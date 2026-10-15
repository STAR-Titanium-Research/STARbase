"""Poller: the safety net behind the webhook, and the stuck-row reaper.

Every ``POLL_INTERVAL_SECONDS`` (default 60):

* enqueue a render for each ``pending`` row (a Flow that failed or a worker that was down leaves rows
  nobody was told about; a scan already queued or running is not enqueued twice);
* fail any ``rendering`` row nobody has touched for the job timeout plus a grace period (a job killed
  hard never reaches its ``except``; docs/plugin-contract.md section 9 forbids leaving the row there).

On start it also fails every ``rendering`` row last touched before it started: this container's workers
just started, so nothing it owns from before can be mid-render. The message names the likely cause (a crash while reading a very
large file); the user can press "Render again".
"""

from __future__ import annotations

import logging
import os
import time
from datetime import UTC, datetime, timedelta

from rq import Queue

from app.lib import directus_client
from app.lib.job_config import job_timeout_seconds, poll_interval_seconds
from app.lib.redis_conn import get_redis
from app.lib.statuses import STATUS_FAILED, STATUS_PENDING, STATUS_RENDERING
from app.queueing import QUEUE_NAME, enqueue_render

log = logging.getLogger("poller")

BATCH = 50
DEFAULT_GRACE_SECONDS = 600

RESTART_MESSAGE = (
    "The render was interrupted (the worker restarted, perhaps out of memory on a very large file). "
    "Use Render again."
)
TIMEOUT_MESSAGE = "The render did not finish within the time limit. Use Render again."


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


def _fail(scan_id: str, message: str) -> bool:
    def compute(current: dict) -> dict | None:
        if current.get("render_status") != STATUS_RENDERING:
            return None  # finished or reset since we listed it
        return {"render_status": STATUS_FAILED, "render_error": message}

    return directus_client.update_scan(scan_id, compute) is not None


def fail_rendering(message: str, older_than: datetime | None = None) -> list[str]:
    """Fail ``rendering`` rows (all of them, or those untouched since *older_than*)."""
    cutoff = older_than.isoformat() if older_than else None
    failed: list[str] = []
    for row in directus_client.list_scans(STATUS_RENDERING, limit=BATCH, updated_before_iso=cutoff):
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
    cutoff = (now or datetime.now(UTC)) - timedelta(seconds=job_timeout_seconds() + _grace_seconds())
    return fail_rendering(TIMEOUT_MESSAGE, older_than=cutoff)


def run_forever() -> None:
    logging.basicConfig(level=logging.INFO)
    queue = Queue(QUEUE_NAME, connection=get_redis())
    interval = poll_interval_seconds()
    started_at = datetime.now(UTC)
    swept = False
    while True:
        try:
            if not swept:
                # Only rows untouched since this process started: a job claimed after that is ours.
                fail_rendering(RESTART_MESSAGE, older_than=started_at)
                swept = True
            enqueue_pending(queue)
            reap_once()
        except Exception:
            # Directus or Redis may be down at container start: keep trying.
            log.exception("poll pass failed")
        time.sleep(interval)


if __name__ == "__main__":
    run_forever()
