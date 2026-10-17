# ADR-0021 — Surface scans belong to inserts and edges, not to Tests; rendered by a read-only worker

- **Status:** Proposed (2026-10-15)
- **Date:** 2026-10-15
- **Deciders:** Maintainer + Claude (design interview,
  [spec](../superpowers/specs/2026-10-15-surface-scans-design.md))

## Context

Topography scans (Alicona `.al3d` and similar) of a cutting insert or edge were filed as Tests whose subject is
the edge (`test_sessions_subject`), which mixed tool wear inspection with characterisation of samples. The
scan files sit on the read-only archive share and could only be downloaded. A sibling design (a crawler that
finds new files on the share) needs somewhere to put a scan, and must not own rendering.

## Decision

1. **A surface scan is its own record** (`surface_scans`) on exactly one cutting insert or insert edge, with a
   condition and an optional operation. Alicona Tests on samples stay Tests.
2. **A worker renders it.** `plugins/surface-scan-worker` reads the file from the existing read-only
   `/mnt/archive` mount with SurfaceTopography and writes a decimated height grid, its metadata and a
   thumbnail to MinIO. Browsers get them only through the `d1-surface-scan` Directus endpoint, which checks
   the caller can read the scan. STARbase draws the grid in three.js with the GPU doing the shading.
3. **The crawler owns file hashes** (`file_fingerprints`); the worker only reads one as its cache key, with a
   provisional key when there is none. Neither session writes the other's tables.
4. **Scans are visible lab-wide**, like inserts and edges (ADR-0011 reference data).

## Alternatives considered

- **Keep scans as Tests and fix the labelling.** Rejected: the problem is the model, not the label; an edge is
  the thing measured, not a sample under test.
- **Parse `.al3d` in the browser.** Rejected: files run to hundreds of MB and the browser must not reach the
  share.
- **Worker hashes the file while it reads it.** Rejected by the maintainer in favour of one hash writer, the
  crawler.
- **Compute Sa/Sz from the raw grid.** Rejected for v1: it would not match Alicona's filtered values.

## Consequences

- A new compute service (the worker), a new Directus extension, a new table and a MinIO prefix to run.
- A scan the crawler never saw has no content hash; its cache key can go stale if the file is overwritten in
  place (path, size or mtime change gives a new key).
- Adding a scan publishes a file from someone's personal folder to every lab member; the UI says so.
- The old edge-subject Alicona Tests still exist until a later, guarded migration.
- A pointer row's `archive_path` is editable by every Lab Member, so the worker renders a file only when its id
  equals the id derived from that path (`uuid5` of `file:<path>`, the indexer's and the crawler's rule); a
  repointed row is refused (found by the crawler session's review of this feature).
