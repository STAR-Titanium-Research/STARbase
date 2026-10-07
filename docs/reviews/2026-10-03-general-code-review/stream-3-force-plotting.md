# Stream 3 — `packages/force-plotting` (raw reviewer report)

Unverified reviewer output; the consolidated report records which findings the coordinator
checked. Paths are under `packages/force-plotting/src/`. Not read in depth: ForceDashboard's
template, RecipePanel, SignalPanel, SpatialPanel, ColorScaleEditor, scaleHandles.

## Blocking

1. **`ForceDashboard.vue:245, 609, 641` — long polls write into whichever op is open.**
   `buildOctree`, `buildGridOctree`, `bakeFilters` and `clearBake` poll for up to 15 min and then
   write `detail.value = { ...detail.value, <op A result> }` without checking
   `detail.value.id === d.id` (`pollRender` at :1956 does check). Start a bake on op A, open op B:
   B gets A's `live_cache_file`, `octree_path`, `filter_chain`, and B's FRM shows A's cut. Via
   `onCloudLoaded`, "Save crop as official" can then persist A's crop indices onto B. None of the
   loops stops on unmount/deactivate. Fix: guard each write, or a `createLoadToken()` per loop
   cancelled on op change and unmount.

## Should fix

2. `FrmCloud.vue:655-686` — deactivate calls `forceContextLoss()`, reactivate builds a new
   `WebGLRenderer` on the same canvas; a lost context is not restored by `getContext()`, so the
   FRM likely shows "WebGL unavailable" after Plot → Record → Plot. **Uncertain** (not run). Fix:
   re-key the canvas or don't force-lose on deactivate.
3. `FrmCloud.vue:656-658` — teardown cancels `raf` / `cropTimer` without zeroing them, so the
   `if (raf) return` / `if (cropTimer)` guards block redraws and crop rebuilds after reactivation.
4. `ForceChart.vue:311-314` — `emitHover` maps the zoom-window fraction onto the full `xs` range,
   so after any zoom the crosshair lands on the wrong sample (or none). Fix: `x = x0 +
   frac*(x1-x0)`, then binary-search `xs`.
5. `SpectrumView.vue:268-269`, `ForceDashboard.vue:1792, 2332-2339` — every keystroke in the
   filter chain refetches spectrograms (12 requests for "2000" in the 3-axis panel), no debounce
   or `AbortSignal`; intermediate values 422 and flash errors.
6. `FrmOctree.vue:300-310, 373-389` — no `onDeactivated`; the rAF/Potree loop and up to 25M
   points of GPU memory stay live while on the Record page.
7. `DiagnosticsWorkbench.vue:423` — anonymous `document` click listener never removed; one leaks
   per op switch.
8. `DiagOctreeView.vue:437-470, 568-575` — `load()` has no load token; unmount mid-load leaks the
   point cloud.
9. `PolarPlot.vue:80-82, 98-101` — radius `(r/rMax)*radiusPx` ignores sign; negative Mz/Fz plot
   180° off, and all-negative data inverts the scale.
10. `ForceDashboard.vue:1853-1866` — `measuredRadialPath` rebuilds the full path (≈100 MB at 5M
    points) on every crop-handle drag.
11. `ForceDashboard.vue:403-419` — `computeStats` has no stale guard; `cropStartSec.value ||
    c.csSec` treats a start of 0 as unset (use `??`).
12. `FrmCloud.vue ~1029-1040, 735` — `releaseFrmCache` revokes blob URLs but Figure mode doesn't
    refetch on reactivate. **Uncertain.**
13. `liveCache.ts:105-113` — LRU caps by count (6), not bytes (≈0.7–1 GB possible);
    `cachePut(id, null as any)` is used as a delete.
14. `liveCache.ts`, `ForceDashboard.vue:1594-1596` — float32 time in D1LC is ≈1.6 samples coarse
    at 600 s/25.6 kHz, so the 1-sample crop-dirty check can misfire. Compare in sample indices.

## Format notes

- D1LC (`liveCache.ts`) and D1AN (`diagAttrs.ts`) match `backend/app/d1lc.py` and
  `scripts/diag/d1an.py`.
- Latent gap: `plugins/filter-service/app/d1lc.py` `parse` ignores the v2 trailer and
  `serialise` always writes v1 (lines 61, 79), so filtered caches lose Mz/X/Y/Z.
- A truncated D1LC body throws a bare `RangeError`; a truncated trailer silently drops fields.

## Test gaps

No `write_d1lc` → TS cross-language fixture; no truncated-file cases; `signalStats.ts`,
`frmExport.ts`, `scaleTexture.ts` untested; no lifecycle tests for FrmCloud/FrmOctree/ForceChart;
edge cases in `path.ts` (`buildTurningSpiral` vc mode with `feed=0` → NaN), `idxOfTime` past end,
`alignRhoToBuckets` past end.

## Nits

`diagError.ts` maps every 403 to "session expired"; SpectrumView "power" averages dB, waterfall
divides by zero for one column; `/spectrogram` decimates frequency by stride; `saveLayer` /
`onPolygon` can drop a polygon drawn within one round trip; `<private-view>` unregistered in the
standalone app; GPU spiral shader `cos`/`sin` on unreduced args; `perKeyComputed` never evicts.

## Checks run

`npm test` 31 files / 376 tests passed; `npm run typecheck` (vue-tsc) clean.
