# General code review — 2026-10-03

A whole-repo review of `main` at `8dbb529`, split into seven areas. Each area was reviewed by a
read-only Sonnet reviewer that read the code and ran the area's own checks, and in places
reproduced bugs with small scripts. The coordinator then re-read the code behind every finding
listed under **Verified blockers** below. Everything else comes from the reviewers' reports in
[`2026-10-03-general-code-review/`](2026-10-03-general-code-review/), which give `file:line`,
scenario and fix for each item. No code was changed by the review itself.

**Status:** the fixes shipped in PR #119 (merged 2026-10-04). Its description lists what was fixed,
the owner decisions taken and the items held back. The review and fix-batch plans were deleted
once the batch shipped (see `docs/superpowers/README.md`); git history keeps them.

| # | Area | Raw report | Blocking | Should fix |
|---|---|---|---|---|
| 1 | force-app backend, backup server, bug-report relay | [stream-1](2026-10-03-general-code-review/stream-1-backend.md) | 4 | 7 |
| 2 | force-app web, desktop (Electron) | [stream-2](2026-10-03-general-code-review/stream-2-web-desktop.md) | 3 | 8 |
| 3 | `packages/force-plotting` | [stream-3](2026-10-03-general-code-review/stream-3-force-plotting.md) | 1 | 13 |
| 4 | `core/` Directus extensions, `apply.sh`, permissions | [stream-4](2026-10-03-general-code-review/stream-4-core.md) | 2 | 9 |
| 5 | `db/` migrations, seeds, schema tests | [stream-5](2026-10-03-general-code-review/stream-5-db.md) | 1 | 7 |
| 6 | `plugins/`, compose, infra, CI | [stream-6](2026-10-03-general-code-review/stream-6-plugins-infra.md) | 3 | 8 |
| 7 | `scripts/`, script and UI tests | [stream-7](2026-10-03-general-code-review/stream-7-scripts-tests.md) | 3 | 9 |

## Verified blockers

The coordinator checked each of these against the code.

**Security: services are exposed with no or weak authentication**

| Ref | Finding |
|---|---|
| 6.1 | `docker-compose.yml:35-36` publishes Redis on all interfaces with no password. rq loads jobs with pickle, so anyone who reaches port 6379 can run code in the worker containers, which hold the MinIO root credentials and the Directus token. |
| 6.2 | Every compose port binds to `0.0.0.0`. `WORKER_WEBHOOK_SECRET` is blank by default, and `check_secret` (`plugins/heavy-data-worker/app/lib/security.py:24`) then turns auth off for the worker routes and the text-to-SQL API. Fallback passwords such as `minioadmin` and `change_me` work. |
| 1.3 | `apps/force-app/backend/scripts/start_recorder.ps1:35` starts the unauthenticated recorder on `--host 0.0.0.0`. The code itself (`main.py:2364`) says binding to loopback only is its sole protection. |
| 4.1 | `core/extensions/d1-report/src/index.js:165+` checks only that someone is logged in, then reads through the root knex. Any account can fetch full sample, operation and test reports, whatever its Directus permissions. |
| 4.2 | `core/extensions/d1-ask-endpoint/index.js:22-36` has the same "any user" gate. It sits in front of a database role that can read every table except a deny-list, including `audit_logs` and `people`. The SQL guard can be bypassed (6.4: CTE shadowing, `query_to_xml`), so in practice the deny-list is the only boundary. |

**Data loss or corruption**

| Ref | Finding |
|---|---|
| 1.1 | If the consumer thread throws, for example on a full disk or because of 1.2, the recording hangs in "recording" for good. `Ring.close()` blocks on the full queue, so the raw data is never fsynced, the backup never stops and finalize never runs. Reproduced. |
| 1.2 | Virtual-channel formulas such as `min(Fx)`, `sqrt()` or `1/0` pass the check when channels are saved, then throw `TypeError` or `ZeroDivisionError` while recording, which triggers 1.1. Reproduced. |
| 2.3 | The desktop quit and auto-update guards check only for `state === 'recording'`. Quitting or updating during `finalizing` force-kills the backend, so the cut is left as an incomplete recording. |
| 2.1 | The Record page never re-reads `/record/status` and never reconnects its WebSocket. If a `done` message is missed (the user left the page, or the backend restarted), the UI stays stuck: Stop returns a 409 that is swallowed, and the save dialog spins forever. |
| 3.1 | Four polling loops in `ForceDashboard.vue` (`buildOctree`, `buildGridOctree`, `bakeFilters`, `clearBake`) run for up to 15 minutes and write op A's results into whichever op is open when they finish. "Save crop as official" can then save A's crop onto B. |
| 5.1 | `refresh_project_rollup()` deletes and re-inserts the whole rollup on every statement. Two concurrent edits to different operations fail with a duplicate-key error. Reproduced on Postgres 16. |
| 6.3 | The analysis worker decimates by striding with no anti-alias filter. On large files a 1 kHz tone is reported at 16 Hz, and the bands above 500 Hz are always zero. Reproduced. |
| 7.1 | `scripts/index_archive.py:545-557` handles a moved file by deleting the old `directus_files` row. That cascades into `machining_force_analysis`, so moving a `.mat` file in the archive silently deletes its analysis. |
| 7.2 | A second run of `scripts/clear_fast_logs.py` truncates its own QA backup and snapshots nothing, so the CoSHH and QA notes are permanently lost. |
| 7.3 | `tests/phase4_heavy_data.sh` exits after its first PASS: `((PASS++))` with `set -e`. |

Stream 5's finding 2 was also checked. `v_manufacturing_operations_full` and
`v_test_sessions_full` inner-join a now-nullable `sample_id`, so text-to-SQL silently undercounts
operations and tests.

## Cross-cutting themes

1. **The network boundary is assumed, not enforced.** The plugin contract, the recorder, the
   relay and Caddy all assume they run "Docker-internal" or "tailnet only", but compose and the
   autostart script publish everything on all interfaces, and the secrets fail open (6.1, 6.2,
   1.3, 1.7). One change in compose and the env template (bind to `127.0.0.1` or the tailnet IP,
   `${VAR:?}`, fail closed) removes most of this class.
2. **Custom endpoints and hooks skip Directus permissions.** `d1-report`, `d1-ask`,
   `owner-cascade`, `d1-apply-prep-recipe` and `box-intake` read or write through the root knex
   (4.1, 4.2, 4.7). The text-to-SQL role is built on a deny-list (5.8, 6.4).
3. **ADR-0002 drift.** Business rules live only in the browser or in post-commit hooks:
   operation codes and sample codes are built client-side with `max+1` and no unique constraint
   (4.5, 4.6). Owner cascade and box intake run as action hooks whose errors are swallowed (4.7).
   The process-category map is duplicated in Vue and SQL (4.11).
4. **Audit and OCC cover only part of the schema.** 9 of 48 tables are audited, several
   `version` columns have no OCC trigger, `audit_trigger_function` has no pinned `search_path`,
   and plugin write-backs skip the version filter (5.3, 5.4, 5.7, 6.6).
5. **Stale async responses overwrite newer state** across the Vue code: replay search and pick,
   the dashboard polls, stats, and the lab and FAST dashboards (2.7, 3.1, 3.11, 4.10).
6. **Destructive scripts lack transactions, confirmation or verification.** Affected: restore
   with no `ON_ERROR_STOP`, backup that doesn't verify its dump, `configure_all.sh`,
   `clear_fast_logs`, `apply_fast_qa_backup --dry-run`, and `make reset-db` (6.9, 7.2, 7.8–7.10).
7. **Tests that don't run, or don't test.** `phase3_api.sh`, `phase4`, `tests/scripts`,
   Playwright, the plugin-template tests and the filter/diag image builds are not in CI.
   Several assertions can't fail (7.3, 7.11) or can't pass (7.11). The `tests/scripts` goldens
   fail on a fresh environment because of KD-tree ties (7.12). There are no unit tests for any
   Directus hook or endpoint (4).

## Suggested follow-up batches

Batches P0–P2 follow the same pattern as `docs/superpowers/plans/2026-10-02-open-issues-batch.md`.
Each needs a plan and owner sign-off first.

- **P0, security exposure (small, high value):** 6.1, 6.2, 1.3, 4.1, 4.2 (role gate plus deny
  `audit_logs` and `people`), 6.4 (guard and grants).
- **P0, data loss:** 1.1 + 1.2, 2.3, 3.1, 7.1, 7.2, 5.1, and backup/restore hardening (7.8).
- **P1, correctness:** 2.1, 2.2 (duplicate operation on save retry), 2.5, 5.2, 6.3, 6.5, 6.6,
  1.4–1.6, 4.5–4.8, 3.2–3.4.
- **P2, coverage and hygiene:** audit and OCC catalog tests plus the missing triggers (5.3,
  5.4); add the non-running suites to CI and fix vacuous tests (7.3, 7.11, 7.12); scope the
  workflow `permissions:` blocks (6.10); bring the plugin contract in line with the code (6.11).

## Decisions for the owner

- Whether `apply.sh` / `permissions.json` should be ported to Directus v11 policies or retired
  in favour of `scripts/configure_users_and_policies.sql` (4.3).
- Who may use `/d1-ask` and `/d1-report`, and whether text-to-SQL should move to a table
  allow-list (4.2, 5.8).
- Whether `audit_logs` should cover every table, as ADR-0003 says, and how sample deletes should
  cascade (5.3).
- How to repair applied migrations whose down sections are lossy (5.5, 5.6), since they can't be
  edited.

## Checks run

| Area | Result |
|---|---|
| backend | `pytest` 441 passed; `ruff check` 1 finding (UP031, `tests/test_nidaq.py:78`) |
| backup-server / bug-report-relay | 39 / 8 passed |
| force-app web / desktop | 317 / 68 passed (1 Windows-only skip); typecheck clean |
| force-plotting | 376 passed; `vue-tsc` clean |
| plugins | llm-text-to-sql 91, heavy-data 12, analysis 11, filter 6, diag 41, template 2 passed; `ruff` clean |
| db | all 120 migrations up / down / up on Postgres 16, schema dumps identical; seeds idempotent |
| scripts / tests | `tests/scripts` 212 passed, **4 failed** (golden tie-break, 7.12); `ruff` clean |
| core | `node --check`, `bash -n`, JSON parse; force-dashboard extension build OK |
