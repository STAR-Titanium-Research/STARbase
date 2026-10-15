# Found files and the Inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only inbox crawler finds new files in each person's and team's folder on the lab share, tags what they look like and which record they name, and STARbase gets an Inbox (badge, Home panel, page) where people link them to samples, operations and tests, in bulk, with opt-in auto-linking.

**Architecture:** Five `d1_private` tables plus two columns (migration, stream A). A plain-ESM Directus endpoint `d1-inbox` is the only reader and writer of found files for people, and links as the caller (stream B). A Python daemon `scripts/inbox_crawler/` does the scanning behind one read-only filesystem module and a build-failing test (stream C). STARbase gets the Inbox entry, page, Home panel, alias/folder fields and an admin tab (stream D).

**Tech Stack:** PostgreSQL 16 + dbmate; Directus 11.17 endpoint (plain ESM, `node:test`); Python 3.12 (psycopg2, Pillow, pytest); Vue 3 + TypeScript (`@d1/starbase-pages`, `apps/starbase/web`), vitest, Playwright; Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-15-found-files-inbox-design.md` (the schema contract is §4; the route table §9). **ADR:** `docs/adr/0020-inbox-crawler-read-only-allow-listed.md`. **Glossary:** `CONTEXT.md` § Files on the share.

## Global Constraints

- **The share is never changed.** No write, delete, move, rename or open-for-write against it, anywhere. Documents are never opened before a person links them. Read the `inbox-crawler-conventions` skill.
- Words on screen: **found file**, **Inbox**, **link**, **backlog** shown as "Older files", **uni alias**, **share folder**. A surface scan is **added**, never "linked" or "attached". "Attach" is only the process map's word.
- Branches: the coordinator's branch is `ccr-f5ece72d-pvkcct` (PR #310). Each stream works in its own worktree on a local branch `feat/inbox-<stream>`; workers **never push, merge (other than the initial fast-forward, or when told) or rebase**. The coordinator merges after review.
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01YGVh6kfgvqZMHaVmHn39dw`.
- Workers run on **Sonnet 5.5 at high effort**; reviews run on **Opus**. Three or four workers at a time.
- Migrations: re-scan every origin branch for the next free number immediately before creating the file (`ls db/migrations | tail`; the live tip at plan time is `20261015000191`). Follow the `db-migration` skill: reversible, COMMENT everything, prove up/down/up.
- Errors from `d1-inbox` use the d1-record-access shape `{ errors: [{ message, extensions: { code, source: 'd1-inbox' } }] }`: 401 no user, 403 not allowed, 404 unknown id, 409 refused state, 400 bad input, 429 rate limit.
- Writes run in a knex transaction that starts with `SELECT set_config('d1.actor_identity', <user id>, true)`; clear the Directus cache after commit when `CACHE_ENABLED` (copy `d1-record-access`).
- `@d1/starbase-pages` stays host-neutral (`src/hostNeutral.test.ts`).
- Things only the real share, Directus data or a rig can confirm go in `docs/runbooks/physical-test-backlog.md` (items F1–F9 are already there; extend them, never remove).

## Status

| Stream | What | Agent profile | Worktree / branch | State |
|---|---|---|---|---|
| E | Spec, ADR-0020, glossary, backlog items F1–F9, this plan, the crawler profile and skill | coordinator | `ccr-f5ece72d-pvkcct` | **done** (PR #310) |
| A | Migration: `uni_alias`, `share_folder`, five `d1_private` tables, schema tests | `d1-server-implementer` | `feat/inbox-a-schema` | not started |
| B | `d1-inbox` extension (routes, edit-rights check, undo, rate limit, auto-link guard) | `d1-server-implementer` | `feat/inbox-b-endpoint` | not started (after A is merged) |
| C | `scripts/inbox_crawler/` daemon, classifiers, recognition, read-only tests, compose service | `inbox-crawler-implementer` | `feat/inbox-c-crawler` | not started (after A is merged) |
| D | STARbase: Inbox entry and badge, page, Home panel, People/Teams fields, admin tab | `directus-ui-implementer` | `feat/inbox-d-ui` | not started (after A is merged) |
| F | Surface-scan confirm form (item, condition, operation) and the `surface_scans` link target in `d1-inbox` | `directus-ui-implementer` + `d1-server-implementer` | `feat/inbox-f-scan-form` | contract received (spec §8); builds with fakes; live link waits for the Alicona chat's `surface_scans` migration |
| R | Opus review of A–D, fixes, CI | reviewers | — | not started |

Order: **A → (B, C, D in parallel) → R → F when unblocked.** Update this table on every state change and fold the edit into the next code push.

## Review Focus

1. **A write against the share** (any module, any path) → the build-failing AST test catches it; reviewer also greps for `open(`, `os.`, `shutil`, `Path(` in `scripts/inbox_crawler/`.
2. **A document opened before it is linked** → `open_rb` refuses it; test with `.pdf`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.m`, `.mat`.
3. **Link by someone who can only view the record** → 403 (junction creates are unfiltered by Directus rules, ADR-0011, so the extension must check). Test with a view-only person and a Restricted record.
4. **A date mistaken for a short ID** (`20261015`) and **two records sharing a token** → neither is flagged as a suggestion.
5. **A share that disappears mid-scan** → scan aborts; no candidate becomes `gone`.
6. **A team's file linked by two members at once** → the second gets 409, not a second junction row.
7. **Undo after the record was changed** → removes only the junction row the batch created.
8. **Auto-link for a person who opted out, or for a document, or for an ambiguous match** → never.
9. **The per-person rescan abused** → 429 within 10 minutes of the last request.
10. **Candidate rows read through Directus's REST** → impossible (`d1_private`, not exposed).

---

## Stream A — Schema (`d1-server-implementer`)

**Files owned:** one new migration `db/migrations/<next>_found_files_inbox.sql`; a new section in `tests/phase1_schema.sh`; entries in `docs/data-dictionary.md`.

- [ ] **A1: Tests first** in `tests/phase1_schema.sh` (each check in a rolled-back transaction, in the style of the existing sections): `people.uni_alias` rejects `a`, `a/b`, a 65-char value and a duplicate differing only in case; accepts `abc12de`; `teams.share_folder` rejects `x/y`, `x\y` and blank; `file_candidates` rejects a row with both owners, with neither, a bad `kind`/`state`/`origin`/`match_strength`; cascades when its `directus_files` row is deleted; `directus_files_id` is unique; the singleton `inbox_crawler_state` rejects a second row; `inbox_scan_requests` rejects a bad `scope`/`status`; every new table and column has a comment; none of the new tables is in `directus_collections`. Run `bash scripts/dev/schema_test_docker.sh` → new checks FAIL.
- [ ] **A2:** Write the migration exactly as spec §4 (columns, constraints, indexes, comments, singleton seed row, down). Auto-link opt-in: inspect migration 170 (`d1_private.user_prefs`); if a boolean preference fits its shape reuse it, else create `d1_private.inbox_prefs (user_id uuid primary key, auto_link boolean not null default false)`. Record the choice in the commit message and in spec §4.
- [ ] **A3:** `ROUNDTRIP=1 bash scripts/dev/schema_test_docker.sh` → new checks pass; only the pre-existing FAIL lines remain.
- [ ] **A4:** `docs/data-dictionary.md` entry; commit (`feat(db): found files inbox tables`). Also run the `migration-review` skill on the new file and fix its findings.

## Stream B — `d1-inbox` extension (`d1-server-implementer`, after A is merged)

**Files owned:** `core/extensions/d1-inbox/{package.json,index.js,index.test.mjs}`; wiring in `docker-compose.yml` only if extensions are listed there (check `d1-build`'s precedent).

Copy the shape of `core/extensions/d1-build` (route wrapper, `HttpError`, Directus-shaped errors, `ItemsService` with the caller's accountability and `knex: trx`).

- [ ] **B1: Tests first** (fake knex and fake services, as the precedents do) for every route in spec §9, including: summary counts new vs older-with-exact-match, per person and per team; visibility (owner person, active team member, administrator; nobody else); `link` refuses a view-only user, accepts an editor, is atomic across a batch, returns `link_batch_id`, is idempotent per candidate, returns 409 when two members race; `accept-all` links only exact short-ID suggestions the caller can edit and reports skipped rows; `undo` removes exactly the batch's junction rows; `rescan` queues once and returns 429 inside 10 minutes; `prefs` round-trips; `auto-link` is machine-only and refuses an opted-out person, a document, an ambiguous match and a record the person cannot edit.
- [ ] **B2:** Implement the routes. The edit-rights check is the same function `d1-access-guard` uses (read it and import or mirror it; say which in the commit message). Link targets in v1: `physical_samples` → `sample_data_files`, `manufacturing_operations` → `operation_data_files`, `test_sessions` → `session_data_files`. Linking a document sets a flag the crawler reads to hash it once.
- [ ] **B3:** `GET /d1-inbox/admin` and `POST /d1-inbox/admin/scan-all` (administrators only); the admin payload includes status, last scan, errors, unmatched `Users/` folders and people without an alias (read from `inbox_dirs` and `inbox_crawler_state`).
- [ ] **B4:** `cd core/extensions/d1-inbox && node --test` passes; commit per route group.

## Stream C — Inbox crawler (`inbox-crawler-implementer`, after A is merged)

**Files owned:** `scripts/inbox_crawler/` (`fs_readonly.py`, `owners.py`, `scan.py`, `recognise.py`, `classify_sem.py`, `classify_scan.py`, `hashing.py`, `db.py`, `daemon.py`, `__main__.py`), `tests/scripts/test_inbox_crawler_*.py`, a `inbox-crawler` service in `docker-compose.yml` (profile `archive`, same `archive_share:ro` mount, `python:3.12-slim`, installs `psycopg2-binary Pillow`), `make inbox-crawler`, `.env.example` notes, CI wiring (see `docs/ci-cd.md` and the `ci-local` skill: the new tests must run in the scripts job).

- [ ] **C1: Read-only first.** `fs_readonly.py` (`scandir`, `stat`, `open_rb(path, adopted=False)`); `test_inbox_crawler_readonly.py` (AST scan for every forbidden call in the skill; `open_rb` refusals; a fake share that vanishes mid-scan).
- [ ] **C2: Recognition** (`recognise.py`, pure): tests for short IDs, dates ignored, delimiter rules, two-record collisions, full codes, edge codes, strength ordering, and that it consults a supplied lookup, never a regex on the database.
- [ ] **C3: Classification:** `classify_scan.py` (`.al3d` from a config list); `classify_sem.py` with the pluggable profile interface and the JEOL profile (bottom data-bar detection with Pillow on **synthetic fixtures generated in the test**; embedded metadata read when present; OCR only behind a default-off flag). Output `kind`, confidence, `extracted` containing only what was read.
- [ ] **C4: Hashing and registration:** throttled streaming SHA-256 into `file_fingerprints`; pointer rows in `directus_files`/`directus_folders` using the indexer's id rule (import it from `scripts/index_archive.py`; do not change that script's behaviour; its tests must still pass).
- [ ] **C5: Scan loop and owners:** owners from `people.uni_alias`/`teams.share_folder`; incremental scan via `inbox_dirs` (stat known dirs, list only changed ones); first complete scan of an owner sets `baselined_at` and marks that scan's files `origin='backlog'`; duplicates (hash) set `duplicate_of`; vanished files → `gone` or re-point on hash match; share-drop abort. Postgres-backed tests in the style of `tests/scripts/test_index_archive.py`.
- [ ] **C6: Daemon:** `inbox_crawler_state` heartbeat and `desired_state`/interval/`read_mb_per_s`; scan requests claimed with `FOR UPDATE SKIP LOCKED`; after-scan auto-link calls to `d1-inbox` (`POST /d1-inbox/auto-link`, machine token from `.env`, tests with a fake HTTP server); adopted-document hashing loop.
- [ ] **C7:** compose service, `make inbox-crawler`, docs line in `docs/runbooks/`, backlog items F1–F9 kept accurate; commit per task.

## Stream D — STARbase (`directus-ui-implementer`, after A is merged)

**Files owned:** `packages/starbase-pages/src/inbox/` (new), the sidebar entry in `packages/d1-ui/src/nav/navConfig.ts`, a Home panel in `packages/starbase-pages/src/home/`, the alias field in `packages/starbase-pages/src/people/` (`PersonEditDialog.vue` and its API/model), the share-folder field in `packages/starbase-pages/src/teams/`, an admin tab in `packages/starbase-pages/src/crawler/`, routes in `routes.ts`.

Develop against the route table in spec §9 with a typed `inboxApi.ts` and a fake server in tests; no backend needed.

- [ ] **D1: Pure model first** (`inboxModel.ts` + tests): tabs, filters in the URL, suggestion text ("short ID `3fa9c1d2` in the file name"), match-strength labels, accept-all preview count, rate-limit message, consent text.
- [ ] **D2: Sidebar entry and badge** at the top, outside the five sections, polling the summary route at a calm interval and on focus; **Home panel** (new count and "N older files match a record").
- [ ] **D3: Inbox page** (`/inbox`): tabs *New · Older · Recently linked · Dismissed*, rows with thumbnails (image kinds only, via the existing Directus asset route), Link / Change (record picker for sample, operation, test) / Dismiss, filters, Accept all with confirm, one Undo per batch, Rescan my folder, document rows collapsed under "Other files" with the "reads this file once" notice.
- [ ] **D4: Settings:** the auto-link switch with consent text (what is linked, documents never auto-linked, where the undo is) and the "Recently auto-linked" list.
- [ ] **D5: Admin:** alias field on the People edit dialog (and "scan while Former"), share folder on Teams, a second tab on `/crawler` (status, last scan, errors, unmatched folders, people without an alias, Scan all).
- [ ] **D6:** vitest for models, a Playwright spec for the page against the fake server, `directus-ui-conventions` checks, backlog items kept accurate; commit per task.

## Stream F — Surface-scan link target and confirm form

Contract received from the Alicona chat (spec §8). Two parts, started after B and D are merged:

- [ ] **F1 (`d1-server-implementer`):** in `d1-inbox`, a `surface_scans` link target: `POST /d1-inbox/link` accepts `{candidate_id, collection:'surface_scans', insert_id|edge_id, condition, operation_id?, scanned_on?, condition_note?, notes?}`; creates the row through `ItemsService` as the caller in the same transaction as the candidate update; undo deletes it; refuses a missing/invalid `condition`, both or neither of `insert_id`/`edge_id`; a feature check that the `surface_scans` table exists (otherwise 409 "Surface scans are not available yet"). Tests with fakes.
- [ ] **F2 (`directus-ui-implementer`):** for `kind='surface_scan'` the Link dialog's button reads "Add a surface scan" and collects item (insert or edge picker), condition (required, no default), optional operation, date and notes; shows the warning "Adding a surface scan makes the file visible to every lab member"; a duplicate (same item and file, refused by the table's unique constraint) is shown as "already added"; never says "link" or "attach" for it.
- [ ] **F3:** once the Alicona chat's `surface_scans` migration is on the base branch, run both against the real table (schema test) and tick backlog item F9.

## Stream R — Review and CI (coordinator)

- [ ] **R1:** After each of A, B, C, D: an Opus review (`directus-ui-reviewer` for D; for A, B and C a general Opus reviewer given the spec, ADR-0020, the skill's invariants and the Review Focus list, plus the `migration-review` skill for A). Findings are fixed by the same worker (`SendMessage`) before merge.
- [ ] **R2:** Merge the stream branches into `ccr-f5ece72d-pvkcct` after review, in the order A, B, C, D; update this table; push once per merged group.
- [ ] **R3:** Check CI (`CI passed`, plus Claude Approvals if the repo runs it) on PR #310 after every push; fix red CI; never skip a test.
- [ ] **R4:** Final Opus review of the whole diff against the spec before reporting done.
