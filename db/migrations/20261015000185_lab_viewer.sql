-- migrate:up
-- Lab Viewer: a read-only account role that reads every record (maintainer decision 2026-10-15: the lab's PI must see everything and change nothing).
--
-- A login whose account role is Lab Viewer and that is not suspended is a reader of EVERY record of every type, Restricted included, so Directus
-- permissions, STARbase, the finder and every endpoint that reads the readers tables show them everything with no special case (ADR-0014 amendment).
-- This is done inside the readers machinery of migrations 166, 182 and 183, not beside it:
--
--   * d1_private.v_viewers: the user_id of every non-suspended login with the Lab Viewer role (role id 10000001-0000-0000-0000-000000000003), straight from
--     directus_users (a viewer needs no People row). d1_private.lab_viewer_role() is that id, the one place it is written in SQL.
--   * the six production functions readers_of_sample, _operation, _test, _campaign, _project and _campaign_sample and their six _spec
--     functions each get ONE more branch: UNION the viewers x every record asked about. The branch comes after the rule (and after the gates of
--     operations and tests, which would drop a viewer from a Restricted parent), so a viewer reads whatever the gates say. The bodies are
--     those of the head (migration 183), otherwise untouched; the per-pair predicates can_read_*() and the candidates stay the ORDINARY
--     rule, and scripts/dev/access_matrix_oracle.sql models a viewer on its own (ref.viewer) and tests/readers_matrix.sh asserts the three agree.
--     Everything else that reads who reads what (sync_readers, readers_drift, the closure, the triggers of every input) is unchanged: they
--     only call these functions.
--   * a login that gains or loses the role, or is suspended, unsuspended, created or deleted, changes the viewer set, so its readers rows are
--     recomputed for every record type: statement triggers on directus_users (AFTER INSERT, UPDATE, DELETE with transition tables, which only
--     ask "did the viewer set change?" and call d1_private.readers_rebuild()), and a BEFORE statement trigger on INSERT, DELETE and UPDATE OF
--     role, status that takes the global readers lock first (the same lock-first rule as people_readers_lock of migration 166: a delete of a
--     login needs a row lock that a writer holding the readers lock may be waiting for). UPDATE OF role, status only: Directus writes
--     last_access and last_page on every request, which must not take the lock. Drift stays 0.
--   * the role, the policy and the permission rows. Role Lab Viewer (10000001-0000-0000-0000-000000000003), policy Lab Viewer (20000002-0000-0000-0000-000000000003, app access, no admin
--     access) and their directus_access row (30000003-0000-0000-0000-000000000003); the policy's rows are the READ rows of Lab Member, as they are (the same
--     collections, filters and fields), and NOTHING else: no create, update or delete row at all, so Directus refuses every write. They are
--     `python3 scripts/gen_access_rules.py --viewer-values` (a snapshot of the rules on 2026-10-15, as in migration 166); the generator keeps
--     them in step with Lab Member (`--check` covers scripts/configure_users_and_policies.sql, which carries the same block).
--
-- Being a reader never grants a write: the update, delete and manage rules of access_rules.json are Directus filters that Lab Viewer has no row for;
-- the custom endpoints (d1-record-access, d1-teams, d1-people-admin) refuse a Lab Viewer on every route that changes anything (Task A of this
-- change; ADR-0014 amendment).
--
-- Known gaps, accepted for now (copied rules, not invented ones): project_rollup is read by a project's PI and investigators only, and the five
-- *_access tables by the person they list, exactly as for Lab Member, so a viewer sees no rollup rows of other people's projects and no one else's
-- access rows through Directus. The People page and its endpoints are Task B.
--
-- Rollout: stop Directus, migrate, start it (the changed extensions load at start; the role and policy are new, so no cached permission goes stale), then invite with the role
-- Lab Viewer (docs/runbooks/starbase.md).
-- Down: drops all of it and puts the functions of migration 183 back; a login that still has the role is left without a role; the readers are recomputed.
SET LOCAL lock_timeout = '10s';
CREATE SCHEMA IF NOT EXISTS d1_private;

-- 1. The role, its policy and the binding.
INSERT INTO directus_roles (id, name, icon, description) VALUES
    ('10000001-0000-0000-0000-000000000003', 'Lab Viewer', 'visibility', 'Reads every record, including Restricted ones, and changes nothing')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;
INSERT INTO directus_policies (id, name, icon, description, admin_access, app_access) VALUES
    ('20000002-0000-0000-0000-000000000003', 'Lab Viewer', 'badge', 'App access + read only on all lab data collections', FALSE, TRUE)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, admin_access = EXCLUDED.admin_access, app_access = EXCLUDED.app_access;
INSERT INTO directus_access (id, role, policy, sort) VALUES
    ('30000003-0000-0000-0000-000000000003', '10000001-0000-0000-0000-000000000003', '20000002-0000-0000-0000-000000000003', 1)
ON CONFLICT (id) DO NOTHING;

-- 2. The permission rows: the read rows of Lab Member, under the viewer's policy (python3 scripts/gen_access_rules.py --viewer-values).
CREATE TEMP TABLE _lv_rules (collection TEXT, action TEXT, filter JSON, validation JSON, fields TEXT) ON COMMIT DROP;
INSERT INTO _lv_rules (collection, action, filter, validation, fields) VALUES
    ('physical_samples', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('manufacturing_operations', 'read', '{"_or":[{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"open_to_all":{"_some":{"record_id":{"_nnull":true}}}}]}', '{}', '*'),
    ('test_sessions', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('campaigns', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('projects', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_co_owners', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_stock_provenance', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_data_files', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_genealogy', 'read', '{"_or":[{"child_sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"parent_sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    ('campaign_samples', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('operation_data_files', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('machining_force_analysis', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('fast_run_data', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_data_files', 'read', '{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('operation_additional_operators', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_additional_operators', 'read', '{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('test_sessions_subject', 'read', '{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('project_investigators', 'read', '{"project_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('project_rollup', 'read', '{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"project_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"project_id":{"access":{"role":{"_in":["investigator"]}}}}]}]}]}]}', '{}', '*'),
    ('people', 'read', '{}', '{}', '*'),
    ('sample_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('operation_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('test_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('campaign_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('project_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('sample_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('operation_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('test_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('campaign_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('project_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('campaign_sample_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('operation_open_to_all', 'read', '{}', '{}', '*'),
    ('label_templates', 'read', '{}', '{}', '*'),
    ('batches', 'read', '{}', '{}', '*'),
    ('machining_params', 'read', '{}', '{}', '*'),
    ('sintering_params', 'read', '{}', '{}', '*'),
    ('heat_treatment_params', 'read', '{}', '{}', '*'),
    ('deformation_params', 'read', '{}', '{}', '*'),
    ('am_params', 'read', '{}', '{}', '*'),
    ('tensile_test_params', 'read', '{}', '{}', '*'),
    ('hardness_test_params', 'read', '{}', '{}', '*'),
    ('charpy_test_params', 'read', '{}', '{}', '*'),
    ('compression_test_params', 'read', '{}', '{}', '*'),
    ('sem_params', 'read', '{}', '{}', '*'),
    ('xrd_params', 'read', '{}', '{}', '*'),
    ('materials', 'read', '{}', '{}', '*'),
    ('material_iso_classifications', 'read', '{}', '{}', '*'),
    ('alloying_elements', 'read', '{}', '{}', '*'),
    ('material_alloying_elements', 'read', '{}', '{}', '*'),
    ('equipment', 'read', '{}', '{}', '*'),
    ('tools', 'read', '{}', '{}', '*'),
    ('tool_boxes', 'read', '{}', '{}', '*'),
    ('cutting_inserts', 'read', '{}', '{}', '*'),
    ('insert_edges', 'read', '{}', '{}', '*'),
    ('insert_types', 'read', '{}', '{}', '*'),
    ('manufacturers', 'read', '{}', '{}', '*'),
    ('raw_stock_lots', 'read', '{}', '{}', '*'),
    ('manufacturing_methods', 'read', '{}', '{}', '*'),
    ('facilities', 'read', '{}', '{}', '*'),
    ('fast_recipes', 'read', '{}', '{}', '*'),
    ('force_crawler_state', 'read', '{}', '{}', '*'),
    ('label_settings', 'read', '{}', '{}', '*'),
    ('teams', 'read', '{}', '{}', '*'),
    ('team_members', 'read', '{}', '{}', '*'),
    ('directus_files', 'read', '{}', '{}', '*');
DELETE FROM directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000003';
INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
SELECT g.collection, g.action, g.filter, g.validation, g.fields, '20000002-0000-0000-0000-000000000003' FROM _lv_rules g;

-- 3. Who is a viewer.
CREATE OR REPLACE FUNCTION d1_private.lab_viewer_role() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '10000001-0000-0000-0000-000000000003'::uuid $$;
COMMENT ON FUNCTION d1_private.lab_viewer_role() IS 'The id of the account role Lab Viewer (migration 185; scripts/access_rules.json "viewer"), the one place SQL names it.';

CREATE OR REPLACE VIEW d1_private.v_viewers AS
    SELECT u.id AS user_id FROM public.directus_users u
     WHERE u.role = d1_private.lab_viewer_role() AND u.status <> 'suspended';
COMMENT ON VIEW d1_private.v_viewers IS 'The logins that read every record: directus_users with the role Lab Viewer that are not suspended (an invite that is not yet accepted counts: it cannot sign in until it is). Read by readers_of_* and their _spec functions (migration 185); not granted to any role.';

-- 4. The readers functions: the viewers are readers of every record.
CREATE OR REPLACE FUNCTION d1_private.readers_of_sample(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT r.record_id, r.user_id FROM (
        -- on the list: always a reader
        SELECT l.sample_id AS record_id, l.user_id FROM d1_private.v_s_list l WHERE l.sample_id = ANY (ids)
        UNION ALL
        -- inherited, only for an unrestricted sample: the investigators of its project
        SELECT s.sample_id, i.user_id FROM physical_samples s JOIN d1_private.v_p_invs i ON i.project_id = s.project_id
         WHERE s.sample_id = ANY (ids) AND NOT s.restricted
        UNION ALL
        -- the owner of a campaign it is in, while the campaign's project lets them in
        SELECT cs.sample_id, lp.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id
          JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id
          JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id
          LEFT JOIN projects cp ON cp.project_id = c.project_id
         WHERE cs.sample_id = ANY (ids) AND NOT s.restricted
           AND (cp.project_id IS NULL OR NOT cp.restricted
                OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = lp.user_id))
        UNION ALL
        -- the investigators of an unrestricted campaign's project
        SELECT cs.sample_id, i.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id
          JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_p_invs i ON i.project_id = c.project_id
         WHERE cs.sample_id = ANY (ids) AND NOT s.restricted AND NOT c.restricted
    ) r
    UNION
    SELECT x.sample_id, v.user_id FROM physical_samples x CROSS JOIN d1_private.v_viewers v WHERE x.sample_id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_operation(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH o AS MATERIALIZED (SELECT x.operation_id, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id, x.restricted
                              FROM manufacturing_operations x WHERE x.operation_id = ANY (ids)),
    paths AS (
        SELECT o.operation_id AS rid, lp.user_id AS uid FROM o JOIN d1_private.v_login_person lp ON lp.person_id = o.owner_person_id
        UNION ALL
        SELECT a.operation_id, lp.user_id FROM operation_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.operation_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN d1_private.v_p_pi pi ON pi.project_id = o.project_id
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id
        UNION ALL
        -- the inherited paths exist only for an unrestricted operation
        SELECT o.operation_id, i.user_id FROM o JOIN d1_private.v_p_invs i ON i.project_id = o.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, lp.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_invs i ON i.project_id = c.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, r.user_id FROM o
          JOIN sample_readers r ON r.record_id = o.sample_id
         WHERE NOT o.restricted
    )
    SELECT DISTINCT pa.rid, pa.uid FROM paths pa
      JOIN o ON o.operation_id = pa.rid
      LEFT JOIN physical_samples s ON s.sample_id = o.sample_id
      LEFT JOIN projects sp ON sp.project_id = s.project_id
      LEFT JOIN projects pr ON pr.project_id = o.project_id
      LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
      LEFT JOIN projects cp ON cp.project_id = c.project_id
     WHERE
       -- P(its project)
       (pr.project_id IS NULL OR NOT pr.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = pr.project_id AND pl.user_id = pa.uid))
       -- P(its sample's project)
       AND (sp.project_id IS NULL OR NOT sp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = sp.project_id AND pl.user_id = pa.uid))
       -- C(its campaign): unrestricted or on its list, and its project lets them in
       AND (c.campaign_id IS NULL OR (
              (NOT c.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = c.campaign_id AND cl.user_id = pa.uid))
              AND (cp.project_id IS NULL OR NOT cp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = pa.uid))))
       -- S*(its sample): unrestricted or on its list, and (on its list, or investigates its own project, or not campaign-shielded)
       AND (s.sample_id IS NULL OR (
              (NOT s.restricted OR EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid))
              AND (EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid)
                   OR EXISTS (SELECT 1 FROM d1_private.v_p_invs i WHERE i.project_id = s.project_id AND i.user_id = pa.uid)
                   OR NOT (EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = s.sample_id)
                           AND NOT EXISTS (SELECT 1 FROM campaign_samples x JOIN campaigns xc ON xc.campaign_id = x.campaign_id
                                             LEFT JOIN projects xp ON xp.project_id = xc.project_id
                                            WHERE x.sample_id = s.sample_id
                                              AND (NOT xc.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = xc.campaign_id AND cl.user_id = pa.uid))
                                              AND (xp.project_id IS NULL OR NOT xp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = xp.project_id AND pl.user_id = pa.uid)))))))
    UNION
    SELECT x.operation_id, v.user_id FROM manufacturing_operations x CROSS JOIN d1_private.v_viewers v WHERE x.operation_id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_test(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH o AS MATERIALIZED (SELECT x.session_id AS operation_id, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id, x.restricted
                              FROM test_sessions x WHERE x.session_id = ANY (ids)),
    paths AS (
        SELECT o.operation_id AS rid, lp.user_id AS uid FROM o JOIN d1_private.v_login_person lp ON lp.person_id = o.owner_person_id
        UNION ALL
        SELECT a.session_id, lp.user_id FROM test_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.session_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN d1_private.v_p_pi pi ON pi.project_id = o.project_id
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN d1_private.v_p_invs i ON i.project_id = o.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, lp.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_invs i ON i.project_id = c.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, r.user_id FROM o
          JOIN sample_readers r ON r.record_id = o.sample_id
         WHERE NOT o.restricted
    )
    SELECT DISTINCT pa.rid, pa.uid FROM paths pa
      JOIN o ON o.operation_id = pa.rid
      LEFT JOIN physical_samples s ON s.sample_id = o.sample_id
      LEFT JOIN projects sp ON sp.project_id = s.project_id
      LEFT JOIN projects pr ON pr.project_id = o.project_id
      LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
      LEFT JOIN projects cp ON cp.project_id = c.project_id
     WHERE
       (pr.project_id IS NULL OR NOT pr.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = pr.project_id AND pl.user_id = pa.uid))
       AND (sp.project_id IS NULL OR NOT sp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = sp.project_id AND pl.user_id = pa.uid))
       AND (c.campaign_id IS NULL OR (
              (NOT c.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = c.campaign_id AND cl.user_id = pa.uid))
              AND (cp.project_id IS NULL OR NOT cp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = pa.uid))))
       AND (s.sample_id IS NULL OR (
              (NOT s.restricted OR EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid))
              AND (EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid)
                   OR EXISTS (SELECT 1 FROM d1_private.v_p_invs i WHERE i.project_id = s.project_id AND i.user_id = pa.uid)
                   OR NOT (EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = s.sample_id)
                           AND NOT EXISTS (SELECT 1 FROM campaign_samples x JOIN campaigns xc ON xc.campaign_id = x.campaign_id
                                             LEFT JOIN projects xp ON xp.project_id = xc.project_id
                                            WHERE x.sample_id = s.sample_id
                                              AND (NOT xc.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = xc.campaign_id AND cl.user_id = pa.uid))
                                              AND (xp.project_id IS NULL OR NOT xp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = xp.project_id AND pl.user_id = pa.uid)))))))
    UNION
    SELECT x.session_id, v.user_id FROM test_sessions x CROSS JOIN d1_private.v_viewers v WHERE x.session_id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT x.record_id, x.user_id FROM (
        SELECT l.campaign_id AS record_id, l.user_id FROM d1_private.v_c_list l WHERE l.campaign_id = ANY (ids)
        UNION ALL
        SELECT c.campaign_id, i.user_id FROM campaigns c JOIN d1_private.v_p_invs i ON i.project_id = c.project_id
         WHERE c.campaign_id = ANY (ids) AND NOT c.restricted
        UNION ALL
        SELECT cs.campaign_id, e.user_id FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_s_editor e ON e.sample_id = cs.sample_id
         WHERE cs.campaign_id = ANY (ids) AND NOT c.restricted
    ) x
    JOIN campaigns c ON c.campaign_id = x.record_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE p.project_id IS NULL OR NOT p.restricted
       OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = p.project_id AND pl.user_id = x.user_id)
    UNION
    SELECT x.campaign_id, v.user_id FROM campaigns x CROSS JOIN d1_private.v_viewers v WHERE x.campaign_id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_project(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    -- the unrestricted projects among ids (a restricted project is read by its list alone)
    WITH pr AS MATERIALIZED (SELECT x.project_id FROM projects x WHERE x.project_id = ANY (ids) AND NOT x.restricted),
    -- the samples of those projects: their editors read the project
    ps AS MATERIALIZED (SELECT s.sample_id, s.project_id, s.owner_person_id FROM physical_samples s
                         WHERE s.project_id = ANY (ids) AND EXISTS (SELECT 1 FROM pr WHERE pr.project_id = s.project_id))
    -- the list of the project (PI, investigators, access entries)
    SELECT l.project_id, l.user_id FROM d1_private.v_p_list l WHERE l.project_id = ANY (ids)
    UNION
    -- the owner of a campaign of an unrestricted project (on the campaign's list; the project's gate P passes everyone)
    SELECT c.project_id, lp.user_id FROM campaigns c JOIN pr ON pr.project_id = c.project_id JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id
    UNION
    -- the editors of its samples (on the sample's list)
    SELECT ps.project_id, lp.user_id FROM ps JOIN d1_private.v_login_person lp ON lp.person_id = ps.owner_person_id
    UNION
    SELECT ps.project_id, o.user_id FROM ps JOIN sample_co_owners o ON o.sample_id = ps.sample_id
    UNION
    SELECT ps.project_id, lp.user_id FROM ps JOIN sample_access a ON a.sample_id = ps.sample_id AND a.role IN ('edit', 'manage') JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id
    UNION
    -- the owner of an operation / test in it that they can read: operation_readers / test_readers already hold exactly that (the ordinary
    -- read; sync_readers() recomputes operations and tests before projects, and every operation whose readers could have changed is in its closure)
    SELECT o.project_id, pe.user_id FROM manufacturing_operations o JOIN pr ON pr.project_id = o.project_id
      JOIN d1_private.v_o_owner oo ON oo.operation_id = o.operation_id
      JOIN people pe ON pe.person_id = oo.person_id AND pe.user_id IS NOT NULL
      JOIN operation_readers r ON r.record_id = o.operation_id AND r.user_id = pe.user_id
     WHERE o.project_id = ANY (ids)
    UNION
    SELECT t.project_id, pe.user_id FROM test_sessions t JOIN pr ON pr.project_id = t.project_id
      JOIN d1_private.v_t_owner tt ON tt.session_id = t.session_id
      JOIN people pe ON pe.person_id = tt.person_id AND pe.user_id IS NOT NULL
      JOIN test_readers r ON r.record_id = t.session_id AND r.user_id = pe.user_id
     WHERE t.project_id = ANY (ids)
    UNION
    SELECT x.project_id, v.user_id FROM projects x CROSS JOIN d1_private.v_viewers v WHERE x.project_id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_sample(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT cs.id AS record_id, r.user_id FROM campaign_samples cs JOIN sample_readers r ON r.record_id = cs.sample_id WHERE cs.id = ANY (ids)
        UNION ALL
        SELECT cs.id, r.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id AND NOT s.restricted
          JOIN campaign_readers r ON r.record_id = cs.campaign_id
         WHERE cs.id = ANY (ids)
    ) q
    UNION
    SELECT x.id, v.user_id FROM campaign_samples x CROSS JOIN d1_private.v_viewers v WHERE x.id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_sample_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.sample_candidates(ids) c WHERE d1_private.can_read_sample(c.record_id, c.user_id)
    UNION SELECT x.sample_id, v.user_id FROM physical_samples x CROSS JOIN d1_private.v_viewers v WHERE x.sample_id = ANY (ids) $$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_operation_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.operation_candidates(ids) c WHERE d1_private.can_read_operation(c.record_id, c.user_id)
    UNION SELECT x.operation_id, v.user_id FROM manufacturing_operations x CROSS JOIN d1_private.v_viewers v WHERE x.operation_id = ANY (ids) $$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_test_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.test_candidates(ids) c WHERE d1_private.can_read_test(c.record_id, c.user_id)
    UNION SELECT x.session_id, v.user_id FROM test_sessions x CROSS JOIN d1_private.v_viewers v WHERE x.session_id = ANY (ids) $$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.campaign_candidates(ids) c WHERE d1_private.can_read_campaign(c.record_id, c.user_id)
    UNION SELECT x.campaign_id, v.user_id FROM campaigns x CROSS JOIN d1_private.v_viewers v WHERE x.campaign_id = ANY (ids) $$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_project_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.project_candidates(ids) c WHERE d1_private.can_read_project(c.record_id, c.user_id)
    UNION SELECT x.project_id, v.user_id FROM projects x CROSS JOIN d1_private.v_viewers v WHERE x.project_id = ANY (ids) $$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_sample_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT cs.id AS record_id, c.user_id FROM campaign_samples cs JOIN d1_private.sample_candidates(ARRAY(SELECT x.sample_id FROM campaign_samples x WHERE x.id = ANY (ids))) c ON c.record_id = cs.sample_id
         WHERE cs.id = ANY (ids)
        UNION ALL
        SELECT cs.id, c.user_id FROM campaign_samples cs JOIN d1_private.campaign_candidates(ARRAY(SELECT x.campaign_id FROM campaign_samples x WHERE x.id = ANY (ids))) c ON c.record_id = cs.campaign_id
         WHERE cs.id = ANY (ids)
    ) q WHERE d1_private.can_read_campaign_sample(q.record_id, q.user_id)
    UNION SELECT x.id, v.user_id FROM campaign_samples x CROSS JOIN d1_private.v_viewers v WHERE x.id = ANY (ids) $$;

COMMENT ON FUNCTION d1_private.readers_of_sample(uuid[]) IS 'Every login that may read each sample (the single statement of the rule; sample_readers materialises it): the logins on its list, and for an unrestricted sample the investigators of its project, the owners of the campaigns it is in (while the campaign''s project lets them in) and the investigators of an unrestricted campaign''s project. Set-based; equal to readers_of_sample_spec() and to the oracle ref.s_read. Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_operation(uuid[]) IS 'Every login that may read each operation by the ordinary path (operation_readers materialises it; the ownerless runs open to everyone are operation_open_of()): the positive paths (owner, access entry, the PI of its project and of its campaign''s project, and for an unrestricted operation the investigators, the campaign owner, the readers of its sample) kept when the gates hold (P of its project and of its sample''s project, C of its campaign, the exact S* of its sample). Set-based; equal to readers_of_operation_spec() and to the oracle. Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_test(uuid[]) IS 'Every login that may read each test session (test_readers materialises it): the same paths and gates as readers_of_operation, with test_access. Set-based; equal to readers_of_test_spec() and to the oracle. Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_campaign(uuid[]) IS 'Every login that may read each campaign (campaign_readers materialises it): the logins on its list, and for an unrestricted campaign the investigators of its project and the editors of its samples, all while its project lets them in. Set-based; equal to readers_of_campaign_spec() and to the oracle ref.c_read. Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_project(uuid[]) IS 'Every login that may read each project (project_readers materialises it): its list, and for an unrestricted project the owners of its campaigns, the editors of its samples and the owners of operations and tests in it that can read them (taken from operation_readers and test_readers, which sync_readers() has just brought up to date, and which hold exactly the per-pair can_read_operation / can_read_test). Equal to readers_of_project_spec() and to the oracle ref.p_read whenever those tables are in sync. Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_campaign_sample(uuid[]) IS 'Every login that may read each campaign_samples row (ids are campaign_samples.id): readers of its sample, or, for an unrestricted sample, readers of its campaign (campaign_sample_readers materialises it). Composed from sample_readers and campaign_readers, which sync_readers() has just brought up to date (it recomputes samples and campaigns before the junction rows), and equal to readers_of_campaign_sample_spec() and to the oracle ref.cs_read whenever those tables are in sync. Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_sample_spec(uuid[]) IS 'Every login that may read each sample (the rule as candidates then the per-pair predicate can_read_sample; the production readers_of_sample is the set-based equal). Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_operation_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_operation). Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_test_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_test). Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_campaign_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_campaign). Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_project_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_project). Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';
COMMENT ON FUNCTION d1_private.readers_of_campaign_sample_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_campaign_sample). Lab Viewer (migration 185): every login in d1_private.v_viewers is also a reader of every row, whatever the gates say (a separate union after the rule, equal in the production function and in the specification).';

-- 5. A change of the viewer set recomputes the readers of every type.
CREATE OR REPLACE FUNCTION d1_private.trg_readers_directus_users_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM new_rows n WHERE n.role = d1_private.lab_viewer_role() AND n.status <> 'suspended') THEN
        PERFORM d1_private.readers_rebuild();
    END IF;
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.trg_readers_directus_users_ins() IS 'Statement trigger function (INSERT on directus_users): a login created as a viewer (the role Lab Viewer, not suspended) reads every record, so every readers table is recomputed (migration 185). No visibility logic here.';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_directus_users_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id
                WHERE coalesce(o.role = d1_private.lab_viewer_role() AND o.status <> 'suspended', false)
                      IS DISTINCT FROM coalesce(n.role = d1_private.lab_viewer_role() AND n.status <> 'suspended', false)) THEN
        PERFORM d1_private.readers_rebuild();
    END IF;
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.trg_readers_directus_users_upd() IS 'Statement trigger function (UPDATE on directus_users): a login that gained or lost the role Lab Viewer, or was suspended or unsuspended while it has it, changes the viewer set, so every readers table is recomputed; any other update (last_access, last_page, a name) returns at once (migration 185).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_directus_users_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM old_rows o WHERE o.role = d1_private.lab_viewer_role() AND o.status <> 'suspended') THEN
        PERFORM d1_private.readers_rebuild();
    END IF;
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.trg_readers_directus_users_del() IS 'Statement trigger function (DELETE on directus_users): a deleted viewer leaves the viewer set. The readers rows of the login are already gone (their foreign keys cascade); the recompute makes the result certain (migration 185).';

DROP TRIGGER IF EXISTS directus_users_readers_lock ON directus_users;
CREATE TRIGGER directus_users_readers_lock BEFORE INSERT OR DELETE OR UPDATE OF role, status ON directus_users FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_lock();
COMMENT ON TRIGGER directus_users_readers_lock ON directus_users IS 'Takes the global readers lock before the statement locks the login rows (a delete takes FOR UPDATE on one, which a writer holding the readers lock may be waiting for through a foreign key) and before the AFTER triggers recompute the readers (migration 185, as people_readers_lock of migration 166). UPDATE OF role, status only: Directus updates last_access on every request.';
DROP TRIGGER IF EXISTS directus_users_readers_ins ON directus_users;
CREATE TRIGGER directus_users_readers_ins AFTER INSERT ON directus_users REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_directus_users_ins();
COMMENT ON TRIGGER directus_users_readers_ins ON directus_users IS 'A login created as a viewer recomputes the readers tables (migration 185).';
DROP TRIGGER IF EXISTS directus_users_readers_upd ON directus_users;
CREATE TRIGGER directus_users_readers_upd AFTER UPDATE ON directus_users REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_directus_users_upd();
COMMENT ON TRIGGER directus_users_readers_upd ON directus_users IS 'A login that gains or loses the role Lab Viewer, or is suspended or unsuspended, recomputes the readers tables (migration 185). No column list: a trigger with transition tables cannot have one; the function returns at once when role and status did not change the viewer set.';
DROP TRIGGER IF EXISTS directus_users_readers_del ON directus_users;
CREATE TRIGGER directus_users_readers_del AFTER DELETE ON directus_users REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_directus_users_del();
COMMENT ON TRIGGER directus_users_readers_del ON directus_users IS 'A deleted viewer recomputes the readers tables (migration 185).';

-- 6. Logins that already have the role (a re-applied migration, or a role set by hand first) get their rows now.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM d1_private.v_viewers) THEN
        PERFORM d1_private.readers_rebuild();
    END IF;
END
$$;

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- the triggers first, so the role change below does not recompute twice
DROP TRIGGER IF EXISTS directus_users_readers_del ON directus_users;
DROP TRIGGER IF EXISTS directus_users_readers_upd ON directus_users;
DROP TRIGGER IF EXISTS directus_users_readers_ins ON directus_users;
DROP TRIGGER IF EXISTS directus_users_readers_lock ON directus_users;
DROP FUNCTION IF EXISTS d1_private.trg_readers_directus_users_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_directus_users_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_directus_users_ins();

-- Everything below happens once: a second run of this down (a replay after the readers machinery was rolled back and re-applied, as the schema
-- tests do) finds the view gone and does nothing, so it never puts migration 183's functions back over an older head.
DO $lv$
BEGIN
    IF to_regclass('d1_private.v_viewers') IS NOT NULL THEN
        -- the readers functions as migration 183 left them (no viewer branch)
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_sample(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT r.record_id, r.user_id FROM (
        -- on the list: always a reader
        SELECT l.sample_id AS record_id, l.user_id FROM d1_private.v_s_list l WHERE l.sample_id = ANY (ids)
        UNION ALL
        -- inherited, only for an unrestricted sample: the investigators of its project
        SELECT s.sample_id, i.user_id FROM physical_samples s JOIN d1_private.v_p_invs i ON i.project_id = s.project_id
         WHERE s.sample_id = ANY (ids) AND NOT s.restricted
        UNION ALL
        -- the owner of a campaign it is in, while the campaign's project lets them in
        SELECT cs.sample_id, lp.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id
          JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id
          JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id
          LEFT JOIN projects cp ON cp.project_id = c.project_id
         WHERE cs.sample_id = ANY (ids) AND NOT s.restricted
           AND (cp.project_id IS NULL OR NOT cp.restricted
                OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = lp.user_id))
        UNION ALL
        -- the investigators of an unrestricted campaign's project
        SELECT cs.sample_id, i.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id
          JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_p_invs i ON i.project_id = c.project_id
         WHERE cs.sample_id = ANY (ids) AND NOT s.restricted AND NOT c.restricted
    ) r;
END
$$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_sample(uuid[]) IS 'Every login that may read each sample (the single statement of the rule; sample_readers materialises it): the logins on its list, and for an unrestricted sample the investigators of its project, the owners of the campaigns it is in (while the campaign''s project lets them in) and the investigators of an unrestricted campaign''s project. Set-based; equal to readers_of_sample_spec() and to the oracle ref.s_read.'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_operation(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH o AS MATERIALIZED (SELECT x.operation_id, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id, x.restricted
                              FROM manufacturing_operations x WHERE x.operation_id = ANY (ids)),
    paths AS (
        SELECT o.operation_id AS rid, lp.user_id AS uid FROM o JOIN d1_private.v_login_person lp ON lp.person_id = o.owner_person_id
        UNION ALL
        SELECT a.operation_id, lp.user_id FROM operation_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.operation_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN d1_private.v_p_pi pi ON pi.project_id = o.project_id
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id
        UNION ALL
        -- the inherited paths exist only for an unrestricted operation
        SELECT o.operation_id, i.user_id FROM o JOIN d1_private.v_p_invs i ON i.project_id = o.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, lp.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_invs i ON i.project_id = c.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, r.user_id FROM o
          JOIN sample_readers r ON r.record_id = o.sample_id
         WHERE NOT o.restricted
    )
    SELECT DISTINCT pa.rid, pa.uid FROM paths pa
      JOIN o ON o.operation_id = pa.rid
      LEFT JOIN physical_samples s ON s.sample_id = o.sample_id
      LEFT JOIN projects sp ON sp.project_id = s.project_id
      LEFT JOIN projects pr ON pr.project_id = o.project_id
      LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
      LEFT JOIN projects cp ON cp.project_id = c.project_id
     WHERE
       -- P(its project)
       (pr.project_id IS NULL OR NOT pr.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = pr.project_id AND pl.user_id = pa.uid))
       -- P(its sample's project)
       AND (sp.project_id IS NULL OR NOT sp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = sp.project_id AND pl.user_id = pa.uid))
       -- C(its campaign): unrestricted or on its list, and its project lets them in
       AND (c.campaign_id IS NULL OR (
              (NOT c.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = c.campaign_id AND cl.user_id = pa.uid))
              AND (cp.project_id IS NULL OR NOT cp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = pa.uid))))
       -- S*(its sample): unrestricted or on its list, and (on its list, or investigates its own project, or not campaign-shielded)
       AND (s.sample_id IS NULL OR (
              (NOT s.restricted OR EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid))
              AND (EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid)
                   OR EXISTS (SELECT 1 FROM d1_private.v_p_invs i WHERE i.project_id = s.project_id AND i.user_id = pa.uid)
                   OR NOT (EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = s.sample_id)
                           AND NOT EXISTS (SELECT 1 FROM campaign_samples x JOIN campaigns xc ON xc.campaign_id = x.campaign_id
                                             LEFT JOIN projects xp ON xp.project_id = xc.project_id
                                            WHERE x.sample_id = s.sample_id
                                              AND (NOT xc.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = xc.campaign_id AND cl.user_id = pa.uid))
                                              AND (xp.project_id IS NULL OR NOT xp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = xp.project_id AND pl.user_id = pa.uid)))))));
END
$$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_operation(uuid[]) IS 'Every login that may read each operation by the ordinary path (operation_readers materialises it; the ownerless runs open to everyone are operation_open_of()): the positive paths (owner, access entry, the PI of its project and of its campaign''s project, and for an unrestricted operation the investigators, the campaign owner, the readers of its sample) kept when the gates hold (P of its project and of its sample''s project, C of its campaign, the exact S* of its sample). Set-based; equal to readers_of_operation_spec() and to the oracle.'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_test(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH o AS MATERIALIZED (SELECT x.session_id AS operation_id, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id, x.restricted
                              FROM test_sessions x WHERE x.session_id = ANY (ids)),
    paths AS (
        SELECT o.operation_id AS rid, lp.user_id AS uid FROM o JOIN d1_private.v_login_person lp ON lp.person_id = o.owner_person_id
        UNION ALL
        SELECT a.session_id, lp.user_id FROM test_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.session_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN d1_private.v_p_pi pi ON pi.project_id = o.project_id
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN d1_private.v_p_invs i ON i.project_id = o.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, lp.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_invs i ON i.project_id = c.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, r.user_id FROM o
          JOIN sample_readers r ON r.record_id = o.sample_id
         WHERE NOT o.restricted
    )
    SELECT DISTINCT pa.rid, pa.uid FROM paths pa
      JOIN o ON o.operation_id = pa.rid
      LEFT JOIN physical_samples s ON s.sample_id = o.sample_id
      LEFT JOIN projects sp ON sp.project_id = s.project_id
      LEFT JOIN projects pr ON pr.project_id = o.project_id
      LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
      LEFT JOIN projects cp ON cp.project_id = c.project_id
     WHERE
       (pr.project_id IS NULL OR NOT pr.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = pr.project_id AND pl.user_id = pa.uid))
       AND (sp.project_id IS NULL OR NOT sp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = sp.project_id AND pl.user_id = pa.uid))
       AND (c.campaign_id IS NULL OR (
              (NOT c.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = c.campaign_id AND cl.user_id = pa.uid))
              AND (cp.project_id IS NULL OR NOT cp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = pa.uid))))
       AND (s.sample_id IS NULL OR (
              (NOT s.restricted OR EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid))
              AND (EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid)
                   OR EXISTS (SELECT 1 FROM d1_private.v_p_invs i WHERE i.project_id = s.project_id AND i.user_id = pa.uid)
                   OR NOT (EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = s.sample_id)
                           AND NOT EXISTS (SELECT 1 FROM campaign_samples x JOIN campaigns xc ON xc.campaign_id = x.campaign_id
                                             LEFT JOIN projects xp ON xp.project_id = xc.project_id
                                            WHERE x.sample_id = s.sample_id
                                              AND (NOT xc.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = xc.campaign_id AND cl.user_id = pa.uid))
                                              AND (xp.project_id IS NULL OR NOT xp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = xp.project_id AND pl.user_id = pa.uid)))))));
END
$$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_test(uuid[]) IS 'Every login that may read each test session (test_readers materialises it): the same paths and gates as readers_of_operation, with test_access. Set-based; equal to readers_of_test_spec() and to the oracle.'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT x.record_id, x.user_id FROM (
        SELECT l.campaign_id AS record_id, l.user_id FROM d1_private.v_c_list l WHERE l.campaign_id = ANY (ids)
        UNION ALL
        SELECT c.campaign_id, i.user_id FROM campaigns c JOIN d1_private.v_p_invs i ON i.project_id = c.project_id
         WHERE c.campaign_id = ANY (ids) AND NOT c.restricted
        UNION ALL
        SELECT cs.campaign_id, e.user_id FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_s_editor e ON e.sample_id = cs.sample_id
         WHERE cs.campaign_id = ANY (ids) AND NOT c.restricted
    ) x
    JOIN campaigns c ON c.campaign_id = x.record_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE p.project_id IS NULL OR NOT p.restricted
       OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = p.project_id AND pl.user_id = x.user_id);
END
$$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_campaign(uuid[]) IS 'Every login that may read each campaign (campaign_readers materialises it): the logins on its list, and for an unrestricted campaign the investigators of its project and the editors of its samples, all while its project lets them in. Set-based; equal to readers_of_campaign_spec() and to the oracle ref.c_read.'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_project(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    -- the unrestricted projects among ids (a restricted project is read by its list alone)
    WITH pr AS MATERIALIZED (SELECT x.project_id FROM projects x WHERE x.project_id = ANY (ids) AND NOT x.restricted),
    -- the samples of those projects: their editors read the project
    ps AS MATERIALIZED (SELECT s.sample_id, s.project_id, s.owner_person_id FROM physical_samples s
                         WHERE s.project_id = ANY (ids) AND EXISTS (SELECT 1 FROM pr WHERE pr.project_id = s.project_id))
    -- the list of the project (PI, investigators, access entries)
    SELECT l.project_id, l.user_id FROM d1_private.v_p_list l WHERE l.project_id = ANY (ids)
    UNION
    -- the owner of a campaign of an unrestricted project (on the campaign's list; the project's gate P passes everyone)
    SELECT c.project_id, lp.user_id FROM campaigns c JOIN pr ON pr.project_id = c.project_id JOIN d1_private.v_c_owner co ON co.campaign_id = c.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = co.person_id
    UNION
    -- the editors of its samples (on the sample's list)
    SELECT ps.project_id, lp.user_id FROM ps JOIN d1_private.v_login_person lp ON lp.person_id = ps.owner_person_id
    UNION
    SELECT ps.project_id, o.user_id FROM ps JOIN sample_co_owners o ON o.sample_id = ps.sample_id
    UNION
    SELECT ps.project_id, lp.user_id FROM ps JOIN sample_access a ON a.sample_id = ps.sample_id AND a.role IN ('edit', 'manage') JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id
    UNION
    -- the owner of an operation / test in it that they can read: operation_readers / test_readers already hold exactly that (the ordinary
    -- read; sync_readers() recomputes operations and tests before projects, and every operation whose readers could have changed is in its closure)
    SELECT o.project_id, pe.user_id FROM manufacturing_operations o JOIN pr ON pr.project_id = o.project_id
      JOIN d1_private.v_o_owner oo ON oo.operation_id = o.operation_id
      JOIN people pe ON pe.person_id = oo.person_id AND pe.user_id IS NOT NULL
      JOIN operation_readers r ON r.record_id = o.operation_id AND r.user_id = pe.user_id
     WHERE o.project_id = ANY (ids)
    UNION
    SELECT t.project_id, pe.user_id FROM test_sessions t JOIN pr ON pr.project_id = t.project_id
      JOIN d1_private.v_t_owner tt ON tt.session_id = t.session_id
      JOIN people pe ON pe.person_id = tt.person_id AND pe.user_id IS NOT NULL
      JOIN test_readers r ON r.record_id = t.session_id AND r.user_id = pe.user_id
     WHERE t.project_id = ANY (ids);
END
$$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_project(uuid[]) IS 'Every login that may read each project (project_readers materialises it): its list, and for an unrestricted project the owners of its campaigns, the editors of its samples and the owners of operations and tests in it that can read them (taken from operation_readers and test_readers, which sync_readers() has just brought up to date, and which hold exactly the per-pair can_read_operation / can_read_test). Equal to readers_of_project_spec() and to the oracle ref.p_read whenever those tables are in sync.'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_sample(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT cs.id AS record_id, r.user_id FROM campaign_samples cs JOIN sample_readers r ON r.record_id = cs.sample_id WHERE cs.id = ANY (ids)
        UNION ALL
        SELECT cs.id, r.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id AND NOT s.restricted
          JOIN campaign_readers r ON r.record_id = cs.campaign_id
         WHERE cs.id = ANY (ids)
    ) q;
END
$$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_campaign_sample(uuid[]) IS 'Every login that may read each campaign_samples row (ids are campaign_samples.id): readers of its sample, or, for an unrestricted sample, readers of its campaign (campaign_sample_readers materialises it). Composed from sample_readers and campaign_readers, which sync_readers() has just brought up to date (it recomputes samples and campaigns before the junction rows), and equal to readers_of_campaign_sample_spec() and to the oracle ref.cs_read whenever those tables are in sync.'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_sample_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.sample_candidates(ids) c WHERE d1_private.can_read_sample(c.record_id, c.user_id) $$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_sample_spec(uuid[]) IS 'Every login that may read each sample (the rule as candidates then the per-pair predicate can_read_sample; the production readers_of_sample is the set-based equal).'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_operation_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.operation_candidates(ids) c WHERE d1_private.can_read_operation(c.record_id, c.user_id) $$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_operation_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_operation).'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_test_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.test_candidates(ids) c WHERE d1_private.can_read_test(c.record_id, c.user_id) $$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_test_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_test).'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.campaign_candidates(ids) c WHERE d1_private.can_read_campaign(c.record_id, c.user_id) $$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_campaign_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_campaign).'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_project_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT c.record_id, c.user_id FROM d1_private.project_candidates(ids) c WHERE d1_private.can_read_project(c.record_id, c.user_id) $$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_project_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_project).'$lvq$;
        EXECUTE $lvq$CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_sample_spec(ids uuid[])
 RETURNS TABLE(record_id uuid, user_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path = pg_catalog, public
AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT cs.id AS record_id, c.user_id FROM campaign_samples cs JOIN d1_private.sample_candidates(ARRAY(SELECT x.sample_id FROM campaign_samples x WHERE x.id = ANY (ids))) c ON c.record_id = cs.sample_id
         WHERE cs.id = ANY (ids)
        UNION ALL
        SELECT cs.id, c.user_id FROM campaign_samples cs JOIN d1_private.campaign_candidates(ARRAY(SELECT x.campaign_id FROM campaign_samples x WHERE x.id = ANY (ids))) c ON c.record_id = cs.campaign_id
         WHERE cs.id = ANY (ids)
    ) q WHERE d1_private.can_read_campaign_sample(q.record_id, q.user_id) $$$lvq$;
        EXECUTE $lvq$COMMENT ON FUNCTION d1_private.readers_of_campaign_sample_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_campaign_sample).'$lvq$;
        -- the logins that still have the role are left without one (a role that no longer exists cannot be kept)
        UPDATE directus_users SET role = NULL WHERE role = '10000001-0000-0000-0000-000000000003';
        -- the viewers' rows go: recompute every readers table with the functions of migration 183
        PERFORM d1_private.readers_rebuild();
    END IF;
END
$lv$;

DELETE FROM directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000003';
DELETE FROM directus_access WHERE id = '30000003-0000-0000-0000-000000000003' OR policy = '20000002-0000-0000-0000-000000000003';
DELETE FROM directus_policies WHERE id = '20000002-0000-0000-0000-000000000003';
DELETE FROM directus_roles WHERE id = '10000001-0000-0000-0000-000000000003';

DROP VIEW IF EXISTS d1_private.v_viewers;
DROP FUNCTION IF EXISTS d1_private.lab_viewer_role();
