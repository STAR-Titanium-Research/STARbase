"""Directus REST API write-back client for the analysis worker.

Every write to test_sessions is optimistic-concurrency guarded as described in
docs/api-contract.md section 7.2: PATCH with ``filter[version][_eq]=<version
read>``; a stale version matches no row and Directus answers with ``data: null``
(or an empty array), which we surface as :class:`VersionConflictError`.
"""

import logging
import os
import random
import time
from collections.abc import Callable

import requests

log = logging.getLogger(__name__)

DIRECTUS_URL: str = os.getenv("DIRECTUS_URL", "http://directus:8055")
_TOKEN: str = os.getenv("WORKER_DIRECTUS_TOKEN", "")

#: How many times a read-merge-write is retried after losing an OCC race.
OCC_MAX_ATTEMPTS: int = int(os.getenv("OCC_MAX_ATTEMPTS", "5"))

SESSION_FIELDS = "session_id,status,summary_stats,plot_uris,version,updated_at"


class VersionConflictError(Exception):
    """The row changed between our read and our write (OCC filter matched nothing)."""


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_TOKEN}",
        "Content-Type": "application/json",
        "X-Actor-Identity": "analysis-worker",
    }


def patch_test_session(
    session_id: str, payload: dict, version: int | None = None
) -> dict:
    """PATCH /items/test_sessions/{session_id}.

    With *version* the PATCH carries the OCC filter and raises
    :class:`VersionConflictError` if no row matched. Never put ``version`` in the body.
    """
    url = f"{DIRECTUS_URL}/items/test_sessions/{session_id}"
    params = {"filter[version][_eq]": str(version)} if version is not None else None
    resp = requests.patch(
        url, json=payload, params=params, headers=_headers(), timeout=30
    )
    resp.raise_for_status()
    body = resp.json()
    if version is not None and not body.get("data"):
        raise VersionConflictError(f"session {session_id}: version {version} is stale")
    return body


def get_test_session(session_id: str) -> dict:
    """GET /items/test_sessions/{session_id} — return the item's data dict
    (including ``version``).

    Used to read-merge-write summary_stats / plot_uris so that the analysis
    worker and this worker don't clobber each other's contributions to the
    same JSONB columns.
    """
    url = f"{DIRECTUS_URL}/items/test_sessions/{session_id}"
    resp = requests.get(
        url, params={"fields": SESSION_FIELDS}, headers=_headers(), timeout=30
    )
    resp.raise_for_status()
    data = resp.json().get("data")
    if not isinstance(data, dict):
        msg = f"session {session_id}: unexpected GET response"
        raise ValueError(msg)
    return data


def update_session(
    session_id: str,
    compute: Callable[[dict], dict | None],
    max_attempts: int | None = None,
) -> dict | None:
    """Read-modify-write one test_sessions row under OCC.

    ``compute(current)`` receives the freshly read row and returns the PATCH
    payload, or None for "nothing to write". On :class:`VersionConflictError` the row
    is re-read and ``compute`` re-applied, up to *max_attempts* times. A failed
    read or a row without a ``version`` aborts: we never write blind.
    """
    attempts = max_attempts or OCC_MAX_ATTEMPTS
    for attempt in range(1, attempts + 1):
        current = get_test_session(session_id)  # raises on failure: abort
        version = current.get("version")
        if version is None:
            msg = f"session {session_id}: row has no version; refusing blind write"
            raise ValueError(msg)
        payload = compute(current)
        if not payload:
            return None
        try:
            return patch_test_session(session_id, payload, version=version)
        except VersionConflictError:
            log.info("OCC conflict session=%s attempt=%d", session_id, attempt)
            if attempt < attempts:
                time.sleep(random.uniform(0.05, 0.25) * attempt)
    msg = f"session {session_id}: gave up after {attempts} version conflicts"
    raise VersionConflictError(msg)


def list_stale_sessions(
    statuses: list[str] | tuple[str, ...], older_than_iso: str
) -> list:
    """Sessions whose ``status`` is in *statuses* and ``updated_at`` < *older_than_iso*.

    Used by the reaper to find rows stranded by a killed or timed-out job.
    """
    url = f"{DIRECTUS_URL}/items/test_sessions"
    params = {
        "filter[status][_in]": ",".join(statuses),
        "filter[updated_at][_lt]": older_than_iso,
        "fields": SESSION_FIELDS,
        "limit": "100",
    }
    resp = requests.get(url, params=params, headers=_headers(), timeout=30)
    resp.raise_for_status()
    data = resp.json().get("data")
    return data if isinstance(data, list) else []
