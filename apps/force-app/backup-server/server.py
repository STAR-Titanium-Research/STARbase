"""Remote live-backup server for force-app recordings.

Receives chunked D1RW data streamed from the acquisition backend during a recording, stores it in
temporary storage, and auto-purges expired sessions. The acquisition PC can download a backup for
recovery if the local recording is lost.

Run:  uvicorn server:app --host 0.0.0.0 --port 8210

Endpoints:
  POST /ingest/start          — register a new session (sends header + config)
  POST /ingest/chunk          — append a binary chunk to a session's raw file
  POST /ingest/finish         — mark a session as complete
  GET  /sessions              — list stored backup sessions
  GET  /sessions/{id}/raw     — download the raw D1RW file
  GET  /sessions/{id}/info    — session metadata (size, duration, state)
  POST /sessions/{id}/mark-deleted — the recorder deleted its local copy; expire on retention
  POST /sessions/{id}/unmark-deleted — the recorder restored it; undo the tombstone
  DELETE /sessions/{id}       — delete a backup session
  GET  /health                — server health + storage info
"""

from __future__ import annotations

import json
import ntpath
import os
import posixpath
import shutil
import struct
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

STORAGE = os.environ.get(
    "BACKUP_STORAGE", os.path.join(os.path.dirname(__file__), "backups")
)
RETENTION_HOURS = float(os.environ.get("BACKUP_RETENTION_HOURS", "12"))


def _expires_at(updated_at: float) -> float:
    """When the purge sweep removes a session last updated at `updated_at`."""
    return updated_at + RETENTION_HOURS * 3600


PURGE_INTERVAL = 300  # seconds between purge sweeps

D1RW_MAGIC = b"D1RW"
D1RW_HEADER_SIZE = 32
D1RW_HEADER_FMT = "<4sIIfd"


def _is_safe_id(sid: str) -> bool:
    """A bare directory name under BOTH path flavours (same rule as the recorder's
    recovery.is_safe_id): no separators, drive letters (`:`), parent references, and the id must be
    its own normalised basename. "" and "." name STORAGE itself, which DELETE /sessions/{sid} would
    rmtree."""
    if not isinstance(sid, str) or not sid or sid in (".", "..") or ".." in sid:
        return False
    if any(c in sid for c in "/\\:\0"):
        return False
    return all(
        flavour.basename(sid) == sid and flavour.normpath(sid) == sid
        for flavour in (posixpath, ntpath)
    )


def _session_dir(sid: str) -> str:
    if not _is_safe_id(sid):
        raise HTTPException(400, "invalid session id")
    root = os.path.abspath(STORAGE)
    path = os.path.abspath(os.path.join(root, sid))
    try:
        inside = (
            os.path.commonpath([root, path]) == root and os.path.dirname(path) == root
        )
    except ValueError:  # different drives
        inside = False
    if not inside:
        raise HTTPException(400, "invalid session id")
    return os.path.join(STORAGE, sid)


def _write_meta(d: str, meta: dict) -> None:
    """Write a session's meta.json so a reader (or a crash) never sees half of it: temp file in the
    same directory, then os.replace."""
    path = os.path.join(d, "meta.json")
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(meta, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _read_meta_or_409(d: str, sid: str) -> dict | None:
    """A session's meta.json as a dict, None if there is none, 409 if there is one we can't read.

    The stored config (the per-channel gains a restore needs) lives in this file, so a caller that
    rewrites it must not do so on the strength of a read that merely failed."""
    try:
        with open(os.path.join(d, "meta.json")) as f:
            meta = json.load(f)
        if not isinstance(meta, dict):
            raise ValueError("meta.json is not an object")
        return meta
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise HTTPException(
            409, f"session {sid} has an unreadable meta.json ({e}); left untouched"
        ) from e


def _session_info(sid: str) -> dict | None:
    d = os.path.join(STORAGE, sid)
    raw = os.path.join(d, "raw.d1rw")
    meta_path = os.path.join(d, "meta.json")
    if not os.path.isfile(raw):
        return None
    info: dict = {"id": sid, "raw_size_bytes": os.path.getsize(raw)}
    if os.path.isfile(meta_path):
        try:
            with open(meta_path) as f:
                info["meta"] = json.load(f)
        except (OSError, ValueError):
            pass
    # Parse header for duration estimate
    try:
        with open(raw, "rb") as f:
            hdr = f.read(D1RW_HEADER_SIZE)
        if len(hdr) == D1RW_HEADER_SIZE:
            magic, ver, n_cols, rate, start_unix = struct.unpack_from(
                D1RW_HEADER_FMT, hdr
            )
            if magic == D1RW_MAGIC and n_cols > 0 and rate > 0:
                body = info["raw_size_bytes"] - D1RW_HEADER_SIZE
                n_rows = body // (n_cols * 4)
                info["n_rows"] = n_rows
                info["rate"] = rate
                info["duration_sec"] = round(n_rows / rate, 2)
                info["start_unix"] = start_unix
                info["started_iso"] = time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(start_unix)
                )
    except (OSError, struct.error):
        pass
    info["raw_size_mb"] = round(info["raw_size_bytes"] / 1e6, 2)
    meta = info.get("meta", {})
    state = meta.get("state", "unknown")
    info["state"] = state
    # When the purge sweep will remove this session — the same updated_at it measures from (or
    # the directory mtime when meta has none), so a client can say "expires in Xh" without
    # re-deriving the server's retention rule.
    updated = meta.get("updated_at") or _mtime(d)
    if updated:
        info["updated_at"] = updated
        info["expires_at"] = _expires_at(updated)
    if meta.get("deleted_at"):
        info["deleted_at"] = meta["deleted_at"]
    return info


def _mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


# ---- Purge daemon ----
_purge_stop = threading.Event()


def _purge_loop():
    while not _purge_stop.wait(PURGE_INTERVAL):
        _purge_expired()


def _purge_expired():
    if not os.path.isdir(STORAGE):
        return
    cutoff = time.time() - RETENTION_HOURS * 3600
    for name in os.listdir(STORAGE):
        d = os.path.join(STORAGE, name)
        if not os.path.isdir(d):
            continue
        meta_path = os.path.join(d, "meta.json")
        ts = 0.0
        if os.path.isfile(meta_path):
            try:
                with open(meta_path) as f:
                    ts = json.load(f).get("updated_at", 0)
            except (OSError, ValueError):
                pass
        if ts == 0:
            try:
                ts = os.path.getmtime(d)
            except OSError:
                continue
        if ts < cutoff:
            try:
                shutil.rmtree(d)
            except OSError:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(STORAGE, exist_ok=True)
    t = threading.Thread(target=_purge_loop, daemon=True, name="backup-purge")
    t.start()
    yield
    _purge_stop.set()


app = FastAPI(title="force-app-backup-server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/health")
async def health() -> dict:
    total, used, free = shutil.disk_usage(STORAGE)
    sessions = 0
    if os.path.isdir(STORAGE):
        sessions = sum(
            1 for n in os.listdir(STORAGE) if os.path.isdir(os.path.join(STORAGE, n))
        )
    return {
        "ok": True,
        "storage_path": STORAGE,
        "retention_hours": RETENTION_HOURS,
        "sessions": sessions,
        "disk_free_gb": round(free / 1e9, 2),
        "disk_total_gb": round(total / 1e9, 2),
    }


# ---- Ingest ----
@app.post("/ingest/start")
async def ingest_start(request: Request) -> dict:
    body = await request.json()
    sid = body.get("session_id", "")
    if not sid:
        raise HTTPException(400, "session_id required")
    d = _session_dir(sid)
    header_hex = body.get("header_hex", "")
    try:
        header = bytes.fromhex(header_hex) if header_hex else b""
    except (TypeError, ValueError):
        raise HTTPException(400, "header_hex is not valid hex")
    raw_path = os.path.join(d, "raw.d1rw")
    meta_path = os.path.join(d, "meta.json")
    # Idempotent: a retry (or a replay of the start) for a session we already hold must not
    # truncate the raw file back to its header or clear a tombstone -- the streamed bytes are the
    # only copy a lost local capture can be restored from. Tell the client where we are instead;
    # it resumes from that offset.
    if os.path.isfile(raw_path) and os.path.getsize(raw_path) > 0:
        if not os.path.isfile(meta_path):
            # Raw but no meta (a crash between the two writes): re-create the meta only.
            os.makedirs(d, exist_ok=True)
            _write_meta(d, _new_meta(sid, body))
        return {
            "ok": True,
            "session_id": sid,
            "existing": True,
            "size": os.path.getsize(raw_path),
        }
    os.makedirs(d, exist_ok=True)
    if header:
        with open(raw_path, "wb") as f:
            f.write(header)
    _write_meta(d, _new_meta(sid, body))
    return {"ok": True, "session_id": sid, "size": len(header)}


def _new_meta(sid: str, body: dict) -> dict:
    now = time.time()
    return {
        "session_id": sid,
        "state": "streaming",
        "started_at": now,
        "updated_at": now,
        "config": body.get("config", {}),
    }


@app.post("/ingest/chunk")
async def ingest_chunk(request: Request) -> dict:
    sid = request.headers.get("X-Session-ID", "")
    if not sid:
        raise HTTPException(400, "X-Session-ID header required")
    d = _session_dir(sid)
    raw_path = os.path.join(d, "raw.d1rw")
    if not os.path.isdir(d):
        raise HTTPException(404, f"session {sid} not found — call /ingest/start first")
    chunk = await request.body()
    if not chunk:
        return {"ok": True, "appended": 0}

    # Offset-addressed append. The client re-sends from its last acknowledged offset whenever it
    # didn't see our response — including when we DID write the bytes and only the response was
    # lost — so a blind append duplicates them. .d1raw is fixed-width interleaved rows, so a single
    # duplicated chunk misaligns every row after it and silently corrupts the whole backup.
    # Overlap is the NORMAL retry shape, not an error: the client's re-read starts at the old
    # offset but runs to the current end of file, so it legitimately carries both bytes we already
    # have and bytes we don't. Skip the prefix we already hold and append only the genuinely new
    # tail — that makes the write idempotent under arbitrary retries.
    # Older clients send no X-Offset; fall back to the legacy blind append so they keep working.
    size = os.path.getsize(raw_path) if os.path.isfile(raw_path) else 0
    raw_offset = request.headers.get("X-Offset")
    if raw_offset is not None:
        try:
            offset = int(raw_offset)
        except ValueError:
            raise HTTPException(400, f"invalid X-Offset: {raw_offset!r}")
        if offset < 0:
            raise HTTPException(400, f"invalid X-Offset: {offset}")
        if offset > size:
            # A gap means bytes were lost in transit; appending here would leave a hole and
            # misalign everything after it. Refuse — the client still holds the authoritative copy.
            raise HTTPException(
                409,
                f"offset {offset} is beyond current size {size} — refusing to leave a gap",
            )
        already_have = size - offset
        if already_have >= len(chunk):
            return {"ok": True, "appended": 0, "duplicate": True, "size": size}
        chunk = chunk[already_have:]
    with open(raw_path, "ab") as f:
        f.write(chunk)
    # Update timestamp in meta
    meta_path = os.path.join(d, "meta.json")
    try:
        with open(meta_path) as f:
            meta = json.load(f)
        meta["updated_at"] = time.time()
        meta["chunks_received"] = meta.get("chunks_received", 0) + 1
        _write_meta(d, meta)
    except (OSError, ValueError):
        pass
    return {"ok": True, "appended": len(chunk)}


@app.post("/ingest/finish")
async def ingest_finish(request: Request) -> dict:
    body = await request.json()
    sid = body.get("session_id", "")
    if not sid:
        raise HTTPException(400, "session_id required")
    d = _session_dir(sid)
    meta_path = os.path.join(d, "meta.json")
    if not os.path.isdir(d):
        raise HTTPException(404, f"session {sid} not found")
    try:
        with open(meta_path) as f:
            meta = json.load(f)
        # A late finish must not resurrect a tombstone into a healthy-looking "complete".
        if meta.get("state") != "deleted":
            meta["state"] = "complete"
        meta["finished_at"] = time.time()
        meta["updated_at"] = time.time()
        _write_meta(d, meta)
    except (OSError, ValueError):
        pass
    return {"ok": True, "session_id": sid}


# ---- Session listing / download ----
@app.get("/sessions")
async def list_sessions() -> dict:
    sessions = []
    if os.path.isdir(STORAGE):
        for name in sorted(os.listdir(STORAGE), reverse=True):
            d = os.path.join(STORAGE, name)
            if not os.path.isdir(d):
                continue
            info = _session_info(name)
            if info:
                sessions.append(info)
    return {"sessions": sessions, "retention_hours": RETENTION_HOURS}


@app.get("/sessions/{sid}/info")
async def session_info(sid: str) -> dict:
    _session_dir(sid)  # same id validation as every other /sessions/{sid} route
    info = _session_info(sid)
    if not info:
        raise HTTPException(404, "session not found")
    return info


@app.get("/sessions/{sid}/raw")
async def session_raw(sid: str) -> FileResponse:
    d = _session_dir(sid)
    raw = os.path.join(d, "raw.d1rw")
    if not os.path.isfile(raw):
        raise HTTPException(404, "raw file not found")
    return FileResponse(
        raw, media_type="application/octet-stream", filename=f"{sid}.d1raw"
    )


@app.post("/sessions/{sid}/mark-deleted")
async def session_mark_deleted(sid: str) -> dict:
    """The recorder deleted (or discarded) its local copy of this session.

    The backup is deliberately NOT removed here: a local delete is exactly the kind of mistake this
    server exists to undo. It becomes a tombstone instead — state "deleted" plus deleted_at — and
    updated_at is reset so the ordinary purge sweep removes it one full retention period from now.
    Clients use the state to stop labelling a deleted capture as a healthy "complete" backup.
    """
    d = _session_dir(sid)
    if not os.path.isdir(d):
        raise HTTPException(404, "session not found")
    # No meta at all: a bare tombstone loses nothing.
    meta = _read_meta_or_409(d, sid) or {"session_id": sid}
    # Idempotent: a repeat (a retry, or a delete followed by a discard) must not restart the
    # retention clock, or a tombstone could be kept alive forever by repeated calls.
    if meta.get("state") == "deleted":
        base = meta.get("updated_at") or _mtime(d) or time.time()
        return {"ok": True, "session_id": sid, "expires_at": _expires_at(base)}
    now = time.time()
    # Keep what the stream reached, so a restore can still say whether the copy was complete.
    meta["state_before_delete"] = meta.get("state", "unknown")
    meta["state"] = "deleted"
    meta["deleted_at"] = now
    meta["updated_at"] = now
    _write_meta(d, meta)
    return {"ok": True, "session_id": sid, "expires_at": _expires_at(now)}


@app.post("/sessions/{sid}/unmark-deleted")
async def session_unmark_deleted(sid: str) -> dict:
    """The recorder restored this session from the backup, so it is no longer a deleted capture.

    Undoes mark-deleted: state goes back to what the stream had reached (state_before_delete) and
    the deleted markers are dropped. updated_at is left exactly as it is, so the retention clock
    runs as it does for any other session and a restore can't extend a backup's life. Idempotent:
    a session that is not tombstoned is left as it is.
    """
    d = _session_dir(sid)
    if not os.path.isdir(d):
        raise HTTPException(404, "session not found")
    meta = _read_meta_or_409(d, sid)
    if meta is None or meta.get("state") != "deleted":
        return {"ok": True, "session_id": sid, "unmarked": False}
    meta["state"] = meta.pop("state_before_delete", None) or "unknown"
    meta.pop("deleted_at", None)
    _write_meta(d, meta)
    return {"ok": True, "session_id": sid, "unmarked": True, "state": meta["state"]}


@app.delete("/sessions/{sid}")
async def session_delete(sid: str) -> dict:
    d = _session_dir(sid)
    if not os.path.isdir(d):
        raise HTTPException(404, "session not found")
    shutil.rmtree(d)
    return {"deleted": True, "session_id": sid}
