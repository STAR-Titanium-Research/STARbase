"""Tests for the local capture browse/delete endpoints behind Settings > Local Captures."""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    with TestClient(app) as c:
        yield c


# Sizes are reported in MB rounded to 2dp, so fixtures use realistic (MB-scale) raw files —
# a 1KB stand-in rounds to 0.0 and would make the size assertions meaningless.
def _make_capture(root, cid: str, *, finalized: bool = True, raw_bytes: int = 250_000) -> str:
    d = os.path.join(str(root), cid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "raw.d1raw"), "wb") as f:
        f.write(b"\0" * raw_bytes)
    if finalized:
        with open(os.path.join(d, "capture.mat"), "wb") as f:
            f.write(b"\0" * 64)
        with open(os.path.join(d, "live_cache.bin"), "wb") as f:
            f.write(b"\0" * 32)
        with open(os.path.join(d, "summary.json"), "w") as f:
            json.dump(
                {
                    "sample_name": f"SAMPLE-{cid}",
                    "duration_sec": 4.5,
                    "n": 9000,
                    "peaks": {"Fx": 1.0, "Fy": 2.0, "Fz": 3.0},
                    "config": {"source": "nidaq"},
                },
                f,
            )
    return d


def test_browse_lists_finalized_and_incomplete(client, tmp_path):
    _make_capture(tmp_path, "20260822-100000-aaa", finalized=True)
    _make_capture(tmp_path, "20260822-090000-bbb", finalized=False)

    body = client.get("/captures/browse").json()
    ids = [c["id"] for c in body["captures"]]
    assert ids == ["20260822-100000-aaa", "20260822-090000-bbb"]  # newest first

    done, partial = body["captures"]
    assert done["finalized"] is True
    assert done["sample_name"] == "SAMPLE-20260822-100000-aaa"
    assert done["source"] == "nidaq"
    assert done["peaks"]["Fz"] == 3.0
    # An un-finalized capture is exactly what accumulates from "Don't save", so it must be listed,
    # just without the summary-derived fields.
    assert partial["finalized"] is False
    assert "sample_name" not in partial
    assert partial["files"]["raw.d1raw"] > 0


def test_browse_reports_sizes_and_totals(client, tmp_path):
    _make_capture(tmp_path, "a", raw_bytes=2_000_000)
    _make_capture(tmp_path, "b", raw_bytes=1_000_000)

    body = client.get("/captures/browse").json()
    assert body["total_size_mb"] == pytest.approx(3.0, abs=0.01)
    assert body["captures_root"] == str(tmp_path)
    assert "free_gb" in body["disk"]


def test_browse_empty_root(client):
    body = client.get("/captures/browse").json()
    assert body["captures"] == [] and body["total_size_mb"] == 0


def test_delete_removes_a_finalized_capture(client, tmp_path):
    """The gap this closes: recovery.discard_session refuses finalized sessions by design, so
    before this endpoint a completed capture could never be removed from inside the app."""
    d = _make_capture(tmp_path, "20260822-100000-aaa", finalized=True, raw_bytes=500_000)
    assert os.path.isdir(d)

    body = client.delete("/captures/20260822-100000-aaa").json()
    assert body["deleted"] is True
    assert body["freed_mb"] == pytest.approx(0.5, abs=0.01)
    assert not os.path.exists(d)


def test_delete_missing_is_404(client):
    assert client.delete("/captures/nope").status_code == 404


@pytest.mark.parametrize("bad", ["../escape", "a/b", "a\\b"])
def test_delete_rejects_path_traversal(client, bad):
    assert client.delete(f"/captures/{bad}").status_code in (400, 404)


def test_delete_refuses_the_in_progress_recording(client, tmp_path, monkeypatch):
    _make_capture(tmp_path, "live-one", finalized=False)

    class _FakeSession:
        id = "live-one"
        state = "recording"

    monkeypatch.setattr(main, "_session", _FakeSession())
    res = client.delete("/captures/live-one")
    assert res.status_code == 409
    assert os.path.isdir(os.path.join(str(tmp_path), "live-one"))


def test_delete_allows_a_finished_session_that_is_still_referenced(client, tmp_path, monkeypatch):
    """Only an ACTIVE recording is protected — the last finished one must still be deletable."""
    _make_capture(tmp_path, "done-one", finalized=True)

    class _FakeSession:
        id = "done-one"
        state = "done"

    monkeypatch.setattr(main, "_session", _FakeSession())
    assert client.delete("/captures/done-one").status_code == 200


# ---- PATCH /captures/{id}/metadata ----
#
# The motivating case: a forgotten Sample locks Upload out at cut end with no way back in (the
# capture stays on disk, listed, but nothing lets you assign one after the fact). These also cover
# the real bug found while building this — RecordConfig.sample_name has its own default ("SIM-CUT")
# completely separate from extra_metadata.sample_name, and the frontend never sent it, so every
# real recording archived under the generic default regardless of what was actually picked.


def test_patch_metadata_corrects_sample_name_and_config_together(client, tmp_path):
    _make_capture(tmp_path, "20260822-100000-aaa", finalized=True)

    res = client.patch(
        "/captures/20260822-100000-aaa/metadata", json={"sample_name": "REAL-SAMPLE-42"}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["sample_name"] == "REAL-SAMPLE-42"
    assert (
        body["config"]["sample_name"] == "REAL-SAMPLE-42"
    )  # kept in step, not just the top-level echo

    with open(os.path.join(str(tmp_path), "20260822-100000-aaa", "summary.json")) as f:
        on_disk = json.load(f)
    assert on_disk["sample_name"] == "REAL-SAMPLE-42"


def test_patch_metadata_recording_parameters(client, tmp_path):
    _make_capture(tmp_path, "20260822-100000-aaa", finalized=True)

    res = client.patch(
        "/captures/20260822-100000-aaa/metadata",
        json={"rpm": 1500, "feed": 0.08, "diam": 90, "sample_rate": 20000},
    )
    cfg = res.json()["config"]
    assert (
        cfg["rpm"] == 1500
        and cfg["feed"] == 0.08
        and cfg["diam"] == 90
        and cfg["sample_rate"] == 20000
    )
    assert (
        cfg["source"] == "nidaq"
    ), "unrelated existing config fields must survive the patch untouched"


def test_patch_metadata_replaces_extra_metadata_wholesale(client, tmp_path):
    """Matches /record/start's own semantics (extra_metadata: metaObj()) — the frontend always
    sends the full current+edited object, not a sparse diff, so this is a replace, not a per-key
    merge. A caller sending a smaller object should see keys actually disappear."""
    _make_capture(tmp_path, "20260822-100000-aaa", finalized=True)
    client.patch(
        "/captures/20260822-100000-aaa/metadata",
        json={"extra_metadata": {"sample_name": "A", "notes": "first pass"}},
    )
    res = client.patch(
        "/captures/20260822-100000-aaa/metadata",
        json={"extra_metadata": {"sample_name": "A"}},
    )
    body = res.json()
    assert body["metadata"] == {"sample_name": "A"}
    assert body["config"]["extra_metadata"] == {"sample_name": "A"}
    assert "notes" not in body["metadata"]


def test_patch_metadata_only_touches_provided_fields(client, tmp_path):
    _make_capture(tmp_path, "20260822-100000-aaa", finalized=True)
    res = client.patch("/captures/20260822-100000-aaa/metadata", json={"rpm": 1000})
    body = res.json()
    assert body["sample_name"] == "SAMPLE-20260822-100000-aaa"  # untouched
    assert body["config"]["source"] == "nidaq"  # untouched


def test_patch_metadata_404_for_unfinalized_or_missing(client, tmp_path):
    _make_capture(tmp_path, "20260822-090000-partial", finalized=False)
    assert (
        client.patch("/captures/20260822-090000-partial/metadata", json={"rpm": 1000}).status_code
        == 404
    )
    assert client.patch("/captures/does-not-exist/metadata", json={"rpm": 1000}).status_code == 404


def test_patch_metadata_rejects_path_traversal(client):
    res = client.patch("/captures/../../etc/metadata", json={"rpm": 1000})
    assert res.status_code in (
        400,
        404,
    )  # never a 500, and never touches anything outside CAPTURES_ROOT
