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
| F1 | Home tiles, Projects count, uncoded-operation label, Test tables, dark accent token, un-stretch | `agent-fixes1` | `fix/explorer-fixes-1` | in progress |
| D1 | Root cause of the broken "Log an operation" form (read-only) | none | none | in progress |
| F2 | Re-apply Directus field config (fix for D1) | main checkout | none (database) | waiting for D1, then the maintainer's approval |
| L1 | Record-page layout: rail and/or flat sections, density | to do | to do | design: maintainer choosing between three mockups |
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
