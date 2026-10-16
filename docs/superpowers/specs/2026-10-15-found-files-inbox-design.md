# Found files and the Inbox: an inbox crawler for personal and team folders

- **Date:** 2026-10-15
- **Status:** Approved in conversation 2026-10-15 (maintainer); built as plan
  [`2026-10-15-found-files-inbox`](../plans/2026-10-15-found-files-inbox.md)
- **Decision record:** [ADR-0020](../../adr/0020-inbox-crawler-read-only-allow-listed.md)
- **Terms:** `CONTEXT.md` → *Files on the share* (Personal folder, Uni alias, Team folder, Found file, Inbox,
  Backlog, Link). The crawler is called the **inbox crawler**; the existing daemon stays the **force crawler**.

## 1. What this is

People save instrument output (SEM images, Alicona scans, force files, documents) in their own folder on the
lab file share. Today nothing notices those files, and STARbase cannot link a file to a record at all (it
only lists linked files; linking happens in Data Studio's picker). This feature adds:

1. A **read-only inbox crawler** that watches each person's **personal folder** (`Users/<uni alias>`) and each
   **team folder** (`Shared/<folder tied to a team>`), registers new files, and tags what they look like.
2. An **Inbox** in STARbase: a count badge, a Home panel and a page where a person **links** found files to
   samples, operations and tests, quickly and in bulk, with suggestions.
3. **Opt-in auto-linking** for files whose name or path carries an exact short ID.

Files stay on the share. Nothing is uploaded, moved or changed (§3).

## 2. Decisions (from the interview)

| # | Decision |
|---|---|
| D1 | `Users/<uni alias>` = one person; the alias is a new unique field on People, set by an administrator. `Shared/<folder>` = one team, via a new field on Teams. Folders with no match are listed for admins and not scanned. Loose files directly in `Shared/` are skipped. Former people's folders are not scanned unless an admin switches it on for that person. |
| D2 | **Strictly read-only** against the share: no edit, delete, move or rename, ever. Documents are never opened until a person links them; then they are read once to hash, and the link dialog says so. Only images and surface-scan files are read before linking. |
| D3 | A new sibling service (not an extension of `scripts/index_archive.py`), on the existing read-only `archive_share` mount, run under the maintainer's personal SMB account for now (known risk, §10). |
| D4 | Recognition has no naming convention: a **short ID** (8+ lowercase hex) or an **exact record code** anywhere in the file name or path. All-digit 8-character tokens are ignored (dates). A match to exactly one record is a suggestion; two or more are never flagged. Insert-edge codes are a weaker suggestion, and only when exactly one edge matches. |
| D5 | v1 classifiers: SEM images (JEOL profile first; others as the maintainer supplies images) and Alicona `.al3d` files (tag only, §8). Everything else is an untyped found file; documents show name, size and date only. |
| D6 | **Backlog:** the first complete scan of an owner's folder marks everything found as backlog. Backlog is not counted as new, but backlog files with an exact match are flagged. |
| D7 | Scan every 30 minutes, incrementally. A per-person **Rescan my folder** (rate-limited) and an admin **Scan all**. |
| D8 | The inbox is a count badge on its own sidebar entry plus a Home panel. No general notification system (the count is generic, so one could consume it later). |
| D9 | **Accept all** acts only on exact short-ID matches to one record the person can edit, with one undo per batch. |
| D10 | **Auto-link** is per person, off by default, consent text on the switch; only exact short-ID, one record, one the person can edit; SEM images and other images only (never documents, and never surface scans, which need a condition chosen by a person); listed under "Recently auto-linked" with undo; audited. No team auto-linking, no group-wide switch in v1. |
| D11 | The same image in two inboxes shows once (where first seen); the copy is marked "copy of" and drops out when the original is linked or dismissed. *As built (final review):* for a copy whose original belongs to the **same** person or team that is the rule; for a copy whose original belongs to a **different** owner it drops out only when the original is **linked**, not when another owner merely dismisses it (their dismissal must not hide your file), and it counts in the badge once the original is gone or dismissed by that other owner. The list names whose Inbox holds the original only for the caller's own folder or one of their teams; for anyone else `duplicate_of_owner` is `{ "kind": "other" }` with no name. |
| D12 | Dismissed files stay in a "Dismissed" view (undoable). A file that disappears before a decision is marked **gone**; a hash-matched move re-points the row. |
| D13 | **Link** is the verb for samples, operations and tests. A surface scan is **added** (the Alicona chat's term, §8). |

## 3. Read-only guarantees (three layers)

1. The share is mounted `ro` twice (compose `ro` option and `:ro` on the service) — already true for
   `archive_share`.
2. **One module touches the share.** `scripts/inbox_crawler/fs_readonly.py` exposes only `scandir`, `stat` and
   `open_rb`. Nothing else in the package imports `os`, `shutil` or `pathlib` write functions.
3. **Tests fail the build** if the package contains any write, delete, rename, `chmod`, truncate or
   open-for-write call (an AST scan), and a runtime test shows `open_rb` raises for a path whose extension is
   not on the read allow-list unless the caller passes `adopted=True`.
4. Not a layer yet: the SMB account is the maintainer's personal admin account, which can write. A read-only
   account is a follow-up (backlog item).

## 4. Data model (the contract all streams build against)

Migrations are written by stream A. Names below are binding; column types are binding unless a constraint
forces a change (then the worker updates this table in the same commit). Implemented by migration
`20261015000193_found_files_inbox.sql`; where it differs from the first draft of this section the text below
already says so (changes marked *as built*).

**public**

- `people.uni_alias TEXT` — nullable; `CHECK (uni_alias ~ '^[A-Za-z0-9._-]{2,64}$')` and (*as built*)
  the regex is tightened to `'^[A-Za-z0-9_-][A-Za-z0-9._-]{1,63}$'` (no leading dot: `..` cannot walk out of `Users/`
  and a hidden folder such as `.snapshot` is impossible); unique on `lower(uni_alias)` where not null
  (`people_uni_alias_key`). `people.scan_while_former BOOLEAN NOT NULL DEFAULT false`. Kept out of Lab
  Member create and update: not in their `people` update field list, and a `BEFORE INSERT` trigger on `people`
  refuses a new row that sets either column (*as built*; error `uni_alias and scan_while_former can only be set by
  an update`), so only an administrator's UPDATE sets them. Stream B also narrows the Lab Member create field list.
- `teams.share_folder TEXT` — nullable; `CHECK (share_folder !~ '[\\/]' AND btrim(share_folder) <> '')` and (*as built*)
  `CHECK (share_folder = btrim(share_folder))` and `CHECK (share_folder !~ '^[.]+$')`; unique on `lower(share_folder)` where not null
  (`teams_share_folder_key`).
- *As built:* teams are keyed by `team_id` (not `id`), so every team foreign key below is `teams (team_id)`.

**d1_private** (not exposed in Directus; reached only through the `d1-inbox` extension, like pins and drafts)

- `file_candidates`
  - `candidate_id UUID PK DEFAULT gen_random_uuid()` (*as built*, was `uuid_generate_v4()`; the same for `inbox_scan_requests.request_id`, as migration 181 does), `directus_files_id UUID NOT NULL UNIQUE REFERENCES
    directus_files(id) ON DELETE CASCADE`
  - `owner_person_id UUID REFERENCES people(person_id) ON DELETE CASCADE`,
    `owner_team_id UUID REFERENCES teams(team_id) ON DELETE CASCADE`;
    `CHECK (num_nonnulls(owner_person_id, owner_team_id) = 1)`
  - `kind TEXT NOT NULL CHECK (kind IN ('sem_image','surface_scan','image','document','other'))`,
    `kind_confidence NUMERIC(4,3)` (*as built:* `CHECK (kind_confidence BETWEEN 0 AND 1)`),
    `extracted JSONB NOT NULL DEFAULT '{}'` (*as built:* must be a JSON object)
  - `origin TEXT NOT NULL CHECK (origin IN ('new','backlog'))`,
    `state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','linked','dismissed','gone'))`
  - `match_strength TEXT NOT NULL DEFAULT 'none' CHECK (match_strength IN ('short_id','code','edge_code','none'))`,
    `matches JSONB NOT NULL DEFAULT '[]'` (array of `{collection, record_id, via, token}`; *as built:* must be a
    JSON array), `suggested_collection TEXT`, `suggested_record_id UUID` (set only when exactly one record matches;
    *as built:* both set or both null)
  - `duplicate_of UUID REFERENCES file_candidates(candidate_id) ON DELETE SET NULL` (*as built:* not its own id)
  - `rel_path TEXT NOT NULL` (relative to `star_group1`), `size_bytes BIGINT` (*as built:* `>= 0`),
    `source_mtime TIMESTAMPTZ`
  - `first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `decided_at TIMESTAMPTZ`,
    `decided_by UUID REFERENCES directus_users(id) ON DELETE SET NULL` (*as built:* a real foreign key)
  - undo bookkeeping: `link_kind TEXT CHECK (link_kind IN ('manual','bulk','auto'))`, `linked_collection TEXT`,
    `linked_junction_id UUID`, `link_batch_id UUID`; *as built:* all four are NOT NULL when `state = 'linked'` and
    all NULL otherwise (two CHECKs, `file_candidates_linked_bookkeeping_check` and
    `file_candidates_unlinked_bookkeeping_check`), so an undo must clear all four together with the state;
    `linked_collection` has no value list
  - *As built:* `adopted_at TIMESTAMPTZ` — set by `d1-inbox` when a person links a document or other non-image
    file; it is the "flag the crawler reads" (plan B2/C6): the crawler hashes rows with `adopted_at IS NOT NULL`
    that have no `file_fingerprints` row yet (`open_rb(..., adopted=True)`). Stays set after an undo.
  - indexes: `(owner_person_id, state)`, `(owner_team_id, state)`, and, partial on not-null, `(link_batch_id)`,
    `(suggested_record_id)`; *as built* also partial `(duplicate_of)`, `(adopted_at)` and `(decided_by)`
- `inbox_dirs` — the folder cache: `rel_path TEXT PK`, `owner_person_id`, `owner_team_id` (same check and
  `ON DELETE CASCADE` foreign keys; each owner column is indexed),
  `dir_mtime TIMESTAMPTZ`, `last_listed_at`, `baselined_at TIMESTAMPTZ` (set on the owner's root row when their
  first complete scan ends; files first seen before that are `origin='backlog'`).
- `inbox_scan_requests` — `request_id UUID PK`, `scope TEXT CHECK (scope IN ('person','all'))`,
  `person_id UUID REFERENCES people ON DELETE CASCADE` (*as built:* required exactly when `scope = 'person'`),
  `requested_by UUID REFERENCES directus_users ON DELETE SET NULL`, `requested_at NOT NULL DEFAULT now()`,
  `started_at`, `finished_at`, `status TEXT NOT NULL DEFAULT 'queued' CHECK
  (status IN ('queued','running','done','failed'))`, `error TEXT`. Indexes `(status, requested_at)` (the daemon's
  claim), partial `(person_id, requested_at DESC)` (the rate limit) and, *as built*, a partial UNIQUE index on
  `(person_id) WHERE scope = 'person' AND status IN ('queued','running')`: at most one open request per person, so
  two concurrent `rescan` calls cannot both pass the endpoint's check (the loser gets a unique violation, reported
  as 429), and partial `(requested_by)` (the user foreign key).
- `inbox_crawler_state` — singleton like `force_crawler_state` (`id` fixed to
  `00000000-0000-0000-0000-000000000001`, one seeded row): `desired_state` (`running`/`paused`, default
  `running`: the daemon is already opt-in through the compose profile and the admin tab has no start switch),
  `interval_minutes INT NOT NULL DEFAULT 30` (`>= 1`), `read_mb_per_s NUMERIC NOT NULL DEFAULT 60` (`> 0`),
  `last_heartbeat_at`, `daemon_started_at`, `current_activity`, `last_scan_started_at`, `last_scan_finished_at`,
  `files_registered BIGINT NOT NULL DEFAULT 0`, `error_count INT NOT NULL DEFAULT 0`, `last_error`.
  *As built:* `unmatched_folders JSONB NOT NULL DEFAULT '[]'` — a JSON array of share-relative paths
  (`"Users/zz9"`, `"Shared/Old project"`) of folders directly under `Users/` and `Shared/` that match no alias and
  no share folder, rewritten by the crawler each scan (`inbox_dirs` rows need an owner, so they cannot hold these);
  and `updated_at`.
- Auto-link opt-in: **decided: a new table `d1_private.inbox_prefs`** (`user_id UUID PK REFERENCES
  directus_users ON DELETE CASCADE`, `auto_link BOOLEAN NOT NULL DEFAULT false`, `updated_at`), not
  `d1_private.user_prefs` (migration 170): `user_prefs.prefs` is a JSON document owned by the `d1-usage` endpoint,
  which rejects keys it does not know, so a flag written by `d1-inbox` would be refused or dropped there; and
  "who opted in" stays a plain indexed column for the crawler. The row is keyed by Directus user; the crawler
  maps a person to their login through `people.user_id`.

**Reused unchanged:** `directus_files` (`storage='star'` pointer rows, uuid5-of-relative-path ids, written by
the crawler with the indexer's rule so ids agree), `directus_folders`, `file_fingerprints` (the crawler writes
`content_sha256`), the three junctions `sample_data_files`, `operation_data_files`, `session_data_files`,
`record_by_short_id()` (the crawler itself reads the record tables' `short_id` columns, §6).

## 5. The inbox crawler (`scripts/inbox_crawler/`, compose service `inbox-crawler`, profile `archive`)

A daemon like the force crawler: reads `inbox_crawler_state` each loop, writes its heartbeat back.

**Scan loop.**
1. Load owners: every person with a `uni_alias` (active, or `scan_while_former`) and every team with a
   `share_folder`. Unmatched folders directly under `Users/` are recorded for the admin list; not scanned.
2. Walk each owner's tree **incrementally** using `inbox_dirs`: for every known directory, `stat` it (one cheap
   call); only directories whose mtime changed since `last_listed_at` are listed (`scandir`). A new nested
   directory appears as a new entry of a changed parent. A file edited in place does not change its
   directory's mtime and is not noticed in v1 (new files are the goal).
3. For each new file: build its `directus_files` pointer row and folder rows (indexer's rule), then:
   - **images** (`.tif .tiff .jpg .jpeg .png .bmp`) and **surface scans** (`.al3d`): hash content (throttled by
     `read_mb_per_s`, written to `file_fingerprints`), classify (§7), recognise IDs (§6);
   - **everything else** (documents, `.mat`, camera raw, …): record name, size, mtime only; never opened.
4. Create the `file_candidates` row: `origin='backlog'` if the owner has no `baselined_at` yet, else `'new'`.
   After an owner's first complete scan, set `baselined_at`.
5. Hash-matched duplicates (images and scans only): set `duplicate_of` on the later row.
6. Files that vanished: `state='gone'` (undecided only), or re-point the row when a hash matches a new path.

**Requests.** Every ~30 s the daemon claims `inbox_scan_requests` (`person` scope scans only that owner,
`all` scans everyone) with `FOR UPDATE SKIP LOCKED`. The rate limit is enforced by the extension (§9).

**Auto-link.** After a scan, for each new file whose owner is a person with auto-link on, an exact single
short-ID match, and kind in (`sem_image`,`image`): the crawler asks the `d1-inbox` extension
(`POST /d1-inbox/auto-link`, machine credential) to link it on the person's behalf. The crawler never writes
the junction itself. Auto-link links only what the person could link by hand and is least likely to regret: it
excludes backlog (Older) files, team-folder files, copies of another file, files a person already undid an auto-link
of (`file_candidates.auto_undone_at`; the extension answers `UNDONE`, the crawler's candidate query skips them), and
documents, other files and surface scans (kinds outside `sem_image` and `image`).

**Hash after adoption.** When a person links a document, the extension marks the candidate; the crawler reads
it once (`open_rb(..., adopted=True)`), hashes it and writes `file_fingerprints`.

**When an alias or share folder changes.** Triggers on `people` (`AFTER UPDATE OF uni_alias`) and `teams`
(`AFTER UPDATE OF share_folder`), firing only when the value really changes (`lower(old) IS DISTINCT FROM lower(new)`: alias and share folder
uniqueness ignore case, so `ABC` to `abc` is the same name and changes nothing; setting it to or from `NULL` counts), delete that owner's `inbox_dirs` rows and that owner's `file_candidates` in state `new`, `gone`
and `dismissed`. Candidates in state `linked` are kept (the link is a decision and its undo bookkeeping must
survive). The cache and the undecided rows described the old folder, so left alone they would strand. The owner's
next scan is a first scan of the new folder: everything in it is backlog and `baselined_at` is set again. An
UPDATE that leaves the value as it was deletes nothing.

## 6. Recognition (`recognise.py`, pure functions)

- Tokenise the relative path on `/ \ _ - . space`. Candidates: runs of `[0-9a-f]{8,32}` (lower-cased input) that
  are not all digits.
- A token counts only if it equals a record's short ID exactly. The crawler looks short IDs up in the `short_id`
  column of the three record tables (`physical_samples`, `manufacturing_operations`, `test_sessions`), not in
  `short_ids`: a short ID of a deleted record stays in `short_ids` for ever, so the record's own row is the truth. Codes
  are looked up in `sample_code`, `pass_code`, `test_code` and `insert_edges.edge_code` (a lookup table, never a
  regex on the database).
- Exact **full codes** (sample code, operation code, test code) found as a whole delimited substring of the
  path, matched against current codes. Edge codes (`H13A-#2-fC` form) likewise against `insert_edges`.
- `match_strength`: `short_id` > `code` > `edge_code` > `none`. Two or more distinct records at the strongest
  level → `matches` lists them, `suggested_*` stays null.
- A renamed code can drift from its file; code matches are weaker than short-ID matches for that reason.

## 7. Classification (`classify_sem.py`, `classify_scan.py`)

- Surface scan: extension `.al3d` (config list) → `kind='surface_scan'`, confidence 1.0, no pixel work.
- SEM image: a pluggable per-instrument profile. v1 profile = JEOL: bottom data bar (dark band along the bottom
  edge, high-contrast text-like content, a scale-bar line) plus any embedded TIFF metadata the profile knows.
  Output `kind='sem_image'` with a confidence, and `extracted` (only what was actually read: kV,
  magnification, scale bar, instrument), or `kind='image'`. OCR of the bar text is an optional dependency behind
  a flag, **off until validated on the maintainer's sample strips**; the tag is worded "possible SEM image"
  until then.
- Profiles are tested on synthetic fixtures (generated strips), never on committed research data.

## 8. Surface scans (coordination with the Alicona chat)

The surface-scan table, viewer and derivatives belong to the "Alicona files and GitHub resources" chat (spec on
its branch `ccr-6b593491-4alqyj`: `docs/superpowers/specs/2026-10-15-surface-scans-design.md`). Its design,
reported by that chat as confirmed by the maintainer there: Alicona files belong to an insert or an edge; a
surface scan is **added**, not linked; visibility is lab-wide like inserts and edges. This feature detects and
tags `kind='surface_scan'` and, on confirm, creates the scan row. Neither chat writes the other's tables; the
scan row is the contract.

**Row contract (`surface_scans`, published by that chat; its migration is not merged yet):**

- Required from the inbox: `directus_files_id` (the pointer row this crawler created), exactly one of
  `insert_id` (cutting_inserts) or `edge_id` (insert_edges), and `condition` (`new | worn | cleaned | other`;
  never guessed by the crawler, always chosen by the person).
- Optional from the inbox: `operation_id` (the operation that wore the edge), `scanned_on` (date),
  `condition_note`, `notes`.
- Written only by the viewer's worker, never by us: `render_status` (the default `pending` queues the render),
  `render_error`, `rendered_at`, `cache_key`, `source_*`, `grid_*`, `pixel_pitch_*`, `z_*`.
- Unique per `(insert_id, directus_files_id)` and `(edge_id, directus_files_id)`; standard columns as on
  `insert_edges` (`version` for OCC, `owner`, `owner_person_id`).

**Write path:** a plain Directus item create on `surface_scans` as the caller (permissions and hooks apply); not
`d1-build`, because it is one row. In the `d1-inbox` link route this is a `surface_scans` create through
`ItemsService` with the caller's accountability inside the same transaction that marks the candidate linked;
the edit check is Directus's own create permission on `surface_scans` (lab-wide reference data), not a
record-access function. Undo deletes that row.

**Hashing:** the crawler writes `file_fingerprints.content_sha256` for `.al3d` at discovery; the viewer's worker
reads it, uses a provisional key when it is not `done`, and never hashes or writes that table.

**Until `surface_scans` is merged** stream F builds against this contract with fakes, and the live link stays
disabled behind a feature flag the extension reads (the table's existence).

*As built (stream F1, `d1-inbox`):* `surface_scans` is on the base branch (migration 192), so the feature flag is the
table's existence, read once from `information_schema` (409 `SURFACE_SCANS_UNAVAILABLE` when it is missing). A surface
scan is **added** through `POST /d1-inbox/link` with an item of its own shape:

```
{ candidate_id, collection: 'surface_scans', insert_id | edge_id (exactly one), condition: 'new'|'worn'|'cleaned'|'other' (required, never defaulted),
  operation_id?, scanned_on? ('YYYY-MM-DD'), condition_note? (500 characters), notes? (2000 characters) }
```

It may sit in one batch with sample, operation and test links. Only a candidate of kind `surface_scan` can be added
(409 `NOT_A_SURFACE_SCAN` for any other); a surface scan linked to a sample, operation or test is 409 `SURFACE_SCAN`
("A surface scan is added to an insert or an edge."); accept-all and auto-link keep skipping it. The row is created
through `ItemsService` as the caller in the transaction that marks the candidate linked (`link_kind` `manual` or `bulk`,
`linked_collection` `surface_scans`, `linked_junction_id` = the new `scan_id`); the endpoint sends only `insert_id` or
`edge_id`, `directus_files_id` (from the candidate), `condition` and the optional fields, never `owner_*`, `render_*`,
`cache_key`, `source_*`, `grid_*`, `pixel_pitch_*` or `z_*` (the default `render_status = 'pending'` queues the render, and
`d1-owner-default` sets the owner). The insert, edge and operation are read as the caller first: one that is missing or
that the caller cannot read is 404 `NOT_FOUND`. A unique violation is 409 `ALREADY_ADDED`; any refusal rolls the whole
batch back. The answer item is `{ candidate_id, collection: 'surface_scans', record_id: <scan_id>, junction_id: <scan_id>,
insert_id, edge_id, adopted: false }`. Validation errors are 400 `INVALID_PAYLOAD` with `extensions.field`. Undo deletes
only the scan rows the batch created (still holding the same file), as the caller, so a caller who may no longer delete
gets 403 and nothing is undone (administrators are not substituted). `GET /files` names a linked scan: `linked_collection`
`surface_scans`, `linked_record_id` the scan, `linked_label` "H13A-#2 (worn)", and `linked_insert_id` / `linked_edge_id`.

## 9. The `d1-inbox` extension (Directus endpoint, plain ESM, like `d1-build`)

All routes run as the caller (Directus accountability); linking writes through `ItemsService` with the caller's
accountability and `knex: trx` so hooks apply. Junction creates are **unfiltered by the permission rules**
(ADR-0011), so the extension itself must refuse a link unless the caller has at least *Can edit* on the target
record, decided by the same function `d1-access-guard` uses. A view-only user is refused (test).

| Route | Who | What |
|---|---|---|
| `GET /d1-inbox/summary` | login | counts: new, older with an exact match, for the person and each of their teams |
| `GET /d1-inbox/files` | login | paged list, filters: tab (new/older/linked/dismissed), kind, folder, date, owner or team, match strength |
| `POST /d1-inbox/link` | login | `{items:[{candidate_id, collection, record_id}]}` in one transaction; returns `link_batch_id`. A surface scan is `{candidate_id, collection:'surface_scans', insert_id\|edge_id, condition, ...}` (§8) |
| `POST /d1-inbox/accept-all` | login | `{filter}` → links only rows with exact short-ID suggestion the caller can edit; returns the batch |
| `POST /d1-inbox/dismiss`, `/restore` | login | state changes |
| `POST /d1-inbox/undo` | login | `{link_batch_id}` removes the junction rows it made and returns the candidates to `new` |
| `POST /d1-inbox/rescan` | login | queue a `person`-scope request; refused if the person has one queued or finished in the last 10 minutes |
| `GET/PUT /d1-inbox/prefs` | login | auto-link opt-in |
| `POST /d1-inbox/auto-link` | machine | only for opted-in people, exact short-ID, one record, caller-as-person edit check; the crawler sends the header `X-Inbox-Crawler-Secret` (env `D1_INBOX_CRAWLER_SECRET`, compared in constant time; 401 when the header is missing, 403 when wrong or when the secret is not configured); body `{candidate_ids: [...]}`, answer `{data: {results: [{candidate_id, status: linked/skipped/error, reason?, link_batch_id?}]}}`; backlog, team-folder, copy, document, other-file, surface-scan and undone-auto-link (`UNDONE`) files are skipped |
| `GET /d1-inbox/admin`, `POST /d1-inbox/admin/scan-all` | administrator | status, last scan, errors, unmatched folders, people without an alias |

*As built (stream B):* a file already linked to the chosen record (for example in Data Studio) is refused 409
`ALREADY_ON_RECORD`: the table's CHECK needs a junction id the batch itself made, and undo must never delete a row it
did not create. Accept-all skips such rows and surface scans (a scan needs a person-chosen condition) but may link
documents and other files with an exact short-ID match (the link adopts them, the confirm says so); auto-link links
images only (`sem_image`, `image`) and also skips backlog, team-folder and copy files. Payload shapes are the ones
STARbase's `inboxApi.ts` reads; a record is named in a list row only to a caller who can read it.

Visibility of a candidate: its owner person's login; any active member of its owner team (the first member to
link or dismiss resolves it for everyone); administrators (all). Candidates are never readable through
Directus's REST (they live in `d1_private`).

## 10. STARbase

- **Inbox** entry at the top of the sidebar (outside the five sections) with the count badge; the same count
  and "N older files match a record" on **Home** (follows the admin attention-panel pattern).
- **Inbox page** (`/inbox`): tabs *New · Older · Recently linked · Dismissed*; rows with the kind's icon and the
  extracted metadata (no thumbnails: see §13), kind, name and folder, size and date, the suggestion and
  *why* (`short ID 3fa9c1d2 in the file name`), buttons Link / Change / Dismiss; filters; **Accept all** with a
  confirm showing the count, one **Undo** per batch; "Rescan my folder".
- Documents: shown under "Other files", collapsed; the Link dialog says "linking reads this file once to
  fingerprint it".
- **People** admin: `uni alias` field (and a "scan while Former" switch). **Teams**: `share folder`.
- **Admin tab** on `/crawler`: inbox crawler status, last scan, errors, unmatched `Users/` folders, people with
  no alias, **Scan all**.
- **Settings:** auto-link switch with the consent text (names what will be linked, that documents are never
  auto-linked, and where the undo is).

*As built (stream F2, the surface-scan form):* a `surface_scan` row's button is **Add a surface scan** (enabled; the row never offers Link or Change)
and opens a dialog (`AddScanDialog.vue`, pure parts in `inboxScan.ts`): an Insert or Edge choice with a search by code through `/items` as the
signed-in user (started with the item the file's path names, when it names one), the **condition** (required, nothing chosen to begin with, the four
options and labels of the Alicona dialog, which also supplies the validation, the operation picker's fields and the lab-wide warning), and
optionally the operation, the day, a condition note and notes. Confirm stays off until an item and a condition are set (and, as in the Alicona
dialog, a note when the condition is *other*), and a second click while the first runs sends one request. The add is the scan item of section 8
sent alone to `POST /d1-inbox/link`; the page never sends a scan to a sample, operation or test. The notice reads *Added as a surface scan of
<code>. It is now visible to every lab member.* with one batch Undo; a repeat is *That file was already added.* with no Undo; every refusal code of
section 8 has its own words (a 400 names the control it is about), and the 403 of an Undo shows verbatim. On *Recently linked* the row reads *Added as
a surface scan of H13A-#2 (worn)* and routes to the insert or edge page by `linked_insert_id` / `linked_edge_id` (STARbase has no page for a scan
row); a batch of scans is titled *Added as a surface scan, 1 file*. Live checks: backlog **IF23** (the STARbase form) and **IF30**.

## 11. Known risks and limits

- The read-only, never-open-a-document guarantee (§3) is the **inbox crawler's**. Other tools can still read files
  under `Users/`: `scripts/index_archive.py --fingerprint` and `scripts/file_fingerprints.py` hash documents they
  find there. `file_fingerprints.py --phase all` skips a document or other non-image file the crawler found that
  nobody has linked or adopted (it keys on the candidate row in `d1_private.file_candidates`, not on the pointer
  row's metadata, which the indexer rewrites and any Lab Member can edit), so an unlinked document is not read by
  that route either, but a person running the indexer by hand reads whatever the indexer's rules cover.
- **Rolling back the migrations: roll back 194 before 193** (194 lists fields that 193 adds). Rolling back 193
  drops every alias (`people.uni_alias`, `people.scan_while_former`), every share folder (`teams.share_folder`),
  every candidate (so every dismissal and every Inbox undo record), every scan request, the crawler state row and
  every auto-link consent (`inbox_prefs`); `directus_files` pointer rows and the junction links people made stay.
  Export `people.uni_alias`, `people.scan_while_former`, `teams.share_folder` and `d1_private.inbox_prefs` first.
  After re-applying, an administrator enters the aliases and folders again, every owner gets a first scan, so
  everything found is Older, and previously dismissed files come back as Older (nothing is counted new).
  A database that applied an EARLIER version of migration 193 (before the review fixes) has neither the auto_undone_at column nor the case-insensitive trigger conditions: roll back 194 then 193 and re-apply, or add the column and recreate the two triggers by hand; nothing live has run it.
- The crawler runs under the maintainer's personal admin SMB account (can write). Mitigated by the read-only
  mount and the build-failing tests, not by the credential. A read-only account is a follow-up.
- Folder mtimes must update reliably on the real share (assumed, to be confirmed on it).
- A file edited in place is not noticed.
- SEM tagging is a guess until validated on real images.
- A code in a file name can drift from its record after a rename.
- Any Lab Member can delete a `directus_files` row today (ADR-0011, until the A1b file-access work), and a found
  file's candidate row cascades from it, so a deletion silently removes someone else's candidate (and its undo
  record). The crawler only re-registers it if the folder's modified time changes. Pre-existing exposure, not
  introduced here; whoever owns ADR-0011's A1b work should know.
- Aliases are the only link between a folder and a person: a Lab Member cannot set one (create list, insert
  trigger and update list all exclude it), but an administrator's typo routes someone's files to the wrong
  person until fixed; fixing it resets that owner's undecided files (§5).
- Directus uploads are not backed up (pre-existing, unrelated).

## 12. Testing

Unit and integration tests per stream (plan). Read-only AST test (§3). Recognition table tests including dates,
two-record collisions, edge codes. Extension tests with fake knex: edit-rights refusal, batch atomicity, undo,
rate limit, auto-link guards. DB: schema checks in `tests/phase1_schema.sh`. UI: component and model tests.
Things only the real share/rig can confirm go into `docs/runbooks/physical-test-backlog.md` (§ in the plan).

## 13. Out of scope (v1)

OCR validation, instruments beyond JEOL, force/`.D1*` file recognition, GitHub resources, a general
notification centre, a group-wide auto-link switch, scanning `Shared/` root files, file editing of any kind,
serving share bytes through Directus.

## 14. Thumbnails and full view (follow-up, 2026-10-16)

Directus declares no `star` storage, so its asset route cannot serve pointer rows, and serving share bytes through
Directus stays out of scope (Directus does not even mount the share). Instead the **crawler writes small derived
pictures into the database**, and `d1-inbox` serves those. The share is still only read.

- **Who and when.** Only kinds `image` and `sem_image` (decoded with the same limits as classification: formats TIFF,
  JPEG, PNG, BMP; `MAX_PIXELS`; files up to `CLASSIFY_MAX_BYTES`). Documents, surface scans and everything else get none, and a
  document is still never opened. At registration the crawler already holds the image bytes in memory (it hashes and
  classifies them), so a new file costs no extra share read. Files registered before this existed are filled in by a
  throttled backfill step that reads through `fs_readonly` like any other read.
- **What.** A `thumb` (about 320 px on the long side, JPEG) for the row and a `preview` (about 1600 px, JPEG) for the
  full view. The preview is a reduced copy, never the original: the dialog says so. Both are derived data, replaceable
  from the share, and live in `d1_private.file_thumbnails` (not exposed in Directus). Rows go with their candidate
  (`ON DELETE CASCADE`) and are removed when the file is marked gone. Switch off with `INBOX_THUMBNAILS=0`.
- **Failures and staleness.** An image that cannot be decoded gets a marker row in the same table (both pictures NULL, a short
  `failed_reason`), keyed on the file's size and modification time like a picture, so it is not read again until the file
  changes. The backfill works only for owners the scan would scan now, below their current folder and outside ignored folders.
  A picture is made once, when the file is first seen: a file re-saved at the same path keeps its old picture until it moves.
- **Serving.** `GET /d1-inbox/files/:candidate_id/thumb` and `/preview` answer `image/jpeg` with the same visibility as
  the list (a person's own Inbox and their teams'), `Cache-Control: private`, an ETag, and 404 when the caller cannot
  see the file or it has none. `FoundFile` gains one additive field, `has_thumbnail: boolean`.
- **UI.** A row with `has_thumbnail` shows the thumbnail in place of the icon, loaded lazily (visible rows only, a few
  at a time) with a shimmer while it loads and the kind's icon if it fails. Clicking opens a dialog with the preview
  (spinner while it loads, the thumbnail shown meanwhile, Esc/click outside closes, keyboard reachable). Pictures
  are fetched with the signed-in session as blobs, so no unauthenticated URL exists.
- **Not in v1.** Zoom/pan, thumbnails for linked records elsewhere in STARbase, `.al3d` renders, document previews.

## 15. Ignored folders (follow-up, 2026-10-16)

A person can tell the crawler to leave a folder alone ("ignore this folder when scanning"). Decisions, taken with the
user's request as the only input; each is cheap to change:

- **Scope.** A rule belongs to the owner of the folder it sits under: a person for their own folder, a team for its
  team folder. A person manages their own rules; a team member manages the team's (the same people who may link a team file).
  Table `d1_private.inbox_ignored_dirs(owner_person_id | owner_team_id, rel_folder, created_at, created_by)`; not exposed in Directus.
- **Matching.** A rule is a folder path *relative to the owner's root* (`World-Ti Paper/Drafts`, not `Users/abc12de/...`),
  matched on whole path parts, case-insensitively (the share is case-insensitive), covering the folder and everything under
  it. No wildcards. The root itself cannot be ignored; no leading or trailing slash, no `.` or `..` parts, at most 200 rules per owner.
- **Crawler.** An ignored subtree is neither listed nor statted (lower load on the share, which is the point). It
  is *not scanned*, which is different from *empty*: the missing-file sweep must never mark candidates under it `gone`. A
  rule is read when the crawler starts an owner and again before it lists a folder and before each batch of
  registrations, so a rule added mid-scan stops the walk of its folder within a batch (it only ever makes the
  crawler read less).
- **Existing files.** Adding a rule dismisses the owner's open (`new`) candidates under it in the same transaction, as an
  ordinary, restorable dismissal; linked files are untouched. Removing a rule resets the folder's cache rows
  (`dir_mtime` and `last_listed_at` set to NULL for the folder and everything below it; the rows are kept, because the crawler
  reaches a folder through its cached parent and keeps a "seen, not listed" row for every ignored folder) so the next
  scan lists it again (queued as a rescan when the rate limit allows); files dismissed by the rule stay in Dismissed until
  restored by hand.
- **Endpoint.** `GET /d1-inbox/ignored-folders`, `POST /d1-inbox/ignored-folders { folder, team_id? }` (answers
  the rule and how many files were dismissed), `DELETE /d1-inbox/ignored-folders/:id`. Errors in the d1-record-access shape.
- **UI.** A row's folder offers "Ignore this folder" (confirm says what happens: the files below move to Dismissed, nothing on the share
  is touched); the Inbox gets an "Ignored folders" section listing the rules with Remove, and an add-by-picking field fed by the folders already known.
- **Not in v1.** Wildcards or patterns, ignoring by file type, admin-wide rules.
