-- Performance seed for the record access rules (A1a Task 2; spec section 11). COPY ONLY: scripts/dev/directus_smoke.sh
-- loads it into the throwaway copy of live (D1_SMOKE_MODE=perf) before Directus starts; never run it against a real
-- database. Live has no access rows and nothing restricted, so an unseeded copy shows almost no fan-out. This adds,
-- on top of the copy's own data (about 170 samples, 10k operations, 9 projects):
--   4 large synthetic projects (project 3 is restricted) and 12 campaigns (campaign 5 is restricted)
--   1500 samples (8% restricted, 70% in a project), each in 1 to 3 campaigns (so several campaigns of big projects)
--   an access list of 4 people on a quarter of the samples, on every campaign and every project (one investigator)
--   300 old co-owner rows, 4000 operations on those samples (8% restricted, a third with a project, a third with a
--   campaign, a few with an access list) and 600 tests (9% restricted)
-- and two Lab Members with tokens: perf-stranger (involved in nothing: the rules scan everything and return only
-- the orphan FAST runs) and perf-member (co-owner of 20 samples, investigator of two projects, owner of 30 operations).
\set ON_ERROR_STOP on
SELECT setseed(0.42);

CREATE SCHEMA perf;
CREATE FUNCTION perf.id(label text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('smoke-perf-' || label)::uuid $$;
-- a deterministic "random" person with a login for (label)
CREATE FUNCTION perf.person(label text) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT person_id FROM people WHERE user_id IS NOT NULL AND full_name NOT LIKE 'Perf %' ORDER BY md5(person_id::text || label) LIMIT 1 $$;
CREATE FUNCTION perf.any_person(label text) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT person_id FROM people WHERE full_name NOT LIKE 'Perf %' ORDER BY md5(person_id::text || label) LIMIT 1 $$;

-- the two members
CREATE TABLE perf.users (name text PRIMARY KEY, user_id uuid, person_id uuid, token text);
INSERT INTO perf.users VALUES ('stranger', perf.id('user-stranger'), perf.id('person-stranger'), 'smoke-perf-stranger'),
                              ('member', perf.id('user-member'), perf.id('person-member'), 'smoke-perf-member');
INSERT INTO directus_users (id, email, status, role, token, first_name, last_name)
SELECT u.user_id, 'perf-' || u.name || '@example.invalid', 'active', r.id, u.token, 'Perf', u.name
  FROM perf.users u,
       (SELECT r.id FROM directus_roles r JOIN directus_access a ON a.role = r.id JOIN directus_policies p ON p.id = a.policy
         WHERE r.name = 'Lab Member' AND NOT p.admin_access LIMIT 1) r;
INSERT INTO people (person_id, full_name, user_id, is_researcher, active)
SELECT person_id, 'Perf ' || name, user_id, true, true FROM perf.users;

-- projects, campaigns
INSERT INTO projects (project_id, project_code, project_name, principal_investigator_person, restricted)
SELECT perf.id('P' || i), 'PFP' || i, 'Perf project ' || i, perf.person('pi' || i), i = 3 FROM generate_series(1, 4) i;
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, owner_person_id, restricted)
SELECT perf.id('C' || i), perf.id('P' || (1 + i % 4)), 'testing_campaign', 'Perf campaign ' || i, perf.person('co' || i), i = 5 FROM generate_series(1, 12) i;

-- samples: 1500, in 1 to 3 campaigns
INSERT INTO physical_samples (sample_id, sample_code, project_id, owner_person_id, restricted)
SELECT perf.id('S' || i), 'PFS' || i, CASE WHEN i % 10 < 7 THEN perf.id('P' || (1 + i % 4)) END, perf.any_person('so' || i), i % 12 = 0
  FROM generate_series(1, 1500) i;
INSERT INTO campaign_samples (campaign_id, sample_id)
SELECT perf.id('C' || c), perf.id('S' || i)
  FROM generate_series(1, 1500) i, LATERAL unnest(ARRAY[1 + i % 12, 1 + (i * 7) % 12] || CASE WHEN i % 5 = 0 THEN ARRAY[1 + (i * 5) % 12] ELSE ARRAY[]::int[] END) AS c
ON CONFLICT DO NOTHING;
INSERT INTO sample_co_owners (sample_id, user_id)
SELECT DISTINCT ON (s) perf.id('S' || s), p.user_id
  FROM generate_series(1, 1500, 5) s, LATERAL (SELECT user_id FROM people WHERE user_id IS NOT NULL AND full_name NOT LIKE 'Perf %' ORDER BY md5(person_id::text || 'cow' || s) LIMIT 1) p
ON CONFLICT DO NOTHING;
-- the member: co-owner of 20 samples, investigator of projects 1 and 2
INSERT INTO sample_co_owners (sample_id, user_id) SELECT perf.id('S' || (i * 70 + 1)), perf.id('user-member') FROM generate_series(0, 19) i ON CONFLICT DO NOTHING;
INSERT INTO project_investigators (project_id, user_id) VALUES (perf.id('P1'), perf.id('user-member')), (perf.id('P2'), perf.id('user-member'));

-- operations: 4000 on those samples
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, project_id, campaign_id, owner_person_id, restricted)
SELECT perf.id('O' || i), (SELECT method_id FROM manufacturing_methods WHERE method_code = 'HT'),
       perf.id('S' || (1 + i % 1500)),
       CASE WHEN i % 3 = 0 THEN perf.id('P' || (1 + i % 4)) END,
       CASE WHEN i % 3 = 1 THEN perf.id('C' || (1 + i % 12)) END,
       CASE WHEN i % 130 = 0 THEN perf.id('person-member') WHEN i % 5 <> 0 THEN perf.any_person('oo' || i) END,
       i % 13 = 0
  FROM generate_series(1, 4000) i;
INSERT INTO test_sessions (session_id, test_type, project_id, campaign_id, owner_person_id, restricted)
SELECT perf.id('T' || i), 'hardness', CASE WHEN i % 3 = 0 THEN perf.id('P' || (1 + i % 4)) END, CASE WHEN i % 3 = 1 THEN perf.id('C' || (1 + i % 12)) END,
       perf.any_person('to' || i), i % 11 = 0
  FROM generate_series(1, 600) i;
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
SELECT perf.id('T' || i), 'physical_samples', perf.id('S' || (1 + (i * 3) % 1500))::text FROM generate_series(1, 600) i;

-- access lists: 4 people on every project and campaign, on a quarter of the samples, on 160 operations
INSERT INTO project_access (project_id, person_id, role)
SELECT perf.id('P' || i), perf.any_person('pa' || i || '-' || j), CASE WHEN j = 1 THEN 'investigator' ELSE 'view' END
  FROM generate_series(1, 4) i, generate_series(1, 4) j ON CONFLICT DO NOTHING;
INSERT INTO campaign_access (campaign_id, person_id, role)
SELECT perf.id('C' || i), perf.any_person('ca' || i || '-' || j), CASE WHEN j = 1 THEN 'edit' ELSE 'view' END
  FROM generate_series(1, 12) i, generate_series(1, 4) j ON CONFLICT DO NOTHING;
INSERT INTO sample_access (sample_id, person_id, role)
SELECT perf.id('S' || i), perf.any_person('sa' || i || '-' || j), CASE WHEN j = 1 THEN 'edit' ELSE 'view' END
  FROM generate_series(1, 1500, 4) i, generate_series(1, 4) j ON CONFLICT DO NOTHING;
INSERT INTO operation_access (operation_id, person_id, role)
SELECT perf.id('O' || i), perf.any_person('oa' || i || '-' || j), 'view' FROM generate_series(1, 4000, 25) i, generate_series(1, 3) j ON CONFLICT DO NOTHING;

ANALYZE;
