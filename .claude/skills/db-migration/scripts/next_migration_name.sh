#!/usr/bin/env bash
# Print the next dbmate migration filename for db/migrations/.
#
# Names are YYYYMMDD + a 6-digit running sequence + _slug.sql, e.g.
# 20260930000115_backfill_legacy_geometry_forms.sql. The date is today's, or the
# latest migration's if that is later, so the new file always sorts last.
#
# Usage: next_migration_name.sh [slug words...]
set -euo pipefail

dir="$(git rev-parse --show-toplevel)/db/migrations"
slug="$(printf '%s' "${*:-description}" | tr '[:upper:] -' '[:lower:]__' | tr -cd 'a-z0-9_')"

last="$(find "$dir" -maxdepth 1 -name '[0-9]*_*.sql' -printf '%f\n' | sort | tail -1)"
last_date="${last:0:8}"
last_seq="${last:8:6}"

date="$(date +%Y%m%d)"
[[ "$last_date" > "$date" ]] && date="$last_date"

printf '%s%06d_%s.sql\n' "$date" $((10#$last_seq + 1)) "$slug"
