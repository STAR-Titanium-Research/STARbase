# Inbox: ignore folders when scanning

Spec: `docs/superpowers/specs/2026-10-15-found-files-inbox-design.md` section 15. ADR-0020 holds: read-only on the share. A rule makes the
crawler read *less*; it adds no share access.

## Global constraints

- Contract (stream A defines it; B and C follow it exactly):
  - table `d1_private.inbox_ignored_dirs(ignored_id uuid PK DEFAULT gen_random_uuid(), owner_person_id uuid, owner_team_id uuid, rel_folder text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), created_by uuid)`; exactly one owner set (CHECK, as `inbox_dirs` does); FKs with the same delete actions
    as `inbox_dirs`; `rel_folder` CHECK (no leading/trailing `/`, no empty, `.` or `..` parts); unique `(coalesce(owner_person_id, owner_team_id), lower(rel_folder))`; at most 200 per owner
    (enforced in the endpoint). Check real names in migration 193. Reversible; number: next free after the thumbnails migration `20261016000198`
    (check `origin/main` and the other open branches' migrations right before committing; the SEM chat took 196 and 197).
  - routes as spec section 15; `POST` runs rule insert + dismissal of open candidates under it in ONE transaction using the same dismissal SQL as `/dismiss`.
    Answer `{ data: { ignored_id, folder, team_id, dismissed } }`. `GET` answers `{ data: [{ ignored_id, folder, owner: { kind, id, name }, created_at, can_remove }] }`.
- Matching helper: one pure function per language (JS in `d1-inbox`, Python in `scripts/inbox_crawler/`) with the same table of cases in both test files:
  `is_ignored(rel_folder_of_candidate_or_dir, rules)` true when equal to a rule or beneath it on whole path parts, case-insensitive, `World-Ti Paper` does not cover `World-Ti Paper 2`.
- CI: ruff 0.6.9 pinned, `.env.example` rules, one trailing newline, rig-only checks in `docs/runbooks/physical-test-backlog.md` with bold `IF` ids.

## Status

| Stream | What | Agent profile | Worktree / branch | State |
|---|---|---|---|---|
| IA | Migration, endpoint routes, matching helper, golden fixtures, schema tests | `d1-server-implementer` | `feat/ignore-a-server` | not started |
| IB | Crawler skips ignored subtrees, sweep never marks them gone, rule changes honoured next scan, tests, runbook, backlog | `inbox-crawler-implementer` | `feat/ignore-b-crawler` | not started |
| IC | STARbase: "Ignore this folder" on a row, Ignored folders section, confirm text, fake server, tests (after the thumbnails UI stream is merged: same files) | `directus-ui-implementer` | `feat/ignore-c-ui` | not started |
| R | Opus review, fixes, CI | reviewers + coordinator | `ccr-f5ece72d-pvkcct` | not started |

## Stream IA: server

Migration, tests in `tests/phase1_schema.sh`, data dictionary. In `core/extensions/d1-inbox/index.js` three routes using the `route()` wrapper and the
existing scope checks (person's own rules; team member for team rules; a Lab Viewer is refused writes like every write). Validation per the contract
with clear messages. Fake-knex tests incl. dismissal count, restore of a dismissed file, a linked file untouched, duplicate rule 409, 200-rule cap, another person's rule 404.
Golden fixtures regenerated. Do not touch UI or crawler files.

## Stream IB: crawler

Load the owner's rules once per scan (`db.py`). In `scan.py` skip listing and statting of any directory that is ignored, and treat an ignored subtree
as *not scanned* in the missing-file sweep (candidates there keep their state, whatever it is). Never read a file below an ignored folder, including the thumbnail backfill and
the adopted-hash queue (document hashing of already linked files is NOT stopped: a linked file keeps being tracked; say so in a comment and a test).
Mid-scan rule changes: next scan. Read-only AST test stays green. Tests with a real temp tree and the DB world fixture: ignored subtree not listed, rule removal re-lists it,
`World-Ti Paper` vs `World-Ti Paper 2`, case difference, nested rules, owner isolation, abort mid-scan marks nothing gone.

## Stream IC: STARbase (after the thumbnails UI stream is merged)

As in spec section 15 UI bullet; `inboxApi.ts` three calls, `useIgnoredFolders.ts`, `IgnoredFolders.vue`, confirm text via `inboxModel.ts`, fake server, tests, Playwright spec.
