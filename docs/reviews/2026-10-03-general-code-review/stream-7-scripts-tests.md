# Stream 7 — `scripts/`, `tests/scripts`, `tests/ui`, top-level `tests/*.sh` (raw reviewer report)

The reviewer reproduced the `((PASS++))` abort, the phase3 `jq` empty-input behaviour, the
envelope NaN and the interpolation error with small scripts. The coordinator's checks are
recorded in the consolidated report.

## Findings

1. **blocking — `scripts/index_archive.py:545-557` move handling deletes referenced files.** On a
   "move" (same fingerprint, new path) only the three `_JUNCTIONS` tables are re-pointed, then
   `DELETE FROM directus_files WHERE id=old`. `machining_force_analysis.directus_files_id` is
   `NOT NULL … ON DELETE CASCADE` (`…074`), so a moved `.mat` silently deletes its force-analysis
   row; `archive_metadata_edits`, `fast_run_data`, `machining_force_analysis.live_cache_file` /
   `frm_*`, `tools`/`equipment.image` are `SET NULL`. The fingerprint is size + head/tail 64 KB,
   so zero-padded files can collide. Fix: re-point every FK to `directus_files` (or mark the old
   row moved), never delete a referenced row; collision-check before auto re-pointing.
2. **blocking — `scripts/clear_fast_logs.py:105-110` destroys its own backup on a second run.**
   Non-dry run does `TRUNCATE fast_log_qa_backup`, snapshots, deletes — no confirmation. A rerun
   finds 0 rows, truncates the backup and snapshots nothing: CoSHH refs and QA notes are lost.
   Fix: refuse to truncate a non-empty backup when there's nothing to snapshot; require `--yes`.
3. **blocking (test) — `tests/phase4_heavy_data.sh:15,28`** — `set -e` with `((PASS++))` exits
   after the first PASS (post-increment of 0 returns status 1). Same for `FAIL`. Not in CI. Fix:
   `PASS=$((PASS+1))`.
4. **should fix — `scripts/migrate_legacy.py:625-626`** `is_depleted = status and …` yields `None`
   for a blank status; the column is `NOT NULL`, so one row aborts the whole migration. Wrap in
   `bool()`.
5. **should fix — `migrate_legacy.py:89-90`** `clean_str` treats `"na"` as empty → sodium (`Na`)
   is dropped from alloying elements and junctions.
6. **should fix — `migrate_legacy.py`, `transfer_sample_ownership.py`** write `owner`/`user_id`
   only; the UI reads `owner_person_id` / `operator_person_id` / `sample_co_owners.person_id`
   since `…061/062`, with no sync trigger. `load_users`' uuid5 map holds ids that don't exist when
   the email already existed.
7. **should fix — `migrate_legacy.py` reruns overwrite live edits** despite the "DO NOTHING"
   docstring (`COALESCE(EXCLUDED.x, table.x)`; `form`/`notes` unconditional). `clean_float`
   (`:63-69`) maps 0.0 to None.
8. **should fix — `infra/backup/backup.sh`, `restore.sh`.** A failed `pg_dump | gzip` leaves a
   truncated `.gz` under a valid name; restore has no `ON_ERROR_STOP` / `--single-transaction`,
   and `--clean` dumps start with DROPs, so a bad file guts the DB and still prints "Restore
   complete"; only `sleep 10` as confirmation; roles not dumped (the `.ps1` handles globals);
   `make prune-backups` has no keep-last-N.
9. **should fix — `scripts/apply_fast_qa_backup.py:76-83`** `--revert --dry-run` writes and
   commits.
10. **should fix — `scripts/configure_all.sh:14`** psql without `ON_ERROR_STOP`; the configure SQL
    files lack BEGIN/COMMIT and `configure_campaigns.sql:38-40` starts with DELETEs of
    `directus_fields`; errors detected only by `grep -i error … || true`.
11. **should fix — tests that pass/fail for the wrong reason.** `tests/phase3_api.sh:~264-275`
    Researcher-isolation check can never pass (`curl -sf` discards the 403 body, `jq` on empty
    prints nothing); its stale-OCC check accepts any curl failure. `tests/phase6_text_to_sql.sh`
    `deny()` passes on any non-zero psql exit; write test masked by
    `default_transaction_read_only`. `tests/ui/specs/11-force-dashboard.spec.ts:34` assertion is
    vacuous. `tests/phase7_traceability.sh` hides fixture failures (`|| true`) and never cleans up.
12. **should fix — `tests/scripts` goldens fail on a fresh environment; not in CI.**
    `scripts/diag/spatial.py:55-57` `cKDTree.query(k=30)` has distance ties at the 30th
    neighbour on 2,560 synthetic points, so `gi_star` depends on tie-breaking; 4 byte-exact golden
    tests fail on both current and plugin-pinned numpy/scipy/sklearn. Fix: deterministic
    tie-break or tolerance; add a CI job.
13. **nit — `scripts/matlab/migrate_force_to_v2.m:71`, `upgrade_force_v05_to_v10.m:80`** delete
    `dst` with no `src ≠ dst` check; `mo.placeholder = []` doesn't remove the variable.
14. **nit — `scripts/diag/envelope.py:46-47`** `butter(4, …, 'band')` in b,a form goes NaN for
    narrow bands (fc=200/500 Hz at fs=100 kHz). Use `sos` + `sosfiltfilt`.
15. **nit — `scripts/diag/interpolate.py:~114-116`** binning pitch ≠ grid pitch unless span/res is
    an integer (2× the expected error in a ramp test).
16. **nit (uncertain) — `index_archive` without `--fingerprint`** (as `make index-archive` runs it)
    rewrites `metadata` without the fingerprint; `force_orchestrator.py:287` would then requeue
    every previously fingerprinted analysis. `created_on` uses `st_ctime`.
17. **nit — formats.** `scripts/diag/d1lc.py` matches the backend v1 header and arrays but
    ignores the v2 trailer and never validates `version`; `process_force.m` writes v1 correctly;
    `test_d1lc_round_trip` uses a hand-rolled writer, never `write_d1lc` or MATLAB output;
    `frm_filters.m` silently makes the despike window odd where Python rejects it.
18. **nit — test patterns.** Playwright fixed sleeps + non-retrying visibility asserts (specs
    01/02/06/07/08); `fieldByLabel` is a prefix regex; `tests/ui/verify_fast25.mjs:13` hard-codes
    the placeholder password; `test_diag_requeue_trigger.py` effectively never runs outside one
    machine.
19. **gap** — no tests (not even dry-run) for `migrate_legacy.py`, `index_archive.py`,
    `clear_fast_logs.py`, `apply_fast_qa_backup.py`, backup/restore, `configure_all.sh`, the `.m`
    migration tools.

## Checked and fine

`backup-postgres.ps1`; `index_archive.py` f-string table names come from constants;
`force_orchestrator` MATLAB `-batch` quoting; `process_force.m` opens `.mat` read-only.

## Checks run

`pytest -q tests/scripts`: 212 passed, 2 skipped, 4 failed (goldens, see 12) on two dependency
sets. `ruff check scripts tests` clean. `bash -n` OK. shellcheck not installed; Playwright not run.
