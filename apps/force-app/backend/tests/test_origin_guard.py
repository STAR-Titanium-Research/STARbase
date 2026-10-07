"""Review 1.7: the unauthenticated recorder must refuse browser requests from other sites and
DNS-rebinding hosts, over HTTP and over the WebSocket handshake, while requests without an Origin
(curl, the Electron main process, the sidecar health probe) and the app's own origins still work."""

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

import app.main as main
from app import origin_guard
from app.main import app as fastapi_app

PORT = 8200
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}/record/stream"


def _guard_settings():
    """The settings object of the middleware actually installed on `fastapi_app`. (Some tests
    reload app.main, which rebinds main._origin_guard to a different object.)"""
    for m in fastapi_app.user_middleware:
        if m.cls is origin_guard.OriginGuard:
            return m.kwargs["settings"]
    raise AssertionError("OriginGuard is not installed")


@pytest.fixture
def client(monkeypatch, tmp_path):
    # conftest lets Starlette's `Host: testserver` through; the guard's own tests use real
    # loopback hosts and no extras.
    monkeypatch.setattr(_guard_settings(), "extra_hosts", set())
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    with TestClient(fastapi_app, base_url=BASE) as c:
        yield c


# ---- Origin ----


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "http://localhost:9999", "null", "http://127.0.0.1:5180"]
)
def test_foreign_origin_is_refused_on_every_method(client, origin):
    h = {"Origin": origin}
    assert client.post("/record/stop", headers=h).status_code == 403
    assert client.get("/record/status", headers=h).status_code == 403
    assert client.delete("/captures/whatever", headers=h).status_code == 403
    r = client.post(
        "/storage/config", content=b'{"x":1}', headers={**h, "content-type": "text/plain"}
    )
    assert r.status_code == 403


def test_no_cors_post_does_not_reach_the_handler(client, monkeypatch):
    """The point of the guard: the side effect must not happen, not just the response be hidden."""
    stopped = []

    class _S:
        id, state = "x", "recording"

        def stop(self, **k):
            stopped.append(1)

    monkeypatch.setattr(main, "_session", _S())
    r = client.post("/record/stop", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert stopped == []


@pytest.mark.parametrize(
    "origin", ["app://force", "http://localhost:5180", "http://localhost:5181"]
)
def test_the_apps_own_origins_work(client, origin):
    r = client.get("/record/status", headers={"Origin": origin})
    assert r.status_code == 200
    # ... and CORS still answers for the dev origins the browser asks about
    if origin.startswith("http"):
        assert r.headers.get("access-control-allow-origin") == origin


def test_cors_preflight_for_an_allowed_origin_still_works(client):
    r = client.options(
        "/record/start",
        headers={
            "Origin": "http://localhost:5180",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5180"


def test_preflight_for_a_foreign_origin_is_refused(client):
    r = client.options(
        "/record/start",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert r.status_code == 403


def test_requests_without_an_origin_keep_working(client):
    # curl, the Electron main process (recorderFetch) and the sidecar health probe send none.
    assert client.get("/health").status_code == 200
    assert client.get("/record/status").status_code == 200
    assert client.post("/record/stop").status_code in (200, 400, 404, 409)


# ---- Host ----


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",
        "evil.example:8200",
        "127.0.0.1.evil.example:8200",
        "localhost.evil.example",
        "192.168.1.5:8200",
        "127.0.0.1:9999",  # a loopback name on another port is not this server
        "",
    ],
)
def test_foreign_host_is_refused(client, host):
    r = client.get("/health", headers={"Host": host})
    assert r.status_code == 403, r.text


@pytest.mark.parametrize("host", ["127.0.0.1:8200", "localhost:8200", "[::1]:8200", "localhost"])
def test_loopback_hosts_work(client, host):
    assert client.get("/health", headers={"Host": host}).status_code == 200


def test_dns_rebinding_with_a_matching_origin_is_still_refused(client):
    """Rebinding makes the page same-origin with the attacker's hostname, so Origin == Host, and
    both are foreign."""
    r = client.get(
        "/record/status",
        headers={"Host": "rebind.evil.example:8200", "Origin": "http://rebind.evil.example:8200"},
    )
    assert r.status_code == 403


def test_an_explicitly_configured_extra_host_is_allowed(client, monkeypatch):
    monkeypatch.setattr(_guard_settings(), "extra_hosts", {"rig-pc.tail1234.ts.net"})
    assert client.get("/health", headers={"Host": "rig-pc.tail1234.ts.net:8200"}).status_code == 200
    assert client.get("/health", headers={"Host": "evil.example"}).status_code == 403


# ---- WebSocket handshake ----


def test_websocket_with_a_foreign_origin_is_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(WS, headers={"Origin": "https://evil.example"}):
            pass


def test_websocket_with_a_foreign_host_is_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(WS, headers={"Host": "evil.example"}):
            pass


@pytest.mark.parametrize("origin", [None, "app://force", "http://localhost:5180"])
def test_websocket_from_the_app_connects(client, origin):
    headers = {"Origin": origin} if origin else {}
    with client.websocket_connect(WS, headers=headers) as ws:
        ws.close()


# ---- body parsing (the other half of the no-cors POST: a JSON body sent as text/plain) ----


def test_json_endpoints_refuse_a_non_json_content_type(client):
    """A no-cors cross-site POST can only send a "simple" content type (text/plain, form...) or
    none at all. The Origin check above is what stops it, but the body must not be parsed as JSON
    either: text/plain is a 422 from FastAPI, and a body with no Content-Type (which some FastAPI
    versions, e.g. 0.115, do parse as JSON) is refused by the guard with 415."""
    for url in ("/storage/config", "/record/start"):
        r = client.post(url, content=b'{"duration_sec": 1}', headers={"content-type": "text/plain"})
        assert r.status_code == 422, (url, r.status_code)
        r = client.post(url, content=b'{"duration_sec": 1}', headers={"content-type": ""})
        assert r.status_code == 415, (url, r.status_code)
    # A bodiless POST (e.g. /record/stop from the app) still needs no Content-Type.
    assert client.post("/record/stop").status_code != 415


def test_stream_handler_returns_when_an_idle_client_disconnects(monkeypatch):
    """A client that leaves while nothing is being published must end the handler. It used to wait
    only on the broadcast queue, so it never saw the disconnect, and a SIGTERM hung on "Waiting for
    background tasks" for as long as a browser had the stream open."""
    import asyncio

    from app.stream.broadcast import Broadcaster

    class _ClientGone:
        async def accept(self):
            pass

        async def receive(self):
            return {"type": "websocket.disconnect", "code": 1001}

        async def send_bytes(self, b):
            raise AssertionError("nothing was published")

        send_text = send_bytes

    async def run():
        b = Broadcaster(asyncio.get_running_loop())
        monkeypatch.setattr(main, "_broadcaster", b)
        await asyncio.wait_for(main.record_stream(_ClientGone()), timeout=2)
        assert b._subs == set()

    asyncio.run(run())
