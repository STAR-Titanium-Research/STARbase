#!/usr/bin/env bash
# Prove the newest migration is reversible: apply everything, roll the newest back,
# re-apply it, then run the schema test suites CI runs. Mirrors the `migrations`
# job in .github/workflows/ci.yml on a smaller scale.
#
# Usage: DATABASE_URL=... verify_migration.sh [--no-tests]
# Use a scratch database — this writes to it. scratch_pg.sh gives you one.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to a scratch database (see scratch_pg.sh)}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

if command -v dbmate >/dev/null; then
  dbmate() { command dbmate --no-dump-schema "$@"; }
elif docker info >/dev/null 2>&1; then
  dbmate() { docker run --rm --network host -e DATABASE_URL="$DATABASE_URL" \
    -v "$root/db:/db" ghcr.io/amacneil/dbmate:2 --no-dump-schema "$@"; }
else
  echo "Need dbmate on PATH or a running Docker daemon." >&2
  echo "  curl -fsSL -o /usr/local/bin/dbmate https://github.com/amacneil/dbmate/releases/download/v2.23.0/dbmate-linux-amd64 && chmod +x /usr/local/bin/dbmate" >&2
  exit 1
fi

echo "== up (all pending)";      dbmate up
echo "== down (newest)";         dbmate down
echo "== up (newest again)";     dbmate up
echo "== status";                dbmate status | tail -3

[[ "${1:-}" == "--no-tests" ]] && exit 0

echo "== seed";                  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f db/seeds/001_reference_data.sql >/dev/null
for t in tests/phase1_schema.sh tests/phase7_traceability.sh tests/phase6_text_to_sql.sh; do
  echo "== $t";                  bash "$t"
done
