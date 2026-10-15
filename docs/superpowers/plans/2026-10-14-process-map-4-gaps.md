# Process map — follow-up (known gaps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the known gaps left in PR #281: dragged cards snapping back, record counts behind "+N more" (D21), oversized modules and duplicated collection↔kind maps, and the Lab Member E2E scenarios that skip.

**Architecture:** No new features. Behaviour fixes in `useMapCanvas`/`useProcessMap`/`fans`, a refactor that splits `useProcessMap.ts` and `loadFamily.ts` along existing seams, one shared `collections.ts` for collection ↔ kind ↔ words ↔ record route, and a spec-19 setup that gives the preview's member a readable family.

**Tech Stack:** Vue 3.5, TypeScript, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-process-map-design.md` (D18 drag, D21 hidden records, D22 limits); slice-1 ledger "Known gaps" in PR #281.

## Global Constraints

- Worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\process-map`, branch `feat/process-map-gaps` (off main after PR #281 merged). Never `git stash`. Never touch containers other than the `d1-starbase-map` preview.
- No behaviour change in the refactor task (Task 3): all existing tests pass unchanged except import paths.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `py -m pre_commit run --files <changed>` before each commit; push after each task.
- Write a one-line progress note to `.superpowers/sdd/2026-10-14-process-map-4-gaps/progress.md` at the end of each step so a resumed session knows where it got to.

## Review Focus

1. A card dragged, then a Show chip toggled → the card stays where it was dragged (only Re-layout resets).
2. A campaign or stock-lot fan where some samples are unreadable → the stub says "More" (or "+N more" counting only readable rows), never a number that includes hidden records.
3. The refactor must not change any public export used by other files (grep importers).
4. The member E2E setup must not leave data behind on the preview copy (clean up in `finally`).

---

### Task 1: Dragged cards stay put on Show / Reach / "more" changes

**Files:** `packages/starbase-pages/src/pages/map/useMapCanvas.ts`, `model/placeMerged.ts` (reuse), tests in `useMapCanvas.test.ts`.

- [ ] **Step 1: Failing tests:** `a dragged card keeps its position when a Show chip hides another kind`; `… when Reach changes`; `… when "+N more from the form" opens`; `Re-layout still resets every card`; new cards that appear on a Reach increase are placed without overlapping dragged ones.
- [ ] **Step 2:** FAIL. **Step 3:** Implement: treat every shown-set change like an expand (keep placed nodes, place only new ones via `placeMerged`); remember user-dragged ids (Vue Flow `onNodeDragStop`) so they are never moved except by Re-layout; removed nodes just disappear. **Step 4:** PASS + suites + typecheck. **Step 5:** Commit `fix(map): dragged cards stay put on show and reach changes`, push.

### Task 2: No hidden-record counts in "+N more" (D21)

**Files:** `model/fans.ts`, `model/loadFamily.ts` (`loadUsedIn` campaign and stock-lot branches), tests.

- [ ] **Step 1: Failing tests:** campaign fan where the junction `filter_count` exceeds the readable samples → the stub shows "More" without a number; tool/equipment fans (counts from the operations collection itself, which already respects permissions) keep "+N more"; stock-lot fan likewise "More".
- [ ] **Step 2:** FAIL. **Step 3:** Implement: `UsedIn.total` becomes `number | null` where the count comes from a junction or provenance table whose rows are not permission-filtered by the target; the stub label is "More" when null; paging continues until a page returns fewer than the limit. **Step 4:** PASS + suites. **Step 5:** Commit `fix(map): no hidden-record counts behind More (D21)`, push.

### Task 3: Split the big modules; one collections table

**Files:** create `pages/map/model/collections.ts` (collection ↔ kind ↔ label ↔ record-page route ↔ focus plan), `pages/map/useMapExpand.ts`, `pages/map/useMapHover.ts`, `pages/map/model/loadFans.ts` (`loadUsedIn`, `loadRecordRef`, `loadStepRow`); modify `useProcessMap.ts`, `loadFamily.ts`, `buildGraph.ts`, `fans.ts`, `connections.ts`, `recordInfo.ts`, `MapRail.vue`, `nodes/kinds.ts` to use them.

- [ ] **Step 1:** Grep every importer of the moved symbols; record them in the progress note.
- [ ] **Step 2:** Move code (no behaviour change); replace the five duplicated collection↔kind maps with `collections.ts`; add `collections.test.ts` (every collection maps to a kind and back; record-page routes match `recordRoute`).
- [ ] **Step 3:** All suites + typecheck pass with only import-path edits in tests. `useProcessMap.ts` < 500 lines, `loadFamily.ts` < 450 lines (report the counts).
- [ ] **Step 4:** Commit `refactor(map): split useProcessMap and loadFamily; one collections table`, push.

### Task 4: Member E2E scenarios run

**Files:** `tests/ui/specs/21-process-map.spec.ts`, maybe `tests/ui/starbase/target.ts`.

- [ ] **Step 1:** In spec 19's member setup, through `adminApi` on the preview copy: pick a sample with operations and make it readable to the preview member the way the record-access rules allow (owner or reader — read ADR-0014 / migration 166 for the supported way, e.g. add the member to the sample's readers or set `owner_person_id` to the member's person); restore it in `finally`.
- [ ] **Step 2:** Run specs 13 + 19 on the preview (`D1_PREVIEW_NAME=d1-starbase-map D1_PREVIEW_PORT=18059`, vite 5192) `--retries=0` → 0 skipped for the member map scenarios, 0 failed. Stop the preview.
- [ ] **Step 3:** Commit `test(map): member map scenarios get a readable family on the preview`, push.
