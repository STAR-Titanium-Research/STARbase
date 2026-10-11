"""Runs one accepted rig-test request, and owns the rig while it does (ADR-0012 §4).

One run at a time, in a daemon thread that walks the steps in order. Phase 1 has two kinds:
an `ask` waits for the operator's answer, a `note` waits for "Continue". Each step has an answer
window (`step_window_s`: an ask gets max(ASK_TIMEOUT_S, 1.5 x its estimate), a note gets
ASK_TIMEOUT_S); with no answer the step is `no_response` and the run carries on. A step whose
`after` dependency did not pass is skipped. The whole run has a hard cap (`run_cap_s`):
min(RUN_CAP_MAX_S, max(1.5 x the estimates, the sum of the windows)), so a run of default asks is
never cut off before its last answer window. The operator can cancel at any time.

While a run is active `owns_rig()` is true: it stops a second run from being accepted and the poller
from asking the relay. The rig *lock* (see `__init__`) is narrower: it refuses `/record/start` and
every hardware or storage write only while an automated step is executing
(`automated_step_active()`). Phase 1 has no automated steps, so it never engages, and the operator
stays free to record, change the amp mode or edit channels while an `ask` step is open.

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
from .catalog import NOTE_OPTIONS, issue_url

log = logging.getLogger("force_app.rig_test")

ASK_TIMEOUT_S = 300.0  # the shortest time the operator gets to answer any one step
ASK_WINDOW_FACTOR = 1.5  # an ask with a long estimate gets this many times it
RUN_CAP_FACTOR = 1.5
# Nothing is locked in phase 1, so the run may wait on a person for a long while. The spec's 30 min
# ceiling was for automated steps holding the rig (phase 2).
RUN_CAP_MAX_S = 2 * 3600.0
FINISHED_TTL_S = 300.0  # how long a finished run stays visible on GET /rig-tests/run
MAX_NOTE = 1000
RESULTS_DIR = "rig-tests"  # under the captures root: rig-tests/<n>/result-<started>.json


class RunnerBusyError(Exception):
    """A run is already active."""


class AnswerRejectedError(Exception):
    """The answer does not match the open question. `conflict` is True when no such question is
    open (HTTP 409), False when the option is not one of the choices (HTTP 400)."""

    def __init__(self, message: str, conflict: bool):
        super().__init__(message)
        self.conflict = conflict


def step_window_s(spec: dict, base_s: float = ASK_TIMEOUT_S) -> float:
    """How long the operator has to answer this step before it counts as `no_response`."""
    if spec["kind"] == "ask":
        return max(base_s, ASK_WINDOW_FACTOR * spec["est_s"])
    return base_s


def run_cap_s(specs: list[dict], base_s: float = ASK_TIMEOUT_S) -> float:
    """The hard time limit of a whole run."""
    estimate = sum(s["est_s"] for s in specs)
    windows = sum(step_window_s(s, base_s) for s in specs)
    return min(RUN_CAP_MAX_S, max(RUN_CAP_FACTOR * estimate, windows))


def iso_local(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


class _Run:
    """Everything about one run: the public record, the step specs and the waiting state."""

    def __init__(
        self, request: dict, meta: dict, clock: float, wall: float, rig: str, window_s: float
    ):
        specs = [s for item in request["items"] for s in item["steps"]]
        estimate = float(request["estimate_s"]["full"])
        self.specs = specs
        cap_s = run_cap_s(specs, window_s)
        self.started_clock = clock
        self.hard_deadline = clock + cap_s
        self.started_wall = wall
        self.finished_wall: float | None = None
        self.comment_id: int | str | None = None
        self.cancel = False
        self.answer: dict | None = None
        self.record: dict = {
            "number": request["number"],
            "title": request["title"],
            "url": issue_url(request.get("url")),
            "rig": rig,
            "app_version": meta.get("app_version") or "unknown",
            "operator": report.operator_initials(meta.get("operator")),
            "mode": "full",
            "state": "running",
            "started_at": iso_local(wall),
            "deadline_at": iso_local(wall + cap_s),
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
        on_unsent: Callable[[int, str | None, str | None], None] = lambda n, body, state: None,
    ):
        self._captures_root = captures_root
        self._rig_id = rig_id
        self._clock = clock
        self._wall = wall
        self._ask_timeout_s = ask_timeout_s
        self._slice_s = slice_s
        self._on_active = on_active
        self._on_unsent = on_unsent
        self._cond = threading.Condition()
        self._run: _Run | None = None
        self._thread: threading.Thread | None = None
        self._automated_active = False

    # ---- queries -----------------------------------------------------------------------------

    def owns_rig(self) -> bool:
        with self._cond:
            return self._run is not None and self._run.record["state"] == "running"

    def automated_step_active(self) -> bool:
        """True while an automated step is executing against the hardware. Always False in phase 1
        (no automated kinds exist)."""
        with self._cond:
            return self._automated_active and self.owns_rig()

    def set_automated_step_active(self, active: bool) -> None:
        """The executor of an automated step (phase 2) wraps its action in this; tests use it to
        exercise the lock."""
        with self._cond:
            self._automated_active = active

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
            run = _Run(
                request, meta, self._clock(), self._wall(), self._rig_id(), self._ask_timeout_s
            )
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
            with self._cond:
                step["status"] = "skipped_dependency"
            self._sync_progress(run)
            return
        options = spec["options"] if spec["kind"] == "ask" else list(NOTE_OPTIONS)
        with self._cond:
            run.answer = None
            now = self._clock()
            # The countdown the UI shows ends when the step times out or the run's cap hits,
            # whichever is first.
            step_deadline = now + step_window_s(spec, self._ask_timeout_s)
            limit = min(step_deadline, run.hard_deadline)
            step["status"] = "active"
            rec["current"] = spec["index"]
            rec["question"] = {
                "step": spec["index"],
                "text": spec["text"],
                "options": options,
                "expires_at": iso_local(self._wall() + (limit - now)),
            }
        self._sync_progress(run)
        with self._cond:
            while run.answer is None and not run.cancel:
                now = self._clock()
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
            elif run.cancel or self._clock() < step_deadline:
                step["status"] = "cancelled"  # Cancel, or the run's cap cut the window short
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
            rec["finished_at"] = iso_local(run.finished_wall)
            self._automated_active = False
            rec["state"] = state  # the rig is free from here on
        self._notify_active(None)
        self._write_result(run)
        self._sync_progress(run)
        self._send_result(rec, state)

    def _send_result(self, rec: dict, state: str) -> None:
        """Post the result comment and set the final label. Whatever the relay does not take goes
        to the outbox (the state file), which the poller retries until it is sent."""
        body = report.render_result(rec)
        label = "done" if state == "done" else "partial"
        comment_ok = bool(relay.post_comment(rec["number"], body).get("ok"))
        label_ok = bool(relay.set_state(rec["number"], label).get("ok"))
        if comment_ok and label_ok:
            return
        try:
            self._on_unsent(
                rec["number"], None if comment_ok else body, None if label_ok else label
            )
        except Exception:  # noqa: BLE001 - the run is over either way
            log.exception("could not queue the result of rig test #%s", rec["number"])

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
            # One file per run: asking for the same issue again must not overwrite the first.
            stamp = datetime.fromtimestamp(run.started_wall).strftime("%Y%m%dT%H%M%S")
            atomic_write_json(os.path.join(folder, f"result-{stamp}.json"), data, indent=2)
        except OSError:
            log.exception("could not write rig test result for #%s", rec["number"])


# ---- the process-wide runner, installed by routes.configure() -----------------------------------

_runner: RigTestRunner | None = None


def install(runner: RigTestRunner | None) -> None:
    global _runner
    _runner = runner


def owns_rig() -> bool:
    return _runner is not None and _runner.owns_rig()


def automated_step_active() -> bool:
    return _runner is not None and _runner.automated_step_active()


def current_issue() -> int | None:
    return _runner.current_issue() if _runner else None
