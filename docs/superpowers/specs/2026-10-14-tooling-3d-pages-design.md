# Tooling record pages with an interactive 3D insert view

Date: 2026-10-14. Status: approved (design settled in conversation; the user waived the written review).

## Goal

A tool box, a cutting insert and an insert edge each get a STARbase **record page**, and all three are
one page with one interactive 3D view at the top. The box shows its numbered inserts; clicking an insert
moves the camera to it and the page's record changes to that insert; the insert shows its lettered edges;
clicking an edge zooms onto it and the record changes to that edge. It must be fast, feel modern, and
follow STARbase's look (theme variables, light and dark).

Purpose (Q1): both choosing the next fresh edge at the machine (state colours, a "next fresh edge"
shortcut on the box) and tracing an edge's history (tests and operations, linked to the Force plotter).

## Settled decisions

| # | Decision |
|---|---|
| Lettering | Edge letters run clockwise from the insert's reference mark, viewed from the top: the top face first (A, B, …), then the underside (C, D, …), with C directly under A. Only corners that can cut get a letter (CNMG 4, TNMG 6, SNMG 8, CCMT 2). Legacy `fA`/`fC`: ignore the `f`. See `CONTEXT.md` › Tooling. |
| Q1 | Both purposes; box level leads with state and "next fresh edge", edge level with its history. |
| Q2 | The term is **Tool box** (avoid "insert box"). |
| Q4 | A is the cutting corner nearest the reference mark; the view draws a small notch at the mark. |
| Q5 | Three record pages, `/tool-boxes/:id`, `/inserts/:id`, `/edges/:id`, rendered by one page component. Moving inside a box only moves the camera; nothing remounts. |
| Q6 | `is_used` is the truth. The page warns when it disagrees with linked tests or operations. No wear columns. |
| Q7 | The box is a clean tray with a grid sized from the number of inserts (10 → 2 × 5), numbered in reading order. |
| Q8/Q16 | Shape from the ISO 1832 designation (shape C D S T V W R, clearance letter, hole type, size, thickness, nose radius). Non-null `insert_types` columns (`included_angle_deg`, `nose_radius_mm`, `cutting_edge_length_mm`, `fixing_hole_diameter_mm`) override the parsed values. An unreadable designation falls back to a regular polygon from `edge_count`, with a "shape not recognised" note. No STEP import. |
| Q17 | Flat top face with a subtle bevel; no invented chipbreaker. |
| Q9 | STARbase only. three.js loads only when the page opens (a lazy chunk). Reports and Data Studio are unchanged. |
| Q10 | Next fresh edge: the lowest-numbered non-depleted insert that already has a used edge, its first fresh letter (A → B → C → D); if none is part-used, the lowest-numbered insert with a fresh edge. |
| Q11 | No in-page state changes. Edit opens the existing `EditDrawer` / Data Studio form. |
| Q13 | Click selects; constrained orbit and zoom; Esc or the breadcrumb goes up a level; arrow keys step between inserts or edges; hover label; ~400 ms camera ease, instant under `prefers-reduced-motion`. |
| Q14 | No WebGL, or a stage narrower than 600 px: a 2D slot grid with the same selection and URLs. |
| Q15 | The Tool boxes, Cutting inserts and Insert edges index rows open the record page (`rowTarget: 'record'`); `recordRoute` maps the three collections. |

## Data (read as the signed-in user, `/items`)

Confirmed columns (`db/schema.sql`):

- `tool_boxes`: `tool_box_id`, `tool_box_code`, `insert_type_id`, `description`, `location`, `package_quantity`, `project_id`, `owner_person_id`, `version`.
- `cutting_inserts`: `insert_id`, `insert_code`, `tool_box_id`, `insert_type_id` (override), `insert_number`, `is_depleted`, `location`, `notes`.
- `insert_edges`: `edge_id`, `edge_code`, `insert_id`, `edge_identifier`, `is_used`, `notes`.
- `insert_types`: `type_code`, `iso_designation`, `manufacturer_id`, `edge_count`, `nose_radius_mm`, `cutting_edge_length_mm`, `included_angle_deg`, `fixing_hole_diameter_mm`, `inserts_per_box`, `coating`, `substrate`, `material_class`.
- History: `test_sessions.insert_edge_id` and `manufacturing_operations.insert_edge_id`.

Load order: the route's record (box, insert or edge) decides "page" vs "Not found or not visible to
you" and gives the box id. The box, its inserts and their edges then load as one **model** keyed by
box id; a route change inside the same box reuses it. The edge's history and the insert type load as
sections that fail on their own (`useSections`, `useRequestGate`).

## Units

**`@d1/ui` › `tooling/` (pure, vitest):**

- `isoDesignation.ts`: `parseIsoDesignation(text) → IsoInsert | null`. Accepts `CNMG120408-PM`, `CNMG 12 04 08-PM`, `CCMT09T304`.
- `insertGeometry.ts`: `resolveInsertGeometry(type) → InsertGeometry`, merging the overrides and the `edge_count` fallback; `insertOutline(geom)` → the 2D outline with nose fillets and the corner list (angle, centre, which corners cut).
- `edgePlacement.ts`: `placeEdge(geom, identifier) → { face, corner } | null` (strips the `f`).
- `boxLayout.ts`: `slotGrid(count)` → columns, rows and each slot's cell in reading order.
- `toolingModel.ts`: `buildToolingModel(box, type, inserts, edges)` → the one object the view draws; `insertState()` (fresh, partly used, used, depleted); `nextFreshEdge(model)`; `edgeUsageMismatch(edge, historyCount)`.
- `recordRoute.ts` and `indexConfig.ts`: the three collections become record pages.

**`@d1/starbase-pages` › `pages/tooling/`:**

- `ToolingPage.vue` on one route record, `:kind(tool-boxes|inserts|edges)/:id`, so moving between
  the three kinds keeps the instance (and the WebGL context) alive.
- `useToolingData.ts`: the loads above.
- Rail and panels for the focused record: `BoxPanels.vue`, `InsertPanels.vue`, `EdgePanels.vue`.
- `stage/ToolingStage.vue`: picks the 3D view (lazy `import()`) or `SlotGrid2D.vue`.
- `stage/scene/*`: three.js, imperative and outside Vue reactivity. One shared insert geometry per box
  (instanced), edge segments as separate pickable meshes, a raycast picker, a camera rig that eases
  between framings, render-on-demand (no loop at rest), theme colours read from CSS variables and
  re-read on theme change, full dispose on unmount.

## Look

The stage is a full-width panel at the top of the main column (about 420 px high), in the theme's tile
colour with a soft ground shadow. Insert state colours come from the kit's `--d1-ok`, `--d1-warn`, and
`--d1-dim`, with `--d1-accent` for the selection. Labels are HTML overlays in Inter, projected from 3D.
The rail keeps the standard Sample-page order: identity, actions, facts, then "On this page".

## Errors and edge cases

- A box with no visible inserts draws the empty tray, with a "No inserts visible to you" note.
- Edges with no placement (an unreadable letter, or a letter beyond the shape's corners) are listed beside
  the stage as "position unknown" and stay selectable.
- WebGL context loss falls back to the 2D grid.
- More than 60 inserts in one box: the tray still draws, and the 2D grid is offered.

## Testing

- vitest for every `@d1/ui/tooling` function (designations from the seed, CCMT, every shape letter,
  overrides, fallback, legacy `f`, slot grids, next fresh edge).
- vitest for the scene builders in Node (geometry counts, picking ids, dispose), without WebGL.
- Route test: one route record for all three kinds.
- Headless render against a stubbed `/items` (kept out of the repo) for screenshots.
- Physical test backlog: open a real box on real data, in light and dark, and on a machine without WebGL.

## Addendum 2026-10-14: tall side rail and tipped inserts

Requested after the first review of PR #286 and approved in conversation.

- **The stage is a tall side rail.** The 3D stage moves out of the main column into the left rail, in
  the `RecordRail` `#extra` slot (as the Sample drawing is), below identity and actions. The rail widens to
  about 360 px on tooling pages only (a rail-width variable on `RecordLayout`, default 300 px), and stays
  sticky. The stage is portrait (about 360 × 560 px).
- **The box turns 90°.** `slotGrid` is portrait: the long side of the tray runs down the stage (10 → 2
  columns × 5 rows), numbered in reading order. The camera frames the tall tray; the 2D grid is portrait too.
- **3D by stage size.** 3D needs the stage to be at least about 260 px wide and 360 px tall, not 600 px
  wide. Tooling pages stack only under 840 px of layout width (`RecordLayout` `late-stack`, against the
  usual 1000 px), so a 1280 px laptop with the sidebar open keeps the tall rail; when stacked, the stage
  sits above the panels.
- **Edge count caps the cutting corners.** When `insert_types.edge_count` is below the shape's cutting
  corners, only the first `edge_count` corners cut (from A), and the insert is single-sided.
- **Tipped inserts (PCD, PCBN, CBN).** Detected from the insert type's substrate, type code
  or ISO designation. Each cutting corner gets a brazed tip pad in a lighter, diamond-grey material.
- **One-insert boxes.** A box holding one insert draws as a small single case, and the box framing opens
  close on that insert.
