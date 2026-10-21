"""Directus REST client for the surface-scan worker.

The worker is a system actor on an administrator token. It writes ``surface_scans`` in exactly two
ways, both optimistic-concurrency guarded on the row's ``version`` (a stale version is surfaced as
:class:`VersionConflictError`):

* the claim (``pending`` to ``rendering``): a REST PATCH with ``filter[version][_eq]=<version read>``
  (:func:`patch_scan`), as the heavy-data worker does;
* the outcome (``done`` or ``failed``, with the render's numbers or its error): ``POST
  /d1-surface-scan/<id>/result`` with the version read in the body (:func:`post_result`). The render
  columns and the error live in ``d1_private.surface_scan_renders`` (ADR-0023), which only that route
  writes; the public row no longer has them, so the worker never PATCHes them.

Reads ``directus_files`` (where the file is) and ``file_fingerprints`` (the crawler's content hash,
read-only for us: this worker never hashes a file and never writes that table).
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
#: Public columns only: ``render_error`` and ``cache_key`` moved to the private render table (ADR-0023).
SCAN_FIELDS = "scan_id,directus_files_id,render_status,version,updated_at"
LIST_FIELDS = "scan_id,render_status,version,updated_at"


#: The endpoint that records a render's outcome (administrators only), relative to ``DIRECTUS_URL``.
RESULT_ROUTE = "/d1-surface-scan/{scan_id}/result"


class VersionConflictError(Exception):
    """The row changed between our read and our write: the OCC filter matched nothing, or the result
    route answered 409 VERSION_CONFLICT (stale version, or the row is no longer ``rendering``)."""


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


def post_result(scan_id: str, payload: dict, version: int) -> dict:
    """``POST /d1-surface-scan/{id}/result``: record ``done`` or ``failed`` for a ``rendering`` row.

    *payload* is ``{render_status: 'done'|'failed', render_error?, columns?}``; the version we read goes
    in the body as ``version``. A 409 (the endpoint's ``VERSION_CONFLICT``: the version moved, or the row
    is no longer ``rendering``) raises :class:`VersionConflictError`; any other error status raises
    ``requests.HTTPError`` (403: the token is not an administrator's; 400: a body the endpoint refused).
    """
    resp = requests.post(
        f"{DIRECTUS_URL}{RESULT_ROUTE.format(scan_id=scan_id)}",
        json={**payload, "version": version},
        headers=_headers(),
        timeout=30,
    )
    if resp.status_code == 409:
        raise VersionConflictError(
            f"surface scan {scan_id}: version {version} is stale (VERSION_CONFLICT)"
        )
    resp.raise_for_status()
    body = resp.json()
    return body if isinstance(body, dict) else {}


def _occ_retry(
    scan_id: str,
    compute: Callable[[dict], dict | None],
    write: Callable[[dict, int], dict],
    max_attempts: int | None,
) -> dict | None:
    """Read the row, let *compute* decide the payload, *write* it with the version read; on a version
    conflict re-read and start again. A row without a ``version`` aborts: we never write blind."""
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
            return write(payload, version)
        except VersionConflictError:
            log.info("OCC conflict scan=%s attempt=%d", scan_id, attempt)
            if attempt < attempts:
                time.sleep(random.uniform(0.05, 0.25) * attempt)
    raise VersionConflictError(
        f"surface scan {scan_id}: gave up after {attempts} version conflicts"
    )


def update_scan(
    scan_id: str,
    compute: Callable[[dict], dict | None],
    max_attempts: int | None = None,
) -> dict | None:
    """Read-modify-write one row's public columns under OCC (PATCH).

    ``compute(current)`` gets the freshly read row and returns the PATCH payload, or None for "nothing
    to write". On a version conflict the row is re-read and ``compute`` applied again.
    """
    return _occ_retry(
        scan_id,
        compute,
        lambda payload, version: patch_scan(scan_id, payload, version=version),
        max_attempts,
    )


def report_result(
    scan_id: str,
    compute: Callable[[dict], dict | None],
    max_attempts: int | None = None,
) -> dict | None:
    """Read the row, then post its outcome to the result route under OCC, retrying on a 409 exactly as
    :func:`update_scan` does.

    ``compute(current)`` returns the result payload (``render_status`` plus ``render_error`` or
    ``columns``), or None for "nothing to write": callers return None when the row is no longer
    ``rendering`` (someone reset it), which is how a lost claim is skipped.
    """
    return _occ_retry(
        scan_id,
        compute,
        lambda payload, version: post_result(scan_id, payload, version),
        max_attempts,
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
