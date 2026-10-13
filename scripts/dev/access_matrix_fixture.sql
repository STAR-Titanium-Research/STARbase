-- Record access fixture for scripts/dev/directus_smoke.sh and tests/readers_matrix.sh. COPY ONLY: the harness loads this into the
-- throwaway copy of live before Directus starts (after scripts/dev/access_matrix_oracle.sql, which defines schema ref: the
-- independent plain-SQL model, the two intended changes of spec section 1 included); never run it against a real database.
--
-- Spec docs/superpowers/specs/2026-10-12-record-access-design.md section 10. Fixture people (all with logins unless
-- noted): owner (owns the samples), coowner (an old sample_co_owners row), viewer (view access), editor (edit access),
-- inv (an old project_investigators row), inv2 (project_access investigator, and a view entry on the samples), pi,
-- campaignOwner, opOwner (owns the operations and tests), qpi (PI of an open project), stranger, nologin (a People row
-- with no login: on a project list only). 32 universes (k = 0..31): the bits of k switch P, C, S, O and T to
-- restricted, so every combination exists once. A universe is
--   project P (PI pi; investigator inv; access: viewer view, inv2 investigator, nologin view)
--   campaign C in P (owner campaignOwner; access: viewer view, editor edit)
--   sample S in P and in C (owner owner; co-owner coowner; access: viewer view, editor edit, inv2 view)
--   sample S2 in no project, in C and in the open campaign C2 of the open project Q (owner owner)
--   operation O (S, P, C), O2 (S only), O3 (S2 and P), O4 (S2 and C), OF1 (a FAST run on nothing, nobody owns it), OF2 (on S
--   only, nobody owns it); all owned by opOwner except the two FAST runs; O has an access list (viewer view, editor edit)
--   test T (S, P, C; owner opOwner; access: viewer view, editor edit)
-- and then the plain-SQL evaluation of the rules in schema ref (written from the spec's tables, not from the
-- generated filters) with ref.expected_json(): for every fixture user and the five record types, the ids that user
-- may read, update and delete. The smoke compares Directus's answers with it. The fixture is inserted AFTER migration 166, so the
-- recompute triggers maintain the readers tables while it loads (the harness then asserts d1_private.readers_drift() is empty).
\set ON_ERROR_STOP on

CREATE TABLE ref.fixture_users (name text PRIMARY KEY, user_id uuid, person_id uuid, token text);

-- 1. people and logins (Lab Member role, as the harness's own smoke user)
INSERT INTO ref.fixture_users (name, user_id, person_id, token)
SELECT n, ref.id('user-' || n), ref.id('person-' || n), 'smoke-fx-' || n
  FROM unnest(ARRAY['owner', 'coowner', 'viewer', 'editor', 'inv', 'inv2', 'pi', 'campaignOwner', 'opOwner', 'qpi', 'stranger']) AS n;

-- the Lab Member role when the database has one (the smoke copy); none in the bare schema test, where the role does not matter
INSERT INTO directus_users (id, email, status, role, token, first_name, last_name)
SELECT f.user_id, 'fx-' || lower(f.name) || '@example.invalid', 'active',
       (SELECT r.id FROM directus_roles r
          JOIN directus_access a ON a.role = r.id
          JOIN directus_policies p ON p.id = a.policy
         WHERE r.name = 'Lab Member' AND NOT p.admin_access LIMIT 1), f.token, 'Fx', f.name
  FROM ref.fixture_users f;

INSERT INTO people (person_id, full_name, user_id, is_researcher, active)
SELECT f.person_id, 'Fx ' || f.name, f.user_id, true, true FROM ref.fixture_users f;
INSERT INTO people (person_id, full_name, is_researcher, active) VALUES (ref.id('person-nologin'), 'Fx nologin', true, true);

-- 2. the 32 universes
CREATE TEMP TABLE _u AS SELECT k, (k & 1) <> 0 AS rp, (k & 2) <> 0 AS rc, (k & 4) <> 0 AS rs, (k & 8) <> 0 AS ro, (k & 16) <> 0 AS rt
  FROM generate_series(0, 31) AS k;

INSERT INTO projects (project_id, project_code, project_name, principal_investigator_person, restricted)
SELECT ref.id('P' || k), 'FXP' || k, 'Fixture project ' || k, ref.id('person-pi'), rp FROM _u;
INSERT INTO projects (project_id, project_code, project_name, principal_investigator_person, restricted)
SELECT ref.id('Q' || k), 'FXQ' || k, 'Fixture open project ' || k, ref.id('person-qpi'), false FROM _u;

INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, owner_person_id, restricted)
SELECT ref.id('C' || k), ref.id('P' || k), 'testing_campaign', 'Fixture campaign ' || k, ref.id('person-campaignOwner'), rc FROM _u;
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, owner_person_id, restricted)
SELECT ref.id('C2_' || k), ref.id('Q' || k), 'testing_campaign', 'Fixture open campaign ' || k, ref.id('person-qpi'), false FROM _u;

INSERT INTO physical_samples (sample_id, sample_code, project_id, owner_person_id, restricted)
SELECT ref.id('S' || k), 'FXS' || k, ref.id('P' || k), ref.id('person-owner'), rs FROM _u;
INSERT INTO physical_samples (sample_id, sample_code, project_id, owner_person_id, restricted)
SELECT ref.id('S2_' || k), 'FXSB' || k, NULL, ref.id('person-owner'), false FROM _u;

INSERT INTO campaign_samples (campaign_id, sample_id)
SELECT ref.id('C' || k), ref.id('S' || k) FROM _u
UNION ALL SELECT ref.id('C' || k), ref.id('S2_' || k) FROM _u
UNION ALL SELECT ref.id('C2_' || k), ref.id('S2_' || k) FROM _u;

INSERT INTO sample_co_owners (sample_id, user_id) SELECT ref.id('S' || k), ref.id('user-coowner') FROM _u;
INSERT INTO project_investigators (project_id, user_id) SELECT ref.id('P' || k), ref.id('user-inv') FROM _u;

-- OF1 is a FAST run as the imports make them: no sample, a source system, the sintering method (MF) and a run number
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, project_id, campaign_id, owner_person_id, restricted,
                                      source_system, pass_code, sintering_run_number)
SELECT ref.id(v.label || k),
       (SELECT method_id FROM manufacturing_methods WHERE method_code = CASE WHEN v.label = 'OF1_' THEN 'MF' ELSE 'HT' END),
       CASE v.s WHEN 'S' THEN ref.id('S' || k) WHEN 'S2' THEN ref.id('S2_' || k) END, CASE WHEN v.p THEN ref.id('P' || k) END, CASE WHEN v.c THEN ref.id('C' || k) END,
       CASE WHEN v.owned THEN ref.id('person-opOwner') END, v.label = 'O' AND ro,
       CASE WHEN v.label = 'OF1_' THEN 'fast_25' END, CASE WHEN v.label = 'OF1_' THEN 'FXFAST' || k END,
       CASE WHEN v.label = 'OF1_' THEN 900000 + k END
  FROM _u, (VALUES ('O', 'S', true, true, true), ('O2_', 'S', false, false, true), ('O3_', 'S2', true, false, true),
                   ('O4_', 'S2', false, true, true), ('OF1_', NULL, false, false, false), ('OF2_', 'S', false, false, false)) AS v (label, s, p, c, owned);

INSERT INTO test_sessions (session_id, test_type, project_id, campaign_id, owner_person_id, restricted)
SELECT ref.id('T' || k), 'hardness', ref.id('P' || k), ref.id('C' || k), ref.id('person-opOwner'), rt FROM _u;
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
SELECT ref.id('T' || k), 'physical_samples', ref.id('S' || k)::text FROM _u;

-- the fixture rows by record type: the plain-SQL evaluation only looks at these (it is a per-row evaluation of
-- every rule; the 10k real operations only matter through the orphan amnesty, answered once below)
CREATE TABLE ref.fx_ids (kind text, id uuid);
INSERT INTO ref.fx_ids SELECT 'physical_samples', sample_id FROM physical_samples WHERE sample_code LIKE 'FX%';
INSERT INTO ref.fx_ids SELECT 'manufacturing_operations', operation_id FROM manufacturing_operations
 WHERE project_id IN (SELECT project_id FROM projects WHERE project_code LIKE 'FX%')
    OR sample_id IN (SELECT id FROM ref.fx_ids WHERE kind = 'physical_samples') OR pass_code LIKE 'FXFAST%';
INSERT INTO ref.fx_ids SELECT 'test_sessions', session_id FROM test_sessions WHERE project_id IN (SELECT project_id FROM projects WHERE project_code LIKE 'FX%');
INSERT INTO ref.fx_ids SELECT 'campaigns', campaign_id FROM campaigns WHERE name LIKE 'Fixture%';
INSERT INTO ref.fx_ids SELECT 'projects', project_id FROM projects WHERE project_code LIKE 'FX%';

-- 3. access lists
INSERT INTO project_access (project_id, person_id, role)
SELECT ref.id('P' || k), ref.id('person-viewer'), 'view' FROM _u
UNION ALL SELECT ref.id('P' || k), ref.id('person-inv2'), 'investigator' FROM _u
UNION ALL SELECT ref.id('P' || k), ref.id('person-nologin'), 'view' FROM _u;
INSERT INTO campaign_access (campaign_id, person_id, role)
SELECT ref.id('C' || k), ref.id('person-viewer'), 'view' FROM _u
UNION ALL SELECT ref.id('C' || k), ref.id('person-editor'), 'edit' FROM _u;
INSERT INTO sample_access (sample_id, person_id, role)
SELECT ref.id('S' || k), ref.id('person-viewer'), 'view' FROM _u
UNION ALL SELECT ref.id('S' || k), ref.id('person-editor'), 'edit' FROM _u
UNION ALL SELECT ref.id('S' || k), ref.id('person-inv2'), 'view' FROM _u;
INSERT INTO operation_access (operation_id, person_id, role)
SELECT ref.id('O' || k), ref.id('person-viewer'), 'view' FROM _u
UNION ALL SELECT ref.id('O' || k), ref.id('person-editor'), 'edit' FROM _u;
INSERT INTO test_access (session_id, person_id, role)
SELECT ref.id('T' || k), ref.id('person-viewer'), 'view' FROM _u
UNION ALL SELECT ref.id('T' || k), ref.id('person-editor'), 'edit' FROM _u;

-- the rollup cache (a statement trigger per insert above already refreshed it; once more so the smoke starts from the live derivation)
SELECT refresh_project_rollup();

CREATE FUNCTION ref.ids(kind text, action text, u uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
    out jsonb;
BEGIN
    CASE kind
        WHEN 'physical_samples' THEN
            SELECT coalesce(jsonb_agg(x.sample_id ORDER BY x.sample_id), '[]') INTO out FROM physical_samples x
             WHERE x.sample_id IN (SELECT id FROM ref.fx_ids WHERE ref.fx_ids.kind = 'physical_samples') AND CASE action WHEN 'read' THEN ref.s_read(x.sample_id, u) WHEN 'update' THEN ref.s_editor(x.sample_id, u)
                               ELSE ref.me(x.owner_person_id, u) END;
        WHEN 'manufacturing_operations' THEN
            SELECT coalesce(jsonb_agg(x.operation_id ORDER BY x.operation_id), '[]') INTO out FROM manufacturing_operations x
             WHERE x.operation_id IN (SELECT id FROM ref.fx_ids WHERE ref.fx_ids.kind = 'manufacturing_operations') AND CASE action WHEN 'read' THEN ref.op_read(x.operation_id, u) WHEN 'update' THEN ref.op_update(x.operation_id, u)
                               ELSE ref.op_delete(x.operation_id, u) END;
        WHEN 'test_sessions' THEN
            SELECT coalesce(jsonb_agg(x.session_id ORDER BY x.session_id), '[]') INTO out FROM test_sessions x
             WHERE x.session_id IN (SELECT id FROM ref.fx_ids WHERE ref.fx_ids.kind = 'test_sessions') AND CASE action WHEN 'read' THEN ref.test_read(x.session_id, u) WHEN 'update' THEN ref.test_update(x.session_id, u)
                               ELSE ref.test_delete(x.session_id, u) END;
        WHEN 'campaigns' THEN
            SELECT coalesce(jsonb_agg(x.campaign_id ORDER BY x.campaign_id), '[]') INTO out FROM campaigns x
             WHERE x.campaign_id IN (SELECT id FROM ref.fx_ids WHERE ref.fx_ids.kind = 'campaigns') AND CASE action WHEN 'read' THEN ref.c_read(x.campaign_id, u) WHEN 'update' THEN ref.c_update(x.campaign_id, u)
                               ELSE ref.c_delete(x.campaign_id, u) END;
        ELSE
            SELECT coalesce(jsonb_agg(x.project_id ORDER BY x.project_id), '[]') INTO out FROM projects x
             WHERE x.project_id IN (SELECT id FROM ref.fx_ids WHERE ref.fx_ids.kind = 'projects') AND CASE action WHEN 'read' THEN ref.pj_read(x.project_id, u) ELSE ref.me(x.principal_investigator_person, u) END;
    END CASE;
    RETURN out;
END $$;

-- 5. what the smoke cases read: users and tokens, the expected ids per user, collection and action, and the ids of the
-- fixture records by universe
CREATE FUNCTION ref.expected_json() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'users', (SELECT jsonb_object_agg(name, token) FROM ref.fixture_users),
        'expected', (SELECT jsonb_object_agg(f.name, (
                        SELECT jsonb_object_agg(c.kind, jsonb_build_object(
                                   'read', ref.ids(c.kind, 'read', f.user_id),
                                   'update', ref.ids(c.kind, 'update', f.user_id),
                                   'delete', ref.ids(c.kind, 'delete', f.user_id)))
                          FROM (VALUES ('physical_samples'), ('manufacturing_operations'), ('test_sessions'), ('campaigns'), ('projects')) AS c (kind)))
                       FROM ref.fixture_users f),
        -- the rollup rows of the fixture projects each user may read: the PI every row, an investigator (old table or access
        -- role investigator) the unrestricted ones (migration 167; before it the column does not exist and counts as false)
        'rollup', (SELECT jsonb_object_agg(f.name, (
                      SELECT coalesce(jsonb_agg(r.row_id ORDER BY r.row_id), '[]'::jsonb)
                        FROM project_rollup r JOIN projects p ON p.project_id = r.project_id
                       WHERE p.project_code LIKE 'FXP%'
                         AND (ref.pi_of(r.project_id, f.user_id)
                              OR (NOT coalesce((to_jsonb(r) ->> 'restricted')::boolean, false) AND ref.p_invs(r.project_id, f.user_id)))))
                    FROM ref.fixture_users f),
        -- the real operations every member reads (the narrowed amnesty, ref.amnesty_open): the copy's ownerless legacy runs
        'real_amnesty_ops', (SELECT coalesce(jsonb_agg(o.operation_id ORDER BY o.operation_id), '[]') FROM manufacturing_operations o
                              WHERE ref.amnesty_open(o.owner_person_id, o.project_id, o.campaign_id, o.restricted, o.sample_id)
                                AND o.operation_id NOT IN (SELECT id FROM ref.fx_ids WHERE kind = 'manufacturing_operations')),
        'universes', (SELECT jsonb_agg(jsonb_build_object(
                          'k', k, 'P', ref.id('P' || k), 'Q', ref.id('Q' || k), 'C', ref.id('C' || k), 'C2', ref.id('C2_' || k),
                          'S', ref.id('S' || k), 'S2', ref.id('S2_' || k),
                          'O', ref.id('O' || k), 'O2', ref.id('O2_' || k), 'O3', ref.id('O3_' || k), 'O4', ref.id('O4_' || k),
                          'OF1', ref.id('OF1_' || k), 'OF2', ref.id('OF2_' || k), 'T', ref.id('T' || k),
                          'rp', (k & 1) <> 0, 'rc', (k & 2) <> 0, 'rs', (k & 4) <> 0, 'ro', (k & 8) <> 0, 'rt', (k & 16) <> 0,
                          'coowner_row', (SELECT id FROM sample_co_owners WHERE sample_id = ref.id('S' || k) LIMIT 1),
                          'investigator_row', (SELECT id FROM project_investigators WHERE project_id = ref.id('P' || k) LIMIT 1))
                          ORDER BY k) FROM generate_series(0, 31) AS k)
    )::text $$;
