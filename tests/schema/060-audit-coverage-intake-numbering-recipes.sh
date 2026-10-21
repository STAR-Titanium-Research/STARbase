# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Audit coverage: every business table, keyed by its primary key (review 5.3) =="
# Tables deliberately NOT audited: the log itself, dbmate bookkeeping, Directus system tables,
# derived caches (project_rollup, semantic_embeddings), the crawler's heartbeat row,
# audit_log_actors (the actor side-table of the log itself), short_ids (the short-ID registry:
# write-once bookkeeping written only by claim_short_id()), test_code_counters (test-code number
# bookkeeping written only by next_test_code_number()), file_fingerprints (derived data: content
# hashes of directus_files rows, written only by scripts/file_fingerprints.py and recomputable at
# any time, so an audit row would record nothing a re-run cannot). Migration 141's backup of Directus
# permission rows lives in the private schema d1_private, so this public-schema check never sees it.
# The readers tables of migration 166 (sample_readers, operation_readers, test_readers, campaign_readers, project_readers,
# campaign_sample_readers, operation_open_to_all) are derived caches written only by the recompute triggers: not audited either.
# file_readers (migration 196) is the readers table of directus_files, derived and written only by its triggers: not audited either.
# team_events (migration 181) is the history of a team, written only by the team triggers and the sharing code: it is a log, so not audited either.
# bulk_actions and bulk_action_rows (migration 204) are the journal of bulk actions: append-only history of who changed which records (with each row's before and after), written only by the d1-bulk-actions endpoint. A log, so not audited itself.
AUDIT_EXCLUDED="'audit_logs','audit_log_actors','schema_migrations','project_rollup','semantic_embeddings','force_crawler_state','short_ids','test_code_counters','file_fingerprints','team_events','bulk_actions','bulk_action_rows','file_readers','sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all'"
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
expect_line au_out "people_actions:INSERT,UPDATE,DELETE" "people: INSERT, UPDATE and DELETE each write an audit row keyed by person_id"
expect_line au_out "people_changed:Audit Test Person>Audit Test Renamed" "people: UPDATE records the changed field (old and new)"
expect_line au_out "people_delete_before:Audit Test Renamed" "people: DELETE keeps the row as it was"
expect_line au_out "element_actions:INSERT,UPDATE,DELETE" "alloying_elements: audit rows keyed by its text primary key (symbol)"
expect_line au_out "element_changed:element_name" "alloying_elements: UPDATE changed_fields lists exactly the changed columns"
expect_line au_out "unknown_ids:0" "no audit row is logged with record_id 'unknown'"

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
expect_line rid_out "op_record_id:c0000000-0000-4000-8000-0000000000c5" "operation audit rows carry operation_id, not sample_id"
expect_line rid_out "ts_record_id:c0000000-0000-4000-8000-0000000000e3" "test session audit rows carry session_id, not sample_id"
expect_line rid_out "method_record_id:c0000000-0000-4000-8000-0000000000a3" "newly audited manufacturing_methods carries method_id"

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
expect_line mfa_out "mfa_rows:2" "machining_force_analysis: INSERT and UPDATE are audited"
expect_line mfa_out "mfa_big_omitted:0" "machining_force_analysis: series/fft/diag_metrics are left out of the snapshots"
expect_line mfa_out "mfa_status_logged:done" "machining_force_analysis: ordinary columns are still logged"

# Issue #190: a Force App cut over the recorder's .mat size limit has no .mat, so its analysis row
# goes in with directus_files_id NULL. The column must accept that (several NULLs, UNIQUE kept), and
# the down migration must refuse while such rows exist rather than silently deleting them.
NUL=$(migration machining_force_analysis_file_nullable)
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
expect_line nul_out "nul_rows:2" "machining_force_analysis: rows with a NULL directus_files_id insert (a cut with no .mat)"
expect_line nul_out "nul_unique_kept:1" "machining_force_analysis: the UNIQUE constraint on directus_files_id is kept"
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
expect_line occ_out "stale_rows:0" "tool_setup: an update on a stale version matches no row"
expect_line occ_out "version:2 notes:writer one" "tool_setup: version is bumped once and the stale write did not land"

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
expect_line bi_out "boxes:TST4-1,TST4-2,TST4-3" "intake of 3 creates TST4-1..3"
expect_line bi_out "inserts:6" "2 inserts per box x 3 boxes"
expect_line bi_out "edges:12" "2 edges per insert x 6 inserts"
expect_line bi_out "owned_boxes:3" "owner_person_id and owner are copied onto every box (clones included)"
expect_line bi_out "owned_inserts:6" "owner_person_id and owner are copied onto every insert"
expect_line bi_out "owned_edges:12" "owner_person_id and owner are copied onto every edge"
expect_line bi_out "boxes_after:TST4-1,TST4-3,TST4-4,TST4-5" "intake after a box delete continues from the highest code (no collision)"

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
expect_line oc_out "no_flag_children_unchanged:2/4" "owner change without cascade_ownership does not touch children"
expect_line oc_out "box_cascade_inserts:2" "box cascade: every insert gets the box's owner_person_id"
expect_line oc_out "box_cascade_edges:4" "box cascade: every edge of those inserts gets it too"
expect_line oc_out "box_flag_reset:true" "box cascade: cascade_ownership is reset to false"
expect_line oc_out "insert_cascade_own_edges:2" "insert cascade: the insert's edges get its owner_person_id"
expect_line oc_out "insert_cascade_other_edges:2" "insert cascade: other inserts' edges are untouched"
expect_line oc_out "insert_flag_reset:true" "insert cascade: cascade_ownership is reset to false"
expect_line oc_out "stored_owner_edges:4" "flag alone propagates the stored owner"
expect_line oc_out "null_owner_inserts:2" "a NULL owner is propagated to inserts"
expect_line oc_out "null_owner_edges:4" "a NULL owner is propagated to edges"
expect_line oc_out "legacy_owner_untouched:4" "the legacy owner column is not written by the cascade"

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
expect_line bt_out "boxes:TST5-1,TST5-2" "an intake row with a quantity expands into that many boxes"
expect_line bt_out "inserts:4" "2 boxes x 2 inserts are created"
expect_line bt_out "edges:8" "4 inserts x 2 edges are created"
expect_line bt_out "clone_sentinel:0" "clone boxes carry package_quantity = 0 (no re-expansion)"
expect_line bt_out "owned_edges:8" "owner_person_id reaches every edge through the trigger path"
expect_line bt_out "boxes_second_call:TST5-1,TST5-2" "a second expand_tool_box_intake() call creates no boxes and renames nothing"
expect_line bt_out "inserts_second_call:4" "a second call creates no inserts"
expect_line bt_out "edges_second_call:8" "a second call creates no edges"
expect_line bt_out "untouched_boxes:5" "explicit code, NULL, 0 quantity and typeless boxes are not expanded"
expect_line bt_out "legacy_code_kept:1" "a box with an explicit code and a quantity (legacy import) keeps both"
expect_line bt_out "no_type_box:1" "a quantity without an insert type is left alone, no error"
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
expect_line seq_out "op:0421:1:TI-S1-HTA1-800C_60min_AC" "a new heat-treatment op gets sequence 1 and a code that carries it"
expect_line seq_out "op:0422:2:TI-S1-DR2-20C_50pct" "a new deformation op gets the next number, in its code too"
expect_line seq_out "op:0423:3:TI-S1-AM3-200W" "a new additive op gets the next number, in its code too"
expect_line seq_out "op:0424:9:TI-S1-F9-20MPM" "a supplied (machining pass) number is kept"
expect_line seq_out "op:0425:10:TI-S1-HTS10" "the next blank number continues after the highest one"
expect_line seq_out "op:0426:1:TI-S2-HTA1" "numbering restarts per sample"
expect_line seq_out "op:0427:2:MY-OWN-CODE" "a typed code without a placeholder is stored unchanged"
expect_line seq_out "op:0428:null:TI-NOSAMPLE-X" "an operation without a sample keeps a NULL sequence and a typed code"
mf_exp=$(grep -m1 '^mf_explicit:' <<<"$seq_out" | cut -d: -f2)
expect_line seq_out "op:0429:null:TI-IMP-FAST" "an imported row (source_system set) is not auto-numbered, even with a sample"
expect_line seq_out "op:042a:1:TI-IMP-F1" "an imported row's explicit number is kept"
expect_line seq_out "mf:0431:01-01-26-MF${mf_exp}-950C" "an explicit MF number is stored as given"
expect_line seq_out "regen:TI-S1-HTA1-800C_60min_AC:1" "regenerating with an old client's {seq} placeholder code gives the rule's code, never a raw placeholder"

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
sc_base=$(grep -m1 '^base:' <<<"$sc_out" | cut -d: -f2)
expect_line sc_out "code:0611:$((sc_base + 1))-TI-MF-2026-10-4" "a {seq}- sample code gets max+1 and keeps the rest of the code"
expect_line sc_out "code:0612:$((sc_base + 2))-TI-HT-2026-10-4" "the next one gets the next number"
expect_line sc_out "code:0613:TI-HAND-TYPED" "a hand-typed code without the placeholder is stored as given"
expect_line sc_out "code:0614:$((sc_base + 500))-TI-OLD-2020-1-1" "an explicit number is stored as given"
expect_line sc_out "code:0615:$((sc_base + 501))-TI-MF-2026-10-5" "a later placeholder continues after the highest number in use"
expect_line sc_out "renumber:$((sc_base + 501))-TI-MF-2026-10-5" "renumbering excludes the row's own number"
expect_line sc_out "untouched:$((sc_base + 1))-TI-MF-2026-10-4" "an unrelated update does not renumber"
expect_line sc_out "preview:$((sc_base + 502))" "next_sample_code_number() previews max+1 over every sample"
expect_line sc_out "preview_excl:$((sc_base + 501))" "next_sample_code_number(id) ignores that sample's own number"

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
act_do=$(sed -n '/^-- migrate:up/,/^-- migrate:down/p' $(migration audit_actor_from_directus_activity) \
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
expect_line act_out "trigger:1" "the migration's block installs the directus_activity trigger"
expect_line act_out "raw_actor_null:2" "setup: the audit rows carried no actor (the hook could not reach the transaction)"
expect_line act_out "attributed:INSERT=c0000000-0000-4000-8000-000000000799/true,UPDATE=c0000000-0000-4000-8000-000000000799/true" "INSERT and UPDATE audit rows are attributed to the Directus user"
expect_line act_out "actor_rows:2" "one side-table row per attributed audit row, no duplicates"
expect_line act_out "public:public" "an unauthenticated write is attributed to 'public'"
expect_line act_out "old_rows:0" "an audit row from an earlier transaction is not re-attributed"
expect_line act_out "guc:guc-user/false" "an actor set through the GUC wins over the fallback"
expect_line act_out "child_edges:8/8" "audit rows of the intake's child edges (written by a trigger) are attributed too"
expect_line act_out "child_boxes:1/1" "so are the clone box rows the intake trigger created"
expect_line act_out "child_unattributed:0" "no audit row of the transaction is left without an actor"
expect_line act_out "guc_rows:0" "a GUC-attributed row gets no side-table row"

# The migration's down section refuses to drop a populated audit_log_actors unless the loss is accepted.
act_down=$(sed -n '/^-- migrate:down/,$p' $(migration audit_actor_from_directus_activity))
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
expect_line pc_out "rederived:sintering" "changing the method re-derives the category (heat_treatment -> sintering)"
expect_line pc_out "cat:0821:machining" "a later edit of the category (method unchanged) is not overwritten"
expect_line pc_out "cat:0822:additive" "a category set in the same statement as a method change wins"
expect_line pc_out "cat:0823:machining" "an unmapped method never blanks a stored category"
expect_line pc_out "cat:0824:null" "an unmapped method on a blank category stays blank (nothing invented)"
expect_line pc_out "seed_MP:sample_prep" "the method map covers MP (sample preparation), which the old SQL map missed"
expect_line pc_out "seed_HT:heat_treatment" "the method map covers HT"
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
expect_line pr_out "steps:1:grinding:P1200,2:polishing:-" "a prep operation created with a recipe gets its steps, in order"
expect_line pr_out "steps_after_switch:2" "existing steps are never clobbered by another recipe"
expect_line pr_out "empty_recipe_steps:0" "an empty recipe copies nothing"
expect_line pr_out "late_apply_steps:1" "setting a recipe on an existing prep operation without steps applies it"
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
