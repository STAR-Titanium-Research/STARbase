"""Rows whose render job died (OOM kill of the rq work-horse) and the startup sweep's start time."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from app import poller, queueing
from app.lib import directus_client

from .conftest import OTHER_SCAN, SCAN


def _job(status, worker="w1"):
    j = MagicMock()
    j.get_status.return_value = status
    j.worker_name = worker
    return j


@pytest.fixture
def queue():
    """A queue whose Redis knows one live worker, 'w1'."""
    q = MagicMock()
    q.fetch_job.return_value = None
    q.connection.exists.side_effect = lambda key: key == "rq:worker:w1"
    q.enqueue.side_effect = lambda fn, scan_id, **kw: MagicMock(id=kw["job_id"])
    return q


@pytest.fixture
def listed(world, monkeypatch):
    def list_scans(status, limit=50, updated_before_iso=None):
        rows = [r for r in world.rows.values() if r["render_status"] == status]
        if updated_before_iso:
            rows = [r for r in rows if r["updated_at"] < updated_before_iso]
        return rows[:limit]

    monkeypatch.setattr(directus_client, "list_scans", list_scans)
    return world


# --- 3. a killed work-horse leaves a 'rendering' row -----------------------------------------------


@pytest.mark.parametrize(
    "job",
    [None, _job("failed"), _job("stopped"), _job("canceled"), _job("finished")],
    ids=["gone", "failed", "stopped", "canceled", "finished"],
)
def test_a_rendering_row_with_no_live_job_is_failed_with_the_memory_message(
    listed, queue, job
):
    listed.add_scan(SCAN, status="rendering")
    queue.fetch_job.return_value = job
    assert poller.fail_killed(queue) == [SCAN]
    row = listed.rows[SCAN]
    assert row["render_status"] == "failed"
    assert "out of memory" in row["render_error"]
    assert "Render again" in row["render_error"]
    assert "SURFACE_SCAN_MEMORY_LIMIT" in row["render_error"]
    queue.fetch_job.assert_called_with(f"surface-scan-{SCAN}")


def test_a_job_started_by_a_dead_worker_counts_as_dead(listed, queue):
    listed.add_scan(SCAN, status="rendering")
    queue.fetch_job.return_value = _job("started", worker="gone-worker")
    assert poller.fail_killed(queue) == [SCAN]


@pytest.mark.parametrize(
    "job",
    [_job("started"), _job("queued"), _job("scheduled"), _job("deferred")],
    ids=["running", "queued", "scheduled", "deferred"],
)
def test_a_row_whose_job_is_live_is_left_alone(listed, queue, job):
    listed.add_scan(SCAN, status="rendering")
    queue.fetch_job.return_value = job
    assert poller.fail_killed(queue) == []
    assert listed.rows[SCAN]["render_status"] == "rendering"


def test_a_row_that_finished_since_it_was_listed_is_not_failed(
    world, monkeypatch, queue
):
    world.add_scan(SCAN, status="rendering")

    def list_then_finish(status, limit=50, updated_before_iso=None):
        row = dict(world.rows[SCAN])
        world.rows[SCAN]["render_status"] = (
            "done"  # the job wrote 'done' and was deleted
        )
        return [row]

    monkeypatch.setattr(directus_client, "list_scans", list_then_finish)
    queue.fetch_job.return_value = None  # result_ttl=0: a finished job is gone
    assert poller.fail_killed(queue) == []
    assert world.rows[SCAN]["render_status"] == "done"


def test_one_bad_row_does_not_stop_the_check(listed, queue):
    listed.add_scan(SCAN, status="rendering")
    listed.add_scan(OTHER_SCAN, status="rendering")
    queue.fetch_job.side_effect = [RuntimeError("redis hiccup"), None]
    assert poller.fail_killed(queue) == [OTHER_SCAN]


def test_the_oom_failure_is_not_waited_for_the_timeout(listed, queue):
    """The row was claimed seconds ago: the timeout sweep would not touch it, the dead job does."""
    row = listed.add_scan(SCAN, status="rendering")
    row["updated_at"] = datetime.now(UTC).isoformat()
    assert poller.reap_once() == []
    queue.fetch_job.return_value = _job("failed")
    assert poller.fail_killed(queue) == [SCAN]


def test_render_again_after_a_kill_enqueues_even_if_rq_still_lists_the_job_started(
    queue,
):
    """The container died mid-render: rq keeps the job 'started' until its timeout. It must not block."""
    dead = _job("started", worker="gone-worker")
    queue.fetch_job.return_value = dead
    job, enqueued = queueing.enqueue_render(queue, SCAN)
    assert enqueued
    dead.delete.assert_called_once_with(remove_from_queue=True)
    assert queue.enqueue.call_args.kwargs["job_id"] == f"surface-scan-{SCAN}"


def test_a_job_started_by_a_live_worker_still_blocks_a_second_enqueue(queue):
    running = _job("started", worker="w1")
    queue.fetch_job.return_value = running
    job, enqueued = queueing.enqueue_render(queue, SCAN)
    assert not enqueued and job is running
    queue.enqueue.assert_not_called()
    running.delete.assert_not_called()


def test_a_failed_job_is_replaced_by_enqueueing_over_it(queue):
    failed = _job("failed")
    queue.fetch_job.return_value = failed
    _, enqueued = queueing.enqueue_render(queue, SCAN)
    assert enqueued
    failed.delete.assert_not_called()


# --- 2. the startup sweep's start time -------------------------------------------------------------


def test_started_at_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("SURFACE_SCAN_STARTED_AT", "2026-10-15T12:00:00Z")
    assert poller.started_at() == datetime(2026, 10, 15, 12, 0, tzinfo=UTC)


def test_started_at_falls_back_to_now_on_garbage_or_absence(monkeypatch):
    before = datetime.now(UTC)
    for value in ("", "yesterday-ish"):
        monkeypatch.setenv("SURFACE_SCAN_STARTED_AT", value)
        assert before <= poller.started_at() <= datetime.now(UTC)
    monkeypatch.delenv("SURFACE_SCAN_STARTED_AT")
    assert before <= poller.started_at() <= datetime.now(UTC)


class _StopError(Exception):
    pass


def _run_one_pass(monkeypatch):
    """Run run_forever until its first sleep; return what the startup sweep was called with."""
    calls = []
    monkeypatch.setattr(poller, "get_redis", lambda: MagicMock())
    monkeypatch.setattr(poller, "Queue", lambda *a, **k: MagicMock())
    monkeypatch.setattr(
        poller,
        "fail_rendering",
        lambda message, older_than=None: calls.append((message, older_than)),
    )
    for name in ("fail_killed", "enqueue_pending", "reap_once"):
        monkeypatch.setattr(poller, name, lambda *a, **k: [])

    def stop(_seconds):
        raise _StopError

    monkeypatch.setattr(poller.time, "sleep", stop)
    with pytest.raises(_StopError):
        poller.run_forever()
    return calls


def test_the_startup_sweep_uses_the_start_time_the_entrypoint_took(monkeypatch):
    monkeypatch.setenv("SURFACE_SCAN_STARTED_AT", "2026-10-15T12:00:00Z")
    (call,) = _run_one_pass(monkeypatch)
    assert call == (poller.RESTART_MESSAGE, datetime(2026, 10, 15, 12, 0, tzinfo=UTC))


def test_a_row_claimed_after_the_container_started_survives_the_sweep(
    listed, monkeypatch
):
    """The race: the poller is still importing while a worker claims a row. The row's updated_at is
    after the entrypoint's start time, so the sweep must leave it for its job to finish."""
    monkeypatch.setenv("SURFACE_SCAN_STARTED_AT", "2026-10-15T12:00:00Z")
    orphan = listed.add_scan(SCAN, status="rendering")
    orphan["updated_at"] = "2026-10-15T11:58:00+00:00"
    claimed = listed.add_scan(OTHER_SCAN, status="rendering")
    claimed["updated_at"] = (
        "2026-10-15T12:00:02+00:00"  # claimed during the poller's imports
    )

    assert poller.fail_rendering(
        poller.RESTART_MESSAGE, older_than=poller.started_at()
    ) == [SCAN]
    assert listed.rows[OTHER_SCAN]["render_status"] == "rendering"


def test_the_poll_pass_order_is_sweep_then_dead_jobs_then_enqueue_then_timeout(
    monkeypatch,
):
    order = []
    monkeypatch.setattr(poller, "get_redis", lambda: MagicMock())
    monkeypatch.setattr(poller, "Queue", lambda *a, **k: MagicMock())
    monkeypatch.setattr(poller, "fail_rendering", lambda *a, **k: order.append("sweep"))
    monkeypatch.setattr(poller, "fail_killed", lambda *a, **k: order.append("dead"))
    monkeypatch.setattr(
        poller, "enqueue_pending", lambda *a, **k: order.append("enqueue")
    )
    monkeypatch.setattr(poller, "reap_once", lambda *a, **k: order.append("timeout"))
    monkeypatch.setattr(
        poller.time, "sleep", lambda s: (_ for _ in ()).throw(_StopError())
    )
    with pytest.raises(_StopError):
        poller.run_forever()
    assert order == ["sweep", "dead", "enqueue", "timeout"]
