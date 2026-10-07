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
-- 4. Lab Member permissions — CRUD on all lab collections
--    (admin_access=TRUE policy needs no rows; admin gets everything)
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000002';

INSERT INTO directus_permissions (collection, action, fields, policy) VALUES
-- ── primary data ─────────────────────────────────────────────────────────────
('physical_samples',         'create', '*', '20000002-0000-0000-0000-000000000002'),
('physical_samples',         'read',   '*', '20000002-0000-0000-0000-000000000002'),
('physical_samples',         'update', '*', '20000002-0000-0000-0000-000000000002'),
('physical_samples',         'delete', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners',         'create', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners',         'read',   '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners',         'update', '*', '20000002-0000-0000-0000-000000000002'),
('sample_co_owners',         'delete', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'create', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'read',   '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'update', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_operations', 'delete', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions',            'create', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions',            'read',   '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions',            'update', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions',            'delete', '*', '20000002-0000-0000-0000-000000000002'),
-- ── process param tables ──────────────────────────────────────────────────────
('machining_params',         'create', '*', '20000002-0000-0000-0000-000000000002'),
('machining_params',         'read',   '*', '20000002-0000-0000-0000-000000000002'),
('machining_params',         'update', '*', '20000002-0000-0000-0000-000000000002'),
('machining_params',         'delete', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params',         'create', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params',         'read',   '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params',         'update', '*', '20000002-0000-0000-0000-000000000002'),
('sintering_params',         'delete', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params',    'create', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params',    'read',   '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params',    'update', '*', '20000002-0000-0000-0000-000000000002'),
('heat_treatment_params',    'delete', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params',       'create', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params',       'read',   '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params',       'update', '*', '20000002-0000-0000-0000-000000000002'),
('deformation_params',       'delete', '*', '20000002-0000-0000-0000-000000000002'),
('am_params',                'create', '*', '20000002-0000-0000-0000-000000000002'),
('am_params',                'read',   '*', '20000002-0000-0000-0000-000000000002'),
('am_params',                'update', '*', '20000002-0000-0000-0000-000000000002'),
('am_params',                'delete', '*', '20000002-0000-0000-0000-000000000002'),
-- ── test param tables ─────────────────────────────────────────────────────────
('tensile_test_params',      'create', '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params',      'read',   '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params',      'update', '*', '20000002-0000-0000-0000-000000000002'),
('tensile_test_params',      'delete', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params',     'create', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params',     'read',   '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params',     'update', '*', '20000002-0000-0000-0000-000000000002'),
('hardness_test_params',     'delete', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params',       'create', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params',       'read',   '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params',       'update', '*', '20000002-0000-0000-0000-000000000002'),
('charpy_test_params',       'delete', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params',  'create', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params',  'read',   '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params',  'update', '*', '20000002-0000-0000-0000-000000000002'),
('compression_test_params',  'delete', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params',               'create', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params',               'read',   '*', '20000002-0000-0000-0000-000000000002'),
('sem_params',               'update', '*', '20000002-0000-0000-0000-000000000002'),
('sem_params',               'delete', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params',               'create', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params',               'read',   '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params',               'update', '*', '20000002-0000-0000-0000-000000000002'),
('xrd_params',               'delete', '*', '20000002-0000-0000-0000-000000000002'),
-- ── reference / config tables ─────────────────────────────────────────────────
('projects',                          'create', '*', '20000002-0000-0000-0000-000000000002'),
('projects',                          'read',   '*', '20000002-0000-0000-0000-000000000002'),
('projects',                          'update', '*', '20000002-0000-0000-0000-000000000002'),
('projects',                          'delete', '*', '20000002-0000-0000-0000-000000000002'),
('materials',                         'create', '*', '20000002-0000-0000-0000-000000000002'),
('materials',                         'read',   '*', '20000002-0000-0000-0000-000000000002'),
('materials',                         'update', '*', '20000002-0000-0000-0000-000000000002'),
('materials',                         'delete', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications',      'create', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications',      'read',   '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications',      'update', '*', '20000002-0000-0000-0000-000000000002'),
('material_iso_classifications',      'delete', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements',                 'create', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements',                 'read',   '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements',                 'update', '*', '20000002-0000-0000-0000-000000000002'),
('alloying_elements',                 'delete', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements',        'create', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements',        'read',   '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements',        'update', '*', '20000002-0000-0000-0000-000000000002'),
('material_alloying_elements',        'delete', '*', '20000002-0000-0000-0000-000000000002'),
('equipment',                         'create', '*', '20000002-0000-0000-0000-000000000002'),
('equipment',                         'read',   '*', '20000002-0000-0000-0000-000000000002'),
('equipment',                         'update', '*', '20000002-0000-0000-0000-000000000002'),
('equipment',                         'delete', '*', '20000002-0000-0000-0000-000000000002'),
('tools',                             'create', '*', '20000002-0000-0000-0000-000000000002'),
('tools',                             'read',   '*', '20000002-0000-0000-0000-000000000002'),
('tools',                             'update', '*', '20000002-0000-0000-0000-000000000002'),
('tools',                             'delete', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes',                        'create', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes',                        'read',   '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes',                        'update', '*', '20000002-0000-0000-0000-000000000002'),
('tool_boxes',                        'delete', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts',                   'create', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts',                   'read',   '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts',                   'update', '*', '20000002-0000-0000-0000-000000000002'),
('cutting_inserts',                   'delete', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges',                      'create', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges',                      'read',   '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges',                      'update', '*', '20000002-0000-0000-0000-000000000002'),
('insert_edges',                      'delete', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types',                      'create', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types',                      'read',   '*', '20000002-0000-0000-0000-000000000002'),
('insert_types',                      'update', '*', '20000002-0000-0000-0000-000000000002'),
('insert_types',                      'delete', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots',                    'create', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots',                    'read',   '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots',                    'update', '*', '20000002-0000-0000-0000-000000000002'),
('raw_stock_lots',                    'delete', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods',             'create', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods',             'read',   '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods',             'update', '*', '20000002-0000-0000-0000-000000000002'),
('manufacturing_methods',             'delete', '*', '20000002-0000-0000-0000-000000000002'),
-- ── lineage / audit (read-only for Lab Members) ───────────────────────────────
('sample_genealogy',                  'read',   '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy',                  'create', '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy',                  'update', '*', '20000002-0000-0000-0000-000000000002'),
('sample_genealogy',                  'delete', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance',           'read',   '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance',           'create', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance',           'update', '*', '20000002-0000-0000-0000-000000000002'),
('sample_stock_provenance',           'delete', '*', '20000002-0000-0000-0000-000000000002'),
('audit_logs',                        'read',   '*', '20000002-0000-0000-0000-000000000002'),
-- ── grants added by later migrations ─────────────────────────────────────────
-- This script deletes and re-inserts every Lab Member row, so it must repeat each grant that a
-- migration adds to this policy, or applying it after the migrations (scripts/README.md) undoes
-- them. Keep in sync with db/migrations/*_lab_member_*.sql and the *_meta / fast_* migrations:
--   20260703000066 people, test_sessions_subject (CRUD), facilities (read)
--   20260705000075 machining_force_analysis read; 20260705000078 force_crawler_state read
--   20260709000084 fast_run_data read;           20260722000100 fast_recipes read
--   20260911000111 machining_force_analysis update
--   20261005000133 directus_files create + read, machining_force_analysis create (Force App save)
('people',                            'create', '*', '20000002-0000-0000-0000-000000000002'),
('people',                            'read',   '*', '20000002-0000-0000-0000-000000000002'),
('people',                            'update', '*', '20000002-0000-0000-0000-000000000002'),
('people',                            'delete', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject',             'create', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject',             'read',   '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject',             'update', '*', '20000002-0000-0000-0000-000000000002'),
('test_sessions_subject',             'delete', '*', '20000002-0000-0000-0000-000000000002'),
('facilities',                        'read',   '*', '20000002-0000-0000-0000-000000000002'),
('fast_recipes',                      'read',   '*', '20000002-0000-0000-0000-000000000002'),
('fast_run_data',                     'read',   '*', '20000002-0000-0000-0000-000000000002'),
('force_crawler_state',               'read',   '*', '20000002-0000-0000-0000-000000000002'),
('machining_force_analysis',          'create', '*', '20000002-0000-0000-0000-000000000002'),
('machining_force_analysis',          'read',   '*', '20000002-0000-0000-0000-000000000002'),
('machining_force_analysis',          'update', '*', '20000002-0000-0000-0000-000000000002'),
('directus_files',                    'create', '*', '20000002-0000-0000-0000-000000000002'),
('directus_files',                    'read',   '*', '20000002-0000-0000-0000-000000000002');

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
