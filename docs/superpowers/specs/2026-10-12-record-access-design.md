# A1: Record access ("Who has access", Restricted records)

Status: **design for review.** The maintainer's decisions of 2026-10-12 are binding and listed first; everything else
is the proposed design and the places where it needs a ruling are collected in "Open questions". Builds on
[ADR-0011](../../adr/0011-row-level-visibility.md) (row-level visibility) and amends it; it does not replace it.
Implementation plan for the first phase: `docs/superpowers/plans/2026-10-12-a1a-record-access.md`.

Why: ADR-0011 made every record readable by exactly the people involved in it, by inheritance only. Nobody can
share a single sample with a colleague without making them a co-owner of it, and nobody can keep a sensitive
sample or test private from the PI or the rest of the project. A1 adds a Google-Drive-style "Who has access"
dialog (add and remove people, transfer ownership) and a per-record **Restricted** switch, and closes the
places where the data can be read around Directus's permissions.

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
  get the search box, the role selectors, remove buttons and Transfer. For everyone else the controls are not
  drawn and the dialog says "Only <owner name> can change who has access."
- **Add.** Typing searches active People by name (the same `/items/people` search the People page uses). Pick a
  person, pick a role (default Can view), Add. A person with no login shows "can't sign in yet": they are added
  and the grant starts working the day an admin links their login to the People row.
- **Roles.** Can view / Can edit on every record. On a **sample** a Can edit person is a *co-owner* (it is the
  same thing; the label shows "Co-owner · can edit"). On a **project** a third role, **Secondary investigator**,
  means what it means today: read access to everything in the project (the project form's
  `investigator_access_notice`). Existing co-owners and investigators from the old tables appear in the list with
  those labels (section 2).
- **Transfer ownership.** Choose a person, read the confirm text ("<name> becomes the owner. You stay on the
  record as Can edit. Only the new owner can change who has access."), Confirm. The previous owner is kept as Can
  edit so a transfer never makes the record disappear for the person who made it; they can be removed afterwards.
  The new owner is removed from the access list (they are the owner now).
- **The Restrict switch** (a toggle at the top of the dialog, "Restricted: only the people below can see this")
  exists in the component behind a flag that is off in A1a and on in A1b. Nothing in A1a draws it, and the Data
  Studio form field is hidden and read-only (section 8).
- **Email.** The person added gets a short email: who added them, their role, the record's name and code, and a
  button linking to the Explorer record page (`PUBLIC_URL` + `/admin/home/samples/<id>` and so on). Sent only on a
  new grant (not when a role changes, not when you add yourself, not when the person has no email). If the mail
  server refuses it, the change stands and the dialog says "Added. The email could not be sent."

### What a Restricted record does to the people who cannot see it

It is gone from every list, count, page, search, report and the genealogy for them, exactly as an unreadable
record is today (the page says "Not found or not visible to you"). A restricted sample takes its operations,
tests, files, analyses and params with it. Lists and counts narrow silently; the places that print a count of
hidden things are changed to "some records hidden" (section 8 and Risks).

### Who sees a record, by state

| Record | Unrestricted (as today, plus anyone listed) | Restricted |
|---|---|---|
| Sample | owner, co-owners, listed people, project PI and investigators, owner of a campaign it is in (and that campaign's project PI/investigators) | owner, co-owners, listed people, project PI, PI of a campaign's project; admins |
| Operation / test | owner, anyone who can see its sample, listed people, project PI/investigators, campaign owner and the campaign's project PI/investigators | owner, listed people, project PI (own project or campaign's project); admins |
| Campaign | owner, listed, project PI/investigators, owner or co-owner of a sample in it | owner, listed, project PI; admins |
| Project | PI, listed, investigators, owner of a campaign/sample/operation/test in it | PI, listed (incl. secondary investigators), admins |

and, **always on top**, for an operation or test: the caller must also pass the **sample gate**: its sample is
unrestricted, or the caller is on the sample's restricted list (owner, co-owner, listed, project PI). A test or
operation with no sample passes the gate. Only a **sample's** restriction cascades. A restricted campaign or
project hides that record itself; the samples, operations and tests in it keep their own rules (open question 1).

Edit is never wider than read: Can edit people can update the record; an owner can always edit; for an operation
or test the sample's editors can still edit it unless it is restricted. Delete stays with the owner (PI).

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

The five tables share one shape; the same alias name `access` on every parent keeps the generator's path strings
uniform (`access._some.person_id.user_id`).

```sql
-- sample_access, operation_access, test_access, campaign_access, project_access
CREATE TABLE sample_access (
    access_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sample_id          UUID NOT NULL REFERENCES physical_samples(sample_id) ON DELETE CASCADE,
    person_id          UUID NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    role               TEXT NOT NULL CHECK (role IN ('view', 'edit')),   -- project_access also 'investigator'
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
  "show me my restricted records" cheap; the column is almost always false.
- **People are not deleted from under a list:** `ON DELETE CASCADE` on `person_id` is safe because only admins
  delete People rows (ADR-0011 decision 9) and a deleted person owns nothing visible any more anyway.
- **Directus metadata** (in the same migration, following the pattern of 20261007000141): `directus_collections`
  rows for the five tables (hidden: nobody edits access lists in the Data Studio), `directus_relations` rows for
  the five parent FKs with `one_field = 'access'` and for `person_id → people` with no alias, `directus_fields` rows
  for the five `access` aliases (hidden, `special: o2m`) and for the five `restricted` fields (**hidden and
  read-only in A1a**, section 8). `scripts/configure_*.sql` delete and re-insert relations and fields, so they must
  keep these exactly as they keep the owner relations (ADR-0011 "The filters walk Directus relations"); phase1
  resolves every rule path after the migrations and again after the configure scripts.
- **Audit and OCC.** The five tables get the audit trigger of migration 121 so access changes are logged to
  `audit_logs`. They need no OCC `version` column: they are never edited by two people at once (only the endpoint
  writes them).

### What happens to `sample_co_owners` and `project_investigators`

These are keyed by `user_id → directus_users`, so they cannot hold a person with no login, and they are read by
a dozen consumers: `d1-access-guard` and its rules, `packages/d1-ui` (`mine.ts` `coOwnedByMe` and `projectsMine`,
`projects.ts`, `record/sampleFacts.ts`), `d1-home` (`useSampleData`, `useProjectData`, `useProjectsIndex`),
`configure_directus.sql`, `migrate_legacy.py`, `gen_people_meta.py`, `legacy_people.py`, the Data Studio sample and
project forms. Two routes:

- (a) migrate every row into the new tables and retire the old ones: one source of truth, but a change to all of
  the above and a backfill that has to report co-owners and investigators whose user has no People row;
- (b) **keep them, honour both, show both** (chosen for A1a).

(b) in detail. The rule sets are a **union**: a sample's editors are its owner, its `sample_co_owners` rows and its
`sample_access` rows with role `edit`; a project's investigators are its `project_investigators` rows and its
`project_access` rows with role `investigator`. The dialog lists both stores merged by person, labelling an old
co-owner "Co-owner · can edit" and an old investigator "Secondary investigator". It **writes only the new
tables**; removing someone who is listed only in an old table deletes that old row (the endpoint does it after
the manage check). Result: nothing needs migrating, "existing co-owners become Can edit" holds by definition, and
the Data Studio forms keep working. Two consumers are extended so "mine" stays honest: `mine.ts` gains
`sample_access` edit rows in `coOwnedByMe` and `project_access` investigator rows in `projectsMine`. Retiring the
old tables is a later, separate migration (backlog item, with the "count of rows whose user has no People row"
report); it touches no rules because the sets already treat the old and the new alike.

A deliberate change from ADR-0011: **co-owners can no longer add other co-owners**, and a project's
Can edit person cannot add investigators. The `sample_co_owners` and `project_investigators` create guards move
from the parent's *update* rule to its *manage* (delete) rule, in line with decision 2.

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
"campaign.read": ["owner_person_id.user_id", "project_id.principal_investigator_person.user_id",
  "project_id.secondary_investigators._some.user_id", "samples._some.sample_id.owner_person_id.user_id",
  "samples._some.sample_id.co_owners._some.user_id"],
"project.pi": ["principal_investigator_person.user_id"],
"project.read": ["principal_investigator_person.user_id", "secondary_investigators._some.user_id",
  "campaigns._some.owner_person_id.user_id", "samples._some.owner_person_id.user_id",
  "samples._some.co_owners._some.user_id", "operations._some.owner_person_id.user_id",
  "sessions._some.owner_person_id.user_id"],
"rollup.read":   [{"via": "project_id", "set": "project.investigators"}]
```
```json
"rules": {
  "physical_samples": {"create": "any", "read": "sample.read", "update": "sample.editors", "delete": "sample.owner"},
  "manufacturing_operations": {"create": "any", "read": "record.read", "update": "record.update", "delete": "record.owner"},
  "campaigns": {"create": "any", "read": "campaign.read", "update": "campaign.owner", "delete": "campaign.owner"},
  "projects": {"create": "any", "read": "project.read", "update": "project.pi", "delete": "project.pi"}, ...
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

Every record type has three groups of paths:

- **listed**: always sees it, restricted or not. The owner, the access-list rows, the project PI (and, for samples
  and operations/tests, the PI of the campaign's project).
- **inherited**: sees it only while it is **not** restricted. Everything ADR-0011 grants through involvement
  elsewhere (investigators, campaign owner, readers of the sample, owners of things inside a project).
- **read = listed OR (restricted = false AND inherited)**.

Operations and tests add the **sample gate** with AND:
**read = sampleGate AND (listed OR (restricted = false AND inherited))**, with
`sampleGate = sample_id IS NULL OR sample.restricted = false OR <caller is on the sample's restricted list>`.

### Generator changes (`scripts/gen_access_rules.py`, `scripts/access_rules.json`)

Today a set is a flat OR of paths that each end at `user_id = $CURRENT_USER`. The new rules need AND, literal
leaves and a role test on the access row, so a set is now a small **tree** that is built first and flattened to
Directus filters last (a `via` prefix is distributed onto the leaves, never wrapped around an `_or`/`_and`, so no
logical operator is ever nested under a relation key and the `_some` legality rule, which is about the full path
from the collection root, keeps working):

```jsonc
"set.name": [ ...items ]                      // OR of the items (as today)
"set.name": { "and": [ ...items ] }           // AND of the items
// items:
"owner_person_id.user_id"                      // user leaf (as today)
{"set": "sample.read", "via": "sample_id"}     // include a set, prefixed (as today)
{"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}
                                               // user leaf plus `role _in [...]` on the junction row `at`
{"field": "restricted", "eq": false}           // literal leaf: {restricted: {_eq: false}}
{"field": "sample_id", "null": true}           // {sample_id: {_null: true}}
{"unless_restricted": [ ...items ]}            // AND( restricted = false , OR(items) ), prefix-aware
{"and": [...]}  {"or": [...]}                  // nesting
```

- `path_filter()` keeps its `_some` legality rule unchanged (index 1, or right after another legal `_some`);
  `where` becomes sibling keys of the user leaf at the junction node, in the `_some` body when legal and on the bare
  hop when dropped. **The dropped-`_some` form is only ever used for positive membership tests here** (never
  `_none`), which is why "any joined row" is the right meaning.
- `amnesty_filter()` gains optional extra clauses: `"orphan_amnesty": {"manufacturing_operations": {"null": [...],
  "restricted_false": true, "also": "record.sample_ok"}}`, so an ownerless FAST run under a restricted sample stays
  hidden.
- `owner_guards` entries grow a `fields` list (section 4) and `gen_access_rules.py` keeps its safety net: a ruled
  collection whose update filter differs from its delete filter and that has no `owner_guards` entry fails the
  build. With Can edit people, **campaigns and projects now trip that check and get entries.**
- `resolve()` walks the new item kinds: a `field`/`null` leaf must be a column of the collection it is prefixed to,
  `where` columns must exist on the junction, `at` must be an alias in `directus_fields`.
- `hook_rules()` additionally writes `core/extensions/d1-record-access/rules.json` (per record type: table names,
  the read filter and the **manage** filter, which is the delete rule), so the endpoint never restates a rule; the
  drift check (`--check`, pre-commit, phase1, pytest) covers that file too.

### New sets (`access_rules.json`)

```jsonc
// ---- samples ----
"sample.listed": ["owner_person_id.user_id", "co_owners._some.user_id", "access._some.person_id.user_id",
  "project_id.principal_investigator_person.user_id",
  "campaigns._some.campaign_id.project_id.principal_investigator_person.user_id"],
"sample.inherited": [
  "project_id.secondary_investigators._some.user_id",
  {"path": "project_id.access._some.person_id.user_id", "at": "access", "where": {"role": ["investigator"]}},
  "campaigns._some.campaign_id.owner_person_id.user_id",
  "campaigns._some.campaign_id.project_id.secondary_investigators._some.user_id",
  {"path": "campaigns._some.campaign_id.project_id.access._some.person_id.user_id", "at": "access", "where": {"role": ["investigator"]}}],
"sample.read":    [{"set": "sample.listed"}, {"unless_restricted": [{"set": "sample.inherited"}]}],
"sample.pass":    [{"field": "restricted", "eq": false}, {"set": "sample.listed"}],   // passes the sample gate
"sample.editors": ["owner_person_id.user_id", "co_owners._some.user_id",
  {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"sample.owner":   ["owner_person_id.user_id"],                                        // delete, manage

// ---- operations and tests ----
"record.listed": ["owner_person_id.user_id", "access._some.person_id.user_id",
  "project_id.principal_investigator_person.user_id",
  "campaign_id.project_id.principal_investigator_person.user_id"],
"record.inherited": [{"via": "sample_id", "set": "sample.read"},
  "project_id.secondary_investigators._some.user_id", {"path": "project_id.access._some.person_id.user_id", "at": "access", "where": {"role": ["investigator"]}},
  "campaign_id.owner_person_id.user_id",
  "campaign_id.project_id.secondary_investigators._some.user_id", {"path": "campaign_id.project_id.access._some.person_id.user_id", "at": "access", "where": {"role": ["investigator"]}}],
"record.sample_ok": [{"field": "sample_id", "null": true}, {"via": "sample_id", "set": "sample.pass"}],
"record.read":   {"and": [{"set": "record.sample_ok"},
                          {"or": [{"set": "record.listed"}, {"unless_restricted": [{"set": "record.inherited"}]}]}]},
"record.editors": ["owner_person_id.user_id", {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"record.update": {"and": [{"set": "record.sample_ok"},
                          {"or": [{"set": "record.editors"}, {"unless_restricted": [{"via": "sample_id", "set": "sample.editors"}]}]}]},
"record.delete": {"and": [{"set": "record.sample_ok"}, {"set": "record.owner"}]},   // also the manage rule

// ---- campaigns ----
"campaign.listed": ["owner_person_id.user_id", "access._some.person_id.user_id", "project_id.principal_investigator_person.user_id"],
"campaign.inherited": [<project investigators, legacy + access role investigator, via project_id>,
  "samples._some.sample_id.owner_person_id.user_id", "samples._some.sample_id.co_owners._some.user_id",
  {"path": "samples._some.sample_id.access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"campaign.read": [{"set": "campaign.listed"}, {"unless_restricted": [{"set": "campaign.inherited"}]}],
"campaign.update": ["owner_person_id.user_id", {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"campaign.owner": ["owner_person_id.user_id"],                                     // delete, manage

// ---- projects ----
"project.listed": ["principal_investigator_person.user_id", "secondary_investigators._some.user_id", "access._some.person_id.user_id"],
"project.inherited": ["campaigns._some.owner_person_id.user_id", "samples._some.owner_person_id.user_id",
  "samples._some.co_owners._some.user_id", "operations._some.owner_person_id.user_id", "sessions._some.owner_person_id.user_id"],
"project.read": [{"set": "project.listed"}, {"unless_restricted": [{"set": "project.inherited"}]}],
"project.update": ["principal_investigator_person.user_id", {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}],
"project.pi": ["principal_investigator_person.user_id"],                           // delete, manage
"project.investigators": ["principal_investigator_person.user_id", "secondary_investigators._some.user_id",
  {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["investigator"]}}],
"rollup.read": [{"via": "project_id", "set": "project.pi"},
                {"unless_restricted": [{"via": "project_id", "set": "project.investigators"}]}]   // restricted = the rollup row's own column
```

`rules` entries change to `"physical_samples": {..., "read": "sample.read", "update": "sample.editors", "delete": "sample.owner"}`
(unchanged), `"manufacturing_operations"` and `"test_sessions"`: `read: record.read, update: record.update,
delete: record.delete`; `"campaigns"`: `update: campaign.update`; `"projects"`: `update: project.update`.

### The operations read filter, new

`S` is the sample gate, `O` the operation's own rule. Written in generated form (illegal `_some` dropped, so the
nested hops read as joins). 26 leaves against today's 14.

```jsonc
{"_or":[
 {"_and":[
   // S: no sample, an unrestricted sample, or on the sample's restricted list
   {"_or":[ {"sample_id":{"_null":true}}, {"sample_id":{"restricted":{"_eq":false}}},
     {"sample_id":{"owner_person_id":{"user_id":U}}}, {"sample_id":{"co_owners":{"user_id":U}}},
     {"sample_id":{"access":{"person_id":{"user_id":U}}}},
     {"sample_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
     {"sample_id":{"campaigns":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}}}} ]},
   // O: listed, or (unrestricted AND inherited)
   {"_or":[ {"owner_person_id":{"user_id":U}},
     {"access":{"_some":{"person_id":{"user_id":U}}}},                    // legal _some: top-level O2M
     {"project_id":{"principal_investigator_person":{"user_id":U}}},
     {"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":U}}}},
     {"_and":[ {"restricted":{"_eq":false}},
       {"_or":[ /* the sample's own read rule, via sample_id: its listed paths, and (sample.restricted = false AND its inherited paths) */
                /* project investigators (old table + project_access role investigator), campaign owner,
                   campaign's project investigators: today's remaining 5 disjuncts plus their access forms */ ]} ]} ]} ]},
 // orphan amnesty: ownerless FAST runs stay readable, unless restricted or under a restricted sample
 {"_and":[ {"owner_person_id":{"_null":true}}, {"project_id":{"_null":true}}, {"campaign_id":{"_null":true}},
           {"restricted":{"_eq":false}}, <S as above> ]} ]}
```

Update and delete for operations and tests:

```jsonc
// update: S AND ( owner OR role-edit on the operation OR (unrestricted AND the sample's editors) )
{"_and":[ <S>, {"_or":[ {"owner_person_id":{"user_id":U}},
   {"access":{"_some":{"person_id":{"user_id":U},"role":{"_in":["edit"]}}}},      // role test beside the user test
   {"_and":[{"restricted":{"_eq":false}},
            {"_or":[{"sample_id":{"owner_person_id":{"user_id":U}}},{"sample_id":{"co_owners":{"user_id":U}}},
                    {"sample_id":{"access":{"person_id":{"user_id":U},"role":{"_in":["edit"]}}}}]}]} ]} ]}
// delete: S AND owner   (also the manage rule)
```

### Everything attached follows its record

- **Children already ruled** (`sample_co_owners`, `sample_stock_provenance`, `sample_data_files`,
  `operation_data_files`, `machining_force_analysis`, `fast_run_data`, `session_data_files`,
  `*_additional_operators`, `test_sessions_subject`, `project_investigators`) follow their parent through the sets
  above with no change to their entries; the parents' new gating flows through `via`.
- **Params tables, were unfiltered for Lab Member** (`machining_params`, `sintering_params`,
  `heat_treatment_params`, `deformation_params`, `am_params` have `operation_id`; `tensile_test_params`,
  `hardness_test_params`, `charpy_test_params`, `compression_test_params`, `sem_params`, `xrd_params` have
  `session_id`, all UNIQUE). They move from `unfiltered` to `rules`, create `any`, read/update/delete the existing
  `operation.read`/`operation.update` and `session.read`/`session.update` sets (delete follows update, like the
  other data-file children). They need `directus_relations` rows for `operation_id` and `session_id` for the paths
  to resolve; check before writing the rules (`--resolve`).
- **`campaign_samples` read** becomes `sample.pass` (via `sample_id`) AND (campaign read via `campaign_id` OR sample
  read via `sample_id`), so a campaign reader no longer sees the junction row (and the id) of a restricted sample.
- **`project_rollup`** gets a `restricted` column (the refresh of migration 118 fills it: an `operation` row is
  restricted when the operation or its sample is; a `sample` row when the sample is; the tool, edge, insert,
  material and equipment rows are derived from operations and are restricted only when **every** operation behind
  them is). `rollup.read` as above: the PI sees every row, investigators only `restricted = false` rows. The
  refresh triggers fire on operations and campaigns only, so a trigger on `physical_samples` (the `restricted`
  column) is added.
- **Access tables** (`sample_access` and the four others): Lab Member **read only rows about themselves**
  (`person_id.user_id = $CURRENT_USER`), no create, update or delete. This is what the legal `_some` subquery needs
  (Directus applies the related collection's own rule inside it, so the rule must not itself recurse into the
  parent's read rule), and it is all the filters need. The dialog's full list is served by the endpoint
  (section 5); every write goes through it.

### Index counts and the Explorer

All Explorer lists, counts (`meta=filter_count`, aggregates), stat tiles and project cards read through `/items`
as the signed-in user, so they narrow without a code change. A user sees the count of records they can see: when
an owner restricts a sample, the owner's numbers are unchanged and everyone else's drop by one (and by its
operations and tests). Totals on different pages are therefore per viewer, as they already are under ADR-0011. The
Home "yours" counts and the "mine" filters are unaffected except as noted for `mine.ts`.

## 4. `d1-access-guard`

Directus does not filter create, and the filters above only decide who can *update*; the hook enforces who may
change the access-granting fields. Changes:

1. **Owner-only fields.** `owner_guards[collection]` becomes `{ "key": ..., "fields": [ {"field": "owner_person_id",
   "value_key": "person_id"}, {"field": "restricted"} ], "filter": <delete rule> }` in `rules.json`
   (`ownerGuards`). An `items.update` whose payload names **any** of the fields, and whose value differs from the
   stored one, must pass the record's **delete** rule (owner; for operations and tests also the sample gate), else
   403 `FORBIDDEN` with `extensions.kind = 'owner'` or `'restricted'`. Entries are added for `campaigns`
   (`owner_person_id`) and `projects` (`principal_investigator_person`): with Can edit people their update rule is
   no longer the same as their delete rule, which `gen_access_rules.py` would otherwise refuse. The unchanged-value
   rule (an editor saving the whole form) and the batch-per-key check stay as they are.
2. **Junction guards use the manage rule.** `guards.sample_co_owners` and `guards.project_investigators` get
   `"rule": "delete"` (the generator already looks the parent's filter up by `rule`). The messages become "Only the
   sample's owner can add co-owners." and "Only the project's principal investigator can add investigators."
   `campaign_samples` and `test_sessions_subject` are unchanged (they grant by relation, not by list).
3. **Access tables need no guard**: Lab Member has no write grant on them; the endpoint is the only writer and
   checks the manage rule itself.
4. **Ownership transfer.** A direct `PATCH owner_person_id` by the owner keeps working (Data Studio); the dialog
   uses the endpoint, which additionally keeps the previous owner as Can edit and removes the new owner from the
   list. Admins and internal calls bypass the hook, as today.
5. A create may still set `restricted = true` on a record the creator will own (nothing to guard: it narrows
   access to the creator). Creating an operation or test **under a restricted sample the creator cannot read**
   is not refused in A1a (known gap, below): the record is created and the creator cannot read it back, and the
   Force App then reports that the server did not return the new operation id, which is the existing "recording on
   a sample you cannot read is not possible" behaviour.

## 5. The record-access endpoint and the email

A new Directus endpoint extension **`core/extensions/d1-record-access`** (plain ESM, `node:test`, mounted at
`/d1-record-access`). It is the only writer of the five access tables. Every route needs a user (401 otherwise),
accepts a fixed set of collections (`physical_samples`, `manufacturing_operations`, `test_sessions`, `campaigns`,
`projects`; anything else 400) and a uuid `:id`.

| Route | Needs | Does |
|---|---|---|
| `GET /:collection/:id` | the caller can **read** the record (read through `ItemsService` with the caller's accountability, so the real rule decides; unreadable is 404) | `{ restricted, owner, project_pi, can_manage, entries: [{ person_id, name, role, label, source, can_sign_in, added_by, added_at }] }`: owner, the access table, plus the old co-owner or investigator rows (`source: 'co_owner'\|'investigator'`) |
| `POST /:collection/:id/entries` `{person_id, role}` | **manage** | upserts the access row (new row: sends the email); the person must be active; adding the owner is refused |
| `PATCH /:collection/:id/entries/:person_id` `{role}` | manage | changes the role of an access row; an old-table entry is first converted (the old row is deleted, the new one written) |
| `DELETE /:collection/:id/entries/:person_id` | manage | deletes the access row and any old co-owner or investigator row for that person |
| `POST /:collection/:id/transfer` `{person_id}` | manage | sets the owner column, adds the previous owner as `edit`, drops the new owner's access row, sends the new owner the email with the role "Owner" |

- **can_manage** = the caller is an admin, or the **manage filter** (the record's delete rule from
  `rules.json`) matches the record when run through `ItemsService.readByQuery` as the caller with `$CURRENT_USER`
  substituted (the same technique as `d1-access-guard`'s `canUpdate`). The manage check runs inside the same
  request as the write, then the write uses the system accountability (`accountability: null`), after the check,
  so Lab Member needs no write grant.
- **Person lookup** uses root reads of `people` (`person_id, full_name, email, active, user_id`); `can_sign_in` =
  `user_id IS NOT NULL`. Names come from People, which every member can already read.
- **Mail.** After the write commits, `new MailService({ schema, knex })`
  (`services.MailService` from the endpoint context), then `mail.send({ to, subject, html, text })`. The body is
  built here from plain strings with every interpolated value HTML-escaped (no Liquid template file to mount):
  adder's name, role label, record kind and code (`sample_code`, the operation's code or pass code, the test's
  title, `campaign_code`/name, `project_code`/name; the existing label helpers in `packages/d1-ui/src` are the
  reference for wording), and a link `PUBLIC_URL + '/admin' + recordRoute(collection, id)`. The send is wrapped in
  `try/catch`: any failure (no `EMAIL_*`, SMTP refusal, no email on the person) returns
  `email: 'failed' | 'skipped'` in the JSON and logs a warning; the write is never rolled back. No mail to the
  adder themselves. **The exact `MailService.send` options shape and base-template wrapping must be checked against
  the Directus 11.17 source in the running image before coding** (the smoke harness has the image); if `html` is
  not accepted without a template, ship one `.liquid` file in the extension's folder and pass `template`.
- **Why an endpoint, not an `items.create` hook on the access tables:** the endpoint already knows the adder, the
  role and the record, and a hook would also email for bulk or scripted inserts.
- Only the endpoint knows `PUBLIC_URL`; if it is unset or is `localhost` the mail is still sent with that link and
  the dialog shows nothing special.
- **Rate and abuse:** one email per new grant; a person can be added once per record (unique key), so re-adding is a
  role change with no email.

## 6. The dialog UI

- **Kit** (`packages/d1-ui`, no SDK imports; `noSdkImports.test.ts`): `access/accessApi.ts` (typed calls against the
  endpoint and `/items/people`), `access/accessModel.ts` (pure: role labels per collection, entry ordering,
  `canChangeRole`, people-search query, "can't sign in yet" marking, merge of old and new entries) and
  `components/AccessDialog.vue` (modal, uses the kit's tokens, keyboard and aria like `EditDrawer`).
  `ExplorerHost.api` today offers only `get`: it gains `post`, `patch` and `delete`, and `explorerHost.ts` already
  passes the SDK's `useApi()` axios instance, which has them.
- **Host pages** (`core/extensions/d1-home/src/pages/*Page.vue`): one `<v-button small secondary @click="access = true">
  <v-icon name="group" small left />Who has access</v-button>` in each `RecordRail` `#actions`, and
  `<AccessDialog v-model="access" :collection :id :title />` beside `EditDrawer`. The button is shown to everyone
  who can read the page; `can_manage` comes from the GET.
- **Restrict switch**: `AccessDialog` has the toggle, behind a prop `restrictEnabled` that the pages pass from one
  constant (`RESTRICT_UI = false`, one line to flip in A1b). In A1a the Data Studio `restricted` field is `hidden`
  and `readonly` in `directus_fields`, so nothing in any UI turns it on.
- **Pending states**: loading line, an inline error line (the endpoint's `message`), disabled controls while a
  write runs, optimistic nothing: the list is refetched after every change.

## 7. Paths that bypass Directus

Already enforced through the user's own permissions: the **Force App** reads with the user's Bearer token, and so do
**filter-service** and **diag-service**; **d1-trace** and **d1-report** read through `ItemsService` with the caller's
accountability (d1-report then reads root `v_*` views only for ids it has shown readable).

| Path | Today | Under A1 |
|---|---|---|
| `directus_files` / `/assets` (Lab Member: unfiltered create, read, update, delete) | any member reads any file | **A1b**: read only when the caller uploaded it (`uploaded_by`) or it is attached to a record they can read (`operation_data_files`, `session_data_files`, `sample_data_files`, `machining_force_analysis.directus_files_id` and `.live_cache_file` as hidden O2M aliases on `directus_files`). A1a: unchanged and listed as a known gap |
| **Octrees** (Caddy `handle_path /octrees/*`, `root * /srv/octrees`; `force_orchestrator.py` `OCTREE_DIR/<op>/`, `OCTREE_DIR/diag/<op>/`, `OCTREE_DIR/grid/<op>/`; no auth, ACAO `*`) | anyone who reaches the tailnet host can stream any operation's point cloud | **A1b**: Caddy `forward_auth` to a small Directus endpoint (below) |
| **Process and test params** (11 tables, unfiltered for Lab Member, each UNIQUE `operation_id`/`session_id`) | a member can read or edit any operation's params | **A1a**: follow their operation/test (section 3) |
| **llm-text-to-sql** (`d1_llm_app`, member of `d1_llm_readonly`, SELECT allow-list of migration 20261003000132, no per-user check) | reads every row of every granted table | **A1a**: Postgres row-level security scoped to that role (below) |
| **project_rollup** | readable by the PI and investigators, so it would list restricted records to secondary investigators | **A1a**: `restricted` column and the restriction-aware rule above |
| **d1-trace** | returns "N hidden" counts per section | **A1a**: booleans, UI says "some records hidden" |
| `campaign_samples`, `sample_genealogy` rows | the row reveals the other sample's id | `campaign_samples` read now needs the sample gate; a genealogy edge to a restricted relative still shows the id and the existence of the edge to a reader of the other end (d1-trace shows the marker, not the sample). Accepted (known gap) |
| Machine users (Operator, Researcher, Administrator in `core/roles.json`) | crawler, workers, equipment | live has only Administrator, Lab Admin and Lab Member; machine tokens are Administrator users. The legacy role files are deleted in A1a once nothing is found to read them (plan Task 5) |

### Ask-the-database (A1a): row-level security for one role

ADR-0011 rejected Postgres RLS because it depended on a per-request setting through a pooled connection. Here the
policy is keyed on **the role**, not the user: `d1_llm_readonly` (and its member `d1_llm_app`) must never see a
restricted record, whoever is asking. Directus connects as the table owner (`d1`) and the owner bypasses RLS unless
`FORCE ROW LEVEL SECURITY` is set (it is not), so Directus and the migrations are unaffected.

- For each table the role can SELECT that holds record-bound rows, `ENABLE ROW LEVEL SECURITY`, then a permissive
  policy `FOR SELECT TO PUBLIC USING (true)` (so any other non-owner role keeps today's behaviour; the migrations
  and compose file define no other roles, but the plan greps again) and a **restrictive** policy
  `AS RESTRICTIVE FOR SELECT TO d1_llm_readonly USING (...)`.
- The five record tables: `physical_samples`: `NOT restricted`; `manufacturing_operations` and `test_sessions`:
  `NOT restricted AND (sample_id IS NULL OR sample_id IN (SELECT sample_id FROM physical_samples))`, where the
  subquery is itself subject to the role's policy; `campaigns`, `projects`: `NOT restricted`.
- Children (`operation_data_files`, `session_data_files`, `sample_data_files`, `machining_force_analysis`,
  `fast_run_data`, the 11 params tables, `campaign_samples`, `sample_genealogy`, `sample_co_owners`,
  `sample_stock_provenance`, `test_sessions_subject`, `project_investigators`, `project_rollup` and
  `semantic_embeddings` if it carries a record key): `... IN (SELECT <fk> FROM <parent>)`, evaluated under the
  parent's policy, so a restricted sample hides its whole tree.
- **Views**: the `v_*` views granted to the role run as their owner and would bypass the policies. They are altered
  to `security_invoker = true` (Postgres 16), so they read the base tables as the role. `v_schema_dictionary`
  and the other views that touch no record rows are left alone.
- The Ask-DB UI stays as is; a restricted sample's absence reads to the model as "no such row".

### Octrees behind a login (A1b design)

`handle_path /octrees/*` gains `forward_auth directus:8055 { uri /d1-record-access/octree-auth }` ahead of
`file_server`, with the preflight (`OPTIONS`) still answered by Caddy before the auth step and `Authorization`
added to `Access-Control-Allow-Headers` (the CORS `*` wildcard does not cover it). Caddy sends the original
headers, so Directus authenticates the call from the `Authorization: Bearer` header (the Force App) or the session
cookie (the Directus-hosted force dashboard; `copy_headers Cookie`). The endpoint parses the path
(`/octrees/<op>/...`, `/octrees/diag/<op>/...`, `/octrees/grid/<op>/...`) and answers 200 when the caller can read
that operation through `ItemsService` (the operation's read rule, which includes the sample gate), 403 when not, 401
without a login, 404 for a path that names no operation. The answer is cached 60 s per (user, operation) in
process memory. The Force App sends its Bearer token on octree and diag fetches: diag already uses
`host.authHeaders()` through `authorizedFetch` in `packages/force-plotting/src/host.ts`; the octree loader (Potree)
needs the same header on its range requests (`octreeUrl` in `apps/force-app/web/src/config.ts`).

### What A1b also touches in the Force App

`apps/force-app/web/src/record/workspace.ts` `logRunSync()` POSTs `manufacturing_operations` as the signed-in user
(the creator becomes the owner) and `uploadCapture.ts` uploads the files with `POST /files`, then
`machining_force_analysis`. A1b adds a **Restricted** option to the record and upload dialogs: it sends
`restricted: true` in the operation payload (create is not guarded, the creator is the owner), shows a lock badge
and "Restricted" state on the operation, and surfaces the "could not read back the operation" failure as "you cannot
see this sample" rather than the current wording.

## 8. d1-trace, project rollup and the Data Studio

- **d1-trace** (`core/extensions/d1-trace/index.js`): the response's `hidden` object (`stock_origins`, `ancestors`,
  `events`, `descendants`) turns from counts into booleans; `packages/d1-ui/src/life.ts` `hiddenMarker()` and
  `LifeStrip` print "some records hidden" with no number; `truncated` is unchanged. Related counts that still print
  numbers (`CampaignProgress` and `SamplesPanel` "N samples not visible to you", the sample page breadcrumb) are
  listed under Known gaps and are a one-line text change each if the maintainer wants them gone in A1a (open
  question 3).
- **Data Studio**: the five `restricted` fields are hidden and read-only in A1a; the five access tables are hidden
  collections. The Data Studio never lists or edits access.

## 9. Phasing

| | Scope |
|---|---|
| **A1a** (plan: `2026-10-12-a1a-record-access.md`) | migration 164 (columns, five access tables, Directus metadata); generator and `access_rules.json`, migration 165 (the Lab Member permission rows), migration 166 (`project_rollup.restricted` and trigger); `d1-access-guard` changes; `d1-record-access` endpoint and email; dialog and button (switch off); `mine.ts` extensions; migration 167 (Ask-DB RLS, `security_invoker` views); d1-trace booleans; delete `core/roles.json` and `core/permissions.json` and what reads them; ADR and wiki |
| **A1b** | `directus_files` rule and its aliases; octree auth endpoint and Caddy change, Force App Bearer on octree/diag fetches; Force App lock badge and Restricted option; `RESTRICT_UI = true` and un-hide the `restricted` field |

A1a leaves a window in which the database enforces restriction but files and octrees still leak (a restricted
operation's `.mat` or point cloud is reachable by whoever has its id). That is why no UI can turn it on until
A1b: an owner could still set it through the API, and the plan says so in the release notes.

## 10. Testing

Fixture people (all with logins unless noted): `owner`, `coowner` (old `sample_co_owners` row), `viewer`
(`*_access` view), `editor` (`*_access` edit), `inv` (old `project_investigators` row), `inv2` (`project_access`
investigator), `pi`, `campaignOwner`, `stranger`, `nologin` (a People row with no `user_id`), `admin`. Records:
project P (PI `pi`) with campaign C (owner `campaignOwner`), sample S in C and P, operation O and test T on S, an
orphan FAST operation, in every combination of restricted/unrestricted for S, O, T, C, P.

- **`bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1 per migration batch)** and **`tests/phase1_schema.sh`**:
  the five tables and columns exist; `restricted` defaults false and is NOT NULL; unique and check constraints; the
  Lab Member rows equal the generator's output (existing assertion) and have no grant on `*_access` beyond read of
  own rows; the params tables are ruled; every new rule path resolves against the metadata after the migrations and
  after running `configure_all.sh`'s scripts (`--resolve`); the five `access` aliases and `restricted` fields keep
  their `directus_fields`/`directus_relations` rows after the configure scripts; migration 165 applies, reapplies
  and reverses to exactly the rows it started from; the RLS policies exist and a `SET ROLE d1_llm_readonly` session
  sees none of a restricted tree (samples, operations, tests, params, files rows, views) while the owner role sees
  all.
- **`python3 scripts/gen_access_rules.py --check`** (pre-commit, CI) and **`tests/scripts/test_access_rules.py`**:
  the tree flattening, `unless_restricted` with and without `via`, `where` placement for legal and dropped `_some`,
  `and` sets under `via` (distribution), the amnesty clause, `owner_guards` fields, the update-wider-than-delete
  check for campaigns and projects, `resolve()` for the new item kinds, and invariants: restricted never widens
  (every update/delete filter implies its read filter, checked on the fixture by evaluation), a restricted sample
  gates every ruled child.
- **Node tests** (`node --test core/extensions/*/index.test.mjs`): `d1-access-guard` (owner-only fields, `restricted`
  change by owner, editor, admin; unchanged value passes; batch per key; co-owner and investigator junction guards
  on the manage rule); `d1-record-access` (401; collection whitelist; read check 404; manage matrix per role; add
  sends one mail, role change none, self-add none, no email skips; a throwing `MailService` still returns the
  change; transfer keeps the previous owner as edit; old-table entries merged and deleted; two-user isolation);
  `d1-trace` (booleans).
- **d1-ui vitest** (`npx vitest run` in `packages/d1-ui`): `accessModel` (labels, ordering, merge, can't-sign-in,
  search query), `life.ts` with boolean hidden markers, `mine.ts` with access rows, `noSdkImports`; and a d1-home
  type check and build.
- **Directus smoke** (`D1_SMOKE_REQUIRE_LM=1 bash scripts/dev/directus_smoke.sh`, a read-only dump of live, never
  live itself): new `lm_*` cases for the fixture matrix, each compared with a plain-SQL evaluation of the same rules
  (as migration 160 was): every ruled collection answers 200 (the `_some` constraint), list, `filter_count` and
  paging agree and return **no duplicate rows** with an access list of several people, the role test inside
  `_some` works (viewer cannot update, editor can), an operation under a restricted sample is invisible to its owner
  when the owner is not on the sample, and the mail path returns without error with mail unconfigured.
- **Physical backlog** (`docs/runbooks/physical-test-backlog.md`): two real users, add and remove, transfer,
  email arrives with a working link, restrict (API only in A1a), project page and Home counts.

## 11. Risks, known gaps, open questions

**Filter size and performance.** The operations read filter roughly doubles (14 to about 26 leaves, with a nested
`_and` of two `_or`s), and every illegal `_some` becomes a join: `sample_id.co_owners`, `sample_id.access`,
`sample_id.campaigns...` (several), the project investigator tables, and the project access tables. Joins multiply
rows before Directus de-duplicates. The operations list is the hot path (10k+ FAST runs) and runs the filter twice
(rows and `filter_count`). **Gate:** measure on the restored copy of live with a Lab Member that reaches records
only through co-ownership, before and after (page of 25 and `filter_count`); the plan states the acceptance bar (not
slower than 2x today's median and no duplicates) and the escape hatches in this order: (1) a trigger-maintained
`sample_restricted` copy on operations and tests so the first two disjuncts of the gate are local-column checks;
(2) ADR-0011's Postgres access table (materialised per-user visibility), which also gives Ask-DB per-user scoping.
**Index counts** narrow silently per viewer (section 3).

**Directus behaviours to prove, not assume** (each has a smoke case): a role condition beside the user condition
inside a legal `_some`; `_and` of `_or`s at the top of a rule under `getCases`; the dropped-`_some` join semantics
with an access list of several rows (duplicates and counts); the legal `access._some` subquery applying the access
table's own "rows about me" rule; the mail service shape.

**Known gaps (accepted, to list in the ADR).**
- A multi-sample test is matched through its derived primary `sample_id`; a restricted *secondary* sample does not
  hide it (existing ADR-0011 limit).
- Creating an operation or test under a restricted sample the creator cannot read is not refused (section 4).
- A genealogy edge to a restricted relative shows the relative's id to a reader of the other end.
- Counts that survive: "N samples not visible to you" on campaign pages, and the sample page's hidden-link count.
- The `directus_files` and octree leaks between A1a and A1b (section 9).
- Old-table entries (`sample_co_owners`, `project_investigators`) are always people with a login; the new tables
  carry the login-less ones.

**Open questions (maintainer).**
1. Should restricting a **campaign or project** also hide the samples, operations and tests in it? The design says
   no (only a sample cascades, per decision 7); the practical effect is that a restricted project hides the
   project page and its rollup only. A cascade would be a second sample-gate-like AND on every record's rule.
2. Should **a transfer email** the new owner? The design says yes (they are being added, with the role "Owner"); one
   line to drop.
3. Should the **"N samples not visible to you"** counts in the campaign UI be changed to "some samples hidden" in
   A1a, with the d1-trace change? Recommended; it is the same kind of leak.
4. **Retiring `sample_co_owners` and `project_investigators`** (route (a)) as an A2, with the people-without-a-row
   report.
5. Does **Can edit on a project** (new: it lets that person edit the project's fields) match what you mean by Can
   edit on projects, or should projects offer only Can view and Secondary investigator?

## 12. Files this touches (A1a)

`db/migrations/20261012000164_record_access.sql`, `..165_lab_member_record_access_rules.sql`,
`..166_project_rollup_restricted.sql`, `..167_llm_role_row_security.sql`; `scripts/access_rules.json`,
`scripts/gen_access_rules.py`, `scripts/configure_users_and_policies.sql` (generated block),
`scripts/configure_directus.sql` (keep relations and fields); `core/extensions/d1-access-guard/{index.js,rules.json,index.test.mjs}`;
new `core/extensions/d1-record-access/`; `core/extensions/d1-trace/index.js`;
`packages/d1-ui/src/{host.ts,life.ts,mine.ts,index.ts,access/*,components/AccessDialog.vue}`;
`core/extensions/d1-home/src/pages/{Sample,Operation,Test,Campaign,Project}Page.vue`;
`tests/phase1_schema.sh`, `tests/scripts/test_access_rules.py`, `scripts/dev/directus_smoke.mjs`; delete
`core/roles.json`, `core/permissions.json` and rewrite or delete `core/apply.sh`, `core/README.md`, with the docs
and `.env.example` references listed in plan Task 5; `docs/adr/` (a new ADR amending 0011),
`docs/wiki/database/roles-and-permissions.md`, `docs/data-dictionary.md`.
