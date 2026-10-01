"""Non-blocking live-backup streamer: tails the raw.d1raw file during recording and POSTs chunks
to the remote backup server. Runs in a daemon thread — never delays or blocks the local recording.

Design goals (from the spec):
  - Never delay local recording because of networking.
  - Continue local recording if network fails.
  - Automatically resume backup if network reconnects.
  - Chunk-based streaming (every ~5 seconds) for resilience.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

from .config import RecordConfig
from .d1rw import HEADER_SIZE
from .storage import atomic_write_json

# Explicit name, matching force_app.main / force_app.session / force_app.nidaq. __name__ here
# resolves to "app.backup", which breaks module filtering in the Settings > Logs view.
log = logging.getLogger("force_app.backup")

BACKUP_CONFIG_PATH: str | None = None  # set at module init from main.py
# Read-only fallback for installs that wrote this to the pre-move (package-relative) location.
LEGACY_BACKUP_CONFIG_PATH: str | None = None  # set at module init from main.py
CHUNK_INTERVAL = 5.0  # seconds between chunk sends
MAX_CHUNK_BYTES = 4 * 1024 * 1024  # 4 MB per HTTP POST


def _config_path(captures_root: str) -> str:
    """Where the backup settings live.

    When BACKUP_CONFIG_PATH is set (main.py does so at import) it wins, and it deliberately points
    OUTSIDE the captures root: storing these settings on the recording drive tied them to whichever
    drive was selected, so repointing the drive silently reverted backup to {"enabled": False} with
    no UI indication — /backup/status reads the same now-empty config, so it looks correctly
    disabled while recordings go unprotected.

    Falling back to captures_root when it is unset keeps the function injectable, which is what
    lets tests point it at a tmp_path instead of writing to the real installed config.
    """
    return BACKUP_CONFIG_PATH or os.path.join(captures_root, "backup_config.json")


def load_config(captures_root: str) -> dict:
    cfg = {"enabled": False, "server_url": "", "retention_hours": 12}
    # Fall back through the pre-move locations so an existing install doesn't silently lose its
    # backup settings — and therefore silently stop backing up — the first time it starts on the
    # new path. Only the first (current) path is ever written to; a save migrates the settings.
    candidates = [_config_path(captures_root)]
    if LEGACY_BACKUP_CONFIG_PATH:
        candidates.append(LEGACY_BACKUP_CONFIG_PATH)
    candidates.append(os.path.join(captures_root, "backup_config.json"))
    for path in candidates:
        if not os.path.isfile(path):
            continue
        try:
            with open(path) as f:
                cfg.update(json.load(f))
        except (OSError, ValueError):
            # The current config exists but is unreadable (save_config is not atomic, so a
            # truncated write is possible). Stop here rather than falling through: an older file
            # could resurrect a stale server URL or re-enable backup the user had turned off, and
            # streaming a recording to the wrong host is worse than the safe defaults.
            log.warning("backup config at %s is unreadable — using defaults", path)
        break
    return cfg


def save_config(captures_root: str, cfg: dict) -> dict:
    path = _config_path(captures_root)
    merged = load_config(captures_root)
    merged.update(cfg)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    atomic_write_json(path, merged, indent=2)
    return merged


def probe_server(server_url: str, timeout: float = 4.0) -> dict:
    try:
        req = urllib.request.Request(f"{server_url.rstrip('/')}/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
            return {"reachable": True, **data}
    except Exception as e:
        return {"reachable": False, "error": str(e)}


def list_remote_sessions(server_url: str, timeout: float = 8.0) -> list[dict]:
    try:
        req = urllib.request.Request(f"{server_url.rstrip('/')}/sessions", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
            return data.get("sessions", [])
    except Exception:
        return []


def fetch_remote_session_config(server_url: str, session_id: str, timeout: float = 8.0) -> dict:
    """Return the RecordConfig dict the recorder sent to /ingest/start for this session.

    Restoring the raw bytes alone is not enough to reconstruct a recording: without this config
    finalize falls back to a default RecordConfig with empty `dyno_gains`, applies the scalar
    gain=1.0, and writes out raw amplifier VOLTS while labelling them newtons. Returns {} if the
    server has no config for the session, in which case the caller must not fabricate one.
    """
    try:
        url = f"{server_url.rstrip('/')}/sessions/{session_id}/info"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            info = json.loads(r.read())
        cfg = (info.get("meta") or {}).get("config") or {}
        return cfg if isinstance(cfg, dict) else {}
    except Exception as e:
        log.warning("could not fetch remote config for %s: %s", session_id, e)
        return {}


def download_remote_raw(
    server_url: str, session_id: str, dest_path: str, timeout: float = 120.0
) -> int:
    """Download a raw backup file from the remote server. Returns bytes written."""
    url = f"{server_url.rstrip('/')}/sessions/{session_id}/raw"
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        with open(dest_path, "wb") as f:
            total = 0
            while True:
                buf = r.read(1024 * 1024)
                if not buf:
                    break
                f.write(buf)
                total += len(buf)
    return total


class BackupStreamer:
    """Tails a raw.d1raw file and streams chunks to the backup server in a daemon thread."""

    def __init__(
        self, session_id: str, raw_path: str, server_url: str, cfg: RecordConfig | None = None
    ):
        self.session_id = session_id
        self.raw_path = raw_path
        self.server_url = server_url.rstrip("/")
        self.cfg = cfg

        self.bytes_sent = 0
        self.chunks_sent = 0
        self.connected = False
        self.error: str | None = None
        self.state = "idle"  # idle | streaming | paused | done | error

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.state = "streaming"
        self._thread = threading.Thread(
            target=self._run, name=f"backup-{self.session_id}", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10.0)

    def status(self) -> dict:
        raw_size = 0
        try:
            raw_size = os.path.getsize(self.raw_path)
        except OSError:
            pass
        return {
            "state": self.state,
            "bytes_sent": self.bytes_sent,
            "bytes_total": raw_size,
            "chunks_sent": self.chunks_sent,
            "connected": self.connected,
            "error": self.error,
            "progress_pct": round(self.bytes_sent / raw_size * 100, 1) if raw_size > 0 else 0,
        }

    # ---- internal ----

    def _post_json(self, path: str, data: dict, timeout: float = 8.0) -> dict | None:
        try:
            body = json.dumps(data).encode()
            req = urllib.request.Request(
                f"{self.server_url}{path}",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                self.connected = True
                return json.loads(r.read())
        except Exception as e:
            self.connected = False
            self.error = str(e)
            return None

    def _post_chunk(self, chunk: bytes, offset: int, timeout: float = 15.0) -> bool:
        """POST one chunk, telling the server exactly where in the file it belongs.

        The offset makes the write idempotent, which matters because a failure here is ambiguous:
        a read timeout after the server has already appended looks identical to a chunk that never
        arrived, and either way we return False and leave `offset` unadvanced, so the same bytes
        are re-sent next interval. Without the offset the server would append them a second time —
        and since .d1raw is fixed-width interleaved rows, one duplicated chunk misaligns every row
        after it and silently ruins the whole backup. The server drops any chunk that doesn't start
        exactly at its current file size.
        """
        try:
            req = urllib.request.Request(
                f"{self.server_url}/ingest/chunk",
                data=chunk,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Session-ID": self.session_id,
                    "X-Offset": str(offset),
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout):
                self.connected = True
                self.error = None
                return True
        except Exception as e:
            self.connected = False
            self.error = str(e)
            return False

    def _run(self) -> None:
        # Wait for the raw file to exist and have the header
        for _ in range(20):
            if self._stop.is_set():
                self.state = "done"
                return
            try:
                if os.path.getsize(self.raw_path) >= HEADER_SIZE:
                    break
            except OSError:
                pass
            time.sleep(0.25)

        # Read header
        try:
            with open(self.raw_path, "rb") as f:
                header = f.read(HEADER_SIZE)
        except OSError as e:
            self.error = f"cannot read raw file: {e}"
            self.state = "error"
            return

        # Register session with backup server
        cfg_dump = self.cfg.model_dump() if self.cfg else {}
        result = self._post_json(
            "/ingest/start",
            {
                "session_id": self.session_id,
                "header_hex": header.hex(),
                "config": cfg_dump,
            },
        )
        if result is None:
            # Server unreachable at start — keep trying in the loop
            log.warning("backup server unreachable at session start, will retry")
            self.state = "paused"

        offset = HEADER_SIZE  # start reading after header (already sent)
        registered = result is not None

        while not self._stop.is_set():
            self._stop.wait(CHUNK_INTERVAL)
            if self._stop.is_set():
                break

            try:
                file_size = os.path.getsize(self.raw_path)
            except OSError:
                continue

            if file_size <= offset:
                continue  # no new data

            # Register if we haven't yet (server was down at start)
            if not registered:
                result = self._post_json(
                    "/ingest/start",
                    {
                        "session_id": self.session_id,
                        "header_hex": header.hex(),
                        "config": cfg_dump,
                    },
                )
                if result is None:
                    continue
                registered = True
                self.state = "streaming"

            # Read new bytes and send in bounded chunks
            try:
                with open(self.raw_path, "rb") as f:
                    f.seek(offset)
                    remaining = file_size - offset
                    while remaining > 0:
                        to_read = min(remaining, MAX_CHUNK_BYTES)
                        chunk = f.read(to_read)
                        if not chunk:
                            break
                        if self._post_chunk(chunk, offset):
                            offset += len(chunk)
                            self.bytes_sent = offset
                            self.chunks_sent += 1
                            self.state = "streaming"
                        else:
                            self.state = "paused"
                            break  # network issue — retry next interval
                        remaining -= len(chunk)
            except OSError as e:
                self.error = f"read error: {e}"

        # Send any final bytes after stop
        try:
            file_size = os.path.getsize(self.raw_path)
            if file_size > offset and registered:
                with open(self.raw_path, "rb") as f:
                    f.seek(offset)
                    while offset < file_size:
                        chunk = f.read(min(MAX_CHUNK_BYTES, file_size - offset))
                        if not chunk:
                            break
                        if self._post_chunk(chunk, offset):
                            offset += len(chunk)
                            self.bytes_sent = offset
                            self.chunks_sent += 1
                        else:
                            break
        except OSError:
            pass

        # Signal completion
        if registered:
            self._post_json("/ingest/finish", {"session_id": self.session_id})

        self.state = "done"
