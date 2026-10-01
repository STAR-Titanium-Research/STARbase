# Diagnostics Workbench — design

**Status:** implemented — phases 1–6 shipped 2026-08-30 → 2026-09-01 (`scripts/diag/`,
`packages/force-plotting/src/DiagnosticsWorkbench.vue`). The UI and pipeline-structure portions
are superseded by [`2026-09-01-diagnostics-recipe-workbench-design.md`](./2026-09-01-diagnostics-recipe-workbench-design.md);
the science here remains authoritative.

## Motivation

The force app records and plots cuts, but every judgement about a cut is currently made by
eye: the operator looks at the FRM spiral and decides whether a coloured region is a
macrozone, a chatter burst, a tool-wear trend, or nothing. Nothing in the app quantifies
that judgement, and nothing links a feature seen in the spatial map back to the moment in
the signal that produced it.

This design adds an **advanced analysis window** that:

- separates the repeatable part of a cut (tool, runout, fixture) from the non-repeatable
  residual, which is where material variation actually lives;
- scores that residual statistically, so "this looks like a macrozone" becomes a hotspot
  with a p-value rather than an impression;
- links the 1D signal, the frequency content, and the 3D point cloud bidirectionally, so a
  spatial selection highlights the corresponding time segments and vice versa;
- is honest about what the dynamometer can and cannot measure, rather than presenting
  structural resonance as if it were cutting force.

## Goals

- A shared `DiagnosticsWorkbench` component in `packages/force-plotting`, mounted in **both**
  hosts (Directus admin module and the standalone force app) through the existing `ForceHost`
  interface.
- Server-side analysis as a **third octree variant** per operation, following the grid-octree
  precedent — new surface area kept small, existing artefacts untouched.
- A per-point analysis attribute set (`D1AN`) carried as LAS extra dims, so the existing
  `FrmOctree` shader renders anomaly channels with a uniform change and no new rendering
  architecture.
- Angular-domain (order) analysis and time-synchronous averaging, driven by the `revs_cum`
  the pipeline already computes.
- Bidirectional brushing between the signal, spectrum, and spatial panels.
- Explicit bandwidth validity: a quantitative band and a separate event band, labelled.

## Non-goals / deferred

- **PointNet++ / U-Net segmentation** — no labelled data exists; obtaining it needs
  destructive EBSD. Rejected for this design, not deferred.
- **CWT / synchrosqueezing, EMD / HHT** — deferred. Order tracking plus TSA addresses the
  non-stationarity these were proposed for, without their parameter sensitivity.
- **LOF** — superseded by HDBSCAN's GLOSH score, which needs no `k` and comes free with the
  clustering already required.
- **FRF estimation** — the worker *applies* a supplied H matrix; measuring one is a bench
  procedure, out of scope.
- **Real-time analysis during recording** — see Component 8.
- **Ground-truth correlation** (metallography / EBSD registration) — a researcher workflow,
  not an app feature. The app records provenance so it is possible; it does not perform it.

## Architecture / data flow

```
                     process_force.m   (UNCHANGED — sole owner of geometry)
                                |
                   D1LC cache + D1OC spiral binary
                                |
force_orchestrator.py  (new diag handler, near-clone of process_octree_row)
    D1LC + D1OC
      --> [H-matrix FRF] --> [frame transform] --> [validity split]
      --> angular resample --> TSA --> residual --> radial detrend
      --> Getis-Ord Gi* + HDBSCAN/GLOSH
      --> D1AN binary + metrics JSON
      --> laspy LAS (float32 extra dims) --> PotreeConverter
      --> infra/octrees/diag/<op_id>/   + DB diag_* columns

DiagnosticsWorkbench  (packages/force-plotting, both hosts)
    diag octree     --> FrmOctree shader (channel uniform)   [visual detail]
    D1AN decimated  --> WorkingSet (>= 5M points)            [selection + stats]
    metrics JSON    --> Panels C / D
```

The raw-spiral octree, grid octree, live cloud, FRM PNGs, and `process_force.m` are all
**unchanged**. The diag octree is a third variant per op, built on demand.

## Component 1 — orchestrator handler

New handler in `scripts/force_orchestrator.py`, mirroring `claim_octree` / `process_octree_row`
/ `handle_octrees`:

- `claim_diag(conn, limit=1)` — `WHERE diag_status='pending'`. **Concurrency 1**: this host
  also serves Directus, and a clustering run that starves the database mid-experiment is
  worse than a slow queue.
- `process_diag_row(...)` — runs the analysis (Component 3), writes `D1AN`, converts to LAS,
  runs PotreeConverter, publishes to `OCTREE_DIR/diag/<op_id>/`.
- `handle_diags(conn, ...)` — wired into `run_queue` and the daemon loop beside
  `handle_octrees` / `handle_grids`.

New columns on the analysis row: `diag_status`, `diag_path`, `diag_points`, `diag_version`,
`diag_metrics` (jsonb). `diag_version` lets a re-analysis with changed parameters be detected
and re-queued without a schema change.

Reuses `_patch_octree_climits` for colour limits, and `_read_octree_bin` generalised to accept
the `D1AN` magic.

## Component 2 — language split

Analysis is **Python**, not MATLAB, and consumes what MATLAB already emits.

`process_force.m` remains the single source of truth for geometry — spiral, cut window, drift
compensation. Reimplementing that in Python is exactly the divergence risk the codebase already
guards against elsewhere (see the live-spiral / live-cache geometry note in `app/dsp.py`). The
new worker recomputes **no geometry**: it reads `revs_cum`, `t`, and the force axes from the
D1LC cache, and the spatial `(x, y)` from the D1OC binary.

Statistics go where the libraries are: `scikit-learn >= 1.3` supplies `cluster.HDBSCAN` and
its cluster-membership probabilities; spatial statistics are implemented directly on
NumPy/SciPy.

## Component 3 — the analysis pipeline

```
D1LC (cut window: t, Fx, Fy, Fz, rpm, revs_cum)
  |
  +-- [optional] H-matrix FRF correction        (from the setup record)
  +-- frame_transform -> Fc / Ff / Fp           (Component 4)
  +-- VALIDITY SPLIT
  |     quantitative band (< f_n/5) -> forces, coefficients, statistics
  |     event band (resonance)      -> band-pass -> Hilbert envelope -> env_band
  |
  +-- angular resample: np.interp(uniform_revs, revs_cum, sig)
  |     +-- order spectrum   (integer orders = process, non-integer = chatter)
  |     +-- TSA over revolutions
  |           +-- mean signature  (tool / runout = the expected cut)
  |           +-- tsa_resid       <-- the anomaly substrate
  |
  +-- radial detrend -> resid_z
  |     (MUST precede any global outlier statistic: in face turning the cutting speed
  |      changes continuously with radius, so undetrended force carries a deterministic
  |      radial trend that any outlier detector will rediscover as "the middle of the
  |      part differs from the edge")
  |
  +-- spatial statistics on (x, y, resid_z)
        +-- Getis-Ord Gi* + Benjamini-Hochberg FDR -> gi_star, gi_sig
        +-- HDBSCAN on a grid-reduced set -> cluster_id, glosh

  event band:
  +-- band-pass around the dynamometer's structural resonance -> Hilbert envelope
        -> envelope spectrum -> env_band, refused (not aliased) when the effective
           Nyquist can't support the requested band
```

**HDBSCAN scaling.** HDBSCAN is memory-bound well before it is slow and will not run directly
on the full cloud. The pipeline grid-reduces to a smaller representative set, clusters there,
then assigns the remaining points to clusters by an exact grid-cell lookup (an improvement on
"approximate nearest neighbour": the grid reduction step already knows exactly which cell each
point fell into, so broadcasting a cluster label back is a direct array index, not a search).
This is a required step, not a tuning knob.

**Envelope analysis.** Above `f_n/5` the dynamometer amplifies rather than measures. That band
is still useful for *event detection*: band-pass around the structural resonance, take the
Hilbert envelope, and the spectrum of that envelope reveals the repetition rate of whatever is
exciting the mode — a rate whose fundamental is not directly measurable. Amplitude in this band
is explicitly non-quantitative and is labelled as such everywhere it appears. This step runs on
the full-rate signal, not the angular-resampled data the rest of the pipeline works in, and must
refuse (recording why) rather than alias when the cut's effective Nyquist cannot support the
requested band around the resonance.

## Component 4 — frame transform

New module: `frame_transform(force_xyz, angle | None) -> (Fc, Ff, Fp)`, upstream of every
analysis.

- **Turning** — static rotation from mount geometry; `angle` is `None`.
- **Milling** — angle-dependent, driven by `revs_cum`.

One interface covers both. This matters beyond convenience: every cutting-force-coefficient
wear model is defined in the tool frame, the `Fc/Ff` ratio is a drift-immune wear indicator,
and radial detrending is natural in the tool frame and awkward in XYZ.

Requires mount angles per setup. A `tool_setup` record (or fields on the operation) owns the
mount geometry **and** the H matrix, so cuts reference a setup rather than each carrying a
near-duplicate FRF file. The FRF is setup-dependent (workpiece mass, fixturing), so binding it
to the cut would produce many near-identical files with no way to tell which was valid.

The workbench exposes a global frame selector (XYZ / Fc-Ff-Fp); everything downstream respects
it.

## Component 5 — the D1AN contract

The keystone: **the browser computes nothing.** It thresholds and highlights attributes the
server baked. This is what keeps a very large cloud interactive.

Two artefacts per op.

### 5.1 `D1AN` binary — per-point attributes, 1:1 with the diag octree's points

| Attribute    | Type | Meaning                                                   |
|--------------|------|-------------------------------------------------------------|
| `t`          | f32  | sample time — makes time-brushing a shader predicate     |
| `rev`        | f32  | revolution number (from `revs_cum`)                      |
| `x`          | f32  | spatial x (mm), self-contained WorkingSet data source    |
| `y`          | f32  | spatial y (mm)                                           |
| `tsa_resid`  | f32  | force minus the per-rev mean signature                   |
| `resid_z`    | f32  | radially-detrended robust z-score                        |
| `glosh`      | f32  | HDBSCAN outlier-score proxy (`1 - probabilities_`)       |
| `cluster_id` | f32  | cluster label; -1 = noise                                |
| `gi_star`    | f32  | Getis-Ord z-score                                        |
| `gi_sig`     | f32  | FDR-adjusted significance flag (0.0 / 1.0)               |
| `env_band`   | f32  | envelope amplitude in the resonance band, when computed  |

Stored as **float32 LAS extra dims**, matching both shipped handlers (`process_octree_row`
and `process_grid_row`).

Note the grid-octree *design doc* proposed int16-scaled extra dims, but the implementation
reverted to float32 and records why in `process_grid_row`: **PotreeConverter ignores the
extra-dim scale/offset and stores raw int16 codes**, so the viewer receives codes rather than
physical values. Do not re-attempt int16 packing without first confirming PotreeConverter
behaviour has changed. Storage cost is accepted in exchange for correctness.

`cluster_id` and `gi_sig` are integer-valued but are still carried as float32 for the same
reason; the shader compares them against exact small integers, which float32 represents
without error.

`FrmOctree.vue` already reads Fx/Fy/Fz as octree attributes and colours them through a custom
`ShaderMaterial` with an axis uniform. That uniform generalises from "axis" to "channel" and the
new attributes drop straight in — no new rendering architecture.

**No GLOSH here.** `sklearn.cluster.HDBSCAN` exposes `probabilities_` (cluster-membership
confidence) but not `outlier_scores_` (the actual GLOSH algorithm, only in the standalone
`hdbscan` package). `glosh` in this design is `1 - probabilities_` — a documented proxy, not
literal GLOSH. Adding the standalone package for real GLOSH would reintroduce the
native-compile dependency risk that choosing scikit-learn was meant to avoid.

### 5.2 Metrics JSON

Order spectrum, TSA mean signature, band energies, cluster summary table, bandwidth validity
limits, spatial uncertainty estimate, and full provenance: input file ids, `frf_id`, frame
transform parameters, analysis parameters, `diag_version`.

## Component 6 — interaction, and the LOD constraint

The octree is LOD-streamed, so **the browser never holds all points at full resolution**. A
flat client-side mask over full-resolution points is not available. Hence a dual
representation:

- **WorkingSet** — decimated typed arrays, **at least 5 M points**, held in memory. The analysis
  and selection substrate. Carries `point_id` back to full resolution for export.

  5 M is not an arbitrary floor: `process_force.m:43` already defaults `live_cache_points` to
  5,000,000 ("cache the cut window ~1:1 up to 5M"), and `_octree_threshold` falls back to the
  same constant. The workbench inherits it rather than inventing a second number.

  At 5 M points with nine f32 attributes plus `x`, `y` and `point_id`, the set is roughly
  240 MB. That is comfortable in a desktop browser or Electron renderer but is the dominant
  memory cost of the window, so the attribute set is loaded lazily: `t`, `x`, `y` and
  `resid_z` on open, the rest on first use by a panel that needs them.
- **Full octree** — visual detail only.

**Selections are predicates, not index lists.** Three sources, one type:

| Source                  | Predicate                                  | Evaluated      |
|-------------------------|---------------------------------------------|----------------|
| Time brush (Panel A)    | `t0 <= t <= t1`                            | shader uniform |
| Attribute threshold (D) | `glosh > x`, `gi_sig = 1`, `cluster_id = k`| shader uniform |
| Spatial lasso (Panel B) | polygon test                               | polygon uniform|

The first two evaluate directly in the shader, so highlighting works at every LOD with zero
mask upload. Statistics evaluate on the WorkingSet. This replaces the k-d tree a naive design
would need, and it is why selection-by-anomaly-value — the primary review workflow — costs
nothing extra.

Recompute runs in a **web worker**, debounced. The existing analysis code (`signalStats.ts`,
`liveCloud.ts`) is synchronous main-thread; brush-drag recompute there would jank badly.

Selections persist as named objects carrying the method and parameters that produced them, so
a region referenced in a write-up is reproducible.

## Component 7 — layout

Dockable panels via `grid-layout-plus`, poppable via `LivePanelWindow.vue` — both already in
the app, and popping lets the spatial view go to a second monitor.

```
+--------------------------------+------------------+
|                                | A: Signal        |
|  B: Spatial (hero, ~60%)       |  brush + frame   |
|     diag octree, channel       +------------------+
|     selector, cluster overlay  | C/D: tabbed      |
|                                |  Orders |Anomaly |
|                                |  Envelope|Clusters|
+--------------------------------+------------------+
| Selection Inspector: n / t-span / r-range / stats  |
+---------------------------------------------------+
| Bandwidth validity: quantitative < f_n/5 | event   |
+---------------------------------------------------+
```

Panel C carries the **order spectrum** (integer vs non-integer orders) and the **envelope
spectrum** in the resonance band, the latter labelled non-quantitative.

## Component 8 — local tier, deliberately thin

In the standalone app's FastAPI sidecar, against `.d1raw` before upload: cut-window detect,
clipping / validity flags, quick order spectrum, drift check.

Its only justification is that the operator is at the machine and the part is still in the
chuck. Everything else goes to the server.

**Hard rule: never runs during recording.** The acquisition loop writes 25 kHz x 10 channels
with a disk watcher that force-stops runs on pressure; a dropped sample is unrecoverable in a
way a slow analysis never is.

## Testing

- **Synthetic ground truth** — generate a spiral with an implanted anomaly at a known
  `(r, theta)`; assert the pipeline recovers its location within tolerance. This is the test
  that validates the science, not just the plumbing.
- **Angular resampling** — constant-RPM synthetic round-trips; varying-RPM collapses a swept
  tone to a fixed order.
- **Radial detrend regression** — a pure radial ramp with no implanted anomaly must yield zero
  significant hotspots. Guards the failure mode where the detector rediscovers geometry.
- **D1AN contract** — round-trip; float32 values preserved exactly.
- **Frame transform** — turning static rotation and milling angle-dependent rotation both
  verified against hand-computed cases.
- `vue-tsc --noEmit` run separately from vitest (vitest passing does not imply typecheck
  passing in this repo).

## Phasing

1. **Substrate** — frame transform, angular resampling, TSA residual, radial detrend, D1AN
   contract, diag octree handler. No UI; verifiable entirely by the synthetic-anomaly test.
2. **Workbench shell** — Panels A + B, WorkingSet, predicate selections, Selection Inspector,
   bandwidth annotation.
3. **Statistics** — Getis-Ord + FDR, HDBSCAN / GLOSH proxy, cluster overlay, Panel D.
4. **Event band** — envelope analysis, order spectrum, Panel C.
5. **Pass-to-pass differencing** — angular-domain alignment of two cuts. Cheap once phase 1
   exists, and the highest-information single feature for separating material from machine.
6. **Tool-setup record and the local tier** — the `tool_setup` record (mount geometry + H
   matrix) that `frame_transform`'s `mount_deg` and the FRF correction both depend on, and the
   local-tier sidecar work described in Component 8. Both were designed but deliberately not
   built in phases 1-4: `mount_deg` has shipped as a pass-through default (`0.0`) the whole
   time, meaning Fc/Ff are just a rotation of Fx/Fy by whatever default angle was passed in,
   not a real tool-frame decomposition, until this phase gives it a real value to rotate by.

## Input sample rate — resolved

D1LC is **decimated**, to a target set by `live_cache_points`. `process_force.m:43` defaults it
to 5,000,000; the orchestrator currently overrides it to 250,000 for the dashboard's live
cache. 250,000 points is far too coarse for order spectra or envelope analysis.

The diag handler therefore requests its **own** live cache at `live_cache_points >= 5,000,000`,
independent of the dashboard's, and records the resulting effective sample rate in the metrics
JSON.

This has a hard consequence the pipeline must enforce. For a long cut the decimation is real:
a 400 s cut at 25 kHz is 10 M samples, so a 5 M cache halves the rate to 12.5 kHz and the
effective Nyquist to 6.25 kHz. That still clears the quantitative band comfortably and still
clears a ~2 kHz resonance band — but it will not for every cut. **The pipeline must compute the
effective Nyquist and refuse (not silently alias) envelope analysis when it falls below the
configured resonance band**, recording the refusal in the metrics rather than emitting a
plausible-looking wrong answer.

## Open questions

1. **Dynamometer model**, so `f_n/5` is currently a placeholder. The validity limit must come
   from the setup record, not a constant.

## Note on this document's provenance

This spec was originally written and self-reviewed during Phase 1 brainstorming, but was
never committed — an oversight caught only once Phase 5 planning needed the Phase 5/6
descriptions it defines and discovered both this file and the master implementation plan
missing from disk with no commit history to recover from. Reconstructed from the
conversation's own record, including the self-review fixes (float32 extra dims, the
`live_cache_points` open question resolved) that were already applied to the original before
it was lost. Every phase's actual implementation (1 through 4, all committed and tested) was
built from the version this reconstruction matches.
