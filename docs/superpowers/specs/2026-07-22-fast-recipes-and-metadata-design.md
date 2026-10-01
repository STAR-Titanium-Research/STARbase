# FAST: recipe linking + machine-sourced metadata

**Date:** 2026-07-22
**Status:** Implemented 2026-07-22 — migrations `20260722000100_fast_recipes.sql` and
`20260723000102_fast_recipe_field_dedup.sql`, `scripts/fast_recipes.py`, and the FAST dashboard's
recipe panel (`core/extensions/d1-fast-dashboard`).

## Context

The FAST sintering runs were just rebuilt from the machine backends (9,735 FAST 25 ops from
`ECS_Analysis.MDB`, 313 FAST 250 ops from the export run-list, 305 plottable traces). Two gaps
remain in how that data surfaces:

1. **Recipes are free text.** `sintering_recipe_number` holds a name/number string, so there is
   no way to ask "show me every run of this recipe", and the recipe's own parameters
   (target temperature, force, hold time) are not in the database at all.
2. **The operation detail shows the wrong metadata.** The dashboard's stats grid was built for
   the old Google-sheet log import, so it surfaces sheet-era QA fields (V@maxT, P@maxT, PTC
   top/bot) that are now mostly NULL, while the real measured values sitting in each trace are
   not shown. It is also not machine-aware: FAST 25 and FAST 250 provide different fields.

**Governing rule (user):** all metadata that is not QA moves off the Google-sheet logs. Machine
data (MDB / export list) and the measured trace are authoritative. Only **CoSHH ref** and
**comments/failures/alarms** remain sheet-derived.

**Key enabling discovery:** FAST 25 runs *can* be linked to recipes. `Versuch.Bezeichnung` ends
in `/ N` where N is the `ProgrammNr` in `ECS_Prog.mdb::Rezept` — **9,600 of 9,735 runs (98.6%)**
resolve, and the recipe's `ProgrammText` matches the run title, confirming the key is real.

## Goals

- Link every FAST operation to a real recipe record, for both machines.
- Source all non-QA operation metadata from machine data or the measured trace.
- Reshape the FAST dashboard's detail panel (and the Directus operation form) to show correct,
  machine-aware, provenance-labelled metadata.

## Non-goals

- FAST 25 `.HIS` trace decoding (still deferred — see `scripts/fast_his.py`).
- Any change to the machining/FRM force system (`d1-force-dashboard`, `/filter/run`, `.mat`).
- Redesigning the FAST page layout: the 3-column layout and plot grid stay as they are.

## Design

### 1. Data model — `fast_recipes` + operation link

New collection, registered in Directus following the pattern in
`db/migrations/20260709000084_fast_run_data.sql` (collection + fields + relations + Lab Member
read permission).

```sql
CREATE TABLE fast_recipes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  machine       VARCHAR(8)  NOT NULL,      -- '25' | '250'
  program_nr    INTEGER,                   -- FAST 25 ProgrammNr; NULL for 250
  name          TEXT        NOT NULL,      -- ProgrammText / .rcp basename
  group_name    TEXT,
  source_file   TEXT,                      -- 'R_HPD 25_00001248' / 'PROGS/x.rcp'
  target_temp_c   NUMERIC,
  target_force_kn NUMERIC,
  hold_time_min   NUMERIC,
  params        JSONB,                     -- raw Daten1-20 / .rcp segment rows
  date_created  TIMESTAMPTZ,
  date_changed  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identity differs per machine: FAST 25 is keyed by ProgrammNr (two recipes may share a
-- ProgrammText), FAST 250 has no program number and is keyed by name. Hence two partial
-- indexes rather than one composite — a plain (machine, lower(name)) unique index would
-- wrongly reject legitimate FAST 25 duplicate-titled recipes.
CREATE UNIQUE INDEX fast_recipes_prog_uniq ON fast_recipes (machine, program_nr)
  WHERE program_nr IS NOT NULL;
CREATE UNIQUE INDEX fast_recipes_name_uniq ON fast_recipes (machine, lower(name))
  WHERE program_nr IS NULL;

ALTER TABLE manufacturing_operations
  ADD COLUMN fast_recipe_id UUID REFERENCES fast_recipes(id) ON DELETE SET NULL;
CREATE INDEX manufacturing_operations_fast_recipe_idx
  ON manufacturing_operations (fast_recipe_id);
```

Directus registration: `fast_recipes` collection (hidden, grouped under manufacturing);
`fast_recipe_id` as an M2O on `manufacturing_operations` displaying `{{name}}`; an O2M
back-reference `runs` on `fast_recipes` so a recipe page lists its runs.

**Identity is deterministic** so importers stay idempotent: `id = uuid5(NS, "fast25|<ProgrammNr>")`
or `uuid5(NS, "fast250|<lower(name)>")`.

### 2. Recipe import + linking

**FAST 25** (`import_fast25.py`):
- Read `ECS_Prog.mdb::Rezept` → upsert `fast_recipes` rows (machine `'25'`, `program_nr`,
  `name`=ProgrammText, `group_name`, `source_file`=FileName, `params` from Daten1-20,
  `date_created`/`date_changed`). ~2,761 recipes.
- Parse trailing `/\s*(\d+)\s*$` from `Versuch.Bezeichnung` → `program_nr` → set
  `fast_recipe_id`. Expect ~9,600 linked; the ~135 unmatched keep `fast_recipe_id` NULL.
- Derive `target_temp_c` / `target_force_kn` / `hold_time_min` from the recipe's Daten columns
  using the same defensive numeric extraction already in `import_fast25.py` (`first_num`).

**FAST 250** (`import_fast250.py`):
- Import `PROGS/*.rcp` → `fast_recipes` (machine `'250'`, `name`=file basename,
  `source_file`=relative path, `params`=parsed segment rows, targets parsed from the filename
  convention e.g. `D105_IN718_Briq_1125_35MPa_30mins`).
- Link each op by recipe name from the export list / trace preamble. Names not present in
  `PROGS/` are still created as name-only recipe rows so every run links.

`sintering_recipe_number` is retained as the raw machine string (provenance), with
`fast_recipe_id` as the structured link.

### 3. Measured run summary — populate `fast_run_data.summary`

`fast_run_data.summary JSONB` already exists and is unused. `normalize_fast_csv` already computes
per-channel `min`/`max` for the series catalog; extend it to also emit a summary keyed by the
canonical channel keys already defined in `fast_mapping._CANON`:

```json
{"peak_temp_c": 1601.2, "peak_force_kn": 63.1, "peak_power_kw": 42.0,
 "peak_voltage_v": 8.4, "ptc_top_max_c": 412, "ptc_bot_max_c": 389,
 "dwell_s": 1800, "ramp_c_per_min": 98.5}
```

Derivation: peaks from the `pyro_top` / `force` / `sps_power` / `sps_voltage` / `ptc_top` /
`ptc_bot` channel maxima; `dwell_s` = time within 2 % of peak temperature; `ramp_c_per_min` =
mean slope from 10 % to 90 % of peak temperature. Any channel absent from a given trace simply
omits its key — consumers must treat every key as optional.

The orchestrator writes `summary` alongside `series` (one extra column in the existing UPDATE).
Requires re-running the 305 FAST 250 traces (~10 min) to backfill.

### 4. QA boundary correction

`apply_fast_qa_backup.py` currently fills *any* NULL machine field from the sheet backup. Narrow
it to **CoSHH ref + outcome notes only**, and add a one-off revert that NULLs the sheet-written
`sintering_mass_grams`, `sintering_mould_diameter_mm`, `sintering_ptc_top_celsius`,
`sintering_ptc_bot_celsius`, `sintering_voltage_at_max_t_v`, `sintering_power_at_max_t_kw` on the
528 operations that step touched.

The revert is safe: `fast_log_qa_backup` retains every original value, and those quantities are
recoverable as measured values from the trace summary.

### 5. Dashboard detail panel

`core/extensions/d1-fast-dashboard/src/FastDashboard.vue` — layout unchanged, detail column
reworked. `opMeta` and `stats` are currently flat literal arrays; replace them with a
machine-aware, provenance-tagged builder:

- **Recipe card** (new): name, program number, target temp/force/hold; links to the recipe record
  and to its runs. Hidden when `fast_recipe_id` is NULL.
- **Stats grid**: prefers `fast_run_data.summary` (tagged *measured*), falls back to the recorded
  operation metadata (tagged *recorded*), falls back to sheet QA (tagged *QA log*) for CoSHH.
  A tile with no source on this machine is **omitted**, not rendered empty.
- **Provenance line**: `machine · source` so a number's origin is never ambiguous.
- Add `fast_recipe_id.*` and `summary` to the existing detail/list `fields` requests. The list
  query gains `summary` so peaks can show per row.

To keep the file from growing further (already 605 lines), the metadata/stat derivation moves
into a small sibling module `fastMeta.ts` with pure functions
(`buildOpMeta(detail)`, `buildStats(detail, fastRun)`), unit-testable without mounting the view.

### 6. Directus operation form

Group the sintering fields so provenance is visible in the record editor: machine-sourced fields
(recipe link, temp, force, mould, mass, atmosphere, TC/Pyro) separate from the QA-log fields
(CoSHH ref, comments). Follow the conditional-group convention already used in this project:
base `hidden=false` plus "hide unless" conditions.

## Verification

1. **Recipes imported**: `fast_recipes` ≈ 2,761 (machine 25) + ~100–310 (machine 250).
2. **Linkage**: ≈9,600 FAST 25 ops and ~all FAST 250 ops have non-NULL `fast_recipe_id`;
   spot-check that a linked recipe's name matches the run's `Bezeichnung` prefix.
3. **Idempotency**: re-run both importers → no new recipes, no new ops, `done` traces untouched.
4. **Summary**: all 305 `fast_run_data` rows have non-empty `summary`; peak temp/force for a known
   run (e.g. FAST 250 run with a 1600 °C recipe) is within tolerance of the recipe target.
5. **QA revert**: the six reverted columns are NULL on the 528 previously-touched ops, while
   `fast_log_qa_backup` still holds 1,895 rows; CoSHH + notes survive.
6. **Dashboard**: select a FAST 250 op → recipe card populated, stats show *measured* peaks;
   select a FAST 25 op (no trace) → stats show *recorded* MDB values, no empty tiles, recipe card
   populated.
7. **No FRM regression**: `git status` shows no tracked changes under
   `core/extensions/d1-force-dashboard/`.

## Risks

- **FAST 250 recipe-name collisions** — export/trace names are truncated (e.g.
  `D200_SSME26-007-BBT_SiO2_1210…`). Mitigation: match case-insensitively on the trimmed name and
  create a name-only recipe when no `PROGS/*.rcp` matches, so linking never silently drops a run.
- **`summary` backfill cost** — re-draining 305 traces takes ~10 min and re-uploads the CSVs.
  Acceptable; the importer's `status <> 'done'` guard means this must be an explicit reset.
- **Mojibake in MDB text** (`Ti-64 1200°C` → `1200?C`) affects recipe/run titles cosmetically.
  Out of scope here; worth a follow-up on the access-parser decode path.
