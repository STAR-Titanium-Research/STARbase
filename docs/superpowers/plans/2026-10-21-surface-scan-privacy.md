# Surface scans follow their file's provenance owner: plan

> **For agentic workers:** work your stream only, in your own worktree. Commit after every step. Never push, merge, rebase or
> edit the Status table. Your worktree is created from the coordinator's branch, so the spec and ADR are already in it; if a
> file is missing, read it with `git show ccr-6b593491-4alqyj:<path>` and do not try to merge.

**Spec:** [`docs/superpowers/specs/2026-10-21-surface-scan-privacy-design.md`](../specs/2026-10-21-surface-scan-privacy-design.md)
(the contracts, the rules and the migration are there; code against them). **ADR:**
[0023](../../adr/0023-surface-scans-follow-their-files-owner.md). Also read ADR-0022, CLAUDE.md, CONTEXT.md and the conventions
skill of your area.

**Branch:** `ccr-6b593491-4alqyj` (the coordinator's; streams branch from it, the coordinator merges and opens one PR).

**Commit trailer lines** (end every commit message with them):

```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NbxXFsBQbJUfCfYzsigV9M
```

## Status

| Stream | Worktree | Branch | State |
|---|---|---|---|
| S1 schema, rules, guard (migration 205, access rules, generator, d1-access-guard, phase1 tests) | | | not started |
| S2 endpoint (`d1-surface-scan`: `/scans`, lock checks, `/result`, access log) | | | not started |
| S3 worker (`plugins/surface-scan-worker`: report through `/result`) | | | not started |
| S4 STARbase (`pages/surface`: locked placeholder, warning, error states) | | | not started |
| Inbox text and comments (another session's files) | | | waiting for the inbox session |
| Integration, Opus review, CI, PR | main checkout | `ccr-6b593491-4alqyj` | not started |

Order: S1 to S4 run in parallel against the spec's contracts (fakes where the other side is missing). They ship as one release.

## S1 schema, rules, guard (agent: `d1-server-implementer`, skill db-migration)

Owns: `db/migrations/20261021000205_surface_scans_follow_file_owner.sql` (re-scan every origin branch for the next free number
right before creating it), `scripts/access_rules.json`, `scripts/gen_access_rules.py`, `core/extensions/d1-access-guard/`
(`index.js`, its tests, regenerated `rules.json`), `scripts/configure_users_and_policies.sql` (regenerated), `tests/phase1_schema.sh`,
`tests/scripts/test_access_rules.py`, `docs/data-dictionary.md`, the ADR-0021 and ADR-0022 headers (note that decision 4 of 0021 is
superseded by 0023; decision 6 of 0022 is fulfilled by it), `docs/adr/README.md` (row for 0023), `CONTEXT.md` (the Add a surface scan
sentence "Adding it makes the file visible to every lab member" and the Flagged-ambiguities text if it says so), and
`docs/runbooks/physical-test-backlog.md` (SS4 to SS7 and the SS1 / SCAN-UI1 amendments from the spec).

Do the migration exactly as the spec says: the private tables, the data move, the reset trigger, Directus metadata, the backup of
the old rules, the `NOTICE`, a reversible down. Prove up, down, up with the db-migration skill's scripts; phase1's replay of
migration 192's down must run 205's down first. Postgres-backed tests for the visibility rule and every permission row.

## S2 endpoint (agent: `d1-server-implementer`)

Owns: `core/extensions/d1-surface-scan/` (`index.js`, `objectStore.js` only if needed, tests). Build the routes and the visibility
rule from the spec: `GET /scans`, the lock check before the ETag/304 branch on `grid|meta|thumb`, `cache_key` from
`surface_scan_renders`, the admin access-log row, `POST /:id/render` clearing the private error, `POST /:id/result` (administrators only,
OCC on `version` and `render_status='rendering'`). Fake knex and services as the existing tests do; cover every person and case the
spec lists.

## S3 worker (agent: `d1-server-implementer`)

Owns: `plugins/surface-scan-worker/app/lib/directus_client.py`, `app/jobs/render_scan.py`, `app/poller.py`, their tests, the
plugin README, `docs/runbooks/surface-scan-worker.md`. Report render results and failures through
`POST /d1-surface-scan/:id/result` with the version read, retrying on 409; drop `render_error` and `cache_key` from `SCAN_FIELDS`.
The share stays read-only; no database credential; the worker never hashes a file. Keep the id-matches-archive_path check.

## S4 STARbase (agent: `directus-ui-implementer`)

Owns: `packages/starbase-pages/src/pages/surface/**`, `tests/ui/starbase/stubScans.ts`, and the STARbase tooling wiki page. Read
`GET /d1-surface-scan/scans`; the locked tile; the new warning text; the `403 FILE_LOCKED` error text; the stub and the dom tests.
Do **not** touch the inbox files (`inboxScan.ts` and its tests): they belong to the inbox session.

## Inbox files (not in this plan's streams)

`core/extensions/d1-inbox/index.js` comments and `inboxScan.ts` `scanAddedText` plus its four tests say scans are lab-wide. The inbox
session decides whether it changes them or the coordinator does after its agreement.
