# Process map — slice 1 (map core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A STARbase **Process map** page at `/map` (Blender-style node editor: operations/tests as containers, samples flowing through sockets) with its entry points, and the Cytoscape lineage graph removed.

**Architecture:** A pure TypeScript graph model (`packages/starbase-pages/src/pages/map/model/`: load → group batches → build graph → reach → ELK input), unit-tested without Vue; Vue Flow custom nodes and one custom edge render it; elkjs lays it out from measured node sizes. Data comes only through `useExplorerHost().api`.

**Tech Stack:** Vue 3.5, vue-router 4, TypeScript (vue-tsc), vitest 4 (node env; component tests via SSR `renderToString`), `@vue-flow/core` 1.48.2, `@vue-flow/minimap` 1.5.4, `@vue-flow/controls` 1.1.3, `@vue-flow/background` 1.3.2, `elkjs` 0.12.0, Playwright (tests/ui).

**Spec:** `docs/superpowers/specs/2026-10-14-process-map-design.md` (read it first; D-numbers below refer to its §2). Visual reference: `docs/superpowers/specs/assets/process-map-mockup.html` (open in a browser; its CSS is the look to reproduce with kit tokens). Glossary: `CONTEXT.md` → "Samples and their history".

## Global Constraints

- Work in the worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\process-map` (branch `feat/process-map`); run npm from the worktree root (`npm ci` once if `node_modules` is missing).
- Exact versions, no ranges: `@vue-flow/core` `1.48.2`, `@vue-flow/minimap` `1.5.4`, `@vue-flow/controls` `1.1.3`, `@vue-flow/background` `1.3.2`, `elkjs` `0.12.0`, in `packages/starbase-pages/package.json` `dependencies`.
- Import ELK as `elkjs/lib/elk.bundled.js` (no worker).
- No `@directus/extensions-sdk`, `useApi(`, `useStores(`, `<router-link`, `router.push(`, `window.open(`, `'/assets/…'` strings, or numeric `--d1-sticky-top` in new files (guards `noSdkImports.test.ts`, `hostNeutral.test.ts`). Links: `AppLink`, `openLink(path, router)`, `RecordLink`, `recordRoute`.
- Colours only from theme variables / kit tokens; kind colours as `--k-*` (spec §6.2) inked toward `--theme--foreground` for text; every font size from the kit scale (`var(--fs-sm, 12px)` etc.).
- Words in UI copy: "Process map", "lineage", "batch", "probable batch", "powder batch" exactly as the glossary; never "graph", "lineage graph", "node graph".
- Test commands: `npm test -w @d1/starbase-pages`, `npm test -w @d1/ui`, `npm run typecheck -w @d1/starbase-pages`. Every task ends green on all three.
- Commit after each task with a `feat(map): …` / `test(map): …` / `chore(map): …` message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push (`git push`) after each task.
- Never merge, deploy, or run migrations on live.

## Review Focus

1. **A family with no operations at all** (old samples with only lineage rows) — the map must still show cards and junctions, not an empty canvas. → Task 2 test `lineage-only family`.
2. **A FAST import with no sample** (`sample_id` and `output_sample_id` both null) in a used-in fan — a container with zero rows, no crash. → Task 2 test `zero-row container`.
3. **Two operations on the same sample on the same date with no `operation_sequence`** — chain order must be stable (fall back to id order), never a cycle. → Task 2 test `same-day in-place order`.
4. **The person cannot read `/fields` or `/relations`** — Inside tray falls back to the fixed relation list, page still renders. → Task 4 test `fields refused`.
5. **Focus id that does not exist or is not readable** (`d1-trace` 404) — a "not visible to you or does not exist" state, not a blank canvas or an uncaught error. → Task 7 test.

---

### Task 1: Dependencies, model types, batch grouping

**Files:**
- Modify: `packages/starbase-pages/package.json` (dependencies), root `package-lock.json` (via npm)
- Create: `packages/starbase-pages/src/pages/map/model/types.ts`
- Create: `packages/starbase-pages/src/pages/map/model/groupBatches.ts`
- Test: `packages/starbase-pages/src/pages/map/model/groupBatches.test.ts`

**Interfaces:**
- Produces (types.ts):
  - `type Kind = 'sample' | 'operation' | 'test' | 'stock_lot' | 'powder_batch' | 'material' | 'equipment' | 'tool' | 'insert_edge' | 'recipe' | 'data_file' | 'person' | 'campaign' | 'project' | 'junction'`
  - `type ProcessCategory = 'machining' | 'sintering' | 'heat_treatment' | 'deformation' | 'additive' | 'sample_prep' | null`
  - `interface Ref { collection: string; id: string; code: string; label?: string }`
  - `interface OpRow { id: string; code: string; methodId: string; methodName: string; category: ProcessCategory; date: string | null; sequence: number | null; status: string | null; sampleId: string | null; outputSampleId: string | null; equipmentId: string | null; recipeKey: string | null; batchId: string | null; sourceRunUid: string | null; powderBatch: string | null; relations: Record<string, Ref | null>; settings: Record<string, unknown>; projectId: string | null }`
  - `interface TestRow { id: string; code: string; testType: string | null; category: 'nde' | 'destructive' | 'dynamic' | 'other' | null; date: string | null; status: string | null; subjectSampleIds: string[]; equipmentId: string | null; batchId: string | null; relations: Record<string, Ref | null>; settings: Record<string, unknown>; projectId: string | null }`
  - `interface SampleRec { id: string; code: string; form: string | null; status: string | null; projectId: string | null; materialRef: Ref | null; facts: Record<string, string> }`
  - `interface LineageRow { parentId: string; childId: string; type: 'derived_from' | 'cut_from' | 'sintered_from' | 'powder_from'; fraction: number | null }`
  - `interface StockOrigin { lotId: string; lotCode: string; supplier: string | null; massUsedGrams: number | null; sampleId: string }`
  - `interface ProcessData { focus: Ref & { kind: Kind }; samples: SampleRec[]; operations: OpRow[]; tests: TestRow[]; lineage: LineageRow[]; stock: StockOrigin[]; hidden: { ancestors: boolean; descendants: boolean; events: boolean; stock: boolean }; truncated: boolean; fan?: { items: Ref[]; total: number } }`
  - `interface Group { id: string; kind: 'operation' | 'test'; rowIds: string[]; batch: { recorded: true; code: string } | { recorded: false } | null }` (`null` = a single row, no batch)
  - `ProcessGraph`, `MapNode`, `Wire`, `SampleRow`, `Slot`, `HiddenMarker` — exactly as spec §5.1; socket ids `<nodeId>:in:<i>`, `<nodeId>:out:<i>`, bundle `<nodeId>:in:b` / `<nodeId>:out:b`.
- Produces (groupBatches.ts): `groupBatches(ops: OpRow[], tests: TestRow[], opts: { probable: boolean; batchCodes?: Record<string, string> }): Group[]` — every row in exactly one group.

- [ ] **Step 1:** `npm install -w @d1/starbase-pages --save-exact @vue-flow/core@1.48.2 @vue-flow/minimap@1.5.4 @vue-flow/controls@1.1.3 @vue-flow/background@1.3.2 elkjs@0.12.0`; confirm `package.json` shows exact versions.
- [ ] **Step 2: Write the failing tests** in `groupBatches.test.ts` (build rows with a small `op({...})` helper defaulting every field to null):
  - `13 sintering runs, one day, one recipe, one powder batch → 13 single groups` (each with `sourceRunUid` set; also a variant with `sourceRunUid` null still gives 13 singles because sintering never groups different inputs).
  - `4 cuts from one sample on one day → one group of 4, batch {recorded:false}` (category machining, same `sampleId`, method, equipment, date-day; different `outputSampleId`).
  - `4 polishing rows on 4 samples, same day, machine, recipe → one probable group` (category sample_prep).
  - `the same 4 rows on a lathe (machining, different samples) → 4 singles`.
  - `heat_treatment and additive group like sample_prep; deformation does not`.
  - `different day or different recipe splits a sample_prep group`; `blank recipe equals blank`.
  - `recorded batch_id groups any category and wins: rows with batchId never join a probable group`; header code from `batchCodes`.
  - `probable:false → only recorded groups`.
  - `tests group only by batchId` (no probable grouping for tests).
  - `every input row appears in exactly one group`.
- [ ] **Step 3:** Run `npm test -w @d1/starbase-pages -- groupBatches` → FAIL (module missing).
- [ ] **Step 4:** Implement `types.ts` and `groupBatches` (spec §5.3: recorded first; then same-input rule for any category; then several-samples rule for `sample_prep|heat_treatment|additive` only; skip rows with `sourceRunUid`; group keys use the calendar day of `date` in UTC; a group needs ≥ 2 rows). Group id: `batch:<batchId>` / `probable:<rowIds sorted joined>` / `op:<id>` / `test:<id>`.
- [ ] **Step 5:** Run the tests → PASS; typecheck → PASS.
- [ ] **Step 6:** Commit `feat(map): model types and batch grouping` and push.

### Task 2: Build the graph

**Files:**
- Create: `packages/starbase-pages/src/pages/map/model/buildGraph.ts`
- Test: `packages/starbase-pages/src/pages/map/model/buildGraph.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `groupBatches` output.
- Produces: `buildGraph(data: ProcessData, groups: Group[], opts: { slots: (row: OpRow | TestRow, kind: 'operation' | 'test') => Slot[]; maxRows?: number }): ProcessGraph`. Node ids: samples `s:<id>`, containers = group id, junctions `j:<parentId>:<type>`, stock lots `lot:<id>`, powder batch `pb:<opId>`, material `m:<sampleId>`. `Wire = { id: string; from: string /* socket id */; to: string; carries: string | null /* sample id */; flow: 'sample' | 'stock'; bundled: boolean; origin: string /* node id */ }`.

- [ ] **Step 1: Write the failing tests** (fixture builders shared in `model/fixtures.ts`, created here), each asserting nodes/wires by id:
  - `FAST op makes a sample`: op (sampleId null, outputSampleId S) → container `op:<id>` with one row `{ out }`, wire container `:out:0` → `s:S:in:0`, `carries: S`.
  - `stock lot into the making op`: S has stock origin L and making op → wire `lot:L:out:0` → `op:<id>:in:0`, flow `stock`; no wire lot → sample.
  - `stock lot into the card when no making op`.
  - `powder batch card`: FAST op with no lot and `powderBatch 'TIMET 45-150'` → node `pb:<opId>` (kind powder_batch, code `TIMET 45-150`) wired to the op input.
  - `material only for a root without making op and lot`.
  - `in-place chain`: S → turning (date 10 Sep) → polishing (12 Sep) → test (14 Sep, nde): wires `s:S:out:0 → turn:in:0`, `turn:out:0 → pol:in:0`, `pol:out:0 → test:in:0`, all `carries: S`; S has exactly one card.
  - `same-day in-place order`: two in-place ops same date, no sequence → ordered by id, no cycle (wire count = 2).
  - `cut 1→N`: a grouped cut of 4 rows → container with 4 rows sharing one input socket `:in:0` (one wire from S) and outputs `:out:0..3` wired to the 4 children; folded per maxRows 3 → rows 0–1 shown, rows 2–3 on `:out:b` with `bundled: true`.
  - `lineage dedupe`: genealogy (S→A cut_from) covered by an op with sampleId S, outputSampleId A → no junction; uncovered (S→B cut_from) → junction `j:S:cut_from` with wires `s:S:out:0 → j:…:in:0` and `j:…:out:<i> → s:B:in:0`; siblings with one parent and type share the junction.
  - `multi-parent`: child C with parents P1, P2 (uncovered) → C has sockets `:in:0`, `:in:1`.
  - `destructive test has no output`: test category destructive → row without `out`.
  - `lineage-only family` (Review Focus 1): no ops/tests → sample cards + junctions, ≥ 1 wire.
  - `zero-row container` (Review Focus 2): op with neither sample → container with `rows: []`, no wires, no throw.
  - `hidden markers`: `hidden.ancestors` true → marker on the focus sample's input side; `hidden.descendants` → output side.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `buildGraph` per spec §5.2 rules 1–8. Chain order key: `(date ?? '9999', sequence ?? +∞, id)`; tests merge into the same per-sample chain by date.
- [ ] **Step 4:** Run → PASS; typecheck → PASS.
- [ ] **Step 5:** Commit `feat(map): build the process graph` and push.

### Task 3: Reach and Inside-tray slots

**Files:**
- Create: `packages/starbase-pages/src/pages/map/model/reach.ts`, `formSlots.ts`
- Test: `reach.test.ts`, `formSlots.test.ts` (same folder)

**Interfaces:**
- Produces: `shownNodes(graph: ProcessGraph, focusNodeId: string, reach: number | 'all'): Set<string>` — steps counted over wires in both directions; a container counts as one step; stock/powder/material/junction nodes adjacent to a shown node are always shown.
- Produces: `formSlots(row: OpRow | TestRow, kind: 'operation' | 'test', defs: RelationDef[]): Slot[]` with `RelationDef = { field: string; label: string; collection: string }` and `Slot = { field: string; role: string; ref: Ref | null; major: boolean }`. `FALLBACK_RELATIONS: Record<'operation' | 'test', RelationDef[]>` exported (the spec §4 relation lists). Major fields: operation `equipment_id`, `tool_id`, `insert_edge_id`, `fast_recipe_id`, `source_recipe_id`, `force_file_id`; test `equipment_id`, `insert_edge_id`, `session_data_files`. Roles: Machine, Tool, Insert edge, Recipe, Force data / Data. Never slots: `sample_id`, `output_sample_id`, `method_id`, `project_id`, `batch_id` (shown elsewhere). Empty relations produce no slot.
- Produces: `keySettings(row: OpRow | TestRow, category: ProcessCategory | 'test'): { label: string; value: string }[]` — at most 4, in the spec §6.4 order for the category, read from `row.settings` by field name (the plan implementer maps each label to the inline param field names in `20261009000143_restore_inline_param_field_meta.sql`, e.g. sintering `sintering_max_temp_celsius`, `sintering_max_force_kn`, `sintering_mould_diameter_mm`), missing values skipped.
- Produces: `mergeSlots(rows: Slot[][]): (Slot & { values?: Ref[] })[]` and `mergeSettings(rows)` for a group: a value shared by every row appears once; differing values become one entry with `values` (rendered "N different", expandable) / settings value `"varies"`.

- [ ] **Step 1: Failing tests:** `reach 1 shows focus + direct neighbours`; `reach 2` on the in-place chain; `'all'` shows everything; `stock lot beside a shown sample is shown`; `formSlots puts majors first in the order above`; `unknown relation from defs becomes a folded slot with its label`; `empty relation → no slot`; `excluded fields never appear`; `keySettings sintering returns max temp, max force, dwell, mould in that order and skips a missing one`; `keySettings caps at 4`; `mergeSlots keeps a shared machine once and turns 2 different tools into one entry with 2 values`; `mergeSettings gives varies for differing values`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, typecheck.
- [ ] **Step 5:** Commit `feat(map): reach, inside-tray slots and key settings`, push.

### Task 4: Load the data

**Files:**
- Create: `packages/starbase-pages/src/pages/map/model/loadFamily.ts`
- Test: `loadFamily.test.ts`

**Interfaces:**
- Consumes: `HostApi` (`useExplorerHost().api`, axios-shaped `get(path, { params })`), `TraceResponse` from `@d1/ui`.
- Produces:
  - `parseFocus(q: string | undefined): { collection: string; id: string } | null` (`physical_samples:<uuid>`; legacy `?sample=<id>` handled by the page).
  - `loadFamily(api: HostApi, sampleId: string): Promise<ProcessData>` — spec §7 steps 1–4: `GET /d1-trace/sample/:id`; operations `filter[_or][0][sample_id][_in]` / `[1][output_sample_id][_in]` chunked at **150** ids; tests via `test_sessions` with `filter[subjects][_some][item][_in]` + `collection = physical_samples` (use the M2A alias the Directus schema defines for `test_sessions_subject`; confirm with `GET /fields/test_sessions` on the preview and record the alias in a comment) chunked at 150; `sample_genealogy` among family ids; `sample_stock_provenance` from `trace.stock_origins`. Field lists as constants at the top of the file.
  - `loadRelationDefs(api, collection): Promise<RelationDef[] | null>` — `/relations/<c>` + `/fields/<c>`; returns `null` when refused (caller uses `FALLBACK_RELATIONS`).
  - `loadUsedIn(api, ref: { collection: string; id: string }, page: number): Promise<{ items: OpRow[] | TestRow[] | SampleRec[]; total: number }>` — spec §7 used-in fan; `limit 20`, `sort -operation_date`, `meta filter_count`.
- [ ] **Step 1: Failing tests** with a fake api recording calls: `chunks 320 family ids into 3 operation requests of ≤150`; `asks for ops by sample_id OR output_sample_id`; `maps trace hidden booleans and numbers to booleans`; `truncated when any trace list is truncated`; `fields refused → loadRelationDefs returns null` (Review Focus 4); `loadUsedIn tool → filter tool_id, limit 20, total from meta.filter_count`; `404 from d1-trace rejects with isNotVisible(err) true`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, typecheck.
- [ ] **Step 5:** Commit `feat(map): load a sample family and used-in fans`, push.

### Task 5: ELK input and layout composable

**Files:**
- Create: `model/elkInput.ts`, `packages/starbase-pages/src/pages/map/useElkLayout.ts`
- Test: `model/elkInput.test.ts`

**Interfaces:**
- Produces: `elkInput(graph: ProcessGraph, shown: Set<string>, sizes: Record<string, { width: number; height: number }>, dir: 'RIGHT' | 'DOWN'): ElkNode` — root options `elk.algorithm: 'layered'`, `elk.direction: dir`, `elk.layered.spacing.nodeNodeBetweenLayers: '80'`, `elk.spacing.nodeNode: '36'`, `elk.edgeRouting: 'SPLINES'`; each container `elk.portConstraints: 'FIXED_ORDER'` with ports in row order (inputs WEST, outputs EAST for RIGHT; NORTH/SOUTH for DOWN); edges between port ids; only shown nodes/wires.
- Produces: `useElkLayout(): { layout(graph, shown, sizes, dir): Promise<Record<string, { x: number; y: number }>> }` — imports `elkjs/lib/elk.bundled.js` lazily (dynamic `import()`).
- [ ] **Step 1: Failing tests:** `ports follow row order`; `sizes are passed through`; `hidden nodes and their wires are left out`; `DOWN uses NORTH/SOUTH ports`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(map): elk input and layout`, push.

### Task 6: Node and wire components

**Files:**
- Create in `packages/starbase-pages/src/pages/map/nodes/`: `RecordNode.vue`, `ContainerNode.vue`, `JunctionNode.vue`, `SlotRow.vue`, `WireEdge.vue`, `kinds.ts` (kind → label, Lucide-or-`v-icon` name, `--k-*` variable), `mapTokens.css` (the `--k-*` palette from spec §6.2 and the ink rule)
- Test: `nodes/nodes.test.ts`

**Interfaces:**
- Consumes: `MapNode`, `Slot`, `Wire` (Task 1/2); Vue Flow `Handle`, `Position`, `BaseEdge`, `getBezierPath`.
- Produces: components taking Vue Flow node props `{ id, data: MapNode, selected }`; emits via a provided `mapActions` injection key `MAP_ACTIONS: InjectionKey<{ select(id: string): void; expand(id: string): void; hover(id: string | null, el?: HTMLElement): void; toggleRows(id: string): void; toggleMore(id: string): void }>` exported from `nodes/actions.ts`. `WireEdge` data `{ wire: Wire; tooltip: string }`; emits `actions.hover` for tooltips and on Ctrl/⌘+click calls `actions.select(wire.origin)` with `{ centre: true }` (extend the `select` signature to `select(id, opts?: { centre?: boolean })`).
- [ ] **Step 1: Failing SSR tests** (`createSSRApp` + `renderToString`, `Handle` stubbed as `<span class="sock" :data-id>`, `MAP_ACTIONS` provided as spies): `ContainerNode renders header, 2 rows + "+2 more samples" for 4 rows, Inside tray with majors then "+N more from the form"`; `ContainerNode for a probable batch says "Probable batch" and has a dashed class`; `zero rows renders the tray without row sockets`; `destructive test row has no out handle`; `RecordNode shows kind pill, code, status badge and a ＋ button`; `JunctionNode labels "Cut from" and fractions`; `WireEdge tooltip text "S-0412-A · Sample / from OP-… / into OP-…"` (pure helper `wireTooltip(wire, nodes)` exported and tested directly).
- [ ] **Step 2:** FAIL. **Step 3:** Implement to the mockup's look with kit tokens (cards = raised `RecordCard` look; container header tinted with `--k-op`/`--k-test`; sockets 12px dots coloured by flow; bundle socket 16px with a ring; pass-through dashed line on in-place rows). A click on the card body calls `select`; the ＋ button calls `expand` and stops propagation.
- [ ] **Step 4:** PASS + typecheck + `hostNeutral` guard green.
- [ ] **Step 5:** Commit `feat(map): node and wire components`, push.

### Task 7: The page, route, navigation and loading states

**Files:**
- Create: `packages/starbase-pages/src/pages/map/ProcessMapPage.vue`, `pages/map/useProcessMap.ts`
- Modify: `packages/starbase-pages/src/routes.ts` (add `{ path: 'map', component: () => import('./pages/map/ProcessMapPage.vue') }` before `:slug`), `packages/starbase-pages/src/routes.test.ts` (path list + count 15), `packages/d1-ui/src/links.ts:31` (`LOCAL_PAGES` gains `'/map'`), `packages/d1-ui/src/links.test.ts` (`/map?focus=…` resolves inside STARbase and `canonicalPath` keeps `focus` and `reach`), `packages/d1-ui/src/nav/navConfig.ts` (Analysis gains `{ label: 'Process map', icon: 'workflow', to: '/map' }` after the plotters), `navConfig.test.ts` if it pins the list.
- Test: `pages/map/useProcessMap.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `useProcessMap(api, route)` returning reactive `{ status: 'empty' | 'loading' | 'ready' | 'notVisible' | 'error'; error: string; data; graph; shown; focusNodeId; reach; setReach(r); dir; setDir(d); probable; setProbable(b); hiddenKinds; toggleKind(k); expand(nodeId); select(id, opts) ; selectedId }`. URL: reads `focus`, `reach`, legacy `sample`; writes `focus`/`reach` with `router.replace` through the host-safe helper used by other pages (no `router.push(` string). Show chips persisted under localStorage key `d1.map.show.v1` inside try/catch.
- [ ] **Step 1: Failing tests** for `useProcessMap` with a fake api: `no focus → status empty`; `?sample=<id> is read as physical_samples:<id>`; `d1-trace 404 → notVisible` (Review Focus 5); `other error → error with errorText`; `reach clamped and banner flag set when shown > 300 or data.truncated`; `localStorage throwing does not break toggleKind`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement `useProcessMap` and `ProcessMapPage.vue`: page frame + crumb line + two-column grid (rail slot left 300 px, map `Section` right whose lid holds search, Left→right/Top→down `SegmentedControl`, Re-layout, Fit, Clear); `<VueFlow>` with `nodeTypes` `{ record, container, junction }`, `edgeTypes` `{ wire }`, `MiniMap`, `Controls`, `Background` (dots); run `useElkLayout` after Vue Flow's `onNodesInitialized` with measured dimensions, animate to positions (CSS transition on transform for 200 ms), `fitView` around the focus; nodes `draggable: true`; Re-layout reruns ELK. Empty state: search box (reuse the Finder search the shell uses, or `useItems` over the seven code fields as NodeGraph did) and "Pick a record to map". Not-visible and error states via `LoadState`. The project frame: an absolutely positioned div under the nodes in the Vue Flow viewport layer, from the laid-out bounds, label = focus project code + title.
- [ ] **Step 4:** PASS (`@d1/starbase-pages`, `@d1/ui`) + typecheck; build the app `npm run build -w starbase-web` succeeds and the `map` chunk is separate (check `dist/assets` for a chunk containing `elk`).
- [ ] **Step 5:** Commit `feat(map): the process map page, route and sidebar entry`, push.

### Task 8: Rail, hover card, data thumbnails, wire hover

**Files:**
- Create in `pages/map/`: `MapRail.vue`, `HoverCard.vue`, `DataThumb.vue`, `WireTip.vue`, `model/connections.ts` (+ `connections.test.ts`), `model/dataPreview.ts` (+ test)
- Modify: `ProcessMapPage.vue`

**Interfaces:**
- Produces: `connectionsOf(graph, id): Record<'Came in from' | 'Went on to' | 'Inside' | 'Used in' | 'In this project', Ref[]>` (empty groups omitted, de-duplicated, junctions passed through to their parent sample with label "cut from"/…); `dataPreview(api, refs): Promise<Record<string, { kind: 'force' | 'fast' | 'none'; imageFileId?: string; plotterPath: string; fileName?: string }>>` — reuses `plotRequests`/`plotData` from `@d1/ui` (`packages/d1-ui/src/index/plotData.ts`): an operation with a finished force analysis gets `imageFileId = frmFz` (the Fz figure, shown with `assetUrl(id, { key/thumbnail })`); a FAST run with finished run data gets `kind 'fast'` and no image (shows "FAST run data · Open in FAST plotter"); anything else `none`. Never downloads a data file.
- [ ] **Step 1: Failing tests:** `connectionsOf` for a sample (Came in from making op, Went on to next step and pieces), a slot record (Used in), a container (Inside + in/out); `dataPreview` maps a done force analysis to its frmFz and a done FAST run to kind fast, and a refused request to `none`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement: `MapRail` = `RecordRail` (kind, status, code, title; actions Open record (`RecordLink`/`recordRoute`, Data Studio form for kinds without a page), Expand, Centre; `SampleGeometry` for samples; `DataThumb`; facts) + `Section` Connections (hover → `hover(id)`, click → `select(id, { centre: true })`) + `Section` Show (chips per kind present + Settings + Probable batches) + `Section` Reach (`SegmentedControl` 1/2/3/Whole history). `HoverCard`: 250 ms delay, positioned beside the hovered element inside the canvas, flips left then below, `aria-hidden`, not focusable. `WireTip`: follows the pointer; text from `wireTooltip`. While hovering, non-adjacent nodes get a dim class and adjacent wires a highlight class. Hidden markers render as a small "some records hidden" pill at the socket.
- [ ] **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(map): rail, hover cards, data thumbnails and wire hover`, push.

### Task 9: Expand and focus kinds (used-in fans)

**Files:**
- Modify: `useProcessMap.ts`, `model/buildGraph.ts` (fan mode), tests alongside
- Test: `useProcessMap.test.ts`, `buildGraph.test.ts` additions

**Interfaces:**
- Produces: `buildGraph` accepts `data.fan` → a column of collapsed containers (header-only flag `collapsed: true` on the container node) or sample cards, plus a stub node `more:<focus>` "+N more" when `total > items.length`.
- Focus rules (D20): `manufacturing_operations` / `test_sessions` → load the family of the first input (or output, or subject) sample, focus that container; `tools`, `equipment`, `insert_edges`, `fast_recipes`, `prep_recipes`, `raw_stock_lots` → used-in fan; `materials`, `projects`, `campaigns` → sample fan. ＋ on a slot record → its used-in fan merged beside the container; ＋ on a collapsed container → the family of its sample merged; ＋ on a sample outside the family → its family merged; "+N more" → next page.
- [ ] **Step 1: Failing tests:** `operation focus loads its input sample's family and focuses the container`; `tool focus builds a fan of ≤20 collapsed containers + "+N more"`; `expanding a collapsed container merges a family without duplicating nodes`; `material focus fans samples`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (merge by node id; `useRequestGate` so a newer focus cancels older work). **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(map): used-in fans and expand`, push.

### Task 10: Phones and keyboard

**Files:**
- Modify: `ProcessMapPage.vue`, `MapRail.vue`, node components
- Test: `pages/map/keyboard.test.ts` (pure key-handling helper)

**Interfaces:**
- Produces: `mapKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean }, focusedId: string | null): { action: 'select' | 'expand' | 'open' | 'none'; id?: string }` — Enter → select, `+` → expand, `o` → open.
- [ ] **Step 1: Failing tests** for `mapKey`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement: cards and slots `tabindex="0"` in DOM order; a focused socket (tabindex) lists its wires in the rail's Connections; below 768 px (use the shell's width helper) the rail becomes a bottom sheet (collapsed to its header; drag/tap to open), minimap hidden, long-press (500 ms) shows the hover card, tap selects.
- [ ] **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(map): keyboard and phone layout`, push.

### Task 11: Entry points

**Files:**
- Modify: `packages/starbase-pages/src/pages/SamplePage.vue` (add the rail button; remove the "Open lineage graph" button at ~131–136), `OperationPage.vue`, `TestPage.vue`, `ProjectPage.vue`, `CampaignPage.vue` (rail button), `packages/d1-ui/src/index/IndexPage.vue` + new `packages/d1-ui/src/index/RowMapButton.vue` (row action on tools, equipment, insert_edges, raw_stock_lots, materials, prep_recipes, fast_recipes), `packages/starbase-pages/src/home/QuickActions.vue:10` (drop the stale comment)
- Test: `packages/d1-ui/src/index/rowMap.test.ts`, extend an existing page SSR test if one exists for SamplePage

**Interfaces:**
- Produces: `mapPath(collection: string, id: string): string` in `packages/d1-ui/src/mapLink.ts` → `/map?focus=<collection>:<encoded id>`; `MAP_ROW_COLLECTIONS` (the seven above).
- [ ] **Step 1: Failing tests:** `mapPath encodes the id`; `MAP_ROW_COLLECTIONS lists the seven`; `RowMapButton renders only for those collections`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement: rail button inside `RecordActions` — `<v-button icon small secondary :to="mapPath(...)" title="Process map" aria-label="Process map"><v-icon name="<a tree/workflow icon the STARbase VIcon stand-in and Directus both render — check apps/starbase/web/src/standins/VIcon.vue>" small /><span class="sr-only">Process map</span></v-button>` (same pattern as Print label); row action through `AppLink`.
- [ ] **Step 4:** PASS (`@d1/ui`, `@d1/starbase-pages`) + typecheck; `grep -rn "d1-lab-dashboard/graph" packages` → nothing.
- [ ] **Step 5:** Commit `feat(map): process map buttons on record pages and index rows`, push.

### Task 12: Remove the Cytoscape graph

**Files:**
- Delete: `core/extensions/d1-lab-dashboard/src/views/NodeGraph.vue`
- Modify: `core/extensions/d1-lab-dashboard/src/index.ts` (drop import line 6 and the `graph` route line 26), `src/Module.vue` (drop the "Node Graph" button ~line 23 and `isGraph`), `src/views/SampleDashboard.vue` (drop `<NodeGraph>` ~171, import ~179, `graphRef` calls ~314/318/323, `.d1-graph` CSS ~579 — the panel's grid area collapses), `src/views/MachiningDashboard.vue` (~117, ~125, ~196/201, ~387), `src/views/FastDashboard.vue` (~79, ~87, ~133, ~221), `core/extensions/d1-lab-dashboard/package.json` (remove `cytoscape`), `package-lock.json` (via `npm uninstall -w <workspace> cytoscape`), `packages/d1-ui/src/links.test.ts` (drop the `/d1-lab-dashboard/graph` case), docs: `docs/wiki/database/samples.md:63`, `docs/runbooks/physical-test-backlog.md` (~398–412, ~792–794), `.claude/skills/directus-ui-conventions/SKILL.md:84` — reword to "Process map (STARbase `/map`)".
- Test: existing `extensionRecordLinks.test.ts` stays green; the extension build.

- [ ] **Step 1:** Make the edits; `grep -rn "NodeGraph\|cytoscape" core packages apps --include=*.vue --include=*.ts --include=*.json -l | grep -v node_modules` → only `package-lock.json` absent too.
- [ ] **Step 2:** `npm run build:extensions` (or the d1-lab-dashboard workspace build) → succeeds; `npm test -w @d1/ui` → PASS.
- [ ] **Step 3:** Commit `chore(map): remove the Cytoscape lineage graph from d1-lab-dashboard`, push.

### Task 13: End-to-end on the preview

**Files:**
- Modify: `tests/ui/specs/13-explorer-routes.spec.ts` (`EXTRA_ROUTES` gains `'/map'`)
- Create: `tests/ui/specs/17-process-map.spec.ts`

- [ ] **Step 1:** Write spec 17 (helpers from `tests/ui/starbase/target.ts`: `signInStarbase`, `adminApi`, `findFirstId`, `watchErrors`), as admin and as member: find a sample with operations (`adminApi` query on `manufacturing_operations` with `sample_id` not null); visit `/map?focus=physical_samples:<id>`; expect `.vue-flow__node` count ≥ 2 and a container node; hover a wire hit path → tooltip contains the sample code; Ctrl+click it → the rail's code changes to the origin; click ＋ on a slot → node count grows; "Open record" in the rail leads to the record page; the Sample page's Process map button opens `/map?focus=…`; the page text never contains "lineage graph"; no console errors.
- [ ] **Step 2:** Start the preview exactly as `tests/ui/README.md` describes with `D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057` (build extensions and `starbase-web` first), then `D1_ROUTES_CREDENTIALS=.superpowers/preview-credentials-d1-starbase.txt D1_ROUTES_STARBASE=http://127.0.0.1:5190 npx playwright test specs/13-explorer-routes.spec.ts specs/17-process-map.spec.ts --retries=0` from `tests/ui` → all pass. Stop the preview (`--stop`).
- [ ] **Step 3:** Commit `test(map): end-to-end process map on the preview`, push.
