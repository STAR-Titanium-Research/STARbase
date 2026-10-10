#!/usr/bin/env bash
# Local stand-in for CI's "migrations" job, for machines without a host psql (Windows):
# a throwaway pgvector Postgres on an internal Docker network, dbmate up, the reference seed,
# then tests/phase1_schema.sh in a runner image with psql + python3. Optional ROUNDTRIP=<n>:
# afterwards roll back the newest n migrations and apply them again.
#
# Workaround, local only: migration 20261001000123 (operator back-fill) fails on an empty
# database because its operator names are not in people. When that happens the script adds the
# names it reports to people and runs dbmate again. CI will need its own fix (tracked separately).
#
# Usage: bash scripts/dev/schema_test_docker.sh        (from the repository root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
NET=d1-schema-test; PG=d1-schema-test-pg; RUNNER=d1-schema-runner:1
URL="postgres://d1:ci_secret@$PG:5432/d1_test?sslmode=disable"

docker image inspect "$RUNNER" >/dev/null 2>&1 \
  || docker build -q -t "$RUNNER" -f scripts/dev/schema-runner.Dockerfile scripts/dev >/dev/null
docker rm -f "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
docker network create --internal "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD=ci_secret \
  -e POSTGRES_DB=d1_test pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U d1 -d d1_test >/dev/null 2>&1 && break; sleep 1; done

dbmate() { docker run --rm --network "$NET" -e DATABASE_URL="$URL" -v "$REPO/db:/db" \
  ghcr.io/amacneil/dbmate:2 --no-dump-schema "$@" 2>&1; }

out=$(dbmate up); echo "$out" | tail -2
if grep -q 'operator mapping: names missing' <<<"$out"; then
  names=$(sed -n 's/.*names missing or ambiguous in people: \(.*\) (P0001).*/\1/p' <<<"$out" | tr -d '\r\n')
  sql=$(printf '%s' "$names" | awk -v RS=', ' '{gsub(/\x27/,"\x27\x27"); printf "INSERT INTO people (full_name) VALUES (\x27%s\x27);\n", $0}')
  docker exec -i "$PG" psql -U d1 -d d1_test -q <<<"$sql"
  echo "(workaround: added $(wc -l <<<"$sql") operator names to people for migration 123)"
  dbmate up | tail -2
fi
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo "$RUNNER" \
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f db/seeds/001_reference_data.sql 2>&1 | tail -3
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo -e DATABASE_URL="$URL" "$RUNNER" \
  bash tests/phase1_schema.sh 2>&1
if [[ -n "${ROUNDTRIP:-}" ]]; then
  echo "== roundtrip: rollback x $ROUNDTRIP, then up"
  for _ in $(seq 1 "$ROUNDTRIP"); do dbmate rollback | tail -1; done
  dbmate up | tail -3
fi
docker rm -f "$PG" >/dev/null; docker network rm "$NET" >/dev/null
