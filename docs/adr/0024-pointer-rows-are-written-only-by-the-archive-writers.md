# ADR-0024 — A pointer row of the archive share is written only by the archive indexer and the inbox crawler

- **Status:** Proposed (2026-10-21)
- **Date:** 2026-10-21
- **Deciders:** Maintainer ("do as recommended" on the
  [options paper](../superpowers/specs/2026-10-21-forged-pointer-rows-options.md)) + Claude
- **Relates to:** [ADR-0020](./0020-inbox-crawler-read-only-allow-listed.md), [ADR-0021](./0021-surface-scans-on-inserts-and-edges.md),
  [ADR-0022](./0022-files-belong-to-their-provenance-owner.md); closes the "Forged pointer rows" known limit of ADR-0023
  (on the surface-scan privacy branch, not yet on main)

## Context

A pointer row is a `directus_files` row with `storage = 'star'`: it names a file on the read-only archive share through
`metadata.archive_path`, and its id is `uuid5(NS, 'file:' + path)`. The surface-scan worker trusts a row whose id matches its
path. Lab Members may write `id`, `storage`, `filename_disk` and `metadata` on `directus_files` (migrations 196 and 201), so a
member who knew the path of someone else's file could create such a row. It is unowned, so the guard let them add a surface scan
of it and the worker rendered it lab-wide; the crawler's later registration conflicted and, because the file already had a scan,
left it unowned. Directus, the crawler and the indexer connect as the same Postgres role.

## Decision

1. **Only the archive writers create or repoint a pointer row.** A `BEFORE INSERT OR UPDATE` trigger on `directus_files`
   (migration 206) refuses an insert of a `storage = 'star'` row, and an update that gives a row that storage or changes the
   `id`, `storage`, `filename_disk` or `metadata.archive_path` of such a row, unless the session has set
   `d1.archive_writer = 'on'`. `scripts/index_archive.py` and the inbox crawler (`inbox_crawler.db.connect`) set it on their
   connections; Directus never does, so no REST, GraphQL, Flow or extension write can forge a pointer row.
2. **Member permissions do not change.** The Lab Member field lists stay as migrations 196 and 201 left them. Narrowing them is
   a separate decision that waits for physical-test item SEM3 (member uploads, "Replace file").
3. **Rows forged before the migration are found, not auto-fixed.** A query over `directus_activity` lists pointer rows
   that a user created through the API (`docs/runbooks/inbox-crawler.md`, "Forged pointer rows"); the administrator deletes or
   stamps them.

## Alternatives considered

- **Narrow the member field lists.** Closes it only if `id` and `metadata` go from both CREATE and UPDATE, which risks member
  uploads and "Replace file", and it depends on SEM3 and the Directus version. Kept as a later layer.
- **A permission `validation` rule on `storage`.** Smaller, but it guards only the Directus layer and its behaviour on a PATCH
  without `storage` is unverified.
- **The crawler stamps a conflicting unowned row.** It cannot tell a forged row from one the indexer made, so it would reverse
  ADR-0022 decision 5 for every indexed file in a personal folder.
- **The worker refuses unowned rows under a personal or team folder.** Breaks scans of legacy linked files in those folders and
  needs a grandfathering rule we do not have.

## Consequences

- A script or migration that writes pointer rows must set `d1.archive_writer` (a new writer that forgets fails loudly, with an
  `insufficient_privilege` error and a hint).
- A forger gets a Directus 500 rather than a clean 403.
- The setting is a convention between our own writers, not a secret: anyone with raw SQL access to the database can set it.
  The threat it closes is a write made through Directus.
- Unowned pointer rows made by the indexer for files the crawler has not stamped yet, and legacy linked files, stay open
  (ADR-0022 decision 5). That is not changed here.
- The storage name `star` is fixed in the trigger, as it is in the worker (`render_scan.py`); `STORAGE_NAME` is not configurable
  without a new migration.

## Verification

`tests/phase1_schema.sh` (migration 206 up and down, a Directus-style write refused, a writer accepted),
`tests/scripts/test_pointer_row_write_guard.py`, the crawler and indexer tests under the real guard, and physical-test items
FP1 to FP3.
