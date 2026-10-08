"""Fresh full WordPress core/SQLite boundary using cached PHP-WASM only."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
PRODUCER = ROOT / "producer"
SERVER = ROOT / "server"
RUNTIME_HOME = Path(tempfile.gettempdir()) / "publication-v1-wp-runtime"
sys.path.insert(0, str(PRODUCER))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_builder import build
from runtime_paths import node_binary, php_wasm_modules, wordpress_core

NODE = node_binary()
WP_CORE = wordpress_core()
SQLITE_ZIP_NAME = "@wp-playground/cli/sqlite-database-integration.zip"


def png_fixture() -> bytes:
    def chunk(name: bytes, data: bytes) -> bytes:
        payload = name + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\x12\x34\x56\xff"))
        + chunk(b"IEND", b"")
    )


def cached_modules() -> Path:
    modules = php_wasm_modules()
    for package_name in ("@php-wasm/node-8-3", "@php-wasm/universal", "@wp-playground/wordpress", "@wp-playground/cli"):
        package = modules / package_name / "package.json"
        if package.is_symlink() or not package.is_file():
            raise AssertionError(f"pinned PHP-WASM runtime package missing: {package_name}")
        metadata = json.loads(package.read_text(encoding="utf-8"))
        if metadata.get("version") != "3.1.56":
            raise AssertionError(f"pinned PHP-WASM runtime package version mismatch: {package_name}")
    sqlite_zip = modules / SQLITE_ZIP_NAME
    if sqlite_zip.is_symlink() or not sqlite_zip.is_file():
        raise AssertionError("pinned SQLite integration ZIP missing")
    return modules


def build_article(
    run_root: Path,
    key: str,
    selected: str,
    title: str,
    source: str,
    *,
    with_png: bool = False,
) -> dict:
    vault = run_root / key / "synthetic-vault"
    note = vault / Path(selected)
    note.parent.mkdir(parents=True)
    note.write_text(source, encoding="utf-8")
    approved_assets = {}
    image = None
    if with_png:
        image = png_fixture()
        image_path = note.parent / "图.png"
        image_path.write_bytes(image)
        approved_assets["图.png"] = {
            "sha256": hashlib.sha256(image).hexdigest(),
            "mime": "image/png",
        }
    store = run_root / key / "packages"
    package_id = build(
        store,
        selected,
        vault,
        approved_assets=approved_assets,
        title=title,
    )
    package_path = store / package_id
    manifest = json.loads((package_path / "manifest.json").read_bytes())
    compiler_sha256 = hashlib.sha256(
        json.dumps(
            manifest["compiler"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()
    return {
        "key": key,
        "selected": selected,
        "title": title,
        "package_id": package_id,
        "package_path": package_path,
        "manifest": manifest,
        "compiler_sha256": compiler_sha256,
        "operation_id": uuid.uuid4().hex,
        "image_sha256": hashlib.sha256(image).hexdigest() if image else None,
    }


def run_isolated_wordpress(cases: list[dict], php_code: str | list[str]) -> tuple[dict, dict | list[dict]]:
    modules = cached_modules()
    assert NODE.is_file(), f"pinned Node runtime unavailable: {NODE}"
    assert (WP_CORE / "wp-includes" / "version.php").is_file(), f"cached core unavailable: {WP_CORE}"
    assert (SERVER / "publication-v1.php").is_file()
    RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    compiler_sha256 = cases[0]["compiler_sha256"] if cases else "0" * 64
    assert all(c["compiler_sha256"] == compiler_sha256 for c in cases)
    source_codes = php_code if isinstance(php_code, list) else [php_code]
    scenario_codes = [
        code.replace("/wordpress/PLACEHOLDER/wp-load.php", f"/wordpress/{run_id}/wp-load.php")
        for code in source_codes
    ]
    payload = {
        "modules": str(modules),
        "wpCore": str(WP_CORE),
        "sqliteZip": str(modules / SQLITE_ZIP_NAME),
        "serverPath": str(SERVER),
        "runId": run_id,
        "dbName": "synthetic_" + uuid.uuid4().hex,
        "compilerSha256": compiler_sha256,
        "packages": [
            {"id": c["package_id"], "path": str(c["package_path"])} for c in cases
        ],
        "phpCodes": [base64.b64encode(code.encode("utf-8")).decode("ascii") for code in scenario_codes],
    }
    encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
    runner = ROOT / "tests" / "wp-runtime-v1" / "wp-harness.mjs"
    env = dict(os.environ)
    proc = subprocess.run(
        [str(NODE), str(runner), "-"],
        input=encoded,
        encoding="utf-8",
        capture_output=True,
        text=True,
        check=False,
        timeout=240,
        env=env,
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"fresh PHP-WASM WordPress bootstrap/scenario failed (exit={proc.returncode})\n"
            f"stdout={proc.stdout}\nstderr={proc.stderr}"
        )
    smoke_line = next((line for line in proc.stdout.splitlines() if line.startswith("PHP_WASM_SMOKE=")), None)
    result_line = next((line for line in proc.stdout.splitlines() if line.startswith("PHP_WASM_RESULT=")), None)
    if smoke_line is None or result_line is None:
        raise AssertionError(f"missing PHP-WASM smoke/scenario output\n{proc.stdout}\n{proc.stderr}")
    return (
        json.loads(smoke_line.split("=", 1)[1]),
        json.loads(result_line.split("=", 1)[1]),
    )


CONTENT_PROBE = r'''<?php
$_SERVER['DOCUMENT_ROOT'] = dirname('__WP_LOAD__');
require_once '__WP_LOAD__';
$cases = json_decode(base64_decode('__CASES_B64__'), true);
$publisher_id = wp_insert_user(array(
    'user_login' => 'synthetic-publisher-' . wp_generate_password(12, false, false),
    'user_email' => wp_generate_password(12, false, false) . '@example.test',
    'user_pass' => wp_generate_password(48, true, true),
    'role' => 'subscriber',
));
if (is_wp_error($publisher_id)) { throw new RuntimeException('synthetic publisher creation failed'); }
(new WP_User($publisher_id))->add_cap('publish_publication_v1');
$GLOBALS['pubv1_kses_post_filter_calls'] = 0;
$GLOBALS['pubv1_content_filter_calls'] = 0;
$unsafe_payload = '<p onclick="alert(1)">safe<script>alert(2)</script><a href="javascript:alert(3)">unsafe link</a><img src="x" onerror="alert(4)"></p>';
$unsafe_sanitized = wp_kses_post($unsafe_payload);
add_filter('wp_kses_allowed_html', function ($tags, $context) {
    if ($context === 'post') { $GLOBALS['pubv1_kses_post_filter_calls']++; }
    return $tags;
}, 10, 2);
add_filter('the_content', function ($content) {
    $GLOBALS['pubv1_content_filter_calls']++;
    return $content;
}, PHP_INT_MAX, 1);
$rows = array();
foreach ($cases as $case) {
    $loaded = pubv1_load_package($case['package_id']);
    $preview = is_array($loaded) ? pubv1_preview_body($loaded['_inventory_bytes']['preview.html'], $case['title']) : false;
    $content = is_string($preview) ? pubv1_content_for_operation($case['operation_id'], $preview, $loaded['inventory']) : false;
    $sanitized = is_string($content) ? wp_kses_post($content) : false;
    $filtered = is_string($content) ? apply_filters('the_content', $content) : false;
    $snapshot = pubv1_freeze($case['operation_id'], $case['package_id'], $case['title'], (int) $publisher_id, time() + 300);
    $rows[] = array(
        'case' => $case['key'],
        'selected' => $loaded['selected'] ?? null,
        'title_utf8_valid' => is_string($case['title']) && preg_match('//u', $case['title']) === 1,
        'package_valid' => is_array($loaded),
        'producer_body_valid' => is_string($preview),
        'cms_content_valid' => is_string($content),
        'kses_unchanged' => is_string($content) && $sanitized === $content,
        'freeze_valid' => is_array($snapshot),
        'producer_cms_bytes' => is_string($content) ? strlen($content) : null,
        'producer_cms_sha256' => is_string($content) ? hash('sha256', $content) : null,
        'real_kses_bytes' => is_string($sanitized) ? strlen($sanitized) : null,
        'real_kses_sha256' => is_string($sanitized) ? hash('sha256', $sanitized) : null,
        'final_filter_bytes' => is_string($filtered) ? strlen($filtered) : null,
        'final_filter_sha256' => is_string($filtered) ? hash('sha256', $filtered) : null,
        'http_link_preserved' => is_string($content) && strpos($content, 'href="https://example.test/path"') !== false,
        'approved_png_bound' => is_string($content) && strpos($content, 'resources/' . $case['operation_id'] . '/assets/images/') !== false,
        'katex_markup_present' => is_string($content) && strpos($content, 'class="katex"') !== false,
        'katex_visual_html_present' => is_string($content)
            && strpos($content, 'class="katex-html"') !== false
            && strpos($content, 'class="mfrac"') !== false
            && strpos($content, 'style="height:') !== false
            && strpos($content, 'vertical-align:') !== false,
        'katex_mathml_structure_present' => is_string($content)
            && strpos($content, '<mfrac><mi>a</mi><mi>b</mi></mfrac><mo>+</mo><msup><mi>x</mi><mn>2</mn></msup>') !== false,
    );
}
$filter_probe = apply_filters('the_content', "first synthetic line\n\nsecond synthetic line");
echo json_encode(array(
    'cases' => $rows,
    'unsafe_payload_rejected' => is_string($unsafe_sanitized)
        && $unsafe_sanitized !== $unsafe_payload
        && strpos($unsafe_sanitized, '<script') === false
        && strpos($unsafe_sanitized, 'onclick') === false
        && strpos($unsafe_sanitized, 'onerror') === false
        && stripos($unsafe_sanitized, 'javascript:') === false
        && strpos($unsafe_sanitized, 'safe') !== false,
    'real_kses_post_filter_calls' => $GLOBALS['pubv1_kses_post_filter_calls'],
    'real_the_content_filter_calls' => $GLOBALS['pubv1_content_filter_calls'],
    'real_wpautop_registered' => has_filter('the_content', 'wpautop') !== false,
    'real_filter_probe' => $filter_probe,
    'simulated_human_approval' => false,
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''


def content_probe(cases: list[dict]) -> str:
    rows = [
        {
            "key": case["key"],
            "selected": case["selected"],
            "title": case["title"],
            "package_id": case["package_id"],
            "operation_id": case["operation_id"],
        }
        for case in cases
    ]
    return (
        CONTENT_PROBE.replace("__WP_LOAD__", "/wordpress/" + "PLACEHOLDER" + "/wp-load.php")
        .replace("__CASES_B64__", base64.b64encode(json.dumps(rows, ensure_ascii=False).encode()).decode())
    )


class RealWordPressPublicationRuntimeTests(unittest.TestCase):
    def test_full_wordpress_kses_and_filters_on_separate_producer_cases(self) -> None:
        RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="run-", dir=RUNTIME_HOME) as tmp:
            root = Path(tmp)
            cases = [
                build_article(root, "nested", "文章/子目录/边界.md", "中文嵌套选文验收", "# 中文标题\n\n嵌套路径与中文正文。\n"),
                build_article(root, "link", "文章/子目录/链接.md", "HTTP 链接验收", "普通文字与 [HTTP 链接](https://example.test/path)。\n"),
                build_article(root, "approved-png", "文章/子目录/图片.md", "批准 PNG 验收", "![批准图片](图.png)\n", with_png=True),
                build_article(root, "katex", "文章/子目录/公式.md", "KaTeX 公式验收", "公式 $\\frac{a}{b} + x^2$。\n"),
            ]
            katex_case = cases[-1]
            inventory = katex_case["manifest"]["inventory"]
            css_name = "assets/katex.min.css"
            self.assertIn(css_name, inventory)
            css_path = katex_case["package_path"] / "bundle" / css_name
            css_bytes = css_path.read_bytes()
            css_text = css_bytes.decode("utf-8")
            self.assertIn('<link rel="stylesheet" href="assets/katex.min.css">', (katex_case["package_path"] / "bundle" / "preview.html").read_text(encoding="utf-8"))
            self.assertIn(b".katex", css_bytes)
            self.assertIn(b".mfrac", css_bytes)
            self.assertIn(b".vlist", css_bytes)
            self.assertEqual(inventory[css_name]["bytes"], len(css_bytes))
            self.assertEqual(inventory[css_name]["sha256"], hashlib.sha256(css_bytes).hexdigest())
            font_refs = {ref.strip("\\\"'") for ref in re.findall(r"url\(([^)]+)\)", css_text)}
            self.assertTrue(font_refs and all(ref.startswith("fonts/KaTeX_") for ref in font_refs), font_refs)
            for font_ref in font_refs:
                asset_name = "assets/" + font_ref
                self.assertIn(asset_name, inventory)
                font_bytes = (katex_case["package_path"] / "bundle" / asset_name).read_bytes()
                self.assertEqual(inventory[asset_name]["bytes"], len(font_bytes))
                self.assertEqual(inventory[asset_name]["sha256"], hashlib.sha256(font_bytes).hexdigest())
            code = content_probe(cases)
            # The site root is a UUID-scoped PHP-WASM VFS path, supplied by the Node bootstrap.
            # Replace only this fixed marker after run_isolated_wordpress chooses the run id.
            smoke, result = run_isolated_wordpress(cases, code)
            summary = {"smoke": smoke, "result": result}
            print("WORDPRESS_RUNTIME_SUMMARY=" + json.dumps(summary, ensure_ascii=False, sort_keys=True))
            self.assertTrue(smoke["complete_core_loaded"], summary)
            self.assertEqual(smoke["database_engine"], "sqlite", summary)
            self.assertIn("SQLite", smoke["database_driver"], summary)
            self.assertEqual(smoke["database_query"], 1, summary)
            self.assertTrue(smoke["plugin_active"], summary)
            self.assertTrue(smoke["the_content_wpautop_registered"], summary)
            observed = {row["case"]: row for row in result["cases"]}
            self.assertEqual(set(observed), {"nested", "link", "approved-png", "katex"}, summary)
            self.assertTrue(observed["nested"]["title_utf8_valid"] and observed["nested"]["selected"].endswith("边界.md"), summary)
            self.assertTrue(observed["link"]["http_link_preserved"], summary)
            self.assertTrue(observed["approved-png"]["approved_png_bound"], summary)
            self.assertTrue(observed["katex"]["katex_markup_present"], summary)
            self.assertTrue(observed["katex"]["katex_visual_html_present"], summary)
            self.assertTrue(observed["katex"]["katex_mathml_structure_present"], summary)
            self.assertTrue(result["unsafe_payload_rejected"], summary)
            self.assertGreater(result["real_kses_post_filter_calls"], 0, summary)
            self.assertGreater(result["real_the_content_filter_calls"], 0, summary)
            self.assertTrue(result["real_wpautop_registered"], summary)
            self.assertIn("<p>first synthetic line</p>", result["real_filter_probe"], summary)
            malformed = [r for r in result["cases"] if not r["package_valid"] or not r["producer_body_valid"] or not r["cms_content_valid"]]
            self.assertEqual(malformed, [], summary)
            changed = [r for r in result["cases"] if not r["kses_unchanged"] or not r["freeze_valid"]]
            self.assertEqual(
                changed,
                [],
                "Decisive real WordPress KSES RED: core changed producer/CMS bytes and fail-closed freeze rejected the snapshot. "
                "No sanitizer bypass or normalization was applied. Hashes/lengths are included; bodies are not. "
                + json.dumps(summary, ensure_ascii=False, sort_keys=True),
            )


if __name__ == "__main__":
    unittest.main()
