"""Host / Origin guard for the recorder API (review 1.7).

The recorder has no authentication: its only protection is that it listens on loopback. A web page
the operator merely visits can still reach it from their browser, in two ways:

* a cross-site `fetch(..., {mode: "no-cors"})` POST (to /record/stop, or /record/start and
  /storage/config with a body that needs no CORS preflight) — the response is opaque but the
  request is sent and acted on;
* a WebSocket handshake to /record/stream (WebSockets are not subject to CORS at all);
* DNS rebinding, where an attacker's hostname resolves to 127.0.0.1 so that "cross-site" becomes
  same-origin from the browser's point of view.

Every browser attaches an `Origin` header to those requests (and to WebSocket handshakes) and
always sends the page's own hostname as `Host`, so this pure-ASGI middleware refuses:

* any HTTP or WebSocket request whose `Host` is not a loopback name (or an explicitly configured
  extra host) on the port the server is listening on, and
* any request carrying an `Origin` that is not on the allow-list (the CORS list, the desktop
  renderer's `app://force`).

Requests with NO `Origin` (curl, the Electron main process, the sidecar health probe, the
installer's smoke tests) are not browser cross-site requests and keep working.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from urllib.parse import urlsplit

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
# The packaged desktop app's renderer (desktop/src/protocol.ts registers the `app` scheme and
# main.ts loads app://force/).
DESKTOP_ORIGIN = "app://force"


def normalize_origin(origin: str) -> str:
    return origin.strip().rstrip("/").lower()


class OriginGuardSettings:
    """Mutable so tests (and nothing else) can adjust it after the middleware is built."""

    def __init__(self, origins: Iterable[str] = (), extra_hosts: Iterable[str] = ()):
        self.origins: set[str] = {normalize_origin(o) for o in origins if o.strip()}
        self.origins.add(DESKTOP_ORIGIN)
        self.extra_hosts: set[str] = {h.strip().lower() for h in extra_hosts if h.strip()}


def _host_ok(host_header: str, server_port: int | None, extra_hosts: set[str]) -> bool:
    try:
        parts = urlsplit("//" + host_header.strip())
        hostname = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if not hostname:
        return False
    if hostname in extra_hosts:
        return True
    if hostname not in LOOPBACK_HOSTS:
        return False
    # A loopback name on some OTHER port is not this server (or a rebinding trick): refuse.
    return port is None or server_port is None or port == server_port


def _has_body(headers: dict[str, str]) -> bool:
    if "transfer-encoding" in headers:
        return True
    try:
        return int(headers.get("content-length", "0") or "0") > 0
    except ValueError:
        return True


class OriginGuard:
    def __init__(self, app, settings: OriginGuardSettings):
        self.app = app
        self.settings = settings

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        server = scope.get("server")
        server_port = server[1] if server and len(server) > 1 else None
        reason = None
        status = 403
        if not _host_ok(headers.get("host", ""), server_port, self.settings.extra_hosts):
            reason = "host not allowed"
        elif (
            scope["type"] == "http"
            and scope.get("method") in ("POST", "PUT", "PATCH")
            and not headers.get("content-type", "").strip()
            and _has_body(headers)
        ):
            # A no-cors `fetch` with an untyped Blob sends a body with no Content-Type, and some
            # FastAPI versions parse that as JSON. Every real client labels its body.
            reason, status = "a request body needs a Content-Type", 415
        else:
            origin = headers.get("origin")
            if origin is not None and normalize_origin(origin) not in self.settings.origins:
                reason = "origin not allowed"
        if reason is None:
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            # Closing before accept makes the server answer the handshake with HTTP 403.
            await receive()  # the websocket.connect event
            await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        body = json.dumps({"detail": reason}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
