"""Reaper: sessions stranded in 'processing' are marked failed (contract section 9)."""

from datetime import UTC, datetime, timedelta

import pytest

from app import reaper
from app.lib import directus_client

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)
IN_FLIGHT = reaper.REAP_STATUSES[0]


@pytest.fixture
def server(monkeypatch):
    """Mock Directus client: rows keyed by id; records list queries and patches."""
    state = {"rows": {}, "listed": [], "patches": []}

    def list_stale(statuses, older_than_iso):
        state["listed"].append((tuple(statuses), older_than_iso))
        return [
            {"session_id": k}
            for k, r in state["rows"].items()
            if r["status"] in statuses and r["updated_at"] < older_than_iso
        ]

    def get(session_id):
        return dict(state["rows"][session_id])

    def patch(session_id, payload, version=None):
        row = state["rows"][session_id]
        state["patches"].append((session_id, payload, version))
        if version != row["version"]:
            raise directus_client.VersionConflictError("stale")
        row.update(payload)
        row["version"] += 1
        return {"data": row}

    monkeypatch.setattr(directus_client, "list_stale_sessions", list_stale)
    monkeypatch.setattr(directus_client, "get_test_session", get)
    monkeypatch.setattr(directus_client, "patch_test_session", patch)
    monkeypatch.setattr(directus_client.time, "sleep", lambda s: None)
    monkeypatch.delenv("JOB_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("REAPER_GRACE_SECONDS", raising=False)
    return state


def _row(age_hours, status=IN_FLIGHT, **extra):
    return {
        "status": status,
        "updated_at": (NOW - timedelta(hours=age_hours)).isoformat(),
        "version": 3,
        "summary_stats": {"keep": "me"},
        **extra,
    }


def test_stale_session_is_failed_with_message_and_occ(server):
    server["rows"]["old"] = _row(8)
    assert reaper.reap_once(NOW) == ["old"]

    (sid, payload, version) = server["patches"][0]
    assert version == 3  # OCC filter value
    assert payload["status"] == "failed"
    err = payload["summary_stats"]["pipeline_error"]
    assert "timed out" in err["message"] and "6 h" in err["message"]
    assert err["worker"] == reaper.WORKER_NAME
    assert payload["summary_stats"]["keep"] == "me"  # existing stats preserved


def test_recent_session_is_left_alone(server):
    server["rows"]["young"] = _row(2)  # within the 6 h timeout
    server["rows"]["edge"] = _row(6.1)  # past timeout but inside the grace period
    assert reaper.reap_once(NOW) == []
    assert server["patches"] == []


def test_cutoff_uses_configured_timeout_plus_grace(server, monkeypatch):
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", "7200")
    monkeypatch.setenv("REAPER_GRACE_SECONDS", "0")
    server["rows"]["a"] = _row(3)
    reaper.reap_once(NOW)
    statuses, cutoff = server["listed"][0]
    assert statuses == reaper.REAP_STATUSES
    assert cutoff == (NOW - timedelta(hours=2)).isoformat()
    assert server["rows"]["a"]["status"] == "failed"


def test_only_in_flight_status_is_reaped(server):
    server["rows"]["done"] = _row(30, status="processed")
    server["rows"]["bad"] = _row(30, status="failed")
    assert reaper.reap_once(NOW) == []


def test_row_that_finished_after_listing_is_not_overwritten(server, monkeypatch):
    server["rows"]["race"] = _row(8)
    real_get = directus_client.get_test_session

    def finished_meanwhile(session_id):
        server["rows"][session_id]["status"] = "analysed"
        return real_get(session_id)

    monkeypatch.setattr(directus_client, "get_test_session", finished_meanwhile)
    assert reaper.reap_once(NOW) == []
    assert server["patches"] == []
    assert server["rows"]["race"]["status"] == "analysed"


def test_row_touched_after_listing_is_not_reaped(server, monkeypatch):
    server["rows"]["race"] = _row(8)
    real_get = directus_client.get_test_session

    def touched(session_id):
        server["rows"][session_id]["updated_at"] = NOW.isoformat()
        return real_get(session_id)

    monkeypatch.setattr(directus_client, "get_test_session", touched)
    assert reaper.reap_once(NOW) == []


def test_one_failure_does_not_stop_the_pass(server, monkeypatch):
    server["rows"]["a"] = _row(8)
    server["rows"]["b"] = _row(8)
    real_get = directus_client.get_test_session

    def flaky(session_id):
        if session_id == "a":
            raise RuntimeError("directus hiccup")
        return real_get(session_id)

    monkeypatch.setattr(directus_client, "get_test_session", flaky)
    assert reaper.reap_once(NOW) == ["b"]


def test_z_suffixed_timestamps_parse():
    ts = reaper._parse_ts("2026-10-03T01:02:03.000Z")
    assert ts == datetime(2026, 10, 3, 1, 2, 3, tzinfo=UTC)
    assert reaper._parse_ts("2026-10-03T01:02:03").tzinfo is not None
    assert reaper._parse_ts(None) is None
    assert reaper._parse_ts("garbage") is None
