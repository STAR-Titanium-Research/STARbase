-- migrate:up
-- Label printing in the Explorer (docs/superpowers/specs/2026-10-12-label-printing-design.md,
-- decisions 5 and 6): label layouts become rows in a `label_templates` collection instead of
-- being hard-coded in the page. One row holds the page geometry (a sheet, or a continuous roll
-- whose page is one label), the label grid, an arrangement, the ordered text fields and the extra
-- fields that go into the QR payload (an empty list means all of them: material, nickname, date,
-- owner_initials, owner_email, contact_email; the sample code and short id are always there).
--
-- It also adds the singleton `label_settings`, the lab's contact email that every label's QR carries
-- (everyone reads it, only admins write it) so that whoever finds a sample can reach someone.
--
-- Permissions (decision 6): every Lab Member reads and creates; update and delete only where
-- user_created is the signed-in user (create and update cannot touch is_default or the system columns); admins (admin_access policy) can do everything. The Lab Member
-- rows are the ones scripts/access_rules.json generates for `label_templates` (custom rows).
-- Directus caches permissions: flush Redis and restart Directus after applying.

CREATE TABLE label_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT,
    media           TEXT NOT NULL,
    page_width_mm   NUMERIC NOT NULL,
    page_height_mm  NUMERIC NOT NULL,
    columns         INTEGER NOT NULL DEFAULT 1,
    rows            INTEGER NOT NULL DEFAULT 1,
    label_width_mm  NUMERIC NOT NULL,
    label_height_mm NUMERIC NOT NULL,
    margin_top_mm   NUMERIC NOT NULL DEFAULT 0,
    margin_left_mm  NUMERIC NOT NULL DEFAULT 0,
    gap_x_mm        NUMERIC NOT NULL DEFAULT 0,
    gap_y_mm        NUMERIC NOT NULL DEFAULT 0,
    padding_mm      NUMERIC NOT NULL DEFAULT 2,
    arrangement     TEXT NOT NULL,
    qr_size_mm      NUMERIC,
    fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
    qr_fields       JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    user_created    UUID REFERENCES directus_users (id) ON DELETE SET NULL,
    date_created    TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_updated    UUID REFERENCES directus_users (id) ON DELETE SET NULL,
    date_updated    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT label_templates_name_key UNIQUE (name),
    CONSTRAINT label_templates_media_check CHECK (media IN ('sheet', 'roll')),
    CONSTRAINT label_templates_arrangement_check CHECK (arrangement IN ('qr_top', 'qr_left', 'text_only')),
    CONSTRAINT label_templates_page_size_check CHECK (page_width_mm > 0 AND page_height_mm > 0),
    CONSTRAINT label_templates_grid_check CHECK (columns >= 1 AND rows >= 1),
    CONSTRAINT label_templates_roll_grid_check CHECK (media <> 'roll' OR (columns = 1 AND rows = 1)),
    CONSTRAINT label_templates_label_size_check CHECK (label_width_mm > 0 AND label_height_mm > 0),
    CONSTRAINT label_templates_offsets_check CHECK (
        margin_top_mm >= 0 AND margin_left_mm >= 0 AND gap_x_mm >= 0 AND gap_y_mm >= 0 AND padding_mm >= 0
    ),
    CONSTRAINT label_templates_qr_size_check CHECK (qr_size_mm IS NULL OR qr_size_mm > 0),
    CONSTRAINT label_templates_fields_check CHECK (
        jsonb_typeof(fields) = 'array' AND jsonb_typeof(qr_fields) = 'array'
    )
);

-- At most one default template.
CREATE UNIQUE INDEX idx_label_templates_default ON label_templates (is_default) WHERE is_default;
CREATE INDEX idx_label_templates_user_created ON label_templates (user_created);

COMMENT ON TABLE label_templates IS 'Printable label layouts (sheet or roll) used by the Explorer labels page: page geometry, label grid, arrangement, text fields and QR payload fields.';
COMMENT ON COLUMN label_templates.id IS 'Primary key.';
COMMENT ON COLUMN label_templates.name IS 'Unique display name of the template, e.g. L7160 21-up.';
COMMENT ON COLUMN label_templates.description IS 'Free-text note on the stock or printer the template is for.';
COMMENT ON COLUMN label_templates.media IS 'sheet (a grid of labels on a page) or roll (continuous roll; the page is one label, always 1 x 1).';
COMMENT ON COLUMN label_templates.page_width_mm IS 'Page width in mm (for a roll, the roll width).';
COMMENT ON COLUMN label_templates.page_height_mm IS 'Page height in mm (for a roll, the label length).';
COMMENT ON COLUMN label_templates.columns IS 'Number of label columns on the page (at least 1).';
COMMENT ON COLUMN label_templates.rows IS 'Number of label rows on the page (at least 1).';
COMMENT ON COLUMN label_templates.label_width_mm IS 'Width of one label in mm.';
COMMENT ON COLUMN label_templates.label_height_mm IS 'Height of one label in mm.';
COMMENT ON COLUMN label_templates.margin_top_mm IS 'Space above the first label row in mm.';
COMMENT ON COLUMN label_templates.margin_left_mm IS 'Space left of the first label column in mm.';
COMMENT ON COLUMN label_templates.gap_x_mm IS 'Horizontal gap between label columns in mm.';
COMMENT ON COLUMN label_templates.gap_y_mm IS 'Vertical gap between label rows in mm.';
COMMENT ON COLUMN label_templates.padding_mm IS 'Inner padding of each label in mm.';
COMMENT ON COLUMN label_templates.arrangement IS 'Label layout: qr_top (QR above centred text), qr_left (QR left, text right) or text_only.';
COMMENT ON COLUMN label_templates.qr_size_mm IS 'QR code edge in mm; NULL means the largest square that fits.';
COMMENT ON COLUMN label_templates.fields IS 'Ordered JSON array of printed text lines: [{"key": FieldKey, "size": "lg"|"md"|"sm", "bold": bool}]; FieldKey is sample_code, short_id, nickname, material, date or owner_initials.';
COMMENT ON COLUMN label_templates.qr_fields IS 'JSON array of the extras written into the QR payload besides the sample code and short id: material, nickname, date, owner_initials, owner_email, contact_email. Empty means all of them.';
COMMENT ON COLUMN label_templates.is_default IS 'True for the template the labels page selects first; at most one row is true.';
COMMENT ON COLUMN label_templates.user_created IS 'Directus user who created the template; only they (and admins) can update or delete it.';
COMMENT ON COLUMN label_templates.date_created IS 'When the template was created (set by Directus).';
COMMENT ON COLUMN label_templates.user_updated IS 'Directus user who last updated the template (set by Directus).';
COMMENT ON COLUMN label_templates.date_updated IS 'When the template was last updated (set by Directus).';
COMMENT ON COLUMN label_templates.updated_at IS 'Last update time, maintained by the occ_label_templates trigger.';
COMMENT ON COLUMN label_templates.version IS 'Optimistic-concurrency counter, incremented by the occ_label_templates trigger.';

-- Making a template the default clears the old default in the same statement, so the swap is one write
-- (the partial unique index above is checked row by row, and the UI would otherwise need two requests that
-- can leave no default, or fail halfway). Rows it clears fire the OCC and audit triggers like any update.
-- Limit: ONE row at a time. A single statement that makes two rows the default fails on the unique index (each
-- row's trigger clears the other's flag only after it has run). The labels page writes one row per request, and
-- is_default is read-only in the Data Studio form so a batch edit cannot send a multi-row UPDATE of it.
CREATE FUNCTION label_templates_single_default() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.is_default THEN
        UPDATE label_templates SET is_default = FALSE WHERE is_default AND id <> NEW.id;
    END IF;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION label_templates_single_default() IS 'BEFORE INSERT OR UPDATE OF is_default on label_templates: the row becoming the default clears the previous default.';

CREATE TRIGGER label_templates_single_default
    BEFORE INSERT OR UPDATE OF is_default ON label_templates
    FOR EACH ROW EXECUTE FUNCTION label_templates_single_default();
CREATE TRIGGER occ_label_templates
    BEFORE UPDATE ON label_templates
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();
CREATE TRIGGER audit_label_templates
    AFTER INSERT OR UPDATE OR DELETE ON label_templates
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- Seeds (owned by nobody: only admins can edit them).
INSERT INTO label_templates (
    name, description, media, page_width_mm, page_height_mm, columns, rows, label_width_mm, label_height_mm,
    margin_top_mm, margin_left_mm, gap_x_mm, gap_y_mm, arrangement, fields, qr_fields, is_default
) VALUES
(
    'A4 4×5', 'A4 sheet, 4 columns by 5 rows, edge to edge', 'sheet', 210, 297, 4, 5, 52.5, 59.4,
    0, 0, 0, 0, 'qr_top',
    '[{"key": "sample_code", "size": "lg", "bold": true}, {"key": "nickname", "size": "sm", "bold": false}]', '["material", "nickname", "date", "owner_initials", "owner_email", "contact_email"]', true
),
(
    'L7160 21-up', 'Avery L7160 address labels, A4, 3 by 7', 'sheet', 210, 297, 3, 7, 63.5, 38.1,
    15.15, 7.25, 2.54, 0, 'qr_left',
    '[{"key": "sample_code", "size": "md", "bold": true}, {"key": "nickname", "size": "sm", "bold": false}]', '["material", "nickname", "date", "owner_initials", "owner_email", "contact_email"]', false
),
(
    '50×25 single', 'Single 50 x 25 mm label on a roll', 'roll', 50, 25, 1, 1, 50, 25,
    0, 0, 0, 0, 'qr_left',
    '[{"key": "sample_code", "size": "md", "bold": true}, {"key": "nickname", "size": "sm", "bold": false}]', '["material", "nickname", "date", "owner_initials", "owner_email", "contact_email"]', false
),
(
    'Brother DK-22205 62 mm', 'Brother QL continuous roll, 62 mm wide, 30 mm label', 'roll', 62, 30, 1, 1, 62, 30,
    0, 0, 0, 0, 'qr_left',
    '[{"key": "sample_code", "size": "lg", "bold": true}, {"key": "short_id", "size": "md", "bold": false}, {"key": "nickname", "size": "sm", "bold": false}]',
    '["material", "nickname", "date", "owner_initials", "owner_email", "contact_email"]', false
);

-- The lab contact printed into every label's QR code (a "Contact: <email>" line): a singleton, so there is one
-- row, id 1, and the CHECK stops a second. It starts empty (the QR then has no contact line) until an admin sets it
-- on the labels page. Everyone reads it, only admins write it (the Lab Member policy gets read only).
CREATE TABLE label_settings (
    id            INTEGER PRIMARY KEY DEFAULT 1,
    contact_email TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    version       INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT label_settings_singleton_check CHECK (id = 1),
    CONSTRAINT label_settings_contact_email_check CHECK (
        contact_email IS NULL OR contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+.[^@[:space:]]+$'
    )
);

COMMENT ON TABLE label_settings IS 'Singleton (one row, id 1): settings shared by every printed label. Today the lab contact email that the QR code carries.';
COMMENT ON COLUMN label_settings.id IS 'Always 1: the table holds one row.';
COMMENT ON COLUMN label_settings.contact_email IS 'Lab contact email written into every label QR code as "Contact: <email>"; NULL leaves the line out. Must look like an email address.';
COMMENT ON COLUMN label_settings.created_at IS 'When the row was created.';
COMMENT ON COLUMN label_settings.updated_at IS 'Last update time, maintained by the occ_label_settings trigger.';
COMMENT ON COLUMN label_settings.version IS 'Optimistic-concurrency counter, incremented by the occ_label_settings trigger.';

CREATE TRIGGER occ_label_settings
    BEFORE UPDATE ON label_settings
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();
CREATE TRIGGER audit_label_settings
    AFTER INSERT OR UPDATE OR DELETE ON label_settings
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

INSERT INTO label_settings (id, contact_email) VALUES (1, NULL);

-- Directus metadata for label_settings.
INSERT INTO directus_collections (collection, icon, note, hidden, singleton, sort)
VALUES ('label_settings', 'contact_mail', 'Lab contact email printed into every label QR code (admins edit it on the Print labels page)', true, true, 93)
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, translations)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.readonly, v.hidden, v.sort, v.width, v.translations::json
FROM (VALUES
    ('label_settings', 'id', NULL, 'input', NULL, NULL, true, true, 1, 'full', NULL),
    ('label_settings', 'contact_email', NULL, 'input', '{"placeholder":"lab@example.org"}', NULL, false, false, 2, 'full',
        '[{"language":"en-US","translation":"Contact email on labels"}]'),
    ('label_settings', 'created_at', NULL, 'datetime', NULL, 'datetime', true, true, 3, 'half', NULL),
    ('label_settings', 'updated_at', NULL, 'datetime', NULL, 'datetime', true, true, 4, 'half', NULL),
    ('label_settings', 'version', NULL, 'input', NULL, NULL, true, true, 5, 'half', NULL)
) v(collection, field, special, interface, options, display, readonly, hidden, sort, width, translations)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- Directus metadata for label_templates.
INSERT INTO directus_collections (collection, icon, note, hidden, sort)
VALUES ('label_templates', 'label', 'Printable label layouts for the Explorer labels page', false, 92)
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (
    collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations
)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json,
       v.readonly, v.hidden, v.sort, v.width, v.translations::json
FROM (VALUES
    ('label_templates', 'id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', NULL),
    ('label_templates', 'name', NULL, 'input', NULL, NULL, NULL, false, false, 2, 'half', NULL),
    ('label_templates', 'is_default', 'cast-boolean', 'boolean', NULL, NULL, NULL, true, false, 3, 'half',
        '[{"language":"en-US","translation":"Default template"}]'),
    ('label_templates', 'description', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 4, 'full', NULL),
    ('label_templates', 'media', NULL, 'select-dropdown',
        '{"choices":[{"text":"Sheet","value":"sheet"},{"text":"Roll","value":"roll"}]}', 'labels', NULL,
        false, false, 5, 'half', NULL),
    ('label_templates', 'arrangement', NULL, 'select-dropdown',
        '{"choices":[{"text":"QR on top","value":"qr_top"},{"text":"QR on the left","value":"qr_left"},{"text":"Text only","value":"text_only"}]}',
        'labels', NULL, false, false, 6, 'half', NULL),
    ('label_templates', 'page_width_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 7, 'half',
        '[{"language":"en-US","translation":"Page width (mm)"}]'),
    ('label_templates', 'page_height_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 8, 'half',
        '[{"language":"en-US","translation":"Page height (mm)"}]'),
    ('label_templates', 'columns', NULL, 'input', '{"min":1,"step":1}', NULL, NULL, false, false, 9, 'half', NULL),
    ('label_templates', 'rows', NULL, 'input', '{"min":1,"step":1}', NULL, NULL, false, false, 10, 'half', NULL),
    ('label_templates', 'label_width_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 11, 'half',
        '[{"language":"en-US","translation":"Label width (mm)"}]'),
    ('label_templates', 'label_height_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 12, 'half',
        '[{"language":"en-US","translation":"Label height (mm)"}]'),
    ('label_templates', 'margin_top_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 13, 'half',
        '[{"language":"en-US","translation":"Top margin (mm)"}]'),
    ('label_templates', 'margin_left_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 14, 'half',
        '[{"language":"en-US","translation":"Left margin (mm)"}]'),
    ('label_templates', 'gap_x_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 15, 'half',
        '[{"language":"en-US","translation":"Column gap (mm)"}]'),
    ('label_templates', 'gap_y_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 16, 'half',
        '[{"language":"en-US","translation":"Row gap (mm)"}]'),
    ('label_templates', 'padding_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 17, 'half',
        '[{"language":"en-US","translation":"Padding (mm)"}]'),
    ('label_templates', 'qr_size_mm', NULL, 'input', '{"min":0,"step":0.01,"suffix":"mm"}', NULL, NULL, false, false, 18, 'half',
        '[{"language":"en-US","translation":"QR size (mm, empty = largest that fits)"}]'),
    ('label_templates', 'fields', 'cast-json', 'input-code', '{"language":"json"}', NULL, NULL, false, false, 19, 'full',
        '[{"language":"en-US","translation":"Printed fields"}]'),
    ('label_templates', 'qr_fields', 'cast-json', 'input-code', '{"language":"json"}', NULL, NULL, false, false, 20, 'full',
        '[{"language":"en-US","translation":"QR payload extras (empty = all)"}]'),
    ('label_templates', 'user_created', 'user-created', 'select-dropdown-m2o', '{"template":"{{first_name}} {{last_name}}"}',
        'user', NULL, true, true, 21, 'half', NULL),
    ('label_templates', 'date_created', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 22, 'half', NULL),
    ('label_templates', 'user_updated', 'user-updated', 'select-dropdown-m2o', '{"template":"{{first_name}} {{last_name}}"}',
        'user', NULL, true, true, 23, 'half', NULL),
    ('label_templates', 'date_updated', 'date-updated', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 24, 'half', NULL),
    ('label_templates', 'updated_at', NULL, 'datetime', NULL, NULL, NULL, true, true, 25, 'half', NULL),
    ('label_templates', 'version', NULL, 'input', NULL, NULL, NULL, true, true, 26, 'half', NULL)
) v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field)
SELECT * FROM (VALUES
    ('label_templates', 'user_created', 'directus_users', NULL),
    ('label_templates', 'user_updated', 'directus_users', NULL)
) v(many_collection, many_field, one_collection, one_field)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- Lab Member permissions: the rows scripts/access_rules.json generates for label_templates
-- (`python3 scripts/gen_access_rules.py --values`). Read is open. Create and update are limited to the
-- content columns, so is_default, id and the system columns (user_created, user_updated,
-- date_created, date_updated, updated_at, version) are admin-only. Update and delete only where
-- user_created is the signed-in user.
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT 'label_templates', v.action, v.permissions::json, '{}'::json, NULL, v.fields, '20000002-0000-0000-0000-000000000002'
FROM (VALUES
    ('create', '{}', 'name,description,media,page_width_mm,page_height_mm,columns,rows,label_width_mm,label_height_mm,margin_top_mm,margin_left_mm,gap_x_mm,gap_y_mm,padding_mm,arrangement,qr_size_mm,fields,qr_fields'),
    ('read', '{}', '*'),
    ('update', '{"user_created":{"_eq":"$CURRENT_USER"}}', 'name,description,media,page_width_mm,page_height_mm,columns,rows,label_width_mm,label_height_mm,margin_top_mm,margin_left_mm,gap_x_mm,gap_y_mm,padding_mm,arrangement,qr_size_mm,fields,qr_fields'),
    ('delete', '{"user_created":{"_eq":"$CURRENT_USER"}}', '*')
) v(action, permissions, fields)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002'
      AND p.collection = 'label_templates' AND p.action = v.action
);

-- label_settings: Lab Members read only (the generated 'unfiltered' row of scripts/access_rules.json); admins
-- write through the admin_access policy.
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT 'label_settings', 'read', '{}'::json, '{}'::json, NULL, '*', '20000002-0000-0000-0000-000000000002'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = 'label_settings' AND p.action = 'read'
);

-- migrate:down
DELETE FROM directus_permissions WHERE collection IN ('label_templates', 'label_settings');
DELETE FROM directus_relations WHERE many_collection = 'label_templates';
DELETE FROM directus_fields WHERE collection IN ('label_templates', 'label_settings');
DELETE FROM directus_collections WHERE collection IN ('label_templates', 'label_settings');
DROP TRIGGER IF EXISTS audit_label_settings ON label_settings;
DROP TRIGGER IF EXISTS occ_label_settings ON label_settings;
DROP TABLE IF EXISTS label_settings;
DROP TRIGGER IF EXISTS audit_label_templates ON label_templates;
DROP TRIGGER IF EXISTS occ_label_templates ON label_templates;
DROP TRIGGER IF EXISTS label_templates_single_default ON label_templates;
DROP TABLE IF EXISTS label_templates;
DROP FUNCTION IF EXISTS label_templates_single_default();
