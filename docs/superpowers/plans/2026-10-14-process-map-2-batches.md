# Process map — slice 2 (recorded batches) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record batches in the database (a `batches` table and `batch_id` on operations and tests), let the Data Studio form set them, group the Process map's containers on them, and relabel the FAST "Batch #" field as **Powder batch**.

**Architecture:** One dbmate migration in the house pattern (`20261012000164_label_templates.sql`): table + OCC/audit triggers + Directus collection/field/relation rows + Lab Member permissions mirrored in `scripts/access_rules.json`. The map reads `batch_id` only when the runtime field definitions list it, so STARbase keeps working before the migration is applied. `groupBatches` already groups on `batchId` (slice 1).

**Tech Stack:** PostgreSQL 16 + dbmate, Directus 11 metadata, TypeScript/vitest, Playwright, bash preview script.

**Spec:** `docs/superpowers/specs/2026-10-14-process-map-design.md` §9, D14, D27, D28; glossary `CONTEXT.md` (**batch**, **probable batch**, **powder batch**).

## Global Constraints

- Worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\process-map`, branch `feat/process-map`.
- Migration file number: re-scan every origin branch immediately before creating it (`git fetch` then list `db/migrations/` on every `refs/remotes/origin/*`); 176 was the highest on 2026-10-14, so expect `20261014000177_batches.sql` unless something newer landed. ADR number `0017`.
- `batch_id` is **nullable** everywhere (Directus treats NOT NULL without a default as required — the `short_id` incident).
- `batches.code`: `TEXT NOT NULL UNIQUE` with a column **default** `batches_next_code()` (`'B-'` and the next `batches_code_seq` number padded to at least four digits, never truncated: B-9999, B-10000; a plain `lpad(n, 4, '0')` would truncate B-10000 to B-1000) **and** a `BEFORE INSERT` trigger that fills it when the insert sends a blank (or NULL) code. Directus rejects an explicit `null` itself (400), and the Data Studio form never sends the column default, so in practice the default does the work.
- Field translation for `manufacturing_operations.sintering_batch_number`: label **Powder batch**, note **"The powder batch typed on the FAST press, e.g. TIMET 45-150. Names a raw stock lot but is not linked to it."**
- Never apply the migration to live; previews only, under `D1_PREVIEW_NAME=d1-starbase-map D1_PREVIEW_PORT=18059` (vite 5192) — the default `d1-starbase` preview belongs to another session.
- Run `py -m pre_commit run --files <changed files>` before each commit (sqlfluff, access-rules-in-sync, whitespace).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push after each task. Never merge or deploy.

## Review Focus

1. **STARbase deployed before `make migrate`** — the map must not request `batch_id` when `/fields/manufacturing_operations` has no such field (Directus would refuse the whole operations read). → Task 2 test `defs without batch_id → no batch_id requested`.
2. **The form's `code`** — the form omits it (Directus never sends the column default), so the default gives a `B-` code; a blank code gets one from the trigger; Directus itself refuses an explicit `"code": null` (400, accepted). → Task 1 SQL test and Task 3 REST smoke.
3. **A batch holding operations and tests** — they must form two containers (an operation batch and a test batch), not one. → Task 2 test.
4. **A batch the person cannot read** (permissions) — the container falls back to ungrouped rows, no crash, no code shown. → Task 2 test `batch_id present but batch unreadable`.
5. **Migration down** — removes fields, relations, permissions, columns, table and sequence cleanly, and restores the old "Batch #" label. → Task 1 up/down test.

---

### Task 1: Migration, permissions, ADR

**Files:**
- Create: `db/migrations/20261014000177_batches.sql` (number per Global Constraints)
- Modify: `scripts/access_rules.json` (a `batches` entry like `label_templates`), and whatever `scripts/gen_access_rules.py --values` regenerates if the repo keeps a generated copy
- Create: `docs/adr/0017-batches-are-recorded.md` (format of `docs/adr/0015-*.md`; title "Batches are recorded; probable batches are only shown"; context = spec §5.3/D14/D27; decision; consequences incl. the deploy order)
- Modify: `docs/adr/README.md` (index line)
- Test: the repo's migration test path used for recent migrations (find how `20261012000164_label_templates.sql` is tested — `tests/phase1_schema.sh` and/or `db/tests/*`; add the same kind of checks)

**Interfaces:**
- Produces: table `batches(batch_id uuid pk default uuid_generate_v4(), code text not null unique default …, batch_date date, notes text, owner_person_id uuid references people on delete set null, user_created, date_created, updated_at, version)`; sequence `batches_code_seq`; columns `manufacturing_operations.batch_id` and `test_sessions.batch_id` (uuid null references batches on delete set null, indexed); Directus: collection `batches` (icon `inventory_2`, note "Several operations or tests done together as one job"), M2O fields `batch_id` on both collections (interface `select-dropdown-m2o`, template `{{code}}`, "create new" allowed), `batches` fields meta; Lab Member permissions on `batches` (read any; create any; update/delete owner or admin — decide after reading ADR-0014 and record the reason in the ADR).

- [ ] **Step 1:** Re-scan migration numbers; read `20261012000164_label_templates.sql` and ADR-0014; write the failing schema test (table, sequence, both FKs nullable, insert without code → `B-0001`-shaped, insert with `code = NULL` → filled, unique code, delete batch → `batch_id` set null, translation of `sintering_batch_number` = "Powder batch").
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Write the migration (up + down; down restores the previous `sintering_batch_number` translation exactly as it is in live metadata — read it from migration 20261009000143's stage row), the access-rules entry, the ADR.
- [ ] **Step 4:** Run the schema test (up, down, up) → PASS; `py -m pre_commit run --files <files>` → PASS.
- [ ] **Step 5:** Commit `feat(batches): batches table, batch_id on operations and tests, Powder batch label`, push.

### Task 2: The map reads and groups recorded batches

**Files:**
- Modify: `packages/starbase-pages/src/pages/map/model/loadFamily.ts` (request `batch_id` + `batch_id.code` only when the runtime defs for that collection include `batch_id`; map to `OpRow.batchId` / `TestRow.batchId` and collect `batchCodes`), `useProcessMap.ts` (pass `batchCodes` into `groupBatches`), `model/formSlots.ts` (`batch_id` stays excluded from slots — confirm)
- Test: `loadFamily.test.ts`, `groupBatches.test.ts`, `useProcessMap.test.ts`

**Interfaces:**
- Consumes: `groupBatches(ops, tests, { probable, batchCodes })` (slice 1).
- Produces: `ProcessData.batchCodes?: Record<string, string>`.

- [ ] **Step 1: Failing tests:** `defs without batch_id → no batch_id in any request` (Review Focus 1); `defs with batch_id → batch_id and batch_id.code requested; rows carry batchId; batchCodes filled`; `a batch with 2 operations and 1 test → one operation container "Batch B-0003" and one test container` (Review Focus 3); `batch_id present but its code unreadable (null relation) → rows grouped by id with header "Batch"` — or ungrouped if the id itself is null (Review Focus 4); container header text "Batch B-0003".
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npm test -w @d1/starbase-pages`, `npm test -w @d1/ui`, typecheck → PASS.
- [ ] **Step 5:** Commit `feat(map): group containers on recorded batches`, push.

### Task 3: Preview smoke, E2E, runbook

**Files:**
- Modify: `tests/ui/specs/17-process-map.spec.ts` (a recorded-batch scenario: create a batch + attach two operations of one family through `adminApi` on the preview copy, open the map, expect one container titled `Batch B-…`; clean up after)
- Modify: the deploy runbook that lists `make migrate` steps (find the current STARbase runbook under `docs/runbooks/`): migrate **before** deploying this STARbase build is not required (the map tolerates a missing `batch_id`), but the form field appears only after migrate + Directus restart + cache flush — say so.
- Modify: `docs/wiki/database/` page that documents operations/FAST fields: mention Batch and the Powder batch label.

- [ ] **Step 1:** Start the preview (`D1_PREVIEW_NAME=d1-starbase-map D1_PREVIEW_PORT=18059`, per tests/ui/README.md), apply the migration **to the copy only** (`make migrate` pointed at the preview's database URL, or the script's own migrate hook), restart that Directus and flush its cache.
- [ ] **Step 2:** REST smoke as admin and as a Lab Member: create a batch with `code` omitted and one with `"code": ""` → both get `B-` codes (an explicit `"code": null` is refused by Directus with a 400, accepted); set `batch_id` on two operations; open each operation in the Data Studio form (`GET /items/manufacturing_operations/<id>?fields=*,batch_id.*`), edit one field and save, copy one (`POST` with the copied body) — all succeed; `sintering_batch_number` field meta shows "Powder batch". Record the commands and responses in the report.
- [ ] **Step 3:** Write the spec-17 scenario; run specs 13 + 17 `--retries=0` → PASS. Stop the preview.
- [ ] **Step 4:** Update the runbook and wiki page; `py -m pre_commit run --files <files>`.
- [ ] **Step 5:** Commit `test(batches): preview smoke and map batch scenario; docs`, push.
