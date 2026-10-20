# Process map — edit mode redesign (a node editor you can actually build in)

**Date:** 2026-10-18 · **Status:** decided, not built. Decided with the maintainer in a second design interview
(grill-with-docs, 2026-10-18), after the first version of edit mode was used on the live server and an end-to-end
audit of `main` (812af754).

Amends [the edit mode spec](./2026-10-14-process-map-edit-mode-design.md). Where a decision below conflicts with
an E-row there, this document wins; rows not mentioned stand. Amends [ADR-0018](../../adr/0018-starbase-writes-records.md)
and [ADR-0019](../../adr/0019-operations-and-tests-can-be-planned.md) (see their "Amendments"). Glossary: `CONTEXT.md`
→ **palette**, **add search**, **remove / delete / dissolve**, **socket**, **attach**, **template**.

## 1. Why

Edit mode shipped with the server and form working and the canvas half-built. On live it could add things but not
take them away, no wire or spare socket could be removed, adding an operation took a nested menu, there was no way
to put an operation *before* a sample, new nodes landed on top of existing ones, templates and attaching a record
that was not already on the canvas were not there, and some paths dead-ended on fake ids. The maintainer's verdict:
the Add menu's shape was wrong. The interaction is redesigned around a **palette to drag from**, **one search for
the keyboard**, and **removal that works**.

## 2. Decisions

| # | Decision |
|---|---|
| R1 | **Two ways to add, one catalog.** A side **palette** (grouped by process category, with a search box and a Templates group first) is dragged from. **Add search** (Shift+A or Ctrl/⌘+K) opens at the pointer and takes typing. Both list the same things: sample, operation by method, test by type, template, and "From database…". Replaces E8's nested category → method → blank/attach/new-from menu. |
| R2 | **Where a drop lands.** Empty canvas: a floating node. A socket: connected there. An existing **wire**: inserted between its two ends. Clicking a free socket opens the add search filtered to what can legally connect. Selecting a card and choosing "Insert before" / "Insert after" does the same without dragging (E21's no-drag rule stands). |
| R3 | **Before a sample.** Allowed for **new** samples only. "Insert before" on a sample that already exists as a record (done, or planned and saved) is **refused**, with the reason "Its history is recorded and can't change from the map. Start from a new sample instead." A recorded sample's parentage is never changed from the map. *Decided by the maintainer ("as recommended", option C):* the earlier plan, an "Add an earlier step" action on a done sample, is **removed**. As first built in slice 2a it made a chain of three new items (a new planned sample, an operation with no method yet, the sample it makes) that nothing connected to the done sample, so it was not an earlier step and misled. To record a missing earlier step, ask an admin to fix the lineage. |
| R4 | **Removal.** Delete or X removes the selected node or wire. New and planned items can be removed; a planned record that already exists is shown struck through as "will be deleted" and deleted at Create (E18, ADR-0019 §6). A done record shows a lock and the reason and cannot be removed. Dragging a wire off its socket removes it, with the same rule. **Dissolve** (Ctrl/⌘+Delete) removes a container and wires its input to its output. Undo covers all of it. |
| R5 | **Sockets are derived.** A card or container shows a socket for each wire it has plus one free one. A spare that nothing uses disappears when the next one is connected or the selection leaves it. Nothing about sockets is stored in the draft. Replaces the ＋ output / ＋ pass rows as the way to add them (E9): connecting to the free socket does it. |
| R6 | **Layout.** A new node is placed in the nearest free slot beside what it was attached to and never overlaps another node. Positions the person dragged are kept and never re-flowed. **Tidy** is an explicit, undoable button that re-lays out the draft's own items. Replaces automatic re-layout on every change. |
| R7 | **Templates.** A template is an operation or test method plus its filled-in fields (machine, tool, operator, settings, notes), never sample links or dates. "Save as template" on any container (private, account role or everyone, E11's scopes). Templates appear in the palette and add search like any other item and drop in as a prefilled container the person can edit. No built-in starter set; templates are made by people. Duplicate ×N (E10) stays for the same operation on many samples. **Built in slice 4** (§2.2). |
| R8 | **Attach from the database.** "From database…" (palette, add search, or a socket's menu) searches every record that can legally attach where it is opened: operations that take the sample as input, tests run on it, samples as an operation's output. Joining a record from another process joins the two processes on the map and asks one-line confirmation. A record already attached on that socket is greyed with the reason. Replaces E8's canvas-only "Existing…". |
| R9 | **Planned or done at Create.** Each new operation or test has a Planned / Done toggle. Done asks for the date (default today) and Create writes it done in one step, outputs active (ADR-0019 amendment). |
| R10 | **Mark done by whoever may edit the operation** (ADR-0019 amendment): the status flip of its output samples uses system rights after the operation update succeeds. |
| R11 | **Who may build.** `d1-build` answers 403 to an account that may not create operations, and the page hides edit mode for it. Create refuses with a clear message when the caller has no researcher People row (ADR-0018 amendment). |
| R12 | **Project and campaign** are chosen in the draft's top bar: pre-filled from the first sample, editable, the campaign limited to the chosen project (E16 made reachable). |

### 2.1 Details as built in slice 2a (R1, R2, R3)

- **One catalog.** New sample, Existing sample… (opens the sample picker; the lid's Pick samples stays), an operation per manufacturing method
  by process category, a test per test type. Templates (slice 4) and "From database…" (slice 3) are not in it yet. Both surfaces are one flat
  list: no category → method → blank menu. Opened at a socket the add search lists what can legally connect there (the old fit rules of
  `menuModel.ts`), ends with **Connect to…** and **Existing sample…** where that applies, and what is chosen is connected.
- **Recents.** The last six things added (a method, a test type, a new sample), per person, in `localStorage`; first in the add search and the
  palette while nothing is typed, and ahead of equals while typing. The palette's folded state is per person too.
- **Keys.** Shift+A and Ctrl/⌘+K open the add search at the pointer (at the focused card for a person on the keyboard); Ctrl/⌘+K is taken in
  the capture phase so the shell's Finder does not also open, and passes on while typing in a field or with a dialog open. **I** and **Shift+I**
  insert after / before the selected card; the card's right-click menu has the same (**Insert before…** is shown disabled, with the reason as its title, on a sample that is already a record: see below).
  Enter on a palette entry adds it next to the selected card, else at the middle of the canvas.
- **Drops.** Empty canvas: a floating card at the pointer. A socket: connected, if it fits (`addDrop.ts` runs the same actions on a copy and
  refuses with the draft's reason). A wire: the card goes between the ends. A test cannot (no output); a new sample goes only between two
  operations; wires of records that are done or saved are refused with the lock reason. One undo step each.
- **Insert before / after** (no dragging): on the card's one input / output wire when it has exactly one; a sample nothing makes gets an
  operation that makes it with a new input sample; "after" a sample or a container with nothing leaving it adds the operation fed by it (a
  branch).
- **No "earlier step" (R3, as built now).** "Insert before" on a sample that already exists as a record (done, or planned and saved) is refused
  up front, before anything opens: no add search, no change to the draft, no undo step. The reason is one constant (`BEFORE_RECORDED` in
  `insertModel.ts`): "Its history is recorded and can't change from the map. Start from a new sample instead." It is said where the canvas says
  its problems for I / Shift+I, and is the title of the disabled **Insert before…** item in the right-click menu. Why: a done sample's parentage
  can't be changed from the map (the draft cannot give a recorded sample a maker and d1-build writes no lineage rows), and the "Add an earlier
  step" action that was built first drew a chain that nothing joined to the sample. To record a missing earlier step, ask an admin to fix the
  lineage. "Insert before" on a **new** sample works as before, and "Insert after" and a drop on a done sample are unchanged (branching;
  a wire of done records is refused with the lock reason).

### 2.2 Details as built in slice 4 (R7)

- **What a template holds: an allow-list.** Only the SETUP of the work: the method (or test type) and its process category, the machine, tool,
  cutting edge and operator, and the process settings of the form's settings groups (cutting, tooling, heat treatment, deformation, additive,
  the FAST machine settings, and a test type's `*_params`). It is decided from the field definitions the generated form already loads
  (`meta.group`, read-only, interface: `templateFields.ts`), so a settings field added to a group tomorrow is kept and a result field is not.
  Never kept: results and QA readings (any `*_results` group), a test's `status`, the dates, codes and `notes`, the sample links, the legacy and
  imported-run columns (`sintering_run_number`, which is unique with its machine, `source_*`, recipes, `recorded_metadata`), files and their
  paths, the owner (every owner column, the legacy `owner` too), test code columns, the project and campaign (the draft's top bar chooses
  those), and any link to another record that is not one of the setup references. A deny-list of the known bad columns backs the allow-list,
  and only real columns travel (a many-to-many such as additional operators is not in a template). The notes (an operation's `outcome_notes`,
  a test's `notes`) are kept only when the person ticks "Keep the notes too". The same clean-up runs again when a template is used, so a
  template made before a column changed cannot put a stale field into a draft. An operation needs its method and a test its type before it
  can be saved. `newFromValues` (new from, duplicate) also drops the run identity, owner, files, test status and test code columns.
- **Restricted records.** A restricted record (ADR-0011) can only be saved as **Only me**: the dialog offers no other scope and says why, and
  Replace will not put a restricted card into a template others can see.
- **Making one.** **Save as template** on any container: the rail's Template section (shown for every selected operation or test, new or
  recorded) and the card's right-click menu. The dialog asks for a name (started with the method or test type) and who can use it: **Only me**,
  **My account role**, **Everyone** (the three saved-view scopes: `private`, `role` with the maker's own role, `global`), and lists what it
  keeps. The palette opens and says it saved.
- **Using one.** A **Templates** group is the first of the palette (above the recents, the samples and the categories) and of the add search,
  found by name, method or "template"; a template is the same choice as the method or test it is made of, so every rule about where it fits
  (empty canvas, free socket, wire, Insert before / after, Enter on its entry) applies unchanged. What is made is a plain new container with
  the template's values, editable, and keeps nothing of the template: changing or deleting the template never changes it.
- **Managing.** The ⋯ on a template the person made (or any, for an administrator) opens, inside the palette: rename, who can use it, **Replace
  with the selected card's settings** (an operation card for an operation template, a test for a test; asks once more), delete (asks once
  more). Each says what it did or why not in plain words; a stale version (409) reloads the list and says to try again; 403 says only the
  maker or an administrator can change it.
- **Retired and used-up gear.** A template that names a machine or tool with `is_active` false, or a cutting edge with `is_used` true, is
  greyed with the reason under it in the palette and the add search (it can still be chosen), and any new card that names such gear (from a
  template or typed) has the same warning in Checks. A warning only: Create is not blocked. Reading the state is best effort: gear the person
  may not read is not warned about, and a read that failed is not repeated until another draft is opened. A template whose method or test type
  is no longer in the lists is greyed with that reason and cannot be added (it can still be deleted).
- **Not there.** The empty "Templates" placeholder of the old Add menu stays gone: no templates, no group. A Lab Viewer, who may not build,
  gets 403 from `/d1-build/templates` and sees no edit mode.

## 3. Plain fixes found by the audit (no decision needed)

1. The Create toast counts distinct created records, not map keys ("Created 2", not "3").
2. A draft card has no "Open record", "Process map of…", ＋ or Expand: its id is not a record. Hide them for `draft:` ids.
3. Create is disabled when the draft makes nothing (only picked existing samples).
4. A new sample no operation makes can be Created: `current_status` (required on live, never shown) is skipped by the
   client's required check the way the server skips reserved fields. Confirm against live's `directus_fields`.
5. Stacks and probable batches split on work state, so a planned pass stacked with done passes still offers Mark done.
6. Duplicate drops owner fields so a copy of a team-owned sample is not refused at Create.
7. `d1-build` fills `test_category` and the material inherited by operations (ADR-0018 amendment).
8. Used-in fans and step rows read `work_state`.
9. A new draft shows in Open ▾ at once; starting a build while an empty draft is open reuses it.
10. Undo does not merge edits to different fields of one card.
11. A blank canvas shows what to do first and hides Clear / Reset / Find.
12. "Open in Data Studio" on a new item's field says it opens after Create instead of showing a banner.
13. Back to planned has its button (owner rules unchanged).

## 4. Delivery

Four slices, each its own PR, each verified in a real browser against a **real local stack** (Postgres 16 with the
migrations, Directus 11 with the repo's extensions, STARbase) before it is called fixed, then a short checklist in
the physical test backlog for what only live can confirm. A change is not "fixed" because its unit tests pass; the
first edit mode shipped that way.

0. **Harness.** A script that brings the local stack up and a Playwright suite that drives edit mode against it.
1. **Correctness:** R4 removal, R5 derived sockets, R6 layout, R10 and R11 and the `d1-build` side of plain fixes 7–8, plain fixes 1–6 and 13.
2. **Adding:** R1 palette and add search, R2 drops and insert, R3, R9, R12, plain fixes 9–12.
3. **Attach from the database:** R8.
4. **Templates:** R7.

## 5. Out of scope

Rewriting a done record's lineage from the map; built-in template lists; the phone build experience (E20 stands).
