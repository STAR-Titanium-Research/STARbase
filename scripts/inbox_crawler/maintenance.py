"""One-shot passes over rows that already exist: `--reclassify` and `--sem-backfill`.

Both run under the crawler's advisory lock (`__main__` takes it, so a daemon, a `--once` run and a pass are
never alongside each other) and read an image only through the share's read-only `open_rb` (the allow-list
applies, `adopted` is never set), into memory, throttled by the read rate of `inbox_crawler_state`. The bytes
go to `classify_sem.classify_image` as `io.BytesIO`; nothing here opens a path or writes to the share.

`reclassify` (spec section 7) re-reads the undecided image candidates the current classifier version has not
looked at, because a detector fix changes what `kind` and `extracted` should be: it promotes an image the new
detector recognises, demotes a `sem_image` it no longer believes, and records the version, so a second run
finds nothing and a killed run resumes. A `linked` row is never touched. Only a PERMANENT read failure
(no permission, refused by the allow-list, too large to read into memory) is recorded as classified, so it is
not retried in a loop; a file that is missing or fails with a transient error is skipped and stays in the queue
for the next run (a share that drops must never mark rows it did not read). `--force` ignores `classified_by`
(for example after OCR is switched on) and re-reads every eligible row once.

Both passes guard the share like a scan: the root must answer before they start and again whenever a read fails
with "missing" or a transient error, and `scan.MAX_CONSECUTIVE_FAILURES` such failures in a row abort the pass
(`aborted` in its stats, exit code 1); rows already committed stay committed.

`sem_backfill` (spec section 7) gives the images people linked BEFORE settings were saved at link time their
imaging settings: pointer rows that are linked, image-typed, unowned and have no `sem_image_settings` row. Each
is read, classified, and when it is an SEM image `save_sem_settings` (migration 197, the only place `extracted`
becomes settings, merging and never overwriting a person's correction) writes the row. A run visits each row
once (it walks the files ids in order), a row that got settings leaves the list, so a killed run is finished by
the next; an unreadable file is logged and skipped (and tried again by the next run, as is an SEM image whose
read gave no value: INBOX_OCR may be on by then).
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

from . import classify_sem, db, hashing, scan
from .fs_readonly import ReadRefused
from .identity import file_id
from .owners import clean_rel_path

log = logging.getLogger("inbox_crawler.maintenance")

# How many candidates one query returns. Each pass pages by id, so a row it skipped is not offered again in the same run.
BATCH = 50


@dataclass
class PassStats:
    promoted: int = 0  # image -> sem_image
    demoted: int = 0  # sem_image -> image
    unchanged: int = 0  # read, same kind
    unreadable: int = 0  # permanent read failure (permission, allow-list refusal): kept as it is, marked
    too_large: int = 0  # bigger than scan.CLASSIFY_MAX_BYTES: kept as it is, marked
    skipped: int = 0  # missing or a transient error: not marked, back in the queue for the next run
    decided: int = (
        0  # linked (or otherwise settled) while the pass was reading it: not written
    )
    aborted: bool = False  # the share stopped answering: the pass ended early

    @property
    def examined(self) -> int:
        return (
            self.promoted
            + self.demoted
            + self.unchanged
            + self.unreadable
            + self.too_large
            + self.skipped
            + self.decided
        )


class ShareGuard:
    """The scan's own share checks (`Scanner.verify_share`, `_note_failure`, `MAX_CONSECUTIVE_FAILURES`), reused
    for a pass: `scan.ShareUnavailable` when the share root does not answer or too many reads failed in a row."""

    def __init__(self, share, store: db.Store):
        self._scanner = scan.Scanner(share, store)

    def verify(self) -> None:
        self._scanner.verify_share()

    def failed(self, exc: OSError) -> None:
        """A read failed as 'missing' or transiently: the root must still answer (else the share dropped), then
        the failure is counted."""
        self._scanner.verify_share()
        self._scanner._note_failure(exc)

    def worked(self) -> None:
        self._scanner._failures = 0


def read_image(share, rel: str, throttle, guard: ShareGuard):
    """Read an image through the share's read-only `open_rb` (so the allow-list applies, never `adopted`),
    throttled, into memory. Returns (bytes or None, status, reason), status being:

    * `ok`        the bytes;
    * `permanent` no permission, or refused by the allow-list or the path rules: marking the row is safe;
    * `too_large` more than scan.CLASSIFY_MAX_BYTES: marking the row is safe;
    * `skipped`   missing or a transient error (EIO, a host that went away, a timeout): never marked.

    Raises scan.ShareUnavailable (through the guard) when the root no longer answers or too many reads failed
    in a row. Never raises for a file that cannot be read."""
    log.debug("reading %s", rel)
    try:
        with share.open_rb(rel) as fh:
            out = hashing.hash_stream(
                fh, throttle=throttle, keep_up_to=scan.CLASSIFY_MAX_BYTES
            )
    except PermissionError as exc:
        return None, "permanent", f"{type(exc).__name__}: {exc}"[:500]
    except (ReadRefused, ValueError) as exc:
        return None, "permanent", f"read refused ({type(exc).__name__}: {exc})"[:500]
    except (
        OSError
    ) as exc:  # FileNotFoundError included: a moved file or a share that went away
        guard.failed(exc)
        return None, "skipped", f"{type(exc).__name__}: {exc}"[:500]
    guard.worked()
    if out.data is None:
        return (
            None,
            "too_large",
            f"larger than {scan.CLASSIFY_MAX_BYTES // (1024 * 1024)} MB",
        )
    return out.data, "ok", None


def reclassify(
    store: db.Store,
    share,
    *,
    throttle: hashing.Throttle | None = None,
    ocr: bool = False,
    ocr_func=None,
    bar_reader=None,
    profiles=None,
    stop=lambda: False,
    batch: int = BATCH,
    force: bool = False,
) -> PassStats:
    """Re-read every undecided image candidate the current classifier version has not classified (every
    eligible one with `force`), and write kind, kind_confidence, extracted and classified_by. One commit per
    file; rows are visited in id order, once per run."""
    stats = PassStats()
    guard = ShareGuard(share, store)
    after: str | None = None
    try:
        guard.verify()
        while not stop():
            rows = store.reclassify_batch(batch, after, force=force)
            store.commit()
            if not rows:
                break
            for cid, _fid, rel, kind in rows:
                if stop():
                    break
                after = cid
                data, status, problem = read_image(share, rel, throttle, guard)
                if status == "skipped":
                    stats.skipped += 1
                    log.warning(
                        "not re-classifying %s: %s; left in the queue for the next run",
                        rel,
                        problem,
                    )
                    continue
                if data is None:
                    store.mark_classified(cid)
                    store.commit()
                    if status == "too_large":
                        stats.too_large += 1
                        log.info(
                            "not re-classifying %s: %s; kept as %s, marked as classified by %s",
                            rel,
                            problem,
                            kind,
                            classify_sem.CLASSIFIER_VERSION,
                        )
                    else:
                        stats.unreadable += 1
                        log.warning(
                            "not re-classifying %s: %s; kept as %s, marked as classified by %s "
                            "so it is not retried",
                            rel,
                            problem,
                            kind,
                            classify_sem.CLASSIFIER_VERSION,
                        )
                    continue
                cls = classify_sem.classify_image(
                    io.BytesIO(data),
                    ocr=ocr,
                    ocr_func=ocr_func,
                    bar_reader=bar_reader,
                    profiles=profiles,
                )
                written = store.set_classification(cid, cls)
                store.commit()
                if not written:
                    stats.decided += 1
                elif kind == "image" and cls.kind == "sem_image":
                    stats.promoted += 1
                    log.info("promoted %s to sem_image (%s)", rel, cls.reason)
                elif kind == "sem_image" and cls.kind == "image":
                    stats.demoted += 1
                    log.info("demoted %s to image (%s)", rel, cls.reason)
                else:
                    stats.unchanged += 1
    except scan.ShareUnavailable as exc:
        store.rollback()
        stats.aborted = True
        log.error(
            "reclassify aborted, nothing read after this point was marked: %s", exc
        )
    log.info(
        "reclassify: %d promoted, %d demoted, %d unchanged "
        "(%d unreadable, %d too large, %d skipped, %d decided meanwhile)%s%s",
        stats.promoted,
        stats.demoted,
        stats.unchanged,
        stats.unreadable,
        stats.too_large,
        stats.skipped,
        stats.decided,
        " (ABORTED)" if stats.aborted else "",
        " (STOPPED, run it again to finish)" if stop() else "",
    )
    return stats


READ_BY = "backfill"  # sem_image_settings.read_by for rows this pass writes


@dataclass
class BackfillStats:
    saved: int = 0  # an SEM image whose settings row now exists
    not_sem: int = 0  # read, not an SEM image: nothing written
    no_values: int = 0  # an SEM image with no usable value (a bar-only image without OCR): no row, tried again later
    unreadable: int = 0  # not read (permission, allow-list, too large, missing, a transient error): logged, skipped
    bad_path: int = 0  # the stored path is not the file's own: never read
    aborted: bool = False  # the share stopped answering: the pass ended early

    @property
    def examined(self) -> int:
        return (
            self.saved + self.not_sem + self.no_values + self.unreadable + self.bad_path
        )


def sem_backfill(
    store: db.Store,
    share,
    *,
    throttle: hashing.Throttle | None = None,
    ocr: bool = False,
    ocr_func=None,
    bar_reader=None,
    profiles=None,
    stop=lambda: False,
    batch: int = BATCH,
) -> BackfillStats:
    """Read each linked, unowned, image-typed pointer row that has no settings and save what the image says.
    One commit per file. The path is the row's metadata.archive_path, believed only when it is clean and the
    row's id is the indexer's uuid5 of it (any Lab Member can edit the metadata). Marks nothing (an unreadable
    row is simply listed again by the next run); the share guard is the reclassify pass's."""
    stats = BackfillStats()
    guard = ShareGuard(share, store)
    after: str | None = None
    try:
        guard.verify()
        while not stop():
            rows = store.backfill_batch(batch, after)
            store.commit()
            if not rows:
                break
            for fid, rel in rows:
                if stop():
                    break
                after = fid
                if not clean_rel_path(rel) or str(file_id(rel)) != fid:
                    stats.bad_path += 1
                    log.warning(
                        "not reading file %s: its stored path is not its own", fid
                    )
                    continue
                data, _status, problem = read_image(share, rel, throttle, guard)
                if data is None:
                    stats.unreadable += 1
                    log.warning(
                        "not reading %s for settings: %s; skipped", rel, problem
                    )
                    continue
                cls = classify_sem.classify_image(
                    io.BytesIO(data),
                    ocr=ocr,
                    ocr_func=ocr_func,
                    bar_reader=bar_reader,
                    profiles=profiles,
                )
                if cls.kind != "sem_image":
                    stats.not_sem += 1
                    continue
                if store.save_sem_settings(fid, cls.extracted, READ_BY):
                    stats.saved += 1
                else:
                    stats.no_values += 1
                    log.info("%s is an SEM image but gave no usable value", rel)
                store.commit()
    except scan.ShareUnavailable as exc:
        store.rollback()
        stats.aborted = True
        log.error("sem-backfill aborted: %s", exc)
    log.info(
        "sem-backfill: %d saved, %d not an SEM image, %d SEM images with no usable value, "
        "%d unreadable, %d with a path that is not their own%s%s",
        stats.saved,
        stats.not_sem,
        stats.no_values,
        stats.unreadable,
        stats.bad_path,
        " (ABORTED)" if stats.aborted else "",
        " (STOPPED, run it again to finish)" if stop() else "",
    )
    return stats
