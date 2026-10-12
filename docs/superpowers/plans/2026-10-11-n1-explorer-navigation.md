# N1: Explorer navigation and index pages — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sidebar, 20 generic index pages, a Ctrl K finder and the Home rewiring, so every
Explorer page and every visible record is reachable without the Data Studio.

**Architecture:** Pure logic (nav config, index config, URL ⇄ query, finder ranking) in
`packages/d1-ui` with vitest tests; Vue components in `packages/d1-ui` that never import
`@directus/extensions-sdk` and get an `ExplorerHost` by `inject`; one `ExplorerView` in d1-home is
the only Directus seam (wraps `<private-view>`, fills `#navigation`, provides the host).

**Tech Stack:** Vue 3 + TypeScript, vitest (`npm test -w @d1/ui`), vue-tsc, Directus 11 extension
build (`npm run build -w directus-extension-d1-home`).

**Spec:** [`docs/superpowers/specs/2026-10-11-explorer-navigation-design.md`](../specs/2026-10-11-explorer-navigation-design.md)
(read §2-§8; §5.1 is the column table, verbatim source of `indexConfig`).

## Global Constraints

- Worktree `.claude/worktrees/n1-nav`, branch `feat/explorer-nav`; never the main checkout or
  live; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run `npm ci` once at
  the repo root of the worktree before the first test (no `node_modules` yet).
- New files under `packages/d1-ui/src/{nav,index,finder}/` and `host.ts` must not import
  `@directus/extensions-sdk` (a test greps for it, Task 1). Existing SDK-coupled kit files
  (`useItems`, `useCanUpdate`, `useFieldDefs`, `EditDrawer`) stay as they are.
- Routes are app routes (no `/admin` prefix), as in `recordRoute.ts`.
- Requests go through `host.api.get(path, { params })` (axios-shaped: resolves `{ data }`).
  Directus filters are sent as JSON objects in `params.filter` (axios serialises them; Directus
  accepts JSON-string or bracket form — use `JSON.stringify` for `filter` to be explicit).
- Every user-facing string in plain English, sentence case, no jargon (house style of d1-home).
- Gates per task: `npm test -w @d1/ui` all pass; `npm run typecheck -w @d1/ui` and
  `npm run typecheck -w directus-extension-d1-home` no new errors (record the pre-existing count
  first); from Task 4 on also `npm run build -w directus-extension-d1-home` succeeds.

## Review Focus

1. **A bookmark filter with `$CURRENT_USER` / `$NOW(-7 days)` and relational paths** is passed
   through unchanged and ANDed with chips and search — never rewritten or dropped. (Task 2 tests.)
2. **A Lab Member** sees 19 collections; a hidden collection must not appear in the sidebar, the
   finder sources or as a chip relation. (Tasks 1, 3 tests; Task 8 live-copy check.)
3. **Big collections** (operations 10,285, FAST recipes 2,925): only one page of 50 is ever
   requested, with `meta=filter_count`. (Task 2 test asserts `limit`/`page`/`meta`.)
4. **URL is the state:** reload or Back reproduces bookmark + chips + search + sort + page; a
   stale/unknown bookmark id degrades with a message. (Task 2 round-trip tests; Task 5.)
5. **Finder race:** typing fast never shows results of an older query. (Task 3 uses the request
   gate; Task 6 wires it.)

---

### Task 1: Host contract, nav config, index config

**Files:** create `packages/d1-ui/src/host.ts`, `src/nav/navConfig.ts`, `src/nav/navConfig.test.ts`,
`src/index/indexConfig.ts`, `src/index/indexConfig.test.ts`, `src/noSdkImports.test.ts`; modify
`src/index.ts` (exports).

**Produces:**

```ts
// host.ts
import type { InjectionKey } from 'vue';
export interface ExplorerHost {
  api: { get(path: string, config?: { params?: Record<string, unknown> }): Promise<{ data: any }> };
  navigate(to: string): void;          // app route, e.g. '/home/samples?bookmark=3'
  openDataStudio(path: string): void;  // '/content/...'
  isAdmin: import('vue').Ref<boolean>;
  user: import('vue').Ref<{ id: string; first_name?: string } | null>;
}
export const EXPLORER_HOST: InjectionKey<ExplorerHost> = Symbol('ExplorerHost');

// nav/navConfig.ts
export interface NavLink { label: string; to: string; collection?: string; adminOnly?: boolean; newTab?: boolean }
export interface NavGroup { id: 'main' | 'dashboards' | 'records' | 'inventory' | 'resources' | 'tools'; label: string | null; collapsible: boolean; links: NavLink[] }
export const NAV_GROUPS: NavGroup[];   // exactly the tree of spec §3, in that order
export interface Bookmark { id: number; bookmark: string; collection: string; user: string | null; role: string | null; filter: unknown; search: string | null; layout_query: unknown }
export interface VisibleNav { groups: Array<NavGroup & { links: Array<NavLink & { bookmarks: Bookmark[] }> }> }
export function buildNav(visibleCollections: Set<string> | null, bookmarks: Bookmark[], isAdmin: boolean): VisibleNav;
//  - visibleCollections null (the /collections call failed) → only links without `collection` (spec §8)
//  - drops links whose collection is not visible, adminOnly links for non-admins, then empty groups
//  - nests bookmarks under the link of their collection; order global (user & role null), role, own; A-Z within
export function linkForBookmark(b: Bookmark): string;   // indexRoute(collection, { bookmark: id })

// index/indexConfig.ts — one entry per row of spec §5.1, verbatim
export interface ColumnDef { field: string; label: string; format?: 'date' | 'bool' | 'number' | 'code'; relation?: { collection: string; display: string } }
export interface FilterDef { field: string; label: string; options: { kind: 'relation'; collection: string; display: string } | { kind: 'enum'; values?: string[] } | { kind: 'bool' } }
export interface IndexDef { slug: string; collection: string; title: string; group: 'records' | 'inventory' | 'resources'; primaryKey: string; columns: ColumnDef[]; searchFields: string[]; filters: FilterDef[]; fixedFilter?: Record<string, unknown>; defaultSort: string; rowTarget: 'record' | 'drawer'; hasShortId?: boolean }
export const INDEX_DEFS: IndexDef[];
export function indexDefBySlug(slug: string): IndexDef | undefined;
export function indexDefByCollection(collection: string): IndexDef | undefined;
```

Primary keys: see the spec's fact table — all `<singular>_id` uuids except `Machine_Operators.id`
(int), `material_iso_classifications.iso_code`, `fast_recipes.id`, `insert_edges.edge_id`,
`cutting_inserts.insert_id`, `raw_stock_lots.lot_id`, `tool_boxes.tool_box_id`,
`manufacturing_methods.method_id`, `insert_types.insert_type_id`. `hasShortId` true for samples,
operations, tests. Relation display fields: projects `project_code`, materials `alloy_code`,
methods `method_code`, equipment `equipment_name`, samples `sample_code`, tool boxes
`tool_box_code`, insert types `type_code`, cutting inserts `insert_code`, facilities `name`,
manufacturers `name`, ISO classes `iso_code`. Enum chip values are loaded at runtime (distinct
values, Task 5), so `values` may be omitted.

- [ ] **Step 1: Tests first.** `navConfig.test.ts`: the static tree has the groups and link labels
  of spec §3 in order; `buildNav` with a member's 19 collections drops Etchants, Prep recipes,
  Machine operators; with `null` keeps Home, Force, FAST, Print labels, Report a bug, Data Studio
  only; Force Crawler only for admins; an Inventory group with no visible collection disappears;
  bookmarks nest under Samples/Operations/Tests in order global → role → own, A-Z. `indexConfig.test.ts`:
  20 entries; slugs unique and URL-safe; every entry's collection appears in `NAV_GROUPS` and vice
  versa (except projects, people which keep bespoke pages); every `defaultSort` field (minus `-`)
  and every `searchFields` entry is either a column field or a dotted relation path; the four core
  collections have `rowTarget 'record'`, the rest `'drawer'`. `noSdkImports.test.ts`: reads every
  `.ts`/`.vue` under `src/nav`, `src/index`, `src/finder` and `src/host.ts` and asserts none contains
  `@directus/extensions-sdk`. Run → FAIL.
- [ ] **Step 2:** Implement; export the new public names from `src/index.ts`.
- [ ] **Step 3:** Gates; commit (`feat(d1-ui): Explorer host contract, navigation and index configs`).

### Task 2: URL ⇄ query (`indexQuery`)

**Files:** create `packages/d1-ui/src/index/indexQuery.ts` + `.test.ts`; modify
`src/recordRoute.ts` (+ `indexRoute`, `INDEX_PAGES` from `INDEX_DEFS`) + its test.

**Produces:**

```ts
export interface IndexState { bookmark: number | null; q: string; filters: Record<string, string>; sort: string | null; page: number; open: string | null }
export function stateFromQuery(query: Record<string, string | string[] | undefined>): IndexState;  // keys: bookmark, q, f.<field>, sort, page, open
export function queryFromState(s: IndexState): Record<string, string>;   // omits defaults (page 1, empty q, null sort…)
export const PAGE_SIZE = 50;
export const SHORT_ID_RE = /^[0-9a-f]{8,32}$/i;
export function buildItemsParams(def: IndexDef, s: IndexState, bookmark: Bookmark | null): Record<string, unknown>;
//  fields: [pk, ...column fields (relations as `<field>.<display>`)]
//  filter: { _and: [fixedFilter?, bookmark.filter?, ...chips (field: {_eq: value}; bool 'true'/'false'), search?] } (omit when empty)
//  search: { _or: searchFields.map(f => nested {_icontains: q}) } + { short_id: { _eq: q.toLowerCase() } } when def.hasShortId && SHORT_ID_RE
//  sort: [s.sort ?? bookmarkSort(bookmark) ?? def.defaultSort]
//  limit PAGE_SIZE, page s.page, meta 'filter_count'; filter is JSON.stringify'd
export function bookmarkSort(b: Bookmark | null): string | null;   // layout_query.tabular.sort[0]
export function nested(path: string, cond: unknown): Record<string, unknown>; // 'sample_id.sample_code' → {sample_id:{sample_code:cond}}
export function dataStudioLink(def: IndexDef, s: IndexState): { to: string; note: string | null };
//  bookmark only (no q, no chips) → /content/<c>?bookmark=<id>, note null; else /content/<c> with note "Opens the full list: the Data Studio can't take this search or these filters."
// recordRoute.ts
export function indexRoute(collection: string, opts?: { bookmark?: number; open?: string }): string;
```

- [ ] **Step 1: Tests first** (each a named case): round-trip `queryFromState(stateFromQuery(x))`
  for a full state and for defaults; `f.project_id` → `filters.project_id`; non-numeric page → 1;
  `buildItemsParams` with the live bookmark filter
  `{"_and":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}` + a chip + search keeps the
  bookmark object deep-equal inside `_and`; relation search path nests; `a1b2c3d4` on samples adds
  the `short_id` clause, on tools it does not; sort precedence URL > bookmark (`-operation_date`
  from `layout_query`) > default; `limit 50`, `page 3`, `meta filter_count`; no `filter` key when
  nothing applies; `dataStudioLink` both branches; `indexRoute('physical_samples',{bookmark:7})` →
  `/home/samples?bookmark=7`, unknown collection → `/content/<c>`; `collectionRoute` now returns
  `/home/<slug>` for all 20 + projects; `recordRoute` unchanged. Run → FAIL.
- [ ] **Step 2:** Implement. **Step 3:** Gates; commit (`feat(d1-ui): index page query from the URL`).

### Task 3: Finder logic

**Files:** create `packages/d1-ui/src/finder/finder.ts` + `.test.ts`.

**Produces:**

```ts
export interface FinderHit { group: 'Pages' | 'Saved views' | 'Samples' | 'Operations' | 'Tests' | 'Campaigns' | 'Projects' | 'People' | 'Inventory'; label: string; detail?: string; to: string; rank: number }
export interface FinderSource { group: FinderHit['group']; collection: string; fields: string[]; match: string[]; shortId?: boolean; label(row: any): string; detail?(row: any): string; to(row: any): string }
export const FINDER_SOURCES: FinderSource[];   // spec §6 table; Inventory = five sources (tools, tool_boxes, cutting_inserts, insert_edges, raw_stock_lots) → indexRoute(c, { open: pk })
export function localHits(q: string, nav: VisibleNav): FinderHit[];        // pages + bookmarks
export function sourceParams(src: FinderSource, q: string): Record<string, unknown>;  // filter _or of _icontains (+ short_id _eq when shortId && SHORT_ID_RE), limit 5, fields
export function rankHit(q: string, label: string, exactShortId: boolean): number;     // 0 exact short id, 1 exact code, 2 prefix, 3 contains
export function mergeHits(q: string, groups: FinderHit[][]): FinderHit[];             // group order of spec §6, rank inside groups, max 5 per remote group
export function visibleSources(visible: Set<string> | null): FinderSource[];         // null → none (only local hits)
export const MIN_QUERY = 2;
```

Labels: operations use `operationLabel` from `../operationLabel`; tests `test_code ?? 'Test'` with
`test_type` as detail; samples `sample_code` with nickname detail; people → `/home/people?q=<name>`.

- [ ] **Step 1: Tests first:** `localHits('sam', nav)` finds the Samples page and "My samples";
  `sourceParams` for samples with `a1b2c3d4` has the short-id clause and limit 5, for people not;
  `rankHit` ordering; `mergeHits` puts an exact short-id sample first within Samples and keeps group
  order; `visibleSources` drops sources whose collection is hidden; queries shorter than
  `MIN_QUERY` produce nothing remote. Run → FAIL.
- [ ] **Step 2:** Implement. **Step 3:** Gates; commit (`feat(d1-ui): finder sources and ranking`).

### Task 4: `ExplorerView` + `ExplorerNav`; pages use it

**Files:** create `core/extensions/d1-home/src/ExplorerView.vue`,
`packages/d1-ui/src/nav/ExplorerNav.vue`, `packages/d1-ui/src/nav/useExplorerNav.ts`; modify
d1-home's eight `<private-view>` users (`home.vue`, `register-sample.vue`, `people.vue`,
`pages/ProjectsIndex.vue`, `ProjectPage.vue`, `CampaignPage.vue`, `SamplePage.vue`,
`OperationPage.vue`, `TestPage.vue`) to use `<ExplorerView :title>` with the same slots; replace
the admin heuristics in `home.vue` / `people.vue` with `host.isAdmin`; export `ExplorerNav`,
`EXPLORER_HOST` from `src/index.ts`.

- `ExplorerView` props `title: string`; slots default, `headline`, `title-outer:prepend`, `actions`
  passed to `<private-view>`; `#navigation` → `<ExplorerNav />`. Builds the host once per app
  (module-level singleton so navigating between pages doesn't refetch): `api` = `useApi()`,
  `navigate`/`openDataStudio` = `useRouter().push`, `isAdmin` from `GET /policies/me/globals`
  (`data.data.admin_access === true`; false on error), `user` from
  `GET /users/me?fields=id,first_name`. `provide(EXPLORER_HOST, host)`.
- `useExplorerNav(host)`: loads `GET /collections?fields=collection,meta.hidden` (visible set =
  rows with `meta` and not hidden) and the bookmarks (spec §3 request) in parallel, once per app
  session (cached in module scope; a `refresh()` for Retry); returns `nav` (`buildNav`), `loading`,
  `error`.
- `ExplorerNav.vue`: renders spec §3 — brand "STARBase" + subtitle "A sisyphean pursuit"; a
  "Find a record… Ctrl K" button that emits `open-finder` (wired in Task 6); groups with headings;
  Inventory/Resources collapsible with state in `localStorage['d1.nav.collapsed']` (try/catch;
  default collapsed; auto-open the group containing the active route); bookmarks as indented
  sub-links; active link highlighted (route path match, and `bookmark` query for bookmarks);
  new-tab links get `target="_blank"`; the §8 failure line "Couldn't load the list of pages" +
  Retry. Styling with the kit's tokens (`tokens.css`), compact (Directus nav width), keyboard
  focus visible.
- [ ] **Step 1:** Implement (no unit tests for SFCs; logic already tested). **Step 2:** Gates incl.
  build. **Step 3:** Commit (`feat(d1-home): Explorer sidebar on every Explorer page`).

### Task 5: Generic `IndexPage` and the `:slug` route

**Files:** create `packages/d1-ui/src/index/IndexPage.vue`, `src/index/useIndexPage.ts`,
`core/extensions/d1-home/src/pages/IndexRoute.vue` (wraps `IndexPage` in `ExplorerView`, reads
`slug` prop); modify `core/extensions/d1-home/src/index.ts` (add `{ path: ':slug', component:
IndexRoute, props: true }` **after** the static routes).

- `useIndexPage(host, def, route)`: state from the route query (`stateFromQuery`); loads the
  bookmark (from the nav cache, else `GET /presets/<id>`; unreadable/missing → message "That saved
  view isn't available" and continue without it); items via `buildItemsParams` with
  `useRequestGate`; total from `meta.filter_count`; chip options: relation → `GET
  /items/<collection>?fields=<pk>,<display>&sort=<display>&limit=200`, enum → `GET
  /items/<c>?groupBy[]=<field>&aggregate[count]=*&limit=200` (distinct values), bool → yes/no; a chip
  whose relation collection is not visible is not offered. Every change writes the URL with
  `router.replace` for typing (debounced 250 ms) and `router.push` for clicks (bookmark, chip,
  sort, page).
- `IndexPage.vue` (spec §5): header (title, total "Showing 1-50 of 1,206", "+ New" →
  `host.openDataStudio('/content/<c>/+')`, "Open in Data Studio" with `dataStudioLink` and its note
  as tooltip); bookmark chips (this collection's bookmarks; active one highlighted; × clears);
  search box; chip filter selects; the table (`DataTable` from the kit; header click sorts asc →
  desc; formats via `formatDate`/`formatNumber`; relations show their display value; operations'
  code column uses `operationLabel`); previous/next paging; rows: `record` → `host.navigate(recordRoute(c, pk))`,
  `drawer` → `EditDrawer` (existing component, `collection`, `primaryKey`, `v-model` open, `@saved`
  reloads); `?open=<pk>` opens the drawer on load and clears `open` from the URL when it closes;
  states: skeleton rows, empty ("Nothing matches." + "Clear filters"), `NotVisible` on 403,
  `LoadState` error with Retry; unknown slug → "No such page" + link Home.
- [ ] **Step 1:** Implement. **Step 2:** Gates incl. build. **Step 3:** Commit
  (`feat(d1-home): one index page for every collection`).

### Task 6: Finder dialog (Ctrl K)

**Files:** create `packages/d1-ui/src/finder/Finder.vue`, `src/finder/useFinder.ts`; modify
`ExplorerView.vue` (mount the finder once; global keydown Ctrl K / ⌘K, ignored while focus is in
a Directus drawer form input other than the finder; the nav's `open-finder` opens it).

- `useFinder(host, nav, visible)`: debounced 200 ms; below `MIN_QUERY` only `localHits`; else
  `localHits` + parallel `GET /items/<c>` per `visibleSources` with `sourceParams`, gated by
  `useRequestGate`; failures of one source drop that group only; `mergeHits`.
- `Finder.vue`: modal dialog (`role="dialog"`, `aria-modal`, focus trapped, Esc closes, focus
  returns to the opener), one input, grouped results, ↑/↓ moves, Enter opens (`host.navigate`),
  mouse click opens; empty state "No matches"; loading hint.
- [ ] **Step 1:** Implement. **Step 2:** Gates incl. build. **Step 3:** Commit
  (`feat(d1-home): Ctrl K finder`).

### Task 7: Rewiring

**Files:** modify `core/extensions/d1-home/src/home/{LabStats,NeedsAttention,QuickActions,RecentActivity,MyWork}.vue`,
`home/attention.ts`, `pages/projects/CampaignCards.vue`, `pages/projects/UnassignedLists.vue`,
`pages/sample/SampleRecords.vue`; delete `home/samplesBookmark.ts` (and its uses).

- LabStats tiles → `collectionRoute(c)` (now the index pages); Samples tile plain (no bookmark).
- NeedsAttention `moreLink`: named bookmark readable → `indexRoute(c, { bookmark: id })`, else
  `collectionRoute(c)`; text "See all" / "See the list".
- Cap-link texts "Open the collection in the Data Studio (unfiltered)" → "See the full list" (at
  `CampaignCards.vue:62`, `UnassignedLists.vue:33,50,67`, `SampleRecords.vue:42,65` — confirm lines).
- QuickActions: keep the three main actions; remove the `more` chips (Projects, People, Force
  Analysis, FAST Analysis, Force Crawler) — the sidebar has them (spec N-Q5).
- RecentActivity/MyWork: replace `SAMPLES_LIST`/`samplesBookmarkLink` with `collectionRoute`.
- [ ] **Step 1:** `grep -rn "samplesBookmark\|SAMPLES_LIST\|in the Data Studio (unfiltered)" core packages`
  → only the files above; change each. **Step 2:** Gates incl. build; `grep` again → no hits.
  **Step 3:** Commit (`feat(d1-home): Home and record pages link to the Explorer lists`).

### Task 8 (coordinator): preview on a copy of live and check in the browser

No schema change, so no migration. Add `scripts/dev/explorer_preview.sh` (from
`directus_smoke.sh`): restore a copy of live into a throwaway Postgres, start Directus (live's
image) with the worktree's built `core/extensions/d1-home` overlaid, **publish it on
`127.0.0.1:18055`**, create on the copy a local test admin and a test Lab Member with generated
passwords written to a git-ignored `.superpowers/` file (never live, never real credentials),
print the URL, leave it running until `--stop`. Then in the browser pane, as admin and as the
member: the checks of spec §9 (sidebar entries, 19 for the member; bookmarks nest and filter;
search, sort, page, stack bookmark + chip; core row → page; inventory row → drawer; "+ New",
"Open in Data Studio"; Ctrl K by code, by short ID, test by code, edge by code). Screenshots of the
sidebar and one index page into the Outcome. Deployment into the main checkout waits for the
maintainer (spec N-Q1).
