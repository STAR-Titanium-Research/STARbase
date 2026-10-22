"""Poller: the safety net behind the webhook, and the stuck-row reaper.

Every ``POLL_INTERVAL_SECONDS`` (default 60):

* enqueue a render for each ``pending`` row (a Flow that failed or a worker that was down leaves rows
  nobody was told about; a scan already queued or running is not enqueued twice);
* fail any ``rendering`` row whose rq job is gone, failed, or started by a worker that has died. The
  usual cause is the kernel's out-of-memory killer taking the forked rq work-horse on a very large scan:
  the job's ``except`` never runs, rq marks the job failed, and the row would otherwise sit in
  ``rendering`` until the timeout sweep. docs/plugin-contract.md section 9 forbids leaving it there;
* fail any ``rendering`` row nobody has touched for the job timeout plus a grace period (the backstop).

Before its loop it probes the result route with a harmless report to learn whether the worker's token is an
administrator's (see :func:`verify_token`); a token that is not stops the poller, so the container exits
non-zero instead of leaving every row it touches stuck in ``rendering``.

On start it also fails every ``rendering`` row last touched before the container started: its workers
had only just started, so nothing it owns from before can be mid-render. The start time is taken by
entrypoint.sh before any child process starts (``SURFACE_SCAN_STARTED_AT``), not here after the slow
imports, so a row a worker claims in the meantime is never swept.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from datetime import UTC, datetime, timedelta

import requests
from rq import Queue

from app.lib import directus_client
from app.lib.job_config import job_timeout_seconds, poll_interval_seconds
from app.lib.redis_conn import get_redis
from app.lib.statuses import STATUS_FAILED, STATUS_PENDING, STATUS_RENDERING
from app.queueing import QUEUE_NAME, enqueue_render, job_id_for, job_is_live

log = logging.getLogger("poller")

BATCH = 50
DEFAULT_GRACE_SECONDS = 600

RESTART_MESSAGE = (
    "The render was interrupted (the worker restarted, perhaps out of memory on a very large file). "
    "Use Render again."
)
TIMEOUT_MESSAGE = "The render did not finish within the time limit. Use Render again."
KILLED_MESSAGE = (
    "The render was killed, probably out of memory. Use Render again; if it repeats, the scan is "
    "too large for the worker's memory limit (SURFACE_SCAN_MEMORY_LIMIT)."
)


def _grace_seconds() -> int:
    try:
        return int(os.getenv("REAPER_GRACE_SECONDS", "") or DEFAULT_GRACE_SECONDS)
    except ValueError:
        return DEFAULT_GRACE_SECONDS


def enqueue_pending(queue: Queue) -> int:
    """Enqueue every pending row not already queued; returns how many jobs were added."""
    added = 0
    for row in directus_client.list_scans(STATUS_PENDING, limit=BATCH):
        scan_id = row.get("scan_id")
        if not scan_id:
            continue
        _, enqueued = enqueue_render(queue, scan_id)
        added += enqueued
    return added


TOKEN_MESSAGE = (
    "The surface-scan worker's Directus token was refused by the result route (it answered %s: 403 "
    "means the token is not an administrator's, 401 that Directus does not know the token or it is "
    "blank). Without an ADMINISTRATOR's token no render outcome can be recorded and every row stays "
    "'rendering'. Set SURFACE_SCAN_DIRECTUS_TOKEN (or WORKER_DIRECTUS_TOKEN) to the static token of an "
    "ADMINISTRATOR machine user, then restart the worker. Exiting."
)

TOKEN_REFUSED = "refused"
TOKEN_OK = "ok"
TOKEN_UNKNOWN = "unknown"


def probe_token() -> str:
    """Probe ``POST /d1-surface-scan/<nil uuid>/result``. Returns :data:`TOKEN_REFUSED` when the token is
    definitely refused (403, or 401 for a token Directus does not know), :data:`TOKEN_OK` on a definite
    acceptance, and :data:`TOKEN_UNKNOWN` when the probe could not tell yet.

    An administrator gets 409 (no such row, nothing written) and a 400 means the body drifted from the
    route's: both are an acceptance. A connection error, a 5xx, a 404 (the endpoint is not deployed yet)
    or anything else unexpected only logs a warning and is "unknown" (Directus may still be starting, as
    on a cold start of the whole stack): the worker must not die for a problem that mends itself, and
    the poll loop asks again until it gets a definite answer.
    """
    try:
        status = directus_client.probe_result_route()
    except requests.RequestException as err:
        log.warning(
            "token probe: Directus could not be reached (%s); will ask again", err
        )
        return TOKEN_UNKNOWN
    if status in (401, 403):
        log.critical(TOKEN_MESSAGE, status)
        return TOKEN_REFUSED
    if status in (409, 400):
        log.info(
            "token probe: the result route accepts the worker's token (%s)", status
        )
        return TOKEN_OK
    log.warning(
        "token probe: unexpected answer %s from the result route (Directus still starting, or the "
        "endpoint not deployed?); will ask again",
        status,
    )
    return TOKEN_UNKNOWN


def verify_token() -> bool:
    """False only when the token is definitely refused (see :func:`probe_token`)."""
    return probe_token() != TOKEN_REFUSED


def _fail(scan_id: str, message: str) -> bool:
    def compute(current: dict) -> dict | None:
        if current.get("render_status") != STATUS_RENDERING:
            return None  # finished or reset since we listed it
        return {"render_status": STATUS_FAILED, "render_error": message}

    # The error text goes to the private render table through POST /d1-surface-scan/<id>/result, with
    # the version and the directus_files_id of the row as just read here (report_result posts those).
    return directus_client.report_result(scan_id, compute) is not None


def fail_rendering(message: str, older_than: datetime | None = None) -> list[str]:
    """Fail ``rendering`` rows (all of them, or those untouched since *older_than*)."""
    cutoff = older_than.isoformat() if older_than else None
    failed: list[str] = []
    for row in directus_client.list_scans(
        STATUS_RENDERING, limit=BATCH, updated_before_iso=cutoff
    ):
        scan_id = row.get("scan_id")
        if not scan_id:
            continue
        try:
            if _fail(scan_id, message):
                failed.append(scan_id)
                log.warning("failed stuck scan=%s", scan_id)
        except Exception:
            log.exception("could not fail scan=%s", scan_id)
    return failed


def reap_once(now: datetime | None = None) -> list[str]:
    cutoff = (now or datetime.now(UTC)) - timedelta(
        seconds=job_timeout_seconds() + _grace_seconds()
    )
    return fail_rendering(TIMEOUT_MESSAGE, older_than=cutoff)


def fail_killed(queue: Queue) -> list[str]:
    """Fail ``rendering`` rows whose job is not live: gone from rq, failed (the work-horse was killed),
    or started by a worker that no longer exists. A row whose job is queued or running is left alone."""
    failed: list[str] = []
    for row in directus_client.list_scans(STATUS_RENDERING, limit=BATCH):
        scan_id = row.get("scan_id")
        if not scan_id:
            continue
        try:
            job = queue.fetch_job(job_id_for(scan_id))
            if job is not None and job_is_live(queue, job):
                continue
            # _fail re-reads the row: one that finished since we listed it is left alone.
            if _fail(scan_id, KILLED_MESSAGE):
                failed.append(scan_id)
                log.warning("failed scan=%s: its render job is gone or dead", scan_id)
        except Exception:
            log.exception("could not check scan=%s", scan_id)
    return failed


def started_at() -> datetime:
    """When this container started: ``SURFACE_SCAN_STARTED_AT`` (set by entrypoint.sh before any child
    process starts), else now."""
    raw = os.getenv("SURFACE_SCAN_STARTED_AT", "").strip()
    if raw:
        try:
            ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return ts if ts.tzinfo else ts.replace(tzinfo=UTC)
        except ValueError:
            log.warning("ignoring unparseable SURFACE_SCAN_STARTED_AT=%r", raw)
    return datetime.now(UTC)


def run_forever() -> None:
    logging.basicConfig(level=logging.INFO)
    token_state = probe_token()
    if token_state == TOKEN_REFUSED:
        sys.exit(1)  # entrypoint.sh takes the container down when any child dies
    queue = Queue(QUEUE_NAME, connection=get_redis())
    interval = poll_interval_seconds()
    container_started = started_at()
    swept = False
    while True:
        try:
            if not swept:
                # Only rows untouched since the container started: a job claimed after that is ours.
                fail_rendering(RESTART_MESSAGE, older_than=container_started)
                swept = True
            fail_killed(queue)
            enqueue_pending(queue)
            reap_once()
        except Exception:
            # Directus or Redis may be down at container start: keep trying.
            log.exception("poll pass failed")
        if token_state == TOKEN_UNKNOWN:
            # A cold start of the whole stack usually reaches us before Directus is up: keep asking until
            # the route answers definitely, so a non-administrator token is still caught.
            token_state = probe_token()
            if token_state == TOKEN_REFUSED:
                sys.exit(1)
        time.sleep(interval)


if __name__ == "__main__":
    run_forever()
