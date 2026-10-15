# Data Dictionary — D1-Database Schema

Tables and columns carry native PostgreSQL `COMMENT`s (a rule for every
migration — see [`CONTRIBUTING.md`](../CONTRIBUTING.md)), and those comments are
the authoritative dictionary. Query them through the `v_schema_dictionary`
view (one row per column, with its table and column comments); it is also what
the text-to-SQL path builds its prompt from (ADR-0009).

This file is the human-readable map. The schema overview lists every table and
view the migrations create, as of `20260918000113`. The table details describe
the core entities as designed in Phase 1: those columns all still exist, but the
core tables have since gained typed parameter columns, people and campaign links
and more, so use `v_schema_dictionary` for the full column list.

> **LLM guidance:** Always consult `information_schema.columns` and
> `pg_description` for the authoritative column semantics. This document
> summarises the design intent.

---

## Schema overview

```
Reference tables (static / slow-changing)
  alloying_elements            periodic-table reference
  material_alloying_elements   M2M: elemental composition of each alloy
  material_iso_classifications ISO 513 P/M/K/N/S/H groups
  materials                    alloy catalogue (alloy_code → common_name)
  manufacturing_methods        process-type catalogue (method_code → method_name)
  facilities                   labs / centres that house equipment
  equipment                    machines and rigs
  manufacturers                manufacturer dropdown for equipment, tools, insert types
  tools                        tool holders
  insert_types                 cutting-insert catalogue
  etchants                     metallographic etchants (sample preparation)

People
  people                       anyone attributed on a record: operator, researcher, owner

Projects & campaigns
  projects                     research projects (e.g. AI4340)
  project_investigators        M2M: secondary investigators on a project
  campaigns                    machining trial or testing campaign under a project
  campaign_samples             M2M: samples in a campaign
  project_rollup               read-only cache of v_project_rollup, rebuilt by trigger

Record access (A1a)
  sample_access                who has access to a sample, by person (view / edit)
  operation_access             the same for a manufacturing operation (view / edit)
  test_access                  the same for a test session (view / edit)
  campaign_access              the same for a campaign (view / edit)
  project_access               the same for a project (view / investigator)
  sample_readers, operation_readers, test_readers, campaign_readers, project_readers, campaign_sample_readers
                               derived: which login may read each record (kept by triggers; never edited)
  operation_open_to_all        derived: the ownerless operations every member may read

Labels
  label_templates              printable label layouts (sheet or roll) for the Explorer labels page
  label_settings               singleton: the lab contact email printed into every label's QR code

Batches
  batches                      a job done on several samples together (B-0001, ...); manufacturing_operations and test_sessions point at it with batch_id

Raw-material provenance
  raw_stock_lots               inbound material ledger

Tooling hierarchy (3 levels)
  tool_boxes                   grandparent: storage container
  cutting_inserts              parent: individual multi-edged insert
  insert_edges                 child: discrete cutting point

Core sample lifecycle
  physical_samples             central entity (dual identity: UUID + sample_code)
  sample_genealogy             self-referential parent-child lineage
  sample_stock_provenance      sample ↔ raw_stock_lots (many-to-many)
  sample_co_owners             M2M: co-owning Directus users

Operations & tests
  manufacturing_operations     unified operation log; typed per-process parameter columns
  test_sessions                experimental trial ledger; typed per-test parameter columns
  test_sessions_subject        M2A: what a test targets (sample, insert edge, …)

Sample preparation
  prep_recipes                 reusable preparation recipe
  prep_recipe_steps            the ordered steps of a recipe
  prep_steps                   the editable steps of one preparation operation

Files & archive links
  operation_data_files         M2M: File Library files ↔ operations
  sample_data_files            M2M: File Library files ↔ samples
  session_data_files           M2M: File Library files ↔ test sessions
  operation_files              network-share path links on an operation
  archive_metadata_edits       audit trail of in-place edits to archive-file metadata

Machining force analysis
  machining_force_analysis     per-.mat results: metrics, FRM, octrees, diagnostics state
  force_crawler_state          singleton control/status row for the force-crawler daemon
  filter_profiles              named FRM filter-chain library
  tool_setup                   dynamometer mount geometry + H-matrix FRF correction
  diag_recipes                 named diagnostics recipe library
  diag_layer                   hand-painted mask / label / seed polygons for diagnostics

FAST sintering
  fast_run_data                normalised sintering trace per operation
  fast_recipes                 FAST 25 / 250 recipe definitions

Cross-cutting
  audit_logs                   append-only immutable change log

AI-readiness (Phase 6 — text-to-SQL & semantic search)
  semantic_embeddings          pgvector store for note text (HNSW cosine index)

Views (v_ prefix — LLM query targets)
  v_complete_sample_history  flat sample + material + project
  v_tooling_hierarchy        3-tier tooling denormalized
  v_sample_genealogy_flat    parent-child pairs
  v_manufacturing_operations_full  ops + method + tooling + project
  v_stock_provenance         sample ← raw stock lots
  v_test_sessions_full       sessions + sample + tooling + project
  v_project_rollup           everything used in a project, direct or via a campaign
  v_schema_dictionary        table/column COMMENTs as a queryable dictionary
  v_llm_query_targets        allow-list menu of views the LLM may query
  v_embeddings_source_notes  every embeddable note (embedding backfill source)

Private schema (not exposed)
  d1_private.*               migration bookkeeping that is not data: the Lab Member permission rows
                             migration 141 saved and the aliases it added (its down restores and
                             drops them). Not in this dictionary, not exposed by Directus (outside
                             its schema scan), not granted to the LLM role.
  d1_private.process_drafts, d1_private.process_templates
                             the process map's edit mode (migration 190, ADR-0018): a person's
                             unfinished build (DraftBody JSON, private to its owner, deleted when
                             created) and saved templates for new operations and tests (private,
                             role or global scope). Reached only through the d1-build endpoint.
  d1_private.file_candidates, inbox_dirs, inbox_scan_requests, inbox_crawler_state, inbox_prefs
                             found files and the Inbox (migration 193, ADR-0020): files the inbox
                             crawler found in people's and teams' folders on the share, its folder
                             cache, its scan queue, its control row and the auto-link opt-in. Reached
                             only through the d1-inbox endpoint and the crawler; see "Found files".
```

---

## Dual identifier pattern

Every primary entity uses two identifiers:

| Identifier | Column | Type | Purpose |
|---|---|---|---|
| Hidden permanent PK | `sample_id`, `insert_id`, `edge_id`, … | UUID | All FK references; never changes; never displayed |
| Human-readable pseudonym | `sample_code`, `insert_code`, `edge_code`, … | TEXT UNIQUE | Displayed; printed on labels; regenerable from FK + parameter data |

The pseudonym is generated by one of the `generate_*` functions and is
**unique-constrained but never the primary key**. It can be re-derived from
the underlying data if the column is ever corrupted.

**Short IDs.** Samples, operations and tests also carry `short_id`: the first 8 hex characters of
the UUID (more only after a clash), unique across the three tables through the `short_ids`
registry, never changed and never reused. It is the handle for labels, the finder and notes; the
readable codes (`sample_code`, `pass_code`, `test_code`) may change when their fields do. A CHECK
on each of the three tables (`*_short_id_format_check`, migration `…155`) keeps `short_id` at
8-32 lower-case hex characters, so the empty column default can never be stored.

---

## Table details

### `physical_samples`

The central entity. Everything else points to or from here.

| Column | Type | Description |
|---|---|---|
| `sample_id` | UUID PK | Hidden permanent primary key |
| `sample_code` | TEXT UNIQUE | Human-readable pseudonym, e.g. `10-AA-MF-2023-06-03` |
| `short_id` | TEXT UNIQUE | Permanent short ID (8+ hex characters of `sample_id`), unique across samples, operations and tests. Never changes; printed on labels. Assigned by trigger (migration `…150`) |
| `material_id` | UUID FK | References `materials.material_id` |
| `project_id` | UUID FK | References `projects.project_id` |
| `form` | TEXT | Physical form (the Geometry dropdown): disc, ring, cylinder, block, plate, bar, round_bar, tensile_coupon, bend_bar, powder, other |
| `mass_grams` | NUMERIC(12,4) | Current mass in grams |
| `diameter_mm` | NUMERIC(10,4) | Outer diameter in mm |
| `inner_diameter_mm` | NUMERIC(10,4) | Bore diameter in mm of a `ring`-form sample; must be below `diameter_mm` (migration `…162`) |
| `length_mm` | NUMERIC(10,4) | Length in mm |
| `thickness_mm` | NUMERIC(10,4) | Thickness in mm |
| `current_status` | TEXT | Lifecycle: active \| consumed \| destroyed \| archived \| planned. `planned` (migration `…185`, ADR-0019) = a sample a planned operation is going to make; it has its final code already and turns `active` when that operation is marked done. Filters that mean "exists physically" use `active` |
| `manufactured_date` | DATE | Date sample was produced |
| `export_controlled` | BOOLEAN | ITAR/ECJU flag; drives RBAC visibility |
| `owner_person_id` | UUID FK | References `people.person_id`; the owner. Owner and co-owners may edit the sample; only the owner may delete it ([ADR-0011](adr/0011-row-level-visibility.md)) |
| `co_owners_legacy` | TEXT | Legacy comma-separated co-owner e-mails from the AppSheet import (renamed from `co_owners`, migration `…140`). The live co-owners are the `sample_co_owners` rows, shown in Directus as the `co_owners` M2M field. Absent on databases that already dropped the column |
| `restricted` | BOOLEAN NOT NULL DEFAULT false | Restricted record (migration `…165`, see "Record access" below). Hidden and read-only in Directus; changed only by the record-access endpoint |
| `version` | INTEGER | OCC version counter (incremented by trigger on UPDATE) |
| `updated_at` | TIMESTAMPTZ | Auto-updated by OCC trigger |

**Code generation:** `generate_sample_code(seq, alloy_code, method_code, date)`
→ `{seq}-{alloy}-{method}-{YYYY-MM-DD}`

**Numbers are assigned by the database** (migrations `…126`, `…127`; `next_sample_code_number()` is the read-only preview function the Register sample page uses, served by the `d1-next-number` endpoint). The Directus
interfaces send a sample code whose number part is the literal placeholder `{seq}`; a BEFORE
trigger replaces it with the next free number under an advisory lock, so concurrent
registrations never collide. A sample code without a placeholder is stored as given. This
paragraph is about samples only: operation codes and `operation_sequence` are built by a
different trigger with different rules (see "Operation codes" under `manufacturing_operations`).

---

### `manufacturing_operations`

Unified log of every manufacturing step performed on a sample. Replaces the
separate `FAST Runs` and `Machining Operations` spreadsheet tabs.

| Column | Type | Description |
|---|---|---|
| `operation_id` | UUID PK | |
| `sample_id` | UUID FK | The sample operated on |
| `method_id` | UUID FK | References `manufacturing_methods` |
| `project_id` | UUID FK | Optional project grouping |
| `equipment_id` | UUID FK | Machine used |
| `tool_id` | UUID FK | Tool holder used |
| `insert_edge_id` | UUID FK | Cutting edge consumed |
| `operator_name` | TEXT | Legacy free-text operator; `operator_person_id` → `people` supersedes it |
| `operation_sequence` | INTEGER | Ordering of this operation within the sample lifecycle (1 = first); the number in its code. Left NULL on insert it is assigned by the database as max+1 for the sample (not for imported rows, `source_system` set); a supplied value (e.g. a machining pass number) is kept. An automatic operation that moves to another sample or method gets the next number there. Existing machining operations were numbered where the number could be read from the stored code (migration `…157`, ledger `d1_private.operation_sequence_backfill`); codes like N/R, or a number already taken by the same letter on that sample, stay without a sequence |
| `pass_code` | TEXT | Human-readable operation code, e.g. `TEST-S-F2-30MPM_0.1feed_1DoC` or `22-04-21-MF25-4624-950C_11kN_20dia`. Kept up to date by the database from the operation's fields (`operation_code_for`) unless a person typed a different one; clear it to make it automatic again (not for experiment-sheet rows, whose code is fixed). Not the PK. See "Operation codes" below |
| `sintering_run_number` | INTEGER (> 0), nullable, no default | FAST/SPS run number as the machine shows it (typed on a hand-logged operation, read from the machine file by the importer). Part of the sintering code; never invented. Unique per machine: the unique index `manufacturing_operations_sintering_run_unique` on (`equipment_id`, `sintering_run_number`) covers sintering rows that have a run number and an equipment set. Added by migration `…156` |
| `short_id` | TEXT UNIQUE | Permanent short ID (8+ hex characters of `operation_id`), unique across samples, operations and tests. Never changes. Assigned by trigger (migration `…150`) |
| `operation_date` | TIMESTAMPTZ | When the operation ran; empty while the operation is planned |
| `work_state` | TEXT NOT NULL DEFAULT `'done'` | `planned` \| `done` (migration `…185`, ADR-0019). Every record made before planning existed, and every record a form or importer writes without it, is `done`. Set to `done` by Mark done (`d1-build`), which also sets `operation_date`, `done_by_person_id`, `done_at` and turns the planned output samples `active`. Done back to planned is refused by `d1-access-guard` unless the caller owns the record or is an admin. Reports and counts of "what was done" filter `work_state = 'done'` |
| `planned_date` | DATE | The day the operation is meant to happen (planned work); `operation_date` stays the day it happened |
| `done_by_person_id` | UUID FK | `people`, ON DELETE SET NULL: who marked it done (Mark done); NULL for planned operations and ones recorded as done directly |
| `done_at` | TIMESTAMPTZ | When it was marked done; NULL for planned operations and ones recorded as done directly |
| `recorded_metadata` | JSONB | Method-specific parameters as designed in Phase 1 — now superseded by typed columns (below) |
| `capture_software` | TEXT | e.g. `MATLAB ABFP 0.18` — needed to interpret force files |
| `capture_frequency_khz` | NUMERIC(10,4) | Sampling frequency in kHz (e.g. 25.6) |
| `file_storage_pointer` | TEXT | MinIO S3 URI to raw data file |
| `force_file_id` | TEXT | Human-readable force-file label |
| `nc_program_text` | TEXT | Inline G-code |
| `nc_program_file_uri` | TEXT | MinIO URI for G-code artifact |

**JSONB key conventions for `recorded_metadata`:**

FAST (MF): `peak_temperature_celsius`, `hold_time_minutes`, `applied_pressure_mpa`,
`atmosphere`, `heating_rate_celsius_per_min`, `die_material`, `recipe_name`

CNC Turning (MC): `cutting_speed_m_per_min`, `feed_rate_mm_per_rev`,
`depth_of_cut_mm`, `max_spindle_rpm`, `coolant_type`, `coolant_pressure_bar`,
`chips_collected`, `new_edge_used`

Since migration `20260623000032_inline_param_fields.sql`, parameters are typed
inline columns instead, prefixed by process and shown according to
`process_category`: `machining_*`, `sintering_*`, `ht_*` (heat treatment),
`deform_*` and `am_*` (additive). The `method_parameters` registry that described
the JSONB keys was dropped in `20260626000039`.

`process_category` comes from `manufacturing_methods.process_category` (migration
`…129`): a BEFORE trigger fills it on insert, or when the method changes, if the write
does not set it. Applying a prep recipe (`prep_recipe_id` on a Sample Preparation
operation) copies its steps in an AFTER trigger in the same transaction.

**Operation codes (T0b, migrations `…155`-`…158`).** The code rule lives in Postgres:
`operation_code_for(manufacturing_operations, sample_code TEXT)` returns the code the rule gives
for a row and its input sample's code (`NULL` when none can be built, e.g. sintering without a
run number). The machining token drops a two-letter method prefix (`MT-F` gives `F`), as in every
stored code. `code_num(NUMERIC)` writes a number as the codes do: 6 significant digits, no
trailing zeros (`80` gives `80`, `0.05` gives `0.05`). The BEFORE trigger `mfg_op_set_code`
(`trg_mfg_op_set_code()`, replacing migration 126's number trigger) keeps `pass_code` equal to the
rule for operations whose code is automatic: empty, an old client's `{seq}`/`{mf}` placeholder,
or equal to the rule's value for the row before the change. A code a person typed is kept as
written; clearing it makes the operation automatic again. A new operation takes the next
`operation_sequence` for its sample (under the rollup lock and the sample row), and an automatic
one that changes sample or method is renumbered. Experiment-sheet rows (`source_system =
'experiment_sheet'`) are frozen: never renamed automatically, and their code cannot be cleared
(clearing it, or writing a placeholder, keeps the saved code); a person can still type a new one.
When a sample's `sample_code` changes, the AFTER trigger `trg_cascade_operation_codes()` rewrites
the codes of its automatic operations with the new sample code, keeping their numbers; typed and
experiment-sheet codes are left alone. To keep lock order the same everywhere (rollup lock, then
the sample row), statement-level triggers on `physical_samples` (UPDATE, DELETE) and
`manufacturing_operations` take the rollup advisory lock first. `preview_operation_code(values
JSONB, operation_id UUID, sample_code TEXT)` is the read-only preview the form box uses (served
by `POST /d1-next-number/operation-code`, which authorises the operation and the sample as the
user and answers `{code, frozen}`): it returns what the rule would give (even for a typed or frozen
operation, which the trigger stores as written), writes nothing, and does not check access
itself, so its caller must (a) authorise the operation as the user (read it through Directus
`ItemsService`) and (b) pass the code of the merged row's sample as `sample_code`.

---

### `test_sessions`

Experimental trial ledger. A session maps to one raw data file in MinIO.
The async heavy-data worker (Phase 4) populates `summary_stats` and `plot_uris`
after parsing.

| Column | Type | Description |
|---|---|---|
| `session_id` | UUID PK | |
| `short_id` | TEXT UNIQUE | Permanent short ID (8+ hex characters of `session_id`), unique across samples, operations and tests. Never changes. Assigned by trigger (migration `…150`) |
| `test_code` | TEXT UNIQUE | Readable test code, `{subject code}-{TYPE}{n}` (e.g. `116-RK-MH-2024-12-18-SEM1`). Assigned by the database when the first subject is linked; follows the subject and type unless typed by hand (`test_code_is_manual`) (migration `…152`) |
| `test_code_number` | INTEGER | The n of an automatic `test_code`, drawn from `test_code_counters`. The `test_code_*` bookkeeping columns belong to the trigger: reset on INSERT, ignored on UPDATE (a copied test does not inherit them) |
| `test_code_type` | TEXT | The `test_type` the current number was drawn for; a different `test_type` draws a new number |
| `test_code_is_manual` | BOOLEAN | True when `test_code` was written by a person: it is then kept as written. Clearing `test_code` sets it back to false |
| `test_code_subject_collection` | TEXT | Kind of subject the automatic code is built on: `physical_samples` or `insert_edges` |
| `test_code_subject_id` | UUID | The subject the automatic code is built on (`sample_id` or `edge_id`; no FK, the subject may be removed and the code kept) |
| `sample_id` | UUID FK | Primary sample under test: derived from `test_sessions_subject` by a trigger (migration `…139`); do not write directly |
| `equipment_id` | UUID FK | Test rig used |
| `insert_edge_id` | UUID FK | Primary cutting edge involved (machining tests): derived from `test_sessions_subject`; do not write directly |
| `project_id` | UUID FK | Optional project grouping |
| `test_type` | TEXT | e.g. force_measurement, microstructure, hardness |
| `capture_software` | TEXT | Data-capture app + version |
| `capture_frequency_khz` | NUMERIC | Sampling rate (required to decode raw files) |
| `file_storage_pointer` | TEXT | MinIO URI (10–100 GB files) |
| `file_size_gb` | NUMERIC | File size in GB as reported by client |
| `summary_stats` | JSONB | Written by worker: min/max/mean forces, etc. |
| `plot_uris` | JSONB | JSON array of MinIO URIs for rendered plots |
| `status` | TEXT | Pipeline state: registered \| pending_processing \| processing \| processed \| analysing \| analysed \| failed (migration `…013`). Not whether the test was carried out: that is `work_state` |
| `work_state` | TEXT NOT NULL DEFAULT `'done'` | `planned` \| `done` (migration `…185`, ADR-0019): whether the test was carried out. A planned test has nothing for the pipeline to process yet. Set to `done` by Mark done (`d1-build`); done back to planned is refused by `d1-access-guard` unless the caller owns the record or is an admin |
| `planned_date` | DATE | The day the test is meant to happen (planned work); `session_date` stays the day it happened |
| `done_by_person_id` | UUID FK | `people`, ON DELETE SET NULL: who marked it done; NULL for planned tests and ones recorded as done directly |
| `done_at` | TIMESTAMPTZ | When it was marked done; NULL for planned tests and ones recorded as done directly |

Since Phase 1: what a test targets is recorded through the `test_sessions_subject`
M2A junction (a sample, an insert edge, …). `sample_id` and `insert_edge_id` are a
denormalised *primary subject*: since migration `…139` a trigger on the junction sets
them to the earliest linked (by `linked_at`, ties by junction id) `physical_samples` / `insert_edges` subject, so
form-created tests are found by readers that filter on `sample_id`. A test with several
samples shows only the first there; read the junction for all of them. The migration's
back-fill copies a direct `sample_id` / `insert_edge_id` into the junction only for a test with no
junction row of that kind, and never one that the audit log shows was removed from the test. Deleting a
sample no longer cascades to its tests (migration `…139`): the sample leaves each test's
subject list and the next sample becomes primary; a test is deleted with the sample only when
that was its last subject (no other sample, no insert edge). Deleting an insert edge that a
test names, in the junction or in `insert_edge_id`, is refused with "… is the subject of test
<id>; remove it from the test first", and so is deleting a cutting insert or tool box whose
cascade reaches such an edge: remove the edge from the test first. Typed per-test
parameters are inline columns prefixed by test type (`tensile_*`, `hardness_*`, `sem_*`,
`xrd_*`, …).

`test_sessions_subject` has one added column, from migration `…151`, which also changes the rule
above: the primary subject is the earliest linked one, not the lowest junction id.

| Column | Type | Description |
|---|---|---|
| `linked_at` | TIMESTAMPTZ NOT NULL | When this subject was linked to the test. The earliest valid subject is the test's primary subject (`sync_test_session_primary_subject`). Rows linked before this column existed carry `-infinity`, so among them the lowest junction id wins (the previous rule) |

**Test codes** (migration `…152`): the database builds `test_code` from the test's primary
subject and `test_type`, and a trigger keeps it current. A corrected sample or edge code flows into
its tests' automatic codes; a manual code is left as written.

---

### `short_ids`

Registry of permanent short IDs (first 8+ hex characters of the record UUID) for
`physical_samples`, `manufacturing_operations` and `test_sessions`. Unique across the three tables;
rows are never deleted, so an ID is never reused. Bookkeeping: written only by `claim_short_id()`
(migration `…150`).

| Column | Type | Description |
|---|---|---|
| `short_id` | TEXT PK | The short ID: lower-case hex, 8 characters, more only after a clash |
| `collection` | TEXT | Which table the record is in |
| `record_id` | UUID | The record's primary key (`sample_id`, `operation_id` or `session_id`). The record may since have been deleted |
| `created_at` | TIMESTAMPTZ | When the short ID was assigned |

`UNIQUE (collection, record_id)`: one short ID per record. `record_by_short_id(text)` resolves an
ID back to its record.

---

### `test_code_counters`

Bookkeeping for test codes: the last number handed out per (subject, test type), so a number is
never handed out twice. Written only by `next_test_code_number()`; no OCC or audit (no user edits
it) (migration `…152`).

| Column | Type | Description |
|---|---|---|
| `subject_collection` | TEXT | `physical_samples` or `insert_edges` |
| `subject_id` | UUID | The sample or edge (no FK: the counter outlives a deleted subject, which keeps numbers from being reused) |
| `test_type` | TEXT | The `test_type` the numbers are for |
| `last_number` | INTEGER | The highest number handed out so far |

Primary key `(subject_collection, subject_id, test_type)`.

---

### `file_fingerprints`

Content hashes of Directus files, one row per file (migration `…159`, stream T0e). Derived data,
recomputable from the file: written only by `scripts/file_fingerprints.py` on the host that can read
the share; no audit trigger. It gives a file an identity that survives renames, copies and a
metadata-only edit of a `.mat` file. Rows are deleted with their file (`ON DELETE CASCADE`).

| Column | Type | Description |
|---|---|---|
| `directus_files_id` | UUID PK | The file (`directus_files.id`). One fingerprint per file |
| `status` | TEXT NOT NULL | `done` (default): read, `content_sha256` set. `error`: found but could not be (fully) read or decoded, see `error_message`. `missing`: not on the share |
| `content_sha256` | TEXT | SHA-256 (64 lower-case hex) of the whole file, byte for byte. Required when `status` is `done` |
| `data_sha256` | TEXT | `.mat` force files only: SHA-256 of the decoded force array, **not** of the bytes on disk. Taken over the array's MATLAB shape as two little-endian uint64 (rows, cols), then, for each column in order, the 32-byte SHA-256 digest of that column's values as little-endian float64, top to bottom (each column is hashed on its own, so a chunked file is read in one pass). The variable read is `data` when present, else `DATA`. A metadata-only edit of the file keeps it |
| `data_variable` | TEXT | `data` or `DATA`: the variable `data_sha256` was taken from |
| `data_rows` | BIGINT | Rows of that array (the first shape value hashed) |
| `data_cols` | BIGINT | Columns of that array (the second shape value hashed) |
| `size_bytes` | BIGINT | The `directus_files.filesize` the hash was taken against (staleness key) |
| `source_mtime` | TIMESTAMPTZ | The modification time the hash was taken against: the share mtime from `directus_files.metadata.modified`, else `modified_on` (staleness key) |
| `error_message` | TEXT | Why the file could not be (fully) hashed. A message starting `permanent: ` (then the error class, e.g. `permanent: NoForceArray: …`) marks a file that was read but is not a usable `.mat` force file; the script re-reads it only when its staleness key changes or with `--retry-permanent`. Every other `error` (and every `missing`) is retried on each run unless `--skip-failed` |
| `hashed_at` | TIMESTAMPTZ | When the row was last computed |

Indexes: `file_fingerprints_content_idx` on `content_sha256` (duplicate and copy detection);
`file_fingerprints_data_idx` on `data_sha256`, partial (`WHERE data_sha256 IS NOT NULL`).
`CHECK`s: both hashes are 64 lower-case hex characters; `status = 'done'` needs a `content_sha256`.

---

### Found files and the Inbox: `people.uni_alias`, `teams.share_folder`, `d1_private.file_candidates` and friends

Migration `…193` ([spec](superpowers/specs/2026-10-15-found-files-inbox-design.md) section 4,
[ADR-0020](adr/0020-inbox-crawler-read-only-allow-listed.md)). The inbox crawler lists each person's folder
(`Users/<uni alias>`) and each team's folder (`Shared/<share folder>`) on the lab share, registers new files and
tags what they look like and which record they name; people link them in STARbase's Inbox. The five tables are in
`d1_private`: not exposed by Directus (candidates are never readable through its REST API), not in
`v_schema_dictionary`, not granted to the LLM role, no audit or OCC triggers (derived bookkeeping; the link is
audited on its junction row). Files stay on the share.

**New columns on existing tables** (set by an administrator with an UPDATE: kept out of the Lab Member `people` update field list, and a `BEFORE INSERT` trigger on `people` refuses a new row that sets `uni_alias` or `scan_while_former`, so a Lab Member cannot create a person that squats on a folder name)

| Column | Type | Description |
|---|---|---|
| `people.uni_alias` | TEXT, nullable | Name of the person's personal folder under `Users/`. 2 to 64 of letters, digits, `.`, `_`, `-`, never only dots. Unique ignoring case (`people_uni_alias_key`) |
| `people.scan_while_former` | BOOLEAN NOT NULL | Default false. True: keep scanning the folder after the person is inactive |
| `teams.share_folder` | TEXT, nullable | Name of the team's folder under `Shared/`: no `/` or `\`, not blank, not only dots. Unique ignoring case (`teams_share_folder_key`) |

**`d1_private.file_candidates`**: one row per found file, until linked, dismissed or gone. `directus_files_id` is
unique and cascades; owner is exactly one of `owner_person_id` / `owner_team_id` (both cascade).

| Column | Type | Description |
|---|---|---|
| `candidate_id` | UUID PK | Surrogate key |
| `directus_files_id` | UUID NOT NULL UNIQUE FK | The `directus_files` pointer row (`storage = 'star'`) |
| `owner_person_id`, `owner_team_id` | UUID FK | Whose folder it was found in; exactly one is set |
| `kind` | TEXT NOT NULL | `sem_image` (possible SEM image), `surface_scan` (`.al3d`), `image`, `document`, `other`. Documents and others are never opened before a person links them |
| `kind_confidence` | NUMERIC(4,3) | Classifier confidence, 0 to 1; NULL when none ran |
| `extracted` | JSONB NOT NULL | JSON object of what was actually read (kV, magnification, ...); `{}` when nothing |
| `origin` | TEXT NOT NULL | `new` (found after the owner's first complete scan) or `backlog` (found during it: "Older files") |
| `state` | TEXT NOT NULL | `new` (default), `linked`, `dismissed`, `gone` |
| `match_strength` | TEXT NOT NULL | Strongest way the path names a record: `short_id`, `code`, `edge_code`, `none` (default) |
| `matches` | JSONB NOT NULL | JSON array of `{collection, record_id, via, token}` at the strongest level |
| `suggested_collection`, `suggested_record_id` | TEXT, UUID | The single record named; both set or both NULL. NULL when two or more match |
| `duplicate_of` | UUID FK (self) | Earlier candidate with the same content hash; `ON DELETE SET NULL` |
| `rel_path` | TEXT NOT NULL | Path relative to the share root (`star_group1`) |
| `size_bytes`, `source_mtime` | BIGINT, TIMESTAMPTZ | Size (>= 0) and modification time when found |
| `first_seen_at`, `decided_at`, `decided_by` | TIMESTAMPTZ, TIMESTAMPTZ, UUID FK | First seen; when and by which Directus user (`ON DELETE SET NULL`) it was linked or dismissed |
| `link_kind`, `linked_collection`, `linked_junction_id`, `link_batch_id` | TEXT, TEXT, UUID, UUID | Undo bookkeeping: `manual` / `bulk` / `auto`, the record collection, the junction row created, the batch one Undo removes. All four are set when `state = 'linked'` and all NULL otherwise (two CHECKs), so an undo clears all four with the state; `linked_collection` has no list, so a later link target needs no migration |
| `adopted_at` | TIMESTAMPTZ | Set when a document or other non-image file is linked: the crawler then reads it once and hashes it |

Indexes: `(owner_person_id, state)`, `(owner_team_id, state)`; partial on not-null: `(link_batch_id)`,
`(suggested_record_id)`, `(duplicate_of)`, `(adopted_at)`.

**When an alias or share folder changes** (triggers `people_inbox_alias_changed`, `teams_inbox_folder_changed`,
only when the value really changes, `NULL` included): that owner's `inbox_dirs` rows and their `file_candidates` in
state `new`, `gone` and `dismissed` are deleted; `linked` candidates are kept. The next scan is a first scan of the
new folder (everything is backlog).

**`d1_private.inbox_dirs`**: the folder cache. `rel_path` PK; one owner (person or team, cascade); `dir_mtime`,
`last_listed_at`; `baselined_at` is set on an owner's root row when their first complete scan ends.

**`d1_private.inbox_scan_requests`**: the queue behind "Rescan my folder" and "Scan all". `scope`
(`person` / `all`; `person_id` required exactly for `person`), `requested_by`, `requested_at`, `started_at`,
`finished_at`, `status` (`queued` default, `running`, `done`, `failed`), `error`. Indexes `(status, requested_at)`
and partial `(person_id, requested_at DESC)`.

**`d1_private.inbox_crawler_state`**: singleton (id `00000000-0000-0000-0000-000000000001`, seeded). Admin
settings `desired_state` (`running` default / `paused`), `interval_minutes` (default 30), `read_mb_per_s` (default
60); daemon status `last_heartbeat_at`, `daemon_started_at`, `current_activity`, `last_scan_started_at`,
`last_scan_finished_at`, `files_registered`, `error_count`, `last_error`; `unmatched_folders` (JSON array of
share-relative paths of folders under `Users/` and `Shared/` that match nobody, rewritten each scan); `updated_at`.

**`d1_private.inbox_prefs`**: `user_id` (PK, FK `directus_users`, cascade), `auto_link` (BOOLEAN NOT NULL, default
false: the person's opt-in to auto-linking exact short-ID matches of images and surface scans), `updated_at`.

---

### Record access: `sample_access`, `operation_access`, `test_access`, `campaign_access`, `project_access`

Who has access to one record, by person (migration `…165`, A1a; spec
`docs/superpowers/specs/2026-10-12-record-access-design.md`). There is one table per record type so
that each parent has its own hidden `access` list for the Directus row filters. Keyed by **person**
(`people.person_id`), not by login, so a person with no login can be listed; the grant starts working
when an admin links the login (`people.user_id`). The five tables have the same shape. They are
written only through the record-access endpoint and are audited (migration `…121` trigger); they have
no OCC `version`. In A1a they are stored and hidden in Directus; the rules that read them arrive in
later migrations, so until then they change nothing anyone can see.

| Column | Type | Description |
|---|---|---|
| `access_id` | UUID PK | Surrogate key (`gen_random_uuid()`) |
| `sample_id` / `operation_id` / `session_id` / `campaign_id` / `project_id` | UUID NOT NULL FK | The record (`physical_samples`, `manufacturing_operations`, `test_sessions`, `campaigns`, `projects`), named per table. `ON DELETE CASCADE`: the list goes with the record |
| `person_id` | UUID NOT NULL FK | References `people.person_id`. `ON DELETE CASCADE`: a deleted person's grants go with them |
| `role` | TEXT NOT NULL | `view` or `edit`; in `project_access` `view` or `investigator` (a secondary investigator) |
| `added_by_person_id` | UUID FK | Who made the grant; `ON DELETE SET NULL` |
| `created_at` | TIMESTAMPTZ NOT NULL | When the grant was made (default `now()`) |

`UNIQUE (<record column>, person_id)`: a person is listed once per record. Index `<table>_person_idx`
on `person_id`. `CHECK` on `role` as above (`<table>_role_check`). Directus: each table is a hidden
collection; each parent has a hidden O2M alias `access` over its list, and `person_id` is a relation
to `people` with no alias. The existing `sample_co_owners` and `project_investigators` stay honoured
beside these (decision 17 of the spec).

**`restricted`** (also migration `…165`): `BOOLEAN NOT NULL DEFAULT false` on `physical_samples`,
`manufacturing_operations`, `test_sessions`, `campaigns` and `projects`, each with a partial index
`idx_<table>_restricted ... WHERE restricted`. The default keeps every existing record unrestricted
and stops Directus from treating the column as required. A hidden, read-only Directus field; no
interface shows or changes it in A1a.

### Readers tables (derived): `sample_readers`, `operation_readers`, `test_readers`, `campaign_readers`, `project_readers`, `campaign_sample_readers`, `operation_open_to_all`, and `d1_private.hidden_records`

Who can **read** each record, stored (migration `…166`, A1a; ADR-0014). They are derived data: the SQL function family
`d1_private.readers_of_<type>()` states the rule, the tables hold its answer, statement triggers on every input table recompute
what a write could change, and the Directus read rule of the five record types is one membership test on the table. Nothing writes
them by hand; the dumps leave their data out and a restore ends with `d1_private.readers_rebuild()`.
`d1_private.readers_drift()` lists every row where a table and its function disagree (empty is correct), `readers_drift_count()` counts them
(the admin overview shows it, `scripts/a1_readers_drift_check.sh` logs it).

| Table | Columns | Meaning |
|---|---|---|
| `sample_readers`, `operation_readers`, `test_readers`, `campaign_readers`, `project_readers` | `reader_id` BIGINT identity PK, `record_id` UUID FK (`ON DELETE CASCADE`), `user_id` UUID FK to `directus_users` (`ON DELETE CASCADE`), `UNIQUE (record_id, user_id)` | This login may read this record. Keyed by **login**, not person; admins are not listed |
| `campaign_sample_readers` | the same, `record_id` is a `campaign_samples.id` | Who may read the junction row |
| `operation_open_to_all` | `reader_id` identity PK, `record_id` UUID UNIQUE FK to `manufacturing_operations` | The ownerless runs every member may read (the narrowed orphan amnesty) |
| `d1_private.hidden_records` | `kind` TEXT (`physical_samples`, `manufacturing_operations`, `test_sessions`, `campaigns`, `projects`), `record_id` UUID, primary key `(kind, record_id)` | The records the Ask-the-database role must not see: restricted, or under a restricted project, campaign or sample. Read through `d1_private.is_hidden(kind, id)` (SECURITY DEFINER) by the role's row-level-security policies of migration `…168`; not granted to any role |

The public tables are hidden Directus collections and are not audited. They are listed in `v_schema_dictionary` like every public table, but `d1_llm_readonly` has no grant on them (and the plugin filters its prompt by privilege), so Ask-DB never offers or reads them.

---

### `raw_stock_lots`

Inbound material ledger — new entity with no equivalent in legacy AppSheet data.
Provides the "raw material → sample" provenance link (currently a free-text field).

| Column | Type | Description |
|---|---|---|
| `lot_id` | UUID PK | |
| `lot_code` | TEXT UNIQUE | Human-readable lot ID |
| `stock_type` | TEXT | swarf \| powder \| billet \| chemical \| other |
| `material_id` | UUID FK | References `materials` |
| `supplier_name` | TEXT | Supplier / vendor name |
| `inbound_mass_grams` | NUMERIC | Total received mass in grams |
| `remaining_mass_grams` | NUMERIC | Current remaining mass in grams |
| `mesh_size_micrometres` | NUMERIC | For powders: particle size |
| `purity_percent` | NUMERIC | For chemicals/powders: purity 0–100 |
| `certificate_url` | TEXT | URI to material certificate in MinIO |
| `export_controlled` | BOOLEAN | ITAR/ECJU flag |

---

### `audit_logs`

Append-only; every core-table mutation produces one row. Protected by
`NO UPDATE / NO DELETE` rules.

| Column | Type | Description |
|---|---|---|
| `log_id` | BIGSERIAL PK | Monotonically increasing |
| `event_timestamp` | TIMESTAMPTZ | Exact time of mutation |
| `table_name` | TEXT | Source table name |
| `record_id` | TEXT | PK value of the affected row |
| `action_type` | TEXT | INSERT \| UPDATE \| DELETE |
| `actor_identity` | TEXT | User/token ID from `d1.actor_identity` GUC |
| `row_before` | JSONB | Full row before mutation (NULL for INSERT) |
| `row_after` | JSONB | Full row after mutation (NULL for DELETE) |
| `changed_fields` | JSONB | For UPDATE: `{col: {old: ..., new: ...}}` |

Since migration `…121` every business table is audited and `record_id` is the table's
own primary key (composite keys joined with `:`). `audit_logs` also refuses `TRUNCATE`
(`…120`). When a Directus API write could not set `d1.actor_identity` in its own
transaction, the actor is recorded from `directus_activity` into `audit_log_actors`
(`…128`); query **`v_audit_logs_with_actor`** for "who made this change".

---

### `semantic_embeddings`

pgvector store for unstructured note text (Phase 6 hybrid search). Derived,
rebuildable data — keyed for idempotent, incremental backfill — so **not**
audited. Source notes are defined by the `v_embeddings_source_notes` view.

| Column | Type | Description |
|---|---|---|
| `embedding_id` | UUID PK | Surrogate key |
| `source_table` | TEXT | Table the text came from (e.g. `physical_samples`) |
| `source_id` | UUID | PK of the source row |
| `source_column` | TEXT | Note column embedded (e.g. `notes`, `outcome_notes`) |
| `content_text` | TEXT | The exact text embedded (kept for re-rank/display) |
| `content_hash` | TEXT | SHA-256 of `content_text`; skips unchanged rows |
| `embedding` | VECTOR(768) | nomic-embed-text vector; HNSW cosine index |
| `model_name` | TEXT | Embedding model; part of the uniqueness key |

Unique on `(source_table, source_id, source_column, model_name)`.

---

## Naming conventions

- **Table names:** plural snake_case, e.g. `physical_samples`
- **PK column names:** `{singular_entity}_id` or descriptive (e.g. `symbol`, `iso_code`)
- **FK column names:** same as the referenced PK column
- **Boolean columns:** `is_*` prefix (e.g. `is_active`, `is_depleted`, `is_used`)
- **Timestamp columns:** `*_at` suffix, always `TIMESTAMPTZ`
- **Unit suffixes in column names:** `_celsius`, `_grams`, `_mm`, `_khz`, `_mpa`,
  `_m_per_min`, `_mm_per_rev`, `_bar`, `_rpm`, `_gb`, `_percent`, `_g_per_cm3`
- **Views:** `v_` prefix
- **Constraints:** `{table}_{description}_{type}` (e.g. `physical_samples_code_unique`)

---

## OCC concurrency pattern

All mutable tables carry `version INTEGER` and `updated_at TIMESTAMPTZ`.
The `occ_update_trigger_function` BEFORE UPDATE trigger increments `version`
and refreshes `updated_at` automatically.

API update pattern:
```sql
UPDATE physical_samples
SET    mass_grams = 449.02
WHERE  sample_id  = '<uuid>'
  AND  version    = 5;   -- client's known version
-- If 0 rows affected → conflict: another writer updated first.
```

---

## Security notes

- `export_controlled = TRUE` rows require elevated RBAC visibility (Phase 3).
- `audit_logs` has NO-OP UPDATE/DELETE rules — append-only enforced at DB level.
- Operator identity injected via `SET LOCAL d1.actor_identity = '...'` at
  session start, picked up by the audit trigger.
- Passwords must never be stored in this schema (use Directus or separate auth).
- **Text-to-SQL read surface (Phase 6):** the `d1_llm_readonly` role is granted
  `SELECT` on an explicit allow-list of lab tables and `v_*` views (migration `…132`) —
  never `audit_logs`, `people` or any `directus_*` table. It is `default_transaction_read_only` with a statement timeout.
  LLM-generated SQL is additionally validated by the plugin's SQL guard before it
  runs (ADR-0009, `docs/runbooks/text-to-sql.md`). The login role used by the
  plugin must inherit `d1_llm_readonly` and never be the superuser. Since migration `…168` row-level security hides restricted records
  (and everything under them) from that role and the granted views are `security_invoker` (ADR-0014); `d1_private.hidden_records` is not granted to it.
