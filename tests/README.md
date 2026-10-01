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
| `scripts/` | pytest suite for `scripts/diag`, the orchestrators and the FAST helpers | `python -m pytest tests/scripts` (deps: `scripts/requirements.txt` + pytest) | no |
| `ui/` | Playwright tests against the real Directus admin UI | see [`ui/README.md`](./ui/README.md) | no |

The CI jobs are in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml); the
force-app suites run in `force-app-release.yml` when a release is tagged.

Two caveats for `tests/scripts`:

- The `*_golden_exactly` tests compare the diagnostics pipeline byte-for-byte with
  fixtures frozen on the maintainer's machine, so a different numpy / scipy /
  scikit-learn build can fail them without any code change. Read
  `tests/scripts/diag/regenerate_goldens.py` before regenerating anything.
- `test_diag_requeue_trigger.py` needs a migrated Postgres at `DATABASE_URL`.
