# `/db` — The durable Postgres core

This directory owns the **schema** — the contract the whole system depends on
(see [`../docs/adr/0001-postgres-as-durable-core.md`](../docs/adr/0001-postgres-as-durable-core.md)).

- `migrations/` — versioned, reversible SQL migrations, applied by
  [dbmate](https://github.com/amacneil/dbmate). **The schema is changed only
  here**, never via the Directus UI or manual edits.
- `seeds/` — idempotent reference/lookup data for local and dev environments.
- `schema.sql` — a schema-only snapshot of the **production** database, Directus's
  own `directus_*` tables included, kept for reference and diffing. Nothing applies
  it. It is refreshed by hand from the live database, so it can lag the
  migrations: the `schema_migrations` rows at the end of the file show which
  migration it was taken at.

## Migrations

Each file is plain SQL named `YYYYMMDDhhmmss_description.sql`, with a
`-- migrate:up` section and a `-- migrate:down` section that reverses it:

```sql
-- migrate:up
ALTER TABLE tool_boxes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- migrate:down
ALTER TABLE tool_boxes DROP COLUMN IF EXISTS version;
```

Every new table and column needs a `COMMENT` (the semantic dictionary the
text-to-SQL path reads — see [`../docs/data-dictionary.md`](../docs/data-dictionary.md)).

```sh
make migrate          # apply pending migrations (dbmate in Docker; needs DATABASE_URL)
make migrate-status   # list applied / pending
make migrate-down     # roll back the latest migration
make seed             # load db/seeds/001_reference_data.sql
make reset-db         # DESTRUCTIVE: drop, re-migrate, re-seed (dev only)
```

CI (`.github/workflows/ci.yml`, `migrations` job) applies every migration to a
fresh `pgvector/pgvector:pg16`, loads the seeds, runs the schema, traceability
and text-to-SQL tests in [`../tests/`](../tests/), then rolls every migration
back and checks no tables remain.
