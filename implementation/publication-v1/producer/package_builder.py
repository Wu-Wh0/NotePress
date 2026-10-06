"""Build immutable, content-addressed publication-v1 preview packages."""
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import zlib

from reader import read_selected, read_selected_asset

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT.parent.parent
HISTORICAL = PROJECT / "spikes" / "029-recovery-event-integration"
PARSER_ROOT = HISTORICAL / "runtime" / "parser"
NODE = PROJECT / "spikes" / "004-wordpress-roundtrip" / "runtime" / "node-v24.21.0-linux-x64" / "bin" / "node"
COMPILER_FILES = ("render.cjs", "reader.py", "package_builder.py")
MAX_LABEL_BYTES = 16_000


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _toolchain():
    dep_file = HISTORICAL / "producer" / "dependency-bytes.json"
    lock_file = HISTORICAL / "producer" / "package-lock.json"
    if dep_file.is_symlink() or lock_file.is_symlink() or not dep_file.is_file() or not lock_file.is_file():
        raise ValueError("parser_dependency_binding_mismatch")
    dep_bytes = dep_file.read_bytes()
    expected = json.loads(dep_bytes)
    if not isinstance(expected, dict) or not expected:
        raise ValueError("parser_dependency_binding_mismatch")
    base = PARSER_ROOT / "node_modules"
    for relative, digest in expected.items():
        rel = Path(relative)
        if rel.is_absolute() or ".." in rel.parts or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("parser_dependency_binding_mismatch")
        item = base / rel
        probe = base
        for part in rel.parts:
            probe = probe / part
            if probe.is_symlink():
                raise ValueError("parser_dependency_binding_mismatch")
        if not item.is_file() or _sha(item.read_bytes()) != digest:
            raise ValueError("parser_dependency_binding_mismatch")
    if NODE.is_symlink() or not NODE.is_file():
        raise ValueError("pinned_node_runtime_unavailable")
    node_version = subprocess.run([str(NODE), "--version"], check=True, text=True, capture_output=True, timeout=10).stdout.strip()
    if node_version != "v24.21.0":
        raise ValueError("pinned_node_runtime_mismatch")
    return {
        "node": node_version,
        "markdown_it": json.loads((PARSER_ROOT / "node_modules" / "markdown-it" / "package.json").read_text(encoding="utf-8"))["version"],
        "katex": json.loads((PARSER_ROOT / "node_modules" / "katex" / "package.json").read_text(encoding="utf-8"))["version"],
        "dependency_manifest_sha256": _sha(dep_bytes),
        "package_lock_sha256": _sha(lock_file.read_bytes()),
    }


def _load_labels(vault, selected):
    sidecar = (Path(vault) / selected).with_suffix(".labels.json")
    if not sidecar.exists():
        return {}, _canonical({})
    if sidecar.is_symlink() or not sidecar.is_file() or sidecar.stat().st_nlink != 1 or sidecar.stat().st_size > MAX_LABEL_BYTES:
        raise ValueError("invalid_label_approval_file")
    raw = sidecar.read_bytes()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid_label_approval_file") from exc
    if not isinstance(value, dict):
        raise ValueError("invalid_label_approval_file")
    return value, raw


def _assets(parser_result):
    dist = PARSER_ROOT / "node_modules" / "katex" / "dist"
    css = (dist / "katex.min.css").read_text(encoding="utf-8")
    files = {"assets/katex.min.css": css.encode("utf-8")}
    for raw_url in set(re.findall(r"url\(([^)]+)\)", css)):
        name = raw_url.strip("\"'")
        if not re.fullmatch(r"fonts/KaTeX_[A-Za-z0-9_-]+\.(?:woff2|woff|ttf)", name):
            raise ValueError("invalid_css_dependency")
        font = dist / name
        if font.is_symlink() or not font.is_file():
            raise ValueError("invalid_css_dependency")
        files["assets/" + name] = font.read_bytes()
    return files


def _validate_png(data):
    if len(data) > 4 * 1024 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("invalid_png")
    offset = 8
    seen_ihdr = False
    seen_idat = False
    seen_iend = False
    idat_ended = False
    idat = []
    width = height = channels = None
    while offset < len(data):
        if len(data) - offset < 12:
            raise ValueError("invalid_png")
        length = int.from_bytes(data[offset:offset + 4], "big")
        offset += 4
        kind = data[offset:offset + 4]
        offset += 4
        if length > 4 * 1024 * 1024 or offset + length + 4 > len(data):
            raise ValueError("invalid_png")
        chunk = data[offset:offset + length]
        offset += length
        crc = int.from_bytes(data[offset:offset + 4], "big")
        offset += 4
        if zlib.crc32(chunk, zlib.crc32(kind)) & 0xFFFFFFFF != crc:
            raise ValueError("invalid_png_crc")
        if kind == b"IHDR":
            if seen_ihdr or offset != 8 + 4 + 4 + 13 + 4 or length != 13:
                raise ValueError("invalid_png")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunk)
            if width < 1 or height < 1 or width > 4096 or height > 4096 or width * height > 4_000_000:
                raise ValueError("png_dimensions_unsupported")
            if depth != 8 or color not in (2, 6) or compression or filtering or interlace:
                raise ValueError("png_format_unsupported")
            channels = 3 if color == 2 else 4
            seen_ihdr = True
        elif kind == b"IDAT":
            if not seen_ihdr or idat_ended or seen_iend:
                raise ValueError("invalid_png")
            seen_idat = True
            idat.append(chunk)
        elif kind == b"IEND":
            if not seen_idat or length != 0 or seen_iend:
                raise ValueError("invalid_png")
            seen_iend = True
            if offset != len(data):
                raise ValueError("invalid_png_trailing_data")
        else:
            raise ValueError("png_metadata_or_chunk_unsupported")
        if seen_idat and kind != b"IDAT" and kind != b"IEND":
            idat_ended = True
        if seen_iend:
            break
    if not (seen_ihdr and seen_idat and seen_iend) or offset != len(data):
        raise ValueError("invalid_png")
    row_bytes = width * channels
    expected = height * (row_bytes + 1)
    if expected > 16 * 1024 * 1024:
        raise ValueError("png_decompressed_size_unsupported")
    inflater = zlib.decompressobj()
    compressed = b"".join(idat)
    decoded = bytearray()
    pending = compressed
    while pending:
        remaining = expected + 1 - len(decoded)
        if remaining <= 0:
            raise ValueError("png_decompressed_size_unsupported")
        block = inflater.decompress(pending, remaining)
        decoded.extend(block)
        if len(decoded) > expected or inflater.unused_data:
            raise ValueError("invalid_png_pixels")
        pending = inflater.unconsumed_tail
        if not pending:
            break
    if not inflater.eof or inflater.unconsumed_tail or len(decoded) != expected:
        raise ValueError("invalid_png_pixels")
    stride = row_bytes + 1
    if any(decoded[row * stride] > 4 for row in range(height)):
        raise ValueError("invalid_png_filter")


def _validated_asset_approvals(approved_assets, vault, selected):
    if approved_assets is None:
        approved_assets = {}
    if not isinstance(approved_assets, dict):
        raise ValueError("invalid_asset_approvals")
    public_records = {}
    asset_bytes = {}
    for relative, record in approved_assets.items():
        if not isinstance(relative, str) or not isinstance(record, dict) or set(record) != {"sha256", "mime"}:
            raise ValueError("invalid_asset_approval")
        if record["mime"] != "image/png" or not isinstance(record["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"]):
            raise ValueError("invalid_asset_approval")
        raw = read_selected_asset(vault, selected, relative)
        if _sha(raw) != record["sha256"]:
            raise ValueError("asset_approval_hash_mismatch")
        _validate_png(raw)
        public_records[relative] = {"sha256": record["sha256"], "mime": "image/png"}
        asset_bytes[record["sha256"]] = raw
    return public_records, asset_bytes


def build(store, selected, vault, approved_assets=None, title=None):
    """Render only the named Markdown file; labels are explicit sidecar approvals."""
    store = Path(store)
    store.mkdir(parents=True, exist_ok=True)
    vault = Path(vault)
    raw = read_selected(vault, selected)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("source_not_utf8") from exc
    labels, label_bytes = _load_labels(vault, selected)
    asset_records, approved_image_bytes = _validated_asset_approvals(approved_assets, vault, selected)
    if title is None:
        title = Path(selected).stem
    if not isinstance(title, str) or not title.strip() or len(title) > 200 or any(ord(c) < 32 or ord(c) == 127 for c in title):
        raise ValueError("invalid_title")
    toolchain = _toolchain()
    env = os.environ.copy()
    env["PUBLICATION_PARSER_ROOT"] = str(PARSER_ROOT)
    payload = {"text": text, "labels": labels, "assets": asset_records}
    proc = subprocess.run(
        [str(NODE), str(ROOT / "producer" / "render.cjs")],
        input=json.dumps(payload, ensure_ascii=False), text=True, capture_output=True,
        timeout=30, env=env,
    )
    if proc.returncode:
        raise ValueError("render_rejected: " + proc.stderr.strip())
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("render_output_invalid") from exc

    compiler = {
        "files": {name: _sha((ROOT / "producer" / name).read_bytes()) for name in COMPILER_FILES},
        "toolchain": toolchain,
    }
    stage = Path(tempfile.mkdtemp(prefix=".building-", dir=store))
    try:
        bundle = stage / "bundle"
        bundle.mkdir()
        html_text = (
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>"
            + html.escape(title, quote=True)
            + "</title><link rel=\"stylesheet\" href=\"assets/katex.min.css\"></head><body>"
            + result["body"]
            + "</body></html>"
        )
        (bundle / "preview.html").write_text(html_text, encoding="utf-8")
        resources = _assets(result)
        resources.update({f"assets/images/{digest}.png": raw for digest, raw in approved_image_bytes.items()})
        for relative, data in resources.items():
            target = bundle / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        inventory = {
            item.relative_to(bundle).as_posix(): {"bytes": item.stat().st_size, "sha256": _sha(item.read_bytes())}
            for item in sorted(bundle.rglob("*")) if item.is_file()
        }
        manifest = {
            "schema": "publication-v1",
            "selected": selected,
            "source_sha256": _sha(raw),
            "labels_sha256": _sha(label_bytes),
            "title": title,
            "compiler": compiler,
            "inventory": inventory,
        }
        manifest_bytes = _canonical(manifest)
        package_id = _sha(manifest_bytes)
        (stage / "manifest.json").write_bytes(manifest_bytes)
        target = store / package_id
        if target.exists():
            if target.is_symlink() or not target.is_dir() or (target / "manifest.json").read_bytes() != manifest_bytes:
                raise ValueError("package_collision")
            for relative, record in inventory.items():
                item = target / "bundle" / relative
                if item.is_symlink() or not item.is_file() or _sha(item.read_bytes()) != record["sha256"]:
                    raise ValueError("existing_package_corrupt")
        else:
            os.rename(stage, target)
        return package_id
    finally:
        if stage.exists():
            shutil.rmtree(stage)
