# Record codes: test codes, operation codes that follow their fields, short IDs and file hashes

Status: **approved by the maintainer on 2026-10-10** ("spec approved", with Q48 answered (a)).
**T0a, T0b and T0c (Directus side) are live (migrations 150-158, the `d1-next-number` operation-code
route, the `d1-operation-code` box); T0d is built on `feat/record-codes` (scripts only, nothing deployed).**
**T0e (file fingerprints) LIVE 2026-10-11: migration 159 + `scripts/file_fingerprints.py`; the 187 linked files are hashed (183 done, 4 permanent errors).**
Next: T0f after the maintainer's N/R hand-fix.
**T0d built (no migration): the FAST importers write `sintering_run_number`, `scripts/finalize_fast_codes.py` is retired.**
Stream T0 of
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
| Q35 | Sintering code = `DD-MM-YY-MF{machine}-{run}[-{T}C_{F}kN_{D}dia]`, machine 25 or 250. The running-MF-counter rule is dropped. |
| Q48 | The run is the number the FAST machine shows: typed by the person on a hand-logged operation, read from the file by the importer. The importer fills in an existing operation with the same machine and run instead of creating a duplicate. |
| Q36 | The rules live only in the database. The form box and the Force dashboard show a live preview by asking it; the dashboard stops writing codes. A Force App release is part of T0. |
| Q37 | All 10,048 FAST codes are rebuilt to the Q35 rule once; afterwards they follow the rules like any other. *(Rebuild superseded 2026-10-11: measured no-op, see the T0d outcome note.)* New FAST imports get their code from the database (retires the `finalize_fast_codes.py` step). |
| Q38 | The 151 machining operations imported from experiment sheets stay **frozen**: their codes match the archive file names. Their 6 `N/R` codes go on the hand-fix list. |
| Q39 | When a sample's code changes, the automatic codes of its operations and tests follow (same numbers). Typed and frozen codes are left alone. |
| Q41 | Samples, operations and tests get a short ID. |
| Q42 | Short ID = the first 8 hex characters of the record's UUID, unique, never changes (9+ characters on the rare clash). *Added in review:* unique across samples, operations and tests together, and new ids stay random (v4). |
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
  Assigned by a BEFORE INSERT trigger (and the back-fill), under one advisory lock shared by the
  three tables so two inserts cannot pick the same value.
- **Unique across all three tables**, not per table: a label's QR code or a short ID typed in the
  finder must reach exactly one record. A registry table `short_ids(short_id TEXT PRIMARY KEY,
  collection TEXT, record_id UUID)` holds every assigned value; the triggers insert into it and
  a delete of the record removes its row. All record ids here are random UUIDs (v4), so the first
  8 hex characters are random; **new ids must stay v4** (see §7: a time-ordered v7 id would put
  timestamp bits in those characters and clash for every capture made within the same minute).
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
- **Change 2 — the date is taken in UTC.** Every one of the 10,048 FAST codes already uses the UTC
  date (measured: 0 differ in UTC, 1 would differ in `Europe/London`), so UTC keeps them as they
  are. The browser used local time; only sintering codes carry a date, and none was made by hand.
- **Change 3 — no placeholders.** The database knows the numbers when it builds the code, so
  `{seq}`/`{mf}` disappear. The trigger still accepts them from an old client (treated as "build
  it for me") until the Force App release is out.

**Numbers:** `operation_sequence` (existing, per sample) and a new `sintering_run_number INTEGER`
(per machine; back-filled from `source_run_uid` for FAST imports). Kept when only parameters or
the date change; the next free number when the input sample or the method changes (Q27):
`max(operation_sequence)+1` for the new sample. **The sintering run number is never invented**
(Q48): it is the run number the FAST machine shows, typed by the person on a hand-logged
operation (a new `sintering_run_number` field on the form, required for sintering) or read from
the machine's file by the importer. Until it is set, a sintering operation has no code. When the
importer meets an operation with the same machine and run, it fills that operation in instead of
creating a second one.
A machining sub-type change (F → R) counts as a parameter: the number stays.

**Missing sequence numbers.** 52 machining operations have no `operation_sequence` (43 made by
hand, 9 experiment-sheet). On those samples a new operation would get `max+1` and repeat an
F-number already in a code. The migration fills `operation_sequence` from the number after the
sub-type in the stored code (`…-F8-…` → 8) wherever it parses, for frozen rows too (the number is
read, the code is not touched), and lists the rows it could not parse.

**Sintering runs are unique per machine:** a unique index on `(equipment_id,
sintering_run_number)` for sintering rows, not only a one-off check during the rebuild.

**Frozen operations:** `source_system = 'experiment_sheet'` — never renamed automatically (Q38).
FAST imports (`fast_25`, `fast_250`) are not frozen after the rebuild (Q37). A future importer
that needs frozen codes is added to this list explicitly, in its own migration.

**Trigger** `mfg_op_set_code` replaces `mfg_op_assign_numbers`, BEFORE INSERT OR UPDATE.
Its name sorts after `mfg_op_derive_category`, so `process_category` is already set when it runs.

1. *Frozen:* never renamed automatically. A person can still re-type the code, but clearing it (empty, or writing a `{seq}`/`{mf}` placeholder) keeps the saved code.
2. *Automatic or typed?* On UPDATE the code is automatic when `OLD.pass_code =
   operation_code_for(OLD, old sample code)` (Q29). On INSERT it is automatic when `pass_code` is
   NULL/'' or contains a placeholder.
3. *Typed:* a code written in this statement that is not the rule's value stays as written; a
   cleared code goes back to automatic.
4. *Automatic:* assign the numbers as above, then `NEW.pass_code := operation_code_for(NEW, …)`.
5. **Lock order, unchanged:** `refresh_project_rollup` advisory lock → sample row
   (`FOR NO KEY UPDATE`). Taken only when a sequence number is assigned, as today. (No run
   counter: the run number is typed or imported, Q48, and the unique index guards it.)
6. Fast exit: on UPDATE, when none of the fields the code is built from changed and `pass_code`
   did not change, return at once (the dashboards write these rows often).

### 4. Sample code changes (Q39)

An AFTER UPDATE OF `sample_code` trigger on `physical_samples` rebuilds the automatic codes of the
sample's operations (`sample_id`) and of tests whose primary subject is that sample, with the same
numbers. It sets the new code explicitly, only on rows whose stored code equals the rule's value
with the *old* sample code (that is what "automatic" means here), so it does not rely on the
operation trigger's fast exit. Typed and frozen codes are untouched. The same applies to
`insert_edges.edge_code` for tests.

**Lock order.** Updating the operations fires the statement-level `refresh_rollup_ops`, which
takes the `refresh_project_rollup` advisory lock (`20261003000118`). By then the UPDATE on
`physical_samples` already holds the sample row, which is the reverse of the order a new operation
uses (rollup lock, then sample row, `20261003000126`): the two could deadlock. So a BEFORE UPDATE
OF `sample_code` trigger on `physical_samples` takes the rollup lock first, before the row is
changed, restoring the one order (rollup → sample row → counters). The plan verifies with a
two-session test that this holds (a sample-code edit and a new operation on the same sample,
concurrently) before relying on it.

### 5. Live preview (Q36)

- SQL: `preview_operation_code(values jsonb, operation_id uuid) RETURNS text` and
  `preview_test_code(values jsonb, session_id uuid) RETURNS text`. They build the code from the
  form's current values and the numbers the record has (or the next free one, as an estimate);
  no writes. `values` is the form's partial state merged over the saved row.
- Endpoint: two routes added to `d1-next-number` (it already asks Postgres for the next sample
  number): `POST /d1-next-number/operation-code` and `POST /d1-next-number/test-code`. Same
  guards (signed-in user with app access). **Permissions:** the endpoint's `database` connection
  ignores Directus permissions, so it must not read a sample or edge code itself (a user could
  send any `sample_id` and learn a code they cannot see, against the row visibility of ADR-0011).
  It reads them through Directus's `ItemsService` with the request's accountability, and passes
  the codes into the SQL function; a sample the user cannot read gives a 403, not a code.
- **`d1-operation-code` box:** shows the preview, updating 300 ms after the last change. In
  automatic mode it sends **no** `pass_code`, so the database builds it on save; typing sends the
  text (typed); ↻ clears it (back to automatic). Hints: "Automatic: follows the fields below" /
  "Typed: kept as you wrote it — ↻ to go back to automatic". The browser copy of the rules is
  deleted.
- **Force dashboard (and the standalone Force App, same package):** `computeAutoCode` is removed
  and the metadata panel no longer PATCHes `pass_code`; after a save it shows the code the database
  stored (read back from the PATCH). *Changed in T0c (2026-10-11):* no live preview inside the
  dashboard (the Directus form has it), and the opt-in "name.stale" check is retired rather than
  rewired (an automatic code cannot be stale any more and typed codes are intended). The Directus
  module ships with T0b; the standalone Force App gets it at its next release (a PR to `main`,
  the maintainer's decision).

### 6. FAST rebuild (Q37) and the importer

*(Steps 1-3 and the expected size below are superseded 2026-10-11: measured no-op, see the T0d outcome note at the end of this section.)*

One migration, after §3 is in place:

1. *(superseded 2026-10-11: measured no-op, see the T0d outcome note)* Back-fill `sintering_run_number` from `source_run_uid` (`fast25|4624` → 4624); stop with an
   error listing any FAST row it cannot parse.
2. Check that (machine, run) is unique across sintering rows; stop with the clashes listed if not.
3. Rebuild every FAST `pass_code` with `operation_code_for`. One UPDATE statement; the statement-
   level rollup refresh runs once. The old codes go into a ledger table
   (`d1_private.fast_code_rebuild_changes`: operation id, old code, new code) so `migrate:down`
   restores them exactly; it is also added to the `DROP TABLE` list of the migration-141 test, the
   same CI trap the form fix hit.

**Expected size (measured 2026-10-09):** *(superseded 2026-10-11: measured no-op, see the T0d outcome note)* with UTC dates, every FAST code already matches the rule:
0 date prefixes differ, 0 run numbers differ from `source_run_uid`, 0 duplicate runs, 0 short
codes whose row has parameters, and the 293 "other" shapes are codes with only some parameters
set, which the rule also writes. So the rebuild should change almost nothing; its real effect is
that FAST codes stop being special. The migration prints the count it changed and the plan's dry
run lists every changed row for the reviewer.

`scripts/finalize_fast_codes.py` is retired: the FAST importers leave `pass_code` NULL as now and
set `sintering_run_number`, and the trigger builds the code on insert.

T0d outcome (2026-10-11): the rebuild was measured on live and is a no-op, so no rebuild migration was written; the importers write `sintering_run_number`, adopt a hand-logged run of the same machine and run, and `finalize_fast_codes.py` is deleted.

### 7. File identity (Q43, Q45, Q46)

- **Table `file_fingerprints`:** `directus_files_id UUID PRIMARY KEY` (FK, ON DELETE CASCADE),
  `content_sha256 TEXT` (the whole file), `data_sha256 TEXT` (`.mat` only: the *decoded* main
  force-data array, never the bytes on disk, because v7.3 files are HDF5 and their chunked or
  compressed bytes change without the data changing. Defined as SHA-256 over: the array's
  MATLAB shape as two little-endian uint64 (rows, cols), then, for each column in order, the
  32-byte SHA-256 digest of that column's values as float64 little-endian (top to bottom).
  *Amended 2026-10-11 during T0e:* the first wording hashed all values in one column-major
  stream; real v7.3 force files are chunked 10 columns × 819 samples, so a column-major stream
  re-reads an 11.8 GB file ~10× over the share, while per-column digests are computed in one
  pass. The variable read is `data` when present, else `DATA` — taken from the variables, not
  from `fileVersion` (22 files declare v1 but carry the v0.9 layout)), `size_bytes BIGINT`,
  `hashed_at TIMESTAMPTZ`. Index on each hash. `data_sha256` survives metadata-only edits (the
  future metadata migration), so an old file stays recognisable after it; a layout upgrade
  (v0.5 → v1.0) changes it, and the tool doing the upgrade records the new value.
- **Back-fill:** the heavy-data worker hashes the 186 operation-linked files first, then walks the
  rest of `star` and `local` in the background, oldest first, resumable, throttled so the share
  stays usable. Re-hashed when `directus_files.modified_on` changes.
  *As built (T0e, 2026-10-11):* a host script, `scripts/file_fingerprints.py`, not the heavy-data
  worker (the worker has neither the share nor a database driver). It runs by hand:
  `--phase linked` (files linked to operations, samples, tests and force analyses), then
  `--phase all`. The staleness key is `filesize` plus the share mtime the indexer writes to
  `metadata.modified` (falling back to `modified_on`). Each row has a status (`done` / `error` /
  `missing`); failed rows are retried on the next run. When the indexer detects a moved file,
  the fingerprint moves with the file's references.
- **New files:** the code at capture time is the file name, with no ID (Q43). Phase 2 recording
  generates the operation's UUID (**random, v4**, so its short ID is random too, §1) when a
  capture starts, writes it into the file's metadata as `RecordID` (and `RecordShortID`), and
  creates the operation with that id.
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
| `…150_short_ids` | `short_id` on the three tables, back-fill, trigger, guard, `record_by_short_id()` |
| `…151_test_subject_linked_at` | `linked_at`, primary subject = earliest linked |
| `…152_test_codes` | test code columns, counters, `test_code_for()`, trigger, Directus field rows |
| `…155_short_id_format_check` | **T0b, built.** CHECK on the three `short_id` columns (8-32 lower-case hex) |
| `…156_operation_code_rule` | **T0b, built.** `code_num()`, `sintering_run_number` and its unique index (per machine), `operation_code_for()` (machining token drops a two-letter method prefix), run-number back-fill |
| `…157_operation_code_trigger` | **T0b, built.** `mfg_op_set_code` replacing 126's `mfg_op_assign_numbers` (automatic vs typed, renumbering, frozen experiment_sheet rows keep their code even when cleared), `operation_sequence` back-fill with ledger `d1_private.operation_sequence_backfill` |
| `…158_operation_code_cascade_and_preview` | **T0b, built.** Sample-code cascade to automatic operations, statement-level rollup-lock triggers on `physical_samples` and `manufacturing_operations`, `preview_operation_code()` |
| (none) | **T0d, built: no migration.** The importers write `sintering_run_number`; `finalize_fast_codes.py` retired. Migration 156 already back-filled the run numbers, and the rebuild measured as a no-op (see §6) |
| next free | T0e: `file_fingerprints`, the table and its indexes (was planned as 155) |
| later | T0f: `UNIQUE (pass_code)`, after the hand-fix |

Each has a working `migrate:down`, comments on every new table and column, and its checks in
`tests/phase1_schema.sh`. The latest live migration is `20261009000143`. Data-dictionary entries
for the new columns and tables.

## Risks and how each is checked

| Risk | Check |
|---|---|
| The SQL rule differs from the browser rule for existing machining codes, so automatic codes look "typed" | Before switching: run `operation_code_for` over the 84 non-imported machining rows and list every row whose stored code differs; the maintainer sees the list in review. |
| Deadlock with the rollup lock | Same lock order as `20261003000126` everywhere (rollup → sample row → counters), including the sample-code cascade (§4). Two-session tests: two renames on one sample; a sample-code edit against a new operation on the same sample. |
| The preview leaks a code the user cannot see | Codes are read through `ItemsService` as the user (§5); a test asks for a sample outside the user's visibility and expects 403. |
| A short ID clashes across tables | One registry (§1); a test forces the same 8 characters on a sample and an operation. |
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

The T0 worktree branches from `feat/explorer-restyle` **with `fix/restore-inline-param-meta`
merged in first**, so migration 143 and its test fix (`21790784`) are in the tree and the
`tests/phase1_schema.sh` edits do not conflict.

1. **T0a** short IDs + test codes (migrations 150-152), with tests.
2. **T0b** operation codes in Postgres + preview endpoint + the form box (155-158).
3. **T0c** Force dashboard / force-plotting changes and the Force App release.
4. **T0d** FAST importers feed the rule (built, no migration; the rebuild was a no-op).
5. **T0e** file fingerprints (next free) + the worker's back-fill + the force-file-standard update.
6. **T0f** UNIQUE on `pass_code`, after the maintainer's hand-fix.

Each stage: Opus migration review → backup of the touched tables → apply → Directus restart →
live check, as for the form fix (F2). Never `configure_all.sh` or `configure_directus.sql`.


## What N1 takes from this

The Tests index and the finder use `test_code`; the finder also matches `short_id` on samples,
operations and tests; record pages show the short ID with a copy button (built in N1/L1); the
sample label adds the short ID and a QR code (a `d1-report` change, in N1).
