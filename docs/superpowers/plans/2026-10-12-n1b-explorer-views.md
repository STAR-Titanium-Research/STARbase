# N1b: icon-rail navigation, list views, plot buttons and an admin Home — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The maintainer's 2026-10-11 decisions: an icon rail + panel sidebar, Table/Cards and
density on every index page, thumbnails, per-row Force/FAST buttons, and a tidy admin Home with
admin panels (force-crawler queue, missing files, ownerless records).

**Architecture:** Pure models in `packages/d1-ui` with vitest tests; kit components get host-neutral
slots (`#thumb`, `#card`) that the Directus module fills (`IndexRoute.vue` supplies the geometry
drawing and images), so the kit stays free of d1-home imports. Data the list request can't carry
(force/FAST presence, Fz figure) comes from a second, fail-soft request keyed by the page's ids.
Missing-file counts need SQL on `directus_files.metadata` (json, not filterable over REST), so a
small admin-only endpoint extension serves the admin panels.

**Tech Stack:** Vue 3 + TS, vitest (`npm test -w @d1/ui`), `node --test` for endpoint extensions,
vue-tsc, Directus 11.17 extension builds.

**Spec:** [`docs/superpowers/specs/2026-10-11-explorer-n1b-design.md`](../specs/2026-10-11-explorer-n1b-design.md)
(decisions 1-6). Facts behind this plan (aliases, counts, limits) were gathered 2026-10-12.

## Global Constraints

- Worktree `.claude/worktrees/n1b`, branch `feat/explorer-n1b` (from `feat/explorer-rail`); never the
  main checkout or live; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; stage
  only your own paths. Push and keep the draft PR updated after each task (coordinator).
- Kit code (`packages/d1-ui/src/**`) never imports d1-home or `@directus/extensions-sdk` (guard test);
  Directus globals (`v-icon` …) stay out of new kit components.
- Relation/alias names (verified on live): operations → `force_analyses` (machining_force_analysis,
  `status`, `frm_fz`), `fast_run` (fast_run_data, `status`); samples → operations alias is
  `manufacturing_operations` (not `operations`). `machining_force_analysis` and `fast_run_data` are
  **hidden** collections (not in `useExplorerNav().visible`) and Lab Members read them row-filtered:
  never put their fields in the main list request; use a separate request and treat failure as "no
  data" (no button, placeholder thumbnail).
- Counting through o2m request filters is wrong (join duplicates); count with `_in` ids client-side or
  `aggregate[countDistinct]`.
- Image thumbnails: `/assets/<id>?width=320&height=200&fit=cover&format=webp`, `loading="lazy"`,
  `decoding="async"`, and an `@error` fallback to the placeholder (most force figures can't be
  transformed on live yet; see Task 8).
- User-facing text: plain English, sentence case. Every per-browser preference in `localStorage`
  wrapped in try/catch with a working default.
- Gates per task: `npm test -w @d1/ui`, typechecks 0 (@d1/ui, d1-home, d1-lab-dashboard,
  d1-campaign-ops), `npm run build -w directus-extension-d1-home`, `bash scripts/sync_geometry.sh --check`;
  endpoint tasks also `node --test core/extensions/<ext>/index.test.mjs`.

## Decisions where the spec was silent (flagged)

1. **Ownerless operations panel counts machining operations only** (`process_category != 'sintering'`;
   27 on live). 7,227 of the 7,254 ownerless operations are legacy FAST imports that will never get an
   owner (they are readable by every Lab Member by design); listing them would swamp the panel.
2. **Geometry thumbnail fallback:** no drawing (a neutral placeholder with the form name) when the form
   is "other"/empty or the sample has no dimension at all (84 of 162 live samples), because the
   engine otherwise invents a default-sized shape that looks like data.
3. **"Force (n)" target:** the Operations list with `q=<sample code>` and a new boolean chip "With force
   data" that emits `{"force_analyses":{"_some":{"status":{"_eq":"done"}}}}` (legal: top-level o2m;
   migration 160 is live, so Lab Members don't 400; Directus applies the related rows' own rules).
4. **Force-figure thumbnails need a live change** (Task 8): prepared here, deployed only with the
   maintainer's go-ahead.
5. **Sample photos** wait on the AppSheet export (`Sample_Data.xlsx`); not in this plan.

## Review Focus

1. A Lab Member who can read an operation but not its force analysis: no Force button, no error, the
   list still loads. (Task 5 test with a failing second request; preview check as member.)
2. 50 cards with images on one page: lazy loading, no layout jump, broken images fall back. (Task 4.)
3. Density/view preferences survive reload per list and never break the page when storage throws.
   (Task 2 tests.)
4. Admin panels never show to a Lab Member, and the endpoint refuses non-admins. (Task 6 tests.)
5. The icon rail keeps every destination the old sidebar had (no lost pages), keyboard reachable.
   (Task 1 test: every `NAV_GROUPS` link appears in exactly one rail section.)

---

### Task 1: Icon rail + panel navigation

**Files:** create `packages/d1-ui/src/nav/railModel.ts` + test, `nav/NavRail.vue`, `nav/NavPanel.vue`;
rewrite `nav/ExplorerNav.vue` to compose them (keep its name, props `showBrand`, emit `open-finder`,
so `ExplorerView.vue` doesn't change); keep `useExplorerNav`, `navState.ts` (active link, collapse) as is.

```ts
// railModel.ts
export type RailSectionId = 'home' | 'records' | 'analysis' | 'kit' | 'tools';
export interface RailSection { id: RailSectionId; label: string; icon: string /* single glyph or short text, no v-icon */; groups: Array<VisibleNav['groups'][number]> }
export const RAIL_SECTIONS: Array<{ id: RailSectionId; label: string; icon: string; groupIds: NavGroup['id'][] }>;
//  home: ['main']; records: ['records']; analysis: ['dashboards']; kit: ['inventory','resources']; tools: ['tools']
export function railSections(nav: VisibleNav): RailSection[];          // drops sections with no visible link
export function activeSection(sections: RailSection[], path: string, query: Record<string, unknown>): RailSectionId; // section holding the active link, else 'home'
```

- `NavRail`: a narrow dark column (~56px) of section buttons (glyph + small label), `aria-label="Sections"`,
  `aria-current` on the active one; the finder button (🔍 "Find") at the top emits `open-finder`.
- `NavPanel`: the selected section's title, its groups (Kit shows "Inventory" and "Resources" as two
  headed groups, collapsible as today), links with the open list's saved views nested under it,
  admin-only links per `buildNav`; the "Couldn't load the list of pages · Retry" note as today.
- The selected section follows the route (`activeSection`) and can be switched by clicking the rail
  without navigating; remembered per browser (`d1.nav.section`, try/catch) only while on Home.
- Narrow column (Directus nav ≈ 260px): rail + panel side by side inside it.
- [ ] Tests first (`railModel.test.ts`): every link of `NAV_GROUPS` appears in exactly one section;
  empty sections are dropped for a member without Kit collections; `activeSection` for
  `/home/samples?bookmark=3` → records, `/d1-force-dashboard` → analysis, `/home/tools` → kit,
  `/home` → home.
- [ ] Implement; gates; commit (`feat(d1-ui): icon rail and panel navigation`).

### Task 2: List preferences — view and density

**Files:** create `packages/d1-ui/src/index/listPrefs.ts` + test; modify `index/IndexPage.vue`,
`index/useIndexPage.ts`.

```ts
export type ListView = 'table' | 'cards';
export type Density = 'compact' | 'normal' | 'roomy';
export interface ListPrefs { view: ListView; density: Density }
export function readListPrefs(slug: string, storage?: Storage | null): ListPrefs;   // default { view: 'table', density: 'normal' }; junk → default
export function writeListPrefs(slug: string, prefs: ListPrefs, storage?: Storage | null): void; // key `d1.list.<slug>`; never throws
```

- Header gets two segmented controls (Table | Cards; Compact | Normal | Roomy) with `role="radiogroup"`.
- Density changes table row padding/font (`compact` ~3px rows 12px text; `normal` today; `roomy` 11px
  rows) and, in Roomy, a thumbnail column (first column) rendered through the `#thumb` slot when the
  page provides one (Task 4).
- [ ] Tests first: defaults; round trip; junk JSON → default; storage that throws on get/set → default,
  no throw. Implement; gates; commit (`feat(d1-ui): table or cards and a density switch per list`).

### Task 3: Card view and the campaign card

**Files:** create `packages/d1-ui/src/index/CardGrid.vue`, `index/TextCard.vue`, `index/cardFacts.ts` +
test; create `packages/d1-ui/src/campaign/CampaignCard.vue` + `campaign/campaignCardStats.ts` + test;
modify `IndexPage.vue`, `core/extensions/d1-home/src/pages/projects/CampaignCards.vue` (use the new card);
`indexConfig.ts` (campaigns def gains `owner_person_id.full_name` for the card).

- `CardGrid`: `repeat(auto-fill, minmax(240px, 1fr))` grid of the page's rows (same paging, search,
  chips, saved views as the table). Each card is the `#card` slot if the page provides one, else a
  `TextCard`: thumbnail area (`#thumb` slot or nothing), code (monospace, the row link), title, up to
  four facts from `cardFacts(def, row)` (the def's columns after code/title, formatted like the table,
  empty ones skipped), and the row's plot buttons (Task 5) in the footer. Record rows link to their
  page; drawer rows open the drawer (as table rows do).
- `cardFacts(def, row): Array<{ label; value }>` — pure, tested.
- `CampaignCard`: extracted from `CampaignCards.vue` lines ~34-63 (code/name, type tag, status, owner,
  dates, counts, progress bar or "progress unavailable"/"nothing to track"), props
  `{ campaign, stats: CampaignStats | null }`. `campaignCardStats(host, campaignIds)` loads the counts
  and progress for up to 50 campaigns with the same reads `useProjectData.loadCampaigns` uses, filtered
  `campaign_id._in` the ids instead of the project; each read fail-soft (stats null on failure).
  The campaigns index renders `CampaignCard` in Cards view; the Project page's Campaigns panel uses the
  same component (no visible change there).
- [ ] Tests first (`cardFacts`, `campaignCardStats` with a fake host: counts per campaign, one failing
  read → that part null). Implement; gates; commit (`feat(d1-ui): card view and a campaign card`).

### Task 4: Thumbnails (d1-home supplies them)

**Files:** modify `core/extensions/d1-home/src/pages/IndexRoute.vue`; create
`core/extensions/d1-home/src/pages/index/IndexThumb.vue`; modify `packages/d1-ui/src/index/indexView.ts`
(`extraFields`) + test; `packages/d1-ui/src/index/thumbs.ts` + test (pure: which thumbnail kind a
collection has and which fields to request).

```ts
export type ThumbKind = 'geometry' | 'image' | 'force' | null;
export function thumbKind(collection: string): ThumbKind;   // physical_samples geometry; equipment/tools/insert_types image ('image'), manufacturers image ('Logo'); manufacturing_operations force; else null
export function thumbFields(collection: string): string[];  // samples: form + the 6 dimension columns sampleDims reads; image ones: their file field
export function hasDrawableDims(row): boolean;              // form not 'other'/empty AND at least one dimension present
export function assetThumbUrl(fileId: string, w = 320, h = 200): string;
```

- `IndexRoute.vue` fills `IndexPage`'s `#thumb="{ row, def }"` with `IndexThumb`: samples →
  `SampleGeometry` (the same component the Sample page rail uses, so the drawing is identical) when
  `hasDrawableDims`, else the placeholder (form name, muted); image collections → `<img>` of the file
  field via `assetThumbUrl`; machining operations → the Fz figure id from the row's force data (Task 5's
  second request result is exposed to the slot as `row.__force?.frmFz`) or the placeholder.
- Every `<img>`: `loading="lazy"`, fixed aspect box (no layout jump), `@error` → placeholder.
- [ ] Tests first (`thumbs.ts`: kinds, fields, `hasDrawableDims` incl. 'other', none, a disc with only a
  diameter; `extraFields` adds `thumbFields`). Implement; gates incl. `sync_geometry.sh --check`;
  commit (`feat(d1-home): thumbnails on cards and in roomy rows`).

### Task 5: Row plot buttons and "With force data"

**Files:** create `packages/d1-ui/src/index/plotData.ts` + test; modify `useIndexPage.ts`,
`IndexPage.vue`, `TextCard.vue`, `indexConfig.ts` (+ test) for the new chip kind.

```ts
export interface RowPlots { force: boolean; fast: boolean; frmFz: string | null; forceCount?: number }
export function plotRequests(collection: string, ids: string[]): Array<{ path: string; params: Record<string, unknown>; key: 'force' | 'fast' | 'sampleForce' }>;
//  operations: force = /items/machining_force_analysis filter {_and:[{operation_id:{_in:ids}},{status:{_eq:'done'}}]} fields operation_id,frm_fz limit -1
//              fast  = /items/fast_run_data         filter {_and:[{operation_id:{_in:ids}},{status:{_eq:'done'}}]} fields operation_id limit -1
//  samples:    sampleForce = /items/machining_force_analysis filter {_and:[{status:{_eq:'done'}},{operation_id:{sample_id:{_in:ids}}}]} fields operation_id.operation_id,operation_id.sample_id limit -1
export function mergePlots(collection: string, ids: string[], results: Partial<Record<'force'|'fast'|'sampleForce', unknown[] | null>>): Record<string, RowPlots>;
//  null result (request failed) → no buttons for that kind; sample forceCount = distinct operation ids per sample; frmFz = first done row's frm_fz
```

- `useIndexPage` runs `plotRequests` after each successful page load (gated, fail-soft), exposes
  `plots: Record<rowId, RowPlots>`.
- Table: a right-aligned "Plots" column (operations, samples only): **Force** → `analysisLink(id,
  'machining')`, **FAST** → `analysisLink(id, 'sintering')` (existing helper in `process.ts`), sample
  **Force (n)** → `indexRoute('manufacturing_operations', { query: { q: <sample_code>, 'f.has_force': 'true' } })`.
  Buttons only when true; a row without data shows nothing. Cards show the same in the footer.
- New chip kind on the operations def: `{ field: 'has_force', label: 'With force data', options: { kind:
  'flag', filter: {"force_analyses":{"_some":{"status":{"_eq":"done"}}}} } }` — `buildItemsParams` emits
  the given filter when `f.has_force=true` (a flag chip is a yes/off toggle; not a column).
- [ ] Tests first: `plotRequests` shapes (no `_some` in these); `mergePlots` (a failed request → false,
  4 ops with two done rows → one frmFz, sample counts distinct); the flag chip emits its filter only when
  `'true'`. Implement; gates; commit (`feat(d1-ui): Force and FAST buttons on list rows`).

### Task 6: Admin overview endpoint

**Files:** create `core/extensions/d1-admin-overview/{package.json,index.js,index.test.mjs}`; add to the
root `package.json` workspaces if extensions are listed there; add a row to the endpoint table in
`core/README.md`.

- `GET /d1-admin-overview` → 403 unless `req.accountability?.admin`; 401 without a user. Returns
  `{ missingFiles: { count, recent: [{ id, filename_download, missing_since }] (≤10, newest first) },
  fingerprints: { done, error, missing }, crawler: { state: <force_crawler_state row: desired_state,
  current_activity, last_heartbeat_at, processed_count, error_count>, analyses: { pending, processing,
  done, error } }, ownerless: { samples, campaigns, machiningOperations } }` via `database` (knex) SQL:
  `(metadata::jsonb->>'missing') = 'true'` on directus_files; `file_fingerprints` grouped by status (table
  may not exist on an older DB → zeros); `machining_force_analysis` grouped by status;
  `owner_person_id IS NULL` counts (operations: `process_category <> 'sintering'`). Each part
  fail-soft (`null` + logged) so one broken query doesn't 500 the rest. Follow `d1-next-number/index.js`
  for structure and test style (fake knex).
- [ ] Tests first (`node --test`): 401/403; shape with a fake database; one failing part → that part
  null, others present. Implement; commit (`feat(admin): overview endpoint for the admin Home panels`).

### Task 7: Admin Home redesign + admin panels

**Files:** modify `core/extensions/d1-home/src/home.vue`, `home/{QuickActions,NeedsAttention,LabStats,MyWork,RecentActivity}.vue`;
create `home/AdminPanels.vue`, `home/useAdminOverview.ts`.

- Layout (spec decision 5): greeting hero with the three quick actions as buttons in it; one stats band
  (LabStats' six counts in one row, wrapping only on narrow screens); a two-column row with equal-height
  panels: **Needs attention** listing only non-zero items (one "Nothing needs you ✓" line otherwise) and
  **Your work** (MyWork's three groups merged into one panel; a group with nothing is left out; the
  "link your login to a person" note when applicable); **Recent activity** full width.
- **Admin panels** (admins only, `host.isAdmin`), from `GET /d1-admin-overview`: Force crawler (state,
  activity, online = heartbeat < 30 s, processed/errors, pending/processing/error counts, link to
  `/d1-force-crawler`); Files missing on the share (count, last ten with when; fingerprints done/error/
  missing; link to the Data Studio files list); Ownerless records (samples, campaigns, machining
  operations, each linking to its index page with an owner-empty view if one exists, else the plain list).
  A failed endpoint call shows one quiet line, not three broken panels.
- [ ] Gates; commit (`feat(d1-home): tidy admin Home with crawler, missing-file and ownerless panels`).

### Task 8 (coordinator, prepared, deploy needs the maintainer): force-figure thumbnails

- In `docker-compose.yml` `directus` env: `ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION: "8000"`,
  `ASSETS_TRANSFORM_TIMEOUT: "30000"` (the Fz PNGs are 6,006-6,102 px and ~20 MB).
- `scripts/backfill_image_dims.py`: for `directus_files` rows of type `image/png|jpeg|webp` with NULL
  width/height, read the image header (PNG IHDR / JPEG SOF / WebP) from the uploads volume via
  `docker exec d1-database-directus-1` and set width/height; dry run by default; `--apply` to write.
- Not applied: the maintainer decides when (Directus restart). Until then force cards show the
  placeholder.

### Task 9 (coordinator): review, preview, PR

Final Opus review, one fix round, preview on a copy of live (admin + Lab Member, 1600×900 and narrow):
rail sections, Table/Cards, density, thumbnails (geometry identical to the Sample page), plot buttons,
admin Home. Keep the PR (stacked on #239) updated after each task.
