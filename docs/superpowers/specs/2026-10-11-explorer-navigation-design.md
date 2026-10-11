# N1: Explorer navigation and index pages

Status: **approved to proceed 2026-10-11** (the maintainer said "proceed" without answering §10,
so the recommended answers to N-Q1…N-Q6 stand; deploying into the main checkout, N-Q1, still waits
for an explicit go-ahead). Built from the decisions of the
2026-10-09 grilling (Q1-Q15, Q18-Q19, Q33; recorded in
[`docs/superpowers/plans/2026-10-09-explorer-round-2.md`](../plans/2026-10-09-explorer-round-2.md),
"Resume here", item 1) and the layout mockup `nav-options.html` (option A, chosen). Questions the
grilling did not settle are numbered **N-Q1…** in §10; each has a recommended answer that this
draft already assumes.

Branch `feat/explorer-nav` (worktree `.claude/worktrees/n1-nav`), cut from `feat/record-codes`
(it needs T0's test codes and short IDs for the finder). It goes before L1 (rail and panels),
whose clickable counts land on these index pages.

## 1. Goal

Every Explorer page, and every record a user may see, is reachable from the Explorer itself,
without opening the Data Studio. Editing keeps using the Directus form (drawer or Data Studio).
The Explorer will later leave Directus for a standalone web app, so everything Directus-specific
sits behind one seam.

**Out of scope:** record-page layout (L1), access dialog (A1), frequently used (U1), lineage
graph (G1); making the existing kit pieces Directus-free (`useItems`, `useCanUpdate`,
`useFieldDefs`, `EditDrawer` keep importing the SDK); counts in the sidebar (decided: no
counts); a mobile layout of our own (narrow screens use Directus's slide-out for now).

## 2. Architecture

```
d1-home module (Directus)                       packages/d1-ui (@d1/ui, no Directus imports in new code)
─────────────────────────                       ─────────────────────────────────────────────────────
ExplorerView.vue  ── the only Directus seam ──► provides ExplorerHost
  <private-view>                                  nav/navConfig.ts       grouping, labels, slugs, links
    #navigation → <ExplorerNav/>                  nav/ExplorerNav.vue    the sidebar
    default     → page content                   index/indexConfig.ts   one entry per index page (§5)
  host = { api, navigate, openDataStudio,         index/indexQuery.ts    URL ⇄ query, Directus params
           isAdmin, user }                        index/IndexPage.vue    the generic index page
                                                  finder/finder.ts       sources, ranking, short-ID match
                                                  finder/Finder.vue      Ctrl K dialog
                                                  host.ts                ExplorerHost type + inject key
```

- **`ExplorerView`** (new, `core/extensions/d1-home/src/ExplorerView.vue`) replaces the eight
  `<private-view>` wrappers in d1-home's pages. It renders `<private-view :title>`, puts
  `ExplorerNav` in the `#navigation` slot (empty today in every page), and passes `#headline` /
  `#title-outer:prepend` through for People. It builds the **`ExplorerHost`** and `provide`s it:
  - `api`: the axios instance from `useApi()` (only `get` is used by the new code);
  - `navigate(to)`: the router's `push`; `openDataStudio(path)`: same, for `/content/...`;
  - `isAdmin`: from `GET /policies/me/globals` → `admin_access` (the REST check; the store
    heuristic in `home.vue`/`people.vue` is replaced by this too);
  - `user`: `{ id, first_name }` from `GET /users/me?fields=id,first_name`.
- **New kit code never imports `@directus/extensions-sdk`**; it takes the host by `inject`. A
  standalone app later provides its own host and reuses the components unchanged.
- **Pure logic is unit-tested** (`npm test -w @d1/ui`, vitest, node environment, as the kit's
  existing `*.test.ts`); components are checked by typecheck, build and a browser check (§9).

## 3. The sidebar (`ExplorerNav`)

Grouping comes from `navConfig.ts`, **not** from the Directus collection tree: in Directus
`physical_samples` sits in the `inventory` folder and `test_sessions` under `projects`, which is not
how the lab thinks about them.

```
STARBase                      (brand; subtitle "A sisyphean pursuit")
[ Find a record…   Ctrl K ]   (opens the finder, §6)
Home                          /home
DASHBOARDS
  Force                       /d1-force-dashboard
  FAST                        /d1-fast-dashboard
RECORDS
  Projects                    /home/projects     (bespoke page, kept)
  Campaigns                   /home/campaigns
  Samples                     /home/samples
    ↳ <bookmarks of physical_samples>             /home/samples?bookmark=<id>
  Operations                  /home/operations
    ↳ <bookmarks of manufacturing_operations>
  Tests                       /home/tests
    ↳ <bookmarks of test_sessions>
  People                      /home/people       (bespoke page, kept)
INVENTORY ▸                   (collapsible)
  Tools, Tool boxes, Cutting inserts, Insert edges, Raw stock lots
RESOURCES ▸                   (collapsible)
  Equipment, Materials, Machine operators, Insert types, ISO classes, Methods,
  Manufacturers, Facilities, Prep recipes, Etchants, FAST recipes
TOOLS
  Print labels                /d1-report/labels  (new tab, as QuickActions does today)
  Report a bug                /report-bug
  Data Studio                 /content
  Force Crawler               /d1-force-crawler  (admins only)
```

- **Visibility:** `GET /collections` already returns only the collections the user can read (and
  their folders): a Lab Member gets 19 of the 22 (no Etchants, Prep recipes, Machine operators).
  An entry whose collection is not in that list is not shown; a group left empty is not shown.
- **Bookmarks:** `GET /presets?filter[bookmark][_nnull]=true&fields=id,bookmark,collection,user,role,filter,search,layout_query,icon&sort=bookmark`.
  Directus lets every app user read global, role and own presets. Nested under their collection
  in any group (today only samples, operations and tests have any: 14 bookmarks). Order: global,
  then role, then own, each A-Z. No counts.
- **Collapsed state** of Inventory and Resources: `localStorage` per browser (wrapped in
  try/catch; default collapsed; a group containing the current page opens).
- **Active entry:** the current route (and `bookmark` query) is highlighted.
- **Narrow screens:** Directus's own navigation slide-out.

## 4. Routes

d1-home keeps its static routes (`''`, `register-sample`, `people`, `projects`, the five
`<collection>/:id` record pages) and adds **one** route, `:slug`, after them (vue-router ranks
static routes first), served by `IndexPage` with `slug` → `indexConfig`. An unknown slug shows a
"No such page" state with a link Home. 20 index pages: every visible collection except
Projects and People, which keep their bespoke pages (decision) and gain the sidebar.

## 5. Index pages

One generic page, one config entry per collection:

```ts
interface IndexDef {
  slug: string;              // URL: /home/<slug>
  collection: string;
  title: string;             // "Samples"
  group: 'records' | 'inventory' | 'resources';
  columns: ColumnDef[];      // field path, label, optional format ('date', 'bool', 'number', 'relation')
  searchFields: string[];    // the search box ORs _icontains over these (incl. dotted relations)
  filters: FilterDef[];      // chip filters: field + how options are loaded (relation / enum)
  fixedFilter?: object;      // always ANDed in (none planned today)
  defaultSort: string;       // '-created_at' etc.
  rowTarget: 'record' | 'drawer';   // record = its Explorer page (recordRoute); drawer = EditDrawer
}
```

**Query** (`indexQuery.ts`, pure): URL ⇄ state ⇄ Directus params. URL keys: `bookmark`, `q`,
`f.<field>` (one per chip filter), `sort`, `page`. The request is
`GET /items/<collection>?fields=<pk>,<columns>&filter=<AND of fixed, bookmark filter, chips, search>&sort=<s>&limit=50&page=<p>&meta=filter_count`.
- **Search** is an `_or` of `_icontains` over `searchFields` (not Directus's `search`, which
  touches every text column and is slow on 10,285 operations). An input that looks like a short ID
  (8+ hex, §6) also matches `short_id` exactly where the collection has one.
- **Bookmark:** its stored `filter` is passed through unchanged (`$CURRENT_USER`, `$NOW(-7 days)`
  are resolved by Directus), and its `search`, if any, fills `q`. Its columns and layout are
  ignored (decision). **Sort:** the bookmark's `layout_query.tabular.sort` is used when the URL has
  no `sort` (N-Q2).
- Bookmark, chips and search **stack**; everything lives in the URL, so a link reproduces the view
  and Back works.
- **Paging:** 50 rows, "Showing 1-50 of 1,206", previous/next. **Sort:** click a column header
  (asc → desc); default newest first where the collection has a date, else code A-Z (§5.1).
- **Rows:** `rowTarget = 'record'` (samples, operations, tests, campaigns) opens the Explorer
  page via `recordRoute`; every other row opens the existing `EditDrawer` over the list, and the
  list refreshes after a save. `?open=<pk>` opens the drawer on load (used by the finder).
- **Header actions:** "+ New" → `/content/<collection>/+` (Data Studio create form). "Open in Data
  Studio" → `/content/<collection>`, with `?bookmark=<id>` when a bookmark is the only constraint;
  with search or chips it opens the plain collection and says so in its tooltip (Directus has no
  URL parameter for an ad-hoc filter; N-Q3).
- **States:** loading (skeleton rows), empty ("Nothing matches. Clear filters"), 403/error
  (`NotVisible` / `LoadState`, as the record pages).

### 5.1 Column table (for the maintainer to check)

Columns in display order. "→" = relation shown by its display field. Sort = default sort.

| Slug | Collection | Columns | Search | Chip filters | Sort | Row |
|---|---|---|---|---|---|---|
| campaigns | campaigns | Code, Name, Project →, Type, Status, Start, End | campaign_code, name | Project, Status, Type | -start_date | record |
| samples | physical_samples | Code, Nickname, Material →, Project →, Form, Status, Location, Created | sample_code, nickname | Project, Status, Material | -created_at | record |
| operations | manufacturing_operations | Code (operationLabel), Sample →, Method →, Equipment →, Date, Operator, Outcome | pass_code, sample_id.sample_code, operator_name | Project, Method, Process category | -operation_date | record |
| tests | test_sessions | Code, Type, Sample →, Date, Status, Equipment → | test_code, test_type, sample_id.sample_code | Project, Type, Status | -session_date | record |
| tools | tools | Code, Name, Type, Manufacturer →, Active | tool_code, tool_name | Type, Active | -created_at | drawer |
| tool-boxes | tool_boxes | Code, Description, Insert type →, Location, Qty | tool_box_code, description | Insert type, Project | -created_at | drawer |
| inserts | cutting_inserts | Code, Tool box →, Insert type →, No., Depleted, Location | insert_code | Insert type, Depleted | -created_at | drawer |
| edges | insert_edges | Code, Insert →, Edge, Used | edge_code | Used | -created_at | drawer |
| stock-lots | raw_stock_lots | Code, Type, Material →, Supplier, Remaining (g), Received | lot_code, supplier_name | Type, Material | -received_date | drawer |
| equipment | equipment | Code, Name, Type, Facility →, Location, Active | equipment_code, equipment_name | Type, Facility, Active | -created_at | drawer |
| materials | materials | Alloy, Name, ISO class →, Density (g/cm³), Export controlled | alloy_code, common_name | ISO class, Export controlled | -created_at | drawer |
| machine-operators | Machine_Operators | Name, Equipment | Name | — | Name | drawer |
| insert-types | insert_types | Type code, Short code, Manufacturer →, ISO designation, Coating, Edges | type_code, short_code, iso_designation | Manufacturer, Op type | -created_at | drawer |
| iso-classes | material_iso_classifications | ISO code, Description | iso_code, description | — | iso_code | drawer |
| methods | manufacturing_methods | Code, Name, Process category | method_code, method_name | Process category | method_code | drawer |
| manufacturers | manufacturers | Name | name | — | name | drawer |
| facilities | facilities | Code, Name | code, name | — | code | drawer |
| prep-recipes | prep_recipes | Name, Suited materials, Created | name | — | -created_at | drawer |
| etchants | etchants | Name, Composition, Suited metals | name, composition | — | name | drawer |
| fast-recipes | fast_recipes | Name, Machine, Program, Group, Temp (°C), Force (kN), Hold (min), Changed | name, machine, group_name | Machine, Group | -date_changed | drawer |

Methods are sorted by code (a fixed list of 19, read as a reference table), Etchants by name.
Machine operators is the legacy list (people now carry `legacy_machine_operator_id`); it stays
because it is visible (N-Q4).

## 6. Finder (Ctrl K)

Opened by Ctrl K / ⌘K anywhere in the Explorer, or the sidebar box. One input, results grouped,
arrow keys + Enter, Esc closes.

| Source | How | Opens |
|---|---|---|
| Pages | `navConfig` labels (client-side) | the page |
| Bookmarks | the bookmarks already loaded for the sidebar | its index page with `?bookmark=` |
| Samples | `sample_code`, `nickname` `_icontains`; `short_id` exact | Sample page |
| Operations | `pass_code` `_icontains`; `short_id` exact | Operation page |
| Tests | `test_code` `_icontains`; `short_id` exact | Test page |
| Campaigns, Projects | code and name `_icontains` | their pages |
| People | `full_name` `_icontains` | `/home/people`, searched for that name |
| Inventory codes | `tool_code`, `tool_box_code`, `insert_code`, `edge_code`, `lot_code` `_icontains` | index page with the drawer open (`?open=`) |

- Remote sources run in parallel, **5 results each**, 200 ms debounce, stale responses dropped
  (`useRequestGate`). Only collections the user can read are queried (the `/collections` list).
- **Short IDs:** an input of 8+ hex characters is tried as a short ID on samples, operations and
  tests first and an exact hit is ranked top (the `short_ids` registry is not readable by Lab
  Members, so the three tables are queried directly).
- Ranking inside a group: exact code match, then prefix, then contains; groups in the table's
  order, with pages and bookmarks first.

## 7. Rewiring

- `recordRoute.ts`: `INDEX_PAGES` gains every slug of §5.1 (so `collectionRoute()` goes to the
  Explorer index for all 22), and a new `indexRoute(collection, { bookmark?, open? })`.
- Link texts that say "in the Data Studio (unfiltered)" change to "See all" / "Open the full
  list": `CampaignCards.vue:62`, `UnassignedLists.vue:33,50,67`, `SampleRecords.vue:42,65`, and
  NeedsAttention's fallback.
- **Home:** LabStats tiles → index pages; the Samples tile no longer needs `samplesBookmarkLink`
  (live has no global "Samples" bookmark; the helper can pick one person's own), so
  `samplesBookmark.ts` is deleted. NeedsAttention's "more" links → `indexRoute(c, { bookmark })`
  when the named bookmark is readable, else the plain index page. QuickActions' "more" chips that
  duplicate the sidebar (Projects, People, the dashboards, Force Crawler) are dropped (N-Q5);
  its three main actions stay.
- `home.vue` / `people.vue` admin checks use `host.isAdmin`.

## 8. Errors and edge cases

- `/collections`, `/presets` or `/policies/me/globals` failing: the sidebar shows the static
  entries (Home, Dashboards, Tools without Force Crawler) and a quiet "Couldn't load the list of
  pages" line with Retry; pages still work.
- A bookmark id in the URL that the user cannot read or that no longer exists: the page loads
  without it and says "That saved view isn't available".
- A chip filter on a relation the user cannot read: the chip is not offered.
- A row the user can see but not edit: the drawer opens read-only (EditDrawer already handles it
  through `useCanUpdate`).
- Very large collections (operations 10,285; FAST recipes 2,925): server paging and `filter_count`
  only; never load all rows.

## 9. Testing and delivery

- **Unit (vitest, `@d1/ui`):** `indexQuery` (URL ⇄ state round-trip; filter AND-ing with a
  bookmark filter containing `$CURRENT_USER`; search `_or` incl. relation paths; short-ID
  detection; sort precedence URL > bookmark > default), `navConfig` (visibility pruning, empty
  groups dropped, bookmark ordering), `finder` (ranking, short-ID priority, grouping), and a config
  check that every `indexConfig` collection exists in `navConfig` and every slug is unique.
- **Typecheck and build:** `npm run typecheck` for `@d1/ui` and d1-home; `npm run build -w
  directus-extension-d1-home`.
- **No schema change**, so no migration and no Directus smoke run. Deployment = rebuild d1-home in
  the main checkout and **restart Directus** (it caches app extension bundles).
- **Browser check on live** (mandatory, read-only): as admin and as a Lab Member — the sidebar
  shows the right entries (19 collections for the member), bookmarks nest and filter, an index
  page searches, sorts, pages and stacks a bookmark with a chip, a core row opens its page, an
  inventory row opens the drawer, "+ New" and "Open in Data Studio" go to the right place, Ctrl K
  finds a sample by code and by short ID, a test by its code and an edge by its code.

## 10. Questions for the maintainer (recommended answers assumed above)

- **N-Q1. Deploy route.** The main checkout has uncommitted edits to the same d1-home files
  (home.vue, LabStats, MyWork, NeedsAttention, QuickActions, …) on
  `feat/ownership-identity-cleanup`. Recommended: build N1 on `feat/explorer-nav`, then deploy by
  copying the built extension's source into the main checkout in one window (as for T0b),
  reconciling those files by hand and listing every overwritten hunk for you first.
- **N-Q2. Bookmark sort.** Use a bookmark's saved sort when the URL has none? Recommended: yes
  (operations bookmarks sort by date).
- **N-Q3. "Open in Data Studio" with search or chips.** Directus cannot take an ad-hoc filter in
  the URL. Recommended: open the plain collection (or the bookmark alone) and say so in the
  tooltip, rather than creating a temporary bookmark for the user.
- **N-Q4. Machine operators.** Keep its index page (it is visible today), or hide the legacy
  collection in Directus and drop it? Recommended: keep it for now.
- **N-Q5. Home "more" chips.** Drop the chips that the sidebar now duplicates? Recommended: yes.
- **N-Q6. The column table (§5.1).** Please check the columns, searches and chip filters per
  collection; anything not listed there is out.
