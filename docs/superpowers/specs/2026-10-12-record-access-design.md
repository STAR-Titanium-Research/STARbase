# A1: Record access ("Who has access", Restricted records)

Status: **revised after review (2026-10-12), maintainer rulings on the open questions recorded in section 11.**
The maintainer's decisions are binding and listed first; everything else is the proposed design. Builds on
[ADR-0011](../../adr/0011-row-level-visibility.md) (row-level visibility) and amends it; it does not replace it.
Implementation plan for the first phase: `docs/superpowers/plans/2026-10-12-a1a-record-access.md`; live apply:
`docs/runbooks/a1-record-access-cutover.md`.

Why: ADR-0011 made every record readable by exactly the people involved in it, by inheritance only. Nobody can
share a single sample with a colleague without making them a co-owner of it, and nobody can keep a sensitive
record private from the rest of the project. A1 adds a Google-Drive-style "Who has access" dialog (add and remove
people, transfer ownership) and a per-record **Restricted** switch, and closes the places where the data can be
read around Directus's permissions.

## Decisions (maintainer, binding)

1. **Dialog.** A "Who has access" dialog in Google Drive "Manage members" style on the Explorer record pages of
   samples, operations, tests, campaigns and projects.
2. **Who manages access.** The record's owner (for projects, the PI) and admins change access. Co-owners and other
   members can see the list, not change it.
3. **Actions.** Add and remove people; transfer ownership (with a confirm step); on projects, secondary
   investigators; on samples, co-owners.
4. **People.** Any active person in People, picked by name search. A person with no linked login is marked "can't
   sign in yet" and can still be added.
5. **Email.** When someone is added an email goes out: it names the record and who added them, gives their role
   and links to the Explorer record page. It goes through Directus's mail setup (`EMAIL_*`, configured on live). A
   failed email never blocks the change.
6. **Restricted (granular).** Records inherit access by default, as today. Any sample, operation, test, campaign or
   project can be switched to Restricted. A Restricted record is visible only to its owner, the people listed on it
   with Can view or Can edit, the project PI (who always sees everything in their project) and admins.
7. **A restricted sample hides everything under it.** Its operations and tests (and their data, analyses and files)
   are visible only to people who can see the sample AND who pass the child's own rule.
8. **Attached data follows its record:** data files, force/FAST analyses, process and test params.
9. **Roles on a record:** Can view and Can edit. Existing sample co-owners become Can edit. Unrestricted records
   behave exactly as today.
10. **Who can restrict:** the owner of the record and admins. An operation's owner can restrict it even if they do
    not own the sample.
11. **Phasing.** **A1a:** the restriction model in the database and Directus rules; the dialog; emails; params
    tables following their operation/test; Ask-the-database excluding restricted records; d1-trace showing "some
    records hidden" with no counts; deleting the legacy `core/roles.json` and `core/permissions.json` after
    confirming nothing reads them. The Restrict switch stays hidden in the UI until A1b ships. **A1b:**
    `directus_files` readable only by the uploader or through a readable record; octrees behind a login check;
    the Force App lock badge and Restricted option; turning the Restrict switch on.
12. **Out of scope:** the recorder and backup-server (pre-upload, tailnet-trusted).

Rulings of 2026-10-12 on the open questions of the first draft (also section 11):

13. **A restricted project or campaign hides what is inside it** (the cascade, section 3). A restricted project: its
    campaigns, samples, operations and tests are visible only to people who can see the project; the PI always can.
    A restricted campaign: its operations and tests (via `campaign_id`) are hidden the same way; a sample that
    belongs to a restricted campaign is hidden unless the user reaches it another way: they own it, they are on its
    own access list, or they can see it through another campaign or the project.
14. **A transfer emails the new owner.**
15. **The campaign UI's "N samples not visible" becomes "some hidden"** in A1a, with the d1-trace change.
16. **Projects offer only Can view and Secondary investigator** (no separate Can edit).
17. **The old `sample_co_owners` and `project_investigators` tables are retired later**, as a follow-up after A1b
    (out of A1a).

## 1. What people see

### The dialog

A **Who has access** button in the record rail's action row (`RecordRail` `#actions` slot, next to Edit and Print
label) on the five record pages. It opens a dialog:

```
Who has access to  Sample 25-0142                         [x]
[ Add people by name…                              v ]
---------------------------------------------------------------
  (AB) Ada Byron (you)          Owner
  (CD) Charles Dee              Co-owner  [Can edit v]   [remove]
  (EF) Edith Ford               Can view  [Can view v]   [remove]
  (GH) Grace Hall  can't sign in yet   Can view [v]      [remove]
---------------------------------------------------------------
  Project PI: Dr Ibis Jones - sees everything in the project
  [ Transfer ownership… ]                                   [Done]
```

- **Everyone who can read the record can open it** and sees the list; only the owner (PI for a project) and admins
  get the search box, the role selectors, remove buttons and Transfer. For everyone else the controls are not drawn
  and the dialog says "Only <owner name> can change who has access." A record with **no owner** (legacy rows) says
  "Only an admin can change who has access."
- **Add.** Typing searches active People by name (the same `/items/people` search the People page uses). Pick a
  person, pick a role (default Can view), Add. A person with no login shows "can't sign in yet": they are added and
  the grant starts working the day an admin links their login to the People row.
- **Roles.** Samples, operations, tests and campaigns: **Can view** and **Can edit**. On a **sample** a Can edit
  person is a *co-owner* (the label reads "Co-owner · can edit"). **Projects offer Can view and Secondary
  investigator only**: Can view sees the project page, a Secondary investigator additionally sees everything in the
  project (what the project form's `investigator_access_notice` already promises). Nobody but the PI edits a
  project. Existing co-owners and investigators from the old tables appear with those labels (section 2).
- **Transfer ownership.** Choose a person, read the confirm text ("<name> becomes the owner. You stay on the record
  as Can edit (on a project: Secondary investigator). Only the new owner can change who has access."), Confirm.
  The previous owner is kept so a transfer never makes the record disappear for the person who made it; they can be
  removed afterwards. The new owner is removed from the access list (they are the owner now).
- **Grants that cannot take effect.** If the record sits under a restricted sample, campaign or project that does
  not list the person, the dialog says so on add and on transfer ("<name> cannot see <parent>, so this will not
  take effect until its owner adds them"); the change is still made.
- **The Restrict switch** (a toggle at the top of the dialog, "Restricted: only the people below can see this")
  exists in the component behind a flag that is off in A1a and on in A1b. Nothing in A1a draws it, and the Data
  Studio form field is hidden and read-only (section 8). In A1b the text on a campaign or project reads "hides this
  campaign (project) and everything in it from people not listed here".
- **Email.** Sent to the person added, on a new grant only (not on a role change, not when you add yourself, not
  when no address is known), and to the new owner on a transfer (its own subject, "You are now the owner of …").
  Content: who added them, their role, the record's name and code, and a button linking to the Explorer page
  (`PUBLIC_URL` + `/admin/home/samples/<id>` and so on). If the mail server refuses it, the change stands and the
  dialog says "Added. The email could not be sent."

### What a Restricted record does to the people who cannot see it

It is gone from every list, count, page, search, report and the genealogy for them, exactly as an unreadable record
is today (the page says "Not found or not visible to you"). A restricted sample takes its operations, tests, files,
analyses and params with it; a restricted campaign takes its operations and tests; a restricted project takes its
campaigns, samples, operations and tests (with the sample exception below). The places that printed a count of
hidden things say "some records hidden" instead (section 8).

### Who sees a record, by state

"Gate" below means a condition the caller must pass **in addition** to the record's own rule. P, C and S are the
project, campaign and sample gates:

- **P(project)**: no project, or the project is unrestricted, or the caller is on the project's list (PI, a
  Can view or Secondary investigator entry, an old `project_investigators` row).
- **C(campaign)**: no campaign, or (the campaign is unrestricted or the caller is on its list: owner, access entry,
  its project's PI) **and** P(its project).
- **S(sample)**: no sample, or the sample is unrestricted or the caller is on its list (owner, co-owner, access
  entry, the PI of its project or of a campaign's project).

| Record | Own rule, unrestricted (today's, plus anyone listed) | Own rule, restricted | Gates, always |
|---|---|---|---|
| Sample | owner, co-owners, listed, project PI/investigators, owner of a campaign it is in, a campaign's project PI/investigators | owner, co-owners, listed, project PI, PI of a campaign's project; admins | none as a gate: a project or campaign restriction removes only the *inherited* ways to see it (below) |
| Operation / test | owner, anyone who can see its sample, listed, project PI/investigators, campaign owner, campaign's project PI/investigators | owner, listed, project PI (own project or campaign's project); admins | S(its sample), P(its sample's project), P(its project), C(its campaign) |
| Campaign | owner, listed, project PI/investigators, owner or co-owner of a sample in it | owner, listed, project PI; admins | P(its project) |
| Project | PI, listed, investigators, owner of a campaign/sample/operation/test in it | PI, listed (incl. Secondary investigators); admins | none |

**Samples under a restricted project or campaign.** A sample is always visible to its owner, its co-owners and
the people on its own access list, and to its project's PI. What a restricted project or campaign removes is the
*inherited* ways: a campaign's owner sees the samples in it only while the campaign is visible to them (P(its
project) holds), and the investigators of a campaign's project see its samples only while the campaign is
unrestricted. A sample in several campaigns stays visible through any campaign that still lets the caller in.

**What the cascade cannot do** (not expressible in Directus filters, section 3): an operation or test is not gated
by the *campaign memberships* of its sample (a sample can be in many campaigns, and "none of them lets the caller
in" needs a universal condition over a to-many relation behind a to-one hop). Nearest expressible rule: an
operation or test is gated by its **own** project and campaign and by its sample's `restricted` flag and its
sample's own `project_id`, not by the sample's campaigns. Consequence: an operation with no project or campaign of
its own on a sample whose only campaign is restricted stays visible to the operation's owner, while the sample is
hidden from them.

Edit is never wider than read: an owner, a Can edit person and (for operations and tests, unless restricted) the
sample's editors can update; delete and manage stay with the owner (the PI) and always carry the same gates as
read.

## 2. Data model

### The choice: one access table per record type, each with a top-level `access` alias

Directus can only evaluate `_some` when it sits directly under a **top-level** O2M alias of the collection being
filtered (or at the top of the subquery another legal `_some` opens). Everywhere else it throws `"_some" can only
be used with top level relational alias field`; migration 160's header has the details, and
`gen_access_rules.py path_filter()` already drops an illegal `_some`, which leaves a bare to-many hop that means
"any joined row" and is correct for the positive membership tests used here. So every record type needs its own
O2M alias to its access list. Options:

| Option | Fits Directus filters? | Verdict |
|---|---|---|
| One polymorphic table `record_access(collection, item_id, person_id, role)` | No: Directus relations cannot be polymorphic for an O2M alias, so there is nothing for `_some` to hang on | rejected |
| One table with five nullable FKs and a `num_nonnulls = 1` CHECK | Works (five relations, each with `one_field = 'access'`), but loses `NOT NULL` and per-parent uniqueness, needs partial unique indexes, and every permission and RLS rule has to guess which FK is set | rejected |
| **Five tables**, one per record type, each with a real FK to its parent | Yes: each parent gets a hidden alias `access` (O2M) | **chosen** |

```sql
-- sample_access, operation_access, test_access, campaign_access, project_access
CREATE TABLE sample_access (
    access_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sample_id          UUID NOT NULL REFERENCES physical_samples(sample_id) ON DELETE CASCADE,
    person_id          UUID NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    role               TEXT NOT NULL CHECK (role IN ('view', 'edit')),   -- project_access: ('view', 'investigator')
    added_by_person_id UUID REFERENCES people(person_id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sample_id, person_id)
);
CREATE INDEX sample_access_person_idx ON sample_access (person_id);
-- operation_access(operation_id → manufacturing_operations), test_access(session_id → test_sessions),
-- campaign_access(campaign_id → campaigns), project_access(project_id → projects)
```

- **Keyed by person, not by login.** The decision that a person with no login can be added forces
  `person_id → people`, and the filters read `access._some.person_id.user_id` (a to-one hop inside the legal
  `_some`), exactly like owners (`owner_person_id.user_id`). When an admin later links the login
  (`people.user_id`) the grant starts working with no further write.
- **`restricted BOOLEAN NOT NULL DEFAULT false`** on `physical_samples`, `manufacturing_operations`,
  `test_sessions`, `campaigns`, `projects`. The default keeps Directus from treating it as a required field (the T0a
  incident, 2026-10-10) and every existing row unrestricted. A partial index `WHERE restricted` on each table keeps
  "show me my restricted records" cheap.
- **Cascade on `person_id`**: only admins delete People rows (ADR-0011 decision 9), and a deleted person's grants
  should go with them. (Owner columns are `ON DELETE SET NULL`, so the owner of a deleted person's record is
  cleared; that is existing behaviour.)
- **Directus metadata** (in the same migration, following 20261007000141): `directus_collections` rows for the
  five tables (hidden), `directus_relations` rows for the five parent FKs with `one_field = 'access'` and for
  `person_id → people` with no alias, `directus_fields` rows for the five `access` aliases (hidden, `special: o2m`)
  and for the five `restricted` fields (**hidden and read-only in A1a**, section 8). `scripts/configure_*.sql`
  delete and re-insert relations and fields, so they must keep these as they keep the owner relations (ADR-0011
  "The filters walk Directus relations"); phase1 resolves every rule path after the migrations and again after the
  configure scripts.
- **Audit and OCC.** The five tables get the audit trigger of migration 121. No OCC `version` column: only the
  endpoint writes them.
- **Migration numbers.** `20261012000163_user_usage.sql` (PR #246) is on `origin/main` and live; `..164` is taken by
  `label_templates` on `feat/label-printing` and `feat/label-scan`. As of this revision the highest number on any
  branch is 164, so A1a takes the next four free numbers, **165 to 168** (schema, rules, rollup, Ask-DB row
  security). The plan re-checks with `git ls-tree -r --name-only origin/<branch> db/migrations` over every branch
  before writing a file, and the branch must merge `origin/main` before any migration is applied anywhere (dbmate
  silently skips a lower-numbered file once a higher one is recorded).

### What happens to `sample_co_owners` and `project_investigators`

These are keyed by `user_id → directus_users`, so they cannot hold a person with no login, and they are read by a
dozen consumers (`d1-access-guard`, `packages/d1-ui` `mine.ts`/`projects.ts`/`record/sampleFacts.ts`, `d1-home`
`useSampleData`/`useProjectData`/`useProjectsIndex`, `configure_directus.sql`, `migrate_legacy.py`,
`gen_people_meta.py`, `legacy_people.py`, the Data Studio forms). **A1a keeps them (decision 17)**:

- The rule sets are a **union**: a sample's editors are its owner, its `sample_co_owners` rows and its
  `sample_access` rows with role `edit`; a project's investigators are its `project_investigators` rows and its
  `project_access` rows with role `investigator`.
- The dialog lists both stores merged by person (the strongest role wins), labelling an old co-owner "Co-owner ·
  can edit" and an old investigator "Secondary investigator". It **writes only the new tables**, and on every add,
  role change, remove and transfer for a person it **deletes that person's old-table row for the record in the same
  transaction**, so the two stores can never disagree for one person. "New grant" (for the email) means the person
  had neither an access row nor an old-table row.
- Both old tables lose their remaining write paths: `sample_co_owners` update and delete move from "any editor of
  the sample" to **the sample's owner** (`link.sample.owner`; today a co-owner could `PATCH` another co-owner's
  `user_id` to an outsider or delete co-owners, which on a restricted sample leaks it), and the create guards use
  the manage rule (section 4). `project_investigators` is already PI-only. This is a deliberate change from
  ADR-0011: **co-owners can no longer add, change or remove co-owners.**
- `mine.ts` is extended so "mine" stays honest (`coOwnedByMe` also matches `access` edit rows,
  `projectsMine` also matches `project_access` investigator rows).
- Retiring both tables is a follow-up after A1b (migrate the rows into the new tables with a report of co-owners
  and investigators whose user has no People row, then drop the old path from the sets); it touches no rules because
  the sets already treat old and new alike.

## 3. Visibility rules

### Today's shapes (what changes)

`scripts/access_rules.json`, the sets that change:

```json
"sample.editors": ["owner_person_id.user_id", "co_owners._some.user_id"],
"sample.read": [ {"set": "sample.editors"}, "project_id.principal_investigator_person.user_id",
  "project_id.secondary_investigators._some.user_id",
  "campaigns._some.campaign_id.owner_person_id.user_id",
  "campaigns._some.campaign_id.project_id.principal_investigator_person.user_id",
  "campaigns._some.campaign_id.project_id.secondary_investigators._some.user_id" ],
"record.owner":  ["owner_person_id.user_id"],
"record.update": ["owner_person_id.user_id", {"via": "sample_id", "set": "sample.editors"}],
"record.read":   ["owner_person_id.user_id", {"via": "sample_id", "set": "sample.read"},
  "project_id.principal_investigator_person.user_id", "project_id.secondary_investigators._some.user_id",
  "campaign_id.owner_person_id.user_id", "campaign_id.project_id.principal_investigator_person.user_id",
  "campaign_id.project_id.secondary_investigators._some.user_id"],
"campaign.owner": ["owner_person_id.user_id"],
"campaign.read": ["owner_person_id.user_id", "project_id.principal_investigator_person.user_id",
  "project_id.secondary_investigators._some.user_id", "samples._some.sample_id.owner_person_id.user_id",
  "samples._some.sample_id.co_owners._some.user_id"],
"project.pi": ["principal_investigator_person.user_id"],
"project.read": ["principal_investigator_person.user_id", "secondary_investigators._some.user_id",
  "campaigns._some.owner_person_id.user_id", "samples._some.owner_person_id.user_id",
  "samples._some.co_owners._some.user_id", "operations._some.owner_person_id.user_id",
  "sessions._some.owner_person_id.user_id"],
"link.sample.read": [{"via": "sample_id", "set": "sample.read"}],
"link.sample.editors": [{"via": "sample_id", "set": "sample.editors"}],
"rollup.read":   [{"via": "project_id", "set": "project.investigators"}]
```
```json
"rules": {
  "physical_samples": {"create": "any", "read": "sample.read", "update": "sample.editors", "delete": "sample.owner"},
  "manufacturing_operations": {"create": "any", "read": "record.read", "update": "record.update", "delete": "record.owner"},
  "campaigns": {"create": "any", "read": "campaign.read", "update": "campaign.owner", "delete": "campaign.owner"},
  "projects": {"create": "any", "read": "project.read", "update": "project.pi", "delete": "project.pi"},
  "sample_co_owners": {"create": "any", "read": "link.sample.read", "update": "link.sample.editors", "delete": "link.sample.editors"},
  "campaign_samples": {"create": "any", "read": "campaign_samples.read", "update": "campaign_samples.write", "delete": "campaign_samples.write"}, ...
},
"guards": { "sample_co_owners": [{"field": "sample_id", "parent": "physical_samples", "key": "sample_id", "rule": "update"}],
            "project_investigators": [{"field": "project_id", "parent": "projects", "key": "project_id", "rule": "update"}], ...},
"owner_guards": { "physical_samples": {"field": "owner_person_id", "key": "sample_id", "value_key": "person_id"},
                  "manufacturing_operations": {...}, "test_sessions": {...} },
"orphan_amnesty": { "manufacturing_operations": ["owner_person_id", "project_id", "campaign_id"] },
"unfiltered": { "machining_params": ["create","read","update","delete"], ... , "directus_files": [...] }
```

and today's generated `manufacturing_operations` read filter (migration 160, 14 disjuncts, the illegal `_some`s
already dropped; `U` = `{"_eq":"$CURRENT_USER"}`):

```json
{"_or":[ {"owner_person_id":{"user_id":U}},
  {"sample_id":{"owner_person_id":{"user_id":U}}}, {"sample_id":{"co_owners":{"user_id":U}}},
  {"sample_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
  {"sample_id":{"project_id":{"secondary_investigators":{"user_id":U}}}},
  {"sample_id":{"campaigns":{"campaign_id":{"owner_person_id":{"user_id":U}}}}},
  {"sample_id":{"campaigns":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}}}},
  {"sample_id":{"campaigns":{"campaign_id":{"project_id":{"secondary_investigators":{"user_id":U}}}}}},
  {"project_id":{"principal_investigator_person":{"user_id":U}}}, {"project_id":{"secondary_investigators":{"user_id":U}}},
  {"campaign_id":{"owner_person_id":{"user_id":U}}},
  {"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
  {"campaign_id":{"project_id":{"secondary_investigators":{"user_id":U}}}},
  {"_and":[{"owner_person_id":{"_null":true}},{"project_id":{"_null":true}},{"campaign_id":{"_null":true}}]} ]}
```

### The new rule structure

Each record type has three groups of paths:

- **listed**: always sees it, restricted or not (the owner, the access-list rows, the PI of its project).
- **inherited**: sees it only while it is **not** restricted (ADR-0011's involvement paths: investigators, campaign
  owner, readers of the sample, owners of things inside a project).
- **read = listed OR (restricted = false AND inherited)**, and, for every record type except projects, **AND the
  gates** of section 1.

Gates ride on relations the record already carries: `project_id`, `campaign_id`, `sample_id`, each a **to-one**
hop, so each gate is a plain path-and-leaf filter, written once as a set and reused through `via`.

### Generator changes (`scripts/gen_access_rules.py`, `scripts/access_rules.json`)

Today a set is a flat OR of paths that each end at `user_id = $CURRENT_USER`. The new rules need AND, literal
leaves, a role test, and a way to group conditions on **one row of a to-many relation**. A set is now a small
**tree**, built first and flattened to Directus filters last (a `via` prefix is distributed onto the leaves, never
wrapped around an `_or`/`_and`, so no logical operator is nested under a relation key and the `_some` legality rule,
which is about the full path from the collection root, keeps working):

```jsonc
"set.name": [ ...items ]                      // OR of the items (as today)
"set.name": { "and": [ ...items ] }           // AND of the items
// items:
"owner_person_id.user_id"                      // user leaf (as today)
{"set": "sample.read", "via": "sample_id"}     // include a set, prefixed (as today); `via` must be a to-one hop
{"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}
                                               // user leaf plus `role _in [...]` on the junction row `at`
{"field": "restricted", "eq": false}           // literal leaf: {restricted: {_eq: false}}; the field may be a to-one chain
{"field": "sample_id", "null": true}           // {sample_id: {_null: true}}
{"unless_restricted": [ ...items ]}            // AND( restricted = false , OR(items) ), prefix-aware
{"each": "campaigns", "items": [ ...items ]}   // conditions on ONE row of a to-many alias (items are relative to the junction)
{"and": [...]}  {"or": [...]}                  // nesting
```

- `path_filter()` keeps its `_some` legality rule unchanged (index 1, or right after another legal `_some`).
  `where` becomes sibling keys of the user leaf at the junction node. **`each`** emits
  `{alias: {_some: {<AND of items>}}}` when the alias sits at the top of the collection (legal), and the bare form
  `{alias: {<AND of items>}}` when a `via` prefix has pushed it deeper (illegal `_some` dropped; the items then
  constrain one joined alias, which is the same row). Both are used only for **positive** membership tests, never
  `_none`, which is why "any joined row" is the right meaning.
- A `via` must name an **M2O** field (`resolve()` and a pytest assert it): distributing a `via` onto an `and` is only
  equivalent for to-one hops, because for a to-many hop "exists A and exists B" is not "exists A-and-B". To-many
  conditions that must hold on the same row use `each`.
- `amnesty_filter()` takes optional extra clauses: `"orphan_amnesty": {"manufacturing_operations": {"null":
  [...], "restricted_false": true, "also": "record.gates"}}`, so an ownerless FAST run under a restricted sample,
  campaign or project stays hidden.
- `owner_guards` entries grow a `fields` list (section 4) and `gen_access_rules.py` keeps its safety net: a ruled
  collection whose update filter differs from its delete filter and that has no `owner_guards` entry fails the build.
  With Can edit people, **campaigns** now trip it and get an entry (projects stay PI-only and need none).
- `resolve()` walks the new kinds: a `field`/`null` leaf must be a column of the collection it is prefixed to,
  `where` columns must exist on the junction, `at` and `each` must be aliases in `directus_fields`.
- `hook_rules()` additionally writes `core/extensions/d1-record-access/rules.json` (per record type: table names,
  the read filter and the **manage** filter, which is the delete rule), so the endpoint never restates a rule; the
  drift check (`--check`, pre-commit, phase1, pytest) covers that file too.

### New sets (`access_rules.json`)

```jsonc
// ---- gates (relative to the row that carries project_id / campaign_id / sample_id) ----
"project.listed":  ["principal_investigator_person.user_id", "secondary_investigators._some.user_id", "access._some.person_id.user_id"],
"project.pass":    [{"field": "restricted", "eq": false}, {"set": "project.listed"}],                  // P: restricted false, or on the list
"project.invs":    ["secondary_investigators._some.user_id",
                    {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["investigator"]}}],
"has.project_ok":  [{"field": "project_id", "null": true}, {"via": "project_id", "set": "project.pass"}],
"campaign.listed": ["owner_person_id.user_id", "access._some.person_id.user_id", "project_id.principal_investigator_person.user_id"],
"campaign.pass":   {"and": [{"or": [{"field": "restricted", "eq": false}, {"set": "campaign.listed"}]}, {"set": "has.project_ok"}]},   // C
"has.campaign_ok": [{"field": "campaign_id", "null": true}, {"via": "campaign_id", "set": "campaign.pass"}],
"sample.listed":   ["owner_person_id.user_id", "co_owners._some.user_id", "access._some.person_id.user_id",
                    "project_id.principal_investigator_person.user_id",
                    "campaigns._some.campaign_id.project_id.principal_investigator_person.user_id"],
"sample.pass":     [{"field": "restricted", "eq": false}, {"set": "sample.listed"}],                  // S
"record.gates":    {"and": [
    {"or": [{"field": "sample_id", "null": true}, {"via": "sample_id", "set": "sample.pass"}]},       // S
    {"or": [{"field": "sample_id", "null": true}, {"via": "sample_id", "set": "has.project_ok"}]},    // P(sample's project)
    {"set": "has.project_ok"},                                                                          // P(own project)
    {"set": "has.campaign_ok"}]},                                                                       // C(own campaign)

// ---- samples ----
"sample.inherited": [
  {"via": "project_id", "set": "project.invs"},
  {"each": "campaigns", "items": [{"and": ["campaign_id.owner_person_id.user_id", {"via": "campaign_id", "set": "has.project_ok"}]}]},
  {"each": "campaigns", "items": [{"and": [{"field": "campaign_id.restricted", "eq": false}, {"via": "campaign_id.project_id", "set": "project.invs"}]}]}],
"sample.read":    [{"set": "sample.listed"}, {"unless_restricted": [{"set": "sample.inherited"}]}],
"sample.editors": ["owner_person_id.user_id", "co_owners._some.user_id",
  {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"sample.owner":   ["owner_person_id.user_id"],
"link.sample.owner": [{"via": "sample_id", "set": "sample.owner"}],             // sample_co_owners update and delete

// ---- operations and tests ----
"record.listed": ["owner_person_id.user_id", "access._some.person_id.user_id",
  "project_id.principal_investigator_person.user_id", "campaign_id.project_id.principal_investigator_person.user_id"],
"record.inherited": [{"via": "sample_id", "set": "sample.read"},
  {"via": "project_id", "set": "project.invs"}, "campaign_id.owner_person_id.user_id",
  {"via": "campaign_id.project_id", "set": "project.invs"}],
"record.read":   {"and": [{"set": "record.gates"},
                          {"or": [{"set": "record.listed"}, {"unless_restricted": [{"set": "record.inherited"}]}]}]},
"record.editors": ["owner_person_id.user_id", {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"record.update": {"and": [{"set": "record.gates"},
                          {"or": [{"set": "record.editors"}, {"unless_restricted": [{"via": "sample_id", "set": "sample.editors"}]}]}]},
"record.delete": {"and": [{"set": "record.gates"}, {"set": "record.owner"}]},   // also the manage rule

// ---- campaigns ----
"campaign.inherited": [{"via": "project_id", "set": "project.invs"},
  "samples._some.sample_id.owner_person_id.user_id", "samples._some.sample_id.co_owners._some.user_id",
  {"path": "samples._some.sample_id.access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"campaign.read":   {"and": [{"set": "has.project_ok"}, {"or": [{"set": "campaign.listed"}, {"unless_restricted": [{"set": "campaign.inherited"}]}]}]},
"campaign.update": {"and": [{"set": "has.project_ok"}, {"or": ["owner_person_id.user_id",
  {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}]}]},
"campaign.manage": {"and": [{"set": "has.project_ok"}, "owner_person_id.user_id"]},    // delete, manage
"campaign.owner":  ["owner_person_id.user_id"],                                          // campaign_samples.write (unchanged)

// ---- projects (PI-only edit; no Can edit) ----
"project.inherited": ["campaigns._some.owner_person_id.user_id", "samples._some.owner_person_id.user_id",
  "samples._some.co_owners._some.user_id",
  {"path": "samples._some.access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}},   // new-style co-owner
  "operations._some.owner_person_id.user_id", "sessions._some.owner_person_id.user_id"],
"project.read": [{"set": "project.listed"}, {"unless_restricted": [{"set": "project.inherited"}]}],
"project.pi": ["principal_investigator_person.user_id"],
"project.investigators": ["principal_investigator_person.user_id", {"set": "project.invs"}],

// ---- children ----
"campaign_samples.read": {"and": [{"via": "sample_id", "set": "sample.pass"},
    {"or": [{"via": "campaign_id", "set": "campaign.read"}, {"via": "sample_id", "set": "sample.read"}]}]},
"rollup.read": [{"via": "project_id", "set": "project.pi"},
                {"unless_restricted": [{"via": "project_id", "set": "project.invs"}]}]   // `restricted` = the rollup row's own column
```

`rules` changes: `manufacturing_operations` and `test_sessions`: `read: record.read, update: record.update,
delete: record.delete`; `campaigns`: `update: campaign.update, delete: campaign.manage`; `projects` unchanged;
**`sample_co_owners`: `update: link.sample.owner, delete: link.sample.owner`** (create stays `any` + guard); the five
access tables as `custom` rows (read: `person_id.user_id = $CURRENT_USER`; no create, update or delete).

**Intended differences from today**, for the equivalence test: `sample_co_owners` update and delete (owner only);
and, only where something is restricted or an access row exists, everything above. With nothing restricted and no
access rows every user sees exactly today's ids.

### The operations read filter, new

`S`, `P`, `C` are the gates of section 1, `O` the operation's own rule. Written in generated form (illegal `_some`
dropped; the nested hops read as joins).

```jsonc
{"_or":[
 {"_and":[
   // S: no sample, an unrestricted sample, or on the sample's list
   {"_or":[ {"sample_id":{"_null":true}}, {"sample_id":{"restricted":{"_eq":false}}},
     {"sample_id":{"owner_person_id":{"user_id":U}}}, {"sample_id":{"co_owners":{"user_id":U}}},
     {"sample_id":{"access":{"person_id":{"user_id":U}}}},
     {"sample_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
     {"sample_id":{"campaigns":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}}}} ]},
   // P(sample's project)
   {"_or":[ {"sample_id":{"_null":true}}, {"sample_id":{"project_id":{"_null":true}}},
     {"sample_id":{"project_id":{"restricted":{"_eq":false}}}},
     {"sample_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
     {"sample_id":{"project_id":{"secondary_investigators":{"user_id":U}}}},
     {"sample_id":{"project_id":{"access":{"person_id":{"user_id":U}}}}} ]},
   // P(own project): the same leaves under "project_id"
   // C(own campaign): no campaign, or (campaign unrestricted or on its list) AND (its project is open to the caller)
   {"_or":[ {"campaign_id":{"_null":true}},
     {"_and":[ {"_or":[ {"campaign_id":{"restricted":{"_eq":false}}}, {"campaign_id":{"owner_person_id":{"user_id":U}}},
                        {"campaign_id":{"access":{"person_id":{"user_id":U}}}},
                        {"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}} ]},
               {"_or":[ {"campaign_id":{"project_id":{"_null":true}}}, /* the project leaves under campaign_id.project_id */ ]} ]} ]},
   // O: listed, or (unrestricted AND inherited)
   {"_or":[ {"owner_person_id":{"user_id":U}},
     {"access":{"_some":{"person_id":{"user_id":U}}}},                    // legal _some: top-level O2M
     {"project_id":{"principal_investigator_person":{"user_id":U}}},
     {"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
     {"_and":[ {"restricted":{"_eq":false}},
       {"_or":[ /* the sample's read rule via sample_id (its listed paths, and sample.restricted = false AND its
                   inherited paths incl. the campaign groups), project investigators (old table + access role
                   investigator), the campaign's owner, the campaign project's investigators */ ]} ]} ]} ]},
 // orphan amnesty: ownerless FAST runs stay readable unless restricted or gated
 {"_and":[ {"owner_person_id":{"_null":true}}, {"project_id":{"_null":true}}, {"campaign_id":{"_null":true}},
           {"restricted":{"_eq":false}}, <S and P(sample's project) as above> ]} ]}
```

About 55 leaves against 14 today and a deeper nesting (section 11 on the cost). Update and delete:

```jsonc
// update: gates AND ( owner OR role-edit on the operation OR (unrestricted AND the sample's editors) )
{"_and":[ <S, P, P, C>, {"_or":[ {"owner_person_id":{"user_id":U}},
   {"access":{"_some":{"person_id":{"user_id":U},"role":{"_in":["edit"]}}}},      // role test beside the user test
   {"_and":[{"restricted":{"_eq":false}},
            {"_or":[{"sample_id":{"owner_person_id":{"user_id":U}}},{"sample_id":{"co_owners":{"user_id":U}}},
                    {"sample_id":{"access":{"person_id":{"user_id":U},"role":{"_in":["edit"]}}}}]}]} ]} ]}
// delete: gates AND owner   (also the manage rule)
```

The restricted-sample case in words: an operation whose sample is restricted is hidden from everyone not on the
sample's list **even if they own the operation**, because the first gate (`S`) fails; a restricted operation under
an unrestricted sample is hidden from everyone but its owner, its access list, and the PIs.

A sample's campaign group, as generated from `sample.inherited` (the same-row form; legal `_some` at the top of
`physical_samples`):

```jsonc
{"campaigns":{"_some":{"_and":[
  {"campaign_id":{"owner_person_id":{"user_id":U}}},
  {"campaign_id":{"_or":[ {"project_id":{"_null":true}}, {"project_id":{"restricted":{"_eq":false}}},
      {"project_id":{"principal_investigator_person":{"user_id":U}}}, {"project_id":{"secondary_investigators":{"user_id":U}}},
      {"project_id":{"access":{"person_id":{"user_id":U}}}} ]}} ]}}}
```

Inside that subquery Directus applies `campaign_samples`' own read rule (migration 160 header), which is built only
from `via` paths (no `_some` of its own), so it adds no new illegal `_some`.

### Everything attached follows its record

- **Children already ruled** (`sample_stock_provenance`, `sample_data_files`, `operation_data_files`,
  `machining_force_analysis`, `fast_run_data`, `session_data_files`, `*_additional_operators`,
  `test_sessions_subject`, `project_investigators`, and the reads of `sample_co_owners`) follow their parent through
  the sets above with no change to their entries; the parents' new gating flows through `via`.
- **Params tables, were unfiltered for Lab Member** (`machining_params`, `sintering_params`,
  `heat_treatment_params`, `deformation_params`, `am_params` have `operation_id`; `tensile_test_params`,
  `hardness_test_params`, `charpy_test_params`, `compression_test_params`, `sem_params`, `xrd_params` have
  `session_id`, all UNIQUE). They move from `unfiltered` to `rules`, create `any`, read/update/delete the existing
  `operation.read`/`operation.update` and `session.read`/`session.update` sets. They need `directus_relations`
  rows for `operation_id` and `session_id` for the paths to resolve; check before writing the rules (`--resolve`).
- **`campaign_samples` read** as above: a campaign reader no longer sees the junction row (and the id) of a
  restricted sample.
- **`project_rollup`** gets a `restricted` column, filled by the refresh: an `operation` row is restricted when the
  operation, its sample or its campaign is; a `sample` row when the sample is; the tool, edge, insert, material and
  equipment rows are derived from operations and are restricted only when **every** operation behind them is.
  `rollup.read`: the PI sees every row, investigators only `restricted = false` rows. The refresh triggers fire on
  operations and campaigns; a trigger on `physical_samples` (the `restricted` column) is added. A PI of project P
  still sees the rollup row of an operation of P that is hidden from them by another project's restricted sample
  (section 11, to confirm).
- **Access tables** (`sample_access` and the four others): Lab Member **reads only rows about themselves**
  (`person_id.user_id = $CURRENT_USER`), no create, update or delete. This is what the legal `_some` subquery needs
  (Directus applies the related collection's own rule inside it, so the rule must not itself recurse into the
  parent's read rule). The dialog's full list is served by the endpoint (section 5); every write goes through it.

### Index counts and the Explorer

All Explorer lists, counts (`meta=filter_count`, aggregates), stat tiles and project cards read through `/items` as
the signed-in user, so they narrow without a code change. When an owner restricts a sample, the owner's numbers are
unchanged and everyone else's drop by one (and by its operations and tests); restricting a project drops
everything under it for everyone not on its list. Totals on different pages are per viewer, as under ADR-0011.

## 4. `d1-access-guard`

Directus does not filter create, and the filters above only decide who can *update*; the hook enforces who may
change the access-granting fields. Changes:

1. **Owner-only fields.** `owner_guards[collection]` becomes `{ "key": ..., "fields": [ {"field": "owner_person_id",
   "value_key": "person_id"}, {"field": "restricted"} ], "filter": <delete rule> }` in `rules.json`
   (`ownerGuards`). An `items.update` whose payload names **any** of the fields, with a value that differs from the
   stored one, must pass the record's **delete** rule (owner, with the gates), else 403 `FORBIDDEN` with
   `extensions.kind = 'owner'` or `'restricted'`. Entries: samples, operations, tests, campaigns. Projects need
   none (only the PI can update one at all). The unchanged-value rule and the batch-per-key check stay.
2. **Restricted-sensitive keys.** Moving a record changes who sees it, which is managing access by another name.
   On an `items.update` that changes `project_id` (samples, operations, tests, campaigns), `campaign_id`
   (operations, tests) or `sample_id` (operations, tests), when **the record, its current sample, or the old or new
   project, campaign or sample is restricted** (read straight from the database, in the request's transaction), the
   caller must pass the record's **delete** rule (the owner). Otherwise an editor could lift a restricted sample into
   a project whose PI then sees it, or move an operation out of a restricted sample's gate. The same applies to
   junction rows that move a record: `campaign_samples` create or repoint requires the sample's **delete** rule
   when that sample is restricted (the campaign side keeps the campaign's update rule), and `test_sessions_subject`
   create or repoint requires the test's **delete** rule when the test or its current sample is restricted (the
   migration-139 trigger derives `test_sessions.sample_id` from the lowest subject row). Config:
   `"restricted_keys": {"physical_samples": ["project_id"], "manufacturing_operations": ["project_id","campaign_id","sample_id"], ...}`
   in `access_rules.json`, emitted into `rules.json`.
3. **Junction guards use the manage rule.** `guards.sample_co_owners` and `guards.project_investigators` get
   `"rule": "delete"` (the generator already looks the parent's filter up by `rule`). Messages: "Only the sample's
   owner can add co-owners." and "Only the project's principal investigator can add investigators."
   `sample_co_owners` update and delete are now owner-only in the rule itself (section 3), so the guard only has to
   close create.
4. **Access tables need no guard**: Lab Member has no write grant on them; the endpoint is the only writer and
   checks the manage rule itself.
5. **Ownership transfer.** A direct `PATCH owner_person_id` by the owner keeps working (Data Studio); the dialog
   uses the endpoint, which additionally keeps the previous owner and removes the new owner from the list. Admins and
   internal calls bypass the hook, as today.
6. A create may still set `restricted = true` on a record the creator will own. Creating an operation or test
   **under a restricted sample the creator cannot read** is not refused in A1a (known gap): the record is created and
   the creator cannot read it back, and the Force App then reports that the server did not return the new operation
   id, which is the existing "recording on a sample you cannot read is not possible" behaviour.

## 5. The record-access endpoint and the email

A new Directus endpoint extension **`core/extensions/d1-record-access`** (plain ESM, `node:test`, mounted at
`/d1-record-access`). It is the only writer of the five access tables. Every route needs a user (401 otherwise),
accepts a fixed set of collections (`physical_samples`, `manufacturing_operations`, `test_sessions`, `campaigns`,
`projects`; anything else 400) and a uuid `:id`.

| Route | Needs | Does |
|---|---|---|
| `GET /:collection/:id` | the caller can **read** the record (through `ItemsService` with the caller's accountability, so the real rule decides; unreadable is 404) | `{ restricted, owner, project_pi, can_manage, entries: [{ person_id, name, role, label, source, can_sign_in, added_by, added_at, blocked_by }] }`: owner, the access table, plus the old co-owner or investigator rows (`source: 'co_owner'\|'investigator'`), merged by person to the strongest role |
| `POST /:collection/:id/entries` `{person_id, role}` | **manage** | upserts the access row, deletes the person's old-table row; a new grant sends the email; the person must be active; adding the owner is refused; roles per collection (`investigator` only on projects) |
| `PATCH /:collection/:id/entries/:person_id` `{role}` | manage | changes the role (old-table entry converted in the same transaction) |
| `DELETE /:collection/:id/entries/:person_id` | manage | deletes the access row and any old row for that person |
| `POST /:collection/:id/transfer` `{person_id}` | manage | sets the owner column (`principal_investigator_person` for projects), keeps the previous owner (Can edit; Secondary investigator on a project), drops the new owner's rows, emails the new owner |

- **can_manage** = the caller is an admin, or the **manage filter** (the record's delete rule from `rules.json`)
  matches the record when run through `ItemsService.readByQuery` as the caller with `$CURRENT_USER` substituted. The
  check runs in the same request as the write, which then uses the system accountability, so Lab Member needs no
  write grant. A record with no owner is manageable by admins only.
- **Audit.** The writes run in one knex transaction that first does `SELECT set_config('d1.actor_identity',
  <user id>, true)`, so the audit trigger (migration 128) names the caller (system accountability would otherwise
  leave it empty); `added_by_person_id` is set from the caller's People row.
- **`blocked_by`** per entry names the restricted parent (sample, campaign, project) that does not list that person
  (a small SQL check against those parents' flags and lists), which drives the dialog's "will not take effect" line.
- **Mail recipient.** The address is `directus_users.email` when the person has a login (an admin-controlled
  address), and `people.email` only for a login-less person. (Lab Member can edit `people.email` on any People row, so
  mailing it for a person with a login would let any member redirect another's notifications; tightening
  `people.update` to "email only on your own row" is a separate ADR-0011 follow-up.)
- **Mail.** After the write commits, `new MailService({ schema, knex })` (`services.MailService`), then
  `mail.send({ to, subject, html, text })`, with the body built here from plain strings, every interpolated value
  HTML-escaped (no Liquid template to mount): adder's name, role label, record kind and code, and the link
  `PUBLIC_URL + '/admin/home/<kind>/<id>'`. The endpoint cannot import the kit's `recordRoute`, so it keeps a
  five-entry map and a kit test pins that map against `recordRoute`. **The send is wrapped in `try/catch` and in a
  10-second timeout** (nodemailer's defaults are minutes when the host is unreachable): any failure (no `EMAIL_*`,
  SMTP refusal, timeout, no address) returns `email: 'failed' | 'skipped'` and logs a warning; the write is never
  rolled back. No mail to the adder. **The exact `MailService.send` option shape and base-template wrapping must be
  checked against the Directus 11.17 source in the running image before coding**; if `html` is not accepted without
  a template, ship one `.liquid` file in the extension folder and pass `template`.
- **Why an endpoint, not an `items.create` hook on the access tables:** the endpoint already knows the adder, the
  role and the record, and a hook would also email for bulk or scripted inserts.
- One email per new grant; a person is on a record at most once (unique key), so re-adding is a role change with no
  email.

## 6. The dialog UI

- **Kit** (`packages/d1-ui`, no SDK imports; `noSdkImports.test.ts`): `access/accessApi.ts` (typed calls against the
  endpoint and `/items/people`), `access/accessModel.ts` (pure: role labels per collection, entry ordering,
  `canChangeRole`, people-search query, "can't sign in yet" marking, merge of old and new entries, the no-owner and
  blocked texts) and `components/AccessDialog.vue` (modal, kit tokens, keyboard and aria like `EditDrawer`).
  `ExplorerHost.api` today offers only `get`: it gains `post`, `patch` and `delete`, and `explorerHost.ts` already
  passes the SDK's `useApi()` axios instance, which has them.
- **Host pages** (`core/extensions/d1-home/src/pages/*Page.vue`): one `<v-button small secondary @click="access = true">
  <v-icon name="group" small left />Who has access</v-button>` in each `RecordRail` `#actions`, and
  `<AccessDialog v-model="access" :collection :id :title />` beside `EditDrawer`. The button is shown to everyone who
  can read the page; `can_manage` comes from the GET.
- **Restrict switch**: behind a prop `restrictEnabled` fed from one constant (`RESTRICT_UI = false`, one line to flip
  in A1b; a test pins it). In A1a the Data Studio `restricted` field is `hidden` and `readonly` in
  `directus_fields`, so nothing in any UI turns it on.
- **Hidden counts** (decision 15): `CampaignProgress` and `SamplesPanel` print "Some samples in this campaign are
  hidden from you" instead of "N samples not visible to you"; the sample page's hidden-genealogy marker and the
  d1-trace flags do the same (section 8). `hiddenSampleCount` stays as a boolean helper.
- **Pending states**: loading line, an inline error line (the endpoint's `message`), disabled controls while a write
  runs; the list is refetched after every change.

## 7. Paths that bypass Directus

Already enforced through the user's own permissions: the **Force App** reads with the user's Bearer token, and so
do **filter-service** and **diag-service**; **d1-trace** and **d1-report** read through `ItemsService` with the
caller's accountability (d1-report then reads root `v_*` views only for ids it has shown readable); the Explorer and
dashboard extensions (`d1-campaign-ops`, `d1-fast-dashboard`, `d1-force-dashboard`, `d1-lab-dashboard`,
`d1-project-items`, ...) read as the user (checked: no root reads; `d1-admin-overview` is admin-only).

| Path | Today | Under A1 |
|---|---|---|
| `directus_files` / `/assets` (Lab Member: unfiltered create, read, update, delete) | any member reads any file | **A1b**: read only when the caller uploaded it (`uploaded_by`) or it is attached to a record they can read (`operation_data_files`, `session_data_files`, `sample_data_files`, `machining_force_analysis.directus_files_id` and `.live_cache_file` as hidden O2M aliases on `directus_files`). A1a: unchanged, listed as a known gap |
| **Octrees** (Caddy `handle_path /octrees/*`, `root * /srv/octrees`; `force_orchestrator.py` `OCTREE_DIR/<op>/`, `OCTREE_DIR/diag/<op>/`, `OCTREE_DIR/grid/<op>/`; no auth, ACAO `*`) | anyone who reaches the tailnet host can stream any operation's point cloud | **A1b**: Caddy `forward_auth` to a small Directus endpoint (below) |
| **Process and test params** (11 tables, unfiltered for Lab Member, each UNIQUE `operation_id`/`session_id`) | a member can read or edit any operation's params | **A1a**: follow their operation/test (section 3) |
| **llm-text-to-sql** (`d1_llm_app`, member of `d1_llm_readonly`, SELECT allow-list of migration 20261003000132, no per-user check) | reads every row of every granted table | **A1a**: Postgres row-level security scoped to that role (below) |
| **project_rollup** | readable by the PI and investigators, so it would list restricted records to secondary investigators | **A1a**: `restricted` column and the restriction-aware rule |
| **d1-trace** | returns "N hidden" counts | **A1a**: booleans, UI says "some records hidden" |
| `campaign_samples`, `sample_genealogy` rows | the row reveals the other sample's id | `campaign_samples` read now needs the sample gate; a genealogy edge to a restricted relative still shows the id and the existence of the edge to a reader of the other end (d1-trace shows the marker, not the sample). Accepted (known gap) |
| Machine users (Operator, Researcher, Administrator in `core/roles.json`) | crawler, workers, equipment | live has only Administrator, Lab Admin and Lab Member; machine tokens are Administrator users. The legacy role files are deleted in A1a once nothing is found to read them (plan Task 5) |

### Ask-the-database (A1a): row-level security for one role

ADR-0011 rejected Postgres RLS because it depended on a per-request setting through a pooled connection. Here the
policy is keyed on **the role**, not the user: `d1_llm_readonly` (and its member `d1_llm_app`) must never see a
restricted record, whoever is asking. Directus connects as the table owner (`d1`), which bypasses RLS unless
`FORCE ROW LEVEL SECURITY` is set (it is not), so Directus and the migrations are unaffected.

- Per table: `ENABLE ROW LEVEL SECURITY`, a **permissive** policy `FOR ALL TO PUBLIC USING (true) WITH CHECK (true)`
  and a **restrictive** policy `AS RESTRICTIVE FOR SELECT TO d1_llm_readonly USING (...)`. The permissive policy must
  cover every command, not just SELECT: other non-owner roles exist that are created by hand and appear only in
  runbooks and `.env`, notably **`d1_embedder`** (`docs/runbooks/text-to-sql.md`, `.env.example`:
  `GRANT SELECT, INSERT, UPDATE ON semantic_embeddings`; the embedding backfill connects as it). With RLS enabled and
  a SELECT-only permissive policy its INSERT and UPDATE would be refused and the backfill would stop on live.
- **Conservative role-level expressions** (the role has no user, so it hides anything restricted or under a
  restricted ancestor): `physical_samples`: `NOT restricted AND (project_id IS NULL OR project_id IN (SELECT
  project_id FROM projects)) AND NOT EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id =
  physical_samples.sample_id AND cs.campaign_id NOT IN (SELECT campaign_id FROM campaigns))`; `manufacturing_operations`
  and `test_sessions`: `NOT restricted` AND each of sample, project, campaign is NULL or `IN (SELECT ... FROM <parent>)`
  (the subquery is itself subject to the role's policy); `campaigns`: `NOT restricted` AND project NULL or visible;
  `projects`: `NOT restricted`.
- **Complete table list** (every table migration 20261003000132 grants the role). **Record-bound**, each with a
  policy that checks its parent(s) under the parents' own policies: `physical_samples`, `manufacturing_operations`,
  `test_sessions`, `campaigns`, `projects` (above); `campaign_samples` (both ends), `sample_genealogy` (both
  ends), `sample_stock_provenance`, `sample_co_owners`, `sample_data_files` (`sample_id`); `operation_data_files`,
  `operation_files`, `prep_steps`, `machining_force_analysis`, `fast_run_data` (`operation_id`); `diag_layer`
  (`analysis_id` -> `machining_force_analysis`); `session_data_files`, `test_sessions_subject` (`session_id` /
  `test_sessions_id`); `project_investigators` (`project_id`); `project_rollup` (`NOT restricted` **and** the project
  visible); `semantic_embeddings` (`CASE source_table WHEN 'physical_samples' THEN source_id IN (SELECT sample_id
  FROM physical_samples) WHEN 'manufacturing_operations' ... ELSE false END`, unknown source tables denied).
  **Reference** (no policy, named in the test): `alloying_elements`, `cutting_inserts`, `diag_recipes`,
  `equipment`, `etchants`, `facilities`, `fast_recipes`, `filter_profiles`, `insert_edges`, `insert_types`,
  `manufacturers`, `manufacturing_methods`, `material_alloying_elements`, `material_iso_classifications`,
  `materials`, `prep_recipe_steps`, `prep_recipes`, `raw_stock_lots`, `tool_boxes`, `tool_setup`, `tools`.
  The params tables are not granted to the role today; a later grant must add a policy, which the completeness
  assertion below enforces. **phase1 asserts that every table granted to `d1_llm_readonly` either has RLS enabled
  or is in the reference list**, so a new grant without a policy fails CI.
- **Views.** The `v_*` views granted to the role run as their owner and would bypass the policies, so all nine are
  `ALTER VIEW ... SET (security_invoker = true)` (Postgres 16). Checked: they read only tables the role already has
  SELECT on. **`CREATE OR REPLACE VIEW` without a `WITH (...)` clause resets that option**, so a later migration that
  redefines one silently turns the bypass back on: phase1 asserts that every view granted to the role has
  `security_invoker=true` in `pg_class.reloptions`, and CONTRIBUTING and the `db-migration` skill say "recreate an
  LLM-granted view `WITH (security_invoker = true)`". The `f_trace_*` functions (EXECUTE kept by migration 132) are
  not SECURITY DEFINER and run as invoker, so they are covered.
- The Ask-DB UI stays as is; a restricted sample's absence reads to the model as "no such row".

### Octrees behind a login (A1b design)

`handle_path /octrees/*` gains `forward_auth directus:8055 { uri /d1-record-access/octree-auth }` ahead of
`file_server`, with the preflight (`OPTIONS`) still answered by Caddy before the auth step and `Authorization` added
to `Access-Control-Allow-Headers` (the CORS `*` wildcard does not cover it). Caddy sends the original headers, so
Directus authenticates the call from the `Authorization: Bearer` header (the Force App) or the session cookie (the
Directus-hosted force dashboard; `copy_headers Cookie`). The endpoint parses the path (`/octrees/<op>/...`,
`/octrees/diag/<op>/...`, `/octrees/grid/<op>/...`) and answers 200 when the caller can read that operation through
`ItemsService` (its read rule, which includes the gates), 403 when not, 401 without a login, 404 for a path that
names no operation. The answer is cached 60 s per (user, operation) in process memory. The Force App sends its
Bearer token on octree and diag fetches: diag already uses `host.authHeaders()` through `authorizedFetch` in
`packages/force-plotting/src/host.ts`; the octree loader (Potree) needs the same header on its range requests
(`octreeUrl` in `apps/force-app/web/src/config.ts`).

### What A1b also touches in the Force App

`apps/force-app/web/src/record/workspace.ts` `logRunSync()` POSTs `manufacturing_operations` as the signed-in user
(the creator becomes the owner) and `uploadCapture.ts` uploads the files with `POST /files`, then
`machining_force_analysis`. A1b adds a **Restricted** option to the record and upload dialogs: it sends
`restricted: true` in the operation payload (create is not guarded, the creator is the owner), shows a lock badge and
"Restricted" state on the operation, and words the "could not read back the operation" failure as "you cannot see
this sample" rather than the current text.

## 8. d1-trace, project rollup and the Data Studio

- **d1-trace** (`core/extensions/d1-trace/index.js`): the response's `hidden` object (`stock_origins`, `ancestors`,
  `events`, `descendants`) turns from counts into booleans; `packages/d1-ui/src/life.ts` `hiddenMarker()` and
  `LifeStrip` print "some records hidden" with no number; `truncated` is unchanged. The campaign UI's "N samples not
  visible" texts change the same way (decision 15).
- **Data Studio**: the five `restricted` fields are hidden and read-only in A1a; the five access tables are hidden
  collections. The Data Studio never lists or edits access.

## 9. Phasing

| | Scope |
|---|---|
| **A1a** (plan: `2026-10-12-a1a-record-access.md`) | migration 165 (columns, five access tables, Directus metadata); generator and `access_rules.json`, migration 166 (the Lab Member permission rows), migration 167 (`project_rollup.restricted` and trigger); `d1-access-guard` changes; `d1-record-access` endpoint and email; dialog and button (switch off); `mine.ts` extensions; campaign and d1-trace hidden texts; migration 168 (Ask-DB row security, `security_invoker` views); delete `core/roles.json` and `core/permissions.json` and what reads them; ADR, wiki, cutover runbook |
| **A1b** | `directus_files` rule and its aliases; octree auth endpoint and Caddy change, Force App Bearer on octree/diag fetches; Force App lock badge and Restricted option; `RESTRICT_UI = true` and un-hide the `restricted` field; the guard's remaining A1a gap (creating under a restricted sample) |
| **A2** (follow-up, decision 17) | retire `sample_co_owners` and `project_investigators`: migrate into the new tables with the "no People row" report, then drop the old path from the sets and the consumers |

A1a leaves a window in which the database enforces restriction but files and octrees still leak (a restricted
operation's `.mat` or point cloud is reachable by whoever has its id). That is why no UI can turn it on until A1b:
an owner could still set it through the API, and the release notes say so.

## 10. Testing

Fixture people (all with logins unless noted): `owner`, `coowner` (old `sample_co_owners` row), `viewer`
(`*_access` view), `editor` (`*_access` edit), `inv` (old `project_investigators` row), `inv2` (`project_access`
investigator), `pi`, `campaignOwner`, `stranger`, `nologin` (a People row with no `user_id`), `admin`. Records:
project P (PI `pi`) with campaign C (owner `campaignOwner`), sample S in C and P, a second sample S2 in C and also in
an open campaign C2 of an open project Q, operation O and test T on S, an orphan FAST operation, in every
combination of restricted/unrestricted for S, O, T, C, P.

- **`bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=4, the number of new migrations)** and
  **`tests/phase1_schema.sh`**: the five tables and columns exist; `restricted` defaults false and is NOT NULL;
  unique and check constraints (`project_access` accepts `investigator`, the others refuse it); the Lab Member rows
  equal the generator's output (existing assertion) and have no grant on `*_access` beyond read of own rows; the
  params tables are ruled; every new rule path resolves against the metadata after the migrations and after running
  `configure_all.sh`'s scripts (`--resolve`); the five `access` aliases and `restricted` fields keep their rows after
  the configure scripts; each migration applies, reapplies and reverses to exactly the rows it started from; **RLS:**
  a `SET ROLE d1_llm_readonly` session sees none of a restricted tree (samples, operations, tests, params-adjacent
  tables, file rows, `v_*` views) or of a tree under a restricted project or campaign, while the owner role sees all;
  **a role with `d1_embedder`'s grants can still INSERT and UPDATE `semantic_embeddings` after migration 168**;
  **every granted table has RLS or is in the reference list**; **every granted view has
  `security_invoker=true`**.
- **`python3 scripts/gen_access_rules.py --check`** (pre-commit, CI) and **`tests/scripts/test_access_rules.py`**:
  tree flattening; `unless_restricted` with and without `via`; `where` placement for legal and dropped `_some`;
  `each` in its legal and dropped forms; `and` sets under `via` (distribution) and that every `via` is an M2O;
  the amnesty clause; `owner_guards` fields; the update-wider-than-delete net for campaigns;
  `resolve()` for the new kinds; and invariants: restricted never widens (every update/delete filter implies its
  read filter, evaluated on the fixture), a restricted sample/campaign/project gates every ruled child as
  specified, a legacy co-owner and an access-edit person see exactly the same ids everywhere, and with nothing
  restricted and no access rows every user sees exactly today's ids (intended difference: `sample_co_owners`
  update/delete owner-only). **The fixture evaluator models Directus, not SQL intuition:** it applies the related
  collection's own read rule inside a legal `_some` and treats a dropped `_some` as an any-row join.
- **Node tests** (`node --test core/extensions/*/index.test.mjs`): `d1-access-guard` (owner-only fields; `restricted`
  by owner, co-owner, Can edit person, admin; unchanged value passes; batch per key; campaigns guarded; **a
  co-owner's `PATCH user_id` and `DELETE` on a `sample_co_owners` row are 403**; the junction guards on the manage
  rule; **restricted-sensitive keys: an editor changing `project_id`/`campaign_id`/`sample_id` of a restricted record,
  or out of or into a restricted parent, is 403, the owner passes; the `campaign_samples` and
  `test_sessions_subject` cases**); `d1-record-access` (401; collection whitelist; 404 on unreadable; manage matrix per
  role; add sends one mail, role change none, self-add none, no address skips, a legacy co-owner re-added sends none;
  the recipient is the login email when there is a login and the People email otherwise; a throwing or hanging
  `MailService` still returns the change; transfer keeps the previous owner and emails the new one with its own
  subject; old-table entries merged to the strongest role and deleted in the same transaction; `blocked_by`;
  `set_config` called; two-user isolation); the link map pinned against the kit's `recordRoute`; `d1-trace` booleans.
- **d1-ui vitest**: `accessModel` (labels incl. the project roles, ordering, merge, can't-sign-in, search query,
  no-owner text), `life.ts` with boolean markers, the campaign "some hidden" texts, `mine.ts` with access rows,
  `RESTRICT_UI` pinned, `noSdkImports`; and a d1-home type check and build.
- **Directus smoke** (`D1_SMOKE_REQUIRE_LM=1 D1_SMOKE_OVERLAYS="d1-access-guard d1-record-access d1-trace" bash
  scripts/dev/directus_smoke.sh`, a read-only dump of live, never live itself). The harness mounts the **main
  checkout's** extensions and overlays only `d1-next-number`, so without the overlay list the worktree's guard,
  endpoint and trace would not be under test. New `lm_*` cases for the fixture matrix, each compared with a plain-SQL
  evaluation of the same rules (as migration 160 was): every ruled collection answers 200 (the `_some` constraint),
  list, `filter_count` and paging agree and return **no duplicate rows** with an access list of several people and
  samples in several campaigns, the role test inside `_some` works (viewer cannot update, editor can), an operation
  under a restricted sample is invisible to its own owner, a restricted project hides its campaigns, samples (except
  to owners and lists), operations and tests from a stranger and not from the PI, params follow their operation,
  a co-owner's `PATCH`/`DELETE` of a `sample_co_owners` row is 403, an editor's `PATCH project_id` of a restricted
  sample is 403, and the mail path returns without error with mail unconfigured.
- **Performance** (section 11) runs on the same copy after seeding.
- **Physical backlog** (`docs/runbooks/physical-test-backlog.md`): two real users, add and remove, transfer, email
  arrives with a working link, restrict (API only in A1a), project page and Home counts.

## 11. Risks, decisions, known gaps

**Filter size and performance (the main risk).** The operations read filter grows from 14 to about 55 leaves with a
nested `_and` of `_or`s, and every illegal `_some` becomes a join: `sample_id.co_owners`, `sample_id.access`,
`sample_id.campaigns...`, `sample_id.project_id.access`, `project_id.access`, `campaign_id.project_id.access`, the old
investigator tables at each of those levels. Joins multiply rows before Directus de-duplicates, and the operations
list (10k+ FAST runs) runs the filter twice (rows and `filter_count`). Legal `_some` subqueries also embed the
related collection's own rule, so `projects.read` carries the operations, tests, samples and campaigns rules inside
its EXISTS clauses. **Gate (plan Task 2):**
- Seed the test copy first (live has no access rows and nothing restricted, so an unseeded copy shows almost no
  fan-out): 3 to 5 access rows on a realistic share of samples, campaigns and projects, restricted samples with
  operations and tests, a restricted campaign and a restricted project with contents, and a sample in several
  campaigns of large projects (`scripts/dev/seed_access_fixture.sql`, copy only).
- Time, **as a stranger (scans everything, returns nothing) and as a member** (co-owner of a few samples and an
  investigator), before (main) and after: the operations, projects and campaigns index queries with
  `filter_count`, the Home counts, and a sample page's children lists. **Absolute limit: p95 under 300 ms per list
  request on the preview copy**, and no more than 2x today's median.
- If it fails: **run `EXPLAIN (ANALYZE, BUFFERS)` first** on the slowest request and look at the dominant join and
  the indexes (`*_access(person_id)` exist; check `project_investigators(project_id)`, `campaign_samples(sample_id)`
  and `(campaign_id)`, `co_owners(sample_id)`), fix with indexes, then take the **fallback: per-record gate tables**
  (designed here, built only if needed): each of operations and tests gets `gated BOOLEAN` and a hidden `gate`
  alias to `operation_gate(operation_id, person_id)` (and `test_gate`; samples and campaigns likewise), maintained by
  one SQL function from triggers on the `restricted` columns, the access tables, owner, `project_id`, `campaign_id`,
  `sample_id` and `campaign_samples`, holding rows only for records that sit under some restriction (rare). The gates
  then collapse to `gated = false OR gate._some.person_id.user_id = $CURRENT_USER` (two leaves, one legal `_some`).
  The cost is a second implementation of the gate logic in SQL, kept honest by running the pytest fixture evaluator
  against it. A trigger-maintained `sample_restricted` copy alone would **not** help, because Directus emits every
  join regardless of OR short-circuiting.
- Index counts narrow silently per viewer (section 3).

**Directus behaviours to prove, not assume** (each has a smoke case): a role condition beside the user condition
inside a legal `_some`; `_and` of `_or`s at the top of a rule under `getCases`; the dropped-`_some` join semantics
with an access list of several rows and samples in several campaigns (duplicates, counts, same-row grouping inside
`each`); the legal `access._some` subquery applying the access table's own "rows about me" rule; the mail service
shape.

**Not expressible in Directus filters** (sections 1 and 3): gating an operation or test by the *campaign memberships
of its sample* (needs a universal condition over a to-many behind a to-one hop; `_none` is legal only at the top of
the collection and applies the junction's own read rule). Nearest rule, adopted: gate by the operation's own project
and campaign and by its sample's `restricted` flag and own `project_id`.

**Known gaps (accepted, to list in the ADR).**
- A multi-sample test is matched through its derived primary `sample_id`; a restricted *secondary* sample does not
  hide it (existing ADR-0011 limit), and the readable test's `test_sessions_subject` rows name that sample's id.
- Creating an operation or test under a restricted sample the creator cannot read is not refused (section 4).
- A genealogy edge to a restricted relative shows the relative's id to a reader of the other end.
- The `directus_files` and octree leaks between A1a and A1b (section 9).
- Old-table entries (`sample_co_owners`, `project_investigators`) are always people with a login; the new tables
  carry the login-less ones.
- A PI of project P still sees the rollup row of an operation of P that a restricted sample of another project hides
  from them (below).

**Decided** (maintainer, 2026-10-12):
1. Restricting a **campaign or project cascades** (decision 13); the filters are in section 3, with the one
   inexpressible case above.
2. A **transfer emails the new owner**, with its own subject (decision 14).
3. The campaign UI's **"N samples not visible"** becomes "some hidden" in A1a (decision 15).
4. **Projects offer Can view and Secondary investigator only** (decision 16); a transfer keeps the previous PI as
   Secondary investigator.
5. The **old tables are retired later**, as a follow-up after A1b (decision 17, A2).

**To confirm (the design picked a default).**
1. *Strict gates for operations and tests.* Under a restricted project or campaign the operation's own owner, if not
   on the list, cannot see their operation (the same rule decision 7 sets for a restricted sample). Samples keep an
   owner exception, as the ruling states; operations, tests and campaigns do not.
2. *PI versus the sample gate, cross-project.* An operation in project P on a restricted sample of project Q is
   hidden from P's PI (decision 7 wins over "the PI sees everything"), while the rollup row stays visible to P's PI.
   Alternative: let the PI of the operation's project pass the sample gate.
3. *Tightening `people.update`* so a member edits `email` only on their own row (a separate ADR-0011 follow-up; the
   mail recipient rule above already avoids the redirect for people with a login).

## 12. Files this touches (A1a)

`db/migrations/<next four free numbers, 165 to 168 at the time of writing>`: record access, Lab Member rules,
project rollup, LLM role row security; `scripts/access_rules.json`, `scripts/gen_access_rules.py`,
`scripts/configure_users_and_policies.sql` (generated block), `scripts/configure_directus.sql` (keep relations and
fields); `core/extensions/d1-access-guard/{index.js,rules.json,index.test.mjs}`; new
`core/extensions/d1-record-access/`; `core/extensions/d1-trace/index.js`;
`packages/d1-ui/src/{host.ts,life.ts,mine.ts,index.ts,access/*,components/AccessDialog.vue,campaign/*}`;
`core/extensions/d1-home/src/pages/{Sample,Operation,Test,Campaign,Project}Page.vue`;
`tests/phase1_schema.sh`, `tests/scripts/test_access_rules.py`, `scripts/dev/directus_smoke.sh` (overlays),
`scripts/dev/directus_smoke.mjs`, `scripts/dev/seed_access_fixture.sql`; delete `core/roles.json`,
`core/permissions.json` and rewrite or delete `core/apply.sh`, `core/README.md`, with the docs and `.env.example`
references listed in plan Task 5; `.pre-commit-config.yaml`; `docs/adr/` (a new ADR amending 0011),
`docs/wiki/database/roles-and-permissions.md`, `docs/data-dictionary.md`, `CONTRIBUTING.md` and
`.claude/skills/db-migration/SKILL.md` (the `security_invoker` rule), `docs/runbooks/a1-record-access-cutover.md`.
