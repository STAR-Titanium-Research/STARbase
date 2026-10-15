# Process map — edit mode (build a process on the canvas)

**Date:** 2026-10-14 · **Status:** in progress on branch `claude/keen-brahmagupta-nmo9oy` (plan
`docs/superpowers/plans/2026-10-14-process-map-edit-mode.md`). Decided with the maintainer in a design interview
(grill-with-docs, 2026-10-14); the maintainer approved this spec without a separate review stop ("write, approve,
implement").

Builds on: `docs/superpowers/specs/2026-10-14-process-map-design.md` (the view-only map, D1–D29) and the card
tweaks of `claude/jolly-fermi-us5mb7` (stack of passes, ＋/−, Reset). Decisions recorded as
[ADR-0018](../../adr/0018-starbase-writes-records.md) (STARbase writes records) and
[ADR-0019](../../adr/0019-operations-and-tests-can-be-planned.md) (planned work).
Glossary: `CONTEXT.md` → "Building on the process map" (**card**, **container**, **socket**, **wire**, **edit
mode**, **draft**, **create**, **planned** / **done**, **planned sample**, **attach**, **new from**, **duplicate**,
**template**, **checks**, **stack of passes**).

## 1. Why

The process map shows how samples came to be, but only after someone has filled in a Data Studio form per
operation, per test and per new sample, in the right order, with the right input sample picked each time. The
maintainer wants to work the other way round, like Blender's node editor: start from a blank canvas (or an
existing history), put sample cards on it, hang operations off their sockets, wire the outputs on, and have the
records built behind the scenes. The same canvas is used to **plan** work before it is done (labels printed
before the cut) and to **record** it afterwards.

## 2. Decisions

| # | Decision |
|---|---|
| E1 | **Edit mode** is a mode of the Process map page, not a new page. Two ways in: an **Edit** toggle on any map (extend that history) and **Build a process** (sidebar, Analysis section, next to Process map), which opens `/map?edit=new` on a blank canvas. |
| E2 | Operations and tests are **planned** or **done** (ADR-0019). A planned operation's new output samples are **planned samples**, created with their final codes at Create. |
| E3 | Work is built in a **draft**, kept on the server automatically (debounced), private to its owner, named (default "<first sample code> · <date>"), several per person. **My drafts** lists them on Home and in edit mode's Open menu. A draft is deleted once it is created. |
| E4 | **Create** turns the whole draft into records in **one transaction**, all or nothing. A failure leaves the draft untouched and marks the card it came from. The button shows what it will make: "Create 2 operations, 4 samples". |
| E5 | **Checks** (the rail's Checks section, red badges on cards, the Create button's "N things missing") list what is missing. **Blocking:** what the database refuses (operation without method; operation with neither input nor output), a record re-check found gone or no longer attachable, and — for **done** records only — the fields the form marks required. **Warnings:** useful-but-optional fields (no machine, no planned date) and records changed since they were added. Planned records need only their structure (method, wiring; test type for tests). |
| E6 | **Mark done** (immediate, not a draft change; also in view mode and on phones): asks the date (default today) and who, runs the container's checks as done, sets the work state, turns its planned outputs active. Back to planned: owner (or owning team's manager) or admin only. |
| E7 | **Sample picker:** the Samples index page opens over the canvas in picker mode (its filters, search, saved views, checkboxes). Picked rows fly onto the canvas (FLIP animation from the row's rectangle to the card's place), staggered 40 ms, landing as a column; undo plays it backwards; `prefers-reduced-motion` → 150 ms fade. |
| E8 | **Socket menu:** clicking a free socket, or dragging from it into empty canvas, opens a search menu at the pointer, filtered by what fits. From a sample's output: **Templates** first, then category → method → *Attach an existing one* / *New from…* / *Blank*. From an operation's output: *New sample* / *Same sample (in-place)* / *Existing sample…*. **Shift+A** (or right-click on empty canvas) opens the same menu unconnected. |
| E9 | A container gets a **＋ output** row (cuts: one operation row per output piece, D9 of the map spec; the rows of one new container are tied by a recorded **batch**, ADR-0017). A stacked container gets **＋ pass** (a new pass with the same settings appended to the stack). |
| E10 | **Duplicate** (Shift+D, Ctrl/⌘+D, menu; "Duplicate ×N" asks a count): copies every field including Inside slots and operator. Copies of an in-place operation chain after the original as further passes (joining its stack); copies of anything else keep the same input wire and get their own open output; a duplicated sample card is a new sample with the same details. Duplicating a created record = new from. |
| E11 | **Templates** (slice 5): named, saved prefilled fields for a new operation or test; private, shared with your account role, or with everyone (the three saved-view scopes). Made with "Save as template" on any container (date, sample and notes off by default); used from the socket menu and a **Templates** shelf; edited from the shelf (never changes what was made from them); a template pointing at a depleted or retired tool/edge is greyed and warns in Checks. Templates hold operations and tests only. |
| E12 | **Undo / redo** (buttons in the map panel lid, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z) over every draft change; history lives for this visit only; Create clears it, so undo never deletes records. |
| E13 | **Stale drafts:** opening a draft and Create re-read every existing record in it. Changed since added → warning badge "Changed since you added it — review". Gone or no longer attachable (e.g. an attached operation got an input meanwhile) → blocking. Nothing is overwritten silently: edits to existing records carry the version they were made against (OCC). |
| E14 | **Edits to existing records** made in edit mode (e.g. a planned operation's feed rate) are draft changes, applied at Create with the version check. |
| E15 | **New samples inherit** (shown greyed, overridable): an operation's output sample takes material and form from the input sample and its method from the operation; the code's date is the Create date and never changes. A free new sample has nothing to inherit and gets Checks entries until filled in. |
| E16 | The draft has a **project** and an optional **campaign**, defaulting from the first sample added, drawn as the project frame, applied to every new record, overridable per card. Owner of new records = the person creating them. |
| E17 | **STARbase's own form** (ADR-0018), generated from the Directus field definitions (`/fields/<collection>`: groups, conditions, required, choices, translations, notes). Key settings are editable inline in the container; everything else in the rail. A field whose interface it cannot draw shows its value and "Open in Data Studio". Used only in edit mode in v1. |
| E18 | Planned records may be **deleted** in edit mode by their owner (a draft change, applied at Create). A planned operation's planned outputs go with it unless something done hangs off them (then refused). Done records are never deleted from the map. |
| E19 | After Create: records settle into the map (planned ghosted, done solid), edit mode closes, the first sample is focused, a toast offers **Print labels for N new samples** (`/labels?ids=…`), the draft is deleted. |
| E20 | Phones (< 768 px): no building; drafts open read-only; **Mark done** is available. |
| E21 | Keyboard: Shift+A add menu at the focused point; Enter on a focused socket opens its menu; "Connect to…" lists compatible sockets, searchable by code; Delete removes the selected draft item; Shift+D duplicates; Ctrl/⌘+Z / Ctrl/⌘+Shift+Z. No gesture needs dragging. |

## 3. Delivery

One spec, six slices, one plan; executed in this order, each usable alone:

1. **Planned work** — migration (work state, planned date, done by/at, `planned` sample status), Directus
   metadata, access-guard rule, `d1-build` **mark-done**, the map reads work state (ghosted planned
   containers and samples) and gets **Mark done** in the rail. ADR-0019.
2. **Drafts and Create** — `d1_private` draft store, `d1-build` drafts CRUD, **check** and **create**
   (transactional), the client draft model and Checks. ADR-0018.
3. **Edit mode canvas** — Edit toggle, Build a process, blank canvas, sample picker and fly-in, socket menu,
   new/blank containers, new samples, wiring, ＋ output, duplicate, undo/redo, My drafts on Home, the
   Create button and post-create toast. Fields are filled in through the framed Data Studio form until slice 4.
4. **STARbase form** — generated form in the rail, inline key settings.
5. **Attach, new from, ＋ pass, templates.**
6. **Deleting planned records** and the labels hand-off polish.

## 4. Data model

### 4.1 Planned work (slice 1) — migration `…_planned_work.sql`

| Table | Column | Type | Notes |
|---|---|---|---|
| `manufacturing_operations` | `work_state` | `text NOT NULL DEFAULT 'done'` | CHECK `work_state IN ('planned','done')` |
| | `planned_date` | `date NULL` | when it is meant to happen |
| | `done_by_person_id` | `uuid NULL → people ON DELETE SET NULL` | who marked it done |
| | `done_at` | `timestamptz NULL` | when it was marked done |
| `test_sessions` | the same four columns | | |
| `physical_samples` | `current_status` CHECK | | widened to `active, consumed, destroyed, archived, planned`; down maps `planned` → `archived` |

Directus metadata: `work_state` as a read-only `select-dropdown` (Planned / Done) placed with the date in the
"Who & where" field group; `planned_date` (datetime, date only) beside it; `done_by_person_id` and `done_at`
read-only. `current_status` choices gain **Planned**. `scripts/access_rules.json` field lists gain the new
columns where the collection lists fields explicitly. Indexes: `(work_state)` partial `WHERE work_state =
'planned'` on both tables.

`d1-access-guard` (filter hook): an update that sets `work_state` from `done` to `planned` is refused (403,
"Only the owner can set a done record back to planned") unless the caller is admin or owns the record
(`owner_person_id` → their People row; the owning-team managers when team ownership exists).

### 4.2 Draft and template store (slices 2, 5) — migration `…_build_store.sql`

Endpoint-only tables in `d1_private` (the d1-usage pattern: outside the Directus schema scan, no Directus
permissions, reached only through `d1-build`):

```sql
d1_private.process_drafts(
  draft_id uuid PK default gen_random_uuid(),
  user_id uuid NOT NULL,            -- directus_users.id of the owner
  name text NOT NULL,
  body jsonb NOT NULL,              -- DraftBody, §5.1
  created_at timestamptz NOT NULL default now(),
  updated_at timestamptz NOT NULL default now(),
  version integer NOT NULL default 1)
d1_private.process_templates(
  template_id uuid PK default gen_random_uuid(),
  user_id uuid NOT NULL,            -- creator
  scope text NOT NULL CHECK (scope IN ('private','role','global')),
  role_id uuid NULL,                -- set when scope = 'role'
  name text NOT NULL,
  collection text NOT NULL CHECK (collection IN ('manufacturing_operations','test_sessions')),
  values jsonb NOT NULL,            -- field → value, method_id / test_type included
  created_at, updated_at, version)
```

Index `(user_id, updated_at desc)` on drafts. A template is visible to its creator; `role` scope to callers
with that account role; `global` to everyone. Only the creator (or an admin) edits or deletes it.

## 5. The draft

### 5.1 Body (`DraftBody`, version 1)

Shared TypeScript types in `packages/d1-ui/src/build/types.ts` (the endpoint validates the same shape in JS):

```ts
type DraftKey = string;                       // 'n1', 'n2', … unique within the draft
interface DraftBody {
  v: 1;
  projectId: string | null;
  campaignId: string | null;
  items: DraftItem[];
  wires: DraftWire[];
  positions: Record<DraftKey, { x: number; y: number }>;
}
type DraftItem = DraftSample | DraftOperation | DraftTest;
interface DraftBase {
  key: DraftKey;
  existing?: { id: string; version: number };   // a record that already exists
  values: Record<string, unknown>;              // new record: all fields; existing: only changed fields
  remove?: true;                                // E18: delete this planned record at Create
}
interface DraftSample extends DraftBase { kind: 'sample'; }
interface DraftOperation extends DraftBase {
  kind: 'operation';
  workState: 'planned' | 'done';
  attach?: true;                                // existing record being given an input (E8 attach)
  rows: { key: DraftKey }[];                    // one per output piece (E9); in-place = one row
}
interface DraftTest extends DraftBase { kind: 'test'; workState: 'planned' | 'done'; }
interface DraftWire {
  from: { key: DraftKey; row?: number };        // a sample's output, or an operation row's output
  to: { key: DraftKey; row?: number };          // an operation row's input, a test, or a sample
}
```

Wiring meaning: sample → operation row = that row's `sample_id`; operation row → sample = that row's
`output_sample_id` (a different sample) or in-place (wire to the same sample, or no output wire: the sample
continues); sample → test = a `test_sessions_subject` row. An operation with N rows becomes N operation
records sharing method, settings and Inside slots, tied by a new `batches` row when N > 1.

### 5.2 Client model (`packages/starbase-pages/src/pages/map/edit/`)

Pure modules with unit tests, no Vue:

| Module | Does |
|---|---|
| `draft.ts` | Reducer: `apply(body, action) → body` for `addSample`, `addExistingSamples`, `addContainer` (blank / from template / new from), `attach`, `addOutputRow`, `addPass`, `wire`, `unwire`, `setValues`, `duplicate(n)`, `remove`, `move`, `setProject`, `setCampaign`, `rename`. Keys from a counter in the body. |
| `history.ts` | Undo/redo stacks of bodies (cap 200), cleared on Create. |
| `inherit.ts` | E15 inheritance: the greyed values a new output sample shows. |
| `checks.ts` | `checks(body, ctx) → Check[]` with `{ key, field?, level: 'block'|'warn', text }`; `ctx` = field defs (required flags), loaded existing records and their versions. |
| `summary.ts` | "Create 2 operations, 4 samples" and the draft's default name. |
| `toGraph.ts` | Merges a draft into the map's `ProcessData` (draft items as ghost records with `draft: true`), so the existing `buildGraph`/ELK path draws them. |

`useDraft.ts` (composable): loads/saves through `d1-build` (debounced 800 ms, OCC on `version`), exposes
`body`, `apply`, `undo`, `redo`, `checks`, `create()`.

## 6. The endpoint `d1-build` (`core/extensions/d1-build/`)

Plain ESM endpoint (`index.js`, `index.test.mjs`, `package.json`), shaped like `d1-record-access` and
`d1-teams`: `route()` wrapper with `HttpError` and Directus-shaped errors; 401 without a user. Checks run as the
caller; record writes go through `services.ItemsService` **with the caller's accountability and `knex: trx`**
so Directus permissions and hooks (`d1-owner-default`, `d1-access-guard`, `d1-campaign-inherit`, …) apply
inside the one transaction (precedent: `d1-people-admin` passing `knex: trx` to `UsersService`). Every
transaction starts with `set_config('d1.actor_identity', …, true)`. DB errors map to 409/400 with the draft
key they came from. The Directus data cache is cleared after a successful write when enabled.

| Route | Does |
|---|---|
| `GET /d1-build/drafts` | the caller's drafts (id, name, updated_at, summary) |
| `POST /d1-build/drafts` | new draft `{name?, body}` |
| `GET /d1-build/drafts/:id` | one draft (owner only, else 404) |
| `PATCH /d1-build/drafts/:id` | `{name?, body?, version}`; 409 on version mismatch |
| `DELETE /d1-build/drafts/:id` | discard |
| `POST /d1-build/drafts/:id/check` | server-side checks: re-reads existing records (versions, attachability), required-for-done from `directus_fields.required` |
| `POST /d1-build/drafts/:id/create` | §6.1; `200 {created: {key → {collection, id, code}}, sampleIds[]}`; `409 {checks}` |
| `POST /d1-build/mark-done` | `{collection, ids[], date?, personId?}` (E6): every row of a container (or every pass of a stack) in one transaction |
| `POST /d1-build/mark-planned` | `{collection, ids[]}`: back to planned, owner or admin only; clears the done date, who and when; outputs back to planned unless something done hangs off them |
| `GET/POST/PATCH/DELETE /d1-build/templates[/:id]` | E11 (slice 5) |

### 6.1 Create, in one transaction

1. Lock the draft row (`FOR UPDATE`), re-run the checks; any blocking check → 409 with the list, nothing written.
2. Removals (E18): delete planned records marked `remove` (and their planned outputs; refuse if something
   done hangs off them).
3. Existing records' edits: for each, compare `version` with the stored one (409 on mismatch), then
   `ItemsService.updateOne` with the changed fields only.
4. New samples, in key order: `createOne` with the inherited and given values; the code template
   (`{seq}-{alloy}-{method}-{Y}-{M}-{D}`, the client composes it with the shared `sampleCodeTemplate()` from
   `@d1/ui`, as `register-sample.vue` does) is numbered by the existing trigger; `current_status = 'planned'`
   when the operation that makes it is planned.
5. New `batches` rows for operations with more than one row.
6. New and attached operations in topological order of the wires (so `operation_sequence` follows the chain);
   one record per row; `work_state`, `planned_date` / `operation_date`, project, campaign.
7. New tests, with `subject: { create: [{ collection: 'physical_samples', item }] }`.
8. Delete the draft. Commit. Return the created ids and codes.

Any error rolls everything back; the response names the draft key whose write failed.

### 6.2 Mark done

In one transaction: read the record as the caller (404 if unreadable); refuse unless the caller may update it;
check the required-for-done fields (409 with the missing ones); update `work_state = 'done'`,
`operation_date`/`session_date` (given or today), `done_by_person_id` (given, else the caller's People row),
`done_at = now()`; set the operation's planned output samples to `active`.

## 7. The page

### 7.1 Edit mode

`/map?edit=<draftId>` (or `edit=new`, which creates a draft and replaces the URL). `useProcessMap` keeps
`focus` and `reach`; in edit mode the draft is merged into the loaded data (`toGraph.ts`) and drawn with a
dashed outline and a "Draft" tint. The map panel lid gains: **Done editing**, undo, redo, **Add** (Shift+A),
**Pick samples**, the draft name (rename in place), Open ▾ (My drafts), and the **Create** button (primary;
disabled with "N things missing" while blocking checks exist). The rail gains **Checks** (above Connections)
and, for a selected draft item, its form (§7.3).

### 7.2 Components (`packages/starbase-pages/src/pages/map/edit/`)

`EditLid.vue`, `AddMenu.vue` (search menu: templates, categories → methods, existing records via the map's
`Finder`), `SamplePicker.vue` (the Samples index page in picker mode — `IndexPage` gains a `pick` mode emitting
the chosen rows with their DOM rectangles), `flyIn.ts` (FLIP), `ChecksSection.vue`, `MarkDoneDialog.vue`,
`CreateToast.vue`, `useEditKeys.ts`. `ContainerNode`/`RecordNode` gain an `editing` prop: free sockets become
buttons (click → AddMenu; drag → wire preview, drop on a compatible socket → `wire`, drop on empty canvas →
AddMenu), a ＋ output row, ＋ pass on stacks, a red badge with the block count.

Home gains `home/MyDrafts.vue` (hidden when empty). The sidebar's Analysis group gains **Build a process**
(`to: '/map?edit=new'`, icon `add_circle`); `PAGE_KEYS` (d1-usage and `usage.ts`) gain it.

### 7.3 The STARbase form (slice 4)

`packages/d1-ui/src/form/`: `fieldModel.ts` (pure: Directus field defs → `FormField[]` with group, width,
label, note, required, choices, interface kind; `conditions.ts` evaluates Directus `meta.conditions` rules
(`_eq`, `_neq`, `_in`, `_nin`, `_null`, `_nnull`, `_empty`, `_nempty`, `_gt`, `_gte`, `_lt`, `_lte`,
`_and`/`_or`) against the current values to hide, make read-only or required), `FieldForm.vue` (renders
groups as `Section`s; inputs: text, textarea, number with suffix, select/radio from choices, toggle,
date/datetime, M2O as a record picker using the Finder search on the related collection, people picker;
anything else → value + "Open in Data Studio"). Until slice 4, the rail's **Edit fields** opens the framed
Data Studio form (`host.openEditor`) for existing records only; new draft items are filled through the key
settings inline and the Checks list.

## 8. Error handling

- Draft save conflict (409, another tab): reload the draft and say "This draft changed in another tab;
  reloaded"; local undo history is dropped.
- Create 409: Checks section opens, each card with its message. Network error: the draft is already kept; the
  Create button returns to its state with "Could not reach the server; nothing was created".
- `d1-build` missing (STARbase deployed before d1-server): Edit and Build a process are hidden (the GET
  `/d1-build/drafts` probe 404s).
- Fields missing (migration not applied): the map does not request `work_state` unless `/fields` lists it
  (the `batch_id` pattern), and draws everything done.

## 9. Testing

- **Unit** (vitest): `draft.ts` (every action, duplicate ×N chaining passes, remove), `history.ts`,
  `inherit.ts`, `checks.ts` (planned vs done required, stale versions, attachability), `summary.ts`,
  `toGraph.ts` (draft items drawn, wires into rows, cut rows), `fieldModel.ts` and `conditions.ts`, `flyIn.ts`
  (rectangle maths), sample picker selection.
- **Endpoint** (`node --test core/extensions/d1-build/index.test.mjs`, fake knex + fake ItemsService):
  ownership of drafts, OCC, create ordering (samples before operations, batches for multi-row operations,
  topological order), rollback on a failing write, mark-done (outputs active, required fields), templates
  scopes.
- **SQL** (`tests/phase1_schema.sh`): defaults, CHECKs, `planned` status, the `d1_private` tables, up/down/up.
- **Live** (physical test backlog, section A): build and create a cut with 4 planned outputs as a lab member,
  print their labels, mark the cut done, check the codes and the genealogy rows; Create rollback when one
  record is refused; back-to-planned refused for a non-owner.

## 10. Out of scope

Multi-step templates (a chain of containers); sharing drafts; editing done records' wiring or deleting done
records from the map; junctions, stock lots and recorded batches drawn by hand; STARbase's form on the record
pages; building on phones.
