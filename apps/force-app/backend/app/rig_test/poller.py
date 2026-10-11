"""Finds rig-test requests on the relay and keeps the operator's choices about them.

`RigTestPoller` is a daemon thread like `BackupStreamer` (app/backup.py): every 60 s it asks the
relay for open `rig-test-request` issues, but only while this PC is the rig, no recording is
running and no rig test is active. Snoozes, declines and the pending list live in
`<config dir>/rig_tests_state.json` so they survive a restart.

Nothing here can start a run: a request becomes runnable only through `POST /rig-tests/{n}/accept`,
which looks it up in this poller's pending list.
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import threading
import time
from collections.abc import Callable
from datetime import datetime

from ..bug_report import _fence, _redact_paths
from ..storage import atomic_write_json
from . import catalog, relay
from .report import _cell

log = logging.getLogger("force_app.rig_test")

DEFAULT_INTERVAL_S = 60.0
INITIAL_DELAY_S = 5.0
HANDLED_GRACE_S = 120.0  # the relay caches for 30 s: trust our own decision until it has caught up
AFTER_RECORDING_MAX_S = 4 * 3600.0
MAX_SNOOZE_S = 7 * 24 * 3600.0
# States that hide a request until its maintainer clears the label (spec, "Relay").
_SETTLED_LABELS = {"declined", "running", "partial", "done", "interrupted"}
DECLINE_REASONS = {
    "about_to_record": "About to record / mid-session",
    "machine_in_use": "Someone else is using the machine",
    "rig_not_set_up": "Rig not set up (no tool or sensor)",
    "not_today": "Not today, ask tomorrow",
    "other": "Other",
}


def _label(issue: dict) -> str:
    raw = str(issue.get("state_label") or "").strip().lower()
    return raw.removeprefix("rig-test:")


def _hhmm(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).strftime("%H:%M")


class StateFile:
    """The small JSON file behind `rig_tests_state.json`: pending requests, snoozes, declines,
    the invalid requests already reported, and the run in progress (to spot a crash)."""

    def __init__(self, path: str):
        self._path = path
        self._lock = threading.RLock()
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        self._data: dict = data if isinstance(data, dict) else {}

    def get(self, key: str, default=None):
        with self._lock:
            return copy.deepcopy(self._data.get(key, default))

    def update(self, **values) -> None:
        with self._lock:
            if all(self._data.get(k) == v for k, v in values.items()):
                return
            self._data.update(values)
            self._save()

    def update_in(self, key: str, sub: str, value) -> None:
        with self._lock:
            self._data.setdefault(key, {})[sub] = value
            self._save()

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
            atomic_write_json(self._path, self._data, indent=2)
        except OSError:
            log.warning("could not save %s", self._path)


class RigTestPoller:
    def __init__(
        self,
        *,
        store: StateFile,
        eligible: Callable[[], tuple[bool, str | None]],
        is_busy: Callable[[], bool],
        owns_rig: Callable[[], bool],
        rig_id: Callable[[], str],
        interval_s: float = DEFAULT_INTERVAL_S,
        initial_delay_s: float = INITIAL_DELAY_S,
        wall: Callable[[], float] = time.time,
    ):
        self._store = store
        self._eligible = eligible
        self._is_busy = is_busy
        self._owns_rig = owns_rig
        self._rig_id = rig_id
        self._interval_s = interval_s
        self._initial_delay_s = initial_delay_s
        self._wall = wall
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.relay_state = "ok"  # of the last relay answer; "ok" until one has failed

    # ---- thread ------------------------------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="rig-test-poller", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        if self._stop.wait(self._initial_delay_s):
            return
        self._report_interrupted_run()
        while True:
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001 - a poll must never take the thread down
                log.exception("rig test poll failed")
            if self._stop.wait(self._interval_s):
                return

    # ---- polling -----------------------------------------------------------------------------

    def _report_interrupted_run(self) -> None:
        """A run that was active when the app last stopped never reported: say so, once."""
        n = self._store.get("active_run")
        if n is None:
            return
        relay.post_comment(
            n,
            f"**Rig test #{n} was interrupted**: the app on {_cell(self._rig_id(), 80)} "
            "restarted while the run was in progress. Results so far were not reported.",
        )
        relay.set_state(n, "interrupted")
        self._store.update(active_run=None)

    def poll_once(self) -> None:
        eligible, _ = self._eligible()
        if not eligible:
            self._set_pending([])
            return
        if self._is_busy() or self._owns_rig():
            return
        res = relay.list_requests()
        self.relay_state = relay.relay_status(res)
        if not res.get("ok"):
            return  # keep what we had; the relay may be briefly down
        pending = []
        for issue in sorted(
            res["requests"], key=lambda i: (str(i.get("created_at")), i.get("number", 0))
        ):
            request = self._consider(issue)
            if request:
                pending.append(request)
        self._set_pending(pending)

    def _consider(self, issue: dict) -> dict | None:
        """A pending Request for this issue, or None when it is not for us, not due or invalid."""
        try:
            n = int(issue["number"])
            body = str(issue.get("body") or "")
        except (KeyError, TypeError, ValueError):
            return None
        if _label(issue) in _SETTLED_LABELS:
            return None
        handled = self._store.get("handled", {}).get(str(n))
        if handled and self._wall() - handled["at"] < HANDLED_GRACE_S:
            return None
        rig = catalog.peek_rig(body)
        if rig and rig.lower() != self._rig_id().lower():
            return None
        digest = hashlib.sha1(body.encode("utf-8", "replace")).hexdigest()[:12]
        if self._store.get("invalid", {}).get(str(n)) == digest:
            return None
        try:
            resolved = catalog.parse_request(body)
        except catalog.RigRequestError as e:
            self._reject(n, str(e), digest)
            return None
        return {
            "number": n,
            "title": str(issue.get("title") or "")[:200],
            "url": str(issue.get("url") or ""),
            "requested_by": str(issue.get("requested_by") or "")[:80],
            "created_at": str(issue.get("created_at") or ""),
            "items": [i.model_dump(by_alias=True, exclude_none=True) for i in resolved.items],
            "estimate_s": resolved.estimate_s,
            "needs_operator_steps": resolved.needs_operator_steps,
        }

    def _reject(self, n: int, reason: str, digest: str) -> None:
        """Say once, on the issue, that the request cannot run; the operator never sees it."""
        text = (
            f"**Rig test #{n}: invalid request** ({_cell(self._rig_id(), 80)} did not run it): "
            f"{_cell(reason, 300)}\n\nFix the `rig-test` block and remove the `rig-test:declined` "
            "label to ask again."
        )
        if relay.post_comment(n, text).get("ok"):
            self._store.update_in("invalid", str(n), digest)
            relay.set_state(n, "declined")

    def _set_pending(self, pending: list[dict]) -> None:
        with self._lock:
            # An accept or decline made while this poll was in flight must not be undone by it.
            recent = {
                n
                for n, h in self._store.get("handled", {}).items()
                if self._wall() - h["at"] < HANDLED_GRACE_S
            }
            self._store.update(pending=[r for r in pending if str(r["number"]) not in recent])

    # ---- what the routes use -----------------------------------------------------------------

    def pending(self) -> list[dict]:
        """Pending requests oldest first, minus the snoozed ones that are not yet due."""
        busy = self._is_busy()
        with self._lock:
            snoozes = self._store.get("snoozes", {})
            now = self._wall()
            for key, s in list(snoozes.items()):
                if s["after_recording"] and busy:
                    s["saw_busy"] = True
                due = (s["after_recording"] and s["saw_busy"] and not busy) or now >= s["until"]
                if due:
                    del snoozes[key]
            self._store.update(snoozes=snoozes)
            return [r for r in self._store.get("pending", []) if str(r["number"]) not in snoozes]

    def get(self, n: int) -> dict | None:
        return next((r for r in self._store.get("pending", []) if r["number"] == n), None)

    def mark_accepted(self, n: int) -> None:
        self._settle(n, "running")

    def snooze(self, n: int, until: str) -> None:
        """Hide request n until `until` (ISO 8601) or until the current recording ends."""
        now = self._wall()
        if until == "after_recording":
            entry = {
                "until": now + AFTER_RECORDING_MAX_S,
                "after_recording": True,
                "saw_busy": self._is_busy(),
            }
            when = "until the current recording is finished"
        else:
            try:
                at = datetime.fromisoformat(until.replace("Z", "+00:00")).timestamp()
            except ValueError:
                raise ValueError("until must be an ISO 8601 time or 'after_recording'") from None
            if at <= now:
                raise ValueError("until is in the past")
            at = min(at, now + MAX_SNOOZE_S)
            entry = {"until": at, "after_recording": False, "saw_busy": False}
            when = f"until {_hhmm(at)}"
        with self._lock:
            self._store.update_in("snoozes", str(n), entry)
        relay.post_comment(n, f"**Rig test #{n} snoozed** on {_cell(self._rig_id(), 80)} {when}.")
        relay.set_state(n, "deferred")

    def decline(self, n: int, reason_code: str, text: str | None) -> None:
        label = DECLINE_REASONS[reason_code]
        lines = [f"**Rig test #{n} declined** on {_cell(self._rig_id(), 80)}: {label}."]
        if text and text.strip():
            lines += ["", *_fence(_redact_paths(text), 500)]
        self._settle(n, "declined")
        relay.post_comment(n, "\n".join(lines))
        relay.set_state(n, "declined")

    def _settle(self, n: int, state: str) -> None:
        with self._lock:
            handled = self._store.get("handled", {})
            handled[str(n)] = {"state": state, "at": self._wall()}
            snoozes = self._store.get("snoozes", {})
            snoozes.pop(str(n), None)
            pending = [r for r in self._store.get("pending", []) if r["number"] != n]
            self._store.update(handled=handled, snoozes=snoozes, pending=pending)
