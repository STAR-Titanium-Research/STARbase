#!/usr/bin/env bash
# Put the STARbase link tile first in Directus's module bar (spec 2026-10-13-directus-headless §5.6).
# Reads DIRECTUS_PUBLIC_URL from .env (or the first argument) and runs scripts/module_bar_starbase_link.sql
# in the compose postgres. Idempotent. The maintainer runs it on live after migration 171; it is not
# part of configure_all.sh, which must never run on live.
#   bash scripts/set_module_bar_starbase.sh [https://d1-server.tail54eeb6.ts.net]
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:-}"
if [[ -z "$url" && -f .env ]]; then url=$(grep -E '^DIRECTUS_PUBLIC_URL=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r'); fi
[[ "$url" =~ ^https?://[^/]+ ]] || { echo "Need an absolute http(s) DIRECTUS_PUBLIC_URL (got: '${url}')" >&2; exit 1; }
DB_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- | tr -d '\r' || true)
DB_NAME=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- | tr -d '\r' || true)
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -v public_url="$url" \
	-U "${DB_USER:-d1}" -d "${DB_NAME:-d1_database}" < scripts/module_bar_starbase_link.sql
echo "Module bar: STARbase tile -> ${url%/}/d1-links/go"
