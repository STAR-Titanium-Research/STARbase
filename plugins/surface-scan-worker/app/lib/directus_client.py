"""Directus REST client for the surface-scan worker.

Writes only ``surface_scans`` render columns. Reads ``directus_files`` (where the file is) and
``file_fingerprints`` (the crawler's content hash, read-only for us: this worker never hashes a file
and never writes that table). Every ``surface_scans`` write is optimistic-concurrency guarded the way
the heavy-data worker's are: PATCH with ``filter[version][_eq]=<version read>``; a stale version
matches no row and is surfaced as :class:`VersionConflictError`.
"""

from __future__ import annotations

import logging
import os
import random
import time
from collections.abc import Callable

import requests

log = logging.getLogger(__name__)

DIRECTUS_URL: str = os.getenv("DIRECTUS_URL", "http://directus:8055")
_TOKEN: str = os.getenv("WORKER_DIRECTUS_TOKEN", "")

#: How many times a read-modify-write is retried after losing an OCC race.
OCC_MAX_ATTEMPTS: int = int(os.getenv("OCC_MAX_ATTEMPTS", "5"))

COLLECTION = "surface_scans"
SCAN_FIELDS = (
    "scan_id,directus_files_id,render_status,render_error,cache_key,version,updated_at"
)
LIST_FIELDS = "scan_id,render_status,version,updated_at"


class VersionConflictError(Exception):
    """The row changed between our read and our write (OCC filter matched nothing)."""


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_TOKEN}",
        "Content-Type": "application/json",
        "X-Actor-Identity": "surface-scan-worker",
    }


def _data(resp: requests.Response):
    resp.raise_for_status()
    return resp.json().get("data")


def get_scan(scan_id: str) -> dict:
    """``GET /items/surface_scans/{id}``: the row's data dict (including ``version``)."""
    resp = requests.get(
        f"{DIRECTUS_URL}/items/{COLLECTION}/{scan_id}",
        params={"fields": SCAN_FIELDS},
        headers=_headers(),
        timeout=30,
    )
    data = _data(resp)
    if not isinstance(data, dict):
        raise ValueError(f"surface scan {scan_id}: unexpected GET response")
    return data


def patch_scan(scan_id: str, payload: dict, version: int | None = None) -> dict:
    """``PATCH /items/surface_scans/{id}``. With *version* the PATCH carries the OCC filter and raises
    :class:`VersionConflictError` if no row matched. Never put ``version`` in the body."""
    params = {"filter[version][_eq]": str(version)} if version is not None else None
    resp = requests.patch(
        f"{DIRECTUS_URL}/items/{COLLECTION}/{scan_id}",
        json=payload,
        params=params,
        headers=_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if version is not None and not body.get("data"):
        raise VersionConflictError(
            f"surface scan {scan_id}: version {version} is stale"
        )
    return body


def update_scan(
    scan_id: str,
    compute: Callable[[dict], dict | None],
    max_attempts: int | None = None,
) -> dict | None:
    """Read-modify-write one row under OCC.

    ``compute(current)`` gets the freshly read row and returns the PATCH payload, or None for "nothing
    to write". On a version conflict the row is re-read and ``compute`` applied again. A row without a
    ``version`` aborts: we never write blind.
    """
    attempts = max_attempts or OCC_MAX_ATTEMPTS
    for attempt in range(1, attempts + 1):
        current = get_scan(scan_id)
        version = current.get("version")
        if version is None:
            raise ValueError(
                f"surface scan {scan_id}: row has no version; refusing blind write"
            )
        payload = compute(current)
        if not payload:
            return None
        try:
            return patch_scan(scan_id, payload, version=version)
        except VersionConflictError:
            log.info("OCC conflict scan=%s attempt=%d", scan_id, attempt)
            if attempt < attempts:
                time.sleep(random.uniform(0.05, 0.25) * attempt)
    raise VersionConflictError(
        f"surface scan {scan_id}: gave up after {attempts} version conflicts"
    )


def list_scans(
    status: str, limit: int = 50, updated_before_iso: str | None = None
) -> list[dict]:
    """Rows with ``render_status = status`` (oldest first), optionally only those not touched since
    *updated_before_iso*."""
    params = {
        "filter[render_status][_eq]": status,
        "fields": LIST_FIELDS,
        "sort": "updated_at",
        "limit": str(limit),
    }
    if updated_before_iso:
        params["filter[updated_at][_lt]"] = updated_before_iso
    resp = requests.get(
        f"{DIRECTUS_URL}/items/{COLLECTION}",
        params=params,
        headers=_headers(),
        timeout=30,
    )
    data = _data(resp)
    return data if isinstance(data, list) else []


def get_file(file_id: str) -> dict:
    """``GET /files/{id}``: the file's ``storage``, ``filename_download`` and ``metadata``."""
    resp = requests.get(
        f"{DIRECTUS_URL}/files/{file_id}",
        params={"fields": "id,storage,filename_download,filesize,metadata"},
        headers=_headers(),
        timeout=30,
    )
    data = _data(resp)
    if not isinstance(data, dict):
        raise ValueError(f"file {file_id}: unexpected GET response")
    return data


def get_fingerprint(file_id: str) -> dict | None:
    """The crawler's ``file_fingerprints`` row for the file (``status``, ``content_sha256``,
    ``size_bytes``, ``source_mtime``: the hash and its staleness key), or None when there is none.

    Read only. Asked as a filtered list, not by primary key: Directus answers 403 for a primary key
    that does not exist, which would be indistinguishable from a missing permission. An empty list means
    the crawler has not seen the file (normal: the caller uses a provisional cache key); a 403 here
    really is a permission problem, logged as one (and the provisional key is used all the same).
    """
    resp = requests.get(
        f"{DIRECTUS_URL}/items/file_fingerprints",
        params={
            "filter[directus_files_id][_eq]": file_id,
            "fields": "status,content_sha256,size_bytes,source_mtime",
            "limit": "1",
        },
        headers=_headers(),
        timeout=30,
    )
    if resp.status_code == 403:
        log.warning(
            "the worker's token may not read file_fingerprints (403); "
            "grant it read access. Using provisional cache keys meanwhile."
        )
        return None
    data = _data(resp)
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    return None
