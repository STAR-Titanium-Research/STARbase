-- migrate:up
-- The Lab Member rows of campaigns and campaign_samples carry validation NULL where
-- scripts/access_rules.json generates '{}'. 20260930000119 inserted them without a validation, and
-- 20261007000141's UPDATE keeps an existing row's validation when the rule has none. Directus reads
-- NULL and '{}' alike (no validation), so this changes no behaviour; it makes the stored rows equal
-- the generated ones, as configure_users_and_policies.sql would write them.
UPDATE directus_permissions
   SET validation = '{}'
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection IN ('campaigns', 'campaign_samples')
   AND validation IS NULL;

-- migrate:down
UPDATE directus_permissions
   SET validation = NULL
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection IN ('campaigns', 'campaign_samples')
   AND validation::jsonb = '{}'::jsonb;
