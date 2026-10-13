# Runbook: Applying record access (A1a) to the live deployment

**System:** D1-Database
**Scope:** the maintainer applies the A1a release to the running compose stack with real data and real Lab Member
accounts. Design: ADR-0014 and the spec below.
**Applies to:** the five A1a migrations, in this order: `20261012000165_record_access.sql`,
`20261012000166_record_readers_and_rules.sql`, `20261012000167_project_rollup_restricted.sql`,
`20261012000168_llm_role_row_security.sql`, `20261012000169_people_update_own_row.sql` (confirm the numbers with
`make migrate-status`; if main has gained migrations since, they must sort **below** 165 or be renumbered before the merge) and
the extensions `d1-access-guard`, `d1-record-access`, `d1-trace` and the rebuilt `d1-home` and `d1-lab-dashboard`
(`SampleTimeline.vue` changed). Design: `docs/superpowers/specs/2026-10-12-record-access-design.md`.

## The order, and why

1. Back up first, and save the dangling rows to a file.
2. **STOP**: the maintainer's go for the dangling-row cleanup.
3. Stop Directus; pause the force crawler and any import.
4. `git pull` and build the extensions.
5. Migrate 165 to 169, then check the drift.
6. Flush Redis, start Directus.
7. Smoke read as a Lab Member.
8. Rollback (below), with Directus stopped.

**Why Directus is stopped before the pull.** `docker-compose.yml` sets `EXTENSIONS_AUTO_RELOAD: "true"` and mounts
`./core/extensions` read-only, so a running Directus **hot-loads whatever `git pull` puts there**. The new `d1-access-guard`
selects `restricted`, reads `sample_readers` and filters on the `readers` alias; the new `d1-record-access` reads the access
and readers tables; `d1-trace` reads the new columns. Loaded before the migrations they return 500 on owner changes, moves and
campaign-sample writes. Between the migrations and the restart, a permissions cache refresh would serve rules on aliases the
stale schema does not know (the incident pattern of migration 160: every Lab Member read fails). Migration 166 also adds
foreign keys to `directus_users`, which a live Directus touches constantly (`last_access`), under a 10 s `lock_timeout`.
So nothing of A1a may be visible to a running Directus: **it is stopped before the pull and started only after the
migrations, once, with a flushed cache.** Do it in a quiet window and tell members first. A1a has no screen that turns
Restricted on, and until A1b only an admin can set it over the API (the guard's `RESTRICT_ADMIN_ONLY` switch, below), but the
rules and the endpoint are live from the start.

All `psql` lines below use the compose Postgres, written as `PSQL` for short:

```bash
PSQL='docker compose exec -T postgres psql -U d1 -d d1_database'
```

## 0. Before the window (read only)

- On the branch: `git fetch && git merge origin/main`; confirm `ls db/migrations | tail -7` shows 164 and any later numbers
  **below** A1a's five. A migration numbered below the newest recorded one is skipped silently by dbmate.
- **Local gates, on the final tree.** CI does not run the readers matrix or the Directus smoke. CI runs `pre-commit run
  --all-files`, `node --test`, the d1-ui vitest, `phase1_schema.sh`, `phase6_text_to_sql.sh` and the migration round trip; the
  other two gates are run by hand and recorded in the PR:
  ```bash
  ROUNDTRIP=4 bash scripts/dev/schema_test_docker.sh        # includes the readers matrix (tests/readers_matrix.sh)
  D1_SMOKE_REQUIRE_LM=1 D1_SMOKE_OVERLAYS="d1-next-number d1-access-guard d1-record-access d1-trace d1-admin-overview" \
    bash scripts/dev/directus_smoke.sh
  ```
- **Preflight queries (they change nothing):**
  ```bash
  $PSQL <<'SQL'
  -- dangling logins: rows naming a login that no longer exists (must be 0 and 0 before migration 166, else step 2)
  SELECT (SELECT count(*) FROM sample_co_owners c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id)) AS dangling_co_owners,
         (SELECT count(*) FROM project_investigators c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id)) AS dangling_investigators;
  -- those two columns must have no foreign key to directus_users yet (migration 166 adds them): expect 0 rows
  SELECT conrelid::regclass, conname FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'directus_users'::regclass AND conrelid IN ('sample_co_owners'::regclass, 'project_investigators'::regclass);
  SHOW max_locks_per_transaction;   -- the big cascades peaked at 159 to 177 locks per transaction on the seeded copy with the default 64 and no failure
  SHOW max_connections;             -- default 100; the backfill and the cascades use one connection each
  SQL
  ```
  If the `pg_constraint` query returns rows, someone added a foreign key by hand: read it before the window (it may make the
  cleanup unnecessary). `max_locks_per_transaction` below 64 would need raising (a restart) before the window.
- Read the PR's performance table (p95 per list request as a stranger and as a member on the seeded copy). Do not
  proceed if it is over the stated limit. Measured on the seeded copy (1665 samples, 14285 operations; live is smaller): migration
  166 applies in 0.66 s including the backfill, `readers_rebuild()` takes 0.73 s and `readers_drift_count()` 0.73 s, and every
  read p95 is under 80 ms. Migrations 168 and 169 are instantaneous.
- Check mail on live, the email on add depends on it:
  ```bash
  docker compose exec directus printenv | grep -E '^(EMAIL_|PUBLIC_URL)' | sed 's/\(PASSWORD=\).*/\1***/'
  ```
  `EMAIL_TRANSPORT`, `EMAIL_FROM` and the transport's host/credentials must be set, and `PUBLIC_URL` must be the
  address members open (the email links to `PUBLIC_URL/admin/home/...`). A wrong `PUBLIC_URL` does not block anything,
  it only sends bad links. A failing mail transport never blocks a change; the dialog says the email could not be sent.
- **Backups and restores (readers tables).** The big readers tables (`sample_readers`, `operation_readers`, `test_readers`,
  `campaign_readers`, `project_readers`, `campaign_sample_readers`, `operation_open_to_all`) are derived data:
  `infra/backup/backup.sh` and `scripts/backup-postgres.ps1` leave their data out of the dump (`--exclude-table-data`), and
  `infra/backup/restore.sh` ends with `SELECT d1_private.readers_rebuild()` and the drift check. `d1_private.hidden_records` is also
  derived but is **dumped** (it is tiny): the Ask-the-database role reads it through row security, so it must not be empty after
  a restore that skipped the rebuild. After any other restore (a `pg_restore`, a data-only load, `session_replication_role =
  replica`, a disabled trigger) run `SELECT d1_private.readers_rebuild(); SELECT d1_private.readers_drift_count();` by hand:
  the count must be 0.

## 1. Back up first, and save the dangling rows

```bash
make backup                       # or: pwsh scripts/backup-postgres.ps1 (pg_dump of the live Postgres; nothing is changed)
ls -l backups/ | tail -4          # note the file name: this is the rollback point
make migrate-status               # note the last applied migration (should be 164 or later, before A1a)

# the dangling legacy rows, to files (the cleanup in step 2 deletes them; this is how they come back if anyone asks)
TS=$(date +%Y%m%d_%H%M%S)
$PSQL -c "COPY (SELECT i.* FROM project_investigators i WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = i.user_id) ORDER BY i.id) TO STDOUT WITH CSV HEADER" \
  > backups/a1_dangling_investigators_${TS}.csv
$PSQL -c "COPY (SELECT c.* FROM sample_co_owners c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id) ORDER BY c.id) TO STDOUT WITH CSV HEADER" \
  > backups/a1_dangling_co_owners_${TS}.csv
wc -l backups/a1_dangling_*_${TS}.csv     # header + one line per row: 3 investigators (live, 2026-10-13), 0 co-owners
```

Record the previous extension folders too (step 4 keeps them): `core/extensions/d1-access-guard`, `d1-trace`, `d1-home`,
`d1-lab-dashboard` (a copy, or the previous git commit).

## 2. STOP: the maintainer's go for the cleanup

**Do not go past this step until the maintainer has said go, at cutover time. It deletes rows from the live database.**

`sample_co_owners.user_id` and `project_investigators.user_id` have no foreign key today, so a deleted login left dangling rows
(live had 3 `project_investigators` rows of deleted users on 2026-10-13, none in `sample_co_owners`, no `people` row with a dead
login). Migration 166 adds `ON DELETE CASCADE` foreign keys to `directus_users` and **refuses to run while any dangling row
exists**, with a message that points here. A dangling row grants nothing (no one can sign in as a deleted login) and cannot be
shown in any list.

The maintainer's ruling: delete them, after they are saved. So, with the CSV files of step 1 in `backups/` and read:

```bash
$PSQL -f - < scripts/a1_clean_dangling_legacy_logins.sql                 # dry run: lists the rows, rolls back
# --- the maintainer says go ---
$PSQL -v apply=1 -f - < scripts/a1_clean_dangling_legacy_logins.sql      # deletes them
```

(`psql -f -` reads the script from stdin, so it works through `docker compose exec -T`.) The harness copies run the same
script with `apply=1` before the migrations. Migration 166 prints the counts it found (`NOTICE: A1a readers preflight: ...`) and the
backfill's row counts and drift (`NOTICE: A1a readers backfill: ...`).

## 3. Stop Directus; pause the crawler and the imports

```bash
# note the crawler's setting, then pause it (the daemon reads this row live)
$PSQL -c "SELECT desired_state FROM force_crawler_state"            # note it, normally 'running'
$PSQL -c "UPDATE force_crawler_state SET desired_state = 'paused'"
# stop any importer that writes samples, operations or tests (the FAST and EMD importers, a legacy migration run): an open transaction
# holds the global readers lock that the migrations need. Let running batches finish.
docker compose stop directus
docker compose ps directus        # not running
```

The workers (`heavy-data-worker`, `analysis-worker`) write through Directus and simply fail their webhooks while it is down;
leave them.

## 4. Pull and deploy the extensions

```bash
git pull
npm ci && npm run build:extensions     # d1-access-guard (new rules.json), d1-record-access, d1-trace, d1-home, d1-lab-dashboard
```

Directus is stopped, so nothing loads yet.

## 5. Apply the migrations, then check the drift

```bash
make migrate                           # applies the five A1a migrations (165 to 169)
make migrate-status                    # no pending migrations
$PSQL -c "SELECT count(*) FROM d1_private.readers_drift()"    # must be 0 (the backfill leaves the readers tables equal to the functions)
```

If the drift is not 0, run `SELECT d1_private.readers_rebuild();` and check again; if it is still not 0, stop and roll back.
Do the same after **any** restore (below). Migration 167 refreshes `project_rollup`; it may take a moment on a large instance.
The migrations print `NOTICE`s (counts of rows changed); note them.

## 6. Flush Redis, start Directus

```bash
docker compose exec -T redis redis-cli FLUSHALL
docker compose start directus
```

(`bash scripts/configure_all.sh` re-applies the Directus metadata and keeps the new relations, aliases and hidden fields.)
Directus reads relations, collections, permissions and extensions **at start-up**, so this single start sees all five
migrations and the new extensions together. Do not let members back in until step 7 passes. Resume what step 3 paused only
after step 7:

```bash
$PSQL -c "UPDATE force_crawler_state SET desired_state = 'running'"    # the value you noted in step 3
# then start the importers again
```

## 7. Smoke read as a Lab Member

As a Lab Member account (a test member, not an admin; use a token or sign in):

1. `GET /items/<collection>?limit=1` returns 200 for every ruled collection: `physical_samples`,
   `manufacturing_operations`, `test_sessions`, `campaigns`, `projects`, `campaign_samples`, `sample_co_owners`,
   `project_investigators`, `project_rollup`, `people`, the params tables (for example `machining_params`), `sample_access`,
   `operation_access`, `test_access`, `campaign_access`, `project_access`. A 400 with `"_some" can only be used with
   top level relational alias field` means a rule is wrong or Directus was not restarted: stop and roll back (below).
2. The Explorer pages open: Home counts, **Home "Your samples" and "Your projects"**, the Projects index, a sample page, an
   operation page.
3. `GET /d1-record-access/physical_samples/<id>` on one of your samples returns the list with `can_manage: true`; on a
   colleague's sample you can read, `can_manage: false`.
4. The "Who has access" button opens on the five record pages; add a test person to a scratch sample and remove them
   (the email may arrive; if the transport is not set up the dialog says it could not be sent and the change stands).
5. Restricting is admin-only until A1b: as the owner of a scratch sample, `PATCH /items/physical_samples/<id> {"restricted": true}`
   is refused with "Restricting a record is not available yet"; as an admin it works (then clear it again). As an unrelated
   member the restricted scratch sample is invisible.
6. A member can edit their own People row and not another's (`PATCH /items/people/<id>` returns 403 for someone else's row).
7. As an admin: everything still readable; as `d1_llm_app` (Ask the database): a question returns rows and none of the
   restricted scratch sample's tree, and no query on the lab tables fails with "permission denied for schema d1_private" (the
   `USAGE` grant of migration 168). Check the role's policies are in force:
   `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('physical_samples','manufacturing_operations','semantic_embeddings')` (all `t`).

Also work through the A1 items in [`physical-test-backlog.md`](physical-test-backlog.md) with two members and an admin.

## 8. Rolling back

Preferred, if the smoke read fails or the performance is unacceptable. **Stop Directus first** (the same reasons as the
cutover: it must not load the old rules against the new schema or the other way round):

```bash
docker compose stop directus
make migrate-down        # five times: 169, 168, 167, 166, 165, in that order
# restore the previous extension builds (d1-access-guard, d1-trace, d1-home, d1-lab-dashboard; remove d1-record-access)
docker compose exec -T redis redis-cli FLUSHALL
docker compose start directus
```

Each migration's `down` restores exactly what it changed (the Lab Member rows come back from the private backup tables,
the rollup view and function return, the access tables and the `restricted` columns are dropped, the RLS policies and
`security_invoker` settings are removed). **`migrate-down` past 165 drops every access grant made since the cutover** (the
`*_access` tables go with their rows); the old co-owner and investigator rows that the endpoint converted are not brought back.

Two traps:
- **Restoring the step-1 (pre-A1a) backup over a migrated database fails**: the A1a tables' foreign keys to `physical_samples` and
  other tables are not in the old dump, so `DROP TABLE` errors (`restore.sh` rolls back safely). Restore the step-1 backup only
  after `migrate-down` x5, or into an empty database. It is needed only if data was damaged (`backup-restore.md`); anything members
  wrote after the start would be lost by a restore, so prefer the migrations' `down`.
- **The `down` of 166 and 167 restores the Lab Member rows by `directus_permissions.id`.** If `scripts/configure_users_and_policies.sql`
  (delete and re-insert, with new ids) was run after the cutover, `down` cannot find them and every member read would fail on the
  dropped `readers` alias. After such a run, roll back by running **main's** `configure_users_and_policies.sql` after the `down`.

## 9. Afterwards

- Members' counts on Home and the indexes are per viewer, as they already are, and drop only for records someone has
  restricted (nothing is, in A1a).
- **Until A1b, only an admin can restrict anything.** The guard's `RESTRICT_ADMIN_ONLY` switch (`core/extensions/d1-access-guard/index.js`;
  A1b turns it off, or sets `D1_A1B_RESTRICT_OPEN=true` in the Directus environment) refuses every change of `restricted` by a
  member, on update and at create, on samples, operations, tests, campaigns and projects. The reason: a restricted record's
  attached files (`directus_files`) and octrees are still reachable by anyone who has their id, so Restricted would promise
  privacy the system cannot keep. Do not tell members that Restricted protects files yet, and do not turn the switch on in the UI.
- A member can edit only their **own** People row (migration 169); an admin edits any row, and anyone may still add a person.
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
  trigger-disabled import, a direct write to a readers table): `SELECT d1_private.readers_rebuild();` (about a second on the live data).
- **After a restore.** The dumps leave the big derived tables' data out (`infra/backup/backup.sh`); `infra/backup/restore.sh` rebuilds
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
