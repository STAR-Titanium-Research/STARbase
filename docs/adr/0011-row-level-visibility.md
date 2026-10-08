# ADR-0011 — Row-level visibility: people see the records they are involved in

- **Status:** Accepted (2026-10-07; the owner's decisions are recorded below)
- **Date:** 2026-10-06 (proposed), 2026-10-07 (accepted)
- **Deciders:** Maintainer + Claude (Phase 9 RBAC hardening; Explorer pages track)

## Context

Until this ADR every human account was a **Lab Member** (or Lab Admin). The Lab Member policy in
`scripts/configure_users_and_policies.sql` granted full CRUD on every lab collection with **no
row filter**, so everyone could read and change every sample, operation, test, campaign and
project. ADR-0005 always intended project-level access "as a row-level permission filter, not as
separate roles", deferred to Phase 9 (`plan.md`, "Open / deferred decisions").

The maintainer's target workflow (2026-10-06) is: a user logs in and **sees only the things they
are authorised on** (records they own or co-own), on a clean custom home screen, and browses
projects, campaigns, samples and operations as formatted pages rather than Data Studio forms (see
the [Explorer spec](../superpowers/specs/2026-10-06-explorer-pages-design.md)). The Explorer pages
read through `/items` as the signed-in user, so they show whatever Directus permissions allow.
The restriction itself therefore has to live in the permissions, not in the pages.

The data already records who is involved in a record:

| Record | Involvement columns |
|---|---|
| `projects` | `principal_investigator_person` → `people`; `project_investigators` (M2M alias `secondary_investigators`, `user_id` → `directus_users`). The project form already tells users that investigators "will be recorded as having viewing access to all samples, operations, and test sessions connected to this project" (`scripts/configure_directus.sql`, `investigator_access_notice`). |
| `campaigns` | `owner_person_id` → `people`; `project_id`; the samples in it through `campaign_samples` (alias `samples`) |
| `physical_samples` | `owner_person_id`; `sample_co_owners` (M2M alias `co_owners`, `user_id`); `project_id`; `campaign_samples` (alias `campaigns`) |
| `manufacturing_operations`, `test_sessions` | `owner_person_id` (defaulted to the creator by the `d1-default-owner` hook); `project_id`; `campaign_id`; the sample they act on (`sample_id`) |

`people.user_id` (unique) links a person to their Directus login, so "the current user" in a
filter is `owner_person_id.user_id = $CURRENT_USER`. The older `owner` / `principal_investigator`
UUID columns are hidden backups (`20260703000062_people_directus_meta.sql`) and are not used.

## Owner decisions (2026-10-07)

1. **Rig operators:** there is no technician role. Owners add operators as **co-owners** of the
   samples they work on. A co-owner can read and edit the sample and its operations and tests.
2. **Strict, not focused:** the restriction is enforced by Directus permission filters on the Lab
   Member policy, so the Data Studio and the API are restricted too, not only the Explorer pages.
3. **Ask-DB is unchanged for now.** Its `llm_readonly` Postgres role still reads all lab data.
   This is an accepted, known gap, to be revisited (see "Known gaps"). `d1-ask-endpoint` and the
   LLM role are not touched.
4. **Editing:** update is limited to owners and co-owners, not to PIs and investigators who can
   read a record through the project. Lab Admins are unaffected. Create is open to every member.
   Delete is limited to the owner.

Decisions after the review of the first implementation (2026-10-07):

5. **Self-grant is blocked.** Four junctions grant visibility when a row is written: a
   `sample_co_owners` row (the co-owner reads and edits the sample), a `project_investigators` row
   (the investigator reads everything in the project), a `campaign_samples` row (the campaign's
   owner reads the sample) and a `test_sessions_subject` row. The last one is indirect: migration 139
   keeps `test_sessions.sample_id` equal to the first sample of the test's subject rows (lowest
   junction id), and the test read and update rules go through `sample_id`, so a member who added a
   subject row naming **their own** sample to a colleague's test (choosing a low id for the row) would
   become that test's reader and editor. Directus does not filter create, so a member could grant
   themselves access by creating one. The `d1-access-guard` hook (below) refuses a create, or an
   update that repoints the parent key, unless the caller may **update the parent**: the sample for
   `sample_co_owners`, the project (its PI) for `project_investigators`, the test (its owner, or an
   owner or co-owner of its sample) for `test_sessions_subject`, and for `campaign_samples`
   **both** the campaign (its owner) **and** the sample (owner or co-owner of it). The sample half is
   the ruling for campaigns: without it a campaign owner could add any sample to their campaign and
   read it. A sample owner who wants a sample in someone else's campaign makes that person its
   co-owner, who then adds it. Deleting a `campaign_samples` row stays open to either side.
   For a subject row the guard does **not** also require that the caller can read the sample (or
   insert edge) it names. Naming a sample you cannot read gives you nothing (the test is already
   yours to update, `sample_id` reads back as hidden, no rule grants a sample through a test); its
   effect is that the **sample's** owner and co-owners can then read and edit your test, which is the
   same trade as adding them as collaborators and is visible on the test. A member who does not want
   that does not add the subject. Any later rule that reads a record **through a derived column**
   needs the junction it is derived from in `guards`; a pytest enforces this for `sample_id`.
6. **The audit log is for admins only.** Lab Member has no grant on `audit_logs`: it holds the old
   and new values of every change, including records the member cannot see, and has no owner column
   to filter on. No extension reads it as a member (checked).
7. **A PI sees the project's campaigns' records.** "Belongs to the project" counts records that
   reach the project through their **campaign** as well as through their own `project_id`: the
   project's PI and investigators read an operation or test whose `campaign_id.project_id` is the
   project, and a sample that is in a campaign of the project. A project is also readable by the
   owner of an operation or test in it, so that owner's breadcrumb is not dead.
8. **A project's PI defaults to its creator** (`d1-default-owner`), like the owner of the other
   records, so the creator can edit what they made. **The creator wins over inheritance.**
   `campaign-inherit` used to copy a project's PI onto a new campaign and a campaign's owner onto a
   new operation or test, and as it loads before `d1-default-owner` (alphabetical) the copy was in
   place first and the creator never became the owner, so a member who made an operation in a
   colleague's campaign could not see or edit it afterwards. `campaign-inherit` now copies the
   project, default equipment and default material only; the owner of a new record is its creator
   unless the form or API names someone else.
9. **People cannot be relinked by members.** `people.user_id` decides who a person *is*, so freeing
   your login and attaching it to a colleague's row would hand you all their records. Lab Members can
   read People, create a row with no login or with their own, and update every column **except**
   `user_id`; only admins link or relink logins and delete People rows (a delete would orphan the
   owner of every record that person owns).
10. **Only the owner can hand a record over.** Co-owners may update a sample and only its owner may
    delete it, so a co-owner who set `owner_person_id` to themselves would gain delete. The same
    holds for operations and tests (their editors include the sample's owner and co-owners, their
    delete is the record's own owner). The `d1-access-guard` hook therefore refuses an update that
    **changes** `owner_person_id` of a sample, operation or test unless the caller passes that
    record's **delete** rule, i.e. is its current owner. The owner can hand a record to someone else;
    an editor cannot take it. Campaigns and projects need no such check: their update and delete
    rules are the same, so only the owner or PI can reach the update at all.

## Decision

### The rules

"Owner" means `owner_person_id` → `people.user_id` equals the signed-in user. "Co-owner" means a
`sample_co_owners.user_id` row for the signed-in user. "PI" means the project's
`principal_investigator_person.user_id`; "investigator" means a `project_investigators.user_id`
row. The machine-readable form of every rule is
[`scripts/access_rules.json`](../../scripts/access_rules.json).

**Read** (a record is visible when any line holds):

| Collection | Visible to |
|---|---|
| `physical_samples` | its owner; a co-owner; the PI or an investigator of its project; the owner of a campaign it belongs to; the PI or an investigator of the project of a campaign it belongs to |
| `manufacturing_operations`, `test_sessions` | the record's owner; anyone who can read the sample it acts on (`sample_id`, by the sample rule); the PI or an investigator of its project, or of its campaign's project; the owner of its campaign |
| `campaigns` | its owner; the PI or an investigator of its project; the owner or a co-owner of a sample in it |
| `projects` | the PI; an investigator; the owner of a campaign in it; the owner or a co-owner of a sample in it; the owner of an operation or a test in it |
| Child rows (below) | whoever can read the parent row |
| Reference data | every member (unfiltered) |

**Update** (limited to the people who work on the record, so PI and investigator access through
the project is read-only):

| Collection | Updatable by |
|---|---|
| `physical_samples` | its owner or a co-owner |
| `manufacturing_operations`, `test_sessions` | the record's owner, or an owner or co-owner of the sample it acts on (so a co-owned operator can record and fix their own work) |
| `campaigns` | its owner |
| `projects` | its PI |

**Delete:** `physical_samples` by its owner; operations and tests by the record's owner;
campaigns by their owner; projects by their PI.

**Create:** any member, with no filter (Directus does not apply item filters to create), except the
four junctions that grant visibility, which the `d1-access-guard` hook checks (decision 5). The
`d1-default-owner` hook makes the creator the owner of a new sample, operation, test or
campaign, and the PI of a new project, so the creator can read and edit what they just made. The
creator is the owner even in a campaign or project owned by someone else: `campaign-inherit` copies
the campaign's project and defaults, never its owner (decision 8).

**Child rows follow the parent.** Read follows the parent's read rule, update and delete follow
the parent's update rule:

| Child collection | Parent it follows |
|---|---|
| `sample_co_owners`, `sample_stock_provenance`, `sample_data_files` | the sample (`sample_id`); creating a `sample_co_owners` row needs the sample's update rule (guard) |
| `sample_genealogy` | read: either the child or the parent sample; update and delete: the child sample's update rule |
| `campaign_samples` | read: the campaign's or the sample's read rule; update and delete: the campaign's owner or the sample's owner or co-owner; create (or repointing a key): the campaign's update rule **and** the sample's update rule (guard) |
| `operation_data_files`, `machining_force_analysis`, `fast_run_data` | the operation (`operation_id`); `fast_run_data` has read only and `machining_force_analysis` has no delete, as before |
| `session_data_files`, `test_sessions_subject` | the test (`session_id`, `test_sessions_id`); creating a `test_sessions_subject` row (or repointing its test) needs the test's update rule (guard) |
| `project_investigators` | read: the project's read rule; update and delete: the project's PI; create (or repointing the project): the project's update rule, i.e. the PI (guard) |
| `project_rollup` (read only) | the project's PI and investigators only |

**Reference data stays readable (and writable, as before) by every member:** `materials`,
`material_iso_classifications`, `alloying_elements`, `material_alloying_elements`, `equipment`,
`manufacturing_methods`, `raw_stock_lots`, `tools`, `tool_boxes`, `cutting_inserts`,
`insert_edges`, `insert_types`, `facilities`, `fast_recipes`, `force_crawler_state`,
and the `directus_files` create and read grants.

**People** are read by every member but are not freely writable (decision 9). Create: a row with
no `user_id` or with the member's own (a `validation` rule; a member without a People row can make
their own). Update: every column except `user_id` (a field list; `person_id`, the legacy machine
operator id and `created_at` are also left out, and a column added later stays read-only until the
rule lists it, which a phase1 assertion enforces). Delete: admins only. **Audit log:** admins only
(decision 6).

Where a rule says "can read the sample", the *sample* read rule applies in full, so an owner of a
campaign sees the operations and tests on every sample in it.

### The mechanism

Directus **permission filters** on the Lab Member policy (`directus_permissions.permissions`),
using `$CURRENT_USER` and relational paths, for example for `physical_samples` read:

```json
{ "_or": [
  { "owner_person_id": { "user_id": { "_eq": "$CURRENT_USER" } } },
  { "co_owners": { "_some": { "user_id": { "_eq": "$CURRENT_USER" } } } },
  { "project_id": { "principal_investigator_person": { "user_id": { "_eq": "$CURRENT_USER" } } } },
  { "project_id": { "secondary_investigators": { "_some": { "user_id": { "_eq": "$CURRENT_USER" } } } } },
  { "campaigns": { "_some": { "campaign_id": { "owner_person_id": { "user_id": { "_eq": "$CURRENT_USER" } } } } } }
] }
```

The filters are written **once**, in `scripts/access_rules.json`, and turned into rows by
`scripts/gen_access_rules.py`. One migration applies them to the Lab Member policy;
`configure_users_and_policies.sql` carries the same generated rows between markers, because that
script deletes and re-inserts every Lab Member permission on each run and would otherwise remove
the filters. A phase1 test compares the stored permission JSON with the generator's output and a
pytest checks the script block, so neither can drift from the source. A new rule is a change to
the JSON plus a new migration that pastes the regenerated rows.

The rules are documented by intent in `docs/wiki/database/roles-and-permissions.md`, so the
drop-Directus drill (ADR-0002) can re-implement them.

**The guard hook.** `core/extensions/d1-access-guard` (a plain `index.js` hook, like
`d1-default-owner`) registers `items.create` and `items.update` filters for the four junctions of
decision 5. It reads `rules.json`, which `gen_access_rules.py --write` generates from the
`guards` section of `access_rules.json` and which holds each parent's **own update filter**, so the
rule is written once. The hook runs `ItemsService.readByQuery` on the parent with the caller's
accountability (and the request's transaction, so a parent created in the same request is found),
the key and that filter with `$CURRENT_USER` substituted, and refuses with a 403 `FORBIDDEN` when no
row comes back **and** the parent was not inserted by this same transaction (below). Admins and calls with no accountability (flows, scripts, other extensions) are not
checked; every other caller is, whatever their policy. On update only a parent key that actually
changes is checked (a key sent with its current value is not a change); for a junction with more
than one guard (`campaign_samples`) a change to either key checks **every** guard on the row as it
will be after the update, so moving a row to another campaign needs the sample's update rule and
moving it to another sample needs the campaign's.

**Creating a parent and its junction rows in one save** (a project with investigators, a sample with
co-owners, a campaign with samples, a test with subjects) must work even when the creator names
someone else as owner or PI, in which case the new row's update rule does not hold for them. Directus
inserts the parent first and then runs the junction's create filter inside the same transaction, so
when the update rule refuses, the hook asks the database whether that parent row was **inserted by
the current transaction and never updated since**:
`SELECT <key> FROM <parent> WHERE <key> = $1 AND xmin = pg_current_xact_id()::xid AND version = 1`
on `context.database` (the request's transaction). `xmin` alone is the id of the transaction that last
*wrote* the row, so it also matches a pre-existing row merely updated here (by the request, an FK
action or a trigger); every guarded parent carries the OCC `version` column, which starts at 1 and
which the OCC trigger raises on every update, so `version = 1` keeps only rows inserted here. A match
passes; a row that merely exists, or was updated in this transaction, goes by the update rule, so a
member still cannot attach themselves to a record they did not just make. This is per parent: for
`campaign_samples` the campaign may be new while the sample still needs its own update rule, unless
that sample is new too. A parent created inside a savepoint has the sub-transaction's id and is not
recognised, which refuses (fails closed); Directus does not use savepoints. A parent without the
`version` column would make the query fail and so refuse the write; phase1 asserts that all four guarded
parents (samples, tests, campaigns, projects) have it and its OCC trigger. A payload that nests a parent
with no key has nothing to check and passes (the caller is creating that record). A drift check (`gen_access_rules.py --check`, in
pre-commit, phase1 and pytest) fails when `rules.json` is stale. It guards the Directus API, as
everything here does: SQL imports (`migrate_legacy.py`) are not checked.

**The owner check** (decision 10) is the same hook's second job. `access_rules.json` lists the
records whose update rule is wider than their delete rule under `owner_guards` (the owner column,
the record's primary key and the people key), and `gen_access_rules.py` fails when a ruled collection
has such a pair and no entry, so a new collection cannot forget it. `rules.json` carries each
record's **delete filter** as `ownerGuards`. On `items.update` of one of those collections whose
payload names the owner column, the hook reads the current owners straight from the database, skips
the keys whose owner is not changing (an editor saving the whole form sends the owner back
unchanged), and runs the delete filter as the caller through `ItemsService` for each remaining key,
so a batch update is checked per key and one refused key refuses the batch. Setting an owner on an
ownerless record, clearing an owner and naming a brand-new person all count as changes. Create is
not checked (the creator may name anyone). Admins and internal calls bypass, as for the junctions.

**The filters walk Directus relations.** A filter on `owner_person_id.user_id` only works while
`directus_relations` has the `owner_person_id -> people` row, and an alias such as `co_owners` or
`projects.operations` needs its relation and a `directus_fields` row. The `configure_*.sql` scripts
delete and re-insert relations, and once removed those (the owner relations of samples, operations,
tests and campaigns, `campaign_samples.campaign_id`, the campaign alias fields), so every filter
failed after a re-run. The scripts now keep them, migration 141 inserts any that are missing and
stops (RAISE) when a relation points elsewhere or an alias name is taken, and phase1 resolves
**every path of every rule** against the metadata after the migrations and again after running
`configure_all.sh`'s scripts in a rolled-back transaction (`gen_access_rules.py --resolve`).

Two schema changes make the filters expressible:

- **`physical_samples.co_owners` was a legacy TEXT column and, at once, the Directus M2M alias
  over `sample_co_owners`.** A filter on `co_owners._some.user_id` is ambiguous with a real column
  of that name. A migration renames the TEXT column to `co_owners_legacy` (when it exists; the
  production snapshot no longer has it).
- **`projects` had no aliases for what belongs to it.** The relations `physical_samples.project_id`,
  `manufacturing_operations.project_id` and `test_sessions.project_id` → `projects` gain the hidden
  aliases `samples`, `operations` and `sessions`, which the project read rule needs for "owns or
  co-owns a sample in it" and "owns an operation or test in it". Directus needs a restart or a
  cache clear to pick the aliases up.

### Paths that bypass Directus permissions, and what each does

| Path | Under this ADR |
|---|---|
| `d1-trace` endpoint | Already correct: SQL functions find ids, then every record is re-read through `ItemsService`. Unreadable relatives show as "N not visible to you" |
| `d1-report` endpoints | `ItemsService` checks, then root-knex `v_*` views only for ids shown readable. The views also join `projects`, so the sample report blanks `project_code`, `project_name` and the document number unless the caller can read that project (a record can be visible through its sample or campaign while its project is not). The operation and test reports read the project through `ItemsService` and were already correct |
| `project_rollup` (cache table read by `d1-project-items`) | Lab Member read is limited to the project's PI and investigators. The Explorer project page reads the real collections instead |
| Ask-DB (`llm_readonly` Postgres role) | **Unchanged: known gap** (below) |
| `directus_files` / `/assets` | Unchanged: known gap (below) |
| Machine users (Operator / Researcher / Administrator roles, `core/roles.json`) | Unchanged: crawler, workers and equipment nodes need everything |

## Known gaps (accepted)

- **Ask-DB.** The `llm_readonly` role (ADR-0009) reads every lab table, so a question typed into
  Ask-DB can return rows the asking user cannot open elsewhere. The owner accepted this for now.
  Revisit by restricting Ask-DB to Lab Admins, or by a scoped mode (the "access table" in
  "Alternatives considered" is the escape hatch). Not changed here.
- **Secondary samples of a multi-sample test.** Tests are matched through the derived primary
  `test_sessions.sample_id` (migration 139: the first sample of the `test_sessions_subject`
  junction). A co-owner of only a *secondary* sample of a test cannot see that test, unless they
  also own it, own its campaign or are PI or investigator of its project. The polymorphic
  `subject` alias cannot be traversed cheaply in a filter.
- **`directus_files` is unchanged.** Any member can read any file, and `/assets/<id>` serves the
  bytes. The Phase 9 export-control item covers it.
- **Create is filtered only for the four visibility junctions.** Directus ignores item filters on
  create; the guard hook (decision 5) closes the junctions, and only on the Directus API. Other
  create paths (a SQL import, `migrate_legacy.py`) are not checked, and neither is a record's own
  foreign key: a member who sets a sample's, operation's, test's or campaign's `project_id` to a
  project they cannot read (by API, the Data Studio picker lists only readable projects) can then
  read that **project row** (name, code, description), never its samples or other records, because
  owning something in a project is one of the ways to read the project. The same holds for
  `campaign_id` pointing at a campaign they cannot read: it makes the *record* readable to that
  campaign's owner, not the campaign to them.
- **Create of child rows is unfiltered, by name.** Besides the four guarded junctions, these child
  collections have an unfiltered create (their read, update and delete do follow the parent):
  `sample_genealogy`, `sample_stock_provenance`, `sample_data_files`, `operation_data_files`,
  `session_data_files` and `machining_force_analysis`. A member can therefore attach a row to a
  sample, operation or test they cannot update (a file link, a genealogy edge, a force analysis).
  No read is gained by doing so: the rows follow the parent's read rule, and the member's own
  involvement filters do not look at them. They are not guarded because machine users (crawler,
  workers, equipment nodes) write some of them, and a guard keyed on the parent's update rule
  would refuse those.
- **`campaign-inherit` reads campaigns with the root connection.** An operation or test created
  with another person's `campaign_id` (one the member cannot read) inherits that campaign's
  `project_id` when it names none, and so makes that **project row** readable to the member (owning
  an operation in a project is one of the ways to read the project). It is the same accepted gap as
  a hand-typed `project_id` above: the project row only, never its samples or other records.
- **People need a `people` row.** A member without a `people` row linked by `user_id` owns
  nothing, because the hook cannot fill the owner, and sees only what others share with them. A
  member can create their own row (no login, or their own) but only an admin can link or relink a
  login.
- **Records with no owner.** Legacy rows with a null `owner_person_id` are visible only through
  their project, campaign or co-owners. The migration prints how many exist, so they can be
  assigned before members rely on the filter (`scripts/transfer_sample_ownership.py`).
- **"Belongs to the project".** A sample, operation or test can name its project directly or only
  through its campaign; nothing copies the campaign's project onto it (only the `d1-project-inherit`
  form interface does). The read rules cover both: the record's own `project_id` and its campaign's
  project (decision 7). Only the owner of an operation or test, not an operator who co-owns just its
  sample, makes a project readable through that record.

## Alternatives considered

- **A Postgres access table** (`record_access(user_id, …)` kept up to date by triggers, with a
  Directus relation that the filter checks with `_some`). The filters become trivial and the
  same table could scope Ask-DB and a future FastAPI layer (ADR-0002). Rejected for now: it needs
  a trigger on every involvement column, one nullable column per collection (Directus relations
  cannot be polymorphic), and a backfill, before anyone sees a benefit. It stays the escape hatch
  if the filters get slow or Ask-DB needs scoping.
- **Postgres row-level security.** Directus connects as one database user through a pool, so RLS
  would depend on a per-request setting like `d1.actor_identity`, set by the `actor-identity`
  hook. That is fragile across pooled connections and invisible to Directus. Rejected.
- **Per-project roles.** Already rejected in ADR-0005: the number of roles grows with every
  project.
- **A Lab Technician policy that reads all samples** for rig operators. Rejected by the owner
  (decision 1): co-ownership gives the operator exactly the samples they work on.
- **Filter in the UI only** ("my things" by default, everything still readable). Cheap and
  harmless, but not a restriction, so it does not meet "sees only what they are authorised on".

## Consequences

- Lists, counts, dashboards, the Explorer pages, `d1-trace` and `d1-report` all narrow to the
  user's records automatically, because they all read as the user.
- Counts on Home become "yours", not "the lab's". A lab-wide figure would need an admin view or a
  dedicated endpoint.
- Relational filters add subqueries to every Lab Member read. They are fine at lab scale (hundreds
  to thousands of samples). `people.user_id` is unique, and the migration adds the missing indexes
  on the filtered FK and junction columns.
- Operators need to be added as co-owners of a sample before they can record on it. The Force App
  save path creates the operation row as the signed-in user, who becomes its owner, so it keeps
  working; recording on a sample the operator cannot read is not possible, by design.
- Any new collection holding lab data needs a rule in `scripts/access_rules.json` and a migration.
  CONTRIBUTING and the `db-migration` skill say so.
- Live verification needs a real Directus with two test users; it is in
  `docs/runbooks/physical-test-backlog.md`.

## Verification

- `tests/phase1_schema.sh`: the Lab Member permission rows carry exactly the generated filters,
  validation and fields, every Lab Member row is listed in `access_rules.json`, reference
  collections stay unfiltered, the audit log has no Lab Member grant and `people` cannot be relinked,
  the script block and the hook's `rules.json` have not drifted, every rule path resolves against
  the Directus metadata after the migrations and after the configure scripts, and migration 141
  applies, applies again, reverses to **exactly** the rows it started from, and refuses relations
  that point elsewhere.
- `tests/scripts/test_access_rules.py`: the generator's output, the script block, the rules'
  invariants (PI reach, project read, people rows, a guard for every junction a rule goes through)
  and the path resolver.
- `core/extensions/d1-default-owner/index.test.mjs`: the hook defaults the owner on samples,
  operations, tests and campaigns, and the PI on projects.
- `core/extensions/campaign-inherit/index.test.mjs`: both hooks run in load order on a campaign with a
  `project_id` and on an operation and a test with a `campaign_id`; the creator is the owner, the
  project, equipment and material still inherit, and an owner named in the payload is kept.
- `core/extensions/d1-access-guard/index.test.mjs`: creates and parent-key updates of the four
  junctions are refused without the right (campaign_samples: campaign and sample, also when only one
  key is repointed), allowed with it,
  admins and internal calls bypass, and the read runs as the caller. Owner changes on a sample,
  operation or test: refused for a co-owner, allowed for the owner and for an admin, a payload
  without the owner field or with the unchanged owner is not checked, batch updates are checked per
  key.
- `core/extensions/d1-report`: the sample report blanks projects the caller cannot read.
- Physical backlog: as user A (owner) and user B (unrelated), each rule above is visible to A,
  invisible to B, and reachable by B after B is added as a co-owner or investigator.

## References

- ADR-0002 (Directus as a swappable adapter), ADR-0005 (RBAC structure; Phase 9 row filter),
  ADR-0009 (Ask-DB read-only role)
- `scripts/access_rules.json`, `scripts/gen_access_rules.py`, `scripts/configure_users_and_policies.sql`,
  `core/roles.json`
- `db/migrations/20260703000060_people_table.sql`, `20260703000061_people_repoint.sql`,
  `20260703000062_people_directus_meta.sql`, `20260622000029_sample_co_owners.sql`,
  `20260623000030_project_investigators.sql`, `20260710000087_campaign_redesign.sql`,
  `20261007000139_test_sessions_primary_subject_sync.sql`
- `core/extensions/d1-default-owner`, `d1-access-guard`, `d1-trace`, `d1-report/src/access.js`
- [Explorer pages spec](../superpowers/specs/2026-10-06-explorer-pages-design.md)
