"""Producer-to-server contract test; records the single shared package format.

Contract decision: manifest.json is the canonical, package-ID-addressed producer
manifest (schema, selected, source_sha256, labels_sha256, title, compiler,
inventory); inventory records bind bundle/preview.html and each asset by byte
length and SHA-256, while the server derives MIME from the allowlisted path.
The preview document is the sole HTML body source. The server extracts its body, fails closed if WordPress sanitization changes it,
and rewrites approved content-addressed image paths to operation-bound resource
URLs while loading the exact inventory bytes from bundle/.
"""
from __future__ import annotations

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

ROOT = Path(__file__).resolve().parents[1]
PRODUCER = ROOT / "producer"
sys.path.insert(0, str(PRODUCER))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_builder import build
from runtime_paths import node_binary
from test_wordpress_runtime import cached_modules

NODE = node_binary()

OPERATION_ID = "0123456789abcdef0123456789abcdef"


def png_fixture() -> bytes:
    def chunk(name: bytes, data: bytes) -> bytes:
        body = name + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\x12\x34\x56\xff"))
        + chunk(b"IEND", b"")
    )


def cached_php_wasm_node_modules() -> Path:
    return cached_modules()


NODE_RUNNER = r'''import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const universal = pathToFileURL(path.join(input.modules, '@php-wasm/universal/index.js')).href;
const wasm83 = pathToFileURL(path.join(input.modules, '@php-wasm/node-8-3/index.js')).href;
const [{ PHP, loadPHPRuntime }, php83] = await Promise.all([
  import(universal), import(wasm83)
]);
// Use the local PHP.wasm runtime directly: no CLI server, socket, or network.
const php = new PHP(await loadPHPRuntime(await php83.getPHPLoaderModule()));
function mkdirp(vfsPath) {
  let current = '';
  for (const part of vfsPath.split('/').filter(Boolean)) {
    current += '/' + part;
    if (!php.isDir(current)) php.mkdir(current);
  }
}
function copyTree(nativePath, vfsPath) {
  const st = fs.statSync(nativePath);
  if (st.isDirectory()) {
    mkdirp(vfsPath);
    for (const name of fs.readdirSync(nativePath)) copyTree(path.join(nativePath, name), vfsPath + '/' + name);
  } else {
    mkdirp(path.posix.dirname(vfsPath));
    php.writeFile(vfsPath, new Uint8Array(fs.readFileSync(nativePath)));
  }
}
copyTree(input.packagePath, '/private/store/' + input.packageId);
copyTree(input.serverPath, '/plugin');
mkdirp('/wordpress');
mkdirp('/docroot');
const response = await php.run({code: Buffer.from(input.phpCode, 'base64').toString('utf8')});
console.log('PHP_WASM_RESULT=' + response.text);
if (response.exitCode !== 0) {
  console.error('PHP_WASM_EXIT=' + response.exitCode + ' ERRORS=' + response.errors);
  process.exitCode = 2;
}
php.exit();
'''


class ProducerServerContractTests(unittest.TestCase):
    def test_real_producer_package_is_loaded_and_frozen_by_server_php_wasm(self) -> None:
        self.assertTrue(NODE.is_file(), f"pinned Node runtime unavailable: {NODE}")
        modules = cached_php_wasm_node_modules()
        with tempfile.TemporaryDirectory(prefix="publication-contract-") as tmp:
            root = Path(tmp)
            vault = root / "synthetic-vault"
            note_dir = vault / "synthetic"
            note_dir.mkdir(parents=True)
            selected = "synthetic/Boundary.md"
            source = "# Synthetic boundary\n\nSee [[target]] and this approved image.\n\n![pixel](pixel.png)\n".encode()
            labels_raw = b'{ "target" : "approved label" }\n'
            image = png_fixture()
            (note_dir / "Boundary.md").write_bytes(source)
            (note_dir / "Boundary.labels.json").write_bytes(labels_raw)
            (note_dir / "pixel.png").write_bytes(image)
            image_sha256 = hashlib.sha256(image).hexdigest()
            title = "Synthetic publication boundary"
            store = root / "packages"
            package_id = build(
                store,
                selected,
                vault,
                approved_assets={"pixel.png": {"sha256": image_sha256, "mime": "image/png"}},
                title=title,
            )
            package_path = store / package_id
            manifest_raw = (package_path / "manifest.json").read_bytes()
            manifest = json.loads(manifest_raw)
            compiler_sha256 = hashlib.sha256(
                json.dumps(manifest["compiler"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            self.assertEqual(package_id, hashlib.sha256(manifest_raw).hexdigest())

            php_code = r'''<?php
                define('ABSPATH', '/wordpress/');
                define('BLOG_V1_STORE', '/private/store');
                define('BLOG_V1_COMPILER_SHA256', '__COMPILER_SHA256__');
                $_SERVER['DOCUMENT_ROOT'] = '/docroot';
                function wp_normalize_path($p) { return str_replace('\\', '/', $p); }
                function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
                function add_action(...$args) {}
                function add_filter(...$args) {}
                function remove_filter(...$args) {}
                function get_bloginfo($key) { return 'synthetic-wp'; }
                function home_url($path = '/') { return 'https://example.test' . $path; }
                function rest_url($path = '') { return 'https://example.test/wp-json/' . ltrim($path, '/'); }
                function wp_kses_post($html) { return $html; }
                function apply_filters($tag, $value) { return $value; }
                require '/plugin/publication-v1.php';
                $package_id = '__PACKAGE_ID__';
                $operation_id = '__OPERATION_ID__';
                $loaded = pubv1_load_package($package_id);
                $snapshot = pubv1_freeze($operation_id, $package_id, '__TITLE__', 321, time() + 300);
                $byte_bindings = array();
                if (is_array($loaded)) {
                    foreach ($loaded['_inventory_bytes'] as $path => $bytes) {
                        $byte_bindings[$path] = array('bytes' => strlen($bytes), 'sha256' => hash('sha256', $bytes));
                    }
                }
                echo json_encode(array(
                    'package_valid' => is_array($loaded),
                    'snapshot_valid' => is_array($snapshot),
                    'byte_bindings' => $byte_bindings,
                    'snapshot' => is_array($snapshot) ? $snapshot : null,
                ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            '''
            php_code = (
                php_code.replace("__COMPILER_SHA256__", compiler_sha256)
                .replace("__PACKAGE_ID__", package_id)
                .replace("__OPERATION_ID__", OPERATION_ID)
                .replace("__TITLE__", title)
            )
            runner_input = {
                "modules": str(modules),
                "packagePath": str(package_path),
                "packageId": package_id,
                "serverPath": str(ROOT / "server"),
                "phpCode": __import__("base64").b64encode(php_code.encode()).decode(),
            }
            proc = subprocess.run(
                [str(NODE), "--input-type=module", "-e", NODE_RUNNER,
                 __import__("base64").b64encode(json.dumps(runner_input).encode()).decode()],
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
                env=dict(os.environ),
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            result_line = next((line for line in proc.stdout.splitlines() if line.startswith("PHP_WASM_RESULT=")), None)
            self.assertIsNotNone(result_line, proc.stdout + proc.stderr)
            result = json.loads(result_line.split("=", 1)[1])

            # One vertical boundary: emitted package -> actual PHP validator/loader/freeze.
            self.assertTrue(result["package_valid"], f"actual server PHP rejected the producer package: {result}")
            self.assertTrue(result["snapshot_valid"], "actual server PHP did not freeze the producer package")
            self.assertEqual(result["byte_bindings"], manifest["inventory"])
            snapshot = result["snapshot"]
            self.assertEqual(snapshot["selected"], selected)
            self.assertEqual(snapshot["source_sha256"], hashlib.sha256(source).hexdigest())
            self.assertEqual(snapshot["labels_sha256"], hashlib.sha256(labels_raw).hexdigest())
            self.assertEqual(snapshot["title"], title)
            self.assertEqual(snapshot["compiler_sha256"], compiler_sha256)
            preview = (package_path / "bundle" / "preview.html").read_text(encoding="utf-8")
            self.assertIn(selected, manifest_raw.decode("utf-8"))
            self.assertNotIn(selected, preview)
            preview_body = preview.split("</head><body>", 1)[1].removesuffix("</body></html>")
            resource_url = f"https://example.test/wp-json/publication-v1/v1/resources/{OPERATION_ID}/assets/images/{image_sha256}.png"
            expected_final = preview_body.replace(
                f'src="assets/images/{image_sha256}.png"', f'src="{resource_url}"'
            )
            self.assertEqual(snapshot["content"], expected_final)
            self.assertEqual(
                result["byte_bindings"][f"assets/images/{image_sha256}.png"],
                {"bytes": len(image), "sha256": image_sha256},
            )
            print(f"BOUNDARY_PACKAGE_ID_SHA256={package_id}")
            print(f"BOUNDARY_SOURCE_SHA256={hashlib.sha256(source).hexdigest()}")
            print(f"BOUNDARY_LABELS_SHA256={hashlib.sha256(labels_raw).hexdigest()}")
            print(f"BOUNDARY_COMPILER_SHA256={compiler_sha256}")
            print(f"BOUNDARY_IMAGE_SHA256={image_sha256}")


if __name__ == "__main__":
    unittest.main()
