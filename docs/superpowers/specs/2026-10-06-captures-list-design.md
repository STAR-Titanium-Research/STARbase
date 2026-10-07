# Captures list: search, filter, sort, paging, bulk actions

**Status:** Implemented. Implementation: `apps/force-app/web/src/settings/CapturesSettings.vue`,
`apps/force-app/web/src/settings/captureList.ts`, `GET /captures/browse` in
`apps/force-app/backend/app/main.py`. Review item R9 of
[`docs/reviews/2026-10-05-ux-utility-review.md`](../../reviews/2026-10-05-ux-utility-review.md);
plan stream P of [`plans/2026-10-06-ux-larger-items.md`](../plans/2026-10-06-ux-larger-items.md).

## Problem

Settings > Local Captures (`CapturesSettings.vue`) is a plain list.

- The web client asks for `/captures/browse?limit=500` and the backend returns newest-first up to
  that cap. With more than 500 captures the oldest silently never show, and they are exactly the
  ones you want to clean up. Nothing says how many exist.
- No search, no filter by status, no sort by size (the usual question is "what is eating the
  drive?"), no multi-select. Deleting 300 old uploaded captures is 300 confirm dialogs.
- "Upload N unsynced" runs one `upload()` after another with no progress and no way to stop.

## What it costs to browse thousands of captures

`/captures/browse` builds one entry per capture folder: `isfile` + `getsize` for each of four files
(8 stats), `getmtime` on the folder, then opens and parses `summary.json` (finalized) or
`manifest.json` + the raw header (incomplete). That is about 10 filesystem round trips per
capture, all sequential, in one thread. Estimates (not measured on the real drive; see the
physical test backlog):

| Where the captures are | Per round trip | Per capture | 500 captures | 3000 captures |
|---|---|---|---|---|
| Local SSD | ~0.05 ms | ~0.5 ms | 0.3 s | 1.5 s |
| LAN SMB share (metadata cached) | 1 to 3 ms | 10 to 30 ms | 5 to 15 s | 30 to 90 s |
| SMB over VPN or a busy NAS | 5 to 20 ms | 50 to 200 ms | 25 to 100 s | minutes |

Two conclusions. The 500 cap is what keeps today's list usable on a network drive, so removing it
without changing the scan makes the page unusable exactly where it matters. And the cost is the
per-capture round trips, not the JSON size (3000 rows is about 1.5 MB, trivial), so where the
filtering runs matters less than how many captures have to be inspected per request.

Also relevant: "uploaded" is not known to the recorder. It is derived in the browser from Directus
(`captureUploadState.ts`). Any status filter on it has to run in the browser.

**What "uploaded" means.** A `manufacturing_operations` row carrying the capture id is not enough:
the upload order is operation row, files, analysis row, so an upload that died after the first step
leaves an orphan operation row. A capture counts as uploaded (for the cleanup rule, the bulk-delete
only-copy warning and hiding the Upload button) only when a `machining_force_analysis` row for one
of its operations has `live_cache_file` set, and `directus_files_id` too when the capture wrote a
`.mat` (the browse row's `files` lists `capture.mat`; captures over `MAT_MAX_BYTES` have none).
Otherwise it is a **partial upload**: it counts as not uploaded, the only copy, and stays uploadable
(`ensureOperation` resumes on the existing operation row). The analysis rows are fetched with one
query per 80 operation ids (`operation_id _in`, three fields only).

## Options

1. **All client-side.** Fetch everything once (raise the cap), filter, sort and page in the
   browser. Simple, and the pure module is easy to test. But every open and every Refresh pays the
   full scan (30 to 90 s on a share with 3000 captures), the first row appears only after the last
   is read, and one request holds the recorder's threadpool for that long.
2. **All server-side.** Query params for everything, including "uploaded". Impossible for
   uploaded/not-uploaded without sending the id list to the recorder or giving it Directus
   credentials; both are worse than the problem.
3. **Hybrid (chosen).** The recorder owns what it can know and what saves disk work: text search,
   sort, `incomplete`/`finalized`, and paging, with a total. The browser owns "uploaded", the
   selection and the cleanup rules, because only it can see Directus.

## Decision

Option 3, with two backend changes that make it cheap:

- **Scan only what the request needs.** Capture ids are timestamp-prefixed, so date order is the
  directory listing order with no per-capture I/O. With no `q`, no `status` and `sort=date`, the
  backend slices the id list first and builds entries for that page only: first paint costs one
  listing plus `limit` captures, whatever the total. `q`, `status` and `sort=size` need metadata
  for every capture, so they build entries for all ids, once per request (never a second pass).
- **Cache finalized entries.** A finalized capture's entry does not change except when
  `summary.json` is rewritten (metadata edit, atomic rename) or the folder is removed. Entries are
  cached in memory keyed by `(folder mtime, summary.json mtime)`, so a repeat scan costs two stats
  per capture instead of about ten. Incomplete captures are never cached (they are few, and their
  `recording`/`discarding`/`recovering` flags are live). `_capture_ids()` also moves to
  `os.scandir`, so the folder test is free.

### API: `GET /captures/browse`

New optional query parameters; with none, the response is the same as today.

| Param | Values | Meaning |
|---|---|---|
| `q` | text | Case-insensitive substring of the capture id, sample name or source. `2026-10-02` also matches the id's `20261002`. |
| `status` | `finalized`, `incomplete` | Has a `summary.json` or not. (`uploaded` / `not_uploaded` are browser-side, see above.) |
| `sort` | `date_desc` (default), `date_asc`, `size_desc`, `size_asc` | Date is the id order; size is the sum of the listed files. |
| `offset`, `limit` | ints | Window into the filtered, sorted result. `limit` is clamped to 1..500 (default 200). |

Response keeps `captures_root`, `captures`, `total_size_mb` (sum over the returned page, as
before) and `disk`, and adds `total` (captures matching `q`/`status`), `total_all` (captures on
disk), `offset` and `limit` (as applied) and `matching_size_mb` (sum over everything matching;
`null` when the request took the page-first path and did not read the rest). An unknown `status`
or `sort` is a 422.

### Web

- Search box (debounced, sent as `q`), status chips (All, Not uploaded, Uploaded, Incomplete),
  sort select, and a "Showing N of TOTAL" line with "Load more". Not uploaded and Uploaded send
  `status=finalized` and filter the rows in the browser; "Load more" then keeps fetching pages until
  a page's worth of matches is found or the server runs out, and the footer says how many captures
  it has looked at.
- `captureList.ts` is a pure module: row state, the safe-to-delete and cleanup rules, selection
  helpers, the cleanup preview, the "need more pages" decision and the upload-all progress
  reducer. No fetch, no Vue.
- Multi-select with a checkbox per row, "select all shown" and a bulk-delete bar.
- "Free up space" panel: delete uploaded captures older than N days, with a preview first.
- `uploadAllUnsynced` shows "n of m, current item" and a Cancel button that stops between items.

## Cost of the Uploaded / Not uploaded chips

Upload state is Directus's, so these two chips filter in the browser, which makes a page of the
list cost two things: a recorder scan (the server filter `status=finalized` needs an entry for every
capture, warm about two stats each) and a Directus lookup for the ids on that page. Trade-offs made:

- **Look up only new ids.** The page keeps the state of every id it has already looked up and asks
  Directus only about ids loaded since (`idsToLookUp`), instead of re-fetching everything loaded for
  each extra page. A reload (Refresh, search, chip, sort) clears the cache and looks everything up
  again, so an entry never outlives the list it was found for. If a lookup fails, its rows stay
  unknown (never "not uploaded") until the next reload.
- **One big page.** With one of these chips the page size is the recorder's maximum (500, not 200),
  so a screenful of matches usually takes one request instead of several.
- **Not removed:** the operation-row query is still bounded below by `created_at` only (an upload can
  happen long after the recording, so there is no safe upper bound), so a lookup for older pages
  scans every operation since that date. Filtering that on the server would need a real
  `capture_id` column on `manufacturing_operations` (a migration; key 9 of the force-app
  conventions), which is out of scope here.

## Delete safety rules

These apply to bulk delete and cleanup. The single-row Delete keeps its present dialog.

1. **Backend is the last gate, unchanged.** Every delete goes through `DELETE /captures/{cid}`, which
   refuses the active recording (409) and a capture with a recover/restore/discard in flight, and
   marks the remote copy deleted rather than removing it. No new delete route.
2. **Never selectable in bulk:** incomplete captures (recover or delete them one at a time, where
   the dialog says what is lost), the recording in progress, anything discarding or recovering.
3. **Bulk delete needs a known upload state.** If Directus is unreachable the bulk bar is disabled
   with the reason; unknown must never read as "uploaded".
4. **Not-uploaded captures can be in a manual selection, but are called out.** The dialog lists
   every item with size and state, totals the space freed, and puts a separate danger line "N of
   these have NOT been uploaded and have no complete remote backup: this is the only copy"
   above the list. A capture queued for upload counts as not uploaded.
5. **Cleanup is stricter and has no manual override.** A candidate must be finalized, positively
   known as fully uploaded to Directus (not a partial upload), not queued, not recording/discarding/recovering, and older than
   N days by its recording time (folder mtime). Not-uploaded, incomplete and unknown never
   qualify. The candidate list is previewed (count, space, oldest and newest) before the
   confirm, and the rules are re-applied to fresh state at the moment of deleting, not to the
   preview: one lookup of every candidate after the confirm, then again per item right before its
   delete (see rule 7).
6. **Per-item results.** Deletion runs one capture at a time and carries on after a failure. The
   summary lists deleted, failed (with the reason) and skipped (became unsafe), plus total space
   actually freed (`freed_mb` from the endpoint).

7. **Three loops share the page, so each checks the others.** Upload all, bulk delete and cleanup
   can overlap with each other and with the row buttons. A capture with an upload or delete in
   flight (`busy`) is not selectable, not a cleanup candidate and not offered an Upload; bulk delete,
   cleanup preview and the row Upload buttons are disabled while Upload all runs, and Upload all
   and the row buttons are disabled while a bulk delete runs. Per item, right before `DELETE`,
   the page re-reads the capture from the recorder (`GET /captures/{id}/summary`: still there and
   finalized) and, for cleanup, re-asks Directus whether its known operation still has a complete
   analysis row. That fresh state decides; the row the plan was made from does not. A failed
   re-check skips the item with the reason. The recorder's own refusals (recording, recover in
   flight) stay the last gate.

## Data flow

Mount: `GET /captures/browse?sort=date_desc&limit=200` renders page 1; Directus uploaded-state and
remote-backup lookups run for the loaded ids as today. A change of search/sort/status restarts at
`offset=0`. "Load more" appends the next page and re-runs the uploaded lookup for the new ids.
Cleanup first loads every remaining finalized page (`status=finalized`, `sort=date_asc`), then
looks up uploaded state for all of them, then previews. Delete and cleanup remove deleted ids from
the loaded rows and subtract their size from the totals without a rescan.

## Out of scope

- A persistent server-side index or database of captures (the in-memory cache is enough, and
  restarting the recorder just means one cold scan).
- Filtering by date range, operator or peak force; sorting by name.
- Remote (backup server) captures: only local ones are listed here.
- Changing the single-capture Delete, Recover, Upload or Edit flows beyond making `upload()`
  return its outcome.
- Selecting across pages without loading them (select-all means all loaded rows that pass the
  filter).
