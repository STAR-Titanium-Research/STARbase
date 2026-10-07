# Explorer pages: a custom front end over Directus

**Date:** 2026-10-06
**Status:** Implemented 2026-10-07 (PR pending); access restriction (ADR-0011) not built. Plan:
[`plans/2026-10-06-explorer-pages.md`](../plans/2026-10-06-explorer-pages.md).
Access rule: [ADR-0011](../../adr/0011-row-level-visibility.md) (proposed, not built: the pages
show what the signed-in user's role may read today).

## Why

Researchers find the Directus Data Studio heavy: generic list layouts, long forms, and related
records shown as tables of ids. Custom pages already exist (Home, the lab dashboards, the sample
timeline, the campaign overview), but each one links straight back into `/content/<collection>/<id>`.
Two of the best views (campaign overview, project items) also only exist as widgets *inside* the
Data Studio form. So every click lands the user back in the Data Studio.

Target workflow (maintainer, 2026-10-06):

1. A user logs in and lands on a clean Home that shows **their** work.
2. They can view projects, campaigns, samples, operations and tests as **formatted pages**, not
   forms, and move between them without touching the Data Studio.
3. They see only what they are authorised on (owner, co-owner, or through a project or campaign).
   That is enforced by permissions (ADR-0011), not by these pages.
4. Editing reuses the existing Directus forms (no form is rebuilt without a reason), surfaced
   from the page.

## Goals

- One record page per main entity, all linking to each other: **Projects index, Project, Campaign,
  Sample, Operation, Test session**.
- Home becomes "my work": my projects and campaigns, recent samples, and "needs attention" tiles
  (closes UX review D10).
- Every link on our custom pages goes to an Explorer page. "Open in Data Studio" stays as a
  secondary action.
- Edit from the page in a drawer that renders the collection's normal Directus form, then return to
  the page.
- Everything reads through `/items` as the signed-in user, so permissions apply with no new endpoint
  (one exception: the existing `d1-trace`).

## Non-goals

- Rebuilding create/edit forms. "Register sample" stays the one custom create flow; the rest open
  the Directus form.
- Replacing the Force, FAST, Diagnostics or Ask-DB pages. The Explorer links into them.
- Hiding the Data Studio. Directus 11 has one global module bar and cannot hide a module per
  role, and taking away `app_access` would also remove the custom pages. The aim is that nobody
  *needs* the Data Studio.
- Lab-wide statistics for non-admins once ADR-0011 is live (counts become "yours").
- Phone layouts (UX review D15). Pages should not break on a tablet, but nothing more is
  designed for it.

## Architecture

### Where the pages live: the `home` module

The pages are **child routes of the existing `d1-home` module** (`id: 'home'`), not a new module:
the user has one place to land, and the shared components live in one extension.

| Route (`/admin` + …) | Page |
|---|---|
| `/home` | Home: my work, needs attention, quick actions (rework of `home.vue`) |
| `/home/projects` | Projects index |
| `/home/projects/:id` | Project |
| `/home/campaigns/:id` | Campaign |
| `/home/samples/:id` | Sample |
| `/home/operations/:id` | Manufacturing operation |
| `/home/tests/:id` | Test session |
| `/home/register-sample`, `/home/people` | Unchanged |

The module is added **first** on the module bar (`directus_settings.module_bar`, a migration
following `20260711000090_fast_module_bar.sql`). The Data Studio (`content`) moves after the
dashboards. Whether Directus 11 lands a user on the first module after login, or on `/content`,
is checked in stage 1. If it does not, a small `app.after` redirect is out of scope; document it
and move on.

### Shared kit: `packages/d1-ui`

There is no shared UI code across extensions today: styles are copied per view, and `geometry.ts`
is vendored into three extensions with a sync check. A new **workspace package**
`packages/d1-ui` (same pattern as `@d1/force-plotting`: consumed as source, vitest-tested, listed
in the root `package.json` workspaces) holds:

- **Pure logic, tested with vitest:**
  - `recordRoute(collection, id)`: collection → Explorer route, falling back to
    `/content/<collection>/<id>` for anything without a page;
  - the campaign roll-up, moved from `d1-campaign-ops/src/overview.js`;
  - the campaign **matrix builder**;
  - **activity binning** for sparklines;
  - status vocabularies and colours (test lifecycle from `20260619000013_status_vocabulary.sql`;
    force `status` and `diag_status`).
- **Components:**
  - `RecordHeader` (code, title, kind chip, status, owner, actions);
  - `StatTile`, `StatusBadge`, `RecordLink`, `Section` (title, count, collapsible, empty state);
  - `LoadState` (loading / empty / error with text);
  - `KeyValueGrid`, `ProgressBar`, `Sparkline`;
  - `EditDrawer` (below).
- **Composables:** `useItems` (the `useD1Items` wrapper from `d1-lab-dashboard`, moved) and
  `useRequestGate` (latest-request-wins, moved).

`d1-home` consumes it first. `d1-lab-dashboard` and `d1-campaign-ops` switch to importing the
moved code in the same stream, so nothing is duplicated. Their Data Studio widgets stay, as thin
wrappers. Styling follows Directus theme variables (`--theme--*`) so light and dark both work.
Chart colours follow the repo's `dataviz` skill palette.

### Editing: `EditDrawer`

"Edit" on a page opens a `v-drawer` rendering Directus's own `v-form` for that collection:

- fields come from the app's fields store (`useStores().useFieldsStore()`);
- the record is loaded through `/items`, and changed fields are saved with `PATCH /items/<c>/<id>`;
- the page refreshes on save.

Because `v-form` renders the configured interfaces, the custom field widgets work unchanged: sample
code, machine picker, material and project inherit, geometry preview. OCC needs no special handling:
`occ_update_trigger_function()` only increments `version`. The drawer still re-reads `version`
before saving and warns if someone else saved in between.

**Fallback.** If `v-form` or the fields store turns out not to be usable from a module extension
(checked first thing in stage 1), "Edit" opens `/content/<c>/<id>` in the same tab. The result is
then recorded in this spec.

**Finding (stage 1, 2026-10-06): the drawer is possible, so the fallback is only a runtime guard.**
Checked against the Directus source (`main`, which `directus/directus:11` tracks) and the installed
`@directus/composables`, because no live Directus was available:

- `app/src/components/register.ts` registers `VForm` and `VDrawer` with `app.component(...)`, so
  `<v-form>` and `<v-drawer>` resolve in any extension template, the same as `v-button` and `v-icon`.
- `app/src/composables/use-system.ts` provides `useFieldsStore` (with the user, collections,
  permissions and other stores) through `STORES_INJECT`, and `useStores()` from
  `@directus/extensions-sdk` returns it. `@directus/composables`' own `useCollection` calls
  `useFieldsStore().getFieldsForCollectionSorted()` the same way.
- The Data Studio item page itself renders `<v-form v-model="edits" :fields :initial-values
  :primary-key>`, and `v-form` provides `values` to its interfaces, which the d1 interfaces inject.
  `EditDrawer` uses the same props, so those interfaces see what they see in the Data Studio.

`EditDrawer` therefore renders the real form. If `v-form` or the fields store is ever missing (a
Directus upgrade renames it), the drawer does not open and the page navigates to
`/content/<c>/<id>` instead. Not provable without a live Directus, so it is a backlog item: the
form shows the custom interfaces and saves through them (see the physical test backlog).
Deliberate gaps: the record is read with `fields=*` (relational interfaces fetch their own
related rows), and fields the role may not read are hidden rather than shown disabled.

"New" actions (new operation for this sample, new test, new campaign in this project) open
`/content/<c>/+`. Pre-filling the parent needs a query-to-default mechanism Directus does not
have, so it is out of scope (UX review D7 note).

## Pages

Each page has a header, then sections; empty sections collapse to one line. Every related record
is a `RecordLink`. Data is fetched in parallel, scoped to the one parent, and each list caps at 200
with a "show all" link.

### Home (my work)

- **Greeting and quick actions:** kept, but trimmed to the things a researcher does: register
  sample, log operation, ask the database, print labels, dashboards.
- **My work:** projects where I am PI or investigator, campaigns I own, and my 10 most recently
  updated samples, as cards.
- **Needs attention:** counts that link to a filtered list:
  - force analysis in `error` on my operations;
  - test sessions `failed`;
  - operations with force files still `pending`;
  - samples with no owner (admins only).
- **Recent activity:** kept, now linking to Explorer pages.

"Mine" means `owner_person_id.user_id = $CURRENT_USER` or co-owner. These are explicit filters,
so Home is personal even before ADR-0011 is live.

**Deviation (E3, 2026-10-07).** The Data Studio cannot be opened on an arbitrary filter from a
link (only on a saved bookmark), and three of the four tiles have no bookmark. So a tile opens the
matching records (first 10, each a link to its Explorer page) right under the tiles, with "Open
the full list in the Data Studio" for the rest. The counts use the same filters
(`packages/d1-ui/src/mine.ts`). A user whose login has no `people` row sees a notice instead of
silently empty owned lists.

### Projects index

A card grid with code, name, PI, status, dates, campaign count and sample count, plus a sparkline
of operations and tests per week (last 26 weeks). Filters: *my role* (all / PI or investigator /
PI / investigator) and status (the project's `is_active`). Search by code or name.

**Deviation (E3).** The sparkline bins on the client (`packages/d1-ui/src/activity.ts`), not with
`aggregate` + `groupBy` on `week()`: the dates are TIMESTAMPTZ, and SQL `year()` and `week()`
disagree at the turn of the year (1 January can be ISO week 53). The pages read only the date and
project id of the rows inside the window, newest first, capped at 5000 per collection, and say so
when the cap is hit. Counts per project do use `aggregate` + `groupBy=project_id`.

### Project

- **Header:** code, name, status, dates, PI, investigators, and Edit / Data Studio actions (no Report).
- **Tiles:** samples, operations, tests and campaigns. These use the one **"belongs to project"
  rule** (below), so they agree with the campaign cards.
- **Campaigns** as cards, each with type, owner, status and a progress bar (the campaign roll-up's
  "analysed n / m").
- **Not in a campaign:** samples, operations and tests with this `project_id` and no campaign.
- **Activity:** the sparkline at full width.
- **Equipment used:** distinct equipment from the project's operations.

**"Belongs to project" (E-final).** Nothing in the database copies a campaign's project onto its
operations, tests or samples, and the campaign pickers used to set only `campaign_id`. So a record
belongs to project P if its own `project_id` is P, or it has none and its campaign's `project_id`
is P (the COALESCE rule of `v_project_rollup`; `projectScope.ts` in the kit builds the filters).
The Project tiles, the activity sparkline, *Equipment used* and the project items view use it.
*Samples* is the one place with a wider rule: the tile counts a sample if its own `project_id` is P
**or** it is in one of P's campaigns (through `campaign_samples`), the same samples the campaign
cards count. The Projects index cannot express either rule in a grouped aggregate, so its sample
count is "samples assigned to the project" (`project_id` only), and its sparkline, which reads
rows, applies the rule exactly. The pickers now also copy the campaign's project onto a record that
has none (never overwriting one, as `d1-project-inherit` does), which makes the two agree for new
data. A record whose own project differs from its campaign's counts for its own project in the
tiles but still shows on its campaign's card.

Reads the real collections (not `project_rollup`, which ADR-0011 restricts). The investigators
are read from `project_investigators` as a separate section, so a role that cannot read the
junction still gets the page. There is no *Report* action yet: `d1-report` has sample, operation
and test reports only.

### Campaign

- **Header:** code, name, type, project breadcrumb, owner, status, dates, default equipment and
  material.
- **Tiles and bars:** the current `CampaignOverview` content (moved into `d1-ui`).
- **Sample × step matrix.** This is the main visual. Rows are the campaign's samples. Columns are
  the campaign's operations, by `pass_code` / sequence, then test types. Each cell is coloured by
  state: none, done, force analysed, diagnostics built, error, or skipped. The error text shows on
  hover and a click opens the record. Wide matrices scroll horizontally with the sample column
  pinned.
- **Lists:** samples, operations and tests, plus the existing pickers (add samples / test
  sessions, assign operations), which are still the right editing tool here.

**Finding (stage 2, 2026-10-07): how the matrix and the shared panel were built.**
- `operation_sequence` is numbered per sample, so a matrix column is "sequence N of process
  category C" (the same step lines up across samples). An operation with no sequence gets its own
  column, labelled with its `pass_code`. Tests share a column per `test_type`.
- `CampaignOverview` and the pickers became the kit's `CampaignWorkbench`
  (`packages/d1-ui/src/campaign/`). The Campaign page shows it with the matrix; the
  `d1-campaign-ops` interface on the Data Studio form is a thin wrapper that shows it without the
  matrix.
- `EditDrawer` gained a `hiddenFields` prop: the page's Edit form leaves out the
  `campaign_operations` panel, which is already in the page body.

### Sample

- **Header:**
  - code, form, status;
  - project and campaign breadcrumb;
  - owner and co-owners;
  - Edit, Print label, Report, QR, Data Studio actions.
- **Overview card:**
  - the **geometry drawing** (`geometry.ts`, the copy already vendored in `d1-home`);
  - material name with the **composition bar**. Its logic moves from `d1-composition-bar` into
    `d1-ui`, and the form interface keeps using it;
  - dimensions, mass estimate, condition, manufacturing method.
- **Life of the sample.** A horizontal timeline strip: stock lot → parents → this sample →
  operations and tests by date → children. It reuses the `d1-trace` response, laid out
  left-to-right with the vertical list as the narrow-screen fallback. Below it is the "N not
  visible to you" marker. **Deviation (E4):** the lineage graph is not drawn inline (that would
  pull the `NodeGraph` cytoscape view into the page bundle); an **Open lineage graph** button
  opens the Lab Dashboard graph centred on the sample (`?sample=<id>`).
- **Operations and tests** as tables with status badges. Each force-measured operation has
  "View forces" (`/d1-force-dashboard?operation=`) and FAST ones have "View FAST".
- **Files:** linked data files and archive paths (the `d1-archive-links` logic).

### Operation

- **Header:** pass code, process category, date, owner, operator, equipment, then the sample
  (workpiece) and campaign.
- **Parameters:** the category's parameter fields as a key–value grid, with units from the field
  suffix. (The `*_params` tables no longer exist: migration 20260623000032 flattened them into
  inline columns, `machining_*`, `sintering_*`, `ht_*` ... on `manufacturing_operations`. The page
  reads the field definitions and keeps the fields whose "show when `process_category` = x"
  condition matches, falling back to the column prefix.)
- **Inputs and outputs:** samples consumed and produced (`produced_by_operations`).
- **Force analysis:** each file's `status` / `diag_status`, error text, and one "View forces"
  button for the operation (the dashboard opens an operation, not a file; the diagnostics are a
  badge, with no separate link). FAST operations show the imported run and "View FAST". Cutting
  metrics stay in the Force dashboard.
- **Files.**

### Test session

- **Header:** test type and category, date, status, owner, operator, equipment, then the sample
  and campaign.
- **Parameters:** the test type's parameter fields (inline `tensile_*`, `hardness_*` ... columns on
  `test_sessions`, chosen by the same field conditions as the operation's).
- **Subject:** the sample (or other target) from `test_sessions_subject`, which is where a test
  made through the form stores it. `test_sessions.sample_id` / `insert_edge_id` are a derived
  *primary subject* (migration 139: a trigger copies the first sample and first insert edge of the
  junction into them), so readers that filter on `sample_id` (campaign matrix, reports, lineage,
  timeline) also see form-created tests. A test with several samples is complete only in the
  junction, so the Sample page reads both (`sample_id` or a junction row) in one request.
  The migration's back-fill copies a direct `sample_id` / `insert_edge_id` into the junction only
  for a test with no junction row of that kind and no audit-log DELETE of that very subject, so a
  sample swapped out in the form (the hidden column keeps the old value) is not resurrected.
  **Deleting subjects:** `test_sessions_sample_fkey` is ON DELETE SET NULL, and a BEFORE DELETE
  trigger on `physical_samples` removes the sample from every test's junction (the next sample is
  promoted) and deletes only the tests left with no subject at all (migration 023's "a test belongs
  to its sample", kept for the last sample). A sample delete therefore never destroys a test that
  has another sample or an insert edge (a test that goes is deleted before the sample's junction
  rows are touched, so its audit trail has no stray UPDATE). Deleting an insert edge that a test names is refused by a
  BEFORE DELETE trigger (as `test_sessions_insert_edge_fkey` does for the column), which also stops
  a cutting insert or tool box delete whose cascade reaches such an edge: remove it from the test
  first.
- **Results:** `summary_stats` rendered as a key–value grid, grouped by the namespaced key each
  worker writes.
- **Files.**

## Links

`recordRoute()` is the single mapping. Switched to it:

- `d1-home`;
- `d1-lab-dashboard` (`d1-open` links, `SampleTimeline`);
- `d1-campaign-ops` (overview tables, which are still useful inside the form);
- `d1-project-items` (gains links);
- the Force and FAST dashboards' `openRecord` host callbacks (`DirectusForceDashboard.vue`,
  `FastDashboard.vue`).

**QR labels:** `d1-report`'s `adminRecordUrl()` points new labels at `/admin/home/samples/<id>`
(reports use `/admin/home/operations|tests/<id>`). `d1-report` cannot import the kit, so its
small mapping repeats `recordRoute()`'s table. Printed labels keep working because
`/admin/content/...` still exists. The Sample page has no separate QR button: Print label is the
QR (the label carries it).

**Project items:** `project_rollup` rows carry a hashed `row_id`, not the record id, so
`d1-project-items` reads the project's operations (as the user, in pages, ids only) with their
sample, machine, tool, edge, insert and material, and matches rollup rows to records by recomputing
`row_id` client-side (`md5('operation:' || id)`, `md5('<kind>:' || project || ':' || id)`;
`rollupTargets()` in the kit). Matching by `row_id` and not by code means a shared `pass_code`
cannot link to the wrong operation. Rows it cannot resolve stay plain text.

## Error handling

Every page has explicit loading, empty and error states (`LoadState`), with the error text from
Directus. A missing or forbidden record shows the same "Not found or not visible to you" page
(matching `d1-trace`), with a link back to Home. Stale responses are dropped through
`useRequestGate`.

## Testing

- **vitest in `packages/d1-ui`:** `recordRoute`, the campaign roll-up (existing `overview.js`
  tests move across), the matrix builder (sparse cells, skipped files, several files per
  operation, error precedence), activity binning, and status mapping.
- **CI:** add `packages/d1-ui` to the `force-app-js`-style job (vitest + `vue-tsc`), and **build
  `d1-home`, `d1-lab-dashboard` and `d1-campaign-ops`** in CI. Today only `d1-force-dashboard` is
  built, so a broken import in the others would not be caught.
- **Headless check:** pages rendered against a stubbed `/items` in Chromium for screenshots (as
  `force-app-verify` does for the force app). Live checks go to
  `docs/runbooks/physical-test-backlog.md`: the edit drawer saves through real interfaces,
  module-bar landing, a filtered role sees only its records, and QR labels open the sample page.

## Stages

1. **Kit and Sample page:** `packages/d1-ui`, the router children, `recordRoute`, the
   `EditDrawer` spike, the Sample page, and links switched. Module bar order.
2. **Campaign page** with the matrix; move `CampaignOverview` into the kit.
3. **Projects index, Project page, Home as "my work"** (closes D10).
4. **Operation and Test pages**, `d1-project-items` links, QR target.
5. ADR-0011 permissions (after the owner answers its open questions); can run in parallel with
   2–4 because the pages don't depend on it.
