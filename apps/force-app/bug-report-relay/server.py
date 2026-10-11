"""Relay that creates GitHub issues on behalf of force-app clients.

Deployed on d1-server alongside the rest of the stack, behind Caddy's Tailscale-only entry point
(see infra/caddy/Caddyfile) — like backup-server, it has no authentication of its own and relies
entirely on the fact that only tailnet members can reach it. This is the point of the service: the
GitHub App private key lives here, centrally, instead of on every acquisition PC that ships the
force-app backend. Clients POST a ready-made {title, body, labels} to /report; this process mints
a short-lived GitHub App installation token and creates the issue.

Configure via env vars:

    GITHUB_APP_ID                  numeric App ID
    GITHUB_APP_PRIVATE_KEY_PATH    path to the App's private key .pem (preferred — mount as a file)
    GITHUB_APP_PRIVATE_KEY         PEM content inline (fallback if a file mount isn't practical;
                                    literal "\n" sequences are unescaped since most env-var
                                    mechanisms can't carry real newlines)
    GITHUB_APP_INSTALLATION_ID     installation ID from installing the App on the target repo
    GITHUB_REPO                    "owner/repo", defaults to this monorepo
    RIG_TEST_ALLOWED_LOGINS        comma-separated GitHub logins (case-insensitive) allowed to
                                    request rig tests; empty = rig tests off

Rig test requests (ADR-0012, docs/superpowers/specs/2026-10-11-rig-test-requests-design.md). The
app on the rig PC polls these; none of them runs anything here:

    GET   /rig-tests                       open issues labelled "rig-test-request" whose label was
                                           last applied by an allowlisted login and that an
                                           allowlisted login opened (30 s cache)
    POST  /rig-tests/{n}/comment           {body} -> {ok, id}; comment on a rig-test issue
    PATCH /rig-tests/{n}/comment/{id}      {body}; edits only a comment this App created there
    POST  /rig-tests/{n}/state             {state}; sets one "rig-test:<state>" label, drops the
                                           others (deferred|declined|running|partial|done|
                                           interrupted)

Trust: a command is trusted by its GitHub authorship (who opened the issue and who applied the
label: both must be allowlisted, since the author can edit the block after the label is on), never
by who called the relay. The relay has no auth of its own, so anyone on the tailnet can call these endpoints;
the worst they can do is post or label on an issue that is already an allowlisted rig-test
request. Every write re-checks that the issue is open, is not a PR, carries the label, was
opened by an allowlisted login and was labelled by one. With RIG_TEST_ALLOWED_LOGINS empty, or the App unconfigured, all
of them answer {"ok": false, "reason": "rig tests not configured"}.

If any of the App ID / private key / installation ID is missing, /report fails closed with a
clear "not configured" reason rather than raising — callers should surface that as a runtime
message, not a crash, since misconfiguration here shouldn't take down a client's error-reporting
attempt with a 500.
"""

from __future__ import annotations

import calendar
import functools
import logging
import os
import time
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
import jwt
from fastapi import FastAPI
from pydantic import BaseModel, Field

GITHUB_API = "https://api.github.com"
DEFAULT_REPO = "dpremoli/D1-Database"

log = logging.getLogger("bug-report-relay")

app = FastAPI()


def _app_id() -> str:
    return os.environ.get("GITHUB_APP_ID", "")


def _private_key() -> str:
    path = os.environ.get("GITHUB_APP_PRIVATE_KEY_PATH", "")
    if path and os.path.isfile(path):
        with open(path) as f:
            return f.read()
    return os.environ.get("GITHUB_APP_PRIVATE_KEY", "").replace("\\n", "\n")


def _installation_id() -> str:
    return os.environ.get("GITHUB_APP_INSTALLATION_ID", "")


def _repo() -> str:
    return os.environ.get("GITHUB_REPO", DEFAULT_REPO)


def configured() -> bool:
    return bool(_app_id() and _private_key() and _installation_id())


def _mint_jwt() -> str:
    now = int(time.time())
    payload = {
        "iat": now - 60,  # clock drift between this host and GitHub's
        "exp": now + 540,  # GitHub caps this at 10 minutes
        "iss": _app_id(),
    }
    return jwt.encode(payload, _private_key(), algorithm="RS256")


class _TokenCache:
    """Installation access tokens last ~1h; minting a fresh JWT + exchange on every issue would
    work but adds two network round-trips to every report for no reason, so cache and refresh
    with a safety margin before the real expiry."""

    def __init__(self) -> None:
        self.token = ""
        self.expires_at = 0.0

    async def get(self) -> str:
        if self.token and time.time() < self.expires_at - 300:
            return self.token
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{GITHUB_API}/app/installations/{_installation_id()}/access_tokens",
                headers={
                    "Authorization": f"Bearer {_mint_jwt()}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
        res.raise_for_status()
        data = res.json()
        self.token = data["token"]
        # GitHub's expires_at is UTC: timegm, not mktime (which would read it as local time and be
        # off by the host's UTC offset).
        self.expires_at = float(
            calendar.timegm(time.strptime(data["expires_at"], "%Y-%m-%dT%H:%M:%SZ"))
        )
        return self.token

    def clear(self) -> None:
        self.token = ""
        self.expires_at = 0.0


_token_cache = _TokenCache()


class _AuthError(Exception):
    """Minting or exchanging the installation token failed (as opposed to the API call itself)."""


async def _github(method: str, url: str, **kwargs) -> httpx.Response:
    """One authenticated GitHub call. A 401 means the cached installation token was revoked or
    expired early (clock skew, App reinstalled), so drop it and retry ONCE with a fresh one rather
    than failing every report until the cache's own expiry. Raises _AuthError if the token can't be had, else httpx.HTTPError like httpx."""
    res: httpx.Response | None = None
    for attempt in (1, 2):
        try:
            token = await _token_cache.get()
        except httpx.HTTPError as e:
            raise _AuthError(str(e)) from e
        # A renamed or transferred repo answers with a redirect to /repositories/<id> (307 for a
        # POST, which keeps the method and body). Same host, so httpx keeps the Authorization.
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            res = await client.request(
                method,
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                **kwargs,
            )
        if res.status_code != 401 or attempt == 2:
            break
        _token_cache.clear()
    assert res is not None
    return res


def _repo_path(suffix: str) -> str:
    return f"/repos/{_repo()}{suffix}"


def _failure(reason: str) -> dict:
    return {"ok": False, "reason": reason}


async def _gh(
    method: str,
    path: str,
    *,
    what: str = "request",
    allow: tuple[int, ...] = (),
    **kwargs,
) -> tuple[object, dict | None]:
    """_github plus the never-raise contract: returns (parsed JSON or None, None) on success, or
    (None, {"ok": False, "reason": ...}) when authentication, the network or GitHub failed.
    Statuses in `allow` count as success (their body is still returned)."""
    try:
        res = await _github(method, f"{GITHUB_API}{path}", **kwargs)
    except _AuthError as e:
        return None, _failure(f"could not authenticate with GitHub: {e}")
    except httpx.HTTPError as e:
        return None, _failure(f"could not reach GitHub: {e}")
    try:
        data = res.json()
    except ValueError:
        data = None
    if res.status_code >= 300 and res.status_code not in allow:
        detail = data.get("message", "") if isinstance(data, dict) else ""
        return None, _failure(
            f"GitHub rejected the {what} (HTTP {res.status_code}) {detail}".strip()
        )
    return data, None


_Label = Annotated[str, Field(max_length=100)]


class ReportRequest(BaseModel):
    # Bounded like body/labels so an unbounded payload is not buffered in full before the GitHub
    # call; the call site still truncates to GitHub's own 250-character limit.
    title: str = Field(max_length=1000)
    body: str = Field(max_length=100_000)
    labels: list[_Label] = Field(default_factory=list, max_length=20)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "configured": configured()}


@app.post("/report")
async def report(req: ReportRequest) -> dict:
    """Returns {"ok": True, "url": ..., "number": ...} or {"ok": False, "reason": ...}. Never raises
    — callers render "reason" directly to the user, so a 500 here would just show as a worse
    message for no benefit."""
    if not configured():
        return {
            "ok": False,
            "reason": "Bug reporting relay is not configured (missing GitHub App credentials).",
        }
    title = req.title.strip()
    if not title:
        return {"ok": False, "reason": "A title is required."}

    data, err = await _gh(
        "POST",
        _repo_path("/issues"),
        what="report",
        json={"title": title[:250], "body": req.body, "labels": req.labels},
    )
    if err:
        return err
    data = data if isinstance(data, dict) else {}
    return {"ok": True, "url": data.get("html_url", ""), "number": data.get("number")}


@app.get("/issues")
async def issues() -> dict:
    """Recent in-app-reported issues, for the app's own "has this already been reported" list.

    Returns {"ok": True, "issues": [...]} or {"ok": False, "reason": ...}. Never raises — same
    contract as /report. Scoped to the in-app-report label (not just force-app) so this never
    leaks unrelated repo issues to a client that only asked about its own bug reports.
    """
    if not configured():
        return {
            "ok": False,
            "reason": "Bug reporting relay is not configured (missing GitHub App credentials).",
        }
    data, err = await _gh(
        "GET",
        _repo_path("/issues"),
        params={
            "labels": "in-app-report",
            "state": "all",
            "sort": "created",
            "direction": "desc",
            "per_page": 50,
        },
    )
    if err:
        return err

    out = []
    for item in data if isinstance(data, list) else []:
        if (
            "pull_request" in item
        ):  # the issues endpoint also returns PRs; this repo files none
            continue  # with these labels, but skip defensively rather than assume
        out.append(
            {
                "number": item.get("number"),
                "title": item.get("title", ""),
                "url": item.get("html_url", ""),
                "state": item.get("state", ""),
                "labels": _label_names(item),
                "created_at": item.get("created_at"),
            }
        )
    return {"ok": True, "issues": out}


# ---------------------------------------------------------------------------------------------
# Rig test requests (ADR-0012). A request is an open issue labelled RIG_LABEL whose label was
# applied by a login on RIG_TEST_ALLOWED_LOGINS. The relay is the only place that check happens.

RIG_LABEL = "rig-test-request"
STATE_PREFIX = "rig-test:"
RigState = Literal["deferred", "declined", "running", "partial", "done", "interrupted"]
_LIST_TTL_S = 30.0
_EVENT_PAGES_MAX = (
    10  # 1000 events on one issue; beyond that fail closed rather than guess
)


def _allowed_logins() -> frozenset[str]:
    raw = os.environ.get("RIG_TEST_ALLOWED_LOGINS", "")
    return frozenset(p.strip().lower() for p in raw.split(",") if p.strip())


def _is_allowed(login: str | None) -> bool:
    return (login or "").lower() in _allowed_logins()


def _author(issue: dict) -> str | None:
    """Login of whoever opened the issue. Anyone who can open an issue can later edit its body,
    so a request is only trusted if its author is allowlisted as well as its labeller."""
    user = issue.get("user")
    login = user.get("login") if isinstance(user, dict) else None
    return login if isinstance(login, str) else None


def _rig_gate() -> dict | None:
    """Fail closed: no allowlist, or no GitHub App, means no rig-test endpoint does anything."""
    if not _allowed_logins() or not configured():
        return _failure("rig tests not configured")
    return None


def _never_raise(fn):
    """The rig-test endpoints are polled by the backend, which renders "reason" as is; an
    unexpected GitHub payload shape must not turn into a 500."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except Exception:
            log.exception("rig-test endpoint failed")
            return _failure("unexpected error in the relay")

    return wrapper


def _label_names(issue: dict) -> list[str]:
    return [
        (lb if isinstance(lb, str) else (lb or {}).get("name", ""))
        for lb in issue.get("labels") or []
    ]


async def _labeller(n: int) -> tuple[str | None, dict | None]:
    """Login that most recently applied RIG_LABEL to issue n ("" if GitHub shows no actor, None
    if never). Events come oldest first, so every page is read and the last match wins."""
    last: str | None = None
    for page in range(1, _EVENT_PAGES_MAX + 1):
        events, err = await _gh(
            "GET",
            _repo_path(f"/issues/{n}/events"),
            params={"per_page": 100, "page": page},
        )
        if err:
            return None, err
        if not isinstance(events, list):
            return None, _failure("unexpected reply from GitHub")
        for e in events:
            if (
                isinstance(e, dict)
                and e.get("event") == "labeled"
                and ((e.get("label") or {}).get("name") or "").lower() == RIG_LABEL
            ):
                last = (e.get("actor") or {}).get("login") or ""
        if len(events) < 100:
            return last, None
    return None, _failure(f"issue #{n} has too many events to verify")


async def _rig_issue(n: int) -> tuple[dict | None, dict | None]:
    """Issue n if it is an open, non-PR issue carrying RIG_LABEL, opened by an allowlisted login
    and labelled by one; otherwise a refusal. Every write endpoint goes through this, so the relay cannot be used to
    comment on or relabel anything that is not a legitimate rig-test request."""
    issue, err = await _gh("GET", _repo_path(f"/issues/{n}"), allow=(404,))
    if err:
        return None, err
    refusal = _failure(f"issue #{n} is not an open rig-test request")
    if (
        not isinstance(issue, dict)
        or issue.get("state") != "open"
        or "pull_request" in issue
        or RIG_LABEL not in (name.lower() for name in _label_names(issue))
    ):
        return None, refusal
    if not _is_allowed(_author(issue)):
        return None, refusal
    login, err = await _labeller(n)
    if err:
        return None, err
    if not _is_allowed(login):
        return None, refusal
    return issue, None


_list_cache: dict = {"key": None, "expires": 0.0, "requests": []}


@app.get("/rig-tests")
@_never_raise
async def rig_tests() -> dict:
    """Pending rig-test requests, or {"ok": False, "reason": ...}. An issue is listed only if its
    author and the login that most recently applied the label are both allowlisted. Cached for
    30 s."""
    if (gate := _rig_gate()) is not None:
        return gate
    allowed = _allowed_logins()
    if _list_cache["key"] == allowed and time.monotonic() < _list_cache["expires"]:
        return {"ok": True, "requests": _list_cache["requests"]}

    items, err = await _gh(
        "GET",
        _repo_path("/issues"),
        params={"labels": RIG_LABEL, "state": "open", "per_page": 50},
    )
    if err:
        return err
    out = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or "pull_request" in item:
            continue
        n = item.get("number")
        if not isinstance(n, int):
            continue
        if not _is_allowed(_author(item)):
            log.info(
                "rig-test #%s ignored: opened by %r, not on the allowlist",
                n,
                _author(item),
            )
            continue
        login, err = await _labeller(n)
        if err:
            return err
        if not _is_allowed(login):
            log.info(
                "rig-test #%s ignored: label applied by %r, not on the allowlist",
                n,
                login,
            )
            continue
        states = [
            x[len(STATE_PREFIX) :]
            for x in _label_names(item)
            if x.startswith(STATE_PREFIX)
        ]
        out.append(
            {
                "number": n,
                "title": item.get("title", ""),
                "body": item.get("body") or "",
                "url": item.get("html_url", ""),
                "requested_by": login,
                "created_at": item.get("created_at"),
                "state_label": states[0] if states else None,
            }
        )
    _list_cache.update(
        key=allowed, expires=time.monotonic() + _LIST_TTL_S, requests=out
    )
    return {"ok": True, "requests": out}


class CommentRequest(BaseModel):
    body: str = Field(min_length=1, max_length=60_000)


class StateRequest(BaseModel):
    state: RigState


@app.post("/rig-tests/{n}/comment")
@_never_raise
async def rig_test_comment(n: int, req: CommentRequest) -> dict:
    if (gate := _rig_gate()) is not None:
        return gate
    _, err = await _rig_issue(n)
    if err:
        return err
    data, err = await _gh(
        "POST",
        _repo_path(f"/issues/{n}/comments"),
        what="comment",
        json={"body": req.body},
    )
    if err:
        return err
    return {"ok": True, "id": (data or {}).get("id")}


_bot_login: dict[str, str] = {}


async def _app_bot_login() -> str:
    """ "<slug>[bot]", the login GitHub gives this App's comments. GET /app needs the App JWT, not
    an installation token, so it does not go through _gh. Cached for the process lifetime."""
    if "login" not in _bot_login:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(
                f"{GITHUB_API}/app",
                headers={
                    "Authorization": f"Bearer {_mint_jwt()}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
        res.raise_for_status()
        _bot_login["login"] = f"{res.json()['slug']}[bot]".lower()
    return _bot_login["login"]


async def _is_own_comment(comment: dict, n: int) -> bool:
    """True only for a comment on issue n that this App created. The author must be a Bot, and
    then GitHub's performed_via_github_app (when present) must be this App; if GitHub omits it,
    the bot login must be this App's "<slug>[bot]". A human's comment, or another App's, is never
    editable here."""
    if (
        not isinstance(comment, dict)
        or (comment.get("user") or {}).get("type") != "Bot"
    ):
        return False
    if not str(comment.get("issue_url") or "").endswith(f"/issues/{n}"):
        return False
    via = comment.get("performed_via_github_app")
    if isinstance(via, dict) and via.get("id") is not None:
        return str(via["id"]) == _app_id()
    login = str((comment.get("user") or {}).get("login") or "").lower()
    return login == await _app_bot_login()


@app.patch("/rig-tests/{n}/comment/{comment_id}")
@_never_raise
async def rig_test_edit_comment(n: int, comment_id: int, req: CommentRequest) -> dict:
    if (gate := _rig_gate()) is not None:
        return gate
    _, err = await _rig_issue(n)
    if err:
        return err
    path = _repo_path(f"/issues/comments/{comment_id}")
    comment, err = await _gh("GET", path, what="comment")
    if err:
        return err
    if not await _is_own_comment(comment, n):
        return _failure(f"comment {comment_id} is not a relay comment on issue #{n}")
    _, err = await _gh("PATCH", path, what="comment", json={"body": req.body})
    if err:
        return err
    return {"ok": True, "id": comment_id}


@app.post("/rig-tests/{n}/state")
@_never_raise
async def rig_test_state(n: int, req: StateRequest) -> dict:
    """Set the one rig-test:<state> label on issue n and remove the others."""
    if (gate := _rig_gate()) is not None:
        return gate
    issue, err = await _rig_issue(n)
    if err:
        return err
    want = f"{STATE_PREFIX}{req.state}"
    have = [x for x in _label_names(issue) if x.startswith(STATE_PREFIX)]
    if want not in have:
        # 422 = the label already exists in the repo, which is fine.
        _, err = await _gh(
            "POST",
            _repo_path("/labels"),
            what="label",
            allow=(422,),
            json={
                "name": want,
                "color": "ededed",
                "description": "Rig test request state",
            },
        )
        if err:
            return err
        _, err = await _gh(
            "POST",
            _repo_path(f"/issues/{n}/labels"),
            what="label",
            json={"labels": [want]},
        )
        if err:
            return err
    for stale in have:
        if stale != want:
            # 404 = someone removed it between our read and now.
            _, err = await _gh(
                "DELETE",
                _repo_path(f"/issues/{n}/labels/{quote(stale, safe='')}"),
                what="label",
                allow=(404,),
            )
            if err:
                return err
    _list_cache["expires"] = 0.0
    return {"ok": True, "state": req.state}
