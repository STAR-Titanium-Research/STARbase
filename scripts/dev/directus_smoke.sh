#!/usr/bin/env bash
# Directus smoke test on a restored copy of live. Written after the T0a incident (2026-10-10):
# every SQL test passed, but Directus treats a NOT NULL column without a default as required and
# refused to create a sample. This harness exercises schema changes through a real Directus:
#   1. throwaway pgvector Postgres on an internal Docker network,
#   2. restore a copy of live into it (pg_dump of the live container; live is only read),
#   3. apply the worktree's pending dbmate migrations (the copy already has what live has),
#   4. set a random admin API token on the COPY only,
#   5. start Directus (the live container's exact image, live's extensions mounted read-only,
#      plus the worktree's extensions named in D1_SMOKE_OVERLAYS overlaid) on the copy,
#   6. run scripts/dev/directus_smoke.mjs against it: one `SMOKE PASS|FAIL <case>` line per case.
# Exit status is non-zero on any FAIL or any harness failure; cleanup always runs.
#
# --skip <version> (repeatable) simulates "this migration was never applied": it is rolled back in
# the copy if live already has it, and withheld from dbmate (a temporary db/ without those files is
# mounted), otherwise `dbmate up` would simply re-apply it. Use it to prove the smoke test catches
# an old incident, e.g.:  bash scripts/dev/directus_smoke.sh --skip 20261010000153
#
# The lm_* cases run as a Lab Member created in the copy (people row with is_researcher, so d1-owner-default
# owns what they create). If Directus answers that user's probe read with the known 400 `"_some" can only be used
# with top level relational alias field` (the Lab Member permission rows), those cases print `SMOKE SKIP <case>:
# <reason>` and the run still exits 0; any other probe failure makes them FAIL. D1_SMOKE_REQUIRE_LM=1 (or true)
# turns the skip into a FAIL; unset, 0 or anything else leaves it off.
#
# D1_SMOKE_OVERLAYS="d1-next-number d1-access-guard ..." (default d1-next-number) lists the extension folders of this
# worktree that replace live's at /directus/extensions/<name> (whole folders, so a rules.json travels with its
# extension). Every A1a run is
#   D1_SMOKE_REQUIRE_LM=1 D1_SMOKE_OVERLAYS="d1-next-number d1-access-guard d1-record-access d1-trace" bash scripts/dev/directus_smoke.sh
# (an overlay name with no folder in this worktree is a harness failure).
#
# Record access (A1a): migration 166 refuses to run while sample_co_owners or project_investigators hold a row whose login no
# longer exists (live has 3), so the harness first runs scripts/a1_clean_dangling_legacy_logins.sql with apply=1 on the COPY (the
# same file the runbook names for live; it runs in the "before" runs too, so the two runs see the same data).
# When the copy has the access tables (migration 165), scripts/dev/access_matrix_oracle.sql (schema ref, the independent
# plain-SQL model) and scripts/dev/access_matrix_fixture.sql are loaded into the COPY before Directus starts: fixture people
# with logins, every restricted/unrestricted combination of a project, campaign, sample, operation and test, access lists, and
# the oracle's evaluation of who may read, update and delete what. Its answer is handed to the lm_access_* cases
# (D1_SMOKE_ACCESS=0 skips it). With migration 166 applied the recompute triggers maintain the readers tables while the fixture
# loads, and the harness asserts d1_private.readers_drift_count() = 0 afterwards.
# D1_SMOKE_MODE=seed loads it and leaves the copy running for hand measurement. D1_SMOKE_MODE=perf loads scripts/dev/seed_access_fixture.sql (restricted records, access rows, big projects) into the
# copy instead and runs scripts/dev/directus_perf.mjs: p50/p95 per list request for a stranger and a member
# (use --skip 20261012000166 --skip 20261012000167 for "before"). D1_SMOKE_KEEP=1 leaves the copy running for debugging
# (docker rm -fv d1-smoke-directus d1-smoke-pg; docker network rm d1-smoke).
#
# Usage: [D1_SMOKE_REQUIRE_LM=1] bash scripts/dev/directus_smoke.sh [--skip <migration-version>...]   (from the repo root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
# What live's Directus mounts at /directus/extensions (override on another machine).
MAIN_CHECKOUT="${D1_MAIN_CHECKOUT:-D:\\Users\\CMBE Admn 3214022001\\Documents\\GitHub\\D1-Database}"
NET=d1-smoke; PG=d1-smoke-pg; DX=d1-smoke-directus
LIVE_PG=d1-database-postgres-1; LIVE_DX=d1-database-directus-1
rhex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
DB_PASS="smoke-$(rhex 8)"
URL="postgres://d1:$DB_PASS@$PG:5432/d1_database?sslmode=disable"
SKIPS=()
TMPDB=
FXDIR=
EXTDIR=
OVERLAYS="${D1_SMOKE_OVERLAYS:-d1-next-number}"
MODE="${D1_SMOKE_MODE:-cases}"
for o in $OVERLAYS; do
  [[ -d "core/extensions/$o" ]] || { echo "FAIL harness: D1_SMOKE_OVERLAYS names core/extensions/$o, which is not in this worktree"; exit 2; }
done

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip) [[ -n "${2:-}" ]] || { echo "FAIL harness: --skip needs a migration version"; exit 2; }
            SKIPS+=("$2"); shift 2 ;;
    *) echo "FAIL harness: unknown argument $1"; exit 2 ;;
  esac
done

cleanup() {
  docker rm -fv "$DX" "$PG" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  [[ -n "$TMPDB" ]] && rm -rf "$TMPDB"
  [[ -n "$FXDIR" ]] && rm -rf "$FXDIR"
  [[ -n "$EXTDIR" ]] && rm -rf "$EXTDIR"
  return 0
}
if [[ "${D1_SMOKE_KEEP:-}" == 1 ]]; then
  trap 'echo "kept: containers d1-smoke-directus and d1-smoke-pg on network d1-smoke"' EXIT
else
  trap cleanup EXIT
fi
# abort <stage> <exit> [output]: greppable FAIL line, then the stage's output; cleanup runs via the trap.
abort() { echo "FAIL harness: $1 (exit $2)"; [[ -n "${3:-}" ]] && echo "$3"; exit 1; }
psql_copy() { docker exec -i "$PG" psql -U d1 -d d1_database -X -q -v ON_ERROR_STOP=1 "$@"; }

cleanup   # clear leftovers of a killed earlier run
docker network create --internal "$NET" >/dev/null || abort "docker network create" $?
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB=d1_database pgvector/pgvector:pg16 >/dev/null || abort "postgres container start" $?
ready=
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -U d1 -d d1_database >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[[ -n "$ready" ]] || abort "postgres not ready after 60s" 1

# --- restore a copy of live (live is only read). Revisions/activity data are skipped: large, not needed.
# Two steps so a failed or truncated dump cannot pass: the dump is streamed into a file in the scratch
# container with both exit codes checked, then restored from that file with every pg_restore error accounted for.
t0=$SECONDS
docker exec "$LIVE_PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=directus_revisions --exclude-table-data=directus_activity' \
  | docker exec -i "$PG" sh -c 'cat > /tmp/live.dump'
ps=("${PIPESTATUS[@]}")
[[ ${ps[0]} -eq 0 && ${ps[1]} -eq 0 ]] || abort "restore: pg_dump of live (pg_dump/cat exit ${ps[0]}/${ps[1]})" 1
# Harness self-test hook: D1_SMOKE_TEST_TRUNCATE_DUMP=<bytes> cuts the dump to prove a broken restore is caught.
[[ -n "${D1_SMOKE_TEST_TRUNCATE_DUMP:-}" ]] \
  && docker exec "$PG" sh -c "head -c $D1_SMOKE_TEST_TRUNCATE_DUMP /tmp/live.dump > /tmp/t && mv /tmp/t /tmp/live.dump"
docker exec "$PG" pg_restore -l /tmp/live.dump >/dev/null 2>&1 || abort "restore: dump file unreadable (truncated?)" $?
rout=$(docker exec "$PG" pg_restore -U d1 -d d1_database --no-owner --role=d1 /tmp/live.dump 2>&1)
# Every "pg_restore: error:" must be explained: a `role "..." does not exist` error on a GRANT/REVOKE (roles
# that exist only on live, e.g. d1_llm_readonly). Anything else (COPY failed, could not read from input
# file, a failed CREATE ...) is a real failure. The count must also equal pg_restore's own
# "errors ignored on restore: N" summary.
acct=$(awk '
  /^pg_restore: error:/ { if (pend) { print "  " err; bad++ } err = $0; pend = 1; total++; next }
  /^Command was:/ { if (pend) { if (err ~ /role "[^"]+" does not exist/ && $0 ~ /^Command was: (GRANT|REVOKE) /) ok++;
                                else { print "  " err; print "  " $0; bad++ } pend = 0 } next }
  END { if (pend) { print "  " err; bad++ } print "COUNTS " total + 0 " " ok + 0 " " bad + 0 }' <<<"$rout")
read -r _ e_total e_ok e_bad <<<"$(grep '^COUNTS ' <<<"$acct")"
e_sum=$(sed -n 's/^pg_restore: warning: errors ignored on restore: \([0-9]*\).*/\1/p' <<<"$rout")
[[ "$e_bad" -eq 0 && "$e_total" -eq "$e_ok" && "${e_sum:-0}" -eq "$e_total" ]] \
  || abort "restore" 1 "unexplained pg_restore errors (errors=$e_total explained=$e_ok summary=${e_sum:-none}):
$(grep -v '^COUNTS ' <<<"$acct" | head -40)
$(tail -5 <<<"$rout")"
# Sanity: the post-data section (indexes, constraints, triggers) made it, i.e. the dump was complete.
trg=$(psql_copy -Atc "SELECT count(*) FROM pg_trigger WHERE tgname IN ('physical_samples_short_id','mfg_op_short_id','test_sessions_short_id','test_sessions_set_code')") \
  || abort "restore check (triggers)" $?
[[ "$trg" == "4" ]] || abort "restore: expected 4 short_id/test_code triggers in the copy, found ${trg:-none}" 1 "$(tail -5 <<<"$rout")"
n=$(psql_copy -Atc "SELECT count(*) FROM schema_migrations") || abort "restore check (schema_migrations missing)" $? "$rout"
[[ "${n:-0}" -gt 0 ]] || abort "restore produced no schema_migrations rows" 1 "$rout"
echo "restored copy of live ($n migrations applied) in $((SECONDS - t0))s"

# --- --skip: roll the skipped migrations back in the copy (newest first) and keep dbmate from re-applying them
DBDIR="$REPO/db"
if [[ ${#SKIPS[@]} -gt 0 ]]; then
  TMPDB=$(mktemp -d)
  mkdir -p "$TMPDB/db"
  cp -r db/. "$TMPDB/db/"
  for v in "${SKIPS[@]}"; do
    f=$(ls db/migrations/"${v}"_*.sql 2>/dev/null | head -1)
    [[ -n "$f" ]] || abort "--skip $v: no such migration file" 1
    rm -f "$TMPDB/db/migrations/$(basename "$f")"
  done
  DBDIR="$(cygpath -m "$TMPDB" 2>/dev/null || echo "$TMPDB")/db"
  for v in $(printf '%s\n' "${SKIPS[@]}" | sort -r); do
    f=$(ls db/migrations/"${v}"_*.sql | head -1)
    if [[ "$(psql_copy -Atc "SELECT count(*) FROM schema_migrations WHERE version='$v'")" == "1" ]]; then
      down=$(awk '/^-- migrate:down/{d=1;next} d' "$f")
      sout=$({ echo "BEGIN;"; echo "$down"; echo "DELETE FROM schema_migrations WHERE version='$v';"; echo "COMMIT;"; } | psql_copy 2>&1) \
        || abort "--skip $v rollback" $? "$sout"
      echo "skipped $v: rolled back in the copy"
    else
      echo "skipped $v: not applied in live, just withheld"
    fi
  done
fi

dbmate() { docker run --rm --network "$NET" -e DATABASE_URL="$URL" -v "$DBDIR:/db" \
  ghcr.io/amacneil/dbmate:2 --no-dump-schema "$@" 2>&1; }
# migration 166 refuses dangling legacy logins (live has 3 project_investigators rows of deleted users): clean them on the copy
# first, exactly as the runbook does on live. A copy from before the legacy tables existed has nothing to clean.
if [[ "$(psql_copy -Atc "SELECT to_regclass('public.sample_co_owners') IS NOT NULL AND to_regclass('public.project_investigators') IS NOT NULL")" == t ]]; then
  cl=$(psql_copy -v apply=1 -f - < scripts/a1_clean_dangling_legacy_logins.sql 2>&1) || abort "clean dangling legacy logins on the copy" $? "$cl"
  echo "cleaned dangling legacy logins on the copy: $(grep '^DELETE' <<<"$cl" | tr '\n' ' ')"
fi
out=$(dbmate up); rc=$?
[[ $rc -eq 0 ]] && echo "$out" | tail -3 || abort "dbmate up" $rc "$out"

# --- admin API token, on the copy only. Directus 11: user -> directus_access (user or role) -> policy.admin_access
TOKEN="smoke-$(rhex 16)"
admin=$(psql_copy -Atc "
  SELECT u.id FROM directus_users u
  WHERE u.status = 'active' AND EXISTS (
    SELECT 1 FROM directus_access a JOIN directus_policies p ON p.id = a.policy
    WHERE p.admin_access AND (a.\"user\" = u.id OR (a.role IS NOT NULL AND a.role = u.role)))
  ORDER BY u.id LIMIT 1") || abort "find admin user" $?
[[ -n "$admin" ]] || abort "no active admin user in the copy" 1
psql_copy -c "UPDATE directus_users SET token = '$TOKEN' WHERE id = '$admin'" >/dev/null || abort "set token" $?

# --- a Lab Member token, on the copy only: a fresh user in the Lab Member role (access through the role's
# policy) with its own people row (people.user_id, ADR-0011), so the row-visibility rules apply to it. Always
# created, never borrowed from a real person in the copy, so it owns and co-owns nothing to begin with.
LM_TOKEN="smoke-lm-$(rhex 16)"
lm_user=$(psql_copy -Atc "
  WITH r AS (SELECT r.id FROM directus_roles r JOIN directus_access a ON a.role = r.id
             JOIN directus_policies p ON p.id = a.policy
             WHERE r.name = 'Lab Member' AND NOT p.admin_access LIMIT 1),
  u AS (INSERT INTO directus_users (id, email, status, role, token, first_name, last_name)
        SELECT gen_random_uuid(), 'smoke-lab-member-$(rhex 4)@example.invalid', 'active', r.id, '$LM_TOKEN', 'Smoke', 'Member'
        FROM r RETURNING id),
  p AS (INSERT INTO people (full_name, user_id, is_researcher, active) SELECT 'Smoke Member', id, true, true FROM u RETURNING person_id)
  SELECT id FROM u") || abort "create Lab Member smoke user" $?
[[ -n "$lm_user" ]] || abort "no Lab Member role in the copy to create the smoke user in" 1

# --- record access: the fixture (people with logins, the restricted/unrestricted matrix, a plain-SQL evaluation of the
# rules) or, in perf mode, the seed. Both only ever touch the copy, before Directus starts.
FXDIR=$(mktemp -d)
FXMOUNT="$(cygpath -m "$FXDIR" 2>/dev/null || echo "$FXDIR")"
has_access=$(psql_copy -Atc "SELECT to_regclass('public.sample_access') IS NOT NULL")
has_readers=$(psql_copy -Atc "SELECT to_regproc('d1_private.readers_rebuild') IS NOT NULL")
if [[ "$has_access" == t && ( "$MODE" == perf || "$MODE" == seed ) ]]; then
  t1=$SECONDS
  psql_copy -f - < scripts/dev/seed_access_fixture.sql >/dev/null || abort "perf seed (scripts/dev/seed_access_fixture.sql)" $?
  echo "seeded the copy in $((SECONDS - t1))s: $(psql_copy -Atc "SELECT (SELECT count(*) FROM physical_samples) || ' samples, ' || (SELECT count(*) FROM manufacturing_operations) || ' operations, ' || (SELECT count(*) FROM sample_access) || ' sample access rows'")"
  if [[ "$has_readers" == t ]]; then
    # the readers tables were maintained by the triggers during the seed; a full rebuild must then change nothing, and the drift
    # check must be empty. Both are timed (the gate records the backfill time and the drift function's run time).
    t1=$(date +%s%3N)
    psql_copy -c "SELECT d1_private.readers_rebuild()" >/dev/null || abort "readers_rebuild() on the seeded copy" $?
    t2=$(date +%s%3N)
    drift=$(psql_copy -Atc "SELECT d1_private.readers_drift_count()") || abort "readers_drift_count() on the seeded copy" $?
    t3=$(date +%s%3N)
    echo "readers_rebuild() on the seeded copy: $((t2 - t1)) ms; readers_drift_count() = $drift in $((t3 - t2)) ms"
    [[ "$drift" == 0 ]] || abort "readers drift after the seed is not empty ($drift rows)" 1 "$(psql_copy -Atc "SELECT kind, problem, count(*) FROM d1_private.readers_drift() GROUP BY 1, 2")"
  fi
elif [[ "$has_access" == t && "${D1_SMOKE_ACCESS:-1}" != 0 ]]; then
  cat scripts/dev/access_matrix_oracle.sql scripts/dev/access_matrix_fixture.sql | psql_copy -f - >/dev/null || abort "access matrix oracle and fixture (scripts/dev/access_matrix_oracle.sql, access_matrix_fixture.sql)" $?
  psql_copy -Atc "SELECT ref.expected_json()" > "$FXDIR/expected.json" || abort "access matrix: plain-SQL evaluation" $?
  echo "access matrix: $(psql_copy -Atc "SELECT count(*) FROM ref.fixture_users") fixture users, expected ids computed in SQL"
  if [[ "$has_readers" == t ]]; then
    drift=$(psql_copy -Atc "SELECT d1_private.readers_drift_count()") || abort "readers_drift_count() after the fixture" $?
    [[ "$drift" == 0 ]] || abort "readers drift after the fixture is not empty ($drift rows)" 1 "$(psql_copy -Atc "SELECT kind, problem, count(*) FROM d1_private.readers_drift() GROUP BY 1, 2")"
    echo "readers_drift() after the fixture: empty"
  fi
fi

# --- Directus: the live container's exact image; live's extensions + this worktree's overlays
IMAGE=$(docker inspect "$LIVE_DX" --format '{{.Image}}') || abort "docker inspect $LIVE_DX" $?
# One merged extensions folder: live's built extensions (the main checkout's), then each overlay of this worktree in
# place of live's (a whole folder, so its rules.json travels with it). A merged copy rather than nested bind mounts,
# because an overlay that live does not have yet (d1-record-access) has no mount point in a read-only folder.
EXTDIR=$(mktemp -d)
copy_ext() { tar -C "$1" --exclude=node_modules --exclude=src -cf - . | tar -C "$2" -xf -; }
copy_ext "$(cygpath -u "$MAIN_CHECKOUT" 2>/dev/null || echo "$MAIN_CHECKOUT")/core/extensions" "$EXTDIR" || abort "copy live's extensions" $?
for o in $OVERLAYS; do
  rm -rf "${EXTDIR:?}/$o"; mkdir -p "$EXTDIR/$o"; copy_ext "core/extensions/$o" "$EXTDIR/$o" || abort "copy overlay $o" $?
done
EXTMOUNT="$(cygpath -m "$EXTDIR" 2>/dev/null || echo "$EXTDIR")"
docker run -d --name "$DX" --network "$NET" \
  -e KEY="$(rhex 16)" -e SECRET="$(rhex 32)" \
  -e DB_CLIENT=pg -e DB_HOST="$PG" -e DB_PORT=5432 -e DB_DATABASE=d1_database -e DB_USER=d1 -e DB_PASSWORD="$DB_PASS" \
  -e PUBLIC_URL="http://$DX:8055" -e EXTENSIONS_AUTO_RELOAD=false -e D1_TIMEZONE=Europe/London \
  -v "$EXTMOUNT:/directus/extensions:ro" \
  "$IMAGE" >/dev/null || abort "directus container start" $?
ready=
for _ in $(seq 1 120); do
  h=$(docker exec "$DX" wget -qO- http://127.0.0.1:8055/server/health 2>/dev/null)
  grep -q '"status":"ok"' <<<"$h" && { ready=1; break; }
  sleep 1
done
[[ -n "$ready" ]] || abort "directus not healthy after 120s" 1 "$(docker logs --tail 60 "$DX" 2>&1)"

# D1_SMOKE_MODE=seed: the seeded copy with Directus running, left for hand measurement (EXPLAIN, rule experiments)
if [[ "$MODE" == seed ]]; then
  echo "seeded copy ready: containers $DX and $PG on network $NET (docker rm -fv $DX $PG; docker network rm $NET)"
  trap - EXIT; exit 0
fi

# --- cases
SCRIPT=directus_smoke.mjs; [[ "$MODE" == perf ]] && SCRIPT=directus_perf.mjs
cout=$(docker run --rm --network "$NET" -e DIRECTUS_URL="http://$DX:8055" -e TOKEN="$TOKEN" -e LM_TOKEN="$LM_TOKEN" -e D1_SMOKE_REQUIRE_LM="${D1_SMOKE_REQUIRE_LM:-}" \
  -e D1_SMOKE_PERF_N="${D1_SMOKE_PERF_N:-20}" -v "$FXMOUNT:/fixture:ro" \
  -v "$REPO/scripts/dev:/smoke:ro" node:20-alpine node /smoke/$SCRIPT 2>&1)
crc=$?
echo "$cout"
if [[ "$MODE" == perf ]]; then
  grep -q '^PERF ' <<<"$cout" && exit "$crc"
  echo "FAIL harness: perf: no PERF lines in the output"; exit 1
fi

# --- file case (T0e): a file that has a file_fingerprints row can still be deleted through Directus, and the
# row goes with it (ON DELETE CASCADE). Upload and delete run in node; the fingerprint insert needs psql here.
node_files() { docker run --rm --network "$NET" -e DIRECTUS_URL="http://$DX:8055" -e TOKEN="$TOKEN" \
  -v "$REPO/scripts/dev:/smoke:ro" node:20-alpine node /smoke/directus_smoke_files.mjs "$@" 2>&1; }
if [[ "$(psql_copy -Atc "SELECT to_regclass('public.file_fingerprints') IS NOT NULL")" == t ]]; then
  fcase=file_delete_cascades_fingerprint
  if ! fid=$(node_files upload) || ! [[ "$fid" =~ ^[0-9a-f-]{36}$ ]]; then
    fline="SMOKE FAIL $fcase: upload: $fid"
  elif ! psql_copy -c "INSERT INTO file_fingerprints (directus_files_id, content_sha256, size_bytes) VALUES ('$fid', repeat('a', 64), 1)" >/dev/null; then
    fline="SMOKE FAIL $fcase: fingerprint insert"
  else
    st=$(node_files delete "$fid")
    left=$(psql_copy -Atc "SELECT count(*) FROM file_fingerprints WHERE directus_files_id = '$fid'")
    if [[ "$st" == 204 && "$left" == 0 ]]; then fline="SMOKE PASS $fcase"
    else fline="SMOKE FAIL $fcase: DELETE /files -> $st, fingerprint rows left: $left"; fi
  fi
  echo "$fline"; cout+=$'\n'"$fline"
  [[ "$fline" == "SMOKE FAIL"* && $crc -eq 0 ]] && crc=1
fi
# On a failed case show the end of Directus's own log: the route logs the cause of a 500 there.
grep -q '^SMOKE FAIL ' <<<"$cout" && { echo "--- directus log (tail) ---"; docker logs --tail 40 "$DX" 2>&1 | cut -c1-600; }
# A failure outside check() (image pull, the .mjs throwing) prints no SMOKE lines: flag it as a harness failure.
if ! grep -q '^SMOKE ' <<<"$cout"; then
  echo "FAIL harness: cases (exit $crc): no SMOKE lines in the output"; exit 1
elif [[ $crc -ne 0 ]] && ! grep -q '^SMOKE FAIL ' <<<"$cout"; then
  echo "FAIL harness: cases (exit $crc): non-zero exit without a SMOKE FAIL line"; exit 1
fi
exit "$crc"
