"""Jobs are enqueued with an explicit, configurable job_timeout (rq's default is 180 s)."""

from unittest.mock import MagicMock

import pytest

from app.lib.job_config import (
    DEFAULT_JOB_TIMEOUT_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    job_timeout_seconds,
    poll_interval_seconds,
)
from app.queueing import enqueue_render, job_id_for

SCAN = "0b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e11"


def _queue(existing=None):
    q = MagicMock()
    q.fetch_job.return_value = existing
    q.enqueue.return_value = MagicMock(id=job_id_for(SCAN))
    return q


def test_default_timeout_is_one_hour(monkeypatch):
    monkeypatch.delenv("JOB_TIMEOUT_SECONDS", raising=False)
    q = _queue()
    _, enqueued = enqueue_render(q, SCAN)
    assert enqueued
    assert q.enqueue.call_args.kwargs["job_timeout"] == 3600
    assert DEFAULT_JOB_TIMEOUT_SECONDS == 3600


def test_timeout_is_configurable(monkeypatch):
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", "90000")
    q = _queue()
    enqueue_render(q, SCAN)
    assert q.enqueue.call_args.kwargs["job_timeout"] == 90000


@pytest.mark.parametrize("bad", ["abc", "0", "-5"])
def test_bad_timeout_falls_back_to_default(monkeypatch, bad):
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", bad)
    assert job_timeout_seconds() == DEFAULT_JOB_TIMEOUT_SECONDS


def test_poll_interval_default_and_floor(monkeypatch):
    monkeypatch.delenv("POLL_INTERVAL_SECONDS", raising=False)
    assert poll_interval_seconds() == DEFAULT_POLL_INTERVAL_SECONDS
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "1")
    assert poll_interval_seconds() == 5


@pytest.mark.parametrize("status", ["queued", "started", "scheduled", "deferred"])
def test_a_live_job_for_the_scan_is_not_enqueued_twice(status):
    existing = MagicMock(id=job_id_for(SCAN))
    existing.get_status.return_value = status
    q = _queue(existing)
    job, enqueued = enqueue_render(q, SCAN)
    assert not enqueued
    assert job is existing
    q.enqueue.assert_not_called()


@pytest.mark.parametrize("status", ["finished", "failed", "canceled", "stopped"])
def test_a_finished_job_does_not_block_a_new_one(status):
    existing = MagicMock()
    existing.get_status.return_value = status
    q = _queue(existing)
    _, enqueued = enqueue_render(q, SCAN)
    assert enqueued
    assert q.enqueue.call_args.kwargs["job_id"] == f"surface-scan-{SCAN}"
