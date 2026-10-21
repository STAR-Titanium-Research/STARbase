# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== physical_samples.co_owners is free for the M2M alias (ADR-0011) =="
# The legacy TEXT column is renamed so that `co_owners._some.user_id` in a permission filter can
# only mean the sample_co_owners junction. Run the migration's down then up in a rolled-back
# transaction, with a legacy value seeded to prove the data survives both renames.
CO=$(migration physical_samples_co_owners_legacy)
co_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$CO")
co_down=$(awk '/-- migrate:down/{f=1;next}f' "$CO")
run_eq "no real column named co_owners is left on physical_samples" \
    "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='physical_samples' AND column_name='co_owners'" "0"
run_eq "the legacy TEXT column is co_owners_legacy and has a comment" \
    "SELECT count(*) FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='physical_samples' AND c.column_name='co_owners_legacy' AND c.data_type='text' AND col_description('public.physical_samples'::regclass, c.ordinal_position) IS NOT NULL" "1"
co_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_code, co_owners_legacy) VALUES ('TEST-CO-001', 'a@example.org');
$co_down
SELECT 'dn_col:' || count(*) FROM information_schema.columns WHERE table_name='physical_samples' AND column_name='co_owners';
SELECT 'dn_val:' || co_owners FROM physical_samples WHERE sample_code='TEST-CO-001';
SELECT 'dn_meta:' || count(*) FROM directus_fields WHERE collection='physical_samples' AND field='co_owners_legacy';
$co_up
SELECT 'up_col:' || count(*) FROM information_schema.columns WHERE table_name='physical_samples' AND column_name='co_owners';
SELECT 'up_val:' || co_owners_legacy FROM physical_samples WHERE sample_code='TEST-CO-001';
SELECT 'up_meta:' || hidden || '/' || readonly FROM directus_fields WHERE collection='physical_samples' AND field='co_owners_legacy';
$co_up
SELECT 'up_idempotent:' || count(*) FROM directus_fields WHERE collection='physical_samples' AND field='co_owners_legacy';
SELECT 'views_ok:' || count(*) FROM v_complete_sample_history WHERE sample_code='TEST-CO-001';
ROLLBACK;
SQL
)
expect_line co_out "dn_col:1" "down: the TEXT column is called co_owners again"
expect_line co_out "dn_val:a@example.org" "down: the legacy value survives"
expect_line co_out "dn_meta:0" "down: the hidden Directus field row is removed"
expect_line co_out "up_col:0" "up: co_owners is renamed away"
expect_line co_out "up_val:a@example.org" "up: the legacy value survives"
expect_line co_out "up_meta:true/true" "up: the legacy column is hidden and read-only in Directus"
expect_line co_out "up_idempotent:1" "up is idempotent (one Directus field row)"
expect_line co_out "views_ok:1" "views over physical_samples still work after the rename"

echo "== Lab Member row-level visibility (ADR-0011) =="
# CI has no live Directus, so the stored permission JSON is what can be tested: the Lab Member rows
# must carry exactly the filters scripts/gen_access_rules.py generates from scripts/access_rules.json.
LM=20000002-0000-0000-0000-000000000002
rules_json=$(python3 scripts/gen_access_rules.py --json)
python3 scripts/gen_access_rules.py --check >/dev/null 2>&1 \
    && ok "configure_users_and_policies.sql and the d1-access-guard rules.json carry the generated rules (no drift from access_rules.json)" \
    || bad "configure_users_and_policies.sql or d1-access-guard/rules.json differs from access_rules.json (run gen_access_rules.py --write)"
rl_out=$($PSQL 2>&1 <<SQL
CREATE TEMP TABLE _gen AS
  SELECT * FROM json_to_recordset(\$rules\$$rules_json\$rules\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, ruled boolean);
SELECT 'generated:' || count(*) FROM _gen WHERE ruled;
SELECT 'exact:' || count(*) FROM _gen g JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = g.collection AND p.action = g.action
 AND p.permissions::jsonb = g.permissions AND p.validation::jsonb = g.validation AND p.fields = g.fields
 WHERE g.ruled;
SELECT 'filtered_rows:' || count(*) FROM _gen WHERE ruled AND permissions <> '{}'::jsonb;
SELECT 'stray:' || count(*) FROM directus_permissions p
 WHERE p.policy = '$LM' AND p.permissions::jsonb <> '{}'::jsonb
   AND NOT EXISTS (SELECT 1 FROM _gen g WHERE g.collection = p.collection AND g.action = p.action
                   AND g.permissions = p.permissions::jsonb);
-- A Lab Member grant that access_rules.json does not list would vanish the next time
-- configure_users_and_policies.sql runs (it deletes and re-inserts the policy's rows).
SELECT 'unlisted:' || count(*) FROM directus_permissions p
 WHERE p.policy = '$LM'
   AND NOT EXISTS (SELECT 1 FROM _gen g WHERE g.collection = p.collection AND g.action = p.action);
SELECT 'reference_filtered:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND permissions::jsonb <> '{}'::jsonb
   AND NOT (collection = 'people' AND action = 'update')  -- migration 169: a member updates only their own People row
   AND collection IN ('materials','material_iso_classifications','alloying_elements','material_alloying_elements',
                      'equipment','tools','tool_boxes','cutting_inserts','insert_edges','insert_types',
                      'raw_stock_lots','manufacturing_methods','people','facilities','fast_recipes');
SELECT 'ref_in_rules:' || count(*) FROM _gen WHERE ruled AND collection IN ('materials','equipment','raw_stock_lots');
SELECT 'audit_logs_rows:' || count(*) FROM directus_permissions WHERE policy = '$LM' AND collection = 'audit_logs';
SELECT 'people_actions:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions WHERE policy = '$LM' AND collection = 'people';
SELECT 'people_update_fields:' || fields FROM directus_permissions WHERE policy = '$LM' AND collection = 'people' AND action = 'update';
SELECT 'people_create_validation:' || (validation::jsonb = '{"_or":[{"user_id":{"_null":true}},{"user_id":{"_eq":"\$CURRENT_USER"}}]}'::jsonb)
  FROM directus_permissions WHERE policy = '$LM' AND collection = 'people' AND action = 'create';
-- people.update lists its fields, so a column added later is not editable until someone decides:
-- the columns left out are exactly the key, the login, the legacy id and the timestamp.
SELECT 'people_columns_left_out:' || string_agg(c.column_name, ',' ORDER BY c.column_name)
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'people'
   AND c.column_name <> ALL (string_to_array((SELECT fields FROM directus_permissions
        WHERE policy = '$LM' AND collection = 'people' AND action = 'update'), ','));
-- people.create lists its fields too (migration 194): a member may not set the inbox alias columns on a new person row.
SELECT 'people_create_columns_left_out:' || coalesce(string_agg(c.column_name, ',' ORDER BY c.column_name), '')
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'people'
   AND c.column_name <> ALL (string_to_array((SELECT fields FROM directus_permissions
        WHERE policy = '$LM' AND collection = 'people' AND action = 'create'), ','));
-- directus_files.create and .update list their fields too (migration 196, ADR-0022): a member may not set or change the provenance owner columns.
SELECT 'files_create_columns_left_out:' || coalesce(string_agg(c.column_name, ',' ORDER BY c.column_name), '')
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'directus_files'
   AND c.column_name <> ALL (string_to_array((SELECT fields FROM directus_permissions
        WHERE policy = '$LM' AND collection = 'directus_files' AND action = 'create'), ','));
SELECT 'files_update_columns_left_out:' || coalesce(string_agg(c.column_name, ',' ORDER BY c.column_name), '')
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'directus_files'
   AND c.column_name <> ALL (string_to_array((SELECT fields FROM directus_permissions
        WHERE policy = '$LM' AND collection = 'directus_files' AND action = 'update'), ','));
-- read visibility is the readers tables: one membership test per record type, the amnesty leaf for operations, one bare hop for children
SELECT 'read_membership:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action = 'read' AND collection IN ('physical_samples','test_sessions','campaigns','projects','campaign_samples')
   AND permissions::jsonb = '{"readers":{"_some":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb;
SELECT 'ops_read_amnesty:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'manufacturing_operations' AND action = 'read'
   AND permissions::jsonb = '{"_or":[{"readers":{"_some":{"user_id":{"_eq":"\$CURRENT_USER"}}}},{"open_to_all":{"_some":{"record_id":{"_nnull":true}}}}]}'::jsonb;
SELECT 'child_one_hop:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action = 'read'
   AND permissions::jsonb IN ('{"operation_id":{"readers":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb, '{"session_id":{"readers":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb,
                              '{"sample_id":{"readers":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb, '{"project_id":{"readers":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb,
                              '{"test_sessions_id":{"readers":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb);
SELECT 'update_delete_no_some:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action IN ('update','delete') AND permissions::text LIKE '%_some%';
SELECT 'readers_tables_read:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action = 'read' AND collection IN ('sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers')
   AND permissions::jsonb = '{"user_id":{"_eq":"\$CURRENT_USER"}}'::jsonb AND fields = '*';
SELECT 'open_set_read:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action = 'read' AND collection = 'operation_open_to_all' AND permissions::jsonb = '{}'::jsonb;
SELECT 'readers_tables_write:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action <> 'read' AND collection IN ('sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all');
SELECT 'access_tables_read:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action = 'read' AND collection IN ('sample_access','operation_access','test_access','campaign_access','project_access')
   AND permissions::jsonb = '{"person_id":{"user_id":{"_eq":"\$CURRENT_USER"}}}'::jsonb;
SELECT 'access_tables_write:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND action <> 'read' AND collection IN ('sample_access','operation_access','test_access','campaign_access','project_access');
SELECT 'params_tables_present:' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
  ('machining_params','sintering_params','heat_treatment_params','deformation_params','am_params','tensile_test_params',
   'hardness_test_params','charpy_test_params','compression_test_params','sem_params','xrd_params');
SELECT 'co_owner_rows_owner_only:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'sample_co_owners' AND action IN ('update','delete')
   AND permissions::jsonb = '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"\$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"\$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["manage"]}}}}]}]}'::jsonb;
SELECT 'rollup_read:' || permissions::text FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'project_rollup' AND action = 'read';
SELECT 'people_update_own_row:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'people' AND action = 'update'
   AND permissions::jsonb = '{"user_id":{"_eq":"\$CURRENT_USER"}}'::jsonb;
SQL
)
gen_n=$(grep -o '^generated:[0-9]*' <<<"$rl_out" | cut -d: -f2)
[[ "${gen_n:-0}" -gt 40 ]] && expect_fixed rl_out "exact:$gen_n" "every ruled Lab Member row carries exactly the generated permissions, validation and fields ($gen_n rows)" \
    || bad "the generator produced too few rules (psql output: $rl_out)"
expect_fixed rl_out "stray:0" "no Lab Member row carries a filter that access_rules.json does not generate"
expect_fixed rl_out "unlisted:0" "every Lab Member (collection, action) row in the database is listed in access_rules.json"
expect_fixed rl_out "access_tables_read:5" "Lab Member reads the five access tables for the rows about themselves"
expect_fixed rl_out "access_tables_write:0" "Lab Member has no create, update or delete grant on any access table (only the record-access endpoint writes them)"
expect_fixed rl_out "params_tables_present:0" "the eleven *_params tables are gone (migration 20260623000032), so there is nothing to rule; access_rules.json keeps their stale grants only for these drift checks"
expect_fixed rl_out "co_owner_rows_owner_only:2" "sample_co_owners update and delete are owner-only (the person owner, or a manager of the owning team)"
expect_fixed rl_out "reference_filtered:0" "reference data and people (but its own-row update) stay unfiltered (directus_files is filtered since migration 196, ADR-0022; checked in its own section)"
expect_fixed rl_out "ref_in_rules:0" "materials, equipment and raw_stock_lots have no rules"
expect_fixed rl_out "audit_logs_rows:0" "Lab Member has no grant on audit_logs (admins only)"
expect_fixed rl_out "people_update_own_row:1" "Lab Member updates only their own People row (migration 169: people.user_id = \$CURRENT_USER); create and read stay open"
expect_fixed rl_out "people_actions:create,read,update" "Lab Member can create, read and update people but not delete them"
expect_fixed rl_out "people_update_fields:full_name,email,is_operator,is_researcher,active,notes" "Lab Member cannot update people.user_id (no relink takeover)"
expect_fixed rl_out "people_create_validation:true" "a Lab Member can only create a People row with no login or their own"
expect_fixed rl_out "people_columns_left_out:created_at,legacy_machine_operator_id,person_id,scan_while_former,uni_alias,user_id" "people.update leaves out exactly the key, the login, the legacy id, the timestamp and the inbox alias columns (migration 193: administrators only)"
expect_fixed rl_out "people_create_columns_left_out:scan_while_former,uni_alias" "people.create leaves out exactly the inbox alias columns (migration 194: a member cannot squat a uni alias or switch on scan_while_former; administrators only)"
expect_fixed rl_out "files_create_columns_left_out:owner_person_id,owner_team_id" "directus_files.create leaves out exactly the two provenance owner columns (migration 196: only an administrator stamps or changes an owner)"
expect_fixed rl_out "files_update_columns_left_out:owner_person_id,owner_team_id" "directus_files.update leaves out exactly the two provenance owner columns (migration 196)"
expect_fixed rl_out "read_membership:5" "samples, tests, campaigns, projects and campaign_samples read through ONE membership test on their readers table"
expect_fixed rl_out "ops_read_amnesty:1" "operations read through the readers table OR the open_to_all leaf (the narrowed amnesty)"
expect_fixed rl_out "child_one_hop:11" "every child of a record reads through one bare hop to its parent's readers (11 collections)"
expect_fixed rl_out "update_delete_no_some:0" "no update or delete filter contains a _some (a legal _some would apply the readers table's own rule for the action)"
expect_fixed rl_out "readers_tables_read:6" "Lab Member reads the six readers tables for their own rows only (user_id = the caller)"
expect_fixed rl_out "open_set_read:1" "Lab Member reads operation_open_to_all without a filter"
expect_fixed rl_out "readers_tables_write:0" "Lab Member has no create, update or delete grant on any readers table (only the recompute triggers write them)"
expect_fixed rl_out 'rollup_read:{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"project_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"project_id":{"access":{"role":{"_in":["investigator"]}}}}]}]}]}]}' \
    "project_rollup: the project's PI reads every row, an investigator (old table or access role investigator) only restricted = false rows"
for idx in idx_physical_samples_owner_person_id idx_physical_samples_project_id \
    idx_manufacturing_operations_owner_person_id idx_manufacturing_operations_project_id \
    idx_test_sessions_owner_person_id idx_test_sessions_project_id idx_campaigns_owner_person_id \
    idx_projects_principal_investigator_person idx_project_investigators_user_id idx_sample_co_owners_user_id
do
    run "index $idx exists" "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='$idx'"
done

# d1-access-guard "created in this transaction" proof (ADR-0011): xmin = pg_current_xact_id() alone also
# matches a pre-existing row merely UPDATED in the transaction (FK action, trigger, the request itself),
# which would let a member attach themselves to someone else's record. The guard adds `version = 1`
# (inserted here and never updated). Every guarded parent must therefore carry the OCC version column
# and its trigger, and the exact SQL the guard sends must tell "inserted here" from "updated here".
guard_sql="xmin = pg_current_xact_id()::xid AND version = 1"
grep -qF "$guard_sql" core/extensions/d1-access-guard/index.js \
    && ok "d1-access-guard sends the 'inserted here and never updated' proof this test exercises" \
    || bad "d1-access-guard/index.js no longer contains: $guard_sql (update this test with it)"
guard_parents=$(python3 -c "import json;print(' '.join(sorted({c['parent'] for v in json.load(open('core/extensions/d1-access-guard/rules.json'))['guards'].values() for c in v})))")
[[ "$guard_parents" == "campaigns physical_samples projects test_sessions" ]] \
    && ok "the guarded parents are exactly campaigns, physical_samples, projects and test_sessions" \
    || bad "d1-access-guard now guards another parent ($guard_parents): give it a version column or fail it closed, and extend this test"
run_eq "every guarded parent has the OCC version column" \
    "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='version' AND data_type='integer' AND table_name IN ('campaigns','physical_samples','projects','test_sessions')" "4"
run_eq "every guarded parent has its OCC trigger (version rises on every update)" \
    "SELECT count(*) FROM pg_trigger WHERE tgfoid='occ_update_trigger_function'::regproc AND NOT tgisinternal AND tgrelid IN ('campaigns'::regclass,'physical_samples'::regclass,'projects'::regclass,'test_sessions'::regclass)" "4"
XP=c0000000-0000-4000-8000-00000000f0
# The "existing" parents are committed first (a transaction cannot be both old and new), then removed.
$PSQL -q >/dev/null 2>&1 <<SQL
INSERT INTO projects (project_id, project_code, project_name) VALUES ('${XP}01', 'ZZ-XMIN-OLD', 'xmin probe (pre-existing)');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${XP}02', 'XMIN-OLD-S');
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name) VALUES ('${XP}03', '${XP}01', 'testing_campaign', 'xmin old campaign');
INSERT INTO test_sessions (session_id) VALUES ('${XP}04');
SQL
xmin_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- parents inserted by this transaction
INSERT INTO projects (project_id, project_code, project_name) VALUES ('${XP}11', 'ZZ-XMIN-NEW', 'xmin probe (new)');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${XP}12', 'XMIN-NEW-S');
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name) VALUES ('${XP}13', '${XP}01', 'testing_campaign', 'xmin new campaign');
INSERT INTO test_sessions (session_id) VALUES ('${XP}14');
SELECT 'old_before_update:' || (SELECT count(*) FROM projects WHERE project_id='${XP}01' AND xmin = pg_current_xact_id()::xid AND version = 1);
-- pre-existing parents updated by this transaction (same xmin as ours, version raised by the OCC trigger)
UPDATE projects SET project_name = 'touched' WHERE project_id = '${XP}01';
UPDATE physical_samples SET notes = 'touched' WHERE sample_id = '${XP}02';
UPDATE campaigns SET name = 'touched' WHERE campaign_id = '${XP}03';
UPDATE test_sessions SET notes = 'touched' WHERE session_id = '${XP}04';
SELECT 'updated_here_xmin_alone:' || (
    (SELECT count(*) FROM projects WHERE project_id='${XP}01' AND xmin = pg_current_xact_id()::xid)
  + (SELECT count(*) FROM physical_samples WHERE sample_id='${XP}02' AND xmin = pg_current_xact_id()::xid)
  + (SELECT count(*) FROM campaigns WHERE campaign_id='${XP}03' AND xmin = pg_current_xact_id()::xid)
  + (SELECT count(*) FROM test_sessions WHERE session_id='${XP}04' AND xmin = pg_current_xact_id()::xid));
SELECT 'updated_here_guard:' || (
    (SELECT count(*) FROM projects WHERE project_id='${XP}01' AND $guard_sql)
  + (SELECT count(*) FROM physical_samples WHERE sample_id='${XP}02' AND $guard_sql)
  + (SELECT count(*) FROM campaigns WHERE campaign_id='${XP}03' AND $guard_sql)
  + (SELECT count(*) FROM test_sessions WHERE session_id='${XP}04' AND $guard_sql));
SELECT 'inserted_here_guard:' || (
    (SELECT count(*) FROM projects WHERE project_id='${XP}11' AND $guard_sql)
  + (SELECT count(*) FROM physical_samples WHERE sample_id='${XP}12' AND $guard_sql)
  + (SELECT count(*) FROM campaigns WHERE campaign_id='${XP}13' AND $guard_sql)
  + (SELECT count(*) FROM test_sessions WHERE session_id='${XP}14' AND $guard_sql));
-- a new row that is then updated in the same transaction no longer qualifies either (fails closed)
UPDATE projects SET project_name = 'touched' WHERE project_id = '${XP}11';
SELECT 'inserted_then_updated_guard:' || count(*) FROM projects WHERE project_id='${XP}11' AND $guard_sql;
ROLLBACK;
SQL
)
$PSQL -q >/dev/null 2>&1 <<SQL
DELETE FROM test_sessions WHERE session_id = '${XP}04';
DELETE FROM campaigns WHERE campaign_id = '${XP}03';
DELETE FROM physical_samples WHERE sample_id = '${XP}02';
DELETE FROM projects WHERE project_id = '${XP}01';
SQL
expect_fixed xmin_out "old_before_update:0" "a pre-existing parent is not 'created here' (xmin differs)"
expect_fixed xmin_out "updated_here_xmin_alone:4" "xmin alone matches all four pre-existing parents once updated in the transaction (why version = 1 is needed)"
expect_fixed xmin_out "updated_here_guard:0" "the guard's proof refuses a pre-existing parent updated in the same transaction (samples, tests, campaigns, projects)"
expect_fixed xmin_out "inserted_here_guard:4" "the guard's proof accepts a parent inserted by the transaction (samples, tests, campaigns, projects)"
expect_fixed xmin_out "inserted_then_updated_guard:0" "a parent inserted and then updated in the same transaction is refused (fails closed)"

# Every path of every rule must resolve against the Directus metadata: a filter on owner_person_id.user_id
# silently stops working when directus_relations loses the owner_person_id -> people row. Checked on the
# metadata the migrations leave (A) and on what the configure_*.sql scripts leave (B: they run in
# configure_all.sh order, in one transaction that is rolled back; each script's own BEGIN/COMMIT is dropped).
RES_DIR=$(mktemp -d)
dump_metadata_sql="SELECT json_build_object(
  'relations', (SELECT coalesce(json_agg(json_build_array(many_collection, many_field, one_collection, one_field)), '[]'::json) FROM directus_relations),
  'columns', (SELECT coalesce(json_agg(table_name || '.' || column_name), '[]'::json) FROM information_schema.columns WHERE table_schema = 'public'),
  'fields', (SELECT coalesce(json_agg(collection || '.' || field), '[]'::json) FROM directus_fields));"
$PSQL -c "$dump_metadata_sql" > "$RES_DIR/a.json" 2>/dev/null
res_a=$(python3 scripts/gen_access_rules.py --resolve "$RES_DIR/a.json" 2>&1) \
    && ok "every rule path resolves in the migrated Directus metadata" \
    || bad "a rule path does not resolve after the migrations: $res_a"
cfg_files=$(sed -n '/^FILES=(/,/^)/p' scripts/configure_all.sh | grep -o '[a-z_]*\.sql')
[[ $(wc -w <<<"$cfg_files") -ge 7 ]] && ok "found the configure scripts in scripts/configure_all.sh ($(wc -w <<<"$cfg_files") files)" \
    || bad "could not read the FILES list of scripts/configure_all.sh"
{
    echo "BEGIN;"
    # the person pickers migration 062 registered, as the migrations leave them (compared after the scripts)
    echo "CREATE TEMP TABLE people_pickers AS SELECT collection, field, special, interface, options::text AS options, display, display_options::text AS display_options, readonly, hidden, sort, width, required, translations::text AS translations FROM directus_fields WHERE field IN ('owner_person_id','operator_person_id','principal_investigator_person');"
    # the record access metadata of migration 165 as the migrations leave it (compared after the scripts)
    echo "CREATE TEMP TABLE ra_rel AS SELECT many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action FROM directus_relations WHERE many_collection IN ('sample_access','operation_access','test_access','campaign_access','project_access');"
    echo "CREATE TEMP TABLE ra_fld AS SELECT collection, field, special, interface, options::text AS options, display, readonly, hidden, sort, width, note FROM directus_fields WHERE field IN ('access','restricted') AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects');"
    for f in $cfg_files; do sed -E '/^(BEGIN|COMMIT);[[:space:]]*$/d' "scripts/$f"; done
    echo '\t on'
    echo '\a'
    echo "\\o $RES_DIR/b.json"
    echo "$dump_metadata_sql"
    echo '\o'
    echo "SELECT 'b_legacy_field:' || hidden || '/' || readonly FROM directus_fields WHERE collection = 'physical_samples' AND field = 'co_owners_legacy';"
    echo "SELECT 'b_project_aliases:' || string_agg(field, ',' ORDER BY field) FROM directus_fields WHERE collection = 'projects' AND field IN ('samples','operations','sessions');"
    echo "SELECT 'b_pickers_before:' || count(*) FROM people_pickers;"
    echo "SELECT 'b_pickers_changed:' || count(*) FROM (SELECT * FROM people_pickers EXCEPT SELECT collection, field, special, interface, options::text, display, display_options::text, readonly, hidden, sort, width, required, translations::text FROM directus_fields) x;"
    echo "SELECT 'b_picker_relations_lost:' || count(*) FROM (SELECT collection, field FROM people_pickers EXCEPT SELECT many_collection, many_field FROM directus_relations WHERE one_collection = 'people') x;"
    echo "SELECT 'b_legacy_visible:' || count(*) FROM directus_fields WHERE NOT hidden AND ((collection, field) IN (('physical_samples','owner'),('manufacturing_operations','owner'),('test_sessions','owner'),('campaigns','owner'),('etchants','owner'),('prep_recipes','owner'),('tool_boxes','owner'),('cutting_inserts','owner'),('insert_edges','owner'),('manufacturing_operations','operator'),('test_sessions','operator')));"
    echo "SELECT 'b_access_rel_before:' || count(*) FROM ra_rel;"
    echo "SELECT 'b_access_rel_changed:' || count(*) FROM ((SELECT * FROM ra_rel EXCEPT SELECT many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action FROM directus_relations WHERE many_collection IN ('sample_access','operation_access','test_access','campaign_access','project_access')) UNION ALL (SELECT many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action FROM directus_relations WHERE many_collection IN ('sample_access','operation_access','test_access','campaign_access','project_access') EXCEPT SELECT * FROM ra_rel)) x;"
    echo "SELECT 'b_access_fld_before:' || count(*) FROM ra_fld;"
    echo "SELECT 'b_access_fld_changed:' || count(*) FROM ((SELECT * FROM ra_fld EXCEPT SELECT collection, field, special, interface, options::text, display, readonly, hidden, sort, width, note FROM directus_fields WHERE field IN ('access','restricted') AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects')) UNION ALL (SELECT collection, field, special, interface, options::text, display, readonly, hidden, sort, width, note FROM directus_fields WHERE field IN ('access','restricted') AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects') EXCEPT SELECT * FROM ra_fld)) x;"
    echo "SELECT 'b_access_aliases:' || string_agg(r.one_collection, ',' ORDER BY r.one_collection) FROM directus_relations r JOIN directus_fields f ON f.collection = r.one_collection AND f.field = 'access' WHERE r.one_field = 'access' AND f.hidden AND f.special = 'o2m';"
    echo "SELECT 'b_restricted_fields:' || count(*) FROM directus_fields WHERE field = 'restricted' AND hidden AND readonly AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects');"
    echo "ROLLBACK;"
} > "$RES_DIR/configure.sql"
cfg_out=$(psql "$DATABASE_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -f "$RES_DIR/configure.sql" 2>&1 | grep '^b_')
res_b=$(python3 scripts/gen_access_rules.py --resolve "$RES_DIR/b.json" 2>&1) \
    && ok "every rule path still resolves after the configure scripts have run (Lab Member reads survive configure_all.sh)" \
    || bad "the configure scripts leave a rule path unresolved: $res_b"
grep -qxF "b_legacy_field:true/true" <<<"$cfg_out" && ok "configure_directus.sql re-adds the hidden co_owners_legacy field row" \
    || bad "configure_directus.sql does not re-add the co_owners_legacy field row (output: $cfg_out)"
grep -qxF "b_project_aliases:operations,samples,sessions" <<<"$cfg_out" && ok "configure_directus.sql keeps the hidden projects.samples, operations and sessions aliases" \
    || bad "configure_directus.sql loses a projects alias (output: $cfg_out)"
# The Owner / Operator / PI pickers (m2o -> people, migration 062) must survive the scripts, which delete
# the field rows of these collections; otherwise the forms fall back to a raw UUID input.
grep -qxF "b_pickers_before:14" <<<"$cfg_out" && ok "the migrations leave 14 person picker field rows (owner, operator and PI, and the owner of batches and of surface scans)" \
    || bad "expected 14 owner_person_id/operator_person_id/principal_investigator_person field rows after the migrations (output: $cfg_out)"
grep -qxF "b_pickers_changed:0" <<<"$cfg_out" && ok "the configure scripts keep every person picker field row, with migration 062's interface, options, display, width, sort and translations" \
    || bad "a configure script drops or changes a person picker field row (output: $cfg_out)"
grep -qxF "b_picker_relations_lost:0" <<<"$cfg_out" && ok "the configure scripts keep a relation to people for every person picker" \
    || bad "a configure script drops the people relation of a person picker (output: $cfg_out)"
grep -qxF "b_legacy_visible:0" <<<"$cfg_out" && ok "the legacy owner and operator backup columns stay hidden after the configure scripts" \
    || bad "a configure script makes a legacy owner/operator column visible again (output: $cfg_out)"
grep -qxF "b_access_rel_before:10" <<<"$cfg_out" && ok "the migrations leave 10 record access relations (5 parent links with alias access, 5 person links)" \
    || bad "expected 10 relations on the five access tables after the migrations (output: $cfg_out)"
grep -qxF "b_access_rel_changed:0" <<<"$cfg_out" && ok "the configure scripts keep every record access relation exactly as migration 165 leaves it" \
    || bad "a configure script drops or changes a record access relation (output: $cfg_out)"
grep -qxF "b_access_fld_before:10" <<<"$cfg_out" && ok "the migrations leave 10 record access field rows (5 access aliases, 5 restricted)" \
    || bad "expected 10 access/restricted field rows after the migrations (output: $cfg_out)"
grep -qxF "b_access_fld_changed:0" <<<"$cfg_out" && ok "the configure scripts keep every access alias and restricted field row exactly as migration 165 leaves it" \
    || bad "a configure script drops or changes an access alias or restricted field row (output: $cfg_out)"
grep -qxF "b_access_aliases:campaigns,manufacturing_operations,physical_samples,projects,test_sessions" <<<"$cfg_out" && ok "after the configure scripts every record type still has a hidden o2m access alias over its relation" \
    || bad "an access alias is missing after the configure scripts (output: $cfg_out)"
grep -qxF "b_restricted_fields:5" <<<"$cfg_out" && ok "after the configure scripts the five restricted fields are still hidden and read-only" \
    || bad "a restricted field is missing, visible or writable after the configure scripts (output: $cfg_out)"
rm -rf "$RES_DIR"

# The migration itself. Down first (to the real pre-migration state), then seed what the old script
# left: unfiltered rows, a NULL-permission row, a hand-added campaigns row, a hand-narrowed field
# list, the audit_logs grant, the four people rows, an unrelated row, another policy's row; delete
# some relations the way the configure scripts did. Run up twice, assert, run down, and assert the
# Lab Member rows are back exactly (ids included). ROLLBACK.
RV=$(migration lab_member_row_visibility)
rv_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RV")
rv_down=$(awk '/-- migrate:down/{f=1;next}f' "$RV")
# 20261010000160 runs after this migration on every database: its backup table is in d1_private too
# (so this migration's down only empties the schema once 160 is down), and it moves this migration's
# snapshot filters onto the current generator's output (no `_some` where Directus rejects it).
SF=$(migration lab_member_some_only_where_directus_accepts_it)
sf_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$SF")
sf_down=$(awk '/-- migrate:down/{f=1;next}f' "$SF")
# 20261012000161 runs after 160: it rules the additional-operators junctions (its backup is in
# d1_private too, so it goes down first and comes up after 160, as on a real database).
JR=$(migration lab_member_additional_operator_rules)
jr_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$JR")
jr_down=$(awk '/-- migrate:down/{f=1;next}f' "$JR")
# 20261012000166 (record access rules) keeps its own backup table in d1_private and runs after 163: it goes down
# first and comes up after 161, as on a real database.
LA=$(migration record_readers_and_rules)
la_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$LA")
la_down=$(awk '/-- migrate:down/{f=1;next}f' "$LA")
# 20261012000167 (rollup restricted) rewrites 166's project_rollup row and keeps its own backup in d1_private: it goes down
# before 166 and comes up after it.
RR=$(migration project_rollup_restricted)
rr_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RR")
rr_down=$(awk '/-- migrate:down/{f=1;next}f' "$RR")
# 20261012000168 (Ask-DB row security) sits on top of 166's is_hidden and 167's view: it goes down before 167 and up after it.
LL=$(migration llm_role_row_security)
ll_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$LL")
ll_down=$(awk '/-- migrate:down/{f=1;next}f' "$LL")
# 20261012000169 (a member updates only their own People row) is the last of the family and independent of the rest (it changes one
# directus_permissions row and keeps its own backup in d1_private): it goes down with 168, before it, and comes up with it, after it,
# so every sequence below that peels 168 also peels 169.
PU=$(migration people_update_own_row)
pu_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$PU")
pu_down=$(awk '/-- migrate:down/{f=1;next}f' "$PU")
ll_up="$ll_up
$pu_up"
ll_down="$pu_down
$ll_down"
# 20261014000174 (form layout) keeps its backup in d1_private and rewrites the field lists of four Lab Member rows (create and update
# of physical_samples and projects), so it goes down first, before 169, and comes up last, as on a real database.
fl_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG_FL")
fl_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG_FL")
ll_up="$ll_up
$fl_up"
ll_down="$fl_down
$ll_down"
# 20261015000194 (people create without the inbox alias columns) rewrites one Lab Member row (people create: its field list) and needs no backup
# (down puts '*' back), so, like 169, it is peeled with 168 (down first of all) and replayed with it (up last).
PC=$(migration people_create_no_inbox_fields)
pc_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$PC")
pc_down=$(awk '/-- migrate:down/{f=1;next}f' "$PC")
ll_up="$ll_up
$pc_up"
ll_down="$pc_down
$ll_down"
# 20261012000163 (per-user usage scores) also keeps tables in d1_private, and runs after 161: this
# migration's down only empties the schema (and drops it) once 163's down has run too.
UU=$(migration user_usage)
uu_down=$(awk '/-- migrate:down/{f=1;next}f' "$UU")
# 20261013000170 (pin order, view pins, user_prefs) runs after 163 and adds d1_private.user_prefs, so its
# down goes first, as on a real database.
UP=$(migration user_pins_and_prefs)
up_down=$(awk '/-- migrate:down/{f=1;next}f' "$UP")
# 20261014000180 (people admin) adds three functions in d1_private (and nothing else there), so its down goes
# first: 141's down only drops the schema once it is empty.
PA=$(migration people_admin)
pa_down=$(awk '/-- migrate:down/{f=1;next}f' "$PA")
# 20261014000181 (teams) adds four functions in d1_private (and nothing else there) and runs after 180, so its down goes
# before 180's: 180's down and 141's only drop their own objects and the schema once it is empty.
TM=$(migration teams)
tm_down=$(awk '/-- migrate:down/{f=1;next}f' "$TM")
# 20261014000182 (team access) adds functions in d1_private, references teams and replaces 180's functions and 166's update trigger
# functions (its down puts them back), so its down goes first of all, before 181's.
TA=$(migration team_access)
ta_down=$(awk '/-- migrate:down/{f=1;next}f' "$TA")
# 20261014000183 (team ownership) replaces functions of 182 and 166 and adds functions in d1_private; its down puts them back, so it goes first of all, before 182's.
TO=$(migration team_ownership)
to_down=$(awk '/-- migrate:down/{f=1;next}f' "$TO")
# 20261014000184 (team ownership rules) only changes Lab Member rows (its backup table lives in d1_private); its down goes before 183's. The up is replayed wherever
# the rows are compared with the generator (the temp table it creates lives until commit, so a second replay drops it first).
TR=$(migration team_ownership_rules)
tr_down=$(awk '/-- migrate:down/{f=1;next}f' "$TR")
tr_up="DROP TABLE IF EXISTS _lm_team_ownership_rules;
$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$TR")"
# 20261015000185 (Lab Viewer) replaces the readers_of_* functions of 183, adds a view, a function and triggers in d1_private and the Lab Viewer role, policy and rows;
# its down goes before 184's, in every chain that starts with 184's (it does nothing when the view is already gone, so a second replay is harmless). The up is replayed
# where it is compared with the generator (its temp table lives until commit, so a second replay drops it first).
LV=$(migration lab_viewer)
lv_down=$(awk '/-- migrate:down/{f=1;next}f' "$LV")
lv_up="DROP TABLE IF EXISTS _lv_rules;
$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$LV")"
# 20261016000196 (file provenance owner) changes the Lab Member and Lab Viewer directus_files rows, adds file_readers rows and references people, teams and
# directus_files, so its down goes before 185's (and so before every chain that starts with 185's or 184's), and its up is replayed after 185's and after 184's
# (only its permission rows: the chains that replay 184's have dropped teams and people, so no table or trigger of it can come back; the viewer rows only while
# the viewer policy exists, so a chain that replays 184's without 185's gets the Lab Member rows only).
FPO_MIG=$(migration file_provenance_owner)
fpo_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$FPO_MIG")
fpo_down=$(awk '/-- migrate:down/{f=1;next}f' "$FPO_MIG")
# 20261016000197 (SEM image settings) adds two tables, five functions and a column in d1_private and nothing else, so its down goes first of all (before 196's), and it is not replayed.
SEM_MIG=$(migration sem_image_settings)
sem_down=$(awk '/-- migrate:down/{f=1;next}f' "$SEM_MIG")
# 20261016000201 (file owner follow-ups) replaces 196's readers function and people trigger and adds two guard triggers and their functions, so its down goes before everything else and it is not replayed.
FOF_MIG=$(migration file_owner_followups)
fof_down=$(awk '/-- migrate:down/{f=1;next}f' "$FOF_MIG")
lv_down="$fof_down
$sem_down
$fpo_down
$lv_down"
lv_up="$lv_up
$fpo_up"
fpo_rules_up=$(awk '/^-- rules:begin/{f=1;next}/^-- rules:end/{f=0}f' "$FPO_MIG")
tr_up="$tr_up
$fpo_rules_up"
tr_down="$lv_down
$tr_down"
rv_ruled="(SELECT collection FROM _gen WHERE ruled UNION SELECT 'audit_logs')"
rv_seed="
DELETE FROM directus_permissions WHERE policy = '$LM'
  AND collection IN (SELECT collection FROM _gen WHERE ruled UNION SELECT 'audit_logs' UNION SELECT 'materials');
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy) VALUES
  ('physical_samples','read',NULL,NULL,NULL,'*','$LM'),
  ('physical_samples','delete','{}','{}','{\"owner\":1}','sample_id,sample_code','$LM'),
  ('machining_force_analysis','update','{}','{}',NULL,'*','$LM'),
  ('campaigns','read','{}','{}',NULL,'*','$LM'),
  ('materials','read','{}','{}',NULL,'*','$LM'),
  ('audit_logs','read','{}','{}',NULL,'*','$LM'),
  ('people','create','{}','{}',NULL,'*','$LM'),
  ('people','read','{}','{}',NULL,'*','$LM'),
  ('people','update','{}','{}',NULL,'*','$LM'),
  ('people','delete','{}','{}',NULL,'*','$LM'),
  ('physical_samples','read','{}','{}',NULL,'*','20000002-0000-0000-0000-000000000001');
CREATE TEMP TABLE before_rows AS SELECT * FROM directus_permissions WHERE policy = '$LM';
DELETE FROM directus_relations WHERE many_collection = 'physical_samples' AND many_field = 'project_id';
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field)
  VALUES ('physical_samples', 'project_id', 'projects', NULL);
DELETE FROM directus_relations WHERE (many_collection, many_field) IN
  (('physical_samples','owner_person_id'), ('campaigns','owner_person_id'), ('campaign_samples','campaign_id'));
UPDATE directus_relations SET one_field = NULL
  WHERE many_collection = 'manufacturing_operations' AND many_field = 'project_id';
UPDATE directus_relations SET one_field = 'sessions'
  WHERE many_collection = 'test_sessions' AND many_field = 'project_id';
DELETE FROM directus_fields WHERE collection = 'projects' AND field IN ('samples','operations','sessions');
INSERT INTO directus_fields (collection, field, special, interface, hidden, readonly, note)
  VALUES ('projects', 'sessions', 'o2m', 'list-o2m', TRUE, TRUE, 'pre-existing alias (test seed)');
INSERT INTO physical_samples (sample_code) VALUES ('TEST-NOOWNER-001');
"
rv_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- migrations 143 and 175 keep a ledger in d1_private; drop them (rolled back) so 141's down can drop the empty schema
DROP TABLE IF EXISTS d1_private.restore_inline_param_meta_changes;
DROP TABLE IF EXISTS d1_private.operation_sequence_backfill;
DROP TABLE IF EXISTS d1_private.form_values_175_backup;
DROP TABLE IF EXISTS d1_private.process_templates;
DROP TABLE IF EXISTS d1_private.process_drafts;
DROP TABLE IF EXISTS d1_private.inbox_prefs;
DROP TABLE IF EXISTS d1_private.inbox_crawler_state;
DROP TABLE IF EXISTS d1_private.inbox_scan_requests;
DROP TABLE IF EXISTS d1_private.inbox_ignored_dirs;
DROP TABLE IF EXISTS d1_private.inbox_dirs;
DROP TABLE IF EXISTS d1_private.file_thumbnails;
DROP TABLE IF EXISTS d1_private.file_candidates;
DROP FUNCTION IF EXISTS d1_private.people_inbox_columns_insert_guard() CASCADE;
DROP FUNCTION IF EXISTS d1_private.inbox_person_alias_changed() CASCADE;
DROP FUNCTION IF EXISTS d1_private.inbox_team_folder_changed() CASCADE;
CREATE TEMP TABLE _gen AS
  SELECT * FROM json_to_recordset(\$rules\$$rules_json\$rules\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, ruled boolean);
$tr_down
$to_down
$ta_down
$tm_down
$pa_down
$up_down
$ll_down
$rr_down
$la_down
$uu_down
$jr_down
$sf_down
$rv_down
SELECT 'dn0_backup_table:' || coalesce(to_regclass('d1_private.lab_member_permissions_backup')::text, 'gone');
SELECT 'dn0_schema:' || coalesce((SELECT nspname FROM pg_namespace WHERE nspname = 'd1_private'), 'gone');
$rv_seed
$rv_up
SELECT 'up_sample_read_filtered:' || (permissions::jsonb ? '_or') FROM directus_permissions WHERE policy='$LM' AND collection='physical_samples' AND action='read';
SELECT 'up_sample_delete:' || permissions::text FROM directus_permissions WHERE policy='$LM' AND collection='physical_samples' AND action='delete';
SELECT 'up_hand_fields:' || fields FROM directus_permissions WHERE policy='$LM' AND collection='physical_samples' AND action='delete';
SELECT 'up_sample_create_inserted:' || permissions::text FROM directus_permissions WHERE policy='$LM' AND collection='physical_samples' AND action='create';
SELECT 'up_campaigns_read_rows:' || count(*) FROM directus_permissions WHERE policy='$LM' AND collection='campaigns' AND action='read';
SELECT 'up_campaigns_read_filtered:' || (permissions::jsonb ? '_or') FROM directus_permissions WHERE policy='$LM' AND collection='campaigns' AND action='read';
SELECT 'up_materials:' || permissions::text FROM directus_permissions WHERE policy='$LM' AND collection='materials';
SELECT 'up_other_policy:' || permissions::text FROM directus_permissions WHERE policy='20000002-0000-0000-0000-000000000001' AND collection='physical_samples';
SELECT 'up_rollup_rows:' || count(*) FROM directus_permissions WHERE policy='$LM' AND collection='project_rollup';
SELECT 'up_fast_run_data_actions:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions WHERE policy='$LM' AND collection='fast_run_data';
SELECT 'up_audit_logs:' || count(*) FROM directus_permissions WHERE policy='$LM' AND collection='audit_logs';
SELECT 'up_people_actions:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions WHERE policy='$LM' AND collection='people';
SELECT 'up_people_update_fields:' || fields FROM directus_permissions WHERE policy='$LM' AND collection='people' AND action='update';
SELECT 'up_people_create_validation:' || (validation::jsonb ? '_or') FROM directus_permissions WHERE policy='$LM' AND collection='people' AND action='create';
$sf_up
$jr_up
$la_up
$rr_up
$ll_up
$tr_up
-- 20261012000164 (label_templates), 20261014000177 (batches) and 20261015000192 (surface_scans), custom-rows collections, run after these and add their rows, which are the generated ones
INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
  SELECT collection, action, permissions::json, '{}'::json, fields, '$LM' FROM _gen WHERE collection IN ('label_templates', 'batches', 'surface_scans');
SELECT 'up_exact:' || count(*) FROM _gen g JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = g.collection AND p.action = g.action AND p.permissions::jsonb = g.permissions
 AND (g.fields = '*' OR p.fields = g.fields) AND (g.validation = '{}'::jsonb OR p.validation::jsonb = g.validation)
 WHERE g.ruled;
$tr_down
$ll_down
$rr_down
$la_down
-- the replay's own rows for label_templates, batches and surface_scans go before the older migrations' down sections run
DELETE FROM directus_permissions WHERE policy = '$LM' AND collection IN ('label_templates', 'batches', 'surface_scans');
$jr_down
$sf_down
SELECT 'up_backup_rows:' || count(*) FROM d1_private.lab_member_permissions_backup;
SELECT 'up_backup_exact:' || count(*) FROM (
  (SELECT to_jsonb(b) FROM before_rows b WHERE b.collection IN $rv_ruled EXCEPT SELECT to_jsonb(k) FROM d1_private.lab_member_permissions_backup k)
  UNION ALL
  (SELECT to_jsonb(k) FROM d1_private.lab_member_permissions_backup k EXCEPT SELECT to_jsonb(b) FROM before_rows b)) x;
SELECT 'up_backup_commented:' || (obj_description('d1_private.lab_member_permissions_backup'::regclass, 'pg_class') IS NOT NULL);
SELECT 'up_backup_not_public:' || coalesce(to_regclass('public.lab_member_permissions_backup')::text, 'absent');
SELECT 'up_backup_in_dictionary:' || count(*) FROM v_schema_dictionary WHERE object_name LIKE 'lab\_member\_%';
SELECT 'up_backup_in_targets:' || count(*) FROM v_llm_query_targets WHERE view_name LIKE 'lab\_member%';
SELECT 'up_private_schema_commented:' || (obj_description('d1_private'::regnamespace, 'pg_namespace') IS NOT NULL);
SELECT 'up_llm_usage:' || has_schema_privilege('d1_llm_readonly', 'd1_private', 'USAGE');
SELECT 'up_llm_select:' || has_table_privilege('d1_llm_readonly', 'd1_private.lab_member_permissions_backup', 'SELECT');
SELECT 'up_public_usage:' || has_schema_privilege('public', 'd1_private', 'USAGE');
SELECT 'up_changes:' || string_agg(kind || '/' || collection || '.' || field, ',' ORDER BY kind, collection, field) FROM d1_private.lab_member_row_visibility_changes;
SELECT 'up_rel_owner:' || count(*) FROM directus_relations WHERE (many_collection, many_field, one_collection) IN
  (('physical_samples','owner_person_id','people'), ('campaigns','owner_person_id','people'), ('campaign_samples','campaign_id','campaigns'));
SELECT 'up_alias:' || one_field FROM directus_relations WHERE many_collection='physical_samples' AND many_field='project_id';
SELECT 'up_alias_ops:' || one_field FROM directus_relations WHERE many_collection='manufacturing_operations' AND many_field='project_id';
SELECT 'up_alias_tests:' || one_field FROM directus_relations WHERE many_collection='test_sessions' AND many_field='project_id';
SELECT 'up_alias_fields:' || string_agg(field || '=' || hidden || '/' || readonly, ',' ORDER BY field) FROM directus_fields WHERE collection='projects' AND field IN ('samples','operations','sessions');
$rv_up
SELECT 'up_idempotent:' || count(*) FROM directus_permissions WHERE policy='$LM' AND collection IN ('physical_samples','campaigns','project_rollup','projects');
SELECT 'up_idempotent_alias:' || count(*) FROM directus_fields WHERE collection='projects' AND field IN ('samples','operations','sessions');
SELECT 'up_idempotent_relations:' || count(*) FROM directus_relations WHERE many_collection='physical_samples' AND many_field='owner_person_id';
SELECT 'up2_backup_still_old:' || count(*) FROM d1_private.lab_member_permissions_backup WHERE coalesce(permissions::jsonb, '{}'::jsonb) <> '{}'::jsonb;
SELECT 'up2_backup_rows:' || count(*) FROM d1_private.lab_member_permissions_backup;
SELECT 'up2_changes:' || count(*) FROM d1_private.lab_member_row_visibility_changes;
$rv_down
SELECT 'dn_exact:' || count(*) FROM (
  (SELECT to_jsonb(b) FROM before_rows b EXCEPT SELECT to_jsonb(p) FROM directus_permissions p WHERE p.policy = '$LM')
  UNION ALL
  (SELECT to_jsonb(p) FROM directus_permissions p WHERE p.policy = '$LM' EXCEPT SELECT to_jsonb(b) FROM before_rows b)) x;
SELECT 'dn_hand_fields:' || fields || ' ' || presets::text FROM directus_permissions WHERE policy='$LM' AND collection='physical_samples' AND action='delete';
SELECT 'dn_audit_logs:' || count(*) FROM directus_permissions WHERE policy='$LM' AND collection='audit_logs';
SELECT 'dn_people_actions:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions WHERE policy='$LM' AND collection='people';
SELECT 'dn_other_policy:' || count(*) FROM directus_permissions WHERE policy='20000002-0000-0000-0000-000000000001' AND collection='physical_samples';
SELECT 'dn_materials:' || count(*) FROM directus_permissions WHERE policy='$LM' AND collection='materials';
SELECT 'dn_filters_left:' || count(*) FROM directus_permissions WHERE policy='$LM' AND permissions::jsonb <> '{}'::jsonb;
SELECT 'dn_backup_table:' || coalesce(to_regclass('d1_private.lab_member_permissions_backup')::text, 'gone');
SELECT 'dn_changes_table:' || coalesce(to_regclass('d1_private.lab_member_row_visibility_changes')::text, 'gone');
SELECT 'dn_schema:' || coalesce((SELECT nspname FROM pg_namespace WHERE nspname = 'd1_private'), 'gone');
SELECT 'dn_alias:' || coalesce(one_field, 'null') FROM directus_relations WHERE many_collection='physical_samples' AND many_field='project_id';
SELECT 'dn_alias_ops:' || coalesce(one_field, 'null') FROM directus_relations WHERE many_collection='manufacturing_operations' AND many_field='project_id';
SELECT 'dn_alias_tests:' || coalesce(one_field, 'null') FROM directus_relations WHERE many_collection='test_sessions' AND many_field='project_id';
SELECT 'dn_alias_sessions_field:' || note FROM directus_fields WHERE collection='projects' AND field='sessions';
SELECT 'dn_alias_fields:' || string_agg(field, ',' ORDER BY field) FROM directus_fields WHERE collection='projects' AND field IN ('samples','operations','sessions');
-- idx_batches_owner_person_id belongs to 20261014000177 (batches), which this replay never rolls back, so it is not one of the indexes expected to be gone
SELECT 'dn_indexes:' || count(*) FROM pg_indexes WHERE (indexname LIKE 'idx\_%\_owner\_person\_id' AND tablename NOT IN ('batches', 'surface_scans')) OR indexname IN ('idx_physical_samples_project_id','idx_sample_co_owners_user_id','idx_project_investigators_user_id');
ROLLBACK;
SQL
)
expect_fixed rv_out "dn0_backup_table:gone" "(setup) down drops the backup table"
expect_fixed rv_out "dn0_schema:gone" "(setup) down drops the private schema once it is empty"
expect_fixed rv_out "up_sample_read_filtered:true" "up: an unfiltered sample read row gets the filter"
expect_fixed rv_out 'up_sample_delete:{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}' "up: sample delete is owner-only"
expect_fixed rv_out "up_hand_fields:sample_id,sample_code" "up: a field list narrowed by hand on a collection without custom rows is kept"
expect_fixed rv_out "up_sample_create_inserted:{}" "up: a missing create row is inserted, unfiltered"
expect_fixed rv_out "up_campaigns_read_rows:1" "up: a hand-added campaigns row is updated, not duplicated"
expect_fixed rv_out "up_campaigns_read_filtered:true" "up: campaigns read is filtered"
expect_fixed rv_out "up_materials:{}" "up: reference data rows are not touched"
expect_fixed rv_out "up_other_policy:{}" "up: another policy's rows are not touched"
expect_fixed rv_out "up_rollup_rows:1" "up: project_rollup gets a read row"
expect_fixed rv_out "up_fast_run_data_actions:read" "up: fast_run_data stays read-only"
expect_fixed rv_out "up_audit_logs:0" "up: the Lab Member audit_logs grant is removed"
expect_fixed rv_out "up_people_actions:create,read,update" "up: Lab Member people delete is removed"
expect_fixed rv_out "up_people_update_fields:full_name,email,is_operator,is_researcher,active,notes" "up: people update loses user_id"
expect_fixed rv_out "up_people_create_validation:true" "up: people create gets the login validation"
n_exact=$(grep -o '^up_exact:[0-9]*' <<<"$rv_out" | cut -d: -f2)
[[ "${n_exact:-0}" -eq "${gen_n:-x}" ]] && ok "up, then 20261010000160: every ruled row matches the generated rules ($n_exact rows)" || bad "up: ruled rows differ from the generated rules (psql output: $rv_out)"
n_backup=$(grep -o '^up_backup_rows:[0-9]*' <<<"$rv_out" | cut -d: -f2)
[[ "${n_backup:-0}" -eq 9 ]] && ok "up: the backup holds the 9 seeded Lab Member rows of the changed collections" || bad "up: backup has ${n_backup:-?} rows, want 9 (psql output: $rv_out)"
expect_fixed rv_out "up_backup_exact:0" "up: the backup rows equal the rows before the migration, ids included"
expect_fixed rv_out "up_backup_commented:true" "up: the backup table has a comment"
expect_fixed rv_out "up_backup_not_public:absent" "up: the backup is not a public table (Directus would list it as a collection)"
expect_fixed rv_out "up_backup_in_dictionary:0" "up: the backup and change-log tables are not in v_schema_dictionary (the Ask-DB prompt)"
expect_fixed rv_out "up_backup_in_targets:0" "up: nothing of the backup is a v_llm_query_targets entry"
expect_fixed rv_out "up_private_schema_commented:true" "up: the d1_private schema has a comment"
expect_fixed rv_out "up_llm_usage:false" "up: the LLM role has no USAGE on d1_private"
expect_fixed rv_out "up_llm_select:false" "up: the LLM role cannot read the backup"
expect_fixed rv_out "up_public_usage:false" "up: PUBLIC has no USAGE on d1_private"
expect_fixed rv_out "up_changes:alias_field/projects.operations,alias_field/projects.samples,relation_alias/manufacturing_operations.project_id,relation_alias/physical_samples.project_id" "up: records the aliases it set (not the test_sessions one that already existed)"
expect_fixed rv_out "up_rel_owner:3" "up: the deleted owner_person_id and campaign_samples.campaign_id relations are inserted again"
expect_fixed rv_out "up_alias:samples" "up: physical_samples.project_id gets the one_field alias 'samples'"
expect_fixed rv_out "up_alias_ops:operations" "up: manufacturing_operations.project_id gets the alias 'operations'"
expect_fixed rv_out "up_alias_tests:sessions" "up: test_sessions.project_id gets the alias 'sessions'"
expect_fixed rv_out "up_alias_fields:operations=true/true,samples=true/true,sessions=true/true" "up: the projects aliases are hidden and read-only"
expect_fixed rv_out "up_idempotent_alias:3" "up is idempotent (three alias fields)"
expect_fixed rv_out "up_idempotent_relations:1" "up is idempotent (one owner_person_id relation)"
expect_fixed rv_out "up2_backup_still_old:0" "a second up keeps the first backup (the pre-migration rows)"
expect_fixed rv_out "up2_backup_rows:$n_backup" "a second up does not add backup rows"
expect_fixed rv_out "up2_changes:4" "a second up does not add change rows"
grep -q "ownerless records.*physical_samples=[1-9]" <<<"$rv_out" && ok "up: reports ownerless samples in a NOTICE" || bad "up: no ownerless NOTICE (psql output: $rv_out)"
expect_fixed rv_out "dn_exact:0" "down: the Lab Member rows are exactly as before (ids, filters, fields, presets)"
expect_fixed rv_out 'dn_hand_fields:sample_id,sample_code {"owner":1}' "down: a hand-narrowed field list and its presets come back"
expect_fixed rv_out "dn_audit_logs:1" "down: the audit_logs grant comes back"
expect_fixed rv_out "dn_people_actions:create,delete,read,update" "down: people delete comes back"
expect_fixed rv_out "dn_materials:1" "down: reference data rows are kept"
expect_fixed rv_out "dn_other_policy:1" "down: another policy's rows are kept"
expect_fixed rv_out "dn_filters_left:0" "down: no Lab Member row keeps a filter"
expect_fixed rv_out "dn_backup_table:gone" "down: the backup table is dropped"
expect_fixed rv_out "dn_changes_table:gone" "down: the change log is dropped"
expect_fixed rv_out "dn_schema:gone" "down: the empty private schema is dropped"
expect_fixed rv_out "dn_alias:null" "down: the relation alias is removed"
expect_fixed rv_out "dn_alias_ops:null" "down: the operations alias is removed"
expect_fixed rv_out "dn_alias_tests:sessions" "down: an alias that existed before up (test_sessions.project_id -> sessions) is kept"
expect_fixed rv_out "dn_alias_sessions_field:pre-existing alias (test seed)" "down: the alias field row that existed before up is kept untouched"
expect_fixed rv_out "dn_alias_fields:sessions" "down: only the alias fields up inserted are removed"
expect_fixed rv_out "dn_indexes:0" "down: the indexes are dropped"
n_up=$(grep -o '^up_idempotent:[0-9]*' <<<"$rv_out" | cut -d: -f2)
[[ "${n_up:-0}" -eq 13 ]] && ok "up is idempotent (a second run leaves 13 rows for four collections)" || bad "up is not idempotent (psql output: $rv_out)"

# Relations that point somewhere else, or an alias name that is taken, stop the migration before it
# installs filters that would fail at run time. Each case is its own rolled-back transaction.
rv_refuse() {
    local label="$1" setup="$2" expect="$3" out
    out=$($PSQL 2>&1 <<SQL
BEGIN;
$setup
$rv_up
ROLLBACK;
SQL
)
    grep -qF -- "$expect" <<<"$out" && ok "up refuses: $label" || bad "up does not refuse: $label (psql output: $out)"
}
rv_refuse "a relation that points at another collection" \
    "UPDATE directus_relations SET one_collection = 'equipment' WHERE many_collection = 'physical_samples' AND many_field = 'owner_person_id';" \
    "directus_relations has physical_samples.owner_person_id -> equipment but the row filters need -> people"
rv_refuse "a relation that already has a different alias" \
    "UPDATE directus_relations SET one_field = 'operations' WHERE many_collection = 'test_sessions' AND many_field = 'project_id';" \
    "relation test_sessions.project_id already has the alias operations but the row filters walk sessions"
rv_refuse "an alias name that another relation uses" \
    "UPDATE directus_relations SET one_field = NULL WHERE many_collection = 'test_sessions' AND many_field = 'project_id';
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field) VALUES ('equipment', 'project_id', 'projects', 'sessions');" \
    "cannot name the alias projects.sessions"
