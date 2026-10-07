# `/tests` — Integration & end-to-end tests

Cross-cutting tests that exercise the system as a whole. Unit tests live beside
the code they cover: each plugin's `tests/`, `apps/force-app/*/tests/`, and the
`*.test.ts` files in `packages/force-plotting/` and `apps/force-app/web/`.

| Suite | Covers | Run with | In CI |
|---|---|---|---|
| `phase0_smoke.sh` | Repository foundation: required files and directories, `.env.example` covers compose, no tracked `.env`, compose validates | `make smoke` | yes |
| `phase1_schema.sh` | Core tables and views, seeds, code-generation functions, audit and OCC triggers, genealogy | `make schema-test` (needs `DATABASE_URL`) | yes |
| `phase6_text_to_sql.sh` | AI-readiness views and the read-only `d1_llm_readonly` role | `make ai-test` (superuser `DATABASE_URL`) | yes |
| `phase7_traceability.sh` | Recursive lineage functions | `make traceability-test` | yes |
| `phase3_api.sh` | Directus RBAC, machine-token auth, OCC and audit through the REST API | see the script header (running stack + `core/apply.sh`) | no |
| `phase4_heavy_data.sh` | Heavy-data upload pipeline end to end | `make phase4-test` (running stack + `MACHINE_TOKEN`) | no |
| `scripts/` | pytest suite for `scripts/diag`, the orchestrators, the FAST helpers and the scripts' own behaviour (legacy migration, archive indexer, FAST log clearing, `configure_all.sh`, the shell tests' assertions) | `python -m pytest tests/scripts` (deps: `scripts/requirements.txt` + `numpy scipy scikit-learn pytest`; set `DATABASE_URL` to a migrated Postgres for the DB-level tests, they skip without it) | yes (`script-tests`) |
| `ui/` | Playwright tests against the real Directus admin UI | see [`ui/README.md`](./ui/README.md) | no |

The CI jobs are in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); the
force-app suites run in `force-app-release.yml` when a release is tagged.

Notes for `tests/scripts`:

- DB-level tests (`test_migrate_legacy.py`, `test_index_archive.py`, `test_fast_qa_scripts.py`,
  `test_configure_all.py`, `test_phase7_traceability_script.py`, `test_diag_requeue_trigger.py`)
  need `DATABASE_URL` pointing at a **throwaway** migrated database (`dbmate up`; seeds are not
  needed). They roll back or clean up after themselves, but they do write. Without
  `DATABASE_URL` they skip. `test_configure_all.py` and the phase7 test also need `psql`.
- `test_phase3_api_script.py` runs `tests/phase3_api.sh` against a stub Directus (needs `jq`
  and `curl`), so the script's own assertions are checked without a stack.
- The `*_golden_exactly` tests compare the diagnostics pipeline byte-for-byte with fixtures in
  `tests/scripts/diag/fixtures`. Neighbour ties are broken deterministically
  (`spatial.knn_deterministic`), so they hold across numpy/scipy versions, but `cluster_id` and
  `glosh` come from scikit-learn's HDBSCAN, which differs between minor versions: the goldens
  match the plugin-pinned `scikit-learn==1.5.*`. Read `tests/scripts/diag/regenerate_goldens.py`
  and the provenance note in `tests/scripts/diag/conftest.py` before regenerating anything.
