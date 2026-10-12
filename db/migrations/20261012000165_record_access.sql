-- migrate:up
-- Record access, schema (A1a Task 1; spec docs/superpowers/specs/2026-10-12-record-access-design.md section 2).
--
-- Why: today a record's visibility follows its owner, co-owners (sample_co_owners) and a project's
-- investigators (project_investigators), all keyed by login (directus_users). "Who has access" needs to
-- name a person who has no login yet, and a record that can be marked Restricted. This migration adds
-- only the storage; the rules that read it come in the next migrations (166 onward), so nothing visible
-- changes here:
--   * restricted BOOLEAN NOT NULL DEFAULT false on physical_samples, manufacturing_operations,
--     test_sessions, campaigns and projects (the default keeps Directus from treating it as a required
--     field, the T0a incident of 2026-10-10, and leaves every existing row unrestricted), each with a
--     partial index WHERE restricted so "my restricted records" stays cheap;
--   * five access tables, one per record type, each with a real foreign key to its parent and a
--     person_id -> people (so a person with no login can be added; the filters read
--     access._some.person_id.user_id, like owner_person_id.user_id). Roles: view or edit;
--     project_access: view or investigator. Only the record-access endpoint writes them, so no OCC
--     version column. They get the audit trigger of migration 121;
--   * the Directus metadata the filters walk (as migration 141 does for the owner relations): hidden
--     collections, the parent FK relations with the hidden O2M alias `access`, the person_id -> people
--     relations, the hidden `access` alias fields and the hidden read-only `restricted` fields. A
--     relation that exists but points elsewhere, or an alias name already used by another relation,
--     stops the migration (RAISE) instead of installing metadata the rules would not resolve through.
--     scripts/configure_*.sql delete and re-insert these field and relation rows, so they re-add them
--     (phase1 checks the metadata after the configure scripts).
--
-- Directus reads relations at start-up: restart it, or clear its cache, to pick them up.
-- Down: drops the tables and columns and deletes the metadata rows this migration added.
SET LOCAL lock_timeout = '10s';

-- 1. The restricted flag. A constant default is a catalogue-only change (no table rewrite).
ALTER TABLE physical_samples ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE manufacturing_operations ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE test_sessions ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE campaigns ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_physical_samples_restricted ON physical_samples (restricted) WHERE restricted;
CREATE INDEX idx_manufacturing_operations_restricted ON manufacturing_operations (restricted) WHERE restricted;
CREATE INDEX idx_test_sessions_restricted ON test_sessions (restricted) WHERE restricted;
CREATE INDEX idx_campaigns_restricted ON campaigns (restricted) WHERE restricted;
CREATE INDEX idx_projects_restricted ON projects (restricted) WHERE restricted;

COMMENT ON COLUMN physical_samples.restricted IS 'When true the sample is Restricted: visible only to the people on its access list, its owner and admins (rules from migration 166; until then the flag has no effect). Hidden and read-only in Directus; only the record-access endpoint changes it. Default false, so every record stays as visible as before.';
COMMENT ON INDEX idx_physical_samples_restricted IS 'Finds the Restricted samples without scanning the table. Partial: only rows with restricted = true.';
COMMENT ON COLUMN manufacturing_operations.restricted IS 'When true the manufacturing operation is Restricted: visible only to the people on its access list, its owner and admins (rules from migration 166; until then the flag has no effect). Hidden and read-only in Directus; only the record-access endpoint changes it. Default false, so every record stays as visible as before.';
COMMENT ON INDEX idx_manufacturing_operations_restricted IS 'Finds the Restricted manufacturing operations without scanning the table. Partial: only rows with restricted = true.';
COMMENT ON COLUMN test_sessions.restricted IS 'When true the test session is Restricted: visible only to the people on its access list, its owner and admins (rules from migration 166; until then the flag has no effect). Hidden and read-only in Directus; only the record-access endpoint changes it. Default false, so every record stays as visible as before.';
COMMENT ON INDEX idx_test_sessions_restricted IS 'Finds the Restricted test sessions without scanning the table. Partial: only rows with restricted = true.';
COMMENT ON COLUMN campaigns.restricted IS 'When true the campaign is Restricted: visible only to the people on its access list, its owner and admins (rules from migration 166; until then the flag has no effect). Hidden and read-only in Directus; only the record-access endpoint changes it. Default false, so every record stays as visible as before.';
COMMENT ON INDEX idx_campaigns_restricted IS 'Finds the Restricted campaigns without scanning the table. Partial: only rows with restricted = true.';
COMMENT ON COLUMN projects.restricted IS 'When true the project is Restricted: visible only to the people on its access list, its owner and admins (rules from migration 166; until then the flag has no effect). Hidden and read-only in Directus; only the record-access endpoint changes it. Default false, so every record stays as visible as before.';
COMMENT ON INDEX idx_projects_restricted IS 'Finds the Restricted projects without scanning the table. Partial: only rows with restricted = true.';

-- 2. The access tables.

CREATE TABLE sample_access (
    access_id UUID NOT NULL DEFAULT gen_random_uuid(),
    sample_id UUID NOT NULL,
    person_id UUID NOT NULL,
    role TEXT NOT NULL,
    added_by_person_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sample_access_pkey PRIMARY KEY (access_id),
    CONSTRAINT sample_access_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES physical_samples (sample_id) ON DELETE CASCADE,
    CONSTRAINT sample_access_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT sample_access_added_by_person_id_fkey FOREIGN KEY (added_by_person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT sample_access_role_check CHECK (role IN ('view', 'edit')),
    CONSTRAINT sample_access_sample_id_person_id_key UNIQUE (sample_id, person_id)
);

CREATE INDEX sample_access_person_idx ON sample_access (person_id);

CREATE TRIGGER audit_sample_access
    AFTER INSERT OR UPDATE OR DELETE ON sample_access
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

COMMENT ON TABLE sample_access IS 'Who has access to a sample, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and sample. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the sample and with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN sample_access.access_id IS 'Surrogate key of the grant.';
COMMENT ON COLUMN sample_access.sample_id IS 'The sample the grant is on (physical_samples.sample_id). Deleted with it.';
COMMENT ON COLUMN sample_access.person_id IS 'The person who has access (people.person_id), not a login: the rules follow people.user_id. Deleted with the person.';
COMMENT ON COLUMN sample_access.role IS 'What the person can do: view (can see) or edit (can change).';
COMMENT ON COLUMN sample_access.added_by_person_id IS 'The person who made the grant; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN sample_access.created_at IS 'When the grant was made.';
COMMENT ON INDEX sample_access_person_idx IS 'Finds everything one person has access to; the row filters join through it.';

CREATE TABLE operation_access (
    access_id UUID NOT NULL DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL,
    person_id UUID NOT NULL,
    role TEXT NOT NULL,
    added_by_person_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT operation_access_pkey PRIMARY KEY (access_id),
    CONSTRAINT operation_access_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES manufacturing_operations (operation_id) ON DELETE CASCADE,
    CONSTRAINT operation_access_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT operation_access_added_by_person_id_fkey FOREIGN KEY (added_by_person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT operation_access_role_check CHECK (role IN ('view', 'edit')),
    CONSTRAINT operation_access_operation_id_person_id_key UNIQUE (operation_id, person_id)
);

CREATE INDEX operation_access_person_idx ON operation_access (person_id);

CREATE TRIGGER audit_operation_access
    AFTER INSERT OR UPDATE OR DELETE ON operation_access
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

COMMENT ON TABLE operation_access IS 'Who has access to a manufacturing operation, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and manufacturing operation. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the manufacturing operation and with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN operation_access.access_id IS 'Surrogate key of the grant.';
COMMENT ON COLUMN operation_access.operation_id IS 'The manufacturing operation the grant is on (manufacturing_operations.operation_id). Deleted with it.';
COMMENT ON COLUMN operation_access.person_id IS 'The person who has access (people.person_id), not a login: the rules follow people.user_id. Deleted with the person.';
COMMENT ON COLUMN operation_access.role IS 'What the person can do: view (can see) or edit (can change).';
COMMENT ON COLUMN operation_access.added_by_person_id IS 'The person who made the grant; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN operation_access.created_at IS 'When the grant was made.';
COMMENT ON INDEX operation_access_person_idx IS 'Finds everything one person has access to; the row filters join through it.';

CREATE TABLE test_access (
    access_id UUID NOT NULL DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL,
    person_id UUID NOT NULL,
    role TEXT NOT NULL,
    added_by_person_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT test_access_pkey PRIMARY KEY (access_id),
    CONSTRAINT test_access_session_id_fkey FOREIGN KEY (session_id) REFERENCES test_sessions (session_id) ON DELETE CASCADE,
    CONSTRAINT test_access_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT test_access_added_by_person_id_fkey FOREIGN KEY (added_by_person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT test_access_role_check CHECK (role IN ('view', 'edit')),
    CONSTRAINT test_access_session_id_person_id_key UNIQUE (session_id, person_id)
);

CREATE INDEX test_access_person_idx ON test_access (person_id);

CREATE TRIGGER audit_test_access
    AFTER INSERT OR UPDATE OR DELETE ON test_access
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

COMMENT ON TABLE test_access IS 'Who has access to a test session, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and test session. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the test session and with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN test_access.access_id IS 'Surrogate key of the grant.';
COMMENT ON COLUMN test_access.session_id IS 'The test session the grant is on (test_sessions.session_id). Deleted with it.';
COMMENT ON COLUMN test_access.person_id IS 'The person who has access (people.person_id), not a login: the rules follow people.user_id. Deleted with the person.';
COMMENT ON COLUMN test_access.role IS 'What the person can do: view (can see) or edit (can change).';
COMMENT ON COLUMN test_access.added_by_person_id IS 'The person who made the grant; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN test_access.created_at IS 'When the grant was made.';
COMMENT ON INDEX test_access_person_idx IS 'Finds everything one person has access to; the row filters join through it.';

CREATE TABLE campaign_access (
    access_id UUID NOT NULL DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL,
    person_id UUID NOT NULL,
    role TEXT NOT NULL,
    added_by_person_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT campaign_access_pkey PRIMARY KEY (access_id),
    CONSTRAINT campaign_access_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns (campaign_id) ON DELETE CASCADE,
    CONSTRAINT campaign_access_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT campaign_access_added_by_person_id_fkey FOREIGN KEY (added_by_person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT campaign_access_role_check CHECK (role IN ('view', 'edit')),
    CONSTRAINT campaign_access_campaign_id_person_id_key UNIQUE (campaign_id, person_id)
);

CREATE INDEX campaign_access_person_idx ON campaign_access (person_id);

CREATE TRIGGER audit_campaign_access
    AFTER INSERT OR UPDATE OR DELETE ON campaign_access
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

COMMENT ON TABLE campaign_access IS 'Who has access to a campaign, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and campaign. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the campaign and with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN campaign_access.access_id IS 'Surrogate key of the grant.';
COMMENT ON COLUMN campaign_access.campaign_id IS 'The campaign the grant is on (campaigns.campaign_id). Deleted with it.';
COMMENT ON COLUMN campaign_access.person_id IS 'The person who has access (people.person_id), not a login: the rules follow people.user_id. Deleted with the person.';
COMMENT ON COLUMN campaign_access.role IS 'What the person can do: view (can see) or edit (can change).';
COMMENT ON COLUMN campaign_access.added_by_person_id IS 'The person who made the grant; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN campaign_access.created_at IS 'When the grant was made.';
COMMENT ON INDEX campaign_access_person_idx IS 'Finds everything one person has access to; the row filters join through it.';

CREATE TABLE project_access (
    access_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    person_id UUID NOT NULL,
    role TEXT NOT NULL,
    added_by_person_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT project_access_pkey PRIMARY KEY (access_id),
    CONSTRAINT project_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (project_id) ON DELETE CASCADE,
    CONSTRAINT project_access_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT project_access_added_by_person_id_fkey FOREIGN KEY (added_by_person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT project_access_role_check CHECK (role IN ('view', 'investigator')),
    CONSTRAINT project_access_project_id_person_id_key UNIQUE (project_id, person_id)
);

CREATE INDEX project_access_person_idx ON project_access (person_id);

CREATE TRIGGER audit_project_access
    AFTER INSERT OR UPDATE OR DELETE ON project_access
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

COMMENT ON TABLE project_access IS 'Who has access to a project, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and project. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the project and with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN project_access.access_id IS 'Surrogate key of the grant.';
COMMENT ON COLUMN project_access.project_id IS 'The project the grant is on (projects.project_id). Deleted with it.';
COMMENT ON COLUMN project_access.person_id IS 'The person who has access (people.person_id), not a login: the rules follow people.user_id. Deleted with the person.';
COMMENT ON COLUMN project_access.role IS 'What the person can do: view (can see the project''s records) or investigator (a secondary investigator).';
COMMENT ON COLUMN project_access.added_by_person_id IS 'The person who made the grant; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN project_access.created_at IS 'When the grant was made.';
COMMENT ON INDEX project_access_person_idx IS 'Finds everything one person has access to; the row filters join through it.';

-- 3. The Directus metadata the filters walk.
INSERT INTO directus_collections (collection, icon, note, hidden, sort)
SELECT v.collection, 'lock', v.note, TRUE, v.sort
FROM (VALUES
    ('sample_access', 'Access list of a sample (A1a); written only through the record-access endpoint', 92),
    ('operation_access', 'Access list of a manufacturing operation (A1a); written only through the record-access endpoint', 93),
    ('test_access', 'Access list of a test session (A1a); written only through the record-access endpoint', 94),
    ('campaign_access', 'Access list of a campaign (A1a); written only through the record-access endpoint', 95),
    ('project_access', 'Access list of a project (A1a); written only through the record-access endpoint', 96)
) AS v (collection, note, sort)
WHERE NOT EXISTS (SELECT 1 FROM directus_collections AS c WHERE c.collection = v.collection);

DO $$
DECLARE
    r        RECORD;
    existing RECORD;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('sample_access', 'sample_id', 'physical_samples', 'access', 'delete'),
            ('operation_access', 'operation_id', 'manufacturing_operations', 'access', 'delete'),
            ('test_access', 'session_id', 'test_sessions', 'access', 'delete'),
            ('campaign_access', 'campaign_id', 'campaigns', 'access', 'delete'),
            ('project_access', 'project_id', 'projects', 'access', 'delete'),
            ('sample_access', 'person_id', 'people', NULL, 'nullify'),
            ('operation_access', 'person_id', 'people', NULL, 'nullify'),
            ('test_access', 'person_id', 'people', NULL, 'nullify'),
            ('campaign_access', 'person_id', 'people', NULL, 'nullify'),
            ('project_access', 'person_id', 'people', NULL, 'nullify')
        ) AS v (many_collection, many_field, one_collection, one_field, deselect)
    LOOP
        SELECT * INTO existing
        FROM directus_relations
        WHERE many_collection = r.many_collection AND many_field = r.many_field
        ORDER BY id
        LIMIT 1;

        IF NOT FOUND THEN
            IF r.one_field IS NOT NULL AND EXISTS (
                SELECT 1 FROM directus_relations
                WHERE one_collection = r.one_collection AND one_field = r.one_field
            ) THEN
                RAISE EXCEPTION 'A1a: cannot add relation %.% -> %: alias %.% is already used by another relation',
                    r.many_collection, r.many_field, r.one_collection, r.one_collection, r.one_field;
            END IF;
            INSERT INTO directus_relations
                (many_collection, many_field, one_collection, one_field, one_deselect_action)
            VALUES (r.many_collection, r.many_field, r.one_collection, r.one_field, r.deselect);
        ELSIF existing.one_collection IS DISTINCT FROM r.one_collection THEN
            RAISE EXCEPTION 'A1a: directus_relations has %.% -> % but the access rules need -> %',
                r.many_collection, r.many_field, existing.one_collection, r.one_collection;
        ELSIF existing.one_field IS DISTINCT FROM r.one_field THEN
            RAISE EXCEPTION 'A1a: relation %.% has the alias % but the access rules walk %',
                r.many_collection, r.many_field, existing.one_field, r.one_field;
        END IF;
    END LOOP;
END
$$;

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, TRUE, TRUE, v.sort, v.width, v.note
FROM (VALUES
    ('physical_samples', 'access', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 90, 'full',
        'Hidden alias over sample_access.sample_id: the access list the record-access rules filter on (A1a).'),
    ('manufacturing_operations', 'access', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 90, 'full',
        'Hidden alias over operation_access.operation_id: the access list the record-access rules filter on (A1a).'),
    ('test_sessions', 'access', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 90, 'full',
        'Hidden alias over test_access.session_id: the access list the record-access rules filter on (A1a).'),
    ('campaigns', 'access', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 90, 'full',
        'Hidden alias over campaign_access.campaign_id: the access list the record-access rules filter on (A1a).'),
    ('projects', 'access', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 90, 'full',
        'Hidden alias over project_access.project_id: the access list the record-access rules filter on (A1a).'),
    ('physical_samples', 'restricted', 'cast-boolean', 'toggle', NULL, 'boolean', 91, 'half',
        'Restricted record (A1a). Hidden and read-only until the Restrict switch ships; changed only by the record-access endpoint.'),
    ('manufacturing_operations', 'restricted', 'cast-boolean', 'toggle', NULL, 'boolean', 91, 'half',
        'Restricted record (A1a). Hidden and read-only until the Restrict switch ships; changed only by the record-access endpoint.'),
    ('test_sessions', 'restricted', 'cast-boolean', 'toggle', NULL, 'boolean', 91, 'half',
        'Restricted record (A1a). Hidden and read-only until the Restrict switch ships; changed only by the record-access endpoint.'),
    ('campaigns', 'restricted', 'cast-boolean', 'toggle', NULL, 'boolean', 91, 'half',
        'Restricted record (A1a). Hidden and read-only until the Restrict switch ships; changed only by the record-access endpoint.'),
    ('projects', 'restricted', 'cast-boolean', 'toggle', NULL, 'boolean', 91, 'half',
        'Restricted record (A1a). Hidden and read-only until the Restrict switch ships; changed only by the record-access endpoint.')
) AS v (collection, field, special, interface, options, display, sort, width, note)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields AS f WHERE f.collection = v.collection AND f.field = v.field
);

-- migrate:down
SET LOCAL lock_timeout = '10s';

DELETE FROM directus_fields
WHERE (field IN ('access', 'restricted') AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects'))
   OR collection IN ('sample_access', 'operation_access', 'test_access', 'campaign_access', 'project_access');

DELETE FROM directus_relations
WHERE many_collection IN ('sample_access', 'operation_access', 'test_access', 'campaign_access', 'project_access');

DELETE FROM directus_collections
WHERE collection IN ('sample_access', 'operation_access', 'test_access', 'campaign_access', 'project_access');

DROP TABLE IF EXISTS project_access;
DROP TABLE IF EXISTS campaign_access;
DROP TABLE IF EXISTS test_access;
DROP TABLE IF EXISTS operation_access;
DROP TABLE IF EXISTS sample_access;

DROP INDEX IF EXISTS idx_projects_restricted;
DROP INDEX IF EXISTS idx_campaigns_restricted;
DROP INDEX IF EXISTS idx_test_sessions_restricted;
DROP INDEX IF EXISTS idx_manufacturing_operations_restricted;
DROP INDEX IF EXISTS idx_physical_samples_restricted;

ALTER TABLE projects DROP COLUMN IF EXISTS restricted;
ALTER TABLE campaigns DROP COLUMN IF EXISTS restricted;
ALTER TABLE test_sessions DROP COLUMN IF EXISTS restricted;
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS restricted;
ALTER TABLE physical_samples DROP COLUMN IF EXISTS restricted;
