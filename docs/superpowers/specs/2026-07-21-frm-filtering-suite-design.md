# FRM signal-filtering suite — design

**Status:** implemented July 2026 — `plugins/filter-service/`,
`packages/force-plotting/src/filterChain.ts` and migrations `20260721000097_filter_chain.sql`
and `20260722000099_filter_baked.sql`.

## Motivation

The FRM maps colour points by instantaneous force, so every signal artefact becomes a map
artefact: broadband noise → speckle, drift/DC → colour-scale walk across the spiral,
spindle-periodic force → rings/banding, spikes → stretched colour limits. A filtering suite
lets the user clean the signal and see the cleaned map — interactively while experimenting,
and permanently once a chain is baked.

User decisions (2026-07-21 interview):
- Artefacts to address: **all four** (noise, drift, spindle harmonics, spikes).
- **Hybrid** architecture; interactive preview computed by a **host-side filter service**
  (the user's clients can be phones; the workstation does the maths).
- Profiles: **per-op chain + named profile library** (applying a profile copies it — no
  live linkage).
- Bake **replaces** the derived outputs, recorded + reversible (raw .mat never touched).
- Preview shows **raw and filtered side-by-side in two linked viewports** (shared
  transform), not a single swapped view.

## Goals

- A fixed-order, per-stage-optional filter chain applied identically to Fx/Fy/Fz.
- Instant-feeling experimentation in Lite via a containerised filter service.
- Side-by-side raw|filtered comparison with linked pan/zoom and a shared colour scale.
- Filtered-FFT overlay so notch/LP effects are visible in the frequency domain.
- One-click bake: MATLAB applies the identical chain at full resolution to ALL derived
  outputs (FRM PNGs, live cache, octree/grid emits). Reversible by clearing + re-baking.
- Named profiles for reuse across a campaign.

## Non-goals / deferred

- **Tracking (time-varying) notches** — v1 notches centre on the op's mean RPM; true
  order-domain tracking breaks zero-phase filtering and needs resampling — v2.
- **Per-axis chains** — v1 applies one chain to all three axes (drift/harmonics are
  common-mode). Deferred.
- **3D compare** — comparison mode is 2D-only; linking two OrbitControls cameras is out.
- **Filtering the tacho/RPM** — force only in v1.
- **Compare in Figure/Full** — under replace-semantics the raw and filtered octrees never
  coexist; comparison is a Lite feature (raw cache + on-demand service filtering always
  allow it, before or after bake).

## The filter chain

Fixed order (DSP-sensible), each stage independently enabled with parameters; JSON-encoded:

```json
{ "despike": { "on": true, "window": 11, "sigma": 5 },
  "detrend": { "on": true, "mode": "highpass", "cutoff_hz": 5 },
  "lowpass": { "on": true, "cutoff_hz": 2000, "order": 4 },
  "notch":   { "on": true, "harmonics": [1, 2, 3], "q": 30 } }
```

1. **Despike** — Hampel (median ± sigma·MAD over `window` samples).
2. **Detrend** — `dc` (subtract mean) | `highpass` (Butterworth HP at `cutoff_hz`).
3. **Low-pass** — Butterworth, `order`, `cutoff_hz`.
4. **Notch ×k** — IIR notches at `harmonics × f_spindle`, `f_spindle = mean_rpm/60` Hz.

All IIR stages run **zero-phase** (`sosfiltfilt` / `filtfilt`) so the spiral geometry never
phase-shifts. Cutoffs are validated against Nyquist (of the signal being filtered — the
service filters the decimated cache, so its effective Fs is `Fs/stride`; stages whose
cutoff exceeds the preview Nyquist are skipped in preview with a UI note, but still apply
at full resolution on bake).

## Architecture

```
Browser (Lite)                         filter-service (Docker, Python/scipy)
  Filters accordion ──chain JSON──▶  POST /filter {cache_file_id, chain, target_points}
  (debounced ~400ms)                    ├─ fetch live_cache.bin from Directus (service token)
                                        ├─ in-memory LRU of parsed caches
                                        ├─ apply chain (sosfiltfilt/hampel) to Fx/Fy/Fz
                                        └─ return: D1LC binary (decimated to target_points)
  two FrmClouds  ◀──filtered cache──    + per-axis filtered FFT (json, small)
  raw | filtered, linked view

Bake: op.filter_chain (jsonb) ──status='pending'──▶ force_orchestrator ──▶ MATLAB
  process_force applies the SAME chain (jsondecode) to Fx/Fy/Fz right after channel
  extraction → every output (summary metrics, series, fft, FRM PNGs, live cache,
  octree_out, grid_out) is filtered. Clearing the chain + re-baking restores raw.
```

### filter-service (new container)

- Python 3.12 + FastAPI + numpy/scipy, in `services/filter-service/` (mirrors the existing
  worker-container pattern), added to docker-compose, served same-origin by Caddy at
  `/filter/*` (CSP-safe, like `/octrees/*`).
- Auth: forwards the caller's Directus session — the service fetches the cache from
  Directus WITH the user's cookie/token, so access control stays Directus's (no service
  account with broad rights; an unauthenticated caller gets a 403 from Directus).
- `POST /filter` body: `{ cache_file_id, chain, target_points (default 1_500_000), axes:
  ["Fx","Fy","Fz"] }` → response: filtered D1LC binary (same header/layout, decimated by
  stride to ≤ target_points) with `X-Filter-Skipped` header listing preview-skipped stages;
  `POST /filter/fft` → `{ f: [...], amp: [...] }` for one axis (filtered), ~3k points.
- In-memory parsed-cache LRU (≈ 4 entries) so repeated tweaks re-filter without re-download.
- `GET /health` for compose/Playwright gating.

### Client (Lite) — compare mode

- When the chain has ≥1 enabled stage, the FRM area splits into **raw | filtered**
  viewports (vertical stack on mobile; both keep the square aspect).
- **Linked transform**: a shared view-state object `{cx, cy, span, active}` owned by
  ForceDashboard, passed to both FrmCloud instances via an optional `sharedView` prop;
  when present FrmCloud reads/writes it in place of its local refs → pan/zoom/rect-zoom
  in either pane drives both.
- **Shared colour scale**: both panes use the raw cloud's auto 1/99 limits (or the manual
  cmin/cmax) so amplitude changes read honestly. The filtered pane shows the chain badge;
  the raw pane is labelled "raw". Crop bars drive both.
- The filtered pane's data source is a **filtered cache** in the existing liveCache LRU,
  keyed `«cacheFileId»#«chainHash»`, fetched from the service (debounced). Service
  unreachable → notice in the filtered pane; raw pane unaffected.
- Z (3D) select is disabled while compare is active.
- The FFT chart overlays the filtered spectrum (dashed) from `/filter/fft`.

### Persistence + profiles

- `machining_force_analysis.filter_chain jsonb` — the op's active chain (NULL = none).
- New `filter_profiles` table: `id uuid PK, name text unique, chain jsonb, created_at`.
- UI: profile dropdown (load = copy into the op's working chain), "Save as profile…",
  delete. Registered in Directus (fields metadata) like other tables.

### Bake (MATLAB)

- Orchestrator passes `opts.filter_chain` as a JSON **string** (via `mlq`), MATLAB
  `jsondecode`s it; a new `apply_filter_chain(Fx, Fy, Fz, Fs, mean_rpm, chain)` in
  `scripts/matlab/frm_filters.m` implements the identical stages (hampel, detrend/
  highpass butter+filtfilt, butter LP + filtfilt, iirnotch per harmonic + filtfilt).
- Applied in `run_analysis` right after Fx/Fy/Fz extraction and rpm computation (the
  notch needs mean rpm), BEFORE metrics/series/fft/FRM/cache/octree — so every artefact
  is consistently filtered. `pulses_per_rev`-corrected rpm feeds the notch frequency.
- Row claim already returns per-op fields; add `filter_chain` and thread like
  `inner_diameter`. Applies to: process_file (full reprocess), octree emit, grid emit,
  viewport render.
- FRM header badge "⚙ filtered" (tooltip = chain summary) whenever `filter_chain` is
  non-null, in every mode.

## Error handling

- Service down / non-200 → filtered pane shows "filter service unreachable — raw only";
  compare stays usable (raw side), chain edits still saved.
- Invalid params (cutoff ≥ Nyquist at full rate, Q ≤ 0, window even) → validated in the
  UI and re-validated by the service (422 with a message).
- Preview-skipped stages (cutoff above the *decimated* Nyquist) surfaced as a chip:
  "LP 2 kHz not visible at preview resolution — bake applies it fully".
- Bake failure → existing status='error'/error_message path; chain kept for retry.

## Testing

- **Parity**: pytest generates synthetic signals (noise + drift + tone at f_spindle·k +
  spikes), runs the scipy chain; MATLAB harness runs `frm_filters` on the same CSV; assert
  RMS difference < 1e-6 of signal RMS per stage and for the full chain.
- **Service**: unit tests for chain validation, D1LC round-trip, decimation, LRU.
- **Client**: Playwright — enable a chain → two viewports appear, linked pan (drag one,
  compare canvas transform states), badge renders; profile save/load round-trip;
  service-down path shows the notice (stop the container).
- **Bake**: integration on a small op — bake with LP → FRM PNG + cache regenerate;
  clear + re-bake → raw restored (hash/points compare).

## Open defaults (changeable at review)

- Preview `target_points` 1.5 M; debounce 400 ms; service LRU 4 caches.
- Despike window 11 / 5σ; detrend HP 5 Hz; LP 2 kHz order 4; notch Q 30, harmonics 1–3.
- Chain badge text "⚙ filtered"; compare split 50/50.
