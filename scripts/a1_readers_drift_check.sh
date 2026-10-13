#!/usr/bin/env bash
# a1_readers_drift_check.sh: log the drift count of the record-access readers tables (migration 166, ADR-0013).
#
# The readers tables (sample_readers, operation_readers, ..., d1_private.hidden_records) are derived data kept by triggers.
# d1_private.readers_drift_count() is 0 when they equal what the SQL functions say. Run this nightly and after every import or
# restore (a bulk load that disables triggers leaves them stale). Read only: it never repairs anything.
#
#   DATABASE_URL=postgres://d1:...@localhost:5432/d1_database bash scripts/a1_readers_drift_check.sh
#   D1_DRIFT_PSQL='docker compose exec -T postgres psql -U d1 -d d1_database' bash scripts/a1_readers_drift_check.sh   # no host psql
#   D1_DRIFT_LOG=/var/log/d1-readers-drift.log ...   # also append the line there
#
# Output: one line, `<UTC time> readers drift: 0 (ok)` and exit 0; or `<UTC time> readers drift: N (REBUILD NEEDED: ...)` and exit 1;
# or `... could not be checked` and exit 2 (a scheduler alerts on a non-zero exit). Repair with: SELECT d1_private.readers_rebuild();
set -uo pipefail

if [[ -n "${D1_DRIFT_PSQL:-}" ]]; then
    # shellcheck disable=SC2206
    PSQL=($D1_DRIFT_PSQL)
else
    : "${DATABASE_URL:?set DATABASE_URL (or D1_DRIFT_PSQL, a psql command line)}"
    PSQL=(psql "$DATABASE_URL")
fi

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$1"; [[ -n "${D1_DRIFT_LOG:-}" ]] && echo "$1" >>"$D1_DRIFT_LOG"; return 0; }

count=$("${PSQL[@]}" -X -q -t -A -c "SELECT d1_private.readers_drift_count()" 2>&1)
if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    say "$(now) readers drift: could not be checked (${count//$'\n'/ })"
    exit 2
fi
if [[ "$count" -eq 0 ]]; then
    say "$(now) readers drift: 0 (ok)"
    exit 0
fi
say "$(now) readers drift: $count (REBUILD NEEDED: run SELECT d1_private.readers_rebuild(); then re-check; see docs/runbooks/a1-record-access-cutover.md)"
exit 1
