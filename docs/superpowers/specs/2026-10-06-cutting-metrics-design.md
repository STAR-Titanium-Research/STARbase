# Cutting metrics card (P6)

**Status:** Implemented. Implementation: `packages/force-plotting/src/cuttingMetrics.ts`, the "Cutting
metrics" card in `ForceDashboard.vue` and the extra columns in `statsCsv.ts`.

## Problem

Signal statistics gives per-axis mean/RMS/min/max over the crop window. Machinists and materials
people ask different questions: how big is the cutting force, how much power does the cut take,
what is the specific cutting energy of this material. Today they copy numbers into a spreadsheet
and redo the arithmetic with the operation sheet beside them. The dashboard already holds every
input (forces, RPM, feed, depth of cut, diameter), so it should show the numbers, with units and
the formula, and say plainly when an input is missing.

## Metrics, formulas, units

All over the crop window (the same window as Signal statistics). Forces in N, lengths in mm.

| Metric | Formula | Unit |
|---|---|---|
| Resultant mean / peak | per sample `\|F\| = sqrt(Fx² + Fy² + Fz²)`; mean and max over the window | N |
| Fc, Ff, Fp (mean) | `\|mean\|` of the mapped axis | N |
| Fc, Ff, Fp (peak) | `max \|x\|` of the mapped axis | N |
| Cutting speed vc | `π · D · n / 1000` (D in mm, n in rpm) | m/min (divide by 60 for m/s) |
| Cutting power Pc | `Fc · vc / 60`, i.e. `Fc · vc[m/s]` | W |
| Specific cutting energy kc | `Fc / (ap · f)` | N/mm² (= MPa) |

Fc is the **mean** tangential force, so Pc and kc are mean values. Feed-force power is neglected
in Pc (the feed velocity is orders of magnitude below vc), the standard approximation. kc is the
apparent value for this one cut, not a material constant (it depends on chip thickness, tool
geometry and wear).

## Axis mapping (owner's standard, selectable, remembered per operation type)

The repo does not define it. `process_force.m` and `docs/force-file-standards.md` only say Fx and
Fy are the two horizontal plate axes and Fz the sum of the four vertical corners. `angle.ts` /
`toFixedFrame` is the milling (RCD, rotating-frame) transform and says nothing about turning
directions. The mapping depends on how the plate is mounted and on the workholding and operation.

Decision (2026-10-06, owner: "Axis mapping can change depending on the work holding and machining
operation. Standard is Fz as Fp and Fx as Fc."): the default is
**Fc (tangential, main cutting) = Fx, Ff (feed) = Fy, Fp (passive/radial) = Fz.** This replaces the
earlier guess (Fc = Fz, Ff = Fx, Fp = Fy).

- The card carries a select ("Axis mapping") with all six assignments and states the mapping in
  use, with a note that it depends on workholding and operation.
- The choice is remembered **per saved operation subtype** (MT-F, MT-O, ...; empty is `default`,
  any other subtype, recognised or not, gets its own entry; an unsaved edit of the Subtype field
  does not change the key) in localStorage key `d1.cuttingAxisMapBySubtype`, a JSON object
  `{ "MT-F": "Fz/Fx/Fy", ... }`. Subtypes without an entry use the standard. Unreadable or invalid
  entries are ignored. The old single key `d1.cuttingAxisMap` was chosen against the old default
  and is removed on first load.
- Every tooltip and the CSV (`axis_map` column) name the mapping used.
- Workholding itself is not modelled (it is not recorded with the operation); out of scope. The
  per-subtype memory is the proxy. Operators confirm the mapping per workholding and operation on
  the rig (physical test backlog, P6).

For face turning the feed and passive roles swap relative to longitudinal turning (feed is radial,
passive is along the spindle). Labels follow ISO 3002 (Fc, Ff, Fp); the select exists because the
physical orientation is not recorded anywhere.

## Inputs and where they come from

| Input | Source (fields the dashboard already fetches) | Notes |
|---|---|---|
| Fx, Fy, Fz | live cache, crop window | as Signal statistics |
| n (rpm) | **measured mean over the window** (`SignalStats.rpm.mean`) | not the target `machining_spindle_speed_rpm`; zero or non-finite is "unavailable", no silent fallback |
| D (mm) | the Diameter control (`editDiam`: per-op `outer_diameter` override, else cache header `CutDiameter`) | the spiral model's `D/2` is at the active crop start |
| f (mm/rev) | operation `machining_feed_mm_per_rev`, else capture `feed` | |
| ap (mm) | operation `machining_axial_depth_of_cut_mm`, else capture `depth_of_cut` | |
| operation type | `machining_operation_subtype` prefix: `MT` turning, `MM` milling (same rule as `opTypeCategory` in force-app-web) | |

**Which operations spiral.** Only facing (`MT-F`), grooving (`MT-G`) and parting (`MT-P`) move
the tool across the diameter (the spelled-out `MT-FACE`, `MT-GROOVE`, `MT-PART` forms are accepted
too; the codes are the Record page's `op_type` list). OD turning (`MT-O`), roughing (`MT-R`),
boring (`MT-B`), threading (`MT-H`) and drilling (`MT-D`) run at a constant diameter, so their vc
uses D as entered (D = 80 mm, n = 1000 rpm gives 251.3 m/min whatever the window). An earlier
version applied the shrinkage to every `MT*` subtype and understated vc and Pc on OD cuts.

**Facing spiral.** The diameter shrinks as the tool spirals inward at `f` per rev, so vc is not
constant. vc uses the diameter at the window midpoint:
`D_mid = D - 2 · f · n · (t_mid - t_origin) / 60`, with `n` the window's mean rpm and `t_mid` the
window midpoint. It must agree with the radial axis of the plots (`radialValuesFor` in
`ForceDashboard.vue`), so it takes the same inputs: `t_origin` is the **active crop start** (the
saved crop override when there is one, else the auto window, else the live crop; not the cache's
own crop start, which differs as soon as a crop is saved) and `f` is the **geometry feed**
(`editFeed`, the Geometry box) rather than the operation record's feed. kc keeps using the
operation's feed. If `D_mid <= 0`, vc is unavailable. With no usable geometry feed the shrinkage
cannot be computed, so vc uses D at the origin. The inner diameter and the plots' time-scale
control are not used here.

**Missing inputs.** Each metric is computed independently and is either a value or
`unavailable: <reason>` ("feed not recorded", "RPM is zero in this window", "diameter missing",
"depth of cut not recorded", "milling operation"). The UI shows "—" with the reason as tooltip;
the CSV leaves the cell empty.

**Milling.** Fc/Ff/Fp, vc, Pc and kc assume a turning geometry (one edge, one chip thickness).
For `MM*` operations they are unavailable (reason "milling operation: turning geometry assumed")
while the resultant stays available since it needs no geometry. Unknown or empty subtype: same,
reason "operation type unknown".

## Data flow

`computeSignalStats` additionally returns the window's resultant mean and peak (one extra term in
the pass that already iterates the window). The dashboard calls the pure
`computeCuttingMetrics({ stats, axisMap, opKind, spiral, diameterMm, feedMmPerRev, apMm, spiralFeedMmPerRev, spiralOriginSec })`
and renders the result; it recomputes when stats, an input or the mapping change. The CSV gets one
set of columns repeated on every row, like the RPM columns.

## Out of scope

Milling metrics (average chip thickness, per-tooth force), feed/passive power, a target-RPM
fallback, rotating force into a tool frame, temperature or wear corrections, a schema change to
store the mounting orientation (worth doing once the real mapping is known), per-revolution
metrics.
