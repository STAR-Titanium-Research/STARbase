# Diagnostics Recipe Workbench — design

**Status:** implemented — phases A–F shipped 2026-09-01 → 2026-09-03 (`scripts/diag/recipe.py`,
`registry.py`, `runner.py`, `plugins/diag-service/`), then extended by the Phase G and Phase H
specs alongside this one.

Supersedes the UI and pipeline-structure portions of
`2026-08-30-diagnostics-workbench-design.md`. That document's science (angular resampling, TSA,
radial detrend, Getis-Ord, HDBSCAN, envelope analysis) is unchanged and still authoritative;
what changes is that the pipeline stops being a fixed sequence and becomes an editable,
reusable program.

## Motivation

Phases 1-6 of the original design shipped and the server-side science works. The UI does not.
Against a real cut it renders a near-uniform disc, because the workbench exposes only
`resid_z` and `tsa_resid` while `gi_star`, `gi_sig`, `cluster_id`, `glosh` and `env_band` are
computed, written into `attrs.d1an`, and then unreachable. There is no cluster overlay, no
per-cluster summary, and no way to see which processing step produced what. The tool that was
supposed to turn "that looks like a macrozone" into a hotspot with a p-value instead produces a
green circle.

Two failures are worth separating, because they have different fixes:

1. **Nothing is inspectable.** The pipeline is a black box: MATLAB emits a cloud, Python runs
   seven stages, one artifact appears. When the result looks wrong there is no way to find out
   which stage is responsible, and no way to try a different parameter without a code change and
   a full rebuild.
2. **Nothing is adjustable.** Every parameter -- the Gi\* neighbourhood `k`, the HDBSCAN
   grid-reduction target, the detrend bin count -- is a module-level constant. `spatial.py`'s own
   docstring admits they are "defaults chosen to be reasonable on synthetic data, not tuned
   against real cuts" and asks for them to be revisited. There is currently no mechanism to
   revisit them.

The fix for both is the same: make the pipeline a **recipe** -- an ordered list of typed,
parameterised steps that the user edits, previews per step, and bakes when satisfied.

## Goals

- The processing pipeline becomes a first-class editable object: reorder, toggle, retune, insert
  and remove steps, and view the point cloud as of any step.
- Tuning feedback in seconds, not minutes, without moving computation into the browser.
- Every channel the pipeline produces is selectable in the viewer, derived from the recipe rather
  than hardcoded.
- Recipes are named, saved, and applied across cuts, so a tuned analysis can be run over a whole
  campaign.
- Hand-painted regions (mask / label / seed) without destroying recipe reusability.
- What you tuned is what you baked, guaranteed by construction rather than by discipline.

## Non-goals

Carried over from the original design and still rejected: PointNet++/U-Net segmentation (no
labelled data), CWT/synchrosqueezing, EMD/HHT, FRF estimation (the worker applies a supplied
matrix, it does not measure one), and analysis during recording.

Newly out of scope for this design:

- **Client-side computation of any kind.** The browser authors recipes, draws polygons and
  renders attributes. It does not compute statistics. This is the original design's keystone and
  it is retained verbatim.
- **Absorbing the existing `filter_chain`.** The time-domain signal filter chain is baked into
  the live cache upstream of everything here. It stays a separate object for now; see Open
  questions.

## Architecture

```
                 process_force.m   (UNCHANGED — sole owner of cut geometry)
                          |
              D1LC cache  +  D1OC spiral binary
                          |
   force_orchestrator.py :: process_diag_row          [BAKE — full resolution, ~20-25 s]
       run_recipe(registry, recipe, layers, columns)
         --> base.d1an     (post angular-resample, pre-statistics)
         --> attrs.d1an    (every column the recipe produces)
         --> LAS -> PotreeConverter -> infra/octrees/diag/<op_id>/
         --> diag_metrics, diag_recipe_hash, diag_version
                          |
   diag-service :: POST /diag/preview                 [PREVIEW — decimated, ~1-3 s]
       run_recipe(registry, recipe, layers, base.d1an, from_step=N)
         --> the columns produced at or after step N
                          |
   DiagnosticsPage (force app, /diagnostics)
       Recipe panel | Spatial (channel from recipe.produces) | Signal | Orders/Anomaly/Clusters
```

`run_recipe` is one function in `scripts/diag`, imported by both executors. That shared import is
the design's central safety property: preview and bake cannot diverge, because they are the same
code path over the same registry.

## Component 1 — the Recipe

An ordered list of typed steps, shaped deliberately like the existing `FilterChain`, whose JSON
is already shared verbatim between TypeScript, the Python filter-service and MATLAB `frm_filters`.

```jsonc
{
  "recipe_version": 1,
  "name": "Ti-64 macrozone v3",
  "steps": [
    { "id": "s1", "op": "frame_transform",  "on": true,  "params": { "channel": "fp", "mount_deg": 0 } },
    { "id": "s2", "op": "angular_resample", "on": true,  "params": { "samples_per_rev": 256 } },
    { "id": "s3", "op": "tsa",              "on": true,  "params": {} },
    { "id": "s4", "op": "radial_detrend",   "on": true,  "params": { "n_bins": 200, "min_per_bin": 8 },
      "inputs": { "mask": { "layer": "fixture", "required": false } } },
    { "id": "s5", "op": "getis_ord",        "on": true,  "params": { "k": 30, "alpha": 0.05 } },
    { "id": "s6", "op": "hdbscan",          "on": true,  "params": { "grid_target": 20000, "min_cluster_size": 10 } },
    { "id": "s7", "op": "envelope",         "on": false, "params": { "bandwidth_frac": 0.2 } }
  ]
}
```

Three properties carry weight:

- **`id` is stable and opaque.** "Show the cloud as of step 4" references `s4`, so reordering or
  toggling does not break the current view, a saved selection, or a figure caption in a write-up.
- **`on` toggles without deleting.** Same as `FilterChain`'s per-stage `on`: a step can be
  A/B-compared without losing its tuning.
- **`inputs` binds a per-cut layer *by name*.** The recipe declares "radial_detrend consumes a
  mask called `fixture`"; each cut supplies its own `fixture`. This is the split that keeps a
  recipe reusable while still allowing hand-painted, inherently per-cut masks -- a function and
  its arguments. `required: false` means a cut with no such layer runs unmasked; `true` means
  applying the recipe there refuses rather than silently analysing an artefact.

## Component 2 — the step registry

The principal server-side change. `analyse()` stops being a hardcoded sequence and becomes
registry-driven. Each op is a pure function over a column dict with a declared contract:

```python
@step(
    "radial_detrend",
    produces=["resid_z"],
    requires=["tsa_resid", "x", "y"],
    tier="derived",
)
def _radial_detrend(cols: Columns, params: dict, inputs: Inputs) -> Columns: ...
```

| Field | Purpose |
|---|---|
| `produces` | The viewer's channel selector is **derived from the recipe**, not hardcoded. This alone fixes the defect that `gi_star`/`glosh`/`cluster_id` are computed but unreachable. |
| `requires` | The editor validates ordering and refuses illegal insertions before anything runs. |
| `tier` | `base` = consumes the raw full-rate cache and therefore forces a re-bake; `derived` = previewable from `base.d1an` in seconds. Surfaced in the UI rather than pretending every step is equally cheap. |

Tier is a property of what a step *consumes*, not of where it sits in the list. Everything up to
and including `angular_resample` is `base`, because `base.d1an` is its output. Everything after is
`derived` -- with one instructive exception: **`envelope` is `base` despite appearing last.**
`envelope.py` is explicitly time-domain ("operates on the FULL-RATE raw signal, not the
angular-resampled data the rest of this package's pipeline works in"), because the modulation rate
it recovers lives in Hz, which the angular domain deliberately discards. So retuning the envelope
band costs a re-bake while retuning HDBSCAN does not. That asymmetry is real, and the `tier` field
exists precisely so the UI can state it instead of leaving the user to discover it by waiting.

The step functions are the *existing* functions in `scripts/diag/*` behind a thin decorator. This
is a refactor, not a rewrite.

**Binding constraint:** the default recipe must reproduce today's `analyse()` exactly -- same
inputs, byte-identical D1AN columns. That equivalence is the primary regression test and the
thing that makes this change safe to land.

## Component 3 — paint layers

A layer is **polygons in (x, y) millimetres**, plus a role and a value. It is *not* a per-point
array.

That choice is load-bearing. A dense `uint8[204800]` mask would be only 200 KB and is the obvious
first idea, but it is welded to the current point count and ordering: changing `samples_per_rev`
from 256 to 512 would silently invalidate every mask ever painted, with no error. Geometry
survives re-baking at any resolution, is diffable, is inspectable in the database, and is exactly
the polygon predicate `selection.ts` already defines for the spatial lasso.

```sql
CREATE TABLE diag_layer (
    layer_id     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_id  uuid NOT NULL REFERENCES machining_force_analysis(id) ON DELETE CASCADE,
    name         text NOT NULL,        -- the name a recipe's `inputs` binds to
    role         text NOT NULL,        -- 'mask' | 'label' | 'seed'
    geometry     jsonb NOT NULL,       -- polygons, in x/y mm
    value        jsonb,                -- include|exclude / label name+colour / seed class
    version      integer NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (analysis_id, name)
);
```

| Role | Consumed by | Notes |
|---|---|---|
| `mask` | Compute steps, via `inputs` | Exclude a chuck mark or fixture artefact so the detrend and Gi\* never see it |
| `label` | Nothing — annotation only | Exported with the operation. Also the only route to ever having labelled data, which is precisely why the original design rejected supervised segmentation |
| `seed` | A future `grow_segmentation` step | Marked in/out examples over the D1AN attributes |
| *select* | Nothing — transient | Needs no table: it is the existing shader predicate in `selection.ts` |

Rasterisation from polygons to per-point labels happens **server-side**, inside the registry, via
one shared helper. The browser draws polygons and renders the overlay -- input and display, not
computation -- so "the browser computes nothing" remains literally true.

## Component 4 — execution: two tiers, one code path

### Preview — `diag-service`

A new container mirroring `plugins/filter-service`'s shape (FastAPI, uvicorn, httpx, numpy,
scipy, **plus scikit-learn**). Its Dockerfile copies `scripts/diag/` into the image, so it calls
the same `run_recipe` the orchestrator calls.

```
POST /diag/preview
  { analysis_id, recipe, from_step, layers }
  -> D1AN-format columns produced at or after `from_step`
```

`layers` is sent **by the client, inline**, rather than fetched from `diag_layer` by the service.
That is deliberate: a mask is most useful while you are still drawing it, and requiring a save
round-trip before you could see its effect would make painting feel broken. The service treats
inline layers as the authoritative input for that request and never writes them; persistence is a
separate, explicit action. Saved layers are simply what the client sends by default.

It fetches `base.d1an` over Caddy at `/octrees/diag/<op_id>/base.d1an`, but **authorizes the
caller against Directus for that analysis row first**, including on LRU hits. This is not
optional: commit `32fb4b7` fixed exactly this IDOR hole in filter-service, where a shared LRU
served cached data without re-checking the requester. The same guard is required here.

Client side: 400 ms debounce, `AbortController` cancelling in-flight requests -- the pattern
`filterChain.ts` already implements via its `signal` parameter.

### Bake — the orchestrator, unchanged in shape

`process_diag_row` keeps its current structure and gains `run_recipe`. It publishes `base.d1an`
alongside `attrs.d1an`, and records `diag_recipe_hash`.

Preview cannot invoke MATLAB (it needs the archive, and costs ~20 s), which is why `base.d1an`
exists: the state after angular resampling and before any statistics — `t, rev, x, y, sig` at
204,800 points, about 4 MB.

An earlier draft of this document specified that set as `t, rev, x, y, fc, ff, fp`. That is not
writable: `fc/ff/fp` are full-rate channels while `t/rev/x/y` are on the angular grid, and the
D1AN format requires every column to share one length. The angular state is also the correct
thing to store, because it is precisely what a `derived`-tier step resumes from — and the only
consumer of full-rate channels, `envelope`, is `base` tier and therefore never previewed at all.

The rejected alternative deserves recording. `x`/`y` *could* be reconstructed inside the service
from the D1LC cache alone, using `r = revs_cum/PPR; theta = wrapTo2Pi(2*pi*r); rho = Diam/2 -
Feed*r` -- the formula `LivePlot.vue` already uses client-side -- which would avoid a new
artifact entirely. It is rejected because it re-implements cut geometry outside `process_force.m`,
the divergence risk this codebase has guarded against throughout, and which the original design
called out explicitly. Publishing MATLAB's own `x`/`y` keeps that invariant intact.

### Prefix hashing

Each step's output identity is `hash(enabled steps up to and including i + their params + bound
layer versions)`. Editing step 6 invalidates only steps at or after 6; the prefix through step 5
is served from cache. This is what makes retuning a clustering parameter feel immediate rather
than re-running the whole pipeline, and it generalises `chainKey()`'s existing rule that only
enabled stages contribute to identity.

## Component 5 — invalidation: two independent axes

| Axis | Meaning | Column |
|---|---|---|
| `DIAG_VERSION` | The **code** changed — an algorithm's implementation moved | `diag_version` (exists) |
| `diag_recipe_hash` | The **configuration** changed — steps or parameters differ | `diag_recipe_hash` (new) |

A baked artifact is reusable only when both match. `claim_diag`'s existing "requeue `done` rows
with an older `diag_version`" clause extends to requeue on either mismatch. Keeping them separate
matters: bumping `DIAG_VERSION` must invalidate every cut regardless of recipe, while editing one
cut's recipe must not invalidate anyone else's.

The recipe itself is stored per-cut on `machining_force_analysis.diag_recipe jsonb`, with a
`diag_recipes` library table for named, reusable recipes -- mirroring `filter_chain` and
`filter_profiles`, whose comment already describes the pattern: *"applying a profile copies its
chain onto an operation."*

## Component 6 — layout

Extends the original design's panel arrangement with the recipe as a first-class column.

```
+------------------+--------------------------------+------------------+
| RECIPE           |                                | A: Signal        |
|  step list       |  B: Spatial (hero)             |  brush + frame   |
|  + Add step      |     channel selector, built     +------------------+
|  step params     |     from recipe.produces       | C/D: tabbed      |
|  [Bake]          |     cluster overlay + layers   |  Orders |Anomaly |
|                  |     paint tools                |  Envelope|Clusters|
+------------------+--------------------------------+------------------+
| Selection Inspector: n · t-span · r-range · stats                     |
+-----------------------------------------------------------------------+
| Bandwidth validity · previewing @ step 5 (decimated) · baked: stale    |
+-----------------------------------------------------------------------+
```

Behaviours that matter:

- Clicking a step previews the cloud **as of** that step.
- The channel selector is populated from the recipe's produced columns, so a newly added step's
  output is immediately viewable. This is the direct fix for the current dead-end.
- The state strip is honest about what is on screen: *previewing at decimated resolution* versus
  *baked at full resolution*, and whether the bake is stale relative to the current recipe.
- Paint tools live in the Spatial panel toolbar and write `diag_layer` rows.

The window is the standalone force app's `/diagnostics` route, which already exists and inherits
`AppShell`'s per-item popout for a second monitor. It is deliberately not a panel in the shared
`ForceDashboard`.

## Testing

Follows existing conventions: pytest for the worker and the service, vitest for the package,
`vue-tsc --noEmit` run separately.

- **Default-recipe equivalence** — the registry pipeline reproduces the current `analyse()`
  byte-for-byte on the same input. The test that makes the refactor safe.
- **Preview/bake parity** — the same recipe through both executors yields the same columns within
  float32 tolerance on the decimated set. The test that makes "what you tuned is what you baked"
  true rather than aspirational.
- **Step contracts** — every registered op honours its declared `produces`/`requires`; the
  validator rejects an ordering that violates them.
- **Recipe hash stability** — reordering disabled steps does not change the hash; changing a
  disabled step's params does not change the hash. Mirrors `chainKey()`.
- **Layer resolution-independence** — the same polygon selects the same physical region at 256
  and at 512 samples/rev. This is the test that justifies storing geometry over indices.
- **Authorization** — a caller without rights to an analysis row is refused on an LRU *hit*, not
  merely on a miss. Direct regression test for `32fb4b7`.
- **Synthetic ground truth** — retained from the original design: a spiral with an implanted
  anomaly at a known `(r, theta)`; the pipeline must recover its location. Still the test that
  validates the science rather than the plumbing.

## Phasing

| Phase | Content | Visible outcome |
|---|---|---|
| **A** | Step registry refactor + default-recipe equivalence test | None — pure server refactor, behaviour identical |
| **B** | `base.d1an` artifact, `diag_recipe`/`diag_recipe_hash` columns, dual invalidation | None — infrastructure |
| **C** | `diag-service` container, `POST /diag/preview`, prefix cache | Preview reachable by API |
| **D** | Recipe panel, channel selector from `recipe.produces`, cluster overlay, per-cluster table | **v1: tune-and-see.** Hotspots and clusters finally visible and adjustable |
| **E** | Paint layers: mask, label, and the deferred spatial-lasso shader path | Artefacts maskable; regions annotatable |
| **F** | Seeded segmentation step; recipe library (save / name / apply across cuts) | Campaign-scale reuse |

Phases A-D constitute the first genuinely usable version and are the scope of the accompanying
implementation plan. E and F are additive and restructure nothing A-D establishes; each gets its
own plan when it is reached.

## Open questions

1. **The existing `filter_chain` overlaps the recipe's `base` tier.** Time-domain filtering is
   currently baked into the live cache upstream of the diag pipeline, and duplicating it as
   recipe steps would give two places to filter. Left separate in this design; revisit once the
   `base` tier has a second member.
2. **Dynamometer natural frequency is still unrecorded**, so `quantitative_limit_hz` remains
   absent and envelope analysis continues to refuse rather than alias. Unchanged from the
   original design; it needs the `tool_setup` record populated, not new code.
3. **HDBSCAN parameters remain unvalidated against real cuts.** This design provides the
   mechanism to tune them; it does not tune them. That is the first task once Phase D lands.
