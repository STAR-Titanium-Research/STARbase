# Design system rollout: View rail, title pin, force and FAST plotters, chart rules

Spec: `DESIGN.md` at the repo root, sections 4 (Proposed), 5 ("Pin on the title", "The View rail"), 5b (plotters and
charts) and 8 (Responsive). Mock-ups (HTML you can open, and PNG): the design canvas linked at the top of `DESIGN.md`, and
locally in the coordinator's scratchpad while this container lives:
`/tmp/claude-0/-home-user-STARbase/ce426b20-a748-5140-9a39-f124d4c23823/scratchpad/`
- View rail, index and record pages: `mock15/IndexRail2_1920.png`, `mock15/ViewRail_Sample.png`, `mock15/ViewRail_Project.png` (+ `.html`)
- Force plotter: `mock9/ForceV6_1080*.png` (layout, tabs, filter preview, FFT) and `mock12/ForceV7_1080*.png` (chart style)
- FAST plotter: `mock13/FastV8_1080*.png`, `mock13/FastV8_Tabs.png`; chart style `mock12/ChartsBeforeAfter.png`

If the scratchpad is gone, `DESIGN.md` is the spec; the canvas link still has every mock-up.

## Global constraints

- Functionality stays 1:1: nothing the force or FAST plotter can do today is removed, only moved. Each stream lists where
  every existing control goes in its PR notes.
- No page scroll on the plotters at 1920×1080, 1920×1200 and 1440×900; panels fill the height and scroll inside.
- Colours only through `--theme--*` / `--d1-*` tokens (no raw hex outside `tokens.css`/`theme.css`); new chart tokens
  `--d1-series-1/2/3` (light `#2a78d6/#eb6834/#1baf7a`, dark `#3987e5/#d95926/#199e70`), `--d1-grid`, `--d1-axis` go in
  `tokens.css` (stream B owns that edit; other streams use the names and fall back with `var(--d1-series-1, #2a78d6)`).
- Load the area's conventions skill first (`directus-ui-conventions` or `force-app-conventions`). Follow the `dataviz`
  rules in DESIGN.md §5b: one y axis per chart, solid hairline grid, axis titles with units, no text in series colours.
- Commit after every step in the worktree, conventional messages, with the trailer lines from the coordinator. Never
  push, merge or rebase. Run the package's tests and typecheck before each commit that touches code.
- Rig- or real-data-only checks go in `docs/runbooks/physical-test-backlog.md` (coordinator adds them, ids `UI1…`).

## Status

| Stream | What | Agent profile | Wave | Worktree / branch | State |
|---|---|---|---|---|---|
| B | `ViewRail` kit component, title pin (`pagePin`), record-page View rail (panels, table density, empty sections, activity range), chart tokens | `directus-ui-implementer` (Sonnet) | 1 | `agent-a26a30703b413a3b6` / `worktree-agent-a26a30703b413a3b6` | reviewed, fixed (11 commits), merged |
| C | Force charts: axis/tick/grid/title restyle, shared time axis, hover, FFT filter bands, `FilterResponse` preview | `force-plotting-implementer` (Sonnet) | 1 | `agent-a452c19055332b01f` / `worktree-agent-a452c19055332b01f` | done (6 commits, tests green); reviewed, fixed (14 commits), merged. FilterResponse `passes: 2`; filter-service `/spectrogram` gains additive `ref_db` |
| D | FAST plotter: layout, Samples → Runs, run column + tabs, statistics (`fastStats.ts`), plot tiles, chart restyle | `directus-ui-implementer` (Sonnet) | 1 | `agent-a125ed7efe09919ee` / `worktree-agent-a125ed7efe09919ee` | done (6 commits, tests green, no page scroll at 1920×1080/1440×900); reviewed, fixed (12 commits), merged |
| A | Index pages: View rail (count/pager, layout, density, sort, group by, columns dropdown, rows per page), toolbar = filters only | `directus-ui-implementer` (Sonnet) | 2 (on B's branch) | `agent-a0001a426275cbc10` / `worktree-agent-a0001a426275cbc10` | reviewed (no blockers, 4 should-fix + nits); fixes in progress |
| E | Force plotter layout: four columns, Samples → Operations, icon tabs (operation record in Cut), FRM centre, Signals group | `force-plotting-implementer` (Sonnet) | 2 (after C) | `agent-a0c4a7b6be34a67d9` / `worktree-agent-a0c4a7b6be34a67d9` | done (3 commits); reviewed: 2 blocking (chain aliasing, stacked column collapse) + 6 should-fix; fixes in progress |
| R | Opus review per stream, simplify pass, merge, PR, CI | `directus-ui-reviewer` / `force-app-reviewer` (Opus) + coordinator | after each | `claude/vigilant-clarke-0dvjuw` | not started |

## Stream B: kit pieces and record pages (`directus-ui-implementer`)

Owns: `packages/d1-ui/src/components/ViewRail.vue` (new), `packages/d1-ui/src/components/pagePin.ts` (new),
`RecordLayout.vue`, `Section.vue`, `PageContents.vue`, `DataTable.vue` (density only), `Sparkline.vue`/`activity.ts`
(range), `tokens.css`, `apps/starbase/web/src/PlainFrame.vue`, `packages/starbase-pages/src/pages/SamplePage.vue`,
`ProjectPage.vue` and their sub-components, plus the two pin lines in `d1-ui/src/index/IndexPage.vue`/`IndexToolbar.vue`.
1. `ViewRail.vue`: the hanging card (DESIGN §5): lid with a sliders icon, "View", collapse button; `sections` via slots
   (`<ViewRailSection label>`); collapsed = 36px vertical tab with a `summary` prop and a `modified` dot; `\` toggles it
   (ignored while typing in a field); open/closed remembered per `storageKey` in localStorage (wrapped in try/catch);
   default open/closed from a prop. Below 1100px content width it renders a "View" button with a popover holding the same
   slots. Unit tests for toggling, persistence and the key handler.
2. `pagePin.ts`: `providePagePin(target: Ref<PinTarget | null>)` and `usePagePin()` (provide/inject). `PlainFrame.vue`
   shows the pin button right after the `h1`, only on hover or focus-within of the title, filled when pinned, tooltip
   "Pin to the sidebar"/"Unpin from the sidebar", using the existing `usePins` toggle (same server endpoints). Remove the
   Pin button from `IndexToolbar.vue` and from record pages' `#title-actions`, and call `providePagePin` instead
   (`pinTargetForIndex` / `pinTargetForRecord` stay the source of the target). Check how the Directus Data Studio host
   renders these pages: if it has no `PlainFrame`, keep the old `PinToggle` there (fallback when nothing injects).
3. Chart tokens in `tokens.css` (light and dark), documented in the file's header comment.
4. Record View rail: `RecordLayout` gets an optional `view` slot rendered as a third grid column (220px, or the 36px
   tab); default collapsed on record pages. Settings, stored per record kind (`d1.view.<kind>`):
   panels 1 | 2 columns (two independent stacks, not a stretched grid), table density for every `DataTable` inside
   (provide/inject), empty sections Show | Hide (hidden `Section`s with `empty` are not rendered and `PageContents` shows
   "n empty sections hidden"). Project page adds Activity range 30 d | 6 mo | All (`activity.ts` takes a weeks/all window;
   26 weeks stays the default). Wire Sample and Project pages; other record pages get the rail only if they use the
   same three settings without extra work. (Sample "Units" from DESIGN is left out: there is no unit conversion to
   switch; leave the DESIGN open question.)
5. Tests: `npm test -w @d1/ui`, `-w @d1/starbase-pages`, `-w starbase-web`; typecheck all three; `npm run build -w starbase-web`.

## Stream C: force charts (`force-plotting-implementer`)

Owns: `packages/force-plotting/src/ForceChart.vue`, `ChartHoverLayer.vue`, `SpectrumView.vue`, a new
`FilterResponse.vue` + `filterResponse.ts`, and their tests. Do not edit `ForceDashboard.vue` beyond the props needed to
pass new options (keep those edits tiny; stream E rewrites the layout).
1. Axis restyle per DESIGN §5b: solid left/bottom axis lines with 4px outward tick marks, no box; solid hairline grid at
   every labelled tick (`--d1-grid`); 5–6 nice ticks (1, 2, 2.5, 5 × 10ⁿ) with the top tick above the data; 11px muted
   tabular tick labels, real minus signs; axis titles "Force (N)", "Time (s)", top "Radius (mm)".
2. Shared time axis: props `xLabels` (default true) and `topAxis` (default true) so a stacked group shows tick marks on
   every chart but labels/title only on the bottom one and the radius axis only on the top one.
3. Series colours from `--d1-series-1/2/3` (Fx, Fy, Fz), RPM keeps its own neutral; envelope band 10%, line 1.5px.
4. Hover: the hovered chart shows the tooltip; the other charts in the group show a value dot with a surface ring
   (shared cursor already exists via ChartHoverLayer: extend it, do not duplicate).
5. FFT/spectrum: single dB axis "Magnitude (dB re 1 N)", log frequency axis with decade labels (10, 100, 1k, 10k) and
   faint minor lines; when a filter chain is active, shade and label stop bands (low-pass from its cut-off, high-pass
   below its cut-off, notch ± its bandwidth and harmonics), raw spectrum faint and filtered solid. A "Filter bands"
   toggle prop. Never a second y axis.
6. `filterResponse.ts`: analytic magnitude response (dB) of a `FilterChain` (Butterworth high/low-pass of the chain's
   order, notch with Q and harmonics, combined) over log-spaced frequencies up to Nyquist; unit-tested against known
   values (−3 dB at cut-off, notch depth). `FilterResponse.vue`: the preview plot (gain against log frequency) with the
   combined curve and each stage dashed, drag handles on cut-off/notch frequencies that emit an updated chain, and a
   hover read-out. It must work offline (pure maths), while applying the filter to data stays on the filter service.
7. Tests and typecheck: `npm test -w @d1/force-plotting`, `npm run typecheck -w @d1/force-plotting`; then
   `npm test -w force-app-web` and `npm run typecheck -w force-app-web`. Use the `force-app-verify` skill for a headless
   screenshot of the Plot page.

## Stream D: FAST plotter (`directus-ui-implementer`)

Owns: `packages/fast-plotting/src/*` (FastDashboard.vue, FastChart.vue, new `fastStats.ts` + tests, fastMeta.ts).
Not `core/extensions/d1-lab-dashboard` (a separate, older FAST view; leave it).
1. Layout per DESIGN §5b: header-level title stays the host's; three columns `256px | 330px | 1fr` (`44px | 300px | 1fr`
   below 1500px content width, lists folded to a tab), filling the height, no page scroll. Keep the stacked layout for
   narrow widths.
2. Column 1: Samples → Runs (group operations by `sample_id`), search, filter chip, Show all; quality as worded badges.
3. Column 2: lid with run code and quality badge; always visible: sample code (link), material, date, machine, operator,
   atmosphere, mould Ø and mass tagged "recorded", six Peaks tiles; icon tabs ▮ Statistics · ⓘ Operation detail ·
   ⚗ Recipe (same tab strip pattern as the force plotter: symbols, tooltip, title row); Open operation pinned at the bottom.
4. `fastStats.ts` (pure, unit-tested): phases (heating to the hold, hold = within 10 °C of the target temperature, cooling
   from the end of the hold to 200 °C), run duration, time over 1000 °C, mean ramp, total energy (integral of power, kWh),
   power-on time, mean hold power, densification (ram travel), peak shrink rate, energy per gram (recorded mass). Works on
   a time window for "Whole run | Zoom window" (follows the shared zoom). Missing series → that tile is omitted.
   Statistics tab: phase bar, nine tiles, cumulative-energy chart filling the remaining height, CSV export.
5. Plots group: count "n of 6", rectangle zoom, Reset zoom, Add plot (disabled at 6); tiles titled by their main group
   with the peak (e.g. "Temperature · peak 1362 °C"), keep pick series, normalise, resize spans, remove, right-click
   picker (now grouped and searchable). 2-wide grid filling the height.
6. `FastChart.vue` restyle per DESIGN §5b: axis lines, outward ticks, nice ticks, unit above the y axis, time in minutes
   with "Time (min)" on the bottom row only, series colours `--d1-series-1/2/3` then dash patterns, legend with line keys
   for 2+ series; synchronised hover (tooltip on the hovered tile, dots on the others).
7. Tests and typecheck: `npm test -w @d1/fast-plotting`, `npm run typecheck -w @d1/fast-plotting`, `npm run build -w starbase-web`.

## Stream A: index pages (`directus-ui-implementer`, after B is merged)

Owns: `packages/d1-ui/src/index/*` (IndexPage.vue, IndexToolbar.vue, IndexTable.vue, CardGrid.vue, listPrefs.ts,
useIndexPage.ts, indexQuery.ts) and tests.
1. Toolbar keeps only search, filter buttons/chips and Clear filters. Everything about how rows look moves to a
   `ViewRail` (from B) placed in the grid's second column, starting level with the table (the toolbar sits above the
   table only). Open by default from 1500px content width, collapsed from 1100 to 1499px, popover below.
2. Rail sections: "1–50 of 153" with ‹ ›; Layout table | cards | list (list = compact two-line rows, new); Density;
   Sort (field select + direction button, for every layout; the URL keeps the sort); Group by (None or a filter field of
   kind enum/relation: rows grouped under headers within the page, sorted by the group field first); Columns dropdown
   "9 of 13 shown ▾" with search, drag to reorder, checkboxes, Reset, Done (code column always shown); Rows per page
   25 | 50 | 100 (replaces the fixed `PAGE_SIZE`; page resets to 1 on change).
3. `listPrefs.ts` gains columns (visible + order), page size, layout `list`, group by, with validation of stored values
   against the current `IndexDef` (unknown columns dropped). The Settings "forget my list views" still clears all.
4. Tests for prefs migration/validation, column picker, page size in the query, group-by ordering. Typecheck and
   `npm test -w @d1/ui`, `-w @d1/starbase-pages`, `-w starbase-web`; `npm run build -w starbase-web`.

## Stream E: force plotter layout (`force-plotting-implementer`, after C is merged)

Owns: `packages/force-plotting/src/ForceDashboard.vue` (and new small child components you split out of it).
1. Four columns per DESIGN §5b (`256 | 330 | 624 | 1fr` from 1800px; `44 | 300 | 520 | 1fr` below, lists folded to a
   tab), filling the height. Keep grid-layout-plus for the area right of column 2 so Add panel (Wear trend, Metadata
   doctor), drag, resize, pop-out and Reset layout keep working; the default layout puts the FRM in the centre column and
   Signals (Fx, Fy, Fz as three panels sharing the height and one time axis, using C's `xLabels`/`topAxis`) on the right.
2. Column 1: Samples → Operations (operations filtered to the chosen sample by a chip, search, Show all, Metadata issues
   only, worded badges "FRM ready" / "n issues").
3. Column 2: icon tabs ✂ Cut parameters (cut fields + plot model + the operation record fields, editable, one-line
   label | value rows) · ◐ Display · ⏷ Signal filters (badge = stages on; mounts C's `FilterResponse` above the stage
   rows; "Preview on charts") · ▮ Signal statistics · ◠ Cutting metrics. Sample/recorded/machine always visible above;
   Save changes + Open pinned at the bottom; dot on a tab with unsaved edits; Capture/technical stays reachable.
4. Signals group lid: mode pill with the existing slide-out (Force, FFT, Power, Spectrogram, Waterfall), LIVE, legend
   chips, zoom, ⋯; FFT passes the active chain so C's filter bands show.
5. Keep every existing feature (compare, crop + "Save as official crop?", right-click menus, URL view state, Copy link,
   localStorage keys: migrate old layout keys rather than break them). The force app's Record page and Diagnostics page
   import the package: run their tests.
6. Tests: as stream C, plus `force-app-verify` screenshots at 1920×1080 and 1440×900.

## Review and merge (coordinator)

Each finished stream: Opus review with the area's reviewer profile, fixes by the same implementer, then a simplify pass
(remove dead code, duplicated helpers, needless options), then merge into `claude/vigilant-clarke-0dvjuw` in the order
B, C, D, A, E. Update this table, run the CI-gated jobs locally (`directusUi`, `forceAppJs`), push once per wave, open
or update the PR, watch CI.
