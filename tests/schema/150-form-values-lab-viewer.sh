# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Sample stored values: form values migration (175) =="
# The test database has already run 175's up, so run its down first, seed rows that carry legacy values, run up,
# assert the mapping and the default, run down, assert the originals are back - all in a rolled-back transaction.
MIG=$(migration form_values)
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG")
fv_out=$($PSQL 2>&1 <<SQL
BEGIN;
$mig_down
SELECT 'down_default:' || count(*) FROM information_schema.columns
  WHERE table_name='physical_samples' AND column_name='item_type' AND column_default IS NOT NULL;
SELECT 'down_backup_table:' || count(*) FROM information_schema.tables
  WHERE table_schema='d1_private' AND table_name='form_values_175_backup';
INSERT INTO physical_samples (sample_code, item_type, form, surface_finish) VALUES
  ('TEST-FV175-01', NULL, 'rectangular', 'Machined'),
  ('TEST-FV175-02', 'sample', 'Cylindrical', ' polished '),
  ('TEST-FV175-03', 'sample', 'coupon', 'MIRROR'),
  ('TEST-FV175-04', 'sample', 'BILLET', 'Ground'),
  ('TEST-FV175-05', 'sample', 'l-profile', 'As produced'),
  ('TEST-FV175-06', 'sample', 'disc', 'As Produced'),
  ('TEST-FV175-07', 'sample', 'disc', 'As-sintered'),
  ('TEST-FV175-08', 'sample', 'disc', 'as_sintered'),
  ('TEST-FV175-09', 'sample', 'disc', 'N/A'),
  ('TEST-FV175-10', 'equipment', 'other', 'finish_machined'),
  ('TEST-FV175-11', 'sample', 'ring', 'rough_machined'),
  ('TEST-FV175-12', 'sample', 'bend_bar', 'Lapped'),
  ('TEST-FV175-13', NULL, NULL, NULL);
CREATE TEMP TABLE fv_orig AS
  SELECT sample_code, item_type, form, surface_finish FROM physical_samples WHERE sample_code LIKE 'TEST-FV175-%';
$mig_up
SELECT 'up_default:' || column_default FROM information_schema.columns
  WHERE table_name='physical_samples' AND column_name='item_type';
SELECT 'up_backup_rows:' || count(*) FROM d1_private.form_values_175_backup b
  JOIN physical_samples ps USING (sample_id) WHERE ps.sample_code LIKE 'TEST-FV175-%';
SELECT 'up:' || sample_code || ':' || coalesce(item_type, '~') || ':' || coalesce(form, '~') || ':' || coalesce(surface_finish, '~')
  FROM physical_samples WHERE sample_code LIKE 'TEST-FV175-%';
INSERT INTO physical_samples (sample_code, form) VALUES ('TEST-FV175-14', 'block');
SELECT 'up_new_row_item_type:' || item_type FROM physical_samples WHERE sample_code = 'TEST-FV175-14';
$mig_down
SELECT 'down_default2:' || count(*) FROM information_schema.columns
  WHERE table_name='physical_samples' AND column_name='item_type' AND column_default IS NOT NULL;
SELECT 'down_restored:' || count(*) FROM physical_samples ps JOIN fv_orig o USING (sample_code)
  WHERE ps.item_type IS NOT DISTINCT FROM o.item_type AND ps.form IS NOT DISTINCT FROM o.form
    AND ps.surface_finish IS NOT DISTINCT FROM o.surface_finish;
SELECT 'down_backup_gone:' || count(*) FROM information_schema.tables
  WHERE table_schema='d1_private' AND table_name='form_values_175_backup';
ROLLBACK;
SQL
)
expect_fixed fv_out "down_default:0" "175 down: item_type has no default"
expect_fixed fv_out "down_backup_table:0" "175 down: backup table dropped"
expect_fixed fv_out "up_default:'sample'::text" "175 up: item_type defaults to sample"
expect_fixed fv_out "up_backup_rows:10" "175 up: the 10 rows that change are backed up (the three unchanged control rows are not)"
expect_fixed fv_out "up:TEST-FV175-01:sample:block:medium_machined" "175 up: NULL item_type -> sample, rectangular -> block, Machined -> medium_machined"
expect_fixed fv_out "up:TEST-FV175-02:sample:cylinder:polished" "175 up: Cylindrical -> cylinder, ' polished ' (case, spaces) -> polished"
expect_fixed fv_out "up:TEST-FV175-03:sample:tensile_coupon:mirror" "175 up: coupon -> tensile_coupon, MIRROR -> mirror"
expect_fixed fv_out "up:TEST-FV175-04:sample:cylinder:ground" "175 up: BILLET -> cylinder, Ground -> ground"
expect_fixed fv_out "up:TEST-FV175-05:sample:other:as_produced" "175 up: l-profile -> other, 'As produced' -> as_produced"
expect_fixed fv_out "up:TEST-FV175-06:sample:disc:as_produced" "175 up: 'As Produced' -> as_produced"
expect_fixed fv_out "up:TEST-FV175-07:sample:disc:as_produced" "175 up: 'As-sintered' -> as_produced"
expect_fixed fv_out "up:TEST-FV175-08:sample:disc:as_produced" "175 up: 'as_sintered' -> as_produced"
expect_fixed fv_out "up:TEST-FV175-09:sample:disc:none" "175 up: N/A -> none"
expect_fixed fv_out "up:TEST-FV175-10:equipment:other:finish_machined" "175 up: equipment rows and existing finish codes are untouched"
expect_fixed fv_out "up:TEST-FV175-11:sample:ring:rough_machined" "175 up: a current form and finish code are untouched"
expect_fixed fv_out "up:TEST-FV175-12:sample:bend_bar:Lapped" "175 up: an unknown finish is left as it is"
expect_fixed fv_out "up:TEST-FV175-13:sample:~:~" "175 up: a NULL form and finish stay NULL (only item_type is filled)"
expect_fixed fv_out "up_new_row_item_type:sample" "175 up: a new row without item_type gets sample"
expect_fixed fv_out "down_default2:0" "175 down (after up): default dropped again"
expect_fixed fv_out "down_restored:13" "175 down: every seeded row has its original item_type, form and surface_finish back"
expect_fixed fv_out "down_backup_gone:0" "175 down (after up): backup table dropped"

echo "== Lab Viewer (migration 185): a read-only account role that reads every record =="
VW=20000002-0000-0000-0000-000000000003
VROLE=10000001-0000-0000-0000-000000000003
python3 scripts/gen_access_rules.py --check >/dev/null 2>&1 \
    && ok "configure_users_and_policies.sql carries the generated Lab Member and Lab Viewer blocks (no drift from access_rules.json)" \
    || bad "configure_users_and_policies.sql differs from access_rules.json (run gen_access_rules.py --write)"
lv_rules_json=$(python3 scripts/gen_access_rules.py --viewer-json)
# the collections whose Lab Member read rule is about the caller; the viewer reads every row of them (access_rules.json "viewer.read_all")
lv_all=$(python3 -c "import json; print(','.join(chr(39) + c + chr(39) for c in json.load(open('scripts/access_rules.json'))['viewer']['read_all']))")
lm_rules_json=$(python3 scripts/gen_access_rules.py --json)
lvx_out=$($PSQL 2>&1 <<SQL
CREATE TEMP TABLE _vgen AS
  SELECT * FROM json_to_recordset(\$vr\$$lv_rules_json\$vr\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, policy uuid, ruled boolean);
CREATE TEMP TABLE _lmgen AS
  SELECT * FROM json_to_recordset(\$lr\$$lm_rules_json\$lr\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, policy uuid, ruled boolean);
SELECT 'generated:' || count(*) FROM _vgen;
SELECT 'stored:' || count(*) FROM directus_permissions WHERE policy = '$VW';
SELECT 'exact:' || count(*) FROM _vgen g JOIN directus_permissions p
  ON p.policy = '$VW' AND p.collection = g.collection AND p.action = g.action
 AND p.permissions::jsonb = g.permissions AND p.validation::jsonb = g.validation AND p.fields = g.fields;
SELECT 'writes:' || count(*) FROM directus_permissions WHERE policy = '$VW' AND action <> 'read';
SELECT 'generated_writes:' || count(*) FROM _vgen WHERE action <> 'read';
-- the rows are the read rows of Lab Member as the generator makes them: same collections, filters, validation and fields
SELECT 'lm_read_only_in_lm:' || count(*) FROM (SELECT collection, permissions, validation, fields FROM _lmgen WHERE action = 'read' AND collection NOT IN ($lv_all)
    EXCEPT SELECT collection, permissions, validation, fields FROM _vgen) x;
SELECT 'lm_read_only_in_viewer:' || count(*) FROM (SELECT collection, permissions, validation, fields FROM _vgen WHERE collection NOT IN ($lv_all)
    EXCEPT SELECT collection, permissions, validation, fields FROM _lmgen WHERE action = 'read') x;
-- Task B: project_rollup and the five *_access tables are about the caller for a Lab Member (own rows only) and open for the viewer (every row)
SELECT 'read_all_n:' || count(*) FROM _vgen WHERE collection IN ($lv_all);
SELECT 'read_all_viewer_open:' || count(*) FROM directus_permissions WHERE policy = '$VW' AND action = 'read' AND collection IN ($lv_all) AND permissions::jsonb = '{}'::jsonb AND fields = '*';
SELECT 'read_all_member_scoped:' || count(*) FROM directus_permissions WHERE policy = '$LM' AND action = 'read' AND collection IN ($lv_all) AND permissions::jsonb <> '{}'::jsonb;
SELECT 'read_all_same_cols:' || count(*) FROM _lmgen l JOIN _vgen v USING (collection, action, validation, fields) WHERE l.action = 'read' AND l.collection IN ($lv_all);
SELECT 'role:' || count(*) FROM directus_roles WHERE id = '$VROLE' AND name = 'Lab Viewer';
SELECT 'policy:' || count(*) FROM directus_policies WHERE id = '$VW' AND name = 'Lab Viewer' AND NOT admin_access AND app_access;
SELECT 'access:' || count(*) FROM directus_access WHERE role = '$VROLE' AND policy = '$VW';
SELECT 'access_other_policies:' || count(*) FROM directus_access WHERE role = '$VROLE' AND policy <> '$VW';
SELECT 'records_read_through_readers:' || count(*) FROM directus_permissions
 WHERE policy = '$VW' AND action = 'read' AND collection IN ('physical_samples','test_sessions','campaigns','projects','campaign_samples')
   AND permissions::jsonb = '{"readers":{"_some":{"user_id":{"_eq":"\$CURRENT_USER"}}}}'::jsonb;
-- the functions and triggers
SELECT 'viewer_view:' || (to_regclass('d1_private.v_viewers') IS NOT NULL);
SELECT 'viewer_view_not_granted:' || (NOT has_table_privilege('d1_llm_readonly', 'd1_private.v_viewers', 'SELECT'));
SELECT 'triggers:' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.directus_users'::regclass AND tgname LIKE 'directus\_users\_readers\_%';
SELECT 'trigger_functions_definer:' || count(*) FILTER (WHERE p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, public%') || '/' || count(*)
  FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND p.proname LIKE 'trg\_readers\_directus\_users\_%';
SELECT 'lock_trigger_update_of:' || (position('UPDATE OF role, status' IN pg_get_triggerdef(t.oid)) > 0) FROM pg_trigger t WHERE t.tgname = 'directus_users_readers_lock';
SELECT 'every_readers_fn_has_viewers:' || count(*) FILTER (WHERE position('v_viewers' IN p.prosrc) > 0) || '/' || count(*)
  FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace
   AND p.proname IN ('readers_of_sample','readers_of_operation','readers_of_test','readers_of_campaign','readers_of_project','readers_of_campaign_sample',
                     'readers_of_sample_spec','readers_of_operation_spec','readers_of_test_spec','readers_of_campaign_spec','readers_of_project_spec','readers_of_campaign_sample_spec');
SELECT 'drift:' || d1_private.readers_drift_count();
-- up, down, up (all rolled back): the down takes the role, policy, rows, view, triggers and the viewer branches away; the up brings them back exactly
BEGIN;
$lv_down
SELECT 'dn_rows:' || (SELECT count(*) FROM directus_permissions WHERE policy = '$VW') || '/' || (SELECT count(*) FROM directus_roles WHERE id = '$VROLE')
    || '/' || (SELECT count(*) FROM directus_policies WHERE id = '$VW') || '/' || (SELECT count(*) FROM directus_access WHERE role = '$VROLE' OR policy = '$VW');
SELECT 'dn_objects:' || coalesce(to_regclass('d1_private.v_viewers')::text, 'gone') || '/' || coalesce(to_regprocedure('d1_private.lab_viewer_role()')::text, 'gone')
    || '/' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('directus_users_readers_lock','directus_users_readers_ins','directus_users_readers_upd','directus_users_readers_del'))
    || '/' || (SELECT count(*) FROM pg_proc WHERE proname LIKE 'trg\_readers\_directus\_users\_%');
SELECT 'dn_functions_with_viewers:' || count(*) FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND position('v_viewers' IN p.prosrc) > 0;
SELECT 'dn_drift:' || d1_private.readers_drift_count();
SELECT 'dn_comment_restored:' || (obj_description('d1_private.readers_of_sample(uuid[])'::regprocedure, 'pg_proc') NOT LIKE '%Lab Viewer%');
$lv_down
SELECT 'dn_twice_functions_with_viewers:' || count(*) FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND position('v_viewers' IN p.prosrc) > 0;
$lv_up
-- 185's up section is a snapshot: it knows nothing of the read row migration 192 added for surface_scans, so the replay is one short.
SELECT 'up2_exact:' || count(*) FROM _vgen g JOIN directus_permissions p
  ON p.policy = '$VW' AND p.collection = g.collection AND p.action = g.action
 AND p.permissions::jsonb = g.permissions AND p.validation::jsonb = g.validation AND p.fields = g.fields
 WHERE g.collection <> 'surface_scans';
SELECT 'up2_stored:' || count(*) FROM directus_permissions WHERE policy = '$VW';
SELECT 'up2_objects:' || (to_regclass('d1_private.v_viewers') IS NOT NULL) || '/' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('directus_users_readers_lock','directus_users_readers_ins','directus_users_readers_upd','directus_users_readers_del'));
SELECT 'up2_functions_with_viewers:' || count(*) FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND position('v_viewers' IN p.prosrc) > 0;
SELECT 'up2_drift:' || d1_private.readers_drift_count();
ROLLBACK;
SQL
)
lvx_n=$(grep '^generated:' <<<"$lvx_out" | cut -d: -f2)
expect_fixed lvx_out "stored:$lvx_n" "the Lab Viewer policy holds exactly the $lvx_n generated rows"
expect_fixed lvx_out "exact:$lvx_n" "every generated Lab Viewer row is stored with the same filter, validation and fields"
expect_fixed lvx_out "writes:0" "the Lab Viewer policy has no create, update or delete row"
expect_fixed lvx_out "generated_writes:0" "the generator makes no create, update or delete row for Lab Viewer"
expect_fixed lvx_out "lm_read_only_in_lm:0" "every read row of Lab Member (as generated) is a Lab Viewer row, but the rows about the caller (viewer.read_all)"
expect_fixed lvx_out "lm_read_only_in_viewer:0" "every Lab Viewer row is a read row of Lab Member (same collection, filter, validation, fields), but the rows about the caller"
expect_fixed lvx_out "read_all_n:6" "the viewer reads every row of project_rollup and the five *_access tables (six rows)"
expect_fixed lvx_out "read_all_viewer_open:6" "those six viewer rows have no filter and every field, as stored"
expect_fixed lvx_out "read_all_member_scoped:6" "Lab Member keeps its own-person filter on the same six collections, as stored"
expect_fixed lvx_out "read_all_same_cols:6" "the six rows differ from Lab Member's only in the filter"
expect_fixed lvx_out "role:1" "the role Lab Viewer exists"
expect_fixed lvx_out "policy:1" "the policy Lab Viewer has app access and no admin access"
expect_fixed lvx_out "access:1" "the role is bound to the policy"
expect_fixed lvx_out "access_other_policies:0" "the role has no other policy"
expect_fixed lvx_out "records_read_through_readers:5" "samples, tests, campaigns, projects and campaign samples are read through the readers tables, like Lab Member"
expect_fixed lvx_out "viewer_view:true" "d1_private.v_viewers exists"
expect_fixed lvx_out "viewer_view_not_granted:true" "the Ask-DB role has no grant on v_viewers"
expect_fixed lvx_out "triggers:directus_users_readers_del,directus_users_readers_ins,directus_users_readers_lock,directus_users_readers_trunc,directus_users_readers_upd" "directus_users has the lock, insert, update, delete and truncate readers triggers"
expect_fixed lvx_out "trigger_functions_definer:3/3" "the three viewer trigger functions are SECURITY DEFINER with a pinned search_path"
expect_fixed lvx_out "lock_trigger_update_of:true" "the lock trigger fires on UPDATE OF role, status only (Directus updates last_access on every request)"
expect_fixed lvx_out "every_readers_fn_has_viewers:12/12" "all six readers_of_* functions and their six _spec functions list the viewers"
expect_fixed lvx_out "drift:0" "readers_drift() is empty"
expect_fixed lvx_out "dn_rows:0/0/0/0" "down: no permission row, role, policy or binding is left"
expect_fixed lvx_out "dn_objects:gone/gone/0/0" "down: the view, the role function, the triggers and their functions are gone"
expect_fixed lvx_out "dn_functions_with_viewers:0" "down: no readers function lists the viewers any more (the heads of 183 are back)"
expect_fixed lvx_out "dn_drift:0" "down: readers_drift() is empty"
expect_fixed lvx_out "dn_comment_restored:true" "down: the function comments are the old ones"
expect_fixed lvx_out "dn_twice_functions_with_viewers:0" "down twice does nothing the second time"
expect_fixed lvx_out "up2_exact:$((lvx_n - 1))" "up again: every generated row is back, exact (but the surface_scans row of migration 192)"
expect_fixed lvx_out "up2_stored:$((lvx_n - 1))" "up again: no more and no fewer rows (but the surface_scans row of migration 192)"
expect_fixed lvx_out "up2_objects:true/4" "up again: the view and four triggers are back"
expect_fixed lvx_out "up2_functions_with_viewers:12" "up again: twelve readers functions list the viewers"
expect_fixed lvx_out "up2_drift:0" "up again: readers_drift() is empty"
