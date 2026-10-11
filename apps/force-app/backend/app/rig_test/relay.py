"""Client for the bug-report relay's /rig-tests endpoints (apps/force-app/bug-report-relay).

The rig PC holds no GitHub credential: the relay does, and checks who labelled a request (ADR-0012).
Every function here returns the relay's own `{"ok": ..., ...}` dict and never raises, so a relay
outage can only ever mean "nothing to show", never a crashed poller or a failed run. Callers use
`relay.<fn>(...)` through the module (not `from .relay import ...`) so tests can monkeypatch it.
"""

from __future__ import annotations

from urllib.parse import quote

import httpx

from .. import bug_report

TIMEOUT_S = 30.0  # GitHub can take a while under load; a poll never blocks a recording
STATES = ("deferred", "declined", "running", "partial", "done", "interrupted")
MAX_COMMENT = 60_000  # the relay's own limit
RESULT_MARKER = "<!-- rig-test-result "
_SHORTENED = "\n\n(comment shortened to fit GitHub's size limit)\n\n"


def _call(method: str, path: str, body: dict | None = None) -> dict:
    base = bug_report._relay_url().rstrip("/")
    if not base:
        return {"ok": False, "reason": "relay not configured", "kind": "not_configured"}
    try:
        res = httpx.request(method, f"{base}{path}", json=body, timeout=TIMEOUT_S)
        data = res.json()
    except httpx.HTTPError as e:
        return {"ok": False, "reason": f"could not reach the relay: {e}", "kind": "unreachable"}
    except Exception as e:  # noqa: BLE001 - a bad body must not escape either
        return {"ok": False, "reason": f"unreadable relay answer: {e}", "kind": "unreachable"}
    if not isinstance(data, dict):
        return {"ok": False, "reason": "unexpected relay answer", "kind": "unreachable"}
    if res.status_code >= 300 and data.get("ok") is not False:
        return {
            "ok": False,
            "reason": f"relay error (HTTP {res.status_code})",
            "kind": "unreachable",
        }
    return data


def relay_status(result: dict) -> str:
    """'ok' | 'unreachable' | 'not_configured' for the Settings tab, from one relay answer."""
    if result.get("ok"):
        return "ok"
    if result.get("kind") == "not_configured" or "not configured" in str(result.get("reason", "")):
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
