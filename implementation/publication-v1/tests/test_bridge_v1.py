"""Local tracer: actual Obsidian entry -> producer -> real PHP/WP contract.

Synthetic only. No credentials, approval, commit, remote upload, or product server.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "bridge-output"
BRIDGE = ROOT / "bridge"
sys.path.insert(0, str(BRIDGE))
from local_preview_bridge import LocalPreviewBridge

sys.path.insert(0, str(ROOT / "tests"))
import test_wordpress_runtime as wp_runtime

# Keep every generated run artifact inside the explicitly permitted evidence dir.
wp_runtime.RUNTIME_HOME = OUTPUT / "wp-runtime"
NODE = wp_runtime.NODE
PLUGIN = ROOT / "plugin" / "main.js"
HARNESS = ROOT / "tests" / "wp-runtime-v1" / "wp-harness.mjs"

NODE_DRIVER = r'''const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return {
    Plugin: class Plugin {}, Notice: class Notice {}, ItemView: class ItemView {},
  };
  return originalLoad.call(this, request, parent, isMain);
};
(async () => {
  const [pluginPath, vaultPath, origin, selectedPath, source] = process.argv.slice(1);
  const EntryPreview = require(pluginPath);
  const file = { extension: 'md', path: selectedPath };
  let shown = null;
  const finalLeaf = { view: { show: value => { shown = value; }, invalidate() {} } };
  const app = {
    vault: {
      adapter: { getBasePath: () => vaultPath },
      read: async () => source,
    },
    workspace: {
      activeEditor: undefined,
      getActiveFile: () => file,
      getLeavesOfType: type => type === 'blog-entry-final-preview' ? [finalLeaf] : [],
      revealLeaf: async () => {},
    },
  };
  const plugin = new EntryPreview();
  Object.assign(plugin, {
    app, config: { expectedVault: vaultPath, bridgeOrigin: origin },
    freezeEpoch: 0, busy: false,
  });
  const result = await plugin.generate();
  console.log('PLUGIN_RESULT=' + JSON.stringify({ result, shown }));
  if (!result || result.ok !== true) process.exitCode = 2;
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 3; });
'''

PHP_PREPARE = r'''<?php
$_SERVER['DOCUMENT_ROOT'] = dirname('__WP_LOAD__');
require_once '__WP_LOAD__';
do_action('rest_api_init', rest_get_server());
$input = json_decode(base64_decode('__INPUT_B64__'), true);
function bridge_test_response($response) {
    if ($response instanceof WP_REST_Response) {
        return array('status' => $response->get_status(), 'data' => $response->get_data());
    }
    if (is_wp_error($response)) {
        $error_data = $response->get_error_data();
        return array(
            'status' => is_array($error_data) ? (int) ($error_data['status'] ?? 0) : 0,
            'data' => array('code' => $response->get_error_code()),
        );
    }
    return array('status' => 0, 'data' => array());
}
function bridge_test_request($method, $route, $body = null, $nonce = null) {
    $request = new WP_REST_Request($method, $route);
    if ($body !== null) {
        $request->set_header('content-type', 'application/json');
        $request->set_body(wp_json_encode($body));
    }
    if (is_string($nonce)) { $request->set_header('X-WP-Nonce', $nonce); }
    return bridge_test_response(rest_do_request($request));
}
function bridge_test_remove_tree($path) {
    if (is_link($path) || (file_exists($path) && !is_dir($path))) return @unlink($path);
    if (!is_dir($path)) return true;
    foreach (scandir($path) as $name) {
        if ($name === '.' || $name === '..') continue;
        if (!bridge_test_remove_tree($path . DIRECTORY_SEPARATOR . $name)) return false;
    }
    return @rmdir($path);
}
$user_id = wp_insert_user(array(
    'user_login' => 'synthetic-bridge-publisher',
    'user_email' => 'synthetic-bridge-publisher@example.test',
    'user_pass' => wp_generate_password(48, true, true),
    'role' => 'subscriber',
));
if (is_wp_error($user_id)) { throw new RuntimeException('synthetic user setup failed'); }
(new WP_User($user_id))->add_cap('publish_publication_v1');
$expires = time() + HOUR_IN_SECONDS;
$token = WP_Session_Tokens::get_instance($user_id)->create($expires);
$_COOKIE = array(LOGGED_IN_COOKIE => wp_generate_auth_cookie($user_id, $expires, 'logged_in', $token));
wp_set_current_user((int) $user_id);
$nonce = wp_create_nonce('wp_rest');

// Build the real receive payload from the harness fixture, then remove the
// unowned pre-stage before exercising the authenticated WordPress endpoint.
$package_path = rtrim(BLOG_V1_STORE, '/') . '/' . $input['package_id'];
$manifest_raw = @file_get_contents($package_path . '/manifest.json');
$manifest = is_string($manifest_raw) ? json_decode($manifest_raw, true) : false;
$files = array();
$fixture_valid = is_array($manifest) && is_array($manifest['inventory'] ?? null);
if ($fixture_valid) {
    foreach ($manifest['inventory'] as $relative => $record) {
        $bytes = @file_get_contents($package_path . '/bundle/' . $relative);
        if (!is_string($bytes)) { $fixture_valid = false; break; }
        $files[$relative] = base64_encode($bytes);
    }
}
$fixture_removed = $fixture_valid && bridge_test_remove_tree($package_path);
$upload = $fixture_removed
    ? bridge_test_request('POST', '/publication-v1/v1/packages', array('manifest' => $manifest_raw, 'files' => $files), $nonce)
    : array('status' => 0, 'data' => array());
$query = bridge_test_request('GET', '/publication-v1/v1/packages/' . $input['package_id'], null, $nonce);
$loaded = pubv1_load_package($input['package_id']);
$uploaded_bytes_exact = is_array($loaded);
if ($uploaded_bytes_exact) {
    foreach ($files as $path => $encoded) {
        $expected = base64_decode($encoded, true);
        if (!is_string($expected) || !isset($loaded['_inventory_bytes'][$path])
            || !hash_equals($expected, $loaded['_inventory_bytes'][$path])) {
            $uploaded_bytes_exact = false;
            break;
        }
    }
}
$owner = pubv1_package_owner_record($input['package_id']);
$owner_exact = is_array($owner)
    && ($owner['package_id'] ?? '') === $input['package_id']
    && (int) ($owner['publisher_id'] ?? 0) === (int) $user_id
    && (int) ($owner['site_id'] ?? 0) === (int) get_current_blog_id();
$expires_at = time() + 300;
$create = bridge_test_request('POST', '/publication-v1/v1/operations', array(
    'id' => $input['operation_id'],
    'title' => $input['title'],
    'expires_at' => $expires_at,
    'manifest_sha256' => $input['package_id'],
), $nonce);
$status = $create['status'];
$data = $create['data'];
$record = maybe_unserialize(pubv1_read_raw_option(pubv1_option_key($input['operation_id'])));
$snapshot = is_array($record) ? ($record['snapshot'] ?? null) : null;
$preview_body = is_array($loaded)
    ? pubv1_preview_body($loaded['_inventory_bytes']['preview.html'] ?? '', $input['title'])
    : false;
$producer_cms_body = is_string($preview_body)
    ? pubv1_content_for_operation($input['operation_id'], $preview_body, $loaded['inventory'])
    : false;
$content_match = is_string($producer_cms_body)
    && $producer_cms_body === $preview_body
    && is_array($snapshot)
    && ($snapshot['content'] ?? null) === $producer_cms_body;
$pending = is_array($record)
    && ($record['state'] ?? '') === 'pending'
    && ($snapshot['operation_key'] ?? '') === $input['operation_id']
    && ($snapshot['manifest_sha256'] ?? '') === $input['package_id']
    && ($snapshot['selected'] ?? '') === $input['selected']
    && ($snapshot['source_sha256'] ?? '') === $input['source_sha256']
    && ($snapshot['labels_sha256'] ?? '') === $input['labels_sha256']
    && ($snapshot['title'] ?? '') === $input['title']
    && (int) ($snapshot['publisher_id'] ?? 0) === (int) $user_id;
echo json_encode(array(
    'status' => $status,
    'data' => $data,
    'pre_staged_fixture_removed_before_upload' => $fixture_removed,
    'private_upload_status' => $upload['status'],
    'private_query_status' => $query['status'],
    'private_query_identity_matches' => ($query['data']['package_id'] ?? null) === $input['package_id'],
    'uploaded_resource_bytes_exact' => $uploaded_bytes_exact,
    'private_owner_bound' => $owner_exact,
    'pending_snapshot_bound' => $pending,
    'server_snapshot_content_matches_producer' => $content_match,
    'publication_approval' => false,
    'expires_at' => $expires_at,
), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
'''


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def server_prepare(package: dict, selected: str, source_sha256: str, labels_sha256: str) -> dict:
    operation_id = __import__('uuid').uuid4().hex
    payload = {
        "operation_id": operation_id,
        "package_id": package["package_id"],
        "selected": selected,
        "source_sha256": source_sha256,
        "labels_sha256": labels_sha256,
        "title": package["manifest"]["title"],
    }
    php_code = (
        PHP_PREPARE.replace("__WP_LOAD__", "/wordpress/PLACEHOLDER/wp-load.php")
        .replace("__INPUT_B64__", base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode())
    )
    case = {
        "package_id": package["package_id"],
        "package_path": package["package_path"],
        "compiler_sha256": package["compiler_sha256"],
    }
    smoke, result = wp_runtime.run_isolated_wordpress([case], php_code)
    if not smoke.get("complete_core_loaded") or smoke.get("database_engine") != "sqlite" or not smoke.get("plugin_active"):
        raise AssertionError(f"fresh WordPress runtime did not meet bootstrap gate: {smoke}")
    return result


class LocalBridgeTracerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        wp_runtime.RUNTIME_HOME.mkdir(parents=True, exist_ok=True)
        runner = wp_runtime.RUNTIME_HOME / "wp-harness.mjs"
        if not runner.exists() or runner.read_bytes() != HARNESS.read_bytes():
            shutil.copyfile(HARNESS, runner)

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="bridge-v1-", dir=OUTPUT)
        self.root = Path(self.temp.name)
        self.vault = self.root / "synthetic-vault"
        self.selected = "文章/Tracer.md"
        self.note = self.vault / self.selected
        self.note.parent.mkdir(parents=True)
        self.source = "# Bridge tracer\n\nSee [[target]] in this synthetic note.\n"
        self.note.write_text(self.source, encoding="utf-8")
        self.labels_raw = b'{ "target" : "approved display text" }\n'
        self.note.with_suffix(".labels.json").write_bytes(self.labels_raw)
        self.store = self.root / "packages"
        self.prepared = []
        self.bridge = LocalPreviewBridge(
            vault=self.vault,
            selected=self.selected,
            store=self.store,
            prepare=lambda package, selected, source_hash, labels_hash: self._prepare(
                package, selected, source_hash, labels_hash
            ),
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _prepare(self, package, selected, source_hash, labels_hash):
        result = server_prepare(package, selected, source_hash, labels_hash)
        self.prepared.append(result)
        return result

    def _run_plugin_over_local_transport(self):
        requests = []
        bridge = self.bridge

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _write(self, status, body, content_type="application/json"):
                raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Access-Control-Allow-Origin", "app://obsidian.md")
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                if self.path != "/generate":
                    return self._write(404, {"code": "no_route"})
                if self.headers.get("Origin") != "app://obsidian.md":
                    return self._write(403, {"code": "origin_denied"})
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if size <= 0 or size > 2000:
                        raise ValueError("invalid_request_size")
                    body = json.loads(self.rfile.read(size))
                    requests.append(body)
                    origin = f"http://127.0.0.1:{self.server.server_port}"
                    return self._write(201, bridge.generate(body, origin=origin))
                except (ValueError, OSError) as error:
                    return self._write(409, {"code": str(error)[:160]})

            def do_GET(self):
                prefix = "/preview/"
                if not self.path.startswith(prefix):
                    return self._write(404, {"code": "no_preview"})
                try:
                    content = bridge.preview(self.path[len(prefix):])
                    return self._write(200, content, "text/html; charset=utf-8")
                except (ValueError, KeyError):
                    return self._write(404, {"code": "no_preview"})

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            proc = subprocess.run(
                [
                    str(NODE), "-e", NODE_DRIVER, str(PLUGIN), str(self.vault), origin,
                    self.selected, self.source,
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
                env={**os.environ, "TMPDIR": os.environ.get("TMPDIR", "/mnt/e/Hermes/cache/scratch")},
            )
            fetched = None
            if proc.returncode == 0:
                line = next((row for row in proc.stdout.splitlines() if row.startswith("PLUGIN_RESULT=")), None)
                if line is not None:
                    shown = json.loads(line.split("=", 1)[1])["shown"]
                    with urlopen(shown["preview_url"], timeout=3) as response:
                        fetched = response.read()
            return origin, requests, proc, fetched
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_actual_plugin_generate_uses_producer_package_and_real_pending_contract(self) -> None:
        self.assertTrue(NODE.is_file(), f"pinned Node runtime unavailable: {NODE}")
        origin, requests, proc, fetched = self._run_plugin_over_local_transport()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        line = next((row for row in proc.stdout.splitlines() if row.startswith("PLUGIN_RESULT=")), None)
        self.assertIsNotNone(line, proc.stdout + proc.stderr)
        plugin_result = json.loads(line.split("=", 1)[1])
        result = plugin_result["result"]
        shown = plugin_result["shown"]
        self.assertEqual(requests, [{"path": self.selected, "source_sha256": sha(self.source.encode())}])
        self.assertEqual(len(self.prepared), 1)
        server = self.prepared[0]
        self.assertEqual(server["status"], 201, server)
        self.assertTrue(server["pre_staged_fixture_removed_before_upload"], server)
        self.assertEqual(server["private_upload_status"], 201, server)
        self.assertEqual(server["private_query_status"], 200, server)
        self.assertTrue(server["private_query_identity_matches"], server)
        self.assertTrue(server["uploaded_resource_bytes_exact"], server)
        self.assertTrue(server["private_owner_bound"], server)
        self.assertTrue(server["pending_snapshot_bound"], server)
        self.assertTrue(server["server_snapshot_content_matches_producer"], server)
        self.assertEqual(server["data"]["state"], "pending", server)
        self.assertEqual(server["data"]["id"], shown["preview_id"])
        self.assertEqual(server["data"]["digest"], shown["digest"])
        self.assertEqual(result["package_id"], shown["package_id"])
        self.assertEqual(shown["source_sha256"], sha(self.source.encode()))
        self.assertEqual(shown["publication_approval"], False)
        self.assertEqual(shown["state"], "pending")
        self.assertEqual(shown["path"], self.selected)
        self.assertEqual(shown["preview_url"], origin + "/preview/" + shown["preview_id"])
        html_bytes = shown["html"].encode("utf-8")
        self.assertEqual(sha(html_bytes), shown["preview_sha256"])
        self.assertEqual(fetched, html_bytes)
        self.assertIn("approved display text", shown["html"])
        evidence = {
            "schema": "publication-v1-local-bridge-tracer",
            "verdict": "PASS",
            "synthetic_only": True,
            "plugin_generate_ok": result["ok"],
            "bridge_post_count": len(requests),
            "server_create_status": server["status"],
            "pre_staged_fixture_removed_before_upload": server["pre_staged_fixture_removed_before_upload"],
            "private_package_upload_status": server["private_upload_status"],
            "private_package_query_status": server["private_query_status"],
            "private_package_owner_bound": server["private_owner_bound"],
            "private_package_bytes_exact": server["uploaded_resource_bytes_exact"],
            "server_state": server["data"]["state"],
            "server_pending_snapshot_bound": server["pending_snapshot_bound"],
            "server_snapshot_content_matches_producer": server["server_snapshot_content_matches_producer"],
            "operation_id": shown["preview_id"],
            "package_id_sha256": shown["package_id"],
            "source_sha256": shown["source_sha256"],
            "labels_sha256": sha(self.labels_raw),
            "server_digest": shown["digest"],
            "preview_sha256": shown["preview_sha256"],
            "preview_readback_sha256": sha(fetched),
            "preview_origin": origin,
            "publication_approval": False,
            "approval_attempted": False,
            "commit_attempted": False,
            "remote_upload_attempted": False,
            "simulated_approval": False,
        }
        (OUTPUT / "tracer.json").write_text(json.dumps(evidence, indent=2) + chr(10), encoding="utf-8")
        print("BRIDGE_V1_EVIDENCE=" + json.dumps(evidence, sort_keys=True))

    def test_unknown_prepare_result_is_not_retried_in_same_bridge_instance(self) -> None:
        calls = []

        def uncertain_prepare(*_args):
            calls.append("attempt")
            raise TimeoutError("synthetic response loss")

        bridge = LocalPreviewBridge(
            vault=self.vault, selected=self.selected, store=self.store, prepare=uncertain_prepare
        )
        request = {"path": self.selected, "source_sha256": sha(self.source.encode())}
        with self.assertRaisesRegex(ValueError, "server_outcome_unknown"):
            bridge.generate(request, origin="http://127.0.0.1:12345")
        with self.assertRaisesRegex(ValueError, "prepare_attempt_already_made"):
            bridge.generate(request, origin="http://127.0.0.1:12345")
        self.assertEqual(calls, ["attempt"])

    def test_label_change_during_server_prepare_invalidates_preview_without_retry(self) -> None:
        calls = []

        def mutate_labels(package, selected, source_hash, labels_hash):
            calls.append((selected, source_hash, labels_hash))
            self.note.with_suffix(".labels.json").write_bytes(b'{"target":"changed approval"}\\n')
            return {
                "status": 201,
                "data": {
                    "id": "f" * 32,
                    "digest": "d" * 64,
                    "state": "pending",
                    "preview_url": "https://publication-v1.example.test/?publication_v1_preview=" + "f" * 32,
                },
                "pending_snapshot_bound": True,
                "publication_approval": False,
                "expires_at": int(__import__("time").time()) + 300,
            }

        bridge = LocalPreviewBridge(
            vault=self.vault, selected=self.selected, store=self.store, prepare=mutate_labels
        )
        request = {"path": self.selected, "source_sha256": sha(self.source.encode())}
        with self.assertRaisesRegex(ValueError, "selected_inputs_changed_after_prepare"):
            bridge.generate(request, origin="http://127.0.0.1:12345")
        self.assertEqual(len(calls), 1, "an indeterminate/pending operation must not be retried")
        self.assertEqual(bridge._previews, {})

    def test_disk_source_mismatch_is_rejected_before_server_prepare(self) -> None:
        request = {"path": self.selected, "source_sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "selected_source_mismatch"):
            self.bridge.generate(request, origin="http://127.0.0.1:12345")
        self.assertEqual(self.prepared, [])

    def test_image_without_explicit_approval_is_rejected(self) -> None:
        self.source = "![unapproved](figure.png)\n"
        self.note.write_text(self.source, encoding="utf-8")
        request = {"path": self.selected, "source_sha256": sha(self.source.encode())}
        with self.assertRaisesRegex(ValueError, "unapproved_local_image"):
            self.bridge.generate(request, origin="http://127.0.0.1:12345")
        self.assertEqual(self.prepared, [])


if __name__ == "__main__":
    unittest.main()
