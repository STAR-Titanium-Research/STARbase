# Inbox crawler

The inbox crawler (`scripts/inbox_crawler/`, compose service `inbox-crawler`) watches each person's folder
(`Users/<uni alias>`) and each team's folder (`Shared/<share folder>`) on the lab share, registers new files
as **found files**, tags what they look like and which record their path names, and leaves them for the
person to link in STARbase's Inbox. Design:
[found files and the Inbox](../superpowers/specs/2026-10-15-found-files-inbox-design.md), decision:
[ADR-0020](../adr/0020-inbox-crawler-read-only-allow-listed.md). The force crawler
(`scripts/force_orchestrator.py`) is a different daemon.

## Run it

```sh
make inbox-crawler        # start the daemon (compose profile `archive`, needs SMB_USER / SMB_PASS in .env)
make inbox-crawler-once   # one scan of everyone, then exit
docker compose --profile archive logs -f inbox-crawler
```

**One crawler at a time.** At start the daemon and `--once` take a Postgres advisory lock on their own
connection. `make inbox-crawler-once` refuses to run while the daemon holds the lock (it logs that and exits 1):
stop the daemon first with `docker compose --profile archive stop inbox-crawler`. A second daemon exits 1 the
same way. The lock goes with the process, so a killed daemon never leaves it behind.

Order of a fresh deployment: migrations (d1-server), the `d1-inbox` extension, STARbase, then the crawler.
Set `uni_alias` on People and `share_folder` on Teams first; folders that match nobody are listed for
administrators (admin tab on `/crawler`) and are not scanned.

| Setting | Where | Default |
|---|---|---|
| `DATABASE_URL`, `ARCHIVE_ROOT` | compose | as `archive-indexer` |
| `D1_INBOX_URL` | `.env` | `http://directus:8055` |
| `D1_INBOX_CRAWLER_SECRET` | `.env`, the same value Directus gets | empty: auto-link is off |
| `INBOX_OCR=1` | `.env` (passed through by compose) | off. Reads the FEI/Thermo data bar of an image with no metadata (PNG, JPEG, BMP, a TIFF without tag 34682) cell by cell and, with two header labels read, claims it as a possible SEM image with the values it read. Needs `rapidocr-onnxruntime` and `numpy` in the image, which the service does not install yet (backlog **SEM7**): without them the crawler logs one warning and reads no bars. A TIFF with FEI metadata gets all its values from the metadata without OCR, but with `INBOX_OCR=1` every FEI TIFF that has a data bar is also read by OCR (about 0.16 s each) as a cross-check: the metadata wins and a bar that disagrees is flagged `bar_mismatch` |
| `INBOX_OCR_DEVICE` | `.env` (passed through by compose) | `cpu`; `auto` takes the GPU when onnxruntime has `CUDAExecutionProvider` (and logs the choice), `cuda` insists and falls back to the CPU with a warning. Optional: the CPU reads a bar in about 0.16 s (backlog **SEM4**) |
| `INBOX_PERSON_DIR` | `.env` (passed through by compose) | `User`, the lab share's folder of personal folders (the code's own default, `Users`, is the spec's spelling) |
| `INBOX_ONLY_FOLDERS` | `.env` (passed through by compose; recreate the service after changing it) | empty: everyone with a folder; a comma-separated list of uni aliases / share folders scans only those (trial runs) |
| `INBOX_LOG_LEVEL=DEBUG` | `.env` (passed through by compose; recreate the service after changing it) | `INFO`; DEBUG logs every file the crawler opens; a value that is not a level falls back to INFO with a warning |
| `desired_state`, `interval_minutes`, `read_mb_per_s` | `d1_private.inbox_crawler_state`, by SQL (see below): there is no admin route or tab for them | running, 30, 60 |

## Pause it, change the schedule or the read rate

The admin tab on `/crawler` only shows the crawler (heartbeat, last scan, errors, folders nobody owns) and
queues *Scan all*. The three settings are changed with SQL on the singleton row, as the database owner:

```sql
UPDATE d1_private.inbox_crawler_state SET desired_state = 'paused';    -- keeps the heartbeat, scans nothing
UPDATE d1_private.inbox_crawler_state SET desired_state = 'running';
UPDATE d1_private.inbox_crawler_state SET interval_minutes = 60;       -- minutes between scans of everyone, at least 1
UPDATE d1_private.inbox_crawler_state SET read_mb_per_s = 20;          -- cap on hashing reads, above 0
```

The daemon reads the row every 30 seconds, so a change takes effect within about that long, except that a scan or
a hash already running is not interrupted (a new read rate applies from the next tick). A paused
daemon still clears stale scan requests and keeps its heartbeat; requests queued meanwhile wait until it runs.

## What it does and does not do

- **Read-only.** The share is mounted `ro` twice. In code, `fs_readonly.py` is the only module that touches
  it (list, stat, open for reading), and `tests/scripts/test_inbox_crawler_readonly.py` fails the build on any
  write, delete, rename or open-for-write call, on reflection and dynamic code, and on any import that is not on
  a module's allow-list. The SMB account in `.env` can still write today (backlog IF1).
- **Regular files only, never through a link.** A symbolic link is neither listed nor followed; `open_rb`
  refuses a link (also one swapped in between listing and opening), a FIFO, a device and a directory, and
  refuses to read at all on a platform that cannot refuse links. Hidden directories (`.…`), snapshot directories
  (`~snapshot…`), `$RECYCLE.BIN` and `_dedup_removed` are never entered.
- **Only images (`.tif .tiff .jpg .jpeg .png .bmp`) and surface scans (`.al3d`) are opened before a person
  links them**, to hash them (throttled by `read_mb_per_s`) and look at the picture. Documents, `.mat`, camera
  raw and unknown types are listed by name, size and date. A document is read once, to hash it, after a person
  links it. A picture is decoded only if it is TIFF, JPEG, PNG or BMP and at most 50 million pixels (judged from
  the header); anything else, or any decoding failure, is a plain image.
- **Dependencies are pinned.** The service installs `psycopg2-binary==2.9.13` and `Pillow==12.3.0` (the
  versions CI resolved) at every start, in the compose command and in `make inbox-crawler-once`. Pillow parses
  pictures from the share, so a bump is a reviewed change to both places (and to `scripts/requirements.txt`'s
  floor if needed), not whatever pip finds at a restart.
- **Incremental.** Each scan stats the directories it knows (`inbox_dirs`) and lists only those whose
  modification time moved (one changed in the last 2 seconds is listed again next scan). The first complete
  scan of an owner marks what it finds as backlog (*Older files*); later files are new. A permission error does
  not stop that baseline, an I/O error does (it is retried). A file modified in the last 5 seconds is left for
  the next scan, in case it is still being written.
- **A share that goes away** aborts the scan and marks nothing gone (`last_scan_finished_at` does not advance;
  the admin tab shows the error until a later scan of everyone completes cleanly and clears it). A large file
  hashed through the read throttle keeps writing the heartbeat (at least every 30 seconds), so the admin tab
  does not show the daemon as stale while it reads. The heartbeat is written on a connection of its own
  (autocommit, with a 2 second lock timeout and a 5 second statement timeout), never on the scan's: it can
  neither commit the owner's unfinished registrations (that is the alias check's job, at the end of a folder)
  nor roll them back, and a failed one only logs `heartbeat not written (<error class>)` once and is tried
  again with a new connection on the next beat. An unreadable folder of one person is recorded and that
  person skipped; the others are still scanned. A file that vanished while the share was fine becomes `gone` if nobody had decided
  it; one that reappears under another path with the same content is re-pointed. A scan that stops after
  listing a folder cannot lose that decision: the folder is cached as changed until the gone marks are written.
- **A deleted folder.** Every scan stats the folder of each undecided (`new`) file and every folder above it,
  not only the folders in the cache, so a whole folder that was deleted is noticed even when its cache rows
  went earlier. That matters for a file that was dismissed (or linked) when its folder was deleted and is then
  restored (or its link undone): it comes back as `new`, and the next scan marks it `gone`.
- **Already linked is not found.** A file already linked to a sample, operation or test (for example in Data
  Studio), or already a surface scan (`surface_scans.directus_files_id`, added in the Alicona feature's own
  dialog, which offers every star `.al3d`, the crawler's included), gets no candidate, and an undecided
  candidate whose file is linked or a surface scan meanwhile is deleted at the next scan. Linked and
  dismissed rows are never touched. A database without the `surface_scans` table (migration 192) skips that
  check.
- **Copies.** The same image or surface scan (same hash) in two places is registered once as the original; the
  later one has `duplicate_of` set. d1-inbox lists a copy marked *copy of* the original and hides it once its
  original is linked or dismissed (same owner) or linked (different owner); a copy is not counted in the badge.
  Documents are not hashed before they are linked, so they are never copies.
- **Recognition** looks for a short ID or an exact record code in the path below the owner's folder (an alias
  that looks like a short ID is not a match). Suggestions are refreshed for undecided files each scan.
- **It never creates a link.** It never writes a link or a link bookkeeping column; the one thing it does to
  existing references is re-point them when a file moves, through the indexer's `repoint_file_references`.
  After a scan, for opted-in people only, exact short-ID *images* (SEM or plain; never documents, never
  surface scans, never copies, never a file whose auto-link the person undid) are offered to
  `POST /d1-inbox/auto-link`; the extension decides and links as the person. The client follows no redirects and
  ignores proxy settings; a refused candidate is offered again after an hour.
- **A pointer row's path is not trusted.** `metadata.archive_path` can be edited by any Lab Member, so a
  candidate's path is re-synced from it after an indexer move only when it is a clean path under the same owner's
  folder and the row's id is the indexer's id for that very path; before a linked document is read, its stored
  path is checked the same way: a linked document whose stored path is not its own (for example one left under
  an old alias) gets an `error` fingerprint row, `path is not under its owner folder`, retried hourly like any
  failed hash, so a pile of them cannot hold back the documents behind them. A path the share refuses is
  recorded as an error row (retried hourly), never an exception that repeats every 30 seconds.
- **Rescan my folder** scans the person's own folder (if they have an alias) and the folders of the teams they
  are an active member of; a person with neither fails the request with *no folder to scan*.
- **Alias changes.** The crawler's cached rows are tied to their owner. If a person's alias or a team's share
  folder changes during a scan, that owner's unfinished work is dropped; a folder handed to someone else is a
  first scan for them.
- **The indexer.** `make index-archive` and the crawler share `directus_files` pointer rows. The indexer's
  missing sweep now only judges file types it walks, so crawler-only rows (`.al3d`, other types) are left
  alone (rows flagged missing by an older run stay flagged: clear `metadata.missing` by hand if it matters).
  When the indexer moves a file, the crawler re-reads its candidates' paths from the pointer rows first.

## Known limits

- **A share that hangs blocks.** There is no timeout on a call to the share: if it stops answering without
  failing, the scan waits and the heartbeat goes stale (the admin tab shows the daemon as stale). Restart the
  service; nothing is lost (work is committed in batches, and the share is only read).
- **A file edited in place is not noticed** (its folder's mtime does not change). A file replaced by a new one
  under the same name is. A file that was linked when first seen, and is unlinked later, is not offered.
- A cross-owner move (a file moved from one person's folder to another's) shows as gone plus new.
- A clock difference of more than a few seconds between the share and the server makes every scan list every
  folder (correct, but slow).
- The SMB account in `.env` can write (ADR-0020, backlog IF1); the guarantees above are code and mounts.
- **The crawler connects to Postgres as the superuser** (`POSTGRES_USER` from `.env`, like the indexer). A
  dedicated role that can reach only the tables it needs is a follow-up; until then the code (and the tests that
  read it) are the only limit on what it writes.
- Other tools can still read documents under `Users/` that nobody linked (the indexer's own walk): backlog
  IF15. `file_fingerprints.py --phase all` does not: it skips a document or other non-image file the crawler
  found (a `d1_private.file_candidates` row of kind `document` or `other`) that is not linked and was never
  adopted. It keys on that candidate row, not on `directus_files.metadata.found_by`, which the indexer's next
  run overwrites and any Lab Member can edit. `--phase all` stays a superset of `--phase linked`.

## When something looks wrong

- *Badge stays at 0 / nothing found:* the admin tab shows the heartbeat and the last scan. A person with no
  alias, a Former person (unless "scan while Former"), or a folder that does not match is not scanned.
  `docker compose logs inbox-crawler` shows `scan aborted` when the share did not answer, and `skipping
  Users/<alias>` when one folder could not be read.
- *A scan request stays queued:* the daemon claims one request per 30-second tick, but only between scans: a
  request waits while a scheduled scan runs, which can take hours on a first scan of a big share (watch
  `current_activity` in the admin tab). It is also not claimed while the daemon is paused. A request found
  `running` is failed at the next tick once it is older than 15 minutes, and at start-up whatever its age, so
  the person can ask again.
- *`make inbox-crawler-once` exits 1 at once:* the daemon (or another run) holds the single-crawler lock; stop it
  first.
- *Auto-link does nothing:* `auto-link is off` in the log means the secret is empty; `auto-link refused` means it
  differs from Directus's.
- Tests: `python -m pytest tests/scripts/test_inbox_crawler_*.py` (the DB-backed ones need `DATABASE_URL`, see
  `tests/scripts/test_inbox_crawler_world.py`). What only the real share can show is in
  [the physical test backlog](./physical-test-backlog.md) (IF1 to IF14, IF15 onward, and the IF20 to IF23 and
  IF30 to IF33 groups that other streams own).

## Rolling back

Migrations are `20261015000193_found_files_inbox` and `20261015000194_people_create_no_inbox_fields`. Roll back
194 before 193 (`make migrate-down` undoes the latest one, so run it twice, checking `make migrate-status`
between). Stop the crawler first (`docker compose --profile archive stop inbox-crawler`).

Rolling back 193 **drops** every uni alias and share folder (the `people` and `teams` columns), every candidate
(so every dismissal and every Inbox undo record), every scan request, the crawler's state row and every
auto-link consent. The pointer rows in `directus_files` and the links in the junction tables stay, so nothing
linked is lost. Export what cannot be recomputed first:

```sql
\copy (SELECT person_id, uni_alias, scan_while_former FROM people WHERE uni_alias IS NOT NULL OR scan_while_former) TO 'people_inbox.csv' CSV HEADER
\copy (SELECT team_id, share_folder FROM teams WHERE share_folder IS NOT NULL) TO 'teams_inbox.csv' CSV HEADER
\copy d1_private.inbox_prefs TO 'inbox_prefs.csv' CSV HEADER
```

After re-applying 193 and 194 and restoring those values, every owner gets a first scan, and everything it finds
shows as *Older* (backlog): the dismissals and *Recently linked* history are gone, but files linked through the
Inbox stay linked.
