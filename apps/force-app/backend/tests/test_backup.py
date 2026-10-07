"""Tests for the backup client: config persistence, BackupStreamer file-tailing."""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

from app.backup import BackupStreamer, load_config, save_config
from app.d1rw import HEADER_SIZE, RawWriter

# ---- Config persistence ----


def test_load_config_defaults(tmp_path):
    cfg = load_config(str(tmp_path))
    assert cfg["enabled"] is False
    assert cfg["server_url"] == ""
    # Retention belongs to the server (#93) — the client no longer has a setting for it.
    assert "retention_hours" not in cfg


def test_save_and_load_config(tmp_path):
    save_config(str(tmp_path), {"enabled": True, "server_url": "http://backuphost:8210"})
    cfg = load_config(str(tmp_path))
    assert cfg["enabled"] is True
    assert cfg["server_url"] == "http://backuphost:8210"


def test_save_config_merges(tmp_path):
    save_config(str(tmp_path), {"enabled": True, "server_url": "http://host1:8210"})
    save_config(str(tmp_path), {"enabled": False})
    cfg = load_config(str(tmp_path))
    assert cfg["enabled"] is False
    assert cfg["server_url"] == "http://host1:8210"  # preserved from first save


def test_old_config_with_retention_hours_still_loads(tmp_path, isolate_backup_config):
    # A config file written by an older build still carries the dead retention_hours key.
    isolate_backup_config.write_text(
        json.dumps({"enabled": True, "server_url": "http://h:8210", "retention_hours": 48})
    )
    cfg = load_config(str(tmp_path))
    assert cfg == {"enabled": True, "server_url": "http://h:8210"}
    # ...and a save neither keeps the old key nor accepts a new one.
    saved = save_config(str(tmp_path), {"retention_hours": 5})
    assert "retention_hours" not in saved
    assert "retention_hours" not in json.loads(isolate_backup_config.read_text())


# ---- BackupStreamer ----


class _IngestHandler(BaseHTTPRequestHandler):
    """Minimal mock backup server that records what it receives."""

    sessions: dict = {}
    lock = threading.Lock()

    def do_POST(self):  # noqa: N802 — name mandated by BaseHTTPRequestHandler
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if self.path == "/ingest/start":
            data = json.loads(body)
            sid = data["session_id"]
            with self.lock:
                self.sessions[sid] = {
                    "header": bytes.fromhex(data.get("header_hex", "")),
                    "chunks": [],
                    "finished": False,
                }
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())

        elif self.path == "/ingest/chunk":
            sid = self.headers.get("X-Session-ID", "")
            with self.lock:
                if sid in self.sessions:
                    self.sessions[sid]["chunks"].append(body)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "appended": len(body)}).encode())

        elif self.path == "/ingest/finish":
            data = json.loads(body)
            sid = data["session_id"]
            with self.lock:
                if sid in self.sessions:
                    self.sessions[sid]["finished"] = True
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode())

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress logs during tests


def _start_mock_server():
    _IngestHandler.sessions = {}
    server = HTTPServer(("127.0.0.1", 0), _IngestHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, f"http://127.0.0.1:{port}"


def _make_raw_file(path: str, n_rows: int = 200, rate: float = 2000.0) -> None:
    w = RawWriter(path, n_cols=10, rate=rate, start_unix=1700000000.0)
    rng = np.random.default_rng(7)
    for i in range(0, n_rows, 50):
        n = min(50, n_rows - i)
        t = np.arange(i, i + n, dtype=np.float64) / rate
        data = rng.normal(size=(n, 9)).astype(np.float64)
        w.append(t, data)
    w.close()


def test_streamer_sends_data_to_server(tmp_path):
    server, url = _start_mock_server()
    try:
        raw_path = str(tmp_path / "raw.d1raw")
        _make_raw_file(raw_path, n_rows=200)

        streamer = BackupStreamer("test-session-001", raw_path, url)
        streamer.start()
        # Wait for it to finish (file is already complete, streamer should send all and stop quickly)
        time.sleep(2)
        streamer.stop()

        status = streamer.status()
        assert status["state"] == "done"
        assert status["bytes_sent"] > HEADER_SIZE
        assert status["chunks_sent"] >= 1

        # Verify server received the data
        sess = _IngestHandler.sessions.get("test-session-001")
        assert sess is not None
        assert len(sess["header"]) == HEADER_SIZE
        total_chunk_bytes = sum(len(c) for c in sess["chunks"])
        assert total_chunk_bytes > 0
        assert sess["finished"] is True
    finally:
        server.shutdown()


def test_streamer_handles_unreachable_server(tmp_path):
    raw_path = str(tmp_path / "raw.d1raw")
    _make_raw_file(raw_path, n_rows=100)

    # Point at a port nothing is listening on
    streamer = BackupStreamer("test-unreachable", raw_path, "http://127.0.0.1:19999")
    streamer.start()
    time.sleep(2)
    streamer.stop()

    status = streamer.status()
    assert status["state"] in ("done", "paused", "error")
    assert status["connected"] is False
    assert status["error"] is not None


def test_streamer_tails_growing_file(tmp_path):
    server, url = _start_mock_server()
    try:
        raw_path = str(tmp_path / "raw.d1raw")
        # Create file with header only
        w = RawWriter(raw_path, n_cols=10, rate=2000.0, start_unix=1700000000.0)

        streamer = BackupStreamer("test-tailing", raw_path, url)
        # Patch chunk interval to be fast for testing
        import app.backup as bmod

        orig_interval = bmod.CHUNK_INTERVAL
        bmod.CHUNK_INTERVAL = 0.3
        try:
            streamer.start()
            time.sleep(0.5)

            # Write some data
            rng = np.random.default_rng(0)
            for i in range(3):
                t = np.arange(i * 50, (i + 1) * 50, dtype=np.float64) / 2000
                data = rng.normal(size=(50, 9)).astype(np.float64)
                w.append(t, data)
                time.sleep(0.5)

            w.close()
            time.sleep(1)
            streamer.stop()

            status = streamer.status()
            assert status["chunks_sent"] >= 1
            assert status["bytes_sent"] > HEADER_SIZE

            sess = _IngestHandler.sessions.get("test-tailing")
            assert sess is not None
            assert sess["finished"] is True
        finally:
            bmod.CHUNK_INTERVAL = orig_interval
    finally:
        server.shutdown()


def test_streamer_status_reports_progress(tmp_path):
    raw_path = str(tmp_path / "raw.d1raw")
    _make_raw_file(raw_path, n_rows=500)
    file_size = os.path.getsize(raw_path)

    server, url = _start_mock_server()
    try:
        streamer = BackupStreamer("test-progress", raw_path, url)
        streamer.start()
        time.sleep(2)
        streamer.stop()

        status = streamer.status()
        assert status["bytes_total"] == file_size
        assert status["progress_pct"] > 0
    finally:
        server.shutdown()
