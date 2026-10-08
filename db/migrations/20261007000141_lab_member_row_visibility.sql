-- migrate:up
-- ADR-0011 (row-level visibility), step 2: put the row filters on the Lab Member policy.
--
-- Until now Lab Member could read and change every sample, operation, test, campaign and project.
-- Owner decisions of 2026-10-07 (docs/adr/0011-row-level-visibility.md): strict enforcement through
-- Directus permission filters (so the Data Studio and the API are restricted, not only the Explorer
-- pages); read follows involvement (owner, co-owner, PI or investigator, campaign owner, and the
-- records reached through the project's campaigns); update is limited to owners and co-owners;
-- delete to the owner (the PI for projects); create stays open, but the d1-access-guard hook
-- refuses the junction rows that would grant visibility. Child rows follow their parent.
-- Reference data stays unfiltered. The audit log is for admins only. People cannot be relinked.
--
-- The filters below are generated from scripts/access_rules.json by
-- `python3 scripts/gen_access_rules.py --values` and embedded here, because a migration is a
-- snapshot of the rules on the day it was written. scripts/configure_users_and_policies.sql carries
-- the same rows (it deletes and re-inserts the policy's rows on every run). tests/phase1_schema.sh
-- fails when the stored permissions differ from the generator's output, so a rule change needs
-- a new migration that pastes the regenerated rows.
--
-- What the rows do, per collection (see the ADR for the exact rules):
--   * Rows are backed up first (d1_private.lab_member_permissions_backup, kept until `down`): every Lab Member
--     row of a ruled collection, of people and of audit_logs, so that `down` restores them exactly.
--   * UPDATE of an existing Lab Member row sets its `permissions` filter. `validation` and `fields`
--     are only set where the rules define them (people), so a field list a deployment narrowed by
--     hand on another collection is kept.
--   * INSERT of a missing row: campaigns, campaign_samples, project_investigators, project_rollup
--     and the three data-file junctions were never granted by this repo's scripts (a deployment may
--     have granted them by hand and then the UPDATE covers them), and a fresh database (CI) has no
--     Lab Member rows for the rest, since only configure_users_and_policies.sql creates them.
--   * DELETE of a row the rules no longer grant: audit_logs read and people delete.
--   * Rows of other collections, and of other policies, are not touched.
--
-- Also here:
--   * Indexes on the columns the filters join through (owner, project, user ids). The junction
--     and FK columns the rules also use (campaign_samples, test_sessions.sample_id and campaign_id,
--     manufacturing_operations.campaign_id, sample_genealogy, *_data_files, people.user_id) are
--     indexed by earlier migrations.
--   * The Directus relations and alias fields the filters walk (a filter on `owner_person_id.user_id`
--     only works while directus_relations has the owner_person_id -> people row). scripts/configure_*.sql
--     used to delete some of them; they are inserted here when missing, and the migration stops
--     (RAISE) when a relation exists but points somewhere else, or an alias name is taken, rather
--     than installing filters that would fail at run time. This includes the hidden aliases
--     projects.samples, projects.operations and projects.sessions (O2M over the records' project_id):
--     the project read rule says "owns or co-owns a sample in it" and "owns an operation or test in
--     it", and a filter needs an alias to traverse. Directus reads relations at start-up: restart it,
--     or clear its cache, to pick them up.
--   * A NOTICE with how many records have no owner. They stay visible only through their project,
--     campaign or co-owners until someone assigns an owner (scripts/transfer_sample_ownership.py).

-- 0. A private schema for what this migration keeps for its own `down`. It is not `public`, so the
-- tables in it are not in v_schema_dictionary (the Ask-DB prompt), not exposed by Directus (it only
-- scans `public`, so the Data Studio and the API never list them) and not readable by the LLM role:
-- nothing is granted on the schema, and the default privileges that hand out new tables apply to
-- `public` only. This is not a permission wall against Directus: it connects as the same database
-- role that owns the schema, so it could read these tables if asked; it just does not look.
CREATE SCHEMA IF NOT EXISTS d1_private;
COMMENT ON SCHEMA d1_private IS
    'Internal bookkeeping of migrations (backups they restore in `migrate:down`). Not exposed by Directus (outside its schema scan) and not granted to d1_llm_readonly; not in v_schema_dictionary.';
REVOKE ALL ON SCHEMA d1_private FROM PUBLIC;

-- What `up` changed in the Directus metadata that `down` must undo again: the hidden projects
-- aliases (relation `one_field` and the field row). Only a change `up` made itself is recorded, so a
-- deployment that already had an alias keeps it when this migration is reversed.
CREATE TABLE IF NOT EXISTS d1_private.lab_member_row_visibility_changes (
    kind       TEXT NOT NULL CHECK (kind IN ('relation_alias', 'alias_field')),
    collection TEXT NOT NULL,
    field      TEXT NOT NULL,
    PRIMARY KEY (kind, collection, field)
);
COMMENT ON TABLE d1_private.lab_member_row_visibility_changes IS
    'ADR-0011 migration 20261007000141: the projects alias metadata it added (relation_alias: many_collection + many_field whose one_field it set; alias_field: the directus_fields row it inserted). `migrate:down` undoes exactly these and drops the table.';

-- 1. Indexes behind the filters.
CREATE INDEX IF NOT EXISTS idx_physical_samples_owner_person_id ON physical_samples (owner_person_id);
CREATE INDEX IF NOT EXISTS idx_physical_samples_project_id ON physical_samples (project_id);
CREATE INDEX IF NOT EXISTS idx_manufacturing_operations_owner_person_id ON manufacturing_operations (owner_person_id);
CREATE INDEX IF NOT EXISTS idx_manufacturing_operations_project_id ON manufacturing_operations (project_id);
CREATE INDEX IF NOT EXISTS idx_test_sessions_owner_person_id ON test_sessions (owner_person_id);
CREATE INDEX IF NOT EXISTS idx_test_sessions_project_id ON test_sessions (project_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_owner_person_id ON campaigns (owner_person_id);
CREATE INDEX IF NOT EXISTS idx_projects_principal_investigator_person ON projects (principal_investigator_person);
CREATE INDEX IF NOT EXISTS idx_project_investigators_user_id ON project_investigators (user_id);
CREATE INDEX IF NOT EXISTS idx_sample_co_owners_user_id ON sample_co_owners (user_id);

-- 2. The Directus relations and aliases the filters walk.
DO $$
DECLARE
    r        RECORD;
    existing RECORD;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            -- who owns / leads (migration 062)
            ('physical_samples', 'owner_person_id', 'people', NULL, NULL, 'nullify'),
            ('manufacturing_operations', 'owner_person_id', 'people', NULL, NULL, 'nullify'),
            ('test_sessions', 'owner_person_id', 'people', NULL, NULL, 'nullify'),
            ('campaigns', 'owner_person_id', 'people', NULL, NULL, 'nullify'),
            ('projects', 'principal_investigator_person', 'people', NULL, NULL, 'nullify'),
            -- project links; the alias is what `projects` filters on
            ('physical_samples', 'project_id', 'projects', 'samples', NULL, 'nullify'),
            ('manufacturing_operations', 'project_id', 'projects', 'operations', NULL, 'nullify'),
            ('test_sessions', 'project_id', 'projects', 'sessions', NULL, 'nullify'),
            ('campaigns', 'project_id', 'projects', 'campaigns', NULL, 'nullify'),
            -- the record's sample and campaign
            ('manufacturing_operations', 'sample_id', 'physical_samples', NULL, NULL, 'delete'),
            ('manufacturing_operations', 'campaign_id', 'campaigns', NULL, NULL, 'nullify'),
            ('test_sessions', 'sample_id', 'physical_samples', NULL, NULL, 'delete'),
            ('test_sessions', 'campaign_id', 'campaigns', NULL, NULL, 'nullify'),
            -- the M2M junctions (migrations 029, 030, 087)
            ('campaign_samples', 'campaign_id', 'campaigns', 'samples', 'sample_id', 'delete'),
            ('campaign_samples', 'sample_id', 'physical_samples', 'campaigns', 'campaign_id', 'delete'),
            ('sample_co_owners', 'sample_id', 'physical_samples', 'co_owners', 'user_id', 'delete'),
            ('sample_co_owners', 'user_id', 'directus_users', NULL, 'sample_id', 'nullify'),
            ('project_investigators', 'project_id', 'projects', 'secondary_investigators', 'user_id', 'delete'),
            ('project_investigators', 'user_id', 'directus_users', NULL, 'project_id', 'nullify'),
            -- child rows follow their parent
            ('sample_stock_provenance', 'sample_id', 'physical_samples', NULL, NULL, 'delete'),
            ('sample_data_files', 'sample_id', 'physical_samples', NULL, NULL, 'delete'),
            ('sample_genealogy', 'child_sample_id', 'physical_samples', NULL, NULL, 'delete'),
            ('sample_genealogy', 'parent_sample_id', 'physical_samples', NULL, NULL, 'delete'),
            ('operation_data_files', 'operation_id', 'manufacturing_operations', NULL, NULL, 'delete'),
            ('machining_force_analysis', 'operation_id', 'manufacturing_operations', NULL, NULL, 'delete'),
            ('fast_run_data', 'operation_id', 'manufacturing_operations', NULL, NULL, 'delete'),
            ('session_data_files', 'session_id', 'test_sessions', NULL, NULL, 'delete'),
            ('test_sessions_subject', 'test_sessions_id', 'test_sessions', NULL, NULL, 'delete'),
            ('project_rollup', 'project_id', 'projects', NULL, NULL, 'delete')
        ) AS v(many_collection, many_field, one_collection, one_field, junction_field, deselect)
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
                RAISE EXCEPTION 'ADR-0011: cannot add relation %.% -> %: alias %.% is already used by another relation',
                    r.many_collection, r.many_field, r.one_collection, r.one_collection, r.one_field;
            END IF;
            INSERT INTO directus_relations
                (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action)
            VALUES (r.many_collection, r.many_field, r.one_collection, r.one_field, r.junction_field, r.deselect);
            IF r.one_collection = 'projects' AND r.one_field IN ('samples', 'operations', 'sessions') THEN
                INSERT INTO d1_private.lab_member_row_visibility_changes (kind, collection, field)
                VALUES ('relation_alias', r.many_collection, r.many_field) ON CONFLICT DO NOTHING;
            END IF;
        ELSIF existing.one_collection IS DISTINCT FROM r.one_collection THEN
            RAISE EXCEPTION 'ADR-0011: directus_relations has %.% -> % but the row filters need -> %',
                r.many_collection, r.many_field, existing.one_collection, r.one_collection;
        ELSIF r.one_field IS NOT NULL AND existing.one_field IS DISTINCT FROM r.one_field THEN
            IF existing.one_field IS NOT NULL THEN
                RAISE EXCEPTION 'ADR-0011: relation %.% already has the alias % but the row filters walk %',
                    r.many_collection, r.many_field, existing.one_field, r.one_field;
            END IF;
            IF EXISTS (
                SELECT 1 FROM directus_relations
                WHERE one_collection = r.one_collection AND one_field = r.one_field
            ) THEN
                RAISE EXCEPTION 'ADR-0011: cannot name the alias %.% (for %.%): it is used by another relation',
                    r.one_collection, r.one_field, r.many_collection, r.many_field;
            END IF;
            UPDATE directus_relations SET one_field = r.one_field WHERE id = existing.id;
            IF r.one_collection = 'projects' AND r.one_field IN ('samples', 'operations', 'sessions') THEN
                INSERT INTO d1_private.lab_member_row_visibility_changes (kind, collection, field)
                VALUES ('relation_alias', r.many_collection, r.many_field) ON CONFLICT DO NOTHING;
            END IF;
        END IF;
    END LOOP;
END
$$;

WITH inserted AS (
INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, 'related-values', v.hidden, v.hidden, v.sort, 'full', v.note
FROM (VALUES
    ('physical_samples', 'co_owners', 'm2m', 'list-m2m', '{"template":"{{user_id.first_name}} {{user_id.last_name}}","junction_field":"user_id"}', FALSE, 22, NULL),
    ('physical_samples', 'campaigns', 'm2m', 'list-m2m', NULL, FALSE, 60, NULL),
    ('campaigns', 'samples', 'm2m', 'list-m2m', NULL, FALSE, 30, NULL),
    ('projects', 'secondary_investigators', 'm2m', 'list-m2m', '{"template":"{{user_id.first_name}} {{user_id.last_name}}","junction_field":"user_id"}', FALSE, 12, NULL),
    ('projects', 'campaigns', 'o2m', 'list-o2m', '{"template":"{{name}} - {{campaign_type}}","enableCreate":true}', FALSE, 13, NULL),
    ('projects', 'samples', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', TRUE, 23,
        'Hidden alias over physical_samples.project_id, used by the Lab Member row filters (ADR-0011).'),
    ('projects', 'operations', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', TRUE, 24,
        'Hidden alias over manufacturing_operations.project_id, used by the Lab Member row filters (ADR-0011).'),
    ('projects', 'sessions', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', TRUE, 25,
        'Hidden alias over test_sessions.project_id, used by the Lab Member row filters (ADR-0011).')
) AS v(collection, field, special, interface, options, hidden, sort, note)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field
)
RETURNING collection, field
)
INSERT INTO d1_private.lab_member_row_visibility_changes (kind, collection, field)
SELECT 'alias_field', collection, field FROM inserted
WHERE collection = 'projects' AND field IN ('samples', 'operations', 'sessions')
ON CONFLICT DO NOTHING;

-- 3. Back up the Lab Member rows this migration changes, once (a second run keeps the first backup).
DO $$
BEGIN
    IF to_regclass('d1_private.lab_member_permissions_backup') IS NULL THEN
        CREATE TABLE d1_private.lab_member_permissions_backup AS
        SELECT * FROM directus_permissions
        WHERE policy = '20000002-0000-0000-0000-000000000002'
          AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'sample_co_owners', 'sample_stock_provenance', 'sample_data_files', 'sample_genealogy', 'campaign_samples', 'operation_data_files', 'machining_force_analysis', 'fast_run_data', 'session_data_files', 'test_sessions_subject', 'project_investigators', 'project_rollup', 'people', 'audit_logs');
        COMMENT ON TABLE d1_private.lab_member_permissions_backup IS
            'ADR-0011 migration 20261007000141: the Lab Member directus_permissions rows (of the collections it changes) as they were before it ran. `migrate:down` restores them and drops this table.';
    END IF;
END
$$;

-- 4. The Lab Member rows, from scripts/access_rules.json.
CREATE TEMPORARY TABLE lab_member_rules (
    collection  TEXT NOT NULL,
    action      TEXT NOT NULL,
    permissions JSON NOT NULL,
    validation  JSON NOT NULL,
    fields      TEXT NOT NULL
);

INSERT INTO lab_member_rules (collection, action, permissions, validation, fields) VALUES
    ('physical_samples', 'create', '{}', '{}', '*'),
    ('physical_samples', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}]}', '{}', '*'),
    ('physical_samples', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    ('physical_samples', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('manufacturing_operations', 'create', '{}', '{}', '*'),
    ('manufacturing_operations', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('manufacturing_operations', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('manufacturing_operations', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('test_sessions', 'create', '{}', '{}', '*'),
    ('test_sessions', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('test_sessions', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('test_sessions', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('campaigns', 'create', '{}', '{}', '*'),
    ('campaigns', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"samples":{"_some":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"samples":{"_some":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*'),
    ('campaigns', 'update', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('campaigns', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('projects', 'create', '{}', '{}', '*'),
    ('projects', 'read', '{"_or":[{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}},{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaigns":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"samples":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"samples":{"_some":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operations":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sessions":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('projects', 'update', '{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('projects', 'delete', '{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('sample_co_owners', 'create', '{}', '{}', '*'),
    ('sample_co_owners', 'read', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*'),
    ('sample_co_owners', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_co_owners', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_stock_provenance', 'create', '{}', '{}', '*'),
    ('sample_stock_provenance', 'read', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*'),
    ('sample_stock_provenance', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_stock_provenance', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_data_files', 'create', '{}', '{}', '*'),
    ('sample_data_files', 'read', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*'),
    ('sample_data_files', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_data_files', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_genealogy', 'create', '{}', '{}', '*'),
    ('sample_genealogy', 'read', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"child_sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"child_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"child_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"parent_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"parent_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"parent_sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"parent_sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"parent_sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"parent_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"parent_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*'),
    ('sample_genealogy', 'update', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('sample_genealogy', 'delete', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('campaign_samples', 'create', '{}', '{}', '*'),
    ('campaign_samples', 'read', '{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"campaign_id":{"samples":{"_some":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"campaign_id":{"samples":{"_some":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*'),
    ('campaign_samples', 'update', '{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('campaign_samples', 'delete', '{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('operation_data_files', 'create', '{}', '{}', '*'),
    ('operation_data_files', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*'),
    ('operation_data_files', 'update', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('operation_data_files', 'delete', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('machining_force_analysis', 'create', '{}', '{}', '*'),
    ('machining_force_analysis', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*'),
    ('machining_force_analysis', 'update', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('fast_run_data', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*'),
    ('session_data_files', 'create', '{}', '{}', '*'),
    ('session_data_files', 'read', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"session_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"session_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"session_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"session_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*'),
    ('session_data_files', 'update', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('session_data_files', 'delete', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('test_sessions_subject', 'create', '{}', '{}', '*'),
    ('test_sessions_subject', 'read', '{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"test_sessions_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"test_sessions_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"test_sessions_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"test_sessions_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*'),
    ('test_sessions_subject', 'update', '{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('test_sessions_subject', 'delete', '{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('project_investigators', 'create', '{}', '{}', '*'),
    ('project_investigators', 'read', '{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"project_id":{"campaigns":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"project_id":{"samples":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"project_id":{"samples":{"_some":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"project_id":{"operations":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"project_id":{"sessions":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('project_investigators', 'update', '{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('project_investigators', 'delete', '{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('project_rollup', 'read', '{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*'),
    ('people', 'create', '{}', '{"_or":[{"user_id":{"_null":true}},{"user_id":{"_eq":"$CURRENT_USER"}}]}', '*'),
    ('people', 'read', '{}', '{}', '*'),
    ('people', 'update', '{}', '{}', 'full_name,email,is_operator,is_researcher,active,notes');

-- Rows the rules no longer grant: the audit log (admins only) and any action of a ruled collection
-- that has no rule (people delete).
DELETE FROM directus_permissions AS p
WHERE p.policy = '20000002-0000-0000-0000-000000000002'
  AND (
      p.collection = 'audit_logs'
      OR (
          p.collection IN (SELECT DISTINCT collection FROM lab_member_rules)
          AND NOT EXISTS (
              SELECT 1 FROM lab_member_rules AS r
              WHERE r.collection = p.collection AND r.action = p.action
          )
      )
  );

UPDATE directus_permissions AS p
SET permissions = r.permissions,
    validation = CASE WHEN r.validation::jsonb <> '{}'::jsonb THEN r.validation ELSE p.validation END,
    fields = CASE WHEN r.fields <> '*' THEN r.fields ELSE p.fields END
FROM lab_member_rules AS r
WHERE p.policy = '20000002-0000-0000-0000-000000000002'
  AND p.collection = r.collection
  AND p.action = r.action;

INSERT INTO directus_permissions (policy, collection, action, permissions, validation, fields)
SELECT '20000002-0000-0000-0000-000000000002', r.collection, r.action, r.permissions, r.validation, r.fields
FROM lab_member_rules AS r
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions AS p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002'
      AND p.collection = r.collection AND p.action = r.action
);

DROP TABLE lab_member_rules;

-- 5. Records nobody owns.
DO $$
DECLARE
    v_samples    BIGINT;
    v_operations BIGINT;
    v_tests      BIGINT;
    v_campaigns  BIGINT;
    v_projects   BIGINT;
BEGIN
    SELECT count(*) INTO v_samples FROM physical_samples WHERE owner_person_id IS NULL;
    SELECT count(*) INTO v_operations FROM manufacturing_operations WHERE owner_person_id IS NULL;
    SELECT count(*) INTO v_tests FROM test_sessions WHERE owner_person_id IS NULL;
    SELECT count(*) INTO v_campaigns FROM campaigns WHERE owner_person_id IS NULL;
    SELECT count(*) INTO v_projects FROM projects WHERE principal_investigator_person IS NULL;
    RAISE NOTICE 'ADR-0011 ownerless records (visible to Lab Members only through a project, campaign or co-owner): physical_samples=%, manufacturing_operations=%, test_sessions=%, campaigns=%, projects without a PI=%',
        v_samples, v_operations, v_tests, v_campaigns, v_projects;
END
$$;

-- migrate:down
-- Back to the Lab Member grants as they were before this migration: every Lab Member row of the
-- collections it changed (the ruled ones, people and audit_logs) is deleted and the rows saved in
-- d1_private.lab_member_permissions_backup are put back, ids included, then the backup table is
-- dropped (and the d1_private schema, when nothing else lives in it).
-- A row a deployment added by hand for one of those collections after the migration goes with the
-- delete. The indexes are dropped. The hidden aliases projects.samples, projects.operations and
-- projects.sessions are removed from the relations and the field list only where `up` set or
-- inserted them (d1_private.lab_member_row_visibility_changes), so an alias that was already there
-- stays. Relations and the other alias fields this migration added because they were missing
-- (co_owners, the campaign samples and so on) are metadata corrections and stay.

DO $$
BEGIN
    IF to_regclass('d1_private.lab_member_permissions_backup') IS NULL THEN
        RAISE EXCEPTION 'ADR-0011: d1_private.lab_member_permissions_backup is missing, so the Lab Member rows cannot be restored';
    END IF;
END
$$;

DELETE FROM directus_permissions
WHERE policy = '20000002-0000-0000-0000-000000000002'
  AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'sample_co_owners', 'sample_stock_provenance', 'sample_data_files', 'sample_genealogy', 'campaign_samples', 'operation_data_files', 'machining_force_analysis', 'fast_run_data', 'session_data_files', 'test_sessions_subject', 'project_investigators', 'project_rollup', 'people', 'audit_logs');

INSERT INTO directus_permissions (id, collection, action, permissions, validation, presets, fields, policy)
SELECT id, collection, action, permissions, validation, presets, fields, policy
FROM d1_private.lab_member_permissions_backup;

DROP TABLE d1_private.lab_member_permissions_backup;

DO $$
BEGIN
    IF to_regclass('d1_private.lab_member_row_visibility_changes') IS NOT NULL THEN
        DELETE FROM directus_fields AS f
        USING d1_private.lab_member_row_visibility_changes AS c
        WHERE c.kind = 'alias_field' AND f.collection = c.collection AND f.field = c.field
          AND f.collection = 'projects' AND f.field IN ('samples', 'operations', 'sessions');
        UPDATE directus_relations AS r
        SET one_field = NULL
        FROM d1_private.lab_member_row_visibility_changes AS c
        WHERE c.kind = 'relation_alias' AND r.many_collection = c.collection AND r.many_field = c.field
          AND r.one_collection = 'projects' AND r.one_field IN ('samples', 'operations', 'sessions');
        DROP TABLE d1_private.lab_member_row_visibility_changes;
    END IF;
END
$$;

-- The schema goes too, unless something else has been put in it since.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class AS c INNER JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'd1_private'
    ) THEN
        DROP SCHEMA IF EXISTS d1_private;
    END IF;
END
$$;

DROP INDEX IF EXISTS idx_sample_co_owners_user_id;
DROP INDEX IF EXISTS idx_project_investigators_user_id;
DROP INDEX IF EXISTS idx_projects_principal_investigator_person;
DROP INDEX IF EXISTS idx_campaigns_owner_person_id;
DROP INDEX IF EXISTS idx_test_sessions_project_id;
DROP INDEX IF EXISTS idx_test_sessions_owner_person_id;
DROP INDEX IF EXISTS idx_manufacturing_operations_project_id;
DROP INDEX IF EXISTS idx_manufacturing_operations_owner_person_id;
DROP INDEX IF EXISTS idx_physical_samples_project_id;
DROP INDEX IF EXISTS idx_physical_samples_owner_person_id;
