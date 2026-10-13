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

echo "== Directus field metadata is complete =="
# Regression guard for the 2026-07/09 incident: scripts/configure_directus.sql was run on a migrated
# database, its blanket DELETE FROM directus_fields removed the inline parameter field rows (and more),
# and nothing noticed for weeks. The migration 20261009000143 restores them. On CI the migrations are
# the only thing that writes Directus metadata, so these are real checks there too.
run_eq "every inline parameter column has a directus_fields row" \
    "SELECT count(*) FROM information_schema.columns AS c
     WHERE c.table_schema = 'public'
       AND ((c.table_name = 'manufacturing_operations' AND c.column_name ~ '^(machining|sintering|ht|deform|am)_')
         OR (c.table_name = 'test_sessions' AND c.column_name ~ '^(tensile|hardness|charpy|compression|sem|xrd)_'))
       AND NOT EXISTS (SELECT 1 FROM directus_fields AS f WHERE f.collection = c.table_name AND f.field = c.column_name)" \
    "0"
# Every relation that names an alias (one_field) needs the alias field row, or the parent form loses
# the panel. Known gaps that predate the incident, kept out so this stays a regression guard:
#   * manufacturing_methods.operations and raw_stock_lots.provenance: relations from configure_directus.sql
#     whose alias field rows have never existed anywhere;
#   * campaigns.operations and campaigns.sessions: on CI the relation rows come from migration
#     20261007000141, but the alias field rows come from scripts/configure_campaigns.sql, which CI
#     does not run.
run_eq "every relation alias has its directus_fields row (known gaps excepted)" \
    "SELECT count(*) FROM directus_relations AS r
     WHERE r.one_field IS NOT NULL
       AND (r.one_collection, r.one_field) NOT IN (
           ('manufacturing_methods', 'operations'), ('raw_stock_lots', 'provenance'),
           ('campaigns', 'operations'), ('campaigns', 'sessions'))
       AND NOT EXISTS (SELECT 1 FROM directus_fields AS f
                       WHERE f.collection = r.one_collection AND f.field = r.one_field)" \
    "0"
run_eq "every field group points at a field row of the same collection" \
    "SELECT count(*) FROM directus_fields AS f
     WHERE f.\"group\" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM directus_fields AS g WHERE g.collection = f.collection AND g.field = f.\"group\")" \
    "0"
run_eq "no (collection, field) has two directus_fields rows" \
    "SELECT count(*) FROM (SELECT 1 FROM directus_fields GROUP BY collection, field HAVING count(*) > 1) AS d" \
    "0"

echo "== Directus field metadata: restore migration =="
# directus_fields / directus_relations are empty stubs on CI, so reproduce the state the incident left
# (inline rows, the four alias fields and the source_recipe_id relation gone; a customised inline row and
# an owner picker present; the o2m relation of projects.rollup missing) in a rolled-back transaction, then
# apply the migration's up twice and its down, asserting each step.
RIM=db/migrations/20261009000143_restore_inline_param_field_meta.sql
rim_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RIM")
rim_down=$(awk '/-- migrate:down/{f=1;next}f' "$RIM")
# sintering_run_number (migration 156) is a later column with its own row; 143 neither adds nor removes it, so it stays out of these counts
rim_inline="((collection = 'manufacturing_operations' AND field ~ '^(machining|sintering|ht|deform|am)_' AND field !~ '_group\$' AND field <> 'sintering_run_number')
         OR (collection = 'test_sessions' AND field ~ '^(tensile|hardness|charpy|compression|sem|xrd)_'))"
rim_out=$($PSQL 2>&1 <<SQL
BEGIN;
DROP TABLE IF EXISTS d1_private.restore_inline_param_meta_changes;
DROP TABLE IF EXISTS d1_private.operation_sequence_backfill;
DELETE FROM directus_fields WHERE $rim_inline
  OR (collection = 'manufacturing_operations' AND field IN ('prep_steps', 'source_recipe_id', 'data_file_links'))
  OR (collection = 'projects' AND field = 'rollup')
  OR (collection = 'manufacturing_operations' AND field = 'owner_person_id');
DELETE FROM directus_relations
  WHERE (many_collection = 'manufacturing_operations' AND many_field = 'source_recipe_id')
     OR (many_collection, many_field) IN (('prep_steps', 'operation_id'), ('operation_files', 'operation_id'), ('project_rollup', 'project_id'));
-- the o2m relations that name two of the aliases exist; the one for projects.rollup does not (yet)
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
  ('prep_steps', 'operation_id', 'manufacturing_operations', 'prep_steps', 'delete'),
  ('operation_files', 'operation_id', 'manufacturing_operations', 'data_file_links', 'delete');
-- a row that is present and customised, and an owner picker set by 20261001000126_owner_picker_fields.sql: both must survive
INSERT INTO directus_fields (collection, field, interface, note, "group") VALUES
  ('manufacturing_operations', 'sintering_batch_number', 'input', 'custom note', NULL),
  ('manufacturing_operations', 'owner_person_id', 'd1-owner-picker', NULL, NULL);
SELECT 'seeded_missing:' || count(*) FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND ((c.table_name = 'manufacturing_operations' AND c.column_name ~ '^(machining|sintering|ht|deform|am)_')
      OR (c.table_name = 'test_sessions' AND c.column_name ~ '^(tensile|hardness|charpy|compression|sem|xrd)_'))
    AND NOT EXISTS (SELECT 1 FROM directus_fields AS f WHERE f.collection = c.table_name AND f.field = c.column_name);
$rim_up
SELECT 'up_missing:' || count(*) FROM information_schema.columns AS c
  WHERE c.table_schema = 'public'
    AND ((c.table_name = 'manufacturing_operations' AND c.column_name ~ '^(machining|sintering|ht|deform|am)_')
      OR (c.table_name = 'test_sessions' AND c.column_name ~ '^(tensile|hardness|charpy|compression|sem|xrd)_'))
    AND NOT EXISTS (SELECT 1 FROM directus_fields AS f WHERE f.collection = c.table_name AND f.field = c.column_name);
SELECT 'up_ops_rows:' || count(*) FROM directus_fields WHERE collection = 'manufacturing_operations'
  AND field ~ '^(machining|sintering|ht|deform|am)_' AND field !~ '_group\$' AND field <> 'sintering_run_number';
SELECT 'up_sessions_rows:' || count(*) FROM directus_fields WHERE collection = 'test_sessions'
  AND field ~ '^(tensile|hardness|charpy|compression|sem|xrd)_';
SELECT 'up_custom_row:' || count(*) || ',' || max(note) FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
SELECT 'up_owner_picker:' || count(*) || ',' || max(interface) FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND field = 'owner_person_id';
SELECT 'up_machine_group:' || count(*) FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND "group" = 'sintering_machine_group' AND field <> 'sintering_run_number';
SELECT 'up_qa_group:' || count(*) FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND "group" = 'sintering_qa_group';
SELECT 'up_hidden_recipe_number:' || hidden FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND field = 'sintering_recipe_number';
SELECT 'up_presets:' || count(*) FROM directus_fields
  WHERE interface = 'select-dropdown' AND options::text LIKE '%allowOther%'
    AND collection = 'test_sessions'
    AND field IN ('sem_magnification_range', 'sem_coating_material', 'sem_etchant', 'xrd_radiation_source', 'xrd_detector_type');
SELECT 'up_relation:' || count(*) || ',' || max(one_collection) FROM directus_relations
  WHERE many_collection = 'manufacturing_operations' AND many_field = 'source_recipe_id';
SELECT 'up_alias_with_relation:' || count(*) FROM directus_fields
  WHERE (collection = 'manufacturing_operations' AND field IN ('prep_steps', 'source_recipe_id', 'data_file_links'));
SELECT 'up_alias_without_relation:' || count(*) FROM directus_fields WHERE collection = 'projects' AND field = 'rollup';
-- the missing relation arrives; the second run fills only that gap
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
  ('project_rollup', 'project_id', 'projects', 'rollup', 'nullify');
$rim_up
SELECT 'up2_rollup:' || count(*) FROM directus_fields WHERE collection = 'projects' AND field = 'rollup';
SELECT 'up2_inline_rows:' || count(*) FROM directus_fields WHERE $rim_inline;
SELECT 'up2_duplicates:' || count(*) FROM (SELECT 1 FROM directus_fields GROUP BY collection, field HAVING count(*) > 1) AS d;
SELECT 'up2_relations:' || count(*) FROM directus_relations
  WHERE many_collection = 'manufacturing_operations' AND many_field = 'source_recipe_id';
$rim_down
SELECT 'down_inline_rows:' || count(*) FROM directus_fields WHERE $rim_inline;
SELECT 'down_custom_row:' || count(*) || ',' || max(note) || ',' || coalesce(max("group"), 'no group') FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
SELECT 'down_aliases:' || count(*) FROM directus_fields
  WHERE (collection = 'manufacturing_operations' AND field IN ('prep_steps', 'source_recipe_id', 'data_file_links'))
     OR (collection = 'projects' AND field = 'rollup');
SELECT 'down_relation:' || count(*) FROM directus_relations
  WHERE many_collection = 'manufacturing_operations' AND many_field = 'source_recipe_id';
SELECT 'down_other_relations:' || count(*) FROM directus_relations
  WHERE (many_collection, many_field) IN (('prep_steps', 'operation_id'), ('operation_files', 'operation_id'), ('project_rollup', 'project_id'));
SELECT 'down_owner_picker:' || count(*) || ',' || max(interface) FROM directus_fields
  WHERE collection = 'manufacturing_operations' AND field = 'owner_person_id';
SELECT 'down_ledger:' || coalesce(to_regclass('d1_private.restore_inline_param_meta_changes')::text, 'dropped');
ROLLBACK;
SQL
)
rim_check() { grep -qx "$1" <<<"$rim_out" && ok "$2" || bad "$2 (psql output: $rim_out)"; }
rim_check "seeded_missing:115" "setup: the incident state is reproduced (115 inline columns without a row; the 116th is the customised one)"
rim_check "up_missing:0" "up: every inline parameter column has a row again"
rim_check "up_ops_rows:56" "up: 56 manufacturing_operations parameter rows"
rim_check "up_sessions_rows:60" "up: 60 test_sessions parameter rows"
rim_check "up_custom_row:1,custom note" "up: a present, customised row is left as it is (not duplicated, not replaced)"
rim_check "up_owner_picker:1,d1-owner-picker" "up: the d1-owner-picker interface of 20261001000126_owner_picker_fields.sql is untouched"
rim_check "up_machine_group:10" "up: ten machine-sourced sintering fields are in the machine group"
rim_check "up_qa_group:5" "up: five QA fields are in the QA group"
rim_check "up_hidden_recipe_number:true" "up: the free-text sintering recipe number is hidden (migration 102)"
rim_check "up_presets:5" "up: the five SEM/XRD dropdown presets are restored"
rim_check "up_relation:1,prep_recipes" "up: manufacturing_operations.source_recipe_id is related to prep_recipes"
rim_check "up_alias_with_relation:3" "up: prep_steps, source_recipe_id and data_file_links aliases are restored"
rim_check "up_alias_without_relation:0" "up: an o2m alias whose relation is missing is not inserted"
rim_check "up2_rollup:1" "up (second run): fills the gap once the relation exists"
rim_check "up2_inline_rows:116" "up (second run): no inline row is added twice"
rim_check "up2_duplicates:0" "up (second run): no (collection, field) is duplicated"
rim_check "up2_relations:1" "up (second run): the relation is not duplicated"
rim_check "down_inline_rows:1" "down: removes the inline rows it added and keeps the one that was there"
rim_check "down_custom_row:1,custom note,no group" "down: the pre-existing row keeps its content and its group is cleared"
rim_check "down_aliases:0" "down: removes the four alias fields"
rim_check "down_relation:0" "down: removes the source_recipe_id relation"
rim_check "down_other_relations:3" "down: leaves relations it did not add"
rim_check "down_owner_picker:1,d1-owner-picker" "down: the owner picker is still untouched"
rim_check "down_ledger:dropped" "down: drops its bookkeeping table"

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

echo "== Sample geometry: ring form migration =="
# Same shape as the round bar section: the column is real, the Directus rows are seeded stubs.
MIG=db/migrations/20261012000162_ring_form.sql
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
ring_check() { grep -qx "$1" <<<"$ring_out" && ok "$2" || bad "$2 (psql output: $ring_out)"; }
ring_check "up_form_choices:1" "up: Geometry dropdown offers ring (and round_bar)"
ring_check "up_dim_fields:4" "up: Ø, inner Ø, width and thickness are shown for ring"
grep -q "physical_samples_inner_diameter_mm_check" <<<"$ring_out" && ! grep -qx "bore_check:missing" <<<"$ring_out" \
  && ok "a bore as wide as the ring is refused" || bad "a bore as wide as the ring is refused (psql output: $ring_out)"
ring_check "down_fields:0" "down: ring removed from dropdown, conditions and fields"
ring_check "down_form:disc" "down: ring samples are mapped to disc"
ring_check "down_column:0" "down: inner_diameter_mm is dropped"

echo "== Label templates migration =="
# Run the file's down and up inside a rolled-back transaction (the Directus tables are stubs here, so
# the metadata rows are asserted by counting what the migration wrote).
LT=db/migrations/20261012000164_label_templates.sql
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
lt_check() { grep -qxF "$1" <<<"$lt_out" && ok "$2" || bad "$2 (psql output: $lt_out)"; }
lt_check "down_table:gone" "down: label_templates is dropped"
lt_check "down_settings_table:gone" "down: label_settings is dropped"
lt_check "down_meta:0,0,0,0" "down: its Directus fields, collection, permissions and relations are removed"
lt_check "up_seeds:50×25 single|A4 4×5|Brother DK-22205 62 mm|L7160 21-up" "up: the four template seeds are present"
lt_check "up_default:A4 4×5" "up: A4 4×5 is the only default"
lt_check "up_fields:26" "up: every column has a Directus field row"
lt_check "up_relations:2" "up: user_created and user_updated relate to directus_users"
lt_check 'up_perm_rows:create={};delete={"user_created":{"_eq":"$CURRENT_USER"}};read={};update={"user_created":{"_eq":"$CURRENT_USER"}}' \
    "up: Lab Members read and create freely, update and delete only their own rows"
lt_check "up_perm_fields:create=18/false;delete=1/false;read=1/false;update=18/false"     "up: Lab Member create and update cannot set is_default, id or the system columns"
lt_check "up_qr_all:4" "up: every seed template puts all six extras in the QR"
lt_check "ls_row:1,null" "up: label_settings has its one row, with no contact yet"
lt_check "ls_meta:5,1" "up: label_settings is a Directus singleton with a field row per column"
lt_check "ls_perm:read" "up: Lab Members may only read label_settings"
lt_check "ls_comments:0" "up: every label_settings column carries a COMMENT"
lt_check "ls_triggers:audit_label_settings,occ_label_settings" "up: label_settings has the audit and OCC triggers"
! grep -qx "ls_second_row:accepted" <<<"$lt_out" && ok "a second label_settings row is refused" || bad "a second label_settings row is refused"
! grep -qx "ls_bad_email:accepted" <<<"$lt_out" && ok "a contact email without an @ is refused" || bad "a contact email without an @ is refused"
! grep -qx "ls_no_dot_email:accepted" <<<"$lt_out" && ok "a contact email with no dot after the @ (a@bcd) is refused" || bad "a contact email with no dot after the @ (a@bcd) is refused"
lt_check "ls_good_email:lab@example.org,v2" "a valid contact email is accepted and bumps version"
lt_check "up_comments:0" "up: every column carries a COMMENT"
lt_check "up_tbl_comment:true" "up: the table carries a COMMENT"
lt_check "up_triggers:audit_label_templates,label_templates_single_default,occ_label_templates" "up: audit, single-default and OCC triggers are attached"
! grep -qx "roll_grid:accepted" <<<"$lt_out" && ok "a roll with 2 columns is refused" || bad "a roll with 2 columns is refused"
lt_check "swap_insert:t-second-default" "inserting a default template clears the old default"
lt_check "swap_update:L7160 21-up" "making a template the default clears the old default"
lt_check "swap_unrelated_update:L7160 21-up" "an unrelated update keeps the default"
lt_check "swap_failed_insert:A4 4×5" "a failed insert with is_default keeps the old default"
! grep -qx "dup_name:accepted" <<<"$lt_out" && ok "a duplicate template name is refused" || bad "a duplicate template name is refused"
! grep -qx "bad_arrangement:accepted" <<<"$lt_out" && ok "an unknown arrangement is refused" || bad "an unknown arrangement is refused"
lt_check "occ_version:2" "an update bumps version"
lt_check "audit_updates:1" "an update of a template is audited"
lt_check "redown_table:gone" "down runs again after up"

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
# owner_person_id (062), campaign_samples.campaign_id (087) and created_by (20261001000124), plus the
# project_id link and the two campaign_id links of operations and tests that migration 141 registers
# for the row filters (ADR-0011).
run_eq "Directus relations for campaigns are registered (6)" \
    "SELECT string_agg(many_collection || '.' || many_field || '->' || one_collection, ',' ORDER BY many_collection COLLATE \"C\", many_field COLLATE \"C\")
     FROM directus_relations
     WHERE one_collection='campaigns' OR many_collection='campaigns'
        OR (many_collection IN ('manufacturing_operations','test_sessions') AND many_field='campaign_id')" \
    "campaign_samples.campaign_id->campaigns,campaigns.created_by->directus_users,campaigns.owner_person_id->people,campaigns.project_id->projects,manufacturing_operations.campaign_id->campaigns,test_sessions.campaign_id->campaigns"

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
# audit_log_actors (the actor side-table of the log itself), short_ids (the short-ID registry:
# write-once bookkeeping written only by claim_short_id()), test_code_counters (test-code number
# bookkeeping written only by next_test_code_number()), file_fingerprints (derived data: content
# hashes of directus_files rows, written only by scripts/file_fingerprints.py and recomputable at
# any time, so an audit row would record nothing a re-run cannot). Migration 141's backup of Directus
# permission rows lives in the private schema d1_private, so this public-schema check never sees it.
AUDIT_EXCLUDED="'audit_logs','audit_log_actors','schema_migrations','project_rollup','semantic_embeddings','force_crawler_state','short_ids','test_code_counters','file_fingerprints'"
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
# The trigger fills operation_sequence (max+1 per sample) and builds the code from the rule (T0b, migration 157).
# An old client's {seq} / {mf} placeholder code counts as automatic, so the operations below carry the
# fields their code is built from. Rolled-back transaction first: the numbers a new heat-treatment,
# deformation and additive operation get, a supplied number being kept, and a typed code kept.
seq_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000000-0000-4000-8000-000000000401', 'T-I-HT', 'stream I test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000411', 'TI-S1');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000000-0000-4000-8000-000000000412', 'TI-S2');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, ht_treatment_type, ht_peak_temp_celsius, ht_hold_time_min, ht_cooling_method, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000421', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'heat_treatment', 'anneal', 800, 60, 'air', 'TI-S1-HTA{seq}-800C_60min_AC');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, deform_deformation_type, deform_deformation_temp_celsius, deform_total_reduction_pct, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000422', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'deformation', 'rolling', 20, 50, 'TI-S1-DR{seq}-20C_50pct');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, am_laser_power_w, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000423', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'additive', 200, 'TI-S1-AM{seq}-200W');
-- a machining pass number the user typed is kept, and the next blank one continues after it
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000424', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'machining', 9, 'TI-S1-F9-20MPM');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, ht_treatment_type, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000425', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000411', 'heat_treatment', 'solution_treat', 'TI-S1-HTS{seq}');
-- numbering is per sample, and a typed override without a placeholder is stored as given
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, ht_treatment_type, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000426', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'heat_treatment', 'anneal', 'TI-S2-HTA{seq}');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000427', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'heat_treatment', 'MY-OWN-CODE');
-- no sample: the sequence stays NULL; a typed code is stored as given
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000428', 'c0000000-0000-4000-8000-000000000401', 'heat_treatment', 'test', 'TI-NOSAMPLE-X');
-- an imported row (source_system set) keeps a NULL sequence even with a sample; a later explicit
-- number is kept, so the importer's own numbering cannot collide with an auto-assigned one
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000429', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'sintering', 'test', 'TI-IMP-FAST');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, source_system, operation_sequence, pass_code)
VALUES ('c0000000-0000-4000-8000-00000000042a', 'c0000000-0000-4000-8000-000000000401', 'c0000000-0000-4000-8000-000000000412', 'machining', 'test', 1, 'TI-IMP-F1');
SELECT 'op:' || substr(operation_id::text, 33) || ':' || COALESCE(operation_sequence::text, 'null') || ':' || pass_code
FROM manufacturing_operations WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-0000000004_%' ORDER BY operation_id;

-- sintering "MF" counter: max+1 over live codes, not count+1
SELECT COALESCE(max((substring(pass_code FROM '(?:^|-)MF(\d{1,9})(?:-|$)'))::bigint), 0) AS mfbase
FROM manufacturing_operations WHERE process_category = 'sintering' \gset
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
VALUES ('c0000000-0000-4000-8000-000000000431', 'c0000000-0000-4000-8000-000000000401', 'sintering', 'test', '01-01-26-MF' || (:mfbase + 5) || '-950C');
SELECT 'mf_explicit:' || (:mfbase + 5);
SELECT 'mf:' || substr(operation_id::text, 33) || ':' || pass_code FROM manufacturing_operations
WHERE operation_id::text LIKE 'c0000000-0000-4000-8000-00000000043_' ORDER BY operation_id;
-- an old client's regenerate (a {seq} placeholder code) gets the rule's code, never a raw placeholder
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
seq_check "op:0428:null:TI-NOSAMPLE-X" "an operation without a sample keeps a NULL sequence and a typed code"
mf_exp=$(grep -m1 '^mf_explicit:' <<<"$seq_out" | cut -d: -f2)
seq_check "op:0429:null:TI-IMP-FAST" "an imported row (source_system set) is not auto-numbered, even with a sample"
seq_check "op:042a:1:TI-IMP-F1" "an imported row's explicit number is kept"
seq_check "mf:0431:01-01-26-MF${mf_exp}-950C" "an explicit MF number is stored as given"
seq_check "regen:TI-S1-HTA1-800C_60min_AC:1" "regenerating with an old client's {seq} placeholder code gives the rule's code, never a raw placeholder"

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
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, ht_treatment_type, pass_code)
VALUES ('c0000000-0000-4000-8000-0000000004$1', 'c0000000-0000-4000-8000-000000000402',
        'c0000000-0000-4000-8000-000000000413', 'heat_treatment', 'anneal', '$2')
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

# Bulk load: the per-sample lock must not use the shared lock table (advisory locks do, and
# ~13,000 samples in one transaction ran out of it). 400 samples, one operation each, one
# transaction: no per-sample advisory lock is held at the end, and each sample's number is 1.
bulk_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code)
SELECT ('c0000000-0000-4000-8001-' || lpad(g::text, 12, '0'))::uuid, 'TI-BULK-' || g FROM generate_series(1, 400) g;
INSERT INTO manufacturing_operations (method_id, sample_id, process_category, ht_treatment_type, pass_code)
SELECT 'c0000000-0000-4000-8000-000000000402', sample_id, 'heat_treatment', 'anneal', 'TI-BULK-HTA{seq}'
FROM physical_samples WHERE sample_code LIKE 'TI-BULK-%';
SELECT 'bulk_ops:' || count(*) || ':' || min(operation_sequence) || ':' || max(operation_sequence)
FROM manufacturing_operations WHERE pass_code ~ '^TI-BULK-[0-9]+-HTA1$';
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
# placeholder hits the CHECK; one implicit transaction per -c, so nothing is left behind. The
# short_id is supplied by hand because the short-ID trigger is bypassed too (it is NOT NULL).
ph_o=$($PSQL -q 2>&1 -c "SET LOCAL session_replication_role = replica;
INSERT INTO manufacturing_operations (short_id, method_id, process_category, source_system, pass_code)
VALUES ('5ba0d0ff', (SELECT method_id FROM manufacturing_methods LIMIT 1), 'sintering', 'test', '05-01-26-MF{mf}')")
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

-- of two samples linked in turn, the first linked (it also has the lower junction id) stays primary
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000001c2', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-0000000001c2', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a1');
SELECT 'lowest_id:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c2';

-- the earliest LINKED subject is the primary, even when a later one has a lower junction id
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-0000000001c9');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-0000000000ff', 'c0000000-0000-4000-8000-0000000001c9', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000001c9', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a1');
SELECT 'earliest:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c9';

-- rows with EQUAL linked_at (e.g. linked before the column existed) fall back to junction id order
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-0000000001c8');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item, linked_at)
VALUES ('00000000-0000-4000-8000-0000000000e9', 'c0000000-0000-4000-8000-0000000001c8', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a1', '-infinity');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item, linked_at)
VALUES ('00000000-0000-4000-8000-0000000000e8', 'c0000000-0000-4000-8000-0000000001c8', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2', '-infinity');
SELECT 'tie_id_order:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c8';

-- new junction rows are stamped with the wall-clock time they are linked
SELECT 'linked_at_default:' || pg_get_expr(d.adbin, d.adrelid)
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'test_sessions_subject'::regclass AND a.attname = 'linked_at';
SELECT 'linked_at_field:' || hidden || '/' || readonly
  FROM directus_fields WHERE collection = 'test_sessions_subject' AND field = 'linked_at';

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
ps_check "lowest_id:true" "of two subjects linked in turn, the first linked is the primary"
ps_check "earliest:true" "the earliest linked subject stays primary when a later one has a lower junction id"
ps_check "tie_id_order:true" "subjects with an equal linked_at fall back to junction id order (the pre-migration rule)"
ps_check "linked_at_default:clock_timestamp()" "new junction rows are stamped with clock_timestamp() by default"
ps_check "linked_at_field:true/true" "linked_at is registered hidden and read-only in Directus"
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

echo "== Short IDs: permanent, unique across samples, operations and tests (T0a) =="
# The three fixture ids share their first 8 hex characters, so the second and third must be
# lengthened. Everything is rolled back. (Prefix 5d000000: earlier sections commit c0000000- fixtures, whose registry rows stay.)
sid_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('5d000000-0000-4000-8000-000000000201', 'TEST-SID-001');
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('5d000000-0000-4000-8000-000000000205', 'T-SID-M', 'short id test method');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code)
VALUES ('5d000000-0000-4000-8000-000000000202', '5d000000-0000-4000-8000-000000000205', '5d000000-0000-4000-8000-000000000201', 'TEST-SID-OP');
INSERT INTO test_sessions (session_id) VALUES ('5d000000-0000-4000-8000-000000000203');
SELECT 'sample:' || short_id FROM physical_samples WHERE sample_id = '5d000000-0000-4000-8000-000000000201';
SELECT 'operation:' || short_id FROM manufacturing_operations WHERE operation_id = '5d000000-0000-4000-8000-000000000202';
SELECT 'test:' || short_id FROM test_sessions WHERE session_id = '5d000000-0000-4000-8000-000000000203';
SELECT 'lookup:' || collection || '/' || record_id FROM record_by_short_id('5D0000000');
DO $$ BEGIN
  UPDATE physical_samples SET short_id = 'deadbeef' WHERE sample_id = '5d000000-0000-4000-8000-000000000201';
  RAISE NOTICE 'guard:missing';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'guard:ok';
END $$;
SELECT 'samecode:' || short_id FROM physical_samples WHERE sample_id = '5d000000-0000-4000-8000-000000000201';
UPDATE physical_samples SET nickname = 'renamed' WHERE sample_id = '5d000000-0000-4000-8000-000000000201';
SELECT 'other_update:' || short_id FROM physical_samples WHERE sample_id = '5d000000-0000-4000-8000-000000000201';
DELETE FROM test_sessions WHERE session_id = '5d000000-0000-4000-8000-000000000203';
SELECT 'deleted_lookup:' || count(*) FROM record_by_short_id('5d00000000');
SELECT 'registry_kept:' || count(*) FROM short_ids WHERE short_id = '5d00000000';
INSERT INTO test_sessions (session_id) VALUES ('5d000000-0000-4000-8000-000000000204');
SELECT 'no_reuse:' || short_id FROM test_sessions WHERE session_id = '5d000000-0000-4000-8000-000000000204';
SELECT 'not_null:' || count(*) FROM information_schema.columns
  WHERE column_name = 'short_id' AND is_nullable = 'NO'
    AND table_name IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
SELECT 'directus_rows:' || count(*) FROM directus_fields
  WHERE field = 'short_id' AND readonly
    AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
SELECT 'comments:' || count(*) FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
  WHERE c.relname = 'short_ids' AND d.objsubid = 0;
ROLLBACK;
SQL
)
sid_check() { grep -q -- "$1" <<<"$sid_out" && ok "$2" || bad "$2 (psql output: $sid_out)"; }
sid_check "sample:5d000000$" "a new sample gets the first 8 hex characters of its id"
sid_check "operation:5d0000000$" "an operation whose 8 characters are taken by a sample gets 9"
sid_check "test:5d00000000$" "a test whose 8 and 9 characters are taken gets 10"
sid_check "lookup:manufacturing_operations/5d000000-0000-4000-8000-000000000202" "record_by_short_id finds the record (case-insensitive)"
sid_check "guard:ok" "changing a short_id is refused"
sid_check "samecode:5d000000$" "a refused change leaves the short_id as it was"
sid_check "other_update:5d000000$" "other updates keep the short_id"
sid_check "deleted_lookup:0" "a deleted record's short ID resolves to nothing"
sid_check "registry_kept:1" "a deleted record's short ID stays reserved"
sid_check "no_reuse:5d000000000$" "a reserved short ID is never handed out again"
sid_check "not_null:3" "short_id is NOT NULL on the three tables"
sid_check "directus_rows:3" "the three short_id fields are registered read-only in Directus"
sid_check "comments:1" "short_ids carries a table comment"
run_eq "short_id has a column default on the three tables (Directus demands a NOT NULL column without one)" \
    "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'short_id' AND column_default IS NOT NULL AND table_name IN ('physical_samples', 'manufacturing_operations', 'test_sessions')" \
    "3"
run_eq "the short_id format CHECKs exist and are validated on the three tables (so the empty default can never be stored)" \
    "SELECT count(*) FROM pg_constraint WHERE conname IN ('physical_samples_short_id_format_check', 'manufacturing_operations_short_id_format_check', 'test_sessions_short_id_format_check') AND convalidated" \
    "3"
# With the short-ID triggers bypassed (session_replication_role = replica) an insert that omits short_id
# would store the '' column default; the format CHECK must refuse it. Rolled back.
fmt_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('5d000000-0000-4000-8000-000000000215', 'T-FMT-M', 'short id format test method');
DO $$ BEGIN
  INSERT INTO physical_samples (sample_id, sample_code) VALUES ('5d000000-0000-4000-8000-000000000211', 'TEST-FMT-001');
  RAISE NOTICE 'fmt_sample:missing';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'fmt_sample:ok';
END $$;
DO $$ BEGIN
  INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, pass_code)
  VALUES ('5d000000-0000-4000-8000-000000000212', '5d000000-0000-4000-8000-000000000215', 'sintering', 'test', 'TEST-FMT-OP');
  RAISE NOTICE 'fmt_operation:missing';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'fmt_operation:ok';
END $$;
DO $$ BEGIN
  INSERT INTO test_sessions (session_id) VALUES ('5d000000-0000-4000-8000-000000000213');
  RAISE NOTICE 'fmt_test:missing';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'fmt_test:ok';
END $$;
ROLLBACK;
SQL
)
fmt_check() { grep -q -- "$1" <<<"$fmt_out" && ok "$2" || bad "$2 (psql output: $fmt_out)"; }
fmt_check "fmt_sample:ok" "a sample inserted without a short_id (trigger bypassed) is refused by the format CHECK"
fmt_check "fmt_operation:ok" "an operation inserted without a short_id (trigger bypassed) is refused by the format CHECK"
fmt_check "fmt_test:ok" "a test inserted without a short_id (trigger bypassed) is refused by the format CHECK"

echo "== Short IDs: the back-fill (T0a) =="
# Runs the real back-fill SQL, extracted from migration 150 between its backfill:start / backfill:end
# markers, on rows made to look like pre-migration data (short_id NULL, no registry row), inside
# a rolled-back transaction. The three user-trigger sets are bypassed for the setup and must be
# back to enabled ('O') afterwards. The guard is run on its own, on a trigger set to ENABLE ALWAYS.
SID_MIG=db/migrations/20261010000150_short_ids.sql
sid_backfill=$(awk '/^-- backfill:start/{f=1;next}/^-- backfill:end/{f=0}f' "$SID_MIG")
sid_guard=$(printf '%s\n' "$sid_backfill" | awk '/^DO \$\$/{f=1} f{print} f && /^END \$\$;/{exit}')
[[ -n "$sid_backfill" && -n "$sid_guard" ]] && ok "found the short-ID back-fill and its guard in the migration" \
    || bad "could not extract the short-ID back-fill / guard from $SID_MIG"
bf_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('6b000000-0000-4000-8000-000000000301', 'TEST-SBF-001');
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('6b000000-0000-4000-8000-000000000305', 'T-SBF-M', 'short id back-fill test method');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code)
VALUES ('6b000000-0000-4000-8000-000000000302', '6b000000-0000-4000-8000-000000000305', '6b000000-0000-4000-8000-000000000301', 'TEST-SBF-OP');
INSERT INTO test_sessions (session_id) VALUES ('6b000000-0000-4000-8000-000000000303');
-- make them look like pre-migration rows: no short_id, no registry row, a recorded version
ALTER TABLE physical_samples ALTER COLUMN short_id DROP NOT NULL;
ALTER TABLE manufacturing_operations ALTER COLUMN short_id DROP NOT NULL;
ALTER TABLE test_sessions ALTER COLUMN short_id DROP NOT NULL;
ALTER TABLE physical_samples DISABLE TRIGGER USER;
ALTER TABLE manufacturing_operations DISABLE TRIGGER USER;
ALTER TABLE test_sessions DISABLE TRIGGER USER;
UPDATE physical_samples SET short_id = NULL, version = 7 WHERE sample_id = '6b000000-0000-4000-8000-000000000301';
UPDATE manufacturing_operations SET short_id = NULL, version = 5 WHERE operation_id = '6b000000-0000-4000-8000-000000000302';
UPDATE test_sessions SET short_id = NULL, version = 3 WHERE session_id = '6b000000-0000-4000-8000-000000000303';
DELETE FROM short_ids WHERE record_id IN ('6b000000-0000-4000-8000-000000000301',
    '6b000000-0000-4000-8000-000000000302', '6b000000-0000-4000-8000-000000000303');
ALTER TABLE physical_samples ENABLE TRIGGER USER;
ALTER TABLE manufacturing_operations ENABLE TRIGGER USER;
ALTER TABLE test_sessions ENABLE TRIGGER USER;
SELECT (SELECT sum(version) FROM physical_samples) + (SELECT sum(version) FROM manufacturing_operations)
     + (SELECT sum(version) FROM test_sessions) AS vsum \gset
SELECT COALESCE(max(log_id), 0) AS lid FROM audit_logs \gset
SELECT 'bf_setup:' || count(*) FROM (
    SELECT short_id FROM physical_samples WHERE sample_id = '6b000000-0000-4000-8000-000000000301'
    UNION ALL SELECT short_id FROM manufacturing_operations WHERE operation_id = '6b000000-0000-4000-8000-000000000302'
    UNION ALL SELECT short_id FROM test_sessions WHERE session_id = '6b000000-0000-4000-8000-000000000303') x
  WHERE short_id IS NULL;

-- the guard refuses a trigger that is not in its normal state (here ENABLE ALWAYS), and the
-- failed statement leaves it untouched
SAVEPOINT guard_test;
ALTER TABLE test_sessions ENABLE ALWAYS TRIGGER test_sessions_set_code;
$sid_guard
ROLLBACK TO guard_test;

-- the real back-fill
$sid_backfill

SELECT 'bf_short:' || (SELECT short_id FROM physical_samples WHERE sample_id = '6b000000-0000-4000-8000-000000000301')
    || '/' || (SELECT short_id FROM manufacturing_operations WHERE operation_id = '6b000000-0000-4000-8000-000000000302')
    || '/' || (SELECT short_id FROM test_sessions WHERE session_id = '6b000000-0000-4000-8000-000000000303');
SELECT 'bf_versions:' || (SELECT version FROM physical_samples WHERE sample_id = '6b000000-0000-4000-8000-000000000301')
    || '/' || (SELECT version FROM manufacturing_operations WHERE operation_id = '6b000000-0000-4000-8000-000000000302')
    || '/' || (SELECT version FROM test_sessions WHERE session_id = '6b000000-0000-4000-8000-000000000303');
SELECT 'bf_vsum:' || ((SELECT sum(version) FROM physical_samples) + (SELECT sum(version) FROM manufacturing_operations)
     + (SELECT sum(version) FROM test_sessions) = :vsum);
SELECT 'bf_audit:' || count(*) FROM audit_logs
  WHERE log_id > :lid AND table_name IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
SELECT 'bf_nulls:' || (SELECT count(*) FROM physical_samples WHERE short_id IS NULL)
    || '/' || (SELECT count(*) FROM manufacturing_operations WHERE short_id IS NULL)
    || '/' || (SELECT count(*) FROM test_sessions WHERE short_id IS NULL);
SELECT 'bf_registry:' || count(*) FROM short_ids
  WHERE record_id IN ('6b000000-0000-4000-8000-000000000301', '6b000000-0000-4000-8000-000000000302', '6b000000-0000-4000-8000-000000000303');
SELECT 'bf_triggers:' || count(*) FILTER (WHERE tgenabled <> 'O') || '/' || count(*) FROM pg_trigger
  WHERE NOT tgisinternal
    AND tgrelid IN ('physical_samples'::regclass, 'manufacturing_operations'::regclass, 'test_sessions'::regclass);
ROLLBACK;
SQL
)
bf_check() { grep -q -- "$1" <<<"$bf_out" && ok "$2" || bad "$2 (psql output: $bf_out)"; }
bf_check "bf_setup:3$" "(setup) the three rows have no short_id before the back-fill"
bf_check "is not enabled in its normal state" "the back-fill guard refuses a user trigger that is ENABLE ALWAYS"
bf_check "bf_short:6b000000/6b0000000/6b00000000$" "the back-fill assigns short IDs, lengthening on a clash across the three tables"
bf_check "bf_versions:7/5/3$" "the back-fill leaves each version as it was"
bf_check "bf_vsum:true$" "the back-fill changes no version in the three tables"
bf_check "bf_audit:0$" "the back-fill writes no audit rows"
bf_check "bf_nulls:0/0/0$" "no row is left without a short_id"
bf_check "bf_registry:3$" "the back-fill registers the three short IDs"
bf_check "bf_triggers:0/" "every user trigger on the three tables is enabled again after the back-fill"
echo "== Test codes: built from the earliest subject and the type, kept up to date (T0a) =="
tc_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('7e000000-0000-4000-8000-000000000211', 'TEST-TC-001'),
    ('7e000000-0000-4000-8000-000000000212', 'TEST-TC-002');
INSERT INTO people (person_id, full_name) VALUES ('7e000000-0000-4000-8000-000000000213', 'Test Code Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('7e000000-0000-4000-8000-000000000214', 'TEST-TC-BOX', '7e000000-0000-4000-8000-000000000213');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('7e000000-0000-4000-8000-000000000215', 'TEST-TC-BOX-1', '7e000000-0000-4000-8000-000000000214');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier)
VALUES ('7e000000-0000-4000-8000-000000000216', 'TEST-TC-BOX-1A', '7e000000-0000-4000-8000-000000000215', 'A');
INSERT INTO test_sessions (session_id, test_type) VALUES
    ('7e000000-0000-4000-8000-000000000221', 'sem'),
    ('7e000000-0000-4000-8000-000000000222', 'sem'),
    ('7e000000-0000-4000-8000-000000000223', 'sem'),
    ('7e000000-0000-4000-8000-000000000224', 'hardness'),
    ('7e000000-0000-4000-8000-000000000226', 'sem'),
    ('7e000000-0000-4000-8000-000000000228', NULL);
INSERT INTO test_sessions (session_id, test_type, test_code)
VALUES ('7e000000-0000-4000-8000-000000000225', 'sem', '  TEST-TC-001-SEM4 ');
CREATE TEMP VIEW tc AS SELECT session_id, coalesce(test_code, 'null') AS code, test_code_is_manual AS manual FROM test_sessions;

SELECT 'nocode:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000221', 'physical_samples', '7e000000-0000-4000-8000-000000000211');
SELECT 'first:' || code || '/' || manual FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000221', 'physical_samples', '7e000000-0000-4000-8000-000000000212');
SELECT 'second:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000222', 'physical_samples', '7e000000-0000-4000-8000-000000000211');
SELECT 'next:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_code = test_code WHERE session_id = '7e000000-0000-4000-8000-000000000222';
SELECT 'resave:' || code || '/' || manual FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_type = 'xrd' WHERE session_id = '7e000000-0000-4000-8000-000000000221';
SELECT 'type:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000223', 'physical_samples', '7e000000-0000-4000-8000-000000000211');
SELECT 'noreuse:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000223';
UPDATE test_sessions SET test_code = 'MY-CODE' WHERE session_id = '7e000000-0000-4000-8000-000000000222';
SELECT 'typed:' || code || '/' || manual FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_type = 'tem' WHERE session_id = '7e000000-0000-4000-8000-000000000222';
SELECT 'typed_kept:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_code = NULL WHERE session_id = '7e000000-0000-4000-8000-000000000222';
SELECT 'cleared:' || code || '/' || manual FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000222';
SELECT 'typed_insert:' || code || '/' || manual FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000225';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000226', 'physical_samples', '7e000000-0000-4000-8000-000000000211');
SELECT 'skip_taken:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000226';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000224', 'insert_edges', '7e000000-0000-4000-8000-000000000216');
SELECT 'edge:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000224';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000224', 'physical_samples', '7e000000-0000-4000-8000-000000000211');
SELECT 'edge_kept:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000224';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000228', 'physical_samples', 'not-a-uuid');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000228', 'physical_samples', '7E000000-0000-4000-8000-000000000211');
SELECT 'notype:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000228';
UPDATE test_sessions SET test_type = 'dma' WHERE session_id = '7e000000-0000-4000-8000-000000000228';
SELECT 'type_arrives:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000228';
SELECT 'junk_subject:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000228';
UPDATE physical_samples SET sample_code = 'TEST-TC-001B' WHERE sample_id = '7e000000-0000-4000-8000-000000000211';
SELECT 'cascade:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000223';
SELECT 'cascade_typed:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000225';
SELECT 'cascade_edge_test:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000224';
UPDATE insert_edges SET edge_code = 'TEST-TC-BOX-1Z' WHERE edge_id = '7e000000-0000-4000-8000-000000000216';
SELECT 'cascade_edge:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000224';
DELETE FROM test_sessions_subject
  WHERE test_sessions_id = '7e000000-0000-4000-8000-000000000221' AND item = '7e000000-0000-4000-8000-000000000211';
SELECT 'promoted:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000221';
DELETE FROM test_sessions_subject WHERE test_sessions_id = '7e000000-0000-4000-8000-000000000221';
SELECT 'orphan:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000221';
DO $$ BEGIN
  INSERT INTO test_sessions (session_id, test_code) VALUES ('7e000000-0000-4000-8000-000000000229', 'TEST-TC-001B-SEM3');
  RAISE NOTICE 'unique:missing';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'unique:ok';
END $$;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('7e000000-0000-4000-8000-000000000231', 'TEST-TC-ORP'),
    ('7e000000-0000-4000-8000-000000000232', 'TEST-TC-NUL');
INSERT INTO test_sessions (session_id, test_type) VALUES
    ('7e000000-0000-4000-8000-000000000241', 'sem'),
    ('7e000000-0000-4000-8000-000000000242', 'sem');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES
    ('7e000000-0000-4000-8000-000000000241', 'physical_samples', '7e000000-0000-4000-8000-000000000231'),
    ('7e000000-0000-4000-8000-000000000242', 'physical_samples', '7e000000-0000-4000-8000-000000000232');
DELETE FROM test_sessions_subject WHERE test_sessions_id = '7e000000-0000-4000-8000-000000000241';
UPDATE test_sessions SET test_type = NULL WHERE session_id = '7e000000-0000-4000-8000-000000000242';
UPDATE physical_samples SET sample_code = 'TEST-TC-ORP2' WHERE sample_id = '7e000000-0000-4000-8000-000000000231';
UPDATE physical_samples SET sample_code = 'TEST-TC-NUL2' WHERE sample_id = '7e000000-0000-4000-8000-000000000232';
SELECT 'orphan_rename:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000241';
SELECT 'notype_rename:' || code FROM tc WHERE session_id = '7e000000-0000-4000-8000-000000000242';
SELECT 'directus:' || count(*) FROM directus_fields WHERE collection = 'test_sessions'
  AND field IN ('test_code', 'test_code_number', 'test_code_type', 'test_code_is_manual',
                'test_code_subject_collection', 'test_code_subject_id');
SELECT 'directus_visible:' || count(*) FROM directus_fields WHERE collection = 'test_sessions' AND field = 'test_code' AND NOT hidden;
ROLLBACK;
SQL
)
tc_check() { grep -q -- "$1" <<<"$tc_out" && ok "$2" || bad "$2 (psql output: $tc_out)"; }
tc_check "nocode:null$" "a test with no subject has no code"
tc_check "first:TEST-TC-001-SEM1/false$" "linking the first subject gives {sample code}-{TYPE}1, automatic"
tc_check "second:TEST-TC-001-SEM1$" "linking a second subject changes nothing"
tc_check "next:TEST-TC-001-SEM2$" "the next SEM test on the sample gets 2"
tc_check "resave:TEST-TC-001-SEM2/false$" "re-saving the same code keeps it automatic"
tc_check "type:TEST-TC-001-XRD1$" "a type change takes the next number of the new type"
tc_check "noreuse:TEST-TC-001-SEM3$" "a number that moved away is not handed out again"
tc_check "typed:MY-CODE/true$" "a typed code is kept and flagged as typed"
tc_check "typed_kept:MY-CODE$" "a typed code survives a type change"
tc_check "cleared:TEST-TC-001-TEM1/false$" "clearing a typed code goes back to automatic with the current type"
tc_check "typed_insert:TEST-TC-001-SEM4/true$" "a code given on insert is typed (and trimmed)"
tc_check "skip_taken:TEST-TC-001-SEM5$" "an automatic code skips a number someone typed by hand"
tc_check "edge:TEST-TC-BOX-1A-HRD1$" "an insert-edge subject uses the edge code"
tc_check "edge_kept:TEST-TC-BOX-1A-HRD1$" "adding a sample to an edge test keeps the edge-based code"
tc_check "notype:null$" "a test with a subject but no type has no code"
tc_check "type_arrives:TEST-TC-001-DMA1$" "setting the type gives the code (upper-case junction item accepted)"
tc_check "junk_subject:TEST-TC-001-DMA1$" "a junk junction item linked earlier is skipped when building the code"
tc_check "cascade:TEST-TC-001B-SEM3$" "a corrected sample code flows into its tests' automatic codes"
tc_check "cascade_typed:TEST-TC-001-SEM4$" "a typed code ignores a sample code change"
tc_check "cascade_edge_test:TEST-TC-BOX-1A-HRD1$" "a sample code change leaves an edge-based code alone"
tc_check "cascade_edge:TEST-TC-BOX-1Z-HRD1$" "a corrected edge code flows into its tests"
tc_check "promoted:TEST-TC-002-XRD1$" "removing the code's subject re-codes the test from the next subject"
tc_check "orphan:TEST-TC-002-XRD1$" "a test that loses all its subjects keeps its last code"
tc_check "unique:ok" "test codes are unique"
tc_check "directus:6$" "the six test-code fields are registered in Directus"
tc_check "directus_visible:1$" "only test_code is visible on the form"
tc_check "orphan_rename:TEST-TC-ORP-SEM1$" "renaming the old subject of an orphaned test keeps its code"
tc_check "notype_rename:TEST-TC-NUL-SEM1$" "renaming the subject of a test whose type was cleared keeps its code"

echo "== Test codes: client-supplied bookkeeping is ignored; a taken rebuilt code draws a new number (T0a) =="
# A clone (Directus "Save as copy") carries the source test's test_code_* columns; they must not
# decide the copy's code. Each risky step is in a DO block that reports instead of aborting, so a
# regression shows up as a failed check, not a dead transaction. Rolled back.
cg_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('7e000000-0000-4000-8000-000000000251', 'TEST-CG-001'),
    ('7e000000-0000-4000-8000-000000000253', 'TEST-CG-003');
INSERT INTO test_sessions (session_id, test_type) VALUES ('7e000000-0000-4000-8000-000000000261', 'sem');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000261', 'physical_samples', '7e000000-0000-4000-8000-000000000251');
SELECT 'cg_source:' || test_code || '/' || test_code_number FROM test_sessions WHERE session_id = '7e000000-0000-4000-8000-000000000261';

-- (a) a copy that carries the source's bookkeeping but no code gets the next free number
DO $$
DECLARE v TEXT;
BEGIN
  INSERT INTO test_sessions (session_id, test_type, test_code_number, test_code_type,
                             test_code_subject_collection, test_code_subject_id)
  VALUES ('7e000000-0000-4000-8000-000000000262', 'sem', 1, 'sem', 'physical_samples',
          '7e000000-0000-4000-8000-000000000251');
  INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
  VALUES ('7e000000-0000-4000-8000-000000000262', 'physical_samples', '7e000000-0000-4000-8000-000000000251');
  SELECT test_code INTO v FROM test_sessions WHERE session_id = '7e000000-0000-4000-8000-000000000262';
  RAISE NOTICE 'copy_nocode:%', v;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'copy_nocode:unique_violation';
END $$;

-- (b) a copy that also carries the source's code is still refused as a duplicate
DO $$
BEGIN
  INSERT INTO test_sessions (session_id, test_type, test_code, test_code_number, test_code_type,
                             test_code_subject_collection, test_code_subject_id)
  VALUES ('7e000000-0000-4000-8000-000000000263', 'sem', 'TEST-CG-001-SEM1', 1, 'sem', 'physical_samples',
          '7e000000-0000-4000-8000-000000000251');
  RAISE NOTICE 'copy_unique:missing';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'copy_unique:ok';
END $$;

-- (c) an UPDATE cannot change the bookkeeping columns
UPDATE test_sessions SET test_code_number = 9, test_code_type = 'tem', test_code_subject_collection = 'insert_edges',
       test_code_subject_id = '7e000000-0000-4000-8000-000000000253'
 WHERE session_id = '7e000000-0000-4000-8000-000000000261';
SELECT 'bookkeeping_ignored:' || test_code || '/' || test_code_number || '/' || test_code_type || '/'
    || test_code_subject_collection || '/' || (test_code_subject_id = '7e000000-0000-4000-8000-000000000251')
  FROM test_sessions WHERE session_id = '7e000000-0000-4000-8000-000000000261';

-- (d) renaming a subject to a name whose next code is taken (typed by hand on another test)
-- draws the next number instead of failing on UNIQUE
INSERT INTO test_sessions (session_id, test_type) VALUES ('7e000000-0000-4000-8000-000000000264', 'sem');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('7e000000-0000-4000-8000-000000000264', 'physical_samples', '7e000000-0000-4000-8000-000000000253');
INSERT INTO test_sessions (session_id, test_type, test_code)
VALUES ('7e000000-0000-4000-8000-000000000265', 'sem', 'TEST-CG-004-SEM1');
SELECT 'rename_before:' || test_code FROM test_sessions WHERE session_id = '7e000000-0000-4000-8000-000000000264';
DO $$
DECLARE v TEXT;
BEGIN
  UPDATE physical_samples SET sample_code = 'TEST-CG-004' WHERE sample_id = '7e000000-0000-4000-8000-000000000253';
  SELECT test_code INTO v FROM test_sessions WHERE session_id = '7e000000-0000-4000-8000-000000000264';
  RAISE NOTICE 'rename_taken:%', v;
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'rename_taken:unique_violation';
END $$;
ROLLBACK;
SQL
)
cg_check() { grep -q -- "$1" <<<"$cg_out" && ok "$2" || bad "$2 (psql output: $cg_out)"; }
cg_check "cg_source:TEST-CG-001-SEM1/1$" "(setup) the source test is TEST-CG-001-SEM1, number 1"
cg_check "copy_nocode:TEST-CG-001-SEM2$" "a copy carrying the source's bookkeeping but no code gets the next free number"
cg_check "copy_unique:ok" "a copy carrying the source's code is refused as a duplicate"
cg_check "bookkeeping_ignored:TEST-CG-001-SEM1/1/sem/physical_samples/true$" "an UPDATE of the test_code_* bookkeeping columns is ignored"
cg_check "rename_before:TEST-CG-003-SEM1$" "(setup) the renamed sample's test starts as TEST-CG-003-SEM1"
cg_check "rename_taken:TEST-CG-004-SEM2$" "renaming a subject to a name whose rebuilt code is taken draws the next number"

echo "== Test codes: a subject written directly on the test is coded too (T0a follow-up) =="
# Directus "Save as copy" copies the hidden derived sample_id, an importer may set sample_id or
# insert_edge_id: the junction insert that follows then derives the same primary, the sync's UPDATE
# is a no-op and the BEFORE trigger never runs again. The trigger therefore falls back to the
# directly written columns when the junction has no subject yet. Rolled back.
fb_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('8c000000-0000-4000-8000-000000000011', 'TEST-FB-001'),
    ('8c000000-0000-4000-8000-000000000012', 'TEST-FB-002');
INSERT INTO people (person_id, full_name) VALUES ('8c000000-0000-4000-8000-000000000013', 'Fallback Code Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('8c000000-0000-4000-8000-000000000014', 'TEST-FB-BOX', '8c000000-0000-4000-8000-000000000013');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('8c000000-0000-4000-8000-000000000015', 'TEST-FB-BOX-1', '8c000000-0000-4000-8000-000000000014');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier)
VALUES ('8c000000-0000-4000-8000-000000000016', 'TEST-FB-BOX-1A', '8c000000-0000-4000-8000-000000000015', 'A');
CREATE TEMP VIEW fb AS SELECT session_id, coalesce(test_code, 'null') AS code FROM test_sessions;

-- (a) a test written with sample_id and no junction row is coded at INSERT
INSERT INTO test_sessions (session_id, test_type, sample_id)
VALUES ('8c000000-0000-4000-8000-000000000021', 'sem', '8c000000-0000-4000-8000-000000000011');
SELECT 'fb_direct:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000021';
-- (b) the junction row that follows (same primary, the sync is a no-op) leaves the code alone
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('8c000000-0000-4000-8000-000000000021', 'physical_samples', '8c000000-0000-4000-8000-000000000011');
SELECT 'fb_junction_after:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000021';
-- (c) a "Save as copy": sample_id and the source's bookkeeping carried, no code; then the junction
INSERT INTO test_sessions (session_id, test_type, sample_id, test_code_number, test_code_type,
                           test_code_subject_collection, test_code_subject_id)
VALUES ('8c000000-0000-4000-8000-000000000022', 'sem', '8c000000-0000-4000-8000-000000000011',
        1, 'sem', 'physical_samples', '8c000000-0000-4000-8000-000000000011');
SELECT 'fb_clone:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000022';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('8c000000-0000-4000-8000-000000000022', 'physical_samples', '8c000000-0000-4000-8000-000000000011');
SELECT 'fb_clone_junction:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000022';
-- (d) an insert-edge subject written directly
INSERT INTO test_sessions (session_id, test_type, insert_edge_id)
VALUES ('8c000000-0000-4000-8000-000000000023', 'hardness', '8c000000-0000-4000-8000-000000000016');
SELECT 'fb_edge:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000023';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('8c000000-0000-4000-8000-000000000023', 'insert_edges', '8c000000-0000-4000-8000-000000000016');
SELECT 'fb_edge_junction:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000023';
-- (e) no type yet: no code; the type arriving gives the code from the direct subject
INSERT INTO test_sessions (session_id, test_type, sample_id)
VALUES ('8c000000-0000-4000-8000-000000000024', NULL, '8c000000-0000-4000-8000-000000000011');
SELECT 'fb_notype:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000024';
UPDATE test_sessions SET test_type = 'dma' WHERE session_id = '8c000000-0000-4000-8000-000000000024';
SELECT 'fb_type_arrives:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000024';
-- (f) a junction-linked test that loses its only subject keeps its code (the sync clears
-- sample_id, so the fallback finds nothing)
INSERT INTO test_sessions (session_id, test_type) VALUES ('8c000000-0000-4000-8000-000000000025', 'sem');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('8c000000-0000-4000-8000-000000000025', 'physical_samples', '8c000000-0000-4000-8000-000000000012');
SELECT 'fb_linked:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000025';
DELETE FROM test_sessions_subject WHERE test_sessions_id = '8c000000-0000-4000-8000-000000000025';
SELECT 'fb_orphan:' || coalesce(test_code, 'null') || '/' || (sample_id IS NULL)
  FROM test_sessions WHERE session_id = '8c000000-0000-4000-8000-000000000025';
-- the cascade on a corrected sample / edge code reaches fallback-coded tests, keeping their numbers
UPDATE physical_samples SET sample_code = 'TEST-FB-001B' WHERE sample_id = '8c000000-0000-4000-8000-000000000011';
SELECT 'fb_cascade:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000021';
SELECT 'fb_cascade_clone:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000022';
UPDATE insert_edges SET edge_code = 'TEST-FB-BOX-1Z' WHERE edge_id = '8c000000-0000-4000-8000-000000000016';
SELECT 'fb_cascade_edge:' || code FROM fb WHERE session_id = '8c000000-0000-4000-8000-000000000023';
ROLLBACK;
SQL
)
fb_check() { grep -qx -- "$1" <<<"$fb_out" && ok "$2" || bad "$2 (psql output: $fb_out)"; }
fb_check "fb_direct:TEST-FB-001-SEM1" "a test written with sample_id and no junction row is coded at INSERT"
fb_check "fb_junction_after:TEST-FB-001-SEM1" "the junction row that follows leaves that code unchanged"
fb_check "fb_clone:TEST-FB-001-SEM2" "a copy carrying sample_id and the source's bookkeeping is coded at INSERT with the next number"
fb_check "fb_clone_junction:TEST-FB-001-SEM2" "the copy's junction row leaves its code unchanged"
fb_check "fb_edge:TEST-FB-BOX-1A-HRD1" "a test written with insert_edge_id and no junction row is coded from the edge"
fb_check "fb_edge_junction:TEST-FB-BOX-1A-HRD1" "the edge test's junction row leaves its code unchanged"
fb_check "fb_notype:null" "a direct subject without a test type gives no code"
fb_check "fb_type_arrives:TEST-FB-001-DMA1" "setting the type then gives the code from the direct subject"
fb_check "fb_linked:TEST-FB-002-SEM1" "a junction-linked test is coded as before"
fb_check "fb_orphan:TEST-FB-002-SEM1/true" "a test that loses its only junction subject keeps its code (the fallback finds nothing)"
fb_check "fb_cascade:TEST-FB-001B-SEM1" "a corrected sample code flows into a fallback-coded test"
fb_check "fb_cascade_clone:TEST-FB-001B-SEM2" "a corrected sample code flows into a copy's fallback code, keeping its number"
fb_check "fb_cascade_edge:TEST-FB-BOX-1Z-HRD1" "a corrected edge code flows into a fallback-coded edge test"

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
rl_check 'rollup_read:{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}' \
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
# 20261010000160 runs after this migration on every database: its backup table is in d1_private too
# (so this migration's down only empties the schema once 160 is down), and it moves this migration's
# snapshot filters onto the current generator's output (no `_some` where Directus rejects it).
SF=db/migrations/20261010000160_lab_member_some_only_where_directus_accepts_it.sql
sf_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$SF")
sf_down=$(awk '/-- migrate:down/{f=1;next}f' "$SF")
# 20261012000161 runs after 160: it rules the additional-operators junctions (its backup is in
# d1_private too, so it goes down first and comes up after 160, as on a real database).
JR=db/migrations/20261012000161_lab_member_additional_operator_rules.sql
jr_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$JR")
jr_down=$(awk '/-- migrate:down/{f=1;next}f' "$JR")
# 20261012000163 (per-user usage scores) also keeps tables in d1_private, and runs after 161: this
# migration's down only empties the schema (and drops it) once 163's down has run too.
UU=db/migrations/20261012000163_user_usage.sql
uu_down=$(awk '/-- migrate:down/{f=1;next}f' "$UU")
# 20261013000170 (pin order, view pins, user_prefs) runs after 163 and adds d1_private.user_prefs, so its
# down goes first, as on a real database.
UP=db/migrations/20261013000170_user_pins_and_prefs.sql
up_down=$(awk '/-- migrate:down/{f=1;next}f' "$UP")
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
-- migration 143 keeps its ledger in d1_private; drop it (rolled back) so 141's down can drop the empty schema
DROP TABLE IF EXISTS d1_private.restore_inline_param_meta_changes;
DROP TABLE IF EXISTS d1_private.operation_sequence_backfill;
CREATE TEMP TABLE _gen AS
  SELECT * FROM json_to_recordset(\$rules\$$rules_json\$rules\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, ruled boolean);
$up_down
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
-- 20261012000164 (label_templates, a custom-rows collection) runs after these and adds its four rows, which are the generated ones
INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
  SELECT collection, action, permissions::json, '{}'::json, fields, '$LM' FROM _gen WHERE collection = 'label_templates';
SELECT 'up_exact:' || count(*) FROM _gen g JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = g.collection AND p.action = g.action AND p.permissions::jsonb = g.permissions
 AND (g.fields = '*' OR p.fields = g.fields) AND (g.validation = '{}'::jsonb OR p.validation::jsonb = g.validation)
 WHERE g.ruled;
-- the replay's own rows for label_templates go before the older migrations' down sections run
DELETE FROM directus_permissions WHERE policy = '$LM' AND collection = 'label_templates';
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
[[ "${n_exact:-0}" -eq "${gen_n:-x}" ]] && ok "up, then 20261010000160: every ruled row matches the generated rules ($n_exact rows)" || bad "up: ruled rows differ from the generated rules (psql output: $rv_out)"
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

echo "== Operation code rule: code_num, operation_code_for, the run number (T0b) =="
# One rolled-back transaction. Rows for operation_code_for are built in memory with jsonb_populate_record.
# CI has no FCT HP D machines (the live ones come from the Lab Equipment import), so two are created here.
OC_MIG=db/migrations/20261010000156_operation_code_rule.sql
oc_backfill=$(awk '/^-- runbackfill:start/{f=1;next}/^-- runbackfill:end/{f=0}f' "$OC_MIG" 2>/dev/null)
oc_guard=$(printf '%s\n' "$oc_backfill" | awk '/^DO \$\$/{f=1} f{print} f && /^END \$\$;/{exit}')
[[ -n "$oc_backfill" && -n "$oc_guard" ]] && ok "found the run-number back-fill and its guard in the migration" \
    || bad "could not extract the run-number back-fill / guard from $OC_MIG"
OC_E25='9a000000-0000-4000-8000-000000000025'
OC_E250='9a000000-0000-4000-8000-000000000250'
oc_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO equipment (equipment_id, equipment_code, equipment_name, equipment_type) VALUES
    ('$OC_E25',  'T-OC-FCT25',  'FCT HP D 25',  'FAST_Press'),
    ('$OC_E250', 'T-OC-FCT250', 'FCT HP D 250', 'FAST_Press');
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('9a000000-0000-4000-8000-000000000001', 'T-OC-M', 'operation code rule test method');

SELECT 'cn:' || coalesce(code_num(0), '') || '|' || coalesce(code_num(0.05), '') || '|' || coalesce(code_num(1932.080), '')
    || '|' || coalesce(code_num(30.000), '') || '|' || coalesce(code_num(123456789), '') || '|' || coalesce(code_num(-5.50), '')
    || '|' || coalesce(code_num(NULL), '');

CREATE FUNCTION pg_temp.oc(j jsonb, s text DEFAULT 'TEST-OC-001') RETURNS text LANGUAGE sql AS
\$f\$ SELECT coalesce(operation_code_for(jsonb_populate_record(NULL::manufacturing_operations, j), s), '<null>') \$f\$;

SELECT 'm_full:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"F","operation_sequence":8,"machining_cutting_speed_m_per_min":30,"machining_feed_mm_per_rev":0.1,"machining_axial_depth_of_cut_mm":1}');
SELECT 'm_speed:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"F","operation_sequence":8,"machining_cutting_speed_m_per_min":30}');
SELECT 'm_none:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"F","operation_sequence":8}');
SELECT 'm_mt:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"MT-F","operation_sequence":8,"machining_cutting_speed_m_per_min":30}');
SELECT 'm_mm:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"MM-R","operation_sequence":8}');
SELECT 'm_word:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"facing","operation_sequence":8}');
SELECT 'ht:' || pg_temp.oc('{"process_category":"heat_treatment","ht_treatment_type":"anneal","operation_sequence":2,"ht_peak_temp_celsius":1050,"ht_hold_time_min":60,"ht_cooling_method":"furnace"}');
SELECT 'def:' || pg_temp.oc('{"process_category":"deformation","deform_deformation_type":"rolling","operation_sequence":3,"deform_deformation_temp_celsius":900,"deform_total_reduction_pct":50,"deform_pass_count":4}');
SELECT 'def_unknown:' || pg_temp.oc('{"process_category":"deformation","deform_deformation_type":"weird","operation_sequence":3}');
SELECT 'am:' || pg_temp.oc('{"process_category":"additive","operation_sequence":4,"am_laser_power_w":200,"am_scan_speed_mm_per_s":800,"am_layer_thickness_mm":0.03}');
SELECT 'sint_utc:' || pg_temp.oc('{"process_category":"sintering","equipment_id":"$OC_E25","sintering_run_number":9500,"operation_date":"2026-10-09T23:30:00Z","sintering_max_temp_celsius":1150,"sintering_max_force_kn":101,"sintering_mould_diameter_mm":80}', NULL);
SELECT 'sint_norun:' || pg_temp.oc('{"process_category":"sintering","equipment_id":"$OC_E25","operation_date":"2026-10-09T23:30:00Z","sintering_max_temp_celsius":1150}', NULL);
SELECT 'sint_src250:' || pg_temp.oc('{"process_category":"sintering","source_system":"fast_250","sintering_run_number":12,"operation_date":"2026-01-02T12:00:00Z"}', NULL);
SELECT 'sint_equip250:' || pg_temp.oc('{"process_category":"sintering","equipment_id":"$OC_E250","sintering_run_number":12,"operation_date":"2026-01-02T12:00:00Z"}', NULL);
SELECT 'prep:' || pg_temp.oc('{"process_category":"sample_prep","operation_sequence":5}');
SELECT 'nothing:' || pg_temp.oc('{}', NULL);

-- the back-fill, on FAST-shaped rows carrying their code and run only in pass_code / source_run_uid
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, source_run_uid, equipment_id, operation_date,
    sintering_max_temp_celsius, sintering_max_force_kn, sintering_mould_diameter_mm, pass_code) VALUES
    ('9a000000-0000-4000-8000-000000000101', '9a000000-0000-4000-8000-000000000001', 'sintering', 'fast_25', 'fast25|4624', '$OC_E25',
        '2016-10-12T10:00:00Z', 1200, 14, 20, '12-10-16-MF25-4624-1200C_14kN_20dia'),
    ('9a000000-0000-4000-8000-000000000102', '9a000000-0000-4000-8000-000000000001', 'sintering', 'fast_25', 'fast25|9686', '$OC_E25',
        '2025-02-13T08:00:00Z', NULL, NULL, NULL, '13-02-25-MF25-9686'),
    ('9a000000-0000-4000-8000-000000000103', '9a000000-0000-4000-8000-000000000001', 'sintering', 'fast_250', 'fast250|77', '$OC_E250',
        '2024-03-05T09:00:00Z', 1100, 30, NULL, '05-03-24-MF250-77-1100C_30kN');
SELECT 'bf_before:' || count(*) FROM manufacturing_operations WHERE operation_id::text LIKE '9a000000-0000-4000-8000-0000000001%' AND sintering_run_number IS NULL;
SAVEPOINT guard_test;
ALTER TABLE manufacturing_operations ENABLE ALWAYS TRIGGER mfg_op_short_id;
$oc_guard
ROLLBACK TO guard_test;
SELECT COALESCE(max(log_id), 0) AS lid FROM audit_logs \gset
$oc_backfill
SELECT 'bf_runs:' || string_agg(sintering_run_number::text, ',' ORDER BY operation_id) FROM manufacturing_operations
  WHERE operation_id::text LIKE '9a000000-0000-4000-8000-0000000001%';
SELECT 'bf_same:' || count(*) FILTER (WHERE operation_code_for(m, NULL) = m.pass_code) || '/' || count(*)
  FROM manufacturing_operations m WHERE operation_id::text LIKE '9a000000-0000-4000-8000-0000000001%';
SELECT 'bf_audit:' || count(*) FROM audit_logs WHERE log_id > :lid AND table_name = 'manufacturing_operations';
SELECT 'bf_triggers:' || count(*) FILTER (WHERE tgenabled <> 'O') FROM pg_trigger
  WHERE NOT tgisinternal AND tgrelid = 'manufacturing_operations'::regclass;

-- one operation per machine run
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number, operation_date, pass_code)
VALUES ('9a000000-0000-4000-8000-000000000111', '9a000000-0000-4000-8000-000000000001', 'sintering', 'test', '$OC_E25', 9500, '2026-10-09T23:30:00Z', 'TEST-OC-RUN-A');
DO \$\$ BEGIN
  INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number, operation_date, pass_code)
  VALUES ('9a000000-0000-4000-8000-000000000112', '9a000000-0000-4000-8000-000000000001', 'sintering', 'test', '$OC_E25', 9500, '2026-10-10T08:00:00Z', 'TEST-OC-RUN-B');
  RAISE NOTICE 'uniq_same:missing';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uniq_same:ok';
END \$\$;
DO \$\$ BEGIN
  INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number, operation_date, pass_code)
  VALUES ('9a000000-0000-4000-8000-000000000113', '9a000000-0000-4000-8000-000000000001', 'sintering', 'test', '$OC_E250', 9500, '2026-10-09T23:30:00Z', 'TEST-OC-RUN-C');
  RAISE NOTICE 'uniq_other:ok';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uniq_other:refused';
END \$\$;
SELECT 'df:' || coalesce("group", '<null>') || '/' || coalesce(required::text, '<null>') || '/' || coalesce(hidden::text, '<null>') || '/' || count(*) OVER ()
  FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number';
ROLLBACK;
SQL
)
oc_check() { grep -q -- "$1" <<<"$oc_out" && ok "$2" || bad "$2 (psql output: $oc_out)"; }
oc_check "^cn:0|0.05|1932.08|30|123457000|-5.5|$" "code_num writes 6 significant digits without trailing zeros (0, 0.05, 1932.08, 30, 123457000, -5.5, NULL)"
oc_check "^m_full:TEST-OC-001-F8-30MPM_0.1feed_1DoC$" "machining code: sample, subtype + sequence, then the set parameters"
oc_check "^m_speed:TEST-OC-001-F8-30MPM$" "machining code with only the speed set"
oc_check "^m_none:TEST-OC-001-F8$" "machining code with no parameters"
oc_check "^m_mt:TEST-OC-001-F8-30MPM$" "machining code: a subtype stored as method code + letter (MT-F) gives the bare letter, as every stored code has it"
oc_check "^m_mm:TEST-OC-001-R8$" "machining code: MM-R gives R"
oc_check "^m_word:TEST-OC-001-facing8$" "machining code: a subtype without a method prefix is used as it is"
oc_check "^ht:TEST-OC-001-HTA2-1050C_60min_FC$" "heat treatment code"
oc_check "^def:TEST-OC-001-DR3-900C_50pct_4p$" "deformation code"
oc_check "^def_unknown:TEST-OC-001-D3$" "deformation code with an unknown type falls back to D"
oc_check "^am:TEST-OC-001-AM4-200W_800mmps_0.03mm$" "additive code without a process variant"
oc_check "^sint_utc:09-10-26-MF25-9500-1150C_101kN_80dia$" "sintering code: UTC date, machine from the equipment, run number"
oc_check "^sint_norun:<null>$" "sintering code is NULL without a run number (never invented)"
oc_check "^sint_src250:02-01-26-MF250-12$" "sintering code takes the machine from source_system when there is no equipment"
oc_check "^sint_equip250:02-01-26-MF250-12$" "sintering code: machine 250 from the equipment name"
oc_check "^prep:TEST-OC-001-5$" "a category without its own rule gives sample code + sequence"
oc_check "^nothing:<null>$" "no category and no sample gives NULL"
oc_check "^bf_before:3$" "(setup) the three FAST-shaped rows have no run number before the back-fill"
oc_check "is not in its normal state" "the run-number back-fill guard refuses a user trigger that is ENABLE ALWAYS"
oc_check "^bf_runs:4624,9686,77$" "the back-fill reads the run number from source_run_uid"
oc_check "^bf_same:3/3$" "operation_code_for reproduces the imported FAST code for every back-filled row"
oc_check "^bf_audit:0$" "the back-fill writes no audit rows"
oc_check "^bf_triggers:0$" "every user trigger on manufacturing_operations is enabled again after the back-fill"
oc_check "uniq_same:ok" "a second sintering operation with the same machine and run is refused"
oc_check "uniq_other:ok" "the same run number on the other machine is allowed"
oc_check "^df:sintering_machine_group/false/false/1$" "the run number field is in the sintering group, not required, not hidden"
echo "== Operation codes follow their fields (T0b) =="
# One rolled-back transaction. A person's typed code is kept; an automatic one is rebuilt from the
# rule (operation_code_for) whenever a field it is built from changes. Prefix 9b000000-0000-4000-8000-.
OT_MIG=db/migrations/20261010000157_operation_code_trigger.sql
ot_seqfill=$(awk '/^-- seqbackfill:start/{f=1;next}/^-- seqbackfill:end/{f=0}f' "$OT_MIG" 2>/dev/null)
[[ -n "$ot_seqfill" ]] && ok "found the sequence back-fill in the migration" \
    || bad "could not extract the sequence back-fill from $OT_MIG"
OT_P='9b000000-0000-4000-8000-'
ot_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('${OT_P}000000000001', 'TEST-OT-001'), ('${OT_P}000000000002', 'TEST-OT-002'), ('${OT_P}000000000003', 'TEST-OT-003'),
    ('${OT_P}000000000004', 'TEST-OT-004');
INSERT INTO manufacturing_methods (method_id, method_code, method_name) VALUES
    ('${OT_P}000000000011', 'T-OT-M1', 'operation code trigger test method 1'),
    ('${OT_P}000000000012', 'T-OT-M2', 'operation code trigger test method 2');
INSERT INTO equipment (equipment_id, equipment_code, equipment_name, equipment_type) VALUES
    ('${OT_P}000000000021', 'T-OT-FCT25',  'FCT HP D 25',  'FAST_Press'),
    ('${OT_P}000000000022', 'T-OT-FCT250', 'FCT HP D 250', 'FAST_Press');

-- new_auto: a machining operation without a code gets its number and the rule's code
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype,
    machining_cutting_speed_m_per_min, machining_feed_mm_per_rev, machining_axial_depth_of_cut_mm)
VALUES ('${OT_P}000000000101', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 'F', 30, 0.1, 1);
SELECT 'new_auto:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- param_follow
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 45 WHERE operation_id = '${OT_P}000000000101';
SELECT 'param_follow:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- resend: the same code written again changes nothing and the op stays automatic
UPDATE manufacturing_operations SET pass_code = pass_code WHERE operation_id = '${OT_P}000000000101';
SELECT 'resend:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET machining_feed_mm_per_rev = 0.2 WHERE operation_id = '${OT_P}000000000101';
SELECT 'resend_follow:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- notes: nothing the code is built from changed
UPDATE manufacturing_operations SET outcome_notes = 'just a note' WHERE operation_id = '${OT_P}000000000101';
SELECT 'notes:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- subtype_keeps_number
UPDATE manufacturing_operations SET machining_operation_subtype = 'R' WHERE operation_id = '${OT_P}000000000101';
SELECT 'subtype:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- sample_change: TEST-OT-002 already has one operation (number 1)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${OT_P}000000000102', '${OT_P}000000000011', '${OT_P}000000000002', 'machining', 'F');
SELECT 'other_first:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000102';
UPDATE manufacturing_operations SET sample_id = '${OT_P}000000000002' WHERE operation_id = '${OT_P}000000000101';
SELECT 'sample_change:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- method_change: a third operation on TEST-OT-002 raises the highest number to 3, so the moved one gets 4
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${OT_P}000000000103', '${OT_P}000000000011', '${OT_P}000000000002', 'machining', 'F');
UPDATE manufacturing_operations SET method_id = '${OT_P}000000000012' WHERE operation_id = '${OT_P}000000000101';
SELECT 'method_change:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- typed: a code a person wrote is kept, and later field changes leave it alone
UPDATE manufacturing_operations SET pass_code = 'MY-OP-CODE' WHERE operation_id = '${OT_P}000000000101';
SELECT 'typed:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 50 WHERE operation_id = '${OT_P}000000000101';
SELECT 'typed_kept:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- typed_equals_rule: writing exactly the rule's value makes it automatic again
SELECT operation_code_for(m, 'TEST-OT-002') AS rule_value FROM manufacturing_operations m WHERE operation_id = '${OT_P}000000000101' \gset
UPDATE manufacturing_operations SET pass_code = :'rule_value' WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 55 WHERE operation_id = '${OT_P}000000000101';
SELECT 'typed_equals_rule:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- cleared: NULL rebuilds from the rule
UPDATE manufacturing_operations SET pass_code = 'MY-OP-CODE' WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET pass_code = NULL WHERE operation_id = '${OT_P}000000000101';
SELECT 'cleared:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- placeholder: an old client's {seq} code counts as automatic (TEST-OT-001 has no operation left)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype, pass_code)
VALUES ('${OT_P}000000000111', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 'F', '{seq}-whatever');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype,
    machining_cutting_speed_m_per_min, pass_code)
VALUES ('${OT_P}000000000112', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 'F', 30, 'TEST-OT-001-F{seq}-30MPM');
SELECT 'placeholder_a:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000111';
SELECT 'placeholder_b:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000112';
-- clear_move: clearing the code in the same statement as a sample change still takes the next number there
UPDATE manufacturing_operations SET sample_id = '${OT_P}000000000001', pass_code = NULL WHERE operation_id = '${OT_P}000000000101';
SELECT 'clear_move:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- legacy_kept: a stored code that is not the rule's value counts as typed
ALTER TABLE manufacturing_operations DISABLE TRIGGER mfg_op_set_code;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, machining_operation_subtype,
    machining_cutting_speed_m_per_min, machining_feed_mm_per_rev, machining_axial_depth_of_cut_mm, pass_code)
VALUES ('${OT_P}000000000121', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 9, 'F', 30, 0.05, 0.1, 'TEST-OT-001-F9-30MPM_0.05feed_0.1DoC_');
-- null_code_becomes_auto: no code yet counts as automatic, but only once something it is built from changes
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, machining_operation_subtype,
    machining_cutting_speed_m_per_min)
VALUES ('${OT_P}000000000122', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 20, 'F', 30);
ALTER TABLE manufacturing_operations ENABLE TRIGGER mfg_op_set_code;
UPDATE manufacturing_operations SET machining_feed_mm_per_rev = 0.07 WHERE operation_id = '${OT_P}000000000121';
SELECT 'legacy_kept:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000121';
UPDATE manufacturing_operations SET outcome_notes = 'a note' WHERE operation_id = '${OT_P}000000000122';
SELECT 'null_notes:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000122';
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 31 WHERE operation_id = '${OT_P}000000000122';
SELECT 'null_speed:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000122';
-- frozen: an experiment_sheet row keeps its code; a person may still rename it
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, source_system,
    machining_operation_subtype, machining_cutting_speed_m_per_min, pass_code)
VALUES ('${OT_P}000000000131', '${OT_P}000000000011', '${OT_P}000000000003', 'machining', 1, 'experiment_sheet', 'F', 30, 'EXP-SHEET-OLD');
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 60 WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = 'EXP-SHEET-RENAMED' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_typed:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
-- frozen: clearing the code (NULL, or blank) keeps the saved one; typing a new one stores it
UPDATE manufacturing_operations SET pass_code = NULL WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_clear:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = '   ' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_blank:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = 'X-{seq}-{mf}' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_placeholder:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = 'EXP-SHEET-RENAMED-2' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_retyped:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
-- fast_follow: a FAST-shaped row follows its temperature
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number,
    operation_date, sintering_max_temp_celsius, sintering_max_force_kn, sintering_mould_diameter_mm, pass_code)
VALUES ('${OT_P}000000000141', '${OT_P}000000000011', 'sintering', 'fast_25', '${OT_P}000000000021', 4624,
    '2016-10-12T10:00:00Z', 1200, 14, 20, '12-10-16-MF25-4624-1200C_14kN_20dia');
UPDATE manufacturing_operations SET sintering_max_temp_celsius = 1250 WHERE operation_id = '${OT_P}000000000141';
SELECT 'fast_follow:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000141';
-- sinter_hand: a hand-made sintering operation has no code until it has a run number
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, equipment_id, operation_date)
VALUES ('${OT_P}000000000142', '${OT_P}000000000011', '${OT_P}000000000003', 'sintering', '${OT_P}000000000022', '2026-03-05T09:00:00Z');
SELECT 'sinter_hand_norun:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000142';
UPDATE manufacturing_operations SET sintering_run_number = 400 WHERE operation_id = '${OT_P}000000000142';
SELECT 'sinter_hand_run:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000142';
-- an old client's {mf} placeholder is automatic too, and the run number is never invented
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, equipment_id, operation_date, pass_code)
VALUES ('${OT_P}000000000143', '${OT_P}000000000011', '${OT_P}000000000003', 'sintering', '${OT_P}000000000022', '2026-03-06T09:00:00Z', '06-03-26-MF{mf}');
SELECT 'mf_placeholder:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000143';
-- seq_backfill: the extracted back-fill, run as the migration runs it (before mfg_op_set_code exists,
-- so with that trigger disabled; the other user triggers stay on). Imported rows keep a NULL sequence.
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, source_system, machining_operation_subtype, operation_sequence, pass_code) VALUES
    ('${OT_P}000000000151', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-F2_1-60MPM'),
    ('${OT_P}000000000152', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'N/R'),
    ('${OT_P}000000000153', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-F3_30MPM_0.05feed'),
    ('${OT_P}000000000154', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-F5-30MPM'),
    ('${OT_P}000000000155', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'F', 5, 'TEST-OT-004-F5-X'),
    ('${OT_P}000000000156', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-R', NULL, 'TEST-OT-004-R6-a'),
    ('${OT_P}000000000157', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-R', NULL, 'TEST-OT-004-R6-b'),
    ('${OT_P}000000000158', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-7-x');
SELECT 'bf_before:' || count(*) FROM manufacturing_operations WHERE operation_id::text LIKE '${OT_P}00000000015%' AND operation_sequence IS NULL;
ALTER TABLE manufacturing_operations DISABLE TRIGGER mfg_op_set_code;
$ot_seqfill
ALTER TABLE manufacturing_operations ENABLE TRIGGER mfg_op_set_code;
SELECT 'bf_seq:' || string_agg(coalesce(operation_sequence::text, '<null>'), ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id::text LIKE '${OT_P}00000000015%';
SELECT 'bf_codes:' || string_agg(pass_code, ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id::text LIKE '${OT_P}00000000015%';
SELECT 'bf_ledger:' || count(*) || ':' || string_agg(filled::text, ',' ORDER BY filled) FROM d1_private.operation_sequence_backfill WHERE operation_id::text LIKE '${OT_P}%';
SELECT 'trg:' || count(*) FILTER (WHERE tgname = 'mfg_op_set_code' AND tgenabled = 'O')
    || '/' || count(*) FILTER (WHERE tgname = 'mfg_op_assign_numbers') FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = 'manufacturing_operations'::regclass;
ROLLBACK;
SQL
)
ot_check() { grep -qx -- "$1" <<<"$ot_out" && ok "$2" || bad "$2 (psql output: $ot_out)"; }
ot_check "new_auto:1:TEST-OT-001-F1-30MPM_0.1feed_1DoC" "a new machining operation gets number 1 and the rule's code"
ot_check "param_follow:1:TEST-OT-001-F1-45MPM_0.1feed_1DoC" "changing the speed rewrites the code and keeps the number"
ot_check "resend:TEST-OT-001-F1-45MPM_0.1feed_1DoC" "writing the same code again changes nothing"
ot_check "resend_follow:TEST-OT-001-F1-45MPM_0.2feed_1DoC" "an operation whose code was written again still follows its fields"
ot_check "notes:1:TEST-OT-001-F1-45MPM_0.2feed_1DoC" "changing only the notes leaves code and number alone"
ot_check "subtype:1:TEST-OT-001-R1-45MPM_0.2feed_1DoC" "changing the subtype keeps the number"
ot_check "other_first:1:TEST-OT-002-F1" "(setup) the first operation on TEST-OT-002 is number 1"
ot_check "sample_change:2:TEST-OT-002-R2-45MPM_0.2feed_1DoC" "moving to another sample takes that sample's next number"
ot_check "method_change:4:TEST-OT-002-R4-45MPM_0.2feed_1DoC" "changing the method takes the next number on the sample"
ot_check "typed:MY-OP-CODE" "a typed code is stored as written"
ot_check "typed_kept:MY-OP-CODE" "a typed code survives a later field change"
ot_check "typed_equals_rule:TEST-OT-002-R4-55MPM_0.2feed_1DoC" "writing exactly the rule's value keeps the operation automatic"
ot_check "cleared:TEST-OT-002-R4-55MPM_0.2feed_1DoC" "clearing the code rebuilds it from the rule"
ot_check "placeholder_a:1:TEST-OT-001-F1" "an old client's {seq}-whatever code is replaced by the rule's code"
ot_check "placeholder_b:2:TEST-OT-001-F2-30MPM" "an old client's code with a {seq} placeholder is replaced by the rule's code"
ot_check "clear_move:3:TEST-OT-001-R3-55MPM_0.2feed_1DoC" "clearing the code in the same statement as a sample change takes the next number on the new sample"
ot_check "legacy_kept:TEST-OT-001-F9-30MPM_0.05feed_0.1DoC_" "a stored code that is not the rule's value counts as typed and is kept"
ot_check "null_notes:<null>" "an operation with no code stays without one when only the notes change"
ot_check "null_speed:TEST-OT-001-F20-31MPM" "an operation with no code gets the rule's code once a field it is built from changes"
ot_check "frozen:EXP-SHEET-OLD" "an experiment_sheet operation keeps its code when a field changes"
ot_check "frozen_typed:EXP-SHEET-RENAMED" "a person can still rename an experiment_sheet operation"
ot_check "frozen_clear:EXP-SHEET-RENAMED" "clearing the code of an experiment_sheet operation keeps its code"
ot_check "frozen_blank:EXP-SHEET-RENAMED" "blanking the code of an experiment_sheet operation keeps its code"
ot_check "frozen_placeholder:EXP-SHEET-RENAMED" "writing a {seq}/{mf} placeholder to an experiment_sheet operation keeps its code"
ot_check "frozen_retyped:EXP-SHEET-RENAMED-2" "typing a new code on an experiment_sheet operation stores it"
ot_check "fast_follow:12-10-16-MF25-4624-1250C_14kN_20dia" "a FAST operation's code follows its temperature"
ot_check "sinter_hand_norun:<null>" "a hand-made sintering operation has no code before it has a run number"
ot_check "sinter_hand_run:05-03-26-MF250-400" "a run number gives it the code"
ot_check "mf_placeholder:<null>" "an old client's {mf} code is automatic: no run number, no code, no invented MF number"
ot_check "bf_before:7" "(setup) the seven back-fill candidates have no sequence"
ot_check "bf_seq:2,<null>,3,<null>,5,<null>,<null>,<null>" "the back-fill reads F2_1 as 2 and F3_30MPM_0.05feed as 3, and leaves N/R, a taken number, two candidates sharing one and a bare-digit token NULL"
ot_check "bf_codes:TEST-OT-004-F2_1-60MPM,N/R,TEST-OT-004-F3_30MPM_0.05feed,TEST-OT-004-F5-30MPM,TEST-OT-004-F5-X,TEST-OT-004-R6-a,TEST-OT-004-R6-b,TEST-OT-004-7-x" "the back-fill leaves every code as it was"
ot_check "bf_ledger:2:2,3" "the back-fill ledger holds exactly the two filled rows"
ot_check "trg:1/0" "mfg_op_set_code is on the table and mfg_op_assign_numbers is gone"
echo "== Sample code corrections reach operation codes; the code preview (T0b) =="
# One rolled-back transaction for the cascade and the preview (prefix 9c000000-0000-4000-8000-), then a
# two-session lock-order check on committed rows that are deleted afterwards.
CS_MIG=db/migrations/20261010000158_operation_code_cascade_and_preview.sql
[[ -f "$CS_MIG" ]] && ok "found migration 158" || bad "migration 158 is missing ($CS_MIG)"
CS_P='9c000000-0000-4000-8000-'
cs_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${CS_P}000000000001', 'TEST-OC-CAS');
INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category) VALUES
    ('${CS_P}000000000011', 'T-OC-M1', 'operation code cascade test machining', 'machining'),
    ('${CS_P}000000000012', 'T-OC-M2', 'operation code cascade test heat treatment', 'heat_treatment');
-- an automatic, a typed and a frozen operation on the sample, and a test coded on it (T0a)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype,
    machining_cutting_speed_m_per_min, machining_feed_mm_per_rev)
VALUES ('${CS_P}000000000101', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F', 30, 0.1);
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype, pass_code)
VALUES ('${CS_P}000000000102', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F', 'MY-TYPED-OC');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, source_system,
    machining_operation_subtype, pass_code)
VALUES ('${CS_P}000000000103', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 3, 'experiment_sheet', 'F', 'EXP-OLD-OC');
INSERT INTO test_sessions (session_id, test_type, sample_id) VALUES ('${CS_P}000000000201', 'sem', '${CS_P}000000000001');
SELECT 'cas_before:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
SELECT 'cas_test_before:' || test_code FROM test_sessions WHERE session_id = '${CS_P}000000000201';
UPDATE physical_samples SET sample_code = 'TEST-OC-CAS2' WHERE sample_id = '${CS_P}000000000001';
SELECT 'cascade_auto:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
SELECT 'cascade_typed:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000102';
SELECT 'cascade_frozen:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000103';
SELECT 'cascade_tests_still:' || test_code FROM test_sessions WHERE session_id = '${CS_P}000000000201';
-- the renamed operation is still automatic: it follows a later field change
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 45 WHERE operation_id = '${CS_P}000000000101';
SELECT 'cascade_still_auto:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
-- a change that is not the code leaves the operations alone
UPDATE physical_samples SET nickname = 'nick' WHERE sample_id = '${CS_P}000000000001';
SELECT 'cascade_nick:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';

-- preview_new: the preview of a new operation is what a real insert with those values then gets
SELECT preview_operation_code('{"process_category":"machining","sample_id":"${CS_P}000000000001","machining_operation_subtype":"F","machining_cutting_speed_m_per_min":30}'::jsonb, NULL, 'TEST-OC-CAS2') AS pn \gset
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype, machining_cutting_speed_m_per_min)
VALUES ('${CS_P}000000000104', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F', 30);
SELECT 'preview_new:' || (:'pn' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000104';
-- preview_edit: the preview of an edit is what the UPDATE then gives
SELECT preview_operation_code('{"machining_feed_mm_per_rev":0.2}'::jsonb, '${CS_P}000000000101', 'TEST-OC-CAS2') AS pe \gset
UPDATE manufacturing_operations SET machining_feed_mm_per_rev = 0.2 WHERE operation_id = '${CS_P}000000000101';
SELECT 'preview_edit:' || (:'pe' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
-- preview_method: only a method, no category: the category comes from the method
SELECT preview_operation_code('{"method_id":"${CS_P}000000000011","sample_id":"${CS_P}000000000001","machining_operation_subtype":"F"}'::jsonb, NULL, 'TEST-OC-CAS2') AS pm \gset
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, machining_operation_subtype)
VALUES ('${CS_P}000000000105', '${CS_P}000000000011', '${CS_P}000000000001', 'F');
SELECT 'preview_method:' || (:'pm' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000105';
-- preview_method_edit: a saved operation moved to a heat-treatment method (category and number follow)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_P}000000000106', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F');
SELECT preview_operation_code('{"method_id":"${CS_P}000000000012"}'::jsonb, '${CS_P}000000000106', 'TEST-OC-CAS2') AS pme \gset
UPDATE manufacturing_operations SET method_id = '${CS_P}000000000012' WHERE operation_id = '${CS_P}000000000106';
SELECT 'preview_method_edit:' || (:'pme' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000106';
-- derive_category_exact: the preview derives the category exactly as mfg_op_derive_category does
-- (A) method changed and a category passed along that equals the saved one: the trigger still derives
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_P}000000000107', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F');
SELECT preview_operation_code('{"method_id":"${CS_P}000000000012","process_category":"machining"}'::jsonb, '${CS_P}000000000107', 'TEST-OC-CAS2') AS pa \gset
UPDATE manufacturing_operations SET method_id = '${CS_P}000000000012', process_category = 'machining' WHERE operation_id = '${CS_P}000000000107';
SELECT 'preview_cat_a:' || (:'pa' = pass_code) || ':' || process_category || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000107';
-- (B) a saved operation whose category is NULL keeps it when only another value is edited
ALTER TABLE manufacturing_operations DISABLE TRIGGER mfg_op_derive_category;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, machining_operation_subtype)
VALUES ('${CS_P}000000000108', '${CS_P}000000000011', '${CS_P}000000000001', 'F');
ALTER TABLE manufacturing_operations ENABLE TRIGGER mfg_op_derive_category;
SELECT preview_operation_code('{"machining_cutting_speed_m_per_min":30}'::jsonb, '${CS_P}000000000108', 'TEST-OC-CAS2') AS pb \gset
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 30 WHERE operation_id = '${CS_P}000000000108';
SELECT 'preview_cat_b:' || (:'pb' = pass_code) || ':' || coalesce(process_category, '<null>') || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000108';
-- (C) a category set to NULL on a saved operation stays NULL (the method did not change)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_P}000000000109', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F');
SELECT preview_operation_code('{"process_category":null}'::jsonb, '${CS_P}000000000109', 'TEST-OC-CAS2') AS pc \gset
UPDATE manufacturing_operations SET process_category = NULL WHERE operation_id = '${CS_P}000000000109';
SELECT 'preview_cat_c:' || (:'pc' = pass_code) || ':' || coalesce(process_category, '<null>') || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000109';
-- no values and no saved row gives NULL, not an error; a NULL values object is read as empty
SELECT 'preview_empty:' || coalesce(preview_operation_code('{}'::jsonb, NULL, NULL), '<null>');
SELECT 'preview_nullvalues:' || coalesce(preview_operation_code(NULL, NULL, 'TEST-OC-CAS2'), '<null>');
-- the triggers' shape and the comments on every new object
SELECT 'shape:' || string_agg(tgname || '/' || (tgtype & 1) || '/' || (tgtype & 2) || '/' || (tgtype & 4) || '/' || (tgtype & 8) || '/' || (tgtype & 16)
    || '/' || (tgattr::text = '')::text || '/' || (tgqual IS NULL)::text || '/' || (obj_description(oid, 'pg_trigger') IS NOT NULL)::text, ',' ORDER BY tgname)
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'physical_samples'::regclass
  AND tgname IN ('physical_samples_rollup_lock', 'physical_samples_cascade_operation_codes');
SELECT 'shape_ops:' || string_agg(tgname || '/' || (tgtype & 1) || '/' || (tgtype & 2) || '/' || (tgtype & 4) || '/' || (tgtype & 8) || '/' || (tgtype & 16) || '/' || (tgattr::text = '')::text || '/' || (tgqual IS NULL)::text || '/' || (obj_description(oid, 'pg_trigger') IS NOT NULL)::text, ',' ORDER BY tgname)
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'manufacturing_operations'::regclass AND tgname = 'mfg_op_rollup_lock';
SELECT 'fn_comments:' || count(*) FILTER (WHERE obj_description(p.oid, 'pg_proc') IS NOT NULL) || '/' || count(*)
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('trg_physical_samples_rollup_lock', 'trg_cascade_operation_codes', 'preview_operation_code', 'trg_manufacturing_operations_rollup_lock');
ROLLBACK;
SQL
)
cs_check() { grep -qx -- "$1" <<<"$cs_out" && ok "$2" || bad "$2 (psql output: $cs_out)"; }
cs_check "cas_before:1:TEST-OC-CAS-F1-30MPM_0.1feed" "(setup) the automatic operation carries the sample's first code"
cs_check "cas_test_before:TEST-OC-CAS-SEM1" "(setup) the test on the sample carries the sample's first code"
cs_check "cascade_auto:1:TEST-OC-CAS2-F1-30MPM_0.1feed" "renaming the sample renames its automatic operation, sequence unchanged"
cs_check "cascade_typed:MY-TYPED-OC" "a typed operation code is kept when the sample is renamed"
cs_check "cascade_frozen:EXP-OLD-OC" "an experiment_sheet operation code is kept when the sample is renamed"
cs_check "cascade_tests_still:TEST-OC-CAS2-SEM1" "the test code cascade (T0a) still runs next to the operation cascade"
cs_check "cascade_still_auto:TEST-OC-CAS2-F1-45MPM_0.1feed" "a renamed operation is still automatic: it follows a later field change"
cs_check "cascade_nick:TEST-OC-CAS2-F1-45MPM_0.1feed" "a sample change that is not its code leaves operation codes alone"
cs_check "preview_new:true:TEST-OC-CAS2-F4-30MPM" "preview_operation_code of a new operation equals the code a real insert gets"
cs_check "preview_edit:true:TEST-OC-CAS2-F1-45MPM_0.2feed" "preview_operation_code of an edit equals the code the UPDATE gives"
cs_check "preview_method:true:TEST-OC-CAS2-F5" "a preview with only a method takes the category from the method, as the insert does"
cs_check "preview_method_edit:true:TEST-OC-CAS2-HT6" "a preview of a method change takes the new category and the next number, as the UPDATE does"
cs_check "preview_empty:<null>" "a preview of nothing is NULL"
cs_check "preview_nullvalues:TEST-OC-CAS2" "a NULL values object is read as empty"
cs_check "shape:physical_samples_cascade_operation_codes/1/0/0/0/16/true/true/true,physical_samples_rollup_lock/0/2/0/8/16/true/true/true" "the two triggers: row AFTER UPDATE and statement BEFORE UPDATE OR DELETE, no column list, no WHEN, commented"
cs_check "shape_ops:mfg_op_rollup_lock/0/2/4/8/16/true/true/true" "mfg_op_rollup_lock: statement BEFORE INSERT OR UPDATE OR DELETE, no column list, no WHEN, commented"
cs_check "fn_comments:4/4" "every new function has a comment"
cs_check "preview_cat_a:true:heat_treatment:TEST-OC-CAS2-HT7" "preview: a method change derives the category even when the same category is passed (as the UPDATE does)"
cs_check "preview_cat_b:true:<null>:TEST-OC-CAS2-8" "preview: a saved NULL category is not derived by an edit of another value (as the UPDATE)"
cs_check "preview_cat_c:true:<null>:TEST-OC-CAS2-9" "preview: a category set to NULL stays NULL (as the UPDATE)"

# lock_order: session A locks a sample row and, later in its transaction, refreshes the rollup (any
# operation write does); session B writes an operation of that sample (rollup lock, then the sample
# row). Without the statement-level trigger A takes the sample row first and B the rollup lock first:
# deadlock. With it A takes the rollup lock before locking the sample row, so B simply waits.
CS_L='9c000000-0000-4000-8000-0000000000'
$PSQL -c "
    DELETE FROM manufacturing_operations WHERE operation_id IN ('${CS_L}f1','${CS_L}f2');
    DELETE FROM physical_samples WHERE sample_id = '${CS_L}f0';
    DELETE FROM manufacturing_methods WHERE method_id = '${CS_L}fa';
" > /dev/null 2>&1 || true
cs_fx=$($PSQL -v ON_ERROR_STOP=1 -c "
    INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category)
    VALUES ('${CS_L}fa', 'T-OC-LK', 'operation code lock order test method', 'machining');
    INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${CS_L}f0', 'TEST-OC-LOCK');
    INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
    VALUES ('${CS_L}f1', '${CS_L}fa', '${CS_L}f0', 'machining', 'F');
" 2>&1) && ok "(setup) lock-order fixtures committed" || bad "lock-order fixtures could not be committed: $cs_fx"
cs_a_log=$(mktemp); cs_b_log=$(mktemp)
psql "$DATABASE_URL" --no-psqlrc -q -v ON_ERROR_STOP=1 > "$cs_a_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL lock_timeout = '10s';
UPDATE physical_samples SET nickname = nickname WHERE sample_id = '${CS_L}f0';
SELECT pg_sleep(1.5);
UPDATE manufacturing_operations SET outcome_notes = 'lo-a' WHERE operation_id = '${CS_L}f1';
COMMIT;
SQL
cs_a_pid=$!
sleep 0.5
psql "$DATABASE_URL" --no-psqlrc -q -v ON_ERROR_STOP=1 > "$cs_b_log" 2>&1 <<SQL
BEGIN;
SET LOCAL lock_timeout = '10s';
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_L}f2', '${CS_L}fa', '${CS_L}f0', 'machining', 'F');
COMMIT;
SQL
cs_b_rc=$?
wait "$cs_a_pid"; cs_a_rc=$?
[[ $cs_a_rc -eq 0 ]] && ok "lock_order: session A (sample row, then an operation write) committed" || bad "lock_order: session A failed: $(cat "$cs_a_log")"
[[ $cs_b_rc -eq 0 ]] && ok "lock_order: session B (operation insert on the same sample) committed" || bad "lock_order: session B failed: $(cat "$cs_b_log")"
if grep -qi "deadlock detected" "$cs_a_log" "$cs_b_log"; then bad "lock_order: deadlock detected: $(cat "$cs_a_log" "$cs_b_log")"; else ok "lock_order: no deadlock between a sample update and an operation insert"; fi
run_eq "lock_order: both writes landed, B's operation numbered after A's" \
    "SELECT string_agg(right(operation_id::text, 2) || ':' || coalesce(operation_sequence::text, ''), ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id IN ('${CS_L}f1','${CS_L}f2')" \
    "f1:1,f2:2"
rm -f "$cs_a_log" "$cs_b_log"
$PSQL -c "
    DELETE FROM manufacturing_operations WHERE operation_id IN ('${CS_L}f1','${CS_L}f2');
    DELETE FROM physical_samples WHERE sample_id = '${CS_L}f0';
    DELETE FROM manufacturing_methods WHERE method_id = '${CS_L}fa';
" > /dev/null 2>&1 || true
run_eq "lock_order: fixtures removed" "SELECT count(*) FROM physical_samples WHERE sample_code = 'TEST-OC-LOCK'" "0"
echo "== File fingerprints table (T0e) =="
# Each check is its own rolled-back transaction (prefix 9d000000-0000-4000-8000-). A rejected statement
# aborts psql (ON_ERROR_STOP), so the error text is what is asserted on. The CI database has the stub
# directus_files (id only, migration 030), so the fixture row sets just the id.
FF_MIG=db/migrations/20261010000159_file_fingerprints.sql
[[ -f "$FF_MIG" ]] && ok "found migration 159" || bad "migration 159 is missing ($FF_MIG)"
FF_F='9d000000-0000-4000-8000-000000000001'
FF_H64=$(printf 'a%.0s' $(seq 1 64))
FF_H63=$(printf 'a%.0s' $(seq 1 63))
FF_HUP=$(printf 'A%.0s' $(seq 1 64))
ff_sql() { # ff_sql <statements>: run them after a fixture directus_files row, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_files (id) VALUES ('$FF_F');
$1
ROLLBACK;
SQL
}
run_eq "file_fingerprints exists" "SELECT to_regclass('public.file_fingerprints')::TEXT" "file_fingerprints"
run_eq "file_fingerprints has both indexes" \
    "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'file_fingerprints' AND indexname IN ('file_fingerprints_content_idx', 'file_fingerprints_data_idx')" \
    "file_fingerprints_content_idx,file_fingerprints_data_idx"
run_eq "file_fingerprints_data_idx is partial (data_sha256 IS NOT NULL)" \
    "SELECT count(*) FROM pg_indexes WHERE indexname = 'file_fingerprints_data_idx' AND indexdef LIKE '%WHERE (data_sha256 IS NOT NULL)%'" "1"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_sha256, data_variable, data_rows, data_cols, size_bytes, source_mtime)
    VALUES ('$FF_F', '$FF_H64', '$FF_H64', 'DATA', 10, 3, 1234, now());
SELECT 'ff_row:' || status || ':' || data_variable || ':' || data_rows || 'x' || data_cols FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_row:done:DATA:10x3' <<<"$ff_out" && ok "a done fingerprint for a file inserts (status defaults to done)" || bad "done fingerprint insert failed (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256) VALUES ('$FF_F', '$FF_H63');")
grep -q 'check constraint' <<<"$ff_out" && ok "a 63-character content_sha256 is rejected (check_violation)" || bad "63-character content_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256) VALUES ('$FF_F', '$FF_HUP');")
grep -q 'check constraint' <<<"$ff_out" && ok "an upper-case content_sha256 is rejected (check_violation)" || bad "upper-case content_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_sha256) VALUES ('$FF_F', '$FF_H64', '$FF_H63');")
grep -q 'check constraint' <<<"$ff_out" && ok "a 63-character data_sha256 is rejected (check_violation)" || bad "63-character data_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_variable) VALUES ('$FF_F', '$FF_H64', 'Data');")
grep -q 'check constraint' <<<"$ff_out" && ok "a data_variable other than data / DATA is rejected" || bad "bad data_variable was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_rows) VALUES ('$FF_F', '$FF_H64', -1);")
grep -q 'check constraint' <<<"$ff_out" && ok "a negative data_rows is rejected" || bad "negative data_rows was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status, content_sha256) VALUES ('$FF_F', 'weird', '$FF_H64');")
grep -q 'check constraint' <<<"$ff_out" && ok "an unknown status is rejected" || bad "unknown status was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status) VALUES ('$FF_F', 'done');")
grep -q 'file_fingerprints_done_has_hash' <<<"$ff_out" && ok "status done with a NULL content_sha256 is rejected" || bad "done without content_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status) VALUES ('9d000000-0000-4000-8000-000000000002', 'missing');")
grep -q 'foreign key' <<<"$ff_out" && ok "a fingerprint for a file that does not exist is rejected (foreign key)" || bad "fingerprint without a file was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status, error_message) VALUES ('$FF_F', 'missing', 'not on the share');
SELECT 'ff_missing:' || status || ':' || coalesce(content_sha256, '<null>') || ':' || coalesce(data_sha256, '<null>') FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_missing:missing:<null>:<null>' <<<"$ff_out" && ok "status missing with NULL hashes is accepted" || bad "missing fingerprint with NULL hashes failed (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status, error_message) VALUES ('$FF_F', 'error', 'unreadable');
SELECT 'ff_error:' || status FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_error:error' <<<"$ff_out" && ok "status error with NULL hashes is accepted" || bad "error fingerprint with NULL hashes failed (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256) VALUES ('$FF_F', '$FF_H64');
DELETE FROM directus_files WHERE id = '$FF_F';
SELECT 'ff_cascade:' || count(*) FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_cascade:0' <<<"$ff_out" && ok "deleting the directus_files row removes its fingerprint" || bad "fingerprint survived its file's deletion (output: $ff_out)"
run_eq "file_fingerprints has a table comment" "SELECT count(*) FROM pg_description WHERE objoid = 'public.file_fingerprints'::regclass AND objsubid = 0 AND description <> ''" "1"
run_eq "every file_fingerprints column has a comment (without: none)" \
    "SELECT coalesce(string_agg(a.attname, ', '), '') FROM pg_attribute a WHERE a.attrelid = 'public.file_fingerprints'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND coalesce(col_description(a.attrelid, a.attnum), '') = ''" ""
run_eq "both file_fingerprints indexes have a comment" \
    "SELECT count(*) FROM pg_class c WHERE c.relname IN ('file_fingerprints_content_idx', 'file_fingerprints_data_idx') AND coalesce(obj_description(c.oid, 'pg_class'), '') <> ''" "2"
run_eq "data_sha256's comment says how the hash is taken (uint64 shape, float64, per-column digests, DATA)" \
    "SELECT count(*) FROM pg_description WHERE objoid = 'public.file_fingerprints'::regclass AND objsubid = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.file_fingerprints'::regclass AND attname = 'data_sha256') AND description ~* 'uint64' AND description ~* 'float64' AND description ~* 'each column' AND description ~ 'otherwise DATA'" "1"

echo "== Per-user usage scores (migration 163) =="
# Each check is its own rolled-back transaction (users prefix 9e000000-0000-4000-8000-). A rejected
# statement aborts psql (ON_ERROR_STOP), so the error text is what is asserted on. The CI database
# has the stub directus_users (id only matters), so the fixture users set just the id.
UU_MIG=db/migrations/20261012000163_user_usage.sql
[[ -f "$UU_MIG" ]] && ok "found migration 163" || bad "migration 163 is missing ($UU_MIG)"
UU_A='9e000000-0000-4000-8000-000000000001'
UU_B='9e000000-0000-4000-8000-000000000002'
uu_sql() { # uu_sql <statements>: run them after two fixture users, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$UU_A'), ('$UU_B');
$1
ROLLBACK;
SQL
}
run_eq "user_usage and user_usage_cursor are in d1_private" \
    "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relname IN ('user_usage', 'user_usage_cursor')" \
    "user_usage,user_usage_cursor"
run_eq "neither table is in public (Directus would list it as a collection)" \
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('user_usage', 'user_usage_cursor')" "0"
run_eq "the (user_id, kind) index exists" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname = 'd1_private' AND indexname = 'user_usage_user_kind_idx' AND indexdef LIKE '%(user_id, kind)%'" "1"
run_eq "the tables are not in v_schema_dictionary (the Ask-DB prompt)" \
    "SELECT count(*) FROM v_schema_dictionary WHERE object_name IN ('user_usage', 'user_usage_cursor')" "0"
run_eq "d1_llm_readonly cannot read the usage tables" \
    "SELECT has_table_privilege('d1_llm_readonly', 'd1_private.user_usage', 'SELECT') OR has_table_privilege('d1_llm_readonly', 'd1_private.user_usage_cursor', 'SELECT')" "f"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target, score) VALUES ('$UU_A', 'page', 'samples', 1.5);
SELECT 'uu_row:' || score || ':' || pinned || ':' || coalesce(hidden_at::text, '<null>') FROM d1_private.user_usage WHERE user_id = '$UU_A';")
grep -q 'uu_row:1.5:false:<null>' <<<"$uu_out" && ok "a usage row inserts with pinned false and not hidden by default" || bad "usage row insert failed (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'other', 'samples');")
grep -q 'check constraint' <<<"$uu_out" && ok "a kind other than page / record is rejected" || bad "bad kind was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples');
INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples');")
grep -q 'duplicate key' <<<"$uu_out" && ok "one row per user, kind and target (primary key)" || bad "duplicate usage row was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples'), ('$UU_B', 'page', 'samples'), ('$UU_A', 'record', 'samples');
SELECT 'uu_same_target:' || count(*) FROM d1_private.user_usage;")
grep -q 'uu_same_target:3' <<<"$uu_out" && ok "two users (and two kinds) can hold the same target" || bad "same target for another user or kind failed (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('9e000000-0000-4000-8000-0000000000ff', 'page', 'samples');")
grep -q 'foreign key' <<<"$uu_out" && ok "usage for a user that does not exist is rejected (foreign key)" || bad "usage without a user was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples'), ('$UU_B', 'page', 'samples');
INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES ('$UU_A', 7), ('$UU_B', 9);
DELETE FROM directus_users WHERE id = '$UU_A';
SELECT 'uu_cascade:' || (SELECT count(*) FROM d1_private.user_usage) || ',' || (SELECT count(*) FROM d1_private.user_usage_cursor);")
grep -q 'uu_cascade:1,1' <<<"$uu_out" && ok "deleting a user removes their usage rows and cursor, and only theirs" || bad "usage rows did not follow their user (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES ('$UU_A', 1), ('$UU_A', 2);")
grep -q 'duplicate key' <<<"$uu_out" && ok "one cursor per user" || bad "second cursor for a user was not rejected (output: $uu_out)"
run_eq "both tables and their columns and the index have comments (without: none)" \
    "SELECT coalesce(string_agg(x, ', '), '') FROM (
        SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname IN ('user_usage', 'user_usage_cursor', 'user_usage_user_kind_idx')
           AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname IN ('user_usage', 'user_usage_cursor') AND a.attnum > 0 AND NOT a.attisdropped
           AND coalesce(col_description(a.attrelid, a.attnum), '') = '') q" ""
# The d1-usage endpoint's own statements, run against Postgres. The strings below are the SQL constants of
# core/extensions/d1-usage/index.js (`SQL`), with `?` placeholders as the endpoint sends them; a node test in
# that extension fails if this file and index.js drift apart. Each is PREPAREd with ? turned into $1, $2, ...
# directus_activity is Directus-managed (stub or absent in CI), so a TEMP table of the same name and shape
# (from db/schema.sql) shadows it inside each rolled-back transaction.
UU_SQL_LOCK="SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))"
UU_SQL_GETROW="SELECT score, last_at, pinned, hidden_at FROM d1_private.user_usage WHERE user_id = ? AND kind = ? AND target = ?"
UU_SQL_UPSERT="INSERT INTO d1_private.user_usage (user_id, kind, target, score, last_at, pinned, hidden_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, kind, target) DO UPDATE SET score = EXCLUDED.score, last_at = EXCLUDED.last_at, pinned = EXCLUDED.pinned, hidden_at = EXCLUDED.hidden_at"
UU_SQL_LIST="SELECT kind, target, score, last_at, pinned FROM d1_private.user_usage WHERE user_id = ? AND kind <> 'view' AND pinned = false AND (hidden_at IS NULL OR last_at > hidden_at)"
UU_SQL_GETCURSOR="SELECT last_activity_id FROM d1_private.user_usage_cursor WHERE user_id = ?"
UU_SQL_SETCURSOR="INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET last_activity_id = EXCLUDED.last_activity_id"
UU_SQL_STARTID="SELECT id FROM directus_activity WHERE \"timestamp\" < ? ORDER BY id DESC LIMIT 1"
UU_SQL_MAXID="SELECT id FROM directus_activity ORDER BY id DESC LIMIT 1"
UU_SQL_ACTIVITY="SELECT id, collection, item, \"timestamp\" FROM directus_activity WHERE \"user\" = ? AND id > ? AND action IN ('create', 'update') AND collection IN (?, ?, ?, ?, ?, ?, ?) ORDER BY id LIMIT 500"
UU_SQL_DELUNPINNED="DELETE FROM d1_private.user_usage WHERE user_id = ? AND pinned = false"
UU_SQL_ZEROPINNED="UPDATE d1_private.user_usage SET score = 0 WHERE user_id = ? AND pinned = true"
UU_SQL_GETPINS="SELECT kind, target FROM d1_private.user_usage WHERE user_id = ? AND pinned = true ORDER BY pin_order, kind, target"
UU_SQL_PINAPPEND="UPDATE d1_private.user_usage SET pin_order = (SELECT coalesce(max(pin_order), -1) + 1 FROM d1_private.user_usage WHERE user_id = ? AND pin_order IS NOT NULL) WHERE user_id = ? AND kind = ? AND target = ? AND pin_order IS NULL"
UU_SQL_CLEARPINORDER="UPDATE d1_private.user_usage SET pin_order = NULL WHERE user_id = ? AND kind = ? AND target = ?"
UU_SQL_COMPACTPINS="UPDATE d1_private.user_usage u SET pin_order = r.n FROM (SELECT kind, target, row_number() OVER (ORDER BY pin_order, kind, target) - 1 AS n FROM d1_private.user_usage WHERE user_id = ? AND pin_order IS NOT NULL) r WHERE u.user_id = ? AND u.kind = r.kind AND u.target = r.target"
UU_SQL_SETPINORDER="UPDATE d1_private.user_usage SET pin_order = ? WHERE user_id = ? AND kind = ? AND target = ? AND pinned = true"
UU_SQL_UNPINALL="UPDATE d1_private.user_usage SET pinned = false, pin_order = NULL WHERE user_id = ? AND (pinned = true OR pin_order IS NOT NULL)"
UU_SQL_GETPREFS="SELECT pins_seeded, prefs FROM d1_private.user_prefs WHERE user_id = ?"
UU_SQL_MARKSEEDED="INSERT INTO d1_private.user_prefs (user_id, pins_seeded) VALUES (?, true) ON CONFLICT (user_id) DO UPDATE SET pins_seeded = true, updated_at = now()"
UU_SQL_SETPREFS="INSERT INTO d1_private.user_prefs (user_id, prefs) VALUES (?, ?::jsonb) ON CONFLICT (user_id) DO UPDATE SET prefs = d1_private.user_prefs.prefs || EXCLUDED.prefs, updated_at = now()"
uu_prepare() { # uu_prepare <name> <sql with ?>: a PREPARE with the placeholders numbered
    printf 'PREPARE %s AS ' "$1"
    awk '{ s = $0; out = ""; n = 0; while ((i = index(s, "?")) > 0) { n++; out = out substr(s, 1, i - 1) "$" n; s = substr(s, i + 1) } print out s ";" }' <<<"$2"
}
uu_stmt() { # uu_stmt <statements>: the real statements prepared, two users and a shadow directus_activity, then ROLLBACK
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$UU_A'), ('$UU_B');
CREATE TEMP TABLE directus_activity (id integer PRIMARY KEY, action varchar(45) NOT NULL, "user" uuid,
    "timestamp" timestamptz NOT NULL DEFAULT now(), collection varchar(64) NOT NULL, item varchar(255) NOT NULL);
$(uu_prepare lock "$UU_SQL_LOCK")
$(uu_prepare getrow "$UU_SQL_GETROW")
$(uu_prepare upsert "$UU_SQL_UPSERT")
$(uu_prepare list "$UU_SQL_LIST")
$(uu_prepare getcursor "$UU_SQL_GETCURSOR")
$(uu_prepare setcursor "$UU_SQL_SETCURSOR")
$(uu_prepare startid "$UU_SQL_STARTID")
$(uu_prepare maxid "$UU_SQL_MAXID")
$(uu_prepare activity "$UU_SQL_ACTIVITY")
$(uu_prepare delunpinned "$UU_SQL_DELUNPINNED")
$(uu_prepare zeropinned "$UU_SQL_ZEROPINNED")
$(uu_prepare getpins "$UU_SQL_GETPINS")
$(uu_prepare pinappend "$UU_SQL_PINAPPEND")
$(uu_prepare clearpinorder "$UU_SQL_CLEARPINORDER")
$(uu_prepare compactpins "$UU_SQL_COMPACTPINS")
$(uu_prepare setpinorder "$UU_SQL_SETPINORDER")
$(uu_prepare unpinall "$UU_SQL_UNPINALL")
$(uu_prepare getprefs "$UU_SQL_GETPREFS")
$(uu_prepare markseeded "$UU_SQL_MARKSEEDED")
$(uu_prepare setprefs "$UU_SQL_SETPREFS")
$1
ROLLBACK;
SQL
}
UU_TS="'2026-10-12 09:00:00+00'"
uu_out=$(uu_stmt "EXECUTE lock('$UU_A');
EXECUTE upsert('$UU_A', 'page', 'samples', 1, $UU_TS, false, NULL);
EXECUTE upsert('$UU_B', 'page', 'samples', 7, $UU_TS, true, NULL);
EXECUTE upsert('$UU_A', 'page', 'samples', 2.5, $UU_TS, true, NULL);
SELECT 'uu_up:' || count(*) || ',' || (SELECT score || '/' || pinned FROM d1_private.user_usage WHERE user_id = '$UU_A') || ',' || (SELECT score FROM d1_private.user_usage WHERE user_id = '$UU_B') FROM d1_private.user_usage;
CREATE TEMP TABLE got AS EXECUTE getrow('$UU_A', 'page', 'samples');
CREATE TEMP TABLE got2 AS EXECUTE getrow('$UU_A', 'page', 'other');
SELECT 'uu_get:' || (SELECT count(*) FROM got) || ',' || (SELECT count(*) FROM got2);")
grep -q 'uu_up:2,2.5/true,7' <<<"$uu_out" && ok "the visit upsert's ON CONFLICT (user_id, kind, target) updates one user's row and leaves another user's alone" || bad "visit upsert gave the wrong rows (output: $uu_out)"
grep -q 'uu_get:1,0' <<<"$uu_out" && ok "the row lookup finds the user's row and only that one" || bad "row lookup gave the wrong rows (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'visible', 1, $UU_TS, false, NULL);
EXECUTE upsert('$UU_A', 'page', 'revisited', 1, '2026-10-12 10:00:00+00', false, '2026-10-12 09:00:00+00');
EXECUTE upsert('$UU_A', 'page', 'hidden', 1, $UU_TS, false, '2026-10-12 09:00:00+00');
EXECUTE upsert('$UU_A', 'record', 'hidden_later', 1, $UU_TS, false, '2026-10-12 11:00:00+00');
EXECUTE upsert('$UU_B', 'page', 'bobs', 1, $UU_TS, false, NULL);
CREATE TEMP TABLE listed AS EXECUTE list('$UU_A');
SELECT 'uu_list:' || string_agg(kind || '/' || target, ',' ORDER BY target) FROM listed;")
grep -qx 'uu_list:page/revisited,page/visible' <<<"$uu_out" && ok "the list predicate hides an item until it is used again after hidden_at, and returns only the caller's rows" || bad "list predicate gave the wrong rows (output: $uu_out)"
uu_out=$(uu_stmt "INSERT INTO directus_activity (id, action, \"user\", collection, item)
    SELECT g, 'update', '$UU_A', 'physical_samples', gen_random_uuid()::text FROM generate_series(1, 600) g;
INSERT INTO directus_activity (id, action, \"user\", collection, item) VALUES
    (601, 'update', '$UU_B', 'physical_samples', 'b'), (602, 'delete', '$UU_A', 'physical_samples', 'x'),
    (603, 'create', '$UU_A', 'directus_users', 'y'), (604, 'create', '$UU_A', 'campaigns', 'z');
UPDATE directus_activity SET \"timestamp\" = now() - interval '40 days' WHERE id <= 2;
CREATE TEMP TABLE page1 AS EXECUTE activity('$UU_A', 0, 'physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'people', 'equipment');
SELECT 'uu_fold1:' || count(*) || ',' || min(id) || ',' || max(id) || ',' || count(*) FILTER (WHERE id > 600) FROM page1;
CREATE TEMP TABLE page2 AS EXECUTE activity('$UU_A', 550, 'physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'people', 'equipment');
SELECT 'uu_fold2:' || count(*) || ',' || min(id) || ',' || max(id) || ',' || string_agg(DISTINCT collection, ',') FROM page2;
CREATE TEMP TABLE sid AS EXECUTE startid(now() - interval '30 days');
CREATE TEMP TABLE mid AS EXECUTE maxid;
SELECT 'uu_ids:' || (SELECT id FROM sid) || ',' || (SELECT id FROM mid);")
grep -q 'uu_fold1:500,1,500,0' <<<"$uu_out" && ok "the fold scan takes at most 500 of the user's rows, oldest id first, and no one else's" || bad "fold scan page 1 is wrong (output: $uu_out)"
grep -q 'uu_fold2:51,551,604,campaigns,physical_samples' <<<"$uu_out" && ok "the fold scan from a cursor skips other users, deletes and other collections" || bad "fold scan from a cursor is wrong (output: $uu_out)"
grep -q 'uu_ids:2,604' <<<"$uu_out" && ok "the first-fold start id is the newest activity older than the cutoff; the newest id is the maximum" || bad "start id / max id statements are wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE setcursor('$UU_A', 5);
EXECUTE setcursor('$UU_A', 9);
EXECUTE setcursor('$UU_B', 1);
CREATE TEMP TABLE cur AS EXECUTE getcursor('$UU_A');
SELECT 'uu_cursor:' || (SELECT last_activity_id FROM cur) || ',' || (SELECT count(*) FROM d1_private.user_usage_cursor);")
grep -q 'uu_cursor:9,2' <<<"$uu_out" && ok "the cursor upsert keeps one row per user and the lookup returns the user's own" || bad "cursor statements are wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'pinned', 4, $UU_TS, true, NULL);
EXECUTE upsert('$UU_A', 'page', 'plain', 4, $UU_TS, false, NULL);
EXECUTE upsert('$UU_B', 'page', 'plain', 4, $UU_TS, false, NULL);
EXECUTE delunpinned('$UU_A');
EXECUTE zeropinned('$UU_A');
SELECT 'uu_clear2:' || coalesce(string_agg((user_id = '$UU_A')::text || '/' || target || '/' || score, ',' ORDER BY user_id, target), '') FROM d1_private.user_usage;")
grep -q 'uu_clear2:true/pinned/0,false/plain/4' <<<"$uu_out" && ok "clear deletes the caller's unpinned rows, zeroes the pinned ones, and leaves other users' rows" || bad "clear statements gave the wrong rows (output: $uu_out)"
# The sidebar statements (migration 170), same way.
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'visible', 1, $UU_TS, false, NULL);
EXECUTE upsert('$UU_A', 'page', 'pinned', 1, $UU_TS, true, NULL);
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, false, NULL);
EXECUTE upsert('$UU_A', 'record', 'campaigns:x', 1, $UU_TS, false, NULL);
CREATE TEMP TABLE listed AS EXECUTE list('$UU_A');
SELECT 'uu_home:' || string_agg(kind || '/' || target, ',' ORDER BY target) FROM listed;")
grep -qx 'uu_home:record/campaigns:x,page/visible' <<<"$uu_out" && ok "the Home list leaves out pinned rows and view rows" || bad "Home list predicate is wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'view', '12');
EXECUTE upsert('$UU_A', 'record', 'campaigns:x', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'record', 'campaigns:x');
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
CREATE TEMP TABLE pins AS EXECUTE getpins('$UU_A');
SELECT 'uu_pins1:' || (SELECT string_agg(kind || '/' || target, ',') FROM pins);
SELECT 'uu_pins1b:' || string_agg(target || '=' || pin_order, ',' ORDER BY user_id, pin_order) FROM d1_private.user_usage;")
grep -q 'uu_pins1:page/a,view/12,record/campaigns:x' <<<"$uu_out" && ok "a new pin goes last, whatever its kind, and the pin list is in order" || bad "pin append or list is wrong (output: $uu_out)"
grep -q 'uu_pins1b:a=0,12=1,campaigns:x=2,a=0' <<<"$uu_out" && ok "pinning again keeps the place, and another user's order starts at 0 on its own" || bad "pin append is not per user or not idempotent (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'page', 'b', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'b');
EXECUTE upsert('$UU_A', 'page', 'c', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'c');
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE upsert('$UU_B', 'page', 'b', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'b');
EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, false, NULL);
EXECUTE clearpinorder('$UU_A', 'page', 'a');
EXECUTE compactpins('$UU_A', '$UU_A');
SELECT 'uu_gap:' || string_agg((user_id = '$UU_A')::text || '/' || target || '=' || coalesce(pin_order::text, 'null'), ',' ORDER BY user_id, target) FROM d1_private.user_usage;")
grep -q 'uu_gap:true/a=null,true/b=0,true/c=1,false/a=0,false/b=1' <<<"$uu_out" && ok "an unpin clears its order and compaction closes the gap, for that user only" || bad "gap closing is wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'view', '12');
EXECUTE upsert('$UU_A', 'page', 'plain', 3, $UU_TS, false, NULL);
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE setpinorder(1, '$UU_A', 'page', 'a');
EXECUTE setpinorder(0, '$UU_A', 'view', '12');
EXECUTE setpinorder(7, '$UU_A', 'page', 'plain');
EXECUTE setpinorder(9, '$UU_A', 'page', 'a');
EXECUTE setpinorder(1, '$UU_A', 'page', 'a');
CREATE TEMP TABLE pins AS EXECUTE getpins('$UU_A');
SELECT 'uu_reorder:' || (SELECT string_agg(kind || '/' || target, ',') FROM pins) || ',' || (SELECT coalesce(pin_order::text, 'null') FROM d1_private.user_usage WHERE user_id = '$UU_A' AND target = 'plain') || ',' || (SELECT pin_order FROM d1_private.user_usage WHERE user_id = '$UU_B');")
grep -q 'uu_reorder:view/12,page/a,null,0' <<<"$uu_out" && ok "setting the order writes the caller's pinned rows only (not unpinned rows, not other users)" || bad "set order is wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 2, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'view', '12');
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE unpinall('$UU_A');
SELECT 'uu_unpinall:' || string_agg((user_id = '$UU_A')::text || '/' || target || '/' || pinned || '/' || coalesce(pin_order::text, 'null') || '/' || score, ',' ORDER BY user_id, target) FROM d1_private.user_usage;")
grep -q 'uu_unpinall:true/12/false/null/0,true/a/false/null/2,false/a/true/0/0' <<<"$uu_out" && ok "unpin-all clears the caller's pins and orders, keeps scores, and leaves other users alone" || bad "unpin-all is wrong (output: $uu_out)"
uu_out=$(uu_stmt "CREATE TEMP TABLE p0 AS EXECUTE getprefs('$UU_A');
EXECUTE setprefs('$UU_A', '{\"theme\": \"dark\"}');
EXECUTE setprefs('$UU_A', '{\"sidebarCollapsed\": true, \"theme\": \"light\"}');
EXECUTE markseeded('$UU_A');
EXECUTE setprefs('$UU_B', '{\"autoCollapse\": false}');
EXECUTE markseeded('$UU_A');
CREATE TEMP TABLE p1 AS EXECUTE getprefs('$UU_A');
CREATE TEMP TABLE p2 AS EXECUTE getprefs('$UU_B');
SELECT 'uu_prefs:' || (SELECT count(*) FROM p0) || ',' || (SELECT pins_seeded || ':' || (prefs->>'theme') || ':' || (prefs->>'sidebarCollapsed') FROM p1) || ',' || (SELECT pins_seeded || ':' || (prefs->>'autoCollapse') FROM p2) || ',' || (SELECT count(*) FROM d1_private.user_prefs);")
grep -q 'uu_prefs:0,true:light:true,false:false,2' <<<"$uu_out" && ok "prefs upsert merges keys, marking seeded keeps them, a first prefs write leaves pins_seeded false, one row per user" || bad "prefs statements are wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE setprefs('$UU_A', '{}');
UPDATE d1_private.user_prefs SET updated_at = '2000-01-01';
EXECUTE setprefs('$UU_A', '{\"theme\": \"dark\"}');
SELECT 'uu_prefs_ts:' || (updated_at > '2020-01-01') FROM d1_private.user_prefs;
UPDATE d1_private.user_prefs SET updated_at = '2000-01-01';
EXECUTE markseeded('$UU_A');
SELECT 'uu_seed_ts:' || (updated_at > '2020-01-01') FROM d1_private.user_prefs;")
grep -q 'uu_prefs_ts:t' <<<"$uu_out" && grep -q 'uu_seed_ts:t' <<<"$uu_out" && ok "every prefs write sets updated_at" || bad "updated_at not set on a prefs write (output: $uu_out)"

echo "== Pin order, view pins and user preferences (migration 170) =="
# Same rolled-back-transaction pattern as migration 163 (fixture users UU_A / UU_B, set above).
[[ -f "$UP" ]] && ok "found migration 170" || bad "migration 170 is missing ($UP)"
up_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$UP")
run_eq "user_usage has pin_order (nullable integer)" \
    "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'user_usage' AND column_name = 'pin_order'" "integer:YES"
run_eq "user_prefs is in d1_private, not public, and not in v_schema_dictionary" \
    "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'd1_private' AND tablename = 'user_prefs') || ',' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_prefs') || ',' || (SELECT count(*) FROM v_schema_dictionary WHERE object_name = 'user_prefs')" "1,0,0"
run_eq "d1_llm_readonly cannot read user_prefs" \
    "SELECT has_table_privilege('d1_llm_readonly', 'd1_private.user_prefs', 'SELECT')" "f"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target, pinned, pin_order) VALUES ('$UU_A', 'view', '12', true, 0);
SELECT 'up_view:' || kind || ':' || target || ':' || pin_order FROM d1_private.user_usage WHERE user_id = '$UU_A';")
grep -q 'up_view:view:12:0' <<<"$uu_out" && ok "kind view is accepted, with a pin_order" || bad "view row insert failed (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'other', '1');")
grep -q 'check constraint' <<<"$uu_out" && ok "a kind other than page / record / view is still rejected" || bad "bad kind was not rejected after migration 170 (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples');
SELECT 'up_null:' || coalesce(pin_order::text, '<null>') FROM d1_private.user_usage WHERE user_id = '$UU_A';")
grep -q 'up_null:<null>' <<<"$uu_out" && ok "pin_order is NULL until a row is pinned" || bad "pin_order default is not NULL (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('$UU_A');
SELECT 'up_prefs:' || pins_seeded || ':' || prefs || ':' || (updated_at IS NOT NULL) FROM d1_private.user_prefs WHERE user_id = '$UU_A';")
grep -q 'up_prefs:false:{}:true' <<<"$uu_out" && ok "a preferences row defaults to pins_seeded false and empty prefs" || bad "user_prefs defaults are wrong (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('$UU_A'), ('$UU_A');")
grep -q 'duplicate key' <<<"$uu_out" && ok "one preferences row per user" || bad "second preferences row was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('9e000000-0000-4000-8000-0000000000ff');")
grep -q 'foreign key' <<<"$uu_out" && ok "preferences for a user that does not exist are rejected (foreign key)" || bad "prefs without a user were not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('$UU_A'), ('$UU_B');
DELETE FROM directus_users WHERE id = '$UU_A';
SELECT 'up_cascade:' || count(*) FROM d1_private.user_prefs;")
grep -q 'up_cascade:1' <<<"$uu_out" && ok "deleting a user removes their preferences row, and only theirs" || bad "prefs did not follow their user (output: $uu_out)"
run_eq "user_prefs, its columns and pin_order have comments (without: none)" \
    "SELECT coalesce(string_agg(x, ', '), '') FROM (
        SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname = 'user_prefs' AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND a.attnum > 0 AND NOT a.attisdropped AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
           AND (c.relname = 'user_prefs' OR (c.relname = 'user_usage' AND a.attname = 'pin_order'))) q" ""
# Back-fill and down: run 170's down (back to the 163 shape), seed pins out of order, run its up, check the numbering,
# then add a view pin and run the down again (the view row goes, the order column goes, the old CHECK is back).
uu_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$UU_A'), ('$UU_B');
$up_down
INSERT INTO d1_private.user_usage (user_id, kind, target, pinned, last_at) VALUES
  ('$UU_A', 'page',   'samples',            true,  '2026-10-03'),
  ('$UU_A', 'record', 'physical_samples:x', true,  '2026-10-01'),
  ('$UU_A', 'page',   'tests',              true,  '2026-10-02'),
  ('$UU_A', 'page',   'people',             false, '2026-09-01'),
  ('$UU_B', 'page',   'samples',            true,  '2026-10-05'),
  ('$UU_B', 'page',   'tests',              true,  '2026-10-05');
$up_up
SELECT 'up_bf_a:' || string_agg(target || '=' || pin_order, ',' ORDER BY pin_order) FROM d1_private.user_usage WHERE user_id = '$UU_A' AND pinned;
SELECT 'up_bf_b:' || string_agg(target || '=' || pin_order, ',' ORDER BY pin_order) FROM d1_private.user_usage WHERE user_id = '$UU_B' AND pinned;
SELECT 'up_bf_unpinned:' || coalesce(pin_order::text, '<null>') FROM d1_private.user_usage WHERE user_id = '$UU_A' AND target = 'people';
INSERT INTO d1_private.user_usage (user_id, kind, target, pinned, pin_order) VALUES ('$UU_A', 'view', '12', true, 3);
$up_down
SELECT 'up_dn_kinds:' || string_agg(DISTINCT kind, ',') FROM d1_private.user_usage;
SELECT 'up_dn_rows:' || count(*) FROM d1_private.user_usage;
SELECT 'up_dn_pinned:' || count(*) FROM d1_private.user_usage WHERE pinned;
SELECT 'up_dn_column:' || count(*) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'user_usage' AND column_name = 'pin_order';
SELECT 'up_dn_prefs:' || coalesce(to_regclass('d1_private.user_prefs')::text, 'gone');
SAVEPOINT s;
INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'view', '13');
ROLLBACK;
SQL
)
grep -q 'up_bf_a:samples=0,tests=1,physical_samples:x=2' <<<"$uu_out" && ok "up numbers existing pins by last_at, newest first (as U1 showed them), from 0" || bad "back-fill order is wrong (output: $uu_out)"
grep -q 'up_bf_b:samples=0,tests=1' <<<"$uu_out" && ok "up numbers each user's pins separately (ties broken by kind, target)" || bad "second user's back-fill is wrong (output: $uu_out)"
grep -q 'up_bf_unpinned:<null>' <<<"$uu_out" && ok "up leaves unpinned rows without a pin_order" || bad "unpinned row got a pin_order (output: $uu_out)"
grep -q 'up_dn_kinds:page,record' <<<"$uu_out" && grep -q 'up_dn_rows:6' <<<"$uu_out" && ok "down deletes the view rows and keeps the page and record rows" || bad "down left the wrong rows (output: $uu_out)"
grep -q 'up_dn_pinned:5' <<<"$uu_out" && ok "down keeps pinned = true on the page and record pins" || bad "down lost pinned flags (output: $uu_out)"
grep -q 'up_dn_column:0' <<<"$uu_out" && grep -q 'up_dn_prefs:gone' <<<"$uu_out" && ok "down drops pin_order and user_prefs" || bad "down left pin_order or user_prefs (output: $uu_out)"
grep -q 'check constraint' <<<"$uu_out" && ok "down restores the old CHECK (kind view is rejected again)" || bad "down did not restore the CHECK (output: $uu_out)"

echo "== Lab Member filters put _some only where Directus accepts it =="
# Directus 11 (api apply-query/filter) handles `_some`/`_none` only directly under an O2M field at the
# top of a query, or at the top of the subquery another legal `_some` opens. Anywhere else, e.g.
# `sample_id.co_owners._some` (after a to-one hop), it throws `"_some" can only be used with top level
# relational alias field`. A `_some` subquery also applies the related collection's own permission
# rows, so one bad row 400s every collection whose rule reaches it: 20 Lab Member collections on
# live after hotfix 20261009000142, which kept the outermost `_some` even where it was illegal
# (migration 20261010000160). CI has no Directus, so this checks the stored JSON against that rule,
# using directus_relations for which fields are O2M.
SOME_LINT=$(mktemp)
cat > "$SOME_LINT" <<'PY'
import json, sys
doc = json.loads(sys.stdin.read())
o2m = {(r["one_collection"], r["one_field"]): r["many_collection"] for r in doc["relations"] if r["one_field"]}
m2o = {(r["many_collection"], r["many_field"]): r["one_collection"] for r in doc["relations"] if r["one_collection"]}
bad = []
def scope(coll, node, top, where):
    for key, val in (node or {}).items():
        if key in ("_and", "_or"):
            for sub in val:
                scope(coll, sub, top, where)
        elif not key.startswith("_") and isinstance(val, dict):
            field(coll, key, val, top, where)
def field(coll, key, val, top, where):
    first = next(iter(val), None)
    if first in ("_some", "_none"):
        if top and (coll, key) in o2m:
            scope(o2m[(coll, key)], val[first], True, where)
        else:
            bad.append(f"{where}: {coll}.{key}.{first}")
        return
    if any(k in ("_some", "_none") for k in val):
        bad.append(f"{where}: {coll}.{key} ({'/'.join(val)})")
    nxt = o2m.get((coll, key)) or m2o.get((coll, key))
    for k, v in val.items():
        if nxt and not k.startswith("_") and isinstance(v, dict):
            field(nxt, k, v, False, where)
for row in doc["rows"]:
    for col in ("permissions", "validation"):
        scope(row["collection"], row[col], True, f'{row["policy"]} {row["collection"]}.{row["action"]} {col}')
print(f"illegal:{len(bad)}")
for b in bad[:20]:
    print("  " + b)
PY
some_rows_sql="json_build_object(
  'relations', (SELECT coalesce(json_agg(json_build_object('many_collection', many_collection, 'many_field', many_field,
                 'one_collection', one_collection, 'one_field', one_field)), '[]') FROM directus_relations),
  'rows', (SELECT coalesce(json_agg(json_build_object('policy', policy, 'collection', collection, 'action', action,
                 'permissions', permissions::json, 'validation', validation::json)), '[]') FROM directus_permissions))"
lint_out=$($PSQL -c "SELECT $some_rows_sql" 2>&1 | python3 "$SOME_LINT" 2>&1)
grep -qx "illegal:0" <<<"$lint_out" \
    && ok "no stored permission or validation filter has a _some Directus would reject" \
    || bad "a stored permission filter has a _some Directus 11 rejects (400s the whole policy): $lint_out"
# The lint itself must catch the live failure: the hotfix-142 shape of manufacturing_operations.read.
lint_neg=$(python3 "$SOME_LINT" 2>&1 <<'JSON'
{"relations": [{"many_collection": "manufacturing_operations", "many_field": "sample_id", "one_collection": "physical_samples", "one_field": null},
               {"many_collection": "sample_co_owners", "many_field": "sample_id", "one_collection": "physical_samples", "one_field": "co_owners"}],
 "rows": [{"policy": "p", "collection": "manufacturing_operations", "action": "read", "validation": null,
           "permissions": {"_or": [{"sample_id": {"co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}}]}},
          {"policy": "p", "collection": "physical_samples", "action": "read", "validation": null,
           "permissions": {"_or": [{"co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}]}}]}
JSON
)
grep -qx "illegal:1" <<<"$lint_neg" \
    && ok "the _some lint flags sample_id.co_owners._some (after a to-one hop) and passes top-level co_owners._some" \
    || bad "the _some lint does not tell legal from illegal _some: $lint_neg"

# Migration 20261010000160 from a live-shaped state: seed two rows as hotfix 142 left them on live
# (a read and an update row with `_some` after a to-one hop), apply up, then down. Rolled back.
MIG=db/migrations/20261010000160_lab_member_some_only_where_directus_accepts_it.sql
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG")
gen_perm() { python3 -c 'import json,sys; c,a=sys.argv[1:3]; print(json.dumps(next(x["permissions"] for x in json.load(sys.stdin) if (x["collection"],x["action"])==(c,a))))' "$1" "$2" <<<"$rules_json"; }
gen_mo_read=$(gen_perm manufacturing_operations read)
gen_cs_update=$(gen_perm campaign_samples update)
live_mo_read='{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'
live_cs_update='{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'
sm_out=$($PSQL 2>&1 <<SQL
BEGIN;
$mig_down
SELECT 'down_backup_gone:' || (to_regclass('d1_private.lab_member_some_fix_backup') IS NULL);
UPDATE directus_permissions SET permissions = '$live_mo_read'
 WHERE policy = '$LM' AND collection = 'manufacturing_operations' AND action = 'read';
UPDATE directus_permissions SET permissions = '$live_cs_update'
 WHERE policy = '$LM' AND collection = 'campaign_samples' AND action = 'update';
CREATE TEMP TABLE _before AS SELECT id, policy, permissions::text AS p, validation::text AS v, fields FROM directus_permissions;
SELECT 'pre_lint:' || $some_rows_sql;
$mig_up
SELECT 'up_mo_read:' || (permissions::jsonb = '$gen_mo_read'::jsonb) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'manufacturing_operations' AND action = 'read';
SELECT 'up_cs_update:' || (permissions::jsonb = '$gen_cs_update'::jsonb) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'campaign_samples' AND action = 'update';
SELECT 'up_other_untouched:' || count(*) FROM directus_permissions d FULL JOIN _before b USING (id)
 WHERE d.id IS NULL OR b.id IS NULL OR d.validation::text IS DISTINCT FROM b.v OR d.fields IS DISTINCT FROM b.fields
    OR (b.policy <> '$LM' AND d.permissions::text IS DISTINCT FROM b.p);
SELECT 'up_lint:' || $some_rows_sql;
$mig_down
SELECT 'down_exact:' || count(*) FROM directus_permissions d FULL JOIN _before b USING (id)
 WHERE (d.permissions::text, d.validation::text, d.fields) IS DISTINCT FROM (b.p, b.v, b.fields);
ROLLBACK;
SQL
)
sm_check() { grep -qxF -- "$1" <<<"$sm_out" && ok "$2" || bad "$2 (psql output: $(cut -c1-400 <<<"$sm_out"))"; }
pre_lint=$(sed -n 's/^pre_lint://p' <<<"$sm_out" | python3 "$SOME_LINT" 2>&1 | head -1)
up_lint=$(sed -n 's/^up_lint://p' <<<"$sm_out" | python3 "$SOME_LINT" 2>&1)
[[ "$pre_lint" =~ ^illegal:[1-9] ]] && ok "the live-shaped state before up fails the _some lint ($pre_lint)" \
    || bad "the live-shaped state should fail the _some lint, got: $pre_lint"
grep -qx "illegal:0" <<<"$up_lint" && ok "up: no Lab Member filter has an illegal _some" || bad "up: still illegal: $up_lint"
sm_check "up_mo_read:true" "up: manufacturing_operations.read is the generated filter (amnesty kept)"
sm_check "up_cs_update:true" "up: update rows are fixed too, not only reads (campaign_samples.update)"
sm_check "up_other_untouched:0" "up: only Lab Member permissions change (validation, fields and other policies kept)"
sm_check "down_exact:0" "down: every permission row is back exactly as before up"
sm_check "down_backup_gone:true" "down: the backup table is dropped"
rm -f "$SOME_LINT"

echo "== Operator backfill is safe on an empty database =="
# The generated backfill maps legacy Machine_Operators ids to people by name. Only ids a run still
# points at are mapped, so a fresh database (as CI builds) neither fails the name check nor gains
# the NEW people. Each case runs the up SQL in its own rolled-back transaction (its temp table is
# ON COMMIT DROP, but a second CREATE in one transaction would clash).
OPB=db/migrations/20261001000123_operator_backfill.sql
opb_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$OPB")
opb_fixture="INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000123-0000-4000-8000-0000000000a1', 'T-C-OB', 'operator backfill test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000123-0000-4000-8000-0000000000d1', 'TEST-OB-001');"
opb_out=$($PSQL 2>&1 <<SQL
BEGIN;
UPDATE manufacturing_operations SET operator = NULL WHERE operator IS NOT NULL;
UPDATE test_sessions SET operator = NULL WHERE operator IS NOT NULL;
CREATE TEMP TABLE _opb_before AS SELECT count(*) AS n FROM people;
$opb_up
SELECT 'empty_people_unchanged:' || ((SELECT count(*) FROM people) = (SELECT n FROM _opb_before));
ROLLBACK;
SQL
)
opb_check() { grep -qx "$1" <<<"$opb_out" && ok "$2" || bad "$2 (psql output: $opb_out)"; }
opb_check "empty_people_unchanged:true" "no run points at an operator: up succeeds and adds no people"
opb_out=$($PSQL 2>&1 <<SQL
BEGIN;
$opb_fixture
INSERT INTO "Machine_Operators" (id) VALUES (121), (228) ON CONFLICT (id) DO NOTHING;
INSERT INTO people (person_id, full_name) VALUES ('c0000123-0000-4000-8000-0000000000f1', 'Nick Weston');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code, operator)
VALUES ('c0000123-0000-4000-8000-0000000000c1', 'c0000123-0000-4000-8000-0000000000a1', 'c0000123-0000-4000-8000-0000000000d1', 'TEST-OB-OP', 121);
INSERT INTO test_sessions (session_id, sample_id, operator)
VALUES ('c0000123-0000-4000-8000-0000000000e1', 'c0000123-0000-4000-8000-0000000000d1', 228);
$opb_up
SELECT 'map:' || operator_person_id FROM manufacturing_operations WHERE operation_id = 'c0000123-0000-4000-8000-0000000000c1';
SELECT 'new:' || p.full_name || '/' || p.is_operator FROM test_sessions s JOIN people p ON p.person_id = s.operator_person_id
 WHERE s.session_id = 'c0000123-0000-4000-8000-0000000000e1';
ROLLBACK;
SQL
)
opb_check "map:c0000123-0000-4000-8000-0000000000f1" "a referenced MAP operator is linked to its person"
opb_check "new:Kyle Marshall/true" "a referenced NEW operator gets a new operator person"
opb_out=$($PSQL 2>&1 <<SQL
BEGIN;
$opb_fixture
INSERT INTO "Machine_Operators" (id) VALUES (113) ON CONFLICT (id) DO NOTHING;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code, operator)
VALUES ('c0000123-0000-4000-8000-0000000000c1', 'c0000123-0000-4000-8000-0000000000a1', 'c0000123-0000-4000-8000-0000000000d1', 'TEST-OB-OP', 113);
$opb_up
ROLLBACK;
SQL
)
grep -qF "names missing or ambiguous in people: Xinzef" <<<"$opb_out" \
    && ok "a referenced operator whose person is missing still fails, naming only that person" \
    || bad "a referenced operator whose person is missing still fails, naming only that person (psql output: $opb_out)"

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
