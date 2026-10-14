-- Write-path timings for the record access performance gate (A1a Task 2, plan "Performance gate"; spec section 11). COPY ONLY: run by
-- scripts/dev/directus_smoke.sh in D1_SMOKE_MODE=perf on the seeded throwaway copy of live (after scripts/dev/seed_access_fixture.sql), once with
-- migrations 166 and 167 withheld ("before": main's rules) and once with them ("after"), on the same data; never against a real database.
-- Each scenario runs in its own transaction that is rolled back, so every repetition starts from the same data. One line per measurement:
--   PERFW <scenario> <milliseconds>          wall time of the statement(s) of the scenario
--   PERFLOCKS <scenario> <count>             pg_locks held by the session at the end of the scenario (the peak: locks are held to commit)
--   PERFINFO <scenario> <text>               sizes (closure sizes of the cascades)
-- The statements mirror the real writers: scripts/import_fast25.py (INSERT ... ON CONFLICT (source_run_uid) WHERE source_run_uid IS NOT NULL DO
-- UPDATE, page_size 500), scripts/force_orchestrator.py (INSERT INTO machining_force_analysis ... SELECT, UPDATE ... SET status), migration
-- 139's per-subject UPDATE, Directus's one campaign_samples INSERT per statement. Usage: psql -v rep=1 -f scripts/dev/perf_writes.sql
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\if :{?n_import}
\else
  \set n_import 3000
\endif
\if :{?n_tests}
\else
  \set n_tests 20
\endif
\if :{?n_campaign_samples}
\else
  \set n_campaign_samples 50
\endif

-- the big project (the largest of the copy) and its biggest campaign, a sample in several campaigns of it with many operations, a login-less person
-- the largest project of the copy: most operations of its own and on its samples
SELECT p.project_id AS big_project FROM projects p
 ORDER BY (SELECT count(*) FROM manufacturing_operations o WHERE o.project_id = p.project_id OR o.sample_id IN (SELECT s.sample_id FROM physical_samples s WHERE s.project_id = p.project_id)) DESC LIMIT 1 \gset
SELECT campaign_id AS big_campaign FROM (SELECT cs.campaign_id, count(*) n FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
                                          WHERE c.project_id = :'big_project' GROUP BY 1 ORDER BY n DESC LIMIT 1) x \gset
SELECT s.sample_id AS big_sample FROM physical_samples s JOIN campaign_samples cs ON cs.sample_id = s.sample_id
  JOIN manufacturing_operations o ON o.sample_id = s.sample_id WHERE s.project_id = :'big_project' GROUP BY s.sample_id ORDER BY count(DISTINCT cs.campaign_id) DESC, count(o.operation_id) DESC LIMIT 1 \gset
SELECT user_id AS co_user FROM people WHERE user_id IS NOT NULL AND full_name NOT LIKE 'Perf %' ORDER BY md5(person_id::text || 'co') LIMIT 1 \gset
SELECT principal_investigator_person AS big_pi FROM projects WHERE project_id = :'big_project' \gset
SELECT method_id AS mf FROM manufacturing_methods WHERE method_code = 'MF' \gset
SELECT method_id AS ht FROM manufacturing_methods WHERE method_code = 'HT' \gset
SELECT 'PERFINFO big_project ' || (SELECT count(*) FROM manufacturing_operations WHERE project_id = :'big_project') || ' operations, '
       || (SELECT count(*) FROM physical_samples WHERE project_id = :'big_project') || ' samples, '
       || (SELECT count(*) FROM test_sessions WHERE project_id = :'big_project') || ' tests, '
       || (SELECT count(*) FROM campaigns WHERE project_id = :'big_project') || ' campaigns, '
       || (SELECT count(*) FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id WHERE c.project_id = :'big_project') || ' campaign_samples rows' AS info \gset
\echo :info

-- 1. the FAST importer's bulk insert: one statement, a few thousand operations (a third with an owner, as resolve_owner gives some runs)
BEGIN;
SELECT clock_timestamp() AS t0 \gset
INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number, source_run_uid, owner_person_id)
SELECT md5('pw-imp-' || :rep || '-' || g)::uuid, :'mf', 'fast_25', 'PWIMP' || :rep || '-' || g, 100000 * :rep + g, 'pw-uid-' || :rep || '-' || g,
       CASE WHEN g % 3 = 0 THEN :'big_pi'::uuid END FROM generate_series(1, :n_import) g;
SELECT 'PERFW importer_bulk_insert ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
SELECT 'PERFLOCKS importer_bulk_insert ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
-- 2. its real re-import: INSERT ... ON CONFLICT (source_run_uid) DO UPDATE on the same runs (fires the insert and the update triggers)
SELECT clock_timestamp() AS t0 \gset
INSERT INTO manufacturing_operations (operation_id, method_id, source_system, pass_code, sintering_run_number, source_run_uid, owner_person_id, sintering_mass_grams)
SELECT md5('pw-imp-' || :rep || '-' || g)::uuid, :'mf', 'fast_25', 'PWIMP' || :rep || '-' || g, 100000 * :rep + g, 'pw-uid-' || :rep || '-' || g,
       CASE WHEN g % 2 = 0 THEN :'big_pi'::uuid END, 12.5 FROM generate_series(1, :n_import) g
ON CONFLICT (source_run_uid) WHERE source_run_uid IS NOT NULL
DO UPDATE SET owner_person_id = EXCLUDED.owner_person_id, sintering_mass_grams = EXCLUDED.sintering_mass_grams, updated_at = now();
SELECT 'PERFW importer_reimport_on_conflict ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
ROLLBACK;

-- 3. the force crawler's writes: link analysis rows to operations (INSERT ... SELECT) and the status updates (machining_force_analysis is not an input)
BEGIN;
SELECT clock_timestamp() AS t0 \gset
INSERT INTO machining_force_analysis (operation_id, status)
SELECT o.operation_id, 'pending' FROM manufacturing_operations o
 WHERE o.project_id = :'big_project' AND NOT EXISTS (SELECT 1 FROM machining_force_analysis a WHERE a.operation_id = o.operation_id) LIMIT 2000;
UPDATE machining_force_analysis SET status = 'done', updated_at = now() WHERE status = 'pending' AND operation_id IN (SELECT operation_id FROM manufacturing_operations WHERE project_id = :'big_project');
SELECT 'PERFW crawler_force_analysis_writes ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
ROLLBACK;

-- 4. a co-owner added to a big sample (the sample in several campaigns of the large project, with many operations): the cascade of one row
BEGIN;
SELECT clock_timestamp() AS t0 \gset
INSERT INTO sample_co_owners (sample_id, user_id) VALUES (:'big_sample', :'co_user') ON CONFLICT DO NOTHING;
SELECT 'PERFW coowner_added_to_big_sample ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
SELECT 'PERFLOCKS coowner_added_to_big_sample ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
ROLLBACK;

-- 5a. N tests with subjects, each its own statement (migration 139's trigger issues one UPDATE test_sessions per subject row)
BEGIN;
SELECT clock_timestamp() AS t0 \gset
DO $$
DECLARE g int; s uuid; t uuid;
BEGIN
    FOR g IN 1..20 LOOP
        SELECT sample_id INTO s FROM physical_samples WHERE project_id = (SELECT p.project_id FROM projects p ORDER BY (SELECT count(*) FROM manufacturing_operations o WHERE o.project_id = p.project_id OR o.sample_id IN (SELECT x.sample_id FROM physical_samples x WHERE x.project_id = p.project_id)) DESC LIMIT 1) ORDER BY md5(sample_id::text || g) LIMIT 1;
        INSERT INTO test_sessions (test_type, status) VALUES ('hardness', 'registered') RETURNING session_id INTO t;
        INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES (t, 'physical_samples', s::text);
    END LOOP;
END $$;
SELECT 'PERFW tests_with_subjects_x20 ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
ROLLBACK;

-- 5b. adding 50 samples to a large campaign, one campaign_samples INSERT per statement (what Directus does for M2M writes)
BEGIN;
SELECT clock_timestamp() AS t0 \gset
DO $$
DECLARE r record; c uuid := (SELECT campaign_id FROM (SELECT cs.campaign_id, count(*) n FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
                                                      WHERE c.project_id = (SELECT p.project_id FROM projects p ORDER BY (SELECT count(*) FROM manufacturing_operations o WHERE o.project_id = p.project_id OR o.sample_id IN (SELECT x.sample_id FROM physical_samples x WHERE x.project_id = p.project_id)) DESC LIMIT 1) GROUP BY 1 ORDER BY n DESC LIMIT 1) x);
BEGIN
    FOR r IN SELECT s.sample_id FROM physical_samples s WHERE NOT EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s.sample_id AND cs.campaign_id = c)
              ORDER BY md5(s.sample_id::text) LIMIT 50 LOOP
        INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (c, r.sample_id);
    END LOOP;
END $$;
SELECT 'PERFW campaign_add_50_samples ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
ROLLBACK;

-- 5c. linking the login of the PI of the large project (people.user_id NULL -> a login): row 45's cascade, the whole project's contents
BEGIN;
SELECT user_id AS pi_user FROM people WHERE person_id = :'big_pi' \gset
UPDATE people SET user_id = NULL WHERE person_id = :'big_pi';
SELECT clock_timestamp() AS t0 \gset
UPDATE people SET user_id = :'pi_user' WHERE person_id = :'big_pi';
SELECT 'PERFW link_login_of_big_project_pi ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
SELECT 'PERFLOCKS link_login_of_big_project_pi ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
ROLLBACK;

-- 6. the cascades, reported without a limit: restricting the large project, changing its PI
BEGIN;
SELECT clock_timestamp() AS t0 \gset
UPDATE projects SET restricted = true WHERE project_id = :'big_project';
SELECT 'PERFW cascade_restrict_big_project ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
SELECT 'PERFLOCKS cascade_restrict_big_project ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
ROLLBACK;
BEGIN;
SELECT clock_timestamp() AS t0 \gset
UPDATE projects SET principal_investigator_person = (SELECT person_id FROM people WHERE user_id IS NOT NULL AND person_id <> :'big_pi' ORDER BY md5(person_id::text) LIMIT 1) WHERE project_id = :'big_project';
SELECT 'PERFW cascade_change_pi_of_big_project ' || round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz) * 1000) AS m \gset
\echo :m
SELECT 'PERFLOCKS cascade_change_pi_of_big_project ' || count(*) FROM pg_locks WHERE pid = pg_backend_pid();
ROLLBACK;
