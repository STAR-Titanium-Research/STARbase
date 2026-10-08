-- configure_users_and_policies.sql
-- Idempotent. Run via: docker exec -i <postgres-container> psql -U d1 -d d1_database < scripts/configure_users_and_policies.sql
--
-- Creates:
--   • Lab Admin role  + admin_access policy
--   • Lab Member role + CRUD policy for all lab collections
--   • 15 Directus users from the XLSX Users sheet + one external co-owner
--   • sample_co_owners junction rows wired from legacy co_owners TEXT
--     (email resolution is handled in migrate_legacy.py — this file just sets up auth)
--
-- IMPORTANT: Run AFTER dbmate migrations (including 20260622000029_sample_co_owners).
--            Run BEFORE migrate_legacy.py so role UUIDs exist when Python assigns them.
--
-- Role / Policy UUIDs are hard-coded for idempotency across re-runs.
-- User UUIDs are computed via uuid_generate_v5 with the same namespace that
-- migrate_legacy.py uses, so owner FK resolution in Python produces matching IDs.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Shared namespace (mirrors Python: uuid.uuid5(NAMESPACE_DNS, "d1-database.legacy-migration.v1"))
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    PERFORM uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'probe');
EXCEPTION WHEN undefined_function THEN
    RAISE EXCEPTION 'uuid-ossp extension not installed. Run: CREATE EXTENSION IF NOT EXISTS "uuid-ossp";';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Roles
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO directus_roles (id, name, icon, description) VALUES
('10000001-0000-0000-0000-000000000001', 'Lab Admin',   'admin_panel_settings', 'Full platform access — manages users, roles, and all lab data'),
('10000001-0000-0000-0000-000000000002', 'Lab Member',  'science',              'Read and contribute lab data; manage own samples')
ON CONFLICT (id) DO UPDATE SET
    name        = EXCLUDED.name,
    description = EXCLUDED.description;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Policies
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO directus_policies (id, name, icon, description, admin_access, app_access) VALUES
('20000002-0000-0000-0000-000000000001', 'Lab Admin',   'shield', 'Full administrative access',                          TRUE,  TRUE),
('20000002-0000-0000-0000-000000000002', 'Lab Member',  'badge',  'App access + full CRUD on all lab data collections',  FALSE, TRUE)
ON CONFLICT (id) DO UPDATE SET
    name         = EXCLUDED.name,
    admin_access = EXCLUDED.admin_access,
    app_access   = EXCLUDED.app_access;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Bind policies → roles
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO directus_access (id, role, policy, sort) VALUES
('30000003-0000-0000-0000-000000000001', '10000001-0000-0000-0000-000000000001', '20000002-0000-0000-0000-000000000001', 1),
('30000003-0000-0000-0000-000000000002', '10000001-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000002', 1)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Lab Member permissions (ADR-0011: row-level visibility)
--    (admin_access=TRUE policy needs no rows; admin gets everything)
--    This script deletes and re-inserts every Lab Member row, so the rows below carry the same
--    row filters as the migration that applied them (20261007000141_lab_member_row_visibility).
--    They are generated from scripts/access_rules.json, the single source of the rules: change
--    that file, run `python3 scripts/gen_access_rules.py --write` and add a migration with the
--    new rows (`--values`). Reference data and every grant a later migration added are in the
--    file's "unfiltered" list, so a re-run of this script does not lose them.
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000002';

-- BEGIN GENERATED: Lab Member permissions (scripts/gen_access_rules.py --write; do not edit by hand)
INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy) VALUES
('physical_samples', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('physical_samples', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('physical_samples', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('physical_samples', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaigns', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaigns', 'read', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"samples":{"_some":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"samples":{"_some":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaigns', 'update', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaigns', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('projects', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('projects', 'read', '{"_or":[{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}},{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaigns":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"samples":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"samples":{"_some":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operations":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sessions":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('projects', 'update', '{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('projects', 'delete', '{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners', 'read', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance', 'read', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_data_files', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_data_files', 'read', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_data_files', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_data_files', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy', 'read', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"child_sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"child_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"child_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"parent_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"parent_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"parent_sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"parent_sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"parent_sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"parent_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"parent_sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy', 'update', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy', 'delete', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaign_samples', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaign_samples', 'read', '{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"campaign_id":{"samples":{"_some":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"campaign_id":{"samples":{"_some":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaign_samples', 'update', '{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('campaign_samples', 'delete', '{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('operation_data_files', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('operation_data_files', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('operation_data_files', 'update', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('operation_data_files', 'delete', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('machining_force_analysis', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('machining_force_analysis', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('machining_force_analysis', 'update', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('fast_run_data', 'read', '{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"operation_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"operation_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('session_data_files', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('session_data_files', 'read', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"session_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"session_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"session_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"session_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('session_data_files', 'update', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('session_data_files', 'delete', '{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject', 'read', '{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"test_sessions_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}},{"test_sessions_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}},{"test_sessions_id":{"sample_id":{"campaigns":{"_some":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}}}},{"test_sessions_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"campaign_id":{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"campaign_id":{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject', 'update', '{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject', 'delete', '{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('project_investigators', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('project_investigators', 'read', '{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"project_id":{"campaigns":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"project_id":{"samples":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"project_id":{"samples":{"_some":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}},{"project_id":{"operations":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"project_id":{"sessions":{"_some":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('project_investigators', 'update', '{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('project_investigators', 'delete', '{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('project_rollup', 'read', '{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"project_id":{"secondary_investigators":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('people', 'create', '{}', '{"_or":[{"user_id":{"_null":true}},{"user_id":{"_eq":"$CURRENT_USER"}}]}', '*', '20000002-0000-0000-0000-000000000002'),
('people', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('people', 'update', '{}', '{}', 'full_name,email,is_operator,is_researcher,active,notes', '20000002-0000-0000-0000-000000000002'),
('machining_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('machining_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('machining_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('machining_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('am_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('am_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('am_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('am_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('materials', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('materials', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('materials', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('materials', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('equipment', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('equipment', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('equipment', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('equipment', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tools', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tools', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tools', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tools', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods', 'update', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods', 'delete', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('facilities', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('fast_recipes', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('force_crawler_state', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('directus_files', 'create', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002'),
('directus_files', 'read', '{}', '{}', '*', '20000002-0000-0000-0000-000000000002');
-- END GENERATED: Lab Member permissions

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Users
--    UUIDs computed via uuid_generate_v5 with the same namespace that
--    migrate_legacy.py uses: uuid5(NAMESPACE_DNS, "d1-database.legacy-migration.v1")
--    → then uuid5(that namespace, "d1_user:{email_lowercase}")
--    status = 'invited': user can log in via "Forgot Password" / admin invite link.
--    Passwords are intentionally null — set via Directus UI or email invite.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_ns UUID;
    v_lab_admin  UUID := '10000001-0000-0000-0000-000000000001';
    v_lab_member UUID := '10000001-0000-0000-0000-000000000002';
BEGIN
    v_ns := uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'd1-database.legacy-migration.v1');

    INSERT INTO directus_users (id, first_name, last_name, email, role, status) VALUES
    -- Admins
    (uuid_generate_v5(v_ns, 'd1_user:dpremoli1@sheffield.ac.uk'),           'Dennis',   'Premoli',        'dpremoli1@sheffield.ac.uk',           v_lab_admin,  'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:jtaylor25@sheffield.ac.uk'),            'Joshua',   'Taylor',         'jtaylor25@sheffield.ac.uk',            v_lab_admin,  'invited'),
    -- Members
    (uuid_generate_v5(v_ns, 'd1_user:t.m.childerhouse@sheffield.ac.uk'),    'Thomas',   'Childerhouse',   't.m.childerhouse@sheffield.ac.uk',     v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:hrboyle1@sheffield.ac.uk'),            'Henry',    'Boyle',          'hrboyle1@sheffield.ac.uk',             v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:ddfrith1@sheffield.ac.uk'),            'Dillon',   'Frith',          'ddfrith1@sheffield.ac.uk',             v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:jsmcgowan1@sheffield.ac.uk'),          'Jozef',    'McGowan',        'jsmcgowan1@sheffield.ac.uk',           v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:o.levano@sheffield.ac.uk'),            'Oliver',   'Levano Blanch',  'o.levano@sheffield.ac.uk',             v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:unknown@sheffield.ac.uk'),             'Unknown',  'Unknown',        'unknown@sheffield.ac.uk',              v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:jrhopkinson1@sheffield.ac.uk'),        'Joe',      'Hopkinson',      'jrhopkinson1@sheffield.ac.uk',         v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:cbarrie1@sheffield.ac.uk'),            'Cameron',  'Barrie',         'cbarrie1@sheffield.ac.uk',             v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:n.weston@sheffield.ac.uk'),            'Nick',     'Weston',         'n.weston@sheffield.ac.uk',             v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:ldeaney1@sheffield.ac.uk'),            'Lewis',    'Deaney',         'LDeaney1@sheffield.ac.uk',             v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:jack.batty@sheffield.ac.uk'),          'Jack',     'Batty',          'jack.batty@sheffield.ac.uk',           v_lab_member, 'invited'),
    (uuid_generate_v5(v_ns, 'd1_user:sjackson13@sheffield.ac.uk'),          'Sam J',    'Jackson',        'sjackson13@sheffield.ac.uk',           v_lab_member, 'invited'),
    -- External collaborator found in legacy co_owners data
    (uuid_generate_v5(v_ns, 'd1_user:carolina.guerra@nottingham.ac.uk'),    'Carolina', 'Guerra',         'carolina.Guerra@nottingham.ac.uk',     v_lab_member, 'invited')
    ON CONFLICT (email) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        role       = CASE
                       WHEN directus_users.email = 'admin@example.com' THEN directus_users.role
                       ELSE EXCLUDED.role
                     END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Summary
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
    u.first_name || ' ' || u.last_name AS name,
    u.email,
    r.name AS role,
    u.status
FROM directus_users u
LEFT JOIN directus_roles r ON r.id = u.role
ORDER BY r.name, u.last_name, u.first_name;

COMMIT;
