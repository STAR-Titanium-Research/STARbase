# Diagnostics Phase G — Interactive Full-Resolution Workbench

**Status:** implemented 2026-09-03. One deviation: the analysis overlay described below as a new
`DiagAnalysisOverlay.vue` was built into `DiagOctreeView.vue` instead.
**Extends:** the Diagnostics Recipe Workbench (`2026-09-01-diagnostics-recipe-workbench-design.md`) and its Phases A–F, all merged.
**Supersedes:** the deferred "Phase D-2 full-resolution view" sketch — this replaces it.

## Motivation

The workbench today renders the **analysis grid**: the pipeline angular-resamples to 256 samples/rev before TSA / Gi\* / HDBSCAN, so the Spatial panel shows ~200k–1M points — the resolution the statistics are computed at, not the resolution the cut was measured at. Users work with the raw ~7M-point spiral everywhere else in the app and expect the diagnostics view to match.

Running the whole pipeline at 7M is not the answer: TSA needs whole revolutions on a fixed phase grid, and HDBSCAN on 7M points is minutes per bake. The workable model, from the user:

> "the user can zoom the viewport and then hdbscan just on that if needed"

Show the full 7M cloud; let the analyst frame a region; run the spatial statistics on just those points, at full resolution, on demand.

## Decisions (locked with the user)

| Question | Decision |
|---|---|
| What does the bake broadcast onto the 7M cloud? | **`resid_z` only.** The full-res view always shows `resid_z`; clusters / hotspots / segments exist only after a viewport recompute. |
| Fast decimated view, or octree-only? | **Octree-only.** One render path. Param tuning previews by re-running the scoped step on the current viewport (fast because it is a subset). |
| How does a viewport recompute fire? | **Auto on pan/zoom settle for the cheap step (Gi\*); explicit button for HDBSCAN and segmentation.** |

## Non-goals

- Running TSA / `radial_detrend` at full resolution. They stay global at 256/rev.
- A global HDBSCAN pass at bake. `cluster_id` / `segment_id` / `gi_*` are not baked artifacts any more — they are viewport-scoped results.
- Cross-cut viewport transfer. A recompute is bound to one cut's geometry.
- Removing the recipe. Base steps (frame_transform → angular_resample → tsa → radial_detrend) are still the bake and still tunable; the spatial steps still carry their params, they just execute against the viewport.

## Component 1 — the bake broadcasts `resid_z` to full resolution

`process_diag_row`, after `columns` is produced on the 256/rev grid:

```python
# columns["rev"] is the angular grid; cache["revs"] is the ~7M strided spiral's per-point rev.
resid_full = np.interp(cache["revs"], columns["rev"], columns["resid_z"])
```

`np.interp` because `resid_z` is a continuous residual — linear interpolation between adjacent phase bins is the honest broadcast (nearest-neighbour would band). `x_full`, `y_full` are the strided spiral coords `process_diag_row` already has (`_read_octree_bin` + the `step` decimation).

**The bake is purely additive.** Everything Phase F produces — `attrs.d1an` (256/rev, all 12 columns, `getis_ord` / `hdbscan` still run globally for it), `base.d1an`, the 256/rev diag octree, `diag_metrics`, `diag_recipe_hash` — is unchanged. `DEFAULT_RECIPE` is untouched, so the golden equivalence fixtures stay valid with no test change. Phase G only *adds* two artifacts under `OCTREE_DIR/diag/<op>/full/`:

- **`full.d1an`** — flat `{x, y, resid_z}` float32, ~7M rows (~84 MB). The queryable source for viewport recompute. D1AN format, no new writer needed.
- **`full/` octree** — a LAS with `x`, `y`, `resid_z` as an extra dim → PotreeConverter. What `DiagOctreeView` streams.

The 256/rev `attrs.d1an` remains the "global baked" analysis: the Selection Inspector's whole-cut stats, the Signal panel, and the recipe channel selector's fallback all still read it. A viewport recompute is a *higher-resolution local refinement* of what `attrs.d1an` already shows globally — not a replacement.

`DIAG_VERSION` 6 → 7 (the published set grew); `claim_diag` requeues every cut to generate `full/`.

Bake cost: one `np.interp` (milliseconds) + one extra PotreeConverter run (~15 s per cut). The global `getis_ord` / `hdbscan` still run as today.

## Component 2 — `POST /diag/viewport` (diag-service)

```
POST /diag/viewport
  { analysis_id, bbox: [x0, y0, x1, y1], step, params, layers?, max_points }
  -> binary: n:u32, then n * (x:f32, y:f32, value:f32)
```

- Authorizes the caller against Directus for the analysis row (same guard as `/preview`, including on LRU hits — commit `32fb4b7`).
- Loads `full.d1an` over Caddy at `/octrees/diag/<op>/full/full.d1an`; LRU-caches the parsed arrays keyed by `diag_path`.
- Crops: `m = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)`. If `m.sum() > max_points`, take an even stride down to `max_points` (a recompute is a preview, not the bake).
- Runs exactly one registry step's function on the cropped `{x, y, resid_z}`:
  - `getis_ord` → `value = gi_star` (or `gi_sig` — the client says which via `params.output`)
  - `hdbscan` → `value = cluster_id`
  - `grow_segmentation` → `value = segment_id`, with `layers` rasterised against the cropped coords for the seed classes (Phase F's `resolve_inputs` list mode, called directly).
- Masked points (a Phase-E mask layer sent in `layers`) → excluded, `value = NaN` / `-1` per the step's own rule.
- Returns the cropped `(x, y, value)` so the client can render them as an overlay without needing a global index.

Client: 600 ms debounce on the auto (Gi\*) path, `AbortController` cancelling in-flight; the button path fires immediately.

Result caching: keyed `(diag_path, step, round(bbox), recipe_hash_of_that_step, layers_key)`. Panning back to a region you already computed is instant.

## Component 3 — the Spatial panel

`DiagScatter` (the flat 256/rev render) is **removed from the workbench**. `DiagOctreeView` (already built, currently dead code) becomes the Spatial panel's base layer, widened:

- **Base render:** the `full/` octree, coloured by `resid_z` (viridis, auto 1/99). This is the always-on context layer — full density, LOD-streamed.
- **Analysis overlay:** a new `DiagAnalysisOverlay.vue` — a flat `THREE.Points` (like the old `DiagScatter`) fed by the last `/diag/viewport` result. Renders the framed region's `cluster_id` / `gi_star` / `segment_id` categorically or continuously, on top of the octree. ~50k–1M points, one buffer, recoloured instantly on channel switch. Empty until the first recompute.
- **Paint layer overlay + draw:** ported from `DiagScatter` (Phase E) onto this view — polygons are x/y mm, the ortho camera unprojects the same way. `LineLoop` rings per layer, the draft ring, the transparent draw `<div>`.
- **Viewport tracking:** the octree view already computes `currentBounds()` (x/y mm rectangle the ortho camera shows). A `watch` on it, debounced 600 ms, drives the auto Gi\* recompute; the HDBSCAN / segmentation buttons read it on click.

`DiagOctreeView`'s channel prop stays `residZ` only (it is the context layer). The overlay owns the analysis channels.

## Component 4 — the recipe, reframed

The recipe object is unchanged in shape, and every step still runs globally at bake exactly as in Phase F (so `attrs.d1an` and the golden tests are untouched). Phase G adds a **second execution path** for the three spatial steps: on a framed viewport, at full resolution.

| Step | Global (bake, 256/rev) | Viewport (full-res, on demand) |
|---|---|---|
| `frame_transform`, `angular_resample`, `tsa`, `radial_detrend` | yes | — (base steps, not viewport-scoped) |
| `getis_ord` | yes | auto on pan/zoom settle |
| `hdbscan` | yes | on the "Cluster this view" button |
| `grow_segmentation` | yes (if in recipe) | on the "Grow segmentation" button; seeds bound as in Phase F |
| `envelope` | yes | — |

`RecipePanel` gains, per spatial step, a "runs on the current view" note and (for HDBSCAN / segmentation) the trigger button inline. The Spatial channel selector offers the analysis channels; picking one shows the **viewport overlay** for that channel if a recompute has produced it, else the global `attrs.d1an` values (the octree does not carry them, so this falls back to a message "frame a region and run this step").

`bakeStale` continues to track the whole recipe for the *global* bake (unchanged from Phase F). A spatial-step param edit still marks the global bake stale — but the analyst can see the effect immediately in the viewport overlay without baking, and bake later to update the global `attrs.d1an` too.

## Component 5 — layout & density

The current 3-column grid (Recipe w:3 / Spatial w:6 / Signal w:3) makes Spatial too small for a 7M octree. Rework:

```
+------------------------------------------------+------------------+
|                                                | Recipe           |
|  SPATIAL (hero) — full-res octree              |  step list       |
|   + analysis overlay                            |  (collapsible)   |
|   + paint tools                                 +------------------+
|   viewport-recompute controls (top-right)      | Signal           |
|                                                |  resid_z vs t    |
+------------------------------------------------+  brush           |
| Selection Inspector: n · t-span · r-range · stats · overlay stats  |
+-------------------------------------------------------------------+
| baked @ DIAG_VERSION 7 · viewport: 412k pts · Gi* auto · [Bake]     |
+-------------------------------------------------------------------+
```

- Spatial spans ~9 of 12 columns and full height. Recipe + Signal stack in the right ~3.
- Recipe panel is **collapsible** (a header chevron) — collapsed by default once a recipe is baked, so the Spatial view owns the screen; expand to tune.
- The state strip reports the live viewport point count and which recomputes are armed.
- `LayerPanel` moves into the Spatial panel's own toolbar (it acts on that view).
- `grid-layout-plus` stays; the default layout array changes and Recipe/Signal get a min-height so they do not collapse to nothing.

## Component 6 — painting on the full-res cloud

Phase E's paint machinery (`DiagScatter`'s draw `<div>`, `canvasToWorld`, `rebuildOverlay`, the draft `LineLoop`) ports to `DiagOctreeView` essentially verbatim — both are top-down orthographic with the same unproject. The `diag_layer` geometry is already x/y mm on the analysis grid; the full-res spiral shares that coordinate space (MATLAB's own geometry), so a polygon drawn on the octree selects the same physical region. No schema change.

The viewport recompute sends the drawn `layers` inline (Phase E pattern) so a mask or seed affects the result while you are still drawing it.

## Testing

- **Broadcast fidelity** — `resid_full` at a sample of full-res points matches `np.interp` of the 256/rev `resid_z` at their `rev`, within float32. A point exactly on a phase-bin centre equals that bin's value.
- **Viewport crop** — `/diag/viewport` with a bbox returns exactly the points inside it (± the stride when over `max_points`), and the same bbox twice hits the result LRU.
- **Scoped HDBSCAN parity** — HDBSCAN on a bbox that covers the whole cloud, at full `max_points`, recovers the planted anomaly from the synthetic ground-truth cut (the science test, retained).
- **Scoped segmentation** — two seed polygons in a bbox → two classes over the cropped points; masked points excluded.
- **Authorization** — a caller without rights to the row is refused on a `/diag/viewport` LRU *hit*, not just a miss (regression for `32fb4b7`).
- **Auto-vs-button** — a pan/zoom settle fires exactly one Gi\* request (debounced) and zero HDBSCAN requests; the HDBSCAN button fires one.
- **Golden equivalence untouched** — `DEFAULT_RECIPE` and the bake are unchanged, so `assert_columns_match_golden` and every existing diag test pass with no modification. This is the check that Phase G is additive.
- **Octree URL** — the Spatial panel loads `/octrees/diag/<op>/full/`, not `/octrees/diag/<op>/` (the 256/rev octree, a different artifact) and not `/octrees/<op>/` (the raw spiral).

## Phasing within G

One plan, one merge. Task groups:

1. **Bake** — `resid_z` broadcast, `full.d1an` + `full/` octree publish, `DIAG_VERSION` 7, re-bake all cuts.
2. **Service** — `POST /diag/viewport`: crop, stride, run one step, authz, LRU.
3. **Spatial panel** — `DiagOctreeView` as base, `DiagAnalysisOverlay.vue`, viewport tracking, paint port.
4. **Recipe reframe** — spatial steps become viewport-scoped; RecipePanel triggers; `bakeStale` base-only; channel selector "run on a view first".
5. **Layout** — the new grid, collapsible Recipe, state strip with viewport count.
6. **Verify** — full suites; re-bake; headless: frame a region, Gi\* auto-fires, Cluster button, paint a mask and see it affect the recompute, collapse/expand Recipe.

Everything Phases A–F established on the server (the registry, `run_recipe`, `resolve_inputs`, the D1AN format, `diag_layer`, `diag_recipes`, the trigger) is reused unchanged. `DiagScatter.vue` and its Phase E/F additions are retired from the workbench but kept in the package export (other consumers may exist).
