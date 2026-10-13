# Runbook: Applying record access (A1a) to the live deployment

**System:** D1-Database
**Scope:** the maintainer applies the A1a release to the running compose stack with real data and real Lab Member
accounts. Design: ADR-0013 and the spec below.
**Applies to:** the four A1a migrations, in this order: `20261012000165_record_access.sql`,
`20261012000166_record_readers_and_rules.sql`, `20261012000167_project_rollup_restricted.sql`,
`20261012000168_llm_role_row_security.sql` (confirm the numbers with `make migrate-status`; if main has gained migrations
since, they must sort **below** 165 or be renumbered before the merge) and the extensions `d1-access-guard`, `d1-record-access`, `d1-trace` and the rebuilt
`d1-home`. Design: `docs/superpowers/specs/2026-10-12-record-access-design.md`.

**Order matters.** The permission rows of the second migration walk the new hidden `access` aliases of the first.
If Directus serves those rows before its schema cache knows the aliases, every Lab Member read fails (the incident
pattern of migration 160). The new `restricted` guard in `d1-access-guard` and the `d1-record-access` endpoint must
be live when the rules are, or `restricted` is not guarded over the API and the dialog has nothing to talk to. So:
**deploy the extensions and apply all four migrations in one window, then flush Redis and restart Directus once,
after all of them.** Do it in a quiet window and tell members first. A1a has no UI that turns Restricted on (that is
A1b), but the rules and the endpoint are live from the restart.

## 0. Before the window

- On the branch: `git fetch && git merge origin/main`; confirm `ls db/migrations | tail -6` shows 164 and any later
  numbers **below** A1a's four, and that CI is green (migrations round trip, node tests, vitest, smoke with
  `D1_SMOKE_REQUIRE_LM=1`). A migration numbered below the newest recorded one is skipped silently by dbmate.
- **Read-only preflight (run it on live before the window; it changes nothing).**
  ```sql
  -- dangling logins: rows naming a login that no longer exists (must be 0 and 0, else clean up first, below)
  SELECT (SELECT count(*) FROM sample_co_owners c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id)) AS dangling_co_owners,
         (SELECT count(*) FROM project_investigators c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id)) AS dangling_investigators;
  -- those two columns must have no foreign key to directus_users yet (migration 166 adds them): expect 0 rows
  SELECT conrelid::regclass, conname FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'directus_users'::regclass AND conrelid IN ('sample_co_owners'::regclass, 'project_investigators'::regclass);
  SHOW max_locks_per_transaction;   -- the big cascades peaked at 159 to 177 locks per transaction on the seeded copy with the default 64 and no failure
  SHOW max_connections;             -- default 100; the backfill and the cascades use one connection each
  ```
  If either dangling count is not 0, run the cleanup below **first** (the migration refuses to run otherwise). If the `pg_constraint`
  query returns rows, someone added a foreign key by hand: read it before the window (it may make the cleanup unnecessary).
  `max_locks_per_transaction` below 64 would need raising (a restart) before the window; at the default it is fine.
- **Dangling legacy logins (a hard stop of migration 166).** `sample_co_owners.user_id` and `project_investigators.user_id`
  have no foreign key today, so a deleted login left dangling rows (live had 3 `project_investigators` rows of deleted users
  on 2026-10-13, none in `sample_co_owners`, no `people` row with a dead login). Migration 166 adds `ON DELETE CASCADE`
  foreign keys to `directus_users` and **refuses to run while any dangling row exists**, with a message that points here.
  Look first, then delete deliberately (the maintainer's decision; a dangling row grants nothing, no one can sign in as a
  deleted login):
  ```bash
  psql "$DATABASE_URL" -f scripts/a1_clean_dangling_legacy_logins.sql                # dry run: lists the rows, rolls back
  psql "$DATABASE_URL" -v apply=1 -f scripts/a1_clean_dangling_legacy_logins.sql     # deletes them
  ```
  The harness copies run the same script with `apply=1` before the migrations. Migration 166 prints the counts it found
  (`NOTICE: A1a readers preflight: ...`) and the backfill's row counts and drift (`NOTICE: A1a readers backfill: ...`).
- **Backups and restores (readers tables).** The readers tables (`sample_readers`, `operation_readers`, `test_readers`,
  `campaign_readers`, `project_readers`, `campaign_sample_readers`, `operation_open_to_all`) and `d1_private.hidden_records`
  are derived data: `infra/backup/backup.sh` and `scripts/backup-postgres.ps1` leave their data out of the dump
  (`--exclude-table-data`), and `infra/backup/restore.sh` ends with `SELECT d1_private.readers_rebuild()` and the drift check.
  After any other restore (a `pg_restore`, a data-only load, `session_replication_role = replica`, a disabled trigger) run
  `SELECT d1_private.readers_rebuild(); SELECT d1_private.readers_drift_count();` by hand: the count must be 0.
- Read the PR's performance table (p95 per list request as a stranger and as a member on the seeded copy). Do not
  proceed if it is over the stated limit. Measured on the seeded copy (1665 samples, 14285 operations; live is smaller): migration
  166 applies in 0.66 s including the backfill, `readers_rebuild()` takes 0.73 s and `readers_drift_count()` 0.73 s, and every
  read p95 is under 80 ms. Migration 168 is instantaneous (policies and view options only).
- Check mail on live, the email on add depends on it:
  ```bash
  docker compose exec directus printenv | grep -E '^(EMAIL_|PUBLIC_URL)' | sed 's/\(PASSWORD=\).*/\1***/'
  ```
  `EMAIL_TRANSPORT`, `EMAIL_FROM` and the transport's host/credentials must be set, and `PUBLIC_URL` must be the
  address members open (the email links to `PUBLIC_URL/admin/home/...`). A wrong `PUBLIC_URL` does not block anything,
  it only sends bad links. A failing mail transport never blocks a change; the dialog says the email could not be sent.

## 1. Back up and note the rollback point

```bash
make backup
ls -l backups/ | tail -4          # note the file name: this is the rollback point
make migrate-status               # note the last applied migration (should be 164 or later, before A1a)
```

Record the name of the previous extension folders too (step 2 keeps them).

## 2. Deploy the extensions and apply the migrations together

```bash
git pull
npm ci && npm run build:extensions     # d1-access-guard (new rules.json), d1-record-access, d1-trace, d1-home
make migrate                           # applies the four A1a migrations
make migrate-status                    # no pending migrations
```

**Check the drift immediately after the migrations** (the backfill leaves the readers tables equal to the functions, so this is the proof):

```bash
docker compose exec -T postgres psql -U d1 -d d1_database -c "SELECT count(*) FROM d1_private.readers_drift()"   # must be 0
```

If it is not 0, run `SELECT d1_private.readers_rebuild();` and check again; if it is still not 0, stop and roll back. Do the same
after **any** restore (below).

Keep the previous `core/extensions/d1-access-guard`, `d1-trace` and `d1-home` builds (a copy, or the previous git
commit) for the rollback. Migration 167 refreshes `project_rollup`; it may take a moment on a large instance.
The migrations print `NOTICE`s (counts of rows changed); note them.

## 3. Flush Redis and restart Directus once, after everything

```bash
docker exec "$(docker compose ps -q redis)" redis-cli FLUSHALL    # or: POST /utils/cache/clear as an admin
docker restart "$(docker compose ps -q directus)"
```

(`bash scripts/configure_all.sh` does both and re-applies the Directus metadata; it keeps the new relations, aliases
and hidden fields.) Directus reads relations, collections, permissions and extensions **at start-up**. Until it
restarts, the new aliases are unknown, the old guard is still loaded and the cached permissions may be the old ones.
Do not let members back in until step 4 passes. If the migrations were ever applied in separate windows, flush and
restart after the first one (the aliases) as well.

## 4. Smoke read as a Lab Member

As a Lab Member account (a test member, not an admin; use a token or sign in):

1. `GET /items/<collection>?limit=1` returns 200 for every ruled collection: `physical_samples`,
   `manufacturing_operations`, `test_sessions`, `campaigns`, `projects`, `campaign_samples`, `sample_co_owners`,
   `project_investigators`, `project_rollup`, the params tables (for example `machining_params`), `sample_access`,
   `operation_access`, `test_access`, `campaign_access`, `project_access`. A 400 with `"_some" can only be used with
   top level relational alias field` means a rule is wrong or Directus was not restarted: stop and roll back (below).
2. The Explorer pages open: Home counts, the Projects index, a sample page, an operation page.
3. `GET /d1-record-access/physical_samples/<id>` on one of your samples returns the list with `can_manage: true`; on a
   colleague's sample you can read, `can_manage: false`.
4. The "Who has access" button opens on the five record pages; add a test person to a scratch sample and remove them
   (the email may arrive; if the transport is not set up the dialog says it could not be sent and the change stands).
5. As an unrelated member, a restricted-by-API scratch sample (owner sets it with
   `PATCH /items/physical_samples/<id> {"restricted": true}`, then clear it again) is invisible and `PATCH`ing
   `restricted` as a non-owner is refused.
6. As an admin: everything still readable; as `d1_llm_app` (Ask the database): a question returns rows and none of the
   restricted scratch sample's tree, and no query on the lab tables fails with "permission denied for schema d1_private" (the
   `USAGE` grant of migration 168). Check the role's policies are in force:
   `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('physical_samples','manufacturing_operations','semantic_embeddings')` (all `t`).

Also work through the A1 items in [`physical-test-backlog.md`](physical-test-backlog.md) with two members and an admin.

## 5. Afterwards

- Members' counts on Home and the indexes are per viewer, as they already are, and drop only for records someone has
  restricted (nothing is, in A1a).
- Until A1b, a restricted record's attached files (`directus_files`) and octrees are still reachable by anyone who has
  their id; do not tell members that Restricted protects files yet, and do not turn the switch on in the UI.
- The embedding backfill (`d1_embedder`) must keep writing: check the next run of the embedder or
  `docker compose logs --tail 50 llm-text-to-sql`; migration 168 keeps its INSERT and UPDATE (the permissive policy is `FOR ALL`).
- **Schedule the drift check.** `scripts/a1_readers_drift_check.sh` logs the drift count and exits non-zero when it is not 0 (1) or
  cannot be read (2). Run it nightly (next to the Postgres backup task) and after every import or restore:
  ```bash
  D1_DRIFT_PSQL='docker compose exec -T postgres psql -U d1 -d d1_database' D1_DRIFT_LOG=./backups/readers-drift.log \
    bash scripts/a1_readers_drift_check.sh
  ```
  (On the Windows host: a scheduled task that runs it through Git Bash, with the working directory the repo.) The admin overview
  shows the same count (cached 60 s; `?refresh=1`). A non-zero count means a write bypassed the triggers (a restore, a
  trigger-disabled import, a direct write to a readers table): `SELECT d1_private.readers_rebuild();`.
- **After a restore.** The dumps leave the derived tables' data out (`infra/backup/backup.sh`); `infra/backup/restore.sh` rebuilds
  and checks. For any other restore, run `SELECT d1_private.readers_rebuild();` and then
  `SELECT count(*) FROM d1_private.readers_drift();` (must be 0) before letting members back in.
- **A `TRUNCATE` of `test_sessions_subject`** removes the subject rows but does not clear `test_sessions.sample_id`, which migration
  139's row trigger derives from them, so each test keeps pointing at its old primary sample and the readers follow that stale
  sample. After one, restore the subject rows (or fix `sample_id` by hand) and run `SELECT d1_private.readers_rebuild();`.

- Writes to samples, operations, tests, campaigns, projects, their access lists and `campaign_samples` take one global lock
  (`d1_readers`) at the start of the statement and hold it to the end of the transaction, so an import transaction that stays
  open blocks members' saves of those records until it commits (measured on the seeded copy: a UI sample save waits the length
  of the open import, 7 s in the test, as it already did through the project rollup lock; test and campaign-note saves did not
  wait). Keep import transactions short (the importer commits in batches). A rare deadlock (`40P01`) aborts one writer cleanly;
  neither Directus nor the importer retries it (a bounded retry is a named follow-up), so re-run the failed save or batch.
- The readers tables are derived data: `readers_drift_count()` should be 0 (the admin overview shows it); after a restore or
  if it is not 0, run `SELECT d1_private.readers_rebuild();` (about a second on the live data).

## Rolling back

Preferred, if the smoke read fails or the performance is unacceptable:

```bash
make migrate-down        # four times: 168, 167, 166, 165, in that order
# restore the previous extension builds (d1-access-guard, d1-trace, d1-home; remove d1-record-access)
docker exec "$(docker compose ps -q redis)" redis-cli FLUSHALL
docker restart "$(docker compose ps -q directus)"
```

Each migration's `down` restores exactly what it changed (the Lab Member rows come back from the private backup table,
the rollup view and function return, the access tables and the `restricted` columns are dropped, the RLS policies and
`security_invoker` settings are removed). Flush and restart again afterwards, for the same reasons as step 3. Restore the
backup of step 1 only if data was damaged (`backup-restore.md`); note that anything members wrote after step 3 would
be lost by a restore, so prefer the migrations' `down`.
