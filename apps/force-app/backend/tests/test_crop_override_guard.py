"""#190: the crop the operator sets in the final summary is kept locally (PUT /captures/{id}/crop),
so a failed upload or a restart no longer loses it."""

from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main, recovery
from app.main import app

CID = "20261008-100000-abc"
N = 37_000_000


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    with TestClient(app) as c:
        yield c


def _capture(root, cid=CID, n=N):
    d = os.path.join(str(root), cid)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "summary.json")
    with open(path, "w") as f:
        json.dump({"n": n, "fs": 51200.0, "mat_written": False, "config": {"source": "nidaq"}}, f)
    return path


def _summary(path):
    with open(path) as f:
        return json.load(f)


def test_crop_is_stored_in_summary_and_served_by_the_summary_get(client, tmp_path):
    path = _capture(tmp_path)
    r = client.put(
        f"/captures/{CID}/crop",
        json={"crop_start_idx_override": 1000, "crop_end_idx_override": 36_000_000},
    )
    assert r.status_code == 200
    assert r.json() == {"crop_start_idx_override": 1000, "crop_end_idx_override": 36_000_000}
    assert _summary(path)["crop_start_idx_override"] == 1000
    got = client.get(f"/captures/{CID}/summary").json()
    assert got["crop_start_idx_override"] == 1000
    assert got["crop_end_idx_override"] == 36_000_000
    assert got["mat_written"] is False  # the rest of the summary is untouched


def test_both_null_clears_the_stored_crop(client, tmp_path):
    path = _capture(tmp_path)
    client.put(
        f"/captures/{CID}/crop", json={"crop_start_idx_override": 5, "crop_end_idx_override": 50}
    )
    r = client.put(
        f"/captures/{CID}/crop",
        json={"crop_start_idx_override": None, "crop_end_idx_override": None},
    )
    assert r.status_code == 200
    s = _summary(path)
    assert "crop_start_idx_override" not in s and "crop_end_idx_override" not in s
    client.put(
        f"/captures/{CID}/crop", json={"crop_start_idx_override": 5, "crop_end_idx_override": 50}
    )
    assert client.put(f"/captures/{CID}/crop", json={}).status_code == 200  # both omitted: same
    assert "crop_start_idx_override" not in _summary(path)


@pytest.mark.parametrize("body", [{"crop_start_idx_override": 7}, {"crop_end_idx_override": 50}])
def test_one_side_alone_is_refused_and_keeps_the_stored_crop(client, tmp_path, body):
    path = _capture(tmp_path)
    client.put(
        f"/captures/{CID}/crop", json={"crop_start_idx_override": 5, "crop_end_idx_override": 40}
    )
    assert client.put(f"/captures/{CID}/crop", json=body).status_code == 422
    s = _summary(path)
    assert (s["crop_start_idx_override"], s["crop_end_idx_override"]) == (5, 40)


@pytest.mark.parametrize(
    "body",
    [
        {"crop_start_idx_override": -1, "crop_end_idx_override": 10},
        {"crop_start_idx_override": 10, "crop_end_idx_override": 10},
        {"crop_start_idx_override": 11, "crop_end_idx_override": 10},
        {"crop_start_idx_override": 0, "crop_end_idx_override": N + 1},
        {"crop_start_idx_override": N, "crop_end_idx_override": None},
        {"crop_start_idx_override": None, "crop_end_idx_override": 0},
        {"crop_start_idx_override": "x", "crop_end_idx_override": 10},
    ],
)
def test_out_of_range_crop_is_refused_and_nothing_is_written(client, tmp_path, body):
    path = _capture(tmp_path)
    before = _summary(path)
    assert client.put(f"/captures/{CID}/crop", json=body).status_code in (422,)
    assert _summary(path) == before


def test_the_whole_recording_is_a_valid_crop(client, tmp_path):
    _capture(tmp_path)
    r = client.put(
        f"/captures/{CID}/crop", json={"crop_start_idx_override": 0, "crop_end_idx_override": N}
    )
    assert r.status_code == 200


def test_unknown_id_is_404_and_a_bad_id_is_400(client):
    body = {"crop_start_idx_override": 1, "crop_end_idx_override": 9}
    assert client.put("/captures/nope-123/crop", json=body).status_code == 404
    assert client.put("/captures/..%2Fx/crop", json=body).status_code in (400, 404)


def test_a_capture_folder_without_a_summary_is_404(client, tmp_path):
    os.makedirs(os.path.join(str(tmp_path), CID))
    body = {"crop_start_idx_override": 1, "crop_end_idx_override": 9}
    assert client.put(f"/captures/{CID}/crop", json=body).status_code == 404


def test_refused_while_that_capture_is_recording(client, tmp_path, monkeypatch):
    path = _capture(tmp_path)
    monkeypatch.setattr(main, "_session", SimpleNamespace(id=CID, state="recording"))
    r = client.put(
        f"/captures/{CID}/crop", json={"crop_start_idx_override": 1, "crop_end_idx_override": 9}
    )
    assert r.status_code == 409
    assert "crop_start_idx_override" not in _summary(path)


def test_refused_while_that_capture_is_finalizing(client, tmp_path, monkeypatch):
    _capture(tmp_path)
    monkeypatch.setattr(main, "_session", SimpleNamespace(id=CID, state="finalizing"))
    body = {"crop_start_idx_override": 1, "crop_end_idx_override": 9}
    assert client.put(f"/captures/{CID}/crop", json=body).status_code == 409


def test_another_capture_is_still_editable_while_one_records(client, tmp_path, monkeypatch):
    _capture(tmp_path, "20261008-090000-old")
    monkeypatch.setattr(main, "_session", SimpleNamespace(id=CID, state="recording"))
    body = {"crop_start_idx_override": 1, "crop_end_idx_override": 9}
    assert client.put("/captures/20261008-090000-old/crop", json=body).status_code == 200


def test_refused_while_a_recover_owns_the_capture(client, tmp_path):
    _capture(tmp_path)
    body = {"crop_start_idx_override": 1, "crop_end_idx_override": 9}
    with recovery.recovering(CID):
        assert client.put(f"/captures/{CID}/crop", json=body).status_code == 409
