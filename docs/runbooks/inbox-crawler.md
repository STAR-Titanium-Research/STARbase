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
| `INBOX_OCR=1` | `.env` (passed through by compose) | off (not validated; needs `pytesseract` and tesseract in the image) |
| `INBOX_THUMBNAILS=0` | `.env` (passed through by compose; recreate the service after changing it) | `1`: on. `0` turns off both the pictures made at registration and the backfill of older files (see *Thumbnails*) |
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
- **Thumbnails** (spec section 14): see the next section. They add no read of the share for a new file and a
  throttled, allow-listed read for an older one; the picture code only ever gets bytes already in memory.
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
- **Ignored folders.** A person (for their own folder) or a team member (for the team folder) can tell the
  crawler to leave a folder alone: a rule in `d1_private.inbox_ignored_dirs`, a path *relative to the owner's
  folder* (`World-Ti Paper/Drafts`, not `Users/abc12de/...`), matched on whole path parts without regard to case
  (`World-Ti Paper` covers `world-ti paper/Drafts` but not `World-Ti Paper 2`; no wildcards; the folder itself is
  covered, and everything below it). A rule only ever makes the crawler read less, so the crawler reads an owner's
  rules when it starts the owner and again before it lists a folder, before each batch of 50 registrations and
  (every few seconds) before it reads a file: a rule added while a big folder is being walked stops the walk of it
  within a batch, and nothing under a rule found at that moment is registered, classified or given pictures
  (files registered in the instant before the crawler saw the rule stay `new`; STARbase hides them, and the
  crawler makes no more). A rule *removed* mid-scan is honoured from the next owner or folder it reads.
  An ignored folder is **not scanned**, which is not the same as empty:
  - the crawler stops looking for new files there: the folder is not listed, not statted and nothing in it is
    opened (a lower load on the share is the point). It still shows in its parent's listing, so it keeps a cache
    row (`inbox_dirs`, seen but not listed). Files already linked stay linked and tracked (a linked document is
    still read to fingerprint it, see below);
  - nothing under it is ever marked `gone`, in any state, even when the folder or a folder above it has been
    deleted on the share, and the cache rows below it stay as they are. Candidates there keep whatever state
    they had until the rule is removed, when the next scan looks again;
  - a file below it is not retried when its first hash failed, is not offered to auto-link and gets no
    thumbnail from the backfill (every query that reads the share applies the rules, in SQL and again exactly in
    Python, because Postgres and Python lower-case a few letters differently);
  - a file that was dismissed by the rule and then restored by hand stays `new`: the crawler neither lists the
    folder nor marks it `gone`, and it never makes one `new` under a rule;
  - **a file that is already linked stays tracked.** The queue that hashes a linked document once (and retries a
    failed one) is not stopped by a rule: a linked file belongs to a record, and the rule only keeps the crawler
    from finding new files there.
  The scan log says `N ignored folders were not scanned`. The rules are changed in STARbase's Inbox (adding one
  dismisses the owner's undecided files below it); to look at them in SQL:
  `SELECT owner_person_id, owner_team_id, rel_folder FROM d1_private.inbox_ignored_dirs`. A database without the
  table (the migration not applied yet) ignores nothing.
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

## Thumbnails

Each image and SEM image gets two small derived pictures, a thumbnail (about 320 px on the long side) and a
reduced preview (about 1600 px), both JPEG, in `d1_private.file_thumbnails` (migration 198). The `d1-inbox`
extension serves them to whoever may see the file, and STARbase shows them in the row and in a full view. They
are replaceable copies, never the original, and the table is outside Directus's schema scan.

- **At registration** the crawler already holds the image's bytes (it has hashed and classified them), so
  the pictures cost no second read: they are made from those bytes and stored in the same transaction as the
  candidate. Only kinds `image` and `sem_image` get any; a document is never opened for this and `.al3d` has none.
  An image that Pillow cannot decode is still a found file, and gets a **marker row** instead (both pictures
  empty, `failed_reason` such as `not decoded`, keyed on the file's size and modification time), so it is not read
  again for a picture until the file changes. The decode limits are
  classification's: TIFF, JPEG, PNG and BMP only, at most 50 million pixels, a file of at most 64 MB. A big JPEG is
  decoded at a reduced scale. 16-bit, 32-bit and float grey is stretched to 8 bits, palette and CMYK
  pictures become RGB, transparency (RGBA, grey with alpha, a transparent palette colour) is composited on white,
  a multi-page TIFF shows its first frame, EXIF orientation is applied, and a picture is never enlarged.
- **Backfill.** Images registered before this existed, or whose size or modification time differ from those
  the pictures were made from, are filled in by a step at the end of a tick (only when nothing else is waiting to be
  hashed): up to 25 images or 20 seconds per tick, undecided files first, newest first. It works only for
  owners the scan would scan right now (the scan's own rule: an active person, or one with *scan while former*, with
  a uni alias; a team with a share folder; only the `INBOX_ONLY_FOLDERS` when that is set), for files below the
  owner's **current** folder (a candidate left under an old alias or share folder is not read) and outside the
  owner's ignored folders. It reads through
  `fs_readonly.open_rb` like the scan does (`adopted=False`, so only allow-listed images), at the same
  `read_mb_per_s` throttle, and keeps the heartbeat beating. It makes a picture only of a file that is still the
  one the candidate describes (same size and modification time); one that vanished is skipped (the scan
  decides what is gone). A file that cannot be decoded gets a marker row, which counts as done until the file's
  size or modification time changes. A file that vanished, is refused to the crawler or changed since is tried
  once per process (the in-memory list is for transient problems only). A share hiccup (an I/O error on the
  share) ends that tick's batch and marks nothing, so the next tick tries the same files again. A file whose
  discovery hash failed waits for that hash's hourly retry.
- **Pictures are made once.** The picture is made when the file is first seen. A file re-saved at the same path
  keeps its old picture (and its old size, date and classification, which the scan does not update for a path it
  already knows) until it moves, or is dismissed and re-found. There is no sweep that re-checks known files.
- **Gone.** Marking a candidate `gone` deletes its pictures; one that comes back gets them again from the
  backfill. Dismissed and linked files keep theirs.
- **Switch.** `INBOX_THUMBNAILS=0` (recreate the service) stops both. The pictures already made stay.
- **Without the table.** If migration 198 is not applied yet the crawler logs `file_thumbnails could not be
  written ... is migration 198 applied?` once, registers files without pictures, and the backfill stays off for
  10 minutes at a time. Nothing else is affected.
- **Storage.** A thumbnail is about 10 to 25 KB and a preview about 150 to 400 KB (JPEG quality 78 and 80), so
  budget about **0.3 MB per image**: 10,000 images are about 3 GB, 100,000 about 30 GB. JPEG does not compress
  further in Postgres, and the table is in `pg_dump` backups. The count to multiply is
  `SELECT count(*) FROM d1_private.file_candidates WHERE kind IN ('image', 'sem_image') AND state <> 'gone'`
  (a first scan of a big share registers its whole history as *Older files*, and the backfill then makes a
  picture of each); the size so far is
  `SELECT count(*), pg_size_pretty(sum(octet_length(thumb) + octet_length(preview))) FROM d1_private.file_thumbnails`.
  The backlog is worked through at up to 25 images per 30-second tick, about 3,000 an hour, less when the read
  throttle or big TIFFs slow it. To save the space, set `INBOX_THUMBNAILS=0` or
  `TRUNCATE d1_private.file_thumbnails` (they are made again from the share if it is switched on).
- **Memory.** About 500 MB peak for a 50 MP 16-bit TIFF; the service has no limit of its own
  today, so give the container room for that (backlog IF54).
- **Markers.** `SELECT failed_reason, count(*) FROM d1_private.file_thumbnails WHERE failed_reason IS NOT NULL GROUP BY 1`
  lists the images that have no picture and why. To try them again (after a Pillow bump, say), delete those rows:
  `DELETE FROM d1_private.file_thumbnails WHERE failed_reason IS NOT NULL`.
- What only the real share and real SEM images can show is in the backlog: IF53 to IF58.

## Known limits

- **A share that hangs blocks.** There is no timeout on a call to the share: if it stops answering without
  failing, the scan waits and the heartbeat goes stale (the admin tab shows the daemon as stale). Restart the
  service; nothing is lost (work is committed in batches, and the share is only read).
- **A file edited in place is not noticed** (its folder's mtime does not change). A file replaced by a new one
  under the same name is. A file that was linked when first seen, and is unlinked later, is not offered.
  Its picture is stale too: see *Pictures are made once* under Thumbnails.
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
- *A folder's files never show up:* check that no rule ignores it (or a folder above it):
  `SELECT rel_folder FROM d1_private.inbox_ignored_dirs WHERE owner_person_id = '<person id>'` (or
  `owner_team_id`). Remove the rule in the Inbox and the next scan lists the folder again.
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
  [the physical test backlog](./physical-test-backlog.md) (IF1 to IF14, IF15 onward, the IF20 to IF23 and
  IF30 to IF33 groups that other streams own, and IF70 to IF72 for ignored folders).

## Rolling back

Migrations are `20261015000193_found_files_inbox`, `20261015000194_people_create_no_inbox_fields`,
`20261016000198_file_thumbnails` (the derived pictures: rolling it back loses nothing that cannot be made again from
the share, but stop the crawler or set `INBOX_THUMBNAILS=0` first, or it logs the missing table every ten minutes) and
`20261016000199_inbox_ignored_dirs` (rolling it back loses the owners' ignore rules: export them first).
Roll back 198 (thumbnails) and 199 (ignored folders) first, then 194, then 193 (`make migrate-down` undoes the latest one, so run it once per migration, checking `make migrate-status`
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
