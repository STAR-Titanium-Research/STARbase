"""Client for the bug-report relay's /rig-tests endpoints (apps/force-app/bug-report-relay).

The rig PC holds no GitHub credential: the relay does, and checks who labelled a request (ADR-0012).
Every call carries the signed-in operator's D1 access token as `Authorization: Bearer`, which the
relay checks with Directus. The web app lends that token to this process (`PUT /rig-tests/session`)
while its session is online; it lives in memory only, is never written to disk, logged, reported or
put in an error message, and is gone after a restart until the web app sends it again.
Every function here returns the relay's own `{"ok": ..., ...}` dict and never raises, so a relay
outage can only ever mean "nothing to show", never a crashed poller or a failed run. Callers use
`relay.<fn>(...)` through the module (not `from .relay import ...`) so tests can monkeypatch it.
"""

from __future__ import annotations

import re
import threading
import time
from urllib.parse import quote

import httpx

from .. import bug_report

TIMEOUT_S = 30.0  # GitHub can take a while under load; a poll never blocks a recording
STATES = ("deferred", "declined", "running", "partial", "done", "interrupted")
MAX_COMMENT = 60_000  # the relay's own limit
RESULT_MARKER = "<!-- rig-test-result "
SIGNED_OUT = "Sign in to D1 online to receive rig-test requests"
SIGNIN_REJECTED = "D1 sign-in rejected"  # the relay's reason, verbatim
# Printable ASCII only, so it is a legal header value whatever the web sent.
_TOKEN_RE = re.compile(r"[\x21-\x7e]{1,4096}")
_session_lock = threading.Lock()
_session = {
    "token": "",
    "expires_at": 0.0,
}  # expires_at: epoch ms, as the web's auth store keeps it
_SHORTENED = "\n\n(comment shortened to fit GitHub's size limit)\n\n"


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


def _call(method: str, path: str, body: dict | None = None) -> dict:
    base = bug_report._relay_url().rstrip("/")
    if not base:
        return {"ok": False, "reason": "relay not configured", "kind": "not_configured"}
    secret = _current_token()
    if not secret:
        return {"ok": False, "reason": SIGNED_OUT, "kind": "signed_out"}

    def scrub(e: Exception) -> str:  # an exception text must never carry the token
        return str(e).replace(secret, "<token>")

    try:
        res = httpx.request(
            method,
            f"{base}{path}",
            json=body,
            headers={"Authorization": f"Bearer {secret}"},
            timeout=TIMEOUT_S,
        )
        data = res.json()
    except httpx.HTTPError as e:
        return {
            "ok": False,
            "reason": f"could not reach the relay: {scrub(e)}",
            "kind": "unreachable",
        }
    except Exception as e:  # noqa: BLE001 - a bad body must not escape either
        return {
            "ok": False,
            "reason": f"unreadable relay answer: {scrub(e)}",
            "kind": "unreachable",
        }
    if not isinstance(data, dict):
        return {"ok": False, "reason": "unexpected relay answer", "kind": "unreachable"}
    if res.status_code == 403 and data.get("reason") == SIGNIN_REJECTED:
        clear_session(only=secret)
        return {"ok": False, "reason": SIGNIN_REJECTED, "kind": "signin_rejected"}
    if res.status_code == 503:  # Directus or the relay is down: wait, it is not a refusal
        return {
            "ok": False,
            "reason": str(data.get("reason") or "relay unavailable"),
            "kind": "unreachable",
        }
    if res.status_code >= 300 and data.get("ok") is not False:
        return {
            "ok": False,
            "reason": f"relay error (HTTP {res.status_code})",
            "kind": "unreachable",
        }
    return data


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


def list_requests() -> dict:
    """{ok, requests:[{number,title,body,url,requested_by,created_at,state_label}]}"""
    res = _call("GET", "/rig-tests")
    if res.get("ok") and not isinstance(res.get("requests"), list):
        return {"ok": False, "reason": "unexpected relay answer", "kind": "unreachable"}
    return res


def fit_comment(body: str) -> str:
    """`body` within the relay's size limit. report.render_result already shortens notes and the
    table to fit, so this is only the last resort; it cuts the head of the comment and keeps the
    hidden result JSON at the end whole, never the other way round."""
    if len(body) <= MAX_COMMENT:
        return body
    at = body.rfind(RESULT_MARKER)
    tail = body[at:] if at >= 0 else ""
    room = MAX_COMMENT - len(tail) - len(_SHORTENED)
    if room <= 0:  # the JSON alone is too big: nothing sensible is left to cut
        return body[:MAX_COMMENT]
    return body[:room].rstrip() + _SHORTENED + tail


def post_comment(number: int, body: str) -> dict:
    """{ok, id} for a new comment on rig-test issue `number`."""
    return _call("POST", f"/rig-tests/{int(number)}/comment", {"body": fit_comment(body)})


def edit_comment(number: int, comment_id: int | str, body: str) -> dict:
    path = f"/rig-tests/{int(number)}/comment/{quote(str(comment_id), safe='')}"
    return _call("PATCH", path, {"body": fit_comment(body)})


def set_state(number: int, state: str) -> dict:
    if state not in STATES:
        return {"ok": False, "reason": f"unknown state {state!r}"}
    return _call("POST", f"/rig-tests/{int(number)}/state", {"state": state})
