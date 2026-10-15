-- migrate:up
-- Found files and the Inbox (docs/superpowers/specs/2026-10-15-found-files-inbox-design.md section 4, ADR-0020): close the alias squat on
-- People CREATE. This is defence in depth over migration 193's insert trigger people_inbox_columns_insert (which already rejects a non-null
-- uni_alias or scan_while_former on INSERT): the permission row now refuses the fields before the database does.
--
-- Migration 193 added people.uni_alias (whose folder under Users/ is theirs) and people.scan_while_former. Only an administrator may set them:
-- the Lab Member people UPDATE row already lists its fields and leaves them out. The Lab Member people CREATE row, however, has fields '*',
-- so any member could create a person with a uni_alias of their choice ("squatting" a colleague's alias before an administrator assigns it, so the
-- inbox crawler would offer that colleague's folder to the squatter's row) or switch scan_while_former on. The fix is the same as for update: the
-- create row names its fields. It lists every People column EXCEPT those two, so nothing else about creating a person changes (the validation,
-- a person with no login or one's own, is untouched). A column added to people later is not creatable until someone decides, like for update.
--
-- The source is scripts/access_rules.json (custom.people.create.fields), pasted into scripts/configure_users_and_policies.sql by
-- gen_access_rules.py --write; this migration applies the same row to a live database. Directus caches permissions: flush Redis and restart
-- Directus after applying. Down puts the open list back ('*'), which is what the row held before (the generator's value, checked by phase1).

UPDATE directus_permissions
   SET fields = 'person_id,full_name,email,user_id,is_operator,is_researcher,active,notes,legacy_machine_operator_id,created_at'
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection = 'people' AND action = 'create';

-- migrate:down
UPDATE directus_permissions
   SET fields = '*'
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection = 'people' AND action = 'create';
