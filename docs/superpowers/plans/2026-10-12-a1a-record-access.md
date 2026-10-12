# A1a Record Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Who has access" dialog on the five Explorer record pages (add and remove people, transfer ownership, email
on add), and a per-record **Restricted** model in the database and the Lab Member rules (a restricted sample hides its
operations and tests; a restricted campaign or project hides what is inside it; params, rollup, Ask-the-database and
d1-trace follow), with the Restrict switch **hidden in every UI** until A1b.

**Architecture:** Migration 165 adds `restricted` to five tables and five person-keyed access tables, each with a
hidden top-level `access` O2M alias. `access_rules.json` and `gen_access_rules.py` learn AND, literal leaves, role
tests and same-row `each` groups (sets become trees); migration 166 applies the regenerated Lab Member rows and
migration 167 adds `project_rollup.restricted`. `d1-access-guard` gains owner-only `restricted`, restricted-sensitive
keys and manage-rule junction guards. A new endpoint extension `d1-record-access` is the only writer of the access
tables and sends the email through Directus's `MailService`. The kit holds the pure model and the dialog; d1-home
places the button. Migration 168 gives the Ask-DB role row-level security.

**Tech Stack:** Postgres 16 + dbmate, Directus 11.17 (endpoint and hook, plain ESM JS, node:test), Vue 3 + TS kit with
vitest, Python 3 (generator and pytest), bash harnesses.

**Spec:** `docs/superpowers/specs/2026-10-12-record-access-design.md`
**Live apply:** `docs/runbooks/a1-record-access-cutover.md` (maintainer-run; this plan never touches live).

## Global Constraints

- **Migration numbers.** `20261012000163_user_usage.sql` is on `origin/main` and live (PR #246);
  `20261012000164_label_templates.sql` is on `feat/label-printing` and `feat/label-scan`. As of 2026-10-12 the highest
  number on any branch is 164, so A1a takes **165 to 168**: `..165_record_access.sql`,
  `..166_lab_member_record_access_rules.sql`, `..167_project_rollup_restricted.sql`,
  `..168_llm_role_row_security.sql`. **Before writing the first migration**: (1) `git fetch origin`, then merge
  `origin/main` into `feat/record-access` (this branch was cut before 163 existed; dbmate silently skips a
  lower-numbered file once a higher one is recorded); (2) re-run
  `for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin refs/heads); do git ls-tree -r --name-only $b db/migrations; done | sed 's|.*/||' | sort | tail -3`
  and take the next four free numbers, renumbering this plan's names if another branch has taken any; (3) **merge
  `origin/main` again before applying anywhere** and re-check. The `ROUNDTRIP` count in every gate equals the number
  of new migrations in that task (Task 1: 1, Task 2: 2, Task 5: 1, final gate: 4).
- **Directus 11.17 rejects a `_some` that is not directly under a top-level O2M** of the collection being filtered
  (`"_some" can only be used with top level relational alias field`; read the header of migration
  `20261010000160_lab_member_some_only_where_directus_accepts_it.sql`). `gen_access_rules.py path_filter()` keeps a
  `_some` only at path index 1 or right after another legal one and drops the rest; a dropped `_some` is a bare
  to-many hop, which means "any joined row". Use it **only for positive membership tests** (never `_none`); conditions
  that must hold on one row of a to-many use the `each` item. A legal `_some` subquery applies the related
  collection's own Lab Member rule, so an access table's rule must not recurse into its parent's read rule: Lab
  Member reads only rows about themselves (`person_id.user_id = $CURRENT_USER`). Every new rule must be proven on the
  Directus smoke harness (200, correct rows, no duplicates, `filter_count` agrees), not only in Postgres.
- **The Restrict switch stays hidden.** `restricted` is a hidden, read-only field in `directus_fields`; the dialog's
  toggle is behind `RESTRICT_UI = false`. No A1a code path renders it.
- **Writes to the access tables only through the endpoint.** Lab Member has no create, update or delete grant on
  them. The endpoint checks the manage rule (the record's delete rule from the generated `rules.json`) in the same
  request, then writes with system accountability. Admins manage any record.
- **Old tables stay (decision 17).** `sample_co_owners` and `project_investigators` remain honoured (union with the
  new tables in every set), shown in the dialog, and their row for a person is deleted by the dialog's writes. No
  backfill and no consumer rewrite beyond `mine.ts`. Retiring them is the A2 follow-up, not this plan.
- **Unrestricted records behave exactly as today** when their access lists are empty: a test compares the new
  generated filters with today's on the fixture (same visible ids for every user when nothing is restricted and no
  access rows exist). The one intended difference: `sample_co_owners` update and delete become owner-only.
- **The smoke harness must load the worktree's code.** `scripts/dev/directus_smoke.sh` mounts the main checkout's
  extensions and overlays only `d1-next-number`. Task 2 adds `D1_SMOKE_OVERLAYS` (a space-separated list, default
  `d1-next-number`) and **every A1a smoke run is
  `D1_SMOKE_REQUIRE_LM=1 D1_SMOKE_OVERLAYS="d1-next-number d1-access-guard d1-record-access d1-trace" bash scripts/dev/directus_smoke.sh`**.
- **No live access.** Never touch the live containers or database. Harnesses restore a read-only dump into a
  throwaway copy; follow `scripts/dev/directus_smoke.sh` as written. Seed data goes into the copy only.
- Kit files never import `@directus/extensions-sdk` (`noSdkImports.test.ts`). The dialog uses `EXPLORER_HOST.api`.
- No emojis in code, UI text or commits. UI wording is plain ("Who has access", "Can view", "Can edit", "Secondary
  investigator", "can't sign in yet", "some records hidden").
- Commit per task (Task 2: per sub-step) with the message given; end each commit message with the attribution line
  the harness provides.

## Review Focus

1. **Restricted never widens.** For every collection and every fixture user, update and delete visible ids are a
   subset of read visible ids; a restricted sample's operations, tests, file rows, analyses and params are invisible
   to anyone not on its list, including the operation's own owner; a restricted project or campaign hides what is
   inside it per spec section 1.
2. **The `_some` rule.** No generated filter has a `_some` anywhere but index 1 / after a legal `_some`; every `via`
   is an M2O; the role test inside a legal `_some` and the same-row `each` groups work on a real Directus (viewer
   cannot update, editor can; no duplicates).
3. **Manage = owner (PI) or admin, nothing else.** A co-owner, a Can edit person cannot add, change or remove
   anyone (including through `PATCH`/`DELETE` of `sample_co_owners`), change `restricted`, move a restricted record
   by changing `project_id`/`campaign_id`/`sample_id`/subject rows, or hand the record over, by endpoint or by
   `PATCH /items`.
4. **The email can never block or leak.** A throwing or hanging mail service still returns the change; no mail to the
   adder, to a person with no address, or on a role change; the recipient is the login email when there is a login;
   every interpolated value is escaped; the link is `PUBLIC_URL/admin/home/<kind>/<id>`.
5. **Ask-DB** sees nothing of a restricted tree through tables or `v_*` views; `d1_embedder` can still write
   `semantic_embeddings`; Directus (table owner) and the migrations are unaffected; every granted table has RLS or is
   named reference, and every granted view is `security_invoker`.
6. **Performance gate** (Task 2): on a seeded copy, p95 under 300 ms per list request as a stranger and as a member,
   no duplicates; EXPLAIN first, then the fallback.
7. **Deleting `core/roles.json` and `core/permissions.json`** leaves nothing that reads them.

---

### Task 1: Schema (migration 165) and Directus metadata

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

### Task 2: Rules engine, Lab Member rows, params, rollup, performance gate (migrations 166 and 167)

Delivered as **three commits** (2a, 2b, 2c), each reviewable on its own.

**Files:**
- Modify: `scripts/gen_access_rules.py`, `scripts/access_rules.json`
- Modify: `tests/scripts/test_access_rules.py`, `tests/phase1_schema.sh`, `scripts/dev/directus_smoke.mjs`,
  `scripts/dev/directus_smoke.sh` (the `D1_SMOKE_OVERLAYS` list: loop over it, mounting
  `-v "$REPO/core/extensions/$o:/directus/extensions/$o:ro"` for each, default `d1-next-number`; mount whole folders so
  the worktree's `rules.json` files travel with the overlay)
- Create: `db/migrations/20261012000166_lab_member_record_access_rules.sql`,
  `db/migrations/20261012000167_project_rollup_restricted.sql`, `scripts/dev/seed_access_fixture.sql` (copy only,
  parameterised, never run against live)
- Regenerate: `scripts/configure_users_and_policies.sql` (block), `core/extensions/d1-access-guard/rules.json`, new
  `core/extensions/d1-record-access/rules.json` (`gen_access_rules.py --write`)
- Modify: `.pre-commit-config.yaml` (add `core/extensions/d1-record-access/rules.json` to the
  `access-rules-in-sync` `files:` regex) and `.github/workflows/ci.yml` only if it names the old file list

**Interfaces (produces):** the item kinds and sets of spec section 3.
- Generator: a set is a list (OR) or `{"and": [...]}`; items: user-leaf string, `{"set","via"}`,
  `{"path","at","where":{col:[values]}}`, `{"field","eq"}`, `{"field","null"}`, `{"unless_restricted":[...]}`,
  `{"each","items"}`, `{"and":[...]}`, `{"or":[...]}`. Build a tree, distribute `via` onto leaves, flatten last.
  `path_filter()` legality rule unchanged. `amnesty_filter()` takes `{"null":[...],"restricted_false":true,"also":"<set>"}`.
  `owner_guards` entries become `{"key","fields":[{"field","value_key"?}]}`; a new `restricted_keys` section; `resolve()`
  and the update-vs-delete safety net understand the new kinds and assert every `via` is an M2O. `hook_rules()` also
  emits the d1-record-access rules file (`{collection: {table, fk, read, manage, ...}}` for the five record types plus
  their access tables).
- `access_rules.json`: every set of spec section 3 (gates `project.listed/pass/invs`, `has.project_ok`,
  `campaign.listed/pass`, `has.campaign_ok`, `sample.listed/pass`, `record.gates`; `sample.inherited/read/editors/owner`,
  `link.sample.owner`; `record.listed/inherited/read/editors/update/delete`; `campaign.inherited/read/update/manage/owner`;
  `project.inherited/read/pi/investigators`; `campaign_samples.read`; `rollup.read`); `rules` entries per spec
  (`sample_co_owners` update and delete -> `link.sample.owner`; campaigns `update: campaign.update`,
  `delete: campaign.manage`; operations and tests `delete: record.delete`); the params tables move from `unfiltered` to
  `rules` (`operation_id` -> `operation.read/update`, `session_id` -> `session.read/update`, delete follows update); the
  five access tables get `custom` rows (read: person is me; no create/update/delete); `orphan_amnesty` in the new
  shape; `guards.sample_co_owners` and `guards.project_investigators` get `"rule": "delete"`; `owner_guards` for
  samples, operations, tests and campaigns, each with `fields` incl. `restricted`; `restricted_keys` per spec section 4.
- `project_rollup.restricted BOOLEAN NOT NULL DEFAULT false` (cache table), filled by `refresh_project_rollup()` from
  `v_project_rollup` plus the rule in spec section 3; `v_project_rollup` gains `restricted` as its last column
  (`CREATE OR REPLACE VIEW` may only append; start from the newest definition, find it with
  `grep -rn "v_project_rollup" db/migrations`; **if the view is granted to the LLM role, re-set
  `security_invoker`**, see Task 5); a statement trigger on `physical_samples` UPDATE OF restricted (operations and
  campaigns already fire the refresh).

**2a. Engine (pure, fast; no database)**
- [ ] **Params and relations first.** Check that `directus_relations` has `operation_id` -> `manufacturing_operations`
  for the five process params tables and `session_id` -> `test_sessions` for the six test params tables; if a row is
  missing it is added in migration 166 (RAISE if one points elsewhere).
- [ ] **Generator tests first** (`tests/scripts/test_access_rules.py`): tree flattening; `via` distributed onto
  `unless_restricted` and `field` leaves (`{"sample_id": {"restricted": {"_eq": false}}}`); `where` placement for a
  legal `_some` (sibling of the user leaf in the `_some` body) and a dropped one; `each` legal and dropped forms
  (same-row grouping); `and` sets keep their AND under `via`; no `_some` outside index 1 / after a legal `_some` in any
  generated rule (walk every output); every `via` is an M2O (`resolve()` fails on a to-many `via`); amnesty with the
  extra gate; owner-guard `fields`; the update-wider-than-delete net fires for campaigns without an entry;
  `resolve()` for a missing `restricted` column or `at` alias. **Equivalence tests with a fixture evaluator** (small,
  in the test file) that **models Directus, not SQL intuition**: inside a legal `_some` it also applies the related
  collection's own read rule, and a dropped `_some` is an any-row join on one alias. With it: (i) the new filters give
  **exactly today's visible ids** for every fixture user when nothing is restricted and no access rows exist
  (intended difference listed: `sample_co_owners` update/delete); (ii) restricted never widens (update/delete subset of
  read) over the full restricted/unrestricted matrix of spec section 10; (iii) a legacy co-owner and an access-edit
  person see exactly the same ids everywhere (incl. the project page, I7); (iv) the cascade table of spec section 1,
  case by case (restricted project, restricted campaign, sample in two campaigns, orphan FAST operation).
- [ ] Implement the generator and the JSON. `python3 scripts/gen_access_rules.py --write`; run `--check`,
  `--resolve` (on a dump from the phase1 harness) and `python3 -m pytest tests/scripts/test_access_rules.py`.
- [ ] Gates: `--check`, pytest. Commit `feat(access): rules engine with gates, role tests and same-row groups`.

**2b. Lab Member rows, smoke, performance gate (migration 166)**
- [ ] **Migration 166**: a snapshot of `python3 scripts/gen_access_rules.py --values` for every collection whose rule
  changed, in the style of 160/161: back up what it overwrites into `d1_private.lab_member_access_rules_backup` for
  `down`; update rows whose permissions or validation differ, insert missing rows (the five access tables); header
  comment names the Directus restart and Redis flush and says it must be applied together with the Task 3 extensions.
- [ ] **phase1**: the Lab Member rows equal the generator output (existing); params rows ruled; access tables have no
  Lab Member write grants; drift checks include the new rules file; migration 166 applies, reapplies, reverses to
  exactly the old rows.
- [ ] **Harness**: implement `D1_SMOKE_OVERLAYS` in `directus_smoke.sh`.
- [ ] **Smoke cases** in `scripts/dev/directus_smoke.mjs` (`lm_*`): build the fixture matrix of spec section 10 in the
  copy; for each user and collection compare `GET /items/<collection>` ids, `meta=filter_count` and a second page
  against a plain-SQL evaluation; every ruled collection answers 200; no duplicate ids with a three-person access list
  and a sample in several campaigns; viewer cannot `PATCH`, editor can; a sample-restricted operation is invisible to its
  own owner; the restricted project/campaign cascade of spec section 1; params follow their operation; a co-owner's
  `PATCH user_id` and `DELETE` of a `sample_co_owners` row are 403 (guard parts of this land in Task 3 and are added
  there). Run with the smoke command in Global Constraints.
- [ ] **Performance gate** (on the smoke copy, the preview copy; never live): load `scripts/dev/seed_access_fixture.sql`
  first (3-5 access rows on a realistic share of samples, campaigns and projects; restricted samples with operations and
  tests; a restricted campaign and a restricted project with contents; a sample in several campaigns of large
  projects). Then time, for **a stranger** (member with no involvement) and **a member** (co-owner of a few samples and
  an investigator), before (main's rules) and after: the Explorer's operations, projects and campaigns index queries
  with `meta=filter_count`, the Home counts, and a sample page's children lists. 20 requests each, p50 and p95. **Limit:
  p95 under 300 ms per list request, and not more than 2x today's median.** Record the table in the commit body.
  **If it fails: run `EXPLAIN (ANALYZE, BUFFERS)` on the slowest SQL first** (enable Directus query logging on the
  copy), look at the dominant join and the indexes (`project_investigators(project_id)`, `campaign_samples(sample_id)` and
  `(campaign_id)`, `sample_co_owners(sample_id)`, `*_access(person_id)`), add indexes in migration 166 and re-measure;
  only then take the fallback of spec section 11 (per-record gate tables), as an extra migration and generator output in
  this task, and re-measure. If it still fails, stop and report; do not ship.
- [ ] Gates: `--check`; pytest; `bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1 for 166); the smoke run.
- [ ] Commit `feat(access): restriction-aware Lab Member rules and params (migration 166)`.

**2c. Rollup (migration 167)**
- [ ] phase1 assertions first: an operation under a restricted sample and a restricted operation (or one in a
  restricted campaign) are `restricted = true` in the cache after the refresh; a tool used only by restricted
  operations is restricted; flipping a sample's flag refreshes the cache; the PI reads every row, an investigator only
  `restricted = false` rows (extend the smoke cases).
- [ ] Implement migration 167 (column, view, refresh function, trigger; `down` restores the old view and function).
- [ ] Gates: `bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1); smoke run.
- [ ] Commit `feat(access): project rollup carries restricted (migration 167)`.

### Task 3: Guard hook, record-access endpoint, email (backend)

**Files:**
- Modify: `core/extensions/d1-access-guard/index.js`, `index.test.mjs` (rules.json is generated in Task 2)
- Create: `core/extensions/d1-record-access/{package.json,index.js,index.test.mjs}` (package.json shape from
  `core/extensions/d1-admin-overview`; `rules.json` is generated in Task 2). CI already runs
  `node --test core/extensions/*/index.test.mjs`, so no list to edit.
- Modify: `scripts/dev/directus_smoke.mjs` (endpoint and guard cases)
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
  and every write deletes the person's old-table row in the same transaction; `blocked_by` names a restricted parent
  that does not list the person; `set_config('d1.actor_identity', ...)` is issued first in the write transaction;
  transfer keeps the previous owner (Secondary investigator on a project), drops the new owner's rows and emails the
  new owner with its own subject; the link map equals the five d1-home routes (and a d1-ui test pins it against
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
  (403).
- [ ] Gates: `node --test core/extensions/d1-access-guard/index.test.mjs core/extensions/d1-record-access/index.test.mjs`;
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
- `mine.ts`: `coOwnedByMe` also matches `access: { _some: { person_id: { user_id: $CURRENT_USER }, role: { _eq: 'edit' } } }`,
  and `projectsMine` also matches `project_access` role `investigator`. Explicit filters sent to `/items`, so their
  `_some` sits at the top of the collection.
- Campaign texts: "Some samples in this campaign are hidden from you" (no number) in `CampaignProgress` and
  `SamplesPanel`; `hiddenSampleCount` stays as the boolean-style helper. `life.ts` `hiddenMarker` prints "some records
  hidden" and accepts a boolean.

- [ ] Tests first (`accessModel.test.ts`, `accessApi.test.ts`, `mine.test.ts`, campaign and `life` tests, vitest): labels
  per collection (sample Can edit reads "Co-owner · can edit"; project has Can view and Secondary investigator only),
  ordering (owner first), `canChangeRole`, the login-less marker, the confirm text, the no-owner and blocked texts, the
  people-search query, the api wrappers surface the endpoint's message, `RESTRICT_UI` is `false` (a test pins it so A1b
  flips it deliberately), the route map equals `recordRoute`, `mine` filters include the access rows, the campaign and
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
  CHECK (true)`** policy and an `AS RESTRICTIVE FOR SELECT TO d1_llm_readonly` policy with the spec's conservative
  expressions (record tables: `NOT restricted` plus project/campaign/sample subqueries; children:
  `<fk> IN (SELECT <pk> FROM <parent>)`, both ends for `campaign_samples` and `sample_genealogy`; `project_rollup`:
  `NOT restricted` and project visible; `semantic_embeddings`: `CASE source_table ... ELSE false END`);
  `ALTER VIEW ... SET (security_invoker = true)` for **all nine** granted `v_*` views; `down` drops policies, disables RLS
  and resets the views. Do not `FORCE` row security.
- d1-trace: `hidden: { stock_origins: boolean, ancestors: boolean, events: boolean, descendants: boolean }`.

- [ ] **Inventory first (widely).** Roles that touch these tables are not all in migrations: grep
  `grep -rIn "d1_embedder\|d1_llm\|CREATE ROLE\|GRANT .* TO\|postgres://" docs .env.example docker-compose.yml infra scripts plugins db/migrations tests`
  and list every role and URL found; read `docs/runbooks/text-to-sql.md` and `.env.example` (`d1_embedder` has
  `SELECT, INSERT, UPDATE` on `semantic_embeddings`). Check `semantic_embeddings` rows' `source_table` values
  (`SELECT DISTINCT source_table` on the smoke copy) so the CASE covers every real source. Put the findings in the report.
- [ ] **phase1 / phase6 assertions first**, on a fixture with a restricted sample (with an operation, a test, params,
  file links, a force analysis), an unrestricted one, and a tree under a restricted project and campaign: as
  `SET ROLE d1_llm_readonly`, counts through the tables and through `v_*` views exclude every restricted tree; the owner
  role (`d1`) sees everything; `d1_llm_app` (member) is covered by the same policies; **a role with `d1_embedder`'s
  grants can still INSERT and `INSERT ... ON CONFLICT DO UPDATE` `semantic_embeddings` after the migration**; **every
  table granted to `d1_llm_readonly` has RLS enabled or is in the named reference list** (so a new grant without a
  policy fails); **every view granted to `d1_llm_readonly` has `security_invoker=true` in `pg_class.reloptions`**;
  migration 168 applies, reapplies and reverses cleanly.
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
  runbook, `docs/data-dictionary.md` if Task 1 left anything.
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
on Sonnet). Review the generated filters by eye for the operation cases (unrestricted; restricted; under a restricted
sample; under a restricted campaign and project). Preview with two Lab Member users and an admin; confirm the Force App
still records on a sample the user can see, and that nothing in any UI shows the Restrict switch. Open the PR (draft),
stacked on the base that carries migrations up to 164, and list in its body: the A1a-to-A1b window in which a
restricted operation's files and octrees are still reachable by id, the deliberate change that co-owners can no longer
add, change or remove co-owners, the performance numbers, and the "to confirm" items of spec section 11. Do not merge or
apply anything live: the maintainer follows `docs/runbooks/a1-record-access-cutover.md`, which deploys the extensions
and the four migrations together, flushes Redis and restarts Directus once.
