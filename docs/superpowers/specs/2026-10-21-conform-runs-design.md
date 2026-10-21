# Conform runs — design

**Date:** 2026-10-21
**Status:** design agreed in the maintainer's design interview (all answers below are binding). Plan: [2026-10-21-conform-runs](../plans/2026-10-21-conform-runs.md). ADR: [ADR-0024](../../adr/0024-conform-is-its-own-process-category.md).

## Why

The lab runs a Conform machine (continuous rotary extrusion): loose swarf or powder goes into a grooved wheel and comes out of a die as one long length, which is later sectioned into samples. Today a Conform run can only be recorded as a generic *deformation* operation with type "extrusion". Its machine log (a 1 Hz CSV of 24 channels) lives in spreadsheets, where energy use and the per-setting temperature ranges are worked out by hand: the "Power & Cost" and "Summary" tabs of `MT3 - Machine Data.xlsx`.

This feature makes the Conform run a first-class operation. It gets its own form, a log upload, energy and step summaries worked out from the log, a plotter (the FAST plotter, reused), process-map and Operation-page panels, and a PDF appendix.

## Words

These are in `CONTEXT.md`: **Conform run**, **Feedstock**, **Extrusion**, **Conform log**, **Run window**, **Step**, **Conform plotter**. "Batch" is never used for Conform (it means operations done together), and "Confirm" is a typo.

## Goals

1. A Conform run is an operation of a new process category `conform`, with its own field group on the operation form.
2. Feedstock is recorded as one of:
   - the input **Sample** (swarf from the lab's own machining; a mixed feedstock is one Sample with several lineage parents)
   - a **raw stock lot** linked to the Extrusion through the existing `sample_stock_provenance`
   - text
3. The output is one **Extrusion** Sample, linked to the feedstock Sample as **extruded from**. Sectioning it uses the ordinary cut operations already in place.
4. A **Conform log** CSV is uploaded once and processed **in the browser**, with no host daemon. Several Conform runs can share one log, each owning a **run window**.
5. Each run gets the following, all computed over its own window only:
   - a summary
   - energy figures
   - a **steps** table
6. The log itself gets whole-log energy totals.
7. Four derived **power channels** are added to the stored CSV: motor, IPS, cooling and total, in kW.
8. The **Conform plotter** at `/plot/conform` is the FAST plotter with a Conform profile. `/plot/fast` behaves exactly as before.
9. Panels: the process-map container, hover card and rail; the Operation page's "Conform run" section; and a PDF report appendix.

## Non-goals (this version)

- Network streaming of live machine data. Its design is deferred until the protocol is known; nothing here pre-builds it.
- The thermocouple heat-transfer correction ("Calculated Temperature", `h(Ttc − Tair)`, `tm4`).
- Recording where along the extrusion each section was cut, or mapping length to log time.
- Energy cost (tariffs).
- Bulk import of past logs. Past runs are uploaded one CSV at a time; a spreadsheet sheet is exported to CSV first.
- xlsx upload.

## Data model

### Process category, method, machine, lineage

Migration `20261022000206_conform_category.sql`:

- **Category.** Add `conform` to both `process_category` CHECKs: `manufacturing_operations` (migration 031) and `manufacturing_methods` (migration 129).
- **Method.** Insert method `CF`, "Conform (continuous extrusion)", with `process_category = 'conform'`.
- **Machine.** Add `conform` to the Conform machine's `equipment.capabilities` (row `equipment_name = 'Conform'`, seeded in migration 056). Keep `deformation` too, so old records stay valid. Add `conform` to the `capabilities` field's choices.
- **Lineage.** Add `extruded_from` to the `sample_genealogy.relationship_type` CHECK. `mfg_op_link_genealogy` maps method `CF`, or category `conform`, to `extruded_from`.
- **Operation code.** `operation_code_for()` gets a conform branch that builds `DD-MM-YY-CF-{run:03}-{die}dia` (for example `17-03-25-CF-012-8dia`).
  - The `{die}` token is dropped when the die diameter is empty.
  - The run number falls back to the existing sample-seq rule when empty, the same way the sintering branch falls back.
- **Uniqueness.** A unique index on `(equipment_id, conform_run_number) WHERE process_category = 'conform' AND conform_run_number IS NOT NULL`.
- **Inline columns on `manufacturing_operations`:**

| column | type | label (unit suffix) |
|---|---|---|
| `conform_run_number` | integer | Conform run number |
| `conform_feedstock` | text | Feedstock (when not a sample or lot) |
| `conform_feedstock_form` | text, choices `swarf, powder, granules, rod` | Feedstock form |
| `conform_feed_mass_g` | numeric(10,2) | Feedstock mass charged (g) |
| `conform_die_diameter_mm` | numeric(8,3) | Die exit diameter (mm) |
| `conform_tooling_id` | text | Abutment / die tooling |
| `conform_extrusion_length_mm` | numeric(10,1) | Extrusion length (mm) |
| `conform_extrusion_mass_g` | numeric(10,2) | Extrusion mass (g) |
| `conform_yield_pct` | numeric(6,2) | Yield (%) |
| `conform_flash_mass_g` | numeric(10,2) | Flash mass (g) |
| `conform_wheel_speed_rpm` | numeric(8,3) | Wheel speed setpoint (rpm) |
| `conform_ips_setpoint_c` | numeric(8,1) | IPS setpoint (°C) |

- **Field metadata.** The `directus_fields` rows follow the inline-parameter convention of migration 143: base `hidden = true`, plus the condition `show when conform` on `process_category`.
- **Setpoints.** The wheel speed and IPS setpoint fields are filled from the log's first step when the window is set **and** the field is empty. After that they can be edited.

### Conform logs and run data

Migration `20261022000207_conform_logs_and_run_data.sql`:

```
conform_logs
  log_id            uuid pk default gen_random_uuid()
  directus_files_id uuid not null  → directus_files   -- the normalised CSV ("Conform Logs" folder)
  equipment_id      uuid null      → equipment
  source_filename   text not null
  log_start         timestamptz not null              -- first row, UTC
  log_end           timestamptz not null
  n_rows            integer not null
  duration_s        numeric not null
  series            jsonb not null                    -- [{key,label,unit,group,min,max,flat?}]
  totals            jsonb not null                    -- whole-log energy (see Energy)
  constants         jsonb not null                    -- the power constants used
  created_by        uuid, created_at timestamptz, version integer   -- OCC like every business table

conform_run_data
  id            uuid pk
  operation_id  uuid not null unique → manufacturing_operations on delete cascade
  log_id        uuid null → conform_logs on delete set null
  window_start  timestamptz null
  window_end    timestamptz null       -- CHECK (window_start < window_end) when both set
  status        text not null CHECK in ('no_log','no_window','done','error')
  summary       jsonb null             -- per-run summary + energy (window only)
  steps         jsonb null             -- [{start,end,duration_s,ips_setpoint_c,wheel_speed_rpm, ...}]
  error_message text null
  version, created_at, updated_at
```

- **No overlapping windows.** A `BEFORE INSERT OR UPDATE` trigger refuses a window that overlaps another run's window on the same `log_id`. The message names the other operation's code.
  - A trigger is used rather than an exclusion constraint, so no `btree_gist` extension is needed.
  - Gaps between windows are allowed. A window must lie inside `[log_start, log_end]`.
- **Status** is written by the browser:
  - `no_log` until a log is linked
  - `no_window` while a log is linked but the window is empty
  - `done` once the summary is computed
  - `error` with `error_message` when processing failed
- **Cross-cutting rows.** Every new business table gets them; follow `fast_run_data` in each:
  - audit triggers (migration 121)
  - OCC (`version`)
  - the LLM read-only allow list (132) and row security (168)
  - Lab Member visibility (141)
  - readers rules (166)
  - the Lab Viewer role (185)
  - `scripts/access_rules.json`
- **Access.**
  - `conform_run_data` follows `fast_run_data`: `{"read": "reader.operation"}`, and write for whoever can edit the operation.
  - `conform_logs` may be read by a reader of **any** run whose `conform_run_data.log_id` is that log. A log shared by runs with different readers therefore shows its whole file to each of them. The run records stay private. This is accepted (maintainer decision) and documented in the access docs.
  - A user who can create operations can insert logs.
  - Directus collections `conform_logs` and `conform_run_data` are hidden and grouped under `manufacturing_methods`, like `fast_run_data`. There is an O2M alias `manufacturing_operations.conform_run` in `grp_related`.

### Form layout

Migration `20261022000208_conform_form_layout.sql` adds `grp_conform` ("Conform") at sort **105**, between `grp_sample_prep` (100) and `grp_notes_files` (110), with the condition `Hide unless conform` (base not hidden; the condition hides it, which is the group convention).

- The fields come in this order: run number, feedstock, feedstock form, feed mass, die diameter, tooling, then wheel speed and IPS setpoint, then extrusion length, extrusion mass, yield, flash.
- The `-- BEGIN FORM LAYOUT` / `-- END FORM LAYOUT` block in `scripts/configure_form_layout.sql` is updated byte-identically. `tests/phase1_schema.sh` enforces this.
- The down migration restores the pre-images, as in migration 174.

## Processing a Conform log (browser)

A pure TypeScript module in `packages/fast-plotting/src/conform/`, with no Vue and no network calls, so it can be unit-tested and is host-neutral:

- **`parseConformCsv(text) → {startUtc, rows, columns}`**
  - Reads the header; the first column is `Timestamp` (ISO-8601 UTC).
  - Normalises the header text:
    - `Â°` becomes `°`, and `ºC` becomes `°C`.
    - The unit comes from the trailing `(…)`. `(C)` is read as `°C`.
    - A note after the unit (" – Die exit", " - behind abutment", " Die exit") is dropped from the key but kept as the label's note.
  - Columns with no unit that are not known channels are **ignored**: `Pwcool`, `PIPS`, `Pmotor`, `Column1`, `h(Ttc -Tair)`, `tm4`, `tm (K)`, `Calculated Temperature`.
  - Non-numeric cells become `NaN` and are counted.
  - The sample interval is checked: gaps over 1.5 s are counted and reported, not filled.
- **Channel catalogue.** A map from canonical header to `(key, label, unit, group)`:
  - Tooling Temperature 1 is labelled "Tooling 1 (behind abutment)" and Tooling Temperature 2 "Tooling 2 (die exit)".
  - Groups: `speed`, `torque` (% channels), `current`, `temp`, `power`, `ips`, `cooling`, `other`.
  - An unknown header *with* a unit passes through, grouped by its unit.
  - A temperature channel that never leaves ±1 °C of its first value is marked `flat: true` ("flat, possibly disconnected"); it is still plotted.
- **`powerChannels(rows)`.** Uses the maintainer's formulas, one value per row, in kW:
  - `p_motor_kw = √3 × V × motor_current_a × cosφ_motor / 1000`
  - `p_ips_kw = ips_coil_va × k_ips / 1000`
  - `p_cooling_kw = √3 × V × wheel_cooling_pump_current_a × cosφ_cooling / 1000`
  - `p_total_kw` is the sum of the three.
  - Constants live in one exported object, `CONFORM_POWER_CONSTANTS = {voltage_v: 400, cos_phi_motor: 0.85, k_ips: 0.95, cos_phi_cooling: 0.80, version: 1}`, and are stored in `conform_logs.constants`.
  - Negative currents are kept as logged, as the spreadsheet does.
- **Energy.** Energy in kWh is the sum of `p_kw × Δt / 3600` for each component, with Δt the row interval (1 s). This reproduces the spreadsheet: on sheet "2and10rpm2first" it gives motor **44.57**, IPS **0.78** and cooling **0.17** kWh. That is a golden test.
- **`normaliseLog(parsed)`** produces the CSV that is stored:
  - columns `time_s`, then every kept channel in catalogue order, then the four power channels
  - the `series` catalogue, as `[{key,label,unit,group,min,max,flat?}]`, which `fastCache.parseTrace` already reads
  - `totals` for the whole log
- **`summariseWindow(log, start, end)`.** Over the rows inside the window it returns:
  - `duration_s`
  - `extruding_s`: rows with wheel speed ≥ 1 rpm **and** motor torque > 10 %
  - `mean_wheel_speed_rpm`, `mean_torque_pct` and `mean_tooling1_c`, over extruding rows
  - `peak_torque_pct`, `peak_motor_current_a`, `peak_tooling1_c` and `peak_wheel_temp_c`
  - `ips_setpoint_c`
  - `energy_kwh: {motor, ips, cooling, total}` and `avg_demand_kw`
  - `n_rows` and `gaps`
- **`detectSteps(log, start, end)`.**
  - Walks the window, keyed on `(IPS setpoint, Wheel Speed Demand rounded to 0.5 rpm)`, and starts a new step whenever the key changes.
  - Steps shorter than 60 s are dropped. Their rows count to no step.
  - Each step holds: start, end, `duration_s`, `ips_setpoint_c`, `wheel_speed_rpm`, min/max/range of Wheel Temperature, Tooling 1 and Tooling 2, `mean_torque_pct`, and `energy_kwh` (total).
  - On sheet "AR250to350_5to10rpm" this yields the grid 250/300/350 °C × 5/8/10 rpm, which is a golden test.

## Upload and windows (flows)

- **Upload a log** (Conform plotter or Operation page, for a run with no log):
  1. Read the file.
  2. Run `parseConformCsv` and `normaliseLog`.
  3. `POST /files` the normalised CSV into the "Conform Logs" folder.
  4. Insert `conform_logs`.
  5. Upsert `conform_run_data` with `log_id` and the window set to the **whole log**.
  6. Run `summariseWindow` and `detectSteps`, and write the summary and steps with `status = 'done'`.

  Parse errors leave nothing behind. If a write after the file upload fails, the page deletes the uploaded file and shows the error. If the operation's date is empty it is set from `log_start`. If a date is set and differs by more than a day, a warning is shown and nothing is changed.
- **Use a log already uploaded.** Lists `conform_logs` from the same machine whose `log_start` is within ±1 day of the run's date. Picking one links it with an **empty** window (`status = 'no_window'`).
- **Set the window.**
  - In the plotter: "Use this view as the run window" takes `viewStart`/`viewEnd`.
  - On the Operation page: start and end as UK local clock times, editable.
  - Saving recomputes the summary and steps. An overlap refusal from the trigger is shown verbatim.
  - The setpoint fields are filled if empty.
- **Reprocessing.** If `conform_logs.constants.version` is older than the code's, or `summary.version` is missing, the Operation page offers "Recompute". The CSV is never re-parsed from the original; the normalised CSV holds everything needed.

## Plotter

The FAST plotter becomes a **run plotter with profiles**.

- **The profile.** `FastDashboard.vue` keeps its look and behaviour, and takes a `profile` prop (a `RunProfile` interface in `packages/fast-plotting/src/profile.ts`). The profile carries everything that is FAST-specific today:
  - the list query (category, fields)
  - the run-data loader (which table, and how to get the CSV and the `series`)
  - `buildOpMeta`, `buildStats` and the data-quality line
  - the seed groups for the default tiles
  - the localStorage layout key
  - the upload handler
- **FAST profile.** It reproduces today's behaviour exactly; the existing tests keep passing unchanged. Its layout key stays `d1-fast-dashboard-v1`.
- **Conform profile.** It lists `process_category = conform` and loads `conform_run_data` → `conform_logs` → `/assets/{directus_files_id}`. Its default tiles are:
  - wheel speed and demand
  - motor torque and current
  - temperatures (Tooling 1, Tooling 2, Wheel, IPS control)
  - IPS output and coil VA
  - power (motor, IPS, cooling, total)

  Its stats come from `summary`. Its layout key is `d1-conform-dashboard-v1`.
- **Additions that appear only when the profile supplies windows** (FAST never does):
  - It opens zoomed to the run's window.
  - Every run window on the log is drawn as a faint labelled band, labelled with the run's feedstock or code.
  - A "Use this view as the run window" button.
  - "Use a log already uploaded".
- **Hover** shows UK local clock time alongside elapsed time when the profile supplies a `startUtc`. FAST does not.
- **Routing.**
  - `apps/starbase/web/src/plot/routes.ts` adds `/plot/conform?operation=<id>`, with a host in `plotHosts.ts`.
  - `packages/d1-ui/src/links.ts` and `process.ts`: `analysisLink(id, 'conform')` → `/plot/conform?operation=<id>`, and `PROCESS_LABEL.conform = 'Conform'`.
  - Nav gets a "Conform plotter" entry under Analysis, next to "FAST plotter" (`navConfig.ts`, `usage.ts`).

## Panels

- **Process map** (`packages/starbase-pages/src/pages/map/`):
  - `ProcessCategory` and `CATEGORIES` include `conform`.
  - `KEY_SETTING_FIELDS.conform` = die diameter, wheel speed setpoint, IPS setpoint.
  - The log shows in the container's Inside tray as data.
  - `dataPreview` kind `conform`: a trace thumbnail of the run's **window** only (wheel speed plus Tooling 1), "Conform run data", and "Open in Conform plotter".
  - The palette and add search offer method CF like any other method.
  - Marking a planned Conform run done with a log but no window is a **warning** check, not a block.
- **Operation page** (`OperationPage.vue`, `operation/OperationAnalysis.vue`, `useOperationData.ts`): a "Conform run" section in "On this page" for `process_category = conform`. It shows:
  - status
  - window start and end, editable
  - the summary
  - energy (per component, total, average demand)
  - the steps table, with "Copy as CSV"
  - "Whole log" totals (duration, energy per component, average demand)
  - upload, "use a log already uploaded", and Recompute
  - "Open in Conform plotter"
- **Parameters panel.** `OPERATION_PARAM_PREFIX.conform = 'conform_'` in `packages/d1-ui/src/params.ts`.
- **Index pages.** The row plot button for Conform runs (`index/plotData.ts`, `RowPlotButtons.vue`), and a thumbnail (`IndexThumb.vue`) where FAST has one.
- **Data Studio interfaces.** `d1-process-category` `CAT_LABEL.conform = 'Conform (continuous extrusion)'`; `d1-operation-code` gets a Conform hint.
- **PDF report** (`core/extensions/d1-report`): `conformAppendix(runData, log)`, modelled on `fastAppendix`. It has four fixed panels plotted over the run window:
  - wheel speed and demand
  - motor torque
  - Tooling 1, Tooling 2 and wheel temperature
  - IPS output

  It ends with the summary table and the steps table.

## Error handling

- **A malformed CSV** (no `Timestamp` column, fewer than 2 numeric rows, timestamps not increasing) is refused before anything is uploaded, with the reason.
- **Missing channels.** Power components whose source channel is missing are left out. `totals` lists `missing: ['ips', …]`, the summary says so, and the steps are still computed.
- **Writes after the file upload fail:** the uploaded file is deleted and nothing else is left behind.
- **Window outside the log, or overlapping another run:** refused by the database, and the message is shown.
- **A reader who cannot read the log** sees "Conform log not visible to you" in place of the plot. The run summary is still shown, because it is part of the run.

## Testing

- **Unit tests** (vitest, `packages/fast-plotting/src/conform/*.test.ts`):
  - header normalisation (`Â°C`, annotated names, ignored derived columns)
  - power formula and energy, as a golden test against a committed excerpt: `packages/fast-plotting/src/conform/__fixtures__/tiswarf-excerpt.csv`, 900 rows (13:38:20–13:53:19) of the 2025-03-17 TiSwarf log, with the expected kWh computed independently in Python by the same formulas and pinned in the test
  - `summariseWindow` (extruding time, means, peaks)
  - `detectSteps` on a synthetic log with 250/300/350 × 5/8/10 steps and a sub-60 s blip
  - flat-channel detection
  - window clipping
- **Profile refactor.** All existing `fast-plotting` tests are unchanged and pass. A new test checks that the FAST profile's list query and layout key are identical to today's. The `hostNeutral` test covers the new files.
- **STARbase:** route tests for `/plot/conform`, `analysisLink`, nav entries, `dataPreview` kind `conform`, `KEY_SETTING_FIELDS`, and the Operation page section (component test with mocked API).
- **Schema** (`tests/phase1_schema.sh`):
  - the category map includes `CF → conform`
  - the overlap trigger refuses an overlapping window and accepts a gap
  - `extruded_from` is written for a CF operation with input and output
  - the form-layout block is byte-identical
  - the migration applies up, down and up again
- **d1-report:** the `conformAppendix` render test.
- **Physical test backlog** (`docs/runbooks/physical-test-backlog.md`): upload the TiSwarf log on a real Directus, set two windows, check the energy against the spreadsheet, open the plotter, and print the PDF.
