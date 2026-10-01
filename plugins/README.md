# `/plugins` — Project-specific compute (separate containers)

Everything volatile and lab-specific lives here, behind a documented,
Directus-agnostic contract ([`docs/plugin-contract.md`](../docs/plugin-contract.md))
— never inside the core. One folder per container; each is a service in
[`docker-compose.yml`](../docker-compose.yml).

| Plugin | Purpose | Origin |
|---|---|---|
| `heavy-data-worker/` | Streaming parse of 10–100 GB D1F files: summary stats + SVG plots, written back to the session ([ADR-0006](../docs/adr/0006-heavy-data-pipeline.md)) | Phase 4 |
| `plugin-template/` | The scaffold new plugins are copied from — Flask webhook, rq job, Directus/MinIO clients, tests ([ADR-0007](../docs/adr/0007-plugin-framework.md)) | Phase 5 |
| `analysis-worker/` | FFT / spectrum analysis of D1F files, derived from the template | Phase 5 |
| `llm-text-to-sql/` | Guarded natural-language querying via a local Ollama model, plus pgvector semantic search ([ADR-0009](../docs/adr/0009-text-to-sql-guarded-readonly.md)); the `ollama` service is in the opt-in `llm` compose profile | Phase 6 |
| `filter-service/` | Interactive FRM signal-filter previews, served same-origin by Caddy at `/filter/*` ([design](../docs/superpowers/specs/2026-07-21-frm-filtering-suite-design.md)) | Force track |
| `diag-service/` | Diagnostics recipe previews and full-resolution viewport recomputes, served at `/diag/*`; runs the same `scripts/diag` engine as the orchestrator's bake ([design](../docs/superpowers/specs/2026-09-01-diagnostics-recipe-workbench-design.md)) | Force track |

The workers authenticate as machine users (API tokens). `filter-service` and
`diag-service` instead forward the caller's own Directus credentials, so
Directus decides what each request may read.

Each plugin keeps its unit tests beside its code (`<plugin>/tests/`). CI builds
the heavy-data, analysis and text-to-SQL images and runs their tests; run the
others locally with `pytest` from the plugin's folder.

The force-capture recorder is not a plugin: it runs next to the acquisition
hardware and lives in [`apps/force-app/`](../apps/force-app/) with its two
server-side helpers, the live-backup server and the bug-report relay (compose
services `backup-server` and `bug-report-relay`; see
[ADR-0010](../docs/adr/0010-force-app-extraction-and-electron-packaging.md)).
