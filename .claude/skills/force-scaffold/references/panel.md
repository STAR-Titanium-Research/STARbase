# Adding a panel or plot mode

## Live Record panel (e.g. Polar, 36069d5)

| File | Change |
|---|---|
| `apps/force-app/web/src/record/panels/<X>Panel.vue` | the panel body only: `RecordPage.vue` already wraps every grid item in `PanelFrame.vue` (title bar, close, pop-out). Read live data through `useWorkspace()` (`record/workspace.ts`), never a second WebSocket |
| `apps/force-app/web/src/record/RecordPage.vue` | add `<x>: { title, icon, w, h, single? }` to `PANEL_TYPES` and a `v-else-if="item.type === '<x>'"` branch in the grid. **Don't** add it to `DEFAULT_LAYOUT` unless every operator should get it, and don't change `LS_KEY` |
| `apps/force-app/web/src/record/LivePanelWindow.vue` | pop-out support. The route `/live/:panel` already exists in `router.ts`, so only the panel switch and its URL query params are needed |
| `apps/force-app/web/src/record/workspace.ts` | per-panel persisted options, if any (pattern: `polarRadius`/`polarAngleSource`/`polarBins`) |
| `packages/force-plotting/src/<X>.vue` + `index.ts` export | if the renderer is reusable by the Plot page, put it here (67070a0), not in the web app |

Reactivity: if the panel reads `client.fft`, `client.trace` or `client.frm`, its computeds must also
read `client.fftSeq.value` or `client.frameSeq.value`. Otherwise it renders once and freezes.

Icons are Material Symbols ligature names (`'radar'`, `'speed'`). They show up in the button's
accessible name, so tests must allow for that.

## Plot-page panel (`ForceDashboard.vue`)

- Add the type to `RPanelType`, an entry to `R_META` (title, icon), and the render branch.
- **Never bump `RIGHT_KEY`** (`'d1-force-right-layout-v2'`). That wipes every operator's saved layout.
  Unknown types in a saved layout must be skipped.
- The dashboard has two hosts (web app and `core/extensions/d1-force-dashboard`). Anything that
  needs Directus, assets or a service URL goes through `ForceHost` (`src/host.ts`). Check both hosts
  still typecheck: `npm run typecheck -w @d1/force-plotting`.

## Plot mode (Time/FFT/… in a Force panel)

`web/src/record/plotModes.ts` (the mode list) + `record/panels/ForcePanel.vue` (render branch). For
finished-cut spectra the work happens in `packages/force-plotting/src/SpectrumView.vue`,
`filterChain.ts` and `plugins/filter-service/app/main.py` (3ce06ad). Then test filter-service with
`pytest` too.

## Tests

- vitest beside the component (`*.test.ts`), for the pure logic (binning, scaling, option
  persistence). Pull it out of the `.vue` file so it's testable.
- Canvas backgrounds use `var(--plot-bg, …)`: `npm run lint:theme -w force-app-web`.
- `force-app-verify`: `ui_smoke.mjs --record`, then add the panel through the "+" menu or a seeded
  layout and screenshot it with data flowing.
