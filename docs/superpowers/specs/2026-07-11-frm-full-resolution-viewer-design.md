# FRM full-resolution viewer — design

**Date:** 2026-07-11
**Status:** Implemented 2026-07-11/12 with option (b) from the open decision below — the
three.js renderer (`packages/force-plotting/src/FrmCloud.vue`), the viewport download (migration
`20260711000092_frm_viewport_render.sql`) and the Phase 2 Potree octree (migration
`20260712000093_frm_octree.sql`, `FrmOctree.vue`). The throwaway `d1-potree-spike` module was
never committed.

## Context & problem

The Force dashboard's **Live FRM** renders a WebGL point cloud rebuilt client-side from
`live_cache.bin` — a host-**decimated** copy of the machining force signal, capped by the
crawler's `live_cache_points` (currently **1,000,000**). So even the "Show every: all pts"
control only shows *cached* points, never the raw signal. Example op `9fa1f0e9`: raw cut =
1,926,100 samples → cached at 968,259 (~50%); for a 14M-point op the cache is ~7%. Users
correctly perceive the Live FRM as "the crawled downsampled version."

The maintainer wants to **plot the full resolution when desired**, and separately to
**download a pixel-identical FRM of the current viewport**. They also expect **future 3D
point clouds** where a chosen series drives a **Z axis**.

## Goals

- **Continuous full-resolution** interactive plotting for operations up to **~3M points**.
- A path to **seamless full-res at any N** (up to ~14M) for larger ops and future **3D**
  (Z-series) clouds.
- **Pixel-identical viewport download** matching the prerendered report FRM PNGs.
- Keep the existing FRM controls (axis pick, colormap, crop, colorbar, scale bar).

## Non-goals

- Re-deriving the FRM geometry (unchanged: `rho = Diam/2 - Feed·r`, `theta = 2π·r`).
- Changing the canonical prerendered PNGs / metrics pipeline.
- Real-time collaborative or multi-op views.

## Decisions (from brainstorming, 2026-07-11)

1. **≤3M ops:** render the **full, undecimated** cloud client-side — no LOD needed; a modern
   GPU renders a few million points continuously (Batch-1 pan/zoom is already uniform-only).
2. **>3M / 14M / 3D:** use a **Potree octree LOD** (2D analogue of an octree; native fit once
   clouds become 3D). Not a drop-in viewer — integrated via `potree-core` + `three.js`.
3. **Renderer stack:** unify on **three.js** so the Potree octree (Phase 2) drops into the
   same scene as the ≤3M direct renderer (Phase 1) — one renderer, not two.
4. **Download:** **MATLAB host raster** of the viewport bounds — pixel-identical to the report
   PNGs. Potree/three.js is the *viewer*; MATLAB is the *exporter*.
5. **Spike outcome (Phase A, done):** `three` + `potree-core` + `OrbitControls` **bundle
   cleanly** in the Directus extension build; a 400k-point cloud renders top-down orthographic,
   viridis-by-scalar, with pan/zoom, no errors. Throwaway module `d1-potree-spike` (URL-only,
   not in the module bar) — to be deleted once Phase 2 lands.

## Architecture overview (phased)

```
Phase 1 (this plan)                         Phase 2 (later)
──────────────────                          ───────────────
host: raise cache cap → full cloud ≤3M      host: .mat → Potree octree (PotreeConverter)
client: three.js Points viewer  ───────────▶ client: same three.js scene + potree-core LOD
        (replaces FrmCloud WebGL)                    + optional Z-series (3D)
download: MATLAB viewport raster (shared by both phases)
```

## Phase 1 — ≤3M continuous full-resolution (the buildable scope now)

**Host.** The cache is already written by `scripts/matlab/process_force.m` →
`write_live_cache(...)` and decimated to `opts.live_cache_points`. Raise the effective cap so
ops with ≤3M points in the cut window are cached **1:1** (no decimation), and ops above it are
capped at 3M. Concretely: `force_crawler_state.live_cache_points` default raised (or a new
`live_cache_max_points` = 3,000,000), and `write_live_cache` keeps all points when
`N ≤ cap`. Re-crawl (or on-demand Tier-2 "Process") regenerates affected caches. Cache binary
format is unchanged (just more points); download size grows (≤3M × 6 float32 ≈ 72 MB worst
case) — acceptable for the opt-in Live view, mitigated by the existing per-op LRU cache.

**Client.** Replace `FrmCloud.vue`'s bespoke WebGL renderer with a **three.js `Points`**
renderer (the spike's proven approach), keeping the same props/controls:
- Geometry recompute stays in `liveCloud.ts` `buildCloud` (positions + per-point colour from
  the chosen axis + colormap + prctile 1/99) — feeds a three.js `BufferGeometry`
  (`position` + `color` attributes), uploaded once per geometry/colour change (mirrors the
  Batch-1 rebuild/redraw split).
- **Orthographic top-down** camera; pan/zoom via a constrained `OrbitControls` (rotate
  disabled) or the existing pointer handlers — continuous, no per-frame rebuild.
- Keep the colorbar, scale bar, axis buttons, crop handles, colormap/point-size/gridding
  controls, and the "N pts" readout.
- Relabel the stride control honestly: "Show every … (of cached points)".

**Interfaces / isolation.** `buildCloud` stays the pure geometry→(pos,col) unit (already
tested-in-isolation friendly). The three.js scene lifecycle (init, resize, dispose) is a thin
renderer wrapper — swappable without touching `buildCloud` or the parent dashboard.

## Phase 2 — Potree octree LOD + 3D Z-series (designed, deferred)

- **Host pipeline:** from the raw `.mat`, emit the full point set with per-point **attributes**
  (Fx, Fy, Fz, and candidate Z-series values), run **PotreeConverter** to a Potree 2.0 octree.
  A new orchestrator step (or `process_force.m` companion) triggered like the existing Tier-2
  render. Remaining unknown (**Phase B spike, not yet done**): generate + serve + stream an
  octree end-to-end.
- **Serving:** octrees are multi-file tilesets needing HTTP range reads → served as **static
  folders via the `proxy`/nginx container**, not one-file Directus assets.
- **Viewer:** `potree-core` loads the octree into the **same three.js scene**; colour by a
  chosen attribute (viridis gradient), pick the display axis, and optionally map a series to
  **Z** for a true 3D cloud (enable rotate in 3D mode).
- **Threshold:** ops ≤3M keep the Phase-1 direct path; >3M use the octree.

## Download — MATLAB viewport raster (shared)

A "Download this view" action sends the **current viewport bounds** (xmin/xmax/ymin/ymax) +
axis + colormap + colour limits to the host; the orchestrator invokes a MATLAB FRM render
restricted to those bounds, reusing the exact styling block in `process_force.m`'s FRM loop
(fonts, colorbar, grid), and returns a PNG. Mechanism mirrors the existing Tier-2 request:
new fields on `machining_force_analysis` (`render_bounds` jsonb, `render_axis`,
`render_colormap`, `render_cmin/cmax`, `render_status`, `render_file` FK); client sets them +
polls; orchestrator fills `render_file`; client downloads. This also satisfies the original
"download a fully-formatted FRM of whatever is in the viewport" request.

## Data model / DB changes

- Phase 1: raise `force_crawler_state.live_cache_points` cap (migration) — or add
  `live_cache_max_points`.
- Download: add the `render_*` fields above to `machining_force_analysis` (migration).
- Phase 2: octree location/id per analysis row (e.g. `octree_path`), added when built.

## Error handling

- Cache > cap: fall back to decimated (current behaviour) + a UI note that full-res needs a
  re-render (Tier-2 "Process").
- three.js/WebGL context loss: show a message + offer reload (as `FrmCloud` does today).
- Download/render failures: surface the MATLAB error (as Tier-2 does), non-blocking.
- Phase 2 octree fetch/range errors: fall back to the Phase-1 direct cloud when ≤3M, else the
  decimated cache + message.

## Testing

- **Unit:** `buildCloud` output (counts, prctile limits, colour mapping) — pure function.
- **Playwright:** Live FRM renders on a ≤3M op, pan/zoom keeps "N pts" constant (no rebuild),
  colours match viridis, no console errors (headless Chromium has SwiftShader WebGL).
- **Data:** verify a re-crawled ≤3M op caches 1:1 (cache N == cut samples) and >3M caps at 3M.
- **Download:** the returned PNG visually matches the prerendered `frm_<axis>.png` styling.

## Rollout & risks

- Phase 1 first (real value: continuous full-res ≤3M + the download). Phase 2 (Potree octree)
  only when the 14M/3D need is concrete; its serving/streaming (Phase B) still needs a spike.
- Risk: ≤3M cache download size (~tens of MB) — mitigated by opt-in Live + LRU cache; the 3M
  cap bounds it.
- Risk: swapping `FrmCloud`'s renderer to three.js is a non-trivial rewrite of one component —
  contained, and de-risked by the working spike.
- **Open decision for review:** Phase 1 renderer — (a) reuse the existing Batch-1 custom WebGL
  renderer and *only* raise the cache cap (least work now, but two renderers later), vs
  (b) rebuild on three.js now so Phase 2's Potree drops into the same scene (recommended;
  more work now, one stack). This spec assumes (b).
