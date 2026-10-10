"""Injected-callable transport for the publication-v1 WordPress REST routes."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import time
from typing import Callable


HEX32 = re.compile(r"^[a-f0-9]{32}$")
HEX64 = re.compile(r"^[a-f0-9]{64}$")
PACKAGE_ROUTE = "/wp-json/publication-v1/v1/packages"
OPERATIONS_ROUTE = "/wp-json/publication-v1/v1/operations"
COMMIT_ROUTE = "/wp-json/publication-v1/v1/commit"
MAX_MANIFEST_BYTES = 65_536
MAX_PACKAGE_BYTES = 16_000_000
MAX_UPLOAD_BODY_BYTES = 25_165_824
MAX_FROZEN_SNAPSHOT_BYTES = 1_048_576
MAX_FROZEN_RESPONSE_BYTES = 4_194_304
MAX_FILES = 128
FROZEN_SNAPSHOT_FIELDS = {
    "schema", "operation_key", "selected", "source_sha256", "labels_sha256", "title",
    "publisher_id", "site_origin", "visibility", "target_id", "baseline_sha256",
    "manifest_sha256", "compiler", "compiler_sha256", "inventory", "content", "rendered",
    "policy", "policy_sha256", "expires_at",
}
MIME_BY_SUFFIX = {
    ".html": "text/html",
    ".css": "text/css",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


class WordPressTransport:
    """Map session operations to actual WP routes using a caller-owned request.

    ``request(method, path, headers, body)`` must return ``(status, body_bytes)``.
    Authentication, credentials, TLS policy, and network ownership remain with
    the caller; this class stores none of them and never implements approval.
    """

    def __init__(
        self,
        *,
        request: Callable[[str, str, dict, bytes | None], tuple[int, bytes]],
        clock: Callable[[], float] = time.time,
        operation_ttl_seconds: int = 300,
    ):
        if not callable(request):
            raise ValueError("request_callable_required")
        if not callable(clock):
            raise ValueError("clock_callable_required")
        if (not isinstance(operation_ttl_seconds, int) or isinstance(operation_ttl_seconds, bool)
                or not 1 <= operation_ttl_seconds <= 3600):
            raise ValueError("invalid_operation_ttl")
        self._request_callable = request
        self._clock = clock
        self._operation_ttl_seconds = operation_ttl_seconds
        self._operation_packages: dict[str, dict] = {}

    @staticmethod
    def _json_bytes(value: dict) -> bytes:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def _exchange(self, method: str, path: str, body: bytes | None = None) -> tuple[int, bytes]:
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        response = self._request_callable(method, path, headers, body)
        if (not isinstance(response, tuple) or len(response) != 2
                or not isinstance(response[0], int) or isinstance(response[0], bool)
                or not isinstance(response[1], bytes)):
            raise ValueError("request_callable_contract_mismatch")
        return response

    @staticmethod
    def _decode_json(status: int, body: bytes) -> dict:
        try:
            value = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("wordpress_response_invalid_json") from error
        if not isinstance(value, dict):
            raise ValueError("wordpress_response_invalid_object")
        return value

    @staticmethod
    def _require_identity(value: dict, operation_id: str) -> None:
        if value.get("id") != operation_id:
            raise ValueError("wordpress_operation_identity_mismatch")

    @staticmethod
    def _mime(path: str) -> str | None:
        return MIME_BY_SUFFIX.get(PurePosixPath(path).suffix.lower())

    @staticmethod
    def _compiler_sha256(manifest: dict) -> str:
        compiler = manifest.get("compiler")
        encoded = json.dumps(compiler, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _read_package(package_path: str | Path, package_id: str, manifest_sha256: str) -> tuple[bytes, dict, dict[str, str]]:
        if not isinstance(package_id, str) or not HEX64.fullmatch(package_id):
            raise ValueError("package_identity_invalid")
        if not isinstance(manifest_sha256, str) or not HEX64.fullmatch(manifest_sha256) or package_id != manifest_sha256:
            raise ValueError("manifest_identity_invalid")
        root = Path(package_path)
        if root.is_symlink() or not root.is_dir():
            raise ValueError("package_directory_invalid")
        manifest_path = root / "manifest.json"
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise ValueError("package_manifest_missing")
        raw = manifest_path.read_bytes()
        if len(raw) > MAX_MANIFEST_BYTES or hashlib.sha256(raw).hexdigest() != package_id:
            raise ValueError("package_manifest_identity_mismatch")
        try:
            manifest = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("package_manifest_invalid") from error
        inventory = manifest.get("inventory") if isinstance(manifest, dict) else None
        if not isinstance(inventory, dict) or not 1 <= len(inventory) <= MAX_FILES:
            raise ValueError("package_inventory_invalid")
        files: dict[str, str] = {}
        total = 0
        bundle = root / "bundle"
        if bundle.is_symlink() or not bundle.is_dir():
            raise ValueError("package_bundle_invalid")
        for relative, record in inventory.items():
            if (not isinstance(relative, str) or not isinstance(record, dict)
                    or set(record) != {"bytes", "sha256"}
                    or not isinstance(record.get("bytes"), int) or isinstance(record.get("bytes"), bool)
                    or record["bytes"] < 1 or not isinstance(record.get("sha256"), str)
                    or not HEX64.fullmatch(record["sha256"])):
                raise ValueError("package_inventory_invalid")
            rel = PurePosixPath(relative)
            if (rel.is_absolute() or not rel.parts or "\\" in relative
                    or any(part in ("", ".", "..") for part in rel.parts)
                    or WordPressTransport._mime(relative) is None):
                raise ValueError("package_path_invalid")
            path = bundle.joinpath(*rel.parts)
            probe = bundle
            for part in rel.parts:
                probe = probe / part
                if probe.is_symlink():
                    raise ValueError("package_resource_link_rejected")
            if not path.is_file():
                raise ValueError("package_resource_missing")
            content = path.read_bytes()
            total += len(content)
            if (total > MAX_PACKAGE_BYTES or record["bytes"] != len(content)
                    or hashlib.sha256(content).hexdigest() != record["sha256"]):
                raise ValueError("package_resource_binding_mismatch")
            files[relative] = base64.b64encode(content).decode("ascii")
        return raw, manifest, files

    def upload(self, operation_id: str, package_path: str | Path, package_id: str) -> dict:
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        raw, manifest, files = self._read_package(package_path, package_id, package_id)
        existing = self._operation_packages.get(operation_id)
        if existing is not None and existing["manifest_sha256"] != package_id:
            raise ValueError("operation_package_conflict")
        request_body = self._json_bytes({"manifest": raw.decode("utf-8"), "files": files})
        if len(request_body) > MAX_UPLOAD_BODY_BYTES:
            raise ValueError("package_request_too_large")
        status, response_body = self._exchange("POST", PACKAGE_ROUTE, request_body)
        if status not in (200, 201):
            raise ValueError(f"wordpress_upload_rejected_{status}")
        uploaded = self._decode_json(status, response_body)
        if (uploaded.get("package_id") != package_id
                or uploaded.get("manifest_sha256") != package_id
                or uploaded.get("selected") != manifest.get("selected")
                or uploaded.get("title") != manifest.get("title")):
            raise ValueError("wordpress_upload_identity_mismatch")

        # Read back the exact owner-scoped manifest/inventory before prepare.
        query_status, query_body = self._exchange("GET", f"{PACKAGE_ROUTE}/{package_id}")
        if query_status != 200:
            raise ValueError(f"wordpress_package_query_rejected_{query_status}")
        query = self._decode_json(query_status, query_body)
        expected_inventory = {
            name: {"bytes": record["bytes"], "sha256": record["sha256"], "mime": self._mime(name)}
            for name, record in manifest["inventory"].items()
        }
        compiler_sha256 = self._compiler_sha256(manifest)
        if (query.get("package_id") != package_id or query.get("manifest_sha256") != package_id
                or query.get("selected") != manifest.get("selected")
                or query.get("title") != manifest.get("title")
                or query.get("schema") != manifest.get("schema")
                or query.get("source_sha256") != manifest.get("source_sha256")
                or query.get("labels_sha256") != manifest.get("labels_sha256")
                or query.get("compiler_sha256") != compiler_sha256
                or not isinstance(query.get("server_policy_sha256"), str)
                or not HEX64.fullmatch(query["server_policy_sha256"])
                or query.get("inventory") != expected_inventory):
            raise ValueError("wordpress_package_readback_mismatch")
        publisher_id = query.get("publisher_id")
        site_id = query.get("site_id")
        site_origin = query.get("site_origin")
        if (not isinstance(publisher_id, int) or isinstance(publisher_id, bool) or publisher_id < 1
                or not isinstance(site_id, int) or isinstance(site_id, bool) or site_id < 1
                or not isinstance(site_origin, str) or not site_origin or len(site_origin) > 256):
            raise ValueError("wordpress_package_owner_readback_invalid")
        self._operation_packages[operation_id] = {
            "manifest_sha256": package_id,
            "title": manifest["title"],
            "publisher_id": publisher_id,
            "site_id": site_id,
            "site_origin": site_origin,
            "compiler_sha256": compiler_sha256,
            "server_policy_sha256": query["server_policy_sha256"],
            "selected": manifest["selected"],
            "source_sha256": manifest["source_sha256"],
            "labels_sha256": manifest["labels_sha256"],
        }
        return {
            "operation_id": operation_id,
            "state": "uploaded",
            "publisher_id": publisher_id,
            "site_id": site_id,
            "site_origin": site_origin,
            "server_policy_sha256": query["server_policy_sha256"],
        }

    def prepare(self, operation_id: str, binding: dict) -> dict:
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        if not isinstance(binding, dict):
            raise ValueError("operation_binding_invalid")
        package = self._operation_packages.get(operation_id)
        if (package is None
                or binding.get("manifest_sha256") != package["manifest_sha256"]
                or hashlib.sha256(package["title"].encode("utf-8")).hexdigest() != binding.get("title_sha256")
                or binding.get("publisher_id") != package["publisher_id"]
                or binding.get("site_id") != package["site_id"]
                or binding.get("site_origin") != package["site_origin"]
                or binding.get("selected_path") != package["selected"]
                or binding.get("source_sha256") != package["source_sha256"]
                or binding.get("labels_sha256") != package["labels_sha256"]
                or binding.get("compiler_sha256") != package["compiler_sha256"]
                or binding.get("server_policy_sha256") != package["server_policy_sha256"]):
            raise ValueError("operation_title_binding_mismatch")
        expires_at = int(self._clock()) + self._operation_ttl_seconds
        if expires_at <= int(self._clock()) or expires_at > int(self._clock()) + 3600:
            raise ValueError("operation_expiry_invalid")
        payload = {
            "id": operation_id,
            "title": package["title"],
            "expires_at": expires_at,
            "manifest_sha256": package["manifest_sha256"],
        }
        status, body = self._exchange("POST", OPERATIONS_ROUTE, self._json_bytes(payload))
        if status not in (200, 201):
            raise ValueError(f"wordpress_prepare_rejected_{status}")
        prepared = self._decode_json(status, body)
        self._require_identity(prepared, operation_id)
        digest = prepared.get("digest")
        if prepared.get("state") != "pending" or not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise ValueError("wordpress_prepare_contract_mismatch")
        return {"operation_id": operation_id, "state": "pending", "digest": digest}

    def lookup(self, operation_id: str) -> dict:
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        status, body = self._exchange("GET", f"{OPERATIONS_ROUTE}/{operation_id}")
        if status == 404:
            return {"operation_id": operation_id, "state": "not_found", "digest": None}
        if status != 200:
            raise ValueError(f"wordpress_lookup_rejected_{status}")
        if len(body) > 16_384:
            raise ValueError("wordpress_lookup_response_too_large")
        value = self._decode_json(status, body)
        self._require_identity(value, operation_id)
        state = value.get("state")
        digest = value.get("digest")
        if state not in {"pending", "approved", "committed"}:
            raise ValueError("wordpress_lookup_contract_mismatch")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise ValueError("wordpress_lookup_digest_invalid")
        binding = value.get("binding")
        required = {
            "publisher_id", "site_id", "site_origin", "manifest_sha256", "selected_sha256",
            "source_sha256", "labels_sha256", "title_sha256", "compiler_sha256",
            "server_policy_sha256", "expires_at",
        }
        if not isinstance(binding, dict) or set(binding) != required:
            raise ValueError("wordpress_lookup_binding_invalid")
        for field in (
            "manifest_sha256", "selected_sha256", "source_sha256", "labels_sha256",
            "title_sha256", "compiler_sha256", "server_policy_sha256",
        ):
            if not isinstance(binding.get(field), str) or not HEX64.fullmatch(binding[field]):
                raise ValueError("wordpress_lookup_binding_invalid")
        for field in ("publisher_id", "site_id", "expires_at"):
            if (not isinstance(binding.get(field), int) or isinstance(binding[field], bool)
                    or binding[field] < 1):
                raise ValueError("wordpress_lookup_binding_invalid")
        if (not isinstance(binding.get("site_origin"), str) or not binding["site_origin"]
                or len(binding["site_origin"]) > 256):
            raise ValueError("wordpress_lookup_binding_invalid")
        return {
            "operation_id": operation_id,
            "state": state,
            "digest": digest,
            "binding": dict(binding),
        }

    @staticmethod
    def _frozen_snapshot_shape(snapshot: dict) -> None:
        if not isinstance(snapshot, dict) or set(snapshot) != FROZEN_SNAPSHOT_FIELDS:
            raise ValueError("wordpress_snapshot_shape_invalid")
        if snapshot.get("schema") != "publication-v1":
            raise ValueError("wordpress_snapshot_shape_invalid")
        for field in ("operation_key",):
            if not isinstance(snapshot.get(field), str) or not HEX32.fullmatch(snapshot[field]):
                raise ValueError("wordpress_snapshot_shape_invalid")
        for field in ("source_sha256", "labels_sha256", "baseline_sha256", "manifest_sha256", "compiler_sha256", "policy_sha256"):
            if not isinstance(snapshot.get(field), str) or not HEX64.fullmatch(snapshot[field]):
                raise ValueError("wordpress_snapshot_shape_invalid")
        for field, limit in (("selected", 4096), ("title", 800), ("site_origin", 256)):
            value = snapshot.get(field)
            if not isinstance(value, str) or not value or len(value.encode("utf-8")) > limit:
                raise ValueError("wordpress_snapshot_shape_invalid")
        for field in ("content", "rendered"):
            value = snapshot.get(field)
            if not isinstance(value, str) or len(value.encode("utf-8")) > MAX_FROZEN_SNAPSHOT_BYTES:
                raise ValueError("wordpress_snapshot_shape_invalid")
        for field in ("publisher_id", "expires_at"):
            value = snapshot.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise ValueError("wordpress_snapshot_shape_invalid")
        if (snapshot.get("visibility") != "public"
                or not isinstance(snapshot.get("target_id"), int)
                or isinstance(snapshot["target_id"], bool) or snapshot["target_id"] != 0):
            raise ValueError("wordpress_snapshot_shape_invalid")
        compiler = snapshot.get("compiler")
        policy = snapshot.get("policy")
        inventory = snapshot.get("inventory")
        if not isinstance(compiler, dict) or not compiler or not isinstance(policy, dict) or not policy:
            raise ValueError("wordpress_snapshot_shape_invalid")
        if not isinstance(inventory, dict) or not 1 <= len(inventory) <= MAX_FILES:
            raise ValueError("wordpress_snapshot_shape_invalid")

        def canonical(value):
            try:
                return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            except (TypeError, ValueError, UnicodeEncodeError) as error:
                raise ValueError("wordpress_snapshot_shape_invalid") from error

        if hashlib.sha256(canonical(compiler)).hexdigest() != snapshot["compiler_sha256"]:
            raise ValueError("wordpress_snapshot_compiler_binding_mismatch")
        for relative, record in inventory.items():
            if (not isinstance(relative, str) or not isinstance(record, dict)
                    or set(record) != {"bytes", "sha256", "mime"}
                    or not isinstance(record.get("bytes"), int) or isinstance(record["bytes"], bool)
                    or record["bytes"] < 0 or not isinstance(record.get("sha256"), str)
                    or not HEX64.fullmatch(record["sha256"]) or record.get("mime") != WordPressTransport._mime(relative)):
                raise ValueError("wordpress_snapshot_inventory_invalid")
            path = PurePosixPath(relative)
            if path.is_absolute() or not path.parts or "\\\\" in relative or any(part in ("", ".", "..") for part in path.parts):
                raise ValueError("wordpress_snapshot_inventory_invalid")

    def frozen_snapshot(self, operation_id: str) -> dict:
        """Read one bounded, canonical, owner-scoped server snapshot without writes."""
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        status, body = self._exchange("GET", f"{OPERATIONS_ROUTE}/{operation_id}/snapshot")
        if status != 200:
            raise ValueError(f"wordpress_snapshot_rejected_{status}")
        if len(body) > MAX_FROZEN_RESPONSE_BYTES:
            raise ValueError("wordpress_snapshot_response_too_large")

        def pairs(items):
            value = {}
            for key, item in items:
                if key in value:
                    raise ValueError("wordpress_snapshot_duplicate_json_key")
                value[key] = item
            return value

        try:
            response = json.loads(body.decode("utf-8"), object_pairs_hook=pairs, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("invalid_json_constant")))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("wordpress_snapshot_invalid_json") from error
        if not isinstance(response, dict) or set(response) != {"id", "digest", "state", "snapshot_json"}:
            raise ValueError("wordpress_snapshot_contract_mismatch")
        if response.get("id") != operation_id:
            raise ValueError("wordpress_operation_identity_mismatch")
        digest = response.get("digest")
        state = response.get("state")
        snapshot_json = response.get("snapshot_json")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise ValueError("wordpress_snapshot_digest_invalid")
        if state not in {"pending", "approved"}:
            raise ValueError("wordpress_snapshot_state_invalid")
        if not isinstance(snapshot_json, str):
            raise ValueError("wordpress_snapshot_json_invalid")
        try:
            raw = snapshot_json.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("wordpress_snapshot_json_invalid") from error
        if not raw or len(raw) > MAX_FROZEN_SNAPSHOT_BYTES:
            raise ValueError("wordpress_snapshot_size_limit")
        try:
            snapshot = json.loads(snapshot_json, object_pairs_hook=pairs, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("invalid_json_constant")))
        except (json.JSONDecodeError, UnicodeEncodeError) as error:
            raise ValueError("wordpress_snapshot_json_invalid") from error
        if not isinstance(snapshot, dict):
            raise ValueError("wordpress_snapshot_json_invalid")
        try:
            canonical = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, UnicodeEncodeError) as error:
            raise ValueError("wordpress_snapshot_json_invalid") from error
        if canonical != raw:
            raise ValueError("wordpress_snapshot_json_not_canonical")
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("wordpress_snapshot_digest_mismatch")
        self._frozen_snapshot_shape(snapshot)
        if snapshot.get("operation_key") != operation_id:
            raise ValueError("wordpress_snapshot_identity_mismatch")
        return {"id": operation_id, "digest": digest, "state": state, "snapshot_json": snapshot_json}

    def commit(self, operation_id: str, digest: str) -> dict:
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise ValueError("commit_digest_invalid")
        status, body = self._exchange(
            "POST", COMMIT_ROUTE, self._json_bytes({"id": operation_id, "digest": digest})
        )
        if status != 200:
            raise ValueError(f"wordpress_commit_rejected_{status}")
        committed = self._decode_json(status, body)
        self._require_identity(committed, operation_id)
        if committed.get("state") != "committed" or committed.get("digest") != digest:
            raise ValueError("wordpress_commit_contract_mismatch")
        return {"operation_id": operation_id, "state": "committed", "digest": digest}
