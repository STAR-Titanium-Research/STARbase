# A1a Record Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Who has access" dialog on the five Explorer record pages (add and remove people, transfer ownership, email
on add), and a per-record **Restricted** model in the database and the Lab Member rules (a restricted sample hides its
operations and tests; params, rollup, Ask-the-database and d1-trace follow), with the Restrict switch **hidden in
every UI** until A1b.

**Architecture:** Migration 164 adds `restricted` to five tables and five person-keyed access tables, each with a
hidden top-level `access` O2M alias. `access_rules.json` and `gen_access_rules.py` learn AND, literal leaves and
role tests (sets become trees), migration 165 applies the regenerated Lab Member rows. `d1-access-guard` gains
owner-only `restricted` and manage-rule junction guards. A new endpoint extension `d1-record-access` is the only
writer of the access tables and sends the email through Directus's `MailService`. The kit holds the pure model and
the dialog; d1-home places the button. Migration 167 gives the Ask-DB role row-level security.

**Tech Stack:** Postgres 16 + dbmate, Directus 11.17 (endpoint and hook, plain ESM JS, node:test, Vue 3 + TS kit with
vitest), Python 3 (generator and pytest), bash harnesses.

**Spec:** `docs/superpowers/specs/2026-10-12-record-access-design.md`

## Global Constraints

- **Migrations** (the next number is 164; 163 is U1, deployed live):
  `db/migrations/20261012000164_record_access.sql`, `20261012000165_lab_member_record_access_rules.sql`,
  `20261012000166_project_rollup_restricted.sql`, `20261012000167_llm_role_row_security.sql`. Each has a working
  `migrate:down`, and `ROUNDTRIP=1` must pass. If another branch has taken a number by the time this lands, renumber
  and say so in the report.
- **Directus 11.17 rejects a `_some` that is not directly under a top-level O2M** of the collection being filtered
  (`"_some" can only be used with top level relational alias field`; read the header of migration
  `20261010000160_lab_member_some_only_where_directus_accepts_it.sql`). `gen_access_rules.py path_filter()` keeps a
  `_some` only at path index 1 or right after another legal one and drops the rest; a dropped `_some` is a bare
  to-many hop, which means "any joined row". Use it **only for positive membership tests** (never `_none`). A legal
  `_some` subquery applies the related collection's own Lab Member rule, so an access table's rule must not recurse
  into its parent's read rule: Lab Member reads only rows about themselves (`person_id.user_id = $CURRENT_USER`).
  Every new rule must be proven on the Directus smoke harness (200, correct rows, no duplicates, `filter_count`
  agrees), not only in Postgres.
- **The Restrict switch stays hidden.** `restricted` is a hidden, read-only field in `directus_fields`; the dialog's
  toggle is behind `RESTRICT_UI = false`. No A1a code path renders it.
- **Writes to the access tables only through the endpoint.** Lab Member has no create, update or delete grant on
  them. The endpoint checks the manage rule (the record's delete rule from the generated `rules.json`) in the same
  request, then writes with system accountability. Admins manage any record.
- **Old tables stay.** `sample_co_owners` and `project_investigators` remain honoured (union with the new tables in
  every set), shown in the dialog, and deleted by it on removal. No backfill, no consumer rewrite beyond `mine.ts`.
- **Unrestricted records behave exactly as today** when their access lists are empty: a test must compare the new
  generated filters with today's on the fixture (same visible ids for every user when nothing is restricted and no
  access rows exist).
- **No live access.** Never touch the live containers or database. Harnesses restore a read-only dump into a
  throwaway copy; follow `scripts/dev/directus_smoke.sh` as written.
- Kit files never import `@directus/extensions-sdk` (`noSdkImports.test.ts`). The dialog uses `EXPLORER_HOST.api`.
- No emojis in code, UI text or commits. Wording in the UI is plain ("Who has access", "Can view", "Can edit",
  "can't sign in yet", "some records hidden").
- Commit per task with the message given; end each commit message with the attribution line the harness provides.

## Review Focus

1. **Restricted never widens.** For every collection and every fixture user, update and delete visible ids are a
   subset of read visible ids; a restricted sample's operations, tests, files rows, analyses and params are invisible
   to anyone not on its list, including the operation's own owner.
2. **The `_some` rule.** No generated filter has a `_some` anywhere but index 1 / after a legal `_some`; the role
   test inside a legal `_some` works on a real Directus (viewer cannot update, editor can).
3. **Manage = owner (PI) or admin, nothing else.** A co-owner, a Can edit person and a project's Can edit person
   cannot add or remove anyone, change `restricted`, or hand the record over, by endpoint or by `PATCH /items`.
4. **The email can never block or leak.** A throwing mail service still returns the change; no mail to the adder, to
   a person without an email, or on a role change; every interpolated value is escaped; the link is
   `PUBLIC_URL/admin/home/<kind>/<id>`.
5. **Ask-DB** sees nothing of a restricted tree through tables or `v_*` views, and Directus (table owner) and the
   migrations are unaffected.
6. **Performance gate** (Task 2): the Lab Member operations list is not slower than 2x today's median on the
   restored copy, with no duplicates.
7. **Deleting `core/roles.json` and `core/permissions.json`** leaves nothing that reads them.

---

### Task 1: Schema (migration 164) and Directus metadata

**Files:**
- Create: `db/migrations/20261012000164_record_access.sql`
- Modify: `scripts/configure_directus.sql` (keep the new relations, alias fields and hidden `restricted` fields where
  it keeps the owner relations and the project aliases: see lines near "owner_person_id" -> people and the
  `samples`/`operations` alias blocks; they delete and re-insert, so without this a re-run drops them)
- Modify: `tests/phase1_schema.sh` (new assertions, below)
- Modify: `docs/data-dictionary.md` (new tables and columns; follow how `file_fingerprints` was documented)

**Interfaces (produces):**
- `restricted BOOLEAN NOT NULL DEFAULT false` on `physical_samples`, `manufacturing_operations`, `test_sessions`,
  `campaigns`, `projects`, each with a partial index `... WHERE restricted`.
- Tables `sample_access(sample_id)`, `operation_access(operation_id)`, `test_access(session_id)`,
  `campaign_access(campaign_id)`, `project_access(project_id)`, each: `access_id UUID PK DEFAULT gen_random_uuid()`,
  parent FK `NOT NULL ON DELETE CASCADE`, `person_id UUID NOT NULL REFERENCES people ON DELETE CASCADE`,
  `role TEXT NOT NULL CHECK (role IN ('view','edit'))` (`project_access`: also `'investigator'`),
  `added_by_person_id UUID REFERENCES people ON DELETE SET NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  `UNIQUE (<parent>, person_id)`, index on `person_id`; audit trigger as migration
  `20261003000121_audit_all_business_tables.sql` (copy its mechanism; the new tables have no OCC `version`).
- Directus metadata: `directus_collections` (hidden) for the five tables; `directus_relations` for each parent FK with
  `one_field = 'access'` and for `person_id -> people` (no alias); `directus_fields` for the five hidden `access`
  aliases (`special: o2m`) and the five `restricted` fields (`hidden: true`, `readonly: true`). Insert only when
  missing and RAISE when a relation points elsewhere, as migration `20261007000141` does.

- [ ] Read migrations 141 (relations and aliases), 121 (audit triggers) and 159 (a recent table with Directus
  metadata) and follow their patterns exactly. Check live-affecting traps: a NOT NULL column needs a default
  (T0a incident); sqlfluff style via `pre-commit run --files <migration>`.
- [ ] Write the phase1 assertions first and watch them fail: the five tables and constraints exist (unique key, role
  check, project_access accepts `investigator`, others refuse it); `restricted` is NOT NULL default false on the five
  parents and every existing row is false; the metadata rows exist and the aliases resolve; deleting a person
  cascades their access rows; deleting a parent cascades its list; the audit trigger writes `audit_logs`.
- [ ] Implement the migration (up and down; down drops tables and columns and removes the metadata rows it added).
- [ ] Update `scripts/configure_directus.sql`; add a phase1 assertion that the new relations, aliases and fields are
  still there after `configure_all.sh` runs (extend the block near `tests/phase1_schema.sh:2658-2700`).
- [ ] Gates: `bash scripts/dev/schema_test_docker.sh` with `ROUNDTRIP=1` (no new FAIL lines); `pre-commit run
  --files db/migrations/20261012000164_record_access.sql scripts/configure_directus.sql`.
- [ ] Commit `feat(access): restricted flag and person-keyed access tables (migration 164)`.

### Task 2: Rules engine, Lab Member rows, params, rollup (migrations 165 and 166)

**Files:**
- Modify: `scripts/gen_access_rules.py`, `scripts/access_rules.json`
- Modify: `tests/scripts/test_access_rules.py`, `tests/phase1_schema.sh`, `scripts/dev/directus_smoke.mjs`
- Create: `db/migrations/20261012000165_lab_member_record_access_rules.sql`,
  `db/migrations/20261012000166_project_rollup_restricted.sql`
- Regenerate: `scripts/configure_users_and_policies.sql` (block), `core/extensions/d1-access-guard/rules.json`,
  new `core/extensions/d1-record-access/rules.json` (`gen_access_rules.py --write`)
- Modify: `.pre-commit-config.yaml` (add `core/extensions/d1-record-access/rules.json` to the
  `access-rules-in-sync` `files:` regex) and `.github/workflows/ci.yml` only if it names the old file list

**Interfaces (produces):** the item kinds and sets of spec section 3.
- Generator: a set is a list (OR) or `{"and": [...]}`; items: user-leaf string, `{"set","via"}`,
  `{"path","at","where":{col:[values]}}`, `{"field","eq"}`, `{"field","null"}`, `{"unless_restricted":[...]}`,
  `{"and":[...]}`, `{"or":[...]}`. Build a tree, distribute `via` onto leaves, flatten last. `path_filter()` legality
  rule unchanged. `amnesty_filter()` takes `{"null":[...],"restricted_false":true,"also":"<set>"}`.
  `owner_guards` entries become `{"key","fields":[{"field","value_key"?}]}`; `resolve()` and the update-vs-delete
  safety net understand the new kinds. `hook_rules()` also emits the d1-record-access rules file
  (`{collection: {table, fk, read, manage, ...}}` for the five record types plus their access tables).
- `access_rules.json`: the sets `sample.listed/inherited/read/pass/editors/owner`, `record.listed/inherited/sample_ok/read/editors/update/delete`,
  `campaign.listed/inherited/read/update/owner`, `project.listed/inherited/read/update/pi/investigators`,
  `rollup.read`; `rules` entries per spec ("rules entries change"); the params tables move from `unfiltered` to
  `rules` (`operation_id` -> `operation.read/update`, `session_id` -> `session.read/update`, delete follows update);
  `campaign_samples.read` requires `sample.pass`; the five access tables get `custom` rows (read: person is me;
  no create/update/delete); `orphan_amnesty` in the new shape; `guards.sample_co_owners` and
  `guards.project_investigators` get `"rule": "delete"`; `owner_guards` for samples, operations, tests, campaigns
  (`owner_person_id`) and projects (`principal_investigator_person`) each with `fields` incl. `restricted`.
- `project_rollup.restricted BOOLEAN NOT NULL DEFAULT false` (cache table), filled by `refresh_project_rollup()` from
  `v_project_rollup` plus the rule in spec section 3; `v_project_rollup` gains `restricted` as its last column
  (`CREATE OR REPLACE VIEW` may only append; start from the newest definition, find it with
  `grep -rn "v_project_rollup" db/migrations`); a statement trigger on `physical_samples` UPDATE OF restricted
  (operations and campaigns already fire the refresh; only samples need the new trigger).

- [ ] **Params and relations first.** Check that `directus_relations` has `operation_id` -> `manufacturing_operations`
  for the five process params tables and `session_id` -> `test_sessions` for the six test params tables; if a row is
  missing add it in migration 165 (RAISE if one points elsewhere). Run `gen_access_rules.py --resolve` early.
- [ ] **Generator tests first** (`tests/scripts/test_access_rules.py`, pure Python): tree flattening; `via` distributed
  onto `unless_restricted` and `field` leaves (`{"sample_id": {"restricted": {"_eq": false}}}`); `where` placement
  for a legal `_some` (sibling of the user leaf in the `_some` body) and a dropped one (sibling on the bare hop);
  `and` sets keep their AND under `via`; no `_some` outside index 1 / after a legal `_some` in any generated rule
  (walk every output); amnesty clause with the extra gate; owner-guard `fields`; the update-wider-than-delete net
  now fires for campaigns and projects without entries; `resolve()` for a missing `restricted` column or `at` alias.
  **Equivalence test:** with a fixture evaluator (a small Python filter evaluator over fixture rows), the new
  filters give **exactly today's visible ids** for every fixture user when nothing is restricted and no access rows
  exist, and "restricted never widens" holds (update/delete subset of read) over the full restricted/unrestricted
  matrix. Keep the evaluator small and in the test file.
- [ ] Implement the generator and the JSON. Regenerate with `python3 scripts/gen_access_rules.py --write`; run
  `--check`, `--resolve` and pytest (`python3 -m pytest tests/scripts/test_access_rules.py`).
- [ ] **Migration 165**: a snapshot of `python3 scripts/gen_access_rules.py --values` for every collection whose rule
  changed, in the style of 160/161: back up what it overwrites into `d1_private.lab_member_access_rules_backup` for
  `down`; update rows whose permissions or validation differ, insert missing rows (the five access tables and the
  params tables' rows already exist as unfiltered); header comment names the Directus restart and Redis flush.
- [ ] **Migration 166**: rollup column, view, refresh function, trigger; `down` restores the old view and function.
  Assertions in phase1: an operation under a restricted sample and a restricted operation are `restricted = true` in
  the cache after the refresh; a tool used only by restricted operations is restricted; flipping a sample's flag
  refreshes the cache.
- [ ] **phase1**: the Lab Member rows equal the generator output (existing); params rows ruled; access tables have no
  Lab Member write grants; `access_rules` drift checks include the new rules file; migration 165 apply, reapply,
  reverse restores exactly the old rows.
- [ ] **Smoke cases** in `scripts/dev/directus_smoke.mjs` (`lm_*`, same style as the existing ones): build the
  fixture matrix of spec section 10 in the copy; for each user and collection compare `GET /items/<collection>` ids,
  `meta=filter_count` and a second page against a plain-SQL evaluation; assert every ruled collection answers 200,
  no duplicate ids with a three-person access list, viewer cannot `PATCH` and editor can, a sample-restricted
  operation is invisible to its own owner when they are not on the sample, params follow their operation.
  Run: `D1_SMOKE_REQUIRE_LM=1 bash scripts/dev/directus_smoke.sh`.
- [ ] **Performance gate** on the same copy: as a Lab Member who reaches records only through co-ownership, time
  `GET /items/manufacturing_operations?limit=25&meta=filter_count&sort=-operation_date` and the Explorer's operations
  index query, before (main) and after; record the numbers in the commit body. If slower than 2x median or
  duplicates appear, apply the first escape hatch of spec section 11 (a trigger-maintained `sample_restricted`
  copy on operations and tests) in this task and re-measure; if that is still not enough, stop and report.
- [ ] Gates: `python3 scripts/gen_access_rules.py --check`; pytest; `bash scripts/dev/schema_test_docker.sh`
  (ROUNDTRIP=2); the smoke run above.
- [ ] Commit `feat(access): restriction-aware Lab Member rules, params and rollup follow their record (migrations 165, 166)`.

### Task 3: Guard hook, record-access endpoint, email (backend)

**Files:**
- Modify: `core/extensions/d1-access-guard/index.js`, `index.test.mjs` (rules.json is generated in Task 2)
- Create: `core/extensions/d1-record-access/{package.json,index.js,index.test.mjs}` (package.json shape from
  `core/extensions/d1-admin-overview`; `rules.json` is generated in Task 2). CI already runs
  `node --test core/extensions/*/index.test.mjs`, so no list to edit.
- Modify: `scripts/dev/directus_smoke.mjs` (endpoint cases) and, if the smoke script mounts only named overlays,
  `scripts/dev/directus_smoke.sh` so the new extension is overlaid like `d1-next-number`.
- Modify: `docs/wiki/database/roles-and-permissions.md` and the access-guard header comment (behaviour changes).

**Interfaces (produces):** the routes of spec section 5.
- `GET /d1-record-access/:collection/:id` -> `{ restricted, owner:{person_id,name}, project_pi, can_manage, entries:[{ person_id, name, role, label, source:'access'|'co_owner'|'investigator', can_sign_in, added_by, added_at }] }`
- `POST .../entries {person_id, role}` -> `{ entry, email: 'sent'|'skipped'|'failed' }`; `PATCH .../entries/:person_id {role}`;
  `DELETE .../entries/:person_id`; `POST .../transfer {person_id}` -> `{ owner, email }`.
- Errors: 401 no user; 400 unknown collection, bad uuid or role (`investigator` only on projects); 404 unreadable
  record; 403 `FORBIDDEN` with `extensions.source = 'd1-record-access'` when the caller may not manage; 409 adding
  the owner. Exported pure helpers for tests: `COLLECTIONS`, `roleLabel(collection, role, source)`,
  `mailContent({ adder, role, kind, code, title, link })`, `recordLink(publicUrl, collection, id)`.
- Guard: `ownerGuards[collection] = { key, fields:[{field,valueKey?}], filter }`; an update naming any field with a
  changed value must pass the delete rule (403 `extensions.kind` `'owner'` or `'restricted'`); junction guards use the
  parent's delete rule for `sample_co_owners` and `project_investigators`.

- [ ] Tests first, guard (`index.test.mjs`, existing style): `restricted` changed by the owner, a co-owner, a Can edit
  person, an admin and an internal call; unchanged value passes; batch update is checked per key; projects and
  campaigns guarded; the co-owner and investigator junction guards refuse a co-owner and accept the owner; messages.
- [ ] Tests first, endpoint (fake `ItemsService`, `MailService`, knex like `d1-admin-overview`'s tests): 401; the
  collection whitelist; read check gives 404; manage matrix per role (owner, co-owner, Can edit, viewer, stranger,
  admin); add sends exactly one mail, a role change none, self-add none, a person without an email skips; a
  `MailService` that throws still returns the change with `email: 'failed'`; mail content is HTML-escaped and
  carries the adder, role, record and link; entries merge the access table with `sample_co_owners` and
  `project_investigators` rows and label them; remove deletes both stores; transfer keeps the previous owner as
  `edit`, drops the new owner's row and refuses a non-person; two-user isolation (a user never gets another
  record's list).
- [ ] **Check the Directus 11.17 `MailService.send` signature** in the image the smoke harness runs (read the
  installed `@directus/api` source in the container, a read-only `docker exec ... cat`/`grep`): which of `html`,
  `text` and `template` is accepted, whether the base template wraps `html`. Code to what is there; if `html` needs
  a template, add one `.liquid` file in the extension folder and pass `template`. Note the finding in the report.
- [ ] Implement the guard changes and the endpoint (system accountability only after the manage check; write inside
  one knex transaction; mail after commit, inside try/catch; read env `PUBLIC_URL`).
- [ ] Smoke cases: as owner add a login-less person (no mail address), add a person with an address (the smoke Directus
  has no mail server, so assert `email` is `failed` or `skipped` and the change stands), list as a viewer
  (`can_manage = false`), change `restricted` by `PATCH /items` as the owner (200) and as an editor (403).
- [ ] Gates: `node --test core/extensions/d1-access-guard/index.test.mjs core/extensions/d1-record-access/index.test.mjs`;
  `python3 scripts/gen_access_rules.py --check`; the smoke run (`D1_SMOKE_REQUIRE_LM=1`).
- [ ] Commit `feat(access): owner-only restricted guard and the d1-record-access endpoint with email`.

### Task 4: The dialog and the button (frontend)

**Files:**
- Create: `packages/d1-ui/src/access/{accessModel.ts,accessModel.test.ts,accessApi.ts,accessApi.test.ts}`,
  `packages/d1-ui/src/components/AccessDialog.vue`
- Modify: `packages/d1-ui/src/host.ts` (`ExplorerHost.api` gains `post`, `patch`, `delete`),
  `packages/d1-ui/src/index.ts` (exports), `packages/d1-ui/src/mine.ts` and `mine.test.ts`
- Modify: `core/extensions/d1-home/src/explorerHost.ts` (already hands over the SDK's axios; only the type changes),
  `core/extensions/d1-home/src/pages/{Sample,Operation,Test,Campaign,Project}Page.vue` (button and dialog)

**Interfaces (produces):**
- `accessModel.ts` (pure): `ROLE_LABELS(collection)`, `entryLabel(entry)`, `sortEntries`, `canChangeRole(entry, canManage)`,
  `peopleSearchQuery(text)` (active people, name search, limit), `isLoginless(person)`, `transferConfirmText(from, to)`,
  `RESTRICT_UI = false`.
- `accessApi.ts`: `loadAccess(api, collection, id)`, `addEntry`, `setRole`, `removeEntry`, `transfer`, `searchPeople`,
  each returning plain data or a message string from the endpoint's error.
- `AccessDialog.vue` props: `modelValue`, `collection`, `id`, `title`; emits `changed`. Shows the list for everyone
  who can read the record and the controls only when `can_manage`; the Restrict toggle only when `RESTRICT_UI`.
- `mine.ts`: `coOwnedByMe` also matches `access: { _some: { person_id: { user_id: $CURRENT_USER }, role: { _eq: 'edit' } } }`
  (so a Can edit person's samples count as theirs), and `projectsMine` also matches `project_access` role
  `investigator`. These are explicit filters sent to `/items`, so their `_some` sits at the top of the collection.

- [ ] Tests first (`accessModel.test.ts`, `accessApi.test.ts`, `mine.test.ts`, vitest): labels per collection (sample
  Can edit reads "Co-owner · can edit"; project has the third role), ordering (owner first), `canChangeRole`, the
  login-less marker, the confirm text, the people-search query, the api wrappers surface the endpoint's message,
  `RESTRICT_UI` is `false` (a test pins it so A1b flips it deliberately), `mine` filters include the access rows.
- [ ] Implement the model, api and component. Keyboard: Escape closes, focus is trapped, the add box is a combobox
  with aria labels, every button names its person ("Remove Edith Ford"). Use the kit's tokens and the `EditDrawer`
  modal conventions; read `packages/d1-ui/src/components/EditDrawer.vue` and `.claude/skills/directus-ui-conventions`
  first. Transfer asks for confirmation in a second step with the confirm text. After every change refetch the list
  and emit `changed`. A failed email shows "Added. The email could not be sent."
- [ ] Add the button to the five pages' `RecordRail` `#actions` slot and the dialog beside `EditDrawer`; title for
  the operation page uses the page's own label helpers.
- [ ] Gates: `npx vitest run` in `packages/d1-ui`; `vue-tsc` in `packages/d1-ui` and `core/extensions/d1-home`;
  d1-home build (`npm run build` in `core/extensions/d1-home`); `noSdkImports.test.ts` green.
- [ ] Preview as a Lab Member owner and as a co-owner using the repo's explorer preview
  (`scripts/dev/explorer_preview.sh`, see its header for the overlay variable): the owner sees the controls, the
  co-owner sees the list only, a login-less person can be added, nothing shows a Restrict toggle. One screenshot per
  state is enough.
- [ ] Commit `feat(d1-home): Who has access dialog on the record pages`.

### Task 5: Close the bypasses and clean up (migration 167, d1-trace, legacy roles, docs)

**Files:**
- Create: `db/migrations/20261012000167_llm_role_row_security.sql`
- Modify: `core/extensions/d1-trace/index.js`, `index.test.mjs`; `packages/d1-ui/src/life.ts`, `life.test.ts`;
  `core/extensions/d1-home/src/pages/sample/LifeStrip.vue`; the type of the trace in the kit
- Modify/Delete: `core/roles.json`, `core/permissions.json`, `core/apply.sh`, `core/README.md`; and every reference
  found by the grep below (known: `docs/adr/0005-directus-rbac-structure.md`, `docs/adr/0011-row-level-visibility.md`,
  `docs/wiki/database/roles-and-permissions.md`, `docs/wiki/database/developer-guide.md`, `docs/api-contract.md`,
  `docs/runbooks/heavy-data-pipeline.md`, `.env.example` (Operator token), the phase4 `MACHINE_TOKEN` note,
  `.claude/skills/ci-local/SKILL.md`)
- Create: the next free ADR number in `docs/adr/` (0013 unless taken), "Record access", amending 0011 (paths that
  bypass, known gaps, the choices of the spec); update `docs/adr/README.md`; extend
  `docs/wiki/database/roles-and-permissions.md` and `docs/runbooks/physical-test-backlog.md` (the two-user
  checklist of spec section 10)
- Modify: `tests/phase1_schema.sh`, `tests/phase6_text_to_sql.sh` (RLS assertions)

**Interfaces (produces):**
- Migration 167: for each table the llm role can SELECT and that holds record-bound rows: `ENABLE ROW LEVEL SECURITY`,
  a permissive `FOR SELECT TO PUBLIC USING (true)` policy, and `AS RESTRICTIVE FOR SELECT TO d1_llm_readonly` with the
  spec's expressions (record tables: `NOT restricted` plus the sample subquery for operations and tests; children:
  `<fk> IN (SELECT <pk> FROM <parent>)`); `ALTER VIEW ... SET (security_invoker = true)` for the `v_*` views granted to
  the role that read record rows (list them from migration `20261003000132`); `down` drops policies, disables RLS and
  resets the views. Do not `FORCE` row security.
- d1-trace: `hidden: { stock_origins: boolean, ancestors: boolean, events: boolean, descendants: boolean }`;
  `life.ts` `hiddenMarker` prints "some records hidden" with no number.

- [ ] **Inventory first.** `grep -rn "semantic_embeddings" plugins db/migrations | head` and read its columns: if it
  has a record key (source table and id) add the child policy, otherwise report that it cannot be scoped and
  `REVOKE SELECT` on it from the role pending the maintainer's decision (do not silently leave it readable). Grep the
  migrations and compose for every other role that selects these tables (`GRANT ... TO`, `CREATE ROLE`): the
  permissive `TO PUBLIC` policy keeps them unchanged; list what you find in the report.
- [ ] **phase1 / phase6 assertions first**: as `SET ROLE d1_llm_readonly` on a fixture with a restricted sample (with
  an operation, a test, params, file links, a force analysis) and an unrestricted one: counts through the tables and
  through `v_*` views exclude the restricted tree; the owner role (`d1`) sees everything; a restricted operation under
  an unrestricted sample is also hidden; `d1_llm_app` (member) is covered by the same policies; migration 167 applies,
  reapplies and reverses cleanly.
- [ ] Implement migration 167. Gate: `bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1) and, if the harness
  supports it, `tests/phase6_text_to_sql.sh`.
- [ ] **d1-trace**: tests first (booleans, still `truncated`), then change the endpoint, `life.ts` and `LifeStrip`;
  `npx vitest run` in `packages/d1-ui`; `node --test core/extensions/d1-trace/index.test.mjs`.
- [ ] **Legacy roles.** Confirm nothing reads `core/roles.json` and `core/permissions.json`:
  `grep -rIn "roles.json\|permissions.json\|apply\.sh" --exclude-dir=node_modules --exclude-dir=.git .`, then check
  `Makefile`, `.github/workflows`, `docker-compose.yml`, `.pre-commit-config.yaml`, `scripts/` and `tests/`
  individually. `core/apply.sh` reads both files (it creates the Operator machine user and prints the token that
  `.env.example` and the heavy-data runbook mention): decide with the findings whether to delete it or rewrite it
  to create a machine user on the Administrator role, and **stop and ask the maintainer** if anything outside the
  documentation and the script depends on the Operator role or its token. Live has only Administrator, Lab Admin
  and Lab Member. Then delete the two files (and `apply.sh` if retired) and fix every reference.
- [ ] Docs: the ADR, the wiki page, the physical-test checklist, `docs/data-dictionary.md` if Task 1 left anything.
- [ ] Gates: `bash scripts/dev/schema_test_docker.sh` ROUNDTRIP=1; `python3 scripts/gen_access_rules.py --check`;
  `python3 -m pytest tests/scripts/test_access_rules.py`; `npx vitest run` in `packages/d1-ui`;
  `node --test core/extensions/*/index.test.mjs`; `D1_SMOKE_REQUIRE_LM=1 bash scripts/dev/directus_smoke.sh`;
  `pre-commit run --all-files` (or the repo's `ci-local` skill).
- [ ] Commit `feat(access): Ask-DB row security, d1-trace hidden flags, retire the Phase 3 role files (migration 167)`.

---

### After the tasks: final review, preview, PR

Final review by Opus with one fix round (see the repo's token-economy practice: small reviews on Haiku, implementers
on Sonnet). Review the generated filters by eye for the three operation cases (unrestricted, restricted, under a
restricted sample). Preview with two Lab Member users and an admin; confirm the Force App still records on a sample
the user can see, and that nothing in any UI shows the Restrict switch. Open the PR (draft), stacked on the base
that carries migrations up to 163, and list in its body: the A1a-to-A1b window in which a restricted operation's
files and octrees are still reachable by id, the deliberate change that co-owners can no longer add co-owners, and
the open questions of the spec. Do not merge or apply anything live; flush Redis and restart Directus after
migrations 165 and 166 on whatever environment applies them.
