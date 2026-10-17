"""Throttled streaming SHA-256 of a file on the share (spec sections 5 and 8).

Images and surface scans are hashed at discovery; a document is hashed once, after a person links it
(`adopted=True`). The read rate is capped by `inbox_crawler_state.read_mb_per_s` so a first scan cannot
swamp the share. The cap logic is the same as `file_fingerprints.Throttle`; it is copied here because that
module imports numpy and the crawler's image does not carry it.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass

log = logging.getLogger("inbox_crawler.hashing")

CHUNK = 1 << 20  # 1 MiB reads: the throttle sleeps between them


class Throttle:
    """A byte-rate cap: `consume(n)` reserves the next n / rate seconds and sleeps until they have passed."""

    def __init__(
        self, bytes_per_s: float | None, clock=time.monotonic, sleep=time.sleep
    ):
        self._clock = clock
        self._sleep = sleep
        self._free_at = 0.0
        self.rate = None
        self.set_rate(bytes_per_s)

    def set_rate(self, bytes_per_s: float | None) -> None:
        if bytes_per_s is not None and bytes_per_s <= 0:
            raise ValueError("the read rate must be positive or None")
        self.rate = bytes_per_s

    def consume(self, n: int) -> None:
        if self.rate is None or n <= 0:
            return
        start = max(self._clock(), self._free_at)
        self._free_at = start + n / self.rate
        wait = self._free_at - self._clock()
        if wait > 0:
            self._sleep(wait)


def mb_per_s(value) -> float | None:
    """The state row's read_mb_per_s as bytes per second."""
    return None if value is None else float(value) * 1024 * 1024


@dataclass
class HashOutcome:
    status: str  # done | error | missing (the file_fingerprints statuses)
    sha256: str | None = None
    size: int | None = None
    data: bytes | None = (
        None  # the bytes, when the file was small enough to keep (see keep_up_to)
    )
    error: str | None = None


class Pulse:
    """Calls `fn(total_bytes_so_far)` at most once per `every_s`, however often it is called itself. Used as
    the `progress` callback of a hash, so a long throttled read still shows the crawler is alive."""

    def __init__(self, every_s: float, fn, clock=time.monotonic):
        self.every_s = every_s
        self._fn = fn
        self._clock = clock
        self._last = clock()

    def __call__(self, total: int = 0) -> None:
        now = self._clock()
        if now - self._last >= self.every_s:
            self._last = now
            self._fn(total)


def hash_stream(
    fh, *, throttle: Throttle | None = None, keep_up_to: int = 0, progress=None
) -> HashOutcome:
    """SHA-256 of everything `fh` yields. Keeps the bytes when there are at most `keep_up_to` of them, so
    the caller can classify without reading the file a second time. `progress(total)` is called after each
    chunk (and after the throttle's wait): it adds no read."""
    h = hashlib.sha256()
    total = 0
    kept: bytearray | None = bytearray() if keep_up_to > 0 else None
    while True:
        buf = fh.read(CHUNK)
        if not buf:
            break
        h.update(buf)
        total += len(buf)
        if throttle is not None:
            throttle.consume(len(buf))
        if progress is not None:
            progress(total)
        if kept is not None:
            if total <= keep_up_to:
                kept += buf
            else:
                kept = None
    return HashOutcome(
        "done", h.hexdigest(), total, bytes(kept) if kept is not None else None
    )


def hash_file(
    share,
    rel: str,
    *,
    throttle: Throttle | None,
    adopted: bool = False,
    keep_up_to: int = 0,
    progress=None,
) -> HashOutcome:
    """Hash a share-relative file. A vanished file is 'missing', any other read failure is 'error' (the
    caller records it and moves on; it is never retried in a loop). A refusal by the allow-list is a
    bug in the caller and propagates."""
    if adopted:
        log.info("reading %s once to fingerprint it (a person linked it)", rel)
    else:
        log.debug("reading %s", rel)
    try:
        with share.open_rb(rel, adopted=adopted) as fh:
            return hash_stream(
                fh, throttle=throttle, keep_up_to=keep_up_to, progress=progress
            )
    except FileNotFoundError:
        return HashOutcome("missing", error="the file is not on the share")
    except OSError as exc:
        return HashOutcome("error", error=f"{type(exc).__name__}: {exc}"[:500])
