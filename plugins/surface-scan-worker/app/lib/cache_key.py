"""The MinIO cache key for a rendered scan (spec decision 7).

``surface-scans/<cache_key>/`` holds one render. The key is the file's content hash when the crawler
has written one that still describes the file, so the same bytes under another name or path share one
render. THIS WORKER NEVER HASHES A FILE and never writes ``file_fingerprints``: for a file the crawler
has not fingerprinted (or whose fingerprint is out of date) it uses a provisional key built from what a
``stat`` says, which changes when the file is overwritten in place (size or mtime) but cannot recognise
a copy.

A fingerprint is current only when BOTH halves of its staleness key match the file on disk
(``file_fingerprints.size_bytes`` and ``source_mtime``, migration 20261010000159). A file re-exported in
place with the same size has a new mtime, so its old hash must not be reused.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

_SHA256 = re.compile(r"^[0-9a-f]{64}$")

PREFIX = "surface-scans"

#: Seconds of slack when comparing the fingerprint's source_mtime (a timestamptz the crawler took from
#: the share) with the file's mtime now: SMB and FAT timestamps are coarse (FAT: 2 s).
MTIME_TOLERANCE_SECONDS = 2.0


def _epoch(value: object) -> float | None:
    """A timestamptz string from Directus (or a datetime) as epoch seconds; None if unusable."""
    if isinstance(value, datetime):
        ts = value
    elif isinstance(value, str) and value:
        try:
            ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    return ts.timestamp()


def fingerprint_is_current(
    fingerprint: dict | None, size_bytes: int, mtime: float
) -> bool:
    """True when *fingerprint* is ``done``, has a valid hash and describes the file as it is now.

    A fingerprint missing its ``size_bytes`` or ``source_mtime`` cannot be checked and is not trusted.
    """
    if not fingerprint or fingerprint.get("status") != "done":
        return False
    if not _SHA256.match(str(fingerprint.get("content_sha256") or "")):
        return False
    recorded_size = fingerprint.get("size_bytes")
    if recorded_size is None or int(recorded_size) != int(size_bytes):
        return False
    recorded_mtime = _epoch(fingerprint.get("source_mtime"))
    return (
        recorded_mtime is not None
        and abs(recorded_mtime - float(mtime)) <= MTIME_TOLERANCE_SECONDS
    )


def cache_key(
    directus_files_id: str, fingerprint: dict | None, size_bytes: int, mtime: float
) -> str:
    """``content_sha256`` when the fingerprint is current (see :func:`fingerprint_is_current`), else
    ``p-<directus_files_id>-<size>-<mtime>`` from the file's own ``stat``."""
    if fingerprint_is_current(fingerprint, size_bytes, mtime):
        return str(fingerprint["content_sha256"])  # type: ignore[index]
    return f"p-{directus_files_id}-{int(size_bytes)}-{int(mtime)}"


def object_keys(key: str) -> dict[str, str]:
    """The three object keys of one render, by name."""
    base = f"{PREFIX}/{key}"
    return {
        "grid": f"{base}/grid.bin",
        "meta": f"{base}/meta.json",
        "thumb": f"{base}/thumb.png",
    }
