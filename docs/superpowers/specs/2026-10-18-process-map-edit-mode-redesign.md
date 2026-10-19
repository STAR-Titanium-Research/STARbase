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
| R3 | **Before a sample.** Allowed for new and planned samples. A done sample is never given a new parent: "Add an earlier step" creates a new planned upstream sample with the operation between it and a new link; the done record's lineage is not rewritten from the map. |
| R4 | **Removal.** Delete or X removes the selected node or wire. New and planned items can be removed; a planned record that already exists is shown struck through as "will be deleted" and deleted at Create (E18, ADR-0019 §6). A done record shows a lock and the reason and cannot be removed. Dragging a wire off its socket removes it, with the same rule. **Dissolve** (Ctrl/⌘+Delete) removes a container and wires its input to its output. Undo covers all of it. |
| R5 | **Sockets are derived.** A card or container shows a socket for each wire it has plus one free one. A spare that nothing uses disappears when the next one is connected or the selection leaves it. Nothing about sockets is stored in the draft. Replaces the ＋ output / ＋ pass rows as the way to add them (E9): connecting to the free socket does it. |
| R6 | **Layout.** A new node is placed in the nearest free slot beside what it was attached to and never overlaps another node. Positions the person dragged are kept and never re-flowed. **Tidy** is an explicit, undoable button that re-lays out the draft's own items. Replaces automatic re-layout on every change. |
| R7 | **Templates.** A template is an operation or test method plus its filled-in fields (machine, tool, operator, settings, notes), never sample links or dates. "Save as template" on any container (private, account role or everyone, E11's scopes). Templates appear in the palette and add search like any other item and drop in as a prefilled container the person can edit. No built-in starter set; templates are made by people. Duplicate ×N (E10) stays for the same operation on many samples. |
| R8 | **Attach from the database.** "From database…" (palette, add search, or a socket's menu) searches every record that can legally attach where it is opened: operations that take the sample as input, tests run on it, samples as an operation's output. Joining a record from another process joins the two processes on the map and asks one-line confirmation. A record already attached on that socket is greyed with the reason. Replaces E8's canvas-only "Existing…". |
| R9 | **Planned or done at Create.** Each new operation or test has a Planned / Done toggle. Done asks for the date (default today) and Create writes it done in one step, outputs active (ADR-0019 amendment). |
| R10 | **Mark done by whoever may edit the operation** (ADR-0019 amendment): the status flip of its output samples uses system rights after the operation update succeeds. |
| R11 | **Who may build.** `d1-build` answers 403 to an account that may not create operations, and the page hides edit mode for it. Create refuses with a clear message when the caller has no researcher People row (ADR-0018 amendment). |
| R12 | **Project and campaign** are chosen in the draft's top bar: pre-filled from the first sample, editable, the campaign limited to the chosen project (E16 made reachable). |

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
