"""End-to-end live-backup round trip: recorder -> REAL backup server -> restore -> finalize.

The two halves of the backup feature were each well tested, but only ever against different
fixtures, so they had never met:

  - test_backup.py drives BackupStreamer against a hand-rolled mock whose /ingest/chunk handler
    ignores X-Offset entirely and blind-appends. The offset protocol exists precisely to make
    retries idempotent, so the client's half of that contract was never exercised.
  - backup-server/test_server.py drives the real server, but with synthetic requests rather than a
    real streamer, and is not collected by the backend's own pytest run.

Nothing anywhere asserted the thing the feature is actually for: that a recording streamed off the
acquisition PC can be pulled back and finalized into a capture matching the original. These tests
close that gap by running the real server.py in-process and putting a real RecordingSession
through it, including a mid-stream outage.
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import threading
import time

import numpy as np
import pytest

from app import backup as bmod
from app.backup import (
    BackupStreamer,
    download_remote_raw,
    fetch_remote_session_config,
    fetch_remote_sessions,
    probe_server,
)
from app.config import SIGNAL_CHANNELS, RecordConfig
from app.recovery import recover_session, write_manifest
from app.session import RecordingSession

BACKUP_SERVER_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backup-server"
)


def _load_backup_server(storage_dir: str):
    """Import backup-server/server.py fresh, with STORAGE bound to `storage_dir`.

    server.py reads STORAGE from the environment at import time, so the env var must be set before
    the import and the module must not be cached between tests that use different directories.
    """
    os.environ["BACKUP_STORAGE"] = storage_dir
    os.environ["BACKUP_RETENTION_HOURS"] = "24"
    sys.modules.pop("server", None)
    spec = importlib.util.spec_from_file_location(
        "server", os.path.join(BACKUP_SERVER_DIR, "server.py")
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["server"] = mod
    spec.loader.exec_module(mod)
    return mod


class _ServerHandle:
    """The real FastAPI backup server on a real socket, startable and stoppable mid-test.

    Binds the socket up front and hands it to uvicorn so the port is known without racing, and so
    a restart can reuse the exact same port — which is what lets a test drop the server mid-stream
    and bring it back at the URL the streamer is already pointed at.
    """

    def __init__(self, storage_dir: str):
        self.storage_dir = storage_dir
        self.module = _load_backup_server(storage_dir)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self.port = self._sock.getsockname()[1]
        self._server = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        import uvicorn

        if self._sock is None:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._sock.bind(("127.0.0.1", self.port))
        cfg = uvicorn.Config(self.module.app, log_level="warning", lifespan="on")
        self._server = uvicorn.Server(cfg)
        sock = self._sock
        self._thread = threading.Thread(
            target=lambda: self._server.run(sockets=[sock]), daemon=True
        )
        self._thread.start()
        deadline = time.time() + 15
        while time.time() < deadline:
            if getattr(self._server, "started", False):
                return
            time.sleep(0.05)
        raise RuntimeError("backup server did not start in time")

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=10)
        self._server = None
        self._thread = None
        self._sock = None  # uvicorn closes the socket it was handed


@pytest.fixture
def server(tmp_path):
    h = _ServerHandle(str(tmp_path / "remote"))
    h.start()
    try:
        yield h
    finally:
        h.stop()


# ---- A real recording source (deterministic, fast) ----


class _FiniteSource:
    """Emits a fixed number of chunks of synthetic 9-channel data, then ends the stream."""

    channels = list(SIGNAL_CHANNELS)
    rate = 2000.0

    def __init__(self, chunks: int = 40, chunk_n: int = 200, delay: float = 0.02):
        self.chunks = chunks
        self.chunk_n = chunk_n
        self.delay = delay
        self._i = 0
        self._sent = 0
        self._stop = threading.Event()
        self._rng = np.random.default_rng(7)

    def start(self):
        self._i = 0
        self._sent = 0
        self._stop.clear()

    def stop(self):
        self._stop.set()

    def read(self):
        if self._stop.is_set() or self._sent >= self.chunks:
            return None
        n = self.chunk_n
        t = np.arange(self._i, self._i + n) / self.rate
        data = self._rng.normal(0, 1.0, size=(n, len(self.channels)))
        self._i += n
        self._sent += 1
        time.sleep(self.delay)  # let the 5s-interval streamer actually see a growing file
        return t, data


def _record(
    tmp_path, server_url: str, *, chunk_interval: float = 0.2, **cfg_kw
) -> RecordingSession:
    """Run a complete recording locally with live backup streaming to `server_url`."""
    cfg = RecordConfig(sample_rate=2000, duration_sec=4.0, sample_name="E2E-BACKUP", **cfg_kw)
    captures = str(tmp_path / "captures")
    os.makedirs(captures, exist_ok=True)
    bmod.save_config(captures, {"enabled": True, "server_url": server_url})
    sess = RecordingSession(cfg, captures, _FiniteSource())
    # Tighten the streamer's cadence so a ~2s test recording produces several real chunks.
    orig = bmod.CHUNK_INTERVAL
    bmod.CHUNK_INTERVAL = chunk_interval
    try:
        sess.start()
        if sess._thread:
            sess._thread.join(30)
        sess.join_finalize(30)
    finally:
        bmod.CHUNK_INTERVAL = orig
    return sess


def _local_raw(sess: RecordingSession) -> bytes:
    with open(os.path.join(sess.dir, "raw.d1raw"), "rb") as f:
        return f.read()


def _restore_and_finalize(server_url: str, sid: str, restore_root: str) -> dict:
    """The exact sequence POST /backup/restore/{id} performs, minus the HTTP layer."""
    capture_dir = os.path.join(restore_root, sid)
    os.makedirs(capture_dir, exist_ok=True)
    download_remote_raw(server_url, sid, os.path.join(capture_dir, "raw.d1raw"))
    remote_cfg = fetch_remote_session_config(server_url, sid)
    assert (
        remote_cfg
    ), "server returned no recording config — restore would produce volts-as-newtons"
    cfg = RecordConfig(**{k: v for k, v in remote_cfg.items() if v is not None})
    write_manifest(capture_dir, "restored", cfg)
    return recover_session(restore_root, sid)


# ---- The round trip ----


def test_streamed_backup_restores_byte_identically(server, tmp_path):
    sess = _record(tmp_path, server.url)
    assert sess.state == "done", f"local recording failed: {sess.error}"

    sessions = fetch_remote_sessions(server.url)["sessions"]
    assert [s["id"] for s in sessions] == [sess.id]

    restored = _restore_and_finalize(server.url, sess.id, str(tmp_path / "restored"))

    with open(os.path.join(tmp_path / "restored", sess.id, "raw.d1raw"), "rb") as f:
        assert f.read() == _local_raw(sess), "restored raw differs from the recorded raw"

    with open(os.path.join(sess.dir, "summary.json")) as f:
        local = json.load(f)
    assert restored["n"] == local["n"]
    assert restored["fs"] == local["fs"]
    for ax in ("Fx", "Fy", "Fz"):
        assert restored["peaks"][ax] == pytest.approx(local["peaks"][ax])


def test_restore_survives_a_mid_stream_outage(server, tmp_path):
    """Drop the server mid-recording and bring it back; the restored file must still be exact.

    Note what this does and does not cover. A CLEAN outage writes nothing server-side, so the
    client's retry offset still matches the server's size exactly and no overlap arises — this
    proves resume-after-reconnect, not the dedup path. The overlap case (server wrote the bytes,
    client never saw the response) is covered by test_dropped_ack_does_not_duplicate_bytes below.
    """
    cfg = RecordConfig(sample_rate=2000, duration_sec=4.0, sample_name="E2E-OUTAGE")
    captures = str(tmp_path / "captures")
    os.makedirs(captures, exist_ok=True)
    bmod.save_config(captures, {"enabled": True, "server_url": server.url})

    orig = bmod.CHUNK_INTERVAL
    bmod.CHUNK_INTERVAL = 0.2
    try:
        sess = RecordingSession(cfg, captures, _FiniteSource(chunks=60, delay=0.03))
        sess.start()
        time.sleep(0.6)  # let some chunks land
        server.stop()  # outage begins
        time.sleep(0.8)  # recording continues locally, streamer retries and fails
        server.start()  # back on the same port
        if sess._thread:
            sess._thread.join(30)
        sess.join_finalize(30)
    finally:
        bmod.CHUNK_INTERVAL = orig

    assert sess.state == "done", f"recording should survive a backup outage: {sess.error}"
    # The streamer drains the tail on stop(), so the server should hold the whole file again.
    _restore_and_finalize(server.url, sess.id, str(tmp_path / "restored"))
    with open(os.path.join(tmp_path / "restored", sess.id, "raw.d1raw"), "rb") as f:
        restored_bytes = f.read()
    local_bytes = _local_raw(sess)
    assert len(restored_bytes) == len(local_bytes), (
        f"restored {len(restored_bytes)} bytes vs local {len(local_bytes)} — "
        "duplicated or dropped chunk across the outage"
    )
    assert restored_bytes == local_bytes


class _AckDroppingProxy:
    """Forwards to the real server but hides the response to the first /ingest/chunk.

    This reproduces the exact hazard the X-Offset protocol was designed for, and the one case the
    existing tests cannot reach: the server DID append the bytes, but the client never learned it,
    so the client keeps its old offset and re-sends from there. Its next chunk therefore overlaps
    bytes the server already holds. A blind append would write that overlap twice, and .d1raw is
    fixed-width interleaved rows — one duplicated chunk misaligns every row after it and silently
    corrupts the whole backup while leaving a plausible-looking file.
    """

    def __init__(self, target_url: str):
        self.target = target_url.rstrip("/")
        self.dropped = 0
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self.port = self._sock.getsockname()[1]
        self._sock.close()
        self._httpd = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> None:
        import urllib.error
        import urllib.request
        from http.server import BaseHTTPRequestHandler, HTTPServer

        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
                headers = {k: v for k, v in self.headers.items() if k.lower() != "host"}
                req = urllib.request.Request(
                    proxy.target + self.path, data=body, headers=headers, method="POST"
                )
                try:
                    with urllib.request.urlopen(req, timeout=10) as r:
                        payload, status = r.read(), r.status
                except urllib.error.HTTPError as e:
                    payload, status = e.read(), e.code

                # The bytes are now committed upstream; pretend the reply never made it back.
                if self.path == "/ingest/chunk" and proxy.dropped == 0 and status == 200:
                    proxy.dropped += 1
                    self.send_response(502)
                    self.end_headers()
                    self.wfile.write(b"simulated lost ack")
                    return
                self.send_response(status)
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):  # noqa: N802
                try:
                    with urllib.request.urlopen(proxy.target + self.path, timeout=10) as r:
                        payload, status = r.read(), r.status
                except urllib.error.HTTPError as e:
                    payload, status = e.read(), e.code
                self.send_response(status)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):  # silence
                pass

        self._httpd = HTTPServer(("127.0.0.1", self.port), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
        if self._thread:
            self._thread.join(timeout=5)


def test_dropped_ack_does_not_duplicate_bytes(server, tmp_path):
    """The dedup path, exercised client-against-server for the first time.

    test_backup.py's mock ignores X-Offset and blind-appends, so this contract has only ever been
    checked from the server side with synthetic requests. Here a real BackupStreamer talks to the
    real server through a proxy that swallows one acknowledgement.
    """
    proxy = _AckDroppingProxy(server.url)
    proxy.start()
    try:
        cfg = RecordConfig(sample_rate=2000, duration_sec=4.0, sample_name="E2E-DROPPED-ACK")
        captures = str(tmp_path / "captures")
        os.makedirs(captures, exist_ok=True)
        bmod.save_config(captures, {"enabled": True, "server_url": proxy.url})

        orig = bmod.CHUNK_INTERVAL
        bmod.CHUNK_INTERVAL = 0.2
        try:
            sess = RecordingSession(cfg, captures, _FiniteSource(chunks=60, delay=0.03))
            sess.start()
            if sess._thread:
                sess._thread.join(30)
            sess.join_finalize(30)
        finally:
            bmod.CHUNK_INTERVAL = orig
    finally:
        proxy.stop()

    assert (
        proxy.dropped == 1
    ), "the proxy never got a chunk to drop — test did not exercise its case"
    assert sess.state == "done", f"recording failed: {sess.error}"

    # Read back through the real server (not the proxy) and compare byte for byte.
    _restore_and_finalize(server.url, sess.id, str(tmp_path / "restored"))
    with open(os.path.join(tmp_path / "restored", sess.id, "raw.d1raw"), "rb") as f:
        restored_bytes = f.read()
    local_bytes = _local_raw(sess)
    assert len(restored_bytes) == len(local_bytes), (
        f"restored {len(restored_bytes)} bytes vs local {len(local_bytes)} — the re-sent overlap "
        "was appended twice instead of deduplicated"
    )
    assert restored_bytes == local_bytes


def test_local_recording_unaffected_when_server_never_reachable(tmp_path):
    """Backup is best-effort: an unreachable server must not degrade the local capture at all."""
    sess = _record(tmp_path, "http://127.0.0.1:9")  # port 9 = discard, refuses connections
    assert (
        sess.state == "done"
    ), f"recording must survive an unreachable backup server: {sess.error}"
    assert os.path.isfile(os.path.join(sess.dir, "capture.mat"))
    assert sess.backup is not None and sess.backup.status()["connected"] is False


# ---- The remote-query helpers, previously untested ----


def test_probe_server_reports_reachability(server):
    ok = probe_server(server.url)
    assert ok["reachable"] is True and ok["ok"] is True
    assert "disk_free_gb" in ok

    down = probe_server("http://127.0.0.1:9")
    assert down["reachable"] is False and "error" in down


def test_fetch_remote_sessions_empty_and_unreachable(server):
    assert fetch_remote_sessions(server.url)["sessions"] == []
    # An unreachable server is an error, not "no backups" (#92).
    with pytest.raises(bmod.RemoteBackupError):
        fetch_remote_sessions("http://127.0.0.1:9")


def test_fetch_remote_session_config_missing_returns_empty(server):
    """The guard behind the restore endpoint's 502: no config must not silently become a default.

    A fabricated RecordConfig has empty dyno_gains, so finalize applies the scalar gain of 1.0 and
    writes raw amplifier volts labelled as newtons — wrong by a per-channel factor, and not
    obviously wrong on inspection.
    """
    assert fetch_remote_session_config(server.url, "no-such-session") == {}


def test_restore_refuses_without_a_recording_config(server, tmp_path):
    """A session whose bytes arrived but whose config didn't must fail loudly, not guess.

    Header bytes are sent so the raw file genuinely exists server-side — otherwise the download
    404s first and we'd never reach the check this test is about.
    """
    import urllib.request

    from app.d1rw import pack_header

    req = urllib.request.Request(
        f"{server.url}/ingest/start",
        data=json.dumps(
            {
                "session_id": "cfgless",
                "header_hex": pack_header(10, 2000.0, time.time()).hex(),
                # config deliberately omitted — an older or partially-upgraded client
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5).read()

    assert fetch_remote_session_config(server.url, "cfgless") == {}
    with pytest.raises(AssertionError, match="volts-as-newtons"):
        _restore_and_finalize(server.url, "cfgless", str(tmp_path / "restored"))


def test_streamer_reports_progress_against_the_real_server(server, tmp_path):
    raw_path = str(tmp_path / "raw.d1raw")
    from app.d1rw import RawWriter

    w = RawWriter(raw_path, n_cols=10, rate=2000.0, start_unix=time.time())
    w.append(np.arange(500) / 2000.0, np.zeros((500, 9)))
    w.close()

    orig = bmod.CHUNK_INTERVAL
    bmod.CHUNK_INTERVAL = 0.1
    try:
        s = BackupStreamer("progress-test", raw_path, server.url, RecordConfig(sample_rate=2000))
        s.start()
        time.sleep(0.6)
        s.stop()
    finally:
        bmod.CHUNK_INTERVAL = orig

    st = s.status()
    assert st["connected"] is True
    assert st["bytes_sent"] == os.path.getsize(raw_path)
    assert st["progress_pct"] == pytest.approx(100.0, abs=0.5)


def test_restore_refuses_to_overwrite_a_finalized_local_capture(server, tmp_path, monkeypatch):
    """Restoring must not clobber an intact local capture.

    The download opens raw.d1raw for writing and recover_session only refuses a finalized session
    afterwards, so the old order destroyed the local raw and then failed. Harmless when the remote
    copy is complete — but this endpoint exists for situations where copies are already being lost,
    and a truncated remote copy would have taken the good local one with it.
    """
    from fastapi.testclient import TestClient

    from app import main as mainmod

    captures = tmp_path / "captures"
    (captures / "sess-1").mkdir(parents=True)
    raw = captures / "sess-1" / "raw.d1raw"
    raw.write_bytes(b"the local copy, which must survive")
    (captures / "sess-1" / "summary.json").write_text('{"n": 1}')

    monkeypatch.setattr(mainmod, "CAPTURES_ROOT", str(captures))
    bmod.save_config(str(captures), {"enabled": True, "server_url": server.url})

    with TestClient(mainmod.app) as c:
        res = c.post("/backup/restore/sess-1")

    assert res.status_code == 409
    assert "already finalized" in res.json()["detail"]
    assert raw.read_bytes() == b"the local copy, which must survive"


def test_local_delete_tombstones_the_real_remote_copy(server, tmp_path, monkeypatch):
    """#91 end to end: a recording streamed to the real server reads "complete" + finalized; after
    a local delete it reads deleted on both sides, with an expiry, and its bytes are still there."""
    from fastapi.testclient import TestClient

    from app import main as mainmod

    sess = _record(tmp_path, server.url)
    assert sess.state == "done", sess.error
    monkeypatch.setattr(mainmod, "CAPTURES_ROOT", sess.captures_root)
    monkeypatch.setattr(mainmod, "_session", None)

    with TestClient(mainmod.app) as c:
        before = {s["id"]: s for s in c.get("/backup/remote-sessions").json()["sessions"]}
        row = before[sess.id]
        assert (row["backup_state"], row["local_status"]) == ("complete", "finalized")
        assert row["name"] == "E2E-BACKUP"

        body = c.delete(f"/captures/{sess.id}").json()
        assert body["remote_marked_deleted"] is True

        after = {s["id"]: s for s in c.get("/backup/remote-sessions").json()["sessions"]}
        row = after[sess.id]
        assert (row["backup_state"], row["local_status"]) == ("deleted", "deleted")
        assert row["expires_at"] > time.time()

    assert fetch_remote_session_config(server.url, sess.id)  # still restorable until it expires
