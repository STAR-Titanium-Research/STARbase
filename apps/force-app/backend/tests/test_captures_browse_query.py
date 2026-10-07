"""/captures/browse query parameters: q, status, sort, offset/limit and the totals (R9)."""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from app import main, recovery
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    main._BROWSE_CACHE.clear()
    with TestClient(app) as c:
        yield c
    main._BROWSE_CACHE.clear()


def _make(root, cid, *, sample=None, raw_bytes=100_000, finalized=True, source="nidaq"):
    d = os.path.join(str(root), cid)
    os.makedirs(d)
    with open(os.path.join(d, "raw.d1raw"), "wb") as f:
        f.write(b"\0" * raw_bytes)
    if finalized:
        with open(os.path.join(d, "summary.json"), "w") as f:
            json.dump({"sample_name": sample, "n": 10, "config": {"source": source}}, f)
    elif sample:
        with open(os.path.join(d, "manifest.json"), "w") as f:
            json.dump({"config": {"sample_name": sample, "source": source}}, f)
    return d


@pytest.fixture
def populated(tmp_path):
    # id order == date order. Sizes: ccc biggest, aaa smallest.
    _make(tmp_path, "20260101-090000-aaa", sample="Ti-6Al-4V bar", raw_bytes=100_000)
    _make(tmp_path, "20260215-100000-bbb", sample="Inconel 718", raw_bytes=500_000)
    _make(tmp_path, "20260301-110000-ccc", sample="Ti-6Al-4V plate", raw_bytes=900_000)
    _make(
        tmp_path, "20260402-120000-ddd", sample="Inconel crash", raw_bytes=300_000, finalized=False
    )
    _make(tmp_path, "20260503-130000-eee", sample=None, raw_bytes=200_000, source="sim")
    return tmp_path


def _ids(body):
    return [c["id"] for c in body["captures"]]


def test_default_response_is_backward_compatible(client, populated):
    body = client.get("/captures/browse").json()
    assert _ids(body)[0] == "20260503-130000-eee"  # newest first, as before
    assert len(body["captures"]) == 5
    assert {"captures_root", "captures", "total_size_mb", "disk"} <= set(body)
    assert body["total"] == body["total_all"] == 5
    assert body["offset"] == 0 and body["limit"] == 200


def test_q_matches_sample_name_case_insensitively(client, populated):
    body = client.get("/captures/browse", params={"q": "TI-6AL"}).json()
    assert _ids(body) == ["20260301-110000-ccc", "20260101-090000-aaa"]
    assert body["total"] == 2 and body["total_all"] == 5


def test_q_matches_id_source_and_incomplete_manifest_sample(client, populated):
    assert _ids(client.get("/captures/browse", params={"q": "bbb"}).json()) == [
        "20260215-100000-bbb"
    ]
    assert _ids(client.get("/captures/browse", params={"q": "sim"}).json()) == [
        "20260503-130000-eee"
    ]
    # Incomplete capture: the sample name comes from manifest.json.
    assert _ids(client.get("/captures/browse", params={"q": "crash"}).json()) == [
        "20260402-120000-ddd"
    ]


def test_q_iso_date_matches_the_compact_id_prefix(client, populated):
    body = client.get("/captures/browse", params={"q": "2026-02-15"}).json()
    assert _ids(body) == ["20260215-100000-bbb"]


def test_q_with_no_match(client, populated):
    body = client.get("/captures/browse", params={"q": "zzz"}).json()
    assert body["captures"] == [] and body["total"] == 0 and body["total_all"] == 5
    assert body["matching_size_mb"] == 0


@pytest.mark.parametrize(
    "status,expected",
    [
        ("incomplete", ["20260402-120000-ddd"]),
        (
            "finalized",
            [
                "20260503-130000-eee",
                "20260301-110000-ccc",
                "20260215-100000-bbb",
                "20260101-090000-aaa",
            ],
        ),
    ],
)
def test_status_filter(client, populated, status, expected):
    body = client.get("/captures/browse", params={"status": status}).json()
    assert _ids(body) == expected
    assert body["total"] == len(expected)


def test_unknown_status_or_sort_is_rejected(client, populated):
    assert client.get("/captures/browse", params={"status": "uploaded"}).status_code == 422
    assert client.get("/captures/browse", params={"sort": "name"}).status_code == 422


def test_sort_date_ascending(client, populated):
    body = client.get("/captures/browse", params={"sort": "date_asc"}).json()
    assert _ids(body)[0] == "20260101-090000-aaa" and _ids(body)[-1] == "20260503-130000-eee"


def test_sort_by_size_both_directions(client, populated):
    desc = _ids(client.get("/captures/browse", params={"sort": "size_desc"}).json())
    assert desc[0] == "20260301-110000-ccc" and desc[-1] == "20260101-090000-aaa"
    asc = _ids(client.get("/captures/browse", params={"sort": "size_asc"}).json())
    assert asc == desc[::-1]


def test_paging_offset_and_limit_with_totals(client, populated):
    p1 = client.get("/captures/browse", params={"limit": 2}).json()
    p2 = client.get("/captures/browse", params={"limit": 2, "offset": 2}).json()
    p3 = client.get("/captures/browse", params={"limit": 2, "offset": 4}).json()
    assert [len(p["captures"]) for p in (p1, p2, p3)] == [2, 2, 1]
    assert all(p["total"] == 5 for p in (p1, p2, p3))
    assert _ids(p1) + _ids(p2) + _ids(p3) == _ids(client.get("/captures/browse").json())
    assert client.get("/captures/browse", params={"offset": 99}).json()["captures"] == []


def test_date_asc_paging_without_filters_reads_only_the_page(client, populated, monkeypatch):
    built: list[str] = []
    real = main._capture_entry
    monkeypatch.setattr(main, "_capture_entry", lambda cid: built.append(cid) or real(cid))
    body = client.get(
        "/captures/browse", params={"limit": 2, "offset": 1, "sort": "date_asc"}
    ).json()
    assert _ids(body) == ["20260215-100000-bbb", "20260301-110000-ccc"]
    assert len(built) == 2


def test_paging_without_filters_does_not_read_the_rest(client, populated, monkeypatch):
    built: list[str] = []
    real = main._capture_entry
    monkeypatch.setattr(main, "_capture_entry", lambda cid: built.append(cid) or real(cid))
    body = client.get("/captures/browse", params={"limit": 2, "offset": 1}).json()
    assert len(built) == 2
    assert body["total"] == 5 and body["matching_size_mb"] is None
    assert body["total_size_mb"] > 0  # sum over the returned page, as before


def test_filtered_request_builds_each_capture_once(client, populated, monkeypatch):
    built: list[str] = []
    real = main._capture_entry
    monkeypatch.setattr(main, "_capture_entry", lambda cid: built.append(cid) or real(cid))
    client.get("/captures/browse", params={"q": "ti", "sort": "size_desc", "limit": 1})
    assert len(built) == 5 and len(set(built)) == 5


def test_filters_combine_with_sort_and_paging(client, populated):
    body = client.get(
        "/captures/browse",
        params={"q": "inconel", "status": "finalized", "sort": "size_desc"},
    ).json()
    assert _ids(body) == ["20260215-100000-bbb"]
    body = client.get(
        "/captures/browse", params={"q": "ti-6al", "sort": "size_asc", "limit": 1, "offset": 1}
    ).json()
    assert _ids(body) == ["20260301-110000-ccc"]
    assert body["total"] == 2
    assert body["matching_size_mb"] == pytest.approx(1.0, abs=0.01)


def test_limit_is_clamped_to_500(client, populated):
    assert client.get("/captures/browse", params={"limit": 100000}).json()["limit"] == 500
    assert client.get("/captures/browse", params={"limit": 0}).json()["limit"] == 1


def test_cache_follows_metadata_edits_and_deletes(client, populated):
    cid = "20260101-090000-aaa"
    assert _ids(client.get("/captures/browse", params={"q": "renamed"}).json()) == []
    res = client.patch(f"/captures/{cid}/metadata", json={"sample_name": "renamed"})
    assert res.status_code == 200
    assert _ids(client.get("/captures/browse", params={"q": "renamed"}).json()) == [cid]
    assert client.delete(f"/captures/{cid}").status_code == 200
    body = client.get("/captures/browse", params={"q": "renamed"}).json()
    assert body["captures"] == [] and body["total_all"] == 4


def test_incomplete_rows_are_not_cached_so_live_flags_stay_live(client, populated, monkeypatch):
    client.get("/captures/browse", params={"status": "incomplete"})
    monkeypatch.setattr(recovery, "_recovering", {"20260402-120000-ddd"})
    row = client.get("/captures/browse", params={"status": "incomplete"}).json()["captures"][0]
    assert row["recovering"] is True


def test_missing_root_returns_empty_page(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path / "nope"))
    body = client.get("/captures/browse", params={"q": "x"}).json()
    assert body["captures"] == [] and body["total"] == 0 and body["total_all"] == 0
