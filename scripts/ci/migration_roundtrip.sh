#!/usr/bin/env bash
# Prove every migration is reversible: roll back ALL applied migrations, check nothing they
# created is left behind, then apply them all again. CI runs this after the schema tests; run it
# locally against a scratch database (.claude/skills/db-migration/scripts/scratch_pg.sh).
#
# Usage: DATABASE_URL=... scripts/ci/migration_roundtrip.sh
# DESTRUCTIVE: empties every table and drops the schema. Never point it at a real database.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a scratch database}"
cd "$(git rev-parse --show-toplevel)"
psql() { PGOPTIONS="-c client_min_messages=warning" command psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
applied() { dbmate --no-dump-schema status | sed -n 's/^Applied: //p'; }

n="$(applied)"
echo "== $n migrations applied"
[[ "$n" -gt 0 ]] || { echo "FAIL: nothing applied; run dbmate up first" >&2; exit 1; }

echo "== purge data (a down migration may refuse to drop a non-empty table)"
psql -c "
  DO \$\$
  DECLARE r RECORD;
  BEGIN
    FOR r IN SELECT tablename FROM pg_tables
             WHERE schemaname = 'public'
               -- audit_logs is append-only (a BEFORE TRUNCATE trigger raises);
               -- the rollback drops it like any other table.
               AND tablename NOT IN ('schema_migrations', 'audit_logs')
    LOOP
      EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
    END LOOP;
  END \$\$;"

echo "== down x $n"
# Exactly n steps, each of which must succeed: a failing down migration fails here, by name,
# instead of ending the loop early and looking like "nothing left to roll back".
for _ in $(seq 1 "$n"); do dbmate --no-dump-schema down >/dev/null; done
left="$(applied)"
[[ "$left" -eq 0 ]] || { echo "FAIL: $left migrations still applied after $n downs" >&2; exit 1; }

echo "== leftovers (objects a down migration forgot to drop)"
leftovers="$(psql -c "
  WITH ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
  ns AS (SELECT oid, nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
           AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%')
  SELECT kind || ' ' || name FROM (
    SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
                          WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence'
                          WHEN 'f' THEN 'foreign table' END AS kind,
           ns.nspname || '.' || c.relname AS name
    FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND c.oid NOT IN (SELECT objid FROM ext)
      AND NOT (ns.nspname = 'public' AND c.relname IN ('schema_migrations', 'schema_migrations_version_seq'))
    UNION ALL
    SELECT 'function', ns.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
    WHERE p.oid NOT IN (SELECT objid FROM ext)
    UNION ALL
    SELECT 'type', ns.nspname || '.' || t.typname
    FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
    WHERE t.typtype IN ('e', 'd', 'c', 'r', 'm') AND t.oid NOT IN (SELECT objid FROM ext)
      AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
    UNION ALL
    SELECT 'schema', nspname FROM ns WHERE nspname <> 'public'
  ) o ORDER BY 1;")"
if [[ -n "$leftovers" ]]; then
  echo "FAIL: left behind after rolling back every migration:" >&2
  while IFS= read -r obj; do echo "  $obj" >&2; done <<<"$leftovers"
  exit 1
fi

echo "== up again (a down that leaves state behind often breaks the next up)"
dbmate --no-dump-schema up >/dev/null
again="$(applied)"
[[ "$again" -eq "$n" ]] || { echo "FAIL: $again applied after re-up, expected $n" >&2; exit 1; }
echo "OK: $n migrations rolled back cleanly and re-applied"
