# ADR-0011 — Row-level visibility: people see the records they are involved in

- **Status:** Proposed (the rule in "Decision" needs the owner's confirmation of the open
  questions below before it is built)
- **Date:** 2026-10-06
- **Deciders:** Maintainer + Claude (Phase 9 RBAC hardening; Explorer pages track)

## Context

Today every human account is a **Lab Member** (or Lab Admin). The Lab Member policy in
`scripts/configure_users_and_policies.sql` grants full CRUD on every lab collection with **no
row filter**, so everyone can read and change every sample, operation, test, campaign and project.
ADR-0005 always intended project-level access "as a row-level permission filter, not as separate
roles", deferred to Phase 9 (`plan.md`, "Open / deferred decisions").

The maintainer's target workflow (2026-10-06) is: a user logs in and **sees only the things they
are authorised on** (records they own or co-own), on a clean custom home screen, and browses
projects, campaigns, samples and operations as formatted pages rather than Data Studio forms (see
the [Explorer spec](../superpowers/specs/2026-10-06-explorer-pages-design.md)). The Explorer pages
read through `/items` as the signed-in user, so they show whatever Directus permissions allow.
The restriction itself therefore has to live in the permissions, not in the pages.

The data already records who is involved in a record:

| Record | Involvement columns |
|---|---|
| `projects` | `principal_investigator_person` → `people`; `project_investigators` (M2M alias `secondary_investigators`, `user_id` → `directus_users`). The project form already tells users that investigators "will be recorded as having viewing access to all samples, operations, and test sessions connected to this project" (`scripts/configure_directus.sql`, `investigator_access_notice`). |
| `campaigns` | `owner_person_id` → `people`; `project_id` |
| `physical_samples` | `owner_person_id`; `sample_co_owners` (M2M alias `co_owners`, `user_id`); `project_id`; `campaign_samples` |
| `manufacturing_operations`, `test_sessions` | `owner_person_id` (defaulted to the creator by the `d1-default-owner` hook); `project_id`; `campaign_id`; the sample they act on |

`people.user_id` (unique) links a person to their Directus login, so "the current user" in a
filter is `owner_person_id.user_id = $CURRENT_USER`. The older `owner` / `principal_investigator`
UUID columns are hidden backups (`20260703000062_people_directus_meta.sql`) and are not used.

## Decision

### The rule (proposed)

A Lab Member can **read** a record when they are involved in it, directly or through a parent:

1. **Project:** they are its PI or a listed investigator, or they own a campaign in it, or they own
   or co-own a sample in it (so the breadcrumb to their own work is never a dead end).
2. **Campaign:** they own it, or they are PI or investigator of its project, or they own or co-own
   a sample in it.
3. **Sample:** they own or co-own it, or they are PI or investigator of its project, or they own a
   campaign it belongs to.
4. **Operation / test session:** they own it, or they can read (by rule 3) the sample it acts on,
   or they are PI or investigator of its project, or they own its campaign.
5. **Child rows** (`*_params` tables, `sample_genealogy`, `sample_stock_provenance`, data-file
   junctions, `machining_force_analysis`, `fast_run_data`, `campaign_samples`): readable when the
   parent row is readable by the rules above.
6. **Reference data** stays readable by every member: `materials`, `equipment`,
   `manufacturing_methods`, `raw_stock_lots`, tools (`tool_boxes`, `cutting_inserts`,
   `insert_edges`), recipes, `people` (names only, as today), `filter_profiles`, `diag_recipes`.

**Write** (proposed): members may **create** any record (the `d1-default-owner` hook, extended to
samples and campaigns, makes them its owner). They may **update** what they can read, and
**delete** only what they own. Lab Admins keep full access.

### The mechanism

Directus **permission filters** on the Lab Member policy (`directus_permissions.permissions`),
using `$CURRENT_USER` and relational paths, for example for `physical_samples` read:

```json
{ "_or": [
  { "owner_person_id": { "user_id": { "_eq": "$CURRENT_USER" } } },
  { "co_owners": { "_some": { "user_id": { "_eq": "$CURRENT_USER" } } } },
  { "project_id": { "principal_investigator_person": { "user_id": { "_eq": "$CURRENT_USER" } } } },
  { "project_id": { "secondary_investigators": { "_some": { "user_id": { "_eq": "$CURRENT_USER" } } } } },
  { "campaigns": { "_some": { "campaign_id": { "owner_person_id": { "user_id": { "_eq": "$CURRENT_USER" } } } } } }
] }
```

The filters are written **once**, in a single source file (`scripts/access_rules.json`, or a
generator next to `configure_users_and_policies.sql`), and applied by a migration. They are
documented by intent in `docs/wiki/database/roles-and-permissions.md`, so the drop-Directus
drill (ADR-0002) can re-implement them. `configure_users_and_policies.sql` currently deletes
and re-inserts every Lab Member permission on each run. It must apply the same rules, or a re-run
would silently remove them.

### Paths that bypass Directus permissions, and what each must do

| Path | Today | Under this ADR |
|---|---|---|
| `d1-trace` endpoint | SQL functions to find ids, then every record re-read through `ItemsService` | Already correct: unreadable relatives show as "N not visible to you" |
| `d1-report` endpoints | `ItemsService` checks, then root-knex `v_*` views only for ids shown readable | Already correct; add a test with a filtered role |
| `project_rollup` (cache table read by `d1-project-items`) | Readable by all | Restrict to the project's PI and investigators; the Explorer project page reads the real collections instead |
| Ask-DB (`llm_readonly` Postgres role) | Reads every lab table | **Open question:** restrict Ask-DB to Lab Admins until it has a scoped mode, or accept that it answers over all data |
| `directus_files` / `/assets` | Unfiltered | Unchanged; the existing Phase 9 export-control item covers it |
| Machine users (Operator / Researcher / Administrator roles, `core/roles.json`) | Unfiltered | Unchanged: crawler, workers and equipment nodes need everything |

### Open questions for the owner

1. **Rig operators.** The force app signs in as the person at the rig (`apps/force-app/web`,
   `/auth/login`). A technician recording a cut on someone else's sample would not see it under
   rule 4. Either add a **Lab Technician** policy that reads all samples and operations, or have
   owners add technicians as co-owners.
2. **Strict or focused?** Is the goal that people *cannot* see others' work (this ADR), or that
   they *start from* their own work but can still browse everything? The second is a UI default
   and needs no permission change.
3. **Ask-DB:** admins only, or all data for everyone (see the table above)?
4. **Update rights:** should a project investigator be able to edit a sample they can only read
   through the project, or should update be limited to owners and co-owners?

## Alternatives considered

- **A Postgres access table** (`record_access(user_id, …)` kept up to date by triggers, with a
  Directus relation that the filter checks with `_some`). The filters become trivial and the
  same table could scope Ask-DB and a future FastAPI layer (ADR-0002). Rejected for now: it needs
  a trigger on every involvement column, one nullable column per collection (Directus relations
  cannot be polymorphic), and a backfill, before anyone sees a benefit. It stays the escape hatch
  if the filters get slow or Ask-DB needs scoping.
- **Postgres row-level security.** Directus connects as one database user through a pool, so RLS
  would depend on a per-request setting like `d1.actor_identity`, set by the `actor-identity`
  hook. That is fragile across pooled connections and invisible to Directus. Rejected.
- **Per-project roles.** Already rejected in ADR-0005: the number of roles grows with every
  project.
- **Filter in the UI only** ("my things" by default, everything still readable). Cheap and
  harmless. It is what open question 2's second answer means, but it is not a restriction, so it
  does not meet "sees only what they are authorised on".

## Consequences

- Lists, counts, dashboards, the Explorer pages, `d1-trace` and `d1-report` all narrow to the
  user's records automatically, because they all read as the user.
- Counts on Home become "yours", not "the lab's". A lab-wide figure would need an admin view or a
  dedicated endpoint.
- Relational filters add subqueries to every Lab Member read. They are fine at lab scale (hundreds
  to thousands of samples). `people.user_id` is unique, and the junction and FK columns used
  must be indexed (the migration checks for this).
- Records with **no owner** (legacy rows where `owner_person_id` is null) become visible only
  through their project or campaign. The migration must report how many such rows exist, so they
  can be assigned before the filter goes live.
- Any new collection holding lab data needs a rule in the same source file. CONTRIBUTING and
  the `db-migration` skill should say so.
- Live verification needs a real Directus with two test users; it goes in
  `docs/runbooks/physical-test-backlog.md`.

## Verification

- `tests/` integration script (or an extension `node --test` with a stubbed `ItemsService`)
  asserting the generated permission rows match `access_rules`.
- `physical_samples.co_owners` is both a legacy TEXT column and the M2M alias over
  `sample_co_owners`. Check on a live Directus that `co_owners._some` in a permission filter
  resolves to the junction; if it does not, drop or rename the legacy column first.
- Physical backlog: as user A (owner) and user B (unrelated), each rule above is visible to A,
  invisible to B, and reachable by B after B is added as a co-owner or investigator.

## References

- ADR-0002 (Directus as a swappable adapter), ADR-0005 (RBAC structure; Phase 9 row filter),
  ADR-0009 (Ask-DB read-only role)
- `scripts/configure_users_and_policies.sql`, `core/roles.json`
- `db/migrations/20260703000060_people_table.sql`, `20260703000061_people_repoint.sql`,
  `20260703000062_people_directus_meta.sql`, `20260622000029_sample_co_owners.sql`,
  `20260623000030_project_investigators.sql`, `20260710000087_campaign_redesign.sql`
- `core/extensions/d1-default-owner`, `d1-trace`, `d1-report/src/access.js`
- [Explorer pages spec](../superpowers/specs/2026-10-06-explorer-pages-design.md)
