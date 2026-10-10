# T0b: operation codes in Postgres — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operation codes are built and kept up to date by the database from the operation's own
fields (one copy of the rules), the Directus form shows a live preview by asking the database, and
every schema change is also tested through a real Directus before it reaches live.

**Architecture:** A Directus smoke harness first (throwaway Directus on a restored copy of live,
driven through REST). Then four migrations: 155 a format CHECK on `short_id` (T0a carry-over);
156 the code rule (`code_num`, `operation_code_for`, `sintering_run_number`); 157 the trigger
`mfg_op_set_code` that replaces `mfg_op_assign_numbers` (numbers, typed/automatic, frozen rows),
with a sequence back-fill; 158 the sample-code cascade to operations and `preview_operation_code`.
Then a preview route on the `d1-next-number` endpoint and a rewritten `d1-operation-code` box.

**Tech Stack:** PostgreSQL 16, PL/pgSQL, dbmate, Directus 11 (endpoint + interface extensions, Vue 3),
Node `node --test`, bash, Docker.

**Spec:** [`docs/superpowers/specs/2026-10-10-record-codes-design.md`](../specs/2026-10-10-record-codes-design.md)
§3, §4 (operations), §5. Stage **T0b**. T0a is live (migrations 150-154); its carry-overs are in
the "Outcome" and "Live demo" sections at the end of
[`2026-10-10-t0a-short-ids-and-test-codes.md`](2026-10-10-t0a-short-ids-and-test-codes.md).

## Global Constraints

- Worktree `.claude/worktrees/t0-record-codes`, branch `feat/record-codes`. Never touch the main
  checkout, never write to the live database, never run `scripts/configure_all.sh` or
  `scripts/configure_directus.sql`.
- Migration versions `20261010000155` … `20261010000158` (150-154 are applied on live; the parallel
  branch `fix/migrations-empty-db` owns 144-149).
- Every new table, column, function and trigger carries a `COMMENT`; every `migrate:down` undoes
  its `migrate:up` exactly, in reverse order; trigger functions use `LANGUAGE plpgsql` and
  `SET search_path = pg_catalog, public`.
- **No trigger on a code column may use `UPDATE OF <column>` or a `WHEN` clause naming it**
  (migration 116's down retypes the code columns; Postgres refuses `ALTER TYPE` on a column a
  trigger definition names). Put the "did it change" test inside the function.
- **No new NOT NULL column without a default, and no `required` Directus field inside a
  conditionally hidden group** — Directus treats both as required on every create (the T0a
  incident). The Directus smoke test (Task 1) must pass before any live apply.
- Directus metadata from a migration is inserted only where missing and tested on CI's stubs.
- A ledger table in `d1_private` must be added to the `DROP TABLE IF EXISTS` list of the
  migration-141 test (two places in `tests/phase1_schema.sh`, next to
  `d1_private.restore_inline_param_meta_changes`).
- Lock order everywhere: `refresh_project_rollup` advisory lock → sample row → anything else.
- Operation code rules (spec §3), dates in **UTC**, numbers as `num()` did: 6 significant digits,
  no trailing zeros:

  | Category | Code |
  |---|---|
  | machining | `{sample}-{machining_operation_subtype}{seq}-{speed}MPM_{feed}feed_{doc}DoC` |
  | heat_treatment | `{sample}-HT{type abbr}{seq}-{peak}C_{hold}min_{cooling abbr}` |
  | deformation | `{sample}-{DR/DF/DE/DD/DX, else D}{seq}-{temp}C_{reduction}pct_{passes}p` |
  | additive | `{sample}-{am_process_variant, else AM}{seq}-{power}W_{scan}mmps_{layer}mm` |
  | sintering | `{DD-MM-YY}-MF{machine}-{run}[-{T}C_{F}kN_{D}dia]` |
  | sample_prep / none | `{sample}-{seq}`, or `{sample}` |

  Parameters only when set, joined with `_`; abbreviations: HT type anneal A, solution_treat S,
  age AG, quench Q, temper T, stress_relieve SR, normalise N, other X; cooling furnace FC, air AC,
  water_quench WQ, oil_quench OQ, forced_air FA, other X; deformation rolling DR, forging DF,
  extrusion DE, drawing DD, other DX.
- Frozen: `source_system = 'experiment_sheet'` is never renamed automatically.
- The sintering run number is never invented (Q48): typed from the FAST machine or imported.
- Commit after each task; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests are run at every step: `bash scripts/dev/schema_test_docker.sh` (gate: only the 4
  pre-existing FAIL lines, no `FAIL harness`), plus the node tests named in each task.

## Decisions this plan makes where the spec was silent (flagged for review)

1. **The rule is split from the trigger** (`operation_code_for(op, sample_code)`), so the preview,
   the cascade, the typed/automatic test and later the Force App use one function.
2. **Rollup lock for the sample-code cascade is taken by a statement-level BEFORE UPDATE trigger
   on `physical_samples`** (no column list). A row-level BEFORE trigger cannot do it: Postgres
   locks the row before firing it, which would invert the order against `mfg_op_set_code`.
   Cost: every sample UPDATE waits for in-flight operation writes to commit (sub-second).
3. **No `preview_test_code`** (the spec lists it): the test form is a plain box (Q22), nothing
   would call it. Add it when a consumer appears.
4. **The machine number comes from the equipment name** `FCT HP D <n>` (falls back to
   `source_system` `fast_<n>` for imported rows without equipment), so a future FAST machine
   needs no code change.
5. **A typed code keeps its numbers**: numbers are drawn only for automatic codes (and the
   existing INSERT rule: a new operation with a sample and no sequence gets one).
6. **`sintering_run_number` is not `required` in Directus** (it sits in the conditionally hidden
   sintering group; a required field there would block every non-sintering save). The note says
   to type the machine's run number; a sintering operation without one has no code.

## Review Focus

- A Directus create or edit of an operation that sends no `pass_code` must get the rule's code;
  one that re-sends the unchanged code must stay automatic. → Task 4 `resend`, Task 1 smoke.
- An edit that changes only an unrelated field (notes) must not renumber or rename. → Task 4 `notes`.
- Existing operations whose stored code differs from the rule (legacy shapes) must be left alone
  until edited, and stay as typed when edited. → Task 4 `legacy_kept`; Task 7 lists them.
- Imported FAST rows must keep their codes byte-for-byte when nothing changes. → Task 3 `fast_same`.
- A sample code correction must reach automatic operation codes and leave typed and frozen ones.
  → Task 5 `cascade_*`.

---

### Task 1: Directus smoke harness

**Files:**
- Create: `scripts/dev/directus_smoke.sh`
- Create: `scripts/dev/directus_smoke.mjs`

**Interfaces:**
- Produces: `bash scripts/dev/directus_smoke.sh [--skip <migration-version>...]` — restores a copy
  of live into a throwaway Postgres, applies the worktree's pending migrations (minus any
  `--skip`ped ones, which it rolls back if live already has them), starts a throwaway Directus
  (the live container's exact image) on it, runs `directus_smoke.mjs`, prints one
  `SMOKE PASS <case>` / `SMOKE FAIL <case>: <detail>` line per case and exits non-zero on any FAIL.
  Later tasks add cases to `directus_smoke.mjs`.

- [ ] **Step 1: Write the harness**

`scripts/dev/directus_smoke.sh` (bash, Git Bash on Windows; follow `schema_test_docker.sh`'s style:
`MSYS_NO_PATHCONV=1`, Windows path from `pwd -W`, `FAIL harness:` lines, cleanup always runs):
1. Internal network `d1-smoke`; Postgres `d1-smoke-pg` from `pgvector/pgvector:pg16`
   (user `d1`, db `d1_database`), wait with `pg_isready -h 127.0.0.1`.
2. Restore live: `docker exec d1-database-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=directus_revisions --exclude-table-data=directus_activity' | docker exec -i d1-smoke-pg pg_restore -U d1 -d d1_database --no-owner --role=d1`
   (errors about missing roles in GRANTs are expected; any other restore error is a
   `FAIL harness: restore`). This reads live and writes nothing to it.
3. For each `--skip <version>`: if the copy has it in `schema_migrations`, run that file's
   `migrate:down` section through psql in the copy and delete its `schema_migrations` row
   (newest first). Then `dbmate up` with the worktree's `db/` (only pending files apply; the
   copy already has everything live has). Any failure: `FAIL harness: dbmate up`.
4. Test credentials, generated, only in the copy: pick the first user whose role/policy has
   admin access (`SELECT u.id FROM directus_users u … LIMIT 1`; look at the schema in the copy —
   Directus 11 uses `directus_access` + `directus_policies.admin_access`), set
   `token = 'smoke-' || md5(random()::text)` on it, and keep the token in a shell variable only.
5. Start Directus `d1-smoke-directus` with the live container's image id
   (`docker inspect d1-database-directus-1 --format '{{.Image}}'`) on `d1-smoke`, env: `KEY`,
   `SECRET` (random hex), `DB_CLIENT=pg`, `DB_HOST=d1-smoke-pg`, `DB_DATABASE=d1_database`,
   `DB_USER=d1`, `DB_PASSWORD=<the copy's>`, `PUBLIC_URL=http://d1-smoke-directus:8055`,
   `EXTENSIONS_AUTO_RELOAD=false`, `D1_TIMEZONE=Europe/London`; volumes: the **main checkout's**
   `core/extensions` read-only at `/directus/extensions` (what live runs), and, overlaid on top,
   the worktree's `core/extensions/d1-next-number` at `/directus/extensions/d1-next-number`
   (read-only). No published ports. Wait for `/server/health` = ok from inside the network
   (e.g. `docker exec d1-smoke-directus wget -qO- http://127.0.0.1:8055/server/health`), up to
   120 s, else `FAIL harness: directus not healthy` plus `docker logs`.
6. Run the cases: `docker run --rm --network d1-smoke -e DIRECTUS_URL=http://d1-smoke-directus:8055 -e TOKEN=<token> -v "<worktree>/scripts/dev:/smoke:ro" node:20-alpine node /smoke/directus_smoke.mjs`.
7. Cleanup: remove both containers and the network, always.

`scripts/dev/directus_smoke.mjs` (Node 20, built-in `fetch`, no dependencies): a tiny client
(`api(method, path, body)` with `Authorization: Bearer ${TOKEN}`; returns `{status, body}`), a
`check(name, fn)` runner printing `SMOKE PASS name` / `SMOKE FAIL name: detail`, exit code 1 if
any failed. Cases for now (T0a regression — the incident):
- `create_sample`: `POST /items/physical_samples` `{sample_code: 'SMOKE-<random6>', nickname: 'smoke', item_type: 'sample', current_status: 'active'}` with `?fields=sample_id,short_id` → 200 and `short_id` matches `^[0-9a-f]{8,}$`.
- `create_test_with_subject`: `POST /items/test_sessions` `{test_type: 'sem', status: 'registered', subject: {create: [{collection: 'physical_samples', item: {sample_id}}], update: [], delete: []}}` → `test_code` = `<sample code>-SEM1`.
- `copy_test_keeping_code`: GET that test `fields=*`, drop `session_id, short_id, created_at, updated_at, version, subject, created_by`, POST it back → status 400 with a "has to be unique" message.
- `copy_test_cleared`: the same with `test_code: null` and a nested subject create for the same sample → `test_code` = `<sample code>-SEM2`.

- [ ] **Step 2: Prove it catches the incident**

```bash
bash scripts/dev/directus_smoke.sh --skip 20261010000153 > /tmp/smoke-incident.txt 2>&1; echo "exit $?"; grep SMOKE /tmp/smoke-incident.txt
bash scripts/dev/directus_smoke.sh > /tmp/smoke-ok.txt 2>&1; echo "exit $?"; grep SMOKE /tmp/smoke-ok.txt
```

Expected: the first run exits non-zero with `SMOKE FAIL create_sample: … short_id … required`;
the second exits 0 with four `SMOKE PASS` lines. Save both outputs under
`.superpowers/sdd/<plan workspace>/`.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev/directus_smoke.sh scripts/dev/directus_smoke.mjs
git commit -m "chore(dev): Directus smoke test on a restored copy of live

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 155 — short_id format CHECK (T0a carry-over)

**Files:**
- Create: `db/migrations/20261010000155_short_id_format_check.sql`
- Modify: `tests/phase1_schema.sh` (short-ID section; also the 153 checks)

- [ ] **Step 1: Failing tests** — in the short-ID section add, in a rolled-back transaction with
  the three `*_short_id` triggers disabled for one insert each: inserting a sample without
  `short_id` (so the `''` default would be stored) raises `check_violation`
  (`'fmt_sample:ok'` via a DO block catching `check_violation`), same for an operation and a
  test. Replace the near-vacuous 153 check ("the empty default never reaches a row") with a
  check that the three CHECK constraints exist and are validated
  (`SELECT count(*) FROM pg_constraint WHERE conname IN ('physical_samples_short_id_format_check', 'manufacturing_operations_short_id_format_check', 'test_sessions_short_id_format_check') AND convalidated` = 3),
  and add `table_schema = 'public'` to the 153 default check.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Migration:**

```sql
-- migrate:up
-- short_id must look like a short ID (T0b, carry-over from T0a's review). Since 153 gave short_id
-- an empty default for Directus's sake, an INSERT that bypasses the trigger (triggers disabled,
-- session_replication_role = replica) would silently store '' instead of failing on NOT NULL.
-- CHECK runs after the BEFORE triggers, so the normal path is unaffected; Directus does not read
-- CHECK constraints, so it does not start demanding the field.
ALTER TABLE physical_samples
    ADD CONSTRAINT physical_samples_short_id_format_check CHECK (short_id ~ '^[0-9a-f]{8,32}$');
ALTER TABLE manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_short_id_format_check CHECK (short_id ~ '^[0-9a-f]{8,32}$');
ALTER TABLE test_sessions
    ADD CONSTRAINT test_sessions_short_id_format_check CHECK (short_id ~ '^[0-9a-f]{8,32}$');
COMMENT ON CONSTRAINT physical_samples_short_id_format_check ON physical_samples IS 'short_id is 8-32 lower-case hex (never the empty column default).';
COMMENT ON CONSTRAINT manufacturing_operations_short_id_format_check ON manufacturing_operations IS 'short_id is 8-32 lower-case hex (never the empty column default).';
COMMENT ON CONSTRAINT test_sessions_short_id_format_check ON test_sessions IS 'short_id is 8-32 lower-case hex (never the empty column default).';

-- migrate:down
ALTER TABLE test_sessions DROP CONSTRAINT IF EXISTS test_sessions_short_id_format_check;
ALTER TABLE manufacturing_operations DROP CONSTRAINT IF EXISTS manufacturing_operations_short_id_format_check;
ALTER TABLE physical_samples DROP CONSTRAINT IF EXISTS physical_samples_short_id_format_check;
```

  The T0a back-fill test inserts rows with NULL `short_id` before running the back-fill: NULL
  passes a CHECK, so it keeps working — confirm.
- [ ] **Step 4: `ROUNDTRIP=1` harness run; FAIL lines = the 4 pre-existing.**
- [ ] **Step 5: Commit** (`feat(db): short_id must look like a short ID`).

---

### Task 3: Migration 156 — the operation code rule

**Files:**
- Create: `db/migrations/20261010000156_operation_code_rule.sql`
- Modify: `tests/phase1_schema.sh` (new section "Operation code rule (T0b)")

**Interfaces:**
- Produces: `code_num(numeric) RETURNS text` (IMMUTABLE); column
  `manufacturing_operations.sintering_run_number INTEGER`; unique index
  `manufacturing_operations_sintering_run_unique`; `operation_code_for(op manufacturing_operations, p_sample_code text) RETURNS text` (STABLE; NULL when no code can be built).

- [ ] **Step 1: Failing tests.** In one rolled-back transaction (fixture prefix `9a000000-0000-4000-8000-`,
  grep first; equipment rows are the live seed ids only on live, so create fixture equipment
  `FCT HP D 25` / `FCT HP D 250` if the CI database has none — check how `equipment` is seeded):
  `code_num`: `SELECT code_num(0), code_num(0.05), code_num(1932.080), code_num(30.000), code_num(123456789), code_num(-5.50), code_num(NULL)`
  → `0|0.05|1932.08|30|123457000|-5.5|` (null last).
  `operation_code_for` on rows built with `jsonb_populate_record(NULL::manufacturing_operations, '{…}')`
  and an explicit sample code `TEST-OC-001`:
  - machining `{process_category: machining, machining_operation_subtype: F, operation_sequence: 8, machining_cutting_speed_m_per_min: 30, machining_feed_mm_per_rev: 0.1, machining_axial_depth_of_cut_mm: 1}` → `TEST-OC-001-F8-30MPM_0.1feed_1DoC`
  - machining with only speed set → `TEST-OC-001-F8-30MPM`; with no params → `TEST-OC-001-F8`
  - heat_treatment `{ht_treatment_type: anneal, operation_sequence: 2, ht_peak_temp_celsius: 1050, ht_hold_time_min: 60, ht_cooling_method: furnace}` → `TEST-OC-001-HTA2-1050C_60min_FC`
  - deformation `{deform_deformation_type: rolling, operation_sequence: 3, deform_deformation_temp_celsius: 900, deform_total_reduction_pct: 50, deform_pass_count: 4}` → `TEST-OC-001-DR3-900C_50pct_4p`; unknown type `{deform_deformation_type: weird}` → token `D3`
  - additive `{operation_sequence: 4, am_laser_power_w: 200, am_scan_speed_mm_per_s: 800, am_layer_thickness_mm: 0.03}` (no variant) → `TEST-OC-001-AM4-200W_800mmps_0.03mm`
  - sintering `{process_category: sintering, equipment_id: <FCT HP D 25>, sintering_run_number: 9500, operation_date: '2026-10-09T23:30:00Z', sintering_max_temp_celsius: 1150, sintering_max_force_kn: 101, sintering_mould_diameter_mm: 80}` → `09-10-26-MF25-9500-1150C_101kN_80dia` (UTC date); without a run number → NULL; equipment NULL but `source_system: fast_250` → `MF250`
  - sample_prep with sequence 5 → `TEST-OC-001-5`; no category, no sample → NULL
  - `fast_same`: for every live-shaped FAST row in the CI fixtures there are none — instead
    insert 3 FAST-shaped rows (`source_system fast_25`, `source_run_uid 'fast25|4624'`, codes
    `12-10-16-MF25-4624-1200C_14kN_20dia`, `13-02-25-MF25-9686`, and one with only temp and
    force) with matching fields, run the migration's run-number back-fill (extract between
    `-- runbackfill:start` / `-- runbackfill:end` markers with awk), and assert
    `operation_code_for(m, NULL) = pass_code` for all three.
  - unique run per machine: a second sintering row with the same equipment and run →
    `unique_violation`.
  - Directus row for `sintering_run_number` exists, in group `sintering_machine_group`, not
    required, not hidden.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Migration.**

```sql
-- migrate:up
-- The operation code rule in Postgres (stream T0b, spec 2026-10-10-record-codes-design.md §3).
--
-- Why: the code was composed in the browser (d1-operation-code) and in a second copy in
-- packages/force-plotting, only for new operations, and saved codes went stale when their fields
-- changed. One rule, here, used by the trigger (next migration), the sample-code cascade, the
-- form's live preview and later the Force App. A faithful port of OperationCode.vue's autoCode
-- with three deliberate changes: (1) sintering = DD-MM-YY-MF{machine}-{run}[-params], machine
-- from the equipment (FCT HP D <n>) or source_system fast_<n>, run = sintering_run_number (typed
-- from the FAST machine or imported, never invented: Q48) — the old rule treated the number after
-- MF as a running counter, but in every imported FAST code it is the machine; (2) the date is
-- UTC, which is what all 10,048 imported FAST codes use; (3) no {seq}/{mf} placeholders.

CREATE FUNCTION code_num(p NUMERIC)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT CASE
        WHEN p IS NULL THEN NULL
        WHEN p = 0 THEN '0'
        ELSE trim_scale(round(p, 5 - floor(log(abs(p)))::int))::text
    END;
$$;

COMMENT ON FUNCTION code_num(NUMERIC) IS
    'A number as operation codes write it: 6 significant digits, no trailing zeros (80 -> 80, 0.05 -> 0.05, 1932.080 -> 1932.08).';

ALTER TABLE manufacturing_operations ADD COLUMN sintering_run_number INTEGER CHECK (sintering_run_number > 0);

COMMENT ON COLUMN manufacturing_operations.sintering_run_number IS
    'FAST/SPS run number as the machine shows it (typed on a hand-logged operation, read from the machine file by the importer). Part of the sintering code; never invented. Unique per machine (equipment).';

-- runbackfill:start
-- FAST imports carry the run in source_run_uid ('fast25|4624'). Back-filled with the table's user
-- triggers off (10k rows: no version bumps, audit rows or rollup refreshes for a derived value).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'
               AND tgrelid = 'manufacturing_operations'::regclass) THEN
        RAISE EXCEPTION 'a user trigger on manufacturing_operations is not in its normal state';
    END IF;
END $$;
ALTER TABLE manufacturing_operations DISABLE TRIGGER USER;
UPDATE manufacturing_operations
SET sintering_run_number = split_part(source_run_uid, '|', 2)::int
WHERE source_system IN ('fast_25', 'fast_250')
  AND source_run_uid ~ '^fast[0-9]+\|[0-9]+$';
ALTER TABLE manufacturing_operations ENABLE TRIGGER USER;
-- runbackfill:end

CREATE UNIQUE INDEX manufacturing_operations_sintering_run_unique
    ON manufacturing_operations (equipment_id, sintering_run_number)
    WHERE process_category = 'sintering' AND sintering_run_number IS NOT NULL;

COMMENT ON INDEX manufacturing_operations_sintering_run_unique IS
    'One operation per FAST machine run.';

CREATE FUNCTION operation_code_for(op manufacturing_operations, p_sample_code TEXT)
    RETURNS TEXT
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_sample  TEXT := coalesce(p_sample_code, '');
    v_seq     TEXT := coalesce(op.operation_sequence::text, '');
    v_token   TEXT := '';
    v_parts   TEXT[] := '{}';
    v_code    TEXT;
    v_machine TEXT;
BEGIN
    IF op.process_category = 'sintering' THEN
        SELECT substring(e.equipment_name FROM 'FCT HP D (\d+)$') INTO v_machine
        FROM public.equipment e WHERE e.equipment_id = op.equipment_id;
        v_machine := coalesce(v_machine, substring(op.source_system FROM '^fast_(\d+)$'));
        IF v_machine IS NULL OR op.sintering_run_number IS NULL OR op.operation_date IS NULL THEN
            RETURN NULL;
        END IF;
        v_parts := array_remove(ARRAY[
            code_num(op.sintering_max_temp_celsius) || 'C',
            code_num(op.sintering_max_force_kn) || 'kN',
            code_num(op.sintering_mould_diameter_mm) || 'dia'], NULL);
        v_code := to_char(op.operation_date AT TIME ZONE 'UTC', 'DD-MM-YY')
                  || '-MF' || v_machine || '-' || op.sintering_run_number;
        IF cardinality(v_parts) > 0 THEN
            v_code := v_code || '-' || array_to_string(v_parts, '_');
        END IF;
        RETURN v_code;
    ELSIF op.process_category = 'machining' THEN
        v_token := coalesce(op.machining_operation_subtype, '') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.machining_cutting_speed_m_per_min) || 'MPM',
            code_num(op.machining_feed_mm_per_rev) || 'feed',
            code_num(op.machining_axial_depth_of_cut_mm) || 'DoC'], NULL);
    ELSIF op.process_category = 'heat_treatment' THEN
        v_token := 'HT' || coalesce(CASE op.ht_treatment_type
            WHEN 'anneal' THEN 'A' WHEN 'solution_treat' THEN 'S' WHEN 'age' THEN 'AG'
            WHEN 'quench' THEN 'Q' WHEN 'temper' THEN 'T' WHEN 'stress_relieve' THEN 'SR'
            WHEN 'normalise' THEN 'N' WHEN 'other' THEN 'X' END, '') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.ht_peak_temp_celsius) || 'C',
            code_num(op.ht_hold_time_min) || 'min',
            CASE op.ht_cooling_method
                WHEN 'furnace' THEN 'FC' WHEN 'air' THEN 'AC' WHEN 'water_quench' THEN 'WQ'
                WHEN 'oil_quench' THEN 'OQ' WHEN 'forced_air' THEN 'FA' WHEN 'other' THEN 'X' END], NULL);
    ELSIF op.process_category = 'deformation' THEN
        v_token := coalesce(CASE op.deform_deformation_type
            WHEN 'rolling' THEN 'DR' WHEN 'forging' THEN 'DF' WHEN 'extrusion' THEN 'DE'
            WHEN 'drawing' THEN 'DD' WHEN 'other' THEN 'DX' END, 'D') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.deform_deformation_temp_celsius) || 'C',
            code_num(op.deform_total_reduction_pct) || 'pct',
            code_num(op.deform_pass_count) || 'p'], NULL);
    ELSIF op.process_category = 'additive' THEN
        v_token := coalesce(op.am_process_variant, 'AM') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.am_laser_power_w) || 'W',
            code_num(op.am_scan_speed_mm_per_s) || 'mmps',
            code_num(op.am_layer_thickness_mm) || 'mm'], NULL);
    ELSE
        RETURN nullif(CASE WHEN v_sample <> '' AND v_seq <> '' THEN v_sample || '-' || v_seq ELSE v_sample END, '');
    END IF;

    v_code := v_sample;
    IF v_token <> '' THEN
        v_code := CASE WHEN v_code <> '' THEN v_code || '-' || v_token ELSE v_token END;
    END IF;
    IF v_code <> '' AND cardinality(v_parts) > 0 THEN
        v_code := v_code || '-' || array_to_string(v_parts, '_');
    END IF;
    RETURN nullif(v_code, '');
END;
$$;

COMMENT ON FUNCTION operation_code_for(manufacturing_operations, TEXT) IS
    'The operation code the rule gives for this row and its input sample''s code (spec 2026-10-10-record-codes §3); NULL when none can be built (e.g. sintering without a run number).';

INSERT INTO directus_fields (collection, field, interface, options, readonly, hidden, sort, width, note, "group", searchable)
SELECT 'manufacturing_operations', 'sintering_run_number', 'input', '{"min":1,"step":1}'::json, FALSE, FALSE,
       0, 'half', 'Run number shown on the FAST machine. Part of the code; leave empty until known.',
       'sintering_machine_group', TRUE
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number');

-- migrate:down
DELETE FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number';
DROP FUNCTION IF EXISTS operation_code_for(manufacturing_operations, TEXT);
DROP INDEX IF EXISTS manufacturing_operations_sintering_run_unique;
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS sintering_run_number;
DROP FUNCTION IF EXISTS code_num(NUMERIC);
```

  Note `jsonb_populate_record(NULL::manufacturing_operations, …)` and functions taking the row
  type depend on the table's row type: a later `ALTER TABLE manufacturing_operations ADD COLUMN`
  is fine, `DROP COLUMN sintering_run_number` in the down must come after dropping
  `operation_code_for` (as written).
- [ ] **Step 4: `ROUNDTRIP=1` harness run; FAIL lines = the 4 pre-existing.**
- [ ] **Step 5: Commit** (`feat(db): the operation code rule in Postgres`).

---

### Task 4: Migration 157 — the trigger that keeps codes up to date

**Files:**
- Create: `db/migrations/20261010000157_operation_code_trigger.sql`
- Modify: `tests/phase1_schema.sh` (new section "Operation codes follow their fields (T0b)";
  the 141 DROP list; any existing "Operation numbers and codes are assigned server-side" checks
  that assert `{mf}` counter behaviour — see Step 1)

**Interfaces:**
- Consumes: `operation_code_for`, `sintering_run_number` (Task 3).
- Produces: trigger `mfg_op_set_code` / function `trg_mfg_op_set_code()` (replaces
  `mfg_op_assign_numbers` / `trg_manufacturing_operations_assign_numbers()`); ledger
  `d1_private.operation_sequence_backfill(operation_id uuid PK, filled integer)`.

- [ ] **Step 1: Failing tests.** New section, one rolled-back transaction, prefix
  `9b000000-0000-4000-8000-`, a sample `TEST-OT-001` and `TEST-OT-002`, a machining method row
  (method_id NOT NULL; copy the minimal method fixture used by the T0a short-ID section), the
  FAST equipment fixtures from Task 3. Cases (`name` → expected):
  - `new_auto`: insert machining op on `TEST-OT-001`, subtype F, speed 30, feed 0.1, DoC 1, no
    `pass_code` → `TEST-OT-001-F1-30MPM_0.1feed_1DoC`, `operation_sequence` 1.
  - `param_follow`: update speed to 45 → `TEST-OT-001-F1-45MPM_0.1feed_1DoC` (number kept).
  - `resend`: update `pass_code` to the same value it has → unchanged, still follows a later
    feed change (`…-F1-45MPM_0.2feed_1DoC`).
  - `notes`: update `notes` only → code and sequence unchanged, and no rollup lock taken
    (check `pg_locks` for the advisory key is not held by this transaction after the statement
    — or simply assert the code; keep it simple if the lock check is awkward).
  - `subtype_keeps_number`: subtype F → R → `TEST-OT-001-R1-…`.
  - `sample_change`: move the op to `TEST-OT-002` (which has one op already, sequence 1) →
    sequence 2, `TEST-OT-002-R2-…`.
  - `method_change`: change method_id to another machining method → next number on the same
    sample.
  - `typed`: update `pass_code` to `MY-OP-CODE` → kept; then change speed → still `MY-OP-CODE`.
  - `typed_equals_rule`: writing exactly the rule's value keeps the op automatic (a later param
    change follows).
  - `cleared`: update `pass_code` to NULL → rebuilt from the rule.
  - `placeholder`: insert with `pass_code` `'{seq}-whatever'` (an old client) → treated as
    automatic → rule's code; also `'TEST-OT-001-F{seq}-30MPM'` → rule's code.
  - `legacy_kept`: insert a row (triggers off for the insert) with a non-rule code
    `TEST-OT-001-F9-30MPM_0.05feed_0.1DoC_` (trailing underscore) and matching fields
    (sequence 9), re-enable, then change the feed → code unchanged (it was not the rule's value,
    so it counts as typed).
  - `null_code_becomes_auto`: insert (triggers off) a non-frozen op with `pass_code` NULL and
    fields set, then update notes → still NULL (nothing changed in the code inputs); update
    speed → gets the rule's code.
  - `frozen`: an `experiment_sheet` op: change speed → code unchanged; set `pass_code` to
    something typed → stored as typed (a person may still rename it).
  - `fast_follow`: a FAST-shaped row (source_system fast_25, run 4624, equipment FCT HP D 25,
    code `12-10-16-MF25-4624-1200C_14kN_20dia`): change temp to 1250 → `12-10-16-MF25-4624-1250C_14kN_20dia`.
  - `sinter_hand`: hand-made sintering op with equipment FCT HP D 250, date, no run → NULL
    code; then set run 400 → `DD-MM-YY-MF250-400`.
  - `seq_backfill`: run the extracted back-fill (`-- seqbackfill:start/end`) on two inserted
    rows with NULL sequence and codes `TEST-OT-001-F7-30MPM` (→ 7) and `N/R` (→ stays NULL, and
    the ledger has exactly the filled row).
  Remove or update any existing check in the "Operation numbers and codes are assigned
  server-side" section (around line 940) that asserts the old `{mf}` running counter or the
  `{seq}` replacement inside a client code string; keep the ones that still hold (a new op
  with a sample gets the next sequence; imported rows keep NULL; the no-placeholder CHECK).
  List every changed or removed old check in your report with the reason.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Migration** (`20261010000157_operation_code_trigger.sql`):
  - Header comment: why (spec §3), what replaces what, the typed/automatic rule, frozen rows,
    lock order, fast exit, and the trigger-shape constraint.
  - `SET LOCAL lock_timeout = '10s';`
  - Sequence back-fill between `-- seqbackfill:start` / `-- seqbackfill:end`: create
    `d1_private` schema if missing and table `d1_private.operation_sequence_backfill(operation_id UUID PRIMARY KEY, filled INTEGER NOT NULL)`
    with a COMMENT; insert into it and update `operation_sequence` for machining rows with
    `operation_sequence IS NULL`, a sample, and a code that starts with `<sample_code>-` whose
    next `-`-separated token ends in digits (`substring(split_part(substr(pass_code, length(sample_code) + 2), '-', 1) FROM '(\d+)$')::int`),
    frozen rows included (the number is read, the code untouched). Do it with the table's user
    triggers ON (52 rows; an audited, versioned data change is fine) and before the new trigger
    exists (the old `mfg_op_assign_numbers` returns early when `pass_code` is unchanged).
    `RAISE NOTICE` how many rows were filled and how many were left.
  - `DROP TRIGGER mfg_op_assign_numbers` and its function; create:

```sql
CREATE FUNCTION trg_mfg_op_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_new_sample TEXT;
    v_old_sample TEXT;
    v_auto       BOOLEAN;
    v_written    BOOLEAN := FALSE;
    v_renumber   BOOLEAN := FALSE;
BEGIN
    -- Fast exit: on UPDATE nothing the code is built from changed and the code was not written.
    IF TG_OP = 'UPDATE'
       AND NEW.pass_code IS NOT DISTINCT FROM OLD.pass_code
       AND (NEW.sample_id, NEW.method_id, NEW.process_category, NEW.operation_sequence,
            NEW.machining_operation_subtype, NEW.machining_cutting_speed_m_per_min,
            NEW.machining_feed_mm_per_rev, NEW.machining_axial_depth_of_cut_mm,
            NEW.ht_treatment_type, NEW.ht_peak_temp_celsius, NEW.ht_hold_time_min, NEW.ht_cooling_method,
            NEW.deform_deformation_type, NEW.deform_deformation_temp_celsius,
            NEW.deform_total_reduction_pct, NEW.deform_pass_count,
            NEW.am_process_variant, NEW.am_laser_power_w, NEW.am_scan_speed_mm_per_s, NEW.am_layer_thickness_mm,
            NEW.sintering_max_temp_celsius, NEW.sintering_max_force_kn, NEW.sintering_mould_diameter_mm,
            NEW.sintering_run_number, NEW.operation_date, NEW.equipment_id, NEW.source_system)
           IS NOT DISTINCT FROM
           (OLD.sample_id, OLD.method_id, OLD.process_category, OLD.operation_sequence,
            OLD.machining_operation_subtype, OLD.machining_cutting_speed_m_per_min,
            OLD.machining_feed_mm_per_rev, OLD.machining_axial_depth_of_cut_mm,
            OLD.ht_treatment_type, OLD.ht_peak_temp_celsius, OLD.ht_hold_time_min, OLD.ht_cooling_method,
            OLD.deform_deformation_type, OLD.deform_deformation_temp_celsius,
            OLD.deform_total_reduction_pct, OLD.deform_pass_count,
            OLD.am_process_variant, OLD.am_laser_power_w, OLD.am_scan_speed_mm_per_s, OLD.am_layer_thickness_mm,
            OLD.sintering_max_temp_celsius, OLD.sintering_max_force_kn, OLD.sintering_mould_diameter_mm,
            OLD.sintering_run_number, OLD.operation_date, OLD.equipment_id, OLD.source_system) THEN
        RETURN NEW;
    END IF;

    -- A new operation with a sample and no sequence gets the next one (as migration 126 did),
    -- typed code or not; imported rows (source_system set) keep NULL.
    IF TG_OP = 'INSERT' AND NEW.operation_sequence IS NULL AND NEW.sample_id IS NOT NULL
       AND NEW.source_system IS NULL THEN
        v_renumber := TRUE;
    END IF;

    -- Frozen rows: never renamed automatically (a person may still type a code).
    IF NEW.source_system = 'experiment_sheet' THEN
        RETURN NEW;
    END IF;

    SELECT ps.sample_code INTO v_new_sample FROM public.physical_samples ps WHERE ps.sample_id = NEW.sample_id;

    -- Automatic or typed?
    IF TG_OP = 'INSERT' THEN
        v_auto := nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}';
        v_written := NOT v_auto;
    ELSIF NEW.pass_code IS DISTINCT FROM OLD.pass_code THEN
        IF nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}' THEN
            v_auto := TRUE;                 -- cleared, or an old client's placeholder: rebuild
        ELSE
            v_auto := FALSE;
            v_written := TRUE;              -- decided below against the rule's value
        END IF;
    ELSE
        SELECT ps.sample_code INTO v_old_sample FROM public.physical_samples ps WHERE ps.sample_id = OLD.sample_id;
        -- No code yet counts as automatic (the 9 NULL codes and codeless sintering rows get one
        -- at their next edit); otherwise automatic means "is the rule's value for the old row".
        v_auto := OLD.pass_code IS NULL
                  OR OLD.pass_code = public.operation_code_for(OLD, v_old_sample);
        -- a new number when the sample or the method changed (and the sequence was not set by hand)
        IF v_auto AND NEW.sample_id IS NOT NULL AND NEW.source_system IS NULL
           AND NEW.operation_sequence IS NOT DISTINCT FROM OLD.operation_sequence
           AND (NEW.sample_id IS DISTINCT FROM OLD.sample_id OR NEW.method_id IS DISTINCT FROM OLD.method_id) THEN
            v_renumber := TRUE;
        END IF;
    END IF;

    IF v_renumber THEN
        -- Lock order: rollup lock, then the sample row (as migration 126).
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('refresh_project_rollup', 0));
        PERFORM 1 FROM public.physical_samples ps WHERE ps.sample_id = NEW.sample_id FOR NO KEY UPDATE;
        SELECT coalesce(max(mo.operation_sequence), 0) + 1 INTO NEW.operation_sequence
        FROM public.manufacturing_operations mo
        WHERE mo.sample_id = NEW.sample_id AND mo.operation_id IS DISTINCT FROM NEW.operation_id;
    END IF;

    IF v_written THEN
        NEW.pass_code := btrim(NEW.pass_code);  -- typed (or the rule's own value): kept as written
    ELSIF v_auto THEN
        NEW.pass_code := public.operation_code_for(NEW, v_new_sample);
    END IF;
    RETURN NEW;
END;
$$;
```

    with a COMMENT, and `CREATE TRIGGER mfg_op_set_code BEFORE INSERT OR UPDATE ON manufacturing_operations FOR EACH ROW EXECUTE FUNCTION trg_mfg_op_set_code();`
    plus its COMMENT. (Its name sorts after `mfg_op_derive_category`, so `process_category` is
    already derived when it runs.) Update the COMMENTs on `pass_code` and `operation_sequence`.
  - `migrate:down`: drop `mfg_op_set_code` and its function; recreate
    `trg_manufacturing_operations_assign_numbers()`, its trigger and COMMENTs **verbatim from
    `20261003000126_operation_sequence_server_side.sql`** (diff to confirm); restore the
    `pass_code` / `operation_sequence` COMMENTs as 126 left them; set
    `operation_sequence = NULL` for the ledger's rows; drop the ledger table.
  - Add `DROP TABLE IF EXISTS d1_private.operation_sequence_backfill;` next to the two
    `restore_inline_param_meta_changes` lines in `tests/phase1_schema.sh`.
- [ ] **Step 4: `ROUNDTRIP=3` harness run (rolls back 157, 156, 155); FAIL lines = the 4
  pre-existing.**
- [ ] **Step 5: Commit** (`feat(db): operation codes follow their fields`).

---

### Task 5: Migration 158 — sample-code cascade and the preview function

**Files:**
- Create: `db/migrations/20261010000158_operation_code_cascade_and_preview.sql`
- Modify: `tests/phase1_schema.sh`

**Interfaces:**
- Consumes: Tasks 3-4.
- Produces: `preview_operation_code(p_values JSONB, p_operation_id UUID, p_sample_code TEXT) RETURNS TEXT`;
  triggers `physical_samples_rollup_lock` (statement-level BEFORE UPDATE) and
  `physical_samples_cascade_operation_codes` (row-level AFTER UPDATE).

- [ ] **Step 1: Failing tests** (prefix `9c000000-0000-4000-8000-`):
  - `cascade_auto`: sample `TEST-OC-CAS` with an automatic machining op; rename the sample to
    `TEST-OC-CAS2` → op code starts `TEST-OC-CAS2-F1-`, sequence unchanged.
  - `cascade_typed`: a typed op on the same sample keeps its code.
  - `cascade_frozen`: an experiment_sheet op on it keeps its code.
  - `cascade_tests_still`: a test coded on the sample (T0a) still follows (both cascades run).
  - `preview_new`: `preview_operation_code('{"process_category":"machining","sample_id":"<id>","machining_operation_subtype":"F","machining_cutting_speed_m_per_min":30}'::jsonb, NULL, 'TEST-OC-CAS2')`
    = the code a real insert with those values then gets.
  - `preview_edit`: for an existing op, `preview_operation_code('{"machining_feed_mm_per_rev":0.2}'::jsonb, <op id>, <its sample code>)`
    = the code it gets after `UPDATE … SET machining_feed_mm_per_rev = 0.2`.
  - `preview_method`: values with only `method_id` of a machining method (no
    `process_category`) derive the category from the method.
  - `lock_order` (two sessions): in bash, start session A in the background:
    `BEGIN; UPDATE physical_samples SET nickname = nickname WHERE sample_id = <S>; SELECT pg_sleep(2); COMMIT;`
    and right after, session B: `BEGIN; INSERT INTO manufacturing_operations (…, sample_id) VALUES (…, <S>); COMMIT;`
    both with `lock_timeout = '10s'`; assert neither prints `deadlock detected` and both
    commit. Use committed fixture rows with a fresh prefix and delete them at the end (the
    existing "Cleanup test rows" section shows the pattern). If two concurrent psql sessions
    cannot be made reliable in this harness, say so in the report rather than shipping a flaky
    check.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Migration:**
  - `trg_physical_samples_rollup_lock()`: `PERFORM pg_advisory_xact_lock(hashtextextended('refresh_project_rollup', 0)); RETURN NULL;`
    — `CREATE TRIGGER physical_samples_rollup_lock BEFORE UPDATE ON physical_samples FOR EACH STATEMENT …`
    (no column list: see Global Constraints). Comment: why statement level (row-level BEFORE
    triggers run after the row is locked).
  - `trg_cascade_operation_codes()`: `IF NEW.sample_code IS NOT DISTINCT FROM OLD.sample_code THEN RETURN NULL; END IF;`
    then `UPDATE public.manufacturing_operations m SET pass_code = public.operation_code_for(m, NEW.sample_code) WHERE m.sample_id = NEW.sample_id AND m.source_system IS DISTINCT FROM 'experiment_sheet' AND m.pass_code IS NOT DISTINCT FROM public.operation_code_for(m, OLD.sample_code);`
    — `CREATE TRIGGER physical_samples_cascade_operation_codes AFTER UPDATE ON physical_samples FOR EACH ROW …`.
    (In the operation trigger the written code equals the rule's value with the new sample
    code, so the op stays automatic.)
  - `preview_operation_code` (STABLE, `SET search_path`): read the saved row as jsonb (if any),
    merge `p_values` over it, `jsonb_populate_record` into a `manufacturing_operations` row; if
    `p_values` has `method_id` but not `process_category`, or the category is NULL, take
    `manufacturing_methods.process_category` for that method; if the op has a sample, no
    source_system, and (no saved row, or the sample or method changed, or no sequence) and
    `p_values` does not set `operation_sequence`, estimate the sequence as max+1 for the sample
    excluding this op; return `operation_code_for(row, p_sample_code)`. COMMENT: a preview only,
    no writes; the trigger decides on save.
  - Down: drop the two triggers and three functions.
- [ ] **Step 4: `ROUNDTRIP=4` run; FAIL lines = the 4 pre-existing.**
- [ ] **Step 5: Commit** (`feat(db): sample code corrections reach operation codes; code preview`).

---

### Task 6: Preview route on the d1-next-number endpoint

**Files:**
- Modify: `core/extensions/d1-next-number/index.js`
- Modify: `core/extensions/d1-next-number/index.test.mjs`
- Modify: `core/extensions/d1-next-number/package.json` (description)
- Modify: `scripts/dev/directus_smoke.mjs` (cases)

**Interfaces:**
- Produces: `POST /d1-next-number/operation-code` body `{ values: object, operation_id?: uuid|null }`
  → `200 { code: string|null }`; `401` no user; `403` no app access, or the user cannot read the
  operation or the sample; `400` bad body. The interface (Task 7) calls it.

- [ ] **Step 1: Failing node tests** in `index.test.mjs` (extend `mount` to capture both
  `router.get` and `router.post` handlers and to pass a `services` stub with an `ItemsService`
  class whose `readOne` returns `{sample_code: 'S-1'}` or throws a Directus-style
  `{status: 403}`/`ForbiddenError`): 401 without a user; 403 without app access; 400 when
  `operation_id` is not a uuid or `values` is not an object; 403 when the sample read is
  forbidden; on success the SQL is called with `(values json, operation_id, 'S-1')` and the
  response is `{code}`; only whitelisted keys reach the SQL (unknown keys dropped); an m2o value
  given as an object (`{sample_id: {sample_id: '<uuid>'}}`, `{method_id: {method_id: '…'}}`,
  `{equipment_id: {equipment_id: '…'}}`) is reduced to its key. Run with
  `node --test core/extensions/d1-next-number/index.test.mjs` → FAIL.
- [ ] **Step 2: Implement.** Handler signature `(router, { database, logger, services })`; same
  guards as `/sample`; whitelist = the code-input columns listed in Task 4's fast exit plus
  `notes` excluded; read the operation (when `operation_id` given) and the sample through
  `new services.ItemsService(<collection>, { accountability: req.accountability, schema: req.schema })`
  `.readOne(id, { fields: [...] })` — a thrown error with status 403 → 403; the sample id is
  `values.sample_id` if present, else the saved operation's; call
  `database.raw('SELECT preview_operation_code(?::jsonb, ?::uuid, ?) AS code', [JSON.stringify(values), operation_id ?? null, sampleCode ?? null])`.
  Errors → 500 with a generic message and `logger.error`.
- [ ] **Step 3: Node tests pass; add smoke cases** to `directus_smoke.mjs`:
  `op_create_auto` (create a machining op on the smoke sample with subtype F, speed 30, feed 0.1,
  DoC 1, a machining `method_id` read from `/items/manufacturing_methods?filter[process_category][_eq]=machining&limit=1`,
  no `pass_code` → `<sample>-F1-30MPM_0.1feed_1DoC`), `op_edit_follows` (PATCH speed 45 → code
  follows), `op_typed_kept` (PATCH pass_code `SMOKE-TYPED` then speed 50 → kept),
  `op_cleared` (PATCH pass_code null → rule's code), `op_preview_matches` (POST
  `/d1-next-number/operation-code` with `{values: {machining_feed_mm_per_rev: 0.2}, operation_id}`
  equals the code after PATCHing feed 0.2), `sample_rename_cascades` (PATCH the smoke sample's
  code → the auto op follows, the typed op does not), `create_machining_op_without_run_number`
  (a non-sintering create is not blocked by `sintering_run_number`). Run
  `bash scripts/dev/directus_smoke.sh` → all PASS.
- [ ] **Step 4: Commit** (`feat(d1-next-number): live operation-code preview`).

---

### Task 7: The operation-code box

**Files:**
- Create: `core/extensions/d1-operation-code/src/state.js`
- Create: `core/extensions/d1-operation-code/src/state.test.mjs`
- Modify: `core/extensions/d1-operation-code/src/OperationCode.vue` (rewrite)
- Modify: `core/extensions/d1-operation-code/package.json` (`"test": "node --test src/state.test.mjs"`)

**Interfaces:**
- Consumes: `POST /d1-next-number/operation-code` (Task 6).
- Produces: `state.js` exports `initialMode({ isNew, value, preview })` → `'auto' | 'typed'`
  (new → auto; existing → auto when `value` equals `preview` or both empty, else typed),
  `onTyped(text, preview)` → `{ mode, emit }` (empty → `{mode:'auto', emit:null}`; equal to the
  preview → `{mode:'auto', emit:text}`; else `{mode:'typed', emit:text}`),
  `onRegenerate()` → `{ mode: 'auto', emit: null }`, `shown({ mode, value, preview, error })`
  → the text to show (auto: the preview, or '' when it is null; typed: the value).

- [ ] **Step 1: Failing node tests** for each function and edge (empty strings, nulls, whitespace).
- [ ] **Step 2: Implement `state.js`; tests pass.**
- [ ] **Step 3: Rewrite `OperationCode.vue`:** inject `values`; on mount and on every change of
  `values` (debounced 300 ms; ignore out-of-order responses with a request counter) POST the
  preview with `{ values: <the form's values>, operation_id: <primaryKey unless '+'> }`; decide
  the initial mode once the first preview arrives (`initialMode`); in auto mode never emit (the
  database builds the code on save); typing calls `onTyped` and emits; the append icon is ↻
  in typed mode (`onRegenerate`, emits null) and a static `auto_fix_high` in auto mode; hints:
  auto "Automatic: follows the fields below." / typed "Typed: kept as you wrote it — ↻ to go back
  to automatic." / sintering with no run number: "Set the run number to get a code." / preview
  failure: "Preview unavailable — the database still builds the code on save." Delete the old
  `autoCode`, `num`, `dateCode`, abbreviation maps, MF/seq estimates and placeholder logic.
- [ ] **Step 4: Build check:** `npm run build` in `core/extensions/d1-operation-code` must succeed
  (install its dev dependencies in the worktree if missing: `npm install` in that folder; do not
  commit `node_modules` or `dist`). Run `npm test` there.
- [ ] **Step 5: Commit** (`feat(d1-operation-code): show the database's code as a live preview`).

---

### Task 8: Docs and the stage's own checks

**Files:**
- Modify: `docs/data-dictionary.md` (`manufacturing_operations`: `sintering_run_number`,
  `pass_code`, `operation_sequence`; the functions; the `short_id` CHECK)
- Modify: `docs/superpowers/specs/2026-10-10-record-codes-design.md` (Migrations table: T0b is
  155-158 now; T0c-T0f numbers become "next free"; Status line: T0b built)
- Modify: `docs/superpowers/plans/2026-10-09-explorer-round-2.md` (T0 status: T0b built)

- [ ] **Step 1: Docs**, wording from the migration COMMENTs.
- [ ] **Step 2: Full runs:** `ROUNDTRIP=4 bash scripts/dev/schema_test_docker.sh` (FAIL lines =
  the 4 pre-existing), `node --test core/extensions/d1-next-number/index.test.mjs`,
  `npm test` in `core/extensions/d1-operation-code`, `bash scripts/dev/directus_smoke.sh` (all PASS).
- [ ] **Step 3: Commit** (`docs: T0b operation codes`).

---

### Task 9 (coordinator): review, dry run, apply, check live

- [ ] Opus whole-branch review of T0b (base: the commit before Task 1).
- [ ] **Existing operations, automatic vs typed:** on a restored copy with 155-158 applied, list
  every non-frozen operation whose stored code differs from `operation_code_for(m, sample code)`
  (these will stay as typed until someone edits them) and every one that matches (they will
  follow their fields). Record counts and the differing rows in the plan's Outcome section for
  the maintainer.
- [ ] **Pre-checks on live** (read-only): duplicate (equipment, run) among FAST rows after the
  run back-fill (`SELECT equipment_id, split_part(source_run_uid,'|',2), count(*) … HAVING count(*) > 1` = none);
  user triggers on the touched tables all `'O'`; the no-placeholder CHECK still holds.
- [ ] **Dry run + Directus smoke on a copy:** `bash scripts/dev/directus_smoke.sh` (it restores a
  fresh copy and applies 155-158) → all PASS; time the migrations.
- [ ] **Backup:** `pg_dump -Fc -t manufacturing_operations -t physical_samples -t test_sessions -t directus_fields -t schema_migrations`
  → `backups/pre_t0b_<UTC>.dump`.
- [ ] **Apply in a quiet window:** stop Directus; copy 155-158 into the main checkout's
  `db/migrations`; `dbmate status` shows exactly 155-158 pending; `dbmate up`; copy the worktree's
  `core/extensions/d1-next-number/` and `core/extensions/d1-operation-code/src/` + `package.json`
  into the main checkout; `npm run build -w directus-extension-d1-operation-code` there; start
  Directus.
- [ ] **Live check (browser + API):** on the demo sample `DEMO-T0A-001` create a demo machining
  operation through the form (notes "DEMO … safe to delete"): the box previews the code as you
  type, the saved code matches; change the speed → the code follows; type a code → kept; ↻ →
  back to automatic. Open an existing FAST operation: the box says Automatic and shows its code.
