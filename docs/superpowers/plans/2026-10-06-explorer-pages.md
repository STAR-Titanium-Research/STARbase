# Explorer pages — 2026-10-06

Implements [`specs/2026-10-06-explorer-pages-design.md`](../specs/2026-10-06-explorer-pages-design.md)
and, once the owner has answered its open questions, [ADR-0011](../../adr/0011-row-level-visibility.md).
Delete this plan once the batch has shipped (see `docs/superpowers/README.md`).

**Process.**
- Stream E1 runs first and alone, because every other stream builds on its kit.
- E2–E4 then run in parallel: `directus-ui-implementer` workers (`.claude/agents/`) in worktrees, each fast-forwarded to the merged E1
  first. Workers commit after each step and never push, merge or rebase.
- E5 waits for the owner's answers to ADR-0011's open questions.
- After the streams: an Opus `/simplify` pass, a high-effort Opus review, fixes, local CI
  (`ci-local`, including `pre-commit`), PR, CI green, merge.
- Every check that needs a live Directus goes into
  [`docs/runbooks/physical-test-backlog.md`](../../runbooks/physical-test-backlog.md) in the same
  stream (see `CLAUDE.md`).

## Status

| Stream | Scope | Worktree / branch | State |
|---|---|---|---|
| E1 — Kit and Sample page | spec stage 1 | `agent-a75d68373a9795e38` | merged (`5fbba12`); coordinator fix: co-owner names, admin build docs. Lineage graph and QR action deferred to E4 |
| E2 — Campaign page and matrix | spec stage 2 | `agent-ae4f2e67ae2684b1c` | merged; matrix columns = sequence N of process category (spec note); EditDrawer gained `hiddenFields` |
| E3 — Projects, Project, Home "my work" | spec stage 3 (D10) | `agent-ac65ea5bc992c974e` | merged (`1107cb1`); `directus-ui-reviewer`: 0 blocking, 7 should-fix → E3-fix in `agent-ad01616309859b46c`, merged |
| E4 — Operation and Test pages; links; QR target | spec stage 4 | `agent-a783b7731c3e45aa8` | merged (`277f9fd`); E4-fix (`02f5900`) and E4-mig (`7ba8af3`: migrations renumbered 138/139, sample-delete keeps multi-subject tests, edge delete blocked) merged; origin/main merged (`112abe3`) |
| E5 — Row-level visibility | ADR-0011 | — | waits for owner decisions |
| Final review, CI, PR | all | main checkout | reviews done and fixed (E4-mig2 `292a660`, E-final `67d866c`); ci-local 2026-10-07 all green (pre-commit, smoke, geometry, extension/report/ask-db tests, force-app-web, force-plotting, @d1/ui 225, typechecks, builds, verify_migration, phase1 268 / phase7 16 / phase6 59, full rollback to 0 tables and re-apply). Not run: force-app-verify (only `openRecord` link target changed in force-app-web). PR #133 opened; merge when CI is green |

## E1. Kit and Sample page

Files:
- `packages/d1-ui/**` (new);
- `core/extensions/d1-home/**`;
- `core/extensions/d1-lab-dashboard/src/{composables,views/SampleTimeline.vue}` (switch to the kit);
- a migration for the module-bar order (`db-migration` skill, modelled on
  `20260711000090_fast_module_bar.sql`);
- `.github/workflows/ci.yml`;
- root `package.json` workspaces (add `core/extensions/d1-home` and `core/extensions/d1-lab-dashboard`);
- the database wiki page for Home.

1. **`packages/d1-ui`.** `package.json` (`@d1/ui`, `type: module`, vitest + vue-tsc scripts like
   `@d1/force-plotting`), `src/index.ts`, `recordRoute.ts` with tests, `status.ts` (vocabularies
   and colours) with tests, components `RecordHeader`, `StatTile`, `StatusBadge`, `RecordLink`,
   `Section`, `LoadState`, `KeyValueGrid`, `ProgressBar`. Move `useD1Items` → `useItems` and
   `useRequestGate` from `d1-lab-dashboard`. Theme variables only, no hard-coded backgrounds.
2. **Router children** in `d1-home/src/index.ts` for every route in the spec table. Pages not
   built yet render a placeholder with a Data Studio link, so links never 404.
3. **`EditDrawer` spike.** `v-drawer` + `v-form` with fields from `useFieldsStore()`. If either is
   unavailable in a module extension, implement the fallback (navigate to `/content/<c>/<id>`)
   and write the finding into the spec's Editing section. Either way, record a backlog item.
4. **Sample page** per the spec: header and actions, overview card (geometry from `d1-home`'s
   `geometry.ts`, the composition bar logic moved into `d1-ui` with `d1-composition-bar` importing
   it, or vendored with `sync_geometry.sh`-style checking if the import does not build), the
   horizontal life strip from `/d1-trace/sample/:id` with the vertical fallback, operations and
   tests tables, files. "Not found or not visible" state.
5. **Links:** `home.vue` recent activity and stat cards, and `d1-lab-dashboard`'s `d1-open` links
   and `SampleTimeline`, all go through `recordRoute`.
6. **Module bar:** `home` first, `content` after the dashboards. Down migration restores the
   previous array.
7. **CI:** `npm test -w @d1/ui`, `npm run typecheck -w @d1/ui`, and build `d1-home` and
   `d1-lab-dashboard` in the `force-app-js` job (or a new `directus-ui` job).
8. **Backlog items:** edit drawer saves through real interfaces; landing module after login;
   Sample page against real data, including a sample with hidden relatives.

## E2. Campaign page and matrix

Files:
- `packages/d1-ui/src/campaign/**`: the roll-up moved from `d1-campaign-ops/src/overview.js`,
  with its tests moved to vitest, and `matrix.ts` with tests;
- `core/extensions/d1-home/src/pages/CampaignPage.vue`;
- `core/extensions/d1-campaign-ops/**` (import from the kit, add to workspaces, links via
  `recordRoute`).

The matrix covers:
- rows = samples (from `campaign_samples`, plus any sample referenced by a campaign operation or
  test that is not in the junction, flagged);
- columns = operations by sequence, then test types;
- cell state = worst across files (`error > processing > pending > done > skipped`), with
  `diag_status` as a second marker;
- a pinned first column and horizontal scroll.

The pickers stay as they are.

## E3. Projects index, Project page, Home "my work"

Files:
- `d1-home/src/pages/{ProjectsIndex,ProjectPage}.vue`;
- `home.vue` rework;
- `packages/d1-ui/src/activity.ts` (week binning, with tests) and `Sparkline.vue`;
- the D10 row in `docs/reviews/2026-10-05-ux-utility-review.md`.

"Mine" filters are explicit (`owner_person_id.user_id = $CURRENT_USER`, co-owner, PI or
investigator), so Home is personal before E5. The Project page reads the real collections, not
`project_rollup`.

## E4. Operation and Test pages, remaining links, QR target

Files:
- `d1-home/src/pages/{OperationPage,TestPage}.vue`;
- `packages/d1-ui` `KeyValueGrid` units from field notes;
- `core/extensions/d1-project-items` (links);
- `d1-report/src/*` (`adminRecordUrl` for samples → `/admin/home/samples/<id>`, with tests);
- the `openRecord` host callbacks in `d1-force-dashboard/src/DirectusForceDashboard.vue` and
  `d1-fast-dashboard/src/FastDashboard.vue`.

## E5. Row-level visibility (ADR-0011)

Not started until the owner answers the four open questions in the ADR. Then:
- `scripts/access_rules.json` holds the rules;
- a migration applies them to the Lab Member policy, reports ownerless rows and checks indexes;
- `configure_users_and_policies.sql` applies the same rules;
- `project_rollup` is restricted;
- extend `d1-default-owner` to samples and campaigns;
- the Ask-DB decision;
- tests, the wiki page `roles-and-permissions.md`, and backlog items for the two-user live check.

## Commit trailers

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018vgy42gyM3tMd873o9FouL
```
