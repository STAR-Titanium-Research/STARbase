---
name: db-migration
description: Use when changing the D1-Database Postgres schema or Directus metadata — adding or altering a table, column, constraint, index, view, trigger or function, back-filling data, or editing directus_fields / directus_collections / directus_relations rows. Writes a reversible dbmate migration in db/migrations/ that follows the repo's naming, COMMENT, OCC and audit conventions, then proves it applies up, down and up again.
argument-hint: [what-the-migration-does]
---

# DB migration

The schema is the contract (ADR-0001, CONTRIBUTING golden rule 1). It changes **only** through a
new file in `db/migrations/` — never by editing an applied migration, never through the Directus
UI, never with ad-hoc `psql`.

## Where things stand

Newest migrations:
!`ls db/migrations | tail -4`

Next filename (replace the slug): !`bash .claude/skills/db-migration/scripts/next_migration_name.sh`

Migration count: !`ls db/migrations/*.sql | wc -l` (see the CI rollback gotcha below)

## What a good migration here looks like

- One `-- migrate:up` and one `-- migrate:down` section; down restores the exact prior state.
- A leading comment explaining **why** — the incident, the spec or the ADR it serves. Later
  sessions read these to understand the schema (see `20260918000113_tool_boxes_version_column.sql`).
- New tables and columns follow `docs/data-dictionary.md` → *Naming conventions*: plural
  snake_case tables, `is_*` booleans, `*_at TIMESTAMPTZ`, unit suffixes (`_mm`, `_celsius`,
  `_rpm`, …), `v_` views, `{table}_{description}_{type}` constraints, real FKs.
- `COMMENT ON` every new table and column. The text-to-SQL plugin reads them through
  `v_schema_dictionary`; a column without one is invisible to it.
- A new **mutable** table gets `created_at`, `updated_at` and `version INTEGER NOT NULL DEFAULT 1`,
  plus both shared triggers (copy from `20260628000047_campaigns.sql`):
  `occ_<table>` BEFORE UPDATE → `occ_update_trigger_function()` and
  `audit_<table>` AFTER INSERT OR UPDATE OR DELETE → `audit_trigger_function()`.
- Index FK columns you will filter on (`idx_<table>_<column>`).

## Verify — don't stop at "it looks right"

1. Lint: `pre-commit run sqlfluff-lint --files db/migrations/<file>` (or `make lint`).
2. Apply up → down → up and run the CI schema suites:
   ```sh
   eval "$(bash .claude/skills/db-migration/scripts/scratch_pg.sh start)"   # no Docker? local PG16
   bash .claude/skills/db-migration/scripts/verify_migration.sh
   bash .claude/skills/db-migration/scripts/scratch_pg.sh stop
   ```
   With the stack up you can instead point `DATABASE_URL` at a **scratch** database. Never at the
   real one: the script rolls back and the tests write rows.
3. Add a test section to `tests/phase1_schema.sh` for anything with behaviour (constraints,
   triggers, back-fills, Directus metadata). The `round bar form migration` section is the
   pattern: run the file's up and down SQL inside a rolled-back transaction and assert both.
4. Update `docs/data-dictionary.md` for new tables and columns users will query.

## Gotchas

- **CI rolls back with a fixed loop.** `.github/workflows/ci.yml` runs `dbmate down` in
  `for _ in $(seq 1 120)`. Once the migration count passes 120 the full rollback stops early
  and "Verify clean rollback" fails. Raise the bound in the same PR.
- **Directus tables are stubs in CI.** `20260624000030_directus_stubs.sql` creates empty
  `directus_*` tables so the migrations run on bare Postgres. `UPDATE directus_fields …` therefore
  matches **zero rows** in CI and passes silently; only a test that seeds the row proves it.
  If you write to a `directus_*` column the stub lacks, add it to the stub (idempotently) or CI
  breaks.
- **Down must handle data written under the new shape.** Narrowing a CHECK or a dropdown leaves
  rows the old schema can't show. Map them back explicitly and say in a comment if that's lossy
  (`20260930000114_round_bar_form.sql`).
- **The audit function is shared.** `audit_trigger_function()` has been redefined by later
  migrations (e.g. campaigns). Read the newest body (`grep -l 'FUNCTION audit_trigger_function' db/migrations/*`)
  before changing it, and don't revert it in a down section that other tables depend on.
- **Sequence numbers aren't unique** (`000030`–`000032` and `000035` each appear twice) — dbmate
  orders by the full 14-digit version, so take the script's suggestion rather than picking one.
- `db/schema.sql` is a hand-refreshed production snapshot. Don't edit it to match your migration.
- The role `d1` must exist (`20260701000052_llm_readonly_broad_read.sql` references it); `scratch_pg.sh`
  creates it as a superuser, as CI does.
