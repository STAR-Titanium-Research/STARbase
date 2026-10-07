#!/usr/bin/env bash
# D1-Database — restore script.
#
# Downloads a backup from MinIO (or uses a local copy), verifies it, and restores it into
# PostgreSQL in a single transaction: either the whole dump applies or nothing changes.
# Requires the stack to be running (docker compose up -d).
#
# Usage:
#   BACKUP_FILE=d1_20260618T120000Z.sql.gz bash infra/backup/restore.sh [--yes]
#
# The restore DROPS and recreates every object in the database, so it asks you to type the
# database name first. --yes skips the prompt (automation only).
#
# For a local-only restore (skip MinIO download if file already exists locally):
#   SKIP_DOWNLOAD=1 BACKUP_FILE=d1_20260618T120000Z.sql.gz bash infra/backup/restore.sh
#
# Roles (optional): GLOBALS_FILE=d1globals_<ts>.sql.gz also replays the roles dump taken by
# backup.sh. Roles that already exist produce harmless "already exists" errors, so that step
# does not stop on error; the database restore itself always does.
#
# Environment (loaded from .env if present):
#   POSTGRES_USER, POSTGRES_DB, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (required for a download)
#   BACKUP_DIR   — local directory for dumps (default: ./backups)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y) ASSUME_YES=1 ;;
        *) echo "ERROR: unknown argument: $arg (only --yes is accepted)" >&2; exit 2 ;;
    esac
done

fail() { echo "ERROR: $*" >&2; exit 1; }

: "${BACKUP_FILE:?BACKUP_FILE must be set, e.g. BACKUP_FILE=d1_20260618T120000Z.sql.gz}"

POSTGRES_USER="${POSTGRES_USER:-d1}"
POSTGRES_DB="${POSTGRES_DB:-d1_database}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-0}"
GLOBALS_FILE="${GLOBALS_FILE:-}"

# File names are bare names inside BACKUP_DIR / the bucket, never paths.
for f in "$BACKUP_FILE" "$GLOBALS_FILE"; do
    [[ -z "$f" || "$f" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid backup file name: $f"
done

PARTIAL=()
cleanup() { [[ ${#PARTIAL[@]} -eq 0 ]] || rm -f -- "${PARTIAL[@]}"; }
trap cleanup EXIT

# fetch <name> — make sure $BACKUP_DIR/<name> exists locally and is a valid gzip file.
fetch() {
    local name="$1" dest="$BACKUP_DIR/$1"
    if [[ "$SKIP_DOWNLOAD" == "1" && -f "$dest" ]]; then
        echo "      Using local copy (SKIP_DOWNLOAD=1): $dest"
    else
        : "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set to download from MinIO}"
        echo "      Downloading from MinIO (d1-backups/$name) …"
        mkdir -p "$BACKUP_DIR"
        PARTIAL+=("$dest.part")
        docker run --rm \
            --network d1-database_d1net \
            -v "$ROOT/$BACKUP_DIR:/backups" \
            -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
            minio/mc:latest \
            mc cp "local/d1-backups/$name" "/backups/$name.part" \
            || fail "download of $name failed"
        mv -- "$dest.part" "$dest"
    fi
    gzip -t "$dest" || fail "$dest is not a valid gzip file (truncated or corrupt); nothing was restored"
    echo "      Verified (gzip -t): $dest"
}

echo "=== D1-Database Restore: $BACKUP_FILE ==="

echo "[1/3] Fetching and verifying …"
fetch "$BACKUP_FILE"
[[ -z "$GLOBALS_FILE" ]] || fetch "$GLOBALS_FILE"

echo "[2/3] Restoring into PostgreSQL …"
echo
echo "  WARNING: this will DROP and recreate all objects in '$POSTGRES_DB'."
echo "  All current data in it will be lost."
echo
if [[ "$ASSUME_YES" -ne 1 ]]; then
    read -r -p "  Type the database name ($POSTGRES_DB) to confirm: " answer || answer=""
    [[ "$answer" == "$POSTGRES_DB" ]] || fail "confirmation did not match; nothing was restored"
fi

if [[ -n "$GLOBALS_FILE" ]]; then
    echo "      Replaying roles from $GLOBALS_FILE (existing roles will report 'already exists') …"
    zcat "$BACKUP_DIR/$GLOBALS_FILE" \
        | docker compose exec -T postgres \
            psql -U "$POSTGRES_USER" -d postgres -q > /dev/null \
        || echo "      WARNING: some role statements failed; check that the roles you need exist." >&2
fi

# The dump was created with --clean --if-exists, so it drops each object before recreating it.
# ON_ERROR_STOP + --single-transaction: the first error aborts and rolls everything back,
# leaving the database exactly as it was. pipefail makes zcat or psql failures fatal.
if ! zcat "$BACKUP_DIR/$BACKUP_FILE" \
    | docker compose exec -T postgres \
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q \
            -v ON_ERROR_STOP=1 --single-transaction > /dev/null; then
    fail "restore FAILED and was rolled back; '$POSTGRES_DB' is unchanged. See the psql error above."
fi

echo "[3/3] Restore complete."
echo
echo "  Verify: make schema-test"
