#!/usr/bin/env bash
# Explorer preview on a restored copy of live, for checking UI work in a browser without touching live:
#   1. throwaway pgvector Postgres on an internal Docker network; restore a copy of live into it (live is only read),
#   2. apply the worktree's pending dbmate migrations,
#   3. create two local test users ON THE COPY (an admin and a Lab Member, random passwords written to the
#      git-ignored .superpowers/preview-credentials.txt),
#   4. start Directus (live's exact image and asset settings) on a merged extensions folder (live's built
#      extensions, with this worktree's D1_PREVIEW_OVERLAY extensions in their place, default d1-home and
#      d1-admin-overview), published on 127.0.0.1:18055 only, and leave it running.
# The copy has no uploaded files (an empty preview-only volume), so picture thumbnails show their placeholders;
# sample drawings need no files. Stop and remove everything with --stop. Build d1-home first:
#   npm run build -w directus-extension-d1-home
#
# Usage: bash scripts/dev/explorer_preview.sh [--stop]   (from the repo root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
MAIN_CHECKOUT="${D1_MAIN_CHECKOUT:-D:\\Users\\CMBE Admn 3214022001\\Documents\\GitHub\\D1-Database}"
NET=d1-preview; PG=d1-preview-pg; DX=d1-preview-directus; PORT="${D1_PREVIEW_PORT:-18055}"
LIVE_PG=d1-database-postgres-1; LIVE_DX=d1-database-directus-1
FILES_VOL=d1-preview-uploads
OVERLAY="${D1_PREVIEW_OVERLAY:-d1-home d1-admin-overview}"
CREDS=.superpowers/preview-credentials.txt
EXT_DIR=.superpowers/preview-extensions
rhex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
stop() { docker rm -fv "$DX" "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
abort() { echo "FAIL preview: $1"; [[ -n "${2:-}" ]] && echo "$2"; stop; exit 1; }
psql_copy() { docker exec -i "$PG" psql -U d1 -d d1_database -X -q -v ON_ERROR_STOP=1 "$@"; }
# Built extensions only: node_modules and sources stay behind (every extension ships a bundled entry).
copy_ext() { tar -C "$1" --exclude=node_modules --exclude=src -cf - . | tar -C "$2" -xf -; }

if [[ "${1:-}" == "--stop" ]]; then
  stop; docker volume rm "$FILES_VOL" >/dev/null 2>&1; rm -rf "$CREDS" "$EXT_DIR"; echo "preview stopped"; exit 0
fi
[[ -f core/extensions/d1-home/dist/index.js ]] || abort "build d1-home first (npm run build -w directus-extension-d1-home)"

stop
# --- merged extensions: live's, then this worktree's overlay extensions replacing theirs
rm -rf "$EXT_DIR"; mkdir -p "$EXT_DIR"
copy_ext "$(cygpath -u "$MAIN_CHECKOUT" 2>/dev/null || echo "$MAIN_CHECKOUT")/core/extensions" "$EXT_DIR" \
  || abort "copy live's extensions"
for ext in $OVERLAY; do
  [[ -d "core/extensions/$ext" ]] || abort "overlay extension core/extensions/$ext not found"
  rm -rf "${EXT_DIR:?}/$ext"; mkdir -p "$EXT_DIR/$ext"; copy_ext "core/extensions/$ext" "$EXT_DIR/$ext" || abort "copy $ext"
done
EXT_MOUNT="$(cd "$EXT_DIR" && (pwd -W 2>/dev/null || pwd))"
DB_PASS="preview-$(rhex 8)"
URL="postgres://d1:$DB_PASS@$PG:5432/d1_database?sslmode=disable"
docker network create --internal "$NET" >/dev/null || abort "docker network create"
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB=d1_database pgvector/pgvector:pg16 >/dev/null || abort "postgres start"
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -h 127.0.0.1 -U d1 -d d1_database >/dev/null 2>&1 && break; sleep 1; done

# --- copy of live (revisions/activity data skipped). Only GRANT/REVOKE errors for live-only roles are tolerated.
docker exec "$LIVE_PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=directus_revisions --exclude-table-data=directus_activity' \
  | docker exec -i "$PG" sh -c 'cat > /tmp/live.dump'
ps=("${PIPESTATUS[@]}"); [[ ${ps[0]} -eq 0 && ${ps[1]} -eq 0 ]] || abort "pg_dump of live"
rout=$(docker exec "$PG" pg_restore -U d1 -d d1_database --no-owner --role=d1 /tmp/live.dump 2>&1)
bad=$(grep -A1 '^pg_restore: error:' <<<"$rout" | grep -v -- '^--$' | paste - - | grep -vE 'role "[^"]+" does not exist.*Command was: (GRANT|REVOKE) ' || true)
[[ -z "$bad" ]] || abort "restore" "$bad"
out=$(docker run --rm --network "$NET" -e DATABASE_URL="$URL" -v "$REPO/db:/db" ghcr.io/amacneil/dbmate:2 --no-dump-schema up 2>&1) \
  || abort "dbmate up" "$out"
echo "$out" | grep -E '^Applying' || echo "no pending migrations"

# --- local test users on the copy: an admin (through an admin policy) and a Lab Member (role + people row)
ADMIN_EMAIL="preview-admin-$(rhex 3)@example.com"; LM_EMAIL="preview-member-$(rhex 3)@example.com"
# The copy keeps live's password policy (upper, lower, digit, symbol).
ADMIN_PASS="Pv$(rhex 10)A!"; LM_PASS="Pv$(rhex 10)M!"; TOKEN="preview-$(rhex 16)"
admin_id=$(psql_copy -Atc "
  WITH p AS (SELECT id FROM directus_policies WHERE admin_access ORDER BY name LIMIT 1),
  u AS (INSERT INTO directus_users (id, email, status, token, first_name, last_name)
        VALUES (gen_random_uuid(), '$ADMIN_EMAIL', 'active', '$TOKEN', 'Preview', 'Admin') RETURNING id),
  a AS (INSERT INTO directus_access (id, \"user\", policy) SELECT gen_random_uuid(), u.id, p.id FROM u, p RETURNING id)
  SELECT id FROM u") || abort "create preview admin"
lm_id=$(psql_copy -Atc "
  WITH r AS (SELECT r.id FROM directus_roles r WHERE r.name = 'Lab Member' LIMIT 1),
  u AS (INSERT INTO directus_users (id, email, status, role, first_name, last_name)
        SELECT gen_random_uuid(), '$LM_EMAIL', 'active', r.id, 'Preview', 'Member' FROM r RETURNING id),
  p AS (INSERT INTO people (full_name, user_id, is_researcher, active) SELECT 'Preview Member', id, true, true FROM u RETURNING person_id)
  SELECT id FROM u") || abort "create preview member"
[[ -n "$admin_id" && -n "$lm_id" ]] || abort "no admin policy or no Lab Member role in the copy"

# --- Directus on the copy, published on localhost only
IMAGE=$(docker inspect "$LIVE_DX" --format '{{.Image}}') || abort "docker inspect $LIVE_DX"
docker run -d --name "$DX" -p "127.0.0.1:$PORT:8055" \
  -e KEY="$(rhex 16)" -e SECRET="$(rhex 32)" -e TELEMETRY=false \
  -e DB_CLIENT=pg -e DB_HOST="$PG" -e DB_PORT=5432 -e DB_DATABASE=d1_database -e DB_USER=d1 -e DB_PASSWORD="$DB_PASS" \
  -e PUBLIC_URL="http://127.0.0.1:$PORT" -e EXTENSIONS_AUTO_RELOAD=false -e D1_TIMEZONE=Europe/London \
  -e ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION=8000 -e ASSETS_TRANSFORM_TIMEOUT=30000 \
  -v "$EXT_MOUNT:/directus/extensions:ro" \
  -v "$FILES_VOL:/directus/uploads" \
  "$IMAGE" >/dev/null || abort "directus start"
docker network connect "$NET" "$DX" || abort "connect directus to the copy's network"
for _ in $(seq 1 120); do
  curl -fs "http://127.0.0.1:$PORT/server/health" 2>/dev/null | grep -q '"status":"ok"' && break; sleep 1
done
curl -fs "http://127.0.0.1:$PORT/server/health" >/dev/null || abort "directus not healthy" "$(docker logs --tail 40 "$DX" 2>&1)"

# Passwords through the API so Directus hashes them.
for pair in "$admin_id:$ADMIN_PASS" "$lm_id:$LM_PASS"; do
  mkdir -p .superpowers
  code=$(curl -s -o .superpowers/preview-resp.json -w '%{http_code}' -X PATCH "http://127.0.0.1:$PORT/users/${pair%%:*}" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"password\":\"${pair#*:}\"}")
  [[ "$code" == 2* ]] || abort "set password (HTTP $code)" "$(cat .superpowers/preview-resp.json 2>/dev/null)"
done
mkdir -p .superpowers
printf 'url=http://127.0.0.1:%s/admin\nadmin=%s %s\nmember=%s %s\n' "$PORT" "$ADMIN_EMAIL" "$ADMIN_PASS" "$LM_EMAIL" "$LM_PASS" > "$CREDS"
echo "preview running: http://127.0.0.1:$PORT/admin (test logins in $CREDS; stop with --stop)"
