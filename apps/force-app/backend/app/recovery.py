"""Recovery of incomplete recordings after a crash, power failure, or forced shutdown.

Scans the captures directory for session directories that have a raw.d1raw file but were never
finalized (no summary.json). Re-runs finalize() to produce the .mat, live_cache.bin, and
summary.json from the crash-safe raw file (which is valid up to the last fsync point).
"""

from __future__ import annotations

import json
import os
import shutil
import time

from .config import RecordConfig
from .d1rw import HEADER_SIZE, read_header
from .finalize import finalize
from .storage import atomic_write_json

MANIFEST = "manifest.json"

# Session ids currently being deleted by discard_session, running in a background thread. A large
# raw.d1raw can take a while to unlink — scan_incomplete excludes these so a still-deleting session
# doesn't reappear in the recovery list and invite a second, overlapping discard of the same dir.
_discarding: set[str] = set()


def write_manifest(
    capture_dir: str, state: str, cfg: RecordConfig | None = None, error: str | None = None
) -> None:
    data: dict = {
        "state": state,
        "updated_at": time.time(),
        "updated_iso": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if cfg is not None:
        data["config"] = cfg.model_dump()
    if error is not None:
        data["error"] = error
    atomic_write_json(os.path.join(capture_dir, MANIFEST), data, fsync=True, indent=2)


def _raw_info(capture_dir: str) -> dict | None:
    raw_path = os.path.join(capture_dir, "raw.d1raw")
    if not os.path.isfile(raw_path):
        return None
    try:
        hdr = read_header(raw_path)
    except (ValueError, OSError):
        return None
    body_bytes = os.path.getsize(raw_path) - HEADER_SIZE
    n_cols = hdr["n_cols"]
    row_bytes = n_cols * 4
    n_rows = body_bytes // row_bytes if row_bytes > 0 else 0
    duration_sec = n_rows / hdr["rate"] if hdr["rate"] > 0 else 0.0
    return {
        "n_rows": n_rows,
        "n_cols": n_cols,
        "rate": hdr["rate"],
        "start_unix": hdr["start_unix"],
        "duration_sec": round(duration_sec, 2),
        "raw_size_mb": round(os.path.getsize(raw_path) / 1e6, 2),
        # Guarded like n_rows above: a header that parses but reports n_cols == 0 would otherwise
        # raise ZeroDivisionError here, 500-ing /recovery/check and hiding every OTHER recoverable
        # session in the scan.
        "truncated_bytes": body_bytes % row_bytes if row_bytes > 0 else body_bytes,
    }


def scan_incomplete(captures_root: str, exclude_id: str | None = None) -> list[dict]:
    """Return a list of session dirs that look like crashed/incomplete recordings.

    `exclude_id` must be the CURRENTLY ACTIVE recording session's id, if any. Having no
    summary.json is not on its own evidence of a crash — a session still genuinely recording looks
    identical on disk (raw.d1raw present and growing, summary.json not written yet, because it
    hasn't finished). Without this exclusion, an in-progress recording could be listed here and
    offered for discard; discarding it then runs shutil.rmtree on a directory whose raw.d1raw is
    still open by the live acquisition thread, which fails with PermissionError on Windows — in a
    background task the client never learns about, while the real recording keeps running,
    untouched, underneath (#29). Caller (main.py) is the one that knows the live session id.
    """
    incomplete = []
    if not os.path.isdir(captures_root):
        return incomplete
    for name in sorted(os.listdir(captures_root), reverse=True):
        if name == exclude_id:
            continue
        d = os.path.join(captures_root, name)
        if not os.path.isdir(d):
            continue
        summary_path = os.path.join(d, "summary.json")
        manifest_path = os.path.join(d, MANIFEST)
        raw_path = os.path.join(d, "raw.d1raw")

        if os.path.isfile(summary_path):
            continue
        if not os.path.isfile(raw_path):
            continue
        if name in _discarding:
            continue
        if name == exclude_id:
            continue

        info = _raw_info(d)
        if info is None or info["n_rows"] == 0:
            continue

        manifest = None
        if os.path.isfile(manifest_path):
            try:
                with open(manifest_path) as f:
                    manifest = json.load(f)
            except (OSError, ValueError):
                pass

        incomplete.append(
            {
                "id": name,
                "dir": d,
                "raw": info,
                "manifest": manifest,
                "started_iso": time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(info["start_unix"])
                ),
            }
        )
    return incomplete


def is_safe_id(session_id: str) -> bool:
    """A bare directory name: no separators or parent references that could escape the root."""
    return not ("/" in session_id or "\\" in session_id or ".." in session_id)


def recover_session(captures_root: str, session_id: str) -> dict:
    """Re-run finalize on a crashed session's raw file."""
    if not is_safe_id(session_id):
        raise ValueError("invalid session id")
    capture_dir = os.path.join(captures_root, session_id)
    raw_path = os.path.join(capture_dir, "raw.d1raw")
    if not os.path.isfile(raw_path):
        raise FileNotFoundError(f"no raw file for session {session_id}")
    if os.path.isfile(os.path.join(capture_dir, "summary.json")):
        raise ValueError(f"session {session_id} is already finalized")

    manifest_path = os.path.join(capture_dir, MANIFEST)
    cfg_dict = {}
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path) as f:
                m = json.load(f)
                cfg_dict = m.get("config", {})
        except (OSError, ValueError):
            pass

    hdr = read_header(raw_path)
    cfg_dict.setdefault("sample_rate", hdr["rate"])
    cfg_dict.setdefault("sample_name", f"RECOVERED-{session_id}")
    cfg = RecordConfig(**{k: v for k, v in cfg_dict.items() if v is not None})

    summary = finalize(capture_dir, cfg)

    write_manifest(capture_dir, "recovered")
    return summary


def discard_session(captures_root: str, session_id: str) -> None:
    """Delete an incomplete session directory. Idempotent: a session already gone (e.g. a prior
    discard finished after the client gave up waiting on it) is treated as success, not an error —
    otherwise a retried/duplicate request would surface a confusing 404 for a discard that actually
    already worked."""
    if not is_safe_id(session_id):
        raise ValueError("invalid session id")
    capture_dir = os.path.join(captures_root, session_id)
    if not os.path.isdir(capture_dir):
        return
    if os.path.isfile(os.path.join(capture_dir, "summary.json")):
        raise ValueError(f"session {session_id} is finalized — use delete instead")
    shutil.rmtree(capture_dir)
