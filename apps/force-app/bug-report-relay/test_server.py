"""Tests for the bug-report relay: config gating, token caching, issue creation, rig tests."""

import asyncio
import json
import logging
from urllib.parse import unquote

import httpx
import pytest
import server as srv
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _reset_cache():
    srv._token_cache.token = ""
    srv._token_cache.expires_at = 0.0
    yield


D1_TOKEN = "d1-access-token"
USER = {"id": "d1-user-1", "email": "op@example.ac.uk"}


@pytest.fixture
def client():
    # A signed-in operator's D1 token on every call; tests of the sign-in build their own client.
    return TestClient(srv.app, headers={"Authorization": f"Bearer {D1_TOKEN}"})


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


def test_report_follows_a_renamed_repo_redirect(client, monkeypatch):
    """#223: after the repo was renamed, GitHub answers POST /repos/<old>/issues with a 307 to
    /repositories/<id>/issues. The report has to land there, still as the App, not fail."""
    monkeypatch.setattr(srv, "configured", lambda: True)

    async def fake_get_token(self):
        return "installation-token"

    monkeypatch.setattr(srv._TokenCache, "get", fake_get_token)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content))
        if request.url.path.startswith("/repos/"):
            return httpx.Response(
                307,
                headers={"Location": "https://api.github.com/repositories/42/issues"},
                json={"message": "Moved Permanently"},
            )
        assert request.headers["Authorization"] == "Bearer installation-token"
        return httpx.Response(
            201, json={"html_url": "https://github.com/x/new/issues/7", "number": 7}
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

    r = client.post("/report", json={"title": "Bug", "body": "Body text"})
    assert r.json() == {
        "ok": True,
        "url": "https://github.com/x/new/issues/7",
        "number": 7,
    }
    assert [(m, p) for m, p, _ in seen] == [
        ("POST", f"/repos/{srv._repo()}/issues"),
        ("POST", "/repositories/42/issues"),
    ]
    assert seen[0][2] == seen[1][2]


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


# ---- rig test requests (ADR-0012) -------------------------------------------------------------


class FakeDirectus:
    """Stands in for Directus /users/me: token -> user; any other token is refused."""

    def __init__(self):
        self.users = {D1_TOKEN: USER}
        self.down = False
        self.calls = 0

    async def __call__(self, token):
        self.calls += 1
        if self.down:
            raise srv._D1Unavailable
        return self.users.get(token)


class FakeGitHub:
    """Just enough of the GitHub REST API for the rig-test endpoints. `calls` records every
    (method, path) so tests can assert what was NOT touched."""

    def __init__(self):
        self.issues = {}  # n -> issue dict
        self.events = {}  # n -> [event dicts, oldest first]
        self.comments = {}  # id -> comment dict
        self.fail_with = None  # status code for every API call
        self.created_labels = []
        self.calls = []
        self.hook = None  # request -> Response | None, tried before the routes

    def issue(
        self,
        n,
        labels=("rig-test-request",),
        state="open",
        labeller="Maintainer",
        author="Maintainer",
        **kw,
    ):
        self.issues[n] = {
            "number": n,
            "user": {"login": author},
            "title": f"Rig test {n}",
            "body": "```rig-test\nitems: [R4]\n```",
            "html_url": f"https://github.com/x/y/issues/{n}",
            "state": state,
            "labels": [{"name": name} for name in labels],
            "created_at": "2026-10-11T10:00:00Z",
            **kw,
        }
        self.events[n] = [labeled(labeller)] if labeller else []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if path.endswith("/access_tokens"):
            return httpx.Response(
                201, json={"token": "t", "expires_at": "2099-01-01T00:00:00Z"}
            )
        self.calls.append((method, path))
        if self.hook and (res := self.hook(request)) is not None:
            return res
        if self.fail_with:
            return httpx.Response(self.fail_with, json={"message": "boom"})
        parts = path.removeprefix(f"/repos/{srv._repo()}").strip("/").split("/")
        if parts == ["issues"] and method == "GET":
            wanted = request.url.params["labels"]
            return httpx.Response(
                200,
                json=[
                    i
                    for i in self.issues.values()
                    if i["state"] == "open"
                    and wanted in [lb["name"] for lb in i["labels"]]
                ],
            )
        if parts[0] == "issues" and parts[1] == "comments":
            c = self.comments.get(int(parts[2]))
            if c is None:
                return httpx.Response(404, json={"message": "Not Found"})
            if method == "PATCH":
                c["body"] = json.loads(request.content)["body"]
            return httpx.Response(200, json=c)
        if parts[0] == "issues":
            n = int(parts[1])
            issue = self.issues.get(n)
            if issue is None:
                return httpx.Response(404, json={"message": "Not Found"})
            tail = parts[2:]
            if tail == [] and method == "GET":
                return httpx.Response(200, json=issue)
            if tail == ["events"]:
                page = int(request.url.params.get("page", 1))
                events = self.events[n]
                if events is None:
                    return httpx.Response(200, json=None)
                # Like GitHub: a Link header with rel="last" whenever there is more than a page.
                last = max(1, -(-len(events) // 100))
                headers = {}
                if last > 1:
                    base = f"https://api.github.com{path}?per_page=100"
                    headers["Link"] = (
                        f'<{base}&page={page + 1}>; rel="next", <{base}&page={last}>; rel="last"'
                    )
                return httpx.Response(
                    200, json=events[(page - 1) * 100 : page * 100], headers=headers
                )
            if tail == ["comments"] and method == "POST":
                cid = 1000 + len(self.comments)
                self.comments[cid] = bot_comment(
                    cid, n, json.loads(request.content)["body"]
                )
                return httpx.Response(201, json=self.comments[cid])
            if tail == ["labels"] and method == "POST":
                for name in json.loads(request.content)["labels"]:
                    issue["labels"].append({"name": name})
                return httpx.Response(200, json=issue["labels"])
            if tail[:1] == ["labels"] and method == "DELETE":
                name = unquote(tail[1])
                issue["labels"] = [lb for lb in issue["labels"] if lb["name"] != name]
                return httpx.Response(200, json=issue["labels"])
        if parts == ["labels"] and method == "POST":
            name = json.loads(request.content)["name"]
            if name in self.created_labels:
                return httpx.Response(422, json={"message": "already_exists"})
            self.created_labels.append(name)
            return httpx.Response(201, json={"name": name})
        return httpx.Response(500, json={"message": f"unexpected {method} {path}"})


def labeled(login, label="rig-test-request"):
    return {
        "event": "labeled",
        "label": {"name": label},
        "actor": {"login": login} if login else None,
    }


def bot_comment(cid, n, body, **overrides):
    return {
        "id": cid,
        "body": body,
        "issue_url": f"https://api.github.com/repos/x/y/issues/{n}",
        "user": {"login": "d1-bug-reporter[bot]", "type": "Bot"},
        "performed_via_github_app": {"id": 1, "slug": "d1-bug-reporter"},
        **overrides,
    }


@pytest.fixture
def gh(monkeypatch):
    _configure(monkeypatch)
    monkeypatch.setenv("RIG_TEST_ALLOWED_LOGINS", "maintainer, Other-Admin")
    monkeypatch.delenv("RIG_TEST_RELAY_TOKEN", raising=False)
    srv._d1_cache.clear()
    fake_d1 = FakeDirectus()
    monkeypatch.setattr(srv, "_directus_me", fake_d1)
    srv._list_cache.update(key=None, expires=0.0, requests=[])
    srv._bot_login.clear()
    fake = FakeGitHub()
    fake.d1 = fake_d1
    _patch_transport(monkeypatch, fake)
    return fake


def _all_rig_endpoints(client):
    return [
        client.get("/rig-tests"),
        client.post("/rig-tests/5/comment", json={"body": "hi"}),
        client.patch("/rig-tests/5/comment/9", json={"body": "hi"}),
        client.post("/rig-tests/5/state", json={"state": "done"}),
    ]


def test_rig_tests_fail_closed_without_an_allowlist(client, gh, monkeypatch):
    monkeypatch.setenv("RIG_TEST_ALLOWED_LOGINS", " , ")
    gh.issue(5)
    for r in _all_rig_endpoints(client):
        assert r.status_code == 200
        assert r.json() == {"ok": False, "reason": "rig tests not configured"}
    assert gh.calls == []
    assert gh.d1.calls == 0  # config is checked before Directus is asked


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Bearer "},
        {"Authorization": "Basic abc"},
        {"Authorization": "Bearer not-a-d1-token"},
        {"X-Rig-Token": "rig-secret-token"},  # the old shared token is gone
    ],
)
def test_every_rig_endpoint_rejects_a_missing_or_refused_sign_in(gh, headers):
    """A tailnet host without a D1 sign-in can neither read nor write: forging a result comment
    is the case that matters."""
    gh.issue(5)
    gh.comments[9] = bot_comment(9, 5, "progress")
    c = TestClient(srv.app)
    forged = '<!-- rig-test-result {"items":[]} -->'
    for r in (
        c.get("/rig-tests", headers=headers),
        c.post("/rig-tests/5/comment", json={"body": forged}, headers=headers),
        c.patch("/rig-tests/5/comment/9", json={"body": "forged"}, headers=headers),
        c.post("/rig-tests/5/state", json={"state": "done"}, headers=headers),
    ):
        assert r.status_code == 403
        assert r.json() == {"ok": False, "reason": "D1 sign-in rejected"}
    assert gh.calls == []
    assert gh.comments[9]["body"] == "progress"


@pytest.mark.parametrize(
    "token",
    ["café".encode("latin-1"), b"\xff\xfe", b"a" * 4097, b"has\ttab"],
    ids=["non-ascii", "high-bytes", "over-long", "control-char"],
)
def test_a_bearer_that_is_not_a_plausible_token_is_refused_before_directus(gh, token):
    """Starlette decodes headers as latin-1; httpx would raise on a non-ASCII value, so such a
    token must be a plain 403 and never reach Directus (nor a traceback)."""
    gh.issue(5)
    c = TestClient(srv.app)
    headers = {"Authorization": b"Bearer " + token}
    for r in (
        c.get("/rig-tests", headers=headers),
        c.post("/rig-tests/5/comment", json={"body": "hi"}, headers=headers),
        c.patch("/rig-tests/5/comment/9", json={"body": "hi"}, headers=headers),
        c.post("/rig-tests/5/state", json={"state": "done"}, headers=headers),
    ):
        assert r.status_code == 403
        assert r.json() == {"ok": False, "reason": "D1 sign-in rejected"}
    assert gh.d1.calls == 0
    assert gh.calls == []


def test_a_signed_in_operator_is_accepted_and_logged_without_the_token(gh, caplog):
    gh.issue(5)
    with caplog.at_level(logging.INFO, logger="bug-report-relay"):
        r = TestClient(srv.app).get(
            "/rig-tests", headers={"Authorization": f"Bearer {D1_TOKEN}"}
        )
    assert r.status_code == 200 and r.json()["ok"] is True
    assert "d1-user-1" in caplog.text and "op@example.ac.uk" in caplog.text
    assert D1_TOKEN not in caplog.text


def test_an_accepted_sign_in_is_cached_for_60_s(client, gh, monkeypatch):
    gh.issue(5)
    clock = [1000.0]
    monkeypatch.setattr(
        srv, "_now", lambda: clock[0]
    )  # not time.monotonic: the event loop uses it
    client.get("/rig-tests")
    client.get("/rig-tests")
    assert gh.d1.calls == 1
    clock[0] += 61
    client.get("/rig-tests")
    assert gh.d1.calls == 2


def test_a_refused_sign_in_is_not_cached(gh):
    gh.issue(5)
    c = TestClient(srv.app, headers={"Authorization": "Bearer later-valid"})
    assert c.get("/rig-tests").status_code == 403
    gh.d1.users["later-valid"] = USER
    assert c.get("/rig-tests").status_code == 200


def test_the_sign_in_cache_is_bounded(gh):
    for i in range(300):
        gh.d1.users[f"t{i}"] = USER
        asyncio.run(srv._d1_user(f"t{i}"))
    assert len(srv._d1_cache) <= 256
    assert all("t" not in k for k in srv._d1_cache)  # keys are hashes, never the token


def test_directus_down_is_503_and_nothing_reaches_github(client, gh):
    gh.issue(5)
    gh.d1.down = True
    for r in _all_rig_endpoints(client):
        assert r.status_code == 503
        assert r.json() == {"ok": False, "reason": "D1 unavailable"}
    assert gh.calls == []


def test_directus_me_asks_users_me_with_the_bearer(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"data": USER})

    _patch_transport(monkeypatch, handler)
    monkeypatch.setenv("DIRECTUS_INTERNAL_URL", "http://d1.test:8055/")
    assert asyncio.run(srv._directus_me(D1_TOKEN)) == USER
    (req,) = seen
    assert str(req.url).startswith("http://d1.test:8055/users/me?")
    assert req.url.params["fields"] == "id,email"
    assert req.headers["Authorization"] == f"Bearer {D1_TOKEN}"


def test_directus_me_defaults_to_the_compose_service(monkeypatch):
    seen = []
    _patch_transport(
        monkeypatch,
        lambda r: seen.append(r) or httpx.Response(200, json={"data": USER}),
    )
    monkeypatch.delenv("DIRECTUS_INTERNAL_URL", raising=False)
    asyncio.run(srv._directus_me(D1_TOKEN))
    assert str(seen[0].url).startswith("http://directus:8055/users/me")


@pytest.mark.parametrize(
    "status,body",
    [
        (401, {"errors": []}),
        (403, {"errors": []}),
        (200, {"data": {}}),
        (200, {"data": None}),
        (200, []),
    ],
)
def test_directus_me_refusals_are_none(monkeypatch, status, body):
    _patch_transport(monkeypatch, lambda r: httpx.Response(status, json=body))
    assert asyncio.run(srv._directus_me(D1_TOKEN)) is None


def _connect_error(request):
    raise httpx.ConnectError("down", request=request)


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(500, json={}),
        lambda r: httpx.Response(502, text="bad gateway"),
        lambda r: httpx.Response(200, text="not json"),
        _connect_error,
    ],
)
def test_directus_me_failures_raise_unavailable(monkeypatch, handler):
    _patch_transport(monkeypatch, handler)
    with pytest.raises(srv._D1Unavailable):
        asyncio.run(srv._directus_me(D1_TOKEN))


def test_rig_tests_fail_closed_without_the_github_app(client, gh, monkeypatch):
    monkeypatch.delenv("GITHUB_APP_ID")
    for r in _all_rig_endpoints(client):
        assert r.json() == {"ok": False, "reason": "rig tests not configured"}
    assert gh.calls == []
    assert gh.d1.calls == 0  # config is checked before Directus is asked


def test_list_returns_requests_from_allowlisted_labellers(client, gh):
    gh.issue(5, labels=("rig-test-request", "rig-test:deferred", "bug"))
    gh.issue(6, labeller="Other-Admin")  # case-insensitive both ways
    data = client.get("/rig-tests").json()
    assert data["ok"] is True
    by_n = {r["number"]: r for r in data["requests"]}
    assert set(by_n) == {5, 6}
    assert by_n[5] == {
        "number": 5,
        "title": "Rig test 5",
        "body": "```rig-test\nitems: [R4]\n```",
        "url": "https://github.com/x/y/issues/5",
        "requested_by": "Maintainer",
        "created_at": "2026-10-11T10:00:00Z",
        "state_label": "deferred",
    }
    assert by_n[6]["state_label"] is None
    assert by_n[6]["requested_by"] == "Other-Admin"


def test_list_excludes_a_stranger_pull_requests_and_closed_issues(client, gh):
    gh.issue(5, labeller="stranger")
    gh.issue(6, pull_request={"url": "x"})
    gh.issue(7, state="closed")
    gh.issue(8, labeller=None)  # no labeled event at all
    gh.issue(9, labeller=None)
    gh.events[9] = [labeled(None)]  # actor deleted: GitHub gives a null actor
    gh.issue(10)
    assert [r["number"] for r in client.get("/rig-tests").json()["requests"]] == [10]


def test_list_requires_the_issue_author_to_be_allowlisted_too(client, gh):
    """An allowlisted login labels an issue a stranger wrote: the stranger can edit the block
    afterwards, so it is not a request (12)."""
    gh.issue(5, author="stranger")  # labelled by the maintainer, written by a stranger
    gh.issue(6, author="Other-Admin")  # both allowlisted, any case
    gh.issue(7, author=None, user=None)  # a deleted account: GitHub gives user=null
    gh.issue(8, labeller="stranger", author="maintainer")  # the other direction
    gh.issue(9, author="maintainer")
    assert [r["number"] for r in client.get("/rig-tests").json()["requests"]] == [6, 9]
    # the stranger-authored issues did not cost an events call
    assert not any(p.endswith("/issues/5/events") for _, p in gh.calls)


def test_list_the_most_recent_labeller_wins(client, gh):
    # allowlisted applies, label removed, a stranger re-applies: excluded.
    gh.issue(5)
    gh.events[5] = [labeled("maintainer"), {"event": "unlabeled"}, labeled("stranger")]
    # a stranger applied first, the maintainer re-applied: listed.
    gh.issue(6)
    gh.events[6] = [labeled("stranger"), {"event": "unlabeled"}, labeled("maintainer")]
    # other labels by strangers don't count.
    gh.issue(7)
    gh.events[7] = [labeled("maintainer"), labeled("stranger", label="bug")]
    assert [r["number"] for r in client.get("/rig-tests").json()["requests"]] == [6, 7]


def test_list_reads_every_page_of_events(client, gh):
    gh.issue(5)
    noise = [{"event": "commented"}] * 150
    gh.events[5] = [labeled("maintainer")] + noise + [labeled("stranger")]
    assert client.get("/rig-tests").json() == {"ok": True, "requests": []}
    gh.calls.clear()
    srv._list_cache["expires"] = 0.0
    gh.events[5] = [labeled("stranger")] + noise + [labeled("maintainer")]
    assert [r["number"] for r in client.get("/rig-tests").json()["requests"]] == [5]
    assert sum(p.endswith("/events") for _, p in gh.calls) == 2


def test_list_is_cached_for_30_seconds(client, gh):
    gh.issue(5)
    assert len(client.get("/rig-tests").json()["requests"]) == 1
    gh.calls.clear()
    assert len(client.get("/rig-tests").json()["requests"]) == 1
    assert gh.calls == []
    srv._list_cache["expires"] = 0.0
    client.get("/rig-tests")
    assert gh.calls != []


def test_list_cache_does_not_outlive_an_allowlist_change(client, gh, monkeypatch):
    gh.issue(5)
    assert len(client.get("/rig-tests").json()["requests"]) == 1
    monkeypatch.setenv("RIG_TEST_ALLOWED_LOGINS", "someone-else")
    assert client.get("/rig-tests").json() == {"ok": True, "requests": []}


def test_list_github_5xx_is_ok_false_and_not_cached(client, gh):
    gh.issue(5)
    gh.fail_with = 502
    data = client.get("/rig-tests").json()
    assert data["ok"] is False and "502" in data["reason"]
    gh.fail_with = None
    assert len(client.get("/rig-tests").json()["requests"]) == 1


def test_list_unexpected_payload_never_500s(client, gh):
    gh.issue(5)
    gh.events[5] = None  # json null instead of a list
    r = client.get("/rig-tests")
    assert r.status_code == 200 and r.json() == {"ok": True, "requests": []}
    # a write to that issue is refused with a reason, not a 500
    r = client.post("/rig-tests/5/comment", json={"body": "x"})
    assert r.status_code == 200 and r.json()["ok"] is False


def test_one_unverifiable_issue_does_not_hide_the_others(client, gh):
    """L2: an issue with too many events (or any error verifying it) is skipped and logged."""
    gh.issue(5)
    gh.events[5] = [{"event": "commented"}] * (100 * srv._EVENT_PAGES_MAX + 1)
    gh.issue(6)
    gh.issue(7)
    gh.events[7] = None
    gh.issue(8)
    assert [r["number"] for r in client.get("/rig-tests").json()["requests"]] == [6, 8]
    # the same issue still fails closed on a write
    r = client.post("/rig-tests/5/comment", json={"body": "x"})
    assert r.json()["ok"] is False and "too many events" in r.json()["reason"]


def test_the_latest_label_event_is_found_from_the_last_page(client, gh):
    """L2: a long thread costs two calls (page 1 for the Link header, then the last page), not
    every page."""
    gh.issue(5)
    noise = [{"event": "commented"}] * 450
    gh.events[5] = [labeled("stranger")] + noise + [labeled("maintainer")]
    assert [r["number"] for r in client.get("/rig-tests").json()["requests"]] == [5]
    assert sum(p.endswith("/events") for _, p in gh.calls) == 2


def test_the_walk_goes_backwards_to_an_older_page_and_is_bounded(client, gh):
    gh.issue(5)
    # label on page 1 only, 3 pages in all: pages 3, 2 are read (and page 1 reused)
    gh.events[5] = [labeled("maintainer")] + [{"event": "commented"}] * 250
    assert len(client.get("/rig-tests").json()["requests"]) == 1
    assert sum(p.endswith("/events") for _, p in gh.calls) == 3
    # more pages than the cap, label only at the very start: fail closed, bounded reads
    gh.calls.clear()
    srv._list_cache["expires"] = 0.0
    gh.events[5] = [labeled("maintainer")] + [{"event": "commented"}] * (
        100 * srv._EVENT_PAGES_MAX + 50
    )
    assert client.get("/rig-tests").json() == {"ok": True, "requests": []}
    assert sum(p.endswith("/events") for _, p in gh.calls) == srv._EVENT_PAGES_MAX + 1


def test_comment_posts_to_a_rig_test_issue(client, gh):
    gh.issue(5)
    r = client.post("/rig-tests/5/comment", json={"body": "accepted"})
    assert r.json() == {"ok": True, "id": 1000}
    assert gh.comments[1000]["body"] == "accepted"


@pytest.mark.parametrize(
    "setup",
    [
        {"state": "closed"},
        {"labels": ("bug",)},
        {"labeller": "stranger"},
        {"author": "stranger"},
        {"user": None},
        {"pull_request": {"url": "x"}},
    ],
    ids=[
        "closed",
        "unlabelled",
        "stranger-labelled",
        "stranger-authored",
        "no-author",
        "pull-request",
    ],
)
def test_writes_are_refused_unless_the_issue_is_an_open_rig_test_request(
    client, gh, setup
):
    gh.issue(5, **setup)
    gh.comments[9] = bot_comment(9, 5, "progress")
    for r in (
        client.post("/rig-tests/5/comment", json={"body": "x"}),
        client.patch("/rig-tests/5/comment/9", json={"body": "x"}),
        client.post("/rig-tests/5/state", json={"state": "done"}),
    ):
        assert r.json() == {
            "ok": False,
            "reason": "issue #5 is not an open rig-test request",
        }
    assert gh.comments[9]["body"] == "progress"
    assert [(m, p) for m, p in gh.calls if m != "GET"] == []


def test_write_to_a_missing_issue_is_refused(client, gh):
    r = client.post("/rig-tests/99/comment", json={"body": "x"})
    assert r.json() == {
        "ok": False,
        "reason": "issue #99 is not an open rig-test request",
    }


def test_comment_body_is_bounded(client, gh):
    gh.issue(5)
    assert (
        client.post("/rig-tests/5/comment", json={"body": "x" * 60_001}).status_code
        == 422
    )
    assert (
        client.post("/rig-tests/5/comment", json={"body": "x" * 60_000}).json()["ok"]
        is True
    )


def test_patch_edits_the_apps_own_comment(client, gh):
    gh.issue(5)
    gh.comments[9] = bot_comment(9, 5, "progress")
    r = client.patch("/rig-tests/5/comment/9", json={"body": "step 2"})
    assert r.json() == {"ok": True, "id": 9}
    assert gh.comments[9]["body"] == "step 2"


def test_patch_refuses_a_comment_that_holds_a_result(client, gh):
    """The rig only edits its progress comment; the result marker is write-once (M1)."""
    gh.issue(5)
    body = 'Result\n<!-- rig-test-result {"items":[{"id":"R4","status":"pass"}]} -->'
    gh.comments[9] = bot_comment(9, 5, body)
    r = client.patch("/rig-tests/5/comment/9", json={"body": "forged"})
    assert r.json()["ok"] is False
    assert gh.comments[9]["body"] == body
    assert [(m, p) for m, p in gh.calls if m == "PATCH"] == []


def test_patch_refuses_a_humans_comment(client, gh):
    gh.issue(5)
    gh.comments[9] = bot_comment(
        9,
        5,
        "mine",
        user={"login": "maintainer", "type": "User"},
        performed_via_github_app=None,
    )
    r = client.patch("/rig-tests/5/comment/9", json={"body": "hijacked"})
    assert r.json()["ok"] is False
    assert gh.comments[9]["body"] == "mine"


def test_patch_refuses_another_apps_bot_comment(client, gh):
    gh.issue(5)
    gh.comments[9] = bot_comment(
        9,
        5,
        "dependabot says",
        user={"login": "dependabot[bot]", "type": "Bot"},
        performed_via_github_app={"id": 777},
    )
    assert (
        client.patch("/rig-tests/5/comment/9", json={"body": "x"}).json()["ok"] is False
    )
    assert gh.comments[9]["body"] == "dependabot says"


def test_patch_refuses_a_comment_that_belongs_to_another_issue(client, gh):
    gh.issue(5)
    gh.issue(6, labels=("bug",))
    gh.comments[9] = bot_comment(9, 6, "elsewhere")
    assert (
        client.patch("/rig-tests/5/comment/9", json={"body": "x"}).json()["ok"] is False
    )
    assert gh.comments[9]["body"] == "elsewhere"


def test_patch_falls_back_to_the_app_slug_when_github_omits_performed_via(client, gh):
    gh.issue(5)
    ours = bot_comment(9, 5, "progress", performed_via_github_app=None)
    other = bot_comment(
        10,
        5,
        "not ours",
        performed_via_github_app=None,
        user={"login": "other-app[bot]", "type": "Bot"},
    )
    gh.comments.update({9: ours, 10: other})

    gh.hook = lambda request: (
        httpx.Response(200, json={"slug": "D1-Bug-Reporter", "id": 1})
        if request.url.path == "/app"
        else None
    )
    assert (
        client.patch("/rig-tests/5/comment/9", json={"body": "edited"}).json()["ok"]
        is True
    )
    assert (
        client.patch("/rig-tests/5/comment/10", json={"body": "edited"}).json()["ok"]
        is False
    )
    assert ours["body"] == "edited" and other["body"] == "not ours"


def test_state_swaps_the_rig_test_label_and_keeps_other_labels(client, gh):
    gh.issue(
        5, labels=("rig-test-request", "rig-test:deferred", "bug", "rig-test:running")
    )
    r = client.post("/rig-tests/5/state", json={"state": "done"})
    assert r.json() == {"ok": True, "state": "done"}
    assert [lb["name"] for lb in gh.issues[5]["labels"]] == [
        "rig-test-request",
        "bug",
        "rig-test:done",
    ]
    assert gh.created_labels == ["rig-test:done"]


def test_state_tolerates_an_existing_label_and_is_idempotent(client, gh):
    gh.issue(5, labels=("rig-test-request", "rig-test:done"))
    gh.created_labels.append("rig-test:partial")  # exists in the repo, not on the issue
    assert (
        client.post("/rig-tests/5/state", json={"state": "partial"}).json()["ok"]
        is True
    )
    assert (
        client.post("/rig-tests/5/state", json={"state": "partial"}).json()["ok"]
        is True
    )
    assert sorted(lb["name"] for lb in gh.issues[5]["labels"]) == [
        "rig-test-request",
        "rig-test:partial",
    ]


def test_state_rejects_an_unknown_state(client, gh):
    gh.issue(5)
    assert client.post("/rig-tests/5/state", json={"state": "bogus"}).status_code == 422
    assert (
        client.post("/rig-tests/5/state", json={"state": "rig-test:done"}).status_code
        == 422
    )


def test_state_change_drops_the_cached_list(client, gh):
    gh.issue(5)
    assert client.get("/rig-tests").json()["requests"][0]["state_label"] is None
    client.post("/rig-tests/5/state", json={"state": "deferred"})
    assert client.get("/rig-tests").json()["requests"][0]["state_label"] == "deferred"


def test_writes_report_github_5xx_as_ok_false(client, gh):
    gh.issue(5)
    gh.fail_with = 503
    for r in (
        client.post("/rig-tests/5/comment", json={"body": "x"}),
        client.patch("/rig-tests/5/comment/9", json={"body": "x"}),
        client.post("/rig-tests/5/state", json={"state": "done"}),
    ):
        assert r.status_code == 200
        assert r.json()["ok"] is False and "503" in r.json()["reason"]


def test_a_network_failure_after_the_gate_is_ok_false_not_a_500(client, gh):
    gh.issue(5)

    def drop_connection(request):
        if request.method == "POST" and request.url.path.endswith("/comments"):
            raise httpx.ConnectError("connection reset")

    gh.hook = drop_connection
    r = client.post("/rig-tests/5/comment", json={"body": "x"})
    assert r.status_code == 200
    assert r.json()["ok"] is False and "could not reach GitHub" in r.json()["reason"]
