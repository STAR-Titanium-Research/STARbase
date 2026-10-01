-- migrate:up
-- Several people can run one operation / test session. operator_person_id stays
-- the MAIN operator (the force app sets exactly one); everyone else who ran it
-- goes in these junctions, shown as "Additional operators" on the forms.

CREATE TABLE operation_additional_operators (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_id uuid NOT NULL REFERENCES manufacturing_operations(operation_id) ON DELETE CASCADE,
    person_id    uuid NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    CONSTRAINT operation_additional_operators_unique UNIQUE (operation_id, person_id)
);
CREATE INDEX operation_additional_operators_person_idx ON operation_additional_operators (person_id);
COMMENT ON TABLE operation_additional_operators IS 'People who ran a manufacturing operation besides its main operator (operator_person_id).';

CREATE TABLE session_additional_operators (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id uuid NOT NULL REFERENCES test_sessions(session_id) ON DELETE CASCADE,
    person_id  uuid NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    CONSTRAINT session_additional_operators_unique UNIQUE (session_id, person_id)
);
CREATE INDEX session_additional_operators_person_idx ON session_additional_operators (person_id);
COMMENT ON TABLE session_additional_operators IS 'People who ran a test session besides its main operator (operator_person_id).';

-- Directus: hidden junction collections, M2M alias fields, relations (pattern of campaign_samples, 20260710000087).
INSERT INTO directus_collections (collection, icon, note, hidden, sort)
VALUES ('operation_additional_operators', 'group', 'M2M junction: operation <-> additional operator', true, 90),
       ('session_additional_operators',   'group', 'M2M junction: test session <-> additional operator', true, 91)
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (collection, field, interface, special, options, width, sort, hidden, translations)
SELECT v.collection, v.field, v.interface, v.special, v.options::json, v.width, v.sort, v.hidden, v.translations::json
FROM (VALUES
    ('operation_additional_operators', 'operation_id', 'select-dropdown-m2o', 'm2o', NULL, 'half', 1, false, NULL),
    ('operation_additional_operators', 'person_id',    'select-dropdown-m2o', 'm2o', '{"template":"{{full_name}}"}', 'half', 2, false, NULL),
    ('session_additional_operators',   'session_id',   'select-dropdown-m2o', 'm2o', NULL, 'half', 1, false, NULL),
    ('session_additional_operators',   'person_id',    'select-dropdown-m2o', 'm2o', '{"template":"{{full_name}}"}', 'half', 2, false, NULL),
    ('manufacturing_operations', 'additional_operators', 'list-m2m', 'm2m',
        '{"template":"{{person_id.full_name}}","junction_field":"person_id","enableCreate":false}', 'half', 9, false,
        '[{"language":"en-US","translation":"Additional operators"}]'),
    ('test_sessions', 'additional_operators', 'list-m2m', 'm2m',
        '{"template":"{{person_id.full_name}}","junction_field":"person_id","enableCreate":false}', 'half', 9, false,
        '[{"language":"en-US","translation":"Additional operators"}]')
) v(collection, field, interface, special, options, width, sort, hidden, translations)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action)
SELECT * FROM (VALUES
    ('operation_additional_operators', 'operation_id', 'manufacturing_operations', 'additional_operators', 'person_id',    'delete'),
    ('operation_additional_operators', 'person_id',    'people',                   NULL,                   'operation_id', 'nullify'),
    ('session_additional_operators',   'session_id',   'test_sessions',            'additional_operators', 'person_id',    'delete'),
    ('session_additional_operators',   'person_id',    'people',                   NULL,                   'session_id',   'nullify')
) v(many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- Lab Members can record additional operators (same full-CRUD pattern as their other lab-data collections).
INSERT INTO directus_permissions (collection, action, fields, policy)
SELECT v.collection, v.action, '*', '20000002-0000-0000-0000-000000000002'
FROM (VALUES
    ('operation_additional_operators', 'create'), ('operation_additional_operators', 'read'),
    ('operation_additional_operators', 'update'), ('operation_additional_operators', 'delete'),
    ('session_additional_operators', 'create'), ('session_additional_operators', 'read'),
    ('session_additional_operators', 'update'), ('session_additional_operators', 'delete')
) v(collection, action)
WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = '20000002-0000-0000-0000-000000000002'
                  AND p.collection = v.collection AND p.action = v.action);

-- merge_person: also dedupe the new junctions before repointing.
CREATE OR REPLACE FUNCTION merge_person(p_keep uuid, p_drop uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    r       record;
    v_email text;
    v_user  uuid;
BEGIN
    IF p_keep IS NULL OR p_drop IS NULL OR p_keep = p_drop THEN
        RETURN;
    END IF;
    DELETE FROM sample_co_owners d USING sample_co_owners k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.sample_id = d.sample_id;
    DELETE FROM project_investigators d USING project_investigators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.project_id = d.project_id;
    DELETE FROM operation_additional_operators d USING operation_additional_operators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.operation_id = d.operation_id;
    DELETE FROM session_additional_operators d USING session_additional_operators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.session_id = d.session_id;
    FOR r IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'people'::regclass
    LOOP
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col) USING p_keep, p_drop;
    END LOOP;
    SELECT email, user_id INTO v_email, v_user FROM people WHERE person_id = p_drop;
    UPDATE people SET user_id = NULL, legacy_machine_operator_id = NULL WHERE person_id = p_drop;
    UPDATE people SET email = COALESCE(email, v_email), user_id = COALESCE(user_id, v_user)
     WHERE person_id = p_keep;
    DELETE FROM people WHERE person_id = p_drop;
END;
$$;

-- migrate:down
DELETE FROM directus_permissions
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection IN ('operation_additional_operators', 'session_additional_operators');
DELETE FROM directus_relations WHERE many_collection IN ('operation_additional_operators', 'session_additional_operators');
DELETE FROM directus_fields
 WHERE collection IN ('operation_additional_operators', 'session_additional_operators')
    OR (field = 'additional_operators' AND collection IN ('manufacturing_operations', 'test_sessions'));
DELETE FROM directus_collections WHERE collection IN ('operation_additional_operators', 'session_additional_operators');
DROP TABLE IF EXISTS session_additional_operators;
DROP TABLE IF EXISTS operation_additional_operators;
-- Restore merge_person to the migration-120 body.
CREATE OR REPLACE FUNCTION merge_person(p_keep uuid, p_drop uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    r        record;
    v_email  text;
    v_user   uuid;
BEGIN
    IF p_keep IS NULL OR p_drop IS NULL OR p_keep = p_drop THEN
        RETURN;
    END IF;
    -- Junction rows that would duplicate an existing keep row are removed first.
    DELETE FROM sample_co_owners d USING sample_co_owners k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.sample_id = d.sample_id;
    DELETE FROM project_investigators d USING project_investigators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.project_id = d.project_id;
    FOR r IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'people'::regclass
    LOOP
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col) USING p_keep, p_drop;
    END LOOP;
    -- Carry over the email/login the keep row lacks (free the unique columns first).
    SELECT email, user_id INTO v_email, v_user FROM people WHERE person_id = p_drop;
    UPDATE people SET user_id = NULL, legacy_machine_operator_id = NULL WHERE person_id = p_drop;
    UPDATE people SET email = COALESCE(email, v_email), user_id = COALESCE(user_id, v_user)
     WHERE person_id = p_keep;
    DELETE FROM people WHERE person_id = p_drop;
END;
$$;
