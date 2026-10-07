"""Focused end-to-end test for authenticated unsaved-editor live preview."""
from __future__ import annotations

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from runtime_paths import node_binary, parser_root

sys.path.insert(0, str(ROOT / "bridge"))
from publication_session import BridgeDispatcher, BridgeSession

NODE = node_binary()
PARSER = parser_root()
PLUGIN = ROOT / "plugin" / "main.js"
POLICY = "a" * 64
ORIGIN = "app://obsidian.md"
SELECTED = "notes/selected.md"
SAVED = b"# Saved disk version\n"
UNSAVED = "# Stale editor version\n"
UPDATED = "# Current editor version\n"

NODE_DRIVER = r'''const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return {
    Plugin: class Plugin {}, Notice: class Notice {}, ItemView: class ItemView {},
  };
  return originalLoad.call(this, request, parent, isMain);
};
(async () => {
  const [pluginPath, origin, selected, initialText, updatedText] = process.argv.slice(1);
  const authorization = process.env.PUBLICATION_TEST_AUTH;
  const issued = [], revoked = [];
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const value = create(blob); issued.push(value); return value; };
  URL.revokeObjectURL = value => { revoked.push(value); return revoke(value); };
  const EntryPreview = require(pluginPath);
  const file = { extension: 'md', path: selected };
  let editorText = initialText, diskReads = 0, enumerations = 0;
  const events = [];
  const markdownView = { file, getMode: () => 'source', editor: { getValue: () => editorText } };
  const writingLeaf = { view: { update: event => events.push(event), frame: { ownerDocument: { defaultView: { URL, Blob } } } }, setViewState: async () => {} };
  const app = {
    vault: {
      adapter: { getBasePath: () => '/synthetic' },
      read: async () => { diskReads++; throw Error('disk_read_forbidden'); },
      getMarkdownFiles: () => { enumerations++; throw Error('vault_enumeration_forbidden'); },
    },
    workspace: {
      getActiveFile: () => file,
      getLeavesOfType: type => type === 'markdown' ? [{ view: markdownView }]
        : type === 'blog-entry-writing-preview' ? [writingLeaf] : [],
      getLeaf: () => writingLeaf,
      detachLeavesOfType: () => {},
    },
  };
  const plugin = new EntryPreview();
  Object.assign(plugin, { app, config: { expectedVault: '/synthetic' } });
  plugin.setPublicationSession({
    origin, authorization, selected, title: 'Explicit Live Title',
    approvedAssets: {}, approvedLabels: {},
  });
  const started = await plugin.startLive();
  if (!started.ok) throw Error('live_start_failed');
  const firstRun = plugin.live.run();
  setTimeout(() => { editorText = updatedText; }, 10);
  await firstRun;
  const stateAfterStaleResponse = plugin.liveLast.state;
  const statesAfterStaleResponse = events.map(event => event.state);
  const staleRevokedCount = revoked.length;
  await plugin.live.run();
  const final = plugin.liveLast;
  const result = {
    started: started.ok,
    stateAfterStaleResponse,
    statesAfterStaleResponse,
    staleRevokedCount,
    state: final.state,
    path: final.selected?.path,
    source_sha256: final.selected?.source_sha256,
    code: final.code,
    srcdoc: final.out?.srcdoc || '',
    publication_approval: final.publication_approval,
    diskReads, enumerations, issuedCount: issued.length,
  };
  plugin.onunload();
  result.allObjectUrlsRevoked = issued.every(value => revoked.includes(value));
  process.stdout.write(JSON.stringify(result));
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 3; });
'''


class NoRemoteTransport:
    def __init__(self):
        self.calls = []

    def upload(self, *args):
        self.calls.append(("upload", args))
        raise AssertionError("live preview must not upload")

    def prepare(self, *args):
        self.calls.append(("prepare", args))
        raise AssertionError("live preview must not create an operation")

    def commit(self, *args):
        self.calls.append(("commit", args))
        raise AssertionError("live preview must not commit")


class PluginLiveSessionTests(unittest.TestCase):
    def test_actual_plugin_renders_only_current_unsaved_text_through_authenticated_session(self):
        scratch = Path(os.environ["TMPDIR"])
        before_ephemeral = set(scratch.glob("publication-live-*"))
        with tempfile.TemporaryDirectory(prefix="plugin-live-session-", dir=scratch) as temporary:
            root = Path(temporary)
            vault = root / "vault"
            note = vault / SELECTED
            note.parent.mkdir(parents=True)
            note.write_bytes(SAVED)
            labels = note.with_suffix(".labels.json")
            labels.write_bytes(b'{"disk-only":"must not be loaded"}\n')
            image = note.parent / "unapproved.png"
            image.write_bytes(b"not read unless explicitly approved")
            saved_labels = labels.read_bytes()
            saved_image = image.read_bytes()
            store = root / "packages"
            receipts = root / "receipts"
            transport = NoRemoteTransport()
            session = BridgeSession(
                vault=vault, selected=SELECTED, store=store, receipts_dir=receipts,
                transport=transport, site_pin="https://example.test", policy_sha256=POLICY,
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
            server.dispatcher = BridgeDispatcher(session, pinned_host=f"127.0.0.1:{server.server_port}")
            authorization = server.dispatcher.take_startup_authorization()
            requests = []
            live_count = 0

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def _dispatch(self):
                    nonlocal live_count
                    raw = self.rfile.read(int(self.headers.get("Content-Length", "0"))) if self.command == "POST" else b""
                    body = json.loads(raw) if raw else None
                    requests.append({
                        "method": self.command, "path": self.path, "body": body,
                        "authorized": self.headers.get("Authorization") == authorization,
                        "origin": self.headers.get("Origin"), "host": self.headers.get("Host"),
                    })
                    if self.path == "/v1/live" and self.command == "POST":
                        live_count += 1
                        if live_count == 1:
                            time.sleep(0.1)
                    status, headers, response = server.dispatcher.dispatch(
                        self.command, self.path, dict(self.headers.items()), raw
                    )
                    self.send_response(status)
                    for name, value in headers.items():
                        self.send_header(name, value)
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)

                do_GET = _dispatch
                do_POST = _dispatch

            server.RequestHandlerClass = Handler
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{server.server_port}"
            env = os.environ.copy()
            env["PUBLICATION_NODE"] = str(NODE)
            env["PUBLICATION_PARSER_ROOT"] = str(PARSER)
            env["PUBLICATION_TEST_AUTH"] = authorization
            try:
                process = subprocess.run(
                    [str(NODE), "-e", NODE_DRIVER, str(PLUGIN), origin, SELECTED, UNSAVED, UPDATED],
                    capture_output=True, text=True, timeout=120, check=False, env=env,
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(process.stdout)
            self.assertTrue(result["started"])
            self.assertEqual(result["stateAfterStaleResponse"], "waiting", result)
            self.assertNotIn("synced", result["statesAfterStaleResponse"])
            self.assertGreater(result["staleRevokedCount"], 0)
            self.assertEqual(result["state"], "synced")
            self.assertEqual(result["path"], SELECTED)
            self.assertEqual(result["source_sha256"], hashlib.sha256(UPDATED.encode()).hexdigest())
            self.assertIn("Current editor version", result["srcdoc"])
            self.assertNotIn("Stale editor version", result["srcdoc"])
            self.assertNotIn("Saved disk version", result["srcdoc"])
            self.assertIn("default-src 'none'", result["srcdoc"])
            self.assertIn("<style>", result["srcdoc"])
            self.assertNotIn('<link rel="stylesheet"', result["srcdoc"])
            self.assertIn("color-scheme:", result["srcdoc"])
            self.assertIn("blob:", result["srcdoc"])
            self.assertNotIn("/v1/assets/", result["srcdoc"])
            self.assertFalse(result["publication_approval"])
            self.assertEqual(result["diskReads"], 0)
            self.assertEqual(result["enumerations"], 0)
            self.assertGreater(result["issuedCount"], 0)
            self.assertTrue(result["allObjectUrlsRevoked"])
            live_requests = [request for request in requests if request["path"] == "/v1/live"]
            self.assertEqual([request["body"]["text"] for request in live_requests], [UNSAVED, UPDATED])
            self.assertEqual([request["body"]["path"] for request in live_requests], [SELECTED, SELECTED])
            self.assertEqual(
                [request["body"]["source_sha256"] for request in live_requests],
                [hashlib.sha256(UNSAVED.encode()).hexdigest(), hashlib.sha256(UPDATED.encode()).hexdigest()],
            )
            for request in live_requests:
                self.assertTrue(request["authorized"])
                self.assertEqual(request["origin"], ORIGIN)
                self.assertEqual(request["body"]["approved_assets"], {})
                self.assertEqual(request["body"]["approved_labels"], {})
                self.assertNotIn("authorization", request["body"])
            resource_requests = [request for request in requests if request["path"].startswith("/v1/assets/")]
            self.assertGreater(len(resource_requests), 0)
            self.assertTrue(all(request["authorized"] and request["origin"] == ORIGIN for request in resource_requests))
            self.assertTrue(all("?" not in request["path"] and "#" not in request["path"] for request in requests))
            self.assertFalse(any("/v1/prepare" in request["path"] or "/v1/commit" in request["path"] for request in requests))
            self.assertEqual(transport.calls, [])
            self.assertEqual(note.read_bytes(), SAVED)
            self.assertEqual(labels.read_bytes(), saved_labels)
            self.assertEqual(image.read_bytes(), saved_image)
            self.assertEqual(list(receipts.glob("*.json")) if receipts.exists() else [], [])

            invalid = {
                "path": SELECTED, "text": "![unapproved](unapproved.png)\n",
                "source_sha256": hashlib.sha256(b"![unapproved](unapproved.png)\n").hexdigest(),
                "title": "Explicit Live Title", "approved_assets": {}, "approved_labels": {},
            }
            headers = {
                "Origin": ORIGIN, "Host": f"127.0.0.1:{server.server_port}",
                "Authorization": authorization, "Content-Type": "application/json",
            }
            for changes, expected_code in (
                ({"path": "notes/other.md"}, "selected_path_mismatch"),
                ({"source_sha256": "0" * 64}, "source_hash_mismatch"),
                ({"text": "x" * 10001, "source_sha256": hashlib.sha256(b"x" * 10001).hexdigest()}, "source_too_large"),
                ({}, None),
            ):
                body = {**invalid, **changes}
                status, _response_headers, response = server.dispatcher.dispatch(
                    "POST", "/v1/live", headers,
                    json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(),
                )
                self.assertEqual(status, 409)
                if expected_code:
                    self.assertEqual(json.loads(response)["code"], expected_code)
            self.assertEqual(transport.calls, [])
            self.assertEqual(note.read_bytes(), SAVED)
        self.assertEqual(set(scratch.glob("publication-live-*")), before_ephemeral)


if __name__ == "__main__":
    unittest.main()
