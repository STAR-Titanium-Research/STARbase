# Rig tests: D1 sign-in instead of a shared token, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared rig token (`X-Rig-Token` / `RIG_TEST_RELAY_TOKEN` / `FORCE_APP_RIG_TEST_TOKEN`) with the signed-in operator's D1 (Directus) access token, so any laptop plugged into the rig works with no per-machine setup.

**Architecture:** The web app lends its current D1 access token to the local recorder backend (`PUT /rig-tests/session`), which keeps it in memory only and sends it to the relay as `Authorization: Bearer`. The relay checks it with Directus `GET /users/me` (cached 60 s) and logs the D1 user. Everything GitHub-side is unchanged.

**Tech Stack:** Relay: FastAPI + httpx (Python 3.12, Docker). Backend: FastAPI + httpx (Python, PyInstaller). Web: Vue 3 + TypeScript, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-rig-test-d1-login-design.md` (read it first). Decision record: `docs/adr/0012-rig-test-requests-over-github-issues.md` decision 2 (amended).

## Global Constraints

- Work in the worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\rig-test-d1-login`, branch `feat/rig-test-d1-login` (draft PR #248). All paths below are relative to it.
- Backend Python: `$PY = "D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\apps\force-app\backend\.venv\Scripts\python.exe"`; run tests from `apps/force-app/backend` with `& $PY -m pytest ...`.
- Relay tests need `pyjwt`, which that venv lacks. Run them in Docker from `apps/force-app/bug-report-relay`:
  `docker run --rm -v "${PWD}:/app" -w /app python:3.12-slim sh -c "pip install -q -r requirements.txt && python -m pytest -q test_server.py"`
- Web: run `npm ci` once at the worktree root (npm workspaces). Then from `apps/force-app/web`: `npx vitest run <file>`, `npm run typecheck`, `npm run lint:theme`.
- Relay reason strings, verbatim: `D1 sign-in rejected` (HTTP 403), `D1 unavailable` (HTTP 503), `rig tests not configured` (HTTP 200, unchanged).
- Backend signed-out reason, verbatim: `Sign in to D1 online to receive rig-test requests`.
- Directus lookup: `GET {DIRECTUS_INTERNAL_URL}/users/me?fields=id,email`, timeout 5 s, `DIRECTUS_INTERNAL_URL` default `http://directus:8055`.
- Relay cache: accepted users only, 60 s, keyed by SHA-256 of the token, at most 256 entries.
- The token must never appear in a response body, a log line or an exception text, on backend or relay.
- Backend session token: printable ASCII (`\x21`–`\x7e`), 1–4096 chars; `expires_at` is epoch **milliseconds**.
- Web refreshes the D1 token early when it expires within `REFRESH_AHEAD_MS = 90_000`, only while the recorder reports `hardware_ok === true`.
- Indentation and style follow each file: Python 4 spaces, ruff-clean; web files use tabs.
- Commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push with `git push`.

## Review Focus

1. **Directus down during a run's result upload:** the relay answers 503; the backend must classify it `kind: "unreachable"` so `flush_outbox` waits instead of counting a refusal and dropping the result after 5 tries. Pinned in Task 2 (`test_d1_unavailable_is_unreachable_so_the_outbox_keeps_the_result`).
2. **Token refreshed while a relay call is in flight, and that call is refused:** the backend must clear the session only if it still holds the refused token, never the newer one. Pinned in Task 2 (`test_a_rejection_does_not_clear_a_newer_token`).
3. **Office laptop (no rig hardware) left signed in for hours:** the access token expires in the backend; the web must not re-send an expired token every 30 s. Pinned in Task 5 (`does not send an expired token`).
4. **The relay rejects a sign-in and keeps rejecting it:** the web refreshes and re-sends once, then stops (no loop every poll). Pinned in Task 5 (`retries a rejected sign-in once, then stops`).
5. **Sign-out while the shell unmounts:** the backend must not keep the last operator's token. Pinned in Task 5 (`stop() releases the session when signed out`).

**Known, out of scope:** `authStore` doesn't listen for `storage` events, so a pop-out window keeps the refresh token it loaded. Directus rotates the refresh token on every refresh, so after the main window refreshes, a pop-out's own refresh is refused and its `clear()` removes the shared `localStorage` session (the main window's in-memory session survives until a reload). This exists today on any 401-driven refresh; Task 5's early refresh makes it periodic on an idle rig. Fix separately (sync `authStore` across windows); don't widen this PR.

---

### Task 1: Relay checks the D1 sign-in instead of the shared token

**Files:**
- Modify: `apps/force-app/bug-report-relay/server.py` (module docstring lines 1–53, imports 55–75, `_rig_token`/`_rig_gate` at ~350–362, the four rig endpoints at ~466, ~542, ~603, ~630)
- Modify: `apps/force-app/bug-report-relay/test_server.py`
- Modify: `docker-compose.yml` (bug-report-relay `environment`), `.env.example` (rig-test lines ~70–76)

**Interfaces:**
- Produces (HTTP, consumed by Task 2): every `/rig-tests*` call needs `Authorization: Bearer <D1 access token>`. 403 `{"ok": false, "reason": "D1 sign-in rejected"}`; 503 `{"ok": false, "reason": "D1 unavailable"}`.
- Produces (Python, for tests): `async def _directus_me(token: str) -> dict | None` (raises `_D1Unavailable`), `async def _d1_user(token: str) -> dict | None`, `_d1_cache: dict[str, tuple[float, dict]]`, `class _D1Unavailable(Exception)`.

- [ ] **Step 1: Replace the token fixtures and tests with sign-in ones (failing)**

In `test_server.py`:

1. Add `import asyncio` and `import logging` to the imports.
2. Replace `RIG_TOKEN = "rig-secret-token"` and the `client` fixture with:

```python
D1_TOKEN = "d1-access-token"
USER = {"id": "d1-user-1", "email": "op@example.ac.uk"}


@pytest.fixture
def client():
    # A signed-in operator's D1 token on every call; tests of the sign-in build their own client.
    return TestClient(srv.app, headers={"Authorization": f"Bearer {D1_TOKEN}"})
```

3. Add, just above `class FakeGitHub`:

```python
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
```

4. In the `gh` fixture, replace `monkeypatch.setenv("RIG_TEST_RELAY_TOKEN", RIG_TOKEN)` with:

```python
    monkeypatch.delenv("RIG_TEST_RELAY_TOKEN", raising=False)
    srv._d1_cache.clear()
    fake_d1 = FakeDirectus()
    monkeypatch.setattr(srv, "_directus_me", fake_d1)
```

and after `fake = FakeGitHub()` add `fake.d1 = fake_d1`.

5. Delete `test_rig_tests_fail_closed_without_a_relay_token`, `test_the_right_token_is_accepted_on_a_get` and `test_token_is_compared_in_constant_time`.

6. Replace the parametrized `test_every_rig_endpoint_rejects_a_missing_or_wrong_token` (and its `@pytest.mark.parametrize`) with:

```python
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


def test_a_signed_in_operator_is_accepted_and_logged_without_the_token(gh, caplog):
    gh.issue(5)
    with caplog.at_level(logging.INFO, logger="bug-report-relay"):
        r = TestClient(srv.app).get("/rig-tests", headers={"Authorization": f"Bearer {D1_TOKEN}"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert "d1-user-1" in caplog.text and "op@example.ac.uk" in caplog.text
    assert D1_TOKEN not in caplog.text


def test_an_accepted_sign_in_is_cached_for_60_s(client, gh, monkeypatch):
    gh.issue(5)
    clock = [1000.0]
    monkeypatch.setattr(srv, "_now", lambda: clock[0])  # not time.monotonic: the event loop uses it
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
    _patch_transport(monkeypatch, lambda r: seen.append(r) or httpx.Response(200, json={"data": USER}))
    monkeypatch.delenv("DIRECTUS_INTERNAL_URL", raising=False)
    asyncio.run(srv._directus_me(D1_TOKEN))
    assert str(seen[0].url).startswith("http://directus:8055/users/me")


@pytest.mark.parametrize(
    "status,body",
    [(401, {"errors": []}), (403, {"errors": []}), (200, {"data": {}}), (200, {"data": None}), (200, [])],
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
```

7. In `test_rig_tests_fail_closed_without_an_allowlist` and `test_rig_tests_fail_closed_without_the_github_app`, add as the last line: `assert gh.d1.calls == 0  # config is checked before Directus is asked`.

8. Then make sure nothing else still uses the old token:
   `Select-String test_server.py -Pattern "RIG_TOKEN|X-Rig-Token|RIG_TEST_RELAY_TOKEN|compare_digest"` must only match the deliberate `{"X-Rig-Token": "rig-secret-token"}` parametrize case.

- [ ] **Step 2: Run the relay tests to see them fail**

Run (from `apps/force-app/bug-report-relay`): the Docker command in Global Constraints.
Expected: FAIL — `AttributeError: module 'server' has no attribute '_d1_cache'` (fixture) and 403 assertions.

- [ ] **Step 3: Implement the D1 gate in `server.py`**

Imports: drop `import hmac`, add `import hashlib`.

Logging: the relay never configures logging, and uvicorn only configures its own loggers, so an
`log.info` line is dropped in production (Python's last-resort handler prints WARNING and up). The
D1-user line must reach `docker logs`. Right after `log = logging.getLogger("bug-report-relay")` add:

```python
if not logging.getLogger().handlers:  # uvicorn configures only its own loggers; pytest adds its own
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
```

(Checked live after deploy by the runbook step "the relay log names that D1 user".)

Replace `_rig_token` and `_rig_gate` (the block starting `def _rig_token() -> str:` through the end of `_rig_gate`) with:

```python
D1_REJECTED = "D1 sign-in rejected"
D1_UNAVAILABLE = "D1 unavailable"
_D1_TTL_S = 60.0
_D1_CACHE_MAX = 256
# sha256(token) -> (monotonic expiry, user). Accepted sign-ins only: a refusal is asked again.
_d1_cache: dict[str, tuple[float, dict]] = {}
_now = time.monotonic  # the sign-in cache's clock; tests replace it


class _D1Unavailable(Exception):
    """Directus could not say whether the token is good (down, timeout, 5xx, garbage)."""


def _directus_url() -> str:
    return os.environ.get("DIRECTUS_INTERNAL_URL", "http://directus:8055").rstrip("/")


async def _directus_me(token: str) -> dict | None:
    """The D1 user this access token belongs to, or None when Directus refuses it. Only id and
    email are asked for: a non-admin may not read their own status, and a suspended user's session
    can't be refreshed anyway, so it lapses within one access-token lifetime."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(
                f"{_directus_url()}/users/me",
                params={"fields": "id,email"},
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError:
        raise _D1Unavailable from None
    if res.status_code in (401, 403):
        return None
    if res.status_code != 200:
        raise _D1Unavailable
    try:
        body = res.json()
    except ValueError:
        raise _D1Unavailable from None
    user = body.get("data") if isinstance(body, dict) else None
    return user if isinstance(user, dict) and user.get("id") else None


async def _d1_user(token: str) -> dict | None:
    key = hashlib.sha256(token.encode()).hexdigest()
    now = _now()
    hit = _d1_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    user = await _directus_me(token)
    if user is not None:
        _d1_cache.pop(key, None)
        while len(_d1_cache) >= _D1_CACHE_MAX:
            _d1_cache.pop(next(iter(_d1_cache)))  # oldest first (dicts keep insertion order)
        _d1_cache[key] = (now + _D1_TTL_S, user)
    return user


async def _rig_gate(authorization: str, action: str) -> dict | JSONResponse | None:
    """Fail closed: no allowlist or no GitHub App means no rig-test endpoint does anything.
    Otherwise the caller must be signed in to D1 (every method, reads too)."""
    if not _allowed_logins() or not configured():
        return _failure("rig tests not configured")
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return JSONResponse(_failure(D1_REJECTED), status_code=403)
    try:
        user = await _d1_user(token)
    except _D1Unavailable:
        return JSONResponse(_failure(D1_UNAVAILABLE), status_code=503)
    if user is None:
        return JSONResponse(_failure(D1_REJECTED), status_code=403)
    log.info("rig-test %s by D1 user %s (%s)", action, user.get("id"), user.get("email"))
    return None
```

In each of the four endpoints, rename the header parameter and await the gate:

```python
async def rig_tests(authorization: Annotated[str, Header()] = "") -> dict:
    ...
    if (gate := await _rig_gate(authorization, "list")) is not None:
        return gate
```

Use action names `"list"`, `f"comment on #{n}"`, `f"edit comment {comment_id} on #{n}"`, `f"state on #{n}"` for the list, comment, edit and state endpoints respectively. Every `x_rig_token` parameter becomes `authorization`.

Update the module docstring: in the env list replace the `RIG_TEST_RELAY_TOKEN` entry with

```
    DIRECTUS_INTERNAL_URL          where the relay asks Directus who a D1 token belongs to;
                                    default http://directus:8055 (same Docker network)
```

and replace the "Trust:" paragraph's token sentences (from "Callers are not trusted by network position either" to the end of the 403 sentence) with:

```
Callers are not trusted by network position either: every /rig-tests* call, reads included, must
carry the signed-in operator's D1 access token as `Authorization: Bearer`, which the relay checks
with Directus /users/me (accepted users cached 60 s, by hash) and logs the D1 user it belongs to.
The token is used for nothing else and never logged. Even signed in, every write re-checks that the
issue is open, is not a PR, carries the label, was opened by an allowlisted login and was labelled
by one, and the relay will not edit a comment that holds a result marker. With
RIG_TEST_ALLOWED_LOGINS empty, or the App unconfigured, every rig-test endpoint answers
{"ok": false, "reason": "rig tests not configured"}; a missing or refused sign-in gets HTTP 403
{"ok": false, "reason": "D1 sign-in rejected"}, and Directus being unreachable HTTP 503
{"ok": false, "reason": "D1 unavailable"}.
```

- [ ] **Step 4: Run the relay tests to see them pass**

Run the Docker command again. Expected: all pass (57 before this change, minus 3 deleted, plus the new ones). Also run `& $PY -m ruff check apps/force-app/bug-report-relay` from the worktree root if ruff is installed in that venv; otherwise `docker run --rm -v "${PWD}:/app" -w /app python:3.12-slim sh -c "pip install -q ruff && ruff check . && ruff format --check ."` from the relay folder.

- [ ] **Step 5: Deploy config**

`docker-compose.yml`, bug-report-relay `environment`: replace the line
`RIG_TEST_RELAY_TOKEN: ${RIG_TEST_RELAY_TOKEN:-}  # must match the rig PC token (Settings > Rig tests)` with
`DIRECTUS_INTERNAL_URL: ${DIRECTUS_INTERNAL_URL:-http://directus:8055}  # who a rig-test caller's D1 token belongs to`.

`.env.example`: delete the `RIG_TEST_RELAY_TOKEN=` line and its comment lines (around lines 73–75); keep `RIG_TEST_ALLOWED_LOGINS`. If the comment above `RIG_TEST_ALLOWED_LOGINS` mentions the token, reword it to say callers sign in with D1.

- [ ] **Step 6: Commit**

```bash
git add apps/force-app/bug-report-relay/server.py apps/force-app/bug-report-relay/test_server.py docker-compose.yml .env.example
git commit -m "feat(relay): rig-test endpoints check the caller's D1 sign-in instead of a shared token"
git push
```

---

### Task 2: Backend relay client holds the D1 session in memory and sends it as a bearer

**Files:**
- Modify: `apps/force-app/backend/app/rig_test/relay.py`
- Delete: `apps/force-app/backend/tests/test_rig_test_token_guard.py`
- Create: `apps/force-app/backend/tests/test_rig_test_session.py`
- Modify: `apps/force-app/backend/tests/test_rig_test_poller.py` (~line 397)

**Interfaces:**
- Consumes: Task 1's HTTP contract (403 `D1 sign-in rejected`, 503 `D1 unavailable`).
- Produces (used by Task 3):
  - `relay.SIGNED_OUT: str` = `"Sign in to D1 online to receive rig-test requests"`
  - `relay.SIGNIN_REJECTED: str` = `"D1 sign-in rejected"`
  - `relay.set_session(token: str, expires_at: float) -> bool` — `expires_at` epoch ms; returns True if the token differs from the one held; raises `ValueError` for an unusable token.
  - `relay.clear_session(only: str | None = None) -> None` — with `only`, clears just if that is still the token held.
  - `relay.session_present() -> bool` — a token is held and not expired.
  - `relay.relay_status(result) -> str` now also returns `"signed_out"` and `"signin_rejected"` (no more `"token_rejected"`).
  - `_call` results carry `kind` in `{"not_configured", "signed_out", "signin_rejected", "unreachable"}` on failure.

- [ ] **Step 1: Write the failing tests**

Delete `tests/test_rig_test_token_guard.py`. Create `tests/test_rig_test_session.py`:

```python
"""The operator's D1 sign-in (ADR-0012 decision 2, amended 2026-10-12): the web lends its access
token to the backend, which sends it to the relay as a bearer, keeps it in memory only, never leaks
it, and does not call the relay without it."""

import time

import httpx
import pytest

import app.main as main
from app.rig_test import relay

TOKEN = "d1-access-token-0123456789"


def later(seconds: float = 3600) -> float:
    return (time.time() + seconds) * 1000


@pytest.fixture(autouse=True)
def _clean_session(monkeypatch):
    monkeypatch.setenv("FORCE_APP_BUG_REPORT_RELAY_URL", "http://relay.invalid")
    relay.clear_session()
    yield
    relay.clear_session()


def _record_requests(monkeypatch, reply):
    sent = []

    def fake_request(method, url, **kw):
        sent.append((method, url, kw))
        return reply(method, url, kw)

    monkeypatch.setattr(httpx, "request", fake_request)
    return sent


def _ok(*_):
    return httpx.Response(200, json={"ok": True, "requests": []})


def test_no_session_means_no_request_at_all(monkeypatch):
    sent = _record_requests(monkeypatch, _ok)
    for res in (relay.list_requests(), relay.post_comment(5, "x"), relay.set_state(5, "done")):
        assert res == {"ok": False, "reason": relay.SIGNED_OUT, "kind": "signed_out"}
        assert relay.relay_status(res) == "signed_out"
    assert sent == []


def test_every_relay_call_sends_the_bearer(monkeypatch):
    relay.set_session(TOKEN, later())
    sent = _record_requests(monkeypatch, _ok)
    relay.list_requests()
    relay.post_comment(5, "x")
    relay.edit_comment(5, 9, "x")
    relay.set_state(5, "done")
    assert len(sent) == 4
    assert all(kw["headers"] == {"Authorization": f"Bearer {TOKEN}"} for _, _, kw in sent)


def test_an_expired_session_counts_as_signed_out(monkeypatch):
    relay.set_session(TOKEN, later(-1))
    assert relay.session_present() is False
    sent = _record_requests(monkeypatch, _ok)
    assert relay.list_requests()["kind"] == "signed_out"
    assert sent == []


@pytest.mark.parametrize("bad", ["", "has a space", "café", "line\nbreak", "x" * 4097])
def test_an_unusable_token_is_refused_and_the_old_one_kept(bad):
    relay.set_session(TOKEN, later())
    with pytest.raises(ValueError):
        relay.set_session(bad, later())
    assert relay.session_present() is True


def test_set_session_says_whether_the_token_changed():
    assert relay.set_session(TOKEN, later()) is True
    assert relay.set_session(TOKEN, later(7200)) is False  # same token, new expiry
    assert relay.set_session(TOKEN + "2", later()) is True


def test_a_rejected_sign_in_clears_the_session(monkeypatch):
    relay.set_session(TOKEN, later())
    _record_requests(
        monkeypatch,
        lambda *_: httpx.Response(403, json={"ok": False, "reason": "D1 sign-in rejected"}),
    )
    res = relay.list_requests()
    assert res["kind"] == "signin_rejected" and relay.relay_status(res) == "signin_rejected"
    assert relay.session_present() is False


def test_a_rejection_does_not_clear_a_newer_token(monkeypatch):
    relay.set_session(TOKEN, later())

    def refused_while_the_web_refreshed(*_):
        relay.set_session("newer-token", later())
        return httpx.Response(403, json={"ok": False, "reason": "D1 sign-in rejected"})

    _record_requests(monkeypatch, refused_while_the_web_refreshed)
    relay.list_requests()
    assert relay.session_present() is True


def test_d1_unavailable_is_unreachable_so_the_outbox_keeps_the_result(monkeypatch):
    relay.set_session(TOKEN, later())
    _record_requests(
        monkeypatch, lambda *_: httpx.Response(503, json={"ok": False, "reason": "D1 unavailable"})
    )
    res = relay.post_comment(5, "result")
    assert res["kind"] == "unreachable" and relay.relay_status(res) == "unreachable"


def test_the_token_never_appears_in_an_error_text(monkeypatch):
    relay.set_session(TOKEN, later())

    def boom(method, url, **kw):
        raise httpx.LocalProtocolError(f"Illegal header value {kw['headers']['Authorization']!r}")

    monkeypatch.setattr(httpx, "request", boom)
    res = relay.post_comment(5, "x")
    assert res["ok"] is False and TOKEN not in repr(res)


def test_the_token_is_not_in_the_bug_report_diagnostics():
    relay.set_session(TOKEN, later())
    assert TOKEN not in "\n".join(main._diag_lines())


def test_the_old_token_env_var_and_file_are_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", "old-shared-token")
    (tmp_path / "rig_test_token").write_text("old-shared-token", encoding="utf-8")
    sent = _record_requests(monkeypatch, _ok)
    assert relay.list_requests()["kind"] == "signed_out"
    assert sent == []
```

In `tests/test_rig_test_poller.py`, `test_the_real_relay_client_never_raises`: replace `monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", "test-rig-token")` with `relay.set_session("test-d1-token", (time.time() + 3600) * 1000)` (add `import time` if missing) and add `relay.clear_session()` as the last line of that test.

Also add to `test_rig_test_poller.py` (it already has the poller test helpers; follow the existing pattern there for building a `RigTestPoller` with a `StateFile`):

```python
def test_outbox_waits_while_signed_out_then_sends(monkeypatch, tmp_path):
    from app.rig_test import poller as poller_mod

    relay.clear_session()
    store = poller_mod.StateFile(str(tmp_path / "state.json"))
    store.outbox_add(7, "result body", "done")
    p = poller_mod.RigTestPoller(
        store=store, eligible=lambda: (False, relay.SIGNED_OUT), is_busy=lambda: False,
        owns_rig=lambda: False, rig_id=lambda: "rig", interval_s=60,
    )
    sent = []
    monkeypatch.setattr(httpx, "request", lambda m, u, **kw: sent.append(u) or httpx.Response(200, json={"ok": True, "id": 1}))
    for _ in range(6):  # more than OUTBOX_REFUSED_MAX: signed out must never count as a refusal
        p.flush_outbox()
    assert sent == [] and len(store.get("outbox")) == 1
    relay.set_session("test-d1-token", (time.time() + 3600) * 1000)
    p.flush_outbox()
    assert store.get("outbox") == []
    relay.clear_session()
```

If `RigTestPoller`'s constructor or `StateFile.outbox_add`'s signature differs from the above, adapt the call to the real signature (read `app/rig_test/poller.py` lines 120–215) — the assertions are what matter.

- [ ] **Step 2: Run them to see them fail**

Run: `& $PY -m pytest tests/test_rig_test_session.py tests/test_rig_test_poller.py -q`
Expected: FAIL — `AttributeError: module 'app.rig_test.relay' has no attribute 'clear_session'`.

- [ ] **Step 3: Implement the session in `relay.py`**

Replace the module docstring's token sentences (lines 3–7) with:

```
The rig PC holds no GitHub credential: the relay does, and checks who labelled a request (ADR-0012).
Every call carries the signed-in operator's D1 access token as `Authorization: Bearer`, which the
relay checks with Directus. The web app lends that token to this process (`PUT /rig-tests/session`)
while its session is online; it lives in memory only, is never written to disk, logged, reported or
put in an error message, and is gone after a restart until the web app sends it again.
```

Replace `import os` with `import threading` and `import time` (keep `re`; `os` is no longer used here — check with ruff). Replace the constants `TOKEN_ENV` … `_config_dir` and the functions `set_config_dir` and `token` with:

```python
SIGNED_OUT = "Sign in to D1 online to receive rig-test requests"
SIGNIN_REJECTED = "D1 sign-in rejected"  # the relay's reason, verbatim
# Printable ASCII only, so it is a legal header value whatever the web sent.
_TOKEN_RE = re.compile(r"[\x21-\x7e]{1,4096}")
_session_lock = threading.Lock()
_session = {"token": "", "expires_at": 0.0}  # expires_at: epoch ms, as the web's auth store keeps it


def set_session(token: str, expires_at: float) -> bool:
    """Hold the operator's D1 access token. True if it differs from the one held. Raises
    ValueError (without the token in it) for anything that is not a usable header value."""
    if not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
        raise ValueError("not a usable access token")
    with _session_lock:
        changed = token != _session["token"]
        _session["token"] = token
        _session["expires_at"] = float(expires_at)
    return changed


def clear_session(only: str | None = None) -> None:
    """Forget the token; with `only`, just if that is still the one held (a refresh may have
    replaced it while a refused call was in flight)."""
    with _session_lock:
        if only is None or _session["token"] == only:
            _session["token"] = ""
            _session["expires_at"] = 0.0


def _current_token() -> str:
    with _session_lock:
        if _session["token"] and _session["expires_at"] > time.time() * 1000:
            return _session["token"]
    return ""


def session_present() -> bool:
    return bool(_current_token())
```

In `_call`, replace

```python
    secret = token()
    if not secret:
        return {"ok": False, "reason": TOKEN_MISSING, "kind": "not_configured"}
```

with

```python
    secret = _current_token()
    if not secret:
        return {"ok": False, "reason": SIGNED_OUT, "kind": "signed_out"}
```

change `headers={"X-Rig-Token": secret},` to `headers={"Authorization": f"Bearer {secret}"},`, and replace the `TOKEN_REJECTED` check with:

```python
    if res.status_code == 403 and data.get("reason") == SIGNIN_REJECTED:
        clear_session(only=secret)
        return {"ok": False, "reason": SIGNIN_REJECTED, "kind": "signin_rejected"}
    if res.status_code == 503:  # Directus or the relay is down: wait, it is not a refusal
        return {
            "ok": False,
            "reason": str(data.get("reason") or "relay unavailable"),
            "kind": "unreachable",
        }
```

Replace `relay_status` with:

```python
def relay_status(result: dict) -> str:
    """'ok' | 'unreachable' | 'not_configured' | 'signed_out' | 'signin_rejected' for the
    Settings tab, from one relay answer."""
    if result.get("ok"):
        return "ok"
    kind = result.get("kind")
    if kind in ("signed_out", "signin_rejected"):
        return kind
    if kind == "not_configured" or "not configured" in str(result.get("reason", "")):
        return "not_configured"
    return "unreachable"
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `& $PY -m pytest tests/test_rig_test_session.py tests/test_rig_test_poller.py tests/test_rig_test_report.py tests/test_rig_test_runner.py tests/test_rig_test_catalog.py -q`
Expected: PASS. (`test_rig_test_api.py` still fails until Task 3 — `routes.py` calls the removed `relay.set_config_dir`. Commit Task 2 but push it together with Task 3, so CI never sees the broken middle state.)

- [ ] **Step 5: Commit**

```bash
git add -A apps/force-app/backend/app/rig_test/relay.py apps/force-app/backend/tests/
git commit -m "feat(force-app): backend sends the operator's D1 token to the relay, held in memory only"
```

(No push yet: Task 3 pushes both.)

---

### Task 3: Backend routes receive the session and report it

**Files:**
- Modify: `apps/force-app/backend/app/rig_test/routes.py`
- Modify: `apps/force-app/backend/tests/test_rig_test_api.py` (fixture at lines ~35–58, plus new tests)

**Interfaces:**
- Consumes: Task 2's `relay.set_session`, `relay.clear_session`, `relay.session_present`, `relay.SIGNED_OUT`.
- Produces (HTTP, consumed by Tasks 4–5):
  - `PUT /rig-tests/session` body `{"access_token": str, "expires_at": number}` → `{"ok": true}`; 422 for an unusable token. Never echoes the token.
  - `DELETE /rig-tests/session` → `{"ok": true}`.
  - `GET /rig-tests/pending` adds `"session": bool`, `"hardware_ok": bool | null`, `"relay": "ok" | "unreachable" | "not_configured" | "unknown" | "signed_out" | "signin_rejected"`.
  - `GET /rig-tests/eligibility` adds `"session"` and `"hardware_ok"`; its `"relay"` uses the same rule as `/pending`.

- [ ] **Step 1: Update the fixture and write the failing tests**

In `tests/test_rig_test_api.py`, fixture `rig`: replace

```python
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", "test-rig-token")
    monkeypatch.setattr(relay, "_config_dir", relay._config_dir)  # configure() below sets it
```

with

```python
    relay.set_session(SESSION_TOKEN, (time.time() + 3600) * 1000)
```

and add `relay.clear_session()` after `wiring.runner.join()` in its teardown. Add `import time` if missing and, at module level, `SESSION_TOKEN = "test-d1-token-abcdef"`.

Append these tests:

```python
def test_put_and_delete_session_drive_the_pending_flags(client, rig):
    relay.clear_session()
    assert client.get("/rig-tests/pending").json()["session"] is False
    r = client.put(
        "/rig-tests/session",
        json={"access_token": "new-d1-token", "expires_at": (time.time() + 600) * 1000},
    )
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert client.get("/rig-tests/pending").json()["session"] is True
    assert client.delete("/rig-tests/session").json() == {"ok": True}
    assert client.get("/rig-tests/pending").json()["session"] is False


@pytest.mark.parametrize("token", ["", "has space", "x" * 5000])
def test_an_unusable_session_token_is_422_and_changes_nothing(client, rig, token):
    r = client.put("/rig-tests/session", json={"access_token": token, "expires_at": 1})
    assert r.status_code == 422
    assert SESSION_TOKEN not in r.text and (not token or token not in r.text)
    assert relay.session_present() is True


def test_no_route_ever_returns_the_session_token(client, rig):
    client.put(
        "/rig-tests/session",
        json={"access_token": "secret-d1-token-xyz", "expires_at": (time.time() + 600) * 1000},
    )
    for path in ("/rig-tests/eligibility", "/rig-tests/pending", "/rig-tests/run", "/rig-tests/history"):
        assert "secret-d1-token-xyz" not in client.get(path).text


def test_signed_out_pc_is_not_eligible_and_never_polls(client, rig, fake, monkeypatch):
    relay.clear_session()
    fake.requests = [issue(231)]
    monkeypatch.setattr(
        relay, "list_requests", lambda: pytest.fail("the relay must not be asked while signed out")
    )
    rig.poller.poll_once()
    body = client.get("/rig-tests/eligibility").json()
    assert body["eligible"] is False and body["reason"] == relay.SIGNED_OUT
    assert body["session"] is False and body["hardware_ok"] is True
    pending = client.get("/rig-tests/pending").json()
    assert pending["requests"] == [] and pending["relay"] == "signed_out"
    assert pending["hardware_ok"] is True


def test_hardware_ok_is_null_until_the_first_check(client, rig):
    assert client.get("/rig-tests/pending").json()["hardware_ok"] is None


def test_a_new_token_resets_the_relay_state(client, rig):
    rig.poller.relay_state = "signin_rejected"
    client.put("/rig-tests/session", json={"access_token": "another-token", "expires_at": (time.time() + 600) * 1000})
    assert rig.poller.relay_state == "unknown"
    rig.poller.relay_state = "ok"
    client.put("/rig-tests/session", json={"access_token": "another-token", "expires_at": (time.time() + 900) * 1000})
    assert rig.poller.relay_state == "ok"  # same token: nothing to reset


def test_a_rejection_is_reported_even_though_the_session_was_cleared(client, rig):
    rig.poller.relay_state = "signin_rejected"
    relay.clear_session()
    assert client.get("/rig-tests/pending").json()["relay"] == "signin_rejected"
    assert client.get("/rig-tests/eligibility").json()["relay"] == "signin_rejected"
```

`issue` and `fake` already exist in this module (from `test_rig_test_support`); if `issue` isn't imported here, add it to the existing `from .test_rig_test_support import ...` line.

- [ ] **Step 2: Run them to see them fail**

Run: `& $PY -m pytest tests/test_rig_test_api.py -q`
Expected: FAIL — `AttributeError: module 'app.rig_test.relay' has no attribute 'set_config_dir'` from `routes.configure`.

- [ ] **Step 3: Implement in `routes.py`**

`_Wiring` gains a holder for the last hardware check:

```python
@dataclass
class _Wiring:
    is_busy: Callable[[], bool]
    captures_root: Callable[[], str]
    poller: RigTestPoller
    runner: RigTestRunner
    # The last hardware check, None before the first: the web refreshes the D1 token early only
    # on a PC that is on the rig, and must not trigger a DAQmx enumeration to find out.
    hardware: dict
```

In `configure`, delete `relay.set_config_dir(config_dir)` and replace `eligible` with:

```python
    hardware: dict = {"ok": None}

    def eligible() -> tuple[bool, str | None]:
        ok, reason = eligibility.check(devices(), labamp())
        hardware["ok"] = ok
        if ok and not relay.session_present():
            # Nobody signed in online: the relay would refuse every call anyway.
            return False, relay.SIGNED_OUT
        return ok, reason
```

and construct `_w = _Wiring(is_busy, captures_root, poller, rig_runner, hardware)`.

Add after `class AnswerBody`:

```python
class SessionBody(BaseModel):
    # No Field limits on purpose: pydantic's 422 echoes the rejected input, and this is a
    # credential. relay.set_session checks it (1-4096 printable ASCII) without repeating it.
    access_token: str
    expires_at: float  # epoch ms
```

Add helper and routes (before `@router.get("/eligibility")`):

```python
def _relay_view(w: _Wiring) -> str:
    """The relay state Settings and the store show. A refused sign-in clears the session, so it
    is checked before "signed_out" or the operator would never see why."""
    if not bug_report.configured():
        return "not_configured"
    if w.poller.relay_state == "signin_rejected":
        return "signin_rejected"
    if not relay.session_present():
        return "signed_out"
    return w.poller.relay_state


@router.put("/session")
async def put_session(body: SessionBody) -> dict:
    w = _wiring()
    try:
        changed = relay.set_session(body.access_token, body.expires_at)
    except ValueError:
        raise HTTPException(422, "not a usable access token") from None
    if changed:
        w.poller.relay_state = "unknown"  # a rejection seen from now on is about this token
    return {"ok": True}


@router.delete("/session")
async def delete_session() -> dict:
    relay.clear_session()
    return {"ok": True}
```

The test `test_an_unusable_session_token_is_422_and_changes_nothing` pins that a refused token is never echoed (a non-string `access_token` still gets pydantic's own 422, which is fine: it isn't a usable credential).

`get_eligibility` becomes:

```python
@router.get("/eligibility")
async def get_eligibility() -> dict:
    w = _wiring()
    ok, reason = await run_in_threadpool(w.poller.check_eligibility)
    out: dict = {
        "eligible": ok,
        "rig_id": eligibility.rig_id(),
        "relay": _relay_view(w),
        "session": relay.session_present(),
        "hardware_ok": w.hardware["ok"],
    }
    if reason:
        out["reason"] = reason
    return out
```

`get_pending` adds three keys to its dict:

```python
        "session": relay.session_present(),
        "hardware_ok": w.hardware["ok"],
        "relay": _relay_view(w),
```

- [ ] **Step 4: Run the whole backend suite**

Run: `& $PY -m pytest -q` (from `apps/force-app/backend`), then `& $PY -m ruff check . ; & $PY -m ruff format --check .`
Expected: all pass, ruff clean. Fix any other test that still referenced `FORCE_APP_RIG_TEST_TOKEN` or `_config_dir` the same way as the fixture above.

- [ ] **Step 5: Commit**

```bash
git add apps/force-app/backend/app/rig_test/routes.py apps/force-app/backend/tests/test_rig_test_api.py
git commit -m "feat(force-app): PUT/DELETE /rig-tests/session; pending reports session, hardware and relay state"
git push
```

---

### Task 4: Web API client and parsing know the session

**Files:**
- Modify: `apps/force-app/web/src/rigtest/rigTestApi.ts`
- Modify: `apps/force-app/web/src/rigtest/rigTestLogic.ts` (`RelayState`, `Eligibility`, `PendingList`, `parsePending`, `relayInfo`)
- Modify: `apps/force-app/web/src/rigtest/rigTestApi.test.ts`, `rigTestLogic.test.ts`, `rigTestStore.test.ts` (helpers only)

**Interfaces:**
- Consumes: Task 3's HTTP contract.
- Produces (used by Task 5):
  - `type RelayState = 'ok' | 'unreachable' | 'not_configured' | 'unknown' | 'signed_out' | 'signin_rejected'`
  - `parseRelay(x: unknown): RelayState` (unknown values → `'not_configured'`)
  - `interface PendingList { requests; snoozed; busy: boolean; session: boolean; hardwareOk: boolean | null; relay: RelayState }`
  - `interface Eligibility { eligible; rig_id; reason?; relay: RelayState; session: boolean; hardwareOk: boolean | null }`
  - `putSession(token: string, expiresAt: number): Promise<ApiResult<unknown>>`, `deleteSession(): Promise<ApiResult<unknown>>`, both on `rigTestApi`.

- [ ] **Step 1: Write the failing tests**

`rigTestApi.test.ts`: import `putSession, deleteSession` too. Replace the `'GET /eligibility keeps relay "token_rejected" …'` test with:

```ts
	it('GET /eligibility keeps the sign-in states and reads session / hardware_ok', async () => {
		stub(200, { eligible: false, rig_id: 'rig-1', relay: 'signin_rejected', session: false, hardware_ok: true });
		const r = await getEligibility();
		expect(r.kind === 'ok' && r.data).toMatchObject({ relay: 'signin_rejected', session: false, hardwareOk: true });
		stub(200, { eligible: false, rig_id: 'rig-1', relay: 'signed_out' });
		const s = await getEligibility();
		expect(s.kind === 'ok' && s.data).toMatchObject({ relay: 'signed_out', session: false, hardwareOk: null });
	});
	it('an old relay state from an older backend reads as not configured', async () => {
		stub(200, { eligible: true, rig_id: 'rig-1', relay: 'token_rejected' });
		const r = await getEligibility();
		expect(r.kind === 'ok' && r.data.relay).toBe('not_configured');
	});
```

Fix the `'GET /eligibility defaults relay to not_configured'` expectation to
`{ eligible: true, rig_id: 'rig-1', reason: undefined, relay: 'not_configured', session: false, hardwareOk: null }`.

Add:

```ts
describe('session routes', () => {
	it('PUT /session sends the token and its expiry, DELETE clears it', async () => {
		const f = stub(200, { ok: true });
		expect((await putSession('tok', 123)).kind).toBe('ok');
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(/\/rig-tests\/session$/);
		expect(init.method).toBe('PUT');
		expect(JSON.parse(String(init.body))).toEqual({ access_token: 'tok', expires_at: 123 });
		await deleteSession();
		const [, del] = f.mock.calls[1] as unknown as [string, RequestInit];
		expect(del.method).toBe('DELETE');
	});
	it('a refused PUT is an error, not a throw', async () => {
		stub(422, { detail: 'not a usable access token' });
		expect(await putSession('bad token', 1)).toMatchObject({ kind: 'error', status: 422, detail: 'not a usable access token' });
	});
});
```

`rigTestLogic.test.ts` (`parsePending` describe): change the expected objects to include the new fields, and add a case:

```ts
		expect(parsePending(null)).toEqual({ requests: [], snoozed: [], busy: false, session: false, hardwareOk: null, relay: 'not_configured' });
		expect(parsePending({ busy: 'yes', snoozed: 4 })).toEqual({ requests: [], snoozed: [], busy: false, session: false, hardwareOk: null, relay: 'not_configured' });
		expect(parsePending({ session: true, hardware_ok: false, relay: 'ok' })).toMatchObject({ session: true, hardwareOk: false, relay: 'ok' });
		expect(parsePending({ session: 'yes', hardware_ok: 'no', relay: 'nope' })).toMatchObject({ session: false, hardwareOk: null, relay: 'not_configured' });
```

In the `relayInfo` describe, replace the two `token_rejected` lines with:

```ts
		expect(relayInfo('signin_rejected').tone).toBe('bad');
		expect(relayInfo('signin_rejected').text).toBe("D1 didn't accept your sign-in: sign out and back in");
		expect(relayInfo('signed_out').text).toBe('Sign in to D1 online to receive rig-test requests');
		expect(relayInfo('signed_out').tone).toBe('dim');
```

`rigTestStore.test.ts` helpers: `pend` becomes
`ok<PendingList>({ requests, snoozed: [], busy: false, session: true, hardwareOk: true, relay: 'ok', ...extra })`, `fakeApi` gains `putSession: vi.fn(async () => ok({ ok: true })), deleteSession: vi.fn(async () => ok({ ok: true })),`, and its `getEligibility` default returns `ok({ eligible: true, rig_id: 'rig', relay: 'ok' as const, session: true, hardwareOk: true })`.

- [ ] **Step 2: Run them to see them fail**

Run (from `apps/force-app/web`): `npx vitest run src/rigtest/rigTestApi.test.ts src/rigtest/rigTestLogic.test.ts`
Expected: FAIL — `putSession` is not exported; parse expectations differ.

- [ ] **Step 3: Implement**

`rigTestLogic.ts`:

```ts
export type RelayState = 'ok' | 'unreachable' | 'not_configured' | 'unknown' | 'signed_out' | 'signin_rejected';
const RELAY_STATES: readonly RelayState[] = ['ok', 'unreachable', 'not_configured', 'unknown', 'signed_out', 'signin_rejected'];
/** The recorder's relay state; anything this build doesn't know reads as "not configured". */
export function parseRelay(x: unknown): RelayState {
	return RELAY_STATES.includes(x as RelayState) ? (x as RelayState) : 'not_configured';
}

export interface Eligibility {
	eligible: boolean;
	rig_id: string;
	reason?: string;
	relay: RelayState;
	/** The recorder holds an unexpired D1 access token from this app. */
	session: boolean;
	/** The last hardware check: on the rig (true), not (false), not checked yet (null). */
	hardwareOk: boolean | null;
}

/** GET /rig-tests/pending. `busy`: the recorder is recording, saving or recovering a capture.
 *  `session` / `hardwareOk` / `relay` tell the session sync when to send or refresh the D1 token. */
export interface PendingList {
	requests: RigRequest[]; snoozed: SnoozedRequest[]; busy: boolean;
	session: boolean; hardwareOk: boolean | null; relay: RelayState;
}
```

(Move `PendingList` and `Eligibility` so `RelayState` is declared before them if needed.)

`parsePending` becomes:

```ts
export function parsePending(raw: unknown): PendingList {
	const r = (raw ?? {}) as { requests?: unknown; snoozed?: unknown; busy?: unknown; session?: unknown; hardware_ok?: unknown; relay?: unknown };
	const rawSnoozed = (Array.isArray(r.snoozed) ? r.snoozed : []).filter((x) => x && typeof x.number === 'number');
	const snoozed = parseRequestList(rawSnoozed).map((x, i) => ({ ...x, snoozed_until: str(rawSnoozed[i].snoozed_until) }));
	return {
		requests: parseRequests(raw), snoozed, busy: r.busy === true,
		session: r.session === true,
		hardwareOk: typeof r.hardware_ok === 'boolean' ? r.hardware_ok : null,
		relay: parseRelay(r.relay),
	};
}
```

`relayInfo`: replace the `token_rejected` case with

```ts
		case 'signed_out': return { text: 'Sign in to D1 online to receive rig-test requests', tone: 'dim', icon: 'login' };
		case 'signin_rejected': return { text: "D1 didn't accept your sign-in: sign out and back in", tone: 'bad', icon: 'key_off' };
```

`rigTestApi.ts`: `call`'s `method` parameter type becomes `'GET' | 'POST' | 'PUT' | 'DELETE'`; import `parseRelay`; `getEligibility` maps to

```ts
		const e = (d ?? {}) as Partial<Eligibility> & { hardware_ok?: unknown };
		return {
			eligible: !!e.eligible, rig_id: typeof e.rig_id === 'string' ? e.rig_id : '',
			reason: typeof e.reason === 'string' ? e.reason : undefined,
			relay: parseRelay(e.relay),
			session: e.session === true,
			hardwareOk: typeof e.hardware_ok === 'boolean' ? e.hardware_ok : null,
		};
```

and add, before `rigTestApi`:

```ts
/** Lend the signed-in operator's D1 access token to the recorder (it sends it to the relay). */
export const putSession = (token: string, expiresAt: number) => call('PUT', '/session', { access_token: token, expires_at: expiresAt });

export const deleteSession = () => call('DELETE', '/session');
```

and add `putSession, deleteSession` to the `rigTestApi` object.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/rigtest` then `npm run typecheck`.
Expected: PASS, no type errors (anything else that used `'token_rejected'` must be updated: `Select-String -Path src -Recurse -Pattern token_rejected` → no matches).

- [ ] **Step 5: Commit**

```bash
git add apps/force-app/web/src/rigtest/
git commit -m "feat(force-app): web client for the rig-test session and the sign-in relay states"
git push
```

---

### Task 5: Web lends the D1 token to the recorder and keeps it fresh

**Files:**
- Create: `apps/force-app/web/src/rigtest/rigTestSession.ts`
- Create: `apps/force-app/web/src/rigtest/rigTestSession.test.ts`
- Modify: `apps/force-app/web/src/rigtest/rigTestStore.ts`
- Modify: `apps/force-app/web/src/rigtest/rigTestStore.test.ts`

**Interfaces:**
- Consumes: Task 4's `putSession`, `deleteSession`, `PendingList.session/hardwareOk/relay`, `RelayState`; `authStore` from `apps/force-app/web/src/authStore.ts` (`state.accessToken`, `state.offline`, `state.expiresAt`, `refresh(): Promise<boolean>`).
- Produces: `createSessionSync(deps)` returning `{ sync(view: SessionView): Promise<void>; release(): Promise<void> }`; `REFRESH_AHEAD_MS = 90_000`; `RigTestDeps` gains optional `session?: SessionSync` and `onAuthChange?: (cb: () => void) => () => void`.

- [ ] **Step 1: Write the failing session tests**

Create `rigTestSession.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from './rigTestApi';
import { REFRESH_AHEAD_MS, createSessionSync, type SessionView } from './rigTestSession';

const ok = (): ApiResult<unknown> => ({ kind: 'ok', data: { ok: true } });
const NOW = 1_000_000;

function setup(over: { online?: boolean; token?: string | null; expiresAt?: number } = {}) {
	const auth = {
		on: over.online ?? true,
		token: over.token === undefined ? 'tok-1' : over.token,
		expiresAt: over.expiresAt ?? NOW + 15 * 60_000,
	};
	const api = { putSession: vi.fn(async () => ok()), deleteSession: vi.fn(async () => ok()) };
	const refresh = vi.fn(async () => { auth.token = `${auth.token}-r`; auth.expiresAt = NOW + 15 * 60_000; return true; });
	const sync = createSessionSync({
		api,
		auth: { online: () => auth.on && !!auth.token, accessToken: () => auth.token, expiresAt: () => auth.expiresAt, refresh },
		now: () => NOW,
	});
	return { auth, api, refresh, sync };
}
const view = (v: Partial<SessionView> = {}): SessionView => ({ session: false, hardwareOk: true, relay: 'ok', ...v });

describe('createSessionSync', () => {
	it('sends the token once, then only when it changes or the recorder lost it', async () => {
		const { auth, api, sync } = setup();
		await sync.sync(view());
		expect(api.putSession).toHaveBeenCalledWith('tok-1', auth.expiresAt);
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenCalledTimes(1);
		await sync.sync(view({ session: false })); // the recorder restarted
		expect(api.putSession).toHaveBeenCalledTimes(2);
		auth.token = 'tok-2';
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenLastCalledWith('tok-2', auth.expiresAt);
	});

	it('clears the recorder on sign-out or going offline', async () => {
		const { auth, api, sync } = setup();
		await sync.sync(view());
		auth.on = false;
		await sync.sync(view({ session: true }));
		expect(api.deleteSession).toHaveBeenCalledTimes(1);
		await sync.sync(view({ session: false }));
		expect(api.deleteSession).toHaveBeenCalledTimes(1); // nothing left to clear
	});

	it('refreshes early only on the rig', async () => {
		const near = { expiresAt: NOW + REFRESH_AHEAD_MS - 1 };
		const onRig = setup(near);
		await onRig.sync.sync(view({ hardwareOk: true }));
		expect(onRig.refresh).toHaveBeenCalledTimes(1);
		expect(onRig.api.putSession).toHaveBeenCalledWith('tok-1-r', expect.any(Number));
		for (const hardwareOk of [false, null]) {
			const office = setup(near);
			await office.sync.sync(view({ hardwareOk }));
			expect(office.refresh).not.toHaveBeenCalled();
		}
	});

	it('does not send an expired token', async () => {
		const { api, sync } = setup({ expiresAt: NOW - 1 });
		await sync.sync(view({ hardwareOk: false }));
		expect(api.putSession).not.toHaveBeenCalled();
	});

	it('retries a rejected sign-in once, then stops', async () => {
		const { api, refresh, sync } = setup();
		await sync.sync(view());                                   // sends tok-1
		await sync.sync(view({ relay: 'signin_rejected' }));       // refused: refresh, send tok-1-r
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(api.putSession).toHaveBeenLastCalledWith('tok-1-r', expect.any(Number));
		await sync.sync(view({ relay: 'signin_rejected' }));       // refused again: give up
		await sync.sync(view({ relay: 'signin_rejected' }));
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(api.putSession).toHaveBeenCalledTimes(2);
	});

	it('a failed PUT is tried again on the next tick', async () => {
		const { api, sync } = setup();
		api.putSession.mockResolvedValueOnce({ kind: 'error', status: 0, detail: 'down' });
		await sync.sync(view({ session: true }));
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenCalledTimes(2);
	});

	it('release() clears the recorder only when signed out', async () => {
		const signedIn = setup();
		await signedIn.sync.release();
		expect(signedIn.api.deleteSession).not.toHaveBeenCalled();
		const signedOut = setup({ online: false });
		await signedOut.sync.release();
		expect(signedOut.api.deleteSession).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/rigtest/rigTestSession.test.ts`
Expected: FAIL — cannot resolve `./rigTestSession`.

- [ ] **Step 3: Implement `rigTestSession.ts`**

```ts
// Lends the signed-in operator's D1 access token to the local recorder, which sends it to the
// relay on every rig-test call (ADR-0012 decision 2, amended 2026-10-12). Only while the session
// is online: signed out or offline, the recorder holds nothing and the PC takes no requests.
//
// Driven by the store's pending poll (`sync`, every 30 s and on sign-in changes) and by the
// shell unmounting (`release`). A factory so the tests can drive it with a fake api and auth.
import type { ApiResult } from './rigTestApi';
import type { RelayState } from './rigTestLogic';

/** While the PC is on the rig, refresh the access token this long before it expires, so the
 *  recorder's copy never lapses between two 30 s polls. */
export const REFRESH_AHEAD_MS = 90_000;

export interface SessionAuth {
	/** An online session with an access token (not offline, not signed out). */
	online(): boolean;
	accessToken(): string | null;
	/** Epoch ms. */
	expiresAt(): number;
	refresh(): Promise<boolean>;
}
export interface SessionApi {
	putSession(token: string, expiresAt: number): Promise<ApiResult<unknown>>;
	deleteSession(): Promise<ApiResult<unknown>>;
}
/** What the recorder last said (GET /rig-tests/pending). */
export interface SessionView { session: boolean; hardwareOk: boolean | null; relay: RelayState }

export function createSessionSync(deps: { api: SessionApi; auth: SessionAuth; now: () => number }) {
	const { api, auth, now } = deps;
	/** The token the recorder holds, as far as we know. */
	let sent: string | null = null;
	/** A token the relay refused: never sent again. */
	let rejected: string | null = null;
	/** A refused sign-in gets one refresh-and-resend; reset once the relay accepts again. */
	let retried = false;
	let busy = false;

	const wanted = (): string | null => (auth.online() ? auth.accessToken() : null);

	async function sync(view: SessionView): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			if (view.relay === 'signin_rejected' && sent) {
				rejected = sent;
				sent = null;
				if (!retried) { retried = true; await auth.refresh(); }
			} else if (view.relay === 'ok') {
				retried = false;
			}
			if (view.hardwareOk === true && auth.online() && auth.expiresAt() - now() < REFRESH_AHEAD_MS) await auth.refresh();
			const token = wanted();
			if (token && token !== rejected && auth.expiresAt() > now()) {
				if (token !== sent || !view.session) {
					const r = await api.putSession(token, auth.expiresAt());
					sent = r.kind === 'ok' ? token : null;
				}
			} else if (sent !== null || view.session) {
				await api.deleteSession();
				sent = null;
			}
		} finally {
			busy = false;
		}
	}

	/** The shell is going away: if nobody is signed in online, the recorder must not keep the
	 *  last operator's token. */
	async function release(): Promise<void> {
		if (wanted()) return;
		sent = null;
		await api.deleteSession();
	}

	return { sync, release };
}
export type SessionSync = ReturnType<typeof createSessionSync>;
```

Note on the first test: after a rejection, `rejected` holds the old token; the early-refresh branch can still produce a new token later, which is then sent (a re-enabled account recovers without a restart).

- [ ] **Step 4: Run session tests to see them pass**

Run: `npx vitest run src/rigtest/rigTestSession.test.ts` — Expected: PASS.

- [ ] **Step 5: Wire it into the store (failing store tests first)**

Append to `rigTestStore.test.ts`:

```ts
describe('session sync', () => {
	it('passes each pending answer to the session sync, and stop() releases it', async () => {
		const session = { sync: vi.fn(async () => {}), release: vi.fn(async () => {}) };
		const api = fakeApi({ getPending: vi.fn(async () => pend([], { session: false, hardwareOk: true, relay: 'signed_out' })) });
		const store = createRigTestStore({ api, notify: vi.fn(), now: () => Date.now(), acceptContext: async () => ({ uploadBusy: false }), session });
		const stop = store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(session.sync).toHaveBeenCalledWith({ session: false, hardwareOk: true, relay: 'signed_out' });
		stop();
		expect(session.release).toHaveBeenCalledTimes(1);
	});

	it('a sign-in change re-reads pending right away', async () => {
		let fire = () => {};
		const onAuthChange = vi.fn((cb: () => void) => { fire = cb; return () => { fire = () => {}; }; });
		const api = fakeApi();
		const store = createRigTestStore({ api, notify: vi.fn(), now: () => Date.now(), acceptContext: async () => ({ uploadBusy: false }), onAuthChange });
		const stop = store.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(1);
		fire();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(2);
		stop();
		fire(); // unwatched on stop
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getPending).toHaveBeenCalledTimes(2);
	});
});
```

Run: `npx vitest run src/rigtest/rigTestStore.test.ts` — Expected: FAIL (session not called).

Then in `rigTestStore.ts`:

1. Imports: add `import { authStore } from '../authStore';` and `import { createSessionSync, type SessionSync } from './rigTestSession';`.
2. `RigTestDeps` gains:

```ts
	/** Lends the D1 token to the recorder (rigTestSession.ts). Absent in most tests. */
	session?: SessionSync;
	/** Calls back when the sign-in changes (token, offline); returns the unwatch. */
	onAuthChange?: (cb: () => void) => () => void;
```

3. In `applyPending`, as the last line: `void deps.session?.sync({ session: p.session, hardwareOk: p.hardwareOk, relay: p.relay });`
4. In `refreshPending`'s `missing` branch, pass the full shape: `applyPending({ requests: [], snoozed: [], busy: false, session: false, hardwareOk: null, relay: 'not_configured' });`
5. Add `let unwatchAuth: (() => void) | null = null;` next to `unwatchSave`. In `start()`, after the `unwatchSave` line: `unwatchAuth = deps.onAuthChange?.(() => { void refreshPending(); }) ?? null;`. In `stop()`: `unwatchAuth?.(); unwatchAuth = null; void deps.session?.release();`.
6. Replace the bottom `export const rigTest = …` with:

```ts
/** Lends this window's D1 sign-in to the recorder. Only the main window mounts RigTestHost, so
 *  only it ever sends the token. */
const sessionSync = createSessionSync({
	api: rigTestApi,
	auth: {
		online: () => !authStore.state.offline && !!authStore.state.accessToken,
		accessToken: () => authStore.state.accessToken,
		expiresAt: () => authStore.state.expiresAt,
		refresh: () => authStore.refresh(),
	},
	now: () => Date.now(),
});

/** The app's one store. */
export const rigTest = createRigTestStore({
	api: rigTestApi, notify: desktopNotify, now: () => Date.now(), acceptContext: currentAcceptContext,
	session: sessionSync,
	onAuthChange: (cb) => watch(() => [authStore.state.accessToken, authStore.state.offline], cb),
});
```

Update the file's header comment: add a line "It also lends the operator's D1 sign-in to the recorder (rigTestSession.ts) on every pending poll."

- [ ] **Step 6: Run all web tests, typecheck, theme lint**

Run: `npx vitest run src/rigtest` then `npm test`, `npm run typecheck`, `npm run lint:theme`.
Expected: all pass. If importing `authStore` into `rigTestStore` breaks an existing test that imports the store module without a `localStorage`, add `vi.mock('../authStore', () => ({ authStore: { state: { accessToken: null, offline: false, expiresAt: 0 }, refresh: async () => false } }))` at the top of that test file.

- [ ] **Step 7: Commit**

```bash
git add apps/force-app/web/src/rigtest/
git commit -m "feat(force-app): lend the D1 sign-in to the recorder for rig tests and keep it fresh"
git push
```

---

### Task 6: Settings text and the end-to-end test

**Files:**
- Modify: `apps/force-app/web/src/settings/RigTestsSettings.vue` (lines ~51–54)
- Modify: `apps/force-app/web/e2e/rig-tests.spec.ts`

**Interfaces:**
- Consumes: Task 4's `relayInfo` texts and Task 5's store wiring.

- [ ] **Step 1: Update the e2e stub and add the failing check**

In `rig-tests.spec.ts`:
- Add `sessions: any[]` to `interface Stub` and `sessions: []` to its initial value.
- In the route handler, before the final 404, add:

```ts
		if (path === '/rig-tests/session') { s.sessions.push(req.method() === 'PUT' ? req.postDataJSON() : 'DELETE'); return json({ ok: true }); }
```

- The `/rig-tests/pending` stub returns `{ requests: s.pending, snoozed: s.snoozed, busy: s.phase !== 'idle', session: s.sessions.length > 0, hardware_ok: true, relay: 'ok' }`, and `/rig-tests/eligibility` returns `{ eligible: true, rig_id: 'rig-e2e', relay: 'ok', session: true, hardware_ok: true }`.
- New test:

```ts
test('the signed-in D1 token is lent to the recorder', async ({ page }) => {
	const s = await setup(page);
	await page.goto('/settings?tab=general');
	await expect.poll(() => s.sessions.length).toBeGreaterThan(0);
	expect(s.sessions[0]).toMatchObject({ access_token: 'fake', expires_at: expect.any(Number) });
});
```

- [ ] **Step 2: Remove the token instructions from Settings**

In `RigTestsSettings.vue`, delete the whole `<span v-if="elig && !elig.eligible && elig.reason?.includes('token')" class="sub"> … </span>` block (the paragraph about `rig_test_token` and `FORCE_APP_RIG_TEST_TOKEN`). The signed-out reason from the backend ("Sign in to D1 online to receive rig-test requests") is already shown by the `elig.reason` span above it, and the relay row shows `relayInfo`'s sign-in texts.

- [ ] **Step 3: Run the e2e suite and the unit suite**

Run (from `apps/force-app/web`): `npx playwright test e2e/rig-tests.spec.ts` (install browsers first if prompted: `npx playwright install chromium`), then `npm test` and `npm run typecheck`.
Expected: 6 of 6 e2e pass; unit suite and typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add apps/force-app/web/src/settings/RigTestsSettings.vue apps/force-app/web/e2e/rig-tests.spec.ts
git commit -m "feat(force-app): Settings drops the rig-token instructions; e2e checks the D1 token is lent"
git push
```

---

### Task 7: Docs, runbook and the final check

**Files:**
- Modify: `docs/runbooks/physical-test-backlog.md` (§C "Rig test relay settings", ~lines 1270–1291; §B if it mentions the token)
- Modify: `docs/superpowers/specs/2026-10-11-rig-test-requests-design.md` (status header only)
- Modify: `docs/superpowers/plans/2026-10-11-rig-test-requests-phase1.md` only if it is linked as current guidance for the token (add a one-line pointer, don't rewrite history)

- [ ] **Step 1: Rewrite the runbook §C item**

Replace the "Rig test relay settings" item with:

```markdown
- [ ] **Rig test relay settings.** In the relay's environment on d1-server, set
  `RIG_TEST_ALLOWED_LOGINS=dpremoli,dennis-premoli-staff` (GitHub logins allowed to request rig
  tests). No token: callers sign in with D1. Remove any leftover `RIG_TEST_RELAY_TOKEN` line from
  `.env`, and delete `%LOCALAPPDATA%\force-app\rig_test_token` on any PC that has one. Redeploy
  `bug-report-relay` (`docker compose up -d --build --no-deps bug-report-relay`). Optionally set
  `FORCE_APP_RIG_ID` on a rig laptop; without it the rig id is just `rig`. Check:
  - `GET /bug-report-relay/rig-tests` over Tailscale with no `Authorization` header, or with
    `Authorization: Bearer made-up`, is refused with 403 `D1 sign-in rejected`. With a real D1
    access token (copy one from the force app's DevTools, `localStorage['force-app.auth']`) it
    returns `{"ok": true, ...}`, and the relay log names that D1 user.
  - Stop Directus for a moment: the same call gets 503 `D1 unavailable`.
  - An issue that an allowlisted login both wrote and labelled is listed. One written by anyone
    else is not, even if you label it.
  - A comment through `POST /rig-tests/<n>/comment` on an issue without the label is refused.
  - An attempt to PATCH the rig's result comment is refused.
  - On a laptop plugged into the rig, signed in online: Settings → Rig tests says the PC takes
    requests. Signed in offline, or signed out: it says "Sign in to D1 online to receive rig-test
    requests", and the PC never polls. Left idle on the rig for more than 15 minutes, it keeps
    taking requests (the token is refreshed early).
  - An issue with more than 100 events, for example one with many label changes, is still
    listed, because the latest labeller is found from the last page.

  Since the rig test requests PR; sign-in check since the D1 login PR (#248).
```

Then `Select-String docs/runbooks/physical-test-backlog.md -Pattern "rig token|X-Rig|RIG_TEST_RELAY|FORCE_APP_RIG_TEST_TOKEN|rig_test_token"` must only match the cleanup sentence above; fix any §B line that still tells an operator to set a token.

- [ ] **Step 2: Point the phase-1 spec at the amendment**

In `docs/superpowers/specs/2026-10-11-rig-test-requests-design.md`, after the `**Status:**` line add:

```markdown
**Amended 2026-10-12:** the shared rig token described below (`X-Rig-Token`,
`RIG_TEST_RELAY_TOKEN`, `FORCE_APP_RIG_TEST_TOKEN`) is replaced by the operator's D1 sign-in; see
[`2026-10-12-rig-test-d1-login-design.md`](2026-10-12-rig-test-d1-login-design.md).
```

- [ ] **Step 3: Final repo-wide check for leftovers**

Run from the worktree root:
`git grep -n -E "RIG_TEST_RELAY_TOKEN|FORCE_APP_RIG_TEST_TOKEN|X-Rig-Token|rig_test_token|token_rejected"`
Expected: matches only in the ADR's amendment note, the phase-1 spec/plan (historical, with the pointer), the new spec, the runbook cleanup sentence, the relay test's deliberate `X-Rig-Token` case, and `test_rig_test_session.py`'s "old token is ignored" test.

- [ ] **Step 4: Full verification**

- Backend: `& $PY -m pytest -q`; ruff check + format check.
- Relay: the Docker pytest command; ruff.
- Web: `npm test`, `npm run typecheck`, `npm run lint:theme`, `npm run build`, `npx playwright test e2e/rig-tests.spec.ts`.
- Desktop: `npm test` and `npm run typecheck` from `apps/force-app/desktop` (nothing should change there; this confirms it).

Record the pass counts for the PR description.

- [ ] **Step 5: Commit, update the PR**

```bash
git add docs/
git commit -m "docs(rig-test): runbook and phase-1 spec follow the D1 sign-in change"
git push
```

Update draft PR #248's description: what changed per part, the pass counts, and the deploy steps (merge → redeploy relay → next force-app release → remove `RIG_TEST_RELAY_TOKEN` from d1-server `.env` and delete `%LOCALAPPDATA%\force-app\rig_test_token` on d1-server). Mark it ready for review only when the maintainer says so. Deploying the relay and releasing the app are the maintainer's call.
