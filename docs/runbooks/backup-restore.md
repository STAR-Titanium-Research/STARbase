# Runbook: Backup and Restore

**System:** D1-Database  
**Scope:** PostgreSQL data + MinIO object store  
**Tested against:** Phase 2 stack (docker compose)

---

## Production (`d1-server`)

The production database is **not** backed up with the scripts below. It uses
[`scripts/backup-postgres.ps1`](../../scripts/backup-postgres.ps1), run nightly
at 02:00 by the Windows scheduled task **"D1 Postgres Nightly Backup"**:

- `pg_dump -Fc` of the database plus `pg_dumpall --globals-only` for the roles,
  written to `D:\D1-Backups\postgres` (14-day retention);
- both copied off-host to the university filestore (5-day retention).

Restore with `pg_restore`; the script's header comment has the tested
procedure and exit codes, and
[ADR-0010](../adr/0010-force-app-extraction-and-electron-packaging.md) (step 0)
records the restore verification. Directus uploads (the `directus-uploads`
volume) are **not** in these dumps; ADR-0010's open decisions describe their
one-off off-host snapshot.

The rest of this runbook covers the compose-stack backup to MinIO
(`make backup`), for development and other deployments of the stack.

---

## Prerequisites

- Docker and Docker Compose installed and running
- Stack is up: `docker compose up -d`
- `.env` copied from `.env.example` with real secrets
- MinIO buckets bootstrapped: `make bootstrap-minio`

---

## Backup

### What is backed up

| Component | Method | Destination |
|---|---|---|
| PostgreSQL | `pg_dump --clean --if-exists` (plain SQL, gzipped) | `./backups/` + MinIO `d1-backups` bucket |
| MinIO objects | Stored in named Docker volume `minio-data` | Separate volume backup (see below) |

> The SQL schema is reproducible from migrations alone. A `pg_dump` backup
> captures all *data*. Large binary files (force files, plots) live in MinIO
> and are not included in the SQL dump — back up the `minio-data` volume
> separately if needed, or rely on MinIO replication in production.

### Run a backup

```bash
bash infra/backup/backup.sh
# or
make backup
```

Output includes the local path and the MinIO key. Example:

```
=== D1-Database Backup: 20260618T120000Z ===
[1/3] Dumping PostgreSQL …
      → ./backups/d1_20260618T120000Z.sql.gz (4.2M)
[2/3] Uploading to MinIO (d1-backups bucket) …
      → minio://d1-backups/d1_20260618T120000Z.sql.gz
[3/3] Backup complete.
```

### Scheduled backups

For production, add a cron job on the host:

```cron
0 2 * * * cd /opt/d1-database && bash infra/backup/backup.sh >> /var/log/d1-backup.log 2>&1
```

---

## Restore

### From MinIO (standard path)

```bash
BACKUP_FILE=d1_20260618T120000Z.sql.gz bash infra/backup/restore.sh
# or
BACKUP_FILE=d1_20260618T120000Z.sql.gz make restore
```

The script will:
1. Download the specified file from MinIO `d1-backups/`
2. Warn with a 10-second countdown (Ctrl-C to abort)
3. Pipe through `psql` into the running Postgres container

### From a local file (skip download)

```bash
SKIP_DOWNLOAD=1 BACKUP_FILE=d1_20260618T120000Z.sql.gz bash infra/backup/restore.sh
```

Use this if the file is already in `./backups/` or MinIO is unreachable.

### After a complete wipe (fresh container)

If the Postgres volume was destroyed, run migrations and seed first, then restore:

```bash
docker compose up -d postgres
make migrate          # re-apply schema
BACKUP_FILE=d1_20260618T120000Z.sql.gz bash infra/backup/restore.sh
```

> The dump contains `DROP IF EXISTS` statements before each object, so
> restoring onto the migration-applied schema is safe — it drops and
> recreates each object in the correct order.

---

## Verification

After restore, confirm the schema tests pass:

```bash
make schema-test
```

Spot-check key data:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM physical_samples;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM manufacturing_operations;"
```

---

## List available backups

```bash
# Local
ls -lh backups/

# In MinIO
docker run --rm \
  --network d1-database_d1net \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
  minio/mc:latest mc ls local/d1-backups/
```

---

## Prune old local backups

```bash
make prune-backups   # removes local copies older than 30 days
```

MinIO retention is configured separately via the MinIO console
(`http://localhost:9001`) under **Buckets → d1-backups → Lifecycle**.

---

## Tested restore procedure (acceptance criteria)

The following sequence was used to validate this runbook:

1. `docker compose up -d` — healthy stack
2. `make migrate && make seed` — schema + reference data
3. `bash infra/backup/backup.sh` — dump created and uploaded
4. `docker compose down -v` — volumes wiped
5. `docker compose up -d postgres` — fresh Postgres
6. `make migrate` — schema recreated from migrations
7. `BACKUP_FILE=<file> bash infra/backup/restore.sh` — data restored
8. `make schema-test` — all checks pass

State after step 7 is indistinguishable from state after step 3. ✓
