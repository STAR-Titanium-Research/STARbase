"""Rig test requests (ADR-0012, spec 2026-10-11): a GitHub issue asks the rig PC to run backlog
checks, the operator consents in the app, and the result goes back to the issue.

Phase 1 runs operator steps only (`ask`, `note`). `main.py` wires this in with `configure()`,
includes `router`, starts the poller from its lifespan, and passes `lock_guard` as an app-wide
dependency so the endpoints in `LOCKED` answer 409 while an automated step is executing. Phase 1
has none, so the lock never engages and the operator can use the rig during manual steps.
"""

from __future__ import annotations

from fastapi import HTTPException
from starlette.requests import HTTPConnection

from .routes import configure, router, start_poller, stop_poller
from .runner import RESULTS_DIR, automated_step_active, current_issue

# Endpoints that start a recording or change hardware, amp or storage state. They are refused only
# while an *automated* step is executing (`automated_step_active()`): the operator's own manual
# steps (`ask`, `note`) need the rig free. Handlers that re-check after an await, and
# `_refuse_nidaq_change_if_busy()`, also call `refuse_if_rig_test()`, so the check does not depend
# on this table alone.
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
        ("POST", "/nidaq/channels/autoassign"),
        ("POST", "/nidaq/tacho/start"),
        ("POST", "/storage/config"),
    }
)


def refuse_if_rig_test() -> None:
    """409 while an automated rig-test step is executing. Also called where a handler re-checks
    after an await."""
    if automated_step_active():
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
