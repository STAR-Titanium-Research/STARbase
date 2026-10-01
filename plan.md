# D1-Database — Implementation Plan

> A self-hosted, API-first Laboratory Information Management System (LIMS) for
> materials-science sample genealogy, dynamic manufacturing logs, nested tooling
> tracking, high-capacity data ingestion, and LLM-driven text-to-SQL querying.
>
> Requirements source of truth: [`system_requirements_specification.md`](./system_requirements_specification.md).
> This document is the *how* and *when*; the spec is the *what* and *why*.

---

## Context

The lab runs on AppSheet over flat Google Sheets, which breaks down on relational
hierarchies, programmatic high-volume ingest (10–100 GB files), scalability,
multi-user accountability, and rigid schemas. The target is a PostgreSQL-centric,
fully containerised, vendor-agnostic system, deliberately structured so a local
LLM can reliably generate SQL against it.

This is a **multi-session, multi-month build**, authored primarily by Claude with
the maintainer reviewing — so every phase produces explicit docs/ADRs and is
**resumable cold** in a later session. The plan is **staggered**: each phase is
runnable and testable, and later phases depend on earlier ones. **Foundation-first.**

---

## Decisions locked (from planning interview)

| Decision | Choice | Rationale |
|---|---|---|
| **Core engine** | **Directus** over our own Postgres schema | Free admin UI, API, RBAC, file handling → minimal code to author/maintain |
| **Lock-in stance** | **Directus is a swappable adapter; Postgres is the durable core** | Maintainer wants the option to drop Directus later without losing the system |
| **Schema ownership** | **Our versioned SQL migrations own the schema**; Directus only *introspects* | Schema + data survive a Directus removal; stays LLM-friendly |
| **Audit log** | **Postgres trigger-based** append-only `audit_logs` (not Directus revisions) | Captures direct/machine writes, immutable, survives adapter swap (spec §4) |
| **Project-specific compute** | Lives in **separate plugin containers**, never in the core | Heavy-data parsing, text-to-SQL/LLM, custom analysis, equipment integrations |
| **Core↔plugin contract** | *Deferred to Phase 3/4* — but designed Directus-agnostic | Must be reimplementable if Directus is dropped |
| **Front-end** | **Deferred** — rely on Directus admin UI + `v_` views first | Custom traceability timeline is a later phase |
| **Sequencing** | Foundation-first | Maintainer preference |
| **Deployment** | **Docker on Windows now** (Docker Desktop/WSL2), Linux-portable | Keep compose OS-agnostic |
| **Data migration** | **Later**; Sheets export received & analysed ([`docs/legacy-data-analysis.md`](./docs/legacy-data-analysis.md)) | 17 sheets mapped; informs Phase 1; import is Phase 8 |
| **License / visibility** | **Private for now**; license chosen before any public release | — |

> **Since the interview:** the front-end did not stay admin-UI-only. The Directus UI is
> extended with custom modules and interfaces ([`core/extensions/`](./core/extensions/)), and
> machining force capture became its own desktop app (ADR-0010).

---

## North-star architecture

```
                    ┌─────────────────────────────────────────┐
   Humans  ───────► │  DIRECTUS  (swappable adapter)           │
   (browser)        │  admin UI · REST/GraphQL · RBAC          │
                    └───────────────┬─────────────────────────┘
   Machines ──────► (static token)  │ introspects, never mutates structure
   (MATLAB/rigs)                    ▼
                    ┌─────────────────────────────────────────┐
                    │  POSTGRESQL  ── THE DURABLE CORE         │
                    │  our migrations · FK constraints ·       │
                    │  COMMENTs · v_ views · audit triggers ·  │
                    │  OCC version cols · pgvector             │
                    └───────────────┬─────────────────────────┘
                                    │  documented API contract + queue + MinIO
        ┌───────────────┬──────────┴───────────┬───────────────────┐
        ▼               ▼                       ▼                   ▼
  PLUGIN: heavy-   PLUGIN: text-to-       PLUGIN: custom      PLUGIN: equipment
  data worker      SQL / LLM (Ollama,     analysis logic      integrations
  (memmap parse)   pgvector)              (per-project)       (MATLAB/rig adapters)
```

**The rule that prevents lock-in:** no business logic that the system *depends
on* lives in Directus config. Constraints, audit, concurrency, derived views,
and as much RBAC as practical are native Postgres objects. Directus is presentation.

---

## Guiding principles (apply to every phase)

- **Postgres is the contract.** Descriptive names, units in column names, FK
  constraints, `COMMENT` strings, and `v_` views are the product backbone and
  the thing the LLM reads. We hand-design it; no framework auto-generates it.
- **Adapter-swappable.** At any phase we could, in principle, replace Directus
  with a thin FastAPI layer over the *same* schema. We don't build that now, but
  we never take a dependency that would forbid it.
- **Everything is infrastructure-as-code.** One `docker compose up` from a clean
  machine to a running stack.
- **Migrations only.** No manual DB edits; every change is a reviewed, reversible
  migration. Directus must not auto-alter structure.
- **Resumable docs.** Each phase leaves an ADR + runbook so a future cold session
  (or reviewer) has full context.
- **Vertical, testable phases.** Each phase ships something demoable.

---

## Phase 0 — Repository & Project Foundation
*Goal: a professional, reproducible, private repo skeleton. No business logic.*

- Initial commit; `.gitignore` (Python, Node, Docker, OS, `.env`/secrets),
  `.editorconfig`. **No `LICENSE` yet** (private); add a brief proprietary notice.
- `README.md` (vision, the north-star diagram, quick-start, status).
- `docs/adr/` — ADRs for the locked decisions above (ADR-0001 Postgres-as-core,
  ADR-0002 Directus-as-swappable-adapter, ADR-0003 trigger-based audit).
- `CONTRIBUTING.md`, `SECURITY.md`, `.github/` issue/PR templates, CI skeleton
  (lint + migration check on push).
- Tooling: `pre-commit` (ruff/black, sqlfluff, hadolint), Conventional Commits,
  `Makefile` for common commands.
- `docker-compose.yml` skeleton + `.env.example`.
- Repo layout stubbed:
  ```
  /db        SQL migrations, seed data, schema docs, audit triggers
  /core      Directus config-as-code (roles, collections, flows) — version-controlled
  /plugins   one folder per plugin container (worker, llm, analysis, equipment)
  /infra     compose, env templates, backup/restore scripts
  /docs      ADRs, runbooks, data-dictionary, API contract
  /tests     integration / e2e
  ```

**Done when:** clone → `make setup` → green CI on an empty pipeline.

---

## Phase 1 — Core Relational Schema (the keystone)
*Goal: the durable Postgres core — genealogy, integrity, AI-readiness, audit.*
*Input: Sheets export analysed — see [`docs/legacy-data-analysis.md`](./docs/legacy-data-analysis.md).*

Implements spec §2 + §6 together (interdependent). Entity design is now grounded
in the 17 real sheets, not assumptions.

- Migration tooling: `dbmate`/`sqitch`/Flyway (plain-SQL, Directus-independent).
- Tables with FK constraints and descriptive, unit-bearing names:
  - `raw_stock_lots` (swarf/powder/billet/chemical; inbound & remaining mass,
    supplier, grade, data sheets). **NEW** — no such ledger exists today;
    provenance is currently free-text on FAST Runs (weakest current link).
  - `manufacturing_methods`, `method_parameters` (`parameter_name`, `data_type`,
    `unit_of_measure`) — the dynamic process-template engine. Validated by the
    real data: FAST Runs vs Machining Operations share almost no columns.
  - `physical_samples` ← *Inventory*, with a **dual identifier**:
    `sample_id` (GUID/UUID) is the hidden, permanent **primary key** (all FKs
    point here); `sample_code` (e.g. `10-AA-MF-2023-06-03`) is a human-readable,
    sequential **pseudonym** — unique-constrained, deterministically generated,
    deliberately legible so a physical sample found years later is identifiable.
    **Add sample→sample genealogy** (`parent_sample_id` + `sample_composition`
    junction) — the real `Parent`/`Contains`/`Contains_All` columns show discs
    cut into child pieces.
  - `manufacturing_operations` (FKs + `recorded_metadata JSONB`) ← unifies
    *FAST Runs* + *Machining Operations*; optional `insert_edge_id` and
    `file_storage_pointer` for ops that consume edges / produce big files.
  - Nested tooling: `tool_boxes` ← *Insert Boxes Inventory* → `cutting_inserts`
    ← *Inserts* → `insert_edges` ← *Inserts Edges* (3 levels confirmed exact).
  - `test_sessions` (UUID, FKs incl. `insert_edge_id`, `file_storage_pointer`).
  - `projects` / campaigns (e.g. `AI4340`) ← experiment sheets roll up to a
    project with controlled-document numbering (AMRC GESS). **NEW** grouping
    above operations — see [`docs/experiment-sheets-and-naming.md`](./docs/experiment-sheets-and-naming.md).
  - Reference/lookup tables: `materials`/`alloys` (← *Alloy Codes*), `equipment`
    (← *Machines*), `tools`, `insert_types`, ISO material classification.
  - Sample ↔ raw-stock provenance (many-to-many).
  - Capture provenance on operations that produce files: capture software +
    version (`ABFP`) and sampling frequency [kHz] — needed to read files later.
  - NC programs (G-code) as text/file artifacts linked to operations.
  - **Shared deterministic code-generation service** (one place): produces the
    compositional human-readable IDs — `sample_code`
    (`{seq}-{alloy}-{method}-{date}`), pass code (`…-F9`/`…-R1`), and force-file
    ID (`…-20MPM_0.05feed_0.1DoC`). All are projections of FK + parameter data,
    never primary keys. Dual identity also applies to inserts/edges (`H13A-#2-fC`).
  - **Honour `Export Controlled?`** flags in the visibility/RBAC model (potential
    ITAR/ECJU concern) — carry the flag from day one.
- **AI-readiness from day one:** `COMMENT ON TABLE/COLUMN` everywhere (the
  semantic dictionary); native FKs for a coherent `information_schema`; `v_*`
  flattened views (e.g. `v_complete_sample_history`).
- **Audit & concurrency (native):** append-only `audit_logs` + generic trigger
  capturing `INSERT/UPDATE/DELETE` JSON deltas; `version`/`updated_at` for OCC.
- **JSONB-vs-LLM resolution:** core entities/relationships stay typed+FK; JSONB
  only for genuinely variable method params; document the JSONB key space in the
  dictionary and surface it via views. (ADR-0004 — since superseded: method and
  test parameters became typed columns and `method_parameters` was dropped in
  June 2026; see the ADR's update.)
- `pgvector` extension enabled (columns added in Phase 6).
- Seed/fixture data + schema-diagram docs (`tbls`/`schemaspy`).

**Done when:** migrations apply up/down cleanly; seed loads; audit triggers fire;
generated schema docs render the relationships.

---

## Phase 2 — Infrastructure & Orchestration
*Goal: the whole stack runs from one compose file with persistent volumes.*

Implements spec §7.

- `docker-compose.yml`: PostgreSQL 15+ (with pgvector), MinIO (+console), Redis,
  Directus, reverse proxy. Healthchecks, named volumes, restart policies.
- Windows/Docker-Desktop notes; keep compose Linux-portable.
- Centralised `.env` config + documented secrets model.
- MinIO bucket bootstrap + retention policy.
- **Backup & restore:** scripted `pg_dump` + MinIO mirror; a *tested* restore
  runbook in `docs/runbooks/`. (Schema is plain SQL, so backups are adapter-free.)

**Done when:** `docker compose up` on a clean host → healthy stack; backup → wipe
→ restore reproduces state.

---

## Phase 3 — Core Tracking Layer (Directus) + API Contract
*Goal: authenticated, role-aware tracking over the schema, with OCC + audit intact.*

Implements spec §4 and the §2 dynamic-template UX. **Config-as-code in `/core`.**

- Point Directus at the existing schema (introspect, do **not** let it alter
  structure). Configure collections, relations, and the dynamic-template forms.
- RBAC roles `Operator` / `Researcher` / `Administrator`; document the mapping so
  it's reproducible (and re-implementable if Directus is dropped).
- Machine nodes: revocable **static tokens** as machine users
  (`Rig_1_Fast_Sampling_Node`) — also the auth path for plugins/equipment.
- Surface `GET /items/samples/{id}` full profile (the MATLAB pre-test query, §3).
- Verify OCC rejects stale writes; verify every mutation hits `audit_logs`.
- **Publish the documented API contract** in `/docs` — the Directus-agnostic
  interface plugins will use (so a FastAPI swap stays feasible).

**Done when:** a machine token authenticates, fetches a sample, logs an
operation; a stale update is rejected; the mutation appears in `audit_logs`;
Directus config is reproducible from version control.

---

## Phase 4 — Heavy-Data Pipeline (first plugin) ✅ Done
*Goal: 10–100 GB files move without touching the core's memory. Establishes the plugin pattern.*

Implemented: `plugins/heavy-data-worker/` — Flask webhook receiver + rq worker
container. D1F binary format (64-byte header + float32 row-major); streaming
stats (chunked reads, ≤ `WORKER_MEMORY_LIMIT_MB` peak); strided-read SVG plotter
(≤ 10 k points); MinIO multipart presign/complete API; Directus PATCH write-back.
Plugin contract documented in `docs/plugin-contract.md`; ADR in
`docs/adr/0006-heavy-data-pipeline.md`; runbook in
`docs/runbooks/heavy-data-pipeline.md`. CI adds a `worker-build` job (docker
build + pytest). Integration test at `tests/phase4_heavy_data.sh`.

---

## Phase 5 — Plugin Framework: Analysis & Equipment ✅ Done
*Goal: generalise Phase 4's contract into a reusable plugin template.*

Implemented: `plugins/plugin-template/` — canonical scaffold (Flask webhook,
rq job stub, directus_client, minio_client, pytest suite, README authoring guide).
`plugins/analysis-worker/` — second non-trivial plugin derived from template:
FFT amplitude spectrum, dominant frequencies, RMS, peak force, band energy per
channel on D1F files; renders spectrum SVG; writes `fft_analysis` into
`summary_stats` via Directus PATCH. ADR-0007 in
`docs/adr/0007-plugin-framework.md`. CI adds `analysis-build` job.

---

## Phase 6 — AI-Readiness & Local Text-to-SQL (plugin) ✅ Done
*Goal: a local LLM answers NL questions against the DB safely.*

Implements spec §6 (parts not already in Phase 1). Implemented as a two-layer
safety boundary (ADR-0009): an application SQL guard plus a read-only Postgres
role, with the durable half living in the core so the Phase 9 FastAPI drill
inherits it.

- `v_schema_dictionary` (table/column `COMMENT`s as a queryable view) +
  `v_llm_query_targets` (allow-list menu) — the LLM prompt is built from the live
  schema, no second copy. Migration `…0015_ai_readiness.sql`.
- Guarded text-to-SQL plugin `plugins/llm-text-to-sql/`: **sqlglot** AST
  validation (single read-only SELECT, allow-listed `v_*` views only, enforced
  LIMIT) → executed only through the **read-only `d1_llm_readonly` role**
  (SELECT on views only, `default_transaction_read_only`, statement timeout).
- Local **Ollama** (Llama-3/Mistral) in an opt-in `llm` compose profile.
- `pgvector`: `semantic_embeddings` (HNSW cosine) + `v_embeddings_source_notes`;
  incremental backfill + `/api/search` hybrid semantic search.
- NL→SQL evaluation set (`eval/questions.json`) with offline (guard) + live
  harness; `tests/test_eval_golds.py` keeps the gold set honest in CI.

**Done when:** a curated question set returns correct SQL against a read-only
role. ✅ Guard allow/deny matrix + `tests/phase6_text_to_sql.sh` (grant isolation
against a real login member of `d1_llm_readonly`) green in CI; `llm-build` job
builds the image and runs the unit/eval tests.

---

## Phase 7 — Traceability ✅ Done
*Goal: bi-directional cradle-to-grave navigation. Spec §5.*

Implemented as recursive PostgreSQL functions (ADR-0008), keeping the traversal
logic in the durable core so Directus, ad-hoc SQL, plugins, and the Phase 6 LLM
all share one correct implementation — rather than building a throwaway
front-end (the visual timeline remains deferred; we lean on Directus relational
browsing over the `v_*` views for now).

- `f_trace_ancestors` / `f_trace_descendants` — recursive, cycle-guarded
  genealogy walks (reverse / forward).
- `f_trace_stock_origins` — closes the cradle end: raw stock lots feeding a
  sample or any ancestor (reverse: file/session → sample → stock).
- `f_sample_timeline` — chronological manufacturing operations + test sessions.
- Migration `db/migrations/...0014_traceability.sql`, ADR-0008,
  `docs/runbooks/traceability.md`, integration test
  `tests/phase7_traceability.sh` wired into the CI `migrations` job.

**Done when:** any sample's full lineage is walkable forward and backward without
dead ends. ✅ Verified by phase7 test (BILLET → DISC → PIECE-A/B fixture).

---

## Phase 8 — Legacy Data Migration ✅ Done
*Goal: import existing AppSheet/Sheets data once the schema is proven.*

Implemented as `scripts/migrate_legacy.py` — a standalone Python ETL that reads
`Sample_Data.xlsx` (the AppSheet/Sheets export) and loads all entities in
FK-dependency order. Safe to re-run (idempotent via ON CONFLICT DO NOTHING).
Provenance recorded in every row's `notes` / `outcome_notes` field.

Entities migrated (850 rows from 17 sheets):
- `alloying_elements` (117), `materials` (36), `equipment` (6), `tools` (18),
  `insert_types` (23), `manufacturing_methods` (17) + FAST/Turning param templates.
- `tool_boxes` (19 + 1 synthetic), `cutting_inserts` (178), `insert_edges` (152).
- `physical_samples` (138), `sample_genealogy` (32), `manufacturing_operations` (113).

Known gaps (documented in reconciliation report):
- 1 407 FAST Runs have no sample link (NOT NULL FK) → skipped + flagged.
- 11 Machining Ops with `Workpiece ID = #N/A` (template rows) → skipped.
- Legacy insert-edge codes pre-date the inventory → stored in JSONB metadata.
- No raw stock ledger in legacy data → `sample_stock_provenance` empty.

**Run:** `make migrate-legacy XLSX=/path/to/Sample_Data.xlsx`

**Done when:** legacy data loads with a validated reconciliation report.

---

## Phase 9 — Hardening, Security, Ops & the "Drop-Directus" Drill
*Goal: production confidence + proof the lock-in escape hatch is real.*

- Tests: unit, integration, e2e across the §3 pipeline.
- Security: token revocation, RBAC boundaries, MinIO policy, **text-to-SQL
  injection surface**, dependency scanning.
- Performance: large-file pipeline load tests; index tuning.
- Observability: structured logs, health/metrics.
- **Drop-Directus drill:** stand up a minimal FastAPI read API over the *same*
  schema to *prove* the core is adapter-independent (validation, not a migration).
- Docs pass: runbooks, data dictionary, ADRs current.

**Done when:** a new operator can deploy, back up, restore, and operate from docs
alone; the drop-Directus drill succeeds.

---

## Open / deferred decisions (revisit at the noted phase)

- ~~**Core↔plugin contract specifics**~~ — **Resolved in Phase 4:**
  [`docs/plugin-contract.md`](./docs/plugin-contract.md), Directus-agnostic (ADR-0006).
- ~~**RBAC durability**~~ — **Resolved in Phase 3 (ADR-0005):** Directus roles,
  documented by intent so they can be re-implemented; audit, OCC and constraints
  stay native Postgres. Project and export-control row filters are deferred to Phase 9.
- ~~**Queue**~~ — **Resolved in Phase 4:** Redis + rq (ADR-0006).
- **License** — before any public release. Still open.
- ~~**Sample identifier**~~ — **Resolved in Phase 1:** a hidden UUID primary key
  plus the human-readable `sample_code` ([`docs/data-dictionary.md`](./docs/data-dictionary.md)).

---

## Status tracker

| Phase | Status | Notes |
|------:|--------|-------|
| 0 | ✅ Done | Repo foundation — structure, ADRs, tooling, CI, smoke test (48 checks green) |
| 1 | ✅ Done | Postgres core — 13 migrations, 6 views, audit+OCC triggers, code-gen functions, seeds, ADR-0004, data-dictionary, CI migrations job. Migration 0013 unifies the test_sessions.status vocabulary |
| 2 | ✅ Done | Compose stack — healthchecks, restart policies, Caddy proxy, MinIO bootstrap, backup/restore scripts + runbook |
| 3 | ✅ Done | Directus RBAC (3 roles, machine tokens), API contract doc, ADR-0005, phase3 test script, core/apply.sh config-as-code. Actor-identity hook (core/extensions/actor-identity) now sets d1.actor_identity in-transaction so API writes are audited |
| 4 | ✅ Done | Heavy-data pipeline — D1F worker, presigned multipart upload, streaming stats, SVG plots, plugin-contract doc, CI worker-build job. Hardened: truncation-safe stats, header validation, webhook shared-secret auth, object-key/size validation, read-merge-write to avoid clobbering |
| 5 | ✅ Done | Plugin framework — plugin-template scaffold + analysis-worker (FFT/spectrum), ADR-0007, CI analysis-build job. Same status/merge/auth hardening as Phase 4 |
| 6 | ✅ Done | Text-to-SQL + pgvector — guarded NL→SQL plugin (sqlglot allow-list + read-only `d1_llm_readonly` role), `v_schema_dictionary`/`v_llm_query_targets` semantic dictionary, `semantic_embeddings` (pgvector HNSW) + hybrid search, NL→SQL eval set, ADR-0009, runbook, migration 0015, phase6 test wired into CI + `llm-build` job. Ollama in opt-in `llm` compose profile |
| 7 | ✅ Done | Traceability — recursive cradle-to-grave lineage functions (f_trace_ancestors/descendants/stock_origins/sample_timeline), migration 0014, ADR-0008, runbook, phase7 test wired into CI. Visual timeline UI deferred |
| 8 | ✅ Done | Legacy migration — `scripts/migrate_legacy.py` loads 850 rows (alloying elements, materials, equipment, tools, insert hierarchy, samples, genealogy, operations) from Sample_Data.xlsx. Idempotent. 1 407 unlinked FAST Runs flagged in reconciliation report. |
| 9 | ☐ Not started | Hardening + drop-Directus drill |

## Parallel track — force capture (machining)

The machining force-capture app grew alongside the phases above rather than inside them: a
Directus dashboard module first, then a standalone recorder + Electron desktop app sharing one
plotting package, plus a live-backup service. On top of the captured cuts sit the FRM plotting
services (Potree octrees, `filter-service`) and the Diagnostics Workbench, a recipe-driven
analysis pipeline (`scripts/diag`, `diag-service`) over the full-resolution spiral. Milling
groundwork (path models, spindle angle, the polar plot) shipped in force-app v0.1.19; the
self-describing v2.0 capture format is designed but not yet built.

- [`docs/adr/0010-force-app-extraction-and-electron-packaging.md`](./docs/adr/0010-force-app-extraction-and-electron-packaging.md) — why it was extracted and how it ships
- [`apps/force-app/README.md`](./apps/force-app/README.md) — what the app does, with screenshots
- [`docs/force-app-operations.md`](./docs/force-app-operations.md) — running, deploying, troubleshooting
- [`docs/force-file-standards.md`](./docs/force-file-standards.md) — the four `.mat` layouts in the archive
- [`docs/superpowers/README.md`](./docs/superpowers/README.md) — the per-feature design specs
  (FRM viewer, octrees and filtering, recording slices, NI-DAQ channel model, desktop packaging,
  replay, diagnostics phases, milling) and whether each has shipped

Separately, the FAST 25 / FAST 250 **sintering** data is described in
[`docs/FAST25_OVERVIEW.md`](./docs/FAST25_OVERVIEW.md): the machines' data formats, and what was
built on them (importers, `fast_run_data`, `fast_recipes`, the `d1-fast-dashboard` module). It is
deliberately kept apart from machining force analysis.

## After Phase 8 — the schema keeps moving

Phase 8 landed on 2026-06-19 with 15 migrations. Around a hundred more have followed — people,
facilities and polymorphic test subjects
([spec](./docs/superpowers/specs/2026-07-03-lab-data-model-and-ux.md)), campaigns, sample
preparation, archive file links, FAST run data, and the force-analysis and diagnostics tables. The
phase notes above describe how the core was built; [`db/migrations/`](./db/migrations/) is the
authoritative account of what it is now.
