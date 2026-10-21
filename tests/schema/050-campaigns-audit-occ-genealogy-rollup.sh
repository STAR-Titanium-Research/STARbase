# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Campaigns layer (trials + testing campaigns) =="
run "campaigns table exists" \
    "SELECT to_regclass('public.campaigns')::TEXT"
run "manufacturing_operations.campaign_id column exists" \
    "SELECT column_name FROM information_schema.columns
     WHERE table_name='manufacturing_operations' AND column_name='campaign_id'"
run "test_sessions.campaign_id column exists" \
    "SELECT column_name FROM information_schema.columns
     WHERE table_name='test_sessions' AND column_name='campaign_id'"
run_eq "campaign_type CHECK restricts to the known kinds" \
    "SELECT count(*) FROM information_schema.check_constraints
     WHERE constraint_name LIKE '%campaign_type%'
       AND check_clause LIKE '%machining_trial%'
       AND check_clause LIKE '%testing_campaign%'" \
    "1"
# owner_person_id (062), campaign_samples.campaign_id (087) and created_by (20261001000124), plus the
# project_id link and the two campaign_id links of operations and tests that migration 141 registers
# for the row filters (ADR-0011), plus the campaign_access list (migration 165, alias `access`) and the owner_team_id link to teams (migration 183).
run_eq "Directus relations for campaigns are registered (9)" \
    "SELECT string_agg(many_collection || '.' || many_field || '->' || one_collection, ',' ORDER BY many_collection COLLATE \"C\", many_field COLLATE \"C\")
     FROM directus_relations
     WHERE one_collection='campaigns' OR many_collection='campaigns'
        OR (many_collection IN ('manufacturing_operations','test_sessions') AND many_field='campaign_id')" \
    "campaign_access.campaign_id->campaigns,campaign_readers.record_id->campaigns,campaign_samples.campaign_id->campaigns,campaigns.created_by->directus_users,campaigns.owner_person_id->people,campaigns.owner_team_id->teams,campaigns.project_id->projects,manufacturing_operations.campaign_id->campaigns,test_sessions.campaign_id->campaigns"

echo "== Audit trigger fires on INSERT =="
# Insert a test sample and verify audit_logs captured it.
$PSQL -c "
    INSERT INTO physical_samples (sample_code, current_status)
    VALUES ('TEST-AUDIT-001', 'active');
" > /dev/null 2>&1 || true
run "audit INSERT recorded" \
    "SELECT table_name FROM audit_logs
     WHERE table_name = 'physical_samples'
       AND action_type = 'INSERT'
       AND row_after->>'sample_code' = 'TEST-AUDIT-001'"

echo "== OCC trigger increments version on UPDATE =="
$PSQL -c "
    UPDATE physical_samples SET notes = 'occ-test' WHERE sample_code = 'TEST-AUDIT-001';
" > /dev/null 2>&1 || true
run_eq "OCC version = 2 after UPDATE" \
    "SELECT version FROM physical_samples WHERE sample_code = 'TEST-AUDIT-001'" \
    "2"

echo "== Audit immutability (NO UPDATE rule) =="
$PSQL -c "UPDATE audit_logs SET table_name = 'hacked' WHERE log_id = 1;" > /dev/null 2>&1 || true
run "audit_logs UPDATE is silently blocked" \
    "SELECT COUNT(*) FROM audit_logs WHERE table_name = 'hacked'" 2>/dev/null
# The rule makes UPDATE a no-op; table_name 'hacked' should not exist.

echo "== Self-referential genealogy =="
$PSQL -c "
    INSERT INTO physical_samples (sample_code, current_status)
    VALUES ('TEST-PARENT-001', 'consumed'),
           ('TEST-CHILD-001', 'active');
    INSERT INTO sample_genealogy (child_sample_id, parent_sample_id, relationship_type)
    SELECT c.sample_id, p.sample_id, 'cut_from'
    FROM physical_samples AS c, physical_samples AS p
    WHERE c.sample_code = 'TEST-CHILD-001'
      AND p.sample_code = 'TEST-PARENT-001';
" > /dev/null 2>&1 || true
run "genealogy insert roundtrips via view" \
    "SELECT child_sample_code FROM v_sample_genealogy_flat
     WHERE parent_sample_code = 'TEST-PARENT-001'"

echo "== project_rollup refresh survives concurrent writers (review 5.1) =="
# Two sessions updating DIFFERENT operations used to fail the second with a duplicate key on
# project_rollup_pkey. Session A holds its transaction open (after its refresh has run); B must
# queue on the advisory lock and then succeed.
$PSQL -c "
    INSERT INTO manufacturing_methods (method_id, method_code, method_name)
    VALUES ('c0000000-0000-4000-8000-0000000000a1', 'T-C-RL', 'rollup lock test method');
    INSERT INTO projects (project_id, project_code, project_name)
    VALUES ('c0000000-0000-4000-8000-0000000000b1', 'TCRL-1', 'rollup lock test');
    INSERT INTO physical_samples (sample_id, sample_code)
    VALUES ('c0000000-0000-4000-8000-0000000000d0', 'TEST-RL-001');
    INSERT INTO manufacturing_operations (operation_id, method_id, project_id, sample_id, pass_code) VALUES
        ('c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000d0', 'TCRL-OP-1'),
        ('c0000000-0000-4000-8000-0000000000c2', 'c0000000-0000-4000-8000-0000000000a1', 'c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000d0', 'TCRL-OP-2');
" > /dev/null 2>&1 || true
rl_a_log=$(mktemp); rl_b_log=$(mktemp)
psql "$DATABASE_URL" --no-psqlrc -q -v ON_ERROR_STOP=1 > "$rl_a_log" 2>&1 <<SQL &
BEGIN;
UPDATE manufacturing_operations SET outcome_notes = 'rl-a' WHERE operation_id = 'c0000000-0000-4000-8000-0000000000c1';
SELECT pg_sleep(3);
COMMIT;
SQL
rl_a_pid=$!
sleep 1
rl_b_start=$(date +%s)
$PSQL -v ON_ERROR_STOP=1 -c "UPDATE manufacturing_operations SET outcome_notes = 'rl-b' WHERE operation_id = 'c0000000-0000-4000-8000-0000000000c2'" > "$rl_b_log" 2>&1
rl_b_rc=$?
rl_b_secs=$(( $(date +%s) - rl_b_start ))
wait "$rl_a_pid"; rl_a_rc=$?
[[ $rl_a_rc -eq 0 ]] && ok "session A (held open) committed" || bad "session A failed: $(cat "$rl_a_log")"
[[ $rl_b_rc -eq 0 ]] && ok "session B (different operation) succeeded" || bad "session B failed: $(cat "$rl_b_log")"
[[ $rl_b_secs -ge 1 ]] && ok "session B queued behind A's refresh (${rl_b_secs}s)" || bad "session B did not wait for A (${rl_b_secs}s): the refresh is not serialised"
run_eq "both concurrent updates landed" \
    "SELECT string_agg(outcome_notes, ',' ORDER BY pass_code) FROM manufacturing_operations WHERE pass_code IN ('TCRL-OP-1','TCRL-OP-2')" \
    "rl-a,rl-b"
run_eq "project_rollup cache equals v_project_rollup after the race" \
    "SELECT (SELECT count(*) FROM project_rollup) = (SELECT count(*) FROM v_project_rollup)" "t"
rm -f "$rl_a_log" "$rl_b_log"
$PSQL -c "
    DELETE FROM manufacturing_operations WHERE operation_id IN ('c0000000-0000-4000-8000-0000000000c1','c0000000-0000-4000-8000-0000000000c2');
    DELETE FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-0000000000d0';
    DELETE FROM projects WHERE project_id = 'c0000000-0000-4000-8000-0000000000b1';
    DELETE FROM manufacturing_methods WHERE method_id = 'c0000000-0000-4000-8000-0000000000a1';
" > /dev/null 2>&1 || true

echo "== Denormalised views keep every operation and test session (review 5.2) =="
# Row parity between each view and its base table, including an operation that only has
# output_sample_id and a test session whose subject is not a sample (test_sessions_subject).
vp_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-0000000000a2', 'T-C-VP', 'view parity test method');
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-0000000000d1', 'TEST-VP-001');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code) VALUES
    ('c0000000-0000-4000-8000-0000000000c3', 'c0000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-0000000000d1', 'TEST-VP-OP-IN');
INSERT INTO manufacturing_operations (operation_id, method_id, output_sample_id, pass_code) VALUES
    ('c0000000-0000-4000-8000-0000000000c4', 'c0000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-0000000000d1', 'TEST-VP-OP-OUT');
INSERT INTO test_sessions (session_id, sample_id) VALUES
    ('c0000000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-0000000000d1');
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-0000000000e2');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-0000000000e2', 'tools', 'subject-only');
SELECT 'ops_parity:' || ((SELECT count(*) FROM v_manufacturing_operations_full) = (SELECT count(*) FROM manufacturing_operations));
SELECT 'ts_parity:' || ((SELECT count(*) FROM v_test_sessions_full) = (SELECT count(*) FROM test_sessions));
SELECT 'op_out_only_in_view:' || count(*) FROM v_manufacturing_operations_full WHERE pass_code = 'TEST-VP-OP-OUT' AND sample_id IS NULL;
SELECT 'ts_subject_only_in_view:' || count(*) FROM v_test_sessions_full WHERE session_id = 'c0000000-0000-4000-8000-0000000000e2' AND sample_code IS NULL;
SELECT 'ts_with_sample_code:' || sample_code FROM v_test_sessions_full WHERE session_id = 'c0000000-0000-4000-8000-0000000000e1';
ROLLBACK;
SQL
)
expect_line vp_out "ops_parity:true" "v_manufacturing_operations_full has one row per operation"
expect_line vp_out "ts_parity:true" "v_test_sessions_full has one row per test session"
expect_line vp_out "op_out_only_in_view:1" "operation with only output_sample_id is in the view"
expect_line vp_out "ts_subject_only_in_view:1" "subject-only test session is in the view"
expect_line vp_out "ts_with_sample_code:TEST-VP-001" "sample columns are still filled when there is a sample"

echo "== Audit trail hardening (review 5.7) =="
run_eq "audit_trigger_function pins search_path" \
    "SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = 'audit_trigger_function'" \
    "search_path=pg_catalog, public"
run_eq "no role but the owner holds TRUNCATE on audit_logs" \
    "SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.audit_logs'::regclass AND a.privilege_type = 'TRUNCATE' AND a.grantee <> c.relowner" \
    "0"
tr_out=$($PSQL 2>&1 <<SQL
TRUNCATE audit_logs;
SQL
)
grep -q 'append-only' <<<"$tr_out" && ok "TRUNCATE audit_logs is rejected (even for the owner)" || bad "TRUNCATE audit_logs was not rejected (output: $tr_out)"
run "audit_logs still has rows after the TRUNCATE attempt" "SELECT 1 FROM audit_logs LIMIT 1"
# A schema placed ahead of public on the search_path must not capture the audit insert.
sp_out=$($PSQL 2>&1 <<SQL
BEGIN;
CREATE SCHEMA tc_shadow;
CREATE TABLE tc_shadow.audit_logs (LIKE public.audit_logs);
SET LOCAL search_path = tc_shadow, public;
INSERT INTO public.physical_samples (sample_code) VALUES ('TEST-SHADOW-001');
SELECT 'shadow:' || count(*) FROM tc_shadow.audit_logs;
SELECT 'real:' || count(*) FROM public.audit_logs WHERE row_after->>'sample_code' = 'TEST-SHADOW-001';
ROLLBACK;
SQL
)
grep -qx 'shadow:0' <<<"$sp_out" && grep -qx 'real:1' <<<"$sp_out" \
    && ok "audit row lands in public.audit_logs despite a shadowing schema" \
    || bad "search_path shadowing captured the audit write (output: $sp_out)"
