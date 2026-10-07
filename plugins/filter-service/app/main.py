"""FRM filter-service: interactive signal-filter previews.

The browser POSTs a filter chain + a live-cache file id; we
fetch the cache from Directus FORWARDING THE CALLER'S OWN
credentials (cookie / Authorization header) — so access
control stays Directus's and an unauthenticated caller simply
gets Directus's 403. Parsed caches are LRU-kept in memory so
repeated tweaks only pay the filter maths. Filtering runs at
the cache's real sample rate; preview decimation
(target_points) happens AFTER filtering. Served same-origin
by Caddy at /filter/*.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from collections import OrderedDict

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from scipy import signal as ssig
from starlette.concurrency import run_in_threadpool

from .d1lc import Cache, parse, serialise
from .filters import ChainError, apply_chain

DIRECTUS_URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
LRU_CAP = int(os.environ.get("CACHE_LRU", "4"))

app = FastAPI(title="d1-filter-service")

# CORS for the standalone Force App (apps/force-app/web), which
# calls this service from its own origin. `expose_headers` is
# essential: the browser reads X-Filter-Skipped / X-Filter-Stride
# off the response; cross-origin those are hidden unless exposed.
_cors_origins = [
    o.strip() for o in os.environ.get("FILTER_CORS_ORIGINS", "").split(",") if o.strip()
]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=["X-Filter-Skipped", "X-Filter-Ms", "X-Filter-Stride"],
    )

_lru: OrderedDict[str, Cache] = OrderedDict()
# The filter maths runs in the threadpool (a multi-second chain must not freeze the event loop
# and /health), so the LRU is touched from more than one thread: guard every mutation.
_lru_lock = threading.RLock()
# Heavy computes allowed at once; each holds several float64 copies of a multi-million-sample cache.
_compute_slots = threading.BoundedSemaphore(
    max(1, int(os.environ.get("FILTER_MAX_CONCURRENCY", "2")))
)


def _lru_get(file_id: str) -> Cache | None:
    with _lru_lock:
        c = _lru.get(file_id)
        if c is not None:
            _lru.move_to_end(file_id)
        return c


def _lru_put(file_id: str, c: Cache) -> None:
    with _lru_lock:
        _lru[file_id] = c
        _lru.move_to_end(file_id)
        while len(_lru) > LRU_CAP:
            _lru.popitem(last=False)


def _valid_file_id(value: object) -> str:
    """The canonical UUID string for a Directus file id, or a 422.

    The id is interpolated into a Directus URL path; anything else ("../users/me", "x?y")
    could collapse to a different route under the caller's own credentials.
    """
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise HTTPException(422, "cache_file_id must be a UUID") from None


def _auth_headers(req: Request) -> dict:
    h: dict[str, str] = {}
    if "authorization" in req.headers:
        h["Authorization"] = req.headers["authorization"]
    if "cookie" in req.headers:
        h["Cookie"] = req.headers["cookie"]
    return h


async def _authorize(file_id: str, req: Request) -> None:
    """Re-check that THIS caller may read the asset.

    A cheap HEAD to the same /assets route the real fetch uses
    (Directus applies identical file permissions). Guards LRU
    HITS: without this, an entry warmed by one user's creds
    would be served to any caller who knows the id (IDOR). The
    MISS path authorizes inherently because it fetches bytes
    with the caller's own credentials.
    """
    async with httpx.AsyncClient(timeout=30) as cl:
        r = await cl.head(
            f"{DIRECTUS_URL}/assets/{file_id}", headers=_auth_headers(req)
        )
    if r.status_code not in (200, 206):
        raise HTTPException(
            r.status_code if r.status_code >= 400 else 403, "not permitted"
        )


async def _get_cache(file_id: str, req: Request) -> Cache:
    file_id = _valid_file_id(file_id)
    c = _lru_get(file_id)
    if c is not None:
        await _authorize(
            file_id, req
        )  # per-request authz on the shared LRU (IDOR guard)
        return c
    async with httpx.AsyncClient(timeout=120) as cl:
        r = await cl.get(f"{DIRECTUS_URL}/assets/{file_id}", headers=_auth_headers(req))
    if r.status_code != 200:
        raise HTTPException(r.status_code, f"cache fetch failed ({r.status_code})")
    try:
        c = parse(r.content)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    _lru_put(file_id, c)
    return c


def _effective_fs(c: Cache) -> float:
    """The cache's REAL sample rate (it may already be decimated vs the header Fs)."""
    if c.n > 1 and c.t[-1] > c.t[0]:
        return float((c.n - 1) / (c.t[-1] - c.t[0]))
    return float(c.fs)


def _filtered(c: Cache, chain: dict) -> tuple[Cache, list[str]]:
    fs = _effective_fs(c)
    mean_rpm = float(np.mean(c.rpm)) if c.n else 0.0
    axes, skipped = apply_chain(
        {"Fx": c.fx, "Fy": c.fy, "Fz": c.fz}, fs, mean_rpm, chain
    )
    fc = Cache(
        c.fs,
        c.feed,
        c.diam,
        c.cs_sec,
        c.ce_sec,
        c.t,
        axes["Fx"].astype(np.float32),
        axes["Fy"].astype(np.float32),
        axes["Fz"].astype(np.float32),
        c.rpm,
        c.revs,
        c.extras,
    )
    return fc, skipped


@app.get("/health")
async def health():
    return {"ok": True, "lru": len(_lru)}


@app.post("/run")
async def filter_cache(req: Request):
    body = await req.json()
    file_id = body.get("cache_file_id")
    chain = body.get("chain") or {}
    target = int(body.get("target_points") or 1_500_000)
    if not file_id:
        raise HTTPException(422, "cache_file_id required")
    c = await _get_cache(str(file_id), req)
    return await run_in_threadpool(_run_compute, c, chain, target)


def _run_compute(c: Cache, chain: dict, target: int) -> Response:
    """CPU-bound half of /run. Plain `def`, run in the threadpool."""
    t0 = time.perf_counter()
    try:
        with _compute_slots:
            fc, skipped = _filtered(c, chain)
            stride = max(
                1, -(-c.n // max(1, target))
            )  # ceil-div: decimate AFTER filtering
            buf = serialise(fc, stride)
    except ChainError as e:
        raise HTTPException(422, str(e)) from e
    return Response(
        content=buf,
        media_type="application/octet-stream",
        headers={
            "X-Filter-Skipped": "; ".join(skipped),
            "X-Filter-Ms": f"{(time.perf_counter() - t0) * 1000:.0f}",
            "X-Filter-Stride": str(stride),
            "Cache-Control": "no-store",
        },
    )


@app.post("/fft")
async def filter_fft(req: Request):
    """Amplitude spectrum of ONE filtered axis (for the dashed FFT-chart overlay).

    `amp` is RMS amplitude in N (scaling="spectrum": a sine of amplitude A peaks at A/sqrt(2)),
    the same unit as the dashboard's main FFT trace, which process_force.m builds as
    sqrt(pspectrum power). It is NOT a density (N/sqrt(Hz)): the overlay shares the main trace's
    axis, so the two must agree.
    """
    body = await req.json()
    file_id = body.get("cache_file_id")
    axis = str(body.get("axis") or "Fz")
    chain = body.get("chain") or {}
    if not file_id:
        raise HTTPException(422, "cache_file_id required")
    if axis not in ("Fx", "Fy", "Fz"):
        raise HTTPException(422, "axis must be Fx|Fy|Fz")
    c = await _get_cache(str(file_id), req)
    return await run_in_threadpool(_fft_compute, c, chain, axis)


def _fft_compute(c: Cache, chain: dict, axis: str) -> dict:
    try:
        with _compute_slots:
            fc, _ = _filtered(c, chain)
            fs = _effective_fs(c)
            y = {"Fx": fc.fx, "Fy": fc.fy, "Fz": fc.fz}[axis].astype(np.float64)
            nper = min(y.size, 1 << 14)
            f, p = ssig.welch(y, fs=fs, nperseg=nper, scaling="spectrum")
    except ChainError as e:
        raise HTTPException(422, str(e)) from e
    amp = np.sqrt(p)
    step = max(1, f.size // 3000)  # ~3k points, full Nyquist span
    return {"f": f[::step].tolist(), "amp": amp[::step].tolist()}


@app.post("/spectrogram")
async def filter_spectrogram(req: Request):
    """STFT of one filtered axis for the dashboard's spectrogram/waterfall/power views.

    Returns a time x frequency magnitude grid in dB (S[freq][time], 0 dB = global peak),
    decimated small enough to ship as JSON. The client draws the heatmap, the stacked
    waterfall, and the time-averaged power spectrum from this one payload.
    """
    body = await req.json()
    file_id = body.get("cache_file_id")
    axis = str(body.get("axis") or "Fz")
    chain = body.get("chain") or {}
    if not file_id:
        raise HTTPException(422, "cache_file_id required")
    if axis not in ("Fx", "Fy", "Fz"):
        raise HTTPException(422, "axis must be Fx|Fy|Fz")
    c = await _get_cache(str(file_id), req)
    return await run_in_threadpool(_spectrogram_compute, c, chain, axis)


def _spectrogram_compute(c: Cache, chain: dict, axis: str) -> dict:
    try:
        with _compute_slots:
            fc, _ = _filtered(c, chain)
            fs = _effective_fs(c)
            y = {"Fx": fc.fx, "Fy": fc.fy, "Fz": fc.fz}[axis].astype(np.float64)
            if y.size < 128:
                return {"f": [], "t": [], "S": [], "fmax": 0.0}
            nper = int(min(2048, max(128, 1 << int(np.log2(max(128, y.size // 200))))))
            noverlap = nper // 2
            f, t, sxx = ssig.spectrogram(
                y, fs=fs, nperseg=nper, noverlap=noverlap, mode="magnitude"
            )
    except ChainError as e:
        raise HTTPException(422, str(e)) from e
    fstep = max(1, f.size // 180)  # ~180 frequency bins
    tstep = max(1, t.size // 260)  # ~260 time columns
    f_o, t_o, s_o = f[::fstep], t[::tstep], sxx[::fstep, ::tstep]
    mx = float(s_o.max()) or 1.0
    # magnitude → dB relative to the global peak, floored at -80 dB
    s_db = 20.0 * np.log10(np.maximum(s_o, mx * 1e-4) / mx)
    return {
        "f": f_o.round(2).tolist(),
        "t": t_o.round(3).tolist(),
        "S": s_db.round(1).tolist(),
        "fmax": float(f_o[-1]) if f_o.size else 0.0,
    }


def _chain_hash(chain: dict) -> str:
    return hashlib.sha1(json.dumps(chain, sort_keys=True).encode()).hexdigest()[:12]
