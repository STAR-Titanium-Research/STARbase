"""Rig test requests (ADR-0012, spec 2026-10-11): a GitHub issue asks the rig PC to run backlog
checks, the operator consents in the app, and the result goes back to the issue.

Phase 1 runs operator steps only (`ask`, `note`). `main.py` wires this in with `configure()`,
includes `router`, starts the poller from its lifespan, and passes `lock_guard` as an app-wide
dependency so the endpoints in `LOCKED` answer 409 while a run owns the rig.
"""

from __future__ import annotations

from fastapi import HTTPException
from starlette.requests import HTTPConnection

from .routes import configure, router, start_poller, stop_poller
from .runner import RESULTS_DIR, current_issue, owns_rig

# Endpoints that start a recording or change hardware, amp or storage state. Phase 1 runs make no
# recordings of their own, so there is no bypass: nothing may use the rig while a run holds it.
LOCKED = frozenset(
    {
        ("POST", "/record/start"),
        ("POST", "/record/start_replay"),
        ("POST", "/labamp/mode"),
        ("POST", "/labamp/autorange/apply"),
        ("POST", "/labamp/autorange/converge"),
        ("POST", "/labamp/sensors/write"),
        ("POST", "/labamp/config"),
        ("PUT", "/nidaq/channels"),
        ("POST", "/nidaq/tacho/start"),
        ("POST", "/storage/config"),
    }
)


def refuse_if_rig_test() -> None:
    """409 while a rig test owns the rig. Also called where a handler re-checks after an await."""
    if owns_rig():
        raise HTTPException(
            409,
            f"a rig test is running (issue #{current_issue()}); cancel it from the rig-test window",
        )


async def lock_guard(conn: HTTPConnection) -> None:
    """App-wide FastAPI dependency: one table (`LOCKED`) instead of a check in every handler."""
    if (conn.scope.get("method"), conn.scope["path"]) in LOCKED:
        refuse_if_rig_test()


__all__ = [
    "LOCKED",
    "RESULTS_DIR",
    "configure",
    "lock_guard",
    "refuse_if_rig_test",
    "router",
    "start_poller",
    "stop_poller",
]
