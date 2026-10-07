"""POST /backup/restore must never destroy local data (#82), and recover/discard must not race.

The "remote" is a real HTTP server on localhost that serves a raw file and a recording config, and
can cut a download off part-way, so the download code really writes (and really fails).
"""

from __future__ import annotations

import http.server
import json
import os
import threading

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import backup as backup_mod
from app import recovery
from app.config import RecordConfig
from app.d1rw import RawWriter
from app.main import app as fastapi_app
from app.recovery import write_manifest

SID = "20261001-100000-abc"


def _write_raw(path: str, rows: int) -> bytes:
    w = RawWriter(path, n_cols=10, rate=2000.0, start_unix=1_700_000_000.0)
    if rows:
        w.append(np.arange(rows) / 2000.0, np.ones((rows, 9)))
    w.close()
    with open(path, "rb") as f:
        return f.read()


class _Remote:
    def __init__(self, raw: bytes, config: dict | None, cut_after: int | None = None, on_raw=None):
        outer = self
        self.raw, self.config, self.cut_after = raw, config, cut_after
        self.on_raw = on_raw  # called (in the server thread) when the raw download is requested
        self.posts: list[str] = []  # paths POSTed to (the unmark-deleted call)
        self.post_status = 200

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):  # noqa: N802
                outer.posts.append(self.path)
                self.send_response(outer.post_status)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self):  # noqa: N802 (http.server dispatches on this name)
                if self.path.endswith("/raw"):
                    if outer.on_raw:
                        outer.on_raw()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(outer.raw)))
                    self.end_headers()
                    body = outer.raw if outer.cut_after is None else outer.raw[: outer.cut_after]
                    self.wfile.write(body)
                    self.wfile.flush()
                    self.close_connection = True  # short body + Content-Length = IncompleteRead
                elif self.path.endswith("/info"):
                    data = json.dumps({"meta": {"config": outer.config}}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    self.send_response(404)
                    self.end_headers()

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    remotes: list[_Remote] = []

    def make(raw: bytes, config="default", cut_after=None, on_raw=None) -> _Remote:
        cfg = (
            RecordConfig(sample_rate=2000, sample_name="REMOTE-1").model_dump()
            if config == "default"
            else config
        )
        r = _Remote(raw, cfg, cut_after, on_raw)
        remotes.append(r)
        backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": r.url})
        return r

    with TestClient(fastapi_app) as c:
        yield c, tmp_path, make
    for r in remotes:
        r.close()


def _local_incomplete(root, rows: int) -> tuple[str, bytes]:
    d = os.path.join(str(root), SID)
    os.makedirs(d)
    raw = _write_raw(os.path.join(d, "raw.d1raw"), rows)
    write_manifest(d, "recording", RecordConfig(sample_rate=2000, sample_name="LOCAL-1"))
    return d, raw


def _snapshot(d: str) -> dict[str, bytes]:
    out = {}
    for n in sorted(os.listdir(d)):
        with open(os.path.join(d, n), "rb") as f:
            out[n] = f.read()
    return out


def test_failed_download_keeps_the_local_raw_byte_identical(env):
    client, root, make = env
    d, local = _local_incomplete(root, rows=4000)
    before = _snapshot(d)
    remote_raw = _write_raw(str(root / "remote.d1raw"), 3000)
    make(remote_raw, cut_after=len(remote_raw) // 2)
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 502
    assert "local copy was not changed" in r.json()["detail"]
    assert _snapshot(d) == before  # raw AND manifest untouched, no .part left behind


def test_failed_download_into_a_new_dir_leaves_nothing(env):
    client, root, make = env
    remote_raw = _write_raw(str(root / "remote.d1raw"), 3000)
    make(remote_raw, cut_after=100)
    assert client.post(f"/backup/restore/{SID}").status_code == 502
    assert not os.path.exists(os.path.join(str(root), SID))


def test_existing_incomplete_capture_that_is_longer_is_refused(env):
    client, root, make = env
    d, _ = _local_incomplete(root, rows=4000)
    before = _snapshot(d)
    make(_write_raw(str(root / "remote.d1raw"), 3000))  # remote is the SHORTER copy
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 409
    assert _snapshot(d) == before


def test_longer_remote_replaces_but_keeps_the_local_raw_aside(env):
    client, root, make = env
    d, local = _local_incomplete(root, rows=2000)
    remote_raw = _write_raw(str(root / "remote.d1raw"), 5000)
    make(remote_raw)
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 200, r.text
    aside = r.json()["local_copy_kept_as"]
    with open(os.path.join(d, aside), "rb") as f:
        assert f.read() == local  # the local rows are still there, untouched
    with open(os.path.join(d, "raw.d1raw"), "rb") as f:
        assert f.read() == remote_raw
    # the local recording's own manifest (LOCAL-1) is kept rather than replaced by the remote's
    assert json.load(open(os.path.join(d, "summary.json")))["sample_name"] == "LOCAL-1"


def test_failed_finalize_puts_the_local_raw_back(env, monkeypatch):
    client, root, make = env
    d, local = _local_incomplete(root, rows=2000)
    make(_write_raw(str(root / "remote.d1raw"), 5000))

    def boom(*a, **k):
        raise RuntimeError("finalize broke")

    monkeypatch.setattr(recovery, "recover_session", boom)
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 500
    assert _snapshot(d)["raw.d1raw"] == local
    assert not [n for n in os.listdir(d) if ".local-" in n or n.endswith(".part")]


def test_clean_restore_into_a_new_dir_still_works(env):
    client, root, make = env
    remote_raw = _write_raw(str(root / "remote.d1raw"), 3000)
    make(remote_raw)
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["n"] == 3000
    assert not os.path.exists(os.path.join(str(root), SID, "raw.d1raw.part"))


def test_a_successful_restore_clears_the_remote_deleted_mark(env):
    client, root, make = env
    remote = make(_write_raw(str(root / "remote.d1raw"), 3000))
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 200, r.text
    assert remote.posts == [f"/sessions/{SID}/unmark-deleted"]
    assert r.json()["remote_unmarked"] is True


def test_a_failing_unmark_never_fails_the_restore(env):
    client, root, make = env
    remote = make(_write_raw(str(root / "remote.d1raw"), 3000))
    remote.post_status = 500  # or an older server with no such endpoint
    r = client.post(f"/backup/restore/{SID}")
    assert r.status_code == 200, r.text
    assert remote.posts == [f"/sessions/{SID}/unmark-deleted"]
    assert r.json()["remote_unmarked"] is False
    assert os.path.isfile(os.path.join(str(root), SID, "summary.json"))


def test_a_failed_or_refused_restore_leaves_the_remote_mark_alone(env):
    client, root, make = env
    remote_raw = _write_raw(str(root / "remote.d1raw"), 3000)
    remote = make(remote_raw, cut_after=100)
    assert client.post(f"/backup/restore/{SID}").status_code == 502  # download cut off
    d, _ = _local_incomplete(root, rows=4000)
    remote.cut_after = None
    assert client.post(f"/backup/restore/{SID}").status_code == 409  # local copy is longer
    assert remote.posts == []


def test_unmark_remote_deleted_never_raises():
    assert backup_mod.unmark_remote_deleted("http://127.0.0.1:9", "x", timeout=1.0) is False
    assert backup_mod.unmark_remote_deleted("", "x") is False


def test_restore_of_the_active_session_is_refused(env, monkeypatch):
    client, root, make = env
    make(_write_raw(str(root / "remote.d1raw"), 100))
    monkeypatch.setattr(main, "_active_session_id", lambda: SID)
    assert client.post(f"/backup/restore/{SID}").status_code == 409
    assert not os.path.exists(os.path.join(str(root), SID))


# ---- #83: recover vs discard ------------------------------------------------------------------


def test_discard_is_refused_while_the_same_id_is_being_recovered(env):
    client, root, _ = env
    _local_incomplete(root, rows=100)
    recovery._recovering.add(SID)
    try:
        assert client.post(f"/recovery/discard/{SID}").status_code == 409
        assert client.post(f"/recovery/recover/{SID}").status_code == 409  # second recover too
        assert os.path.isdir(os.path.join(str(root), SID))
    finally:
        recovery._recovering.discard(SID)


def test_recover_clears_its_marker_afterwards_even_on_failure(env, monkeypatch):
    client, root, _ = env
    _local_incomplete(root, rows=100)
    monkeypatch.setattr(
        recovery, "recover_session", lambda *a: (_ for _ in ()).throw(RuntimeError("x"))
    )
    assert client.post(f"/recovery/recover/{SID}").status_code == 500
    assert SID not in recovery._recovering


def test_recover_refuses_a_discard_in_flight(env):
    client, root, _ = env
    _local_incomplete(root, rows=100)
    recovery._discarding.add(SID)
    try:
        assert client.post(f"/recovery/recover/{SID}").status_code == 409
    finally:
        recovery._discarding.discard(SID)


# ---- two requests for one id: the busy check and the claim are one step ----------------------


def _pause_first_restore(monkeypatch):
    """Park the first restore at its first await (the local raw_info probe), where the busy check
    has passed but, before the fix, the id was not yet claimed. Later calls go straight through."""
    started, release = threading.Event(), threading.Event()
    calls: list[int] = []
    real = recovery.raw_info

    def raw_info(d):
        calls.append(1)
        if len(calls) == 1:
            started.set()
            assert release.wait(30)
        return real(d)

    monkeypatch.setattr(recovery, "raw_info", raw_info)
    return started, release


def _post_in_thread(client, path: str) -> tuple[threading.Thread, list]:
    out: list = []
    t = threading.Thread(target=lambda: out.append(client.post(path)))
    t.start()
    return t, out


def test_two_concurrent_restores_of_one_id_one_wins_and_the_capture_survives(env, monkeypatch):
    client, root, make = env
    remote_raw = _write_raw(str(root / "remote.d1raw"), 3000)
    make(remote_raw)
    started, release = _pause_first_restore(monkeypatch)
    first, first_out = _post_in_thread(client, f"/backup/restore/{SID}")
    try:
        assert started.wait(30)  # the first restore is parked at its first await
        second = client.post(f"/backup/restore/{SID}")
        assert second.status_code == 409  # refused outright, not run alongside the first
        assert SID in recovery._recovering  # ...and its refusal did not release the first's claim
    finally:
        release.set()
        first.join(30)
    assert first_out[0].status_code == 200, first_out[0].text
    d = os.path.join(str(root), SID)
    assert json.load(open(os.path.join(d, "summary.json")))["n"] == 3000
    assert _snapshot(d)["raw.d1raw"] == remote_raw
    assert SID not in recovery._recovering


def test_a_recover_racing_a_restore_is_refused_and_leaves_the_restore_alone(env, monkeypatch):
    client, root, make = env
    remote_raw = _write_raw(str(root / "remote.d1raw"), 3000)
    make(remote_raw)
    started, release = _pause_first_restore(monkeypatch)
    first, first_out = _post_in_thread(client, f"/backup/restore/{SID}")
    try:
        assert started.wait(30)
        assert client.post(f"/recovery/recover/{SID}").status_code == 409
        assert client.post(f"/recovery/discard/{SID}").status_code == 409
    finally:
        release.set()
        first.join(30)
    assert first_out[0].status_code == 200, first_out[0].text
    assert os.path.isfile(os.path.join(str(root), SID, "summary.json"))


def test_recovering_refuses_an_id_already_in_flight_without_releasing_it():
    recovery._recovering.add(SID)
    try:
        with pytest.raises(recovery.CaptureBusyError):
            with recovery.recovering(SID):
                pytest.fail("entered a claimed id")
        assert SID in recovery._recovering  # the owner's claim survives the refused attempt
    finally:
        recovery._recovering.discard(SID)
    recovery._discarding.add(SID)
    try:
        with pytest.raises(recovery.CaptureBusyError):
            with recovery.recovering(SID):
                pytest.fail("entered a claimed id")
    finally:
        recovery._discarding.discard(SID)


def test_discard_claims_the_id_before_its_task_runs(env):
    """The handler returns before the background task starts; a recover in that gap must lose."""
    client, root, _ = env
    d, _raw = _local_incomplete(root, rows=100)
    gate = threading.Event()
    real = recovery.discard_session

    def slow(*a):
        assert gate.wait(30)
        return real(*a)

    recovery.discard_session = slow
    try:
        assert client.post(f"/recovery/discard/{SID}").status_code == 200
        assert SID in recovery._discarding
        assert client.post(f"/recovery/recover/{SID}").status_code == 409
        assert client.post(f"/backup/restore/{SID}").status_code in (400, 409)
    finally:
        recovery.discard_session = real
        gate.set()
    import time

    deadline = time.time() + 10
    while SID in recovery._discarding and time.time() < deadline:
        time.sleep(0.05)
    assert SID not in recovery._discarding
    assert not os.path.exists(d)


# ---- #7 + id hardening -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad", ["", ".", "..", "a/b", "a\\b", "C:", "C:foo", "c:\\x", "x:y", "a\x00b", "..\\x", "a/.."]
)
def test_is_safe_id_rejects_names_that_point_at_the_root(bad):
    # "C:" is the review's 1.6 case: ntpath.join(root, "C:", ...) escapes the root on Windows.
    assert recovery.is_safe_id(bad) is False


@pytest.mark.parametrize("good", ["20261001-100000-abc", "a.b", "a b", "x-1_2"])
def test_is_safe_id_accepts_ordinary_ids(good):
    assert recovery.is_safe_id(good) is True


@pytest.mark.parametrize("bad", ["C:", "C:foo", "..", "a/b", "a\\b"])
def test_capture_dir_for_and_discard_refuse_unsafe_ids(tmp_path, bad):
    with pytest.raises(ValueError):
        recovery.capture_dir_for(str(tmp_path), bad)
    with pytest.raises(ValueError):
        recovery.discard_session(str(tmp_path), bad)
    with pytest.raises(ValueError):
        recovery.recover_session(str(tmp_path), bad)


def test_capture_dir_for_returns_a_direct_child(tmp_path):
    assert recovery.capture_dir_for(str(tmp_path), "abc") == os.path.join(str(tmp_path), "abc")


@pytest.mark.parametrize("cid", ["C%3A", "C%3Afoo", "%2e%2e", "..", "a%5Cb", "a%2Fb"])
def test_capture_endpoints_refuse_unsafe_ids_over_http(env, cid):
    client, root, _ = env
    survivor = os.path.join(str(root), "keep-me")
    os.makedirs(survivor)
    for method in ("delete", "get", "post"):
        for url in (f"/captures/{cid}", f"/captures/{cid}/discard", f"/captures/{cid}/summary"):
            r = getattr(client, method)(url)
            assert r.status_code in (400, 404, 405), (method, url, r.status_code)
    assert os.path.isdir(survivor)


def test_non_numeric_updated_at_does_not_break_the_list(env, monkeypatch):
    client, root, _ = env
    backup_mod.save_config(str(root), {"enabled": True, "server_url": "http://b:1"})
    monkeypatch.setattr(
        backup_mod,
        "fetch_remote_sessions",
        lambda url, timeout=8.0: {
            "retention_hours": 12,
            "sessions": [
                {"id": "good", "state": "complete", "meta": {"updated_at": 1_700_000_000}},
                {"id": "bad", "state": "complete", "meta": {"updated_at": "yesterday"}},
            ],
        },
    )
    r = client.get("/backup/remote-sessions")
    assert r.status_code == 200
    by_id = {s["id"]: s for s in r.json()["sessions"]}
    assert by_id["good"]["expires_at"] == 1_700_000_000 + 12 * 3600
    assert by_id["bad"]["expires_at"] is None


def test_a_200_without_sessions_is_an_error_not_an_empty_list(monkeypatch):
    class R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"status": "ok"}'

    monkeypatch.setattr(backup_mod.urllib.request, "urlopen", lambda *a, **k: R())
    with pytest.raises(backup_mod.RemoteBackupError):
        backup_mod.fetch_remote_sessions("http://x")
