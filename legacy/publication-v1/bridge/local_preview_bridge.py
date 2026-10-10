"""Test-only local adapter for the publication-v1 tracer.

This is deliberately not a deployable server: callers supply the synthetic
publisher transport; there is no credential handling, remote upload, approval,
commit, or Vault enumeration.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

PRODUCER = Path(__file__).resolve().parents[1] / "producer"
import sys
sys.path.insert(0, str(PRODUCER))
from package_builder import build
from reader import read_selected

HEX64 = re.compile(r"^[a-f0-9]{64}$")
HEX32 = re.compile(r"^[a-f0-9]{32}$")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _loopback_origin(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("non_loopback_bridge")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("non_loopback_bridge") from error
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or not isinstance(port, int)
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query
        or parsed.fragment
        or parsed.netloc != f"127.0.0.1:{port}"
    ):
        raise ValueError("non_loopback_bridge")
    return value


def _label_bytes(vault: Path, selected: str) -> bytes:
    sidecar = (vault / selected).with_suffix(".labels.json")
    if not sidecar.exists() and not sidecar.is_symlink():
        return b"{}"
    if (
        sidecar.is_symlink()
        or not sidecar.is_file()
        or sidecar.stat().st_nlink != 1
        or sidecar.stat().st_size > 16_000
    ):
        raise ValueError("invalid_label_approval_file")
    return sidecar.read_bytes()


def _verify_package(store: Path, package_id: str, selected: str, source: bytes, labels: bytes) -> dict:
    if not HEX64.fullmatch(package_id):
        raise ValueError("package_identity_invalid")
    package = store / package_id
    manifest_path = package / "manifest.json"
    if package.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("package_manifest_missing")
    raw = manifest_path.read_bytes()
    if _sha(raw) != package_id:
        raise ValueError("package_identity_mismatch")
    try:
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("package_manifest_invalid") from error
    expected_keys = {
        "schema", "selected", "source_sha256", "labels_sha256", "title", "compiler", "inventory"
    }
    if (
        not isinstance(manifest, dict)
        or set(manifest) != expected_keys
        or manifest["schema"] != "publication-v1"
        or manifest["selected"] != selected
        or manifest["source_sha256"] != _sha(source)
        or manifest["labels_sha256"] != _sha(labels)
        or not isinstance(manifest["title"], str)
        or not isinstance(manifest["compiler"], dict)
        or not isinstance(manifest["inventory"], dict)
    ):
        raise ValueError("package_binding_mismatch")
    inventory = manifest["inventory"]
    if "preview.html" not in inventory or "assets/katex.min.css" not in inventory:
        raise ValueError("package_resources_incomplete")
    bundle = package / "bundle"
    for relative, record in inventory.items():
        if not isinstance(relative, str) or not isinstance(record, dict) or set(record) != {"bytes", "sha256"}:
            raise ValueError("package_inventory_invalid")
        rel = PurePosixPath(relative)
        if rel.is_absolute() or not rel.parts or any(part in ("", ".", "..") for part in rel.parts):
            raise ValueError("package_inventory_invalid")
        path = bundle.joinpath(*rel.parts)
        probe = bundle
        for part in rel.parts:
            probe = probe / part
            if probe.is_symlink():
                raise ValueError("package_resource_link_rejected")
        if not path.is_file():
            raise ValueError("package_resource_missing")
        content = path.read_bytes()
        if (
            not isinstance(record["bytes"], int)
            or record["bytes"] != len(content)
            or not isinstance(record["sha256"], str)
            or not HEX64.fullmatch(record["sha256"])
            or _sha(content) != record["sha256"]
        ):
            raise ValueError("package_resource_binding_mismatch")
    return manifest


class LocalPreviewBridge:
    """Bind one caller-selected note to the producer and injected server test transport."""

    def __init__(self, *, vault, selected: str, store, prepare):
        self.vault = Path(vault)
        self.selected = selected
        self.store = Path(store)
        if not callable(prepare):
            raise ValueError("server_transport_required")
        self.prepare = prepare
        self._prepare_attempted = False
        self._previews: dict[str, bytes] = {}

    def generate(self, body: dict, *, origin: str) -> dict:
        origin = _loopback_origin(origin)
        if self._prepare_attempted:
            raise ValueError("prepare_attempt_already_made")
        if (
            not isinstance(body, dict)
            or set(body) != {"path", "source_sha256"}
            or body.get("path") != self.selected
            or not isinstance(body.get("source_sha256"), str)
            or not HEX64.fullmatch(body["source_sha256"])
        ):
            raise ValueError("invalid_selected_request")

        source = read_selected(self.vault, self.selected)
        source_sha256 = _sha(source)
        if source_sha256 != body["source_sha256"]:
            raise ValueError("selected_source_mismatch")
        labels = _label_bytes(self.vault, self.selected)
        title = Path(self.selected).stem

        # No client-provided image approvals exist in the plugin request contract.
        # Passing an empty allowlist makes image-bearing notes fail closed.
        package_id = build(self.store, self.selected, self.vault, approved_assets={}, title=title)
        if read_selected(self.vault, self.selected) != source or _label_bytes(self.vault, self.selected) != labels:
            raise ValueError("selected_inputs_changed_during_build")
        manifest = _verify_package(self.store, package_id, self.selected, source, labels)
        package = {
            "package_id": package_id,
            "package_path": self.store / package_id,
            "manifest": manifest,
            "compiler_sha256": _sha(json.dumps(
                manifest["compiler"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")),
        }

        # One-shot even on a lost response; cold/restart recovery is intentionally absent.
        self._prepare_attempted = True
        try:
            server = self.prepare(package, self.selected, source_sha256, _sha(labels))
        except Exception:
            raise ValueError("server_outcome_unknown") from None
        data = server.get("data") if isinstance(server, dict) else None
        if (
            not isinstance(server, dict)
            or server.get("status") != 201
            or server.get("pending_snapshot_bound") is not True
            or server.get("publication_approval") is not False
            or not isinstance(data, dict)
            or set(data) != {"id", "digest", "state", "preview_url"}
            or not isinstance(data.get("id"), str)
            or not HEX32.fullmatch(data["id"])
            or not isinstance(data.get("digest"), str)
            or not HEX64.fullmatch(data["digest"])
            or data.get("state") != "pending"
            or not isinstance(server.get("expires_at"), int)
            or server["expires_at"] <= int(time.time())
        ):
            raise ValueError("server_contract_mismatch")
        if read_selected(self.vault, self.selected) != source or _label_bytes(self.vault, self.selected) != labels:
            raise ValueError("selected_inputs_changed_after_prepare")

        html_bytes = (package["package_path"] / "bundle" / "preview.html").read_bytes()
        preview_url = f"{origin}/preview/{data['id']}"
        self._previews[data["id"]] = html_bytes
        return {
            "preview_id": data["id"],
            "package_id": package_id,
            "digest": data["digest"],
            "html": html_bytes.decode("utf-8"),
            "preview_sha256": _sha(html_bytes),
            "preview_url": preview_url,
            "state": "pending",
            "mode": "frozen",
            "path": self.selected,
            "source_sha256": source_sha256,
            "expires_at": server["expires_at"],
            "publication_approval": False,
        }

    def preview(self, operation_id: str) -> bytes:
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("no_preview")
        try:
            return self._previews[operation_id]
        except KeyError as error:
            raise ValueError("no_preview") from error
