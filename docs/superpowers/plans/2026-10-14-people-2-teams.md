# People 2 — Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can create a team, its managers run its membership, a record's owner can give a team Can view / Can edit (Investigator on a project), and people who join a team later get that access only when the owner approves or ticked **Trust future members**. Teams show as one entry whose members appear on hover.

**Architecture:** A team grant (`<type>_team_access`) is expanded by triggers into **derived per-person rows** in the existing `<type>_access` tables, one per *active* member, tagged with the grant they come from. Everything that already reads access rows by person — the readers functions and tables, Restricted cascades, the Lab Member update/delete filters (`access._some.person_id.user_id` where role …), Ask-DB row security — then covers teams with no change. Pending and declined joiners live in `<type>_team_pending`. A guard trigger refuses direct writes to derived rows. New endpoint `d1-teams`; `d1-record-access` learns team entries; STARbase gets the People/Teams switch, a team page, the members card and the Waiting-for-you card.

**Tech Stack:** Postgres 16 (dbmate), Directus 11.17 endpoints (plain ESM, `node:test`), Vue 3 + TS (`@d1/ui`, `@d1/starbase-pages`), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-people-and-teams-design.md` (§1.2–§1.5, §2, §3.1–§3.2, decisions 7–12, 14–18); ADR `docs/adr/0016-teams.md`; glossary `CONTEXT.md` § People and access. Builds on PR 1 (`feat/people-admin`, plan `2026-10-14-people-1-admin-page.md`).

## Global Constraints

- **Ruling D1 (data model, overrides spec decision 10 / §2.2 and ADR-0016 decision 3):** no `<type>_editors` / `<type>_managers` tables and no change to `scripts/access_rules.json` or the Directus rules. Team access is expanded into derived rows in `<type>_access` (`team_access_id` set). Task 9 amends the spec (erratum) and ADR-0016. Reason: the derived rows reuse the readers machinery, the Restricted gates and the existing edit filters; the ADR design needed a new generator item kind, new aliases in three places, editors oracles that do not exist and a rewrite of every Lab Member update/delete rule, gated by a matrix CI does not run.
- **Ruling D2 ("would raise access"):** a pending row is *actionable* (shown on Home, in emails, in "N waiting") only while approving it would raise that person's access: for a `view` grant (or `investigator`) the person's login is not in `<type>_readers` for the record; for an `edit` grant the person has no `edit`-level `<type>_access` row (direct or derived) on the record and is not its owner, co-owner (`sample_co_owners`) or PI.
- Words follow `CONTEXT.md`: **team**, **team manager**, **pending member**, **Trust future members**, **access level** (Can view, Can edit, Investigator). Never "group" for a team.
- Migrations start at **181** (originally 175; renumbered after main took 173-177, PR 1 owns 180); check `git ls-tree` of open branches before committing a number.
- Every migration that creates or drops anything in `d1_private` joins the hard-coded down-block chain in `tests/phase1_schema.sh` (~2957–3040, newest first; see PR 1's `pa_down`), and `scripts/ci/migration_roundtrip.sh` must stay clean.
- New tables are **not** granted to `d1_llm_readonly`.
- Database gate (GitHub CI does not run it): `ROUNDTRIP=6 bash scripts/dev/schema_test_docker.sh` (phase1, readers matrix, people_admin, teams) — 0 failures; paste the summary into the PR body. Compare failures against `main`, never against this branch's own earlier commits.
- Writes in endpoints: knex transaction with `SELECT set_config('d1.actor_identity', <user id>, true)`; Directus data-cache clear after commit when `CACHE_ENABLED`; mail never undoes a change; error shape `{ errors: [{ message, extensions: { code, source } }] }`.
- `@d1/starbase-pages` and `@d1/ui` stay host-neutral (`hostNeutral.test.ts`, `noSdkImports`): no `router.push(`, `<router-link`, `window.open(`, `useApi(`, `useStores(`.
- Team palette keys (exact): `teal, blue, indigo, violet, pink, red, orange, amber, green, slate`; default `teal`. Logo: png, jpeg or svg, ≤ 1 MB, enforced in `d1-teams` (Lab Member has unfiltered `directus_files` rights — a member could still overwrite a logo file through `/files`: known gap).
- Performance gate is the coded A1a one: p95 < 300 ms per list request and writes ≤ 2× (`scripts/dev/perf_compare.py`); the spec's "80 ms" is corrected in Task 9.

## Review Focus

1. **A team manager widening access** — adding a member to a team never gives them access to a record whose owner did not trust future members; they are `pending` until approved. (Task 2 SQL test `join_without_trust_is_pending`.)
2. **Derived rows edited behind the bookkeeping** — an Administrator in Data Studio inserting, updating or deleting a derived `<type>_access` row is refused. (Task 2 test `derived_rows_are_guarded`.)
3. **Restricted records and teams** — a team granted on a Restricted record lets its active members read it; pending members cannot. (Task 2 test `restricted_record_team_grant`.)
4. **Leaving a team removes access at once**, including Can edit, and its readers rows go in the same statement. (Task 2 test `leave_removes_access_and_readers`.)
5. **Deleting the last manager** — refused at commit (deferred constraint); admins can still manage. (Task 1 test `team_needs_a_manager`.)

---

## File structure

| File | Responsibility |
|---|---|
| `db/migrations/20261014000181_teams.sql` | `teams`, `team_members`, `team_events`; manager constraint; Directus metadata; Lab Member read rows |
| `db/migrations/20261014000182_team_access.sql` | `<type>_team_access` ×5, `<type>_team_pending` ×5, `team_access_id` on `<type>_access` + uniques, bookkeeping + guard triggers, `d1_private.team_decide()`, `d1_private.team_drift()`, history writes; replaces 180's three functions (source `team`, key `former_in_team`) |
| `tests/teams.sh` | SQL tests (rolled-back cases on a TEMPLATE copy, like `tests/people_admin.sh`) |
| `tests/readers_matrix.sh` | new mutation cases for team grants |
| `core/extensions/d1-teams/` | the teams endpoint |
| `core/extensions/d1-record-access/` | team entries, team routes, derived rows ignored by person flows |
| `core/extensions/d1-people-admin/` | Through-teams and waiting counts, `former_in_team` |
| `packages/d1-ui/src/teams/` | `teamPalette.ts`, `teamsApi.ts`, `TeamTile.vue`, `TeamCard.vue` |
| `packages/d1-ui/src/access/*`, `components/Access*.vue` | team support in the Who-has-access dialog |
| `packages/starbase-pages/src/teams/` | `TeamsView.vue`, `TeamPage.vue`, `TeamEditDialog.vue`, `AddMemberDialog.vue` |
| `packages/starbase-pages/src/home/WaitingForYou.vue` | Home card |
| `tests/ui/specs/18-teams.spec.ts` | E2E |

---

### Task 1: teams, members, history (migration 181)

**Files:** Create `db/migrations/20261014000181_teams.sql`, `tests/teams.sh`; Modify `tests/phase1_schema.sh` (down chain if anything lands in `d1_private`), `.github/workflows/ci.yml` (run `bash tests/teams.sh` after `tests/people_admin.sh`), `scripts/dev/schema_test_docker.sh` (run it too), `scripts/configure_users_and_policies.sql` (Lab Member read rows for the three tables, outside the generated block).

**Interfaces — produces:**
```sql
teams(team_id uuid pk default gen_random_uuid(), name text not null, description text,
      color text not null default 'teal' check (color in ('teal','blue','indigo','violet','pink','red','orange','amber','green','slate')),
      logo uuid references directus_files(id) on delete set null,
      created_by_person_id uuid references people on delete set null, created_at timestamptz not null default now());
unique index teams_name_key on teams (lower(btrim(name)));
team_members(team_id uuid references teams on delete cascade, person_id uuid references people on delete cascade,
      is_manager boolean not null default false, joined_at timestamptz not null default now(), primary key (team_id, person_id));
team_events(event_id bigint generated always as identity primary key, team_id uuid not null references teams on delete cascade,
      at timestamptz not null default now(), actor_person_id uuid references people on delete set null,
      kind text not null check (kind in ('created','renamed','member_added','member_removed','manager_set','manager_unset',
        'shared','unshared','approved','declined','trust_set','trust_unset')),
      person_id uuid references people on delete set null, collection text, record_id uuid, detail jsonb);
```
- `d1_private.team_has_manager()` deferred constraint trigger (`DEFERRABLE INITIALLY DEFERRED`, AFTER INSERT/UPDATE/DELETE ON team_members FOR EACH ROW): at commit, a team that has ≥ 1 member and 0 managers raises `23514` "A team must keep at least one manager".
- History triggers on `teams` (insert → `created`, name change → `renamed`) and `team_members` (insert → `member_added`, delete → `member_removed`, `is_manager` change → `manager_set`/`manager_unset`); actor = the person whose `user_id = current_setting('d1.actor_identity', true)::uuid` (null when unset). A team's own deletion leaves no events (cascade).
- Directus: collections `teams`, `team_members`, `team_events` registered (visible, in a "People" group next to `people`; `team_members.team_id` / `person_id` M2O relations with alias `members` on teams; `logo` file relation). Lab Member: read on all three (no filter), no create/update/delete. Lab Admin/Administrator: full (admin_access).

- [ ] **Step 1: failing SQL tests** in `tests/teams.sh` (harness copied from `tests/people_admin.sh`): `name_is_unique_case_insensitive`; `colour_must_be_in_palette`; `team_needs_a_manager` (team with one non-manager member → commit raises; with a manager → ok; removing the last manager in its own transaction → raises; deleting the team → ok); `history_records_member_changes` (actor from `d1.actor_identity`); `not_granted_to_llm_role`.
- [ ] **Step 2:** run → FAIL. **Step 3:** write the migration (+ down). **Step 4:** run → PASS; `bash scripts/ci/migration_roundtrip.sh` clean; phase1 0 failures.
- [ ] **Step 5: Commit** `feat(db): teams, members and history (migration 181)`

### Task 2: team grants expanded into derived access rows (migration 182)

**Files:** Create `db/migrations/20261014000182_team_access.sql`; Modify `tests/teams.sh`, `tests/readers_matrix.sh`, `tests/phase1_schema.sh` (down chain), `tests/people_admin.sh` (new source/key expectations).

**Interfaces — produces:**
```sql
-- per type T in (sample: physical_samples.sample_id, operation: manufacturing_operations.operation_id,
--   test: test_sessions.session_id, campaign: campaigns.campaign_id, project: projects.project_id)
<T>_team_access(team_access_id uuid pk default gen_random_uuid(), <fk> uuid not null references <parent> on delete cascade,
   team_id uuid not null references teams on delete cascade, role text not null check (role in (<same roles as <T>_access>)),
   trust_new_members boolean not null default false, added_by_person_id uuid references people on delete set null,
   created_at timestamptz not null default now(), unique (<fk>, team_id));
<T>_team_pending(team_access_id uuid references <T>_team_access on delete cascade, person_id uuid references people on delete cascade,
   state text not null check (state in ('pending','declined')), decided_by_person_id uuid references people on delete set null,
   decided_at timestamptz, primary key (team_access_id, person_id));
alter table <T>_access add column team_access_id uuid references <T>_team_access on delete cascade;
-- replace UNIQUE (<fk>, person_id) by: unique (<fk>, person_id) where team_access_id is null;
--                                       unique (<fk>, person_id, team_access_id) where team_access_id is not null
```
- Bookkeeping (row-level AFTER triggers, SECURITY DEFINER, each sets `set_config('d1.team_sync','on',true)` around its writes):
  | Event | Effect |
  |---|---|
  | team grant inserted | a derived `<T>_access` row (role = grant role, `added_by_person_id` = grant's) for every current member; event `shared` |
  | grant role changed | derived rows take the new role |
  | grant `trust_new_members` false→true | its `pending` rows become derived rows (declined stay); event `trust_set` (`trust_unset` on true→false, nothing else changes) |
  | grant deleted | derived and pending rows cascade; event `unshared` |
  | member inserted | per grant of that team: trust → derived row; else `pending` row |
  | member deleted | that person's derived and pending rows for the team's grants are deleted |
- Guard: BEFORE INSERT/UPDATE/DELETE ON `<T>_access` FOR EACH ROW: when `team_access_id` (old or new) is not null and `current_setting('d1.team_sync', true)` is not `'on'` → raise `42501` "Team access rows are managed by the team's grant". Cascaded deletes from a grant/parent delete must pass (detect `pg_trigger_depth() > 1` from a cascade, or set the flag in the grant-delete trigger — choose and test).
- `d1_private.team_decide(collection text, team_access_id uuid, person_id uuid, decision text) returns void` (`'approve'|'decline'`): approve → delete the pending row, insert the derived row; decline → state `declined`; event `approved`/`declined` with the record; raises when there is no pending/declined row.
- `d1_private.team_pending_actionable(collection text, team_access_id uuid, person_id uuid) returns boolean` — Ruling D2.
- `d1_private.team_drift() returns table (collection text, team_access_id uuid, person_id uuid, problem text)` — derived rows vs active members (`missing`, `extra`, `role`); empty when healthy.
- Replace migration 180's functions (same signatures): `person_access_list(p, which)` gains `which = 'teams'` (derived rows, `source = 'team'`, `granted_by` = team name) and excludes derived rows from `'shared'`; `person_access` returns `(owns, shared, investigator, teams int, waiting int)` — new return type → `DROP FUNCTION` + `CREATE` (callers in d1-people-admin updated in Task 5); `people_attention()` gains key `former_in_team` (people with `active = false` in any team).
- The existing readers triggers on `<T>_access` fire on derived inserts/deletes unchanged (their `upd` guard tuple also must include `team_access_id`).

- [ ] **Step 1: failing tests** in `tests/teams.sh`: `grant_creates_rows_for_members` (and `sample_readers` gains their logins); `join_without_trust_is_pending` (no derived row, no readers row, `team_pending_actionable` true); `join_with_trust_is_active`; `approve_and_decline` (approve → derived + readers; decline → `declined`, not actionable; approve after decline works); `trust_turned_on_activates_pending_not_declined`; `role_change_follows_grant` (view→edit gives update rights: Lab Member update filter on `physical_samples` evaluated via the readers/edit SQL equivalent — assert an `edit` derived row exists); `leave_removes_access_and_readers`; `restricted_record_team_grant`; `derived_rows_are_guarded` (direct insert/update/delete refused; grant delete and parent delete cascade fine); `direct_and_team_rows_coexist` (person with a direct `view` row and a team `edit` row: two rows, both removable independently); `team_drift_is_empty_and_detects`; `actionable_rule_D2` (view grant to someone already a reader → false; edit grant to the owner → false); `person_access_sources` (team rows counted under `teams`, not `shared`; `waiting` counts actionable pending); `former_in_team_attention`.
- [ ] In `tests/readers_matrix.sh` add mutation cases `m.c_team_grant`, `m.c_team_join`, `m.c_team_leave`, `m.c_team_trust`, `m.c_team_delete` (each asserts `readers_drift()` empty after the mutation and after its reversal, like the existing cases); register them in the run list.
- [ ] **Step 2:** FAIL. **Step 3:** migration (+ down that restores 180's functions and the original unique constraints). **Step 4:** `ROUNDTRIP=6 bash scripts/dev/schema_test_docker.sh` → phase1 0, readers matrix 0 failures, people_admin and teams pass.
- [ ] **Step 5: Commit** `feat(db): team grants as derived access rows, pending joiners, drift check (migration 182)`

### Task 3: `d1-teams` endpoint

**Files:** Create `core/extensions/d1-teams/{package.json,index.js,index.test.mjs}`; Modify `core/README.md`.

**Interfaces — produces** (mounted `/d1-teams`; admin = `accountAdmin(...).admin` logic copied from d1-people-admin or imported from it):
- `GET /` → `{ teams: [{ team_id, name, description, color, logo, member_count, managers: [{person_id, full_name}], is_member, is_manager }] }`
- `GET /:id` → `{ team, members: [{person_id, full_name, can_sign_in, is_manager, joined_at}], counts: { view, edit, investigator }, records: [{collection, id, kind, code, title, role}] (only readable by the caller, via `<T>_readers`), hidden_count, events: [...] (last 20; `?events=all`) }`
- `POST /` `{name, description?, color?}` → 201 team; caller (must have a person) becomes manager; 409 `TEAM_NAME_TAKEN`.
- `PATCH /:id` `{name?, description?, color?, logo?}` (manager or admin); `logo` must be a `directus_files` id whose `type` ∈ image/png, image/jpeg, image/svg+xml and `filesize` ≤ 1048576 (else 400 `BAD_LOGO`).
- `DELETE /:id` (manager or admin) → deletes (grants cascade); mails each affected record's owner once ("Additive was deleted; it no longer has access to …").
- `POST /:id/members` `{person_id, is_manager?}` (manager or admin) → `{ pending: n, owners_asked: n, owned_edit: 0 }` (owned_edit stays 0 until PR 3); mails each owner with actionable pending rows **once per joiner** listing kind + code of their records.
- `PATCH /:id/members/:person_id` `{is_manager}`; `DELETE /:id/members/:person_id` (manager, admin, or the person themself). The deferred constraint's `23514` → 409 `LAST_MANAGER` "Make someone else a manager first".
- `GET /pending` → `{ items: [{ team_id, team_name, person_id, full_name, records: [{collection, id, kind, code, title, role}] }] }` — actionable pending rows on records the caller can manage (owner per `<T>` owner column / PI, or admin), grouped by joiner + team.
- `POST /pending/decide` `{ team_id, person_id, decision: 'approve'|'decline', records?: [{collection, id}] }` → calls `team_decide` for each manageable record; mails the joiner on approve.

- [ ] **Step 1: failing tests** (`node:test`, fake db as in d1-people-admin): every route's happy path; 403 for non-manager edits; `LAST_MANAGER` mapping; `TEAM_NAME_TAKEN`; `BAD_LOGO` (type and size); member add answers pending counts and sends one mail per owner; `/pending` only lists records the caller manages; decide on a record the caller does not manage → 403; delete mails owners; mail failure never undoes.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `node --test core/extensions/*/index.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(d1-teams): teams, members, pending approvals`

### Task 4: `d1-record-access` team entries

**Files:** Modify `core/extensions/d1-record-access/index.js`, `index.test.mjs`.

**Interfaces — produces:**
- `GET /:collection/:id` adds `teams: [{ team_access_id, team_id, name, color, logo, member_count, role, trust_new_members, waiting, declined }]` (`waiting` = actionable pending count, `declined` = declined count); person `entries` exclude derived rows.
- `POST …/entries` accepts `{ team_id, role }` (manage) → inserts `<T>_team_access` (409 `TEAM_ALREADY_LISTED`); mails each active member with an email and a login ("via <team>").
- `PATCH …/entries/team/:team_id` `{ role?, trust_new_members? }`; `DELETE …/entries/team/:team_id`; `GET …/entries/team/:team_id/members` → `{ active: [...], pending: [...], declined: [...] }`; `POST …/entries/team/:team_id/members/:person_id` `{ decision }` → `team_decide`.
- Person flows (POST upsert, PATCH, DELETE, transfer, dropLegacy) touch only rows with `team_access_id IS NULL`; the upsert's conflict target is the partial unique index.

- [ ] **Step 1: failing tests:** GET lists teams and hides derived rows; add team (+ mails, not to pending); duplicate → 409; role/trust patch; remove team; members listing; per-record decide; a person DELETE never removes a derived row; transfer leaves derived rows alone.
- [ ] **Step 2–4:** FAIL → implement → PASS (all extension tests).
- [ ] **Step 5: Commit** `feat(d1-record-access): teams in who-has-access`

### Task 5: People admin and People page — teams counts

**Files:** Modify `core/extensions/d1-people-admin/index.js` (+tests: `GET /people` rows get `teams: [{team_id,name,color,logo,is_manager}]`; access route returns `teams` and `waiting` counts and `?list=teams`), `packages/starbase-pages/src/people/peopleQuery.ts` (+ `team` in `ListState`, URL key `team`, filter by membership), `peopleApi.ts`, `PeopleView.vue` (Team menu, admins and members), `PersonPanel.vue` (Teams chips section, "Through teams" count row, "Waiting for approval: N records (M owners)" line), `rowNote.ts` / `ATTENTION_LABELS` (`former_in_team`: "N Former people still in a team").

- [ ] **Step 1: failing tests** (endpoint + vitest for the query/labels). **Step 2–4.** **Step 5: Commit** `feat(people): teams on the People page and person panel`

### Task 6: kit — team tile, members card, palette, API, access dialog

**Files:** Create `packages/d1-ui/src/teams/{teamPalette.ts,teamPalette.test.ts,teamsApi.ts,teamsApi.test.ts,TeamTile.vue,TeamCard.vue}`; Modify `packages/d1-ui/src/access/{accessModel.ts,accessApi.ts,useAccess.ts}` (+tests), `components/AccessDialog.vue`, `components/AccessPersonPicker.vue`, `src/index.ts` (exports).

**Interfaces — produces:**
- `TEAM_PALETTE: Record<TeamColor, { light: { bg: string; fg: string }; dark: { bg: string; fg: string } }>` for the ten keys; test: every fg/bg pair has WCAG contrast ≥ 4.5 (compute relative luminance).
- `TeamTile` props `{ team: { name: string; color: TeamColor; logo?: string | null }; size?: 'sm' | 'md' | 'lg' }` — square tile, logo via `assetUrl`, else initials (first letters of the first two words) on the palette colour.
- `TeamCard` props `{ teamId: string }` + default slot (the trigger): popover on hover, keyboard focus and tap; Esc / leaving closes; lists first 6 members (manager badge, "no login"), "and N more", "Open team" → `host.navigate('/teams/<id>')`; fetches `GET /d1-teams/:id` once per page (module-level cache `Map`).
- `teamsApi.ts`: `listTeams(api)`, `getTeam(api, id, opts?)`, `createTeam`, `updateTeam`, `deleteTeam`, `addMember`, `setManager`, `removeMember`, `listPending`, `decidePending`, `uploadTeamLogo(api, file: File): Promise<string>` (POST `/files` FormData, returns id); errors → `TeamsApiError { status, code, extensions }`.
- Picker: searches people **and** teams (teams from `listTeams`, filtered client-side by name), emits `pick(PersonHit | TeamHit)`; `TeamHit = { kind: 'team', team_id, name, color, logo, member_count }`.
- Dialog: team rows (tile, name, "Team · N members", face stack, opens `TeamCard`), level select, Remove; for managers of the record: **Trust future members** checkbox and "N waiting · M declined" expanding to Approve/Decline per person; the add box placeholder "Add people or teams".

- [ ] **Step 1: failing vitest** for palette contrast, initials, teamsApi URLs/errors, accessModel team sorting and labels, useAccess add/remove team. **Step 2–4.** `npm test -w @d1/ui`, typecheck, `noSdkImports`.
- [ ] **Step 5: Commit** `feat(d1-ui): team tile, members card and teams in who-has-access`

### Task 7: STARbase — Teams view, team page, Home card

**Files:** Create `packages/starbase-pages/src/teams/{TeamsView.vue,TeamPage.vue,TeamEditDialog.vue,AddMemberDialog.vue,teamPage.ts,teamPage.test.ts}`, `src/home/WaitingForYou.vue`; Modify `src/people/PeopleView.vue` (People | Teams switch, `?view=teams`), `src/routes.ts` + `routes.test.ts` (`teams/:id` before `:slug`; route count 13), `src/home.vue` (WaitingForYou above MyWork), `tests/ui/specs/13-explorer-routes.spec.ts` (`/home/teams/<id>` not needed; add `/home/people?view=teams` to EXTRA_ROUTES).

- Teams view (spec §1.2): row per team (tile, name, description, member count, managers); chips All · My teams; **New team** (everyone) → TeamEditDialog.
- Team page (`/teams/:id`): head (tile, name, description, "N members · M records", Edit/Delete for managers and admins; Delete shows the 409 text when it applies — PR 3); Members (manager badge; Add member, Make manager / Remove manager, Remove, **Leave** for oneself); Records (counts per level for everyone; list of readable records, then "and N you can't see"); History (last 20, "show all").
- TeamEditDialog: name, description, colour swatches (the ten keys), logo upload (accept png/jpeg/svg, client check ≤ 1 MB, then `uploadTeamLogo` + PATCH), remove logo.
- AddMemberDialog: person search (people only), "Make manager" box, then the endpoint's answer: "Owners of N records shared with <team> will be asked to approve." (and `owned_edit` text once PR 3 lands).
- WaitingForYou (spec §1.5): only when `listPending` returns items; one line per joiner + team: "<name> joined <team> · N of your records" with Approve all / Decline all / Review (expands to per-record choices).

- [ ] **Step 1: failing vitest** for `teamPage.ts` pure helpers (counts text, hidden-count line, history labels) and routes. **Step 2–4.** typecheck both packages.
- [ ] **Step 5: Commit** `feat(starbase-pages): teams view, team page and waiting-for-you`

### Task 8: E2E, perf scenarios, docs

**Files:** Create `tests/ui/specs/18-teams.spec.ts`; Modify `tests/ui/README.md`, `scripts/dev/explorer_preview.sh` (default overlay + `d1-teams`, `d1-person-link`), `scripts/dev/directus_perf_writes.mjs` / `perf_writes.sql` (scenarios `team_join_100_records`, `team_grant_20_members`), `docs/runbooks/starbase.md` ("Teams (PR 2)": migrations 181–182, restart directus, run `SELECT * FROM d1_private.team_drift()` = 0 rows), `docs/superpowers/specs/2026-10-14-people-and-teams-design.md` (§10 errata plan 2: Ruling D1 replaces §2.2; Ruling D2; perf gate 300 ms not 80 ms; logo overwrite gap in §7), `docs/adr/0016-teams.md` (decision 3 amended: derived rows, with the reason; status stays Proposed), `core/README.md`.

- [ ] **Step 1: spec 18** (preview as in plan 1 Task 9, overlay incl. `d1-teams d1-record-access d1-people-admin d1-person-link`): admin creates a team, adds the member as manager; member shares a sample they own with the team… (use admin-created fixtures via `adminApi`): (a) team grant gives an active member read + edit (open the sample page as that member); (b) a new joiner without trust is pending — cannot read; owner sees Waiting for you, approves → can read; (c) trust future members → next joiner reads at once; (d) leaving removes access; (e) hover/focus on a team row in Who-has-access shows the members card; (f) last-manager leave refused with the message; (g) People/Teams switch and team page load for a member. Specs 13, 15, 17 still pass.
- [ ] **Step 2:** run spec 18 + 13 + 15 + 17 on the preview → PASS. Run `D1_SMOKE_MODE=perf` before/after with `perf_compare.py` if the preview supports it; otherwise record why in the report and leave it as a runbook step.
- [ ] **Step 3: Commit** `test(ui): teams E2E; perf scenarios; docs, errata and ADR amendment`

---

## Plans 3–4 (outline; detailed after PR 2)

**Plan 3 — Team ownership (PR 3).** `owner_team_id` on samples, campaigns, operations, tests (CHECK at most one owner, `ON DELETE RESTRICT`); team ownership expands into derived rows too: members → `edit`, managers → a new access level `manage` (added to the four `<T>_access` role CHECKs) generated by an `owner` pseudo-grant; `scripts/access_rules.json`: owner and delete sets gain `{path: access._some.person_id.user_id, at: access, where: {role: [manage]}}` (existing item kind), regenerate, snapshot migration; `d1-access-guard` owner guard follows the delete rule; `d1-owner-default` must not fill `owner_person_id` when `owner_team_id` is set; `d1-admin-overview` ownerless counts and index `no_owner` flags treat team-owned as owned; `mine.ts` "my work" includes records of teams you manage/belong to; the four record rails show a team owner (TeamTile + "managers"); transfer to/from a team in `d1-record-access`; team delete refused while it owns records (409 with counts); add-member dialog's "will get Can edit on N records".

**Plan 4 — My teams (PR 4).** Index-page **Team** filter: a new FilterDef option kind `team` whose filter is `{_or: [{access: {_some: {team_access_id: {team_id: {_eq: id}}}}}, {owner_team_id: {_eq: id}}]}` — verify Directus accepts the nested to-one hop inside `_some`; else filter by `id` list from `GET /d1-teams/:id`); Home **My teams** panel (recent records across the viewer's teams, one line each with the team tile).
