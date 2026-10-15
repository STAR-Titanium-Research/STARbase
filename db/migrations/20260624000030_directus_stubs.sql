-- migrate:up
-- Stubs for every Directus-managed table that later migrations reference.
-- In production Directus creates these long before our migrations run;
-- in CI (bare Postgres, no Directus runtime) we need the tables to exist.
-- CREATE TABLE IF NOT EXISTS is idempotent: safe in both environments.

-- ── core identity ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_roles (
    id UUID NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(64) DEFAULT 'supervised_user_circle',
    description TEXT,
    parent UUID
);

CREATE TABLE IF NOT EXISTS directus_policies (
    id UUID NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(64) DEFAULT 'badge',
    description TEXT,
    ip_access TEXT,
    enforce_tfa BOOLEAN DEFAULT FALSE NOT NULL,
    admin_access BOOLEAN DEFAULT FALSE NOT NULL,
    app_access BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE IF NOT EXISTS directus_users (
    id UUID NOT NULL PRIMARY KEY,
    first_name VARCHAR(50),
    last_name VARCHAR(50),
    email VARCHAR(128),
    password VARCHAR(255),
    location VARCHAR(255),
    title VARCHAR(50),
    description TEXT,
    tags JSON,
    avatar UUID,
    language VARCHAR(255),
    tfa_secret VARCHAR(255),
    status VARCHAR(16) DEFAULT 'active' NOT NULL,
    role UUID,
    token VARCHAR(255),
    last_access TIMESTAMPTZ,
    last_page VARCHAR(255),
    provider VARCHAR(128) DEFAULT 'default' NOT NULL,
    external_identifier VARCHAR(255),
    auth_data JSON,
    email_notifications BOOLEAN DEFAULT TRUE,
    appearance VARCHAR(255),
    theme_dark VARCHAR(255),
    theme_light VARCHAR(255),
    theme_light_overrides JSON,
    theme_dark_overrides JSON,
    text_direction VARCHAR(255) DEFAULT 'auto' NOT NULL
);

-- filename_download and type: the columns the d1-inbox list query reads (tests/phase1_schema.sh prepares it against this stub). Real Directus has both
-- (and many more) before our migrations run, so on a production database this CREATE does nothing.
CREATE TABLE IF NOT EXISTS directus_files (
    id UUID NOT NULL PRIMARY KEY,
    filename_download TEXT,
    type TEXT
);

-- ── access / permissions ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_access (
    id UUID NOT NULL PRIMARY KEY,
    role UUID,
    "user" UUID,
    policy UUID NOT NULL,
    sort INTEGER
);

CREATE TABLE IF NOT EXISTS directus_permissions (
    id SERIAL PRIMARY KEY,
    collection VARCHAR(64) NOT NULL,
    action VARCHAR(10) NOT NULL,
    permissions JSON,
    validation JSON,
    presets JSON,
    fields TEXT,
    policy UUID NOT NULL
);

-- ── sessions / shares ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_sessions (
    token VARCHAR(64) NOT NULL PRIMARY KEY,
    "user" UUID,
    expires TIMESTAMPTZ NOT NULL,
    ip VARCHAR(255),
    user_agent TEXT,
    share UUID,
    origin VARCHAR(255),
    next_token VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS directus_shares (
    id UUID NOT NULL PRIMARY KEY,
    name VARCHAR(255),
    collection VARCHAR(64) NOT NULL,
    item VARCHAR(255) NOT NULL,
    role UUID,
    password VARCHAR(255),
    user_created UUID,
    date_created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    date_start TIMESTAMPTZ,
    date_end TIMESTAMPTZ,
    times_used INTEGER DEFAULT 0,
    max_uses INTEGER
);

-- ── schema metadata ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_collections (
    collection VARCHAR(64) NOT NULL PRIMARY KEY,
    icon VARCHAR(64),
    note TEXT,
    display_template VARCHAR(255),
    hidden BOOLEAN DEFAULT FALSE NOT NULL,
    singleton BOOLEAN DEFAULT FALSE NOT NULL,
    translations JSON,
    archive_field VARCHAR(64),
    archive_app_filter BOOLEAN DEFAULT TRUE NOT NULL,
    archive_value VARCHAR(255),
    unarchive_value VARCHAR(255),
    sort_field VARCHAR(64),
    accountability VARCHAR(255) DEFAULT 'all',
    color VARCHAR(255),
    item_duplication_fields JSON,
    sort INTEGER,
    "group" VARCHAR(64),
    collapse VARCHAR(255) DEFAULT 'open' NOT NULL,
    preview_url VARCHAR(255),
    versioning BOOLEAN DEFAULT FALSE NOT NULL
);

CREATE TABLE IF NOT EXISTS directus_fields (
    id SERIAL PRIMARY KEY,
    collection VARCHAR(64) NOT NULL,
    field VARCHAR(64) NOT NULL,
    special VARCHAR(64),
    interface VARCHAR(64),
    options JSON,
    display VARCHAR(64),
    display_options JSON,
    readonly BOOLEAN DEFAULT FALSE NOT NULL,
    hidden BOOLEAN DEFAULT FALSE NOT NULL,
    sort INTEGER,
    width VARCHAR(30) DEFAULT 'full',
    translations JSON,
    note TEXT,
    conditions JSON,
    required BOOLEAN DEFAULT FALSE,
    "group" VARCHAR(64),
    validation JSON,
    validation_message TEXT,
    searchable BOOLEAN DEFAULT TRUE NOT NULL
);

CREATE TABLE IF NOT EXISTS directus_relations (
    id SERIAL PRIMARY KEY,
    many_collection VARCHAR(64) NOT NULL,
    many_field VARCHAR(64) NOT NULL,
    one_collection VARCHAR(64),
    one_field VARCHAR(64),
    one_collection_field VARCHAR(64),
    one_allowed_collections TEXT,
    junction_field VARCHAR(64),
    sort_field VARCHAR(64),
    one_deselect_action VARCHAR(255) DEFAULT 'nullify' NOT NULL
);

-- ── presets (bookmarks / default layouts) ──────────────────────────

CREATE TABLE IF NOT EXISTS directus_presets (
    id SERIAL PRIMARY KEY,
    bookmark VARCHAR(255),
    "user" UUID,
    role UUID,
    collection VARCHAR(64),
    search VARCHAR(100),
    layout VARCHAR(100) DEFAULT 'tabular',
    layout_query JSON,
    layout_options JSON,
    refresh_interval INTEGER,
    filter JSON,
    icon VARCHAR(64) DEFAULT 'bookmark',
    color VARCHAR(255)
);

-- ── settings ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_settings (
    id SERIAL PRIMARY KEY,
    project_name VARCHAR(100) DEFAULT 'Directus' NOT NULL,
    project_url VARCHAR(255),
    project_color VARCHAR(255) DEFAULT '#6644FF' NOT NULL,
    project_logo UUID,
    public_foreground UUID,
    public_background UUID,
    public_note TEXT,
    auth_login_attempts INTEGER DEFAULT 25,
    auth_password_policy VARCHAR(100),
    storage_asset_transform VARCHAR(7) DEFAULT 'all',
    storage_asset_presets JSON,
    custom_css TEXT,
    storage_default_folder UUID,
    basemaps JSON,
    mapbox_key VARCHAR(255),
    module_bar JSON,
    project_descriptor VARCHAR(100),
    default_language VARCHAR(255) DEFAULT 'en-US' NOT NULL,
    custom_aspect_ratios JSON,
    public_favicon UUID,
    default_appearance VARCHAR(255) DEFAULT 'auto' NOT NULL,
    default_theme_light VARCHAR(255),
    theme_light_overrides JSON,
    default_theme_dark VARCHAR(255),
    theme_dark_overrides JSON,
    report_error_url VARCHAR(255),
    report_bug_url VARCHAR(255),
    report_feature_url VARCHAR(255),
    public_registration BOOLEAN DEFAULT FALSE NOT NULL,
    public_registration_verify_email BOOLEAN DEFAULT TRUE NOT NULL,
    public_registration_role UUID,
    public_registration_email_filter JSON
);

-- ── flows / automation ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_flows (
    id UUID NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    icon VARCHAR(64),
    color VARCHAR(255),
    description TEXT,
    status VARCHAR(255) DEFAULT 'active' NOT NULL,
    trigger VARCHAR(255),
    accountability VARCHAR(255) DEFAULT 'all',
    options JSON,
    operation UUID,
    date_created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    user_created UUID
);

CREATE TABLE IF NOT EXISTS directus_operations (
    id UUID NOT NULL PRIMARY KEY,
    name VARCHAR(255),
    key VARCHAR(255) NOT NULL,
    type VARCHAR(255) NOT NULL,
    position_x INTEGER NOT NULL,
    position_y INTEGER NOT NULL,
    options JSON,
    resolve UUID,
    reject UUID,
    flow UUID NOT NULL,
    date_created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    user_created UUID
);

-- ── deployments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS directus_deployments (
    id UUID NOT NULL PRIMARY KEY,
    provider VARCHAR(255) NOT NULL,
    credentials TEXT,
    options TEXT,
    date_created TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    user_created UUID,
    webhook_ids JSON,
    webhook_secret VARCHAR(255),
    last_synced_at TIMESTAMPTZ
);

-- ── application-level stubs (Directus admin UI managed) ────────────

CREATE TABLE IF NOT EXISTS "Machine_Operators" (
    id INTEGER NOT NULL PRIMARY KEY,
    "Name" TEXT
);

-- manufacturing_operations.operator is a Directus-managed column
-- (INTEGER FK to Machine_Operators) added via the admin UI. Later
-- migrations (0038, 0061) UPDATE it, so it must exist in CI.
ALTER TABLE manufacturing_operations
    ADD COLUMN IF NOT EXISTS operator INTEGER
        REFERENCES "Machine_Operators"(id) ON DELETE SET NULL;

-- migrate:down
-- WARNING: This down migration drops Directus-managed tables. In production
-- Directus owns these tables and running this rollback would destroy data.
-- This rollback path is exercised only in CI (bare Postgres, no real data).
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS operator;
DROP TABLE IF EXISTS "Machine_Operators";
DROP TABLE IF EXISTS directus_deployments;
DROP TABLE IF EXISTS directus_operations;
DROP TABLE IF EXISTS directus_flows;
DROP TABLE IF EXISTS directus_settings;
DROP TABLE IF EXISTS directus_presets;
DROP TABLE IF EXISTS directus_relations;
DROP TABLE IF EXISTS directus_fields;
DROP TABLE IF EXISTS directus_collections;
DROP TABLE IF EXISTS directus_shares;
DROP TABLE IF EXISTS directus_sessions;
DROP TABLE IF EXISTS directus_permissions;
DROP TABLE IF EXISTS directus_access;
DROP TABLE IF EXISTS directus_files;
DROP TABLE IF EXISTS directus_users;
DROP TABLE IF EXISTS directus_policies;
DROP TABLE IF EXISTS directus_roles;
