-- migrate:up
-- People admin (People 1, Task 1; spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md sections 1.1 and 3.4).
-- Three read-only SQL functions that feed the d1-people-admin endpoint (the admin People page). They only read: no table, no trigger,
-- no Directus permission changes (a Lab Member gets nothing new), and they are not granted to the Ask-the-database role.
--
--   * d1_private.people_attention()        the "needs attention" items, one row per kind of problem, only kinds with at least one hit;
--   * d1_private.person_access(person)     three counts for the person panel: what a person owns, was shared, is an investigator on;
--   * d1_private.person_access_list(person, which)  the records behind one of those counts, with how the person got there.
--
-- All three are SECURITY INVOKER, STABLE and run with a fixed search_path. The endpoint calls them as the database role Directus
-- connects as, after it has checked that the caller is an administrator (or, for the access functions, the person themselves).
-- Down: drops the three functions.

CREATE SCHEMA IF NOT EXISTS d1_private;

-- 1. The attention items.
CREATE OR REPLACE FUNCTION d1_private.people_attention()
RETURNS TABLE (key text, person_ids uuid[], user_ids uuid[])
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    WITH
    -- a usable login (active, invited or suspended: what the People page lists) that nobody is linked to; archived and draft ones are not people the lab acts on
    lw AS (
        SELECT u.id FROM directus_users u
         WHERE u.status IN ('active', 'invited', 'suspended') AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.user_id = u.id)
    ),
    -- an invited login that was never accepted, with its person when it has one
    inv AS (
        SELECT u.id AS uid, pe.person_id AS pid
          FROM directus_users u LEFT JOIN people pe ON pe.user_id = u.id
         WHERE u.status = 'invited'
    ),
    -- no email on the person and none on the linked login
    me AS (
        SELECT pe.person_id AS pid
          FROM people pe LEFT JOIN directus_users u ON u.id = pe.user_id
         WHERE nullif(btrim(pe.email), '') IS NULL AND nullif(btrim(u.email), '') IS NULL
    ),
    -- the same normalised full name, or the same email ignoring case
    dup AS (
        SELECT pe.person_id AS pid
          FROM people pe
         WHERE nullif(lower(btrim(pe.full_name)), '') IS NOT NULL
           AND (SELECT count(*) FROM people o WHERE lower(btrim(o.full_name)) = lower(btrim(pe.full_name))) > 1
        UNION
        SELECT pe.person_id
          FROM people pe
         WHERE nullif(lower(btrim(pe.email)), '') IS NOT NULL
           AND (SELECT count(*) FROM people o WHERE lower(btrim(o.email)) = lower(btrim(pe.email))) > 1
    ),
    -- a former person whose login still works
    fla AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe JOIN directus_users u ON u.id = pe.user_id
         WHERE pe.active = false AND u.status = 'active'
    ),
    -- a suspended login whose person still owns records (or is the PI of a project)
    sor AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe JOIN directus_users u ON u.id = pe.user_id
         WHERE u.status = 'suspended'
           AND (EXISTS (SELECT 1 FROM physical_samples r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM campaigns r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM manufacturing_operations r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM test_sessions r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM projects r WHERE r.principal_investigator_person = pe.person_id))
    ),
    items (ord, key, person_ids, user_ids) AS (
        SELECT 1, 'login_without_person'::text, '{}'::uuid[],
               coalesce((SELECT array_agg(lw.id ORDER BY lw.id) FROM lw), '{}')
        UNION ALL
        SELECT 2, 'invite_not_accepted',
               coalesce((SELECT array_agg(inv.pid ORDER BY inv.pid) FILTER (WHERE inv.pid IS NOT NULL) FROM inv), '{}'),
               coalesce((SELECT array_agg(inv.uid ORDER BY inv.uid) FROM inv), '{}')
        UNION ALL
        SELECT 3, 'missing_email', coalesce((SELECT array_agg(me.pid ORDER BY me.pid) FROM me), '{}'), '{}'::uuid[]
        UNION ALL
        SELECT 4, 'possible_duplicate', coalesce((SELECT array_agg(dup.pid ORDER BY dup.pid) FROM dup), '{}'), '{}'::uuid[]
        UNION ALL
        SELECT 5, 'former_login_active',
               coalesce((SELECT array_agg(fla.pid ORDER BY fla.pid) FROM fla), '{}'),
               coalesce((SELECT array_agg(fla.uid ORDER BY fla.uid) FROM fla), '{}')
        UNION ALL
        SELECT 6, 'suspended_owns_records',
               coalesce((SELECT array_agg(sor.pid ORDER BY sor.pid) FROM sor), '{}'),
               coalesce((SELECT array_agg(sor.uid ORDER BY sor.uid) FROM sor), '{}')
    )
    SELECT i.key, i.person_ids, i.user_ids FROM items i
     WHERE cardinality(i.person_ids) > 0 OR cardinality(i.user_ids) > 0
     ORDER BY i.ord
$$;
COMMENT ON FUNCTION d1_private.people_attention() IS 'What needs an administrator''s attention on the People page: one row per key, only keys with at least one hit, in a fixed order. login_without_person (user_ids: active, invited or suspended logins no person is linked to; archived and draft ones are left out, as on the People page), invite_not_accepted (logins with status invited; person_ids are their people, if any), missing_email (people with no email and no email on the linked login), possible_duplicate (people sharing lower(btrim(full_name)) or lower(email)), former_login_active (people.active = false whose linked login is still active), suspended_owns_records (a suspended login whose person owns a sample, campaign, operation or test, or is the PI of a project). Count an item by user_ids for login_without_person and invite_not_accepted, by person_ids for the others (the person-based keys also fill user_ids with the same people''s logins where they have one). SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migration 174.';

-- 2. The access list of one person: the single source of the counts below.
CREATE OR REPLACE FUNCTION d1_private.person_access_list(p uuid, which text)
RETURNS TABLE (collection text, record_id uuid, level text, source text, granted_by text, added_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
    IF which = 'owns' THEN
        -- the records the person owns, and the projects they are PI of
        RETURN QUERY
        SELECT 'physical_samples'::text, r.sample_id, 'owner'::text, 'owner'::text, NULL::text, NULL::timestamptz
          FROM physical_samples r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'campaigns', r.campaign_id, 'owner', 'owner', NULL, NULL FROM campaigns r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'manufacturing_operations', r.operation_id, 'owner', 'owner', NULL, NULL FROM manufacturing_operations r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'test_sessions', r.session_id, 'owner', 'owner', NULL, NULL FROM test_sessions r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'projects', r.project_id, 'pi', 'pi', NULL, NULL FROM projects r WHERE r.principal_investigator_person = p
        ORDER BY 1, 2;
    ELSIF which = 'shared' THEN
        -- view / edit entries on the five access tables, and the old sample co-owner rows of the person's login
        RETURN QUERY
        SELECT 'physical_samples'::text, a.sample_id, a.role, 'access'::text, g.full_name, a.created_at
          FROM sample_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'campaigns', a.campaign_id, a.role, 'access', g.full_name, a.created_at
          FROM campaign_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'manufacturing_operations', a.operation_id, a.role, 'access', g.full_name, a.created_at
          FROM operation_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'test_sessions', a.session_id, a.role, 'access', g.full_name, a.created_at
          FROM test_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'projects', a.project_id, a.role, 'access', g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'physical_samples', c.sample_id, 'edit', 'co_owner', NULL, NULL
          FROM sample_co_owners c JOIN people pe ON pe.user_id = c.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSIF which = 'investigator' THEN
        -- investigator entries on projects: the access table and the old junction rows of the person's login
        RETURN QUERY
        SELECT 'projects'::text, a.project_id, 'investigator'::text, 'access'::text, g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role = 'investigator'
        UNION ALL
        SELECT 'projects', i.project_id, 'investigator', 'investigator_junction', NULL, NULL
          FROM project_investigators i JOIN people pe ON pe.user_id = i.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSE
        RAISE EXCEPTION 'person_access_list: which must be owns, shared or investigator, got %', coalesce(which, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
END
$$;
COMMENT ON FUNCTION d1_private.person_access_list(uuid, text) IS 'The records behind one count of d1_private.person_access, for the person panel. which = owns: records with owner_person_id = the person in physical_samples, campaigns, manufacturing_operations and test_sessions (level and source owner), and projects they are PI of (level and source pi). which = shared: view / edit rows of the person in the five *_access tables (source access, granted_by the adder''s full_name, added_at the grant date) and the sample_co_owners rows of the person''s login (source co_owner, level edit). which = investigator: project_access rows with role investigator (source access) and project_investigators rows of the person''s login (source investigator_junction). Any other value raises invalid_parameter_value. Ordered by collection, then record_id. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migration 174.';

-- 3. The three counts.
CREATE OR REPLACE FUNCTION d1_private.person_access(p uuid)
RETURNS TABLE (owns int, shared int, investigator int)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    SELECT (SELECT count(*)::int FROM d1_private.person_access_list(p, 'owns')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'shared')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'investigator'))
$$;
COMMENT ON FUNCTION d1_private.person_access(uuid) IS 'The three counts of the person panel, always one row: owns (records they own in samples, campaigns, operations and tests, plus projects they are PI of), shared (view / edit rows of theirs in the five *_access tables, plus the sample_co_owners rows of their login), investigator (project_access rows with role investigator, plus the project_investigators rows of their login). Counts the rows d1_private.person_access_list returns for the same person. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migration 174.';

-- No grant to d1_llm_readonly (the Ask-the-database role): it must not ask who owns what, who is suspended or whose invite is open.
REVOKE ALL ON FUNCTION d1_private.people_attention() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.person_access_list(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.person_access(uuid) FROM PUBLIC;

-- migrate:down
DROP FUNCTION IF EXISTS d1_private.person_access(uuid);
DROP FUNCTION IF EXISTS d1_private.person_access_list(uuid, text);
DROP FUNCTION IF EXISTS d1_private.people_attention();
