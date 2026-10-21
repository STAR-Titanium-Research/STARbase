# surface-scan-worker

Renders a topography scan (Alicona `.al3d`, or any format [SurfaceTopography](https://pypi.org/project/SurfaceTopography/)
reads, MIT) of a cutting insert or an insert edge into a decimated height grid and a thumbnail in MinIO,
for the STARbase 3D viewer. Design: `docs/superpowers/specs/2026-10-15-surface-scans-design.md`;
decisions: ADR-0021 and ADR-0023 (scans follow their file's owner; the result route); operations: `docs/runbooks/surface-scan-worker.md`.

Scaffolded from `plugins/plugin-template` (webhook + rq worker, `check_secret`, fail-closed secret),
with `heavy-data-worker`'s OCC write pattern.

## Contract

Row (`surface_scans`, owned by the server stream): the worker picks `render_status = 'pending'` rows and
claims them. It is a **system actor on an administrator token**, with the archive mounted `:ro` and no
database credential (ADR-0023), and it writes in exactly two ways:

1. **The claim** (`pending` to `rendering`): `PATCH /items/surface_scans/<id>?filter[version][_eq]=<version read>`
   with `{render_status: 'rendering'}` only. A stale version matches no row: another job has it, skip.
2. **The outcome**: `POST /d1-surface-scan/<id>/result` (administrators only) with the version read and the id of the file it rendered in the body,
   `{version, directus_files_id, render_status: 'done' | 'failed', render_error?, columns?}`. `columns` is `cache_key,
   source_format, source_width, source_height, grid_width, grid_height, pixel_pitch_x_um, pixel_pitch_y_um,
   z_min_um, z_max_um, rendered_at`. The route writes them, and the error, to `d1_private.surface_scan_renders`
   in one transaction with the status; the public row no longer has those columns, so **the worker never
   PATCHes `render_error` or the render columns**, and `directus_client.SCAN_FIELDS` does not read them. A `409
   VERSION_CONFLICT` (the version moved, the row is no longer `rendering`, or it now points at another file)
   re-reads the row and tries again, as `update_scan` does (up to `OCC_MAX_ATTEMPTS`, default 5); if the re-read
   row is no longer `rendering`, or its `directus_files_id` is not the file this job rendered, someone reset or
   repointed it (Render again, a new file) and the result is skipped, never overwritten: a stale job can never
   store one file's grid under another. A `done` result that cannot be
   posted fails the job (which then tries to post `failed`); a `failed` result that cannot be posted is only
   logged, and the original error is raised.

The poller fails stuck, dead and swept `rendering` rows through the same route (with the row's own file id as
read in that pass).

**Token probe.** The result route is administrators only, so before its loop the poller posts one harmless
`failed` report for the nil scan (`00000000-0000-0000-0000-000000000000`): an administrator token gets `409`,
anything else `403`. On `403` (or `401`) it logs CRITICAL, naming `SURFACE_SCAN_DIRECTUS_TOKEN` /
`WORKER_DIRECTUS_TOKEN` and the administrator requirement, and exits non-zero (the container exits with it);
`409`/`400` carry on; a connection error, `5xx` or `404` only warn.

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

- The worker has no database credential and never hashes a file; the archive is read-only. The only
  `surface_scans` write besides the claim is the result route, and `render_error` / `cache_key` are not in
  any PATCH body nor in `SCAN_FIELDS`.
- A file row's id must equal the id derived from its `archive_path` (`archive.check_identity`), so a row
  repointed at another file under the share is refused, not rendered.

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
app/lib/directus_client.py  the claim (PATCH, OCC), post_result / report_result (POST /result, retry on 409), reads
app/lib/minio_client.py
tests/synthetic.py    writes small .al3d files; no real data is committed
```

## Tests

```sh
pip install -r requirements.txt && python -m pytest tests/
```

(or `make surface-scan-test`, which builds the image first). Tests use synthetic `.al3d` files and fakes for
Directus and MinIO. Not covered by CI: a real `.al3d` from the share and a real MinIO (see
`docs/runbooks/physical-test-backlog.md`).
