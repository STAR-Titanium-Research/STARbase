# Surface scans follow their file's provenance owner: design

Status: designed 2026-10-21 (Opus planning review of the code on main at 5c55064c), decisions Q1 and Q3 confirmed by the
maintainer, the rest follow ADR-0022. ADR: [0023](../../adr/0023-surface-scans-follow-their-files-owner.md). Plan:
[`2026-10-21-surface-scan-privacy.md`](../plans/2026-10-21-surface-scan-privacy.md).

## Problem

[ADR-0022](../../adr/0022-files-belong-to-their-provenance-owner.md) makes a file visible and linkable only to its
provenance owner (`directus_files.owner_person_id` for a personal folder, `owner_team_id` for a team folder; unowned and
already-linked legacy files stay open). Decision 6 left surface scans lab-wide until this stream. Today:

- any Lab Member or Lab Viewer reads every `surface_scans` row, including `directus_files_id` and the render columns
  (`cache_key`, `source_*`, `grid_*`, `pixel_pitch_*`, `z_*`, `render_error`);
- the `d1-surface-scan` endpoint streams grid, meta and thumbnail without looking at the file's owner;
- the create and update rules accept any file id, including an owned file the caller cannot read (migration 196 says so).

## Decisions

1. **One visibility rule**, used everywhere: a scan's file is visible to the caller when the caller is an administrator, the
   file has no owner (`owner_person_id` and `owner_team_id` both null), or `file_readers` has a row for (file, caller's login).
2. **A locked scan stays visible as a placeholder** (ADR-0022 decision 3). Confirmed Q1: it shows the **condition, the date
   and the operation** (facts about the shared insert or edge) and hides the file, notes, condition note, who added it and
   everything about the render.
3. **Confirmed Q3:** an administrator's 3D open (`grid` read) of a scan they could not read as a non-admin is logged in
   `d1_private.surface_scan_access_log`. Not a general audit: thumbnails, `/assets` and Data Studio stay unlogged.
4. **File-derived data leaves the public row** (option A of the planning review, ADR-0022 decision 4): the render columns move to
   `d1_private.surface_scan_renders`, read only through the endpoint. Per-row column hiding with two permission rows was
   rejected (repo rule: one row per policy, collection, action; the Directus build's behaviour for filters, sorts and aggregates
   on gated fields is unverified).
5. **Add, repoint, edit and delete need the file.** Only people who can read the file, and administrators, can add a scan of it,
   change a scan's file, edit or delete a scan whose file is owned. Scans of unowned files stay lab-wide as today.
6. **Existing scans** whose adder cannot read the (owned) file are reported by the migration (a `NOTICE` count); nothing is deleted.
7. **The raw file id is hidden** on scans for non-readers (the pointer-row id is `uuid5('file:<path>')`, so it lets a guesser
   confirm a path). Junction tables keep showing theirs until A1b (ADR-0022 decision 5).
8. **A scan becomes private when its file later gets an owner** (an administrator re-stamp, a crawler move). Visibility is
   computed live from `file_readers`, so nothing needs syncing.
9. **Identical bytes owned by two people:** the render cache key is a content hash, so two files with the same bytes share the
   objects. This is accepted: whoever can read one file already holds the bytes of the other. Provisional keys are per file.

## Schema: migration `20261021000205_surface_scans_follow_file_owner.sql` (reversible)

- New `d1_private.surface_scan_renders`: `scan_id UUID PRIMARY KEY REFERENCES public.surface_scans ON DELETE CASCADE`,
  `render_error TEXT`, `rendered_at TIMESTAMPTZ`, `cache_key TEXT CHECK (same pattern as the endpoint's validCacheKey)`,
  `source_format`, `source_width`, `source_height`, `grid_width`, `grid_height`, `pixel_pitch_x_um`, `pixel_pitch_y_um`,
  `z_min_um`, `z_max_um` (types as in migration 192), `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. No foreign key to
  `directus_files` (the indexer repoints those), no audit trigger. COMMENT on everything.
- New `d1_private.surface_scan_access_log` (admin `grid` reads, shaped like `sem_settings_access_log`).
- Data move: `INSERT ... SELECT` from `surface_scans` where any of the 12 columns is non-null, then `DROP COLUMN` for them.
  Keep `render_status` (its CHECK and partial index) on `surface_scans`: the worker polls and claims it.
- Replace `surface_scans_reset_render()`: set `render_status := 'pending'` and delete the row in `surface_scan_renders`.
- Directus: delete the 12 `directus_fields` rows; update the notes and COMMENTs that say the scan is lab-wide or that
  `owner_person_id` is informational; back up the old permission rows into `d1_private.surface_scans_rules_backup` (the 196
  pattern) and replace them with the generated ones below.
- `NOTICE` with the count of existing scans whose file is owned and whose adder's login has no `file_readers` row.
- Down: restore the rules from the backup, re-add the columns (migration 192's types and COMMENTs), copy the data back, restore
  192's trigger function and the 12 field rows, drop the new tables. phase1's replay of 192's down must run 205's down first.

## Directus rules (`scripts/access_rules.json`, `custom.surface_scans`)

- **create:** fields unchanged; a new `d1-access-guard` guard `surface_scans.directus_files_id` requires the caller to read the file.
- **read** (Lab Member and Lab Viewer): fields only `scan_id, insert_id, edge_id, condition, scanned_on, operation_id,
  created_at, updated_at, version`, no filter. So `directus_files_id`, `render_status`, `notes`, `condition_note` and
  `owner_person_id` are readable through REST and GraphQL only by administrators.
- **update** and **delete:** filter `{"_or":[{"directus_files_id":{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]}},{"directus_files_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}`
  (the m2o then the bare to-many hop of migration 196/201). Update fields: the current list minus `render_error`.
- `gen_access_rules.py`: `hook_rules` must accept a guarded collection with a `custom` create row and a `custom` parent whose
  `rule` names a custom action; regenerate `core/extensions/d1-access-guard/rules.json` and
  `scripts/configure_users_and_policies.sql`.
- `d1-access-guard/index.js`: skip `createdInThisTransaction` for parents without a `version` column (`directus_files` has none);
  add `JUNCTION_MESSAGES['surface_scans.directus_files_id']` = "You can only add a surface scan of a file you can see." (same
  message for a file that does not exist).

## Endpoint contract (`core/extensions/d1-surface-scan`)

- `GET /d1-surface-scan/scans?insert_id=<uuid>&edge_id=<uuid>` (at least one; an edge page passes both): rows where `insert_id`
  or `edge_id` matches, capped at `LIST_CAP`. Read as the caller (row permission; the operation label expanded as the caller).
  - readable row: `{scan_id, insert_id, edge_id, locked:false, condition, scanned_on, operation:{id,label}|null, notes,
    condition_note, added_by:{person_id,name}|null, file:{id,name}, render_status, render_error, rendered_at,
    grid:{width,height}|null, can_edit}`
  - locked row: `{scan_id, insert_id, edge_id, locked:true, condition, scanned_on, operation:{id,label}|null}`
- `GET .../:id/grid|meta|thumb`: the visibility rule runs first (before the ETag/304 branch); a locked scan answers
  `403 FILE_LOCKED` (`no-store`, no ETag). `cache_key` comes from `surface_scan_renders`. An administrator reading `grid` of a
  scan they would not see as a non-admin writes one `surface_scan_access_log` row.
- `POST .../:id/render`: unchanged contract; the ItemsService update as the caller now enforces the file filter; clears the
  private `render_error` in the same transaction.
- `POST .../:id/result` (new, **administrators only**; the worker's machine user is one): body `{version, render_status:
  'done'|'failed', render_error?, columns?}` with `columns` = `{cache_key, source_format, source_width, source_height,
  grid_width, grid_height, pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um, rendered_at?}`. One transaction: `UPDATE
  surface_scans SET render_status ... WHERE scan_id=? AND version=? AND render_status='rendering'` (zero rows is `409
  VERSION_CONFLICT`), then UPSERT `surface_scan_renders`. Validates types and `cache_key`, sets `d1.actor_identity`, clears the
  Directus data cache. Non-admin is `403`.

## Worker (`plugins/surface-scan-worker`)

Stays a system actor on an administrator token with the share mounted `:ro`; no database credential. `directus_client.SCAN_FIELDS`
loses `render_error` and `cache_key`. The claim (pending to rendering, REST PATCH with OCC) and `list_scans` are unchanged;
`render_scan._finish` and the poller's failure of stuck rows post to `/d1-surface-scan/:id/result` with the version they read and
retry on 409 as `update_scan` does. The cache-key scheme does not change.

## STARbase (`packages/starbase-pages/src/pages/surface`)

- `useSurfaceScans` and `scanModel` read `GET /d1-surface-scan/scans`; `ScanRow` gains `locked`; `SCAN_FIELDS` goes away.
- `SurfaceScansPanel`: a locked row is a lock tile "A surface scan you cannot open: its file belongs to someone else", with the
  condition, date and operation; no Open, no Render again, no notes, no thumbnail (`useScanThumbs` skips it). The scan count
  includes locked rows. `takenFileIds` comes from readable rows only.
- `addScanModel.VISIBILITY_WARNING`: "Only the file's owner (or its team) and administrators see this scan's file and 3D view;
  others see that the item has a scan. Files with no owner stay visible to every lab member." A guard 403 shows its reason.
- Viewer and `scanErrorText`: `403 FILE_LOCKED` is "This scan's file belongs to someone else, so it cannot be shown."
- Update `tests/ui/starbase/stubScans.ts` and the dom tests.

## The inbox (another session's files)

`core/extensions/d1-inbox/index.js` (header comments around lines 42 to 53 and 208 to 209) and the STARbase inbox text
`inboxScan.ts` `scanAddedText` ("It is now visible to every lab member") and its tests (`inboxScan.test.ts`,
`inboxPage.dom.test.ts`, `useInbox.test.ts`, `inboxContract.test.ts`) say scans are lab-wide. The `link` route already allows
only the owner or an active team member and creates the scan as the caller, so the new guard passes for them; no crawler change.
The inbox session must agree before these are touched.

## Tests

Postgres-backed (phase1 style): migration up, down, up with a checksum of the moved values; the reset trigger deletes the private
row; exact permission rows; down restores the backup; generator drift and `tests/scripts/test_access_rules.py`.
Endpoint and guard unit tests across: owner, non-owner, active team member, inactive team member, an inactive person who owns
files, administrator, Lab Viewer, unowned file, a file re-stamped by an administrator, a file moved by `repoint_candidate`, for
`/scans`, grid/meta/thumb (403 and 304 ordering), render, result (non-admin 403, stale version 409, bad `cache_key` 400) and the
access log. Guard: create or repoint to an owned file the caller cannot read is 403; owner, administrator, unowned file and
no-accountability calls pass; a missing file gives the same 403. Worker pytest for the result calls.

## Physical-test backlog (added in the implementing PR)

- **SS4** two accounts, a team folder, an administrator and a Lab Viewer, end to end.
- **SS5** as a non-owner probe REST `fields=*`, `fields=directus_files_id.*`, `filter[directus_files_id]`, `sort`, `aggregate`,
  `groupBy`, GraphQL (query and introspection), `/utils/export` and a websocket subscription; each must be 403 or return no data.
- **SS6** migration 205 on a copy of the live database (timing, the `NOTICE` count, down and up).
- **SS7** the worker through the result route, and Render again by a non-owner refused.
- Amend **SS1** and **SCAN-UI1** (the warning text; "may not read" now means not the owner).

## Could not be verified (checked by SS5 and SS6)

Directus `dedupeAccess` and whether member filters, sorts, `aggregate` and `groupBy` on a hidden field are blocked; that Directus
accepts the m2o-then-bare-`readers` filter on a live build; the deployed Directus 11.x build (compose pins `directus/directus:11`).

## Release

One release: the migration drops columns that today's endpoint, worker and panel read. Deploy with Directus and the worker
stopped, migrate, restart Directus and flush Redis.
