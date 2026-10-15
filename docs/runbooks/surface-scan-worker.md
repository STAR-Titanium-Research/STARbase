# Runbook — Surface-scan render worker

**System:** D1-Database
**Scope:** `plugins/surface-scan-worker` (render pipeline for `surface_scans`), its Directus Flow, its
compose service and what to do when a scan will not render.
**Design:** [`2026-10-15-surface-scans-design.md`](../superpowers/specs/2026-10-15-surface-scans-design.md),
[ADR-0021](../adr/0021-surface-scans-on-inserts-and-edges.md).

## 1. What it does

A scan row (`surface_scans`, one cutting insert or one insert edge, with a file from the library) is
created `render_status = 'pending'`. The worker:

1. claims the row (`rendering`, under the row's `version`), so a duplicate trigger does nothing;
2. looks up the file (`GET /files/<id>`), takes `metadata.archive_path` and resolves it under
   `ARCHIVE_ROOT` (`/mnt/archive/star_group1`). It refuses anything that is not a clean relative path
   inside that root (also after symlinks) and any extension that is not a topography format
   (documents, spreadsheets, archives and force `.mat` files are never opened);
3. picks the cache key: `file_fingerprints.content_sha256` when the crawler's fingerprint for the file is
   `done` (and its size still matches), else the provisional `p-<directus_files_id>-<size>-<mtime>`.
   The worker never hashes a file and never writes `file_fingerprints`;
4. on a cache hit (all three objects already under `surface-scans/<cache_key>/`) copies the numbers from
   `meta.json` and skips reading the file; otherwise reads the file read-only with SurfaceTopography,
   block-means it (NaN-aware) to at most 1024 cells on the longer side, and writes `grid.bin`,
   `thumb.png` and then `meta.json` to MinIO;
5. fills `render_*`, `cache_key`, `source_*`, `grid_*`, `pixel_pitch_*`, `z_*` and sets `done`; any
   failure sets `failed` with `render_error` (what STARbase shows next to "Render again").

`z_min_um` / `z_max_um` are the range of the stored (decimated) grid, so they match what the viewer
draws; the grid pitch is the source pitch times the block size.

## 2. Start it

The worker mounts the SMB archive (`archive_share`, `:ro`), so it is in the same opt-in `archive`
compose profile as the indexer: a plain `docker compose up` never tries to mount the share.

```sh
docker compose --profile archive up -d --build surface-scan-worker
docker compose logs -f surface-scan-worker
```

Settings (all optional, see `.env.example`): `SURFACE_SCAN_DIRECTUS_TOKEN` (blank uses
`WORKER_DIRECTUS_TOKEN`; a machine user that can read and update `surface_scans` and read `directus_files`
and `file_fingerprints`), `SURFACE_SCAN_CONCURRENCY` (1 or 2 renders at a time, default 1),
`SURFACE_SCAN_MEMORY_LIMIT` (default 2g), `SURFACE_SCAN_POLL_SECONDS`, `SURFACE_SCAN_JOB_TIMEOUT_SECONDS`.

## 3. The Directus Flow

Same pattern as [`heavy-data-pipeline.md`](./heavy-data-pipeline.md) section 3. Create once:

- **Name:** `surface-scan-render`; **Trigger:** Event Hook, scope items, collection `surface_scans`,
  event **Create**.
- **Operation:** Webhook / Request URL, POST `http://surface-scan-worker:8080/api/webhook/scan`,
  Request Body: Include Payload, header `X-Worker-Secret: {{$env.WORKER_WEBHOOK_SECRET}}`.

The Flow is the fast path only. The worker also polls every `SURFACE_SCAN_POLL_SECONDS` for `pending`
rows, so a Flow that is missing or failed costs at most a minute, and "Render again" (which sets the
row back to `pending`) is picked up by the poll. To make it instant, add **Update** to the Flow's events:
the webhook ignores every update except one that sets `render_status` to `pending`, so the worker's own
status writes do not loop (they do add Flow log lines, which is why Create alone is the default).

## 4. When a scan does not render

| `render_error` (or symptom) | Meaning and fix |
|---|---|
| `Not a topography file format (.xyz)` | The extension is not one SurfaceTopography reads, or is deliberately excluded (`.mat`, `.txt`, `.csv`, `.dat`, `.xlsx`, `.zip`, `.nc`). Pick the scan file. |
| `The file is not on the archive share ...` | The library file is a local upload, or has no `archive_path`. Only archive files are rendered. |
| `... (moved or deleted)` | The path in the library no longer exists on the share. Re-run `make index-archive`, then Render again. |
| `The file resolves outside the archive` / `escapes the archive` | A bad `archive_path`; the worker refused it. Fix the file row. |
| `The file could not be read as al3d: ...` | The file is corrupt, truncated or not what its extension says. |
| `The file does not state its length unit` | The scale is unknown; the worker will not guess. |
| `The render was interrupted ...` | The container restarted mid-render, probably out of memory on a very large scan (see `SURFACE_SCAN_MEMORY_LIMIT`). Render again; raise the limit if it repeats. |
| `The render did not finish within the time limit` | Slow share or huge file. Raise `SURFACE_SCAN_JOB_TIMEOUT_SECONDS`. |
| Rows stay `pending` | The container is not running (it is in the `archive` profile), or the worker's token cannot read `surface_scans`. `docker compose logs surface-scan-worker`. |

To re-render by hand: set the row's `render_status` back to `pending` (the "Render again" action does
exactly this).

## 5. Cleaning up

`surface-scans/<cache_key>/` objects are derived data and can be deleted at any time; the next render
recreates them. A provisional-key prefix (`p-...`) is orphaned when the file changes (new size or
mtime gives a new key) or when the crawler later fingerprints the file (the hash key replaces it).
