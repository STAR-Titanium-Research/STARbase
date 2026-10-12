# L1: record pages get a side rail beside panels — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The five record pages (Sample, Operation, Test, Campaign, Project) get a sticky 300px rail
on the left (identity, actions, key facts, "On this page") beside a main column of panels whose
values are a dense label/value list instead of tiles.

**Architecture:** Four kit components in `packages/d1-ui` (`RecordLayout`, `RecordRail`, `FactList`,
`PageContents`) plus `Section` changes; pure models (contents, fact filtering, counts) with vitest
tests; each page file builds its rail facts from the record it already loads. No new requests, no
permission or editing changes.

**Tech Stack:** Vue 3 + TypeScript, vitest (`npm test -w @d1/ui`), vue-tsc, Directus 11 extension
build (`npm run build -w directus-extension-d1-home`).

**Spec:** [`docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md`](../specs/2026-10-09-explorer-rail-layout-design.md)
(approved 2026-10-09; read it whole — the page table and "Inside the panels" are the requirements).

## Global Constraints

- Worktree `.claude/worktrees/l1-rail`, branch `feat/explorer-rail` (cut from `feat/explorer-nav`:
  the count links land on N1's index pages); never the main checkout or live; trailer
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; stage only your own paths.
- Kit components `RecordLayout`, `RecordRail`, `FactList`, `PageContents` use no Directus globals
  (`v-icon`, `v-button`, …) and no `@directus/extensions-sdk`; icons and buttons come in through
  slots from the page (spec "standalone direction"). The sticky offset is one CSS variable
  (`--d1-sticky-top`).
- Rail 300px, left; main column the rest; narrow layout (page width < ~1000px, container query on
  the layout, not the viewport): rail becomes a non-sticky block at the top with facts in 2–3
  columns, "On this page" hidden.
- `FactList`: label left (secondary colour), value right (text colour, weight 600), unit after in
  secondary colour, tabular figures, hairline under rows, ~28px rows, columns `repeat(auto-fill,
  minmax(260px, 1fr))` (one column in the rail), long values wrap, empty values left out. Avoid
  `dl/dt/dd` or re-set every property the Data Studio leaks onto them (comment which).
- Only kit tokens (`--d1-*`), no new literal colours (dark theme).
- Lists longer than six entries in the rail show six and "N more".
- A hidden parent reads "not visible to you" via `HiddenLink`, never blank.
- No page file over ~400 lines.
- Gates per task: `npm test -w @d1/ui`, `npm run typecheck` for @d1/ui, d1-home, d1-lab-dashboard,
  d1-campaign-ops (0 errors), `npm run build -w directus-extension-d1-home`, `bash scripts/sync_geometry.sh --check`.

## Decisions where the spec is silent or changed since (flagged)

1. **The spec's "two Home fixes" (L1e) move to N1b**, which redesigns admin Home (maintainer,
   2026-10-11, Q5): no Home changes in this plan.
2. **Counts that link** (spec decision 4): Project counts → `indexRoute(c, { query: { 'f.project_id': id } })`
   for samples, operations, tests; "Campaigns" scrolls to the panel. Campaign counts →
   operations and tests via a new **Campaign** chip filter (`campaign_id`, relation `campaigns` /
   `campaign_code`) added to the operations and tests index defs; the samples count stays plain
   text (samples join campaigns through `campaign_samples`, no single-field filter).
3. **"People on this record" is not built** (spec decision 3); the rail leaves no empty box for it.

## Review Focus

1. **Sticky inside Directus:** the Data Studio scrolls inside its own container; the rail must
   stick under the header bar and scroll on its own when taller than the window. (Task 6 preview
   check at 1440×900 and a short window.)
2. **Data Studio `dl/dt/dd` leakage** into `FactList` (values cut with an ellipsis). (Task 6.)
3. **A record with a hidden parent** (project or sample not visible to a Lab Member): rail shows
   "not visible to you". (Unit test on the fact builder; Task 6 as member.)
4. **Nothing visible today disappears:** every value the old header/meta/tiles showed is in the
   rail or a panel. (Each page task lists the old fields and where they went.)
5. **Narrow width** (Directus sidebar open): rail stacks on top, no horizontal scroll. (Task 6.)

---

### Task 1 (L1a): kit components and models

**Files:** create in `packages/d1-ui/src/components/`: `RecordLayout.vue`, `RecordRail.vue`,
`FactList.vue`, `PageContents.vue`; create `packages/d1-ui/src/record/{facts.ts,contents.ts}` +
tests; modify `Section.vue`, `src/index.ts`; keep `KeyValueGrid`/`RecordHeader` until Task 5 removes them.

**Produces:**

```ts
// record/facts.ts
export interface Fact { label: string; value: string | number | null | undefined; unit?: string; mono?: boolean;
  to?: string;            // app route → router-link
  hidden?: boolean;       // the target exists but the user can't see it → "not visible to you"
  list?: Array<{ label: string; to?: string; hidden?: boolean }>;  // multi-value (campaigns, investigators)
}
export function visibleFacts(facts: Fact[]): Fact[];           // drops empty (value null/''/undefined, empty list) unless hidden
export function capList<T>(items: T[], max = 6): { shown: T[]; more: number };
// record/contents.ts
export interface ContentsEntry { id: string; title: string; count: number | null }
export function contentsModel(entries: ContentsEntry[], visibleIds: Set<string>): Array<ContentsEntry & { empty: boolean; current: boolean }>;
//  current = first entry (in page order) whose id is in visibleIds; none visible → the last one passed the top (caller decides) — keep it simple: first visible, else null
```

Components:
- `RecordLayout` — props none; slots `crumbs`, `rail`, default; CSS grid `300px minmax(0,1fr)`,
  gap 16px; rail column `position: sticky; top: var(--d1-sticky-top, 0); max-height: calc(100vh -
  var(--d1-sticky-top, 0) - 16px); overflow: auto`; `container-type: inline-size` on the layout
  root with an `@container (max-width: 1000px)` rule that stacks the rail and un-sticks it.
- `RecordRail` — props `kind: string`, `status?: string` (rendered through a `status` slot if
  given), `code: string`, `plain?: boolean`, `title?: string`, `facts: Fact[]`, `contents?:
  ContentsEntry[]`; slots `kind-icon`, `status`, `actions`, `extra` (e.g. the sample drawing),
  `after-facts` (e.g. progress bars). Blocks in spec order. Uses `FactList` (one column) and
  `PageContents`.
- `FactList` — props `facts: Fact[]`, `columns?: 'auto' | 1`. Renders `visibleFacts`; `to` →
  `router-link`; `hidden` → `HiddenLink`-style text "not visible to you"; `list` → wrapped items
  capped at six + "N more" (toggle to show all).
- `PageContents` — props `entries: ContentsEntry[]`; observes `document.getElementById(id)` for
  each entry with an `IntersectionObserver` (root = the nearest scrolling ancestor, found once);
  click scrolls the section into view (`scrollIntoView({ block: 'start' })`) and sets the URL hash
  without a navigation; empty entries dimmed.
- `Section` — new optional `id` prop on the root; when the section has no rows (existing empty
  state), render the **lid only**: title, a zero count, and the "nothing recorded" text on one line.

- [ ] **Step 1: Tests first** (`record/facts.test.ts`, `record/contents.test.ts`): `visibleFacts`
  drops null/''/undefined/empty-list facts, keeps `hidden` facts and zero numbers; `capList` 0, 6,
  9 items (shown 6, more 3); `contentsModel` marks empty (count 0), current = first visible id,
  none visible → no current. Run → FAIL.
- [ ] **Step 2:** Implement the two modules and four components + `Section` change; export from
  `src/index.ts` (`RecordLayout`, `RecordRail`, `FactList`, `PageContents`, `Fact`, `ContentsEntry`).
  Add the no-Directus-globals guard: extend `noSdkImports.test.ts` (or a sibling) to assert the
  four new `.vue` files contain no `<v-` tags and no `extensions-sdk`.
- [ ] **Step 3:** Gates; commit (`feat(d1-ui): record layout, rail, fact list and page contents`).

### Task 2 (L1b): Operation and Test pages

**Files:** `core/extensions/d1-home/src/pages/OperationPage.vue`, `TestPage.vue`, and their
`operation/*`, `test/*` sub-components as needed. d1-home has no test runner, so any rail-fact
builder with logic (choosing labels, merging Overview + Parameters, dropping rail facts from
Details) goes in `packages/d1-ui/src/record/` as a pure function over plain records, with tests;
the page only wires it up.

- Wrap each page in `RecordLayout`: `crumbs` = today's breadcrumb; `rail` = `RecordRail` with
  identity (kind "Operation · <category>", status, code/label from `operationHeading`, title),
  actions (Edit primary when `canUpdate`, Report, Data Studio … — the buttons the header has today,
  as `v-button`s passed in the `actions` slot), key facts per the spec table (date, method,
  machine, sample, project, campaign; Test: date, category, machine, sample, project, campaign),
  contents (Details, Samples in/out, Force analysis or FAST run, Files; Test: Details, Subject,
  Results, Files).
- Main column: **one "Details" panel** = Overview + Parameters merged into one `FactList`
  (many columns), minus the facts now in the rail; the other panels unchanged, each `Section`
  given an `id` matching the contents entry.
- Remove the old `RecordHeader` and tile grids from these pages.
- [ ] List every field the old header, meta line, Overview and Parameters showed (in the report)
  and where each now appears. Gates; commit (`feat(d1-home): Operation and Test pages use the rail`).

### Task 3 (L1c): Sample page

**Files:** `SamplePage.vue`, `sample/*`.
- Rail: identity (kind "Sample · <form>", status, code, nickname), actions, **the geometry drawing
  in the `extra` slot (~265px wide, always visible)**, key facts (material, form and dimensions,
  mass, location, project, campaigns as a `list`), contents (Material and details, Life of the
  sample, Operations, Tests, Files).
- Main: "Material and details" keeps the composition bar + remaining facts (FactList) + condition
  notes; Life strip, Operations, Tests, Files unchanged (with ids).
- The drawing's CSS classes (`.gt .gl …`) must come along (see `SampleOverview.vue`).
- [ ] Field inventory in the report. Gates incl. `sync_geometry.sh --check`; commit.

### Task 4 (L1d): Project and Campaign pages + counts that link

**Files:** `ProjectPage.vue`, `CampaignPage.vue`, `projects/*`, `campaign/*`;
`packages/d1-ui/src/index/indexConfig.ts` (+ test) for the Campaign chip.
- Project rail: dates, PI, investigators (`list`), document number; counts (samples, operations,
  tests, campaigns) as facts whose `to` is `indexRoute(c, { query: { 'f.project_id': id } })`;
  "Campaigns" scrolls to the Campaigns panel (`#campaigns`). Remove the stat-tile row.
- Campaign rail: type, dates, default machine and material, project; counts — operations and tests
  link with `f.campaign_id`, samples plain text; the three progress bars in `after-facts`. Remove
  the tile row.
- `indexConfig`: add `{ field: 'campaign_id', label: 'Campaign', options: { kind: 'relation',
  collection: 'campaigns', display: 'campaign_code' } }` to the operations and tests filters; update
  the config test (and §5.1-check test if it pins the filter list).
- Main columns as the spec table; sections get ids.
- [ ] A count's number must equal what the linked list shows (same filter) — note any mismatch
  (e.g. project counts that include records reached through a campaign) in the report and show
  such a count as plain text instead of a link. Gates; commit.

### Task 5: Remove the old components

- `grep -rn "RecordHeader\|KeyValueGrid" core packages` → if no users remain, delete both and their
  exports. Gates; commit (`chore(d1-ui): drop RecordHeader and KeyValueGrid`).

### Task 6 (coordinator): preview check and review

Final Opus review of the branch, one fix round, then `scripts/dev/explorer_preview.sh` on a copy
of live: one page of each kind as admin and as a Lab Member (with the copy-only permissions fix),
1440×900 and 1920 wide, a short window (rail scrolls on its own), narrow width (rail on top),
Light and Dark (`appearance` toggle), a record with a hidden parent. Screenshots in the Outcome.
