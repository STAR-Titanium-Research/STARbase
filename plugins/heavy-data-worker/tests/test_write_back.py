"""OCC-guarded write-back and status transition rules (review finding 6.6).

A tiny in-memory stand-in for Directus implements the api-contract section 7.2
behaviour: a PATCH with ``filter[version][_eq]=<v>`` that doesn't match the row
returns ``{"data": null}`` and changes nothing; a match bumps ``version``.
"""

import copy

import pytest

from app.jobs import process_session as job
from app.lib import directus_client
from app.lib.statuses import (
    ALLOWED_STATUSES,
    STATUS_ANALYSED,
    STATUS_ANALYSING,
    STATUS_FAILED,
    STATUS_PROCESSED,
    STATUS_PROCESSING,
    resolve_status,
)


class _Resp:
    def __init__(self, body, status=200):
        self._body, self.status_code = body, status

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            msg = f"HTTP {self.status_code}"
            raise RuntimeError(msg)


class FakeDirectus:
    def __init__(self, row):
        self.row = row
        self.patches: list[dict] = []  # {"params":..., "json":...}
        self.gets = 0
        self.fail_get = False
        self.always_conflict = False
        self.empty_array_on_conflict = False
        self.before_patch = None  # callable(fake) run before each PATCH is applied

    def get(self, url, params=None, headers=None, timeout=None):
        self.gets += 1
        if self.fail_get:
            return _Resp({}, 500)
        return _Resp({"data": copy.deepcopy(self.row)})

    def patch(self, url, json=None, params=None, headers=None, timeout=None):
        self.patches.append({"params": params, "json": copy.deepcopy(json)})
        if self.before_patch:
            self.before_patch(self)
        expected = (params or {}).get("filter[version][_eq]")
        if self.always_conflict or (
            expected is not None and str(self.row["version"]) != str(expected)
        ):
            return _Resp({"data": [] if self.empty_array_on_conflict else None})
        self.row.update(copy.deepcopy(json))
        self.row["version"] += 1
        return _Resp({"data": copy.deepcopy(self.row)})


@pytest.fixture
def fake(monkeypatch):
    f = FakeDirectus(
        {
            "session_id": "s1",
            "status": STATUS_PROCESSING,
            "summary_stats": {"fft_analysis": {"rms": 1.0}},
            "plot_uris": ["minio://b/a.svg"],
            "version": 7,
        }
    )
    monkeypatch.setattr(directus_client.requests, "get", f.get)
    monkeypatch.setattr(directus_client.requests, "patch", f.patch)
    monkeypatch.setattr(directus_client.time, "sleep", lambda s: None)
    return f


def test_get_requests_version(fake, monkeypatch):
    seen = {}

    def get(url, params=None, **kw):
        seen["params"] = params
        return _Resp({"data": {"version": 1}})

    monkeypatch.setattr(directus_client.requests, "get", get)
    directus_client.get_test_session("s1")
    assert "version" in seen["params"]["fields"].split(",")


def test_patch_carries_occ_filter_and_no_version_in_body(fake):
    job._merge_outputs("s1", "basic", {"n": 1}, "minio://b/o.svg", STATUS_PROCESSED)
    assert len(fake.patches) == 1
    p = fake.patches[0]
    assert p["params"] == {"filter[version][_eq]": "7"}
    assert "version" not in p["json"]
    assert fake.row["summary_stats"] == {
        "fft_analysis": {"rms": 1.0},
        "basic": {"n": 1},
    }
    assert fake.row["plot_uris"] == ["minio://b/a.svg", "minio://b/o.svg"]
    assert fake.row["status"] == STATUS_PROCESSED


def test_conflict_rereads_and_remerges_keeping_concurrent_write(fake):
    def concurrent_writer(f):
        if len(f.patches) == 1:  # only before our first attempt lands
            f.row["summary_stats"]["other"] = {"x": 1}
            f.row["version"] += 1

    fake.before_patch = concurrent_writer
    job._merge_outputs("s1", "basic", {"n": 1}, "minio://b/o.svg", STATUS_PROCESSED)

    assert len(fake.patches) == 2
    assert fake.gets == 2
    assert fake.patches[1]["params"] == {"filter[version][_eq]": "8"}
    assert set(fake.row["summary_stats"]) == {"fft_analysis", "other", "basic"}


def test_empty_array_response_is_a_conflict_too(fake):
    fake.empty_array_on_conflict = True
    calls = {"n": 0}

    def once(f):
        calls["n"] += 1
        if calls["n"] == 1:
            f.row["version"] += 1

    fake.before_patch = once
    job._merge_outputs("s1", "basic", {"n": 1}, "u", STATUS_PROCESSED)
    assert len(fake.patches) == 2


def test_conflicts_are_bounded(fake):
    fake.always_conflict = True
    with pytest.raises(directus_client.VersionConflictError):
        job._merge_outputs("s1", "basic", {"n": 1}, "u", STATUS_PROCESSED)
    assert len(fake.patches) == directus_client.OCC_MAX_ATTEMPTS
    assert fake.row["summary_stats"] == {"fft_analysis": {"rms": 1.0}}


def test_read_failure_aborts_without_writing(fake):
    fake.fail_get = True
    with pytest.raises(RuntimeError):
        job._merge_outputs("s1", "basic", {"n": 1}, "u", STATUS_PROCESSED)
    assert fake.patches == []
    assert fake.row["summary_stats"] == {"fft_analysis": {"rms": 1.0}}


def test_row_without_version_is_not_written_blind(fake):
    del fake.row["version"]
    with pytest.raises(ValueError, match="version"):
        job._merge_outputs("s1", "basic", {"n": 1}, "u", STATUS_PROCESSED)
    assert fake.patches == []


def test_job_marks_failed_not_fresh_write_when_read_fails(fake, monkeypatch, tmp_path):
    """process_session: GET failing at write-back must not overwrite summary_stats."""
    from app.lib import minio_client

    fake.fail_get = False
    monkeypatch.setattr(job, "streaming_stats", lambda *a, **k: {"n": 1})
    monkeypatch.setattr(job, "parse_header", lambda fh: {"n_channels": 6})
    monkeypatch.setattr(job, "strided_read", lambda *a, **k: None)
    monkeypatch.setattr(job, "plot_overview", lambda *a, **k: b"<svg/>")
    monkeypatch.setattr(minio_client, "download_file", lambda k, p: None)
    monkeypatch.setattr(minio_client, "put_object", lambda *a, **k: None)

    def boom(*a, **k):
        raise RuntimeError("directus down")

    monkeypatch.setattr(job, "_merge_outputs", boom)
    with pytest.raises(RuntimeError):
        job.process_session("s1", "a/b.d1f")
    assert fake.row["status"] == STATUS_FAILED
    assert fake.row["summary_stats"] == {"fft_analysis": {"rms": 1.0}}


# --- status transition rules -------------------------------------------------


def test_late_processed_does_not_overwrite_analysed(fake):
    fake.row["status"] = STATUS_ANALYSED
    job._merge_outputs("s1", "basic", {"n": 1}, "u", STATUS_PROCESSED)
    assert fake.row["status"] == STATUS_ANALYSED
    assert "basic" in fake.row["summary_stats"]  # stats still merged


def test_processed_does_not_displace_in_flight_analysing(fake):
    fake.row["status"] = STATUS_ANALYSING
    job._merge_outputs("s1", "basic", {"n": 1}, "u", STATUS_PROCESSED)
    assert fake.row["status"] == STATUS_ANALYSING


def test_failed_does_not_overwrite_a_good_result(fake):
    for good in (STATUS_PROCESSED, STATUS_ANALYSED):
        fake.row["status"] = good
        job._mark("s1", STATUS_FAILED)
        assert fake.row["status"] == good


def test_failed_overwrites_in_flight_status(fake):
    job._mark("s1", STATUS_FAILED)
    assert fake.row["status"] == STATUS_FAILED


def test_processing_mark_does_not_displace_analysing(fake):
    fake.row["status"] = STATUS_ANALYSING
    job._mark("s1", STATUS_PROCESSING)
    assert fake.row["status"] == STATUS_ANALYSING
    assert fake.patches == []  # nothing to write: no PATCH at all


def test_resolve_status_table():
    assert resolve_status("processing", "processed") == "processed"
    assert resolve_status("failed", "processed") == "processed"
    assert resolve_status("analysed", "processed") is None
    assert resolve_status("processing", "analysed") == "analysed"
    assert resolve_status("failed", "analysed") == "analysed"
    assert resolve_status("analysed", "analysed") is None
    assert resolve_status("processed", "failed") is None
    assert resolve_status("analysing", "failed") == "failed"
    assert resolve_status(None, "processing") == "processing"
    assert resolve_status("something-legacy", "processing") == "processing"
    for target in ("processing", "analysing", "processed", "analysed", "failed"):
        assert target in ALLOWED_STATUSES
