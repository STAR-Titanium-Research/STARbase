# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

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
       AND ((c.table_name = 'manufacturing_operations' AND c.column_name ~ '^(machining|sintering|ht|deform|am|conform)_')
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
RIM=$(migration restore_inline_param_field_meta)
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
expect_line rim_out "seeded_missing:115" "setup: the incident state is reproduced (115 inline columns without a row; the 116th is the customised one)"
expect_line rim_out "up_missing:0" "up: every inline parameter column has a row again"
expect_line rim_out "up_ops_rows:56" "up: 56 manufacturing_operations parameter rows"
expect_line rim_out "up_sessions_rows:60" "up: 60 test_sessions parameter rows"
expect_line rim_out "up_custom_row:1,custom note" "up: a present, customised row is left as it is (not duplicated, not replaced)"
expect_line rim_out "up_owner_picker:1,d1-owner-picker" "up: the d1-owner-picker interface of 20261001000126_owner_picker_fields.sql is untouched"
expect_line rim_out "up_machine_group:10" "up: ten machine-sourced sintering fields are in the machine group"
expect_line rim_out "up_qa_group:5" "up: five QA fields are in the QA group"
expect_line rim_out "up_hidden_recipe_number:true" "up: the free-text sintering recipe number is hidden (migration 102)"
expect_line rim_out "up_presets:5" "up: the five SEM/XRD dropdown presets are restored"
expect_line rim_out "up_relation:1,prep_recipes" "up: manufacturing_operations.source_recipe_id is related to prep_recipes"
expect_line rim_out "up_alias_with_relation:3" "up: prep_steps, source_recipe_id and data_file_links aliases are restored"
expect_line rim_out "up_alias_without_relation:0" "up: an o2m alias whose relation is missing is not inserted"
expect_line rim_out "up2_rollup:1" "up (second run): fills the gap once the relation exists"
expect_line rim_out "up2_inline_rows:116" "up (second run): no inline row is added twice"
expect_line rim_out "up2_duplicates:0" "up (second run): no (collection, field) is duplicated"
expect_line rim_out "up2_relations:1" "up (second run): the relation is not duplicated"
expect_line rim_out "down_inline_rows:1" "down: removes the inline rows it added and keeps the one that was there"
expect_line rim_out "down_custom_row:1,custom note,no group" "down: the pre-existing row keeps its content and its group is cleared"
expect_line rim_out "down_aliases:0" "down: removes the four alias fields"
expect_line rim_out "down_relation:0" "down: removes the source_recipe_id relation"
expect_line rim_out "down_other_relations:3" "down: leaves relations it did not add"
expect_line rim_out "down_owner_picker:1,d1-owner-picker" "down: the owner picker is still untouched"
expect_line rim_out "down_ledger:dropped" "down: drops its bookkeeping table"
