"""Tests for the backup server: ingest flow, session listing, purge, health."""

import json
import os
import struct
import time

import pytest


def _make_header() -> bytes:
    """Create a minimal D1RW header."""
    head = struct.pack("<4sIIfd", b"D1RW", 1, 10, 2000.0, 1700000000.0)
    return head + b"\x00" * (32 - len(head))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BACKUP_STORAGE", str(tmp_path))
    monkeypatch.setenv("BACKUP_RETENTION_HOURS", "12")
    # Re-import after env is set
    import server as srv

    monkeypatch.setattr(srv, "STORAGE", str(tmp_path))
    monkeypatch.setattr(srv, "RETENTION_HOURS", 12.0)

    from fastapi.testclient import TestClient

    with TestClient(srv.app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "disk_free_gb" in data


def test_ingest_start_chunk_finish(client, tmp_path):
    header = _make_header()

    # Start
    r = client.post(
        "/ingest/start",
        json={
            "session_id": "test-001",
            "header_hex": header.hex(),
            "config": {"sample_name": "TEST"},
        },
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    # Send chunks
    chunk1 = os.urandom(400)  # 10 float32 rows
    r = client.post(
        "/ingest/chunk",
        content=chunk1,
        headers={
            "X-Session-ID": "test-001",
            "Content-Type": "application/octet-stream",
        },
    )
    assert r.status_code == 200
    assert r.json()["appended"] == 400

    chunk2 = os.urandom(200)
    r = client.post(
        "/ingest/chunk",
        content=chunk2,
        headers={
            "X-Session-ID": "test-001",
            "Content-Type": "application/octet-stream",
        },
    )
    assert r.status_code == 200

    # Finish
    r = client.post("/ingest/finish", json={"session_id": "test-001"})
    assert r.status_code == 200

    # Verify raw file
    raw_path = os.path.join(str(tmp_path), "test-001", "raw.d1rw")
    assert os.path.isfile(raw_path)
    data = open(raw_path, "rb").read()
    assert data[:4] == b"D1RW"
    assert len(data) == 32 + 400 + 200  # header + chunks


def _start(client, sid="dedup-001"):
    r = client.post(
        "/ingest/start", json={"session_id": sid, "header_hex": _make_header().hex()}
    )
    assert r.status_code == 200
    return sid


def _chunk(client, sid, content, offset=None):
    headers = {"X-Session-ID": sid, "Content-Type": "application/octet-stream"}
    if offset is not None:
        headers["X-Offset"] = str(offset)
    return client.post("/ingest/chunk", content=content, headers=headers)


def _raw_size(tmp_path, sid):
    return os.path.getsize(os.path.join(str(tmp_path), sid, "raw.d1rw"))


def test_ingest_chunk_replay_at_same_offset_is_not_duplicated(client, tmp_path):
    """A retry after a lost response must not append the bytes twice.

    .d1raw is fixed-width interleaved rows, so one duplicated chunk misaligns every row after it
    and silently corrupts the whole backup — the failure mode this offset check exists to prevent.
    """
    sid = _start(client)
    chunk = os.urandom(400)

    assert _chunk(client, sid, chunk, offset=32).json()["appended"] == 400
    size_after_first = _raw_size(tmp_path, sid)

    # Client never saw the response, so it re-sends the identical chunk from the same offset.
    r = _chunk(client, sid, chunk, offset=32)
    assert r.status_code == 200
    assert r.json()["appended"] == 0
    assert r.json()["duplicate"] is True
    assert _raw_size(tmp_path, sid) == size_after_first


def test_ingest_chunk_overlapping_retry_appends_only_new_tail(client, tmp_path):
    """The normal retry shape: the re-read starts at the old offset but runs to a now-longer EOF."""
    sid = _start(client)
    first = os.urandom(400)
    assert _chunk(client, sid, first, offset=32).json()["appended"] == 400

    # Response was lost; by the next interval the file has grown, so the client re-sends from 32
    # with the original 400 bytes plus 200 genuinely new ones.
    tail = os.urandom(200)
    r = _chunk(client, sid, first + tail, offset=32)
    assert r.status_code == 200
    assert r.json()["appended"] == 200  # only the new tail

    data = open(os.path.join(str(tmp_path), sid, "raw.d1rw"), "rb").read()
    assert data == _make_header() + first + tail


def test_ingest_chunk_gap_is_refused(client, tmp_path):
    """A chunk starting past EOF would leave a hole and misalign everything after it."""
    sid = _start(client)
    assert _chunk(client, sid, os.urandom(400), offset=32).json()["appended"] == 400
    size_before = _raw_size(tmp_path, sid)

    r = _chunk(client, sid, os.urandom(100), offset=9999)
    assert r.status_code == 409
    assert _raw_size(tmp_path, sid) == size_before  # nothing written


def test_ingest_chunk_without_offset_still_appends(client, tmp_path):
    """Older clients send no X-Offset — they must keep working (legacy blind append)."""
    sid = _start(client)
    r = _chunk(client, sid, os.urandom(400))
    assert r.status_code == 200
    assert r.json()["appended"] == 400
    assert _raw_size(tmp_path, sid) == 32 + 400


def test_ingest_chunk_rejects_malformed_offset(client):
    sid = _start(client)
    assert _chunk(client, sid, os.urandom(10), offset="not-a-number").status_code == 400
    assert _chunk(client, sid, os.urandom(10), offset=-1).status_code == 400


def test_ingest_chunk_without_start_returns_404(client):
    r = client.post(
        "/ingest/chunk",
        content=b"\x00" * 100,
        headers={
            "X-Session-ID": "nonexistent",
            "Content-Type": "application/octet-stream",
        },
    )
    assert r.status_code == 404


def test_ingest_chunk_without_session_header_returns_400(client):
    r = client.post(
        "/ingest/chunk",
        content=b"\x00" * 100,
        headers={
            "Content-Type": "application/octet-stream",
        },
    )
    assert r.status_code == 400


def test_sessions_list(client, tmp_path):
    header = _make_header()
    # Create two sessions
    for sid in ("sess-a", "sess-b"):
        client.post(
            "/ingest/start", json={"session_id": sid, "header_hex": header.hex()}
        )
        client.post(
            "/ingest/chunk",
            content=os.urandom(400),
            headers={"X-Session-ID": sid, "Content-Type": "application/octet-stream"},
        )

    r = client.get("/sessions")
    assert r.status_code == 200
    sessions = r.json()["sessions"]
    assert len(sessions) == 2
    ids = {s["id"] for s in sessions}
    assert "sess-a" in ids and "sess-b" in ids


def test_session_info(client, tmp_path):
    header = _make_header()
    client.post(
        "/ingest/start", json={"session_id": "info-test", "header_hex": header.hex()}
    )
    # Write 10 rows of 10 float32 columns = 400 bytes
    client.post(
        "/ingest/chunk",
        content=os.urandom(400),
        headers={
            "X-Session-ID": "info-test",
            "Content-Type": "application/octet-stream",
        },
    )
    client.post("/ingest/finish", json={"session_id": "info-test"})

    r = client.get("/sessions/info-test/info")
    assert r.status_code == 200
    info = r.json()
    assert info["id"] == "info-test"
    assert info["n_rows"] == 10
    assert info["rate"] == 2000.0
    assert info["state"] == "complete"


def test_session_raw_download(client, tmp_path):
    header = _make_header()
    client.post(
        "/ingest/start", json={"session_id": "dl-test", "header_hex": header.hex()}
    )
    chunk = os.urandom(800)
    client.post(
        "/ingest/chunk",
        content=chunk,
        headers={"X-Session-ID": "dl-test", "Content-Type": "application/octet-stream"},
    )

    r = client.get("/sessions/dl-test/raw")
    assert r.status_code == 200
    assert r.content[:4] == b"D1RW"
    assert len(r.content) == 32 + 800


def test_session_delete(client, tmp_path):
    header = _make_header()
    client.post(
        "/ingest/start", json={"session_id": "del-test", "header_hex": header.hex()}
    )

    r = client.delete("/sessions/del-test")
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    r = client.get("/sessions/del-test/info")
    assert r.status_code == 404


def test_session_not_found(client):
    assert client.get("/sessions/ghost/info").status_code == 404
    assert client.get("/sessions/ghost/raw").status_code == 404
    assert client.delete("/sessions/ghost").status_code == 404


def test_purge_expired(client, tmp_path, monkeypatch):
    import server as srv

    monkeypatch.setattr(srv, "RETENTION_HOURS", 0.0001)  # ~0.36 seconds

    header = _make_header()
    client.post(
        "/ingest/start", json={"session_id": "old-sess", "header_hex": header.hex()}
    )

    # Backdate the meta
    meta_path = os.path.join(str(tmp_path), "old-sess", "meta.json")
    with open(meta_path) as f:
        meta = json.load(f)
    meta["updated_at"] = time.time() - 3600  # 1 hour ago
    with open(meta_path, "w") as f:
        json.dump(meta, f)

    srv._purge_expired()

    assert not os.path.exists(os.path.join(str(tmp_path), "old-sess"))


def test_session_info_reports_expiry(client, tmp_path):
    import server as srv

    client.post(
        "/ingest/start", json={"session_id": "exp", "header_hex": _make_header().hex()}
    )
    info = client.get("/sessions/exp/info").json()
    assert info["expires_at"] == pytest.approx(
        info["updated_at"] + srv.RETENTION_HOURS * 3600
    )


def test_mark_deleted_tombstones_and_restarts_the_retention_clock(client, tmp_path):
    import server as srv

    client.post(
        "/ingest/start", json={"session_id": "gone", "header_hex": _make_header().hex()}
    )
    client.post("/ingest/finish", json={"session_id": "gone"})
    # Backdate, so the reset of updated_at is observable.
    meta_path = os.path.join(str(tmp_path), "gone", "meta.json")
    with open(meta_path) as f:
        meta = json.load(f)
    meta["updated_at"] = time.time() - 3600
    with open(meta_path, "w") as f:
        json.dump(meta, f)

    before = time.time()
    r = client.post("/sessions/gone/mark-deleted")
    assert r.status_code == 200
    assert r.json()["expires_at"] >= before + srv.RETENTION_HOURS * 3600 - 1

    info = client.get("/sessions/gone/info").json()
    assert info["state"] == "deleted"
    assert info["deleted_at"] >= before
    assert info["meta"]["state_before_delete"] == "complete"
    # The bytes are still there: a tombstone is a label, not a delete.
    assert client.get("/sessions/gone/raw").status_code == 200

    # A late /ingest/finish (the streamer flushing after the local delete) keeps the tombstone.
    client.post("/ingest/finish", json={"session_id": "gone"})
    assert client.get("/sessions/gone/info").json()["state"] == "deleted"

    # Marking twice is harmless and keeps the original pre-delete state.
    client.post("/sessions/gone/mark-deleted")
    assert (
        client.get("/sessions/gone/info").json()["meta"]["state_before_delete"]
        == "complete"
    )


def test_mark_deleted_twice_does_not_restart_the_clock(client, tmp_path):
    client.post(
        "/ingest/start",
        json={"session_id": "twice", "header_hex": _make_header().hex()},
    )
    client.post("/sessions/twice/mark-deleted")
    meta_path = os.path.join(str(tmp_path), "twice", "meta.json")
    with open(meta_path) as f:
        meta = json.load(f)
    meta["updated_at"] -= 3600
    meta["deleted_at"] -= 3600
    with open(meta_path, "w") as f:
        json.dump(meta, f)
    r = client.post("/sessions/twice/mark-deleted")
    assert r.status_code == 200
    with open(meta_path) as f:
        after = json.load(f)
    assert after["updated_at"] == meta["updated_at"]
    assert after["deleted_at"] == meta["deleted_at"]
    assert r.json()["expires_at"] == pytest.approx(meta["updated_at"] + 12 * 3600)


@pytest.mark.parametrize("bad", ["", ".", "..", "a/b", "a\\b"])
def test_session_dir_rejects_names_that_point_at_storage(client, bad):
    import server as srv
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        srv._session_dir(bad)
    assert e.value.status_code == 400


def test_delete_dot_does_not_remove_the_storage_root(client, tmp_path):
    client.post(
        "/ingest/start", json={"session_id": "keep", "header_hex": _make_header().hex()}
    )
    # %2E: a literal "." segment would be normalised away by the HTTP client before it got here.
    client.delete("/sessions/%2E")
    assert os.path.isdir(os.path.join(str(tmp_path), "keep"))


def test_mark_deleted_is_purged_after_retention(client, tmp_path, monkeypatch):
    import server as srv

    client.post(
        "/ingest/start", json={"session_id": "tomb", "header_hex": _make_header().hex()}
    )
    client.post("/sessions/tomb/mark-deleted")
    srv._purge_expired()
    assert os.path.isdir(
        os.path.join(str(tmp_path), "tomb")
    )  # not yet: retention is 12 h

    monkeypatch.setattr(srv, "RETENTION_HOURS", 0.0)
    time.sleep(0.01)
    srv._purge_expired()
    assert not os.path.exists(os.path.join(str(tmp_path), "tomb"))


def test_mark_deleted_unknown_session_is_404(client):
    assert client.post("/sessions/ghost/mark-deleted").status_code == 404


def _begin(client, sid, config=None):
    client.post(
        "/ingest/start",
        json={
            "session_id": sid,
            "header_hex": _make_header().hex(),
            "config": config or {"dyno_gains": [1, 2, 3, 4, 5, 6, 7, 8]},
        },
    )
    return sid


@pytest.mark.parametrize("content", [b"{not json", b"", b"[1, 2]", b"\xff\xfe"])
def test_mark_deleted_does_not_overwrite_an_unreadable_meta(client, tmp_path, content):
    _begin(client, "broken")
    meta_path = os.path.join(str(tmp_path), "broken", "meta.json")
    with open(meta_path, "wb") as f:
        f.write(content)
    r = client.post("/sessions/broken/mark-deleted")
    assert r.status_code == 409
    with open(meta_path, "rb") as f:
        assert f.read() == content  # untouched: nothing was lost
    assert not os.path.exists(meta_path + ".tmp")


def test_mark_deleted_keeps_the_stored_config(client, tmp_path):
    _begin(client, "cfg", {"dyno_gains": [9] * 8, "sample_name": "KEEP"})
    assert client.post("/sessions/cfg/mark-deleted").status_code == 200
    meta = client.get("/sessions/cfg/info").json()["meta"]
    assert meta["config"] == {"dyno_gains": [9] * 8, "sample_name": "KEEP"}


def test_mark_deleted_without_a_meta_file_still_tombstones(client, tmp_path):
    _begin(client, "nometa")
    os.remove(os.path.join(str(tmp_path), "nometa", "meta.json"))
    assert client.post("/sessions/nometa/mark-deleted").status_code == 200
    with open(os.path.join(str(tmp_path), "nometa", "meta.json")) as f:
        assert json.load(f)["state"] == "deleted"


def test_mark_deleted_writes_meta_atomically(client, tmp_path, monkeypatch):
    """A write that dies part-way must leave the old meta.json whole, and no temp file behind."""
    _begin(client, "atomic")
    meta_path = os.path.join(str(tmp_path), "atomic", "meta.json")
    with open(meta_path, "rb") as f:
        before = f.read()

    def dies_halfway(obj, f, *a, **k):
        f.write('{"session_id": "atom')
        raise OSError("disk full")

    import server as srv

    monkeypatch.setattr(srv.json, "dump", dies_halfway)
    with pytest.raises(OSError):
        client.post("/sessions/atomic/mark-deleted")
    with open(meta_path, "rb") as f:
        assert f.read() == before
    assert not os.path.exists(meta_path + ".tmp")


def _meta(tmp_path, sid):
    with open(os.path.join(str(tmp_path), sid, "meta.json")) as f:
        return json.load(f)


def test_unmark_deleted_restores_the_state_and_drops_the_markers(client, tmp_path):
    _begin(client, "back")
    client.post("/ingest/finish", json={"session_id": "back"})
    client.post("/sessions/back/mark-deleted")
    tomb = _meta(tmp_path, "back")
    assert tomb["state"] == "deleted"

    r = client.post("/sessions/back/unmark-deleted")
    assert r.status_code == 200 and r.json()["unmarked"] is True
    meta = _meta(tmp_path, "back")
    assert meta["state"] == "complete"  # what the stream had reached
    assert "deleted_at" not in meta and "state_before_delete" not in meta
    # The stored config is intact, and the retention clock was not touched or reset.
    assert meta["config"] == tomb["config"]
    assert meta["updated_at"] == tomb["updated_at"]
    info = client.get("/sessions/back/info").json()
    assert info["state"] == "complete" and "deleted_at" not in info
    assert info["expires_at"] == pytest.approx(tomb["updated_at"] + 12 * 3600)
    assert client.get("/sessions/back/raw").status_code == 200

    # A late /ingest/finish now behaves as for any live session.
    client.post("/ingest/finish", json={"session_id": "back"})
    assert client.get("/sessions/back/info").json()["state"] == "complete"


def test_unmark_deleted_restores_an_interrupted_copy_as_streaming(client, tmp_path):
    _begin(client, "cut")  # never finished: state "streaming"
    client.post("/sessions/cut/mark-deleted")
    client.post("/sessions/cut/unmark-deleted")
    assert _meta(tmp_path, "cut")["state"] == "streaming"


def test_unmark_deleted_is_idempotent_and_leaves_live_sessions_alone(client, tmp_path):
    _begin(client, "live")
    before = _meta(tmp_path, "live")
    r = client.post("/sessions/live/unmark-deleted")  # never tombstoned
    assert r.status_code == 200 and r.json()["unmarked"] is False
    assert _meta(tmp_path, "live") == before

    client.post("/sessions/live/mark-deleted")
    assert client.post("/sessions/live/unmark-deleted").json()["unmarked"] is True
    once = _meta(tmp_path, "live")
    assert client.post("/sessions/live/unmark-deleted").json()["unmarked"] is False
    assert _meta(tmp_path, "live") == once


def test_unmark_then_mark_again_tombstones_afresh(client, tmp_path):
    _begin(client, "again")
    client.post("/ingest/finish", json={"session_id": "again"})
    client.post("/sessions/again/mark-deleted")
    client.post("/sessions/again/unmark-deleted")
    client.post("/sessions/again/mark-deleted")
    meta = _meta(tmp_path, "again")
    assert meta["state"] == "deleted" and meta["state_before_delete"] == "complete"


def test_unmark_deleted_validates_the_id_and_the_session(client, tmp_path):
    assert client.post("/sessions/ghost/unmark-deleted").status_code == 404
    assert client.post("/sessions/a%5Cb/unmark-deleted").status_code == 400
    assert client.post("/sessions/%2E/unmark-deleted").status_code == 400


def test_unmark_deleted_does_not_overwrite_an_unreadable_meta(client, tmp_path):
    _begin(client, "bad")
    meta_path = os.path.join(str(tmp_path), "bad", "meta.json")
    with open(meta_path, "wb") as f:
        f.write(b"{oops")
    assert client.post("/sessions/bad/unmark-deleted").status_code == 409
    with open(meta_path, "rb") as f:
        assert f.read() == b"{oops"


@pytest.mark.parametrize(
    "sid",
    ["C%3A", "C%3Afoo", "..", "a%2Fb", "a%5Cb", "%2e%2e", "%2E", "x%3Ay", "..%5Cx"],
)
def test_session_id_must_be_a_bare_basename(client, tmp_path, sid):
    """Drive letters, parent refs, separators and encoded variants all name something other than a
    direct child of STORAGE (on Windows `C:` escapes it) — refused before any filesystem call."""
    assert client.delete(f"/sessions/{sid}").status_code in (400, 404)
    assert client.post(f"/sessions/{sid}/mark-deleted").status_code in (400, 404)
    assert client.get(f"/sessions/{sid}/info").status_code in (400, 404)
    assert os.path.isdir(str(tmp_path))  # the storage root itself survived


@pytest.mark.parametrize(
    "sid", ["C:", "C:foo", "..", ".", "", "a/b", "a\\b", "x:y", "a\x00b"]
)
def test_session_dir_rejects_unsafe_ids(sid, tmp_path, monkeypatch):
    import server as srv
    from fastapi import HTTPException

    monkeypatch.setattr(srv, "STORAGE", str(tmp_path))
    with pytest.raises(HTTPException) as e:
        srv._session_dir(sid)
    assert e.value.status_code == 400


def test_session_dir_accepts_normal_ids(tmp_path, monkeypatch):
    import server as srv

    monkeypatch.setattr(srv, "STORAGE", str(tmp_path))
    for sid in ("20260101-000000-abc123", "test-001", "a.b", "a b"):
        assert srv._session_dir(sid) == os.path.join(str(tmp_path), sid)


def _start_body(sid, config=None):
    return {
        "session_id": sid,
        "header_hex": _make_header().hex(),
        "config": config or {},
    }


def test_duplicate_ingest_start_keeps_the_streamed_bytes(client, tmp_path):
    """Review 1.9: a retried /ingest/start used to reopen raw.d1rw with "wb", truncating a
    recording that was already streaming back to its 32-byte header."""
    sid = "dup-1"
    client.post("/ingest/start", json=_start_body(sid, {"gain": 1}))
    body = os.urandom(400)
    assert _chunk(client, sid, body, offset=32).json()["appended"] == 400
    before = _meta(tmp_path, sid)

    r = client.post("/ingest/start", json=_start_body(sid, {"gain": 2}))

    assert r.status_code == 200
    assert r.json()["existing"] is True
    assert r.json()["size"] == 32 + 400  # where the client should resume
    raw = (tmp_path / sid / "raw.d1rw").read_bytes()
    assert raw == _make_header() + body
    after = _meta(tmp_path, sid)
    assert after["started_at"] == before["started_at"]
    assert after["config"] == {"gain": 1}
    assert after["chunks_received"] == before["chunks_received"]


def test_duplicate_ingest_start_does_not_clear_a_tombstone(client, tmp_path):
    sid = "dup-2"
    client.post("/ingest/start", json=_start_body(sid))
    _chunk(client, sid, os.urandom(400), offset=32)
    client.post(f"/sessions/{sid}/mark-deleted")

    r = client.post("/ingest/start", json=_start_body(sid))

    assert r.status_code == 200 and r.json()["size"] == 432
    meta = _meta(tmp_path, sid)
    assert meta["state"] == "deleted" and "deleted_at" in meta
    assert (tmp_path / sid / "raw.d1rw").stat().st_size == 432


def test_ingest_start_with_bad_hex_is_a_400_not_a_500(client, tmp_path):
    r = client.post("/ingest/start", json={"session_id": "bad-hex", "header_hex": "zz"})
    assert r.status_code == 400
    assert not (tmp_path / "bad-hex").exists()


def test_session_info_validates_the_id_like_the_other_routes(client):
    assert client.get("/sessions/a%5Cb/info").status_code == 400
    assert client.get("/sessions/C%3A/info").status_code == 400
    assert client.get("/sessions/ghost/info").status_code == 404


def test_meta_updates_leave_no_temp_file_and_stay_valid_json(client, tmp_path):
    sid = "atomic-1"
    client.post("/ingest/start", json=_start_body(sid))
    _chunk(client, sid, os.urandom(400), offset=32)
    client.post("/ingest/finish", json={"session_id": sid})
    names = sorted(os.listdir(tmp_path / sid))
    assert names == ["meta.json", "raw.d1rw"]
    assert _meta(tmp_path, sid)["state"] == "complete"


def test_meta_writes_go_through_write_meta(client, tmp_path, monkeypatch):
    import server as srv

    calls = []
    real = srv._write_meta
    monkeypatch.setattr(
        srv, "_write_meta", lambda d, m: (calls.append(m["state"]), real(d, m))
    )
    sid = "atomic-2"
    client.post("/ingest/start", json=_start_body(sid))
    _chunk(client, sid, os.urandom(400), offset=32)
    client.post("/ingest/finish", json={"session_id": sid})
    assert calls == ["streaming", "streaming", "complete"]
