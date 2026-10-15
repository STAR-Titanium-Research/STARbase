# Process map — design

Date: 2026-10-14 · Branch: `feat/process-map` · Status: decided with the maintainer in chat (2026-10-14);
the maintainer waived the written-spec and plan review stops for this stream ("implement right after").

Supersedes §6.1 ("Lineage graph, `/graph`") of
`docs/superpowers/specs/2026-10-13-directus-headless-design.md`. Visual reference (the agreed mockup,
open it in a browser): [`assets/process-map-mockup.html`](assets/process-map-mockup.html).
Glossary: `CONTEXT.md` → "Samples and their history" (**process map**, **lineage**, **batch**,
**probable batch**, **FAST run**, **powder batch**).

## 1. What and why

The Cytoscape "lineage graph" (`core/extensions/d1-lab-dashboard/src/views/NodeGraph.vue`, coloured
circles, one hop per click, no details) is removed. In its place STARbase gets the **Process map**: a
page that shows how samples came to be, drawn like Blender's node editor. Operations and tests are
**containers**: the samples that went through them enter on input sockets and leave on output sockets,
and what was used (machine, tool, insert edge, recipe, data file, …) sits **inside** the container.
Samples flow left to right.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | STARbase page **Process map** at `/map?focus=<collection>:<id>&reach=<n|all>`. Sidebar entry in **Analysis**; a "Process map" button in the rail of the record pages, and a row action on the index pages of kinds without a record page (see §8). No embedded copy on record pages. |
| D2 | Look: STARbase's own design (Directus theme variables, `@d1/ui` kit tokens, `RecordRail`, `Section`, `StatusBadge`, `FactList`, v-button stand-ins). Record rail on the **left** (300 px), canvas on the right — the record pages' layout. |
| D3 | Library: **Vue Flow** (`@vue-flow/core`, `@vue-flow/minimap`, `@vue-flow/controls`, `@vue-flow/background`) with **elkjs** `layered`, direction RIGHT. Route lazy-loaded. |
| D4 | An **operation** is a container: a header (method, code, status, ＋), one **sample row** per sample through it (input socket left, output socket right; in-place work = the same sample in and out, drawn with a dashed pass-through line), the **Inside** tray, then the **key settings**. |
| D5 | A **test** is a container like an operation: one row per subject sample (`test_sessions_subject`); no output socket when `test_category = 'destructive'`. Equipment, insert edge, operators and data files go Inside. |
| D6 | Inside tray: **every relation on the record's form**, read at runtime from the collection's relations; the **major** ones are shown, the rest fold under "+N more from the form". Major = machine, tool, insert edge, recipe (FAST or prep), data file. |
| D7 | Key settings only (≤ 4 per container, chosen per process category, §6.4). |
| D8 | More than 3 sample rows: show 2 and fold the rest into a bundled "+N more samples" row with a larger socket and a thicker wire; clicking it unfolds. |
| D9 | A cut is a container with 1 input row and N output rows (several operation rows with the same input sample, grouped — §5.3). |
| D10 | **Lineage** with no operation behind it is a small dashed **junction** labelled by its type (Cut from / Sintered from / Powder from / Derived from); siblings with one parent and one type share it; the fraction shows per output. |
| D11 | A sample with several parents has one input socket per parent (folded past 3). |
| D12 | A **raw stock lot** feeds a sample: wired into the input of the operation that made the sample when there is one, else into the sample card. When a FAST run has no stock lot but has a **powder batch** text, its input is a text-only card "Powder batch: TIMET 45-150 · not linked to a stock lot". Material shows in facts; a **material** card appears only as the origin of a root sample that has no making operation and no stock lot. |
| D13 | The focus record's **project** is a frame (Blender frame node) drawn round all nodes, labelled with the project; records of other projects carry a project tag in their meta line. |
| D14 | **Batches**: a recorded batch (slice 2) groups operation rows / test rows into one container; otherwise a **probable batch** is guessed (§5.3) and drawn dashed with a "probable batch" header; a Show chip "Probable batches" (on by default) turns guessing off. |
| D15 | Click on a card **selects** it into the rail. The **＋** button on a card (and **Expand** in the rail) loads more. |
| D16 | Hover on a card or an Inside slot shows its **hover card** (the RecordRail identity block, a data thumbnail when the record has data, facts, counts). |
| D17 | Wires carry no labels. Hover on a wire shows the sample it carries, where it comes from and where it goes; hover on a socket lists its wires. **Ctrl/⌘+click** on a wire selects and centres its origin. |
| D18 | Cards can be dragged for this visit; **Re-layout** puts them back. Positions are not saved. |
| D19 | Opening on a sample loads its whole family (§7). **Reach** (1, 2 default, 3, Whole history) only limits what is *shown*. |
| D20 | Opening on a tool, machine, insert edge, recipe or stock lot shows a **used-in fan**: the operations (and tests, for equipment and insert edges) that used it, as collapsed containers (header only), newest first, 20 at a time with "+N more"; each expands into its sample flow. Material and Project show a fan of their **samples** (cards), each expandable. Operation and Test focus open the family of their (first) input sample with that container focused. |
| D21 | Records the person may not read are a **marker only** ("some records hidden" on the socket where they would join) — no placeholder card and no count (A1a decision 15). |
| D22 | Limits: `d1-trace` cuts each list at 500; the map has a soft cap of **300** cards. Hitting either shows a banner "Showing part of this history" and Reach is clamped to what fits. |
| D23 | Keyboard: Tab through cards and Inside slots, Enter selects, `+` expands, `o` opens the record; a focused socket lists its wires in the rail. |
| D24 | Phones (< 768 px): the map pinches and pans; the rail is a bottom sheet; tap selects, long-press shows the hover card; the minimap is hidden. (The listed exception to "phones get lists".) |
| D25 | Address: `focus` and `reach` are in the URL, so Copy link reproduces the view. Show chips are remembered per person on the device (localStorage, wrapped in try/catch). |
| D26 | **Export** PNG and PDF of the *whole* map at the current Show settings, with a header (focus code and kind, date, who exported) and a legend. PDF: one landscape page, A4, or A3 when the map is wide. `html-to-image` + `jspdf`, both lazy-loaded on click. |
| D27 | Batches are **recorded** (slice 2): a `batches` table and `batch_id` on operations and tests (ADR-0017). |
| D28 | The FAST field `sintering_batch_number` is relabelled **Powder batch** (help text: "The powder batch typed on the FAST press, e.g. TIMET 45-150. Names a raw stock lot but is not linked to it."). Matching those texts to stock lots is later work. |
| D29 | Removed now: `NodeGraph.vue`, every embedded "Connections" panel that uses it, the `/graph` view of `d1-lab-dashboard`, the `cytoscape` dependency, and the Sample page's "Open lineage graph" link. The rest of `d1-lab-dashboard` stays until headless phase 2. |

## 3. Delivery

One spec, three slices, a plan each, executed in this order; each slice is usable alone.

1. **Map core** — the page, the graph model, containers, junctions, probable batches, rail, hover cards,
   wire hover and Ctrl+click, drag/Re-layout, phones, keyboard, the record-page buttons and sidebar
   entry, and the Cytoscape removal (D29). No schema change.
2. **Recorded batches** — migration (table, columns, Directus metadata, permissions, `B-` codes),
   the form field, grouping on `batch_id`, the Powder batch relabel, ADR-0017.
3. **Export** — PNG and PDF.

## 4. Facts the design rests on (from the database, 2026-10-14)

- `manufacturing_operations`: `sample_id` = the input (workpiece), `output_sample_id` = the sample it
  made (FAST, additive, cuts). The check allows a row with neither when `source_system` is set (FAST
  imports with no sample yet) — such a container has **zero sample rows** and must render cleanly.
  Ordering: `operation_date`, then `operation_sequence`. Relations: `method_id`, `project_id`,
  `campaign_id`, `equipment_id`, `tool_id`, `insert_edge_id`, `material_id`, `source_recipe_id` (prep
  recipe), FAST recipe (sintering fields / `fast_recipe_id` where present), `operator`,
  `operator_person_id`, `owner_person_id`, `gcode_file`, `force_file_id`.
- Trigger `mfg_op_link_genealogy`: when an operation has both `sample_id` and `output_sample_id`, it
  writes a `sample_genealogy` row (child = output, parent = input): `sintered_from` for MF/MHIP,
  `cut_from` for MC/MM/MC2/MEDM/MCO/MX/MS, else `derived_from`.
- `sample_genealogy`: `child_sample_id`, `parent_sample_id`, `relationship_type` ∈ {derived_from,
  cut_from, sintered_from, powder_from}, `fraction` (0–1 or null). A child may have several parents.
- `test_sessions`: subjects through the M2A junction `test_sessions_subject(test_sessions_id,
  collection, item)` — `collection` is `physical_samples` or `insert_edges`, `item` is the id as text.
  `test_sessions.sample_id` is kept in sync as the primary subject. Relations: `equipment_id`,
  `insert_edge_id`, `project_id`, `campaign_id`, operators, owner, `session_data_files` (files).
  `test_category` ∈ {nde, destructive, dynamic, other}.
- `sample_stock_provenance(sample_id, lot_id, mass_used_grams)` → `raw_stock_lots`.
- `GET /d1-trace/sample/:id` → `{ sample, stock_origins[], ancestors[], events[], descendants[],
  hidden{…: boolean}, truncated{} }`. Ancestors/descendants carry `relationship_type`, `fraction`,
  `through_hidden`. `events` lists only operations where the **root** is the input and tests where the
  root is the primary subject — so the operation that *made* a sample, and every event of the other
  family members, must be fetched separately (§7).
- The FAST field `sintering_batch_number` holds free text ("TIMET 45-150", "SAVOIE CHIP 1.0-4.5",
  "705"); on live up to 13 FAST runs on one day share one value. It is a powder batch, not a batch.

## 5. The graph model (pure TypeScript, no Vue)

### 5.1 Units

All in `packages/starbase-pages/src/pages/map/model/`, each with its own unit tests:

| Module | Does | Input → output |
|---|---|---|
| `types.ts` | The graph's types | — |
| `loadFamily.ts` | Fetches everything for a focus through `host.api` (§7) | `(api, focus) → ProcessData` |
| `groupBatches.ts` | Recorded batches, then probable batches (§5.3) | `(operations, tests, opts) → Group[]` |
| `buildGraph.ts` | Turns data into nodes and wires (§5.2) | `(ProcessData, groups, opts) → ProcessGraph` |
| `reach.ts` | Which nodes show for a focus and a reach | `(ProcessGraph, focusId, reach) → Set<id>` |
| `formSlots.ts` | Inside-tray slots from the collection's relations; major vs folded | `(relations, fields, record) → Slot[]` |
| `elkInput.ts` | ELK graph from shown nodes, measured sizes and ports | `(ProcessGraph, shown, sizes) → ElkNode` |

`ProcessGraph = { nodes: MapNode[]; wires: Wire[]; hidden: HiddenMarker[]; truncated: boolean }`.
`MapNode` is one of `record` (sample, stock lot, powder-batch text, material, …), `container`
(operation or test, or a group of them), `junction`. A container has `rows: SampleRow[]` (each
`{ in?: Socket; out?: Socket; sampleId?; recordId }` — `recordId` is the operation or test of that row),
`slots`, `settings`. Every socket has a stable id (`<nodeId>:in:<i>`, `<nodeId>:out:<i>`,
`…:b` for the bundle) used as a Vue Flow handle id and an ELK port id.

### 5.2 Building rules

1. Every family sample is a **record** card with one input socket per incoming wire source (D11) and
   one output socket.
2. Every operation and test becomes a **row** of a container; rows are grouped into containers by §5.3;
   ungrouped rows are containers of one row.
3. Row wiring: input sample → row's input socket; row's output socket → `output_sample_id` (a new
   sample) or, for in-place work and non-destructive tests, → the next step of the same sample in date
   order (`operation_date`, `operation_sequence`, then test `session_date`); the last step's output is
   left open. In-place work never creates a second card for the same sample.
4. **Lineage dedupe:** a genealogy row (parent P, child C) is *covered* when some loaded operation has
   `sample_id = P` and `output_sample_id = C`. Only uncovered rows become **junctions** (D10); without
   this every logged cut draws twice.
5. **Stock origins** (D12): lot → the making operation's input when the sample has one, else → the
   sample card. A FAST operation with no lot but a powder-batch text gets the text-only card.
6. Material card only for a root sample without making operation and lot (D12).
7. Bundling (D8): with more than 3 rows, rows ≥ index 2 share the bundle sockets `…:in:b` / `…:out:b`;
   their wires are marked `bundled` (drawn thicker).
8. `hidden` flags from `d1-trace` become markers on the focus sample's input (ancestors, stock origins)
   or output (descendants, events) socket.

### 5.3 Batch grouping

Recorded first: rows with the same `batch_id` form one container (header "Batch B-0001"). Recorded
grouping applies to every process category. Rows with a `batch_id` never join a probable batch.

Probable (only when the "Probable batches" chip is on), on the remaining rows:

- **Same input sample** — any category, machining included: operation rows with the same `sample_id`,
  method, machine and calendar day, at least 2 → one container (a cut into pieces: 1 input row shared,
  N output rows).
- **Several samples together** — only `sample_prep`, `heat_treatment` and `additive`: rows with
  different input samples but the same method, machine, calendar day and recipe (blank = blank), at
  least 2.
- **Never**: different input samples in `machining`, `sintering` or `deformation`; never rows with a
  `source_run_uid` (FAST runs imported from the press: one press cycle each).

Required fixtures: 13 sintering runs, one day, one recipe, one powder batch → **no** group; 4 cuts from
one sample on one day → **one** group with 1 input and 4 outputs; 4 polishing rows on 4 samples, one day,
one machine and recipe → one group; the same on a lathe → no group.

A group's Inside tray shows a value once when all rows share it, else "N different" (expandable).
Settings likewise ("varies").

## 6. The page

### 6.1 Layout

`ProcessMapPage.vue` in `packages/starbase-pages/src/pages/map/`, inside the normal page frame: the
crumb line (`<kind list> / <focus code> / Process map`) with title actions (Copy link; Export ▾ in
slice 3); then a two-column grid like `RecordLayout`: the **rail** (left, 300 px, sticky) and the **map
panel** (a `Section` whose lid holds the search box, the direction toggle Left→right / Top→down,
Re-layout, Fit and Clear; the body is the Vue Flow canvas filling the viewport height).

### 6.2 Nodes (Vue Flow custom nodes)

- `RecordNode.vue` — a raised `RecordCard`: kind pill (colour per kind), status badge, ＋, code, one
  meta line; sockets as Vue Flow `Handle`s on the left/right edges.
- `ContainerNode.vue` — header (method or "Batch B-0001" / "Probable batch", code, status, ＋), sample
  rows with handles, the Inside tray (`SlotRow`, "+N more from the form"), key settings grid.
- `JunctionNode.vue` — dashed; type pill; one input, outputs with fraction labels.
- Project frame: drawn behind the nodes from the laid-out bounds (not an ELK compound node).

Kind colours: the old graph's palette as `--k-*` custom properties in the page (sample #9C27B0,
operation #FF9800, test #00ACC1, equipment #607D8B, tool #795548, insert edge #E91E63, material
#4CAF50, project #673AB7, recipe #7CB342, data file #546E7A, person #5C6BC0, campaign #26A69A), inked
toward the text colour for text exactly as `--d1-ok` does, so light and dark both pass contrast.

### 6.3 Wires

A custom Vue Flow edge (bezier) coloured by what flows (sample, stock/material). A wide transparent
hit path carries hover (D17 tooltip) and Ctrl/⌘+click. Bundled wires are thicker. While a card or slot
is hovered, its own wires are highlighted and everything not adjacent dims.

### 6.4 Key settings per process category

| Category | Settings (first 4 present) |
|---|---|
| sintering | max temperature, max force, dwell, mould diameter |
| machining | cutting speed, feed, depth of cut, coolant |
| sample_prep | steps / final abrasive, force, time |
| heat_treatment | temperature, time, atmosphere, cooling |
| additive | layer thickness, power, scan speed, build plate |
| deformation | temperature, strain, strain rate, force |
| tests | test type, standard, headline result |

Read from the operation's inline parameter fields by name; a missing value is skipped, not shown blank.

### 6.5 Rail

From top: the selected record's `RecordRail` (kind, status, code, title; actions **Open record**,
**Expand**, **Centre**; the sample drawing for samples (`SampleGeometry`); the data thumbnail when the
record has data; facts); **Connections** (`Section`, grouped: Came in from / Went on to / Inside /
Used in / In this project; hover → hover card on the canvas; click → select and centre); **Show** chips
(one per kind present, Settings, Probable batches); **Reach** (1, 2, 3, Whole history).

### 6.6 Hover card and data thumbnails

The hover card is the rail's identity block + data thumbnail + facts + counts + a hint line. It opens
after 250 ms, beside the card (flips left, then below, to stay on screen), and is not focusable.
Data thumbnail: a small multi-line plot (~260×64) — force Fx/Fy/Fz for an operation with a force file,
temperature and force for a FAST run, stress–strain for a test with a curve. Source per kind is fixed in
the slice-1 plan from whatever preview data already exists; a record whose data has no cheap preview
shows the file name and "Open in plotter" instead of a curve. Never downloads a full data file for a
thumbnail.

### 6.7 Layout engine

`useElkLayout`: wait for Vue Flow's nodes-initialised signal, read each node's measured size, build the
ELK graph (`elkInput.ts`: `elk.algorithm=layered`, `elk.direction=RIGHT` or `DOWN`,
`elk.portConstraints=FIXED_ORDER` on containers, ports from socket ids, spacing tuned to the mockup),
run `elkjs/lib/elk.bundled.js` (no worker), then set positions with a short animation. After an expand,
nodes already placed keep their layer (ELK `interactive` layering seeded with current positions).
Dragging sets positions locally; Re-layout reruns ELK. Changing Show, Reach or folding a row keeps every card where it is
(new cards are placed around them, `placeMerged`); only Re-layout and a change of direction re-lay everything.

## 7. Loading data

Through `useExplorerHost().api` only (permissions apply; no SDK import — `hostNeutral` guard).

Sample focus:
1. `GET /d1-trace/sample/:id` → family ids (root, ancestors, descendants), stock origins, hidden,
   truncated.
2. Operations where `sample_id ∈ family` **or** `output_sample_id ∈ family`, in chunks of ≤ 150 ids per
   request (the query string stays well under 8 KB), with the fields the containers need (method name
   and category, codes, dates, sequence, status, the major relations with code/name, `batch_id` when it
   exists, settings fields, `source_run_uid`, `sintering_batch_number`).
3. Tests whose `test_sessions_subject` has `collection = physical_samples` and `item ∈ family`
   (chunked), with their relations.
4. Genealogy rows among family ids (for junction coverage and fractions).
5. Field labels and relations of `manufacturing_operations` and `test_sessions` (`/fields/<c>`,
   `/relations/<c>`), cached for the session, for the Inside tray (D6). If those calls are refused,
   fall back to a fixed list of the known relations.

Used-in fan (D20): operations (or tests) filtered by the relation (`equipment_id`, `tool_id`,
`insert_edge_id`, recipe, or the stock lot through `sample_stock_provenance`), `sort=-operation_date`,
`limit=20`, `meta=filter_count` for "+N more". The campaign fan and the stock-lot fan are counted from a junction or
provenance table whose rows the target's permissions do not filter, so a count could include records the person may
not read: those two fans show "More" **without a number** (D21) and keep paging until a page comes back short.
The same two fans carry the D21 marker ("some records hidden", on the fan's record) when a junction or provenance row
names a sample the person may not read. A row whose sample was deleted shows it too (conservative: it cannot be told from
an unreadable one), and an unreadable making operation behind a readable sample gives no marker (no signal to read).

Expand (＋): on a slot record → its used-in fan beside the container; on a sample outside the loaded
family → that sample's family (steps 1–4) merged in. Each request goes through `useRequestGate` so a
newer focus cancels older work. Errors show with `errorText` in the map panel, keeping what is loaded.

## 8. Entry points

- Sidebar: **Process map** (`to: '/map'`) in the Analysis section (search-first when opened without
  `focus`: the map panel shows the search box and recent records). `/map` joins `LOCAL_PAGES` in
  `packages/d1-ui/src/links.ts` (a page with no `/home` form) and `starbaseRoutes` (before the
  `:slug` catch-all); `routes.test.ts` and spec 13's `EXTRA_ROUTES` gain it.
- A **Process map** button (icon `workflow`) in the rail actions (`RecordActions` slot) of the five
  record pages that exist: Sample, Operation, Test, Project, Campaign (Campaign opens a fan of its
  samples, like Project). The Sample page's "Open lineage graph" link (to `/d1-lab-dashboard/graph`) is
  removed.
- Tool, Equipment, Stock lot, Recipe (FAST and prep) and Material have no record page (they
  open the Data Studio form): their **index pages** get a per-row "Process map" action that opens the
  used-in fan. Insert edge has a record page since the tooling pages (`ToolingPage`, kind `edges`): its
  rail has the same **Process map** button as the five above, and its index row keeps the action (harmless).
  Tool boxes and cutting inserts have tooling pages too but are not map focuses: no button. Inside the map, a slot's hover card also offers "Process map of <code>".
- `links.ts`: `canonicalPath` keeps `focus` and `reach`. The `/d1-lab-dashboard/graph` resolver test
  (`links.test.ts`) goes with the view.

## 9. Slice 2 — recorded batches

- Migration (next free number across all branches; the pattern of `20261012000164_label_templates.sql`:
  comments, OCC + audit triggers, `directus_collections`/`directus_fields`/`directus_relations` rows, Lab
  Member permissions mirrored in `scripts/access_rules.json`): table `batches` (`batch_id` uuid pk,
  `code` text unique not null **default** `batches_next_code()` (`'B-'` and the next `batches_code_seq` number padded to at
  least four digits, never truncated: B-9999, B-10000; a plain `lpad(n, 4, '0')` would cut B-10000 to B-1000) —
  a default, so Directus does not treat it as required, plus a `BEFORE INSERT` trigger that fills a blank code; `d1-next-number` has no prefix config and needs
  no change), `batch_date` date, `notes` text, `owner_person_id` → people, the house audit columns),
  and **nullable** `batch_id` (FK `ON DELETE SET NULL`,
  indexed) on `manufacturing_operations` and `test_sessions`. Directus metadata for the collection and
  the two fields (an M2O dropdown with "create new"); the `sintering_batch_number` field's translation
  becomes "Powder batch" with the D28 help text. Permissions follow ADR-0014 (decided in the plan after
  reading it; a batch holds no sample data of its own).
- Grouping (§5.3) reads `batch_id`.
- ADR-0017 "Batches are recorded; probable batches are only shown".
- Tests: SQL migration test (up/down, FK, nullable), and a Directus smoke on the `d1-starbase` preview
  (create a batch, attach two operations through the REST API, edit and copy one) — the house rule after
  the `short_id` incident.

## 10. Slice 3 — export

Export ▾ (PNG, PDF) in the title actions. Both render an off-screen export frame: header (focus code and
kind, date, exporter), the whole graph, and a legend of the kinds present. The graph is a clone of the Vue Flow
pane (its transformation pane, so the hover card, controls and minimap are not in it) put into the frame at
zoom 1, sized to the bounds of the drawn cards (and the project frame, when it is drawn) plus padding, with the
cards' own controls (the + buttons, fold and "more" toggles) filtered out. `html-to-image` takes the picture
(`toBlob` for the PNG, `toPng` for the PDF's image) at pixel ratio 2, reduced to stay inside the canvas limits
(each side 16384 px; 64 MP in all, 16 MP on touch devices); `skipFonts: false`, because the card icons are a
same-origin icon font. A browser that refuses the canvas returns an empty picture: it is retried once at ratio
1 and then reported ("This map is too large to export in this browser"), never saved. PDF = `jspdf` with the
picture on one landscape page, A4 or A3 when the aspect ratio is wider than 2:1, at the ratio 300 dpi needs
there (at most the PNG's). Check STARbase's CSP / Caddy headers
allow `img-src data: blob:` and that fonts are same-origin (embeddable). Downloads use the existing
credentialed-blob pattern (never navigate).

## 11. Testing

- **Unit** (vitest, slice 1): `groupBatches` (the §5.3 fixtures), `buildGraph` (in-place chain, cut
  1→N, lineage dedupe, multi-parent sockets, stock lot into making op vs into the card, powder-batch
  card, zero-row FAST container, bundling past 3, destructive test without output, hidden markers),
  `reach`, `formSlots` (major vs folded, unknown relation folded), `elkInput` (ports in row order,
  sizes passed through; not pixel positions), `loadFamily` (chunking at 150, the four queries, fallback
  when `/fields` is refused).
- **Component** (vitest has no DOM here: SSR `renderToString`, as `navStandalone.test.ts` does, with
  Vue Flow's `Handle` stubbed): `ContainerNode` renders rows, bundle, tray, settings; wire tooltip text.
- **E2E** on the preview (`D1_PREVIEW_NAME=d1-starbase`, port 18057), as admin and as a lab member: open
  `/map?focus=physical_samples:<id>`, expand a slot, hover a wire (tooltip), Ctrl+click jumps, open a
  record from the rail; the Sample page button opens the map; the route harness (spec 13) includes
  `/map`; nothing references `/d1-lab-dashboard/graph`.
- Guards stay green: `noSdkImports`, `hostNeutral` (no `router-link`, `router.push(`, `window.open(`,
  `/assets/` strings in the new files — use `AppLink`/`openLink`/`RecordLink`); `d1-lab-dashboard`
  still builds without `cytoscape` (its `Module.vue` "Node Graph" button and the three dashboards'
  embedded `<NodeGraph>` go).

## 12. Out of scope

Saving dragged positions; a batch record page; a "Log a batch" task screen; matching powder-batch texts
to stock lots; editing anything from the map (records open their own page / the Data Studio form);
embedding the map on record pages.
