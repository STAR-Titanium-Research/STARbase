# ADR-0002 — Directus is a swappable adapter

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Maintainer + Claude (planning session)

## Context

The spec offers a choice of application layer: a hand-built **FastAPI** stack or
an open-source data gateway like **Directus**. The project is authored primarily
by Claude with the maintainer reviewing, so minimising bespoke, hand-maintained
code is valuable. At the same time, the maintainer is not certain Directus is the
permanent answer and wants to avoid lock-in (see ADR-0001).

## Decision

Adopt **Directus as the core engine for the tracking domain**, running on top of
**our own** Postgres schema (it *introspects*, it does not own/alter structure).
Directus provides the admin UI, REST/GraphQL API, RBAC, and S3/MinIO file
handling — far less code to author and maintain.

**The rule that prevents lock-in:** no business logic the system depends on lives
in Directus configuration. Directus is presentation/convenience only. RBAC
mappings and any Flows are version-controlled in [`/core`](../../core/) and
documented so they could be reimplemented elsewhere.

## Consequences

- **Positive:** a professional UI/API/RBAC/audit-adjacent layer almost for free;
  fast path to a usable system; small maintained surface.
- **Negative / cost:** we must respect Directus's opinions and learn its
  extension model; custom needs (traceability timeline, dynamic-template forms)
  become Directus extensions or deferred custom UI (Phase 7).
- **Escape hatch (must stay real):** because the schema, constraints, audit,
  views, and OCC are native Postgres (ADR-0001, ADR-0003), Directus can be
  replaced by a thin FastAPI layer over the same schema. Phase 9 includes a
  "drop-Directus drill" to *prove* this remains true.
  *Narrowed 2026-10-21:* the drill covers the schema and who may read a
  record; who may change one is decided in Directus filters and hooks by
  deliberate choice, see the amendment to [ADR-0014](./0014-record-access.md).

## Alternatives considered

- **FastAPI (full custom):** maximum control, cleanest fit for the pipeline — but
  the most code to author/review; rejected as the *core* (still used for plugins).
- **Directus-only (incl. pipeline):** rejected — memory-mapped parsing of
  10–100 GB files is a poor fit for Directus Flows; that work lives in plugins.
