# Runbook: Upgrading an existing deployment to row-level visibility (ADR-0011)

**System:** D1-Database
**Scope:** an already-running compose stack with real data and real Lab Member accounts
**Applies to:** the Explorer pages release (migrations `20261007000139` to `20261007000141`)

Migration 141 puts a row filter on every Lab Member permission: from the moment it is applied
and Directus has reloaded, members see only the records they own, co-own, lead or reach through a
project or campaign. Do this in a quiet window and tell members first.

## 1. Back up

```bash
make backup
ls -l backups/ | tail -4
```

## 2. Pull, build, migrate

```bash
git pull
npm ci && npm run build:extensions     # the Explorer pages and the d1-access-guard hook
make migrate                           # applies 139, 140 and 141
make migrate-status                    # no pending migrations
```

Migration 141 prints a `NOTICE` such as `ADR-0011 ownerless records ...`: note the counts (step 4).

## 3. Restart Directus right after migration 141 (do not skip)

```bash
docker exec "$(docker compose ps -q redis)" redis-cli FLUSHALL    # or: POST /utils/cache/clear as an admin
docker restart "$(docker compose ps -q directus)"
```

(`bash scripts/configure_all.sh` does both, and re-applies the Directus metadata.)

Directus reads relations, collections and permissions **at start-up** and caches them. Until it
restarts:

- the hidden `projects.samples`, `projects.operations` and `projects.sessions` aliases that migration
  141 adds are unknown to it, so the project read rule fails and members get errors or empty lists on
  projects (and on every collection whose rule walks a project);
- the new `d1-access-guard` hook (refuses self-granted co-owner, investigator, campaign-sample and
  test-subject rows and owner takeovers) is not loaded, so those rows are **not** checked;
- the cached permissions may still be the old, unfiltered ones.

Do not let members back in until the restart is done and step 5 passes.

## 4. Give ownerless records an owner

Records with no owner are visible to members only through their project, campaign or co-owners.
Use the counts from step 2 and assign owners (`scripts/transfer_sample_ownership.py`, or the *Owner*
field). Every member who should own records needs a People row linked to their login (an admin
links it: People page).

## 5. Check

Work through "Row-level visibility (E5, ADR-0011)" in
[`physical-test-backlog.md`](physical-test-backlog.md) with two Lab Member accounts and an admin;
at least: B sees none of A's records, an admin sees all, a project opens for its PI, and a new
sample created by A shows A as owner.

## Rolling back

`make migrate-down` reverses 141 (run it again for 140 and 139): the Lab Member rows come back exactly as
they were (migration 141 keeps them in the private schema `d1_private` until then) and the hidden
project aliases it added are removed. Restart Directus again afterwards, for the same reasons.
Restore the backup only if data was damaged (`backup-restore.md`).
