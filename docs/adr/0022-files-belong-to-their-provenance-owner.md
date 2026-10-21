# ADR-0022 — A file belongs to its provenance owner: only they see it, link it or read its settings

- **Status:** Proposed (2026-10-16)
- **Date:** 2026-10-16
- **Deciders:** Maintainer + Claude (design interview,
  [spec](../superpowers/specs/2026-10-16-sem-data-bar-reader-design.md))
- **Relates to:** [ADR-0011](./0011-row-level-visibility.md), [ADR-0014](./0014-record-access.md),
  [ADR-0016](./0016-teams.md), [ADR-0020](./0020-inbox-crawler-read-only-allow-listed.md),
  [ADR-0021](./0021-surface-scans-on-inserts-and-edges.md)

## Context

The inbox crawler finds files in `Users/<uni alias>` and `Shared/<folder>`, and a person links them to records.
Until now a linked file was readable by anyone who could read its `directus_files` row: ADR-0014 records that
`directus_files` and `/assets` are "open until A1b" (any member can read any file by id), and ADR-0021 makes surface
scans, and so their files, visible to the whole lab. Personal folders hold more than lab data, and reading SEM
images' settings into the database makes the question sharper: linking someone's file must not publish it.
The maintainer's rule (2026-10-16): **a file is linkable and visible only to the user whose alias matches the
folder it came from**. The path of a pointer row cannot carry that rule, because any Lab Member can edit
`archive_path` (ADR-0021).

## Decision

1. **Every file the inbox crawler registers has a provenance owner**: `directus_files.owner_person_id` for a
   personal folder, `owner_team_id` for a team folder (at most one of the two). It is stamped by the crawler when it
   registers the pointer row, belongs to the person (not the alias text), and only an administrator can change it.
2. **Raw reads are filtered on the owner**: a Directus permission filter on `directus_files` (and so `/assets`)
   for Lab Member and Lab Viewer. Rows with no owner stay readable as today. Administrators are not filtered.
3. **Others see a locked file**, never the file: on a record linked to a file they do not own they see that a link
   exists and nothing else. Administrators' reads of an owned file's settings are logged and read-only **within the
   `d1-inbox` settings endpoint only** (`GET /d1-inbox/sem-settings`, one `sem_settings_access_log` row per read, no
   correction allowed). The log is not a general audit of administrators: a Directus administrator can read, edit and
   re-own owned files and their `/assets` directly, through Directus, without any log row (administrators are not
   filtered, as above), and the Inbox list returns an owned candidate's `extracted` (the values the crawler
   read) to administrators without a log row.
4. **Derived data follows the file.** The imaging settings read from an SEM image sit in `d1_private`, are read
   only through the `d1-inbox` endpoint, and obey the same rule. Only the owner can correct them.
5. **Linked and legacy files are not retroactive.** Already-linked files and the legacy archive stay open until the
   file-access stream (A1b) or an administrator's opt-in, so nobody loses access they have today. Found files that
   are not linked yet are owned: the migration stamps the ones the (already live) crawler registered, from the
   owner it recorded in `d1_private.file_candidates`, and the crawler stamps new ones.
6. **Surface scans** are brought under the rule by a separate stream that supersedes the lab-wide decision in
   ADR-0021. Until it lands, ADR-0021 stands.

## Alternatives considered

- **Derive the owner from `archive_path` on every read.** Rejected: any Lab Member can edit the path, so anyone
  could claim a folder's files.
- **A separate ownership table joined into the filter.** Rejected for now: a column on the row Directus already
  filters is one indexed filter; a join adds cost to every `/assets` read. Revisit if the team test needs a
  readers table (ADR-0014 pattern).
- **Serve files through our own proxy and block `/assets`.** Rejected: the largest change and a second read path
  for every viewer; the permission filter is enough for the stated rule.
- **Linking is the act of sharing** (everyone on the record sees the file). Rejected by the maintainer: the rule
  is about who may see the file, not only who may link it.
- **Close every file now, including linked and legacy ones.** Rejected: it would take away access colleagues have
  today in one migration; the maintainer chose a deliberate opt-in.

## Consequences

- A new column pair on a Directus system table, Directus field lists that keep the owner columns out of members' writes, and a filter in the Lab Member and Lab
  Viewer policies that every `/assets` read pays for (indexed; measured in the plan).
- A person with owned files cannot be deleted (`ON DELETE RESTRICT`); they are deactivated instead.
- A linked record can show a link its reader cannot open. The link's existence is visible; the file's name,
  contents and settings are not.
- Files in the legacy archive and already-linked files remain readable by every member until A1b, so the lab's
  privacy statement stays "for files registered after this change".
- Surface scans stay lab-wide until the separate stream lands; ADR-0021 is then marked superseded.
- The crawler becomes the stamp writer for owned files; the indexer still registers unowned legacy files.
- A folder that changes hands (an alias given to someone else or corrected) leaves the files stamped to the person
  they came from: the new holder's Inbox does not list them and `d1-inbox` refuses a candidate whose file is stamped to
  someone else; an administrator re-stamps by SQL when the files really are the new holder's
  (`docs/runbooks/inbox-crawler.md`, "An alias handed to someone else").
- **Two team-membership rules differ on purpose, for now.** `d1-inbox` counts only `people.active` members of a team
  (a Former person sees no team files in the Inbox), while the `file_readers` table of migration 196 holds a row for
  every team member with a login, active or not, so a Former member who still has a login can still read a
  team-owned file by id through Directus. Migration 196 is already on main and is not changed; the difference is
  checked in physical-test item SEM19 and a later migration can align it (either way round).

- **A pointer row for a path someone else owns cannot be made by hand, and is not rendered if it exists** (2026-10-21). Decision 5 leaves
  linked and legacy files unowned, and the Lab Member field list for `directus_files` lets a member write `id`, `storage` and
  `metadata`, so a member who knew a path could make its pointer row ahead of the crawler and add a surface scan of it. Two guards, neither
  of which narrows a field list (that waits for SEM3): `d1-access-guard` refuses a non-admin write that creates a row with `storage = 'star'` or
  `metadata.archive_path` or changes either on an existing row (`archivePointers.js`; the indexer, crawler and imports write by SQL and
  are not affected), and the surface-scan worker refuses an unowned row whose path is under the personal folder or under a team's
  `Shared/` folder (`archive.check_owner_stamped`). Legacy scans of unowned files in those folders stop rendering until the crawler has
  stamped them (runbook `surface-scan-worker.md`, "Scans of unowned files in personal folders"). The crawler's own stamp of scan-linked rows
  (commit 82c7f47) stays. Backlog IF91 and IF92.

## Verification

Postgres-backed visibility tests (owner, non-owner, team member, administrator with the access log, unowned file,
moved file, an alias handed to another person, an attempt to change the owner as a Lab Member, `/assets` for owned
and unowned files), and the physical-test items SEM3 and SEM5 in the backlog.

## References

[Spec](../superpowers/specs/2026-10-16-sem-data-bar-reader-design.md) sections 3 to 5,
[found files spec](../superpowers/specs/2026-10-15-found-files-inbox-design.md),
`scripts/inbox_crawler/owners.py`, `scripts/inbox_crawler/scan.py`, `core/extensions/d1-inbox/index.js`.
