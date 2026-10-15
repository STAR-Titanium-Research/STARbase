# ADR-0014 — Record access: a "Who has access" list, Restricted records, and materialised readers

- **Status:** Accepted for A1a (2026-10-13); A1b (files, octrees, the Restrict switch) follows. Amends [ADR-0011](./0011-row-level-visibility.md).
- **Date:** 2026-10-12 (design), 2026-10-13 (performance gate, readers tables)
- **Deciders:** Maintainer + Claude (spec `docs/superpowers/specs/2026-10-12-record-access-design.md`, plan `docs/superpowers/plans/2026-10-12-a1a-record-access.md`)

## Context

ADR-0011 made a member see the records they own, co-own or are an investigator of, and nothing else, but the only way to share a
record was the two junction tables (`sample_co_owners`, `project_investigators`) and the only way to hide a record from its own
project's people was not to put it there. The maintainer asked for a Google-Drive-style **Who has access** dialog on the five record
types (sample, operation, test, campaign, project), with **Can view** and **Can edit** people, an email on add, ownership transfer,
and a **Restricted** switch that makes a record (and everything under it) visible only to its owner, the people listed and admins.

The first implementation (read filters of about 76 leaves with bare to-many hops) failed the performance gate on a seeded copy of the
live data: Directus turns each bare to-many hop of a filter into a `LEFT JOIN`, and the operations index went 7.6x, a Home count 14.5x,
a sample page's campaigns 130x, member lists past 60 s. Decision 18 of the spec replaced it.

## Decision

1. **One access table per record type** (`sample_access`, `operation_access`, `test_access`, `campaign_access`, `project_access`; person-keyed, so a person
   with no login can be listed) and a `restricted` boolean on the five record tables. The old junctions stay honoured; retiring them is a
   follow-up after A1b (A2).
2. **Who can read a record is materialised.** `d1_private.readers_of_<type>()` (one SQL function family) is the single statement of the rule; the
   `<type>_readers(record_id, user_id)` tables hold its answer, kept by statement triggers that only say which records to recompute; the Directus
   read rule of the five types is one membership test on the table. Refreshes are serialised by one global advisory lock. Drift between the
   tables and the functions is checkable (`d1_private.readers_drift()`, shown on `/d1-admin-overview`, scheduled check in the cutover runbook) and
   repaired by `d1_private.readers_rebuild()`. A mutation matrix and a randomised differential test against an independent plain-SQL oracle guard it.
3. **Update, delete and manage** remain Directus filters, generated from `scripts/access_rules.json` by `scripts/gen_access_rules.py`
   (`--check` in CI), and carry the reader term, so a rule is never wider than read.
4. **Restricting cascades.** A restricted project hides its campaigns, samples, operations and tests; a restricted campaign hides its operations and tests
   and the samples that only reach the user through it; a restricted sample hides its operations, tests, files and analyses. The project's PI always sees everything in it.
5. **Only an owner (a PI for a project) or an admin** changes the owner, the Restricted flag or what is moved into a Restricted parent (`d1-access-guard`);
   **a co-owner can no longer add, change or remove co-owners** (a deliberate change from ADR-0011).
6. **The `d1-record-access` endpoint** lists, adds, changes, removes and transfers, with an email on add and on transfer (a failed email never blocks the change).
7. **A1a ships with the Restrict switch hidden** (`RESTRICT_UI = false`): the database and the Directus rules enforce it, no screen turns it on until A1b
   closes the file and octree paths below. **Over the API only an admin can set or change `restricted` until A1b** (the guard's
   `RESTRICT_ADMIN_ONLY`, maintainer ruling): an owner who could restrict through the API would believe a record private while its files
   and octrees are not. A1b turns the switch off. A Lab Member also updates **only their own People row** (migration 169), because a People
   row now decides who is a reader and who is mailed.

### Paths that bypass Directus, and what each does (the amendment to ADR-0011)

| Path | Under A1a |
|---|---|
| **Ask-the-database** (`d1_llm_app`, member of `d1_llm_readonly`) | **Closed in A1a (migration 168).** Postgres row-level security keyed on the role: every granted record-bound table has a restrictive `FOR SELECT TO d1_llm_readonly` policy, the five record tables' policy is `NOT d1_private.is_hidden('<collection>', <key>)` (a recompute-maintained `d1_private.hidden_records`), the children check their parent, `project_rollup` and `semantic_embeddings` are scoped by their own keys; the nine granted `v_*` views are `security_invoker`; a permissive `FOR ALL TO PUBLIC` policy keeps every other role (the `d1_embedder` backfill) unchanged; the owner role (`d1`, which Directus and the migrations use) bypasses row security (not `FORCE`d). The role has `USAGE` on `d1_private` and `EXECUTE` on `is_hidden`, and no grant on `hidden_records`; the SQL guard rejects schema-qualified calls and every schema but `public`, so the model cannot call the function. |
| **d1-trace** | Closed: returns booleans (`hidden: { stock_origins, ancestors, events, descendants }`), never counts; the UI says "some records hidden"; the remaining counts the Explorer printed (campaign "N samples not visible", the timeline's items, test subjects, the sample page's campaigns) are count-free too. |
| **project_rollup** | Closed: restricted-aware column, rule and Ask-DB policy. |
| **`directus_files` and `/assets`** | **Open until A1b**: any member can read any file by id. |
| **Octrees** (Caddy `/octrees/*`, no auth) | **Open until A1b**: anyone on the tailnet host can stream a point cloud by operation id. |
| `campaign_samples` and `sample_genealogy` rows | A genealogy edge to a restricted relative still shows its id to a reader of the other end. Accepted. |
| Machine users | The legacy Phase 3 role files (`core/roles.json`, `core/permissions.json`, `core/apply.sh`; Operator, Researcher, Administrator) are **deleted**: nothing read them (checked: Makefile, CI, compose, pre-commit, scripts, tests). Live has Administrator, Lab Admin and Lab Member only; machine users are Administrator users with a static token created by hand (`docs/runbooks/heavy-data-pipeline.md`). |

### The LLM-granted view rule

`CREATE OR REPLACE VIEW` without a `WITH (...)` clause **resets** `security_invoker`, silently turning the Ask-DB bypass back on. A later migration
that redefines any view granted to `d1_llm_readonly` must say `WITH (security_invoker = true)`; `tests/phase1_schema.sh` asserts every granted view has
`security_invoker=true` in `pg_class.reloptions`, and that every granted table has row security on or is on the named reference list (21 tables), so a new
grant without a policy fails CI. `CONTRIBUTING.md` and the `db-migration` skill carry the rule. A view that a security-invoker view depends on must not read
`d1_private.hidden_records` directly (the role has no grant): use `d1_private.is_hidden()`, as `v_project_rollup` does.

## Amendment (2026-10-15): the Lab Viewer account role (migration 185)

The lab's PI must see everything and change nothing, so a fourth account role, **Lab Viewer**, is a **reader of every record** of every type, Restricted
included. It is done inside this machinery, not beside it, so Directus permissions, STARbase, the finder and every endpoint that reads the readers tables
show a viewer everything with no special case:

- `d1_private.v_viewers` (a login with the role id `10000001-0000-0000-0000-000000000003` that is not `suspended`, read straight from `directus_users`: a
  viewer needs no People row) is one more branch of each of the six `readers_of_*` functions and of their six `_spec` functions: a viewer is a reader of every
  record, added after the rule and its gates (a Restricted parent would otherwise drop it). The per-pair predicates `can_read_*` and the candidate functions stay
  the ordinary rule; `scripts/dev/access_matrix_oracle.sql` models a viewer on its own (`ref.viewer`) and `tests/readers_matrix.sh` asserts that function,
  specification and oracle agree, with viewers present, for every record and user of the 32 universes and of the random ones.
- A login that gains or loses the role, or is suspended, unsuspended, created or deleted, changes the viewer set: statement triggers on `directus_users`
  (AFTER INSERT, UPDATE and DELETE, with transition tables) recompute every readers table with `readers_rebuild()`; a BEFORE statement trigger on INSERT, DELETE
  and UPDATE OF role, status takes the global readers lock first (decision 2's lock rule; Directus writes `last_access` on every request, which must not take it).
  Drift stays 0.
- The Directus policy is the **read rows of Lab Member, unchanged**, generated by `scripts/gen_access_rules.py` under the viewer's policy id (`--check` covers
  both blocks of `scripts/configure_users_and_policies.sql`); it has **no create, update or delete row**. Being a reader never grants a write: the update, delete and
  manage rules of decision 3 are Directus filters the policy has no row for, and the endpoints that write with knex or as the system after their own check
  (`d1-record-access`, `d1-teams`, `d1-people-admin`) refuse a viewer first on every route that changes anything (`403 READ_ONLY_ROLE`), because a viewer who owns a
  record or is a project's PI would otherwise pass their manage check.
- Not changed, so still true for a viewer: **Ask-the-database** hides Restricted records from every asker (its role-level row security is the table above), and
  files and octrees stay open until A1b.
- `project_rollup` and the five `*_access` tables are about the caller for a Lab Member (a project's PI and investigators; the person an access row lists). For the
  viewer that rule is no filter (`scripts/access_rules.json` `viewer.read_all`, generated like the rest, `--check` covers it): it reads every row, as it reads every record.
  The `*_team_access` and `*_team_pending` tables have no Directus permission for anyone; the endpoints read them.
- The People page for a viewer (Task B): `d1-people-admin` (`/people`, `/attention`, `/people/:id/access`), `d1-teams` and `d1-record-access` (`GET`) answer a viewer what they answer
  an administrator (every person, every record of every list: a viewer reads every record), and still refuse its writes. A viewer's `can_manage` is always `false`, and
  `GET /d1-teams/pending` is empty (nothing waits for someone who decides nothing). The host contract (`@d1/ui`) carries `canViewAllAccess` (the account role id, the
  same id rule as the endpoints); the People and Teams pages show an administrator's reads for `isAdmin || canViewAllAccess` and keep every control that changes something
  off for a viewer.

## Known gaps (accepted)

- The A1a-to-A1b window: a restricted operation's files, force analyses' files and octrees are reachable by anyone who has their id.
- A multi-sample test is matched through its derived primary sample; a restricted *secondary* sample does not hide it (ADR-0011 limit).
- Creating an operation or test under a restricted sample the creator cannot read is not refused by the guard (A1b).
- A genealogy edge or a junction row can reveal the id of a record the reader cannot open (genealogy to a restricted relative; a campaign reader and an unrestricted sample hidden from them by shielding).
- The orphan amnesty covers only runs that are open to everyone.
- A PI of project P still sees the rollup row of an operation of P whose restricted sample belongs to another project.
- Ask-DB is role-level: a restricted record is hidden from every Ask-DB question, including the owner's. A per-user policy needs the service to carry the
  asker's identity and the guard to forbid `set_config` (follow-up).
- Deadlocks (`40P01`) between a parent delete and a child writer abort one writer cleanly and are not retried (a bounded retry is a named follow-up). The global
  readers lock queues writes behind an open import transaction (measured: a UI sample save waits the length of the import); the importer commits in batches.
- Derived data bypassed by triggers-off restores must be rebuilt (`readers_rebuild()`); a `TRUNCATE` of `test_sessions_subject` leaves `test_sessions.sample_id` stale.
- A `d1_private` function that the policies do not call is executable by the Ask-DB role once it has schema `USAGE` (every one is an invoker function over tables the role cannot read, or a trigger function): the guard is what keeps the model off them.

## Consequences

- Reads are one indexed membership test; measured on the seeded copy every list is under 80 ms p95 (heavy lists went from 24 to 60 s down to about 20 ms); writes that
  need a refresh take one global lock and cost milliseconds, with rare cascades (restricting a big project) measured in the hundreds of milliseconds.
- The derived tables need operations care: a scheduled drift check and a rebuild after any restore (`docs/runbooks/a1-record-access-cutover.md`).
- The readers tables, `hidden_records` and the backups are not granted to `d1_llm_readonly` and are left out of the backup dumps (derived data).
- Retiring the old junction tables (A2) and the files and octree paths (A1b) are the open follow-ups.

## References

- Spec `docs/superpowers/specs/2026-10-12-record-access-design.md`; ADR-0005 (RBAC), ADR-0009 (Ask-DB role), ADR-0011 (row-level visibility).
- Migrations `…165` (access tables, `restricted`), `…166` (readers, rules), `…167` (project rollup), `…168` (Ask-DB row security), `…185` (Lab Viewer).
- `scripts/access_rules.json`, `scripts/gen_access_rules.py`, `core/extensions/d1-access-guard`, `core/extensions/d1-record-access`, `docs/runbooks/a1-record-access-cutover.md`.
