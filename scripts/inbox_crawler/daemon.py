"""The inbox crawler daemon (spec section 5): control row, heartbeat, scan requests, schedule, hashing.

Like the force crawler it polls a singleton row (`inbox_crawler_state`) each loop, writes its heartbeat and
what it is doing back, and honours `desired_state` (paused keeps the heartbeat and scans nothing), the
scan interval and the read throttle. Each tick, in order:

1. claim one queued scan request (FOR UPDATE SKIP LOCKED) and run it, else
2. run the scheduled scan of everyone when `interval_minutes` have passed since the last one began;
3. after a scan: refresh suggestions for undecided files, then ask the d1-inbox extension to auto-link;
4. read once, hash and fingerprint files a person has linked (documents), and retry hashes that failed;
5. when step 4 had nothing to do, backfill thumbnails (spec section 14) for a bounded batch of images that
   have none: a read through `fs_readonly` like any other (allow-listed images only, `adopted=False`, the
   same throttle).

Nothing here touches the share except through `Scanner`'s `share` object (fs_readonly), and nothing here
writes a link.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from . import autolink, db, hashing, scan, thumbs

log = logging.getLogger("inbox_crawler.daemon")

# Images whose thumbnails the backfill makes per tick at most (each is one throttled read), how long one tick's
# backfill may run before it hands back to the loop (scan requests wait for it), and how long it stays off after
# the thumbnails table could not be read (migration 198 not applied yet).
THUMB_BATCH = 25
THUMB_BUDGET_S = 20
THUMB_RETRY_S = 600
# Ids tried this process: an image Pillow cannot decode (or that changed on the share) would be offered every
# tick otherwise. Cleared when it grows past this, so a long-lived daemon tries such files again.
THUMB_TRIED_MAX = 20_000

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
    thumbnails: bool = (
        True  # INBOX_THUMBNAILS=0: no thumbnails at registration, no backfill
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
        self._thumbs_tried: set[str] = set()
        self._thumbs_retry_at: datetime | None = None

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
        if (
            self.hash_pending() == 0
        ):  # fingerprints first: the backfill uses the ticks that are left
            self.thumbnail_pending()
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
            thumbnails=self.config.thumbnails,
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

    # ---- thumbnails backfill ---------------------------------------------------------

    def thumbnail_pending(self, limit: int = THUMB_BATCH) -> int:
        """Make the thumbnails of up to `limit` images that have none (registered before thumbnails existed, or
        whose file changed since they were made). Each is read through the share's `open_rb` (not adopted, so
        only allow-listed images) at the shared throttle, and only if it is still the file the candidate
        describes (same size and modification time): a picture of a different file would not match its row.
        A file that cannot be decoded gets a marker row (`failed_reason`) so it is read once, not every tick,
        until it changes. A file that vanished, is not the file the row describes or is refused to us is skipped
        for the rest of the process (`_thumbs_tried`); the scan, not this step, decides what is gone. A share
        hiccup (an OSError other than those) ends this tick's batch and marks nothing as tried, so the files
        behind it are offered again next tick. A call stops after THUMB_BUDGET_S seconds. Returns how many
        pictures were made."""
        if not self.config.thumbnails:
            return 0
        if self._thumbs_retry_at is not None and self._now() < self._thumbs_retry_at:
            return 0
        store = self.store
        try:
            targets = store.candidates_missing_thumbnails(
                limit, max_bytes=scan.CLASSIFY_MAX_BYTES, skip=self._thumbs_tried
            )
        except Exception as exc:  # noqa: BLE001 (above all: the table is not there yet)
            store.rollback()
            self._thumbs_retry_at = self._now() + timedelta(seconds=THUMB_RETRY_S)
            log.warning(
                "thumbnail backfill is off for %d minutes (%s): is migration 198 applied?",
                THUMB_RETRY_S // 60,
                type(exc).__name__,
            )
            return 0
        self._thumbs_retry_at = None
        made = 0
        started = self._now()
        for target in targets:
            if self.stop_event.is_set():
                break
            if self._now() - started >= timedelta(seconds=THUMB_BUDGET_S):
                break  # the rest next tick
            try:
                outcome = self._make_thumbnails(target)
            except OSError as exc:  # the share hiccuped: not this file's fault, so it is not marked as tried
                store.rollback()
                log.warning(
                    "thumbnail backfill stops for this tick (%s): the share did not answer",
                    type(exc).__name__,
                )
                break
            except Exception as exc:  # noqa: BLE001 (one file must not stop the others, or the loop)
                store.rollback()
                log.warning(
                    "thumbnails of %s failed: %s", target.rel_path, type(exc).__name__
                )
                outcome = "skip"
            if outcome == "made":
                made += 1
            elif outcome == "skip":
                if len(self._thumbs_tried) >= THUMB_TRIED_MAX:
                    self._thumbs_tried.clear()
                self._thumbs_tried.add(target.candidate_id)
        if made:
            log.info("thumbnails made for %d images", made)
        return made

    def _make_thumbnails(self, target: db.ThumbTarget) -> str:
        """One backfill target: "made" (pictures stored), "marked" (a marker row stored: it cannot be decoded or
        is too big) or "skip" (not this file any more, or not readable by us: tried again only after a restart).
        An OSError from the share (not "gone", not "refused") propagates: the caller ends the batch."""
        rel = target.rel_path
        try:
            st = self.share.stat(rel)
        except (FileNotFoundError, NotADirectoryError, PermissionError, ValueError):
            return "skip"  # gone or refused: the scan decides, not this step
        if not st.is_file or (st.size, db.to_datetime(st.mtime_ns)) != (
            target.size,
            target.mtime,
        ):
            return "skip"  # not the file the candidate describes any more
        pulse_args = {} if self._clock is None else {"clock": self._clock}
        pulse = hashing.Pulse(
            self.config.heartbeat_s,
            lambda _total: self.store.heartbeat(f"thumbnails {rel}"),
            **pulse_args,
        )
        out = hashing.hash_file(
            self.share,
            rel,
            throttle=self.throttle,
            keep_up_to=scan.CLASSIFY_MAX_BYTES,
            progress=pulse,
        )
        if out.status == "done":
            out = scan.still_the_same(
                self.share, rel, st, out
            )  # an OSError here ends the batch
        if out.status == "missing":
            return "skip"
        if out.status != "done":
            error = out.error or ""
            if error.startswith(("PermissionError", "the file changed")):
                return "skip"  # ours to leave alone, not a hiccup
            raise OSError(
                error[:100] or "read failed"
            )  # the share failed under the read
        if out.data is None:
            return self._mark_thumbnails(target, "too large")
        pictures = thumbs.make_thumbnails(out.data)
        if pictures is None:
            log.info("no thumbnails for %s: it could not be decoded", rel)
            return self._mark_thumbnails(target, "not decoded")
        self.store.store_thumbnails(
            target.candidate_id, pictures, target.size, target.mtime
        )
        self.store.commit()
        return "made"

    def _mark_thumbnails(self, target: db.ThumbTarget, reason: str) -> str:
        self.store.store_thumbnail_failure(
            target.candidate_id, reason, target.size, target.mtime
        )
        self.store.commit()
        return "marked"

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
