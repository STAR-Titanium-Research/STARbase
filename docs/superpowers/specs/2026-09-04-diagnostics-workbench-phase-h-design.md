# Diagnostics Workbench — Phase H design

Status: implemented 2026-09-04 → 2026-09-07 (all four slices). Extends the Phase A–G workbench.

Phase H is a field-report response, decomposed into four slices that ship in order. Each
slice is independently mergeable and independently useful. Slice 2 must precede slice 3
(the card UI has to render the new steps and their categories); slice 1 is first because
the 401 makes the tool intermittently unusable.

| # | Slice | Ships |
|---|-------|-------|
| 1 | Bugs & legibility | authorized fetch, human-readable errors, pop-out sync, HDBSCAN boundaries, Playwright coverage |
| 2 | New steps | `invert`, `griddify`, `gmm_segmentation`, step categories |
| 3 | Workbench UX | pipeline left, spatial hero, reorderable step cards, category picker, click-step-to-revert |
| 4 | Signal panel | Record-style channel picker, per-channel recipe runs |

---

## Slice 1 — Bugs & legibility

### 1.1 The 401 (`diag preview: 401 {"detail":"not permitted"}`)

**Root cause.** `directusClient.ts` installs an axios response interceptor that, on 401,
refreshes the access token once and retries. The diag clients do not go through axios:
`diagPreview.ts` and `diagViewport.ts` call raw `fetch()` with `host.authHeaders()`, which
reads whatever access token happens to be in `authStore` at that moment. There is no
refresh and no retry. Once the short-lived access token expires, every diag request 401s
forever while the rest of the app carries on refreshing transparently — the observed
"comes up intermittently, usually after leaving it a while" behaviour.

`_resolve_and_authorize` in `plugins/diag-service/app/main.py` forwards the caller's
credentials to Directus and maps its 401/403 to `HTTPException(status, "not permitted")`,
so the wire message is correct and blameless; the bug is entirely client-side.

**Fix.** Add `authorizedFetch(url, init)` to `packages/force-plotting/src/host.ts`. It
attaches `host.authHeaders()`, issues the request, and on a 401 calls a new
`host.refreshAuth?: () => Promise<boolean>` hook exactly once, retrying with fresh headers
if it returns true. Concurrent 401s share one in-flight refresh (`authStore.refresh()`
already does this internally). `diagPreview.ts`, `diagViewport.ts` and the layers/octree
fetches switch to it. Hosts that cannot refresh omit the hook and behave as today.

The three app hosts (`StandaloneDiagnosticsWorkbench.vue`, `DiagPanelWindow.vue`,
`StandaloneForceDashboard.vue`) supply `refreshAuth: () => authStore.refresh()`.

### 1.2 Human-readable errors

Every diag client currently throws `` `diag preview: ${res.status} ${text.slice(0,200)}` ``,
which is what surfaced the raw JSON to the analyst. Introduce `diagError.ts` mapping status
to prose:

- 401 / 403 → "Your session expired. Reload the page to sign in again." (only reachable
  after the refresh in 1.1 has already failed)
- 404 → "This cut has no diagnostics row."
- 409 → "This cut has not been baked yet — run a bake first."
- 422 → the server's detail, which for recipe faults is already the `recipeProblems()`
  prose; prefixed with "This recipe can't run: ".
- 502 → "The diagnostics service could not reach the database."
- anything else → "Diagnostics service error (HTTP n)." with the raw body kept on the
  error object as `.detail` for the console, never for the panel.

The panel renders `err.message`; `err.detail` goes to `console.warn` only.

### 1.3 Pop-out synchronisation

`DiagPanelWindow.vue` is a deliberate read-only viewer: it fetches the row once in
`onMounted`, uses `diag_recipe` as baked, and never hears about anything afterwards. The
Record tab's `LivePanelWindow` gets its currency for free from the live socket
(`client.connectViaRelay()`), so there is no existing pattern to copy.

**Fix.** A `diagSync.ts` module wrapping `BroadcastChannel` keyed `d1.diag.<analysisId>`.
The main workbench publishes on change (debounced 150 ms):

```ts
type DiagSyncMsg =
  | { t: 'recipe';    recipe: Recipe }
  | { t: 'channel';   panelId: string; channel: ChannelKey }
  | { t: 'isolate';   clusterId: number | null }
  | { t: 'layers';    layers: DiagLayer[] }
  | { t: 'viewport';  bbox: [number, number, number, number] }
  | { t: 'hello' };
```

A pop-out subscribes, applies each message to its local state, and posts `hello` on mount;
the main window answers a `hello` with the full current state, so a window opened late is
never stale. `BroadcastChannel` is same-origin and needs no server round trip. When it is
unavailable the pop-out degrades to exactly today's behaviour.

The pop-out stays a **viewer**: it applies recipe and isolation changes, but its own
controls do not publish back. Its header note changes from "colours by the last baked
recipe" to "mirrors the main window".

### 1.4 HDBSCAN blockiness

**Root cause.** `_op_hdbscan` calls `grid_reduce(target_n=grid_target)`, which sizes a grid
so the occupied-cell count is roughly `grid_target` **across whatever extent it is given**.
At the default 20 000 that is about 141 × 141 cells over the current bbox, at every zoom
level. `assign_from_grid` then broadcasts each cell's label to every point in that cell, so
cluster boundaries are quantized to one cell — about 1/141 of the view width, always.
Zooming in shrinks the cells but never increases their count, so the blockiness is
scale-invariant and no parameter removes it.

**Fix.** Keep `grid_reduce` — it is what makes clustering 5M points tractable — but replace
the cell broadcast. Add `assign_by_neighbours(x, y, xr, yr, labels, glosh, k)` in
`spatial.py`: for each full-resolution point, take the `k` nearest reduced centroids
(cKDTree, already a dependency via the Gi* path) and assign the majority label, weighted by
inverse distance, with `-1` counted as a real label so noise regions stay noise. `glosh`
becomes the inverse-distance-weighted mean. Boundaries then follow the data rather than the
grid.

`k` defaults to 4 and is not exposed as a recipe parameter — it is an implementation detail
of the assignment, not a clustering knob, and exposing it would invite tuning the wrong
thing. `assign_from_grid` is kept (still exported, still tested) because it is the exact
broadcast and the equivalence tests use it.

This changes `cluster_id` output for every cut, so `DIAG_VERSION` bumps 8 → 9 and all six
baked cuts re-bake.

### 1.5 Playwright coverage

`tests/ui/` is a Playwright project (`specs/`, config at `tests/ui/playwright.config.ts`,
baseURL `D1_BASE_URL`). Add `specs/diag_workbench.spec.ts` covering:

1. The workbench loads a baked cut and renders the spatial hero with no console error.
2. **No response in the run is a 401**, and no visible text matches `/^\w+ \w+: \d{3} \{/`
   — the shape of the raw-JSON error the analyst reported. This is the regression gate for
   1.1 and 1.2 together.
3. An expired access token (injected by clearing `accessToken` but keeping `refreshToken`
   in localStorage) still yields a successful preview — the direct test of the refresh path.
4. Editing a recipe parameter fires exactly one preview per debounce window, and the
   response is 200.
5. Opening the pop-out and changing the main window's channel updates the pop-out (1.3).

### Testing

Python: `assign_by_neighbours` unit tests (boundary follows a diagonal split; noise stays
noise; k larger than the cell count degrades gracefully), plus an `_op_hdbscan` test that
the label set is unchanged from `assign_from_grid` while the boundary points differ.
TypeScript: `diagError.ts` mapping table, `authorizedFetch` refresh-once-and-retry
(including the "refresh fails → surfaces the session-expired message" branch), and
`diagSync` message round-trip. Playwright as above.

---

## Slice 2 — New recipe steps

Each new step touches nine places. This checklist is the definition of done per step:

1. `scripts/diag/ops.py` — the `@step` registration and function
2. `recipeChannels.ts::STEP_META` — label, tier, produces, params
3. `recipeChannels.ts::STEP_REQUIRES`
4. `recipeChannels.ts::PRODUCED_TO_CHANNEL` and `ALL_CHANNELS` (if it produces a channel)
5. `diagHelp.ts` — prose for the step and every parameter
6. `diagViewport.ts::ViewportStep['op']` (spatial steps only)
7. `main.py::_VIEWPORT_OUTPUT` and the viewport op validation (spatial steps only)
8. `test_ts_registry_parity.py` passes without amendment
9. `DIAG_VERSION` bump + re-bake

### 2.1 `invert` — derived tier

Value inversion, not sign flip and not deconvolution: map a channel through a reciprocal or
complement so a "low is bad" channel reads as "high is bad" and colormaps stay consistent.

- params: `source` (select over the produced numeric channels, default `resid_z`),
  `mode` (`complement` | `reciprocal`, default `complement`), `epsilon` (reciprocal only,
  default 1e-6, guards the divide)
- `complement`: `max(finite) - v`. `reciprocal`: `1 / (|v| + epsilon)`, sign preserved.
- produces `inverted` → channel `inverted`. NaN in, NaN out; the finite max ignores NaN.

### 2.2 `griddify` — derived tier

Grid interpolation with an honest fake-data estimate.

**Constraint that shapes the design:** after `angular_resample` every derived step must
preserve `n` — `resolve_inputs` asserts `arr.shape == xa.shape` and the runner assembles
fixed-length columns. So griddify cannot emit a regridded cloud. It interpolates onto a
regular grid and **samples back to the original points**, which keeps the contract intact
and is also what the analyst wants to look at.

- params: `resolution_mm` (grid pitch in data units, default 0.25), `method`
  (`linear` | `nearest`, default `linear`), `max_fill_mm` (default 1.0 — beyond this
  distance from any real sample the output is NaN rather than invented)
- produces `grid_fill` and `grid_support`.
  - `grid_fill` — the interpolated value at each original point's location.
  - `grid_support` — the confidence/fake-data estimate, in [0, 1]: `1` where the point's
    grid cell contained real samples, falling off with distance to the nearest real sample
    and reaching `0` at `max_fill_mm`. Colouring by `grid_support` is the uncertainty map;
    its mean over a region is "what fraction of this is invented".

### 2.3 `gmm_segmentation` — derived tier, spatial

Gaussian-mixture segmentation over (x, y, resid_z), as an unsupervised counterpart to the
seeded `grow_segmentation`.

- params: `n_components` (default 4), `covariance_type` (`full` | `tied` | `diag` |
  `spherical`, default `full`), `attr_weight` (default 1.0 — scales resid_z against the
  spatial coordinates), `random_state` (default 0, so results are reproducible)
- produces `gmm_id` and `gmm_prob` (the responsibility of the assigned component — a
  natural confidence channel, and the thing that makes GMM worth having over HDBSCAN).
- Runs on the grid-reduced set like `hdbscan`, and uses the same `assign_by_neighbours`
  from 1.4, so it does not reintroduce the blockiness.
- Registered in `ViewportStep['op']` so it can be run on a framed view.

### 2.4 Step categories

Add `category: str` to `StepSpec` and the `@step` decorator, and mirror it as
`StepMeta.category`. Categories: `transform` (frame_transform, angular_resample, invert),
`residual` (tsa, radial_detrend, envelope), `interpolation` (griddify), `statistics`
(getis_ord), `segmentation` (hdbscan, grow_segmentation, gmm_segmentation). The step
*picker* groups by category; the pipeline itself stays a flat ordered list, because order
is semantic and grouping the list would hide that.

`test_ts_registry_parity.py` extends to pin category alongside produces/requires/tier.

### 2.5 Widened `/viewport` response

Griddify and GMM both produce a value plus a confidence, and the analyst wants to see them
together. `POST /diag/viewport` currently returns a single `value` column chosen by
`output`. It gains an optional `outputs: [str]` request field; when present the D1AN
response carries one named column per requested output alongside `x`/`y`, and
`X-Diag-Viewport-Cols` names them in order. `output` (singular) stays for compatibility and
is equivalent to a one-element `outputs`. The spatial view can then modulate colour by
`grid_fill` and opacity by `grid_support` in a single render.

---

## Slice 3 — Workbench UX

- **Layout.** `DIAG_DEFAULT_LAYOUT` becomes pipeline-left (`x: 0, w: 3`, full height) with
  the spatial view as the hero occupying the remaining width and the top two thirds of the
  height. `DIAG_LAYOUT_LS_KEY` bumps to `force-app.diag.layout.v3` — without this, every
  existing analyst keeps their persisted v2 layout and sees no change at all.
- **Step cards.** `RecipePanel` steps become cards matching the sample/operation picker
  cards in the plot section, drag-reorderable within the pipeline. Reordering revalidates
  through `recipeProblems()` on every drop, so an ordering that strands a step is refused
  at the drop rather than at the request.
- **Category picker.** "Add step" opens a picker grouped by the slice-2 categories.
- **Click-step-to-revert.** Clicking a card shows the pipeline state *as of* that step.
  This needs `stop_after` on `POST /diag/preview`: `runner.run_recipe` already takes it,
  but `main.py` only ever passes `from_step` (which is resume-from, the opposite knob).
  The response's channel selection then follows `STEP_META[op].produces` →
  `PRODUCED_TO_CHANNEL` → the hero panel's channel.
- **`resid_z` naming.** The panel titles the channel by its meaning, not its column name:
  "Anomaly z-score (resid_z)", with the existing `diagHelp` prose on the InfoTip.

## Slice 4 — Signal panel

The Signal panel is currently a fixed "anomaly z-score along the cut" chart with no
controls. It gains the Record tab's axis/channel picker, and a run-scope control:

- **this channel** — today's behaviour, one recipe run for the selected
  `frame_transform.channel`
- **this view** — the existing per-step viewport recompute
- **all channels** — the UI runs the recipe once per channel (fc / ff / fp) and caches the
  three results, so switching between them is instant. `frame_transform.channel` remains a
  single-valued parameter and the column contract is untouched; this is a client-side
  fan-out, not a pipeline change.
