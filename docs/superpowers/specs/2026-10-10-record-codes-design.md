# Record codes: test codes, operation codes that follow their fields, short IDs and file hashes

Status: **draft for the maintainer's review** (2026-10-10). Stream T0 of
[`docs/superpowers/plans/2026-10-09-explorer-round-2.md`](../plans/2026-10-09-explorer-round-2.md);
it goes before N1 (navigation), whose finder and Tests index use what this adds. Every decision
below was made by the maintainer in a grilling round on 2026-10-09/10 (questions Q16-Q47; the
numbers are kept so the record can be traced).

## Why

- **Tests have no code.** A test session is known only by its date and type, so it cannot be
  searched for, written on a sample bag, or named in a file. The table is empty today (0 rows), so
  this is the cheapest moment to add one.
- **Operation codes go stale.** The code is built in the browser by `d1-operation-code` only for a
  new operation. Once saved it is treated as typed by hand: change the sample, the speed or the
  date and the code still shows the old values until someone presses ↻. Two more copies of the
  rules (`packages/force-plotting/src/operationCode.ts`, used by the Force dashboard's save and by
  the metadata doctor) can disagree with it.
- **The sintering rule is wrong.** In every one of the 10,048 imported FAST codes the number after
  `MF` is the machine (`MF25` = FAST 25, `MF250` = FAST 250) and the next number is the machine's
  run (`28-01-21-MF25-6453-1200C_11kN_20dia`). The form's rule treats the number after `MF` as a
  running counter, so the first hand-made sintering operation would be called `MF251`.
- **A renamed code drifts from its files.** Captured files on the lab share are named by the code
  at capture time (`…/9-AA-MR-2023-3-24-F24-200MPM_0.017feed_0.1DoC.mat`). Codes that rename
  themselves must not depend on file names, and files need an identity that does not depend on
  the code.

## Goals

1. Every test gets a readable code built from its subject and type, unique, assigned by the
   database.
2. Every automatic code (tests and operations) follows the fields it is built from, whatever path
   writes the record (the Directus form, the Explorer, the Force dashboard, an import, the API).
3. One copy of the code rules, in Postgres. The form and the Force dashboard show a live preview by
   asking the database.
4. One sintering format for imported and hand-made operations; the FAST codes rebuilt to it once.
5. A permanent short ID for samples, operations and tests, for people (labels, the finder, record
   pages), and an identity for files that survives renaming the code: the record ID inside new
   files and a content hash in the database for every linked file.

## Non-goals

- Renaming files on the share. Existing files keep their names (Q40, superseded by the short-ID
  model; the maintainer: files "save with that old name").
- Writing anything into existing `.mat` files (Q46). That is the future `.mat` metadata migration,
  blocked by the `fileVersion` ↔ layout coupling (`docs/force-file-standards.md` §6).
- The Force App's recording itself (Phase 2). This spec defines what a recorded file must carry;
  Phase 2 implements it (Q47).
- Codes for campaigns and projects (typed by people, rarely change; no short ID either, Q41).
- Navigation, index pages and the finder (N1). N1 consumes `test_code` and `short_id`.

## Decisions (maintainer, 2026-10-09/10)

| # | Decision |
|---|---|
| Q12 | Test codes are their own step (T0), done before N1. |
| Q16 | Test code = `{primary subject code}-{TYPE}{n}`, e.g. `116-RK-MH-2024-12-18-SEM1`. The subject code is the sample code, or the edge code for an insert edge. |
| Q17 | Numbered by the database, unique from day one, can be overridden by hand. |
| Q20 | TYPE abbreviations: tensile TEN, hardness HRD, charpy CHP, compression CMP, tribology TRB, optical_microscopy OM, sem SEM, tem TEM, xrd XRD, alicona ALI, clemx CLX, dct DCT, ct_scan CT, fatigue FAT, creep CRP, dma DMA, other OTH. |
| Q21 | The code appears when the first subject is linked; before that the test has none. **It changes when the test type or the primary subject changes.** |
| Q22 | The test form shows a plain text box with a hint (no new interface extension). |
| Q23 | After a change the code takes the next free number for its new subject and type. Numbers are never reused; tests that were not changed keep their codes. The old code stays in the audit log. |
| Q24 | A hand-typed code is kept when the subject or type changes later. |
| Q25 | Only the primary subject counts; adding a second subject changes nothing. |
| Q26 | The renaming happens in the database, for tests and operations. |
| Q27 | Every part of an operation code follows its field. The number stays when only parameters or the date change; it becomes the next free number when the input sample or the method changes. |
| Q28 | Nothing is mass-renamed; a code renames when its record is edited. (Revised by Q37 for FAST and kept by Q38 for experiment-sheet imports.) |
| Q29 | "Automatic" means the code is what the rule gives for the record's current fields; anything else counts as typed by hand. Tests keep a flag. |
| Q30 | Operation codes stay non-unique for now. The duplicates are listed for the maintainer to fix by hand; then UNIQUE is switched on. |
| Q31 | A test that loses all its subjects keeps its last code. |
| Q34 | The primary subject becomes the **earliest linked** one (today it is the lowest random junction id). |
| Q35 | Sintering code = `DD-MM-YY-MF{machine}-{run}[-{T}C_{F}kN_{D}dia]`, machine 25 or 250, run = the machine's next run number. The running-MF-counter rule is dropped. |
| Q36 | The rules live only in the database. The form box and the Force dashboard show a live preview by asking it; the dashboard stops writing codes. A Force App release is part of T0. |
| Q37 | All 10,048 FAST codes are rebuilt to the Q35 rule once; afterwards they follow the rules like any other. New FAST imports get their code from the database (retires the `finalize_fast_codes.py` step). |
| Q38 | The 151 machining operations imported from experiment sheets stay **frozen**: their codes match the archive file names. Their 6 `N/R` codes go on the hand-fix list. |
| Q39 | When a sample's code changes, the automatic codes of its operations and tests follow (same numbers). Typed and frozen codes are left alone. |
| Q41 | Samples, operations and tests get a short ID. |
| Q42 | Short ID = the first 8 hex characters of the record's UUID, unique, never changes (9+ characters on the rare clash). |
| Q43 | File names carry the code at capture time and **no ID**. The full record ID goes inside the file; the database stores a content hash of every linked file; the Force App generates the record ID when a capture starts. |
| Q44 | The short ID shows on Explorer record pages (copyable), in the finder, on printed sample labels (text + QR) and as a read-only field on the Directus form. |
| Q45 | Hash the operation-linked files first, then the rest of the share in the background. |
| Q46 | Old `.mat` files are left untouched; the hash rule goes into `docs/force-file-standards.md` for the future migration. |
| Q47 | T0 defines the rules and the database pieces; Phase 2 recording implements "ID inside the file"; the MATLAB writer, if still used, is its own task. |

## Current state (measured 2026-10-09 on the live database)

- **Operations:** 10,284. By `source_system`: `fast_25` 9,735 and `fast_250` 313 (all sintering,
  none has a sample), `experiment_sheet` 151 (machining), NULL 85 (84 machining, 1 with no
  category). Sintering operations reference equipment `FCT HP D 25` / `FCT HP D 250`; their run
  number is in `source_run_uid` (`fast25|4624`).
- **FAST code shapes:** FAST 25: 6,115 full (`…-MF25-4624-1200C_14kN_20dia`), 3,412 without
  parameters, 208 other. FAST 250: 228 without parameters, 85 other, none full.
- **Numbering today:** trigger `mfg_op_assign_numbers` (`20261003000126`) fills `{seq}` (per-sample
  `operation_sequence`, max+1 under the sample row lock; not for imports) and `{mf}` (1 + the
  highest `MF\d+` in any sintering code), after taking the global `refresh_project_rollup`
  advisory lock. CHECK `manufacturing_operations_pass_code_no_placeholder_check` (NOT VALID).
- **No uniqueness on `pass_code`.** Duplicates: `N/R` × 6 (all experiment-sheet machining,
  2023-03-23, no linked files); 9 operations have no code (NULL; allowed by UNIQUE).
- **Tests:** 0 rows. The primary subject (`sample_id` / `insert_edge_id`) is derived from the M2A
  junction `test_sessions_subject` by `sync_test_session_primary_subject()` (`20261007000139`),
  ordered by the junction's random `id`.
- **Files:** 222,725 on storage `star` (the lab share), 11,741 `local`. `.mat` archive files are
  linked to operations by stored foreign keys (`operation_data_files`, 186 rows;
  `machining_force_analysis.operation_id`), never by `pass_code` at runtime.
- **Copies of the operation rules:** `core/extensions/d1-operation-code/src/OperationCode.vue`
  (`autoCode`), `packages/force-plotting/src/operationCode.ts` (`computeAutoCode`, used by
  `ForceDashboard.vue` to PATCH `pass_code` and by `metadataDoctor.ts` for "name.stale").

## Design

### 1. Short IDs (samples, operations, tests)

- Column `short_id TEXT` on `physical_samples`, `manufacturing_operations`, `test_sessions`;
  `UNIQUE`, `NOT NULL` after back-fill, never updated (a BEFORE UPDATE guard rejects a change).
- Value: `left(replace(<uuid>::text,'-',''), 8)`. On a clash, 9, then 10 … characters until unique.
  Assigned by a BEFORE INSERT trigger (and the back-fill), under a per-table advisory lock so two
  inserts cannot pick the same value.
- Directus: read-only `input` field near the top of each form, note "Permanent ID — never changes".
- Lookup helper for tools: `record_by_short_id(text) RETURNS TABLE(collection text, id uuid)`.

### 2. Test codes

**Columns on `test_sessions`:** `test_code TEXT UNIQUE` (NULL until a subject is linked),
`test_code_number INTEGER` (the `n`), `test_code_is_manual BOOLEAN NOT NULL DEFAULT false`.
**Counters:** `test_code_counters(subject_collection TEXT, subject_id UUID, test_type TEXT,
last_number INTEGER, PRIMARY KEY (…))`, so a number is never handed out twice (Q23), even when the
highest one moved away.

**Primary subject = earliest linked (Q34).** `test_sessions_subject` gains `linked_at TIMESTAMPTZ
NOT NULL DEFAULT clock_timestamp()`; `sync_test_session_primary_subject()` orders by
`(linked_at, id)` instead of `id`. Removing the primary promotes the next earliest.

**The rule** (`test_code_for(subject_code, test_type, n)`):
`{subject_code}-{ABBR[test_type]}{n}`. Subject code = `physical_samples.sample_code` when
`sample_id` is set, else `insert_edges.edge_code`.

**Trigger** `test_sessions_set_code`, BEFORE INSERT OR UPDATE on `test_sessions`:

1. *Typed by hand:* `NEW.test_code` differs from `OLD.test_code` (or is set on INSERT) and is not
   the rule's value → `test_code_is_manual := true`, keep it. Cleared to NULL/'' → `is_manual :=
   false`, rebuild below.
2. *Manual codes are left alone* (Q24).
3. *No subject:* keep whatever code there is (Q31; on INSERT that means NULL).
4. *Primary subject or `test_type` changed, or no code yet:* take the next number from
   `test_code_counters` for (subject, type), store it in `test_code_number`, build the code. If
   that code is already taken (someone typed it by hand on another test), take the next number
   again, so an automatic code never hits the UNIQUE constraint.
5. *Only the subject's code changed* (Q39, see §4): rebuild with the same number.

The junction sync already issues a real UPDATE on `test_sessions` when the primary changes, so
the BEFORE trigger sees the new subject. A test inserted by Directus has no subject at INSERT time
(the junction rows follow), so its code appears on that follow-up UPDATE (Q21).

**Directus:** `test_code` as an `input` after `test_type`, note "Assigned automatically when a
subject is linked; follows the subject and type. Type your own to keep it fixed; clear it to go
back to automatic." `test_code_number` and `test_code_is_manual` hidden.

### 3. Operation codes in Postgres

**The rule** `operation_code_for(op manufacturing_operations, sample_code text) RETURNS text`,
STABLE (it reads the equipment row for the sintering machine): a faithful port of
`OperationCode.vue`'s `autoCode` (lines 148-215 and the abbreviation maps at 135-144), with three
deliberate changes:

| Category | Code |
|---|---|
| machining | `{sample}-{machining_operation_subtype}{seq}-{speed}MPM_{feed}feed_{doc}DoC` |
| heat_treatment | `{sample}-HT{type abbr}{seq}-{peak}C_{hold}min_{cooling abbr}` |
| deformation | `{sample}-{DR/DF/DE/DD/DX, else D}{seq}-{temp}C_{reduction}pct_{passes}p` |
| additive | `{sample}-{am_process_variant, else AM}{seq}-{power}W_{scan}mmps_{layer}mm` |
| **sintering (changed, Q35)** | `{DD-MM-YY}-MF{machine}-{run}[-{T}C_{F}kN_{D}dia]` |
| sample_prep / empty | `{sample}-{seq}`, or `{sample}` |

- Parameters are written only when set; numbers as `num()` does today (6 significant digits, no
  trailing zeros). Unchanged abbreviation maps (HT types and cooling, deformation tokens).
- **Change 1 — sintering:** machine = 25 or 250 from the operation's equipment (`FCT HP D 25` /
  `FCT HP D 250`, pinned by id in the migration), run = `sintering_run_number`.
- **Change 2 — the date is taken in `Europe/London`** (the browser used local time).
- **Change 3 — no placeholders.** The database knows the numbers when it builds the code, so
  `{seq}`/`{mf}` disappear. The trigger still accepts them from an old client (treated as "build
  it for me") until the Force App release is out.

**Numbers:** `operation_sequence` (existing, per sample) and a new `sintering_run_number INTEGER`
(per machine; back-filled from `source_run_uid` for FAST imports). Kept when only parameters or
the date change; the next free number when the input sample or the method changes (Q27):
`max(operation_sequence)+1` for the new sample, or `max(sintering_run_number)+1` for the machine.
A machining sub-type change (F → R) counts as a parameter: the number stays.

**Frozen operations:** `source_system = 'experiment_sheet'` — never renamed automatically (Q38).
FAST imports (`fast_25`, `fast_250`) are not frozen after the rebuild (Q37). A future importer
that needs frozen codes is added to this list explicitly, in its own migration.

**Trigger** `mfg_op_set_code` replaces `mfg_op_assign_numbers`, BEFORE INSERT OR UPDATE.
Its name sorts after `mfg_op_derive_category`, so `process_category` is already set when it runs.

1. *Frozen:* leave `pass_code` alone.
2. *Automatic or typed?* On UPDATE the code is automatic when `OLD.pass_code =
   operation_code_for(OLD, old sample code)` (Q29). On INSERT it is automatic when `pass_code` is
   NULL/'' or contains a placeholder.
3. *Typed:* a code written in this statement that is not the rule's value stays as written; a
   cleared code goes back to automatic.
4. *Automatic:* assign the numbers as above, then `NEW.pass_code := operation_code_for(NEW, …)`.
5. **Lock order, unchanged:** `refresh_project_rollup` advisory lock → sample row
   (`FOR NO KEY UPDATE`) → the per-machine run counter lock. Taken only when a number is
   assigned, as today.
6. Fast exit: on UPDATE, when none of the fields the code is built from changed and `pass_code`
   did not change, return at once (the dashboards write these rows often).

### 4. Sample code changes (Q39)

An AFTER UPDATE OF `sample_code` trigger on `physical_samples` rebuilds the automatic codes of the
sample's operations (`sample_id`) and of tests whose primary subject is that sample, with the same
numbers. It sets the new code explicitly, only on rows whose stored code equals the rule's value
with the *old* sample code (that is what "automatic" means here), so it does not rely on the
operation trigger's fast exit. It runs one UPDATE per table (so the operation trigger's rollup lock is taken once per
statement, after the sample row, matching the lock order). Typed and frozen codes are untouched.
The same applies to `insert_edges.edge_code` for tests.

### 5. Live preview (Q36)

- SQL: `preview_operation_code(values jsonb, operation_id uuid) RETURNS text` and
  `preview_test_code(values jsonb, session_id uuid) RETURNS text`. They build the code from the
  form's current values and the numbers the record has (or the next free one, as an estimate);
  no writes. `values` is the form's partial state merged over the saved row.
- Endpoint: two routes added to `d1-next-number` (it already asks Postgres for the next sample
  number): `POST /d1-next-number/operation-code` and `POST /d1-next-number/test-code`. Same
  guards (signed-in user with app access). The sample and edge codes they read are ones the user
  picked in the form.
- **`d1-operation-code` box:** shows the preview, updating 300 ms after the last change. In
  automatic mode it sends **no** `pass_code`, so the database builds it on save; typing sends the
  text (typed); ↻ clears it (back to automatic). Hints: "Automatic: follows the fields below" /
  "Typed: kept as you wrote it — ↻ to go back to automatic". The browser copy of the rules is
  deleted.
- **Force dashboard (and the standalone Force App, same package):** `computeAutoCode` is removed.
  Its metadata panel shows the preview from the endpoint and no longer PATCHes `pass_code`;
  "name.stale" in `metadataDoctor` compares the stored code with the endpoint's answer. One Force
  App release, through the `force-app-release` / ship-release workflow.

### 6. FAST rebuild (Q37) and the importer

One migration, after §3 is in place:

1. Back-fill `sintering_run_number` from `source_run_uid` (`fast25|4624` → 4624); stop with an
   error listing any FAST row it cannot parse.
2. Check that (machine, run) is unique across sintering rows; stop with the clashes listed if not.
3. Rebuild every FAST `pass_code` with `operation_code_for`. One UPDATE statement; the audit
   trigger records each old code; the statement-level rollup refresh runs once.

`scripts/finalize_fast_codes.py` is retired: the FAST importers leave `pass_code` NULL as now and
set `sintering_run_number`, and the trigger builds the code on insert.

### 7. File identity (Q43, Q45, Q46)

- **Table `file_fingerprints`:** `directus_files_id UUID PRIMARY KEY` (FK, ON DELETE CASCADE),
  `content_sha256 TEXT` (the whole file), `data_sha256 TEXT` (`.mat` only: the main force-data
  matrix's raw bytes as stored, float64 little-endian column-major), `size_bytes BIGINT`,
  `hashed_at TIMESTAMPTZ`. Index on each hash. `data_sha256` survives metadata-only edits (the
  future metadata migration), so an old file stays recognisable after it; a layout upgrade
  (v0.5 → v1.0) changes it, and the tool doing the upgrade records the new value.
- **Back-fill:** the heavy-data worker hashes the 186 operation-linked files first, then walks the
  rest of `star` and `local` in the background, oldest first, resumable, throttled so the share
  stays usable. Re-hashed when `directus_files.modified_on` changes.
- **New files:** the code at capture time is the file name, with no ID (Q43). Phase 2 recording
  generates the operation's UUID (time-ordered, v7) when a capture starts, writes it into the
  file's metadata as `RecordID` (and `RecordShortID`), and creates the operation with that id.
- **`docs/force-file-standards.md`:** new §3.4 "Record identity" (`RecordID`, `RecordShortID`,
  added only by writers of new files; readers use `isfield`) and §6 rules for hashes: the two
  hashes, how `data_sha256` is computed, and that a migration which rewrites the matrix must
  record the new `data_sha256` against the same file. Old files are not rewritten (Q46).

### 8. Hand-fix list (for the maintainer)

The 6 `N/R` operation codes, all experiment-sheet machining dated 2023-03-23, frozen, no linked
files: `41182593-1c07-53d4-aa9a-b454c3e1a266`, `53f517cc-0885-544a-bbda-fe3e05943bf2`,
`ba64ab12-5b02-563c-8967-b0f628ecfe4d`, `df74191d-403f-5a99-9008-d6d6dc4b5bd1`,
`fc328912-f090-5de0-aa5f-0d8a4b181408`, `fe32afdd-e907-5c6c-97cb-07b619606d3d` (the last three
are on one sample, sequences 1, 3 and 8). After they are fixed, a small migration adds `UNIQUE (pass_code)` (Q30). The 9 NULL
codes are allowed by UNIQUE and become automatic codes at their next edit (they are not frozen).

## Migrations (in order)

| Version | What |
|---|---|
| `…144_short_ids` | `short_id` on the three tables, back-fill, trigger, guard, `record_by_short_id()` |
| `…145_test_subject_linked_at` | `linked_at`, primary subject = earliest linked |
| `…146_test_codes` | test code columns, counters, `test_code_for()`, trigger, Directus field rows |
| `…147_operation_codes_in_db` | `sintering_run_number`, `operation_code_for()`, `mfg_op_set_code` replacing `mfg_op_assign_numbers`, preview functions, sample/edge code cascade |
| `…148_fast_code_rebuild` | back-fill run numbers, uniqueness check, rebuild the FAST codes |
| `…149_file_fingerprints` | the table and its indexes |
| later | `UNIQUE (pass_code)`, after the hand-fix |

Each has a working `migrate:down`, comments on every new table and column, and its checks in
`tests/phase1_schema.sh`. The latest live migration is `20261009000143`. Data-dictionary entries
for the new columns and tables.

## Risks and how each is checked

| Risk | Check |
|---|---|
| The SQL rule differs from the browser rule for existing machining codes, so automatic codes look "typed" | Before switching: run `operation_code_for` over the 84 non-imported machining rows and list every row whose stored code differs; the maintainer sees the list in review. |
| Deadlock with the rollup lock | Same lock order as `20261003000126`; a test runs two concurrent sessions renaming operations of one sample. |
| The FAST rebuild clashes or mis-parses a run number | Steps 1-2 of §6 stop the migration with the offending rows listed; dry-run in BEGIN/ROLLBACK on a copy first. |
| An old Force App build writes a code during the switch | Placeholders still accepted; a code it builds that equals the rule stays automatic. The release goes out with T0. |
| Renames cost work on busy rows | Fast exit when no input changed; renames happen only on edits. |
| A test renames unexpectedly when a subject is added | Earliest-linked primary (Q34): adding a subject never changes the primary. Tested. |
| A short-ID clash | UNIQUE + lengthen; tested with a forced clash. |

## Testing

- `tests/phase1_schema.sh`, following the sections at lines 940-1211 (operation and sample
  numbering) and 1478-1586 (test subjects): short IDs (back-fill, clash, guard); test codes (first
  subject, second subject, primary removed, type change, numbers not reused, typed kept, cleared
  back to automatic, no subject keeps code, uniqueness); operation codes (every category, number
  kept on a parameter change, next number on a sample/method change, typed kept, frozen untouched,
  placeholders from old clients, sample code cascade); FAST run back-fill and rebuild on seeded
  rows; preview functions.
- Kit / extension tests: `d1-operation-code` (preview debounce, automatic sends no code, typed,
  ↻); `d1-next-number` routes (auth guards, bad input); force-plotting (no code PATCH,
  name.stale via the endpoint); `tests/ui/specs/08-operation-code-autogen.spec.ts` updated.
- Live check after applying: an existing machining operation renames when its speed changes; a
  typed one does not; a new test gets its code when a sample is linked; a FAST code reads
  `DD-MM-YY-MF25-{run}-…`.

## Stages (Sonnet workers at high effort; Opus review; the coordinator applies)

1. **T0a** short IDs + test codes (migrations 144-146), with tests.
2. **T0b** operation codes in Postgres + preview endpoint + the form box (147).
3. **T0c** Force dashboard / force-plotting changes and the Force App release.
4. **T0d** FAST rebuild (148) — backup of `manufacturing_operations` first; dry run; apply.
5. **T0e** file fingerprints (149) + the worker's back-fill + the force-file-standard update.
6. **T0f** UNIQUE on `pass_code`, after the maintainer's hand-fix.

Each stage: Opus migration review → backup of the touched tables → apply → Directus restart →
live check, as for the form fix (F2). Never `configure_all.sh` or `configure_directus.sql`.

## What N1 takes from this

The Tests index and the finder use `test_code`; the finder also matches `short_id` on samples,
operations and tests; record pages show the short ID with a copy button (built in N1/L1); the
sample label adds the short ID and a QR code (a `d1-report` change, in N1).
