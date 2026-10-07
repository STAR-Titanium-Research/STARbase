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

---

## Table details

### `physical_samples`

The central entity. Everything else points to or from here.

| Column | Type | Description |
|---|---|---|
| `sample_id` | UUID PK | Hidden permanent primary key |
| `sample_code` | TEXT UNIQUE | Human-readable pseudonym, e.g. `10-AA-MF-2023-06-03` |
| `material_id` | UUID FK | References `materials.material_id` |
| `project_id` | UUID FK | References `projects.project_id` |
| `form` | TEXT | Physical form: disc, billet, powder-compact, coupon |
| `mass_grams` | NUMERIC(12,4) | Current mass in grams |
| `diameter_mm` | NUMERIC(10,4) | Outer diameter in mm |
| `length_mm` | NUMERIC(10,4) | Length in mm |
| `thickness_mm` | NUMERIC(10,4) | Thickness in mm |
| `current_status` | TEXT | Lifecycle: active \| consumed \| destroyed \| archived |
| `manufactured_date` | DATE | Date sample was produced |
| `export_controlled` | BOOLEAN | ITAR/ECJU flag; drives RBAC visibility |
| `version` | INTEGER | OCC version counter (incremented by trigger on UPDATE) |
| `updated_at` | TIMESTAMPTZ | Auto-updated by OCC trigger |

**Code generation:** `generate_sample_code(seq, alloy_code, method_code, date)`
→ `{seq}-{alloy}-{method}-{YYYY-MM-DD}`

**Numbers are assigned by the database** (migrations `…126`, `…127`; `next_sample_code_number()` is the read-only preview function the Register sample page uses, served by the `d1-next-number` endpoint). The Directus
interfaces send a code whose number part is the literal placeholder `{seq}` (and, for
sintering pass codes, `{mf}`); a BEFORE trigger replaces it with the next free number
under a lock (an advisory lock for sample and MF numbers, a row lock on the sample for
operation numbers), so concurrent registrations never collide. A code without a
placeholder is stored as given. `manufacturing_operations.operation_sequence` is filled
the same way when it is NULL, except for imported rows (`source_system` set), which keep
a NULL sequence because importers number their own rows.

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
| `operation_sequence` | INTEGER | Ordering within sample lifecycle |
| `pass_code` | TEXT | Human-readable pass pseudonym, e.g. `9-AA-MR-2023-03-23-F9` |
| `operation_date` | TIMESTAMPTZ | When the operation ran |
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

---

### `test_sessions`

Experimental trial ledger. A session maps to one raw data file in MinIO.
The async heavy-data worker (Phase 4) populates `summary_stats` and `plot_uris`
after parsing.

| Column | Type | Description |
|---|---|---|
| `session_id` | UUID PK | |
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
| `status` | TEXT | Pipeline state: registered \| pending_processing \| processing \| processed \| analysing \| analysed \| failed (migration `…013`) |

Since Phase 1: what a test targets is recorded through the `test_sessions_subject`
M2A junction (a sample, an insert edge, …). `sample_id` and `insert_edge_id` are a
denormalised *primary subject*: since migration `…139` a trigger on the junction sets
them to the first (lowest junction id) `physical_samples` / `insert_edges` subject, so
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
  plugin must inherit `d1_llm_readonly` and never be the superuser.
