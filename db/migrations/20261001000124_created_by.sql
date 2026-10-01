-- migrate:up
-- Permanent, read-only "created by" (the login) on every ownable collection,
-- separate from the editable owner. Historical rows are filled from the audit
-- log's INSERT entries where it recorded a real login; otherwise left NULL.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('physical_samples', 'sample_id'), ('tool_boxes', 'tool_box_id'), ('cutting_inserts', 'insert_id'),
        ('insert_edges', 'edge_id'), ('etchants', 'etchant_id'), ('prep_recipes', 'recipe_id'),
        ('campaigns', 'campaign_id'), ('manufacturing_operations', 'operation_id'),
        ('test_sessions', 'session_id'), ('projects', 'project_id')
    ) v(tbl, pk) LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES directus_users(id) ON DELETE SET NULL', r.tbl);
        EXECUTE format($f$
            UPDATE %1$I x SET created_by = COALESCE(a.canonical_user_id, u.id)
              FROM audit_logs l
              JOIN directus_users u ON u.id::text = l.actor_identity
              LEFT JOIN login_aliases a ON a.alias_user_id = u.id
             WHERE x.created_by IS NULL
               AND l.table_name = %2$L AND l.action_type = 'INSERT'
               AND l.row_after ->> %3$L = x.%3$I::text
        $f$, r.tbl, r.tbl, r.pk);

        INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options,
                                     readonly, hidden, sort, width, required, translations)
        SELECT r.tbl, 'created_by', 'user-created', 'select-dropdown-m2o',
               '{"template":"{{first_name}} {{last_name}}"}', 'user', NULL,
               true, false, 98, 'half', false, '[{"language":"en-US","translation":"Created by"}]'
        WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = r.tbl AND f.field = 'created_by');

        INSERT INTO directus_relations (many_collection, many_field, one_collection, one_deselect_action)
        SELECT r.tbl, 'created_by', 'directus_users', 'nullify'
        WHERE NOT EXISTS (SELECT 1 FROM directus_relations x WHERE x.many_collection = r.tbl AND x.many_field = 'created_by');
    END LOOP;
END $$;

-- migrate:down
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['physical_samples','tool_boxes','cutting_inserts','insert_edges','etchants',
                             'prep_recipes','campaigns','manufacturing_operations','test_sessions','projects'] LOOP
        DELETE FROM directus_relations WHERE many_collection = t AND many_field = 'created_by';
        DELETE FROM directus_fields WHERE collection = t AND field = 'created_by';
        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS created_by', t);
    END LOOP;
END $$;
