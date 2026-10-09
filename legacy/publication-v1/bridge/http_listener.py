"""Small authenticated HTTP/1.1 adapter for one local publication session."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from typing import Any

from publication_session import BridgeDispatcher, BridgeSession


class _LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = True


class LoopbackHTTPListener:
    """Bind exactly to IPv4 loopback and serve one dispatcher until closed.

    The startup bearer is available once via ``take_startup_authorization``.
    It is never placed in a URL, response, or log message.
    """

    def __init__(self, session: BridgeSession, *, max_body_bytes: int = 64 * 1024):
        self.session = session
        self.max_body_bytes = max_body_bytes
        self._dispatcher: BridgeDispatcher | None = None
        self._authorization: str | None = None
        self._thread: threading.Thread | None = None
        self._closed = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "PublicationV1Local"
            sys_version = ""

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def handle_expect_100(self) -> bool:
                self._send(417, {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"}, b"")
                return False

            def _send(self, status: int, headers: dict, body: bytes) -> None:
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                if body:
                    self.wfile.write(body)
                self.close_connection = True

            def _reject(self, status: int, code: str) -> None:
                response = owner._dispatcher._json(status, {"code": code})
                self._send(*response)

            def _handle(self) -> None:
                dispatcher = owner._dispatcher
                if dispatcher is None:
                    self._reject(503, "listener_unavailable")
                    return

                # Validate Origin, exact Host, and bearer without reading a byte
                # from rfile. OPTIONS reaches dispatch's method gate only after
                # those checks have succeeded.
                security_headers = {
                    name: value for name, value in self.headers.items()
                    if name.lower() != "content-length"
                }
                preflight = dispatcher.dispatch("OPTIONS", "/", security_headers, b"")
                if preflight[0] != 405:
                    self._send(*preflight)
                    return
                if self.command not in ("GET", "POST"):
                    self._send(*preflight)
                    return

                transfer_encoding = self.headers.get_all("Transfer-Encoding", [])
                lengths = self.headers.get_all("Content-Length", [])
                if transfer_encoding:
                    self._reject(413, "request_transfer_encoding_denied")
                    return
                if len(lengths) > 1:
                    self._reject(400, "invalid_content_length")
                    return
                if lengths:
                    value = lengths[0]
                    if not value.isdecimal():
                        self._reject(400, "invalid_content_length")
                        return
                    length = int(value)
                else:
                    length = 0
                if length > dispatcher.max_body_bytes:
                    self._reject(413, "request_too_large")
                    return
                if self.command == "GET" and length:
                    self._reject(413, "get_body_denied")
                    return

                self.connection.settimeout(15)
                try:
                    body = self.rfile.read(length) if length else b""
                except (OSError, TimeoutError):
                    self._reject(400, "request_body_incomplete")
                    return
                if len(body) != length:
                    self._reject(400, "request_body_incomplete")
                    return
                response = dispatcher.dispatch(self.command, self.path, self.headers, body)
                self._send(*response)

            def do_GET(self) -> None:
                self._handle()

            def do_POST(self) -> None:
                self._handle()

            def do_HEAD(self) -> None:
                self._handle()

            def do_PUT(self) -> None:
                self._handle()

            def do_PATCH(self) -> None:
                self._handle()

            def do_DELETE(self) -> None:
                self._handle()

            def do_OPTIONS(self) -> None:
                self._handle()

        self._server = _LoopbackServer(("127.0.0.1", 0), Handler)
        host, port = self._server.server_address[:2]
        if host != "127.0.0.1":
            self._server.server_close()
            raise RuntimeError("listener_not_loopback")
        self.host = host
        self.port = int(port)
        self.host_header = f"{self.host}:{self.port}"
        self.url = f"http://{self.host_header}"
        self._dispatcher = BridgeDispatcher(
            session,
            pinned_host=self.host_header,
            max_body_bytes=max_body_bytes,
        )
        self._authorization = self._dispatcher.take_startup_authorization()

    def take_startup_authorization(self) -> str:
        if self._authorization is None:
            raise RuntimeError("startup_authorization_already_taken")
        value = self._authorization
        self._authorization = None
        return value

    def start(self) -> "LoopbackHTTPListener":
        if self._closed:
            raise RuntimeError("listener_closed")
        if self._thread is not None:
            raise RuntimeError("listener_already_started")
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="publication-v1-loopback-listener",
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        self._thread.start()
        return self

    def close(self) -> None:
        if self._closed:
            return
        if self._thread is not None:
            self._server.shutdown()
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                raise RuntimeError("listener_thread_did_not_stop")
        self._server.server_close()
        self._closed = True

    def __enter__(self) -> "LoopbackHTTPListener":
        return self.start()

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()
