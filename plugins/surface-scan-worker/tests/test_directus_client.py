"""The Directus client: URLs, OCC filter, and the read-only use of file_fingerprints."""

from unittest.mock import MagicMock

import pytest
import requests

from app.lib import directus_client as dc

SCAN = "0b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e11"


def _resp(status=200, body=None):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body if body is not None else {}
    r.raise_for_status.side_effect = (
        None if status < 400 else requests.HTTPError(str(status))
    )
    return r


@pytest.fixture
def http(monkeypatch):
    m = MagicMock()
    monkeypatch.setattr(dc, "requests", m)
    monkeypatch.setattr(dc.time, "sleep", lambda s: None)
    return m


def test_patch_with_a_version_sends_the_occ_filter_not_a_body_field(http):
    http.patch.return_value = _resp(body={"data": {"scan_id": SCAN}})
    dc.patch_scan(SCAN, {"render_status": "rendering"}, version=3)
    args, kwargs = http.patch.call_args
    assert args[0].endswith(f"/items/surface_scans/{SCAN}")
    assert kwargs["params"] == {"filter[version][_eq]": "3"}
    assert kwargs["json"] == {"render_status": "rendering"}
    assert kwargs["headers"]["X-Actor-Identity"] == "surface-scan-worker"


def test_a_stale_version_is_a_conflict(http):
    http.patch.return_value = _resp(body={"data": None})
    with pytest.raises(dc.VersionConflictError):
        dc.patch_scan(SCAN, {"render_status": "rendering"}, version=3)


def test_update_scan_rereads_and_retries_after_a_conflict(http):
    http.get.side_effect = [
        _resp(body={"data": {"version": 1, "render_status": "rendering"}}),
        _resp(body={"data": {"version": 2, "render_status": "rendering"}}),
    ]
    http.patch.side_effect = [
        _resp(body={"data": None}),
        _resp(body={"data": {"ok": 1}}),
    ]
    out = dc.update_scan(SCAN, lambda row: {"render_status": "done"})
    assert out == {"data": {"ok": 1}}
    versions = [
        c.kwargs["params"]["filter[version][_eq]"] for c in http.patch.call_args_list
    ]
    assert versions == ["1", "2"]


def test_update_scan_gives_up_after_repeated_conflicts(http):
    http.get.return_value = _resp(body={"data": {"version": 1}})
    http.patch.return_value = _resp(body={"data": None})
    with pytest.raises(dc.VersionConflictError, match="gave up"):
        dc.update_scan(SCAN, lambda row: {"x": 1}, max_attempts=3)
    assert http.patch.call_count == 3


def test_update_scan_with_nothing_to_write_does_not_patch(http):
    http.get.return_value = _resp(body={"data": {"version": 1}})
    assert dc.update_scan(SCAN, lambda row: None) is None
    http.patch.assert_not_called()


def test_update_scan_never_writes_blind(http):
    http.get.return_value = _resp(body={"data": {"render_status": "rendering"}})
    with pytest.raises(ValueError, match="no version"):
        dc.update_scan(SCAN, lambda row: {"x": 1})
    http.patch.assert_not_called()


def test_list_scans_filters_by_status_and_age(http):
    http.get.return_value = _resp(body={"data": [{"scan_id": SCAN}]})
    rows = dc.list_scans(
        "rendering", limit=10, updated_before_iso="2026-10-15T00:00:00+00:00"
    )
    assert rows == [{"scan_id": SCAN}]
    params = http.get.call_args.kwargs["params"]
    assert params["filter[render_status][_eq]"] == "rendering"
    assert params["filter[updated_at][_lt]"] == "2026-10-15T00:00:00+00:00"
    assert params["limit"] == "10"


def test_fingerprint_is_a_plain_get(http):
    http.get.return_value = _resp(
        body={"data": {"status": "done", "content_sha256": "ab" * 32}}
    )
    assert dc.get_fingerprint("f1")["status"] == "done"
    assert http.get.call_args.args[0].endswith("/items/file_fingerprints/f1")
    http.patch.assert_not_called()
    http.post.assert_not_called()
    http.put.assert_not_called()
    http.delete.assert_not_called()


@pytest.mark.parametrize("status", [404, 403])
def test_no_readable_fingerprint_is_none_not_an_error(http, status):
    http.get.return_value = _resp(status=status)
    assert dc.get_fingerprint("f1") is None


def test_a_server_error_reading_the_fingerprint_propagates(http):
    http.get.return_value = _resp(status=500)
    with pytest.raises(requests.HTTPError):
        dc.get_fingerprint("f1")
