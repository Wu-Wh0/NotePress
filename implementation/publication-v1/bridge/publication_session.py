"""Bounded, session-scoped publication-v1 bridge core.

This is a core/dispatcher contract, not a listener or deployable server. The
host supplies a private transport and the actual 127.0.0.1 HTTP adapter. Every
request must carry exact Origin, pinned Host, and a startup-random Authorization
header; there are no cookies, query-token, or iframe-URL workarounds. The
startup header is returned once for an out-of-band in-process handoff and is
never included in responses or receipts. The Obsidian parent should render live
HTML locally (for example via srcdoc with locally bound resources) or use an
explicitly authenticated resource fetch; iframe GET cannot attach this header.

Receipts persist only bounded noncredential bindings and operation state. The
producer's content-addressed package remains the sole rendered-body artifact.
No credentials, remote client, approval action, or network implementation is
provided here; a caller must inject upload/prepare/lookup/commit transport.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
PRODUCER_DIR = ROOT / "producer"
sys.path.insert(0, str(PRODUCER_DIR))
import package_builder as producer  # the existing publication-v1 producer
from reader import read_selected, read_selected_asset


HEX32 = re.compile(r"^[a-f0-9]{32}$")
HEX64 = re.compile(r"^[a-f0-9]{64}$")
MAX_BODY_BYTES = 64 * 1024
MAX_RECEIPTS = 32
MAX_RECEIPT_BYTES = 12 * 1024
MAX_APPROVED_ASSETS = 8
MAX_PACKAGE_BYTES = 48 * 1024 * 1024
ACTIVE_STATES = {"allocated", "uploading", "uploaded", "creating", "pending", "unknown", "stale_remote", "committing"}
TERMINAL_STATES = {"committed", "committed_input_drift"}
RECEIPT_SCHEMA = "publication-v1-bridge-receipt"


class BridgeSession:
    """One selected note, one pinned policy/site, bounded receipts, injected transport."""

    def __init__(self, *, vault, selected: str, store, receipts_dir, transport,
                 site_pin: str, policy_sha256: str, max_receipts: int = MAX_RECEIPTS):
        self.vault = Path(vault)
        self.selected = selected
        self.store = Path(store)
        self.receipts_dir = Path(receipts_dir)
        self.transport = transport
        self.site_pin = self._validate_site_pin(site_pin)
        if not isinstance(policy_sha256, str) or not HEX64.fullmatch(policy_sha256):
            raise ValueError("invalid_policy_pin")
        if not isinstance(max_receipts, int) or isinstance(max_receipts, bool) or not 1 <= max_receipts <= MAX_RECEIPTS:
            raise ValueError("invalid_receipt_limit")
        self.policy_sha256 = policy_sha256
        self.max_receipts = max_receipts
        self._cancelled = False
        self._live_packages = []
        self.receipts_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.receipts_dir.is_symlink() or not self.receipts_dir.is_dir():
            raise ValueError("unsafe_receipt_directory")
        try:
            self.receipts_dir.chmod(0o700)
        except OSError:
            pass

    @staticmethod
    def _validate_site_pin(value: str) -> str:
        if not isinstance(value, str) or len(value) > 256:
            raise ValueError("invalid_site_pin")
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError as error:
            raise ValueError("invalid_site_pin") from error
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError("invalid_site_pin")
        host = parsed.hostname.lower()
        if not re.fullmatch(r"[a-z0-9.-]+", host):
            raise ValueError("invalid_site_pin")
        return f"https://{host}" + (f":{port}" if port is not None else "")

    def _ensure_open(self) -> None:
        if self._cancelled:
            raise ValueError("session_cancelled")

    @staticmethod
    def _title(value: str) -> str:
        if (not isinstance(value, str) or not value.strip() or len(value) > 200
                or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise ValueError("invalid_title")
        return value

    @staticmethod
    def _approvals(value: dict) -> dict:
        if not isinstance(value, dict) or len(value) > MAX_APPROVED_ASSETS:
            raise ValueError("invalid_asset_approvals")
        approved = {}
        for relative, record in value.items():
            if (not isinstance(relative, str) or not isinstance(record, dict)
                    or set(record) != {"sha256", "mime"} or record.get("mime") != "image/png"
                    or not isinstance(record.get("sha256"), str)
                    or not HEX64.fullmatch(record["sha256"])):
                raise ValueError("invalid_asset_approval")
            approved[relative] = {"sha256": record["sha256"], "mime": "image/png"}
        return approved

    def _capture_binding(self, approved: dict) -> dict:
        source = read_selected(self.vault, self.selected)
        _labels, label_bytes = producer._load_labels(self.vault, self.selected)
        images = {}
        for relative, record in approved.items():
            raw = read_selected_asset(self.vault, self.selected, relative)
            digest = hashlib.sha256(raw).hexdigest()
            if digest != record["sha256"]:
                raise ValueError("asset_approval_hash_mismatch")
            images[relative] = digest
        return {
            "source_sha256": hashlib.sha256(source).hexdigest(),
            "labels_sha256": hashlib.sha256(label_bytes).hexdigest(),
            "image_sha256": dict(sorted(images.items())),
        }

    def _package(self, title: str, approved: dict) -> tuple[str, Path, dict]:
        title = self._title(title)
        approved = self._approvals(approved)
        binding = self._capture_binding(approved)
        package_id = producer.build(
            self.store, self.selected, self.vault, approved_assets=approved, title=title
        )
        package_path = self.store / package_id
        manifest = self._verify_package(package_id)
        if (manifest["selected"] != self.selected or manifest["title"] != title
                or manifest["source_sha256"] != binding["source_sha256"]
                or manifest["labels_sha256"] != binding["labels_sha256"]):
            raise ValueError("package_input_binding_mismatch")
        expected_inventory_images = {
            f"assets/images/{digest}.png" for digest in binding["image_sha256"].values()
        }
        actual_inventory_images = {
            path for path in manifest["inventory"] if path.startswith("assets/images/")
        }
        if actual_inventory_images != expected_inventory_images:
            raise ValueError("package_image_binding_mismatch")
        binding.update({
            "manifest_sha256": package_id,
            "title_sha256": hashlib.sha256(title.encode("utf-8")).hexdigest(),
            "compiler_sha256": hashlib.sha256(
                json.dumps(manifest["compiler"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
            "site_pin": self.site_pin,
            "policy_sha256": self.policy_sha256,
            "selected_path": self.selected,
        })
        return package_id, package_path, {"binding": binding, "manifest": manifest, "approved": approved}

    def _verify_package(self, package_id: str) -> dict:
        if not isinstance(package_id, str) or not HEX64.fullmatch(package_id):
            raise ValueError("package_identity_invalid")
        package = self.store / package_id
        manifest_path = package / "manifest.json"
        if package.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file():
            raise ValueError("package_manifest_missing")
        raw = manifest_path.read_bytes()
        if len(raw) > MAX_RECEIPT_BYTES * 2 or hashlib.sha256(raw).hexdigest() != package_id:
            raise ValueError("package_identity_mismatch")
        try:
            manifest = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("package_manifest_invalid") from error
        if (not isinstance(manifest, dict)
                or set(manifest) != {"schema", "selected", "source_sha256", "labels_sha256", "title", "compiler", "inventory"}
                or manifest.get("schema") != "publication-v1"
                or not isinstance(manifest.get("inventory"), dict)
                or "preview.html" not in manifest["inventory"]
                or "assets/katex.min.css" not in manifest["inventory"]):
            raise ValueError("package_manifest_invalid")
        bundle = package / "bundle"
        total = 0
        for relative, record in manifest["inventory"].items():
            if (not isinstance(relative, str) or not isinstance(record, dict)
                    or set(record) != {"bytes", "sha256"} or isinstance(record.get("bytes"), bool)
                    or not isinstance(record.get("bytes"), int) or record["bytes"] < 0
                    or not isinstance(record.get("sha256"), str) or not HEX64.fullmatch(record["sha256"])):
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
            total += len(content)
            if total > MAX_PACKAGE_BYTES:
                raise ValueError("package_size_limit")
            if record["bytes"] != len(content) or hashlib.sha256(content).hexdigest() != record["sha256"]:
                raise ValueError("package_resource_binding_mismatch")
        return manifest

    def _check_receipt_pins(self, receipt: dict) -> None:
        if (receipt.get("site_pin") != self.site_pin
                or receipt.get("policy_sha256") != self.policy_sha256
                or receipt.get("selected_path") != self.selected):
            raise ValueError("session_pin_mismatch")

    def _recheck(self, receipt: dict, package_id: str) -> None:
        self._check_receipt_pins(receipt)
        approved = {
            path: {"sha256": digest, "mime": "image/png"}
            for path, digest in receipt["image_sha256"].items()
        }
        current = self._capture_binding(approved)
        if (current["source_sha256"] != receipt["source_sha256"]
                or current["labels_sha256"] != receipt["labels_sha256"]
                or current["image_sha256"] != receipt["image_sha256"]):
            raise ValueError("selected_inputs_changed")
        manifest = self._verify_package(package_id)
        compiler_sha256 = hashlib.sha256(
            json.dumps(manifest["compiler"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if (manifest["selected"] != receipt["selected_path"]
                or manifest["source_sha256"] != receipt["source_sha256"]
                or manifest["labels_sha256"] != receipt["labels_sha256"]
                or hashlib.sha256(manifest["title"].encode("utf-8")).hexdigest() != receipt["title_sha256"]
                or compiler_sha256 != receipt["compiler_sha256"]
                or hashlib.sha256((self.store / package_id / "manifest.json").read_bytes()).hexdigest() != receipt["manifest_sha256"]):
            raise ValueError("package_input_binding_mismatch")

    def _receipt_files(self) -> list[Path]:
        files = sorted(self.receipts_dir.glob("*.json"))
        if len(files) > self.max_receipts:
            raise ValueError("receipt_limit_reached")
        for path in files:
            if path.is_symlink() or not path.is_file() or not HEX32.fullmatch(path.stem):
                raise ValueError("receipt_store_invalid")
        return files

    def _read_receipt(self, operation_id: str) -> dict:
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        path = self.receipts_dir / f"{operation_id}.json"
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECEIPT_BYTES:
            raise ValueError("receipt_not_found")
        try:
            receipt = json.loads(path.read_bytes())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("receipt_invalid") from error
        if (not isinstance(receipt, dict) or receipt.get("schema") != RECEIPT_SCHEMA
                or receipt.get("operation_id") != operation_id):
            raise ValueError("receipt_invalid")
        return receipt

    def _save_receipt(self, receipt: dict) -> None:
        operation_id = receipt.get("operation_id")
        if not isinstance(operation_id, str) or not HEX32.fullmatch(operation_id):
            raise ValueError("operation_id_invalid")
        encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_RECEIPT_BYTES:
            raise ValueError("receipt_size_limit")
        target = self.receipts_dir / f"{operation_id}.json"
        if target.is_symlink():
            raise ValueError("receipt_store_invalid")
        fd, temporary = tempfile.mkstemp(prefix=".receipt-", suffix=".tmp", dir=self.receipts_dir)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            try:
                directory_fd = os.open(self.receipts_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _assert_no_active_operation(self) -> None:
        for path in self._receipt_files():
            receipt = self._read_receipt(path.stem)
            if receipt.get("state") in ACTIVE_STATES:
                raise ValueError("operation_outcome_unresolved")

    def asset_candidate(self, relative: str) -> dict:
        """Inspect exactly one note-relative PNG without granting approval."""
        self._ensure_open()
        raw = read_selected_asset(self.vault, self.selected, relative)
        producer._validate_png(raw)
        return {
            "path": relative,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "mime": "image/png",
            "bytes": len(raw),
        }

    def live_render(self, title: str, approved_assets: dict) -> dict:
        self._ensure_open()
        package_id, package_path, result = self._package(title, approved_assets)
        self._recheck({**result["binding"], "image_sha256": result["binding"]["image_sha256"]}, package_id)
        html = (package_path / "bundle" / "preview.html").read_text(encoding="utf-8")
        return {
            "package_id": package_id,
            "manifest_sha256": package_id,
            "source_sha256": result["binding"]["source_sha256"],
            "html": html,
            "asset_paths": sorted(result["manifest"]["inventory"]),
        }

    def live_render_unsaved(self, path: str, text: str, source_sha256: str,
                            title: str, approved_assets: dict, approved_labels: dict) -> dict:
        """Render bounded editor text in a private synthetic workspace; never freeze it."""
        self._ensure_open()
        if not isinstance(path, str) or path != self.selected:
            raise ValueError("selected_path_mismatch")
        if not isinstance(self.selected, str) or any(char in self.selected for char in (chr(92), ":", chr(0))):
            raise ValueError("invalid_selected_path")
        raw_parts = self.selected.split("/")
        if any(part in ("", ".", "..") or part.startswith(".") for part in raw_parts):
            raise ValueError("invalid_selected_path")
        selected_parts = PurePosixPath(self.selected)
        if selected_parts.is_absolute() or not self.selected.endswith(".md") or not selected_parts.parts:
            raise ValueError("invalid_selected_path")
        if not isinstance(text, str):
            raise ValueError("invalid_source_text")
        try:
            source_bytes = text.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("invalid_source_text") from error
        if len(source_bytes) > 10000:
            raise ValueError("source_too_large")
        if (not isinstance(source_sha256, str) or not HEX64.fullmatch(source_sha256)
                or hashlib.sha256(source_bytes).hexdigest() != source_sha256):
            raise ValueError("source_hash_mismatch")
        title = self._title(title)
        approved = self._approvals(approved_assets)
        if not isinstance(approved_labels, dict) or len(approved_labels) > 128:
            raise ValueError("invalid_label_approvals")
        for key, label in approved_labels.items():
            if (not isinstance(key, str) or not key or len(key) > 256
                    or any(ord(char) < 32 or ord(char) == 127 for char in key)
                    or not isinstance(label, str) or not label.strip() or len(label) > 200
                    or any(ord(char) < 32 or ord(char) == 127 for char in label)):
                raise ValueError("invalid_label_approvals")
        label_bytes = json.dumps(approved_labels, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(label_bytes) > producer.MAX_LABEL_BYTES:
            raise ValueError("invalid_label_approvals")
        if self.store.is_symlink():
            raise ValueError("unsafe_live_store")
        vault_root = self.vault.resolve(strict=True)
        store_root = self.store.resolve()
        if store_root == vault_root or vault_root in store_root.parents:
            raise ValueError("unsafe_live_store")

        approved_bytes = {}
        for relative, record in approved.items():
            raw = read_selected_asset(self.vault, self.selected, relative)
            if hashlib.sha256(raw).hexdigest() != record["sha256"]:
                raise ValueError("asset_approval_hash_mismatch")
            approved_bytes[relative] = raw

        with tempfile.TemporaryDirectory(prefix="publication-live-") as temporary:
            synthetic = Path(temporary)
            note_path = synthetic.joinpath(*selected_parts.parts)
            note_path.parent.mkdir(parents=True, exist_ok=True)
            note_path.write_bytes(source_bytes)
            note_path.with_suffix(".labels.json").write_bytes(label_bytes)
            for relative, raw in approved_bytes.items():
                asset_path = note_path.parent.joinpath(*PurePosixPath(relative).parts)
                asset_path.parent.mkdir(parents=True, exist_ok=True)
                asset_path.write_bytes(raw)
            package_id = producer.build(
                self.store, self.selected, synthetic, approved_assets=approved, title=title
            )

        manifest = self._verify_package(package_id)
        if (manifest["selected"] != self.selected or manifest["title"] != title
                or manifest["source_sha256"] != source_sha256
                or manifest["labels_sha256"] != hashlib.sha256(label_bytes).hexdigest()):
            raise ValueError("live_package_input_binding_mismatch")
        expected_images = {f"assets/images/{record['sha256']}.png" for record in approved.values()}
        actual_images = {name for name in manifest["inventory"] if name.startswith("assets/images/")}
        if actual_images != expected_images:
            raise ValueError("live_package_image_binding_mismatch")
        self._live_packages = [item for item in self._live_packages if item != package_id]
        self._live_packages.append(package_id)
        self._live_packages = self._live_packages[-8:]
        package_path = self.store / package_id
        html_bytes = (package_path / "bundle" / "preview.html").read_bytes()
        html = html_bytes.decode("utf-8")
        return {
            "package_id": package_id,
            "manifest_sha256": package_id,
            "path": self.selected,
            "source_sha256": source_sha256,
            "title_sha256": hashlib.sha256(title.encode("utf-8")).hexdigest(),
            "html": html,
            "preview_sha256": hashlib.sha256(html_bytes).hexdigest(),
            "asset_inventory": {name: record for name, record in manifest["inventory"].items() if name != "preview.html"},
            "mode": "live",
            "state": "live",
            "publication_approval": False,
        }

    def live_asset_bundle(self, package_id: str) -> dict:
        """Return one bounded authenticated local fetch for a live preview's resources."""
        self._ensure_open()
        if package_id not in self._live_packages:
            raise ValueError("live_package_not_found")
        manifest = self._verify_package(package_id)
        package = self.store / package_id / "bundle"
        resources = {}
        total = 0
        for relative, record in sorted(manifest["inventory"].items()):
            if relative == "preview.html":
                continue
            if not relative.startswith("assets/"):
                raise ValueError("live_asset_path_invalid")
            suffix = PurePosixPath(relative).suffix.lower()
            content_type = {
                ".css": "text/css; charset=utf-8",
                ".png": "image/png",
                ".woff2": "font/woff2",
                ".woff": "font/woff",
                ".ttf": "font/ttf",
            }.get(suffix)
            if content_type is None:
                raise ValueError("package_asset_type_denied")
            path = package / PurePosixPath(relative)
            content = path.read_bytes()
            total += len(content)
            if (total > MAX_PACKAGE_BYTES or record["bytes"] != len(content)
                    or hashlib.sha256(content).hexdigest() != record["sha256"]):
                raise ValueError("package_resource_binding_mismatch")
            resources[relative] = {
                "bytes": len(content),
                "sha256": record["sha256"],
                "content_type": content_type,
                "data": base64.b64encode(content).decode("ascii"),
            }
        return {"package_id": package_id, "assets": resources}

    def prepare(self, title: str, approved_assets: dict) -> dict:
        self._ensure_open()
        if self.transport is None:
            raise ValueError("private_transport_required")
        self._assert_no_active_operation()
        package_id, package_path, result = self._package(title, approved_assets)
        binding = result["binding"]
        self._recheck({**binding, "image_sha256": binding["image_sha256"]}, package_id)
        operation_id = uuid.uuid4().hex
        receipt = {
            "schema": RECEIPT_SCHEMA,
            "operation_id": operation_id,
            "state": "allocated",
            "phase": "before_upload",
            "site_pin": self.site_pin,
            "policy_sha256": self.policy_sha256,
            "selected_path": self.selected,
            "title_sha256": binding["title_sha256"],
            "manifest_sha256": package_id,
            "source_sha256": binding["source_sha256"],
            "labels_sha256": binding["labels_sha256"],
            "compiler_sha256": binding["compiler_sha256"],
            "image_sha256": binding["image_sha256"],
            "remote_digest": None,
        }
        if len(self._receipt_files()) >= self.max_receipts:
            raise ValueError("receipt_limit_reached")
        self._save_receipt(receipt)

        receipt["state"], receipt["phase"] = "uploading", "upload"
        self._save_receipt(receipt)
        try:
            uploaded = self.transport.upload(operation_id, package_path, package_id)
        except Exception:
            self._mark_unknown(receipt, "upload", package_id)
            raise ValueError("server_outcome_unknown") from None
        self._after_remote_mutation(receipt, package_id, "upload")
        if (not self._valid_transport_reply(uploaded, operation_id, "uploaded")
                or not self._valid_upload_binding(uploaded, self.site_pin)):
            self._mark_unknown(receipt, "upload", package_id)
            raise ValueError("server_outcome_unknown")
        receipt["publisher_id"] = uploaded["publisher_id"]
        receipt["site_id"] = uploaded["site_id"]
        receipt["site_origin"] = uploaded["site_origin"]
        receipt["server_policy_sha256"] = uploaded["server_policy_sha256"]
        receipt["state"], receipt["phase"] = "uploaded", "before_prepare"
        self._save_receipt(receipt)
        receipt["state"], receipt["phase"] = "creating", "prepare"
        self._save_receipt(receipt)
        try:
            prepared = self.transport.prepare(operation_id, dict(receipt))
        except Exception:
            self._mark_unknown(receipt, "prepare", package_id)
            raise ValueError("server_outcome_unknown") from None
        self._after_remote_mutation(receipt, package_id, "prepare")
        if (not self._valid_transport_reply(prepared, operation_id, "pending")
                or not isinstance(prepared.get("digest"), str)
                or not HEX64.fullmatch(prepared["digest"])):
            self._mark_unknown(receipt, "prepare", package_id)
            raise ValueError("server_outcome_unknown")
        receipt["state"], receipt["phase"] = "pending", "complete"
        receipt["remote_digest"] = prepared["digest"]
        self._save_receipt(receipt)
        return dict(receipt)

    @staticmethod
    def _valid_transport_reply(reply, operation_id: str, expected_state: str) -> bool:
        return (isinstance(reply, dict) and reply.get("operation_id") == operation_id
                and reply.get("state") == expected_state)

    def _after_remote_mutation(self, receipt: dict, package_id: str, phase: str) -> None:
        try:
            self._recheck(receipt, package_id)
        except Exception:
            receipt["state"], receipt["phase"] = "stale_remote", phase
            self._save_receipt(receipt)
            raise ValueError("selected_inputs_changed_after_remote_write") from None

    def _mark_unknown(self, receipt: dict, phase: str, package_id: str) -> None:
        # A lost response is indeterminate: recheck local bindings, but never repeat a write.
        try:
            self._recheck(receipt, package_id)
            receipt["input_recheck"] = "unchanged"
        except Exception:
            receipt["input_recheck"] = "changed_or_unavailable"
        receipt["state"], receipt["phase"] = "unknown", phase
        self._save_receipt(receipt)

    @staticmethod
    def _valid_upload_binding(reply: dict, site_pin: str) -> bool:
        publisher_id = reply.get("publisher_id")
        site_id = reply.get("site_id")
        site_origin = reply.get("site_origin")
        return (
            isinstance(publisher_id, int) and not isinstance(publisher_id, bool) and publisher_id > 0
            and isinstance(site_id, int) and not isinstance(site_id, bool) and site_id > 0
            and isinstance(site_origin, str) and len(site_origin) <= 256
            and site_origin == site_pin + "/"
            and isinstance(reply.get("server_policy_sha256"), str)
            and HEX64.fullmatch(reply["server_policy_sha256"]) is not None
        )

    @staticmethod
    def _valid_lookup_binding(binding) -> bool:
        required = {
            "publisher_id", "site_id", "site_origin", "manifest_sha256", "selected_sha256",
            "source_sha256", "labels_sha256", "title_sha256", "compiler_sha256",
            "server_policy_sha256", "expires_at",
        }
        if not isinstance(binding, dict) or set(binding) != required:
            return False
        if any(not isinstance(binding.get(field), str) or not HEX64.fullmatch(binding[field]) for field in (
            "manifest_sha256", "selected_sha256", "source_sha256", "labels_sha256",
            "title_sha256", "compiler_sha256", "server_policy_sha256",
        )):
            return False
        if any(not isinstance(binding.get(field), int) or isinstance(binding[field], bool) or binding[field] < 1
               for field in ("publisher_id", "site_id", "expires_at")):
            return False
        return isinstance(binding.get("site_origin"), str) and 0 < len(binding["site_origin"]) <= 256

    def _lookup(self, operation_id: str) -> dict:
        if self.transport is None or not callable(getattr(self.transport, "lookup", None)):
            raise ValueError("private_lookup_transport_required")
        remote = self.transport.lookup(operation_id)
        allowed = {"pending", "approved", "committed", "not_found", "unknown"}
        if (not isinstance(remote, dict) or remote.get("operation_id") != operation_id
                or remote.get("state") not in allowed):
            raise ValueError("remote_lookup_contract_mismatch")
        state = remote["state"]
        digest = remote.get("digest")
        if state in {"not_found", "unknown"}:
            if digest is not None:
                raise ValueError("remote_lookup_contract_mismatch")
            return {"operation_id": operation_id, "state": state, "digest": None}
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise ValueError("remote_lookup_digest_invalid")
        binding = remote.get("binding")
        if not self._valid_lookup_binding(binding):
            raise ValueError("remote_lookup_binding_invalid")
        return {"operation_id": operation_id, "state": state, "digest": digest, "binding": dict(binding)}

    def _validate_remote_binding(self, receipt: dict, remote: dict) -> None:
        binding = remote.get("binding")
        expected_selected = hashlib.sha256(receipt["selected_path"].encode("utf-8")).hexdigest()
        expected = {
            "publisher_id": receipt.get("publisher_id"),
            "site_id": receipt.get("site_id"),
            "site_origin": receipt.get("site_origin"),
            "manifest_sha256": receipt.get("manifest_sha256"),
            "selected_sha256": expected_selected,
            "source_sha256": receipt.get("source_sha256"),
            "labels_sha256": receipt.get("labels_sha256"),
            "title_sha256": receipt.get("title_sha256"),
            "compiler_sha256": receipt.get("compiler_sha256"),
            "server_policy_sha256": receipt.get("server_policy_sha256"),
        }
        if any(binding.get(field) != value for field, value in expected.items()):
            raise ValueError("remote_operation_binding_mismatch")
        if receipt.get("site_origin") != self.site_pin + "/":
            raise ValueError("remote_operation_site_mismatch")
        now = int(time.time())
        if binding["expires_at"] <= now or binding["expires_at"] > now + 3600:
            raise ValueError("remote_operation_expired_or_unbounded")
        if receipt.get("remote_digest") is not None and remote.get("digest") != receipt["remote_digest"]:
            raise ValueError("remote_operation_digest_mismatch")

    def status(self, operation_id: str) -> dict:
        receipt = self._read_receipt(operation_id)
        try:
            remote = self._lookup(operation_id)
            if remote["state"] in {"pending", "approved", "committed"}:
                self._validate_remote_binding(receipt, remote)
                if receipt.get("state") == "unknown" and receipt.get("phase") == "prepare":
                    if remote["state"] != "pending":
                        raise ValueError("remote_operation_state_not_reconcilable")
                    self._recheck(receipt, receipt["manifest_sha256"])
                    current = self._read_receipt(operation_id)
                    if current != receipt or current.get("state") != "unknown" or current.get("phase") != "prepare":
                        raise ValueError("receipt_changed_during_reconciliation")
                    reconciled = dict(current)
                    reconciled["state"], reconciled["phase"] = "pending", "complete"
                    reconciled["remote_digest"] = remote["digest"]
                    self._save_receipt(reconciled)
                    receipt = reconciled
        except Exception:
            remote = {"operation_id": operation_id, "state": "unknown", "digest": None}
        return {"receipt": dict(receipt), "remote": remote}

    def commit(self, operation_id: str, digest: str) -> dict:
        self._ensure_open()
        receipt = self._read_receipt(operation_id)
        self._check_receipt_pins(receipt)
        if receipt.get("state") != "pending":
            raise ValueError("operation_not_pending")
        if not isinstance(digest, str) or not HEX64.fullmatch(digest):
            raise ValueError("confirmation_digest_invalid")
        remote = self._lookup(operation_id)  # fresh read immediately before the explicit write
        if remote["state"] == "approved":
            self._validate_remote_binding(receipt, remote)
        if (remote["state"] != "approved" or remote["digest"] != receipt.get("remote_digest")
                or remote["digest"] != digest):
            raise ValueError("fresh_remote_approval_digest_mismatch")
        try:
            self._recheck(receipt, receipt["manifest_sha256"])
        except Exception:
            receipt["state"], receipt["phase"] = "stale_remote", "before_commit"
            self._save_receipt(receipt)
            raise ValueError("selected_inputs_changed_before_commit") from None
        receipt["state"], receipt["phase"] = "committing", "commit"
        self._save_receipt(receipt)
        try:
            committed = self.transport.commit(operation_id, digest)
        except Exception:
            self._mark_unknown(receipt, "commit", receipt["manifest_sha256"])
            raise ValueError("server_outcome_unknown") from None
        if (not self._valid_transport_reply(committed, operation_id, "committed")
                or committed.get("digest") != digest):
            self._mark_unknown(receipt, "commit", receipt["manifest_sha256"])
            raise ValueError("server_outcome_unknown")
        try:
            self._recheck(receipt, receipt["manifest_sha256"])
        except Exception:
            receipt["state"], receipt["phase"] = "committed_input_drift", "complete"
            self._save_receipt(receipt)
            raise ValueError("inputs_changed_after_commit") from None
        receipt["state"], receipt["phase"] = "committed", "complete"
        self._save_receipt(receipt)
        return dict(receipt)

    def cancel(self) -> dict:
        """Close this local session only; it does not cancel a remote operation."""
        self._cancelled = True
        self._live_packages.clear()
        return {"state": "cancelled_local", "remote_cancelled": False}

    def read_asset(self, package_id: str, relative: str) -> tuple[bytes, str]:
        manifest = self._verify_package(package_id)
        if relative not in manifest["inventory"]:
            raise ValueError("package_asset_not_found")
        suffix = PurePosixPath(relative).suffix.lower()
        content_type = {
            ".css": "text/css; charset=utf-8",
            ".png": "image/png",
            ".woff2": "font/woff2",
            ".woff": "font/woff",
            ".ttf": "font/ttf",
        }.get(suffix)
        if content_type is None:
            raise ValueError("package_asset_type_denied")
        path = self.store / package_id / "bundle" / PurePosixPath(relative)
        return path.read_bytes(), content_type


class BridgeDispatcher:
    """Framework-neutral authenticated route dispatcher; caller binds loopback only."""

    def __init__(self, session: BridgeSession, *, pinned_host: str,
                 max_body_bytes: int = MAX_BODY_BYTES):
        if (not isinstance(pinned_host, str)
                or not re.fullmatch(r"127\.0\.0\.1:[0-9]{1,5}", pinned_host)
                or not 1 <= int(pinned_host.rsplit(":", 1)[1]) <= 65535):
            raise ValueError("host_must_be_pinned_ipv4_loopback")
        if not isinstance(max_body_bytes, int) or isinstance(max_body_bytes, bool) or not 1 <= max_body_bytes <= MAX_BODY_BYTES:
            raise ValueError("invalid_body_limit")
        self.session = session
        self.pinned_host = pinned_host
        self.max_body_bytes = max_body_bytes
        authorization = "Bearer " + secrets.token_urlsafe(32)
        self._authorization_digest = hashlib.sha256(authorization.encode("ascii")).digest()
        self._startup_authorization = authorization

    def take_startup_authorization(self) -> str:
        if self._startup_authorization is None:
            raise RuntimeError("startup_authorization_already_taken")
        value = self._startup_authorization
        self._startup_authorization = None
        return value

    @staticmethod
    def _json(status: int, value: dict) -> tuple[int, dict, bytes]:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return status, BridgeDispatcher._response_headers("application/json; charset=utf-8"), body

    @staticmethod
    def _response_headers(content_type: str) -> dict:
        return {
            "Content-Type": content_type,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Allow-Origin": "app://obsidian.md",
            "Vary": "Origin",
        }

    @staticmethod
    def _headers(headers) -> dict:
        if not hasattr(headers, "items"):
            raise ValueError("invalid_headers")
        normalized = {}
        for name, value in headers.items():
            key = str(name).lower()
            if key in normalized or not isinstance(value, str):
                raise ValueError("invalid_headers")
            normalized[key] = value
        return normalized

    @staticmethod
    def _json_body(raw: bytes) -> dict:
        def pairs(items):
            value = {}
            for key, item in items:
                if key in value:
                    raise ValueError("duplicate_json_key")
                value[key] = item
            return value
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid_json") from error
        if not isinstance(value, dict):
            raise ValueError("invalid_json_object")
        return value

    def dispatch(self, method: str, path: str, headers, body: bytes = b"") -> tuple[int, dict, bytes]:
        try:
            normalized = self._headers(headers)
        except ValueError:
            return self._json(400, {"code": "invalid_headers"})
        if normalized.get("origin") != "app://obsidian.md":
            return self._json(403, {"code": "origin_denied"})
        if normalized.get("host") != self.pinned_host:
            return self._json(403, {"code": "host_denied"})
        if not isinstance(body, bytes) or len(body) > self.max_body_bytes:
            return self._json(413, {"code": "request_too_large"})
        content_length = normalized.get("content-length")
        if content_length is not None:
            if not content_length.isdecimal() or int(content_length) != len(body):
                return self._json(400, {"code": "content_length_mismatch"})
        authorization = normalized.get("authorization", "")
        supplied_digest = hashlib.sha256(authorization.encode("utf-8")).digest()
        if not hmac.compare_digest(self._authorization_digest, supplied_digest):
            return self._json(401, {"code": "authentication_required"})
        if method not in ("GET", "POST"):
            return self._json(405, {"code": "method_not_allowed"})
        if not isinstance(path, str) or not path.startswith("/") or any(char in path for char in ("?", "#", "%", "\\")):
            return self._json(404, {"code": "no_route"})
        if method == "GET" and body:
            return self._json(413, {"code": "get_body_denied"})
        if method == "GET":
            status_match = re.fullmatch(r"/v1/status/([a-f0-9]{32})", path)
            if status_match:
                try:
                    return self._json(200, self.session.status(status_match.group(1)))
                except ValueError:
                    return self._json(404, {"code": "operation_not_found"})
            asset_bundle_match = re.fullmatch(r"/v1/assets/([a-f0-9]{64})", path)
            if asset_bundle_match:
                try:
                    return self._json(200, self.session.live_asset_bundle(asset_bundle_match.group(1)))
                except ValueError:
                    return self._json(404, {"code": "asset_not_found"})
            asset_match = re.fullmatch(r"/v1/assets/([a-f0-9]{64})/(.+)", path)
            if asset_match:
                try:
                    content, content_type = self.session.read_asset(asset_match.group(1), asset_match.group(2))
                except ValueError:
                    return self._json(404, {"code": "asset_not_found"})
                return 200, self._response_headers(content_type), content
            return self._json(404, {"code": "no_route"})
        if normalized.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            return self._json(415, {"code": "json_required"})
        try:
            request = self._json_body(body)
            if path == "/v1/asset-candidate":
                if set(request) != {"path"}:
                    raise ValueError("request_fields_invalid")
                return self._json(200, self.session.asset_candidate(request["path"]))
            if path == "/v1/live":
                if set(request) != {"path", "text", "source_sha256", "title", "approved_assets", "approved_labels"}:
                    raise ValueError("request_fields_invalid")
                result = self.session.live_render_unsaved(
                    request["path"], request["text"], request["source_sha256"], request["title"],
                    request["approved_assets"], request["approved_labels"],
                )
                return self._json(200, result)
            if path == "/v1/prepare":
                if set(request) != {"title", "approved_assets"}:
                    raise ValueError("request_fields_invalid")
                return self._json(201, self.session.prepare(request["title"], request["approved_assets"]))
            if path == "/v1/cancel":
                if request:
                    raise ValueError("request_fields_invalid")
                return self._json(200, self.session.cancel())
            commit_match = re.fullmatch(r"/v1/commit/([a-f0-9]{32})", path)
            if commit_match:
                if set(request) != {"digest"}:
                    raise ValueError("request_fields_invalid")
                return self._json(200, self.session.commit(commit_match.group(1), request["digest"]))
            return self._json(404, {"code": "no_route"})
        except ValueError as error:
            code = str(error).split(":", 1)[0][:96] or "request_rejected"
            return self._json(409, {"code": code})
