"""Connected HTTP-session to fresh, persistent WordPress-WASM seam."""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "bridge"
OUTPUT = Path(tempfile.gettempdir()) / "publication-v1-session-output"
WORKER = Path(__file__).resolve().parent / "fixtures" / "wp-session-worker.mjs"
OUTPUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(BRIDGE))
sys.path.insert(0, str(ROOT / "tests"))

from http_listener import LoopbackHTTPListener  # noqa: E402
from wp_transport import WordPressTransport  # noqa: E402
from publication_session import BridgeSession  # noqa: E402
from test_wordpress_runtime import NODE, SERVER, WP_CORE, cached_modules, png_fixture  # noqa: E402

SITE = "https://publication-v1.example.test"
ORIGIN = "app://obsidian.md"
POLICY = hashlib.sha256(b"isolated synthetic publication policy").hexdigest()


def http_exchange(port: int, method: str, path: str, *, headers=None, body=b""):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        actual = {"Connection": "close", **(headers or {})}
        connection.request(method, path, body=body, headers=actual)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def raw_status(port: int, request_headers: list[str], method: str = "POST") -> int:
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        request = "POST /v1/prepare HTTP/1.1\r\n" + "\r\n".join(request_headers) + "\r\n\r\n"
        if method != "POST":
            request = request.replace("POST /v1/prepare", f"{method} /v1/prepare", 1)
        sock.sendall(request.encode("ascii"))
        sock.settimeout(5)
        line = bytearray()
        while not line.endswith(b"\r\n"):
            chunk = sock.recv(1)
            if not chunk:
                break
            line.extend(chunk)
        return int(bytes(line).split(b" ", 2)[1])
    finally:
        sock.close()


def assert_port_closed(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise AssertionError(f"owned loopback port {port} remained open")


NODE_SESSION_CLIENT = r"""
const client = require(process.argv[1]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  let rendered;
  try {
    const value = JSON.parse(input);
    const session = { origin: value.origin, authorization: value.authorization,
      selected: value.selected.path, title: value.title, approvedAssets: value.approvedAssets,
      approvedLabels: {}, workflowConnected: true, sitePin: value.sitePin };
    const receipt = await client.discoverPublicationReceipt(session, value.selected);
    const status = await client.publicationStatus(session, receipt.operation_id);
    const browserWindow = { Blob: class Blob { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
      URL: { createObjectURL: (() => { let n = 0; return () => `blob:session-test-${++n}`; })(), revokeObjectURL() {} } };
    rendered = await client.renderFrozenSession(session, value.selected, receipt, browserWindow);
    process.stdout.write(JSON.stringify({
      operation_id: receipt.operation_id, receipt_state: receipt.state, remote_state: status.remote.state,
      digest: rendered.digest, package_id: rendered.package_id,
      rendered_sha256: require('node:crypto').createHash('sha256').update(rendered.rendered).digest('hex'),
      srcdoc_has_csp: rendered.srcdoc.includes('Content-Security-Policy'),
      srcdoc_has_loopback_resource_url: rendered.srcdoc.includes('/resources/'),
      srcdoc_has_no_anchor_href: !/<a\b[^>]*\bhref\s*=/.test(rendered.srcdoc),
      srcdoc_preserves_inert_link_markup: /<a\b[^>]*>普通链接<\/a>/.test(rendered.srcdoc),
      srcdoc_has_math_markup: rendered.srcdoc.includes('class="katex"') && rendered.srcdoc.includes('<math'),
      publication_approval: rendered.publication_approval,
    }));
  } catch (error) {
    process.stderr.write(`node_session_client_failed:${error.message}`);
    process.exitCode = 1;
  } finally { rendered?.dispose?.(); }
});
"""


class SessionWordPressIntegrationTests(unittest.TestCase):
    def test_authenticated_listener_private_wordpress_lifecycle_and_readback(self):
        self.assertTrue(NODE.is_file(), f"pinned Node runtime missing: {NODE}")
        self.assertTrue(WORKER.is_file(), "persistent isolated PHP-WASM worker is missing")
        with tempfile.TemporaryDirectory(prefix="session-wp-", dir=OUTPUT) as run_dir:
            root = Path(run_dir)
            selected = "文章/子目录/真实接线.md"
            vault = root / "synthetic-vault"
            note = vault / selected
            note.parent.mkdir(parents=True)
            source = "# 合成闭环\n\n真实 producer、批准 PNG 与 [普通链接](https://example.test/path)。\n\n![像素](图.png)\n\n公式 $a^2+b^2=c^2$。\n\n$$\n\\frac{1}{2}\n$$\n"
            note.write_text(source, encoding="utf-8")
            image = png_fixture()
            (note.parent / "图.png").write_bytes(image)
            note.with_suffix(".labels.json").write_bytes(b"{}")
            approvals = {"图.png": {"sha256": hashlib.sha256(image).hexdigest(), "mime": "image/png"}}

            from package_builder import build as build_package
            package_store = root / "package-probe"
            package_id = build_package(package_store, selected, vault, approved_assets=approvals, title="真实 WP 会话接线")
            manifest = json.loads((package_store / package_id / "manifest.json").read_bytes())
            compiler_sha = hashlib.sha256(json.dumps(manifest["compiler"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
            import shutil
            shutil.rmtree(package_store)

            php_runtime = cached_modules()
            run_id = uuid.uuid4().hex
            payload = {
                "modules": str(php_runtime),
                "wpCore": str(WP_CORE),
                "sqliteZip": str(php_runtime / "@wp-playground/cli/sqlite-database-integration.zip"),
                "serverPath": str(SERVER),
                "runId": run_id,
                "compilerSha256": compiler_sha,
            }
            encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
            worker_env = dict(os.environ)
            worker_env["PYTHONDONTWRITEBYTECODE"] = "1"
            worker = subprocess.Popen(
                [str(NODE), str(WORKER), encoded],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=worker_env,
            )
            wp_port = None
            bridge = None
            bridge_port = None
            safe_bridge = None
            safe_bridge_port = None
            try:
                import selectors
                selector = selectors.DefaultSelector()
                selector.register(worker.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=180):
                    raise AssertionError("persistent WordPress-WASM worker did not become ready")
                ready_line = worker.stdout.readline()
                selector.close()
                ready = json.loads(ready_line)
                self.assertEqual(ready["type"], "READY")
                wp_port = int(ready["port"])
                publisher_token = ready["publisherToken"]
                control_token = ready["controlToken"]
                self.assertTrue(1 <= wp_port <= 65535)

                call_counts = {}
                package_readbacks = {}
                remote_responses = {"uploads": []}
                operation_post_ids = []
                lose_prepare_response = {"armed": True}

                def wp_request(method, path, headers, body):
                    key = (method, path)
                    call_counts[key] = call_counts.get(key, 0) + 1
                    safe_headers = dict(headers or {})
                    safe_headers["X-Test-Publisher"] = publisher_token
                    status, _response_headers, response_body = http_exchange(wp_port, method, path, headers=safe_headers, body=body or b"")
                    if method == "POST" and path == "/wp-json/publication-v1/v1/packages":
                        remote_responses["uploads"].append((status, response_body[:1024]))
                    if method == "POST" and path == "/wp-json/publication-v1/v1/operations":
                        operation_post_ids.append(json.loads(body)["id"])
                    if method == "GET" and path == f"/wp-json/publication-v1/v1/packages/{package_id}":
                        package_readbacks["response"] = (status, response_body)
                    if method == "POST" and path == "/wp-json/publication-v1/v1/operations" and lose_prepare_response["armed"]:
                        lose_prepare_response["armed"] = False
                        raise TimeoutError("SIMULATED lost prepare response")
                    return status, response_body

                now = int(time.time())
                transport = WordPressTransport(request=wp_request, clock=lambda: now)
                session = BridgeSession(
                    vault=vault,
                    selected=selected,
                    store=root / "packages",
                    receipts_dir=root / "receipts",
                    transport=transport,
                    site_pin=SITE,
                    policy_sha256=POLICY,
                )
                bridge = LoopbackHTTPListener(session, max_body_bytes=64 * 1024)
                bridge.start()
                bridge_port = bridge.port
                self.assertEqual(bridge.host, "127.0.0.1")
                self.assertEqual(bridge.host_header, f"127.0.0.1:{bridge_port}")
                authorization = bridge.take_startup_authorization()

                self.assertEqual(raw_status(bridge_port, [f"Host: {bridge.host_header}", "Origin: app://obsidian.md", "Content-Length: 999999999", "Connection: close"]), 401)
                self.assertEqual(raw_status(bridge_port, [f"Host: {bridge.host_header}", "Origin: https://evil.example", f"Authorization: {authorization}", "Content-Length: 999999999", "Connection: close"]), 403)
                self.assertEqual(raw_status(bridge_port, ["Host: localhost:1", "Origin: app://obsidian.md", f"Authorization: {authorization}", "Content-Length: 999999999", "Connection: close"]), 403)
                self.assertEqual(raw_status(bridge_port, [f"Host: {bridge.host_header}", "Origin: app://obsidian.md", f"Authorization: {authorization}", "Content-Length: 999999999", "Connection: close"]), 413)
                self.assertEqual(raw_status(bridge_port, [f"Host: {bridge.host_header}", "Origin: app://obsidian.md", f"Authorization: {authorization}", "Content-Length: 999999999", "Connection: close"], method="PUT"), 405)

                def bridge_request(method, path, value=None):
                    body = b"" if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    return http_exchange(
                        bridge_port,
                        method,
                        path,
                        headers={"Origin": ORIGIN, "Authorization": authorization, "Content-Type": "application/json"},
                        body=body,
                    )

                status, _headers, body = bridge_request("POST", "/v1/prepare", {"title": "真实 WP 会话接线", "approved_assets": approvals})
                self.assertEqual(status, 409, body)
                self.assertEqual(json.loads(body)["code"], "server_outcome_unknown")
                receipts = list((root / "receipts").glob("*.json"))
                self.assertEqual(len(receipts), 1)
                receipt = json.loads(receipts[0].read_bytes())
                operation_id = receipt["operation_id"]
                unknown_operation_id = operation_id
                manifest_sha = receipt["manifest_sha256"]
                self.assertRegex(operation_id, r"^[0-9a-f]{32}$")
                self.assertEqual(manifest_sha, package_id)

                query_status, query_body = package_readbacks.get("response", (0, b""))
                package_query = json.loads(query_body) if query_status == 200 else {}
                identity = {
                    "private_package_valid": query_status == 200,
                    "package_owner_exact": package_query.get("package_id") == manifest_sha and package_query.get("manifest_sha256") == manifest_sha,
                    "package_manifest_sha256": package_query.get("manifest_sha256"),
                    "publisher_id": package_query.get("publisher_id"),
                    "site_id": package_query.get("site_id"),
                    "site_origin": package_query.get("site_origin"),
                    "server_policy_sha256": package_query.get("server_policy_sha256"),
                    "operation_state": None,
                }
                self.assertEqual(receipt["phase"], "prepare", {"phase": receipt["phase"], "calls": call_counts, "package_query": query_status, "upload_response": remote_responses["uploads"][0]})
                self.assertTrue(identity["private_package_valid"], {"identity": identity, "calls": call_counts, "package_query": query_status})
                self.assertTrue(identity["package_owner_exact"], identity)
                self.assertEqual(identity["package_manifest_sha256"], manifest_sha)
                self.assertIsInstance(identity["publisher_id"], int)
                self.assertGreater(identity["publisher_id"], 0)
                self.assertIsInstance(identity["site_id"], int)
                self.assertGreater(identity["site_id"], 0)
                self.assertEqual(identity["site_origin"], SITE + "/")
                self.assertRegex(identity["server_policy_sha256"], r"^[0-9a-f]{64}$")

                status, _headers, body = bridge_request("GET", f"/v1/status/{operation_id}")
                self.assertEqual(status, 200, body)
                status_value = json.loads(body)
                digest = status_value["remote"]["digest"]
                self.assertRegex(digest, r"^[0-9a-f]{64}$")
                self.assertEqual(status_value["remote"]["state"], "pending")
                self.assertEqual(status_value["receipt"]["operation_id"], operation_id)
                self.assertEqual(status_value["receipt"]["state"], "pending")
                self.assertEqual(status_value["receipt"]["remote_digest"], digest)
                remote_binding = status_value["remote"]["binding"]
                self.assertEqual(remote_binding["publisher_id"], identity["publisher_id"])
                self.assertEqual(remote_binding["site_id"], identity["site_id"])
                self.assertEqual(remote_binding["site_origin"], identity["site_origin"])
                self.assertEqual(remote_binding["manifest_sha256"], manifest_sha)
                self.assertEqual(remote_binding["selected_sha256"], hashlib.sha256(selected.encode("utf-8")).hexdigest())
                self.assertEqual(remote_binding["source_sha256"], package_query["source_sha256"])
                self.assertEqual(remote_binding["labels_sha256"], package_query["labels_sha256"])
                self.assertEqual(remote_binding["title_sha256"], hashlib.sha256("真实 WP 会话接线".encode("utf-8")).hexdigest())
                self.assertEqual(remote_binding["compiler_sha256"], compiler_sha)
                self.assertEqual(remote_binding["server_policy_sha256"], identity["server_policy_sha256"])
                self.assertGreater(remote_binding["expires_at"], int(time.time()))
                self.assertLessEqual(remote_binding["expires_at"], int(time.time()) + 3600)
                identity["operation_state"] = status_value["remote"]["state"]
                self.assertEqual(identity["operation_state"], "pending")

                # The approved publication PNG resource URL must render through
                # the exact WordPress pipeline without widening KSES or changing
                # the frozen reviewer-visible bytes.
                frozen_route = f"/wp-json/publication-v1/v1/operations/{operation_id}/snapshot"
                frozen_status, _headers, frozen_bytes = http_exchange(
                    wp_port, "GET", frozen_route, headers={"X-Test-Publisher": publisher_token}
                )
                self.assertEqual(frozen_status, 200, frozen_bytes)
                frozen_value = json.loads(frozen_bytes)
                self.assertEqual(frozen_value["digest"], digest)
                proof_status, _headers, proof_bytes = http_exchange(
                    wp_port, "POST", "/__test__/snapshot-readback-probes",
                    headers={"X-Test-Harness": control_token, "Content-Type": "application/json"},
                    body=json.dumps({"id": operation_id}).encode(),
                )
                proof = json.loads(proof_bytes)
                self.assertEqual(proof_status, 200, proof)
                self.assertEqual(proof["publisher_status"], 200, proof)
                self.assertTrue(proof["rendered_kses_unchanged"], proof)
                self.assertTrue(proof["rendered_matches_real_the_content"], proof)
                self.assertNotIn('decoding="async"', proof["rendered"])
                self.assertTrue(proof["unsupported_filter_output_rejected"], proof)
                self.assertEqual(proof["snapshot_sha256"], digest)
                self.assertEqual(proof["decoding_scope"], {"pretty": True, "query": True, "ordinary_unchanged": True, "foreign_unchanged": True, "missing_inventory_unchanged": True})
                self.assertIn("private", proof["snapshot_cache_control"])
                self.assertIn("no-store", proof["snapshot_cache_control"])
                self.assertEqual(proof["reviewer_status"], 403, proof)
                self.assertEqual(proof["other_publisher_status"], 404, proof)
                self.assertEqual(proof["anonymous_status"], 403, proof)
                frozen_status, _headers, frozen_body = bridge_request("GET", f"/v1/frozen/{operation_id}")
                self.assertEqual(frozen_status, 200)
                frozen_png = json.loads(frozen_body)
                self.assertEqual(frozen_png["digest"], digest)
                self.assertEqual(frozen_png["operation_id"], operation_id)
                self.assertEqual(json.loads(frozen_png["snapshot_json"])["rendered"], proof["rendered"])
                self.assertIs(frozen_png["publication_approval"], False)
                node_input = {
                    "origin": bridge.url,
                    "authorization": authorization,
                    "selected": {"path": selected, "source_sha256": receipt["source_sha256"]},
                    "title": "真实 WP 会话接线",
                    "approvedAssets": approvals,
                    "sitePin": SITE,
                }
                node_result = subprocess.run(
                    [str(NODE), "-e", NODE_SESSION_CLIENT, str(ROOT / "plugin" / "session_client.js")],
                    input=json.dumps(node_input, ensure_ascii=False),
                    text=True, capture_output=True, timeout=60, check=False,
                )
                self.assertEqual(node_result.returncode, 0, node_result.stderr)
                node_session_client = json.loads(node_result.stdout)
                self.assertEqual(node_session_client["operation_id"], unknown_operation_id)
                self.assertEqual(node_session_client["receipt_state"], "pending")
                self.assertEqual(node_session_client["remote_state"], "pending")
                self.assertEqual(node_session_client["digest"], digest)
                self.assertEqual(node_session_client["package_id"], manifest_sha)
                self.assertEqual(node_session_client["rendered_sha256"], hashlib.sha256(proof["rendered"].encode("utf-8")).hexdigest())
                self.assertTrue(node_session_client["srcdoc_has_csp"])
                self.assertFalse(node_session_client["srcdoc_has_loopback_resource_url"])
                self.assertTrue(node_session_client["srcdoc_has_no_anchor_href"])
                self.assertTrue(node_session_client["srcdoc_preserves_inert_link_markup"])
                self.assertTrue(node_session_client["srcdoc_has_math_markup"])
                self.assertIs(node_session_client["publication_approval"], False)
                self.assertEqual(operation_post_ids.count(unknown_operation_id), 1)
                self.assertEqual(len(operation_post_ids), 1)
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/commit"), 0), 0)
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/operations"), 0), 1)

                # A separate saved, text-only synthetic note exercises successful
                # frozen read-back through the same persistent real WordPress
                # worker without bypassing its KSES/rendering gate.
                safe_selected = "文章/子目录/安全读回.md"
                safe_note = vault / safe_selected
                safe_note.write_text("# 安全读回\n\n[普通链接](https://example.test/path)。\n", encoding="utf-8")
                safe_note.with_suffix(".labels.json").write_bytes(b"{}")
                safe_session = BridgeSession(
                    vault=vault, selected=safe_selected, store=root / "packages",
                    receipts_dir=root / "safe-receipts", transport=transport,
                    site_pin=SITE, policy_sha256=POLICY,
                )
                safe_receipt = safe_session.prepare("安全读回文章", {})
                safe_operation_id = safe_receipt["operation_id"]
                self.assertNotEqual(safe_operation_id, operation_id)
                safe_bridge = LoopbackHTTPListener(safe_session)
                safe_bridge.start()
                safe_bridge_port = safe_bridge.port
                safe_authorization = safe_bridge.take_startup_authorization()
                safe_path = f"/v1/frozen/{safe_operation_id}"
                missing_auth_status, _headers, _body = http_exchange(
                    safe_bridge_port, "GET", safe_path, headers={"Origin": ORIGIN}
                )
                self.assertEqual(missing_auth_status, 401)
                wrong_origin_status, _headers, _body = http_exchange(
                    safe_bridge_port, "GET", safe_path,
                    headers={"Origin": "https://evil.example", "Authorization": safe_authorization},
                )
                self.assertEqual(wrong_origin_status, 403)

                def safe_bridge_request():
                    return http_exchange(
                        safe_bridge_port, "GET", safe_path,
                        headers={"Origin": ORIGIN, "Authorization": safe_authorization},
                    )

                safe_status, safe_response_headers, safe_body = safe_bridge_request()
                self.assertEqual(safe_status, 200, safe_body)
                safe_frozen = json.loads(safe_body)
                self.assertEqual(set(safe_frozen), {"operation_id", "digest", "state", "snapshot_json", "package_id", "publication_approval"})
                self.assertEqual(safe_frozen["operation_id"], safe_operation_id)
                self.assertEqual(safe_frozen["digest"], safe_receipt["remote_digest"])
                self.assertEqual(safe_frozen["state"], "pending")
                self.assertEqual(safe_frozen["package_id"], safe_receipt["manifest_sha256"])
                self.assertIs(safe_frozen["publication_approval"], False)
                self.assertEqual(safe_response_headers["Cache-Control"], "no-store")
                no_auth_asset_status, _headers, _body = http_exchange(
                    safe_bridge_port, "GET", f"{safe_path}/assets", headers={"Origin": ORIGIN}
                )
                self.assertEqual(no_auth_asset_status, 401)
                safe_raw = safe_frozen["snapshot_json"].encode("utf-8")
                self.assertEqual(hashlib.sha256(safe_raw).hexdigest(), safe_frozen["digest"])
                safe_snapshot = json.loads(safe_raw)
                self.assertEqual(safe_snapshot["operation_key"], safe_operation_id)
                self.assertEqual(safe_snapshot["source_sha256"], safe_receipt["source_sha256"])
                self.assertEqual(safe_snapshot["title"], "安全读回文章")
                safe_proof_status, _headers, safe_proof_bytes = http_exchange(
                    wp_port, "POST", "/__test__/snapshot-readback-probes",
                    headers={"X-Test-Harness": control_token, "Content-Type": "application/json"},
                    body=json.dumps({"id": safe_operation_id}).encode(),
                )
                safe_proof = json.loads(safe_proof_bytes)
                self.assertEqual(safe_proof_status, 200, safe_proof)
                self.assertEqual(safe_proof["publisher_status"], 200, safe_proof)
                self.assertEqual(safe_proof["snapshot_json"], safe_frozen["snapshot_json"])
                self.assertEqual(safe_proof["rendered"], safe_snapshot["rendered"])
                self.assertTrue(safe_proof["rendered_kses_unchanged"], safe_proof)
                self.assertTrue(safe_proof["rendered_matches_real_the_content"], safe_proof)
                self.assertEqual(safe_proof["snapshot_sha256"], safe_frozen["digest"])
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/commit"), 0), 0)
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/operations"), 0), 2)

                # Modified bodies cannot override the digest already anchored in
                # the safe operation's durable receipt.
                original_frozen_snapshot = transport.frozen_snapshot
                try:
                    for mutation, replace_digest in (("changed-rendered", False), ("changed-operation", True), ("changed-source", True)):
                        changed = dict(safe_snapshot)
                        if mutation == "changed-rendered":
                            changed["rendered"] += "tampered"
                        elif mutation == "changed-operation":
                            changed["operation_key"] = "f" * 32
                        else:
                            changed["source_sha256"] = "0" * 64
                        changed_json = json.dumps(changed, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                        changed_digest = hashlib.sha256(changed_json.encode("utf-8")).hexdigest() if replace_digest else safe_frozen["digest"]
                        transport.frozen_snapshot = lambda _operation_id, raw=changed_json, changed_hash=changed_digest: {
                            "id": safe_operation_id, "digest": changed_hash, "state": "pending", "snapshot_json": raw,
                        }
                        rejected_status, _headers, rejected_body = safe_bridge_request()
                        self.assertEqual(rejected_status, 404, (mutation, rejected_body))
                finally:
                    transport.frozen_snapshot = original_frozen_snapshot

                saved_source = safe_note.read_bytes()
                safe_note.write_bytes(saved_source + b"local source drift\n")
                drift_status, _headers, drift_body = safe_bridge_request()
                self.assertEqual(drift_status, 404, drift_body)
                safe_note.write_bytes(saved_source)

                probe_status, _headers, probe_bytes = http_exchange(
                    wp_port, "POST", "/__test__/unapproved-commit-probe",
                    headers={"X-Test-Harness": control_token, "Content-Type": "application/json"},
                    body=json.dumps({"id": operation_id, "digest": digest}).encode(),
                )
                probe = json.loads(probe_bytes)
                self.assertEqual(probe_status, 200)
                self.assertEqual(probe["status"], 409, probe)

                status, _headers, body = bridge_request("POST", "/v1/prepare", {"title": "真实 WP 会话接线", "approved_assets": approvals})
                self.assertEqual(status, 409, body)
                self.assertEqual(json.loads(body)["code"], "operation_outcome_unresolved")
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/packages"), 0), 2)
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/operations"), 0), 2)
                self.assertEqual(operation_post_ids.count(operation_id), 1)
                self.assertEqual(operation_post_ids.count(safe_operation_id), 1)
                self.assertEqual(len(operation_post_ids), 2)
                self.assertEqual([row[0] for row in remote_responses["uploads"]], [201, 201])

                review_status, _headers, review_bytes = http_exchange(
                    wp_port, "POST", "/__test__/simulated-reviewer-approval",
                    headers={"X-Test-Harness": control_token, "Content-Type": "application/json"},
                    body=json.dumps({"id": operation_id, "digest": digest}).encode(),
                )
                review = json.loads(review_bytes)
                self.assertEqual(review_status, 200)
                self.assertTrue(review["SIMULATED"], review)
                self.assertEqual(review["status"], 200, review)

                status, _headers, body = bridge_request("GET", f"/v1/status/{operation_id}")
                self.assertEqual(status, 200, body)
                approved_status = json.loads(body)
                self.assertEqual(approved_status["remote"]["state"], "approved")
                self.assertEqual(approved_status["receipt"]["state"], "pending")
                status, _headers, body = bridge_request("POST", f"/v1/commit/{operation_id}", {"digest": digest})
                self.assertEqual(status, 200, body)
                committed = json.loads(body)
                self.assertEqual(committed["state"], "committed")
                self.assertEqual(committed["remote_digest"], digest)

                status, _headers, body = bridge_request("GET", f"/v1/status/{operation_id}")
                self.assertEqual(status, 200, body)
                self.assertEqual(json.loads(body)["remote"]["state"], "committed")
                readback_status, _headers, readback_bytes = http_exchange(
                    wp_port, "POST", "/__test__/public-readback",
                    headers={"X-Test-Harness": control_token, "Content-Type": "application/json"},
                    body=json.dumps({
                        "operation_id": operation_id,
                        "image_sha256": approvals["图.png"]["sha256"],
                        "title_php": "真实 WP 会话接线",
                    }, ensure_ascii=False).encode("utf-8"),
                )
                readback = json.loads(readback_bytes)
                self.assertEqual(readback_status, 200)
                self.assertEqual(readback["state"], "committed")
                self.assertTrue(readback["db_exact"], readback)
                self.assertTrue(readback["one_post"], readback)
                self.assertTrue(readback["reviewer_distinct"], readback)
                self.assertEqual(readback["core_status"], 200, readback)
                core = json.loads(readback["core"])
                self.assertEqual(core["status"], "publish", core)
                self.assertEqual(core["id"], readback["post_id"], core)
                self.assertEqual(core["title"]["rendered"], "真实 WP 会话接线", core)
                self.assertEqual(core["content"]["rendered"], readback["snapshot_rendered"], core)
                self.assertEqual(readback["resource_status"], 200, readback)
                resource = base64.b64decode(readback["resource_bytes"], validate=True)
                self.assertEqual(resource, image)
                self.assertEqual(readback["resource_type"], "image/png")

                status, _headers, body = bridge_request("GET", f"/v1/status/{operation_id}")
                self.assertEqual(status, 200)
                serialized = json.dumps(json.loads(body), ensure_ascii=False)
                self.assertNotIn(authorization, serialized)
                self.assertNotIn(publisher_token, serialized)
                self.assertNotIn(control_token, serialized)
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/packages"), 0), 2)
                self.assertEqual(call_counts.get(("POST", "/wp-json/publication-v1/v1/operations"), 0), 2)
                self.assertEqual(operation_post_ids.count(operation_id), 1)
                self.assertEqual(operation_post_ids.count(safe_operation_id), 1)
                self.assertEqual(len(operation_post_ids), 2)

                print("SESSION_WORDPRESS_EVIDENCE=" + json.dumps({
                    "node_session_client_frozen_readback": node_session_client,
                    "run_id": run_id,
                    "worker_pid": worker.pid,
                    "private_upload_http_statuses": [row[0] for row in remote_responses["uploads"]],
                    "private_upload_owner_exact": identity["package_owner_exact"],
                    "unknown_operation_id": unknown_operation_id,
                    "unknown_response_same_id_no_duplicate": operation_post_ids.count(unknown_operation_id) == 1,
                    "committed_operation_id": operation_id,
                    "safe_frozen_operation_id": safe_operation_id,
                    "safe_frozen_preview_readback": True,
                    "png_frozen_readback_kses_real_content": True,
                    "unsupported_filter_output_fail_closed": proof["unsupported_filter_output_rejected"],
                    "prepare_pending_digest": digest,
                    "unapproved_commit_http_status": probe["status"],
                    "reviewer_approval": "SIMULATED",
                    "explicit_bridge_commit": committed["state"],
                    "database_core_resource_readback": True,
                    "bridge_requests": {f"{method} {path}": count for (method, path), count in sorted(call_counts.items())},
                }, ensure_ascii=False, sort_keys=True))
            finally:
                if safe_bridge is not None:
                    safe_bridge.close()
                    if safe_bridge_port is not None:
                        assert_port_closed(safe_bridge_port)
                if bridge is not None:
                    bridge.close()
                    if bridge_port is not None:
                        assert_port_closed(bridge_port)
                worker.terminate()
                worker.wait(timeout=30)
                self.assertIsNotNone(worker.returncode)
                if wp_port is not None:
                    assert_port_closed(wp_port)
                stdout_tail = worker.stdout.read() if worker.stdout else ""
                stderr_tail = worker.stderr.read() if worker.stderr else ""
                self.assertNotIn(publisher_token if "publisher_token" in locals() else "__never__", stdout_tail + stderr_tail)
                self.assertNotIn(control_token if "control_token" in locals() else "__never__", stdout_tail + stderr_tail)
                if worker.stdout:
                    worker.stdout.close()
                if worker.stderr:
                    worker.stderr.close()
                self.assertEqual(worker.returncode, 0, "persistent worker did not shut down cleanly")


if __name__ == "__main__":
    unittest.main(verbosity=2)
