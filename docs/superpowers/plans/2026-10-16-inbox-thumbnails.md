# Inbox thumbnails and full view

Spec: `docs/superpowers/specs/2026-10-15-found-files-inbox-design.md` section 14. ADR-0020 still holds: the crawler
only reads the share; the new table holds derived pictures, never share bytes served as files.

## Global constraints

- Read-only on the share is an invariant. The thumbnail code takes in-memory bytes (`io.BytesIO`), never a path
  or handle; the backfill reads through `fs_readonly.open_rb` with the same throttle as other reads. The AST allow-list test
  (`tests/scripts/test_inbox_crawler_readonly.py`) must keep passing and cover the new module.
- Only `image` and `sem_image` kinds. Never open documents, never thumbnail `.al3d`.
- Contract (stream A defines it, B and C follow it exactly):
  - table `d1_private.file_thumbnails(candidate_id uuid PRIMARY KEY REFERENCES d1_private.file_candidates(candidate_id) ON DELETE CASCADE,
    thumb bytea NOT NULL, preview bytea NOT NULL, thumb_width int, thumb_height int, preview_width int, preview_height int,
    source_size bigint NOT NULL, source_mtime timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`, JPEG bytes.
    Check the real PK/FK names in migration 193 first. Reversible migration, next free number after
    `20261016000195` (check `origin/main` right before you commit). `tests/phase1_schema.sh` and `docs/data-dictionary.md` updated.
  - `FoundFile.has_thumbnail: boolean` (additive). `GET /d1-inbox/files/:candidate_id/thumb|preview`, as in spec section 14.
- Size targets: thumb about 10 to 25 KB, preview about 150 to 400 KB (JPEG quality ~75 to 82, `Image.thumbnail` with LANCZOS, 16-bit and
  palette/CMYK/RGBA modes normalised to RGB, first frame of a multi-page TIFF, EXIF orientation applied).
- CI: ruff 0.6.9 pinned (pre-commit), every compose variable an uncommented `VAR=` line in `.env.example`, one trailing newline.
  Rig-only checks go into `docs/runbooks/physical-test-backlog.md` with bold ids (next free `IF` ids).

## Status

| Stream | What | Agent profile | Worktree / branch | State |
|---|---|---|---|---|
| A | Migration, `d1-inbox` thumb/preview routes, `has_thumbnail`, golden fixtures, schema tests | `d1-server-implementer` | `feat/thumbs-a-server` | merged, reviewed, fixed |
| B | `scripts/inbox_crawler/thumbs.py`, registration hook, backfill step, cleanup on gone, `INBOX_THUMBNAILS`, runbook | `inbox-crawler-implementer` | `feat/thumbs-b-crawler` | merged, reviewed, fixed |
| C | STARbase: lazy thumbnail in the row, shimmer, lightbox with preview and spinner, fake server, tests | `directus-ui-implementer` | `feat/thumbs-c-ui` | merged, reviewed, fixed; UI minor fixes in progress |
| R | Opus review of all three, fixes, CI | reviewers + coordinator | `ccr-f5ece72d-pvkcct` | review done; UI minor fixes in progress |

## Stream A: server (`d1-server-implementer`)

Migration and table above. In `core/extensions/d1-inbox/index.js`: `has_thumbnail` in `fileOut` (an `EXISTS` in the list query or a
joined boolean, not the bytes), and two GET routes that reuse the list's visibility predicate (do not write a second one: the owner rules
are being tightened elsewhere and must apply to pictures too). Send `Content-Type: image/jpeg`, `Cache-Control: private, max-age=3600`,
`ETag` (hash of the stored bytes or `source_mtime`+size), honour `If-None-Match` with 304, 404 for not visible or no picture, no
`res.json` wrapping. Regenerate the golden fixtures (`contract_fixtures.mjs`) and add a visible/not visible/none/304 test with the fake knex.
Update the header contract comment. Do not touch UI files.

## Stream B: crawler (`inbox-crawler-implementer`)

`thumbs.py`: `make_thumbnails(data: bytes) -> Thumbs | None` (pure, same decode limits as `classify_sem`; None on any decode failure, never raises
out). `db.py`: `store_thumbnails`, `candidates_missing_thumbnails(limit)` (kinds image and sem_image, state new or dismissed or linked, no row or a row whose
size/mtime differs from the candidate's), `delete_thumbnails`. `scan.py`: at registration, when `hashed.data` is in hand, make and store the thumbnails in the same
transaction as the candidate. `daemon.py`: a backfill step each tick for a bounded batch, throttled, reading with `fs_readonly.open_rb` (not adopted),
skipping files that vanished. Marking a candidate `gone` deletes its thumbnail. `INBOX_THUMBNAILS=0` turns generation and backfill off (compose, `.env.example`, runbook).
Tests with real small images (TIFF 16-bit, JPEG, PNG, truncated file, huge pixel count), and extend the read-only test.

## Stream C: STARbase (`directus-ui-implementer`)

`FoundFile.has_thumbnail`, `inboxApi.ts` (`loadPicture(api, candidateId, 'thumb'|'preview')` fetching a blob with `responseType: 'blob'`; extend
`HostRequestConfig` if it lacks it), a small picture cache and queue (max 4 in flight, only rows scrolled into view, object URLs revoked when
rows go), `InboxRow.vue` (thumbnail button replacing the icon: shimmer while loading, icon on failure, visible focus, `aria-label`),
`PreviewDialog.vue` (preview with spinner, thumbnail blurred meanwhile, name, folder and extracted values, the line "Reduced-size preview. The original stays on the
share.", Esc and backdrop close, focus returns to the thumbnail, respects `prefers-reduced-motion`). Update `fakeInboxServer.ts`, model/api/dom tests,
and the Playwright spec `tests/ui/specs/22-inbox.spec.ts`. The golden-fixture contract test will need stream A's fixtures: leave a clear note in your hand-back.
