# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Directus forms can be saved (form QA, migration 173) =="
# Regression guards from driving the create forms on a copy of live (2026-10-14). A field naming an
# interface that is not installed renders as a raw text box (the Owner fields showed person UUIDs);
# a hidden required field blocks every save of its form (test sessions); a dropdown choice outside its
# CHECK constraint fails with HTTP 500 (Imaging / Analysis campaigns).
missing_ext=""
for ext in $($PSQL -c "SELECT DISTINCT x FROM (SELECT interface AS x FROM directus_fields UNION SELECT display FROM directus_fields) AS u WHERE x LIKE 'd1-%'" 2>/dev/null); do
    [[ -f "core/extensions/$ext/package.json" ]] || missing_ext="$missing_ext $ext"
done
[[ -z "$missing_ext" ]] && ok "every d1-* interface and display named in directus_fields is an extension in core/extensions" \
    || bad "directus_fields names extensions that are not in core/extensions:$missing_ext"
run_eq "no field is hidden, unconditional and required (the form could never be saved)" \
    "SELECT count(*) FROM directus_fields WHERE hidden AND required AND conditions IS NULL" \
    "0"
run_eq "every dropdown choice passes the column's CHECK constraint" \
    "SELECT count(*) FROM directus_fields AS f
     CROSS JOIN LATERAL json_array_elements(f.options -> 'choices') AS ch
     JOIN pg_class AS t ON t.relname = f.collection AND t.relnamespace = 'public'::regnamespace
     JOIN pg_attribute AS a ON a.attrelid = t.oid AND a.attname = f.field
     JOIN pg_constraint AS con ON con.conrelid = t.oid AND con.contype = 'c' AND con.conkey = ARRAY[a.attnum]
     WHERE f.interface IN ('select-dropdown', 'select-radio')
       AND pg_get_constraintdef(con.oid) ~ 'ANY \(ARRAY\['
       AND ch ->> 'value' NOT IN (SELECT m[1] FROM regexp_matches(pg_get_constraintdef(con.oid), '''([^'']*)''', 'g') AS m)" \
    "0"
MIG=$(migration form_blockers)
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG")
fb_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- this database already ran 173: undo it, seed the pre-173 metadata, then run up and down again
$mig_down
DELETE FROM directus_fields WHERE (collection, field) IN (('test_sessions','sample_id'),
  ('physical_samples','owner_person_id'), ('projects','principal_investigator_person'),
  ('manufacturing_operations','machining_operation_subtype'));
INSERT INTO directus_fields (collection, field, interface, options, hidden, required) VALUES
  ('test_sessions','sample_id','select-dropdown-m2o',NULL,true,true),
  ('physical_samples','owner_person_id','d1-owner-picker','{}',false,false),
  ('projects','principal_investigator_person','d1-owner-picker','{}',false,false),
  ('manufacturing_operations','machining_operation_subtype','select-dropdown','{"choices":[{"text":"Turning","value":"turning"}]}',false,false);
$mig_up
SELECT 'up_required:' || required FROM directus_fields WHERE collection='test_sessions' AND field='sample_id';
SELECT 'up_pickers:' || count(*) FROM directus_fields WHERE interface='select-dropdown-m2o' AND (collection, field) IN (('physical_samples','owner_person_id'),('projects','principal_investigator_person'));
SELECT 'up_subtype:' || (options::text LIKE '%"MT-F"%') FROM directus_fields WHERE field='machining_operation_subtype';
INSERT INTO campaigns (name, campaign_type) VALUES ('TEST-FB-173', 'imaging_analysis');
SELECT 'up_imaging:' || count(*) FROM campaigns WHERE name='TEST-FB-173';
$mig_down
SELECT 'down_required:' || required FROM directus_fields WHERE collection='test_sessions' AND field='sample_id';
SELECT 'down_pickers:' || count(*) FROM directus_fields WHERE interface='d1-owner-picker' AND (collection, field) IN (('physical_samples','owner_person_id'),('projects','principal_investigator_person'));
SELECT 'down_campaign:' || campaign_type FROM campaigns WHERE name='TEST-FB-173';
ROLLBACK;
SQL
)
expect_line fb_out "up_required:false" "173 up: test_sessions.sample_id is no longer required"
expect_line fb_out "up_pickers:2" "173 up: owner fields use the related-item dropdown"
expect_line fb_out "up_subtype:true" "173 up: machining sub-type offers the stored MT-/MM- codes"
expect_line fb_out "up_imaging:1" "173 up: an imaging_analysis campaign can be saved"
expect_line fb_out "down_required:true" "173 down: sample_id required again"
expect_line fb_out "down_pickers:2" "173 down: owner fields back on d1-owner-picker"
expect_line fb_out "down_campaign:testing_campaign" "173 down: imaging campaigns are mapped to testing_campaign"


echo "== Form layout (migration 174) =="
# Plan 2026-10-14-form-layout: Field groups on the six record forms, unique sorts, Lab Member field lists.
# Guards on whatever metadata the database has (CI: the part the migrations write; a copy of live: all of it).
FL_COLLECTIONS="'physical_samples','manufacturing_operations','test_sessions','projects','campaigns','raw_stock_lots','tools','equipment','insert_types','cutting_inserts'"
run_eq "no two visible fields of a form (same collection and group) share a sort, so Data Studio's order is the intended one" \
    "SELECT count(*) FROM (SELECT collection, \"group\", sort FROM directus_fields
       WHERE collection IN ($FL_COLLECTIONS) AND NOT hidden GROUP BY 1, 2, 3 HAVING count(*) > 1) AS t" \
    "0"
run_eq "every group-detail is a group (alias,no-data,group): without that special the form crashes" \
    "SELECT count(*) FROM directus_fields WHERE interface = 'group-detail' AND special IS DISTINCT FROM 'alias,no-data,group'" \
    "0"
run_eq "no group-detail is hidden at base (a conditional group is base-visible plus a hide-unless condition)" \
    "SELECT count(*) FROM directus_fields WHERE interface = 'group-detail' AND hidden" \
    "0"
run_eq "every field that names a group finds that group-detail in its own collection" \
    "SELECT count(*) FROM directus_fields AS f WHERE f.\"group\" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM directus_fields AS g WHERE g.collection = f.collection AND g.field = f.\"group\" AND g.interface = 'group-detail')" \
    "0"
# Lab Members cannot edit Co-owners or Secondary Investigators in the form (decision 5): the field lists of the create and
# update rows name every other column and alias, so a column added later must be added to scripts/access_rules.json
# ("field_sets") or members could not save it. Read stays '*'. On CI the alias rows of directus_fields are not there.
LM=20000002-0000-0000-0000-000000000002
for pair in "physical_samples:co_owners" "projects:secondary_investigators"; do
    fl_tbl=${pair%%:*}; fl_left=${pair##*:}
    for fl_act in create update; do
        fl_got=$($PSQL -c "SELECT coalesce(string_agg(x, ',' ORDER BY x), '') FROM (
            SELECT column_name::text AS x FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$fl_tbl'
            UNION SELECT field FROM directus_fields WHERE collection = '$fl_tbl' AND (special LIKE '%m2m%' OR special LIKE '%o2m%' OR special LIKE '%alias%') AND special NOT LIKE '%group%') c
          WHERE x <> ALL (string_to_array((SELECT fields FROM directus_permissions WHERE policy = '$LM' AND collection = '$fl_tbl' AND action = '$fl_act'), ','))" 2>&1)
        [[ "$fl_got" == "$fl_left" || "$fl_got" == "" ]] && ok "Lab Member $fl_tbl.$fl_act leaves out only $fl_left (got '$fl_got')" \
            || bad "Lab Member $fl_tbl.$fl_act field list misses columns or aliases: '$fl_got' (add them to field_sets in scripts/access_rules.json)"
    done
    run_eq "Lab Member $fl_tbl read keeps '*' (STARbase reads $fl_left; a read refusal is an HTTP 403)" \
        "SELECT fields FROM directus_permissions WHERE policy = '$LM' AND collection = '$fl_tbl' AND action = 'read'" "*"
done
# configure_form_layout.sql is the migration's layout block, so a configure run does not undo the forms.
MIG_FL=$(migration form_layout)
fl_mig=$(sed -n '/^-- BEGIN FORM LAYOUT/,/^-- END FORM LAYOUT/p' "$MIG_FL")
fl_cfg=$(sed -n '/^-- BEGIN FORM LAYOUT/,/^-- END FORM LAYOUT/p' scripts/configure_form_layout.sql)
[[ -n "$fl_mig" && "$fl_mig" == "$fl_cfg" ]] && ok "scripts/configure_form_layout.sql repeats the layout block of migration 174" \
    || bad "scripts/configure_form_layout.sql and the layout block of migration 174 differ (or a marker is missing)"
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG_FL")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG_FL")
fl_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- this database already ran 174: undo it, seed the metadata as it was before, then run up and down again
$mig_down
DELETE FROM directus_fields WHERE collection IN ($FL_COLLECTIONS);
INSERT INTO directus_fields (collection, field, special, interface, options, hidden, sort, width, conditions, required, "group", translations) VALUES
  ('physical_samples','report_button','alias,no-data','d1-report-button',NULL,false,0,'full',NULL,false,NULL,NULL),
  ('physical_samples','item_type',NULL,'select-dropdown',NULL,false,4,'half',NULL,false,NULL,NULL),
  ('physical_samples','form',NULL,'select-dropdown','{"choices":[]}',false,6,'half',
   '[{"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false}]',false,NULL,NULL),
  ('physical_samples','diameter_mm',NULL,'input',NULL,false,8,'half',
   '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc"]}}]}, "hidden": true}]',false,NULL,NULL),
  ('physical_samples','width_mm',NULL,'input',NULL,false,9,'half',
   '[{"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true},{"name":"form","rule":{"_and":[{"form":{"_nin":["ring","block"]}}]},"hidden":true}]',false,NULL,NULL),
  ('physical_samples','gauge_length_mm',NULL,'input',NULL,false,12,'half',
   '[{"name":"form","rule":{"_and":[{"form":{"_nin":["tensile_coupon"]}}]},"hidden":true}]',false,NULL,NULL),
  ('physical_samples','co_owners','m2m','list-m2m',NULL,false,22,'full',NULL,false,NULL,NULL),
  ('physical_samples','surface_finish',NULL,'select-dropdown','{"allowOther":true,"choices":[{"text":"None","value":"none"}]}',false,18,'half',NULL,false,NULL,NULL),
  ('manufacturing_operations','method_id','m2o','select-dropdown-m2o',NULL,false,2,'half',NULL,false,NULL,NULL),
  ('manufacturing_operations','sample_id','m2o','select-dropdown-m2o',NULL,false,4,'half',NULL,false,NULL,NULL),
  ('manufacturing_operations','process_category',NULL,'d1-process-category',NULL,false,3,'half',NULL,false,NULL,NULL),
  ('manufacturing_operations','project_id','m2o','select-dropdown-m2o',NULL,false,11,'half',NULL,false,NULL,NULL),
  ('manufacturing_operations','campaign_id','m2o','select-dropdown-m2o','{"template":"{{name}}","filter":{"campaign_type":{"_eq":"machining_trial"}}}',false,12,'half',NULL,false,NULL,NULL),
  ('manufacturing_operations','gcode_file','file','file',NULL,true,18,'full','[{"name":"show when machining","rule":{"_and":[{"process_category":{"_eq":"machining"}}]},"hidden":false}]',false,NULL,NULL),
  ('manufacturing_operations','sintering_machine_group','alias,no-data,group','group-detail','{"start":"open"}',false,60,'full',
   '[{"name":"Hide unless sintering","rule":{"_and":[{"process_category":{"_neq":"sintering"}}]},"hidden":true}]',false,NULL,NULL),
  ('manufacturing_operations','sintering_run_number',NULL,'input',NULL,false,0,'half',NULL,false,'sintering_machine_group',NULL),
  ('test_sessions','test_type',NULL,'select-dropdown',NULL,false,2,'half',NULL,false,NULL,NULL),
  ('test_sessions','session_date',NULL,'datetime',NULL,false,10,'half',NULL,false,NULL,NULL),
  ('test_sessions','tensile_uts_mpa',NULL,'input',NULL,true,110,'half','[{"name":"show when tensile","rule":{"_and":[{"test_type":{"_eq":"tensile"}}]},"hidden":false}]',false,NULL,NULL),
  ('test_sessions','capture_software',NULL,'input',NULL,false,610,'half',NULL,false,NULL,NULL),
  ('projects','project_name',NULL,'input',NULL,false,2,'half',NULL,true,NULL,NULL),
  ('projects','secondary_investigators','m2m','list-m2m',NULL,false,12,'full',NULL,false,NULL,NULL),
  ('campaigns','name',NULL,'input',NULL,false,4,'half',NULL,true,NULL,NULL),
  ('raw_stock_lots','lot_code',NULL,'input',NULL,false,2,'half',NULL,true,NULL,NULL),
  ('raw_stock_lots','supplier_name',NULL,'input',NULL,false,5,'half',NULL,false,NULL,NULL),
  ('tools','tool_name',NULL,'input',NULL,false,14,'half',NULL,false,NULL,NULL),
  ('tools','image',NULL,'file-image',NULL,false,14,'half',NULL,false,NULL,NULL),
  ('tools','op_type',NULL,'select-dropdown','{"choices":[{"text":"Turning","value":"Turning"}],"allowOther":true}',false,6,'half',NULL,false,NULL,NULL),
  ('equipment','equipment_type',NULL,'select-dropdown','{"choices":[{"text":"Machining","value":"Machining"},{"text":"Additive Manufacturing","value":"AM"}],"allowOther":true}',false,4,'half',NULL,false,NULL,NULL),
  ('insert_types','op_type',NULL,'select-dropdown','{"choices":[{"text":"Turning","value":"Turning"}],"allowOther":true}',false,4,'half',NULL,false,NULL,NULL);
DELETE FROM directus_collections WHERE collection IN ('physical_samples','manufacturing_operations','test_sessions');
INSERT INTO directus_collections (collection, translations) VALUES
  ('physical_samples', '[{"language":"en-US","translation":"Items","singular":"Item","plural":"Items"}]'),
  ('manufacturing_operations', '[{"language":"en-US","translation":"Manufacturing Operations","singular":"Operation","plural":"Operations"}]'),
  ('test_sessions', '[{"language":"en-US","translation":"Test Sessions","singular":"Test Session","plural":"Test Sessions"}]');
DELETE FROM directus_permissions WHERE policy = '$LM' AND collection IN ('physical_samples','projects') AND action IN ('create','update');
INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy) VALUES
  ('physical_samples','create','{}','{}','*','$LM'), ('physical_samples','update','{}','{}','*','$LM'),
  ('projects','create','{}','{}','*','$LM'), ('projects','update','{}','{}','*','$LM');
-- a hash of the seeded state, to prove the down section restores it exactly
CREATE TEMP TABLE _fl_before AS SELECT md5(string_agg(f::text, '|' ORDER BY id)) AS h FROM directus_fields AS f WHERE collection IN ($FL_COLLECTIONS);
CREATE TEMP TABLE _fl_before_c AS SELECT md5(string_agg(c::text, '|' ORDER BY collection)) AS h FROM directus_collections AS c;
CREATE TEMP TABLE _fl_before_p AS SELECT md5(string_agg(p::text, '|' ORDER BY id)) AS h FROM directus_permissions AS p WHERE policy = '$LM';
$mig_up
SELECT 'up_groups_valid:' || (count(*) FILTER (WHERE special = 'alias,no-data,group' AND interface = 'group-detail' AND NOT hidden) = count(*) AND count(*) > 60) FROM directus_fields WHERE field LIKE 'grp\_%';
SELECT 'up_sample_groups:' || string_agg(field, ',' ORDER BY sort) FROM directus_fields WHERE collection = 'physical_samples' AND field LIKE 'grp\_%';
SELECT 'up_related_collapsed:' || count(*) FROM directus_fields WHERE field = 'grp_related' AND options::text LIKE '%closed%' AND collection IN ('physical_samples','manufacturing_operations','test_sessions','projects','campaigns');
SELECT 'up_what_open:' || count(*) FROM directus_fields WHERE field = 'grp_what' AND options::text LIKE '%open%';
SELECT 'up_type_groups_conditional:' || count(*) FROM directus_fields WHERE collection = 'test_sessions' AND field LIKE 'grp\_%\_params' AND conditions IS NOT NULL;
SELECT 'up_sintering_nested:' || "group" FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_machine_group';
SELECT 'up_sintering_child_stays:' || "group" FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number';
SELECT 'up_form_condition:' || (conditions::text LIKE '%"_in":["equipment","miscellaneous"]%' AND conditions::text NOT LIKE '%_neq%') FROM directus_fields WHERE collection = 'physical_samples' AND field = 'form';
SELECT 'up_dimension_conditions:' || (conditions::text LIKE '%"_in":["equipment","miscellaneous"]%') || ',' || (conditions::text LIKE '%fatigue_specimen%') || ',' || (conditions::text LIKE '%charpy_specimen%') FROM directus_fields WHERE collection = 'physical_samples' AND field = 'width_mm';
SELECT 'up_gauge_conditions:' || (conditions::text LIKE '%fatigue_specimen%') || ',' || (conditions::text NOT LIKE '%charpy_specimen%') FROM directus_fields WHERE collection = 'physical_samples' AND field = 'gauge_length_mm';
SELECT 'up_form_choices:' || (SELECT string_agg(c ->> 'value', ',' ORDER BY ord) FROM json_array_elements(options -> 'choices') WITH ORDINALITY AS t (c, ord)) || '|' || (options::text LIKE '%Bend bar (ISO 7438)%' AND options::text LIKE '%Charpy specimen (ISO 148-1)%' AND options::text LIKE '%"Fatigue specimen"%') FROM directus_fields WHERE collection = 'physical_samples' AND field = 'form';
SELECT 'up_item_type_hidden:' || hidden FROM directus_fields WHERE collection = 'physical_samples' AND field = 'item_type';
SELECT 'up_form_required:' || required FROM directus_fields WHERE collection = 'physical_samples' AND field = 'form';
SELECT 'up_op_required:' || string_agg(field || '=' || required, ',' ORDER BY field) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field IN ('method_id','sample_id');
SELECT 'up_input_sample_when_machining:' || (conditions::text LIKE '%"required":true%' AND conditions::text LIKE '%machining%') FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sample_id';
SELECT 'up_test_required:' || string_agg(field || '=' || required, ',' ORDER BY field) FROM directus_fields WHERE collection = 'test_sessions' AND field IN ('test_type','session_date');
SELECT 'up_legacy_test_fields_hidden:' || hidden FROM directus_fields WHERE collection = 'test_sessions' AND field = 'capture_software';
SELECT 'up_gcode_hidden:' || hidden || ',' || (conditions IS NULL) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'gcode_file';
SELECT 'up_project_inherit:' || interface FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'project_id';
SELECT 'up_campaign_unfiltered:' || (options::jsonb ? 'filter') FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'campaign_id';
SELECT 'up_raw_new_fields:' || string_agg(field, ',' ORDER BY field) FROM directus_fields WHERE collection = 'raw_stock_lots' AND field IN ('purity_percent','mesh_size_micrometres','certificate_url');
SELECT 'up_surface_choices:' || (options::text LIKE '%as_produced%' AND options::text LIKE '%medium_machined%' AND options::text LIKE '%allowOther%') FROM directus_fields WHERE collection = 'physical_samples' AND field = 'surface_finish';
SELECT 'up_equipment_choices:' || jsonb_array_length((options::jsonb) -> 'choices') || ',' || (options::text NOT LIKE '%"AM"%') || ',' || (options::text LIKE '%"Sample_Prep"%' AND options::text LIKE '%Sample prep%') FROM directus_fields WHERE collection = 'equipment' AND field = 'equipment_type';
SELECT 'up_insert_application:' || (translations::text LIKE '%Application%') || ',' || (options::text LIKE '%Roughing%') || ',' || (options::text NOT LIKE '%allowOther%') FROM directus_fields WHERE collection = 'insert_types' AND field = 'op_type';
SELECT 'up_tools_choices:' || (options::text LIKE '%Parting%') FROM directus_fields WHERE collection = 'tools' AND field = 'op_type';
SELECT 'up_tied_sorts:' || count(*) FROM (SELECT 1 FROM directus_fields WHERE collection IN ($FL_COLLECTIONS) AND NOT hidden GROUP BY collection, "group", sort HAVING count(*) > 1) t;
SELECT 'up_tools_regrouped:' || count(*) FROM directus_fields WHERE collection = 'tools' AND "group" IS NOT NULL;
SELECT 'up_collection_names:' || string_agg(translations::jsonb -> 0 ->> 'translation', ',' ORDER BY collection) FROM directus_collections WHERE collection IN ('physical_samples','manufacturing_operations','test_sessions');
SELECT 'up_perm:' || collection || '.' || action || '=' || (fields LIKE 'sample_id,%' OR fields LIKE 'project_id,%') || ',' || NOT (string_to_array(fields, ',') && ARRAY['co_owners','secondary_investigators'])
  FROM directus_permissions WHERE policy = '$LM' AND collection IN ('physical_samples','projects') AND action IN ('create','update') ORDER BY 1;
SELECT 'up_backup_rows:' || kind || '=' || count(*) FROM d1_private.form_layout_174_backup GROUP BY kind ORDER BY kind;
SELECT 'up_backup_llm_select:' || has_table_privilege('d1_llm_readonly', 'd1_private.form_layout_174_backup', 'SELECT');
SELECT 'up_backup_commented:' || (obj_description('d1_private.form_layout_174_backup'::regclass, 'pg_class') IS NOT NULL);
-- the configure script's block is idempotent: running it on the migrated state changes nothing
CREATE TEMP TABLE _fl_mid AS SELECT md5(string_agg(f::text, '|' ORDER BY collection, field)) AS h FROM (SELECT collection, field, special, interface, options::text, hidden, sort, width, conditions::text, required, "group", translations::text FROM directus_fields WHERE collection IN ($FL_COLLECTIONS)) AS f;
$fl_cfg
SELECT 'again_same:' || ((SELECT h FROM _fl_mid) = md5(string_agg(f::text, '|' ORDER BY collection, field))) FROM (SELECT collection, field, special, interface, options::text, hidden, sort, width, conditions::text, required, "group", translations::text FROM directus_fields WHERE collection IN ($FL_COLLECTIONS)) AS f;
SELECT 'again_groups:' || count(*) FROM directus_fields WHERE field LIKE 'grp\_%';
$mig_down
SELECT 'down_groups:' || count(*) FROM directus_fields WHERE field LIKE 'grp\_%';
SELECT 'down_fields_exact:' || ((SELECT h FROM _fl_before) = md5(string_agg(f::text, '|' ORDER BY id))) FROM directus_fields AS f WHERE collection IN ($FL_COLLECTIONS);
SELECT 'down_collections_exact:' || ((SELECT h FROM _fl_before_c) = md5(string_agg(c::text, '|' ORDER BY collection))) FROM directus_collections AS c;
SELECT 'down_permissions_exact:' || ((SELECT h FROM _fl_before_p) = md5(string_agg(p::text, '|' ORDER BY id))) FROM directus_permissions AS p WHERE policy = '$LM';
SELECT 'down_raw_new_fields:' || count(*) FROM directus_fields WHERE collection = 'raw_stock_lots' AND field IN ('purity_percent','mesh_size_micrometres','certificate_url');
SELECT 'down_backup:' || coalesce(to_regclass('d1_private.form_layout_174_backup')::text, 'gone');
ROLLBACK;
SQL
)
expect_fixed fl_out "up_sample_groups:grp_what,grp_material,grp_geometry,grp_surface,grp_who_where,grp_notes,grp_related,grp_legacy" "174 up: the Sample form's Field groups, in the planned order"
expect_fixed fl_out "up_groups_valid:true" "174 up: every new group is a base-visible group-detail with special alias,no-data,group"
expect_fixed fl_out "up_related_collapsed:5" "174 up: Related records is collapsed on the Sample, Operation, Test, Project and Campaign forms"
expect_fixed fl_out "up_what_open:6" "174 up: What is open on all six forms"
expect_fixed fl_out "up_type_groups_conditional:16" "174 up: each of the 16 test types has a parameters group that is hidden unless that type is chosen"
expect_fixed fl_out "up_sintering_nested:grp_sintering" "174 up: the sintering machine group sits inside the Sintering group"
expect_fixed fl_out "up_sintering_child_stays:sintering_machine_group" "174 up: its children keep their group"
expect_fixed fl_out "up_form_condition:true" "174 up: Geometry hides only for the rig-kit values (a blank new form no longer hides it)"
expect_fixed fl_out "up_dimension_conditions:true,true,true" "174 up: Width shows for a fatigue specimen and a Charpy specimen, and still hides for a rig-kit row"
expect_fixed fl_out "up_gauge_conditions:true,true" "174 up: Gauge length shows for a fatigue specimen (like a tensile coupon) but not for a Charpy specimen"
expect_fixed fl_out "up_form_choices:disc,ring,cylinder,block,plate,bar,round_bar,tensile_coupon,fatigue_specimen,bend_bar,charpy_specimen,powder,other|true" "174 up: Geometry offers the 13 choices in the planned order, with the two new specimens and Bend bar (ISO 7438)"
expect_fixed fl_out "up_item_type_hidden:true" "174 up: Item Type is hidden"
expect_fixed fl_out "up_form_required:true" "174 up: Geometry is required in the form"
expect_fixed fl_out "up_op_required:method_id=true,sample_id=false" "174 up: Method is required; Input sample is required only through its machining condition"
expect_fixed fl_out "up_input_sample_when_machining:true" "174 up: Input sample is required when the process category is machining"
expect_fixed fl_out "up_test_required:session_date=true,test_type=true" "174 up: Test Type and Session Date are required"
expect_fixed fl_out "up_legacy_test_fields_hidden:true" "174 up: a legacy test field leaves the form"
expect_fixed fl_out "up_gcode_hidden:true,true" "174 up: the G-code file leaves the form and its show-when-machining condition is cleared"
expect_fixed fl_out "up_project_inherit:d1-project-inherit" "174 up: Project on an operation fills from its Campaign"
expect_fixed fl_out "up_campaign_unfiltered:false" "174 up: the Campaign picker is not filtered by campaign type"
expect_fixed fl_out "up_raw_new_fields:certificate_url,mesh_size_micrometres,purity_percent" "174 up: the raw stock lot's purity, mesh size and certificate fields get rows"
expect_fixed fl_out "up_surface_choices:true" "174 up: Surface Finish offers As produced and Medium machined"
expect_fixed fl_out "up_equipment_choices:29,true,true" "174 up: Equipment Type is the 29 stored values with readable text (AM dropped)"
expect_fixed fl_out "up_insert_application:true,true,true" "174 up: insert type 'Application' offers Finishing / Medium / Roughing only"
expect_fixed fl_out "up_tools_choices:true" "174 up: tools Op Type offers Parting"
expect_fixed fl_out "up_tied_sorts:0" "174 up: the seeded tied sorts (tools, forms) are unique"
expect_fixed fl_out "up_tools_regrouped:0" "174 up: Inventory forms are not regrouped"
expect_fixed fl_out "up_collection_names:Operations,Samples,Tests" "174 up: collections are named Operations, Samples and Tests in Data Studio"
expect_fixed fl_out "up_perm:physical_samples.create=true,true" "174 up: Lab Member physical_samples.create leaves out co_owners"
expect_fixed fl_out "up_perm:physical_samples.update=true,true" "174 up: Lab Member physical_samples.update leaves out co_owners"
expect_fixed fl_out "up_perm:projects.create=true,true" "174 up: Lab Member projects.create leaves out secondary_investigators"
expect_fixed fl_out "up_perm:projects.update=true,true" "174 up: Lab Member projects.update leaves out secondary_investigators"
expect_fixed fl_out "up_backup_llm_select:false" "174 up: the backup table is not readable by the Ask-DB role"
expect_fixed fl_out "up_backup_commented:true" "174 up: the backup table carries a comment"
expect_fixed fl_out "again_same:true" "174: the configure script's layout block, run on the migrated state, changes nothing"
expect_fixed fl_out "down_groups:0" "174 down: every Field group is removed"
expect_fixed fl_out "down_fields_exact:true" "174 down: every directus_fields row of the ten collections is exactly as before"
expect_fixed fl_out "down_collections_exact:true" "174 down: collection names are exactly as before"
expect_fixed fl_out "down_permissions_exact:true" "174 down: the Lab Member rows are exactly as before"
expect_fixed fl_out "down_raw_new_fields:0" "174 down: the raw stock lot rows it added are removed"
expect_fixed fl_out "down_backup:gone" "174 down: drops its backup table"

echo "== Sample geometry: round bar form migration =="
# CI has no Directus bootstrap rows (directus_fields is an empty stub), so seed the pre-migration
# state, apply the migration's up then down SQL, and assert both — all in a rolled-back transaction.
MIG=$(migration round_bar_form)
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG")
rb_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_fields WHERE collection='physical_samples' AND field IN ('form','diameter_mm','length_mm');
INSERT INTO directus_fields (collection, field, options, conditions) VALUES
  ('physical_samples','form','{"choices":[]}',NULL),
  ('physical_samples','diameter_mm',NULL,'[]'),
  ('physical_samples','length_mm',NULL,'[]');
INSERT INTO physical_samples (sample_code, form) VALUES ('TEST-RB-001','round_bar');
$mig_up
SELECT 'up_form_choice:' || count(*) FROM directus_fields
  WHERE field='form' AND options::text LIKE '%"round_bar"%';
SELECT 'up_dim_fields:' || count(*) FROM directus_fields
  WHERE field IN ('diameter_mm','length_mm') AND conditions::text LIKE '%"round_bar"%';
$mig_down
SELECT 'down_fields:' || count(*) FROM directus_fields
  WHERE collection='physical_samples' AND (options::text LIKE '%round_bar%' OR conditions::text LIKE '%round_bar%');
SELECT 'down_form:' || form FROM physical_samples WHERE sample_code='TEST-RB-001';
ROLLBACK;
SQL
)
expect_line rb_out "up_form_choice:1" "up: Geometry dropdown offers round_bar"
expect_line rb_out "up_dim_fields:2" "up: diameter_mm and length_mm are shown for round_bar"
expect_line rb_out "down_fields:0" "down: round_bar removed from dropdown and conditions"
expect_line rb_out "down_form:cylinder" "down: round_bar samples are mapped to cylinder"

echo "== Sample geometry: ring form migration =="
# Same shape as the round bar section: the column is real, the Directus rows are seeded stubs.
MIG=$(migration ring_form)
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG")
ring_out=$($PSQL 2>&1 <<SQL
BEGIN;
ALTER TABLE physical_samples DROP CONSTRAINT physical_samples_inner_diameter_mm_check;
ALTER TABLE physical_samples DROP COLUMN inner_diameter_mm;
DELETE FROM directus_fields WHERE collection='physical_samples' AND field IN ('form','diameter_mm','width_mm','length_mm','thickness_mm','inner_diameter_mm');
INSERT INTO directus_fields (collection, field, options, conditions) VALUES
  ('physical_samples','form','{"choices":[]}',NULL),
  ('physical_samples','diameter_mm',NULL,'[]'),
  ('physical_samples','width_mm',NULL,'[]'),
  ('physical_samples','length_mm',NULL,'[]'),
  ('physical_samples','thickness_mm',NULL,'[]');
$mig_up
SELECT 'up_form_choices:' || count(*) FROM directus_fields
  WHERE field='form' AND options::text LIKE '%"ring"%' AND options::text LIKE '%"round_bar"%';
SELECT 'up_dim_fields:' || count(*) FROM directus_fields
  WHERE field IN ('diameter_mm','width_mm','thickness_mm','inner_diameter_mm') AND conditions::text LIKE '%"ring"%';
INSERT INTO physical_samples (sample_code, form, diameter_mm, inner_diameter_mm, thickness_mm)
  VALUES ('TEST-RING-001','ring',151,19.5,16.5);
SAVEPOINT bad_bore;
INSERT INTO physical_samples (sample_code, form, diameter_mm, inner_diameter_mm) VALUES ('TEST-RING-002','ring',20,20);
SELECT 'bore_check:missing';
ROLLBACK TO SAVEPOINT bad_bore;
$mig_down
SELECT 'down_fields:' || count(*) FROM directus_fields
  WHERE collection='physical_samples' AND (options::text LIKE '%"ring"%' OR conditions::text LIKE '%"ring"%' OR field='inner_diameter_mm');
SELECT 'down_form:' || form FROM physical_samples WHERE sample_code='TEST-RING-001';
SELECT 'down_column:' || count(*) FROM information_schema.columns WHERE table_name='physical_samples' AND column_name='inner_diameter_mm';
ROLLBACK;
SQL
)
expect_line ring_out "up_form_choices:1" "up: Geometry dropdown offers ring (and round_bar)"
expect_line ring_out "up_dim_fields:4" "up: Ø, inner Ø, width and thickness are shown for ring"
grep -q "physical_samples_inner_diameter_mm_check" <<<"$ring_out" && ! grep -qx "bore_check:missing" <<<"$ring_out" \
  && ok "a bore as wide as the ring is refused" || bad "a bore as wide as the ring is refused (psql output: $ring_out)"
expect_line ring_out "down_fields:0" "down: ring removed from dropdown, conditions and fields"
expect_line ring_out "down_form:disc" "down: ring samples are mapped to disc"
expect_line ring_out "down_column:0" "down: inner_diameter_mm is dropped"

echo "== Label templates migration =="
# Run the file's down and up inside a rolled-back transaction (the Directus tables are stubs here, so
# the metadata rows are asserted by counting what the migration wrote).
LT=$(migration label_templates)
lt_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$LT")
lt_down=$(awk '/-- migrate:down/{f=1;next}f' "$LT")
lt_out=$($PSQL 2>&1 <<SQL
BEGIN;
$lt_down
SELECT 'down_table:' || coalesce(to_regclass('label_templates')::text, 'gone');
SELECT 'down_settings_table:' || coalesce(to_regclass('label_settings')::text, 'gone');
SELECT 'down_meta:' || (SELECT count(*) FROM directus_fields WHERE collection IN ('label_templates', 'label_settings'))
  || ',' || (SELECT count(*) FROM directus_collections WHERE collection IN ('label_templates', 'label_settings'))
  || ',' || (SELECT count(*) FROM directus_permissions WHERE collection IN ('label_templates', 'label_settings'))
  || ',' || (SELECT count(*) FROM directus_relations WHERE many_collection='label_templates');
$lt_up
SELECT 'up_seeds:' || string_agg(name, '|' ORDER BY name) FROM label_templates;
SELECT 'up_default:' || string_agg(name, '|') FROM label_templates WHERE is_default;
SELECT 'up_fields:' || count(*) FROM directus_fields WHERE collection='label_templates';
SELECT 'up_relations:' || count(*) FROM directus_relations WHERE many_collection='label_templates';
SELECT 'up_perm_rows:' || string_agg(action || '=' || permissions::text, ';' ORDER BY action)
  FROM directus_permissions WHERE collection='label_templates' AND policy='20000002-0000-0000-0000-000000000002';
SELECT 'up_perm_fields:' || string_agg(action || '=' || coalesce(array_length(string_to_array(fields, ','), 1), 0) || '/' || (fields ~ '(^|,)(id|is_default|user_created|user_updated|date_created|date_updated|updated_at|version)(,|$)'), ';' ORDER BY action)
  FROM directus_permissions WHERE collection='label_templates' AND policy='20000002-0000-0000-0000-000000000002';
SELECT 'up_comments:' || count(*) FROM information_schema.columns c
  WHERE c.table_name='label_templates' AND c.table_schema='public'
    AND col_description('label_templates'::regclass, c.ordinal_position::int) IS NULL;
SELECT 'up_tbl_comment:' || (obj_description('label_templates'::regclass) IS NOT NULL);
SELECT 'up_triggers:' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
  WHERE tgrelid='label_templates'::regclass AND NOT tgisinternal;
SAVEPOINT s1;
INSERT INTO label_templates (name, media, page_width_mm, page_height_mm, columns, rows, label_width_mm, label_height_mm, arrangement)
  VALUES ('t-roll', 'roll', 50, 25, 2, 1, 50, 25, 'qr_left');
SELECT 'roll_grid:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s2;
INSERT INTO label_templates (name, media, page_width_mm, page_height_mm, label_width_mm, label_height_mm, arrangement, is_default)
  VALUES ('t-second-default', 'sheet', 210, 297, 50, 50, 'text_only', true);
SELECT 'swap_insert:' || string_agg(name, '|') FROM label_templates WHERE is_default;
UPDATE label_templates SET is_default = true WHERE name = 'L7160 21-up';
SELECT 'swap_update:' || string_agg(name, '|') FROM label_templates WHERE is_default;
UPDATE label_templates SET description = 'x' WHERE name = 'L7160 21-up';
SELECT 'swap_unrelated_update:' || string_agg(name, '|') FROM label_templates WHERE is_default;
ROLLBACK TO SAVEPOINT s2;
SAVEPOINT s2b;
-- a failed insert (duplicate name) with is_default must leave the old default in place
DO \$\$ BEGIN
  INSERT INTO label_templates (name, media, page_width_mm, page_height_mm, label_width_mm, label_height_mm, arrangement, is_default)
    VALUES ('A4 4×5', 'sheet', 210, 297, 50, 50, 'text_only', true);
EXCEPTION WHEN unique_violation THEN NULL;
END \$\$;
SELECT 'swap_failed_insert:' || string_agg(name, '|') FROM label_templates WHERE is_default;
ROLLBACK TO SAVEPOINT s2b;
SAVEPOINT s3;
INSERT INTO label_templates (name, media, page_width_mm, page_height_mm, label_width_mm, label_height_mm, arrangement)
  VALUES ('A4 4×5', 'sheet', 210, 297, 50, 50, 'text_only');
SELECT 'dup_name:accepted';
ROLLBACK TO SAVEPOINT s3;
SAVEPOINT s4;
INSERT INTO label_templates (name, media, page_width_mm, page_height_mm, label_width_mm, label_height_mm, arrangement)
  VALUES ('t-bad-arr', 'sheet', 210, 297, 50, 50, 'qr_bottom');
SELECT 'bad_arrangement:accepted';
ROLLBACK TO SAVEPOINT s4;
UPDATE label_templates SET description = 'edited' WHERE name = 'L7160 21-up';
SELECT 'occ_version:' || version FROM label_templates WHERE name = 'L7160 21-up';
SELECT 'audit_updates:' || count(*) FROM audit_logs WHERE table_name = 'label_templates' AND action_type = 'UPDATE';
SELECT 'up_qr_all:' || count(*) FROM label_templates WHERE jsonb_array_length(qr_fields) = 6 AND qr_fields ? 'owner_email' AND qr_fields ? 'contact_email';
SELECT 'ls_row:' || count(*) || ',' || coalesce(max(contact_email), 'null') FROM label_settings;
SELECT 'ls_meta:' || (SELECT count(*) FROM directus_fields WHERE collection='label_settings')
  || ',' || (SELECT count(*) FROM directus_collections WHERE collection='label_settings' AND singleton);
SELECT 'ls_perm:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions
  WHERE collection='label_settings' AND policy='20000002-0000-0000-0000-000000000002';
SELECT 'ls_comments:' || count(*) FROM information_schema.columns c
  WHERE c.table_name='label_settings' AND c.table_schema='public'
    AND col_description('label_settings'::regclass, c.ordinal_position::int) IS NULL;
SELECT 'ls_triggers:' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
  WHERE tgrelid='label_settings'::regclass AND NOT tgisinternal;
SAVEPOINT s5;
INSERT INTO label_settings (id, contact_email) VALUES (2, NULL);
SELECT 'ls_second_row:accepted';
ROLLBACK TO SAVEPOINT s5;
SAVEPOINT s6;
UPDATE label_settings SET contact_email = 'not an email';
SELECT 'ls_bad_email:accepted';
ROLLBACK TO SAVEPOINT s6;
SAVEPOINT s6b;
UPDATE label_settings SET contact_email = 'a@bcd';
SELECT 'ls_no_dot_email:accepted';
ROLLBACK TO SAVEPOINT s6b;
SAVEPOINT s7;
UPDATE label_settings SET contact_email = 'lab@example.org';
SELECT 'ls_good_email:' || contact_email || ',v' || version FROM label_settings;
ROLLBACK TO SAVEPOINT s7;
$lt_down
SELECT 'redown_table:' || coalesce(to_regclass('label_templates')::text, 'gone');
ROLLBACK;
SQL
)
expect_fixed lt_out "down_table:gone" "down: label_templates is dropped"
expect_fixed lt_out "down_settings_table:gone" "down: label_settings is dropped"
expect_fixed lt_out "down_meta:0,0,0,0" "down: its Directus fields, collection, permissions and relations are removed"
expect_fixed lt_out "up_seeds:50×25 single|A4 4×5|Brother DK-22205 62 mm|L7160 21-up" "up: the four template seeds are present"
expect_fixed lt_out "up_default:A4 4×5" "up: A4 4×5 is the only default"
expect_fixed lt_out "up_fields:26" "up: every column has a Directus field row"
expect_fixed lt_out "up_relations:2" "up: user_created and user_updated relate to directus_users"
expect_fixed lt_out 'up_perm_rows:create={};delete={"user_created":{"_eq":"$CURRENT_USER"}};read={};update={"user_created":{"_eq":"$CURRENT_USER"}}' \
    "up: Lab Members read and create freely, update and delete only their own rows"
expect_fixed lt_out "up_perm_fields:create=18/false;delete=1/false;read=1/false;update=18/false"     "up: Lab Member create and update cannot set is_default, id or the system columns"
expect_fixed lt_out "up_qr_all:4" "up: every seed template puts all six extras in the QR"
expect_fixed lt_out "ls_row:1,null" "up: label_settings has its one row, with no contact yet"
expect_fixed lt_out "ls_meta:5,1" "up: label_settings is a Directus singleton with a field row per column"
expect_fixed lt_out "ls_perm:read" "up: Lab Members may only read label_settings"
expect_fixed lt_out "ls_comments:0" "up: every label_settings column carries a COMMENT"
expect_fixed lt_out "ls_triggers:audit_label_settings,occ_label_settings" "up: label_settings has the audit and OCC triggers"
! grep -qx "ls_second_row:accepted" <<<"$lt_out" && ok "a second label_settings row is refused" || bad "a second label_settings row is refused"
! grep -qx "ls_bad_email:accepted" <<<"$lt_out" && ok "a contact email without an @ is refused" || bad "a contact email without an @ is refused"
! grep -qx "ls_no_dot_email:accepted" <<<"$lt_out" && ok "a contact email with no dot after the @ (a@bcd) is refused" || bad "a contact email with no dot after the @ (a@bcd) is refused"
expect_fixed lt_out "ls_good_email:lab@example.org,v2" "a valid contact email is accepted and bumps version"
expect_fixed lt_out "up_comments:0" "up: every column carries a COMMENT"
expect_fixed lt_out "up_tbl_comment:true" "up: the table carries a COMMENT"
expect_fixed lt_out "up_triggers:audit_label_templates,label_templates_single_default,occ_label_templates" "up: audit, single-default and OCC triggers are attached"
! grep -qx "roll_grid:accepted" <<<"$lt_out" && ok "a roll with 2 columns is refused" || bad "a roll with 2 columns is refused"
expect_fixed lt_out "swap_insert:t-second-default" "inserting a default template clears the old default"
expect_fixed lt_out "swap_update:L7160 21-up" "making a template the default clears the old default"
expect_fixed lt_out "swap_unrelated_update:L7160 21-up" "an unrelated update keeps the default"
expect_fixed lt_out "swap_failed_insert:A4 4×5" "a failed insert with is_default keeps the old default"
! grep -qx "dup_name:accepted" <<<"$lt_out" && ok "a duplicate template name is refused" || bad "a duplicate template name is refused"
! grep -qx "bad_arrangement:accepted" <<<"$lt_out" && ok "an unknown arrangement is refused" || bad "an unknown arrangement is refused"
expect_fixed lt_out "occ_version:2" "an update bumps version"
expect_fixed lt_out "audit_updates:1" "an update of a template is audited"
expect_fixed lt_out "redown_table:gone" "down runs again after up"

echo "== Batches migration =="
# Process map slice 2 (ADR-0017): recorded batches. Down and up run inside a rolled-back transaction; the
# Directus tables are stubs here, so a stand-in field row for sintering_batch_number is seeded with its
# pre-migration translation ("Batch #", no note) and the metadata is asserted by reading what the SQL wrote.
BT=$(migration batches)
bt_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$BT")
bt_down=$(awk '/-- migrate:down/{f=1;next}f' "$BT")
bt_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
INSERT INTO directus_fields (collection, field, interface, display, hidden, sort, width, translations, note)
VALUES ('manufacturing_operations', 'sintering_batch_number', 'input', 'raw', true, 381, 'half',
        '[{"language": "en-US", "translation": "Batch #"}]', NULL);
$bt_down
SELECT 'down_table:' || coalesce(to_regclass('batches')::text, 'gone');
SELECT 'down_seq:' || coalesce(to_regclass('batches_code_seq')::text, 'gone');
SELECT 'down_cols:' || count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('manufacturing_operations', 'test_sessions') AND column_name = 'batch_id';
SELECT 'down_fn:' || count(*) FROM pg_proc WHERE proname IN ('batches_fill_code', 'batches_next_code');
SELECT 'down_meta:' || (SELECT count(*) FROM directus_fields WHERE collection = 'batches' OR field = 'batch_id')
  || ',' || (SELECT count(*) FROM directus_collections WHERE collection = 'batches')
  || ',' || (SELECT count(*) FROM directus_permissions WHERE collection = 'batches')
  || ',' || (SELECT count(*) FROM directus_relations WHERE many_collection = 'batches' OR one_collection = 'batches' OR many_field = 'batch_id');
SELECT 'down_powder:' || (translations::jsonb = '[{"language": "en-US", "translation": "Batch #"}]'::jsonb) || '/' || (note IS NULL)
  FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
$bt_up
SELECT 'up_powder:' || (translations::jsonb = '[{"language": "en-US", "translation": "Powder batch"}]'::jsonb) || '/' || note
  FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
SELECT 'up_powder_rows:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
SELECT 'up_nullable:' || string_agg(table_name || '=' || is_nullable, ',' ORDER BY table_name) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('manufacturing_operations', 'test_sessions') AND column_name = 'batch_id';
SELECT 'up_code_col:' || is_nullable || '/' || (column_default LIKE '%batches_next_code()%') FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'batches' AND column_name = 'code';
SELECT 'up_fk:' || string_agg(conrelid::regclass::text || '=' || confdeltype::text, ',' ORDER BY conrelid::regclass::text) FROM pg_constraint
  WHERE contype = 'f' AND confrelid = 'batches'::regclass AND conrelid IN ('manufacturing_operations'::regclass, 'test_sessions'::regclass);
SELECT 'up_indexes:' || string_agg(idx, ',' ORDER BY idx)
  FROM (SELECT indexname AS idx FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('manufacturing_operations', 'test_sessions')
          AND indexdef LIKE '%(batch_id)%') i;
SELECT 'up_comments:' || (SELECT count(*) FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'batches' AND col_description('batches'::regclass, c.ordinal_position::int) IS NULL)
  || ',' || (obj_description('batches'::regclass) IS NOT NULL)
  || ',' || (SELECT count(*) FROM pg_attribute WHERE attname = 'batch_id' AND attrelid IN ('manufacturing_operations'::regclass, 'test_sessions'::regclass)
              AND col_description(attrelid, attnum) IS NOT NULL);
SELECT 'up_triggers:' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'batches'::regclass AND NOT tgisinternal;
SELECT 'up_collection:' || icon || '/' || note FROM directus_collections WHERE collection = 'batches';
SELECT 'up_fields:' || count(*) FROM directus_fields WHERE collection = 'batches';
SELECT 'up_batch_id_fields:' || string_agg(collection || '/' || interface || '/' || (options::jsonb ->> 'template') || '/' || sort || '/' || note, ';' ORDER BY collection)
  FROM directus_fields WHERE field = 'batch_id' AND collection IN ('manufacturing_operations', 'test_sessions');
SELECT 'up_relations:' || count(*) FROM directus_relations WHERE many_collection = 'batches' OR one_collection = 'batches';
SELECT 'up_perm_rows:' || string_agg(action || '=' || permissions::text, ';' ORDER BY action)
  FROM directus_permissions WHERE collection = 'batches' AND policy = '20000002-0000-0000-0000-000000000002';
SELECT 'up_perm_fields:' || string_agg(action || '=' || fields, ';' ORDER BY action)
  FROM directus_permissions WHERE collection = 'batches' AND policy = '20000002-0000-0000-0000-000000000002';
INSERT INTO batches (batch_id, notes) VALUES ('c0000000-0000-4000-8000-0000000001b1', 'code left out');
INSERT INTO batches (batch_id, code, notes) VALUES ('c0000000-0000-4000-8000-0000000001b2', NULL, 'code sent as null');
INSERT INTO batches (batch_id, code) VALUES ('c0000000-0000-4000-8000-0000000001b3', '  ');
INSERT INTO batches (batch_id, code) VALUES ('c0000000-0000-4000-8000-0000000001b4', 'B-custom');
SELECT 'codes:' || string_agg(code, ',' ORDER BY batch_id) FROM batches;
-- the number is never truncated past four digits: the 10000th batch is B-10000, not B-1000
SELECT setval('batches_code_seq', 9999);
INSERT INTO batches (batch_id) VALUES ('c0000000-0000-4000-8000-0000000001b5');
INSERT INTO batches (batch_id, code) VALUES ('c0000000-0000-4000-8000-0000000001b6', NULL);
SELECT 'big_codes:' || string_agg(code, ',' ORDER BY batch_id) FROM batches WHERE batch_id IN ('c0000000-0000-4000-8000-0000000001b5', 'c0000000-0000-4000-8000-0000000001b6');
SAVEPOINT s1;
INSERT INTO batches (code) VALUES ('B-0001');
SELECT 'dup_code:accepted';
ROLLBACK TO SAVEPOINT s1;
UPDATE batches SET notes = 'edited' WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b4';
SELECT 'occ_version:' || version FROM batches WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b4';
SELECT 'audit:' || count(*) FROM audit_logs WHERE table_name = 'batches' AND record_id = 'c0000000-0000-4000-8000-0000000001b4';
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-0000000001a1', 'T-BATCH', 'batches test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-0000000001d1', 'TEST-BATCH-001');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code, batch_id) VALUES
  ('c0000000-0000-4000-8000-0000000001c1', 'c0000000-0000-4000-8000-0000000001a1', 'c0000000-0000-4000-8000-0000000001d1', 'TEST-BATCH-OP', 'c0000000-0000-4000-8000-0000000001b1');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code) VALUES
  ('c0000000-0000-4000-8000-0000000001c2', 'c0000000-0000-4000-8000-0000000001a1', 'c0000000-0000-4000-8000-0000000001d1', 'TEST-BATCH-OP-2');
INSERT INTO test_sessions (session_id, batch_id) VALUES ('c0000000-0000-4000-8000-0000000001e1', 'c0000000-0000-4000-8000-0000000001b1');
SELECT 'attached:' || (SELECT count(*) FROM manufacturing_operations WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b1')
  || ',' || (SELECT count(*) FROM test_sessions WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b1')
  || ',' || (SELECT count(*) FROM manufacturing_operations WHERE batch_id IS NULL AND operation_id = 'c0000000-0000-4000-8000-0000000001c2');
DELETE FROM batches WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b1';
SELECT 'detached:' || (SELECT count(*) FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-0000000001c1' AND batch_id IS NULL)
  || ',' || (SELECT count(*) FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001e1' AND batch_id IS NULL);
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-0000000001f1', 'Batch Owner');
UPDATE batches SET owner_person_id = 'c0000000-0000-4000-8000-0000000001f1' WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b2';
DELETE FROM people WHERE person_id = 'c0000000-0000-4000-8000-0000000001f1';
SELECT 'owner_cleared:' || (owner_person_id IS NULL) FROM batches WHERE batch_id = 'c0000000-0000-4000-8000-0000000001b2';
$bt_down
SELECT 'redown_table:' || coalesce(to_regclass('batches')::text, 'gone');
SELECT 'redown_powder:' || (translations::jsonb = '[{"language": "en-US", "translation": "Batch #"}]'::jsonb) || '/' || (note IS NULL)
  FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
SELECT 'redown_ops:' || count(*) FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-0000000001c2';
ROLLBACK;
SQL
)
expect_fixed bt_out "down_table:gone" "down: batches is dropped"
expect_fixed bt_out "down_seq:gone" "down: batches_code_seq is dropped"
expect_fixed bt_out "down_cols:0" "down: batch_id is dropped from operations and tests"
expect_fixed bt_out "down_fn:0" "down: the code-filling trigger function and batches_next_code() are dropped"
expect_fixed bt_out "down_meta:0,0,0,0" "down: its Directus fields, collection, permissions and relations are removed"
expect_fixed bt_out "down_powder:true/true" "down: sintering_batch_number is labelled Batch # again, with no note"
expect_fixed bt_out 'up_powder:true/The powder batch typed on the FAST press, e.g. TIMET 45-150. Names a raw stock lot but is not linked to it.' "up: sintering_batch_number is Powder batch, with its note"
expect_fixed bt_out "up_powder_rows:1" "up: sintering_batch_number keeps exactly one field row"
expect_fixed bt_out "up_nullable:manufacturing_operations=YES,test_sessions=YES" "up: batch_id is nullable on operations and tests"
expect_fixed bt_out "up_code_col:NO/true" "up: code is NOT NULL and defaults from batches_next_code()"
expect_fixed bt_out "up_fk:manufacturing_operations=n,test_sessions=n" "up: both batch_id foreign keys are ON DELETE SET NULL"
expect_fixed bt_out "up_indexes:idx_manufacturing_operations_batch_id,idx_test_sessions_batch_id" "up: both batch_id columns are indexed"
expect_fixed bt_out "up_comments:0,true,2" "up: every batches column, the table and both batch_id columns carry a COMMENT"
expect_fixed bt_out "big_codes:B-10000,B-10001" "past B-9999 a default and a null code keep counting (B-10000, B-10001) instead of truncating"
expect_fixed bt_out "up_triggers:audit_batches,batches_fill_code,occ_batches" "up: audit, code-filling and OCC triggers are attached"
expect_fixed bt_out "up_collection:inventory_2/Several operations or tests done together as one job" "up: batches is a Directus collection"
expect_fixed bt_out "up_fields:9" "up: every batches column has a Directus field row"
expect_fixed bt_out "up_batch_id_fields:manufacturing_operations/select-dropdown-m2o/{{code}}/11/Set when several samples were processed together as one job.;test_sessions/select-dropdown-m2o/{{code}}/9/Set when several samples were processed together as one job." \
    "up: the batch_id M2O pickers sit beside the date fields, with the note"
expect_fixed bt_out "up_relations:4" "up: batches relates to people and directus_users, operations and tests relate to batches"
expect_fixed bt_out 'up_perm_rows:create={};delete={"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}};read={};update={"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}' \
    "up: Lab Members read and create freely, update and delete only batches they own"
expect_fixed bt_out "up_perm_fields:create=code,batch_date,notes,owner_person_id;delete=*;read=*;update=code,batch_date,notes,owner_person_id" \
    "up: Lab Member create and update cannot touch the system columns"
expect_fixed bt_out "codes:B-0001,B-0002,B-0003,B-custom" "a batch gets B-0001-style codes whether code is left out, null or blank, and an explicit code is kept"
! grep -qx "dup_code:accepted" <<<"$bt_out" && ok "a duplicate batch code is refused" || bad "a duplicate batch code is refused"
expect_fixed bt_out "occ_version:2" "an update bumps version"
expect_fixed bt_out "audit:2" "an insert and an update of a batch are audited under its primary key"
expect_fixed bt_out "attached:1,1,1" "an operation and a test can join a batch, and an operation can have none"
expect_fixed bt_out "detached:1,1" "deleting a batch clears batch_id on its operations and tests"
expect_fixed bt_out "owner_cleared:true" "deleting the owner clears owner_person_id"
expect_fixed bt_out "redown_table:gone" "down runs again after up"
expect_fixed bt_out "redown_powder:true/true" "down after up restores the Batch # label"
expect_fixed bt_out "redown_ops:1" "down keeps the operation rows"

echo "== Planned work migration (ADR-0019) =="
# Process map edit mode, slice 1: work_state, planned_date, done_by_person_id, done_at on operations and tests, and the
# `planned` sample status. Down and up run inside a rolled-back transaction; the Directus tables are stubs here, so a
# stand-in Status field row (four choices) is seeded and the metadata is asserted by reading what the SQL wrote.
PW=$(migration planned_work)
pw_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$PW")
pw_down=$(awk '/-- migrate:down/{f=1;next}f' "$PW")
pw_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_fields WHERE collection = 'physical_samples' AND field = 'current_status';
INSERT INTO directus_fields (collection, field, interface, options, display, display_options, hidden, sort, width)
VALUES ('physical_samples', 'current_status', 'select-dropdown',
        '{"choices":[{"text":"Active","value":"active"},{"text":"Consumed","value":"consumed"},{"text":"Destroyed","value":"destroyed"},{"text":"Archived","value":"archived"}]}',
        'labels',
        '{"choices":[{"text":"Active","value":"active","foreground":"#2E7D32","background":"#E8F5E9"},{"text":"Archived","value":"archived","foreground":"#616161","background":"#F5F5F5"}]}',
        false, 8, 'half');
$pw_down
SELECT 'down_cols:' || count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('manufacturing_operations', 'test_sessions')
    AND column_name IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at');
SELECT 'down_meta:' || (SELECT count(*) FROM directus_fields WHERE collection IN ('manufacturing_operations', 'test_sessions') AND field IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at'))
  || ',' || (SELECT count(*) FROM directus_relations WHERE many_field = 'done_by_person_id');
SELECT 'down_status_check:' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'physical_samples_status_check';
SELECT 'down_status_comment:' || col_description('physical_samples'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'physical_samples'::regclass AND attname = 'current_status'));
SELECT 'down_choices:' || (SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(options::jsonb -> 'choices') c)
  || '/' || (SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(display_options::jsonb -> 'choices') c)
  FROM directus_fields WHERE collection = 'physical_samples' AND field = 'current_status';
$pw_up
SELECT 'up_cols:' || string_agg(table_name || '.' || column_name || '=' || data_type || '/' || is_nullable || '/' || coalesce(column_default, '-'), ';' ORDER BY table_name, column_name)
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('manufacturing_operations', 'test_sessions')
    AND column_name IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at');
SELECT 'up_checks:' || string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
  WHERE conname IN ('manufacturing_operations_work_state_check', 'test_sessions_work_state_check');
SELECT 'up_status_check:' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'physical_samples_status_check';
SELECT 'up_fk:' || string_agg(conrelid::regclass::text || '=' || confdeltype::text, ',' ORDER BY conrelid::regclass::text) FROM pg_constraint
  WHERE contype = 'f' AND confrelid = 'people'::regclass AND conrelid IN ('manufacturing_operations'::regclass, 'test_sessions'::regclass)
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = conrelid AND attname = 'done_by_person_id')];
SELECT 'up_indexes:' || string_agg(indexname || '=' || (indexdef LIKE '%WHERE (work_state = ''planned''::text)'), ',' ORDER BY indexname)
  FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_manufacturing_operations_work_state_planned', 'idx_test_sessions_work_state_planned');
SELECT 'up_done_by_indexes:' || string_agg(indexname || '=' || (indexdef LIKE '%(done_by_person_id) WHERE (done_by_person_id IS NOT NULL)'), ',' ORDER BY indexname)
  FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('idx_manufacturing_operations_done_by_person_id', 'idx_test_sessions_done_by_person_id');
SELECT 'up_comments:' || count(*) FROM pg_attribute
  WHERE attrelid IN ('manufacturing_operations'::regclass, 'test_sessions'::regclass)
    AND attname IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at') AND col_description(attrelid, attnum) IS NOT NULL;
SELECT 'up_status_comment:' || (col_description('physical_samples'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'physical_samples'::regclass AND attname = 'current_status')) LIKE '%planned%');
SELECT 'up_fields:' || string_agg(collection || '.' || field || '/' || interface || '/' || readonly || '/' || hidden || '/' || sort || '/' || coalesce("group", '-'), ';' ORDER BY collection, sort)
  FROM directus_fields WHERE collection IN ('manufacturing_operations', 'test_sessions') AND field IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at');
SELECT 'up_work_state_choices:' || string_agg(DISTINCT (options::jsonb -> 'choices')::text, ';')
  FROM directus_fields WHERE collection IN ('manufacturing_operations', 'test_sessions') AND field = 'work_state';
SELECT 'up_relations:' || count(*) FROM directus_relations
  WHERE many_field = 'done_by_person_id' AND many_collection IN ('manufacturing_operations', 'test_sessions') AND one_collection = 'people';
SELECT 'up_choices:' || (SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(options::jsonb -> 'choices') c)
  || '/' || (SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(display_options::jsonb -> 'choices') c)
  FROM directus_fields WHERE collection = 'physical_samples' AND field = 'current_status';
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-0000000185a1', 'Done By Person');
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-0000000185b1', 'T-PLAN', 'planned work test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-0000000185c1', 'TEST-PLAN-001');
INSERT INTO physical_samples (sample_id, sample_code, current_status) VALUES ('c0000000-0000-4000-8000-0000000185c2', 'TEST-PLAN-002', 'planned');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000185d1', 'c0000000-0000-4000-8000-0000000185b1', 'c0000000-0000-4000-8000-0000000185c1', 'TEST-PLAN-OP-1');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, output_sample_id, pass_code, work_state, planned_date)
VALUES ('c0000000-0000-4000-8000-0000000185d2', 'c0000000-0000-4000-8000-0000000185b1', 'c0000000-0000-4000-8000-0000000185c1',
        'c0000000-0000-4000-8000-0000000185c2', 'TEST-PLAN-OP-2', 'planned', '2026-11-02');
INSERT INTO test_sessions (session_id, sample_id) VALUES ('c0000000-0000-4000-8000-0000000185e1', 'c0000000-0000-4000-8000-0000000185c1');
INSERT INTO test_sessions (session_id, sample_id, work_state, planned_date)
VALUES ('c0000000-0000-4000-8000-0000000185e2', 'c0000000-0000-4000-8000-0000000185c1', 'planned', '2026-11-03');
SELECT 'default_done:' || (SELECT work_state FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d1')
  || ',' || (SELECT work_state FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000185e1');
SELECT 'planned_rows:' || (SELECT work_state || '/' || planned_date || '/' || (operation_date IS NULL) FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d2')
  || ',' || (SELECT work_state || '/' || planned_date || '/' || (session_date IS NULL) FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000185e2');
SELECT 'planned_sample:' || current_status FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-0000000185c2';
SAVEPOINT s1;
UPDATE manufacturing_operations SET work_state = 'cancelled' WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d1';
SELECT 'bad_op_state:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s2;
UPDATE test_sessions SET work_state = 'cancelled' WHERE session_id = 'c0000000-0000-4000-8000-0000000185e1';
SELECT 'bad_test_state:accepted';
ROLLBACK TO SAVEPOINT s2;
SAVEPOINT s3;
UPDATE manufacturing_operations SET work_state = NULL WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d1';
SELECT 'null_state:accepted';
ROLLBACK TO SAVEPOINT s3;
SAVEPOINT s4;
UPDATE physical_samples SET current_status = 'cancelled' WHERE sample_id = 'c0000000-0000-4000-8000-0000000185c1';
SELECT 'bad_sample_status:accepted';
ROLLBACK TO SAVEPOINT s4;
UPDATE manufacturing_operations SET work_state = 'done', done_by_person_id = 'c0000000-0000-4000-8000-0000000185a1', done_at = now()
  WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d2';
UPDATE physical_samples SET current_status = 'active' WHERE sample_id = 'c0000000-0000-4000-8000-0000000185c2';
SELECT 'marked_done:' || (SELECT work_state || '/' || (done_by_person_id IS NOT NULL) || '/' || (done_at IS NOT NULL) FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d2');
DELETE FROM people WHERE person_id = 'c0000000-0000-4000-8000-0000000185a1';
SELECT 'done_by_cleared:' || (done_by_person_id IS NULL) FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-0000000185d2';
UPDATE physical_samples SET current_status = 'planned' WHERE sample_id = 'c0000000-0000-4000-8000-0000000185c2';
$pw_down
SELECT 'redown_sample:' || current_status FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-0000000185c2';
SELECT 'redown_other_sample:' || current_status FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-0000000185c1';
SELECT 'redown_cols:' || count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('manufacturing_operations', 'test_sessions')
    AND column_name IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at');
SELECT 'redown_indexes:' || count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx\_%\_done\_by\_person\_id';
SELECT 'redown_rows:' || (SELECT count(*) FROM manufacturing_operations WHERE operation_id IN ('c0000000-0000-4000-8000-0000000185d1', 'c0000000-0000-4000-8000-0000000185d2'))
  || ',' || (SELECT count(*) FROM test_sessions WHERE session_id IN ('c0000000-0000-4000-8000-0000000185e1', 'c0000000-0000-4000-8000-0000000185e2'));
SELECT 'redown_meta:' || (SELECT count(*) FROM directus_fields WHERE collection IN ('manufacturing_operations', 'test_sessions') AND field IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at'))
  || ',' || (SELECT count(*) FROM directus_relations WHERE many_field = 'done_by_person_id');
SELECT 'redown_status_check:' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'physical_samples_status_check';
SELECT 'redown_choices:' || (SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(options::jsonb -> 'choices') c)
  || '/' || (SELECT string_agg(c ->> 'value', ',') FROM jsonb_array_elements(display_options::jsonb -> 'choices') c)
  FROM directus_fields WHERE collection = 'physical_samples' AND field = 'current_status';
ROLLBACK;
SQL
)
expect_fixed pw_out "down_cols:0" "down: the four work columns are gone from operations and tests"
expect_fixed pw_out "down_meta:0,0" "down: their Directus fields and relations are removed"
expect_fixed pw_out "down_status_check:CHECK ((current_status = ANY (ARRAY['active'::text, 'consumed'::text, 'destroyed'::text, 'archived'::text])))" "down: the sample status CHECK is the old four values"
expect_fixed pw_out "down_status_comment:Lifecycle state: active | consumed | destroyed | archived." "down: the current_status comment is restored"
expect_fixed pw_out "down_choices:active,consumed,destroyed,archived/active,archived" "down: the Status dropdown has no Planned choice (and a stand-in without one is unchanged)"
expect_fixed pw_out "up_cols:manufacturing_operations.done_at=timestamp with time zone/YES/-;manufacturing_operations.done_by_person_id=uuid/YES/-;manufacturing_operations.planned_date=date/YES/-;manufacturing_operations.work_state=text/NO/'done'::text;test_sessions.done_at=timestamp with time zone/YES/-;test_sessions.done_by_person_id=uuid/YES/-;test_sessions.planned_date=date/YES/-;test_sessions.work_state=text/NO/'done'::text" \
    "up: work_state is NOT NULL DEFAULT 'done'; planned_date, done_by_person_id and done_at are nullable"
expect_fixed pw_out "up_checks:manufacturing_operations_work_state_check,test_sessions_work_state_check" "up: both work_state CHECK constraints exist"
expect_fixed pw_out "up_status_check:CHECK ((current_status = ANY (ARRAY['active'::text, 'consumed'::text, 'destroyed'::text, 'archived'::text, 'planned'::text])))" "up: the sample status CHECK allows planned"
expect_fixed pw_out "up_fk:manufacturing_operations=n,test_sessions=n" "up: done_by_person_id is a foreign key to people, ON DELETE SET NULL, on both tables"
expect_fixed pw_out "up_indexes:idx_manufacturing_operations_work_state_planned=true,idx_test_sessions_work_state_planned=true" "up: partial indexes on work_state = 'planned'"
expect_fixed pw_out "up_done_by_indexes:idx_manufacturing_operations_done_by_person_id=true,idx_test_sessions_done_by_person_id=true" "up: partial indexes on done_by_person_id where it is set"
expect_fixed pw_out "up_comments:8" "up: all eight new columns carry a COMMENT"
expect_fixed pw_out "up_status_comment:true" "up: the current_status comment names planned"
expect_fixed pw_out "up_fields:manufacturing_operations.work_state/select-dropdown/true/false/80/grp_who_where;manufacturing_operations.planned_date/datetime/false/false/90/grp_who_where;manufacturing_operations.done_by_person_id/select-dropdown-m2o/true/false/100/grp_who_where;manufacturing_operations.done_at/datetime/true/false/110/grp_who_where;test_sessions.work_state/select-dropdown/true/false/70/grp_who_where;test_sessions.planned_date/datetime/false/false/80/grp_who_where;test_sessions.done_by_person_id/select-dropdown-m2o/true/false/90/grp_who_where;test_sessions.done_at/datetime/true/false/100/grp_who_where" \
    "up: work_state, done_by and done_at are read-only fields in the Who & where group; planned_date is editable beside them"
expect_fixed pw_out 'up_work_state_choices:[{"text": "Planned", "value": "planned"}, {"text": "Done", "value": "done"}]' "up: work_state offers Planned and Done"
expect_fixed pw_out "up_relations:2" "up: done_by_person_id relates to people on both collections"
expect_fixed pw_out "up_choices:active,consumed,destroyed,archived,planned/active,archived,planned" "up: the Status dropdown and its labels gain Planned, once"
expect_fixed pw_out "default_done:done,done" "an operation or test written without a work state is done"
expect_fixed pw_out "planned_rows:planned/2026-11-02/true,planned/2026-11-03/true" "a planned operation and a planned test carry a planned date and no operation or session date"
expect_fixed pw_out "planned_sample:planned" "a sample can be planned"
! grep -qx "bad_op_state:accepted" <<<"$pw_out" && ok "an operation work_state outside planned or done is refused" || bad "an operation work_state outside planned or done is refused"
! grep -qx "bad_test_state:accepted" <<<"$pw_out" && ok "a test work_state outside planned or done is refused" || bad "a test work_state outside planned or done is refused"
! grep -qx "null_state:accepted" <<<"$pw_out" && ok "work_state cannot be NULL" || bad "work_state cannot be NULL"
! grep -qx "bad_sample_status:accepted" <<<"$pw_out" && ok "a sample status outside the five is refused" || bad "a sample status outside the five is refused"
expect_fixed pw_out "marked_done:done/true/true" "marking an operation done keeps who and when"
expect_fixed pw_out "done_by_cleared:true" "deleting the person who marked it done clears done_by_person_id"
expect_fixed pw_out "redown_sample:archived" "down: a planned sample becomes archived"
expect_fixed pw_out "redown_other_sample:active" "down: other samples keep their status"
expect_fixed pw_out "redown_cols:0" "down after up: the work columns are gone"
expect_fixed pw_out "redown_indexes:0" "down after up: the work indexes are gone too"
expect_fixed pw_out "redown_rows:2,2" "down keeps the operation and test rows"
expect_fixed pw_out "redown_meta:0,0" "down after up: the Directus fields and relations are gone"
expect_fixed pw_out "redown_status_check:CHECK ((current_status = ANY (ARRAY['active'::text, 'consumed'::text, 'destroyed'::text, 'archived'::text])))" "down after up: the sample status CHECK is the old four values"
expect_fixed pw_out "redown_choices:active,consumed,destroyed,archived/active,archived" "down after up: Planned is removed from the Status dropdown and its labels"

echo "== Draft and template store migration (ADR-0018) =="
# Process map edit mode, slice 2: d1_private.process_drafts and process_templates, reached only through d1-build.
# Down and up run inside a rolled-back transaction.
BS=$(migration build_store)
bs_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$BS")
bs_down=$(awk '/-- migrate:down/{f=1;next}f' "$BS")
bs_out=$($PSQL 2>&1 <<SQL
BEGIN;
$bs_down
SELECT 'down_tables:' || count(*) FROM pg_tables WHERE schemaname = 'd1_private' AND tablename IN ('process_drafts', 'process_templates');
$bs_up
SELECT 'up_tables:' || string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables
  WHERE schemaname = 'd1_private' AND tablename IN ('process_drafts', 'process_templates');
SELECT 'up_public:' || count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('process_drafts', 'process_templates');
SELECT 'up_drafts_cols:' || string_agg(column_name || '/' || is_nullable || '/' || coalesce(column_default, '-'), ';' ORDER BY ordinal_position)
  FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'process_drafts';
SELECT 'up_templates_cols:' || string_agg(column_name || '/' || is_nullable, ';' ORDER BY ordinal_position)
  FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'process_templates';
SELECT 'up_comments:' || (SELECT count(*) FROM information_schema.columns c
    WHERE c.table_schema = 'd1_private' AND c.table_name IN ('process_drafts', 'process_templates')
      AND col_description((c.table_schema || '.' || c.table_name)::regclass, c.ordinal_position::int) IS NULL)
  || ',' || (obj_description('d1_private.process_drafts'::regclass) IS NOT NULL)
  || ',' || (obj_description('d1_private.process_templates'::regclass) IS NOT NULL);
SELECT 'up_indexes:' || string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
  WHERE schemaname = 'd1_private' AND tablename IN ('process_drafts', 'process_templates') AND indexname LIKE 'idx\_%';
SELECT 'up_llm_drafts:' || has_table_privilege('d1_llm_readonly', 'd1_private.process_drafts', 'SELECT')
  || ',' || has_table_privilege('d1_llm_readonly', 'd1_private.process_templates', 'SELECT');
INSERT INTO directus_users (id, email) VALUES ('c0000000-0000-4000-8000-0000000186a1', 'bs-a@example.test'),
                                              ('c0000000-0000-4000-8000-0000000186a2', 'bs-b@example.test');
INSERT INTO directus_roles (id, name) VALUES ('c0000000-0000-4000-8000-0000000186b1', 'BS role');
INSERT INTO d1_private.process_drafts (user_id, name, body)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'first', '{"v":1,"items":[],"wires":[],"positions":{}}');
INSERT INTO d1_private.process_drafts (draft_id, user_id, name, body)
VALUES ('c0000000-0000-4000-8000-0000000186d2', 'c0000000-0000-4000-8000-0000000186a1', 'second', '{"v":1}');
INSERT INTO d1_private.process_drafts (user_id, name, body)
VALUES ('c0000000-0000-4000-8000-0000000186a2', 'other person', '{"v":1}');
SELECT 'draft_defaults:' || (SELECT count(*) FROM d1_private.process_drafts WHERE user_id = 'c0000000-0000-4000-8000-0000000186a1' AND version = 1
  AND draft_id IS NOT NULL AND created_at IS NOT NULL AND updated_at IS NOT NULL);
SAVEPOINT s1;
INSERT INTO d1_private.process_drafts (user_id, name, body) VALUES ('c0000000-0000-4000-8000-0000000186a1', '  ', '{}');
SELECT 'blank_name:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s2;
INSERT INTO d1_private.process_drafts (user_id, name, body) VALUES ('c0000000-0000-4000-8000-0000000186a1', 'array body', '[]');
SELECT 'array_body:accepted';
ROLLBACK TO SAVEPOINT s2;
SAVEPOINT s3;
INSERT INTO d1_private.process_drafts (user_id, name, body) VALUES ('c0000000-0000-4000-8000-0000000186ff', 'no such user', '{}');
SELECT 'unknown_user:accepted';
ROLLBACK TO SAVEPOINT s3;
-- the endpoint's optimistic update: only the row at the named version changes
UPDATE d1_private.process_drafts SET name = 'renamed', version = version + 1, updated_at = now()
  WHERE draft_id = 'c0000000-0000-4000-8000-0000000186d2' AND user_id = 'c0000000-0000-4000-8000-0000000186a1' AND version = 1;
SELECT 'occ_hit:' || (SELECT version FROM d1_private.process_drafts WHERE draft_id = 'c0000000-0000-4000-8000-0000000186d2');
UPDATE d1_private.process_drafts SET name = 'stale', version = version + 1
  WHERE draft_id = 'c0000000-0000-4000-8000-0000000186d2' AND version = 1;
SELECT 'occ_stale:' || (SELECT name FROM d1_private.process_drafts WHERE draft_id = 'c0000000-0000-4000-8000-0000000186d2');
INSERT INTO d1_private.process_templates (user_id, scope, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'private', 'cut template', 'manufacturing_operations', '{"method_id":"m"}');
INSERT INTO d1_private.process_templates (user_id, scope, role_id, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'role', 'c0000000-0000-4000-8000-0000000186b1', 'role template', 'test_sessions', '{"test_type":"hardness"}');
INSERT INTO d1_private.process_templates (user_id, scope, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'global', 'global template', 'test_sessions', '{}');
SELECT 'template_defaults:' || (SELECT count(*) FROM d1_private.process_templates WHERE version = 1 AND template_id IS NOT NULL AND created_at IS NOT NULL AND updated_at IS NOT NULL);
SAVEPOINT s4;
INSERT INTO d1_private.process_templates (user_id, scope, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'team', 'bad scope', 'test_sessions', '{}');
SELECT 'bad_scope:accepted';
ROLLBACK TO SAVEPOINT s4;
SAVEPOINT s5;
INSERT INTO d1_private.process_templates (user_id, scope, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'role', 'role scope without role', 'test_sessions', '{}');
SELECT 'role_without_role:accepted';
ROLLBACK TO SAVEPOINT s5;
SAVEPOINT s6;
INSERT INTO d1_private.process_templates (user_id, scope, role_id, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'private', 'c0000000-0000-4000-8000-0000000186b1', 'private with role', 'test_sessions', '{}');
SELECT 'private_with_role:accepted';
ROLLBACK TO SAVEPOINT s6;
SAVEPOINT s7;
INSERT INTO d1_private.process_templates (user_id, scope, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'private', 'samples template', 'physical_samples', '{}');
SELECT 'sample_template:accepted';
ROLLBACK TO SAVEPOINT s7;
SAVEPOINT s8;
INSERT INTO d1_private.process_templates (user_id, scope, name, collection, values)
VALUES ('c0000000-0000-4000-8000-0000000186a1', 'private', 'array values', 'test_sessions', '[]');
SELECT 'array_values:accepted';
ROLLBACK TO SAVEPOINT s8;
-- a deleted role takes its role templates; a deleted login takes its drafts and templates
DELETE FROM directus_roles WHERE id = 'c0000000-0000-4000-8000-0000000186b1';
SELECT 'role_gone:' || (SELECT count(*) FROM d1_private.process_templates WHERE scope = 'role');
DELETE FROM directus_users WHERE id = 'c0000000-0000-4000-8000-0000000186a1';
SELECT 'user_gone:' || (SELECT count(*) FROM d1_private.process_drafts WHERE user_id = 'c0000000-0000-4000-8000-0000000186a1')
  || ',' || (SELECT count(*) FROM d1_private.process_templates WHERE user_id = 'c0000000-0000-4000-8000-0000000186a1')
  || ',' || (SELECT count(*) FROM d1_private.process_drafts WHERE user_id = 'c0000000-0000-4000-8000-0000000186a2');
$bs_down
SELECT 'redown_tables:' || count(*) FROM pg_tables WHERE schemaname = 'd1_private' AND tablename IN ('process_drafts', 'process_templates');
ROLLBACK;
SQL
)
expect_fixed bs_out "down_tables:0" "down: both tables are dropped"
expect_fixed bs_out "up_tables:process_drafts,process_templates" "up: process_drafts and process_templates exist in d1_private"
expect_fixed bs_out "up_public:0" "up: neither table is in public (outside the Directus schema scan)"
expect_fixed bs_out "up_drafts_cols:draft_id/NO/gen_random_uuid();user_id/NO/-;name/NO/-;body/NO/-;created_at/NO/now();updated_at/NO/now();version/NO/1" "up: drafts columns, NOT NULLs and defaults"
expect_fixed bs_out "up_templates_cols:template_id/NO;user_id/NO;scope/NO;role_id/YES;name/NO;collection/NO;values/NO;created_at/NO;updated_at/NO;version/NO" "up: templates columns and NOT NULLs"
expect_fixed bs_out "up_comments:0,true,true" "up: every column of both tables and both tables carry a COMMENT"
expect_fixed bs_out "up_indexes:idx_process_drafts_user_updated,idx_process_templates_scope_role,idx_process_templates_user_updated" "up: the owner and scope indexes exist"
expect_fixed bs_out "up_llm_drafts:false,false" "d1_llm_readonly cannot read drafts or templates"
expect_fixed bs_out "draft_defaults:2" "a draft gets an id, timestamps and version 1"
! grep -qx "blank_name:accepted" <<<"$bs_out" && ok "a blank draft name is refused" || bad "a blank draft name is refused"
! grep -qx "array_body:accepted" <<<"$bs_out" && ok "a draft body that is not a JSON object is refused" || bad "a draft body that is not a JSON object is refused"
! grep -qx "unknown_user:accepted" <<<"$bs_out" && ok "a draft for a login that does not exist is refused" || bad "a draft for a login that does not exist is refused"
expect_fixed bs_out "occ_hit:2" "the endpoint's versioned update changes the row at the named version"
expect_fixed bs_out "occ_stale:renamed" "an update naming a stale version changes nothing"
expect_fixed bs_out "template_defaults:3" "private, role and global templates are accepted with defaults"
! grep -qx "bad_scope:accepted" <<<"$bs_out" && ok "a template scope other than private, role, global is refused" || bad "a template scope other than private, role, global is refused"
! grep -qx "role_without_role:accepted" <<<"$bs_out" && ok "a role-scope template without a role is refused" || bad "a role-scope template without a role is refused"
! grep -qx "private_with_role:accepted" <<<"$bs_out" && ok "a private template with a role is refused" || bad "a private template with a role is refused"
! grep -qx "sample_template:accepted" <<<"$bs_out" && ok "templates hold operations and tests only" || bad "templates hold operations and tests only"
! grep -qx "array_values:accepted" <<<"$bs_out" && ok "template values must be a JSON object" || bad "template values must be a JSON object"
expect_fixed bs_out "role_gone:0" "deleting a role deletes the templates shared with it"
expect_fixed bs_out "user_gone:0,0,1" "deleting a login deletes its drafts and templates, and only theirs"
expect_fixed bs_out "redown_tables:0" "down after up drops both tables"

echo "== Form condition fixes (migration 191) =="
# Migration 174's "Hide until saved once" and "show when it has a value" rules used _empty / _nempty, which in Directus 11 mean
# '' and not-'' (null counts as nempty). Directus is a stub here, so seed the 174 rules, run the up and the down, and read
# the conditions back, all in a rolled-back transaction.
CF=$(migration form_condition_fixes)
cf_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$CF")
cf_down=$(awk '/-- migrate:down/{f=1;next}f' "$CF")
cf_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_fields WHERE (field = 'grp_related' AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions'))
   OR (collection = 'manufacturing_operations' AND field IN ('machining_legacy_insert_edge_id', 'machining_legacy_machining_uid',
       'file_storage_pointer', 'capture_software', 'capture_frequency_khz', 'nc_program_text', 'nc_program_file_uri'))
   OR (collection = 'physical_samples' AND field = 'capture_software');
INSERT INTO directus_fields (collection, field, interface, conditions)
SELECT c, 'grp_related', 'group-detail',
       '[{"name":"Hide until saved once","rule":{"_and":[{"short_id":{"_empty":true}}]},"hidden":true}]'::json
FROM unnest(ARRAY['physical_samples', 'manufacturing_operations', 'test_sessions']) AS c;
INSERT INTO directus_fields (collection, field, interface, conditions)
SELECT 'manufacturing_operations', f, 'input',
       ('[{"name":"show when it has a value","rule":{"_and":[{"' || f || '":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]')::json
FROM unnest(ARRAY['machining_legacy_insert_edge_id', 'machining_legacy_machining_uid', 'file_storage_pointer', 'capture_software',
                  'capture_frequency_khz', 'nc_program_text', 'nc_program_file_uri']) AS f;
-- the same shape on another collection, and a field whose rule is not one of the six: both must be left alone
INSERT INTO directus_fields (collection, field, interface, conditions)
VALUES ('physical_samples', 'capture_software', 'input',
        '[{"name":"show when it has a value","rule":{"_and":[{"capture_software":{"_nempty":true}}]},"hidden":false}]');
CREATE TEMP TABLE _before AS SELECT collection, field, conditions::jsonb AS c FROM directus_fields
  WHERE (field = 'grp_related' AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions'))
     OR (collection = 'manufacturing_operations' AND field IN ('machining_legacy_insert_edge_id', 'machining_legacy_machining_uid',
         'file_storage_pointer', 'capture_software', 'capture_frequency_khz', 'nc_program_text', 'nc_program_file_uri'))
     OR (collection = 'physical_samples' AND field = 'capture_software');
$cf_up
SELECT 'up_group:' || string_agg(collection || '=' || (conditions::jsonb -> 0 -> 'rule' = '{"_or":[{"short_id":{"_null":true}},{"short_id":{"_empty":true}}]}'::jsonb)
  || '/' || (conditions::jsonb -> 0 ->> 'name') || '/' || (conditions::jsonb -> 0 ->> 'hidden') || '/' || jsonb_array_length(conditions::jsonb), ',' ORDER BY collection)
  FROM directus_fields WHERE field = 'grp_related' AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
SELECT 'up_fields:' || string_agg(field || '=' || (conditions::jsonb -> 0 -> 'rule' = jsonb_build_object('_and', jsonb_build_array(
    jsonb_build_object(field, jsonb_build_object('_nnull', true)), jsonb_build_object(field, jsonb_build_object('_neq', '')))))
  || '/' || (conditions::jsonb -> 0 ->> 'name') || '/' || (conditions::jsonb -> 0 ->> 'hidden') || '/' || (conditions::jsonb -> 0 ->> 'readonly')
  || '/' || (conditions::jsonb -> 0 ->> 'required'), ',' ORDER BY field)
  FROM directus_fields WHERE collection = 'manufacturing_operations'
    AND field IN ('machining_legacy_insert_edge_id', 'machining_legacy_machining_uid', 'file_storage_pointer', 'capture_software', 'capture_frequency_khz', 'nc_program_text');
SELECT 'up_untouched:' || (SELECT (conditions::jsonb = b.c) FROM directus_fields f JOIN _before b USING (collection, field)
    WHERE f.collection = 'manufacturing_operations' AND f.field = 'nc_program_file_uri')
  || '/' || (SELECT (conditions::jsonb = b.c) FROM directus_fields f JOIN _before b USING (collection, field)
    WHERE f.collection = 'physical_samples' AND f.field = 'capture_software');
SELECT 'up_no_old_rules:' || count(*) FROM directus_fields WHERE collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions')
  AND ((field = 'grp_related' AND position('"_and"' in conditions::text) > 0) OR (collection = 'manufacturing_operations' AND field <> 'nc_program_file_uri' AND position('_nempty' in conditions::text) > 0));
$cf_down
SELECT 'down_restored:' || (SELECT count(*) FROM directus_fields f JOIN _before b USING (collection, field) WHERE f.conditions::jsonb = b.c)
  || '/' || (SELECT count(*) FROM _before);
$cf_up
SELECT 'reup:' || (SELECT conditions::jsonb -> 0 -> 'rule' = '{"_or":[{"short_id":{"_null":true}},{"short_id":{"_empty":true}}]}'::jsonb FROM directus_fields
    WHERE field = 'grp_related' AND collection = 'test_sessions')
  || '/' || (SELECT conditions::jsonb -> 0 -> 'rule' = '{"_and":[{"nc_program_text":{"_nnull":true}},{"nc_program_text":{"_neq":""}}]}'::jsonb
    FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'nc_program_text');
$cf_up
SELECT 'up_twice:' || (SELECT conditions::jsonb -> 0 -> 'rule' = '{"_and":[{"nc_program_text":{"_nnull":true}},{"nc_program_text":{"_neq":""}}]}'::jsonb
    FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'nc_program_text');
ROLLBACK;
SQL
)
expect_fixed cf_out "up_group:manufacturing_operations=true/Hide until saved once/true/1,physical_samples=true/Hide until saved once/true/1,test_sessions=true/Hide until saved once/true/1" \
    "up: Related records is hidden until saved once on a null or empty short_id, for samples, operations and tests, rule name and flag unchanged"
expect_fixed cf_out "up_fields:capture_frequency_khz=true/show when it has a value/false/false/false,capture_software=true/show when it has a value/false/false/false,file_storage_pointer=true/show when it has a value/false/false/false,machining_legacy_insert_edge_id=true/show when it has a value/false/false/false,machining_legacy_machining_uid=true/show when it has a value/false/false/false,nc_program_text=true/show when it has a value/false/false/false" \
    "up: the six 'show when it has a value' rules are not null and not '', with their name and flags unchanged"
expect_fixed cf_out "up_untouched:true/true" "up: a field outside the six, and the same field name on samples, keep their rule"
expect_fixed cf_out "up_no_old_rules:0" "up: the old _and / _empty rule is gone from the three groups and no _nempty is left on the six fields"
expect_fixed cf_out "down_restored:11/11" "down: the nine rules mean what migration 174 wrote again, and the two untouched rows are as they were"
expect_fixed cf_out "reup:true/true" "up again after down gives the corrected rules"
expect_fixed cf_out "up_twice:true" "up run on already-corrected rules changes nothing"

echo "== Sample geometry: legacy forms are back-filled =="
# Seed old-vocabulary samples, apply the back-fill's up SQL, assert, then ROLLBACK.
BACKFILL=$(migration backfill_legacy_geometry_forms)
bf_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$BACKFILL")
bf_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_code, form) VALUES
  ('TEST-LG-001','cylindrical'), ('TEST-LG-002','Rectangular'), ('TEST-LG-003','disc'), ('TEST-LG-004','round_bar');
$bf_up
SELECT 'lg:' || sample_code || '=' || form FROM physical_samples WHERE sample_code LIKE 'TEST-LG-%' ORDER BY sample_code;
ROLLBACK;
SQL
)
expect_line bf_out "lg:TEST-LG-001=cylinder" "cylindrical -> cylinder"
expect_line bf_out "lg:TEST-LG-002=block" "Rectangular -> block (case-insensitive)"
expect_line bf_out "lg:TEST-LG-003=disc" "current values are left alone (disc)"
expect_line bf_out "lg:TEST-LG-004=round_bar" "current values are left alone (round_bar)"
