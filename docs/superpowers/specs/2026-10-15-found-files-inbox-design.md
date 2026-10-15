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
| D10 | **Auto-link** is per person, off by default, consent text on the switch; only exact short-ID, one record, one the person can edit; images and surface scans only; listed under "Recently auto-linked" with undo; audited. No team auto-linking, no group-wide switch in v1. |
| D11 | The same image in two inboxes shows once (where first seen); the copy is marked "copy of" and drops out when the original is linked or dismissed. |
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
  `CHECK (uni_alias !~ '^[.]+$')` so `..` cannot walk out of `Users/`; unique on `lower(uni_alias)` where not null
  (`people_uni_alias_key`). `people.scan_while_former BOOLEAN NOT NULL DEFAULT false`. Kept out of Lab
  Member create and update: not in their `people` update field list, and a `BEFORE INSERT` trigger on `people`
  refuses a new row that sets either column (*as built*; error `uni_alias and scan_while_former can only be set by
  an update`), so only an administrator's UPDATE sets them. Stream B also narrows the Lab Member create field list.
- `teams.share_folder TEXT` — nullable; `CHECK (share_folder !~ '[\\/]' AND btrim(share_folder) <> '')` and (*as built*)
  `CHECK (btrim(share_folder) !~ '^[.]+$')`; unique on `lower(share_folder)` where not null
  (`teams_share_folder_key`).
- *As built:* teams are keyed by `team_id` (not `id`), so every team foreign key below is `teams (team_id)`.

**d1_private** (not exposed in Directus; reached only through the `d1-inbox` extension, like pins and drafts)

- `file_candidates`
  - `candidate_id UUID PK DEFAULT uuid_generate_v4()`, `directus_files_id UUID NOT NULL UNIQUE REFERENCES
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
    `(suggested_record_id)`; *as built* also partial `(duplicate_of)` and `(adopted_at)`
- `inbox_dirs` — the folder cache: `rel_path TEXT PK`, `owner_person_id`, `owner_team_id` (same check and
  `ON DELETE CASCADE` foreign keys; each owner column is indexed),
  `dir_mtime TIMESTAMPTZ`, `last_listed_at`, `baselined_at TIMESTAMPTZ` (set on the owner's root row when their
  first complete scan ends; files first seen before that are `origin='backlog'`).
- `inbox_scan_requests` — `request_id UUID PK`, `scope TEXT CHECK (scope IN ('person','all'))`,
  `person_id UUID REFERENCES people ON DELETE CASCADE` (*as built:* required exactly when `scope = 'person'`),
  `requested_by UUID REFERENCES directus_users ON DELETE SET NULL`, `requested_at NOT NULL DEFAULT now()`,
  `started_at`, `finished_at`, `status TEXT NOT NULL DEFAULT 'queued' CHECK
  (status IN ('queued','running','done','failed'))`, `error TEXT`. Indexes `(status, requested_at)` (the daemon's
  claim) and partial `(person_id, requested_at DESC)` (the rate limit).
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
`record_by_short_id()`, `short_ids`.

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
short-ID match, and kind in (`sem_image`,`image`,`surface_scan`): the crawler asks the `d1-inbox` extension
(`POST /d1-inbox/auto-link`, machine credential) to link it on the person's behalf. The crawler never writes
the junction itself.

**Hash after adoption.** When a person links a document, the extension marks the candidate; the crawler reads
it once (`open_rb(..., adopted=True)`), hashes it and writes `file_fingerprints`.

**When an alias or share folder changes.** Triggers on `people` (`AFTER UPDATE OF uni_alias`) and `teams`
(`AFTER UPDATE OF share_folder`), firing only when the value really changes (`IS DISTINCT FROM`; setting it to
`NULL` counts), delete that owner's `inbox_dirs` rows and that owner's `file_candidates` in state `new`, `gone`
and `dismissed`. Candidates in state `linked` are kept (the link is a decision and its undo bookkeeping must
survive). The cache and the undecided rows described the old folder, so left alone they would strand. The owner's
next scan is a first scan of the new folder: everything in it is backlog and `baselined_at` is set again. An
UPDATE that leaves the value as it was deletes nothing.

## 6. Recognition (`recognise.py`, pure functions)

- Tokenise the relative path on `/ \ _ - . space`. Candidates: runs of `[0-9a-f]{8,32}` (lower-cased input) that
  are not all digits.
- A token counts only if `short_ids` contains it exactly (lookup, never a regex on the database).
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

The surface-scan table, viewer and derivatives belong to the "Alicona files and GitHub resources" chat; its
design (reported by that chat, confirmed by the maintainer there) says Alicona files belong to an insert or an
edge, each with a condition and an optional operation, added through the ADR-0018 write path. This feature:
detects and tags `kind='surface_scan'`; on confirm, the Inbox dialog collects item, condition and optional
operation and calls that chat's write path. Neither writes the other's tables; the scan row is the contract.
**Until that contract exists the stream F (surface-scan confirm form) is blocked**; scans still appear in the
Inbox as found files and cannot be linked yet.

## 9. The `d1-inbox` extension (Directus endpoint, plain ESM, like `d1-build`)

All routes run as the caller (Directus accountability); linking writes through `ItemsService` with the caller's
accountability and `knex: trx` so hooks apply. Junction creates are **unfiltered by the permission rules**
(ADR-0011), so the extension itself must refuse a link unless the caller has at least *Can edit* on the target
record, decided by the same function `d1-access-guard` uses. A view-only user is refused (test).

| Route | Who | What |
|---|---|---|
| `GET /d1-inbox/summary` | login | counts: new, older with an exact match, for the person and each of their teams |
| `GET /d1-inbox/files` | login | paged list, filters: tab (new/older/linked/dismissed), kind, folder, date, owner or team, match strength |
| `POST /d1-inbox/link` | login | `{items:[{candidate_id, collection, record_id}]}` in one transaction; returns `link_batch_id` |
| `POST /d1-inbox/accept-all` | login | `{filter}` → links only rows with exact short-ID suggestion the caller can edit; returns the batch |
| `POST /d1-inbox/dismiss`, `/restore` | login | state changes |
| `POST /d1-inbox/undo` | login | `{link_batch_id}` removes the junction rows it made and returns the candidates to `new` |
| `POST /d1-inbox/rescan` | login | queue a `person`-scope request; refused if the person has one queued or finished in the last 10 minutes |
| `GET/PUT /d1-inbox/prefs` | login | auto-link opt-in |
| `POST /d1-inbox/auto-link` | machine | only for opted-in people, exact short-ID, one record, caller-as-person edit check |
| `GET /d1-inbox/admin`, `POST /d1-inbox/admin/scan-all` | administrator | status, last scan, errors, unmatched folders, people without an alias |

Visibility of a candidate: its owner person's login; any active member of its owner team (the first member to
link or dismiss resolves it for everyone); administrators (all). Candidates are never readable through
Directus's REST (they live in `d1_private`).

## 10. STARbase

- **Inbox** entry at the top of the sidebar (outside the five sections) with the count badge; the same count
  and "N older files match a record" on **Home** (follows the admin attention-panel pattern).
- **Inbox page** (`/inbox`): tabs *New · Older · Recently linked · Dismissed*; rows with thumbnail (via the
  existing Directus thumbnail route for images), kind, name and folder, size and date, the suggestion and
  *why* (`short ID 3fa9c1d2 in the file name`), buttons Link / Change / Dismiss; filters; **Accept all** with a
  confirm showing the count, one **Undo** per batch; "Rescan my folder".
- Documents: shown under "Other files", collapsed; the Link dialog says "linking reads this file once to
  fingerprint it".
- **People** admin: `uni alias` field (and a "scan while Former" switch). **Teams**: `share folder`.
- **Admin tab** on `/crawler`: inbox crawler status, last scan, errors, unmatched `Users/` folders, people with
  no alias, **Scan all**.
- **Settings:** auto-link switch with the consent text (names what will be linked, that documents are never
  auto-linked, and where the undo is).

## 11. Known risks and limits

- The crawler runs under the maintainer's personal admin SMB account (can write). Mitigated by the read-only
  mount and the build-failing tests, not by the credential. A read-only account is a follow-up.
- Folder mtimes must update reliably on the real share (assumed, to be confirmed on it).
- A file edited in place is not noticed.
- SEM tagging is a guess until validated on real images.
- A code in a file name can drift from its record after a rename.
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
