-- Seed family for scripts/dev/local-stack.sh (the process-map edit mode redesign harness, slice 0).
--
-- Run by `local-stack.sh seed` AFTER the three test logins exist (the d1-person-link hook has made their People rows), with
--   psql -v admin_email=... -v member_email=... -v viewer_email=... -f scripts/dev/local-stack.seed.sql
-- Idempotent: every row is found by its code and left alone when it is there. Local throwaway data only.
--
-- What it makes (all owned by the Lab Member login, so the member can read and edit it; the viewer reads it through the Lab Viewer
-- policy; the admin sees everything):
--
--   LOCAL-RAW-1  active    a plain sample nothing has touched: the input of the Playwright edit-mode run
--   LOCAL-RAW-2  active    another untouched one, so a picker has more than one row to choose from
--   LOCAL-BAR-1  active    ──OP LOCAL-BAR-1-T1 (CNC Turning, done)──▶  LOCAL-BAR-2  active
--                  └── test LOCAL-BAR-1-TENSILE (tensile, done) on LOCAL-BAR-1
--
-- plus the reference data of db/seeds/001_reference_data.sql (the manufacturing methods list, materials, equipment) that `up` loads,
-- a project LOCAL-PROJ the member leads (and a second, LOCAL-PROJ-B, with one campaign in each: LOCAL-CAMP-A, LOCAL-CAMP-B), and People rows with is_researcher = true for the admin and the member (the viewer's is
-- made a non-researcher: a Lab Viewer builds nothing, and R11 of the redesign spec needs an account without a researcher row).
\set ON_ERROR_STOP on
BEGIN;
-- The audit trigger names whoever set this; without it the rows are audited as the database user.
SELECT set_config('d1.actor_identity', 'local-stack seed', true);

-- People: the hook made one per login with is_researcher = true.
UPDATE people p SET is_researcher = (u.email IN (:'admin_email', :'member_email')), active = true
FROM directus_users u
WHERE u.id = p.user_id AND u.email IN (:'admin_email', :'member_email', :'viewer_email');

INSERT INTO projects (project_code, project_name, description, principal_investigator_person)
SELECT 'LOCAL-PROJ', 'Local stack project', 'Made by scripts/dev/local-stack.seed.sql for the edit-mode browser suite.', p.person_id
FROM people p JOIN directus_users u ON u.id = p.user_id
WHERE u.email = :'member_email'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE project_code = 'LOCAL-PROJ');

-- A second project and a campaign in each, for the project / campaign chooser of the draft (slice 2b, R12): the samples below belong to
-- LOCAL-PROJ, so a draft that picks one is pre-filled with LOCAL-PROJ and offers LOCAL-CAMP-A; LOCAL-PROJ-B has the other campaign.
INSERT INTO projects (project_code, project_name, description, principal_investigator_person)
SELECT 'LOCAL-PROJ-B', 'Local stack project B', 'The second project of scripts/dev/local-stack.seed.sql (the chooser needs two).', p.person_id
FROM people p JOIN directus_users u ON u.id = p.user_id
WHERE u.email = :'member_email'
  AND NOT EXISTS (SELECT 1 FROM projects WHERE project_code = 'LOCAL-PROJ-B');

INSERT INTO campaigns (project_id, campaign_type, campaign_code, name, owner_person_id)
SELECT pr.project_id, 'machining_trial', v.code, v.name, p.person_id
FROM (VALUES ('LOCAL-PROJ', 'LOCAL-CAMP-A', 'Local campaign A'), ('LOCAL-PROJ-B', 'LOCAL-CAMP-B', 'Local campaign B')) AS v(project, code, name)
JOIN projects pr ON pr.project_code = v.project
CROSS JOIN (SELECT person_id FROM people p JOIN directus_users u ON u.id = p.user_id WHERE u.email = :'member_email') p
WHERE NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.campaign_code = v.code);

-- Samples
INSERT INTO physical_samples (sample_code, material_id, project_id, owner_person_id, form, current_status, nickname)
SELECT v.code, (SELECT material_id FROM materials WHERE alloy_code = 'AA'), pr.project_id, p.person_id, 'cylinder', 'active', v.nick
FROM (VALUES ('LOCAL-RAW-1', 'Untouched sample one'), ('LOCAL-RAW-2', 'Untouched sample two'),
             ('LOCAL-BAR-1', 'Bar, turned'), ('LOCAL-BAR-2', 'Bar after turning')) AS v(code, nick)
CROSS JOIN (SELECT person_id FROM people p JOIN directus_users u ON u.id = p.user_id WHERE u.email = :'member_email') p
CROSS JOIN (SELECT project_id FROM projects WHERE project_code = 'LOCAL-PROJ') pr
WHERE NOT EXISTS (SELECT 1 FROM physical_samples s WHERE s.sample_code = v.code);

-- A done operation: LOCAL-BAR-1 turned into LOCAL-BAR-2.
INSERT INTO manufacturing_operations (sample_id, output_sample_id, method_id, project_id, owner_person_id, pass_code, operation_date, process_category,
                                      work_state, done_by_person_id, done_at)
SELECT i.sample_id, o.sample_id, (SELECT method_id FROM manufacturing_methods WHERE method_code = 'MC'), i.project_id, i.owner_person_id,
       'LOCAL-BAR-1-T1', CURRENT_DATE, 'machining', 'done', i.owner_person_id, now()
FROM physical_samples i, physical_samples o
WHERE i.sample_code = 'LOCAL-BAR-1' AND o.sample_code = 'LOCAL-BAR-2'
  AND NOT EXISTS (SELECT 1 FROM manufacturing_operations WHERE pass_code = 'LOCAL-BAR-1-T1');

-- A done test on LOCAL-BAR-1 (its subject is the junction row; the database sets test_sessions.sample_id).
WITH t AS (
  INSERT INTO test_sessions (test_type, test_category, test_code, session_date, project_id, owner_person_id, work_state, done_by_person_id, done_at)
  SELECT 'tensile', 'destructive', 'LOCAL-BAR-1-TENSILE', now(), s.project_id, s.owner_person_id, 'done', s.owner_person_id, now()
  FROM physical_samples s
  WHERE s.sample_code = 'LOCAL-BAR-1' AND NOT EXISTS (SELECT 1 FROM test_sessions WHERE test_code = 'LOCAL-BAR-1-TENSILE')
  RETURNING session_id
)
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
SELECT t.session_id, 'physical_samples', s.sample_id::text FROM t, physical_samples s WHERE s.sample_code = 'LOCAL-BAR-1';

COMMIT;
