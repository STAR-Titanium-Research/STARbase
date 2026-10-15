# ADR-0020 — The inbox crawler: read-only, allow-listed, and it only suggests

- **Status:** Proposed (2026-10-15)
- **Date:** 2026-10-15
- **Deciders:** Maintainer + Claude ([spec](../superpowers/specs/2026-10-15-found-files-inbox-design.md))
- **Relates to:** [ADR-0006](./0006-heavy-data-pipeline.md), [ADR-0011](./0011-row-level-visibility.md),
  [ADR-0016](./0016-teams.md), [ADR-0018](./0018-starbase-writes-records.md)

## Context

People save instrument output in their own folders on the lab file share (`Users/<uni alias>`, and team folders
under `Shared`). STARbase cannot link a file to a record (only Data Studio's picker can), and nothing notices new
files. The maintainer wants a crawler that finds them, recognises what they are, and offers them to their owner
to link, without trusting uploads and without ever changing the share. The share is a university research store
used by many people.

## Decision

1. **A separate service, the inbox crawler**, beside `scripts/index_archive.py` (not a mode of it). It mounts
   the existing read-only `archive_share` and reuses the indexer's file-ID rule so both agree on a file's
   identity.
2. **Read-only is enforced in code, not by convention.** One module touches the share and exposes only list,
   stat and open-for-read; a build-failing test rejects any write, delete, rename or open-for-write call in the
   package.
3. **An allow-list decides what is ever read.** Only images and surface-scan files are opened before a person
   links them. Everything else (documents, `.mat`, camera raw, …) is recorded by name, size and date only. A
   document is read once, to hash it, after a person links it, and the link dialog says so.
4. **Found files are suggestions in `d1_private`**, not Directus collections. They are reached only through the
   `d1-inbox` extension, which links as the person (ItemsService, caller's accountability) and refuses unless
   the person can edit the target record.
5. **Nothing links itself unless the person opted in**, and then only on an exact short-ID match to one record
   they can edit, for SEM images and other images only (never documents, never surface scans, never team
   folders), with an undo and an audit trail.
6. **Recognition looks for a short ID or an exact record code anywhere in the path**, never for a naming
   convention, and an ambiguous match is never flagged.

## Alternatives considered

- **Extend `index_archive.py`.** Rejected: it walks the whole tree, is already large, and would take image and
  OCR dependencies into a script whose job is registration.
- **A host-side agent on the Windows machine.** Rejected: nothing here needs MATLAB or Kerberos; the Docker
  mount already reads the share, and host scripts are all run by hand.
- **Upload files into Directus/MinIO.** Rejected by the maintainer: files stay on the share; the database
  holds pointers.
- **Found files as a Directus collection.** Rejected: it would need permissions, an audit decision and Data
  Studio exposure for scratch state; `d1_private` plus an endpoint (the `d1-build` / `d1-usage` pattern) needs
  none of that.
- **Auto-link by default.** Rejected: a wrong link is silent; opt-in with undo keeps people in charge.

## Consequences

- The guarantee "the share is never changed" rests on the mount and the tests, not on the SMB account: the
  crawler currently runs under the maintainer's personal admin account, which can write. A read-only account is
  a follow-up (physical-test backlog).
- A new service, five `d1_private` tables, two new columns (`people.uni_alias`, `teams.share_folder`) and one
  extension to deploy: d1-server (migrations, `d1-inbox`) before STARbase; the crawler last.
- The allow-list is the lever for adding more kinds later; widening it is a reviewed code change.
- The Alicona chat's surface-scan table is written through its own contract; this feature writes none of it.
