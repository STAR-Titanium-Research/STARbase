# Process map — edit mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each stream works in its
> own worktree, commits after every step, never pushes, merges or rebases. The coordinator merges.

**Goal:** Build the process map's edit mode: planned/done work, server-kept drafts created in one transaction,
the canvas editor, STARbase's generated form, attach / new from / ＋ pass / templates, deleting planned records.

**Spec:** `docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md` (E1–E21, §4–§9).
ADRs: `docs/adr/0018-starbase-writes-records.md`, `docs/adr/0019-operations-and-tests-can-be-planned.md`.
Glossary: `CONTEXT.md` → "Building on the process map".

**Base branch:** `claude/keen-brahmagupta-nmo9oy` (already contains origin/main and the card tweaks of
`claude/jolly-fermi-us5mb7`: stacks of passes, ＋/−, Reset — read `model/groupBatches.ts`, `nodes/actions.ts`,
`useProcessMap.ts` before touching the map).

## Status

| Stream | Worktree | Branch | State |
|---|---|---|---|
| A — server: migrations, `d1-build`, access guard | agent worktree | `pm-edit/a-server` | reviewed, fixed, **merged** (2026-10-15); migrations renumbered 189–191 |
| B — d1-ui: generated form, index-page picker mode | agent worktree | `pm-edit/b-form` | reviewed, fixed, **merged** (2026-10-15) |
| C — map edit model: draft, history, checks, toGraph, useDraft, work state on the map | agent worktree | `pm-edit/c-model` | reviewed, fixed, **merged** (2026-10-15) |
| D1 — canvas, page wiring, menus, picker, keys | agent worktree | `pm-edit/d1-canvas` | built; reviewed (1 blocking, 12 should-fix); porting onto the socket-rail base + fixes in progress (2026-10-15) |
| D2 — rail/chrome components, My drafts, nav entry | agent worktree | `pm-edit/d2-rail` | reviewed, fixed, **merged** (2026-10-15) |
| E — attach, new from, ＋ pass, templates, delete planned (needs D) | agent worktree | `pm-edit/e-extras` | not started |
| PRs | coordinator | -server → #305 (1/4), -form → #306 (2/4), this branch → #304 (3/4), canvas → part 4 | #305 and #306 **merged**; #304 CI green, in review (2026-10-15) |

## Global constraints

- Commit trailer lines (every commit):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01L4oygaTHCgUFwVogx8zpQt
  ```
- Migrations: re-scan every `refs/remotes/origin/*` for the next number right before creating the file
  (`.claude/skills/db-migration/scripts/next_migration_name.sh`). On 2026-10-14 `183`/`184` are taken on
  `feat/team-ownership`, so (renumbered 2026-10-15 after main took 185 and 188) `20261015000189_planned_work.sql`, `20261015000190_build_store.sql`, `20261015000191_form_condition_fixes.sql`.
- STARbase must keep working before the migration is applied: request `work_state` / `planned_date` only when
  `/fields/<collection>` lists them (the `batch_id` pattern in `loadFamily.ts`). Hide edit mode when
  `GET /d1-build/drafts` 404s.
- The host seam: STARbase pages talk to the API only through `useExplorerHost().api` (no SDK imports, no
  `router-link`, `router.push(`, `window.open(` in `starbase-pages` — use `AppLink`/`openLink`), per
  `directus-ui-conventions`.
- Glossary words in UI text and code names: draft, create, planned, done, socket, wire, container, card,
  attach, new from, duplicate, template, checks, stack of passes. Never "node" for a socket, "save" for create,
  "supervisor" for checks.
- Checks before each commit: UI streams — `npm test -w <pkg>` and `npm run typecheck -w <pkg>` for every
  package touched; server stream — `node --test core/extensions/<ext>/index.test.mjs`, the migration up/down/up
  via the db-migration skill, `python3 scripts/gen_access_rules.py --check`.

## Shared contract (all streams code against this; do not change it without the coordinator)

- `DraftBody` and friends exactly as spec §5.1, in `packages/d1-ui/src/build/types.ts` (stream C creates it;
  A mirrors it in JS validation).
- `d1-build` routes exactly as spec §6 table. Responses:
  - drafts list: `{ data: { id, name, updated_at, summary }[] }`; one draft: `{ data: { id, name, body, version, updated_at } }`.
  - check: `{ data: { checks: { key: string; field?: string; level: 'block'|'warn'; text: string }[] } }`.
  - create 200: `{ data: { created: Record<DraftKey, { collection: string; id: string; code: string | null }>, sampleIds: string[] } }`;
    409: `{ errors: [{ message, extensions: { code: 'CHECKS', checks: Check[] } }] }`; failed write:
    `{ errors: [{ message, extensions: { code: 'WRITE_FAILED', key: DraftKey } }] }`.
  - mark-done body `{ collection: 'manufacturing_operations'|'test_sessions', ids: string[], date?: 'YYYY-MM-DD', personId? }`
    (one transaction) → `{ data: { ids, work_state: 'done' } }`; 409 `CHECKS` as above. mark-planned `{ collection, ids }` likewise.
  - every check carries `code`: GONE, NOT_ATTACHABLE, STALE_VERSION, REMOVE_BLOCKED, PERMISSION, REQUIRED, STRUCTURE, OTHER.
  - templates: `{ data: { id, name, scope, role_id, collection, values, user_id, updated_at, version }[] }`.
- New sample values carry `sample_code` as the template string `{seq}-…` composed by
  `sampleCodeTemplate({ alloyCode, methodCode, date })` from `@d1/ui` (stream C extracts it from
  `register-sample.vue` without changing that page's behaviour).

---

### Stream A — server (`d1-server` side)

**Owns:** `db/migrations/…_planned_work.sql`, `db/migrations/…_build_store.sql`, `core/extensions/d1-build/**`
(new), `core/extensions/d1-access-guard/index.js` + its test, `scripts/access_rules.json` (+ regenerated
output), `tests/phase1_schema.sh` (new sections), `docs/data-dictionary.md` (new columns/tables),
`docs/runbooks/physical-test-backlog.md` (section A items for this stream), `.github/scripts/ci-plan.mjs` only if
the new extension is not already picked up by the extensions/lint jobs.

1. Migration planned work (spec §4.1) + schema test + data dictionary. Commit.
2. Access guard: back-to-planned refused unless owner/admin (spec §4.1) + test. Commit.
3. Migration build store (spec §4.2) + schema test. Commit.
4. `d1-build` scaffold: package.json (like `d1-usage`), route wrapper, drafts CRUD with OCC + tests. Commit.
5. `check` route (server checks: blocking/warn per spec E5, E13; required-for-done from `directus_fields.required`)
   + tests. Commit.
6. `create` route (spec §6.1) using `services.ItemsService` with `{ schema, accountability, knex: trx }` + tests
   (ordering, batches for multi-row operations, rollback naming the failing key, OCC on existing records,
   removals of planned records). Commit.
7. `mark-done` (spec §6.2) + tests. Commit.
8. Templates CRUD with the three scopes + tests. Commit.
9. Backlog items (live checks from spec §9) under section A. Commit.

### Stream B — d1-ui generated form and picker mode

**Owns:** `packages/d1-ui/src/form/**` (new: `fieldModel.ts`, `conditions.ts`, `FieldForm.vue`, inputs, tests),
`packages/d1-ui/src/index.ts` (exports, smallest edit), the index page's picker mode (`packages/d1-ui/src/index/**`
or wherever `IndexPage`/`useIndexPage` live — add a `pick` mode that renders checkboxes, emits
`pick(rows: { id, code, rect: DOMRect }[])` and never navigates).

1. `conditions.ts` (Directus `meta.conditions` evaluation, spec §7.3) + tests. Commit.
2. `fieldModel.ts` (field defs → `FormField[]`; groups, widths, labels from translations, notes, required,
   choices, interface kind; unknown interface → `kind: 'external'`) + tests using real field rows from
   migrations 174/175 as fixtures. Commit.
3. `FieldForm.vue` + input components (text, textarea, number with suffix, select/radio, toggle, date/datetime,
   M2O record picker through the Finder search on the related collection, people picker, external → value +
   "Open in Data Studio" emitting `openExternal(field)`), `v-model` of a values object, `required` and
   conditions applied live; SSR render test as the repo does. Commit.
4. Index page picker mode + tests. Commit.

### Stream C — map edit model

**Owns:** `packages/d1-ui/src/build/**` (new: `types.ts`, `sampleCode.ts` + tests), `register-sample.vue` (only
to import `sampleCodeTemplate`), `packages/starbase-pages/src/pages/map/edit/**` pure modules and
`useDraft.ts`, `pages/map/model/loadFamily.ts` + `types.ts` + `buildGraph.ts` (work state and draft flags),
`nodes/nodes.css` (ghosted planned / draft styling only).

1. `types.ts` (spec §5.1) and `sampleCode.ts` extracted from `register-sample.vue` + tests. Commit.
2. `draft.ts` reducer with every action in spec §5.2, including duplicate ×N (in-place copies chain as passes)
   + tests. Commit.
3. `history.ts`, `summary.ts`, `inherit.ts` + tests. Commit.
4. `checks.ts` (spec E5, E13) + tests. Commit.
5. Work state on the map: `loadFamily` reads `work_state`, `planned_date` when listed in `/fields`; samples'
   `current_status = 'planned'`; `MapNode` gets `planned?: true`, `draft?: true`; ghosted CSS + tests. Commit.
6. `toGraph.ts` (draft merged into `ProcessData`, drawn through `buildGraph`) + tests. Commit.
7. `useDraft.ts` (load, debounced PATCH with version, 409 reload, undo/redo, checks, create, mark done client
   calls through `host.api`) + tests with a fake api. Commit.

### Stream D — canvas editor UI (after A's contract, B and C are merged into the base)

**Owns:** `pages/map/edit/*.vue` and `flyIn.ts`, `useEditKeys.ts`, `ProcessMapPage.vue`, `useProcessMap.ts`,
`MapRail.vue`, `nodes/ContainerNode.vue`, `nodes/RecordNode.vue`, `nodes/actions.ts`, `home/MyDrafts.vue`,
`home.vue`, `packages/d1-ui/src/nav/navConfig.ts`, `packages/d1-ui/src/usage.ts`, `core/extensions/d1-usage/index.js`
(`PAGE_KEYS` only), route tests if touched.

1. Edit mode state in `useProcessMap` (`edit` query param, `edit=new` creates a draft, draft merged via
   `toGraph`), Edit toggle, Done editing, edit lid (spec §7.1). Commit.
2. Socket interactions in nodes (click → AddMenu, drag → wire preview, drop → wire / AddMenu), ＋ output row,
   red check badges. Commit.
3. `AddMenu.vue` (templates slot, categories → methods, attach/new from/blank entries emit actions; existing
   records through `Finder`), Shift+A / right-click. Commit.
4. `SamplePicker.vue` (B's picker mode) + `flyIn.ts` (FLIP, stagger 40 ms, reverse on undo, reduced motion fade)
   + tests for the rectangle maths. Commit.
5. Rail: Checks section, selected draft item's key settings + `FieldForm` (B), project/campaign of the draft,
   Mark done dialog (also in view mode and on phones). Commit.
6. Undo/redo buttons and keys, Duplicate ×N, Delete, "Connect to…" keyboard path (`useEditKeys.ts`). Commit.
7. Create button + summary, 409 → Checks, post-create toast with labels link, My drafts on Home and Open menu,
   Build a process in the sidebar and `PAGE_KEYS`; hide edit mode when `d1-build` is absent; phones view-only.
   Commit.

### Stream E — extras (after D)

**Owns:** `pages/map/edit/TemplatesShelf.vue`, `SaveTemplateDialog.vue`, additions to `AddMenu.vue`, `draft.ts`
(attach / new from / addPass already exist from C — only wire them up), `ContainerNode.vue` (＋ pass,
remove planned), `useDraft.ts` (templates calls).

1. Attach and new from in the socket menu (existing operations through Finder filtered by method; attach only
   operations without an input sample). Commit.
2. ＋ pass on stacked containers. Commit.
3. Templates: shelf, Save as template, use in menu, edit, stale reference warning. Commit.
4. Delete planned records (owner only, spec E18) + Checks for "something done hangs off it". Commit.

### Review and merge (coordinator)

After each stream: `directus-ui-reviewer` (B, C, D, E) or a server review with `migration-review` (A); fix
findings in the stream; merge into the base; run all checks locally (`ci-local`); update this table; push.
Open one PR to `main` when D is merged (E may follow on the same PR), and drive CI to green.
