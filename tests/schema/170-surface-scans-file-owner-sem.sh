# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Surface scans migration (ADR-0021) =="
# One topography scan of one insert or one edge. Down and up run inside a rolled-back transaction; the Directus tables
# are stubs here, so the metadata is asserted by reading what the SQL wrote.
SS=$(migration surface_scans)
ss_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$SS")
ss_down=$(awk '/-- migrate:down/{f=1;next}f' "$SS")
SSB=c0000000-0000-4000-8000-0000000005
ss_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- migration 205 (surface scans follow their file's owner) put a table in d1_private that references surface_scans and changed its columns: its down goes first
$ssf_down
$ss_down
SELECT 'down_table:' || coalesce(to_regclass('surface_scans')::text, 'gone');
SELECT 'down_function:' || count(*) FROM pg_proc WHERE proname = 'surface_scans_reset_render';
SELECT 'down_meta:' || (SELECT count(*) FROM directus_fields WHERE collection = 'surface_scans')
  || ',' || (SELECT count(*) FROM directus_collections WHERE collection = 'surface_scans')
  || ',' || (SELECT count(*) FROM directus_permissions WHERE collection = 'surface_scans')
  || ',' || (SELECT count(*) FROM directus_relations WHERE many_collection = 'surface_scans');
$ss_up
SELECT 'up_comments:' || (SELECT count(*) FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'surface_scans' AND col_description('surface_scans'::regclass, c.ordinal_position::int) IS NULL)
  || ',' || (obj_description('surface_scans'::regclass) IS NOT NULL);
SELECT 'up_triggers:' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'surface_scans'::regclass AND NOT tgisinternal;
SELECT 'up_field_rows:' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'surface_scans')
  || '/' || (SELECT count(*) FROM directus_fields WHERE collection = 'surface_scans')
  || '/' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'surface_scans'
       AND NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = 'surface_scans' AND f.field = c.column_name));
SELECT 'up_worker_fields:' || count(*) FROM directus_fields
  WHERE collection = 'surface_scans' AND readonly AND hidden
    AND (field LIKE 'render\_%' OR field LIKE 'source\_%' OR field LIKE 'grid\_%' OR field LIKE 'pixel\_pitch\_%' OR field LIKE 'z\_%' OR field = 'cache_key' OR field = 'rendered_at');
SELECT 'up_condition_field:' || interface || '/' || jsonb_array_length(options::jsonb -> 'choices') FROM directus_fields WHERE collection = 'surface_scans' AND field = 'condition';
SELECT 'up_collection:' || count(*) FROM directus_collections WHERE collection = 'surface_scans';
SELECT 'up_relations:' || string_agg(many_field || '>' || one_collection, ',' ORDER BY many_field) FROM directus_relations WHERE many_collection = 'surface_scans';
SELECT 'up_member_perms:' || string_agg(action || '=' || permissions::text || '/' || fields, ';' ORDER BY action)
  FROM directus_permissions WHERE collection = 'surface_scans' AND policy = '20000002-0000-0000-0000-000000000002';
SELECT 'up_viewer_perms:' || string_agg(action || '=' || permissions::text || '/' || fields, ';' ORDER BY action)
  FROM directus_permissions WHERE collection = 'surface_scans' AND policy = '20000002-0000-0000-0000-000000000003';
SELECT 'up_llm_select:' || CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly')
  THEN has_table_privilege('d1_llm_readonly', 'surface_scans', 'SELECT')::text ELSE 'false' END;
INSERT INTO people (person_id, full_name) VALUES ('${SSB}f1', 'Scan Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code) VALUES ('${SSB}b1', 'TEST-SS-BOX');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id) VALUES
  ('${SSB}b2', 'TEST-SS-BOX-1', '${SSB}b1'), ('${SSB}b4', 'TEST-SS-BOX-2', '${SSB}b1');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier) VALUES ('${SSB}b3', 'TEST-SS-BOX-1A', '${SSB}b2', 'A');
INSERT INTO directus_files (id) VALUES ('${SSB}d1'), ('${SSB}d2'), ('${SSB}d3');
INSERT INTO manufacturing_methods (method_id, method_code, method_name) VALUES ('${SSB}a1', 'T-SS', 'surface scan test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${SSB}a2', 'TEST-SS-001');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code) VALUES ('${SSB}a3', '${SSB}a1', '${SSB}a2', 'TEST-SS-OP');
INSERT INTO surface_scans (scan_id, insert_id, directus_files_id, condition, owner_person_id) VALUES ('${SSB}c1', '${SSB}b2', '${SSB}d1', 'new', '${SSB}f1');
SELECT 'defaults:' || render_status || '/' || version || '/' || (render_error IS NULL AND cache_key IS NULL AND rendered_at IS NULL AND grid_width IS NULL) FROM surface_scans WHERE scan_id = '${SSB}c1';
INSERT INTO surface_scans (scan_id, edge_id, directus_files_id, condition, operation_id) VALUES ('${SSB}c2', '${SSB}b3', '${SSB}d1', 'worn', '${SSB}a3');
SELECT 'same_file_insert_and_edge:' || count(*) FROM surface_scans WHERE directus_files_id = '${SSB}d1';
SAVEPOINT s1;
INSERT INTO surface_scans (directus_files_id, condition) VALUES ('${SSB}d2', 'new');
SELECT 'no_item:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO surface_scans (insert_id, edge_id, directus_files_id, condition) VALUES ('${SSB}b2', '${SSB}b3', '${SSB}d2', 'new');
SELECT 'both_items:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO surface_scans (insert_id, directus_files_id, condition) VALUES ('${SSB}b2', '${SSB}d2', 'rusty');
SELECT 'bad_condition:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO surface_scans (insert_id, directus_files_id, condition, render_status) VALUES ('${SSB}b2', '${SSB}d2', 'new', 'queued');
SELECT 'bad_status:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO surface_scans (insert_id, directus_files_id, condition) VALUES ('${SSB}b2', '${SSB}d1', 'worn');
SELECT 'dup_insert_file:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO surface_scans (edge_id, directus_files_id, condition) VALUES ('${SSB}b3', '${SSB}d1', 'worn');
SELECT 'dup_edge_file:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO surface_scans (insert_id, directus_files_id, condition) VALUES ('${SSB}b2', NULL, 'new');
SELECT 'no_file:accepted';
ROLLBACK TO SAVEPOINT s1;
UPDATE surface_scans SET render_status = 'done', cache_key = 'abc', grid_width = 4 WHERE scan_id = '${SSB}c1';
SELECT 'occ_version:' || version FROM surface_scans WHERE scan_id = '${SSB}c1';
SELECT 'audit:' || count(*) FROM audit_logs WHERE table_name = 'surface_scans' AND record_id = '${SSB}c1';
-- changing the file resets a done render; changing anything else, or writing the same file again, does not
INSERT INTO surface_scans (scan_id, insert_id, directus_files_id, condition) VALUES ('${SSB}c3', '${SSB}b4', '${SSB}d1', 'worn');
UPDATE surface_scans SET render_status = 'done', cache_key = 'k3', rendered_at = now(), source_format = 'al3d', source_width = 8, source_height = 8,
  grid_width = 4, grid_height = 4, pixel_pitch_x_um = 1.5, pixel_pitch_y_um = 1.5, z_min_um = -2, z_max_um = 3, render_error = 'old' WHERE scan_id = '${SSB}c3';
UPDATE surface_scans SET notes = 'edited', condition = 'cleaned' WHERE scan_id = '${SSB}c3';
UPDATE surface_scans SET directus_files_id = directus_files_id WHERE scan_id = '${SSB}c3';
UPDATE surface_scans SET directus_files_id = '${SSB}d1' WHERE scan_id = '${SSB}c3';
SELECT 'keep_render:' || render_status || '/' || cache_key || '/' || grid_width || '/' || z_max_um || '/' || (rendered_at IS NOT NULL) FROM surface_scans WHERE scan_id = '${SSB}c3';
UPDATE surface_scans SET directus_files_id = '${SSB}d3' WHERE scan_id = '${SSB}c3';
SELECT 'reset_render:' || render_status || '/' || (cache_key IS NULL AND rendered_at IS NULL AND render_error IS NULL AND source_format IS NULL
  AND source_width IS NULL AND source_height IS NULL AND grid_width IS NULL AND grid_height IS NULL AND pixel_pitch_x_um IS NULL
  AND pixel_pitch_y_um IS NULL AND z_min_um IS NULL AND z_max_um IS NULL) || '/' || directus_files_id || '/' || notes
  FROM surface_scans WHERE scan_id = '${SSB}c3';
DELETE FROM manufacturing_operations WHERE operation_id = '${SSB}a3';
SELECT 'operation_cleared:' || (operation_id IS NULL) FROM surface_scans WHERE scan_id = '${SSB}c2';
DELETE FROM people WHERE person_id = '${SSB}f1';
SELECT 'owner_cleared:' || (owner_person_id IS NULL) FROM surface_scans WHERE scan_id = '${SSB}c1';
DELETE FROM directus_files WHERE id = '${SSB}d2';
SELECT 'file_delete_keeps_others:' || count(*) FROM surface_scans;
DELETE FROM insert_edges WHERE edge_id = '${SSB}b3';
SELECT 'edge_delete_cascades:' || count(*) FROM surface_scans WHERE scan_id = '${SSB}c2';
DELETE FROM directus_files WHERE id = '${SSB}d1';
SELECT 'file_delete_cascades:' || count(*) FROM surface_scans WHERE scan_id IN ('${SSB}c1', '${SSB}c2');
$ss_down
SELECT 'redown_table:' || coalesce(to_regclass('surface_scans')::text, 'gone');
ROLLBACK;
SQL
)
expect_fixed ss_out "down_table:gone" "down: surface_scans is dropped"
expect_fixed ss_out "down_meta:0,0,0,0" "down: its Directus fields, collection, permissions and relations are removed"
expect_fixed ss_out "up_comments:0,true" "up: every surface_scans column and the table carry a COMMENT"
expect_fixed ss_out "up_triggers:audit_surface_scans,occ_surface_scans,surface_scans_reset_render" "up: audit, OCC and render-reset triggers are attached"
expect_fixed ss_out "up_field_rows:27/27/0" "up: every surface_scans column has a Directus field row"
expect_fixed ss_out "up_worker_fields:13" "up: the worker-filled columns are read-only and hidden from the form"
expect_fixed ss_out "up_condition_field:select-dropdown/4" "up: condition is a dropdown of four choices"
expect_fixed ss_out "up_collection:1" "up: surface_scans is a Directus collection"
expect_fixed ss_out "up_relations:directus_files_id>directus_files,edge_id>insert_edges,insert_id>cutting_inserts,operation_id>manufacturing_operations,owner>directus_users,owner_person_id>people" "up: the item, file, operation and owner columns are Directus relations"
expect_fixed ss_out 'up_member_perms:create={}/insert_id,edge_id,directus_files_id,condition,condition_note,scanned_on,operation_id,notes,owner_person_id;delete={}/*;read={}/*;update={}/insert_id,edge_id,directus_files_id,condition,condition_note,scanned_on,operation_id,notes,owner_person_id,render_status,render_error' "up: every Lab Member reads and deletes scans and creates and updates them, but not the worker-filled columns"
expect_fixed ss_out "keep_render:done/k3/4/3/true" "changing another column, or writing the same file again, keeps the render"
expect_fixed ss_out "reset_render:pending/true/${SSB}d3/edited" "changing the file sets the scan pending and clears every derived column"
expect_fixed ss_out "down_function:0" "down: the render-reset function is dropped"
expect_fixed ss_out 'up_viewer_perms:read={}/*' "up: Lab Viewers read scans"
expect_fixed ss_out "up_llm_select:false" "up: the text-to-SQL role is not granted surface_scans (migration 168 rule)"
expect_fixed ss_out "defaults:pending/1/true" "a new scan is pending, version 1, with no render result"
expect_fixed ss_out "same_file_insert_and_edge:2" "one file can belong to an insert and to an edge"
for refused in no_item both_items bad_condition bad_status dup_insert_file dup_edge_file no_file; do
    ! grep -qx "$refused:accepted" <<<"$ss_out" && ok "refused: $refused" || bad "accepted although it must be refused: $refused"
done
expect_fixed ss_out "occ_version:2" "an update bumps version"
expect_fixed ss_out "audit:2" "an insert and an update of a scan are audited under its primary key"
expect_fixed ss_out "operation_cleared:true" "deleting the operation clears operation_id"
expect_fixed ss_out "owner_cleared:true" "deleting the owner clears owner_person_id"
expect_fixed ss_out "file_delete_keeps_others:3" "deleting a file with no scan changes no scan"
expect_fixed ss_out "edge_delete_cascades:0" "deleting an edge deletes its scans"
expect_fixed ss_out "file_delete_cascades:0" "deleting a file deletes its scans"
expect_fixed ss_out "redown_table:gone" "down runs again after up"

echo "== Surface scans follow their file's owner (migration 205, ADR-0023) =="
# Spec docs/superpowers/specs/2026-10-21-surface-scan-privacy-design.md. Everything runs in one rolled-back transaction (ids prefix d5000000-0000-4000-8000-0000000000).
# The database is at the head, so migration 205 is applied: the head state is asserted first, then 205's down is run (the old, 192 shape comes back), scans with
# render values are written in the old shape, and the up is replayed over them (the values move, the NOTICE counts the scans their adder cannot see), the down is run
# again (the values come back, version, updated_at and the audit log do not move, the permission rows are exactly the old ones, ids included) and the up a last time.
# The visibility rule (an administrator, an unowned file, or a file_readers row) is run as SQL against the real file_readers triggers.
SSF_MIG=$(migration surface_scans_follow_file_owner)
if [[ -f "$SSF_MIG" ]]; then
ssf_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$SSF_MIG")
ssf_down=$(awk '/-- migrate:down/{f=1;next}f' "$SSF_MIG")
SF=d5000000-0000-4000-8000-0000000000
SF_FILTER='{"_or":[{"_and":[{"directus_files_id":{"owner_person_id":{"_null":true}}},{"directus_files_id":{"owner_team_id":{"_null":true}}}]},{"directus_files_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}'
SF_PUBLIC='scan_id,insert_id,edge_id,condition,scanned_on,operation_id,created_at,updated_at,version'
SF_CREATE='insert_id,edge_id,directus_files_id,condition,condition_note,scanned_on,operation_id,notes,owner_person_id'
SF_UPDATE='insert_id,edge_id,directus_files_id,condition,condition_note,scanned_on,operation_id,notes,owner_person_id,render_status'
SF_COLS="render_error,rendered_at,cache_key,source_format,source_width,source_height,grid_width,grid_height,pixel_pitch_x_um,pixel_pitch_y_um,z_min_um,z_max_um"
# the twelve values of a scan as one comparable text (NULLs included), and the same for a row of the private table
sf_old_sum="SELECT md5(string_agg(jsonb_build_array(s.scan_id, s.render_error, s.rendered_at, s.cache_key, s.source_format, s.source_width, s.source_height, s.grid_width, s.grid_height, s.pixel_pitch_x_um, s.pixel_pitch_y_um, s.z_min_um, s.z_max_um)::text, ',' ORDER BY s.scan_id)) FROM surface_scans s WHERE s.scan_id::text LIKE 'd5000000-%' AND num_nonnulls(s.render_error, s.rendered_at, s.cache_key, s.source_format, s.source_width, s.source_height, s.grid_width, s.grid_height, s.pixel_pitch_x_um, s.pixel_pitch_y_um, s.z_min_um, s.z_max_um) > 0"
sf_new_sum="SELECT md5(string_agg(jsonb_build_array(r.scan_id, r.render_error, r.rendered_at, r.cache_key, r.source_format, r.source_width, r.source_height, r.grid_width, r.grid_height, r.pixel_pitch_x_um, r.pixel_pitch_y_um, r.z_min_um, r.z_max_um)::text, ',' ORDER BY r.scan_id)) FROM d1_private.surface_scan_renders r WHERE r.scan_id::text LIKE 'd5000000-%'"
sf_structure() { # sf_structure <prefix>: the shape of surface_scans, as lines <prefix>_...
    cat <<SQL
SELECT '$1_columns:' || count(*) || '/' || count(*) FILTER (WHERE column_name IN ('render_error','rendered_at','cache_key','source_format','source_width','source_height','grid_width','grid_height','pixel_pitch_x_um','pixel_pitch_y_um','z_min_um','z_max_um')) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'surface_scans';
SELECT '$1_field_rows:' || (SELECT count(*) FROM directus_fields WHERE collection = 'surface_scans')
  || '/' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'surface_scans' AND NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = 'surface_scans' AND f.field = c.column_name))
  || '/' || (SELECT count(*) FROM directus_fields f WHERE f.collection = 'surface_scans' AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'surface_scans' AND c.column_name = f.field));
SELECT '$1_file_note:' || note FROM directus_fields WHERE collection = 'surface_scans' AND field = 'directus_files_id';
SELECT '$1_triggers:' || string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'surface_scans'::regclass AND NOT tgisinternal;
SELECT '$1_reset_function:' || (prosrc LIKE '%surface_scan_renders%') || ',' || (prosrc LIKE '%cache_key%') FROM pg_proc WHERE proname = 'surface_scans_reset_render';
SELECT '$1_comments:' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'surface_scans' AND col_description('public.surface_scans'::regclass, c.ordinal_position::int) IS NULL)
  || ',' || (obj_description('public.surface_scans'::regclass) IS NOT NULL) || ',' || (obj_description('public.surface_scans'::regclass) LIKE '%locked placeholder%')
  || ',' || (col_description('public.surface_scans'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.surface_scans'::regclass AND attname = 'owner_person_id')) LIKE '%Informational only%');
SELECT '$1_member_perms:' || string_agg(action || '=' || permissions::text || '/' || fields, ';' ORDER BY action) FROM directus_permissions WHERE collection = 'surface_scans' AND policy = '20000002-0000-0000-0000-000000000002';
SELECT '$1_viewer_perms:' || string_agg(action || '=' || permissions::text || '/' || fields, ';' ORDER BY action) FROM directus_permissions WHERE collection = 'surface_scans' AND policy = '20000002-0000-0000-0000-000000000003';
SQL
}
sf_private() { # sf_private <prefix>: the private objects
    cat <<SQL
SELECT '$1_private:' || concat_ws(',', to_regclass('d1_private.surface_scan_renders') IS NOT NULL, to_regclass('d1_private.surface_scan_access_log') IS NOT NULL, to_regclass('d1_private.surface_scans_rules_backup') IS NOT NULL);
SQL
}
sf_sees() { # sf_sees <label> <user>: the fixture scans whose file this user may see (the one rule: unowned, or a file_readers row; administrators see all)
    printf "SELECT '%s:' || coalesce(string_agg(right(s.scan_id::text, 2), ',' ORDER BY s.scan_id), '') FROM surface_scans s JOIN directus_files f ON f.id = s.directus_files_id WHERE s.scan_id::text LIKE 'd5000000-%%' AND ((f.owner_person_id IS NULL AND f.owner_team_id IS NULL) OR EXISTS (SELECT 1 FROM file_readers r WHERE r.directus_files_id = f.id AND r.user_id = '%s'));\n" "$1" "$2"
}
sf_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- the head: migration 205 is applied
$(sf_private sf_head)
$(sf_structure sf_head)
SELECT 'sf_head_backup_rows:' || count(*) FROM d1_private.surface_scans_rules_backup;
SELECT 'sf_head_private_privileges:' || (CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly')
  THEN has_table_privilege('d1_llm_readonly', 'd1_private.surface_scan_renders', 'SELECT') OR has_table_privilege('d1_llm_readonly', 'd1_private.surface_scan_access_log', 'SELECT') OR has_table_privilege('d1_llm_readonly', 'd1_private.surface_scans_rules_backup', 'SELECT')
  ELSE false END)
  || ',' || (SELECT count(*) FROM v_schema_dictionary WHERE object_name LIKE 'surface\_scan\_%' AND object_name NOT IN ('surface_scans'))
  || ',' || (SELECT count(*) FROM directus_collections WHERE collection LIKE 'surface\_scan\_%' AND collection <> 'surface_scans');
SELECT 'sf_head_private_comments:' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'd1_private' AND c.table_name IN ('surface_scan_renders', 'surface_scan_access_log', 'surface_scans_rules_backup')
    AND col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position::int) IS NULL)
  || ',' || (SELECT count(*) FROM pg_class WHERE oid IN ('d1_private.surface_scan_renders'::regclass, 'd1_private.surface_scan_access_log'::regclass, 'd1_private.surface_scans_rules_backup'::regclass) AND obj_description(oid, 'pg_class') IS NOT NULL);

-- back to migration 192's shape
$ssf_down
$(sf_private sf_down1)
$(sf_structure sf_down1)

-- fixtures in the old shape: people with logins (P3 and P4 inactive), a team of P2 and P3, files, inserts, an edge, five scans
INSERT INTO directus_users (id) VALUES ('${SF}a1'), ('${SF}a2'), ('${SF}a3'), ('${SF}a4'), ('${SF}a5'), ('${SF}a6');
INSERT INTO people (person_id, full_name, user_id, active) VALUES
  ('${SF}b1', 'SSF Owner', '${SF}a1', true), ('${SF}b2', 'SSF Active Member', '${SF}a2', true), ('${SF}b3', 'SSF Inactive Member', '${SF}a3', false),
  ('${SF}b4', 'SSF Inactive Owner', '${SF}a4', false), ('${SF}b5', 'SSF New Owner', '${SF}a5', true), ('${SF}b6', 'SSF Stranger', '${SF}a6', true);
INSERT INTO teams (team_id, name) VALUES ('${SF}c1', 'SSF Team');
INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('${SF}c1', '${SF}b2', true), ('${SF}c1', '${SF}b3', false);
INSERT INTO directus_files (id, owner_person_id, owner_team_id) VALUES
  ('${SF}d1', '${SF}b1', NULL), ('${SF}d2', NULL, '${SF}c1'), ('${SF}d3', '${SF}b4', NULL), ('${SF}d4', NULL, NULL), ('${SF}d5', '${SF}b1', NULL), ('${SF}d6', '${SF}b1', NULL);
UPDATE directus_files SET owner_person_id = '${SF}b5' WHERE id = '${SF}d5';
INSERT INTO tool_boxes (tool_box_id, tool_box_code) VALUES ('${SF}e0', 'TEST-SSF-BOX');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id) VALUES ('${SF}e1', 'TEST-SSF-BOX-1', '${SF}e0'), ('${SF}e2', 'TEST-SSF-BOX-2', '${SF}e0'),
  ('${SF}e3', 'TEST-SSF-BOX-3', '${SF}e0'), ('${SF}e4', 'TEST-SSF-BOX-4', '${SF}e0');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier) VALUES ('${SF}e5', 'TEST-SSF-BOX-1A', '${SF}e1', 'A');
INSERT INTO surface_scans (scan_id, insert_id, edge_id, directus_files_id, condition, owner_person_id, render_status, render_error, rendered_at, cache_key, source_format,
    source_width, source_height, grid_width, grid_height, pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um) VALUES
  ('${SF}f1', '${SF}e1', NULL, '${SF}d1', 'new', '${SF}b1', 'done', NULL, '2026-10-01 12:00:00+00', 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'al3d', 2048, 1536, 1024, 768, 1.5, 1.25, -12.5, 31.75),
  ('${SF}f2', '${SF}e2', NULL, '${SF}d2', 'worn', '${SF}b6', 'done', NULL, '2026-10-02 09:30:00+00', 'p-${SF}d2-123456-1700000000.5', 'al3d', 100, 80, 100, 80, 0.5, 0.5, 0, 9.5),
  ('${SF}f3', '${SF}e3', NULL, '${SF}d4', 'cleaned', '${SF}b6', 'failed', 'cannot read this file', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('${SF}f4', '${SF}e4', NULL, '${SF}d3', 'other', NULL, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('${SF}f5', NULL, '${SF}e5', '${SF}d5', 'worn', '${SF}b1', 'done', NULL, NULL, 'k5', NULL, NULL, NULL, 64, NULL, NULL, NULL, NULL, NULL);
CREATE TEMP TABLE _sf_old_rules AS SELECT * FROM directus_permissions WHERE collection = 'surface_scans';
SELECT 'sf_old_rule_rows:' || count(*) FROM _sf_old_rules;
CREATE TEMP TABLE _sf_old_state AS SELECT s.scan_id, s.version, s.updated_at FROM surface_scans s WHERE s.scan_id::text LIKE 'd5000000-%';
CREATE TEMP TABLE _sf_old_audit AS SELECT count(*) AS n FROM audit_logs WHERE table_name = 'surface_scans';
SELECT 'sf_old_sum:' || ($sf_old_sum);

-- the up, over those scans
$ssf_up
$(sf_private sf_up1)
$(sf_structure sf_up1)
SELECT 'sf_up1_moved:' || count(*) FROM d1_private.surface_scan_renders WHERE scan_id::text LIKE 'd5000000-%';
SELECT 'sf_up1_sum:' || ($sf_new_sum);
SELECT 'sf_up1_backup_rows:' || count(*) FROM d1_private.surface_scans_rules_backup;
SELECT 'sf_up1_backup_exact:' || count(*) FROM ((SELECT policy, action, permissions::text, validation::text, fields FROM _sf_old_rules EXCEPT SELECT policy, action, permissions::text, validation::text, fields FROM d1_private.surface_scans_rules_backup)
  UNION ALL (SELECT policy, action, permissions::text, validation::text, fields FROM d1_private.surface_scans_rules_backup EXCEPT SELECT policy, action, permissions::text, validation::text, fields FROM _sf_old_rules)) x;
SELECT 'sf_up1_rule_ids:' || count(*) FROM _sf_old_rules o JOIN directus_permissions p ON p.id = o.id AND p.collection = 'surface_scans' AND p.policy = o.policy AND p.action = o.action;
SELECT 'sf_up1_scans_kept:' || count(*) FROM surface_scans WHERE scan_id::text LIKE 'd5000000-%';
SELECT 'sf_up1_status:' || string_agg(right(scan_id::text, 2) || '=' || render_status, ',' ORDER BY scan_id) FROM surface_scans WHERE scan_id::text LIKE 'd5000000-%';

-- and the down again: the values, version, updated_at and the audit log are exactly as before, the rules are the old rows (ids included)
$ssf_down
$(sf_private sf_down2)
$(sf_structure sf_down2)
SELECT 'sf_down2_sum:' || ($sf_old_sum);
SELECT 'sf_down2_state:' || count(*) FROM _sf_old_state o JOIN surface_scans s ON s.scan_id = o.scan_id AND s.version = o.version AND s.updated_at = o.updated_at;
SELECT 'sf_down2_audit:' || ((SELECT count(*) FROM audit_logs WHERE table_name = 'surface_scans') - (SELECT n FROM _sf_old_audit));
SELECT 'sf_down2_rules_exact:' || count(*) FROM ((SELECT to_jsonb(o) FROM _sf_old_rules o EXCEPT SELECT to_jsonb(p) FROM directus_permissions p WHERE p.collection = 'surface_scans')
  UNION ALL (SELECT to_jsonb(p) FROM directus_permissions p WHERE p.collection = 'surface_scans' EXCEPT SELECT to_jsonb(o) FROM _sf_old_rules o)) x;
SELECT 'sf_down2_triggers_enabled:' || count(*) FROM pg_trigger WHERE tgrelid = 'surface_scans'::regclass AND NOT tgisinternal AND tgenabled = 'O';
-- a second down does no harm
$ssf_down
SELECT 'sf_redown:ok';

-- the up a last time (up, down, up): the same values land in the private table
$ssf_up
$(sf_structure sf_up2)
SELECT 'sf_up2_sum:' || ($sf_new_sum);
SELECT 'sf_up2_moved:' || count(*) FROM d1_private.surface_scan_renders WHERE scan_id::text LIKE 'd5000000-%';

-- the visibility rule against the real readers triggers (P1 owns F1; F2 is the team's; F3 belongs to an inactive person; F4 is unowned; F5 was re-stamped from P1 to P5)
$(sf_sees sf_sees_owner "${SF}a1")
$(sf_sees sf_sees_member "${SF}a2")
$(sf_sees sf_sees_inactive_member "${SF}a3")
$(sf_sees sf_sees_inactive_owner "${SF}a4")
$(sf_sees sf_sees_new_owner "${SF}a5")
$(sf_sees sf_sees_stranger "${SF}a6")
UPDATE directus_files SET owner_person_id = '${SF}b6' WHERE id = '${SF}d1';
$(sf_sees sf_restamp_old_owner "${SF}a1")
$(sf_sees sf_restamp_stranger "${SF}a6")

-- the reset trigger: a change of file sets pending and deletes the private row; any other change keeps it
UPDATE surface_scans SET notes = 'edited', condition = 'cleaned' WHERE scan_id = '${SF}f2';
UPDATE surface_scans SET directus_files_id = directus_files_id WHERE scan_id = '${SF}f2';
SELECT 'sf_keep:' || render_status || '/' || (SELECT count(*) FROM d1_private.surface_scan_renders WHERE scan_id = '${SF}f2') FROM surface_scans WHERE scan_id = '${SF}f2';
UPDATE surface_scans SET directus_files_id = '${SF}d4' WHERE scan_id = '${SF}f2';
SELECT 'sf_reset:' || render_status || '/' || (SELECT count(*) FROM d1_private.surface_scan_renders WHERE scan_id = '${SF}f2') || '/' || notes FROM surface_scans WHERE scan_id = '${SF}f2';
SELECT 'sf_reset_other_kept:' || count(*) FROM d1_private.surface_scan_renders WHERE scan_id IN ('${SF}f1', '${SF}f5');
-- the worker's claim still works on the public row (render_status keeps its CHECK and partial index)
UPDATE surface_scans SET render_status = 'rendering' WHERE scan_id = '${SF}f2' AND render_status = 'pending';
SELECT 'sf_claim:' || render_status || '/' || version FROM surface_scans WHERE scan_id = '${SF}f2';
SELECT 'sf_status_index:' || (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_surface_scans_render_status') || ',' || (SELECT count(*) FROM pg_constraint WHERE conname = 'surface_scans_render_status_check');

-- the private table's own rules (f1 has a private row, f4 has none: the cache key checks are written on f4 so only the CHECK can refuse them)
SAVEPOINT s1;
INSERT INTO d1_private.surface_scan_renders (scan_id) VALUES ('${SF}f1');
SELECT 'sf_pk:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1;
INSERT INTO d1_private.surface_scan_renders (scan_id) VALUES ('${SF}ff');
SELECT 'sf_fk:accepted';
ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', '../x'); SELECT 'sf_ck_dotdot:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', 'a/b'); SELECT 'sf_ck_slash:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', '.hidden'); SELECT 'sf_ck_dot:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', 'x..y'); SELECT 'sf_ck_inner_dotdot:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', ''); SELECT 'sf_ck_empty:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', repeat('a', 201)); SELECT 'sf_ck_long:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', repeat('a', 200)); SELECT 'sf_ck_200:accepted'; ROLLBACK TO SAVEPOINT s1;
SAVEPOINT s1; INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key) VALUES ('${SF}f4', 'p-${SF}d4-99-1700000000.25'); SELECT 'sf_ck_provisional:accepted'; ROLLBACK TO SAVEPOINT s1;
-- a result written the way the endpoint does: an upsert
INSERT INTO d1_private.surface_scan_renders (scan_id, cache_key, grid_width, grid_height) VALUES ('${SF}f3', 'ff00', 8, 8)
  ON CONFLICT (scan_id) DO UPDATE SET cache_key = EXCLUDED.cache_key, grid_width = EXCLUDED.grid_width, grid_height = EXCLUDED.grid_height, updated_at = now();
SELECT 'sf_upsert:' || cache_key || '/' || grid_width FROM d1_private.surface_scan_renders WHERE scan_id = '${SF}f3';
-- the access log: a reason is required, and the log outlives the scan
SAVEPOINT s1;
INSERT INTO d1_private.surface_scan_access_log (scan_id, directus_files_id, read_by_user, reason) VALUES ('${SF}f1', '${SF}d1', '${SF}a6', '   ');
SELECT 'sf_log_blank:accepted';
ROLLBACK TO SAVEPOINT s1;
INSERT INTO d1_private.surface_scan_access_log (scan_id, directus_files_id, read_by_user, reason) VALUES ('${SF}f1', '${SF}d1', '${SF}a6', 'administrator read of a scan whose file belongs to someone else');
-- cascades: the private row goes with the scan (and a scan goes with its file), the log row stays
DELETE FROM surface_scans WHERE scan_id = '${SF}f1';
SELECT 'sf_cascade_scan:' || count(*) FROM d1_private.surface_scan_renders WHERE scan_id = '${SF}f1';
SELECT 'sf_log_kept:' || count(*) FROM d1_private.surface_scan_access_log WHERE scan_id = '${SF}f1';
DELETE FROM directus_files WHERE id = '${SF}d5';
SELECT 'sf_cascade_file:' || (SELECT count(*) FROM surface_scans WHERE scan_id = '${SF}f5') || ',' || (SELECT count(*) FROM d1_private.surface_scan_renders WHERE scan_id = '${SF}f5');
SELECT 'sf_done:1';
ROLLBACK;
SQL
)
expect_fixed sf_out "sf_done:1" "migration 205: the replay ran to its end"
# no ON_ERROR_STOP here (the refusals below are errors on purpose, each inside a savepoint; the SELECT after a refused INSERT then answers "transaction is aborted"):
# the only errors allowed are the nine constraint refusals and those follow-ups
[[ "$(grep -c '^ERROR:.*violates' <<<"$sf_out")" == "9" && -z "$(grep '^ERROR:' <<<"$sf_out" | grep -v -e 'violates' -e 'current transaction is aborted')" ]] \
    && ok "migration 205: the replay raised exactly the nine expected refusals and no other error" \
    || bad "migration 205: unexpected errors in the replay (psql output: $(grep '^ERROR:' <<<"$sf_out"))"
# the head
expect_fixed sf_out "sf_head_private:t,t,t" "head: the render table, the access log and the rules backup exist in d1_private"
expect_fixed sf_out "sf_head_columns:15/0" "head: surface_scans has 15 columns and none of the twelve file-derived ones"
expect_fixed sf_out "sf_head_field_rows:15/0/0" "head: every surface_scans column has a Directus field row and no field row is left over"
expect_fixed sf_out "sf_head_triggers:audit_surface_scans,occ_surface_scans,surface_scans_reset_render" "head: audit, OCC and render-reset triggers are attached"
expect_fixed sf_out "sf_head_reset_function:true,false" "head: the reset function deletes the private row and no longer names the moved columns"
expect_fixed sf_out "sf_head_comments:0,true,true,false" "head: every surface_scans column and the table carry a COMMENT, and the lab-wide wording is gone"
expect_fixed sf_out "sf_head_private_comments:0,3" "head: every column and the table of the three d1_private tables carry a COMMENT"
expect_fixed sf_out "sf_head_private_privileges:false,0,0" "head: the text-to-SQL role cannot read the private tables, they are not in v_schema_dictionary and not Directus collections"
expect_fixed sf_out "sf_head_backup_rows:5" "head: the backup holds the five rows migration 192 made (four Lab Member, one Lab Viewer)"
expect_fixed sf_out "sf_head_file_note:The topography file from the library. Only the file's owner (or their team) and administrators can see the file and its 3D view; other lab members see that the item has a scan. A file with no owner stays visible to everyone in the lab." "head: the file field's note no longer says the file is visible to everyone"
expect_fixed sf_out "sf_head_member_perms:create={}/$SF_CREATE;delete=$SF_FILTER/*;read={}/$SF_PUBLIC;update=$SF_FILTER/$SF_UPDATE" "head: a Lab Member reads only the nine link columns, creates as before, and updates and deletes only scans whose file is unowned or readable by them (update without render_error)"
expect_fixed sf_out "sf_head_viewer_perms:read={}/$SF_PUBLIC" "head: a Lab Viewer reads the same nine columns"
# the down
expect_fixed sf_out "sf_down1_private:f,f,f" "down: the private tables and the backup are dropped"
expect_fixed sf_out "sf_down1_columns:27/12" "down: surface_scans has its 27 columns again, twelve of them the file-derived ones"
expect_fixed sf_out "sf_down1_field_rows:27/0/0" "down: every column has a Directus field row again (migration 192's twelve)"
expect_fixed sf_out "sf_down1_file_note:The topography file from the library. Adding it makes the file visible to everyone in the lab." "down: the file field's note is migration 192's"
expect_fixed sf_out "sf_down1_reset_function:false,true" "down: the reset function is migration 192's (clears the columns of the row)"
expect_fixed sf_out "sf_down1_comments:0,true,false,true" "down: every column carries a COMMENT again, with migration 192's texts"
expect_fixed sf_out "sf_down1_triggers:audit_surface_scans,occ_surface_scans,surface_scans_reset_render" "down: the three triggers are still there"
expect_fixed sf_out "sf_down1_member_perms:create={}/$SF_CREATE;delete={}/*;read={}/*;update={}/$SF_UPDATE,render_error" "down: the Lab Member rows are migration 192's again"
expect_fixed sf_out "sf_down1_viewer_perms:read={}/*" "down: the Lab Viewer row is migration 192's again"
expect_fixed sf_out "sf_old_rule_rows:5" "(setup) the old shape has five surface_scans permission rows"
# the up over real values
sf_old=$(grep -o '^sf_old_sum:.*' <<<"$sf_out" | cut -d: -f2)
[[ -n "$sf_old" && "$sf_old" != "" ]] && ok "(setup) the values of the old shape have a checksum" || bad "no checksum of the old shape (psql output: $sf_out)"
expect_fixed sf_out "sf_up1_moved:4" "up: the four scans that have any file-derived value get a private row (the pending one with none does not)"
expect_fixed sf_out "sf_up1_sum:$sf_old" "up: every moved value is exactly what the column held (checksum of all twelve values, NULLs included)"
expect_fixed sf_out "sf_up1_columns:15/0" "up: the twelve columns are dropped"
expect_fixed sf_out "sf_up1_field_rows:15/0/0" "up: the twelve field rows are deleted, every remaining column has one"
expect_fixed sf_out "sf_up1_scans_kept:5" "up: no scan is deleted"
expect_fixed sf_out "sf_up1_status:f1=done,f2=done,f3=failed,f4=pending,f5=done" "up: render_status stays on the public row"
expect_fixed sf_out "sf_up1_backup_rows:5" "up: the backup holds the five old rows"
expect_fixed sf_out "sf_up1_backup_exact:0" "up: the backup rows are exactly the old rows"
expect_fixed sf_out "sf_up1_rule_ids:5" "up: the permission rows keep their ids (updated in place)"
expect_fixed sf_out "sf_up1_member_perms:create={}/$SF_CREATE;delete=$SF_FILTER/*;read={}/$SF_PUBLIC;update=$SF_FILTER/$SF_UPDATE" "up: the Lab Member rows are the generated ones"
expect_fixed sf_out "sf_up1_viewer_perms:read={}/$SF_PUBLIC" "up: the Lab Viewer row is the generated one"
grep -qF "NOTICE:  ADR-0023: 3 existing surface scan(s) point at an owned file their adder cannot read (1 with no recorded adder)." <<<"$sf_out" \
    && ok "up: the NOTICE counts the scans whose owned file their adder cannot read (a non-member, an unknown adder, a re-stamped file) and not the others" \
    || bad "up: the NOTICE count is wrong or missing (psql output: $sf_out)"
# the down after real data
expect_fixed sf_out "sf_down2_sum:$sf_old" "down: every value is copied back exactly"
expect_fixed sf_out "sf_down2_state:5" "down: version and updated_at of every scan are untouched (the OCC trigger is off for the copy)"
expect_fixed sf_out "sf_down2_audit:0" "down: the copy writes no audit row"
expect_fixed sf_out "sf_down2_rules_exact:0" "down: the permission rows are exactly the old rows, ids included"
expect_fixed sf_out "sf_down2_triggers_enabled:3" "down: the OCC, audit and reset triggers are enabled again"
expect_fixed sf_out "sf_down2_private:f,f,f" "down: the private tables and the backup are gone again"
expect_fixed sf_out "sf_redown:ok" "down runs again after down without an error"
expect_fixed sf_out "sf_up2_sum:$sf_old" "up, down, up: the same values land in the private table again"
expect_fixed sf_out "sf_up2_moved:4" "up again: four private rows"
expect_fixed sf_out "sf_up2_columns:15/0" "up again: the columns are gone again"
# the visibility rule
expect_fixed sf_out "sf_sees_owner:f1,f3" "visibility: the owner sees the scan of their file and the scan of an unowned file, not the team's, the inactive person's or the re-stamped file's"
expect_fixed sf_out "sf_sees_member:f2,f3" "visibility: an active team member sees the team file's scan"
expect_fixed sf_out "sf_sees_inactive_member:f3" "visibility: an inactive team member sees only the unowned file's scan (migration 201)"
expect_fixed sf_out "sf_sees_inactive_owner:f3,f4" "visibility: an inactive person keeps seeing the scan of the files they own"
expect_fixed sf_out "sf_sees_new_owner:f3,f5" "visibility: the new owner of a re-stamped file sees its scan"
expect_fixed sf_out "sf_sees_stranger:f3" "visibility: a member who owns nothing sees only the unowned file's scan"
expect_fixed sf_out "sf_restamp_old_owner:f3" "visibility follows a re-stamp live: the former owner loses the scan of the file"
expect_fixed sf_out "sf_restamp_stranger:f1,f3" "visibility follows a re-stamp live: the new owner gains it"
# the trigger, the tables
expect_fixed sf_out "sf_keep:done/1" "a change to notes, condition, or writing the same file again keeps the render and its private row"
expect_fixed sf_out "sf_reset:pending/0/edited" "changing the file sets the scan pending and deletes its private row"
expect_fixed sf_out "sf_reset_other_kept:2" "...and leaves every other scan's private row"
expect_fixed sf_out "sf_claim:rendering/5" "the worker's claim (pending to rendering) still works on the public row, and bumps the version"
expect_fixed sf_out "sf_status_index:1,1" "render_status keeps its partial index and its CHECK"
for sf_refused in sf_pk sf_fk sf_ck_dotdot sf_ck_slash sf_ck_dot sf_ck_inner_dotdot sf_ck_empty sf_ck_long sf_log_blank; do
    ! grep -qx "$sf_refused:accepted" <<<"$sf_out" && ok "refused: $sf_refused" || bad "accepted although it must be refused: $sf_refused"
done
for sf_accepted in sf_ck_200 sf_ck_provisional; do
    grep -qx "$sf_accepted:accepted" <<<"$sf_out" && ok "accepted: $sf_accepted (a cache key is a name: a sha256, or the provisional p-<file>-<size>-<mtime>)" || bad "refused although valid: $sf_accepted"
done
expect_fixed sf_out "sf_upsert:ff00/8" "the result route's upsert (INSERT ... ON CONFLICT (scan_id) DO UPDATE) works"
expect_fixed sf_out "sf_cascade_scan:0" "deleting a scan deletes its private row"
expect_fixed sf_out "sf_log_kept:1" "the access log row outlives the scan (no foreign key)"
expect_fixed sf_out "sf_cascade_file:0,0" "deleting a file deletes its scans and their private rows"
else
    bad "the surface scans follow file owner migration is missing ($SSF_MIG)"
fi

echo "== File provenance owner on directus_files (migration 196, ADR-0022) =="
# ADR-0022 / spec docs/superpowers/specs/2026-10-16-sem-data-bar-reader-design.md section 3 and 4. Every check runs in a rolled-back
# transaction (ids prefix a3000000-0000-4000-8000-). The CI database has the stub directus_files (id, filename_download, type) and
# directus_users (id only), so fixtures set just those. CI has no Directus, so the read filter is checked as stored JSON and its
# readers table by the SQL the filter stands for ("owners both null, or a reader row for the caller").
FO_MIG=$(migration file_provenance_owner)
[[ -n "$FO_MIG" && -f "$FO_MIG" ]] && ok "found the file provenance owner migration (${FO_MIG:-none})" || bad "the file provenance owner migration is missing (db/migrations/*_file_provenance_owner.sql)"
FO_P1='a3000000-0000-4000-8000-0000000000a1'
FO_P2='a3000000-0000-4000-8000-0000000000a2'
FO_P3='a3000000-0000-4000-8000-0000000000a3'
FO_T1='a3000000-0000-4000-8000-0000000000b1'
FO_T2='a3000000-0000-4000-8000-0000000000b2'
FO_U1='a3000000-0000-4000-8000-0000000000d1'
FO_U2='a3000000-0000-4000-8000-0000000000d2'
FO_U3='a3000000-0000-4000-8000-0000000000d3'
FO_F1='a3000000-0000-4000-8000-0000000000c1'
FO_F2='a3000000-0000-4000-8000-0000000000c2'
FO_F3='a3000000-0000-4000-8000-0000000000c3'
FO_F4='a3000000-0000-4000-8000-0000000000c4'
FO_F5='a3000000-0000-4000-8000-0000000000c5'
FO_F6='a3000000-0000-4000-8000-0000000000c6'
fo_fixture="
INSERT INTO directus_users (id) VALUES ('$FO_U1'), ('$FO_U2'), ('$FO_U3');
INSERT INTO people (person_id, full_name, user_id) VALUES ('$FO_P1', 'Owner Test One', '$FO_U1'), ('$FO_P2', 'Owner Test Two', '$FO_U2'), ('$FO_P3', 'Owner Test Three', NULL);
INSERT INTO teams (team_id, name) VALUES ('$FO_T1', 'Owner Test Team'), ('$FO_T2', 'Owner Test Team Two');
INSERT INTO team_members (team_id, person_id, is_manager) VALUES ('$FO_T1', '$FO_P2', true), ('$FO_T1', '$FO_P3', false), ('$FO_T2', '$FO_P1', true);"
fo_sql() { # fo_sql <statements>: run them after the fixture people, teams and users, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$fo_fixture
$1
ROLLBACK;
SQL
}
fo_users() { # fo_users <file id>: the users the readers table lists for a file, as a sorted list of u1/u2/u3 (empty: none)
    printf "SELECT '%s:' || coalesce(string_agg(CASE user_id WHEN '%s' THEN 'u1' WHEN '%s' THEN 'u2' WHEN '%s' THEN 'u3' END, ',' ORDER BY user_id), '') FROM file_readers WHERE directus_files_id = '%s';\n" "$2" "$FO_U1" "$FO_U2" "$FO_U3" "$1"
}
fo_sees() { # fo_sees <label> <user id>: the fixture files the Directus read filter lets that user read (owners both null, or a reader row)
    printf "SELECT '%s:' || coalesce(string_agg(right(f.id::text, 2), ',' ORDER BY f.id), '') FROM directus_files f WHERE f.id::text LIKE 'a3000000-%%' AND ((f.owner_person_id IS NULL AND f.owner_team_id IS NULL) OR EXISTS (SELECT 1 FROM file_readers r WHERE r.directus_files_id = f.id AND r.user_id = '%s'));\n" "$1" "$2"
}
# the columns
run_eq "directus_files.owner_person_id and owner_team_id are nullable uuid columns" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'directus_files' AND column_name IN ('owner_person_id', 'owner_team_id')" \
    "owner_person_id:uuid:YES,owner_team_id:uuid:YES"
run_eq "the owner columns are foreign keys to people and teams, ON DELETE RESTRICT (deleting an owner must not silently open their files)" \
    "SELECT string_agg(a.attname || '>' || c.confrelid::regclass::text || ':' || c.confdeltype::text, ',' ORDER BY a.attname) FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] WHERE c.conrelid = 'public.directus_files'::regclass AND c.contype = 'f' AND a.attname IN ('owner_person_id', 'owner_team_id')" \
    "owner_person_id>people:r,owner_team_id>teams:r"
run_eq "each owner column has a partial index WHERE it IS NOT NULL" \
    "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'directus_files' AND indexname IN ('idx_directus_files_owner_person_id', 'idx_directus_files_owner_team_id') AND indexdef LIKE '%WHERE (owner_%_id IS NOT NULL)'" \
    "idx_directus_files_owner_person_id,idx_directus_files_owner_team_id"
run_eq "both owner columns carry a COMMENT" \
    "SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.directus_files'::regclass AND a.attname IN ('owner_person_id', 'owner_team_id') AND col_description(a.attrelid, a.attnum) IS NOT NULL" "2"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_person_id, owner_team_id) VALUES ('$FO_F1', '$FO_P1', '$FO_T1');")
grep -q 'directus_files_one_owner_check' <<<"$fo_out" && ok "a file with both a person and a team owner is refused (CHECK num_nonnulls <= 1)" || bad "both owners were not refused (output: $fo_out)"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F1', '$FO_P1');
INSERT INTO directus_files (id, owner_team_id) VALUES ('$FO_F2', '$FO_T1');
INSERT INTO directus_files (id) VALUES ('$FO_F3');
SELECT 'fo_one:' || count(*) FROM directus_files WHERE id IN ('$FO_F1', '$FO_F2', '$FO_F3');")
grep -q 'fo_one:3' <<<"$fo_out" && ok "a person owner, a team owner and no owner are all accepted" || bad "valid owners were refused (output: $fo_out)"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F1', '$FO_P1');
UPDATE directus_files SET owner_team_id = '$FO_T1' WHERE id = '$FO_F1';")
grep -q 'directus_files_one_owner_check' <<<"$fo_out" && ok "setting a team owner on a person-owned file is refused (the owner is changed, not added)" || bad "a second owner was not refused (output: $fo_out)"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F1', '$FO_P1');
DELETE FROM people WHERE person_id = '$FO_P1';")
grep -q 'Owner Test One cannot be deleted: they own 1 found file(s)' <<<"$fo_out" && ok "deleting a person who owns a file is refused (RESTRICT: deactivate instead), with a message that names them and the count (migration 201)" || bad "deleting an owning person was not refused with the message (output: $fo_out)"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_team_id) VALUES ('$FO_F2', '$FO_T1');
DELETE FROM teams WHERE team_id = '$FO_T1';")
grep -q 'The team Owner Test Team cannot be deleted: it owns 1 found file(s)' <<<"$fo_out" && ok "deleting a team that owns a file is refused, with a message that names it and the count (migration 201)" || bad "deleting an owning team was not refused with the message (output: $fo_out)"
fo_out=$(fo_sql "SELECT 'fo_guard_fk:' || count(*) FROM pg_constraint WHERE conname = 'directus_files_owner_person_id_fkey' AND confdeltype = 'r';")
grep -q 'fo_guard_fk:1' <<<"$fo_out" && ok "the foreign key stays RESTRICT behind the delete guard (the guard only replaces its message)" || bad "the owner foreign key is no longer RESTRICT (output: $fo_out)"
# migration 201: a team's files are read by its ACTIVE members with a login; a person owner keeps reading their own files when inactive
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_team_id) VALUES ('$FO_F2', '$FO_T1');
INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F1', '$FO_P2');
$(fo_users "$FO_F2" fo_team_active)
UPDATE people SET active = false WHERE person_id = '$FO_P2';
$(fo_users "$FO_F2" fo_team_former)
$(fo_users "$FO_F1" fo_own_former)
SELECT 'fo_team_drift:' || d1_private.file_readers_drift_count();
UPDATE people SET active = true WHERE person_id = '$FO_P2';
$(fo_users "$FO_F2" fo_team_back)")
grep -q 'fo_team_active:u2$' <<<"$fo_out" && ok "a team's file is read by an active member with a login" || bad "an active team member does not read the team's file (output: $fo_out)"
grep -q 'fo_team_former:$' <<<"$fo_out" && ok "a Former (inactive) member loses the team's file at once (migration 201)" || bad "a Former member still reads the team's file (output: $fo_out)"
grep -q 'fo_own_former:u2$' <<<"$fo_out" && ok "an inactive person still reads the files they own" || bad "an inactive owner lost their own file (output: $fo_out)"
grep -q 'fo_team_drift:0' <<<"$fo_out" && grep -q 'fo_team_back:u2$' <<<"$fo_out" && ok "making the member active again restores the team's file, with no drift" || bad "reactivating a member did not restore access (output: $fo_out)"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F1', '$FO_P1');
UPDATE directus_files SET owner_person_id = NULL WHERE id = '$FO_F1';
DELETE FROM people WHERE person_id = '$FO_P1';
SELECT 'fo_deleted:' || count(*) FROM people WHERE person_id = '$FO_P1';")
grep -q 'fo_deleted:0' <<<"$fo_out" && ok "a person whose files are no longer owned by them can be deleted" || bad "deleting a person with no owned file failed (output: $fo_out)"

# the back-fill statement (D10): stamp unlinked found files from the candidate's owner, never overwrite, never touch a linked file
fo_backfill=$(awk '/^-- backfill:begin/{f=1;next}/^-- backfill:end/{f=0}f' "${FO_MIG:-/dev/null}")
[[ -n "$fo_backfill" ]] && ok "the migration marks its back-fill statement (-- backfill:begin / -- backfill:end)" || bad "the migration has no marked back-fill statement"
FO_CJ='a3000000-0000-4000-8000-0000000000e1'
FO_F7='a3000000-0000-4000-8000-0000000000c7'
FO_F8='a3000000-0000-4000-8000-0000000000c8'
FO_F9='a3000000-0000-4000-8000-0000000000c9'
FO_FA='a3000000-0000-4000-8000-0000000000ca'
FO_S1='a3000000-0000-4000-8000-0000000000f1'
FO_O1='a3000000-0000-4000-8000-0000000000f2'
FO_X1='a3000000-0000-4000-8000-0000000000f3'
FO_TB='a3000000-0000-4000-8000-0000000000f4'
FO_CI='a3000000-0000-4000-8000-0000000000f5'
# files that are linked somewhere (Data Studio's picker, the Alicona dialog) while their candidate is still dismissed, new or gone: the candidate
# does not say so, the junction rows do (the crawler's own definition, inbox_crawler/db.py already_linked)
fo_linked_elsewhere="INSERT INTO directus_files (id) VALUES ('$FO_F7'), ('$FO_F8'), ('$FO_F9'), ('$FO_FA');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('$FO_S1', 'FOBF-S1');
INSERT INTO manufacturing_operations (operation_id, sample_id, method_id) VALUES ('$FO_O1', '$FO_S1', (SELECT method_id FROM manufacturing_methods ORDER BY method_code LIMIT 1));
INSERT INTO test_sessions (session_id) VALUES ('$FO_X1');
INSERT INTO tool_boxes (tool_box_id, tool_box_code) VALUES ('$FO_TB', 'FOBF-BOX');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id) VALUES ('$FO_CI', 'FOBF-INS', '$FO_TB');
INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES ('$FO_S1', '$FO_F7');
INSERT INTO operation_data_files (operation_id, directus_files_id) VALUES ('$FO_O1', '$FO_F8');
INSERT INTO session_data_files (session_id, directus_files_id) VALUES ('$FO_X1', '$FO_F9');
INSERT INTO surface_scans (insert_id, directus_files_id, condition) VALUES ('$FO_CI', '$FO_FA', 'worn');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, owner_team_id, kind, origin, state, rel_path) VALUES
  ('$FO_F7', '$FO_P1', NULL, 'image', 'new', 'dismissed', 'Users/a/7.png'),
  ('$FO_F8', '$FO_P1', NULL, 'image', 'new', 'new', 'Users/a/8.png'),
  ('$FO_F9', NULL, '$FO_T1', 'image', 'new', 'gone', 'Shared/t/9.png'),
  ('$FO_FA', '$FO_P2', NULL, 'image', 'new', 'new', 'Users/b/a.al3d');"
fo_out=$(fo_sql "INSERT INTO directus_files (id) VALUES ('$FO_F1'), ('$FO_F2'), ('$FO_F3'), ('$FO_F4'), ('$FO_F5');
$fo_linked_elsewhere
INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F6', '$FO_P3');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, owner_team_id, kind, origin, state, rel_path, link_kind, linked_collection, linked_junction_id, link_batch_id) VALUES
  ('$FO_F1', '$FO_P1', NULL, 'image', 'new', 'new', 'Users/a/1.png', NULL, NULL, NULL, NULL),
  ('$FO_F2', NULL, '$FO_T1', 'image', 'new', 'dismissed', 'Shared/t/2.png', NULL, NULL, NULL, NULL),
  ('$FO_F3', '$FO_P2', NULL, 'image', 'new', 'gone', 'Users/b/3.png', NULL, NULL, NULL, NULL),
  ('$FO_F4', '$FO_P1', NULL, 'image', 'new', 'linked', 'Users/a/4.png', 'manual', 'physical_samples', '$FO_CJ', '$FO_CJ'),
  ('$FO_F6', '$FO_P1', NULL, 'image', 'new', 'new', 'Users/a/6.png', NULL, NULL, NULL, NULL);
$fo_backfill
SELECT 'fo_bf:' || right(f.id::text, 2) || ':' || coalesce(right(f.owner_person_id::text, 2), '-') || ':' || coalesce(right(f.owner_team_id::text, 2), '-')
  FROM directus_files f WHERE f.id::text LIKE 'a3000000-%' ORDER BY f.id;
$fo_backfill
SELECT 'fo_bf_again:' || count(*) FROM directus_files WHERE id::text LIKE 'a3000000-%' AND (owner_person_id IS NOT NULL OR owner_team_id IS NOT NULL);")
grep -qx 'fo_bf:c1:a1:-' <<<"$fo_out" && ok "back-fill: a new candidate's file is stamped with the candidate's person owner" || bad "back-fill: state new not stamped (output: $fo_out)"
grep -qx 'fo_bf:c2:-:b1' <<<"$fo_out" && ok "back-fill: a dismissed candidate's file is stamped with the candidate's team owner" || bad "back-fill: state dismissed not stamped (output: $fo_out)"
grep -qx 'fo_bf:c3:a2:-' <<<"$fo_out" && ok "back-fill: a gone candidate's file is stamped" || bad "back-fill: state gone not stamped (output: $fo_out)"
grep -qx 'fo_bf:c4:-:-' <<<"$fo_out" && ok "back-fill: a linked candidate's file stays unowned (D10: nobody loses access they have)" || bad "back-fill: a linked file was stamped (output: $fo_out)"
grep -qx 'fo_bf:c5:-:-' <<<"$fo_out" && ok "back-fill: a file with no candidate stays unowned" || bad "back-fill: a file without a candidate was stamped (output: $fo_out)"
grep -qx 'fo_bf:c6:a3:-' <<<"$fo_out" && ok "back-fill: an existing stamp is never overwritten" || bad "back-fill: an existing owner was overwritten (output: $fo_out)"
for fo_lk in "c7:a sample's file (dismissed candidate)" "c8:an operation's file (new candidate)" "c9:a test's file (gone candidate)" "ca:a surface scan's file (new candidate)"; do
    grep -qx "fo_bf:${fo_lk%%:*}:-:-" <<<"$fo_out" && ok "back-fill: ${fo_lk#*:} stays unowned: linked anywhere means left alone (D10), whatever its candidate says" || bad "back-fill: ${fo_lk#*:} was stamped although it is linked (output: $fo_out)"
done
grep -qx 'fo_bf_again:4' <<<"$fo_out" && ok "back-fill: running it twice changes nothing more" || bad "back-fill is not idempotent (output: $fo_out)"

# up, down, up inside one transaction: the stamp from the back-fill, the objects gone after down, the permission rows restored exactly
if [[ -n "$FO_MIG" && -f "$FO_MIG" ]]; then
fo_up="$fpo_up"
fo_down="$fof_down
$fpo_down"
fo_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
-- what the migration saved before it changed the rows: the down must put exactly that back
CREATE TEMP TABLE _fo_before AS SELECT policy, action, permissions::text AS p, validation::text AS v, fields FROM d1_private.directus_files_rules_backup;
$fo_down
SELECT 'fo_down_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'directus_files' AND column_name LIKE 'owner%';
SELECT 'fo_down_objects:' || (to_regclass('public.file_readers') IS NULL) || ',' || (to_regclass('d1_private.directus_files_rules_backup') IS NULL) || ',' || (to_regprocedure('d1_private.file_readers_refresh(uuid,uuid,uuid)') IS NULL);
SELECT 'fo_down_meta:' || (SELECT count(*) FROM directus_collections WHERE collection = 'file_readers') || ',' || (SELECT count(*) FROM directus_relations WHERE many_collection = 'file_readers') || ',' || (SELECT count(*) FROM directus_fields WHERE collection = 'directus_files' AND field = 'readers');
SELECT 'fo_down_perms_restored:' || count(*) FROM _fo_before b WHERE EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = b.policy AND p.collection = 'directus_files' AND p.action = b.action AND p.permissions::text IS NOT DISTINCT FROM b.p AND p.validation::text IS NOT DISTINCT FROM b.v AND p.fields IS NOT DISTINCT FROM b.fields) AND b.policy IS NOT NULL;
SELECT 'fo_down_perms_extra:' || count(*) FROM directus_permissions p WHERE p.collection IN ('directus_files', 'file_readers') AND NOT EXISTS (SELECT 1 FROM _fo_before b WHERE b.policy = p.policy AND b.action = p.action);
$fo_fixture
INSERT INTO directus_files (id) VALUES ('$FO_F1'), ('$FO_F2');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, owner_team_id, kind, origin, state, rel_path) VALUES
  ('$FO_F1', '$FO_P1', NULL, 'image', 'new', 'new', 'Users/a/1.png'),
  ('$FO_F2', NULL, '$FO_T1', 'image', 'new', 'new', 'Shared/t/2.png');
$fo_linked_elsewhere
$fo_up
SELECT 'fo_up_linked_elsewhere:' || count(*) FROM directus_files WHERE id IN ('$FO_F7', '$FO_F8', '$FO_F9', '$FO_FA') AND (owner_person_id IS NOT NULL OR owner_team_id IS NOT NULL);
SELECT 'fo_up_stamped:' || (SELECT right(owner_person_id::text, 2) FROM directus_files WHERE id = '$FO_F1') || ',' || (SELECT right(owner_team_id::text, 2) FROM directus_files WHERE id = '$FO_F2');
$(fo_users "$FO_F1" fo_up_readers_f1)
$(fo_users "$FO_F2" fo_up_readers_f2)
SELECT 'fo_up_drift:' || d1_private.file_readers_drift_count();
SELECT 'fo_up_perms:' || count(*) FROM directus_permissions WHERE collection = 'directus_files' AND policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003') AND permissions::jsonb <> '{}'::jsonb;
$fo_down
SELECT 'fo_redown_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'directus_files' AND column_name LIKE 'owner%';
ROLLBACK;
SQL
)
expect_line fo_out "fo_down_columns:0" "down: the owner columns are gone"
expect_line fo_out "fo_down_objects:true,true,true" "down: the readers table, the rules backup and the refresh function are gone"
expect_line fo_out "fo_down_meta:0,0,0" "down: the readers collection, relations and the hidden alias field are gone"
expect_line fo_out "fo_down_perms_extra:0" "down: no permission row remains that was not there before the migration"
fo_nrows=$(grep -o '^fo_down_perms_restored:[0-9]*' <<<"$fo_out" | cut -d: -f2)
[[ "${fo_nrows:-0}" -ge 4 ]] && ok "down: the directus_files permission rows hold exactly their old filters, validation and fields (${fo_nrows} rows)" || bad "down did not restore the old permission rows (psql output: $fo_out)"
expect_line fo_out "fo_up_stamped:a1,b1" "up: a found file is stamped from its candidate's person or team owner"
expect_line fo_out "fo_up_linked_elsewhere:0" "up: no file with a junction row or a surface scan is stamped, whatever its candidate's state"
expect_line fo_out "fo_up_readers_f1:u1" "up: a person-owned file's readers are that person's login"
expect_line fo_out "fo_up_readers_f2:u2" "up: a team-owned file's readers are the logins of the team's members (the member without a login adds none)"
expect_line fo_out "fo_up_drift:0" "up: the readers table has no drift from the owner columns"
expect_line fo_out "fo_up_perms:4" "up: the Lab Member read, update and delete rows and the Lab Viewer read row carry the owner filter"
expect_line fo_out "fo_redown_columns:0" "down runs again after up"
fi

# the readers table (ADR-0014 pattern; Directus filters through a top-level to-many alias, never through a team's members)
run_eq "file_readers has a COMMENT on the table and every column" \
    "SELECT (obj_description('public.file_readers'::regclass, 'pg_class') IS NOT NULL) || ',' || count(*) FILTER (WHERE col_description(a.attrelid, a.attnum) IS NULL) FROM pg_attribute a WHERE a.attrelid = 'public.file_readers'::regclass AND a.attnum > 0 AND NOT a.attisdropped" "true,0"
run_eq "file_readers is unique per file and user, and cascades from files and users" \
    "SELECT string_agg(conname || ':' || contype::text || CASE WHEN contype = 'f' THEN confdeltype::text ELSE '' END, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.file_readers'::regclass" \
    "file_readers_directus_files_id_fkey:fc,file_readers_directus_files_id_user_id_key:u,file_readers_pkey:p,file_readers_user_id_fkey:fc"
run_eq "file_readers has an index on user_id (the filter's lookup)" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'file_readers' AND indexdef LIKE '%(user_id)%'" "1"
run_eq "the readers table is hidden in Directus, with the relation to files (alias readers) and to users (no alias)" \
    "SELECT (SELECT hidden::text FROM directus_collections WHERE collection = 'file_readers') || '/' || (SELECT string_agg(many_field || '>' || one_collection || coalesce('.' || one_field, ''), ',' ORDER BY many_field) FROM directus_relations WHERE many_collection = 'file_readers') || '/' || (SELECT special::text || ':' || hidden::text FROM directus_fields WHERE collection = 'directus_files' AND field = 'readers')" \
    "true/directus_files_id>directus_files.readers,user_id>directus_users/o2m:true"
run_eq "the text-to-SQL role is not granted the readers table (migration 168 rule)" \
    "SELECT has_table_privilege('d1_llm_readonly', 'public.file_readers', 'SELECT')" "f"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F1', '$FO_P1');
INSERT INTO directus_files (id, owner_team_id) VALUES ('$FO_F2', '$FO_T1');
INSERT INTO directus_files (id) VALUES ('$FO_F3');
INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F4', '$FO_P3');
$(fo_users "$FO_F1" r_f1)
$(fo_users "$FO_F2" r_f2)
$(fo_users "$FO_F3" r_f3)
$(fo_users "$FO_F4" r_f4)
$(fo_sees see_u1 "$FO_U1")
$(fo_sees see_u2 "$FO_U2")
$(fo_sees see_u3 "$FO_U3")
SELECT 'drift:' || d1_private.file_readers_drift_count();")
expect_line fo_out "r_f1:u1" "a person-owned file: its owner reads it"
expect_line fo_out "r_f2:u2" "a team-owned file: the team's members with a login read it"
expect_line fo_out "r_f3:" "an unowned file has no readers row (the filter's first leaf opens it)"
expect_line fo_out "r_f4:" "a file owned by a person with no login has no reader (only an administrator reads it)"
expect_line fo_out "see_u1:c1,c3" "the owner of c1 sees (and, by the same test, may update and delete) c1 and the unowned c3, not the team's c2 nor c4"
expect_line fo_out "see_u2:c2,c3" "a team member sees (and may update and delete) the team's c2 and the unowned c3, not another person's c1: a non-reader cannot touch an owned file"
expect_line fo_out "see_u3:c3" "a login that owns nothing and is in no team sees (and may update and delete) only the unowned file, which any member can still change"
expect_line fo_out "drift:0" "the readers table matches the owner columns after the inserts"
fo_out=$(fo_sql "INSERT INTO directus_files (id, owner_team_id) VALUES ('$FO_F2', '$FO_T1');
INSERT INTO team_members (team_id, person_id) VALUES ('$FO_T1', '$FO_P1');
$(fo_users "$FO_F2" joined)
UPDATE people SET user_id = '$FO_U3' WHERE person_id = '$FO_P3';
$(fo_users "$FO_F2" login_added)
DELETE FROM team_members WHERE team_id = '$FO_T1' AND person_id = '$FO_P2';
$(fo_users "$FO_F2" left)
UPDATE people SET user_id = NULL WHERE person_id = '$FO_P1';
$(fo_users "$FO_F2" login_removed)
SELECT 'drift:' || d1_private.file_readers_drift_count();")
expect_line fo_out "joined:u1,u2" "a person who joins the owning team reads the team's files at once"
expect_line fo_out "login_added:u1,u2,u3" "a member who is given a login reads the team's files"
expect_line fo_out "left:u1,u3" "a person who leaves the owning team stops reading its files at once"
expect_line fo_out "login_removed:u3" "a person whose login is removed stops reading"
expect_line fo_out "drift:0" "the readers table has no drift after membership and login changes"
fo_out=$(fo_sql "INSERT INTO directus_files (id) VALUES ('$FO_F1');
UPDATE directus_files SET owner_person_id = '$FO_P1' WHERE id = '$FO_F1';
$(fo_users "$FO_F1" stamped)
UPDATE directus_files SET owner_person_id = NULL, owner_team_id = '$FO_T1' WHERE id = '$FO_F1';
$(fo_users "$FO_F1" handed_to_team)
UPDATE directus_files SET owner_team_id = NULL WHERE id = '$FO_F1';
$(fo_users "$FO_F1" cleared)
UPDATE directus_files SET owner_person_id = '$FO_P1' WHERE id = '$FO_F1';
DELETE FROM directus_files WHERE id = '$FO_F1';
SELECT 'cascade:' || count(*) FROM file_readers WHERE directus_files_id = '$FO_F1';
INSERT INTO directus_files (id, owner_person_id) VALUES ('$FO_F2', '$FO_P1');
DELETE FROM directus_users WHERE id = '$FO_U1';
SELECT 'user_deleted:' || count(*) FROM file_readers WHERE directus_files_id = '$FO_F2';
SELECT 'drift:' || d1_private.file_readers_drift_count();")
expect_line fo_out "stamped:u1" "stamping an unowned file gives its owner a readers row"
expect_line fo_out "handed_to_team:u2" "changing the owner from a person to a team replaces the readers (the old owner stops reading)"
expect_line fo_out "cleared:" "clearing the owner removes every readers row (the file is open again)"
expect_line fo_out "cascade:0" "deleting a file deletes its readers rows"
expect_line fo_out "user_deleted:0" "deleting a login deletes its readers rows"
expect_line fo_out "drift:0" "the readers table has no drift after owner changes"
run_eq "d1_private.file_readers_drift_count exists and the live database has no drift" \
    "SELECT d1_private.file_readers_drift_count()" "0"
# the stored Directus rules
FO_READ='{"_or":[{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]},{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}'
FO_WRITE='{"_or":[{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]},{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}]}'
fo_out=$($PSQL 2>&1 <<SQL
SELECT 'lm_read:' || (permissions::jsonb = '$FO_READ'::jsonb) FROM directus_permissions WHERE policy = '$LM' AND collection = 'directus_files' AND action = 'read';
SELECT 'vw_read:' || (permissions::jsonb = '$FO_READ'::jsonb) FROM directus_permissions WHERE policy = '$VW' AND collection = 'directus_files' AND action = 'read';
SELECT 'lm_update:' || (permissions::jsonb = '$FO_WRITE'::jsonb) FROM directus_permissions WHERE policy = '$LM' AND collection = 'directus_files' AND action = 'update';
SELECT 'lm_delete:' || (permissions::jsonb = '$FO_WRITE'::jsonb) FROM directus_permissions WHERE policy = '$LM' AND collection = 'directus_files' AND action = 'delete';
SELECT 'lm_actions:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions WHERE policy = '$LM' AND collection = 'directus_files';
SELECT 'vw_actions:' || string_agg(action, ',' ORDER BY action) FROM directus_permissions WHERE policy = '$VW' AND collection = 'directus_files';
SELECT 'readers_read:' || count(*) FROM directus_permissions WHERE policy IN ('$LM', '$VW') AND collection = 'file_readers' AND action = 'read'
   AND permissions::jsonb = '{"user_id":{"_eq":"\$CURRENT_USER"}}'::jsonb AND fields = '*';
SELECT 'readers_write:' || count(*) FROM directus_permissions WHERE policy IN ('$LM', '$VW') AND collection = 'file_readers' AND action <> 'read';
SELECT 'update_delete_no_some:' || count(*) FROM directus_permissions WHERE policy = '$LM' AND collection = 'directus_files' AND action IN ('update', 'delete') AND permissions::text LIKE '%_some%';
SQL
)
expect_line fo_out "lm_update:true" "Lab Member updates a file under the same test as reading it, in the bare-hop form (no _some): no owner, or the caller has a readers row"
expect_line fo_out "lm_delete:true" "Lab Member deletes a file under the same test"
expect_line fo_out "lm_read:true" "Lab Member reads a file when it has no owner or the caller is one of its readers"
expect_line fo_out "vw_read:true" "Lab Viewer reads files under the same filter"
expect_line fo_out "lm_actions:create,delete,read,update" "Lab Member still creates, reads, updates and deletes files"
expect_line fo_out "vw_actions:read" "Lab Viewer only reads files"
expect_line fo_out "readers_read:2" "Lab Member and Lab Viewer read the readers table for their own rows only (the legal _some applies its read rule)"
expect_line fo_out "readers_write:0" "nobody but the triggers writes the readers table"
expect_line fo_out "update_delete_no_some:0" "the files update and delete rows carry no _some"

echo "== SEM image settings, save_sem_settings, access log, classified_by (migration 197, ADR-0022) =="
# Spec docs/superpowers/specs/2026-10-16-sem-data-bar-reader-design.md section 3; plan task C2. Every check is a rolled-back transaction (ids prefix
# a4000000-0000-4000-8000-). The CI database has the stub directus_files and directus_users (id only), so the fixture rows set just the id.
SE_MIG=$(migration sem_image_settings)
[[ -n "$SE_MIG" && -f "$SE_MIG" ]] && ok "found the SEM image settings migration (${SE_MIG:-none})" || bad "the SEM image settings migration is missing (db/migrations/*_sem_image_settings.sql)"
SE_F1='a4000000-0000-4000-8000-0000000000c1'
SE_F2='a4000000-0000-4000-8000-0000000000c2'
SE_U1='a4000000-0000-4000-8000-0000000000d1'
SE_FULL='{"kv": 2.0, "spot": 3.5, "working_distance_mm": 15.92, "magnification": 40, "hfw_um": 7460.0, "pixel_size_nm": 7283.8, "scale_bar_um": 1000, "detector": "ETD", "mode": "SE", "instrument": "Quanta 650", "acquired_at": "2025-08-07T14:59:45+01:00", "sources": {"kv": "metadata", "spot": "metadata", "magnification": "derived"}, "flags": {"check_this": true}}'
se_sql() { # se_sql <statements>: run them after a fixture file and user, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_files (id) VALUES ('$SE_F1'), ('$SE_F2');
INSERT INTO directus_users (id) VALUES ('$SE_U1');
$1
ROLLBACK;
SQL
}
se_row() { # se_row <label> <file id>: the row as one line, 15 slots (an absent value is an empty slot)
    printf "SELECT '%s:' || coalesce((SELECT array_to_string(ARRAY[coalesce(kv::text, ''), coalesce(spot::text, ''), coalesce(working_distance_mm::text, ''), coalesce(magnification::text, ''), coalesce(hfw_um::text, ''), coalesce(pixel_size_nm::text, ''), coalesce(scale_bar_um::text, ''), coalesce(detector, ''), coalesce(mode, ''), coalesce(instrument, ''), coalesce(to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS'), ''), sources::text, flags::text, read_by, coalesce(corrected_by::text, '-')], '|') FROM d1_private.sem_image_settings WHERE directus_files_id = '%s'), 'none');\n" "$1" "$2"
}
se_exp() { local IFS='|'; echo "$*"; } # se_exp <15 slots>: the line se_row prints
# the objects
run_eq "sem_image_settings and sem_settings_access_log are tables of d1_private, not in public" \
    "SELECT string_agg(c.relname || ':' || n.nspname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND c.relname IN ('sem_image_settings', 'sem_settings_access_log')" \
    "sem_image_settings:d1_private,sem_settings_access_log:d1_private"
run_eq "sem_image_settings has the spec's columns and types" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(numeric_precision::text, '') || ',' || coalesce(numeric_scale::text, ''), ';' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'sem_image_settings'" \
    "directus_files_id:uuid:NO:,;kv:numeric:YES:6,2;spot:numeric:YES:4,1;working_distance_mm:numeric:YES:6,2;magnification:integer:YES:32,0;hfw_um:numeric:YES:10,2;pixel_size_nm:numeric:YES:12,4;scale_bar_um:numeric:YES:12,3;detector:text:YES:,;mode:text:YES:,;instrument:text:YES:,;acquired_at:timestamp with time zone:YES:,;sources:jsonb:NO:,;flags:jsonb:NO:,;read_by:text:NO:,;read_at:timestamp with time zone:NO:,;corrected_by:uuid:YES:,;corrected_at:timestamp with time zone:YES:,"
run_eq "sem_image_settings is keyed by the file and cascades with it" \
    "SELECT string_agg(contype::text || ':' || CASE WHEN contype = 'f' THEN confrelid::regclass::text ELSE '' END || ':' || CASE WHEN contype = 'f' THEN confdeltype::text ELSE '' END, ',' ORDER BY contype::text) FROM pg_constraint WHERE conrelid = 'd1_private.sem_image_settings'::regclass AND contype IN ('p', 'f')" \
    "f:directus_files:c,p::"
run_eq "sem_settings_access_log has the spec's columns" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ';' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'sem_settings_access_log'" \
    "id:bigint:NO;directus_files_id:uuid:NO;read_by_user:uuid:NO;read_at:timestamp with time zone:NO;reason:text:NO"
run_eq "file_candidates.classified_by is a nullable text column" \
    "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'file_candidates' AND column_name = 'classified_by'" "text:YES"
run_eq "every new table, column, function and constraint-bearing column carries a COMMENT (tables, columns, classified_by, the five functions)" \
    "SELECT (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'd1_private'::regnamespace AND c.relname IN ('sem_image_settings', 'sem_settings_access_log') AND obj_description(c.oid, 'pg_class') IS NULL)
          + (SELECT count(*) FROM pg_attribute a WHERE a.attrelid IN ('d1_private.sem_image_settings'::regclass, 'd1_private.sem_settings_access_log'::regclass) AND a.attnum > 0 AND NOT a.attisdropped AND col_description(a.attrelid, a.attnum) IS NULL)
          + (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'd1_private.file_candidates'::regclass AND a.attname = 'classified_by' AND col_description(a.attrelid, a.attnum) IS NULL)
          + (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND p.proname IN ('save_sem_settings', 'correct_sem_setting', 'sem_clean_number', 'sem_clean_text', 'sem_try_timestamptz') AND obj_description(p.oid, 'pg_proc') IS NULL)" "0"
run_eq "the functions exist: save_sem_settings returns boolean, correct_sem_setting returns void, both SECURITY INVOKER" \
    "SELECT string_agg(p.proname || ':' || format_type(p.prorettype, NULL) || ':' || p.prosecdef::text, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND p.proname IN ('save_sem_settings', 'correct_sem_setting')" \
    "correct_sem_setting:void:false,save_sem_settings:boolean:false"
run_eq "the text-to-SQL role reads neither table and none appears in v_schema_dictionary or directus_collections" \
    "SELECT bool_or(has_table_privilege('d1_llm_readonly', 'd1_private.' || t, 'SELECT'))::text || ',' || (SELECT count(*) FROM v_schema_dictionary WHERE object_name IN ('sem_image_settings', 'sem_settings_access_log')) || ',' || (SELECT count(*) FROM directus_collections WHERE collection IN ('sem_image_settings', 'sem_settings_access_log')) FROM unnest(ARRAY['sem_image_settings', 'sem_settings_access_log']) AS t" "false,0,0"
# table constraints (the ranges of spec section 2)
for bad in "kv = 250" "kv = 0.05" "spot = 0" "spot = 11" "working_distance_mm = 51" "working_distance_mm = 0.05" "magnification = 4" "magnification = 1000001" "hfw_um = 0" "pixel_size_nm = 0" "scale_bar_um = 0"; do
    col=${bad%% =*}
    se_out=$(se_sql "INSERT INTO d1_private.sem_image_settings (directus_files_id, read_by, $col) VALUES ('$SE_F1', 'sem-2', ${bad##*= });")
    grep -q 'sem_image_settings_.*_check' <<<"$se_out" && ok "the table refuses $bad" || bad "the table accepted $bad (output: $se_out)"
done
se_out=$(se_sql "INSERT INTO d1_private.sem_image_settings (directus_files_id, read_by, kv, spot, working_distance_mm, magnification) VALUES ('$SE_F1', 'sem-2', 0.1, 1, 0.1, 5), ('$SE_F2', 'sem-2', 30, 10, 50, 1000000);
SELECT 'se_edges:' || count(*) FROM d1_private.sem_image_settings;")
grep -qx 'se_edges:2' <<<"$se_out" && ok "the range edges are accepted (kv 0.1 and 30, spot 1 and 10, working distance 0.1 and 50, magnification 5 and 1,000,000)" || bad "range edges refused (output: $se_out)"
se_out=$(se_sql "INSERT INTO d1_private.sem_image_settings (directus_files_id, read_by) VALUES ('$SE_F1', 'sem-2');
SELECT 'se_defaults:' || sources::text || flags::text || (read_at IS NOT NULL) FROM d1_private.sem_image_settings;")
grep -qxF 'se_defaults:{}{}true' <<<"$se_out" && ok "sources and flags default to {} and read_at to now()" || bad "defaults wrong (output: $se_out)"
se_out=$(se_sql "INSERT INTO d1_private.sem_image_settings (directus_files_id) VALUES ('$SE_F1');")
grep -q 'null value in column "read_by"' <<<"$se_out" && ok "read_by is required" || bad "a row without read_by was accepted (output: $se_out)"
# the access log
se_out=$(se_sql "INSERT INTO d1_private.sem_settings_access_log (directus_files_id, read_by_user, reason) VALUES ('$SE_F1', '$SE_U1', NULL);")
grep -q 'null value in column "reason"' <<<"$se_out" && ok "the access log refuses a null reason" || bad "the access log accepted a null reason (output: $se_out)"
se_out=$(se_sql "INSERT INTO d1_private.sem_settings_access_log (directus_files_id, read_by_user, reason) VALUES ('$SE_F1', '$SE_U1', 'administrator read');
SELECT 'se_log:' || count(*) || (SELECT (read_at IS NOT NULL)::text FROM d1_private.sem_settings_access_log LIMIT 1) FROM d1_private.sem_settings_access_log;
DELETE FROM directus_files WHERE id = '$SE_F1';
SELECT 'se_log_after_file_delete:' || count(*) FROM d1_private.sem_settings_access_log;")
grep -qx 'se_log:1true' <<<"$se_out" && grep -qx 'se_log_after_file_delete:1' <<<"$se_out" && ok "an access log row stamps read_at and outlives the file it records" || bad "access log behaviour wrong (output: $se_out)"
# classified_by
se_out=$(se_sql "INSERT INTO people (person_id, full_name) VALUES ('a4000000-0000-4000-8000-0000000000a1', 'Sem Test');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, classified_by) VALUES ('$SE_F1', 'a4000000-0000-4000-8000-0000000000a1', 'sem_image', 'new', 'Users/x/1.tif', 'sem-2');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path) VALUES ('$SE_F2', 'a4000000-0000-4000-8000-0000000000a1', 'image', 'new', 'Users/x/2.png');
SELECT 'se_classified:' || string_agg(coalesce(classified_by, '<null>'), ',' ORDER BY rel_path) FROM d1_private.file_candidates WHERE directus_files_id IN ('$SE_F1', '$SE_F2');")
grep -qx 'se_classified:sem-2,<null>' <<<"$se_out" && ok "classified_by is stored, and NULL for a row never classified by a profile version" || bad "classified_by misbehaved (output: $se_out)"
# save_sem_settings
se_out=$(se_sql "SELECT 'se_ret1:' || d1_private.save_sem_settings('$SE_F1', '$SE_FULL'::jsonb, 'sem-2');
$(se_row se_full "$SE_F1")")
grep -qx 'se_ret1:true' <<<"$se_out" && ok "save_sem_settings returns true when a row exists afterwards" || bad "save_sem_settings did not return true (output: $se_out)"
grep -qxF "se_full:$(se_exp 2.00 3.5 15.92 40 7460.00 7283.8000 1000.000 ETD SE 'Quanta 650' 2025-08-07T13:59:45 '{"kv": "metadata", "spot": "metadata", "magnification": "derived"}' '{"check_this": true}' sem-2 -)" <<<"$se_out" \
    && ok "save_sem_settings maps a full extracted to the row (acquired_at with offset stored as the instant, sources and flags kept)" || bad "full extracted mapped wrongly (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '$SE_FULL'::jsonb, 'sem-2');
SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 5.0, \"spot\": 3.5}'::jsonb, 'sem-3');
$(se_row se_second "$SE_F1")
SELECT 'se_rows:' || count(*) FROM d1_private.sem_image_settings WHERE directus_files_id = '$SE_F1';")
grep -qxF "se_second:$(se_exp 5.00 3.5 15.92 40 7460.00 7283.8000 1000.000 ETD SE 'Quanta 650' 2025-08-07T13:59:45 '{"magnification": "derived"}' '{"check_this": true}' sem-3 -)" <<<"$se_out" && ok "a second call MERGES into the row: the keys it carries are updated (kv 5, spot 3.5; their old sources entries go, the new read gave none), the keys it does not carry keep their value, sources entry and flags, read_by follows" || bad "second save wrong (output: $se_out)"
grep -qx 'se_rows:1' <<<"$se_out" && ok "a second call keeps one row per file" || bad "second save made another row (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '$SE_FULL'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', 'kv', '20.5'::jsonb, '$SE_U1');
$(se_row se_after_correct "$SE_F1")
SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0, \"spot\": 4.0, \"working_distance_mm\": 10, \"sources\": {\"kv\": \"metadata\", \"spot\": \"ocr\"}, \"flags\": {\"check_this\": true, \"kv\": \"x\"}}'::jsonb, 'sem-3');
$(se_row se_resave "$SE_F1")")
grep -qxF "se_after_correct:$(se_exp 20.50 3.5 15.92 40 7460.00 7283.8000 1000.000 ETD SE 'Quanta 650' 2025-08-07T13:59:45 '{"kv": "manual", "spot": "metadata", "magnification": "derived"}' '{"check_this": true}' sem-2 $SE_U1)" <<<"$se_out" \
    && ok "correct_sem_setting sets the value, marks sources.kv as manual and records who corrected" || bad "correction wrong (output: $se_out)"
grep -qxF "se_resave:$(se_exp 20.50 4.0 10.00 40 7460.00 7283.8000 1000.000 ETD SE 'Quanta 650' 2025-08-07T13:59:45 '{"kv": "manual", "spot": "ocr", "magnification": "derived"}' '{"check_this": true}' sem-3 $SE_U1)" <<<"$se_out" \
    && ok "sem_settings: manual field survives a re-save (kv stays 20.5 and stays manual; the keys the new read carries are updated, the others keep their values; a flag named after a manual field is not taken)" || bad "manual field did not survive a re-save (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 250, \"spot\": 3.5, \"working_distance_mm\": 15.92, \"magnification\": 40}'::jsonb, 'sem-2');
$(se_row se_range "$SE_F1")")
grep -qxF "se_range:$(se_exp '' 3.5 15.92 40 '' '' '' '' '' '' '' '{}' '{}' sem-2 -)" <<<"$se_out" && ok "kv 250 is dropped (outside 0.1 to 30) and the rest is saved" || bad "out-of-range kv was not dropped cleanly (output: $se_out)"
se_out=$(se_sql "SELECT 'se_ranges:' || d1_private.save_sem_settings('$SE_F1', '{\"kv\": 0.05, \"spot\": 0.5, \"working_distance_mm\": 51, \"magnification\": 4, \"hfw_um\": 0, \"pixel_size_nm\": -1, \"scale_bar_um\": 0}'::jsonb, 'sem-2');
SELECT 'se_ranges_rows:' || count(*) FROM d1_private.sem_image_settings;")
grep -qx 'se_ranges:false' <<<"$se_out" && grep -qx 'se_ranges_rows:0' <<<"$se_out" && ok "when every value is outside its range nothing is saved and the call returns false" || bad "all-out-of-range extracted wrote a row (output: $se_out)"
se_out=$(se_sql "SELECT 'se_empty:' || d1_private.save_sem_settings('$SE_F1', '{}'::jsonb, 'sem-2');
SELECT 'se_empty_flags_only:' || d1_private.save_sem_settings('$SE_F1', '{\"flags\": {\"check_this\": true}, \"sources\": {}}'::jsonb, 'sem-2');
SELECT 'se_empty_null:' || d1_private.save_sem_settings('$SE_F1', NULL, 'sem-2');
SELECT 'se_empty_rows:' || count(*) FROM d1_private.sem_image_settings;")
grep -qx 'se_empty:false' <<<"$se_out" && grep -qx 'se_empty_flags_only:false' <<<"$se_out" && grep -qx 'se_empty_null:false' <<<"$se_out" && grep -qx 'se_empty_rows:0' <<<"$se_out" && ok "an empty extracted (also one with only flags, or NULL) returns false and writes no row" || bad "empty extracted misbehaved (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
SELECT 'se_empty_after:' || d1_private.save_sem_settings('$SE_F1', '{}'::jsonb, 'sem-3');
$(se_row se_empty_kept "$SE_F1")")
grep -qx 'se_empty_after:true' <<<"$se_out" && grep -qxF "se_empty_kept:$(se_exp 2.00 '' '' '' '' '' '' '' '' '' '' '{}' '{}' sem-2 -)" <<<"$se_out" && ok "an empty re-read of a file that has a row returns true and leaves the row as it is" || bad "empty re-read of an existing row misbehaved (output: $se_out)"
se_out=$(se_sql "SELECT 'se_round:' || d1_private.save_sem_settings('$SE_F1', '{\"kv\": 0.104, \"spot\": 9.96, \"working_distance_mm\": 0.104, \"magnification\": 40.05, \"hfw_um\": 7460.004}'::jsonb, 'sem-2');
$(se_row se_rounded "$SE_F1")")
grep -qx 'se_round:true' <<<"$se_out" && grep -qxF "se_rounded:$(se_exp 0.10 10.0 0.10 40 7460.00 '' '' '' '' '' '' '{}' '{}' sem-2 -)" <<<"$se_out" && ok "values are rounded to their column's scale before the range test (kv 0.104 -> 0.10, spot 9.96 -> 10.0, magnification 40.05 -> 40), never an overflow or a CHECK error" || bad "rounding wrong (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '$SE_FULL'::jsonb, 'sem-2');
SELECT 'se_keep:' || d1_private.save_sem_settings('$SE_F1', '{\"kv\": 250, \"spot\": 4.0, \"working_distance_mm\": null, \"magnification\": \"x\", \"sources\": {\"kv\": \"ocr\", \"spot\": \"ocr\"}}'::jsonb, 'sem-3');
$(se_row se_kept "$SE_F1")")
grep -qx 'se_keep:true' <<<"$se_out" && grep -qxF "se_kept:$(se_exp 2.00 4.0 15.92 40 7460.00 7283.8000 1000.000 ETD SE 'Quanta 650' 2025-08-07T13:59:45 '{"kv": "metadata", "spot": "ocr", "magnification": "derived"}' '{"check_this": true}' sem-3 -)" <<<"$se_out" \
    && ok "a key that is present but out of range (kv 250), null or of the wrong type does not erase the stored value or its source; the valid key (spot) is updated" || bad "a bad key erased a stored value (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '$SE_FULL'::jsonb, 'sem-2');
SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 250}'::jsonb, 'sem-3');
$(se_row se_all_bad "$SE_F1")")
grep -qxF "se_all_bad:$(se_exp 2.00 3.5 15.92 40 7460.00 7283.8000 1000.000 ETD SE 'Quanta 650' 2025-08-07T13:59:45 '{"kv": "metadata", "spot": "metadata", "magnification": "derived"}' '{"check_this": true}' sem-2 -)" <<<"$se_out" && ok "a re-read with nothing usable leaves the stored row exactly as it is (read_by too)" || bad "an unusable re-read changed the row (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0, \"spot\": 3.5, \"detector\": \"ETD\", \"flags\": {\"check_this\": true, \"detector\": \"unsure\"}, \"sources\": {\"detector\": \"ocr\"}}'::jsonb, 'sem-2');
SELECT d1_private.save_sem_settings('$SE_F1', '{\"mode\": \"SE\", \"sources\": {\"mode\": \"metadata\"}}'::jsonb, 'sem-3');
$(se_row se_merge_new_key "$SE_F1")
SELECT d1_private.save_sem_settings('$SE_F1', '{\"detector\": \"BSE\", \"sources\": {\"detector\": \"metadata\"}}'::jsonb, 'sem-3');
$(se_row se_merge_flag_follows "$SE_F1")")
grep -qxF "se_merge_new_key:$(se_exp 2.00 3.5 '' '' '' '' '' ETD SE '' '' '{"mode": "metadata", "detector": "ocr"}' '{"detector": "unsure", "check_this": true}' sem-3 -)" <<<"$se_out" && ok "a key the first read did not have is added, and the stored values, sources and flags of the other keys stay" || bad "merge of a new key wrong (output: $se_out)"
grep -qxF "se_merge_flag_follows:$(se_exp 2.00 3.5 '' '' '' '' '' BSE SE '' '' '{"mode": "metadata", "detector": "metadata"}' '{"check_this": true}' sem-3 -)" <<<"$se_out" && ok "an updated key takes its new source and drops the flag that was named after it" || bad "source or flag of an updated key wrong (output: $se_out)"
# a value just outside its range is dropped even when rounding would bring it inside (the raw value is tested, then rounded)
for pair in "kv|0.095" "kv|30.004" "spot|0.95" "spot|10.04" "working_distance_mm|0.095" "working_distance_mm|50.004" "magnification|4.5" "magnification|1000000.4" "hfw_um|0.004"; do
    f=${pair%%|*}; v=${pair#*|}
    se_out=$(se_sql "SELECT 'se_raw:' || d1_private.save_sem_settings('$SE_F1', '{\"$f\": $v}'::jsonb, 'sem-2');
SELECT 'se_raw_rows:' || count(*) FROM d1_private.sem_image_settings;")
    grep -qx 'se_raw:false' <<<"$se_out" && grep -qx 'se_raw_rows:0' <<<"$se_out" && ok "save_sem_settings drops $f = $v (outside the range as given, although rounding would bring it inside)" || bad "save_sem_settings kept $f = $v (output: $se_out)"
    se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', '$f', '$v'::jsonb, '$SE_U1');")
    grep -qi 'out of range' <<<"$se_out" && ok "correct_sem_setting refuses $f = $v for the same reason" || bad "correct_sem_setting accepted $f = $v (output: $se_out)"
done
# pathological extracted: no exception, the field is omitted, the rest is saved
se_out=$(se_sql "SELECT 'se_path:' || d1_private.save_sem_settings('$SE_F1', jsonb_build_object('kv', 'abc', 'spot', true, 'working_distance_mm', '[1]'::jsonb, 'magnification', 1e400, 'hfw_um', 1e12, 'pixel_size_nm', 1e9, 'scale_bar_um', 1e12, 'detector', repeat('x', 20000), 'mode', 7, 'instrument', 'Quanta', 'acquired_at', 'not a date', 'sources', '[1]'::jsonb, 'flags', '\"text\"'::jsonb), 'sem-2');
$(se_row se_pathological "$SE_F1")")
grep -qx 'se_path:true' <<<"$se_out" && grep -qxF "se_pathological:$(se_exp '' '' '' '' '' '' '' '' '' Quanta '' '{}' '{}' sem-2 -)" <<<"$se_out" && ok "pathological values (strings and booleans in numeric fields, 1e400, values past a column's capacity, a 20,000-character text, a date that is not a date, sources and flags that are not objects) raise nothing and are omitted" || bad "pathological extracted misbehaved (output: $se_out)"
se_out=$(se_sql "SELECT 'se_dates:' || d1_private.save_sem_settings('$SE_F1', '{\"acquired_at\": \"2025-13-45T99:00:00+01:00\"}'::jsonb, 'sem-2');
SELECT 'se_dates2:' || d1_private.save_sem_settings('$SE_F1', '{\"acquired_at\": \"2025-10-26T01:30:00Z\", \"kv\": 5}'::jsonb, 'sem-2');
$(se_row se_date "$SE_F1")")
grep -qx 'se_dates:false' <<<"$se_out" && grep -qx 'se_dates2:true' <<<"$se_out" && grep -qxF "se_date:$(se_exp 5.00 '' '' '' '' '' '' '' '' '' 2025-10-26T01:30:00 '{}' '{}' sem-2 -)" <<<"$se_out" && ok "an impossible calendar date is dropped; a UTC time is stored as given" || bad "date handling wrong (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0, \"sources\": {\"kv\": \"manual\", \"spot\": \"ocr\"}}'::jsonb, 'sem-2');
$(se_row se_claim "$SE_F1")
SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 3.0}'::jsonb, 'sem-3');
$(se_row se_claim2 "$SE_F1")")
grep -qxF "se_claim:$(se_exp 2.00 '' '' '' '' '' '' '' '' '' '' '{}' '{}' sem-2 -)" <<<"$se_out" && grep -qxF "se_claim2:$(se_exp 3.00 '' '' '' '' '' '' '' '' '' '' '{}' '{}' sem-3 -)" <<<"$se_out" && ok "a read cannot claim 'manual': that source entry is dropped, so a later re-read still updates the field" || bad "an extracted source of manual was kept (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0, \"detector\": \"ETD\", \"instrument\": \"Quanta\"}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', 'detector', '\"BSE\"'::jsonb, '$SE_U1');
SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 3.0, \"detector\": \"ETD\", \"instrument\": \"Other\"}'::jsonb, 'sem-3');
$(se_row se_text_manual "$SE_F1")")
grep -qxF "se_text_manual:$(se_exp 3.00 '' '' '' '' '' '' BSE '' Other '' '{"detector": "manual"}' '{}' sem-3 $SE_U1)" <<<"$se_out" && ok "a corrected text field survives a re-save too" || bad "a manual text field was overwritten (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"magnification\": 40, \"hfw_um\": 7460, \"flags\": {\"check_this\": true, \"magnification\": \"unverified\", \"acquired_at\": \"invalid_local_time\"}, \"sources\": {\"magnification\": \"ocr\"}}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', 'magnification', '80'::jsonb, '$SE_U1');
$(se_row se_flag_cleared "$SE_F1")")
grep -qxF "se_flag_cleared:$(se_exp '' '' '' 80 7460.00 '' '' '' '' '' '' '{"magnification": "manual"}' '{"check_this": true, "acquired_at": "invalid_local_time"}' sem-2 $SE_U1)" <<<"$se_out" && ok "correcting a field takes away the flag that was named after it and keeps the others" || bad "correction flag handling wrong (output: $se_out)"
# correct_sem_setting refuses
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', 'read_by', '\"someone\"'::jsonb, '$SE_U1');")
grep -qi 'not a correctable field\|unknown field' <<<"$se_out" && ok "correct_sem_setting refuses field = 'read_by'" || bad "correct_sem_setting accepted read_by (output: $se_out)"
for f in sources flags directus_files_id corrected_by corrected_at read_at 'kv; DROP TABLE x'; do
    se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', '$f', '\"x\"'::jsonb, '$SE_U1');")
    grep -qi 'not a correctable field\|unknown field' <<<"$se_out" && ok "correct_sem_setting refuses the field '$f'" || bad "correct_sem_setting accepted the field '$f' (output: $se_out)"
done
for pair in "kv|250" "kv|0.05" "spot|0" "working_distance_mm|51" "magnification|4" "magnification|2000000" "hfw_um|0" "kv|\"abc\"" "kv|true" "kv|null" "detector|5" "acquired_at|\"not a date\"" "acquired_at|5"; do
    f=${pair%%|*}; v=${pair#*|}
    se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', '$f', '$v'::jsonb, '$SE_U1');")
    grep -qi 'out of range\|not a valid' <<<"$se_out" && ok "correct_sem_setting refuses $f = $v" || bad "correct_sem_setting accepted $f = $v (output: $se_out)"
done
se_out=$(se_sql "SELECT d1_private.correct_sem_setting('$SE_F1', 'kv', '5'::jsonb, '$SE_U1');")
grep -qi 'no sem_image_settings row' <<<"$se_out" && ok "correct_sem_setting refuses a file that has no settings row" || bad "correct_sem_setting accepted a file with no row (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
SELECT d1_private.correct_sem_setting('$SE_F1', 'acquired_at', '\"2025-08-07T14:59:45+01:00\"'::jsonb, '$SE_U1');
SELECT d1_private.correct_sem_setting('$SE_F1', 'mode', '\"BSE\"'::jsonb, '$SE_U1');
SELECT 'se_corr:' || to_char(acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') || ':' || mode || ':' || (corrected_at IS NOT NULL)::text || ':' || sources::text FROM d1_private.sem_image_settings;")
grep -qxF 'se_corr:2025-08-07T13:59:45:BSE:true:{"mode": "manual", "acquired_at": "manual"}' <<<"$se_out" && ok "a corrected time and a corrected text are stored with their source and corrected_at" || bad "correct_sem_setting stored time or text wrongly (output: $se_out)"
# the row follows the file
se_out=$(se_sql "SELECT d1_private.save_sem_settings('$SE_F1', '{\"kv\": 2.0}'::jsonb, 'sem-2');
DELETE FROM directus_files WHERE id = '$SE_F1';
SELECT 'se_cascade:' || count(*) FROM d1_private.sem_image_settings;")
grep -qx 'se_cascade:0' <<<"$se_out" && ok "deleting the directus_files row deletes its settings" || bad "settings outlived their file (output: $se_out)"
se_out=$(se_sql "SELECT d1_private.save_sem_settings('a4000000-0000-4000-8000-0000000000ff', '{\"kv\": 2.0}'::jsonb, 'sem-2');")
grep -q 'violates foreign key constraint' <<<"$se_out" && ok "settings for a file that does not exist are refused" || bad "settings for an unknown file were accepted (output: $se_out)"
# up, down, up in one transaction
if [[ -n "$SE_MIG" && -f "$SE_MIG" ]]; then
se_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$SE_MIG")
se_down=$(awk '/-- migrate:down/{f=1;next}f' "$SE_MIG")
se_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_files (id) VALUES ('$SE_F1');
INSERT INTO d1_private.sem_image_settings (directus_files_id, read_by, kv) VALUES ('$SE_F1', 'sem-2', 2);
INSERT INTO d1_private.sem_settings_access_log (directus_files_id, read_by_user, reason) VALUES ('$SE_F1', '$SE_F1', 'x');
$se_down
SELECT 'se_dn_tables:' || coalesce(to_regclass('d1_private.sem_image_settings')::text, 'gone') || ',' || coalesce(to_regclass('d1_private.sem_settings_access_log')::text, 'gone');
SELECT 'se_dn_functions:' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'd1_private'::regnamespace AND proname IN ('save_sem_settings', 'correct_sem_setting', 'sem_clean_number', 'sem_clean_text', 'sem_try_timestamptz'));
SELECT 'se_dn_column:' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'file_candidates' AND column_name = 'classified_by');
$se_down
$se_up
SELECT 'se_up_tables:' || (to_regclass('d1_private.sem_image_settings') IS NOT NULL) || ',' || (to_regclass('d1_private.sem_settings_access_log') IS NOT NULL);
SELECT 'se_up_ret:' || d1_private.save_sem_settings('$SE_F1', '{"kv": 2.0}'::jsonb, 'sem-2');
$se_down
SELECT 'se_redown_tables:' || coalesce(to_regclass('d1_private.sem_image_settings')::text, 'gone');
ROLLBACK;
SQL
)
expect_line se_out "se_dn_tables:gone,gone" "down: both tables are dropped"
expect_line se_out "se_dn_functions:0" "down: the five functions are dropped"
expect_line se_out "se_dn_column:0" "down: file_candidates.classified_by is dropped"
expect_line se_out "se_up_tables:true,true" "up after down: both tables are back"
expect_line se_out "se_up_ret:true" "up after down: save_sem_settings works"
expect_line se_out "se_redown_tables:gone" "down runs again after up (and a second down in a row does nothing)"
fi
