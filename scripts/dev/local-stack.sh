#!/usr/bin/env bash
# A REAL local stack for browser-checking STARbase against the repo's server side, with no Docker daemon:
#
#   Postgres 16 (+ pgvector)  <--  dbmate applies db/migrations  <--  Directus 11 (from npm) with core/extensions
#                                                                       ^
#                                                          STARbase (vite dev server, apps/starbase/web)
#
# It exists for the process-map edit mode redesign (docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md, slice 0): every
# later slice is verified in a real browser against THIS, not against packages/starbase-pages/src/pages/map/edit/fakeBuildServer.ts.
#
# Usage (from anywhere; the repo is found from this file's location):
#   bash scripts/dev/local-stack.sh up       # build everything that is missing, start all three, seed. Safe to re-run.
#   bash scripts/dev/local-stack.sh seed     # (re)apply the seed family and the three test logins; Directus must be up
#   bash scripts/dev/local-stack.sh status   # what is running, the URLs, and the test logins
#   bash scripts/dev/local-stack.sh down     # stop STARbase, Directus and Postgres (data kept); `down --purge` also deletes the data
#
# Then run the browser suite (tests/ui/README.md, "Process map edit mode against the local stack"):
#   cd tests/ui && npx playwright test specs/edit-mode.spec.ts
#
# PREREQUISITES
#   * Linux with the Postgres 16 server binaries in /usr/lib/postgresql/16/bin (override PGBIN) and the postgresql-16-pgvector package.
#     The migrations need the extensions uuid-ossp, pg_trgm and vector; `up` stops with a clear message when one is missing.
#   * node 22 + npm on PATH (/opt/node22/bin in the cloud container). The repo's own `npm ci` is run when node_modules is missing.
#   * curl, psql. Root is fine: Postgres refuses to run as root, so it is started through `runuser -u postgres`.
#   * Outbound HTTPS to the npm registry (Directus is installed from npm) and github.com (the dbmate release binary), both through
#     the proxy in the cloud container. Nothing else is downloaded.
#
# WHERE THINGS LIVE (D1_STACK_DIR, default /tmp/d1-local-stack; outside the repo, nothing here is committed)
#   pg/           the Postgres data directory and socket        bin/dbmate     the dbmate binary (v2.23.0, as docs/ci-cd.md)
#   directus/     `npm i directus@11.x` (its own node_modules, NOT the repo's)     uploads/   Directus's local file storage
#   stack.env     secrets generated on first `up`               credentials.txt   the test logins (format of tests/ui/starbase/target.ts)
#   logs/         one log per process                            run/           pid files
#
# PORTS (all on 127.0.0.1 only; override with the variable in brackets)
#   Postgres 54330 [D1_STACK_PG_PORT]   Directus 18057 [D1_STACK_DIRECTUS_PORT]   STARbase 5190 [D1_STACK_STARBASE_PORT]
#   Directus and STARbase keep the ports of tests/ui/starbase/target.ts and apps/starbase/web (DEV_DIRECTUS_URL), so a STARbase dev server
#   needs no config and the existing Playwright helpers work unchanged. STARbase and Directus are both on 127.0.0.1, so the session
#   cookie is same-site and not Secure (plain HTTP), as in the preview of docs/ci-cd.md.
#
# HOW IT MIRRORS docker-compose.yml's `directus` service
#   The same environment variables where they matter to a browser run: DB_*, KEY/SECRET, PUBLIC_URL, CORS_* (STARbase's origin, with
#   credentials), CORS_EXPOSED_HEADERS, the frame-ancestors CSP, SESSION_COOKIE_SECURE=false, STARBASE_URL, the invite/reset allow-lists,
#   STORAGE_LOCATIONS=local, the ASSETS_TRANSFORM_* limits, D1_TIMEZONE, FLOWS_ENV_ALLOW_LIST, WORKER_WEBHOOK_SECRET. The database user
#   is d1, a SUPERUSER as in the postgres image, so d1_private (created by migration 168/190 as d1) is owned by the user Directus uses.
#   EXTENSIONS_PATH is a copy of core/extensions that keeps only what runs server-side (see "Extensions" below).
#
# ORDER OF EVENTS (the same as production, where Directus exists long before the newest migrations)
#   1. initdb + start Postgres, create role d1 and database d1_database.
#   2. `directus bootstrap` on the empty database: the real directus_* tables (with their foreign keys) and one bootstrap admin
#      (token in stack.env). Migration 20260624000030_directus_stubs.sql is CREATE TABLE IF NOT EXISTS, so it then does nothing.
#   3. dbmate up: every migration in db/migrations.
#   4. db/seeds/001_reference_data.sql (materials, manufacturing methods, equipment), as `make seed`.
#   5. scripts/configure_users_and_policies.sql up to its "5. Users" section: the Lab Admin / Lab Member / Lab Viewer roles and policies,
#      and the generated permission rows (scripts/access_rules.json via gen_access_rules.py). Section 5 is the maintainers' own 15 real
#      accounts and is NOT applied here.
#   6. Start Directus, create the three test logins through its API (so passwords are hashed by Directus and the d1-person-link hook
#      makes their People rows), then apply scripts/dev/local-stack.seed.sql (a small sample family).
#   7. Start STARbase's vite dev server.
#
# WHAT WAS NOT RUN, AND WHY
#   * scripts/configure_all.sh: its own header forbids it on a database that has migrations applied (it deletes the directus_fields rows
#     that later migrations added). Only the users-and-policies file is applied, which is what gives the roles and permissions of live.
#     Consequence: the form-layout / interface metadata the configure_*.sql files create is absent. That metadata is Data Studio's; the
#     edit-mode endpoints (d1-build and the item APIs) do not read it. Directus's own field metadata for our tables is whatever the
#     migrations insert (relations, aliases and the readers aliases, which the permission filters need, are inserted by migrations).
#   * Redis, MinIO and the worker/plugin containers: not started. Directus uses its in-memory cache (CACHE_ENABLED unset, as on live) and
#     local file storage. d1-surface-scan (MinIO) answers 503 as on a live without its reader password; nothing in edit mode uses
#     heavy-data, FFT or the crawler workers. No LLM plugin (d1-ask-endpoint will not reach LLM_PLUGIN_URL; edit mode does not call it).
#   * The Directus Data Studio (the /admin app) is off (SERVE_APP=false) and the interface/module extensions (d1-edit-frame, d1-lab-dashboard,
#     ... they are built with `npm run build:extensions`) are not loaded. Only hooks and endpoints are.
#   * Postgres runs with fsync off (throwaway data, much faster migrations). Not a durability claim.
#   * TLS, Caddy and Tailscale: plain HTTP on loopback.
#
# EXTENSIONS
#   Every extension of core/extensions whose package.json `directus:extension` is a `hook` or `endpoint` with an existing entry file is
#   copied to $D1_STACK_DIR/extensions (sources only), keeping the sibling layout because some import ../d1-record-access/index.js. The copy
#   is refreshed on every `up` and `down`/`up` is how an edit to an extension is picked up (EXTENSIONS_AUTO_RELOAD is off). Endpoint
#   bundles that need `npm run build:extensions` first (d1-report has dist/ only after a build) are skipped when their entry is missing.
#
# Idempotent: every step checks its state first. `up` on a running stack only re-applies what is missing and re-seeds.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK="${D1_STACK_DIR:-/tmp/d1-local-stack}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${D1_STACK_PG_PORT:-54330}"
DX_PORT="${D1_STACK_DIRECTUS_PORT:-18057}"
STAR_PORT="${D1_STACK_STARBASE_PORT:-5190}"
DIRECTUS_VERSION="${D1_STACK_DIRECTUS_VERSION:-11.17.4}"
DBMATE_VERSION="${D1_STACK_DBMATE_VERSION:-2.23.0}"
# The last migration applied before scripts/configure_all.sh's SQL files run (see `migrate`).
CONFIGURE_AFTER="${D1_STACK_CONFIGURE_AFTER:-20260629000051}"
DB_NAME=d1_database
DB_USER=d1
DX_URL="http://127.0.0.1:$DX_PORT"
STAR_URL="http://127.0.0.1:$STAR_PORT"

PGDATA="$STACK/pg/data"; PGSOCK="$STACK/pg/sock"
DBMATE="$STACK/bin/dbmate"
ENVF="$STACK/stack.env"; CREDS="$STACK/credentials.txt"
LOGS="$STACK/logs"; RUN="$STACK/run"; EXT_DIR="$STACK/extensions"

say() { printf '== %s\n' "$*"; }
die() { printf 'FAIL local-stack: %s\n' "$*" >&2; exit 1; }
rhex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
as_pg() { if [[ $EUID -eq 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

# ---- small helpers --------------------------------------------------------------------------------------------------------------
load_env() { [[ -f "$ENVF" ]] || return 0; set -a; . "$ENVF"; set +a; }
db_url() { printf 'postgres://%s:%s@127.0.0.1:%s/%s?sslmode=disable' "$DB_USER" "$DB_PASS" "$PG_PORT" "$DB_NAME"; }
psql_d1() { PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" -d "$DB_NAME" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_admin() { psql -h "$PGSOCK" -p "$PG_PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
alive() { local f="$RUN/$1.pid"; [[ -f "$f" ]] && kill -0 "$(cat "$f")" 2>/dev/null; }
wait_for() { # wait_for <seconds> <description> <command...>
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  die "timed out waiting for $what"
}
api() { # api <METHOD> <path> [json]  (the bootstrap admin's static token)
  local m="$1" p="$2"; shift 2
  if [[ $# -gt 0 ]]; then
    curl -sS -X "$m" "$DX_URL$p" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "$1"
  else
    curl -sS -X "$m" "$DX_URL$p" -H "Authorization: Bearer $ADMIN_TOKEN"
  fi
}

# ---- prerequisites --------------------------------------------------------------------------------------------------------------
check_tools() {
  mkdir -p "$STACK" "$LOGS" "$RUN" "$STACK/bin" "$STACK/uploads"
  [[ -x "$PGBIN/pg_ctl" && -x "$PGBIN/initdb" ]] || die "no Postgres 16 server at $PGBIN (set PGBIN)"
  command -v psql >/dev/null || die "psql is not on PATH"
  command -v node >/dev/null || die "node is not on PATH (try PATH=/opt/node22/bin:\$PATH)"
  command -v curl >/dev/null || die "curl is not on PATH"
  [[ $EUID -ne 0 ]] || id postgres >/dev/null 2>&1 || die "running as root needs a 'postgres' OS user (the postgresql-16 package creates it)"
  # extension files: a missing pgvector is the one failure worth naming before the migrations hit it
  for ext in vector pg_trgm uuid-ossp; do
    [[ -f "$(dirname "$PGBIN")/../../share/postgresql/16/extension/$ext.control" || -f "/usr/share/postgresql/16/extension/$ext.control" ]] \
      || die "Postgres extension $ext is not installed (postgresql-16-pgvector for vector)"
  done
}

install_dbmate() {
  [[ -x "$DBMATE" ]] && return 0
  say "downloading dbmate $DBMATE_VERSION"
  curl -fsSL -m 120 -o "$DBMATE.part" "https://github.com/amacneil/dbmate/releases/download/v$DBMATE_VERSION/dbmate-linux-amd64" \
    || die "could not download dbmate (github.com through the proxy); put a dbmate binary at $DBMATE"
  chmod +x "$DBMATE.part" && mv "$DBMATE.part" "$DBMATE"
}

install_directus() {
  if [[ -x "$STACK/directus/node_modules/.bin/directus" ]] && grep -q "\"version\": \"$DIRECTUS_VERSION\"" "$STACK/directus/node_modules/directus/package.json" 2>/dev/null; then
    return 0
  fi
  say "installing directus@$DIRECTUS_VERSION from npm into $STACK/directus (about two minutes the first time)"
  mkdir -p "$STACK/directus"
  [[ -f "$STACK/directus/package.json" ]] || echo '{"name":"d1-local-directus","private":true}' > "$STACK/directus/package.json"
  (cd "$STACK/directus" && npm i "directus@$DIRECTUS_VERSION" --no-audit --no-fund --loglevel=error) >"$LOGS/npm-directus.log" 2>&1 \
    || { tail -20 "$LOGS/npm-directus.log"; die "npm install directus failed (log: $LOGS/npm-directus.log)"; }
}

install_repo_deps() {
  [[ -x "$REPO/node_modules/.bin/vite" ]] && return 0
  say "npm ci in the repo (STARbase's dependencies)"
  (cd "$REPO" && npm ci --no-audit --no-fund --loglevel=error) >"$LOGS/npm-ci.log" 2>&1 \
    || { tail -20 "$LOGS/npm-ci.log"; die "npm ci failed (log: $LOGS/npm-ci.log)"; }
}

gen_env() {
  [[ -f "$ENVF" ]] && return 0
  say "generating secrets and the test logins ($ENVF, $CREDS)"
  # Passwords satisfy a mixed-case/digit/symbol policy like live's, so the same logins would pass it.
  umask 077
  {
    echo "DB_PASS=$(rhex 12)"
    echo "KEY=$(rhex 16)"
    echo "SECRET=$(rhex 32)"
    echo "ADMIN_TOKEN=local-$(rhex 20)"
    echo "BOOTSTRAP_EMAIL=bootstrap@example.com"
    echo "BOOTSTRAP_PASSWORD=Bs$(rhex 10)A!"
    echo "LOCAL_ADMIN_EMAIL=local-admin@example.com"
    echo "LOCAL_ADMIN_PASSWORD=Ad$(rhex 10)A!"
    echo "LOCAL_MEMBER_EMAIL=local-member@example.com"
    echo "LOCAL_MEMBER_PASSWORD=Mb$(rhex 10)A!"
    echo "LOCAL_VIEWER_EMAIL=local-viewer@example.com"
    echo "LOCAL_VIEWER_PASSWORD=Vw$(rhex 10)A!"
  } > "$ENVF"
  load_env
  printf 'url=%s\nadmin=%s %s\nmember=%s %s\nviewer=%s %s\n' "$STAR_URL" \
    "$LOCAL_ADMIN_EMAIL" "$LOCAL_ADMIN_PASSWORD" "$LOCAL_MEMBER_EMAIL" "$LOCAL_MEMBER_PASSWORD" "$LOCAL_VIEWER_EMAIL" "$LOCAL_VIEWER_PASSWORD" > "$CREDS"
}

# ---- Postgres -------------------------------------------------------------------------------------------------------------------
pg_running() { as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

pg_up() {
  if pg_running; then return 0; fi
  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    say "initdb $PGDATA"
    mkdir -p "$STACK/pg" "$PGSOCK"
    [[ $EUID -ne 0 ]] || chown -R postgres "$STACK/pg"
    as_pg "$PGBIN/initdb" -D "$PGDATA" -U postgres -E UTF8 --locale=C.utf8 --auth-local=trust --auth-host=scram-sha-256 >"$LOGS/initdb.log" 2>&1 \
      || { cat "$LOGS/initdb.log"; die "initdb failed"; }
  fi
  say "starting Postgres on 127.0.0.1:$PG_PORT"
  as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -w -t 60 -l "$STACK/pg/postgres.log" \
    -o "-p $PG_PORT -k $PGSOCK -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=100" start >/dev/null \
    || { tail -20 "$STACK/pg/postgres.log"; die "pg_ctl start failed"; }
  psql_admin -c "DO \$\$ BEGIN CREATE ROLE $DB_USER SUPERUSER LOGIN PASSWORD '$DB_PASS'; EXCEPTION WHEN duplicate_object THEN ALTER ROLE $DB_USER PASSWORD '$DB_PASS'; END \$\$" \
    || die "create role $DB_USER"
  if [[ "$(psql_admin -Atc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" != 1 ]]; then
    psql_admin -c "CREATE DATABASE $DB_NAME OWNER $DB_USER" || die "create database"
  fi
}

pg_down() { pg_running && as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null || true; }

# ---- Directus -------------------------------------------------------------------------------------------------------------------
# A copy of core/extensions with only the hooks and endpoints that have their entry file (see the header).
stage_extensions() {
  rm -rf "$EXT_DIR"; mkdir -p "$EXT_DIR"
  local kept=0 dir name
  for dir in "$REPO"/core/extensions/*/; do
    name="$(basename "$dir")"
    [[ -f "$dir/package.json" ]] || continue
    local entry
    entry="$(node -e '
      const p = JSON.parse(require("fs").readFileSync(process.argv[1] + "/package.json", "utf8"))["directus:extension"] || {};
      if (p.type === "hook" || p.type === "endpoint") process.stdout.write(p.path || "");
    ' "$dir")"
    [[ -n "$entry" && -f "$dir/$entry" ]] || continue
    mkdir -p "$EXT_DIR/$name"
    (cd "$dir" && tar --exclude=node_modules --exclude='*.test.mjs' --exclude='*.test.js' -cf - .) | tar -C "$EXT_DIR/$name" -xf -
    kept=$((kept + 1))
  done
  say "staged $kept hook/endpoint extensions in $EXT_DIR"
}

directus_env() { # the environment of both `bootstrap` and `start`
  cat <<EOF
HOST=127.0.0.1
PORT=$DX_PORT
KEY=$KEY
SECRET=$SECRET
DB_CLIENT=pg
DB_HOST=127.0.0.1
DB_PORT=$PG_PORT
DB_DATABASE=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
ADMIN_EMAIL=$BOOTSTRAP_EMAIL
ADMIN_PASSWORD=$BOOTSTRAP_PASSWORD
ADMIN_TOKEN=$ADMIN_TOKEN
PUBLIC_URL=$DX_URL
TELEMETRY=false
SERVE_APP=false
EXTENSIONS_PATH=$EXT_DIR
EXTENSIONS_AUTO_RELOAD=false
STORAGE_LOCATIONS=local
STORAGE_LOCAL_DRIVER=local
STORAGE_LOCAL_ROOT=$STACK/uploads
CORS_ENABLED=true
CORS_ORIGIN=$STAR_URL
CORS_CREDENTIALS=true
CORS_EXPOSED_HEADERS=Content-Range,Content-Disposition
CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS='self' $STAR_URL
SESSION_COOKIE_SECURE=false
STARBASE_URL=$STAR_URL
USER_INVITE_URL_ALLOW_LIST=$STAR_URL/accept-invite
PASSWORD_RESET_URL_ALLOW_LIST=$STAR_URL/reset-password,$DX_URL/admin/reset-password
ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION=8000
ASSETS_TRANSFORM_TIMEOUT=30000
ASSETS_TRANSFORM_MAX_CONCURRENT=4
D1_TIMEZONE=Europe/London
WORKER_WEBHOOK_SECRET=local-not-used
FLOWS_ENV_ALLOW_LIST=WORKER_WEBHOOK_SECRET
LOG_LEVEL=info
EOF
}

run_directus() { # run_directus <subcommand> : with exactly the environment directus_env prints
  local vars; mapfile -t vars < <(directus_env)
  ( cd "$STACK/directus" && exec env "${vars[@]}" node_modules/.bin/directus "$@" )
}

directus_bootstrapped() {
  [[ "$(psql_d1 -Atc "SELECT to_regclass('public.directus_users') IS NOT NULL")" == t ]] \
    && [[ "$(psql_d1 -Atc "SELECT count(*) FROM directus_users WHERE email = '$BOOTSTRAP_EMAIL'")" == 1 ]]
}

directus_bootstrap() {
  directus_bootstrapped && return 0
  say "directus bootstrap (the real directus_* tables and the bootstrap admin)"
  run_directus bootstrap >"$LOGS/directus-bootstrap.log" 2>&1 || { tail -30 "$LOGS/directus-bootstrap.log"; die "directus bootstrap failed"; }
}

directus_healthy() { curl -fs "$DX_URL/server/health" 2>/dev/null | grep -q '"status":"ok"'; }

directus_start() {
  if alive directus && directus_healthy; then return 0; fi
  alive directus && { kill "$(cat "$RUN/directus.pid")" 2>/dev/null || true; sleep 1; }
  stage_extensions
  say "starting Directus on $DX_URL"
  ( run_directus start >"$LOGS/directus.log" 2>&1 & echo $! > "$RUN/directus.pid" )
  wait_for 120 "Directus health ($LOGS/directus.log)" directus_healthy
}

directus_stop() {
  if alive directus; then
    local pid; pid="$(cat "$RUN/directus.pid")"
    pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  fi
  rm -f "$RUN/directus.pid"
  # the node process Directus's CLI wrapper started, if the wrapper's pid was not the server's
  pkill -f "$STACK/directus/node_modules" 2>/dev/null || true
}

# Live's directus_collections already holds the nav "folder" rows (inventory, ...) that scripts/configure_directus.sql made long before
# migration 20260703000057 files collections under them; this stack does not run that script (see the header), so Directus's foreign key
# directus_collections.group -> directus_collections would refuse those migrations. CI avoids it the same way: its directus_* tables are
# stubs without foreign keys. Only that one constraint is dropped; the folders themselves are Data Studio navigation, which is off here.
relax_directus_fks() {
  psql_d1 -c "ALTER TABLE directus_collections DROP CONSTRAINT IF EXISTS directus_collections_group_foreign" >/dev/null
}

# ---- migrations, reference data, roles and policies ----------------------------------------------------------------------------
dbmate_up() { # dbmate_up <migrations dir>
  local out
  out="$("$DBMATE" --url "$(db_url)" --migrations-dir "$1" --no-dump-schema up 2>&1)" \
    || { printf '%s\n' "$out" | tail -30; die "dbmate up failed"; }
  printf '%s\n' "$out" | grep -c '^Applying' | sed 's/^/   applied: /'
}

# Directus's field, collection, relation and preset metadata of live: the configure_*.sql files of scripts/configure_all.sh, in its order.
# They carry the labels, required flags, hidden fields and groups the process map's draft forms are drawn from, and d1-build reads its
# REQUIRED checks from the same rows (core/extensions/d1-build `parseRequired`): without them physical_samples has 23 field rows instead of
# its hundred-odd and spec §3 item 4 (`current_status` required but never shown) cannot show. configure_all.sh itself is not run: it
# `docker exec`s into containers and restarts Directus. Each file is its own transaction with ON_ERROR_STOP.
configure_metadata() {
  say "Directus metadata (the configure_*.sql files of scripts/configure_all.sh, in order)"
  local f
  for f in $(sed -n '/^FILES=(/,/^)/p' "$REPO/scripts/configure_all.sh" | grep -o '[a-z_]*\.sql'); do
    psql_d1 -f "$REPO/scripts/$f" >/dev/null || die "scripts/$f failed"
  done
}

# The migrations, in the order live lived them: scripts/configure_all.sh was run in the summer on a database that had only the early
# migrations (configure_all.sh's own header: it deletes the directus_fields rows that LATER migrations added, which is what happened on
# live and why migration ...143 repairs it). So the early migrations go first (every one up to D1_STACK_CONFIGURE_AFTER), then the
# configure scripts, then everything else, whose metadata inserts land on top. Running the scripts after all 200+ migrations instead
# wipes the `subject` alias of test_sessions, the inline parameter fields and more, and the process map's test queries then answer 403.
# The scripts run only on a fresh database (marker run/configured); a later `up` with new migrations just applies them.
migrate() {
  say "dbmate up"
  relax_directus_fks
  roles_first
  if [[ -f "$RUN/configured" ]]; then dbmate_up "$REPO/db/migrations"; return; fi
  local early f b; early="$(mktemp -d)"
  for f in "$REPO"/db/migrations/*.sql; do
    b="$(basename "$f")"
    [[ "${b%%_*}" -le "$CONFIGURE_AFTER" ]] && ln -s "$f" "$early/$b"
  done
  dbmate_up "$early"; rm -rf "$early"
  configure_metadata; touch "$RUN/configured"
  dbmate_up "$REPO/db/migrations"
}

reference_data() {
  say "reference data (db/seeds/001_reference_data.sql)"
  psql_d1 -f "$REPO/db/seeds/001_reference_data.sql" >/dev/null
}

# The three roles, their policies and bindings (sections 0-3 of scripts/configure_users_and_policies.sql) BEFORE the migrations, as on live
# where they have existed since July: migration ...066 and later insert Lab Member permission rows, and real Directus's foreign key
# directus_permissions.policy refuses a row whose policy is missing (CI's stub tables have no such key).
roles_first() {
  psql_d1 -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' >/dev/null
  local f; f="$(mktemp)"
  awk '/^-- 4\. Lab Member permissions/ { exit } { print }' "$REPO/scripts/configure_users_and_policies.sql" > "$f"
  echo 'COMMIT;' >> "$f"
  psql_d1 -f "$f" >/dev/null || { rm -f "$f"; die "creating the roles and policies failed"; }
  rm -f "$f"
}

# After the migrations: the whole generated permission set of the Lab Member and Lab Viewer policies (sections 0-4b; section 5, the
# maintainers' own 15 accounts, is left out). The script deletes and re-inserts those policies' rows, so this is idempotent.
policies() {
  say "roles, policies and permissions (scripts/configure_users_and_policies.sql sections 0-4b)"
  local f; f="$(mktemp)"
  awk '/^-- 5\. Users/ { exit } { print }' "$REPO/scripts/configure_users_and_policies.sql" > "$f"
  echo 'COMMIT;' >> "$f"
  psql_d1 -f "$f" >/dev/null || { rm -f "$f"; die "configure_users_and_policies.sql failed"; }
  rm -f "$f"
}

# ---- logins and the seed family -------------------------------------------------------------------------------------------------
ROLE_ADMIN=10000001-0000-0000-0000-000000000001
ROLE_MEMBER=10000001-0000-0000-0000-000000000002
ROLE_VIEWER=10000001-0000-0000-0000-000000000003

ensure_user() { # ensure_user <email> <password> <role id> <first> <last>
  local email="$1" pass="$2" role="$3" first="$4" last="$5" id
  id="$(api GET "/users?filter%5Bemail%5D%5B_eq%5D=$email&fields=id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.data&&j.data[0]?j.data[0].id:"")})')"
  if [[ -z "$id" ]]; then
    local body
    body="$(printf '{"email":"%s","password":"%s","role":"%s","first_name":"%s","last_name":"%s","status":"active"}' "$email" "$pass" "$role" "$first" "$last")"
    api POST /users "$body" | grep -q '"id"' || die "creating user $email"
  else
    api PATCH "/users/$id" "$(printf '{"password":"%s","role":"%s","status":"active"}' "$pass" "$role")" | grep -q '"id"' || die "updating user $email"
  fi
}

seed() {
  directus_healthy || die "Directus is not up (run: bash scripts/dev/local-stack.sh up)"
  load_env
  say "test logins"
  ensure_user "$LOCAL_ADMIN_EMAIL" "$LOCAL_ADMIN_PASSWORD" "$ROLE_ADMIN" Local Admin
  ensure_user "$LOCAL_MEMBER_EMAIL" "$LOCAL_MEMBER_PASSWORD" "$ROLE_MEMBER" Local Member
  ensure_user "$LOCAL_VIEWER_EMAIL" "$LOCAL_VIEWER_PASSWORD" "$ROLE_VIEWER" Local Viewer
  say "seed family (scripts/dev/local-stack.seed.sql)"
  psql_d1 -v admin_email="$LOCAL_ADMIN_EMAIL" -v member_email="$LOCAL_MEMBER_EMAIL" -v viewer_email="$LOCAL_VIEWER_EMAIL" \
    -f "$REPO/scripts/dev/local-stack.seed.sql" >/dev/null || die "seed failed"
}

# ---- STARbase -------------------------------------------------------------------------------------------------------------------
starbase_healthy() { curl -fs "$STAR_URL/" >/dev/null 2>&1; }

starbase_start() {
  if alive starbase && starbase_healthy; then return 0; fi
  install_repo_deps
  say "starting STARbase (vite dev server) on $STAR_URL, pointed at $DX_URL"
  ( cd "$REPO/apps/starbase/web" \
    && VITE_DIRECTUS_URL="$DX_URL" nohup "$REPO/node_modules/.bin/vite" --host 127.0.0.1 --port "$STAR_PORT" --strictPort >"$LOGS/starbase.log" 2>&1 &
    echo $! > "$RUN/starbase.pid" )
  wait_for 90 "STARbase ($LOGS/starbase.log)" starbase_healthy
}

starbase_stop() {
  if alive starbase; then
    local pid; pid="$(cat "$RUN/starbase.pid")"
    pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true
  fi
  rm -f "$RUN/starbase.pid"
}

# ---- subcommands ----------------------------------------------------------------------------------------------------------------
cmd_up() {
  local t0=$SECONDS
  check_tools; install_dbmate; install_directus; gen_env; load_env
  pg_up
  directus_bootstrap
  local pending
  pending="$("$DBMATE" --url "$(db_url)" --migrations-dir "$REPO/db/migrations" --no-dump-schema status 2>&1 | sed -n 's/^Pending: //p')"
  if [[ "${pending:-1}" != 0 || "$(psql_d1 -Atc "SELECT to_regclass('public.physical_samples') IS NULL")" == t ]]; then
    migrate; reference_data; policies
  fi
  directus_start
  seed
  starbase_start
  say "up in $((SECONDS - t0))s"
  cmd_status
}

cmd_down() {
  starbase_stop; directus_stop; pg_down
  if [[ "${1:-}" == --purge ]]; then
    rm -rf "$PGDATA" "$STACK/pg" "$STACK/uploads" "$ENVF" "$CREDS" "$EXT_DIR" "$RUN"
    say "stopped; data, secrets and logins deleted (the npm install and dbmate in $STACK are kept)"
  else
    say "stopped (data kept in $STACK; \`down --purge\` deletes it)"
  fi
}

cmd_status() {
  load_env
  local pgs="stopped" dxs="stopped" sts="stopped"
  pg_running && pgs="running on 127.0.0.1:$PG_PORT"
  alive directus && directus_healthy && dxs="healthy at $DX_URL"
  alive starbase && starbase_healthy && sts="serving $STAR_URL"
  echo "stack dir  $STACK"
  echo "postgres   $pgs   (psql 'postgres://$DB_USER:<DB_PASS in $ENVF>@127.0.0.1:$PG_PORT/$DB_NAME')"
  echo "directus   $dxs   (extensions: $EXT_DIR, log: $LOGS/directus.log)"
  echo "starbase   $sts   (log: $LOGS/starbase.log)"
  if [[ -f "$CREDS" ]]; then
    echo "logins     (file: $CREDS)"
    sed -e 's/^url=/  STARbase  /' -e 's/^admin=/  admin     /' -e 's/^member=/  member    /' -e 's/^viewer=/  viewer    /' "$CREDS"
    echo "  bootstrap admin token (Authorization: Bearer ...): ${ADMIN_TOKEN:-?}"
  else
    echo "logins     none yet (run: bash scripts/dev/local-stack.sh up)"
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) shift; cmd_down "$@" ;;
  seed) check_tools; load_env; [[ -n "${DB_PASS:-}" ]] || die "no stack yet (run: bash scripts/dev/local-stack.sh up)"; seed ;;
  status) cmd_status ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed -n '/^# Usage/,/^#   bash scripts\/dev\/local-stack.sh down/p' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
