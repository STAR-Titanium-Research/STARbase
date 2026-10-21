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


def test_fingerprint_is_a_filtered_list_get_with_its_staleness_key(http):
    row = {
        "status": "done",
        "content_sha256": "ab" * 32,
        "size_bytes": 10,
        "source_mtime": "2025-10-09T08:53:20+00:00",
    }
    http.get.return_value = _resp(body={"data": [row]})
    assert dc.get_fingerprint("f1") == row
    url = http.get.call_args.args[0]
    params = http.get.call_args.kwargs["params"]
    assert url.endswith(
        "/items/file_fingerprints"
    )  # not .../f1: a missing id would be a 403
    assert params["filter[directus_files_id][_eq]"] == "f1"
    assert params["limit"] == "1"
    # columns of migration 20261010000159, including both halves of the staleness key
    assert set(params["fields"].split(",")) == {
        "status",
        "content_sha256",
        "size_bytes",
        "source_mtime",
    }
    http.patch.assert_not_called()
    http.post.assert_not_called()
    http.put.assert_not_called()
    http.delete.assert_not_called()


def test_no_fingerprint_is_an_empty_list_and_is_none_without_a_warning(http, caplog):
    http.get.return_value = _resp(body={"data": []})
    with caplog.at_level("WARNING"):
        assert dc.get_fingerprint("f1") is None
    assert "permission" not in caplog.text and "may not read" not in caplog.text


def test_a_403_is_a_real_permission_problem_and_is_logged_as_one(http, caplog):
    http.get.return_value = _resp(status=403)
    with caplog.at_level("WARNING"):
        assert (
            dc.get_fingerprint("f1") is None
        )  # still falls back to the provisional key
    assert "may not read file_fingerprints" in caplog.text


def test_a_server_error_reading_the_fingerprint_propagates(http):
    http.get.return_value = _resp(status=500)
    with pytest.raises(requests.HTTPError):
        dc.get_fingerprint("f1")


def test_team_folders_are_a_filtered_list_of_share_folders(http):
    http.get.return_value = _resp(
        body={
            "data": [
                {"share_folder": "Alloys"},
                {"share_folder": None},
                {"share_folder": "Sintering"},
            ]
        }
    )
    assert dc.get_team_folders() == ["Alloys", "Sintering"]
    args, kwargs = http.get.call_args
    assert args[0].endswith("/items/teams")
    assert kwargs["params"]["filter[share_folder][_nnull]"] == "true"
    assert kwargs["params"]["limit"] == "-1"


def test_a_failed_team_lookup_raises_so_the_file_is_refused(http):
    http.get.return_value = _resp(status=403)
    with pytest.raises(requests.HTTPError):
        dc.get_team_folders()


def test_get_file_asks_for_the_owner_stamps(http):
    http.get.return_value = _resp(body={"data": {"id": "x"}})
    dc.get_file("x")
    fields = http.get.call_args.kwargs["params"]["fields"].split(",")
    assert {"owner_person_id", "owner_team_id"} <= set(fields)
