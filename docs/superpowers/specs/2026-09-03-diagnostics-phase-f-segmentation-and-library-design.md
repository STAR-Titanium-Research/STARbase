# Diagnostics Phase F — Seeded Segmentation & Recipe Library

**Status:** implemented 2026-09-03 (merged as "Phase F: seeded segmentation + recipe library")
**Extends:** `docs/superpowers/specs/2026-09-01-diagnostics-recipe-workbench-design.md` (the Phase F row of its Phasing table: "Seeded segmentation step; recipe library (save / name / apply across cuts) → Campaign-scale reuse")
**Depends on:** Phases A–E, all merged to `main` (recipe engine, `base.d1an`, diag-service, tune-and-see workbench, paint layers)

## Motivation

Phase D made the pipeline's clustering *visible and tunable*; Phase E let the analyst *exclude* artefacts. Neither lets the analyst say "this region here is the macrozone I care about — find the rest of it." HDBSCAN clusters on residual magnitude and position with no human input; it cannot be told what a macrozone looks like on *this* cut. Phase F adds that: paint a few examples, get a segmentation.

It also closes the reuse loop. A recipe tuned on one cut of a campaign should apply to the next fifty without re-tuning every parameter by hand. The `diag_recipes` table and the `filter_profiles` precedent already exist; Phase F wires the UI.

## Non-goals

- **Supervised deep learning** (PointNet++, U-Net). Rejected in the original design — no labelled data, and obtaining it needs destructive EBSD. Unchanged.
- **Cross-cut seed transfer.** Seeds are polygons in one cut's coordinate space; they do not carry to another cut. Applying a saved recipe brings the *step and its parameters*, not the seeds — identical to how a bound mask works in Phase E.
- **Replacing HDBSCAN.** `grow_segmentation` produces a new channel, `segment_id`. `cluster_id` is untouched; a recipe may enable both.
- **The spatial-lasso shader path** (deferred from Phase E). Still deferred — selection lasso continues to evaluate in JS.

## Component 1 — the `grow_segmentation` step

### Contract

```python
@step(
    "grow_segmentation",
    produces=["segment_id"],
    requires=["x", "y", "resid_z"],
    tier="derived",
)
def _op_grow_segmentation(cols, params, inputs): ...
```

`tier="derived"` — it reads angular-grid columns, so it previews from `base.d1an` in seconds and never forces a re-bake to retune.

### Algorithm

`sklearn.semi_supervised.LabelSpreading(kernel="knn", n_neighbors=k, alpha=alpha)`.

1. Build the feature matrix `F = [x, y, *feature_columns]` where `feature_columns` defaults to `["resid_z"]` (params may add `"gi_star"`, `"glosh"`).
2. `StandardScaler` each column of `F` to zero mean / unit variance, then multiply the non-spatial columns by `attr_weight` (default `1.0`). `attr_weight > 1` makes the segmentation follow the attribute field more than spatial contiguity; `< 1` makes it hug spatial blobs.
3. Labels: each bound seed layer is one class. `y[i] = class_index` for points inside that layer's polygons, `-1` (unlabelled) everywhere else. Class index is the position of the layer name in `inputs["seeds"]` (an ordered dict — see Component 2).
4. `LabelSpreading.fit(F_scaled, y)`; `segment_id = model.transduction_` (the propagated label per point), as float32.

Chosen over seeded region growing (one brittle threshold, one blob per seed) and seeded watershed (needs the cloud gridded first). Label propagation over a k-NN graph is exactly "semi-supervised classification from sparse labels", is in a dependency the pipeline already has, is deterministic, and handles 2-class and multi-class with the same code.

### Degradation

Like `getis_ord` and `hdbscan`, the step degrades rather than raises:

- Fewer than 2 distinct seed classes painted (0 or 1 seed layer with points) → `segment_id` all `-1`, and a metric `segmentation_status: "needs >= 2 seed classes"`.
- Masked points (`resid_z` is `NaN` under a Phase-E mask) are excluded from `F` and the fit, and get `segment_id = -1`.
- Non-finite features after scaling (a degenerate all-constant column) → that feature is dropped with a metric note.

### The 2-class / multi-class distinction

There is no separate code path. "In / out" is the case with exactly 2 seed layers (e.g. `defect`, `clean`); "named zones" is 3+. The analyst chooses by how many seed layers they paint. `segment_id` is always the 0-based class index; the workbench's channel legend shows the seed-layer name for each id.

## Component 2 — `resolve_inputs` list mode

Phase E's `resolve_inputs` resolves one binding to one boolean array via `{"layer": name}`. `grow_segmentation` needs *several* seed layers, ordered. Add a second binding shape:

```json
"inputs": { "seeds": { "layers": ["defect", "clean"], "required": false } }
```

`resolve_inputs` detects `"layers"` (a list) vs `"layer"` (a string):

- `"layer"` → `Inputs[key]` is `np.ndarray | None` (unchanged, what `mask` uses).
- `"layers"` → `Inputs[key]` is `dict[str, np.ndarray]` — an **insertion-ordered** dict mapping each named layer to its rasterised boolean array. Missing layers are skipped (not `None`-filled); `required=true` with zero resolvable layers raises.

The tier gate and shape assertion from Phase E apply to each rasterised array unchanged. `recipe_hash`'s `_canonical` already sorts `inputs` by key and JSON-encodes the value, so a `{"layers": [...]}` binding hashes stably as long as the list order is preserved (it is — the analyst's class order is meaningful).

## Component 3 — the new channel

`segment_id` becomes the 12th D1AN column. This is a format widening, so:

| Change | File |
|---|---|
| `PUBLIC_COLUMNS += ("segment_id",)` | `scripts/diag/runner.py` |
| `_TRUNCATABLE += ("segment_id",)` (angular-domain, shortens under TSA truncation like `cluster_id`) | `scripts/diag/runner.py` |
| Assembly fill for a missing/disabled `segment_id` is `-1.0`, not `0.0` (0 is a valid class; -1 means "unsegmented") | `scripts/diag/runner.py` assembly loop |
| `DIAG_VERSION` 5 → 6 | `scripts/force_orchestrator.py` |
| `ChannelKey`, `WorkingSet`, `COLUMN_MAP`, `CHANNEL_ACCESSOR` gain `segmentId` / `segment_id` | `packages/force-plotting/src/selection.ts` |
| `STEP_META["grow_segmentation"]`, `recipeChannels` surfaces `segmentId` when the step is enabled | `packages/force-plotting/src/recipeChannels.ts` |
| `DiagScatter` renders `segmentId` categorically (reuse `CLUSTER_PALETTE`; `-1` → grey, same as noise) | `packages/force-plotting/src/DiagScatter.vue` |
| `clusterStats` is HDBSCAN-specific and stays as-is; a parallel `segmentStats` is **not** in scope for v1 — the channel legend (id → seed-layer name, point count) is enough | — |

`base.d1an` is unaffected (it is the pre-`tsa` state: `t, rev, x, y, sig`). Every already-baked `attrs.d1an` becomes stale and is re-baked by the `DIAG_VERSION` bump — the same migration Phase D-1's `base.d1an` addition performed. `DEFAULT_RECIPE` does **not** gain `grow_segmentation` (it needs seeds that do not exist by default); the assembly's `-1.0` fill covers every cut that never enables it.

## Component 4 — recipe library

Mirrors `filter_chain` / `filter_profiles` exactly, whose pattern `ForceDashboard.vue` already implements (`loadProfiles`, `saveProfile`, apply-copies-onto-the-cut).

- **`diag_recipes` table** already exists (migration `20260901000106`): `recipe_id`, `name` (unique), `recipe jsonb`, `notes`, timestamps. No schema change.
- **Directus registration** — a `directus_fields` migration so `/items/diag_recipes` is exposed (the table was created but never registered, same gap Phase E's `diag_layer` had).
- **`diagRecipes.ts`** — `fetchRecipeLibrary()`, `saveRecipe({name, recipe, notes?})`, `deleteRecipe(id)`, `applyRecipe(id): Recipe`. Thin, like `diagLayers.ts`.
- **`RecipeLibrary.vue`** — a compact control in the RecipePanel footer: a `<select>` of saved recipes (name + notes tooltip), **Apply** (copies the selected recipe onto the workbench's local `recipe` ref; the analyst then Bakes), **Save as…** (prompts for a name, POSTs the current recipe), **Delete**.
- Applying sets the workbench's `recipe.value`, which fires the existing debounced preview. It does **not** auto-Bake and does **not** touch seeds — the analyst re-paints seeds for the new cut, exactly as with masks.
- The saved `recipe` includes any `inputs` bindings (mask, seeds) by layer *name*. A campaign that uses a consistent naming convention (`defect`, `clean`) gets bindings that "just work" on the next cut once those layers are painted.

## Component 5 — the requeue trigger

Today, editing `diag_recipe` in the Directus admin (not via the workbench's Build button) leaves `diag_status` untouched, so the daemon never re-bakes and the artifacts silently disagree with the stored recipe. Close it with a trigger:

```sql
CREATE FUNCTION diag_requeue_on_recipe_change() RETURNS trigger AS $$
BEGIN
    IF NEW.diag_recipe IS DISTINCT FROM OLD.diag_recipe
       OR NEW.tool_setup_id IS DISTINCT FROM OLD.tool_setup_id THEN
        NEW.diag_status := 'pending';
        NEW.diag_requested_at := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER diag_requeue_on_recipe_change
    BEFORE UPDATE ON machining_force_analysis
    FOR EACH ROW EXECUTE FUNCTION diag_requeue_on_recipe_change();
```

`process_diag_row`'s own completion `UPDATE` sets `diag_status`, `diag_path`, `diag_points`, `diag_version`, `diag_metrics`, `diag_recipe_hash`, `diag_error` — **not** `diag_recipe` or `tool_setup_id` — so `IS DISTINCT FROM` is false on those writes and the trigger does not fight the daemon. The workbench's explicit `diag_status='pending'` PATCH still works (the trigger just re-affirms it). Painting a seed/mask layer does **not** change `diag_recipe`, so a layer edit alone does not requeue — an explicit Build does, which is the intended Phase E behaviour and unchanged here.

## Testing

- **Segmentation recovers a planted region.** Synthetic cut, implant a high-`resid_z` patch at known `(r, θ)`, paint one seed polygon inside it and one in clean material; assert `>90%` of the planted patch and `<5%` of the clean region get the "defect" class.
- **Multi-class.** Three seed layers → three classes present in `segment_id`; class order matches `inputs.seeds.layers` order.
- **Degradation.** 0 and 1 seed layers → all `-1` and the status metric; masked points → `-1`.
- **`resolve_inputs` list mode.** `{"layers": [a, b]}` → ordered dict of two boolean arrays; missing layer skipped; `required` + none → raises; a `{"layer": x}` binding still returns a bare array.
- **Recipe-hash stability.** A `{"layers": [...]}` binding hashes stably; reordering the list changes the hash (order is semantic); a disabled `grow_segmentation` step contributes nothing.
- **Default-recipe equivalence still holds.** `grow_segmentation` is not in `DEFAULT_RECIPE`; the assembly `-1.0` fill for `segment_id` is the only default-path change. The golden fixtures are frozen and never regenerated. `assert_columns_match_golden` currently asserts `set(cols) == set(expected)`, which a 12th column breaks — relax it to `set(expected) <= set(cols)` (every frozen column still present and byte-identical) plus an explicit check that any *extra* column is exactly `segment_id` and is all `-1`. That keeps the canary (`nondegenerate`) and the byte-for-byte comparison of the 11 real columns, and pins the new column's default.
- **Trigger.** `UPDATE ... SET diag_recipe = '{...}'` flips `diag_status` to `pending`; `UPDATE ... SET diag_points = 5` does not.
- **Library round-trip.** Save a recipe, apply it to a second cut, assert the second cut's `diag_recipe` equals the saved document.

## Phasing within F

One plan, one merge (per the standing "merge each phase as it finishes"). Task groups:

1. **Server** — `resolve_inputs` list mode; `grow_segmentation` op + registry; `PUBLIC_COLUMNS`/`_TRUNCATABLE`/assembly-fill/`DIAG_VERSION`; equivalence test update.
2. **diag-service** — no code change (it calls `run_recipe`); one test that a seeded preview returns `segment_id`.
3. **Frontend channel** — `selection.ts` + `recipeChannels.ts` + `DiagScatter` categorical render + `STEP_META`.
4. **Recipe library** — `diag_recipes` Directus migration; `diagRecipes.ts`; `RecipeLibrary.vue`; wire into `RecipePanel`/workbench.
5. **Trigger** — one migration.
6. **Verify** — full suites; re-bake all 5 cuts under `DIAG_VERSION=6`; headless: paint 2 seed layers, preview shows `segment_id`, save/apply a recipe, edit `diag_recipe` in admin and watch it requeue.
