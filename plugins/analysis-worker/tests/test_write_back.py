"""OCC-guarded write-back and status transition rules (review finding 6.6).

A tiny in-memory stand-in for Directus implements the api-contract section 7.2
behaviour: a PATCH with ``filter[version][_eq]=<v>`` that doesn't match the row
returns ``{"data": null}`` and changes nothing; a match bumps ``version``.
"""

import copy

import pytest

from app.jobs import analyse_session as job
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
            "status": STATUS_ANALYSING,
            "summary_stats": {"basic": {"n": 9}},
            "plot_uris": ["minio://b/a.svg"],
            "version": 7,
        }
    )
    monkeypatch.setattr(directus_client.requests, "get", f.get)
    monkeypatch.setattr(directus_client.requests, "patch", f.patch)
    monkeypatch.setattr(directus_client.time, "sleep", lambda s: None)
    return f


def _merge(**kw):
    return job._merge_outputs(
        "s1", "fft_analysis", {"rms": 2.0}, "minio://b/f.svg", STATUS_ANALYSED, **kw
    )


def test_get_requests_version(fake, monkeypatch):
    seen = {}

    def get(url, params=None, **kw):
        seen["params"] = params
        return _Resp({"data": {"version": 1}})

    monkeypatch.setattr(directus_client.requests, "get", get)
    directus_client.get_test_session("s1")
    assert "version" in seen["params"]["fields"].split(",")


def test_patch_carries_occ_filter_and_no_version_in_body(fake):
    _merge()
    assert len(fake.patches) == 1
    p = fake.patches[0]
    assert p["params"] == {"filter[version][_eq]": "7"}
    assert "version" not in p["json"]
    assert fake.row["summary_stats"] == {
        "basic": {"n": 9},
        "fft_analysis": {"rms": 2.0},
    }
    assert fake.row["plot_uris"] == ["minio://b/a.svg", "minio://b/f.svg"]
    assert fake.row["status"] == STATUS_ANALYSED


def test_conflict_rereads_and_remerges_keeping_concurrent_write(fake):
    def concurrent_writer(f):
        if len(f.patches) == 1:
            f.row["summary_stats"]["other"] = {"x": 1}
            f.row["version"] += 1

    fake.before_patch = concurrent_writer
    _merge()
    assert len(fake.patches) == 2
    assert fake.gets == 2
    assert fake.patches[1]["params"] == {"filter[version][_eq]": "8"}
    assert set(fake.row["summary_stats"]) == {"basic", "other", "fft_analysis"}


def test_conflicts_are_bounded(fake):
    fake.always_conflict = True
    with pytest.raises(directus_client.VersionConflictError):
        _merge()
    assert len(fake.patches) == directus_client.OCC_MAX_ATTEMPTS
    assert fake.row["summary_stats"] == {"basic": {"n": 9}}


def test_read_failure_aborts_without_writing(fake):
    fake.fail_get = True
    with pytest.raises(RuntimeError):
        _merge()
    assert fake.patches == []
    assert fake.row["summary_stats"] == {"basic": {"n": 9}}


def test_row_without_version_is_not_written_blind(fake):
    del fake.row["version"]
    with pytest.raises(ValueError, match="version"):
        _merge()
    assert fake.patches == []


def test_analysed_overwrites_processed_or_processing(fake):
    for before in (STATUS_PROCESSING, STATUS_PROCESSED, STATUS_FAILED):
        fake.row["status"] = before
        _merge()
        assert fake.row["status"] == STATUS_ANALYSED


def test_failed_does_not_overwrite_a_good_result(fake):
    for good in (STATUS_PROCESSED, STATUS_ANALYSED):
        fake.row["status"] = good
        job._mark("s1", STATUS_FAILED)
        assert fake.row["status"] == good


def test_failed_overwrites_in_flight_status(fake):
    job._mark("s1", STATUS_FAILED)  # row is 'analysing'
    assert fake.row["status"] == STATUS_FAILED


def test_analysing_mark_does_not_displace_processing(fake):
    fake.row["status"] = STATUS_PROCESSING
    job._mark("s1", STATUS_ANALYSING)
    assert fake.row["status"] == STATUS_PROCESSING
    assert fake.patches == []


def test_resolve_status_table():
    assert resolve_status("processing", "processed") == "processed"
    assert resolve_status("analysed", "processed") is None
    assert resolve_status("processing", "analysed") == "analysed"
    assert resolve_status("analysed", "analysed") is None
    assert resolve_status("processed", "failed") is None
    assert resolve_status("analysing", "failed") == "failed"
    for target in ("processing", "analysing", "processed", "analysed", "failed"):
        assert target in ALLOWED_STATUSES
