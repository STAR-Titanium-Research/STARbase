"""Client for the bug-report relay's /rig-tests endpoints (apps/force-app/bug-report-relay).

The rig PC holds no GitHub credential: the relay does, and checks who labelled a request (ADR-0012).
Every function here returns the relay's own `{"ok": ..., ...}` dict and never raises, so a relay
outage can only ever mean "nothing to show", never a crashed poller or a failed run. Callers use
`relay.<fn>(...)` through the module (not `from .relay import ...`) so tests can monkeypatch it.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from .. import bug_report

log = logging.getLogger("force_app.rig_test")

TIMEOUT_S = 10.0
STATES = ("deferred", "declined", "running", "partial", "done", "interrupted")
_MAX_COMMENT = 60_000  # the relay's own limit


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


def post_comment(number: int, body: str) -> dict:
    """{ok, id} for a new comment on rig-test issue `number`."""
    return _call("POST", f"/rig-tests/{int(number)}/comment", {"body": body[:_MAX_COMMENT]})


def edit_comment(number: int, comment_id: int | str, body: str) -> dict:
    path = f"/rig-tests/{int(number)}/comment/{quote(str(comment_id), safe='')}"
    return _call("PATCH", path, {"body": body[:_MAX_COMMENT]})


def set_state(number: int, state: str) -> dict:
    if state not in STATES:
        return {"ok": False, "reason": f"unknown state {state!r}"}
    return _call("POST", f"/rig-tests/{int(number)}/state", {"state": state})
