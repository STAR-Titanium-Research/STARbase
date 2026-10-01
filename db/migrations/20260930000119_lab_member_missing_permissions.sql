-- migrate:up
-- The Lab Member policy (non-admin) has full CRUD on every other lab-data
-- collection but had no permission rows at all for these four, so any read
-- touching them was FORBIDDEN:
--   - campaigns / campaign_samples: campaigns could not be opened at all.
--   - manufacturers: M2O target of insert_types.manufacturer_id, so opening an
--     insert type with a manufacturer set failed resolving the relation.
--   - directus_files: every file/file-image field in the app (e.g.
--     insert_types.image) failed for non-admin users.
-- Grants copy the existing full-CRUD, all-fields pattern of this policy.

INSERT INTO directus_permissions (collection, action, fields, policy)
SELECT v.collection, v.action, '*', '20000002-0000-0000-0000-000000000002'
FROM (VALUES
    ('campaigns', 'create'), ('campaigns', 'read'), ('campaigns', 'update'), ('campaigns', 'delete'),
    ('campaign_samples', 'create'), ('campaign_samples', 'read'), ('campaign_samples', 'update'), ('campaign_samples', 'delete'),
    ('manufacturers', 'create'), ('manufacturers', 'read'), ('manufacturers', 'update'), ('manufacturers', 'delete'),
    ('directus_files', 'create'), ('directus_files', 'read'), ('directus_files', 'update'), ('directus_files', 'delete')
) v(collection, action)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002'
      AND p.collection = v.collection AND p.action = v.action
);

-- migrate:down
DELETE FROM directus_permissions
WHERE policy = '20000002-0000-0000-0000-000000000002'
  AND collection IN ('campaigns', 'campaign_samples', 'manufacturers', 'directus_files');
