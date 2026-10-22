# Conform runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Conform run a first-class operation, with:
- its own form
- log upload processed in the browser
- per-run energy, summary and steps over a run window of a shared log
- a Conform plotter (the FAST plotter with a profile)
- process-map, Operation-page and PDF panels

**Architecture:**
- Schema: a new `conform` process category, inline `conform_*` columns, and two tables, `conform_logs` (one per uploaded file) and `conform_run_data` (one per operation: log, window, summary, steps).
- Log processing is a pure, host-neutral TypeScript module in `@d1/fast-plotting`. Both the plotter and the Operation page call it.
- `FastDashboard` takes a `RunProfile`. FAST behaviour is unchanged.

**Tech Stack:** Postgres/dbmate migrations, Directus metadata, Vue 3 + TypeScript (vitest, vue-tsc), plain-ESM Directus extensions (node:test).

**Spec:** [`docs/superpowers/specs/2026-10-21-conform-runs-design.md`](../specs/2026-10-21-conform-runs-design.md). Read it before starting. ADR-0025 and the `CONTEXT.md` terms (Conform run, Conform log, Run window, Step, Feedstock, Extrusion) are binding.

## Status

| Stream | Agent profile | Worktree / branch | Depends on | State |
|---|---|---|---|---|
| A — schema & access | `d1-server-implementer` | `worktree-agent-a2b953fa458f61b01` | — | **merged** (phase1 1991/0 on the merged branch; 206–208 round-trip) |
| B — log processing core | `directus-ui-implementer` | `worktree-agent-af20ca6ad2917a35b` | — | **merged** (136 tests pass) |
| C — run plotter profiles | `directus-ui-implementer` | `worktree-agent-ae27e8bda0ad913f5` | B merged | **merged** (fast-plotting 168, starbase-web 212) |
| D — STARbase panels | `directus-ui-implementer` | `worktree-agent-ab055b90f6766c20a` | B merged | **merged** (d1-ui 2158, starbase-pages 3233) |
| E — Data Studio interfaces & PDF | `d1-server-implementer` | `worktree-agent-a379d4c1b8b6358ad` | B merged | **merged** (d1-report 26/0) |
| Review — whole branch | `directus-ui-reviewer` + `migration-review` (Opus) | — | all merged | in progress |

The coordinator merges each stream into `ccr-e9d98032-16ccsn` after reviewing it. Workers commit in their own worktree, and never push, merge or rebase.

## Global Constraints

- Process category value is `conform`; method code `CF`; method name "Conform (continuous extrusion)"; lineage relation `extruded_from`.
- Migration numbers: `20261022000206_conform_category.sql`, `20261022000207_conform_logs_and_run_data.sql`, `20261022000208_conform_form_layout.sql`. Each is reversible: up, then down, then up again.
- Power constants (one exported object, `CONFORM_POWER_CONSTANTS`): `{ voltage_v: 400, cos_phi_motor: 0.85, k_ips: 0.95, cos_phi_cooling: 0.80, version: 1 }`.
- "Extruding" means a row with wheel speed ≥ 1 rpm **and** motor torque > 10 %.
- A step is keyed by `(IPS setpoint, round(wheel speed demand × 2) / 2)`. A run of rows shorter than 60 is dropped.
- Energy in kWh is `Σ p_kw × 1 s / 3600` over the rows, with Δt = 1 s per row. A step's `duration_s` is its row count. A window's `duration_s` is last time minus first time.
- Layout keys: FAST stays `d1-fast-dashboard-v1`; Conform is `d1-conform-dashboard-v1`.
- Routes: `/plot/conform?operation=<id>`. The nav label is "Conform plotter".
- Tooling labels: "Tooling 1 (behind abutment)" and "Tooling 2 (die exit)".
- UK local time (`Europe/London`) for clock times shown. Stored times are UTC `timestamptz`.
- There is no cost or tariff anywhere.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WqtXcLSE51vSVan6Yw2qev
  ```

## Canonical channel keys (shared by B, C, D and E)

| header (normalised) | key | unit | group |
|---|---|---|---|
| Wheel Speed (rpm) | `wheel_speed_rpm` | rpm | speed |
| Wheel Speed Demand (rpm) | `wheel_speed_demand_rpm` | rpm | speed |
| Motor Current (A) | `motor_current_a` | A | current |
| Motor Torque (%) | `motor_torque_pct` | % | torque |
| Tooling Temperature 1 (°C) | `tooling1_c` | °C | temp |
| Tooling Temperature 2 (°C) | `tooling2_c` | °C | temp |
| Wheel Temperature (°C) / 1 / 2 | `wheel_temp_c` / `wheel_temp1_c` / `wheel_temp2_c` | °C | temp |
| IPS Control Temperature (C) | `ips_control_c` | °C | ips |
| IPS Coolant Temp (°C) | `ips_coolant_c` | °C | ips |
| IPS Output (%) | `ips_output_pct` | % | ips |
| IPS Setpoint (°C) | `ips_setpoint_c` | °C | ips |
| IPS Work Coil VA | `ips_coil_va` | VA | ips |
| Wheel Cooling Pump Current (A) | `wheel_cooling_pump_current_a` | A | cooling |
| Wheel Cooling Demand (%) | `wheel_cooling_demand_pct` | % | cooling |
| Wheel Cooling Pump Torque (%) | `wheel_cooling_pump_torque_pct` | % | cooling |
| Machine Cooling Temp. (°C) | `machine_cooling_c` | °C | cooling |
| Product Cooling Temp. (°C) | `product_cooling_c` | °C | cooling |
| Bearing Oil Temperature (°C) | `bearing_oil_c` | °C | temp |
| Gearbox Oil Temperature (°C) | `gearbox_oil_c` | °C | temp |
| Powder Feeder Demand (%) / Setting (%) | `powder_feeder_demand_pct` / `powder_feeder_setting_pct` | % | other |
| Analogue Input 1 | `analogue_input_1` | (none) | other |
| derived | `p_motor_kw`, `p_ips_kw`, `p_cooling_kw`, `p_total_kw` | kW | power |

## Review Focus

1. **A second run linked to an already-uploaded log.** Its window starts empty, and setting it must never overlap the first run's window. The trigger refuses it, and the message names the other run. Owner: A (schema test) and B (`setRunWindow` surfaces the error text).
2. **A CSV exported from Excel.** It may have `Â°C` headers, a junk `Column1`, the computed `Pmotor`/`PIPS`/`Pwcool`, CRLF line endings, a BOM and trailing empty lines. It must parse to the same channels as the clean file. Owner: B.
3. **A log missing the IPS or cooling channels** (an older machine export). Energy is still computed for the components present, and `missing` lists the rest. Nothing throws. Owner: B.
4. **`/plot/fast` after the profile refactor.** The same list query, layout key, tiles and stats; a FAST user notices nothing. Owner: C (equality test of the FAST profile against today's constants).
5. **A reader who can read the run but not the log.** The Operation page still shows the summary and steps, and the plot area says "Conform log not visible to you". Owner: D.

---

### Task A1: Category, method, machine, lineage, code rule, inline columns (migration 206)

**Files:**
- Create: `db/migrations/20261022000206_conform_category.sql`
- Modify: `tests/phase1_schema.sh` (method → category map; `extruded_from`; code rule)

**Interfaces:**
- Produces: `manufacturing_operations.process_category = 'conform'`, the method `CF`, the `conform_*` columns in the spec's table (exact names and types), `sample_genealogy.relationship_type = 'extruded_from'`, and the `operation_code_for()` conform branch `DD-MM-YY-CF-{run:03}-{die}dia`.

- [ ] **Step 1:** Load the `db-migration` skill. In `tests/phase1_schema.sh`, add these assertions:
  - `CF` maps to `conform` in `manufacturing_methods`.
  - Inserting a CF operation with an input and an output sample writes `sample_genealogy` with `relationship_type = 'extruded_from'`.
  - A CF operation dated 2025-03-17, with `conform_run_number = 12` and `conform_die_diameter_mm = 8`, gets the code `17-03-25-CF-012-8dia`. With the die empty it gets `17-03-25-CF-012`.
  - Two CF operations on the same machine with run number 12 violate the unique index.
- [ ] **Step 2:** Run `make test-schema` (or `bash tests/phase1_schema.sh` as the skill describes). It is expected to FAIL on the new assertions.
- [ ] **Step 3:** Write migration 206.
  - Follow the CHECK-replace pattern of migration 129 for both `process_category` CHECKs and the `relationship_type` CHECK.
  - Update `mfg_op_link_genealogy` and `operation_code_for()` with `CREATE OR REPLACE`, copied from their latest definitions (migrations 034/136 and 156/158) with only the conform branch added.
  - Add `conform` to the capabilities of `equipment_name = 'Conform'` and to the capabilities field's choices.
  - Add the inline columns, with COMMENTs and the `directus_fields` rows (base `hidden=true`, condition `show when conform`), units in `options.suffix`, and `conform_feedstock_form` as a dropdown (`swarf, powder, granules, rod`).
  - The down migration restores every pre-image.
- [ ] **Step 4:** Apply up, down, up, then run the schema tests. Expected: PASS.
- [ ] **Step 5:** Run the `migration-review` skill, fix what it finds, and commit.

### Task A2: `conform_logs`, `conform_run_data`, overlap trigger, access (migration 207)

**Files:**
- Create: `db/migrations/20261022000207_conform_logs_and_run_data.sql`
- Modify: `scripts/access_rules.json`, `tests/phase1_schema.sh`, and the access doc that lists `fast_run_data` (grep `docs/` for `fast_run_data` read rules)

**Interfaces:**
- Produces:
  - the tables exactly as in the spec's "Conform logs and run data" block
  - the trigger `conform_run_data_window_guard`, whose error messages are `run window overlaps <operation_code>` and `run window lies outside the log`
  - Directus collections `conform_logs` and `conform_run_data` (hidden, grouped under `manufacturing_methods`)
  - the O2M alias `manufacturing_operations.conform_run`
  - the access rules: `conform_run_data` `{"read":"reader.operation"}` plus write as for operation editors; `conform_logs` readable by a reader of any operation linked through `conform_run_data.log_id`

- [ ] **Step 1:** In `tests/phase1_schema.sh`, add these assertions:
  - A log spanning 13:00–14:00. Run X with window 13:10–13:20 is accepted. Run Y with 13:15–13:30 is refused, and the message contains X's code. Run Y with 13:20–13:30 is accepted (they touch, they don't overlap: use half-open `[start, end)`). Run Y with 12:50–13:05 is refused as "outside the log".
  - `conform_run_data.status` rejects `'pending'`.
  - Deleting the operation deletes its `conform_run_data`. Deleting the log sets `log_id` to null.
- [ ] **Step 2:** Run the schema tests. Expected: FAIL.
- [ ] **Step 3:** Write migration 207.
  - Mirror every cross-cutting row that `fast_run_data` has: audit trigger (121), OCC `version` (010/122 pattern), LLM allow list (132) and row security (168), Lab Member visibility (141), readers rules (166), Lab Viewer (185).
  - Mirror `fast_run_data` in `scripts/access_rules.json`, and add the `conform_logs` "any linked run" reader rule.
  - Document the shared-log visibility in the access doc, in one paragraph.
- [ ] **Step 4:** Apply up, down, up, then run the schema tests. Expected: PASS. Then run `migration-review`, fix, and commit.

### Task A3: Form layout (migration 208) + backlog item

**Files:**
- Create: `db/migrations/20261022000208_conform_form_layout.sql`
- Modify: `scripts/configure_form_layout.sql` (the BEGIN/END block, byte-identical), `docs/runbooks/physical-test-backlog.md`

- [ ] **Step 1:** Add `grp_conform` ("Conform", sort 105, condition `Hide unless conform` with `_neq` → `hidden:true`).
  - Field order inside it: `conform_run_number` 10, `conform_feedstock` 20, `conform_feedstock_form` 30, `conform_feed_mass_g` 40, `conform_die_diameter_mm` 50, `conform_tooling_id` 60, `conform_wheel_speed_rpm` 70, `conform_ips_setpoint_c` 80, `conform_extrusion_length_mm` 90, `conform_extrusion_mass_g` 100, `conform_yield_pct` 110, `conform_flash_mass_g` 120.
  - Put `conform_run` in `grp_related` at the next free sort.
  - Keep pre-images for down, as migration 174 does.
- [ ] **Step 2:** Run `tests/phase1_schema.sh`. It must pass the byte-identical, no-tied-sorts and renderable-group checks. Apply up, down, up.
- [ ] **Step 3:** Add to `docs/runbooks/physical-test-backlog.md`, under the Directus/STARbase section:
  - **C1 — Conform log upload and energy**: on a real Directus, create a CF run, upload `TiSwarf.csv`, and expect the whole-log energy ≈ motor/IPS/cooling kWh, matching the spreadsheet method within 0.01 kWh.
  - **C2 — two runs share one log**: link a second run with "Use a log already uploaded", set non-overlapping windows in the plotter, and expect the bands drawn and an overlap refused.
  - **C3 — Conform form**: fields show only for CF; the code is `DD-MM-YY-CF-…`.
  - **C4 — PDF appendix prints.**
  - Each item names the PR.
- [ ] **Step 4:** Commit.

---

### Task B1: Parse and normalise a Conform log

**Files:**
- Create: `packages/fast-plotting/src/conform/channels.ts`, `parse.ts`, `power.ts`, `normalise.ts`, `index.ts`, and `parse.test.ts`, `power.test.ts`, `normalise.test.ts`
- Fixture (since review round 1: `synthetic-log.csv`; originally a real-log excerpt, now removed) (900 rows)
- Modify: `packages/fast-plotting/src/index.ts` (`export * from './conform'`)

**Interfaces:**
- Produces:
```ts
export type ConformGroup = 'speed'|'torque'|'current'|'temp'|'power'|'ips'|'cooling'|'other';
export interface ConformChannel { key: string; label: string; unit: string; group: ConformGroup; note?: string }
export class ConformLogError extends Error {}               // message = reason shown to the user
export interface ParsedConformLog {
  startMs: number; endMs: number; n: number;
  time: Float64Array;                                       // seconds from startMs
  channels: ConformChannel[]; values: Record<string, Float64Array>;
  ignored: string[]; nonNumeric: number; gaps: number;      // gaps = intervals > 1.5 s
}
export function parseConformCsv(text: string): ParsedConformLog;       // throws ConformLogError
export const CONFORM_POWER_CONSTANTS: { voltage_v: number; cos_phi_motor: number; k_ips: number; cos_phi_cooling: number; version: number };
export type PowerPart = 'motor'|'ips'|'cooling';
export function powerChannels(get: (key: string) => Float64Array | undefined, n: number):
  { p_motor_kw?: Float64Array; p_ips_kw?: Float64Array; p_cooling_kw?: Float64Array; p_total_kw: Float64Array; missing: PowerPart[] };
export interface EnergyKwh { motor: number|null; ips: number|null; cooling: number|null; total: number }
export function energyKwh(p: ReturnType<typeof powerChannels>, from: number, to: number): EnergyKwh; // rows [from, to)
export interface ConformTotals { duration_s: number; energy_kwh: EnergyKwh; avg_demand_kw: number; missing: PowerPart[] }
export interface NormalisedLog { csvText: string; series: SeriesMeta[]; totals: ConformTotals; constants: typeof CONFORM_POWER_CONSTANTS; logStart: string; logEnd: string; nRows: number; durationS: number }
export function normaliseLog(log: ParsedConformLog): NormalisedLog;
```

- [ ] **Step 1: Write the failing tests**
  - `parse.test.ts`:
    - The fixture parses with `n === 900`, `startMs === Date.UTC(2025,2,17,13,38,20)` and `gaps === 0`.
    - `channels.map(c => c.key)` contains every key in the plan's table except the derived ones.
    - `tooling1_c` has the label `"Tooling 1 (behind abutment)"`.
  - **Excel export:** the fixture header rewritten with `Â°C`, a BOM, CRLF, an extra `Column1`, `Pmotor` and `PIPS` (blank unit), the annotation `"Tooling Temperature 2 (°C) Die exit"`, and two trailing empty lines. It yields the same `channels` keys, and `ignored` contains `Column1`, `Pmotor` and `PIPS`.
  - Headers `"Tooling Temperature 1 (°C) - behind abutment"` and `"Calculated Temperature (ºC)"`: the first maps to `tooling1_c`; the second has a unit, so it passes through as key `calculated_temperature_c` in group `temp`.
  - These throw `ConformLogError`: no `Timestamp` column; one data row; decreasing timestamps.
  - `power.test.ts`:
    - Over the fixture, `energyKwh(..., 0, 900)` gives motor `6.004249`, ips `1.666247`, cooling `0.0000573065` and total `7.670553` (`toBeCloseTo(…, 5)`; cooling to 9 decimals).
    - With `ips_coil_va` removed, `missing` is `['ips']`, `energy.ips` is `null`, and `total === motor + cooling`.
  - `normalise.test.ts`:
    - The first CSV header cell is `time_s`.
    - The `series` order equals the CSV column order, with the four `p_*_kw` keys last in group `power`.
    - `parseTrace(csvText, series)` round-trips `motor_current_a[0]`.
    - `series.find(s=>s.key==='tooling2_c').flat === true` (the fixture's T2 stays within 23.9–24.4 °C). `tooling1_c` is not flat.
    - `totals.duration_s === 899`.
- [ ] **Step 2:** `npm test -w @d1/fast-plotting`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement.
  - Header normalisation: strip a BOM; `Â°` becomes `°`; `º` becomes `°`; the unit is the last `(...)`, with `(C)` read as `°C`; text after the unit (with a leading `-`, `–` or space) becomes `note`.
  - Lookup is on the header without its note, case-insensitive.
  - An unknown header with a unit passes through with a key slug of its name plus unit suffix (`_c`, `_pct`, `_a`, `_rpm`, `_va`, `_kw`, otherwise `_x`) and a group by unit (`°C` → temp, `%` → other, `A` → current, `rpm` → speed).
  - An unknown header without a unit, and not `Analogue Input 1`, goes into `ignored`.
  - `SeriesMeta` gains an optional `flat?: boolean` in `fastCache.ts`, which is a backward-compatible change. A channel is flat when it is a temperature and every value is within ±1 °C of its first finite value.
- [ ] **Step 4:** `npm test -w @d1/fast-plotting && npm run typecheck -w @d1/fast-plotting`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task B2: Window summary and steps

**Files:**
- Create: `packages/fast-plotting/src/conform/summary.ts`, `steps.ts`, `summary.test.ts`, `steps.test.ts`

**Interfaces:**
- Consumes: `Trace` from `fastCache.ts` (time in seconds from log start), `energyKwh`, and `powerChannels`.
- Produces:
```ts
export interface ConformSummary {
  version: 1; duration_s: number; n_rows: number; gaps: number;
  extruding_s: number; mean_wheel_speed_rpm: number|null; mean_torque_pct: number|null; mean_tooling1_c: number|null;
  peak_torque_pct: number|null; peak_motor_current_a: number|null; peak_tooling1_c: number|null; peak_wheel_temp_c: number|null;
  ips_setpoint_c: number|null; energy_kwh: EnergyKwh; avg_demand_kw: number; missing: PowerPart[];
}
export interface ConformStep {
  start: string; end: string; duration_s: number; ips_setpoint_c: number; wheel_speed_rpm: number;
  wheel_temp_c: { min: number; max: number; range: number } | null;
  tooling1_c: { min: number; max: number; range: number } | null;
  tooling2_c: { min: number; max: number; range: number } | null;
  mean_torque_pct: number|null; energy_kwh: number;
}
export function windowRows(trace: Trace, logStartMs: number, startMs: number, endMs: number): [from: number, to: number]; // rows with start <= t < end... inclusive of the last row when endMs === log end
export function summariseWindow(trace: Trace, logStartMs: number, startMs: number, endMs: number): ConformSummary;
export function detectSteps(trace: Trace, logStartMs: number, startMs: number, endMs: number): ConformStep[];
export function stepsToCsv(steps: ConformStep[]): string;  // header row + one row per step, UK local clock times
```
  - The `start` and `end` of a step are the ISO UTC timestamps of its first and last row.
  - `ips_setpoint_c` in the summary is the most common setpoint among the extruding rows, or null.

- [ ] **Step 1: Write the failing tests** against the normalised fixture (whole window):
  - `summary.test.ts`:
    - `extruding_s === 804`
    - `mean_wheel_speed_rpm ≈ 4.724669`, `mean_torque_pct ≈ 18.465351`, `mean_tooling1_c ≈ 381.202406`
    - `peak_torque_pct ≈ 67.370605`, `peak_motor_current_a ≈ 158.163025`, `peak_tooling1_c ≈ 433.380493`, `peak_wheel_temp_c ≈ 97.369858`
    - `energy_kwh.total ≈ 7.670553`, `duration_s === 899`, `ips_setpoint_c === 500`
    - A sub-window 13:43:18–13:53:20 has `energy_kwh.total ≈ 5.203773` (the third step's rows).
  - `steps.test.ts`, on the fixture: exactly 3 steps.
    - `{rpm 3, 84 s, start "2025-03-17T13:38:20.000Z"}`
    - `{rpm 4, 208 s, start "2025-03-17T13:39:48.000Z"}`
    - `{rpm 5, 602 s}`
    - all at `ips_setpoint_c 500`
    - step 2 has `tooling1_c.min ≈ 323.620483`, `max ≈ 364.891418`, `mean_torque_pct ≈ 14.723558` and `energy_kwh ≈ 1.642011`
    - The 4-row blip at 3.5 rpm and the 2-row blip at 4.5 rpm belong to no step.
  - A synthetic trace of 250/300/350 °C × 5/8/10 rpm, 120 rows each, plus a 30-row blip, gives 9 steps in order.
  - `stepsToCsv` has a first line starting `Start,End,Duration (s),IPS setpoint (°C),Wheel speed (rpm)`.
  - A log without `tooling2_c` gives `tooling2_c: null`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task B3: Data access helpers (upload, link, window, recompute)

**Files:**
- Create: `packages/fast-plotting/src/conform/api.ts`, `api.test.ts`
- Modify: `packages/fast-plotting/src/hostNeutral.test.ts` (include `conform/*.ts`)

**Interfaces:**
- Consumes: B1 and B2. `AxiosInstance` (as `FastHost.api`).
- Produces:
```ts
export interface ConformLogRow { log_id: string; directus_files_id: string; equipment_id: string|null; source_filename: string; log_start: string; log_end: string; n_rows: number; duration_s: number; series: SeriesMeta[]; totals: ConformTotals; constants: typeof CONFORM_POWER_CONSTANTS }
export interface ConformRunRow { id: string; operation_id: string; log_id: string|null; window_start: string|null; window_end: string|null; status: 'no_log'|'no_window'|'done'|'error'; summary: ConformSummary|null; steps: ConformStep[]|null; error_message: string|null }
export async function loadConformRun(api, operationId: string): Promise<{ run: ConformRunRow|null; log: ConformLogRow|null; logHidden: boolean }>;
export async function loadLogTrace(api, log: ConformLogRow): Promise<Trace>;   // GET /assets/{directus_files_id} as text → parseTrace (cached by log_id via loadTrace)
export async function uploadConformLog(api, op: { operation_id: string; equipment_id: string|null; operation_date: string|null }, file: { name: string; text: string }): Promise<{ run: ConformRunRow; log: ConformLogRow; dateWarning: string|null }>;
export async function listCandidateLogs(api, equipmentId: string|null, aroundDate: string): Promise<ConformLogRow[]>;  // log_start within ±1 day
export async function linkExistingLog(api, operationId: string, logId: string): Promise<ConformRunRow>;   // window empty, status 'no_window'
export async function setRunWindow(api, operationId: string, startIso: string, endIso: string): Promise<ConformRunRow>;  // recompute summary+steps, status 'done'; fills empty setpoint fields
export async function recomputeRun(api, operationId: string): Promise<ConformRunRow>;
export async function listLogWindows(api, logId: string): Promise<{ operation_id: string; label: string; start: string; end: string }[]>; // label = conform_feedstock || operation code
```
  - Directus endpoints: `POST /files` (multipart, folder resolved by name "Conform Logs" through `GET /folders?filter[name][_eq]=Conform Logs`; if it doesn't exist, upload with no folder), `/items/conform_logs`, `/items/conform_run_data`, `/items/manufacturing_operations/{id}`.
  - On any write failure after `POST /files`, call `DELETE /files/{id}`, then rethrow.
  - A Directus error message (`errors[0].message`, for example `run window overlaps 17-03-25-CF-011`) is rethrown as `ConformLogError` with that text.
  - A 403 on `conform_logs` gives `logHidden: true`.
  - `dateWarning` is `"The log starts on <d>, more than a day from the run's date <d>; the date was not changed."`. When `operation_date` is null, the operation's date is set to the log's start date.

- [ ] **Step 1: Write the failing tests** with a fake axios (record calls, return canned responses):
  - Upload sends `POST /files`, then `conform_logs`, then `conform_run_data` with the whole-log window and `status: 'done'`.
  - A failure on `conform_logs` POST triggers `DELETE /files/<id>`.
  - An overlap error text surfaces verbatim.
  - `linkExistingLog` writes `window_start: null, status: 'no_window'`.
  - `setRunWindow` PATCHes `conform_wheel_speed_rpm`/`conform_ips_setpoint_c` only when they are null on the operation.
  - The date rules: null date → PATCH the date; a date 3 days off → `dateWarning` and no PATCH.
  - `loadConformRun` with a 403 on the log gives `logHidden: true` and keeps `run.summary`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the tests, typecheck and `hostNeutral`. Expected: PASS. **Step 5:** Commit.

---

### Task C1: `RunProfile` and the FAST profile (no behaviour change)

**Files:**
- Create: `packages/fast-plotting/src/profile.ts`, `profiles/fastProfile.ts`, `profiles/fastProfile.test.ts`
- Modify: `FastDashboard.vue`, `FastLists.vue`, `FastRunColumn.vue`, `FastStatsTab.vue`, `FastPlots.vue` (only where they hard-wire FAST), `index.ts`

**Interfaces:**
- Produces:
```ts
export interface RunWindowBand { operationId: string; label: string; startS: number; endS: number; current: boolean }
export interface RunProfile {
  key: 'fast' | 'conform';
  title: string;                                   // "FAST plotter" | "Conform plotter"
  layoutKey: string;
  listQuery: { category: string; fields: string[] };
  seedGroups: string[];                            // default tile groups in order
  loadRun(api, operationId: string): Promise<{ trace: Trace|null; meta: unknown; stats: unknown; hidden?: boolean }>;
  buildOpMeta(op: any, run: unknown): ReturnType<typeof buildOpMeta>;
  buildStats(op: any, run: unknown): ReturnType<typeof buildStats>;
  upload?(api, op: any, file: File): Promise<void>;
  // Conform only:
  startMs?(run: unknown): number | null;           // hover clock time
  windows?(api, run: unknown): Promise<RunWindowBand[]>;
  setWindowFromView?(api, op: any, startS: number, endS: number): Promise<void>;
  linkExisting?: { list(api, op: any): Promise<{ id: string; label: string }[]>; link(api, op: any, id: string): Promise<void> };
}
export const fastProfile: RunProfile;
```
  `FastDashboard` takes `profile: RunProfile` as a prop, defaulting to `fastProfile`, so existing mounts keep working untouched.

- [ ] **Step 1:** Write the test `fastProfile.test.ts`:
  - `fastProfile.layoutKey === 'd1-fast-dashboard-v1'`
  - `fastProfile.listQuery.category === 'sintering'`
  - `listQuery.fields` deep-equals the field list `FastDashboard.vue` uses today (copy it from the current source into the test)
  - `seedGroups` equals the current `SEED_GROUP_ORDER`
- [ ] **Step 2:** Run it. Expected: FAIL. **Step 3:** Move the FAST-specific code behind `fastProfile` and leave the rendering untouched. **Step 4:** All existing fast-plotting tests plus the new one pass, and typecheck passes. `npm test -w starbase-web` passes. **Step 5:** Commit.

### Task C2: Conform profile, window bands, view-to-window, routing and nav

**Files:**
- Create: `packages/fast-plotting/src/profiles/conformProfile.ts`, `conformProfile.test.ts`, `RunWindowBands.vue` (an SVG overlay drawn in `FastChart`'s coordinate space)
- Modify: `FastChart.vue` (optional `bands` prop; draw under the lines; label at the top-left of each band; `current` band slightly stronger), `FastDashboard.vue` (initial zoom to the current band; "Use this view as the run window"; "Use a log already uploaded" when the run has no log; hover clock time `HH:MM:SS` in Europe/London when `startMs` is given), `apps/starbase/web/src/plot/routes.ts`, `plotHosts.ts`, `ConformPlotPage.vue` (new, mirrors `FastPlotPage.vue`), `routes.test.ts`, `plotHosts.test.ts`, and the starbase nav config (`navConfig.ts`, `usage.ts`; find them with `grep -rn "FAST plotter" packages apps --include=*.ts`)

**Interfaces:**
- Consumes: B3 (`loadConformRun`, `loadLogTrace`, `uploadConformLog`, `listCandidateLogs`, `linkExistingLog`, `setRunWindow`, `listLogWindows`) and C1 (`RunProfile`).
- Produces: `conformProfile: RunProfile` with `key 'conform'`, `layoutKey 'd1-conform-dashboard-v1'`, `listQuery.category 'conform'`, `seedGroups ['speed','torque','temp','ips','power']`. The route is `/plot/conform`.

- [ ] **Step 1:** Write the tests.
  - The `conformProfile` constants.
  - `windows()` maps `listLogWindows` to `RunWindowBand` (seconds from log start, with `current` set for this operation).
  - `buildStats` shows extruding time, mean torque, peak tooling 1 and total energy from the summary.
  - Routes: `/plot/conform?operation=x` resolves to `ConformPlotPage`.
  - The nav has a "Conform plotter" entry under Analysis, after "FAST plotter".
  - `FastChart` with no `bands` renders no band elements (FAST unchanged).
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** fast-plotting and starbase web tests and typechecks pass. **Step 5:** Commit.

---

### Task D1: d1-ui category plumbing

**Files:**
- Modify: `packages/d1-ui/src/process.ts` (`PROCESS_LABEL.conform = 'Conform'`; `analysisLink(id,'conform')` → `/plot/conform?operation=<id>`), `params.ts` (`OPERATION_PARAM_PREFIX.conform = 'conform_'`), and their tests

- [ ] **Steps:** Tests first: `analysisLink('x','conform') === '/plot/conform?operation=x'`; `paramFields` for `conform` picks up the `conform_*` fields. Then FAIL, implement, PASS (`npm test -w @d1/ui`, typecheck), and commit.

### Task D2: Process map

**Files:**
- Modify, under `packages/starbase-pages/src/pages/map/`: `model/types.ts` (`ProcessCategory`), `model/rows.ts` (`CATEGORIES`, `OPERATION_SETTING_FIELDS`), `model/formSlots.ts` (`KEY_SETTING_FIELDS.conform = ['conform_die_diameter_mm','conform_wheel_speed_rpm','conform_ips_setpoint_c']`), `model/dataPreview.ts` (`kind: 'conform'`), `DataThumb.vue`, `model/recordInfo.ts`, the checks module (find it with `grep -rln "checks" model`), and their tests

**Interfaces:**
- Consumes: B3 (`loadConformRun`, `loadLogTrace`) and D1 (`analysisLink`).

- [ ] **Steps:** Write the tests first:
  - `KEY_SETTING_FIELDS.conform` is as above.
  - `dataPreview` for a CF op with a run-data row gives `kind 'conform'`, label "Conform run data", link text "Open in Conform plotter" and href `/plot/conform?operation=<id>`.
  - The thumbnail series are `wheel_speed_rpm` and `tooling1_c`, sliced to the run window.
  - The "mark done" check for a CF op whose run has a log and no window is a **warning** with the text "Conform run window not set".

  Then FAIL, implement, PASS, and commit.

### Task D3: Operation page "Conform run" section, index rows

**Files:**
- Create: `packages/starbase-pages/src/pages/operation/ConformRunSection.vue`, `ConformRunSection.test.ts`
- Modify: `OperationPage.vue` ("On this page" entry "Conform run" for `conform`), `operation/useOperationData.ts` (load through `loadConformRun`), `operation/OperationAnalysis.vue` (mount the section), `index/plotData.ts` and `RowPlotButtons.vue` (a Conform row plot button), `IndexThumb.vue`

**Interfaces:**
- Consumes: B2 (`stepsToCsv`), B3 (all helpers) and D1.

- [ ] **Step 1:** Write the component tests, with mocked helpers:
  - It shows "Run window not set" for `status 'no_window'`.
  - It shows summary values formatted with units (`7.67 kWh`, `13:38:20` UK time).
  - The steps table has one row per step.
  - "Copy as CSV" writes `stepsToCsv(steps)` to the clipboard.
  - Editing the start or end calls `setRunWindow`, and an overlap error text is shown inline.
  - `logHidden` shows "Conform log not visible to you" and still renders the summary.
  - It has an upload input and a "Use a log already uploaded" picker when `run` is null or `status 'no_log'`.
  - "Recompute" is shown when `summary.version` is missing or `log.constants.version < CONFORM_POWER_CONSTANTS.version`.
  - The whole-log totals block shows `log.totals`.
- [ ] **Steps 2–5:** Run (FAIL), implement, run `npm test -w @d1/starbase-pages` plus typecheck (PASS), and commit.

---

### Task E1: Data Studio interfaces and PDF appendix

**Files:**
- Modify: `core/extensions/d1-process-category/src/ProcessCategory.vue` (`CAT_LABEL.conform = 'Conform (continuous extrusion)'`), `core/extensions/d1-operation-code/src/OperationCode.vue` (a Conform hint: "DD-MM-YY-CF-run-die dia"), `core/extensions/d1-report/src/index.js` (load `conform_run_data` + `conform_logs` + the CSV for conform ops), `render.js` (`conformAppendix(run, log, trace)` beside `fastAppendix`), `src/index.test.mjs`

**Interfaces:**
- Consumes: the schema from A2. d1-report is plain ESM and cannot import the TS package. It parses the normalised CSV with its own small reader: the first column is `time_s`, and the columns follow `log.series`.

- [ ] **Step 1:** Write the test: `conformAppendix` on a 3-step fixture run renders four panel titles ("Wheel speed", "Motor torque", "Temperatures", "IPS output"), a summary table containing "Extruding time" and "Energy (total)", and a steps table with 3 rows. Plot only the run-window rows.
- [ ] **Steps 2–5:** Run (FAIL), implement following `fastAppendix`'s SVG approach, run `npm test` in `core/extensions/d1-report` (PASS), and run the build for the two Vue interfaces if they have one (`npm run build` in each). Commit.

---

### Task R: Whole-branch review (coordinator, Opus)

- [ ] Run `directus-ui-reviewer` on the UI diff and `migration-review` on migrations 206–208, both on Opus. Fix the CONFIRMED findings in a follow-up commit per finding.
- [ ] Run the `ci-local` skill on the merged branch, and fix until clean.
- [ ] Update this plan's Status table and the spec's Status line. Push, open the PR, and watch CI.

---

## Review round 1 (Opus): fixes

Two Opus reviews (front end and migrations) were run on the merged branch. The maintainer then decided:
- **Logs are visible to every lab member** (Lab Member and Lab Viewer). Run records (summary, steps, energy) stay private to their readers. This replaces the spec's "readers of any linked run" rule.
- **The test fixture is synthetic.** `__fixtures__/synthetic-log.csv` replaces the real `tiswarf-excerpt.csv`.
  - `make_synthetic_log.py` regenerates it, and `synthetic-log.expected.json` holds the expected values, computed in Python from the plan's formulas.
  - The real-log comparison moves to backlog item C1.

| Stream | Agent profile | State |
|---|---|---|
| F1 — schema, guard hook, PDF | `d1-server-implementer` | **merged** (phase1 2055/0, roundtrip 217, extensions 1114, d1-report 32) |
| F2 — browser code, panels, fixture swap | `directus-ui-implementer` | **merged** (fast-plotting 222, d1-ui 2153, starbase-pages 3259, starbase-web 214) |

### Contract shared by F1 and F2 (exact names)

- **`conform_logs.source_sha256`**: `text NOT NULL UNIQUE`, the lowercase hex SHA-256 of the uploaded file's raw bytes.
  - The browser computes it with `crypto.subtle.digest`.
  - Before uploading, the browser looks it up. If it exists, the browser offers to link that log instead of uploading.
  - Directus's unique error (`RECORD_NOT_UNIQUE` on `source_sha256`) maps to "This log is already uploaded: use “Use a log already uploaded”."
- **`conform_logs.run_windows`**: `jsonb NOT NULL DEFAULT '[]'`, kept by a trigger on `conform_run_data`.
  - It holds `[{operation_id, start, end}]`, sorted by `start`, with only the rows that have both window ends.
  - The browser draws bands from it. A run the caller can read is labelled with its feedstock or code; any other run is labelled **"Other run"**.
  - `listLogWindows` reads it.
- **`conform_logs` access**:
  - Read: `{}` (every Lab Member and Lab Viewer).
  - Create: any member.
  - Delete: `created_by = $CURRENT_USER`.
  - No update. The browser never PATCHes a log.
- **`conform_run_data` access**:
  - Create, update and delete need edit rights on the operation (`operation_id` → the operation's update rule).
  - Read stays `reader.operation`.
  - Add `guards.conform_run_data`: `operation_id` → `manufacturing_operations` (update) and `log_id` → `conform_logs` (read). Regenerate the generated files.
- **Folder.** A fixed-id Directus folder "Conform Logs", id `c04f1000-0000-4000-8000-000000000001`, seeded by the migration (guarded with `to_regclass('directus_folders')`).
  - Lab Members and Lab Viewers can read that one folder row.
  - The browser exports `CONFORM_LOGS_FOLDER_ID` with that id and uploads into it, with no lookup by name.
- **Readable refusals.** A Directus hook extension `core/extensions/d1-conform-guard` (filter hooks) runs the checks before the database does, and throws `InvalidPayloadError` with these messages. The DB triggers stay as a backstop.
  - Overlap: `Run window overlaps <code> on this log.`. `<code>` is the other run's `pass_code` when the caller can read that operation, otherwise `another run`.
  - Outside the log: `Run window lies outside the log (<start> to <end>, UK time).`
  - Delete of a log still used by a run: `This log is still used by a Conform run. Unlink it from the run first.` The DB also refuses this with a BEFORE DELETE trigger. `ON DELETE SET NULL` on `conform_run_data.log_id` is therefore never reached; leave it.
- **`summary.constants_version`** (a number). The browser stores `CONFORM_POWER_CONSTANTS.version` in each summary, and "Recompute" compares against that, not against `conform_logs.constants`.
- **Shared formats** (Operation page, plotter and PDF alike):
  - energy in kWh to 2 decimals
  - average demand in kW to 2 decimals
  - durations under an hour as `12 min 05 s`, otherwise as `1 h 23 min`
  - clock times `HH:MM:SS`, UK local

### F1 tasks (schema + hook + PDF)

1. **New migration `20261022000209_conform_review_fixes.sql`.** Migrations 206–208 are on a pushed branch but not merged; still add a new migration rather than editing them.
   - `source_sha256` (backfill isn't needed; the table is new), `run_windows` with its trigger, and the delete-refusal trigger.
   - The access changes and the folder seed (with its read permission).
   - Collection sort: give `conform_logs` a sort unique under `manufacturing_methods`.
   - Down restores 207/208's state.
2. **Migration 206's up adoption gap.** In 209, adopt operations whose method is CF and whose category is `deformation`, setting them to `conform`. 209 runs after 206 on a re-up, so this covers both the 206 down→up path and data. Add a phase1 test.
3. **`d1-conform-guard` hook extension.** Plain ESM like the other hooks; register it wherever the extensions are listed in compose and CI. It has `index.test.mjs` with fakes covering:
   - overlap with a readable run and with an unreadable one
   - outside the log
   - touching windows `[a, b)` and `[b, c)` accepted
   - the delete refusal
4. **`tests/phase1_schema.sh`:**
   - `run_windows` follows insert, update and delete of run windows
   - unique `source_sha256`
   - the delete refusal
   - a Lab Member can't create `conform_run_data` for an operation they can't edit (the generated rows)
   - the folder row exists
   - a CF operation is re-adopted
5. **d1-report:**
   - Show "Conform log not visible to you" only when the asset read is forbidden.
   - A window with fewer than 2 rows says "Run window too short to plot".
   - Use the shared formats above.
   - Move `conformAppendix` and its CSV reader to `src/conform.js`.
6. **Docs:**
   - `docs/adr/0011-row-level-visibility.md`: logs are lab-wide, runs are private.
   - Spec "Access": replace the "readers of any linked run" rule.
   - `docs/data-dictionary.md`.
   - The backlog: C1 says the file lands in "Conform Logs" and compares the energy of the real TiSwarf log with the spreadsheet; CFS3 is reworded for a file-level 403.

### F2 tasks (browser code, panels, fixture swap)

1. **Fixture swap.**
   - Every test that used `tiswarf-excerpt.csv` now uses `synthetic-log.csv`, with expected values from `synthetic-log.expected.json`:
     - energy motor 6.112229, ips 1.411225, cooling 0.000416, total 7.523869
     - extruding 870 s
     - means 4.628926 rpm, 17.904279 %, 367.3525 °C
     - peaks 22.0 %, 51.4 A, 430.355 °C, 96.93 °C
     - steps 84/208/602 rows at 3/4/5 rpm, starting 10:00:00, 10:01:28 and 10:04:58 UTC
     - step 2 tooling 1 range 312.76–342.775, mean torque 18.012487, energy 1.776252
     - sub-window from row 298 to the end: 5.118654 kWh
   - Tooling 2 is flat. `tooling1_c` is not flat.
   - Delete `tiswarf-excerpt.csv`.
   - The Excel-variant test builds from the synthetic text.
2. **Encoding.**
   - Read uploads as an `ArrayBuffer`. Decode with `TextDecoder('utf-8', {fatal: true})`, falling back to `windows-1252`. Do this in one helper, `decodeLogBytes(buf): string`, in `conform/parse.ts`, and use it in both upload paths.
   - `cleanHeader` also maps `�` before `C` to `°`.
   - Tests: a header encoded in latin1 gives the same channel keys; a UTF-8 file round-trips.
   - The SHA-256 is computed over the same bytes.
3. **Duplicate check.** `findLogByHash(api, sha256)`; the upload helpers use it before `POST /files` and return `{ existing: ConformLogRow }` so the UI can offer to link it. Map the unique error as in the contract.
4. **Bands from `run_windows`.** `listLogWindows` reads it. Labels: readable runs by feedstock or code, otherwise "Other run".
   - The Operation page lists the other windows on its log, with the times.
   - When linking a log that already has windows, show them, with the note "The whole log is <label>'s window: narrow that run's window first" when one window covers the whole log.
5. **Edit gating.**
   - The plotter's upload, link, window and unlink actions appear only when the caller can edit the operation. Use the same rights check as the Operation page's `canEdit`; share it rather than copying it.
   - The Operation page already gates. Make sure it still does.
6. **Unlink and replace.**
   - "Unlink log" sets the run to `log_id null, window null, summary null, steps null, status 'no_log'`. If the caller uploaded the log and no other run uses it (its `run_windows` is empty and no other row references it), delete the log and then its file, best effort.
   - "Replace log" is unlink followed by the upload/link picker.
   - Both appear on the Operation page and in the plotter.
7. **Window entry.**
   - A field the user didn't edit keeps its stored instant; no truncation to the second.
   - An edited value is clamped to `[log_start, log_end]`, with a note when it was clamped.
   - "Set run window" stays mounted during the reload (focus kept).
8. **Planned runs.** Uploading or linking to a run whose `work_state` is planned never writes `operation_date`.
9. **Recompute.** Write `summary.constants_version`. "Recompute" shows when it is missing or lower than `CONFORM_POWER_CONSTANTS.version`. Remove the `conform_logs` PATCH from `recomputeRun`.
10. **Thumbnails.** `loadTrace` caches the pending promise, so concurrent loads of one log download once. Add a test.
11. **Hidden file.** A 403 on `/assets` for the log's file shows "Conform log not visible to you" in the plotter, the Operation page and the map preview. Other failures say "Could not load the Conform log".
12. **New from and Duplicate.** Add `conform_feed_mass_g`, `conform_extrusion_length_mm`, `conform_extrusion_mass_g`, `conform_yield_pct` and `conform_flash_mass_g` to `NEW_FROM_DROPS`.
13. **Dedupe.**
    - Share one `ConformRunBundle` type.
    - "Use a log already uploaded" with no run date searches around today in both places, with the same wording.
    - Use one UK-time module: `fast-plotting/src/conform/clock.ts` gains what `d1-ui/src/ukTime.ts` has, and d1-ui re-exports or uses it if the package dependency direction allows; otherwise keep both but test them against the same cases.
    - The shared formats from the contract live in `conform/format.ts`, used everywhere.
    - Fix the stale comment at `packages/d1-ui/src/process.ts:26`.
14. **Lab stats.** `LabStats.vue` stops counting Conform runs as "Machining". Count them under their own label, or leave them out of that split with a test.
15. **Folder id.** Use `CONFORM_LOGS_FOLDER_ID` from the contract, and remove the lookup by name.
