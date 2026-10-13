# Explorer sidebar B2: one sidebar, icon rail, pins and settings (design)

**Date:** 2026-10-13
**Status:** Design only. Decisions taken with the maintainer on 2026-10-13 from the mockup canvas
"D1 Sidebar Concepts" (claude.ai artifact, boards B2 and B2 collapsed). Plan:
[`2026-10-13-explorer-sidebar-b2.md`](../plans/2026-10-13-explorer-sidebar-b2.md).
**Supersedes:** decision 1 of [`2026-10-11-explorer-n1b-design.md`](2026-10-11-explorer-n1b-design.md)
(icon rail + panel). Decisions 2-6 there stand.

## Why

The N1b sidebar is a dark icon rail plus a light panel showing one section at a time. Seen in use, the
maintainer found:

- Home opens a whole panel with one link in it.
- The rail mixes an emoji (🔍) with text symbols (⌂ ▦ ∿ ⚙ ☰), so the glyphs differ in weight and baseline.
- "Tools" is a rail section and also a list under Kit, so one word means two things.
- Two columns take a lot of width, and nothing can be kept at hand across sections.
- The Explorer is to become its own website (N1 spec), so the sidebar must also carry what Directus
  supplies today: the brand, account, theme and settings.

## Decisions

1. **One dark sidebar, 224px wide**, in this order from the top:
   - The brand row (mark and name, from the host) with the collapse button.
   - Find, shown as a search field ("Find a record", `Ctrl K`).
   - **Home** as a plain link, then the **Pinned** list (decision 4).
   - A divider, then the sections as an **accordion**, only one open at a time: Records, Analysis,
     Kit, More. A section header shows its icon, name, chevron and, when closed, how many lists it
     holds ("Kit · 16").
   - The account row (name, role, theme toggle, settings gear) at the bottom.

   The section holding the current page opens when a page loads, and its header carries the
   current-page bar while it is closed.
2. **Sections and their lists are N1b's**, except that the rail section "Tools" is renamed **More**.
   It holds Print labels and Report a bug, plus an **Admin** sub-group with Data Studio (opens in a
   new tab) and Force Crawler. The section list stays data in `navConfig.ts`, as now.
3. **Item icons.** Every list has its own 16px outline icon, muted grey, white on the current page.
   Kit's 16 lists keep theirs. Icons are inline SVG from one open set (Lucide, ISC licence), held as
   path data in the kit, so no host icon component is needed. A list's icon is meant to follow its
   records into page headers, Find results and breadcrumbs (later work, not this stream). Long labels
   are cut to one line with "…", and the full name is in the tooltip.
4. **Sub-headings** (Inventory, Resources, Pinned, Admin) are 11px, in spaced-out capitals, dimmer
   than the items, with a hairline running to the edge and 12px of space above. They carry no icon,
   so they never read as items.
5. **Pins.** Any list with a page key (the U1 `PAGE_KEYS`) and any saved view the user can see can be
   pinned. Pinned items appear under Home in the user's own order. Each shows a lit pin on its left
   (click to unpin) and its own icon. A pinned saved view shows its list in grey ("Failed tests ·
   Tests").
   - **Defaults:** a user who has never changed their pins starts with **Samples, then Projects**.
     Once they have changed them, an empty list stays empty.
   - **Ways to pin, in the usual places:** the pin button that appears when you hover a row, the row's
     "⋯" menu or right-click, a **Pin / Pinned** toggle in the page header beside the title, and
     dragging a row into Pinned.
   - **Reorder:** drag with a drop line, `Alt+↑` / `Alt+↓` on a focused pin, or Move up / Move down
     in the "⋯" menu.
   - **One pin concept across the Explorer:** sidebar pins are the U1 "Frequently used" page pins.
     Pinning on Home pins in the sidebar too, and the reverse.
6. **Row "⋯" menu**, opened by the ⋯ button on hover or by right-click. It opens **to the right of
   the sidebar**, level with the row, never on top of the list.
   - **Lists:** Pin to sidebar / Unpin, Open in new tab, Copy link.
   - **Pinned items:** Unpin, Move up, Move down, Open in new tab, Copy link. Move up / Move down are
     disabled at the ends.
   - It closes on Esc, on a click outside or on choosing an item. It is a real `role="menu"` with
     focusable `menuitem`s. On touch screens (`hover: none`) the ⋯ and pin buttons are always shown.
7. **Collapsed: a 60px icon rail.** It has no text, and every label is in a tooltip. From the top:
   - The brand mark, then Find.
   - **Home**, then **one icon per pin**, 40×36 and in pin order. Each pin's tooltip shows its name
     and, for a saved view, its list.
   - A short divider, then **Records, Analysis, Kit, More**.
   - The expand button, then the account.

   Hovering a section icon opens a **hover menu** beside it, level with the icon. The menu holds
   that section's header and lists, the same as the expanded accordion, including the pin buttons.
   Moving into the menu keeps it open. Clicking the icon toggles it, for touch. Clicking the menu's
   header expands the sidebar with that section open. The menu is at most 480px tall and scrolls
   inside. With more than 6 pins, the rail shows the first 5 and a "+n" button whose hover menu
   lists all of them.
8. **Collapse rules.**
   - **Who controls it:** the collapse and expand buttons (also `[` and `]` when focus is not in a
     text field) choose the state, and the choice is **stored per user**.
   - **Narrow windows:** below **1000px** of window width the sidebar starts collapsed, whatever
     the stored choice. Expanding it there opens it **over** the page with a dimmed backdrop, and a
     click on the backdrop or Esc closes it. Widening the window again restores the stored choice.
   - **Inside Directus,** the sidebar lives in Directus's own navigation column, which it cannot
     resize. There it is always expanded and has no collapse button (`collapsible: false`), and
     Directus's own drawer handles narrow windows. Collapse is for the standalone site.
9. **Settings.** A **Settings** page at `/home/settings`, opened from the gear in the account row
   and, on the collapsed rail, from the account button. Its sections:
   - **Appearance:** theme (System / Light / Dark). This applies in the standalone site only. Inside
     Directus the row says the theme is set in Directus and links there.
   - **Sidebar:** a "Start collapsed" switch (the stored choice in decision 8), and "Collapse
     automatically on narrow windows" (on by default). Inside Directus both are shown disabled, with
     the note "Applies on the standalone site".
   - **Pinned:** the pins as a reorderable list (drag, or up/down buttons), with remove buttons and
     **Reset to defaults** (Samples, Projects), which asks to confirm.
   - **Lists:** "Forget my list views" clears the per-browser Table/Cards and density choices (N1b
     decision 4). They stay per-browser and are not moved to the server.
   - **Frequently used:** "Clear my history" (the U1 action, which keeps pins).

   Every setting saves as it changes; there is no Save button. A failed save shows "Couldn't save"
   beside the setting, with Retry, and the control returns to the stored value.
10. **Look.** Ground `#11181f`, text `#d3d9e0`, secondary `#9aa5b1`, hover `#1c2630`, current
    `#253140` with the `#8ab4f8` bar, the same colours as the N1b rail. The font is the host's. The
    values in the mockup are provisional until the Explorer has a DESIGN.md. In code they are tokens
    in `tokens.css`, not literals.

## Data

Migration `20261013000165_user_pins_and_prefs.sql`:

```sql
ALTER TABLE d1_private.user_usage
    DROP CONSTRAINT user_usage_kind_check,
    ADD CONSTRAINT user_usage_kind_check CHECK (kind IN ('page', 'record', 'view')),
    ADD COLUMN pin_order INTEGER;          -- position in the sidebar's Pinned list; NULL when not pinned

CREATE TABLE d1_private.user_prefs (
    user_id     UUID        PRIMARY KEY REFERENCES directus_users (id) ON DELETE CASCADE,
    pins_seeded BOOLEAN     NOT NULL DEFAULT FALSE,   -- the default pins were given (once)
    prefs       JSONB       NOT NULL DEFAULT '{}',    -- {sidebarCollapsed, autoCollapse, theme}
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **Saved views:** kind `view` is a saved view (a `directus_presets` row with a bookmark name), and
  its target is the preset id as text. The endpoint checks that the id is a positive integer. The
  client shows a view pin only if that view is among the user's visible bookmarks (`useExplorerNav`
  already loads them with `BOOKMARK_VISIBILITY_FILTER`). A pin to a view that was deleted or is no
  longer shared is skipped, not shown broken.
- **Pin order:** `pin_order` gives the order, gapless from 0. A pin added from the hover button, the
  menu, the header or Home goes last. A drop or a reorder rewrites the whole order in one request.
  Unpinning (including U1's `hide`) clears `pin_order`.
- **Preferences:** `prefs` is validated by the endpoint against a fixed list of keys and types.
  Unknown keys are rejected with 400. The kinds of preference are small and fixed, so JSONB avoids a
  migration for each new switch.
- Both tables stay in `d1_private`, outside the Directus schema scan, reached only through the
  endpoint, with no audit trigger (as in migration 163).

## Endpoint (`core/extensions/d1-usage`, extended)

Every route needs a signed-in user and touches only that user's rows, as now.

- `GET /d1-usage/nav` returns `{ pins: [{kind, target}], prefs: {...} }`. On the first call for a
  user with `pins_seeded = false`, it pins `samples` (order 0) and `projects` (order 1) and sets
  `pins_seeded`, in one transaction.
- `POST /d1-usage/pin` adds `kind: 'view'`. Pinning sets `pin_order` to the end, and unpinning
  clears it and closes the gap.
- `POST /d1-usage/pin-order {items: [{kind, target}]}` must list exactly the user's current pins,
  in the new order, or it gets 409, so a stale tab cannot drop a pin.
- `POST /d1-usage/prefs {key: value, ...}` merges the given keys into `prefs`.
- `POST /d1-usage/pins/reset` unpins everything, then pins Samples and Projects.
- `GET /d1-usage` (Home's lists) is unchanged, except that view rows are left out of it.

## Components (`packages/d1-ui`, host-neutral)

- `nav/navConfig.ts`: groups gain an `icon` per link and a `pageKey` where U1 has one. Tools is
  renamed More, with an Admin sub-group.
- `nav/sidebarModel.ts`, new and pure: the accordion sections; pins resolved against the visible nav
  and bookmarks (`resolvePins`); drop and keyboard reordering (`moveTo`, `moveBy`); rail overflow
  (`railPins`); the collapse rule (`effectiveCollapsed`).
- `nav/navIcons.ts`, new: the icon path data and their names.
- `nav/usePins.ts`, new: loads `/d1-usage/nav` once per session, pins and reorders optimistically,
  and rolls back if a request fails, with a short notice.
- `nav/ExplorerNav.vue` rewritten to compose `SidebarExpanded.vue`, `SidebarRail.vue`,
  `NavHoverMenu.vue`, `NavRowMenu.vue` and `NavIcon.vue`. Its props are `showBrand` and
  `collapsible`, and it emits `open-finder`. `NavRail.vue`, `NavPanel.vue` and `railModel.ts` are
  removed.
- `components/PinToggle.vue`: the header Pin / Pinned button. `IndexPage.vue` places it beside the
  title, and on a saved view (`?bookmark=`) it pins the view.
- `ExplorerHost.api` gains `post(path, body)`. The kit never imports `@directus/extensions-sdk`
  (existing guard test).
- **d1-home:** `ExplorerView.vue` passes `:collapsible="false"`. A new `pages/SettingsPage.vue`
  (route `/home/settings`) is built from kit parts.

## Accessibility

- The sidebar is a `<nav aria-label="Explorer">`. Accordion headers are buttons with
  `aria-expanded`.
- Hover menus also open on focus and close on Esc.
- Rail icons have `aria-label`. Pin buttons have `aria-pressed`.
- Dragging always has a keyboard equivalent (`Alt+↑` / `Alt+↓`, or Move up / Move down in the menu).
- Text contrast is at least 4.5:1 on `#11181f`. The sub-heading grey `#7f8a97` measures about
  5.0:1.

## Non-goals

- The standalone shell itself, and the theme switch outside it.
- Moving per-browser list preferences to the server.
- Record pins in the sidebar: U1's record pins stay on Home.
- Icons on record pages and in Find (decision 3 notes the intent only).

## Testing

- **Endpoint node tests:** the seeding happens once, an empty list stays empty after unpinning all,
  `pin-order` returns 409 on a mismatch, `view` targets are validated, prefs keys are validated, and
  every route touches only the caller's rows.
- **Migration:** applies up, down and up again (the db-migration skill).
- **Kit vitest:** sidebarModel (resolve, move, overflow, collapse rule), usePins (optimistic update
  and rollback), every `NAV_GROUPS` link has an icon, and the guard test stays green.
- **Preview,** as admin and as Lab Member:
  - pin, unpin and reorder in the expanded sidebar, then reload and see the pins come back;
  - the header Pin toggle on a list and on a saved view;
  - the ⋯ menu opens to the right of the sidebar;
  - Settings saves each switch;
  - inside Directus there is no collapse button.

  The collapsed rail and narrow-window behaviour are checked on an admin-only page,
  `/home/nav-preview`, which renders the sidebar with collapse on, because Directus does not use
  them.
