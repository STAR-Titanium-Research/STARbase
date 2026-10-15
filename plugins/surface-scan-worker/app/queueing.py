"""Enqueueing render jobs, shared by the webhook and the poller.

One job per scan at a time: the job id is derived from the scan id, and a scan that already has a
queued or running job is not enqueued again (the poller would otherwise pile up a duplicate every
pass while a scan waits its turn). The job itself is also idempotent: it only renders a row that is
still ``pending`` and claims it under OCC.
"""

from __future__ import annotations

import os

from rq import Queue

from app.jobs.render_scan import render_scan
from app.lib.job_config import job_timeout_seconds

QUEUE_NAME = os.getenv("QUEUE_NAME", "surface-scan-worker")

_LIVE = {"queued", "started", "scheduled", "deferred"}


def job_id_for(scan_id: str) -> str:
    return f"surface-scan-{scan_id}"


def enqueue_render(queue: Queue, scan_id: str):
    """Enqueue a render of *scan_id*. Returns ``(job, enqueued)``; ``enqueued`` is False when a live
    job for the scan already exists."""
    job_id = job_id_for(scan_id)
    existing = queue.fetch_job(job_id)
    if existing is not None and existing.get_status(refresh=True) in _LIVE:
        return existing, False
    job = queue.enqueue(
        render_scan,
        scan_id,
        job_id=job_id,
        job_timeout=job_timeout_seconds(),
        result_ttl=0,
        failure_ttl=24 * 3600,
    )
    return job, True
