#!/usr/bin/env bash
# Directus smoke test on a restored copy of live. Written after the T0a incident (2026-10-10):
# every SQL test passed, but Directus treats a NOT NULL column without a default as required and
# refused to create a sample. This harness exercises schema changes through a real Directus:
#   1. throwaway pgvector Postgres on an internal Docker network,
#   2. restore a copy of live into it (pg_dump of the live container; live is only read),
#   3. apply the worktree's pending dbmate migrations (the copy already has what live has),
#   4. set a random admin API token on the COPY only,
#   5. start Directus (the live container's exact image, live's extensions mounted read-only,
#      plus the worktree's d1-next-number overlaid) on the copy,
#   6. run scripts/dev/directus_smoke.mjs against it: one `SMOKE PASS|FAIL <case>` line per case.
# Exit status is non-zero on any FAIL or any harness failure; cleanup always runs.
#
# --skip <version> (repeatable) simulates "this migration was never applied": it is rolled back in
# the copy if live already has it, and withheld from dbmate (a temporary db/ without those files is
# mounted), otherwise `dbmate up` would simply re-apply it. Use it to prove the smoke test catches
# an old incident, e.g.:  bash scripts/dev/directus_smoke.sh --skip 20261010000153
#
# Usage: bash scripts/dev/directus_smoke.sh [--skip <migration-version>...]   (from the repo root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
# What live's Directus mounts at /directus/extensions (override on another machine).
MAIN_CHECKOUT="${D1_MAIN_CHECKOUT:-D:\\Users\\CMBE Admn 3214022001\\Documents\\GitHub\\D1-Database}"
NET=d1-smoke; PG=d1-smoke-pg; DX=d1-smoke-directus
LIVE_PG=d1-database-postgres-1; LIVE_DX=d1-database-directus-1
rhex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
DB_PASS="smoke-$(rhex 8)"
URL="postgres://d1:$DB_PASS@$PG:5432/d1_database?sslmode=disable"
SKIPS=()
TMPDB=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip) [[ -n "${2:-}" ]] || { echo "FAIL harness: --skip needs a migration version"; exit 2; }
            SKIPS+=("$2"); shift 2 ;;
    *) echo "FAIL harness: unknown argument $1"; exit 2 ;;
  esac
done

cleanup() {
  docker rm -f "$DX" "$PG" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  [[ -n "$TMPDB" ]] && rm -rf "$TMPDB"
}
trap cleanup EXIT
# abort <stage> <exit> [output]: greppable FAIL line, then the stage's output; cleanup runs via the trap.
abort() { echo "FAIL harness: $1 (exit $2)"; [[ -n "${3:-}" ]] && echo "$3"; exit 1; }
psql_copy() { docker exec -i "$PG" psql -U d1 -d d1_database -X -q -v ON_ERROR_STOP=1 "$@"; }

cleanup   # clear leftovers of a killed earlier run
docker network create --internal "$NET" >/dev/null || abort "docker network create" $?
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB=d1_database pgvector/pgvector:pg16 >/dev/null || abort "postgres container start" $?
ready=
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U d1 -d d1_database >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[[ -n "$ready" ]] || abort "postgres not ready after 60s" 1

# --- restore a copy of live (live is only read). Revisions/activity data are skipped: large, not needed.
t0=$SECONDS
rout=$(docker exec "$LIVE_PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=directus_revisions --exclude-table-data=directus_activity' \
  | docker exec -i "$PG" pg_restore -U d1 -d d1_database --no-owner --role=d1 2>&1)
# Expected noise: GRANTs to roles that exist only on live (d1_llm_readonly ...). pg_restore prints each
# failing command as "Command was: ..."; any failing command that is not a GRANT/REVOKE is a real failure.
badcmd=$(grep -E '^[[:space:]]*Command was:' <<<"$rout" | grep -vE 'Command was: (GRANT|REVOKE) ')
[[ -z "$badcmd" ]] || abort "restore" 1 "$(grep -vE '^[[:space:]]*Command was: (GRANT|REVOKE) |role "[^"]+" does not exist|^pg_restore: while' <<<"$rout" | head -40)"
n=$(psql_copy -Atc "SELECT count(*) FROM schema_migrations") || abort "restore check (schema_migrations missing)" $? "$rout"
[[ "${n:-0}" -gt 0 ]] || abort "restore produced no schema_migrations rows" 1 "$rout"
echo "restored copy of live ($n migrations applied) in $((SECONDS - t0))s"

# --- --skip: roll the skipped migrations back in the copy (newest first) and keep dbmate from re-applying them
DBDIR="$REPO/db"
if [[ ${#SKIPS[@]} -gt 0 ]]; then
  TMPDB=$(mktemp -d)
  mkdir -p "$TMPDB/db"
  cp -r db/. "$TMPDB/db/"
  for v in "${SKIPS[@]}"; do
    f=$(ls db/migrations/"${v}"_*.sql 2>/dev/null | head -1)
    [[ -n "$f" ]] || abort "--skip $v: no such migration file" 1
    rm -f "$TMPDB/db/migrations/$(basename "$f")"
  done
  DBDIR="$(cygpath -m "$TMPDB" 2>/dev/null || echo "$TMPDB")/db"
  for v in $(printf '%s\n' "${SKIPS[@]}" | sort -r); do
    f=$(ls db/migrations/"${v}"_*.sql | head -1)
    if [[ "$(psql_copy -Atc "SELECT count(*) FROM schema_migrations WHERE version='$v'")" == "1" ]]; then
      down=$(awk '/^-- migrate:down/{d=1;next} d' "$f")
      sout=$({ echo "BEGIN;"; echo "$down"; echo "DELETE FROM schema_migrations WHERE version='$v';"; echo "COMMIT;"; } | psql_copy 2>&1) \
        || abort "--skip $v rollback" $? "$sout"
      echo "skipped $v: rolled back in the copy"
    else
      echo "skipped $v: not applied in live, just withheld"
    fi
  done
fi

dbmate() { docker run --rm --network "$NET" -e DATABASE_URL="$URL" -v "$DBDIR:/db" \
  ghcr.io/amacneil/dbmate:2 --no-dump-schema "$@" 2>&1; }
out=$(dbmate up); rc=$?
[[ $rc -eq 0 ]] && echo "$out" | tail -3 || abort "dbmate up" $rc "$out"

# --- admin API token, on the copy only. Directus 11: user -> directus_access (user or role) -> policy.admin_access
TOKEN="smoke-$(rhex 16)"
admin=$(psql_copy -Atc "
  SELECT u.id FROM directus_users u
  WHERE u.status = 'active' AND EXISTS (
    SELECT 1 FROM directus_access a JOIN directus_policies p ON p.id = a.policy
    WHERE p.admin_access AND (a.\"user\" = u.id OR (a.role IS NOT NULL AND a.role = u.role)))
  ORDER BY u.id LIMIT 1") || abort "find admin user" $?
[[ -n "$admin" ]] || abort "no active admin user in the copy" 1
psql_copy -c "UPDATE directus_users SET token = '$TOKEN' WHERE id = '$admin'" >/dev/null || abort "set token" $?

# --- Directus: the live container's exact image; live's extensions + this worktree's d1-next-number
IMAGE=$(docker inspect "$LIVE_DX" --format '{{.Image}}') || abort "docker inspect $LIVE_DX" $?
docker run -d --name "$DX" --network "$NET" \
  -e KEY="$(rhex 16)" -e SECRET="$(rhex 32)" \
  -e DB_CLIENT=pg -e DB_HOST="$PG" -e DB_PORT=5432 -e DB_DATABASE=d1_database -e DB_USER=d1 -e DB_PASSWORD="$DB_PASS" \
  -e PUBLIC_URL="http://$DX:8055" -e EXTENSIONS_AUTO_RELOAD=false -e D1_TIMEZONE=Europe/London \
  -v "$MAIN_CHECKOUT\\core\\extensions:/directus/extensions:ro" \
  -v "$REPO/core/extensions/d1-next-number:/directus/extensions/d1-next-number:ro" \
  "$IMAGE" >/dev/null || abort "directus container start" $?
ready=
for _ in $(seq 1 120); do
  h=$(docker exec "$DX" wget -qO- http://127.0.0.1:8055/server/health 2>/dev/null)
  grep -q '"status":"ok"' <<<"$h" && { ready=1; break; }
  sleep 1
done
[[ -n "$ready" ]] || abort "directus not healthy after 120s" 1 "$(docker logs --tail 60 "$DX" 2>&1)"

# --- cases
docker run --rm --network "$NET" -e DIRECTUS_URL="http://$DX:8055" -e TOKEN="$TOKEN" \
  -v "$REPO/scripts/dev:/smoke:ro" node:20-alpine node /smoke/directus_smoke.mjs 2>&1
exit $?
