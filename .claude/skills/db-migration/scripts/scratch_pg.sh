#!/usr/bin/env bash
# Start a throwaway Postgres 16 for migration testing when Docker isn't available
# (e.g. cloud sessions). Prints the DATABASE_URL to export.
#
# Usage: scratch_pg.sh start|stop
# Needs the postgresql-16 server and postgresql-16-pgvector packages
# (migration 000001 creates the `vector` extension).
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="${SCRATCH_PG_DIR:-/tmp/d1-scratch-pg}"
PORT="${SCRATCH_PG_PORT:-54329}"
URL="postgres://d1@localhost:${PORT}/d1_test?sslmode=disable"

# initdb/pg_ctl refuse to run as root.
as_pg() { if [[ $EUID -eq 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

case "${1:-start}" in
  start)
    [[ -x "$PGBIN/pg_ctl" ]] || { echo "No Postgres server at $PGBIN (set PGBIN)" >&2; exit 1; }
    if [[ ! -f "$DATA/PG_VERSION" ]]; then
      mkdir -p "$DATA"
      [[ $EUID -eq 0 ]] && chown postgres "$DATA"
      as_pg "$PGBIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
    fi
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start >/dev/null
    # Match CI: the migrations expect a superuser role named d1 that owns d1_test.
    admin="postgres://postgres@localhost:${PORT}/postgres"
    psql "$admin" -qc 'CREATE ROLE d1 SUPERUSER LOGIN' 2>/dev/null || true
    psql "$admin" -qc 'CREATE DATABASE d1_test OWNER d1' 2>/dev/null || true
    echo "export DATABASE_URL='$URL'"
    ;;
  stop)
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null && rm -rf "$DATA"
    echo "stopped and removed $DATA"
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
