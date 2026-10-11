# T0d: FAST importers feed the code rule — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New FAST runs get their code from the database rule (T0b), a hand-logged sintering
operation is filled in by the import instead of duplicated (Q48), and `finalize_fast_codes.py`
is retired.

**Architecture:** The two importers (`scripts/import_fast25.py`, `scripts/import_fast250.py`) also
write `sintering_run_number`; the trigger `mfg_op_set_code` then builds the code on insert and keeps
it up to date on re-import. Before the upsert, a shared helper adopts any hand-logged operation with
the same machine (equipment) and run and no `source_run_uid`, so the upsert updates it. The EMD trace
queue uses the operation ids that actually exist after the upsert. No migration: all 10,048 FAST codes
already equal the rule (measured 2026-10-10), so spec §6's rebuild is a no-op.

**Tech Stack:** Python 3, psycopg2, pytest (DB tests skip without `DATABASE_URL`; CI sets
`REQUIRE_DB_TESTS=1`), Docker.

**Spec:** [`docs/superpowers/specs/2026-10-10-record-codes-design.md`](../specs/2026-10-10-record-codes-design.md)
§6 and Q37/Q48. Stage **T0d**.

## Global Constraints

- Worktree `.claude/worktrees/t0-record-codes`, branch `feat/record-codes`; never the main checkout
  or live; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The importers never write `pass_code`; the run number is the machine's own (`VersuchNr` / `No`),
  never invented.
- Adoption matches `process_category = 'sintering' AND equipment_id = <machine> AND
  sintering_run_number = <run> AND source_run_uid IS NULL`; it sets `source_run_uid` and
  `source_system` on that row (it keeps its own `operation_id`, owner, notes and sample links).
- Everything else the importers do stays the same.

## Decisions where the spec was silent

1. **No rebuild migration** (spec §6 steps 1-3): measured on live, every FAST code already equals
   the rule and every run number parses; the back-fill already ran in 156.
2. **Adopted rows keep their own `operation_id`**: the upsert's `ON CONFLICT (source_run_uid)` then
   updates them; the trace queue must use the real id, read back after the upsert.

---

### Task 1: Shared adoption helper, run numbers, real ids in the trace queue

**Files:**
- Create: `scripts/fast_ops.py` — `adopt_hand_logged(cur, equipment_id, source_system, runs)` where
  `runs` is a list of `(run_no, source_run_uid)`; returns the number adopted. And
  `operation_ids_for(cur, uids)` → `{source_run_uid: operation_id}`.
- Modify: `scripts/import_fast25.py`, `scripts/import_fast250.py` — add `sintering_run_number` to the
  inserted columns (value: the run number, int) and to the `DO UPDATE SET` list; call
  `adopt_hand_logged` before the upsert; build the `fast_run_data` enqueue from
  `operation_ids_for` (not the deterministic `op_id_for`); update the module docstrings (no more
  "finalize_fast_codes.py assigns it": the database builds the code from the run number).
- Create: `tests/scripts/test_fast_ops.py` (DB-level; follow the skip conventions in
  `tests/scripts/conftest.py`): in a transaction on a migrated database (rolled back): a hand-logged
  sintering op (equipment FCT HP D 25 fixture, run 9999, no source_run_uid) is adopted by
  `adopt_hand_logged` (count 1; its source_run_uid/source_system set; same operation_id); a second
  call adopts nothing; an op on the other machine or with a source_run_uid is not touched;
  `operation_ids_for` returns the adopted id for its uid. Plus one end-to-end test of the upsert
  path if the importers' DB-writing code can be called without the Access/HIS files (refactor the
  write part into a function taking the parsed `ops` list if needed — keep the parsing untouched):
  after the upsert the adopted op has `sintering_run_number` 9999 and `pass_code` built by the
  trigger (`DD-MM-YY-MF25-9999…`), and a fresh run gets an inserted op with its code.
- Create: `scripts/dev/script_tests_docker.sh` + `scripts/dev/script-runner.Dockerfile` — like
  `schema_test_docker.sh`, but runs `pytest -q tests/scripts` with `DATABASE_URL` and
  `REQUIRE_DB_TESTS=1` in a runner image (pgvector/pgvector:pg16 + python3, pip `psycopg2-binary
  pytest openpyxl requests numpy==2.2.* scipy==1.14.* scikit-learn==1.5.*` — copy the package list
  from the handoff's runner2 Dockerfile at `%TEMP%\d1-handoff-2026-10-10\runner2\Dockerfile` if
  present, else this list), migrations applied with dbmate first (reuse the migration-123
  workaround from `schema_test_docker.sh`), containers removed with `-v`.

- [ ] **Step 1:** Write `test_fast_ops.py`; run `bash scripts/dev/script_tests_docker.sh` → the new
  tests FAIL (module missing). Record the baseline of the other script tests first (some may be
  pre-existing failures/skips — list them).
- [ ] **Step 2:** Implement `fast_ops.py` and the importer changes.
- [ ] **Step 3:** Run the script tests → new tests PASS, no new failures vs the baseline; also
  `bash scripts/dev/schema_test_docker.sh` (only the 4 pre-existing FAIL lines).
- [ ] **Step 4:** Commit (`feat(fast): importers feed the code rule and fill in hand-logged runs`).

### Task 2: Retire finalize_fast_codes.py

**Files:** delete `scripts/finalize_fast_codes.py`; update `scripts/README.md` (the import order:
importers → orchestrator drain; codes come from the database) and any runbook mention; the spec's
Status line and Migrations table row for T0d ("no migration; importers"); the round-2 plan's T0 row.

- [ ] **Step 1:** `grep -rn finalize_fast_codes` (excluding `.superpowers/`) → only the files above;
  remove/update each.
- [ ] **Step 2:** Run the script tests once more (nothing imported the script).
- [ ] **Step 3:** Commit (`chore(fast): retire finalize_fast_codes.py — the database builds FAST codes`).

### Task 3 (coordinator): verify against a copy of live, then hand over

The importers run by hand, not as a service, so nothing is deployed to the stack. On a restored copy
of live: run `adopt_hand_logged` + the upsert path with two synthetic runs (one matching a hand-logged
op created in the copy) and check codes and ids; note the result in the plan's Outcome. The maintainer
runs the next real import; until then nothing changes on live.
