#!/usr/bin/env bash
# The People admin SQL functions (People 1, Task 1, migration 20261014000180): d1_private.people_attention(), person_access() and
# person_access_list(). Each case runs in BEGIN ... ROLLBACK on a COPY of the migrated database (CREATE DATABASE ... TEMPLATE),
# so nothing is left behind and the migrated database itself is never touched.
# Usage: DATABASE_URL=postgres://d1:pw@host:5432/d1_test bash tests/people_admin.sh      (run by CI and scripts/dev/schema_test_docker.sh)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
: "${DATABASE_URL:?DATABASE_URL must be set}"

# the same server, another database (a trailing ?query stays)
url_for() { sed -E "s#(://[^/]+/)[^/?]+#\1$1#" <<<"$DATABASE_URL"; }
SRC_DB=$(sed -E 's#^.*://[^/]+/([^/?]+).*$#\1#' <<<"$DATABASE_URL")
ADMIN_URL=$(url_for postgres)
PA_DB="${SRC_DB}_pa"
PA_URL=$(url_for "$PA_DB")

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

cleanup() { psql "$ADMIN_URL" --no-psqlrc -X -q -c "DROP DATABASE IF EXISTS $PA_DB WITH (FORCE)" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
psql "$ADMIN_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $PA_DB TEMPLATE $SRC_DB" \
  || { bad "cannot copy $SRC_DB to $PA_DB (other sessions connected?)"; echo "Results: $pass passed, $fail failed"; exit 1; }

# run_case <name>: the SQL of the case on stdin, wrapped in BEGIN ... ROLLBACK; a failed ASSERT or any other error fails the case
run_case() {
  local name="$1" body out
  body=$(cat)
  if out=$(printf 'BEGIN;\n%s\nROLLBACK;\n' "$body" | psql "$PA_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -f - 2>&1); then
    ok "$name"
  else
    bad "$name: $out"
  fi
}

# The shared fixture of the access cases: one person (PA Subject, with a login) who owns 2 samples and 1 campaign, is PI of 1 project,
# has edit on 1 sample through sample_access (added by PA Adder), is a co-owner of another sample, and is an investigator on a second
# project through project_access (added by PA Adder). The ids are kept in the temp table pa.
read -r -d '' ACCESS_FIXTURE <<'SQL'
CREATE TEMP TABLE pa (kind text PRIMARY KEY, id uuid);
DO $$
DECLARE u uuid := gen_random_uuid(); adder uuid; pe uuid; s3 uuid; s4 uuid; c1 uuid; pj1 uuid; pj2 uuid; t text := left(u::text, 8);
BEGIN
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-acc-' || u || '@example.invalid', 'active');
    INSERT INTO people (full_name, user_id) VALUES ('PA Subject', u) RETURNING person_id INTO pe;
    INSERT INTO people (full_name) VALUES ('PA Adder') RETURNING person_id INTO adder;
    INSERT INTO projects (project_code, project_name, principal_investigator_person) VALUES ('PA-P1-' || t, 'PA pi project', pe) RETURNING project_id INTO pj1;
    INSERT INTO projects (project_code, project_name) VALUES ('PA-P2-' || t, 'PA inv project') RETURNING project_id INTO pj2;
    INSERT INTO physical_samples (sample_code, owner_person_id) VALUES ('PA-S1-' || t, pe), ('PA-S2-' || t, pe);
    INSERT INTO physical_samples (sample_code) VALUES ('PA-S3-' || t) RETURNING sample_id INTO s3;
    INSERT INTO physical_samples (sample_code) VALUES ('PA-S4-' || t) RETURNING sample_id INTO s4;
    INSERT INTO campaigns (campaign_type, name, owner_person_id) VALUES ('testing_campaign', 'PA campaign', pe) RETURNING campaign_id INTO c1;
    INSERT INTO sample_access (sample_id, person_id, role, added_by_person_id) VALUES (s3, pe, 'edit', adder);
    INSERT INTO sample_co_owners (sample_id, user_id) VALUES (s4, u);
    INSERT INTO project_access (project_id, person_id, role, added_by_person_id) VALUES (pj2, pe, 'investigator', adder);
    INSERT INTO pa VALUES ('person', pe), ('adder', adder), ('s3', s3), ('s4', s4), ('pj1', pj1), ('pj2', pj2), ('c1', c1);
END $$;
SQL

# run_case_fx <name>: the same, with the access fixture run first (a here-string, not a pipe, so the pass/fail counters survive)
run_case_fx() { local rest; rest=$(cat); run_case "$1" <<<"$ACCESS_FIXTURE"$'\n'"$rest"; }

echo "== People admin: attention and access functions =="

run_case attention_keys_only_when_hit <<'SQL'
-- a clean baseline for the key under test: every existing login gets a person
INSERT INTO people (full_name, user_id) SELECT coalesce(u.email, u.id::text), u.id FROM directus_users u
 WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id = u.id);
DO $$
DECLARE u uuid := gen_random_uuid(); got uuid[];
BEGIN
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'login_without_person'), 'baseline has no login_without_person key';
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-nop-' || u || '@example.invalid', 'active');
    SELECT user_ids INTO got FROM d1_private.people_attention() WHERE key = 'login_without_person';
    ASSERT got = ARRAY[u], format('login_without_person lists the new login, got %s', got);
    DELETE FROM directus_users WHERE id = u;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'login_without_person'), 'the key is gone after the delete';
    -- archived and draft logins are not usable logins: not counted (the People page does not list them either)
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-arch-' || u || '@example.invalid', 'archived');
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'login_without_person'), 'archived login: not counted';
    UPDATE directus_users SET status = 'draft' WHERE id = u;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'login_without_person'), 'draft login: not counted';
    UPDATE directus_users SET status = 'suspended' WHERE id = u;
    SELECT user_ids INTO got FROM d1_private.people_attention() WHERE key = 'login_without_person';
    ASSERT got = ARRAY[u], 'suspended login without a person: counted';
    DELETE FROM directus_users WHERE id = u;
    -- only keys with a hit are ever returned, one row per key
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE cardinality(person_ids) = 0 AND cardinality(user_ids) = 0), 'no empty rows';
    ASSERT (SELECT count(*) = count(DISTINCT key) FROM d1_private.people_attention()), 'one row per key';
END $$;
SQL

run_case invite_not_accepted_and_missing_email <<'SQL'
DO $$
DECLARE u uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); pe uuid; pe2 uuid; pe3 uuid; got uuid[];
BEGIN
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-inv-' || u || '@example.invalid', 'invited');
    INSERT INTO people (full_name, user_id) VALUES ('PA Invited', u) RETURNING person_id INTO pe;
    SELECT user_ids INTO got FROM d1_private.people_attention() WHERE key = 'invite_not_accepted';
    ASSERT u = ANY (got), 'the invited login is listed';
    UPDATE directus_users SET status = 'active' WHERE id = u;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'invite_not_accepted' AND u = ANY (user_ids)), 'accepted: not listed';
    -- missing email: none on the person and none on the login; a login email is enough
    INSERT INTO people (full_name) VALUES ('PA No Email') RETURNING person_id INTO pe2;
    INSERT INTO directus_users (id, email, status) VALUES (u2, 'pa-hasmail-' || u2 || '@example.invalid', 'active');
    INSERT INTO people (full_name, user_id) VALUES ('PA Login Email', u2) RETURNING person_id INTO pe3;
    SELECT person_ids INTO got FROM d1_private.people_attention() WHERE key = 'missing_email';
    ASSERT pe2 = ANY (got), 'no email at all: listed';
    ASSERT NOT (pe3 = ANY (got)), 'the login email counts: not listed';
    UPDATE people SET email = 'x@example.invalid' WHERE person_id = pe2;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'missing_email' AND pe2 = ANY (person_ids)), 'with an email: not listed';
END $$;
SQL

run_case duplicate_by_name_and_email <<'SQL'
DO $$
DECLARE a uuid; b uuid; c uuid; d uuid; e uuid; got uuid[];
BEGIN
    INSERT INTO people (full_name) VALUES ('Ada Lovelace') RETURNING person_id INTO a;
    INSERT INTO people (full_name) VALUES (' ada lovelace ') RETURNING person_id INTO b;
    INSERT INTO people (full_name) VALUES ('Someone Else Entirely') RETURNING person_id INTO e;
    SELECT person_ids INTO got FROM d1_private.people_attention() WHERE key = 'possible_duplicate';
    ASSERT a = ANY (got) AND b = ANY (got), 'same normalised name: both listed';
    ASSERT NOT (e = ANY (got)), 'a unique name is not listed';
    INSERT INTO people (full_name, email) VALUES ('Grace A', 'Grace.H@Example.invalid') RETURNING person_id INTO c;
    INSERT INTO people (full_name, email) VALUES ('Grace B', 'grace.h@example.invalid') RETURNING person_id INTO d;
    SELECT person_ids INTO got FROM d1_private.people_attention() WHERE key = 'possible_duplicate';
    ASSERT c = ANY (got) AND d = ANY (got), 'same email, different case: both listed';
END $$;
SQL

run_case former_login_active <<'SQL'
DO $$
DECLARE u uuid := gen_random_uuid(); pe uuid; got uuid[];
BEGIN
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-former-' || u || '@example.invalid', 'active');
    INSERT INTO people (full_name, user_id, active) VALUES ('PA Former', u, false) RETURNING person_id INTO pe;
    SELECT person_ids INTO got FROM d1_private.people_attention() WHERE key = 'former_login_active';
    ASSERT pe = ANY (got), 'former person with an active login: listed';
    UPDATE directus_users SET status = 'suspended' WHERE id = u;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'former_login_active' AND pe = ANY (person_ids)), 'suspended login: not listed';
    UPDATE directus_users SET status = 'active' WHERE id = u;
    UPDATE people SET active = true WHERE person_id = pe;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'former_login_active' AND pe = ANY (person_ids)), 'a current person: not listed';
END $$;
SQL

run_case suspended_owns_records <<'SQL'
DO $$
DECLARE u uuid := gen_random_uuid(); pe uuid; got uuid[];
BEGIN
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-susp-' || u || '@example.invalid', 'suspended');
    INSERT INTO people (full_name, user_id) VALUES ('PA Suspended', u) RETURNING person_id INTO pe;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'suspended_owns_records' AND pe = ANY (person_ids)), 'owns nothing: not listed';
    INSERT INTO physical_samples (sample_code, owner_person_id) VALUES ('PA-SUSP-' || left(u::text, 8), pe);
    SELECT person_ids INTO got FROM d1_private.people_attention() WHERE key = 'suspended_owns_records';
    ASSERT pe = ANY (got), 'suspended and owns a sample: listed';
    UPDATE directus_users SET status = 'active' WHERE id = u;
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'suspended_owns_records' AND pe = ANY (person_ids)), 'an active login: not listed';
END $$;
SQL

run_case_fx person_access_counts <<'SQL'
DO $$
DECLARE r record;
BEGIN
    SELECT * INTO r FROM d1_private.person_access((SELECT id FROM pa WHERE kind = 'person'));
    ASSERT r.owns = 4, format('owns 2 samples + 1 campaign + PI of 1 project = 4, got %s', r.owns);
    ASSERT r.shared = 2, format('shared: sample_access edit + co-owner = 2, got %s', r.shared);
    ASSERT r.investigator = 1, format('investigator = 1, got %s', r.investigator);
    ASSERT r.teams = 0 AND r.waiting = 0, format('no team access and nothing waiting (migration 182 columns), got %s and %s', r.teams, r.waiting);
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.person_access_list((SELECT id FROM pa WHERE kind = 'person'), 'teams')), 'which = teams is accepted and empty';
    -- a person with nothing: one row of zeros
    SELECT * INTO r FROM d1_private.person_access((SELECT id FROM pa WHERE kind = 'adder'));
    ASSERT r.owns = 0 AND r.shared = 0 AND r.investigator = 0 AND r.teams = 0 AND r.waiting = 0, 'the adder has no access of his own';
END $$;
SQL

run_case_fx person_access_list_sources <<'SQL'
DO $$
DECLARE p uuid := (SELECT id FROM pa WHERE kind = 'person'); n int; r record;
BEGIN
    SELECT count(*) INTO n FROM d1_private.person_access_list(p, 'shared');
    ASSERT n = 2, format('shared lists 2 rows, got %s', n);
    SELECT * INTO r FROM d1_private.person_access_list(p, 'shared') WHERE source = 'access';
    ASSERT r.collection = 'physical_samples' AND r.record_id = (SELECT id FROM pa WHERE kind = 's3') AND r.level = 'edit', 'the access row: sample s3, edit';
    ASSERT r.granted_by = 'PA Adder', format('granted_by is the adder''s full_name, got %s', r.granted_by);
    ASSERT r.added_at IS NOT NULL, 'the access row has a date';
    SELECT * INTO r FROM d1_private.person_access_list(p, 'shared') WHERE source = 'co_owner';
    ASSERT r.record_id = (SELECT id FROM pa WHERE kind = 's4') AND r.collection = 'physical_samples', 'the co-owner row: sample s4';
    ASSERT r.granted_by IS NULL, 'a co-owner row has no granter';
    -- owns: 3 owner rows and 1 pi row
    SELECT count(*) INTO n FROM d1_private.person_access_list(p, 'owns') WHERE source = 'owner' AND level = 'owner';
    ASSERT n = 3, format('3 owner rows, got %s', n);
    SELECT * INTO r FROM d1_private.person_access_list(p, 'owns') WHERE source = 'pi';
    ASSERT r.collection = 'projects' AND r.level = 'pi' AND r.record_id = (SELECT id FROM pa WHERE kind = 'pj1'), 'the pi row: project pj1';
    -- investigator
    SELECT * INTO r FROM d1_private.person_access_list(p, 'investigator');
    ASSERT r.collection = 'projects' AND r.level = 'investigator' AND r.source = 'access' AND r.granted_by = 'PA Adder', 'the investigator row via project_access';
    -- a bad selector is an error, not an empty list
    BEGIN
        PERFORM d1_private.person_access_list(p, 'nope');
        ASSERT false, 'an unknown which must raise';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
END $$;
SQL

run_case person_access_other_collections_and_junctions <<'SQL'
DO $$
DECLARE u uuid := gen_random_uuid(); pe uuid; adder uuid; pj uuid; op uuid; ts uuid; ca uuid; r record; n int; t text := left(u::text, 8);
BEGIN
    INSERT INTO directus_users (id, email, status) VALUES (u, 'pa-oth-' || u || '@example.invalid', 'active');
    INSERT INTO people (full_name, user_id) VALUES ('PA Other', u) RETURNING person_id INTO pe;
    INSERT INTO people (full_name) VALUES ('PA Other Adder') RETURNING person_id INTO adder;
    INSERT INTO projects (project_code, project_name) VALUES ('PA-O-' || t, 'PA other project') RETURNING project_id INTO pj;
    -- an owned operation and test session; and a foreign operation, test session and campaign shared with the person
    INSERT INTO manufacturing_operations (method_id, owner_person_id, source_system)
        VALUES ((SELECT method_id FROM manufacturing_methods ORDER BY method_id LIMIT 1), pe, 'pa_test');
    INSERT INTO test_sessions (test_type, owner_person_id) VALUES ('hardness', pe);
    INSERT INTO manufacturing_operations (method_id, source_system)
        VALUES ((SELECT method_id FROM manufacturing_methods ORDER BY method_id LIMIT 1), 'pa_test') RETURNING operation_id INTO op;
    INSERT INTO test_sessions (test_type) VALUES ('hardness') RETURNING session_id INTO ts;
    INSERT INTO campaigns (campaign_type, name) VALUES ('testing_campaign', 'PA other campaign') RETURNING campaign_id INTO ca;
    INSERT INTO operation_access (operation_id, person_id, role, added_by_person_id) VALUES (op, pe, 'view', adder);
    INSERT INTO test_access (session_id, person_id, role, added_by_person_id) VALUES (ts, pe, 'edit', adder);
    INSERT INTO campaign_access (campaign_id, person_id, role, added_by_person_id) VALUES (ca, pe, 'edit', adder);
    INSERT INTO project_access (project_id, person_id, role, added_by_person_id) VALUES (pj, pe, 'view', adder);
    INSERT INTO project_investigators (project_id, user_id) VALUES (pj, u);

    SELECT count(*) INTO n FROM d1_private.person_access_list(pe, 'owns');
    ASSERT n = 2, format('owns an operation and a test session = 2, got %s', n);
    ASSERT (SELECT count(DISTINCT collection) FROM d1_private.person_access_list(pe, 'owns')) = 2, 'the two owner rows are in two collections';
    SELECT count(*) INTO n FROM d1_private.person_access_list(pe, 'shared');
    ASSERT n = 4, format('shared = operation view + test edit + campaign edit + project view = 4, got %s', n);
    ASSERT EXISTS (SELECT 1 FROM d1_private.person_access_list(pe, 'shared') WHERE collection = 'manufacturing_operations' AND record_id = op AND level = 'view' AND source = 'access'), 'operation view listed';
    ASSERT EXISTS (SELECT 1 FROM d1_private.person_access_list(pe, 'shared') WHERE collection = 'test_sessions' AND record_id = ts AND level = 'edit' AND source = 'access'), 'test edit listed';
    ASSERT EXISTS (SELECT 1 FROM d1_private.person_access_list(pe, 'shared') WHERE collection = 'campaigns' AND record_id = ca AND level = 'edit' AND source = 'access'), 'campaign edit listed';
    ASSERT EXISTS (SELECT 1 FROM d1_private.person_access_list(pe, 'shared') WHERE collection = 'projects' AND record_id = pj AND level = 'view' AND source = 'access'), 'project view listed';
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.person_access_list(pe, 'shared') WHERE level = 'investigator'), 'investigator rows are not shared rows';
    SELECT * INTO r FROM d1_private.person_access_list(pe, 'investigator');
    ASSERT r.source = 'investigator_junction' AND r.collection = 'projects' AND r.level = 'investigator' AND r.record_id = pj AND r.granted_by IS NULL,
        'the old junction row is listed as investigator_junction';
    SELECT count(*) INTO n FROM d1_private.person_access_list(pe, 'investigator');
    ASSERT n = 1, format('one investigator row (the view row is not one), got %s', n);
END $$;
SQL

run_case functions_not_granted_to_readonly_role <<'SQL'
DO $$
DECLARE f text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN RETURN; END IF;
    FOREACH f IN ARRAY ARRAY['d1_private.people_attention()', 'd1_private.person_access(uuid)', 'd1_private.person_access_list(uuid, text)'] LOOP
        ASSERT NOT has_function_privilege('d1_llm_readonly', f, 'EXECUTE'), format('%s must not be executable by d1_llm_readonly', f);
    END LOOP;
END $$;
SQL

echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
