# surface-scan-worker

Renders a topography scan (Alicona `.al3d`, or any format [SurfaceTopography](https://pypi.org/project/SurfaceTopography/)
reads, MIT) of a cutting insert or an insert edge into a decimated height grid and a thumbnail in MinIO,
for the STARbase 3D viewer. Design: `docs/superpowers/specs/2026-10-15-surface-scans-design.md`;
decision: ADR-0021; operations: `docs/runbooks/surface-scan-worker.md`.

Scaffolded from `plugins/plugin-template` (webhook + rq worker, `check_secret`, fail-closed secret),
with `heavy-data-worker`'s OCC write pattern.

## Contract

Row (`surface_scans`, owned by the server stream): the worker picks `render_status = 'pending'` rows,
sets `rendering`, and writes only `render_status`, `render_error`, `rendered_at`, `cache_key`,
`source_format`, `source_width/height`, `grid_width/height`, `pixel_pitch_x/y_um`, `z_min/max_um`.

MinIO, `surface-scans/<cache_key>/`:

| Object | Layout |
|---|---|
| `grid.bin` | float32 little-endian, row-major, top row first, micrometres, `NaN` = no data; at most 1024 cells on the longer side (NaN-aware block mean, one block size for both axes) |
| `meta.json` | `width, height, pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um, source_width, source_height, source_format, decimation` (written last) |
| `thumb.png` | height map in a perceptual ramp, at most 320 px, no-data transparent |

Cache key: the crawler's `file_fingerprints.content_sha256` when its status is `done` and its size matches
the file, else `p-<directus_files_id>-<size>-<mtime>`. **The worker never hashes a file and never writes
`file_fingerprints`** (it only reads one row of it).

## Safety rules (each has a test)

- The archive is mounted `:ro`; the only `open` of a scan file is `archive.open_readonly` (`'rb'`).
- `archive_path` must be a clean relative path that resolves, after symlinks, inside `ARCHIVE_ROOT`,
  which must be inside `ARCHIVE_MOUNT`.
- Only extensions of SurfaceTopography readers are opened, minus `archive.NOT_TOPOGRAPHY` (`mat`, `txt`,
  `csv`, `dat`, `xlsx`, `zip`, `nc`); documents are never opened.
- A file with no stated length unit, or that is not a 2D uniform height map, is refused, not guessed.

## Layout

```
app/webhook.py        POST /api/webhook/scan (Directus Flow), GET /health
app/poller.py         polls for pending rows; fails stuck 'rendering' rows
app/queueing.py       one job per scan id, no duplicates while queued or running
app/jobs/render_scan.py   the job: claim, resolve, key, cache check, read, write, finish
app/lib/archive.py    path and extension refusal, the read-only open
app/lib/topography.py SurfaceTopography -> micrometre (rows, cols) array, top row first
app/lib/grid.py       decimation, grid.bin / meta.json / thumb.png
app/lib/cache_key.py  the key and the object names
app/lib/directus_client.py, minio_client.py
tests/synthetic.py    writes small .al3d files; no real data is committed
```

## Tests

```sh
pip install -r requirements.txt && python -m pytest tests/
```

(or `make surface-scan-test`, which builds the image first). Tests use synthetic `.al3d` files and fakes for
Directus and MinIO. Not covered by CI: a real `.al3d` from the share and a real MinIO (see
`docs/runbooks/physical-test-backlog.md`).
