# ADR-0004 — JSONB for Dynamic Method Parameters

**Status:** Superseded — parameters are now typed columns (see *Update* below)
**Date:** 2026-06-18
**Deciders:** Maintainer + Claude (planning session)
**Tags:** schema, jsonb, dynamic-template, ai-readiness

---

## Update — superseded by typed parameter columns

By 2026-06-26 the schema had moved to Approach A below, in four steps:

1. `20260621000025_process_param_tables.sql` and `…026_test_param_tables.sql` —
   typed per-process and per-test parameter tables, 1:1 with operations and
   sessions, with `recorded_metadata` kept for legacy data.
2. `20260623000031_process_category.sql` — a scalar `process_category`
   discriminator, because Directus field conditions evaluate on a scalar in the
   same collection but not on the `method_id` M2O relation.
3. `20260623000032_inline_param_fields.sql` — those tables flattened into
   prefixed inline columns on `manufacturing_operations` and `test_sessions`
   (`machining_*`, `sintering_*`, `tensile_*`, …), so the typed fields render
   directly in the form.
4. `20260626000039_drop_method_parameters.sql` — the `method_parameters`
   registry dropped as superseded.

`recorded_metadata` remains for legacy rows. The decision below is kept as the
record of the original reasoning; the change itself has no ADR of its own.

---

## Context

The system must support manufacturing methods with completely different parameter
sets (e.g. FAST/SPS Sintering uses *temperature / pressure / atmosphere / hold
time* while CNC Turning uses *cutting speed / feed rate / depth of cut / coolant
pressure*). Legacy data (17 AppSheet sheets) confirms two divergent operation
types share almost no columns — exactly the "brittle schema" pain point the spec
identifies in §2B.

Two archetypal approaches:

| Approach | Description |
|---|---|
| **A — Typed columns** | Add a column for every possible parameter across all methods. Sparse; requires schema change for each new method. |
| **B — JSONB bag** | Store method-specific parameters as key-value pairs in a single `recorded_metadata JSONB` column. Schema changes not needed for new methods. |

A hybrid variant:

| Approach | Description |
|---|---|
| **C — Hybrid** | Keep a typed `manufacturing_operations` table for the fields common to *all* methods (FKs, timestamps, operator, file pointer); use JSONB only for the method-specific payload. |

---

## Decision

**Adopt Approach C (hybrid):** all relational, FK-backed fields that apply across
methods stay typed columns in `manufacturing_operations`. Method-specific
parameters are stored in `recorded_metadata JSONB`.

The `method_parameters` table acts as a *template registry* — it documents which
JSONB keys are expected for each `method_id`, their data types, units, and
whether they are required. This gives us:

1. **Runtime validation** — the API layer (Directus / FastAPI) can validate
   incoming JSONB payloads against `method_parameters` before accepting a write.
2. **LLM discoverability** — an LLM reading `information_schema` + `COMMENT`
   strings plus the `method_parameters` table can know *exactly* what keys to
   expect in `recorded_metadata` for each method, preventing hallucinated keys.
3. **Dynamic form rendering** — the Directus Phase 3 UI reads `method_parameters`
   to build input forms without any hardcoded column references.
4. **Forward compatibility** — adding a new manufacturing method adds rows to
   `method_parameters` only; no migration needed to `manufacturing_operations`.

---

## Key JSONB fields exposed via views

`v_manufacturing_operations_full` surfaces `recorded_metadata` alongside all
typed columns. A future phase can add computed columns or generated columns for
the most commonly queried JSONB keys (e.g. `peak_temperature_celsius`) if
performance or LLM accuracy demands it.

The LLM semantic dictionary (`COMMENT ON COLUMN`) on `recorded_metadata` directs
the LLM to consult `method_parameters` to discover valid keys, rather than
guessing. Example comment text:

> *"JSONB bag of method-specific parameters. Keys are defined in
> method_parameters.parameter_name for the corresponding method_id.
> E.g. `{\"peak_temperature_celsius\": 1100, \"atmosphere\": \"Argon\"}` for FAST."*

---

## Consequences

**Good:**
- New methods require only `method_parameters` rows (data change, not schema change).
- Core typed columns remain FK-constrained, normalized, and index-friendly.
- GIN index on `recorded_metadata` supports `@>` containment queries efficiently.
- LLM has a machine-readable key dictionary via `method_parameters`.

**Accepted risks:**
- JSONB values are not type-enforced at the DB level; runtime validation must
  happen in the API/middleware layer using `method_parameters.data_type`.
- Complex aggregate queries across JSONB keys (e.g. average temperature across
  all FAST runs) are slightly more verbose than with typed columns. Mitigated by
  adding targeted `v_` views for common analytical patterns.
- If a particular JSONB key becomes a high-volume query target, it can be
  promoted to a typed generated column in a later migration without breaking
  the existing schema.

---

## Alternatives rejected

**Approach A (all typed columns):** Would require a schema migration to add a
method. With 7+ methods and divergent parameter sets, this produces a very wide,
mostly-NULL table — poor for LLMs and fragile operationally.

**EAV table (Entity-Attribute-Value):** A `method_param_values` table with one
row per parameter per operation. Relational correctness at the cost of
catastrophic query complexity. Joins become deeply nested; LLMs cannot reason
over it reliably.
