# Project page hero

Status: agreed with the maintainer on 20 Oct 2026 (grilling Q1–Q15, demo artifact
https://claude.ai/artifact/R521u56edfWorYktisGyPC, version 6). Supersedes the Project row of
`2026-10-09-explorer-rail-layout-design.md`: the Project page no longer uses the rail.

## Why

A project sits above campaigns, samples, operations and tests, but its page looked like theirs (the shared
rail layout). The Project page becomes a **hero page** whose job is orientation: what the project is, who is on
it, and how far it has got, readable on a 1440 × 900 screen without scrolling.

## Layout

`PageShell` (data page, fills the width) with, in order:

1. **Hero**: one surface (12px radius, `--d1-line`, `--d1-shadow`, 16px padding, 16px row gap, 28px column gap).
   - **Head** (full width): code (mono 700, `--fs-2xl`), name (`--fs-xl`, 650), the pin (`PinToggle`, shown on
     hover or focus of the title), kind pill, status badge, "Export controlled" (danger tone) and "Restricted"
     badges. Actions on the right: Edit, Process map, Open in Data Studio. Under it the **people row** (below).
   - **Timeline** (below).
   - **About**: dates, document number (mono), the description clamped to four lines with "Show more".
   - **Totals**: samples, operations done, tests done, campaigns, as `--fs-2xl` numbers with a hairline above,
     2 × 2. Under each, the planned count ("12 planned"); under campaigns, the open statuses ("1 active ·
     1 planned · 1 on hold"). Then "Counts of the records you can see in this project."
2. **Campaigns**: on the page ground, a heading with a count chip, then the kit's `CampaignCard` **raised**
   (identical to the Campaigns index). Planned, active and on hold first; complete ones behind
   "Show n complete campaigns".
3. **Panels** (`.d1-cols`): Samples, Operations and Tests not in a campaign, and Equipment used. Equipment tiles
   are `--d1-tile` (a card inside a panel is a tile, `DESIGN.md` section 2), each name a `RecordLink`.

The left rail, "On this page" and the Activity panel are gone from this page.

**Responsive** (container queries on the page content):

| Page width | Hero |
|---|---|
| < 700px | One column: head, timeline, about, totals |
| 700–1499px | Head; timeline full width; about and totals side by side |
| ≥ 1500px | Head; timeline in two thirds; about and totals stacked beside it |

## People row

Everyone in "Who has access" (`loadAccess` on `/d1-record-access`, the list the dialog shows; every reader of
the record may read it), in the dialog's order: the owner (the PI) first, investigators, then people and teams
who can edit, then those who can view. Six faces in full (initials; a team is a rounded square with the groups
icon; the PI filled with the accent), then up to three more fading out (opacity 0.5, 0.26, 0.1, hidden from
screen readers). Beside it: "**Dennis Premoli** PI · **2** investigators · **9** more have access", and a
"Who has access" button that opens `AccessDialog`. If the read fails, the row shows the PI only (from the
project) and no count. If the access read fails, the Restricted badge is not shown either; the page cannot tell restricted from not.

## Timeline

One SVG with one time axis, drawn from a pure model (`projectTimeline.ts` in the kit):

- **Rows**: the project bar (start to end; with no end date it runs to today and fades), then one bar per dated
  campaign (active strong, complete light, planned outlined). Campaigns without both dates are listed under the
  chart as "Undated: 6".
- **Done work**: operations (`--d1-chart-1`) and tests (`--d1-chart-2`) per ISO week, stacked, operations at the
  base, with a 2px gap; a y axis with nice steps (1, 2, 2.5, 5 × 10ⁿ), its title "Per week (operations and tests)".
- **Planned work**: hollow circles (operations) and hollow diamonds (tests) on the baseline at their
  `planned_date`, so hue is never the only cue.
- **Today**: a solid line across the chart.
- **Axes** per `DESIGN.md` 5b: solid 1px left and bottom axes, 4px outward ticks, solid gridlines at labelled
  ticks; month ticks at 1, 2, 3 or 6-month steps by span (weekly ticks for 30 days).
- **Range**: 30 d, 6 mo or All (default All: the project's start, or the first record, to the later of its end,
  today and the last planned date, plus 4%). The control is a `SegmentedControl` in the timeline's header,
  remembered per device (`localStorage`, guarded). It moves into the View rail when that exists.
- **Empty**: nothing in range → one line, "No operations or tests in the last 6 months." (`DESIGN.md`: an empty
  chart is a one-line panel).
- Under the chart: "Last operation 9 Oct 2026 · Last test none · Undated: 6". A screen-reader-only table holds the
  weekly numbers. Hover tooltips on weeks, bars and markers.
- Width from a `ResizeObserver`; text stays HTML-size (never a stretched `viewBox`).

## Counts and planned work

- Totals use the project rule (`projectScope.ts`) as today. Done counts filter `work_state = 'done'`; the planned
  figure is `work_state = 'planned'` (operations, tests) and `current_status = 'planned'` (samples).
- Campaign progress bars keep planned work in the denominator (unchanged, and stated so it is not "fixed").
- Activity reads done rows' dates over the whole range (the existing capped read, `ACTIVITY_ROW_CAP`, with its
  "based on the newest records" note when hit) and planned rows' `planned_date`.

## Colours

`DESIGN.md`'s proposed chart tokens become real in `tokens.css`: `--d1-chart-1` (`#2a78d6` / `#3987e5`) and
`--d1-chart-2` (`#d0459a` / `#ff99dd`). `Sparkline` switches to them (operations solid, tests dashed), so the
Projects index and Home match the hero.

## Out of scope

The View rail itself (still Proposed in `DESIGN.md`), people who recorded work but have no access, a Campaign page
hero, and any new endpoint or permission.

## Testing

Vitest for the pure models (`projectTimeline.ts`, `peopleStack.ts`); typecheck and builds per the
directus-ui-conventions checks; a headless render of the page against a stubbed `/items` in light and dark at 390,
1280 and 1920. A real-Directus check goes to `docs/runbooks/physical-test-backlog.md`.
