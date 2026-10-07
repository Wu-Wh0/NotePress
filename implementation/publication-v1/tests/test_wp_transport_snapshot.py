"""Strict validation tests for owner-bound WordPress snapshot read-back."""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))
from wp_transport import OPERATIONS_ROUTE, WordPressTransport  # noqa: E402


def canonical(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


class WordPressFrozenSnapshotTransportTests(unittest.TestCase):
    def setUp(self):
        self.operation_id = "a" * 32
        compiler = {"node": "v24.21.0"}
        policy = {"max_bytes": 1000}
        self.snapshot = {
            "schema": "publication-v1",
            "operation_key": self.operation_id,
            "selected": "notes/selected.md",
            "source_sha256": "1" * 64,
            "labels_sha256": "2" * 64,
            "title": "Frozen title",
            "publisher_id": 7,
            "site_origin": "https://example.test/",
            "visibility": "public",
            "target_id": 0,
            "baseline_sha256": "0" * 64,
            "manifest_sha256": "3" * 64,
            "compiler": compiler,
            "compiler_sha256": hashlib.sha256(canonical(compiler)).hexdigest(),
            "inventory": {
                "assets/katex.min.css": {"bytes": 0, "sha256": "4" * 64, "mime": "text/css"},
            },
            "content": "<p>Frozen bytes.</p>",
            "rendered": "<p>Frozen bytes.</p>",
            "policy": policy,
            "policy_sha256": hashlib.sha256(canonical(policy)).hexdigest(),
            "expires_at": int(time.time()) + 300,
        }
        self.snapshot_json = canonical(self.snapshot).decode("utf-8")
        self.digest = hashlib.sha256(self.snapshot_json.encode("utf-8")).hexdigest()
        self.reply = {
            "id": self.operation_id,
            "digest": self.digest,
            "state": "pending",
            "snapshot_json": self.snapshot_json,
        }
        self.response_body = json.dumps(self.reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.calls = []

        def request(method, path, headers, body):
            self.calls.append((method, path, headers, body))
            return 200, self.response_body

        self.transport = WordPressTransport(request=request)

    def test_reads_exact_canonical_snapshot_and_operation_route(self):
        self.assertEqual(self.transport.frozen_snapshot(self.operation_id), {
            "id": self.operation_id,
            "digest": self.digest,
            "state": "pending",
            "snapshot_json": self.snapshot_json,
        })
        self.assertEqual(self.calls[0][0:2], (
            "GET", f"{OPERATIONS_ROUTE}/{self.operation_id}/snapshot",
        ))

    def test_rejects_noncanonical_inner_json_even_when_hash_matches(self):
        noncanonical = self.snapshot_json + "\n"
        self.reply["snapshot_json"] = noncanonical
        self.reply["digest"] = hashlib.sha256(noncanonical.encode("utf-8")).hexdigest()
        self.response_body = json.dumps(self.reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self.assertRaisesRegex(ValueError, "wordpress_snapshot_json_not_canonical"):
            self.transport.frozen_snapshot(self.operation_id)

    def test_rejects_wrong_digest_and_wrong_snapshot_identity(self):
        self.reply["digest"] = "f" * 64
        self.response_body = json.dumps(self.reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self.assertRaisesRegex(ValueError, "wordpress_snapshot_digest_mismatch"):
            self.transport.frozen_snapshot(self.operation_id)

        changed = dict(self.snapshot)
        changed["operation_key"] = "b" * 32
        self.reply["snapshot_json"] = canonical(changed).decode("utf-8")
        self.reply["digest"] = hashlib.sha256(self.reply["snapshot_json"].encode("utf-8")).hexdigest()
        self.response_body = json.dumps(self.reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self.assertRaisesRegex(ValueError, "wordpress_snapshot_identity_mismatch"):
            self.transport.frozen_snapshot(self.operation_id)

    def test_rejects_duplicate_response_keys_and_extra_contract_fields(self):
        self.response_body = (
            b'{"id":"' + self.operation_id.encode("ascii") + b'","id":"' + self.operation_id.encode("ascii")
            + b'","digest":"' + self.digest.encode("ascii") + b'","state":"pending","snapshot_json":"{}"}'
        )
        with self.assertRaisesRegex(ValueError, "wordpress_snapshot_duplicate_json_key"):
            self.transport.frozen_snapshot(self.operation_id)

        self.reply["unexpected"] = True
        self.response_body = json.dumps(self.reply, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self.assertRaisesRegex(ValueError, "wordpress_snapshot_contract_mismatch"):
            self.transport.frozen_snapshot(self.operation_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
