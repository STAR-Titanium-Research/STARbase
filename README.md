# D1-Database

A self-hosted, API-first **Laboratory Information Management System (LIMS)** for
materials-science research: sample genealogy, dynamic manufacturing/test logs,
deeply nested tooling tracking, high-capacity (10–100 GB) data ingestion, and
LLM-driven natural-language querying — replacing a brittle AppSheet-over-Google-
Sheets setup.

> **Status:** 🚧 Active build — Phases 0–8 complete (core schema, infra,
> Directus RBAC, heavy-data pipeline, plugin framework, local text-to-SQL,
> traceability, and legacy data migration); Phase 9 (hardening and the
> drop-Directus drill) remains. The machining force-capture app runs in
> production alongside it. Private & proprietary — see [`NOTICE.md`](./NOTICE.md).
> Multi-phase build; see [`plan.md`](./plan.md).

## Why

The lab outgrew spreadsheets: no real relational hierarchies, no way to ingest
multi-gigabyte instrument files, weak provenance, no audit trail, and rigid
hardcoded columns. The full problem statement is in
[`system_requirements_specification.md`](./system_requirements_specification.md).

## Architecture at a glance

**Postgres is the durable core; Directus is a swappable adapter.** All logic the
system depends on (schema, constraints, audit, concurrency, views) lives in the
database as native objects; Directus only provides UI/API/RBAC on top and can be
replaced without losing the system. Project-specific compute lives in isolated
plugin containers.

```
   Humans  ───────►  DIRECTUS  (swappable adapter: admin UI · REST/GraphQL · RBAC)
   Machines ──────►  └─ introspects, never mutates structure ─┐
   (MATLAB/ABFP)                                               ▼
                     POSTGRESQL ── THE DURABLE CORE
                     migrations · FK · COMMENTs · v_ views · audit triggers ·
                     OCC version cols · pgvector
                                     │  documented API contract + queue + MinIO
        ┌────────────────┬──────────┴───────────┬────────────────────┐
        ▼                ▼                        ▼                    ▼
   heavy-data       text-to-SQL /            custom analysis      equipment
   worker           LLM (Ollama)             (per-project)        integrations
```

See [`docs/adr/`](./docs/adr/) for the decisions behind this and
[`plan.md`](./plan.md) for the staggered, phase-by-phase roadmap.

## Repository layout

| Path | Contents |
|---|---|
| [`db/`](./db/) | SQL migrations, seeds — the schema (the contract) |
| [`core/`](./core/) | Directus configuration-as-code: roles, permissions, extensions |
| [`plugins/`](./plugins/) | Project-specific compute, one container per folder |
| [`scripts/`](./scripts/) | Host-side orchestrators, Directus config SQL, data import and MATLAB processing |
| [`apps/`](./apps/) | Operator-facing applications — currently [`force-app/`](./apps/force-app/), the machining force-capture desktop app |
| [`packages/`](./packages/) | Shared front-end libraries (e.g. `force-plotting` — the force cloud, polar plot, diagnostics workbench) |
| [`infra/`](./infra/) | Caddy proxy config, backup/restore scripts (the compose file and `.env.example` sit at the root) |
| [`docs/`](./docs/) | the wiki, ADRs, runbooks, data dictionary, feature designs, legacy-data analysis |
| [`tests/`](./tests/) | Integration & end-to-end tests |

## Quick start

```sh
cp .env.example .env      # then edit secrets
make setup                # install pre-commit hooks & dev tooling
make up                   # bring up the core Docker stack
make migrate seed         # apply schema migrations + reference seed data
# Then apply the Directus configuration — see core/README.md
# Optional: local text-to-SQL (heavy — pulls Ollama + models; see the runbook)
docker compose --profile llm up -d
```

Requires Docker (Desktop/WSL2 on Windows) and `pre-commit`. Run `make help` for
all targets.

> **Upgrading an existing deployment?** Do not just `git pull` and `docker compose up`: follow
> [`docs/runbooks/upgrade-2026-10-hardening.md`](./docs/runbooks/upgrade-2026-10-hardening.md)
> (new required secrets, worker Flow headers, migrations, a Directus restart).

## Tech stack

PostgreSQL 15+ (with `pgvector`) · Directus · MinIO (S3-compatible) · Redis ·
Python workers · Ollama (local LLM) · Docker Compose · Caddy. Machining force
analysis adds Vue 3 + three.js, Electron, a FastAPI recorder and MATLAB processing.

## Key documents

- [`docs/wiki/`](./docs/wiki/README.md) — **the wiki**: illustrated user and developer guides for the [Force App](./docs/wiki/force-app/README.md) and the [D1 Database](./docs/wiki/database/README.md)
- [`plan.md`](./plan.md) — the staggered implementation plan & status tracker
- [`system_requirements_specification.md`](./system_requirements_specification.md) — requirements
- [`docs/legacy-data-analysis.md`](./docs/legacy-data-analysis.md) — analysis of the legacy AppSheet/Sheets data
- [`docs/experiment-sheets-and-naming.md`](./docs/experiment-sheets-and-naming.md) — experiment sheets & deterministic naming
- [`apps/force-app/README.md`](./apps/force-app/README.md) — the machining force-capture desktop app (Record / Plot / Diagnostics Workbench), with screenshots
- [`docs/force-app-operations.md`](./docs/force-app-operations.md) — running, deploying & troubleshooting the force-capture app
- [`docs/force-file-standards.md`](./docs/force-file-standards.md) — the four force-capture `.mat` layouts
- [`docs/FAST25_OVERVIEW.md`](./docs/FAST25_OVERVIEW.md) — FAST 25 / FAST 250 sintering data architecture
- [`docs/superpowers/`](./docs/superpowers/README.md) — per-feature design specs and their status
- [`docs/adr/`](./docs/adr/) — architecture decision records · [`docs/runbooks/`](./docs/runbooks/) — operational runbooks
- [`docs/runbooks/physical-test-backlog.md`](./docs/runbooks/physical-test-backlog.md) — checks waiting for the rig or a live Directus
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md)
