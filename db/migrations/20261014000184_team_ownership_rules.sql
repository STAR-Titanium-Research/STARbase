-- migrate:up
-- Team ownership, the Lab Member rules (People 3, Task 2; Ruling O1 of docs/superpowers/plans/2026-10-14-people-3-team-ownership.md).
-- A team-owned record has no owner_person_id: the managers of the owning team hold a derived `manage` row in <type>_access (migration 183) and
-- act as its owner, every other member holds `edit`. So in scripts/access_rules.json
--   * every editor test (`role _in [edit]`) is `role _in [edit, manage]` (a manager edits too), and
--   * the owner sets (sample.owner, record.owner = the delete rule of operations and tests, campaign.owner = campaign.manage) gain a
--     `role _in [manage]` item next to `owner_person_id.user_id`; a plain member of the owning team (edit) is NOT the owner and so cannot
--     delete, share, transfer or restrict the record (the d1-record-access manage rule is this delete rule).
-- The d1-access-guard hook also guards owner_team_id like owner_person_id (changing it needs the delete rule, i.e. a person owner or a manager of
-- the owning team): without that, any editor could write owner_team_id through the API and make their own team the owner. The owner default
-- (d1-owner-default) no longer fills owner_person_id for a record created with owner_team_id.
--
-- The rows are `python3 scripts/gen_access_rules.py --values --only <the collections below>` (a snapshot of the rules on 2026-10-14, as in
-- 20261012000166 section 10): the fifteen collections whose Lab Member rows change (the records, and the children whose update or delete reads the
-- record's editor or owner set through a `via`). A Lab Member row whose permissions or validation differ is updated; a missing row is inserted
-- (fields '*'). What it changes or adds is kept in d1_private.team_ownership_rules_backup for `down`, which restores the old rows exactly.
--
-- Apply this TOGETHER WITH migration 183 and the Task 2 extensions of the same release (d1-access-guard with the owner_team_id guard, d1-owner-default).
-- Directus caches permissions: flush Redis and restart Directus after applying.

CREATE TABLE IF NOT EXISTS d1_private.team_ownership_rules_backup (
    id          INTEGER PRIMARY KEY,
    permissions JSON,
    validation  JSON,
    inserted    BOOLEAN NOT NULL DEFAULT FALSE
);
COMMENT ON TABLE d1_private.team_ownership_rules_backup IS
    'Migration 20261014000184: the Lab Member permission rows it changed (directus_permissions.id with the old permissions and validation) or inserted (inserted = true). `migrate:down` restores or deletes them and drops the table.';

CREATE TEMP TABLE _lm_team_ownership_rules (collection TEXT, action TEXT, filter JSON, validation JSON, fields TEXT) ON COMMIT DROP;
INSERT INTO _lm_team_ownership_rules (collection, action, filter, validation, fields) VALUES
    ('physical_samples', 'create', '{}', '{}', '*'),
    ('physical_samples', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('physical_samples', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit","manage"]}}}]}]}', '{}', '*'),
    ('physical_samples', 'delete', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["manage"]}}}]}]}', '{}', '*'),
    ('manufacturing_operations', 'create', '{}', '{}', '*'),
    ('manufacturing_operations', 'read', '{"_or":[{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"open_to_all":{"_some":{"record_id":{"_nnull":true}}}}]}', '{}', '*'),
    ('manufacturing_operations', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit","manage"]}}}]},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}]}]}]}', '{}', '*'),
    ('manufacturing_operations', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["manage"]}}}]}]}]}', '{}', '*'),
    ('test_sessions', 'create', '{}', '{}', '*'),
    ('test_sessions', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('test_sessions', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit","manage"]}}}]},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}]}]}]}', '{}', '*'),
    ('test_sessions', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["manage"]}}}]}]}]}', '{}', '*'),
    ('campaigns', 'create', '{}', '{}', '*'),
    ('campaigns', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('campaigns', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit","manage"]}}}]}]}]}', '{}', '*'),
    ('campaigns', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["manage"]}}}]}]}]}', '{}', '*'),
    ('sample_co_owners', 'create', '{}', '{}', '*'),
    ('sample_co_owners', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_co_owners', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["manage"]}}}}]}]}', '{}', '*'),
    ('sample_co_owners', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["manage"]}}}}]}]}', '{}', '*'),
    ('sample_stock_provenance', 'create', '{}', '{}', '*'),
    ('sample_stock_provenance', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_stock_provenance', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}', '{}', '*'),
    ('sample_stock_provenance', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}', '{}', '*'),
    ('sample_data_files', 'create', '{}', '{}', '*'),
    ('sample_data_files', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_data_files', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}', '{}', '*'),
    ('sample_data_files', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}', '{}', '*'),
    ('sample_genealogy', 'create', '{}', '{}', '*'),
    ('sample_genealogy', 'read', '{"_or":[{"child_sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"parent_sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    ('sample_genealogy', 'update', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"child_sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}', '{}', '*'),
    ('sample_genealogy', 'delete', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"child_sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}', '{}', '*'),
    ('campaign_samples', 'create', '{}', '{}', '*'),
    ('campaign_samples', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('campaign_samples', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"campaign_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"access":{"role":{"_in":["manage"]}}}}]},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}]}', '{}', '*'),
    ('campaign_samples', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"campaign_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"access":{"role":{"_in":["manage"]}}}}]},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}]}]}]}', '{}', '*'),
    ('operation_data_files', 'create', '{}', '{}', '*'),
    ('operation_data_files', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('operation_data_files', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('operation_data_files', 'delete', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('machining_force_analysis', 'create', '{}', '{}', '*'),
    ('machining_force_analysis', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('machining_force_analysis', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_data_files', 'create', '{}', '{}', '*'),
    ('session_data_files', 'read', '{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_data_files', 'update', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_data_files', 'delete', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('operation_additional_operators', 'create', '{}', '{}', '*'),
    ('operation_additional_operators', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('operation_additional_operators', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('operation_additional_operators', 'delete', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_additional_operators', 'create', '{}', '{}', '*'),
    ('session_additional_operators', 'read', '{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_additional_operators', 'update', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_additional_operators', 'delete', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('test_sessions_subject', 'create', '{}', '{}', '*'),
    ('test_sessions_subject', 'read', '{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('test_sessions_subject', 'update', '{"_and":[{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"test_sessions_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"test_sessions_id":{"restricted":{"_eq":false}}},{"_or":[{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"test_sessions_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('test_sessions_subject', 'delete', '{"_and":[{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"test_sessions_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"test_sessions_id":{"restricted":{"_eq":false}}},{"_or":[{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"test_sessions_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*')
;

-- First keep the rows that are about to change, then change exactly those.
INSERT INTO d1_private.team_ownership_rules_backup (id, permissions, validation)
SELECT p.id, p.permissions, p.validation
  FROM directus_permissions p
  JOIN _lm_team_ownership_rules g ON g.collection = p.collection AND g.action = p.action
 WHERE p.policy = '20000002-0000-0000-0000-000000000002'
   AND (p.permissions::jsonb IS DISTINCT FROM g.filter::jsonb
        OR p.validation::jsonb IS DISTINCT FROM g.validation::jsonb)
ON CONFLICT (id) DO NOTHING;

UPDATE directus_permissions p
   SET permissions = g.filter, validation = g.validation
  FROM _lm_team_ownership_rules g, d1_private.team_ownership_rules_backup b
 WHERE b.id = p.id AND NOT b.inserted
   AND g.collection = p.collection AND g.action = p.action;

WITH added AS (
    INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
    SELECT g.collection, g.action, g.filter, g.validation, g.fields, '20000002-0000-0000-0000-000000000002'
      FROM _lm_team_ownership_rules g
     WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p
                        WHERE p.policy = '20000002-0000-0000-0000-000000000002'
                          AND p.collection = g.collection AND p.action = g.action)
    RETURNING id
)
INSERT INTO d1_private.team_ownership_rules_backup (id, inserted)
SELECT id, TRUE FROM added;


-- The sample create/update field lists of migration 174 name every column and alias except Co-owners, so the new owner_team_id column of
-- migration 183 must join them or the Directus form check (tests/phase1_schema.sh, "field list misses columns") fails. A person still
-- cannot set it: d1-access-guard refuses a non-administrator's owner_team_id on create (Ruling O3) and guards its change like the owner
-- field. A row that is still '*' (166 without 174) needs nothing.
UPDATE directus_permissions
   SET fields = fields || ',owner_team_id'
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection = 'physical_samples' AND action IN ('create', 'update')
   AND fields IS NOT NULL AND fields <> '*'
   AND ',' || fields || ',' NOT LIKE '%,owner_team_id,%';


-- migrate:down
SET LOCAL lock_timeout = '10s';

DELETE FROM directus_permissions p
 USING d1_private.team_ownership_rules_backup b
 WHERE b.id = p.id AND b.inserted;

UPDATE directus_permissions p
   SET permissions = b.permissions, validation = b.validation
  FROM d1_private.team_ownership_rules_backup b
 WHERE b.id = p.id AND NOT b.inserted;

UPDATE directus_permissions
   SET fields = regexp_replace(fields, ',owner_team_id(,|$)', '\1')
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection = 'physical_samples' AND action IN ('create', 'update')
   AND fields IS NOT NULL AND fields <> '*' AND fields LIKE '%,owner_team_id%';

DROP TABLE IF EXISTS d1_private.team_ownership_rules_backup;
