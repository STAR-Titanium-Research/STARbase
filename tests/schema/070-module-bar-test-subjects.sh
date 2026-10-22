# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Module bar: Home first, Data Studio after the dashboards =="
# directus_settings is a stub in CI: seed the shipped bar, apply the migration's up then down in a
# rolled-back transaction, and assert the order after each, plus the cases the shipped bar does not
# cover (a curated bar that already lists home, no dashboards, a NULL bar).
MB=$(migration module_bar_home_first)
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
expect_line mb_out "up:home,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,content,settings" "up: Home first, Data Studio right after the dashboards"
expect_line mb_out "up_again:home,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,content,settings" "up: running it twice changes nothing"
expect_line mb_out "down:content,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,settings" "down: Home removed, Data Studio back at the front"
expect_line mb_out "down_exact:true" "down: the shipped bar is restored exactly"
expect_line mb_out "curated:home=false,users=true,d1-force-dashboard=true,settings=true" "up: an existing Home entry moves first and keeps its enabled flag; content is not added"
expect_line mb_out "idless_dup_home:home=false,?=true,users=true" "up: an entry with no id is kept, and a duplicate home entry is dropped (the first one wins)"
expect_line mb_out "no_dashboards:home,users,content" "up: without dashboards the Data Studio keeps its place"
expect_line mb_out "null_kept:true" "a NULL module bar is left alone"

echo "== Module bar: the STARbase duplicates leave; the STARbase link tile =="
M171=$(migration module_bar_drop_starbase_duplicates)
m171_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$M171")
m171_down=$(awk '/-- migrate:down/{f=1;next}f' "$M171")
link_sql=$(sed "s#:'public_url'#'https://d1.example.org/'#g" scripts/module_bar_starbase_link.sql)
m171_bar='[{"type":"module","id":"home","enabled":true},{"type":"module","id":"users","enabled":true},{"type":"module","id":"files","enabled":true},{"type":"module","id":"insights","enabled":true},{"type":"module","id":"d1-lab-dashboard","enabled":true},{"type":"module","id":"d1-force-dashboard","enabled":true},{"type":"module","id":"d1-fast-dashboard","enabled":true},{"type":"module","id":"content","enabled":true},{"type":"module","id":"settings","enabled":true}]'
m171_out=$($PSQL 2>&1 <<SQL
BEGIN;
DELETE FROM directus_settings;
INSERT INTO directus_settings (id, module_bar) VALUES (1, '$m171_bar');
$m171_up
SELECT 'up:' || ($mb_ids);
$m171_up
SELECT 'up_again:' || ($mb_ids);
$link_sql
SELECT 'link:' || ($mb_ids);
SELECT 'link_url:' || (module_bar->0->>'url') || ',' || (module_bar->0->>'type') FROM directus_settings;
$link_sql
SELECT 'link_again:' || ($mb_ids);
$m171_down
SELECT 'down:' || ($mb_ids);
UPDATE directus_settings SET module_bar = NULL;
$m171_up
$link_sql
SELECT 'null_kept:' || (module_bar IS NULL) FROM directus_settings;
ROLLBACK;
SQL
)
expect_line m171_out "up:users,files,insights,d1-lab-dashboard,content,settings" "171 up: Home and the two plotters leave, the rest keeps its order"
expect_line m171_out "up_again:users,files,insights,d1-lab-dashboard,content,settings" "171 up: running it twice changes nothing"
expect_line m171_out "link:starbase,users,files,insights,d1-lab-dashboard,content,settings" "link script: the STARbase tile goes first"
expect_line m171_out "link_url:https://d1.example.org/d1-links/go,link" "link script: an absolute link to the permanent link, trailing slash dropped"
expect_line m171_out "link_again:starbase,users,files,insights,d1-lab-dashboard,content,settings" "link script: running it twice keeps one tile"
expect_line m171_out "down:home,starbase,users,files,insights,d1-lab-dashboard,d1-force-dashboard,d1-fast-dashboard,content,settings" "171 down: Home first, the plotters back before the Data Studio"
expect_line m171_out "null_kept:true" "a NULL module bar is left alone by both"

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
expect_line ps_out "insert:true/true/v2" "insert: the first sample subject becomes sample_id"
expect_line ps_out "second:true/v2" "a second sample subject with a higher id leaves sample_id and the test row untouched"
expect_line ps_out "lowest_id:true" "of two subjects linked in turn, the first linked is the primary"
expect_line ps_out "earliest:true" "the earliest linked subject stays primary when a later one has a lower junction id"
expect_line ps_out "tie_id_order:true" "subjects with an equal linked_at fall back to junction id order (the pre-migration rule)"
expect_line ps_out "linked_at_default:clock_timestamp()" "new junction rows are stamped with clock_timestamp() by default"
expect_line ps_out "linked_at_field:true/true" "linked_at is registered hidden and read-only in Directus"
expect_line ps_out "delete_primary:true" "deleting the primary subject promotes the next one"
expect_line ps_out "delete_last:true" "deleting the last sample subject clears sample_id"
expect_line ps_out "edge:true/true" "an insert_edges subject fills insert_edge_id and leaves sample_id alone"
expect_line ps_out "junk:true/true" "non-uuid, unknown or wrong-collection items are ignored"
expect_line ps_out "after_junk:true" "a valid sample after ignored junk still wins (uuid match is case-insensitive)"
expect_line ps_out "move:true/true" "moving a junction row recomputes the old and the new test"
expect_line ps_out "stale:true" "(setup) with the trigger off the junction alone leaves sample_id NULL"
expect_line ps_out "backfill:true" "back-fill repairs a test from its junction rows"
expect_line ps_out "cascade:0" "deleting a test cascades through the junction without error"
expect_line ps_out "comments:5" "function, trigger function, trigger and columns carry the derived-column comment"
