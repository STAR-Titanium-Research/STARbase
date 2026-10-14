# People and Teams: an admin People page, and teams that can be given access

- **Status:** Draft for maintainer review (2026-10-14)
- **Decision record:** [ADR-0016](../../adr/0016-teams.md) (amends [ADR-0014](../../adr/0014-record-access.md))
- **Glossary:** `CONTEXT.md` § People and access (Person, Login, Account role, Access level, Owner, Team, Team manager,
  Pending member, Trust future members, Former, Suspended)
- **Mockup:** [`2026-10-14-people-and-teams-mockup.html`](./2026-10-14-people-and-teams-mockup.html) (second pass, the
  agreed density)

## Why

The People page is a flat list with a Researcher/Operator chip and an edit dialog. Admins cannot see or change account roles,
invite someone, see who never signed in, find logins with no person, or answer "what can this person see". And access can
only be given person by person: a sub-group that works together has to be added to every record one name at a time. The
maintainer wants teams that can be given access the way Google Groups can, shown as one entry that reveals its members on
hover.

## Decisions (maintainer, 2026-10-14, binding)

People page
1. Admin controls wanted: **accounts and roles**, **who sees what**, **activity and health**. Offboarding (Former ⇒ suspend ⇒
   transfer) is **not** wanted; Former triggers nothing automatically (Q5).
2. New logins come by **email invite** from STARbase; the login is linked to its person in the same server call (Q22).
3. Only an **Administrator** changes an account role, suspends a login, or invites with a role above Lab Member. A Lab Admin
   sees everything an Administrator sees, edits People rows, links logins, invites (as Lab Member) and manages any team (Q11).
4. Everyone sees their **own** person panel; only admins see other people's access (Q12).
5. The list keeps filtering: quick chips with counts plus Role, Team and Sort menus. One quiet "needs attention" line (Q23).
6. People and Teams are a **switch** on the People page, not two sidebar entries.

Teams
7. A team is **not an account**: it cannot sign in and never acts by itself (Q2). Members are **people** (a person with no
   login may be one, Q4); teams do not contain teams.
8. **Anyone** may create a team; its creator becomes a **team manager**; managers (and admins) change membership and name
   other managers (round 0). A team always has at least one manager (Q13).
9. All teams and their members are visible to every member; no private teams (Q10).
10. Storage: a separate `teams` table, a team as a second kind of grantee on the five access tables, and the **edit and own
    rights materialised in SQL** beside the readers (data-model option 2).
11. **Owner approves joiners.** A team manager must never widen access to a record they do not own. Sharing a record with a
    team covers its members at that moment; someone who joins later gets that record's access only when its owner approves,
    or when the owner ticked **Trust future members** on that record's team entry (per record, Q7). Leaving removes access at
    once.
12. Approval is asked only when joining would **raise** that person's access to the record, and says what changes (Q8). A
    decline is remembered for that record; the owner can approve later from "Who has access"; the joiner is not asked again
    (Q6). Each affected owner gets **one email per joiner** listing the records, and a Home **Waiting for you** card holds
    every open request (Q17). The joiner's own panel says "Waiting for approval: N records (M owners)", with no titles (Q18).
13. A team can **own** samples, campaigns, operations and tests, never a project; on a project a team can be an
    **Investigator**, never the PI (Q9). The team's managers act as the owner. A record becomes team-owned only through
    **Transfer ownership** (Q15). Someone a manager adds to a team that owns records gets Can edit on them at once; the add
    dialog says so (Q16).
14. A team that owns records cannot be deleted until its managers transfer them; deleting a team removes its access entries
    and tells the owners (Q14).
15. Adding a team to a record emails each **active** member with an email and a login, naming the team ("via Additive");
    pending members are mailed when approved (Q19).
16. A team's page shows counts per access level to everyone; its record list shows only what the viewer can read, plus "and N
    you can't see" (Q20). It has a **History** (last 20 events, "show all") (Q26).
17. Teams and membership change **only through STARbase**; in Data Studio the team tables are read-only for Lab Members and
    editable by Administrators only (Q25).
18. Identity: unique name, optional one-line description, a **colour** from a fixed palette, an optional **logo** upload
    (Q28, Q30, Q31).
19. **"My teams" on Home** and a **Team filter** on index pages: a team's work is the records it owns or has an access level
    on (Q21).
20. An admin can remove a **direct** grant from a person's panel; access through a team or a project is listed with "change on
    the team / project" (Q27).

## 1. What people see

### 1.1 People page (`/people`)

Header: `People | Teams` switch, search, **Invite** (admins) and **Add person** (everyone, as today).

**People view**
- Chips with counts: Everyone · Researchers · Operators · No login · Former. Menus: **Role** (any, Administrator, Lab Admin,
  Lab Member, no login), **Team** (any, or one team), **Sort** (name, last sign-in, recently added). Chip, menus and search
  combine; the state is in the URL query (`?f=former&team=<id>&sort=last`) so a view can be pinned.
- **Needs attention** (admins only): one line, "3 things need attention · review". *Review* opens a small menu of the items
  with a count above zero; picking one filters the list (`?attn=<key>`). Items: logins with no person; invites not
  accepted; people missing an email; possible duplicate names (same normalised full name, or same email); Former people
  whose login is still active; Former people still in a team; Suspended logins that still own records.
- A row: avatar, name, Researcher/Operator under it; right side: account role (admins; "No login" for everyone) and last
  sign-in (admins). A row carries one amber note only when something is off (Invite not accepted, Suspended, in an
  attention item). Former rows are dimmed. A login with no person is listed as its email with "Link to a person…".
- Clicking a row opens the **person panel** beside the list (a bottom sheet on a phone).

**Person panel**
- Head: avatar, name, email, Edit (opens today's edit dialog).
- Account (admins; Administrators can change): Role (select), Login (Active · Suspend / Suspended · Reactivate / Invited ·
  Resend), Last sign-in. A Lab Admin sees these read-only. No login: **Invite** (Administrator chooses the account role; a Lab
  Admin's invite is Lab Member).
- Teams: chips (team colour or logo); "+ Add to team" for admins and for managers of a team.
- Access: three counts (Owns · Shared with them · Through teams), plus "Waiting for approval: N records (M owners)" when it
  applies. Clicking a count lists the records (kind chip, code, title, access level, "via <team>" / "granted by <name>");
  direct grants have **Remove** (admins); team and project paths say where to change them.
- Visibility: the panel is shown to admins for anyone and to a member for themselves. For anyone else a member sees the
  existing read-only row (name, Researcher/Operator, teams).

### 1.2 Teams view (`/people?view=teams`) and a team's page (`/teams/:id`)

- **Teams view:** a row per team: tile (logo, or initials on the team colour), name, description, member count, managers'
  names. Chips: All · My teams. **New team** for everyone.
- **Team page:** tile, name, description, "N members · M records". **Members** (manager badge; managers and admins: Add
  member, Make manager, Remove, Leave); **Records** (counts per level for everyone: Owns · Can edit · Can view ·
  Investigator; the list only shows records the viewer can read, then "and N you can't see"); **History** (adds, removes,
  manager changes, approvals and declines, renames, shares; last 20, "show all"). **Edit** (managers, admins): name,
  description, colour, logo. **Delete** (managers, admins): refused while the team owns records ("Transfer its 12 records
  first").
- **Add member dialog** lists what happens: "Femi will get Can edit on the 12 records Additive owns. Owners of 26 other
  records shared with Additive will be asked to approve." Adding a person with no login is allowed and says so.
- **Removing the last manager** is refused ("Make someone else a manager first"); admins may always manage.

### 1.3 Team tile and hover card

One kit component, `TeamTile` (square, logo or initials on the palette colour), and `TeamCard`: name, member count, members
with manager badges and "no login" tags (first 6, then "and N more"), "Open team". The card opens on **hover, keyboard focus
or tap** (a popover, not a title tooltip), closes on Escape or leaving; it fetches the team once per page and caches it.
Used in the People list, the person panel, "Who has access", record rails (owner), the Teams view and the Home panel.

### 1.4 "Who has access" (`AccessDialog`)

- The add box finds people **and** teams ("Add people or teams"); a team result shows its tile and member count.
- A team row: tile, name, "Team · 6 members", a face stack; the row opens `TeamCard`. Its access level select (Can view /
  Can edit; Investigator on a project) and Remove behave like a person's. Owners see on the row: **Trust future members**
  (checkbox, off by default) and, when there are any, "2 waiting · 1 declined" which expands to per-person Approve /
  Decline (declined: Approve).
- A team owner shows as "Additive (managers)" with the tile; "Transfer ownership…" offers teams for samples, campaigns,
  operations and tests (not projects).
- "Only <owner> can change who has access" reads "Only Additive's managers …" for a team-owned record.

### 1.5 Home

- **Waiting for you** card (only when non-empty): one line per joiner and team, "Femi Noor joined Additive · 12 of your
  records", with **Approve all** / **Decline all** / **Review** (lists the records, per-record choice). Approving covers only
  records where it would raise access (decision 12).
- **My teams** panel (PR 4): the most recently changed records across the viewer's teams, one line each with the team tile.
- Index pages (PR 4): a **Team** filter (any / one team) = records the team owns or has an access entry on.

### 1.6 Invites and the accept page

- **Invite** (person panel or the header): email (prefilled from the person), account role (Administrator: any; Lab Admin:
  Lab Member only). The server creates the login with Directus's invite, links it to the person (creating the person when
  invited from the header), and Directus mails the link. The row shows "Invite not accepted · Resend", and the invite says
  it expires in 7 days.
- **Accept page** `/accept-invite?token=…` in STARbase (outside the signed-in shell, like the sign-in page): set password
  (the live password policy is shown), then signed in and sent Home. An expired or used token says so and names who to ask.

## 2. Data model

New migrations from **173** (main is at 172; check other open branches before claiming).

```sql
CREATE TABLE teams (
    team_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT NOT NULL DEFAULT 'teal' CHECK (color IN ('teal','blue','indigo','violet','pink','red','orange','amber','green','slate')),
    logo        UUID REFERENCES directus_files(id) ON DELETE SET NULL,
    created_by_person_id UUID REFERENCES people(person_id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_key ON teams (lower(name));

CREATE TABLE team_members (
    team_id    UUID NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    person_id  UUID NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    is_manager BOOLEAN NOT NULL DEFAULT false,
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, person_id)
);
-- a deferred constraint trigger refuses a commit that leaves a team with members but no manager
```

**The five access tables** (`sample_access`, `operation_access`, `test_access`, `campaign_access`, `project_access`):
- `person_id` becomes nullable; add `team_id UUID REFERENCES teams ON DELETE CASCADE` and `trust_new_members BOOLEAN NOT NULL
  DEFAULT false`; `CHECK (num_nonnulls(person_id, team_id) = 1)`; `trust_new_members` only with a team; unique
  `(record, person_id)` and `(record, team_id)` as partial unique indexes.
- Per table, `<type>_access_members(access_id → <type>_access ON DELETE CASCADE, person_id → people ON DELETE CASCADE, state
  TEXT CHECK (state IN ('active','pending','declined')), decided_by_person_id, decided_at, PRIMARY KEY (access_id,
  person_id))`. One row per member of the granted team. Five tables, not one polymorphic table, so every row has a real
  foreign key and cascades (the same reasoning as ADR-0014's five access tables).

**Ownership:** `owner_team_id UUID REFERENCES teams ON DELETE RESTRICT` on `physical_samples`, `manufacturing_operations`,
`test_sessions`, `campaigns`; `CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1)` (existing rows may have no owner).
`RESTRICT` is what refuses deleting a team that owns records.

**History:** `team_events(event_id, team_id ON DELETE CASCADE, at, actor_person_id, kind, person_id, collection, record_id,
detail JSONB)`; kinds: `created`, `renamed`, `member_added`, `member_removed`, `manager_set`, `manager_unset`, `shared`,
`unshared`, `approved`, `declined`, `trust_set`, `trust_unset`. Written by the triggers below (actor from
`d1.actor_identity`, as migration 128's audit), so Data Studio edits by Administrators are recorded too. When a team is
deleted its history goes with it; the owners' emails are the record of that.

### 2.1 Membership bookkeeping (triggers, so every writer obeys it)

| Event | Effect on `<type>_access_members` |
|---|---|
| A team is granted on a record | one `active` row per current member |
| A person joins a team | for each grant of that team: `active` if `trust_new_members`, else `pending` |
| A person leaves a team | their rows for that team's grants are deleted |
| An owner approves / declines | `active` / `declined`, with who and when |
| Trust future members turned on | the grant's `pending` rows become `active` (declined stay declined) |
| A grant is removed | its rows go (cascade) |

Members of a team that **owns** a record need no rows: ownership is read from `team_members` directly (decision 13).

"Would joining raise their access?" is not stored. A `pending` row stays pending whatever else the person can see; the Home
card, the email and the dialog's "N waiting" show a pending row only while approving it would raise that person's level
(computed from the rights tables below). So if their other path to the record goes away later, the request appears then.

### 2.2 Rights: readers, editors and managers, all materialised

Directus can reach a person through `access._some.person_id.user_id` but not through a team
(`access._some.team_id.<members>.user_id` is a to-many hop inside `_some`, refused by 11.17; see the Directus filter
traps). So, beside the existing `<type>_readers(record_id, user_id)`:

- `<type>_editors(record_id, user_id)`: logins that may update the record (today's `sample.editors` / `record.update` /
  `campaign.update` / `project.pi` sets, plus team paths), always a subset of the readers.
- `<type>_managers(record_id, user_id)`: logins that may manage it (delete, change access, transfer, restrict): the owner,
  or the owning team's managers; the PI for a project.

They are computed by `d1_private.editors_of_<type>()` and `d1_private.managers_of_<type>()` next to `readers_of_<type>()`,
recomputed by the **same** statement triggers under the **same** global advisory lock, checked by the same drift function
(`readers_drift()` grows to `rights_drift()`, still shown on `/d1-admin-overview`) and rebuilt by `rights_rebuild()`.

The team paths, added to every function family:
- **Read:** an active `<type>_access_members` row of the person's login; for a team-owned record, every member's login.
- **Edit:** the same with the grant's level `edit` (on a project, `investigator` follows today's investigator rule); every
  member of an owning team.
- **Manage:** the owning team's managers.
- A team grant on a **Restricted** record lists its active members exactly as a person entry would (the cascade of ADR-0014
  decision 4 is unchanged).

The Directus rules then become one hop each: update `editors._some.user_id = $CURRENT_USER`, delete and manage
`managers._some.user_id = $CURRENT_USER` (the reader term is already inside the tables). `access_rules.json` and
`gen_access_rules.py` are updated to emit them; `--check` stays in CI. The old junctions (`sample_co_owners`,
`project_investigators`) keep counting through the functions, as now.

### 2.3 Directus permissions

| Collection | Lab Member | Lab Admin | Administrator |
|---|---|---|---|
| `teams`, `team_members`, `team_events` | read all | read all | full |
| `<type>_access_members` | read where a reader of the record (the child pattern: one bare hop to the record's readers) | read all | full |
| `<type>_editors`, `<type>_managers` | own rows (like the readers tables) | read all | full |

Writes to teams, membership, team grants and approvals go through the endpoints below with the system accountability after
their own checks. Lab Admins edit teams only through STARbase (decision 17).

## 3. Server

### 3.1 `d1-teams` (new endpoint)

| Route | Needs | Does |
|---|---|---|
| `GET /` | a login | all teams: tile data, member count, managers, `is_member`, `is_manager` |
| `GET /:id` | a login | team, members (name, can_sign_in, is_manager), record counts per level, the record list filtered to what the caller can read plus `hidden_count`, history (paged) |
| `POST /` `{name, description?, color?}` | a login with a person | creates; the caller becomes its manager |
| `PATCH /:id` `{name?, description?, color?, logo?}` | manager or admin | edits; a logo must be an image ≤ 1 MB (png, jpeg, svg) uploaded to a fixed `Team logos` folder |
| `DELETE /:id` | manager or admin | refused 409 while it owns records (lists counts); else deletes and mails the owners of the records it was on |
| `POST /:id/members` `{person_id, is_manager?}` | manager or admin | adds; answers what happened (`owned_edit: n`, `pending: n`, `owners_asked: n`); mails each owner asked, once per joiner |
| `PATCH /:id/members/:person_id` `{is_manager}` | manager or admin | sets or clears manager (last manager refused 409) |
| `DELETE /:id/members/:person_id` | manager, admin, or the person themselves | removes (last manager refused 409) |
| `GET /pending` | a login | the caller's Waiting-for-you items, grouped by joiner and team, only rows where approving would raise access |
| `POST /pending/decide` `{team_id, person_id, decision, records?}` | manages each record | approves or declines across the caller's records for that joiner and team (or only `records`) |

### 3.2 `d1-record-access` (extended)

- `GET` returns team entries: `{ team_id, name, color, logo, member_count, role, trust_new_members, waiting, declined }` and
  `owner` may be a team `{ team_id, name, managers }`.
- `POST …/entries` accepts `{team_id, role}`; `PATCH …/entries/team/:team_id` `{role?, trust_new_members?}`; `DELETE
  …/entries/team/:team_id`; `POST …/entries/team/:team_id/members/:person_id` `{decision}` (per-record approve / decline).
- `POST …/transfer` accepts `{team_id}` for the four ownable types; mails the team's managers.
- `can_manage` reads `<type>_managers` instead of re-running the manage filter.
- Emails: a team grant mails each active member with an email and a login ("via Additive"); approval mails the joiner; the
  join request mails each owner (one per joiner, listing kind and code of their affected records; titles only for records
  the owner can read, which is all of them).

### 3.3 `d1-access-guard` (extended)

The owner and Restricted guards treat "is the owner" as "is in `<type>_managers`". Setting `owner_team_id` directly (Data
Studio) is held to the same rule as `owner_person_id`; setting both is refused by the CHECK.

### 3.4 `d1-people-admin` (new endpoint, PR 1)

| Route | Needs | Does |
|---|---|---|
| `GET /people` | admin | People rows joined to logins: account role, status, `last_access`, teams, attention flags; plus logins with no person |
| `GET /attention` | admin | the seven counts |
| `GET /people/:person_id/access` | admin, or the person themselves | counts and lists from the rights tables and access tables (owns, shared with them, through teams, pending) |
| `PATCH /logins/:user_id` `{role?, status?}` | **Administrator** | changes the account role or suspends / reactivates; refuses demoting the last Administrator |
| `POST /invite` `{person_id? , full_name?, email, role}` | admin (role above Lab Member: Administrator) | Directus `UsersService.inviteUser(email, role, <STARbase>/accept-invite)`, then links `people.user_id` in the same transaction (creating the person when needed) |
| `POST /invite/resend` `{user_id}` | admin | re-sends |

**Administrator vs Lab Admin.** Both roles have `admin_access`, so STARbase's `isAdmin` cannot tell them apart. The endpoint
decides by role: the Administrator role is found by name once at start-up and can be pinned with `D1_ADMINISTRATOR_ROLE_ID`.
It answers `can_administer_accounts` in `GET /people` so the page knows which controls to draw.

**Config.** `USER_INVITE_URL_ALLOW_LIST` gains `${STARBASE_URL}/accept-invite`; the accept page posts to
`/users/invite/accept`.

## 4. STARbase and kit

- `packages/starbase-pages/src/people.vue` splits into `people/PeopleView.vue` (list, filters, attention),
  `people/PersonPanel.vue`, `people/TeamsView.vue`, `people/InviteDialog.vue`; new `pages/TeamPage.vue` (`/teams/:id`) and
  `AcceptInvite.vue` in the STARbase app (outside the shell).
- Kit (`@d1/ui`): `TeamTile`, `TeamCard` (popover), team support in `AccessDialog` / `AccessPersonPicker` / `accessModel`,
  a `WaitingForYou` Home card, the palette (`teamPalette.ts`: about 10 keys, each with a light and a dark shade checked for
  4.5:1 text contrast on both themes).
- Index pages (PR 4): the Team filter as a fixed filter; Home `MyTeams` panel.
- Routes: `people` (unchanged path, `?view=teams`), `teams/:id`; the route harness (`tests/ui/specs/13-explorer-routes`) gains
  both.

## 5. Delivery

| PR | Contents | Depends on |
|---|---|---|
| 1 | People page for admins: filters, attention, person panel, account role, suspend, invites and accept page, `d1-people-admin` | none |
| 2 | Teams: tables, membership triggers, team grants, **editors and managers tables** and the one-hop rules, `d1-teams`, team page, `TeamTile`/`TeamCard`, AccessDialog teams, approvals, Waiting for you, emails, history | 1 (the People/Teams switch) |
| 3 | Team ownership: `owner_team_id`, transfer to a team, guard, owner display | 2 |
| 4 | My teams on Home, Team filter on index pages | 2 |

Each PR is a draft until the maintainer reviews it; migrations are applied to live only by the maintainer, following a
runbook section added in PR 2 (as A1a's cutover: backup, apply, `rights_rebuild()`, drift check, Redis flush, restart).

## 6. Testing

- **Rights equality.** `tests/readers_matrix.sh` becomes a rights matrix: for readers, editors and managers, production
  function = `*_spec` function = the independent oracle (`scripts/dev/access_matrix_oracle.sql`, extended with teams,
  member states, trust and team owners), on the fixture and on random universes that now include teams.
- **Mutation matrix** extended with: join (trust on / off), leave, approve, decline, trust turned on, grant removed, team
  deleted, manager change, transfer to and from a team, Restricted record with a team grant.
- **Directus smoke** (copy of live) with a team-shared record as Lab Member: can read, can edit only at Can edit, pending
  member cannot, Data Studio write to `team_members` refused for a Lab Member.
- **Endpoint unit tests** (`node:test`) for `d1-teams`, `d1-people-admin` and the new `d1-record-access` routes, including
  Lab Admin vs Administrator, last manager, last Administrator, invite linking.
- **Performance gate** on the seeded copy, as A1a: every list under 80 ms p95; a join to a team on 100 records and a grant of
  a 20-person team each under 500 ms.
- **UI:** vitest for the kit pieces; Playwright: People filters, person panel, invite and accept (preview with a mail
  catcher), team page, Who-has-access with a team, approve from Home; STARbase phone layout for the card and the sheet.
- `tests/phase1_schema.sh`: the new tables are not granted to `d1_llm_readonly` (Ask-DB unchanged).

## 7. Known gaps (accepted)

- Administrators editing `team_members` in Data Studio get the bookkeeping and history (triggers) but no emails (those come
  from the endpoints).
- A team's name, colour, logo and member list are visible to every member, including names of members who have no login.
- Team logos are ordinary files: readable by id by any member (the files gap A1b closes elsewhere; a logo is not sensitive).
- A person removed from a team and re-added is a new joiner: their earlier approvals are gone (rows were deleted on leave).
- Ask-DB does not see teams (no grant); questions about team membership are not answerable there.
- The last-Administrator rule is enforced only by `d1-people-admin`: Data Studio's `/users` page can still demote or suspend the
  last Administrator.
- Invite delivery failures show only in the Directus log: Directus sends the invite mail without waiting, so the page can say
  "sent" but never "delivered" (E7).

## 9. Errata (plan 1)

Where building PR 1 (the admin People page, `docs/superpowers/plans/2026-10-14-people-1-admin-page.md`) differs from the text above.

- **E1 Account administrator.** The spec said "find the Administrator role by name" (§3.4). The preview's admin has no role (an
  admin policy attached to the user), so instead an **account administrator** is a login that reaches an `admin_access` policy
  (`d1-record-access` `isAdminLogin`) **and** whose role is not the Lab Admin role. `D1_LAB_ADMIN_ROLE_ID` may override the id;
  `D1_ADMINISTRATOR_ROLE_ID` is not used.
- **E2 No mail catcher.** The preview network has no outbound mail and the repo has no catcher (§6 assumed one). Invite email
  delivery is covered by the endpoint's unit tests (fake `UsersService`); the Playwright spec checks that the invited login exists,
  is linked and shows "Invite not accepted", and the accept page's error path.
- **E3** The "Former people still in a team" attention item (§1.1; `GET /attention` returns six counts in PR 1, not seven), the
  **Team** menu and the **Through teams** count arrive with PR 2, when teams exist.
- **E4** Removing a direct grant from the person panel calls the existing
  `DELETE /d1-record-access/:collection/:id/entries/:person_id` (administrators manage every record); there is no new route.
- **E5** The "Former people still in a team" item, the Team menu and the Through-teams count are PR 2's, not PR 1's (E3, listed
  separately so it is not missed when PR 2 is planned).
- **E6** `POST /invite` answers `200` (not `201`) when it re-sends the invite to a login that is already invited under the same
  e-mail; a new login is `201`.
- **E7** `email_sent` means "handed to Directus's mailer". Directus sends invites fire-and-forget, so a delivery failure shows only
  in its log; the UI says "sent", never "delivered". A mail error that does surface keeps the login and its link and gives
  `email_sent: false` (the page then points to Resend).
