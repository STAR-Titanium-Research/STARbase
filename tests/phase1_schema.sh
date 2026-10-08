#!/usr/bin/env bash
# Phase 1 schema test: verifies migrations apply, views exist, triggers fire,
# seed data loads, and code-generation functions return correct output.
# Requires a running Postgres with DATABASE_URL set, or a local stack via `make up`.
#
# Usage:  DATABASE_URL=postgres://d1:secret@localhost:5432/d1_test bash tests/phase1_schema.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. postgres://d1:pw@localhost:5432/d1_db)}"
PSQL="psql $DATABASE_URL --no-psqlrc -t -A"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run() {
    # run "label" "SQL"  — expects non-empty result from SQL
    local label="$1" sql="$2"
    local result
    result=$($PSQL -c "$sql" 2>&1) || { bad "$label (psql error: $result)"; return; }
    [[ -n "$result" ]] && ok "$label" || bad "$label (empty result)"
}
run_eq() {
    # run_eq "label" "SQL" "expected"
    local label="$1" sql="$2" expected="$3"
    local result
    result=$($PSQL -c "$sql" 2>&1) || { bad "$label (psql error: $result)"; return; }
    [[ "$result" == "$expected" ]] && ok "$label" || bad "$label (got '$result', want '$expected')"
}

echo "== Core tables exist =="
for tbl in \
    alloying_elements material_iso_classifications materials \
    manufacturing_methods equipment tools insert_types \
    projects raw_stock_lots \
    tool_boxes cutting_inserts insert_edges \
    physical_samples sample_genealogy sample_stock_provenance \
    manufacturing_operations test_sessions audit_logs
do
    run "$tbl exists" \
        "SELECT to_regclass('public.$tbl')::TEXT"
done

echo "== Views exist =="
for view in \
    v_complete_sample_history v_tooling_hierarchy v_sample_genealogy_flat \
    v_manufacturing_operations_full v_stock_provenance v_test_sessions_full \
    v_project_rollup
do
    run "$view exists" \
        "SELECT to_regclass('public.$view')::TEXT"
done

echo "== Extensions loaded =="
run "uuid-ossp"  "SELECT extname FROM pg_extension WHERE extname = 'uuid-ossp'"
run "vector"     "SELECT extname FROM pg_extension WHERE extname = 'vector'"
run "pg_trgm"    "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'"

echo "== Seed data present =="
run "ISO groups seeded" \
    "SELECT iso_code FROM material_iso_classifications WHERE iso_code = 'S'"
run "Ti-6Al-4V seeded" \
    "SELECT alloy_code FROM materials WHERE alloy_code = 'AA'"
run "FAST method seeded" \
    "SELECT method_code FROM manufacturing_methods WHERE method_code = 'MF'"
# migration 129 back-fills process_category before the seed runs on a fresh install, so the seed carries it
run_eq "seeded methods carry the process_category migration 129 maps" \
    "SELECT string_agg(method_code || '=' || COALESCE(process_category, 'NULL'), ',' ORDER BY method_code)
       FROM manufacturing_methods WHERE method_code IN ('HT','MC','MF','MM','MO','MR')" \
    "HT=heat_treatment,MC=machining,MF=sintering,MM=machining,MO=deformation,MR=deformation"
run "Equipment seeded" \
    "SELECT equipment_code FROM equipment WHERE equipment_code = 'NLX-2500'"
echo "== Code-generation functions =="
run_eq "generate_sample_code" \
    "SELECT generate_sample_code(10, 'AA', 'MF', '2023-06-03'::DATE)" \
    "10-AA-MF-2023-06-03"

run_eq "generate_pass_code" \
    "SELECT generate_pass_code('9-AA-MR-2023-03-23', 'F', 9)" \
    "9-AA-MR-2023-03-23-F9"

run_eq "generate_force_file_id" \
    "SELECT generate_force_file_id('9-AA-MR-2023-03-23-F9', 20, 0.05, 0.1)" \
    "9-AA-MR-2023-03-23-F9-20MPM_0.05feed_0.1DoC"

echo "== Directus group-detail accordions are renderable =="
# Regression guard for the "Unexpected Error" (TypeError: ...reading 'map') that the
# interface-group-detail throws at render time when a group field lacks the 'group'
# special. Directus needs special to include 'group' (alongside alias,no-data) to
# resolve the group's child fields; without it the accordion crashes when shown.
# This affected EVERY accordion on manufacturing_operations and test_sessions.
run_eq "every group-detail field carries the 'group' special" \
    "SELECT count(*) FROM directus_fields
     WHERE interface = 'group-detail'
       AND (special IS NULL OR special NOT LIKE '%group%')" \
    "0"

echo "== Sample geometry: round bar form migration =="
# CI has no Directus bootstrap rows (directus_fields is an empty stub), so seed the pre-migration
# state, apply the migration's up then down SQL, and assert both — all in a rolled-back transaction.
MIG=db/migrations/20260930000114_round_bar_form.sql
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
rb_check() { grep -qx "$1" <<<"$rb_out" && ok "$2" || bad "$2 (psql output: $rb_out)"; }
rb_check "up_form_choice:1" "up: Geometry dropdown offers round_bar"
rb_check "up_dim_fields:2" "up: diameter_mm and length_mm are shown for round_bar"
rb_check "down_fields:0" "down: round_bar removed from dropdown and conditions"
rb_check "down_form:cylinder" "down: round_bar samples are mapped to cylinder"

echo "== Sample geometry: legacy forms are back-filled =="
# Seed old-vocabulary samples, apply the back-fill's up SQL, assert, then ROLLBACK.
BACKFILL=db/migrations/20260930000115_backfill_legacy_geometry_forms.sql
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
bf_check() { grep -qx "$1" <<<"$bf_out" && ok "$2" || bad "$2 (psql output: $bf_out)"; }
bf_check "lg:TEST-LG-001=cylinder" "cylindrical -> cylinder"
bf_check "lg:TEST-LG-002=block" "Rectangular -> block (case-insensitive)"
bf_check "lg:TEST-LG-003=disc" "current values are left alone (disc)"
bf_check "lg:TEST-LG-004=round_bar" "current values are left alone (round_bar)"

echo "== Lab Member can save a cut from the Force App =="
# directus_permissions is a stub in CI: run the migration's up then down in a rolled-back
# transaction, with an unrelated Lab Member row and the same row on another policy seeded to prove
# the down removes only what the up added.
FAS=db/migrations/20261005000133_lab_member_force_app_save.sql
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
fas_check() { grep -qx "$1" <<<"$fas_out" && ok "$2" || bad "$2 (psql output: $fas_out)"; }
fas_check "up:directus_files.create,directus_files.read,machining_force_analysis.create,machining_force_analysis.update" "up: Lab Member gets file create+read and force-analysis create (update kept)"
fas_check "up_idempotent:4" "up is idempotent"
fas_check "down:directus_files.read,machining_force_analysis.update" "down: removes only the added grants (update and other policies kept)"

echo "== Saved-filter bookmarks (D12) =="
# directus_presets is a stub in CI: run the migration's up then down in a rolled-back transaction,
# with a hand-curated "Failed" bookmark (kept by the up) and an unrelated Machining bookmark
# (kept by the down) seeded, and any rows from an earlier apply cleared first.
SFB=db/migrations/20261006000135_saved_filter_bookmarks.sql
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
sfb_check() { grep -qx "$1" <<<"$sfb_out" && ok "$2" || bad "$2 (psql output: $sfb_out)"; }
sfb_check "up:7" "up: seven global bookmarks present"
sfb_check "up_curated_kept:true" "up: an existing (curated) bookmark is left alone"
sfb_check 'up_mine:$CURRENT_USER' "up: My samples filters on the owner's linked Directus user"
sfb_check 'up_fast:$NOW(-7 days)' "up: FAST runs, last 7 days uses a rolling 7-day window"
sfb_check "up_needs:processed" "up: Needs analysis uses a real status value"
sfb_check "up_idempotent:7" "up is idempotent"
sfb_check "down:Machining" "down: removes the seven bookmarks and keeps other bookmarks"

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
cfg_check() { grep -qx "$1" <<<"$cfg_out" && ok "$2" || bad "$2 (psql output: $cfg_out)"; }
cfg_check "run1_saved:7" "configure_directus.sql: seven saved-filter bookmarks after one run"
cfg_check "run2_saved:7" "configure_directus.sql: still seven, each once, after a second run"
cfg_check "run2_duplicates:0" "configure_directus.sql: no bookmark is duplicated by a re-run"
cfg_check "run2_fixed:3" "configure_directus.sql: Machining, FAST and Samples present once each"
cfg_check "run2_curated_kept:true" "configure_directus.sql: a curated saved filter survives a re-run"
cfg_check "run2_stale:0" "configure_directus.sql: its clean-up still removes unknown global bookmarks"

echo "== Report (Generate PDF) buttons =="
# The d1-report-button field must be registered on the sample, operation and test forms.
# directus_fields is an empty stub in CI, so run the migration's up then down in a rolled-back
# transaction, with a hand-added button seeded to prove the up leaves it alone.
RPT=db/migrations/20261003000117_report_buttons.sql
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
rpt_check() { grep -qx "$1" <<<"$rpt_out" && ok "$2" || bad "$2 (psql output: $rpt_out)"; }
rpt_check "up_rows:manufacturing_operations=Generate operation PDF,physical_samples=Generate sample PDF,test_sessions=-" "up: buttons added on samples and operations, hand-added test button kept"
rpt_check "up_kept_manual:99" "up: an existing button keeps its sort (not overwritten)"
rpt_check "up_idempotent:3" "up: re-running adds no duplicates"
rpt_check "down_rows:1" "down: the buttons the up added are removed"
rpt_check "down_kept_manual:99" "down: a hand-added button is left alone"

echo "== Natural ordering of ID codes (#115) =="
# The code columns use the ICU numeric collation natural_sort, so ORDER BY (and a Directus
# column-header sort) puts 9 < 10 < 151 < 1000 and ...-F9 < ...-F10. Test rows live in a
# rolled-back transaction; the migration's down + up are replayed in it too.
NAT=db/migrations/20261002000116_natural_code_collation.sql
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
nat_check() { grep -qx "$1" <<<"$nat_out" && ok "$2" || bad "$2 (psql output: $nat_out)"; }
nat_check "order:9<10<99<151<1000" "sample_code sorts by number: 9 < 10 < 99 < 151 < 1000"
nat_check "suffix:F9<F10" "later digit runs too: ...-F9 < ...-F10"
nat_check "view:9<10<99<151<1000" "views inherit the ordering (v_complete_sample_history)"
nat_check "code_sort:00000009-TESTNAT-MF-2026-10-1" "code_sort keeps its zero-padded value"
nat_check "unique:1" "equality is unchanged"
nat_check "row_id_sample:true" "project_rollup.row_id of a sample is md5('sample:' || project || ':' || id) (client link matching)"
nat_check "row_id_operation:true" "project_rollup.row_id of an operation is md5('operation:' || id) (client link matching)"
nat_check "rollup_table:9<10<99<151<1000" "project_rollup (the Directus cache table) sorts by number: 9 < 10 < 99 < 151 < 1000"
nat_check "rollup_table_suffix:F9<F10" "project_rollup: ...-F9 < ...-F10"
nat_check "rollup_view:9<10<99<151<1000" "v_project_rollup sorts by number: 9 < 10 < 99 < 151 < 1000"
nat_check "rollup_view_suffix:F9<F10" "v_project_rollup: ...-F9 < ...-F10"
nat_check "down_columns:0" "down: code columns back on the default collation"
nat_check "down_collation:0" "down: collation dropped"
nat_check "reup_order:9<10<99<151<1000" "up again: natural ordering restored"
nat_check "down_rollup_collation:1" "down: project_rollup.code back on the default collation"
nat_check "reup_rollup_table:9<10<99<151<1000" "up again: project_rollup natural ordering restored"
nat_check "reup_rollup_view:9<10<99<151<1000" "up again: v_project_rollup natural ordering restored"
nat_check "reup_views:7" "up again: all 7 dependent views recreated"

echo "== Campaigns layer (trials + testing campaigns) =="
run "campaigns table exists" \
    "SELECT to_regclass('public.campaigns')::TEXT"
run "manufacturing_operations.campaign_id column exists" \
    "SELECT column_name FROM information_schema.columns
     WHERE table_name='manufacturing_operations' AND column_name='campaign_id'"
run "test_sessions.campaign_id column exists" \
    "SELECT column_name FROM information_schema.columns
     WHERE table_name='test_sessions' AND column_name='campaign_id'"
run_eq "campaign_type CHECK restricts to the two kinds" \
    "SELECT count(*) FROM information_schema.check_constraints
     WHERE constraint_name LIKE '%campaign_type%'
       AND check_clause LIKE '%machining_trial%'
       AND check_clause LIKE '%testing_campaign%'" \
    "1"
# owner_person_id (062) and campaign_samples.campaign_id (087), plus the project_id link and the two
# campaign_id links of operations and tests that migration 141 registers for the row filters (ADR-0011).
run_eq "Directus relations for campaigns are registered (5)" \
    "SELECT count(*) FROM directus_relations
     WHERE one_collection='campaigns' OR many_collection='campaigns'
        OR (many_collection IN ('manufacturing_operations','test_sessions') AND many_field='campaign_id')" \
    "5"

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
vp_check() { grep -qx "$1" <<<"$vp_out" && ok "$2" || bad "$2 (psql output: $vp_out)"; }
vp_check "ops_parity:true" "v_manufacturing_operations_full has one row per operation"
vp_check "ts_parity:true" "v_test_sessions_full has one row per test session"
vp_check "op_out_only_in_view:1" "operation with only output_sample_id is in the view"
vp_check "ts_subject_only_in_view:1" "subject-only test session is in the view"
vp_check "ts_with_sample_code:TEST-VP-001" "sample columns are still filled when there is a sample"

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

echo "== Audit coverage: every business table, keyed by its primary key (review 5.3) =="
# Tables deliberately NOT audited: the log itself, dbmate bookkeeping, Directus system tables,
# derived caches (project_rollup, semantic_embeddings), the crawler's heartbeat row,
# audit_log_actors (the actor side-table of the log itself). Migration 141's backup of Directus
# permission rows lives in the private schema d1_private, so this public-schema check never sees it.
AUDIT_EXCLUDED="'audit_logs','audit_log_actors','schema_migrations','project_rollup','semantic_embeddings','force_crawler_state'"
run_eq "every business table has an audit trigger (missing: none)" \
    "SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
       AND c.relname NOT LIKE 'directus\\_%' AND c.relname NOT IN ($AUDIT_EXCLUDED)
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                       WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                         AND t.tgfoid = 'audit_trigger_function'::regproc
                         AND (t.tgtype & 1) = 1                -- FOR EACH ROW
                         AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16)" \
    ""
run_eq "every audited table has a primary key (record_id is never 'unknown')" \
    "SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgfoid = 'audit_trigger_function'::regproc
     WHERE NOT t.tgisinternal
       AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)" \
    ""

# INSERT / UPDATE / DELETE on tables that were unaudited before 20261003000121, in a rolled-back
# transaction. people has a UUID key, alloying_elements a text key.
au_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-0000000000f1', 'Audit Test Person');
UPDATE people SET full_name = 'Audit Test Renamed' WHERE person_id = 'c0000000-0000-4000-8000-0000000000f1';
DELETE FROM people WHERE person_id = 'c0000000-0000-4000-8000-0000000000f1';
INSERT INTO alloying_elements (symbol, element_name, atomic_number) VALUES ('Zz', 'Zzium', 999);
UPDATE alloying_elements SET element_name = 'Zzium2' WHERE symbol = 'Zz';
DELETE FROM alloying_elements WHERE symbol = 'Zz';
SELECT 'people_actions:' || string_agg(action_type, ',' ORDER BY log_id) FROM audit_logs
  WHERE table_name = 'people' AND record_id = 'c0000000-0000-4000-8000-0000000000f1';
SELECT 'people_changed:' || (changed_fields -> 'full_name' ->> 'old') || '>' || (changed_fields -> 'full_name' ->> 'new')
  FROM audit_logs WHERE table_name = 'people' AND action_type = 'UPDATE' AND record_id = 'c0000000-0000-4000-8000-0000000000f1';
SELECT 'people_delete_before:' || (row_before ->> 'full_name') FROM audit_logs
  WHERE table_name = 'people' AND action_type = 'DELETE' AND record_id = 'c0000000-0000-4000-8000-0000000000f1';
SELECT 'element_actions:' || string_agg(action_type, ',' ORDER BY log_id) FROM audit_logs
  WHERE table_name = 'alloying_elements' AND record_id = 'Zz';
SELECT 'element_changed:' || string_agg(k, ',' ORDER BY k) FROM audit_logs, jsonb_object_keys(changed_fields) AS k
  WHERE table_name = 'alloying_elements' AND action_type = 'UPDATE' AND record_id = 'Zz';
SELECT 'unknown_ids:' || count(*) FROM audit_logs WHERE record_id = 'unknown';
ROLLBACK;
SQL
)
au_check() { grep -qx "$1" <<<"$au_out" && ok "$2" || bad "$2 (psql output: $au_out)"; }
au_check "people_actions:INSERT,UPDATE,DELETE" "people: INSERT, UPDATE and DELETE each write an audit row keyed by person_id"
au_check "people_changed:Audit Test Person>Audit Test Renamed" "people: UPDATE records the changed field (old and new)"
au_check "people_delete_before:Audit Test Renamed" "people: DELETE keeps the row as it was"
au_check "element_actions:INSERT,UPDATE,DELETE" "alloying_elements: audit rows keyed by its text primary key (symbol)"
au_check "element_changed:element_name" "alloying_elements: UPDATE changed_fields lists exactly the changed columns"
au_check "unknown_ids:0" "no audit row is logged with record_id 'unknown'"

# record_id was a guess from a fixed column list: an operation was logged under its sample_id.
rid_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-0000000000a3', 'T-C-AU', 'audit record_id test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-0000000000d2', 'TEST-AU-001');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000000c5', 'c0000000-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-0000000000d2', 'TEST-AU-OP');
INSERT INTO test_sessions (session_id, sample_id) VALUES ('c0000000-0000-4000-8000-0000000000e3', 'c0000000-0000-4000-8000-0000000000d2');
SELECT 'op_record_id:' || record_id FROM audit_logs WHERE table_name = 'manufacturing_operations' AND row_after ->> 'pass_code' = 'TEST-AU-OP';
SELECT 'ts_record_id:' || record_id FROM audit_logs WHERE table_name = 'test_sessions' AND row_after ->> 'session_id' = 'c0000000-0000-4000-8000-0000000000e3';
SELECT 'method_record_id:' || record_id FROM audit_logs WHERE table_name = 'manufacturing_methods' AND row_after ->> 'method_code' = 'T-C-AU';
ROLLBACK;
SQL
)
rid_check() { grep -qx "$1" <<<"$rid_out" && ok "$2" || bad "$2 (psql output: $rid_out)"; }
rid_check "op_record_id:c0000000-0000-4000-8000-0000000000c5" "operation audit rows carry operation_id, not sample_id"
rid_check "ts_record_id:c0000000-0000-4000-8000-0000000000e3" "test session audit rows carry session_id, not sample_id"
rid_check "method_record_id:c0000000-0000-4000-8000-0000000000a3" "newly audited manufacturing_methods carries method_id"

# machining_force_analysis: large derived envelopes are kept out of the audit snapshots.
mfa_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO directus_files (id) VALUES ('c0000000-0000-4000-8000-0000000000f2');
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-0000000000a4', 'T-C-MF', 'mfa audit test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-0000000000d3', 'TEST-MF-001');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000000c6', 'c0000000-0000-4000-8000-0000000000a4', 'c0000000-0000-4000-8000-0000000000d3', 'TEST-MF-OP');
INSERT INTO machining_force_analysis (id, operation_id, directus_files_id, series, fft, render_status)
VALUES ('c0000000-0000-4000-8000-0000000000f3', 'c0000000-0000-4000-8000-0000000000c6', 'c0000000-0000-4000-8000-0000000000f2',
        '{"fx":[1,2,3]}', '{"fx":[4,5,6]}', 'pending');
UPDATE machining_force_analysis SET render_status = 'done', series = '{"fx":[9,9,9]}' WHERE id = 'c0000000-0000-4000-8000-0000000000f3';
SELECT 'mfa_rows:' || count(*) FROM audit_logs WHERE table_name = 'machining_force_analysis' AND record_id = 'c0000000-0000-4000-8000-0000000000f3';
SELECT 'mfa_big_omitted:' || count(*) FROM audit_logs WHERE table_name = 'machining_force_analysis'
  AND record_id = 'c0000000-0000-4000-8000-0000000000f3'
  AND (coalesce(row_before, '{}') ?| ARRAY['series','fft','diag_metrics'] OR coalesce(row_after, '{}') ?| ARRAY['series','fft','diag_metrics']
       OR coalesce(changed_fields, '{}') ?| ARRAY['series','fft','diag_metrics']);
SELECT 'mfa_status_logged:' || (changed_fields -> 'render_status' ->> 'new') FROM audit_logs
  WHERE table_name = 'machining_force_analysis' AND action_type = 'UPDATE' AND record_id = 'c0000000-0000-4000-8000-0000000000f3';
ROLLBACK;
SQL
)
mfa_check() { grep -qx "$1" <<<"$mfa_out" && ok "$2" || bad "$2 (psql output: $mfa_out)"; }
mfa_check "mfa_rows:2" "machining_force_analysis: INSERT and UPDATE are audited"
mfa_check "mfa_big_omitted:0" "machining_force_analysis: series/fft/diag_metrics are left out of the snapshots"
mfa_check "mfa_status_logged:done" "machining_force_analysis: ordinary columns are still logged"

# Issue #190: a Force App cut over the recorder's .mat size limit has no .mat, so its analysis row
# goes in with directus_files_id NULL. The column must accept that (several NULLs, UNIQUE kept), and
# the down migration must refuse while such rows exist rather than silently deleting them.
NUL=db/migrations/20261008000140_machining_force_analysis_file_nullable.sql
nul_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$NUL")
nul_down=$(awk '/-- migrate:down/{f=1;next}f' "$NUL")
nul_seed="INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-0000000000a5', 'T-C-NF', 'nullable file test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-0000000000d4', 'TEST-NF-001');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000000c7', 'c0000000-0000-4000-8000-0000000000a5', 'c0000000-0000-4000-8000-0000000000d4', 'TEST-NF-OP');"
nul_out=$($PSQL 2>&1 <<SQL
BEGIN;
$nul_seed
INSERT INTO machining_force_analysis (id, operation_id, directus_files_id, status)
VALUES ('c0000000-0000-4000-8000-0000000000f4', 'c0000000-0000-4000-8000-0000000000c7', NULL, 'done'),
       ('c0000000-0000-4000-8000-0000000000f5', 'c0000000-0000-4000-8000-0000000000c7', NULL, 'done');
SELECT 'nul_rows:' || count(*) FROM machining_force_analysis WHERE operation_id = 'c0000000-0000-4000-8000-0000000000c7' AND directus_files_id IS NULL;
SELECT 'nul_unique_kept:' || count(*) FROM pg_constraint WHERE conname = 'machining_force_analysis_file_unique';
ROLLBACK;
SQL
)
nul_check() { grep -qx "$1" <<<"$nul_out" && ok "$2" || bad "$2 (psql output: $nul_out)"; }
nul_check "nul_rows:2" "machining_force_analysis: rows with a NULL directus_files_id insert (a cut with no .mat)"
nul_check "nul_unique_kept:1" "machining_force_analysis: the UNIQUE constraint on directus_files_id is kept"
nul_down_out=$($PSQL 2>&1 <<SQL
BEGIN;
$nul_seed
INSERT INTO machining_force_analysis (id, operation_id, directus_files_id, status)
VALUES ('c0000000-0000-4000-8000-0000000000f4', 'c0000000-0000-4000-8000-0000000000c7', NULL, 'done');
$nul_down
ROLLBACK;
SQL
)
grep -q "cannot restore NOT NULL" <<<"$nul_down_out" \
    && ok "down: refuses while rows with no .mat file exist" \
    || bad "down: refuses while rows with no .mat file exist (psql output: $nul_down_out)"
nul_roundtrip=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM machining_force_analysis WHERE directus_files_id IS NULL;
$nul_down
SELECT 'down_nullable:' || is_nullable FROM information_schema.columns WHERE table_name = 'machining_force_analysis' AND column_name = 'directus_files_id';
$nul_up
SELECT 'up_nullable:' || is_nullable FROM information_schema.columns WHERE table_name = 'machining_force_analysis' AND column_name = 'directus_files_id';
ROLLBACK;
SQL
)
nul_rt() { grep -qx "$1" <<<"$nul_roundtrip" && ok "$2" || bad "$2 (psql output: $nul_roundtrip)"; }
nul_rt "down_nullable:NO" "down: restores NOT NULL when no such rows exist"
nul_rt "up_nullable:YES" "up: drops NOT NULL again"

echo "== OCC triggers on every versioned table (review 5.4) =="
# schema_migrations.version is dbmate's bookkeeping column, not an OCC version.
run_eq "every table with a version column has an OCC BEFORE UPDATE trigger (missing: none)" \
    "SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '')
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> 'schema_migrations'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'version' AND a.attnum > 0 AND NOT a.attisdropped)
       AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                       WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                         AND t.tgfoid = 'occ_update_trigger_function'::regproc
                         AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16)  -- ROW, BEFORE, UPDATE" \
    ""
# Stale-write detection as documented in docs/data-dictionary.md: UPDATE ... WHERE version = <known>
# matches no row once another writer has bumped the version. tool_setup and diag_layer had no
# trigger, so their version never moved and a stale write went through.
occ_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO tool_setup (setup_id, setup_code) VALUES ('c0000000-0000-4000-8000-0000000000f4', 'TEST-OCC-SETUP');
UPDATE tool_setup SET notes = 'writer one' WHERE setup_id = 'c0000000-0000-4000-8000-0000000000f4' AND version = 1;
WITH stale AS (
    UPDATE tool_setup SET notes = 'writer two (stale)'
    WHERE setup_id = 'c0000000-0000-4000-8000-0000000000f4' AND version = 1 RETURNING 1)
SELECT 'stale_rows:' || count(*) FROM stale;
SELECT 'version:' || version || ' notes:' || notes FROM tool_setup WHERE setup_id = 'c0000000-0000-4000-8000-0000000000f4';
ROLLBACK;
SQL
)
occ_check() { grep -qx "$1" <<<"$occ_out" && ok "$2" || bad "$2 (psql output: $occ_out)"; }
occ_check "stale_rows:0" "tool_setup: an update on a stale version matches no row"
occ_check "version:2 notes:writer one" "tool_setup: version is bumped once and the stale write did not land"

echo "== Box intake: owners propagate and codes survive a delete (review 4.8) =="
# expand_tool_box_intake() is called directly so the test does not depend on how it is triggered:
# the box is inserted with no package_quantity, then given one, then expanded.
bi_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('c0000000-0000-4000-8000-0000000000f5');
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-0000000000f6', 'Intake Owner');
INSERT INTO insert_types (insert_type_id, type_code, short_code, inserts_per_box, edge_count)
VALUES ('c0000000-0000-4000-8000-0000000000f7', 'TEST-INTAKE-TYPE', 'TST4', 2, 2);
INSERT INTO tool_boxes (tool_box_id, insert_type_id, owner, owner_person_id)
VALUES ('c0000000-0000-4000-8000-0000000000f8', 'c0000000-0000-4000-8000-0000000000f7',
        'c0000000-0000-4000-8000-0000000000f5', 'c0000000-0000-4000-8000-0000000000f6');
UPDATE tool_boxes SET package_quantity = 3 WHERE tool_box_id = 'c0000000-0000-4000-8000-0000000000f8';
SELECT expand_tool_box_intake('c0000000-0000-4000-8000-0000000000f8');
SELECT 'boxes:' || string_agg(tool_box_code, ',' ORDER BY tool_box_code) FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-0000000000f7';
SELECT 'inserts:' || count(*) FROM cutting_inserts WHERE insert_type_id = 'c0000000-0000-4000-8000-0000000000f7';
SELECT 'edges:' || count(*) FROM insert_edges e JOIN cutting_inserts i USING (insert_id) WHERE i.insert_type_id = 'c0000000-0000-4000-8000-0000000000f7';
SELECT 'owned_boxes:' || count(*) FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-0000000000f7'
  AND owner_person_id = 'c0000000-0000-4000-8000-0000000000f6' AND owner = 'c0000000-0000-4000-8000-0000000000f5';
SELECT 'owned_inserts:' || count(*) FROM cutting_inserts WHERE insert_type_id = 'c0000000-0000-4000-8000-0000000000f7'
  AND owner_person_id = 'c0000000-0000-4000-8000-0000000000f6' AND owner = 'c0000000-0000-4000-8000-0000000000f5';
SELECT 'owned_edges:' || count(*) FROM insert_edges e JOIN cutting_inserts i USING (insert_id) WHERE i.insert_type_id = 'c0000000-0000-4000-8000-0000000000f7'
  AND e.owner_person_id = 'c0000000-0000-4000-8000-0000000000f6' AND e.owner = 'c0000000-0000-4000-8000-0000000000f5';
-- Delete the middle box, then take in a second delivery of the same type.
DELETE FROM tool_boxes WHERE tool_box_code = 'TST4-2';
INSERT INTO tool_boxes (tool_box_id, insert_type_id) VALUES ('c0000000-0000-4000-8000-0000000000f9', 'c0000000-0000-4000-8000-0000000000f7');
UPDATE tool_boxes SET package_quantity = 2 WHERE tool_box_id = 'c0000000-0000-4000-8000-0000000000f9';
SELECT expand_tool_box_intake('c0000000-0000-4000-8000-0000000000f9');
SELECT 'boxes_after:' || string_agg(tool_box_code, ',' ORDER BY tool_box_code) FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-0000000000f7';
ROLLBACK;
SQL
)
bi_check() { grep -qx "$1" <<<"$bi_out" && ok "$2" || bad "$2 (psql output: $bi_out)"; }
bi_check "boxes:TST4-1,TST4-2,TST4-3" "intake of 3 creates TST4-1..3"
bi_check "inserts:6" "2 inserts per box x 3 boxes"
bi_check "edges:12" "2 edges per insert x 6 inserts"
bi_check "owned_boxes:3" "owner_person_id and owner are copied onto every box (clones included)"
bi_check "owned_inserts:6" "owner_person_id and owner are copied onto every insert"
bi_check "owned_edges:12" "owner_person_id and owner are copied onto every edge"
bi_check "boxes_after:TST4-1,TST4-3,TST4-4,TST4-5" "intake after a box delete continues from the highest code (no collision)"

echo "== Owner cascade runs in Postgres (review 4.7) =="
# A box with two inserts of two edges each, owned by person 1. Rolled back at the end.
oc_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES
    ('c0000000-0000-4000-8000-000000000101', 'Cascade Owner One'),
    ('c0000000-0000-4000-8000-000000000102', 'Cascade Owner Two');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('c0000000-0000-4000-8000-000000000111', 'TEST-OC-BOX', 'c0000000-0000-4000-8000-000000000101');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id, owner_person_id) VALUES
    ('c0000000-0000-4000-8000-000000000121', 'TEST-OC-BOX-1', 'c0000000-0000-4000-8000-000000000111', 'c0000000-0000-4000-8000-000000000101'),
    ('c0000000-0000-4000-8000-000000000122', 'TEST-OC-BOX-2', 'c0000000-0000-4000-8000-000000000111', 'c0000000-0000-4000-8000-000000000101');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier, owner_person_id) VALUES
    ('c0000000-0000-4000-8000-000000000131', 'TEST-OC-BOX-1A', 'c0000000-0000-4000-8000-000000000121', 'A', 'c0000000-0000-4000-8000-000000000101'),
    ('c0000000-0000-4000-8000-000000000132', 'TEST-OC-BOX-1B', 'c0000000-0000-4000-8000-000000000121', 'B', 'c0000000-0000-4000-8000-000000000101'),
    ('c0000000-0000-4000-8000-000000000133', 'TEST-OC-BOX-2A', 'c0000000-0000-4000-8000-000000000122', 'A', 'c0000000-0000-4000-8000-000000000101'),
    ('c0000000-0000-4000-8000-000000000134', 'TEST-OC-BOX-2B', 'c0000000-0000-4000-8000-000000000122', 'B', 'c0000000-0000-4000-8000-000000000101');

-- 1. Owner change WITHOUT the flag: children are left alone.
UPDATE tool_boxes SET owner_person_id = 'c0000000-0000-4000-8000-000000000102' WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111';
SELECT 'no_flag_children_unchanged:' || (SELECT count(*) FROM cutting_inserts WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111' AND owner_person_id = 'c0000000-0000-4000-8000-000000000101')
    || '/' || (SELECT count(*) FROM insert_edges WHERE owner_person_id = 'c0000000-0000-4000-8000-000000000101' AND edge_code LIKE 'TEST-OC-BOX-%');

-- 2. The flag, with the owner written in the same UPDATE (box 2 -> person 1 again).
UPDATE tool_boxes SET owner_person_id = 'c0000000-0000-4000-8000-000000000101', cascade_ownership = TRUE WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111';
UPDATE tool_boxes SET owner_person_id = 'c0000000-0000-4000-8000-000000000102', cascade_ownership = TRUE WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111';
SELECT 'box_cascade_inserts:' || count(*) FROM cutting_inserts WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111' AND owner_person_id = 'c0000000-0000-4000-8000-000000000102';
SELECT 'box_cascade_edges:' || count(*) FROM insert_edges WHERE edge_code LIKE 'TEST-OC-BOX-%' AND owner_person_id = 'c0000000-0000-4000-8000-000000000102';
SELECT 'box_flag_reset:' || NOT cascade_ownership FROM tool_boxes WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111';

-- 3. Insert-level flag only reaches that insert's edges.
UPDATE cutting_inserts SET owner_person_id = 'c0000000-0000-4000-8000-000000000101', cascade_ownership = TRUE WHERE insert_id = 'c0000000-0000-4000-8000-000000000121';
SELECT 'insert_cascade_own_edges:' || count(*) FROM insert_edges WHERE insert_id = 'c0000000-0000-4000-8000-000000000121' AND owner_person_id = 'c0000000-0000-4000-8000-000000000101';
SELECT 'insert_cascade_other_edges:' || count(*) FROM insert_edges WHERE insert_id = 'c0000000-0000-4000-8000-000000000122' AND owner_person_id = 'c0000000-0000-4000-8000-000000000102';
SELECT 'insert_flag_reset:' || NOT cascade_ownership FROM cutting_inserts WHERE insert_id = 'c0000000-0000-4000-8000-000000000121';

-- 4. Flag alone (owner not in the UPDATE): the stored owner is propagated.
UPDATE tool_boxes SET cascade_ownership = TRUE WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111';
SELECT 'stored_owner_edges:' || count(*) FROM insert_edges WHERE edge_code LIKE 'TEST-OC-BOX-%' AND owner_person_id = 'c0000000-0000-4000-8000-000000000102';

-- 5. A NULL owner is propagated as NULL.
UPDATE tool_boxes SET owner_person_id = NULL, cascade_ownership = TRUE WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111';
SELECT 'null_owner_inserts:' || count(*) FROM cutting_inserts WHERE tool_box_id = 'c0000000-0000-4000-8000-000000000111' AND owner_person_id IS NULL;
SELECT 'null_owner_edges:' || count(*) FROM insert_edges WHERE edge_code LIKE 'TEST-OC-BOX-%' AND owner_person_id IS NULL;

-- 6. The legacy owner column is never touched by the cascade.
SELECT 'legacy_owner_untouched:' || count(*) FROM insert_edges WHERE edge_code LIKE 'TEST-OC-BOX-%' AND owner IS NULL;
ROLLBACK;
SQL
)
oc_check() { grep -qx "$1" <<<"$oc_out" && ok "$2" || bad "$2 (psql output: $oc_out)"; }
oc_check "no_flag_children_unchanged:2/4" "owner change without cascade_ownership does not touch children"
oc_check "box_cascade_inserts:2" "box cascade: every insert gets the box's owner_person_id"
oc_check "box_cascade_edges:4" "box cascade: every edge of those inserts gets it too"
oc_check "box_flag_reset:true" "box cascade: cascade_ownership is reset to false"
oc_check "insert_cascade_own_edges:2" "insert cascade: the insert's edges get its owner_person_id"
oc_check "insert_cascade_other_edges:2" "insert cascade: other inserts' edges are untouched"
oc_check "insert_flag_reset:true" "insert cascade: cascade_ownership is reset to false"
oc_check "stored_owner_edges:4" "flag alone propagates the stored owner"
oc_check "null_owner_inserts:2" "a NULL owner is propagated to inserts"
oc_check "null_owner_edges:4" "a NULL owner is propagated to edges"
oc_check "legacy_owner_untouched:4" "the legacy owner column is not written by the cascade"

echo "== Box intake runs in Postgres (review 4.7) =="
bt_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-000000000201', 'Intake Trigger Owner');
INSERT INTO insert_types (insert_type_id, type_code, short_code, inserts_per_box, edge_count)
VALUES ('c0000000-0000-4000-8000-000000000211', 'TEST-INTAKE-TRIGGER', 'TST5', 2, 2);
-- The intake form: no code (placeholder default), a quantity and an owner.
INSERT INTO tool_boxes (tool_box_id, insert_type_id, package_quantity, owner_person_id)
VALUES ('c0000000-0000-4000-8000-000000000221', 'c0000000-0000-4000-8000-000000000211', 2, 'c0000000-0000-4000-8000-000000000201');
SELECT 'boxes:' || string_agg(tool_box_code, ',' ORDER BY tool_box_code) FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'inserts:' || count(*) FROM cutting_inserts WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'edges:' || count(*) FROM insert_edges e JOIN cutting_inserts i USING (insert_id) WHERE i.insert_type_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'clone_sentinel:' || string_agg(DISTINCT package_quantity::text, ',') FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211' AND tool_box_id <> 'c0000000-0000-4000-8000-000000000221';
SELECT 'owned_edges:' || count(*) FROM insert_edges e JOIN cutting_inserts i USING (insert_id)
  WHERE i.insert_type_id = 'c0000000-0000-4000-8000-000000000211' AND e.owner_person_id = 'c0000000-0000-4000-8000-000000000201';
-- The deleted box-intake hook stays loaded until Directus restarts and calls the function again
-- after the trigger already ran: the second call (on the renamed box 1 and on a clone) is a no-op.
SELECT expand_tool_box_intake('c0000000-0000-4000-8000-000000000221');
SELECT expand_tool_box_intake(tool_box_id) FROM tool_boxes
  WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211' AND tool_box_id <> 'c0000000-0000-4000-8000-000000000221';
SELECT 'boxes_second_call:' || string_agg(tool_box_code, ',' ORDER BY tool_box_code) FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'inserts_second_call:' || count(*) FROM cutting_inserts WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'edges_second_call:' || count(*) FROM insert_edges e JOIN cutting_inserts i USING (insert_id) WHERE i.insert_type_id = 'c0000000-0000-4000-8000-000000000211';
-- Writers that must NOT trigger an expansion: explicit code, NULL quantity, zero quantity, no insert type.
INSERT INTO tool_boxes (tool_box_code, insert_type_id, package_quantity) VALUES ('TEST-INTAKE-LEGACY', 'c0000000-0000-4000-8000-000000000211', 5);
INSERT INTO tool_boxes (insert_type_id) VALUES ('c0000000-0000-4000-8000-000000000211');
INSERT INTO tool_boxes (insert_type_id, package_quantity) VALUES ('c0000000-0000-4000-8000-000000000211', 0);
INSERT INTO tool_boxes (package_quantity) VALUES (3);
SELECT 'untouched_boxes:' || count(*) FROM tool_boxes WHERE insert_type_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'legacy_code_kept:' || count(*) FROM tool_boxes WHERE tool_box_code = 'TEST-INTAKE-LEGACY' AND package_quantity = 5;
SELECT 'no_type_box:' || count(*) FROM tool_boxes WHERE insert_type_id IS NULL AND package_quantity = 3 AND tool_box_code LIKE 'TMP-%';
ROLLBACK;
SQL
)
bt_check() { grep -qx "$1" <<<"$bt_out" && ok "$2" || bad "$2 (psql output: $bt_out)"; }
bt_check "boxes:TST5-1,TST5-2" "an intake row with a quantity expands into that many boxes"
bt_check "inserts:4" "2 boxes x 2 inserts are created"
bt_check "edges:8" "4 inserts x 2 edges are created"
bt_check "clone_sentinel:0" "clone boxes carry package_quantity = 0 (no re-expansion)"
bt_check "owned_edges:8" "owner_person_id reaches every edge through the trigger path"
bt_check "boxes_second_call:TST5-1,TST5-2" "a second expand_tool_box_intake() call creates no boxes and renames nothing"
bt_check "inserts_second_call:4" "a second call creates no inserts"
bt_check "edges_second_call:8" "a second call creates no edges"
bt_check "untouched_boxes:5" "explicit code, NULL, 0 quantity and typeless boxes are not expanded"
bt_check "legacy_code_kept:1" "a box with an explicit code and a quantity (legacy import) keeps both"
bt_check "no_type_box:1" "a quantity without an insert type is left alone, no error"
# Errors reach the writer: a type with no usable short code aborts the INSERT.
bt_err=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO insert_types (insert_type_id, type_code) VALUES ('c0000000-0000-4000-8000-000000000212', '---');
INSERT INTO tool_boxes (insert_type_id, package_quantity) VALUES ('c0000000-0000-4000-8000-000000000212', 1);
ROLLBACK;
SQL
)
grep -q 'cannot derive short_code' <<<"$bt_err" && ok "an expansion error aborts the INSERT and reaches the caller" || bad "expansion error was swallowed (output: $bt_err)"

echo "== Operation numbers and codes are assigned server-side (review 4.5) =="
# The trigger fills operation_sequence (max+1 per sample) and the {seq} / {mf} placeholders of a
# client-composed pass_code. Rolled-back transaction first: the numbers a new heat-treatment,
# deformation and additive operation get, a supplied number being kept, and the sintering counter.
seq_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-000000000401', 'T-I-HT', 'stream I test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000411', 'TI-S1');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000412', 'TI-S2');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000421', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'heat_treatment', 'TI-S1-HTA{seq}-800C_60min_AC');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000422', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'deformation', 'TI-S1-DR{seq}-20C_50pct');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000423', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'additive', 'TI-S1-AM{seq}-200W');
-- a machining pass number the user typed is kept, and the next blank one continues after it
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000424', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'machining', 9, 'TI-S1-F9-20MPM');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000425', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'heat_treatment', 'TI-S1-HTS{seq}');
-- numbering is per sample, and a typed override without a placeholder is stored as given
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000426', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'heat_treatment', 'TI-S2-HTA{seq}');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000427', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'heat_treatment', 'MY-OWN-CODE');
-- no sample: the placeholder collapses to nothing and the sequence stays NULL (as before)
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000428', 'c0000000-0000-4000-8000-000000000401', 'heat_treatment', 'test', 'TI-NOSAMPLE{seq}-X');
-- an imported row (source_system set) keeps a NULL sequence even with a sample; a later explicit
-- number is kept, so the importer's own numbering cannot collide with an auto-assigned one
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000429', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'sintering', 'test', 'TI-IMP{seq}-FAST');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, source_system, operation_sequence, pass_code)
VALUES ('c0000000-0000-4000-8000-00000000042a', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'machining', 'test', 1, 'TI-IMP-F1');
SELECT 'op:' || substr(operation_id::text, 33) || ':' || COALESCE(operation_sequence::text, 'null') || ':' || pass_code
FROM manufacturing_operations WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-0000000004_%' ORDER BY operation_id;

-- sintering "MF" counter: max+1 over live codes, not count+1
SELECT COALESCE(max((substring(pass_code FROM '(?:^|-)MF(\d{1,9})(?:-|$)'))::bigint), 0) AS mfbase
FROM manufacturing_operations WHERE process_category = 'sintering' \gset
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000431', 'c0000000-0000-4000-8000-000000000401', 'sintering', 'test', '01-01-26-MF' || (:mfbase + 5) || '-950C');
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000432', 'c0000000-0000-4000-8000-000000000401', 'sintering', 'test', '02-01-26-MF{mf}-950C_11kN');
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000433', 'c0000000-0000-4000-8000-000000000401', 'sintering', 'test', '03-01-26-MF{mf}');
DELETE FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-000000000432';
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000434', 'c0000000-0000-4000-8000-000000000401', 'sintering', 'test', '04-01-26-MF{mf}');
SELECT 'mf_explicit:' || (:mfbase + 5);
SELECT 'mf:' || substr(operation_id::text, 33) || ':' || pass_code FROM manufacturing_operations
WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-00000000043_' ORDER BY operation_id;
-- regenerating the code of an existing operation must not store a raw placeholder
UPDATE manufacturing_operations SET pass_code = 'TI-S1-HTA{seq}-regen' WHERE operation_id = 'c0000000-0000-4000-8000-000000000421';
SELECT 'regen:' || pass_code || ':' || operation_sequence FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-000000000421';
ROLLBACK;
SQL
)
seq_check() { grep -qx "$1" <<<"$seq_out" && ok "$2" || bad "$2 (psql output: $seq_out)"; }
seq_check "op:0421:1:TI-S1-HTA1-800C_60min_AC" "a new heat-treatment op gets sequence 1 and a code that carries it"
seq_check "op:0422:2:TI-S1-DR2-20C_50pct" "a new deformation op gets the next number, in its code too"
seq_check "op:0423:3:TI-S1-AM3-200W" "a new additive op gets the next number, in its code too"
seq_check "op:0424:9:TI-S1-F9-20MPM" "a supplied (machining pass) number is kept"
seq_check "op:0425:10:TI-S1-HTS10" "the next blank number continues after the highest one"
seq_check "op:0426:1:TI-S2-HTA1" "numbering restarts per sample"
seq_check "op:0427:2:MY-OWN-CODE" "a typed code without a placeholder is stored unchanged"
seq_check "op:0428:null:TI-NOSAMPLE-X" "an operation without a sample keeps a NULL sequence and an empty placeholder"
mf_exp=$(grep -m1 '^mf_explicit:' <<<"$seq_out" | cut -d: -f2)
seq_check "op:0429:null:TI-IMP-FAST" "an imported row (source_system set) is not auto-numbered, even with a sample"
seq_check "op:042a:1:TI-IMP-F1" "an imported row's explicit number is kept"
seq_check "mf:0431:01-01-26-MF${mf_exp}-950C" "an explicit MF number is stored as given"
seq_check "mf:0433:03-01-26-MF$((mf_exp + 2))" "the sintering MF counter is max+1 over existing codes"
seq_check "mf:0434:04-01-26-MF$((mf_exp + 3))" "an MF number is not handed out again after a delete"
seq_check "regen:TI-S1-HTA1-regen:1" "regenerating an existing code fills the placeholder from the stored sequence"

# Two writers at once: session A inserts and holds its transaction open, session B inserts for the
# same sample meanwhile. Without the advisory lock both read max = 0 and get 1.
cc_dir=$(mktemp -d)
$PSQL -q -c "
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-000000000402', 'T-I-CC', 'stream I concurrency method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000413', 'TI-CC1');" >/dev/null 2>&1
cc_insert() {  # cc_insert <op-id-suffix> <code> <hold-seconds>
    $PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000004$1', 'c0000000-0000-4000-8000-000000000402',
        'c0000000-0000-4000-8000-000000000413', 'heat_treatment', '$2')
RETURNING operation_sequence || '|' || pass_code;
SELECT pg_sleep($3);
COMMIT;
SQL
}
cc_insert 51 'TI-CC1-HTA{seq}' 2 | grep '|' > "$cc_dir/a" &
sleep 0.7
cc_insert 52 'TI-CC1-HTA{seq}' 0 | grep '|' > "$cc_dir/b"
wait
cc_a=$(cat "$cc_dir/a"); cc_b=$(cat "$cc_dir/b")
[[ "$cc_a" == "1|TI-CC1-HTA1" && "$cc_b" == "2|TI-CC1-HTA2" ]] \
    && ok "concurrent inserts for one sample get distinct sequences and codes ($cc_a, $cc_b)" \
    || bad "concurrent inserts collided (A='$cc_a', B='$cc_b')"

# Same for the global sintering counter.
cc_mf() {  # cc_mf <op-id-suffix> <hold-seconds>
    $PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000004$1', 'c0000000-0000-4000-8000-000000000402', 'sintering', 'test', '05-01-26-MF{mf}')
RETURNING pass_code;
SELECT pg_sleep($2);
COMMIT;
SQL
}
cc_mf 53 2 | grep MF > "$cc_dir/a" &
sleep 0.7
cc_mf 54 0 | grep MF > "$cc_dir/b"
wait
cc_a=$(cat "$cc_dir/a"); cc_b=$(cat "$cc_dir/b")
[[ -n "$cc_a" && -n "$cc_b" && "$cc_a" != "$cc_b" ]] \
    && ok "concurrent sintering inserts get distinct MF numbers ($cc_a, $cc_b)" \
    || bad "concurrent sintering inserts collided (A='$cc_a', B='$cc_b')"

# Bulk load: the per-sample lock must not use the shared lock table (advisory locks do, and
# ~13,000 samples in one transaction ran out of it). 400 samples, one operation each, one
# transaction: no per-sample advisory lock is held at the end, and each sample's number is 1.
bulk_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code)
SELECT ('c0000000-0000-4000-8001-' || lpad(g::text, 12, '0'))::uuid, 'TI-BULK-' || g FROM generate_series(1, 400) g;
INSERT INTO manufacturing_operations (method_id, sample_id, process_category, pass_code)
SELECT 'c0000000-0000-4000-8000-000000000402', sample_id, 'heat_treatment', 'TI-BULK-HTA{seq}'
FROM physical_samples WHERE sample_code LIKE 'TI-BULK-%';
SELECT 'bulk_ops:' || count(*) || ':' || min(operation_sequence) || ':' || max(operation_sequence)
FROM manufacturing_operations WHERE pass_code = 'TI-BULK-HTA1';
SELECT 'bulk_advisory_locks:' || (count(*) <= 3) FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory';
ROLLBACK;
SQL
)
grep -qx "bulk_ops:400:1:1" <<<"$bulk_out" && grep -qx "bulk_advisory_locks:true" <<<"$bulk_out" \
    && ok "400 samples' operations in one transaction: numbered 1, no per-sample advisory locks" \
    || bad "bulk operation insert (psql output: $bulk_out)"

# Lock order (rollup -> sample -> MF/code): A writes an operation for sample X, holds its
# transaction open, then writes one for sample Y; B meanwhile writes one for Y. With the rollup lock
# taken after the sample lock, B holds Y and waits for the rollup lock that A holds while A waits
# for Y: "deadlock detected".
$PSQL -q -c "
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('c0000000-0000-4000-8000-000000000414', 'TI-DLX'), ('c0000000-0000-4000-8000-000000000415', 'TI-DLY');" >/dev/null 2>&1
dl_a() {
    $PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000461', 'c0000000-0000-4000-8000-000000000402',
        'c0000000-0000-4000-8000-000000000414', 'heat_treatment', 'TI-DLX-HTA{seq}');
SELECT pg_sleep(2);
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000462', 'c0000000-0000-4000-8000-000000000402',
        'c0000000-0000-4000-8000-000000000415', 'heat_treatment', 'TI-DLY-HTA{seq}');
COMMIT;
SQL
}
dl_b() {
    $PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000463', 'c0000000-0000-4000-8000-000000000402',
        'c0000000-0000-4000-8000-000000000415', 'heat_treatment', 'TI-DLY-HTA{seq}');
COMMIT;
SQL
}
dl_a > "$cc_dir/dla" &
sleep 0.7
dl_b > "$cc_dir/dlb"
wait
dl_n=$($PSQL -c "SELECT count(*) FROM manufacturing_operations WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-00000000046_'" 2>&1)
if ! grep -qi 'deadlock\|ERROR' "$cc_dir/dla" "$cc_dir/dlb" && [[ "$dl_n" == "3" ]]; then
    ok "operation writes for samples X,Y and Y do not deadlock (rollup lock is taken first)"
else
    bad "operation writes deadlocked or failed (A: $(cat "$cc_dir/dla"); B: $(cat "$cc_dir/dlb"); rows: $dl_n)"
fi

rm -rf "$cc_dir"
$PSQL -q -c "
DELETE FROM manufacturing_operations WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-0000000004_%';
DELETE FROM physical_samples WHERE sample_id IN ('c0000000-0000-4000-8000-000000000413',
    'c0000000-0000-4000-8000-000000000414', 'c0000000-0000-4000-8000-000000000415');
DELETE FROM manufacturing_methods WHERE method_id = 'c0000000-0000-4000-8000-000000000402';" >/dev/null 2>&1 || true

echo "== Sample numbers are assigned server-side (review 4.6) =="
# A code written as {seq}-<rest> gets the next free number from the trigger; any other code is stored as given.
sc_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
SELECT COALESCE(max((substring(sample_code FROM '^(\d{1,9})-'))::bigint), 0) AS sbase FROM physical_samples \gset
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-000000000611', '{seq}-TI-MF-2026-10-4');
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-000000000612', '{seq}-TI-HT-2026-10-4');
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-000000000613', 'TI-HAND-TYPED');
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-000000000614', (:sbase + 500)::text || '-TI-OLD-2020-1-1');
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-000000000615', '{seq}-TI-MF-2026-10-5');
SELECT 'base:' || :sbase;
SELECT 'code:' || substr(sample_id::text, 33) || ':' || sample_code FROM physical_samples
WHERE sample_id::text LIKE 'c0000000-0000-4000-8000-00000000061_' ORDER BY sample_id;
-- "renumber": the row's own number is excluded, so it keeps the top slot rather than jumping past itself
UPDATE physical_samples SET sample_code = '{seq}-TI-MF-2026-10-5' WHERE sample_id = 'c0000000-0000-4000-8000-000000000615';
SELECT 'renumber:' || sample_code FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-000000000615';
-- an unrelated update leaves the code alone
UPDATE physical_samples SET nickname = 'x' WHERE sample_id = 'c0000000-0000-4000-8000-000000000611';
SELECT 'untouched:' || sample_code FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-000000000611';
-- the preview function (d1-next-number endpoint) follows the same rule as the trigger
SELECT 'preview:' || next_sample_code_number();
SELECT 'preview_excl:' || next_sample_code_number('c0000000-0000-4000-8000-000000000615');
ROLLBACK;
SQL
)
sc_check() { grep -qx "$1" <<<"$sc_out" && ok "$2" || bad "$2 (psql output: $sc_out)"; }
sc_base=$(grep -m1 '^base:' <<<"$sc_out" | cut -d: -f2)
sc_check "code:0611:$((sc_base + 1))-TI-MF-2026-10-4" "a {seq}- sample code gets max+1 and keeps the rest of the code"
sc_check "code:0612:$((sc_base + 2))-TI-HT-2026-10-4" "the next one gets the next number"
sc_check "code:0613:TI-HAND-TYPED" "a hand-typed code without the placeholder is stored as given"
sc_check "code:0614:$((sc_base + 500))-TI-OLD-2020-1-1" "an explicit number is stored as given"
sc_check "code:0615:$((sc_base + 501))-TI-MF-2026-10-5" "a later placeholder continues after the highest number in use"
sc_check "renumber:$((sc_base + 501))-TI-MF-2026-10-5" "renumbering excludes the row's own number"
sc_check "untouched:$((sc_base + 1))-TI-MF-2026-10-4" "an unrelated update does not renumber"
sc_check "preview:$((sc_base + 502))" "next_sample_code_number() previews max+1 over every sample"
sc_check "preview_excl:$((sc_base + 501))" "next_sample_code_number(id) ignores that sample's own number"

# Deploy-order guard: a placeholder that survives the trigger is rejected (NOT VALID checks).
ph_s=$($PSQL -q 2>&1 -c "INSERT INTO physical_samples (sample_code) VALUES ('TI-{seq}-MIDDLE')")
grep -q 'physical_samples_sample_code_no_placeholder_check' <<<"$ph_s" \
    && ok "a literal {seq} that the trigger does not replace is rejected" \
    || bad "literal {seq} sample code was not rejected (psql output: $ph_s)"
# With the trigger bypassed (as when the interface runs before the migration did) a literal
# placeholder hits the CHECK; one implicit transaction per -c, so nothing is left behind.
ph_o=$($PSQL -q 2>&1 -c "SET LOCAL session_replication_role = replica;
INSERT INTO manufacturing_operations (method_id, process_category, source_system, pass_code)
VALUES ((SELECT method_id FROM manufacturing_methods LIMIT 1), 'sintering', 'test', '05-01-26-MF{mf}')")
grep -q 'manufacturing_operations_pass_code_no_placeholder_check' <<<"$ph_o" \
    && ok "a literal {mf} / {seq} in pass_code is rejected when the trigger did not run" \
    || bad "literal {mf} pass_code was not rejected (psql output: $ph_o)"
ph_chk=$($PSQL -c "SELECT convalidated FROM pg_constraint WHERE conname IN ('physical_samples_sample_code_no_placeholder_check', 'manufacturing_operations_pass_code_no_placeholder_check')" | sort -u)
[[ "$ph_chk" == "f" ]] && ok "both placeholder checks are NOT VALID (existing rows are not scanned)" \
    || bad "placeholder check validity (got '$ph_chk')"

# Two registrations at once: A holds its transaction open while B inserts.
sc_dir=$(mktemp -d)
sc_insert() {  # sc_insert <id-suffix> <hold-seconds>
    $PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-0000000006$1', '{seq}-TI-CC-2026-10-4') RETURNING sample_code;
SELECT pg_sleep($2);
COMMIT;
SQL
}
sc_insert 21 2 | grep TI-CC > "$sc_dir/a" &
sleep 0.7
sc_insert 22 0 | grep TI-CC > "$sc_dir/b"
wait
sc_a=$(cat "$sc_dir/a"); sc_b=$(cat "$sc_dir/b")
sc_na=${sc_a%%-*}; sc_nb=${sc_b%%-*}
[[ -n "$sc_na" && "$sc_nb" == "$((sc_na + 1))" ]] \
    && ok "concurrent registrations get distinct, consecutive sample numbers ($sc_a, $sc_b)" \
    || bad "concurrent registrations collided (A='$sc_a', B='$sc_b')"
rm -rf "$sc_dir"
$PSQL -q -c "DELETE FROM physical_samples WHERE sample_id::text LIKE 'c0000000-0000-4000-8000-0000000006__';" >/dev/null 2>&1 || true

echo "== Audit actor fallback from directus_activity (review 4.9) =="
# The actor-identity hook's set_config may not reach the write's transaction for PATCH/DELETE (see
# migration 20261003000128). Directus then still writes a directus_activity row in that transaction;
# the trigger on it attributes the audit rows. directus_activity is not a CI stub, so the test
# creates a minimal one inside the rolled-back transaction and installs the trigger with the
# migration's own DO block.
act_do=$(sed -n '/^-- migrate:up/,/^-- migrate:down/p' db/migrations/20261003000128_audit_actor_from_directus_activity.sql \
    | awk '/^DO \$\$/{f=1} f{print} f && /^\$\$;/{exit}')
[[ -n "$act_do" ]] && ok "found the migration's trigger-install block" || bad "could not extract the trigger-install block"
act_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
CREATE TABLE IF NOT EXISTS directus_activity (
    id serial PRIMARY KEY, action varchar(45), "user" uuid, collection varchar(64), item varchar(255),
    "timestamp" timestamptz DEFAULT now());
DROP TRIGGER IF EXISTS audit_actor_from_activity ON directus_activity;
$act_do
SELECT 'trigger:' || count(*) FROM pg_trigger WHERE tgname = 'audit_actor_from_activity' AND NOT tgisinternal;
-- 1. API-style write: no GUC (the hook could not reach this transaction), then Directus' activity rows
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000711', 'TI-ACT-1');
INSERT INTO directus_activity (action, "user", collection, item)
VALUES ('create', 'c0000000-0000-4000-8000-000000000799', 'physical_samples', 'c0000000-0000-4000-8000-000000000711');
UPDATE physical_samples SET nickname = 'renamed' WHERE sample_id = 'c0000000-0000-4000-8000-000000000711';
INSERT INTO directus_activity (action, "user", collection, item)
VALUES ('update', 'c0000000-0000-4000-8000-000000000799', 'physical_samples', 'c0000000-0000-4000-8000-000000000711');
SELECT 'raw_actor_null:' || count(*) FROM audit_logs
  WHERE record_id = 'c0000000-0000-4000-8000-000000000711' AND actor_identity IS NULL;
SELECT 'attributed:' || string_agg(action_type || '=' || actor_identity || '/' || actor_from_directus_activity, ',' ORDER BY log_id)
  FROM v_audit_logs_with_actor WHERE record_id = 'c0000000-0000-4000-8000-000000000711';
SELECT 'actor_rows:' || count(*) FROM audit_log_actors a JOIN audit_logs l USING (log_id)
  WHERE l.record_id = 'c0000000-0000-4000-8000-000000000711';
-- 2. an unauthenticated write is recorded as 'public'
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000712', 'TI-ACT-2');
INSERT INTO directus_activity (action, "user", collection, item)
VALUES ('create', NULL, 'physical_samples', 'c0000000-0000-4000-8000-000000000712');
SELECT 'public:' || actor_identity FROM v_audit_logs_with_actor WHERE record_id = 'c0000000-0000-4000-8000-000000000712';
-- 3. an audit row from an earlier transaction is never re-attributed
INSERT INTO audit_logs (table_name, record_id, action_type, event_timestamp)
VALUES ('physical_samples', 'TI-ACT-OLD', 'UPDATE', now() - interval '1 hour');
INSERT INTO directus_activity (action, "user", collection, item)
VALUES ('update', 'c0000000-0000-4000-8000-000000000799', 'physical_samples', 'TI-ACT-OLD');
SELECT 'old_rows:' || count(*) FROM audit_log_actors a JOIN audit_logs l USING (log_id) WHERE l.record_id = 'TI-ACT-OLD';
-- 4. rows written by OTHER triggers in the same transaction have no activity row of their own:
-- the intake creates a second box, inserts and edges (audited, no actor), Directus only logs the
-- box it was asked to create
INSERT INTO insert_types (insert_type_id, type_code, short_code, inserts_per_box, edge_count)
VALUES ('c0000000-0000-4000-8000-000000000721', 'TEST-ACT-TYPE', 'TACT', 2, 2);
INSERT INTO tool_boxes (tool_box_id, insert_type_id, package_quantity)
VALUES ('c0000000-0000-4000-8000-000000000722', 'c0000000-0000-4000-8000-000000000721', 2);
INSERT INTO directus_activity (action, "user", collection, item)
VALUES ('create', 'c0000000-0000-4000-8000-000000000799', 'tool_boxes', 'c0000000-0000-4000-8000-000000000722');
SELECT 'child_edges:' || count(*) || '/' || count(*) FILTER (WHERE actor_identity = 'c0000000-0000-4000-8000-000000000799' AND actor_from_directus_activity)
  FROM v_audit_logs_with_actor WHERE table_name = 'insert_edges' AND event_timestamp = transaction_timestamp();
SELECT 'child_boxes:' || count(*) || '/' || count(*) FILTER (WHERE actor_identity = 'c0000000-0000-4000-8000-000000000799')
  FROM v_audit_logs_with_actor WHERE table_name = 'tool_boxes' AND record_id <> 'c0000000-0000-4000-8000-000000000722'
   AND event_timestamp = transaction_timestamp();
SELECT 'child_unattributed:' || count(*) FROM v_audit_logs_with_actor
  WHERE event_timestamp = transaction_timestamp() AND table_name IN ('insert_edges', 'cutting_inserts') AND actor_identity IS NULL;
-- 5. a GUC-supplied actor wins and is not duplicated in the side table
SELECT set_config('d1.actor_identity', 'guc-user', true) \gset
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000713', 'TI-ACT-3');
INSERT INTO directus_activity (action, "user", collection, item)
VALUES ('create', 'c0000000-0000-4000-8000-000000000799', 'physical_samples', 'c0000000-0000-4000-8000-000000000713');
SELECT 'guc:' || actor_identity || '/' || actor_from_directus_activity FROM v_audit_logs_with_actor WHERE record_id = 'c0000000-0000-4000-8000-000000000713';
SELECT 'guc_rows:' || count(*) FROM audit_log_actors a JOIN audit_logs l USING (log_id) WHERE l.record_id = 'c0000000-0000-4000-8000-000000000713';
ROLLBACK;
SQL
)
act_check() { grep -qx "$1" <<<"$act_out" && ok "$2" || bad "$2 (psql output: $act_out)"; }
act_check "trigger:1" "the migration's block installs the directus_activity trigger"
act_check "raw_actor_null:2" "setup: the audit rows carried no actor (the hook could not reach the transaction)"
act_check "attributed:INSERT=c0000000-0000-4000-8000-000000000799/true,UPDATE=c0000000-0000-4000-8000-000000000799/true" "INSERT and UPDATE audit rows are attributed to the Directus user"
act_check "actor_rows:2" "one side-table row per attributed audit row, no duplicates"
act_check "public:public" "an unauthenticated write is attributed to 'public'"
act_check "old_rows:0" "an audit row from an earlier transaction is not re-attributed"
act_check "guc:guc-user/false" "an actor set through the GUC wins over the fallback"
act_check "child_edges:8/8" "audit rows of the intake's child edges (written by a trigger) are attributed too"
act_check "child_boxes:1/1" "so are the clone box rows the intake trigger created"
act_check "child_unattributed:0" "no audit row of the transaction is left without an actor"
act_check "guc_rows:0" "a GUC-attributed row gets no side-table row"

# The migration's down section refuses to drop a populated audit_log_actors unless the loss is accepted.
act_down=$(sed -n '/^-- migrate:down/,$p' db/migrations/20261003000128_audit_actor_from_directus_activity.sql)
act_down_run() {  # act_down_run <setup SQL>
    $PSQL -q 2>&1 <<SQL
BEGIN;
$1
$act_down
SELECT 'dropped:' || (to_regclass('public.audit_log_actors') IS NULL);
ROLLBACK;
SQL
}
act_d1=$(act_down_run "INSERT INTO audit_log_actors (log_id, actor_identity) VALUES (-1, 'x');")
grep -q 'audit_log_actors holds 1 row' <<<"$act_d1" && ! grep -q 'dropped:true' <<<"$act_d1" \
    && ok "down refuses to drop audit_log_actors while it has rows" \
    || bad "down did not refuse a populated audit_log_actors (psql output: $act_d1)"
act_d2=$(act_down_run "INSERT INTO audit_log_actors (log_id, actor_identity) VALUES (-1, 'x'); SET LOCAL d1.allow_audit_actor_loss = 'on';")
grep -qx 'dropped:true' <<<"$act_d2" \
    && ok "down drops a populated audit_log_actors when d1.allow_audit_actor_loss is on" \
    || bad "down ignored the override (psql output: $act_d2)"
act_d3=$(act_down_run "DELETE FROM audit_log_actors;")
grep -qx 'dropped:true' <<<"$act_d3" \
    && ok "down drops an empty audit_log_actors with no override (CI's purged rollback)" \
    || bad "down failed on an empty audit_log_actors (psql output: $act_d3)"

echo "== Process category comes from the method, in Postgres (review 4.11) =="
pc_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category) VALUES
  ('c0000000-0000-4000-8000-000000000801', 'T-I-PH', 'pc heat method', 'heat_treatment'),
  ('c0000000-0000-4000-8000-000000000802', 'T-I-PS', 'pc sinter method', 'sintering');
INSERT INTO manufacturing_methods (method_id, method_code, method_name) VALUES
  ('c0000000-0000-4000-8000-000000000803', 'T-I-PU', 'pc unmapped method'),
  ('c0000000-0000-4000-8000-000000000804', 'T-I-PV', 'pc unmapped method 2');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000811', 'TI-PC');
-- derived on insert when blank; an explicit value wins
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id) VALUES
  ('c0000000-0000-4000-8000-000000000821', 'c0000000-0000-4000-8000-000000000801', 'c0000000-0000-4000-8000-000000000811');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category) VALUES
  ('c0000000-0000-4000-8000-000000000822', 'c0000000-0000-4000-8000-000000000801', 'c0000000-0000-4000-8000-000000000811', 'deformation');
-- an unmapped method never blanks or invents a category
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category) VALUES
  ('c0000000-0000-4000-8000-000000000823', 'c0000000-0000-4000-8000-000000000803', 'c0000000-0000-4000-8000-000000000811', 'machining');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id) VALUES
  ('c0000000-0000-4000-8000-000000000824', 'c0000000-0000-4000-8000-000000000803', 'c0000000-0000-4000-8000-000000000811');
UPDATE manufacturing_operations SET method_id = 'c0000000-0000-4000-8000-000000000804'
  WHERE operation_id = 'c0000000-0000-4000-8000-000000000823';
-- changing to a mapped method re-derives; setting the category in the same statement wins
UPDATE manufacturing_operations SET method_id = 'c0000000-0000-4000-8000-000000000802'
  WHERE operation_id = 'c0000000-0000-4000-8000-000000000821';
SELECT 'rederived:' || process_category FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-000000000821';
UPDATE manufacturing_operations SET method_id = 'c0000000-0000-4000-8000-000000000802', process_category = 'additive'
  WHERE operation_id = 'c0000000-0000-4000-8000-000000000822';
-- an update that does not touch the method leaves the category alone, even if the method is mapped
UPDATE manufacturing_operations SET process_category = 'machining' WHERE operation_id = 'c0000000-0000-4000-8000-000000000821';
UPDATE manufacturing_operations SET outcome_notes = 'x' WHERE operation_id = 'c0000000-0000-4000-8000-000000000821';
SELECT 'cat:' || substr(operation_id::text, 33) || ':' || COALESCE(process_category, 'null')
FROM manufacturing_operations WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-00000000082_' ORDER BY operation_id;
SELECT 'seed_MP:' || COALESCE(process_category, 'null') FROM manufacturing_methods WHERE method_code = 'MP';
SELECT 'seed_HT:' || COALESCE(process_category, 'null') FROM manufacturing_methods WHERE method_code = 'HT';
ROLLBACK;
SQL
)
pc_check() { grep -qx "$1" <<<"$pc_out" && ok "$2" || bad "$2 (psql output: $pc_out)"; }
pc_check "rederived:sintering" "changing the method re-derives the category (heat_treatment -> sintering)"
pc_check "cat:0821:machining" "a later edit of the category (method unchanged) is not overwritten"
pc_check "cat:0822:additive" "a category set in the same statement as a method change wins"
pc_check "cat:0823:machining" "an unmapped method never blanks a stored category"
pc_check "cat:0824:null" "an unmapped method on a blank category stays blank (nothing invented)"
pc_check "seed_MP:sample_prep" "the method map covers MP (sample preparation), which the old SQL map missed"
pc_check "seed_HT:heat_treatment" "the method map covers HT"
# insert-time derivation on its own (separate transaction so the later UPDATEs above cannot mask it)
pc2_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category)
VALUES ('c0000000-0000-4000-8000-000000000805', 'T-I-PW', 'pc method', 'additive');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000812', 'TI-PC2');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id)
VALUES ('c0000000-0000-4000-8000-000000000825', 'c0000000-0000-4000-8000-000000000805', 'c0000000-0000-4000-8000-000000000812');
SELECT 'inserted:' || process_category FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-000000000825';
ROLLBACK;
SQL
)
grep -qx "inserted:additive" <<<"$pc2_out" && ok "a new operation with no category gets its method's category on insert" || bad "insert-time derivation failed (output: $pc2_out)"

echo "== Prep recipes are applied in Postgres (review 4.12) =="
pr_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO prep_recipes (recipe_id, name) VALUES
  ('c0000000-0000-4000-8000-000000000901', 'TI recipe A'),
  ('c0000000-0000-4000-8000-000000000902', 'TI recipe B'),
  ('c0000000-0000-4000-8000-000000000903', 'TI recipe empty');
INSERT INTO prep_recipe_steps (recipe_id, step_order, step_type, grit, duration_s) VALUES
  ('c0000000-0000-4000-8000-000000000901', 2, 'polishing', NULL, 120),
  ('c0000000-0000-4000-8000-000000000901', 1, 'grinding', 'P1200', 60),
  ('c0000000-0000-4000-8000-000000000902', 1, 'etching', NULL, 10);
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000911', 'TI-PR');
-- MP is the Sample Preparation method: its operations derive process_category = sample_prep
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, source_recipe_id)
SELECT 'c0000000-0000-4000-8000-000000000921', method_id, 'c0000000-0000-4000-8000-000000000911', 'c0000000-0000-4000-8000-000000000901'
FROM manufacturing_methods WHERE method_code = 'MP';
SELECT 'steps:' || string_agg(step_order || ':' || step_type || ':' || COALESCE(grit, '-'), ',' ORDER BY step_order)
FROM prep_steps WHERE operation_id = 'c0000000-0000-4000-8000-000000000921';
-- an operation that already has steps is not clobbered by a different recipe
UPDATE manufacturing_operations SET source_recipe_id = 'c0000000-0000-4000-8000-000000000902'
WHERE operation_id = 'c0000000-0000-4000-8000-000000000921';
SELECT 'steps_after_switch:' || count(*) FROM prep_steps WHERE operation_id = 'c0000000-0000-4000-8000-000000000921';
-- an empty recipe copies nothing and is not an error
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, source_recipe_id)
SELECT 'c0000000-0000-4000-8000-000000000922', method_id, 'c0000000-0000-4000-8000-000000000911', 'c0000000-0000-4000-8000-000000000903'
FROM manufacturing_methods WHERE method_code = 'MP';
SELECT 'empty_recipe_steps:' || count(*) FROM prep_steps WHERE operation_id = 'c0000000-0000-4000-8000-000000000922';
-- setting a recipe on an existing prep operation without steps applies it
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id)
SELECT 'c0000000-0000-4000-8000-000000000923', method_id, 'c0000000-0000-4000-8000-000000000911'
FROM manufacturing_methods WHERE method_code = 'MP';
UPDATE manufacturing_operations SET source_recipe_id = 'c0000000-0000-4000-8000-000000000902'
WHERE operation_id = 'c0000000-0000-4000-8000-000000000923';
SELECT 'late_apply_steps:' || count(*) FROM prep_steps WHERE operation_id = 'c0000000-0000-4000-8000-000000000923';
ROLLBACK;
SQL
)
pr_check() { grep -qx "$1" <<<"$pr_out" && ok "$2" || bad "$2 (psql output: $pr_out)"; }
pr_check "steps:1:grinding:P1200,2:polishing:-" "a prep operation created with a recipe gets its steps, in order"
pr_check "steps_after_switch:2" "existing steps are never clobbered by another recipe"
pr_check "empty_recipe_steps:0" "an empty recipe copies nothing"
pr_check "late_apply_steps:1" "setting a recipe on an existing prep operation without steps applies it"
# A recipe on anything but a Sample Preparation operation is rejected and the write is rolled back.
pr_err=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO prep_recipes (recipe_id, name) VALUES ('c0000000-0000-4000-8000-000000000904', 'TI recipe C');
INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category)
VALUES ('c0000000-0000-4000-8000-000000000905', 'T-I-PR', 'not a prep method', 'heat_treatment');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000912', 'TI-PR2');
INSERT INTO manufacturing_operations (method_id, sample_id, source_recipe_id)
VALUES ('c0000000-0000-4000-8000-000000000905', 'c0000000-0000-4000-8000-000000000912', 'c0000000-0000-4000-8000-000000000904');
ROLLBACK;
SQL
)
grep -q 'only be set on a Sample Preparation operation' <<<"$pr_err" && ok "a recipe on a non-prep operation is rejected with a clear error" || bad "non-prep recipe was not rejected (output: $pr_err)"

echo "== Module bar: Home first, Data Studio after the dashboards =="
# directus_settings is a stub in CI: seed the shipped bar, apply the migration's up then down in a
# rolled-back transaction, and assert the order after each, plus the cases the shipped bar does not
# cover (a curated bar that already lists home, no dashboards, a NULL bar).
MB=db/migrations/20261007000138_module_bar_home_first.sql
mb_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MB")
mb_down=$(awk '/-- migrate:down/{f=1;next}f' "$MB")
mb_ids='SELECT string_agg(e->>'"'"'id'"'"', '"'"','"'"') FROM directus_settings, json_array_elements(module_bar) e'
mb_shipped='[{"type":"module","id":"content","enabled":true},{"type":"module","id":"users","enabled":true},{"type":"module","id":"files","enabled":true},{"type":"module","id":"insights","enabled":true},{"type":"module","id":"d1-lab-dashboard","enabled":true},{"type":"module","id":"d1-force-dashboard","enabled":true},{"type":"module","id":"d1-fast-dashboard","enabled":true},{"type":"module","id":"settings","enabled":true}]'
mb_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_settings;
INSERT INTO directus_settings (id, module_bar) VALUES (1, '$mb_shipped');
$mb_up
SELECT 'up:' || ($mb_ids);
$mb_up
SELECT 'up_again:' || ($mb_ids);
$mb_down
SELECT 'down:' || ($mb_ids);
SELECT 'down_exact:' || (module_bar::jsonb = '$mb_shipped'::jsonb) FROM directus_settings;
UPDATE directus_settings SET module_bar = '[{"type":"module","id":"users","enabled":true},{"type":"module","id":"home","enabled":false},{"type":"module","id":"d1-force-dashboard","enabled":true},{"type":"module","id":"settings","enabled":true}]';
$mb_up
SELECT 'curated:' || string_agg((e->>'id') || '=' || (e->>'enabled'), ',') FROM directus_settings, json_array_elements(module_bar) e;
UPDATE directus_settings SET module_bar = '[{"type":"module","enabled":true},{"type":"module","id":"home","enabled":false},{"type":"module","id":"users","enabled":true},{"type":"module","id":"home","enabled":true}]';
$mb_up
SELECT 'idless_dup_home:' || string_agg(COALESCE(e->>'id', '?') || '=' || (e->>'enabled'), ',') FROM directus_settings, json_array_elements(module_bar) e;
UPDATE directus_settings SET module_bar = '[{"type":"module","id":"users","enabled":true},{"type":"module","id":"content","enabled":true}]';
$mb_up
SELECT 'no_dashboards:' || ($mb_ids);
UPDATE directus_settings SET module_bar = NULL;
$mb_up
$mb_down
SELECT 'null_kept:' || (module_bar IS NULL) FROM directus_settings;
ROLLBACK;
SQL
)
mb_check() { grep -qx "$1" <<<"$mb_out" && ok "$2" || bad "$2 (psql output: $mb_out)"; }
mb_check "up:home,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,content,settings" "up: Home first, Data Studio right after the dashboards"
mb_check "up_again:home,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,content,settings" "up: running it twice changes nothing"
mb_check "down:content,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,settings" "down: Home removed, Data Studio back at the front"
mb_check "down_exact:true" "down: the shipped bar is restored exactly"
mb_check "curated:home=false,users=true,d1-force-dashboard=true,settings=true" "up: an existing Home entry moves first and keeps its enabled flag; content is not added"
mb_check "idless_dup_home:home=false,?=true,users=true" "up: an entry with no id is kept, and a duplicate home entry is dropped (the first one wins)"
mb_check "no_dashboards:home,users,content" "up: without dashboards the Data Studio keeps its place"
mb_check "null_kept:true" "a NULL module bar is left alone"

echo "== Test subject junction keeps test_sessions.sample_id / insert_edge_id in step =="
# Form-created tests only write test_sessions_subject; the trigger derives the primary subject.
# Explicit junction ids pin "lowest id wins". Everything is rolled back.
ps_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('c0000000-0000-4000-8000-0000000001a1', 'TEST-PS-001'),
    ('c0000000-0000-4000-8000-0000000001a2', 'TEST-PS-002');
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-0000000001b0', 'Primary Subject Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('c0000000-0000-4000-8000-0000000001b1', 'TEST-PS-BOX', 'c0000000-0000-4000-8000-0000000001b0');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('c0000000-0000-4000-8000-0000000001b2', 'TEST-PS-BOX-1', 'c0000000-0000-4000-8000-0000000001b1');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier)
VALUES ('c0000000-0000-4000-8000-0000000001b3', 'TEST-PS-BOX-1A', 'c0000000-0000-4000-8000-0000000001b2', 'A');
INSERT INTO test_sessions (session_id) VALUES
    ('c0000000-0000-4000-8000-0000000001c1'), ('c0000000-0000-4000-8000-0000000001c2'),
    ('c0000000-0000-4000-8000-0000000001c3');

-- insert: the first sample subject becomes sample_id
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-0000000001c1', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a1');
SELECT 'insert:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a1') || '/' || (insert_edge_id IS NULL) || '/v' || version
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c1';

-- a second sample with a higher id changes nothing and does not touch the test (no version bump)
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-0000000001c1', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2');
SELECT 'second:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a1') || '/v' || version
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c1';

-- a second sample with a LOWER id takes over
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000001c2', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-0000000001c2', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a1');
SELECT 'lowest_id:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c2';

-- delete the primary: the next subject is promoted
DELETE FROM test_sessions_subject WHERE id = '00000000-0000-4000-8000-000000000002';
SELECT 'delete_primary:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c1';
-- delete the last subject: sample_id becomes NULL
DELETE FROM test_sessions_subject WHERE id = '00000000-0000-4000-8000-000000000003';
SELECT 'delete_last:' || (sample_id IS NULL)
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c1';

-- insert-edge subject fills insert_edge_id and leaves sample_id alone
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-0000000001c2', 'insert_edges', 'c0000000-0000-4000-8000-0000000001b3');
SELECT 'edge:' || (insert_edge_id = 'c0000000-0000-4000-8000-0000000001b3') || '/' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c2';

-- non-uuid item, unknown sample and unknown collection are ignored, with no error
INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES
    ('c0000000-0000-4000-8000-0000000001c3', 'physical_samples', 'not-a-uuid'),
    ('c0000000-0000-4000-8000-0000000001c3', 'physical_samples', 'c0000000-0000-4000-8000-0000000001ff'),
    ('c0000000-0000-4000-8000-0000000001c3', 'tools', 'c0000000-0000-4000-8000-0000000001a1'),
    ('c0000000-0000-4000-8000-0000000001c3', 'insert_edges', 'nope');
SELECT 'junk:' || (sample_id IS NULL) || '/' || (insert_edge_id IS NULL)
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c3';
-- a valid sample after the junk wins
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-0000000001c3', 'physical_samples', 'C0000000-0000-4000-8000-0000000001A1');
SELECT 'after_junk:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a1')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c3';

-- moving a junction row to another test recomputes both the old and the new parent
UPDATE test_sessions_subject SET test_sessions_id = 'c0000000-0000-4000-8000-0000000001c1'
  WHERE test_sessions_id = 'c0000000-0000-4000-8000-0000000001c3' AND item = 'C0000000-0000-4000-8000-0000000001A1';
SELECT 'move:' || (SELECT sample_id IS NULL FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c3')
  || '/' || (SELECT sample_id = 'c0000000-0000-4000-8000-0000000001a1' FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c1');

-- back-fill: a test whose junction rows were written with the trigger off is repaired
ALTER TABLE test_sessions_subject DISABLE TRIGGER test_sessions_subject_sync_primary;
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-0000000001c4');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-0000000001c4', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2');
SELECT 'stale:' || (sample_id IS NULL) FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c4';
ALTER TABLE test_sessions_subject ENABLE TRIGGER test_sessions_subject_sync_primary;
SELECT sync_test_session_primary_subject(session_id) FROM test_sessions t
  WHERE EXISTS (SELECT 1 FROM test_sessions_subject s WHERE s.test_sessions_id = t.session_id);
SELECT 'backfill:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c4';

-- deleting a whole test cascades through the junction without error
DELETE FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c2';
SELECT 'cascade:' || count(*) FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c2';
SELECT 'comments:' || count(*) FROM pg_description
  WHERE description LIKE '%derived from test_sessions_subject (primary subject); do not write directly%';
ROLLBACK;
SQL
)
ps_check() { grep -qx "$1" <<<"$ps_out" && ok "$2" || bad "$2 (psql output: $ps_out)"; }
ps_check "insert:true/true/v2" "insert: the first sample subject becomes sample_id"
ps_check "second:true/v2" "a second sample subject with a higher id leaves sample_id and the test row untouched"
ps_check "lowest_id:true" "the subject with the lowest junction id is the primary"
ps_check "delete_primary:true" "deleting the primary subject promotes the next one"
ps_check "delete_last:true" "deleting the last sample subject clears sample_id"
ps_check "edge:true/true" "an insert_edges subject fills insert_edge_id and leaves sample_id alone"
ps_check "junk:true/true" "non-uuid, unknown or wrong-collection items are ignored"
ps_check "after_junk:true" "a valid sample after ignored junk still wins (uuid match is case-insensitive)"
ps_check "move:true/true" "moving a junction row recomputes the old and the new test"
ps_check "stale:true" "(setup) with the trigger off the junction alone leaves sample_id NULL"
ps_check "backfill:true" "back-fill repairs a test from its junction rows"
ps_check "cascade:0" "deleting a test cascades through the junction without error"
ps_check "comments:5" "function, trigger function, trigger and columns carry the derived-column comment"

echo "== Deleting samples and edges that are test subjects =="
# Same fixture style as above; every row is rolled back. The back-fill statements are extracted
# from the migration so the direct-value case runs the real SQL.
PS=db/migrations/20261007000139_test_sessions_primary_subject_sync.sql
ps_backfill=$(awk '/^-- Back-fill\./{f=1}/^-- Deleting a sample\./{f=0}f' "$PS")
ds_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('d0000000-0000-4000-8000-0000000001a1', 'TEST-DS-001'),
    ('d0000000-0000-4000-8000-0000000001a2', 'TEST-DS-002'),
    ('d0000000-0000-4000-8000-0000000001a3', 'TEST-DS-003'),
    ('d0000000-0000-4000-8000-0000000001a4', 'TEST-DS-004'),
    ('d0000000-0000-4000-8000-0000000001a5', 'TEST-DS-005'),
    ('d0000000-0000-4000-8000-0000000001a6', 'TEST-DS-006');
INSERT INTO people (person_id, full_name) VALUES ('d0000000-0000-4000-8000-0000000001b0', 'Delete Subject Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('d0000000-0000-4000-8000-0000000001b1', 'TEST-DS-BOX', 'd0000000-0000-4000-8000-0000000001b0');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('d0000000-0000-4000-8000-0000000001b2', 'TEST-DS-BOX-1', 'd0000000-0000-4000-8000-0000000001b1');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier)
VALUES ('d0000000-0000-4000-8000-0000000001b3', 'TEST-DS-BOX-1A', 'd0000000-0000-4000-8000-0000000001b2', 'A');
INSERT INTO test_sessions (session_id) VALUES
    ('d0000000-0000-4000-8000-0000000001c1'), ('d0000000-0000-4000-8000-0000000001c2'),
    ('d0000000-0000-4000-8000-0000000001c3'), ('d0000000-0000-4000-8000-0000000001c4');

-- c1: samples a1 (primary, lowest junction id) and a2.  c2: lone sample a3.
-- c3: samples a4 (primary) and a5 (item in upper case), plus edge b3.
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item) VALUES
    ('00000000-0000-4000-8000-0000000000d1', 'd0000000-0000-4000-8000-0000000001c1', 'physical_samples', 'd0000000-0000-4000-8000-0000000001a1'),
    ('00000000-0000-4000-8000-0000000000d2', 'd0000000-0000-4000-8000-0000000001c1', 'physical_samples', 'd0000000-0000-4000-8000-0000000001a2'),
    ('00000000-0000-4000-8000-0000000000d3', 'd0000000-0000-4000-8000-0000000001c2', 'physical_samples', 'd0000000-0000-4000-8000-0000000001a3'),
    ('00000000-0000-4000-8000-0000000000d4', 'd0000000-0000-4000-8000-0000000001c3', 'physical_samples', 'd0000000-0000-4000-8000-0000000001a4'),
    ('00000000-0000-4000-8000-0000000000d5', 'd0000000-0000-4000-8000-0000000001c3', 'physical_samples', 'D0000000-0000-4000-8000-0000000001A5'),
    ('00000000-0000-4000-8000-0000000000d6', 'd0000000-0000-4000-8000-0000000001c3', 'insert_edges', 'd0000000-0000-4000-8000-0000000001b3');
-- c4: a legacy test written with the column only (no junction row)
UPDATE test_sessions SET sample_id = 'd0000000-0000-4000-8000-0000000001a6' WHERE session_id = 'd0000000-0000-4000-8000-0000000001c4';

-- delete the primary sample of a two-sample test: the test survives and a2 is promoted
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000001a1';
SELECT 'del_primary:' || (SELECT count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c1')
    || '/' || (SELECT sample_id = 'd0000000-0000-4000-8000-0000000001a2' FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c1')
    || '/' || (SELECT count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000001c1');

-- delete a lone sample: the test goes with it, and its audit trail shows the DELETE without a
-- preceding UPDATE (the trigger deletes doomed tests before it edits the survivors)
SELECT COALESCE(max(log_id), 0) AS lid FROM audit_logs \gset
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000001a3';
SELECT 'del_lone:' || (SELECT count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c2')
    || '/' || (SELECT count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000001c2');
SELECT 'del_lone_audit:' || count(*) FILTER (WHERE action_type = 'UPDATE') || '/' || count(*) FILTER (WHERE action_type = 'DELETE')
  FROM audit_logs WHERE table_name = 'test_sessions' AND record_id = 'd0000000-0000-4000-8000-0000000001c2' AND log_id > :lid;

-- delete a secondary sample: its junction row goes, the primary is unchanged
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000001a5';
SELECT 'del_secondary:' || (SELECT count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c3')
    || '/' || (SELECT sample_id = 'd0000000-0000-4000-8000-0000000001a4' FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c3')
    || '/' || (SELECT count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000001c3');

-- delete the last sample of a test that also has an edge subject: the test survives, sample_id NULL
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000001a4';
SELECT 'del_sample_keeps_edge:' || (SELECT count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c3')
    || '/' || (SELECT sample_id IS NULL FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c3')
    || '/' || (SELECT insert_edge_id = 'd0000000-0000-4000-8000-0000000001b3' FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c3');

-- delete the sample of a legacy column-only test: the test is deleted, as the cascade used to do
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000001a6';
SELECT 'del_legacy:' || count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000001c4';

SELECT 'fk:' || confdeltype::text FROM pg_constraint WHERE conname = 'test_sessions_sample_fkey';
SELECT 'other_sample:' || count(*) FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000001a2';
ROLLBACK;
SQL
)
ds_check() { grep -qx "$1" <<<"$ds_out" && ok "$2" || bad "$2 (psql output: $ds_out)"; }
ds_check "del_primary:1/true/1" "deleting the primary sample of a two-sample test keeps the test and promotes the next sample"
ds_check "del_lone:0/0" "deleting a test's only sample deletes the test (and its junction rows)"
ds_check "del_lone_audit:0/1" "deleting a test's only sample leaves no UPDATE of the doomed test in the audit trail, only its DELETE"
ds_check "del_secondary:1/true/2" "deleting a secondary sample removes its junction row and leaves the primary"
ds_check "del_sample_keeps_edge:1/true/true" "deleting a test's last sample keeps a test that still has an edge subject"
ds_check "del_legacy:0" "deleting the sample of a column-only test deletes the test, as before"
ds_check "fk:n" "test_sessions_sample_fkey is ON DELETE SET NULL"
ds_check "other_sample:1" "the test's other sample is not deleted"

# An edge named by a junction row cannot be deleted; an unreferenced one can. A failed statement
# aborts the transaction, so each case is its own run.
ed_run() { $PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('d0000000-0000-4000-8000-0000000002b0', 'Delete Edge Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('d0000000-0000-4000-8000-0000000002b1', 'TEST-DE-BOX', 'd0000000-0000-4000-8000-0000000002b0');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('d0000000-0000-4000-8000-0000000002b2', 'TEST-DE-BOX-1', 'd0000000-0000-4000-8000-0000000002b1');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier) VALUES
    ('d0000000-0000-4000-8000-0000000002b3', 'TEST-DE-BOX-1A', 'd0000000-0000-4000-8000-0000000002b2', 'A'),
    ('d0000000-0000-4000-8000-0000000002b4', 'TEST-DE-BOX-1B', 'd0000000-0000-4000-8000-0000000002b2', 'B');
INSERT INTO test_sessions (session_id) VALUES ('d0000000-0000-4000-8000-0000000002c1');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('d0000000-0000-4000-8000-0000000002c1', 'insert_edges', 'D0000000-0000-4000-8000-0000000002B3');
$1
ROLLBACK;
SQL
}
ed_out=$(ed_run "DELETE FROM insert_edges WHERE edge_id = 'd0000000-0000-4000-8000-0000000002b3';")
grep -q "is the subject of test d0000000-0000-4000-8000-0000000002c1; remove it from the test first" <<<"$ed_out" \
    && ok "deleting an edge named by a junction row raises a clear error" || bad "edge delete was not refused (output: $ed_out)"
ed_out=$(ed_run "DELETE FROM insert_edges WHERE edge_id = 'd0000000-0000-4000-8000-0000000002b4'; SELECT 'free_edge_deleted:' || count(*) FROM insert_edges WHERE edge_id = 'd0000000-0000-4000-8000-0000000002b4';")
grep -qx "free_edge_deleted:0" <<<"$ed_out" && ok "an edge no test names can still be deleted" || bad "free edge delete failed (output: $ed_out)"
ed_out=$(ed_run "DELETE FROM cutting_inserts WHERE insert_id = 'd0000000-0000-4000-8000-0000000002b2';")
grep -q "is the subject of test" <<<"$ed_out" \
    && ok "a cascade from the cutting insert that reaches a subject edge is refused too" || bad "cascade from cutting insert was not refused (output: $ed_out)"

# Back-fill must not overwrite a direct value: a test with a direct sample_id and only an edge in
# the junction keeps its sample (the migration copies it into the junction first).
bf_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('d0000000-0000-4000-8000-0000000003a1', 'TEST-BF-001');
INSERT INTO people (person_id, full_name) VALUES ('d0000000-0000-4000-8000-0000000003b0', 'Backfill Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('d0000000-0000-4000-8000-0000000003b1', 'TEST-BF-BOX', 'd0000000-0000-4000-8000-0000000003b0');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('d0000000-0000-4000-8000-0000000003b2', 'TEST-BF-BOX-1', 'd0000000-0000-4000-8000-0000000003b1');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier)
VALUES ('d0000000-0000-4000-8000-0000000003b3', 'TEST-BF-BOX-1A', 'd0000000-0000-4000-8000-0000000003b2', 'A');
-- the state to repair: written while the sync trigger was not there yet
ALTER TABLE test_sessions_subject DISABLE TRIGGER test_sessions_subject_sync_primary;
INSERT INTO test_sessions (session_id, sample_id) VALUES ('d0000000-0000-4000-8000-0000000003c1', 'd0000000-0000-4000-8000-0000000003a1');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('d0000000-0000-4000-8000-0000000003c1', 'insert_edges', 'd0000000-0000-4000-8000-0000000003b3');
-- swap X -> Y in the (hidden) form: sample_id keeps the stale X, the junction only has Y
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('d0000000-0000-4000-8000-0000000003a2', 'TEST-BF-002'), ('d0000000-0000-4000-8000-0000000003a3', 'TEST-BF-003');
INSERT INTO test_sessions (session_id, sample_id) VALUES ('d0000000-0000-4000-8000-0000000003c2', 'd0000000-0000-4000-8000-0000000003a2');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('d0000000-0000-4000-8000-0000000003c2', 'physical_samples', 'd0000000-0000-4000-8000-0000000003a3');
-- the audit trail shows a sample removed from a test that now only has an edge subject
INSERT INTO test_sessions (session_id, sample_id) VALUES ('d0000000-0000-4000-8000-0000000003c3', 'd0000000-0000-4000-8000-0000000003a2');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-0000000003d1', 'd0000000-0000-4000-8000-0000000003c3', 'physical_samples', 'D0000000-0000-4000-8000-0000000003A2');
DELETE FROM test_sessions_subject WHERE id = '00000000-0000-4000-8000-0000000003d1';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('d0000000-0000-4000-8000-0000000003c3', 'insert_edges', 'd0000000-0000-4000-8000-0000000003b3');
ALTER TABLE test_sessions_subject ENABLE TRIGGER test_sessions_subject_sync_primary;
$ps_backfill
SELECT 'bf_keeps_direct:' || (sample_id = 'd0000000-0000-4000-8000-0000000003a1') || '/' || (insert_edge_id = 'd0000000-0000-4000-8000-0000000003b3')
  FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000003c1';
SELECT 'bf_junction:' || count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000003c1';
SELECT 'bf_swap:' || (sample_id = 'd0000000-0000-4000-8000-0000000003a3')
    || '/' || (SELECT count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000003c2')
    || '/' || (SELECT count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000003c2' AND lower(item) = 'd0000000-0000-4000-8000-0000000003a2')
  FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000003c2';
SELECT 'bf_audited_removal:' || (sample_id IS NULL)
    || '/' || (SELECT count(*) FROM test_sessions_subject WHERE test_sessions_id = 'd0000000-0000-4000-8000-0000000003c3' AND collection = 'physical_samples')
  FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000003c3';
ROLLBACK;
SQL
)
bf_check() { grep -qx "$1" <<<"$bf_out" && ok "$2" || bad "$2 (psql output: $bf_out)"; }
bf_check "bf_keeps_direct:true/true" "back-fill keeps a direct sample_id when the junction only had an edge"
bf_check "bf_junction:2" "back-fill copies the direct sample and edge into the junction"
bf_check "bf_swap:true/1/0" "back-fill does not resurrect a swapped-out sample: the stale sample_id is not copied back and becomes the junction's sample"
bf_check "bf_audited_removal:true/0" "back-fill does not copy back a sample the audit trail shows was removed from the test's subjects"

# Rolling the migration back: indexes serve the trigger lookups, the down section keeps multi-sample
# tests alive once the cascade is back, and everything it created is gone.
ps_down=$(awk '/^-- migrate:down/{f=1;next}f' "$PS")
dn_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('d0000000-0000-4000-8000-0000000004a1', 'TEST-DN-001'), ('d0000000-0000-4000-8000-0000000004a2', 'TEST-DN-002'),
    ('d0000000-0000-4000-8000-0000000004a3', 'TEST-DN-003');
INSERT INTO test_sessions (session_id) VALUES
    ('d0000000-0000-4000-8000-0000000004c1'), ('d0000000-0000-4000-8000-0000000004c2');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item) VALUES
    ('00000000-0000-4000-8000-0000000004d1', 'd0000000-0000-4000-8000-0000000004c1', 'physical_samples', 'd0000000-0000-4000-8000-0000000004a1'),
    ('00000000-0000-4000-8000-0000000004d2', 'd0000000-0000-4000-8000-0000000004c1', 'physical_samples', 'd0000000-0000-4000-8000-0000000004a2'),
    ('00000000-0000-4000-8000-0000000004d3', 'd0000000-0000-4000-8000-0000000004c2', 'physical_samples', 'd0000000-0000-4000-8000-0000000004a3');
SELECT 'dn_pre:' || (SELECT sample_id = 'd0000000-0000-4000-8000-0000000004a1' FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000004c1');
SELECT 'dn_idx_comments:' || count(*) FROM pg_class c JOIN pg_description d ON d.objoid = c.oid
  WHERE c.relname IN ('test_sessions_sample_id_idx', 'test_sessions_insert_edge_id_idx', 'test_sessions_subject_target_lower_idx');
-- the indexes serve the lookups of the delete triggers and of the foreign key action
SET LOCAL enable_seqscan = off;
EXPLAIN SELECT 1 FROM test_sessions WHERE sample_id = 'd0000000-0000-4000-8000-0000000004a1';
EXPLAIN SELECT 1 FROM test_sessions WHERE insert_edge_id = 'd0000000-0000-4000-8000-0000000004a1';
EXPLAIN SELECT 1 FROM test_sessions_subject s WHERE s.collection = 'insert_edges' AND lower(s.item) = 'x';
EXPLAIN DELETE FROM test_sessions_subject s WHERE s.collection = 'physical_samples' AND lower(s.item) = 'x';
RESET enable_seqscan;
$ps_down
SELECT 'dn_cleared:' || (SELECT sample_id IS NULL FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000004c1')
    || '/' || (SELECT sample_id = 'd0000000-0000-4000-8000-0000000004a3' FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000004c2');
-- the restored cascade must not delete the multi-sample test
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000004a1';
SELECT 'dn_survives:' || count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000004c1';
-- and a one-sample test is cascade-deleted with its sample, as before 139
DELETE FROM physical_samples WHERE sample_id = 'd0000000-0000-4000-8000-0000000004a3';
SELECT 'dn_cascade:' || count(*) FROM test_sessions WHERE session_id = 'd0000000-0000-4000-8000-0000000004c2';
SELECT 'dn_fk:' || confdeltype::text FROM pg_constraint WHERE conname = 'test_sessions_sample_fkey';
SELECT 'dn_idx_gone:' || count(*) FROM pg_indexes WHERE indexname IN ('test_sessions_sample_id_idx', 'test_sessions_insert_edge_id_idx', 'test_sessions_subject_target_lower_idx');
SELECT 'dn_triggers_gone:' || count(*) FROM pg_trigger WHERE tgname IN ('physical_samples_delete_test_subjects', 'insert_edges_block_subject_delete', 'test_sessions_subject_sync_primary');
ROLLBACK;
SQL
)
dn_check() { grep -qx "$1" <<<"$dn_out" && ok "$2" || bad "$2 (psql output: $dn_out)"; }
dn_check "dn_pre:true" "(setup) the two-sample test has its derived primary sample before the rollback"
dn_check "dn_idx_comments:3" "the three new indexes carry comments"
for idx in test_sessions_sample_id_idx test_sessions_insert_edge_id_idx test_sessions_subject_target_lower_idx; do
    grep -q "using $idx" <<<"$dn_out" && ok "the planner can use $idx for the trigger lookups" || bad "$idx is not used (psql output: $dn_out)"
done
dn_check "dn_cleared:true/true" "down clears sample_id on a multi-sample test and keeps it on a one-sample test"
dn_check "dn_survives:1" "after down, deleting a multi-sample test's first sample no longer deletes the test"
dn_check "dn_cascade:0" "after down, a one-sample test is deleted with its sample (the restored cascade)"
dn_check "dn_fk:c" "down restores test_sessions_sample_fkey ON DELETE CASCADE"
dn_check "dn_idx_gone:0" "down drops the three indexes"
dn_check "dn_triggers_gone:0" "down drops the sync and delete triggers"

echo "== physical_samples.co_owners is free for the M2M alias (ADR-0011) =="
# The legacy TEXT column is renamed so that `co_owners._some.user_id` in a permission filter can
# only mean the sample_co_owners junction. Run the migration's down then up in a rolled-back
# transaction, with a legacy value seeded to prove the data survives both renames.
CO=db/migrations/20261007000140_physical_samples_co_owners_legacy.sql
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
co_check() { grep -qx "$1" <<<"$co_out" && ok "$2" || bad "$2 (psql output: $co_out)"; }
co_check "dn_col:1" "down: the TEXT column is called co_owners again"
co_check "dn_val:a@example.org" "down: the legacy value survives"
co_check "dn_meta:0" "down: the hidden Directus field row is removed"
co_check "up_col:0" "up: co_owners is renamed away"
co_check "up_val:a@example.org" "up: the legacy value survives"
co_check "up_meta:true/true" "up: the legacy column is hidden and read-only in Directus"
co_check "up_idempotent:1" "up is idempotent (one Directus field row)"
co_check "views_ok:1" "views over physical_samples still work after the rename"

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
   AND collection IN ('materials','material_iso_classifications','alloying_elements','material_alloying_elements',
                      'equipment','tools','tool_boxes','cutting_inserts','insert_edges','insert_types',
                      'raw_stock_lots','manufacturing_methods','people','facilities','fast_recipes',
                      'directus_files');
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
SELECT 'sample_read_has_co_owners:' || count(*) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'physical_samples' AND action = 'read'
   AND permissions::jsonb @> '{"_or":[{"co_owners":{"_some":{"user_id":{"_eq":"\$CURRENT_USER"}}}}]}'::jsonb;
SELECT 'rollup_read:' || permissions::text FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'project_rollup' AND action = 'read';
SQL
)
rl_check() { grep -qxF -- "$1" <<<"$rl_out" && ok "$2" || bad "$2 (psql output: $rl_out)"; }
gen_n=$(grep -o '^generated:[0-9]*' <<<"$rl_out" | cut -d: -f2)
[[ "${gen_n:-0}" -gt 40 ]] && rl_check "exact:$gen_n" "every ruled Lab Member row carries exactly the generated permissions, validation and fields ($gen_n rows)" \
    || bad "the generator produced too few rules (psql output: $rl_out)"
rl_check "stray:0" "no Lab Member row carries a filter that access_rules.json does not generate"
rl_check "unlisted:0" "every Lab Member (collection, action) row in the database is listed in access_rules.json"
rl_check "reference_filtered:0" "reference data, people and directus_files stay unfiltered"
rl_check "ref_in_rules:0" "materials, equipment and raw_stock_lots have no rules"
rl_check "audit_logs_rows:0" "Lab Member has no grant on audit_logs (admins only)"
rl_check "people_actions:create,read,update" "Lab Member can create, read and update people but not delete them"
rl_check "people_update_fields:full_name,email,is_operator,is_researcher,active,notes" "Lab Member cannot update people.user_id (no relink takeover)"
rl_check "people_create_validation:true" "a Lab Member can only create a People row with no login or their own"
rl_check "people_columns_left_out:created_at,legacy_machine_operator_id,person_id,user_id" "people.update leaves out exactly the key, the login, the legacy id and the timestamp"
rl_check "sample_read_has_co_owners:1" "the sample read filter matches co_owners._some.user_id (the M2M alias)"
rl_check 'rollup_read:{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}' \
    "project_rollup is readable only by the project's PI and investigators"
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
xm_check() { grep -qxF -- "$1" <<<"$xmin_out" && ok "$2" || bad "$2 (psql output: $xmin_out)"; }
xm_check "old_before_update:0" "a pre-existing parent is not 'created here' (xmin differs)"
xm_check "updated_here_xmin_alone:4" "xmin alone matches all four pre-existing parents once updated in the transaction (why version = 1 is needed)"
xm_check "updated_here_guard:0" "the guard's proof refuses a pre-existing parent updated in the same transaction (samples, tests, campaigns, projects)"
xm_check "inserted_here_guard:4" "the guard's proof accepts a parent inserted by the transaction (samples, tests, campaigns, projects)"
xm_check "inserted_then_updated_guard:0" "a parent inserted and then updated in the same transaction is refused (fails closed)"

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
grep -qxF "b_pickers_before:12" <<<"$cfg_out" && ok "the migrations leave 12 person picker field rows (owner, operator and PI)" \
    || bad "expected 12 owner_person_id/operator_person_id/principal_investigator_person field rows after the migrations (output: $cfg_out)"
grep -qxF "b_pickers_changed:0" <<<"$cfg_out" && ok "the configure scripts keep every person picker field row, with migration 062's interface, options, display, width, sort and translations" \
    || bad "a configure script drops or changes a person picker field row (output: $cfg_out)"
grep -qxF "b_picker_relations_lost:0" <<<"$cfg_out" && ok "the configure scripts keep a relation to people for every person picker" \
    || bad "a configure script drops the people relation of a person picker (output: $cfg_out)"
grep -qxF "b_legacy_visible:0" <<<"$cfg_out" && ok "the legacy owner and operator backup columns stay hidden after the configure scripts" \
    || bad "a configure script makes a legacy owner/operator column visible again (output: $cfg_out)"
rm -rf "$RES_DIR"

# The migration itself. Down first (to the real pre-migration state), then seed what the old script
# left: unfiltered rows, a NULL-permission row, a hand-added campaigns row, a hand-narrowed field
# list, the audit_logs grant, the four people rows, an unrelated row, another policy's row; delete
# some relations the way the configure scripts did. Run up twice, assert, run down, and assert the
# Lab Member rows are back exactly (ids included). ROLLBACK.
RV=db/migrations/20261007000141_lab_member_row_visibility.sql
rv_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RV")
rv_down=$(awk '/-- migrate:down/{f=1;next}f' "$RV")
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
CREATE TEMP TABLE _gen AS
  SELECT * FROM json_to_recordset(\$rules\$$rules_json\$rules\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, ruled boolean);
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
SELECT 'up_exact:' || count(*) FROM _gen g JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = g.collection AND p.action = g.action AND p.permissions::jsonb = g.permissions
 AND (g.fields = '*' OR p.fields = g.fields) AND (g.validation = '{}'::jsonb OR p.validation::jsonb = g.validation)
 WHERE g.ruled;
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
SELECT 'dn_indexes:' || count(*) FROM pg_indexes WHERE indexname LIKE 'idx\_%\_owner\_person\_id' OR indexname IN ('idx_physical_samples_project_id','idx_sample_co_owners_user_id','idx_project_investigators_user_id');
ROLLBACK;
SQL
)
rv_check() { grep -qxF -- "$1" <<<"$rv_out" && ok "$2" || bad "$2 (psql output: $rv_out)"; }
rv_check "dn0_backup_table:gone" "(setup) down drops the backup table"
rv_check "dn0_schema:gone" "(setup) down drops the private schema once it is empty"
rv_check "up_sample_read_filtered:true" "up: an unfiltered sample read row gets the filter"
rv_check 'up_sample_delete:{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}' "up: sample delete is owner-only"
rv_check "up_hand_fields:sample_id,sample_code" "up: a field list narrowed by hand on a collection without custom rows is kept"
rv_check "up_sample_create_inserted:{}" "up: a missing create row is inserted, unfiltered"
rv_check "up_campaigns_read_rows:1" "up: a hand-added campaigns row is updated, not duplicated"
rv_check "up_campaigns_read_filtered:true" "up: campaigns read is filtered"
rv_check "up_materials:{}" "up: reference data rows are not touched"
rv_check "up_other_policy:{}" "up: another policy's rows are not touched"
rv_check "up_rollup_rows:1" "up: project_rollup gets a read row"
rv_check "up_fast_run_data_actions:read" "up: fast_run_data stays read-only"
rv_check "up_audit_logs:0" "up: the Lab Member audit_logs grant is removed"
rv_check "up_people_actions:create,read,update" "up: Lab Member people delete is removed"
rv_check "up_people_update_fields:full_name,email,is_operator,is_researcher,active,notes" "up: people update loses user_id"
rv_check "up_people_create_validation:true" "up: people create gets the login validation"
n_exact=$(grep -o '^up_exact:[0-9]*' <<<"$rv_out" | cut -d: -f2)
[[ "${n_exact:-0}" -eq "${gen_n:-x}" ]] && ok "up: every ruled row matches the generated rules ($n_exact rows)" || bad "up: ruled rows differ from the generated rules (psql output: $rv_out)"
n_backup=$(grep -o '^up_backup_rows:[0-9]*' <<<"$rv_out" | cut -d: -f2)
[[ "${n_backup:-0}" -eq 9 ]] && ok "up: the backup holds the 9 seeded Lab Member rows of the changed collections" || bad "up: backup has ${n_backup:-?} rows, want 9 (psql output: $rv_out)"
rv_check "up_backup_exact:0" "up: the backup rows equal the rows before the migration, ids included"
rv_check "up_backup_commented:true" "up: the backup table has a comment"
rv_check "up_backup_not_public:absent" "up: the backup is not a public table (Directus would list it as a collection)"
rv_check "up_backup_in_dictionary:0" "up: the backup and change-log tables are not in v_schema_dictionary (the Ask-DB prompt)"
rv_check "up_backup_in_targets:0" "up: nothing of the backup is a v_llm_query_targets entry"
rv_check "up_private_schema_commented:true" "up: the d1_private schema has a comment"
rv_check "up_llm_usage:false" "up: the LLM role has no USAGE on d1_private"
rv_check "up_llm_select:false" "up: the LLM role cannot read the backup"
rv_check "up_public_usage:false" "up: PUBLIC has no USAGE on d1_private"
rv_check "up_changes:alias_field/projects.operations,alias_field/projects.samples,relation_alias/manufacturing_operations.project_id,relation_alias/physical_samples.project_id" "up: records the aliases it set (not the test_sessions one that already existed)"
rv_check "up_rel_owner:3" "up: the deleted owner_person_id and campaign_samples.campaign_id relations are inserted again"
rv_check "up_alias:samples" "up: physical_samples.project_id gets the one_field alias 'samples'"
rv_check "up_alias_ops:operations" "up: manufacturing_operations.project_id gets the alias 'operations'"
rv_check "up_alias_tests:sessions" "up: test_sessions.project_id gets the alias 'sessions'"
rv_check "up_alias_fields:operations=true/true,samples=true/true,sessions=true/true" "up: the projects aliases are hidden and read-only"
rv_check "up_idempotent_alias:3" "up is idempotent (three alias fields)"
rv_check "up_idempotent_relations:1" "up is idempotent (one owner_person_id relation)"
rv_check "up2_backup_still_old:0" "a second up keeps the first backup (the pre-migration rows)"
rv_check "up2_backup_rows:$n_backup" "a second up does not add backup rows"
rv_check "up2_changes:4" "a second up does not add change rows"
grep -q "ownerless records.*physical_samples=[1-9]" <<<"$rv_out" && ok "up: reports ownerless samples in a NOTICE" || bad "up: no ownerless NOTICE (psql output: $rv_out)"
rv_check "dn_exact:0" "down: the Lab Member rows are exactly as before (ids, filters, fields, presets)"
rv_check 'dn_hand_fields:sample_id,sample_code {"owner":1}' "down: a hand-narrowed field list and its presets come back"
rv_check "dn_audit_logs:1" "down: the audit_logs grant comes back"
rv_check "dn_people_actions:create,delete,read,update" "down: people delete comes back"
rv_check "dn_materials:1" "down: reference data rows are kept"
rv_check "dn_other_policy:1" "down: another policy's rows are kept"
rv_check "dn_filters_left:0" "down: no Lab Member row keeps a filter"
rv_check "dn_backup_table:gone" "down: the backup table is dropped"
rv_check "dn_changes_table:gone" "down: the change log is dropped"
rv_check "dn_schema:gone" "down: the empty private schema is dropped"
rv_check "dn_alias:null" "down: the relation alias is removed"
rv_check "dn_alias_ops:null" "down: the operations alias is removed"
rv_check "dn_alias_tests:sessions" "down: an alias that existed before up (test_sessions.project_id -> sessions) is kept"
rv_check "dn_alias_sessions_field:pre-existing alias (test seed)" "down: the alias field row that existed before up is kept untouched"
rv_check "dn_alias_fields:sessions" "down: only the alias fields up inserted are removed"
rv_check "dn_indexes:0" "down: the indexes are dropped"
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

echo "== Cleanup test rows =="
$PSQL -c "
    DELETE FROM sample_genealogy
    WHERE child_sample_id IN (
        SELECT sample_id FROM physical_samples
        WHERE sample_code IN ('TEST-AUDIT-001','TEST-CHILD-001','TEST-PARENT-001')
    );
    DELETE FROM physical_samples
    WHERE sample_code IN ('TEST-AUDIT-001','TEST-CHILD-001','TEST-PARENT-001');
" > /dev/null 2>&1 || true
ok "test rows cleaned up"

echo
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
echo "Phase 1 schema OK."
