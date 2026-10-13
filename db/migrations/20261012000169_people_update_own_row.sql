-- migrate:up
-- A1a: a Lab Member can update only their OWN People row (people.user_id = $CURRENT_USER); admins still edit every row.
--
-- Until now the Lab Member `people` update rule was open to every row (fields full_name, email, is_operator, is_researcher, active, notes).
-- A People row now decides authorization (d1-record-access resolves a person to a login; a login-less person's grant starts working when an
-- admin links one) and email (people.email is the address of a person with no login), so any member could redirect another person's
-- notifications, rename themselves into a colleague's name in the Who-has-access picker, or pre-empt d1-person-link's match for a login an
-- admin is about to create. The filter is `custom.people.update.permissions` in scripts/access_rules.json
-- (python3 scripts/gen_access_rules.py --values --only people); configure_users_and_policies.sql carries the same row for a fresh install.
-- Creating a person is unchanged (a member may still add a person without a login, or their own); only an admin edits that row afterwards.
-- The old filter is kept in d1_private.people_update_rule_backup for `down` (a second up keeps the first backup). Directus caches permissions: flush Redis and restart Directus
-- after applying.

CREATE SCHEMA IF NOT EXISTS d1_private;

CREATE TABLE IF NOT EXISTS d1_private.people_update_rule_backup (
    id          INTEGER PRIMARY KEY,
    permissions JSON
);
COMMENT ON TABLE d1_private.people_update_rule_backup IS
    'Migration 20261012000169: the Lab Member people/update permission row it changed (directus_permissions.id and its old permissions). `migrate:down` puts the old filter back and drops this table.';

INSERT INTO d1_private.people_update_rule_backup (id, permissions)
SELECT p.id, p.permissions
  FROM directus_permissions p
 WHERE p.policy = '20000002-0000-0000-0000-000000000002'
   AND p.collection = 'people' AND p.action = 'update'
   AND p.permissions::jsonb IS DISTINCT FROM '{"user_id":{"_eq":"$CURRENT_USER"}}'::jsonb
ON CONFLICT (id) DO NOTHING;

UPDATE directus_permissions p
   SET permissions = '{"user_id":{"_eq":"$CURRENT_USER"}}'
  FROM d1_private.people_update_rule_backup b
 WHERE b.id = p.id;

-- migrate:down
UPDATE directus_permissions p
   SET permissions = b.permissions
  FROM d1_private.people_update_rule_backup b
 WHERE b.id = p.id;

DROP TABLE IF EXISTS d1_private.people_update_rule_backup;
