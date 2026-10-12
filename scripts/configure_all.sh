#!/usr/bin/env bash
# Apply all Directus configuration in the correct order, then flush + restart.
# Order matters: inline params recreate fields that field-presets then customise.
#
# Every configure_*.sql file runs in its own transaction (BEGIN/COMMIT inside the file) with
# ON_ERROR_STOP, so the first SQL error rolls that file back, stops the script with a
# non-zero status and leaves Redis and Directus untouched. Nothing is swallowed.
#
# Environment (defaults match docker-compose.yml):
#   PG_CONTAINER / DIRECTUS_CONTAINER / REDIS_CONTAINER   container names
#   POSTGRES_USER (d1) / POSTGRES_DB (d1_database)         database login and name
set -euo pipefail
PG=${PG_CONTAINER:-d1-database-postgres-1}
DIRECTUS=${DIRECTUS_CONTAINER:-d1-database-directus-1}
REDIS=${REDIS_CONTAINER:-d1-database-redis-1}
DB_USER=${POSTGRES_USER:-d1}
DB_NAME=${POSTGRES_DB:-d1_database}
HERE="$(cd "$(dirname "$0")" && pwd)"

FILES=(
  configure_directus.sql
  configure_inline_params.sql
  configure_field_presets.sql
  configure_sample_prep.sql
  configure_campaigns.sql
  configure_operation_files.sql
  configure_project_rollup.sql
)

# Fail before touching anything if a file is missing.
for f in "${FILES[@]}"; do
  [[ -f "$HERE/$f" ]] || { echo "ERROR: $HERE/$f not found" >&2; exit 1; }
done

for f in "${FILES[@]}"; do
  echo "── $f ──"
  if ! docker exec -i "$PG" psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$HERE/$f"; then
    echo "ERROR: $f failed; its transaction was rolled back and nothing after it was applied." >&2
    exit 1
  fi
done

# redis-cli authenticates through REDISCLI_AUTH, which compose sets in the redis container.
docker exec "$REDIS" redis-cli FLUSHALL >/dev/null
docker restart "$DIRECTUS" >/dev/null
echo "Applied all config + restarted Directus."
