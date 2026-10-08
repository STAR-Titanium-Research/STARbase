# `/scripts` — host-side jobs, Directus config and one-off ETL

Everything here is run from a host shell (usually on `d1-server`) rather than as a compose
service. Each file's header comment is the authoritative usage note; this index says which file
is for what. Python
dependencies are in [`requirements.txt`](./requirements.txt).

## Long-running orchestrators

| Script | Purpose |
|---|---|
| `force_orchestrator.py` | Machining force pipeline: runs `matlab/process_force.m` read-only over archive `.mat` files, fills `machining_force_analysis`, and builds the FRM octrees and diagnostics bakes. `--daemon` is driven from the `d1-force-crawler` admin module |
| `fast_orchestrator.py` | FAST sintering traces: normalises the machines' CSV exports, uploads them to Directus and fills `fast_run_data` |
| `diag/` | The diagnostics recipe engine (angular resampling, TSA, detrend, Getis-Ord, HDBSCAN, segmentation). Imported by `force_orchestrator.py` and copied into `plugins/diag-service` |

## Directus configuration

Run [`configure_all.sh`](./configure_all.sh) to apply these in the right order, then flush Redis
and restart Directus.

| Script | Purpose |
|---|---|
| `configure_directus.sql` | Directus metadata (collections, fields, relations) and settings for the core schema |
| `configure_inline_params.sql` | Inline per-type parameter fields on operations and test sessions |
| `configure_field_presets.sql` | Dropdown presets for free-text parameter fields |
| `configure_sample_prep.sql` | Sample preparation (etchants, recipes, prep steps) |
| `configure_campaigns.sql` | Campaigns (machining trials and testing campaigns) |
| `configure_operation_files.sql` | External data-file links on an operation |
| `configure_project_rollup.sql` | Read-only `project_rollup` collection and its panel on projects |
| `configure_users_and_policies.sql` | Lab Admin / Lab Member roles and policies, and the lab's user accounts. Applied separately, after migrations and before `migrate_legacy.py` |
| `access_rules.json` + `gen_access_rules.py` | Who may see and change which records (ADR-0011): the rules, and the generator that writes the Lab Member permission rows. `--write` refreshes the marked block in `configure_users_and_policies.sql`; `--check` (pre-commit and CI) fails on drift; `--values` prints the rows for a migration |
| `seed_demo_sample.sql` | Demo sample for the Sample Overview report |

## Data import and backfills

Mostly one-off or rerunnable ETL. Check the header before re-running any of them against
production.

| Script | Purpose |
|---|---|
| `migrate_legacy.py` | Phase 8 — AppSheet/Sheets export (`Sample_Data.xlsx`) into Postgres (`make migrate-legacy`). Re-runs only fill NULL columns, never overwrite edits; owners and operators go through `people` (`legacy_people.py`) |
| `transfer_images.py`, `transfer_sample_ownership.py` | Asset images and sample ownership from the same legacy workbook |
| `index_archive.py` | Index the read-only SMB archive into the Directus File Library (`make index-archive`). With `--fingerprint` a file that moved folder (same name, unique fingerprint) has every reference re-pointed; ambiguous or renamed files are flagged missing, never deleted |
| `import_experiment_sheet.py` | AMRC experiment-sheet machining passes into `manufacturing_operations` |
| `import_milling_jozef.py` | One-off: milling operations for one trial's `.mat` files |
| `import_fast25.py`, `import_fast250.py` | Rebuild FAST 25 / FAST 250 runs from the machine backends |
| `import_fast_logs.py` | Backfill FAST runs from the FCT HP D 250 log workbooks |
| `clear_fast_logs.py`, `apply_fast_qa_backup.py` | Either side of the FAST rebuild: snapshot, then re-attach, the sheet-only QA fields. `clear_fast_logs.py` needs `--yes` (or `--dry-run`) and never truncates its append-only backup; `apply_fast_qa_backup.py --revert --dry-run` writes nothing |
| `backfill_fast_times.py`, `finalize_fast_codes.py` | Operation clock times and canonical pass codes for sintering runs |
| `fast_his.py`, `fast_mapping.py`, `fast_recipes.py` | Shared FAST helpers: `.HIS` trace decoder, field mapping, recipe parsing |

## Migration generators

`flatten_param_fields.py`, `gen_method_fields.py` and `gen_people_meta.py` generated specific
migrations in `db/migrations/`. They are kept for reference; the migrations are the source of
truth.

## MATLAB (`matlab/`)

| Script | Purpose |
|---|---|
| `process_force.m` | Canonical force processing (metrics, FFT, FRM) — called by `force_orchestrator.py` |
| `frm_filters.m` | Bake-side twin of `plugins/filter-service` |
| `frm_grid_interp.m`, `frm_grid_splat.m`, `frm_grid_fidelity.m` | Interpolated-grid FRM octree |
| `crawl_force_structure.m` | Archive census — output in [`docs/force-archive-census/`](../docs/force-archive-census/) |
| `upgrade_force_v05_to_v10.m` | Restructure a v0.5 capture into the v1.0 layout |
| `migrate_force_to_v2.m` | Draft v2.0 migration — the format is not adopted yet (see its spec) |
| `test_*.m` | Parity and format checks, run by hand |

## Ops and checks

| Script | Purpose |
|---|---|
| `backup-postgres.ps1` | Nightly production Postgres backup on `d1-server` (Windows scheduled task; see ADR-0010) |
| `fix-docker-vmplatform.ps1` | Enable WSL2's VirtualMachinePlatform on a policy-locked Windows host |
| `test_filter_parity.py` | filter-service vs MATLAB filter parity (needs MATLAB) |
| `test_grid_bin.py` | Unit tests for the grid-octree reader in `force_orchestrator.py` |
| `diag_smoke_check.py` | Manual: process only the pending diagnostics rows |

Automated tests for `diag/` and the orchestrators live in [`tests/scripts/`](../tests/scripts/).
