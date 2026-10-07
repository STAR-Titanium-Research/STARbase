# Runbook — Cradle-to-Grave Traceability

How to walk a sample's full lineage forward and backward. The traversal logic
lives in PostgreSQL functions (ADR-0008), so it works from `psql`, the Directus
SQL console, any plugin, and the Phase 6 LLM query layer.

## The functions

| Function | Direction | Returns |
|----------|-----------|---------|
| `f_trace_ancestors(sample_id)` | backward (child → parent) | every ancestor, once; depth 0 = the sample itself |
| `f_trace_descendants(sample_id)` | forward (parent → child) | every descendant, once; depth 0 = the sample itself |
| `f_trace_stock_origins(sample_id)` | cradle | raw stock lots feeding the sample or any ancestor |
| `f_sample_timeline(sample_id)` | events | manufacturing operations + test sessions, by date |

All are `STABLE`, read-only, and cycle-safe (bad genealogy data cannot hang
the query).

**One row per sample, shortest path.** `f_trace_ancestors` and
`f_trace_descendants` walk the genealogy breadth-first and return each reachable
sample exactly once, at its minimum depth. `path` is one shortest route from the
starting sample (the starting sample first), and `relationship_type` / `fraction`
are those of the edge that reached the sample on that route. If several routes
have the same length, the step before each sample is the lowest `sample_id` among
the samples one level nearer that link to it, so results are repeatable. A sample
with two parents that share a grandparent therefore lists the grandparent once, at
depth 2; the other route is not listed (query `sample_genealogy` for the edges
between the returned samples if you need every link). Before migration 20261006000136 these
functions listed one row per route, so diamond-shaped genealogies grew
exponentially (a 24-level ladder took over two minutes); a 30-level ladder now
takes milliseconds. `f_trace_stock_origins` builds on `f_trace_ancestors`, so it
lists each (ancestor, lot) pair once. Each call runs a few queries per level
(about 1 ms for a small genealogy), so do not call the functions once per row over
thousands of samples, e.g. in a `LATERAL` join; walk `sample_genealogy` or
`v_sample_genealogy_flat` instead. `sample_genealogy` is indexed on both columns
(the parent side since migration 20261006000137).

## Resolving a sample by its human code

The functions take the UUID `sample_id`. Look it up from the readable
`sample_code` first:

```sql
SELECT sample_id FROM physical_samples WHERE sample_code = '10-AA-MF-2023-06-03';
```

Or inline it:

```sql
SELECT * FROM f_trace_ancestors(
    (SELECT sample_id FROM physical_samples WHERE sample_code = '10-AA-MF-2023-06-03')
);
```

## Reverse traceability (where did this come from?)

```sql
-- Full ancestry, nearest first:
SELECT depth, sample_code, relationship_type, fraction
FROM f_trace_ancestors(:sample_id)
ORDER BY depth;

-- The originating raw material (cradle):
SELECT via_sample_code, depth, lot_code, stock_type, supplier_name, mass_used_grams
FROM f_trace_stock_origins(:sample_id);
```

Use this for a force file / test session: resolve the session's `sample_id`,
then walk ancestors to the stock lot. Combine with `v_test_sessions_full` (which
already joins insert edge → insert → tool box) for the full reverse chain
*test → tooling* and *test → sample → stock*.

## Forward traceability (what was made from this?)

```sql
-- Everything cut/derived from a stock billet or parent sample:
SELECT depth, sample_code, relationship_type
FROM f_trace_descendants(:sample_id)
ORDER BY depth, sample_code;

-- All events on a sample and its descendants:
SELECT d.sample_code, t.*
FROM f_trace_descendants(:sample_id) AS d
CROSS JOIN LATERAL f_sample_timeline(d.sample_id) AS t
ORDER BY t.event_date;
```

## Chronological timeline for one sample

```sql
SELECT event_date, event_type, label, detail
FROM f_sample_timeline(:sample_id);
```

`event_type` is `manufacturing_operation` or `test_session`; `detail` is a JSONB
blob with type-specific fields (method/operator, or status/file pointer).

## Verifying after a deploy

```bash
make traceability-test          # needs DATABASE_URL or a running stack
# or directly:
DATABASE_URL=postgres://d1:pw@localhost:5432/d1_database \
  bash tests/phase7_traceability.sh
```

The test builds an isolated `BILLET → DISC → PIECE-A/B` fixture and asserts
ancestors, descendants, stock origins, and timeline all resolve correctly. It
also runs in CI in the `migrations` job after the schema is applied and seeded.

## Notes & limits

- There is no graphical timeline yet (the front-end is deferred). Navigate via
  Directus relational browsing or these functions. A dedicated visual
  cradle-to-grave UI is optional future work that would consume these functions.
- Genealogy edges come from `sample_genealogy`; if a lineage looks incomplete,
  the missing link is a missing `sample_genealogy` row, not a function bug.
