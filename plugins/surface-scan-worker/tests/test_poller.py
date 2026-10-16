"""The poller: pending rows get enqueued once, stuck 'rendering' rows get failed."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest

from app import poller
from app.lib import directus_client

from .conftest import OTHER_SCAN, SCAN


@pytest.fixture
def queue(monkeypatch):
    q = MagicMock()
    q.fetch_job.return_value = None
    q.enqueue.side_effect = lambda fn, scan_id, **kw: MagicMock(id=kw["job_id"])
    return q


def _list_scans(world, monkeypatch):
    """Fake list_scans over world.rows (status and optional updated_before filter)."""

    def list_scans(status, limit=50, updated_before_iso=None):
        rows = [r for r in world.rows.values() if r["render_status"] == status]
        if updated_before_iso:
            rows = [r for r in rows if r["updated_at"] < updated_before_iso]
        return rows[:limit]

    monkeypatch.setattr(directus_client, "list_scans", list_scans)


def test_every_pending_row_is_enqueued(world, monkeypatch, queue):
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN)
    world.add_scan(OTHER_SCAN)
    world.add_scan("2b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e33", status="done")
    assert poller.enqueue_pending(queue) == 2
    ids = sorted(c.kwargs["job_id"] for c in queue.enqueue.call_args_list)
    assert ids == sorted([f"surface-scan-{SCAN}", f"surface-scan-{OTHER_SCAN}"])


def test_a_scan_already_queued_is_not_enqueued_again(world, monkeypatch, queue):
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN)
    queued = MagicMock(id=f"surface-scan-{SCAN}")
    queued.get_status.return_value = "queued"
    queue.fetch_job.return_value = queued
    assert poller.enqueue_pending(queue) == 0
    queue.enqueue.assert_not_called()


def test_a_stuck_rendering_row_is_failed_after_timeout_plus_grace(world, monkeypatch):
    _list_scans(world, monkeypatch)
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", "3600")
    monkeypatch.setenv("REAPER_GRACE_SECONDS", "600")
    now = datetime(2026, 10, 15, 12, 0, tzinfo=UTC)
    old = world.add_scan(SCAN, status="rendering")
    old["updated_at"] = (now - timedelta(seconds=4300)).isoformat()
    fresh = world.add_scan(OTHER_SCAN, status="rendering")
    fresh["updated_at"] = (now - timedelta(seconds=4000)).isoformat()

    assert poller.reap_once(now) == [SCAN]

    assert world.rows[SCAN]["render_status"] == "failed"
    assert "time limit" in world.rows[SCAN]["render_error"]
    assert world.rows[OTHER_SCAN]["render_status"] == "rendering"


def test_a_row_that_finished_since_listing_is_left_alone(world, monkeypatch):
    world.add_scan(SCAN, status="rendering")

    def stale_list(status, limit=50, updated_before_iso=None):
        row = dict(world.rows[SCAN])
        world.rows[SCAN]["render_status"] = (
            "done"  # the job finished right after we listed it
        )
        return [row]

    monkeypatch.setattr(directus_client, "list_scans", stale_list)
    assert poller.fail_rendering("x") == []
    assert world.rows[SCAN]["render_status"] == "done"


def test_the_startup_sweep_spares_rows_claimed_after_start(world, monkeypatch):
    _list_scans(world, monkeypatch)
    started = datetime(2026, 10, 15, 12, 0, tzinfo=UTC)
    orphan = world.add_scan(SCAN, status="rendering")
    orphan["updated_at"] = (started - timedelta(minutes=5)).isoformat()
    mine = world.add_scan(OTHER_SCAN, status="rendering")
    mine["updated_at"] = (started + timedelta(seconds=3)).isoformat()

    assert poller.fail_rendering(poller.RESTART_MESSAGE, older_than=started) == [SCAN]
    assert "Render again" in world.rows[SCAN]["render_error"]
    assert world.rows[OTHER_SCAN]["render_status"] == "rendering"


def test_a_failing_row_does_not_stop_the_sweep(world, monkeypatch):
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN, status="rendering")
    world.add_scan(OTHER_SCAN, status="rendering")
    real = directus_client.patch_scan
    calls = []

    def flaky(scan_id, payload, version=None):
        calls.append(scan_id)
        if scan_id == SCAN:
            raise RuntimeError("directus hiccup")
        return real(scan_id, payload, version)

    monkeypatch.setattr(directus_client, "patch_scan", flaky)
    assert poller.fail_rendering("x") == [OTHER_SCAN]
    assert set(calls) == {SCAN, OTHER_SCAN}
