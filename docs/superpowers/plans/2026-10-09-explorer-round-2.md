# Explorer pages, round 2: fixes, then layout, access, frequently used and lineage graph

Started 2026-10-09. Coordinator: the main session. Workers: Sonnet, one worktree each
(`.claude/worktrees/agent-*`). Reviewer: Opus, read-only, before any merge.

## Resume here (written 2026-10-09 when the session ran out)

Read this section first, then the Status table. Nothing is pushed anywhere.

**In flight when the session ended**
- **F2, the form fix.** A Sonnet worker was writing migration
  `20261009000143_restore_inline_param_field_meta.sql` and its regression test in worktree
  `.claude/worktrees/agent-fieldmeta` (branch `fix/restore-inline-param-meta`). It commits after
  each piece and was told NOT to apply anything. Check `git -C .claude/worktrees/agent-fieldmeta
  log --oneline e100e65d..HEAD` and `status --short`. If it did not finish, relaunch a Sonnet
  worker on that worktree with the same brief (the brief is in this plan's "Root cause of the
  broken forms" section plus: idempotent, touch only rows it owns, do not revert migration 126's
  `d1-owner-picker`, add the checks to `tests/phase1_schema.sh`, dry-run inside BEGIN / ROLLBACK
  only).
  Then: Opus review (migration-review skill) -> back up `directus_fields` and `directus_relations`
  (`pg_dump -t`) -> apply the migration to the live database -> `docker restart
  d1-database-directus-1` -> check `/admin/content/manufacturing_operations/+` shows the parameter
  fields grouped and conditional, and that an Operation page reads "Cutting speed 1,932.1 m/min".
  **The maintainer has approved applying it.** Never run `configure_all.sh` or
  `configure_directus.sql` on the live database.
- **The last four F1 fixes are built in the main checkout but not loaded.** They load at the next
  Directus restart (the one F2 needs).

**Next, in the order the maintainer agreed**
1. **N1: navigation and simple index pages.** Design first (brainstorming -> spec -> the
   maintainer's review). Decided already: the head reads, finds and navigates; create and edit are
   Directus's own form, **pulled in as an embedded frame** once the head is standalone (inside
   Directus today it stays `EditDrawer`). Index pages are deliberately simple: search and a few
   fixed filters (project, campaign, status) and an "Open in Data Studio" link; no column picker,
   no saved views.
2. **L1: build rail and panels.** Spec approved. Write the implementation plan, get it reviewed by
   the maintainer, then one Sonnet worker for the kit (L1a) and one per page group, then Opus
   review, then the coordinator's live check.
3. **A1: access dialog**, after the permissions work on `feat/ownership-identity-cleanup` lands.
4. **U1: frequently used**, then **G1: lineage graph** (and retiring `d1-lab-dashboard`).

**How the maintainer likes to work (learned this session)**
- Show mockups as an HTML page in the session folder (it opens in the Browser pane); the inline
  chat widgets did not reach them. Mockups made so far, in the session folder
  `C:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database`: `layout-options.html`,
  `layout-counts.html`, and a copy of the rail spec.
- They answer numbered questions in plain chat. Process they asked for: plan, fix, debug and
  simplify with Sonnet workers, then review with Opus.
- Open, lower priority: 16 extensions have source newer than their build (listed below);
  Directus' own buttons need a dark-theme primary in Settings (`theme_dark_overrides`);
  `campaign-inherit/index.test.mjs` imports a missing `d1-default-owner/index.js`;
  "At a glance" wraps its sixth tile at 1440px (fold into L1e).

## Where things are

- **Base branch:** `feat/explorer-restyle` (worktree `.claude/worktrees/explorer-restyle`), cut from
  `feat/ownership-identity-cleanup` at `e100e65d`. Its first commit, `ee5b989e`, is the restyle of
  the Explorer pages (45 files in `packages/d1-ui`, `core/extensions/d1-home` and the physical-test
  backlog). Nothing is pushed.
- **The main checkout** (`D:\...\D1-Database`, branch `feat/ownership-identity-cleanup`) still holds
  the same 45 files as uncommitted edits, next to someone else's staged work. Directus mounts
  `core/extensions` from the main checkout, so that is where a build has to land to be seen live.
  Do not switch its branch.
- **To see a stream live:** copy the stream's changed files from its worktree over the main
  checkout's, run `npm run build:extensions` there, then `docker restart d1-database-directus-1`
  (about 15 s; batch restarts). Workers never do this; the coordinator does, after review.

## Status

| Stream | What | Worktree | Branch | State |
|---|---|---|---|---|
| R0 | Restyle (PageShell, tokens, Section, DataTable, RecordCard) | `explorer-restyle` | `feat/explorer-restyle` | committed `ee5b989e`, live in main checkout, not reviewed |
| F0 | Print labels: rebuild `d1-report` (its build predated the `/labels` route) | main checkout | none (build only) | done 2026-10-09, `/d1-report/labels` renders |
| F1 | Home tiles, Projects count, uncoded-operation label, Test tables, dark accent token, un-stretch | `agent-fixes1` | `fix/explorer-fixes-1` | **merged** into `feat/explorer-restyle` (`eeb2594b`) after two Opus reviews (no blocking findings left; 296 kit tests). Live in the main checkout except the last four commits, which are built and load at the next Directus restart |
| D1 | Root cause of the broken "Log an operation" form (read-only) | none | none | done 2026-10-09: see "Root cause of the broken forms" |
| F2 | Restore the lost field metadata (fix for D1), as migration `20261009000143_restore_inline_param_field_meta.sql` | `agent-fieldmeta` | `fix/restore-inline-param-meta` (from `e100e65d`) | **approved by the maintainer**; a worker is writing the migration and its regression test; then Opus review; then the coordinator backs up `directus_fields` / `directus_relations`, applies it and restarts Directus |
| L1 | Record-page layout: sticky rail beside panels, dense label/value lists | to do | to do | **spec approved 2026-10-09** (`docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md`). Next: write the implementation plan (superpowers:writing-plans), have the maintainer review it, then workers. Its clickable counts need N1's index pages |
| A1 | "Who has access" dialog on each record page (Google Drive "Manage members" style); the owner really adds and removes people | to do | to do | direction settled (answers below); depends on the permissions work in progress on `feat/ownership-identity-cleanup`; design not started |
| U1 | Per-user "frequently used" panel on Home: two short lists, pages and actions, and records | to do | to do | settled: ranks both, stored on the server per user (needs a small table and a migration); design not started |
| G1 | Lineage graph rebuilt on a modern open-source graph library; retire `d1-lab-dashboard` | to do | to do | design not started |
| N1 | Explorer navigation of its own and index pages (samples, operations, tests, campaigns), so every page is reachable without the Data Studio; editing keeps using the Directus form | to do | to do | next to design (proposed order: N1, then L1 build, then A1, U1, G1) |

## Decisions so far (maintainer, 2026-10-09)

- Workers branch from a committed base in a worktree; the main checkout's branch is left alone.
- The field-config fix is dry-run first, then approved by the maintainer before it touches the
  live database.
- The Dashboards module (`d1-lab-dashboard`) is retired. Its lineage graph is rebuilt on a modern
  existing GitHub project instead of being dropped.
- "Ask the database" is hidden from Home for now (the module stays).
- Record pages get **option C, "rail and panels"**: a sticky side rail (identity, actions, key
  facts, access, page contents) beside a main column that keeps its panels, with tiles replaced by
  a dense label/value list. Chosen from three mockups of the same operation (rail + flat sections,
  dense panels with no rail, rail + panels).

## Findings that shape the work

- **57 of 101 fields on `manufacturing_operations` and 60 of 168 on `test_sessions` have no
  `directus_fields` row** (every inline parameter column). The form shows them ungrouped at the top,
  and the Explorer pages fall back to the column name for the label and lose the unit
  ("Cutting speed m per min 1,932.1" instead of "Cutting speed 1,932.1 m/min"): `params.ts` reads
  both from the field definitions. `scripts/configure_inline_params.sql` registers them.
- **Seventeen extensions have source newer than their build** (only `d1-report` has been rebuilt).
  Not rebuilt on purpose: it would put months of unbuilt source live at once. List:
  d1-archive-links, d1-ask-db, d1-bug-report, d1-edge-new-toggle, d1-file-link, d1-force-crawler,
  d1-geometry-preview, d1-machine-picker, d1-material-inherit, d1-operation-code, d1-owner-picker,
  d1-process-category, d1-project-inherit, d1-report-button, d1-sample-code, d1-test-category.
- **Dark theme:** the lab's dark theme is `Directus Default` with no overrides, so its primary is
  the project colour `#18222F` on a `#0d1117` ground. F1 gives the kit an accent token; Directus'
  own buttons need a dark primary in Settings (`theme_dark_overrides`), which is the maintainer's call.
- **`campaign-inherit/index.test.mjs` fails** before any of this work: it imports a missing
  `d1-default-owner/index.js`.

## Verification without writing to the database

Used on 2026-10-09 and worth reusing:
- Dark theme: in the browser console, set `userStore.currentUser.appearance = 'dark'` on the app's
  pinia store. In memory only; a reload restores it.
- A state the data does not have (a test session, "My work" with records): add a request
  interceptor to the app's axios instance (`app._context.provides.api`) that strips a filter or
  answers a fixed id with a stub. Navigate with the app's router so the page does not reload.

## Root cause of the broken forms (D1, 2026-10-09)

`scripts/configure_directus.sql` was run on its own on the live database some time between
2026-07-05 and 2026-09-30. Its blanket `DELETE FROM directus_fields` (line 306) removed every field
row of the collections it owns, and `configure_inline_params.sql` was not run afterwards, so the 56
inline parameter columns of `manufacturing_operations` and the 60 of `test_sessions` have had no
field row since. The migrations' own field metadata was replayed by hand afterwards (the recovery
in the script's STALE BASELINE header); the inline parameters were not. Evidence: one contiguous
block of `directus_fields` ids in that script's INSERT order, and no unapplied migration (162 of 162).

**Do not run `configure_all.sh` or `configure_directus.sql` to fix it:** the first file wipes the
migrations' metadata again and reverts migration 126's `d1-owner-picker` interface.

The fix, dry-run clean in a rolled-back transaction (one transaction, `directus_fields` only,
about 122 rows added, then a Directus restart):
1. `scripts/configure_inline_params.sql` (without its BEGIN / COMMIT)
2. `scripts/configure_field_presets.sql` (without its BEGIN / COMMIT)
3. the `migrate:up` part of `db/migrations/20260722000101_fast_op_form_groups.sql`
4. the `migrate:up` part of `db/migrations/20260723000102_fast_recipe_field_dedup.sql`
5. `scripts/configure_sample_prep.sql` lines 120-125 (`source_recipe_id`, `prep_steps`)
6. `scripts/configure_operation_files.sql` lines 26-27 (`data_file_links`)
7. `scripts/configure_project_rollup.sql` lines 21-22 (`projects.rollup`)

Still to decide: land it as a migration (recommended: tracked and repeatable) or run it once by
hand; add the missing `directus_relations` row for `manufacturing_operations.source_recipe_id`;
recover the handful of other fields with no row (`Machine_Operators.photo`, three
`manufacturer_id`s, `manufacturing_methods.process_category`, three `raw_stock_lots` columns),
possibly from `directus_revisions`.

What brings it back: `scripts/configure_all.sh:23`, `scripts/configure_directus.sql:306`,
`scripts/configure_inline_params.sql:16-18` (its `sintering_%` delete also removes migration 101's
two group rows), and `docs/runbooks/physical-test-backlog.md` lines 23 and 53, which tell testers
to run those scripts. A regression check: every column of the two collections has a
`directus_fields` row, every `directus_relations.one_field` has its alias row, every
`directus_fields."group"` points at an existing row.

The dry runs advanced `directus_fields_id_seq` from 12690 to 13048 and changed no rows.

## Maintainer's later instructions (2026-10-09)

- The lineage graph is rebuilt "using a modern existing GitHub repo" (stream G1).
- The inline mockups did not reach the maintainer; layouts are shown as a page instead.

## Maintainer's answers (2026-10-09, later)

1. **Rail on the left.**
2. **The sample drawing goes in the rail.**
3. Counts in the rail or as a tile row on Project and Campaign pages: "not sure, show me". Shown as
   `layout-counts.html` (both variants of the Project page). Awaiting the choice.
4. **"People on this record" is left out** of the rail until the access view (A1) is designed.
5. **Apply the form fix** (stream F2).
6. **Frequently used: per user, across machines** (stored on the server). Whether it ranks pages
   and actions, records, or both was not answered; the coordinator's recommendation is both.
7. **Access view: the full list for the owner, modelled on Google Drive's "Manage members"
   dialog** (the maintainer sent a screenshot): one row per person with avatar, name, email and a
   role, and a field to add people.

**New direction:** "this head to the headless Directus will eventually live on its own webpage,
rather than bolted as extension of Directus as is now. This means we need proper navigation setup
so the user can reach all pages designed." Stream N1. Consequences to design for:
- a navigation that belongs to the Explorer and reaches every page, not the Directus module bar;
- Explorer index pages for the lists that today open a Data Studio collection (samples,
  operations, tests, campaigns), and a way to find a record (search);
- kit code that does not depend on Directus-only components where there is a choice, with the rest
  behind one seam so a shim can replace it, as the force app did (`apps/force-app/web`).

## Maintainer's answers (2026-10-09, third round)

- **Frequently used ranks both**: the pages and actions a user uses most, and the records they
  open most. Stored per user on the server (answered earlier).
- **Counts go in the rail and are clickable** (variant 1 of `layout-counts.html`).
- **Access:** "a non owner shouldn't even see the operation or sample in the first place.
  permissions is something being worked on." So everyone who can open a record is on its access
  list by definition, and the dialog needs no separate read-only mode for outsiders. **"Add
  people" really grants access** (it writes the co-owner / investigator links), for the owner.
  A1 therefore waits on the permissions work (ADR-0011, `scripts/access_rules.json`, the
  uncommitted edits on `feat/ownership-identity-cleanup`) and must be built on its rules, not
  beside them.
- **Standalone head, and its limit:** "The issue here is ultimately replication. We are slowly
  building a fully fledged head interface. I am ok, to edit forms, to just pull in the directus
  form." The head is for reading, finding and navigating; **create and edit forms are Directus's
  own, pulled in, not rebuilt** (today: `EditDrawer` with the collection's `v-form`). The same
  test applies to everything new: do not rebuild what Directus already does well (forms, the
  filter builder, bulk edit, export, admin); link to it or embed it.

## Maintainer's answers (2026-10-09, fourth round)

- **"embedded frame for pull in directus"**: when the head is standalone, create and edit open
  the record's Directus form in an embedded frame.
- **"approve rail and panels"**: the L1 spec is approved.
- **"table is ok"**: the division of work is agreed. The head shows a record as a readable page,
  navigates between related records, finds a record (a simple list with search and a few fixed
  filters) and draws the plots Directus cannot. Directus keeps create and edit forms, the filter
  builder, bulk edit, export, admin, users and permissions.
