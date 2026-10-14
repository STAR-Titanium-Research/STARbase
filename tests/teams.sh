#!/usr/bin/env bash
# Teams (People 2, Task 1, migration 20261014000175): the teams, team_members and team_events tables, the "a team keeps a manager" deferred
# constraint, the history triggers and the Directus registration. Most cases run in BEGIN ... ROLLBACK on a COPY of the migrated database
# (CREATE DATABASE ... TEMPLATE), so nothing is left behind and the migrated database itself is never touched. The manager rule is judged at
# COMMIT, which a rolled-back case never reaches, so its cases really commit (on the copy, dropped at the end).
# Usage: DATABASE_URL=postgres://d1:pw@host:5432/d1_test bash tests/teams.sh      (run by CI and scripts/dev/schema_test_docker.sh)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
: "${DATABASE_URL:?DATABASE_URL must be set}"

# the same server, another database (a trailing ?query stays)
url_for() { sed -E "s#(://[^/]+/)[^/?]+#\1$1#" <<<"$DATABASE_URL"; }
SRC_DB=$(sed -E 's#^.*://[^/]+/([^/?]+).*$#\1#' <<<"$DATABASE_URL")
ADMIN_URL=$(url_for postgres)
TM_DB="${SRC_DB}_tm"
TM_URL=$(url_for "$TM_DB")

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

cleanup() { psql "$ADMIN_URL" --no-psqlrc -X -q -c "DROP DATABASE IF EXISTS $TM_DB WITH (FORCE)" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
psql "$ADMIN_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $TM_DB TEMPLATE $SRC_DB" \
  || { bad "cannot copy $SRC_DB to $TM_DB (other sessions connected?)"; echo "Results: $pass passed, $fail failed"; exit 1; }

# run_case <name>: the SQL of the case on stdin, wrapped in BEGIN ... ROLLBACK; a failed ASSERT or any other error fails the case
run_case() {
  local name="$1" body out
  body=$(cat)
  if out=$(printf 'BEGIN;\n%s\nROLLBACK;\n' "$body" | psql "$TM_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -f - 2>&1); then
    ok "$name"
  else
    bad "$name: $out"
  fi
}

# run_commit <name> <ok | error text the case must fail with>: the SQL of the case on stdin, run as it is (it carries its own BEGIN and COMMIT)
run_commit() {
  local name="$1" expect="$2" body out rc
  body=$(cat)
  out=$(printf '%s\n' "$body" | psql "$TM_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f - 2>&1); rc=$?
  if [[ "$expect" == ok ]]; then
    [[ $rc -eq 0 ]] && ok "$name" || bad "$name: expected the commit to succeed, got: $out"
  else
    if [[ $rc -ne 0 ]] && grep -qF -- "$expect" <<<"$out" && grep -qF -- '23514' <<<"$out"; then ok "$name"
    else bad "$name: expected 23514 '$expect', got (rc=$rc): $out"; fi
  fi
}

echo "== Teams: tables, manager rule, history =="

run_case name_is_unique_case_insensitive <<'SQL'
DO $$
DECLARE st text;
BEGIN
    INSERT INTO teams (name) VALUES ('TM Alpha');
    BEGIN
        INSERT INTO teams (name) VALUES ('  tm ALPHA ');
        RAISE EXCEPTION 'a second team with the same name (ignoring case and blanks) was accepted';
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS st = CONSTRAINT_NAME;
        ASSERT st = 'teams_name_key', format('the unique index teams_name_key refuses it, got %s', st);
    END;
    INSERT INTO teams (name) VALUES ('TM Alpha 2');
    BEGIN
        INSERT INTO teams (name) VALUES ('   ');
        RAISE EXCEPTION 'a blank name was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
SQL

run_case colour_must_be_in_palette <<'SQL'
DO $$
DECLARE k text;
BEGIN
    INSERT INTO teams (name) VALUES ('TM Default colour');
    ASSERT (SELECT color FROM teams WHERE name = 'TM Default colour') = 'teal', 'the default colour is teal';
    FOREACH k IN ARRAY ARRAY['teal','blue','indigo','violet','pink','red','orange','amber','green','slate'] LOOP
        INSERT INTO teams (name, color) VALUES ('TM colour ' || k, k);
    END LOOP;
    BEGIN
        INSERT INTO teams (name, color) VALUES ('TM Purple', 'purple');
        RAISE EXCEPTION 'a colour outside the palette was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO teams (name, color) VALUES ('TM Null colour', NULL);
        RAISE EXCEPTION 'a NULL colour was accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
END $$;
SQL

# --- the manager rule, judged at COMMIT: each case really commits (on the throwaway copy) ---
run_commit "team_needs_a_manager: a team with only a non-manager member is refused at commit" "A team must keep at least one manager" <<'SQL'
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('7a000000-0000-4000-8000-000000000001', 'TM P1');
INSERT INTO teams (team_id, name) VALUES ('7b000000-0000-4000-8000-000000000001', 'TM No manager');
INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('7b000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000001', false);
COMMIT;
SQL

run_commit "team_needs_a_manager: a team with a manager commits" ok <<'SQL'
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('7a000000-0000-4000-8000-000000000011', 'TM M1'), ('7a000000-0000-4000-8000-000000000012', 'TM M2');
INSERT INTO teams (team_id, name) VALUES ('7b000000-0000-4000-8000-000000000011', 'TM With manager');
-- the non-manager is added first: the rule is judged at commit, not per statement
INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('7b000000-0000-4000-8000-000000000011', '7a000000-0000-4000-8000-000000000012', false);
INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('7b000000-0000-4000-8000-000000000011', '7a000000-0000-4000-8000-000000000011', true);
COMMIT;
SQL

run_commit "team_needs_a_manager: a team with no members commits" ok <<'SQL'
BEGIN;
INSERT INTO teams (team_id, name) VALUES ('7b000000-0000-4000-8000-000000000021', 'TM Empty team');
COMMIT;
SQL

run_commit "team_needs_a_manager: removing the last manager in its own transaction is refused" "A team must keep at least one manager" <<'SQL'
BEGIN;
DELETE FROM team_members WHERE team_id = '7b000000-0000-4000-8000-000000000011' AND person_id = '7a000000-0000-4000-8000-000000000011';
COMMIT;
SQL

run_commit "team_needs_a_manager: unsetting the last manager's flag is refused" "A team must keep at least one manager" <<'SQL'
BEGIN;
UPDATE team_members SET is_manager = false WHERE team_id = '7b000000-0000-4000-8000-000000000011' AND person_id = '7a000000-0000-4000-8000-000000000011';
COMMIT;
SQL

run_commit "team_needs_a_manager: the refused transactions changed nothing" ok <<'SQL'
DO $$
BEGIN
    ASSERT (SELECT count(*) FROM team_members WHERE team_id = '7b000000-0000-4000-8000-000000000011') = 2, 'both members are still in the team';
    ASSERT (SELECT count(*) FROM team_members WHERE team_id = '7b000000-0000-4000-8000-000000000011' AND is_manager) = 1, 'the manager is still a manager';
END $$;
SQL

run_commit "team_needs_a_manager: swapping the manager in one transaction commits" ok <<'SQL'
BEGIN;
UPDATE team_members SET is_manager = true WHERE team_id = '7b000000-0000-4000-8000-000000000011' AND person_id = '7a000000-0000-4000-8000-000000000012';
UPDATE team_members SET is_manager = false WHERE team_id = '7b000000-0000-4000-8000-000000000011' AND person_id = '7a000000-0000-4000-8000-000000000011';
COMMIT;
SQL

run_commit "team_needs_a_manager: removing every member in one transaction commits (an empty team is allowed)" ok <<'SQL'
BEGIN;
DELETE FROM team_members WHERE team_id = '7b000000-0000-4000-8000-000000000011';
COMMIT;
SQL

run_commit "team_needs_a_manager: deleting the team (and with it its last manager) commits" ok <<'SQL'
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('7a000000-0000-4000-8000-000000000031', 'TM D1'), ('7a000000-0000-4000-8000-000000000032', 'TM D2');
INSERT INTO teams (team_id, name) VALUES ('7b000000-0000-4000-8000-000000000031', 'TM To delete');
INSERT INTO team_members (team_id, person_id, is_manager) VALUES
  ('7b000000-0000-4000-8000-000000000031', '7a000000-0000-4000-8000-000000000031', true),
  ('7b000000-0000-4000-8000-000000000031', '7a000000-0000-4000-8000-000000000032', false);
COMMIT;
BEGIN;
DELETE FROM teams WHERE team_id = '7b000000-0000-4000-8000-000000000031';
COMMIT;
DO $$
BEGIN
    ASSERT NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = '7b000000-0000-4000-8000-000000000031'), 'the members went with the team';
    ASSERT NOT EXISTS (SELECT 1 FROM team_events WHERE team_id = '7b000000-0000-4000-8000-000000000031'), 'a deleted team leaves no events';
END $$;
SQL

run_commit "team_needs_a_manager: moving the only manager to another team is refused for the team it left" "A team must keep at least one manager" <<'SQL'
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('7a000000-0000-4000-8000-000000000041', 'TM X1'), ('7a000000-0000-4000-8000-000000000042', 'TM X2');
INSERT INTO teams (team_id, name) VALUES ('7b000000-0000-4000-8000-000000000041', 'TM Move from'), ('7b000000-0000-4000-8000-000000000042', 'TM Move to');
INSERT INTO team_members (team_id, person_id, is_manager) VALUES
  ('7b000000-0000-4000-8000-000000000041', '7a000000-0000-4000-8000-000000000041', true),
  ('7b000000-0000-4000-8000-000000000041', '7a000000-0000-4000-8000-000000000042', false);
COMMIT;
BEGIN;
UPDATE team_members SET team_id = '7b000000-0000-4000-8000-000000000042'
 WHERE team_id = '7b000000-0000-4000-8000-000000000041' AND person_id = '7a000000-0000-4000-8000-000000000041';
COMMIT;
SQL

# --- history ---
run_case history_records_member_changes <<'SQL'
DO $$
DECLARE
    u uuid := gen_random_uuid(); actor uuid; a uuid; b uuid; t uuid; ev text; n int; r record;
BEGIN
    INSERT INTO directus_users (id, email, status) VALUES (u, 'tm-actor-' || u || '@example.invalid', 'active');
    INSERT INTO people (full_name, user_id) VALUES ('TM Actor', u) RETURNING person_id INTO actor;
    INSERT INTO people (full_name) VALUES ('TM Member A') RETURNING person_id INTO a;
    INSERT INTO people (full_name) VALUES ('TM Member B') RETURNING person_id INTO b;

    -- no actor set: events are still written, with a null actor
    INSERT INTO teams (name) VALUES ('TM History') RETURNING team_id INTO t;
    SELECT * INTO r FROM team_events WHERE team_id = t AND kind = 'created';
    ASSERT r.event_id IS NOT NULL AND r.actor_person_id IS NULL AND r.detail = '{"name":"TM History"}', format('created without an actor: %s', to_jsonb(r));

    -- an actor that is not a user id is ignored
    PERFORM set_config('d1.actor_identity', 'machine-token-7', true);
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (t, a, true);
    ASSERT (SELECT actor_person_id FROM team_events WHERE team_id = t AND kind = 'member_added' AND person_id = a) IS NULL, 'a non-uuid actor identity gives a null actor';

    PERFORM set_config('d1.actor_identity', u::text, true);
    INSERT INTO team_members (team_id, person_id) VALUES (t, b);
    UPDATE team_members SET is_manager = true WHERE team_id = t AND person_id = b;
    UPDATE team_members SET is_manager = false WHERE team_id = t AND person_id = b;
    UPDATE team_members SET is_manager = false WHERE team_id = t AND person_id = b;   -- no change: no event
    UPDATE teams SET name = 'TM History renamed' WHERE team_id = t;
    UPDATE teams SET name = 'TM History renamed', color = 'blue' WHERE team_id = t;    -- same name: no event
    UPDATE teams SET description = 'x' WHERE team_id = t;                              -- not the name: no event
    DELETE FROM team_members WHERE team_id = t AND person_id = b;

    SELECT string_agg(kind, ',' ORDER BY event_id) INTO ev FROM team_events WHERE team_id = t;
    ASSERT ev = 'created,member_added,member_added,manager_set,manager_unset,renamed,member_removed', format('events in order: %s', ev);

    SELECT count(*) INTO n FROM team_events WHERE team_id = t AND actor_person_id = actor;
    ASSERT n = 5, format('the five events after the actor was set carry the actor, got %s', n);
    ASSERT (SELECT count(*) FROM team_events WHERE team_id = t AND actor_person_id IS NULL) = 2, 'the two before it carry no actor';
    ASSERT (SELECT count(*) FROM team_events WHERE team_id = t AND kind IN ('member_added', 'manager_set', 'manager_unset', 'member_removed') AND person_id = b) = 4,
        'member_added, manager_set, manager_unset and member_removed are about member B';
    SELECT * INTO r FROM team_events WHERE team_id = t AND kind = 'renamed';
    ASSERT r.detail = '{"from":"TM History","to":"TM History renamed"}', format('renamed carries from and to: %s', r.detail);
    SELECT * INTO r FROM team_events WHERE team_id = t AND kind = 'member_removed';
    ASSERT r.detail = '{"was_manager":false}' AND r.person_id = b, format('member_removed carries was_manager: %s', to_jsonb(r));
    ASSERT (SELECT detail FROM team_events WHERE team_id = t AND kind = 'member_added' AND person_id = a) = '{"is_manager":true}', 'member_added carries is_manager';
    ASSERT (SELECT collection IS NULL AND record_id IS NULL FROM team_events WHERE team_id = t AND kind = 'created'), 'collection and record_id are for sharing events only';

    -- deleting a person: their removal is logged with a null person; deleting the team logs nothing and leaves nothing
    DELETE FROM people WHERE person_id = b;
    INSERT INTO team_members (team_id, person_id) VALUES (t, actor);
    DELETE FROM people WHERE person_id = actor;
    SELECT * INTO r FROM team_events WHERE team_id = t AND kind = 'member_removed' ORDER BY event_id DESC LIMIT 1;
    ASSERT r.person_id IS NULL AND r.actor_person_id IS NULL, format('a deleted person is logged with a null person (and the deleted actor is null too): %s', to_jsonb(r));
    DELETE FROM teams WHERE team_id = t;
    ASSERT NOT EXISTS (SELECT 1 FROM team_events WHERE team_id = t), 'deleting the team deletes its events and logs none';
    ASSERT NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = t), 'deleting the team deletes its members';
END $$;
SQL

run_case history_kinds_for_sharing_are_allowed_and_others_refused <<'SQL'
DO $$
DECLARE t uuid; k text;
BEGIN
    INSERT INTO teams (name) VALUES ('TM Kinds') RETURNING team_id INTO t;
    FOREACH k IN ARRAY ARRAY['shared','unshared','approved','declined','trust_set','trust_unset'] LOOP
        INSERT INTO team_events (team_id, kind, collection, record_id, detail)
        VALUES (t, k, 'physical_samples', gen_random_uuid(), '{"level":"view"}');
    END LOOP;
    BEGIN
        INSERT INTO team_events (team_id, kind) VALUES (t, 'exploded');
        RAISE EXCEPTION 'an unknown event kind was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
SQL

run_case audited_like_the_other_business_tables <<'SQL'
DO $$
DECLARE t uuid; p uuid;
BEGIN
    INSERT INTO people (full_name) VALUES ('TM Audit') RETURNING person_id INTO p;
    INSERT INTO teams (name) VALUES ('TM Audit team') RETURNING team_id INTO t;
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (t, p, true);
    ASSERT EXISTS (SELECT 1 FROM audit_logs WHERE table_name = 'teams' AND record_id = t::text AND action_type = 'INSERT'), 'teams is audited';
    ASSERT EXISTS (SELECT 1 FROM audit_logs WHERE table_name = 'team_members' AND record_id = t::text || ':' || p::text AND action_type = 'INSERT'),
        'team_members is audited, keyed by team and person';
    ASSERT NOT EXISTS (SELECT 1 FROM audit_logs WHERE table_name = 'team_events'), 'team_events is the history itself and is not audited';
END $$;
SQL

run_case directus_registration_and_lab_member_read_rows <<'SQL'
DO $$
DECLARE lm uuid := '20000002-0000-0000-0000-000000000002';
BEGIN
    ASSERT (SELECT count(*) FROM directus_collections WHERE collection IN ('teams', 'team_members', 'team_events') AND NOT hidden AND "group" = 'people') = 3,
        'the three collections are visible and grouped under People';
    ASSERT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'team_members' AND many_field = 'team_id' AND one_collection = 'teams' AND one_field = 'members'),
        'team_members.team_id -> teams with the alias members';
    ASSERT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'team_members' AND many_field = 'person_id' AND one_collection = 'people'), 'team_members.person_id -> people';
    ASSERT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = 'teams' AND many_field = 'logo' AND one_collection = 'directus_files'), 'teams.logo -> directus_files';
    ASSERT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'teams' AND field = 'members' AND special LIKE '%o2m%'), 'the members alias field is registered';
    ASSERT (SELECT string_agg(collection || ':' || action, ',' ORDER BY collection) FROM directus_permissions
             WHERE policy = lm AND collection IN ('teams', 'team_members', 'team_events')) = 'team_events:read,team_members:read,teams:read',
        'a Lab Member has read and only read on the three';
    ASSERT (SELECT bool_and(permissions::jsonb = '{}'::jsonb AND fields = '*') FROM directus_permissions
             WHERE policy = lm AND collection IN ('teams', 'team_members', 'team_events')), 'the read rows carry no filter';
END $$;
SQL

run_case not_granted_to_llm_role <<'SQL'
DO $$
DECLARE t text; f text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN RETURN; END IF;
    FOREACH t IN ARRAY ARRAY['public.teams', 'public.team_members', 'public.team_events'] LOOP
        ASSERT NOT has_table_privilege('d1_llm_readonly', t, 'SELECT'), format('%s must not be readable by d1_llm_readonly', t);
    END LOOP;
    FOREACH f IN ARRAY ARRAY['d1_private.team_actor_person()', 'd1_private.team_has_manager()', 'd1_private.teams_history()', 'd1_private.team_members_history()'] LOOP
        ASSERT NOT has_function_privilege('d1_llm_readonly', f, 'EXECUTE'), format('%s must not be executable by d1_llm_readonly', f);
    END LOOP;
END $$;
SQL

echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
