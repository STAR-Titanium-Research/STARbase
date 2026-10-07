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

If any of the App ID / private key / installation ID is missing, /report fails closed with a
clear "not configured" reason rather than raising — callers should surface that as a runtime
message, not a crash, since misconfiguration here shouldn't take down a client's error-reporting
attempt with a 500.
"""

from __future__ import annotations

import calendar
import os
import time
from typing import Annotated

import httpx
import jwt
from fastapi import FastAPI
from pydantic import BaseModel, Field

GITHUB_API = "https://api.github.com"
DEFAULT_REPO = "dpremoli/D1-Database"

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
        async with httpx.AsyncClient(timeout=15.0) as client:
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

    try:
        res = await _github(
            "POST",
            f"{GITHUB_API}/repos/{_repo()}/issues",
            json={"title": title[:250], "body": req.body, "labels": req.labels},
        )
    except _AuthError as e:
        return {"ok": False, "reason": f"could not authenticate with GitHub: {e}"}
    except httpx.HTTPError as e:
        return {"ok": False, "reason": f"could not reach GitHub: {e}"}

    if res.status_code >= 300:
        detail = ""
        try:
            detail = res.json().get("message", "")
        except ValueError:
            pass
        return {
            "ok": False,
            "reason": f"GitHub rejected the report (HTTP {res.status_code}) {detail}".strip(),
        }

    data = res.json()
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
    try:
        res = await _github(
            "GET",
            f"{GITHUB_API}/repos/{_repo()}/issues",
            params={
                "labels": "in-app-report",
                "state": "all",
                "sort": "created",
                "direction": "desc",
                "per_page": 50,
            },
        )
    except _AuthError as e:
        return {"ok": False, "reason": f"could not authenticate with GitHub: {e}"}
    except httpx.HTTPError as e:
        return {"ok": False, "reason": f"could not reach GitHub: {e}"}

    if res.status_code >= 300:
        detail = ""
        try:
            detail = res.json().get("message", "")
        except ValueError:
            pass
        return {
            "ok": False,
            "reason": f"GitHub rejected the request (HTTP {res.status_code}) {detail}".strip(),
        }

    out = []
    for item in res.json():
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
                "labels": [
                    (label if isinstance(label, str) else label.get("name", ""))
                    for label in item.get("labels", [])
                ],
                "created_at": item.get("created_at"),
            }
        )
    return {"ok": True, "issues": out}
