# Explorer pages, round 2: fixes, then layout, access, frequently used and lineage graph

Started 2026-10-09. Coordinator: the main session. Workers: Sonnet, one worktree each
(`.claude/worktrees/agent-*`). Reviewer: Opus, read-only, before any merge.

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
| F1 | Home tiles, Projects count, uncoded-operation label, Test tables, dark accent token, un-stretch | `agent-fixes1` | `fix/explorer-fixes-1` | six fix commits `a7b5fde1`..`1387f208`, three refactors `fcee2d20`..`e084ac27`; Opus review done (2 blocking, 10 should-fix); a worker is fixing the findings; not merged, not live |
| D1 | Root cause of the broken "Log an operation" form (read-only) | none | none | done 2026-10-09: see "Root cause of the broken forms" |
| F2 | Restore the lost field metadata (fix for D1), as a migration | to do | to do | dry-run clean; waiting for the maintainer's approval |
| L1 | Record-page layout: sticky rail beside panels, dense label/value lists | to do | to do | direction chosen (option C); spec to write, then the maintainer's review |
| A1 | "Who has access" view on each record page | to do | to do | design not started |
| U1 | Per-user "frequently used" panel on Home | to do | to do | design not started |
| G1 | Lineage graph rebuilt on a modern open-source graph library; retire `d1-lab-dashboard` | to do | to do | design not started |

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
