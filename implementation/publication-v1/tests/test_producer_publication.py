import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

PRODUCER = Path(__file__).resolve().parents[1] / "producer"
sys.path.insert(0, str(PRODUCER))
from package_builder import NODE, PARSER_ROOT, build
from reader import read_selected


def run_renderer(text, labels=None, assets=None):
    payload = {"text": text, "labels": labels or {}, "assets": assets or {}}
    env = os.environ.copy()
    env["PUBLICATION_PARSER_ROOT"] = str(PARSER_ROOT)
    return subprocess.run(
        [str(NODE), str(PRODUCER / "render.cjs")],
        input=json.dumps(payload, ensure_ascii=False), text=True,
        capture_output=True, timeout=20, env=env,
    )


def make_png_rgba(pixel=b"\x12\x34\x56\xff"):
    def chunk(name, data):
        body = name + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00" + pixel))
        + chunk(b"IEND", b"")
    )


class PublicationPackageTests(unittest.TestCase):
    def test_renderer_preserves_ordinary_http_and_https_links_and_katex(self):
        result = run_renderer("[HTTP](http://example.com/a) and [HTTPS](https://example.org/b?q=1) with $x^2$.\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        rendered = json.loads(result.stdout)["body"]
        self.assertIn('href="http://example.com/a"', rendered)
        self.assertIn('href="https://example.org/b?q=1"', rendered)
        self.assertIn("katex", rendered)

    def test_katex_markup_keeps_mathml_and_kesesafe_inline_styles(self):
        result = run_renderer("Formula $\\frac{a}{b} + x^2$.\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        rendered = json.loads(result.stdout)["body"]
        self.assertIn('<span class="katex-html"', rendered)
        self.assertIn('<math><semantics><mrow><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>+</mo><msup><mi>x</mi><mn>2</mn></msup>', rendered)
        self.assertNotIn('xmlns="http://www.w3.org/1998/Math/MathML"', rendered)
        self.assertNotRegex(rendered, r'style="[^"]*;"')

    def test_renderer_rejects_unsafe_link_schemes(self):
        for destination in (
            "javascript:alert(1)",
            "data:text/html,<svg>",
            "//example.com/path",
            "ftp://example.com/file",
            "https://user:pass@example.com/",
        ):
            with self.subTest(destination=destination):
                result = run_renderer(f"[unsafe]({destination})")
                self.assertNotEqual(result.returncode, 0, destination)

    def test_renderer_rejects_unapproved_local_and_remote_images(self):
        for source in (
            "![local](figure.png)",
            "![remote](https://example.com/figure.png)",
            "![data](data:image/png;base64,AAAA)",
        ):
            with self.subTest(source=source):
                result = run_renderer(source)
                self.assertNotEqual(result.returncode, 0, result.stderr)

    def test_renderer_requires_explicit_wikilink_conversion_approval(self):
        source = "See [[target]]."
        rejected = run_renderer(source)
        self.assertNotEqual(rejected.returncode, 0)
        approved = run_renderer(source, labels={"target": "<target>"})
        self.assertEqual(approved.returncode, 0, approved.stderr)
        body = json.loads(approved.stdout)["body"]
        self.assertIn("&lt;target&gt;", body)
        self.assertNotIn("href=", body)

    def test_renderer_fails_closed_for_frontmatter_raw_html_embeds_and_dynamic_blocks(self):
        cases = (
            "---\ntitle: private\n---\n",
            "<script>alert(1)</script>",
            "![[private-note]]",
            "```dataview\nTABLE file.name\n```",
        )
        for source in cases:
            with self.subTest(source=source):
                result = run_renderer(source)
                self.assertNotEqual(result.returncode, 0, result.stderr)

    def test_renderer_bounds_total_katex_renderings(self):
        source = " ".join("$x$" for _ in range(65))
        result = run_renderer(source)
        self.assertNotEqual(result.returncode, 0)

    def test_approved_png_is_content_addressed_and_source_path_is_not_published(self):
        with tempfile.TemporaryDirectory(prefix="publication-image-") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            note_dir = vault / "文章"
            note_dir.mkdir(parents=True)
            relative = "媒体/图.png"
            image = note_dir / relative
            image.parent.mkdir()
            raw_image = make_png_rgba()
            image.write_bytes(raw_image)
            (note_dir / "文章.md").write_text("![示意图](媒体/图.png)\n", encoding="utf-8")
            image_hash = hashlib.sha256(raw_image).hexdigest()
            approval = {relative: {"sha256": image_hash, "mime": "image/png"}}

            package_id = build(
                root / "store", "文章/文章.md", vault,
                approved_assets=approval,
            )
            print(f"IMAGE_PACKAGE_SHA256={package_id}")
            print(f"IMAGE_BYTES_SHA256={image_hash}")

            package = root / "store" / package_id
            manifest = json.loads((package / "manifest.json").read_bytes())
            resource = f"assets/images/{image_hash}.png"
            self.assertIn(resource, manifest["inventory"])
            self.assertEqual((package / "bundle" / resource).read_bytes(), raw_image)
            preview = (package / "bundle" / "preview.html").read_text(encoding="utf-8")
            self.assertIn(resource, preview)
            self.assertNotIn(relative, preview)

    def test_asset_reader_rejects_symlink_and_hardlink_targets(self):
        with tempfile.TemporaryDirectory(prefix="publication-asset-links-") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            note_dir = vault / "notes"
            note_dir.mkdir(parents=True)
            raw = make_png_rgba()
            original = note_dir / "original.png"
            original.write_bytes(raw)
            note = note_dir / "note.md"
            note.write_text("![asset](symlink.png)\n", encoding="utf-8")
            (note_dir / "symlink.png").symlink_to(original)
            approval = {"symlink.png": {"sha256": hashlib.sha256(raw).hexdigest(), "mime": "image/png"}}
            with self.assertRaisesRegex(ValueError, "selected_asset_unavailable_or_unsafe"):
                build(root / "store", "notes/note.md", vault, approved_assets=approval)

            os.link(original, note_dir / "hardlink.png")
            note.write_text("![asset](hardlink.png)\n", encoding="utf-8")
            hardlink_approval = {"hardlink.png": {"sha256": hashlib.sha256(raw).hexdigest(), "mime": "image/png"}}
            with self.assertRaisesRegex(ValueError, "unsupported_asset_file"):
                build(root / "store", "notes/note.md", vault, approved_assets=hardlink_approval)

    def test_png_approval_hash_and_chunk_crc_are_enforced(self):
        with tempfile.TemporaryDirectory(prefix="publication-png-guards-") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            note_dir = vault / "notes"
            note_dir.mkdir(parents=True)
            source = note_dir / "note.md"
            asset = note_dir / "pixel.png"
            good = make_png_rgba()
            source.write_text("![pixel](pixel.png)\n", encoding="utf-8")
            asset.write_bytes(good)
            wrong = {"pixel.png": {"sha256": "0" * 64, "mime": "image/png"}}
            with self.assertRaisesRegex(ValueError, "asset_approval_hash_mismatch"):
                build(root / "store", "notes/note.md", vault, approved_assets=wrong)

            corrupted = good[:-1] + bytes([good[-1] ^ 1])
            asset.write_bytes(corrupted)
            matching_corrupt_hash = {
                "pixel.png": {"sha256": hashlib.sha256(corrupted).hexdigest(), "mime": "image/png"}
            }
            with self.assertRaisesRegex(ValueError, "invalid_png_crc"):
                build(root / "store", "notes/note.md", vault, approved_assets=matching_corrupt_hash)

    def test_asset_paths_reject_hidden_and_traversal_segments(self):
        with tempfile.TemporaryDirectory(prefix="publication-path-guards-") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            note_dir = vault / "notes"
            note_dir.mkdir(parents=True)
            (note_dir / "note.md").write_text("Plain text.\n", encoding="utf-8")
            approval = {"sha256": "0" * 64, "mime": "image/png"}
            for relative in ("../outside.png", ".hidden/pixel.png", "media/../pixel.png"):
                with self.subTest(relative=relative):
                    with self.assertRaisesRegex(ValueError, "invalid_asset_path"):
                        build(root / "store", "notes/note.md", vault, approved_assets={relative: approval})

    def test_selected_reader_rejects_hidden_traversal_symlink_and_hardlink(self):
        with tempfile.TemporaryDirectory(prefix="publication-reader-guards-") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            notes = vault / "notes"
            notes.mkdir(parents=True)
            original = notes / "ok.md"
            original.write_text("ok", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid_selected_path"):
                read_selected(vault, "notes/.hidden.md")
            with self.assertRaisesRegex(ValueError, "invalid_selected_path"):
                read_selected(vault, "notes/../outside.md")
            (notes / "symlink.md").symlink_to(original)
            with self.assertRaisesRegex(ValueError, "selected_file_unavailable_or_unsafe"):
                read_selected(vault, "notes/symlink.md")
            os.link(original, notes / "hardlink.md")
            with self.assertRaisesRegex(ValueError, "unsupported_source_file"):
                read_selected(vault, "notes/hardlink.md")

    def test_selected_chinese_note_builds_deterministic_publication_v1_bundle(self):
        with tempfile.TemporaryDirectory(prefix="publication-v1-") as tmp:
            root = Path(tmp)
            vault = root / "vault"
            note = vault / "文章" / "子目录" / "第一篇.md"
            note.parent.mkdir(parents=True)
            source = "# 公开文章\n\n中文内容，公式 $x^2$。\n"
            note.write_text(source, encoding="utf-8")
            (vault / "unselected.png").write_bytes(make_png_rgba())
            store = root / "store"

            package_id = build(store, "文章/子目录/第一篇.md", vault, title="中文标题")
            print(f"BASE_PACKAGE_SHA256={package_id}")

            self.assertRegex(package_id, r"^[0-9a-f]{64}$")
            package = store / package_id
            manifest_bytes = (package / "manifest.json").read_bytes()
            manifest = json.loads(manifest_bytes)
            self.assertEqual(package_id, hashlib.sha256(manifest_bytes).hexdigest())
            self.assertEqual(manifest["schema"], "publication-v1")
            self.assertEqual(
                set(manifest),
                {"schema", "selected", "source_sha256", "labels_sha256", "title", "compiler", "inventory"},
            )
            self.assertEqual(manifest["selected"], "文章/子目录/第一篇.md")
            self.assertEqual(manifest["source_sha256"], hashlib.sha256(source.encode()).hexdigest())
            self.assertEqual(manifest["title"], "中文标题")
            self.assertIn("preview.html", manifest["inventory"])
            self.assertFalse(any(name.startswith("assets/images/") for name in manifest["inventory"]))
            preview = (package / "bundle" / "preview.html").read_text(encoding="utf-8")
            self.assertIn("中文内容", preview)
            self.assertIn("katex", preview)
            self.assertNotIn(str(vault), manifest_bytes.decode("utf-8"))
            self.assertFalse((package / "bundle" / "文章" / "子目录" / "第一篇.md").exists())
            self.assertEqual(
                package_id,
                build(store, "文章/子目录/第一篇.md", vault, title="中文标题"),
            )


if __name__ == "__main__":
    unittest.main()
