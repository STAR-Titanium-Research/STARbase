# Surface scans on inserts and edges: design

Status: agreed with the maintainer in a design interview on 2026-10-15 (every decision below was confirmed
by them unless it says "default"). ADR: [0020](../../adr/0020-surface-scans-on-inserts-and-edges.md).
Plan: [`2026-10-15-surface-scans.md`](../plans/2026-10-15-surface-scans.md).

## Problem

A topography scan (Alicona `.al3d`, or any file SurfaceTopography can read) of a cutting insert or an insert
edge is filed today as a **Test** with the edge as its subject (`test_sessions_subject`), so it is mixed up
with characterisation of samples (SEM, EBSD, Alicona of a machined surface). There is also no way to look at
the scan: the file is a download link.

## Terms (go into `CONTEXT.md` after PR #310 merges, in their own section)

- **Surface scan**: one topography file of one **cutting insert** or one **insert edge**, with the
  **condition** the item was in and, optionally, the date and the **operation** that wore it. It is not a Test.
- **Condition**: `new`, `worn`, `cleaned` or `other`, plus a free note.
- Verb: **add a surface scan** (to an insert or edge). **Link** stays the verb for tying a file to a sample,
  operation or test (PR #310). Never "attach" for files.
- An Alicona Test on a **sample** surface stays a Test (`test_type = 'alicona'`).

## Decisions

1. Files live on the read-only archive share (`directus_files.storage = 'star'`, pointer rows). Nothing
   reads the share except the render worker (and the crawler of the sibling design), strictly read-only, via
   the existing `archive_share` volume at `/mnt/archive`. No second mount, no credentials, no writes.
2. A scan belongs to exactly one insert **or** one edge. An edge page also lists its insert's scans.
3. Any format SurfaceTopography reads is accepted (chosen by extension); `.al3d` first. Only `.al3d`/topography
   files are ever opened; documents never.
4. Interactive 3D viewer in STARbase: orbit, zoom, a vertical-exaggeration slider, colour by height. As much
   work as possible runs on the GPU (the height grid is a float texture; displacement, shading and colour
   are shader work). A flat PNG thumbnail comes from the same render for lists.
5. Render eagerly when a scan is added, lazily as a fallback (a "Render again" action sets it pending).
   One or two renders at a time.
6. Visibility: a scan is visible to every lab member, like inserts and edges (reference data, ADR-0011).
   The add dialog and the inbox warn that adding it makes the file visible lab-wide.
7. Hashing: the crawler (sibling design) writes `file_fingerprints.content_sha256` for scan files. The
   worker reads it as the cache key and **never hashes or writes `file_fingerprints`**. For a scan the
   crawler never saw (added from the file library) the worker uses a provisional key
   `p-<directus_files_id>-<size>-<mtime>` (default; the maintainer left the fallback to us).
8. No roughness numbers in v1 (Sa/Sz differ from Alicona's filtered values). Show only what the file
   states: size, pixel pitch, height range.
9. Existing Alicona Tests that have an edge as subject are **not** migrated in this PR. A guarded dry-run
   script and the physical-test-backlog item come later (needs real data to count).

## Row contract: `surface_scans` (the contract shared with the crawler session)

| Column | Type | Notes |
|---|---|---|
| `scan_id` | uuid pk | default `uuid_generate_v4()` |
| `insert_id` | uuid null | FK `cutting_inserts` |
| `edge_id` | uuid null | FK `insert_edges`; `CHECK (num_nonnulls(insert_id, edge_id) = 1)` |
| `directus_files_id` | uuid not null | FK `directus_files`; unique per item (`UNIQUE (insert_id, directus_files_id)`, `UNIQUE (edge_id, directus_files_id)`) |
| `condition` | text not null | `CHECK IN ('new','worn','cleaned','other')` |
| `condition_note` | text null | |
| `scanned_on` | date null | |
| `operation_id` | uuid null | FK to the operations table; the operation that wore the edge |
| `notes` | text null | |
| `render_status` | text not null default `'pending'` | `pending`, `rendering`, `done`, `failed` |
| `render_error` | text null | |
| `rendered_at` | timestamptz null | |
| `cache_key` | text null | `content_sha256` or provisional key; set by the worker |
| `source_format` | text null | reader name SurfaceTopography used |
| `source_width`, `source_height` | int null | pixels |
| `grid_width`, `grid_height` | int null | decimated grid |
| `pixel_pitch_x_um`, `pixel_pitch_y_um` | numeric null | of the grid (after decimation) |
| `z_min_um`, `z_max_um` | numeric null | |
| plus | | `created_at`, `updated_at`, `version` (OCC), `owner`, `owner_person_id` as on `insert_edges`; follow the db-migration skill |

Writes: a plain Directus create on `surface_scans` as the caller (permissions and hooks apply). The worker
fills only the `render_*`, `cache_key`, `source_*`, `grid_*`, `pixel_pitch_*`, `z_*` columns. `d1-build`
(ADR-0018) is only needed if a caller must create a pointer row and the scan in one transaction.

## Derived data (MinIO, ADR-0006)

Bucket of the heavy-data pipeline, prefix `surface-scans/<cache_key>/`:

- `grid.bin`: float32 little-endian, row-major, top row first, micrometres, `NaN` = no data. At most 1024
  cells on the longer side, decimated by NaN-aware block mean, aspect kept.
- `meta.json`: `{ width, height, pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um, source_width,
  source_height, source_format, decimation }`.
- `thumb.png`: height map, perceptual colour ramp, at most 320 px on the longer side.

Browsers never reach MinIO. The `d1-surface-scan` Directus endpoint serves them after reading the scan row
with the caller's accountability:

- `GET /d1-surface-scan/<scan_id>/grid`, `/meta`, `/thumb` (ETag = cache key, `Cache-Control: private`)
- `POST /d1-surface-scan/<scan_id>/render` sets `render_status = 'pending'` (needs update permission)

## Worker: `plugins/surface-scan-worker`

Python, SurfaceTopography (MIT). Picks up rows with `render_status = 'pending'` (webhook plus a poll as the
safety net), one or two at a time, sets `rendering`, resolves the file via
`directus_files.metadata.archive_path` under `/mnt/archive`, opens it read-only, writes the three objects,
fills the row, sets `done` (or `failed` with `render_error`). Cache hit on the key: skip the read.
Follow the `new-plugin` skill.

## STARbase (packages/starbase-pages)

- Insert and edge record pages: a **Surface scans** panel (thumbnail, condition, date, status, open) and an
  **Add a surface scan** dialog (pick a file from the library, condition, note, date, optional operation, the
  lab-wide warning). An edge page also shows its insert's scans.
- `SurfaceScanViewer`: three.js, the same conventions as the tooling stage (`pages/tooling/stage`). Grid as a
  float `DataTexture`; vertex shader displaces a plane by it; exaggeration and colour ramp are uniforms;
  `NaN` cells are discarded. Orbit and zoom only, no profile or measurement tools.
- States: rendering, failed (with a Render again button), no file readable.

## Out of scope

Sa/Sz, profile or measurement tools, SEM/EBSD of items, migrating the old edge-subject Tests, the crawler
and inbox (sibling session, PR #310 onward).

## Physical test backlog (added in the same PR)

Render a real `.al3d` from the share; check the viewer on a real GPU; count Alicona Tests with an edge as
subject (dry run) before any migration.
