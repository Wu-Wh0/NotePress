"""Explicit synthetic-only launcher joining plugin, bridge, and fresh WP-WASM."""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import selectors
import socket
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
BRIDGE_DIR = ROOT / "bridge"
PRODUCER_DIR = ROOT / "producer"
sys.path[:0] = [str(BRIDGE_DIR), str(PRODUCER_DIR)]
from http_listener import LoopbackHTTPListener  # noqa: E402
from publication_session import BridgeSession  # noqa: E402
from wp_transport import WordPressTransport  # noqa: E402
from live_launcher import _validate_config  # noqa: E402

SITE_PIN = "https://publication-v1.example.test"
POLICY_SHA256 = hashlib.sha256(b"isolated synthetic publication policy").hexdigest()
TOKEN = re.compile(r"^[a-f0-9]{64}$")


def decode_config() -> dict:
    if len(sys.argv) != 2 or len(sys.argv[1]) > 8192:
        raise ValueError("worker_config_invalid")
    value = json.loads(base64.b64decode(sys.argv[1], validate=True))
    keys = {"modules", "wpCore", "sqliteZip", "serverPath", "runId", "compilerSha256", "evidencePath"}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("worker_config_invalid")
    if not re.fullmatch(r"[0-9a-f]{32}", value["runId"] or ""):
        raise ValueError("worker_config_invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", value["compilerSha256"] or ""):
        raise ValueError("worker_config_invalid")
    for name in ("modules", "wpCore", "sqliteZip", "serverPath"):
        path = Path(value[name])
        if not path.is_absolute() or path.is_symlink() or not path.exists():
            raise ValueError("worker_runtime_path_invalid")
    scratch = Path(os.environ.get("TMPDIR", ""))
    evidence_path = Path(value["evidencePath"])
    if (not scratch.is_absolute() or not scratch.is_dir() or scratch.is_symlink()
            or not evidence_path.is_absolute() or ".." in evidence_path.parts
            or scratch.resolve() not in evidence_path.resolve().parents
            or any(path.is_symlink() for path in (evidence_path, *evidence_path.parents))):
        raise ValueError("owned_evidence_path_invalid")
    return value


def runtime_input() -> tuple[Path, str]:
    line = sys.stdin.readline(8193)
    if not line or len(line) > 8192 or not line.endswith("\n"):
        raise ValueError("plugin_runtime_input_invalid")
    value = json.loads(line)
    if not isinstance(value, dict) or set(value) != {"vault", "selected"}:
        raise ValueError("plugin_runtime_input_invalid")
    scratch = Path(os.environ.get("TMPDIR", ""))
    if not scratch.is_absolute() or not scratch.is_dir() or scratch.is_symlink():
        raise ValueError("owned_scratch_invalid")
    vault, selected = _validate_config(value)
    if not vault.is_absolute() or vault.is_symlink() or scratch.resolve() not in vault.resolve().parents:
        raise ValueError("synthetic_vault_outside_owned_scratch")
    if not (vault / selected).is_file():
        raise ValueError("synthetic_selection_invalid")
    return vault, selected


def wait_worker_ready(worker: subprocess.Popen[bytes], timeout: float = 170.0) -> dict:
    selector = selectors.DefaultSelector()
    assert worker.stdout is not None
    selector.register(worker.stdout, selectors.EVENT_READ)
    try:
        if not selector.select(timeout=timeout):
            raise TimeoutError("fresh_wordpress_worker_startup_timeout")
        line = worker.stdout.readline(4097)
    finally:
        selector.close()
    if not line or len(line) > 4096 or not line.endswith(b"\n"):
        raise RuntimeError("fresh_wordpress_worker_ready_invalid")
    ready = json.loads(line)
    if (not isinstance(ready, dict) or set(ready) != {"type", "port", "publisherToken", "controlToken"}
            or ready.get("type") != "READY" or not isinstance(ready.get("port"), int)
            or not 1 <= ready["port"] <= 65535 or not TOKEN.fullmatch(ready.get("publisherToken", ""))
            or not TOKEN.fullmatch(ready.get("controlToken", ""))):
        raise RuntimeError("fresh_wordpress_worker_ready_invalid")
    return ready


def worker_control(port: int, token: str, path: str, body: dict | None = None) -> dict:
    payload = json.dumps(body or {}, separators=(",", ":")).encode("utf-8")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        connection.request("POST", path, body=payload, headers={
            "Connection": "close", "Content-Type": "application/json", "X-Test-Harness": token,
        })
        response = connection.getresponse()
        data = response.read(8192)
        if response.status != 200:
            raise RuntimeError("fresh_wordpress_control_readback_failed")
        value = json.loads(data)
        if not isinstance(value, dict):
            raise RuntimeError("fresh_wordpress_control_readback_invalid")
        return value
    finally:
        connection.close()


def wp_request(port: int, publisher_token: str):
    def request(method: str, route: str, headers: dict, body: bytes | None):
        actual = dict(headers)
        actual["X-Test-Publisher"] = publisher_token
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        try:
            connection.request(method, route, body=body or b"", headers={"Connection": "close", **actual})
            response = connection.getresponse()
            return response.status, response.read(25_200_000)
        finally:
            connection.close()
    return request


def port_closed(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def terminate_worker(worker: subprocess.Popen[bytes] | None) -> int | None:
    if worker is None:
        return None
    if worker.poll() is None:
        worker.terminate()
    try:
        return worker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        worker.kill()
        return worker.wait(timeout=10)


def write_evidence(path: str, value: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, target)


def main() -> int:
    config = decode_config()
    vault, selected = runtime_input()
    if vault.resolve() in Path(config["evidencePath"]).resolve().parents:
        raise ValueError("evidence_must_not_overwrite_vault")
    evidence = {
        "schema": "isolated-publication-launch-evidence-v1",
        "run_id": config["runId"],
        "site_pin": SITE_PIN,
        "worker_pid": None,
        "worker_exit_code": None,
        "bridge_port": None,
        "bridge_port_closed": False,
        "wp_port": None,
        "wp_port_closed": False,
        "post_counts_before": None,
        "post_counts_after": None,
        "stdin_eof": False,
    }
    worker = None
    listener = None
    port = None
    failure = None
    try:
        with tempfile.TemporaryDirectory(prefix="publication-isolated-launch-", dir=Path(os.environ["TMPDIR"])) as private_root:
            worker_payload = {key: config[key] for key in ("modules", "wpCore", "sqliteZip", "serverPath", "runId", "compilerSha256")}
            encoded = base64.b64encode(json.dumps(worker_payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
            worker_env = dict(os.environ)
            worker_env["PYTHONDONTWRITEBYTECODE"] = "1"
            worker = subprocess.Popen(
                [str(Path(os.environ["PUBLICATION_NODE"])), str(ROOT / "tests" / "fixtures" / "wp-session-worker.mjs"), encoded],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=worker_env,
            )
            evidence["worker_pid"] = worker.pid
            if worker.stderr is not None:
                threading.Thread(target=lambda: [line for line in iter(worker.stderr.readline, b"")], daemon=True).start()
            ready = wait_worker_ready(worker)
            port = ready["port"]
            evidence["wp_port"] = port
            before = worker_control(port, ready["controlToken"], "/__test__/publication-counts")
            if set(before) != {"post_count", "publication_operation_meta_count"} or any(type(x) is not int or x < 0 for x in before.values()):
                raise RuntimeError("fresh_wordpress_count_readback_invalid")
            evidence["post_counts_before"] = before
            session = BridgeSession(
                vault=vault, selected=selected,
                store=Path(private_root) / "packages", receipts_dir=Path(private_root) / "receipts",
                transport=WordPressTransport(request=wp_request(port, ready["publisherToken"])),
                site_pin=SITE_PIN, policy_sha256=POLICY_SHA256,
            )
            listener = LoopbackHTTPListener(session).start()
            evidence["bridge_port"] = listener.port
            handshake = {
                "type": "ready", "origin": listener.url,
                "authorization": listener.take_startup_authorization(),
                "workflowConnected": True, "sitePin": SITE_PIN,
            }
            sys.stdout.write(json.dumps(handshake, separators=(",", ":")) + "\n")
            sys.stdout.flush()
            if sys.stdin.read(1):
                raise ValueError("unexpected_parent_input")
            evidence["stdin_eof"] = True
            listener.close()
            listener = None
            evidence["bridge_port_closed"] = port_closed(evidence["bridge_port"])
            after = worker_control(port, ready["controlToken"], "/__test__/publication-counts")
            if set(after) != {"post_count", "publication_operation_meta_count"} or any(type(x) is not int or x < 0 for x in after.values()):
                raise RuntimeError("fresh_wordpress_count_readback_invalid")
            evidence["post_counts_after"] = after
            evidence["worker_exit_code"] = terminate_worker(worker)
            worker = None
            evidence["wp_port_closed"] = port_closed(port)
    except BaseException as error:
        failure = type(error).__name__
    finally:
        if listener is not None:
            try:
                listener.close()
                evidence["bridge_port_closed"] = port_closed(evidence["bridge_port"])
            except Exception:
                pass
        if worker is not None:
            evidence["worker_exit_code"] = terminate_worker(worker)
            if port is not None:
                evidence["wp_port_closed"] = port_closed(port)
        evidence["failure_class"] = failure
        try:
            write_evidence(config["evidencePath"], evidence)
        except Exception:
            pass
    if failure:
        sys.stderr.write("isolated_publication_launcher_failed\n")
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write("isolated_publication_launcher_preflight_failed\n")
        raise SystemExit(2)
