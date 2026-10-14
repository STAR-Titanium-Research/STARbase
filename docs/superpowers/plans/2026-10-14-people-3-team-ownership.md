# People 3 — Team Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team can own a sample, campaign, operation or test (never a project). Its managers act as the owner (share, transfer, restrict, delete); its members get Can edit. A record becomes team-owned only through **Transfer ownership**.

**Architecture:** Same derived-rows design as PR 2 (Ruling D1). Setting `owner_team_id` creates a hidden **owner grant** (`<T>_team_access.role = 'own'`, trust on) that the bookkeeping expands into derived rows: managers get the new access level **`manage`**, members get `edit`. The Lab Member rules learn one thing: an access row with role `manage` counts as the owner (delete / manage / owner guards), and `manage` also counts wherever `edit` does. No new tables.

**Tech Stack:** Postgres 16 (dbmate), Directus 11.17 endpoints/hooks (plain ESM, `node:test`), `scripts/gen_access_rules.py`, Vue 3 + TS, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-people-and-teams-design.md` decisions 13–14, §1.2–§1.4, §2 (ownership), §3.2–§3.3, §10 errata; ADR-0016 decision 4. Builds on PR 2 (`feat/teams`, plan `2026-10-14-people-2-teams.md`).

## Global Constraints

- All of plan 2's Global Constraints apply (derived rows only, migrations numbered from **177**, phase1 down chain, no `d1_llm_readonly` grants, DB gate `ROUNDTRIP=2 bash scripts/dev/schema_test_docker.sh`, host-neutral UI, error shape, actor identity, mail never undoes).
- **Ruling O1:** the access level `manage` exists only on the four ownable types' `<T>_access` (not `project_access`) and is only ever written by the bookkeeping (derived rows of an owner grant). Wherever SQL or `scripts/access_rules.json` treats `edit` as an editor, `manage` counts too; wherever it tests the owner (`owner_person_id.user_id`, delete/manage/owner sets, owner guards, `team_pending_actionable`'s owner test), a `manage` row counts too.
- **Ruling O2:** the owner grant (`role = 'own'`) is never shown as a team entry in Who has access; the owner row shows the team ("Additive (managers)").
- `num_nonnulls(owner_person_id, owner_team_id) <= 1`; `owner_team_id` FK `ON DELETE RESTRICT` (deleting a team that owns records is refused).
- Every CI suite runs on the final commit of every task that touches code: `node --test core/extensions/*/index.test.mjs`, the vitest suites + typechecks, `gen_access_rules.py --check`.

## Review Focus

1. **A plain member cannot manage** a team-owned record (share, transfer, restrict, delete) — Directus delete/manage rules and d1-record-access both refuse. (Task 2 tests + Task 5 E2E.)
2. **Demoting a manager** removes their owner powers at once (derived role `manage` → `edit`). (Task 1 test `manager_flag_changes_derived_role`.)
3. **`d1-owner-default`** never fills `owner_person_id` on a record created with `owner_team_id` (CHECK would fail). (Task 2 test.)
4. **Transfer to a team then back to a person** leaves no owner grant or derived owner rows behind. (Task 1 + Task 3 tests.)
5. **Ownerless counts / "my work"** treat team-owned records as owned, and "my work" includes records of teams I belong to. (Task 4 tests.)

---

### Task 1: owner_team_id and the owner grant (migration 177)

**Files:** Create `db/migrations/20261014000177_team_ownership.sql`; Modify `tests/teams.sh`, `tests/readers_matrix.sh` (cases `m.c_team_own_set`, `m.c_team_own_manager_flag`, `m.c_team_own_clear`), `tests/phase1_schema.sh` (down chain), `scripts/dev/access_matrix_oracle.sql` (`manage` ⊇ `edit`, team owner).

**Interfaces — produces:**
- `owner_team_id uuid references teams on delete restrict` on `physical_samples`, `manufacturing_operations`, `test_sessions`, `campaigns` + index + `CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1)`; Directus M2O relation to `teams` (field `owner_team_id`, interface select-dropdown-m2o, readonly in forms — set only through Transfer).
- `<T>_access.role` CHECK adds `'manage'` (four types); `<T>_team_access.role` CHECK adds `'own'` (four types).
- Bookkeeping: AFTER INSERT/UPDATE OF owner_team_id on the four record tables → keep exactly one `own` grant (`trust_new_members = true`, `added_by_person_id` = actor) for the current `owner_team_id`, delete it when cleared/changed. Owner-grant expansion: derived role = `manage` for `is_manager`, else `edit`; `team_members.is_manager` change updates the derived rows of every `own` grant of that team. The derived-row guard and pending logic treat `own` grants as always-trusted (no pending rows ever).
- Every SQL reader of `role = 'edit'` / `role IN (...)` in migrations 166/176 functions and views (e.g. `v_s_editor`, `team_pending_actionable`'s owner/editor tests) is redefined to include `manage` (`CREATE OR REPLACE`, restored in down).
- `team_drift()` covers `own` grants (derived roles by manager flag; exactly one `own` grant per team-owned record).
- `person_access_list(p, 'owns')` adds records owned by a team where p is a manager (`source = 'team_owner'`); counts follow.

- [ ] **Step 1: failing tests** (`tests/teams.sh`): `owner_check_one_owner`; `set_owner_team_creates_grant_and_rows` (managers `manage`, members `edit`, readers rows); `manager_flag_changes_derived_role`; `clear_owner_team_removes_grant_and_rows`; `delete_team_owning_records_refused` (23503); `own_grant_has_no_pending` (a joiner of an owning team gets `edit` at once); `manage_counts_as_editor_in_readers` (child operation of a team-owned sample readable/editable exactly as for a person owner); `drift_covers_owner_grants`; `person_access_owns_team_owned`. Readers-matrix cases as listed.
- [ ] **Step 2–4:** FAIL → migration (+ down) → `ROUNDTRIP=2 bash scripts/dev/schema_test_docker.sh` green (phase1 0, matrix 0, people_admin, teams).
- [ ] **Step 5: Commit** `feat(db): team ownership as an owner grant with manage rows (migration 177)`

### Task 2: rules, guard and owner default

**Files:** Modify `scripts/access_rules.json` (owner/manage/delete sets gain `{"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["manage"]}}`; every `where role [edit]` editor item gains `manage`; `owner_guards` field lists gain `owner_team_id`), regenerate (`gen_access_rules.py --write`: `configure_users_and_policies.sql`, `core/extensions/d1-access-guard/rules.json`, `core/extensions/d1-record-access/rules.json`), Create `db/migrations/20261014000178_team_ownership_rules.sql` (snapshot of the regenerated Lab Member rows via `--values --only`, with backup table and down, as migration 166 §10 does); Modify `core/extensions/d1-owner-default/index.js` (+ new `index.test.mjs`): do not fill `owner_person_id` when the payload sets `owner_team_id`; `core/extensions/d1-access-guard` tests (changing `owner_team_id` needs the delete rule; a plain member of the owning team is refused, a manager allowed); `tests/scripts/test_access_rules.py` expectations.

- [ ] **Step 1: failing tests** (pytest generator tests; guard and owner-default `node:test`; phase1 rules comparison). **Step 2–4.** `gen_access_rules.py --check`, all extension suites, DB gate.
- [ ] **Step 5: Commit** `feat(access): team managers act as owner in the Lab Member rules`

### Task 3: endpoints — transfer to a team, owner display, team delete

**Files:** Modify `core/extensions/d1-record-access/index.js` (+tests): `POST …/transfer` accepts `{team_id}` for the four types (409 `NOT_OWNABLE_BY_TEAM` on projects): sets `owner_team_id`, clears `owner_person_id`, keeps the previous person owner as `edit` (existing rule), mails the team's managers; transfer `{person_id}` from a team-owned record clears `owner_team_id`; `GET` `owner` may be `{ kind: 'team', team_id, name, color, logo, managers: [{person_id, full_name}] }` (person owners gain `kind: 'person'`); entries/teams lists exclude the `own` grant and its derived rows (Ruling O2). `core/extensions/d1-teams/index.js` (+tests): `DELETE /:id` maps 23503 on `owner_team_id` to 409 `TEAM_OWNS_RECORDS` with `extensions.counts` per collection; `POST /:id/members` answers `owned_edit` = records the team owns; `GET /:id` counts gain `owns`; `/pending` "records the caller owns" includes records owned by a team the caller manages.

- [ ] **Step 1: failing tests. Step 2–4.** All extension suites.
- [ ] **Step 5: Commit** `feat(endpoints): transfer to a team, team owners, team delete guard`

### Task 4: UI and the owner-reading places

**Files:** `packages/d1-ui/src/access/*` + `AccessDialog.vue` (owner row shows a team owner with TeamTile + "Additive (managers)"; "Only Additive's managers can change who has access."; Transfer picker offers teams for the four types), `packages/d1-ui/src/record/{sampleFacts,campaignFacts,operationFacts,testFacts}.ts` (Owner fact: team name when `owner_team_id`; the page data hooks select `owner_team_id.team_id,name,color,logo`), `packages/starbase-pages/src/home/mine.ts` + `useMyWork.ts` ("my work" also includes records owned by teams I belong to: `owner_team_id.members` read through `/items/team_members` ids → `owner_team_id: {_in: myTeamIds}`), `packages/d1-ui/src/index/indexConfig.ts` (`no_owner` flags: `owner_person_id _null AND owner_team_id _null`), `core/extensions/d1-admin-overview/index.js` (ownerless counts exclude team-owned; +test), `packages/starbase-pages/src/teams/AddMemberDialog.vue` (the `owned_edit` sentence), `TeamPage.vue` (Owns count; Delete shows the TEAM_OWNS_RECORDS message with counts).

- [ ] **Step 1: failing vitest** for facts, mine filters, index flags; extension test for admin-overview. **Step 2–4.** All suites + typechecks.
- [ ] **Step 5: Commit** `feat(ui): team owners in rails, who-has-access, my work and ownerless counts`

### Task 5: E2E and docs

**Files:** Create `tests/ui/specs/19-team-ownership.spec.ts`; Modify `tests/ui/README.md`, `docs/runbooks/starbase.md` ("Team ownership (PR 3)": migrations 177–178, Redis/permission cache per the PR 2 sequence, `team_drift()` and `readers_drift_count()` = 0), spec §10 errata (Rulings O1/O2), ADR-0016 note, `core/README.md`.

- [ ] **Step 1: spec 19** (preview, overlay incl. `d1-owner-default d1-access-guard d1-record-access d1-teams`): owner transfers a sample to a team → a manager can open Who has access and share it, a plain member can edit but not share/delete (403 / no controls), demoting the manager removes sharing at once, the rail shows the team owner, deleting the team is refused with counts, transfer back to a person clears it; specs 13, 15, 17, 18 still pass.
- [ ] **Step 2:** run on the preview → PASS; `perf` before/after if available (same gate).
- [ ] **Step 3: Commit** `test(ui): team ownership E2E; runbook and errata`
