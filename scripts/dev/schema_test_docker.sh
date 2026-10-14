#!/usr/bin/env bash
# Local stand-in for CI's "migrations" job, for machines without a host psql (Windows):
# a throwaway pgvector Postgres on an internal Docker network, dbmate up, the reference seed,
# then tests/phase1_schema.sh in a runner image with psql + python3. Optional ROUNDTRIP=<n>:
# afterwards roll back the newest n migrations and apply them again.
#
# Failures: a harness stage that fails (image build, postgres start, dbmate up/rollback, seed)
# prints a greppable `FAIL harness: <stage> (exit N)` line plus that stage's full output, and
# the script exits non-zero (cleanup still runs). Otherwise the exit status is that of
# tests/phase1_schema.sh, which is non-zero whenever any check fails (4 do today), so the gate
# for later tasks is "no new FAIL lines vs baseline.txt"; the exit code is extra signal.
#
# Workaround, local only: migration 20261001000123 (operator back-fill) fails on an empty
# database because its operator names are not in people. When that happens the script adds the
# names it reports to people and runs dbmate again. CI will need its own fix (tracked separately).
#
# Also runs tests/readers_matrix.sh (the readers mutation matrix, the oracle and the randomised differential test) and
# tests/people_admin.sh (the People admin attention and access functions) after phase1.
# Usage: bash scripts/dev/schema_test_docker.sh        (from the repository root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
NET=d1-schema-test; PG=d1-schema-test-pg; RUNNER=d1-schema-runner:1
URL="postgres://d1:ci_secret@$PG:5432/d1_test?sslmode=disable"
STATUS=0

cleanup() { docker rm -fv "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
# stage_fail <stage> <exit> <output>: greppable FAIL line, then the stage's full output.
stage_fail() { echo "FAIL harness: $1 (exit $2)"; [[ -n "${3:-}" ]] && echo "$3"; STATUS=1; }
abort() { stage_fail "$@"; cleanup; exit 1; }

if ! docker image inspect "$RUNNER" >/dev/null 2>&1; then
  bout=$(docker build -q -t "$RUNNER" -f scripts/dev/schema-runner.Dockerfile scripts/dev 2>&1) \
    || abort "runner image build" $? "$bout"
fi
cleanup
docker network create --internal "$NET" >/dev/null || abort "docker network create" $?
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD=ci_secret \
  -e POSTGRES_DB=d1_test pgvector/pgvector:pg16 >/dev/null || abort "postgres container start" $?
# -h 127.0.0.1: the Unix socket answers during the entrypoint's init phase while TCP is still closed.
ready=
for _ in $(seq 1 30); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U d1 -d d1_test >/dev/null 2>&1 && { ready=1; break; }
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
  sout=$(docker exec -i "$PG" psql -U d1 -d d1_test -q -v ON_ERROR_STOP=1 <<<"$sql" 2>&1) \
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

docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo -e DATABASE_URL="$URL" "$RUNNER" \
  bash tests/phase1_schema.sh 2>&1
trc=$?

# The readers mutation matrix (migration 166): the trigger-maintained readers tables against the functions and the independent oracle,
# on copies of this database (tests/readers_matrix.sh). MATRIX_SEEDS / MATRIX_STEPS / MATRIX_SEED0 pass through.
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo -e DATABASE_URL="$URL" -e MATRIX_SEEDS -e MATRIX_STEPS -e MATRIX_SEED0 "$RUNNER" \
  bash tests/readers_matrix.sh 2>&1
mrc=$?
[[ $mrc -ne 0 && $trc -eq 0 ]] && trc=$mrc

# The People admin SQL functions (migration 180): attention and access, on a copy of this database (tests/people_admin.sh).
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo -e DATABASE_URL="$URL" "$RUNNER" \
  bash tests/people_admin.sh 2>&1
prc=$?
[[ $prc -ne 0 && $trc -eq 0 ]] && trc=$prc

if [[ -n "${ROUNDTRIP:-}" ]]; then
  echo "== roundtrip: rollback x $ROUNDTRIP, then up"
  for i in $(seq 1 "$ROUNDTRIP"); do
    rout=$(dbmate rollback); rc=$?
    [[ $rc -eq 0 ]] && echo "$rout" | tail -1 || stage_fail "dbmate rollback #$i" $rc "$rout"
  done
  rout=$(dbmate up); rc=$?
  [[ $rc -eq 0 ]] && echo "$rout" | tail -3 || stage_fail "dbmate up (roundtrip)" $rc "$rout"
fi

cleanup
[[ $STATUS -ne 0 ]] && exit 1
exit "$trc"
