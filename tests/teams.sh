#!/usr/bin/env bash
# Teams (People 2, Task 1, migration 20261014000175): the teams, team_members and team_events tables, the "a team keeps a manager" deferred
# constraint, the history triggers and the Directus registration. Team grants (Task 2, migration 20261014000176): a grant on a record expands
# into derived <type>_access rows for the team's members, joiners wait as pending rows unless the grant trusts new members, the guard on the
# derived rows, team_decide, team_pending_actionable (Ruling D2), team_drift, and the people-admin functions' team sources.
# Most cases run in BEGIN ... ROLLBACK on a COPY of the migrated database
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

# run_commit <name> <ok | error text the case must fail with> [SQLSTATE, default 23514]: the SQL of the case on stdin, run as it is (it carries its own BEGIN and COMMIT)
run_commit() {
  local name="$1" expect="$2" code="${3:-23514}" body out rc
  body=$(cat)
  out=$(printf '%s\n' "$body" | psql "$TM_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f - 2>&1); rc=$?
  if [[ "$expect" == ok ]]; then
    [[ $rc -eq 0 ]] && ok "$name" || bad "$name: expected the commit to succeed, got: $out"
  else
    if [[ $rc -ne 0 ]] && grep -qF -- "$expect" <<<"$out" && grep -qF -- "$code" <<<"$out"; then ok "$name"
    else bad "$name: expected $code '$expect', got (rc=$rc): $out"; fi
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

# --- two sessions: removing DIFFERENT managers of one team at the same time. Each commit-time check would see the other's manager still
# in place and pass, leaving a team without a manager; the check locks the team row, so the second waits and then sees the first's result.
# Session 1 runs its check early (SET CONSTRAINTS ALL IMMEDIATE: it passes, B is still a manager) and then keeps its transaction open for 3 s;
# session 2 starts 1 s later and commits at once. Without the lock both pass (session 2 still sees A as a manager, session 1 has already
# been judged) and the team ends with none; with it session 2 waits for session 1, then sees A demoted and is refused.
# Run in both orders (which manager each session removes): exactly one commit may succeed.
# conc_pair <label> <hex digit for the ids> <session 1 sql> <session 2 sql>   (@A@ and @B@ are the two managers)
conc_pair() {
  local label="$1" d="$2" s1="$3" s2="$4" team a b f1 f2 n e1 e2
  team="${d}b000000-0000-4000-8000-0000000000b1"; a="${d}a000000-0000-4000-8000-0000000000a1"; b="${d}a000000-0000-4000-8000-0000000000a2"
  s1="${s1//@A@/$a}"; s1="${s1//@B@/$b}"; s2="${s2//@A@/$a}"; s2="${s2//@B@/$b}"
  psql "$TM_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -c "
    INSERT INTO people (person_id, full_name) VALUES ('$a', 'TM C1 $label'), ('$b', 'TM C2 $label');
    INSERT INTO teams (team_id, name) VALUES ('$team', 'TM Concurrent $label');
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('$team', '$a', true), ('$team', '$b', true);" >/dev/null 2>&1 \
    || { bad "team_needs_a_manager (concurrent, $label): setup failed"; return; }
  f1=$(mktemp); f2=$(mktemp)
  ( psql "$TM_URL" --no-psqlrc -X -t -A -q -v VERBOSITY=verbose -c "BEGIN; $s1; SET CONSTRAINTS ALL IMMEDIATE; SELECT pg_sleep(3); COMMIT;" >"$f1" 2>&1 ) &
  sleep 1
  ( psql "$TM_URL" --no-psqlrc -X -t -A -q -v VERBOSITY=verbose -c "BEGIN; $s2; COMMIT;" >"$f2" 2>&1 ) &
  wait
  e1=$(grep -c '23514' "$f1"); e2=$(grep -c '23514' "$f2"); rm -f "$f1" "$f2"
  n=$(psql "$TM_URL" --no-psqlrc -X -t -A -q -c "SELECT count(*) FROM team_members WHERE team_id = '$team' AND is_manager")
  if [[ $((e1 + e2)) -eq 1 && "$n" -eq 1 ]]; then ok "team_needs_a_manager (two sessions, $label): exactly one of the two managers could go, $n manager left"
  else bad "team_needs_a_manager (two sessions, $label): $((e1 + e2)) of 2 commits refused and $n managers left (expected 1 and 1)"; fi
}
conc_pair demote_then_delete c \
  "UPDATE team_members SET is_manager = false WHERE person_id = '@A@'" \
  "DELETE FROM team_members WHERE person_id = '@B@'"
conc_pair delete_then_demote d \
  "DELETE FROM team_members WHERE person_id = '@B@'" \
  "UPDATE team_members SET is_manager = false WHERE person_id = '@A@'"

run_case team_member_is_unique_per_person <<'SQL'
DO $$
DECLARE t uuid; p uuid; m1 uuid; m2 uuid;
BEGIN
    INSERT INTO people (full_name) VALUES ('TM Unique') RETURNING person_id INTO p;
    INSERT INTO teams (name) VALUES ('TM Unique team') RETURNING team_id INTO t;
    INSERT INTO team_members (team_id, person_id) VALUES (t, p) RETURNING member_id INTO m1;
    ASSERT m1 IS NOT NULL, 'a membership has a surrogate key (member_id)';
    BEGIN
        INSERT INTO team_members (team_id, person_id) VALUES (t, p);
        RAISE EXCEPTION 'the same person was added to the same team twice';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    INSERT INTO team_members (team_id, person_id) VALUES (t, p) ON CONFLICT (team_id, person_id) DO NOTHING;
    ASSERT (SELECT count(*) FROM team_members WHERE team_id = t) = 1, 'ON CONFLICT (team_id, person_id) works';
    ASSERT (SELECT count(*) FROM pg_index i WHERE i.indrelid = 'team_members'::regclass AND i.indisprimary AND i.indnatts = 1) = 1, 'a single-column primary key (Directus)';
END $$;
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
    ASSERT EXISTS (SELECT 1 FROM audit_logs WHERE table_name = 'team_members' AND record_id = (SELECT member_id::text FROM team_members WHERE team_id = t AND person_id = p) AND action_type = 'INSERT'),
        'team_members is audited, keyed by member_id';
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
    ASSERT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'team_members' AND field = 'member_id' AND hidden), 'the surrogate key is registered and hidden';
    ASSERT (SELECT string_agg(collection || ':' || action, ',' ORDER BY collection) FROM directus_permissions
             WHERE policy = lm AND collection IN ('teams', 'team_members', 'team_events')) = 'team_events:read,team_members:read,teams:read',
        'a Lab Member has read and only read on the three';
    ASSERT (SELECT bool_and(permissions::jsonb = '{}'::jsonb AND fields = '*') FROM directus_permissions
             WHERE policy = lm AND collection IN ('teams', 'team_members', 'team_events')), 'the read rows carry no filter';
END $$;
SQL

run_commit "team_needs_a_manager: the check refuses to run outside READ COMMITTED" "needs READ COMMITTED" 0A000 <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ;
INSERT INTO people (person_id, full_name) VALUES ('7a000000-0000-4000-8000-000000000051', 'TM RR');
INSERT INTO teams (team_id, name) VALUES ('7b000000-0000-4000-8000-000000000051', 'TM Repeatable read');
INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('7b000000-0000-4000-8000-000000000051', '7a000000-0000-4000-8000-000000000051', true);
COMMIT;
SQL

# ------------------------------------------------------------------------------------------------------------------------------
# Team grants (migration 176). The shared fixture: an owner O, members A (manager) and B of team T, two more people C and D outside
# the team, every one with a login; a sample S owned by O and a Restricted sample R owned by O. The ids are in the temp table tf, read
# with pg_temp.tf(kind); pg_temp.rd(login, sample) says whether the login is in sample_readers for the sample.
# ------------------------------------------------------------------------------------------------------------------------------
read -r -d '' TEAM_FIXTURE <<'SQL'
CREATE TEMP TABLE tf (kind text PRIMARY KEY, id uuid);
CREATE FUNCTION pg_temp.tf(k text) RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT id FROM tf WHERE kind = k $f$;
CREATE FUNCTION pg_temp.rd(u uuid, s uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM sample_readers WHERE record_id = s AND user_id = u) $f$;
DO $$
DECLARE n text; u uuid; p uuid; t uuid; s uuid; r uuid; tag text := left(gen_random_uuid()::text, 8);
BEGIN
    FOREACH n IN ARRAY ARRAY['o', 'a', 'b', 'c', 'd'] LOOP
        u := gen_random_uuid();
        INSERT INTO directus_users (id, email, status) VALUES (u, 'tf-' || n || '-' || u || '@example.invalid', 'active');
        INSERT INTO people (full_name, user_id) VALUES ('TF ' || upper(n) || ' ' || tag, u) RETURNING person_id INTO p;
        INSERT INTO tf VALUES ('u' || n, u), ('p' || n, p);
    END LOOP;
    INSERT INTO teams (name) VALUES ('TF Team ' || tag) RETURNING team_id INTO t;
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (t, pg_temp.tf('pa'), true), (t, pg_temp.tf('pb'), false);
    INSERT INTO physical_samples (sample_code, owner_person_id) VALUES ('TF-S-' || tag, pg_temp.tf('po')) RETURNING sample_id INTO s;
    INSERT INTO physical_samples (sample_code, owner_person_id, restricted) VALUES ('TF-R-' || tag, pg_temp.tf('po'), true) RETURNING sample_id INTO r;
    INSERT INTO tf VALUES ('team', t), ('s', s), ('r', r);
END $$;
SQL

# run_case_fx <name>: run_case with the team fixture first (a here-string, not a pipe, so the pass/fail counters survive)
run_case_fx() { local rest; rest=$(cat); run_case "$1" <<<"$TEAM_FIXTURE"$'\n'"$rest"; }

echo "== Team grants: derived access rows, pending members, guard, drift =="

run_case_fx grant_creates_rows_for_members <<'SQL'
DO $$
DECLARE g uuid; r record; s uuid := pg_temp.tf('s');
BEGIN
    PERFORM set_config('d1.actor_identity', pg_temp.tf('uo')::text, true);
    ASSERT NOT pg_temp.rd(pg_temp.tf('ua'), s) AND NOT pg_temp.rd(pg_temp.tf('ub'), s), 'before: the members do not read the sample';
    INSERT INTO sample_team_access (sample_id, team_id, role, added_by_person_id) VALUES (s, pg_temp.tf('team'), 'view', pg_temp.tf('po'))
        RETURNING team_access_id INTO g;
    ASSERT (SELECT string_agg(a.person_id::text, ',' ORDER BY a.person_id) FROM sample_access a WHERE a.team_access_id = g)
         = (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[pg_temp.tf('pa'), pg_temp.tf('pb')]) x), 'one derived row per member';
    ASSERT (SELECT bool_and(a.sample_id = s AND a.role = 'view' AND a.added_by_person_id = pg_temp.tf('po')) FROM sample_access a WHERE a.team_access_id = g),
        'derived rows carry the record, the grant''s role and its adder';
    ASSERT pg_temp.rd(pg_temp.tf('ua'), s) AND pg_temp.rd(pg_temp.tf('ub'), s), 'sample_readers gains the members'' logins';
    ASSERT NOT pg_temp.rd(pg_temp.tf('uc'), s), 'a non-member does not';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE team_access_id = g), 'current members are never pending';
    SELECT * INTO r FROM team_events WHERE team_id = pg_temp.tf('team') AND kind = 'shared';
    ASSERT r.collection = 'physical_samples' AND r.record_id = s AND r.actor_person_id = pg_temp.tf('po') AND r.detail ->> 'level' = 'view',
        format('a shared event names the record, the actor and the level: %s', to_jsonb(r));
    BEGIN
        INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'edit');
        RAISE EXCEPTION 'a second grant of the same team on the same record was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (pg_temp.tf('r'), pg_temp.tf('team'), 'investigator');
        RAISE EXCEPTION 'a sample grant accepted the role investigator';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
SQL

run_case_fx join_without_trust_is_pending <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('s'); pc uuid := pg_temp.tf('pc');
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc);
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id = pc), 'no derived row for a joiner the grant does not trust';
    ASSERT (SELECT state FROM sample_team_pending WHERE team_access_id = g AND person_id = pc) = 'pending', 'a pending row instead';
    ASSERT NOT pg_temp.rd(pg_temp.tf('uc'), s), 'no readers row';
    ASSERT d1_private.team_pending_actionable('physical_samples', g, pc), 'approving would raise their access: actionable';
    ASSERT d1_private.team_drift_count() = 0, 'a pending member is not drift';
END $$;
SQL

run_case_fx join_with_trust_is_active <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('s'); pc uuid := pg_temp.tf('pc');
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role, trust_new_members) VALUES (s, pg_temp.tf('team'), 'edit', true) RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc);
    ASSERT (SELECT role FROM sample_access WHERE team_access_id = g AND person_id = pc) = 'edit', 'a trusted joiner gets a derived row at once';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE person_id = pc), 'and no pending row';
    ASSERT pg_temp.rd(pg_temp.tf('uc'), s) AND d1_private.s_editor(s, pg_temp.tf('uc')), 'they read and edit the sample';
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', g, pc), 'nothing pending: not actionable';
END $$;
SQL

run_case_fx approve_and_decline <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('r'); pc uuid := pg_temp.tf('pc'); pd uuid := pg_temp.tf('pd'); r record; ok boolean;
BEGIN
    PERFORM set_config('d1.actor_identity', pg_temp.tf('uo')::text, true);
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc), (pg_temp.tf('team'), pd);
    -- approve C
    PERFORM d1_private.team_decide('physical_samples', g, pc, 'approve');
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE team_access_id = g AND person_id = pc), 'approve removes the pending row';
    ASSERT (SELECT role FROM sample_access WHERE team_access_id = g AND person_id = pc) = 'view', 'approve adds the derived row';
    ASSERT pg_temp.rd(pg_temp.tf('uc'), s), 'and the readers row (a Restricted sample)';
    SELECT * INTO r FROM team_events WHERE team_id = pg_temp.tf('team') AND kind = 'approved';
    ASSERT r.person_id = pc AND r.collection = 'physical_samples' AND r.record_id = s AND r.actor_person_id = pg_temp.tf('po'), format('approved event: %s', to_jsonb(r));
    -- decline D
    PERFORM d1_private.team_decide('physical_samples', g, pd, 'decline');
    SELECT * INTO r FROM sample_team_pending WHERE team_access_id = g AND person_id = pd;
    ASSERT r.state = 'declined' AND r.decided_by_person_id = pg_temp.tf('po') AND r.decided_at IS NOT NULL, format('decline keeps a declined row: %s', to_jsonb(r));
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id = pd), 'no derived row';
    ASSERT NOT pg_temp.rd(pg_temp.tf('ud'), s), 'no readers row';
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', g, pd), 'declined: not actionable';
    ASSERT EXISTS (SELECT 1 FROM team_events WHERE team_id = pg_temp.tf('team') AND kind = 'declined' AND person_id = pd AND record_id = s), 'declined event';
    -- approve after decline
    PERFORM d1_private.team_decide('physical_samples', g, pd, 'approve');
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE team_access_id = g AND person_id = pd), 'approve after decline removes the declined row';
    ASSERT pg_temp.rd(pg_temp.tf('ud'), s), 'approve after decline gives access';
    -- nothing to decide: raises
    ok := false;
    BEGIN PERFORM d1_private.team_decide('physical_samples', g, pc, 'approve'); EXCEPTION WHEN no_data_found THEN ok := true; END;
    ASSERT ok, 'deciding with no pending or declined row raises no_data_found';
    ok := false;
    BEGIN PERFORM d1_private.team_decide('physical_samples', g, pd, 'maybe'); EXCEPTION WHEN invalid_parameter_value THEN ok := true; END;
    ASSERT ok, 'an unknown decision raises';
    ok := false;
    BEGIN PERFORM d1_private.team_decide('sample_access', g, pd, 'approve'); EXCEPTION WHEN invalid_parameter_value THEN ok := true; END;
    ASSERT ok, 'an unknown collection raises';
    ASSERT d1_private.team_drift_count() = 0, 'no drift';
END $$;
SQL

run_case_fx trust_turned_on_activates_pending_not_declined <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('s'); pc uuid := pg_temp.tf('pc'); pd uuid := pg_temp.tf('pd');
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc), (pg_temp.tf('team'), pd);
    PERFORM d1_private.team_decide('physical_samples', g, pd, 'decline');
    UPDATE sample_team_access SET trust_new_members = true WHERE team_access_id = g;
    ASSERT EXISTS (SELECT 1 FROM sample_access WHERE team_access_id = g AND person_id = pc) AND pg_temp.rd(pg_temp.tf('uc'), s), 'the pending member is now active';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE team_access_id = g AND person_id = pc), 'their pending row is gone';
    ASSERT (SELECT state FROM sample_team_pending WHERE team_access_id = g AND person_id = pd) = 'declined', 'the declined member stays declined';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id = pd) AND NOT pg_temp.rd(pg_temp.tf('ud'), s), 'and has no access';
    ASSERT EXISTS (SELECT 1 FROM team_events WHERE team_id = pg_temp.tf('team') AND kind = 'trust_set' AND record_id = s), 'trust_set event';
    UPDATE sample_team_access SET trust_new_members = false WHERE team_access_id = g;
    ASSERT EXISTS (SELECT 1 FROM team_events WHERE team_id = pg_temp.tf('team') AND kind = 'trust_unset' AND record_id = s), 'trust_unset event';
    ASSERT EXISTS (SELECT 1 FROM sample_access WHERE team_access_id = g AND person_id = pc), 'turning trust off changes nothing else';
    ASSERT (SELECT count(*) FROM sample_access WHERE team_access_id = g) = 3, 'A, B and C are active';
END $$;
SQL

run_case_fx role_change_follows_grant <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('s');
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    -- d1_private.s_editor is the SQL form of the Lab Member update rule on physical_samples (sample.editors: owner, co-owner, an edit entry)
    ASSERT NOT d1_private.s_editor(s, pg_temp.tf('ua')), 'Can view: no update rights';
    UPDATE sample_team_access SET role = 'edit' WHERE team_access_id = g;
    ASSERT (SELECT bool_and(role = 'edit') AND count(*) = 2 FROM sample_access WHERE team_access_id = g), 'every derived row is edit now';
    ASSERT d1_private.s_editor(s, pg_temp.tf('ua')) AND d1_private.s_editor(s, pg_temp.tf('ub')), 'Can edit: the members may update the sample';
    UPDATE sample_team_access SET role = 'view' WHERE team_access_id = g;
    ASSERT NOT d1_private.s_editor(s, pg_temp.tf('ua')), 'back to view';
    ASSERT d1_private.team_drift_count() = 0, 'no drift';
END $$;
SQL

run_case_fx leave_removes_access_and_readers <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('r'); pc uuid := pg_temp.tf('pc');
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'edit') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc);
    ASSERT pg_temp.rd(pg_temp.tf('ub'), s) AND d1_private.s_editor(s, pg_temp.tf('ub')), 'before: B reads and edits';
    DELETE FROM team_members WHERE team_id = pg_temp.tf('team') AND person_id IN (pg_temp.tf('pb'), pc);
    -- right after the statement: nothing else needed
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id IN (pg_temp.tf('pb'), pc)), 'the leavers'' derived rows are gone';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE person_id = pc), 'and their pending rows';
    ASSERT NOT pg_temp.rd(pg_temp.tf('ub'), s) AND NOT d1_private.s_editor(s, pg_temp.tf('ub')), 'B no longer reads or edits the Restricted sample';
    ASSERT pg_temp.rd(pg_temp.tf('ua'), s), 'A still does';
    ASSERT d1_private.team_drift_count() = 0, 'no drift';
END $$;
SQL

run_case_fx restricted_record_team_grant <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('r');
BEGIN
    ASSERT NOT pg_temp.rd(pg_temp.tf('ua'), s), 'before: a Restricted sample is not read by the team';
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    ASSERT pg_temp.rd(pg_temp.tf('ua'), s) AND pg_temp.rd(pg_temp.tf('ub'), s), 'active members read it';
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pg_temp.tf('pc'));
    ASSERT NOT pg_temp.rd(pg_temp.tf('uc'), s), 'a pending member does not';
    ASSERT NOT pg_temp.rd(pg_temp.tf('ud'), s), 'nor does anyone else';
    ASSERT d1_private.readers_drift_count() = 0, 'readers_drift is empty';
END $$;
SQL

run_case_fx derived_rows_are_guarded <<'SQL'
DO $$
DECLARE g uuid; g2 uuid; s uuid := pg_temp.tf('s'); s2 uuid; adder uuid; d uuid; ok boolean; msg text; st text;
BEGIN
    INSERT INTO people (full_name) VALUES ('TF Adder') RETURNING person_id INTO adder;
    INSERT INTO sample_team_access (sample_id, team_id, role, added_by_person_id) VALUES (s, pg_temp.tf('team'), 'view', adder) RETURNING team_access_id INTO g;
    SELECT access_id INTO d FROM sample_access WHERE team_access_id = g AND person_id = pg_temp.tf('pa');
    -- direct insert, update and delete of a derived row are refused
    ok := false;
    BEGIN
        INSERT INTO sample_access (sample_id, person_id, role, team_access_id) VALUES (s, pg_temp.tf('pc'), 'view', g);
    EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, st = RETURNED_SQLSTATE; ok := true;
    END;
    ASSERT ok AND st = '42501' AND msg = 'Team access rows are managed by the team''s grant', format('insert refused (%s %s)', st, msg);
    ok := false;
    BEGIN UPDATE sample_access SET role = 'edit' WHERE access_id = d; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
    ASSERT ok, 'update of a derived row refused';
    ok := false;
    BEGIN DELETE FROM sample_access WHERE access_id = d; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
    ASSERT ok, 'delete of a derived row refused';
    -- a direct row cannot be turned into a derived one; direct rows stay writable
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pg_temp.tf('pd'), 'view');
    ok := false;
    BEGIN UPDATE sample_access SET team_access_id = g WHERE sample_id = s AND person_id = pg_temp.tf('pd'); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
    ASSERT ok, 'setting team_access_id on a direct row refused';
    UPDATE sample_access SET role = 'edit' WHERE sample_id = s AND person_id = pg_temp.tf('pd') AND team_access_id IS NULL;
    DELETE FROM sample_access WHERE sample_id = s AND person_id = pg_temp.tf('pd') AND team_access_id IS NULL;
    -- cascades pass: the adder deleted (added_by_person_id SET NULL on the derived rows)
    DELETE FROM people WHERE person_id = adder;
    ASSERT (SELECT count(*) FROM sample_access WHERE team_access_id = g AND added_by_person_id IS NULL) = 2, 'the adder''s delete clears added_by on the derived rows';
    -- a member deleted as a person
    DELETE FROM people WHERE person_id = pg_temp.tf('pb');
    ASSERT (SELECT count(*) FROM sample_access WHERE team_access_id = g) = 1, 'a deleted person''s derived row goes';
    -- the record deleted
    INSERT INTO physical_samples (sample_code) VALUES ('TF-S2-' || left(g::text, 8)) RETURNING sample_id INTO s2;
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s2, pg_temp.tf('team'), 'edit') RETURNING team_access_id INTO g2;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pg_temp.tf('pc'));
    DELETE FROM physical_samples WHERE sample_id = s2;
    ASSERT NOT EXISTS (SELECT 1 FROM sample_team_access WHERE team_access_id = g2) AND NOT EXISTS (SELECT 1 FROM sample_access WHERE sample_id = s2)
       AND NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE team_access_id = g2), 'deleting the record removes its grant, derived and pending rows';
    -- the grant deleted
    DELETE FROM sample_team_access WHERE team_access_id = g;
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE team_access_id = g) AND NOT EXISTS (SELECT 1 FROM sample_team_pending WHERE team_access_id = g),
        'deleting the grant removes its derived and pending rows';
    ASSERT EXISTS (SELECT 1 FROM team_events WHERE team_id = pg_temp.tf('team') AND kind = 'unshared' AND record_id = s), 'unshared event';
    -- the team deleted
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    DELETE FROM teams WHERE team_id = pg_temp.tf('team');
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE team_access_id IS NOT NULL AND sample_id = s), 'deleting the team removes its grants and derived rows';
    ASSERT d1_private.readers_drift_count() = 0 AND d1_private.team_drift_count() = 0, 'no drift';
END $$;
SQL

run_case_fx direct_and_team_rows_coexist <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('r'); pa uuid := pg_temp.tf('pa'); ua uuid := pg_temp.tf('ua');
BEGIN
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pa, 'view');
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'edit') RETURNING team_access_id INTO g;
    ASSERT (SELECT string_agg(role || ':' || (team_access_id IS NOT NULL), ',' ORDER BY role) FROM sample_access WHERE sample_id = s AND person_id = pa) = 'edit:true,view:false',
        'two rows: the direct view row and the team edit row';
    BEGIN
        INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pa, 'edit');
        RAISE EXCEPTION 'a second direct row for the same person was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pa, 'edit') ON CONFLICT (sample_id, person_id) WHERE team_access_id IS NULL DO UPDATE SET role = 'view';
    ASSERT (SELECT count(*) FROM sample_access WHERE sample_id = s AND person_id = pa) = 2, 'the upsert on the direct row works and leaves the team row alone';
    DELETE FROM sample_access WHERE sample_id = s AND person_id = pa AND team_access_id IS NULL;
    ASSERT pg_temp.rd(ua, s) AND d1_private.s_editor(s, ua), 'without the direct row the team row still gives read and edit';
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pa, 'view');
    DELETE FROM sample_team_access WHERE team_access_id = g;
    ASSERT pg_temp.rd(ua, s) AND NOT d1_private.s_editor(s, ua), 'without the team row the direct view row still gives read, not edit';
    ASSERT (SELECT count(*) FROM sample_access WHERE sample_id = s AND person_id = pa) = 1, 'one row left';
END $$;
SQL

run_case_fx team_drift_is_empty_and_detects <<'SQL'
DO $$
DECLARE g uuid; s uuid := pg_temp.tf('s'); probs text;
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pg_temp.tf('pc'));
    ASSERT d1_private.team_drift_count() = 0, 'healthy: empty';
    -- break it behind the bookkeeping (with the flag the triggers use)
    PERFORM set_config('d1.team_sync', 'on', true);
    DELETE FROM sample_access WHERE team_access_id = g AND person_id = pg_temp.tf('pa');
    UPDATE sample_access SET role = 'edit' WHERE team_access_id = g AND person_id = pg_temp.tf('pb');
    INSERT INTO sample_access (sample_id, person_id, role, team_access_id) VALUES (s, pg_temp.tf('pd'), 'view', g);
    PERFORM set_config('d1.team_sync', '', true);
    SELECT string_agg(collection || '/' || (team_access_id = g) || '/' || (CASE person_id WHEN pg_temp.tf('pa') THEN 'a' WHEN pg_temp.tf('pb') THEN 'b' WHEN pg_temp.tf('pd') THEN 'd' ELSE '?' END) || '/' || problem, ',' ORDER BY problem)
      INTO probs FROM d1_private.team_drift();
    ASSERT probs = 'physical_samples/true/d/extra,physical_samples/true/a/missing,physical_samples/true/b/role', format('drift found: %s', probs);
END $$;
SQL

run_case_fx actionable_rule_D2 <<'SQL'
DO $$
DECLARE t2 uuid; g uuid; ge uuid; s uuid := pg_temp.tf('s'); pc uuid := pg_temp.tf('pc'); pd uuid := pg_temp.tf('pd'); po uuid := pg_temp.tf('po'); pi uuid; pj uuid;
BEGIN
    -- view grant: C already reads the sample (a direct view row), D does not
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pc, 'view');
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc), (pg_temp.tf('team'), pd);
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', g, pc), 'view grant to someone who already reads it: not actionable';
    ASSERT d1_private.team_pending_actionable('physical_samples', g, pd), 'view grant to someone who does not: actionable';
    -- edit grant: the owner, a co-owner and an edit row holder gain nothing; a view row holder does gain
    INSERT INTO teams (name) VALUES ('TF Team 2 ' || left(g::text, 8)) RETURNING team_id INTO t2;
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (t2, pg_temp.tf('pa'), true);
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, t2, 'edit') RETURNING team_access_id INTO ge;
    INSERT INTO team_members (team_id, person_id) VALUES (t2, po), (t2, pc), (t2, pd), (t2, pg_temp.tf('pb'));
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', ge, po), 'edit grant to the owner: not actionable';
    ASSERT d1_private.team_pending_actionable('physical_samples', ge, pc), 'edit grant to a Can view person: actionable';
    UPDATE sample_access SET role = 'edit' WHERE sample_id = s AND person_id = pc AND team_access_id IS NULL;
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', ge, pc), 'edit grant to a Can edit person: not actionable';
    INSERT INTO sample_co_owners (sample_id, user_id) VALUES (s, pg_temp.tf('ud'));
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', ge, pd), 'edit grant to a co-owner: not actionable';
    -- B has a derived row through the first team: view gives nothing towards edit, an edit-level derived row does
    ASSERT d1_private.team_pending_actionable('physical_samples', ge, pg_temp.tf('pb')), 'B has only view through team 1: actionable';
    UPDATE sample_team_access SET role = 'edit' WHERE team_access_id = g;
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', ge, pg_temp.tf('pb')), 'B has edit through team 1: not actionable';
    -- declined is never actionable; an active member is not either
    PERFORM d1_private.team_decide('physical_samples', g, pd, 'decline');
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', g, pd), 'declined: not actionable';
    ASSERT NOT d1_private.team_pending_actionable('physical_samples', g, pg_temp.tf('pa')), 'an active member: not actionable';
    -- the PI of the record's project is not an editor of the sample under the Lab Member rules (Ruling D2a): an edit grant raises them
    INSERT INTO people (full_name) VALUES ('TF PI') RETURNING person_id INTO pi;
    INSERT INTO projects (project_code, project_name, principal_investigator_person) VALUES ('TF-PI-' || left(ge::text, 8), 'TF PI project', pi) RETURNING project_id INTO pj;
    INSERT INTO team_members (team_id, person_id) VALUES (t2, pi);
    UPDATE physical_samples SET project_id = pj WHERE sample_id = s;
    ASSERT d1_private.team_pending_actionable('physical_samples', ge, pi), 'edit grant to the PI of the sample''s project: actionable (the PI does not edit it)';
END $$;
SQL

# Ruling D2b: an investigator grant is broader than view; only the project's PI or an investigator of it gains nothing
run_case_fx actionable_rule_D2_investigator <<'SQL'
DO $$
DECLARE pj uuid; g uuid; t2 uuid; pc uuid := pg_temp.tf('pc'); pd uuid := pg_temp.tf('pd'); po uuid := pg_temp.tf('po'); pb uuid := pg_temp.tf('pb');
        pa uuid := pg_temp.tf('pa'); tag text := left(gen_random_uuid()::text, 8);
BEGIN
    INSERT INTO projects (project_code, project_name, principal_investigator_person) VALUES ('TF-INV-' || tag, 'TF inv project', po) RETURNING project_id INTO pj;
    -- B is an investigator through another team (a derived row); C a reader only (a view entry); D an old project_investigators row
    INSERT INTO teams (name) VALUES ('TF Inv team ' || tag) RETURNING team_id INTO t2;
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (t2, pb, true);
    INSERT INTO project_team_access (project_id, team_id, role) VALUES (pj, t2, 'investigator');
    INSERT INTO project_access (project_id, person_id, role) VALUES (pj, pc, 'view');
    INSERT INTO project_investigators (project_id, user_id) VALUES (pj, pg_temp.tf('ud'));
    ASSERT EXISTS (SELECT 1 FROM project_readers WHERE record_id = pj AND user_id = pg_temp.tf('uc')), 'C reads the project';
    -- the team under test: A (manager, active at grant time); the others join afterwards and wait
    INSERT INTO project_team_access (project_id, team_id, role) VALUES (pj, pg_temp.tf('team'), 'investigator') RETURNING team_access_id INTO g;
    DELETE FROM team_members WHERE team_id = pg_temp.tf('team') AND person_id = pb;
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), po), (pg_temp.tf('team'), pb), (pg_temp.tf('team'), pc), (pg_temp.tf('team'), pd);
    ASSERT d1_private.team_pending_actionable('projects', g, pc), 'investigator grant to a mere reader: actionable';
    ASSERT NOT d1_private.team_pending_actionable('projects', g, po), 'investigator grant to the PI: not actionable';
    ASSERT NOT d1_private.team_pending_actionable('projects', g, pb), 'investigator grant to an investigator through another team: not actionable';
    ASSERT NOT d1_private.team_pending_actionable('projects', g, pd), 'investigator grant to an old project_investigators row: not actionable';
    UPDATE project_access SET role = 'investigator' WHERE project_id = pj AND person_id = pc AND team_access_id IS NULL;
    ASSERT NOT d1_private.team_pending_actionable('projects', g, pc), 'investigator grant to someone with their own investigator entry: not actionable';
END $$;
SQL

run_case_fx moved_member_is_pending_on_untrusting_grant <<'SQL'
DO $$
DECLARE t2 uuid; g uuid; s uuid := pg_temp.tf('r'); pc uuid := pg_temp.tf('pc'); pd uuid := pg_temp.tf('pd');
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'edit') RETURNING team_access_id INTO g;
    INSERT INTO teams (name) VALUES ('TF Elsewhere ' || left(g::text, 8)) RETURNING team_id INTO t2;
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES (t2, pc, true), (t2, pd, false);
    -- moved by an UPDATE of team_id into the team whose grant does not trust new members
    UPDATE team_members SET team_id = pg_temp.tf('team') WHERE team_id = t2 AND person_id = pc;
    ASSERT (SELECT state FROM sample_team_pending WHERE team_access_id = g AND person_id = pc) = 'pending', 'the moved member is pending';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id = pc) AND NOT pg_temp.rd(pg_temp.tf('uc'), s), 'and not active';
    -- an active member's row handed to another person (an UPDATE of person_id): B leaves, D arrives pending
    ASSERT pg_temp.rd(pg_temp.tf('ub'), s), 'before: B is active';
    UPDATE team_members SET person_id = pd WHERE team_id = pg_temp.tf('team') AND person_id = pg_temp.tf('pb');
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id = pg_temp.tf('pb')) AND NOT pg_temp.rd(pg_temp.tf('ub'), s), 'the person taken out leaves';
    ASSERT (SELECT state FROM sample_team_pending WHERE team_access_id = g AND person_id = pd) = 'pending', 'the person put in is pending';
    ASSERT NOT EXISTS (SELECT 1 FROM sample_access WHERE person_id = pd) AND NOT pg_temp.rd(pg_temp.tf('ud'), s), 'and not active';
    ASSERT d1_private.team_drift_count() = 0, 'no drift';
END $$;
SQL

run_case_fx guard_refuses_trigger_inserts <<'SQL'
-- a trigger (depth 2) that writes a derived row is not a foreign-key cascade: refused, like a direct write
CREATE FUNCTION pg_temp.sneak() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
    IF NEW.what = 'insert' THEN
        INSERT INTO sample_access (sample_id, person_id, role, team_access_id) VALUES (pg_temp.tf('s'), pg_temp.tf('pd'), 'edit', NEW.ta);
    ELSE
        UPDATE sample_access SET team_access_id = NEW.ta WHERE sample_id = pg_temp.tf('s') AND person_id = pg_temp.tf('pd') AND team_access_id IS NULL;
    END IF;
    RETURN NULL;
END $f$;
CREATE TEMP TABLE sneak (what text, ta uuid);
CREATE TRIGGER sneak AFTER INSERT ON sneak FOR EACH ROW EXECUTE FUNCTION pg_temp.sneak();
DO $$
DECLARE g uuid; ok boolean;
BEGIN
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (pg_temp.tf('s'), pg_temp.tf('team'), 'view') RETURNING team_access_id INTO g;
    ok := false;
    BEGIN INSERT INTO sneak VALUES ('insert', g); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
    ASSERT ok, 'an insert of a derived row from inside a trigger is refused';
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (pg_temp.tf('s'), pg_temp.tf('pd'), 'view');
    ok := false;
    BEGIN INSERT INTO sneak VALUES ('update', g); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
    ASSERT ok, 'turning an own entry into a derived row from inside a trigger is refused';
END $$;
SQL

run_case_fx person_access_sources <<'SQL'
DO $$
DECLARE g uuid; gp uuid; s uuid := pg_temp.tf('s'); pa uuid := pg_temp.tf('pa'); pc uuid := pg_temp.tf('pc'); pj uuid; r record; tname text;
BEGIN
    SELECT name INTO tname FROM teams WHERE team_id = pg_temp.tf('team');
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (pg_temp.tf('r'), pa, 'view');
    INSERT INTO sample_team_access (sample_id, team_id, role) VALUES (s, pg_temp.tf('team'), 'edit') RETURNING team_access_id INTO g;
    INSERT INTO projects (project_code, project_name) VALUES ('TF-P-' || left(g::text, 8), 'TF project') RETURNING project_id INTO pj;
    INSERT INTO project_team_access (project_id, team_id, role) VALUES (pj, pg_temp.tf('team'), 'investigator') RETURNING team_access_id INTO gp;
    SELECT * INTO r FROM d1_private.person_access(pa);
    ASSERT r.shared = 1 AND r.teams = 2 AND r.investigator = 0 AND r.owns = 0 AND r.waiting = 0, format('A: shared 1 (direct), teams 2 (sample edit, project investigator), got %s', to_jsonb(r));
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.person_access_list(pa, 'shared') WHERE record_id = s), 'derived rows are not shared rows';
    SELECT * INTO r FROM d1_private.person_access_list(pa, 'teams') WHERE record_id = s;
    ASSERT r.collection = 'physical_samples' AND r.level = 'edit' AND r.source = 'team' AND r.granted_by = tname AND r.added_at IS NOT NULL, format('the team row: %s', to_jsonb(r));
    SELECT * INTO r FROM d1_private.person_access_list(pa, 'teams') WHERE record_id = pj;
    ASSERT r.collection = 'projects' AND r.level = 'investigator' AND r.source = 'team', format('the project team row: %s', to_jsonb(r));
    -- waiting: C joins, pending on both grants, both actionable
    INSERT INTO team_members (team_id, person_id) VALUES (pg_temp.tf('team'), pc);
    SELECT * INTO r FROM d1_private.person_access(pc);
    ASSERT r.waiting = 2 AND r.teams = 0, format('C waits on two grants, got %s', to_jsonb(r));
    PERFORM d1_private.team_decide('projects', gp, pc, 'decline');
    INSERT INTO sample_access (sample_id, person_id, role) VALUES (s, pc, 'edit');
    SELECT * INTO r FROM d1_private.person_access(pc);
    ASSERT r.waiting = 0 AND r.shared = 1, format('declined and no-longer-actionable rows do not wait, got %s', to_jsonb(r));
END $$;
SQL

run_case_fx former_in_team_attention <<'SQL'
DO $$
DECLARE got record;
BEGIN
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'former_in_team' AND pg_temp.tf('pb') = ANY (person_ids)), 'B is current: not listed';
    UPDATE people SET active = false WHERE person_id = pg_temp.tf('pb');
    SELECT * INTO got FROM d1_private.people_attention() WHERE key = 'former_in_team';
    ASSERT pg_temp.tf('pb') = ANY (got.person_ids) AND pg_temp.tf('ub') = ANY (got.user_ids), format('a former person still in a team is listed with their login: %s', to_jsonb(got));
    UPDATE people SET active = false WHERE person_id = pg_temp.tf('pc');
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'former_in_team' AND pg_temp.tf('pc') = ANY (person_ids)), 'a former person in no team is not';
    DELETE FROM team_members WHERE person_id = pg_temp.tf('pb');
    ASSERT NOT EXISTS (SELECT 1 FROM d1_private.people_attention() WHERE key = 'former_in_team' AND pg_temp.tf('pb') = ANY (person_ids)), 'removed from the team: not listed';
END $$;
SQL

run_case_fx every_record_type_expands <<'SQL'
DO $$
DECLARE pj uuid; c uuid; o uuid; ts uuid; t2 uuid; tag text := left(gen_random_uuid()::text, 8); t uuid := pg_temp.tf('team');
BEGIN
    INSERT INTO projects (project_code, project_name, restricted) VALUES ('TF-PJ-' || tag, 'TF project', true) RETURNING project_id INTO pj;
    INSERT INTO campaigns (campaign_type, name, restricted) VALUES ('testing_campaign', 'TF campaign', true) RETURNING campaign_id INTO c;
    INSERT INTO manufacturing_operations (method_id, source_system, restricted) VALUES ((SELECT method_id FROM manufacturing_methods ORDER BY method_id LIMIT 1), 'tf_test', true) RETURNING operation_id INTO o;
    INSERT INTO test_sessions (test_type, restricted) VALUES ('hardness', true) RETURNING session_id INTO ts;
    INSERT INTO project_team_access (project_id, team_id, role) VALUES (pj, t, 'investigator');
    INSERT INTO campaign_team_access (campaign_id, team_id, role) VALUES (c, t, 'edit');
    INSERT INTO operation_team_access (operation_id, team_id, role) VALUES (o, t, 'view');
    INSERT INTO test_team_access (session_id, team_id, role, trust_new_members) VALUES (ts, t, 'edit', true);
    ASSERT (SELECT count(*) FROM project_access WHERE project_id = pj AND role = 'investigator' AND team_access_id IS NOT NULL) = 2, 'project rows';
    ASSERT (SELECT count(*) FROM campaign_access WHERE campaign_id = c AND role = 'edit' AND team_access_id IS NOT NULL) = 2, 'campaign rows';
    ASSERT (SELECT count(*) FROM operation_access WHERE operation_id = o AND team_access_id IS NOT NULL) = 2, 'operation rows';
    ASSERT (SELECT count(*) FROM test_access WHERE session_id = ts AND team_access_id IS NOT NULL) = 2, 'test rows';
    ASSERT EXISTS (SELECT 1 FROM project_readers WHERE record_id = pj AND user_id = pg_temp.tf('ua'))
       AND EXISTS (SELECT 1 FROM campaign_readers WHERE record_id = c AND user_id = pg_temp.tf('ua'))
       AND EXISTS (SELECT 1 FROM operation_readers WHERE record_id = o AND user_id = pg_temp.tf('ua'))
       AND EXISTS (SELECT 1 FROM test_readers WHERE record_id = ts AND user_id = pg_temp.tf('ua')), 'A reads all four Restricted records';
    INSERT INTO team_members (team_id, person_id) VALUES (t, pg_temp.tf('pc'));
    ASSERT (SELECT count(*) FROM project_team_pending WHERE person_id = pg_temp.tf('pc')) = 1
       AND (SELECT count(*) FROM campaign_team_pending WHERE person_id = pg_temp.tf('pc')) = 1
       AND (SELECT count(*) FROM operation_team_pending WHERE person_id = pg_temp.tf('pc')) = 1
       AND (SELECT count(*) FROM test_team_pending WHERE person_id = pg_temp.tf('pc')) = 0
       AND EXISTS (SELECT 1 FROM test_access WHERE session_id = ts AND person_id = pg_temp.tf('pc')), 'C is pending on three grants and active on the trusting one';
    PERFORM d1_private.team_decide('manufacturing_operations', (SELECT team_access_id FROM operation_team_access WHERE operation_id = o), pg_temp.tf('pc'), 'approve');
    PERFORM d1_private.team_decide('campaigns', (SELECT team_access_id FROM campaign_team_access WHERE campaign_id = c), pg_temp.tf('pc'), 'approve');
    PERFORM d1_private.team_decide('projects', (SELECT team_access_id FROM project_team_access WHERE project_id = pj), pg_temp.tf('pc'), 'approve');
    ASSERT EXISTS (SELECT 1 FROM operation_readers WHERE record_id = o AND user_id = pg_temp.tf('uc'))
       AND EXISTS (SELECT 1 FROM campaign_readers WHERE record_id = c AND user_id = pg_temp.tf('uc'))
       AND EXISTS (SELECT 1 FROM project_readers WHERE record_id = pj AND user_id = pg_temp.tf('uc')), 'approved on every type';
    -- a member moved to another team (an UPDATE of team_id) leaves this team's grants
    INSERT INTO teams (name) VALUES ('TF Other ' || tag) RETURNING team_id INTO t2;
    UPDATE team_members SET team_id = t2 WHERE team_id = t AND person_id = pg_temp.tf('pb');
    ASSERT NOT EXISTS (SELECT 1 FROM project_access WHERE person_id = pg_temp.tf('pb') AND project_id = pj), 'the moved member leaves the old team''s grants';
    ASSERT d1_private.readers_drift_count() = 0 AND d1_private.team_drift_count() = 0, 'no drift';
END $$;
SQL

# --- two sessions: a team grant added while a member joins. Each side's trigger reads what the other writes (the grant reads the members,
# the joiner the grants); without a common lock each misses the other's uncommitted row and the joiner ends with neither a derived nor a
# pending row (team_drift: missing). Session 1 holds its transaction open for 3 s, session 2 starts 1 s later. Both orders.
# conc_team <label> <hex digit for the ids> <session 1 sql> <session 2 sql> <expected "pending/derived" rows of the joiner>
conc_team() {
  local label="$1" d="$2" s1="$3" s2="$4" want="$5" team m x s f1 f2 got drift
  team="${d}b000000-0000-4000-8000-0000000000c1"; m="${d}a000000-0000-4000-8000-0000000000c1"; x="${d}a000000-0000-4000-8000-0000000000c2"
  s="${d}c000000-0000-4000-8000-0000000000c1"
  s1="${s1//@T@/$team}"; s1="${s1//@X@/$x}"; s1="${s1//@S@/$s}"; s2="${s2//@T@/$team}"; s2="${s2//@X@/$x}"; s2="${s2//@S@/$s}"
  psql "$TM_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -c "
    INSERT INTO people (person_id, full_name) VALUES ('$m', 'TM G1 $label'), ('$x', 'TM G2 $label');
    INSERT INTO teams (team_id, name) VALUES ('$team', 'TM Grant race $label');
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('$team', '$m', true);
    INSERT INTO physical_samples (sample_id, sample_code) VALUES ('$s', 'TM-RACE-$label');" >/dev/null 2>&1 \
    || { bad "team grant and joiner (two sessions, $label): setup failed"; return; }
  f1=$(mktemp); f2=$(mktemp)
  ( psql "$TM_URL" --no-psqlrc -X -t -A -q -c "BEGIN; $s1; SELECT pg_sleep(3); COMMIT;" >"$f1" 2>&1 ) &
  sleep 1
  ( psql "$TM_URL" --no-psqlrc -X -t -A -q -c "BEGIN; $s2; COMMIT;" >"$f2" 2>&1 ) &
  wait
  rm -f "$f1" "$f2"
  got=$(psql "$TM_URL" --no-psqlrc -X -t -A -q -c "SELECT (SELECT count(*) FROM sample_team_pending WHERE person_id = '$x') || '/' || (SELECT count(*) FROM sample_access WHERE person_id = '$x')")
  drift=$(psql "$TM_URL" --no-psqlrc -X -t -A -q -c "SELECT d1_private.team_drift_count()")
  if [[ "$got" == "$want" && "$drift" == 0 ]]; then ok "team grant and joiner (two sessions, $label): the joiner is $([[ $want == 1/0 ]] && echo pending || echo in), no drift"
  else bad "team grant and joiner (two sessions, $label): joiner pending/derived rows $got (expected $want), team_drift $drift"; fi
}
conc_team grant_then_join e \
  "INSERT INTO sample_team_access (sample_id, team_id, role) VALUES ('@S@', '@T@', 'view')" \
  "INSERT INTO team_members (team_id, person_id) VALUES ('@T@', '@X@')" "1/0"
conc_team join_then_grant f \
  "INSERT INTO team_members (team_id, person_id) VALUES ('@T@', '@X@')" \
  "INSERT INTO sample_team_access (sample_id, team_id, role) VALUES ('@S@', '@T@', 'view')" "0/1"

# --- two sessions: the lock order. Session 1 holds the readers lock (any write to physical_samples takes it first) and 2 s later links a login to
# person X (people.user_id is unique, so the update locks X's row FOR UPDATE); session 2 adds X to a team in between. Without the BEFORE STATEMENT
# readers lock on team_members, session 2's foreign-key check takes KEY SHARE on X and then waits for the readers lock: a deadlock (40P01). With it,
# session 2 waits for the readers lock before it locks any row, and both commit.
lock_order_case() {
  local d=9 team m x u f1 f2 o1 o2 got
  team="${d}b000000-0000-4000-8000-0000000000d1"; m="${d}a000000-0000-4000-8000-0000000000d1"; x="${d}a000000-0000-4000-8000-0000000000d2"
  u="${d}d000000-0000-4000-8000-0000000000d1"
  psql "$TM_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -c "
    INSERT INTO people (person_id, full_name) VALUES ('$m', 'TM L1'), ('$x', 'TM L2');
    INSERT INTO directus_users (id, email, status) VALUES ('$u', 'tm-lock-$u@example.invalid', 'active');
    INSERT INTO teams (team_id, name) VALUES ('$team', 'TM Lock order');
    INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('$team', '$m', true);" >/dev/null 2>&1 \
    || { bad "lock order (two sessions): setup failed"; return; }
  f1=$(mktemp); f2=$(mktemp)
  ( psql "$TM_URL" --no-psqlrc -X -t -A -q -v ON_ERROR_STOP=1 -c "BEGIN; UPDATE physical_samples SET restricted = restricted WHERE false; SELECT pg_sleep(2); UPDATE people SET user_id = '$u' WHERE person_id = '$x'; COMMIT;" >"$f1" 2>&1 ) &
  sleep 1
  ( psql "$TM_URL" --no-psqlrc -X -t -A -q -v ON_ERROR_STOP=1 -c "BEGIN; INSERT INTO team_members (team_id, person_id) VALUES ('$team', '$x'); COMMIT;" >"$f2" 2>&1 ) &
  wait
  o1=$(cat "$f1"); o2=$(cat "$f2"); rm -f "$f1" "$f2"
  got=$(psql "$TM_URL" --no-psqlrc -X -t -A -q -c "SELECT (SELECT count(*) FROM team_members WHERE team_id = '$team' AND person_id = '$x') || '/' || (SELECT count(*) FROM people WHERE person_id = '$x' AND user_id = '$u')")
  if [[ "$got" == "1/1" ]] && ! grep -qi 'deadlock' <<<"$o1$o2"; then ok "lock order (two sessions): a member added while the person's login is linked under the readers lock: both commit, no deadlock"
  else bad "lock order (two sessions): member/login committed $got (expected 1/1); session 1: $o1; session 2: $o2"; fi
}
lock_order_case

run_case not_granted_to_llm_role <<'SQL'
DO $$
DECLARE t text; f text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN RETURN; END IF;
    FOREACH t IN ARRAY ARRAY['public.teams', 'public.team_members', 'public.team_events',
                             'public.sample_team_access', 'public.operation_team_access', 'public.test_team_access', 'public.campaign_team_access', 'public.project_team_access',
                             'public.sample_team_pending', 'public.operation_team_pending', 'public.test_team_pending', 'public.campaign_team_pending', 'public.project_team_pending'] LOOP
        ASSERT NOT has_table_privilege('d1_llm_readonly', t, 'SELECT'), format('%s must not be readable by d1_llm_readonly', t);
    END LOOP;
    FOREACH f IN ARRAY ARRAY['d1_private.team_actor_person()', 'd1_private.team_has_manager()', 'd1_private.teams_history()', 'd1_private.team_members_history()',
                             'd1_private.team_decide(text, uuid, uuid, text)', 'd1_private.team_pending_actionable(text, uuid, uuid)', 'd1_private.team_drift()',
                             'd1_private.team_drift_count()', 'd1_private.team_grant_sync()', 'd1_private.team_member_sync()', 'd1_private.team_access_guard()',
                             'd1_private.team_lock()', 'd1_private.team_kinds()', 'd1_private.team_readers_lock()'] LOOP
        ASSERT NOT has_function_privilege('d1_llm_readonly', f, 'EXECUTE'), format('%s must not be executable by d1_llm_readonly', f);
    END LOOP;
END $$;
SQL

echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
