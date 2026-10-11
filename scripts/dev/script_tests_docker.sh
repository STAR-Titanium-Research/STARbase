#!/usr/bin/env bash
# Local stand-in for CI's "script-tests" job, for machines without a host psql/python (Windows):
# a throwaway pgvector Postgres on an internal Docker network, dbmate up, the reference seed, then
# `pytest -q -rs tests/scripts` in a runner image (psql, jq, curl, python3 + CI's packages) with
# DATABASE_URL and REQUIRE_DB_TESTS=1 (a skipped test counts as a failure, as in CI).
# Extra arguments go to pytest: bash scripts/dev/script_tests_docker.sh tests/scripts/test_fast_ops.py -x
#
# Failures: a harness stage that fails (image build, postgres start, dbmate up, seed) prints a
# greppable `FAIL harness: <stage> (exit N)` line plus that stage's full output and the script
# exits non-zero (cleanup still runs). Otherwise the exit status is pytest's.
#
# Workaround, local only: migration 20261001000123 (operator back-fill) fails on an empty
# database because its operator names are not in people. When that happens the script adds the
# names it reports to people and runs dbmate again (same workaround as schema_test_docker.sh).
#
# Usage: bash scripts/dev/script_tests_docker.sh [pytest args]     (from the repository root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
NET=d1-script-test; PG=d1-script-test-pg; RUNNER=d1-script-runner:2
URL="postgres://d1:ci_secret@$PG:5432/d1_scripts?sslmode=disable"
STATUS=0

cleanup() { docker rm -fv "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
# stage_fail <stage> <exit> <output>: greppable FAIL line, then the stage's full output.
stage_fail() { echo "FAIL harness: $1 (exit $2)"; [[ -n "${3:-}" ]] && echo "$3"; STATUS=1; }
abort() { stage_fail "$@"; cleanup; exit 1; }

if ! docker image inspect "$RUNNER" >/dev/null 2>&1; then
  bout=$(docker build -q -t "$RUNNER" -f scripts/dev/script-runner.Dockerfile scripts/dev 2>&1) \
    || abort "runner image build" $? "$bout"
fi
cleanup
docker network create --internal "$NET" >/dev/null || abort "docker network create" $?
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD=ci_secret \
  -e POSTGRES_DB=d1_scripts pgvector/pgvector:pg16 >/dev/null || abort "postgres container start" $?
# -h 127.0.0.1: the Unix socket answers during the entrypoint's init phase while TCP is still closed.
ready=
for _ in $(seq 1 30); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U d1 -d d1_scripts >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[[ -n "$ready" ]] || { echo "FAIL harness: postgres not ready after 30s"; cleanup; exit 1; }

dbmate() { docker run --rm --network "$NET" -e DATABASE_URL="$URL" -v "$REPO/db:/db" \
  ghcr.io/amacneil/dbmate:2 --no-dump-schema "$@" 2>&1; }

out=$(dbmate up); rc=$?
if grep -q 'operator mapping: names missing' <<<"$out"; then
  echo "$out" | tail -2
  names=$(sed -n 's/.*names missing or ambiguous in people: \(.*\) (P0001).*/\1/p' <<<"$out" | tr -d '\r\n')
  sql=$(printf '%s' "$names" | awk -v RS=', ' '{gsub(/\x27/,"\x27\x27"); printf "INSERT INTO people (full_name) VALUES (\x27%s\x27);\n", $0}')
  sout=$(docker exec -i "$PG" psql -U d1 -d d1_scripts -q -v ON_ERROR_STOP=1 <<<"$sql" 2>&1) \
    || stage_fail "migration 123 workaround insert" $? "$sout"
  echo "(workaround: added $(wc -l <<<"$sql") operator names to people for migration 123)"
  out=$(dbmate up); rc=$?
  [[ $rc -eq 0 ]] && echo "$out" | tail -2 || stage_fail "dbmate up (after workaround)" $rc "$out"
elif [[ $rc -eq 0 ]]; then
  echo "$out" | tail -2
else
  stage_fail "dbmate up" $rc "$out"
fi

seed=$(docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo "$RUNNER" \
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f db/seeds/001_reference_data.sql 2>&1); rc=$?
[[ $rc -eq 0 ]] && echo "$seed" | tail -3 || stage_fail "reference seed" $rc "$seed"

if [[ $STATUS -ne 0 ]]; then cleanup; exit 1; fi

# No bytecode / cache files into the mounted checkout.
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo -e DATABASE_URL="$URL" \
  -e REQUIRE_DB_TESTS=1 -e PYTHONDONTWRITEBYTECODE=1 "$RUNNER" \
  python3 -m pytest -q -rs -p no:cacheprovider "${@:-tests/scripts}" 2>&1
trc=$?

cleanup
exit "$trc"
