# People 1 — Admin People Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** STARbase's People page gains admin controls: filters in the URL, a "needs attention" line, a person panel with account role / suspend / last sign-in and "who sees what", and email invites with a STARbase accept-invite page.

**Architecture:** The counts and access lists are SQL functions in `d1_private` (migration 173), tested against a real Postgres in CI. A thin new endpoint extension `d1-people-admin` calls them, adds account changes (role, suspend) and invites through Directus's `UsersService`. STARbase's single `people.vue` splits into a folder of focused components; page logic that can be pure (filters, query parsing, attention labels) lives in `.ts` modules with vitest, and the components are checked by a Playwright spec.

**Tech Stack:** Postgres 16 SQL (dbmate migrations), Directus 11.17 endpoint (plain ESM, `node:test`), Vue 3 + TypeScript (`@d1/starbase-pages`, `apps/starbase/web`), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-people-and-teams-design.md` (§1.1, §1.6, §3.4, §5 PR 1). Glossary: `CONTEXT.md` § People and access.

## Global Constraints

- Words on screen follow `CONTEXT.md`: **account role** (Administrator, Lab Admin, Lab Member), **Former**, **Suspended**, **Researcher** / **Operator** (never "role"), **login**, **person**.
- Only an **account administrator** changes an account role, suspends or reactivates a login, or invites with a role other than Lab Member. A Lab Admin sees all admin data read-only for those three things and may edit People rows, link logins and invite as Lab Member (spec decision 3).
- Admin data (attention, last sign-in, account role, other people's access) is never sent to a non-admin; a member may read only their own access (`GET /people/:person_id/access` for their own person).
- `@d1/starbase-pages` stays host-neutral (`src/hostNeutral.test.ts`): no `router.push(`, `<router-link`, `window.open(`, `useApi(`, `useStores(`; navigate with `host.navigate()`; URL query updates with `router.replace`.
- Endpoint errors use the d1-record-access shape: `{ errors: [{ message, extensions: { code, source: 'd1-people-admin' } }] }`; 401 no user, 403 not allowed, 404 unknown id, 409 refused state, 400 bad input.
- Writes run in a knex transaction that first does `SELECT set_config('d1.actor_identity', <user id>, true)`; after commit clear the Directus data cache when `CACHE_ENABLED` (copy d1-record-access `index.js:431-439`).
- Next migration number is **173** (`20261014000173_people_admin.sql`); check `ls db/migrations | tail` and other open branches before committing it.
- The Lab Admin role id is `10000001-0000-0000-0000-000000000001` (created by `scripts/configure_users_and_policies.sql`).

### Spec errata (apply to the spec in Task 9)

- **E1 Account administrator.** The spec said "find the Administrator role by name". The preview's admin has no role (an admin policy attached to the user), so instead: an **account administrator** is a login that reaches an `admin_access` policy (d1-record-access `isAdminLogin`) **and** whose role is not the Lab Admin role. `D1_LAB_ADMIN_ROLE_ID` may override the id.
- **E2 No mail catcher.** The preview network has no outbound mail and the repo has no catcher. Invite email delivery is covered by the endpoint's unit tests (fake `UsersService`); the E2E checks the invited login exists, is linked and shows "Invite not accepted", and the accept page's error path.
- **E3** The "Former people still in a team" attention item and the **Team** menu and **Through teams** count arrive with PR 2 (teams do not exist yet).
- **E4** Removing a direct grant from the person panel calls the existing `DELETE /d1-record-access/:collection/:id/entries/:person_id` (admins manage every record); no new route.

## Review Focus

1. **The last account administrator** demotes or suspends themselves → refused with 409 "Make someone else an Administrator first"; the UI shows the message, nothing changes. (Task 3 test `refuses demoting the last account administrator`.)
2. **A Lab Admin crafting a request** to change a role or invite as Administrator → 403, even though `accountability.admin` is true. (Task 3/4 tests `lab admin cannot change a role`, `lab admin invite is forced to Lab Member`.)
3. **Inviting an email that already has an active login** → 409 "That email already has a login" with the person to link instead; an email already *invited* → treated as resend. (Task 4 tests.)
4. **A member opening `/people/:id/access` for someone else** → 403; their own → 200 without admin-only fields. (Task 2 test `member can read only their own access`.)
5. **A suspended login keeps a live session** → suspending deletes its `directus_sessions` rows in the same transaction. (Task 3 test `suspend ends sessions`.)

---

## File structure

| File | Responsibility |
|---|---|
| `db/migrations/20261014000173_people_admin.sql` | `d1_private.people_attention()`, `d1_private.person_access(uuid)`, `d1_private.person_access_list(uuid, text)`; Lab Member gets nothing new |
| `tests/people_admin.sh` | SQL tests of the three functions on a migrated database (fixture inserts inside a rolled-back transaction) |
| `core/extensions/d1-people-admin/{package.json,index.js,index.test.mjs}` | the endpoint |
| `docker-compose.yml`, `.env.example`, `tests/starbase_compose.test.mjs`, `tests/ui/starbase/preview-*.env` | `USER_INVITE_URL_ALLOW_LIST` |
| `packages/starbase-pages/src/people/peopleQuery.ts` (+ `.test.ts`) | parse / serialise the list state in the URL; filter and sort |
| `packages/starbase-pages/src/people/peopleApi.ts` | typed calls to `/d1-people-admin` and `/items/people` |
| `packages/starbase-pages/src/people/PeopleView.vue` | header, chips, menus, attention line, list, opens the panel |
| `packages/starbase-pages/src/people/PersonPanel.vue` | side panel / phone sheet: account, access counts and lists |
| `packages/starbase-pages/src/people/PersonEditDialog.vue` | today's add/edit dialog, moved out of `people.vue` unchanged in behaviour |
| `packages/starbase-pages/src/people/InviteDialog.vue` | invite form |
| `packages/starbase-pages/src/people.vue` | becomes a one-line re-export of `people/PeopleView.vue` (keeps `PeopleView` export and route) |
| `apps/starbase/web/src/AcceptInvite.vue`, `src/acceptInvite.ts` (+ `.test.ts`), `src/router.ts`, `src/main.ts` | the public accept page |
| `tests/ui/specs/17-people-admin.spec.ts`, `tests/ui/README.md` | E2E |
| `core/README.md`, `scripts/dev/explorer_preview.sh` (default overlay), `docs/runbooks/starbase.md` | docs and preview |
| `.github/workflows/ci.yml` | run `tests/people_admin.sh` in the migrations job |

---

### Task 1: SQL functions for attention and access (migration 173)

**Files:**
- Create: `db/migrations/20261014000173_people_admin.sql`, `tests/people_admin.sh`
- Modify: `.github/workflows/ci.yml` (migrations job: add `run: bash tests/people_admin.sh` after `tests/phase1_schema.sh`), `scripts/dev/schema_test_docker.sh` (run it too, like `readers_matrix.sh`)

**Interfaces:**
- Produces (all `SECURITY INVOKER`, `STABLE`, `SET search_path = pg_catalog, public`, not granted to `d1_llm_readonly`):
  - `d1_private.people_attention() RETURNS TABLE (key text, person_ids uuid[], user_ids uuid[])` — one row per key, only keys with at least one hit. Keys, exactly: `login_without_person` (user_ids: `directus_users` with no `people.user_id`), `invite_not_accepted` (status `invited`), `missing_email` (people with no `email` and no linked login email), `possible_duplicate` (people sharing `lower(btrim(full_name))` or `lower(email)`), `former_login_active` (`people.active = false` and linked login status `active`), `suspended_owns_records` (linked login status `suspended` and owner of any sample/campaign/operation/test or PI of a project).
  - `d1_private.person_access(p uuid) RETURNS TABLE (owns int, shared int, investigator int)` — owns = records with `owner_person_id = p` in the four tables + projects with `principal_investigator_person = p`; shared = rows for `p` in the five `*_access` tables with role `view`/`edit` + `sample_co_owners` rows for p's login; investigator = `project_access` role `investigator` + `project_investigators` rows for p's login.
  - `d1_private.person_access_list(p uuid, which text) RETURNS TABLE (collection text, record_id uuid, level text, source text, granted_by text, added_at timestamptz)` — `which` ∈ `'owns' | 'shared' | 'investigator'`; `source` ∈ `'owner' | 'access' | 'co_owner' | 'investigator_junction' | 'pi'`; `level` ∈ `'owner' | 'view' | 'edit' | 'investigator' | 'pi'`.

- [ ] **Step 1: Write the failing SQL test** — `tests/people_admin.sh` follows `tests/readers_matrix.sh`'s harness (copy the database from the migrated one with `CREATE DATABASE … TEMPLATE`, run `psql -v ON_ERROR_STOP=1`, each case in `BEGIN … ROLLBACK`). Cases, each with `DO $$ … ASSERT … $$`:
  - `attention_keys_only_when_hit`: on the fixture, insert a `directus_users` row with no person → `people_attention()` has `login_without_person` containing its id; delete it → the key is gone.
  - `duplicate_by_name_and_email`: two people `'Ada Lovelace'` and `' ada lovelace '` → both ids under `possible_duplicate`; two with the same email different case → both.
  - `former_login_active`: person active=false linked to a login with status `active` → listed; status `suspended` → not listed.
  - `suspended_owns_records`: suspended login whose person owns one sample → listed; with no records → not.
  - `person_access_counts`: person owning 2 samples and 1 campaign, PI of 1 project, `edit` on 1 sample through `sample_access`, a `sample_co_owners` row, `investigator` on 1 project through `project_access` → `(owns 4, shared 2, investigator 1)`.
  - `person_access_list_sources`: the same person → `which='shared'` returns 2 rows with sources `access` and `co_owner`, `granted_by` = the adder's `full_name` for the `access` row.
- [ ] **Step 2: Run it, expect FAIL** — `DATABASE_URL=… bash tests/people_admin.sh` → `function d1_private.people_attention() does not exist`.
- [ ] **Step 3: Write the migration** (`-- migrate:up` / `-- migrate:down`, down drops the three functions). Comment each function with what it answers, in the style of migration 166.
- [ ] **Step 4: Run the test, expect PASS**; run `bash scripts/ci/migration_roundtrip.sh` → up/down/up clean.
- [ ] **Step 5: Commit** — `feat(db): people attention and access functions (migration 173)`

### Task 2: `d1-people-admin` endpoint — reads

**Files:**
- Create: `core/extensions/d1-people-admin/package.json` (the d1-admin-overview shape: `"type":"module"`, keywords incl. `directus-custom-endpoint`, `"directus:extension": {"type":"endpoint","path":"index.js","source":"index.js","host":"^11.0.0"}`), `index.js`, `index.test.mjs`
- Modify: `core/README.md` (endpoint table row)

**Interfaces:**
- Consumes: Task 1 functions; `COLLECTIONS` exported by `../d1-record-access/index.js` (kind, segment, code, title fields per collection).
- Produces (mounted at `/d1-people-admin`):
  - `export default { id: 'd1-people-admin', handler(router, { database, logger, services, env }) }`
  - `export async function accountAdmin(db, userId, labAdminRoleId): Promise<{ admin: boolean; accounts: boolean }>` — `admin` = reaches an `admin_access` policy (logic of d1-record-access `isAdminLogin`); `accounts` = `admin && role !== labAdminRoleId`.
  - `GET /people` (admin) → `{ can_administer_accounts: boolean, roles: [{id, name}], people: Person[], logins_without_person: Login[] }` where `Person = { person_id, full_name, email, is_researcher, is_operator, active, notes, user_id, login: null | { status: 'active'|'invited'|'suspended'|'draft'|'archived', role_id, role_name, last_access: string|null, email } , attention: string[] }` and `Login = { user_id, email, first_name, last_name, status, role_id, role_name, last_access }`.
  - `GET /attention` (admin) → `{ items: [{ key, count }] }` (keys in Task 1's order; zero counts omitted).
  - `GET /people/:person_id/access` (admin, or the person whose `user_id` is the caller) → `{ owns, shared, investigator }`; `?list=owns|shared|investigator` adds `records: [{ collection, id, kind, code, title, level, source, granted_by, added_at }]` with code/title read from each record (system read; the caller is admin or the person, who can read what they own or were given — but filter the list through the caller's readers table for a non-admin: a record they no longer read is counted, not listed).

- [ ] **Step 1: Write failing tests** in `index.test.mjs` (copy d1-record-access's `mount()` / `call()` / fake `res` helpers; the fake database answers `raw()` calls by SQL prefix and `('directus_users')` etc. from tables):
  - `401 without a user`, `403 for a member on GET /people`, `GET /people as Lab Admin returns can_administer_accounts false`, `as account administrator returns true`, `admin with no role (policy on the user) is an account administrator`.
  - `GET /people joins login status, role name and last_access, and lists logins without a person`.
  - `GET /attention omits zero counts`.
  - `member can read only their own access` (own → 200 with counts; other → 403), `?list=shared returns kind/code/title from COLLECTIONS fields`.
- [ ] **Step 2: Run** `node --test core/extensions/d1-people-admin/index.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement** the handler, `accountAdmin`, and the three routes. `D1_LAB_ADMIN_ROLE_ID` from `env`, default `10000001-0000-0000-0000-000000000001`.
- [ ] **Step 4: Run** → PASS; `node --test core/extensions/*/index.test.mjs` → all pass.
- [ ] **Step 5: Commit** — `feat(d1-people-admin): people, attention and access reads`

### Task 3: account role and suspend

**Files:** Modify `core/extensions/d1-people-admin/index.js`, `index.test.mjs`

**Interfaces:**
- Produces: `PATCH /logins/:user_id` body `{ role?: uuid, status?: 'active'|'suspended' }` (account administrator only) → `{ user_id, role_id, role_name, status }`.

- [ ] **Step 1: Failing tests:**
  - `lab admin cannot change a role` → 403 code `ACCOUNTS_ADMIN_ONLY`.
  - `changes the role` → `directus_users.role` updated; unknown role id → 400.
  - `refuses demoting the last account administrator` → 409 `LAST_ADMINISTRATOR`, message "Make someone else an Administrator first"; also when suspending them. (Count = active logins for which `accountAdmin(...).accounts` is true, excluding the target after the change.)
  - `suspend ends sessions` → status `suspended` and `directus_sessions` rows of that user deleted, in one transaction with `d1.actor_identity` set.
  - `reactivate` → status `active`.
  - status other than `active`/`suspended` → 400.
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(d1-people-admin): change account role, suspend and reactivate`

### Task 4: invites

**Files:**
- Modify: `core/extensions/d1-people-admin/index.js`, `index.test.mjs`, `docker-compose.yml` (directus `environment:` add `USER_INVITE_URL_ALLOW_LIST: ${STARBASE_URL:+${STARBASE_URL}/accept-invite}`), `.env.example` (comment under `STARBASE_URL`: invites land on `<STARBASE_URL>/accept-invite`), `tests/starbase_compose.test.mjs` (asserts the value with `STARBASE_URL=https://sb.example`), `tests/ui/starbase/preview-ports.env` and `preview-hosts.env` (the same variable for their STARBASE_URL)

**Interfaces:**
- Produces:
  - `POST /invite` body `{ email: string, role?: uuid, person_id?: uuid, full_name?: string }` (admin) → `201 { user_id, person_id, status: 'invited', email_sent: boolean }`.
  - `POST /invite/resend` body `{ user_id }` (admin) → `{ email_sent }`.
- Rules: `role` omitted or not account administrator → Lab Member role (`10000001-0000-0000-0000-000000000002`, `D1_LAB_MEMBER_ROLE_ID`); a non-Lab-Member role from a Lab Admin → 403 `ACCOUNTS_ADMIN_ONLY`. `person_id` given → that person must exist and have no login (409 `PERSON_HAS_LOGIN`); otherwise `full_name` required (400) and a person is created (`is_researcher` true, `email` = the invite email). Email with an `active`/`suspended` login → 409 `EMAIL_HAS_LOGIN` with `extensions.person_id` when that login is linked; with an `invited` login → resend path. Invite URL = `env.STARBASE_URL + '/accept-invite'`; `STARBASE_URL` blank → 503 `STARBASE_URL_UNSET`.
- Calls `new services.UsersService({ schema: req.schema, accountability: SYSTEM_ADMIN, knex: trx }).inviteUser(email, roleId, inviteUrl)`, then reads the new `directus_users.id` by email and sets `people.user_id` in the same transaction. A mail failure inside `inviteUser` is caught: the login and link stay, `email_sent: false`, logged as a warning (d1-record-access's rule: mail never undoes a change).

- [ ] **Step 1: Failing tests** (fake `UsersService` records `inviteUser` calls; `fail` switch throws a mail-like error after inserting the user): `invites and links an existing person`, `creates the person when none is given`, `lab admin invite is forced to Lab Member` (no role → Lab Member; Administrator role → 403), `email with an active login is refused with its person`, `email already invited resends`, `mail failure keeps the login and reports email_sent false`, `503 when STARBASE_URL is unset`, `resend for a login that is not invited → 409 NOT_INVITED`.
- [ ] **Step 2: Run → FAIL. Step 3: Implement + compose/env changes. Step 4:** `node --test core/extensions/d1-people-admin/index.test.mjs tests/starbase_compose.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `feat(d1-people-admin): email invites linked to a person`

### Task 5: list state, filters and API module (pure TS)

**Files:**
- Create: `packages/starbase-pages/src/people/peopleQuery.ts`, `peopleQuery.test.ts`, `peopleApi.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Chip = 'all' | 'researchers' | 'operators' | 'nologin' | 'former';
  export type RoleFilter = 'any' | 'none' | string;            // role id
  export type SortKey = 'name' | 'last' | 'added';
  export interface ListState { chip: Chip; role: RoleFilter; sort: SortKey; q: string; attn: string | null; person: string | null }
  export function parseListState(query: Record<string, unknown>): ListState;   // unknown values → defaults
  export function toQuery(s: ListState): Record<string, string>;               // omits defaults: {} for the default state
  export function applyList(rows: PeopleRow[], s: ListState): PeopleRow[];
  export function chipCounts(rows: PeopleRow[]): Record<Chip, number>;
  export const ATTENTION_LABELS: Record<string, (n: number) => string>;       // e.g. invite_not_accepted: n => `${n} invite${n===1?'':'s'} not accepted`
  ```
  `PeopleRow` = the endpoint's `Person` for admins, or a member's `/items/people` row with `login: null` and `attention: []`, plus `kind: 'person' | 'login'` (a login without a person is a row too, `kind: 'login'`, shown only when `attn === 'login_without_person'` or `chip === 'all'`).
  URL keys: `f` (chip), `role`, `sort`, `q`, `attn`, `person`.
  `peopleApi.ts`: `loadPeople(api, isAdmin)`, `loadAttention(api)`, `loadAccess(api, personId, list?)`, `patchLogin(api, userId, body)`, `invite(api, body)`, `resendInvite(api, userId)`, `removeDirectGrant(api, collection, recordId, personId)` (calls `/d1-record-access/...`) — each returns the parsed `data` and throws the endpoint's `errors[0].message`.
- [ ] **Step 1: Failing tests** in `peopleQuery.test.ts`: `default state serialises to {}`; `round-trips every non-default field`; `unknown chip falls back to all`; `former chip shows only active=false`; `nologin chip shows persons without a login, never login rows`; `role none = persons with no login`; `sort last puts never-signed-in last`; `search matches name and email case-insensitively`; `attn filters to rows whose attention includes the key, and login_without_person shows login rows`; `chipCounts counts persons only`; `ATTENTION_LABELS pluralise`.
- [ ] **Step 2: Run** `npm test -w @d1/starbase-pages` → FAIL. **Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(starbase-pages): people list state and admin API module`

### Task 6: People view (list, chips, menus, attention)

**Files:**
- Create: `packages/starbase-pages/src/people/PeopleView.vue`, `PersonEditDialog.vue` (moved from `people.vue`: the edit/add dialog, `blank()`, `save()`, `remove()`, emits `saved`)
- Modify: `packages/starbase-pages/src/people.vue` → a thin wrapper SFC (`<script setup> import PeopleView from './people/PeopleView.vue' </script><template><PeopleView v-bind="$attrs" /></template>` with `inheritAttrs: false`), keeping `routes.ts` and `index.ts` unchanged.

**Interfaces:**
- Consumes: Task 5 (`parseListState`, `toQuery`, `applyList`, `chipCounts`, `ATTENTION_LABELS`, `peopleApi`); Task 7's `PersonPanel` (`props: { personId: string; rows: PeopleRow[]; canAdministerAccounts: boolean; roles: {id,name}[] }`, emits `close`, `changed`).
- Behaviour (mockup screen 1): header `People` (the Teams switch arrives in PR 2), search, **Invite** (admins), **Add person**; chips with counts; `v-select` menus **Role** (admins only: Any, each role, No login) and **Sort** (Name, Last sign-in, Recently added); admins see the attention line "N things need attention · review" and a menu of `ATTENTION_LABELS` items; rows: avatar, name, Researcher/Operator, right side account role + last sign-in (admins; relative time: "2 h ago", "yesterday", date after 7 days; "—" never), one amber note when `attention` is non-empty (`Invite not accepted` / `Suspended` / first label), Former dimmed. Clicking a row sets `person` in the URL (`router.replace`) and opens the panel beside the list at ≥ 1000px, as a bottom sheet below that. Members get today's page plus the chips and Sort, no admin columns; clicking their **own** row opens the panel; other rows open `PersonEditDialog` read-only as today. A `kind: 'login'` row (admins) shows its email and **Link to a person…**: a picker of people with no login, saving `PATCH /items/people/:person_id { user_id }` (admins may already do this), then reloads.
- [ ] **Step 1:** Implement; `npm run typecheck -w @d1/starbase-pages` → 0 errors; `npm test -w @d1/starbase-pages` (hostNeutral still passes).
- [ ] **Step 2:** Run the existing People E2E (`tests/ui/specs/15-starbase-polish.spec.ts` "a dialog on the People page") against the preview → PASS (the Add person button keeps its label and focus return).
- [ ] **Step 3: Commit** — `feat(starbase-pages): People list with filters in the URL and the attention line`

### Task 7: person panel

**Files:** Create `packages/starbase-pages/src/people/PersonPanel.vue`

**Interfaces:** as consumed in Task 6.
- Content (mockup screen 2): head (avatar, name, email, **Edit** → `PersonEditDialog`); **Account** (admins): Role `v-select` (enabled only when `canAdministerAccounts`), Login line (`Active · Suspend` / `Suspended · Reactivate` / `Invited · Resend` / `No login · Invite`), Last sign-in; errors from `patchLogin` shown under the section (e.g. the last-administrator message); **Access**: three count rows (Owns · Shared with them · Investigator), each a button that loads `?list=` and lists records (kind chip, code, title, level, "granted by"); `source === 'access'` rows get **Remove** for admins (calls `removeDirectGrant`, then reloads counts); other sources say "change on the project" / "co-owner (old entry)". Esc and the × close it (focus returns to the row); on phone it is a sheet with the same `backdropDismiss` behaviour as the shell's.
- [ ] **Step 1:** Implement; typecheck → 0 errors.
- [ ] **Step 2: Commit** — `feat(starbase-pages): person panel with account and access`

### Task 8: invite dialog and accept-invite page

**Files:**
- Create: `packages/starbase-pages/src/people/InviteDialog.vue`; `apps/starbase/web/src/acceptInvite.ts`, `acceptInvite.test.ts`, `AcceptInvite.vue`
- Modify: `apps/starbase/web/src/router.ts` (`{ path: '/accept-invite', name: 'accept-invite', component: AcceptInvite, meta: { public: true } }`), `src/main.ts` (route-name check: also skip the sign-out redirect for `accept-invite`), the `afterEach` title (`Set your password · STARbase` for this route), `src/routes.test.ts`

**Interfaces:**
- `InviteDialog` props `{ person?: PeopleRow | null; roles; canAdministerAccounts }`, emits `invited`; fields: email (prefilled), full name (only without a person), account role (`v-select` for account administrators, else fixed "Lab Member"); shows "The invite expires in 7 days." and the endpoint's 409 messages; on `email_sent: false` says "The login was created but the email could not be sent — use Resend."
- `acceptInvite.ts`: `export async function acceptInvite(api, token: string, password: string): Promise<'ok' | 'expired' | 'invalid' | { policy: string }>` — `api.post('/users/invite/accept', { token, password }, { sbNoGuard: true })`; maps Directus `TOKEN_EXPIRED` → `'expired'`, `INVALID_TOKEN`/`INVALID_PAYLOAD` on token → `'invalid'`, a password-policy failure → `{ policy: message }`. `export function tokenFrom(query): string | null`.
- `AcceptInvite.vue`: password + confirm, the live policy hint, submit → on `'ok'` call `session.signIn(email-from-token, password)` (the JWT payload's `email`, read with `tokenEmail(token)` exported from `acceptInvite.ts`; no signature check needed client-side) then `router.replace('/')`; `'expired'`/`'invalid'` → "This invite link has expired or was already used. Ask an admin to resend it."
- [ ] **Step 1: Failing tests** `acceptInvite.test.ts` (with `fakeServer`): `ok on 204`, `expired on TOKEN_EXPIRED`, `invalid on INVALID_TOKEN`, `policy message passed through`, `tokenEmail reads the payload email`, `tokenFrom ignores arrays`. `routes.test.ts`: `/accept-invite resolves to AcceptInvite and is public`.
- [ ] **Step 2: Run** `npm test -w starbase-web` → FAIL. **Step 3: Implement. Step 4: Run → PASS**, `npm run typecheck -w starbase-web` → 0.
- [ ] **Step 5: Commit** — `feat(starbase): invite dialog and accept-invite page`

### Task 9: E2E, preview, docs

**Files:**
- Create: `tests/ui/specs/17-people-admin.spec.ts`
- Modify: `tests/ui/README.md` (row), `scripts/dev/explorer_preview.sh` (default `D1_PREVIEW_OVERLAY` gains `d1-people-admin d1-record-access`), `docs/runbooks/starbase.md` (people-admin rollout: set nothing new except `USER_INVITE_URL_ALLOW_LIST` comes from `STARBASE_URL`; apply migration 173; restart directus), the spec (errata E1–E4 under a "§9 Errata (plan 1)" heading)

- [ ] **Step 1: Write the spec** (preview `D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057`, `signInStarbase`):
  - `admin: chips and Sort change the URL and survive reload` (`/people?f=former&sort=last`).
  - `admin: the attention line opens a filtered list` (a `logins_without_person` item exists in the preview: create a login with `adminApi` first).
  - `admin: person panel shows account role and last sign-in; role change round-trips` (member account → Lab Admin → back).
  - `admin: suspend and reactivate the member login`; the member's next request is signed out.
  - `admin: invite a new person` → row shows "Invite not accepted"; `/accept-invite?token=bogus` shows the expired/used message.
  - `member: no attention line, no Role menu; own row opens the panel; GET /d1-people-admin/people answers 403`.
- [ ] **Step 2: Run** `cd tests/ui && npx playwright test specs/17-people-admin.spec.ts` → PASS (and specs 13, 15 still pass).
- [ ] **Step 3: Commit** — `test(ui): people admin E2E; docs and preview overlay`
- [ ] **Step 4:** Push, open PR 1 as **draft** stacked on `feat/people-teams` (base: `feat/people-teams` until the spec PR merges), body lists the runbook steps; the maintainer applies migration 173 on live.

---

## Plans 2–4 (outline; detailed after PR 1 lands)

**Plan 2 — Teams (PR 2).** Migrations 174+: `teams`, `team_members` (+ deferred "at least one manager" trigger), team columns on the five access tables (`person_id` nullable, `team_id`, `trust_new_members`, CHECK, partial uniques), five `<type>_access_members` tables + bookkeeping triggers (spec §2.1), `team_events` (trigger-written), editors/managers tables + `editors_of_*` / `managers_of_*` (production + `_spec`), recompute triggers extended, `rights_drift()` / `rights_rebuild()`, oracle + `readers_matrix.sh` → rights matrix, performance gate on the seeded copy. `access_rules.json` / `gen_access_rules.py`: update/delete/manage become `editors` / `managers` one-hop rules; permissions per spec §2.3. `d1-teams` endpoint (§3.1), `d1-record-access` team routes (§3.2), `d1-access-guard` reads managers (§3.3). Kit: `TeamTile`, `TeamCard`, `teamPalette.ts`, AccessDialog/AccessPersonPicker team support, `WaitingForYou` Home card. Pages: People/Teams switch, `TeamsView`, `TeamPage` (`/teams/:id`), person panel "Through teams" + "Waiting for approval", Team menu, attention item `former_in_team`. Runbook: cutover like A1a (backup, apply, `rights_rebuild()`, drift check, Redis flush, restart).

**Plan 3 — Team ownership (PR 3).** `owner_team_id` on four tables (+ CHECK, RESTRICT), rights functions' owner-team branch, transfer to a team in `d1-record-access`, guard, owner display (record rails, AccessDialog "Additive (managers)"), add-member dialog's "will get Can edit on N records", team delete refusal.

**Plan 4 — My teams (PR 4).** Index-page Team filter (`access._some.team_id` or `owner_team_id`), Home `MyTeams` panel.
