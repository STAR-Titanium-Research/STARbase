"""The inbox crawler daemon (spec section 5): control row, heartbeat, scan requests, schedule, hashing.

Like the force crawler it polls a singleton row (`inbox_crawler_state`) each loop, writes its heartbeat and
what it is doing back, and honours `desired_state` (paused keeps the heartbeat and scans nothing), the
scan interval and the read throttle. Each tick, in order:

1. claim one queued scan request (FOR UPDATE SKIP LOCKED) and run it, else
2. run the scheduled scan of everyone when `interval_minutes` have passed since the last one began;
3. after a scan: refresh suggestions for undecided files, then ask the d1-inbox extension to auto-link;
4. read once, hash and fingerprint files a person has linked (documents), and retry hashes that failed.

Nothing here touches the share except through `Scanner`'s `share` object (fs_readonly), and nothing here
writes a link.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from . import autolink, db, hashing, scan

log = logging.getLogger("inbox_crawler.daemon")

NO_FOLDER = (
    "no folder to scan: this person has no uni alias and no team folder, is a Former person, or no "
    "folder of that name is on the share"
)


@dataclass
class Config:
    ocr: bool = False
    tick_s: float = 30.0  # how often requests are claimed
    error_sleep_s: float = 15.0
    heartbeat_s: float = (
        30.0  # the heartbeat while one large file is hashed through the throttle
    )


class Daemon:
    def __init__(
        self,
        store: db.Store,
        share,
        linker: autolink.AutoLinker | None,
        *,
        config: Config | None = None,
        now=lambda: datetime.now(UTC),
        stop: threading.Event | None = None,
        scanner_options: dict | None = None,
        clock=None,
    ):
        self.store = store
        self.share = share
        self.linker = linker
        self.config = config or Config()
        self._now = now
        self.stop_event = stop or threading.Event()
        self.throttle = hashing.Throttle(None)
        self.attempted: dict[
            str, float
        ] = {}  # candidates the extension answered for, and when
        self._scanner_options = scanner_options or {}
        self._clock = (
            clock  # None: time.monotonic (hashing.Pulse's default); tests pass a fake
        )

    # ---- one tick ----------------------------------------------------------------------

    def tick(self) -> str:
        """One loop iteration. Returns what it did: 'no-state', 'paused', 'request', 'scheduled', 'idle'."""
        store = self.store
        state = store.load_state()
        if state is None:
            log.error(
                "inbox_crawler_state row missing; the migration has not been applied"
            )
            return "no-state"
        store.fail_stale_requests()  # every tick: a dead daemon's request must not lock a person out
        if state["desired_state"] != "running":
            store.heartbeat("paused")
            return "paused"
        self.throttle.set_rate(hashing.mb_per_s(state["read_mb_per_s"]))
        did = "idle"
        request = store.claim_request()
        if request is not None:
            self.run_request(request)
            did = "request"
        elif self.scan_due(state):
            self.run_scan(None, full=True)
            did = "scheduled"
        self.hash_pending()
        store.heartbeat("idle" if did == "idle" else f"idle (last: {did})")
        return did

    def scan_due(self, state: dict) -> bool:
        last = state.get("last_scan_started_at")
        if last is None:
            return True
        return self._now() - last >= timedelta(minutes=int(state["interval_minutes"]))

    # ---- scanning ----------------------------------------------------------------------

    def _scanner(self) -> scan.Scanner:
        return scan.Scanner(
            self.share,
            self.store,
            throttle=self.throttle,
            ocr=self.config.ocr,
            stop=self.stop_event.is_set,
            activity=self.store.heartbeat,
            **self._scanner_options,
        )

    def run_request(self, request: dict) -> None:
        full = request["scope"] == "all"
        error = None
        try:
            stats = self.run_scan(None if full else request["person_id"], full=full)
            if stats.aborted:
                error = stats.last_error or "the share did not answer"
            elif stats.interrupted:
                error = "the crawler was stopped while it was scanning; ask again"
            elif not full and stats.owners_scanned == 0:
                error = NO_FOLDER
        except Exception as exc:  # noqa: BLE001 (the request must end done or failed, never stay running)
            self.store.rollback()
            error = f"the scan failed ({type(exc).__name__})"
            log.error("scan request failed: %s", type(exc).__name__)
        self.store.finish_request(request["request_id"], error)

    def run_scan(self, person_id: str | None, *, full: bool) -> scan.ScanStats:
        store = self.store
        if full:
            store.scan_started()
        store.heartbeat("scanning")
        stats = self._scanner().scan(person_id=person_id)
        store.scan_finished(
            registered=stats.registered,
            errors=stats.errors,
            last_error=stats.last_error,
            unmatched=stats.unmatched,
            completed=not stats.aborted and not stats.interrupted,
            full=full,
        )
        log.info(
            "scan %s: %d registered, %d gone, %d re-pointed, %d errors%s",
            "of everyone" if full else "of one person",
            stats.registered,
            stats.gone,
            stats.repointed,
            stats.errors,
            " (ABORTED)" if stats.aborted else "",
        )
        if not stats.aborted and not stats.interrupted:
            self.after_scan()
        return stats

    def after_scan(self) -> None:
        store = self.store
        try:
            changed = store.refresh_recognition(store.load_lookup())
            store.commit()
            if changed:
                log.info("suggestions refreshed for %d undecided files", changed)
        except Exception as exc:  # noqa: BLE001
            store.rollback()
            log.warning("refreshing suggestions failed: %s", type(exc).__name__)
        counts = autolink.run_auto_link(store, self.linker, self.attempted)
        if counts["offered"]:
            log.info("auto-link: %s", counts)

    # ---- hashing queues ----------------------------------------------------------------

    def hash_pending(self, limit: int = 20) -> int:
        """Fingerprint files a person has linked (read once, with `adopted`), and retry hashes that failed
        at least an hour ago. A failure is written as an 'error' row and not tried again for an hour."""
        store = self.store
        n = 0
        for _cid, fid, rel in store.adopted_awaiting_hash(limit):
            if self.stop_event.is_set():
                break
            self._fingerprint(fid, rel, adopted=True)
            n += 1
        for cid, fid, rel in store.errored_hashes(limit):
            if self.stop_event.is_set():
                break
            out = self._fingerprint(fid, rel, adopted=False)
            if out.status == "done" and out.sha256:
                store.set_duplicate_of(cid, store.find_original(out.sha256, fid))
                store.commit()
            n += 1
        return n

    def _fingerprint(
        self, files_id: str, rel: str, *, adopted: bool
    ) -> hashing.HashOutcome:
        pulse_args = {} if self._clock is None else {"clock": self._clock}
        pulse = hashing.Pulse(
            self.config.heartbeat_s,
            lambda _total: self.store.heartbeat(f"hashing {rel}"),
            **pulse_args,
        )
        out, st, mtime = scan.fingerprint_file(
            self.share, rel, self.throttle, adopted=adopted, progress=pulse
        )
        self.store.upsert_fingerprint(
            files_id, out, None if st is None else st.size, mtime
        )
        self.store.commit()
        return out

    # ---- forever -----------------------------------------------------------------------

    def run_forever(self, reconnect) -> None:
        """Loop until stopped. A failed iteration is logged (the exception's class only, never a message
        that could carry a connection string), the connection is replaced and the loop sleeps and goes on."""
        store = self.store
        store.fail_stale_requests(
            None
        )  # one daemon: whatever is 'running' now is not ours
        store.daemon_started()
        log.info("inbox crawler started; polling inbox_crawler_state")
        while not self.stop_event.is_set():
            try:
                self.tick()
                wait = self.config.tick_s
            except Exception as exc:  # noqa: BLE001 (a daemon survives its own iterations)
                log.error("iteration failed (continuing): %s", type(exc).__name__)
                wait = self.config.error_sleep_s
                try:
                    self.store.rollback()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    self.store = reconnect(self.store)
                    store = self.store
                    store.heartbeat(f"error (retrying): {type(exc).__name__}")
                except Exception as exc2:  # noqa: BLE001
                    log.error("reconnect failed: %s", type(exc2).__name__)
            self.stop_event.wait(wait)
        store.heartbeat("stopped")
        log.info("inbox crawler stopped")
