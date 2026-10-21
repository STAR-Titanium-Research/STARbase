# Runbook — Surface-scan render worker

**System:** D1-Database
**Scope:** `plugins/surface-scan-worker` (render pipeline for `surface_scans`), its Directus Flow, its
compose service and what to do when a scan will not render.
**Design:** [`2026-10-15-surface-scans-design.md`](../superpowers/specs/2026-10-15-surface-scans-design.md),
[ADR-0021](../adr/0021-surface-scans-on-inserts-and-edges.md),
[ADR-0023](../adr/0023-surface-scans-follow-their-files-owner.md) (who can see a scan's file, and the
private render table the worker reports into),
[`2026-10-21-surface-scan-privacy-design.md`](../superpowers/specs/2026-10-21-surface-scan-privacy-design.md).

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
5. reports the outcome with `POST /d1-surface-scan/<id>/result` (see "How it writes" below): `done` with
   `cache_key`, `source_*`, `grid_*`, `pixel_pitch_*`, `z_*` and `rendered_at`, or `failed` with
   `render_error` (what STARbase shows, to people who can open the scan, next to "Render again").

`z_min_um` / `z_max_um` are the range of the stored (decimated) grid, so they match what the viewer
draws; the grid pitch is the source pitch times the block size.

### How it writes (ADR-0023)

The worker is a **system actor**: it runs on an **administrator** machine user's token, mounts the share
`:ro` and holds no database credential. A scan's file can belong to one person or team, so the render
columns (`cache_key`, `source_*`, `grid_*`, `pixel_pitch_*`, `z_*`, `rendered_at`) and `render_error` no
longer live on the public `surface_scans` row. They are in `d1_private.surface_scan_renders`, which only the
endpoint reads and writes. So the worker writes `surface_scans` in two ways only:

| Step | Request | Notes |
|---|---|---|
| Claim | `PATCH /items/surface_scans/<id>?filter[version][_eq]=<v>` with `{"render_status": "rendering"}` | A stale version means another job has the row: skipped. |
| Outcome | `POST /d1-surface-scan/<id>/result` with `{version, directus_files_id, render_status: "done" \| "failed", render_error?, columns?}` | Administrators only; one transaction updates the status (only while it is `rendering`, at that `version`, and still pointing at `directus_files_id`, the file the job rendered) and upserts the private row. |

A `409 VERSION_CONFLICT` from the result route means the version moved, the row is no longer
`rendering`, or it now points at another file. The worker re-reads the row and tries again (up to
`OCC_MAX_ATTEMPTS`, default 5, with a short random back-off); if the re-read row is not `rendering` any
more, or its `directus_files_id` is no longer the file this job rendered (someone pressed Render again, or
repointed the scan to another file and it was claimed afresh), the result is dropped rather than overwriting
their reset or storing one file's grid under another. The poller fails stuck rows the same way (timeout
sweep, dead job, startup sweep). The worker still never hashes a file and never writes `file_fingerprints`.

The worker only reads `surface_scans` as an administrator, so its token sees `directus_files_id` and
`render_status` whatever the file's owner; that is why it keeps the check that a file row's id matches
its `archive_path` (section 4) and renders only archive files.

**Token check at start-up.** Before its loop the poller probes the result route with a harmless `failed`
report for a scan that does not exist (all-zero uuid): an administrator token gets `409`, a token that is not
an administrator's gets `403`. On `403` (or `401`, a token Directus does not know or a blank one) it logs
CRITICAL and exits non-zero, so the container stops (and restarts, if its policy says so) instead of failing
every render silently. `409`/`400` carry on; Directus being unreachable, a `5xx` or a `404` (endpoint not
deployed yet) only log a warning and the probe is **asked again at the end of every poll pass until it gets
a definite answer** (on a cold start of the whole stack the worker usually starts before Directus is up, and
a wrong token must still be caught).

## 2. Start it

The worker mounts the SMB archive (`archive_share`, `:ro`), so it is in the same opt-in `archive`
compose profile as the indexer: a plain `docker compose up` never tries to mount the share.

```sh
docker compose --profile archive up -d --build surface-scan-worker
docker compose logs -f surface-scan-worker
```

Settings (all optional, see `.env.example`): `SURFACE_SCAN_DIRECTUS_TOKEN` (blank uses
`WORKER_DIRECTUS_TOKEN`; an **administrator** machine user: the result route accepts administrators only,
and the worker has to read `surface_scans` and `directus_files` whoever owns the file), `SURFACE_SCAN_CONCURRENCY` (1 or 2 renders at a time, default 1),
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
| Log (CRITICAL, then the poller and the container exit): `the surface-scan worker's Directus token is not an administrator's (the result route answered 403)` | The start-up probe found that `SURFACE_SCAN_DIRECTUS_TOKEN` (or `WORKER_DIRECTUS_TOKEN`, when that is blank) belongs to a user that is not an administrator, so no outcome could ever be recorded. Put the static token of an **administrator** machine user there and `docker compose up -d surface-scan-worker`. A `401` in the same message means Directus does not know the token at all. |
| Log: `token probe: Directus could not be reached` or `unexpected answer 404/5xx` | Directus was still starting, or the endpoint extension without `/result` is deployed. Only a warning; the worker carries on and asks again at the end of each poll pass until it gets a definite answer. If it stays, see the `404` row below. |
| Log: `could not write the final state of scan=...` with `403 Forbidden` on `/d1-surface-scan/<id>/result`; rows stay `rendering` (the poller's own failure report goes to the same administrators-only route and is refused too) | The worker's token is not an administrator's (the start-up probe stops the poller as soon as Directus answers; a role changed afterwards would get here). The result route is administrators only; make the machine user an administrator. A non-administrator token cannot even claim a row any more (a member cannot read `render_status` or `directus_files_id`, migration 205), so a token that was never an administrator's shows up as the CRITICAL probe line first. |
| Same log with `404` on `/d1-surface-scan/<id>/result` | Directus is running the old endpoint extension (no `/result` route). Deploy the release as a whole: stop Directus and the worker, migrate, restart Directus and flush Redis. |
| Same log with `400` | The endpoint refused the body (a missing or malformed `directus_files_id`, a bad `cache_key` or a wrongly typed column). A worker bug: the log line has Directus's message. |
| Log: `skip result scan=... it now points at file=...` | A job finished a render of a file the scan no longer points at (it was repointed, perhaps claimed again): the report was dropped on purpose and the new file is rendered by its own job. Nothing to do. |
| Log: `gave up after 5 version conflicts` | The row's version kept moving under the result (someone repeatedly pressing Render again). The job fails; Render again once. |
| Log: `OCC conflict scan=...` once or twice, then `done` | Normal: a webhook, the poller or Render again touched the row between the worker's read and its result. It re-read and retried. |
| A scan is `failed` or stuck `rendering` and the reason is not shown | `render_error` is private now: it is shown by the endpoint to people who can open the scan (its file's owner, the owner's team, administrators), not to others who see a locked tile. Read it as an administrator, or in `d1_private.surface_scan_renders.render_error`. |
| Log: `the worker's token may not read file_fingerprints (403)` | A real permission gap (a missing fingerprint is just an empty list). Grant the worker's user read access on `file_fingerprints`; until then every scan gets a provisional cache key. |

To re-render by hand: use "Render again" in STARbase (`POST /d1-surface-scan/<id>/render`, which sets the row
back to `pending` and clears the private error; it needs a person who can read the file, or an administrator).
Setting `render_status` to `pending` directly (as an administrator) also works: the next result report
overwrites every private render column. (Only a change of the scan's file resets the private render data: the
reset trigger on `surface_scans` fires on `directus_files_id` alone.)

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
