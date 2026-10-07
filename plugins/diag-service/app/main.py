"""diag-service: interactive diagnostics-recipe previews.

The browser POSTs a recipe + an analysis-row id. We forward the caller's own Directus
credentials to resolve that row (403 if they may not see it — an IDOR guard identical to
filter-service's, see its commit 32fb4b7), read the row's published base.d1an off the octree
bind mount, and re-run the recipe from the angular-domain state using the SAME run_recipe the
orchestrator's bake calls. No MATLAB, no archive. The result is D1AN column bytes.

Preview is an APPROXIMATION: base.d1an is float32, so the pipeline resumes at lower precision
than a float64 bake. On real process_force.m geometry the divergence is negligible (validated
against operation ffe1286d: resid_z within 1.6e-4, gi_sig / cluster_id byte-identical), but
the bake remains authoritative — every response carries `X-Diag-Preview: approximate`.

Served same-origin by Caddy at /diag/*; Caddy strips the /diag prefix, so the in-container
routes are /health and /preview.
"""

from __future__ import annotations

import copy
import json
import os
import re
import sys
import threading
import time
import uuid
from collections import OrderedDict

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

# scripts/diag is copied to /app/diag in the image; on a dev host it is reachable one level
# up from the repo. Import the SAME modules the orchestrator uses — never reimplement them.
_HERE = os.path.dirname(__file__)
for _p in (
    os.path.join(_HERE, ".."),
    os.path.join(_HERE, "..", "..", "..", "scripts"),
):
    _abs = os.path.abspath(_p)
    if os.path.isdir(_abs) and _abs not in sys.path:
        sys.path.insert(0, _abs)

from diag.d1an import d1an_bytes, read_d1an  # noqa: E402
from diag.layers import rasterize_polygons, validate_geometry  # noqa: E402
from diag.recipe import recipe_hash  # noqa: E402
from diag.registry import STEPS, resolve_inputs  # noqa: E402
from diag.runner import run_recipe  # noqa: E402

DIRECTUS_URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
BASE_LRU_CAP = int(os.environ.get("BASE_LRU", "6"))
RESULT_LRU_CAP = int(os.environ.get("RESULT_LRU", "24"))
# Viewport results are far larger than /preview results (up to max_points x 3 float32 ~=
# 12 MB at 1M points, vs sub-MB base.d1an columns), so they get their own, smaller cap.
VIEWPORT_LRU_CAP = int(os.environ.get("VIEWPORT_LRU", "6"))
VIEWPORT_MAX_POINTS_CEIL = 5_000_000


def _octree_root() -> str:
    # Read at call time, not import time, so tests can point it at a tmp dir.
    return os.environ.get("OCTREE_ROOT", "/srv/octrees")


app = FastAPI(title="d1-diag-service")

_cors = [
    o.strip() for o in os.environ.get("DIAG_CORS_ORIGINS", "").split(",") if o.strip()
]
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=[
            "X-Diag-Cache",
            "X-Diag-Ms",
            "X-Diag-Preview",
            "X-Diag-Skipped",
            "X-Diag-Viewport-N",
            "X-Diag-Viewport-Cols",
        ],
    )

# base.d1an parsed columns, keyed by diag_path -> (file signature, columns) (~18k rows x 5
# float64 ~= 730 KB each).
_base_lru: OrderedDict[str, tuple[tuple, dict]] = OrderedDict()


def _layers_key(layers: dict | None) -> str:
    """A stable cache-key fragment for a layers dict. json.dumps(sort_keys=True), not repr(),
    so two clients that serialise the same layer with differently-ordered inner keys still
    hit the same cache entry."""
    if not layers:
        return ""
    return json.dumps(layers, sort_keys=True, separators=(",", ":"), default=str)


# Computed D1AN bytes, keyed by (diag_path, recipe_hash, layers_key). The common interaction —
# viewing several steps of one unchanged recipe — is then served from a single compute.
_result_lru: OrderedDict[tuple, bytes] = OrderedDict()

# The compute handlers run in the threadpool (so a multi-second recipe no longer freezes the
# event loop and /health), which means the LRUs are shared between threads: every get/put goes
# through _lru_get/_lru_put under this lock. Compute itself runs outside it.
_cache_lock = threading.RLock()
# Bound how many heavy computes run at once: with the event loop free, N concurrent requests
# would otherwise each allocate their own multi-hundred-MB working set.
_compute_slots = threading.BoundedSemaphore(
    max(1, int(os.environ.get("DIAG_MAX_CONCURRENCY", "2")))
)


def _lru_get(od: OrderedDict, key):
    with _cache_lock:
        hit = od.get(key)
        if hit is not None:
            od.move_to_end(key)
        return hit


def _lru_put(od: OrderedDict, key, value, cap: int) -> None:
    with _cache_lock:
        od[key] = value
        od.move_to_end(key)
        while len(od) > cap:
            od.popitem(last=False)


def _file_sig(path: str) -> tuple[int, int, int]:
    """(mtime_ns, size, inode) of a baked artefact. A rebake rewrites the same path, so every
    cache keyed on a path alone would keep serving the old bake; keying on this signature makes
    the next request after a rebake miss and reload."""
    try:
        st = os.stat(path)
    except OSError:
        raise HTTPException(
            409, "no baked data for this analysis — a rebake is needed"
        ) from None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def _auth_headers(req: Request) -> dict:
    h: dict[str, str] = {}
    if "authorization" in req.headers:
        h["Authorization"] = req.headers["authorization"]
    if "cookie" in req.headers:
        h["Cookie"] = req.headers["cookie"]
    return h


async def _resolve_and_authorize(analysis_id: str, req: Request) -> dict:
    """Fetch diag_path + diag_status for `analysis_id` with the CALLER's credentials.

    Doubles as the authorization check: Directus applies the same row permissions it would
    for any read, so a caller who may not see the row gets its 401/403 here. Runs on every
    request — there is no cached bypass, matching filter-service's post-32fb4b7 behaviour.
    """
    try:
        # Interpolated into a Directus URL path: only a real UUID may reach it ("../users/me"
        # would collapse to a different route under the caller's own credentials).
        analysis_id = str(uuid.UUID(str(analysis_id)))
    except ValueError:
        raise HTTPException(422, "analysis_id must be a UUID") from None
    async with httpx.AsyncClient(timeout=30) as cl:
        r = await cl.get(
            f"{DIRECTUS_URL}/items/machining_force_analysis/{analysis_id}",
            params={"fields": "diag_path,diag_status"},
            headers=_auth_headers(req),
        )
    if r.status_code in (401, 403):
        raise HTTPException(r.status_code, "not permitted")
    if r.status_code == 404:
        raise HTTPException(404, "analysis row not found")
    if r.status_code != 200:
        raise HTTPException(502, f"directus {r.status_code}")
    return (r.json() or {}).get("data") or {}


# diag_path is written by process_diag_row as str(operation_id) — a UUID — but it is a
# text column with no DB constraint and is editable from the Directus admin, so a crafted
# value ("../../..") must not be able to escape the octree root. Operation ids are hex +
# hyphens; anything with a separator or dot is rejected before it reaches os.path.join.
_DIAG_PATH_RE = re.compile(r"[A-Za-z0-9_-]+")


_FRAME_CHANNELS = ("fp", "fc", "ff")


def _channel_of(recipe: dict) -> str:
    """The frame_transform.channel a recipe has selected, defaulting exactly like the step's
    own registry function does."""
    for s in recipe.get("steps", []):
        if s.get("op") == "frame_transform":
            return str((s.get("params") or {}).get("channel", "fp"))
    return "fp"


def _select_base_signal(base: dict, channel: str) -> dict:
    """base.d1an's `sig` seed column for a preview run, picking out the requested channel from
    a DIAG_VERSION 10+ base.d1an (base_columns_all_channels: sig_fp/sig_fc/sig_ff) -- or,
    against an older base.d1an that predates per-channel signals (still just `sig`), falling
    back to whatever single channel it was baked with. That fallback is not a new failure
    mode: it reproduces exactly what preview already did before Phase H slice 4, for a row
    that has not yet been rebaked at v10, rather than a hard 409 mid-transition."""
    if channel not in _FRAME_CHANNELS:
        raise HTTPException(
            422, f"channel must be one of {_FRAME_CHANNELS}, got {channel!r}"
        )
    sig_key = f"sig_{channel}"
    if sig_key in base:
        sig = base[sig_key]
    elif "sig" in base:
        sig = base["sig"]
    else:
        raise HTTPException(
            409, "base.d1an for this analysis has no recognised signal column"
        )
    return {
        "t": base["t"],
        "rev": base["rev"],
        "x": base["x"],
        "y": base["y"],
        "sig": sig,
    }


def _base_path(diag_path: str) -> str:
    if not _DIAG_PATH_RE.fullmatch(diag_path):
        raise HTTPException(400, "invalid diag_path")
    return os.path.join(_octree_root(), "diag", diag_path, "base.d1an")


def _load_base(diag_path: str, sig: tuple | None = None) -> dict:
    """Parsed base.d1an columns, cached per diag_path and invalidated when the file changes."""
    path = _base_path(diag_path)
    if sig is None:
        sig = _file_sig(path)
    hit = _lru_get(_base_lru, diag_path)
    if hit is not None and hit[0] == sig:
        return hit[1]
    cols = {k: np.asarray(v, dtype=np.float64) for k, v in read_d1an(path).items()}
    _lru_put(_base_lru, diag_path, (sig, cols), BASE_LRU_CAP)
    return cols


# --- Phase G: full-resolution viewport recompute ---------------------------------------
# full.d1an is the flat {x, y, resid_z} at raw spiral resolution (~7M rows x 3 float64 ~=
# 168 MB parsed). The endpoint crops it to a framed bbox, strides down over max_points, and
# runs exactly ONE spatial registry step on the crop. Never authoritative -- the 256/rev
# attrs.d1an stays the baked truth; this is a preview at the resolution the analyst is
# looking at.
FULL_LRU_CAP = int(os.environ.get("FULL_LRU", "3"))
_full_lru: OrderedDict[str, tuple[tuple, dict]] = OrderedDict()
_viewport_lru: OrderedDict[tuple, tuple[bytes, int, str]] = (
    OrderedDict()
)  # key -> (d1an bytes, n, cols header)

_VIEWPORT_STEPS = {"getis_ord", "hdbscan", "grow_segmentation", "gmm_segmentation"}
_VIEWPORT_OUTPUT = {
    "getis_ord": "gi_star",
    "hdbscan": "cluster_id",
    "grow_segmentation": "segment_id",
    "gmm_segmentation": "gmm_id",
}


def _full_path(diag_path: str) -> str:
    if not _DIAG_PATH_RE.fullmatch(diag_path):
        raise HTTPException(400, "invalid diag_path")
    return os.path.join(_octree_root(), "diag", diag_path, "full", "full.d1an")


def _load_full(diag_path: str, sig: tuple | None = None) -> dict:
    path = _full_path(diag_path)
    if sig is None:
        if not os.path.isfile(path):
            raise HTTPException(
                409, "no full.d1an — a rebake at DIAG_VERSION 7 is needed"
            )
        sig = _file_sig(path)
    hit = _lru_get(_full_lru, diag_path)
    if hit is not None and hit[0] == sig:
        return hit[1]
    cols = {k: np.asarray(v, dtype=np.float64) for k, v in read_d1an(path).items()}
    _lru_put(_full_lru, diag_path, (sig, cols), FULL_LRU_CAP)
    return cols


def _first_derived_index(recipe: dict) -> int:
    """The step to resume from: the first whose registry tier is 'derived'. Everything
    before it (frame_transform, angular_resample) is already baked into base.d1an."""
    for i, s in enumerate(recipe.get("steps", [])):
        spec = STEPS.get(s.get("op"))
        if spec is not None and spec.tier == "derived":
            return i
    raise HTTPException(422, "recipe has no derived step to preview")


def _disable_unpreviewable(recipe: dict, from_step: int) -> tuple[dict, list[str]]:
    """Return (recipe with un-previewable steps switched off, their op names).

    base.d1an holds only the angular state (t, rev, x, y, sig). A `base`-tier step sitting
    AFTER the resume point -- `envelope` is the one that exists -- consumes full-rate columns
    (fc/ff/fp, revs, t_raw) that base.d1an does not carry, so running it here raises a bare
    KeyError('t_raw'). That surfaced to the analyst as `recipe failed: 't_raw'` on EVERY
    preview once they enabled the envelope step, with nothing saying why.

    Switching those steps off for the preview only (never for the bake) makes the rest of the
    recipe previewable and lets the response name what was skipped, so the UI can say
    "envelope needs a bake" instead of showing a column name as an error.
    """
    skipped = [
        s.get("op")
        for i, s in enumerate(recipe.get("steps", []))
        if i >= from_step
        and s.get("on", True)
        and (spec := STEPS.get(s.get("op"))) is not None
        and spec.tier == "base"
    ]
    if not skipped:
        return recipe, []
    out = copy.deepcopy(recipe)
    for i, s in enumerate(out.get("steps", [])):
        if i >= from_step and s.get("op") in skipped:
            s["on"] = False
    return out, skipped


@app.get("/health")
async def health():
    return {"ok": True, "base_lru": len(_base_lru), "result_lru": len(_result_lru)}


@app.post("/preview")
async def preview(req: Request):
    body = await req.json()
    analysis_id = body.get("analysis_id")
    recipe = body.get("recipe")
    layers = body.get("layers") or None
    if not analysis_id or not isinstance(recipe, dict):
        raise HTTPException(422, "analysis_id and recipe are required")

    # "Click a step in the Pipeline panel to revert the view to it" (Phase H slice 3): the
    # full step-list index (disabled steps included) to truncate execution after, in
    # runner.run_recipe's own stop_after convention. None previews the whole recipe.
    stop_after = body.get("stop_after")
    if stop_after is not None and not isinstance(stop_after, int):
        raise HTTPException(422, "stop_after must be an integer or null")

    # Inline layers are the authoritative mask/label/seed input for THIS request (spec
    # Component 4: "a mask is most useful while you are still drawing it"). Validate the
    # geometry shape here so a malformed polygon set is a clean 422, not a 500 from deep in
    # run_recipe. The service never persists these -- that is a separate explicit action.
    if layers is not None:
        if not isinstance(layers, dict):
            raise HTTPException(422, "layers must be an object keyed by layer name")
        for lname, layer in layers.items():
            try:
                validate_geometry((layer or {}).get("geometry") or {})
            except (ValueError, AttributeError, TypeError) as e:
                raise HTTPException(422, f"layer '{lname}': {e}") from e

    row = await _resolve_and_authorize(str(analysis_id), req)
    if row.get("diag_status") != "done" or not row.get("diag_path"):
        raise HTTPException(409, "analysis has no completed bake to preview from")
    diag_path = str(row["diag_path"])

    return await run_in_threadpool(
        _preview_compute, diag_path, recipe, layers, stop_after
    )


def _preview_compute(
    diag_path: str, recipe: dict, layers: dict | None, stop_after: int | None
) -> Response:
    """The CPU-bound half of /preview. Plain `def`, run in the threadpool."""
    # Steps that cannot run from base.d1an are switched off for the preview and named back to
    # the client, rather than raising a bare column-name KeyError. Done before the cache key so
    # a recipe that differs only in an un-previewable step still shares one cache entry.
    from_step = _first_derived_index(recipe)
    recipe, skipped = _disable_unpreviewable(recipe, from_step)
    skipped_hdr = ",".join(s for s in skipped if s)

    # The base.d1an signature is part of the key: a rebake rewrites the same path.
    base_path = _base_path(diag_path)
    base_sig = _file_sig(base_path)
    key = (diag_path, base_sig, recipe_hash(recipe), _layers_key(layers), stop_after)
    cached = _lru_get(_result_lru, key)
    if cached is not None:
        return Response(
            cached,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Diag-Cache": "hit",
                "X-Diag-Preview": "approximate",
                "X-Diag-Skipped": skipped_hdr,
            },
        )

    with _compute_slots:
        base = _load_base(diag_path, base_sig)
        seed = _select_base_signal(base, _channel_of(recipe))
        t0 = time.perf_counter()
        try:
            cols, _metrics = run_recipe(
                recipe, seed, layers=layers, from_step=from_step, stop_after=stop_after
            )
        except HTTPException:
            raise
        except (KeyError, ValueError) as e:
            raise HTTPException(422, f"recipe failed: {e}") from e

        out = d1an_bytes(cols)

    _lru_put(_result_lru, key, out, RESULT_LRU_CAP)
    return Response(
        out,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Diag-Cache": "miss",
            "X-Diag-Preview": "approximate",
            "X-Diag-Skipped": skipped_hdr,
            "X-Diag-Ms": f"{(time.perf_counter() - t0) * 1000:.0f}",
        },
    )


@app.post("/viewport")
async def viewport(req: Request):
    """Run one spatial step (Gi*, HDBSCAN, GMM, seeded segmentation) on a framed region of
    the full-resolution cloud. The client sends a bbox in x/y mm and the step config; we crop
    full.d1an to it, stride down if over max_points, and return D1AN {x, y, <output columns>}.

    `outputs` (a list) requests several of the step's produced columns at once, each under
    its own name -- e.g. gmm_segmentation's gmm_id (colour) and gmm_prob (confidence)
    together in one response, which griddify-style value+confidence steps need to be shown
    together. `output` (singular) is the older, single-column form: kept exactly as it
    behaved before -- respected only for getis_ord's gi_star/gi_sig choice, silently ignored
    for every other op (existing callers send a stale 'gi_star' default on every request
    regardless of op, so widening what `output` validates against would break them). A
    request naming neither gets the op's own default column. Exactly one of `output`/absent
    and `outputs` present decides whether the response is the legacy single `value` column or
    one column per requested name (X-Diag-Viewport-Cols names them, in order)."""
    body = await req.json()
    analysis_id = body.get("analysis_id")
    bbox = body.get("bbox")
    step = body.get("step") or {}
    layers = body.get("layers") or None
    output = body.get("output") or "gi_star"
    outputs_raw = body.get("outputs")
    op = step.get("op")

    if not analysis_id or not isinstance(bbox, list) or len(bbox) != 4:
        raise HTTPException(422, "analysis_id and bbox [x0,y0,x1,y1] are required")
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in bbox):
        raise HTTPException(422, "bbox elements must be numbers")
    if op not in _VIEWPORT_STEPS:
        raise HTTPException(422, f"step.op must be one of {sorted(_VIEWPORT_STEPS)}")
    if outputs_raw is not None:
        if (
            not isinstance(outputs_raw, list)
            or not outputs_raw
            or not all(isinstance(o, str) for o in outputs_raw)
        ):
            raise HTTPException(422, "outputs must be a non-empty array of strings")
        produces = set(STEPS[op].produces)
        bad = [o for o in outputs_raw if o not in produces]
        if bad:
            raise HTTPException(
                422,
                f"outputs {bad} not produced by {op!r} (produces {sorted(produces)})",
            )
    mp_raw = body.get("max_points")
    if mp_raw is None:
        max_points = 1_000_000
    else:
        try:
            max_points = int(mp_raw)
        except (TypeError, ValueError):
            raise HTTPException(422, "max_points must be an integer") from None
    if max_points < 1:
        raise HTTPException(422, "max_points must be a positive integer")
    max_points = min(max_points, VIEWPORT_MAX_POINTS_CEIL)
    if layers is not None:
        if not isinstance(layers, dict):
            raise HTTPException(422, "layers must be an object keyed by layer name")
        for lname, layer in layers.items():
            try:
                validate_geometry((layer or {}).get("geometry") or {})
            except (ValueError, AttributeError, TypeError) as e:
                raise HTTPException(422, f"layer '{lname}': {e}") from e

    row = await _resolve_and_authorize(str(analysis_id), req)
    if row.get("diag_status") != "done" or not row.get("diag_path"):
        raise HTTPException(409, "analysis has no completed bake")
    diag_path = str(row["diag_path"])

    return await run_in_threadpool(
        _viewport_compute,
        diag_path,
        op,
        step,
        bbox,
        layers,
        output,
        outputs_raw,
        max_points,
    )


def _viewport_compute(
    diag_path: str,
    op: str,
    step: dict,
    bbox: list,
    layers: dict | None,
    output: str,
    outputs_raw: list | None,
    max_points: int,
) -> Response:
    """The CPU-bound half of /viewport. Plain `def`, run in the threadpool."""
    x0, y0, x1, y1 = (float(v) for v in bbox)
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0

    outputs_key = tuple(outputs_raw) if outputs_raw is not None else (output,)
    # full.d1an's signature is part of the key: a rebake rewrites the same path.
    full_path = _full_path(diag_path)
    if not os.path.isfile(full_path):
        raise HTTPException(409, "no full.d1an — a rebake at DIAG_VERSION 7 is needed")
    full_sig = _file_sig(full_path)
    key = (
        diag_path,
        full_sig,
        op,
        (round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)),
        recipe_hash({"steps": [step]}),
        _layers_key(layers),
        outputs_key,
        max_points,
    )
    cached = _lru_get(_viewport_lru, key)
    if cached is not None:
        cbytes, cn, ccols = cached
        return Response(
            cbytes,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Diag-Cache": "hit",
                "X-Diag-Viewport-N": str(cn),
                "X-Diag-Viewport-Cols": ccols,
            },
        )

    with _compute_slots:
        full = _load_full(diag_path, full_sig)
        fx, fy, frz = full["x"], full["y"], full["resid_z"]
        m = (fx >= x0) & (fx <= x1) & (fy >= y0) & (fy <= y1)
        idx = np.where(m)[0]
        if idx.size == 0:
            raise HTTPException(422, "empty viewport")
        if idx.size > max_points:
            idx = idx[:: int(np.ceil(idx.size / max_points))]
        xc = fx[idx].copy()
        yc = fy[idx].copy()
        rc = frz[idx].copy()

        # A mask painted since the last bake is not reflected in full.d1an's NaN pattern (that
        # only carries masks present at bake time). Apply every mask-role layer to the crop here
        # so a viewport recompute excludes the same region the 256/rev preview does -- the ops
        # already skip non-finite resid_z.
        if layers:
            for layer in layers.values():
                lyr = layer or {}
                if lyr.get("role") == "mask" and lyr.get("geometry"):
                    rc[rasterize_polygons(lyr["geometry"], xc, yc)] = np.nan

        t0 = time.perf_counter()
        try:
            # resolve_inputs is inside the try: it raises RecipeError (a ValueError subclass) for a
            # missing/mismatched layer binding, which must surface as the endpoint's 422 contract,
            # not an unhandled 500.
            resolved: dict = {}
            if op == "grow_segmentation":
                resolved = resolve_inputs(
                    {"op": op, "inputs": step.get("inputs")}, layers, xc, yc
                )
            produced, _metrics = STEPS[op].fn(
                {"x": xc, "y": yc, "resid_z": rc}, step.get("params") or {}, resolved
            )
        except HTTPException:
            raise
        except (KeyError, ValueError) as e:
            raise HTTPException(422, f"step failed: {e}") from e
        except MemoryError as e:
            # assign_by_neighbours (hdbscan / gmm_segmentation broadcast-back) allocates an
            # (n_points, n_labels) float64 matrix with no bound tied to VIEWPORT_MAX_POINTS_CEIL,
            # so a large crop that clusters into many labels can exhaust host memory. Return a
            # clean, actionable error rather than a bare 500 or taking the process down for every
            # concurrent analyst.
            raise HTTPException(
                507,
                "viewport crop is too large for this step — zoom in or lower max_points",
            ) from e
        ms = int((time.perf_counter() - t0) * 1000)

    def _column(name: str) -> np.ndarray:
        categorical = name in ("cluster_id", "segment_id", "gmm_id")
        return np.nan_to_num(
            produced[name], nan=-1.0 if categorical else np.nan
        ).astype(np.float32)

    if outputs_raw is not None:
        # Multi-output: each requested column keeps its own real name, so a new client can
        # tell grid_fill from grid_support (or gmm_id from gmm_prob) apart in one response.
        cols_out = list(outputs_raw)
        d1an_cols = {name: _column(name) for name in cols_out}
    else:
        # Legacy single-column path, byte-for-byte what this returned before `outputs`
        # existed: always named 'value', 'output' respected only for getis_ord.
        col = _VIEWPORT_OUTPUT[op]
        if op == "getis_ord" and output in ("gi_star", "gi_sig"):
            col = output
        cols_out = ["value"]
        d1an_cols = {"value": _column(col)}

    cols_header = ",".join(cols_out)

    out = d1an_bytes(
        {
            "x": xc.astype(np.float32),
            "y": yc.astype(np.float32),
            **d1an_cols,
        }
    )

    _lru_put(_viewport_lru, key, (out, int(xc.size), cols_header), VIEWPORT_LRU_CAP)
    return Response(
        out,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Diag-Cache": "miss",
            "X-Diag-Ms": str(ms),
            "X-Diag-Viewport-N": str(xc.size),
            "X-Diag-Viewport-Cols": cols_header,
        },
    )
