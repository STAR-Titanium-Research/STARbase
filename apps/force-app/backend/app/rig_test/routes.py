"""The /rig-tests REST surface (loopback only, like every other route) and the wiring of the
poller and runner to the rest of the backend.

`main.py` calls `configure(...)` once with the few things this package needs from it (device
enumeration, the Lab Amp client, the recording check, the folders), so nothing here imports `main`.
"""

from __future__ import annotations

import glob
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import bug_report, recovery
from . import eligibility, runner
from .poller import RigTestPoller, StateFile
from .runner import AnswerRejectedError, RigTestRunner, RunnerBusyError

router = APIRouter(prefix="/rig-tests", tags=["rig-tests"])

STATE_FILE = "rig_tests_state.json"
HISTORY_LIMIT = 50


@dataclass
class _Wiring:
    is_busy: Callable[[], bool]
    captures_root: Callable[[], str]
    poller: RigTestPoller
    runner: RigTestRunner
    eligible: Callable[[], tuple[bool, str | None]]


_w: _Wiring | None = None


def configure(
    *,
    devices: Callable[[], dict],
    labamp: Callable[[], object],
    is_busy: Callable[[], bool],
    captures_root: Callable[[], str],
    config_dir: str,
    poll_interval_s: float | None = None,
) -> None:
    global _w
    store = StateFile(os.path.join(config_dir, STATE_FILE))
    rig_runner = RigTestRunner(
        captures_root=captures_root,
        rig_id=eligibility.rig_id,
        on_active=lambda n: store.update(active_run=n),
    )
    runner.install(rig_runner)
    interval = poll_interval_s or float(os.environ.get("FORCE_APP_RIG_TEST_POLL_S", "60"))

    def eligible() -> tuple[bool, str | None]:
        return eligibility.check(devices(), labamp())

    poller = RigTestPoller(
        store=store,
        eligible=eligible,
        is_busy=is_busy,
        owns_rig=runner.owns_rig,
        rig_id=eligibility.rig_id,
        interval_s=interval,
    )
    _w = _Wiring(is_busy, captures_root, poller, rig_runner, eligible)


def start_poller() -> None:
    if _w:
        _w.poller.start()


def stop_poller() -> None:
    if _w:
        _w.poller.stop()


def _wiring() -> _Wiring:
    if _w is None:
        raise HTTPException(503, "rig tests are not set up")
    return _w


# ---- request bodies --------------------------------------------------------------------------


class AcceptBody(BaseModel):
    mode: Literal["full"] = "full"  # "automated" arrives with phase 2
    upload_busy: bool = False
    # Not in the web contract's required fields; the renderer may send them to name the operator
    # in the report and the app version it is running.
    operator: str = Field("", max_length=120)
    app_version: str = Field("", max_length=40)


class SnoozeBody(BaseModel):
    until: str = Field(max_length=64)


class DeclineBody(BaseModel):
    reason_code: Literal[
        "about_to_record", "machine_in_use", "rig_not_set_up", "not_today", "other"
    ]
    text: str | None = Field(None, max_length=300)


class AnswerBody(BaseModel):
    step: int
    option: str = Field(max_length=80)
    note: str | None = Field(None, max_length=1000)


# ---- routes ----------------------------------------------------------------------------------


@router.get("/eligibility")
async def get_eligibility() -> dict:
    w = _wiring()
    ok, reason = await run_in_threadpool(w.eligible)
    out: dict = {
        "eligible": ok,
        "rig_id": eligibility.rig_id(),
        "relay": w.poller.relay_state if bug_report.configured() else "not_configured",
    }
    if reason:
        out["reason"] = reason
    return out


@router.get("/pending")
async def get_pending() -> dict:
    w = _wiring()
    return {
        "requests": w.poller.pending(),
        "snoozed": w.poller.snoozed(),
        # The condition accept refuses on, so a web UI whose own status poll is stale stays in
        # badge mode instead of opening a dialog over a recording.
        "busy": w.is_busy() or recovery.any_in_flight(),
    }


@router.post("/{n}/accept")
async def accept(n: int, body: AcceptBody) -> dict:
    w = _wiring()
    ok, reason = await run_in_threadpool(w.eligible)
    # No await from here to runner.start(): the checks and the claim are one step, so a recording
    # cannot start in between (the same rule as /record/start's busy check).
    if not ok:
        raise HTTPException(409, f"this PC is not the rig: {reason}")
    if w.runner.owns_rig():
        raise HTTPException(
            409, f"a rig test is already running (issue #{w.runner.current_issue()})"
        )
    if w.is_busy():
        raise HTTPException(409, "a recording is in progress or still being saved")
    if recovery.any_in_flight():
        raise HTTPException(409, "a restore, recovery or discard is in progress")
    if body.upload_busy:
        raise HTTPException(409, "an upload is in progress; try again when it has finished")
    request = w.poller.get(n)
    if request is None:
        raise HTTPException(404, f"no pending rig test request #{n}")
    try:
        w.runner.start(request, {"operator": body.operator, "app_version": body.app_version})
    except RunnerBusyError:
        raise HTTPException(409, "a rig test is already running") from None
    w.poller.mark_accepted(n)
    return {"ok": True}


@router.post("/{n}/snooze")
async def snooze(n: int, body: SnoozeBody) -> dict:
    w = _wiring()
    if w.poller.get(n) is None:
        raise HTTPException(404, f"no pending rig test request #{n}")
    try:
        await run_in_threadpool(w.poller.snooze, n, body.until)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return {"ok": True}


@router.post("/{n}/decline")
async def decline(n: int, body: DeclineBody) -> dict:
    w = _wiring()
    if w.poller.get(n) is None:
        raise HTTPException(404, f"no pending rig test request #{n}")
    await run_in_threadpool(w.poller.decline, n, body.reason_code, body.text)
    return {"ok": True}


@router.get("/run")
async def get_run() -> dict:
    return _wiring().runner.snapshot()


@router.post("/run/answer")
async def answer(body: AnswerBody) -> dict:
    try:
        _wiring().runner.answer(body.step, body.option, body.note)
    except AnswerRejectedError as e:
        raise HTTPException(409 if e.conflict else 400, str(e)) from None
    return {"ok": True}


@router.post("/run/cancel")
async def cancel() -> dict:
    _wiring().runner.cancel()
    return {"ok": True}


def _summary(data: dict) -> dict:
    counts = data.get("counts", {})
    return {
        "number": data.get("number"),
        "title": data.get("title", ""),
        "url": data.get("url", ""),
        "state": data.get("state"),
        "started_at": data.get("started_at"),
        "finished_at": data.get("finished_at"),
        "rig": data.get("rig"),
        "app_version": data.get("app_version"),
        "pass": counts.get("pass", 0),
        "fail": counts.get("fail", 0),
        "total": sum(counts.values()),
        "counts": counts,
        "items": [{"id": i["id"], "result": i["result"]} for i in data.get("items", [])],
    }


def _read_history(root: str) -> list[dict]:
    runs = []
    for path in glob.glob(os.path.join(root, runner.RESULTS_DIR, "*", "result.json")):
        try:
            with open(path, encoding="utf-8") as f:
                runs.append(_summary(json.load(f)))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    runs.sort(key=lambda r: str(r["started_at"]), reverse=True)
    return runs[:HISTORY_LIMIT]


@router.get("/history")
async def history() -> dict:
    w = _wiring()
    return {"runs": await run_in_threadpool(_read_history, w.captures_root())}
