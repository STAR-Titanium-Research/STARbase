#!/usr/bin/env bash
# D1-Database — backup script.
#
# Creates a compressed PostgreSQL dump (plus a dump of the cluster's roles) and uploads both to
# MinIO. Requires the stack to be running (docker compose up -d).
#
# Each dump is written to a `.tmp` file, verified with `gzip -t`, and only then renamed into
# place, so a failed or truncated dump never leaves a file that looks like a good backup. On any
# failure the temp files are removed and the script exits non-zero.
#
# Usage:
#   bash infra/backup/backup.sh
#
# Environment (loaded from .env if present, or set externally):
#   POSTGRES_USER, POSTGRES_DB, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (required)
#   BACKUP_DIR   — local directory for dumps (default: ./backups)
#
# Output files (UTC timestamp):
#   d1_<ts>.sql.gz         the database (restore with restore.sh)
#   d1globals_<ts>.sql.gz  roles / cluster-wide objects (`pg_dumpall --globals-only`); contains
#                          password hashes, so it is written with mode 0600
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# Load .env if present.
if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

POSTGRES_USER="${POSTGRES_USER:-d1}"
POSTGRES_DB="${POSTGRES_DB:-d1_database}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set (in .env or the environment)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="d1_${TIMESTAMP}.sql.gz"
GLOBALS_FILE="d1globals_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

TMP_FILES=("$BACKUP_DIR/$BACKUP_FILE.tmp" "$BACKUP_DIR/$GLOBALS_FILE.tmp")
cleanup() { rm -f -- "${TMP_FILES[@]}"; }
# Runs on normal exit too; by then the .tmp files have been renamed away, so this is a no-op.
trap cleanup EXIT
trap 'echo "ERROR: backup interrupted" >&2; exit 130' INT TERM

fail() { echo "ERROR: $*" >&2; exit 1; }

# dump_to_tmp <label> <tmpfile> <command...> — runs the command, gzips its output to tmpfile and
# verifies the result. pipefail makes a failing dump command fail the whole pipeline.
dump_to_tmp() {
    local label="$1" tmp="$2"
    shift 2
    if ! "$@" | gzip > "$tmp"; then
        fail "$label dump failed"
    fi
    gzip -t "$tmp" || fail "$label dump is not a valid gzip file"
    # An empty dump still gzips to a few bytes, so check the decompressed content.
    [[ -n "$(gzip -dc "$tmp" | head -c 1)" ]] || fail "$label dump is empty"
}

echo "=== D1-Database Backup: $TIMESTAMP ==="

echo "[1/4] Dumping PostgreSQL …"
# --clean --if-exists produces DROP IF EXISTS before each object so that
# restoring into a populated database works without manual teardown.
dump_to_tmp "database" "${TMP_FILES[0]}" \
    docker compose exec -T postgres \
        pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB"

echo "[2/4] Dumping roles (pg_dumpall --globals-only) …"
dump_to_tmp "globals" "${TMP_FILES[1]}" \
    docker compose exec -T postgres \
        pg_dumpall -U "$POSTGRES_USER" --globals-only

# Both dumps verified: publish them.
mv -- "${TMP_FILES[0]}" "$BACKUP_DIR/$BACKUP_FILE"
mv -- "${TMP_FILES[1]}" "$BACKUP_DIR/$GLOBALS_FILE"
SIZE="$(du -sh "$BACKUP_DIR/$BACKUP_FILE" | cut -f1)"
echo "      → $BACKUP_DIR/$BACKUP_FILE ($SIZE)"
echo "      → $BACKUP_DIR/$GLOBALS_FILE"

echo "[3/4] Uploading to MinIO (d1-backups bucket) …"
# MC_HOST_<alias> format: http://user:password@host:port
docker run --rm \
    --network d1-database_d1net \
    -v "$ROOT/$BACKUP_DIR:/backups:ro" \
    -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
    minio/mc:latest \
    sh -c "mc mb --ignore-existing local/d1-backups \
        && mc cp /backups/$BACKUP_FILE local/d1-backups/$BACKUP_FILE \
        && mc cp /backups/$GLOBALS_FILE local/d1-backups/$GLOBALS_FILE" \
    || fail "upload to MinIO failed (the local files are kept in $BACKUP_DIR)"
echo "      → minio://d1-backups/$BACKUP_FILE"
echo "      → minio://d1-backups/$GLOBALS_FILE"

echo "[4/4] Backup complete."
echo
echo "  Local copy : $BACKUP_DIR/$BACKUP_FILE"
echo "  Roles      : $BACKUP_DIR/$GLOBALS_FILE"
echo "  MinIO key  : d1-backups/$BACKUP_FILE"
echo
echo "  To restore : BACKUP_FILE=$BACKUP_FILE bash infra/backup/restore.sh"
echo "  To prune   : make prune-backups  (keeps the newest 7; KEEP=<n> to change)"
