# STARbase sidebar B2 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the N1b icon rail + panel with one dark sidebar. It has five accordion sections, icons,
per-user pins (pages, saved views, records; drag, header toggle, ⋯ menu) and a rail mode with hover
menus that STARbase's shell switches by window width. There is also a Settings page.

**Architecture:** The pure rules go in `packages/d1-ui/src/nav/sidebarModel.ts` (vitest). Per-user
state goes behind the existing `d1-usage` endpoint, which gains pin order, saved-view pins and a
preferences row (migration 170). `ExplorerNav` renders a mode it is given; STARbase's `AppShell`
chooses the mode from the window width and the saved preference. The Settings page lives in
`packages/starbase-pages`, so both hosts get it.

**Tech Stack:** Vue 3 + TS, vitest, `node --test` (endpoint), dbmate, Vite (STARbase), Playwright
(`tests/ui`), Lucide icon path data (ISC).

**Spec:** [`docs/superpowers/specs/2026-10-13-explorer-sidebar-b2-design.md`](../specs/2026-10-13-explorer-sidebar-b2-design.md)
(decisions 1-11). Glossary: [`CONTEXT.md`](../../../CONTEXT.md).

**Base:** STARbase (`feat/explorer-standalone`) is being finalised in a parallel session. Create
`feat/sidebar-b2` from `main` once STARbase has merged, or else from `origin/feat/explorer-standalone`,
and rebase onto `main` when it lands. Every path below is as it is on the STARbase branch
(`packages/starbase-pages`, `apps/starbase/web`, `useExplorerHost()`, `HostApi.post`).

## Status

| Stream | Tasks | Worktree | Branch | Agent profile | State |
|---|---|---|---|---|---|
| S1 server | 1-2 | `.claude/worktrees/b2-server` | `feat/sidebar-b2-server` | `directus-ui-implementer` | not started (waits on base) |
| S2 kit models | 3-5 | `.claude/worktrees/b2-models` | `feat/sidebar-b2-models` | `directus-ui-implementer` | not started (waits on base) |
| S3 sidebar + shell | 6-9 | `.claude/worktrees/b2-ui` | `feat/sidebar-b2-ui` (from S1+S2) | `directus-ui-implementer` | blocked on S1, S2 |
| S4 pin toggle, settings, docs | 10-12 | `.claude/worktrees/b2-settings` | `feat/sidebar-b2-settings` (from S3) | `directus-ui-implementer` | blocked on S3 |

S1 and S2 run in parallel. The coordinator merges them into `feat/sidebar-b2`, then S3 and S4 stack on
top. Review every stream with `directus-ui-reviewer`, and review migration 170 with `migration-review`.

## Global Constraints

- Workers commit after every task in their own worktree. They never push, merge or rebase. Trailer:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Kit and page sources stay host-neutral: no `@directus/extensions-sdk` (guard tests
  `noSdkImports.test.ts` and `starbase-pages/src/hostNeutral.test.ts`). The host is reached only through
  `useExplorerHost()`.
- Widths: expanded **224px**, rail **60px**, hover menu **224px** wide and at most **480px** tall.
- Window breakpoints: phone **< 768px** (STARbase's `PHONE_MAX_WIDTH = 767`), overlay rail **768-999px**,
  saved choice **≥ 1000px**.
- Pins:
  - default **`samples`, then `projects`**, given once (`pins_seeded`);
  - the rail shows **≤ 6** pins, otherwise 5 and "+n";
  - the Pinned list shows everything up to **12**, otherwise 10 and "Show all (n)".
- Sidebar colours, as `--d1-side-*` tokens in `packages/d1-ui/src/components/tokens.css`: ground
  `#11181f`, text `#d3d9e0`, dim `#9aa5b1`, sub-heading `#7f8a97`, hairline `#263240`, hover `#1c2630`,
  current `#253140`, bar `#8ab4f8`. They are the same in both themes.
- Copy is plain English in sentence case, as in the spec: "Find a record", "Pinned", "Pin", "Pinned",
  "Unpin", "Move up", "Move down", "Open in new tab", "Copy link", "Drop here to pin", "Show all (n)",
  "No longer available", "Couldn't save your pins. Try again.", "Reset to defaults", "Replace your pins
  with Samples and Projects?".
- Use the glossary's words (STARbase, index page, saved view, pin, plotter) in code comments and copy.
- Gates for every task:
  - `npm test -w @d1/ui`, `npm test -w @d1/starbase-pages` and the STARbase web tests, as the
    branch's `package.json` names them;
  - the typechecks of `@d1/ui`, `@d1/starbase-pages`, `apps/starbase/web` and `d1-home` report 0 errors;
  - `npm run build -w directus-extension-d1-home`.

  Endpoint tasks also run `node --test core/extensions/d1-usage/index.test.mjs`.

## Review Focus

1. **Pins to things the person can't see.**
   - An index page their role lost, a saved view deleted or unshared, or a record they can't read: none
     is shown in the sidebar, the sidebar never crashes, and each is listed under Settings → "No longer
     available".
   - Tests: Task 4, `resolvePins splits shown and unavailable`; Task 5, `record pin that 403s is
     unavailable`.
2. **Two tabs reorder at once.** `pin-order` with a stale list gets 409, and the client reloads instead
   of overwriting. Tests: Task 2 (409) and Task 5 (refetch).
3. **The pins request fails.** Every section still renders. Pinned says "Couldn't load your pins" with
   Retry, and pinning works after Retry. Test: Task 5, `load failure`.
4. **Resizing across 767, 768, 999 and 1000px.**
   - The layout switches without losing the saved choice, and the overlay closes when the window grows
     past 999px.
   - Tests: Task 4, `layoutFor` edges; Task 8, e2e at 1280, 900 and 600px.
5. **Keyboard-only use.**
   - Pin, unpin, reorder, the ⋯ menu, hover menus and the overlay all work without a mouse, and the
     overlay keeps focus inside it.
   - Tests: Task 4, `moveBy` edges; Task 8, e2e keyboard pass.

---

### Task 1: Migration 170 — pin order, view pins, user preferences

**Files:**
- Create: `db/migrations/20261013000170_user_pins_and_prefs.sql`

**Interfaces:**
- Produces:
  - `d1_private.user_usage.kind` accepts `'view'`.
  - `d1_private.user_usage.pin_order INTEGER NULL`.
  - `d1_private.user_prefs (user_id UUID PK → directus_users ON DELETE CASCADE, pins_seeded BOOLEAN NOT NULL DEFAULT FALSE, prefs JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.

- [ ] **Step 1:** Write the migration with the db-migration skill, using the spec's Data section.
  - Add a `COMMENT ON` for the new column, the table and each of its columns, in migration 163's style.
  - Number the existing pinned rows by `last_at` into `pin_order`, so U1 pins keep a stable order.
  - Down: drop `user_prefs` and `pin_order`, delete the `kind = 'view'` rows, then restore the old CHECK.
- [ ] **Step 2:** Prove it applies up, down and up again. Expected: all three succeed, and
  `\d d1_private.user_usage` shows `pin_order`.
- [ ] **Step 3:** Run `migration-review` and fix what it reports.
- [ ] **Step 4:** Commit: `feat(db): pin order, view pins and user prefs (migration 170)`.

### Task 2: `d1-usage` endpoint — nav, pin order, prefs, reset, Home without pins

**Files:**
- Modify: `core/extensions/d1-usage/index.js` (`validTarget`, `SQL`, `mount`, header comment)
- Test: `core/extensions/d1-usage/index.test.mjs` (extend `fakeDb` for `user_prefs` and `pin_order`)

**Interfaces:**
- Consumes: Task 1's schema.
- Produces the HTTP contract that Task 5 calls:
  - `GET /d1-usage/nav` returns `{ pins: Array<{kind:'page'|'view'|'record', target:string}>, prefs: {sidebarCollapsed?:boolean, autoCollapse?:boolean, theme?:'system'|'light'|'dark'} }`.
  - `POST /d1-usage/pin {kind, target, pinned}` → 204, now with `kind:'view'`.
  - `POST /d1-usage/pin-order {items}` → 204, or 409 `{error:'pins changed'}`.
  - `POST /d1-usage/prefs {...}` → 204, or 400.
  - `POST /d1-usage/pins/reset` → 204.
  - `GET /d1-usage` lists no pinned rows and no view rows.
  - `validTarget('view','42')` is true; `'x'` and `'0'` are false.

- [ ] **Step 1: Write the failing tests:**
  - `nav seeds samples and projects once`: the first GET returns `[{page,samples},{page,projects}]`.
    After unpinning both, the next GET returns `[]`.
  - `nav orders pages, views and records together by pin_order`.
  - `pin appends to the end and unpin closes the gap`.
  - `pin-order rewrites the order`, and `pin-order with a missing or extra item is 409 and changes
    nothing`.
  - `prefs merges known keys; unknown key or wrong type is 400`.
  - `pins/reset leaves exactly samples, projects`.
  - `hide clears pin_order`.
  - `GET / leaves out pinned rows and view rows`. This replaces the old "pinned first" test.
  - `every new route touches only the caller's rows`.
- [ ] **Step 2:** Run `node --test core/extensions/d1-usage/index.test.mjs`. Expected: the new tests
  fail.
- [ ] **Step 3: Implement.**
  - Each route runs in one `inTx`, taking the advisory lock first.
  - Seeding happens inside the GET's transaction.
  - Compact the order with `row_number() OVER (ORDER BY pin_order) - 1`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(d1-usage): sidebar pins with order, view pins, prefs`.

### Task 3: Nav config — five sections, icons, plotter names

**Files:**
- Create: `packages/d1-ui/src/nav/navIcons.ts`, `packages/d1-ui/src/nav/NavIcon.vue`,
  `packages/d1-ui/src/nav/navIcons.test.ts`
- Modify: `packages/d1-ui/src/nav/navConfig.ts`, `packages/d1-ui/src/nav/navConfig.test.ts`

**Interfaces:**
- Produces:
  - `type NavIconName` and `NAV_ICONS: Record<NavIconName, IconNode[]>`, where
    `IconNode = { tag: 'path'|'circle'|'rect'|'line'|'polyline'|'polygon'|'ellipse'; attrs: Record<string,string> }`.
  - `NavIcon.vue` takes props `{ name: NavIconName; size?: number }` (default 16) and renders an
    `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`.
  - `NavLink` gains `icon: NavIconName`.
  - `NavGroup.id` becomes `'main'|'records'|'analysis'|'inventory'|'reference'|'more'|'admin'`:
    `dashboards` → `analysis`, `resources` → `reference`, `tools` → `more`.
  - More holds Print labels, Report a bug and Settings (`/home/settings`); Admin holds Data Studio and
    Force Crawler.
  - Labels change "Force" → "Force plotter" and "FAST" → "FAST plotter".

- [ ] **Step 1: Write the failing tests:**
  - `every NAV_GROUPS link has an icon present in NAV_ICONS`.
  - `group ids are main, records, analysis, inventory, reference, more, admin`.
  - `More holds Settings; Admin holds Data Studio and Force Crawler`.
  - `NAV_ICONS has the chrome icons`: `search, home, pin, ellipsis, settings, moon, sun,
    panel-left-close, panel-left-open, chevron-down, chevron-right, grip-vertical, x, external-link,
    link, arrow-up, arrow-down, filter`, plus the section icons `records, analysis, inventory,
    reference, more`.
- [ ] **Step 2:** Run `npm test -w @d1/ui -- src/nav`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Copy each icon's child elements from `lucide-static@0.460.0`
    (`npm i --no-save lucide-static@0.460.0` in a scratch directory). Credit "Lucide, ISC licence" in
    the file header.
  - Suggested names:
    - Records: folder, flag, test-tube, cog, clipboard-check, users.
    - Analysis: activity, zap.
    - Inventory: wrench, briefcase, diamond, triangle-right, cylinder.
    - Reference: drill, layers, hard-hat, shapes, tag, workflow, factory, building-2, flask-conical,
      droplet, flame.
    - More: printer, bug, settings; Admin: database, radar.
    - Saved view: filter.
    - Sections: table-2, chart-line, package, book-open, layout-grid.

    Where a name is missing in that version, use the closest one that exists and list the swap in the
    commit.
  - Update every other user of the old group ids
    (`grep -rn "'tools'\|'resources'\|'dashboards'" packages apps core/extensions`).
- [ ] **Step 4:** Run the tests and typechecks. Expected: PASS, 0 errors.
- [ ] **Step 5:** Commit: `feat(d1-ui): five sidebar sections, icons, plotter names`.

### Task 4: `sidebarModel.ts` — sections, pins, reorder, layout rule

**Files:**
- Create: `packages/d1-ui/src/nav/sidebarModel.ts`, `packages/d1-ui/src/nav/sidebarModel.test.ts`

**Interfaces:**
- Consumes: `VisibleNav`, `linkForBookmark`, `linkActive` (existing); `pageTarget` and `RECORD_COLLECTIONS`
  from `../usage`; `NavIconName` (Task 3).
- Produces:
  ```ts
  export type SectionId = 'records' | 'analysis' | 'inventory' | 'reference' | 'more';
  export interface PinRef { kind: 'page' | 'view' | 'record'; target: string }
  export interface SidebarView { id: number; label: string; to: string; pin: PinRef }
  export interface SidebarLink { label: string; to: string; newTab: boolean; icon: NavIconName; collection: string | null; pin: PinRef | null; views: SidebarView[] }
  export interface SidebarGroup { id: string; label: string | null; links: SidebarLink[] }
  export interface SidebarSection { id: SectionId; label: string; icon: NavIconName; groups: SidebarGroup[]; count: number }
  export interface ResolvedPin { ref: PinRef; label: string; hint: string | null; to: string; icon: NavIconName }
  export interface RecordLabel { code: string; to: string }
  export type ShellLayout = { phone: true; mode: 'expanded'; overlay: false } | { phone: false; mode: 'expanded' | 'rail'; overlay: boolean };
  export const PHONE_MAX_PX = 767;
  export const RAIL_RULE_MAX_PX = 999;
  export const RAIL_MAX_PINS = 6;
  export const PINNED_SOFT_MAX = 12;
  export function sidebarSections(nav: VisibleNav): SidebarSection[];
  export function sectionForPage(sections: SidebarSection[], path: string, query: Record<string, unknown>): SectionId | null;
  export function pinKey(p: PinRef): string; // `${kind}:${target}`
  export function resolvePins(pins: PinRef[], sections: SidebarSection[], records: Map<string, RecordLabel>): { shown: ResolvedPin[]; unavailable: PinRef[] };
  export function moveTo(pins: PinRef[], item: PinRef, index: number): PinRef[];
  export function moveBy(pins: PinRef[], item: PinRef, delta: -1 | 1): PinRef[];
  export function pinnedListCut<T>(pins: T[], expanded: boolean): { shown: T[]; hidden: number };
  export function railPins<T>(pins: T[]): { shown: T[]; overflow: T[] };
  export function layoutFor(o: { width: number; savedRail: boolean; autoCollapse: boolean }): ShellLayout;
  ```

- [ ] **Step 1: Write the failing tests:**
  - **`sidebarSections`:**
    - orders the sections records, analysis, inventory, reference, more;
    - leaves out a section with no visible links;
    - gives a one-group section a group label of `null`, and labels More's second group `Admin`;
    - sets `count` to the number of links (Reference is 11 when everything is visible);
    - sets `link.pin` to `{kind:'page', target: pageTarget(link.to)}`, or `null` when there is no
      page key (Report a bug, Settings, Data Studio, Force Crawler);
    - gives a view the pin `{kind:'view', target:String(id)}`.
  - **`resolvePins splits shown and unavailable`:**
    - a page pin whose index page isn't visible, a view id not among the saved views, and a record
      key missing from `records` all go to `unavailable`;
    - `shown` keeps the original order;
    - a record pin's `label` is its code and its `icon` is its collection's link icon;
    - a view pin's `hint` is its index page's label.
  - **`moveTo`:**
    - inserts a new item at `index`;
    - with `[a,b,c]`, moving `a` to 2 gives `[b,a,c]`;
    - moving to `length` puts the item last.
  - **`moveBy`:** `b` with -1 in `[a,b,c]` gives `[b,a,c]`; the ends don't move.
  - **`pinnedListCut`:** 12 items are all shown; 13 show 10 with `hidden` 3; with `expanded: true`,
    all 13 are shown.
  - **`railPins`:** 6 are all shown; 7 give 5 shown and 2 in overflow.
  - **`layoutFor`:**
    - width 767 gives `{phone:true, mode:'expanded', overlay:false}`;
    - 768 with auto on gives `{phone:false, mode:'rail', overlay:true}`, and so does 999;
    - 1000 with `savedRail:false` gives `{mode:'expanded', overlay:false}`;
    - 1000 with `savedRail:true` gives `{mode:'rail', overlay:false}`;
    - 900 with auto off gives the saved choice and `overlay:false`.
  - **`sectionForPage`:** `/home/operations` gives `records`, `/home/samples?bookmark=3` gives
    `records`, `/home/equipment` gives `reference`, and `/home` gives `null`.
- [ ] **Step 2:** Run `npm test -w @d1/ui -- src/nav/sidebarModel.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Map sections to group ids with one table: records → `records`, analysis →
  `analysis`, inventory → `inventory`, reference → `reference`, more → `more`+`admin`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(d1-ui): sidebar model (sections, pins, reorder, layout rule)`.

### Task 5: `usePins` — per-user pins, record codes and prefs

**Files:**
- Create: `packages/d1-ui/src/nav/usePins.ts`, `packages/d1-ui/src/nav/usePins.test.ts`

**Interfaces:**
- Consumes: Task 2's HTTP contract; `useExplorerHost()`; `PinRef`, `pinKey`, `moveTo`, `RecordLabel`
  (Task 4); `recordRequest`, `recordEntries` and `splitRecordTarget` from `../usage`.
- Produces:
  ```ts
  export interface NavPrefs { sidebarCollapsed: boolean; autoCollapse: boolean; theme: 'system' | 'light' | 'dark' }
  export const DEFAULT_PREFS: NavPrefs = { sidebarCollapsed: false, autoCollapse: true, theme: 'system' };
  export interface PinsState {
    pins: Ref<PinRef[]>; records: Ref<Map<string, RecordLabel>>; prefs: Ref<NavPrefs>;
    loaded: Ref<boolean>; loadFailed: Ref<boolean>; notice: Ref<string | null>;
    isPinned(p: PinRef): boolean; toggle(p: PinRef): Promise<void>; reorder(next: PinRef[]): Promise<void>;
    setPref<K extends keyof NavPrefs>(k: K, v: NavPrefs[K]): Promise<void>; resetPins(): Promise<void>; refresh(): Promise<void>;
  }
  export function usePins(): PinsState; // one state per host (useExplorerHost()), like useExplorerNav
  ```

- [ ] **Step 1: Write the failing tests** with a fake host whose `get` and `post` resolve or reject on
  demand:
  - `loads pins and prefs from /d1-usage/nav, filling missing prefs from DEFAULT_PREFS`.
  - `loads record codes for record pins, one request per collection`.
  - `record pin that 403s is unavailable`: it is absent from `records`, and the other pins still load.
  - `load failure`: `loadFailed` is true, `pins` is `[]`, and `refresh()` retries.
  - `toggle is optimistic and posts /d1-usage/pin`. When the post rejects, the pins return to what
    they were and `notice` is `"Couldn't save your pins. Try again."`.
  - `reorder posts /d1-usage/pin-order; on 409 it refetches`.
  - `setPref posts only that key`; on failure the old value comes back.
  - `two calls share one state and one GET`.
- [ ] **Step 2:** Run `npm test -w @d1/ui -- src/nav/usePins.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `useExplorerNav`'s module-scope state and in-flight join. A notice
  clears itself after 6 s.
- [ ] **Step 4:** Run the gates. Expected: PASS, 0 errors.
- [ ] **Step 5:** Commit: `feat(d1-ui): usePins with record codes and prefs`.

### Task 6: Expanded sidebar — accordion, Pinned, row menu, drag

**Files:**
- Create: `packages/d1-ui/src/nav/SidebarExpanded.vue`, `SidebarRow.vue`, `NavRowMenu.vue` (all in
  `packages/d1-ui/src/nav/`)
- Modify: `packages/d1-ui/src/nav/ExplorerNav.vue` (rewrite), `packages/d1-ui/src/components/tokens.css` (`--d1-side-*`)
- Delete: `NavRail.vue`, `NavPanel.vue`, `railModel.ts`, `railModel.test.ts`; in `navState.ts`, the
  section memory (`SECTION_KEY`, `readSection`, `writeSection`) and its tests

**Interfaces:**
- Consumes: Tasks 3-5.
- Produces:
  - `ExplorerNav.vue` props `{ showBrand?: boolean = true; mode?: 'expanded' | 'rail' = 'expanded'; collapsible?: boolean = false }`.
    It emits `open-finder` and `request-mode(mode: 'expanded' | 'rail', sectionId?: SectionId)`.
  - `SidebarRow.vue` props `{ item: SidebarLink | ResolvedPin; variant: 'section' | 'pinned'; pinned: boolean; current: boolean }`.
    It emits `toggle-pin`, `open-menu(anchor: DOMRect)`, `dragstart` and `move(delta: -1 | 1)`.
  - `NavRowMenu.vue` props `{ open: boolean; anchor: DOMRect | null; items: Array<{ id: string; label: string; icon: NavIconName; hint?: string; disabled?: boolean }> }`.
    It emits `choose(id)` and `close`. It is `position: fixed` at
    `left = sidebar's right edge + 4px` and `top = anchor.top - 4`, clamped to the viewport.

- [ ] **Step 1:** Build the expanded layout per spec decisions 1-5:
  - Find, Home, Pinned (with `pinnedListCut`, "Show all (n)"), divider, then the accordion.
  - The accordion opens `sectionForPage(...)` when the route changes; otherwise only clicks open and
    close sections.
  - When `collapsible`, a collapse button emits `request-mode('rail')`.
- [ ] **Step 2:** Drag with HTML5 drag events:
  - a drop line appears before the hovered pinned row;
  - "Drop here to pin" shows while dragging;
  - the drop calls `reorder(moveTo(...))`;
  - `Alt+↑` / `Alt+↓` on a focused pinned row call `moveBy`.
- [ ] **Step 3:** Row menu.
  - Items per spec decision 6. Open in new tab uses `router.resolve(to).href`; Copy link uses
    `navigator.clipboard.writeText` on the absolute URL (through `links.ts`, so each host gets its
    own form).
  - Esc and a click outside close it, and focus returns to the ⋯ button.
  - On touch screens (`@media (hover: none)`) the ⋯ and pin buttons are always shown.
- [ ] **Step 4:** Run the gates. Expected: PASS, 0 errors.
- [ ] **Step 5:** Commit: `feat(d1-ui): one sidebar with accordion, pins and row menu`.

### Task 7: Rail mode and hover menus

**Files:**
- Create: `packages/d1-ui/src/nav/SidebarRail.vue`, `packages/d1-ui/src/nav/NavHoverMenu.vue`
- Modify: `packages/d1-ui/src/nav/ExplorerNav.vue` (render `SidebarRail` when `mode === 'rail'`)

**Interfaces:**
- Consumes: `railPins` (Task 4), `usePins` (Task 5), `SidebarRow` (Task 6).
- Produces: `NavHoverMenu.vue` props `{ section: SidebarSection | null; pins?: ResolvedPin[]; anchor: DOMRect | null }`.
  It emits `expand(sectionId)` and `close`.

- [ ] **Step 1:** Build the rail per spec decision 7:
  - the star mark slot (`#mark`, filled by the host), Find, Home, pins (with the "+n" overflow hover
    menu), divider, the five section icons, and an expand button that emits `request-mode('expanded')`;
  - tooltips via `aria-label` plus a visual tooltip on hover and on focus.
- [ ] **Step 2:** Hover menus:
  - open on mouseenter and on focus, close on mouseleave from the icon plus menu and on Esc, and
    toggle on click;
  - sit level with the icon, at most 480px tall, scrolling inside;
  - a click on the header emits `request-mode('expanded', sectionId)`.
- [ ] **Step 3:** Run the gates. Expected: PASS, 0 errors.
- [ ] **Step 4:** Commit: `feat(d1-ui): rail mode and hover menus`.

### Task 8: STARbase shell — layout by width, overlay, foot, theme

**Files:**
- Modify:
  - `apps/starbase/web/src/AppShell.vue`
  - `apps/starbase/web/src/narrow.ts` (add `useWindowWidth(): Ref<number>`)
  - `apps/starbase/web/src/ShellFoot.vue` (Settings gear → `/settings`, theme toggle)
  - `apps/starbase/web/src/theme.css` (`[data-theme]` override of `prefers-color-scheme`)
  - `apps/starbase/web/src/BrandLogo.vue` (a `mark` variant with only `Star-Icon.svg`)
- Test: `apps/starbase/web/src/shellView.test.ts` (or a new `shellLayout.test.ts`), plus
  `tests/ui/specs/15-sidebar-b2.spec.ts`

**Interfaces:**
- Consumes: `layoutFor`, `usePins().prefs` / `setPref` (Tasks 4-5), `ExplorerNav` (Tasks 6-7).

- [ ] **Step 1: Write the failing unit tests** for the shell's choice:
  - At 1280px with `sidebarCollapsed:false`, the column is `224px` and the mode `expanded`.
  - A `request-mode('rail')` at 1280px calls `setPref('sidebarCollapsed', true)`.
  - At 900px the column is `60px`; a `request-mode('expanded')` opens the overlay without calling
    `setPref`.
  - Growing to 1000px closes the overlay.
- [ ] **Step 2: Implement.**
  - The grid is `grid-template-columns: var(--sb-side-w) minmax(0,1fr)`, with `--sb-side-w` set from
    `layoutFor`.
  - `.sb-side` takes `--d1-side-ground`; the brand shows the full logo expanded and the star mark on
    the rail.
  - The overlay is an absolutely placed expanded sidebar with a backdrop `rgba(13,17,23,.35)`. It
    reuses the phone sheet's focus handling (`sheetFocus.ts`), and closes on a backdrop click, on Esc
    and on a route change.
  - `[` and `]` (outside text fields) request rail and expanded. The listener is removed on unmount.
  - The phone sheet stays as it is, with `mode="expanded"`.
  - `ShellFoot` gets the Settings gear and a theme toggle (`setPref('theme', …)`), and `theme.css`
    applies `data-theme` on `<html>` when the preference is not `system`.
- [ ] **Step 3:** Write the e2e `15-sidebar-b2.spec.ts` with the branch's fake server:
  - pin Operations, reload, and it is still pinned, last;
  - reorder by `Alt+↑`;
  - at 1280px: collapse, then a hover menu on Inventory;
  - at 900px: the overlay opens and Esc closes it;
  - at 600px: the sheet shows the expanded sidebar;
  - a keyboard-only pass over pin, menu and hover menu.
- [ ] **Step 4:** Run the gates and the e2e. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(starbase): sidebar layout by window width, overlay, foot, theme`.

### Task 9: Home's "Frequently used" without pins

**Files:**
- Modify: `packages/starbase-pages/src/home/useFrequentlyUsed.ts`, `packages/starbase-pages/src/home/FrequentlyUsed.vue`

**Interfaces:**
- Consumes: `usePins().refresh()` and `toggle` (Task 5); `GET /d1-usage` without pinned rows (Task 2).

- [ ] **Step 1:** Pinning from a row calls `usePins().toggle({kind, target})` and drops the row from the
  list. Remove the "pinned first" ordering and its 📌 styling. Pins are now shown only in the sidebar.
- [ ] **Step 2:** Run the gates. In the preview, pin "Operations" on Home: it leaves Home's list and
  appears last in Pinned. Unpin it in the sidebar, and it comes back to Home on the next load.
- [ ] **Step 3:** Commit: `feat(starbase-pages): Frequently used lists only unpinned items`.

### Task 10: Pin / Pinned header toggle

**Files:**
- Create: `packages/d1-ui/src/components/PinToggle.vue`
- Modify:
  - `packages/d1-ui/src/index/IndexPage.vue` (beside the title)
  - `packages/d1-ui/src/components/RecordLayout.vue` (a `#title-actions` slot)
  - the five record pages in `packages/starbase-pages/src/pages/` (fill that slot with
    `recordTarget(...)`)
  - `packages/d1-ui/src/index.ts` (export)

**Interfaces:**
- Consumes: `usePins`, `pageTarget`, `recordTarget` (`../usage`).
- Produces: `PinToggle.vue` props `{ target: PinRef; label: string }`. It shows "Pin" or "Pinned" with
  `aria-pressed`.
  - On an index page it pins `{kind:'view', target: bookmark}` when `?bookmark=` is set, else the page.
  - On a record page it pins the record.
  - Nothing is shown when there is no key.

- [ ] **Step 1:** Implement and place it.
- [ ] **Step 2:** Run the gates. In the preview:
  - Pin on Samples, on a saved view and on a sample's record page updates Pinned at once (the record
    shows its code);
  - unpinning in the sidebar resets the button.
- [ ] **Step 3:** Commit: `feat(d1-ui): Pin toggle in index and record page headers`.

### Task 11: Settings page

**Files:**
- Create: `packages/starbase-pages/src/pages/SettingsPage.vue`
- Modify:
  - `packages/starbase-pages/src/routes.ts` (`{ path: 'settings', component: SettingsPage }` before `:slug`)
  - `packages/starbase-pages/src/routes.test.ts`
  - `packages/d1-ui/src/index/listPrefs.ts` (export `forgetListPrefs(): void`)
- Test: `packages/d1-ui/src/index/listPrefs.test.ts`

**Interfaces:**
- Consumes:
  - `usePins` (`prefs`, `setPref`, `pins`, `records`, `reorder`, `toggle`, `resetPins`);
  - `resolvePins` (its `unavailable` list);
  - U1's `clear()`;
  - a new optional `ExplorerHost.appearance?: 'own' | 'directus'`. STARbase's host sets `'own'`; the
    Directus host leaves it unset.

- [ ] **Step 1:** Write the failing tests:
  - `forgetListPrefs clears only list-pref keys`;
  - `routes.test: settings resolves to SettingsPage, not IndexRoute`.

  Then implement them.
- [ ] **Step 2:** Build the page with spec decision 9's sections, in that order:
  - **Appearance:** the theme choice when `appearance === 'own'`. Otherwise "Theme is set in your
    Directus account", with a link.
  - **Sidebar:** both switches. They are disabled, with "Applies in STARbase", unless
    `appearance === 'own'`.
  - **Pinned:** the reorderable list (up and down buttons, drag, remove), then "No longer available",
    each with Remove, then "Reset to defaults" behind a confirm.
  - **Index pages:** "Forget my list views".
  - **Frequently used:** "Clear my history".

  Each control saves as it changes. On a failure it shows "Couldn't save" with Retry and goes back to
  the stored value.
- [ ] **Step 3:** Run the gates. In the preview:
  - each setting persists after a reload;
  - Reset gives Samples and Projects;
  - a Lab Member can use every setting;
  - inside Directus, `/home/settings` opens with the Sidebar switches disabled.
- [ ] **Step 4:** Commit: `feat(starbase-pages): Settings page`.

### Task 12: Docs and backlog

**Files:**
- Modify: `docs/superpowers/README.md` (the B2 row's status), the spec's Status line,
  `docs/runbooks/physical-test-backlog.md`, and this plan's Status table.

- [ ] **Step 1:** Add the backlog items that can only be checked on live Directus with real data:
  - **#B2-1 — Saved-view pins across people.** Pin a role-shared saved view and a personal one. As
    another member of that role, only the shared one is pinnable, and their pins are their own.
  - **#B2-2 — Migration 170 on live.** It applies, existing U1 pins keep their order, and each person
    gets Samples and Projects once.
  - **#B2-3 — Record pins after access changes.** Pin a record, then remove the person's access: the
    pin moves to Settings → "No longer available".
- [ ] **Step 2:** Set the spec's Status line and its README row to *implemented YYYY-MM-DD*, with the
  code paths.
- [ ] **Step 3:** Commit: `docs: B2 sidebar spec status, backlog items`.
