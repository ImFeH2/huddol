from __future__ import annotations

import email.utils
import http
import logging
import secrets
import sys
import threading
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response
from websockets.sync.server import Server, ServerConnection, serve

from huddol.adapters.jsonl.protocol import Dispatcher, encode
from huddol.adapters.websocket.access_error import ACCESS_ERROR_PAGE

APP_ORIGINS = frozenset(
    {"http://localhost:1420", "http://tauri.localhost", "tauri://localhost"}
)

HOST = "127.0.0.1"
CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

log = logging.getLogger(__name__)


def webui_directory(override: str | None = None) -> Path | None:
    if override:
        return Path(override).expanduser().resolve()
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        return Path(bundle) / "webui"
    return None


def _response(status: http.HTTPStatus, content_type: str, body: bytes) -> Response:
    headers = Headers(
        [
            ("Date", email.utils.formatdate(usegmt=True)),
            ("Connection", "close"),
            ("Content-Length", str(len(body))),
            ("Content-Type", content_type),
        ]
    )
    return Response(status.value, status.phrase, headers, body)


def _plain(status: http.HTTPStatus, text: str) -> Response:
    return _response(status, "text/plain; charset=utf-8", text.encode())


def static_response(directory: Path, path: str) -> Response:
    if not directory.is_dir():
        return _plain(http.HTTPStatus.SERVICE_UNAVAILABLE, "Frontend not built")
    relative = unquote(path).lstrip("/")
    target = directory / "index.html"
    if "." in relative:
        target = (directory / relative).resolve()
        if not target.is_relative_to(directory.resolve()) or not target.is_file():
            return _plain(http.HTTPStatus.NOT_FOUND, "Not found")
    if not target.is_file():
        return _plain(http.HTTPStatus.SERVICE_UNAVAILABLE, "Frontend not built")
    content_type = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
    return _response(http.HTTPStatus.OK, content_type, target.read_bytes())


def _close_reason(reason: str | None) -> str | None:
    return reason if reason in (None, "", "keepalive ping timeout") else "[redacted]"


class WebServer:
    def __init__(
        self,
        dispatcher: Dispatcher,
        token: str,
        directory: Path | None,
        port: int = 0,
    ) -> None:
        self._dispatcher = dispatcher
        self._token = token
        self._directory = directory
        logging.getLogger("websockets.server").setLevel(logging.WARNING)
        self._server: Server = serve(
            self._handle,
            HOST,
            port,
            process_request=self._process_request,
        )
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="huddol-web"
        )
        self._connections: set[ServerConnection] = set()
        self._lock = threading.Lock()

    @property
    def port(self) -> int:
        return int(self._server.socket.getsockname()[1])

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        with self._lock:
            connections = list(self._connections)
        for connection in connections:
            connection.close()
        self._thread.join()

    def _process_request(
        self, connection: ServerConnection, request: Request
    ) -> Response | None:
        url = urlsplit(request.path)
        if url.path == "/ws":
            supplied = parse_qs(url.query).get("token", [""])[0]
            authenticated = bool(supplied) and secrets.compare_digest(
                supplied.encode(), self._token.encode()
            )
            if (
                authenticated
                and request.headers.get("Upgrade", "").lower() == "websocket"
            ):
                return None
            response = _response(
                http.HTTPStatus.NO_CONTENT
                if authenticated
                else http.HTTPStatus.UNAUTHORIZED,
                "text/html; charset=utf-8",
                b"" if authenticated else ACCESS_ERROR_PAGE,
            )
            if authenticated:
                del response.headers["Content-Length"]
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["Vary"] = "Origin"
            origin = request.headers.get("Origin")
            if origin in APP_ORIGINS:
                response.headers["Access-Control-Allow-Origin"] = origin
            return response
        if self._directory is None:
            return _plain(http.HTTPStatus.NOT_FOUND, "Not found")
        return static_response(self._directory, url.path)

    def _handle(self, connection: ServerConnection) -> None:
        def sink(payload: dict[str, Any]) -> None:
            try:
                connection.send(encode(payload))
            except ConnectionClosed:
                pass

        with self._lock:
            self._connections.add(connection)
        self._dispatcher.attach(sink)
        try:
            for message in connection:
                text = (
                    message.decode("utf-8") if isinstance(message, bytes) else message
                )
                self._dispatcher.receive(text, sink)
        except ConnectionClosed:
            pass
        finally:
            sent = connection.protocol.close_sent
            received = connection.protocol.close_rcvd
            log.info(
                "WebSocket closed connection=%s code=%s sent_code=%s sent_reason=%r "
                "received_code=%s received_reason=%r",
                connection.id,
                connection.close_code,
                sent.code if sent else None,
                _close_reason(sent.reason if sent else None),
                received.code if received else None,
                _close_reason(received.reason if received else None),
            )
            self._dispatcher.detach(sink)
            with self._lock:
                self._connections.discard(connection)
