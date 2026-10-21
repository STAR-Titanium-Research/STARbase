"""The poller: pending rows get enqueued once, stuck 'rendering' rows get failed."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
import requests

from app import poller
from app.lib import directus_client

from .conftest import OTHER_FILE, OTHER_SCAN, SCAN


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
    assert "time limit" in world.renders[SCAN]["render_error"]
    assert world.rows[OTHER_SCAN]["render_status"] == "rendering"
    assert world.history == []  # the public row is never PATCHed with the error


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
    assert "Render again" in world.renders[SCAN]["render_error"]
    assert world.rows[OTHER_SCAN]["render_status"] == "rendering"


def test_a_failing_row_does_not_stop_the_sweep(world, monkeypatch):
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN, status="rendering")
    world.add_scan(OTHER_SCAN, status="rendering")
    real = directus_client.post_result
    calls = []

    def flaky(scan_id, payload, version, files_id):
        calls.append(scan_id)
        if scan_id == SCAN:
            raise RuntimeError("directus hiccup")
        return real(scan_id, payload, version, files_id)

    monkeypatch.setattr(directus_client, "post_result", flaky)
    assert poller.fail_rendering("x") == [OTHER_SCAN]
    assert set(calls) == {SCAN, OTHER_SCAN}


def test_a_stuck_row_is_failed_through_the_result_route_with_the_version_and_file_read(
    world, monkeypatch
):
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN, file_id=OTHER_FILE, status="rendering")
    world.rows[SCAN]["version"] = 7
    assert poller.fail_rendering("too slow") == [SCAN]
    assert (
        world.results
        == [
            (
                SCAN,
                {
                    "version": 7,
                    "directus_files_id": OTHER_FILE,  # the row's own file, as read in that pass
                    "render_status": "failed",
                    "render_error": "too slow",
                },
            )
        ]
    )
    assert world.rows[SCAN]["render_status"] == "failed"
    assert world.renders[SCAN] == {"render_error": "too slow"}


def test_a_409_failing_a_stuck_row_is_retried(world, monkeypatch):
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN, status="rendering")
    world.result_conflicts_to_inject = 1  # the worker's own result raced the poller
    assert poller.fail_rendering("x") == [SCAN]
    assert [b["version"] for _, b in world.results] == [1, 2]


def test_a_row_that_a_409_moved_out_of_rendering_is_left_alone(world, monkeypatch):
    """The 409 was the job finishing: the re-read sees 'done', so the poller does not fail it."""
    _list_scans(world, monkeypatch)
    world.add_scan(SCAN, status="rendering")
    real = world.post_result

    def job_finishes_first(scan_id, payload, version, files_id):
        world.rows[scan_id]["render_status"] = "done"
        world.rows[scan_id]["version"] += 1
        return real(scan_id, payload, version, files_id)  # 409: no longer rendering

    monkeypatch.setattr(directus_client, "post_result", job_finishes_first)
    assert poller.fail_rendering("x") == []
    assert world.rows[SCAN]["render_status"] == "done"
    assert SCAN not in world.renders


# --- the start-up token probe ----------------------------------------------------------------


def _probe_says(monkeypatch, outcome):
    """Make the probe answer an HTTP status, or raise the given exception."""

    def probe():
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(directus_client, "probe_result_route", probe)


@pytest.mark.parametrize("status", [403, 401])
def test_a_refused_token_is_critical_and_stops_the_poller(monkeypatch, caplog, status):
    _probe_says(monkeypatch, status)
    with caplog.at_level("INFO", logger="poller"):
        assert poller.verify_token() is False
    (record,) = (r for r in caplog.records if r.levelname == "CRITICAL")
    text = record.getMessage()
    assert "SURFACE_SCAN_DIRECTUS_TOKEN" in text
    assert "WORKER_DIRECTUS_TOKEN" in text
    assert "ADMINISTRATOR" in text


@pytest.mark.parametrize("status", [409, 400])
def test_an_accepted_token_carries_on(monkeypatch, caplog, status):
    """409: an administrator, the nil scan does not exist. 400: the route and the body drifted apart,
    which is not the token's fault."""
    _probe_says(monkeypatch, status)
    with caplog.at_level("INFO", logger="poller"):
        assert poller.verify_token() is True
    assert not [r for r in caplog.records if r.levelno >= 30]


@pytest.mark.parametrize(
    "outcome",
    [
        requests.ConnectionError("connection refused"),
        requests.Timeout("slow"),
        500,
        502,
        503,
        404,
    ],
)
def test_directus_starting_or_the_endpoint_not_deployed_only_warns(
    monkeypatch, caplog, outcome
):
    _probe_says(monkeypatch, outcome)
    with caplog.at_level("INFO", logger="poller"):
        assert poller.verify_token() is True
    assert [r.levelname for r in caplog.records if r.levelno >= 30] == ["WARNING"]


def test_the_poller_exits_non_zero_before_its_loop_on_a_refused_token(monkeypatch):
    _probe_says(monkeypatch, 403)
    touched = []
    monkeypatch.setattr(poller, "get_redis", lambda: touched.append("redis"))
    monkeypatch.setattr(poller.time, "sleep", lambda s: touched.append("sleep"))
    with pytest.raises(SystemExit) as exit_info:
        poller.run_forever()
    assert exit_info.value.code == 1
    assert touched == []  # it never got as far as Redis or a poll pass


def test_the_poller_loop_starts_when_the_probe_is_inconclusive(monkeypatch):
    _probe_says(monkeypatch, requests.ConnectionError("down"))
    monkeypatch.setattr(poller, "get_redis", lambda: MagicMock())
    monkeypatch.setattr(poller, "Queue", lambda *a, **k: MagicMock())
    passes = []

    class StopLoopError(Exception):
        pass

    def one_pass(queue):
        passes.append(queue)
        return []

    def stop(_seconds):
        raise StopLoopError

    monkeypatch.setattr(poller, "fail_rendering", lambda *a, **k: [])
    monkeypatch.setattr(poller, "fail_killed", one_pass)
    monkeypatch.setattr(poller, "enqueue_pending", lambda q: 0)
    monkeypatch.setattr(poller, "reap_once", lambda: [])
    monkeypatch.setattr(poller.time, "sleep", stop)
    with pytest.raises(StopLoopError):
        poller.run_forever()
    assert len(passes) == 1  # the loop ran its first pass


def test_a_refusal_that_only_shows_after_directus_is_up_still_stops_the_poller(
    monkeypatch,
):
    """Cold start: Directus is not up at the first probe, so the worker starts its loop; the token is
    asked about again at the end of each pass and a refusal then stops the poller."""
    answers = iter([requests.ConnectionError("down"), 403])

    def probe():
        outcome = next(answers)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(directus_client, "probe_result_route", probe)
    monkeypatch.setattr(poller, "get_redis", lambda: MagicMock())
    monkeypatch.setattr(poller, "Queue", lambda *a, **k: MagicMock())
    passes = []
    monkeypatch.setattr(poller, "fail_rendering", lambda *a, **k: [])
    monkeypatch.setattr(poller, "fail_killed", lambda q: passes.append(1) or [])
    monkeypatch.setattr(poller, "enqueue_pending", lambda q: 0)
    monkeypatch.setattr(poller, "reap_once", lambda: [])
    monkeypatch.setattr(
        poller.time, "sleep", lambda s: pytest.fail("it must exit before sleeping")
    )
    with pytest.raises(SystemExit) as exit_info:
        poller.run_forever()
    assert exit_info.value.code == 1
    assert passes == [1]  # one pass ran, then the second probe was refused


def test_the_probe_stops_being_asked_once_it_has_a_definite_answer(monkeypatch):
    asked = []
    answers = iter([requests.ConnectionError("down"), 409])

    def probe():
        asked.append(1)
        outcome = next(answers)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(directus_client, "probe_result_route", probe)
    monkeypatch.setattr(poller, "get_redis", lambda: MagicMock())
    monkeypatch.setattr(poller, "Queue", lambda *a, **k: MagicMock())
    for name in ("fail_rendering", "fail_killed", "enqueue_pending", "reap_once"):
        monkeypatch.setattr(poller, name, lambda *a, **k: [])
    sleeps = []

    class StopLoopError(Exception):
        pass

    def sleep(_seconds):
        sleeps.append(1)
        if len(sleeps) == 3:
            raise StopLoopError

    monkeypatch.setattr(poller.time, "sleep", sleep)
    with pytest.raises(StopLoopError):
        poller.run_forever()
    assert len(asked) == 2  # the start-up probe and one re-probe; then it is settled


def test_the_critical_message_explains_both_refusals(monkeypatch, caplog):
    _probe_says(monkeypatch, 401)
    with caplog.at_level("INFO", logger="poller"):
        assert poller.verify_token() is False
    text = next(r.getMessage() for r in caplog.records if r.levelname == "CRITICAL")
    assert "401" in text and "blank" in text and "not an administrator's" in text
