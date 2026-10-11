"""Runs one accepted rig-test request, and owns the rig while it does (ADR-0012 §4).

One run at a time, in a daemon thread that walks the steps in order. Phase 1 has two kinds:
an `ask` waits for the operator's answer (up to ASK_TIMEOUT_S, then `no_response`); a `note`
waits for "Continue". A step whose `after` dependency did not pass is skipped. The whole run has
a hard limit of min(1.5 x its estimate, 30 min), and the operator can cancel at any time.

While a run is active `owns_rig()` is true and the lock (see `__init__`) refuses `/record/start`
and every hardware or storage write. The run itself makes no recordings in phase 1.

Clocks and timeouts are injected so the tests run in milliseconds. Every relay call is best
effort: a failure is logged and never changes how the run ends.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from datetime import datetime

from ..storage import atomic_write_json
from . import relay, report
from .catalog import NOTE_OPTIONS

log = logging.getLogger("force_app.rig_test")

ASK_TIMEOUT_S = 300.0
HARD_CAP_S = 30 * 60.0
HARD_CAP_FACTOR = 1.5
FINISHED_TTL_S = 300.0  # how long a finished run stays visible on GET /rig-tests/run
MAX_NOTE = 1000
RESULTS_DIR = "rig-tests"  # under the captures root: rig-tests/<n>/result.json


class RunnerBusyError(Exception):
    """A run is already active."""


class AnswerRejectedError(Exception):
    """The answer does not match the open question. `conflict` is True when no such question is
    open (HTTP 409), False when the option is not one of the choices (HTTP 400)."""

    def __init__(self, message: str, conflict: bool):
        super().__init__(message)
        self.conflict = conflict


def hard_cap_s(estimate_s: float) -> float:
    return min(HARD_CAP_FACTOR * estimate_s, HARD_CAP_S)


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


class _Run:
    """Everything about one run: the public record, the step specs and the waiting state."""

    def __init__(self, request: dict, meta: dict, clock: float, wall: float, rig: str):
        specs = [s for item in request["items"] for s in item["steps"]]
        estimate = float(request["estimate_s"]["full"])
        self.specs = specs
        self.cap_s = hard_cap_s(estimate)
        self.started_clock = clock
        self.hard_deadline = clock + self.cap_s
        self.finished_wall: float | None = None
        self.comment_id: int | str | None = None
        self.cancel = False
        self.answer: dict | None = None
        self.record: dict = {
            "number": request["number"],
            "title": request["title"],
            "url": request.get("url", ""),
            "rig": rig,
            "app_version": meta.get("app_version") or "unknown",
            "operator": meta.get("operator") or "",
            "mode": "full",
            "state": "running",
            "started_at": _iso(wall),
            "deadline_at": _iso(wall + self.cap_s),
            "finished_at": None,
            "elapsed_s": 0.0,
            "estimate_s": estimate,
            "items": [{"id": i["id"], "title": i["title"]} for i in request["items"]],
            "steps": [
                {
                    "index": s["index"],
                    "item_id": s["item_id"],
                    "kind": s["kind"],
                    "text": s["text"],
                    "status": "pending",
                }
                for s in specs
            ],
            "current": None,
            "question": None,
        }


class RigTestRunner:
    def __init__(
        self,
        *,
        captures_root: Callable[[], str],
        rig_id: Callable[[], str],
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        ask_timeout_s: float = ASK_TIMEOUT_S,
        slice_s: float = 0.25,
        on_active: Callable[[int | None], None] = lambda n: None,
    ):
        self._captures_root = captures_root
        self._rig_id = rig_id
        self._clock = clock
        self._wall = wall
        self._ask_timeout_s = ask_timeout_s
        self._slice_s = slice_s
        self._on_active = on_active
        self._cond = threading.Condition()
        self._run: _Run | None = None
        self._thread: threading.Thread | None = None

    # ---- queries -----------------------------------------------------------------------------

    def owns_rig(self) -> bool:
        with self._cond:
            return self._run is not None and self._run.record["state"] == "running"

    def current_issue(self) -> int | None:
        with self._cond:
            return self._run.record["number"] if self.owns_rig() and self._run else None

    def snapshot(self) -> dict:
        """The contract's Run, or {"state": "idle"}."""
        with self._cond:
            run = self._run
            if run is None:
                return {"state": "idle"}
            rec = run.record
            if rec["state"] == "running":
                rec["elapsed_s"] = round(self._clock() - run.started_clock, 1)
            elif self._wall() - (run.finished_wall or 0) > FINISHED_TTL_S:
                return {"state": "idle"}
            out = {
                k: rec[k]
                for k in (
                    "number",
                    "title",
                    "url",
                    "state",
                    "started_at",
                    "deadline_at",
                    "elapsed_s",
                    "estimate_s",
                )
            }
            out["steps"] = [
                {
                    k: s[k]
                    for k in ("index", "item_id", "kind", "text", "status", "answer", "note")
                    if k in s
                }
                for s in rec["steps"]
            ]
            if rec["current"] is not None:
                out["current"] = rec["current"]
            if rec["question"] is not None:
                out["question"] = dict(rec["question"])
            return out

    # ---- control -----------------------------------------------------------------------------

    def start(self, request: dict, meta: dict) -> None:
        """Begin a run of an already-validated request. Raises RunnerBusyError if one is active."""
        with self._cond:
            if self.owns_rig():
                raise RunnerBusyError()
            run = _Run(request, meta, self._clock(), self._wall(), self._rig_id())
            self._run = run
        self._notify_active(run.record["number"])
        self._thread = threading.Thread(
            target=self._walk, args=(run,), name=f"rig-test-{run.record['number']}", daemon=True
        )
        self._thread.start()

    def answer(self, step: int, option: str, note: str | None) -> None:
        with self._cond:
            run = self._run
            q = run.record["question"] if run and run.record["state"] == "running" else None
            if q is None or q["step"] != step or run.answer is not None:  # type: ignore[union-attr]
                raise AnswerRejectedError("no such question is open", conflict=True)
            if option not in q["options"]:
                raise AnswerRejectedError("not one of the options", conflict=False)
            run.answer = {"option": option, "note": (note or "").strip()[:MAX_NOTE]}  # type: ignore[union-attr]
            self._cond.notify_all()

    def cancel(self) -> None:
        with self._cond:
            if self._run is not None and self._run.record["state"] == "running":
                self._run.cancel = True
                self._cond.notify_all()

    def _notify_active(self, number: int | None) -> None:
        try:
            self._on_active(number)
        except Exception:  # noqa: BLE001 - bookkeeping must not stop a run or leave the rig held
            log.exception("could not record the active rig test")

    def join(self, timeout: float = 5.0) -> None:
        """Wait for the run thread, including its final report (tests, shutdown)."""
        if self._thread:
            self._thread.join(timeout)

    # ---- the run thread ----------------------------------------------------------------------

    def _walk(self, run: _Run) -> None:
        rec = run.record
        try:
            self._sync_progress(run)
            relay.set_state(rec["number"], "running")
            for spec in run.specs:
                if self._stop_reason(run):
                    break
                self._do_step(run, spec)
        except Exception:  # noqa: BLE001 - nothing may leave the rig locked
            log.exception("rig test #%s failed unexpectedly", rec["number"])
            self._mark_unfinished(run, "error")
        self._finish(run)

    def _stop_reason(self, run: _Run) -> str | None:
        with self._cond:
            if run.cancel:
                return "cancelled"
            if self._clock() >= run.hard_deadline:
                return "timed_out"
        return None

    def _do_step(self, run: _Run, spec: dict) -> None:
        rec = run.record
        step = rec["steps"][spec["index"]]
        dep = spec.get("after")
        if dep is not None and rec["steps"][dep]["status"] != "pass":
            step["status"] = "skipped_dependency"
            self._sync_progress(run)
            return
        options = spec["options"] if spec["kind"] == "ask" else list(NOTE_OPTIONS)
        with self._cond:
            run.answer = None
            ask_deadline = self._clock() + self._ask_timeout_s
            step["status"] = "active"
            rec["current"] = spec["index"]
            rec["question"] = {
                "step": spec["index"],
                "text": spec["text"],
                "options": options,
                "expires_at": _iso(self._wall() + self._ask_timeout_s),
            }
        self._sync_progress(run)
        with self._cond:
            while run.answer is None and not run.cancel:
                now = self._clock()
                limit = min(ask_deadline, run.hard_deadline)
                if now >= limit:
                    break
                self._cond.wait(min(self._slice_s, limit - now))
            answer, rec["question"] = run.answer, None
            if answer is not None:
                step["answer"] = answer["option"]
                if answer["note"]:
                    step["note"] = answer["note"]
                passing = spec.get("pass") if spec["kind"] == "ask" else NOTE_OPTIONS
                if answer["option"] in (passing or []):
                    step["status"] = "pass"
                elif answer["option"].lower() == "skip":
                    step["status"] = "no_response"
                else:
                    step["status"] = "fail"
            elif run.cancel or self._clock() >= run.hard_deadline:
                step["status"] = "cancelled"
            else:
                step["status"] = "no_response"
            rec["current"] = None
        self._sync_progress(run)

    def _mark_unfinished(self, run: _Run, status: str) -> None:
        with self._cond:
            for s in run.record["steps"]:
                if s["status"] in ("pending", "active"):
                    s["status"] = status
            run.record["question"] = None
            run.record["current"] = None

    def _finish(self, run: _Run) -> None:
        rec = run.record
        reason = self._stop_reason(run)
        unfinished = any(s["status"] in ("pending", "active") for s in rec["steps"])
        with self._cond:
            statuses = [s["status"] for s in rec["steps"]]
            if "cancelled" in statuses or (unfinished and reason):
                state = reason or "cancelled"
            else:
                state = "done" if all(st == "pass" for st in statuses) else "partial"
            for s in rec["steps"]:
                if s["status"] in ("pending", "active"):
                    s["status"] = "cancelled"
            rec["question"] = None
            rec["current"] = None
            rec["elapsed_s"] = round(self._clock() - run.started_clock, 1)
            run.finished_wall = self._wall()
            rec["finished_at"] = _iso(run.finished_wall)
            rec["state"] = state  # the rig is free from here on
        self._notify_active(None)
        self._write_result(run)
        self._sync_progress(run)
        relay.post_comment(rec["number"], report.render_result(rec))
        relay.set_state(rec["number"], "done" if state == "done" else "partial")

    def _sync_progress(self, run: _Run) -> None:
        """Create the progress comment on first use, edit it afterwards."""
        with self._cond:
            body = report.render_progress(run.record)
        if run.comment_id is None:
            res = relay.post_comment(run.record["number"], body)
            if res.get("ok"):
                run.comment_id = res.get("id")
        else:
            relay.edit_comment(run.record["number"], run.comment_id, body)

    def _write_result(self, run: _Run) -> None:
        rec = run.record
        folder = os.path.join(self._captures_root(), RESULTS_DIR, str(rec["number"]))
        try:
            os.makedirs(folder, exist_ok=True)
            data = {**rec, "items": report.item_results(rec), "counts": report.counts(rec)}
            atomic_write_json(os.path.join(folder, "result.json"), data, indent=2)
        except OSError:
            log.exception("could not write rig test result for #%s", rec["number"])


# ---- the process-wide runner, installed by routes.configure() -----------------------------------

_runner: RigTestRunner | None = None


def install(runner: RigTestRunner | None) -> None:
    global _runner
    _runner = runner


def owns_rig() -> bool:
    return _runner is not None and _runner.owns_rig()


def current_issue() -> int | None:
    return _runner.current_issue() if _runner else None
