"""The MinIO cache key for a rendered scan (spec decision 7).

``surface-scans/<cache_key>/`` holds one render. The key is the file's content hash when the crawler
has written one, so the same bytes under another name or path share one render. THIS WORKER NEVER
HASHES A FILE and never writes ``file_fingerprints``: for a file the crawler has not fingerprinted it
uses a provisional key built from what a ``stat`` says, which changes when the file is overwritten in
place (size or mtime) but cannot recognise a copy.
"""

from __future__ import annotations

import re

_SHA256 = re.compile(r"^[0-9a-f]{64}$")

PREFIX = "surface-scans"


def cache_key(
    directus_files_id: str, fingerprint: dict | None, size_bytes: int, mtime: float
) -> str:
    """``content_sha256`` when the fingerprint is ``done`` and still describes this file, else
    ``p-<directus_files_id>-<size>-<mtime>``.

    A fingerprint whose ``size_bytes`` differs from the file's size on disk is stale (the file changed
    since the crawler hashed it) and is ignored.
    """
    if fingerprint and fingerprint.get("status") == "done":
        sha = str(fingerprint.get("content_sha256") or "")
        recorded_size = fingerprint.get("size_bytes")
        if _SHA256.match(sha) and (
            recorded_size is None or int(recorded_size) == int(size_bytes)
        ):
            return sha
    return f"p-{directus_files_id}-{int(size_bytes)}-{int(mtime)}"


def object_keys(key: str) -> dict[str, str]:
    """The three object keys of one render, by name."""
    base = f"{PREFIX}/{key}"
    return {
        "grid": f"{base}/grid.bin",
        "meta": f"{base}/meta.json",
        "thumb": f"{base}/thumb.png",
    }
