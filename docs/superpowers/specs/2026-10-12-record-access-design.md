# A1: Record access ("Who has access", Restricted records)

Status: **revised 2026-10-13: read visibility is materialised in trigger-maintained readers tables (rulings 18 to 20, sections 2 and 3); the rest as revised after review on 2026-10-12, maintainer rulings on the open questions in section 11.**
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

Rulings of 2026-10-13, after the Task 2 performance gate failed (section 11):

18. **Read visibility is materialised.** Who can read each record is computed in SQL when the data change and stored in
    per-type `<type>_readers(record_id, user_id)` tables, kept by triggers. One SQL function family
    (`d1_private.readers_of_<type>`, the promoted `ref.*` model) is the single statement of the rule; the tables
    materialise it; the triggers only say which records to recompute. The Directus read rule of the five types is one
    membership test on the table (sections 2 and 3).
19. **The operation and test gate on the sample's campaigns is exact** (decisions 7 and 13): an operation or test whose
    sample is hidden from the caller because of a restricted campaign or project, with no other way in, is hidden too.
    The "not expressible in Directus filters" caveat of the 2026-10-12 draft is removed (section 1).
20. **Update, delete and manage stay Directus filters** (the generated rules of Task 2a), children of a record read through
    one bare hop to its readers table, and drift between the tables and the function is checkable
    (`d1_private.readers_drift()`, shown on `/d1-admin-overview`) and tested by a mutation matrix. (How update and delete
    carry the exact campaign gate is a proposal, section 3, to confirm 7.)

Notes on the decisions above (added 2026-10-13, the decisions themselves are not reworded): decision 8's "process and
test params" are columns of the operation and the test (the eleven `*_params` tables were dropped by migration
20260623000032), so they follow their record with no rule of their own; the cascade of decisions 7 and 13 is exact as
ruling 19 says.

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
- **Also through the sample (operations and tests).** An operation or test of an unrestricted sample, itself unrestricted, also
  shows a read-only block "Also through <sample>": the sample's owner and its list, with the words "Change it on the sample".
  It appears only when the caller can read the sample (the endpoint answers 404 otherwise and the block is not drawn), so it tells
  the caller nothing the sample's own dialog does not. It is hidden as soon as either record is restricted. The block's sentence
  "Everyone on the sample can see this <record> too" holds only while neither the record's campaign nor its project hides it
  from them (the gates, section 1); the dialog does not compute that, so it is a statement about the sample's list, not a promise.
- **Grants that cannot take effect.** After the write the endpoint asks the record's OWN readers table whether the person can
  read it (the read rule itself, so it is exact whatever hides the record: a restricted sample, campaign or project, a campaign
  shield, the sample's project). A person with a login who is not in it, or a person with no login, is *blocked*; the change is
  still made. The dialog says so on add and on transfer ("<name> cannot see <parent>, so this will not take effect until its
  owner adds them"). **The parent is named only to a caller who can read it** (the nearest of sample, campaign, project that the
  person cannot read and the caller can); otherwise the words are generic ("cannot see this record yet, ... until they are given
  access to what it sits under"), so a restricted parent's code is never sent to someone who cannot see it. A person with no
  login already carries the "can't sign in yet" tag, so no second warning is drawn for them.
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
  entry, the PI of its project or of a campaign's project). Operations and tests pass the exact S* below instead.

| Record | Own rule, unrestricted (today's, plus anyone listed) | Own rule, restricted | Gates, always |
|---|---|---|---|
| Sample | owner, co-owners, listed, project PI/investigators, owner of a campaign it is in, a campaign's project PI/investigators | owner, co-owners, listed, project PI, PI of a campaign's project; admins | none as a gate: a project or campaign restriction removes only the *inherited* ways to see it (below) |
| Operation / test | owner, anyone who can see its sample, listed, project PI/investigators, campaign owner, campaign's project PI/investigators | owner, listed, project PI (own project or campaign's project); admins | S*(its sample), P(its sample's project), P(its project), C(its campaign) |
| Campaign | owner, listed, project PI/investigators, owner or co-owner of a sample in it | owner, listed, project PI; admins | P(its project) |
| Project | PI, listed, investigators, owner of a campaign/sample/operation/test in it | PI, listed (incl. Secondary investigators); admins | none |

**Samples under a restricted project or campaign.** A sample is always visible to its owner, its co-owners and
the people on its own access list, and to its project's PI. What a restricted project or campaign removes is the
*inherited* ways: a campaign's owner sees the samples in it only while the campaign is visible to them (P(its
project) holds), and the investigators of a campaign's project see its samples only while the campaign is
unrestricted. A sample in several campaigns stays visible through any campaign that still lets the caller in.

**The gate on the sample's campaigns is exact** (ruling 19; the 2026-10-12 draft could not express it in Directus filters and
settled for a weaker rule, so this paragraph replaces that caveat). For a caller *u*:

- *A campaign **lets u in*** when it is unrestricted or lists u (owner, access entry, its project's PI) **and** P(its
  project) holds. This is the C gate above.
- *A sample is **campaign-shielded from u*** when it belongs to at least one campaign and **no** campaign of the sample
  lets u in.
- The operation/test gate on the sample, **S\***: no sample; or the sample is unrestricted or lists u, **and** (u is on
  the sample's list, or u is an investigator of the sample's own project, or the sample is not campaign-shielded from u).
  Together with P(the sample's project), P(own project) and C(own campaign) it makes the gates.

In words: an operation or test whose sample is hidden from u **because of** a restricted campaign (or a campaign inside a
restricted project), with no other way in (listed on the sample, or investigator of its own project), is hidden from u
too, even if u owns the operation. The sample's own visibility is unchanged (decision 13 already says a sample in a
restricted campaign is hidden unless reached another way, and that is what the sample's read rule computes). Nothing is
shielded when nothing is restricted, so with no restricted records and no access rows the visible ids are exactly
today's. It is exact because it is computed in SQL (section 2), where "none of the sample's campaigns lets u in" is a
`NOT EXISTS`.

**The orphan amnesty** (ownerless legacy FAST runs readable by every member, ADR-0011, migration 20261009000141) is
narrowed to the cases that are open to *everyone*: owner, project and campaign null, the operation unrestricted, and
either no sample, or a sample that is unrestricted with an open project (none or unrestricted) and either no campaigns or at
least one campaign open to everyone (unrestricted, open project). These form the `operation_open_to_all` set (section 2).
When a restricted sample, campaign or project is in the way, the ownerless operation follows the **ordinary** path
(readable by whoever can read its sample), so a Can view person of a restricted project who cannot read the sample no
longer reads an ownerless run on it. That is stricter than the 2026-10-12 design and applies only where something is
restricted. As today, the children of such an operation (files, analyses, `fast_run_data`) do not inherit the amnesty.

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
  branch is 164 (`label_templates`, which has since landed on `origin/main`; this branch has not merged it yet and must, first), so A1a takes the next free numbers, **165 to 168**, and **169** (a member updates only their own People row; final review I3): `..165` schema (restricted and the access
  tables, done), `..166` the readers (tables, functions, triggers, backfill, Directus metadata) **and** the Lab Member rules
  that walk them, in that order in one file, `..167` project rollup (`restricted`), `..168` Ask-DB row security. The
  2026-10-13 revision rewrites 166 and 167 in place (they were never applied): 166 changes content, and is renamed
  `..166_record_readers_and_rules.sql`; 167 only loses the references to the old rule set. The plan re-checks
  with `git ls-tree -r --name-only origin/<branch> db/migrations` over every branch before writing a file, and the branch
  must merge `origin/main` before any migration is applied anywhere (dbmate silently skips a lower-numbered file once a
  higher one is recorded).

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

### The readers tables (materialised visibility, ruling 18)

**Why.** Task 2's performance gate failed (section 11). Directus turns every bare to-many hop of a filter into a
`LEFT JOIN`, and the read filters of operations, tests, campaigns and samples need dozens of them: 76 leaves for
operations, 971 thousand intermediate rows for the 14 thousand operations, operations index 7.6x today's time as a
stranger, the Home count 14.5x, a sample page's campaigns 130x, member lists over 60 s; the per-record gate tables of
the earlier fallback would still leave operations at about 430 ms. So **who can read a record is decided once, in SQL,
when the data change, stored, and the Directus read rule shrinks to a membership test** (section 3).

#### Tables

`sample_readers`, `operation_readers`, `test_readers`, `campaign_readers`, `project_readers`, one per record type:

```sql
CREATE TABLE operation_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,         -- Directus needs a single-column key
    record_id UUID NOT NULL REFERENCES manufacturing_operations (operation_id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES directus_users (id) ON DELETE CASCADE,
    UNIQUE (record_id, user_id)
);
CREATE INDEX operation_readers_user_idx ON operation_readers (user_id);
-- sample_readers(record_id -> physical_samples), test_readers(-> test_sessions), campaign_readers(-> campaigns),
-- project_readers(-> projects): the same shape
```

- **Keyed by login (`directus_users.id`), not by person.** The access tables stay person-keyed (a person with no login
  can be listed); the function resolves person to login (`people.user_id`), so the Directus check is one column on the
  readers row (`user_id = $CURRENT_USER`), with no hop to `people`. A person with no login has no readers row until an
  admin links the login (`people.user_id` is a trigger input, below), which is what "the grant starts working the day
  the login is linked" now means.
- A row says "this login may **read** this record". Admins are not listed (the admin policy has no rules). The record's
  foreign key removes its rows when it is deleted, and a deleted login's rows go with it.
- **Companions maintained by the same recompute:** `operation_open_to_all(reader_id identity PK, record_id UUID NOT NULL
  UNIQUE REFERENCES manufacturing_operations ON DELETE CASCADE)`, the ownerless runs every member may read (the orphan
  amnesty, below; the readers' own layout, not a table keyed by its foreign key, which is a Directus corner case);
  **`campaign_sample_readers`** (the readers layout, `record_id -> campaign_samples (id)`), the junction row's readers, so the
  `campaign_samples` read rule is one top-level `_some` instead of two bare hops under an `OR` (section 3);
  `d1_private.hidden_records(kind, record_id)`, the records hidden from the Ask-the-database role (section 7; no foreign
  key, so the diff and the delete triggers remove rows of records that no longer exist); and, **only if the measurement
  asks for it**, a `sample_genealogy` shape (section 3).
- **The legacy `user_id` columns.** `sample_co_owners.user_id` and `project_investigators.user_id` have no foreign key (verify with `pg_constraint`)
  today (only `person_id -> people`), so a deleted login leaves dangling rows. Migration 166 first **counts and reports
  dangling rows** (preflight, run read-only on the copy and on live before the window, see the runbook; they are cleaned
  up first when there are any) and then adds `FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE` to
  both; a matrix case deletes a login that holds a legacy row and edits the sample afterwards.
- **Housekeeping.** Public schema (Directus collections); **no audit trigger** (derived cache, so phase1's
  `AUDIT_EXCLUDED` list gains the readers tables, `campaign_sample_readers` and `operation_open_to_all`, next to `project_rollup` and
  `file_fingerprints`); **no grant to `d1_llm_readonly`** (it must not enumerate reader lists); Directus metadata: hidden
  collections, relations `record_id -> parent` with `one_field = 'readers'` (`'open_to_all'` for the companion) and
  `user_id -> directus_users` with no alias, hidden alias fields on the five parents and on `campaign_samples`; `configure_directus.sql` keeps them
  the way it keeps the `access` aliases. Lab Member reads **its own rows only** and has no write grant; only the
  trigger functions write (they are `SECURITY DEFINER` with a pinned `search_path`, as `audit_trigger_function` is). An
  admin write through the API is possible and is what the drift check finds. A bare user filter through the `readers` alias
  (`filter[readers][user_id]`) applies no rule, so it would tell a member which of the records they can already read another
  user can read; low impact, noted in the ADR, and the alias fields get no read permission if Directus still resolves the
  rules without it (to check on the smoke harness).

#### One source of truth: the function family

The plain-SQL model `ref.*` of `scripts/dev/access_matrix_fixture.sql` (a per-record, per-user evaluation of the whole
visibility rule, checked against Directus by the 41 smoke cases over 11 users x 5 types x 32 universes) is **promoted to
schema functions in `d1_private`**. Its helpers (`me`, `pi_of`, `p_listed`, `p_invs`, `gate_p`, `c_pi`, `c_listed`,
`gate_c`, `s_listed`, `gate_s`, `s_editor`, `s_read`, `rec_gates`, `rec_read`, `c_read`, `pj_read`) become
`d1_private.*` with the same shapes, and the two intended changes of this revision (the exact campaign gate and the
narrowed amnesty, section 1) are made once, there. On top of them:

| Function | Returns | Meaning |
|---|---|---|
| `d1_private.readers_of_sample(ids uuid[])` | `(record_id, user_id)` | every login that may read each sample |
| `d1_private.readers_of_operation(ids)`, `readers_of_test`, `readers_of_campaign`, `readers_of_project` | `(record_id, user_id)` | the same per type |
| `d1_private.operation_open_of(ids)` | `(record_id)` | the operations every member may read: ownerless (`owner`, `project`, `campaign` all null), unrestricted, and the sample gate open to everyone (section 1) |
| `d1_private.hidden_of(kind text, ids)` | `(record_id)` | the records the Ask-DB role must not see (section 7) |
| `d1_private.readers_of_campaign_sample(ids)` | `(record_id, user_id)` | the logins that may read each `campaign_samples` row: readers of its sample, or (the sample unrestricted and) readers of its campaign |

The readers tables **materialise** these functions; the triggers only say which ids to recompute. Rules for the
functions (they are what the review and the tests check):

1. **Order-dependent by design: a function may read the readers tables of the types that precede it.** (This revises the
   first draft, which said the functions read base tables only.) The production `readers_of_*` are set-based, and for speed
   four of them take an upstream layer from its materialised table instead of recomputing it:
   `readers_of_operation` and `readers_of_test` read the sample's readers from `sample_readers`;
   `readers_of_campaign_sample` reads `sample_readers` and `campaign_readers`; `readers_of_project` reads the owners that
   can read their operations and tests from `operation_readers` and `test_readers`. Recomputing those layers per call was
   what put the write gate out of reach (a one-record refresh cost 70 to 100 ms, now about 10). The dependency graph is
   acyclic (samples and campaigns read base tables only, operations and tests read samples, projects read operations and
   tests, junction rows read samples and campaigns; nothing reads `project_readers`), and **the order in which
   `sync_readers()` recomputes the types is load-bearing: samples, operations (with `operation_open_to_all`), tests,
   campaigns, projects, then junction rows**. Each type's closure contains every id whose readers can change, and each
   type is diffed in its own statement (a fresh snapshot), so when a function reads an upstream table that table is already
   current for every id it reads. `readers_rebuild()` runs the same function over every id in the same order, so it repairs
   even an arbitrarily wrong upstream layer in one pass. Two consequences, both accepted:
   (a) these functions answer correctly **only on a synced database**: for a hypothetical state ("who would be able to read
   this if...", a preview in a later task) call the `*_spec` functions, which stay pure; and (b) `readers_drift()` computes
   the upper layers from the *stored* lower layers, so a corrupt lower layer is reported at its own level and the layers
   derived from it are consistent with it and not reported; that is intended (the root cause is reported, one rebuild fixes
   every layer, and an empty drift implies equality with a from-scratch recompute by induction over the layers). The
   `*_spec` functions (candidates, then the predicate) and the independent oracle `ref.*` are never order-dependent, and the
   test asserts production = spec = oracle on every record and user of every universe. A static check
   (`tests/readers_matrix.sh`) fails when the call order inside `sync_readers()` puts a type before one of the tables its
   function reads.
2. **Candidates, then the predicate (the `*_spec` functions), and a set-based equal for production.** For each record the
   candidate users are the union of every login the positive paths can reach (owner; co-owners; access entries; the PI and
   the investigators of its project; for a sample also its campaigns' owners and project PIs and investigators; for a
   campaign also the editors of its samples; for a project the owners of what is in it), and the per-pair predicate
   (`can_read_<type>(id, user)`, the promoted `ref.*` evaluation: listed, or unrestricted and inherited, and the gates)
   keeps the ones that pass. It never crosses records with users. **The `*_spec` candidate queries inner-join
   `directus_users`**, so a dangling `user_id` can never be emitted as a reader. **The production set-based functions do not
   join it**: every `user_id` they read is a foreign key to `directus_users` (`people.user_id` since migration 060, ON DELETE
   SET NULL; `sample_co_owners.user_id` and `project_investigators.user_id` gain `ON DELETE CASCADE` keys in migration 166,
   added only after the preflight found no dangling row), so a login that no longer exists cannot be reached, and the join
   cost about 1 ms per call over ten relations. This holds exactly as long as those foreign keys exist; the matrix compares
   production with the `*_spec` functions (which do join) on every universe.
3. **Search path pinned, `STABLE`, no side effects.** A set-based rewrite of a predicate for speed is allowed only while
   the equivalence test below stays green against the fixture's independent oracle.
4. **The oracle stays.** `ref.*` remains in the fixture as an independent plain-SQL model (written from the spec's
   tables, not from the production functions) and the test asserts function = `ref.*`; the two differ only by the
   intended changes of section 1, which the oracle also carries and the report lists.

#### Recompute

`d1_private.refresh_readers(seed_s, seed_o, seed_t, seed_c, seed_p, touch_s, touch_c, touch_p, touch_j uuid[])` is
**VOLATILE plpgsql** (a `STABLE` function would reuse the caller's snapshot) and runs under `READ COMMITTED` (it **raises
unless `current_setting('transaction_isolation') = 'read committed'`**: under `REPEATABLE READ` a later statement would not
see the other transaction's commit, which the protocol relies on). The protocol is deliberately simple:

1. **Take one global, transaction-scoped, exclusive advisory lock** with a fixed key
   (`pg_advisory_xact_lock(hashtextextended('d1_readers', 0))`), **before** anything is read.
2. **In later statements** (each takes a fresh snapshot, so it contains everything the previous holder of the lock
   committed): expand the closure below from the seeds and touches, compute the functions for the closure, and diff.
3. Per type, `DELETE` the rows of the closure that the function no longer returns, `INSERT ... ON CONFLICT DO NOTHING` the
   missing ones. A diff, not delete-all and re-insert, so a big cascade does not churn the tables. Same for
   `campaign_sample_readers`, `operation_open_to_all` and `hidden_records` (which also drops the rows of records that no
   longer exist: it has no foreign key).
4. **Then, in the same call, refresh the project rollup** (`refresh_project_rollup()`) **when the `hidden_records` diff was
   not empty**: the rollup's `restricted` column is derived from `hidden_records` (section 3), so it must follow the diff,
   and it is written after the diff, never before. The rollup refresh takes its own lock after this one; the readers triggers
   are named so that they fire before the rollup's (`..._readers_...` sorts before `refresh_rollup_...`), so the order is
   always readers lock, then rollup lock.

`d1_private.readers_rebuild()` takes **the same lock** and runs steps 2 to 4 over every id (it is the migration's initial
backfill, the `TRUNCATE` repair and the operator's repair after a restore).

**Why one global lock, and what it costs.** Per-record locks cannot be made sound without locking every parent a write
attaches to and re-expanding until the closure stops growing, and they exhaust the shared lock table on a backfill (advisory
locks take main lock-table entries, `max_locks_per_transaction` x connections, about 6,400 by default; 14 thousand
operations would need 14 thousand). The two races the global lock closes: *A*, an operation (or test) repointed onto S
while S is being restricted (the attaching write seeds only the operation, so the two refreshes would share no lock);
*B*, a `campaign_samples (S, C)` insert while C's **project** is restricted (the second refresh's closure is expanded
before the first one's edge is committed). With one lock any two refreshes are totally ordered, and the later one expands
its closure from a snapshot that contains the earlier one's committed edges. **Trade-off: readers refreshes are
serialised**, and the lock is held to the end of the writer's transaction. The lab's write concurrency is low, and the
existing `refresh_project_rollup()` already takes a global transaction-level advisory lock that the operation and campaign
statement triggers fire on every statement, so writes to the hot table already serialise today; what is new is that sample,
test, access and junction writes join them. Consequences handled elsewhere: the importer commits in batches (the write gate
measures how long UI writes wait while an import transaction is open); a deadlock with ordinary row locks is still possible
(`40P01`, which Directus reports as a 500 and does not retry; **no retry is built in A1a: the importer, the crawler and the
endpoint report it, and a retry wrapper around their write transactions is a named follow-up**; nothing is left
half-applied, which the forced-deadlock test asserts); the backfill and a big-project cascade must run on **default lock settings** (the gate records
the peak `pg_locks` count, which is now one advisory lock plus the row locks).

*Seeds* are records whose **own** inputs changed (taken from both the OLD and the NEW row, so a moved record reaches its
old and new parents); the closure follows what depends on them. *Touches* are parents that only need their own recompute
(for example the old project of a record that moved out of it) and do not cascade down.

**Closure** (what a seed makes stale; `Cd` is the campaigns that cascade):

| Set | Is |
|---|---|
| `Cd` | seed campaigns, and campaigns whose project is a seed project |
| `C*` | `Cd`, touched campaigns, and campaigns that hold a seed sample (an editor of the sample is a reader of the campaign) |
| `S*` | seed and touched samples, samples whose project is a seed project, and samples in `Cd` |
| `O*`, `T*` | seed operations (tests), those whose project is a seed project, whose campaign is in `Cd`, or whose sample is in `S*` |
| `P*` | seed and touched projects, and the `project_id` of every record in `C*`, `S*`, `O*`, `T*` (a project's readers include the owners of what is in it, which depends on the derived reads of those records) |
| `J*` | the `campaign_samples` rows whose sample is in `S*`, and touched junction rows (`touch_j`); the rows of a campaign in `C*` are added by `sync_readers()` only when that campaign's readers changed (a junction row's readers are its sample's readers or, for an unrestricted sample, its campaign's, so an unchanged campaign leaves its rows alone); likewise the `sample_genealogy` rows whose child or parent is in `S*` if the genealogy shape is built (below) |

The relation is acyclic: samples, campaigns, operations and tests depend on base tables only, projects depend on the
other four, and the junction rows depend on samples and campaigns, so one pass is complete. Restricting or changing the PI
of a **project** or **campaign** therefore recomputes everything under it (the cascade of decision 13), including the
projects of samples that sit in its campaigns.

**`d1_private.readers_drift()`** returns `(kind, record_id, user_id, problem)` for every row that the functions would add
(`'missing'`) or remove (`'extra'`), plus `open_to_all`, `campaign_sample_readers` and `hidden_records` differences; it
recomputes everything (without taking the lock), so on the seeded copy its run time is recorded and, if it takes more than
a second or two, `/d1-admin-overview` shows the last run cached (`?refresh=1` recomputes). `readers_drift_count()` is the
scalar. **`/d1-admin-overview` shows the drift count** and a non-zero count is a visible warning; because it is only seen
when an admin opens the overview, a **scheduled check** (nightly, and after an import) logs a non-zero count
(`scripts/` job named in the runbook). The same function is the test's assertion (section 10).

#### Recompute triggers

Statement-level `AFTER` triggers with transition tables for every path, so a bulk insert (the FAST importer, the
crawler, a `COPY`) is **one** refresh, not one per row. Postgres 16 limits what such a trigger may be (CREATE TRIGGER
documentation, checked 2026-10-13): *a transition table cannot be combined with an `UPDATE OF <columns>` list* and *a
trigger with transition tables takes one event, not `INSERT OR UPDATE`*. So each source table gets up to **three
triggers** (`..._readers_ins`, `..._readers_upd`, `..._readers_del`), and the update trigger's function joins the old and
new transition tables and keeps only the rows where a tracked column changed (`(n.a, n.b) IS DISTINCT FROM (o.a, o.b)`),
returning at once when there are none. Every `UPDATE` of a source table therefore pays for the transition tables even
when no tracked column changed; the write-path gate (section 11) measures that on the hot tables
(`manufacturing_operations`: the crawler and the Force App write them constantly), and if it fails, those two tables
switch to row-level `AFTER UPDATE OF <tracked columns>` triggers, which Postgres does not fire at all unless a tracked
column is in the `SET` list. Referential actions (`ON DELETE SET NULL`, `ON DELETE CASCADE`) are part of the command
that caused them and fire the affected table's triggers (documentation, same page), so they need no trigger of their own;
the matrix test proves each. Foreign keys whose action is `NO ACTION` simply refuse the delete.

##### Trigger coverage

Every input the `ref.*` model reads, mapped to the trigger that notices it and to what is recomputed. Seeds are
`S O T C P` (samples, operations, tests, campaigns, projects whose own inputs changed) and touches `tS tC tP`; the
recomputed column is the closure of those seeds. Trigger names are abbreviated (`ps` physical_samples, `mo`
manufacturing_operations, `ts` test_sessions, `ca` campaigns, `pr` projects) and all are `..._readers_ins|upd|del`.

| # | Input (table, column or event) | Read by (`ref.*`) | Trigger | Seeds and touches | Recomputed |
|---|---|---|---|---|---|
| 1 | `physical_samples` INSERT | everything about the new sample | `ps_ins` | S = new ids | the sample; its project |
| 2 | `physical_samples.owner_person_id` | `s_listed`, `s_editor` | `ps_upd` | S = changed ids | the sample; campaigns that hold it; its operations and tests; the sample's project and the projects of all of the above |
| 3 | `physical_samples.project_id` | `s_listed` (`pi_of`), `p_invs`, `gate_p` of the sample's project in `rec_gates` | `ps_upd` | S; tP = old and new project | as 2, and the old project |
| 4 | `physical_samples.restricted` | `gate_s`, `s_read` | `ps_upd` | S | as 2 |
| 5 | `physical_samples` DELETE | pj_read (owner of a sample in the project) | `ps_del` | tP = old project (own rows: FK cascade) | the old project; campaigns that held it via row 34 (the junction row cascades) |
| 6 | `manufacturing_operations` INSERT (importer, crawler, Force App) | `rec_read`, amnesty | `mo_ins` | O = new ids | the operation (readers row, `open_to_all` row); its project |
| 7 | `manufacturing_operations.owner_person_id` | `rec_read` (`me(owner)`), amnesty (owner null) | `mo_upd` | O | the operation; its project |
| 8 | `manufacturing_operations.project_id` | `pi_of`, `p_invs`, `gate_p`, amnesty (project null) | `mo_upd` | O; tP = old and new | the operation; old and new project |
| 9 | `manufacturing_operations.campaign_id` | `c_pi`, campaign owner, `gate_c`, amnesty (campaign null) | `mo_upd` | O | the operation; its project |
| 10 | `manufacturing_operations.sample_id` | `s_read`, exact sample gate, `gate_p` of the sample's project, amnesty | `mo_upd` | O | the operation; its project |
| 11 | `manufacturing_operations.restricted` | `rec_read`, amnesty | `mo_upd` | O | the operation; its project |
| 12 | `manufacturing_operations` DELETE | pj_read (owner of an operation in the project) | `mo_del` | tP = old project | the old project |
| 13 | `test_sessions` INSERT | `rec_read` | `ts_ins` | T = new ids | the test; its project |
| 14 | `test_sessions.owner_person_id` | `rec_read` | `ts_upd` | T | the test; its project |
| 15 | `test_sessions.project_id` | `pi_of`, `p_invs`, `gate_p` | `ts_upd` | T; tP = old and new | the test; old and new project |
| 16 | `test_sessions.campaign_id` | `c_pi`, campaign owner, `gate_c` | `ts_upd` | T | the test; its project |
| 17 | `test_sessions.sample_id` (set by hand, or **derived**: migration 139's sync trigger writes it from `test_sessions_subject`) | `s_read`, exact sample gate | `ts_upd` (the sync trigger's own `UPDATE` fires it) | T | the test; its project |
| 18 | `test_sessions.restricted` | `rec_read` | `ts_upd` | T | the test; its project |
| 19 | `test_sessions` DELETE | pj_read | `ts_del` | tP = old project | the old project |
| 20 | `test_sessions_subject` INSERT / UPDATE / DELETE | none directly; it changes row 17 | none (row 17 catches the derived change; the matrix covers it) | | |
| 21 | `campaigns` INSERT | `c_read` | `ca_ins` | C = new ids | the campaign; its project |
| 22 | `campaigns.owner_person_id` | `c_listed`, `s_read` (campaign owner), `rec_read` | `ca_upd` | C | the campaign; samples in it; operations and tests with it or on those samples; projects of all |
| 23 | `campaigns.project_id` | `c_pi`, `gate_c` (`gate_p`), `p_invs` | `ca_upd` | C; tP = old project | as 22, and the old project |
| 24 | `campaigns.restricted` | `gate_c`, `s_read` | `ca_upd` | C | as 22 |
| 25 | `campaigns` DELETE | pj_read; operations' and tests' `campaign_id` is set null by the FK, which fires rows 9 and 16 | `ca_del` | tP = old project (own rows: FK cascade) | the old project |
| 26 | `projects` INSERT | `p_listed` | `pr_ins` | P = new ids | the project |
| 27 | `projects.principal_investigator_person` | `pi_of`, `p_listed`, `c_pi` (so samples of **other** projects that sit in this project's campaigns) | `pr_upd` | P | the project; its campaigns; samples in the project and in those campaigns; their operations and tests; projects of all of them |
| 28 | `projects.restricted` | `gate_p`, `p_listed` | `pr_upd` | P | as 27 |
| 29 | `projects` DELETE | the `project_id` foreign keys of samples, operations and tests are `NO ACTION`, so the delete is refused while any of them reference it; `campaigns.project_id` is `SET NULL` and fires row 23 | `pr_del` | none (own rows: FK cascade) | |
| 30 | `project_investigators` INSERT / DELETE | `p_listed`, `p_invs` | `pi_ins`, `pi_del` | P = project ids | as 27 |
| 31 | `project_investigators` UPDATE (`project_id`, `user_id`) | `p_listed`, `p_invs` | `pi_upd` | P = old and new project ids | as 27 |
| 32 | `project_access` INSERT / DELETE (add, remove) | `p_listed`, `p_invs` | `pa_ins`, `pa_del` | P = project ids | as 27 |
| 33 | `project_access` UPDATE (`role`, `person_id`, `project_id`) | `p_invs` reads the **role** (investigator vs view), `me(person_id)` | `pa_upd` | P = old and new project ids | as 27 |
| 34 | `campaign_samples` INSERT / DELETE / UPDATE (`campaign_id`, `sample_id`) | `s_listed` (`c_pi`), `s_read`, exact sample gate, `c_read` (`s_editor` of the members); the junction's own readers | `cs_ins`, `cs_del`, `cs_upd` | S = sample ids; tC = campaign ids, old and new; tJ = the junction ids | the sample; its operations and tests; the campaigns (their own readers only); the junction rows (`campaign_sample_readers`); projects |
| 35 | `sample_co_owners` INSERT / DELETE | `s_listed`, `s_editor` | `sco_ins`, `sco_del` | S = sample ids | as 2 |
| 36 | `sample_co_owners` UPDATE (`sample_id`, `user_id`) | same | `sco_upd` | S = old and new sample ids | as 2 |
| 37 | `sample_access` INSERT / DELETE | `s_listed`, `s_editor` | `sa_ins`, `sa_del` | S = record ids | as 2 |
| 38 | `sample_access` UPDATE (`role`, `person_id`, `sample_id`) | `s_editor` reads the **role** (edit), which feeds **campaign and project readers** | `sa_upd` | S = old and new record ids | as 2 |
| 39 | `operation_access` INSERT / DELETE | `rec_read` | `oa_ins`, `oa_del` | O = record ids | the operation; its project |
| 40 | `operation_access` UPDATE (`person_id`, `operation_id`; the role is not read) | `rec_read` | `oa_upd` | O = old and new record ids | the operation; its project |
| 41 | `test_access` INSERT / DELETE | `rec_read` | `ta_ins`, `ta_del` | T = record ids | the test; its project |
| 42 | `test_access` UPDATE (`person_id`, `session_id`; the role is not read) | `rec_read` | `ta_upd` | T = old and new record ids | the test; its project |
| 43 | `campaign_access` INSERT / DELETE | `c_listed`, `gate_c`, `s_read` | `ca_acc_ins`, `ca_acc_del` | C = record ids | as 22 |
| 44 | `campaign_access` UPDATE (`person_id`, `campaign_id`; the role is not read) | same | `ca_acc_upd` | C = old and new record ids | as 22 |
| 45 | `people.user_id` (login linked, unlinked or changed) | `me()` everywhere | `people_readers_lock` (BEFORE STATEMENT, takes the global lock before the row lock and before the seeds are gathered) and `pe_upd` | seeds: every record whose owner, PI or access entry is this person, per type (S O T C P) | the closure of all of them (a person who is PI of a project recomputes the project's contents) |
| 46 | `people` DELETE | owners and the PI are set null (rows 2, 7, 14, 22, 27 fire), access rows cascade (rows 32, 33 and 37 to 44 fire), `sample_co_owners` and `project_investigators` rows cascade by their `person_id` foreign key (rows 30 and 35 fire) | none of its own; the referential actions | | |
| 47 | `people` INSERT | nothing references a person that does not exist yet | none | | |
| 48 | `directus_users` DELETE | readers rows cascade; `people.user_id` is set null (row 45 fires); `sample_co_owners.user_id` and `project_investigators.user_id` **gain `ON DELETE CASCADE` foreign keys to `directus_users` in migration 166** (they have none today, so a deleted login left dangling rows that the function would try to insert as readers), after a preflight count and cleanup of dangling rows; then rows 30 and 35 fire | none of its own | | |
| 49 | `TRUNCATE` of a source table: the five parents, the five access tables, `campaign_samples`, `sample_co_owners`, `project_investigators`, `people`, `directus_users` (phase1 asserts a trigger on each) | everything | `..._readers_trunc` (statement) | | `readers_rebuild()` |
| 50 | Triggers not firing: `session_replication_role = replica`, `pg_restore --disable-triggers`, `ALTER TABLE ... DISABLE TRIGGER`, a direct write to a readers table, a data-only restore | everything | not covered by design | | **`readers_drift()` finds it, `readers_rebuild()` repairs it**; backups exclude the derived tables' data (`--exclude-table-data` for the readers tables, `campaign_sample_readers`, `operation_open_to_all`, `hidden_records`) and every restore ends with `readers_rebuild()` and the drift check (runbook; check `infra/backup/backup.sh` and `scripts/backup-postgres.ps1`) |
| 51 | `sample_genealogy` INSERT / UPDATE / DELETE | only if the genealogy shape is built (section 3): the edge's readers follow its child and parent | `sg_ins`, `sg_upd`, `sg_del` (only then) | tJ = the edge | the edge's readers (a read-your-neighbour table; none otherwise: the read rule is evaluated through `sample_readers`) |

**Not inputs** (the model does not read them, so no trigger): `people.active`, `directus_users.status`/`role`/`email`,
`manufacturing_operations.source_system`/`pass_code`, the `role` of `operation_access`, `test_access` and
`campaign_access`, and `added_by_person_id`. A change that makes the model read one of them must add a row here and a
trigger, and the matrix test (section 10) is where that is caught.

**The inputs that are hard to trigger on** (each has its own matrix cases): the *derived* reads that feed projects
(a project's readers include the owners and editors of what is in it **as they themselves can read it**, so almost any
change under a project reaches it, the closure of rows 2 to 28); the campaign gate of an operation (every campaign of its
sample counts, so a campaign's flags, owner, list and project reach the operations of all its samples); a person's
fan-in (row 45 gathers ten columns across ten tables); `test_sessions.sample_id`, derived by a trigger from a junction
(row 17); referential actions (rows 5, 25, 29, 46, 48); and the paths that skip triggers altogether (row 50). Two dependencies that are not columns: the existence of the login (`directus_users`) behind a legacy `user_id`, and the commit order of concurrent writers (the global lock).

#### Backfill, cost and failure modes

- **Migration 166 runs `SELECT d1_private.readers_rebuild()`** after creating the triggers and before the rule rows (the initial backfill, with a `NOTICE` of the row
  counts per table); `down` drops triggers, functions and tables. The backfill's time is measured on the seeded copy and
  goes in the cutover runbook.
- **Write cost.** A bulk insert of operations is one refresh whose closure is the new ids and their projects, so the
  cost is a set-based diff, not a per-row call. The expensive events are the cascades: restricting a project with
  thousands of operations, a project's PI or an investigator change, a co-owner added to a sample in a large campaign
  (the sample, its operations and tests, the campaigns that hold it, the projects). They run in the writer's
  transaction, so the record-access endpoint's response is consistent with the next read, and they are measured
  (section 11).
- **Concurrency** is handled by the one global advisory lock (section 2, "Recompute"); readers refreshes are serialised, writes
  that need none are not. The drift check is only the backstop.
- **Directus's cache.** The triggers change what Directus's rules return below Directus; the endpoint's writes use knex,
  so with `CACHE_ENABLED` the plan's Task 3 clears the data cache after an access change (check how the existing
  rollup and access flows behave before coding).

## 3. Visibility rules

Read visibility is the readers tables of section 2 (the rule itself lives in SQL, once); this section is what Directus does with
them: the constraints it imposes, the one-line read rules, the child rules, and the update, delete and manage filters that
stay generated. The earlier draft's 76-leaf read filters and the read-only sets behind them are gone.

### Directus constraints

What Directus 11.17 does to a filter (found and confirmed in its source on a restored copy while building Task 2,
2026-10-12) and what this design is built around. Every rule is proven on the Directus smoke harness, not only in Postgres.

1. **`_some` only under a top-level O2M alias** of the collection being filtered (or at the top of the subquery another
   legal `_some` opens). Anywhere else it throws `"_some" can only be used with top level relational alias field`
   (migration 160's header). A bare to-many hop with no `_some` means "any joined row" and is correct for positive
   membership tests, but it is a `LEFT JOIN`: it multiplies rows before Directus de-duplicates, which is what failed the
   gate. This is why every record type has a top-level `readers` alias, and why children use a bare to-one hop first.
2. **A relation key is read by its first key only.** A second key beside it (`{access: {person_id: ..., role: ...}}`,
   `role` beside `person_id`) is silently dropped. Two conditions on one row of a to-many relation are written as an
   `_and` of two bare paths through the same alias (Directus joins an alias once per query path, so they hold on the same
   row). This is what `gen_access_rules.py` emits for a role test (`where`) and for `each`; it never emits the textbook
   sibling-key or `_some: {_and: ...}` form, and no hand-written filter (the Explorer's `mine.ts`) may either.
3. **A `_some` body must be one plain chain.** An `_and`, an `_or` or two keys inside a `_some` makes the per-field
   permission `CASE` collapse and the request fail with a 500. `readers: {_some: {user_id: {_eq: $CURRENT_USER}}}` is a
   plain chain.
4. **A legal `_some` applies the related collection's rule for the same action** to the rows it looks at. So the readers
   tables' own Lab Member read rule runs inside every `readers._some` and must stay trivial (own rows:
   `user_id = $CURRENT_USER`, no relation hop, no recursion into the parent's read rule), and an **update or delete**
   filter that used `readers._some` would apply the readers table's update or delete rule, which is none. Update and
   delete therefore use a bare hop (a join applies no rule).

### Read rules: one membership test

Per record type, generated by `gen_access_rules.py` from `access_rules.json` (rule kinds below):

```jsonc
// physical_samples, test_sessions, campaigns, projects:
{"readers": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}
// manufacturing_operations: the same, OR the orphan amnesty (one leaf; operation_open_to_all is a read-any collection)
{"_or": [ {"readers": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}},
          {"open_to_all": {"_some": {"record_id": {"_nnull": true}}}} ]}
```

`readers` is a hidden top-level O2M alias (`directus_relations.one_field`), so each `_some` is legal and compiles to an
`EXISTS` subquery on an indexed pair (`record_id`, `user_id`): no join, no duplicates. The readers tables' Lab Member
rows: **read `{"user_id": {"_eq": "$CURRENT_USER"}}`, fields `*`, and nothing else**; `operation_open_to_all`: read, no
filter. The 76-leaf operations filter becomes one `EXISTS` (two with the amnesty).

### Child collections: one bare hop

A child of a record reads through its parent's readers table with **one bare to-one hop, then the to-many readers
alias**: `{operation_id: {readers: {user_id: {_eq: "$CURRENT_USER"}}}}`. A `_some` here would be illegal (constraint 1: the
`readers` alias is not top-level). The condition on `user_id` inside the join leaves at most one joined row per child (the
`(record_id, user_id)` pair is unique), so a single hop neither multiplies rows nor needs de-duplication. Create keeps
`any` (guarded by the hook where it grants visibility); update and delete are below.

| Collection | Read rule |
|---|---|
| `sample_stock_provenance`, `sample_data_files`, `sample_co_owners` | `sample_id.readers.user_id = $CURRENT_USER` |
| `sample_genealogy` | `child_sample_id.readers.user_id = U` OR `parent_sample_id.readers.user_id = U` |
| `campaign_samples` | `{readers: {_some: {user_id: U}}}` on `campaign_sample_readers` (one top-level `_some`; the junction's readers are "readers of the sample, or, for an unrestricted sample, readers of the campaign", the old "sample gate AND (campaign read OR sample read)" evaluated in SQL) |
| `operation_data_files`, `machining_force_analysis`, `fast_run_data`, `operation_additional_operators` (and every other ruled child of an operation) | `operation_id.readers.user_id = U` |
| `session_data_files`, `session_additional_operators` | `session_id.readers.user_id = U` |
| `test_sessions_subject` | `test_sessions_id.readers.user_id = U` |
| `project_investigators` | `project_id.readers.user_id = U` |
| `project_rollup` | **unchanged** from Task 2c: the PI reads every row, an investigator the rows with `restricted = false`. Not `project_id.readers`, which is a wider audience (Can view people, owners of things in the project); see below and section 11 |
| the five `*_access` tables | their own rows (`person_id.user_id = $CURRENT_USER`), as today; the dialog's full list comes from the endpoint |

**Two-hop `OR` rules are not shipped.** An `OR` of two bare hops stops Postgres pushing `user_id = U` into either `LEFT JOIN`,
so each junction row would join |sample readers| x |campaign readers| rows before the filter (a campaign of a large project
has a hundred readers): the failed gate's "sample page campaigns 130x" query again. So `campaign_samples` is materialised
now: `campaign_sample_readers`, filled by the same refresh (`readers_of_campaign_sample`: the logins that read the sample,
or, when the sample is unrestricted, that read the campaign; closure `J*`), and its read rule is one top-level
`{readers: {_some: {user_id: {_eq: $CURRENT_USER}}}}`. **`sample_genealogy`** (an edge is readable by readers of its child or
its parent) has the same shape problem on a small table with a composite key and no surrogate id; its equivalent is
`sample_genealogy_readers`, keyed by a surrogate `genealogy_id` added to the table, built **only if the gate measures the
two-hop rule over the limit** (genealogy rows are few); until then it keeps the two-hop `OR`, and the smoke asserts no
duplicate ids and `filter_count` agreement for it. Children of an operation do **not** inherit the orphan amnesty, as
today. Known gap (to list in the ADR): a campaign reader still sees the junction row, and so the id, of an unrestricted
sample hidden from them by its project or by campaign shielding.

### Update, delete and manage: "is a reader" AND the editor test (proposal, to confirm 7)

The hand-written gate leaves of the first draft (S, P, P, C on every operation and test) existed only to say "the caller
can read this record"; the readers table says it, and says it exactly (including the campaign shielding, ruling 19, which
no filter can write). So:

- **Update** = *caller is a reader of the record* AND (owner, or Can edit, or, unless restricted, an editor of the sample);
  **delete and manage** (the manage rule is the record's delete rule, which the guard and the endpoint read from
  `rules.json`) = *reader* AND owner. "Reader" is the bare hop `{readers: {user_id: {_eq: U}}}` (`operation_id.readers`
  and so on for children), not `_some` (constraint 4). Joins apply no rule, one row per record, and the decisions are
  single-row, so this is cheap (re-measured by the gate, section 11).
- For **samples** and **projects** no reader term is needed: the editors and the PI are on the list, hence readers. For
  **campaigns** the reader term replaces `has.project_ok`.
- Everything else of Task 2a stays: the owner and editor tests (a role test is an AND of two bare paths, constraint 2),
  `unless_restricted`, owner-only `sample_co_owners` update and delete, the junction guards, the owner guards,
  `restricted_keys`. Children's update and delete keep following the parent's update rule through `via`.
- The invariant **update and delete are never wider than read** is structural for operations, tests and campaigns (the
  reader term) and checked for the others by the DB matrix (section 10), which compares the update and delete ids Directus
  returns on the smoke harness with the function's read set. The pytest evaluator no longer sees the read side.

`access_rules.json` after the revision:

- **Removed:** every read-only set (`sample.inherited`, `sample.read`, `record.listed`, `record.inherited`, `record.read`,
  `campaign.inherited`, `campaign.read`, `project.inherited`, `project.read`, `link.sample.read`, `genealogy.read`,
  `operation.read`, `session.read`, `subject.read`, `investigators.read`, `campaign_samples.read`), the gate sets
  (`project.listed/pass`, `has.project_ok`, `campaign.listed/pass`, `has.campaign_ok`, `sample.listed/pass`,
  `gates.sample`, `record.gates`, `amnesty.gates`) and `each` and `orphan_amnesty` in their old shape, if nothing else
  uses them: their model is the SQL function now, and keeping both would be a second statement of the rule.
- **Kept:** the engine of 2a (tree, `via` onto to-one hops, `where`, `unless_restricted`, `unfiltered`, `guards`,
  `owner_guards`, `restricted_keys`, `record_access`) and the sets for update, delete and manage (`sample.editors`,
  `sample.owner`, `record.editors`, `record.owner`, `record.update`, `record.delete`, `campaign.update`,
  `campaign.manage`, `campaign.owner`, `project.pi`, `project.invs`, `project.investigators`, `link.sample.owner`,
  `link.sample.editors`, `genealogy.write`, `campaign_samples.write`, `operation.update`, `session.update`,
  `subject.update`, `investigators.write`, `rollup.read`).
- **New items and rules:** the item `{"reader": "bare"}` (the bare hop `readers.user_id = $CURRENT_USER` at the row's
  prefix; used with `via` for children) and the read rule kinds `{"readers": "some"}` (the top-level `_some` form; valid
  only at the root of a collection) and `{"open_to_all": true}` (the amnesty leaf). `resolve()` checks the `readers` and
  `open_to_all` aliases exist in `directus_fields`, the relations in `directus_relations`, and that every `via` is to-one.
- `hook_rules()` and the `d1-record-access` rules file keep their shape (read = the generated read filter, manage = the
  delete filter), so the endpoint's "caller can read" check now evaluates the membership test through `ItemsService`.

**Intended differences from today**, for the equivalence tests (section 10): `sample_co_owners` update and delete (owner
only, as in the 2026-10-12 draft); the exact campaign gate and the narrowed amnesty (section 1), visible only where
something is restricted; and, only where something is restricted or an access row exists, everything else in sections 1
and 2. With nothing restricted and no access rows every user sees exactly today's ids.

### Everything attached follows its record

- **Children already ruled** follow their parent through its readers table (the table above). The cascade of section 1
  reaches them because the parents' readers already carry it.
- **Params.** The eleven `*_params` tables no longer exist (migration 20260623000032 folded their fields into
  `manufacturing_operations` and `test_sessions`; the stale Lab Member rows for them were a bypass only on paper), so the
  params work of the first draft is gone: the fields follow the operation or test.
- **`campaign_samples` read** as in the table: a campaign reader no longer sees the junction row (and the id) of a
  restricted sample.
- **`project_rollup`** gets a `restricted` column, **derived from `hidden_records`** (section 2), not recomputed from
  parts: an `operation` row is restricted iff the operation is hidden (restricted, or its sample, project or campaign is
  hidden, including the sample's other campaigns and the campaign's project); a `sample` row iff the sample is hidden; the
  tool, edge, insert, material and equipment rows are derived from operations and are restricted only when **every**
  operation behind them is (`bool_and`). (The first attempt's rule looked only at the operation's, sample's and campaign's
  own flags, so an operation in a restricted project's campaign, or on a sample held only by a restricted campaign, showed
  its code and its sample's code to the investigators, and the Ask-DB policy `NOT restricted` leaked them to the role.)
  The refresh runs from the readers refresh whenever the `hidden_records` diff is non-empty (written after the diff, section
  2), which also covers `campaign_samples` and `projects.restricted`, which fire no rollup trigger today; the existing
  triggers on operations and campaigns and the `physical_samples` one stay.
  `rollup.read`: the PI sees every row, investigators only `restricted = false` rows. **Kept as a set-based rule
  on purpose:** reading it through `project_id.readers` would show the rollup (tools, materials and equipment used across
  the project) to everyone who can read the project, including Can view people and owners of one record in it; that
  widening is the maintainer's call (section 11, to confirm). A PI of project P still sees the rollup row of an operation
  of P that is hidden from them by another project's restricted sample (section 11).
- **Access and readers tables.** Lab Member reads only the rows about themselves (`access`) or their own reader rows
  (`readers`), no create, update or delete. Directus applies the related collection's own rule inside a legal `_some`
  (constraint 4), so these rules must not recurse into the parent's read rule. The dialog's full list is served by the
  endpoint (section 5); every access write goes through it.

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
   **"Restricted" in this paragraph means HIDDEN** (final review I1): the flag, OR the record is listed in `d1_private.hidden_records`
   (restricted, or under a restricted project, campaign or sample; the readers triggers keep it). The bare flag of a parent is not
   enough: an operation on an unrestricted sample in a restricted project is gated by the project, and moving it away lifts that
   gate. The guard reads both and unites them (an empty `hidden_records` after a restore can only make it stricter). It applies
   to the record itself, its current sample, and the old and new project, campaign and sample of the move, to the
   `campaign_samples` rules below and to the DELETE of a `campaign_samples` row of a hidden campaign.
   **`test_sessions_subject`** (the migration-139 trigger derives `test_sessions.sample_id` from its rows) is guarded on create, on
   repointing `item`, `collection` or `test_sessions_id`, and on delete: when the test, the sample it is on, or a sample being
   added or removed is hidden, the caller must pass the test's delete rule (its owner).
   **Two more guards close writes a member could use to gain read of what restriction hides** (the recompute propagates
   these edges correctly; the question is who may write them):
   - **`campaign_samples` create or repoint requires the caller to be a reader of the sample** (`sample_readers`, one
     lookup), and, when the sample is restricted, its owner (the rule above). Without it a member who owns any campaign
     could attach a sample id they happen to know (ids leak through genealogy edges and test subject rows, accepted gaps) and
     become a reader of it through the campaign-owner or campaign-project-PI paths, including a sample in a restricted
     project, or a sample shielded by a restricted campaign (whose unrestricted operations would stop being shielded).
   - **A change of `campaigns.project_id` always needs the campaign's delete rule (its owner; a Can edit person is
     refused),** and, when the campaign holds any restricted sample, has any restricted operation or test with that
     `campaign_id`, or holds a sample of a restricted project, the caller must also pass **each of those records' delete
     rule** (own them); otherwise only an admin can make the move. Moving an unrestricted campaign into a project the mover
     created (anyone can create a project with themselves as PI) would otherwise make them `c_pi`, which lists them on every
     sample in the campaign, restricted ones included, and on every restricted operation and test with that campaign; the
     campaign owner owns none of those, so requiring the campaign owner alone does not close it.
   - **Clearing a key is a move** (fix round 1): setting `project_id`, `campaign_id` or `sample_id` to null takes the record out of its
     parent's gate, so it needs the delete rule exactly when the OLD parent (or the record, or its sample) is Restricted, and a campaign's
     project can never be cleared without the campaign's delete rule. A key that is already empty is not a move.
   - **`restricted` is compared the way Postgres reads a boolean** (`t/true/y/yes/on/1`, `f/false/n/no/off/0`, any case, padded or not);
     any other spelling counts as a change, so the guard runs (`'t'` must not look unchanged over a stored false).
   - **Removing a sample from a Restricted campaign** (a DELETE of a `campaign_samples` row, an `items.delete` filter) needs the campaign's
     delete rule (its owner) or an admin: the campaign shields its operations and tests, and detaching the sample can unhide them. A campaign
     that is not Restricted keeps the junction rule only.
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
6. From A1b a create may set `restricted = true` on a record the creator will own (in A1a rule 7 refuses it for non-admins). Creating an operation or test
   **under a restricted sample the creator cannot read** is not refused in A1a (known gap): the record is created and
   the creator cannot read it back, and the Force App then reports that the server did not return the new operation
   id, which is the existing "recording on a sample you cannot read is not possible" behaviour.

7. **Until A1b, `restricted` is admin-only** (final review I4, ruled by the maintainer). `RESTRICT_ADMIN_ONLY = true` in the guard
   (A1b turns it off, or sets `D1_A1B_RESTRICT_OPEN=true` in the Directus environment): any change of `restricted` on a sample,
   operation, test, campaign or project by a non-admin is refused with kind `restricted` ("Restricting a record is not available
   yet. Ask an administrator."), on update (the value differs from the stored one) and at create (`restricted` true). The owner-only
   logic above stays underneath it for A1b. Why: `directus_files` is unfiltered and octrees are unauthenticated in A1a, so letting
   an owner restrict a record would promise privacy the system cannot keep.

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
- **`blocked_by`** per entry (and on the transfer answer: `POST .../transfer` returns `{ owner, email, blocked_by }`, which the kit
  turns into the same line) is `null`, or `{ reason: 'parent' | 'no_login', collection, id, kind, code }`. It is read from the
  record's own readers table after the write (final review I2): a login that is in it, or an admin (admins are not listed), is not
  blocked; a login that is not, is blocked by a parent; a person with no login is `no_login`. `collection`, `id`, `kind` and
  `code` name the nearest parent (sample, campaign, project) the person cannot read, and only when the CALLER can read that
  parent; they are all null otherwise. The same rule governs `project_pi` in the GET: it is null for a caller who cannot read the
  record's project.
- **Read-your-write.** The access write fires the readers triggers in the same transaction, so the `GET` that follows a
  `POST`, `PATCH`, `DELETE` or transfer already shows the new readers, and the record's page reads the new state. With
  `CACHE_ENABLED` the endpoint clears the Directus data cache after commit (knex writes bypass the services that normally do).
- **Mail recipient.** The address is `directus_users.email` when the person has a login (an admin-controlled
  address), and `people.email` only for a login-less person. (Lab Member could edit `people.email` on any People row, so
  mailing it for a person with a login would let any member redirect another's notifications. Final review I3, ruled by the
  maintainer: a Lab Member may update **only their own People row** (`people.user_id = $CURRENT_USER`; migration 169, and
  `custom.people.update.permissions` in `access_rules.json`); admins edit any row, and anyone may still create a person with no
  login. Nothing in the Explorer depends on a member editing another person's row: `d1-person-link` runs with the system
  accountability, the People page shows other rows read-only to a member, and the dialog only reads People.)
- **Mail to a person who cannot read the record yet** (blocked, above): who added them, the role and the record's kind and code, and
  generic wording only ("You cannot open it yet. You will be able to once the owner of what it sits under gives you access", or "...
  once you have a D1 login and access to it" for a person with no login). No title, no link, and nothing of the parents above it
  (no kind, code or PI name): the recipient may not be allowed to know they exist.
- **Mail.** After the write commits, `new MailService({ schema, knex })` (`services.MailService`), then
  `mail.send({ to, subject, html, text })`, with the body built here from plain strings, every interpolated value
  HTML-escaped (no Liquid template to mount): adder's name, role label, record kind and code, and the link
  `PUBLIC_URL + '/admin/home/<kind>/<id>'`. The endpoint cannot import the kit's `recordRoute`, so it keeps a
  five-entry map and a kit test pins that map against `recordRoute`. **The send is wrapped in `try/catch` and in a
  10-second timeout** (nodemailer's defaults are minutes when the host is unreachable): any failure (no `EMAIL_*`,
  SMTP refusal, timeout, no address) returns `email: 'failed' | 'skipped'` and logs a warning; the write is never
  rolled back. No mail to the adder. **Checked against the image (Directus 11.17.4, @directus/api 35.2.0), 2026-10-13:** `send(data, options)` takes `{ to, subject, html, text }`
  and hands them to nodemailer; `html` is used as given (only a `template` makes it render a `.liquid` file and wrap it), so no template
  file is shipped; every line of `html` is trimmed; `from` defaults to `EMAIL_FROM`; the constructor calls `getMailer()`, which throws on an
  unknown `EMAIL_TRANSPORT`, so it is built inside the same `try/catch` as `send`. Clearing the data cache: an extension gets no cache handle,
  so the endpoint calls `new services.UtilsService({ schema, accountability: { admin: true } }).clearCache({ system: false })` after the commit
  when `CACHE_ENABLED` is on.
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
| `directus_files` / `/assets` (Lab Member: unfiltered create, read, update, delete) | any member reads any file | **A1b**: read only when the caller uploaded it (`uploaded_by`) or it is attached to a record they can read: the attaching collections (`operation_data_files`, `session_data_files`, `sample_data_files`, `machining_force_analysis.directus_files_id` and `.live_cache_file`) are hidden O2M aliases on `directus_files`, and the rule is a bare hop through the alias to the record's readers table (`<alias>.operation_id.readers.user_id = $CURRENT_USER`, an OR over the aliases). A1a: unchanged, listed as a known gap |
| **Octrees** (Caddy `handle_path /octrees/*`, `root * /srv/octrees`; `force_orchestrator.py` `OCTREE_DIR/<op>/`, `OCTREE_DIR/diag/<op>/`, `OCTREE_DIR/grid/<op>/`; no auth, ACAO `*`) | anyone who reaches the tailnet host can stream any operation's point cloud | **A1b**: Caddy `forward_auth` to a small Directus endpoint (below) |
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
- **Why the policy is role-level, and what the readers machinery gives it (ruling 18).** The service
  (`plugins/llm-text-to-sql`) authenticates its caller with one shared secret (`X-Worker-Secret`) and opens a connection
  per query with one `LLM_DATABASE_URL`; it never learns which member asked, so the policy cannot test a per-user readers
  row (`EXISTS (SELECT 1 FROM <type>_readers ...)` against a session setting would need the service to carry the asker's
  identity and the SQL guard to forbid `set_config`: a follow-up, section 11, to confirm). What the role needs is "hide
  anything restricted or under a restricted ancestor", and that is a **recompute-maintained fact**, the same machinery as
  the readers tables: `d1_private.hidden_records(kind, record_id)`, filled by `d1_private.hidden_of(kind, ids)` inside the
  same `refresh_readers` closure, with the same triggers and no extra input (section 2, the coverage table covers it). A
  record is hidden when it is restricted or its project is restricted; a campaign also when its project is; a sample when
  any campaign it belongs to is hidden (conservative: the role has no way in); an operation or test when its sample,
  project or campaign is hidden. Written straight from the flags, so no recursion.
- **The policy** for each record-bound parent is then one line, the same for all five: restrictive `FOR SELECT TO
  d1_llm_readonly USING (NOT d1_private.is_hidden('<collection>', <primary key>))`, where `d1_private.is_hidden(kind,
  id)` is a `STABLE SECURITY DEFINER` function with a pinned `search_path` that looks the pair up in `hidden_records`
  (an indexed anti-join); **`USAGE` on schema `d1_private` and `EXECUTE` on the function go to the role** (a policy expression is evaluated with the querying role's privileges; only the function body runs as its owner, so without `USAGE` every query on the five tables fails with "permission denied for schema" and Ask-DB breaks), while `hidden_records` and the backup tables stay **ungranted** (the role must not list restricted ids). phase6 asserts that a restricted and an unrestricted row behave as the role expects.
  This replaces the five hand-written expressions with their `NOT EXISTS (SELECT ... campaign_samples ...)` subqueries, so
  the restriction logic is stated once (in `hidden_of`) and tested by the drift check; the children below keep their
  `<fk> IN (SELECT <pk> FROM <parent>)` policies, which run under the parent's policy.
  **The model cannot call `is_hidden` or read the table:** `plugins/llm-text-to-sql/app/lib/sql_guard.py` rejects schema-qualified function
  calls and every schema but `public` (checked 2026-10-13), and the policy runs the function on the server's behalf; the
  `EXECUTE` grant is needed only so the policy can evaluate it. A test asserts the guard still rejects `SELECT d1_private.is_hidden(...)`.
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
  The (dropped) params tables are gone, so there is nothing to add for them; a later grant must add a policy, which the completeness
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
`/octrees/diag/<op>/...`, `/octrees/grid/<op>/...`) and answers 200 when the caller is a reader of that operation (a row in `operation_readers`, one indexed lookup:
`SELECT 1 FROM operation_readers WHERE record_id = $1 AND user_id = $2`; admins pass), 403 when not, 401 without a login, 404 for a path that
names no operation. No cache is needed (a primary-key style lookup). The Force App sends its
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
- **Data Studio**: the five `restricted` fields are hidden and read-only in A1a; the five access tables, the five readers
  tables and `operation_open_to_all` are hidden collections. The Data Studio never lists or edits access or readers.

## 9. Phasing

| | Scope |
|---|---|
| **A1a** (plan: `2026-10-12-a1a-record-access.md`) | migration 165 (columns, five access tables, Directus metadata); generator and `access_rules.json`; migration 166 (readers tables, the `d1_private` function family, recompute triggers, backfill, `readers_drift()`, then the Lab Member permission rows: one-membership-test reads, update and delete on the reader term); migration 167 (`project_rollup.restricted` and trigger); `d1-access-guard` changes; `d1-record-access` endpoint and email; `d1-admin-overview` drift count; dialog and button (switch off); `mine.ts` extensions; campaign and d1-trace hidden texts; migration 168 (Ask-DB row security on `hidden_records`, `security_invoker` views); migration 169 (`people.update` own row only); delete `core/roles.json` and `core/permissions.json` and what reads them; ADR, wiki, cutover runbook |
| **A1b** | `directus_files` rule and its aliases; octree auth endpoint and Caddy change, Force App Bearer on octree/diag fetches; Force App lock badge and Restricted option; `RESTRICT_UI = true` and un-hide the `restricted` field; the guard's remaining A1a gap (creating under a restricted sample) |
| **A2** (follow-up, decision 17) | retire `sample_co_owners` and `project_investigators`: migrate into the new tables with the "no People row" report, then drop the old path from the sets and the consumers |

A1a leaves a window in which the database enforces restriction but files and octrees still leak (a restricted
operation's `.mat` or point cloud is reachable by whoever has its id). That is why no UI can turn it on until A1b:
an owner could still set it through the API, so the guard refuses it for everyone but admins until A1b (section 4, rule 7).

## 10. Testing

Fixture people (all with logins unless noted): `owner`, `coowner` (old `sample_co_owners` row), `viewer`
(`*_access` view), `editor` (`*_access` edit), `inv` (old `project_investigators` row), `inv2` (`project_access`
investigator), `pi`, `campaignOwner`, `stranger`, `nologin` (a People row with no `user_id`), `admin`. Records:
project P (PI `pi`) with campaign C (owner `campaignOwner`), sample S in C and P, a second sample S2 in C and also in
an open campaign C2 of an open project Q, operation O and test T on S, an orphan FAST operation, in every
combination of restricted/unrestricted for S, O, T, C, P (`scripts/dev/access_matrix_fixture.sql`: 32 universes).

- **The mutation-matrix equivalence test (non-negotiable).** On a seeded database (the fixture's 32 universes plus
  `scripts/dev/seed_access_fixture.sql`), for **each mutation class** apply the mutation, then assert that **every readers
  table equals the function for all records** (not only the touched ones): `SELECT * FROM d1_private.readers_drift()`
  returns no rows, which also covers `campaign_sample_readers`, `operation_open_to_all` and `hidden_records`; then reverse it
  and assert again, and assert at least one explicit effect (the intended reader appeared or disappeared). The classes are
  the rows of the trigger-coverage table (section 2), none skipped:
  - owner change on each of the four owned types; co-owner add, remove and repoint; legacy project investigators add,
    remove and repoint; each of the five access tables (add, remove, role change, person change, parent change);
  - `restricted` on, then off, on each of the five types; restrict and unrestrict in **one transaction**; a
    `ROLLBACK TO SAVEPOINT` after a mutation; a tracked column set to its **current value** (no readers writes);
  - `project_id`, `campaign_id` and `sample_id` moved on each type that has them (including a test's sample **derived** from
    `test_sessions_subject`, and an old and a new parent that are both restricted); a statement that **swaps two operations'
    samples** (S1 to S2 and S2 to S1) and one that swaps two persons' logins;
  - `campaign_samples` insert, delete and repoint; PI change on a project (including a project whose campaigns hold samples of
    another project); `people.user_id` linked, unlinked and changed;
  - deletes: person (owners set null, access rows cascade, legacy rows cascade by `person_id`); `directus_users`, including a
    user who still holds a **legacy co-owner or investigator row**, followed by an edit of that sample (the dangling-login
    case); each of the five record types; a project with only campaigns (the `SET NULL` path) and a project refused because
    samples reference it; a sample delete where a test survives through a secondary subject (migration 139's BEFORE DELETE
    path); bulk `test_sessions_subject` inserts;
  - multi-row forms: one statement that inserts 1000 operations (the importer's shape), the importer's real
    `INSERT ... ON CONFLICT (operation_id) DO UPDATE` re-import that changes owner, project or sample, one that restricts a
    project with contents, a `COPY`, a `TRUNCATE` of each source table, and a **full `readers_rebuild()` and a big-project
    restrict on default `max_locks_per_transaction`**;
  - the rollup and Ask-DB cases: an operation in a restricted project's campaign, and one on a sample held only by a
    restricted campaign, have `project_rollup.restricted = true` and are hidden from the Ask-DB role.
- **The concurrency cases** (two sessions, each in both commit orders, then `readers_drift()` empty and the explicit effect
  checked): *(0)* session 1 inserts `campaign_samples (S, C)` while session 2 restricts C; *(A)* session 1 repoints an
  operation (or a test) onto S, or inserts one on S, while session 2 restricts S, removes S's co-owner or adds S to a
  restricted campaign (the attaching write seeds only the operation); *(B)* session 1 inserts `campaign_samples (S, C)` while
  session 2 restricts **C's project**; a login unlinked while the same person is added to a record, and while the same
  person is made the owner of a sample (both orders: the `people_readers_lock` trigger takes the lock before the people row
  lock); a forced lock-order deadlock with a row lock, which aborts one writer cleanly with nothing stale; and the
  people-row deadlock (a `people.user_id` update against an owner change), which must not occur and which the test shows
  does occur when the trigger is removed. `refresh_readers` is also run
  under `REPEATABLE READ` and must raise.
- **A seeded randomised differential test** (`tests/readers_matrix.sh`, fixed seed printed on failure): generate small random
  universes (random flags, edges, lists, logins: a sample in two campaigns of different projects with mixed flags, a sample
  whose project is restricted while its campaign's project is open, an operation whose campaign's project differs from its
  own, the investigator-of-the-sample's-project escape of S\*, a login-less person later linked, a Can edit sample entry
  feeding campaign and project readers under restriction) and assert `readers_of_*` equals `ref.*` evaluated as the full
  users x records cross product (this also catches a candidate class the production generation drops); then run random
  mutation sequences and assert `readers_drift()` is empty after every step.
- **A trigger deliberately disabled makes `readers_drift()` report the difference and `readers_rebuild()` repair it** (proof
  that the check can fail). The function is also asserted equal to the independent `ref.*` oracle for every fixture user,
  record and universe, differing only by the intended changes of section 1 (listed in the report: the operations and tests
  of a sample that sits only in a restricted campaign, universes `k & 7 = 2`: C restricted, P and S not).
- **`bash scripts/dev/schema_test_docker.sh` (ROUNDTRIP=4, the number of new migrations)** and
  **`tests/phase1_schema.sh`**: the five access tables and columns exist; `restricted` defaults false and is NOT NULL;
  unique and check constraints (`project_access` accepts `investigator`, the others refuse it); the five readers tables and
  `campaign_sample_readers` and `operation_open_to_all` exist with their unique key, `user_id` index and cascading foreign keys, the legacy `user_id` columns have their `directus_users` foreign keys; **every coverage-table
  trigger exists** (a list in the test: one per table and event, statement-level, with transition tables) and the functions
  are `SECURITY DEFINER` with a pinned `search_path`; the readers tables are not audited (`AUDIT_EXCLUDED`) and not granted
  to `d1_llm_readonly`; the Lab Member rows equal the generator's output (existing assertion) and have no grant on
  `*_access` or `*_readers` beyond reading own rows; the (dropped) params tables have no rule; every new rule path
  resolves against the metadata after the migrations and after running `configure_all.sh`'s scripts (`--resolve`); the five
  `access` and `readers` aliases, `open_to_all` and the `restricted` fields keep their rows after the configure scripts;
  the migration backfill leaves `readers_drift()` empty on the restored copy; each migration applies, reapplies and
  reverses to exactly the rows it started from; **RLS:** a `SET ROLE d1_llm_readonly` session sees none of a restricted
  tree (samples, operations, tests, file rows, `v_*` views) or of a tree under a restricted project or campaign, while the
  owner role sees all; **a role with `d1_embedder`'s grants can still INSERT and UPDATE `semantic_embeddings` after the RLS
  migration**; **every granted table has RLS or is in the reference list**; **every granted view has
  `security_invoker=true`**.
- **`python3 scripts/gen_access_rules.py --check`** (pre-commit, CI) and **`tests/scripts/test_access_rules.py`**: tree
  flattening; `where` as an AND of two bare paths (never a sibling key); `each` in its bare-alias form; `via` distribution
  and that every `via` is an M2O; the new items (`reader` bare hop, the `readers` some rule, `open_to_all`) and their
  `resolve()` checks; no `_some` outside index 1 / after a legal `_some` in any output (walk every rule); every child rule
  is `<fk>.readers.user_id` with a to-one `<fk>`; update, delete and manage of operations, tests and campaigns contain the
  reader term; `owner_guards` fields; the update-wider-than-delete net. The Python evaluator is kept only for the
  update/delete/manage filters and for shapes; **read equivalence is the DB matrix's job, not pytest's**.
- **Node tests** (`node --test core/extensions/*/index.test.mjs`): `d1-access-guard` (owner-only fields; `restricted` by
  owner, co-owner, Can edit person, admin; unchanged value passes; batch per key; campaigns guarded; **a co-owner's
  `PATCH user_id` and `DELETE` on a `sample_co_owners` row are 403**; the junction guards on the manage rule;
  **restricted-sensitive keys: an editor changing `project_id`/`campaign_id`/`sample_id` of a restricted record, or out
  of or into a restricted parent, is 403, the owner passes; the `campaign_samples` and `test_sessions_subject` cases; adding a `campaign_samples` row for a sample the caller cannot read is 403 (and for a restricted one needs its owner); changing a campaign's `project_id` is 403 for a Can edit person, for the campaign owner when the campaign holds a restricted sample, restricted operation or test, or a sample of a restricted project and the caller does not own them, including the owner moving it into a project they created themselves, and passes for an admin**);
  `d1-record-access` (401; collection whitelist; 404 on unreadable; manage matrix per role; add sends one mail, role
  change none, self-add none, no address skips, a legacy co-owner re-added sends none; the recipient is the login email when
  there is a login and the People email otherwise; a throwing or hanging `MailService` still returns the change; transfer
  keeps the previous owner and emails the new one with its own subject; old-table entries merged to the strongest role and
  deleted in the same transaction; `blocked_by` read from the readers tables; `set_config` called; two-user isolation;
  the data cache cleared after a change when caching is on); `d1-admin-overview` (the drift count is returned and a
  non-zero count is flagged); the link map pinned against the kit's `recordRoute`; `d1-trace` booleans.
- **d1-ui vitest**: `accessModel` (labels incl. the project roles, ordering, merge, can't-sign-in, search query,
  no-owner text), `life.ts` with boolean markers, the campaign "some hidden" texts, **`mine.ts` filters in the legal form
  (an AND of bare paths for a role test, never a sibling key or a `_some` with two conditions)**, `RESTRICT_UI` pinned,
  `noSdkImports`; and a d1-home type check and build.
- **Directus smoke** (`D1_SMOKE_REQUIRE_LM=1 D1_SMOKE_OVERLAYS="d1-access-guard d1-record-access d1-trace d1-admin-overview"
  bash scripts/dev/directus_smoke.sh`, a read-only dump of live, never live itself). The harness mounts the **main
  checkout's** extensions and overlays only `d1-next-number`, so without the overlay list the worktree's code would not be
  under test. **The 41 `lm_*` cases of Task 2 must still pass**; their expected ids come from the fixture's oracle, so the
  cases whose expectation changes because of the intended differences of section 1 are re-derived and listed explicitly in
  the report (not silently updated). New or changed cases, each compared with the function's answer: every ruled
  collection answers 200 (the `_some` constraint) with the single-`EXISTS` read rule; list, `filter_count` and paging
  agree and return **no duplicate rows** with an access list of several people, samples in several campaigns and the
  two-hop children (`campaign_samples`, `sample_genealogy`); the child rules (`operation_id.readers`) return a child once;
  the amnesty leaf; update and delete ids are a subset of read ids for every user and type; the role test inside the
  update filters works (viewer cannot update, editor can); an operation under a restricted sample, and one on a sample in
  a restricted campaign, is invisible to its own owner; a restricted project hides its campaigns, samples (except to
  owners and lists), operations and tests from a stranger and not from the PI; a co-owner's `PATCH`/`DELETE` of a
  `sample_co_owners` row is 403; an editor's `PATCH project_id` of a restricted sample is 403; a change through the
  endpoint is readable immediately (the trigger ran in the same transaction); the mail path returns without error with
  mail unconfigured.
- **Performance** (section 11) runs on the same copy after seeding.
- **Physical backlog** (`docs/runbooks/physical-test-backlog.md`): two real users, add and remove, transfer, email
  arrives with a working link, restrict (API only in A1a), project page and Home counts, and the admin overview's drift
  count is zero afterwards.

## 11. Risks, decisions, known gaps

**Performance: what failed, and the gate for the readers design (the main risk).** The first design (read filters of ~76
leaves with bare to-many hops) **failed the Task 2 gate** on a seeded copy (1665 samples, 14285 operations, 4 large projects;
20 requests each; limit p95 under 300 ms and at most 2x today's median):

| as | request | before p50/p95 | after p50/p95 | ratio |
|---|---|---|---|---|
| stranger | operations index | 109/120 ms | 828/862 ms | 7.6x |
| stranger | tests index | 29/32 | 107/113 | 3.7x |
| stranger | campaigns index | 137/145 | 279/284 | 2.0x |
| stranger | Home count machining | 24/27 | 347/351 | 14.5x |
| stranger | sample page campaigns | 13/14 | 1692/1728 | 130x |
| member | operations index | 436/470 | 1056/1081 | 2.4x |
| member | campaigns, samples index | 22599/23664, 23516/23661 | over 60000 | at least 2.6x |
| member | Home count campaigns | 36/42 | 8328/8394 | 231x |

The cause is the multiplication of `LEFT JOIN`s (971 thousand intermediate rows for 14 thousand operations; no index
was missing), and the per-record gate tables of the earlier fallback would have left operations at about 430 ms. The
readers tables (section 2) remove the joins from reads. **The gate for the new design (plan Task 2), on the same seeded
copy** (`scripts/dev/seed_access_fixture.sql`, copy only; live has no access rows and nothing restricted):

- **Reads.** The same requests as above for a stranger and for a member (co-owner of a few samples, an investigator),
  before (main's rules) and after, and **all lists**: the operations, tests, campaigns, samples and projects indexes with
  `filter_count`, the Home counts, a sample page's children and its campaigns list, and the **child lists as the Force App
  queries them** (`machining_force_analysis` by `GET /items/machining_force_analysis`, the call of
  `apps/force-app/web/src/record/directusLookups.ts` and the uploads' lookups; `fast_run_data`; `operation_data_files`).
  **p95 under 300 ms per list request**, no duplicates, and not more than 2x today's median.
- **Writes** (end-to-end wall time of the request or import, so "2x" has a real baseline, before and after on the same
  copy): the FAST importer's bulk insert (`scripts/import_fast25.py`, a few thousand operations in one statement) **and its
  real `INSERT ... ON CONFLICT (operation_id) DO UPDATE` re-import** (lines 284 and 299 of that script; it fires both the
  insert and the update triggers); the force crawler's operation and `machining_force_analysis` writes
  (`scripts/force_orchestrator.py`); a Force App upload (`POST /files`, then `machining_force_analysis`,
  `apps/force-app/web/src/record/uploadCapture.ts`); **a co-owner change on a big sample** (the sample in several campaigns
  of large projects, with many operations); and **the per-row recompute paths**: creating N tests with subjects (migration
  139's sync is a row trigger that issues one `UPDATE test_sessions` per subject row, so `ts_upd` and its refresh run once per
  subject row), adding 50 samples to a large campaign through Directus (one `campaign_samples` insert per statement for M2M and
  O2M writes), and **linking the login of a PI of a large project** (row 45's cascade). **At most 2x today's time for each of
  these**; the cascades an owner can trigger (restricting a large project, changing a PI) are reported with their absolute
  times and closure sizes (rare, one per decision of an owner). Also measured: **how long ordinary UI writes wait while an
  import transaction is open** (the global lock; the importer commits in batches), and the **peak `pg_locks` count during the
  backfill and the big cascades on default lock settings**.
- Also recorded: the migration's backfill time, `readers_drift()`'s run time (and, if slow, the cached display on the
  admin overview), and the readers tables' sizes.
- **If it fails:** `EXPLAIN (ANALYZE, BUFFERS)` first. Reads: `sample_genealogy`, the one two-hop rule left, is the
  likeliest (build its materialised shape, section 3, or add indexes). Writes: the transition tables on
  `manufacturing_operations` and `test_sessions` (section 2: switch those two to row-level `AFTER UPDATE OF <tracked
  columns>` triggers), or a set-based rewrite of a candidate query, kept honest by the equivalence test. If it still
  fails, stop and report; do not ship.
- Index counts narrow silently per viewer (section 3).

**Directus behaviours to prove, not assume** (each has a smoke case): `readers._some` under `getCases` with the readers
table's own rule applied inside it; the `open_to_all` leaf (a `_some` over a collection keyed by its own foreign key);
the one-hop child rules return each child once and `filter_count` agrees, including the `OR` of two hops left in
`sample_genealogy` and the single `_some` of `campaign_samples` over `campaign_sample_readers`; update and delete filters with the bare `readers` hop (constraint 4: no rule is
applied to a join); the role test as an AND of two bare paths; the legal `access._some` subquery applying the access
table's own "rows about me" rule; the mail service shape.

**Trigger-maintained data: what can go wrong, and what covers it.** A missed input leaves a stale reader row (a reader
who should not be one, or the reverse). Covered by: the trigger-coverage table enumerated from the model (section 2), the
mutation-matrix test (section 10: one case per row, `readers_drift()` empty after each), the drift function on the admin
overview and a scheduled check, and `readers_rebuild()` as the repair. Concurrent writers are ordered by one global advisory lock (section 2, "Recompute"), with the two races it closes in the matrix. Not covered by triggers by design: anything that bypasses them
(`session_replication_role = replica`, `pg_restore --disable-triggers`, a direct write to a readers table); the runbooks say
to run the drift check afterwards. A cascade is as large as its project (restricting or re-PI-ing a big project recomputes
everything in it), done in the writer's transaction.

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
- The orphan amnesty covers only runs that are open to everyone; an ownerless run under a restricted ancestor follows the
  ordinary path (section 1).
- A campaign reader still sees the junction row, and so the id, of an unrestricted sample that is hidden from them by its project or by campaign shielding.
- Deadlocks (`40P01`) surface as a 500 in Directus, which does not retry, and the importer, the crawler and the endpoint do not retry them either (a bounded retry around their write transactions is a named follow-up, not built in A1a); nothing is left half-applied. The variants: a writer that takes a parent row lock (a foreign-key `KEY SHARE` by inserting a test, junction, co-owner or access row) before its first readers lock can deadlock with a parent DELETE or key update, which takes the readers lock first and then the row; the same shape for the delete of a campaign, project, person or login. Non-key updates (`restricted`, owner, project) take `NO KEY UPDATE` and do not conflict with `KEY SHARE`, so only parent deletes and unique or primary-key updates are exposed. The `people.user_id` variant is closed by the `people_readers_lock` trigger (below). A `TRUNCATE` of `test_sessions_subject` leaves `test_sessions.sample_id` stale (migration 139's behaviour, not the readers'; the readers follow the column): one line in the runbook.

**Decided** (maintainer, 2026-10-12 and 2026-10-13):
1. Restricting a **campaign or project cascades** (decision 13), and the operation/test gate on the sample's campaigns is
   exact (ruling 19); the "not expressible" caveat is gone.
2. A **transfer emails the new owner**, with its own subject (decision 14).
3. The campaign UI's **"N samples not visible"** becomes "some hidden" in A1a (decision 15).
4. **Projects offer Can view and Secondary investigator only** (decision 16); a transfer keeps the previous PI as
   Secondary investigator.
5. The **old tables are retired later**, as a follow-up after A1b (decision 17, A2).
6. **Read visibility is materialised** in trigger-maintained readers tables, keyed by login, with one SQL function family
   as the single statement of the rule and a mutation-matrix test and drift check as the guard (ruling 18).
7. **Update, delete and manage stay Directus filters** and children read through one bare hop to the readers table (ruling 20); the reader-term form of the update and delete filters is a proposal, to confirm 7.
8. **Readers refreshes are serialised by one global transaction-scoped advisory lock** (maintainer, 2026-10-13, after review): it closes the two races (an attaching write against restricting its parent; a junction insert against restricting a project) and the lock-table exhaustion of per-id locks; the cost is that writes needing a refresh queue until commit, accepted for the lab's write concurrency. Both race cases are in the matrix in both commit orders.

**To confirm (the design picked a default).**
1. *Strict gates for operations and tests.* Under a restricted project or campaign the operation's own owner, if not
   on the list, cannot see their operation (the same rule decision 7 sets for a restricted sample). Samples keep an
   owner exception, as the ruling states; operations, tests and campaigns do not.
2. *PI versus the sample gate, cross-project.* An operation in project P on a restricted sample of project Q is
   hidden from P's PI (decision 7 wins over "the PI sees everything"), while the rollup row stays visible to P's PI.
   Alternative: let the PI of the operation's project pass the sample gate.
3. *Tightening `people.update`* so a member edits `email` only on their own row (a separate ADR-0011 follow-up; the
   mail recipient rule above already avoids the redirect for people with a login).
4. *The reading of the campaign gate (ruling 19).* "Hidden from u because of a restricted campaign or project, with no
   other way in" is implemented as: every campaign of the sample is closed to u, and u is neither on the sample's list nor
   an investigator of its own project. A sample in an open campaign as well is not shielded.
5. *The narrowed amnesty.* A Can view person of a restricted project who cannot read an ownerless run's sample no longer
   reads that run (section 1). Alternative: materialise those people into `operation_readers`.
6. *`project_rollup` through `project_id.readers`.* Kept as PI plus investigators-on-unrestricted-rows. Reading it through
   the readers table would show the rollup to every project reader (Can view people, owners of one record in the project).
7. *Update and delete rebuilt on the reader term* (section 3) rather than kept as Task 2a generated them: it removes the
   second encoding of the gates and makes "never wider than read" structural; it changes the generated filters of
   operations, tests and campaigns.
8. *Ask-the-database stays role-level* (section 7); a per-user policy on the readers tables needs the service to carry the
   asker's identity (a follow-up).

## 12. Files this touches (A1a)

`db/migrations/<next free numbers, 165 to 169 at the time of writing>`: record access (done), readers tables with
functions, triggers and backfill, project rollup, Lab Member rules, LLM role row security; `scripts/access_rules.json`,
`scripts/gen_access_rules.py`, `scripts/configure_users_and_policies.sql` (generated block), `scripts/configure_directus.sql`
(keep relations and fields, including the `readers` and `open_to_all` aliases); `core/extensions/d1-access-guard/{index.js,
rules.json,index.test.mjs}`; new `core/extensions/d1-record-access/`; `core/extensions/d1-admin-overview/{index.js,
index.test.mjs}` (the drift count); `core/extensions/d1-trace/index.js`;
`packages/d1-ui/src/{host.ts,life.ts,mine.ts,index.ts,access/*,components/AccessDialog.vue,campaign/*}`;
`core/extensions/d1-home/src/pages/{Sample,Operation,Test,Campaign,Project}Page.vue`;
`tests/phase1_schema.sh` (incl. `AUDIT_EXCLUDED`), `tests/scripts/test_access_rules.py`, the readers mutation-matrix test
(`tests/readers_matrix.sh`, run by `schema_test_docker.sh`), `scripts/dev/directus_smoke.sh` (overlays),
`scripts/dev/directus_smoke.mjs`, `scripts/dev/access_matrix_fixture.sql` (the oracle with the two intended changes),
`scripts/dev/seed_access_fixture.sql`, `infra/backup/backup.sh` and `scripts/backup-postgres.ps1` (exclude the derived tables' data from dumps); delete `core/roles.json`, `core/permissions.json` and rewrite or delete
`core/apply.sh`, `core/README.md`, with the docs and `.env.example` references listed in plan Task 5;
`.pre-commit-config.yaml`; `docs/adr/` (a new ADR amending 0011), `docs/wiki/database/roles-and-permissions.md`,
`docs/data-dictionary.md`, `CONTRIBUTING.md` and `.claude/skills/db-migration/SKILL.md` (the `security_invoker` rule),
`docs/runbooks/a1-record-access-cutover.md` (five migrations, backfill time, drift check).
