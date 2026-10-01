# Milling groundwork: path models, spindle angle, and the polar plot

**Date:** 2026-09-07
**Status:** implemented 2026-09-07, released in force-app v0.1.19. The milling path models still
have no live data source (see [`apps/force-app/README.md`](../../../apps/force-app/README.md)).
**Scope decision:** groundwork + a working polar plot, designed against the schema only — no
hardware in the loop, no real capture to validate against in this pass.

## Why

The force app was built for turning. Every piece of geometry in the point-cloud visualiser
assumes a face-turning spiral: `liveCloud.ts` computes `θ = 2πr`, `ρ = D/2 − F·r` and converts to
Cartesian, and `Cloud.pos` is a **stride-2** array because there is no third dimension to carry.
Milling breaks all three assumptions:

- the path is not a spiral — today it is a straight flat pass, tomorrow it is whatever XYZ the
  machine controller reports;
- the useful quantity is **torque (Mz)**, which the channel model has no role for;
- a rotating dynamometer measures in a frame that **rotates with the tool**, so the raw Fx/Fy are
  not feed and normal forces until they are rotated through the immersion angle φ.

This design puts a seam where the spiral is hardcoded, adds the angle machinery that both the
polar plot and the frame transform need, and plumbs Mz through as a channel. It deliberately does
**not** implement the v2 multi-rate stream schema
([2026-07-27-force-capture-v2-schema-design.md](2026-07-27-force-capture-v2-schema-design.md)) —
that transition is planned separately, and this work is shaped to slot into it rather than
duplicate it.

## Source material

Three manuals, read 2026-09-07. The facts this design leans on:

| Fact | Source |
|---|---|
| RCD is 4-component: Fx, Fy, Fz, **Mz**. Coordinate frame **rotates with the tool** | 9170B §3.1, §8.1 |
| Feed force Ff is **not measured** — recover it from Fx/Fy via immersion angle φ; only at φ=90° do the frames coincide | 9170B §8.1.1, Fig. 36/37 |
| Polar plot = radius from Mz / Fz / Fxy, angle from *reference* channels Fx and Fy | PTS App §5.5.7.2.7, Fig. 65 |
| Tooth-passing frequency `f = (n/60)·N`; stay below f_n/5 (<5 % error) or f_n/3 (<10 %) | 9170B §6.4.2 |
| Natural frequencies ≈2 kHz (X/Y), ≈5.3 kHz (Z) for a bare 9170B; **400–500 Hz** for the older RCD once installed in a spindle | 9170B §10.1, 9123C §5.4 |
| Fz drifts with rpm² (centrifugal), non-linearly with temperature, and −1600 N at 70 bar internal coolant | 9170B §7.1, §7.3, §7.4 |
| Zero-count / index pulse (5223B ch 6) aligns to a **chosen cutting edge** — gives tooth identity, needs ≥4 kHz sampling vs the 1 kHz AA filter on force channels | 9123C §5.6, §5.8 |
| Analog out ±10 V, channels 1–5, D-Sub 15, **differential** wiring | 9123C §5.8 |

The last row is why the NI-DAQ-first assumption holds: the amplifier hands us voltages, and the
existing `sources/nidaq.py` path is the right entry point. Nothing in this design talks to Kistler
software.

## Non-goals

- The v2 multi-rate `.mat` schema. `machine_xyz` is designed and unit-tested; it has no real data
  source until v2 lands.
- The index-pulse angle source. It gets a named slot and a typed "not implemented" error, nothing
  more — it needs a hardware channel and a sampling-rate change we cannot validate yet.
- Changing the recorder's fixed 9-column layout. A rotating-dyno config can be **authored and
  persisted** after this work; **starting a recording with one is refused with a clear message**
  until v2 supplies variable columns.
- The finished-capture Plot dashboard. The polar plot lands as a live Record panel with a pop-out;
  the dashboard reuses the same component in a later pass.

---

## Protecting what works today

This work refactors the core of a visualiser that people rely on. **Turning capture, the FRM
fingerprint, playback, compare mode and the finished dashboard must come out the other side
bit-for-bit unchanged.** That is a hard constraint, not an aspiration, and it is enforced four
ways.

### The existing suites are the gate, and their assertions are frozen

There is already a real safety net, written after real bugs:

| Suite | Count | What it protects |
|---|---|---|
| `packages/force-plotting/src/liveCloud.test.ts` | 13 | The "must return null, never NaN" contract — written after the live FRM map rendered **solid white** from NaN vertex colours on a degenerate cache, and after the stride/decimation bug. |
| `packages/force-plotting/src/liveCache.test.ts` | 14 | D1LC parsing and `decimateCache` parity. |
| `apps/force-app/desktop/tests/*.spec.ts` | 6 specs | `panel-fit` and `replay-playback` exercise the real FRM render path; plus `smoke`, `save-flow`, `captures-tab`, `logs-tab`. |
| `apps/force-app/backend/tests` | — | Channel model and writers. |

**Rule: no assertion in those files may be weakened, deleted, or "updated to match the new
behaviour".** The only edit permitted is mechanical adaptation of the `makeCache()` / `baseParams()`
helpers in `liveCloud.test.ts` to the new `CloudParams` shape — the helpers change, the
expectations do not. If an existing assertion genuinely cannot pass, **stop**: that is an
unintended behaviour change, and it gets raised rather than edited away. This is the one rule in
this document most likely to be quietly broken under time pressure, so it is stated first.

### Characterisation before refactor

Step 0, committed *before* `path.ts` exists: add `liveCloud.golden.test.ts` capturing the output of
**today's** `buildCloud` across a parameter matrix — all three speed models, gridded and raw,
`stride` ∈ {1, 5}, `innerDiam` ∈ {0, 20}, `zSeries` on and off, crop windows that do and do not
truncate. Assert on the full `pos` / `col` arrays with `toEqual` (Float32 bit-equality), not on
summary statistics. The refactored `buildPath` + `buildCloud` must reproduce them exactly.

Golden values are generated from the current implementation and committed as fixtures **in the
pre-refactor commit**, so the diff that changes the geometry code cannot also change what
"correct" means.

### Additive-only changes, defaults unchanged

- **`turning_spiral` is the default path model.** A capture with no path configuration renders
  exactly as it does today.
- **D1LC v1 files keep parsing to today's exact `Cache`.** Version 2 is written only when extras
  are non-empty, so every writer's output for existing captures is byte-identical — asserted by
  hashing `write_d1lc` output against a committed fixture. MATLAB stays on v1 in this pass.
- **`FrmCloud`'s prop surface is unchanged** (see §3); `axis` survives as a deprecated alias, so
  the four existing `frmAxis` toggles keep working untouched.
- **The default Record panel layout does not gain the polar panel.** It is opt-in via "add panel",
  like every other multi-instance panel.
- **Persisted workspace state migrates by omission**: missing `polarRadius` / `polarAngleSource` /
  `polarBins` take defaults; unknown keys are ignored. An existing saved layout loads identically.
- **Untouched, explicitly:** `FrmOctree.vue`, the diagnostics workbench and its `.d1an` path, and
  the filter-service compare flow — except that `decimateCache` must stay in parity, which the
  existing tests already check.

### Sequencing, so a bad step is one revert

1. Characterisation goldens (no production code changes).
2. `path.ts` + `angle.ts` + `polar.ts` as **new, unused** modules with their own tests. Nothing
   imports them; nothing can break.
3. The `buildCloud` refactor and stride-3 change — **one commit, zero new features**, gated on the
   goldens plus the frozen suites. This is the only risky step, and it is independently revertable.
4. D1LC v2 (additive), channel model, then the polar panel and its wiring.

### Acceptance gate before any of this is called done

`npm run test --workspaces` and `npm run typecheck --workspaces` green from the repo root; backend
pytest green; the six desktop Playwright specs green; and a visual confirmation that an existing
capture's FRM map renders identically to a pre-change screenshot. Evidence — actual command output
— before the claim, not after.

---

## Architecture

```
                     ┌──────────────┐
   live_cache.bin ──▶│  parseCache  │──▶ Cache { t, Fx, Fy, Fz, rpm, revs, Mz?, X?, Y?, Z? }
   (D1LC v1 or v2)   └──────────────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
        ┌────────┐    ┌──────────┐   ┌──────────┐
        │ path.ts│    │ angle.ts │   │ polar.ts │
        │positions    │ φ per    │   │ (r, φ)   │
        │ stride-3    │  sample  │   │  pairs   │
        └────┬───┘    └────┬─────┘   └────┬─────┘
             │             │              │
             ▼             ▼              ▼
      ┌─────────────┐  ┌───────────┐  ┌──────────┐
      │ buildCloud  │  │ fixedFrame│  │PolarPlot │
      │ (colourise) │  │ Ff / FfN  │  │  .vue    │
      └──────┬──────┘  └───────────┘  └──────────┘
             ▼
        FrmCloud.vue
```

Four new pure modules, one widened parser, one refactored `buildCloud`, one new renderer, one new
panel. Every pure module is unit-testable against fabricated `Float32Array`s with no cache file
and no hardware.

---

## 1. `packages/force-plotting/src/path.ts` — new

The seam. Position generation moves out of `buildCloud` entirely.

```ts
import type { Cache } from './liveCache';

export type PathKind = 'turning_spiral' | 'linear_feed' | 'machine_xyz';
export type SpeedMode = 'measured' | 'rpm' | 'vc';   // re-exported from here; liveCloud re-exports for compat

export interface PathWindow {
  cropStartSec: number;
  cropEndSec: number;
  stride: number;          // client-side thinning, >= 1
}

export interface TurningSpiralParams {
  kind: 'turning_spiral';
  feed: number;            // mm/rev
  diam: number;            // mm
  innerDiam: number;       // mm — spiral stops here (0 = solid disc)
  speedMode: SpeedMode;
  rpm: number;             // constant-RPM model
  vc: number;              // constant-Vc model, m/min
  timeScale: number;       // rate override for rpm/vc models (1 = cache Fs)
  ppr: number;             // pulses per rev — divides raw revs_cum in 'measured' mode
}

export interface LinearFeedParams {
  kind: 'linear_feed';
  feedRate: number;        // mm/min along +X
  timeScale: number;       // rate override, mirrors the spiral models
  yOffset: number;         // mm — constant Y for this pass (0 for a single pass)
  zOffset: number;         // mm — constant Z (axial depth reference), informational
}

export interface MachineXyzParams {
  kind: 'machine_xyz';
  xKey: 'X' | 'Y' | 'Z';   // which optional cache array feeds each axis
  yKey: 'X' | 'Y' | 'Z';
  zKey: 'X' | 'Y' | 'Z';
  scale: number;           // mm per stored unit (default 1)
  origin: 'first_sample' | 'absolute';
}

export type PathParams = TurningSpiralParams | LinearFeedParams | MachineXyzParams;

export interface PathBounds {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export interface PathResult {
  pos: Float32Array;   // stride 3 — [x0,y0,z0, x1,y1,z1, ...]
  idx: Int32Array;     // cache index of each emitted point (colour maps back through this)
  count: number;
  bounds: PathBounds;
}

/**
 * Build the tool path for one crop window. Returns null for a degenerate cache
 * (N === 0, empty t, or a crop that selects nothing) — callers MUST handle null.
 */
export function buildPath(c: Cache, p: PathParams, w: PathWindow): PathResult | null;
```

### `idx` is the important part

`buildPath` emits, per point, the **cache index it came from**. That is what makes colouring
independent of geometry: `buildCloud` reads `Faxis[idx[k]]` rather than assuming the k-th point is
the k-th sample. It is also what keeps the spiral's early-break correct — when `ρ` falls below the
inner radius the loop stops, `count` shrinks, and no downstream code has to know why.

### Model semantics

**`turning_spiral`** — lift the existing loop from `liveCloud.ts:112-132` verbatim. Same three
speed models, same `K = F·Vc·1000/(π·120)`, same early break on `ρ < innerR`. `z = 0` for every
point. This must be a behaviour-preserving move: existing FRM output is byte-identical.

**`linear_feed`** — `x = (feedRate / 60) · (t[i] − t[cs]) · timeScale`, `y = yOffset`,
`z = zOffset`. Straight, flat, constant feed. It is deliberately trivial; it exists so the current
milling passes render on the same code path the machine data will use, rather than through a
special case bolted onto the spiral.

**`machine_xyz`** — read `c[xKey]`, `c[yKey]`, `c[zKey]`, multiply by `scale`. Under
`origin: 'first_sample'`, subtract the value at the crop-start index from each axis so the path is
relative to where the cut began; under `'absolute'`, use machine coordinates as-is. If any named
array is absent from the cache, **return null** — do not silently fall back to zeros, which would
render a flat sheet that looks like real data.

> **Resampling.** Machine position arrives at 333 Hz (EVO 40) or 500 Hz (ECOSPEED) while force is
> sampled far faster. This design assumes the position arrays are **already resampled onto the
> force time base** before they reach the cache — that is a v2 ingestion responsibility, and the
> v2 spec's per-stream `time` vectors plus `time_sync_model` are what make it possible. `path.ts`
> must not attempt cross-rate interpolation; if the arrays are not length `N` it returns null.

---

## 2. `packages/force-plotting/src/angle.ts` — new

```ts
export type AngleSource = 'tacho' | 'force_vector' | 'index_pulse';

export interface AngleParams {
  source: AngleSource;
  ppr: number;             // tacho: pulses per rev
  offsetDeg: number;       // rotate φ=0 onto a chosen tooth
  direction: 1 | -1;       // spindle sense
  engagementN: number;     // force_vector: |Fxy| below this ⇒ φ is NaN
}

/**
 * Spindle angle φ in radians, wrapped to [0, 2π), one value per emitted point.
 * `idx` comes from PathResult (or a plain index run for non-spatial callers).
 * Writes into `out` (length >= idx.length). NaN marks "angle unknown here".
 */
export function spindleAngle(c: Cache, p: AngleParams, idx: Int32Array, out: Float32Array): void;
```

**`tacho`** — the angle is already in the cache and currently thrown away. `revs` is integrated
from the real tacho at full resolution, so
`φ = 2π · frac((revs[i] − revs[idx[0]]) / ppr)`, then apply `direction` and `offsetDeg`. This is
the default whenever a Tacho channel is bound. It stays correct while the tool is out of cut.

**`force_vector`** — `φ = atan2(Fy[i], Fx[i])`, which is what the PTS manual specifies ("reference
force signals Fx and Fy which have to be selected for X and Y directions"). It needs no tacho, and
it degenerates to noise when the tool is not engaged — the centre blob in the manual's own Fig. 65
is exactly that artefact. Guard it: when `hypot(Fx, Fy) < engagementN`, emit `NaN` and let the
renderer drop the point. Default `engagementN` to 2 % of the window's 99th-percentile |Fxy|.

**`index_pulse`** — throw `new AngleSourceUnavailableError('index_pulse')`, a typed export. The
5223B's zero-count channel gives tooth *identity*, not just angle, and needs ≥4 kHz sampling
against a 1 kHz anti-aliasing filter on the force channels. Documented slot; no guesswork.

### Rotating → fixed frame transform

Same module, since it consumes the same φ:

```ts
export interface FixedFrame { Ff: Float32Array; FfN: Float32Array }

/** RCD §8.1.1: rotate the tool-frame radial forces into the workpiece frame. */
export function toFixedFrame(
  fx: Float32Array, fy: Float32Array, phi: Float32Array, idx: Int32Array,
): FixedFrame;
```

with

```
Ff  =  Fx·sin φ + Fy·cos φ
FfN = −Fx·cos φ + Fy·sin φ
```

Sanity check the implementer should assert in a test: at φ = 90°, `Ff = Fx` and `FfN = Fy`, which
is the one alignment the manual states explicitly (Fig. 37).

> **Verification debt.** The sign convention and the φ zero-offset depend on which way the spindle
> turns and where the tool's reference edge sits relative to the dynamometer's engraved X marking.
> This is correct as a rotation; it is **not** verified against a real cut. `offsetDeg` and
> `direction` exist precisely so it can be calibrated later without touching the maths. Say so in
> the code comment — do not present it as settled.

---

## 3. `buildCloud` refactor — `liveCloud.ts`

`buildCloud` becomes *positions × colours* and nothing else.

```ts
export type CloudChannel = 'Fx' | 'Fy' | 'Fz' | 'Mz';
export type Axis = 'Fx' | 'Fy' | 'Fz';          // UNCHANGED — still the three force axes

export interface CloudParams {
  channel: CloudChannel;        // was `axis: Axis`
  path: PathParams;
  window: PathWindow;
  gridding: boolean;
  gridN: number;
  colormap: (x: number) => [number, number, number];
  cmin?: number | null;
  cmax?: number | null;
  zSeries?: 'none' | CloudChannel;   // force-as-height overlay; ignored when path.kind === 'machine_xyz'
}

export interface Cloud {
  pos: Float32Array;            // NOW STRIDE 3
  col: Float32Array;            // stride 3, rgb 0..1
  count: number;
  bounds: PathBounds;           // replaces the four min/max fields
  cmin: number; cmax: number;
  zv?: Float32Array;            // centred −0.5..0.5 force-as-height, only for flat paths
}
```

**Deliberate call: `Axis` stays a three-member union.** It is re-declared in four places
(`liveCloud.ts`, `record/types.ts`, `record/workspace.ts`, and derived in `ForceDashboard.vue` /
`WearTrend.vue`) and carries `AXIS_COLOR` / `CH_COLOR` semantics that torque has no business in.
Widening it would ripple through unrelated code. `CloudChannel` is the wider union, introduced
where the wider set is actually needed, and it is the only one `buildCloud` and the polar plot
speak. This is a smaller blast radius than a global widening and it keeps `Fx|Fy|Fz` meaning
"force axis" everywhere it already does.

`axisAutoLimits(c, axis)` widens to accept `CloudChannel` and returns `[0, 1]` when the named array
is absent — same defensive shape it already has for empty arrays.

### `gridCloud` must stop dropping Z

Today `gridCloud` bins on x/y, averages force per cell, and returns **no `zv` at all** — so
gridding plus height is currently impossible, not merely unimplemented. Fix it as part of this
work: bin on X/Y as now, and emit each cell at `(cellCentreX, cellCentreY, meanZ)` using the mean
of the real Z of the points in that cell. For a flat path every Z is identical and behaviour is
unchanged; for `machine_xyz` the gridded view becomes a genuine 2.5-D surface. Document that this
is a **2.5-D** reduction: a path that revisits the same XY at two different Z (a second axial pass)
collapses into one cell. That is a real limitation, not a bug to hide — a true 3-D voxel binning is
a later question.

### Consumers to update

| Site | Change |
|---|---|
| `FrmCloud.vue:310` | Deletes the stride-2 → stride-3 repack loop; hands `cloud.pos` straight to a `BufferAttribute(pos, 3)`. This is a **simplification**, not extra work. |
| `FrmCloud.vue` view/fit maths | Reads `cloud.bounds` instead of `minX/maxX/minY/maxY`. Camera fit stays 2-D (X/Y) — orbiting in true 3-D is a follow-up, not this pass. |
| `FrmCloud.vue` `zScale` handling | Applies only when `cloud.zv` is present; a `machine_xyz` cloud has real Z and the exaggeration control hides. |
| `frmExport.ts` | **Implemented as: no change.** It builds its own `{xmin,xmax,ymin,ymax}` from `fitCx`/`fitSpan`, never touching `Cloud.bounds` directly — confirmed during implementation. |
| `record/playback/engine.ts` | **Implemented as: no change.** It only calls `axisAutoLimits(cache, axis)` with an `Axis`-typed value; `Axis ⊂ CloudChannel`, so it type-checks unchanged — confirmed via `npm run typecheck -w force-app-web`. |
| `FrmOctree.vue` | **No change** — it renders host-baked octrees, not `Cloud`. |

**`FrmCloud.vue` keeps its flat prop surface.** It currently takes `feed`, `diam`, `innerDiam`,
`speedMode`, `rpm`, `vc`, `timeScale`, `ppr`, `cropStartSec`, `cropEndSec`, `stride` as individual
props, and three call sites pass them (`FrmPanel.vue`, `LiveFrm.vue`, `LivePanelWindow.vue`, plus
`ForceDashboard.vue`). Do **not** churn those: `FrmCloud` assembles a `turning_spiral` `PathParams`
from its existing props internally, and gains one optional `path?: PathParams` prop that overrides
them when supplied. New callers pass `path`; every existing caller is untouched. The `axis` prop
widens to `channel?: CloudChannel` with `axis` retained as a deprecated alias for one release, so
the four `frmAxis` toggles keep working unchanged.

---

## 4. D1LC cache format — `liveCache.ts`, `d1lc.py`, `process_force.m`, filter-service

The header already carries a version field at offset 4 (`= 1`) that the TypeScript parser reads
past and ignores. Use it.

**D1LC v2** keeps the 32-byte header and the six mandatory arrays byte-identical, then appends a
trailer:

```
[32-byte header: magic, version=2, N, Fs, feed, diam, csSec, ceSec]
[float32[N] × 6: t, Fx, Fy, Fz, rpm, revs]        ← identical to v1
[uint32 extraCount]
  extraCount × { char[8] name (ascii, NUL-padded), float32[N] data }
```

Names in this pass: `"Mz"`, `"X"`, `"Y"`, `"Z"`. Readers **must ignore names they do not
recognise** — same rule the v2 `.mat` spec sets for roles, and the same rule that would have
prevented the "don't crash loading a bake made before Phase H slice 2's new columns" fix
(`6f5763a`).

```ts
export interface Cache {
  N: number; Fs: number; feed: number; diam: number; csSec: number; ceSec: number;
  t: Float32Array; Fx: Float32Array; Fy: Float32Array; Fz: Float32Array;
  rpm: Float32Array; revs: Float32Array;
  Mz?: Float32Array; X?: Float32Array; Y?: Float32Array; Z?: Float32Array;
  version: number;
}
```

`parseCache` reads the version, parses the six arrays exactly as now, and only then — `if
(version >= 2 && off < ab.byteLength)` — reads the trailer. **A v1 file must parse to exactly the
Cache it parses to today**, with the optional fields `undefined`. Add a regression test that feeds
a v1 buffer and asserts every existing field, so this cannot silently break.

`decimateCache` must decimate the optional arrays too — miss this and a compare-mode pane gets
positions and torque of different lengths.

Four writers stay in sync and the `d1lc.py` docstring already names them: `apps/force-app/backend/
app/d1lc.py`, `plugins/filter-service/app/d1lc.py`, `scripts/matlab/process_force.m::
write_live_cache`, and `liveCache.ts`. In this pass the two Python writers gain an **optional**
`extras: dict[str, np.ndarray] | None = None` parameter and write version 2 only when extras are
non-empty — so nothing that exists today changes format. MATLAB stays on v1 until it has extras to
write; note that explicitly in its comment.

---

## 5. Channel model — `backend/app/channels.py`

```python
ROLES = ["Fx", "Fy", "Fz", "Mz", "Tacho", "Index", "Aux"]
ROLE_COLOR = { ..., "Mz": "#f472b6", "Index": "#facc15" }

DYNO_STATIONARY = "stationary_8"   # Fx1 Fx2 Fy1 Fy2 Fz1..Fz4 — today's plate
DYNO_ROTATING   = "rotating_4"     # Fx Fy Fz Mz — RCD, four single components

ROTATING_ORDER = ["Fx", "Fy", "Fz", "Mz"]

def autoassign(devices: dict, kind: str = DYNO_STATIONARY) -> list[dict]: ...
```

`autoassign(kind=DYNO_ROTATING)` fills the first four AI with `Fx, Fy, Fz, Mz` (role = the name;
there are **no paired corners to sum** on a rotating dyno) then Tacho on the fifth. `Index` is
never auto-assigned — it is opt-in, because it needs a sampling rate the force channels do not run
at.

`dyno_gains` currently returns gains only when all eight named channels supply one; it needs a
rotating branch over `ROTATING_ORDER`. Mz's gain is **N·m/V**, not N/V — add a separate
`gain_nm_per_v` field on the channel dict rather than overloading `gain_n_per_v` with a different
unit. Two units in one field is the kind of thing that produces a plot that looks plausible and is
wrong by a factor of a thousand.

**`to_record_channels` refuses the rotating preset.** It maps into the recorder's fixed
`[Fx1..Fz4, Tacho]` layout, which has no slot for a single Fx or for Mz. Rather than mis-map, it
raises a clear error — "rotating-dyno configs need the v2 variable-column recorder; config is
saved but recording is not yet supported". A user can author, persist and inspect an RCD config
today; pressing Start says exactly why it stops. Silence here would be the worst outcome.

---

## 6. Polar plot

### `packages/force-plotting/src/polar.ts` — new, pure

```ts
export type PolarRadius = 'Mz' | 'Fz' | 'Fxy';

export interface PolarParams {
  radius: PolarRadius;
  angle: AngleParams;
  window: PathWindow;
  bins: number;        // 0 = raw scatter; >0 = angular bins, mean radius per bin
}

export interface PolarResult {
  r: Float32Array;     // radius value per point (units depend on `radius`)
  phi: Float32Array;   // radians, [0, 2π)
  count: number;
  rMin: number; rMax: number;
  unit: 'N·m' | 'N';
  dropped: number;     // points discarded for NaN φ (force_vector below engagement)
}

export function buildPolar(c: Cache, p: PolarParams): PolarResult | null;
```

`Fxy` is `hypot(Fx, Fy)`. `Mz` returns null when `c.Mz` is absent — the panel then shows "no torque
channel in this capture" rather than an empty circle. `dropped` is surfaced in the UI so a mostly
empty plot explains itself.

### `packages/force-plotting/src/PolarPlot.vue` — new

**Canvas 2D, not WebGL.** After striding, a polar view is thousands of points, not millions;
canvas keeps it simple, makes the axis furniture (radial grid, spoke labels every 30°, radius
ticks, colorbar) trivial, and exports to PNG through the same path `frmExport.ts` already uses.
Reuse `COLORMAPS`; colour by the radius value so the plot reads at a glance.

Props: `cache`, `params`, `colormap`, `pointSize`, `rMax` (null ⇒ auto from the 99th percentile,
matching the percentile clamping `buildCloud` already uses), `paneLabel`.
Emits: `loaded` (`{ count, dropped, rMin, rMax }`), `rlimits`.

Renders: filled circle grid, `N`-fold spoke overlay when a flute count is configured (a 4-flute
cutter should visibly produce the manual's 4 lobes), and a footer line stating the angle source in
use — `tacho` vs `atan2(Fy,Fx)` is the difference between a trustworthy plot and a suggestive one,
and the viewer must not have to guess which they are looking at.

### Wiring

| File | Change |
|---|---|
| `record/panels/PolarPanel.vue` (new) | Toolbar: radius (Mz / Fz / Fxy), angle source (tacho / force vector), bins, colormap, stride, pop-out button. Mirrors `FrmPanel.vue`'s shape. |
| `record/RecordPage.vue` | Add `polar` to `PANEL_TYPES` (multi-instance, like `force`), import and branch to `PolarPanel`. |
| `record/LivePanelWindow.vue` | Add `panel === 'polar'`, title "Live Polar", and the radius/angle controls in the header bar — matching the existing FRM branch, which is the pattern that fixed the "pop-out frozen at its opening URL" bug. |
| `record/workspace.ts` | `plot` gains `polarRadius`, `polarAngleSource`, `polarBins`. Persisted with the rest of the plot state. |
| `packages/force-plotting/src/index.ts` | Export `PolarPlot`, `buildPolar`, `buildPath`, `spindleAngle`, `toFixedFrame`, and the new types. |

The route needs no change: `/live/:panel` already takes a free-form panel name, so
`/live/polar?radius=Mz&angle=tacho` works the moment `LivePanelWindow` knows the branch.

---

## 7. Documentation

Add `docs/hardware/rotating-dynamometer.md` recording, with citations, what the manuals establish:
component set and ranges (Fx/Fy ±5 kN, Fz ±20 kN, Mz ±210 N·m nominal; four switchable ranges),
sensitivities per range, natural frequencies and the f_n/5 and f_n/3 rules, the tooth-passing
formula, the three drift mechanisms with magnitudes, the ±10 V differential analog interface, and
the zero-count channel's sampling requirement. These numbers are needed by the follow-up features
below and by anyone choosing cutting parameters; they should not live only in a PDF.

---

## Error handling

Every failure mode returns a value the UI can explain, never a silently wrong picture:

| Condition | Behaviour |
|---|---|
| Empty / degenerate cache (`N === 0`, empty `t`) | `buildPath` / `buildPolar` return `null`; panel shows "no data". This guard already exists in `buildCloud` and exists because NaN vertex colours painted the canvas solid white — keep it. |
| Crop selects nothing | `null`, same path. |
| `machine_xyz` with a missing or wrong-length position array | `null` + a distinct message. **Never** substitute zeros. |
| `Mz` radius on a cache without Mz | `null` + "no torque channel in this capture". |
| `force_vector` angle below engagement | per-point `NaN`, point dropped, `dropped` count shown. |
| `index_pulse` selected | typed `AngleSourceUnavailableError`; the option is disabled in the UI with a tooltip. |
| Rotating preset at record start | backend refuses with the v2 message; the UI surfaces it verbatim. |
| D1LC v1 file | parses exactly as today, optional fields `undefined`. |
| D1LC with unknown trailer names | ignored. |

---

## Testing

All Vitest, all against fabricated `Float32Array`s — no cache file, no hardware. This is what
"designed against the schema only" has to mean for it to be verifiable.

**`path.test.ts`**
- `turning_spiral` reproduces the current `buildCloud` geometry across the full parameter matrix —
  see **Protecting what works today → Characterisation before refactor**; those goldens are the
  binding assertion, not a summary check written here.
- Spiral breaks at `innerDiam`; `count` reflects it; `idx` still points at the right samples.
- All three speed models (`measured` / `rpm` / `vc`) against hand-computed values.
- `linear_feed`: 100 mm/min for 6 s ⇒ x spans 0…10 mm; y and z constant.
- `machine_xyz`: `first_sample` origin zeroes the start; `absolute` does not; a missing array
  returns null; a wrong-length array returns null.
- `stride` thins positions and `idx` consistently.

**`angle.test.ts`**
- Tacho: a linear `revs` ramp of 3 revolutions produces 3 monotonic sawtooths in [0, 2π); `ppr = 2`
  halves the count; `direction = -1` mirrors; `offsetDeg` rotates.
- Force vector: a synthetic rotating vector recovers its own angle to within 1e-5; amplitude below
  `engagementN` yields NaN.
- `index_pulse` throws the typed error.
- `toFixedFrame`: at φ = 90°, `Ff === Fx` and `FfN === Fy`; the transform preserves magnitude
  (`Ff² + FfN² === Fx² + Fy²`) at arbitrary φ.

**`polar.test.ts`**
- Synthetic 4-flute signal `Mz = A·(1 + 0.3·cos(4φ))` with a linear tacho ⇒ binned means show four
  maxima at the expected angles. This is the test that proves the plot would show the manual's
  Fig. 65 lobes.
- `Fxy` radius equals `hypot(Fx, Fy)`.
- Missing Mz ⇒ null.
- `dropped` counts NaN-φ points exactly.

**`liveCache.test.ts`** (extend)
- A synthetic v1 buffer parses to today's exact Cache, optional fields `undefined`.
- A v2 buffer with `Mz` + `X`/`Y`/`Z` populates them.
- A v2 buffer with an unknown trailer name is ignored without throwing.
- `decimateCache` decimates optional arrays to the same length as the mandatory ones.

**`liveCloud.test.ts`**
- Gridded cloud emits stride-3 positions and a mean Z per cell; a flat path is unchanged from
  today's output.

**Backend** — alongside the existing `apps/force-app/backend/tests`: `autoassign(kind=rotating)`
produces four single components plus Tacho; `to_record_channels` raises on a rotating config;
`dyno_gains` handles both presets and keeps N·m/V separate from N/V; `write_d1lc` with no extras is
byte-identical to today's output.

---

## Follow-ups this unlocks (not in this pass)

Queued in the order I would take them, each cheap **because** the angle and path machinery exists:

1. **Rotating → fixed frame as a derived channel.** `toFixedFrame` ships in this pass but nothing
   consumes it yet; exposing `Ff` / `FfN` as selectable channels in the force plot is the single
   highest-value thing for making milling data interpretable (RCD §8.1.1).
2. **Tooth-passing-frequency overlay** on the existing `LiveFft.vue` / `LiveSpectrogram.vue`:
   draw `f = (n/60)·N` and its harmonics, shade the f_n/5 and f_n/3 guard bands (RCD §6.4.2,
   Fig. 26). Needs one new config field — flute count — and reuses the FFT panel wholesale.
3. **Drift compensation** (PTS §5.5.7.2.3): two-point linear detrend, whole-signal or
   cursor-bounded. Motivated by all three RCD drift mechanisms; `scripts/diag/detrend.py` is the
   reference implementation to crib from.
4. **Polar plot on the finished-capture dashboard** — the component is already surface-agnostic.
5. **True 3-D orbit and voxel binning** for `machine_xyz` clouds, once real position data exists to
   justify it.

## Interface with the v2 stream schema

Nothing here blocks or duplicates v2; two seams are shaped to receive it:

- **`machine_xyz` consumes `X`/`Y`/`Z` arrays already on the force time base.** v2's per-stream
  `time` vectors and `time_sync_model` are what make that resampling well-defined. When v2 lands,
  the ingestion path fills the D1LC trailer and `machine_xyz` starts working with no client change.
- **`to_record_channels`'s refusal is the marker for v2's variable columns.** When v2 supplies
  them, that guard is the one place to change.
