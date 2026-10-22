# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.
# Conform runs (ADR-0025): the four migrations conform_category, conform_logs_and_run_data, conform_form_layout and
# conform_review_fixes, each proved up, behaviour, down, up inside rolled-back transactions. Named by slug, not number.

echo "== Migration 207: the Conform category, method CF, lineage, code rule and inline columns (up, behaviour, down, up) =="
CC_MIG=$(migration conform_category)
if [[ -f "$CC_MIG" ]]; then
cc_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$CC_MIG")
cc_down=$(awk '/-- migrate:down/{f=1;next}f' "$CC_MIG")
# The migration is applied by the CI run already; down then up inside a rolled-back transaction proves both and leaves the database as it was.
cc_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
SELECT 'cc_map:' || coalesce((SELECT process_category FROM manufacturing_methods WHERE method_code = 'CF'), 'none');
SELECT 'cc_method_name:' || (SELECT method_name FROM manufacturing_methods WHERE method_code = 'CF');
SELECT 'cc_machine:' || (SELECT capabilities FROM equipment WHERE equipment_name = 'Conform');
SELECT 'cc_uncommented:' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'manufacturing_operations'
    AND c.column_name LIKE 'conform\_%' AND col_description('manufacturing_operations'::regclass, c.ordinal_position) IS NULL);
SELECT 'cc_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'manufacturing_operations' AND column_name LIKE 'conform\_%';
SELECT 'cc_field_rows:' || count(*) || '/' || count(*) FILTER (WHERE hidden AND conditions::text LIKE '%show when conform%' AND conditions::text LIKE '%"conform"%') FROM directus_fields WHERE collection = 'manufacturing_operations' AND field LIKE 'conform\_%' AND field <> 'conform_run';
SELECT 'cc_form_dropdown:' || coalesce((SELECT (options::jsonb -> 'choices')::text FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'conform_feedstock_form'), 'none');
INSERT INTO physical_samples (sample_code, form) VALUES ('CFT-IN', 'powder'), ('CFT-OUT', 'rod'), ('CFT-IN2', 'powder'), ('CFT-OUT2', 'rod');
INSERT INTO manufacturing_operations (sample_id, output_sample_id, method_id, equipment_id, operation_date, conform_run_number, conform_die_diameter_mm)
SELECT (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN'), (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-OUT'),
       (SELECT method_id FROM manufacturing_methods WHERE method_code = 'CF'), (SELECT equipment_id FROM equipment WHERE equipment_name = 'Conform'),
       '2025-03-17 12:00+00', 12, 8;
SELECT 'cc_category:' || process_category || ',' || pass_code FROM manufacturing_operations WHERE conform_run_number = 12 AND process_category = 'conform';
SELECT 'cc_genealogy:' || relationship_type FROM sample_genealogy WHERE child_sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-OUT');
UPDATE manufacturing_operations SET conform_die_diameter_mm = NULL WHERE conform_run_number = 12 AND process_category = 'conform';
SELECT 'cc_code_no_die:' || pass_code FROM manufacturing_operations WHERE conform_run_number = 12 AND process_category = 'conform';
UPDATE manufacturing_operations SET conform_run_number = 1234, conform_die_diameter_mm = 6.5 WHERE conform_run_number = 12 AND process_category = 'conform';
SELECT 'cc_code_big_run:' || pass_code FROM manufacturing_operations WHERE conform_run_number = 1234;
UPDATE manufacturing_operations SET conform_run_number = NULL WHERE conform_run_number = 1234;
SELECT 'cc_code_no_run:' || pass_code FROM manufacturing_operations WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
UPDATE manufacturing_operations SET conform_run_number = 12, conform_die_diameter_mm = 8 WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
SELECT 'cc_code_rebuilt:' || pass_code FROM manufacturing_operations WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
DO \$\$ BEGIN
    INSERT INTO manufacturing_operations (sample_id, method_id, equipment_id, operation_date, conform_run_number)
    SELECT (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN2'), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'CF'),
           (SELECT equipment_id FROM equipment WHERE equipment_name = 'Conform'), '2025-03-18 12:00+00', 12;
    RAISE NOTICE 'cc_unique_run:accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'cc_unique_run:refused'; END \$\$;
DO \$\$ BEGIN
    UPDATE manufacturing_operations SET conform_feedstock_form = 'slurry' WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
    RAISE NOTICE 'cc_form_check:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cc_form_check:refused'; END \$\$;
-- down: the operation goes back to deformation and keeps its code, the edge becomes derived_from, method CF stays while it is used
$cc_down
SELECT 'cc_dn_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'manufacturing_operations' AND column_name LIKE 'conform\_%';
SELECT 'cc_dn_field_rows:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field LIKE 'conform\_%' AND field <> 'conform_run';
SELECT 'cc_dn_op:' || process_category || ',' || pass_code FROM manufacturing_operations WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
SELECT 'cc_dn_genealogy:' || relationship_type FROM sample_genealogy WHERE child_sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-OUT');
SELECT 'cc_dn_method:' || coalesce((SELECT process_category FROM manufacturing_methods WHERE method_code = 'CF'), 'gone');
SELECT 'cc_dn_machine:' || (SELECT capabilities FROM equipment WHERE equipment_name = 'Conform');
DO \$\$ BEGIN
    UPDATE manufacturing_operations SET process_category = 'conform' WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
    RAISE NOTICE 'cc_dn_check:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cc_dn_check:refused'; END \$\$;
DO \$\$ BEGIN
    INSERT INTO sample_genealogy (child_sample_id, parent_sample_id, relationship_type)
    SELECT (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-OUT2'), (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN2'), 'extruded_from';
    RAISE NOTICE 'cc_dn_rel_check:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cc_dn_rel_check:refused'; END \$\$;
-- the code functions are the originals again: no conform branch
SELECT 'cc_dn_code_fn:' || (pg_get_functiondef('operation_code_for(manufacturing_operations, text)'::regprocedure) NOT LIKE '%conform%');
SELECT 'cc_dn_trg_fn:' || (pg_get_functiondef('trg_mfg_op_set_code()'::regprocedure) NOT LIKE '%conform%');
-- an unused method CF is removed by the down (up again first: the kept CF is adopted back under conform)
$cc_up
SELECT 'cc_re_up_map:' || coalesce((SELECT process_category FROM manufacturing_methods WHERE method_code = 'CF'), 'none');
DELETE FROM manufacturing_operations WHERE sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CFT-IN');
$cc_down
SELECT 'cc_dn_method_unused:' || coalesce((SELECT process_category FROM manufacturing_methods WHERE method_code = 'CF'), 'gone');
$cc_up
SELECT 'cc_up2_map:' || coalesce((SELECT process_category FROM manufacturing_methods WHERE method_code = 'CF'), 'none');
SELECT 'cc_up2_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'manufacturing_operations' AND column_name LIKE 'conform\_%';
SELECT 'cc_up2_machine:' || (SELECT capabilities FROM equipment WHERE equipment_name = 'Conform');
SELECT 'cc_up2_code_fn:' || (pg_get_functiondef('operation_code_for(manufacturing_operations, text)'::regprocedure) LIKE '%conform%');
ROLLBACK;
SQL
)
cc_check() { grep -q "$1" <<<"$cc_out" && ok "$2" || bad "$2 (psql output: $cc_out)"; }
cc_check "^cc_map:conform$" "207: method CF maps to the conform category"
cc_check "^cc_method_name:Conform (continuous extrusion)$" "207: method CF is named Conform (continuous extrusion)"
cc_check "^cc_machine:deformation,conform$" "207: the Conform machine keeps deformation and gains conform"
cc_check "^cc_uncommented:0$" "207: every conform_ column has a COMMENT"
cc_check "^cc_columns:12$" "207: manufacturing_operations has the twelve conform_ columns"
cc_check "^cc_field_rows:12/12$" "207: each conform_ column has a Directus field row, hidden at the base with the show-when-conform condition"
cc_check '^cc_form_dropdown:\[{"text": "Swarf", "value": "swarf"}, {"text": "Powder", "value": "powder"}, {"text": "Granules", "value": "granules"}, {"text": "Rod", "value": "rod"}\]$' "207: the feedstock form is a dropdown of swarf, powder, granules, rod"
cc_check "^cc_category:conform,17-03-25-CF-012-8dia$" "207: a CF operation takes the conform category and the code 17-03-25-CF-012-8dia"
cc_check "^cc_genealogy:extruded_from$" "207: a CF operation with input and output writes an extruded_from edge"
cc_check "^cc_code_no_die:17-03-25-CF-012$" "207: with the die empty the code is 17-03-25-CF-012"
cc_check "^cc_code_big_run:17-03-25-CF-1234-6.5dia$" "207: a run number of 100 or more is written in full, the die as 6.5dia"
cc_check "^cc_code_no_run:CFT-IN-1$" "207: without a run number the code falls back to the sample code and sequence"
cc_check "^cc_code_rebuilt:17-03-25-CF-012-8dia$" "207: typing the run number and die again rebuilds the code (the trigger's fast exit sees the conform columns)"
cc_check "cc_unique_run:refused" "207: two CF operations on one machine with run number 12 violate the unique index"
cc_check "cc_form_check:refused" "207: an unknown feedstock form is refused by the CHECK"
cc_check "^cc_dn_columns:0$" "207 down: the conform_ columns are dropped"
cc_check "^cc_dn_field_rows:0$" "207 down: the conform_ field rows are deleted"
cc_check "^cc_dn_op:deformation,17-03-25-CF-012-8dia$" "207 down: a conform operation goes back to deformation and keeps its code"
cc_check "^cc_dn_genealogy:derived_from$" "207 down: an extruded_from edge becomes derived_from"
cc_check "^cc_dn_method:deformation$" "207 down: method CF is kept (filed under deformation) while an operation uses it"
cc_check "^cc_dn_machine:deformation$" "207 down: the Conform machine is back to deformation only"
cc_check "cc_dn_check:refused" "207 down: the category CHECK refuses conform again"
cc_check "cc_dn_rel_check:refused" "207 down: the relationship CHECK refuses extruded_from again"
cc_check "^cc_dn_code_fn:true$" "207 down: operation_code_for has no conform branch again"
cc_check "^cc_dn_trg_fn:true$" "207 down: trg_mfg_op_set_code is the original again"
cc_check "^cc_re_up_map:conform$" "207: an up after a down that kept method CF adopts it back under conform"
cc_check "^cc_dn_method_unused:gone$" "207 down: an unused method CF is removed"
cc_check "^cc_up2_map:conform$" "207 up again: method CF is back under conform"
cc_check "^cc_up2_columns:12$" "207 up again: the twelve columns are back"
cc_check "^cc_up2_machine:deformation,conform$" "207 up again: the machine has conform again"
cc_check "^cc_up2_code_fn:true$" "207 up again: operation_code_for has its conform branch"
else
bad "the Conform category migration is missing ($CC_MIG)"
fi
# directus_fields is an empty stub on CI, so seed the capabilities dropdown as the live database has it (migration 056 gave the machine
# 'deformation'; the choices come from configure_directus.sql) and prove that up adds the choice once and down takes it out again
cc2_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
$cc_down
DELETE FROM directus_fields WHERE collection = 'equipment' AND field = 'capabilities';
INSERT INTO directus_fields (collection, field, interface, options) VALUES ('equipment', 'capabilities', 'select-multiple-dropdown',
    '{"choices":[{"text":"Machining","value":"machining"},{"text":"Deformation","value":"deformation"}]}');
$cc_up
SELECT 'cc2_up_choices:' || (SELECT string_agg(c ->> 'value', ',' ORDER BY ord) FROM directus_fields f, jsonb_array_elements(f.options::jsonb -> 'choices') WITH ORDINALITY AS t (c, ord)
    WHERE f.collection = 'equipment' AND f.field = 'capabilities');
$cc_down
SELECT 'cc2_dn_choices:' || (SELECT string_agg(c ->> 'value', ',' ORDER BY ord) FROM directus_fields f, jsonb_array_elements(f.options::jsonb -> 'choices') WITH ORDINALITY AS t (c, ord)
    WHERE f.collection = 'equipment' AND f.field = 'capabilities');
ROLLBACK;
SQL
)
cc2_check() { grep -qxF -- "$1" <<<"$cc2_out" && ok "$2" || bad "$2 (psql output: $cc2_out)"; }
cc2_check "cc2_up_choices:machining,deformation,conform" "207: the capabilities dropdown gains the conform choice, after the existing ones"
cc2_check "cc2_dn_choices:machining,deformation" "207 down: the conform choice is taken out of the dropdown again"

echo "== Migration 208: conform_logs, conform_run_data, the run-window overlap guard, access (up, behaviour, down, up) =="
CL_MIG=$(migration conform_logs_and_run_data)
if [[ -f "$CL_MIG" ]]; then
cl_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$CL_MIG")
cl_down=$(awk '/-- migrate:down/{f=1;next}f' "$CL_MIG")
CLK=c0f00000-0000-4000-8000-0000000000
cl_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
SELECT 'cl_tables:' || (to_regclass('conform_logs') IS NOT NULL) || ',' || (to_regclass('conform_run_data') IS NOT NULL);
SELECT 'cl_uncommented:' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('conform_logs', 'conform_run_data')
    AND col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) IS NULL);
SELECT 'cl_table_comments:' || (SELECT count(*) FROM pg_description d JOIN pg_class k ON k.oid = d.objoid WHERE d.objsubid = 0 AND k.relname IN ('conform_logs', 'conform_run_data'));
SELECT 'cl_triggers:' || string_agg(c.relname || '.' || t.tgname, ',' ORDER BY c.relname, t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname IN ('conform_logs', 'conform_run_data') AND NOT t.tgisinternal;
SELECT 'cl_trigger_comments:' || (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname IN ('conform_logs', 'conform_run_data')
    AND NOT t.tgisinternal AND obj_description(t.oid, 'pg_trigger') IS NULL);
SELECT 'cl_llm:' || has_table_privilege('d1_llm_readonly', 'conform_logs', 'SELECT') || ',' || has_table_privilege('d1_llm_readonly', 'conform_run_data', 'SELECT');
SELECT 'cl_rls:' || (SELECT count(*) FROM pg_class WHERE relname IN ('conform_logs', 'conform_run_data') AND relrowsecurity AND NOT relforcerowsecurity)
    || ',' || (SELECT count(*) FROM pg_policies WHERE tablename IN ('conform_logs', 'conform_run_data') AND policyname IN ('a1a_open', 'a1a_llm_hide'));
SELECT 'cl_collections:' || string_agg(collection || '/' || hidden || '/' || "group", ',' ORDER BY collection) FROM directus_collections WHERE collection IN ('conform_logs', 'conform_run_data');
SELECT 'cl_field_rows:' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conform_logs')
    || '/' || (SELECT count(*) FROM directus_fields WHERE collection = 'conform_logs')
    || ',' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conform_run_data')
    || '/' || (SELECT count(*) FROM directus_fields WHERE collection = 'conform_run_data')
    || ',' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('conform_logs', 'conform_run_data')
         AND NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = c.table_name AND f.field = c.column_name));
SELECT 'cl_aliases:' || string_agg(collection || '.' || field || '=' || special, ',' ORDER BY collection) FROM directus_fields WHERE field IN ('conform_run', 'runs') AND collection IN ('manufacturing_operations', 'conform_logs');
SELECT 'cl_relations:' || string_agg(many_collection || '.' || many_field || '>' || one_collection || coalesce('.' || one_field, ''), ',' ORDER BY many_collection, many_field)
    FROM directus_relations WHERE many_collection IN ('conform_logs', 'conform_run_data');
SELECT 'cl_perm_lm:' || string_agg(collection || '.' || action, ',' ORDER BY collection, action) FROM directus_permissions
    WHERE policy = '20000002-0000-0000-0000-000000000002' AND collection IN ('conform_logs', 'conform_run_data');
SELECT 'cl_perm_viewer:' || string_agg(collection || '.' || action, ',' ORDER BY collection, action) FROM directus_permissions
    WHERE policy = '20000002-0000-0000-0000-000000000003' AND collection IN ('conform_logs', 'conform_run_data');
-- fixture: a log 13:00-14:00 on the Conform machine, two Conform operations
INSERT INTO directus_files (id) VALUES ('${CLK}f1');
INSERT INTO physical_samples (sample_code, form) VALUES ('CLT-IN-1', 'powder'), ('CLT-IN-2', 'powder');
INSERT INTO manufacturing_operations (operation_id, sample_id, method_id, equipment_id, operation_date, conform_run_number)
SELECT v.op::uuid, (SELECT sample_id FROM physical_samples WHERE sample_code = v.sc), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'CF'),
       (SELECT equipment_id FROM equipment WHERE equipment_name = 'Conform'), '2025-03-17 13:00+00', v.run
FROM (VALUES ('${CLK}a1', 'CLT-IN-1', 91), ('${CLK}a2', 'CLT-IN-2', 92)) AS v (op, sc, run);
INSERT INTO conform_logs (log_id, directus_files_id, equipment_id, source_filename, source_sha256, log_start, log_end, n_rows, duration_s, series, totals, constants)
VALUES ('${CLK}b1', '${CLK}f1', (SELECT equipment_id FROM equipment WHERE equipment_name = 'Conform'), 'TiSwarf.csv', repeat('a', 64),
        '2025-03-17 13:00:00+00', '2025-03-17 14:00:00+00', 3601, 3600, '[]', '{}', '{"version":1}');
SELECT 'cl_log_defaults:' || version || ',' || (created_by IS NULL) || ',' || (created_at IS NOT NULL) FROM conform_logs WHERE log_id = '${CLK}b1';
INSERT INTO conform_run_data (id, operation_id, log_id, window_start, window_end, status)
VALUES ('${CLK}c1', '${CLK}a1', '${CLK}b1', '2025-03-17 13:10:00+00', '2025-03-17 13:20:00+00', 'done');
SELECT 'cl_run_x:accepted';
DO \$\$ BEGIN
    INSERT INTO conform_run_data (id, operation_id, log_id, window_start, window_end, status)
    VALUES ('${CLK}c2', '${CLK}a2', '${CLK}b1', '2025-03-17 13:15:00+00', '2025-03-17 13:30:00+00', 'done');
    RAISE NOTICE 'cl_overlap:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cl_overlap:refused:%', SQLERRM; END \$\$;
INSERT INTO conform_run_data (id, operation_id, log_id, window_start, window_end, status)
VALUES ('${CLK}c2', '${CLK}a2', '${CLK}b1', '2025-03-17 13:20:00+00', '2025-03-17 13:30:00+00', 'done');
SELECT 'cl_touching:accepted';
DO \$\$ BEGIN
    UPDATE conform_run_data SET window_start = '2025-03-17 13:19:59+00' WHERE id = '${CLK}c2';
    RAISE NOTICE 'cl_overlap_update:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cl_overlap_update:refused:%', SQLERRM; END \$\$;
DO \$\$ BEGIN
    UPDATE conform_run_data SET window_start = '2025-03-17 12:50:00+00', window_end = '2025-03-17 13:05:00+00' WHERE id = '${CLK}c2';
    RAISE NOTICE 'cl_outside_before:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cl_outside_before:refused:%', SQLERRM; END \$\$;
DO \$\$ BEGIN
    UPDATE conform_run_data SET window_start = '2025-03-17 13:50:00+00', window_end = '2025-03-17 14:00:01+00' WHERE id = '${CLK}c2';
    RAISE NOTICE 'cl_outside_after:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cl_outside_after:refused:%', SQLERRM; END \$\$;
UPDATE conform_run_data SET window_start = '2025-03-17 13:50:00+00', window_end = '2025-03-17 14:00:00+00' WHERE id = '${CLK}c2';
SELECT 'cl_ends_at_log_end:accepted,' || version FROM conform_run_data WHERE id = '${CLK}c2';
UPDATE conform_run_data SET window_start = NULL, window_end = NULL, status = 'no_window' WHERE id = '${CLK}c2';
SELECT 'cl_no_window:' || status FROM conform_run_data WHERE id = '${CLK}c2';
UPDATE conform_run_data SET window_start = '2025-03-17 13:00:00+00', window_end = '2025-03-17 13:10:00+00', status = 'done' WHERE id = '${CLK}c2';
SELECT 'cl_adjacent_before:accepted';
DO \$\$ BEGIN
    UPDATE conform_run_data SET status = 'pending' WHERE id = '${CLK}c1';
    RAISE NOTICE 'cl_status_check:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cl_status_check:refused'; END \$\$;
DO \$\$ BEGIN
    UPDATE conform_run_data SET window_start = '2025-03-17 13:20:00+00', window_end = '2025-03-17 13:10:00+00' WHERE id = '${CLK}c1';
    RAISE NOTICE 'cl_window_order_check:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cl_window_order_check:refused'; END \$\$;
DO \$\$ BEGIN
    INSERT INTO conform_run_data (operation_id, status) VALUES ('${CLK}a1', 'no_log');
    RAISE NOTICE 'cl_one_per_operation:accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'cl_one_per_operation:refused'; END \$\$;
DO \$\$ BEGIN
    DELETE FROM directus_files WHERE id = '${CLK}f1';
    RAISE NOTICE 'cl_file_delete:accepted';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'cl_file_delete:refused'; END \$\$;
SELECT 'cl_audit:' || count(*) FROM audit_logs WHERE table_name = 'conform_run_data' AND record_id = '${CLK}c1';
SET LOCAL ROLE d1_llm_readonly;
SELECT 'cl_llm_sees:' || (SELECT count(*) FROM conform_logs) || ',' || (SELECT count(*) FROM conform_run_data);
RESET ROLE;
-- a log a run still uses cannot go (migration 210's trigger; 208 alone would have set the runs' log_id to NULL)
DO \$\$ BEGIN
    DELETE FROM conform_logs WHERE log_id = '${CLK}b1';
    RAISE NOTICE 'cl_log_delete_in_use:accepted';
EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'cl_log_delete_in_use:refused'; END \$\$;
SELECT 'cl_log_delete_kept:' || count(*) || ',' || count(*) FILTER (WHERE log_id IS NOT NULL) FROM conform_run_data WHERE id IN ('${CLK}c1', '${CLK}c2');
-- the operation goes: its run row goes with it
DELETE FROM manufacturing_operations WHERE operation_id = '${CLK}a1';
SELECT 'cl_op_delete_cascades:' || count(*) FROM conform_run_data WHERE id = '${CLK}c1';
$cl_down
SELECT 'cl_dn_tables:' || coalesce(to_regclass('conform_logs')::text, 'gone') || ',' || coalesce(to_regclass('conform_run_data')::text, 'gone');
SELECT 'cl_dn_meta:' || (SELECT count(*) FROM directus_fields WHERE collection IN ('conform_logs', 'conform_run_data') OR (collection = 'manufacturing_operations' AND field = 'conform_run'))
    || ',' || (SELECT count(*) FROM directus_collections WHERE collection IN ('conform_logs', 'conform_run_data'))
    || ',' || (SELECT count(*) FROM directus_permissions WHERE collection IN ('conform_logs', 'conform_run_data'))
    || ',' || (SELECT count(*) FROM directus_relations WHERE many_collection IN ('conform_logs', 'conform_run_data') OR one_collection IN ('conform_logs', 'conform_run_data'));
SELECT 'cl_dn_function:' || count(*) FROM pg_proc WHERE proname = 'conform_run_data_window_guard';
$cl_up
SELECT 'cl_up2_tables:' || (to_regclass('conform_logs') IS NOT NULL) || ',' || (to_regclass('conform_run_data') IS NOT NULL);
SELECT 'cl_up2_perms:' || (SELECT count(*) FROM directus_permissions WHERE collection IN ('conform_logs', 'conform_run_data'));
SELECT 'cl_up2_rls:' || (SELECT count(*) FROM pg_policies WHERE tablename IN ('conform_logs', 'conform_run_data'));
$cl_down
SELECT 'cl_redown_tables:' || coalesce(to_regclass('conform_logs')::text, 'gone') || ',' || coalesce(to_regclass('conform_run_data')::text, 'gone');
ROLLBACK;
SQL
)
cl_check() { grep -q "$1" <<<"$cl_out" && ok "$2" || bad "$2 (psql output: $cl_out)"; }
cl_check "^cl_tables:true,true$" "208: conform_logs and conform_run_data exist"
cl_check "^cl_uncommented:0$" "208: every column of both tables has a COMMENT"
cl_check "^cl_table_comments:2$" "208: both tables have a COMMENT"
cl_check "^cl_triggers:conform_logs.audit_conform_logs,conform_logs.occ_conform_logs,conform_logs.refuse_delete_in_use,conform_run_data.audit_conform_run_data,conform_run_data.conform_run_data_window_guard,conform_run_data.occ_conform_run_data,conform_run_data.sync_run_windows$" "208 and 210: audit, OCC, the window guard, the delete refusal and the run-window sync are attached"
cl_check "^cl_trigger_comments:0$" "208: every trigger has a COMMENT"
cl_check "^cl_llm:true,true$" "208: the Ask-the-database role can SELECT both tables"
cl_check "^cl_rls:2,4$" "208: both tables have row security (not forced) with the open and the d1_llm_readonly policy"
cl_check "^cl_collections:conform_logs/true/manufacturing_methods,conform_run_data/true/manufacturing_methods$" "208: both are hidden Directus collections grouped under manufacturing_methods"
cl_check "^cl_field_rows:17/18,12/12,0$" "208 and 210: every column of both tables has a Directus field row (the aliases are extra; 210 adds source_sha256 and run_windows)"
cl_check "^cl_aliases:conform_logs.runs=o2m,manufacturing_operations.conform_run=o2m$" "208: the O2M aliases manufacturing_operations.conform_run and conform_logs.runs exist"
cl_check "^cl_relations:conform_logs.created_by>directus_users,conform_logs.directus_files_id>directus_files,conform_logs.equipment_id>equipment,conform_run_data.log_id>conform_logs.runs,conform_run_data.operation_id>manufacturing_operations.conform_run$" "208: the five relations are registered"
cl_check "^cl_perm_lm:conform_logs.create,conform_logs.delete,conform_logs.read,conform_run_data.create,conform_run_data.delete,conform_run_data.read,conform_run_data.update$" "208: Lab Member rows: logs create/read/delete, run data create/read/update/delete"
cl_check "^cl_perm_viewer:conform_logs.read,conform_run_data.read$" "208: Lab Viewer reads both"
cl_check "^cl_log_defaults:1,true,true$" "208: a new log starts at version 1 with created_at set"
cl_check "^cl_run_x:accepted$" "208: run X with window 13:10-13:20 is accepted"
cl_check "cl_overlap:refused:run window overlaps 17-03-25-CF-091" "208: run Y with 13:15-13:30 is refused and the message names run X's code"
cl_check "^cl_touching:accepted$" "208: run Y with 13:20-13:30 is accepted (windows touch, half-open)"
cl_check "cl_overlap_update:refused:run window overlaps 17-03-25-CF-091" "208: moving a window start one second into the other run is refused on update"
cl_check "cl_outside_before:refused:run window lies outside the log" "208: a window starting before the log is refused (outside the log)"
cl_check "cl_outside_after:refused:run window lies outside the log" "208: a window ending after the log is refused (outside the log)"
cl_check "^cl_ends_at_log_end:accepted,[0-9]*$" "208: a window may end exactly at the log's last row"
cl_check "^cl_no_window:no_window$" "208: a run can be put back to no window"
cl_check "^cl_adjacent_before:accepted$" "208: a window touching the other one from before is accepted"
cl_check "cl_status_check:refused" "208: status pending is refused by the CHECK"
cl_check "cl_window_order_check:refused" "208: a window whose start is after its end is refused"
cl_check "cl_one_per_operation:refused" "208: one run row per operation"
cl_check "cl_file_delete:refused" "208: a file with a log row cannot be deleted before the log"
cl_check "^cl_audit:1$" "208: the run insert was audited"
cl_check "^cl_llm_sees:1,2$" "208: the Ask-the-database role sees the log and both runs of unrestricted operations"
cl_check "cl_log_delete_in_use:refused" "210: a log that runs still use cannot be deleted (restrict_violation)"
cl_check "^cl_log_delete_kept:2,2$" "210: the refused delete leaves both runs linked to the log"
cl_check "^cl_op_delete_cascades:0$" "208: deleting the operation deletes its run row"
cl_check "^cl_dn_tables:gone,gone$" "208 down: both tables are dropped"
cl_check "^cl_dn_meta:0,0,0,0$" "208 down: the Directus fields, collections, permissions and relations are removed"
cl_check "^cl_dn_function:0$" "208 down: the guard function is dropped"
cl_check "^cl_up2_tables:true,true$" "208 up again: both tables are back"
cl_check "^cl_up2_perms:9$" "208 up again: the nine permission rows are back"
cl_check "^cl_up2_rls:4$" "208 up again: the four row security policies are back"
cl_check "^cl_redown_tables:gone,gone$" "208 down runs again after up"
else
bad "the Conform logs and run data migration is missing ($CL_MIG)"
fi

echo "== Migration 209: the Conform group on the Operation form (block identical in configure_form_layout.sql, up, down, up) =="
CF_MIG=$(migration conform_form_layout)
if [[ -f "$CF_MIG" ]]; then
cf_mig=$(sed -n '/^-- BEGIN CONFORM FORM LAYOUT/,/^-- END CONFORM FORM LAYOUT/p' "$CF_MIG")
cf_cfg=$(sed -n '/^-- BEGIN CONFORM FORM LAYOUT/,/^-- END CONFORM FORM LAYOUT/p' scripts/configure_form_layout.sql)
[[ -n "$cf_mig" && "$cf_mig" == "$cf_cfg" ]] && ok "scripts/configure_form_layout.sql repeats the Conform layout block of migration 209" \
    || bad "scripts/configure_form_layout.sql and the Conform layout block of migration 209 differ (or a marker is missing)"
cf_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$CF_MIG")
cf_down=$(awk '/-- migrate:down/{f=1;next}f' "$CF_MIG")
cf_fields="('conform_run_number','conform_feedstock','conform_feedstock_form','conform_feed_mass_g','conform_die_diameter_mm','conform_tooling_id','conform_wheel_speed_rpm','conform_ips_setpoint_c','conform_extrusion_length_mm','conform_extrusion_mass_g','conform_yield_pct','conform_flash_mass_g')"
cf_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
SELECT 'cf_group:' || sort || '/' || options::text || '/' || (conditions::jsonb -> 0 ->> 'name') || '/' || (conditions::jsonb -> 0 -> 'rule' -> '_and' -> 0 -> 'process_category' ->> '_neq') || '/' || (conditions::jsonb -> 0 ->> 'hidden') || '/' || hidden || '/' || special || '/' || interface
  FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_conform';
SELECT 'cf_between:' || (SELECT sort FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_sample_prep') || '<' || (SELECT sort FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_conform')
  || '<' || (SELECT sort FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_notes_files');
SELECT 'cf_order:' || string_agg(field || '=' || sort, ',' ORDER BY sort) FROM directus_fields WHERE collection = 'manufacturing_operations' AND "group" = 'grp_conform';
SELECT 'cf_members:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND "group" = 'grp_conform' AND field IN $cf_fields AND width = 'half' AND hidden;
SELECT 'cf_alias:' || "group" || '/' || hidden || '/' || (conditions::jsonb -> 0 ->> 'name') FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'conform_run';
SELECT 'cf_alias_sort_free:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND "group" = 'grp_related'
  AND sort = (SELECT sort FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'conform_run') AND field <> 'conform_run';
SELECT 'cf_tied_sorts:' || count(*) FROM (SELECT 1 FROM directus_fields WHERE collection = 'manufacturing_operations' AND "group" IN ('grp_conform', 'grp_related')
  GROUP BY "group", sort HAVING count(*) > 1) t;
SELECT 'cf_backup:' || (SELECT count(*) FROM d1_private.conform_form_layout_209_backup) || '/' || (obj_description('d1_private.conform_form_layout_209_backup'::regclass, 'pg_class') IS NOT NULL);
$cf_down
SELECT 'cf_dn_group_row:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_conform';
SELECT 'cf_dn_fields:' || count(*) || '/' || count(*) FILTER (WHERE "group" IS NULL AND sort BETWEEN 600 AND 611 AND hidden) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field IN $cf_fields;
SELECT 'cf_dn_alias:' || coalesce("group", 'none') || '/' || sort || '/' || hidden || '/' || (conditions IS NULL) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'conform_run';
SELECT 'cf_dn_backup:' || coalesce(to_regclass('d1_private.conform_form_layout_209_backup')::text, 'gone');
$cf_up
SELECT 'cf_up2_members:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND "group" = 'grp_conform';
SELECT 'cf_up2_alias:' || "group" FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'conform_run';
$cf_up
SELECT 'cf_up3_group_rows:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_conform';
$cf_down
SELECT 'cf_redown_backup:' || coalesce(to_regclass('d1_private.conform_form_layout_209_backup')::text, 'gone');
ROLLBACK;
SQL
)
cf_check() { grep -qxF -- "$1" <<<"$cf_out" && ok "$2" || bad "$2 (psql output: $cf_out)"; }
cf_check 'cf_group:105/{"start" : "open"}/Hide unless conform/conform/true/false/alias,no-data,group/group-detail' "209: grp_conform is a group-detail at sort 105, open, with the condition Hide unless conform (_neq conform hides it)"
cf_check "cf_between:100<105<110" "209: it sits between Sample preparation (100) and Notes & files (110)"
cf_check "cf_order:conform_run_number=10,conform_feedstock=20,conform_feedstock_form=30,conform_feed_mass_g=40,conform_die_diameter_mm=50,conform_tooling_id=60,conform_wheel_speed_rpm=70,conform_ips_setpoint_c=80,conform_extrusion_length_mm=90,conform_extrusion_mass_g=100,conform_yield_pct=110,conform_flash_mass_g=120" "209: the twelve fields are in the planned order inside it"
cf_check "cf_members:12" "209: all twelve are half-width members of the group (and stay hidden at the base, shown by their own condition)"
cf_check "cf_alias:grp_related/true/show when conform" "209: conform_run joins Related records, hidden unless it is a Conform run"
cf_check "cf_alias_sort_free:0" "209: conform_run has a sort of its own in Related records"
cf_check "cf_tied_sorts:0" "209: no tied sorts inside grp_conform or grp_related"
cf_check "cf_backup:13/true" "209: the pre-image of the thirteen touched rows is kept in a commented private table"
cf_check "cf_dn_group_row:0" "209 down: the group row is deleted"
cf_check "cf_dn_fields:12/12" "209 down: the twelve fields are back outside any group at the sorts of migration 207"
cf_check "cf_dn_alias:none/52/false/true" "209 down: conform_run is back outside any group, shown, with no condition (as migration 208 made it)"
cf_check "cf_dn_backup:gone" "209 down: the backup table is dropped"
cf_check "cf_up2_members:12" "209 up again: the twelve fields are back in the group"
cf_check "cf_up2_alias:grp_related" "209 up again: conform_run is back in Related records"
cf_check "cf_up3_group_rows:1" "209 up twice: still one grp_conform row"
cf_check "cf_redown_backup:gone" "209 down runs again after up"
else
bad "the Conform form layout migration is missing ($CF_MIG)"
fi

echo "== Migration 210: Conform review fixes (source_sha256, run_windows, delete refusal, access, folder, sort, CF adoption; up, behaviour, down, up) =="
CR_MIG=$(migration conform_review_fixes)
if [[ -f "$CR_MIG" ]]; then
cr_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$CR_MIG")
cr_down=$(awk '/-- migrate:down/{f=1;next}f' "$CR_MIG")
K9=c0f90000-0000-4000-8000-0000000000
LMP=20000002-0000-0000-0000-000000000002
VWP=20000002-0000-0000-0000-000000000003
# the windows of one log as 'op@start/end op@start/end' (op = the last two characters of the operation id), in the order of the array
cr_win() { echo "(SELECT coalesce(string_agg(right(e ->> 'operation_id', 2) || '@' || (e ->> 'start') || '/' || (e ->> 'end'), ' ' ORDER BY n), '<none>') FROM conform_logs l, jsonb_array_elements(l.run_windows) WITH ORDINALITY AS t (e, n) WHERE l.log_id = '${K9}$1')"; }
cr_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
-- structure: the columns, constraints, functions and triggers 210 adds are commented and typed as the contract says
SELECT 'cr_sha_column:' || data_type || '/' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conform_logs' AND column_name = 'source_sha256';
SELECT 'cr_windows_column:' || data_type || '/' || is_nullable || '/' || column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conform_logs' AND column_name = 'run_windows';
SELECT 'cr_uncommented:' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('conform_logs', 'conform_run_data')
    AND col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) IS NULL);
SELECT 'cr_constraints:' || string_agg(conname || '=' || (obj_description(oid, 'pg_constraint') IS NOT NULL), ',' ORDER BY conname) FROM pg_constraint
    WHERE conrelid = 'conform_logs'::regclass AND conname IN ('conform_logs_source_sha256_key', 'conform_logs_source_sha256_check');
SELECT 'cr_functions:' || count(*) || '/' || count(*) FILTER (WHERE obj_description(oid, 'pg_proc') IS NOT NULL) FROM pg_proc
    WHERE proname IN ('conform_logs_refresh_run_windows', 'conform_run_data_sync_run_windows', 'conform_logs_refuse_delete_in_use');
SELECT 'cr_triggers:' || count(*) || '/' || count(*) FILTER (WHERE obj_description(oid, 'pg_trigger') IS NOT NULL) FROM pg_trigger
    WHERE tgname IN ('sync_run_windows', 'refuse_delete_in_use') AND NOT tgisinternal;
SELECT 'cr_field_rows:' || count(*) || '/' || count(*) FILTER (WHERE readonly) FROM directus_fields WHERE collection = 'conform_logs' AND field IN ('source_sha256', 'run_windows');
SELECT 'cr_sort:' || (SELECT sort FROM directus_collections WHERE collection = 'conform_logs') || ',' || (SELECT count(*) FROM directus_collections WHERE "group" = 'manufacturing_methods'
    AND sort = (SELECT sort FROM directus_collections WHERE collection = 'conform_logs'));
-- access, as stored
SELECT 'cr_logs_read_open:' || count(*) FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'read' AND permissions::jsonb = '{}'::jsonb AND policy IN ('$LMP', '$VWP');
SELECT 'cr_logs_create_fields:' || (position('source_sha256' IN fields) > 0) || ',' || (position('run_windows' IN fields) = 0) FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'create' AND policy = '$LMP';
SELECT 'cr_logs_no_update:' || count(*) FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'update';
SELECT 'cr_folder_rows:' || count(*) || '/' || count(*) FILTER (WHERE permissions::jsonb = '{"id":{"_eq":"c04f1000-0000-4000-8000-000000000001"}}'::jsonb) FROM directus_permissions
    WHERE collection = 'directus_folders' AND action = 'read' AND policy IN ('$LMP', '$VWP');
SELECT 'cr_folder_rows_only:' || count(*) FROM directus_permissions WHERE collection = 'directus_folders';
-- fixture: two logs on the Conform machine, two Conform operations
INSERT INTO directus_files (id) VALUES ('${K9}f1'), ('${K9}f2');
INSERT INTO physical_samples (sample_code, form) VALUES ('CRB-IN-1', 'powder'), ('CRB-IN-2', 'powder');
INSERT INTO manufacturing_operations (operation_id, sample_id, method_id, equipment_id, operation_date, conform_run_number)
SELECT v.op::uuid, (SELECT sample_id FROM physical_samples WHERE sample_code = v.sc), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'CF'),
       (SELECT equipment_id FROM equipment WHERE equipment_name = 'Conform'), '2025-03-17 13:00+00', v.run
FROM (VALUES ('${K9}a1', 'CRB-IN-1', 191), ('${K9}a2', 'CRB-IN-2', 192)) AS v (op, sc, run);
INSERT INTO conform_logs (log_id, directus_files_id, source_filename, source_sha256, log_start, log_end, n_rows, duration_s, series, totals, constants)
VALUES ('${K9}b1', '${K9}f1', 'one.csv', repeat('a', 64), '2025-03-17 13:00:00+00', '2025-03-17 14:00:00+00', 3601, 3600, '[]', '{}', '{}'),
       ('${K9}b2', '${K9}f2', 'two.csv', repeat('b', 64), '2025-03-17 15:00:00+00', '2025-03-17 16:00:00+00', 3601, 3600, '[]', '{}', '{}');
-- a second file with the same bytes, or a hash that is not 64 lowercase hex digits, or none, is refused
INSERT INTO directus_files (id) VALUES ('${K9}f3');
DO \$\$ BEGIN
    INSERT INTO conform_logs (directus_files_id, source_filename, source_sha256, log_start, log_end, n_rows, duration_s, series, totals, constants)
    VALUES ('${K9}f3', 'dup.csv', repeat('a', 64), '2025-03-17 13:00:00+00', '2025-03-17 14:00:00+00', 1, 0, '[]', '{}', '{}');
    RAISE NOTICE 'cr_sha_unique:accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'cr_sha_unique:refused:%', SQLERRM; END \$\$;
DO \$\$ BEGIN
    INSERT INTO conform_logs (directus_files_id, source_filename, source_sha256, log_start, log_end, n_rows, duration_s, series, totals, constants)
    VALUES ('${K9}f3', 'up.csv', upper(repeat('c', 64)), '2025-03-17 13:00:00+00', '2025-03-17 14:00:00+00', 1, 0, '[]', '{}', '{}');
    RAISE NOTICE 'cr_sha_format:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cr_sha_format:refused'; END \$\$;
DO \$\$ BEGIN
    INSERT INTO conform_logs (directus_files_id, source_filename, log_start, log_end, n_rows, duration_s, series, totals, constants)
    VALUES ('${K9}f3', 'none.csv', '2025-03-17 13:00:00+00', '2025-03-17 14:00:00+00', 1, 0, '[]', '{}', '{}');
    RAISE NOTICE 'cr_sha_required:accepted';
EXCEPTION WHEN not_null_violation THEN RAISE NOTICE 'cr_sha_required:refused'; END \$\$;
-- run_windows follows insert, update and delete of run windows
SELECT 'cr_win_empty:' || $(cr_win b1) || '/' || (SELECT run_windows::text FROM conform_logs WHERE log_id = '${K9}b1');
INSERT INTO conform_run_data (id, operation_id, log_id, window_start, window_end, status)
VALUES ('${K9}c1', '${K9}a1', '${K9}b1', '2025-03-17 13:10:00+00', '2025-03-17 13:20:00+00', 'done');
SELECT 'cr_win_insert:' || $(cr_win b1);
INSERT INTO conform_run_data (id, operation_id, log_id, window_start, window_end, status)
VALUES ('${K9}c2', '${K9}a2', '${K9}b1', '2025-03-17 13:30:00+00', '2025-03-17 13:40:00.123456+00', 'done');
SELECT 'cr_win_two:' || $(cr_win b1);
UPDATE conform_run_data SET window_start = '2025-03-17 13:50:00+00', window_end = '2025-03-17 13:55:00+00' WHERE id = '${K9}c1';
SELECT 'cr_win_update_sorted:' || $(cr_win b1);
UPDATE conform_run_data SET window_end = NULL WHERE id = '${K9}c2';
SELECT 'cr_win_one_end_left_out:' || $(cr_win b1);
UPDATE conform_run_data SET window_end = '2025-03-17 13:40:00+00' WHERE id = '${K9}c2';
SELECT 'cr_win_both_ends_again:' || $(cr_win b1);
UPDATE conform_run_data SET window_start = NULL, window_end = NULL, status = 'no_window' WHERE id = '${K9}c2';
SELECT 'cr_win_cleared:' || $(cr_win b1);
UPDATE conform_run_data SET log_id = '${K9}b2', window_start = '2025-03-17 15:10:00+00', window_end = '2025-03-17 15:20:00+00', status = 'done' WHERE id = '${K9}c2';
SELECT 'cr_win_moved_from:' || $(cr_win b1);
SELECT 'cr_win_moved_to:' || $(cr_win b2);
SELECT 'cr_win_version:' || version FROM conform_logs WHERE log_id = '${K9}b2';
UPDATE conform_run_data SET summary = '{"x":1}' WHERE id = '${K9}c2';
SELECT 'cr_win_other_column:' || version FROM conform_logs WHERE log_id = '${K9}b2';
DELETE FROM conform_run_data WHERE id = '${K9}c1';
SELECT 'cr_win_delete:' || $(cr_win b1);
-- a log a run still uses cannot be deleted, an unused one can
DO \$\$ BEGIN
    DELETE FROM conform_logs WHERE log_id = '${K9}b2';
    RAISE NOTICE 'cr_delete_in_use:accepted';
EXCEPTION WHEN restrict_violation THEN RAISE NOTICE 'cr_delete_in_use:refused:%', SQLERRM; END \$\$;
SELECT 'cr_delete_in_use_kept:' || (SELECT count(*) FROM conform_logs WHERE log_id = '${K9}b2') || ',' || (SELECT count(*) FROM conform_run_data WHERE id = '${K9}c2' AND log_id = '${K9}b2');
DELETE FROM conform_logs WHERE log_id = '${K9}b1';
SELECT 'cr_delete_unused:' || count(*) FROM conform_logs WHERE log_id = '${K9}b1';
INSERT INTO conform_logs (log_id, directus_files_id, source_filename, source_sha256, log_start, log_end, n_rows, duration_s, series, totals, constants)
VALUES ('${K9}b1', '${K9}f1', 'one.csv', repeat('a', 64), '2025-03-17 13:00:00+00', '2025-03-17 14:00:00+00', 3601, 3600, '[]', '{}', '{}');
INSERT INTO conform_run_data (id, operation_id, log_id, window_start, window_end, status)
VALUES ('${K9}c1', '${K9}a1', '${K9}b1', '2025-03-17 13:10:00+00', '2025-03-17 13:20:00+00', 'done');
-- the window guard of 208 is still there as the backstop
DO \$\$ BEGIN
    UPDATE conform_run_data SET log_id = '${K9}b1', window_start = '2025-03-17 13:15:00+00', window_end = '2025-03-17 13:30:00+00' WHERE id = '${K9}c2';
    RAISE NOTICE 'cr_guard_backstop:accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'cr_guard_backstop:refused:%', SQLERRM; END \$\$;
-- down: 208's state
$cr_down
SELECT 'cr_dn_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conform_logs' AND column_name IN ('source_sha256', 'run_windows');
SELECT 'cr_dn_objects:' || (SELECT count(*) FROM pg_proc WHERE proname IN ('conform_logs_refresh_run_windows', 'conform_run_data_sync_run_windows', 'conform_logs_refuse_delete_in_use'))
    || '/' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('sync_run_windows', 'refuse_delete_in_use') AND NOT tgisinternal);
SELECT 'cr_dn_field_rows:' || count(*) FROM directus_fields WHERE collection = 'conform_logs' AND field IN ('source_sha256', 'run_windows');
SELECT 'cr_dn_sort:' || (SELECT sort FROM directus_collections WHERE collection = 'conform_logs');
SELECT 'cr_dn_logs_read:' || (permissions::jsonb ? '_or') FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'read' AND policy = '$LMP';
SELECT 'cr_dn_logs_read_viewer:' || (permissions::jsonb ? '_or') FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'read' AND policy = '$VWP';
SELECT 'cr_dn_logs_create_fields:' || (position('source_sha256' IN fields) = 0) FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'create' AND policy = '$LMP';
SELECT 'cr_dn_folder_rows:' || count(*) FROM directus_permissions WHERE collection = 'directus_folders';
SELECT 'cr_dn_log_id_comment:' || (col_description('conform_run_data'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'conform_run_data'::regclass AND attname = 'log_id')) LIKE '%or after the log was deleted%');
SELECT 'cr_dn_runs:' || (SELECT count(*) FROM conform_run_data WHERE id IN ('${K9}c1', '${K9}c2'));
-- up again: the windows are recomputed from the runs, a log gets its placeholder hash
$cr_up
SELECT 'cr_up2_win_b1:' || $(cr_win b1);
SELECT 'cr_up2_win_b2:' || $(cr_win b2);
SELECT 'cr_up2_placeholder:' || count(*) || '/' || count(*) FILTER (WHERE source_sha256 = encode(sha256(convert_to(log_id::text, 'UTF8')), 'hex')) FROM conform_logs WHERE log_id IN ('${K9}b1', '${K9}b2');
SELECT 'cr_up2_sort:' || (SELECT sort FROM directus_collections WHERE collection = 'conform_logs');
SELECT 'cr_up2_folder_rows:' || count(*) FROM directus_permissions WHERE collection = 'directus_folders';
SELECT 'cr_up2_logs_read_open:' || count(*) FROM directus_permissions WHERE collection = 'conform_logs' AND action = 'read' AND permissions::jsonb = '{}'::jsonb;
$cr_down
SELECT 'cr_redown_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conform_logs' AND column_name IN ('source_sha256', 'run_windows');
ROLLBACK;
SQL
)
cr_check() { grep -qxF -- "$1" <<<"$cr_out" && ok "$2" || bad "$2 (wanted $1; psql output: $(echo "$cr_out" | head -60 | tr '\n' ' ' | cut -c1-900))"; }
cr_check "cr_sha_column:text/NO" "210: conform_logs.source_sha256 is text NOT NULL"
cr_check "cr_windows_column:jsonb/NO/'[]'::jsonb" "210: conform_logs.run_windows is jsonb NOT NULL DEFAULT '[]'"
cr_check "cr_uncommented:0" "210: every column of both Conform tables has a COMMENT (the two new ones included)"
cr_check "cr_constraints:conform_logs_source_sha256_check=true,conform_logs_source_sha256_key=true" "210: the unique and format constraints of source_sha256 exist and are commented"
cr_check "cr_functions:3/3" "210: the three new functions have a COMMENT"
cr_check "cr_triggers:2/2" "210: the two new triggers have a COMMENT"
cr_check "cr_field_rows:2/2" "210: source_sha256 and run_windows have a read-only Directus field row"
cr_check "cr_sort:13,1" "210: conform_logs has collection sort 13, which no other collection under manufacturing_methods has"
cr_check "cr_logs_read_open:2" "210: Lab Member and Lab Viewer read every conform_logs row (no filter)"
cr_check "cr_logs_create_fields:true,true" "210: a member may send source_sha256 when creating a log, and may not send run_windows"
cr_check "cr_logs_no_update:0" "210: no policy may update a log"
cr_check "cr_folder_rows:2/2" "210: Lab Member and Lab Viewer have a read row on directus_folders limited to the Conform Logs folder id"
cr_check "cr_folder_rows_only:2" "210: those two rows are the only directus_folders permission rows"
cr_notice() { grep -qF -- "$1" <<<"$cr_out" && ok "$2" || bad "$2 (wanted $1; psql output: $(echo "$cr_out" | head -60 | tr '\n' ' ' | cut -c1-900))"; }
cr_notice 'cr_sha_unique:refused:duplicate key value violates unique constraint "conform_logs_source_sha256_key"' "210: a second log with the same file hash is refused by the unique constraint"
cr_notice "cr_sha_format:refused" "210: a hash in capitals is refused"
cr_notice "cr_sha_required:refused" "210: a log without a hash is refused"
cr_check "cr_win_empty:<none>/[]" "210: a new log has run_windows []"
cr_check "cr_win_insert:a1@2025-03-17T13:10:00.000Z/2025-03-17T13:20:00.000Z" "210: inserting a run window puts it in run_windows (UTC ISO with milliseconds)"
cr_check "cr_win_two:a1@2025-03-17T13:10:00.000Z/2025-03-17T13:20:00.000Z a2@2025-03-17T13:30:00.000Z/2025-03-17T13:40:00.123Z" "210: a second window joins the list, sorted by start (milliseconds kept)"
cr_check "cr_win_update_sorted:a2@2025-03-17T13:30:00.000Z/2025-03-17T13:40:00.123Z a1@2025-03-17T13:50:00.000Z/2025-03-17T13:55:00.000Z" "210: updating a window re-sorts the list"
cr_check "cr_win_one_end_left_out:a1@2025-03-17T13:50:00.000Z/2025-03-17T13:55:00.000Z" "210: a run with only one window end is not in run_windows"
cr_check "cr_win_both_ends_again:a2@2025-03-17T13:30:00.000Z/2025-03-17T13:40:00.000Z a1@2025-03-17T13:50:00.000Z/2025-03-17T13:55:00.000Z" "210: setting the second end puts the run back"
cr_check "cr_win_cleared:a1@2025-03-17T13:50:00.000Z/2025-03-17T13:55:00.000Z" "210: clearing a run's window takes it out"
cr_check "cr_win_moved_from:a1@2025-03-17T13:50:00.000Z/2025-03-17T13:55:00.000Z" "210: moving a run to another log leaves the first log's other window alone"
cr_check "cr_win_moved_to:a2@2025-03-17T15:10:00.000Z/2025-03-17T15:20:00.000Z" "210: moving a run to another log adds it there"
cr_check "cr_win_other_column:$(grep -x 'cr_win_version:[0-9]*' <<<"$cr_out" | cut -d: -f2)" "210: an update of a run's summary does not touch the log (run_windows is only refreshed when the window changes)"
cr_check "cr_win_delete:<none>" "210: deleting the last run of a log empties its run_windows"
cr_check "cr_delete_in_use_kept:1,1" "210: the refused delete leaves the log and the run linked"
cr_check "cr_delete_unused:0" "210: a log no run uses can be deleted"
grep -q "cr_delete_in_use:refused:conform log .* is still used by a run: unlink it from the run first" <<<"$cr_out" && ok "210: deleting a log a run still uses is refused (restrict_violation) and says to unlink it first" || bad "210: deleting a log in use is not refused as expected (psql output: $(echo "$cr_out" | head -60 | tr '\n' ' ' | cut -c1-900))"
grep -q "cr_guard_backstop:refused:run window overlaps" <<<"$cr_out" && ok "210: the window guard of 208 still refuses an overlapping window at the database (the backstop)" || bad "210: the window guard no longer refuses overlap (psql output: $(echo "$cr_out" | head -60 | tr '\n' ' ' | cut -c1-900))"
cr_check "cr_dn_columns:0" "210 down: source_sha256 and run_windows are dropped"
cr_check "cr_dn_objects:0/0" "210 down: the functions and triggers are dropped"
cr_check "cr_dn_field_rows:0" "210 down: their Directus field rows are removed"
cr_check "cr_dn_sort:11" "210 down: conform_logs is back at collection sort 11"
cr_check "cr_dn_logs_read:true" "210 down: Lab Member's read row of conform_logs is the filtered one of migration 208"
cr_check "cr_dn_logs_read_viewer:true" "210 down: Lab Viewer's read row of conform_logs is the filtered one of migration 208"
cr_check "cr_dn_logs_create_fields:true" "210 down: the create field list has no source_sha256"
cr_check "cr_dn_folder_rows:0" "210 down: the directus_folders read rows are removed"
cr_check "cr_dn_log_id_comment:true" "210 down: the comment on conform_run_data.log_id is the one of migration 208"
cr_check "cr_dn_runs:2" "210 down: both runs are still there"
cr_check "cr_up2_win_b1:a1@2025-03-17T13:10:00.000Z/2025-03-17T13:20:00.000Z" "210 up again: run_windows is recomputed from the runs (log one)"
cr_check "cr_up2_win_b2:a2@2025-03-17T15:10:00.000Z/2025-03-17T15:20:00.000Z" "210 up again: run_windows is recomputed from the runs (log two)"
cr_check "cr_up2_placeholder:2/2" "210 up again: a log that exists gets the hash of its own id as a placeholder"
cr_check "cr_up2_sort:13" "210 up again: conform_logs is at collection sort 13"
cr_check "cr_up2_folder_rows:2" "210 up again: the two directus_folders read rows are back"
cr_check "cr_up2_logs_read_open:2" "210 up again: both read rows of conform_logs have no filter"
cr_check "cr_redown_columns:0" "210 down runs again after up"

# The folder: the CI database has no directus_folders table (a Directus system table), so the migration skips the seed there. A stub table made
# inside a rolled-back transaction proves the seed, its idempotence and that a folder with files in it is kept by the down.
cr_f_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
CREATE TABLE directus_folders (id uuid PRIMARY KEY, name text NOT NULL, parent uuid);
ALTER TABLE directus_files ADD COLUMN folder uuid;
$cr_down
$cr_up
SELECT 'cr_folder:' || count(*) || '/' || min(name) || '/' || coalesce(min(parent::text), 'root') FROM directus_folders WHERE id = 'c04f1000-0000-4000-8000-000000000001';
SELECT 'cr_folder_total:' || count(*) FROM directus_folders;
INSERT INTO directus_files (id, folder) VALUES ('${K9}f9', 'c04f1000-0000-4000-8000-000000000001');
$cr_down
SELECT 'cr_folder_kept:' || count(*) FROM directus_folders;
$cr_up
SELECT 'cr_folder_reup:' || count(*) FROM directus_folders;
DELETE FROM directus_files WHERE id = '${K9}f9';
$cr_down
SELECT 'cr_folder_gone:' || count(*) FROM directus_folders;
ROLLBACK;
SQL
)
cr_f_check() { grep -qxF -- "$1" <<<"$cr_f_out" && ok "$2" || bad "$2 (wanted $1; psql output: $(echo "$cr_f_out" | head -30 | tr '\n' ' ' | cut -c1-700))"; }
cr_f_check "cr_folder:1/Conform Logs/root" "210: the Conform Logs folder is seeded with the fixed id, at the root"
cr_f_check "cr_folder_total:1" "210: the seed adds that folder and nothing else"
cr_f_check "cr_folder_kept:1" "210 down: a folder with a file in it is kept"
cr_f_check "cr_folder_reup:1" "210 up again: the kept folder is not added twice"
cr_f_check "cr_folder_gone:0" "210 down: an empty folder is removed"

# The Lab Member rules the guard hook enforces (the generated rows): a member may create or repoint a conform_run_data row only for an
# operation they may edit, i.e. the operation's stored Lab Member UPDATE rule, which is what rules.json ships for operation_id.
cr_op_update=$($PSQL -At -c "SELECT permissions::text FROM directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000002' AND collection = 'manufacturing_operations' AND action = 'update'")
cr_guard=$(python3 - "$cr_op_update" <<'PY'
import json, sys
stored = json.loads(sys.argv[1])
guards = json.load(open('core/extensions/d1-access-guard/rules.json'))['guards']['conform_run_data']
ok = (
    [(g['field'], g['parent'], g['key']) for g in guards]
    == [('operation_id', 'manufacturing_operations', 'operation_id'), ('log_id', 'conform_logs', 'log_id')]
    and guards[0]['filter'] == stored
    and guards[1]['filter'] == {}
)
print('cr_guard:' + str(ok).lower())
PY
)
[[ "$cr_guard" == "cr_guard:true" ]] && ok "210: the guard hook's rules for conform_run_data are the operation's stored Lab Member update rule (the caller must be able to edit the operation) and an existing log" \
    || bad "210: the guard hook's rules for conform_run_data differ from the stored operation update rule ($cr_guard)"
run_eq "210: Lab Member create row of conform_run_data is still unfiltered (Directus ignores create filters; the hook does the work)" \
    "SELECT permissions::text FROM directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000002' AND collection = 'conform_run_data' AND action = 'create'" "{}"

# Migration 207's adoption gap: 207's down turns a Conform operation into deformation and its up only re-files method CF; 210's up adopts
# the operations again (and their lineage edges), and only those whose method is CF.
cr_a_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_code, form) VALUES ('CRA-IN', 'powder'), ('CRA-OUT', 'rod'), ('CRA-IN2', 'powder'), ('CRA-OUT2', 'rod');
INSERT INTO manufacturing_operations (operation_id, sample_id, output_sample_id, method_id, equipment_id, operation_date, conform_run_number, conform_die_diameter_mm)
SELECT '${K9}d1', (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-IN'), (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-OUT'),
       (SELECT method_id FROM manufacturing_methods WHERE method_code = 'CF'), (SELECT equipment_id FROM equipment WHERE equipment_name = 'Conform'), '2025-03-17 12:00+00', 12, 8;
INSERT INTO manufacturing_operations (operation_id, sample_id, output_sample_id, method_id, operation_date)
SELECT '${K9}d2', (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-IN2'), (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-OUT2'),
       (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MO'), '2025-03-17 12:00+00';
SELECT 'cr_a_before:' || string_agg(right(operation_id::text, 2) || '=' || process_category, ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id IN ('${K9}d1', '${K9}d2');
$cr_down
$cc_down
SELECT 'cr_a_after_207_down:' || string_agg(right(operation_id::text, 2) || '=' || process_category, ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id IN ('${K9}d1', '${K9}d2');
SELECT 'cr_a_edge_after_207_down:' || relationship_type FROM sample_genealogy WHERE child_sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-OUT');
$cc_up
SELECT 'cr_a_after_207_up:' || string_agg(right(operation_id::text, 2) || '=' || process_category, ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id IN ('${K9}d1', '${K9}d2');
SELECT 'cr_a_method:' || process_category FROM manufacturing_methods WHERE method_code = 'CF';
$cr_up
SELECT 'cr_a_after_210_up:' || string_agg(right(operation_id::text, 2) || '=' || process_category, ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id IN ('${K9}d1', '${K9}d2');
SELECT 'cr_a_edge:' || relationship_type FROM sample_genealogy WHERE child_sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-OUT');
SELECT 'cr_a_edge_other:' || relationship_type FROM sample_genealogy WHERE child_sample_id = (SELECT sample_id FROM physical_samples WHERE sample_code = 'CRA-OUT2');
SELECT 'cr_a_code:' || pass_code FROM manufacturing_operations WHERE operation_id = '${K9}d1';
ROLLBACK;
SQL
)
cr_a_check() { grep -qxF -- "$1" <<<"$cr_a_out" && ok "$2" || bad "$2 (wanted $1; psql output: $(echo "$cr_a_out" | head -30 | tr '\n' ' ' | cut -c1-900))"; }
cr_a_check "cr_a_before:d1=conform,d2=deformation" "210: a CF operation is a conform operation, an MO operation a deformation one (fixture)"
cr_a_check "cr_a_after_207_down:d1=deformation,d2=deformation" "207 down: the Conform operation goes back to deformation"
cr_a_check "cr_a_edge_after_207_down:derived_from" "207 down: its lineage edge becomes derived_from"
cr_a_check "cr_a_after_207_up:d1=deformation,d2=deformation" "207 up alone: the operation is not adopted (the gap)"
cr_a_check "cr_a_method:conform" "207 up: method CF is conform again"
cr_a_check "cr_a_after_210_up:d1=conform,d2=deformation" "210 up: the CF operation is a conform operation again, the other deformation operation is untouched"
cr_a_check "cr_a_edge:extruded_from" "210 up: the adopted operation's lineage edge is extruded_from again"
cr_a_check "cr_a_edge_other:derived_from" "210 up: the other operation's lineage edge is untouched"
else
bad "the Conform review fixes migration is missing ($CR_MIG)"
fi

