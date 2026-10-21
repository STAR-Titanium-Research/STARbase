"""The Directus client: URLs, OCC filter, and the read-only use of file_fingerprints."""

from unittest.mock import MagicMock

import pytest
import requests

from app.lib import directus_client as dc

SCAN = "0b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e11"
FILE = "5d1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c01"
OTHER_FILE = "9c1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c77"


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


# --- the result route (ADR-0023): the outcome is POSTed, never PATCHed ---------------------------


def test_scan_fields_hold_only_public_columns():
    fields = set(dc.SCAN_FIELDS.split(","))
    assert fields == {
        "scan_id",
        "directus_files_id",
        "render_status",
        "version",
        "updated_at",
    }
    assert not {"render_error", "cache_key"} & fields


def test_post_result_posts_the_version_and_file_in_the_body_to_the_endpoint(http):
    http.post.return_value = _resp(body={"data": {"scan_id": SCAN}})
    out = dc.post_result(
        SCAN, {"render_status": "failed", "render_error": "boom"}, 4, FILE
    )
    assert out == {"data": {"scan_id": SCAN}}
    args, kwargs = http.post.call_args
    assert args[0].endswith(f"/d1-surface-scan/{SCAN}/result")
    assert kwargs["json"] == {
        "render_status": "failed",
        "render_error": "boom",
        "version": 4,
        "directus_files_id": FILE,
    }
    assert kwargs["headers"]["Authorization"].startswith("Bearer ")
    assert kwargs["headers"]["X-Actor-Identity"] == "surface-scan-worker"
    http.patch.assert_not_called()


def test_post_result_does_not_mutate_the_payload(http):
    http.post.return_value = _resp(body={"data": {}})
    payload = {"render_status": "done", "columns": {"cache_key": "k"}}
    dc.post_result(SCAN, payload, 1, FILE)
    assert payload == {"render_status": "done", "columns": {"cache_key": "k"}}


def test_a_409_from_the_result_route_is_a_version_conflict(http):
    http.post.return_value = _resp(
        status=409,
        body={
            "errors": [{"message": "stale", "extensions": {"code": "VERSION_CONFLICT"}}]
        },
    )
    with pytest.raises(dc.VersionConflictError):
        dc.post_result(SCAN, {"render_status": "done"}, 3, FILE)


@pytest.mark.parametrize("status", [400, 403, 404, 500])
def test_any_other_error_from_the_result_route_propagates(http, status):
    http.post.return_value = _resp(status=status)
    with pytest.raises(requests.HTTPError):
        dc.post_result(SCAN, {"render_status": "done"}, 3, FILE)


def test_report_result_rereads_and_retries_after_a_409(http):
    http.get.side_effect = [
        _resp(body={"data": _row(1)}),
        _resp(body={"data": _row(2)}),
    ]
    http.post.side_effect = [_resp(status=409), _resp(body={"data": {"ok": 1}})]
    out = dc.report_result(
        SCAN, lambda row: {"render_status": "done"}, rendered_file_id=FILE
    )
    assert out == {"data": {"ok": 1}}
    assert [c.kwargs["json"]["version"] for c in http.post.call_args_list] == [1, 2]
    assert {
        c.kwargs["json"]["directus_files_id"] for c in http.post.call_args_list
    } == {FILE}
    http.patch.assert_not_called()


def test_report_result_gives_up_after_repeated_409s(http):
    http.get.return_value = _resp(body={"data": _row(1)})
    http.post.return_value = _resp(status=409)
    with pytest.raises(dc.VersionConflictError, match="gave up"):
        dc.report_result(
            SCAN,
            lambda row: {"render_status": "done"},
            max_attempts=3,
            rendered_file_id=FILE,
        )
    assert http.post.call_count == 3


def _row(version, file_id=FILE, status="rendering"):
    return {
        "scan_id": SCAN,
        "version": version,
        "render_status": status,
        "directus_files_id": file_id,
    }


def test_report_result_skips_a_row_that_now_points_at_another_file(http):
    """The job rendered FILE; the scan was repointed (and is 'rendering' again): nothing is posted."""
    http.get.return_value = _resp(body={"data": _row(5, file_id=OTHER_FILE)})
    compute_calls = []

    def compute(row):
        compute_calls.append(row)
        return {"render_status": "done"}

    assert dc.report_result(SCAN, compute, rendered_file_id=FILE) is None
    http.post.assert_not_called()
    assert compute_calls == []  # decided before the caller's own check


def test_report_result_skips_when_a_409_retry_finds_the_file_changed(http):
    http.get.side_effect = [
        _resp(body={"data": _row(1)}),
        _resp(body={"data": _row(3, file_id=OTHER_FILE)}),
    ]
    http.post.side_effect = [_resp(status=409)]
    assert (
        dc.report_result(
            SCAN, lambda row: {"render_status": "done"}, rendered_file_id=FILE
        )
        is None
    )
    assert http.post.call_count == 1


def test_report_result_without_a_rendered_file_posts_the_row_s_own_file(http):
    """The poller failing a stuck row: the file id is the one on the row as just read."""
    http.get.return_value = _resp(body={"data": _row(7, file_id=OTHER_FILE)})
    http.post.return_value = _resp(body={"data": {"ok": 1}})
    dc.report_result(SCAN, lambda row: {"render_status": "failed"})
    body = http.post.call_args.kwargs["json"]
    assert body == {
        "render_status": "failed",
        "version": 7,
        "directus_files_id": OTHER_FILE,
    }


def test_report_result_never_posts_without_a_file_id(http):
    http.get.return_value = _resp(
        body={"data": {"version": 1, "render_status": "rendering"}}
    )
    with pytest.raises(ValueError, match="directus_files_id"):
        dc.report_result(SCAN, lambda row: {"render_status": "failed"})
    http.post.assert_not_called()


def test_report_result_with_nothing_to_write_does_not_post(http):
    """A lost claim: compute sees a row that is no longer rendering and returns None."""
    http.get.return_value = _resp(
        body={"data": {"version": 1, "render_status": "pending"}}
    )
    assert dc.report_result(SCAN, lambda row: None) is None
    http.post.assert_not_called()


def test_report_result_never_writes_blind(http):
    http.get.return_value = _resp(body={"data": {"render_status": "rendering"}})
    with pytest.raises(ValueError, match="no version"):
        dc.report_result(SCAN, lambda row: {"render_status": "done"})
    http.post.assert_not_called()


# --- the start-up token probe ----------------------------------------------------------------


def test_probe_posts_a_harmless_failed_report_for_the_nil_scan(http):
    http.post.return_value = _resp(status=409)
    assert dc.probe_result_route() == 409
    args, kwargs = http.post.call_args
    nil = "00000000-0000-0000-0000-000000000000"
    assert args[0].endswith(f"/d1-surface-scan/{nil}/result")
    assert kwargs["json"] == {
        "version": 1,
        "directus_files_id": nil,
        "render_status": "failed",
        "render_error": "token probe",
    }
    assert kwargs["headers"]["Authorization"].startswith("Bearer ")
    http.patch.assert_not_called()


@pytest.mark.parametrize("status", [403, 400, 404, 500])
def test_probe_returns_the_status_instead_of_raising(http, status):
    http.post.return_value = _resp(status=status)
    assert dc.probe_result_route() == status
