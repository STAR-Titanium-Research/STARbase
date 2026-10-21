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

Cache key: the crawler's `file_fingerprints.content_sha256` when its status is `done` and BOTH halves of
its staleness key match the file on disk (`size_bytes` and `source_mtime`, within 2 s), else
`p-<directus_files_id>-<size>-<mtime>`. A file re-exported in place with the same size therefore gets a new
key. **The worker never hashes a file and never writes `file_fingerprints`** (it reads one row of it, with a
filtered list query, so an empty list means "no fingerprint" and a 403 means "no permission").

## Safety rules (each has a test)

- The archive is mounted `:ro`; the only open of a scan file is `archive.open_readonly`:
  `os.open(O_RDONLY | O_NOFOLLOW)` on the resolved path, then `fstat` on the descriptor, which must match
  the `stat` the cache key was built from (device, inode, size, mtime) or the render fails with "changed on
  the share". SurfaceTopography reads from that descriptor's file object (it accepts file objects), never
  from the path again, so a link or file swapped in after the check cannot redirect the read.
- `archive_path` must be a clean relative path that resolves, after symlinks, inside `ARCHIVE_ROOT`,
  which must be inside `ARCHIVE_MOUNT`.
- A file below `User/<alias>` (`INBOX_PERSON_DIR`) or below a `Shared/<folder>` that a team claims
  (`teams.share_folder`) is rendered only when its `directus_files` row carries the owner stamp the crawler
  writes (`owner_person_id` / `owner_team_id`, ADR-0022). A Lab Member can create the row of a path they know
  before the crawler has seen the file, and that row passes the id check; without a stamp it is refused, also
  when a link in the archive leads into such a folder. A failed team lookup refuses a `Shared/` file. Files
  elsewhere in the archive have no owner by design and render as before.
- Only the extensions in `archive.ALLOWED_EXTENSIONS` are opened (36 topography instrument formats:
  `al3d opd opdx x3p ibw h5 datx sur plu apx plux vk3 vk4 vk6 vk7 lext zon os3d sdf frt mnt gwy mdt nms oir
  poir ezd nid bcr bcrf tmd zmg mi jpk qep spm`), intersected with the readers the installed
  SurfaceTopography has. `.tif`, `.xyz`, `.asc`, `.npy`, `.hdf5`, `.sxm`, `.mat` and every generic or text
  format are refused; so is a link whose target is of another type. STARbase's "Add a surface scan" dialog
  offers the same list; change both together.
- A file with no stated length unit, or that is not a 2D uniform height map, is refused, not guessed.
- A `rendering` row whose rq job is gone, failed or owned by a dead worker (the OOM killer usually takes
  the forked work-horse, so `except` never runs) is failed by the poller within one poll with an
  out-of-memory message; it does not wait for the timeout.

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
