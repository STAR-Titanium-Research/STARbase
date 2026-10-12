# Ownership & identity cleanup — design

Date: 2026-10-01
Status: approved in conversation, pending written-spec review
Follow-up: sub-project 2 — per-collection access rules (separate spec)

## Goal

One identity per human. A researcher's Directus login *is* them: whatever they
create is prefilled with them as owner (editable) and permanently stamped as
created by them. Technicians are recorded (e.g. as machine operator) but never
log in. Remove the duplicated login-based ownership fields that currently sit
alongside the person-based ones.

## Decisions (from the design conversation)

| Question | Decision |
|---|---|
| Identity table | Keep `people`, strictly one row per human. Researchers link 1:1 to a login (`people.user_id`); technicians have no login. |
| Who can be an owner | Researchers only (`is_researcher` and linked to a login). Operators may be any person. |
| Default owner on a new record | The logged-in user's person ("login wins"). |
| Parent inheritance | Only when the user ticks "same as parent" on the form. Unticked by default. |
| Bulk box intake | The owner on the intake form applies to every generated box, insert and edge. |
| "Created by" | New `created_by` column (Directus `user-created`), automatic and read-only. |
| Canonical login for Dennis | `dennis.premoli2@sheffield.ac.uk` (Lab Admin). Deactivate `dpremoli1@sheffield.ac.uk` and `dennis.premoli@gmail.com`. |
| Access control | Out of scope here. Sub-project 2: per-collection mix (some collections private to owner, others shared). This design must not block row-level rules. |
| Force app | Must keep working with no code change to `apps/force-app`. |
| Several operators per run | Operations and test sessions keep one **main operator** (`operator_person_id`, what the force app sets) plus an **"Additional operators"** many-to-many list. Additional operators also see the run in the force dashboard. |
| Historical operators | Curated by Dennis in `db/mappings/operator-mapping.xlsx` (MAP / NEW / IGNORE + additional people). IGNORE rows keep only the `operator_name` text. |

## Current state (measured 2026-09-30)

Legacy login-based fields (`owner`, `operator` → `directus_users`) exist next to
person-based ones (`owner_person_id`, `operator_person_id` → `people`); the
legacy ones are hidden in the UI but still hold data.

| Table | rows | legacy owner set | person owner set |
|---|---|---|---|
| tool_boxes | 26 | 0 | 5 |
| cutting_inserts | 218 | 0 | 40 |
| insert_edges | 312 | 0 | 160 |
| physical_samples | 143 | 142 | 142 |
| manufacturing_operations | 10283 | 678 | 208 |
| campaigns | 7 | 4 | 7 |
| projects (PI) | 6 | 3 | 4 |
| etchants / prep_recipes / test_sessions | 15 / 0 / 0 | 0 | 0 |

`manufacturing_operations`: 473 rows have only the legacy owner. 271 resolve
through an existing `people.user_id`; 202 belong to James Pepper, whose login
and `people` row exist but are not linked.

Identity duplicates:

- James Pepper, Jack Krohn — login and `people` row exist, unlinked.
- Sam Lister — login linked to a `people` row named "Sam"; a second "Sam
  Lister" operator row also exists.
- Dennis — three logins (see decisions).
- 3 logins have no `people` row.

Junctions `project_investigators` and `sample_co_owners` are keyed on
`user_id` with a backfilled, hidden `person_id`.

No `directus_permissions` rule references owner, operator, investigator or
co-owner fields, so switching them to `people` changes no current access.

Other owner fields to remove: `projects.principal_investigator` (→ users) and
`projects.principal_investigator_name` (free text, a one-time backfill source).

## Design

### 1. Identity model

- **Invariant:** every `directus_users` row that represents a human has exactly
  one `people` row with `user_id` = that login; every `people` row has at most
  one login. Enforced by a unique index on `people.user_id` (partial, non-null).
- **Auto-link hook** (Directus `users.create` action): link an existing unlinked `people` row with the same email
  (case-insensitive), else the same full name, else create one; set
  `is_researcher = true`.
- **One-off cleanup migration:**
  - Link James Pepper and Jack Krohn.
  - Merge "Sam" and "Sam Lister": keep one row, repoint every FK that
    references the removed row (all `*_person_id` columns, junction
    `person_id`s), then delete it.
  - Create `people` rows for logins without one.
  - Dennis: link his person row to `dennis.premoli2`, repoint any legacy
    references to the other two logins onto it, set those two logins
    `status = 'suspended'`, and delete the junk "dennis.premoli@gmail.com"
    person row after repointing.
  - Ends with an assertion query; the migration aborts if any login has zero
    or multiple people rows or any person has multiple logins.

### 2. Owner field and server backstop

**Custom interface `d1-owner-picker`** (Directus extension, pattern of
`d1-project-inherit`), used on the owner field of every ownable collection:

- Options: researchers only (`is_researcher = true`, `user_id` not null).
- New item: prefills the current user's person (looked up via
  `people.user_id = $CURRENT_USER`), shown before save.
- Existing item: shows the stored value; never changes it on open.
- "Same as parent" checkbox, shown when the collection has a parent relation
  (configured via interface options: parent field + parent's owner field).
  When ticked, sets the owner to the parent's owner and follows parent changes
  while ticked. Unticked by default. The tick state is UI-only (not stored).

Ownable collections and their parent (if any):

| Collection | Owner field | Parent for "same as parent" |
|---|---|---|
| physical_samples | owner_person_id | — |
| tool_boxes | owner_person_id | — |
| cutting_inserts | owner_person_id | tool_box_id → tool_boxes |
| insert_edges | owner_person_id | insert_id → cutting_inserts |
| etchants | owner_person_id | — |
| prep_recipes | owner_person_id | — |
| campaigns | owner_person_id | project_id → projects (principal_investigator_person) |
| manufacturing_operations | owner_person_id | campaign_id → campaigns |
| test_sessions | owner_person_id | campaign_id → campaigns |
| projects | principal_investigator_person | — |

**Server backstop hook** (replaces `d1-default-owner`), `items.create` filter
on every collection in the table above: if the owner field is blank, set it to
the current user's person. If the login has no linked researcher person (e.g. a
machine token), leave it blank. Never overwrite a supplied value.

**Hooks removed or reduced:**

- `d1-default-owner` — replaced by the backstop.
- `owner-cascade` — removed (and the `cascade_ownership` columns + fields
  dropped); contradicts "login wins", replaced by "same as parent".
- `campaign-inherit` — keeps project / equipment / material defaults; drops
  owner inheritance (child from campaign, campaign from project PI).
- DB triggers `fill_cutting_insert_code` / `fill_insert_edge_code`
  (migration 114): keep code generation; keep the owner-from-parent fill
  **only** for bulk intake. Implementation: `expand_tool_box_intake()` sets
  `owner_person_id` explicitly on every insert and edge it creates, and the
  trigger's owner-from-parent branch is removed, so the triggers no longer make
  ownership decisions.

**Operator** (`operator_person_id` on operations / test sessions): the main
operator — any person, no prefill. **Additional operators:** junction tables
`operation_additional_operators (operation_id, person_id)` and
`session_additional_operators (session_id, person_id)`, unique per pair,
`ON DELETE CASCADE` both sides, exposed in Directus as an "Additional
operators" M2M (people) on each form.

**Historical operator backfill:** legacy `operator` (→ `Machine_Operators`)
values are linked using the curated sheet: MAP → existing person, NEW → one
person per distinct name (technician unless marked researcher), IGNORE →
`operator_name` text only. Multi-person names: first person is the main
operator, the rest go in the additional-operators list.

### 3. Created by

- Add `created_by uuid REFERENCES directus_users(id) ON DELETE SET NULL` to
  every ownable collection, Directus field `special = 'user-created'`,
  readonly, displayed as "Created by".
- Backfill from `audit_logs` where `action_type = 'INSERT'` and
  `actor_identity` is a valid user id for that record. Otherwise leave null.

### 4. Legacy removal

After backfill assertions pass:

- Backfill every null `owner_person_id` / `operator_person_id` /
  `principal_investigator_person` from the legacy column via
  `people.user_id`. Abort if any legacy value can't be resolved.
- Junctions: fill any null `person_id` from `user_id`; make `person_id` NOT
  NULL; replace the unique `(x, user_id)` constraint with `(x, person_id)`;
  repoint the Directus M2M relation and field templates to `person_id`; drop
  `user_id`.
- Drop columns: `owner` and `operator` on every table listed above,
  `projects.principal_investigator`, `projects.principal_investigator_name`,
  `cascade_ownership`. Remove their `directus_fields` and
  `directus_relations` rows.
- Before dropping, search `apps/`, `packages/`, `core/extensions/`,
  `scripts/` and every database view / function (`pg_views`, `pg_proc`) for
  references to the dropped columns and update them in the same migration.

## Force app compatibility

- Signs in with the researcher's own login and creates operations with
  `operator_person_id` and no owner → the backstop sets owner and
  `created_by` from the login. Offline-queued writes replay under the same
  user's token.
- Its dashboard scopes by `people.user_id` → person, then owner/operator —
  unchanged, and fixed for users whose person wasn't linked.
- After backfill, older operations start appearing in their owners'
  dashboards (intended).
- No change to `apps/force-app`. The shared dashboard filter in
  `packages/force-plotting/src/ForceDashboard.vue` gains one condition so
  additional operators also see their runs. Verified by a test (below).

## Compatibility with sub-project 2 (access rules)

Directus permission filters can traverse relations from the record to the
login, e.g. `{"owner_person_id": {"user_id": {"_eq": "$CURRENT_USER"}}}` or via
the co-owner junction. The 1:1 invariant in section 1 is what makes these
rules correct. Nothing here adds row-level restrictions.

## Migrations (order)

Each a separate, reversible dbmate migration; Directus metadata changes live
in the same migrations and are mirrored into `scripts/configure_directus.sql`
(never re-run wholesale).

1. Identity cleanup + unique index on `people.user_id`.
2. Backfill person fields and junction `person_id`s, with assertions;
   additional-operators junctions; curated operator backfill.
3. `created_by` columns + audit backfill; new owner interface on forms;
   `expand_tool_box_intake` / trigger changes.
4. Drop legacy columns, `cascade_ownership`, junction `user_id`; metadata
   cleanup.

Extension changes ship alongside: new `d1-owner-picker`, new backstop hook,
auto-link hook, removal of `owner-cascade` and `d1-default-owner`, reduced
`campaign-inherit`.

## Testing

Run against the live stack through the Directus REST API (so hooks fire),
following the existing box-intake test script pattern; clean up afterwards.

1. As Jozef: create a sample → owner = Jozef's person, `created_by` = Jozef.
2. Change owner to Dennis → persists; `created_by` unchanged.
3. As Jozef, add an insert to Dennis's box → owner Jozef; with "same as parent"
   → Dennis (interface behaviour checked in the browser).
4. Bulk intake with owner X → every box/insert/edge owner X.
5. Force-app-shaped POST to `manufacturing_operations` (operator set, no
   owner) → owner from login, operator preserved.
6. Invariants: no login with 0 or >1 people; no owned record points at a
   non-researcher; no legacy columns remain.
7. As James Pepper: force-app dashboard lists his operations.
8. New login created → linked/created `people` row with `is_researcher`.
9. Curated operator backfill: every MAP/NEW row's operations link their main
   operator; multi-person rows also fill additional operators; an additional
   operator's force dashboard lists the run.

## Out of scope

- Per-collection / row-level access rules (sub-project 2).
- The Lab Member permission gap on `campaigns`, `campaign_samples`,
  `manufacturers`, `directus_files` (folded into sub-project 2 unless applied
  earlier).
- Enforcing the project "secondary investigators get viewing access" notice.
