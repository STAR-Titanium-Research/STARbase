# Tooling record pages with an interactive 3D insert view: plan

> **For agentic workers:** work your stream only, in your own worktree. Commit after every step. Never
> push, merge, rebase or edit the Status table.

**Spec:** [`docs/superpowers/specs/2026-10-14-tooling-3d-pages-design.md`](../specs/2026-10-14-tooling-3d-pages-design.md).
Read it, `CONTEXT.md` › Tooling, and the `directus-ui-conventions` skill first.

**Branch:** `claude/interactive-3d-insert-preview-yp4dyu` (the coordinator's branch; streams branch from it).

**Commit trailer lines** (end every commit message with them):

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016gzbHS7JPckXcdb7bjgN27
```

## Status

| Stream | Worktree | Branch | State |
|---|---|---|---|
| S1 logic (`@d1/ui/tooling`, routes, index rows) | agent worktree | worker branch | pending |
| S2 stage (3D scene and 2D fallback) | agent worktree | worker branch | pending |
| S3 page (route, data, rail and panels) | agent worktree | worker branch | pending |
| Integration, review, headless check, PR | main checkout | `claude/interactive-3d-insert-preview-yp4dyu` | pending |

Order: S1 first (S2 and S3 import its types), then S2 and S3 in parallel, then integration.

## Shared interfaces (S1 owns them; S2 and S3 code against them)

All in `packages/d1-ui/src/tooling/`, exported from `packages/d1-ui/src/index.ts`. Units are millimetres
and degrees. The top view has x to the right and y up. Corners and letters go **clockwise** seen from the
top, starting at the reference corner (corner 0, nearest the reference mark).

```ts
export type ShapeLetter = 'C' | 'D' | 'S' | 'T' | 'V' | 'W' | 'R';

export interface IsoInsert {
	raw: string;
	shape: ShapeLetter;
	clearanceDeg: number;        // N 0, A 3, B 5, C 7, D 15, E 20, F 25, G 30, P 11, O other → 0
	doubleSided: boolean;        // clearance 0 (N) and a type letter not one-faced (M, R, T one-faced; A, G, N, F, Q, U two-faced)
	hole: 'none' | 'cylindrical' | 'countersunk';  // from the type letter (A/M/G cylindrical; T/W/U countersunk; N/R/F none…)
	icMm: number | null;         // from the size code and shape (C 12 → 12.7; C 09 → 9.525; S 12 → 12.7; T 16 → 9.525 …)
	thicknessMm: number | null;  // 04 → 4.76, T3 → 3.97, 03 → 3.18, 06 → 6.35 …
	noseRadiusMm: number | null; // 04 → 0.4, 08 → 0.8, 12 → 1.2, 00 → sharp; M0 → round
	chipbreaker: string | null;  // the suffix after '-', e.g. 'PM'
}

export interface InsertGeometry {
	shape: ShapeLetter | 'polygon';  // 'polygon' = fallback from edge_count
	recognised: boolean;             // false → the "shape not recognised" note
	includedAngleDeg: number;        // C 80, D 55, S 90, T 60, V 35, W 80, R 360 (round)
	cornerCount: number;             // corners of the outline (C/D/V 4, S 4, T 3, W 3, R = edge letters per face)
	cuttingCorners: number[];        // corner indices that get letters, in letter order (C/D/V: [0, 2]; S: [0,1,2,3]; T/W: [0,1,2])
	icMm: number;                    // falls back to 12.7
	thicknessMm: number;             // falls back to 4.76
	noseRadiusMm: number;            // falls back to 0.8
	clearanceDeg: number;
	doubleSided: boolean;            // edge_count, when set, decides: ≥ 2 × cuttingCorners.length → true, else false; otherwise the ISO rule
	holeDiameterMm: number | null;   // override, else a typical value for the IC; null when hole === 'none'
	holeCountersunk: boolean;
	edgesPerFace: number;            // cuttingCorners.length
}

export interface InsertCorner {
	index: number;
	x: number; y: number;            // nose-fillet centre
	bisectorDeg: number;             // outward direction of the corner, for camera framing and labels
	angleDeg: number;
	cuts: boolean;
}

export interface InsertOutline {
	points: Array<[number, number]>; // closed (last ≠ first), clockwise, fillets sampled every ≤ 10°
	corners: InsertCorner[];
}

export interface EdgePlacement { face: 'top' | 'bottom'; corner: number }

export interface SlotCell { number: number; column: number; row: number }
export interface SlotGrid { columns: number; rows: number; cells: SlotCell[] }

export type InsertState = 'fresh' | 'partly-used' | 'used' | 'depleted';

export interface ToolingEdge {
	id: string; code: string; identifier: string; // raw edge_identifier
	letter: string | null;                        // normalised ('fC' → 'C'); null if unreadable
	used: boolean; notes: string | null;
	placement: EdgePlacement | null;              // null → "position unknown"
}

export interface ToolingInsert {
	id: string; code: string; number: number | null; depleted: boolean;
	state: InsertState; edges: ToolingEdge[];     // edges sorted by letter
	cell: SlotCell | null;                        // null when the number is missing or out of the grid
}

export interface ToolingModel {
	boxId: string; boxCode: string;
	geometry: InsertGeometry; outline: InsertOutline;
	grid: SlotGrid; inserts: ToolingInsert[];     // sorted by number
}

export type ToolingFocus =
	| { kind: 'box' }
	| { kind: 'insert'; insertId: string }
	| { kind: 'edge'; insertId: string; edgeId: string };

export function parseIsoDesignation(text: string | null | undefined): IsoInsert | null;
export function resolveInsertGeometry(type: InsertTypeRow | null): InsertGeometry;
export function insertOutline(geom: InsertGeometry): InsertOutline;
export function normaliseEdgeLetter(identifier: string | null | undefined): string | null;
export function placeEdge(geom: InsertGeometry, letter: string | null): EdgePlacement | null;
export function slotGrid(count: number): SlotGrid;  // 10 → 5 × 2; ≤ 4 one row; else columns = ceil(sqrt(count × 2.5))
export function insertState(insert: { is_depleted: boolean | null }, edges: { is_used: boolean | null }[]): InsertState;
export function buildToolingModel(box: BoxRow, type: InsertTypeRow | null, inserts: InsertRow[], edges: EdgeRow[]): ToolingModel;
export function nextFreshEdge(model: ToolingModel): { insertId: string; edgeId: string } | null;
export function edgeUsageMismatch(used: boolean, historyCount: number): 'unused-with-history' | null;
export function focusParent(focus: ToolingFocus): ToolingFocus | null;     // edge → insert → box → null
export function focusRoute(focus: ToolingFocus, boxId: string): string;    // through recordRoute()
```

`InsertTypeRow` is the subset of `insert_types` columns in the spec (with `iso_designation`, `edge_count`
and the four override columns). `BoxRow`, `InsertRow` and `EdgeRow` are the subsets in the spec's Data
section. Placement: letter index `i` from `A`. `i < edgesPerFace` → top, corner `cuttingCorners[i]`.
On a double-sided insert, `i < 2 × edgesPerFace` → bottom, corner `cuttingCorners[i − edgesPerFace]`.
Otherwise → null.

Stage component contract (S2 owns it; S3 places it):

```ts
// packages/starbase-pages/src/pages/tooling/stage/ToolingStage.vue
defineProps<{ model: ToolingModel; focus: ToolingFocus; nextFresh: { insertId: string; edgeId: string } | null }>();
defineEmits<{ select: [focus: ToolingFocus] }>();
```

The stage handles clicks, hover, arrow keys and Esc itself. It only emits `select`, and the page turns
that into a route.

## S1: logic (`directus-ui-implementer`)

Owns `packages/d1-ui/src/tooling/**`, plus small edits to `packages/d1-ui/src/index.ts`,
`recordRoute.ts`(+test) and `index/indexConfig.ts`(+test).

1. `isoDesignation.ts` + test. Seed designations `CNMG 12 04 08-MF` and `CNMG120408-PM`, plus
   `CCMT09T304`, `CCMT 09 T3 08-MF`, `TNMG160408`, `SNMG120408`, `DCMT11T304`, `VCMT160404`, `WNMG080408`
   and `RCMT1204M0`. Garbage and empty input return null. Reference values: CNMG 12 04 08 → IC 12.7,
   S 4.76, RE 0.8, clearance 0, double-sided, cylindrical hole. CCMT 09 T3 04 → IC 9.525, S 3.97,
   RE 0.4, clearance 7, single-sided, countersunk.
2. `insertGeometry.ts` + test: `resolveInsertGeometry` and `insertOutline`. Non-null override columns win.
   The fallback uses `edge_count` (≥ 3 → that many corners, one face; else a square). Outline tests:
   point order is clockwise (negative signed area with y up), there are `cornerCount` corners, corner 0 is
   the reference corner, and the included angle at the acute corners is right.
3. `edgePlacement.ts` + test, covering `fC`, `A` to `D` on CNMG, `E` on CNMG (null), CCMT `C` (null),
   lower case and junk.
4. `boxLayout.ts` + test: 1, 4, 5, 10, 12 and 50 slots.
5. `toolingModel.ts` + test: `buildToolingModel`, `insertState`, `nextFreshEdge` (spec Q10, including
   depleted inserts being skipped), `edgeUsageMismatch`, `focusParent` and `focusRoute`.
6. Routes: `RECORD_PAGES` gains `tool_boxes: '/home/tool-boxes'`, `cutting_inserts: '/home/inserts'`
   and `insert_edges: '/home/edges'`. The three `INDEX_DEFS` entries change to `rowTarget: 'record'`.
   Fix the counts in `indexConfig.test.ts` and add `recordRoute` tests.
7. Checks: `npm test -w @d1/ui && npm run typecheck -w @d1/ui`, plus
   `npm run typecheck -w starbase-web -w @d1/starbase-pages`.

## S2: stage (`directus-ui-implementer`)

Owns `packages/starbase-pages/src/pages/tooling/stage/**`. Adds `three` (`^0.186.1`) and
`@types/three` (`^0.186.0`) to `packages/starbase-pages/package.json` and runs `npm install` at the root,
so the root lock file updates. It may only reference `three` through a dynamic `import()` from
`ToolingStage.vue`.

1. `scene/insertMesh.ts` + test (Node, no WebGL): an `ExtrudeGeometry` from the outline with a bevel
   of about 0.15 mm. Clearance > 0 tapers the sides: scale the bottom ring by
   `1 − 2·t·tan(clearance)/IC`, or build it from two outlines. The hole is a shape hole, and
   countersunk holes get a cone at the top. There is a reference notch at corner 0. Edge segments are a
   thin tube along the nose arc plus 25 % of each side next to it, on the top or bottom face, one mesh
   per placed edge, with `userData = { kind: 'edge', insertId, edgeId }`. Tests cover vertex counts,
   bounding box ≈ IC × thickness, and one segment per placed edge.
2. `scene/trayMesh.ts` + test: a rounded tray sized from `SlotGrid` (pitch ≈ 1.7 × IC), shallow pockets,
   and a slot number per pocket as a label anchor (no 3D text).
3. `scene/cameraRig.ts` + test: `frameBox`, `frameInsert` and `frameEdge` return the camera position
   and target. The edge framing looks along the corner bisector, slightly from above, and is close
   enough that the nose radius is legible. The ease is `easeInOutCubic` over 400 ms, or instant when
   `matchMedia('(prefers-reduced-motion: reduce)')` matches. Orbit limits: polar 15° to 80°, distance
   0.5× to 3× the framing.
4. `scene/toolingScene.ts`: the class `ToolingScene(canvas, overlayEl)` with `setModel(model)`,
   `setFocus(focus)`, `setNextFresh(next)`, `onPick(cb)`, `onHover(cb)`, `resize()`,
   `refreshTheme()` and `dispose()`.
   - Renderer: `WebGLRenderer({ antialias: true, alpha: true })`, pixel ratio capped at 2, sRGB output,
     ACES tone mapping, and a `RoomEnvironment` PMREM for a sleek carbide look.
   - Inserts are instanced from one geometry. The insert body is graphite metallic (metalness about
     0.6, roughness about 0.35).
   - State shows as a coloured ring in the pocket and on the edge segments: fresh `--d1-ok`, used
     `--d1-dim`, depleted inserts at 35 % opacity. The selection uses `--d1-accent` (emissive), and the
     next fresh edge pulses gently (only while visible, and never under reduced motion).
   - Out-of-focus inserts fade when an insert is focused.
   - `OrbitControls` with damping and the limits above.
   - Render on demand: request a frame on change, controls input or an ease, and never loop at rest.
   - Pick with a `Raycaster` on pointerup when the pointer moved less than 4 px, so a drag doesn't pick.
   - Labels are HTML elements in `overlayEl`, positioned by projecting the anchors each rendered
     frame: slot numbers at box level, edge letters at insert and edge level.
   - Theme colours: resolve them by applying `var(--x)` to a hidden probe element's `color` and reading
     `getComputedStyle().color`. The raw custom property may be an unresolved `light-dark()`.
     `refreshTheme()` runs again on a `prefers-color-scheme` change and on a `data-theme` attribute
     change (MutationObserver).
   - `dispose()` releases every geometry, material, texture, the PMREM target, the controls, the
     listeners and the renderer.
   - On `webglcontextlost`, call the fallback callback.
5. `SlotGrid2D.vue`: the 2D fallback.
   - Box level: a CSS grid of slots, each a button with the number and a state dot.
   - Insert level: an SVG of the outline with the lettered edges as buttons.
   - Edge level: the same SVG with the edge highlighted.
   - Everything works by keyboard. Theme variables only.
6. `ToolingStage.vue`:
   - A `ResizeObserver` on the stage.
   - Use 3D when WebGL is available (probe once) and the width is ≥ 600 px; otherwise use
     `SlotGrid2D`.
   - `import('./scene/toolingScene')` loads only in the 3D branch, with a skeleton until it is ready.
   - Hover label: "Insert 3 · 2/4 fresh" or "Edge 3B · used".
   - Keys: Esc emits `focusParent`, and the arrow keys step through inserts (box focus) or edges
     (insert or edge focus).
   - Prop changes call `setModel`/`setFocus` without recreating the scene.
   - The stage is a panel about 420 px high, in `--d1-tile`, with the kit's 12 px radius and hairline
     border.
   - The "position unknown" edges show as chips under the canvas.
   - It shows the "shape not recognised" note when `!model.geometry.recognised`.
7. Checks: `npm test -w @d1/starbase-pages`, `npm run typecheck -w @d1/starbase-pages -w starbase-web`,
   `npm run build:starbase`. After the build, confirm with `grep -l "WebGLRenderer"` over the dist
   chunks that three is only in lazy chunks and not in the entry chunk.

## S3: page (`directus-ui-implementer`)

Owns `packages/starbase-pages/src/pages/tooling/**` except `stage/`, plus a small edit to
`packages/starbase-pages/src/routes.ts` (and `routes.test.ts`).

1. Route: `{ path: ':kind(tool-boxes|inserts|edges)/:id', component: ToolingPage, props: true }`, placed
   before the `:slug` catch-all. Add a routes test that all three paths resolve to the same record.
2. `useToolingData.ts`, read through `useItems`.
   - Load the focus record by kind:
     - box: `tool_boxes/:id`
     - insert: `cutting_inserts/:id` with `tool_box_id`
     - edge: `insert_edges/:id` with `insert_id.insert_id` and `insert_id.tool_box_id`
   - Not-found or forbidden → `notVisible`.
   - The model, keyed by box id, is reloaded only when the box id changes or on `reload()`:
     - the box with `insert_type_id.*` (the spec's columns) and `project_id.project_id`,
       `project_id.project_code`;
     - its inserts (`filter tool_box_id`, limit 500, sort `insert_number`);
     - their edges (`filter insert_id.tool_box_id`, limit 4000);
     - then `buildToolingModel`.
   - Sections (via `useSections` and `useRequestGate`):
     - edge history: `test_sessions` by `insert_edge_id` (session_id, test_type, session_date, status,
       sample_id.sample_code) and `manufacturing_operations` by `insert_edge_id` (operation_id,
       pass_code, operation_date, process_category, sample_id.sample_code), each `LIST_CAP + 1`;
     - per-insert history counts, for the box's "next fresh edge" card.
   - Expose `focus: ToolingFocus` derived from the route.
3. `ToolingPage.vue`, following `SamplePage.vue`.
   - `ExplorerView` → `PageShell` → `RecordLayout`.
   - Crumbs: Home › Tool boxes › box › insert › edge, each a `RecordLink` or `AppLink`.
   - Rail: `RecordRail` for the focused record (kind "Tool box", "Cutting insert" or "Insert edge"),
     with `PinToggle`, `RecordActions` (Edit opens `EditDrawer` on the focused collection; Data Studio
     goes through `dataStudioRoute`) and facts.
   - The main column starts with `<ToolingStage :model :focus :next-fresh @select>`. `@select` →
     `router.push(focusRoute(...))`.
   - Then the focused record's panels:
     - `BoxPanels.vue`: insert type (ISO designation, manufacturer, coating, edges per insert), state
       counts (fresh, partly used, used, depleted, as `StatTile`s), a next-fresh-edge card with a link,
       and an inserts list.
     - `InsertPanels.vue`: details, notes, and the edges list with state.
     - `EdgePanels.vue`: details, notes, the mismatch warning, and history (tests and operations
       merged, newest first, each a `RecordLink`; machining operations add an `analysisLink` "View
       forces").
   - Page title: "Tool box BOX-…", "Insert CNMG12-1-3" or "Edge CNMG12-1-3B".
4. Until S2 lands, commit a placeholder `stage/ToolingStage.vue` with exactly the contract above (a
   `<div>` listing the inserts as buttons) in **its own commit** named
   `chore(starbase-pages): placeholder tooling stage`. The coordinator drops it at merge.
5. Add to `docs/runbooks/physical-test-backlog.md` under "Explorer pages (STARbase)": open a real box,
   an insert and an edge from the index pages; light and dark; a browser with WebGL off; the camera
   moving between inserts without the page reloading.
6. Checks: `npm test -w @d1/starbase-pages -w @d1/ui`,
   `npm run typecheck -w @d1/starbase-pages -w starbase-web`, `npm run build:starbase`.

## Integration (coordinator)

Merge S1, then S2 and S3, dropping the placeholder. Then:

1. Run the skill's full check list.
2. Run a headless render (Playwright, Chromium at `/opt/pw-browsers`) of the built STARbase against a
   stubbed `/items`, taking screenshots at box, insert and edge level, in light and dark, and with
   WebGL disabled.
3. Review with `directus-ui-reviewer`.
4. Open the PR and watch CI.
