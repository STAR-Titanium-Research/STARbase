#!/usr/bin/env bash
# ################################################################################################
# WARNING - DO NOT RUN THIS ON A DATABASE THAT ALREADY HAS MIGRATIONS APPLIED.
# configure_directus.sql, the first file below, deletes every directus_fields row of the collections
# it owns and re-inserts only its own, older, baseline; the other configure_*.sql files delete and
# re-insert their own rows the same way. Anything that db/migrations/ added to that metadata since
# (owner_person_id pickers, test_sessions per-type fields, FAST recipe groups, ...) is wiped and not
# put back.
# On the live database this happened in 2026-07/2026-09: configure_directus.sql was run alone, the
# 116 inline parameter field rows, the sintering groups and four relation alias fields were lost, and
# the forms ran ungrouped for weeks. Migration 20261009000143_restore_inline_param_field_meta repaired it.
# Use this script only on a brand-new Directus or a scratch database you can throw away. To change
# Directus metadata on a live database, write a migration (see CONTRIBUTING and the db-migration skill).
# ################################################################################################
# Apply all Directus configuration in the correct order, then flush + restart.
# Order matters: inline params recreate fields that field-presets then customise; the form layout goes last.
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
  configure_form_layout.sql
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
