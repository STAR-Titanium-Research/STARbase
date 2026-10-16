"""One-shot passes over candidates that already exist: `--reclassify` (and, in this module too, `--sem-backfill`).

Both run under the crawler's advisory lock (`__main__` takes it, so a daemon, a `--once` run and a pass are
never alongside each other) and read an image only through the share's read-only `open_rb` (the allow-list
applies, `adopted` is never set), into memory, throttled by the read rate of `inbox_crawler_state`. The bytes
go to `classify_sem.classify_image` as `io.BytesIO`; nothing here opens a path or writes to the share.

`reclassify` (spec section 7) re-reads the undecided image candidates the current classifier version has not
looked at, because a detector fix changes what `kind` and `extracted` should be: it promotes an image the new
detector recognises, demotes a `sem_image` it no longer believes, and records the version, so a second run
finds nothing and a killed run resumes. A `linked` row is never touched. An unreadable file is recorded as
classified (and logged) so it is not retried in a loop.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

from . import classify_sem, db, hashing, scan
from .fs_readonly import ReadRefused

log = logging.getLogger("inbox_crawler.maintenance")

# How many candidates one query returns. Every row handled leaves the queue, so the next query is the next batch.
BATCH = 50


@dataclass
class PassStats:
    promoted: int = 0  # image -> sem_image
    demoted: int = 0  # sem_image -> image
    unchanged: int = 0  # read, same kind
    unreadable: int = 0  # not read (permission, vanished, refused by the allow-list): marked, not retried
    too_large: int = 0  # bigger than scan.CLASSIFY_MAX_BYTES: kept as it is, marked
    decided: int = (
        0  # linked (or otherwise settled) while the pass was reading it: not written
    )

    @property
    def examined(self) -> int:
        return (
            self.promoted
            + self.demoted
            + self.unchanged
            + self.unreadable
            + self.too_large
            + self.decided
        )


def read_image(share, rel: str, throttle) -> tuple[bytes | None, str | None]:
    """The bytes of an image on the share, or (None, why not). Never raises for a file that cannot be read:
    the caller records it and goes on. Goes through `hashing.hash_file` (so the throttle and the allow-list
    apply exactly as in a scan); a path the allow-list refuses is a reason too, not a crash."""
    try:
        out = hashing.hash_file(
            share, rel, throttle=throttle, keep_up_to=scan.CLASSIFY_MAX_BYTES
        )
    except (ReadRefused, ValueError) as exc:
        return None, f"read refused ({type(exc).__name__}: {exc})"[:500]
    if out.status != "done":
        return None, out.error or out.status
    if out.data is None:
        return None, f"larger than {scan.CLASSIFY_MAX_BYTES // (1024 * 1024)} MB"
    return out.data, None


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
) -> PassStats:
    """Re-read every undecided image candidate the current classifier version has not classified, and
    write kind, kind_confidence, extracted and classified_by. One commit per file."""
    stats = PassStats()
    seen: set[str] = set()
    while not stop():
        rows = store.reclassify_batch(batch)
        store.commit()
        if not rows:
            break
        if all(r[0] in seen for r in rows):
            # Cannot happen while every row handled leaves the queue; a guard against a tight loop.
            log.error("reclassify: the queue is not shrinking, stopping")
            break
        for cid, _fid, rel, kind in rows:
            if stop():
                break
            seen.add(cid)
            data, problem = read_image(share, rel, throttle)
            if data is None:
                store.mark_classified(cid)
                store.commit()
                if problem and problem.startswith("larger than"):
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
    log.info(
        "reclassify: %d promoted, %d demoted, %d unchanged "
        "(%d unreadable, %d too large, %d decided meanwhile)%s",
        stats.promoted,
        stats.demoted,
        stats.unchanged,
        stats.unreadable,
        stats.too_large,
        stats.decided,
        " (STOPPED, run it again to finish)" if stop() else "",
    )
    return stats
