"""Private subprocess launcher for one fail-closed local live preview."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "bridge"), str(ROOT / "producer")]

MAX_CONFIG_LINE = 8192
MAX_HANDSHAKE_LINE = 4096
LOCAL_SITE_PIN = "https://local-only.invalid"
LOCAL_POLICY_PIN = hashlib.sha256(b"publication-v1 local-live-only policy").hexdigest()


class LiveOnlySession:
    """Keep this launcher permanently disconnected from remote workflows."""

    def __new__(cls, **kwargs):
        from publication_session import BridgeSession

        class Session(BridgeSession):
            def prepare(self, *_args, **_kwargs):
                raise ValueError("session_workflow_not_connected")

            def status(self, *_args, **_kwargs):
                raise ValueError("session_workflow_not_connected")

            def commit(self, *_args, **_kwargs):
                raise ValueError("session_workflow_not_connected")

        return Session(**kwargs)


def _read_config() -> dict:
    raw = sys.stdin.buffer.readline(MAX_CONFIG_LINE + 1)
    if not raw or len(raw) > MAX_CONFIG_LINE or not raw.endswith(b"\n"):
        raise ValueError("invalid_config")
    try:
        value = json.loads(raw[:-1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid_config") from error
    if not isinstance(value, dict) or set(value) != {"selected", "vault"}:
        raise ValueError("invalid_config")
    return value


def _validate_config(value: dict) -> tuple[Path, str]:
    selected = value["selected"]
    if (not isinstance(selected, str) or not selected.endswith(".md")
            or any(ord(char) < 32 or ord(char) == 127 for char in selected)
            or unicodedata.normalize("NFC", selected) != selected
            or any(not part or part.startswith(".") or part in (".", "..") for part in selected.split("/"))
            or "\\" in selected or ":" in selected):
        raise ValueError("invalid_config")
    vault_value = value["vault"]
    if not isinstance(vault_value, str) or "\x00" in vault_value:
        raise ValueError("invalid_config")
    vault = Path(vault_value)
    if not vault.is_absolute() or vault.is_symlink() or not vault.is_dir():
        raise ValueError("invalid_config")
    return vault, selected


def _runtime_check() -> None:
    import package_builder

    package_builder._toolchain()


def _temporary_parent(vault: Path) -> Path | None:
    raw = os.environ.get("TMPDIR")
    if raw is None:
        return None
    parent = Path(raw)
    if not parent.is_absolute() or parent.is_symlink() or not parent.is_dir():
        raise ValueError("invalid_runtime")
    vault_root = vault.resolve(strict=True)
    parent_root = parent.resolve(strict=True)
    if parent_root == vault_root or vault_root in parent_root.parents:
        raise ValueError("invalid_runtime")
    return parent


def _run() -> int:
    from http_listener import LoopbackHTTPListener

    config = _read_config()
    vault, selected = _validate_config(config)
    _runtime_check()
    temporary_parent = _temporary_parent(vault)
    workspace = tempfile.TemporaryDirectory(prefix="publication-local-session-", dir=temporary_parent)
    root = Path(workspace.name)
    session = None
    listener = None
    status = 0
    try:
        session = LiveOnlySession(
            vault=vault,
            selected=selected,
            store=root / "packages",
            receipts_dir=root / "receipts",
            transport=None,
            site_pin=LOCAL_SITE_PIN,
            policy_sha256=LOCAL_POLICY_PIN,
        )
        listener = LoopbackHTTPListener(session).start()
        authorization = listener.take_startup_authorization()
        handshake = json.dumps(
            {"type": "ready", "origin": listener.url, "authorization": authorization},
            separators=(",", ":"),
        ).encode("ascii") + b"\n"
        if len(handshake) > MAX_HANDSHAKE_LINE:
            raise ValueError("handshake_too_large")
        sys.stdout.buffer.write(handshake)
        sys.stdout.buffer.flush()
        # The parent keeps stdin open after the one config line; EOF is shutdown.
        if sys.stdin.buffer.read(1):
            status = 2
    except Exception:
        status = 2
    finally:
        if listener is not None:
            try:
                listener.close()
            except Exception:
                status = 3
        if session is not None:
            try:
                session.cancel()
            except Exception:
                status = 3
        try:
            workspace.cleanup()
        except Exception:
            status = 3
    return status


def main() -> int:
    try:
        return _run()
    except Exception:
        # Never emit raw exceptions, request bodies, or the private handshake.
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
