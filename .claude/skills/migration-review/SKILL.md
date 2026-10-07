---
name: migration-review
description: Use after writing a D1-Database migration, or when reviewing a branch or PR that touches db/migrations/, db/seeds/ or tests/phase1_schema.sh. Reviews the new migrations in an isolated subagent against the repo's schema rules and returns only the findings.
argument-hint: [base-ref, default origin/main]
context: fork
agent: general-purpose
disallowed-tools: Edit, Write, NotebookEdit
---

# Migration review

Review the migrations this branch adds. **Read-only**: report findings, change nothing.

Base ref: `$ARGUMENTS` (use `origin/main` if empty).

New or changed migration files on this branch:
!`git fetch -q origin main 2>/dev/null; git diff --name-status origin/main...HEAD -- db/ tests/phase1_schema.sh .github/workflows/ci.yml docs/data-dictionary.md`

Uncommitted: !`git status --short -- db/ tests/phase1_schema.sh`

If both are empty, there's nothing to review. Say so and stop.

## Check each new migration for

**Blocking**
1. **Applied migrations edited.** Any `M` status on an existing `db/migrations/*.sql` file is a
   bug: deployed databases never re-run it. The fix is a new migration.
2. **Irreversible or lossy down.** `migrate:down` must undo every statement in `migrate:up`, in
   reverse order. Look for rows the new shape allows but the old one can't hold (widened CHECKs,
   new enum or dropdown values, nullable → NOT NULL) and check the down maps them back.
3. **Missing COMMENT** on a new table or column (text-to-SQL depends on them).
4. **New mutable table without OCC + audit**: `version`/`updated_at` columns plus the `occ_<table>`
   and `audit_<table>` triggers (pattern: `20260628000047_campaigns.sql`).
5. **Directus metadata untested.** `UPDATE/INSERT directus_*` matches nothing on CI's empty stubs,
   so without a seeded test in `tests/phase1_schema.sh` it is unverified. Also flag writes to a
   `directus_*` column that `20260624000030_directus_stubs.sql` doesn't create.
6. **CI rollback bound.** Count `db/migrations/*.sql`; if it exceeds the `seq 1 N` bound in the
   `migrations` job of `.github/workflows/ci.yml`, the full rollback check will fail.
7. **Ordering.** The new file's 14-digit version must sort after every migration on `origin/main`.

**Should fix**
- Naming against `docs/data-dictionary.md` → *Naming conventions* (units in column names, `is_*`,
  `*_at TIMESTAMPTZ`, `v_` views, `{table}_{description}_{type}` constraints).
- Unindexed FK columns that queries will filter on.
- No leading comment explaining why the migration exists.
- New user-facing tables or columns missing from `docs/data-dictionary.md`.
- Business logic that belongs in Postgres being put in Directus config instead (ADR-0002), or
  plugin-specific logic creeping into the core schema (ADR-0007).

Run `pre-commit run sqlfluff-lint --files <new files>` if pre-commit is installed and include
real lint errors. Don't apply migrations to any database.

## Report

Return a short list, most severe first. For each finding: `file:line`, what is wrong, and the
concrete fix. Mark each **blocking** or **should fix**. If there are none, say so in one line —
don't pad the report with things that are fine.
