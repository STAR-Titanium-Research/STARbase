# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

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
expect_match sid_out "sample:5d000000$" "a new sample gets the first 8 hex characters of its id"
expect_match sid_out "operation:5d0000000$" "an operation whose 8 characters are taken by a sample gets 9"
expect_match sid_out "test:5d00000000$" "a test whose 8 and 9 characters are taken gets 10"
expect_match sid_out "lookup:manufacturing_operations/5d000000-0000-4000-8000-000000000202" "record_by_short_id finds the record (case-insensitive)"
expect_match sid_out "guard:ok" "changing a short_id is refused"
expect_match sid_out "samecode:5d000000$" "a refused change leaves the short_id as it was"
expect_match sid_out "other_update:5d000000$" "other updates keep the short_id"
expect_match sid_out "deleted_lookup:0" "a deleted record's short ID resolves to nothing"
expect_match sid_out "registry_kept:1" "a deleted record's short ID stays reserved"
expect_match sid_out "no_reuse:5d000000000$" "a reserved short ID is never handed out again"
expect_match sid_out "not_null:3" "short_id is NOT NULL on the three tables"
expect_match sid_out "directus_rows:3" "the three short_id fields are registered read-only in Directus"
expect_match sid_out "comments:1" "short_ids carries a table comment"
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
expect_match fmt_out "fmt_sample:ok" "a sample inserted without a short_id (trigger bypassed) is refused by the format CHECK"
expect_match fmt_out "fmt_operation:ok" "an operation inserted without a short_id (trigger bypassed) is refused by the format CHECK"
expect_match fmt_out "fmt_test:ok" "a test inserted without a short_id (trigger bypassed) is refused by the format CHECK"

echo "== Short IDs: the back-fill (T0a) =="
# Runs the real back-fill SQL, extracted from migration 150 between its backfill:start / backfill:end
# markers, on rows made to look like pre-migration data (short_id NULL, no registry row), inside
# a rolled-back transaction. The three user-trigger sets are bypassed for the setup and must be
# back to enabled ('O') afterwards. The guard is run on its own, on a trigger set to ENABLE ALWAYS.
SID_MIG=$(migration short_ids)
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
expect_match bf_out "bf_setup:3$" "(setup) the three rows have no short_id before the back-fill"
expect_match bf_out "is not enabled in its normal state" "the back-fill guard refuses a user trigger that is ENABLE ALWAYS"
expect_match bf_out "bf_short:6b000000/6b0000000/6b00000000$" "the back-fill assigns short IDs, lengthening on a clash across the three tables"
expect_match bf_out "bf_versions:7/5/3$" "the back-fill leaves each version as it was"
expect_match bf_out "bf_vsum:true$" "the back-fill changes no version in the three tables"
expect_match bf_out "bf_audit:0$" "the back-fill writes no audit rows"
expect_match bf_out "bf_nulls:0/0/0$" "no row is left without a short_id"
expect_match bf_out "bf_registry:3$" "the back-fill registers the three short IDs"
expect_match bf_out "bf_triggers:0/" "every user trigger on the three tables is enabled again after the back-fill"
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
expect_match tc_out "nocode:null$" "a test with no subject has no code"
expect_match tc_out "first:TEST-TC-001-SEM1/false$" "linking the first subject gives {sample code}-{TYPE}1, automatic"
expect_match tc_out "second:TEST-TC-001-SEM1$" "linking a second subject changes nothing"
expect_match tc_out "next:TEST-TC-001-SEM2$" "the next SEM test on the sample gets 2"
expect_match tc_out "resave:TEST-TC-001-SEM2/false$" "re-saving the same code keeps it automatic"
expect_match tc_out "type:TEST-TC-001-XRD1$" "a type change takes the next number of the new type"
expect_match tc_out "noreuse:TEST-TC-001-SEM3$" "a number that moved away is not handed out again"
expect_match tc_out "typed:MY-CODE/true$" "a typed code is kept and flagged as typed"
expect_match tc_out "typed_kept:MY-CODE$" "a typed code survives a type change"
expect_match tc_out "cleared:TEST-TC-001-TEM1/false$" "clearing a typed code goes back to automatic with the current type"
expect_match tc_out "typed_insert:TEST-TC-001-SEM4/true$" "a code given on insert is typed (and trimmed)"
expect_match tc_out "skip_taken:TEST-TC-001-SEM5$" "an automatic code skips a number someone typed by hand"
expect_match tc_out "edge:TEST-TC-BOX-1A-HRD1$" "an insert-edge subject uses the edge code"
expect_match tc_out "edge_kept:TEST-TC-BOX-1A-HRD1$" "adding a sample to an edge test keeps the edge-based code"
expect_match tc_out "notype:null$" "a test with a subject but no type has no code"
expect_match tc_out "type_arrives:TEST-TC-001-DMA1$" "setting the type gives the code (upper-case junction item accepted)"
expect_match tc_out "junk_subject:TEST-TC-001-DMA1$" "a junk junction item linked earlier is skipped when building the code"
expect_match tc_out "cascade:TEST-TC-001B-SEM3$" "a corrected sample code flows into its tests' automatic codes"
expect_match tc_out "cascade_typed:TEST-TC-001-SEM4$" "a typed code ignores a sample code change"
expect_match tc_out "cascade_edge_test:TEST-TC-BOX-1A-HRD1$" "a sample code change leaves an edge-based code alone"
expect_match tc_out "cascade_edge:TEST-TC-BOX-1Z-HRD1$" "a corrected edge code flows into its tests"
expect_match tc_out "promoted:TEST-TC-002-XRD1$" "removing the code's subject re-codes the test from the next subject"
expect_match tc_out "orphan:TEST-TC-002-XRD1$" "a test that loses all its subjects keeps its last code"
expect_match tc_out "unique:ok" "test codes are unique"
expect_match tc_out "directus:6$" "the six test-code fields are registered in Directus"
expect_match tc_out "directus_visible:1$" "only test_code is visible on the form"
expect_match tc_out "orphan_rename:TEST-TC-ORP-SEM1$" "renaming the old subject of an orphaned test keeps its code"
expect_match tc_out "notype_rename:TEST-TC-NUL-SEM1$" "renaming the subject of a test whose type was cleared keeps its code"

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
expect_match cg_out "cg_source:TEST-CG-001-SEM1/1$" "(setup) the source test is TEST-CG-001-SEM1, number 1"
expect_match cg_out "copy_nocode:TEST-CG-001-SEM2$" "a copy carrying the source's bookkeeping but no code gets the next free number"
expect_match cg_out "copy_unique:ok" "a copy carrying the source's code is refused as a duplicate"
expect_match cg_out "bookkeeping_ignored:TEST-CG-001-SEM1/1/sem/physical_samples/true$" "an UPDATE of the test_code_* bookkeeping columns is ignored"
expect_match cg_out "rename_before:TEST-CG-003-SEM1$" "(setup) the renamed sample's test starts as TEST-CG-003-SEM1"
expect_match cg_out "rename_taken:TEST-CG-004-SEM2$" "renaming a subject to a name whose rebuilt code is taken draws the next number"

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
expect_line fb_out "fb_direct:TEST-FB-001-SEM1" "a test written with sample_id and no junction row is coded at INSERT"
expect_line fb_out "fb_junction_after:TEST-FB-001-SEM1" "the junction row that follows leaves that code unchanged"
expect_line fb_out "fb_clone:TEST-FB-001-SEM2" "a copy carrying sample_id and the source's bookkeeping is coded at INSERT with the next number"
expect_line fb_out "fb_clone_junction:TEST-FB-001-SEM2" "the copy's junction row leaves its code unchanged"
expect_line fb_out "fb_edge:TEST-FB-BOX-1A-HRD1" "a test written with insert_edge_id and no junction row is coded from the edge"
expect_line fb_out "fb_edge_junction:TEST-FB-BOX-1A-HRD1" "the edge test's junction row leaves its code unchanged"
expect_line fb_out "fb_notype:null" "a direct subject without a test type gives no code"
expect_line fb_out "fb_type_arrives:TEST-FB-001-DMA1" "setting the type then gives the code from the direct subject"
expect_line fb_out "fb_linked:TEST-FB-002-SEM1" "a junction-linked test is coded as before"
expect_line fb_out "fb_orphan:TEST-FB-002-SEM1/true" "a test that loses its only junction subject keeps its code (the fallback finds nothing)"
expect_line fb_out "fb_cascade:TEST-FB-001B-SEM1" "a corrected sample code flows into a fallback-coded test"
expect_line fb_out "fb_cascade_clone:TEST-FB-001B-SEM2" "a corrected sample code flows into a copy's fallback code, keeping its number"
expect_line fb_out "fb_cascade_edge:TEST-FB-BOX-1Z-HRD1" "a corrected edge code flows into a fallback-coded edge test"

echo "== Deleting samples and edges that are test subjects =="
# Same fixture style as above; every row is rolled back. The back-fill statements are extracted
# from the migration so the direct-value case runs the real SQL.
PS=$(migration test_sessions_primary_subject_sync)
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
expect_line ds_out "del_primary:1/true/1" "deleting the primary sample of a two-sample test keeps the test and promotes the next sample"
expect_line ds_out "del_lone:0/0" "deleting a test's only sample deletes the test (and its junction rows)"
expect_line ds_out "del_lone_audit:0/1" "deleting a test's only sample leaves no UPDATE of the doomed test in the audit trail, only its DELETE"
expect_line ds_out "del_secondary:1/true/2" "deleting a secondary sample removes its junction row and leaves the primary"
expect_line ds_out "del_sample_keeps_edge:1/true/true" "deleting a test's last sample keeps a test that still has an edge subject"
expect_line ds_out "del_legacy:0" "deleting the sample of a column-only test deletes the test, as before"
expect_line ds_out "fk:n" "test_sessions_sample_fkey is ON DELETE SET NULL"
expect_line ds_out "other_sample:1" "the test's other sample is not deleted"

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
expect_line bf_out "bf_keeps_direct:true/true" "back-fill keeps a direct sample_id when the junction only had an edge"
expect_line bf_out "bf_junction:2" "back-fill copies the direct sample and edge into the junction"
expect_line bf_out "bf_swap:true/1/0" "back-fill does not resurrect a swapped-out sample: the stale sample_id is not copied back and becomes the junction's sample"
expect_line bf_out "bf_audited_removal:true/0" "back-fill does not copy back a sample the audit trail shows was removed from the test's subjects"

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
expect_line dn_out "dn_pre:true" "(setup) the two-sample test has its derived primary sample before the rollback"
expect_line dn_out "dn_idx_comments:3" "the three new indexes carry comments"
for idx in test_sessions_sample_id_idx test_sessions_insert_edge_id_idx test_sessions_subject_target_lower_idx; do
    grep -q "using $idx" <<<"$dn_out" && ok "the planner can use $idx for the trigger lookups" || bad "$idx is not used (psql output: $dn_out)"
done
expect_line dn_out "dn_cleared:true/true" "down clears sample_id on a multi-sample test and keeps it on a one-sample test"
expect_line dn_out "dn_survives:1" "after down, deleting a multi-sample test's first sample no longer deletes the test"
expect_line dn_out "dn_cascade:0" "after down, a one-sample test is deleted with its sample (the restored cascade)"
expect_line dn_out "dn_fk:c" "down restores test_sessions_sample_fkey ON DELETE CASCADE"
expect_line dn_out "dn_idx_gone:0" "down drops the three indexes"
expect_line dn_out "dn_triggers_gone:0" "down drops the sync and delete triggers"
