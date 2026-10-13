# Explorer sidebar B2 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the N1b icon rail + panel with one dark sidebar. It has accordion sections, item
icons, pins stored per user (drag, header toggle, ⋯ menu), a collapsed icon rail with hover menus, and
a Settings page.

**Architecture:** The pure rules go in `packages/d1-ui/src/nav/sidebarModel.ts` with vitest tests.
`usePins.ts` holds the per-user state behind the existing `d1-usage` endpoint, which gains pin order,
saved-view pins and a preferences row (migration 165). Vue components are host-neutral, and the
Directus host turns collapse off. The Settings page is a d1-home route.

**Tech Stack:** Vue 3 + TS, vitest (`npm test -w @d1/ui`), `node --test` for the endpoint, dbmate
migrations, Directus 11.17 extension builds, Lucide icon path data (ISC licence).

**Spec:** [`docs/superpowers/specs/2026-10-13-explorer-sidebar-b2-design.md`](../specs/2026-10-13-explorer-sidebar-b2-design.md)
(decisions 1-10). This plan argues from it; read both.

## Status

| Stream | Tasks | Worktree | Branch | Agent profile | State |
|---|---|---|---|---|---|
| S1 server | 1-2 | `.claude/worktrees/b2-server` | `feat/sidebar-b2-server` | `directus-ui-implementer` | not started |
| S2 kit models | 3-5 | `.claude/worktrees/b2-models` | `feat/sidebar-b2-models` | `directus-ui-implementer` | not started |
| S3 sidebar UI | 6-8 | `.claude/worktrees/b2-ui` | `feat/sidebar-b2-ui` (from S2) | `directus-ui-implementer` | blocked on S2 |
| S4 header pin, settings, docs | 9-11 | `.claude/worktrees/b2-settings` | `feat/sidebar-b2-settings` (from S3) | `directus-ui-implementer` | blocked on S3 |

S1 and S2 run in parallel. The coordinator merges S1 + S2 into `feat/sidebar-b2`, then S3 and S4 stack
on top of it. Review every stream with `directus-ui-reviewer`, and review migration 165 with the
`migration-review` skill.

## Global Constraints

- Workers commit after every task in their own worktree. They never push, merge or rebase. Commit
  trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The kit (`packages/d1-ui/src/nav`, `index`, `finder`, `host.ts`) never imports
  `@directus/extensions-sdk` (guard test `noSdkImports.test.ts`) and uses no Directus globals
  (`v-icon`, `v-button`).
- Sidebar widths: expanded **224px**, collapsed **60px**. Narrow window: **< 1000px**. Rail pins:
  **at most 6**, beyond that the first 5 and a "+n". Hover menus: **224px** wide, **480px** tall at
  most.
- Default pins: **`samples`, then `projects`**, given once per user (`pins_seeded`).
- Colours, as tokens in `tokens.css` (`--d1-side-*`): ground `#11181f`, text `#d3d9e0`, dim
  `#9aa5b1`, sub-heading `#7f8a97`, hairline `#263240`, hover `#1c2630`, current `#253140`, bar
  `#8ab4f8`.
- Copy is plain English in sentence case: "Find a record", "Pinned", "Pin to sidebar", "Unpin",
  "Move up", "Move down", "Open in new tab", "Copy link", "Drop here to pin", "Couldn't save your
  pins. Try again.", "Reset to defaults".
- Per-browser storage stays wrapped in try/catch with a working default (existing `navState.ts`
  pattern).
- Gates for every task: `npm test -w @d1/ui`; `npm run typecheck -w @d1/ui` and the d1-home
  typecheck report 0 errors; `npm run build -w directus-extension-d1-home`. Endpoint tasks also run
  `node --test core/extensions/d1-usage/index.test.mjs`.

## Review Focus

1. **Pins loaded while a link is unreadable.** A pinned list the user can no longer read, or a saved
   view that was deleted or unshared, is silently left out. It is never shown as a dead link, and
   it does not crash the sidebar. Test: Task 4, `resolvePins drops unknown targets`.
2. **Two tabs reorder at once.** `pin-order` with a stale list gets 409. The client then reloads its
   pins instead of overwriting them. Tests: Task 2 (409) and Task 5 (refetch on 409).
3. **The pins request fails.** The sidebar still renders every section. Pinned shows "Couldn't load
   your pins" with Retry, and pin buttons still work after Retry. Test: Task 5, `load failure`.
4. **Keyboard-only use.** Every pin action (pin, unpin, reorder, open the ⋯ menu, open a hover menu)
   works without a mouse. Tests: Task 4 (`moveBy` edges) and Task 7 (manual checklist in the
   preview).
5. **Inside Directus.** There is no collapse button, and the sidebar never shrinks to the rail in
   Directus's column, even below 1000px. Test: Task 4, `effectiveCollapsed` with
   `collapsible: false`.

---

### Task 1: Migration 165 — pin order, view pins, user preferences

**Files:**
- Create: `db/migrations/20261013000165_user_pins_and_prefs.sql`

**Interfaces:**
- Produces:
  - `d1_private.user_usage.kind` accepts `'view'`.
  - `d1_private.user_usage.pin_order INTEGER NULL`.
  - `d1_private.user_prefs (user_id UUID PK → directus_users ON DELETE CASCADE, pins_seeded BOOLEAN NOT NULL DEFAULT FALSE, prefs JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.

- [ ] **Step 1:** Write the migration with the db-migration skill, using the SQL in the spec's Data
  section. Add a `COMMENT ON` for the new column, the table and each of its columns, in the style
  of migration 163. Also set `pin_order = NULL` on any existing rows that are not pinned. Down:
  drop `user_prefs` and `pin_order`, delete the `kind = 'view'` rows, then restore the old CHECK.
- [ ] **Step 2:** Prove it applies up, down and up again, as the db-migration skill describes.
  Expected: all three succeed, and `\d d1_private.user_usage` shows `pin_order`.
- [ ] **Step 3:** Run the `migration-review` skill and fix what it reports.
- [ ] **Step 4:** Commit: `feat(db): user pin order, view pins and user prefs (migration 165)`.

### Task 2: `d1-usage` endpoint — nav, pin order, prefs, reset

**Files:**
- Modify: `core/extensions/d1-usage/index.js` (`validTarget`, `SQL`, `mount`, header comment)
- Test: `core/extensions/d1-usage/index.test.mjs` (extend `fakeDb` for `user_prefs` and `pin_order`)

**Interfaces:**
- Consumes: Task 1's columns.
- Produces the HTTP contract that Task 5 calls:
  - `GET /d1-usage/nav` returns `{ pins: Array<{kind:'page'|'view', target:string}>, prefs: {sidebarCollapsed?:boolean, autoCollapse?:boolean, theme?:'system'|'light'|'dark'} }`.
  - `POST /d1-usage/pin {kind:'page'|'record'|'view', target, pinned}` → 204. This route exists;
    `view` is new.
  - `POST /d1-usage/pin-order {items: Array<{kind,target}>}` → 204, or 409 `{error:'pins changed'}`.
  - `POST /d1-usage/prefs {sidebarCollapsed?, autoCollapse?, theme?}` → 204, or 400 for an unknown
    key or a wrong type.
  - `POST /d1-usage/pins/reset` → 204.
  - `validTarget('view', '42') === true`; `validTarget('view', 'x')` and `validTarget('view', '0')`
    are `false`.

- [ ] **Step 1: Write the failing tests** (node:test, same fakes as now):
  - `nav seeds samples and projects once`: the first GET for ALICE returns pins
    `[{page,samples},{page,projects}]`. After she unpins both, a second GET returns `[]`.
  - `nav lists pages and views in pin_order, not records`: a pinned record row is absent from
    `pins`.
  - `pin appends to the end and unpin closes the gap`: pin `operations`, and its order is 2. Unpin
    `samples`, and the orders become projects 0, operations 1.
  - `pin-order rewrites the order`, and `pin-order with a missing or extra item is 409 and changes
    nothing`.
  - `prefs merges known keys; unknown key or wrong type is 400`.
  - `pins/reset leaves exactly samples, projects`.
  - `hide clears pin_order` (U1's existing route).
  - `GET / leaves view rows out`.
  - `every new route touches only the caller's rows`: BOB's rows are unchanged after ALICE's calls.
- [ ] **Step 2:** Run `node --test core/extensions/d1-usage/index.test.mjs`. Expected: the new tests
  fail and the old ones pass.
- [ ] **Step 3: Implement.**
  - Keep each route in one `inTx` and take the existing advisory lock first.
  - Seeding happens inside the GET's transaction: `INSERT … ON CONFLICT DO NOTHING` on `user_prefs`,
    then pin the two defaults only if `pins_seeded` was false.
  - Compact the order with `row_number() OVER (ORDER BY pin_order) - 1`.
- [ ] **Step 4:** Run the tests. Expected: all pass.
- [ ] **Step 5:** Commit: `feat(d1-usage): sidebar pins with order, view pins, prefs`.

### Task 3: Nav config — icons, More/Admin, page keys

**Files:**
- Create: `packages/d1-ui/src/nav/navIcons.ts`, `packages/d1-ui/src/nav/NavIcon.vue`
- Modify: `packages/d1-ui/src/nav/navConfig.ts`, `packages/d1-ui/src/nav/navConfig.test.ts`
- Test: `packages/d1-ui/src/nav/navIcons.test.ts`

**Interfaces:**
- Produces:
  - `type NavIconName` and `NAV_ICONS: Record<NavIconName, IconNode[]>`, where
    `IconNode = { tag: 'path'|'circle'|'rect'|'line'|'polyline'|'polygon'|'ellipse'; attrs: Record<string,string> }`.
  - `NavIcon.vue` takes props `{ name: NavIconName; size?: number }` (default 16). It renders an
    `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`.
  - `NavLink` gains `icon: NavIconName`.
  - `NavGroup.id` becomes `'main'|'dashboards'|'records'|'inventory'|'resources'|'more'|'admin'`.
    `tools` is renamed `more` (Print labels, Report a bug), and the new `admin` group holds Data
    Studio and Force Crawler.

- [ ] **Step 1: Write the failing tests.**
  - `every NAV_GROUPS link has an icon present in NAV_ICONS`.
  - `no group is called tools`.
  - `admin group holds Data Studio and Force Crawler`.
  - `NAV_ICONS has the chrome icons`: `search, home, pin, ellipsis, settings, moon, sun,
    panel-left-close, panel-left-open, chevron-down, chevron-right, grip-vertical, x, external-link,
    link, arrow-up, arrow-down, filter`, plus the four section icons `records, analysis, kit, more`.
- [ ] **Step 2:** Run `npm test -w @d1/ui -- src/nav`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Copy each icon's child elements from `lucide-static@0.460.0`
    (`npm i --no-save lucide-static@0.460.0` in a scratch directory, then read
    `node_modules/lucide-static/icons/<name>.svg`). Credit "Lucide, ISC licence" in the file header.
  - Suggested Lucide names per link:
    - Records: folder, flag, test-tube, cog, clipboard-check, users.
    - Analysis: activity, zap.
    - Kit: wrench, briefcase, diamond, triangle-right, cylinder, drill, layers, hard-hat, shapes,
      tag, workflow, factory, building-2, flask-conical, droplet, flame.
    - More and Admin: printer, bug, database, radar.
    - Saved view: filter.
    - Sections: table-2, chart-line, box, layout-grid.

    Where a name is missing in that version, pick the closest one that exists and list the swap in
    the commit message.
  - Update the other users of `'tools'` (`grep -rn "'tools'" packages/d1-ui/src core/extensions`).
- [ ] **Step 4:** Run the tests and both typechecks. Expected: PASS, 0 errors.
- [ ] **Step 5:** Commit: `feat(d1-ui): nav icons and More/Admin groups`.

### Task 4: `sidebarModel.ts` — sections, pins, reorder, collapse rule

**Files:**
- Create: `packages/d1-ui/src/nav/sidebarModel.ts`, `packages/d1-ui/src/nav/sidebarModel.test.ts`

**Interfaces:**
- Consumes: `VisibleNav`, `linkForBookmark`, `linkActive` (existing); `pageTarget` from `../usage`;
  `NavIconName` (Task 3).
- Produces:
  ```ts
  export type SectionId = 'records' | 'analysis' | 'kit' | 'more';
  export interface PinRef { kind: 'page' | 'view'; target: string }
  export interface SidebarView { id: number; label: string; to: string; pin: PinRef }
  export interface SidebarLink { label: string; to: string; newTab: boolean; icon: NavIconName; pin: PinRef | null; views: SidebarView[] }
  export interface SidebarGroup { id: string; label: string | null; links: SidebarLink[] }
  export interface SidebarSection { id: SectionId; label: string; icon: NavIconName; groups: SidebarGroup[]; count: number }
  export interface ResolvedPin { ref: PinRef; label: string; hint: string | null; to: string; icon: NavIconName }
  export const NARROW_PX = 1000;
  export const RAIL_MAX_PINS = 6;
  export function sidebarSections(nav: VisibleNav): SidebarSection[];
  export function sectionForPage(sections: SidebarSection[], path: string, query: Record<string, unknown>): SectionId | null;
  export function pinKey(p: PinRef): string; // `${kind}:${target}`
  export function resolvePins(pins: PinRef[], sections: SidebarSection[]): ResolvedPin[];
  export function moveTo(pins: PinRef[], item: PinRef, index: number): PinRef[];
  export function moveBy(pins: PinRef[], item: PinRef, delta: -1 | 1): PinRef[];
  export function railPins(pins: ResolvedPin[]): { shown: ResolvedPin[]; overflow: ResolvedPin[] };
  export function effectiveCollapsed(o: { collapsible: boolean; stored: boolean; autoCollapse: boolean; windowWidth: number }): { collapsed: boolean; overlay: boolean };
  ```

- [ ] **Step 1: Write the failing tests.**
  - `sidebarSections` orders sections records, analysis, kit, more.
    - A section with no visible links is left out.
    - A section with one group has a group label of `null`. Kit's groups are labelled `Inventory`
      and `Resources`, and More's second group is `Admin`.
    - `count` is the number of links: Kit is 16 when everything is visible.
    - `link.pin` is `{kind:'page', target: pageTarget(link.to)}`, or `null` when there is no page
      key (Report a bug, Data Studio, Force Crawler).
    - A view's pin is `{kind:'view', target: String(id)}`, and its hint is the list's label.
  - `resolvePins drops unknown targets`: a page pin whose list is not visible, and a view pin whose
    id is not among the bookmarks, both disappear, and the order of the rest is kept.
  - `moveTo`:
    - inserts a new item at the given index;
    - moving an item down past itself lands it before the item that was at `index` (`[a,b,c]`,
      move `a` to 2 gives `[b,a,c]`);
    - moving to `length` puts it last.
  - `moveBy`: `[a,b,c]` with `b` and -1 gives `[b,a,c]`; `a` with -1 is unchanged; `c` with +1 is
    unchanged.
  - `railPins`: 6 pins are all shown; 7 pins give 5 shown and 2 in overflow.
  - `effectiveCollapsed`:
    - `{collapsible:false, stored:true, windowWidth:600}` gives `{collapsed:false, overlay:false}`;
    - `{collapsible:true, stored:false, autoCollapse:true, windowWidth:999}` gives
      `{collapsed:true, overlay:true}`;
    - the same with `windowWidth:1000` gives `{collapsed:false, overlay:false}`;
    - `autoCollapse:false` at 600 gives `{collapsed:stored, overlay:false}`.
  - `sectionForPage`: `/home/operations` gives `records`, `/home/samples?bookmark=3` gives
    `records`, and `/home` gives `null`.
- [ ] **Step 2:** Run `npm test -w @d1/ui -- src/nav/sidebarModel.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `sidebarSections` maps sections to group ids with a table:
  records → `records`, analysis → `dashboards`, kit → `inventory`+`resources`,
  more → `more`+`admin`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(d1-ui): sidebar model (sections, pins, reorder, collapse rule)`.

### Task 5: `usePins` and `ExplorerHost.api.post`

**Files:**
- Modify: `packages/d1-ui/src/host.ts` (`api.post(path: string, body?: unknown): Promise<{ data: any }>`),
  `core/extensions/d1-home/src/explorerHost.ts` (provide `post` from the Directus API)
- Create: `packages/d1-ui/src/nav/usePins.ts`, `packages/d1-ui/src/nav/usePins.test.ts`

**Interfaces:**
- Consumes: Task 2's HTTP contract; `PinRef`, `pinKey`, `moveTo` (Task 4).
- Produces:
  ```ts
  export interface NavPrefs { sidebarCollapsed: boolean; autoCollapse: boolean; theme: 'system' | 'light' | 'dark' }
  export const DEFAULT_PREFS: NavPrefs = { sidebarCollapsed: false, autoCollapse: true, theme: 'system' };
  export interface PinsState {
    pins: Ref<PinRef[]>; prefs: Ref<NavPrefs>; loaded: Ref<boolean>; loadFailed: Ref<boolean>; notice: Ref<string | null>;
    isPinned(p: PinRef): boolean; toggle(p: PinRef): Promise<void>; reorder(next: PinRef[]): Promise<void>;
    setPref<K extends keyof NavPrefs>(k: K, v: NavPrefs[K]): Promise<void>; resetPins(): Promise<void>; refresh(): Promise<void>;
  }
  export function usePins(host: ExplorerHost): PinsState; // one state per host, as useExplorerNav
  ```

- [ ] **Step 1: Write the failing tests** with a fake host whose `get` and `post` resolve or reject
  on demand:
  - `loads pins and prefs from /d1-usage/nav, filling missing prefs from DEFAULT_PREFS`.
  - `load failure`: `loaded` is true, `loadFailed` is true, `pins` is `[]`, and `refresh()` retries.
  - `toggle pins optimistically and posts /d1-usage/pin`. When the post rejects, the pin list
    returns to what it was and `notice` is `"Couldn't save your pins. Try again."`.
  - `reorder posts /d1-usage/pin-order; on 409 it refetches instead of keeping the local order`.
  - `setPref posts only that key`; on failure the old value comes back.
  - `two calls to usePins(host) share one state; one GET`.
- [ ] **Step 2:** Run `npm test -w @d1/ui -- src/nav/usePins.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Copy `useExplorerNav`'s module-scope `WeakMap` and in-flight join. A
  notice clears itself after 6 s.
- [ ] **Step 4:** Run the tests, both typechecks and the d1-home build. Expected: PASS, 0 errors.
- [ ] **Step 5:** Commit: `feat(d1-ui): usePins state with optimistic pins and prefs`.

### Task 6: Expanded sidebar — accordion, pinned list, row menu, drag

**Files:**
- Create: `packages/d1-ui/src/nav/SidebarExpanded.vue`, `packages/d1-ui/src/nav/NavRowMenu.vue`,
  `packages/d1-ui/src/nav/SidebarLinkRow.vue`
- Modify: `packages/d1-ui/src/nav/ExplorerNav.vue` (rewrite), `packages/d1-ui/src/components/tokens.css` (`--d1-side-*`)
- Delete: `NavRail.vue`, `NavPanel.vue`, `railModel.ts`, `railModel.test.ts`; `readSection`/`writeSection` in `navState.ts`, plus its tests

**Interfaces:**
- Consumes: Tasks 3-5.
- Produces:
  - `ExplorerNav.vue` props `{ showBrand?: boolean = true; collapsible?: boolean = true }`, emits
    `open-finder`. `ExplorerView.vue` still compiles unchanged.
  - `SidebarLinkRow.vue` props `{ link: SidebarLink | ResolvedPin; pinned: boolean; current: boolean; variant: 'list' | 'pinned' }`,
    emits `toggle-pin`, `open-menu(anchorRect: DOMRect)`, `dragstart`, `move(delta)`.
  - `NavRowMenu.vue` props `{ open: boolean; anchor: DOMRect | null; items: Array<{ id: string; label: string; icon: NavIconName; hint?: string; disabled?: boolean }> }`,
    emits `choose(id)` and `close`. It is positioned with `position: fixed` at
    `left = sidebar right edge + 4px` and `top = anchor.top - 4`, and stays inside the viewport.

- [ ] **Step 1:** Build the expanded layout exactly as spec decisions 1, 3, 4 and 5 describe: brand
  row, Find field, Home, Pinned, divider, accordion, account row.
  - The accordion opens `sectionForPage(...)` when the route changes. Otherwise only the user's
    clicks open and close sections.
  - Pinned rows show the lit pin on the left and a grip on hover.
  - List rows show the pin and ⋯ buttons on hover; both are always shown under
    `@media (hover: none)`.
- [ ] **Step 2:** Drag with HTML5 drag events:
  - a drop line appears before the hovered pinned row;
  - a "Drop here to pin" zone shows while dragging;
  - the drop calls `pins.reorder(moveTo(...))`;
  - `Alt+↑` / `Alt+↓` on a focused pinned row calls `moveBy`.
- [ ] **Step 3:** Row menu.
  - Items per spec decision 6: list rows get `pin | open-tab | copy-link`; pinned rows get
    `unpin | up | down | open-tab | copy-link`.
  - Open in new tab uses `router.resolve(to).href`; Copy link uses `navigator.clipboard.writeText`
    on the absolute URL.
  - Esc and a click outside close the menu, and focus returns to the ⋯ button.
- [ ] **Step 4:** Run `npm test -w @d1/ui`, both typechecks, and `npm run build -w directus-extension-d1-home`.
  Expected: PASS, 0 errors.
- [ ] **Step 5:** Check it in the Explorer preview as admin and as a Lab Member:
  - the sections open and close;
  - pin and unpin from the hover button, the ⋯ menu and by drag, then reload and the pins persist;
  - the ⋯ menu opens to the right of the sidebar;
  - a Lab Member sees no Admin group.

  Record screenshots in the PR.
- [ ] **Step 6:** Commit: `feat(d1-ui): one sidebar with accordion, pins and row menu`.

### Task 7: Collapsed rail, hover menus, auto-collapse

**Files:**
- Create: `packages/d1-ui/src/nav/SidebarRail.vue`, `packages/d1-ui/src/nav/NavHoverMenu.vue`
- Modify: `packages/d1-ui/src/nav/ExplorerNav.vue`
- Create: `core/extensions/d1-home/src/pages/NavPreview.vue`, plus an admin-only route
  `nav-preview` in `core/extensions/d1-home/src/index.ts`, registered before `:slug`. The page
  renders `<ExplorerNav :collapsible="true">` full height, so the rail can be checked inside
  Directus.

**Interfaces:**
- Consumes: `effectiveCollapsed`, `railPins`, `RAIL_MAX_PINS`, `NARROW_PX` (Task 4); `usePins().prefs` (Task 5).
- Produces:
  - `NavHoverMenu.vue` props `{ section: SidebarSection | null; pins?: ResolvedPin[]; anchor: DOMRect | null }`,
    emits `expand(sectionId)` and `close`.
  - Global keys `[` and `]` toggle collapse only when `collapsible` is true and focus is not in an
    input, textarea or contenteditable. The listener is added on mount and removed on unmount.

- [ ] **Step 1:** Rail per spec decision 7:
  - brand mark, Find, Home, pins (`railPins`, with a "+n" overflow hover menu), divider, the four
    sections, expand button, account;
  - tooltips via `aria-label` plus a visual tooltip on hover and focus.
- [ ] **Step 2:** Hover menus.
  - A menu opens on mouseenter and on focus of a section icon, and closes on mouseleave from the
    icon plus menu, and on Esc. A click toggles it.
  - It is placed level with the icon, at most 480px tall, and scrolls inside.
  - Clicking its header emits `expand`. ExplorerNav then expands with that section open and saves
    `sidebarCollapsed: false` (`setPref`).
- [ ] **Step 3:** Collapse rule.
  - Read `window.innerWidth` on mount and on `resize`, throttled with `requestAnimationFrame`.
  - `effectiveCollapsed` decides the state.
  - In overlay mode, expanding draws the sidebar `position: absolute` over the page, with a backdrop
    `rgba(13,17,23,.35)`. A backdrop click or Esc closes it. The narrow state is never written to
    `prefs`.
- [ ] **Step 4:** Run the gates. Then, in `/home/nav-preview`, check: the rail shows and its
  tooltips work; the hover menus work with the mouse and the keyboard; a 7th pin appears as "+2"
  (pin 7 in the preview data); below 1000px the sidebar is collapsed and opens over the page;
  widening restores the stored choice. In normal pages inside Directus there is no collapse button.
- [ ] **Step 5:** Commit: `feat(d1-ui): collapsed icon rail, hover menus, auto-collapse`.

### Task 8: Home's "Frequently used" stays in sync

**Files:**
- Modify: `core/extensions/d1-home/src/home/useFrequentlyUsed.ts`

**Interfaces:**
- Consumes: `usePins(host).refresh()` (Task 5).

- [ ] **Step 1:** After a successful pin or hide in `useFrequentlyUsed`, call
  `usePins(host).refresh()`. Then pinning a page on Home shows it in the sidebar without a reload.
- [ ] **Step 2:** Run the gates. In the preview, pin "Operations" on Home and see it appear last in
  Pinned. Unpin it in the sidebar and reload Home: it is unpinned there too.
- [ ] **Step 3:** Commit: `feat(d1-home): Home pins and sidebar pins stay in sync`.

### Task 9: Header Pin toggle

**Files:**
- Create: `packages/d1-ui/src/components/PinToggle.vue`
- Modify: `packages/d1-ui/src/index/IndexPage.vue` (beside the title), `packages/d1-ui/src/index.ts` (export)

**Interfaces:**
- Consumes: `usePins`, `pageTarget` (`../usage`).
- Produces: `PinToggle.vue` props `{ target: PinRef; label: string }`. It shows "Pin" or "Pinned"
  with `aria-pressed`. On an index page, the target is `{kind:'view', target: bookmark}` when
  `?bookmark=` is set, else `{kind:'page', target: pageTarget(route.path)}`. No toggle is shown
  when the page has no key.

- [ ] **Step 1:** Implement, with `IndexPage.vue` placing it after the title.
- [ ] **Step 2:** Run the gates. In the preview, Pin on Samples and on a saved view updates the
  sidebar at once, and Unpin there resets the button.
- [ ] **Step 3:** Commit: `feat(d1-ui): Pin toggle in the index page header`.

### Task 10: Settings page

**Files:**
- Create: `core/extensions/d1-home/src/pages/SettingsPage.vue`
- Modify: `core/extensions/d1-home/src/index.ts` (route `settings`, before `:slug`),
  `packages/d1-ui/src/nav/SidebarExpanded.vue` and `SidebarRail.vue` (gear → `/home/settings`),
  `packages/d1-ui/src/index/listPrefs.ts` (export `forgetListPrefs(): void`, which removes this
  module's keys)
- Test: `packages/d1-ui/src/index/listPrefs.test.ts` (`forgetListPrefs clears only list-pref keys`)

**Interfaces:**
- Consumes: `usePins` (`prefs`, `setPref`, `pins`, `reorder`, `toggle`, `resetPins`), `resolvePins`,
  the U1 `clear()` from `useFrequentlyUsed`.

- [ ] **Step 1:** Write the failing `forgetListPrefs` test, then implement it.
- [ ] **Step 2:** Build the page with the sections of spec decision 9, in that order:
  - **Appearance:** inside Directus it reads "Theme is set in your Directus account" with a link to
    `/users/me`. The theme switch renders only when the host says the site is standalone. Add
    `host.standalone?: boolean` to `ExplorerHost`; Directus leaves it unset.
  - **Sidebar:** "Start collapsed" and "Collapse automatically on narrow windows". Inside Directus
    both are shown disabled, with the note "Applies on the standalone site".
  - **Pinned:** a reorderable list with up and down buttons, drag and remove, then "Reset to
    defaults" with a confirm dialog ("Replace your pins with Samples and Projects?").
  - **Lists:** "Forget my list views".
  - **Frequently used:** "Clear my history".

  Each control saves as it changes. On a failure the control shows "Couldn't save" with Retry and
  goes back to the stored value.
- [ ] **Step 3:** Run the gates. In the preview: each setting persists after a reload; Reset gives
  Samples and Projects; a Lab Member can use every setting.
- [ ] **Step 4:** Commit: `feat(d1-home): Settings page`.

### Task 11: Docs and backlog

**Files:**
- Modify: `docs/superpowers/README.md` (the B2 row's status), `docs/superpowers/specs/2026-10-13-explorer-sidebar-b2-design.md`
  (Status line), `docs/runbooks/physical-test-backlog.md`, and this plan's Status table. (The README
  row and the superseded note on N1b decision 1 were added with the spec.)

- [ ] **Step 1:** Add the backlog items that can only be checked on live Directus with real data:
  - **#B2-1 — Pins with real saved views.** Pin a shared (role) saved view and a personal one, then
    log in as another member: they see only the shared one, and only if it is pinned by them.
  - **#B2-2 — Migration 165 on live.** It applies, existing U1 pins keep working, and every user
    gets Samples and Projects once.
- [ ] **Step 2:** Update the spec's Status line and its README row to *implemented YYYY-MM-DD*,
  naming the code paths.
- [ ] **Step 3:** Commit: `docs: B2 sidebar spec status, backlog items`.
