"""Tests for the bug-report relay: config gating, token caching, issue creation."""

import httpx
import pytest
import server as srv
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_cache():
    srv._token_cache.token = ""
    srv._token_cache.expires_at = 0.0
    yield


@pytest.fixture
def client():
    return TestClient(srv.app)


def test_health_reports_unconfigured_by_default(client, monkeypatch):
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["configured"] is False


def test_report_fails_closed_when_not_configured(client, monkeypatch):
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    r = client.post("/report", json={"title": "t", "body": "b"})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert "not configured" in data["reason"]


def test_report_requires_title(client, monkeypatch):
    monkeypatch.setattr(srv, "configured", lambda: True)
    r = client.post("/report", json={"title": "  ", "body": "b"})
    assert r.json() == {"ok": False, "reason": "A title is required."}


def test_report_creates_issue(client, monkeypatch):
    monkeypatch.setattr(srv, "configured", lambda: True)

    async def fake_get_token(self):
        return "installation-token"

    monkeypatch.setattr(srv._TokenCache, "get", fake_get_token)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer installation-token"
        return httpx.Response(
            201, json={"html_url": "https://github.com/x/y/issues/1", "number": 1}
        )

    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(
            transport=httpx.MockTransport(handler),
            **{k: v for k, v in kw.items() if k != "transport"},
        ),
    )

    r = client.post(
        "/report", json={"title": "Bug", "body": "Body text", "labels": ["force-app"]}
    )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["url"] == "https://github.com/x/y/issues/1"
    assert data["number"] == 1


def test_report_surfaces_github_rejection(client, monkeypatch):
    monkeypatch.setattr(srv, "configured", lambda: True)

    async def fake_get_token(self):
        return "installation-token"

    monkeypatch.setattr(srv._TokenCache, "get", fake_get_token)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"message": "Validation failed"})

    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(
            transport=httpx.MockTransport(handler),
            **{k: v for k, v in kw.items() if k != "transport"},
        ),
    )

    r = client.post("/report", json={"title": "Bug", "body": "Body text"})
    data = r.json()
    assert data["ok"] is False
    assert "422" in data["reason"]
    assert "Validation failed" in data["reason"]


def test_issues_fails_closed_when_not_configured(client, monkeypatch):
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    r = client.get("/issues")
    data = r.json()
    assert data["ok"] is False
    assert "not configured" in data["reason"]


def test_issues_lists_and_strips_pull_requests(client, monkeypatch):
    monkeypatch.setattr(srv, "configured", lambda: True)

    async def fake_get_token(self):
        return "installation-token"

    monkeypatch.setattr(srv._TokenCache, "get", fake_get_token)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer installation-token"
        assert request.url.params["labels"] == "in-app-report"
        return httpx.Response(
            200,
            json=[
                {
                    "number": 5,
                    "title": "[Bug] plot lags",
                    "html_url": "https://github.com/x/y/issues/5",
                    "state": "open",
                    "labels": [{"name": "bug"}, {"name": "in-app-report"}],
                    "created_at": "2026-09-14T00:00:00Z",
                },
                {
                    "number": 6,
                    "title": "an actual PR, not a report",
                    "pull_request": {"url": "https://api.github.com/x"},
                    "state": "open",
                    "labels": [],
                },
            ],
        )

    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(
            transport=httpx.MockTransport(handler),
            **{k: v for k, v in kw.items() if k != "transport"},
        ),
    )

    r = client.get("/issues")
    data = r.json()
    assert data["ok"] is True
    assert len(data["issues"]) == 1
    assert data["issues"][0]["number"] == 5
    assert data["issues"][0]["labels"] == ["bug", "in-app-report"]


def test_issues_surfaces_github_rejection(client, monkeypatch):
    monkeypatch.setattr(srv, "configured", lambda: True)

    async def fake_get_token(self):
        return "installation-token"

    monkeypatch.setattr(srv._TokenCache, "get", fake_get_token)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "rate limited"})

    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(
            transport=httpx.MockTransport(handler),
            **{k: v for k, v in kw.items() if k != "transport"},
        ),
    )

    r = client.get("/issues")
    data = r.json()
    assert data["ok"] is False
    assert "403" in data["reason"]
    assert "rate limited" in data["reason"]


def _patch_transport(monkeypatch, handler):
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_async_client(
            transport=httpx.MockTransport(handler),
            **{k: v for k, v in kw.items() if k != "transport"},
        ),
    )


def _configure(monkeypatch):
    monkeypatch.setenv("GITHUB_APP_ID", "1")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "2")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "unused")
    monkeypatch.setattr(srv, "_mint_jwt", lambda: "jwt")


def test_token_expiry_is_read_as_utc_whatever_the_host_timezone(client, monkeypatch):
    """Review 1.10: time.mktime read GitHub's UTC expires_at as local time, so on a host east or
    west of UTC the cached token was kept for the wrong length of time."""
    import calendar
    import time

    _configure(monkeypatch)
    _patch_transport(
        monkeypatch,
        lambda req: httpx.Response(
            201, json={"token": "t1", "expires_at": "2030-01-01T00:00:00Z"}
        ),
    )
    expected = calendar.timegm((2030, 1, 1, 0, 0, 0))
    monkeypatch.setenv("TZ", "Asia/Tokyo")  # UTC+9
    time.tzset()
    try:
        import asyncio

        asyncio.run(srv._token_cache.get())
        assert srv._token_cache.expires_at == expected
    finally:
        monkeypatch.undo()
        time.tzset()


def test_a_401_clears_the_token_cache_and_retries_once(client, monkeypatch):
    _configure(monkeypatch)
    minted = []
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/access_tokens"):
            minted.append(1)
            return httpx.Response(
                201,
                json={
                    "token": f"tok{len(minted)}",
                    "expires_at": "2099-01-01T00:00:00Z",
                },
            )
        seen.append(request.headers["Authorization"])
        if request.headers["Authorization"] == "Bearer tok1":
            return httpx.Response(401, json={"message": "Bad credentials"})
        return httpx.Response(
            201, json={"html_url": "https://github.com/x/y/issues/9", "number": 9}
        )

    _patch_transport(monkeypatch, handler)
    r = client.post("/report", json={"title": "Bug", "body": "b"})
    assert r.json() == {
        "ok": True,
        "url": "https://github.com/x/y/issues/9",
        "number": 9,
    }
    assert seen == ["Bearer tok1", "Bearer tok2"]
    assert len(minted) == 2
    assert srv._token_cache.token == "tok2"


def test_a_persistent_401_is_retried_only_once(client, monkeypatch):
    _configure(monkeypatch)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/access_tokens"):
            return httpx.Response(
                201, json={"token": "t", "expires_at": "2099-01-01T00:00:00Z"}
            )
        calls.append(1)
        return httpx.Response(401, json={"message": "Bad credentials"})

    _patch_transport(monkeypatch, handler)
    r = client.post("/report", json={"title": "Bug", "body": "b"})
    assert r.json()["ok"] is False and "401" in r.json()["reason"]
    assert len(calls) == 2


def test_issues_also_retries_a_401(client, monkeypatch):
    _configure(monkeypatch)
    n = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/access_tokens"):
            n.append(1)
            return httpx.Response(
                201,
                json={"token": f"tok{len(n)}", "expires_at": "2099-01-01T00:00:00Z"},
            )
        if request.headers["Authorization"] == "Bearer tok1":
            return httpx.Response(401, json={"message": "Bad credentials"})
        return httpx.Response(200, json=[])

    _patch_transport(monkeypatch, handler)
    assert client.get("/issues").json() == {"ok": True, "issues": []}


def test_a_token_exchange_failure_is_reported_as_an_authentication_failure(
    client, monkeypatch
):
    _configure(monkeypatch)
    _patch_transport(monkeypatch, lambda req: httpx.Response(500, json={}))
    r = client.post("/report", json={"title": "Bug", "body": "b"})
    assert r.json()["ok"] is False
    assert "could not authenticate" in r.json()["reason"]


def test_overlong_title_is_a_422(client):
    r = client.post("/report", json={"title": "x" * 1001, "body": "b"})
    assert r.status_code == 422
