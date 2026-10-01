# Recording — Slice 2d: Directus 2-Way Sync (sample dropdown + run write-back + offline queue)

**Status:** implemented 2026-07-30 (`apps/force-app/web/src/record/directusSync.ts`). Phase 2
slice 2d of the standalone force app. (2b, real NI-DAQ acquisition, was paused at the time pending
a working NI-DAQmx runtime; it has since shipped as `apps/force-app/backend/app/sources/nidaq.py`.)

## Context

The recording workspace (2a/2a.1) captures cuts and compiles metadata locally. 2d closes the loop
with the database: it **auto-populates pickers from Directus** (samples available for machining) and
**writes a run record back** when a capture succeeds — the two-way communication from the original
brief. It must be **offline-resilient**: if the DB is unreachable, the write is queued locally and
synced when the network returns.

### Decisions locked (2026-07-30)
- **Run record only** (no file upload): create a `manufacturing_operations` row. The cut is logged;
  it becomes viewable in the Plotting app once the existing crawler ingests its `.mat` (out of scope
  here). Leaner, fewer failure modes than also uploading the capture + creating an analysis row.
- **Write-back from the frontend** (reuses the SPA's Directus bearer auth) with a **localStorage
  offline queue**. The backend stays hardware/compute-only; it does not touch Directus.

## What gets written

A `POST /items/manufacturing_operations` with (all fields verified present in the schema):
- `sample_id` (m2o → physical_samples, from the Sample picker), `operator_person_id` (→ people),
  `equipment_id` (→ equipment) — the linkable pickers.
- `operation_date` (capture time, ISO), `pass_code` (from the Operation field or generated),
  `process_category: 'machining'`, `machining_operation_subtype` (op type).
- `machining_spindle_speed_rpm`, `machining_feed_mm_per_rev`, `machining_workpiece_diameter_mm`,
  `machining_cutting_speed_m_per_min` (π·d·rpm/1000), `machining_force_captured: true`,
  `machining_tacho_used: true`, `machining_coolant_used`.
- `capture_software: 'force-app'`, `capture_frequency_khz` (Fs/1000), `outcome_notes`.
- `recorded_metadata` (json): the full compiled metadata + `{ capture_id, peaks, source, replay_of }`.

Free-text metadata without a clean m2o here (insert, edge, tool, coolant) rides in
`recorded_metadata` rather than being resolved to FK ids (kept simple for this slice).

## Frontend design (`apps/force-app/web/src/record/`)

- **`directusSync.ts`** — the offline write queue:
  - Queue persisted in localStorage (`force-app.sync.queue`): pending `{ id, payload, createdAt, attempts }`.
  - `logRun(payload)` → enqueue + `flush()`. `flush()` POSTs each item via the Directus `api`
    (bearer); removes on success; on a network error / `navigator.onLine === false` it stops and
    retries later; a 4xx (validation/permission) surfaces the error but keeps the item for manual retry.
  - Flushes on the `online` event + a periodic timer while pending. Exposes reactive
    `syncStatus { pending, syncing, lastError, lastSyncedAt }`.
- **`directusLookups.ts`** — debounced search helpers over the Directus `api`:
  `searchSamples(q)` (physical_samples: sample_code, sample_id, diameter_mm),
  `searchOperators(q)` (people, `is_operator: true`), `searchEquipment(q)` (equipment).
- **`workspace.ts`** — add `sampleId/operatorId/equipmentId` + picked labels, the lookups, a
  `logRun()` action that builds the payload from cfg/meta/plot/summary + selected ids, and re-exposes
  `syncStatus`. Selecting a sample auto-fills `cfg.diam` from its `diameter_mm`.
- **`MetadataPanel.vue`** — Sample / Operator / Machine become **searchable Directus-backed pickers**
  (a small typeahead component `LookupField.vue`); insert/tool/coolant/notes stay free text.
- **UI** — when a capture is `done`, the Recording Options panel shows **“Log run to database”** +
  a sync status line (Synced ✓ / Queued offline · N pending / error). A small sync indicator also
  sits in the workspace toolbar. Logging requires a selected sample (button disabled otherwise, with a hint).

## Verification

- **Backend/unit:** none new (frontend + Directus only).
- **End-to-end** (`tests/ui/verify_recording_2d.mjs`, Playwright): log in → Recording → run a short
  sim cut → pick a real sample (typeahead) → **Log run**; assert a `manufacturing_operations` row was
  created in Directus (query by the unique `pass_code`/`capture_id` in `recorded_metadata`) with the
  right sample + params + `machining_force_captured=true`. Then **offline test**: `context.setOffline(true)`,
  log another run → assert it queues (pending > 0, no row yet); `setOffline(false)` → assert it flushes
  (row appears, pending → 0). **Clean up**: delete the created test rows so the DB is left untouched.

## Out of scope (later)
File upload + `machining_force_analysis` creation (record→view loop); resolving insert/tool/edge to
FK ids; 2b (NI-DAQ), 2c (LabAmp), 2e (alarms).
