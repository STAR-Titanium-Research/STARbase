# ADR-0007 — Plugin Framework: Shared Template and Extension Pattern

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Maintainer + Claude (Phase 5 planning)

## Context

Phase 4 delivered the first plugin container (`plugins/heavy-data-worker/`),
which establishes a concrete, working implementation of the plugin contract
(`docs/plugin-contract.md`). That contract defines the interface that any
plugin must honour: a Flask/gunicorn webhook server, an rq worker, MinIO
access via boto3, and write-back to the core via the Directus REST API using
a Bearer token.

Phase 5 and beyond require multiple additional plugins covering distinct
workloads:

- **Analysis plugins** for per-project signal processing (FFT, peak-force
  extraction, frequency-domain characterisation of D1F files).
- **Equipment integration plugins** for acquisition adapters (MATLAB ABFP
  instrument bridges).
- **LLM plugins** for natural-language querying (Phase 6, `plugins/llm-text-to-sql/`).

Without a template, each new plugin author must reconstruct the boilerplate
from scratch: Dockerfile, gunicorn entrypoint, rq worker invocation, health
endpoint, error write-back, environment variable wiring. Reconstructed
boilerplate drifts — silently and in ways that violate the contract (e.g.,
blocking inside the webhook handler, not writing `status = failed` on failure,
hard-coding the bucket name). Drift is invisible until it causes an operational
incident.

At the same time, the job logic itself (the code that processes a file and
produces results) is intentionally plugin-specific. No single abstraction can
encapsulate both the shared scaffold and the unique job logic without imposing
an awkward inheritance structure that is harder to read than a flat copy.

## Decision

A canonical plugin scaffold is maintained at `plugins/plugin-template/`. Each
new plugin is created by copying the template directory to
`plugins/<plugin-name>/` and adapting only the job logic in `app/jobs/`. The
shared contract — authentication pattern, queue semantics, webhook protocol,
write-back shape, health endpoint — is never re-implemented. It is defined once
in `docs/plugin-contract.md` and demonstrated once in
`plugins/heavy-data-worker/`.

The template ships with:

- A `Dockerfile` and `requirements.txt` that install the baseline dependencies
  (Flask, gunicorn, rq, boto3, requests) plus a placeholder for job-specific
  additions.
- An `entrypoint.sh` that starts gunicorn and the rq worker in parallel with
  correct signal trapping, parameterised by environment variables.
- An `app/webhook.py` with the `/health` endpoint and `/api/webhook/session`
  handler pre-wired to enqueue into the plugin-specific queue.
- Shared library modules `app/lib/directus_client.py` and
  `app/lib/minio_client.py` that new plugins copy verbatim unless they need
  additional collections or storage operations.
- An `app/jobs/example_job.py` that shows the error-handling envelope
  (try/finally with `status = failed` write-back) and the streaming read
  pattern. Plugin authors delete this file and replace it with their job.
- A `tests/` directory with a minimal conftest and a smoke test for the health
  endpoint.

The two design rules that are not negotiable across all plugins, and are
enforced through code review against the template:

1. The webhook handler returns HTTP 202 before any processing. Synchronous
   processing inside the webhook handler is forbidden.
2. The worker writes `status = failed` with a machine-readable code and a
   human-readable message if any processing stage fails. Leaving a session in
   `processing` without a terminal write-back is not acceptable.

Two additional design rules are enforced structurally by the template layout:

3. Every plugin exposes `GET /health` returning `{ "status": "ok" }`.
4. No plugin accesses the database directly. All reads and writes go through
   the Directus REST API, using the published contract in
   `docs/plugin-contract.md`. Direct PostgreSQL connections from plugin
   containers are not permitted.

## Alternatives considered

### (a) Shared Python library (`d1-plugin-sdk`)

Package the common code (directus_client, minio_client, webhook skeleton) as a
PyPI-installable library that plugins depend on. Updates to the SDK propagate
automatically on rebuild.

Ruled out because:

- Introduces a packaging and versioning dependency that must be managed
  alongside the main repo. Plugins that pin an old SDK version receive no
  updates; plugins that do not pin can break when the SDK changes.
- The shared code is small (under 200 lines across both clients and the webhook
  skeleton). The overhead of SDK publication is not justified.
- A library cannot enforce the entrypoint pattern or the Dockerfile structure,
  which are the most common sources of contract drift.

### (b) Docker base image

Build a `d1-plugin-base` Docker image containing the runtime and shared Python
modules; concrete plugins `FROM d1-plugin-base`. Job logic is layered on top.

Ruled out because:

- Base images must be published to a registry and versioned. In a
  self-hosted, air-gapped deployment this adds infrastructure overhead.
- Layer caching behaviour is less predictable than `COPY`-based builds.
- The base image approach is appropriate at a scale of 10+ plugins; the
  projected plugin count (three to five) does not warrant it.

### (c) No template — document conventions only

Write a checklist document and trust plugin authors to follow it.

Ruled out because this is exactly the pattern that produced drift in the
plugins directory before Phase 5. A runnable, linted, CI-tested scaffold gives
a much stronger guarantee than a document.

## Consequences

### Positive

- **New plugins start from a known-good baseline.** Every plugin produced from
  the template builds and passes unit tests on day one. The contract-required
  behaviours (health endpoint, 202 on webhook, error write-back) are present
  before any job logic is written.
- **Contract updates propagate through documentation.** `docs/plugin-contract.md`
  is the single definition of the interface. Template updates reflect changes
  there; plugin authors are notified via the change history rather than
  discovering drift at runtime.
- **Each plugin is independently deployable.** The template produces a
  self-contained Docker image with no shared runtime state. Plugins can be
  built, tested, and restarted independently of each other and of the core.
- **CI coverage is pre-wired.** The template's `tests/` directory and the
  Makefile pattern from `worker-build` / `worker-test` give each new plugin a
  CI job to copy into `.github/workflows/ci.yml`.
- **Consistent operational surface.** Every plugin exposes `/health` on the
  same port convention, accepts the same environment variables, and uses the
  same Docker Compose `depends_on` pattern. Operators learn the pattern once.

### Negative / Costs

- **Template maintenance burden.** When a baseline dependency (Flask, rq,
  boto3) receives a security update, the template's `requirements.txt` must be
  updated and the change communicated to concrete plugin authors to apply to
  their copies.
- **Template can drift from concrete implementations.** Improvements made
  directly to a concrete plugin (e.g., a better streaming pattern discovered
  in `plugins/heavy-data-worker/`) are not automatically reflected in the
  template. Periodic review is required to keep the template current.
- **Copy semantics mean no automatic propagation.** Unlike the SDK alternative,
  a fix to the template does not automatically fix existing plugins. Each
  plugin must be updated manually.

## References

- ADR-0006: Direct-to-MinIO heavy-data pipeline (first plugin)
- `docs/plugin-contract.md` — the shared plugin interface
- `docs/runbooks/heavy-data-pipeline.md` — operational procedures and Directus
  Flow configuration
- `plugins/plugin-template/` — canonical scaffold (this decision)
- `plugins/heavy-data-worker/` — Phase 4 reference implementation
- `plugins/analysis-worker/` — Phase 5 analysis plugin (template in use)
- An equipment-integration plugin was planned for Phase 5 but never built as a
  container: rig acquisition lives in the force-app recorder instead (ADR-0010)
