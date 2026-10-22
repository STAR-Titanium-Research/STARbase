# STARbase Design Language

> STARbase is the lab's record explorer for the STAR titanium research group: samples, operations, tests,
> campaigns and projects, read and edited by researchers and technicians on desktops in the lab and on
> phones at the machine. The same kit (`@d1/ui`) also renders inside the Directus Data Studio.

This file describes the design language **as it is in the code** (October 2026). The source of truth for every
value is the code, in this order:

1. `apps/starbase/web/src/theme.css`: the theme variables (`--theme--*`), light and dark.
2. `packages/d1-ui/src/components/tokens.css`: the kit's tokens (`--fs-*`, `--d1-*`), derived from the theme.
3. The kit components in `packages/d1-ui/src/components/` and `packages/d1-ui/src/nav/`.

When this file and the code disagree, the code wins. Fix this file in the same PR.
Sections marked **Proposed** are agreed directions that are not in the code yet. Their mock-ups are on the design
canvas "STARbase list page layouts" (https://claude.ai/artifact/ReQ6RAtcoER1eb83VRPetN); the newest row of each
topic is the agreed one.

---

## 1. Visual Theme

**Theme statement:** quiet, dense, trustworthy instrument.

**Character:** A lab notebook that happens to be a web app. Pages are mostly data: codes, counts, statuses and
dates, laid out in opaque panels on a pale ground, with one dark sidebar framing everything. Colour is
reserved for meaning: status, links, the current page. It is never decoration. Type is small, at 13px body,
because researchers want to see a whole sample's history without scrolling. Weight and alignment do the
hierarchy work that size does elsewhere.

**References:**
- The force app (`apps/force-app/web`): the panel-with-a-lid, the type scale and the stat tile all come from it.
- Directus Data Studio: the theme variables and the light/dark model, so the kit works inside it unchanged.
- GitHub's dark theme (`#0d1117` ground, `#161b22` panel): the dark palette.
- Linear and similar sidebars: the dark rail with icon slots, tooltips and hover menus.

---

## 2. Color Palette

All colours are **theme variables**. Components never hold raw hex, except the sidebar, which is dark in both
themes and has its own fixed set. Light is the lab's "Directus Color Match" on the project navy
`#18222f`. Dark is "Directus Default" with a lifted primary. Values below are the computed results of the
`color-mix()` rules in `theme.css`.

### Ground and surfaces (theme ladder)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--theme--background` | `#eff0f0` (white + 7% navy) | `#0d1117` | Page ground |
| `--theme--background-subdued` | `#e8e9ea` | `#161b22` | Light: tile. Dark: panel |
| `--theme--background-normal` | `#dcdee0` | `#21262e` | Neutral badge fill, progress track. Dark: tile |
| `--theme--background-accent` | `#d1d3d5` | `#30363d` | Active list row |
| `--theme--border-color` | `#d1d3d5` | `#21262e` | Input borders |
| `--theme--border-color-subdued` | `#dcdee0` | `#21262d` | Hairlines, panel borders |
| `--theme--form--field--input--background` | `#ffffff` | `#161b22` | Inputs. Light: panel surface |

### Kit surface tokens (`tokens.css`)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--d1-surface` | `#ffffff` | `#161b22` | A panel, rail or raised card: one step off the ground |
| `--d1-tile` | `#e8e9ea` | `#21262e` | A panel lid, a card inside a panel, a row hover: one step off the surface |
| `--d1-line` | `#dcdee0` | `#21262d` | Every hairline |

The ladder is **ground → surface → tile**. Never put a tile colour on the ground or a surface inside a surface.

**Proposed** (from the design review, 16 Oct 2026):

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--d1-control-line` | `#868c93` (3.4:1 on white) | `#66717c` (3.5:1) | Outlines of controls a person must find: segmented controls, inputs. WCAG 1.4.11 needs 3:1; `--d1-line` is 1.35:1 |
| `--d1-panel-line` | `--d1-line` | `#30363d` | Panel borders. In dark, a panel is only 1.09:1 against the ground, so the border carries the edge |

### Chart series

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--d1-chart-1` | `#2a78d6` | `#3987e5` | Operations; slot 1 of every chart |
| `--d1-chart-2` | `#d0459a` (4.2:1 on white) | `#ff99dd` | Tests; second series. The theme's `#ff99dd` is 1.9:1 on white |

### Text

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--theme--foreground` | `#111821` | `#c9d1d9` | Primary text and values |
| `--d1-dim` | `#585d63` (about 6:1) | `#8d949b` | Secondary text: labels, meta, captions |
| `--theme--foreground-subdued` | `#747a82` | `#666672` | **Avoid for text.** About 3.8:1 on the ground. Use `--d1-dim` |

### Brand and accent

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--theme--primary` | `#18222f` (lab navy) | `#6b9bd6` | Native Directus controls only |
| `--d1-accent` | `#18222f` | `#a8bed8` (primary lifted 65% toward the text) | Kit text, icons, borders and fills in the brand colour: record links, the kind pill, count chips, the current-page bar, active segment |
| `--d1-on-accent` | `#ffffff` | `#0d1117` | Text or icon on a solid accent fill |
| `--d1-tint` | accent at 10% | accent at 10% | Icon wells, soft accent backgrounds |
| `--theme--secondary` | `#ff99dd` | `#ff99dd` | Sign-in wash only. Charts use `--d1-chart-2` for tests |

Always write `var(--d1-accent, var(--theme--primary))`. Some kit components also render outside the page frame,
where `--d1-accent` is not set.

### Semantic (status)

A status is a **tone**, never a hex. `status.ts` maps every status vocabulary (tests, force analysis, diagnostics,
samples, campaigns) to one of six tones. `StatusBadge` maps the tone to colours. The ink is the theme's fill
mixed toward the text colour, so it reads on its own tint in both themes.

| Tone | Ink, light / dark | Fill | Used for |
|---|---|---|---|
| `success` | `#207264` / `#7ccfc0` (`--d1-ok`) | success `#2ecda7` at 18% | Active, Processed, Analysed |
| `warning` and `progress` | `#885e2d` / `#e4ba89` (`--d1-warn`) | warning `#ffa439` at 18% | Processing, Analysing, Consumed |
| `danger` | `#8f3a4c` / `#d98496` (`--d1-bad`) | danger `#e35169` at 14% | Failed, Error, Destroyed |
| `info` | `--d1-accent` | accent at 12% | Planned, Queued, Pending |
| `neutral` | `--d1-dim` | `--theme--background-normal` | Registered, Archived, Complete, Skipped |

The Conform run status (`conform` kind, words from `CONFORM_STATUS` in `@d1/fast-plotting`'s `conform/format.ts`) is the
same on the Operation page, the plotter's run list and badge: **No log** (neutral), **No run window** (warning),
**Window set** (success), **Failed** (danger).

### Sidebar (fixed, dark in both themes)

| Token | Value | Usage |
|---|---|---|
| `--d1-side-ground` | `#11181f` | Sidebar background |
| `--d1-side-text` | `#d3d9e0` | Row text |
| `--d1-side-dim` | `#9aa5b1` | Idle icons |
| `--d1-side-sub` | `#7f8a97` | Sub-labels (5.0:1) |
| `--d1-side-hairline` | `#263240` | Dividers, hover-menu border |
| `--d1-side-hover` | `#1c2630` | Hovered row or icon |
| `--d1-side-current` | `#253140` | Current row or icon, tooltip pill |
| `--d1-side-bar` | `#8ab4f8` | 3px current-page bar, badges, focus ring |

These are marked **provisional** in `tokens.css` ("until STARbase has a DESIGN.md"). This file now adopts them as is.

---

## 3. Typography

**Font families:**
- Sans (everything): `'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` (`--theme--fonts--sans--font-family`)
- Mono (record codes, sample IDs, file names): `'Fira Mono', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace` (`--theme--fonts--monospace--font-family`)
- Icons: Material Symbols Rounded, as a ligature font in a fixed 1em box

**Scale:** a fixed, ad-hoc dense scale, roughly 1.1 to 1.2 between steps. **11px is the floor.** Every font size is
written `var(--fs-*, <px>)`, with the px fallback so it also works outside the page frame.

| Token | Size | Usage | Line height | Used |
|---|---|---|---|---|
| `--fs-xs` | 11px | Badges, count chips, units, tile labels, table heads | 1.6 in pills, else 1.35 | 107 |
| `--fs-sm` | 12px | Hints, meta, captions, breadcrumbs, segmented options | 1.45 | 255 |
| `--fs-md` | 13px | **Body**, tables, panel titles, fact rows | 1.45 (page), 1.3 (titles) | 108 |
| `--fs-lg` | 15px | Card codes, key values | 1.25 | 16 |
| `--fs-xl` | 18px | Page title (header), record code in the rail | 1.25 | 11 |
| `--fs-2xl` | 22px | Big counts (stat tiles), sign-in heading | 1.15 | 4 |

**Weights:** 400 body · 600 values, labels and buttons (the workhorse) · 650 panel titles and the current nav
entry · 700 codes, counts, badges and headings. 500 and 800 are each used only a few times and should not spread.

**Numbers:** `font-variant-numeric: tabular-nums` on every count, value and table number.

**Codes:** record codes (sample IDs such as `94-AA-MF-2024-10-30`, campaign `10`) are mono and bold.

---

## 4. Components

All in `@d1/ui` (`packages/d1-ui/src/components`, `.../nav`). Pages compose these. They do not restyle them.

| Component | Level | Purpose | Key variants and states |
|---|---|---|---|
| `PageShell` | Template | The frame of every page: left edge, max width, type scale, 16px block gap | default (1440px), `narrow` (920px), `wide` (none) |
| `RecordLayout` | Template | Record page: sticky left rail plus main column of panels | rail 300px (`--d1-rail-width`), `late-stack`; stacks under 1000px |
| `RecordRail` | Component | The record's identity card: kind pill, status, code, title, icon actions, facts, "On this page" | Raised surface, sticky |
| `Section` | Component | A titled panel: a lid (tile) with title, count chip and actions over an opaque body | default, empty (lid only, inline "nothing recorded"), collapsible, focus |
| `FactList` | Component | Label-left, value-right rows with hairlines | one column (rail), auto grid |
| `PageContents` | Component | "On this page" anchor list with counts | current (2px accent bar, 650 weight), empty (55% opacity) |
| `RecordCard` | Component | A record as a link card: code, tag, name, meta, extras | tile (inside a panel), `raised` (on the ground); hover border is accent |
| `DataTable` | Pattern | Sortable record table | Compact, Normal, Roomy density |
| `StatTile` | Component | Big count with label and icon well | static, link (hover border accent) |
| `StatusBadge` | Primitive | Status pill from a tone | six tones (section 2) |
| `SegmentedControl` | Primitive | One-of-N radio group (Table or Cards, density) | on (accent fill), hover, focus-visible |
| `ProgressBar` | Primitive | "n of m" bar with text | 6px track; empty when max is 0 |
| `Sparkline`, `CompositionBar` | Primitive | Inline charts | Follow the `dataviz` skill |
| `ProjectTimeline` | Component | The Project page's one-axis timeline: project and campaign bars, done work per week, planned markers, Today | Range 30 d, 6 mo or All (`SegmentedControl`); one-line empty state |
| `RecordLink`, `AppLink` | Primitive | Every record link (via `recordRoute()`) | Accent 600, underline on hover |
| `PinToggle` | Primitive | Pin a page to the sidebar | pinned or not |
| `LoadState`, `NotVisible` | Component | Loading, error, and "Not found or not visible to you" | |
| `EditDrawer` | Pattern | Edit a record through the collection's own form | |
| `AccessDialog` | Pattern | Share a record with people and teams | |
| `PeopleStack` | Component | Everyone with access as faces | Six full, then three fading; opens Who has access (`AccessDialog`) |
| `ExplorerNav`: `SidebarExpanded`, `SidebarRail`, `NavHoverMenu` | Pattern | The dark sidebar: Find, Home, Inbox, pins, five sections | expanded (224px), rail (60px icons, tooltips, 224px hover menus) |
| `PlainFrame` (STARbase) | Template | Sticky page header: title, breadcrumb, actions | 44px, one row (PR 356); static on phones |
| `.d1-btn`, `.d1-btn.pri`, `.d1-btn.danger`, `.d1-input` (`tokens.css`) | Primitive | Buttons and inputs of a page's own action rows and forms, next to `.d1-note` | 8px radius, 30px tall, 40px under 700px page width; hover border accent; `.danger` (ink and border `--d1-bad`) for the destructive action |

**Added in PR #377** (designs on the "STARbase list page layouts" canvas):
- `ViewRail` / `ViewRailSection` (kit), `RecordViewRail`, `IndexViewRail`, `TitlePin` (STARbase), `providePagePin`.
- **View rail:** every index and record page puts its viewing settings in one small hanging card on the right, the
  mirror of `RecordRail` on the left. It shows only the settings that apply to that page. Rules in section 5.
- **Pin on title hover:** the pin moves out of the header actions to a button beside the title, shown on hover or focus.
- **Activity under the rail** (still Proposed): the record's activity chart moves from the main column to a card under the left rail (not the Project page, which has the hero timeline).

---

## 5. Layout

**Grid:** no global column grid. Pages are flex or grid compositions inside `PageShell`:
- Record pages: `RecordLayout`, a `300px | 1fr` grid with a 16px gap.
- Block grids: `.d1-cols`, `repeat(auto-fit, minmax(340px, 1fr))` with a 16px gap. Blocks keep their own height (`align-items: start`).
- Fact grids: `repeat(auto-fill, minmax(260px, 1fr))`, 28px column gap.

**Shell:** a dark sidebar (224px expanded, 60px rail), then the content column. A sticky 44px header (`PlainFrame`)
heads the content column and sets `--d1-header-offset` (52px: header plus gap). Sticky rails sit at
`top: var(--d1-header-offset)`.

**Page frame:** `PageShell` padding is 12px top, `var(--content-padding, 32px)` sides and 32px bottom. Blocks are
12px apart. The max width is 1440px (920px when narrow).

**Pin on the title.** Any page that can be pinned shows a pin button right after the page title, only while the
pointer is over the title (or the button has keyboard focus). Filled when the page is pinned; the tooltip says "Pin to
the sidebar" or "Unpin from the sidebar". There is no Pin button among the header actions.

**Project page hero.** The Project page does not use `RecordLayout`: it has no record rail. It is a full-width
hero surface (title, people row, timeline, about, totals), then campaigns as raised cards on the ground, then
panels. The hero reacts to the page's own width:

| Page width | Hero |
|---|---|
| < 700px | One column: head, timeline, about, totals |
| 700–1499px | Head; timeline full width; about and totals side by side |
| ≥ 1500px | Head; timeline in two thirds; about and totals stacked beside it |

The View rail hangs at its right (Table density, Empty sections and Activity range; no Panels, the hero page lays its
panels out itself), and its Activity range is the timeline's range. The Pin is the title pin in the header, not one in the
hero. The full spec is `docs/superpowers/specs/2026-10-20-project-page-hero-design.md`.

**The View rail.** One right-hand card for *how* a page is shown, on index and record pages alike. It
is a hanging card like `RecordRail`: surface, 1px line, 12px radius, `--d1-shadow`, a 40px tile lid with a sliders
icon, "View" and a collapse button; 220px wide, sticky at `--d1-header-offset`, only as tall as its content. It holds
only the settings that apply to the page it is on, always in this order, and drops a section that has nothing in it:

| Section | Index pages | Record pages (Sample, Project, Campaign, Operation…) |
|---|---|---|
| Count and pager | "1–50 of 153" with ‹ › | — |
| Layout | Table, cards or list (icon segmented control, labels in tooltips) | Panels: 1 column or 2 columns |
| Density | Compact (30px rows), Normal (36px), Roomy (44px) | Table density, the same three steps, for every table in the panels |
| Content | Sort (field + direction), Group by, Columns, Rows per page | Empty sections: Show or Hide (hidden ones are counted under "On this page") |
| Page-specific | — | Only when the page has one: Activity range on a Project (30 d, 6 mo, All). (Units on a Sample is not built: nothing converts units yet.) |
| Footnote | — | "Saved for every sample page on this device." |

- **Columns** is a dropdown, not a list of toggles: the button reads "9 of 13 shown ▾" and opens a popover with a
  search field, the shown columns (drag to reorder; the code column is always on) and the hidden ones as
  checkboxes, then Reset and Done.
- **Rows per page** is a per-device preference like the rest of the rail, not part of the URL: a shared link keeps
  the filters, the sort and the page number, but not the page size.
- **Placement.** On index pages the rail starts level with the top of the table, not the filter row: the toolbar sits
  above the table only, and the rail's lid lines up with the table's header row. On record pages it starts level with
  the record rail and the first panel.
- **Index pages split the controls in three.** Header: title (with the hover pin), breadcrumb, then page actions (for
  now on the breadcrumb line under the header, `IndexActions`, until `PlainFrame` offers pages an actions slot): bulk
  actions such as Print labels (disabled until rows are selected, then "Print labels (2)"), Open in Data Studio and the
  primary "New …". Toolbar above the table: search and one button per filter showing its value ("Status Active"),
  tinted when set; these choose *which* rows show and go in the URL. View rail: *how* rows look, remembered per page
  and per device. Filters never go in the rail; view settings never go in the toolbar or header.
- **Collapsed:** a 36px vertical tab with the icon and a summary ("View · Normal · Created ↓"), plus a dot when the view
  is not the default. `\` toggles it.
- **When it is open.** Index pages: open by default from 1500px of content width, collapsed from 1100 to 1499px.
  Record pages: collapsed by default at every width (they are read more than arranged); opening it is remembered.
  Below 1100px the rail becomes a "View" button that opens the same sections in a popover (a sheet on phones).
- A page with no view settings at all has no rail and no tab.

**Spacing base unit:** 2px steps on a 4px rhythm. In practice:

| Step | Value | Typical use | Used |
|---|---|---|---|
| `2xs` | 2px | Pill vertical padding, nudges | 15 |
| `xs` | 4px | Tight inline gaps, fact row padding | 31 |
| `sm` | 6px | Chip and icon-button rows, crumbs | 63 |
| `md` | 8px | **Default inline gap** | 85 |
| `md+` | 10px | Card padding, tile gaps | 35 |
| `lg` | 12px | Panel body padding (with 14px sides), card gaps | 37 |
| `xl` | 16px | Between panels, page sections, rail padding | 21 |
| `2xl` | 28 to 32px | Page side padding, fact column gap | |

There is no `--space-*` token yet. Use these values, and do not add odd ones (5px, 7px).

**Density:** default is dense. Tables offer Compact, Normal and Roomy. Row height is about 36 to 38px at Normal.

**Touch targets:** 44px for sidebar and phone controls. Desktop inline controls are 28 to 34px.

## 5b. Plotters and charts

One plotter component is shared by STARbase and the force app (`@d1/force-plotting`), and FAST follows the same
layout (`@d1/fast-plotting`). Both fill the screen height with no page scroll at 1920×1080, 1920×1200 and 1440×900.

**Force analysis: four columns.** `256px | 330px | FRM | Signals` from 1500px of dashboard width (the FRM and Signals share a 12-column grid, 6/6 by
default, so Add panel, drag and resize still work); below 1500px the lists fold to a 44px tab (`44px | 300px | …`),
and below 900px everything stacks in one column.
1. **Samples → Operations.** Two stacked panels. Pick a sample, then its operations, shown filtered by a
   "Sample … ×" chip, with search, "Show all" and "Metadata issues only". Operations carry worded badges
   ("FRM ready", "1 issue"), never bare coloured dots.
2. **Operation column.** Lid with the operation code; sample, recorded date and machine always visible; then icon
   tabs (symbols, a tooltip with the name and number key, the tab's name repeated as a title row under the strip):
   ✂ Cut parameters (cut fields, plot model, and the editable operation record: Vc, feed, depth of cut, tool,
   coolant, operator) · ◐ Display (FRM colour and points) · ⏷ Signal filters (badge = stages on) · ▮ Signal
   statistics · ◠ Cutting metrics. A dot on a tab marks an unsaved edit. Save changes and Open are pinned at the
   bottom. Fields are one-line label | value rows (`.pg`, 31px).
3. **Force-revolution map (centre).** The FRM bar: Lite FRM, point count chip, Figure | Lite | Full, 2D/axis view,
   download, Fx Fy Fz, close.
4. **Signals.** A group with the mode pill (Force ⌄ slides out FFT, Power, Spectrogram, Waterfall), LIVE, legend
   chips, zoom tools and ⋯; then Fx, Fy and Fz as three panels that share the height and one time axis.
- **Signal filters tab:** a gain (dB) against log-frequency preview of the combined response and each stage, with
  drag handles on cut-off and notch frequencies and a hover read-out; stage rows (type, frequency, order or Q, on);
  "Preview on the Lite map and FFT" shows the work chain on the Lite map's filtered pane and the FFT before Apply.
  (A filtered overlay on the force traces themselves is not built.)
- **FFT with filters on:** the spectrum shows the stop bands shaded and labelled, the raw spectrum faint and the
  filtered one solid, on one dB axis relative to the raw spectrum's peak (the filter service returns `ref_db` for
  this). A "Filter bands" legend chip hides them.

**FAST analysis: three columns.** `256px | 330px | 1fr` (`44px | 300px | 1fr` at 1440).
1. **Samples → Runs**, as Force; runs carry "Trace complete", "Short run", "Importing…", "Import failed", "No trace".
2. **Run column.** Always visible: sample code (Sample ↗), material, date, machine, operator, atmosphere, mould Ø and
   mass (tagged "recorded"), then six Peaks tiles. Then icon tabs: ▮ Statistics · ⓘ Operation detail · ⚗ Recipe.
   Statistics fills the rest of the column: a phase bar (heating, hold, cooling), nine tiles (run duration, time
   over 1000 °C, mean ramp, total energy, power-on time, hold power, densification, peak shrink rate, energy per
   gram), and a cumulative-energy chart that takes the remaining height. "Whole run | Zoom window" recalculates
   for the zoomed range. Definitions: heating starts when the temperature first rises 20 °C above its start or the
   power first exceeds 2 % of its peak; hold = within 10 °C of the target (the run's peak if the recipe target is
   missing or never reached); cooling = end of hold to 200 °C; energy per gram uses the recorded mass. Numbers print
   as integers from 100, one decimal from 10, up to two below, without trailing zeros.
3. **Plots.** A group (count "6 of 6", rectangle zoom, Reset zoom, Add plot, disabled at 6) of up to six tile panels
   in a 2-wide grid filling the height (3 across once the plot area is 1300px or wider). Each tile is titled by what it shows with its peak, and has pick series,
   ≈ normalise, resize (small, wide, tall, big) and remove. Right-click opens the grouped, searchable series picker.

**Chart rules (every plot):**
- Solid 1px left and bottom axis lines with 4px outward tick marks; no box. Solid hairline gridlines at every
  labelled tick (`#edf0f2` light), never dashed; log axes add fainter minor lines at 2–9 of each decade.
- Nice tick steps (1, 2, 2.5, 5 × 10ⁿ), 5–6 per axis, the top tick above the data. Tick labels 11px, muted ink,
  tabular figures, real minus signs, 1k/10k on log axes.
- Every axis has a title with its unit: "Force (N)", "Time (s)", "Radius (mm)", "Frequency (Hz)",
  "Magnitude (dB re raw peak)". FAST tiles show the unit alone above the axis, since the tile names the quantity.
- Stacked charts share the x axis: tick marks on each, labels and title only on the bottom one.
- One y axis per chart, never two.
- Series colours: Fx/slot 1 `#2a78d6` blue, Fy/slot 2 `#eb6834` orange, Fz/slot 3 `#1baf7a` teal (dark:
  `#3987e5`, `#d95926`, `#199e70`). A single series is blue. Two or more get a legend with line keys, and from the
  second series also a dash pattern (colour and dash pairs do not repeat within 15 series), so hue is never the only
  cue. Tokens: `--d1-series-1/2/3`, `--d1-grid`, `--d1-axis` in `tokens.css`. Text never wears a series colour.
- Lines 2px (dense force traces 1.5px), envelope bands at 10%, light chart background in both themes' panels.
- Hover: one cursor across every chart of a group; the chart under the pointer shows a tooltip, the others a value
  dot with a surface ring; the x value shows on the axis.

**Conform plotter: run windows and the time axis.** The Conform plotter is the FAST layout with a Conform profile
(samples → runs, the run column, then plots of the machine log). One **Conform log** is shared by every run made in
one session, and each run owns a **run window** of it.
- *Run-window bands.* Another run's window is a wash of the foreground colour at 5%; the current run's is an accent
  wash at 10%. The plot opens on the current window, so while the view lies within 10% of its length on either side
  the current window is drawn as two 1px accent edge lines and no wash, and never greys the data. An end outside the
  view has no edge line.
- *Band labels.* In the top margin above the plot area, on the y unit's line and after it; on the top row of tiles
  only; cut with an ellipsis to the band's room; with a surface-coloured halo (`paint-order: stroke`). A label never
  prints over the data. A run the reader cannot see is labelled "Other run".
- *Time axis.* The axis keeps elapsed minutes and is titled "Time since log start (min)" (FAST: "Time (min)"). The
  hover badge on the axis shows the elapsed time (`mm:ss`); the tooltip adds the UK clock time ("02:05 · 09:02:05 UK
  time"). Text naming a time range outside the chart (the run window, "Use this view as the run window") uses UK clock
  times `HH:MM:SS`, marked "(UK time)" where it matters; dates use the display form "17 Mar 2025". ISO dates belong in
  inputs only.
- *Run column.* The figures under the identity are titled "Key figures" (four tiles, 2×2, never a lone tile; FAST
  keeps "Peaks", six tiles in 3×2). The Statistics tab is two tiles wide with wrapping labels. Every Conform figure comes
  from the one figure table (`CONFORM_FIGURES`): labels in sentence case, numbers as integers from 100, one decimal from
  10, up to two below; energy and demand to 2 decimals; durations `12 min 05 s` / `1 h 23 min`; no reading is an em
  dash with no unit. The Operation page and the PDF appendix use the same table.
- *Run actions.* Below the figures: the kit's `.btn` (30px, 40px under 700px). An inline confirm (unlink a log, a file
  that is already uploaded) is a `role="group"` in a polite live region, moves focus to Cancel and back, and draws the
  destructive action in `--d1-bad`. A reader who cannot edit sees the window and "No run window is set." with nothing
  to press.
- *Small traces.* A two-series sparkline (wheel speed and Tooling 1 on the map card and the Operation page) draws the
  second series dashed (`4 3`) and carries a one-line key, since the two are on separate scales.

**Reports (PDF).** Report charts follow the chart rules above (nice ticks, axis titles with units, hairline grid) but
keep the report's own series colours (`#dc2626`, `#2563eb`, `#16a34a`, `#d97706`), shared by the FAST and Conform
appendices: a deliberate exception for print on white paper.

---

## 6. Depth

Depth is mostly **tone and hairline**, not shadow. A panel is a surface with a 1px `--d1-line` border and a soft shadow.

| Token / value | Usage |
|---|---|
| none | Ground, tiles, rows |
| `--d1-shadow`: `0 2px 6px rgba(0,0,0,.1)` | Panels, rails, raised cards, stat tiles |
| `0 2px 8px rgba(0,0,0,.4)` | Sidebar tooltip pill |
| `0 8px 24px rgba(0,0,0,.25)` | Hover menus, popovers |
| `0 12px 40px rgba(0,0,0,.3)` | Dialogs and drawers |
| `0 1px 2px rgb(0 0 0/6%), 0 18px 40px -12px rgb(0 0 0/28%)` | The sign-in card only |

`--d1-shadow-lg` is referenced with fallbacks in four places but **is not defined** in `tokens.css`. Define it, or
replace it with the dialog value.

**Radius:**

| Value | Usage |
|---|---|
| 12px (`--d1-radius`) | Panels, rails, raised cards |
| 10px | Cards inside panels, stat tiles, phone icon buttons |
| 9px | Sidebar icon slots |
| 8px (`--theme--border-radius`) | Inputs, buttons, segmented controls, icon buttons |
| 6px | Tooltips, small inline controls |
| 99px | Pills: badges, count chips, kind pills, tags, progress bars |
| 20px | The sign-in card only |

Values in use but **off-scale**: 2, 3, 4 and 7px, and 999px (use 99px).

**Layering (z-index):** the code uses about 17 distinct values (1 to 20000). **Proposed** bands, for a future
z-index token set (the order matches today's code; the exact numbers do not yet):

| Layer | Value |
|---|---|
| In-panel overlap (sticky table heads, markers) | 1 to 5 |
| Sticky page header (`PlainFrame`) | 5 |
| Sticky rails | 10 |
| Sidebar hover menus, tooltips | 50 to 60 |
| Phone sheet and backdrop | 80 to 90 |
| Dialogs and drawers | 100 |
| Toasts | 1000 |
| Full-screen scan or camera | 10000 |

Values outside these bands (9999, 20000) are drift. Consolidate them into a z-index token set.

---

## 7. Do's and Don'ts

### Do
- Use `--theme--*` and `--d1-*` variables for every colour, so light, dark and the Data Studio all work.
- Write font sizes as `var(--fs-md, 13px)`, always with the px fallback.
- Use `--d1-dim` for secondary text, never `--theme--foreground-subdued`.
- Show a status with `StatusBadge` and a tone from `status.ts`. Use the same words and colours on every page.
- Build pages from `PageShell` and `RecordLayout` with `Section` panels. Copy the Sample page's structure.
- Keep the ground, surface and tile ladder: a panel is a surface, and its lid and inner cards are tiles.
- Make record codes mono and bold. Make counts tabular.
- Link every record with `RecordLink` or `recordRoute()`.
- Give every control a visible `:focus-visible` ring in the accent (the sidebar uses `--d1-side-bar`).
- Keep empty sections to one line, as a lid with a zero count and a sentence such as "Every operation of this project that you can see is in a campaign." This includes charts: an empty chart is a one-line panel, not an empty plot.
- On index pages, put search and filters in the toolbar above the table and every viewing setting (count, layout, density, sort, grouping, page size, columns) in the View rail on the right, starting level with the table.
- Mark links in tables and the header with an underline (dotted for record codes). In light mode the accent is near-black, so colour alone does not show a link.
- Make an inline confirm a `role="group"` inside an `aria-live="polite"` region: focus moves to Cancel when it opens
  and back to the opener when it closes, and the destructive action is `.d1-btn.danger`.

### Don't
- Don't use raw hex in a page or component. The sidebar set in `tokens.css` and `theme.css` are the only places hex lives.
- Don't colour anything that isn't a status, a link, or the current location.
- Don't use the theme primary directly as kit text or fill in dark mode. It is about 1.1:1 there. Use `--d1-accent`.
- Don't go below 11px, and don't add a font size outside the six-step scale.
- Don't add a new radius, shadow or z-index value. Pick from section 6.
- Don't make a second breadcrumb line in the page body. The breadcrumb lives in the header.
- Don't scatter view toggles (Table/Cards, Compact/Normal/Roomy) across the toolbar or header of an index page. They belong in the View rail.
- Don't stretch side-by-side blocks to equal height. A short panel stays short.
- Don't rebuild create or edit forms. Use `EditDrawer`.
- Don't show "forbidden" differently from "not found".

---

## 8. Responsive

**Strategy:** every page must work on a phone, on 16:10 screens (1280×800, 1440×900, 1920×1200) and on 16:9
screens (1920×1080, 2560×1440), and must **reflow to use a wider screen**. It must not just centre a fixed column.
Data pages (records, index pages, plotters, the process map) fill the width. Only reading and form pages
(Settings, Report a bug, sign-in) keep the 920px `narrow` measure.

**Two kinds of breakpoint:**
- **The shell reacts to the viewport.** The sidebar is 224px from 1400px wide, a 60px icon rail from 768 to 1399px,
  and a 56px top bar with a menu sheet below 768px (`narrow.ts`, `PHONE_MAX_WIDTH = 767`). The rail from 1400px down
  is **Proposed**; today it switches at 768px. It gives 16:10 laptops (1280 and 1366 wide) about 160px more for content.
- **Page layouts react to their own width** (container queries on the page content, `container-type: inline-size`),
  so the same page works with the sidebar expanded or collapsed and inside the Data Studio.

**Content-width bands (Proposed, from the redesign boards):**

| Content width | Typical screen | Record page | Index page | Force plotter | FAST plotter |
|---|---|---|---|---|---|
| < 700px | Phone | One column. The rail becomes a card on top; "On this page" is hidden; tables become two-line rows | Toolbar wraps; filters and View each open a sheet | Sample and Operation pickers, the operation column, the map, then the charts full width | Run picker, run column, then one plot per row |
| 700–1099px | Tablet, small window | Rail on top with facts in a grid; panels in one column | One column; View is a toolbar button with a popover | Pickers in one row; collapsed groups in a grid | Run strip with "Change run"; plots 2 across |
| 1100–1499px | 16:10 laptop (1280, 1440) | Rail plus panels; the View rail is a 36px tab | Table plus the View rail, collapsed to its 36px tab by default | Lists fold to a 44px tab; 300px operation column, 520px map, signals | Lists fold to a tab; 300px run column; plots 2 across |
| 1500–1999px | 1920×1080, 1920×1200 | Rail plus panels in 2 columns; the View rail is a 36px tab until opened (220px) | Table plus the View rail open (220px) | Four columns: lists, operation, map, signals | Three columns; plots 2 across, 3 rows, fit in the screen height |
| ≥ 2000px | 2560×1440 and up | Panels in 3 columns | | Wider columns; the FRM figure gets its own column when it has one | Plots 3 across, taller |

**Height (16:9 compared with 16:10):** plotter charts take their height from the screen. Each is clamped between 150 and
420px, worked out from `100vh` minus the header and lids. So a 1920×1080 screen shows all six FAST plots, or all three
force channels, without scrolling, and a 16:10 screen gives them the extra height. Fixed `viewBox` charts with
`preserveAspectRatio="none"` stretch their text. Instead, lines scale with `vector-effect: non-scaling-stroke` and
the tick labels are HTML (or the chart re-renders from a ResizeObserver).

**Rules:**
- Never set a fixed page width or a fixed column width over 340px. Use `minmax(0, 1fr)` for the flexible column.
- When a wide layout has no content for a region (an empty FRM figure), the region folds away and the others take the space.
- Phones: touch targets 40 to 44px; icon-only extras move into a ⋯ menu; "needs a larger screen" notes are allowed for
  precision tasks (moving the crop window), but the data must still be readable.
- Other breakpoints in use today (720, 719, 640, 620 and 560px) are one-offs. Fold them into the bands above.

---

## 9. Agent Prompt Guide

**When generating UI for STARbase, agents must:**
- Read `.claude/skills/directus-ui-conventions/SKILL.md` first. Its data invariants (read as the signed-in user, never guess a column, one link mapping) matter as much as the visuals.
- Reference tokens from sections 2, 3, 5 and 6. Never use raw hex, and never use a px font size without a `--fs-*` variable.
- Compose from section 4 before proposing anything new. A new shared component goes in `packages/d1-ui` with vitest tests.
- Apply section 7 as hard rules.
- Confirm a change in both light and dark: a value that works in one only is a bug.

**Invariants (never change these without updating this file):**
- The theme is Directus-shaped (`--theme--*`). The kit derives from it and never replaces it.
- The type scale is six steps, 11 to 22px, with a 13px body.
- The sidebar is dark in both themes.
- Status colour comes from a tone, never from the page.
- Panels are 12px-radius surfaces with a hairline and `--d1-shadow`, with the title in a tile-coloured lid.

**Open questions and known gaps:**
- **STARbase does not load Inter or Fira Mono.** There is no `@font-face` or font link in `apps/starbase/web`, so outside the Data Studio the app renders in the system fallbacks (Segoe UI and Consolas on the lab's Windows PCs). Bundle both as woff2 files.
- No spacing tokens (`--space-*`). Values are conventions only.
- No z-index tokens. There are about 17 ad-hoc values.
- `--d1-shadow-lg` is used but not defined.
- 13 files still contain raw hex (mostly dialogs in `people/`, `teams/`, `home.vue`, `SampleGeometry.vue` and the surface viewer). Audit them.
- About 40 raw px font sizes outside the token convention (mostly 12 and 13px). Wrap them in `--fs-*`.
- Which record pages have a page-specific View setting beyond Units (Sample) and Activity range (Project).

---

## 10. Motion

Motion is minimal and functional: feedback on hover and focus, and the growth of a value.

**Durations:** fast 100 to 120ms (hover borders, opacity) · base 150ms (fades, strokes) · slow 250ms (progress bar width).
**Easing:** `ease` throughout. There is no custom curve.
**Signature transitions:**
- Card or tile hover: `border-color 0.12s ease` to the accent.
- Progress fill: `width 0.25s ease`.
- Menus and tooltips appear without animation.

**Reduced motion:** 8 components honour `prefers-reduced-motion: reduce`. All new motion must do the same, by
dropping the transition entirely.

---

## 11. Voice & Tone

**Voice:** plain, exact, calm. Says what is true about the records you can see, and why.

**Microcopy:**
- Sentence case everywhere: titles, buttons, panel names ("Samples not in a campaign").
- British spelling: colour, analysed, finalise.
- Buttons are verbs or nouns of the action: "+ New", "Pin", "Print labels", "Open in Data Studio".
- Empty states explain, in one sentence: "Every test of this project that you can see is in a campaign."
- Visibility is always honest: counts are "the records you can see", and a missing record is "Not found or not visible to you".
- Errors say what failed and what to do next, and never blame the person.

**Terminology:** `CONTEXT.md` is the glossary and wins over this table. The terms that show up most in UI copy:

| Use | Avoid |
|---|---|
| STARbase | Explorer, frontend, lab-web |
| Index page | List view, collection page |
| Record page | Detail page, item page |
| Sample | Item, physical sample, workpiece |
| Saved view | Bookmark, preset, filter |
| Pin | Favourite, star, bookmark |
| Section (the sidebar's groups) | Module, tab, category |
| Person | User, account, member |
| Data Studio | Directus admin, the backend |
| Permanent link | Permalink, QR link, deep link |
| Conform plotter, FAST plotter | Conform analysis, Conform dashboard, FAST dashboard |
| Conform run, Conform log, run window, step | Batch, Confirm, segment, stage |
| Feedstock, extrusion | Charge, input powder, extrudate, product |

The kit's `Section` component is a panel on a page, but in copy "section" means a sidebar group (`CONTEXT.md`).
Call panels by their title in copy, never "section" or "panel".
