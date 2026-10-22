# Process map creator: kinds in the palette, values on the cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round 1 of the creator design: a palette of kinds, the operation/test kind chosen on the card, required fields and key settings typed on the card with what is missing marked amber, the three first-minute frictions fixed, and a grouped draft bar.

**Architecture:** Front-end only, in `packages/starbase-pages/src/pages/map` (edit mode in `edit/`, cards in `nodes/`) plus one prop on the kit's `FieldForm` (`packages/d1-ui/src/form`). Cards and the side form edit the same draft item through `EditMode.setValues`; every add stays one `EditMode.apply([...])` step. No server, schema or draft-type change.

**Tech Stack:** Vue 3 + TypeScript, Vue Flow, vitest (+ happy-dom render helpers already used in `nodes/*.test.ts`, `edit/*.test.ts`), Playwright specs under `tests/ui/specs` (local stack, Linux only).

**Spec:** `docs/superpowers/specs/2026-10-22-process-map-creator-kinds-design.md` (round 1: K1–K6, K8–K13; **not** K7 Feedstock).

## Deviations from the spec (decided while planning, from the code)

- K6's "Use an existing sample instead" link on a new Sample card is left out of round 1: replacing a card that may already be wired is a
  new interaction; an existing sample stays reachable through the add search ("Existing sample…") and the lid's Pick samples.
- K12: the lid's delete and merge icons are **Remove** and **Dissolve** of the selected card, not draft actions, so they stay with the
  editing tools; the "Draft ▾" menu holds My drafts and the save status.
- K8: "required" for a planned operation/test is what today's checks ask (method and wiring block; machine and planned date warn), so
  the card's amber follows `checksFor(...)`; no new requirement is invented.

## Global Constraints

- Round 1 has **four** palette kinds: Sample, Operation, Test, From database…; no Feedstock entry, card, type or wire.
- No change to `core/extensions/d1-build`, migrations, `@d1/ui` draft types (`build/types.ts`) or saved-draft shape; drafts saved before this branch load unchanged.
- One draft model: cards write through `EditMode.setValues(key, values)` (its 1.5 s typing fold is the undo granularity for typing); an add, its wire and its placement stay one undo step (`EditMode.apply([...actions])`).
- Inline fields only on **draft** items that are editable today (`ContainerNode`'s `editable`, RecordNode's equivalent); recorded/done cards unchanged.
- Key settings on a card: at most **4** (`MAX_SETTINGS`), after the required ones, no repeats.
- Amber = still to fill in (blocking or warning checks that are not server codes); red only for `SERVER_ONLY_CODES` checks.
- Kind pills stay; text on screen uses CONTEXT.md words; copy is sentence case.
- Card inputs never trigger map shortcuts, drag or pan (`nodrag nopan`, existing `keyTarget` typing rule).
- Copy (verbatim): palette hint `Click, Enter or drag to add.`; kind dropdown placeholder `Choose the kind…`; unset-kind check `Choose what kind of operation this is.`; card header `N missing` / `ready`; draft bar `N to fill in`; kind-change notice `Kind changed to <kind>: <n> value(s) dropped · Undo` (only when n > 0).

## Review Focus

1. **Typing on a card while the side panel shows the same item:** both stay in step and the caret does not jump (the card's form and the rail's form are two views of `item.values`). Test in Task 4.
2. **Delete / Backspace / arrow keys / Shift+A typed inside a card field** must edit the field, not remove the card or open the add search. Test in Task 4.
3. **Auto-wire must not attach to a recorded (done) sample's output or to a sample whose output is already used**, and must never produce a wire `wireProblem` would refuse. Test in Task 1.
4. **Changing the kind to the same kind, or to another kind of the same process category,** drops nothing and shows no notice. Test in Task 3.
5. **A card that grows when its kind is chosen** must not overlap a neighbour or move a card the person dragged (R6). Test in Task 4 (canvas reflow call) and checked in the browser before the PR.

---

### Task 1: The add path — one click adds once, the new card is shown and selected, and it is wired to the sample you just added (K9, K10, K11)

**Files:**
- Create: `packages/starbase-pages/src/pages/map/edit/addFollowUp.ts`
- Test: `packages/starbase-pages/src/pages/map/edit/addFollowUp.test.ts`
- Modify: `edit/useEditSurface.ts` (`paletteAdd` ~l.116, `addUnconnected` ~l.207), `edit/useAddMenu.ts` (`applyAt` ~l.57: return the new keys), `edit/Palette.vue` (hint l.85 and entry `title` l.100 → `Click, Enter or drag to add.`)
- Test: `edit/useEditSurface.test.ts`, `edit/useAddMenu.test.ts`, `edit/Palette.test.ts`

**Interfaces:**
- Produces (addFollowUp.ts):
  - `export const REPEAT_ADD_MS = 500`
  - `export function isRepeatAdd(last: { id: string; at: number } | null, id: string, now: number): boolean` — true when `last?.id === id && now - last.at < REPEAT_ADD_MS`.
  - `export function autoWireSource(body: DraftBody, selectedKey: DraftKey | null, choice: MenuChoice): DraftKey | null` — for an operation/test choice (incl. Task 2's `newOperation`/`newTest`): the selected key if it is a **new** draft sample (`!existing`) with no outgoing wire, else the last new draft sample in `body.items` order with no outgoing wire, else null; and only when `socketVerdict(body, { kind: 'sample', id: <its node id>, side: 'out' }, choice).ok`. Never a sample with `existing`.
- Produces: `useAddMenu.applyAt(t, choice): Promise<DraftKey[]>` — the keys `newKeys(before, after)` the step added (empty when nothing was done).
- Consumes: `socketVerdict` (addDrop.ts:74), `newKeys` (draft.ts), node ids `s:draft:<key>` (toGraph.ts), `map.select(id)`, `canvas.reveal(id)`, `build.selectKey`.

- [ ] **Step 1: Failing tests** in `addFollowUp.test.ts`: `isRepeatAdd(null,'op:x',0)===false`; `isRepeatAdd({id:'op:x',at:1000},'op:x',1400)===true`; `…,1600)===false`; different id → false. `autoWireSource`: (a) selected new sample with free output + operation choice → its key; (b) nothing selected, two new samples, the second unwired → the second; (c) a sample with `existing` selected and no new sample → null; (d) selected new sample already wired out → falls back to the last unwired new sample, or null; (e) a choice that is not operation/test → null.
- [ ] **Step 2:** `npx vitest run src/pages/map/edit/addFollowUp.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `addFollowUp.ts` (pure, no Vue).
- [ ] **Step 4:** Tests in `useEditSurface.test.ts`: `paletteAdd` called twice with the same entry within 500 ms adds one card (one undo step); after a palette add the new card's node is selected (`map.select` called with `s:draft:`/`op:draft:` id of the new key) and `canvas.reveal` is called with it; a palette Operation add with a new sample selected produces the container **and** a wire from that sample in one step (`undo` once removes both). `Palette.test.ts`: the hint text is `Click, Enter or drag to add.`
- [ ] **Step 5:** Run them → FAIL.
- [ ] **Step 6:** Implement: `paletteAdd` keeps `lastAdd` and returns early on `isRepeatAdd`; when no socket target and `autoWireSource(...)` returns a key, call `menu.applyAt` with `sock: { kind:'sample', id:'s:draft:'+key, side:'out' }` (the existing socket path wires it, one step); after `applyAt` resolves with keys, `select` the first new key's node (no centring) then `canvas.reveal(nodeId)`, then on `nextTick` focus the new card's `[data-kind-select]` if present (Task 3), else its first empty `[data-field] input, select`. Same follow-up for `addUnconnected` (add search with no socket).
- [ ] **Step 7:** `npx vitest run src/pages/map/edit` → PASS; `npx vue-tsc --noEmit -p .` clean.
- [ ] **Step 8: Commit** `feat(map-edit): one click adds once; a new card is shown, selected and wired to the sample just added`

### Task 2: The palette lists kinds; the add search keeps every method (K1, K2)

**Files:**
- Modify: `edit/menuModel.ts` (`MenuChoice` l.23, `catalogEntries` l.126, `actionsFor` l.277, `searchEntries` unchanged), `edit/usePalette.ts`, `edit/recents.ts` (`recentIdOf`), `edit/checks.ts` (method blocker text), `edit/Palette.vue` (section rendering), `edit/useAddDrag.ts` (`draggable`)
- Test: `edit/menuModel.test.ts`, `edit/usePalette.test.ts`, `edit/Palette.test.ts`, `edit/checks.test.ts`, `edit/recents.test.ts`
- Modify e2e (cannot run on Windows; keep them correct by reading): `tests/ui/specs/edit-mode-slice2a.spec.ts` (R1 test l.52-81 → kinds; drags of `/^CNC Turning/` etc. → drag `Operation` then choose the kind on the card, or use `addFromLid`), `edit-mode-slice2c.spec.ts` (l.45, l.95, l.188), `edit-mode-slice4.spec.ts` (l.120, l.196-199, l.266), `edit-mode-slice3.spec.ts` (palette `From database` stays), helpers in `tests/ui/starbase/mapEdit.ts` (add `chooseKind(card, label)`).

**Interfaces:**
- Produces: `MenuChoice` gains `{ kind: 'newOperation' }` and `{ kind: 'newTest' }`.
- Produces: `export function kindEntries(): MenuEntry[]` — in order: `{ id:'kind:sample', section:'Add', label:'Sample', detail:'a new sample', choice:{kind:'newSample'} }`, `{ id:'kind:operation', section:'Add', label:'Operation', detail:'choose the kind on the card', choice:{kind:'newOperation'} }`, `{ id:'kind:test', section:'Add', label:'Test', detail:'choose the type on the card', choice:{kind:'newTest'} }`, then `FROM_DATABASE`.
- Produces: `usePalette` entries = `kindEntries()` + templates (section `Templates`) + recents (section `Recent`) when nothing is typed; while typing, the palette searches the **full** `catalogEntries(...)` (so typing "Turning" in the palette also finds it). The add search (`AddSearch.vue`, `rootEntries`) also lists the kinds first, then everything it lists today.
- Produces: `actionsFor` maps `newOperation` → `container('operation', { from:'blank' })` and `newTest` → `container('test', { from:'blank' })` (same socket/side handling as `operation`/`test`); `recentIdOf` returns null for both; `useAddDrag.draggable` true for both.
- Produces: checks.ts operation-without-method blocker text `Choose what kind of operation this is.` (field `method_id` unchanged).
- Each palette kind row shows the map's kind icon and colour: sample `--k-sample`, operation `--k-op`, test `--k-test` (`kindVar` from nodes/kinds.ts); From database keeps today's look.

- [ ] **Step 1: Failing tests:** `kindEntries()` ids in order `['kind:sample','kind:operation','kind:test','db:attach']`; `actionsFor` with `newOperation` unconnected → one `addContainer` with `source:{from:'blank'}`; from a sample's output → `addContainer` with `from` set (wired); `recentIdOf({kind:'newOperation'}) === null`; `usePalette` with empty query lists no `op:` entry, with query `'turn'` lists `op:<turning id>`; checks text for a method-less planned operation is `Choose what kind of operation this is.`; Palette renders the four kinds with their icons.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/pages/map` → PASS; tsc clean.
- [ ] **Step 5:** Update the listed e2e specs/helpers to the new palette (by reading; note in the commit body that the local-stack suite was not run on Windows).
- [ ] **Step 6: Commit** `feat(map-edit): the palette lists kinds; the add search keeps every method and test type`

### Task 3: Choose the kind on the card (K3)

**Files:**
- Create: `edit/kindChange.ts`, `edit/KindPicker.vue`
- Test: `edit/kindChange.test.ts`, `edit/KindPicker.test.ts`, `nodes/nodes.edit.test.ts`
- Modify: `nodes/ContainerNode.vue` (render `KindPicker` under `.ohead` when the card is `editable` and the item is new), `edit/useEditMode.ts` (add `setKind`), `nodes/actions.ts` (`MapEdit` gains `kind?(node)`), `edit/useEditCanvas.ts` (provide it)

**Interfaces:**
- Produces (kindChange.ts): `export function kindChange(item: DraftOperation | DraftTest, next: { methodId: string; category: ProcessCategory | null } | { testType: string }, keyFields: (item: DraftItem) => string[]): { patch: Record<string, unknown>; dropped: string[] }` — the patch sets `method_id` + `process_category` (operation) or `test_type` (test) and sets to `undefined` every key-setting field of the old kind that is not a key-setting field of the new kind and has a value; `dropped` lists those fields. Same kind or same category → `dropped = []`.
- Produces: `EditMode.setKind(key: DraftKey, next: …same union…): void` — one `apply([{ type:'setValues', key, values: patch }])` step; when `dropped.length` shows the notice `Kind changed to <label>: <n> value(s) dropped · Undo` through the existing lid notice.
- Produces: `KindPicker.vue` props `{ kind: 'operation' | 'test'; value: string | null; methods: MethodEntry[]; testTypes: TestTypeEntry[] }`, emits `choose [ { methodId, category } | { testType } ]`; a `<select data-kind-select class="nodrag nopan" aria-label="Kind of operation"|"Type of test">` with placeholder option `Choose the kind…`, `<optgroup>` per process category in `CATEGORIES` order (label `processLabel(category)`), tests grouped by the prefix of their choice text (`Non-destructive`, `Destructive`, `Dynamic`, `Other`) with the prefix removed from the option text.
- Consumes: `keyFieldsFor` (railForm.ts) for `keyFields`, `edit.catalog.methods` / `testTypes`.

- [ ] **Step 1: Failing tests:** `kindChange` Turning(machining) → Milling(machining) drops nothing; Turning with `machining_feed_mm_per_rev` set → FAST(sintering) drops it and sets `method_id`, `process_category:'sintering'`; same method → `dropped:[]`. `KindPicker` renders optgroups in category order and emits the method's id and category; test options show "Tensile" under "Destructive". ContainerNode (edit) renders `[data-kind-select]` on a new draft operation and not on a recorded one.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/pages/map` → PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(map-edit): choose an operation's kind or a test's type on its card`

### Task 4: Required fields and key settings typed on the card, missing in amber (K4, K5, K6, K8)

**Files:**
- Create: `edit/CardFields.vue`, `edit/cardFields.ts`
- Test: `edit/cardFields.test.ts`, `edit/CardFields.test.ts`, `nodes/nodes.edit.test.ts`
- Modify: `packages/d1-ui/src/form/FieldForm.vue` + its row view (prop `flagged?: string[]` → the row `[data-field=<f>]` gets class `flag`), `packages/d1-ui/src/form/FieldForm.test.ts`; `nodes/ContainerNode.vue` and `nodes/RecordNode.vue` (render `CardFields` below the header when editable and new); `edit/useEditCanvas.ts` (`badge(node)` → `{ count, text, level }` with `level:'refused'` only for `SERVER_ONLY_CODES`, else `'fill'`); `nodes/nodes.css` (`.chk` amber for `fill`, red for `refused`; header text `N missing`, green `ready` when no checks).

**Interfaces:**
- Produces (cardFields.ts):
  - `export function cardFieldsFor(item: DraftItem, body: DraftBody, ctx: { requiredForDone?: string[] }): string[]` — operation/test: `keyFieldsFor(item, undefined, requiredForDone)` without `method_id` / `test_type` (the kind is the picker), key settings capped so that at most `MAX_SETTINGS` (4) key-setting fields remain, no repeats; sample: `['<the name field RecordNode shows as ref.label>', 'material_id', 'form', 'primary_method_id']` (look the name field up in toGraph's sample ref and use that exact column).
  - `export function flaggedFields(checks: Check[], key: DraftKey): string[]` — fields of `checksFor(checks, key)` that are not `SERVER_ONLY_CODES`.
  - `export function readonlyOnCard(item: DraftItem, body: DraftBody): string[]` — `['primary_method_id']` when `makerOf(body, item.key)` is non-null, else `[]`.
- Produces: `CardFields.vue` props `{ item: DraftItem }` (reads `useEditModeInjected()` for catalog, checks, inherited values), renders `DraftItemForm` with `compact`, `keyFields = cardFieldsFor(...)`, `inherited = inheritedValues(...).values`, those fields readonly per `readonlyOnCard`, `flagged = flaggedFields(...)`; `@update` → `edit.setValues(item.key, withCategory(item, patch, …))` exactly as `EditRailItem.vue` does. Root `class="card-fields nodrag nopan"`; a link button `All fields in the side panel` that selects the card (`map.select`) and focuses the rail form. Relation fields (`equipment_id`, `tool_id`, `insert_edge_id`, recipes) styled as today's slot rows with the same icon as `SlotRow` for that role (CSS in CardFields scoped to `[data-field=…]`).
- Produces: `FieldForm` `flagged` prop (amber via `.row.flag` in the card's CSS; FieldForm itself only adds the class).
- After a card's fields first render or its kind changes, call the canvas `reflow()` so neighbours make room (dragged cards keep their place, R6).

- [ ] **Step 1: Failing tests:** `cardFieldsFor` on a planned Turning op → `['equipment_id','planned_date', <≤4 machining key settings>]`, never `method_id`; a FAST op caps at 4 key settings; a new sample → the four sample fields; `readonlyOnCard` → `['primary_method_id']` for a sample with a draft maker, `[]` without; `flaggedFields` drops a `PERMISSION` check and keeps `equipment_id` (warn). `FieldForm` with `flagged:['feed']` puts `flag` on that row only. CardFields: typing in a card input calls `edit.setValues(key, {…})`; a `keydown` of `Delete`/`Backspace`/`a` with Shift inside the input does not reach the map's key handler (assert `keyDecision`/the edit-keys spy not called). `badge` returns `level:'refused'` only with a server code.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/pages/map` and `npx vitest run` in `packages/d1-ui` → PASS; tsc clean in both.
- [ ] **Step 5: Commit** `feat(map-edit): type a card's required fields and key settings on the card; what is missing is amber`

### Task 5: The draft bar in three groups, "N to fill in", one status mark per draft card (K12, K13)

**Files:**
- Modify: `edit/EditLid.vue` (+ `EditLid.test.ts`), `edit/CreateBar.vue` (+ `CreateBar.test.ts`), `edit/summary.ts` (`missingLabel` → `N to fill in`), `nodes/nodes.css` (remove the `.node.draft::after` corner tags `Draft`, `Draft · planned`, `Draft · done`; keep `.node.removing::after`), `nodes/ContainerNode.vue` (title not truncated: `Machining · Turning`), e2e text in `tests/ui/specs/edit-mode*.spec.ts` that reads `things missing` or the corner tag.

**Interfaces:**
- EditLid groups (left → right): **edit tools** `undo, redo, Add, Pick samples, Tidy, Remove, Dissolve` (Remove/Dissolve act on the selected card, so they stay with the tools); **draft** `name input, Project, Campaign (scope slot), "Draft ▾" menu` where the menu holds today's My drafts list and the save status (`Draft kept` / `Saving…` / error); **create** `N to fill in` text + the `create` slot. Emits unchanged.
- `CreateBar`: when `missing > 0` the button is disabled and reads `Create`, with `N to fill in` beside it (amber); when ready the label is today's summary (`Create 1 operation, 1 sample`); empty draft unchanged.
- `ContainerNode` kind line uses ` · ` between category and method (`Machining · Turning`), not ` | `.

- [ ] **Step 1: Failing tests:** EditLid renders three `[role=group]` with the controls in that order and the save status inside the Draft menu; CreateBar with `missing:3` shows `3 to fill in` and a disabled `Create`; with `missing:0` shows the summary; `missingLabel(1) === '1 to fill in'`; ContainerNode kind line `Machining · Turning`; no `.node.draft::after` content (check nodes.css text as nodes.test.ts already does for `.removing`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; update e2e strings by reading.
- [ ] **Step 4:** `npx vitest run src/pages/map` → PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(map-edit): the draft bar in three groups with Create in a fixed place; one status mark per draft card`

### After the tasks (orchestrator)

- [ ] Simplify pass (Sonnet) over the branch diff: reuse, dead code, duplicated helpers; tests stay green.
- [ ] Opus whole-branch review; fix wave (Sonnet) for Critical/Important.
- [ ] Browser check on the preview (`explorer_preview.sh` + STARbase dev server on 5192): add Sample → Operation (auto-wired, selected, in view) → choose Turning → type cutting speed on the card → side panel shows it → amber clears → Create button state. Screenshot for the PR.
- [ ] Draft PR to `main`, CI watched through the bound PR.
