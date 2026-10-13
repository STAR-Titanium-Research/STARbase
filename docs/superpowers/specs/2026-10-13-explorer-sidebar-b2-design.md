# STARbase sidebar B2: one sidebar, icon rail, pins and settings (design)

**Date:** 2026-10-13
**Status:** Implemented 2026-10-13 on `claude/happy-sagan-875lo1` (not yet merged). Main code paths:
`packages/d1-ui/src/nav/`, `packages/starbase-pages/src/settings/` and `pages/SettingsPage.vue`,
`apps/starbase/web/src/AppShell.vue`, `core/extensions/d1-usage/`,
`db/migrations/20261013000170_user_pins_and_prefs.sql`. Decisions taken with the maintainer on 2026-10-13: first from the mockup canvas
"D1 Sidebar Concepts" (claude.ai artifact, boards B2 and B2 collapsed), then refined in a grilling
session. Plan: [`2026-10-13-explorer-sidebar-b2.md`](../plans/2026-10-13-explorer-sidebar-b2.md).
**Builds on:** STARbase ([`2026-10-12-starbase-standalone-design.md`](2026-10-12-starbase-standalone-design.md),
branch `feat/explorer-standalone`, being finalised). Implementation starts from `main` once STARbase is
merged, or else stacks on that branch.
**Supersedes:** decision 1 of [`2026-10-11-explorer-n1b-design.md`](2026-10-11-explorer-n1b-design.md)
(icon rail + panel). Decisions 2-6 there stand.
**Glossary:** [`CONTEXT.md`](../../../CONTEXT.md). This spec uses its terms: page, index page, saved view,
pin, section, Inventory, Reference, plotter.

## Why

The N1b sidebar is a dark icon rail plus a panel showing one section at a time. Seen in use, the
maintainer found:

- Home opens a whole panel with one link in it.
- The rail mixes an emoji (🔍) with text symbols (⌂ ▦ ∿ ⚙ ☰), so the glyphs differ in weight and baseline.
- "Tools" is a rail section and also an inventory index page, so one word means two things.
- Two columns take a lot of width, and nothing can be kept at hand across sections.

STARbase also gives the sidebar a whole window to itself, so the sidebar can now collapse. Inside
Directus it never could.

## Decisions

1. **One dark sidebar, 224px wide.** STARbase's shell draws the brand (the full STARbase logo) and the
   collapse button above it, and the account foot below it. In between, `ExplorerNav` draws:
   - **Find**, as a search field ("Find a record", `Ctrl K`).
   - **Home**, as a plain link, then the **Pinned** list (decision 5).
   - A divider, then the five **sections** as an **accordion**, only one open at a time: **Records,
     Analysis, Inventory, Reference, More**. A section header shows its icon, name, chevron and, when
     closed, how many pages it holds ("Reference · 11").

   The section holding the current page opens when a page loads, and its header carries the
   current-page bar while it is closed.
2. **Sections and their pages.**
   - **Records:** Projects, Campaigns, Samples, Operations, Tests, People.
   - **Analysis:** Force plotter, FAST plotter.
   - **Inventory:** Tools, Tool boxes, Cutting inserts, Insert edges, Raw stock lots.
   - **Reference:** Equipment, Materials, Machine operators, Insert types, ISO classes, Methods,
     Manufacturers, Facilities, Prep recipes, Etchants, FAST recipes.
   - **More:** Print labels, Report a bug, Settings, then an **Admin** sub-group with Data Studio (new
     tab) and Force Crawler.

   This list stays data in `navConfig.ts`.
3. **Icons.** Every page in the sidebar has its own 16px outline icon, muted grey, white on the current
   page.
   - **Source:** inline SVG from one open set (Lucide, ISC licence), held as path data in the kit, so no
     host icon component is needed.
   - **Records:** an index page's icon is also its records' icon. Record pins use it now, and record
     pages, Find and breadcrumbs may later.
   - **Long labels** are cut to one line with "…", and the full name is in the tooltip.
4. **Sub-headings** (Pinned, Admin) are 11px, in spaced-out capitals, dimmer than the items, with a
   hairline running to the edge and 12px of space above. They carry no icon, so they never read as items.
5. **Pins** (glossary: one pin per thing per person).
   - **What can be pinned:** an index page, a saved view, a task screen with a page key (Print labels,
     Register a sample) or a plotter. A **record** pinned from Home or from its record page also
     appears here.
   - **How they look:** pins appear under Home, in the person's own order, as one list. Each row
     shows a lit pin on its left (click to unpin), then its icon and label:
     - a page shows its name;
     - a saved view shows its name, with its index page in grey ("Failed tests · Tests");
     - a record shows its code (for example `S-0142`), with its kind's icon.
   - **Defaults:** everyone, whatever their role, starts with **Samples, then Projects**, given once.
     Someone who unpins both keeps an empty list.
   - **Ways to pin:**
     - the pin button that appears when you hover a row (always shown on touch screens);
     - the row's "⋯" menu or right-click;
     - a **Pin / Pinned** toggle in the header of index pages, saved views and record pages;
     - the pin toggle on Home's "Frequently used" rows;
     - dragging a row into Pinned.
   - **Reorder:** drag with a drop line, `Alt+↑` / `Alt+↓` on a focused pin, or Move up / Move down in
     the "⋯" menu.
   - **Many pins:** with more than **12**, Pinned shows the first 10 and a "Show all (n)" row. There is
     no hard limit.
   - **Pins you can't see any more:** a pin to something the person can no longer see (an index page
     their role lost, a saved view deleted or unshared, a record they can't read) is **not shown** in
     the sidebar. Settings → Pinned lists it under "No longer available", with Remove.
6. **Row "⋯" menu**, opened by the ⋯ button on hover or by right-click. It opens **to the right of the
   sidebar**, level with the row, never on top of the list.
   - **Section rows:** Pin / Unpin, Open in new tab, Copy link.
   - **Pinned rows:** Unpin, Move up, Move down, Open in new tab, Copy link. Move up / Move down are
     disabled at the ends.
   - It closes on Esc, on a click outside or on choosing an item. It is a real `role="menu"` with
     focusable `menuitem`s.
7. **Rail mode: 60px, icons only.** Every label is in a tooltip. From the top:
   - the star mark (`Star-Icon.svg`), then Find;
   - **Home**, then **one icon per pin**, in pin order. With more than 6 pins it shows the first 5 and
     a "+n" button whose hover menu lists all of them;
   - a short divider, then the five section icons;
   - the expand button, then the account.

   Hovering a section icon, or focusing it, opens a **hover menu** beside it, level with the icon. The
   menu holds that section's header and pages, the same as the expanded accordion, pin buttons
   included. Moving into the menu keeps it open. Clicking the icon toggles the menu, for touch.
   Clicking the menu's header expands the sidebar with that section open. The menu is at most 480px
   tall and scrolls inside.
8. **Who decides the layout: STARbase's shell, by window width.** `ExplorerNav` only renders the mode
   it is given (`expanded` or `rail`) and asks for a change.

   | Window width | Layout |
   |---|---|
   | **< 768px** | Phone (unchanged from STARbase). A top bar opens the sidebar, **expanded**, as a sheet. |
   | **768-999px** | **Rail** by default. Expanding opens the sidebar **over** the page with a dimmed backdrop. A backdrop click, Esc or choosing a page closes it. |
   | **≥ 1000px** | The person's saved choice, expanded or rail. The collapse and expand buttons (also `[` and `]` when focus is not in a text field) change it and save it **per user**. |

   "Collapse automatically on narrow windows" (Settings) can turn off the 768-999px rule.

   Inside Directus, the sidebar stays in Directus's navigation column, always **expanded**, with no
   collapse button.
9. **Settings** at `settings` among the STARbase routes (`/settings` in STARbase, `/home/settings`
   inside Directus). It is opened from the gear in the account foot and from More → Settings. Its
   sections:
   - **Appearance:** theme (System / Light / Dark), saved per user. STARbase applies it. Inside
     Directus the row says the theme is set in your Directus account, with a link there.
   - **Sidebar:** "Start collapsed" (the ≥ 1000px choice in decision 8) and "Collapse automatically on
     narrow windows" (on by default). Inside Directus both are shown disabled, with "Applies in
     STARbase".
   - **Pinned:** the pins as a reorderable list (drag, or up/down buttons), with remove buttons, the
     "No longer available" group, and **Reset to defaults**, which asks "Replace your pins with
     Samples and Projects?" first.
   - **Index pages:** "Forget my list views" clears the per-browser Table/Cards and density choices
     (N1b decision 4). They stay per-browser.
   - **Frequently used:** "Clear my history" (U1; keeps pins).

   Every setting saves as it changes; there is no Save button. A failed save shows "Couldn't save"
   beside the setting, with Retry, and the control returns to the stored value.
10. **Home's "Frequently used"** lists only things that are **not pinned**. Each row keeps its pin
    toggle; pinning moves the row into the sidebar. Home is "what you might want next" and the sidebar
    is "what you chose to keep".
11. **Look.** The sidebar is **dark in both themes**: ground `#11181f`, text `#d3d9e0`, secondary
    `#9aa5b1`, sub-heading `#7f8a97`, hairline `#263240`, hover `#1c2630`, current `#253140` with the
    `#8ab4f8` bar. The page content follows the theme. The values are provisional until STARbase has a
    DESIGN.md. In code they are `--d1-side-*` tokens in `tokens.css`. STARbase's `.sb-side` takes the
    same ground, so the brand and the foot match the sidebar.

## Not in this work

- **"Save this view"**, which creates saved views from STARbase, gets its own spec. Until then the
  sidebar only shows saved views made in Data Studio.
- Default pins per role, or pins chosen by an admin for others.
- Moving per-browser list preferences to the server.

## Data

Migration `20261013000170_user_pins_and_prefs.sql`:

```sql
ALTER TABLE d1_private.user_usage
    DROP CONSTRAINT user_usage_kind_check,
    ADD CONSTRAINT user_usage_kind_check CHECK (kind IN ('page', 'record', 'view')),
    ADD COLUMN pin_order INTEGER;          -- position among the person's pins; NULL when not pinned

CREATE TABLE d1_private.user_prefs (
    user_id     UUID        PRIMARY KEY REFERENCES directus_users (id) ON DELETE CASCADE,
    pins_seeded BOOLEAN     NOT NULL DEFAULT FALSE,   -- the default pins were given (once)
    prefs       JSONB       NOT NULL DEFAULT '{}',    -- {sidebarCollapsed, autoCollapse, theme}
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **Saved views:** kind `view` is a saved view (a `directus_presets` row with a bookmark name), and its
  target is the preset id as text. The endpoint checks that the id is a positive integer. The client
  shows a view pin only when that view is among the person's visible saved views (`useExplorerNav`
  loads them with `BOOKMARK_VISIBILITY_FILTER`).
- **Record pins** are U1's kind `record` (`<collection>:<uuid>`). Their codes are fetched through the
  items API as the person (U1's `recordRequest` / `recordEntries`), so a record they can't read fails
  to load and lands in "No longer available".
- **Pin order:** `pin_order` gives the order, gapless from 0, across all pins of every kind. A new pin
  goes last. A drop or a reorder rewrites the whole order in one request. Unpinning (including U1's
  `hide`) clears it.
- **Preferences:** the endpoint validates `prefs` against a fixed list of keys and types, and rejects
  unknown keys with 400.
- Both tables stay in `d1_private`, outside the Directus schema scan, reached only through the
  endpoint, with no audit trigger (as in migration 163).

## Endpoint (`core/extensions/d1-usage`, extended)

Every route needs a signed-in person and touches only that person's rows, as now.

- `GET /d1-usage/nav` returns `{ pins: [{kind, target}], prefs: {...} }`, with every pinned row in
  `pin_order`. On the first call for a person with `pins_seeded = false`, it pins `samples` (order 0)
  and `projects` (order 1) and sets `pins_seeded`, in one transaction.
- `POST /d1-usage/pin` gains `kind: 'view'`. Pinning sets `pin_order` to the end, and unpinning clears
  it and closes the gap.
- `POST /d1-usage/pin-order {items: [{kind, target}]}` must list exactly the person's current pins, in
  the new order, or it gets 409, so a stale tab cannot drop a pin.
- `POST /d1-usage/prefs {key: value, ...}` merges the given keys into `prefs`.
- `POST /d1-usage/pins/reset` unpins everything, then pins Samples and Projects.
- `GET /d1-usage` (Home's lists) now **leaves out pinned rows and view rows** (decision 10).

## Components

- **`packages/d1-ui` (host-neutral kit):**
  - `nav/navConfig.ts`: an icon per link; the sections Records, Analysis, Inventory, Reference and
    More (with Admin); "Force" and "FAST" become "Force plotter" and "FAST plotter".
  - `nav/sidebarModel.ts`, new and pure: the accordion sections; pins resolved against the visible nav,
    saved views and record codes (`resolvePins`, which also returns the unavailable ones); reordering
    by drop and by keyboard (`moveTo`, `moveBy`); the "Show all" cut (`pinnedListCut`); rail overflow
    (`railPins`); the layout rule (`layoutFor`).
  - `nav/navIcons.ts` and `NavIcon.vue`: the icon data and its renderer.
  - `nav/usePins.ts`: loads `/d1-usage/nav` once per session through `useExplorerHost().api`, pins
    and reorders optimistically, and rolls back with a short notice if a request fails.
  - `nav/ExplorerNav.vue` rewritten. It takes `mode: 'expanded' | 'rail'` (default `expanded`) and
    `collapsible: boolean` (default `false`), and emits `open-finder` and
    `request-mode(mode, sectionId?)`. It is built from `SidebarExpanded.vue`, `SidebarRail.vue`,
    `SidebarRow.vue`, `NavHoverMenu.vue` and `NavRowMenu.vue`. `NavRail.vue`, `NavPanel.vue` and
    `railModel.ts` are removed.
  - `components/PinToggle.vue`: the Pin / Pinned header button, used by `IndexPage.vue` (it pins the
    saved view when `?bookmark=` is set) and by the record pages' frame.
- **`packages/starbase-pages`:** a new `pages/SettingsPage.vue` at route `settings`, placed before
  `:slug`. `home/useFrequentlyUsed.ts` pins through the shared `usePins` state and filters its lists with it.
- **`apps/starbase/web`:**
  - `AppShell.vue`: the grid column is `224px` or `60px` from `layoutFor` and the saved choice; the
    overlay is used at 768-999px; the shell passes `mode` and `:collapsible="true"` and reacts to
    `request-mode`.
  - `narrow.ts` gains the 1000px query next to the phone one.
  - `ShellFoot.vue` gains the Settings gear and the theme toggle.
  - `theme.css` honours the saved theme.
- **The Directus module** (`d1-home`'s `DirectusFrame.vue`) renders `ExplorerNav` as before, with the
  defaults (`expanded`, not collapsible).

## Accessibility

- The sidebar is a `<nav aria-label="STARbase">`. Accordion headers are buttons with `aria-expanded`.
- Hover menus also open on focus and close on Esc.
- Rail icons have `aria-label`. Pin buttons have `aria-pressed`.
- Dragging always has a keyboard equivalent (`Alt+↑` / `Alt+↓`, or Move up / Move down).
- The overlay traps focus like STARbase's phone sheet does (`sheetFocus.ts`).
- Text contrast is at least 4.5:1 on `#11181f`. The sub-heading grey `#7f8a97` measures about 5.0:1.

## Testing

- **Endpoint node tests:**
  - seeding happens once, and an empty list stays empty;
  - the order spans pages, views and records;
  - `pin-order` returns 409 on a mismatch;
  - `view` targets are validated;
  - prefs keys are validated;
  - `GET /` leaves out pinned rows;
  - every route touches only the caller's rows.
- **Migration:** applies up, down and up again (the db-migration skill).
- **Kit vitest:**
  - sidebarModel (resolve with unavailable pins, move, "Show all" cut, overflow, the layout rule at
    767, 768, 999 and 1000px);
  - usePins (optimistic update, rollback, refetch on 409);
  - every `NAV_GROUPS` link has an icon;
  - the host-neutral guard tests stay green.
- **STARbase:**
  - unit tests for the shell's layout choice;
  - an e2e in `tests/ui/specs` covering pin, reorder and reload; rail and hover menu at 1280px; the
    overlay at 900px; the sheet at 600px; Settings saving.
- **Preview inside Directus:** the sidebar is expanded, there is no collapse button, and pinning works.
