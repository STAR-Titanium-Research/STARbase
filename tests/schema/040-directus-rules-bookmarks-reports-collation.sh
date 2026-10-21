# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Lab Member can save a cut from the Force App =="
# directus_permissions is a stub in CI: run the migration's up then down in a rolled-back
# transaction, with an unrelated Lab Member row and the same row on another policy seeded to prove
# the down removes only what the up added.
FAS=$(migration lab_member_force_app_save)
fas_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$FAS")
fas_down=$(awk '/-- migrate:down/{f=1;next}f' "$FAS")
fas_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_permissions WHERE collection IN ('directus_files','machining_force_analysis');
INSERT INTO directus_permissions (policy, collection, action, permissions, validation, fields) VALUES
  ('20000002-0000-0000-0000-000000000002','machining_force_analysis','update','{}','{}','*'),
  ('20000002-0000-0000-0000-000000000001','directus_files','read','{}','{}','*');
$fas_up
SELECT 'up:' || string_agg(collection || '.' || action, ',' ORDER BY collection, action) FROM directus_permissions WHERE policy='20000002-0000-0000-0000-000000000002' AND collection IN ('directus_files','machining_force_analysis');
$fas_up
SELECT 'up_idempotent:' || count(*) FROM directus_permissions WHERE policy='20000002-0000-0000-0000-000000000002' AND collection IN ('directus_files','machining_force_analysis');
$fas_down
SELECT 'down:' || string_agg(collection || '.' || action, ',' ORDER BY collection, action) FROM directus_permissions WHERE collection IN ('directus_files','machining_force_analysis');
ROLLBACK;
SQL
)
expect_line fas_out "up:directus_files.create,directus_files.read,machining_force_analysis.create,machining_force_analysis.update" "up: Lab Member gets file create+read and force-analysis create (update kept)"
expect_line fas_out "up_idempotent:4" "up is idempotent"
expect_line fas_out "down:directus_files.read,machining_force_analysis.update" "down: removes only the added grants (update and other policies kept)"

echo "== Saved-filter bookmarks (D12) =="
# directus_presets is a stub in CI: run the migration's up then down in a rolled-back transaction,
# with a hand-curated "Failed" bookmark (kept by the up) and an unrelated Machining bookmark
# (kept by the down) seeded, and any rows from an earlier apply cleared first.
SFB=$(migration saved_filter_bookmarks)
sfb_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$SFB")
sfb_down=$(awk '/-- migrate:down/{f=1;next}f' "$SFB")
sfb_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND bookmark IS NOT NULL
  AND collection IN ('manufacturing_operations','test_sessions','physical_samples');
INSERT INTO directus_presets (bookmark, collection, filter) VALUES
  ('Failed','test_sessions','{"curated":true}'),
  ('Machining','manufacturing_operations','{"process_category":{"_eq":"machining"}}');
$sfb_up
SELECT 'up:' || count(*) FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND bookmark IS NOT NULL
  AND collection IN ('manufacturing_operations','test_sessions','physical_samples') AND bookmark <> 'Machining';
SELECT 'up_curated_kept:' || (filter::jsonb ->> 'curated') FROM directus_presets WHERE bookmark='Failed' AND collection='test_sessions';
SELECT 'up_mine:' || (filter::jsonb #>> '{_and,0,owner_person_id,user_id,_eq}') FROM directus_presets WHERE bookmark='My samples';
SELECT 'up_fast:' || (filter::jsonb #>> '{_and,1,operation_date,_gte}') FROM directus_presets WHERE bookmark='FAST runs, last 7 days';
SELECT 'up_needs:' || (filter::jsonb #>> '{_and,0,status,_eq}') FROM directus_presets WHERE bookmark='Needs analysis';
$sfb_up
SELECT 'up_idempotent:' || count(*) FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND bookmark IS NOT NULL
  AND collection IN ('manufacturing_operations','test_sessions','physical_samples') AND bookmark <> 'Machining';
$sfb_down
SELECT 'down:' || string_agg(bookmark, ',' ORDER BY bookmark) FROM directus_presets WHERE bookmark IS NOT NULL
  AND collection IN ('manufacturing_operations','test_sessions','physical_samples');
ROLLBACK;
SQL
)
expect_line sfb_out "up:7" "up: seven global bookmarks present"
expect_line sfb_out "up_curated_kept:true" "up: an existing (curated) bookmark is left alone"
expect_line sfb_out 'up_mine:$CURRENT_USER' "up: My samples filters on the owner's linked Directus user"
expect_line sfb_out 'up_fast:$NOW(-7 days)' "up: FAST runs, last 7 days uses a rolling 7-day window"
expect_line sfb_out "up_needs:processed" "up: Needs analysis uses a real status value"
expect_line sfb_out "up_idempotent:7" "up is idempotent"
expect_line sfb_out "down:Machining" "down: removes the seven bookmarks and keeps other bookmarks"

# scripts/configure_directus.sql seeds the same seven bookmarks as the migration (an operator may
# run either first, and it is re-run after every change), so the two lists must not drift apart.
CFG=scripts/configure_directus.sql
# Each extraction starts at the file's saved-filters comment block ($2), so a VALUES list elsewhere
# in the file (configure_directus.sql has several) cannot be picked up instead.
# The anchor is a literal line prefix (index(), not a regex): awk -v processes backslash escapes,
# and gawk (CI) and mawk disagree on "\(", which once made this test pass locally and fail in CI.
sfb_values() { awk -v anchor="$2" 'index($0, anchor) == 1 {a=1} a&&/^FROM \(VALUES/{f=1;next} f&&/^\) AS v\(/{exit} f' "$1"; }
sfb_mig_values=$(sfb_values "$SFB" '-- D12: saved filters')
sfb_cfg_values=$(sfb_values "$CFG" '-- Saved filters (migration 135)')
[[ -n "$sfb_mig_values" && "$sfb_mig_values" == "$sfb_cfg_values" ]] \
    && ok "configure_directus.sql seeds the same bookmark rows as migration 135" \
    || bad "configure_directus.sql and migration 135 bookmark VALUES differ"

# Run the script's bookmark section (from "Global bookmarks" to the fields section; it needs no
# temp table, unlike the rest of the script, so it can run twice in one transaction) twice, with a
# stale bookmark (removed by its clean-up) and a curated "My samples" (kept) seeded. Rolled back.
cfg_bm=$(awk '/^-- ── Global bookmarks/{f=1}/^-- 2\. FIELDS/{f=0}f' "$CFG")
cfg_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND bookmark IS NOT NULL
  AND collection IN ('manufacturing_operations','test_sessions','physical_samples');
INSERT INTO directus_presets (bookmark, collection, filter) VALUES
  ('Stale view','physical_samples','{}'),
  ('My samples','physical_samples','{"curated":true}');
$cfg_bm
SELECT 'run1_saved:' || count(*) FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND (collection, bookmark) IN (
  ('manufacturing_operations','My operations'), ('manufacturing_operations','FAST runs, last 7 days'),
  ('manufacturing_operations','Missing outcome'), ('test_sessions','Failed'), ('test_sessions','Needs analysis'),
  ('physical_samples','My samples'), ('physical_samples','No location'));
$cfg_bm
SELECT 'run2_saved:' || count(*) FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND (collection, bookmark) IN (
  ('manufacturing_operations','My operations'), ('manufacturing_operations','FAST runs, last 7 days'),
  ('manufacturing_operations','Missing outcome'), ('test_sessions','Failed'), ('test_sessions','Needs analysis'),
  ('physical_samples','My samples'), ('physical_samples','No location'));
SELECT 'run2_duplicates:' || count(*) FROM (
  SELECT 1 FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND bookmark IS NOT NULL
    AND collection IN ('manufacturing_operations','test_sessions','physical_samples')
  GROUP BY collection, bookmark HAVING count(*) > 1) d;
SELECT 'run2_fixed:' || count(*) FROM directus_presets WHERE "user" IS NULL AND role IS NULL AND (collection, bookmark) IN (
  ('manufacturing_operations','Machining'), ('manufacturing_operations','FAST'), ('physical_samples','Samples'));
SELECT 'run2_curated_kept:' || (filter::jsonb ->> 'curated') FROM directus_presets WHERE bookmark='My samples' AND collection='physical_samples';
SELECT 'run2_stale:' || count(*) FROM directus_presets WHERE bookmark='Stale view';
ROLLBACK;
SQL
)
expect_line cfg_out "run1_saved:7" "configure_directus.sql: seven saved-filter bookmarks after one run"
expect_line cfg_out "run2_saved:7" "configure_directus.sql: still seven, each once, after a second run"
expect_line cfg_out "run2_duplicates:0" "configure_directus.sql: no bookmark is duplicated by a re-run"
expect_line cfg_out "run2_fixed:3" "configure_directus.sql: Machining, FAST and Samples present once each"
expect_line cfg_out "run2_curated_kept:true" "configure_directus.sql: a curated saved filter survives a re-run"
expect_line cfg_out "run2_stale:0" "configure_directus.sql: its clean-up still removes unknown global bookmarks"

echo "== Report (Generate PDF) buttons =="
# The d1-report-button field must be registered on the sample, operation and test forms.
# directus_fields is an empty stub in CI, so run the migration's up then down in a rolled-back
# transaction, with a hand-added button seeded to prove the up leaves it alone.
RPT=$(migration report_buttons)
rpt_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RPT")
rpt_down=$(awk '/-- migrate:down/{f=1;next}f' "$RPT")
rpt_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_fields WHERE field = 'report_button';
INSERT INTO directus_fields (collection, field, interface, sort) VALUES ('test_sessions','report_button','d1-report-button',99);
$rpt_up
SELECT 'up_rows:' || string_agg(collection || '=' || coalesce(options::jsonb->>'label', '-'), ',' ORDER BY collection) FROM directus_fields WHERE field='report_button';
SELECT 'up_kept_manual:' || sort FROM directus_fields WHERE collection='test_sessions' AND field='report_button';
$rpt_up
SELECT 'up_idempotent:' || count(*) FROM directus_fields WHERE field='report_button';
$rpt_down
SELECT 'down_rows:' || count(*) FROM directus_fields WHERE field='report_button';
SELECT 'down_kept_manual:' || sort FROM directus_fields WHERE collection='test_sessions' AND field='report_button';
ROLLBACK;
SQL
)
expect_line rpt_out "up_rows:manufacturing_operations=Generate operation PDF,physical_samples=Generate sample PDF,test_sessions=-" "up: buttons added on samples and operations, hand-added test button kept"
expect_line rpt_out "up_kept_manual:99" "up: an existing button keeps its sort (not overwritten)"
expect_line rpt_out "up_idempotent:3" "up: re-running adds no duplicates"
expect_line rpt_out "down_rows:1" "down: the buttons the up added are removed"
expect_line rpt_out "down_kept_manual:99" "down: a hand-added button is left alone"

echo "== Natural ordering of ID codes (#115) =="
# The code columns use the ICU numeric collation natural_sort, so ORDER BY (and a Directus
# column-header sort) puts 9 < 10 < 151 < 1000 and ...-F9 < ...-F10. Test rows live in a
# rolled-back transaction; the migration's down + up are replayed in it too.
NAT=$(migration natural_code_collation)
nat_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$NAT")
nat_down=$(awk '/-- migrate:down/{f=1;next}f' "$NAT")
run_eq "natural_sort is an ICU collation" \
    "SELECT count(*) FROM pg_collation WHERE collname = 'natural_sort' AND collprovider = 'i'" \
    "1"
run_eq "the 12 code columns use natural_sort" \
    "SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND collation_name = 'natural_sort'
       AND (table_name, column_name) IN (
           ('physical_samples','sample_code'), ('manufacturing_operations','pass_code'),
           ('tools','tool_code'), ('cutting_inserts','insert_code'),
           ('tool_boxes','tool_box_code'), ('insert_edges','edge_code'),
           ('raw_stock_lots','lot_code'), ('projects','project_code'),
           ('materials','alloy_code'), ('equipment','equipment_code'),
           ('campaigns','campaign_code'), ('project_rollup','code'))" \
    "12"
run_eq "v_project_rollup.code is natural_sort" \
    "SELECT c.collname FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
     WHERE a.attrelid = 'v_project_rollup'::regclass AND a.attname = 'code'" \
    "natural_sort"
run_eq "code_sort is still generated, in the default collation" \
    "SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'code_sort' AND is_generated = 'ALWAYS'
       AND collation_name IS NULL AND table_name IN ('physical_samples','manufacturing_operations')" \
    "2"
run_eq "recreated views keep the text-to-SQL read grant" \
    "SELECT count(*) FROM unnest(ARRAY['v_project_rollup','v_complete_sample_history',
        'v_manufacturing_operations_full','v_sample_genealogy_flat','v_stock_provenance',
        'v_test_sessions_full','v_tooling_hierarchy']) AS v(name)
     WHERE has_table_privilege('d1_llm_readonly', v.name, 'SELECT')
       AND obj_description(v.name::regclass, 'pg_class') IS NOT NULL" \
    "7"
nat_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_code) VALUES
  ('1000-TESTNAT-MF-2026-10-1'), ('151-TESTNAT-MF-2026-10-1'), ('99-TESTNAT-MF-2026-10-1'),
  ('10-TESTNAT-MF-2026-10-1'), ('9-TESTNAT-MF-2026-10-1'),
  ('9-TESTNAT-MR-2023-03-23-F10'), ('9-TESTNAT-MR-2023-03-23-F9');
SELECT 'order:' || string_agg(split_part(sample_code, '-', 1), '<' ORDER BY sample_code)
  FROM physical_samples WHERE sample_code LIKE '%-TESTNAT-MF-%';
SELECT 'suffix:' || string_agg(substring(sample_code FROM 'F[0-9]+$'), '<' ORDER BY sample_code)
  FROM physical_samples WHERE sample_code LIKE '%-TESTNAT-MR-%';
SELECT 'view:' || string_agg(split_part(sample_code, '-', 1), '<' ORDER BY sample_code)
  FROM v_complete_sample_history WHERE sample_code LIKE '%-TESTNAT-MF-%';
SELECT 'code_sort:' || code_sort FROM physical_samples WHERE sample_code = '9-TESTNAT-MF-2026-10-1';
-- project rollup: the cache table Directus shows and the live view it is refreshed from
-- (the operations trigger refreshes project_rollup on insert)
INSERT INTO projects (project_code, project_name) VALUES ('ZZ-TESTNAT', 'natural rollup probe');
INSERT INTO physical_samples (sample_code) VALUES ('TESTNAT-ROLLUP-SAMPLE');
INSERT INTO manufacturing_operations (method_id, project_id, sample_id, pass_code)
SELECT (SELECT method_id FROM manufacturing_methods LIMIT 1),
       (SELECT project_id FROM projects WHERE project_code = 'ZZ-TESTNAT'),
       (SELECT sample_id FROM physical_samples WHERE sample_code = 'TESTNAT-ROLLUP-SAMPLE'),
       c
FROM unnest(ARRAY['1000-TESTNATRU-MF-1', '151-TESTNATRU-MF-1', '99-TESTNATRU-MF-1',
                  '10-TESTNATRU-MF-1', '9-TESTNATRU-MF-1',
                  '9-TESTNATRU-MR-F10', '9-TESTNATRU-MR-F9']) AS c;
SELECT 'rollup_table:' || string_agg(split_part(code, '-', 1), '<' ORDER BY code)
  FROM project_rollup WHERE kind = 'operation' AND code LIKE '%-TESTNATRU-MF-%';
SELECT 'rollup_table_suffix:' || string_agg(substring(code FROM 'F[0-9]+$'), '<' ORDER BY code)
  FROM project_rollup WHERE kind = 'operation' AND code LIKE '%-TESTNATRU-MR-%';
SELECT 'rollup_view:' || string_agg(split_part(code, '-', 1), '<' ORDER BY code)
  FROM v_project_rollup WHERE kind = 'operation' AND code LIKE '%-TESTNATRU-MF-%';
SELECT 'rollup_view_suffix:' || string_agg(substring(code FROM 'F[0-9]+$'), '<' ORDER BY code)
  FROM v_project_rollup WHERE kind = 'operation' AND code LIKE '%-TESTNATRU-MR-%';
SELECT 'unique:' || count(*) FROM physical_samples WHERE sample_code = '10-TESTNAT-MF-2026-10-1';
-- row_id formula: d1-project-items (packages/d1-ui/src/rollupLinks.ts) recomputes these hashes
-- in the browser to link rollup rows to records, so the two must not drift apart.
SELECT 'row_id_sample:' || (r.row_id = md5('sample:' || r.project_id::text || ':' || sa.sample_id::text))
  FROM project_rollup r JOIN physical_samples sa ON sa.sample_code = r.code
  WHERE r.kind = 'sample' AND r.code = 'TESTNAT-ROLLUP-SAMPLE';
SELECT 'row_id_operation:' || (r.row_id = md5('operation:' || o.operation_id::text))
  FROM project_rollup r JOIN manufacturing_operations o ON o.pass_code = r.code
  WHERE r.kind = 'operation' AND r.code = '9-TESTNATRU-MF-1';
$nat_down
SELECT 'down_columns:' || count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND collation_name = 'natural_sort';
SELECT 'down_collation:' || count(*) FROM pg_collation WHERE collname = 'natural_sort';
SELECT 'down_rollup_collation:' || count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'project_rollup' AND column_name = 'code'
    AND collation_name IS NULL;
$nat_up
SELECT 'reup_order:' || string_agg(split_part(sample_code, '-', 1), '<' ORDER BY sample_code)
  FROM physical_samples WHERE sample_code LIKE '%-TESTNAT-MF-%';
SELECT 'reup_rollup_table:' || string_agg(split_part(code, '-', 1), '<' ORDER BY code)
  FROM project_rollup WHERE kind = 'operation' AND code LIKE '%-TESTNATRU-MF-%';
SELECT 'reup_rollup_view:' || string_agg(split_part(code, '-', 1), '<' ORDER BY code)
  FROM v_project_rollup WHERE kind = 'operation' AND code LIKE '%-TESTNATRU-MF-%';
SELECT 'reup_views:' || count(*) FROM pg_views
  WHERE schemaname = 'public' AND viewname IN ('v_project_rollup','v_complete_sample_history',
    'v_manufacturing_operations_full','v_sample_genealogy_flat','v_stock_provenance',
    'v_test_sessions_full','v_tooling_hierarchy');
ROLLBACK;
SQL
)
expect_line nat_out "order:9<10<99<151<1000" "sample_code sorts by number: 9 < 10 < 99 < 151 < 1000"
expect_line nat_out "suffix:F9<F10" "later digit runs too: ...-F9 < ...-F10"
expect_line nat_out "view:9<10<99<151<1000" "views inherit the ordering (v_complete_sample_history)"
expect_line nat_out "code_sort:00000009-TESTNAT-MF-2026-10-1" "code_sort keeps its zero-padded value"
expect_line nat_out "unique:1" "equality is unchanged"
expect_line nat_out "row_id_sample:true" "project_rollup.row_id of a sample is md5('sample:' || project || ':' || id) (client link matching)"
expect_line nat_out "row_id_operation:true" "project_rollup.row_id of an operation is md5('operation:' || id) (client link matching)"
expect_line nat_out "rollup_table:9<10<99<151<1000" "project_rollup (the Directus cache table) sorts by number: 9 < 10 < 99 < 151 < 1000"
expect_line nat_out "rollup_table_suffix:F9<F10" "project_rollup: ...-F9 < ...-F10"
expect_line nat_out "rollup_view:9<10<99<151<1000" "v_project_rollup sorts by number: 9 < 10 < 99 < 151 < 1000"
expect_line nat_out "rollup_view_suffix:F9<F10" "v_project_rollup: ...-F9 < ...-F10"
expect_line nat_out "down_columns:0" "down: code columns back on the default collation"
expect_line nat_out "down_collation:0" "down: collation dropped"
expect_line nat_out "reup_order:9<10<99<151<1000" "up again: natural ordering restored"
expect_line nat_out "down_rollup_collation:1" "down: project_rollup.code back on the default collation"
expect_line nat_out "reup_rollup_table:9<10<99<151<1000" "up again: project_rollup natural ordering restored"
expect_line nat_out "reup_rollup_view:9<10<99<151<1000" "up again: v_project_rollup natural ordering restored"
expect_line nat_out "reup_views:7" "up again: all 7 dependent views recreated"
