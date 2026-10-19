# Process map edit mode redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make edit mode usable on live: remove nodes and wires, derived sockets, collision-free layout, a palette plus add search, insert before a sample, attach from the database, templates; and fix what the end-to-end audit found.

**Spec:** `docs/superpowers/specs/2026-10-18-process-map-edit-mode-redesign.md` (R1–R12, plain fixes 1–13). Builds on `docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md` and its plan (parts 1–4 merged).

## Status

| Slice | Worktree | Branch | State |
|---|---|---|---|
| 0 — harness: local Postgres + Directus + STARbase, Playwright suite for edit mode | agent worktree | `pm-redesign/0-harness` | built, **merged** into the working branch (2026-10-19) |
| 1a — correctness, server: R10, R11, `test_category`/`material_id` (`d1-build`) | agent worktree | `pm-redesign/1a-server` | built, reviewed, merged into the working branch (2026-10-19) |
| 1b — correctness, client: remove, derived sockets, layout, plain fixes (needs 0 for its browser check) | agent worktree | `pm-redesign/1b-canvas` (+ `1c-verify`: browser specs and the fixes they and the Opus review found) | built, reviewed, merged into the working branch; slice 1 PR up (2026-10-19) |
| 2 — adding: palette, add search, drops, insert before, planned/done toggle, project/campaign | agent worktree | `pm-redesign/2-adding` | not started (needs 1) |
| 3 — attach from the database: scoped to existing operations with no input sample (decided 2026-10-19) | agent worktree | `pm-redesign/3-attach` | not started |
| 4 — templates | agent worktree | `pm-redesign/4-templates` | in progress (2026-10-19) |

## Global constraints

- Commit trailer lines (every commit):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01L4oygaTHCgUFwVogx8zpQt
  ```
- Verification is **real**: every slice is driven in a real browser against the slice-0 stack (real Directus, real
  Postgres, the repo's extensions). A fake server (`edit/fakeBuildServer.ts`) is fine for unit tests, not for "it works".
  If something cannot be run here (live data, rig), it goes in `docs/runbooks/physical-test-backlog.md` unticked.
- STARbase pages talk to the API only through `useExplorerHost().api`; UI words follow `CONTEXT.md`.
- Never rewrite a done record's lineage from the map (R3). Never delete a done record from the map (ADR-0019 §6).
- One PR per slice; fold plan/status edits into the next code push (CI minutes).
- Implementation workers run on Sonnet at high effort, at most three at a time; Opus reviews.

---

## Slice 0 — harness

**Files:** `scripts/dev/local-stack.sh` (or `.mjs`) and `tests/ui/specs/edit-mode.spec.ts` (+ fixtures).

- [ ] Start Postgres 16 locally (no Docker: `pg_ctlcluster`/`initdb`), apply `db/migrations` with dbmate, seed a small family (a sample, an operation, a test, people with a researcher row, roles Lab Member and Lab Viewer).
- [ ] Run Directus 11 from npm with `core/extensions` mounted and the access rules applied (`scripts/access_rules.json`); STARbase dev server pointed at it.
- [ ] Record what could not run (e.g. pgvector) and its workaround in the script's header.
- [ ] A Playwright spec that opens `/map?edit=new`, picks a sample, adds an operation, wires, Creates, and reads the records back through the API. Green on `main` before slice 1 starts (it will expose the audit's bugs 1–3 first; keep those as expected-failing until slice 1).

## Slice 1 — correctness

- [ ] Plain fixes 1, 2, 3, 4, 5, 6, 13 (spec §3) — each with a failing test first, then verified in the browser.
- [ ] `d1-build`: R10 (system-rights output flip after the operation update), R11 (403 for accounts that may not create operations; Create refuses with no researcher People row; `useMyDrafts` hides edit mode on 403), fixes 7–8 (`test_category`, `material_id`).
- [ ] R4: Delete/X on a selected node or wire; dragging a wire off its socket; Ctrl/⌘+Delete dissolve; planned existing records struck through and sent as `deleteRecord` at Create; done records locked with the reason; undo/redo covers all of it.
- [ ] R5: derived sockets (a used socket per wire plus one free one; spares vanish); remove the stored ＋ output/＋ pass rows as the way in.
- [ ] R6: collision-free placement near the anchor; dragged positions kept; **Tidy** button.
- [ ] Migrations: none expected. Backlog items for what only live can confirm.

## Slice 2 — adding

- [ ] R1: the palette (left dock, drag source) and add search (Shift+A / Ctrl/⌘+K) over one catalog; replace the nested Add menu.
- [ ] R2: drop onto empty canvas, socket and wire; click on a free socket opens the filtered add search; "Insert before/after" without dragging.
- [x] R3: built as a refusal: Insert before a recorded sample says why; no 'earlier step' (maintainer, 2026-10-19).
- [ ] R9: Planned / Done toggle per new operation or test, date for done, Create writes done.
- [ ] R12: project/campaign chooser in the top bar.
- [ ] Plain fixes 9–12.

## Slice 3 — attach from the database

Scoped by the maintainer on 2026-10-19 to **recorded operations that have no input sample** (planned or done); built on `pm-redesign/3-attach` (spec 2.2).

- [x] "From database…" action row in the palette, the add search (unconnected and from a sample's output) and as a drag source onto a sample's output; the picker (`AttachPicker.vue`) lists operations with `sample_id` null as the signed-in user (search by pass code, method, the sample it made; paged), greyed with the reason when it cannot attach (on the canvas, already attached in this draft, done work on a planned sample, would run in a circle).
- [x] A pick re-reads the operation (version), refuses one that got an input or is gone, else dispatches the draft's `attach` at the sample's output. Create re-checks (GONE, STALE_VERSION, NOT_ATTACHABLE are blocking checks, nothing written); the summary reads "Attach 1 operation". The sample the operation made is drawn from the database, never made again.
- [x] `d1-build`: done work on a planned sample is blocked for an attached operation too (judged by the record's own work state); nothing can be wired out of an attached operation.
- [x] Not built, on purpose: tests onto a sample, a sample as an operation's output, merging another process tree.
- [x] Browser spec `edit-mode-slice3.spec.ts` (11 tests, real stack): attach planned and done, Create read back through REST (only `sample_id`, the version and the database-derived code move; lineage as the trigger writes it; no sample made; draft gone), undo/redo, wire removal, greyed rows, input-meanwhile / changed / gone block Create with nothing written, the palette path and a drop, a second member who cannot see another member's operation, and an investigator who can read but not change one (refused at Create, visibly). Backlog items PM10-*.

## Slice 4 — templates

- [ ] Client for `/d1-build/templates` (list, create, edit, delete), "Save as template" on a container, Templates group first in the palette and add search, scope handling (private / role / everyone), greyed when a tool or edge is depleted.

## Review focus

1. Removing a wire or node never leaves the draft in a state the server refuses at Create without a visible check.
2. A done record can never be removed, dissolved, re-parented or deleted from any gesture or key.
3. Derived sockets: nothing about sockets is stored; save/reload reproduces the same canvas.
4. Layout: no two nodes overlap after any add, insert, duplicate or undo; dragged positions survive reload.
