# Surface scans on inserts and edges: plan

> **For agentic workers:** work your stream only, in your own worktree. Commit after every step. Never
> push, merge, rebase or edit the Status table.

**Spec:** [`docs/superpowers/specs/2026-10-15-surface-scans-design.md`](../specs/2026-10-15-surface-scans-design.md)
(the row contract, the derived-data layout and the endpoint routes are there; code against them).
**ADR:** [0020](../../adr/0020-surface-scans-on-inserts-and-edges.md).
Read the spec, `CONTEXT.md` and the conventions skill of your area first.

**Branch:** `ccr-6b593491-4alqyj` (the coordinator's branch; streams branch from it, the coordinator merges and
opens one PR).

**Commit trailer lines** (end every commit message with them):

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NbxXFsBQbJUfCfYzsigV9M
```

## Status

| Stream | Worktree | Branch | State |
|---|---|---|---|
| S1 server (migration, Directus metadata, access rules, `d1-surface-scan` endpoint) | | | not started |
| S2 worker (`plugins/surface-scan-worker`) | | | not started |
| S3 STARbase (panel, add dialog, 3D viewer) | | | not started |
| Integration, Opus review, CI, PR | main checkout | `ccr-6b593491-4alqyj` | not started |

Order: the three streams are independent (they share only the spec's contract), so they run in parallel.
Then the coordinator merges them, runs the checks, has an Opus reviewer read the whole diff, fixes findings,
pushes once and opens the PR.

## S1 server (agent: `d1-server-implementer`)

Owns: `db/migrations/<next>_surface_scans.sql`, `scripts/access_rules.json` (smallest edit),
`tests/phase1_schema.sh` (smallest edit), `core/extensions/d1-surface-scan/`, MinIO env on the Directus
service in `docker-compose.yml`, `.env.example`, `docs/runbooks/physical-test-backlog.md` (add the three items
the spec lists, with bold ids), wiki page under `docs/wiki/database/` if the repo keeps one per table group.

1. Migration: the `surface_scans` table exactly as in the spec's row contract, reversible up/down, COMMENT on
   the table and every column, the OCC/audit/owner conventions of `insert_edges`, indexes on `insert_id`,
   `edge_id`, `directus_files_id`, `render_status`. Directus collection and field metadata (labels, notes,
   conditions as dropdown, `render_*`/`cache_key`/`grid_*`/`z_*` read-only and hidden from the form, relations to
   insert, edge, file, operation), following migration `20261014000174_form_layout.sql` and
   `20260703000059_test_method_fields_meta.sql`. Re-scan every origin branch for the next free number right
   before creating the file (a sibling session is also adding migrations). Prove up, down, up with the
   db-migration skill's scripts.
2. Access: `surface_scans` is reference data readable and writable by every member (like `insert_edges`);
   add it to the `unfiltered` list in `scripts/access_rules.json` and to the readers/phase-1 checks the repo
   keeps for that list. Add it to the text-to-SQL allow list only if the precedent migration for
   `insert_edges` did (`20261003000132_llm_readonly_allow_list.sql`).
3. Extension `d1-surface-scan` (plain ESM `index.js`, `index.test.mjs`, `node --test`): the four routes in the
   spec. Read the row through `ItemsService` with `req.accountability` (so permissions apply), fetch the object
   from MinIO (the S3 API; keep the client behind a small module so the test fakes it), stream it with ETag and
   `Cache-Control: private`. 404 while `render_status` is not `done`. `POST .../render` sets `pending`, clears
   `render_error`, as the caller. Copy the shape of a precedent extension (route wrapper, HttpError,
   Directus-shaped errors).
4. Docker/env wiring for MinIO access from Directus; do not add a second archive mount.

Tests to run: `node --test` in the extension, the migration up/down/up proof, `bash tests/phase1_schema.sh` if
it runs without live services, JSON validity of `access_rules.json`.

## S2 worker (agent: `d1-server-implementer`, follow `.claude/skills/new-plugin/SKILL.md`)

Owns: `plugins/surface-scan-worker/`, and the compose, `.env.example`, Makefile, CI and plugins README entries
the `new-plugin` skill lists. Does not own `docker-compose.yml` Directus settings (S1).

1. Scaffold from `plugins/plugin-template`; mirror `plugins/heavy-data-worker` for MinIO and webhook patterns.
2. Render pipeline exactly as in the spec: pick `pending` rows (webhook plus a poll), set `rendering`, resolve
   the file from `directus_files.metadata.archive_path` under `/mnt/archive` **opened read-only**, read it with
   SurfaceTopography (`SurfaceTopography` on PyPI, MIT), decimate (NaN-aware block mean to at most 1024 on the
   longer side), write `grid.bin`, `meta.json`, `thumb.png` under `surface-scans/<cache_key>/`, fill the row,
   set `done`; any failure sets `failed` plus `render_error`. One or two renders at a time.
3. Cache key: `file_fingerprints.content_sha256` for the file when its status is `done`, otherwise
   `p-<directus_files_id>-<size>-<mtime>`. **The worker never hashes a file and never writes
   `file_fingerprints`.** Cache hit: skip reading the file.
4. The archive volume is mounted `:ro`; refuse any path outside `/mnt/archive` (path traversal) and never open
   a file whose extension is not a topography format SurfaceTopography reads.
5. Tests with pytest on synthetic files (generate a small file in a format the library writes or reads; do not
   commit real data): decimation, NaN handling, cache key choice, failure paths, path refusal, the
   `grid.bin`/`meta.json` layout.

Tests to run: `pytest` in the plugin, the repo's lint for Python.

## S3 STARbase (agent: `directus-ui-implementer`)

Owns: new files under `packages/starbase-pages/src/pages/` for the panel, dialog and viewer, the smallest
edit to the insert and edge record pages and to `routes.ts` if needed, tests, the tooling wiki page.

1. `SurfaceScanViewer` as in the spec (three.js, the conventions of `pages/tooling/stage/scene`): float
   `DataTexture` from `/d1-surface-scan/<id>/grid` and `/meta`, plane displaced in the vertex shader,
   exaggeration slider and colour-by-height as uniforms, `NaN` cells discarded, orbit and zoom, a legend with
   the height range in micrometres. Pure logic (parsing, scaling, colour ramp) in testable modules.
2. **Surface scans** panel on the insert and edge pages: thumbnail (`/thumb`), condition, date, status,
   "Render again" on failed. The edge page also lists its insert's scans.
3. **Add a surface scan** dialog: file from the library, condition, note, date, optional operation, and the
   lab-wide visibility warning; creates the row with a plain Directus create. Handle OCC and errors like the
   existing forms.
4. Tests: vitest for the logic; extend the stub in `tests/ui/starbase/stubD1.ts` so a headless Chromium
   spec renders the viewer from a synthetic grid (use the repo's headless pattern; the tooling 3D page has
   one). Take a screenshot.

Tests to run: the package's typecheck, lint and vitest, the headless spec.

## Follow-ups (not in this PR)

- F1 guarded dry-run script that lists Alicona Tests whose subject is an edge and proposes surface scans.
- F2 `CONTEXT.md` section (Surface scan, condition) after PR #310 merges.
- F3 inbox form for `kind = surface_scan` (sibling session).
