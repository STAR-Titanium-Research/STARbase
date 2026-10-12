# U1 Frequently Used Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-user "Frequently used" panel on the Explorer Home (pages & actions, records), fed by visit pings and
Directus's activity log, stored server-side per user.

**Architecture:** Migration 163 adds two `d1_private` tables. A Directus endpoint extension `d1-usage` owns all
reads and writes, scoped to `accountability.user`. The kit holds pure helpers (target keys, repeat filter, ranking).
d1-home pings from its router and renders `FrequentlyUsed.vue` on Home.

**Tech Stack:** Postgres 16 + dbmate, Directus 11 endpoint (plain ESM JS, node:test), Vue 3 + TS kit (vitest).

**Spec:** `docs/superpowers/specs/2026-10-12-explorer-frequently-used-design.md`

## Global Constraints

- Migration file: `db/migrations/20261012000163_user_usage.sql` (162 is taken by the maintainer's `ring_form`).
- Tables in schema `d1_private`, never exposed as Directus collections; `migrate:down` drops both tables.
- Weights: visit 1; create/update from `directus_activity` 3; `action:*` page targets 3. Half-life 10 days.
  Repeat visits to the same target within 10 minutes count once (client-side filter).
- Record collections (exactly seven): `physical_samples`, `manufacturing_operations`, `test_sessions`, `campaigns`,
  `projects`, `people`, `equipment`. Check the real collection names in the repo before using them; if a name differs
  (e.g. the tests collection), use the real one and note it in the report.
- Lists: 6 shown, "Show more" up to 15; pinned first, then decayed score; hidden rows left out until used again
  after `hidden_at`. Clear keeps pins.
- Suggested (no history): Samples, Log an operation, Register a sample, My samples, labelled "Suggested".
- Kit files never import `@directus/extensions-sdk` (guard test `noSdkImports.test.ts`).
- Every endpoint route: 401 without a user; only the caller's rows are read or written.

## Review Focus

1. A user's GET must never return another user's rows: test with two users in the node tests.
2. A target string from the client is untrusted: only known page keys or `<one of seven collections>:<id>` pass
   (id: uuid or positive integer as text, length-capped); anything else gets 400 and nothing is written.
3. The activity fold must be idempotent: two GETs back to back don't double-count (cursor advances in the same
   transaction as the score updates).
4. A record the user can no longer read is dropped from the panel without an error state.
5. Ping failures (offline, 500) never surface in the UI or block navigation.

---

### Task 1: Migration, endpoint, node tests (backend)

**Files:**
- Create: `db/migrations/20261012000163_user_usage.sql` (tables as in the spec's Data section,
  plus an index on `(user_id, kind)`)
- Create: `core/extensions/d1-usage/{package.json,index.js,index.test.mjs}`. Copy the package.json shape from
  `core/extensions/d1-admin-overview`.
- Modify: the schema test harness, so the migration round-trips (find how migrations 159-161 are covered in
  `tests/phase1_schema.sh` or the schema test runner, and follow it).
- Modify: the CI or extension test list, if extensions' node tests are enumerated somewhere (grep for
  `d1-admin-overview/index.test.mjs`).

**Interfaces (produces):**
- `POST /d1-usage/visit {kind:'page'|'record', target:string}` → `204`
- `GET /d1-usage` → `{ pages: Item[], records: Item[] }`, where
  `Item = { target, score, pinned, last_at }` and `score` is decayed to now; each array has at most 15 entries.
- `POST /d1-usage/pin {kind, target, pinned:boolean}` → 204, upserting the row if missing.
- `POST /d1-usage/hide {kind, target}` → 204.
- `POST /d1-usage/clear` → 204: deletes the caller's unpinned rows and resets scores of pinned rows to 0.
- Exported pure helpers for tests: `decay(score, lastAt, now)`, `validTarget(kind, target)`, `PAGE_KEYS`
  (a Set; the d1-home task adds keys to this same list, so keep it as one exported constant with a comment).

**Activity fold (GET):**
- Read the cursor. If there is none, start from `max(id)` of activity older than 30 days.
- Select at most 500 rows: `directus_activity WHERE user = $1 AND id > cursor AND action IN ('create','update') AND collection IN (seven)`,
  ordered by id.
- Upsert each as `record`, target `collection:item`, weight 3, with `last_at` = the activity timestamp.
- Advance the cursor. Do all of this in one transaction.

- [ ] Tests first (node:test with a fake knex like d1-admin-overview's tests). They cover:
  - 401;
  - validation;
  - decay at 0, 10 and 30 days;
  - visit upsert maths;
  - two-user isolation;
  - fold idempotency and the 500 cap;
  - hide then revisit unhides;
  - clear keeps pins.
- [ ] Implement, run the tests and sqlfluff (`pre-commit run --files <migration>`, or the repo's sqlfluff config),
  and run the schema round-trip test via `scripts/dev/schema_test_docker.sh` (ROUNDTRIP=1).
- [ ] Commit `feat(usage): per-user frequently-used scores (migration 163, d1-usage endpoint)`.

### Task 2: Kit helpers, pings, Home panel (frontend)

**Files:**
- Create: `packages/d1-ui/src/usage.ts` and `usage.test.ts`:
  - `pageTarget(routeName|path) → string|null`, which maps Explorer routes to page keys;
  - `recordTarget(collection, id) → string|null`;
  - `createRepeatFilter(windowMs=600000, now?)`, which returns a `shouldSend(target)` function;
  - `mergeWithSuggestions(items, suggestions, n)`, where suggestions fill the list only while it has fewer than n
    real items and are flagged `suggested: true`.

  Export them from `packages/d1-ui/src/index.ts`.
- Create: `core/extensions/d1-home/src/home/FrequentlyUsed.vue` and `home/useFrequentlyUsed.ts`.
- Modify: `core/extensions/d1-home/src/home.vue`, to place the panel under the hero beside or above the stats band.
  Keep the N1b layout calm: the panel renders as one card with the two lists side by side, stacked on narrow
  screens.
- Modify: the d1-home router setup (find where routes and `ExplorerView.vue` live), to add the visit ping:
  - send on route change;
  - fire-and-forget through the SDK's api;
  - errors swallowed;
  - the repeat filter applied.

  Quick actions ping `action:<key>` when their form opens.

**Interfaces (consumes):** Task 1's endpoint and `PAGE_KEYS`. Keys must match exactly, so copy the list from
`core/extensions/d1-usage/index.js` into the kit as `PAGE_KEYS`, and add a kit test that reads the endpoint file
as text and checks the two lists match. That way they cannot drift.

**Labels:** page keys map to labels and routes in `usage.ts`. Records are loaded per collection in one request each:
- the request is `filter[id][_in]`, using the collection's display/code field (reuse the index defs or the record
  label helpers the Explorer already has);
- a record that is missing or forbidden is dropped silently.

**UI:**
- 6 items per list, with "Show more" up to 15;
- 📌 pinned items first;
- each row gets an × and a pin toggle (aria-labels name the item);
- a panel menu with "Clear my history" behind a confirm step;
- "Suggested" tag on suggestions;
- a loading line, not an empty box;
- an endpoint failure shows one quiet line.

- [ ] Tests first for usage.ts, including the PAGE_KEYS drift test.
- [ ] Implement.
- [ ] Gates:
  - d1-ui vitest;
  - vue-tsc in d1-ui and d1-home;
  - d1-home build.
- [ ] Commit `feat(d1-home): frequently used panel on Home`.

### Task 3: Final review, preview, PR

Final review is by Opus. There is one fix round. Run the preview with `D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-usage"`,
signed in as admin and as Lab Member, and check:
- suggestions appear for a fresh user;
- visits move items up;
- pin, hide and clear all work;
- one user's list never shows another's.

Open the PR stacked on `feat/explorer-n1b`.
