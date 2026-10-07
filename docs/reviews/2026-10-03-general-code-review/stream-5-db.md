# Stream 5 — `db/` migrations, seeds, schema tests (raw reviewer report)

The reviewer applied all 120 migrations to a throwaway Postgres 16 (up, full down, up; `pg_dump
-s` matched) and checked each migration's down/up individually, so findings are against the
final schema. The coordinator's checks are recorded in the consolidated report.

## Findings

1. **blocking — `20260629000051_project_rollup_table.sql` (`refresh_project_rollup()`, triggers
   `refresh_rollup_ops`, `refresh_rollup_campaigns`).** Every statement on
   `manufacturing_operations` or `campaigns` runs `DELETE FROM project_rollup` and re-inserts the
   whole view. Two concurrent writes to *different* operations fail: with A's update of op 1
   uncommitted, B's update of op 2 errors `duplicate key value violates unique constraint
   "project_rollup_pkey"` (reproduced). Also O(N) per statement → quadratic on bulk imports. Fix:
   `pg_advisory_xact_lock` at the top, or incremental/`ON CONFLICT` refresh, or a materialized
   view refreshed asynchronously.
2. **should fix — `v_manufacturing_operations_full`, `v_test_sessions_full`** (latest in
   `20261002000116_natural_code_collation.sql`). INNER JOIN `physical_samples` on `mo.sample_id`
   (nullable since `…034`) and `ts.sample_id` (nullable since `…063`). Ops with only
   `output_sample_id` and subject-only tests are missing from the views (3 rows vs 2; 1 vs 0), so
   text-to-SQL counts are silently wrong. Fix: LEFT JOIN in a new migration, plus a parity test.
3. **should fix — audit gaps.** Only 9 of 48 public tables carry `audit_*` (ADR-0003: every
   mutation is audited). Unaudited with OCC: `tools`, `equipment`, `insert_types`,
   `manufacturing_methods`, `etchants`, `prep_recipes`, `prep_recipe_steps`, `prep_steps`.
   Unaudited without OCC: `materials`, `people`, `sample_genealogy`, `sample_stock_provenance`,
   `sample_co_owners`, `project_investigators`, `test_sessions_subject`,
   `machining_force_analysis`, `fast_recipes`, `fast_run_data`, `tool_setup`, `diag_layer`. Lab
   Member has full CRUD on `people` (`…066:10-20`), and person deletes null owners via `ON DELETE
   SET NULL` untraceably; sample deletes cascade (`…023`) into unaudited genealogy and
   force-analysis rows. Also `audit_trigger_function`'s `record_id` COALESCE list
   (`…009_audit.sql:57-72`) knows ~17 PK names, so others log `'unknown'`.
4. **should fix — OCC gaps.** `…105_tool_setup.sql:11-17`, `…108_diag_layer.sql:15-17` declare
   `version`/`updated_at` with no `occ_*` trigger. Similar: `diag_recipes`, `fast_recipes`,
   `fast_run_data`, `machining_force_analysis`, `force_crawler_state`, `semantic_embeddings`.
5. **should fix — downs fail with data.** `…063_test_subject_m2a.sql:45-46` sets `sample_id NOT
   NULL` before back-filling (fails once a subject-only test exists); `…034` likewise for
   `output_sample_id`-only ops. Pass in CI only because tables are empty.
6. **should fix — `…032_inline_param_fields.sql` down is not a reverse.** Up copies and drops 11
   `*_params` tables; down only drops the new columns (data lost; re-running up fails —
   reproduced). Applied migration: document it or add a new one, don't edit.
7. **should fix — `audit_trigger_function` is `SECURITY DEFINER` with no `SET search_path`**
   (`…009_audit.sql:50`, `…047_campaigns.sql:50`); unqualified `INSERT INTO audit_logs`.
   `audit_logs` is protected only by `DO INSTEAD NOTHING` rules, so `TRUNCATE` works.
8. **should fix — LLM role is a deny-list** (`…052_llm_readonly_broad_read.sql:12-18`): `GRANT
   SELECT ON ALL TABLES` + default privileges minus 12 tables. Readable in the final schema:
   `audit_logs` (full row JSON), `people` (email), `Machine_Operators`; on a real Directus DB
   possibly `directus_activity`, `directus_revisions`, `directus_notifications` (the plugin's
   `sql_guard.py:75-87` allows those names). No write grants (the real boundary holds). Fix:
   allow-list. Partly **uncertain** (whether revisions hold secrets).
9. **nit — round-trip drift:** `…048` down leaves `project_id` nullable (documented); 053, 079
   lose comments; 100, 113 change column order.
10. **nit — `…078_force_crawler_state_meta.sql` down** deletes `directus_permissions` for the
    collection without scoping by policy (removes admin rows too; 075/084/111 scope correctly).

## Convention counts (final catalog)

602 of 780 non-Directus columns lack a COMMENT (`test_sessions` 150, `manufacturing_operations`
72, `machining_force_analysis` 58); 6 tables lack a COMMENT (`Machine_Operators`, `diag_layer`,
`manufacturers`, `prep_recipe_steps`, `prep_steps`, `project_rollup`). Unit-less columns include
`machining_force_analysis.feed`, `cut_diameter`, `surface_speed`, `depth_of_cut`, `peak_fx/fy/fz`,
`sample_rate`; `prep_*steps.rpm`. `Machine_Operators` is PascalCase. 65 FK columns have no index
(e.g. `manufacturing_operations.{equipment_id,method_id,tool_id,project_id}`,
`test_sessions.{sample_id,project_id}`). 25 `ON DELETE CASCADE` FKs.

## Test gaps

No stale-write OCC test; no catalog test that every `version`/`updated_at` table has `occ_*` and
every core table has `audit_*` (would catch 3, 4); audit tested only for INSERT; no view-parity,
concurrency, down-with-data tests; Directus metadata migrations no-op against empty CI stubs.
Doc drift: `db-migration` skill says the CI rollback loop is bounded at 120; `ci.yml:102` uses 200.

## Environment note

Migration 116's ICU `CREATE COLLATION` needs a non-SQL_ASCII database; pgvector must be installed.

## Checks run

Local PG16: 120 migrations up / down / up, per-migration down-up, seeds twice (idempotent),
catalog and concurrency repros. dbmate and sqlfluff not run.
