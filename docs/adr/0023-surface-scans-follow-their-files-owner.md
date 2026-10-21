# ADR-0023 — Surface scans follow their file's provenance owner (supersedes ADR-0021's lab-wide visibility)

- **Status:** Proposed (2026-10-21)
- **Date:** 2026-10-21
- **Deciders:** Maintainer + Claude (privacy design review,
  [spec](../superpowers/specs/2026-10-21-surface-scan-privacy-design.md))
- **Supersedes in part:** [ADR-0021](./0021-surface-scans-on-inserts-and-edges.md) decision 4 ("Scans are visible lab-wide")
- **Fulfils:** [ADR-0022](./0022-files-belong-to-their-provenance-owner.md) decision 6

## Context

ADR-0022 made a file visible and linkable only to its provenance owner and left surface scans lab-wide until their own
stream. A scan row today exposes its file id and every file-derived render value to all members, the endpoint serves its
grid without asking who owns the file, and a member can add someone else's owned file as a scan.

## Decision

1. **A scan's file is governed by the file's owner**, with one rule used everywhere: an administrator, an unowned file, or a
   caller with a `file_readers` row sees it. Unowned and legacy files stay open, as ADR-0022 decision 5 says.
2. **The scan stays visible as a locked placeholder** showing only the condition, date and operation. The file, notes,
   condition note, adder and render are hidden (maintainer's answer to the design question).
3. **File-derived render data moves to `d1_private.surface_scan_renders`**, read only through the `d1-surface-scan` endpoint;
   the public row keeps only link facts. The worker reports results through a new administrator-only endpoint route.
4. **Adding, repointing, editing and deleting a scan of an owned file needs the file**, enforced by a `d1-access-guard` guard
   and update/delete filters.
5. **An administrator's 3D open of a scan they could not read otherwise is logged** in a separate log (not a general audit).

## Alternatives considered

- **A readers table plus a row filter on scans** (hides the row): fails the placeholder; needs a separate count.
- **Copy the owner onto the scan by trigger:** sync triggers on every re-stamp and team change, and it still cannot hide columns
  per row.
- **Per-row column hiding with two permission rows:** rejected for the repo's one-row-per-action rule and unverified behaviour of
  filters, sorts and aggregates on gated fields.
- **A database credential for the worker:** a new secret, and it breaks the rule that workers write through Directus.

## Consequences

- One release: the migration drops columns the current endpoint, worker and panel read.
- A new admin-only route is the worker's only write path for render results; the worker token is an administrator machine user.
- A person who owns files may add scans of them that others see only as placeholders; scans of unowned files stay lab-wide.
- The inbox's wording "visible to every lab member" is wrong for owned files and is changed in the inbox session's files.
- Existing scans whose adder cannot read their owned file are reported, not deleted.
- **Known limits, accepted** (Opus review of this change):
  - Inserts and edges are lab-wide reference data (ADR-0011), so any member can delete one, and its scans (and their private
    render rows) go with it through `ON DELETE CASCADE`; a member can also move a scan to another insert by editing the edge's
    `insert_id`. This is an integrity matter, not a confidentiality one, and is left as it is.
  - The public columns `updated_at` and `version` of a scan stay readable to members and move when a render is claimed and
    reported, so a non-owner can see roughly when a scan of an owned file was rendered. Nothing else about the render is exposed.
  - **Forged pointer rows (predates this change, not fixed here; closed afterwards, see ADR-0022's consequence of 2026-10-21: the
    worker refuses an unowned row in a personal or tied team folder, and `d1-access-guard` refuses a member's write of
    `archive_path` or `storage = 'star'`).** The Lab Member rules on `directus_files` let a member write
    `id`, `storage`, `filename_disk` and `metadata`, so a member who knows the exact path of a file in someone's personal folder
    that the crawler has not registered yet can create a row with the id the indexer would derive (`uuid5('file:'+path)`),
    add a scan of it (it is unowned, so the guard passes) and have the worker render it; the crawler's later insert conflicts and
    its owner stamp skips a file that already has a scan. The worker's id-matches-path check (PR 312) cannot tell such a row from a
    crawler-made one. It is tracked as its own task (provenance a member cannot write: member field lists, or the crawler
    refusing or stamping a conflicting row) and is not part of this ADR.
- Residual unverified behaviour of Directus on a live build is checked by physical-test items SS5 and SS6.
