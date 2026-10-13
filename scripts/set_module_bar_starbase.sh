#!/usr/bin/env bash
# Put the STARbase link tile first in Directus's module bar (spec 2026-10-13-directus-headless §5.6).
# Reads DIRECTUS_PUBLIC_URL from .env (or the first argument) and runs scripts/module_bar_starbase_link.sql
# in the compose postgres. Idempotent. The maintainer runs it on live after migration 171; it is not
# part of configure_all.sh, which must never run on live.
#   bash scripts/set_module_bar_starbase.sh [https://d1-server.tail54eeb6.ts.net]
set -euo pipefail
cd "$(dirname "$0")/.."
# One value of .env: the last assignment, an inline " # comment" dropped first, then quotes and
# whitespace removed. Empty (and no failure) when the file or the key is missing.
env_value() {
	[[ -f .env ]] || return 0
	{ grep -E "^$1=" .env || true; } | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//' | tr -d "\"' \r"
}
url="${1:-}"
if [[ -z "$url" ]]; then url=$(env_value DIRECTUS_PUBLIC_URL); fi
[[ "$url" =~ ^https?://[^/]+ ]] || { echo "Need an absolute http(s) DIRECTUS_PUBLIC_URL (got: '${url}')" >&2; exit 1; }
DB_USER=$(env_value POSTGRES_USER)
DB_NAME=$(env_value POSTGRES_DB)
out=$(docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -v public_url="$url" \
	-U "${DB_USER:-d1}" -d "${DB_NAME:-d1_database}" < scripts/module_bar_starbase_link.sql)
echo "$out"
if grep -qx 'UPDATE 0' <<<"$out"; then
	echo "WARNING: no row changed: directus_settings.module_bar is NULL (or not a list), so Directus shows its default bar and there is nothing to put the tile into. Open Settings > Modules once in Data Studio (or save it), then run this again." >&2
fi
echo "Module bar: STARbase tile -> ${url%/}/d1-links/go"
