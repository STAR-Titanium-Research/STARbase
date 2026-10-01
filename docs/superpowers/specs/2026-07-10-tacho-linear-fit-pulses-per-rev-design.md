# Tacho linear fit + selectable pulses-per-rev

**Status:** implemented July 2026 — `scripts/matlab/process_force.m` (linear `tachorpm` fit,
`pulses_per_rev` option) and migration `20260710000086_force_pulses_per_rev.sql`.

## Problem

`tachorpm` (MATLAB Signal Processing Toolbox) currently runs with its defaults:
`FitType='smooth'` and `PulsesPerRev=1`. Two changes are needed:

1. The RPM fit between tacho pulses should be **linear**, not smooth, for both the
   canonical (non-live) force analysis and Live mode.
2. The number of tacho pulses per spindle revolution is not always 1 — the user
   needs to be able to set it, per operation, with a sensible global default.

Both `rpm` and its integral `revs_cum` feed the FRM geometry (canonical PNGs) and
the live point-cloud cache (`live_cache.bin`), so this touches the MATLAB
processing script, the orchestrator, two DB tables, and the dashboard's Live
editable-metadata panel.

## FitType → linear (hardcoded, not a toggle)

One-line change in `scripts/matlab/process_force.m`'s `tachorpm(...)` call: add
`'FitType','linear'`. This is not exposed as a setting — the user only wants the
better fit, not a choice between fits.

This changes the RPM *interpolation between pulses*, which is baked into
`revs_cum` at MATLAB time. There is no way to correct for it client-side in Live
mode — **existing rows only get the linear fit after a host reprocess**
(`--reprocess` / hitting "Process" in the dashboard). This is the same contract
already documented for other `process_force.m` changes: settings only affect
files processed after the change.

## Pulses-per-rev — global default + per-operation override

Unlike `FitType`, `PulsesPerRev` is a pure post-hoc divisor: `tachorpm` detects
pulse edges independently of the pulse count, then divides the derived rate by
`PulsesPerRev`. So `rpm` and `revs_cum` both scale by exactly `1/P`. This means:

- The canonical path (MATLAB) computes the **cache's `revs_cum` at `PulsesPerRev=1`**
  (raw pulse-edge revolutions), independent of any operation's actual PPR — keeping
  the live cache a PPR-agnostic artifact, the same way it's already Feed/Diameter-agnostic.
- The canonical **PNGs and `mean_rpm`** apply the real per-operation PPR by dividing
  before the FRM geometry / metric are computed.
- **Live mode can apply PPR as an instant client-side divisor** on the cached
  `revs_cum`, with no host round-trip — the same way Feed/Diameter/RPM-mode are
  already instant, editable, live-only until "Process" persists them.

### Schema

- `force_crawler_state.pulses_per_rev INTEGER NOT NULL DEFAULT 1` — admin-configurable
  global default, following the `series_points`/`live_cache_points` blueprint
  (migration pattern in `...079`/`...083`). Exposed in the `d1-force-crawler` admin
  module.
- `machining_force_analysis.pulses_per_rev INTEGER` (nullable) — the value actually
  used to produce that row's current PNGs/metrics. `NULL` means "used the global
  default at the time of processing." Editable in the Directus item form, same as
  other per-row overrides.

### Canonical (non-live) processing

- `process_force.m`'s `opts` struct gains `pulses_per_rev` (default 1, mirroring
  existing `opts.*` sampling settings).
- Inside the script: compute `rpm_raw` via `tachorpm(..., 'FitType','linear')` at
  the toolbox's native pulse detection (unaffected by PPR). Divide by
  `opts.pulses_per_rev` to get the `rpm` used for `mean_rpm`, `series.json`'s RPM
  envelope, and the FRM geometry (`ang_inc`, `rho_inc`) — all downstream consumers
  keep reading the same `rpm` variable they already do today, just now correctly
  scaled. `revs_cum` (the array written into `live_cache.bin`) is computed from
  **`rpm_raw`, not `rpm`** — it stays the raw, undivided (`PulsesPerRev=1`
  equivalent) cumulative revolutions. This is the one deliberate asymmetry: the
  cache's separate `rpm` array (informational only — it just seeds Live mode's
  "Constant RPM" default guess) stays the real per-op value like today, while
  `revs_cum` (the only array the FRM geometry actually reads) is kept
  PPR-agnostic so the client can apply any divisor to it.
- `force_orchestrator.py`:
  - `DEFAULT_SAMPLING` gains `"pulses_per_rev": 1`.
  - `load_sampling_opts` selects `force_crawler_state.pulses_per_rev`.
  - `claim_batch`'s `RETURNING` gains `a.pulses_per_rev` (row override, mirroring
    `live_render_points`).
  - `process_file`: if the row has a non-null `pulses_per_rev`, it overrides the
    global value in `matlab_opts` for that file only (mirrors the existing
    `live_render_points` → `live_cache_points` override).
  - `ingest`: after a successful run, write the **effective** `pulses_per_rev` used
    (row override if set, else the global default that was active) back into
    `machining_force_analysis.pulses_per_rev`, so the row always records what
    actually produced its current PNGs — never left NULL after a real run.

### Live mode (dashboard)

- `d1-force-dashboard`'s live editable-metadata panel gains a "Pulses/rev" number
  input (integer, min 1) next to Feed/Diameter, seeded from
  `row.pulses_per_rev ?? 1` — same seeding pattern as `editFeed`/`editDiam`.
- `liveCloud.ts` `buildCloud`'s **measured** branch divides by PPR:
  `r = (revs[i] - revsCs) / P`. The constant-RPM/constant-Vc models are analytic
  (don't read the tacho) and are unaffected by PPR.
- The Force/RPM envelope strips (the top charts) are **not** touched — they
  always render the canonical baked `series` JSON regardless of Live mode, the
  same way Feed/Diameter edits already don't affect them today. Only the FRM
  spiral (driven by the cached `revs_cum`) recomputes client-side.
- **PPR in Live mode is preview-only**, exactly like Feed/Diameter today: the
  "Process" button's PATCH already only sends `status`+`live_render_points` — it
  never persists the browser's edited Feed/Diameter back to the row, and a
  reprocess re-derives canonical outputs from whatever is *already stored* in the
  DB, not from the live edits. PPR follows the same contract with no
  special-casing: to actually change an operation's real PPR, the user edits
  `machining_force_analysis.pulses_per_rev` directly on the item (outside Live
  mode, like `feed`/`cut_diameter`), then triggers a reprocess (the dashboard's
  Process button, or the crawler's `--reprocess`). The Live "Pulses/rev" input
  is purely a what-if divisor on the cached `revs_cum` for exploring the FRM
  before committing to a real value.

## Non-goals

- No UI for `FitType` — it's a one-line hardcode.
- No retroactive migration of existing rows' PNGs/metrics — they keep whatever
  `FitType`/PPR produced them until reprocessed, per the existing
  "settings only affect future files" contract already documented for
  `force_crawler_state`.
- No change to the constant-RPM / constant-Vc Live speed models — PPR only
  applies to the "measured" (real tacho) mode.

## Testing

- MATLAB: unit-level smoke test not practical without a real archive `.mat`, but
  verify the FitType/PulsesPerRev options are passed correctly (existing
  `try`/`catch` fallback path around `tachorpm` still applies if the toolbox call
  errors).
- `liveCloud.ts`: extend existing test coverage (if any) or manually verify in
  `tests/ui/specs/11-force-dashboard.spec.ts` that toggling Pulses/rev changes the
  FRM cloud's angular density as expected (P=2 should halve apparent revolutions
  for the same tacho signal).
- Orchestrator: exercise the per-row override path the same way
  `live_render_points` is already exercised (set `machining_force_analysis.pulses_per_rev`,
  confirm `process_file` passes the overridden value to MATLAB).
