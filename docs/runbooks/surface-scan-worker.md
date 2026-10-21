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
   inside that root (also after symlinks) and any extension that is not on the allowlist of 36
   topography instrument formats (`archive.ALLOWED_EXTENSIONS`, the same list STARbase's dialog offers;
   no `.tif`, `.xyz`, `.asc`, `.npy`, `.mat`, documents or text data). It opens the file
   `O_RDONLY | O_NOFOLLOW` and reads through that descriptor after checking it is the same file it
   stat-ed (a file swapped in between fails the render);
3. picks the cache key: `file_fingerprints.content_sha256` when the crawler's fingerprint for the file is
   `done` and still describes the file (`size_bytes` AND `source_mtime` match what is on the share, 2 s
   slack), else the provisional `p-<directus_files_id>-<size>-<mtime>`. A file re-exported in place gets a
   new key. The worker never hashes a file and never writes `file_fingerprints`;
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
| `Not a topography file format (.xyz)` | The extension is not on the allowlist (`archive.ALLOWED_EXTENSIONS`: Alicona and the other topography instrument formats). Generic and text formats (`.tif`, `.xyz`, `.asc`, `.npy`, `.mat`, `.txt`, `.csv`, ...) are refused on purpose. Pick the instrument file. |
| `The installed SurfaceTopography has no reader for .ext files` | An allowed extension the installed library cannot read (a library upgrade dropped it). Pin or upgrade SurfaceTopography. |
| `The file changed on the share while it was being checked` | The file was replaced or rewritten between the check and the read. Render again. |
| `The file could not be opened read-only: ... Too many levels of symbolic links` | The path is (now) a symlink; links are not followed at the last step. |
| `The file is not on the archive share ...` | The library file is a local upload, or has no `archive_path`. Only archive files are rendered. |
| `... (moved or deleted)` | The path in the library no longer exists on the share. Re-run `make index-archive`, then Render again. |
| `The file's archive_path does not match its id ...` | The file row's `metadata.archive_path` was edited after it was registered: the id of an archive pointer row is derived from its path (`scripts/index_archive.py` `file_id`, the same rule the crawler uses), so a mismatch means someone repointed the row at another file. This is refused on purpose, because every Lab Member can update `directus_files` and could otherwise publish any file under the share (for instance from a personal folder) as a scan. Register the real file (re-run the indexer or let the crawler find it) and add that one. |
| `The file is in a personal folder but is not marked as its owner's ...` / `... in a team folder but is not marked as the team's ...` | The file row has no owner stamp but its path is under `User/<alias>` (`INBOX_PERSON_DIR`) or under a `Shared/<folder>` a team claims. The crawler stamps every file it finds in those folders (ADR-0022), so an unstamped row was made another way: by a Lab Member who knew the path (the hole this refusal closes), or by the indexer before migration 196 and never met by the crawler since. Run the crawler on that person or team (the scan stamps the row, which is safe: the id is derived from the path), then Render again. Section "Scans of unowned files in personal folders" lists the affected scans. |
| `Could not check whether this folder belongs to a team` | The worker could not read `teams` (a 403 or Directus down) for a file under `Shared/`; it refuses rather than guess. Give the worker's user read access on `teams` and Render again. |
| `The file resolves outside the archive` / `escapes the archive` | A bad `archive_path`; the worker refused it. Fix the file row. |
| `The file could not be read as al3d: ...` | The file is corrupt, truncated or not what its extension says. |
| `The file does not state its length unit` | The scale is unknown; the worker will not guess. |
| `The render was killed, probably out of memory ...` | The kernel's OOM killer usually takes the forked rq work-horse, not the container, so the job never reached its error handling. The poller notices within one poll (`SURFACE_SCAN_POLL_SECONDS`) that the row's rq job is gone or failed. Render again; if it repeats, the scan is too large for `SURFACE_SCAN_MEMORY_LIMIT` (raise it). |
| `The render was interrupted (the worker restarted ...)` | The whole container restarted mid-render. Set by the poller's startup sweep, for rows last touched before the container's start time (taken in `entrypoint.sh`). Render again. |
| Render again does nothing for a few minutes after a container kill | rq still lists the dead worker's job as started until the worker's key expires (its TTL, about 7 minutes); the poller then replaces the dead job and renders. |
| `The render did not finish within the time limit` | Slow share or huge file. Raise `SURFACE_SCAN_JOB_TIMEOUT_SECONDS`. |
| Rows stay `pending` | The container is not running (it is in the `archive` profile), or the worker's token cannot read `surface_scans`. `docker compose logs surface-scan-worker`. |
| Log: `the worker's token may not read file_fingerprints (403)` | A real permission gap (a missing fingerprint is just an empty list). Grant the worker's user read access on `file_fingerprints`; until then every scan gets a provisional cache key. |

To re-render by hand: set the row's `render_status` back to `pending` (the "Render again" action does
exactly this).

### Scans of unowned files in personal folders

The worker refuses these (the rows of section 4) until the crawler has stamped the file. To list the scans affected, for example after
deploying the refusal or when a scan reports it:

```sql
SELECT s.scan_id, s.render_status, f.id AS file_id, f.metadata::jsonb->>'archive_path' AS archive_path
  FROM surface_scans s
  JOIN directus_files f ON f.id = s.directus_files_id
 WHERE f.owner_person_id IS NULL AND f.owner_team_id IS NULL
   AND ( lower(split_part(f.metadata::jsonb->>'archive_path', '/', 1)) IN ('user', 'users')
      OR (lower(split_part(f.metadata::jsonb->>'archive_path', '/', 1)) = 'shared'
          AND lower(split_part(f.metadata::jsonb->>'archive_path', '/', 2))
              IN (SELECT lower(share_folder) FROM teams WHERE share_folder IS NOT NULL)) );
```

A row here is either a legacy file nobody has stamped (run the crawler for that person or team) or a pointer row someone made by hand:
if the row's file is in a folder whose owner did not add the scan, treat it as the second kind and tell the folder's owner. If your
share's personal folder has another name than `User`/`Users`, add it to the first `IN` list (it is `INBOX_PERSON_DIR`).

## 5. Cleaning up

`surface-scans/<cache_key>/` objects are derived data and can be deleted at any time; the next render
recreates them. A provisional-key prefix (`p-...`) is orphaned when the file changes (new size or
mtime gives a new key) or when the crawler later fingerprints the file (the hash key replaces it).
