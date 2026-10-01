-- migrate:up
-- campaigns."operations" and campaigns."sessions" are O2M alias fields (added
-- out-of-band, not by any tracked migration) with no backing directus_relations
-- row. An O2M alias with no relation isn't recognised as virtual, so Directus's
-- query builder falls back to selecting them as literal columns — which don't
-- exist on campaigns — and every read of the collection (list or single item)
-- fails with "column campaigns.operations/sessions does not exist". This also
-- means manufacturing_operations.campaign_id and test_sessions.campaign_id
-- (real FK columns added in 20260628000047) were never given a directus_fields
-- row or relation of their own, so a campaign's operations/sessions could
-- never actually be assigned from either side.

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations)
SELECT 'manufacturing_operations', 'campaign_id', 'm2o', 'select-dropdown-m2o',
       '{"template":"{{name}}"}', 'related-values', '{"template":"{{name}}"}', false, false, 12, 'half', false,
       '[{"language":"en-US","translation":"Campaign"}]'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'campaign_id'
);

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations)
SELECT 'test_sessions', 'campaign_id', 'm2o', 'select-dropdown-m2o',
       '{"template":"{{name}}"}', 'related-values', '{"template":"{{name}}"}', false, false, 10, 'half', false,
       '[{"language":"en-US","translation":"Campaign"}]'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields WHERE collection = 'test_sessions' AND field = 'campaign_id'
);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field)
SELECT 'manufacturing_operations', 'campaign_id', 'campaigns', 'operations'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_relations WHERE many_collection = 'manufacturing_operations' AND many_field = 'campaign_id'
);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field)
SELECT 'test_sessions', 'campaign_id', 'campaigns', 'sessions'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_relations WHERE many_collection = 'test_sessions' AND many_field = 'campaign_id'
);

-- migrate:down
DELETE FROM directus_relations WHERE many_collection = 'manufacturing_operations' AND many_field = 'campaign_id';
DELETE FROM directus_relations WHERE many_collection = 'test_sessions' AND many_field = 'campaign_id';
DELETE FROM directus_fields   WHERE collection = 'manufacturing_operations' AND field = 'campaign_id';
DELETE FROM directus_fields   WHERE collection = 'test_sessions' AND field = 'campaign_id';
