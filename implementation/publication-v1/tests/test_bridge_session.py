"""Strict synthetic tests for the bounded publication-v1 session core."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))
from publication_session import BridgeDispatcher, BridgeSession


POLICY = "a" * 64
SITE = "https://example.test"
HOST = "127.0.0.1:43127"
ORIGIN = "app://obsidian.md"
DIGEST = "d" * 64


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


class FakeTransport:
    def __init__(self, receipts_dir: Path):
        self.receipts_dir = receipts_dir
        self.calls = []
        self.remote_state = "pending"
        self.remote_digest = DIGEST
        self.remote_binding = None
        self.on_upload = None
        self.on_commit = None
        self.fail_upload = False
        self.fail_prepare = False

    def upload(self, operation_id, package_path, manifest_sha256):
        self.calls.append(("upload", operation_id, manifest_sha256))
        if self.on_upload:
            self.on_upload(operation_id, package_path, manifest_sha256)
        if self.fail_upload:
            raise TimeoutError("synthetic lost upload response")
        return {
            "operation_id": operation_id,
            "state": "uploaded",
            "publisher_id": 7,
            "site_id": 1,
            "site_origin": SITE + "/",
            "server_policy_sha256": "b" * 64,
        }

    def prepare(self, operation_id, binding):
        self.calls.append(("prepare", operation_id, binding["manifest_sha256"]))
        self.remote_binding = {
            "publisher_id": 7,
            "site_id": 1,
            "site_origin": SITE + "/",
            "manifest_sha256": binding["manifest_sha256"],
            "selected_sha256": hashlib.sha256(binding["selected_path"].encode("utf-8")).hexdigest(),
            "source_sha256": binding["source_sha256"],
            "labels_sha256": binding["labels_sha256"],
            "title_sha256": binding["title_sha256"],
            "compiler_sha256": binding.get("compiler_sha256", "c" * 64),
            "server_policy_sha256": binding.get("server_policy_sha256", "b" * 64),
            "expires_at": int(time.time()) + 300,
        }
        if self.fail_prepare:
            raise TimeoutError("synthetic lost prepare response")
        return {"operation_id": operation_id, "state": "pending", "digest": DIGEST}

    def lookup(self, operation_id):
        self.calls.append(("lookup", operation_id))
        return {
            "operation_id": operation_id,
            "state": self.remote_state,
            "digest": self.remote_digest,
            "binding": self.remote_binding,
        }

    def commit(self, operation_id, digest):
        self.calls.append(("commit", operation_id, digest))
        self.remote_state = "committed"
        if self.on_commit:
            self.on_commit()
        return {"operation_id": operation_id, "state": "committed", "digest": digest}


class BridgeSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            prefix="publication-session-", dir=os.environ.get("TMPDIR")
        )
        self.root = Path(self.temp.name)
        self.vault = self.root / "synthetic-vault"
        self.note = self.vault / "notes" / "selected.md"
        self.note.parent.mkdir(parents=True)
        self.source = b"# Synthetic\n\n![pixel](pixel.png)\n"
        self.note.write_bytes(self.source)
        self.image = png_fixture()
        (self.note.parent / "pixel.png").write_bytes(self.image)
        self.labels = self.note.with_suffix(".labels.json")
        self.labels.write_bytes(b"{}")
        self.approved_assets = {
            "pixel.png": {
                "sha256": hashlib.sha256(self.image).hexdigest(),
                "mime": "image/png",
            }
        }
        self.receipts = self.root / "receipts"
        self.store = self.root / "packages"
        self.transport = FakeTransport(self.receipts)
        self.session = self.make_session()

    def tearDown(self):
        self.temp.cleanup()

    def make_session(self, transport=None):
        return BridgeSession(
            vault=self.vault,
            selected="notes/selected.md",
            store=self.store,
            receipts_dir=self.receipts,
            transport=self.transport if transport is None else transport,
            site_pin=SITE,
            policy_sha256=POLICY,
        )

    def test_local_live_render_uses_real_package_without_remote_mutation(self):
        result = self.session.live_render("Synthetic title", self.approved_assets)
        self.assertRegex(result["package_id"], r"^[0-9a-f]{64}$")
        self.assertIn("<h1>Synthetic</h1>", result["html"])
        self.assertIn("assets/images/", result["html"])
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(list(self.receipts.glob("*.json")) if self.receipts.exists() else [], [])

    def test_authenticated_asset_candidate_admits_only_hash_bound_live_png_resource(self):
        dispatcher = BridgeDispatcher(self.session, pinned_host=HOST)
        authorization = dispatcher.take_startup_authorization()
        headers = {
            "Origin": ORIGIN, "Host": HOST, "Authorization": authorization,
            "Content-Type": "application/json",
        }
        body = json.dumps({"path": "pixel.png"}, separators=(",", ":")).encode()

        status, _response_headers, _response = dispatcher.dispatch(
            "POST", "/v1/asset-candidate", {key: value for key, value in headers.items() if key != "Authorization"}, body
        )
        self.assertEqual(status, 401)
        status, _response_headers, response = dispatcher.dispatch(
            "POST", "/v1/asset-candidate", headers, body
        )
        self.assertEqual(status, 200)
        candidate = json.loads(response)
        self.assertEqual(candidate, {
            "path": "pixel.png", "sha256": hashlib.sha256(self.image).hexdigest(),
            "mime": "image/png", "bytes": len(self.image),
        })

        live_body = json.dumps({
            "path": "notes/selected.md", "text": self.source.decode("utf-8"),
            "source_sha256": hashlib.sha256(self.source).hexdigest(), "title": "Independent title",
            "approved_assets": {"pixel.png": {"sha256": candidate["sha256"], "mime": candidate["mime"]}},
            "approved_labels": {},
        }, separators=(",", ":")).encode()
        status, _response_headers, response = dispatcher.dispatch("POST", "/v1/live", headers, live_body)
        self.assertEqual(status, 200)
        rendered = json.loads(response)
        self.assertIn("<title>Independent title</title>", rendered["html"])
        self.assertIn("<h1>Synthetic</h1>", rendered["html"])
        asset_path = f"/v1/assets/{rendered['package_id']}"
        status, _response_headers, _response = dispatcher.dispatch(
            "GET", asset_path, {"Origin": ORIGIN, "Host": HOST}
        )
        self.assertEqual(status, 401)
        status, _response_headers, response = dispatcher.dispatch("GET", asset_path, headers)
        self.assertEqual(status, 200)
        resources = json.loads(response)["assets"]
        image_record = resources[f"assets/images/{candidate['sha256']}.png"]
        self.assertEqual(image_record["content_type"], "image/png")
        self.assertEqual(base64.b64decode(image_record["data"]), self.image)

        (self.note.parent / "pixel.png").write_bytes(png_fixture() + b"changed")
        status, _response_headers, response = dispatcher.dispatch("POST", "/v1/live", headers, live_body)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(response)["code"], "asset_approval_hash_mismatch")
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(list(self.receipts.glob("*.json")) if self.receipts.exists() else [], [])

    def test_receipt_is_durable_before_upload_and_binds_manifest_and_inputs(self):
        seen = []

        def inspect_before_write(operation_id, package_path, manifest_sha256):
            receipt_path = self.receipts / f"{operation_id}.json"
            self.assertTrue(receipt_path.is_file(), "operation ID receipt must precede remote write")
            receipt = json.loads(receipt_path.read_bytes())
            seen.append(receipt)
            self.assertEqual(receipt["operation_id"], operation_id)
            self.assertEqual(receipt["state"], "uploading")
            self.assertEqual(receipt["manifest_sha256"], manifest_sha256)
            self.assertTrue((Path(package_path) / "manifest.json").is_file())

        self.transport.on_upload = inspect_before_write
        receipt = self.session.prepare("Synthetic title", self.approved_assets)
        self.assertEqual(len(seen), 1)
        self.assertEqual(receipt["state"], "pending")
        self.assertEqual(receipt["site_pin"], SITE)
        self.assertEqual(receipt["policy_sha256"], POLICY)
        self.assertEqual(receipt["source_sha256"], hashlib.sha256(self.source).hexdigest())
        self.assertEqual(receipt["labels_sha256"], hashlib.sha256(b"{}").hexdigest())
        self.assertEqual(receipt["image_sha256"]["pixel.png"], self.approved_assets["pixel.png"]["sha256"])
        serialized = (self.receipts / f"{receipt['operation_id']}.json").read_text(encoding="utf-8")
        self.assertNotIn("Synthetic title", serialized)
        self.assertNotIn("<h1>", serialized)
        self.assertNotIn("authorization", serialized.lower())
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare"])

    def test_unknown_upload_outcome_is_looked_up_by_same_id_without_retry(self):
        self.transport.fail_upload = True
        with self.assertRaisesRegex(ValueError, "server_outcome_unknown"):
            self.session.prepare("Synthetic title", self.approved_assets)
        receipt = next(json.loads(path.read_bytes()) for path in self.receipts.glob("*.json"))
        operation_id = receipt["operation_id"]
        self.assertEqual(receipt["state"], "unknown")
        self.assertEqual([call[0] for call in self.transport.calls], ["upload"])

        self.transport.fail_upload = False
        status = self.session.status(operation_id)
        self.assertEqual(status["remote"]["operation_id"], operation_id)
        self.assertEqual([call[1] for call in self.transport.calls], [operation_id, operation_id])
        with self.assertRaisesRegex(ValueError, "operation_outcome_unresolved"):
            self.session.prepare("Synthetic title", self.approved_assets)
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "lookup"])

    def test_lost_prepare_reconciles_same_operation_after_exact_readback(self):
        self.transport.fail_prepare = True
        with self.assertRaisesRegex(ValueError, "server_outcome_unknown"):
            self.session.prepare("Synthetic title", self.approved_assets)
        initial = next(json.loads(path.read_bytes()) for path in self.receipts.glob("*.json"))
        operation_id = initial["operation_id"]
        self.assertEqual(initial["state"], "unknown")
        self.assertEqual(initial["phase"], "prepare")

        status = self.session.status(operation_id)
        self.assertEqual(status["receipt"]["operation_id"], operation_id)
        self.assertEqual(status["receipt"]["state"], "pending")
        self.assertEqual(status["remote"]["operation_id"], operation_id)
        self.assertEqual(status["remote"]["state"], "pending")
        self.assertEqual(status["remote"]["digest"], DIGEST)
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare", "lookup"])
        self.assertEqual({call[1] for call in self.transport.calls}, {operation_id})

    def test_unknown_prepare_readback_rejects_digest_only_and_mismatched_bindings(self):
        self.transport.fail_prepare = True
        with self.assertRaisesRegex(ValueError, "server_outcome_unknown"):
            self.session.prepare("Synthetic title", self.approved_assets)
        operation_id = next(json.loads(path.read_bytes())["operation_id"] for path in self.receipts.glob("*.json"))
        exact = dict(self.transport.remote_binding)
        mutations = {
            "publisher_id": 8,
            "site_id": 2,
            "site_origin": "https://other.example.test/",
            "manifest_sha256": "0" * 64,
            "selected_sha256": "1" * 64,
            "source_sha256": "2" * 64,
            "labels_sha256": "3" * 64,
            "title_sha256": "4" * 64,
            "compiler_sha256": "5" * 64,
            "server_policy_sha256": "6" * 64,
            "expires_at": int(time.time()) - 1,
        }
        cases = [("missing_binding", None)] + list(mutations.items())
        for name, value in cases:
            with self.subTest(binding=name):
                self.transport.remote_binding = None if name == "missing_binding" else {**exact, name: value}
                status = self.session.status(operation_id)
                persisted = json.loads((self.receipts / f"{operation_id}.json").read_bytes())
                self.assertEqual(persisted["state"], "unknown")
                self.assertIsNone(persisted["remote_digest"])
                self.assertEqual(status["remote"]["state"], "unknown")
                self.assertIsNone(status["remote"]["digest"])

        self.transport.remote_state = "not_found"
        self.transport.remote_digest = None
        self.transport.remote_binding = None
        status = self.session.status(operation_id)
        persisted = json.loads((self.receipts / f"{operation_id}.json").read_bytes())
        self.assertEqual(persisted["state"], "unknown")
        self.assertIsNone(persisted["remote_digest"])
        self.assertEqual(status["remote"]["state"], "not_found")
        self.assertEqual([call[0] for call in self.transport.calls if call[0] != "lookup"], ["upload", "prepare"])

    def test_unknown_prepare_readback_rechecks_current_local_inputs(self):
        self.transport.fail_prepare = True
        with self.assertRaisesRegex(ValueError, "server_outcome_unknown"):
            self.session.prepare("Synthetic title", self.approved_assets)
        operation_id = next(json.loads(path.read_bytes())["operation_id"] for path in self.receipts.glob("*.json"))
        self.note.write_bytes(self.source + b"drifted after lost response\n")

        status = self.session.status(operation_id)
        persisted = json.loads((self.receipts / f"{operation_id}.json").read_bytes())
        self.assertEqual(persisted["state"], "unknown")
        self.assertIsNone(persisted["remote_digest"])
        self.assertEqual(status["remote"]["state"], "unknown")
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare", "lookup"])

    def test_source_drift_after_upload_stops_pending_create(self):
        def mutate_after_upload(_operation_id, _package_path, _manifest_sha256):
            self.note.write_bytes(self.source + b"changed\n")

        self.transport.on_upload = mutate_after_upload
        with self.assertRaisesRegex(ValueError, "selected_inputs_changed_after_remote_write"):
            self.session.prepare("Synthetic title", self.approved_assets)
        self.assertEqual([call[0] for call in self.transport.calls], ["upload"])
        receipt = next(json.loads(path.read_bytes()) for path in self.receipts.glob("*.json"))
        self.assertEqual(receipt["state"], "stale_remote")

    def test_commit_requires_fresh_approved_digest_and_unchanged_approved_asset(self):
        receipt = self.session.prepare("Synthetic title", self.approved_assets)
        self.transport.remote_state = "approved"
        self.transport.remote_digest = DIGEST
        (self.note.parent / "pixel.png").write_bytes(self.image + b"changed")
        with self.assertRaisesRegex(ValueError, "selected_inputs_changed_before_commit"):
            self.session.commit(receipt["operation_id"], DIGEST)
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare", "lookup"])

    def test_commit_is_explicit_and_uses_fresh_remote_approval_without_approving(self):
        receipt = self.session.prepare("Synthetic title", self.approved_assets)
        self.transport.remote_state = "approved"
        result = self.session.commit(receipt["operation_id"], DIGEST)
        self.assertEqual(result["state"], "committed")
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare", "lookup", "commit"])
        self.assertFalse(any(call[0] == "approve" for call in self.transport.calls))

    def test_dispatch_requires_secret_origin_host_and_authenticates_get_assets(self):
        rendered = self.session.live_render("Synthetic title", self.approved_assets)
        dispatcher = BridgeDispatcher(self.session, pinned_host=HOST, max_body_bytes=4096)
        authorization = dispatcher.take_startup_authorization()
        asset_path = f"/v1/assets/{rendered['package_id']}/assets/katex.min.css"

        status, _headers, _body = dispatcher.dispatch(
            "GET", asset_path, {"Origin": ORIGIN, "Host": HOST}, b""
        )
        self.assertEqual(status, 401, "Origin is not authentication")
        status, _headers, _body = dispatcher.dispatch(
            "GET", asset_path,
            {"Origin": ORIGIN, "Host": "localhost:43127", "Authorization": authorization}, b"",
        )
        self.assertEqual(status, 403, "Host must be the pinned IPv4 loopback authority")
        status, headers, body = dispatcher.dispatch(
            "GET", asset_path,
            {"Origin": ORIGIN, "Host": HOST, "Authorization": authorization}, b"",
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/css; charset=utf-8")
        self.assertIn(b"katex", body.lower())

        oversized = b"{" + b" " * 4096 + b"}"
        status, _headers, _body = dispatcher.dispatch(
            "POST", "/v1/live",
            {"Origin": ORIGIN, "Host": HOST, "Authorization": authorization, "Content-Type": "application/json"},
            oversized,
        )
        self.assertEqual(status, 413)
        status, _headers, _body = dispatcher.dispatch(
            "GET", "/v1/status/" + "0" * 32,
            {"Origin": ORIGIN, "Host": HOST, "Authorization": authorization}, b"x",
        )
        self.assertEqual(status, 413)
        with self.assertRaises(RuntimeError):
            dispatcher.take_startup_authorization()

    def test_commit_rejects_receipt_when_site_or_policy_pin_changed(self):
        receipt = self.session.prepare("Synthetic title", self.approved_assets)
        self.transport.remote_state = "approved"
        for site_pin, policy_sha256 in (
            (SITE, "b" * 64),
            ("https://other.example.test", POLICY),
        ):
            with self.subTest(site_pin=site_pin, policy_sha256=policy_sha256):
                changed = BridgeSession(
                    vault=self.vault,
                    selected="notes/selected.md",
                    store=self.store,
                    receipts_dir=self.receipts,
                    transport=self.transport,
                    site_pin=site_pin,
                    policy_sha256=policy_sha256,
                )
                with self.assertRaisesRegex(ValueError, "session_pin_mismatch"):
                    changed.commit(receipt["operation_id"], DIGEST)
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare"])

    def test_post_commit_input_drift_is_reported_without_claiming_rollback(self):
        receipt = self.session.prepare("Synthetic title", self.approved_assets)
        self.transport.remote_state = "approved"
        self.transport.on_commit = lambda: self.note.write_bytes(self.source + b"changed after commit\\n")
        with self.assertRaisesRegex(ValueError, "inputs_changed_after_commit"):
            self.session.commit(receipt["operation_id"], DIGEST)
        persisted = json.loads((self.receipts / f"{receipt['operation_id']}.json").read_bytes())
        self.assertEqual(self.transport.remote_state, "committed")
        self.assertEqual(persisted["state"], "committed_input_drift")
        self.assertEqual([call[0] for call in self.transport.calls], ["upload", "prepare", "lookup", "commit"])

    def test_cancel_only_closes_local_session(self):
        result = self.session.cancel()
        self.assertEqual(result, {"state": "cancelled_local", "remote_cancelled": False})
        with self.assertRaisesRegex(ValueError, "session_cancelled"):
            self.session.live_render("Synthetic title", self.approved_assets)
        self.assertEqual(self.transport.calls, [])


if __name__ == "__main__":
    unittest.main()
