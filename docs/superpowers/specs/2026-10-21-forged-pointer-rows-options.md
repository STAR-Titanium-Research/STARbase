# Forged pointer rows: options for the maintainer

Status: **decided 2026-10-21: the maintainer chose the recommendation (option 4 + 2b).** Built in migration 206 and recorded in
[ADR-0024](../../adr/0024-pointer-rows-are-written-only-by-the-archive-writers.md). Option 1b and the probe FP1 stay as listed below;
FP1 to FP3 are in the physical-test backlog. (This paper was written as an investigation, before the choice.)
Context: [ADR-0022](../../adr/0022-files-belong-to-their-provenance-owner.md) (decision 5: unowned and linked legacy files
stay open); ADR-0023 (surface scans follow their file's owner; its "Forged pointer rows" known limit). ADR-0023, the `d1-access-guard` surface-scan guard, the worker's `directus_client.py` and migration 205 were on the then-unmerged branch
`ccr-6b593491-4alqyj` when this was written (they are on main now, PR 392), so the fix takes migration **206**.

## The hole in one paragraph

Lab Members may write `id`, `storage`, `filename_disk` and `metadata` on `directus_files` (CREATE and UPDATE field lists in
`scripts/access_rules.json`, migrations 196 and 201). A member who knows a path in someone else's personal folder that the
crawler has not registered yet creates a row with `id = uuid5(NS, 'file:' + path)`, `storage = 'star'`,
`metadata.archive_path = path`. The row is unowned, so the guard lets them add a surface scan of it, the worker's
`check_identity` passes (id matches path), and the file is rendered and shown lab-wide. The crawler's later insert hits
`ON CONFLICT (id) DO NOTHING` and `stamp_owners` skips files that already have a scan, so the row stays unowned.

## What I established (and what I could not)

1. **Directus may already refuse the forged row, depending on its version.** Upstream `FilesService.createOne` calls
   `assertValidStorageLocation(data.storage)`, which rejects any `storage` that is not in `STORAGE_LOCATIONS`, and
   `updateMany` does the same when `storage` is in the payload (read from the upstream `main` source on 2026-10-21).
   `docker-compose.yml:140` sets `STORAGE_LOCATIONS: local` and says `star` is deliberately not declared. So on a Directus
   with that check, `POST /files` with `storage: 'star'` from a member answers 400 and the hole is closed by accident. The
   compose file pulls the floating `directus/directus:11` tag and I could not find which release added the check, so **whether
   the live system is exploitable is unproven either way**. It is a one-request probe (item **FP1** below) and the answer
   changes how urgent this is, not whether the repo should enforce the rule itself: it is an accident of an upstream
   version, not a rule of ours, and the repo has no test for it.
2. **What Directus's own upload path needs from the field lists** (same source, unverified on our build):
   - Create: `uploadOne` calls `createOne` as the member and the payload carries `storage` (the server fills the default)
     plus `type`, `filename_download`, `title`, `folder`. `id`, `filename_disk` and `metadata` are not part of an ordinary
     upload. So **`storage` cannot be removed from CREATE**, but `id`, `filename_disk` and `metadata` plausibly can.
   - After the bytes are written, the extracted `metadata`, `filesize`, `filename_disk` go in through a no-accountability
     service, so UPDATE does not need them for a new upload.
   - **Replacing a file** (`PATCH /files/<id>` with a file) runs `updateOne` as the member with the existing row's `storage`,
     `filename_disk` and `metadata` merged into the payload. Narrowing those three on UPDATE would likely break Data Studio's
     "Replace file" for members. This is the opposite of the SEM reader session's expectation that UPDATE is the safer one to
     narrow. Both directions are unverified until SEM3 has run.
3. **Directus, the crawler and the indexer connect as the same Postgres user** (`d1`, `docker-compose.yml:95,590,611`), so a
   database trigger cannot tell them apart by role.
4. **The indexer registers the whole `star_group1` tree, personal folders included** (`scripts/index_archive.py`, nightly).
   Unowned rows under a personal folder therefore exist legitimately: files the indexer made and the crawler has not stamped
   yet, files already linked or scanned (decision 5), and files in folders the crawler never stamps (a Former person's,
   an unmatched alias, anything outside `INBOX_ONLY_FOLDERS` on a trial run). **The path of an unowned row cannot tell a forged
   row from these.** The same leak, without any forging, applies to the first two kinds for anyone who can see the pointer
   rows (they are browsable). That is the ADR-0022 decision 5 residue, but it is the same class and worth the maintainer's eye.
5. **The personal-folder base on the real share is `User`, not `Users`** (`INBOX_PERSON_DIR`, compose; `owners.PERSON_BASE`). Any
   path-prefix rule must read the configured value.
6. **Forged rows leave a trace.** A row created through Directus's API has a `directus_activity` `create` entry with a user;
   rows made by the crawler or indexer (SQL) have none. That is a way to find rows forged before a fix, subject to the
   activity retention setting (not checked).

## Options

| | What | Closes the hole | Breaks / costs | Needs |
|---|---|---|---|---|
| **1a** Narrow member field lists | Remove `id` and `metadata` (and `filename_disk`) from CREATE and UPDATE; `storage` has to stay on CREATE. | Yes, if both lists lose `id` and `metadata` (no member-written id or archive_path). | Risks member uploads and "Replace file" (point 2), silently. Directus-version dependent. | **SEM3 first** (per the SEM session). Migration like 196/201, `access_rules.json`, `test_access_rules.py`. |
| **1b** Permission `validation` on `storage` | Keep the field lists; add a `validation` rule on CREATE and UPDATE that refuses `storage = 'star'` for members (`gen_access_rules.py` already supports `validation` on create). | Yes, for every write that goes through Directus permissions. | Much smaller blast radius than 1a (only a value no member upload has). Exact behaviour of the rule when `storage` is absent from a PATCH is **unverified**. Directus layer only: a new extension writing by SQL bypasses it. | One live probe (extend FP1). Migration, `access_rules.json`, tests. |
| **2a** Crawler stamps a conflicting unowned row, also if linked or scanned | Reverse ADR-0022 decision 5 for rows the crawler finds. | Partly. | **Cannot tell forged from indexer-made** (point 4), so it either stamps every indexer row under a personal folder (colleagues lose access to files linked on records today: exactly what decision 5 refused) or none. Late: the render happens before the crawler's next pass. Never reaches folders the crawler skips. | Maintainer's call on decision 5; crawler session. **Not recommended.** |
| **2b** Crawler or an administrator report flags rows created through the API | Flag, not stamp: unowned `storage = 'star'` rows with a user `directus_activity` create entry. | Detects, does not prevent. Good for rows already forged. | Needs activity retention long enough. | Read-only query + runbook note; no schema change. |
| **3** Worker refuses unowned rows under `User/` or a tied team folder | Block at the point of harm. | Yes, and it also covers the indexer-window leak (point 4). | **False positives** (point 4): existing scans of legacy linked files in personal folders stop re-rendering. Needs the configured base and the tied team folders from the `d1-surface-scan` endpoint (the worker has no DB). Conflicts with the unmerged worker changes. | A grandfathering rule we do not have (all timestamps and `found_by` are member-writable). **Not recommended on its own.** |
| **4** Pointer-row write guard (database trigger) | A `BEFORE INSERT OR UPDATE` trigger on `directus_files`: a row with `storage = 'star'` can be inserted, or have `id`, `storage`, `filename_disk` or `metadata->'archive_path'` changed, only inside a transaction that set `d1.archive_writer = 'on'`. The crawler's and indexer's connections set it; Directus never does. | Yes, for every route (REST, GraphQL, Flows, any extension), with **no change to member permissions** and no dependence on Directus's version or on SEM3. | The crawler's `db.connect` and the indexer's connect must each set the setting (one line each; `scripts/inbox_crawler` belongs to the crawler session); any script or migration that writes star rows must set it too, or it fails loudly. A forger gets a 500, not a clean 403. Does not touch rows already forged (use 2b). | Migration 206, Postgres tests in `tests/phase1_schema.sh`, crawler/indexer tests. |

## Recommendation

**4 + 2b**, as one PR, with **1b** as an optional second layer once FP1 shows how Directus treats it:

- 4 is the root cause fix: the rule becomes "only the archive writers create star rows", enforced where every writer passes.
  It does not reverse decision 5, does not narrow what members can upload, and is fully testable without a live Directus.
- 2b finds anything forged before the fix and gives the administrator the call (delete the row, or stamp it).
- Leave 1a until SEM3 has run, and 2a off the table. Keep 3 as a later hardening only if the maintainer wants the
  indexer-window leak (point 4) closed too; it needs a grandfathering rule first.

Whichever is chosen, do not change the surface-scan worker's read-only or never-hash guarantees (none of the above touches
them except 3).

## What building 4 + 2b would involve (not started)

- **Migration** `db/migrations/20261021000206_pointer_row_write_guard.sql` written with the
  `db-migration` skill: trigger function in `d1_private` or `public` per the repo's conventions, `COMMENT`s, reversible down
  (drop trigger and function), proven up/down/up.
- **Tests:** Postgres-backed cases in `tests/phase1_schema.sh`: plain session inserting a star row fails; with the setting it
  succeeds; plain `UPDATE` of `metadata.archive_path`, `storage`, `id` fails; plain `UPDATE` of `title`, `folder`, `description`
  succeeds; owner stamping (an `owner_person_id` update) succeeds; a non-star row is untouched. Crawler: a test that
  `db.connect` and the indexer's connect set `d1.archive_writer` (`tests/scripts/test_inbox_crawler_*`,
  `test_inbox_crawler_indexer.py`).
- **Files owned by others, to coordinate before editing:** `scripts/inbox_crawler/db.py` (`connect`), `scripts/index_archive.py`
  (inbox/crawler session); `tests/phase1_schema.sh` fixtures and any seed that inserts star rows (SEM reader session).
- **Docs:** an ADR addendum (new ADR, "pointer rows are written only by the archive writers"; ADR-0023's known limit then
  points at it), the runbook note for 2b, the ADR-0023 "Forged pointer rows" bullet updated.

## Physical-test backlog items this would add (section C, bold ids)

- **FP1 — Does the live Directus refuse a member-written `star` row?** As a Lab Member, `POST /files` (JSON) with
  `storage: 'star'`, and GraphQL `create_files_item` the same; then `PATCH /files/<id>` on the member's own upload with
  `storage: 'star'`. Expect 400 *"Storage location "star" doesn't exist"* (or, with 4 built, a trigger error). Record the
  Directus version (`GET /server/info`). If the row is created, the hole is live: do not wait for the rest.
- **FP2 — Pointer-row guard on the real stack.** After `make migrate` and a crawler restart: a crawler scan and the nightly
  indexer still register files (rows appear, owner stamped); a member's `PATCH` of a star row's `title` works, of its
  `metadata.archive_path` is refused; Data Studio upload and "Replace file" still work for a member.
- **FP3 — Forged-row detection on a copy of the live database.** Run the 2b query; expect 0 rows, or list them for the
  administrator. Also check `directus_activity` retention.

SEM3 stays as it is and is the gate for 1a.
