# Diagnostics across a campaign (P10)

**Status:** Implemented. Code: `packages/force-plotting/src/{RecipeLibrary.vue,RecipeDialog.vue,recipeIo.ts,diagPicker.ts,diagBatch.ts}`,
`apps/force-app/web/src/force/{DiagnosticsPage,DiagPicker,DiagBatchDialog}.vue`. Plan: `plans/2026-10-06-ux-larger-items.md`, stream N.

## Problem

The Diagnostics page is built for one cut at a time. Running the same recipe over a campaign means
opening each operation in a flat `<select>` (`limit: -1`, no search, no grouping), pressing Bake
and waiting. The recipe library uses `window.prompt` / `window.confirm` (blocked or ugly in the
packaged app, no notes field, no rename), recipes cannot be moved between machines, and the
workbench does not say when the recipe in hand differs from the saved one it came from.

## How a build is requested today

1. `DiagnosticsPage.vue` loads `machining_force_analysis` rows with `status = done` (a diagnosis
   needs the archive `.mat` of the base analysis) and the `diag_*` fields.
2. Build / Retry / the workbench's Bake (`build(recipe?)`) does one `PATCH
   /items/machining_force_analysis/:id` with `diag_status: 'pending'`, `diag_requested_at: now`
   and, for a Bake, `diag_recipe: <recipe>` (a plain Build leaves `diag_recipe` untouched, NULL =
   the built-in default). A role without update permission on the analysis table gets 403 (Lab Member has it since
   migration 111, so it can queue builds; roles without it, e.g. read-only ones, cannot).
3. The host orchestrator (`scripts/force_orchestrator.py`) polls: `claim_diag` picks rows with
   `diag_status = 'pending'` (oldest `diag_requested_at` first, concurrency 1, `FOR UPDATE SKIP
   LOCKED`), flips them to `processing`, and `process_diag_row` bakes the octree, then stores
   `diag_status = 'done'`, `diag_path`, `diag_metrics` and `diag_recipe_hash`
   (`recipe_hash(recipe)`, plus `:<layer fingerprint>` when painted layers exist).
4. The page polls the row every 3 s (15 min cap) until done / error.

There is no diag-service involvement in a bake (that service only serves previews).
The orchestrator already queues: any number of `pending` rows are processed one after another,
so batch apply needs **no server change**.

## Options

- **A. Server-side batch endpoint** (one call, server loops). Needs a new route and permissions
  work; rejected: the orchestrator is already the queue.
- **B. Client loop issuing the same PATCH per operation (chosen).** Sequential, with a cancel
  check between items, then stop; no polling per item (the queue is the host's job; the page
  reports "queued", and each row's state shows in the picker after Refresh).
- **C. Parallel PATCHes.** Rejected: no gain (host concurrency is 1), worse on errors/cancel.

## Decision

1. **Recipe dialogs / import / export.** An in-app `role="dialog"` modal (focus trap, Escape,
   focus restored to the opener, as `PlotHelp.vue`) replaces prompt/confirm for save-as (name +
   notes), rename and delete. Export writes `{ d1_recipe: 1, name, notes, recipe }` JSON;
   import validates the shape and the recipe (known ops, `on`/`params` types, `recipeProblems()`
   must be empty) and drops it into the same save-as dialog so the name can be fixed before it is
   stored. A "modified" badge shows when the workbench recipe is not `recipesEquivalent` to the
   library recipe last applied/saved. Saving an *imported* recipe stores it without putting it on the
   workbench, so it does not move that baseline (`baselineAfterSave`); otherwise the untouched working
   recipe would read as modified. Import also refuses an unsupported `recipe_version`, a param the op
   does not have or of the wrong kind or option, malformed `inputs` bindings, and layer inputs on a
   base-tier step (the host raises on those).
2. **Picker.** Pure module `diagPicker.ts`: search over code/sample/campaign, group by sample
   (campaign shown when the row carries it), filter chips Needs build / Built / Error (building
   rows count as Needs build). A searchable list replaces the select, shown 200 rows at a time
   with "Show more" (the list is cheap to filter in memory; the fetch keeps `limit: -1` for now,
   see P12). Each row links to Plot (`/plot?...`) and the Directus item.
   **Campaigns are optional.** Nothing in the migrations or `configure_users_and_policies.sql`
   grants Lab Member read on `campaigns`, and a nested `operation_id.campaign_id.*` read on a
   forbidden collection is a 403 that would empty the whole list. The main query therefore asks
   only for the foreign key (`operation_id.campaign_id`); the campaign records come from a separate
   `GET /items/campaigns` that may fail, and `attachCampaigns()` merges them in. If it fails, the
   rows carry no campaign, the Campaign grouping is hidden and the picker groups by sample.
3. **Apply recipe to selected.** Multi-select checkboxes in the picker, a recipe chooser from the
   library, then `planBatch()` (pure) classifies each selected row:
   - **skip, already built:** `diag_status = done` and the effective baked recipe
     (`diag_recipe ?? DEFAULT_RECIPE`) is `recipesEquivalent` to the chosen one;
   - **skip, already queued:** `pending` / `processing`;
   - **refuse, with reason:** recipe invalid (`validateRecipe` / `recipeProblems`); a request the
     server refuses (403, the role can't update analysis rows, which also stops the run) is reported as refused too. A cut
     with no archive `.mat` is not detected up front: the host marks it `error` as today;
   - **queue:** everything else.
   The executor sends exactly the Bake PATCH (shared `buildPatch()` helper in `diagBatch.ts`, now used by the
   single build too) per queued row, sequentially, updates progress, checks a cancel flag between
   items, and ends with a summary (queued / skipped (reason) / refused (reason) / failed (reason,
   403 = the role can't request builds)). "Rebuild anyway" is an explicit checkbox that disables the already-built
   skip.

## Idempotency and the recipe hash

The authoritative `diag_recipe_hash` is computed in Python over canonical JSON; reproducing its
bytes in JS (float formatting such as `0.0`) is fragile and an error would silently skip or
rebuild. The client therefore compares recipes structurally with `recipesEquivalent` (same
enabled steps, op, params, inputs; ids and disabled steps ignored), which is exactly the
information `recipe_hash` hashes, against the recipe stored on the row. This also matches the
existing "bake stale" chip. Painted layers are not part of this check: a cut whose layers changed
shows as built; use "Rebuild anyway".

## Out of scope

Server-side batch endpoint or priority queue; per-item polling to completion; applying to rows
across pages beyond what the list loads (P12); pagination of the fetch; writing the layer
fingerprint client-side; recipe sharing between users beyond JSON files.
