# People 4 — My Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Team** filter on every record index page and a **My teams** panel on Home showing the most recently changed records across the viewer's teams.

**Architecture:** A team's work is the records it owns or has an access level on (spec decision 19). Directus cannot filter Lab Member reads through `access._some…` (a legal `_some` applies the access collection's own read rule, which is own-rows only), so the team's record ids come from a new endpoint route that already filters by the caller's readers; index pages filter `<key> _in [ids]`.

**Tech Stack:** Directus 11.17 endpoint (plain ESM, `node:test`), Vue 3 + TS (`@d1/ui` index kit, `@d1/starbase-pages`), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-people-and-teams-design.md` §1.5, decision 19. Builds on PR 3 (`feat/team-ownership`).

## Global Constraints

- Plan 2/3 Global Constraints apply (host-neutral UI, error shape, every CI suite on the final commit).
- **Ruling M1:** team filtering never leaks a record the viewer cannot read: ids come only from `GET /d1-teams/:id/records`, which intersects with the caller's `<T>_readers`.
- Filter state lives in the URL (`f.team=<id>`), like other index filters.

## Review Focus

1. A team filter on an index page shows only records the viewer can read (a hidden team record never appears, the count says nothing of hidden ones). (Task 1 test + Task 3 E2E.)
2. The My teams panel renders nothing for someone in no team. (Task 2 test.)
3. A team with > 500 records: the filter still works (ids posted in chunks or the endpoint caps with a clear "showing the latest 500" note). (Task 1 test.)

---

### Task 1: records-of-a-team route and the index Team filter

**Files:** Modify `core/extensions/d1-teams/index.js` (+tests): `GET /:id/records?collection=<c>&limit=<n≤500>` → `{ ids: [...], truncated: boolean }` — records of that collection the team owns (`owner_team_id`) or has a grant on (`<T>_team_access`), intersected with the caller's `<T>_readers` (admins: all), newest first by the record's date column; `GET /mine/recent?limit=20` → `{ items: [{ collection, id, kind, code, title, team_id, team_name, team_color, changed_at }] }` across the caller's teams (readable only). `packages/d1-ui/src/index/indexConfig.ts` / `indexQuery.ts` (+tests): new FilterDef option kind `team` — options from `listTeams`; when set, the page first calls `GET /d1-teams/:id/records?collection=` and adds `{ [key]: { _in: ids } }` (empty ids → a filter that matches nothing); "showing the latest 500 of this team's records" note when truncated; add the Team filter to the samples, operations, tests, campaigns (and projects: grants only) index definitions.

- [ ] **Step 1: failing tests** (endpoint: readers intersection, owner + grant union, truncation, admin; kit: query building with/without ids, URL round-trip). **Step 2–4.** All extension suites + `@d1/ui` + starbase-pages tests/typechecks.
- [ ] **Step 5: Commit** `feat(teams): team filter on index pages`

### Task 2: My teams panel on Home

**Files:** Create `packages/starbase-pages/src/home/MyTeams.vue`, `home/myTeams.ts` (+test); Modify `home.vue` (after MyWork; renders nothing when the viewer has no teams or no items).
- One line per record: TeamTile (sm), kind chip, code, title, "changed <relative time>"; header "My teams" with a link to `/home/people?view=teams`; at most 10 lines, "Show more" to 20.

- [ ] **Step 1: failing vitest** (`myTeams.ts` grouping/labels; empty → nothing). **Step 2–4.** **Step 5: Commit** `feat(home): my teams panel`

### Task 3: E2E and docs

**Files:** Create `tests/ui/specs/20-my-teams.spec.ts`; Modify `tests/ui/README.md`, `docs/runbooks/starbase.md` ("My teams (PR 4)": no migration; redeploy d1-teams + STARbase), spec §10 erratum (Ruling M1), `core/README.md`.
- [ ] **Step 1: spec 20** — a member filters Samples by their team (sees the team's readable samples only; a team sample they cannot read never appears); Home shows My teams; a person in no team sees no panel. Specs 13, 15, 17, 18, 19 still pass.
- [ ] **Step 2:** preview run → PASS. **Step 3: Commit** `test(ui): my teams E2E; docs`
