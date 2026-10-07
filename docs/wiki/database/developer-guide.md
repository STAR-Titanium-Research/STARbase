# Developer guide

[← D1 Database wiki](README.md)

## Repository map

| Path | What |
|---|---|
| `db/migrations/` | the schema: dbmate migrations, the only way the schema changes |
| `db/seeds/` | reference data for dev (`001_reference_data.sql`) |
| `db/schema.sql` | a schema-only snapshot of production, for reference and diffing (nothing applies it) |
| `core/extensions/` | the Directus extensions: hooks, endpoints, modules, interfaces |
| `core/roles.json`, `core/permissions.json`, `core/apply.sh` | the Phase 3 role model and machine users |
| `scripts/configure_*.sql` | Directus metadata as code |
| `scripts/` | orchestrators, importers, backfills, MATLAB |
| `plugins/` | compute plugins (filter, diagnostics, text-to-SQL, heavy data, analysis) |
| `packages/force-plotting/` | the Force Analysis dashboard, shared with the Force App |
| `packages/d1-ui/` | the Explorer pages' kit (`@d1/ui`): `recordRoute`, status vocabularies, shared components and the edit drawer; used by `d1-home`, `d1-lab-dashboard`, `d1-composition-bar`, `d1-campaign-ops`, `d1-project-items` and `d1-fast-dashboard` |
| `tests/` | schema, traceability, text-to-SQL and UI tests |

Start with [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) for the rules (migrations only, `COMMENT`
on everything, no secrets or real data in git) and [`plan.md`](../../../plan.md) for the roadmap.

## Building the stack from nothing

The normal path is Docker Compose:

```bash
cp .env.example .env           # fill in the secrets
make up                        # Postgres, Directus, Redis, MinIO, proxy, plugins
make migrate                   # DATABASE_URL must point at the stack's Postgres
make seed                      # dev reference data
bash scripts/configure_all.sh  # Directus metadata, then flush Redis + restart Directus
```

Then apply the **role and policy** statements from `scripts/configure_users_and_policies.sql`.
That file also creates the lab's real user accounts, so on a dev or demo stack apply only the
roles and policies and create your own test users. Real accounts and real data stay out of dev stacks and out of git
([`SECURITY.md`](../../../SECURITY.md)).

### Problems you will hit

A from-scratch build against a real Directus database (rather than the stub `directus_*` tables CI
uses) trips over several ordering problems in the repository. These were found while building the
demo stack for this wiki:

| Where | Problem | Workaround |
|---|---|---|
| migration `20260703000057_facilities_directus_meta` | puts the `facilities` collection in the `manufacturing_methods` group, which only `configure_directus.sql` creates, and that runs *after* migrations. A foreign key rejects it. | insert a placeholder `directus_collections` row for `manufacturing_methods` before migrating (configure replaces it later) |
| migration `20260703000066_lab_member_people_permissions` | grants permissions to the Lab Member policy, which only `configure_users_and_policies.sql` creates | apply the roles/policies part of that script before this migration |
| `scripts/configure_directus.sql` | re-inserts the field and relation metadata for the core collections from scratch, which removes the interfaces and relations later migrations registered (about 100 fields and 14 relations; `fast_recipes` then errors because its `runs` relation is gone) | build a second, migrations-only database and copy back the `directus_fields` / `directus_relations` rows that configure removed |
| `scripts/configure_directus.sql` (fixed in this change) | wrote the module bar without `"enabled": true`, so the left-hand module rail was empty | fixed: re-run the script's section 0 |
| `core/extensions/d1-material-inherit`, `d1-report` (fixed in this change) | `package-lock.json` lacked the optional `@emnapi/*` packages, so `npm ci` failed (`EUSAGE`) | fixed: the lock files are refreshed |
| `db/seeds/001_reference_data.sql` (fixed in this change) | the seeded machines had no `capabilities`, so the machine picker offered none of them | fixed: the seed sets them; on an existing dev database, set `equipment.capabilities` by hand |

### Without Docker

Everything also runs natively, which is how the screenshots were made:

1. PostgreSQL 16 with the `pgvector` extension. Create the `d1` user and the `d1_database`
   database.
2. Directus 11 from npm (`npx directus bootstrap`, then `npx directus start`). Point it at the
   database, with `EXTENSIONS_PATH` set to `core/extensions` and `CORS_ORIGIN` including
   `http://localhost:5180,app://force` for the Force App.
3. [dbmate](https://github.com/amacneil/dbmate): `dbmate --migrations-dir db/migrations up`.
4. `psql -f` each configure script in the order `configure_all.sh` uses, then restart Directus.
5. Build each extension (`npm ci && npm run build` in its folder) and restart Directus. The ones that
   import shared source (`d1-force-dashboard`, `d1-home`, `d1-lab-dashboard`, `d1-composition-bar`,
   `d1-campaign-ops`, `d1-project-items`, `d1-fast-dashboard`) are workspaces of the repo root: run
   `npm ci` there, then `npm run build:extension` and `npm run build:extensions`.

## Demo data

Never copy production data into a dev stack. Create clearly labelled demo records through the
API instead: `Demo …` people on `example.com` addresses, a `DEMO-…` project, and sample codes in
a range nobody uses. `scripts/seed_demo_sample.sql` seeds one sample for the report. For force
data, record simulated cuts with the Force App (see its [developer guide](../force-app/developer-guide.md#any-os-in-a-browser-without-hardware)).

## Tests

```bash
make smoke             # repository checks (Phase 0)
make schema-test       # schema tests (needs DATABASE_URL)
make traceability-test # lineage functions
make ai-test           # text-to-SQL guard and roles (needs a superuser URL)
make lint              # all pre-commit hooks
```

Extensions and packages with tests run them with `npm test` in their folder. The Directus UI
tests are in `tests/ui/` (see its README).

## Writing an extension

Copy the closest existing extension of the same type, keep its `package.json`
`directus:extension` block, and build with `npm run build`. Hooks that must hold whatever the
client belong in Postgres instead (triggers and functions), because Directus is the swappable
adapter. Plugins that compute over data follow the [plugin contract](../../plugin-contract.md).
