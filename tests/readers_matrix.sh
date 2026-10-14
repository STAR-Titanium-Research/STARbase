#!/usr/bin/env bash
# The readers mutation matrix (A1a Task 2, spec section 10): the trigger-maintained readers tables of migration 166 must always equal
# the d1_private functions, and the functions must equal the independent plain-SQL oracle scripts/dev/access_matrix_oracle.sql.
#
#   1. function = oracle: the fixture's 32 universes x all users, every type, plus the narrowed amnesty, the junction and hidden records;
#   2. the mutation matrix: one case per row of the spec's trigger-coverage table (rows 1 to 51) and every mutation class of
#      section 10. Each case mutates, asserts d1_private.readers_drift() is EMPTY FOR ALL RECORDS (not only the touched ones), asserts at
#      least one explicit effect, reverses the mutation and asserts both again. Cases run in a subtransaction that is rolled back.
#      The c_team_* cases (migration 176) do the same for team grants: grant, join, leave, trust and a deleted team;
#      the c_team_own_* cases (migration 177) for team ownership (the owner grant, manage = edit, the manager flag, clearing), against the oracle too;
#   3. the multi-form cases that need their own transaction or session: COPY, a 1000-row insert, the importer's ON CONFLICT DO UPDATE,
#      TRUNCATE of every input table, a disabled trigger (detected by readers_drift, repaired by readers_rebuild), REPEATABLE READ (raises);
#   4. the concurrency cases (two sessions, each in both commit orders): 0 (campaign_samples insert against restricting the campaign),
#      A (an operation repointed onto S against restricting S, removing its co-owner, adding it to a restricted campaign), B (a
#      campaign_samples insert against restricting the campaign's PROJECT), a login unlinked while the same person is added to a record,
#      or made the owner of a sample, a forced lock-order deadlock with a row lock, and the people-row deadlock (people.user_id update against an
#      owner change; it must not happen with people_readers_lock and must happen without it);
#   5. the backfill and a big-project restrict on DEFAULT max_locks_per_transaction, with the peak pg_locks count;
#   6. the seeded randomised differential test: random universes against the oracle as a full users x records cross product, then random
#      mutation sequences with readers_drift() after every step (the seed is fixed and printed on failure).
#
# Runs against a database that is migrated to the head (it works on COPIES of it: CREATE DATABASE ... TEMPLATE, so nothing is left behind).
# Usage: DATABASE_URL=postgres://d1:pw@host:5432/d1_test bash tests/readers_matrix.sh      (run by scripts/dev/schema_test_docker.sh)
# Env: MATRIX_SEEDS (default 12) random universes, MATRIX_STEPS (default 18) mutation steps per universe, MATRIX_SEED0 (default 1).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
: "${DATABASE_URL:?DATABASE_URL must be set}"

# the same server, another database (a trailing ?query stays)
url_for() { sed -E "s#(://[^/]+/)[^/?]+#\1$1#" <<<"$DATABASE_URL"; }
SRC_DB=$(sed -E 's#^.*://[^/]+/([^/?]+).*$#\1#' <<<"$DATABASE_URL")
ADMIN_URL=$(url_for postgres)
FIX_DB="${SRC_DB}_mx_fix"
RND_DB="${SRC_DB}_mx_rnd"
FIX_URL=$(url_for "$FIX_DB")
RND_URL=$(url_for "$RND_DB")
SEEDS="${MATRIX_SEEDS:-12}"
STEPS="${MATRIX_STEPS:-18}"
SEED0="${MATRIX_SEED0:-1}"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
q()  { psql "$1" --no-psqlrc -X -t -A -q -v ON_ERROR_STOP=1 -c "$2" 2>&1; }
qf() { psql "$1" --no-psqlrc -X -t -A -q -v ON_ERROR_STOP=1 -f - 2>&1; }

cleanup() { psql "$ADMIN_URL" --no-psqlrc -X -q -c "DROP DATABASE IF EXISTS $FIX_DB WITH (FORCE)" -c "DROP DATABASE IF EXISTS $RND_DB WITH (FORCE)" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
for db in "$FIX_DB" "$RND_DB"; do
  psql "$ADMIN_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db TEMPLATE $SRC_DB" || { bad "cannot copy $SRC_DB to $db (other sessions connected?)"; echo "Results: $pass passed, $fail failed"; exit 1; }
done

# ------------------------------------------------------------------------------------------------------------------------------
# The harness: schema m. Fresh people, record builders, the checks, and a runner that executes a case in a subtransaction.
# ------------------------------------------------------------------------------------------------------------------------------
read -r -d '' HARNESS <<'SQL'
CREATE SCHEMA IF NOT EXISTS m;
CREATE TABLE IF NOT EXISTS m.results (n serial PRIMARY KEY, name text, ok boolean, detail text);

CREATE OR REPLACE FUNCTION m.u(n text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('m-user-' || n)::uuid $$;
CREATE OR REPLACE FUNCTION m.pe(n text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN n IS NULL THEN NULL ELSE md5('m-person-' || n)::uuid END $$;
CREATE OR REPLACE FUNCTION m.id(l text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('m-id-' || l)::uuid $$;

-- people with a login: a b c d e f; z has a People row and no login
INSERT INTO directus_users (id, email, status, first_name, last_name)
SELECT m.u(n), 'm-' || n || '@example.invalid', 'active', 'M', n FROM unnest(ARRAY['a','b','c','d','e','f']) AS n
ON CONFLICT DO NOTHING;
INSERT INTO people (person_id, full_name, user_id, is_researcher, active)
SELECT m.pe(n), 'M ' || n, m.u(n), true, true FROM unnest(ARRAY['a','b','c','d','e','f']) AS n ON CONFLICT DO NOTHING;
INSERT INTO people (person_id, full_name, is_researcher, active) VALUES (m.pe('z'), 'M z', true, true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION m.fail(msg text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'm_fail: %', msg USING ERRCODE = 'M0002'; END $$;
CREATE OR REPLACE FUNCTION m.expect(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'm_fail: %', msg USING ERRCODE = 'M0002'; END IF; END $$;
CREATE OR REPLACE FUNCTION m.done() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'm_ok' USING ERRCODE = 'M0001'; END $$;

-- the drift check, for ALL records: empty, or fail with the first differences
CREATE OR REPLACE FUNCTION m.drift(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint; detail text;
BEGIN
    SELECT count(*) INTO n FROM d1_private.readers_drift();
    IF n > 0 THEN
        SELECT string_agg(x.kind || ' ' || x.problem || ' ' || left(x.record_id::text, 8) || '/' || coalesce(left(x.user_id::text, 8), '-'), ', ')
          INTO detail FROM (SELECT * FROM d1_private.readers_drift() LIMIT 6) x;
        RAISE EXCEPTION 'm_fail: drift after %: % row(s): %', label, n, detail USING ERRCODE = 'M0002';
    END IF;
END $$;

-- does user usr read record rec (by the materialised tables)
CREATE OR REPLACE FUNCTION m.rd(kind text, rec uuid, usr uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT CASE kind
        WHEN 'sample' THEN EXISTS (SELECT 1 FROM sample_readers WHERE record_id = rec AND user_id = usr)
        WHEN 'operation' THEN EXISTS (SELECT 1 FROM operation_readers WHERE record_id = rec AND user_id = usr)
        WHEN 'test' THEN EXISTS (SELECT 1 FROM test_readers WHERE record_id = rec AND user_id = usr)
        WHEN 'campaign' THEN EXISTS (SELECT 1 FROM campaign_readers WHERE record_id = rec AND user_id = usr)
        WHEN 'project' THEN EXISTS (SELECT 1 FROM project_readers WHERE record_id = rec AND user_id = usr)
        WHEN 'junction' THEN EXISTS (SELECT 1 FROM campaign_sample_readers WHERE record_id = rec AND user_id = usr)
    END $$;
CREATE OR REPLACE FUNCTION m.open(rec uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM operation_open_to_all WHERE record_id = rec) $$;
CREATE OR REPLACE FUNCTION m.hid(kind text, rec uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT d1_private.is_hidden(kind, rec) $$;

-- record builders (a person is named by its short name, NULL for none)
CREATE OR REPLACE FUNCTION m.mk_project(l text, pi text DEFAULT NULL, r boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
    INSERT INTO projects (project_id, project_code, project_name, principal_investigator_person, restricted)
    VALUES (m.id(l), 'M' || l, 'M ' || l, m.pe(pi), r) RETURNING project_id INTO v;
    RETURN v;
END $$;
CREATE OR REPLACE FUNCTION m.mk_campaign(l text, proj uuid DEFAULT NULL, own text DEFAULT NULL, r boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
    INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, owner_person_id, restricted)
    VALUES (m.id(l), proj, 'testing_campaign', 'M ' || l, m.pe(own), r) RETURNING campaign_id INTO v;
    RETURN v;
END $$;
CREATE OR REPLACE FUNCTION m.mk_sample(l text, proj uuid DEFAULT NULL, own text DEFAULT NULL, r boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
    INSERT INTO physical_samples (sample_id, sample_code, project_id, owner_person_id, restricted)
    VALUES (m.id(l), 'M-' || l, proj, m.pe(own), r) RETURNING sample_id INTO v;
    RETURN v;
END $$;
CREATE OR REPLACE FUNCTION m.mk_op(l text, smp uuid DEFAULT NULL, proj uuid DEFAULT NULL, camp uuid DEFAULT NULL, own text DEFAULT NULL, r boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
    INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, project_id, campaign_id, owner_person_id, restricted, source_system)
    VALUES (m.id(l), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'HT'), smp, proj, camp, m.pe(own), r,
            CASE WHEN smp IS NULL THEN 'm_test' END) RETURNING operation_id INTO v;
    RETURN v;
END $$;
CREATE OR REPLACE FUNCTION m.mk_test(l text, smp uuid DEFAULT NULL, proj uuid DEFAULT NULL, camp uuid DEFAULT NULL, own text DEFAULT NULL, r boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
    INSERT INTO test_sessions (session_id, test_type, sample_id, project_id, campaign_id, owner_person_id, restricted)
    VALUES (m.id(l), 'hardness', smp, proj, camp, m.pe(own), r) RETURNING session_id INTO v;
    RETURN v;
END $$;
CREATE OR REPLACE FUNCTION m.mk_cs(camp uuid, smp uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (camp, smp) RETURNING id INTO v; RETURN v; END $$;

-- the runner: one case = one function m.<name>() that ends with m.done(); everything it did is rolled back
CREATE OR REPLACE FUNCTION m.run(fname text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE msg text; good boolean := false;
BEGIN
    BEGIN
        EXECUTE format('SELECT m.%I()', fname);
        msg := 'the case did not end with m.done()';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'M0001' THEN good := true; msg := NULL; ELSE msg := SQLSTATE || ' ' || SQLERRM; END IF;
    END;
    INSERT INTO m.results (name, ok, detail) VALUES (fname, good, msg);
END $$;
SQL

run_cases() {   # run_cases <url> <name>...   (prints one PASS/FAIL line per case)
  local url="$1"; shift
  local c
  for c in "$@"; do q "$url" "SELECT m.run('$c')" >/dev/null; done
  while IFS='|' read -r name okv detail; do
    [[ -z "$name" ]] && continue
    if [[ "$okv" == t ]]; then ok "matrix $name"; else bad "matrix $name: $detail"; fi
  done < <(q "$url" "SELECT name, ok, coalesce(detail, '') FROM m.results ORDER BY n; TRUNCATE m.results")
}

echo "== Readers matrix: load the oracle and the fixture (the triggers maintain the readers tables while it loads) =="
qf "$FIX_URL" < scripts/dev/access_matrix_oracle.sql >/dev/null || { bad "oracle load failed"; }
out=$(qf "$FIX_URL" < scripts/dev/access_matrix_fixture.sql) && ok "the fixture (32 universes, 11 users) loads through the recompute triggers" || bad "fixture load failed: $out"
echo "$HARNESS" | qf "$FIX_URL" >/dev/null || bad "harness load failed"
echo "$HARNESS" | qf "$RND_URL" >/dev/null || bad "harness load failed (random database)"
qf "$RND_URL" < scripts/dev/access_matrix_oracle.sql >/dev/null || bad "oracle load failed (random database)"

drift=$(q "$FIX_URL" "SELECT d1_private.readers_drift_count()")
[[ "$drift" == 0 ]] && ok "readers_drift() is empty after the fixture (the triggers kept every table right while it loaded)" || bad "readers_drift() after the fixture: $drift"

echo "== Function = oracle: 32 universes x every user, every type =="
equiv=$(cat <<'SQL'
SELECT 'sample ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.readers_of_sample(ARRAY(SELECT sample_id FROM physical_samples)))
  SELECT 1 FROM physical_samples s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.sample_id AND f.user_id = u.id
   WHERE ref.s_read(s.sample_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'operation ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.readers_of_operation(ARRAY(SELECT operation_id FROM manufacturing_operations)))
  SELECT 1 FROM manufacturing_operations s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.operation_id AND f.user_id = u.id
   WHERE ref.op_read_ordinary(s.operation_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'amnesty ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.operation_open_of(ARRAY(SELECT operation_id FROM manufacturing_operations)))
  SELECT 1 FROM manufacturing_operations s LEFT JOIN f ON f.record_id = s.operation_id
   WHERE ref.op_open(s.operation_id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'test ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.readers_of_test(ARRAY(SELECT session_id FROM test_sessions)))
  SELECT 1 FROM test_sessions s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.session_id AND f.user_id = u.id
   WHERE ref.test_read(s.session_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'campaign ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.readers_of_campaign(ARRAY(SELECT campaign_id FROM campaigns)))
  SELECT 1 FROM campaigns s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.campaign_id AND f.user_id = u.id
   WHERE ref.c_read(s.campaign_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'project ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.readers_of_project(ARRAY(SELECT project_id FROM projects)))
  SELECT 1 FROM projects s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.project_id AND f.user_id = u.id
   WHERE ref.pj_read(s.project_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'junction ' || count(*) FROM (
  WITH f AS (SELECT * FROM d1_private.readers_of_campaign_sample(ARRAY(SELECT id FROM campaign_samples)))
  SELECT 1 FROM campaign_samples s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.id AND f.user_id = u.id
   WHERE ref.cs_read(s.id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x
UNION ALL SELECT 'hidden ' || count(*) FROM (
  SELECT 'physical_samples' AS kind, sample_id AS id FROM physical_samples UNION ALL SELECT 'manufacturing_operations', operation_id FROM manufacturing_operations
  UNION ALL SELECT 'test_sessions', session_id FROM test_sessions UNION ALL SELECT 'campaigns', campaign_id FROM campaigns
  UNION ALL SELECT 'projects', project_id FROM projects) y
 WHERE ref.hidden(y.kind, y.id) IS DISTINCT FROM d1_private.is_hidden(y.kind, y.id)
SQL
)
res=$(q "$FIX_URL" "$equiv") || bad "equivalence query failed: $res"
for t in sample operation amnesty test campaign project junction hidden; do
  n=$(grep "^$t " <<<"$res" | cut -d' ' -f2)
  [[ "$n" == 0 ]] && ok "function = oracle: $t (every record x every user)" || bad "function differs from the oracle for $t: $n pair(s) (result: $res)"
done
# the fixture exercises what matters: restricted records, the shielding and the amnesty all produce readers and non-readers
n=$(q "$FIX_URL" "SELECT count(*) FROM operation_open_to_all") ; [[ "$n" -gt 0 ]] && ok "the fixture has operations in operation_open_to_all ($n)" || bad "operation_open_to_all is empty in the fixture"
# the three-way check: the production (set-based) functions equal the rule as candidates-then-predicate (the *_spec functions)
spec=$(q "$FIX_URL" "
SELECT 'sample ' || count(*) FROM (
  (SELECT * FROM d1_private.readers_of_sample(ARRAY(SELECT sample_id FROM physical_samples)) EXCEPT SELECT * FROM d1_private.readers_of_sample_spec(ARRAY(SELECT sample_id FROM physical_samples)))
  UNION ALL (SELECT * FROM d1_private.readers_of_sample_spec(ARRAY(SELECT sample_id FROM physical_samples)) EXCEPT SELECT * FROM d1_private.readers_of_sample(ARRAY(SELECT sample_id FROM physical_samples)))) x
UNION ALL SELECT 'operation ' || count(*) FROM (
  (SELECT * FROM d1_private.readers_of_operation(ARRAY(SELECT operation_id FROM manufacturing_operations)) EXCEPT SELECT * FROM d1_private.readers_of_operation_spec(ARRAY(SELECT operation_id FROM manufacturing_operations)))
  UNION ALL (SELECT * FROM d1_private.readers_of_operation_spec(ARRAY(SELECT operation_id FROM manufacturing_operations)) EXCEPT SELECT * FROM d1_private.readers_of_operation(ARRAY(SELECT operation_id FROM manufacturing_operations)))) x
UNION ALL SELECT 'test ' || count(*) FROM (
  (SELECT * FROM d1_private.readers_of_test(ARRAY(SELECT session_id FROM test_sessions)) EXCEPT SELECT * FROM d1_private.readers_of_test_spec(ARRAY(SELECT session_id FROM test_sessions)))
  UNION ALL (SELECT * FROM d1_private.readers_of_test_spec(ARRAY(SELECT session_id FROM test_sessions)) EXCEPT SELECT * FROM d1_private.readers_of_test(ARRAY(SELECT session_id FROM test_sessions)))) x
UNION ALL SELECT 'campaign ' || count(*) FROM (
  (SELECT * FROM d1_private.readers_of_campaign(ARRAY(SELECT campaign_id FROM campaigns)) EXCEPT SELECT * FROM d1_private.readers_of_campaign_spec(ARRAY(SELECT campaign_id FROM campaigns)))
  UNION ALL (SELECT * FROM d1_private.readers_of_campaign_spec(ARRAY(SELECT campaign_id FROM campaigns)) EXCEPT SELECT * FROM d1_private.readers_of_campaign(ARRAY(SELECT campaign_id FROM campaigns)))) x
UNION ALL SELECT 'project ' || count(*) FROM (
  (SELECT * FROM d1_private.readers_of_project(ARRAY(SELECT project_id FROM projects)) EXCEPT SELECT * FROM d1_private.readers_of_project_spec(ARRAY(SELECT project_id FROM projects)))
  UNION ALL (SELECT * FROM d1_private.readers_of_project_spec(ARRAY(SELECT project_id FROM projects)) EXCEPT SELECT * FROM d1_private.readers_of_project(ARRAY(SELECT project_id FROM projects)))) x
UNION ALL SELECT 'junction ' || count(*) FROM (
  (SELECT * FROM d1_private.readers_of_campaign_sample(ARRAY(SELECT id FROM campaign_samples)) EXCEPT SELECT * FROM d1_private.readers_of_campaign_sample_spec(ARRAY(SELECT id FROM campaign_samples)))
  UNION ALL (SELECT * FROM d1_private.readers_of_campaign_sample_spec(ARRAY(SELECT id FROM campaign_samples)) EXCEPT SELECT * FROM d1_private.readers_of_campaign_sample(ARRAY(SELECT id FROM campaign_samples)))) x") || true
for t in sample operation test campaign project junction; do
  n=$(grep "^$t " <<<"$spec" | cut -d' ' -f2)
  [[ "$n" == 0 ]] && ok "set-based readers_of_$t = the candidates-then-predicate specification (readers_of_${t}_spec)" || bad "readers_of_$t differs from its _spec: $n pair(s) ($spec)"
done
# a changed function is caught: the check can fail
orig=$(q "$FIX_URL" "SELECT pg_get_functiondef('d1_private.readers_of_sample(uuid[])'::regprocedure)")
q "$FIX_URL" "CREATE OR REPLACE FUNCTION d1_private.readers_of_sample(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE AS \$\$ SELECT l.sample_id, l.user_id FROM d1_private.v_s_list l WHERE l.sample_id = ANY (ids) \$\$" >/dev/null
n=$(q "$FIX_URL" "SELECT count(*) FROM (WITH f AS (SELECT * FROM d1_private.readers_of_sample(ARRAY(SELECT sample_id FROM physical_samples))) SELECT 1 FROM physical_samples s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.sample_id AND f.user_id = u.id WHERE ref.s_read(s.sample_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x")
[[ "$n" -gt 0 ]] && ok "the equivalence check fails when the inherited paths are removed from readers_of_sample ($n pair(s))" || bad "removing the inherited paths did not change the function: the check cannot fail"
echo "$orig" | qf "$FIX_URL" >/dev/null || bad "could not restore readers_of_sample"
q "$FIX_URL" "SELECT d1_private.readers_rebuild()" >/dev/null
[[ "$(q "$FIX_URL" "SELECT d1_private.readers_drift_count()")" == 0 ]] && ok "after restoring the function and readers_rebuild() the drift is empty" || bad "drift after restoring the function"

# ------------------------------------------------------------------------------------------------------------------------------
# The mutation matrix: one function per case
# ------------------------------------------------------------------------------------------------------------------------------
read -r -d '' CASES <<'SQL'
-- row 1: physical_samples INSERT
CREATE OR REPLACE FUNCTION m.c_row01_sample_insert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid;
BEGIN
    p := m.mk_project('r1p', 'a'); s := m.mk_sample('r1s', p, 'b');
    PERFORM m.drift('the sample insert');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('sample', s, m.u('a')) AND NOT m.rd('sample', s, m.u('c')), 'the owner and the project PI read the new sample, a stranger does not');
    PERFORM m.expect(m.rd('project', p, m.u('b')), 'the owner of a sample in the project reads the project');
    DELETE FROM physical_samples WHERE sample_id = s;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(NOT m.rd('project', p, m.u('b')), 'the project loses the owner when the sample is gone');
    PERFORM m.done();
END $$;

-- rows 2 to 4: physical_samples owner, project, restricted
CREATE OR REPLACE FUNCTION m.c_row02_sample_owner() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s uuid; o uuid; c uuid;
BEGIN
    s := m.mk_sample('r2s', NULL, 'a'); o := m.mk_op('r2o', s, NULL, NULL, 'b'); c := m.mk_campaign('r2c', NULL, 'd'); PERFORM m.mk_cs(c, s);
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('c')) AND NOT m.rd('operation', o, m.u('c')) AND NOT m.rd('campaign', c, m.u('c')), 'c reads nothing yet');
    UPDATE physical_samples SET owner_person_id = m.pe('c') WHERE sample_id = s;
    PERFORM m.drift('the new owner');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND m.rd('operation', o, m.u('c')) AND m.rd('campaign', c, m.u('c')), 'the new owner reads the sample, its operation and the campaign it is in');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('a')), 'the old owner no longer reads the sample');
    UPDATE physical_samples SET owner_person_id = m.pe('a') WHERE sample_id = s;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('sample', s, m.u('a')) AND NOT m.rd('operation', o, m.u('c')) AND NOT m.rd('campaign', c, m.u('c')), 'the reverse restores the readers');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row03_sample_project() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; s uuid; o uuid; t uuid;
BEGIN
    p1 := m.mk_project('r3p1', 'a'); p2 := m.mk_project('r3p2', 'c', true);
    s := m.mk_sample('r3s', p1, 'b'); o := m.mk_op('r3o', s, NULL, NULL, 'd'); t := m.mk_test('r3t', s, NULL, NULL, 'd');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.u('a')) AND m.rd('project', p1, m.u('b')) AND NOT m.rd('project', p2, m.u('b')), 'before: the PI a reads the sample, the owner reads p1');
    UPDATE physical_samples SET project_id = p2 WHERE sample_id = s;
    PERFORM m.drift('the move');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND NOT m.rd('sample', s, m.u('a')) AND NOT m.rd('operation', o, m.u('a')), 'the PI of the new project reads the sample, the old PI does not (nor its operation)');
    PERFORM m.expect(NOT m.rd('project', p1, m.u('b')) AND NOT m.rd('project', p2, m.u('b')), 'the old project loses the owner; the new project is restricted and does not list them');
    UPDATE physical_samples SET project_id = p1 WHERE sample_id = s;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('sample', s, m.u('a')) AND m.rd('project', p1, m.u('b')), 'the reverse restores the readers');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row04_sample_restricted() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid;
BEGIN
    p := m.mk_project('r4p', 'a'); s := m.mk_sample('r4s', p, 'b'); o := m.mk_op('r4o', s, NULL, NULL, 'c');
    INSERT INTO project_investigators (project_id, user_id) VALUES (p, m.u('d'));
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.u('d')) AND m.rd('operation', o, m.u('d')), 'before: an investigator of the project reads the sample and the operation under it');
    UPDATE physical_samples SET restricted = true WHERE sample_id = s;
    PERFORM m.drift('restricted on');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('d')) AND NOT m.rd('operation', o, m.u('d')) AND NOT m.rd('operation', o, m.u('c')) AND m.rd('sample', s, m.u('a')), 'restricted: the investigator and the operation owner lose it, the PI keeps it');
    PERFORM m.expect(m.hid('physical_samples', s) AND m.hid('manufacturing_operations', o), 'the sample and its operation are hidden from the Ask-DB role');
    UPDATE physical_samples SET restricted = false WHERE sample_id = s;
    PERFORM m.drift('restricted off');
    PERFORM m.expect(m.rd('sample', s, m.u('d')) AND m.rd('operation', o, m.u('c')) AND NOT m.hid('physical_samples', s), 'unrestricted again');
    PERFORM m.done();
END $$;

-- row 5: physical_samples DELETE (its operations cascade, a test through a secondary subject survives)
CREATE OR REPLACE FUNCTION m.c_row05_sample_delete() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; s2 uuid; o uuid;
BEGIN
    p := m.mk_project('r5p', 'a'); c := m.mk_campaign('r5c', NULL, 'd'); s := m.mk_sample('r5s', p, 'b'); s2 := m.mk_sample('r5s2', NULL, 'e');
    PERFORM m.mk_cs(c, s); o := m.mk_op('r5o', s, NULL, NULL, 'c');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('project', p, m.u('b')) AND m.rd('campaign', c, m.u('b')), 'before: the sample''s owner reads the project and the campaign');
    DELETE FROM physical_samples WHERE sample_id = s;
    PERFORM m.drift('the delete');
    PERFORM m.expect(NOT m.rd('project', p, m.u('b')) AND NOT m.rd('campaign', c, m.u('b')), 'the project and the campaign lose the deleted sample''s owner');
    PERFORM m.expect(NOT EXISTS (SELECT 1 FROM sample_readers WHERE record_id = s) AND NOT EXISTS (SELECT 1 FROM operation_readers WHERE record_id = o), 'its readers rows are gone (foreign key)');
    PERFORM m.done();
END $$;

-- rows 6 to 12: manufacturing_operations
CREATE OR REPLACE FUNCTION m.c_row06_operation_insert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid; n bigint;
BEGIN
    p := m.mk_project('r6p', 'a'); s := m.mk_sample('r6s', p, 'b');
    o := m.mk_op('r6o', s, p, NULL, 'c');
    PERFORM m.drift('one insert');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND m.rd('operation', o, m.u('a')) AND m.rd('operation', o, m.u('b')) AND NOT m.rd('operation', o, m.u('e')), 'owner, PI and the sample owner read it, a stranger does not');
    PERFORM m.expect(m.rd('project', p, m.u('c')), 'the operation owner reads the project');
    -- the importer's shape: a FAST run on nothing, in bulk (one statement), lands in operation_open_to_all
    INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number)
    SELECT m.id('r6bulk' || i), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'), 'fast_25', 'M6BULK' || i, 800000 + i FROM generate_series(1, 50) i;
    PERFORM m.drift('the bulk insert');
    SELECT count(*) INTO n FROM operation_open_to_all WHERE record_id IN (SELECT m.id('r6bulk' || i) FROM generate_series(1, 50) i);
    PERFORM m.expect(n = 50, 'the 50 ownerless FAST runs are open to all (got ' || n || ')');
    DELETE FROM manufacturing_operations WHERE pass_code LIKE 'M6BULK%';
    PERFORM m.drift('the reverse');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row07_operation_owner() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; o uuid;
BEGIN
    p := m.mk_project('r7p', 'a'); o := m.mk_op('r7o', NULL, p, NULL, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('operation', o, m.u('b')) AND m.rd('project', p, m.u('b')) AND NOT m.open(o), 'the owner reads the operation and the project');
    UPDATE manufacturing_operations SET owner_person_id = m.pe('c') WHERE operation_id = o;
    PERFORM m.drift('the new owner');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND NOT m.rd('operation', o, m.u('b')) AND NOT m.rd('project', p, m.u('b')) AND m.rd('project', p, m.u('c')), 'ownership moves the operation and the project readership');
    UPDATE manufacturing_operations SET owner_person_id = NULL, project_id = NULL WHERE operation_id = o;
    PERFORM m.drift('ownerless');
    PERFORM m.expect(m.open(o) AND NOT m.rd('operation', o, m.u('c')), 'an ownerless operation with no project is open to all (the amnesty)');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row08_operation_project() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; o uuid;
BEGIN
    p1 := m.mk_project('r8p1', 'a'); p2 := m.mk_project('r8p2', 'c'); o := m.mk_op('r8o', NULL, p1, NULL, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('operation', o, m.u('a')) AND NOT m.rd('operation', o, m.u('c')) AND m.rd('project', p1, m.u('b')), 'before');
    UPDATE manufacturing_operations SET project_id = p2 WHERE operation_id = o;
    PERFORM m.drift('the move');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND NOT m.rd('operation', o, m.u('a')) AND NOT m.rd('project', p1, m.u('b')) AND m.rd('project', p2, m.u('b')), 'the operation, and both projects'' readers, follow');
    UPDATE manufacturing_operations SET project_id = p1 WHERE operation_id = o;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('operation', o, m.u('a')) AND m.rd('project', p1, m.u('b')) AND NOT m.rd('project', p2, m.u('b')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row09_operation_campaign() RETURNS void LANGUAGE plpgsql AS $$
DECLARE c uuid; o uuid;
BEGIN
    c := m.mk_campaign('r9c', NULL, 'c'); o := m.mk_op('r9o', NULL, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('c')), 'before: the campaign owner does not read it');
    UPDATE manufacturing_operations SET campaign_id = c WHERE operation_id = o;
    PERFORM m.drift('the move');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND m.rd('operation', o, m.u('b')) AND NOT m.open(o), 'the campaign owner reads it; it is no longer ownerless-and-campaignless');
    UPDATE manufacturing_operations SET campaign_id = NULL WHERE operation_id = o;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('c')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row10_operation_sample() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid; o uuid;
BEGIN
    s1 := m.mk_sample('r10s1', NULL, 'a'); s2 := m.mk_sample('r10s2', NULL, 'c'); o := m.mk_op('r10o', s1, NULL, NULL, 'b');
    INSERT INTO sample_co_owners (sample_id, user_id) VALUES (s1, m.u('d'));
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('operation', o, m.u('a')) AND m.rd('operation', o, m.u('d')) AND NOT m.rd('operation', o, m.u('c')), 'before: through the sample');
    UPDATE manufacturing_operations SET sample_id = s2 WHERE operation_id = o;
    PERFORM m.drift('repointed');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND NOT m.rd('operation', o, m.u('a')) AND NOT m.rd('operation', o, m.u('d')), 'the readers of the new sample read it, the old ones no longer');
    UPDATE manufacturing_operations SET sample_id = s1 WHERE operation_id = o;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('operation', o, m.u('d')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row11_operation_restricted() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid;
BEGIN
    p := m.mk_project('r11p', 'a'); s := m.mk_sample('r11s', p, 'b'); o := m.mk_op('r11o', s, p, NULL, 'c');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('operation', o, m.u('b')), 'before: the sample owner reads the operation');
    UPDATE manufacturing_operations SET restricted = true WHERE operation_id = o;
    PERFORM m.drift('restricted on');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('b')) AND m.rd('operation', o, m.u('c')) AND m.rd('operation', o, m.u('a')) AND m.hid('manufacturing_operations', o), 'restricted: only the owner and the PI');
    UPDATE manufacturing_operations SET restricted = false WHERE operation_id = o;
    PERFORM m.drift('restricted off');
    PERFORM m.expect(m.rd('operation', o, m.u('b')) AND NOT m.hid('manufacturing_operations', o), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row12_operation_delete() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; o uuid;
BEGIN
    p := m.mk_project('r12p', 'a'); o := m.mk_op('r12o', NULL, p, NULL, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('project', p, m.u('b')), 'before: the operation owner reads the project');
    DELETE FROM manufacturing_operations WHERE operation_id = o;
    PERFORM m.drift('the delete');
    PERFORM m.expect(NOT m.rd('project', p, m.u('b')) AND NOT EXISTS (SELECT 1 FROM d1_private.hidden_records WHERE record_id = o), 'the project loses the owner; no hidden_records row is left');
    PERFORM m.done();
END $$;

-- rows 13 to 20: test_sessions and their subjects
CREATE OR REPLACE FUNCTION m.c_row13_test_insert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; t uuid;
BEGIN
    p := m.mk_project('r13p', 'a'); s := m.mk_sample('r13s', p, 'b'); t := m.mk_test('r13t', s, p, NULL, 'c');
    PERFORM m.drift('the insert');
    PERFORM m.expect(m.rd('test', t, m.u('c')) AND m.rd('test', t, m.u('a')) AND m.rd('test', t, m.u('b')) AND NOT m.rd('test', t, m.u('e')) AND m.rd('project', p, m.u('c')), 'readers of a new test');
    DELETE FROM test_sessions WHERE session_id = t;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(NOT m.rd('project', p, m.u('c')), 'the project loses the test owner');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row14_test_owner() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; t uuid;
BEGIN
    p := m.mk_project('r14p', 'a'); t := m.mk_test('r14t', NULL, p, NULL, 'b');
    PERFORM m.drift('setup');
    UPDATE test_sessions SET owner_person_id = m.pe('c') WHERE session_id = t;
    PERFORM m.drift('owner changed');
    PERFORM m.expect(m.rd('test', t, m.u('c')) AND NOT m.rd('test', t, m.u('b')) AND m.rd('project', p, m.u('c')) AND NOT m.rd('project', p, m.u('b')), 'the new owner reads it and the project');
    UPDATE test_sessions SET owner_person_id = m.pe('b') WHERE session_id = t;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('test', t, m.u('b')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row15_test_project() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; t uuid;
BEGIN
    p1 := m.mk_project('r15p1', 'a'); p2 := m.mk_project('r15p2', 'c'); t := m.mk_test('r15t', NULL, p1, NULL, 'b');
    PERFORM m.drift('setup');
    UPDATE test_sessions SET project_id = p2 WHERE session_id = t;
    PERFORM m.drift('moved');
    PERFORM m.expect(m.rd('test', t, m.u('c')) AND NOT m.rd('test', t, m.u('a')) AND NOT m.rd('project', p1, m.u('b')) AND m.rd('project', p2, m.u('b')), 'readers and both projects follow');
    UPDATE test_sessions SET project_id = p1 WHERE session_id = t;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('test', t, m.u('a')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row16_test_campaign() RETURNS void LANGUAGE plpgsql AS $$
DECLARE c uuid; t uuid;
BEGIN
    c := m.mk_campaign('r16c', NULL, 'c'); t := m.mk_test('r16t', NULL, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    UPDATE test_sessions SET campaign_id = c WHERE session_id = t;
    PERFORM m.drift('moved');
    PERFORM m.expect(m.rd('test', t, m.u('c')), 'the campaign owner reads the test');
    UPDATE test_sessions SET campaign_id = NULL WHERE session_id = t;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(NOT m.rd('test', t, m.u('c')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row17_test_sample_by_hand_and_derived() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid; t uuid; t2 uuid;
BEGIN
    s1 := m.mk_sample('r17s1', NULL, 'a'); s2 := m.mk_sample('r17s2', NULL, 'c'); t := m.mk_test('r17t', NULL, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    UPDATE test_sessions SET sample_id = s1 WHERE session_id = t;       -- by hand
    PERFORM m.drift('sample set by hand');
    PERFORM m.expect(m.rd('test', t, m.u('a')), 'the sample owner reads the test');
    -- derived: migration 139's sync trigger writes sample_id from test_sessions_subject (its own UPDATE fires ts_upd)
    t2 := m.mk_test('r17t2', NULL, NULL, NULL, 'b');
    INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES (t2, 'physical_samples', s2::text);
    PERFORM m.drift('the subject row (derived sample)');
    PERFORM m.expect((SELECT sample_id FROM test_sessions WHERE session_id = t2) = s2 AND m.rd('test', t2, m.u('c')), 'the derived sample is s2 and its owner reads the test');
    DELETE FROM test_sessions_subject WHERE test_sessions_id = t2;
    PERFORM m.drift('the subject row removed');
    PERFORM m.expect(NOT m.rd('test', t2, m.u('c')), 'no sample, no inherited reader');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row18_test_restricted() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; t uuid;
BEGIN
    p := m.mk_project('r18p', 'a'); s := m.mk_sample('r18s', p, 'b'); t := m.mk_test('r18t', s, p, NULL, 'c');
    PERFORM m.drift('setup');
    UPDATE test_sessions SET restricted = true WHERE session_id = t;
    PERFORM m.drift('on');
    PERFORM m.expect(NOT m.rd('test', t, m.u('b')) AND m.rd('test', t, m.u('c')) AND m.hid('test_sessions', t), 'restricted: owner and PI only');
    UPDATE test_sessions SET restricted = false WHERE session_id = t;
    PERFORM m.drift('off');
    PERFORM m.expect(m.rd('test', t, m.u('b')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row19_test_delete_and_secondary_subject() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s1 uuid; s2 uuid; t uuid;
BEGIN
    p := m.mk_project('r19p', 'a'); s1 := m.mk_sample('r19s1', p, 'b'); s2 := m.mk_sample('r19s2', NULL, 'd');
    t := m.mk_test('r19t', NULL, p, NULL, 'c');
    INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES (t, 'physical_samples', s1::text), (t, 'physical_samples', s2::text);
    PERFORM m.drift('two subjects');
    PERFORM m.expect(m.rd('project', p, m.u('c')), 'before: the test owner reads the project');
    -- deleting the secondary sample leaves the test (migration 139's BEFORE DELETE path); deleting the primary one deletes it only when it was its only subject
    DELETE FROM physical_samples WHERE sample_id = s2;
    PERFORM m.drift('the secondary sample deleted');
    PERFORM m.expect(EXISTS (SELECT 1 FROM test_sessions WHERE session_id = t), 'the test survives its secondary sample');
    DELETE FROM test_sessions WHERE session_id = t;
    PERFORM m.drift('the test deleted');
    PERFORM m.expect(NOT m.rd('project', p, m.u('c')), 'the project loses the test owner');
    PERFORM m.done();
END $$;

-- row 20: test_sessions_subject ins/upd/del (derived sample_id); bulk inserts
CREATE OR REPLACE FUNCTION m.c_row20_subject_rows_and_bulk() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid; i int;
BEGIN
    s1 := m.mk_sample('r20s1', NULL, 'a'); s2 := m.mk_sample('r20s2', NULL, 'c');
    FOR i IN 1..5 LOOP PERFORM m.mk_test('r20t' || i, NULL, NULL, NULL, 'b'); END LOOP;
    INSERT INTO test_sessions_subject (test_sessions_id, collection, item) SELECT m.id('r20t' || g), 'physical_samples', s1::text FROM generate_series(1, 5) g;
    PERFORM m.drift('bulk subject inserts');
    PERFORM m.expect((SELECT count(*) FROM test_readers WHERE record_id IN (SELECT m.id('r20t' || g) FROM generate_series(1, 5) g) AND user_id = m.u('a')) = 5, 'the sample owner reads all five tests');
    UPDATE test_sessions_subject SET item = s2::text WHERE test_sessions_id = m.id('r20t1');
    PERFORM m.drift('a subject repointed');
    PERFORM m.expect(m.rd('test', m.id('r20t1'), m.u('c')) AND NOT m.rd('test', m.id('r20t1'), m.u('a')), 'the repointed subject moves the test');
    PERFORM m.done();
END $$;

-- rows 21 to 25: campaigns
CREATE OR REPLACE FUNCTION m.c_row21_campaign_insert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid;
BEGIN
    p := m.mk_project('r21p', 'a'); c := m.mk_campaign('r21c', p, 'b');
    PERFORM m.drift('the insert');
    PERFORM m.expect(m.rd('campaign', c, m.u('b')) AND m.rd('campaign', c, m.u('a')) AND NOT m.rd('campaign', c, m.u('e')) AND m.rd('project', p, m.u('b')), 'owner and the project PI read it; the owner reads the project');
    DELETE FROM campaigns WHERE campaign_id = c;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(NOT m.rd('project', p, m.u('b')), 'the project loses the campaign owner');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row22_campaign_owner() RETURNS void LANGUAGE plpgsql AS $$
DECLARE c uuid; s uuid; o uuid; t uuid;
BEGIN
    c := m.mk_campaign('r22c', NULL, 'b'); s := m.mk_sample('r22s', NULL, 'a'); PERFORM m.mk_cs(c, s);
    o := m.mk_op('r22o', s, NULL, NULL, 'a'); t := m.mk_test('r22t', s, NULL, NULL, 'a');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('operation', o, m.u('b')) AND m.rd('test', t, m.u('b')), 'before: the campaign owner reads the sample and what is on it');
    UPDATE campaigns SET owner_person_id = m.pe('c') WHERE campaign_id = c;
    PERFORM m.drift('owner changed');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND m.rd('operation', o, m.u('c')) AND NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('operation', o, m.u('b')), 'the samples in it, and their operations and tests, follow');
    UPDATE campaigns SET owner_person_id = m.pe('b') WHERE campaign_id = c;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('test', t, m.u('b')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row23_campaign_project() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; c uuid; s uuid; o uuid;
BEGIN
    p1 := m.mk_project('r23p1', 'a'); p2 := m.mk_project('r23p2', 'c'); c := m.mk_campaign('r23c', p1, 'b');
    s := m.mk_sample('r23s', NULL, 'd'); PERFORM m.mk_cs(c, s); o := m.mk_op('r23o', s, NULL, NULL, 'd');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.u('a')) AND NOT m.rd('sample', s, m.u('c')), 'before: the PI of the campaign''s project reads the sample');
    UPDATE campaigns SET project_id = p2 WHERE campaign_id = c;
    PERFORM m.drift('moved');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND NOT m.rd('sample', s, m.u('a')) AND m.rd('operation', o, m.u('c')) AND NOT m.rd('project', p1, m.u('b')) AND m.rd('project', p2, m.u('b')), 'the new PI reads the sample and its operation, both projects follow');
    UPDATE campaigns SET project_id = p1 WHERE campaign_id = c;
    PERFORM m.drift('the reverse');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row24_campaign_restricted() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; o uuid; t uuid;
BEGIN
    p := m.mk_project('r24p', 'a'); c := m.mk_campaign('r24c', p, 'b'); s := m.mk_sample('r24s', NULL, 'd'); PERFORM m.mk_cs(c, s);
    o := m.mk_op('r24o', s, NULL, NULL, 'c'); t := m.mk_test('r24t', NULL, NULL, c, 'e');
    INSERT INTO project_investigators (project_id, user_id) VALUES (p, m.u('f'));
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('campaign', c, m.u('f')) AND m.rd('sample', s, m.u('f')) AND m.rd('test', t, m.u('f')), 'before: an investigator of the project reads the campaign, the sample and the test');
    UPDATE campaigns SET restricted = true WHERE campaign_id = c;
    PERFORM m.drift('on');
    PERFORM m.expect(NOT m.rd('campaign', c, m.u('f')) AND NOT m.rd('sample', s, m.u('f')) AND NOT m.rd('test', t, m.u('e')) AND m.rd('campaign', c, m.u('b')) AND m.rd('sample', s, m.u('d')), 'restricted: investigators lose it and the sample, the test owner loses the test, the sample owner keeps the sample');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('c')) AND m.rd('operation', o, m.u('d')), 'the operation of the shielded sample is hidden from its own owner c (ruling 19), not from the sample owner');
    UPDATE campaigns SET restricted = false WHERE campaign_id = c;
    PERFORM m.drift('off');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND m.rd('campaign', c, m.u('f')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row25_campaign_delete() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; o uuid; t uuid;
BEGIN
    p := m.mk_project('r25p', 'a'); c := m.mk_campaign('r25c', p, 'b', true); s := m.mk_sample('r25s', NULL, 'd'); PERFORM m.mk_cs(c, s);
    o := m.mk_op('r25o', s, NULL, NULL, 'c'); t := m.mk_test('r25t', NULL, NULL, c, 'e');
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('c')), 'before: shielded by the restricted campaign');
    DELETE FROM campaigns WHERE campaign_id = c;
    PERFORM m.drift('the delete (the operations'' and tests'' campaign_id is set null, the junction cascades)');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND (SELECT campaign_id FROM test_sessions WHERE session_id = t) IS NULL, 'the sample is no longer shielded');
    PERFORM m.done();
END $$;

-- rows 26 to 29: projects
CREATE OR REPLACE FUNCTION m.c_row26_project_insert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
    p := m.mk_project('r26p', 'a', true);
    INSERT INTO project_access (project_id, person_id, role) VALUES (p, m.pe('b'), 'view');
    PERFORM m.drift('the insert and an access entry');
    PERFORM m.expect(m.rd('project', p, m.u('a')) AND m.rd('project', p, m.u('b')) AND NOT m.rd('project', p, m.u('c')) AND m.hid('projects', p), 'PI and listed read the restricted project; it is hidden from the Ask-DB role');
    DELETE FROM projects WHERE project_id = p;
    PERFORM m.drift('the delete');
    PERFORM m.expect(NOT m.hid('projects', p), 'the delete drops the hidden_records row');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row27_project_pi() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; c uuid; s uuid; o uuid; t uuid;
BEGIN
    p1 := m.mk_project('r27p1', 'a'); p2 := m.mk_project('r27p2', 'f');
    c := m.mk_campaign('r27c', p1, 'b'); s := m.mk_sample('r27s', p2, 'd'); PERFORM m.mk_cs(c, s);       -- a sample of ANOTHER project in this project's campaign
    o := m.mk_op('r27o', s, NULL, NULL, 'd'); t := m.mk_test('r27t', s, NULL, NULL, 'd');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.u('a')) AND m.rd('operation', o, m.u('a')) AND NOT m.rd('sample', s, m.u('c')), 'before: the PI of the campaign''s project reads the other project''s sample');
    UPDATE projects SET principal_investigator_person = m.pe('c') WHERE project_id = p1;
    PERFORM m.drift('PI changed');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND m.rd('operation', o, m.u('c')) AND m.rd('test', t, m.u('c')) AND m.rd('campaign', c, m.u('c')) AND NOT m.rd('sample', s, m.u('a')) AND NOT m.rd('campaign', c, m.u('a')), 'the new PI reads the campaign and, through it, the other project''s sample and what is on it');
    UPDATE projects SET principal_investigator_person = NULL WHERE project_id = p1;
    PERFORM m.drift('PI removed');
    UPDATE projects SET principal_investigator_person = m.pe('a') WHERE project_id = p1;
    PERFORM m.drift('the reverse');
    PERFORM m.expect(m.rd('sample', s, m.u('a')), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row28_project_restricted() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; o uuid; t uuid; s2 uuid;
BEGIN
    p := m.mk_project('r28p', 'a'); c := m.mk_campaign('r28c', p, 'b'); s := m.mk_sample('r28s', p, 'd'); s2 := m.mk_sample('r28s2', NULL, 'e'); PERFORM m.mk_cs(c, s2);
    o := m.mk_op('r28o', s, p, c, 'd'); t := m.mk_test('r28t', s, p, NULL, 'e');
    INSERT INTO project_investigators (project_id, user_id) VALUES (p, m.u('f'));
    PERFORM m.drift('setup');
    UPDATE projects SET restricted = true WHERE project_id = p;
    PERFORM m.drift('on (the cascade)');
    PERFORM m.expect(NOT m.rd('campaign', c, m.u('b')) AND m.rd('campaign', c, m.u('f')) AND m.rd('campaign', c, m.u('a')), 'the campaign is hidden from its owner (not on the project list), not from the PI and the investigators (listed on it)');
    PERFORM m.expect(m.rd('sample', s, m.u('d')) AND NOT m.rd('operation', o, m.u('d')) AND NOT m.rd('test', t, m.u('e')) AND m.rd('operation', o, m.u('a')), 'the sample owner keeps the sample, not the operation or the test under a restricted project');
    PERFORM m.expect(m.rd('sample', s2, m.u('e')) AND NOT m.rd('sample', s2, m.u('b')), 'a sample in the restricted project''s campaign: its owner keeps it, the campaign owner loses it');
    PERFORM m.expect(m.hid('campaigns', c) AND m.hid('manufacturing_operations', o) AND m.hid('physical_samples', s2) AND m.hid('test_sessions', t), 'everything under it is hidden from the Ask-DB role');
    UPDATE projects SET restricted = false WHERE project_id = p;
    PERFORM m.drift('off');
    PERFORM m.expect(m.rd('operation', o, m.u('d')) AND m.rd('campaign', c, m.u('b')) AND NOT m.hid('campaigns', c), 'restored');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row29_project_delete() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; refused boolean := false;
BEGIN
    p := m.mk_project('r29p', 'a'); c := m.mk_campaign('r29c', p, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('campaign', c, m.u('a')), 'before: the PI reads the campaign');
    DELETE FROM projects WHERE project_id = p;       -- a project with only campaigns: campaigns.project_id is SET NULL (fires row 23)
    PERFORM m.drift('the project deleted, its campaign detached');
    PERFORM m.expect(NOT m.rd('campaign', c, m.u('a')) AND m.rd('campaign', c, m.u('b')), 'the campaign is no longer the PI''s');
    p := m.mk_project('r29p2', 'a'); s := m.mk_sample('r29s', p, 'b');
    BEGIN DELETE FROM projects WHERE project_id = p; EXCEPTION WHEN foreign_key_violation THEN refused := true; END;
    PERFORM m.expect(refused, 'a project that samples still reference is refused');
    PERFORM m.drift('after the refused delete');
    PERFORM m.done();
END $$;

-- rows 30 to 33: project_investigators, project_access
CREATE OR REPLACE FUNCTION m.c_row30_31_project_investigators() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; s uuid; o uuid; r uuid;
BEGIN
    p1 := m.mk_project('r30p1', 'a'); p2 := m.mk_project('r30p2', 'a'); s := m.mk_sample('r30s', p1, 'b'); o := m.mk_op('r30o', s, NULL, NULL, 'c');
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('d')), 'before');
    INSERT INTO project_investigators (project_id, user_id) VALUES (p1, m.u('d')) RETURNING id INTO r;
    PERFORM m.drift('investigator added');
    PERFORM m.expect(m.rd('sample', s, m.u('d')) AND m.rd('operation', o, m.u('d')) AND m.rd('project', p1, m.u('d')), 'the investigator reads the project''s sample and operation');
    UPDATE project_investigators SET project_id = p2 WHERE id = r;      -- row 31: repoint
    PERFORM m.drift('repointed to another project');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('d')) AND m.rd('project', p2, m.u('d')), 'repointed: the old project''s records are lost');
    UPDATE project_investigators SET project_id = p1, user_id = m.u('e') WHERE id = r;
    PERFORM m.drift('another login');
    PERFORM m.expect(m.rd('sample', s, m.u('e')) AND NOT m.rd('project', p2, m.u('d')), 'the login changed');
    DELETE FROM project_investigators WHERE id = r;
    PERFORM m.drift('removed');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('e')), 'removed');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row32_33_project_access() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; r uuid;
BEGIN
    p := m.mk_project('r32p', 'a'); s := m.mk_sample('r32s', p, 'b');
    INSERT INTO project_access (project_id, person_id, role) VALUES (p, m.pe('c'), 'view') RETURNING access_id INTO r;
    PERFORM m.drift('view entry');
    PERFORM m.expect(m.rd('project', p, m.u('c')) AND NOT m.rd('sample', s, m.u('c')), 'Can view reads the project, not what is in it');
    UPDATE project_access SET role = 'investigator' WHERE access_id = r;      -- row 33: the role is read (investigator vs view)
    PERFORM m.drift('now an investigator');
    PERFORM m.expect(m.rd('sample', s, m.u('c')), 'a Secondary investigator reads the project''s samples');
    UPDATE project_access SET person_id = m.pe('d') WHERE access_id = r;
    PERFORM m.drift('another person');
    PERFORM m.expect(m.rd('sample', s, m.u('d')) AND NOT m.rd('sample', s, m.u('c')), 'the person changed');
    INSERT INTO project_access (project_id, person_id, role) VALUES (p, m.pe('z'), 'investigator');        -- no login: no reader
    PERFORM m.drift('a person with no login');
    UPDATE project_access SET project_id = m.mk_project('r32p2', 'a') WHERE access_id = r;
    PERFORM m.drift('another project');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('d')), 'the entry left the project');
    DELETE FROM project_access WHERE project_id = p;
    PERFORM m.drift('removed');
    PERFORM m.done();
END $$;

-- row 34: campaign_samples
CREATE OR REPLACE FUNCTION m.c_row34_campaign_samples() RETURNS void LANGUAGE plpgsql AS $$
DECLARE c1 uuid; c2 uuid; s uuid; o uuid; j uuid;
BEGIN
    c1 := m.mk_campaign('r34c1', NULL, 'b'); c2 := m.mk_campaign('r34c2', NULL, 'c', true);
    s := m.mk_sample('r34s', NULL, 'a'); o := m.mk_op('r34o', s, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    j := m.mk_cs(c1, s);
    PERFORM m.drift('inserted');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('operation', o, m.u('b')) AND m.rd('campaign', c1, m.u('a')) AND m.rd('junction', j, m.u('b')) AND m.rd('junction', j, m.u('a')), 'the campaign owner reads the sample; its operation is read by its owner; the sample owner reads the campaign and the junction row');
    UPDATE campaign_samples SET campaign_id = c2 WHERE id = j;
    PERFORM m.drift('repointed to a restricted campaign');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND m.rd('sample', s, m.u('c')) AND NOT m.rd('campaign', c1, m.u('a')) AND NOT m.rd('campaign', c2, m.u('a')), 'the sample leaves the first campaign and joins the restricted one (its owner, not listed on it, does not read it)');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('b')) AND m.rd('operation', o, m.u('a')), 'the operation is shielded from its owner b by the restricted campaign (ruling 19), not from the sample owner a');
    UPDATE campaign_samples SET sample_id = m.mk_sample('r34s2', NULL, 'd') WHERE id = j;
    PERFORM m.drift('another sample');
    PERFORM m.expect(m.rd('operation', o, m.u('b')), 'the operation is open again once its sample leaves the restricted campaign');
    DELETE FROM campaign_samples WHERE id = j;
    PERFORM m.drift('removed');
    PERFORM m.done();
END $$;

-- rows 35 to 38: co-owners and sample_access
CREATE OR REPLACE FUNCTION m.c_row35_36_co_owners() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid; c uuid; p uuid; o uuid; r uuid;
BEGIN
    p := m.mk_project('r35p', 'a'); c := m.mk_campaign('r35c', p, 'f'); s1 := m.mk_sample('r35s1', p, 'b'); s2 := m.mk_sample('r35s2', NULL, 'b'); PERFORM m.mk_cs(c, s1);
    o := m.mk_op('r35o', s1, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    INSERT INTO sample_co_owners (sample_id, user_id) VALUES (s1, m.u('d')) RETURNING id INTO r;
    PERFORM m.drift('co-owner added');
    PERFORM m.expect(m.rd('sample', s1, m.u('d')) AND m.rd('operation', o, m.u('d')) AND m.rd('campaign', c, m.u('d')) AND m.rd('project', p, m.u('d')), 'the co-owner reads the sample, its operation, the campaign it is in and the project');
    UPDATE sample_co_owners SET sample_id = s2 WHERE id = r;      -- row 36
    PERFORM m.drift('repointed');
    PERFORM m.expect(NOT m.rd('sample', s1, m.u('d')) AND m.rd('sample', s2, m.u('d')) AND NOT m.rd('campaign', c, m.u('d')) AND NOT m.rd('project', p, m.u('d')), 'repointed: the first sample''s campaign and project lose the co-owner');
    UPDATE sample_co_owners SET user_id = m.u('e') WHERE id = r;
    PERFORM m.drift('another login');
    PERFORM m.expect(m.rd('sample', s2, m.u('e')) AND NOT m.rd('sample', s2, m.u('d')), 'the login changed');
    DELETE FROM sample_co_owners WHERE id = r;
    PERFORM m.drift('removed');
    PERFORM m.expect(NOT m.rd('sample', s2, m.u('e')), 'removed');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row37_38_sample_access() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid; c uuid; p uuid; r uuid;
BEGIN
    p := m.mk_project('r37p', 'a'); c := m.mk_campaign('r37c', p, 'f'); s1 := m.mk_sample('r37s1', p, 'b'); s2 := m.mk_sample('r37s2', NULL, 'b'); PERFORM m.mk_cs(c, s1);
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s1, m.pe('d'), 'view') RETURNING access_id INTO r;
    PERFORM m.drift('view entry');
    PERFORM m.expect(m.rd('sample', s1, m.u('d')) AND NOT m.rd('campaign', c, m.u('d')) AND NOT m.rd('project', p, m.u('d')), 'Can view reads the sample, the campaign and project do not follow');
    UPDATE sample_access SET role = 'edit' WHERE access_id = r;      -- row 38: the role feeds campaign and project readers
    PERFORM m.drift('now Can edit');
    PERFORM m.expect(m.rd('campaign', c, m.u('d')) AND m.rd('project', p, m.u('d')), 'a Can edit person is an editor of the sample: they read its campaign and its project');
    UPDATE sample_access SET person_id = m.pe('e') WHERE access_id = r;
    PERFORM m.drift('another person');
    PERFORM m.expect(m.rd('campaign', c, m.u('e')) AND NOT m.rd('campaign', c, m.u('d')), 'the person changed');
    UPDATE sample_access SET sample_id = s2 WHERE access_id = r;
    PERFORM m.drift('another sample');
    PERFORM m.expect(NOT m.rd('campaign', c, m.u('e')) AND m.rd('sample', s2, m.u('e')), 'the entry left the sample');
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s2, m.pe('z'), 'edit');
    PERFORM m.drift('a person with no login');
    DELETE FROM sample_access WHERE sample_id IN (s1, s2);
    PERFORM m.drift('removed');
    PERFORM m.done();
END $$;

-- rows 39 to 44: operation_access, test_access, campaign_access
CREATE OR REPLACE FUNCTION m.c_row39_40_operation_access() RETURNS void LANGUAGE plpgsql AS $$
DECLARE o1 uuid; o2 uuid; p uuid; r uuid;
BEGIN
    p := m.mk_project('r39p', 'a'); o1 := m.mk_op('r39o1', NULL, p, NULL, 'b', true); o2 := m.mk_op('r39o2', NULL, p, NULL, 'b', true);
    INSERT INTO operation_access (operation_id, person_id, role) VALUES (o1, m.pe('d'), 'view') RETURNING access_id INTO r;
    PERFORM m.drift('entry added');
    PERFORM m.expect(m.rd('operation', o1, m.u('d')) AND NOT m.rd('operation', o2, m.u('d')) AND m.rd('project', p, m.u('d')) = false, 'the listed person reads the restricted operation and nothing else');
    UPDATE operation_access SET person_id = m.pe('e') WHERE access_id = r;      -- row 40
    PERFORM m.drift('another person');
    PERFORM m.expect(m.rd('operation', o1, m.u('e')) AND NOT m.rd('operation', o1, m.u('d')), 'the person changed');
    UPDATE operation_access SET operation_id = o2 WHERE access_id = r;
    PERFORM m.drift('another operation');
    PERFORM m.expect(m.rd('operation', o2, m.u('e')) AND NOT m.rd('operation', o1, m.u('e')), 'the entry moved');
    UPDATE operation_access SET role = 'edit' WHERE access_id = r;               -- the role is not read: no effect
    PERFORM m.drift('the role');
    DELETE FROM operation_access WHERE access_id = r;
    PERFORM m.drift('removed');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row41_42_test_access() RETURNS void LANGUAGE plpgsql AS $$
DECLARE t1 uuid; t2 uuid; r uuid;
BEGIN
    t1 := m.mk_test('r41t1', NULL, NULL, NULL, 'b', true); t2 := m.mk_test('r41t2', NULL, NULL, NULL, 'b', true);
    INSERT INTO test_access (session_id, person_id, role) VALUES (t1, m.pe('d'), 'view') RETURNING access_id INTO r;
    PERFORM m.drift('entry added');
    PERFORM m.expect(m.rd('test', t1, m.u('d')) AND NOT m.rd('test', t2, m.u('d')), 'the listed person reads the restricted test');
    UPDATE test_access SET person_id = m.pe('e') WHERE access_id = r;
    PERFORM m.drift('another person');
    UPDATE test_access SET session_id = t2 WHERE access_id = r;
    PERFORM m.drift('another test');
    PERFORM m.expect(m.rd('test', t2, m.u('e')) AND NOT m.rd('test', t1, m.u('e')), 'the entry moved');
    DELETE FROM test_access WHERE access_id = r;
    PERFORM m.drift('removed');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row43_44_campaign_access() RETURNS void LANGUAGE plpgsql AS $$
DECLARE c1 uuid; c2 uuid; s uuid; o uuid; r uuid;
BEGIN
    c1 := m.mk_campaign('r43c1', NULL, 'f', true); c2 := m.mk_campaign('r43c2', NULL, 'f', true); s := m.mk_sample('r43s', NULL, 'a'); PERFORM m.mk_cs(c1, s);
    o := m.mk_op('r43o', s, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('b')), 'before: the sample is shielded by the restricted campaign, so the operation is hidden from its owner b');
    INSERT INTO campaign_access (campaign_id, person_id, role) VALUES (c1, m.pe('b'), 'view') RETURNING access_id INTO r;
    PERFORM m.drift('the operation owner is listed on the campaign');
    PERFORM m.expect(m.rd('campaign', c1, m.u('b')) AND m.rd('operation', o, m.u('b')), 'listed on the campaign: it lets them in, the shield is gone');
    UPDATE campaign_access SET campaign_id = c2 WHERE access_id = r;      -- row 44
    PERFORM m.drift('listed on another campaign');
    PERFORM m.expect(NOT m.rd('operation', o, m.u('b')) AND m.rd('campaign', c2, m.u('b')), 'the shield is back');
    UPDATE campaign_access SET person_id = m.pe('d') WHERE access_id = r;
    PERFORM m.drift('another person');
    DELETE FROM campaign_access WHERE access_id = r;
    PERFORM m.drift('removed');
    PERFORM m.done();
END $$;

-- row 45: people.user_id linked, unlinked, changed
CREATE OR REPLACE FUNCTION m.c_row45_people_login() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; o uuid; x uuid := m.id('r45user');
BEGIN
    INSERT INTO directus_users (id, email, status, first_name, last_name) VALUES (x, 'r45@example.invalid', 'active', 'R', '45');
    p := m.mk_project('r45p', 'z'); c := m.mk_campaign('r45c', p, 'z'); s := m.mk_sample('r45s', p, 'z'); o := m.mk_op('r45o', s, p, c, 'z');
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, m.pe('z'), 'edit');
    PERFORM m.drift('a person with no login owns everything');
    PERFORM m.expect(NOT m.rd('project', p, x) AND NOT m.rd('operation', o, x), 'before: no login, no reader');
    UPDATE people SET user_id = x WHERE person_id = m.pe('z');
    PERFORM m.drift('login linked');
    PERFORM m.expect(m.rd('project', p, x) AND m.rd('campaign', c, x) AND m.rd('sample', s, x) AND m.rd('operation', o, x), 'linking the login makes the PI, owner and listed person a reader of everything');
    UPDATE people SET user_id = m.u('e') WHERE person_id = m.pe('z') AND false;
    UPDATE people SET user_id = NULL WHERE person_id = m.pe('z');
    PERFORM m.drift('login unlinked');
    PERFORM m.expect(NOT m.rd('project', p, x) AND NOT m.rd('operation', o, x), 'unlinked');
    UPDATE people SET user_id = x WHERE person_id = m.pe('z');
    UPDATE people SET user_id = NULL WHERE person_id = m.pe('f');
    UPDATE people SET user_id = m.u('f') WHERE person_id = m.pe('z');          -- changed to a login that was just freed
    PERFORM m.drift('login changed');
    PERFORM m.expect(m.rd('project', p, m.u('f')) AND NOT m.rd('project', p, x), 'changed');
    PERFORM m.done();
END $$;

-- rows 46 to 48: deletes of a person and of a login
CREATE OR REPLACE FUNCTION m.c_row46_person_delete() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid; x uuid := m.id('r46person');
BEGIN
    INSERT INTO directus_users (id, email, status, first_name, last_name) VALUES (m.id('r46user'), 'r46@example.invalid', 'active', 'R', '46');
    INSERT INTO people (person_id, full_name, user_id, is_researcher, active) VALUES (x, 'R 46', m.id('r46user'), true, true);
    p := m.mk_project('r46p', 'a'); s := m.mk_sample('r46s', p, NULL); o := m.mk_op('r46o', s, p, NULL, NULL);
    UPDATE physical_samples SET owner_person_id = x WHERE sample_id = s; UPDATE manufacturing_operations SET owner_person_id = x WHERE operation_id = o;
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, x, 'edit');
    INSERT INTO sample_co_owners (sample_id, user_id, person_id) VALUES (s, m.u('d'), m.pe('d'));
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.id('r46user')) AND m.rd('operation', o, m.id('r46user')) AND m.rd('project', p, m.id('r46user')), 'before');
    DELETE FROM people WHERE person_id = x;                 -- owners set null, access rows cascade
    PERFORM m.drift('the owner person deleted');
    PERFORM m.expect(NOT m.rd('sample', s, m.id('r46user')) AND NOT m.rd('project', p, m.id('r46user')) AND m.rd('sample', s, m.u('d')), 'the owner and the access entry are gone, the co-owner stays');
    DELETE FROM people WHERE person_id = m.pe('d');           -- the co-owner's person: legacy rows cascade by person_id
    PERFORM m.drift('the co-owner person deleted');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('d')), 'the legacy co-owner row went with the person');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row47_person_insert() RETURNS void LANGUAGE plpgsql AS $$
DECLARE n0 bigint; n1 bigint;
BEGIN
    SELECT (SELECT count(*) FROM sample_readers) + (SELECT count(*) FROM project_readers) INTO n0;
    INSERT INTO people (person_id, full_name, is_researcher, active) VALUES (m.id('r47person'), 'R 47', true, true);
    PERFORM m.drift('a person inserted');
    SELECT (SELECT count(*) FROM sample_readers) + (SELECT count(*) FROM project_readers) INTO n1;
    PERFORM m.expect(n0 = n1, 'nothing references a person that does not exist yet: no readers change');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row48_login_delete_with_legacy_rows() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid; x uuid := m.id('r48user'); xp uuid := m.id('r48person');
BEGIN
    INSERT INTO directus_users (id, email, status, first_name, last_name) VALUES (x, 'r48@example.invalid', 'active', 'R', '48');
    INSERT INTO people (person_id, full_name, user_id, is_researcher, active) VALUES (xp, 'R 48', x, true, true);
    p := m.mk_project('r48p', 'a'); s := m.mk_sample('r48s', p, 'b'); o := m.mk_op('r48o', s, NULL, NULL, NULL);
    UPDATE manufacturing_operations SET owner_person_id = xp WHERE operation_id = o;
    INSERT INTO sample_co_owners (sample_id, user_id) VALUES (s, x);               -- a legacy row of the login
    INSERT INTO project_investigators (project_id, user_id) VALUES (p, x);
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, x) AND m.rd('operation', o, x) AND m.rd('project', p, x), 'before');
    DELETE FROM directus_users WHERE id = x;        -- legacy rows cascade (the foreign keys of 166), people.user_id is set null, readers rows cascade
    PERFORM m.drift('the login deleted');
    PERFORM m.expect(NOT EXISTS (SELECT 1 FROM sample_co_owners WHERE user_id = x) AND NOT EXISTS (SELECT 1 FROM project_investigators WHERE user_id = x), 'the legacy rows went with the login');
    UPDATE physical_samples SET notes = 'edited after the login was deleted' WHERE sample_id = s;
    UPDATE physical_samples SET restricted = true WHERE sample_id = s;
    PERFORM m.drift('the sample edited and restricted afterwards (no dangling login can be emitted as a reader)');
    PERFORM m.done();
END $$;

-- row 49 (the TRUNCATE triggers) is in the shell part; row 50: a trigger that does not fire is DETECTED and repaired
CREATE OR REPLACE FUNCTION m.c_row50_disabled_trigger_is_detected_and_repaired() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s uuid; n bigint;
BEGIN
    s := m.mk_sample('r50s', NULL, 'a');
    PERFORM m.drift('setup');
    ALTER TABLE physical_samples DISABLE TRIGGER physical_samples_readers_upd;
    UPDATE physical_samples SET owner_person_id = m.pe('c') WHERE sample_id = s;
    SELECT count(*) INTO n FROM d1_private.readers_drift();
    PERFORM m.expect(n > 0, 'with the trigger disabled readers_drift() reports the difference (' || n || ' rows)');
    PERFORM m.expect(EXISTS (SELECT 1 FROM d1_private.readers_drift() WHERE kind = 'sample_readers' AND record_id = s AND user_id = m.u('c') AND problem = 'missing')
                     AND EXISTS (SELECT 1 FROM d1_private.readers_drift() WHERE kind = 'sample_readers' AND record_id = s AND user_id = m.u('a') AND problem = 'extra'), 'it names the missing and the extra row');
    PERFORM d1_private.readers_rebuild();
    PERFORM m.drift('after readers_rebuild()');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND NOT m.rd('sample', s, m.u('a')), 'readers_rebuild() repairs it');
    ALTER TABLE physical_samples ENABLE TRIGGER physical_samples_readers_upd;
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_row51_genealogy_shape_is_not_built() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM m.expect(to_regclass('public.sample_genealogy_readers') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'sample_genealogy%readers%'),
                     'the genealogy shape is not built: sample_genealogy reads through the two-hop rule on sample_readers, nothing to maintain');
    PERFORM m.done();
END $$;

-- mutation classes of spec section 10 that are not a row of their own
CREATE OR REPLACE FUNCTION m.c_mc_restrict_and_unrestrict_in_one_transaction() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid;
BEGIN
    p := m.mk_project('mc1p', 'a'); s := m.mk_sample('mc1s', p, 'b'); o := m.mk_op('mc1o', s, NULL, NULL, 'c');
    UPDATE physical_samples SET restricted = true WHERE sample_id = s;
    UPDATE physical_samples SET restricted = false WHERE sample_id = s;
    PERFORM m.drift('restrict then unrestrict');
    PERFORM m.expect(m.rd('operation', o, m.u('b')) AND m.rd('operation', o, m.u('c')), 'nothing changed');
    UPDATE projects SET restricted = true WHERE project_id = p; UPDATE projects SET restricted = false WHERE project_id = p;
    PERFORM m.drift('the same on the project');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_mc_rollback_to_savepoint_after_a_mutation() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid;
BEGIN
    p := m.mk_project('mc2p', 'a'); s := m.mk_sample('mc2s', p, 'b'); o := m.mk_op('mc2o', s, NULL, NULL, 'c');
    PERFORM m.drift('setup');
    BEGIN
        UPDATE physical_samples SET restricted = true, owner_person_id = m.pe('e') WHERE sample_id = s;
        PERFORM m.expect(NOT m.rd('operation', o, m.u('c')), 'inside the savepoint the change is visible');
        RAISE EXCEPTION 'undo';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    PERFORM m.drift('after the rollback to the savepoint');
    PERFORM m.expect(m.rd('operation', o, m.u('c')) AND m.rd('sample', s, m.u('b')) AND NOT m.rd('sample', s, m.u('e')), 'the readers are as before the savepoint');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_mc_a_tracked_column_set_to_its_current_value_writes_nothing() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid; seq0 bigint[]; seq1 bigint[]; n0 bigint; n1 bigint;
BEGIN
    p := m.mk_project('mc3p', 'a'); s := m.mk_sample('mc3s', p, 'b'); o := m.mk_op('mc3o', s, p, NULL, 'c');
    PERFORM m.drift('setup');
    seq0 := ARRAY[coalesce(pg_sequence_last_value('sample_readers_reader_id_seq'), 0), coalesce(pg_sequence_last_value('operation_readers_reader_id_seq'), 0),
                  coalesce(pg_sequence_last_value('project_readers_reader_id_seq'), 0), coalesce(pg_sequence_last_value('campaign_sample_readers_reader_id_seq'), 0)];
    SELECT (SELECT count(*) FROM sample_readers) + (SELECT count(*) FROM operation_readers) + (SELECT count(*) FROM project_readers) INTO n0;
    UPDATE physical_samples SET owner_person_id = owner_person_id, project_id = project_id, restricted = restricted WHERE sample_id = s;
    UPDATE manufacturing_operations SET owner_person_id = owner_person_id, project_id = project_id, restricted = restricted WHERE operation_id = o;
    UPDATE projects SET restricted = restricted, principal_investigator_person = principal_investigator_person WHERE project_id = p;
    UPDATE physical_samples SET notes = 'no tracked column' WHERE sample_id = s;
    seq1 := ARRAY[coalesce(pg_sequence_last_value('sample_readers_reader_id_seq'), 0), coalesce(pg_sequence_last_value('operation_readers_reader_id_seq'), 0),
                  coalesce(pg_sequence_last_value('project_readers_reader_id_seq'), 0), coalesce(pg_sequence_last_value('campaign_sample_readers_reader_id_seq'), 0)];
    SELECT (SELECT count(*) FROM sample_readers) + (SELECT count(*) FROM operation_readers) + (SELECT count(*) FROM project_readers) INTO n1;
    PERFORM m.expect(seq0 = seq1 AND n0 = n1, 'no readers row was inserted or deleted (identity sequences and counts are unchanged)');
    PERFORM m.drift('after the no-op updates');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_mc_swap_two_operations_samples_in_one_statement() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid; o1 uuid; o2 uuid;
BEGIN
    s1 := m.mk_sample('mc4s1', NULL, 'a'); s2 := m.mk_sample('mc4s2', NULL, 'c');
    o1 := m.mk_op('mc4o1', s1, NULL, NULL, 'b'); o2 := m.mk_op('mc4o2', s2, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('operation', o1, m.u('a')) AND m.rd('operation', o2, m.u('c')), 'before');
    UPDATE manufacturing_operations SET sample_id = CASE operation_id WHEN o1 THEN s2 ELSE s1 END WHERE operation_id IN (o1, o2);
    PERFORM m.drift('swapped');
    PERFORM m.expect(m.rd('operation', o1, m.u('c')) AND m.rd('operation', o2, m.u('a')) AND NOT m.rd('operation', o1, m.u('a')) AND NOT m.rd('operation', o2, m.u('c')), 'each operation follows its new sample');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_mc_swap_two_persons_logins_in_one_transaction() RETURNS void LANGUAGE plpgsql AS $$
DECLARE s1 uuid; s2 uuid;
BEGIN
    s1 := m.mk_sample('mc5s1', NULL, 'e'); s2 := m.mk_sample('mc5s2', NULL, 'f');
    PERFORM m.drift('setup');
    UPDATE people SET user_id = NULL WHERE person_id = m.pe('e');
    UPDATE people SET user_id = m.u('e') WHERE person_id = m.pe('f');
    UPDATE people SET user_id = m.u('f') WHERE person_id = m.pe('e');
    PERFORM m.drift('swapped');
    PERFORM m.expect(m.rd('sample', s1, m.u('f')) AND m.rd('sample', s2, m.u('e')) AND NOT m.rd('sample', s1, m.u('e')), 'the samples follow the persons, so the readers swapped logins');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_mc_old_and_new_parent_both_restricted() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; s uuid; o uuid;
BEGIN
    p1 := m.mk_project('mc6p1', 'a', true); p2 := m.mk_project('mc6p2', 'c', true);
    s := m.mk_sample('mc6s', p1, 'b'); o := m.mk_op('mc6o', s, NULL, NULL, 'b');
    PERFORM m.drift('setup');
    UPDATE physical_samples SET project_id = p2 WHERE sample_id = s;
    PERFORM m.drift('moved between two restricted projects');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND NOT m.rd('sample', s, m.u('a')) AND m.rd('sample', s, m.u('b')), 'the new PI reads it, the old one no longer, the owner keeps it');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_mc_rollup_and_askdb_hide_what_sits_under_a_restricted_project_campaign_or_sample_campaign() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c1 uuid; c2 uuid; s uuid; o1 uuid; o2 uuid; r record;
BEGIN
    p := m.mk_project('mc7p', 'a', true); c1 := m.mk_campaign('mc7c1', p, 'b'); o1 := m.mk_op('mc7o1', NULL, NULL, c1, 'c');
    c2 := m.mk_campaign('mc7c2', NULL, 'b', true); s := m.mk_sample('mc7s', NULL, 'd'); PERFORM m.mk_cs(c2, s); o2 := m.mk_op('mc7o2', s, p, NULL, 'd');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.hid('manufacturing_operations', o1) AND m.hid('manufacturing_operations', o2), 'both operations are hidden from the Ask-DB role');
    SELECT * INTO r FROM project_rollup WHERE project_id = p AND kind = 'operation' AND row_id = md5('operation:' || o1::text);
    PERFORM m.expect(r.restricted IS TRUE, 'an operation in a restricted project''s campaign has project_rollup.restricted = true');
    SELECT * INTO r FROM project_rollup WHERE project_id = p AND kind = 'operation' AND row_id = md5('operation:' || o2::text);
    PERFORM m.expect(r.restricted IS TRUE, 'an operation on a sample held only by a restricted campaign has restricted = true');
    SELECT * INTO r FROM project_rollup WHERE project_id = p AND kind = 'sample' AND row_id = md5('sample:' || p::text || ':' || s::text);
    PERFORM m.expect(r.restricted IS TRUE, 'the sample row is restricted too');
    UPDATE projects SET restricted = false WHERE project_id = p;
    UPDATE campaigns SET restricted = false WHERE campaign_id = c2;
    PERFORM m.drift('everything open');
    SELECT * INTO r FROM project_rollup WHERE project_id = p AND kind = 'operation' AND row_id = md5('operation:' || o1::text);
    PERFORM m.expect(r.restricted IS FALSE AND NOT m.hid('manufacturing_operations', o1), 'unrestricting refreshes the rollup and hidden_records');
    PERFORM m.done();
END $$;

-- team grants (migration 176): a grant on a record expands into derived <type>_access rows for the team's members, so the readers
-- triggers of the access tables keep the readers tables right through every team change (grant, join, leave, trust, team deleted)
CREATE OR REPLACE FUNCTION m.mk_team(l text, mgr text, others text[] DEFAULT ARRAY[]::text[]) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO teams (team_id, name) VALUES (m.id(l), 'M team ' || l);
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (m.id(l), m.pe(mgr), true);
    INSERT INTO team_members (team_id, person_id) SELECT m.id(l), m.pe(x) FROM unnest(others) AS x;
    RETURN m.id(l);
END $$;

CREATE OR REPLACE FUNCTION m.c_team_grant() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; c uuid; s uuid; t uuid; g uuid;
BEGIN
    p := m.mk_project('tgp', 'a'); c := m.mk_campaign('tgc', p, 'f'); s := m.mk_sample('tgs', p, 'e'); PERFORM m.mk_cs(c, s);
    t := m.mk_team('tgt', 'b', ARRAY['c', 'z']);
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')), 'before: the team does not read the sample');
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, t, 'view') RETURNING team_access_id INTO g;
    PERFORM m.drift('the team grant (view)');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('sample', s, m.u('c')) AND NOT m.rd('campaign', c, m.u('b')), 'the members read the sample; Can view does not reach the campaign');
    UPDATE sample_team_access SET role = 'edit' WHERE team_access_id = g;
    PERFORM m.drift('the grant made edit');
    PERFORM m.expect(m.rd('campaign', c, m.u('c')) AND m.rd('project', p, m.u('c')), 'Can edit through the team: the members read the campaign and the project');
    DELETE FROM sample_team_access WHERE team_access_id = g;
    PERFORM m.drift('the grant removed');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('project', p, m.u('c')), 'removed: the members lose it all');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_team_join() RETURNS void LANGUAGE plpgsql AS $$
DECLARE o1 uuid; o2 uuid; t uuid; g2 uuid;
BEGIN
    o1 := m.mk_op('tjo1', NULL, NULL, NULL, 'a', true); o2 := m.mk_op('tjo2', NULL, NULL, NULL, 'a', true);
    t := m.mk_team('tjt', 'b');
    INSERT INTO operation_team_access (operation_id, team_id, role, trust_new_members) VALUES (o1, t, 'view', true);
    INSERT INTO operation_team_access (operation_id, team_id, role) VALUES (o2, t, 'edit') RETURNING team_access_id INTO g2;
    PERFORM m.drift('setup');
    INSERT INTO team_members (team_id, person_id) VALUES (t, m.pe('d'));
    PERFORM m.drift('a member joins');
    PERFORM m.expect(m.rd('operation', o1, m.u('d')) AND NOT m.rd('operation', o2, m.u('d')), 'the trusting grant lets the joiner in, the other leaves them pending');
    PERFORM d1_private.team_decide('manufacturing_operations', g2, m.pe('d'), 'approve');
    PERFORM m.drift('the pending member approved');
    PERFORM m.expect(m.rd('operation', o2, m.u('d')), 'approved: the joiner reads the second operation');
    DELETE FROM team_members WHERE team_id = t AND person_id = m.pe('d');
    PERFORM m.drift('the member leaves again');
    PERFORM m.expect(NOT m.rd('operation', o1, m.u('d')) AND NOT m.rd('operation', o2, m.u('d')), 'the reverse: no access left');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_team_leave() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; t uuid; g uuid;
BEGIN
    p := m.mk_project('tlp', 'a'); s := m.mk_sample('tls', p, 'e', true);
    t := m.mk_team('tlt', 'b', ARRAY['c']);
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, t, 'edit') RETURNING team_access_id INTO g;
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND m.rd('project', p, m.u('c')), 'before: the member reads the Restricted sample and, as its editor, the project');
    DELETE FROM team_members WHERE team_id = t AND person_id = m.pe('c');
    PERFORM m.drift('the member leaves');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('c')) AND NOT m.rd('project', p, m.u('c')), 'the leaver loses both at once');
    INSERT INTO team_members (team_id, person_id) VALUES (t, m.pe('c'));
    PERFORM m.drift('the member rejoins (pending)');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('c')), 'a rejoiner the grant does not trust is pending');
    UPDATE sample_team_access SET trust_new_members = true WHERE team_access_id = g;
    PERFORM m.drift('the grant trusts new members');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND m.rd('project', p, m.u('c')), 'the reverse: trusted, the member is back');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_team_trust() RETURNS void LANGUAGE plpgsql AS $$
DECLARE cm uuid; t uuid; g uuid;
BEGIN
    cm := m.mk_campaign('ttc', NULL, 'a', true);
    t := m.mk_team('ttt', 'b');
    INSERT INTO campaign_team_access (campaign_id, team_id, role) VALUES (cm, t, 'view') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (t, m.pe('d')), (t, m.pe('e'));
    PERFORM d1_private.team_decide('campaigns', g, m.pe('e'), 'decline');
    PERFORM m.drift('setup: d pending, e declined');
    PERFORM m.expect(m.rd('campaign', cm, m.u('b')) AND NOT m.rd('campaign', cm, m.u('d')) AND NOT m.rd('campaign', cm, m.u('e')), 'only the member at grant time reads it');
    UPDATE campaign_team_access SET trust_new_members = true WHERE team_access_id = g;
    PERFORM m.drift('trust on');
    PERFORM m.expect(m.rd('campaign', cm, m.u('d')) AND NOT m.rd('campaign', cm, m.u('e')), 'trust lets the pending member in, not the declined one');
    UPDATE campaign_team_access SET trust_new_members = false WHERE team_access_id = g;
    PERFORM m.drift('trust off');
    PERFORM d1_private.team_decide('campaigns', g, m.pe('e'), 'approve');
    PERFORM m.drift('the declined member approved');
    PERFORM m.expect(m.rd('campaign', cm, m.u('d')) AND m.rd('campaign', cm, m.u('e')), 'the reverse: both read it');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_team_delete() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; t uuid;
BEGIN
    p := m.mk_project('tdp', 'a', true); s := m.mk_sample('tds', NULL, 'e', true);
    t := m.mk_team('tdt', 'b', ARRAY['c']);
    INSERT INTO project_team_access (project_id, team_id, role) VALUES (p, t, 'investigator');
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, t, 'view');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.rd('project', p, m.u('b')) AND m.rd('sample', s, m.u('c')), 'the team reads the Restricted project and sample');
    DELETE FROM teams WHERE team_id = t;
    PERFORM m.drift('the team deleted');
    PERFORM m.expect(NOT m.rd('project', p, m.u('b')) AND NOT m.rd('sample', s, m.u('c')), 'its grants and derived rows went with it');
    t := m.mk_team('tdt', 'b', ARRAY['c']);
    INSERT INTO project_team_access (project_id, team_id, role) VALUES (p, t, 'investigator');
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, t, 'view');
    PERFORM m.drift('the reverse: the team and its grants again');
    PERFORM m.expect(m.rd('project', p, m.u('b')) AND m.rd('sample', s, m.u('c')), 'the reverse: read again');
    PERFORM m.done();
END $$;

-- team ownership (migration 177): owner_team_id keeps an owner grant whose derived rows give the team's managers the level manage and its other
-- members edit. The readers machinery counts manage like edit (s_editor, the editor views, the candidates, readers_of_project), and the oracle
-- (scripts/dev/access_matrix_oracle.sql) models the same: m.oracle_agree compares every reader table row of a record, for every user, with the oracle.
CREATE OR REPLACE FUNCTION m.oracle_agree(kind text, rec uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n text; o boolean;
BEGIN
    FOREACH n IN ARRAY ARRAY['a', 'b', 'c', 'd', 'e', 'f'] LOOP
        o := CASE kind WHEN 'sample' THEN ref.s_read(rec, m.u(n)) WHEN 'campaign' THEN ref.c_read(rec, m.u(n)) WHEN 'project' THEN ref.pj_read(rec, m.u(n))
                       WHEN 'operation' THEN ref.op_read_ordinary(rec, m.u(n)) ELSE ref.test_read(rec, m.u(n)) END;
        IF o IS DISTINCT FROM m.rd(kind, rec, m.u(n)) THEN
            RAISE EXCEPTION 'm_fail: the readers table and the oracle disagree on % % for user %: table %, oracle %', kind, left(rec::text, 8), n, m.rd(kind, rec, m.u(n)), o USING ERRCODE = 'M0002';
        END IF;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION m.c_team_own_set() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; o uuid; t uuid; ts uuid; cm uuid; tt uuid; ct uuid; oo uuid; n text;
BEGIN
    p := m.mk_project('tos_p', 'e'); s := m.mk_sample('tos_s', p, 'f', true); o := m.mk_op('tos_o', s, NULL, NULL, NULL, false);
    ts := m.mk_test('tos_t', s, NULL, NULL, 'f', true); cm := m.mk_campaign('tos_c', NULL, 'f', true); oo := m.mk_op('tos_oo', NULL, NULL, NULL, 'f', true);
    t := m.mk_team('tos_team', 'b', ARRAY['c', 'z']);
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('sample', s, m.u('c')) AND m.rd('sample', s, m.u('f')), 'before: the person owner f reads the Restricted sample, the team does not');
    -- the sample, then the other three types, become team-owned
    UPDATE physical_samples SET owner_person_id = NULL, owner_team_id = t WHERE sample_id = s;
    PERFORM m.drift('the sample becomes team-owned');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('sample', s, m.u('c')) AND NOT m.rd('sample', s, m.u('f')) AND m.rd('sample', s, m.u('e')),
        'the members read the Restricted sample, the former owner f does not, the PI e does');
    PERFORM m.expect(m.rd('operation', o, m.u('b')) AND m.rd('operation', o, m.u('c')) AND NOT m.rd('operation', o, m.u('f')), 'the child operation follows the sample''s list');
    PERFORM m.expect(m.rd('project', p, m.u('b')) AND m.rd('project', p, m.u('c')), 'a manager (manage) and a member (edit) are editors of a sample in the project: both read it');
    PERFORM m.expect(d1_private.s_editor(s, m.u('b')) AND d1_private.s_editor(s, m.u('c')) AND ref.s_editor(s, m.u('b')) AND ref.s_editor(s, m.u('c')) AND NOT ref.s_editor(s, m.u('f')),
        'the function and the oracle: both members are editors, the former owner is not');
    PERFORM m.expect((SELECT string_agg(DISTINCT a.role, ',' ORDER BY a.role) FROM sample_access a WHERE a.sample_id = s) = 'edit,manage' AND (SELECT a.role FROM sample_access a WHERE a.sample_id = s AND a.person_id = m.pe('b')) = 'manage', 'the manager has the manage row, the members edit');
    PERFORM m.expect(ref.s_owner(s, m.u('b')) AND NOT ref.s_owner(s, m.u('c')), 'the oracle''s owner: the manager only');
    UPDATE test_sessions SET owner_person_id = NULL, owner_team_id = t WHERE session_id = ts;
    UPDATE campaigns SET owner_person_id = NULL, owner_team_id = t WHERE campaign_id = cm;
    UPDATE manufacturing_operations SET owner_person_id = NULL, owner_team_id = t WHERE operation_id = oo;
    PERFORM m.drift('the test, the campaign and the operation become team-owned');
    PERFORM m.expect(m.rd('test', ts, m.u('b')) AND m.rd('test', ts, m.u('c')) AND m.rd('campaign', cm, m.u('b')) AND m.rd('campaign', cm, m.u('c'))
                     AND m.rd('operation', oo, m.u('b')) AND m.rd('operation', oo, m.u('c')) AND NOT m.rd('operation', oo, m.u('f')), 'the members read the other three Restricted records');
    -- the oracle's update and delete rules: manage and edit may update, only manage deletes
    PERFORM m.expect(ref.test_update(ts, m.u('b')) AND ref.test_update(ts, m.u('c')) AND ref.test_delete(ts, m.u('b')) AND NOT ref.test_delete(ts, m.u('c')), 'test: update by both, delete by the manager');
    PERFORM m.expect(ref.c_update(cm, m.u('b')) AND ref.c_update(cm, m.u('c')) AND ref.c_delete(cm, m.u('b')) AND NOT ref.c_delete(cm, m.u('c')), 'campaign: update by both, delete by the manager');
    PERFORM m.expect(ref.op_update(oo, m.u('b')) AND ref.op_update(oo, m.u('c')) AND ref.op_delete(oo, m.u('b')) AND NOT ref.op_delete(oo, m.u('c')), 'operation: update by both, delete by the manager');
    PERFORM m.oracle_agree('sample', s); PERFORM m.oracle_agree('operation', o); PERFORM m.oracle_agree('project', p); PERFORM m.oracle_agree('test', ts);
    PERFORM m.oracle_agree('campaign', cm); PERFORM m.oracle_agree('operation', oo);
    -- the reverse: back to a person owner
    UPDATE physical_samples SET owner_team_id = NULL, owner_person_id = m.pe('f') WHERE sample_id = s;
    PERFORM m.drift('the sample goes back to a person');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('project', p, m.u('b')) AND m.rd('sample', s, m.u('f')) AND NOT d1_private.s_editor(s, m.u('b')), 'the reverse: the team lost it all, f reads it again');
    PERFORM m.oracle_agree('sample', s); PERFORM m.oracle_agree('project', p);
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_team_own_manager_flag() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; cm uuid; t uuid;
BEGIN
    p := m.mk_project('tof_p', 'e'); s := m.mk_sample('tof_s', p, NULL, true); cm := m.mk_campaign('tof_c', NULL, NULL, false); PERFORM m.mk_cs(cm, s);
    t := m.mk_team('tof_team', 'b', ARRAY['c']);
    UPDATE physical_samples SET owner_team_id = t WHERE sample_id = s;
    PERFORM m.drift('team-owned');
    PERFORM m.expect(m.rd('project', p, m.u('b')) AND m.rd('project', p, m.u('c')) AND m.rd('campaign', cm, m.u('b')) AND m.rd('campaign', cm, m.u('c')), 'start: manage and edit are editors alike: both read the project and the unrestricted campaign');
    -- c becomes a manager, b is demoted: the derived rows swap roles, the readers do not change
    UPDATE team_members SET is_manager = true WHERE team_id = t AND person_id = m.pe('c');
    PERFORM m.drift('c made manager');
    PERFORM m.expect((SELECT a.role FROM sample_access a WHERE a.sample_id = s AND a.person_id = m.pe('c')) = 'manage', 'c holds manage now');
    UPDATE team_members SET is_manager = false WHERE team_id = t AND person_id = m.pe('b');
    PERFORM m.drift('b demoted');
    PERFORM m.expect((SELECT a.role FROM sample_access a WHERE a.sample_id = s AND a.person_id = m.pe('b')) = 'edit', 'b holds edit now');
    PERFORM m.expect(m.rd('project', p, m.u('b')) AND m.rd('project', p, m.u('c')) AND m.rd('campaign', cm, m.u('b')) AND m.rd('campaign', cm, m.u('c'))
                     AND ref.s_editor(s, m.u('b')) AND ref.s_editor(s, m.u('c')) AND ref.s_owner(s, m.u('c')) AND NOT ref.s_owner(s, m.u('b')),
        'a demotion changes the owner powers (oracle), not the reading: the demoted manager still edits and reads');
    PERFORM m.oracle_agree('sample', s); PERFORM m.oracle_agree('project', p); PERFORM m.oracle_agree('campaign', cm);
    -- the reverse
    UPDATE team_members SET is_manager = true WHERE team_id = t AND person_id = m.pe('b');
    UPDATE team_members SET is_manager = false WHERE team_id = t AND person_id = m.pe('c');
    PERFORM m.drift('the flags swapped back');
    PERFORM m.expect((SELECT string_agg(a.role, ',' ORDER BY a.role) FROM sample_access a WHERE a.sample_id = s) = 'edit,manage' AND ref.s_owner(s, m.u('b')), 'the reverse: b manages again');
    PERFORM m.done();
END $$;

-- the owner's elevated paths (a campaign's owner reads its samples, operations and tests; the owner of a campaign, operation or test reads its
-- project) belong to a team's managers too (the manage row), not to its plain members (edit)
CREATE OR REPLACE FUNCTION m.c_team_own_owner_paths() RETURNS void LANGUAGE plpgsql AS $$
DECLARE pc uuid; po uuid; pt uuid; pk uuid; cm uuid; cm2 uuid; s uuid; o uuid; ts uuid; oo uuid; to2 uuid; t uuid;
BEGIN
    pc := m.mk_project('top_pc', 'e'); po := m.mk_project('top_po', 'e'); pt := m.mk_project('top_pt', 'e'); pk := m.mk_project('top_pk', 'e');
    cm := m.mk_campaign('top_c', NULL, 'f', true); s := m.mk_sample('top_s', NULL, 'f', false); PERFORM m.mk_cs(cm, s);
    o := m.mk_op('top_o', NULL, NULL, cm, 'f', false); ts := m.mk_test('top_t', NULL, NULL, cm, 'f', false);
    cm2 := m.mk_campaign('top_c2', pc, 'f', false); oo := m.mk_op('top_oo', NULL, po, NULL, 'f', false); to2 := m.mk_test('top_tt', NULL, pt, NULL, 'f', false);
    t := m.mk_team('top_team', 'b', ARRAY['c']);
    PERFORM m.drift('setup');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('operation', o, m.u('b')) AND NOT m.rd('project', pc, m.u('b')), 'before: the team reads nothing');
    -- the Restricted campaign, and an operation and a test in it, become team-owned
    UPDATE campaigns SET owner_person_id = NULL, owner_team_id = t WHERE campaign_id IN (cm, cm2);
    UPDATE manufacturing_operations SET owner_person_id = NULL, owner_team_id = t WHERE operation_id = oo;
    UPDATE test_sessions SET owner_person_id = NULL, owner_team_id = t WHERE session_id = to2;
    PERFORM m.drift('campaigns, operation and test become team-owned');
    PERFORM m.expect(m.rd('campaign', cm, m.u('b')) AND m.rd('campaign', cm, m.u('c')), 'both members read the Restricted campaign (its list)');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('operation', o, m.u('b')) AND m.rd('test', ts, m.u('b')), 'the manager acts as the campaign''s owner: reads its sample, operation and test');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('c')) AND NOT m.rd('operation', o, m.u('c')) AND NOT m.rd('test', ts, m.u('c')), 'the plain member does not');
    PERFORM m.expect(m.rd('project', pc, m.u('b')) AND m.rd('project', po, m.u('b')) AND m.rd('project', pt, m.u('b')), 'the manager reads the projects of a team-owned campaign, operation and test');
    PERFORM m.expect(NOT m.rd('project', pc, m.u('c')) AND NOT m.rd('project', po, m.u('c')) AND NOT m.rd('project', pt, m.u('c')), 'the plain member reads none of them');
    PERFORM m.oracle_agree('sample', s); PERFORM m.oracle_agree('operation', o); PERFORM m.oracle_agree('test', ts); PERFORM m.oracle_agree('campaign', cm);
    PERFORM m.oracle_agree('project', pc); PERFORM m.oracle_agree('project', po); PERFORM m.oracle_agree('project', pt);
    -- the flag moves: c becomes the manager, b a plain member: the elevations move with it (the role change reaches the readers)
    UPDATE team_members SET is_manager = true WHERE team_id = t AND person_id = m.pe('c');
    UPDATE team_members SET is_manager = false WHERE team_id = t AND person_id = m.pe('b');
    PERFORM m.drift('the manager flag swapped');
    PERFORM m.expect(m.rd('sample', s, m.u('c')) AND m.rd('operation', o, m.u('c')) AND m.rd('project', po, m.u('c')) AND m.rd('project', pc, m.u('c')), 'c, now the manager, has the elevations');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('operation', o, m.u('b')) AND NOT m.rd('project', po, m.u('b')) AND NOT m.rd('project', pt, m.u('b')), 'b, demoted, lost them at once');
    PERFORM m.oracle_agree('sample', s); PERFORM m.oracle_agree('operation', o); PERFORM m.oracle_agree('project', po); PERFORM m.oracle_agree('project', pc);
    -- the reverse: the owners cleared
    UPDATE campaigns SET owner_team_id = NULL WHERE campaign_id IN (cm, cm2);
    UPDATE manufacturing_operations SET owner_team_id = NULL WHERE operation_id = oo;
    UPDATE test_sessions SET owner_team_id = NULL WHERE session_id = to2;
    PERFORM m.drift('the owners cleared');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('c')) AND NOT m.rd('project', po, m.u('c')) AND NOT m.rd('project', pt, m.u('c')) AND NOT m.rd('campaign', cm, m.u('c')), 'the reverse: the team lost it all');
    PERFORM m.done();
END $$;

-- the orphan amnesty: an unrestricted operation with no person owner, no project and no campaign is open to every member. A team-owned one has an
-- owner: it is not open to all (only its team reads it); clearing the team owner makes it an orphan again. A team with no members writes no access row,
-- so only the operations update trigger (which compares owner_team_id) refreshes the amnesty then.
CREATE OR REPLACE FUNCTION m.c_team_own_orphan_open() RETURNS void LANGUAGE plpgsql AS $$
DECLARE o uuid; o2 uuid; t uuid; t2 uuid;
BEGIN
    o := m.mk_op('too_o', NULL, NULL, NULL, NULL, false); o2 := m.mk_op('too_o2', NULL, NULL, NULL, NULL, false);
    t := m.mk_team('too_team', 'b', ARRAY['c']);
    INSERT INTO teams (team_id, name) VALUES (m.id('too_empty'), 'M team empty orphan'); t2 := m.id('too_empty');
    PERFORM m.drift('setup');
    PERFORM m.expect(m.open(o) AND m.open(o2) AND m.rd('operation', o, m.u('d')) IS NOT TRUE AND ref.op_open(o) AND ref.op_read(o, m.u('d')), 'before: an ownerless orphan operation is open to every member (the oracle too)');
    UPDATE manufacturing_operations SET owner_team_id = t WHERE operation_id = o;
    UPDATE manufacturing_operations SET owner_team_id = t2 WHERE operation_id = o2;
    PERFORM m.drift('the orphan operations become team-owned');
    PERFORM m.expect(NOT m.open(o) AND NOT m.open(o2), 'team-owned: not open to all (also for a team with no members)');
    PERFORM m.expect(NOT ref.op_open(o) AND NOT ref.op_open(o2) AND NOT ref.op_read(o, m.u('d')) AND NOT ref.op_read(o2, m.u('d')), 'the oracle agrees: a stranger cannot read them');
    PERFORM m.expect(m.rd('operation', o, m.u('b')) AND m.rd('operation', o, m.u('c')) AND NOT m.rd('operation', o, m.u('d')), 'only the team reads the first');
    PERFORM m.oracle_agree('operation', o); PERFORM m.oracle_agree('operation', o2);
    UPDATE manufacturing_operations SET owner_team_id = NULL WHERE operation_id IN (o, o2);
    PERFORM m.drift('the team owners cleared');
    PERFORM m.expect(m.open(o) AND m.open(o2) AND ref.op_open(o) AND ref.op_open(o2), 'the reverse: ownerless again, open to all again');
    PERFORM m.done();
END $$;

CREATE OR REPLACE FUNCTION m.c_team_own_clear() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p uuid; s uuid; t uuid; o uuid;
BEGIN
    p := m.mk_project('toc_p', 'e'); s := m.mk_sample('toc_s', p, NULL, true); o := m.mk_op('toc_o', s, NULL, NULL, NULL, false);
    t := m.mk_team('toc_team', 'b', ARRAY['c', 'z']);
    PERFORM m.drift('setup');
    UPDATE physical_samples SET owner_team_id = t WHERE sample_id = s;
    PERFORM m.drift('team-owned');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('operation', o, m.u('c')) AND m.rd('project', p, m.u('b')), 'the team reads the sample, its operation and the project');
    -- the team is not deleted while it owns the record; cleared, the grant and every derived row go
    UPDATE physical_samples SET owner_team_id = NULL WHERE sample_id = s;
    PERFORM m.drift('the owner cleared');
    PERFORM m.expect(NOT m.rd('sample', s, m.u('b')) AND NOT m.rd('operation', o, m.u('c')) AND NOT m.rd('project', p, m.u('b')) AND NOT m.rd('project', p, m.u('c')),
        'the team lost the sample, its operation and the project');
    PERFORM m.expect(NOT EXISTS (SELECT 1 FROM sample_access WHERE sample_id = s) AND NOT EXISTS (SELECT 1 FROM sample_team_access WHERE sample_id = s), 'no grant, no derived row');
    PERFORM m.oracle_agree('sample', s); PERFORM m.oracle_agree('operation', o); PERFORM m.oracle_agree('project', p);
    DELETE FROM teams WHERE team_id = t;
    PERFORM m.drift('the team deleted');
    -- the reverse: owned again (a new team), then the record deleted while owned: nothing is left behind
    t := m.mk_team('toc_team', 'b', ARRAY['c']);
    UPDATE physical_samples SET owner_team_id = t WHERE sample_id = s;
    PERFORM m.drift('owned again');
    PERFORM m.expect(m.rd('sample', s, m.u('b')) AND m.rd('project', p, m.u('c')), 'the reverse: the new team reads it again');
    DELETE FROM manufacturing_operations WHERE operation_id = o;
    DELETE FROM physical_samples WHERE sample_id = s;
    PERFORM m.drift('the team-owned record deleted');
    PERFORM m.expect(NOT m.rd('project', p, m.u('b')) AND NOT EXISTS (SELECT 1 FROM sample_team_access WHERE team_id = t), 'a deleted record takes its owner grant with it');
    PERFORM m.done();
END $$;
SQL

echo "== The mutation matrix: one case per row of the spec's trigger-coverage table, and every mutation class =="
echo "$CASES" | qf "$FIX_URL" >/dev/null || bad "the cases did not load: $(echo "$CASES" | qf "$FIX_URL" 2>&1 | head -5)"
cases=$(q "$FIX_URL" "SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'm'::regnamespace AND p.proname LIKE 'c\_%' ORDER BY p.proname")
# shellcheck disable=SC2086
run_cases "$FIX_URL" $cases
# every coverage row has a case: the case names carry the row numbers (c_row30_31_... covers rows 30 and 31); row 49 is the TRUNCATE case below
for n in $(seq 1 51); do
  [[ "$n" == 49 ]] && continue
  nn=$(printf '%02d' "$n")
  grep -Eq "^c_row([0-9]{2}_)*${nn}_" <<<"$cases" || bad "no matrix case for coverage row $n"
done


# ------------------------------------------------------------------------------------------------------------------------------
# Forms that need their own statement, transaction or session
# ------------------------------------------------------------------------------------------------------------------------------
echo "== Row 49: TRUNCATE of every input table rebuilds the readers tables =="
for t in physical_samples manufacturing_operations test_sessions campaigns projects sample_access operation_access test_access campaign_access \
         project_access campaign_samples sample_co_owners project_investigators people directus_users; do
  has=$(q "$FIX_URL" "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.$t'::regclass AND tgname = '${t}_readers_trunc' AND (tgtype & 32) <> 0")
  [[ "$has" == 1 ]] || { bad "row 49: $t has no TRUNCATE trigger ${t}_readers_trunc"; continue; }
  out=$(qf "$FIX_URL" <<SQL
BEGIN;
TRUNCATE $t CASCADE;
SELECT 'drift=' || d1_private.readers_drift_count();
ROLLBACK;
SQL
)
  grep -q '^drift=0$' <<<"$out" && ok "row 49: TRUNCATE $t CASCADE leaves readers_drift() empty (the trigger rebuilt)" || bad "row 49: TRUNCATE $t CASCADE: $out"
done

echo "== Multi-row forms: the importer's 1000-row insert, ON CONFLICT DO UPDATE, COPY =="
t_with=$(qf "$FIX_URL" <<'SQL'
\timing on
BEGIN;
INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number)
SELECT md5('mx1000-' || g)::uuid, (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'), 'fast_25', 'MX1000-' || g, 600000 + g FROM generate_series(1, 1000) g;
SELECT 'drift=' || d1_private.readers_drift_count();
SELECT 'open=' || count(*) FROM operation_open_to_all WHERE record_id IN (SELECT md5('mx1000-' || g)::uuid FROM generate_series(1, 1000) g);
ROLLBACK;
SQL
)
grep -q '^drift=0$' <<<"$t_with" && grep -q '^open=1000$' <<<"$t_with" && ok "one statement inserting 1000 FAST runs: drift empty and all 1000 are open to all" || bad "1000-row insert: $t_with"
ms_with=$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' <<<"$t_with" | sed -n 2p)
t_without=$(qf "$FIX_URL" <<'SQL'
\timing on
BEGIN;
ALTER TABLE manufacturing_operations DISABLE TRIGGER manufacturing_operations_readers_ins;
INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number)
SELECT md5('mx1000-' || g)::uuid, (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'), 'fast_25', 'MX1000-' || g, 600000 + g FROM generate_series(1, 1000) g;
ROLLBACK;
SQL
)
ms_without=$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' <<<"$t_without" | sed -n 3p)
echo "  INFO the 1000-operation insert statement: ${ms_with:-?} ms with the readers trigger, ${ms_without:-?} ms with it disabled (this small database)"

out=$(qf "$FIX_URL" <<'SQL'
BEGIN;
INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number)
SELECT md5('mxup-' || g)::uuid, (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'), 'fast_25', 'MXUP-' || g, 500000 + g FROM generate_series(1, 200) g;
SELECT 'drift_insert=' || d1_private.readers_drift_count();
-- the importer's re-import: INSERT ... ON CONFLICT (operation_id) DO UPDATE changing owner, project and sample (fires the insert and the update triggers)
INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number, owner_person_id, project_id, sample_id)
SELECT md5('mxup-' || g)::uuid, (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'), 'fast_25', 'MXUP-' || g, 500000 + g,
       ref.id('person-owner'), ref.id('P' || (g % 32)), CASE WHEN g % 2 = 0 THEN ref.id('S' || (g % 32)) END FROM generate_series(1, 200) g
ON CONFLICT (operation_id) DO UPDATE SET owner_person_id = EXCLUDED.owner_person_id, project_id = EXCLUDED.project_id, sample_id = EXCLUDED.sample_id;
SELECT 'drift_upsert=' || d1_private.readers_drift_count();
SELECT 'owner_reads=' || count(*) FROM operation_readers WHERE user_id = ref.id('user-owner') AND record_id IN (SELECT md5('mxup-' || g)::uuid FROM generate_series(1, 200) g);
ROLLBACK;
SQL
)
grep -q '^drift_insert=0$' <<<"$out" && grep -q '^drift_upsert=0$' <<<"$out" && ok "the importer's INSERT ... ON CONFLICT (operation_id) DO UPDATE re-import (owner, project and sample changed): drift empty" || bad "ON CONFLICT re-import: $out"
n=$(sed -n 's/^owner_reads=//p' <<<"$out")
[[ "${n:-0}" -gt 0 ]] && ok "the re-import's new owner reads the re-imported operations ($n readers rows)" || bad "ON CONFLICT re-import: the new owner reads none of them"

mid=$(q "$FIX_URL" "SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'")
{
  echo "BEGIN;"
  echo "COPY manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number) FROM STDIN;"
  for i in $(seq 1 40); do
    h=$(printf 'mxcopy-%s' "$i" | md5sum | cut -c1-32)
    printf '%s-%s-%s-%s-%s\t%s\tfast_25\tMXCOPY%s\t%s\n' "${h:0:8}" "${h:8:4}" "${h:12:4}" "${h:16:4}" "${h:20:12}" "$mid" "$i" $((400000 + i))
  done
  echo '\.'
  echo "SELECT 'drift=' || d1_private.readers_drift_count();"
  echo "SELECT 'open=' || count(*) FROM operation_open_to_all o JOIN manufacturing_operations m ON m.operation_id = o.record_id WHERE m.pass_code LIKE 'MXCOPY%';"
  echo "ROLLBACK;"
} > /tmp/mx_copy.sql 2>/dev/null
out=$(qf "$FIX_URL" < /tmp/mx_copy.sql)
grep -q '^drift=0$' <<<"$out" && grep -q '^open=40$' <<<"$out" && ok "COPY of 40 operations: one refresh, drift empty, all open to all" || bad "COPY: $out"

echo "== REPEATABLE READ: refresh_readers raises =="
out=$(qf "$FIX_URL" 2>&1 <<'SQL'
\set ON_ERROR_STOP off
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT d1_private.refresh_readers(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
ROLLBACK;
BEGIN ISOLATION LEVEL REPEATABLE READ;
UPDATE physical_samples SET restricted = NOT restricted WHERE sample_id = ref.id('S0');
ROLLBACK;
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT d1_private.readers_rebuild();
ROLLBACK;
SQL
)
[[ "$(grep -c 'needs READ COMMITTED' <<<"$out")" -ge 3 ]] && ok "refresh_readers, a tracked UPDATE and readers_rebuild all raise under REPEATABLE READ" || bad "REPEATABLE READ did not raise three times: $out"

# ------------------------------------------------------------------------------------------------------------------------------
# Concurrency: two sessions, each in both commit orders. The session that runs its statement first holds the global readers lock
# until it commits (3 s); the other waits at the lock, and must then see everything the first committed.
# ------------------------------------------------------------------------------------------------------------------------------
echo "== Concurrency: cases 0, A, B, a login unlinked while added or made owner, the forced deadlocks =="
# conc <label> <setup sql> <session 1 sql> <session 2 sql> <check sql: one row 'ok' on success>   (@L@ is the order-specific label)
conc() {
  local label="$1" setup="$2" s1="$3" s2="$4" check="$5" order first second lbl f1 f2 out drift res
  for order in 12 21; do
    lbl="${label}_${order}"
    qf "$FIX_URL" <<<"${setup//@L@/$lbl}" >/dev/null || { bad "concurrency $lbl: setup failed"; continue; }
    first="${s1//@L@/$lbl}"; second="${s2//@L@/$lbl}"
    [[ "$order" == 21 ]] && { first="${s2//@L@/$lbl}"; second="${s1//@L@/$lbl}"; }
    f1=$(mktemp); f2=$(mktemp)
    ( psql "$FIX_URL" --no-psqlrc -X -t -A -q -v ON_ERROR_STOP=1 -c "BEGIN; $first; SELECT pg_sleep(3); COMMIT;" >"$f1" 2>&1 ) &
    sleep 1
    ( psql "$FIX_URL" --no-psqlrc -X -t -A -q -v ON_ERROR_STOP=1 -c "BEGIN; $second; COMMIT;" >"$f2" 2>&1 ) &
    wait
    out="$(cat "$f1" "$f2")"; rm -f "$f1" "$f2"
    drift=$(q "$FIX_URL" "SELECT d1_private.readers_drift_count()")
    res=$(q "$FIX_URL" "${check//@L@/$lbl}")
    if [[ -n "$(grep -i 'error' <<<"$out")" ]]; then bad "concurrency $lbl (session order $order): a session failed: $out"
    elif [[ "$drift" != 0 ]]; then bad "concurrency $lbl (session order $order): readers_drift() = $drift after both committed"
    elif [[ "$res" != ok ]]; then bad "concurrency $lbl (session order $order): the effect check failed ($res)"
    else ok "concurrency $lbl: committed in order $order, drift empty and the effect holds"; fi
  done
}

# the builders as SQL text: fresh records per label, committed before the sessions start
SETUP_BASE="SELECT m.mk_project('@L@p', 'a'); SELECT m.mk_campaign('@L@c', m.id('@L@p'), 'b'); SELECT m.mk_sample('@L@s', NULL, 'c');
            INSERT INTO project_investigators (project_id, user_id) VALUES (m.id('@L@p'), m.u('f'));"
# case 0: campaign_samples (S, C) inserted while C is restricted. The investigator f of C's project reads S through the unrestricted campaign.
conc c0 "$SETUP_BASE" \
     "INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (m.id('@L@c'), m.id('@L@s'))" \
     "UPDATE campaigns SET restricted = true WHERE campaign_id = m.id('@L@c')" \
     "SELECT CASE WHEN NOT m.rd('sample', m.id('@L@s'), m.u('f')) AND m.rd('sample', m.id('@L@s'), m.u('b')) AND m.rd('sample', m.id('@L@s'), m.u('c')) THEN 'ok' ELSE 'f reads S: ' || m.rd('sample', m.id('@L@s'), m.u('f')) END"
# case A: an operation repointed onto S while S is restricted / loses its co-owner / joins a restricted campaign (the attaching write seeds only the operation)
SETUP_A="SELECT m.mk_sample('@L@s', NULL, 'a'); SELECT m.mk_op('@L@o', NULL, NULL, NULL, 'c');
         INSERT INTO sample_co_owners (sample_id, user_id) VALUES (m.id('@L@s'), m.u('d'));
         SELECT m.mk_campaign('@L@rc', NULL, 'e', true);"
conc cA1 "$SETUP_A" \
     "UPDATE manufacturing_operations SET sample_id = m.id('@L@s') WHERE operation_id = m.id('@L@o')" \
     "UPDATE physical_samples SET restricted = true WHERE sample_id = m.id('@L@s')" \
     "SELECT CASE WHEN NOT m.rd('operation', m.id('@L@o'), m.u('c')) AND m.rd('operation', m.id('@L@o'), m.u('d')) AND m.rd('operation', m.id('@L@o'), m.u('a')) THEN 'ok' ELSE 'stale readers of the operation (c is the operation owner, not on the restricted sample''s list)' END"
conc cA2 "$SETUP_A" \
     "UPDATE manufacturing_operations SET sample_id = m.id('@L@s') WHERE operation_id = m.id('@L@o')" \
     "DELETE FROM sample_co_owners WHERE sample_id = m.id('@L@s')" \
     "SELECT CASE WHEN NOT m.rd('operation', m.id('@L@o'), m.u('d')) AND m.rd('operation', m.id('@L@o'), m.u('a')) THEN 'ok' ELSE 'the removed co-owner still reads the operation' END"
conc cA3 "$SETUP_A" \
     "UPDATE manufacturing_operations SET sample_id = m.id('@L@s') WHERE operation_id = m.id('@L@o')" \
     "INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (m.id('@L@rc'), m.id('@L@s'))" \
     "SELECT CASE WHEN NOT m.rd('operation', m.id('@L@o'), m.u('c')) AND m.rd('operation', m.id('@L@o'), m.u('d')) AND m.rd('operation', m.id('@L@o'), m.u('a')) THEN 'ok' ELSE 'the shield of the restricted campaign is missing for the operation owner c' END"
# case B: campaign_samples (S, C) inserted while C's PROJECT is restricted
SETUP_B="SELECT m.mk_project('@L@p', 'a'); SELECT m.mk_campaign('@L@c', m.id('@L@p'), 'b'); SELECT m.mk_sample('@L@s', NULL, 'c'); SELECT m.mk_op('@L@o', m.id('@L@s'), NULL, NULL, 'd');"
conc cB "$SETUP_B" \
     "INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (m.id('@L@c'), m.id('@L@s'))" \
     "UPDATE projects SET restricted = true WHERE project_id = m.id('@L@p')" \
     "SELECT CASE WHEN NOT m.rd('sample', m.id('@L@s'), m.u('b')) AND NOT m.rd('operation', m.id('@L@o'), m.u('d')) AND m.rd('sample', m.id('@L@s'), m.u('c')) THEN 'ok' ELSE 'the campaign of a restricted project still lets its owner read the sample' END"
# a login unlinked while the same person is added to a record
SETUP_L="INSERT INTO directus_users (id, email, status, first_name, last_name) VALUES (m.id('@L@u'), '@L@@example.invalid', 'active', 'L', 'U');
         INSERT INTO people (person_id, full_name, user_id, is_researcher, active) VALUES (m.id('@L@pe'), 'L pe', m.id('@L@u'), true, true);
         SELECT m.mk_sample('@L@s', NULL, 'a');"
conc cL "$SETUP_L" \
     "UPDATE people SET user_id = NULL WHERE person_id = m.id('@L@pe')" \
     "INSERT INTO sample_access (sample_id, person_id, role) VALUES (m.id('@L@s'), m.id('@L@pe'), 'view')" \
     "SELECT CASE WHEN NOT m.rd('sample', m.id('@L@s'), m.id('@L@u')) THEN 'ok' ELSE 'an unlinked login is still a reader' END"
# a login unlinked while the same person becomes the owner of a sample (the people.user_id update takes the person's row lock; people_readers_lock takes the readers lock first)
conc cP "$SETUP_L"      "UPDATE people SET user_id = NULL WHERE person_id = m.id('@L@pe')"      "UPDATE physical_samples SET owner_person_id = m.id('@L@pe') WHERE sample_id = m.id('@L@s')"      "SELECT CASE WHEN NOT m.rd('sample', m.id('@L@s'), m.id('@L@u')) AND (SELECT owner_person_id FROM physical_samples WHERE sample_id = m.id('@L@s')) = m.id('@L@pe') THEN 'ok' ELSE 'the unlinked login still reads the sample it was made owner of, or the owner change was lost' END"

# a forced lock-order deadlock with a row lock: session 1 holds a row (SELECT ... FOR UPDATE takes no readers lock) and wants the readers lock, session 2 holds
# the readers lock (every statement on physical_samples takes it) and wants that row
for order in a; do
  lbl="dl_$order"
  qf "$FIX_URL" <<<"SELECT m.mk_sample('${lbl}A', NULL, 'a'); SELECT m.mk_sample('${lbl}B', NULL, 'a'); SELECT m.mk_sample('${lbl}C', NULL, 'a');" >/dev/null
  f1=$(mktemp); f2=$(mktemp)
  ( psql "$FIX_URL" --no-psqlrc -X -t -A -q -c "BEGIN; SELECT 1 FROM physical_samples WHERE sample_id = m.id('${lbl}A') FOR UPDATE; SELECT pg_sleep(2); UPDATE physical_samples SET restricted = true WHERE sample_id = m.id('${lbl}B'); COMMIT;" >"$f1" 2>&1 ) &
  sleep 1
  ( psql "$FIX_URL" --no-psqlrc -X -t -A -q -c "BEGIN; UPDATE physical_samples SET restricted = true WHERE sample_id = m.id('${lbl}C'); SELECT pg_sleep(2); UPDATE physical_samples SET notes = 'y' WHERE sample_id = m.id('${lbl}A'); COMMIT;" >"$f2" 2>&1 ) &
  wait
  out="$(cat "$f1" "$f2")"; rm -f "$f1" "$f2"
  drift=$(q "$FIX_URL" "SELECT d1_private.readers_drift_count()")
  nd=$(grep -c "deadlock detected" <<<"$out")
  nrestricted=$(q "$FIX_URL" "SELECT count(*) FROM physical_samples WHERE sample_id IN (m.id('${lbl}B'), m.id('${lbl}C')) AND restricted")
  if [[ "$nd" == 1 && "$drift" == 0 && "$nrestricted" == 1 ]]; then ok "a forced lock-order deadlock aborts exactly one writer cleanly (40P01), the other commits, nothing is left stale"
  else bad "forced deadlock: deadlocks=$nd drift=$drift committed restricted flags=$nrestricted output: $out"; fi
  break
done

# The people-row deadlock (review finding 2): session 1 holds the readers lock (a sample statement) and then makes P the owner of a sample (a foreign key
# KEY SHARE on P's row); session 2, one second in, updates people.user_id of P (a FOR UPDATE on that row, UNIQUE column). Without people_readers_lock session 2
# takes the row first and waits for the readers lock in its AFTER trigger while session 1 waits for the row: a deadlock. With it session 2 waits at the lock
# BEFORE it touches the row, so both commit. The second round drops the trigger and must deadlock (the test can fail).
people_deadlock() {
  local mode="$1" lbl="pdl_$1" f1 f2 out nd drift own ul
  qf "$FIX_URL" <<<"INSERT INTO directus_users (id, email, status, first_name, last_name) VALUES (m.id('${lbl}u'), '${lbl}@example.invalid', 'active', 'P', 'D');
                    INSERT INTO people (person_id, full_name, user_id, is_researcher, active) VALUES (m.id('${lbl}pe'), 'P ${lbl}', m.id('${lbl}u'), true, true);
                    SELECT m.mk_sample('${lbl}X', NULL, 'a'); SELECT m.mk_sample('${lbl}Y', NULL, 'a');" >/dev/null
  f1=$(mktemp); f2=$(mktemp)
  ( psql "$FIX_URL" --no-psqlrc -X -t -A -q -c "BEGIN; UPDATE physical_samples SET restricted = true WHERE sample_id = m.id('${lbl}X'); SELECT pg_sleep(2); UPDATE physical_samples SET owner_person_id = m.id('${lbl}pe') WHERE sample_id = m.id('${lbl}Y'); COMMIT;" >"$f1" 2>&1 ) &
  sleep 1
  ( psql "$FIX_URL" --no-psqlrc -X -t -A -q -c "BEGIN; UPDATE people SET user_id = NULL WHERE person_id = m.id('${lbl}pe'); COMMIT;" >"$f2" 2>&1 ) &
  wait
  out="$(cat "$f1" "$f2")"; rm -f "$f1" "$f2"
  nd=$(grep -c "deadlock detected" <<<"$out")
  drift=$(q "$FIX_URL" "SELECT d1_private.readers_drift_count()")
  own=$(q "$FIX_URL" "SELECT count(*) FROM physical_samples WHERE sample_id = m.id('${lbl}Y') AND owner_person_id = m.id('${lbl}pe')")
  ul=$(q "$FIX_URL" "SELECT count(*) FROM people WHERE person_id = m.id('${lbl}pe') AND user_id IS NULL")
  echo "$nd $drift $own $ul"
}
res=$(people_deadlock with)
if [[ "$res" == "0 0 1 1" ]]; then ok "a people.user_id update against an owner change (the people-row deadlock): no deadlock with people_readers_lock, both commit, drift empty"
else bad "people-row deadlock with people_readers_lock: deadlocks drift owner-set unlinked = '$res'"; fi
q "$FIX_URL" "DROP TRIGGER people_readers_lock ON people" >/dev/null
res=$(people_deadlock without)
q "$FIX_URL" "CREATE TRIGGER people_readers_lock BEFORE UPDATE OF user_id ON people FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_lock()" >/dev/null
if [[ "${res%% *}" == 1 ]]; then ok "the same pair deadlocks (40P01) when people_readers_lock is dropped: the test can fail ($res)"
else bad "without people_readers_lock the pair did not deadlock ($res): the test does not exercise the row-lock order"; fi
[[ "$(q "$FIX_URL" "SELECT count(*) FROM pg_trigger WHERE tgname = 'people_readers_lock' AND NOT tgisinternal")" == 1 ]] && ok "people_readers_lock restored" || bad "people_readers_lock was not restored"

# ------------------------------------------------------------------------------------------------------------------------------
# The backfill and a big-project restrict on DEFAULT lock settings, with the peak pg_locks count
# ------------------------------------------------------------------------------------------------------------------------------
echo "== The backfill and a big-project restrict on default max_locks_per_transaction =="
maxl=$(q "$FIX_URL" "SHOW max_locks_per_transaction")
[[ "$maxl" == 64 ]] && ok "max_locks_per_transaction is the default (64)" || echo "  INFO max_locks_per_transaction = $maxl (live: 64)"
qf "$FIX_URL" >/dev/null <<'SQL'
-- one big project: 40 campaigns, 800 samples (each in two campaigns), 6000 operations, 600 tests, 6 people with logins on them
SELECT m.mk_project('bigp', 'a');
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, owner_person_id)
SELECT m.id('bigc' || g), m.id('bigp'), 'testing_campaign', 'M big ' || g, m.pe((ARRAY['a','b','c','d','e','f'])[1 + g % 6]) FROM generate_series(1, 40) g;
INSERT INTO physical_samples (sample_id, sample_code, project_id, owner_person_id)
SELECT m.id('bigs' || g), 'M-BIG-' || g, m.id('bigp'), m.pe((ARRAY['a','b','c','d','e','f'])[1 + g % 6]) FROM generate_series(1, 800) g;
INSERT INTO campaign_samples (campaign_id, sample_id)
SELECT m.id('bigc' || (1 + g % 40)), m.id('bigs' || g) FROM generate_series(1, 800) g
UNION SELECT m.id('bigc' || (1 + (g * 7) % 40)), m.id('bigs' || g) FROM generate_series(1, 800) g;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, project_id, owner_person_id)
SELECT m.id('bigo' || g), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'HT'), m.id('bigs' || (1 + g % 800)), m.id('bigp'),
       m.pe((ARRAY['a','b','c','d','e','f'])[1 + g % 6]) FROM generate_series(1, 6000) g;
INSERT INTO test_sessions (session_id, test_type, sample_id, project_id, owner_person_id)
SELECT m.id('bigt' || g), 'hardness', m.id('bigs' || (1 + g % 800)), m.id('bigp'), m.pe((ARRAY['a','b','c','d','e','f'])[1 + g % 6]) FROM generate_series(1, 600) g;
SQL
out=$(qf "$FIX_URL" <<'SQL'
\timing on
BEGIN;
SELECT d1_private.readers_rebuild();
SELECT 'locks_backfill=' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
SELECT 'drift=' || d1_private.readers_drift_count();
COMMIT;
BEGIN;
UPDATE projects SET restricted = true WHERE project_id = m.id('bigp');
SELECT 'locks_restrict=' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
SELECT 'closure_ops=' || count(*) FROM manufacturing_operations WHERE project_id = m.id('bigp');
SELECT 'drift=' || d1_private.readers_drift_count();
COMMIT;
BEGIN;
UPDATE projects SET principal_investigator_person = m.pe('c') WHERE project_id = m.id('bigp');
SELECT 'locks_pi=' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
SELECT 'drift=' || d1_private.readers_drift_count();
COMMIT;
SQL
)
echo "$out" | grep -E "^(locks|closure|Time)" | tr '\n' ' ' | sed 's/^/  INFO /'; echo
[[ "$(grep -c '^drift=0$' <<<"$out")" == 3 ]] && ok "the backfill, restricting a big project (6000 operations) and changing its PI all succeed on default lock settings and leave readers_drift() empty" || bad "big-project cascades: $out"
for k in backfill restrict pi; do
  n=$(sed -n "s/^locks_$k=//p" <<<"$out")
  [[ -n "$n" && "$n" -lt 1000 ]] && ok "peak pg_locks of the $k transaction: $n (limit about 6400)" || bad "peak locks of $k: '$n'"
done

# ------------------------------------------------------------------------------------------------------------------------------
# The seeded randomised differential test
# ------------------------------------------------------------------------------------------------------------------------------
echo "== Randomised differential test: $SEEDS universes from seed $SEED0, $STEPS mutation steps each =="
read -r -d '' RANDSQL <<'SQL'
CREATE OR REPLACE FUNCTION m.rn(n int) RETURNS int LANGUAGE sql VOLATILE AS $$ SELECT floor(random() * n)::int $$;
CREATE OR REPLACE FUNCTION m.rp(prob float) RETURNS boolean LANGUAGE sql VOLATILE AS $$ SELECT random() < prob $$;
-- a random person name (a to f, z has no login) or NULL
CREATE OR REPLACE FUNCTION m.rperson(p_null float DEFAULT 0.15) RETURNS text LANGUAGE sql VOLATILE AS $$
    SELECT CASE WHEN random() < p_null THEN NULL ELSE (ARRAY['a','b','c','d','e','f','z'])[1 + floor(random() * 7)::int] END $$;
CREATE OR REPLACE FUNCTION m.rlogin() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT m.u((ARRAY['a','b','c','d','e','f'])[1 + floor(random() * 6)::int]) $$;
CREATE OR REPLACE FUNCTION m.rid(arr uuid[]) RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT CASE WHEN cardinality(arr) = 0 THEN NULL ELSE arr[1 + floor(random() * cardinality(arr))::int] END $$;
CREATE OR REPLACE FUNCTION m.ridn(arr uuid[], p_null float) RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT CASE WHEN random() < p_null THEN NULL ELSE m.rid(arr) END $$;

CREATE OR REPLACE FUNCTION m.rcross(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
    -- the functions against the oracle, as a full users x records cross product (a candidate class the production generation drops shows up here)
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.readers_of_sample(ARRAY(SELECT sample_id FROM physical_samples)))
        SELECT 1 FROM physical_samples s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.sample_id AND f.user_id = u.id
         WHERE ref.s_read(s.sample_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % samples differ from the oracle: % pair(s)', label, n USING ERRCODE = 'M0002'; END IF;
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.readers_of_operation(ARRAY(SELECT operation_id FROM manufacturing_operations)))
        SELECT 1 FROM manufacturing_operations s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.operation_id AND f.user_id = u.id
         WHERE ref.op_read_ordinary(s.operation_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % operations differ from the oracle: % pair(s)', label, n USING ERRCODE = 'M0002'; END IF;
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.operation_open_of(ARRAY(SELECT operation_id FROM manufacturing_operations)))
        SELECT 1 FROM manufacturing_operations s LEFT JOIN f ON f.record_id = s.operation_id
         WHERE ref.op_open(s.operation_id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % amnesty differs from the oracle: % operation(s)', label, n USING ERRCODE = 'M0002'; END IF;
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.readers_of_test(ARRAY(SELECT session_id FROM test_sessions)))
        SELECT 1 FROM test_sessions s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.session_id AND f.user_id = u.id
         WHERE ref.test_read(s.session_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % tests differ from the oracle: % pair(s)', label, n USING ERRCODE = 'M0002'; END IF;
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.readers_of_campaign(ARRAY(SELECT campaign_id FROM campaigns)))
        SELECT 1 FROM campaigns s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.campaign_id AND f.user_id = u.id
         WHERE ref.c_read(s.campaign_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % campaigns differ from the oracle: % pair(s)', label, n USING ERRCODE = 'M0002'; END IF;
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.readers_of_project(ARRAY(SELECT project_id FROM projects)))
        SELECT 1 FROM projects s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.project_id AND f.user_id = u.id
         WHERE ref.pj_read(s.project_id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % projects differ from the oracle: % pair(s)', label, n USING ERRCODE = 'M0002'; END IF;
    SELECT count(*) INTO n FROM (
        WITH f AS (SELECT * FROM d1_private.readers_of_campaign_sample(ARRAY(SELECT id FROM campaign_samples)))
        SELECT 1 FROM campaign_samples s CROSS JOIN directus_users u LEFT JOIN f ON f.record_id = s.id AND f.user_id = u.id
         WHERE ref.cs_read(s.id, u.id) IS DISTINCT FROM (f.record_id IS NOT NULL)) x;
    IF n > 0 THEN RAISE EXCEPTION 'm_fail: % campaign_samples differ from the oracle: % pair(s)', label, n USING ERRCODE = 'M0002'; END IF;
    PERFORM m.drift(label);
END $$;

-- a random universe: projects, campaigns, samples, operations and tests with random flags, owners, edges and lists
CREATE OR REPLACE FUNCTION m.rbuild() RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int; pj uuid[] := '{}'; cm uuid[] := '{}'; sm uuid[] := '{}'; v uuid; k int;
BEGIN
    FOR i IN 0..2 LOOP
        pj := pj || m.mk_project('xp' || i, m.rperson(0.15), m.rp(0.3));
        IF m.rp(0.4) THEN INSERT INTO project_investigators (project_id, user_id) VALUES (pj[i + 1], m.rlogin()) ON CONFLICT DO NOTHING; END IF;
        IF m.rp(0.4) THEN INSERT INTO project_access (project_id, person_id, role) VALUES (pj[i + 1], m.pe(m.rperson(0)), (ARRAY['view','investigator'])[1 + m.rn(2)]) ON CONFLICT DO NOTHING; END IF;
    END LOOP;
    FOR i IN 0..3 LOOP
        cm := cm || m.mk_campaign('xc' || i, m.ridn(pj, 0.3), m.rperson(0.1), m.rp(0.3));
        IF m.rp(0.4) THEN INSERT INTO campaign_access (campaign_id, person_id, role) VALUES (cm[i + 1], m.pe(m.rperson(0)), (ARRAY['view','edit'])[1 + m.rn(2)]) ON CONFLICT DO NOTHING; END IF;
    END LOOP;
    FOR i IN 0..5 LOOP
        sm := sm || m.mk_sample('xs' || i, m.ridn(pj, 0.4), m.rperson(0.1), m.rp(0.3));
        IF m.rp(0.3) THEN INSERT INTO sample_co_owners (sample_id, user_id) VALUES (sm[i + 1], m.rlogin()) ON CONFLICT DO NOTHING; END IF;
        IF m.rp(0.4) THEN INSERT INTO sample_access (sample_id, person_id, role) VALUES (sm[i + 1], m.pe(m.rperson(0)), (ARRAY['view','edit'])[1 + m.rn(2)]) ON CONFLICT DO NOTHING; END IF;
        FOR k IN 1..m.rn(3) LOOP INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (m.rid(cm), sm[i + 1]) ON CONFLICT DO NOTHING; END LOOP;
    END LOOP;
    FOR i IN 0..7 LOOP
        v := m.mk_op('xo' || i, m.ridn(sm, 0.15), m.ridn(pj, 0.4), m.ridn(cm, 0.4), m.rperson(0.3), m.rp(0.25));
        IF m.rp(0.3) THEN INSERT INTO operation_access (operation_id, person_id, role) VALUES (v, m.pe(m.rperson(0)), 'view') ON CONFLICT DO NOTHING; END IF;
    END LOOP;
    FOR i IN 0..4 LOOP
        v := m.mk_test('xt' || i, m.ridn(sm, 0.2), m.ridn(pj, 0.4), m.ridn(cm, 0.4), m.rperson(0.2), m.rp(0.25));
        IF m.rp(0.3) THEN INSERT INTO test_access (session_id, person_id, role) VALUES (v, m.pe(m.rperson(0)), 'view') ON CONFLICT DO NOTHING; END IF;
    END LOOP;
END $$;

-- one random mutation (an invalid one, refused by a constraint, is skipped; anything else is a failure)
CREATE OR REPLACE FUNCTION m.rmutate(step int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE kind int := m.rn(20); sm uuid[]; op uuid[]; ts uuid[]; cm uuid[]; pj uuid[]; r uuid; tbl text; what text;
BEGIN
    sm := ARRAY(SELECT sample_id FROM physical_samples WHERE sample_code LIKE 'M-x%'); op := ARRAY(SELECT operation_id FROM manufacturing_operations WHERE pass_code IS NULL OR true ORDER BY operation_id);
    ts := ARRAY(SELECT session_id FROM test_sessions WHERE test_type = 'hardness' ORDER BY session_id); cm := ARRAY(SELECT campaign_id FROM campaigns WHERE name LIKE 'M x%');
    pj := ARRAY(SELECT project_id FROM projects WHERE project_code LIKE 'Mx%');
    op := ARRAY(SELECT operation_id FROM manufacturing_operations WHERE source_system = 'm_test' OR sample_id = ANY (sm));
    BEGIN
        IF kind = 0 THEN
            what := (ARRAY['physical_samples','manufacturing_operations','test_sessions','campaigns','projects'])[1 + m.rn(5)];
            what := CASE what WHEN 'physical_samples' THEN 'sample_id' WHEN 'manufacturing_operations' THEN 'operation_id' WHEN 'test_sessions' THEN 'session_id' WHEN 'campaigns' THEN 'campaign_id' ELSE 'project_id' END;
            r := CASE what WHEN 'sample_id' THEN m.rid(sm) WHEN 'operation_id' THEN m.rid(op) WHEN 'session_id' THEN m.rid(ts) WHEN 'campaign_id' THEN m.rid(cm) ELSE m.rid(pj) END;
            tbl := CASE what WHEN 'sample_id' THEN 'physical_samples' WHEN 'operation_id' THEN 'manufacturing_operations' WHEN 'session_id' THEN 'test_sessions' WHEN 'campaign_id' THEN 'campaigns' ELSE 'projects' END;
            EXECUTE format('UPDATE %I SET restricted = NOT restricted WHERE %I = $1', tbl, what) USING r;
        ELSIF kind = 1 THEN
            r := m.rid(sm); UPDATE physical_samples SET owner_person_id = m.pe(m.rperson(0.2)) WHERE sample_id = r;
        ELSIF kind = 2 THEN
            r := m.rid(op); UPDATE manufacturing_operations SET owner_person_id = m.pe(m.rperson(0.3)) WHERE operation_id = r;
        ELSIF kind = 3 THEN
            r := m.rid(ts); UPDATE test_sessions SET owner_person_id = m.pe(m.rperson(0.3)) WHERE session_id = r;
        ELSIF kind = 4 THEN
            r := m.rid(cm); UPDATE campaigns SET owner_person_id = m.pe(m.rperson(0.2)) WHERE campaign_id = r;
        ELSIF kind = 5 THEN
            what := (ARRAY['s','o','t','c'])[1 + m.rn(4)];
            IF what = 's' THEN UPDATE physical_samples SET project_id = m.ridn(pj, 0.3) WHERE sample_id = m.rid(sm);
            ELSIF what = 'o' THEN UPDATE manufacturing_operations SET project_id = m.ridn(pj, 0.3) WHERE operation_id = m.rid(op);
            ELSIF what = 't' THEN UPDATE test_sessions SET project_id = m.ridn(pj, 0.3) WHERE session_id = m.rid(ts);
            ELSE UPDATE campaigns SET project_id = m.ridn(pj, 0.3) WHERE campaign_id = m.rid(cm); END IF;
        ELSIF kind = 6 THEN
            IF m.rp(0.5) THEN UPDATE manufacturing_operations SET campaign_id = m.ridn(cm, 0.3) WHERE operation_id = m.rid(op);
            ELSE UPDATE test_sessions SET campaign_id = m.ridn(cm, 0.3) WHERE session_id = m.rid(ts); END IF;
        ELSIF kind = 7 THEN
            IF m.rp(0.5) THEN UPDATE manufacturing_operations SET sample_id = m.ridn(sm, 0.2) WHERE operation_id = m.rid(op);
            ELSE UPDATE test_sessions SET sample_id = m.ridn(sm, 0.2) WHERE session_id = m.rid(ts); END IF;
        ELSIF kind = 8 THEN
            IF m.rp(0.55) THEN INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (m.rid(cm), m.rid(sm)) ON CONFLICT DO NOTHING;
            ELSIF m.rp(0.5) THEN DELETE FROM campaign_samples WHERE id = (SELECT id FROM campaign_samples ORDER BY id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM campaign_samples), 1)));
            ELSE UPDATE campaign_samples SET campaign_id = m.rid(cm) WHERE id = (SELECT id FROM campaign_samples ORDER BY id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM campaign_samples), 1))); END IF;
        ELSIF kind = 9 THEN
            what := (ARRAY['sample','operation','test','campaign','project'])[1 + m.rn(5)];
            IF m.rp(0.6) THEN
                IF what = 'sample' THEN INSERT INTO sample_access (sample_id, person_id, role) VALUES (m.rid(sm), m.pe(m.rperson(0)), (ARRAY['view','edit'])[1 + m.rn(2)]) ON CONFLICT (sample_id, person_id) WHERE team_access_id IS NULL DO UPDATE SET role = EXCLUDED.role;
                ELSIF what = 'operation' THEN INSERT INTO operation_access (operation_id, person_id, role) VALUES (m.rid(op), m.pe(m.rperson(0)), 'view') ON CONFLICT DO NOTHING;
                ELSIF what = 'test' THEN INSERT INTO test_access (session_id, person_id, role) VALUES (m.rid(ts), m.pe(m.rperson(0)), 'view') ON CONFLICT DO NOTHING;
                ELSIF what = 'campaign' THEN INSERT INTO campaign_access (campaign_id, person_id, role) VALUES (m.rid(cm), m.pe(m.rperson(0)), (ARRAY['view','edit'])[1 + m.rn(2)]) ON CONFLICT DO NOTHING;
                ELSE INSERT INTO project_access (project_id, person_id, role) VALUES (m.rid(pj), m.pe(m.rperson(0)), (ARRAY['view','investigator'])[1 + m.rn(2)]) ON CONFLICT (project_id, person_id) WHERE team_access_id IS NULL DO UPDATE SET role = EXCLUDED.role; END IF;
            ELSE
                IF what = 'sample' THEN DELETE FROM sample_access WHERE access_id = (SELECT access_id FROM sample_access ORDER BY access_id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM sample_access), 1)));
                ELSIF what = 'operation' THEN DELETE FROM operation_access WHERE access_id = (SELECT access_id FROM operation_access ORDER BY access_id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM operation_access), 1)));
                ELSIF what = 'test' THEN DELETE FROM test_access WHERE access_id = (SELECT access_id FROM test_access ORDER BY access_id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM test_access), 1)));
                ELSIF what = 'campaign' THEN DELETE FROM campaign_access WHERE access_id = (SELECT access_id FROM campaign_access ORDER BY access_id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM campaign_access), 1)));
                ELSE DELETE FROM project_access WHERE access_id = (SELECT access_id FROM project_access ORDER BY access_id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM project_access), 1))); END IF;
            END IF;
        ELSIF kind = 10 THEN
            IF m.rp(0.5) THEN INSERT INTO sample_co_owners (sample_id, user_id) VALUES (m.rid(sm), m.rlogin()) ON CONFLICT DO NOTHING;
            ELSE DELETE FROM sample_co_owners WHERE id = (SELECT id FROM sample_co_owners ORDER BY id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM sample_co_owners), 1))); END IF;
        ELSIF kind = 11 THEN
            IF m.rp(0.5) THEN INSERT INTO project_investigators (project_id, user_id) VALUES (m.rid(pj), m.rlogin()) ON CONFLICT DO NOTHING;
            ELSE DELETE FROM project_investigators WHERE id = (SELECT id FROM project_investigators ORDER BY id LIMIT 1 OFFSET m.rn(GREATEST((SELECT count(*)::int FROM project_investigators), 1))); END IF;
        ELSIF kind = 12 THEN
            -- link, unlink or change a person's login (a login is unique to one person: free it first)
            what := m.rperson(0);
            IF m.rp(0.5) THEN UPDATE people SET user_id = NULL WHERE person_id = m.pe(what);
            ELSE UPDATE people SET user_id = NULL WHERE user_id = m.u(what) AND person_id <> m.pe(what); UPDATE people SET user_id = m.u(what) WHERE person_id = m.pe(what) AND what <> 'z'; END IF;
        ELSIF kind = 13 THEN
            UPDATE projects SET principal_investigator_person = m.pe(m.rperson(0.2)) WHERE project_id = m.rid(pj);
        ELSIF kind = 14 THEN
            what := (ARRAY['o','t','s','c'])[1 + m.rn(4)];
            IF what = 'o' THEN DELETE FROM manufacturing_operations WHERE operation_id = m.rid(op);
            ELSIF what = 't' THEN DELETE FROM test_sessions WHERE session_id = m.rid(ts);
            ELSIF what = 's' THEN DELETE FROM physical_samples WHERE sample_id = m.rid(sm);
            ELSE DELETE FROM campaigns WHERE campaign_id = m.rid(cm); END IF;
        ELSIF kind = 16 THEN
            -- a person is deleted (owners set null, access rows and legacy rows cascade) and, half the time, comes back with or without the login
            what := m.rperson(0);
            IF what <> 'z' THEN
                DELETE FROM people WHERE person_id = m.pe(what);
                IF m.rp(0.6) THEN
                    INSERT INTO people (person_id, full_name, user_id, is_researcher, active) VALUES (m.pe(what), 'M again ' || what, CASE WHEN m.rp(0.5) THEN m.u(what) END, true, true);
                END IF;
            END IF;
        ELSIF kind = 17 THEN
            -- a login is deleted (readers rows and legacy rows cascade, people.user_id is set null) and, half the time, created again and linked
            what := (ARRAY['a','b','c','d','e','f'])[1 + m.rn(6)];
            DELETE FROM directus_users WHERE id = m.u(what);
            IF m.rp(0.6) THEN
                INSERT INTO directus_users (id, email, status, first_name, last_name) VALUES (m.u(what), 'm-' || what || '@example.invalid', 'active', 'M', what);
                IF m.rp(0.6) THEN UPDATE people SET user_id = m.u(what) WHERE person_id = m.pe(what) AND user_id IS NULL; END IF;
            END IF;
        ELSIF kind = 18 THEN
            -- a project is deleted (campaigns set null; samples, operations or tests may refuse it)
            DELETE FROM projects WHERE project_id = m.rid(pj);
        ELSIF kind = 19 THEN
            -- multi-row statements: two rows of a table in one UPDATE
            what := (ARRAY['s','o','c','w'])[1 + m.rn(4)];
            IF what = 's' THEN UPDATE physical_samples SET restricted = NOT restricted WHERE sample_id IN (m.rid(sm), m.rid(sm));
            ELSIF what = 'o' THEN UPDATE manufacturing_operations SET owner_person_id = m.pe(m.rperson(0.3)) WHERE operation_id IN (m.rid(op), m.rid(op));
            ELSIF what = 'c' THEN UPDATE campaigns SET project_id = m.ridn(pj, 0.3), restricted = NOT restricted WHERE campaign_id IN (m.rid(cm), m.rid(cm));
            ELSE UPDATE people SET user_id = CASE WHEN user_id IS NULL THEN m.u(CASE person_id WHEN m.pe('a') THEN 'a' WHEN m.pe('b') THEN 'b' ELSE 'c' END) ELSE NULL END
                  WHERE person_id IN (m.pe('a'), m.pe('b'), m.pe('c')); END IF;
        ELSE
            -- a test's derived sample through its subject rows
            r := m.rid(ts);
            IF m.rp(0.6) THEN INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES (r, 'physical_samples', m.rid(sm)::text);
            ELSE DELETE FROM test_sessions_subject WHERE test_sessions_id = r; END IF;
        END IF;
    EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation THEN
        RETURN 'skipped (' || SQLERRM || ')';
    END;
    RETURN 'kind ' || kind;
END $$;

CREATE OR REPLACE FUNCTION m.rrun(seed int, steps int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE i int; what text;
BEGIN
    BEGIN
        PERFORM setseed((seed % 9973) / 10000.0);
        PERFORM m.rbuild();
        PERFORM m.rcross('universe of seed ' || seed);
        FOR i IN 1..steps LOOP
            what := m.rmutate(i);
            PERFORM m.drift('seed ' || seed || ' step ' || i || ' (' || what || ')');
        END LOOP;
        PERFORM m.rcross('seed ' || seed || ' after ' || steps || ' mutations');
        RAISE EXCEPTION 'm_ok' USING ERRCODE = 'M0001';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'M0001' THEN RETURN 'ok'; END IF;
        RETURN SQLSTATE || ' ' || SQLERRM;
    END;
    RETURN 'unreachable';
END $$;
SQL
echo "$RANDSQL" | qf "$RND_URL" >/dev/null || bad "the random-test functions did not load: $(echo "$RANDSQL" | qf "$RND_URL" 2>&1 | head -5)"
# the generator must be able to build universes and reach the checks at all: seed 0 builds a universe and counts what it made
for ((seed = SEED0; seed < SEED0 + SEEDS; seed++)); do
  res=$(q "$RND_URL" "SELECT m.rrun($seed, $STEPS)")
  if [[ "$res" == ok ]]; then ok "random universe, seed $seed: function = oracle on every pair, readers_drift() empty after each of $STEPS mutations"
  else bad "random seed $seed (re-run: MATRIX_SEED0=$seed MATRIX_SEEDS=1): $res"; fi
done

# the random test can fail: with the samples' UPDATE trigger disabled it finds the stale readers on some seed
q "$RND_URL" "ALTER TABLE physical_samples DISABLE TRIGGER physical_samples_readers_upd" >/dev/null
caught=0
for ((seed = SEED0; seed < SEED0 + 8; seed++)); do
  res=$(q "$RND_URL" "SELECT m.rrun($seed, $STEPS)")
  [[ "$res" != ok ]] && { caught=1; break; }
done
q "$RND_URL" "ALTER TABLE physical_samples ENABLE TRIGGER physical_samples_readers_upd" >/dev/null
[[ "$caught" == 1 ]] && ok "the randomised test fails when a trigger is disabled (seed $seed: ${res:0:90}...)" || bad "the randomised test did not notice a disabled trigger on 8 seeds"

# @@TAIL@@
echo
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
echo "Readers matrix OK."
