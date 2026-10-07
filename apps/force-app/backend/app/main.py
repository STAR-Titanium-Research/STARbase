"""FastAPI app for the local recording backend (slice 2a).

Single-session model (one acquisition rig per host): /record/start creates a session, /record/stop
finalizes it, WS /record/stream broadcasts D1LF live frames, and /captures/* serves the finished
artifacts (so the plotting UI can render the just-recorded live_cache.bin). CORS mirrors the
filter-service so the standalone SPA can reach it from its own origin.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os

# aliased: `platform` is also a form field name on /support/report-bug (the renderer's UA string)
import platform as platform_mod
import re
import shutil
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from logging.handlers import RotatingFileHandler
from typing import Any
from urllib.parse import urlparse

import numpy as np
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ValidationError
from starlette.concurrency import run_in_threadpool

from . import backup as backup_mod
from . import (
    bug_report,
    nidaq_catalog,
    nidaq_enum,
    origin_guard,
    recovery,
    storage,
    virtual_channels,
)
from . import channels as chan
from .config import DEFAULT_NIDAQ_CHANNELS, RecordConfig
from .d1lc import read_d1lc_header
from .dsp import welch_spectra
from .labamp import LabAmpClient, LabAmpError, MockLabAmp
from .labamp_autorange import converge_ranges, effective_bits, recommend_ranges
from .session import RecordingSession
from .sources.nidaq import nidaq_available
from .sources.replay import ReplaySource
from .sources.sim import SimSource
from .stream.broadcast import Broadcaster


def _user_state_dir() -> str:
    """Per-user directory for this app's own state (settings, logs).

    Must be writable AT RUNTIME, which rules out anything package-relative: under PyInstaller
    `__file__` resolves inside the frozen bundle, and the default NSIS install location is Program
    Files, where a standard user cannot write.
    """
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "force-app")
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return os.path.join(xdg, "force-app")


# Settings this backend owns. Deliberately NOT under CAPTURES_ROOT: these have to survive the user
# repointing the recording drive, and storage_config.json in particular is what remembers which
# drive that is.
CONFIG_DIR = os.environ.get("FORCE_APP_CONFIG_DIR") or _user_state_dir()
STORAGE_CONFIG_PATH = os.path.join(CONFIG_DIR, "storage_config.json")

# Where these settings lived before they moved out of the package. Read-only fallback, so an
# existing install keeps its configured drive; the next successful save rewrites to the new
# location. Writing here was silently failing in a packaged install — POST /storage/config
# swallowed the OSError, so choosing a drive appeared to work and then reverted on restart.
LEGACY_CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "captures")
LEGACY_STORAGE_CONFIG_PATH = os.path.join(LEGACY_CONFIG_DIR, "storage_config.json")


def _load_json(path: str, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _read_json(path: str) -> dict | None:
    data = _load_json(path, None)
    return data if isinstance(data, dict) else None


def _save_json(path: str, data) -> None:
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        storage.atomic_write_json(path, data, indent=2)
    except OSError:
        pass


# Device settings this backend owns, beside storage_config.json (see _migrate_device_configs).
LABAMP_CONFIG_PATH = os.path.join(CONFIG_DIR, "labamp.json")
NIDAQ_SIM_PATH = os.path.join(CONFIG_DIR, "nidaq_sim.json")
NIDAQ_CHANNELS_PATH = os.path.join(CONFIG_DIR, "nidaq_channels.json")


def _migrate_device_configs() -> None:
    """One-time, at startup: copy the device config files into CONFIG_DIR from where they used to be.

    labamp.json, nidaq_sim.json and nidaq_channels.json used to live in CAPTURES_ROOT, so moving
    the recording folder (or a restart after the folder picker, #101) made them vanish and the
    channel assignment silently re-autoassigned. They now live beside backup_config.json. A file
    is copied only when the new location has none (an unreadable new file counts as present and is
    never overwritten), from the captures root the app STARTED with, then LEGACY_CONFIG_DIR. Old
    files are never moved or deleted. Runs once, not on every read, so a stale file in a folder
    the operator picks later is never adopted.
    """
    for new in (LABAMP_CONFIG_PATH, NIDAQ_SIM_PATH, NIDAQ_CHANNELS_PATH):
        name = os.path.basename(new)
        if os.path.exists(new):
            continue
        for old_dir in (CAPTURES_ROOT, LEGACY_CONFIG_DIR):
            old = os.path.join(old_dir, name)
            if os.path.abspath(old) == os.path.abspath(new):
                continue
            legacy = _load_json(old, None)
            if legacy is not None:
                _save_json(new, legacy)
                break


def _load_captures_root() -> str:
    """Load the user-configured captures directory, falling back to the default.

    The default must not be package-relative. In an installed build that resolves inside the
    application directory, and an update REPLACES that directory — so a user who never picked a
    drive in Settings would silently lose every recording the first time the app auto-updated.
    Recordings are the one thing in this system that cannot be regenerated.

    FORCE_APP_CAPTURES still overrides, and Settings > General is the normal way to put captures on
    a real data drive — this is only the fallback for a fresh install that has not chosen yet.
    """
    default = os.environ.get("FORCE_APP_CAPTURES", os.path.join(_user_state_dir(), "captures"))
    for candidate in (STORAGE_CONFIG_PATH, LEGACY_STORAGE_CONFIG_PATH):
        cfg = _read_json(candidate)
        if not cfg:
            continue
        path = cfg.get("captures_root")
        if not path:
            continue
        # Accept a drive that is present now, or whose parent is — a removable/network drive that
        # is merely offline should not silently reset the setting to the package default.
        if os.path.isdir(path) or os.path.isdir(os.path.dirname(path)):
            return path
    return default


CAPTURES_ROOT = _load_captures_root()
os.makedirs(CAPTURES_ROOT, exist_ok=True)


# The desktop app spawns this as a hidden sidecar process (stdio piped, window hidden) and only
# keeps a short in-memory tail of stderr for crash reports — so without a log file, there is no way
# to see what the backend actually did during a slow stop/finalize/discard once the app is closed.
#
# The directory must be one that is WRITABLE AT RUNTIME, which rules out anything package-relative:
# under PyInstaller, `__file__` resolves inside the frozen bundle (the app package lives in the PYZ
# archive, so `<install>/resources/backend/_internal/app/main.py` is a virtual path), and the
# default NSIS install location is Program Files, where a standard user cannot write. Since
# RotatingFileHandler opens its file eagerly at construction, putting the log there would raise
# PermissionError at import and take the whole backend down on startup.
#
# Order: an explicit FORCE_APP_LOG_DIR (the Electron sidecar passes its own userData path) > the
# per-user state dir for the platform. Deliberately NOT CAPTURES_ROOT, which can point at a
# removable or network drive — the log should survive the recording drive being swapped.
def _default_log_dir() -> str:
    return os.environ.get("FORCE_APP_LOG_DIR") or os.path.join(_user_state_dir(), "logs")


LOG_DIR = _default_log_dir()
LOG_PATH = os.path.join(LOG_DIR, "backend.log")
_handlers: list[logging.Handler] = [logging.StreamHandler()]
try:
    os.makedirs(LOG_DIR, exist_ok=True)
    _file_handler = RotatingFileHandler(
        LOG_PATH, maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    # #45: the in-app log viewer's timestamp column claims to be UTC, but Formatter.converter
    # defaults to localtime -- an operator's machine-local time was being shown unlabeled.
    # Instance-scoped (not the logging.Formatter class default) so only this file's log lines are
    # affected, not the console handler above.
    _file_formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    _file_formatter.converter = time.gmtime
    _file_handler.setFormatter(_file_formatter)
    _handlers.append(_file_handler)
except OSError:
    # Read-only or otherwise unwritable location — degrade to stderr-only. Logging is diagnostic;
    # never let it be the reason the recorder won't start.
    LOG_PATH = ""
logging.basicConfig(level=logging.INFO, handlers=_handlers)
log = logging.getLogger("force_app.main")
if not LOG_PATH:
    log.warning("log file unavailable (%s not writable) — logging to stderr only", LOG_DIR)

# Runtime-adjustable verbosity. Previously the level was fixed at import time, so reproducing an
# intermittent bug meant restarting with an env var set and hoping it happened again — this lets
# an operator turn on DEBUG from Settings > Logs while the problem is actually occurring.
# Scoped to the "force_app" logger tree, not the root logger: the root's handlers still see
# everything propagated up to them regardless, but setting the *level* on root would also lower
# the threshold for uvicorn/httpx/asyncio/etc, flooding the log with third-party DEBUG noise that
# has nothing to do with the bug being chased.
_app_logger = logging.getLogger("force_app")
_app_logger.setLevel(
    logging.INFO
)  # explicit, not inherited NOTSET — GET /logs/level needs a real value

# Pin the backup settings next to storage_config.json rather than inside the captures root. Both
# have to survive the user changing the recording drive — a config stored on the drive it configures
# disappears the moment that drive is swapped, which for backup meant it silently turned itself off.
backup_mod.BACKUP_CONFIG_PATH = os.path.join(CONFIG_DIR, "backup_config.json")
# Same read-only fallback as the storage config, for installs that wrote it to the old location.
backup_mod.LEGACY_BACKUP_CONFIG_PATH = os.path.join(LEGACY_CONFIG_DIR, "backup_config.json")

_broadcaster: Broadcaster | None = None
_session: RecordingSession | None = None


# Suggested live-backup endpoint. The backup server runs as a compose service on the lab server and
# is reached through Caddy's /backup-ingest route rather than on its own published port, so it
# inherits that single TLS, tailnet-only entry point (see infra/caddy/Caddyfile). A direct
# host:8210 URL still works for a hand-run server — nothing here requires this exact form.
DEFAULT_BACKUP_URL = "https://d1-server.tail54eeb6.ts.net/backup-ingest"

# ---- LabAmp (2c) config + instance ----
# The amp is link-local (reachable only from the acquisition PC) so the backend owns the HTTP
# conversation. Defaults to a mock (no hardware here); switch mode=real on the rig.
_migrate_device_configs()  # before the config below is read; CAPTURES_ROOT is still the initial one


def _load_labamp_config() -> dict:
    cfg = {
        "base_url": os.environ.get("LABAMP_URL", "http://169.254.143.59"),
        "channels": int(os.environ.get("LABAMP_CHANNELS", "8")),
        "mode": os.environ.get("LABAMP_MODE", "mock"),  # "mock" | "real"
        "autorange_headroom": float(os.environ.get("LABAMP_AUTORANGE_HEADROOM", "1.5")),
        # We digitise the amp's ANALOG OUTPUT with the NI-DAQ, so the auto-range resolution/bits use
        # the NI-DAQ ADC bit depth + the analog full-scale voltage (set these for your rig).
        "nidaq_bits": int(os.environ.get("NIDAQ_BITS", "16")),
        # The amp's analog-output DAC is limited to 12-bit without the recording licence — this is
        # the bottleneck of the chain (effective bits = min(dac, nidaq)).
        "labamp_dac_bits": int(os.environ.get("LABAMP_DAC_BITS", "12")),
        "analog_fullscale_v": float(os.environ.get("ANALOG_FULLSCALE_V", "10.0")),
    }
    stored = _load_json(LABAMP_CONFIG_PATH, None)
    cfg.update(stored if isinstance(stored, dict) else {})
    return cfg


_labamp_cfg = _load_labamp_config()
_labamp = None  # type: ignore[assignment]

_DEFAULT_ANALOG_FULLSCALE_V = 10.0


def _valid_fullscale_v(v: object) -> bool:
    """A usable analog full-scale voltage: a real number (not a bool), finite and above zero."""
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def _analog_fullscale_v() -> float:
    """The Lab Amp's analog full scale in volts. A stored value that is not a positive finite
    number (a hand-edited labamp.json, or one saved before PUT validated it) falls back to the
    default with a warning rather than failing every NI-DAQ start and /labamp/* call."""
    v = _labamp_cfg.get("analog_fullscale_v", _DEFAULT_ANALOG_FULLSCALE_V)
    if isinstance(v, str):  # an older hand-edited "5.0" still worked through float()
        try:
            v = float(v)
        except ValueError:
            pass
    if _valid_fullscale_v(v):
        return float(v)
    log.warning(
        "labamp config analog_fullscale_v=%r is not a positive finite number; using %s V",
        v,
        _DEFAULT_ANALOG_FULLSCALE_V,
    )
    return _DEFAULT_ANALOG_FULLSCALE_V


def _rebuild_labamp() -> None:
    global _labamp
    _labamp = (
        MockLabAmp(_labamp_cfg["base_url"])
        if _labamp_cfg.get("mode") == "mock"
        else LabAmpClient(_labamp_cfg["base_url"])
    )


def _probe_amp_mode(base_url: str, timeout: float = 3.0) -> str | None:
    """A real protocol call (get_operation_mode), bounded to a short timeout of its own —
    independent of `_labamp`'s default 10s. Shared by health_doctor() and the bug-report
    diagnostics probe, both of which need to ask "does the amp actually answer" without risking a
    10s stall on the exact request most likely to be filed while the amp is unreachable."""
    return LabAmpClient(base_url, timeout=timeout).get_operation_mode()


_rebuild_labamp()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _broadcaster
    _broadcaster = Broadcaster(asyncio.get_running_loop())

    # Pre-warm the nidaqmx import (can take hundreds of ms the first time) in the background so it's
    # not paid as start-latency on the first NI-DAQ recording after a backend restart.
    def _warm_nidaq():
        try:
            from .sources.nidaq import nidaq_available

            nidaq_available()
        except Exception:
            pass

    asyncio.get_running_loop().run_in_executor(None, _warm_nidaq)
    yield
    # Graceful shutdown: stop any active recording so the raw file is properly closed and finalized.
    # finalize() now runs in its own background thread (see session.py) so normal /record/stop calls
    # return quickly — but here, where the process may be killed right after, we must wait for it to
    # actually finish writing the .mat/live_cache/summary before letting that thread die with them.
    if _busy():
        try:
            _session.stop(wait=True, timeout=15.0)
            _session.join_finalize(timeout=30.0)
        except Exception:
            pass


app = FastAPI(title="force-app-recorder", lifespan=lifespan)

_cors = [
    o.strip()
    for o in os.environ.get(
        "RECORDER_CORS_ORIGINS", "http://localhost:5180,http://localhost:5181"
    ).split(",")
    if o.strip()
]
if _cors:
    app.add_middleware(
        CORSMiddleware, allow_origins=_cors, allow_methods=["*"], allow_headers=["*"]
    )

# The API has no auth; loopback binding is its only protection, and a web page the operator visits
# can still reach it from their browser (no-cors POSTs, the WebSocket handshake, DNS rebinding).
# Added AFTER CORS so it is the outermost layer and runs first. See origin_guard.py.
_origin_guard = origin_guard.OriginGuardSettings(
    origins=_cors,
    extra_hosts=os.environ.get("RECORDER_ALLOWED_HOSTS", "").split(","),
)
app.add_middleware(origin_guard.OriginGuard, settings=_origin_guard)


@app.exception_handler(LabAmpError)
async def _labamp_error(_request: Request, e: LabAmpError) -> JSONResponse:
    # The amp answered badly or not at all: a bad gateway, not a fault in this server. Endpoints
    # that want a different status (e.g. set_mode's 400) still catch it themselves.
    return JSONResponse({"detail": str(e)}, status_code=502)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "state": _session.state if _session else "idle"}


# ---- Logs ----
# The desktop app runs this backend as a hidden sidecar and keeps only a 4KB stderr tail for crash
# reports, so the log file is the only durable record of what it did. Serve it so the operator can
# read it from Settings > Logs without hunting through AppData — the crash dialog has always said
# "See logs for details" with no such surface behind it.
_LOG_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) +"
    r"(?P<level>[A-Z]+) +(?P<logger>[\w.]+): (?P<message>.*)$"
)
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
# How far back a filtered query looks. The rotating set holds ~8MB, so this is comfortably the
# whole history while still bounding the work for a pathological file.
LOG_SCAN_CAP = 50_000


def _read_log_tail(limit: int) -> list[str]:
    """Last `limit` physical lines across the rotating set, oldest first.

    RotatingFileHandler splits history over backend.log plus .1/.2/.3, with the HIGHEST suffix
    being the OLDEST, so reading just backend.log silently truncates history to the last 2MB.
    Walk newest to oldest and stop as soon as `limit` lines are in hand.
    """
    if not LOG_PATH:
        return []
    chunks: list[list[str]] = []
    have = 0
    for p in [LOG_PATH] + [f"{LOG_PATH}.{i}" for i in range(1, 4)]:
        if not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                chunk = f.read().splitlines()
        except OSError:
            continue
        chunks.append(chunk)
        have += len(chunk)
        if have >= limit:
            break
    lines = [line for chunk in reversed(chunks) for line in chunk]
    return lines[-limit:]


def _parse_log_lines(raw: list[str]) -> list[dict]:
    """Structure what matches the formatter; keep the rest as continuation of the previous record.

    Tracebacks and any third-party output that doesn't follow our format would otherwise be
    dropped — which is exactly the content someone opens a log viewer to read.
    """
    out: list[dict] = []
    for line in raw:
        m = _LOG_LINE_RE.match(line)
        if m:
            out.append(
                {
                    "ts": m.group("ts"),
                    "level": m.group("level"),
                    "logger": m.group("logger"),
                    "message": m.group("message"),
                }
            )
        elif out:
            out[-1]["message"] += "\n" + line
        elif line.strip():
            out.append({"ts": "", "level": "INFO", "logger": "", "message": line})
    return out


@app.get("/logs")
async def get_logs(limit: int = 500, level: str = "", q: str = "") -> dict:
    """Recent backend log records, oldest first.

    `level` filters to that severity and above; `q` is a case-insensitive substring match over the
    logger name and message.
    """
    limit = max(1, min(limit, 5000))
    lvl_or_q = bool(level.strip()) or bool(q.strip())
    # Filter across the whole retained history, then take the tail — not the other way round.
    # Truncating first meant "show me errors" searched only the most recent `limit` lines and
    # reported "no matching entries" while the errors sat further back in the rotated files,
    # which is precisely when someone is looking for them. SCAN_CAP bounds the work when a filter
    # is active; without a filter the tail is all that is ever needed.
    scan = LOG_SCAN_CAP if lvl_or_q else limit
    raw = await run_in_threadpool(_read_log_tail, scan)
    records = _parse_log_lines(raw)

    lvl = level.strip().upper()
    if lvl in LOG_LEVELS:
        keep = set(LOG_LEVELS[LOG_LEVELS.index(lvl) :])
        records = [r for r in records if r["level"] in keep]
    needle = q.strip().lower()
    if needle:
        records = [
            r for r in records if needle in r["message"].lower() or needle in r["logger"].lower()
        ]

    truncated = len(records) > limit
    records = records[-limit:]
    return {
        "path": LOG_PATH,
        "available": bool(LOG_PATH),
        "truncated": truncated,
        "loggers": sorted({r["logger"] for r in records if r["logger"]}),
        "records": records,
    }


@app.get("/logs/download")
async def download_logs() -> FileResponse:
    if not LOG_PATH or not os.path.isfile(LOG_PATH):
        raise HTTPException(404, "no log file — the backend is logging to stderr only")
    return FileResponse(LOG_PATH, media_type="text/plain", filename="force-app-backend.log")


@app.get("/logs/level")
async def get_log_level() -> dict:
    return {"level": logging.getLevelName(_app_logger.level), "levels": LOG_LEVELS}


@app.post("/logs/level")
async def set_log_level(level: str = Form(...)) -> dict:
    """Raise or lower verbosity without a restart — reverts to INFO next launch since it's not
    persisted, which is intentional: DEBUG left on by accident would otherwise slowly fill the
    rotating log with noise on every future run."""
    lvl = level.strip().upper()
    if lvl not in LOG_LEVELS:
        raise HTTPException(400, f"level must be one of {LOG_LEVELS}")
    _app_logger.setLevel(lvl)
    log.info("log level changed to %s", lvl)
    return {"level": lvl}


# A frontend crash otherwise vanishes into the DevTools console the moment the window closes —
# folding it into the same log file the backend already writes means one place to look, and one
# support-bug-report attachment covers both sides of the app.
_client_log = logging.getLogger("force_app.client")
_last_client_error: dict[str, float] = {}
_CLIENT_LOG_DEDUP_SECONDS = 30.0
# Renderer-supplied text ends up in a plaintext log file that gets tailed/viewed raw (including as
# a bug-report attachment) — strip ANSI escapes and other control chars so it can't manipulate a
# terminal viewer, keeping ordinary newlines/tabs since real stack traces rely on them.
_CONTROL_CHARS_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _strip_control_chars(s: str) -> str:
    return _CONTROL_CHARS_RE.sub("", s)


@app.post("/logs/client")
async def post_client_log(payload: dict) -> dict:
    message = _strip_control_chars(str(payload.get("message", "")).strip()[:4000])
    if not message:
        raise HTTPException(400, "message is required")
    level = str(payload.get("level", "ERROR")).strip().upper()
    if level not in LOG_LEVELS:
        level = "ERROR"
    source = _strip_control_chars(str(payload.get("source", "renderer"))[:80])
    route = _strip_control_chars(str(payload.get("route", ""))[:200])

    # A crash loop (e.g. a render error on every frame) would otherwise fill the rotating log and
    # push out everything else within seconds — dedup identical messages per source+route.
    key = f"{source}:{route}:{message[:200]}"
    now = time.monotonic()
    last = _last_client_error.get(key)
    _last_client_error[key] = now
    # Sweep stale entries opportunistically rather than let the dict grow for the life of the
    # process — a wide variety of distinct client error messages over a long-running session would
    # otherwise never be evicted.
    if len(_last_client_error) > 500:
        cutoff = now - _CLIENT_LOG_DEDUP_SECONDS
        for stale_key, ts in list(_last_client_error.items()):
            if ts < cutoff:
                del _last_client_error[stale_key]
    if last is not None and now - last < _CLIENT_LOG_DEDUP_SECONDS:
        return {"ok": True, "deduped": True}

    _client_log.log(getattr(logging, level), "[%s @ %s] %s", source, route or "?", message)
    return {"ok": True, "deduped": False}


# ---- Bug reporting ----
@app.get("/support/report-bug")
async def report_bug_status() -> dict:
    return {"configured": bug_report.configured()}


@app.get("/support/report-bug/issues")
async def report_bug_issues() -> dict:
    return await bug_report.list_issues()


def _diag_lines() -> list[str]:
    """Machine state worth having on every bug report, gathered best-effort.

    Every probe is individually guarded: a report filed BECAUSE the amp or the DAQ is misbehaving
    is exactly the one where these calls are most likely to throw, and losing the whole report to
    a failing probe would be perverse. A probe that fails records why, which is itself a clue.
    """
    out: list[str] = []

    def probe(label: str, fn) -> None:
        try:
            out.append(f"{label}: {fn()}")
        except Exception as e:  # noqa: BLE001 — a diagnostic must never break the report
            out.append(f"{label}: <unavailable: {e.__class__.__name__}: {e}>")

    probe("python", lambda: sys.version.split()[0])
    probe("os", lambda: f"{platform_mod.system()} {platform_mod.release()}")
    probe("captures_root", lambda: CAPTURES_ROOT)
    probe("disk_free_gb", lambda: round(shutil.disk_usage(CAPTURES_ROOT).free / 1e9, 2))
    probe("recorder_state", lambda: (_session.status() if _session else {"state": "idle"})["state"])
    # The env var AND the resolved client, because they can disagree: the mode is read once at
    # startup, so an operator who changed LABAMP_MODE without restarting sees the old client. That
    # exact mismatch (a packaged install silently talking to a MOCK amp) is what this line is for.
    probe("labamp_mode_env", lambda: os.environ.get("LABAMP_MODE", "<unset, defaults to mock>"))

    def _amp_diag() -> str:
        if isinstance(_labamp, MockLabAmp):
            return f"mock=True mode={_labamp.get_operation_mode()}"
        # A short, BOUNDED timeout, not the shared `_labamp` client's default 10s — this probe is
        # exactly the one most likely to run while the amp is unreachable (an operator filing a
        # report because the amp is misbehaving), and a report-bug request stalling for up to 10s
        # extra on that account is its own small failure. See _probe_amp_mode.
        base_url = _labamp_cfg.get("base_url", "")
        return f"mock=False base_url={base_url} mode={_probe_amp_mode(base_url)}"

    probe("labamp", _amp_diag)
    probe("log_level", lambda: logging.getLevelName(logging.getLogger("force_app").level))

    def _daq() -> str:
        if not nidaq_available():
            return "NI-DAQmx runtime not available on this host"
        cat = _devices()
        chassis = cat.get("chassis") or []
        mods = [f"{c.get('name')}({len(c.get('modules') or [])} modules)" for c in chassis]
        return f"simulated={cat.get('simulated')} chassis=[{', '.join(mods)}]"

    probe("nidaq", _daq)
    probe(
        "channels",
        lambda: ", ".join(f"{c['name']}->{c['physical']}" for c in _channel_config()),
    )
    return out


@app.post("/support/report-bug")
async def report_bug(
    title: str = Form(...),
    description: str = Form(""),
    app_version: str = Form(""),
    platform: str = Form(""),
    route: str = Form(""),
    reporter_email: str = Form(""),
    include_logs: bool = Form(True),
    console_tail: str = Form(""),
    kind: str = Form("bug"),
    # Repeated form field, one per area (#95). A single value — what older clients send — parses
    # as a one-item list; bug_report.normalize_areas filters, de-duplicates and caps it.
    area: list[str] = Form(["general"]),
) -> dict:
    log_tail = ""
    diagnostics = ""
    # The UI only SENDS console_tail when this checkbox is on — enforce that here too, not just in
    # the client, so the "declining logs also declines the console" guarantee the checkbox promises
    # holds regardless of what actually arrives in the request (a modified or future client
    # included).
    console_tail = _strip_control_chars(console_tail) if include_logs else ""
    if include_logs:
        # 2000 lines, not 400: at the rate this backend logs during a recording, 400 lines can be
        # under a minute of history, so the failure being reported has often already scrolled out
        # of the attachment by the time someone gets round to filing.
        raw = await run_in_threadpool(_read_log_tail, 2000)
        log_tail = "\n".join(raw)
        diagnostics = "\n".join(await run_in_threadpool(_diag_lines))
    result = await bug_report.create_issue(
        title=title,
        description=description,
        app_version=app_version,
        platform=platform,
        route=route,
        reporter_email=reporter_email,
        log_tail=log_tail,
        diagnostics=diagnostics,
        console_tail=console_tail,
        kind=kind,
        area=area,
    )
    if not result["ok"]:
        log.warning("bug report failed: %s", result.get("reason"))
    else:
        log.info("bug report filed: %s", result.get("url"))
    return result


# ---- Storage management ----
@app.get("/storage/drives")
async def storage_drives() -> dict:
    drives = await run_in_threadpool(storage.list_drives)
    current = storage.disk_usage_for(CAPTURES_ROOT)
    return {"drives": drives, "current": {**current, "captures_root": CAPTURES_ROOT}}


@app.get("/storage/config")
async def storage_get_config() -> dict:
    current = storage.disk_usage_for(CAPTURES_ROOT)
    return {"captures_root": CAPTURES_ROOT, **current}


def _refuse_folder_switch_if_busy() -> None:
    """409 while anything is reading or writing a capture directory under the current root.

    A recording splits across two folders if the root moves under it (#101). A restore, recovery
    or discard is the same hazard: restore downloads raw.d1raw into the old root, then recovers
    from the new one, finds no raw file, and its cleanup deletes the download.
    """
    if _busy():
        raise HTTPException(
            409,
            "a recording is in progress or still being saved — change the folder once it finishes",
        )
    if recovery.any_in_flight():
        raise HTTPException(
            409,
            "a restore, recovery or discard is in progress — change the folder once it finishes",
        )


def _refuse_if_capture_busy(capture_id: str) -> None:
    """409 while a recover, restore or discard owns this capture directory.

    Removing or rewriting the directory from under any of them is what makes them fail half-way,
    and two recovers of one id would finalize the same directory twice."""
    if recovery.in_flight(capture_id):
        raise HTTPException(
            409,
            f"{capture_id} is being recovered, restored or discarded right now — "
            "wait for it to finish",
        )


@contextmanager
def _claim_capture(capture_id: str) -> Iterator[None]:
    """`recovery.recovering` as an HTTP 409 when another job already owns the id.

    Enter it before the first `await` after the busy check: the check and the claim must be one
    synchronous step, or two requests for the same capture both pass it."""
    try:
        with recovery.recovering(capture_id):
            yield
    except recovery.CaptureBusyError:
        raise HTTPException(
            409,
            f"{capture_id} is being recovered, restored or discarded right now — "
            "wait for it to finish",
        ) from None


@app.post("/storage/config")
async def storage_set_config(body: dict) -> dict:
    global CAPTURES_ROOT
    path = str(body.get("captures_root", "")).strip()
    if not path:
        raise HTTPException(400, "captures_root required")
    if ".." in path:
        raise HTTPException(400, "path traversal not allowed")
    # A relative path would resolve against wherever the backend happens to run from (inside the
    # install directory for a packaged build), which no operator means to choose.
    if not os.path.isabs(path):
        raise HTTPException(400, f"choose a full folder path, not {path!r}")
    # #101: the in-flight session writes raw.d1raw and finalizes into CAPTURES_ROOT/<id>, and the
    # renderer then reads that capture back by id through the same root — moving the root under
    # it splits a recording across two folders and 404s the end-of-cut fetch of live_cache.bin.
    _refuse_folder_switch_if_busy()
    # makedirs succeeds on a folder that already exists however read-only it is, so the first sign
    # of a bad choice used to be a recording that failed to start. Find out now instead. Both steps
    # can block for a long time on a dead network path, so they run off the event loop.
    problem = await run_in_threadpool(storage.prepare_folder, path)
    if problem:
        raise HTTPException(400, problem)
    # A recording, restore, recovery or discard may have started while the folder was checked.
    _refuse_folder_switch_if_busy()
    CAPTURES_ROOT = path
    # Persisting is what makes the choice survive a restart, so a failure here must be reported.
    # It used to be swallowed: the drive change applied to the running process, the UI showed
    # "saved", and the setting quietly reverted on the next launch. The directory creation was
    # outside the guard too, so an unwritable config dir 500'd instead of degrading.
    persisted, warning = True, None
    try:
        os.makedirs(os.path.dirname(STORAGE_CONFIG_PATH), exist_ok=True)
        storage.atomic_write_json(STORAGE_CONFIG_PATH, {"captures_root": path})
    except OSError as e:
        persisted = False
        warning = (
            f"Recording to {path} for now, but the choice could not be saved to "
            f"{STORAGE_CONFIG_PATH} ({e}), so it will revert when the app restarts."
        )
        log.warning("storage_set_config: could not persist captures_root: %s", e)
    current = storage.disk_usage_for(CAPTURES_ROOT)
    return {"captures_root": CAPTURES_ROOT, "persisted": persisted, "warning": warning, **current}


# ---- Connectivity check ----
@app.get("/health/check")
async def health_check() -> dict:
    """Test connectivity to Internet, VPN-accessible services, equipment, and database."""
    import asyncio

    async def probe(label: str, url: str, timeout: float = 4.0) -> dict:
        import urllib.error
        import urllib.request

        def _do():
            try:
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return {"label": label, "url": url, "ok": r.status < 500, "status": r.status}
            except urllib.error.URLError as e:
                return {"label": label, "url": url, "ok": False, "error": str(e.reason)}
            except Exception as e:
                return {"label": label, "url": url, "ok": False, "error": str(type(e).__name__)}

        return await run_in_threadpool(_do)

    checks = [probe("Internet", "https://www.google.com/generate_204", 5.0)]

    # Database (Directus)
    directus_url = os.environ.get("DIRECTUS_URL", "")
    if directus_url:
        checks.append(probe("Database", f"{directus_url}/server/ping", 5.0))

    # Equipment: LabAmp
    amp_url = _labamp_cfg.get("base_url", "")
    if amp_url:
        checks.append(probe("LabAmp", f"{amp_url}/", 3.0))

    # Backup server
    bcfg = backup_mod.load_config(CAPTURES_ROOT)
    backup_url = bcfg.get("server_url", "")
    if backup_url:
        checks.append(probe("Backup server", f"{backup_url}/health", 5.0))

    # Disk space
    disk = storage.disk_usage_for(CAPTURES_ROOT)

    results = await asyncio.gather(*checks, return_exceptions=True)
    probes = []
    for r in results:
        if isinstance(r, Exception):
            probes.append({"label": "?", "ok": False, "error": str(r)})
        else:
            probes.append(r)

    return {"probes": probes, "disk": disk}


@app.api_route("/health/doctor", methods=["GET", "POST"])
async def health_doctor(request: Request) -> dict:
    """Deep diagnostic: check each service, diagnose failures, suggest fixes."""
    import socket
    import subprocess

    body: dict = {}
    if request.method == "POST":
        try:
            body = await request.json()
        except Exception:
            body = {}
    findings: list[dict] = []

    # Both of these block for up to their timeout, and the doctor runs ~6 port probes plus several
    # DNS lookups per call — left on the event loop that's several seconds of a frozen backend
    # (frame broadcast, /record/stop) every time someone opens the Connectivity pane. Threadpooled
    # like _http_probe below already is.
    async def _check_port(host: str, port: int, timeout: float = 3.0) -> bool:
        def _do() -> bool:
            try:
                with socket.create_connection((host, port), timeout=timeout):
                    return True
            except (OSError, TimeoutError):
                return False

        return await run_in_threadpool(_do)

    def _find_process(name_pattern: str) -> list[dict]:
        try:
            out = subprocess.check_output(
                ["tasklist", "/FI", f"IMAGENAME eq {name_pattern}", "/FO", "CSV", "/NH"],
                text=True,
                timeout=5,
                creationflags=0x08000000,
            )
            procs = []
            for line in out.strip().splitlines():
                parts = line.strip('"').split('","')
                if len(parts) >= 2 and parts[0].lower() != "info:":
                    procs.append({"name": parts[0], "pid": parts[1]})
            return procs
        except Exception:
            return []

    async def _http_probe(label: str, url: str, timeout: float = 4.0) -> dict:
        import urllib.error
        import urllib.request

        def _do():
            try:
                req = urllib.request.Request(url, method="GET")
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return {"label": label, "url": url, "ok": r.status < 500, "status": r.status}
            except urllib.error.HTTPError as e:
                return {
                    "label": label,
                    "url": url,
                    "ok": False,
                    "status": e.code,
                    "error": f"HTTP {e.code}",
                }
            except Exception as e:
                return {"label": label, "url": url, "ok": False, "error": str(type(e).__name__)}

        return await run_in_threadpool(_do)

    async def _resolve_host(hostname: str) -> str | None:
        def _do() -> str | None:
            try:
                return socket.gethostbyname(hostname)
            except socket.gaierror:
                return None

        return await run_in_threadpool(_do)

    # 1. Recorder backend (self — always ok since we're serving this request)
    findings.append(
        {
            "service": "Recorder backend",
            "status": "ok",
            "message": "Running (serving this request)",
        }
    )

    async def _check_internet(findings: list[dict]) -> None:
        # 2. Internet
        internet_ok = await _check_port("www.google.com", 443, 4.0)
        if internet_ok:
            findings.append({"service": "Internet", "status": "ok", "message": "Connected"})
        else:
            findings.append(
                {
                    "service": "Internet",
                    "status": "fail",
                    "message": "No internet connectivity",
                    "diagnosis": "Cannot reach www.google.com:443. Check network cable, Wi-Fi, or VPN.",
                    "fix": None,
                }
            )

    async def _check_directus(findings: list[dict]) -> None:
        # 3. Directus / database. The backend process itself never talks to Directus — sample lookup
        # and upload happen entirely in the browser, using the frontend's own resolved config (build-time
        # VITE_DIRECTUS_URL, /config.json, or a Settings > Connectivity override) — so DIRECTUS_URL is normally
        # unset in this process's environment even on a fully working setup. Prefer the URL the frontend
        # actually uses (passed in the request body, same pattern as filter_url/octree_url below); only
        # fall back to the backend's own env var for setups that still rely on it.
        directus_url = body.get("directus_url") or os.environ.get("DIRECTUS_URL", "")
        if body.get("directus_url"):
            # Client-supplied, and the probe below resolves and connects to it: same SSRF guard as
            # the filter/octree URLs. (The env var is operator-controlled, so not checked.)
            try:
                _validate_outbound_url(str(body["directus_url"]), "Directus URL")
            except HTTPException as e:
                findings.append(
                    {
                        "service": "Directus",
                        "status": "fail",
                        "message": str(e.detail),
                        "diagnosis": "The configured Directus URL is invalid or not allowed.",
                        "fix": "Check the Directus URL in Settings > Connectivity.",
                    }
                )
                return
        if directus_url:
            parsed = urlparse(directus_url)
            host = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            resolved = await _resolve_host(host)
            port_ok = await _check_port(host, port) if resolved else False
            if port_ok:
                findings.append(
                    {
                        "service": "Directus",
                        "status": "ok",
                        "message": f"Reachable at {directus_url}",
                    }
                )
            elif not resolved:
                findings.append(
                    {
                        "service": "Directus",
                        "status": "fail",
                        "message": f"DNS lookup failed for {host}",
                        "diagnosis": f"Cannot resolve hostname '{host}'. If using Tailscale, ensure it is connected. Check DIRECTUS_URL env var.",
                        "fix": "Connect to Tailscale or verify the hostname is correct.",
                    }
                )
            else:
                findings.append(
                    {
                        "service": "Directus",
                        "status": "fail",
                        "message": f"Host {host} resolved ({resolved}) but port {port} refused",
                        "diagnosis": "The server is reachable but Directus is not listening on the expected port.",
                        "fix": f"Verify Directus is running on {host}:{port}.",
                    }
                )
        else:
            findings.append(
                {
                    "service": "Directus",
                    "status": "warn",
                    "message": "DIRECTUS_URL not configured",
                    "diagnosis": "No DIRECTUS_URL environment variable set. Database features (sample lookup, upload) are disabled.",
                    "fix": "Set the environment variable before starting the backend, then restart:",
                    "fix_command": '$env:DIRECTUS_URL = "https://d1-server.tail54eeb6.ts.net"; python -m uvicorn app.main:app --host 127.0.0.1 --port 8200',
                }
            )

    async def _check_labamp(findings: list[dict]) -> None:
        # 4. LabAmp — a real protocol call (get_operation_mode), not just an open TCP socket. A bare
        # port probe passes for anything answering on that IP:port at all, including a stray device on
        # a link-local address that isn't the amp; it never confirms the thing on the other end actually
        # IS a LabAmp. LabAmpClient.get_operation_mode() is the same call ping() makes internally, and
        # raises LabAmpError with a specific reason (unreachable / bad HTTP / non-JSON / device-level
        # error), so a device that accepts the connection but doesn't speak the protocol is now
        # distinguishable from one that's genuinely off the network.
        amp_url = _labamp_cfg.get("base_url", "")
        amp_mode = _labamp_cfg.get("mode", "mock")
        if amp_mode == "mock":
            findings.append(
                {"service": "LabAmp", "status": "ok", "message": "Mock mode (no hardware)"}
            )
        elif amp_url:
            host = urlparse(amp_url).hostname or ""
            is_link_local = host.startswith("169.254.")

            try:
                mode = await run_in_threadpool(_probe_amp_mode, amp_url)
                findings.append(
                    {
                        "service": "LabAmp",
                        "status": "ok",
                        "message": f"Responding at {amp_url} (mode: {mode or 'unknown'})",
                    }
                )
            except LabAmpError as e:
                findings.append(
                    {
                        "service": "LabAmp",
                        "status": "fail",
                        "message": f"Not responding at {amp_url}",
                        "diagnosis": (
                            f"{e} "
                            + (
                                "This is a link-local address — ensure the Ethernet cable is connected directly to the amp and the NIC has a 169.254.x.x address."
                                if is_link_local
                                else "Check that the amplifier is powered on and the network config is correct."
                            )
                        ),
                        "fix": "Power-cycle the LabAmp, check the Ethernet cable, or verify the IP address in labamp.json.",
                    }
                )

    async def _check_nidaq(findings: list[dict]) -> None:
        # 5. NI-DAQ runtime — checked proactively so a missing driver is visible before the operator
        # tries to record, not discovered as a 503 from POST /record/start. The first check imports
        # the nidaqmx DLL, which can take seconds: off the event loop, so the other probes proceed.
        if await run_in_threadpool(nidaq_available):
            findings.append(
                {"service": "NI-DAQ runtime", "status": "ok", "message": "NI-DAQmx driver detected"}
            )

            # 5b. NI-DAQ hardware — the driver being installed says nothing about a chassis actually
            # being plugged in, powered, and enumerable: that's exactly the "software present, hardware
            # absent" gap this finding closes. _devices() (the same enumeration the NI-DAQ config page
            # uses) falls back to a SIMULATED layout whenever no real chassis answers, which is the
            # signal to use — nidaq_available() alone reports "ok" in that state. Only checked once the
            # driver is confirmed present: without it, enumeration always falls back to simulated for
            # the same underlying reason already reported above, and a second finding would just repeat
            # it under a different name.
            devices = await run_in_threadpool(_devices)
            chassis = devices.get("chassis") or []
            standalone = devices.get("standalone") or []
            if devices.get("simulated"):
                findings.append(
                    {
                        "service": "NI-DAQ hardware",
                        "status": "warn",
                        "message": "No chassis responded — using the simulated NI-DAQ layout",
                        "diagnosis": "The driver is installed, but no cDAQ chassis answered, so the "
                        "app fell back to a simulated device layout (fine for a dev machine; if this "
                        "IS the acquisition PC, the chassis is not actually reachable).",
                        "fix": "Power on the cDAQ chassis and check its USB/Ethernet connection, "
                        "confirm it appears in NI MAX, then re-run the doctor.",
                    }
                )
            elif not chassis and not standalone:
                findings.append(
                    {
                        "service": "NI-DAQ hardware",
                        "status": "warn",
                        "message": "Driver detected but no devices enumerated",
                        "diagnosis": "NI-DAQmx is installed but System.local() returned no devices at "
                        "all — different from the simulated-fallback case above.",
                        "fix": "Check Device Manager and NI MAX for the chassis; reseat the "
                        "USB/Ethernet connection if it is not listed there either.",
                    }
                )
            else:
                names = ", ".join(d.get("name", "?") for d in (*chassis, *standalone))
                findings.append(
                    {
                        "service": "NI-DAQ hardware",
                        "status": "ok",
                        "message": f"{len(chassis) + len(standalone)} device(s) detected: {names}",
                    }
                )
        else:
            findings.append(
                {
                    "service": "NI-DAQ runtime",
                    "status": "warn",
                    "message": "NI-DAQmx runtime not found on this machine",
                    "diagnosis": "Real hardware recording is unavailable. This is expected on a "
                    "non-acquisition machine (sim/replay sources still work); if this IS "
                    "the acquisition PC, the NI-DAQmx driver needs installing.",
                    "fix": "Install the NI-DAQmx runtime from ni.com, then restart the app.",
                }
            )

    async def _check_services(findings: list[dict]) -> None:
        # 6. Filter service & Octree server (URLs passed from frontend)
        for svc_key, svc_label in [
            ("filter_url", "Filter service"),
            ("octree_url", "Octree server"),
        ]:
            svc_url = body.get(svc_key, "")
            if not svc_url:
                continue
            try:
                _validate_outbound_url(svc_url, svc_label)
            except HTTPException as e:
                findings.append(
                    {
                        "service": svc_label,
                        "status": "fail",
                        "message": str(e.detail),
                        "diagnosis": f"The configured {svc_label} URL is invalid or not allowed.",
                        "fix": f"Check the {svc_label} URL in Settings > Connectivity.",
                    }
                )
                continue
            parsed = urlparse(svc_url)
            host = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            resolved = await _resolve_host(host)
            port_ok = await _check_port(host, port, 3.0) if resolved else False
            if port_ok:
                # Port is open — try an HTTP request to verify the service responds
                probe_result = await _http_probe(
                    svc_label, svc_url + ("/health" if "filter" in svc_key else "/"), 4.0
                )
                if probe_result["ok"]:
                    findings.append(
                        {"service": svc_label, "status": "ok", "message": f"Reachable at {svc_url}"}
                    )
                else:
                    status = probe_result.get("status", "")
                    err = probe_result.get("error", "")
                    if status == 404 and "octree" in svc_key:
                        findings.append(
                            {
                                "service": svc_label,
                                "status": "ok",
                                "message": f"Server running at {svc_url}",
                            }
                        )
                    else:
                        findings.append(
                            {
                                "service": svc_label,
                                "status": "warn",
                                "message": f"Port open but service returned {err or f'HTTP {status}'}",
                                "diagnosis": f"Something is listening on {host}:{port} but the {svc_label.lower()} endpoint did not respond as expected.",
                            }
                        )
            elif not resolved:
                findings.append(
                    {
                        "service": svc_label,
                        "status": "fail",
                        "message": f"DNS lookup failed for {host}",
                        "diagnosis": f"Cannot resolve hostname '{host}'.",
                        "fix": f"Check the {svc_label} URL in Settings > Connectivity.",
                    }
                )
            else:
                is_caddy = host in ("localhost", "127.0.0.1") and port == 80
                findings.append(
                    {
                        "service": svc_label,
                        "status": "fail",
                        "message": f"Cannot reach {host}:{port}",
                        "diagnosis": (
                            f"Nothing is listening on port {port}. "
                            + (
                                "The local web server (Caddy) may not be running."
                                if is_caddy
                                else f"Check that the service is running on {host}."
                            )
                        ),
                        "fix": "Start the local web server (Caddy) that serves filter and octree endpoints."
                        if is_caddy
                        else f"Start the {svc_label.lower()} or fix the URL in Settings > Connectivity.",
                        "fix_command": "caddy run --config Caddyfile" if is_caddy else None,
                    }
                )

    async def _check_backup(findings: list[dict]) -> None:
        # 7. Backup server
        bcfg = backup_mod.load_config(CAPTURES_ROOT)
        backup_url = bcfg.get("server_url", "")
        if backup_url:
            parsed = urlparse(backup_url)
            host = parsed.hostname or ""
            # Behind Caddy the recommended URL is https with no explicit port, so defaulting to 80
            # probed the wrong port and reported the container as down when it was fine. Matches the
            # Directus and filter-service checks above.
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            resolved = await _resolve_host(host)
            port_ok = await _check_port(host, port, 4.0) if resolved else False
            if port_ok:
                findings.append(
                    {
                        "service": "Backup server",
                        "status": "ok",
                        "message": f"Reachable at {backup_url}",
                    }
                )
            elif not resolved:
                is_tailscale = ".ts.net" in host
                findings.append(
                    {
                        "service": "Backup server",
                        "status": "fail",
                        "message": f"DNS lookup failed for {host}",
                        "diagnosis": (
                            f"Cannot resolve '{host}'. "
                            + (
                                "This is a Tailscale hostname — ensure Tailscale is running and connected."
                                if is_tailscale
                                else "Check that the hostname is correct."
                            )
                        ),
                        "fix": "Connect to Tailscale or correct the backup server URL in Settings > Live Backup.",
                    }
                )
            else:
                # Host resolves but port is closed — maybe the server process isn't running. It is
                # deployed as a compose service behind Caddy's /backup-ingest route, so the fix is to
                # bring that service up on the server host, not to hand-run uvicorn (which was the old
                # advice, from before the service was deployable at all).
                findings.append(
                    {
                        "service": "Backup server",
                        "status": "fail",
                        "message": f"Host {host} resolved ({resolved}) but port {port} refused",
                        "diagnosis": f"The backup server host is reachable but nothing is listening on port {port}. The backup-server container may not be running.",
                        "fix": "Start the backup-server service on the server host (it is part of the main docker compose stack).",
                        "fix_command": "docker compose up -d backup-server proxy",
                    }
                )
        elif bcfg.get("enabled"):
            findings.append(
                {
                    "service": "Backup server",
                    "status": "fail",
                    "message": "Backup enabled but no server URL configured",
                    "diagnosis": "Live backup is enabled in settings but the server URL is empty.",
                    "fix": f"Set the backup server URL in Settings > Live Backup (e.g. {DEFAULT_BACKUP_URL}).",
                }
            )
        else:
            findings.append(
                {
                    "service": "Backup server",
                    "status": "info",
                    "message": "Not configured — enable in Settings > Live Backup to stream recordings to a remote server",
                }
            )

    # The probes above are independent and each bounded by its own timeouts, so run them together:
    # an offline machine now waits for the slowest one rather than the sum of all of them. Each fills
    # its own list, concatenated in declaration order, so findings keep their usual order.
    checks = (
        _check_internet,
        _check_directus,
        _check_labamp,
        _check_nidaq,
        _check_services,
        _check_backup,
    )
    parts: list[list[dict]] = [[] for _ in checks]
    await asyncio.gather(*(check(part) for check, part in zip(checks, parts)))
    for part in parts:
        findings.extend(part)

    # 8. Disk space
    disk = storage.disk_usage_for(CAPTURES_ROOT)
    if disk["free_gb"] is None:
        findings.append(
            {
                "service": "Disk space",
                "status": "warn",
                "message": "Could not read free space on the recording drive",
                "diagnosis": f"Reading disk usage for {CAPTURES_ROOT} failed. The drive may be "
                "disconnected, offline, or a network path that is unreachable.",
                "fix": "Check the recording drive is connected, then set it again in Settings > General.",
            }
        )
    elif disk["free_gb"] < 5:
        findings.append(
            {
                "service": "Disk space",
                "status": "fail",
                "message": f"Only {disk['free_gb']:.1f} GB free on recording drive",
                "diagnosis": "Critically low disk space. Recordings will likely fail.",
                "fix": "Free up space or change the recording drive in Settings > General.",
            }
        )
    elif disk["free_gb"] < 20:
        findings.append(
            {
                "service": "Disk space",
                "status": "warn",
                "message": f"{disk['free_gb']:.1f} GB free — running low",
                "diagnosis": "Disk space is limited. Long recordings at high sample rates may fill the drive.",
                "fix": "Consider freeing space or switching to a drive with more capacity.",
            }
        )
    else:
        findings.append(
            {"service": "Disk space", "status": "ok", "message": f"{disk['free_gb']:.1f} GB free"}
        )

    # 9. Incomplete recordings
    incomplete = recovery.scan_incomplete(CAPTURES_ROOT, exclude_id=_active_session_id())
    # Where recovery actually lives: Settings > Local Captures lists every incomplete capture with
    # Recover and Delete. The old text sent people to "the Record page" in plain prose, whose
    # banner can be hidden per-capture ("Ignore for now") while this check still flags it (#83).
    captures_link = {
        "to": "/settings?tab=captures&focus=incomplete-captures",
        "label": "Open Local Captures",
    }
    if incomplete:
        total_mb = sum(s.get("raw", {}).get("raw_size_mb", 0) for s in incomplete)
        findings.append(
            {
                "service": "Crashed recordings",
                "status": "warn",
                "message": f"{len(incomplete)} incomplete recording(s) found ({total_mb:.0f} MB)",
                "diagnosis": "Previous recordings did not finalize — likely from a crash or forced "
                "shutdown. An interrupted recording usually still holds usable data.",
                "fix": "Recover or delete them one at a time in Settings > Local Captures, or "
                "discard them all (asks first, listing each one).",
                "fixable": "purge_incomplete",
                "fix_label": "Discard all…",
                "link": captures_link,
                # Listed so the confirmation can name exactly what is about to be deleted.
                "items": [
                    {
                        "id": s["id"],
                        "sample_name": ((s.get("manifest") or {}).get("config") or {}).get(
                            "sample_name"
                        ),
                        "raw_size_mb": s["raw"]["raw_size_mb"],
                        "duration_sec": s["raw"]["duration_sec"],
                        "started_iso": s.get("started_iso"),
                    }
                    for s in incomplete
                ],
            }
        )
    # A discard deletes in the background and scan_incomplete hides those ids at once, so right
    # after "Discard all" the check above already reads clean while multi-GB files are still being
    # removed — and the doctor used to declare "All systems healthy" mid-delete (#83). Report the
    # in-flight deletes as their own not-yet-healthy finding until they finish.
    discarding = recovery.discarding_ids()
    if discarding:
        findings.append(
            {
                "service": "Discarding recordings",
                "status": "warn",
                "message": f"Still deleting {len(discarding)} discarded recording(s)…",
                "diagnosis": "Large raw files take a while to delete. Keep the app open until "
                "this finishes.",
                "pending": True,
                "link": captures_link,
            }
        )

    all_ok = all(f["status"] in ("ok", "info") for f in findings)
    return {"healthy": all_ok, "findings": findings, "disk": disk}


# ---- Recovery of crashed recordings ----
@app.get("/recovery/check")
async def recovery_check() -> dict:
    incomplete = await run_in_threadpool(
        recovery.scan_incomplete, CAPTURES_ROOT, _active_session_id()
    )
    return {"incomplete": incomplete}


@app.post("/recovery/recover/{session_id}")
async def recovery_recover(session_id: str) -> dict:
    # Defense in depth against the same race scan_incomplete's exclude_id closes: the client's
    # recovery list is a snapshot from whenever it last polled, so a recording that started (or was
    # still running) between that poll and this click could otherwise slip through.
    if session_id == _active_session_id():
        raise HTTPException(
            400, f"session {session_id} is still recording — nothing to recover yet"
        )
    root = CAPTURES_ROOT  # one root for the whole request, however long it takes
    try:
        # The claim refuses (409) a second recover, a restore or a discard of this id, and there is
        # no await between that check and the claim.
        with _claim_capture(session_id):
            summary = await run_in_threadpool(recovery.recover_session, root, session_id)
    except HTTPException:
        raise
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"recovery failed: {e}")
    return {"recovered": True, "session_id": session_id, "summary": summary}


@app.post("/recovery/discard/{session_id}")
async def recovery_discard(session_id: str) -> dict:
    # A large raw.d1raw can take a long time to unlink — awaiting the full rmtree here (even off the
    # event loop, via run_in_threadpool) made the request itself hang for however long that takes,
    # which read as "discard takes forever" and tempted an operator to force-close the app mid-delete
    # (partial delete, then "failed to fetch" retrying against a backend that may still be shutting
    # down). Kick the delete off in the background and return immediately instead; scan_incomplete
    # excludes _discarding ids so the item just vanishes from the recovery list once it finishes.
    if recovery.in_flight(session_id) == "discarding":
        return {"discarded": True, "session_id": session_id}  # already in flight — idempotent
    # Same race scan_incomplete's exclude_id guards against, at the point of action rather than
    # listing: this is exactly the check that was missing when a live recording got discarded out
    # from under itself — the rmtree hit an open raw.d1raw and failed silently in the background
    # while the recording kept running untouched.
    if not recovery.is_safe_id(session_id):
        raise HTTPException(400, "invalid session id")
    _refuse_if_capture_busy(session_id)
    if session_id == _active_session_id():
        raise HTTPException(
            400, f"session {session_id} is still recording — stop it, don't discard it"
        )
    root = CAPTURES_ROOT  # one root for the check and the background delete
    capture_dir = os.path.join(root, session_id)
    if not os.path.isdir(capture_dir):
        log.info("recovery_discard: id=%s not found", session_id)
        raise HTTPException(404, f"session {session_id} not found")
    if os.path.isfile(os.path.join(capture_dir, "summary.json")):
        log.info("recovery_discard: id=%s is finalized, refusing", session_id)
        raise HTTPException(400, f"session {session_id} is finalized — use delete instead")

    async def _run() -> None:
        t0 = time.perf_counter()
        try:
            await run_in_threadpool(recovery.discard_session, root, session_id)
            await _mark_remote_deleted(session_id)
        except Exception:
            log.exception("recovery_discard: background delete failed for id=%s", session_id)
        finally:
            recovery.release_discard(session_id)
            log.info("recovery_discard: id=%s took %.2fs", session_id, time.perf_counter() - t0)

    # Claimed here, not in the task: the task only starts after this handler returns, and a recover
    # or restore arriving in that gap would otherwise pass its own busy check.
    recovery.claim_discard(session_id)
    asyncio.create_task(_run())
    return {"discarded": True, "session_id": session_id}


# ---- Remote live backup ----
@app.get("/backup/config")
async def backup_get_config() -> dict:
    cfg = backup_mod.load_config(CAPTURES_ROOT)
    # Probe server if configured
    if cfg.get("server_url"):
        probe = await run_in_threadpool(backup_mod.probe_server, cfg["server_url"])
        cfg["server_status"] = probe
    return cfg


@app.post("/backup/config")
async def backup_set_config(body: dict) -> dict:
    # retention_hours is no longer a client setting (#93) — an older UI may still send it, and it
    # is ignored rather than rejected. The server's own value comes back in server_status.
    updates = {k: body[k] for k in ("enabled", "server_url") if k in body}
    if updates.get("server_url"):
        updates["server_url"] = _validate_outbound_url(
            str(updates["server_url"]), "backup server URL"
        )
    cfg = backup_mod.save_config(CAPTURES_ROOT, updates)
    return cfg


@app.get("/backup/status")
async def backup_status() -> dict:
    cfg = backup_mod.load_config(CAPTURES_ROOT)
    result: dict = {"enabled": cfg.get("enabled", False), "server_url": cfg.get("server_url", "")}
    if _session and _session.backup:
        result["active"] = _session.backup.status()
    else:
        result["active"] = None
    return result


def _local_capture_status(cid: str) -> str:
    """What this machine holds for a capture id: finalized | incomplete | recording | missing."""
    if not recovery.is_safe_id(cid):
        return "missing"
    d = os.path.join(CAPTURES_ROOT, cid)
    if not os.path.isdir(d):
        return "missing"
    if os.path.isfile(os.path.join(d, "summary.json")):
        return "finalized"
    return "recording" if cid == _active_session_id() else "incomplete"


def _annotate_remote_session(s: dict, retention_hours: float | None) -> dict:
    """Cross-reference one remote backup against the local captures (#91, and the cross-link half
    of #31).

    The server's raw `state` only says how far the STREAM got ("complete" = /ingest/finish was
    received), which read as "this recording is fine" even for a capture deleted locally long ago.
    `backup_state` says what the copy is, and `local_status` what this machine still has, so the UI
    can say "Fully backed up" / "Backup interrupted (partial)" / "Deleted locally — expires in Xh"
    and refuse a restore that would overwrite a finalized local capture.
    """
    meta = s.get("meta") or {}
    cfg = meta.get("config") or {}
    sid = str(s.get("id", ""))
    raw_state = s.get("state") or meta.get("state") or "unknown"
    local = _local_capture_status(sid)
    if raw_state == "deleted":
        backup_state = "deleted"
    elif raw_state == "complete":
        backup_state = "complete"
    elif raw_state == "streaming":
        # Still "streaming" with no live local recording behind it = the stream was cut off (crash,
        # network loss, app closed) and never finished: a partial copy.
        backup_state = "streaming" if local == "recording" else "interrupted"
    else:
        backup_state = "unknown"
    if local == "missing" and backup_state == "deleted":
        local = "deleted"
    name = cfg.get("sample_name") if isinstance(cfg, dict) else None
    if not name and local == "finalized":
        summary = _read_json(os.path.join(CAPTURES_ROOT, sid, "summary.json")) or {}
        name = summary.get("sample_name")
    expires_at = s.get("expires_at")
    if expires_at is None and retention_hours and meta.get("updated_at"):
        # Older servers don't report it; same rule their purge sweep applies. One session's
        # malformed field must not 500 the whole list, so a non-numeric value is just ignored.
        try:
            expires_at = float(meta["updated_at"]) + float(retention_hours) * 3600
        except (TypeError, ValueError):
            expires_at = None
    if expires_at is not None and not isinstance(expires_at, int | float):
        expires_at = None
    return {
        **s,
        "name": name or None,
        "backup_state": backup_state,
        "local_status": local,
        "expires_at": expires_at,
    }


@app.get("/backup/remote-sessions")
async def backup_remote_sessions() -> dict:
    cfg = backup_mod.load_config(CAPTURES_ROOT)
    url = cfg.get("server_url", "")
    if not url:
        return {"configured": False, "sessions": [], "error": "no backup server configured"}
    try:
        data = await run_in_threadpool(backup_mod.fetch_remote_sessions, url)
    except backup_mod.RemoteBackupError as e:
        # An error, not an empty list: "No remote backups found" for a server that simply could
        # not be asked is a false all-clear (#92).
        raise HTTPException(502, f"could not reach the backup server: {e}")
    retention = data.get("retention_hours")
    sessions = await run_in_threadpool(
        lambda: [_annotate_remote_session(s, retention) for s in data.get("sessions", [])]
    )
    return {"configured": True, "sessions": sessions, "retention_hours": retention}


async def _mark_remote_deleted(cid: str) -> bool | None:
    """Best-effort tombstone of a capture's remote backup after its local copy was deleted (#91).
    None when no backup server is configured at all; never raises."""
    url = backup_mod.load_config(CAPTURES_ROOT).get("server_url", "")
    if not url:
        return None
    return await run_in_threadpool(backup_mod.mark_remote_deleted, url, cid)


async def _unmark_remote_deleted(cid: str, url: str) -> bool:
    """Best-effort: after a successful restore, clear the remote backup's deleted tombstone so the
    list stops mislabelling it and the server stops counting down to purging it. Never raises."""
    return await run_in_threadpool(backup_mod.unmark_remote_deleted, url, cid)


@app.post("/backup/restore/{session_id}")
async def backup_restore(session_id: str) -> dict:
    """Download a raw backup from the remote server and finalize it locally.

    Never destroys local data. The download goes to raw.d1raw.part and only replaces raw.d1raw once
    it is complete and its config checked. A local raw that already holds rows is kept: the restore
    is refused (409), except when the remote copy is strictly larger, in which case the local file
    is set aside as raw.d1raw.local-<timestamp> rather than deleted.
    """
    if not recovery.is_safe_id(session_id):
        raise HTTPException(400, "invalid session id")
    # Read the root once: a folder switch must never split one restore across two folders.
    root = CAPTURES_ROOT
    cfg = backup_mod.load_config(root)
    url = cfg.get("server_url", "")
    if not url:
        raise HTTPException(400, "no backup server configured")
    if session_id == _active_session_id():
        raise HTTPException(409, f"{session_id} is still being recorded — it can't be restored")
    # Claim the id before the first await: checking busy and claiming must be one synchronous step,
    # or a double-click (or a recover/discard racing this) gets past the check twice, both write the
    # same raw.d1raw.part, and the loser's cleanup deletes what the winner just finalized.
    with _claim_capture(session_id):
        return await _restore_claimed(session_id, root, url)


async def _restore_claimed(session_id: str, root: str, url: str) -> dict:
    """The body of backup_restore, run while `session_id` is claimed in recovery._recovering."""
    capture_dir = os.path.join(root, session_id)
    raw_path = os.path.join(capture_dir, "raw.d1raw")
    part_path = raw_path + ".part"
    if os.path.isfile(os.path.join(capture_dir, "summary.json")):
        raise HTTPException(
            409,
            f"{session_id} is already finalized on this machine — restoring would overwrite the "
            "local raw file. Delete or move the local capture first if you really want the remote "
            "copy (Settings > Local Captures).",
        )
    local_info = await run_in_threadpool(recovery.raw_info, capture_dir)
    local_rows = bool(local_info and local_info["n_rows"] > 0)
    # A failed restore used to leave its half-built directory behind: a raw file with no summary,
    # which then showed up as an unnamed "incomplete" capture and in the recovery banner (#82). A
    # directory this request created is removed on failure; one that already existed is not touched
    # beyond the temporary .part file.
    created_dir = not os.path.isdir(capture_dir)
    kept = "" if created_dir else " Your local copy was not changed."

    def _cleanup() -> None:
        try:
            os.remove(part_path)
        except OSError:
            pass
        if created_dir:
            shutil.rmtree(capture_dir, ignore_errors=True)

    def _fail(status: int, detail: str) -> HTTPException:
        _cleanup()
        return HTTPException(status, detail)

    os.makedirs(capture_dir, exist_ok=True)

    # Recover the ORIGINAL config too, not just the bytes. recover_session reads the
    # per-channel dyno_gains out of manifest.json; with no manifest it builds a default
    # RecordConfig whose dyno_gains are empty, so finalize applies the scalar gain=1.0 and the
    # restored .mat/live_cache hold raw amplifier volts mislabelled as newtons — wrong by a
    # per-channel factor, and not obviously wrong when you look at it. Fetched before the
    # download so a missing config doesn't cost a multi-GB transfer first.
    remote_cfg = await run_in_threadpool(backup_mod.fetch_remote_session_config, url, session_id)
    if not remote_cfg:
        raise _fail(
            502,
            "the backup server has no recording config for this session, so the per-channel "
            "gains needed to convert volts to newtons are unknown — refusing to finalize "
            f"with incorrect scaling.{kept} The backup is still on the server.",
        )
    try:
        # Same None-filtering recover_session uses — a null in the stored config would
        # otherwise fail validation against a non-optional field.
        restored_cfg = RecordConfig(**{k: v for k, v in remote_cfg.items() if v is not None})
    except Exception as e:
        raise _fail(
            500,
            f"could not apply the original recording config from the backup ({e}); "
            f"finalizing would silently produce volts instead of newtons.{kept} The "
            "backup is still on the server.",
        )

    try:
        nbytes = await run_in_threadpool(backup_mod.download_remote_raw, url, session_id, part_path)
    except Exception as e:
        raise _fail(502, f"download failed: {e}.{kept} The backup is still on the server.")

    if local_rows:
        local_size = os.path.getsize(raw_path)
        if nbytes <= local_size:
            raise _fail(
                409,
                f"{session_id} already has a local recording with data "
                f"({local_info['n_rows']:,} samples) that is at least as long as the backup "
                "— it was not changed. Recover it from Settings > Local Captures instead.",
            )

    aside: str | None = None

    def _restore_aside() -> None:
        """Put the set-aside local raw back so nothing about the local capture has changed."""
        if aside and os.path.exists(aside):
            try:
                os.replace(aside, raw_path)
            except OSError:
                pass

    # Swap in the download. The local raw (only possible here when the remote is larger) is
    # renamed, never deleted.
    try:
        if local_rows:
            aside = f"{raw_path}.local-{int(time.time())}"
            os.replace(raw_path, aside)
        os.replace(part_path, raw_path)
        # A local recording's own manifest (written at record start) is kept as it is; the
        # remote config only fills in when there is none to keep.
        local_manifest = _read_json(os.path.join(capture_dir, recovery.MANIFEST)) or {}
        if not (local_rows and local_manifest.get("config")):
            await run_in_threadpool(recovery.write_manifest, capture_dir, "restored", restored_cfg)
    except Exception as e:
        _restore_aside()
        raise _fail(500, f"could not put the downloaded backup in place ({e}).{kept}")

    # Finalize the downloaded raw file
    try:
        summary = await run_in_threadpool(recovery.recover_session, root, session_id)
    except Exception as e:
        _restore_aside()
        raise _fail(500, f"finalize failed after download: {e}.{kept}")
    result = {"restored": True, "session_id": session_id, "bytes": nbytes, "summary": summary}
    result["remote_unmarked"] = await _unmark_remote_deleted(session_id, url)
    if aside:
        result["local_copy_kept_as"] = os.path.basename(aside)
    return result


def _busy() -> bool:
    return bool(_session and _session.state in ("recording", "finalizing"))


def _active_session_id() -> str | None:
    """The in-flight session's id, or None. A session mid-recording/finalizing has no summary.json
    yet — indistinguishable on disk from a genuinely crashed one — so recovery must never treat it
    as recoverable/discardable. See scan_incomplete's `exclude_id`."""
    return _session.id if _busy() and _session else None


def sample_rate_problem(rate: float, limits: dict) -> dict | None:
    """A structured 400 detail when `rate` is outside the hardware's {"min", "max"}, else None.

    Structured (not a bare string) so the UI can point at the field itself — `field` names the
    RecordConfig key, and the numbers let it say what to change it to without parsing prose.
    """
    hi, lo = limits.get("max"), limits.get("min")
    if hi is not None and rate > hi:
        bound, side, extreme, action = hi, "above", "maximum", "Lower"
    elif lo is not None and rate < lo:
        bound, side, extreme, action = lo, "below", "minimum", "Raise"
    else:
        return None
    return {
        "field": "sample_rate",
        "value": rate,
        "max": hi,
        "min": lo,
        "message": f"Sample rate {rate:,.0f} Hz is {side} the {bound:,.0f} Hz {extreme} of "
        f"the NI-DAQ modules these channels are on. {action} it and start again.",
    }


@app.post("/record/start")
async def record_start(cfg: RecordConfig) -> dict:
    global _session
    if _busy():
        raise HTTPException(409, "a recording is already in progress")
    if cfg.source == "nidaq":
        from .sources.nidaq import NidaqSource, NidaqUnavailableError, nidaq_available

        if not nidaq_available():
            raise HTTPException(
                503, "NI-DAQmx runtime not available on this host — run on the acquisition PC."
            )
        # The gains below, the live rail detector (session.py) and finalize's clipped flags must all
        # use the SAME analog full scale: the Lab Amp's (settings or ANALOG_FULLSCALE_V), not
        # RecordConfig's 10 V default, or a rig on another range never rails.
        vfs = _analog_fullscale_v()
        cfg.analog_fullscale_v = vfs
        # The NI-DAQ page's channel model is the source of truth for physical channels + per-channel
        # gains. A request may still override with an explicit non-default channel list.
        cc = _channel_config()
        # The persisted config has no separate "kind" field (PUT /nidaq/channels saves a bare
        # channel list), so the rotating-vs-stationary preset has to be recovered from the
        # channels themselves. Without this, a saved rotating-dyno config (Fx/Fy/Fz/Mz, no
        # numbered corners) silently matched nothing in to_record_channels'/dyno_gains' stationary
        # FORCE_ORDER lookup and fell through to DEFAULT_NIDAQ_CHANNELS placeholders with no gains
        # and no error -- exactly the silent-garbage-capture failure mode the DYNO_ROTATING
        # refusal in to_record_channels was built to prevent, just never reached.
        dyno_kind = chan.infer_dyno_kind(cc)
        if not cfg.nidaq_channels or cfg.nidaq_channels == list(DEFAULT_NIDAQ_CHANNELS):
            try:
                cfg.nidaq_channels = chan.to_record_channels(cc, kind=dyno_kind)
            except ValueError as e:
                raise HTTPException(400, str(e))
            cfg.extra_channels = chan.to_extra_channels(cc)
            # Widen the physical list to match: NidaqSource reads one physical channel per
            # HARDWARE-source name in cfg.extra_channels, in this same order (virtual channels need
            # no physical channel at all — they're computed, never acquired).
            cfg.nidaq_channels = cfg.nidaq_channels + [
                c.physical for c in cfg.extra_channels if c.source == "hardware" and c.physical
            ]
        if not cfg.dyno_gains:
            g = chan.dyno_gains(cc, kind=dyno_kind)
            if g:
                cfg.dyno_gains = g
        # #84: check the rate against what the assigned modules can actually do BEFORE creating
        # a session. Otherwise DAQmx rejects it (-200077) inside the acquisition thread, after a
        # capture directory exists, and the operator gets a raw driver message in a dialog that
        # talks about finalizing and recovering a recording that never captured a sample.
        limits = await run_in_threadpool(nidaq_enum.sample_rate_limits, cfg.nidaq_channels)
        problem = sample_rate_problem(cfg.sample_rate, limits)
        if problem:
            raise HTTPException(400, problem)
        try:
            source = NidaqSource(
                cfg, physical_channels=cfg.nidaq_channels or None, extra_channels=cfg.extra_channels
            )
        except (ValueError, NidaqUnavailableError) as e:
            raise HTTPException(400, str(e))
        # Per-channel volts→N gains from the amp's (auto-ranged) ranges: N/V = range / analog_fs.
        if not cfg.dyno_gains:
            try:
                # Blocking LAN round-trip to the amp — off the event loop so it doesn't stall other
                # concurrent requests while this one waits on it.
                rows = sorted(
                    await run_in_threadpool(_labamp.sensor_table, 8), key=lambda x: x["channel"]
                )
                gains = [float(r.get("range") or vfs) / vfs for r in rows][:8]
                if len(gains) == 8:
                    cfg.dyno_gains = gains
            except LabAmpError:
                pass  # amp unreachable — fall back to the scalar gain
    else:
        source = SimSource(cfg, realtime=True)
    # The NI-DAQ branch above awaits (thread pool, amp round-trip): a second POST can pass the
    # first _busy() check while this one is parked there. Re-check with NO await between here and
    # the assignment, so exactly one of two overlapping starts wins and none is orphaned.
    if _busy():
        raise HTTPException(409, "a recording is already in progress")
    _session = RecordingSession(cfg, CAPTURES_ROOT, source, broadcaster=_broadcaster)
    _session.start()
    return _session.status()


@app.post("/record/start_replay")
async def record_start_replay(
    file: UploadFile = File(...),
    sample_name: str = Form("REPLAY"),
    axis: str = Form("Fz"),
    ppr: int = Form(1),
    speed: float = Form(1.0),
    extra_metadata: str = Form("{}"),
) -> dict:
    """Replay a real recorded cut (an uploaded D1LC live_cache.bin) through the live pipeline."""
    global _session
    if _busy():
        raise HTTPException(409, "a recording is already in progress")
    cache_bytes = await file.read()
    try:
        h = read_d1lc_header(cache_bytes)
    except ValueError as e:
        raise HTTPException(422, f"not a D1LC cache: {e}") from e
    try:
        meta = json.loads(extra_metadata) if extra_metadata else {}
    except json.JSONDecodeError:
        meta = {}
    n, fs = h["n"], (h["fs"] or 1000.0)
    # RecordConfig.duration_sec is capped at 600 s because it sizes a SIMULATED run. A replay is
    # sized by the cache itself (ReplaySource streams every sample), so a cut longer than 10 min
    # must not be refused (it used to raise ValidationError -> a bare 500). Validate with the cap,
    # then record the true duration.
    duration = max(0.1, n / fs)
    try:
        cfg = RecordConfig(
            sample_name=sample_name,
            axis=axis if axis in ("Fx", "Fy", "Fz") else "Fz",
            feed=max(1e-6, h["feed"]),
            diam=max(1e-6, h["diam"]),
            sample_rate=fs,
            duration_sec=min(duration, 600.0),
            ppr=max(1, ppr),
            extra_metadata=meta,
        )
    except ValidationError as e:
        raise HTTPException(422, f"cannot replay this cache: {e.errors()[0]['msg']}") from e
    cfg.duration_sec = duration
    try:
        source = ReplaySource(cache_bytes, ppr=cfg.ppr, realtime=True, speed=speed)
    except ValueError as e:  # a body cut off after a valid header: frombuffer can't read N samples
        raise HTTPException(422, f"not a complete D1LC cache: {e}") from e
    # `await file.read()` above yielded to the loop; re-check with no await before assigning.
    if _busy():
        raise HTTPException(409, "a recording is already in progress")
    _session = RecordingSession(cfg, CAPTURES_ROOT, source, broadcaster=_broadcaster)
    _session.start()
    return _session.status()


@app.post("/dsp/spectrum")
async def dsp_spectrum(request: Request, fs: float, names: str, nperseg: int = 4096) -> dict:
    """Welch amplitude spectra for one window of samples. Stateless — no session, no playhead.

    Playback (an archived cut scrubbed in the browser) calls this a few times a second so its
    FFT panel is computed by the SAME scipy path as a live recording's, rather than by a second
    implementation in the frontend that could drift. Body is little-endian float32,
    channel-major, len(names) * n_samples.
    """
    chan_names = [n for n in names.split(",") if n]
    if not chan_names:
        raise HTTPException(422, "names must list at least one channel")
    raw = await request.body()
    # Validate BEFORE np.frombuffer: it raises ValueError on a partial element, which would
    # surface as a 500 rather than the 422 a malformed body deserves.
    if len(raw) % 4:
        raise HTTPException(422, f"body is {len(raw)} bytes, not a whole number of float32s")
    flat = np.frombuffer(raw, dtype="<f4")
    if flat.size % len(chan_names):
        raise HTTPException(
            422, f"body has {flat.size} samples, not a multiple of {len(chan_names)} channels"
        )
    n = flat.size // len(chan_names)
    # float64 is required, not cosmetic: rounding a float32-derived value to 4 decimals still
    # carries float32's imprecise representation into the JSON output (e.g. 0.009800000116229057
    # instead of a clean 0.0098) — test_spectrum_matches_welch_spectra_exactly catches this. The
    # live path (session.py) passes raw float32 too, so this endpoint is the odd one out; that's
    # pre-existing behavior, not something to change here.
    bufs = {name: flat[i * n : (i + 1) * n].astype(np.float64) for i, name in enumerate(chan_names)}
    # Welch is CPU-bound; keep it off the event loop so concurrent requests aren't stalled.
    f, spectra = await run_in_threadpool(welch_spectra, bufs, fs=fs, nperseg=max(1, int(nperseg)))
    return {"fs": fs, "f": f or [], "spectra": spectra}


@app.post("/record/stop")
async def record_stop() -> dict:
    if not _busy():
        raise HTTPException(409, "no recording in progress")
    # finalize() now runs in the background (session.py), so `state` may already be "finalizing"
    # from a prior call — don't re-invoke stop() (source.stop() etc.) in that case, just report it.
    # The client learns of the eventual "done"/summary via the WS control message, not this response.
    t0 = time.perf_counter()
    log.info("record_stop: id=%s state=%s", _session.id, _session.state)
    if _session.state == "recording":
        await run_in_threadpool(_session.stop, True, 60.0)
    log.info(
        "record_stop: acquisition-stop returned in %.2fs (state now %s)",
        time.perf_counter() - t0,
        _session.state,
    )
    return {
        "id": _session.id,
        "state": _session.state,
        "error": _session.error,
        "error_kind": _session.error_kind,
        "summary": _session.summary,
    }


@app.get("/record/status")
async def record_status() -> dict:
    return _session.status() if _session else {"state": "idle"}


def _capture_ids() -> list[str]:
    """Capture directory names, newest first (ids are timestamp-prefixed)."""
    # scandir: the "is it a folder" answer comes with the listing, where os.path.isdir per name was
    # one more round trip per capture on a network drive.
    with os.scandir(CAPTURES_ROOT) as it:
        return sorted((e.name for e in it if e.is_dir()), reverse=True)


@app.get("/captures")
def list_captures() -> dict:
    return {"captures": _capture_ids()}


@app.get("/captures/recent")
def list_recent_captures(limit: int = 20, q: str = "") -> dict:
    """Lightweight summaries of the most recent local captures — used by the Auto Range 'previous
    run' picker, which needs each capture's full per-channel peaks (channels_ranging.peaks_n).
    Directus's machining_force_analysis only stores the 3 summed-axis peaks, not per-channel, so a
    previously-uploaded operation only gets an approximated per-channel split there (see the
    frontend's searchPastOperations) — this endpoint is the source of the EXACT numbers, for
    whatever is still local. Bounded + best-effort per capture so one corrupt/partial summary.json
    can't break the whole list. `q` filters by substring match (case-insensitive) on the capture id
    or sample name; matching scans further back than `limit` so an older match isn't hidden behind
    more-recent-but-non-matching captures."""
    ids = _capture_ids()
    needle = q.strip().lower()
    scan_cap = max(1, min(limit, 100)) if not needle else 200
    out = []
    for cid in ids[:scan_cap]:
        try:
            with open(os.path.join(CAPTURES_ROOT, cid, "summary.json")) as f:
                s = json.load(f)
            ranging = s.get("channels_ranging") or {}
            peaks_n = ranging.get("peaks_n")
            if not peaks_n:
                continue  # older/partial summary.json without per-channel ranging data
            sample_name = s.get("sample_name") or cid
            if needle and needle not in cid.lower() and needle not in sample_name.lower():
                continue
            out.append(
                {
                    "id": cid,
                    "sample_name": sample_name,
                    "duration_sec": s.get("duration_sec"),
                    "peaks_n": peaks_n,
                }
            )
            if len(out) >= max(1, min(limit, 100)):
                break
        except (OSError, ValueError):
            continue
    return {"captures": out}


def _capture_file(cid: str, name: str) -> str:
    # Guard against path traversal: only a bare id + known filename.
    if not recovery.is_safe_id(cid):
        raise HTTPException(400, "bad id")
    path = os.path.join(CAPTURES_ROOT, cid, name)
    if not os.path.isfile(path):
        raise HTTPException(404, "not found")
    return path


# /captures/browse: finalized captures never change except when summary.json is rewritten (a
# metadata edit, atomic rename) or the folder goes away, so their entries are cached keyed by the
# folder's mtime and summary.json's mtime and size. A warm scan then costs two stats per capture
# instead of ~10, which is what makes browsing thousands of captures on a network drive tolerable.
# Incomplete captures are never cached: their recording/discarding/recovering flags are live.
_BROWSE_CACHE: dict[str, tuple[tuple[int, int, int], dict]] = {}
# /captures/browse runs in the threadpool, so two requests can touch the cache at once. Every
# mutation and the prune's snapshot of the keys hold this lock: iterating a dict another thread is
# inserting into raises "dictionary changed size during iteration".
_BROWSE_CACHE_LOCK = threading.Lock()
BROWSE_MAX_LIMIT = 500
_DATE_QUERY = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _capture_entry(cid: str) -> dict:
    """The /captures/browse row for one capture folder."""
    d = os.path.join(CAPTURES_ROOT, cid)
    try:
        dir_ns = os.stat(d).st_mtime_ns
    except OSError:
        dir_ns = 0
    summary_path = os.path.join(d, "summary.json")
    try:
        st = os.stat(summary_path)
        # Size is in the key because file times can be coarse: two writes inside one clock tick
        # would otherwise look identical.
        key: tuple[int, int, int] | None = (dir_ns, st.st_mtime_ns, st.st_size)
    except OSError:
        key = None  # no summary.json: incomplete, so not cacheable
    if key is not None:
        hit = _BROWSE_CACHE.get(d)
        if hit and hit[0] == key:
            return hit[1]
    # #96: where the files are, for the "Show in folder" / copy-path controls.
    entry: dict = {
        "id": cid,
        "dir": os.path.abspath(d),
        "size_mb": 0.0,
        "finalized": False,
        "files": {},
    }
    sizes: dict[str, int] = {}
    for fname in ("raw.d1raw", "capture.mat", "live_cache.bin"):
        try:
            sizes[fname] = os.stat(os.path.join(d, fname)).st_size
        except OSError:
            pass
    if key is not None:
        sizes["summary.json"] = key[2]  # already stat'ed above
    entry["files"] = {k: round(n / 1e6, 2) for k, n in sizes.items()}
    entry["size_mb"] = round(sum(sizes.values()) / 1e6, 2)
    entry["finalized"] = key is not None
    entry["mtime"] = dir_ns / 1e9
    if entry["finalized"]:
        try:
            with open(summary_path) as f:
                s = json.load(f)
            entry["sample_name"] = s.get("sample_name")
            entry["duration_sec"] = s.get("duration_sec")
            entry["n"] = s.get("n")
            entry["peaks"] = s.get("peaks")
            entry["source"] = (s.get("config") or {}).get("source")
        except (OSError, ValueError):
            pass
        if key is not None:
            with _BROWSE_CACHE_LOCK:
                _BROWSE_CACHE[d] = (key, entry)
    else:
        # No summary: the recording crashed or its finalize failed. manifest.json is written at
        # record start with the full config, so the sample name is still known; without this the
        # row could only show the timestamp id (#82).
        cfg = (_read_json(os.path.join(d, recovery.MANIFEST)) or {}).get("config") or {}
        if isinstance(cfg, dict):
            for k in ("sample_name", "source"):
                if cfg.get(k):
                    entry[k] = cfg[k]
        info = recovery.raw_info(d)
        if info:
            entry["duration_sec"] = info["duration_sec"]
            entry["n"] = info["n_rows"]
        # What Recover needs: a raw file with at least one row (scan_incomplete's rule).
        entry["recoverable"] = bool(info and info["n_rows"] > 0)
        entry["recording"] = cid == _active_session_id()
        busy = recovery.in_flight(cid)
        entry["discarding"] = busy == "discarding"
        entry["recovering"] = busy == "recovering"
    return entry


def _prune_browse_cache(live: set[str]) -> None:
    """Drop cached entries of this root whose capture folder is gone."""
    with _BROWSE_CACHE_LOCK:
        for stale in [k for k in _BROWSE_CACHE if k not in live]:
            if os.path.dirname(stale) == CAPTURES_ROOT:
                _BROWSE_CACHE.pop(stale, None)


def _browse_matches(entry: dict, needles: list[str], status: str | None) -> bool:
    if status == "finalized" and not entry["finalized"]:
        return False
    if status == "incomplete" and entry["finalized"]:
        return False
    if not needles:
        return True
    hay = " ".join(str(entry.get(k) or "") for k in ("id", "sample_name", "source")).lower()
    return any(n in hay for n in needles)


@app.get("/captures/browse")
async def browse_captures(
    limit: int = 200,
    offset: int = 0,
    q: str = "",
    status: str | None = Query(None, pattern="^(finalized|incomplete)$"),
    sort: str = Query("date_desc", pattern="^(date_desc|date_asc|size_desc|size_asc)$"),
) -> dict:
    """Local captures with the facts needed to decide what to keep, filtered, sorted and paged.

    Distinct from /captures/recent, which exists for the Auto Range picker and therefore skips
    anything without per-channel ranging data. This one lists everything on disk, finalized or not,
    because its job is disk housekeeping: captures accumulate indefinitely (a "Don't save" leaves
    the raw behind by design) and nothing in the app has ever been able to show or remove them.

    Filtering: `q` is a case-insensitive substring of the id, sample name or source (an ISO date
    such as 2026-10-02 also matches the id's 20261002); `status` is finalized or incomplete. Whether
    a capture was uploaded is a Directus fact the recorder does not have, so the web UI filters on
    that itself. `sort` is date_desc (default), date_asc or size_desc/size_asc; date order is the id
    order (ids are timestamp-prefixed), which costs no per-capture I/O.

    The drive is scanned at most once per request, and only as far as needed: with no q, no status
    and a date sort, only the requested page is read.
    """
    limit = max(1, min(limit, BROWSE_MAX_LIMIT))
    offset = max(0, offset)
    needle = q.strip().lower()
    needles = [needle] if needle else []
    m = _DATE_QUERY.match(needle)
    if m:
        needles.append("".join(m.groups()))

    def _scan() -> dict:
        disk = storage.disk_usage_for(CAPTURES_ROOT)
        base = {"captures_root": CAPTURES_ROOT, "offset": offset, "limit": limit, "disk": disk}
        if not os.path.isdir(CAPTURES_ROOT):
            return {
                **base,
                "captures": [],
                "total": 0,
                "total_all": 0,
                "total_size_mb": 0.0,
                "matching_size_mb": 0.0,
            }
        ids = _capture_ids()  # newest first
        total_all = len(ids)
        needs_all = bool(needles) or status is not None or sort.startswith("size")
        if not needs_all:
            window = ids if sort == "date_desc" else ids[::-1]
            page = [_capture_entry(cid) for cid in window[offset : offset + limit]]
            total, matching_mb = total_all, None
        else:
            _prune_browse_cache({os.path.join(CAPTURES_ROOT, cid) for cid in ids})
            rows = [e for e in map(_capture_entry, ids) if _browse_matches(e, needles, status)]
            if sort.startswith("size"):
                rows.sort(key=lambda e: (e["size_mb"], e["id"]), reverse=sort == "size_desc")
            elif sort == "date_asc":
                rows.reverse()
            total = len(rows)
            matching_mb = round(sum(e["size_mb"] for e in rows), 2)
            page = rows[offset : offset + limit]
        return {
            **base,
            "captures": page,
            "total": total,
            "total_all": total_all,
            "total_size_mb": round(sum(c["size_mb"] for c in page), 2),
            "matching_size_mb": matching_mb,
        }

    return await run_in_threadpool(_scan)


@app.delete("/captures/{cid}")
async def delete_capture(cid: str) -> dict:
    """Permanently delete a capture directory.

    recovery.discard_session deliberately refuses to touch finalized sessions, so there was no way
    to remove a completed capture from inside the app at all — they accumulated on the recording
    drive forever. This is the deliberate counterpart to that guard, not a bypass: it is only ever
    reached from an explicit, confirmed user action, and it refuses to delete the recording that is
    currently in progress.
    """
    if not recovery.is_safe_id(cid):
        raise HTTPException(400, "bad id")
    d = os.path.join(CAPTURES_ROOT, cid)
    if not os.path.isdir(d):
        raise HTTPException(404, "not found")
    if cid == _active_session_id():
        raise HTTPException(409, "that recording is still in progress")
    # A restore/recover is reading or writing this directory right now, and a discard is already
    # deleting it. Removing it from under either one is what makes them fail half-way.
    _refuse_if_capture_busy(cid)
    t0 = time.perf_counter()
    freed = 0
    try:
        for root, _dirs, files in os.walk(d):
            for f in files:
                try:
                    freed += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        await run_in_threadpool(shutil.rmtree, d)
    except OSError as e:
        raise HTTPException(500, f"could not delete: {e}")
    log.info(
        "delete_capture: id=%s freed=%.1fMB in %.2fs", cid, freed / 1e6, time.perf_counter() - t0
    )
    # After the local delete has succeeded, never before: the remote copy is the undo for exactly
    # this action, so it is only relabelled (and left to expire), not removed.
    remote = await _mark_remote_deleted(cid)
    return {
        "deleted": True,
        "id": cid,
        "freed_mb": round(freed / 1e6, 2),
        "remote_marked_deleted": remote,
    }


@app.get("/captures/{cid}/summary")
def capture_summary(cid: str) -> JSONResponse:
    with open(_capture_file(cid, "summary.json")) as f:
        return JSONResponse(json.load(f))


class CaptureMetadataPatch(BaseModel):
    """Editable fields on a finalized capture — for correcting metadata that was missing or wrong
    at record time and only noticed later (a forgotten Sample being the motivating case: without
    one, Upload is unavailable at cut end with no way back in). All fields optional; only the ones
    provided are changed. `rpm`/`feed`/`diam`/`sample_rate` have a direct home on RecordConfig;
    everything else (lookups, machining details, notes) lives in `extra_metadata`, sent as a single
    object that REPLACES the stored one wholesale — the same full-replacement semantics
    `/record/start` already uses (extra_metadata: metaObj()), not a per-key deep merge."""

    sample_name: str | None = None
    rpm: float | None = None
    feed: float | None = None
    diam: float | None = None
    sample_rate: float | None = None
    extra_metadata: dict[str, Any] | None = None


# Serialises summary.json read-modify-writes: this handler runs in the threadpool, so two PATCHes
# for one capture (a double-submit, or two quick edits) would otherwise each apply its change to the
# same stale copy and the later write would drop the earlier edit.
_summary_patch_lock = threading.Lock()


@app.patch("/captures/{cid}/metadata")
def patch_capture_metadata(cid: str, patch: CaptureMetadataPatch) -> dict:
    """Correct a finalized capture's local record after the fact.

    Only summary.json is rewritten — capture.mat and raw.d1raw are archival originals of what was
    actually recorded and are never touched, matching how drift_comp already treats the raw file as
    sacrosanct. For a capture that has already been uploaded to Directus, the frontend PATCHes the
    manufacturing_operations row directly (it already talks to Directus for reads — see
    CapturesSettings.vue's checkUploaded()) in addition to calling this endpoint, so the local
    record and the database row are corrected together rather than one drifting from the other.
    """
    path = _capture_file(cid, "summary.json")
    changed = patch.model_dump(exclude_unset=True)
    with _summary_patch_lock:
        with open(path) as f:
            summary = json.load(f)
        cfg = summary.setdefault("config", {})
        if "sample_name" in changed:
            # Kept in step deliberately: finalize.py stamps both from the same
            # RecordConfig.sample_name at record time, and CapturesSettings.vue's list reads the
            # top-level one.
            summary["sample_name"] = changed["sample_name"]
            cfg["sample_name"] = changed["sample_name"]
        for key in ("rpm", "feed", "diam", "sample_rate"):
            if key in changed:
                cfg[key] = changed[key]
        if "extra_metadata" in changed:
            cfg["extra_metadata"] = changed["extra_metadata"]
            summary["metadata"] = changed["extra_metadata"]  # finalize.py's top-level echo of it
        storage.atomic_write_json(path, summary, indent=2)
    log.info("patch_capture_metadata: id=%s fields=%s", cid, sorted(changed.keys()))
    return summary


@app.get("/captures/{cid}/live_cache.bin")
async def capture_cache(cid: str) -> FileResponse:
    return FileResponse(_capture_file(cid, "live_cache.bin"), media_type="application/octet-stream")


@app.get("/captures/{cid}/capture.mat")
async def capture_mat(cid: str) -> FileResponse:
    return FileResponse(
        _capture_file(cid, "capture.mat"),
        media_type="application/octet-stream",
        filename=f"{cid}.mat",
    )


@app.get("/labamp/status")
async def labamp_status() -> dict:
    amp = _labamp
    reachable = await run_in_threadpool(amp.ping)
    mode = None
    if reachable:
        try:
            mode = await run_in_threadpool(amp.get_operation_mode)
        except LabAmpError:
            pass
    return {
        "reachable": reachable,
        "mode": mode,
        "base_url": amp.base_url,
        "mock": amp.mock,
        "channels": _labamp_cfg["channels"],
        "config_mode": _labamp_cfg["mode"],
    }


_LABAMP_BUSY_MSG = (
    "a recording is in progress -- changing the amp's live hardware state would corrupt it"
)


_NIDAQ_BUSY_MSG = (
    "a recording is in progress -- changing the NI-DAQ configuration or the tacho generator "
    "would corrupt it"
)


def _refuse_nidaq_change_if_busy() -> None:
    """Invariant 3: nothing that touches NI-DAQ state may change mid-recording. The tacho generator
    drives PFI0, the tacho input of the channel being sampled; the channel list and simulated
    chassis are what the next start (and the live source's layout) are built from."""
    if _busy():
        raise HTTPException(409, _NIDAQ_BUSY_MSG)


@app.post("/labamp/mode")
async def labamp_set_mode(body: dict) -> dict:
    # #33: the amp's analog outputs feed straight into the NI-DAQ channels a live recording is
    # sampling -- switching operation mode mid-capture (e.g. MEASURE -> RESET) writes garbage or
    # zeroed voltages directly into the in-progress capture, same class of risk as the autorange
    # endpoints below.
    if _busy():
        raise HTTPException(409, _LABAMP_BUSY_MSG)
    mode = str(body.get("mode", ""))
    try:
        await run_in_threadpool(_labamp.set_operation_mode, mode)
        current = await run_in_threadpool(_labamp.get_operation_mode)
    except LabAmpError as e:
        raise HTTPException(400, str(e))
    return {"mode": current}


@app.get("/labamp/sensors")
async def labamp_sensors() -> dict:
    rows = await run_in_threadpool(_labamp.sensor_table, _labamp_cfg["channels"])
    return {"sensors": rows}


@app.get("/labamp/export")
async def labamp_export() -> JSONResponse:
    return JSONResponse(await run_in_threadpool(_labamp.export_params))


# ---- Auto-range: drive the amp's measuring range from the measured signal ----
def _measure_peaks(amp, channels: int) -> list[float]:
    """Per-channel peak magnitude (N) from the amp's live max/min (run a representative cut)."""
    items = amp.signal_get(list(range(1, channels + 1)))
    by_ch: dict[int, float] = {}
    for it in items:
        ch = int(it.get("channel", 0))
        mx = abs(float((it.get("max") or [0])[0]))
        mn = abs(float((it.get("min") or [0])[0]))
        by_ch[ch] = max(mx, mn)
    return [by_ch.get(i, 0.0) for i in range(1, channels + 1)]


def _current_ranges(amp, channels: int) -> list:
    rows = amp.sensor_table(channels)
    r = {int(x["channel"]): x.get("range") for x in rows}
    return [float(r[i]) if r.get(i) is not None else None for i in range(1, channels + 1)]


def _daq() -> tuple[int, int, int, float]:
    """(nidaq_bits, dac_bits, effective_bits, analog_fullscale_v). Effective = chain bottleneck."""
    nidaq = int(_labamp_cfg.get("nidaq_bits", 16))
    dac = int(_labamp_cfg.get("labamp_dac_bits", 12))
    vfs = _analog_fullscale_v()
    return nidaq, dac, effective_bits(dac, nidaq), vfs


@app.get("/labamp/autorange")
async def labamp_autorange(headroom: float | None = None) -> dict:
    hr = float(headroom) if headroom else float(_labamp_cfg.get("autorange_headroom", 1.5))
    ch = int(_labamp_cfg["channels"])
    nidaq, dac, eff, vfs = _daq()
    peaks = await run_in_threadpool(_measure_peaks, _labamp, ch)
    currents = await run_in_threadpool(_current_ranges, _labamp, ch)
    return {
        "headroom": hr,
        "nidaq_bits": nidaq,
        "dac_bits": dac,
        "effective_bits": eff,
        "fullscale_v": vfs,
        "recommendations": recommend_ranges(
            peaks, currents, headroom=hr, bits=eff, fullscale_v=vfs
        ),
    }


@app.post("/labamp/autorange/apply")
async def labamp_autorange_apply(body: dict) -> dict:
    # #33: this sets the amp to RESET and rewrites per-channel ranges -- only safe in the gap
    # between cuts, never mid-recording (see labamp_autorange_converge's docstring below).
    if _busy():
        raise HTTPException(409, _LABAMP_BUSY_MSG)
    hr = float(body.get("headroom") or _labamp_cfg.get("autorange_headroom", 1.5))
    ch = int(_labamp_cfg["channels"])
    nidaq, dac, eff, vfs = _daq()
    peaks = await run_in_threadpool(_measure_peaks, _labamp, ch)
    currents = await run_in_threadpool(_current_ranges, _labamp, ch)
    recs = recommend_ranges(peaks, currents, headroom=hr, bits=eff, fullscale_v=vfs)
    await run_in_threadpool(_labamp.set_operation_mode, "RESET")
    for r in recs:
        await run_in_threadpool(_labamp.set_range, r["channel"], r["recommended"])
    status = await run_in_threadpool(_labamp.channel_status, ch)
    return {"applied": recs, "status": status}


@app.post("/labamp/autorange/converge")
async def labamp_autorange_converge(body: dict) -> dict:
    """Converging between-cuts auto-range: recommend the NEXT-pass ranges from the LAST cut's
    per-channel peaks (from OUR recording — summary.channels_ranging), not a live amp poll.

    Body: {peaks:[8], clipped?:[8], currents?:[8], headroom?, apply?:bool}. With apply=true the
    recommended ranges are written to the amp (for the RESET window before the next cut)."""
    peaks = [float(x) for x in (body.get("peaks") or [])]
    if not peaks:
        raise HTTPException(400, "peaks required")
    clipped = [bool(x) for x in (body.get("clipped") or [])]
    currents = body.get("currents")
    hr = float(body.get("headroom") or _labamp_cfg.get("autorange_headroom", 1.5))
    nidaq, dac, eff, vfs = _daq()
    recs = converge_ranges(peaks, clipped, currents, headroom=hr, bits=eff, fullscale_v=vfs)
    status: dict[str, str] = {}
    if body.get("apply"):
        # Computing recommendations (above) is a pure read + math, safe anytime -- only writing
        # them to the amp needs the between-cuts guard (#33).
        if _busy():
            raise HTTPException(409, _LABAMP_BUSY_MSG)
        await run_in_threadpool(_labamp.set_operation_mode, "RESET")
        for r in recs:
            await run_in_threadpool(_labamp.set_range, r["channel"], r["recommended"])
        status = await run_in_threadpool(_labamp.channel_status, int(_labamp_cfg["channels"]))
    return {
        "headroom": hr,
        "nidaq_bits": nidaq,
        "dac_bits": dac,
        "effective_bits": eff,
        "fullscale_v": vfs,
        "recommendations": recs,
        "applied": bool(body.get("apply")),
        "status": status,
    }


@app.post("/labamp/sensors/write")
async def labamp_write_sensors(body: dict) -> dict:
    """Write calibration values (sensitivity, range) to the amp for specific channels."""
    if _busy():
        raise HTTPException(409, _LABAMP_BUSY_MSG)
    updates = body.get("updates", [])
    if not updates:
        raise HTTPException(400, "updates required")
    params: dict[str, object] = {}
    for u in updates:
        ch = int(u["channel"])
        if "sensitivity" in u and u["sensitivity"] is not None:
            params[f"/measChannel/{ch}/sensor/type/charge/sensitivity"] = float(u["sensitivity"])
        if "range" in u and u["range"] is not None:
            params[f"/measChannel/{ch}/sensor/type/charge/physicalRange"] = float(u["range"])
    if params:
        await run_in_threadpool(_labamp.set_params, params)
    rows = await run_in_threadpool(_labamp.sensor_table, int(_labamp_cfg["channels"]))
    return {"ok": True, "sensors": rows}


@app.get("/labamp/config")
async def labamp_get_config() -> dict:
    return _labamp_cfg


# Shared by every endpoint that accepts a client-supplied URL the backend itself then fetches from
# or streams to (amp base_url, backup server_url, doctor filter_url/octree_url): the amp/filter/
# octree/backup servers are all legitimately on a link-local/private address, so we can't block
# those ranges (that IS the target) — we can only reject scheme confusion and the cloud-metadata
# address, the one dangerous SSRF target that would otherwise be reachable through any of them. The
# recorder is otherwise a loopback-bound, single-user local hardware controller (bind 127.0.0.1),
# which is the mitigation for the lack of endpoint auth.
_BLOCKED_SSRF_HOSTS = {"169.254.169.254", "metadata.google.internal", "fd00:ec2::254"}


def _validate_outbound_url(url: str, what: str = "URL") -> str:
    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        raise HTTPException(400, f"{what} must use http or https")
    if not u.hostname:
        raise HTTPException(400, f"{what} must include a host")
    if u.hostname.strip("[]").lower() in _BLOCKED_SSRF_HOSTS:
        raise HTTPException(400, f"{what} host is not allowed")
    return url


@app.post("/labamp/config")
async def labamp_post_config(body: dict) -> dict:
    # #33: this rebuilds the module-global _labamp client (_rebuild_labamp() below), replacing
    # the amp connection an in-progress recording's ranging/status calls are using mid-flight.
    if _busy():
        raise HTTPException(409, _LABAMP_BUSY_MSG)
    if "base_url" in body:
        body["base_url"] = _validate_outbound_url(str(body["base_url"]), "amp URL")
    # Validate before persisting anything: a bad value saved here is re-read at every startup and
    # then breaks every /labamp/* call (int(...) of garbage, an unknown mode silently meaning real).
    if "channels" in body:
        ch = body["channels"]
        if isinstance(ch, bool) or not isinstance(ch, int) or not 1 <= ch <= 64:
            raise HTTPException(400, "channels must be an integer from 1 to 64")
    if "mode" in body and body["mode"] not in ("mock", "real"):
        raise HTTPException(400, 'mode must be "mock" or "real"')
    if "analog_fullscale_v" in body and not _valid_fullscale_v(body["analog_fullscale_v"]):
        raise HTTPException(422, "analog_fullscale_v must be a finite number above 0 (volts)")
    for k in (
        "base_url",
        "channels",
        "mode",
        "autorange_headroom",
        "nidaq_bits",
        "labamp_dac_bits",
        "analog_fullscale_v",
    ):
        if k in body:
            _labamp_cfg[k] = body[k]
    _save_json(LABAMP_CONFIG_PATH, _labamp_cfg)
    _rebuild_labamp()
    return _labamp_cfg


# ---- NI-DAQ configuration (channel model + simulated chassis) ----
# On dev machines with no DAQmx runtime the chassis is simulated (editable, persisted); on the rig
# it enumerates real hardware. The channel model (roles + physical bindings) is persisted and, when
# source="nidaq", feeds the recorder's channel list + per-channel gains at record start.


def _sim_layout() -> dict:
    return _load_json(NIDAQ_SIM_PATH, dict(nidaq_enum.DEFAULT_SIM_LAYOUT))


def _devices() -> dict:
    return nidaq_enum.enumerate_devices(sim_layout=_sim_layout())


def _channel_config() -> list[dict]:
    cfg = _load_json(NIDAQ_CHANNELS_PATH, None)
    if isinstance(cfg, dict) and isinstance(cfg.get("channels"), list):
        return cfg["channels"]
    # First run: auto-assign force-first from whatever devices are present.
    channels = chan.autoassign(_devices())
    _save_json(NIDAQ_CHANNELS_PATH, {"channels": channels})
    return channels


@app.get("/nidaq/devices")
async def nidaq_devices() -> dict:
    # Also reports runtime_available / hardware_present, which the Record page uses to grey out
    # the NI-DAQ source when there is nothing to record from (#86). Threadpooled: DAQmx device
    # enumeration is a driver call that can take a moment.
    return await run_in_threadpool(nidaq_enum.describe_devices, _sim_layout())


@app.get("/nidaq/catalog")
async def nidaq_catalog_list() -> dict:
    return {"cards": nidaq_catalog.gallery()}


@app.post("/nidaq/sim/card")
async def nidaq_add_card(body: dict) -> dict:
    """Add a card to a simulated slot (the '+' on an empty slot → card catalog)."""
    _refuse_nidaq_change_if_busy()
    layout = _sim_layout()
    slot = int(body.get("slot", 0))
    product_type = str(body.get("product_type", "")).strip()
    if not product_type or slot < 1 or slot > int(layout.get("slots", 8)):
        raise HTTPException(400, "slot (1..slots) and product_type required")
    cards = [c for c in layout.get("cards", []) if int(c["slot"]) != slot]
    cards.append({"slot": slot, "product_type": product_type})
    layout["cards"] = cards
    _save_json(NIDAQ_SIM_PATH, layout)
    return nidaq_enum.enumerate_simulated(layout)


@app.delete("/nidaq/sim/card")
async def nidaq_remove_card(slot: int) -> dict:
    _refuse_nidaq_change_if_busy()
    layout = _sim_layout()
    layout["cards"] = [c for c in layout.get("cards", []) if int(c["slot"]) != int(slot)]
    _save_json(NIDAQ_SIM_PATH, layout)
    return nidaq_enum.enumerate_simulated(layout)


@app.get("/nidaq/channels")
async def nidaq_get_channels() -> dict:
    return {"channels": _channel_config(), "roles": chan.ROLES, "colors": chan.ROLE_COLOR}


@app.put("/nidaq/channels")
async def nidaq_put_channels(body: dict) -> dict:
    _refuse_nidaq_change_if_busy()
    channels = body.get("channels")
    if not isinstance(channels, list):
        raise HTTPException(400, "channels list required")
    try:
        chan.validate_virtual_formulas(channels)
    except virtual_channels.FormulaError as e:
        raise HTTPException(400, str(e))
    _save_json(NIDAQ_CHANNELS_PATH, {"channels": channels})
    return {"channels": channels}


@app.post("/nidaq/channels/validate-formula")
async def nidaq_validate_formula(body: dict) -> dict:
    """Validate a single formula against the CURRENTLY SAVED channel list, without saving anything
    — what the equation-builder UI calls on every edit for live feedback, well before the operator
    hits Save. Only hardware channels can ever be referenced (never another virtual one, formulas
    are flat by design), so which virtual channel is mid-edit is irrelevant here."""
    formula = str(body.get("formula") or "")
    try:
        refs = virtual_channels.referenced_channels(formula)
    except virtual_channels.FormulaError as e:
        return {"valid": False, "error": str(e)}
    known = {*chan.FORCE_ORDER, "Tacho", "Fx", "Fy", "Fz"}
    known |= {
        c["name"] for c in _channel_config() if c.get("source") == "hardware" and c.get("name")
    }
    unknown = refs - known
    if unknown:
        return {"valid": False, "error": f"unknown channel(s): {', '.join(sorted(unknown))}"}
    return {"valid": True, "references": sorted(refs)}


@app.post("/nidaq/channels/autoassign")
async def nidaq_autoassign() -> dict:
    _refuse_nidaq_change_if_busy()
    channels = chan.autoassign(_devices())
    _save_json(NIDAQ_CHANNELS_PATH, {"channels": channels})
    return {"channels": channels}


@app.get("/nidaq/max_rate")
async def nidaq_max_rate(channels: str = "") -> dict:
    """#46: lets the Recording Settings tab warn before start that a requested sample rate exceeds
    what the assigned hardware can actually deliver, instead of only finding out from a raw DAQmx
    error once acquisition is already underway. `channels` is a comma-separated physical channel
    list (same format the frontend already keeps in nidaqChannels); max_rate_hz is null when there
    's no real limit to check (simulated hardware, or the DAQmx runtime isn't available here)."""
    chans = [c.strip() for c in channels.split(",") if c.strip()]
    rate = await run_in_threadpool(nidaq_enum.max_sample_rate, chans)
    return {"max_rate_hz": rate}


# ---- Tacho signal generator (cDAQ-9178 built-in counter → PFI0) ----
_tacho_gen_task = None  # nidaqmx.Task or None


@app.post("/nidaq/tacho/start")
async def nidaq_tacho_start(body: dict = {}) -> dict:
    global _tacho_gen_task
    _refuse_nidaq_change_if_busy()
    if _tacho_gen_task is not None:
        raise HTTPException(409, "tacho generator already running")
    freq = float(body.get("freq_hz", 20.0))
    ppr = int(body.get("ppr", 1))
    counter = str(body.get("counter", "STAR_DAQ/ctr0"))
    terminal = str(body.get("terminal", "/STAR_DAQ/PFI0"))
    if freq <= 0 or freq > 100_000:
        raise HTTPException(400, "freq_hz must be between 0 and 100,000")
    from .sources.nidaq import NidaqUnavailableError, _import_nidaqmx

    try:
        nidaqmx, constants, _ = _import_nidaqmx()
    except NidaqUnavailableError as e:
        raise HTTPException(503, str(e))
    task = nidaqmx.Task("tacho_gen")
    try:
        task.co_channels.add_co_pulse_chan_freq(counter, freq=freq, duty_cycle=0.5)
        task.co_channels[0].co_pulse_term = terminal
        task.timing.cfg_implicit_timing(sample_mode=constants.AcquisitionType.CONTINUOUS)
        task.start()
    except Exception as e:
        task.close()
        raise HTTPException(500, f"counter output error: {e}")
    _tacho_gen_task = task
    rpm = freq * 60 / ppr
    return {"running": True, "freq_hz": freq, "ppr": ppr, "rpm": rpm, "terminal": terminal}


@app.post("/nidaq/tacho/stop")
async def nidaq_tacho_stop() -> dict:
    global _tacho_gen_task
    _refuse_nidaq_change_if_busy()
    if _tacho_gen_task is None:
        return {"running": False}
    try:
        _tacho_gen_task.stop()
        _tacho_gen_task.close()
    except Exception:
        pass
    _tacho_gen_task = None
    return {"running": False}


@app.get("/nidaq/tacho/status")
async def nidaq_tacho_status() -> dict:
    return {"running": _tacho_gen_task is not None}


# ---- Audio: force system volume to maximum for catastrophic alarms ----
@app.post("/audio/maxvolume")
async def audio_max_volume() -> dict:
    """Set the Windows system volume to 100% (best-effort, requires pycaw or nircmd).

    Runs off the event loop: the frontend POSTs this from `alarms.ts:forceMaxVolume()` on every
    alarm trip — i.e. precisely while a recording is streaming frames over the WebSocket. A
    synchronous PowerShell launch here stalls the whole backend (frame broadcast, /record/stop)
    for as long as it takes to start, which is the worst possible moment for it.
    """

    def _set_vol():
        import platform

        if platform.system() != "Windows":
            return {"ok": False, "reason": "not Windows"}
        try:
            import subprocess

            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    (
                        "$wshell = New-Object -ComObject WScript.Shell;"
                        "1..50 | ForEach-Object { $wshell.SendKeys([char]175) }"
                    ),
                ],
                capture_output=True,
                timeout=5,
            )
            return {"ok": True, "method": "sendkeys"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    return await run_in_threadpool(_set_vol)


@app.websocket("/record/stream")
async def record_stream(ws: WebSocket) -> None:
    await ws.accept()
    assert _broadcaster is not None
    q = _broadcaster.subscribe()
    # Watch the client side too. Waiting only on q.get() never noticed a client that left while
    # nothing was being published, and at shutdown uvicorn's close frame went unread, so a SIGTERM
    # hung on "Waiting for background tasks" for as long as a browser had the stream open.
    disconnected = asyncio.create_task(_await_ws_disconnect(ws))
    pending_get: asyncio.Task | None = None
    try:
        while True:
            pending_get = asyncio.ensure_future(q.get())
            done, _ = await asyncio.wait(
                {pending_get, disconnected}, return_when=asyncio.FIRST_COMPLETED
            )
            if disconnected in done:
                break
            msg = pending_get.result()
            pending_get = None
            if isinstance(msg, bytes):
                await ws.send_bytes(msg)
            else:
                await ws.send_text(msg)
    except WebSocketDisconnect:
        pass
    finally:
        if pending_get is not None:
            pending_get.cancel()
        disconnected.cancel()
        _broadcaster.unsubscribe(q)


async def _await_ws_disconnect(ws: WebSocket) -> None:
    """Return once the client side of `ws` is gone. The stream is one-way, so anything the client
    sends is ignored."""
    try:
        while True:
            if (await ws.receive())["type"] == "websocket.disconnect":
                return
    except (WebSocketDisconnect, RuntimeError):
        return
