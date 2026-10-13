# A1a Record Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Who has access" dialog on the five Explorer record pages (add and remove people, transfer ownership, email
on add), and a per-record **Restricted** model in the database and the Lab Member rules (a restricted sample hides its
operations and tests; a restricted campaign or project hides what is inside it; rollup, Ask-the-database and
d1-trace follow), with the Restrict switch **hidden in every UI** until A1b.

**Architecture:** Migration 165 (done) adds `restricted` to five tables and five person-keyed access tables, each with a
hidden `access` O2M alias. **Read visibility is materialised** (spec ruling 18): migration 166 adds a `d1_private`
function family (`readers_of_<type>`, the promoted `ref.*` model, the single statement of the rule), five
`<type>_readers(record_id, user_id)` tables keyed by login (plus `operation_open_to_all` and `hidden_records`),
statement-level recompute triggers with transition tables, `readers_rebuild()` and `readers_drift()`, and the initial
backfill; the same migration then applies the Lab Member rows: the read rule of each
record type is one `readers._some.user_id = $CURRENT_USER` (plus the orphan-amnesty leaf for operations), children read
through one bare hop (`operation_id.readers.user_id`), update and delete are "reader AND editor/owner" filters from the
generator (`access_rules.json` and `gen_access_rules.py`, Task 2a's engine, trimmed). `d1-access-guard` gains owner-only
`restricted`, restricted-sensitive keys and manage-rule junction guards. A new endpoint extension `d1-record-access` is the
only writer of the access tables and sends the email through Directus's `MailService`; `d1-admin-overview` shows the
drift count. The kit holds the pure model and the dialog; d1-home places the button. Migration 167 adds `project_rollup.restricted`; migration 168 gives the Ask-DB role
row-level security on `hidden_records`.

**Tech Stack:** Postgres 16 + dbmate, Directus 11.17 (endpoint and hook, plain ESM JS, node:test), Vue 3 + TS kit with
vitest, Python 3 (generator and pytest), bash harnesses.

**Spec:** `docs/superpowers/specs/2026-10-12-record-access-design.md`
**Live apply:** `docs/runbooks/a1-record-access-cutover.md` (maintainer-run; this plan never touches live).

## Global Constraints

- **Migration numbers.** `20261012000163_user_usage.sql` is on `origin/main` and live (PR #246);
  `20261012000164_label_templates.sql` is on `feat/label-printing` and `feat/label-scan`. As of 2026-10-12 the highest
  number on any branch is 164, so A1a takes **165 to 168**: `..165_record_access.sql` (done),
  `..166_record_readers_and_rules.sql` (the file written as `..166_lab_member_record_access_rules.sql`, never applied,
  renamed and rewritten in place: first the readers tables, functions, triggers, backfill and Directus metadata, then the
  Lab Member rows that walk them), `..167_project_rollup_restricted.sql` (never applied, edited in place),
  `..168_llm_role_row_security.sql`. **Before writing the first new migration**: (1) `git fetch origin`, then merge
  `origin/main` into `feat/record-access`; (2) re-run
  `for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin refs/heads); do git ls-tree -r --name-only $b db/migrations; done | sed 's|.*/||' | sort | tail -3`
  and take the next four free numbers, renumbering this plan's names if another branch has taken any; (3) **merge
  `origin/main` again before applying anywhere** and re-check. The `ROUNDTRIP` count in every gate equals the number of new
  migrations in that task (Task 1: 1, Task 2: 2, Task 5: 1, final gate: 4).
- **Directus 11.17 filter constraints** (spec section 3, "Directus constraints"; read the header of migration
  `20261010000160_lab_member_some_only_where_directus_accepts_it.sql` too): (1) `_some` only under a **top-level O2M alias**
  (`"_some" can only be used with top level relational alias field`); a bare to-many hop is a `LEFT JOIN` that multiplies
  rows (the cause of the failed gate); (2) a relation key is read by its **first key only**, so a role test or any two
  conditions on one row are an AND of two bare paths, never sibling keys; (3) a `_some` body must be **one plain chain**
  (an `_and`/`_or` inside it is a 500); (4) a legal `_some` applies the related collection's own rule **for the same
  action**, so the readers tables' Lab Member read rule is "own rows only" with no relation hop, and update/delete filters
  use a bare hop to readers, never `_some`. Every new rule must be proven on the Directus smoke harness (200, correct
  rows, no duplicates, `filter_count` agrees), not only in Postgres. Hand-written filters count too (`mine.ts`).
- **One source of truth for read visibility.** The `d1_private` function family states who can read a record; the readers
  tables only materialise it; triggers only say which ids to recompute (spec section 2). `ref.*` in the fixture stays an
  independent test oracle. No read rule is written in the JSON or in a filter any more, and no trigger contains visibility
  logic.
- **Readers tables are derived data.** No audit trigger (add them to `AUDIT_EXCLUDED` in `tests/phase1_schema.sh`), no grant
  to `d1_llm_readonly`, no Lab Member write, written only by the `SECURITY DEFINER` trigger functions, kept by
  `configure_directus.sql`, repaired by `d1_private.readers_rebuild()`, checked by `d1_private.readers_drift()`. Check
  whether `v_schema_dictionary` lists the access and readers tables (parked from Task 1) and decide once.
- **The Restrict switch stays hidden.** `restricted` is a hidden, read-only field in `directus_fields`; the dialog's
  toggle is behind `RESTRICT_UI = false`. No A1a code path renders it.
- **Writes to the access tables only through the endpoint.** Lab Member has no create, update or delete grant on
  them. The endpoint checks the manage rule (the record's delete rule from the generated `rules.json`) in the same
  request, then writes with system accountability. Admins manage any record.
- **Old tables stay (decision 17).** `sample_co_owners` and `project_investigators` remain honoured (union with the
  new tables in every set), shown in the dialog, and their row for a person is deleted by the dialog's writes. No
  backfill and no consumer rewrite beyond `mine.ts`. Retiring them is the A2 follow-up, not this plan.
- **Unrestricted records behave exactly as today** when their access lists are empty: the matrix test compares the readers (the
  function) and the smoke compares Directus with today's ids on the fixture (same visible ids for every user when nothing is restricted and no
  access rows exist). The intended differences: `sample_co_owners` update and delete become owner-only; the exact campaign gate and the narrowed amnesty (spec section 1), only where something is restricted.
- **The smoke harness must load the worktree's code.** `scripts/dev/directus_smoke.sh` mounts the main checkout's
  extensions and overlays only `d1-next-number`. Task 2 added `D1_SMOKE_OVERLAYS` (a space-separated list, default
  `d1-next-number`) and **every A1a smoke run is
  `D1_SMOKE_REQUIRE_LM=1 D1_SMOKE_OVERLAYS="d1-next-number d1-access-guard d1-record-access d1-trace d1-admin-overview" bash scripts/dev/directus_smoke.sh`**.
- **No live access.** Never touch the live containers or database. Harnesses restore a read-only dump into a
  throwaway copy; follow `scripts/dev/directus_smoke.sh` as written. Seed data goes into the copy only.
- Kit files never import `@directus/extensions-sdk` (`noSdkImports.test.ts`). The dialog uses `EXPLORER_HOST.api`.
- No emojis in code, UI text or commits. UI wording is plain ("Who has access", "Can view", "Can edit", "Secondary
  investigator", "can't sign in yet", "some records hidden").
- Commit per task (Task 2: per sub-step) with the message given; end each commit message with the attribution line
  the harness provides.

## Review Focus

1. **Restricted never widens.** For every collection and every fixture user, update and delete visible ids are a
   subset of read visible ids; a restricted sample's operations, tests, file rows and analyses are invisible
   to anyone not on its list, including the operation's own owner; a restricted project or campaign hides what is
   inside it per spec section 1, and the operation/test gate on the sample's campaigns is exact (spec ruling 19).
2. **The mutation matrix and the drift check (new, non-negotiable).** One test case per row of the spec's trigger-coverage
   table (`tests/readers_matrix.sh`); after each mutation `readers_drift()` is empty for **all** records, not only the
   touched ones; the function equals the `ref.*` oracle on the 32 universes. Review the coverage table against the
   function: every input the function reads must have a trigger row, and the "not inputs" list must really be unread.
   Includes the cases that skip triggers (a disabled trigger is *detected*, `readers_rebuild()` repairs it).
3. **The functions read base tables only**, never a readers table; candidates come from the positive paths (no
   records x users cross join); the recompute locks sorted ids and computes in a later statement; the diff does not churn;
   the trigger functions are `SECURITY DEFINER` with a pinned `search_path`; triggers carry no visibility logic.
4. **The Directus constraints.** No generated or hand-written filter has a `_some` anywhere but index 1 / after a legal
   `_some`; no sibling keys beside a relation key; no `_some` with a non-chain body; every `via` is an M2O; update and
   delete use a bare hop to readers, never `readers._some`; the readers tables' read rule is trivial. The single-`EXISTS`
   read rules, the one-hop child rules (no duplicates, `filter_count`) and the role test in the update filters work on a
   real Directus (viewer cannot update, editor can).
5. **Manage = owner (PI) or admin, nothing else.** A co-owner, a Can edit person cannot add, change or remove
   anyone (including through `PATCH`/`DELETE` of `sample_co_owners`), change `restricted`, move a restricted record
   by changing `project_id`/`campaign_id`/`sample_id`/subject rows, or hand the record over, by endpoint or by
   `PATCH /items`.
6. **The email can never block or leak.** A throwing or hanging mail service still returns the change; no mail to the
   adder, to a person with no address, or on a role change; the recipient is the login email when there is a login;
   every interpolated value is escaped; the link is `PUBLIC_URL/admin/home/<kind>/<id>`.
7. **Ask-DB** sees nothing of a restricted tree through tables or `v_*` views (policies on `hidden_records`);
   `d1_embedder` can still write `semantic_embeddings`; Directus (table owner) and the migrations are unaffected; every
   granted table has RLS or is named reference, and every granted view is `security_invoker`.
8. **Performance gate** (Task 2d, on the seeded copy): reads (all lists, the child lists as the Force App queries them,
   the sample page's campaigns) p95 under 300 ms as a stranger and as a member, no duplicates; writes (FAST importer bulk
   insert, force crawler, Force App upload, a co-owner change on a big sample) at most 2x today's time, measured
   end to end; EXPLAIN first if either fails.
9. **Deleting `core/roles.json` and `core/permissions.json`** leaves nothing that reads them.

---

### Task 1: Schema (migration 165) and Directus metadata (DONE, commit b972c52e; nothing changes here)

**Files:**
- Create: `db/migrations/20261012000165_record_access.sql`
- Modify: `scripts/configure_directus.sql` (keep the new relations, alias fields and hidden `restricted` fields where
  it keeps the owner relations and the project aliases: see the blocks near the `owner_person_id -> people` list and
  the `samples`/`operations` alias blocks; they delete and re-insert, so without this a re-run drops them)
- Modify: `tests/phase1_schema.sh` (new assertions, below)
- Modify: `docs/data-dictionary.md` (new tables and columns; follow how `file_fingerprints` was documented)

**Interfaces (produces):**
- `restricted BOOLEAN NOT NULL DEFAULT false` on `physical_samples`, `manufacturing_operations`, `test_sessions`,
  `campaigns`, `projects`, each with a partial index `... WHERE restricted`.
- Tables `sample_access(sample_id)`, `operation_access(operation_id)`, `test_access(session_id)`,
  `campaign_access(campaign_id)`, `project_access(project_id)`, each: `access_id UUID PK DEFAULT gen_random_uuid()`,
  parent FK `NOT NULL ON DELETE CASCADE`, `person_id UUID NOT NULL REFERENCES people ON DELETE CASCADE`,
  `role TEXT NOT NULL CHECK (role IN ('view','edit'))` (**`project_access`: `('view','investigator')`**),
  `added_by_person_id UUID REFERENCES people ON DELETE SET NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `UNIQUE (<parent>, person_id)`, index on `person_id`; audit trigger as migration
  `20261003000121_audit_all_business_tables.sql` (copy its mechanism; the new tables have no OCC `version`).
- Directus metadata: `directus_collections` (hidden) for the five tables; `directus_relations` for each parent FK with
  `one_field = 'access'` and for `person_id -> people` (no alias); `directus_fields` for the five hidden `access`
  aliases (`special: o2m`) and the five `restricted` fields (`hidden: true`, `readonly: true`). Insert only when
  missing and RAISE when a relation points elsewhere, as migration `20261007000141` does.

- [ ] Do the migration-number preflight from Global Constraints (merge `origin/main`, re-check numbers).
- [ ] Read migrations 141 (relations and aliases), 121 (audit triggers) and 159 (a recent table with Directus
  metadata) and follow their patterns exactly. Live-affecting traps: a NOT NULL column needs a default (T0a
  incident); sqlfluff style via `pre-commit run --files <migration>`.
- [ ] Write the phase1 assertions first and watch them fail: the five tables and constraints exist (unique key, role
  check; `project_access` accepts `investigator`, the others refuse it; `project_access` refuses `edit`); `restricted`
  is NOT NULL default false on the five parents and every existing row is false; the metadata rows exist and the
  aliases resolve; deleting a person cascades their access rows; deleting a parent cascades its list; the audit
  trigger writes `audit_logs`.
- [ ] Implement the migration (up and down; down drops tables and columns and removes the metadata rows it added).
- [ ] Update `scripts/configure_directus.sql`; add a phase1 assertion that the new relations, aliases and fields are
  still there after `configure_all.sh` runs (extend the block near the "every rule path still resolves after the
  configure scripts" assertion in `tests/phase1_schema.sh`).
- [ ] Gates: `bash scripts/dev/schema_test_docker.sh` with `ROUNDTRIP=1` (no new FAIL lines); `pre-commit run
  --files db/migrations/20261012000165_record_access.sql scripts/configure_directus.sql`.
- [ ] Commit `feat(access): restricted flag and person-keyed access tables (migration 165)`.

### Task 2 (redone): Readers tables, readers-based rules, rollup, performance gate (migrations 166 and 167)

**Why redone.** Task 2 as first built (2a engine `5c5dad7b`, 2b rules `e1074e68`, 2c rollup `d6ea618b`) **failed the
performance gate** (operations index 7.6x as a stranger, Home count 14.5x, sample page campaigns 130x, member lists over
60 s; EXPLAIN: 971 thousand intermediate rows, no index missing; the gate-table fallback would still be about 430 ms; see
spec section 11 and `.superpowers/sdd/2026-10-12-a1a-record-access/task-2-report.md`). The maintainer's ruling (spec
rulings 18 to 20): **materialise read visibility in trigger-maintained readers tables.** What is kept from the first
attempt: the generator engine (2a) for update, delete and manage, the fixture and its 41 smoke cases, `D1_SMOKE_OVERLAYS`,
the rollup migration. The two migration files written as 166 (rules) and 167 (rollup) were never applied: 167 is edited in
place, and 166 is rewritten in place (renamed `..166_record_readers_and_rules.sql`): the readers first (2b'), the rules appended
last (2d'). Four sub-steps, each its own commit.

**Files:**
- Create: `tests/readers_matrix.sh`
- Rename and rewrite in place: `db/migrations/20261012000166_lab_member_record_access_rules.sql` ->
  `db/migrations/20261012000166_record_readers_and_rules.sql` (readers part in 2b', rules part appended in 2d')
- Modify in place: `db/migrations/20261012000167_project_rollup_restricted.sql` (header only, see 2c)
- Modify: `scripts/gen_access_rules.py`, `scripts/access_rules.json`, `tests/scripts/test_access_rules.py`,
  `tests/phase1_schema.sh` (incl. `AUDIT_EXCLUDED`), `scripts/dev/schema_test_docker.sh` (run the matrix),
  `scripts/configure_directus.sql` (keep the `readers` and `open_to_all` aliases, relations and hidden collections where it
  keeps the `access` aliases), `scripts/dev/access_matrix_fixture.sql` (the oracle), `scripts/dev/directus_smoke.mjs`,
  `scripts/dev/seed_access_fixture.sql` (copy only, parameterised, never run against live)
- Regenerate: `scripts/configure_users_and_policies.sql` (block), `core/extensions/d1-access-guard/rules.json`,
  `core/extensions/d1-record-access/rules.json` (`gen_access_rules.py --write`)
- Modify: `.pre-commit-config.yaml` (`access-rules-in-sync` `files:` regex: already carries the record-access rules file)

**Interfaces (produces):**
- `d1_private` (migration 166): `readers_of_sample(uuid[])`, `readers_of_operation`, `readers_of_test`,
  `readers_of_campaign`, `readers_of_project` each returning `(record_id uuid, user_id uuid)`; `operation_open_of(uuid[])`;
  `hidden_of(kind text, uuid[])`; the promoted `ref.*` predicates (`can_read_<type>(id, user)` and their helpers);
  `readers_closure(...)`, `refresh_readers(seed_s, seed_o, seed_t, seed_c, seed_p, touch_s, touch_c, touch_p uuid[])`,
  `readers_rebuild()`, `readers_drift()` returning `(kind, record_id, user_id, problem)`, `readers_drift_count()`,
  `is_hidden(kind text, id uuid)` (SECURITY DEFINER, for Task 5).
- Tables: `sample_readers`, `operation_readers`, `test_readers`, `campaign_readers`, `project_readers`
  (`reader_id` identity PK, `record_id` FK `ON DELETE CASCADE`, `user_id` FK -> `directus_users(id)` `ON DELETE CASCADE`,
  `UNIQUE (record_id, user_id)`, index on `user_id`), `operation_open_to_all(record_id PK FK)`,
  `d1_private.hidden_records(kind, record_id)`. Directus: hidden collections, relations `record_id -> parent` with
  `one_field = 'readers'` (`'open_to_all'`), `user_id -> directus_users` (no alias), hidden alias fields.
- Triggers: one `..._readers_ins|upd|del` statement trigger per row of the spec's trigger-coverage table (transition
  tables; the update function diffs old and new tracked columns), plus `..._readers_trunc` on the source tables.
- Generator (2a'): the item `{"reader": "bare"}`, the read rule kinds `{"readers": "some"}` and `{"open_to_all": true}`,
  child rules by `via` plus the reader item; update, delete and manage of operations, tests and campaigns = reader term AND
  editor/owner test; the read-only sets, the gate sets, `each` and the old `orphan_amnesty` shape removed.
- Lab Member rows (second part of migration 166): reads per spec section 3 (one `readers._some` per type; the operations rule ORs the
  `open_to_all` leaf; children one bare hop; `campaign_samples` and `sample_genealogy` as in the spec's table;
  `project_rollup` unchanged), update/delete/manage on the reader term, own-rows read rows for the five readers tables,
  `operation_open_to_all` and the five access tables.

**2a'. Engine (pure, fast; no database)**
- [ ] **Tests first** (`tests/scripts/test_access_rules.py`): the `reader` bare-hop item (with and without `via`); the
  `readers` some rule only at the root of a collection and never under `via`; the `open_to_all` leaf; child rules are
  exactly `{<fk>: {readers: {user_id: {_eq: $CURRENT_USER}}}}` with a to-one `<fk>`, and the two-hop `OR` rules
  (`campaign_samples`, `sample_genealogy`) have the spec's shape; update, delete and manage of operations, tests and
  campaigns contain the reader term and the owner/editor test (a role test is an AND of two bare paths); a walk of
  every generated rule asserting no `_some` outside index 1 / after a legal `_some`, no sibling key beside a relation key,
  every `via` an M2O, no `readers._some` in an update or delete filter; `resolve()` for a missing `readers`/`open_to_all`
  alias or relation; the removed sets are gone and nothing references them; `owner_guards`, `restricted_keys`,
  `record_access`, `hook_rules`, `record_rules` unchanged. **Delete the read-side equivalence tests** of the first
  attempt (read equivalence is the DB matrix's job); keep the evaluator only for update/delete/manage and shapes.
- [ ] Implement the generator and the JSON; `python3 scripts/gen_access_rules.py --write`; `--check`; pytest.
- [ ] Gates: `--check`, pytest. Commit `refactor(access): generator emits readers-based read rules and reader-term update/delete`.

**2b'. Readers tables, functions, triggers (first part of migration 166)**
- [ ] Preflight: the migration-number check of Global Constraints.
- [ ] Read first: spec section 2 ("The readers tables") and section 1 (the exact gate, the amnesty);
  `scripts/dev/access_matrix_fixture.sql` (`ref.*`); migration 139 (the `test_sessions.sample_id` sync trigger),
  migration 121 (`audit_trigger_function`: `SECURITY DEFINER`, pinned `search_path`), 141 and 165 (relations and hidden alias
  patterns); `scripts/configure_directus.sql`.
- [ ] **Tests first.** In `tests/phase1_schema.sh`: the six tables and their constraints; every coverage-table trigger
  exists (a list in the test); the functions exist, are `SECURITY DEFINER` where required with a pinned `search_path`; the
  readers tables are in `AUDIT_EXCLUDED` and not granted to `d1_llm_readonly`; the Directus metadata resolves and survives
  `configure_all.sh`; the backfill leaves `readers_drift()` empty. In `tests/readers_matrix.sh`: **one case per row of the
  spec's trigger-coverage table** and each mutation class of spec section 10 (including the multi-row, `COPY`, `TRUNCATE`,
  rollback, disabled-trigger and no-op-update cases, and the concurrent-session cases: session 1 inserts `campaign_samples (S, C)` while session 2 restricts C, committed in both orders, S correct afterwards, plus a forced lock-order deadlock that aborts one writer cleanly), each ending in an empty `readers_drift()` over
  all records plus one explicit effect; and the function = `ref.*` oracle on the 32 universes x 11 users. Watch them fail.
- [ ] **Functions.** Promote the `ref.*` helpers to `d1_private.*` (same shapes), apply the two intended changes once (the
  exact campaign gate S\*, the narrowed amnesty), write `readers_of_<type>` as candidates-then-predicate (base tables only,
  never a readers table), `operation_open_of`, `hidden_of`, `readers_closure`, `refresh_readers` (VOLATILE plpgsql; lock the sorted seeds and touches, expand the closure in a later statement, lock the added ids, then compute in a later statement; spec section 2, "Recompute"; diff, never delete-all),
  `readers_rebuild`, `readers_drift`,
  `readers_drift_count`, `is_hidden`. If a predicate is too slow at 14k operations, write a set-based version **behind the
  same signature** and keep the equivalence test green.
- [ ] **Triggers.** Per coverage-table row: statement-level `AFTER` triggers with transition tables, one per event (Postgres
  allows neither a column list nor several events with transition tables), the update function joining old and new and
  returning at once when no tracked column changed; seeds and touches exactly as the table says (OLD and NEW rows); the
  people trigger gathers every record referencing the person; `TRUNCATE` calls `readers_rebuild()`. **No visibility logic in
  a trigger.**
- [ ] **Metadata and housekeeping.** Hidden collections, relations with `one_field = 'readers'` / `'open_to_all'`, hidden
  alias fields, `scripts/configure_directus.sql` keeps them, no audit trigger, no grant to the LLM role; decide whether
  `v_schema_dictionary` lists them. **Backfill:** end the migration with `SELECT d1_private.readers_rebuild()` and a
  `NOTICE` of the row counts; `down` drops triggers, functions and tables and removes the metadata it added.
- [ ] **Oracle.** Update `access_matrix_fixture.sql`'s `ref.*` for the two intended changes only, and list in the report
  exactly which fixture expectations changed (the operations and tests of a sample that sits only in a restricted campaign,
  universes `k & 7 = 2`: C restricted, P and S not; O2 for its owner, OF2 for users the sample is shielded from) and that none changed for the amnesty
  narrowing.
- [ ] Gates: `bash scripts/dev/schema_test_docker.sh` with `ROUNDTRIP=1` (this migration) and the matrix test; phase1; the
  matrix green; `readers_drift()` empty after the backfill on the restored copy. **Record** the backfill time, the drift
  function's run time, and the time of one statement inserting 1000 operations with and without the triggers.
- [ ] Commit `feat(access): readers tables, visibility functions and recompute triggers (migration 166)`.

**2c'. Rollup (migration 167, in place)**
- [ ] Check `20261012000167_project_rollup_restricted.sql` against the new 166: it still refines the `project_rollup` row that
  166's rule block carries (the `restricted` column only exists from 167, so 166's snapshot of that row has no restricted test and
  167 overwrites it, as written); fix any header text that describes the old 166 contents. The statement trigger on
  `physical_samples UPDATE OF restricted` stays and is independent of the readers triggers. Check phase1's rollup assertions.
- [ ] Gates: `bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1 for 167); smoke rollup cases.
- [ ] Commit `refactor(access): migration 167 header follows the readers migration` (skip the commit if nothing needed changing).

**2d'. Lab Member rows, smoke, performance gate (second part of migration 166)**
- [ ] Append to `..166_record_readers_and_rules.sql` (after the readers part, so the aliases exist) the Lab Member rows: a snapshot of
  `python3 scripts/gen_access_rules.py --values` for every collection whose rule changed, in the style of 160/161: back up what
  it overwrites into `d1_private.lab_member_access_rules_backup` for `down`; update rows whose permissions or validation
  differ, insert missing rows (the five readers tables, `operation_open_to_all`, the five access tables); the header names the
  Directus restart and Redis flush and says it must be applied together with 167 and the Task 3 extensions; the `down` removes the rules block first, then the readers.
- [ ] **phase1**: the Lab Member rows equal the generator output (existing); the readers and access tables have no Lab Member
  write grants and read only own rows; no rule path outside the legal shapes (`--resolve` after the migrations and after
  `configure_all.sh`); migration 166 applies, reapplies, reverses to exactly the old rows.
- [ ] **Smoke cases** in `scripts/dev/directus_smoke.mjs` (`lm_*`), spec section 10: **the 41 cases of the first attempt must
  still pass** (run with the overlay command of Global Constraints; the expected ids come from the oracle, and the
  expectation changes of 2b' are listed in the report, not silently updated); the single-`EXISTS` read rules answer 200
  with correct ids, `filter_count`, paging and **no duplicates** for every ruled collection incl. the two-hop children; the
  amnesty leaf; update and delete ids are a subset of read ids; the role test works (viewer cannot `PATCH`, editor can); an
  operation under a restricted sample, and on a sample in a restricted campaign, is invisible to its owner; the cascade of
  spec section 1; a co-owner's `PATCH user_id` and `DELETE` of a `sample_co_owners` row are 403 (guard parts land in
  Task 3).
- [ ] **Performance gate** (on the smoke copy, the preview copy; never live). Load `scripts/dev/seed_access_fixture.sql`
  first (3 to 5 access rows on a realistic share of samples, campaigns and projects; restricted samples with operations
  and tests; a restricted campaign and a restricted project with contents; a sample in several campaigns of large
  projects), then `readers_rebuild()`. Measure, 20 requests each, p50 and p95, **before** (main's rules, the numbers of
  `task-2-report.md` are the baseline for the first attempt) **and after**, for a stranger and for a member (co-owner of a few
  samples, an investigator):
  - **Reads, all lists:** the operations, tests, campaigns, samples and projects indexes with `meta=filter_count`; the Home
    counts; a sample page's children and its campaigns list; the child lists **as the Force App queries them**
    (`GET /items/machining_force_analysis` as `apps/force-app/web/src/record/directusLookups.ts` builds it, `fast_run_data`,
    `operation_data_files`). **Limit: p95 under 300 ms per list request and no duplicates.**
  - **Writes, end to end (request or import wall time):** the FAST importer's bulk insert (`scripts/import_fast25.py`
    shape, a few thousand operations in one statement); the force crawler's writes (`scripts/force_orchestrator.py`); a
    Force App upload (`POST /files` then `machining_force_analysis`, the sequence of `uploadCapture.ts`); a **co-owner change
    on a big sample**. **Limit: at most 2x today's time** for each; also report, without a limit, restricting a large project
    and changing its PI (the cascades), with the closure sizes.
  - Record the table in the commit body, plus the backfill time, `readers_drift()` time and table sizes.
  - **If it fails:** `EXPLAIN (ANALYZE, BUFFERS)` on the slowest SQL first (enable Directus query logging on the copy);
    reads: indexes, or a different shape for the two-hop children; writes: row-level `AFTER UPDATE OF <tracked columns>`
    triggers on `manufacturing_operations` and `test_sessions` instead of the transition-table update triggers, or a
    set-based predicate, re-running the matrix. If it still fails, stop and report; do not ship.
- [ ] Gates: `--check`; pytest; `bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=2: migrations 166 and 167 together);
  the matrix test; the smoke run.
- [ ] Commit `feat(access): readers-based Lab Member rules and the performance gate (migration 166)`.

### Task 3: Guard hook, record-access endpoint, email (backend)

**Files:**
- Modify: `core/extensions/d1-access-guard/index.js`, `index.test.mjs` (rules.json is generated in Task 2)
- Create: `core/extensions/d1-record-access/{package.json,index.js,index.test.mjs}` (package.json shape from
  `core/extensions/d1-admin-overview`; `rules.json` is generated in Task 2). CI already runs
  `node --test core/extensions/*/index.test.mjs`, so no list to edit.
- Modify: `core/extensions/d1-admin-overview/{index.js,index.test.mjs}` (the readers drift count)
- Modify: `scripts/dev/directus_smoke.mjs` (endpoint, guard and drift cases)
- Modify: `docs/wiki/database/roles-and-permissions.md` and the access-guard header comment (behaviour changes).

**Interfaces (produces):** the routes of spec section 5.
- `GET /d1-record-access/:collection/:id` -> `{ restricted, owner, project_pi, can_manage, entries:[{ person_id, name, role, label, source:'access'|'co_owner'|'investigator', can_sign_in, added_by, added_at, blocked_by }] }`
- `POST .../entries {person_id, role}` -> `{ entry, email: 'sent'|'skipped'|'failed' }`; `PATCH .../entries/:person_id {role}`;
  `DELETE .../entries/:person_id`; `POST .../transfer {person_id}` -> `{ owner, email }`.
- Errors: 401 no user; 400 unknown collection, bad uuid or role (`investigator` only on projects, `edit` not on
  projects); 404 unreadable record; 403 `FORBIDDEN` with `extensions.source = 'd1-record-access'` when the caller may
  not manage; 409 adding the owner. Exported pure helpers for tests: `COLLECTIONS`, `roleLabel(collection, role, source)`,
  `mailContent({ adder, role, kind, code, title, link, transfer })`, `recordLink(publicUrl, collection, id)`,
  `recipientAddress(person, user)` (login email first), `withTimeout(promise, ms)`.
- Guard: `ownerGuards[collection] = { key, fields:[{field,valueKey?}], filter }`; an update naming any field with a
  changed value must pass the delete rule (403 `extensions.kind` `'owner'` or `'restricted'`); `restrictedKeys`
  (spec section 4, item 2) and the `campaign_samples` / `test_sessions_subject` restricted-aware rule; junction guards
  use the parent's delete rule for `sample_co_owners` and `project_investigators`.
- Admin overview: `GET /d1-admin-overview` gains `readers_drift: { count, checked_at }` from `d1_private.readers_drift_count()`;
  a non-zero count is flagged in its output. If `readers_drift()` takes more than a second on the seeded copy (Task 2b's
  recorded time) the value is cached for a minute and `?refresh=1` recomputes. No rebuild endpoint: repair is `SELECT
  d1_private.readers_rebuild()` by an operator.
- Endpoint: `blocked_by` is read from the parents' readers tables (the login) or, for a person with no login, their entry in
  the parent's access list; the writes fire the readers triggers in the same transaction, so the response and the next
  read are consistent; after commit the endpoint clears the Directus data cache when `CACHE_ENABLED` is on (knex writes bypass
  the services that do it; check how Directus 11.17 exposes the cache to an endpoint before coding).

- [ ] Tests first, guard (`index.test.mjs`, existing style): `restricted` changed by the owner, a co-owner, a Can edit
  person, an admin and an internal call; unchanged value passes; batch update is checked per key; campaigns guarded;
  the co-owner and investigator junction guards refuse a co-owner and accept the owner; **restricted-sensitive keys**:
  an editor changing `project_id`/`campaign_id`/`sample_id` of a restricted record, out of or into a restricted
  project, campaign or sample, is 403 and the owner passes; a non-restricted move by an editor still passes; adding a
  restricted sample to a campaign needs the sample's owner; a subject row on a test whose sample is restricted needs
  the test's owner; messages.
- [ ] Tests first, endpoint (fake `ItemsService`, `MailService`, knex like `d1-admin-overview`'s tests): 401; the
  collection whitelist; 404 on unreadable; manage matrix per role (owner, co-owner, Can edit, viewer, stranger, admin,
  no-owner record is admin-only); add sends exactly one mail, a role change none, self-add none, a person with no
  address skips, **a legacy co-owner re-added sends none**; **recipient is the login email when there is a login,
  the People email only for a login-less person**; a `MailService` that throws or **hangs (fake timers, 10 s)** still
  returns the change with `email: 'failed'`; mail content is HTML-escaped and carries the adder, role, record and
  link; entries merge the access table with `sample_co_owners` and `project_investigators` rows to the strongest role,
  and every write deletes the person's old-table row in the same transaction; `blocked_by` (from the readers tables) names a restricted parent
  that does not list the person; `set_config('d1.actor_identity', ...)` is issued first in the write transaction;
  transfer keeps the previous owner (Secondary investigator on a project), drops the new owner's rows and emails the
  new owner with its own subject; the data cache is cleared after a change when caching is on; the link map equals the five d1-home routes (and a d1-ui test pins it against
  `recordRoute`, added in Task 4); two-user isolation (a user never gets another record's list).
- [ ] **Check the Directus 11.17 `MailService.send` signature** in the image the smoke harness runs (a read-only
  `docker exec ... grep` of the installed `@directus/api`): which of `html`, `text` and `template` is accepted, whether
  the base template wraps `html`. Code to what is there; if `html` needs a template, add one `.liquid` file in the
  extension folder and pass `template`. Note the finding in the report.
- [ ] Implement the guard changes and the endpoint (system accountability only after the manage check; one knex
  transaction; mail after commit, inside try/catch and a 10 s timeout; read env `PUBLIC_URL`).
- [ ] Smoke cases (with the overlay command): as owner add a login-less person (no mail address) and a person with an
  address (the smoke Directus has no mail server, so assert `email` is `failed` or `skipped` and the change stands); list
  as a viewer (`can_manage = false`); `PATCH /items` of `restricted` as the owner (200) and as an editor (403); an
  editor's `PATCH project_id` of a restricted sample (403); a co-owner's `PATCH`/`DELETE` of a `sample_co_owners` row
  (403); a change through the endpoint is readable immediately as the added person (read-your-write); the admin overview
  reports a drift count of 0 after each case.
- [ ] Tests first, admin overview (`core/extensions/d1-admin-overview/index.test.mjs`): the drift count is returned, a non-zero
  count is flagged, the cached value is refreshed by `?refresh=1`, a non-admin still gets 403.
- [ ] Gates: `node --test core/extensions/d1-access-guard/index.test.mjs core/extensions/d1-record-access/index.test.mjs core/extensions/d1-admin-overview/index.test.mjs`;
  `python3 scripts/gen_access_rules.py --check`; the smoke run.
- [ ] Commit `feat(access): owner-only restricted guard and the d1-record-access endpoint with email`.

### Task 4: The dialog, the button, the hidden-count texts (frontend)

**Files:**
- Create: `packages/d1-ui/src/access/{accessModel.ts,accessModel.test.ts,accessApi.ts,accessApi.test.ts}`,
  `packages/d1-ui/src/components/AccessDialog.vue`
- Modify: `packages/d1-ui/src/host.ts` (`ExplorerHost.api` gains `post`, `patch`, `delete`),
  `packages/d1-ui/src/index.ts` (exports), `packages/d1-ui/src/mine.ts` and `mine.test.ts`,
  `packages/d1-ui/src/campaign/{CampaignProgress.vue,SamplesPanel.vue,rollup.ts}` and their tests,
  `packages/d1-ui/src/life.ts`, `life.test.ts`, `core/extensions/d1-home/src/pages/sample/LifeStrip.vue`
  (the d1-trace boolean consumer; the d1-trace change itself is in Task 5, so land the kit side tolerant of both shapes
  or coordinate the two commits)
- Modify: `core/extensions/d1-home/src/explorerHost.ts` (already hands over the SDK's axios; only the type changes),
  `core/extensions/d1-home/src/pages/{Sample,Operation,Test,Campaign,Project}Page.vue` (button and dialog)

**Interfaces (produces):**
- `accessModel.ts` (pure): `ROLE_LABELS(collection)` (projects: Can view, Secondary investigator), `entryLabel(entry)`,
  `sortEntries`, `canChangeRole(entry, canManage)`, `peopleSearchQuery(text)` (active people, name search, limit),
  `isLoginless(person)`, `transferConfirmText(from, to, collection)`, `noManagerText(owner)` (admin-only variant for a
  record with no owner), `blockedText(entry)`, `RECORD_LINK_KINDS` (kind -> route segment, pinned against `recordRoute`
  in a test), `RESTRICT_UI = false`.
- `accessApi.ts`: `loadAccess(api, collection, id)`, `addEntry`, `setRole`, `removeEntry`, `transfer`, `searchPeople`,
  each returning plain data or a message string from the endpoint's error.
- `AccessDialog.vue` props: `modelValue`, `collection`, `id`, `title`; emits `changed`. Shows the list for everyone who
  can read the record and the controls only when `can_manage`; the Restrict toggle only when `RESTRICT_UI`.
- `mine.ts`: `coOwnedByMe` also matches an access row of this person with role edit, and `projectsMine` a `project_access` row with
  role `investigator`. **The role test is an AND of two bare paths through the same alias**, `{_and: [{access: {person_id:
  {user_id: {_eq: $CURRENT_USER}}}}, {access: {role: {_eq: 'edit'}}}]}`, never `access: {_some: {person_id: ..., role: ...}}`:
  Directus reads a relation key by its first key only (the `role` would be silently dropped, so every viewer would count as
  a co-owner) and a `_some` body must be one plain chain (spec section 3, Directus constraints). These are explicit filters
  sent to `/items`; the aliases join once per query path, so both conditions hold on the same row.
- Campaign texts: "Some samples in this campaign are hidden from you" (no number) in `CampaignProgress` and
  `SamplesPanel`; `hiddenSampleCount` stays as the boolean-style helper. `life.ts` `hiddenMarker` prints "some records
  hidden" and accepts a boolean.

- [ ] Tests first (`accessModel.test.ts`, `accessApi.test.ts`, `mine.test.ts`, campaign and `life` tests, vitest): labels
  per collection (sample Can edit reads "Co-owner · can edit"; project has Can view and Secondary investigator only),
  ordering (owner first), `canChangeRole`, the login-less marker, the confirm text, the no-owner and blocked texts, the
  people-search query, the api wrappers surface the endpoint's message, `RESTRICT_UI` is `false` (a test pins it so A1b
  flips it deliberately), the route map equals `recordRoute`, `mine` filters include the access rows **in the legal form** (a test walks the filter: no sibling key beside a relation key, no `_some` with two conditions, no `_some` below the root), the campaign and
  life texts contain no digits.
- [ ] Implement the model, api and component. Keyboard: Escape closes, focus is trapped, the add box is a combobox with
  aria labels, every button names its person ("Remove Edith Ford"). Use the kit's tokens and the `EditDrawer` modal
  conventions; read `packages/d1-ui/src/components/EditDrawer.vue` and `.claude/skills/directus-ui-conventions` first.
  Transfer asks for confirmation in a second step with the confirm text. After every change refetch the list and emit
  `changed`. A failed email shows "Added. The email could not be sent."
- [ ] Add the button to the five pages' `RecordRail` `#actions` slot and the dialog beside `EditDrawer`; the operation
  page uses its own label helpers for the title.
- [ ] Gates: `npx vitest run` in `packages/d1-ui`; `vue-tsc` in `packages/d1-ui` and `core/extensions/d1-home`; d1-home
  build (`npm run build` in `core/extensions/d1-home`); `noSdkImports.test.ts` green.
- [ ] Preview as a Lab Member owner and as a co-owner with the repo's explorer preview (`scripts/dev/explorer_preview.sh`,
  see its header for the overlay variable): the owner sees the controls, the co-owner sees the list only, a login-less
  person can be added, nothing shows a Restrict toggle. One screenshot per state is enough.
- [ ] Commit `feat(d1-home): Who has access dialog on the record pages, "some hidden" texts`.

### Task 5: Close the bypasses and clean up (migration 168, d1-trace, legacy roles, docs, runbook)

**Files:**
- Create: `db/migrations/20261012000168_llm_role_row_security.sql`
- Modify: `core/extensions/d1-trace/index.js`, `index.test.mjs`
- Modify/Delete: `core/roles.json`, `core/permissions.json`, `core/apply.sh`, `core/README.md`; and every reference found
  by the grep below (known: `docs/adr/0005-directus-rbac-structure.md`, `docs/adr/0011-row-level-visibility.md`,
  `docs/wiki/database/roles-and-permissions.md`, `docs/wiki/database/developer-guide.md`, `docs/api-contract.md`,
  `docs/runbooks/heavy-data-pipeline.md`, `.env.example` (Operator token), the phase4 `MACHINE_TOKEN` note,
  `.claude/skills/ci-local/SKILL.md`)
- Create: the next free ADR number in `docs/adr/` (0013 unless taken), "Record access", amending 0011 (paths that
  bypass, known gaps, the choices of the spec); update `docs/adr/README.md`; extend
  `docs/wiki/database/roles-and-permissions.md` and `docs/runbooks/physical-test-backlog.md` (the two-user checklist of
  spec section 10); finish `docs/runbooks/a1-record-access-cutover.md` with the real migration numbers and any timings
  from Task 2
- Modify: `CONTRIBUTING.md` and `.claude/skills/db-migration/SKILL.md`: **"any later `CREATE OR REPLACE VIEW` of a view
  granted to `d1_llm_readonly` must be created `WITH (security_invoker = true)`; `CREATE OR REPLACE` without it resets the
  option and silently re-opens the bypass"**
- Modify: `tests/phase1_schema.sh`, `tests/phase6_text_to_sql.sh` (RLS assertions)

**Interfaces (produces):**
- Migration 168: for **every table migration `20261003000132` grants the role** (list in spec section 7; record-bound vs
  reference): `ENABLE ROW LEVEL SECURITY` on each record-bound table, a **permissive `FOR ALL TO PUBLIC USING (true) WITH
  CHECK (true)`** policy and an `AS RESTRICTIVE FOR SELECT TO d1_llm_readonly` policy. **The five record tables' policy is
  one line, `NOT d1_private.is_hidden('<collection>', <pk>)`**: `is_hidden` and the `hidden_records` table it reads are
  built and maintained by migration 166 (the same recompute and triggers as the readers tables, spec section 7), so this
  migration holds no restriction logic of its own and no hand-written parent subqueries; the table is not granted to the
  role, `EXECUTE` on `is_hidden` is. Children: `<fk> IN (SELECT <pk> FROM <parent>)`, both ends for `campaign_samples` and
  `sample_genealogy`; `project_rollup`: `NOT restricted` and the project visible; `semantic_embeddings`: `CASE source_table
  ... ELSE false END`. `ALTER VIEW ... SET (security_invoker = true)` for **all nine** granted `v_*` views
  (including `v_project_rollup`, which is granted without it); `down` drops policies, disables RLS and resets the views.
  Do not `FORCE` row security. The (dropped) `*_params` tables have no policy: there is nothing to add.
- d1-trace: `hidden: { stock_origins: boolean, ancestors: boolean, events: boolean, descendants: boolean }`.

- [ ] **Inventory first (widely).** Roles that touch these tables are not all in migrations: grep
  `grep -rIn "d1_embedder\|d1_llm\|CREATE ROLE\|GRANT .* TO\|postgres://" docs .env.example docker-compose.yml infra scripts plugins db/migrations tests`
  and list every role and URL found; read `docs/runbooks/text-to-sql.md` and `.env.example` (`d1_embedder` has
  `SELECT, INSERT, UPDATE` on `semantic_embeddings`). Check `semantic_embeddings` rows' `source_table` values
  (`SELECT DISTINCT source_table` on the smoke copy) so the CASE covers every real source. Put the findings in the report.
- [ ] **phase1 / phase6 assertions first**, on a fixture with a restricted sample (with an operation, a test,
  file links, a force analysis), an unrestricted one, and a tree under a restricted project and campaign: as
  `SET ROLE d1_llm_readonly`, counts through the tables and through `v_*` views exclude every restricted tree; the owner
  role (`d1`) sees everything; `d1_llm_app` (member) is covered by the same policies; **a role with `d1_embedder`'s
  grants can still INSERT and `INSERT ... ON CONFLICT DO UPDATE` `semantic_embeddings` after the migration**; **every
  table granted to `d1_llm_readonly` has RLS enabled or is in the named reference list** (so a new grant without a
  policy fails); **every view granted to `d1_llm_readonly` has `security_invoker=true` in `pg_class.reloptions`**;
  the SQL guard still rejects `SELECT d1_private.is_hidden(...)` (schema-qualified calls and non-public schemas); a flip of `restricted` (and a move into a restricted campaign) changes what the role sees at once (the recompute keeps
  `hidden_records` in step); migration 168 applies, reapplies and reverses cleanly.
- [ ] Implement migration 168. Gate: `bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1) and, if the harness supports
  it, `tests/phase6_text_to_sql.sh`.
- [ ] **d1-trace**: tests first (booleans, still `truncated`), then change the endpoint; the kit side landed in Task 4;
  `npx vitest run` in `packages/d1-ui`; `node --test core/extensions/d1-trace/index.test.mjs`.
- [ ] **Legacy roles.** Confirm nothing reads `core/roles.json` and `core/permissions.json`:
  `grep -rIn "roles.json\|permissions.json\|apply\.sh" --exclude-dir=node_modules --exclude-dir=.git .`, then check
  `Makefile`, `.github/workflows`, `docker-compose.yml`, `.pre-commit-config.yaml`, `scripts/` and `tests/`
  individually. `core/apply.sh` reads both files (it creates the Operator machine user and prints the token that
  `.env.example` and the heavy-data runbook mention): decide with the findings whether to delete it or rewrite it to
  create a machine user on the Administrator role, and **stop and ask the maintainer** if anything outside the
  documentation and the script depends on the Operator role or its token. Live has only Administrator, Lab Admin and
  Lab Member. Then delete the two files (and `apply.sh` if retired) and fix every reference.
- [ ] Docs: the ADR, the wiki page, the physical-test checklist, the migration skill and CONTRIBUTING rule, the cutover
  runbook (four migrations; the backfill time and drift-check time recorded in Task 2b'; a step that runs `SELECT count(*) FROM
  d1_private.readers_drift()` after the migrations and after any restore, and says to run `d1_private.readers_rebuild()` if it
  is not zero), `docs/data-dictionary.md` (the readers tables, `operation_open_to_all`) if Task 1 left anything.
- [ ] **Final gates** (all must be green; `ROUNDTRIP=4` = the four new migrations):
  `bash scripts/dev/schema_test_docker.sh` with `ROUNDTRIP=4`; `python3 scripts/gen_access_rules.py --check`;
  `python3 -m pytest tests/scripts/test_access_rules.py`; `npx vitest run` in `packages/d1-ui`;
  `node --test core/extensions/*/index.test.mjs`; the smoke run with `D1_SMOKE_REQUIRE_LM=1` and the overlay list;
  `pre-commit run --all-files` (or the repo's `ci-local` skill). Merge `origin/main` once more first and re-check the
  migration numbers.
- [ ] Commit `feat(access): Ask-DB row security, d1-trace hidden flags, retire the Phase 3 role files (migration 168)`.

---

### After the tasks: final review, preview, PR

Final review by Opus with one fix round (see the repo's token-economy practice: small reviews on Haiku, implementers
on Sonnet). Review the generated filters by eye (the read rules are one `readers._some`; the update and delete filters carry the reader term) and the readers function for the operation cases (unrestricted; restricted; under a restricted
sample; under a restricted campaign and project). Preview with two Lab Member users and an admin; confirm the Force App
still records on a sample the user can see, and that nothing in any UI shows the Restrict switch. Open the PR (draft),
stacked on the base that carries migrations up to 164, and list in its body: the A1a-to-A1b window in which a
restricted operation's files and octrees are still reachable by id, the deliberate change that co-owners can no longer
add, change or remove co-owners, the performance numbers, and the "to confirm" items of spec section 11. Do not merge or
apply anything live: the maintainer follows `docs/runbooks/a1-record-access-cutover.md`, which deploys the extensions
and the four migrations together, flushes Redis and restarts Directus once, then checks the admin overview's drift count is zero.
