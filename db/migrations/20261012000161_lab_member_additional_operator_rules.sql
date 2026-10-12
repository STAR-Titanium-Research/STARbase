-- migrate:up
-- Lab Member rules for the additional-operators junctions (operation_additional_operators,
-- session_additional_operators). Migration 20261001000122 granted the Lab Member policy unfiltered
-- create/read/update/delete on both tables, so any Lab Member could read or change any operation's or
-- test's extra operators. Like operation_data_files / session_data_files, a row now follows its parent:
-- read when the operation/test is readable, update and delete when it is editable; create stays open
-- (Directus does not filter create). These rows grant no visibility of their own, so no access guard
-- is needed. The filters are `python3 scripts/gen_access_rules.py --values` for these two collections
-- (scripts/access_rules.json, 2026-10-12). A Lab Member row whose permissions or validation differ is
-- updated; a missing row is inserted (fields '*'). What it changes or adds is kept in
-- d1_private.lab_member_junction_rules_backup for `down`. Directus caches permissions: flush Redis and
-- restart Directus after applying.

CREATE SCHEMA IF NOT EXISTS d1_private;

CREATE TABLE d1_private.lab_member_junction_rules_backup (
    id          INTEGER PRIMARY KEY,
    permissions JSON,
    validation  JSON,
    inserted    BOOLEAN NOT NULL DEFAULT FALSE
);
COMMENT ON TABLE d1_private.lab_member_junction_rules_backup IS
    'Migration 20261012000161: the Lab Member permission rows it changed on the additional-operators junctions (directus_permissions.id with the old permissions and validation) or inserted (inserted = true). `migrate:down` restores or deletes them and drops the table.';

CREATE TEMP TABLE _lm_junction_rules (collection TEXT, action TEXT, filter JSON) ON COMMIT DROP;
INSERT INTO _lm_junction_rules (collection, action, filter) VALUES
    ('operation_additional_operators', 'create', '{}'),
    ('operation_additional_operators', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"campaigns":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"campaign_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}'),
    ('operation_additional_operators', 'update', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'),
    ('operation_additional_operators', 'delete', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'),
    ('session_additional_operators', 'create', '{}'),
    ('session_additional_operators', 'read', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"campaigns":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"session_id":{"sample_id":{"campaigns":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"session_id":{"sample_id":{"campaigns":{"campaign_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"session_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"campaign_id":{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}'),
    ('session_additional_operators', 'update', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'),
    ('session_additional_operators', 'delete', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}');

WITH targets AS (
    SELECT p.id, p.permissions AS old_p, p.validation AS old_v, g.filter
      FROM directus_permissions p
      JOIN _lm_junction_rules g ON g.collection = p.collection AND g.action = p.action
     WHERE p.policy = '20000002-0000-0000-0000-000000000002'
       AND (p.permissions::jsonb IS DISTINCT FROM g.filter::jsonb
            OR p.validation::jsonb IS DISTINCT FROM '{}'::jsonb)
), saved AS (
    INSERT INTO d1_private.lab_member_junction_rules_backup (id, permissions, validation)
    SELECT id, old_p, old_v FROM targets
)
UPDATE directus_permissions p
   SET permissions = t.filter, validation = '{}'
  FROM targets t
 WHERE p.id = t.id;

WITH added AS (
    INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
    SELECT g.collection, g.action, g.filter, '{}', '*', '20000002-0000-0000-0000-000000000002'
      FROM _lm_junction_rules g
     WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p
                        WHERE p.policy = '20000002-0000-0000-0000-000000000002'
                          AND p.collection = g.collection AND p.action = g.action)
    RETURNING id
)
INSERT INTO d1_private.lab_member_junction_rules_backup (id, inserted)
SELECT id, TRUE FROM added;

-- migrate:down
DELETE FROM directus_permissions p
 USING d1_private.lab_member_junction_rules_backup b
 WHERE b.id = p.id AND b.inserted;

UPDATE directus_permissions p
   SET permissions = b.permissions, validation = b.validation
  FROM d1_private.lab_member_junction_rules_backup b
 WHERE b.id = p.id AND NOT b.inserted;

DROP TABLE IF EXISTS d1_private.lab_member_junction_rules_backup;
