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
import uuid
from collections.abc import Callable
from datetime import datetime

from ..storage import atomic_write_json
from . import catalog, relay
from .report import _cell, fenced
from .runner import iso_local

log = logging.getLogger("force_app.rig_test")

DEFAULT_INTERVAL_S = 60.0
INITIAL_DELAY_S = 5.0
HANDLED_GRACE_S = 120.0  # the relay caches for 30 s: trust our own decision until it has caught up
AFTER_RECORDING_MAX_S = 4 * 3600.0
OUTBOX_MAX = 20
OUTBOX_REFUSED_MAX = 5  # an entry the relay keeps refusing (the issue was closed) is dropped
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


def _num(value, default: float = 0.0) -> float:
    ok = isinstance(value, int | float) and not isinstance(value, bool)
    return float(value) if ok else default


def _clean(data: object) -> dict:
    """The state file as the rest of the code expects it. A file from another version, a hand edit
    or a half-written one can have the wrong shape; whatever is unusable is dropped (the poller
    refills `pending` within a minute) instead of turning /rig-tests/pending into a 500."""
    d = data if isinstance(data, dict) else {}

    def section(key: str) -> dict:
        return d[key] if isinstance(d.get(key), dict) else {}

    def rows(key: str) -> list:
        return [r for r in d[key] if isinstance(r, dict)] if isinstance(d.get(key), list) else []

    pending = [
        r
        for r in rows("pending")
        if isinstance(r.get("number"), int)
        and isinstance(r.get("items"), list)
        and isinstance(r.get("estimate_s"), dict)
    ]
    snoozes = {
        str(k): {
            "until": _num(v.get("until")),
            "after_recording": bool(v.get("after_recording")),
            "saw_busy": bool(v.get("saw_busy")),
        }
        for k, v in section("snoozes").items()
        if isinstance(v, dict)
    }
    handled = {
        str(k): {"state": str(v.get("state") or ""), "at": _num(v.get("at"))}
        for k, v in section("handled").items()
        if isinstance(v, dict)
    }
    invalid = {str(k): v for k, v in section("invalid").items() if isinstance(v, str)}
    outbox = [
        {
            "id": str(e.get("id") or uuid.uuid4().hex),
            "number": e["number"],
            "body": e["body"] if isinstance(e.get("body"), str) else None,
            "state": e["state"] if isinstance(e.get("state"), str) else None,
            "tries": int(_num(e.get("tries"))),
        }
        for e in rows("outbox")
        if isinstance(e.get("number"), int)
        and (isinstance(e.get("body"), str) or isinstance(e.get("state"), str))
    ]
    active = d.get("active_run")
    return {
        "pending": pending,
        "snoozes": snoozes,
        "handled": handled,
        "invalid": invalid,
        "outbox": outbox[-OUTBOX_MAX:],
        "active_run": active if isinstance(active, int) and not isinstance(active, bool) else None,
    }


class StateFile:
    """The small JSON file behind `rig_tests_state.json`: pending requests, snoozes, declines,
    the invalid requests already reported, the run in progress (to spot a crash) and the outbox of
    comments and labels that could not be sent yet."""

    def __init__(self, path: str):
        self._path = path
        self._lock = threading.RLock()
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {}
        self._data: dict = _clean(data)

    def get(self, key: str, default=None):
        with self._lock:
            return copy.deepcopy(self._data.get(key, default))

    def update(self, **values) -> None:
        with self._lock:
            if all(self._data.get(k) == v for k, v in values.items()):
                return
            self._data.update(values)
            self._save()

    def outbox_add(self, number: int, body: str | None, state: str | None, **also) -> None:
        """Queue a comment and/or state label for issue `number`, to be sent when the relay is
        back. Extra `also` values are stored in the same write (the interrupted-run marker)."""
        with self._lock:
            box = self._data.setdefault("outbox", [])
            box.append(
                {"id": uuid.uuid4().hex, "number": number, "body": body, "state": state, "tries": 0}
            )
            del box[:-OUTBOX_MAX]
            self._data.update(also)
            self._save()

    def outbox_update(self, entry_id: str, **fields) -> None:
        with self._lock:
            for e in self._data.setdefault("outbox", []):
                if e["id"] == entry_id:
                    e.update(fields)
            self._save()

    def outbox_remove(self, entry_id: str) -> None:
        with self._lock:
            box = self._data.setdefault("outbox", [])
            self._data["outbox"] = [e for e in box if e["id"] != entry_id]
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
        # Of the last relay answer: "unknown" until a call has been made, then ok|unreachable|...
        self.relay_state = "unknown"
        self._last_eligibility: tuple[bool, str | None] | None = None
        self._queue_interrupted_run()

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
        while True:
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001 - a poll must never take the thread down
                log.exception("rig test poll failed")
            if self._stop.wait(self._interval_s):
                return

    # ---- polling -----------------------------------------------------------------------------

    def _queue_interrupted_run(self) -> None:
        """A run that was active when the app last stopped never reported. Called from the
        constructor, before any accept can overwrite the marker: the notice goes into the outbox
        and the marker is cleared in the same write, so neither a relay that is down nor a new run
        can lose it. The outbox keeps retrying until the relay has taken it."""
        n = self._store.get("active_run")
        if n is None:
            return
        body = (
            f"**Rig test #{n} was interrupted**: the app on {_cell(self._rig_id(), 80)} "
            "restarted while the run was in progress. Results so far were not reported."
        )
        self._store.outbox_add(n, body, "interrupted", active_run=None)

    def flush_outbox(self) -> None:
        """Send the comments and labels that could not be sent earlier (a run's result, an
        interrupted notice). Stops at the first transport failure (the relay is down); an entry
        the relay refuses outright is dropped after a few tries."""
        for e in self._store.get("outbox", []):
            for part, send in (("body", relay.post_comment), ("state", relay.set_state)):
                if e[part] is None:
                    continue
                res = send(e["number"], e[part])
                if res.get("ok"):
                    e[part] = None
                    self._store.outbox_update(e["id"], **{part: None})
                elif res.get("kind"):  # unreachable / not configured: nothing else gets through
                    return
                else:
                    e["tries"] += 1
                    self._store.outbox_update(e["id"], tries=e["tries"])
                    break
            if e["body"] is None and e["state"] is None:
                self._store.outbox_remove(e["id"])
            elif e["tries"] >= OUTBOX_REFUSED_MAX:
                log.warning("rig test #%s: the relay refuses this entry; dropping it", e["number"])
                self._store.outbox_remove(e["id"])

    def check_eligibility(self) -> tuple[bool, str | None]:
        """Whether this PC is the rig. While a recording runs this returns the last answer instead
        of asking again: finding out means enumerating DAQmx, which must not happen mid-recording."""
        if self._is_busy():
            return self._last_eligibility or (
                False,
                "a recording is in progress; this is checked again when it ends",
            )
        self._last_eligibility = self._eligible()
        return self._last_eligibility

    def poll_once(self) -> None:
        if self._is_busy() or self._owns_rig():
            return  # before the eligibility check: that one may enumerate DAQmx
        self.flush_outbox()
        eligible, _ = self.check_eligibility()
        if not eligible:
            self._set_pending([])
            return
        res = relay.list_requests()
        self.relay_state = relay.relay_status(res)
        if not res.get("ok"):
            return  # keep what we had; the relay may be briefly down
        pending = []
        for issue in sorted(
            res["requests"], key=lambda i: (str(i.get("created_at")), i.get("number", 0))
        ):
            try:
                request = self._consider(issue)
            except Exception:  # noqa: BLE001 - one bad issue must not hide the others
                log.exception("rig test #%s could not be read; skipping it", issue.get("number"))
                continue
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
        # Cheapest checks first: an unchanged body that was already judged invalid is skipped
        # before anything parses it, and a huge one is never parsed at all.
        digest = hashlib.sha1(body.encode("utf-8", "replace")).hexdigest()[:12]
        if self._store.get("invalid", {}).get(str(n)) == digest:
            return None
        if len(body) > catalog.MAX_BODY_CHARS:
            self._reject(n, catalog.BODY_TOO_LONG, digest)
            return None
        rig = catalog.peek_rig(body)
        if rig and rig.lower() != self._rig_id().lower():
            return None
        try:
            resolved = catalog.parse_request(body)
        except catalog.RigRequestError as e:
            self._reject(n, str(e), digest)
            return None
        return resolved.as_request(n, issue)

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

    def _live_snoozes(self) -> dict:
        """The snoozes that are still in force. Due ones are dropped here, so the request comes
        back on the next read; a snooze "until after this recording" is due once a recording has
        been seen and has ended, or at its 4 h fallback."""
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
            return snoozes

    def pending(self) -> list[dict]:
        """Pending requests oldest first, minus the snoozed ones that are not yet due."""
        with self._lock:
            snoozes = self._live_snoozes()
            return [r for r in self._store.get("pending", []) if str(r["number"]) not in snoozes]

    def snoozed(self) -> list[dict]:
        """The snoozed requests, each with `snoozed_until`: an ISO 8601 time, or "after_recording"."""
        with self._lock:
            snoozes = self._live_snoozes()
            return [
                {
                    **r,
                    "snoozed_until": "after_recording"
                    if snoozes[str(r["number"])]["after_recording"]
                    else iso_local(snoozes[str(r["number"])]["until"]),
                }
                for r in self._store.get("pending", [])
                if str(r["number"]) in snoozes
            ]

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
            lines += ["", *fenced(text, 500)]
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
