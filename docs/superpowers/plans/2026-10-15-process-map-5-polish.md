# Process map — polish round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last spec gaps of the Process map after PRs #281 and #291: a "some records hidden" marker on fans that skip unreadable samples (D21), recent records as quick picks in the empty state (§8), an "Open its process map" action for slot records in the rail (§8), and E2E spec housekeeping.

**Architecture:** Small additions to existing modules in `packages/starbase-pages/src/pages/map/` (model/loadFans.ts, model/fans.ts, buildGraph.ts, MapRail.vue, ProcessMapPage.vue) and `tests/ui/specs/`. No schema change.

**Tech Stack:** Vue 3.5, TypeScript, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-process-map-design.md` (D20, D21, §6.5, §8).

## Global Constraints

- Worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\process-map`, branch `feat/process-map-polish` (off main e86675d0). Never `git stash`. Only the `d1-starbase-map` preview (port 18059, vite 5192); never live or other sessions' containers.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `py -m pre_commit run --files <changed>` before each commit; push after each task; a one-line progress note to `.superpowers/sdd/2026-10-15-process-map-5-polish/progress.md` after each step.
- UI words per the glossary ("Process map", "some records hidden").

## Review Focus

1. A campaign or stock-lot fan where some junction rows point at unreadable samples → the fan root shows the "some records hidden" marker; a fan where all rows are readable shows none.
2. The empty state with no usage history (new person) → no empty list box; just the Find button.
3. "Open its process map" on a slot whose collection the map cannot focus (people, files) → not offered.

---

### Task 1: Spec housekeeping and the rail's "Open its process map"

**Files:** `git mv tests/ui/specs/19-process-map.spec.ts tests/ui/specs/21-process-map.spec.ts` (+ references in tests/ui/README.md and docs/superpowers/plans/*.md, docs/wiki); spec's credentials check regex `/preview-credentials(-.+)?\.txt$/` (accept the default-named preview); `pages/map/MapRail.vue` (+ test).

- [ ] **Step 1: Failing test:** the rail for a selected slot record whose collection has a focus plan (`focusPlan` in model/collections.ts / fans.ts) shows an "Open its process map" action linking to `mapPath(collection, id)`; none for people/files/unknown; none when the record already is the focus.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (AppLink with `mapPath`). **Step 4:** PASS + suites + typecheck; `npx playwright test --list` in tests/ui shows spec 21.
- [ ] **Step 5:** Commit `chore(map): spec 21, default preview creds; rail opens a slot record's own map`, push.

### Task 2: "Some records hidden" on fans that skip unreadable samples (D21)

**Files:** `model/loadFans.ts` (campaign and stock-lot branches: a junction/provenance row whose sample comes back null or unreadable sets `hidden: true` on the page), `model/fans.ts` (carry `hidden` per fan, OR across pages), `model/buildGraph.ts` (a HiddenMarker on the fan root node when its fan is hidden), tests.

- [ ] **Step 1: Failing tests:** campaign page with 3 junction rows, 1 null sample → `hidden: true`, root gets the marker; all readable → no marker; stock lot likewise; flag survives "More" paging (OR).
- [ ] **Step 2:** FAIL. **Step 3:** Implement (no count anywhere). **Step 4:** PASS + suites. **Step 5:** Commit `feat(map): some records hidden on fans that skip unreadable samples (D21)`, push.

### Task 3: Recent records as quick picks in the empty state (§8)

**Files:** `pages/map/ProcessMapPage.vue` empty state, a small `pages/map/useRecentRecords.ts` reading the person's frequently used / recent records through the existing usage API (`packages/d1-ui/src/usage.ts` and how Home's "Frequently used" panel loads them — reuse, do not add an endpoint), filtered to collections the map can focus; tests.

- [ ] **Step 1: Failing tests:** given usage rows (records of mixed collections), the quick picks are only focusable collections, at most 8, newest first; each links to `mapPath(collection, id)`; empty or refused usage → no list (Review Focus 2).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + suites + typecheck + `npm run build -w starbase-web`.
- [ ] **Step 5:** Run specs 13 + 21 on the preview (`D1_PREVIEW_NAME=d1-starbase-map D1_PREVIEW_PORT=18059`, env `.superpowers/preview-ports-5192.env`, vite 5192) `--retries=0`; stop the preview. **Step 6:** Commit `feat(map): recent records to map from the empty state`, push; CI green.
