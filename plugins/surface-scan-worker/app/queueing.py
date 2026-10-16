"""Enqueueing render jobs, shared by the webhook and the poller.

One job per scan at a time: the job id is derived from the scan id, and a scan that already has a
live job is not enqueued again (the poller would otherwise pile up a duplicate every pass while a scan
waits its turn). The job itself is also idempotent: it only renders a row that is still ``pending`` and
claims it under OCC.

"Live" means queued, scheduled, deferred, or started by a worker that is still registered in Redis. A
job left ``started`` by a worker that died (the container was killed; rq only notices after the job
timeout) is NOT live: it must not block "Render again", so it is removed and the scan enqueued afresh.
"""

from __future__ import annotations

import os

from rq import Queue
from rq.worker import BaseWorker

from app.jobs.render_scan import render_scan
from app.lib.job_config import job_timeout_seconds

QUEUE_NAME = os.getenv("QUEUE_NAME", "surface-scan-worker")

_WAITING = {"queued", "scheduled", "deferred"}


def job_id_for(scan_id: str) -> str:
    return f"surface-scan-{scan_id}"


def job_is_live(queue: Queue, job) -> bool:
    """True when *job* is waiting to run or is running on a worker that is still alive.

    rq keeps a worker's key in Redis with a TTL that its heartbeat refreshes, so a missing key means
    the worker is gone.
    """
    status = job.get_status(refresh=True)
    if status in _WAITING:
        return True
    if status == "started":
        name = getattr(job, "worker_name", None)
        return bool(name) and bool(
            queue.connection.exists(f"{BaseWorker.redis_worker_namespace_prefix}{name}")
        )
    return False


def enqueue_render(queue: Queue, scan_id: str):
    """Enqueue a render of *scan_id*. Returns ``(job, enqueued)``; ``enqueued`` is False when a live
    job for the scan already exists."""
    job_id = job_id_for(scan_id)
    existing = queue.fetch_job(job_id)
    if existing is not None:
        if job_is_live(queue, existing):
            return existing, False
        if existing.get_status(refresh=True) == "started":
            # A dead worker's job. Job.delete also takes it out of the started registry and drops its
            # executions; otherwise rq's cleanup would later fail the fresh job that reuses its id.
            existing.delete(remove_from_queue=True)
    job = queue.enqueue(
        render_scan,
        scan_id,
        job_id=job_id,
        job_timeout=job_timeout_seconds(),
        result_ttl=0,
        failure_ttl=24 * 3600,
    )
    return job, True
