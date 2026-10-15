-- migrate:up
-- Surface scans (docs/superpowers/specs/2026-10-15-surface-scans-design.md, docs/adr/0020-surface-scans-on-inserts-and-edges.md):
-- one topography file (Alicona .al3d, or any file SurfaceTopography reads) of one cutting insert or one insert edge,
-- with the condition the item was in, optionally the date and the operation that wore it. It is not a Test.
--
-- `surface_scans` is the row contract shared by three parties: the d1-surface-scan endpoint and the STARbase panel read
-- it, the surface-scan worker fills the render_* / cache_key / source_* / grid_* / pixel_pitch_* / z_* columns, and the
-- crawler of the sibling design may create rows. A scan belongs to exactly ONE insert OR ONE edge
-- (CHECK num_nonnulls(insert_id, edge_id) = 1), and a file can be filed only once per item (the two UNIQUE constraints;
-- NULLs never collide, so the same file may belong to an insert and to an edge of another insert).
--
-- Foreign keys: the insert, the edge and the file CASCADE (a scan without its item or its file means nothing, and
-- deleting a pointer row in directus_files removes only the scan; the derived MinIO objects are keyed by content and stay
-- as cache). The operation and the owner SET NULL.
--
-- Visibility: reference data, like insert_edges (ADR-0011): every Lab Member reads and writes (scripts/access_rules.json
-- "unfiltered"), and every Lab Viewer reads. NOT granted to d1_llm_readonly: since migration 168 (ADR-0014) a table the
-- Ask-DB role can read needs row-level-security policies or a place in migration 168's reference list, and 168's own
-- up section (replayed by phase1) raises for a granted table it does not know. The scan metadata is of no use to
-- text-to-SQL; the allow-list migration 132 grant for insert_edges predates that rule.
-- Directus caches permissions and schema: restart Directus after applying (no Redis cache is configured for it).
--
-- Existing Alicona Tests whose subject is an edge are NOT migrated here (spec decision 9).

-- Fail fast instead of queueing behind a long import: migrate while no import runs; on a lock timeout, re-run.
SET LOCAL lock_timeout = '10s';

CREATE TABLE surface_scans (
    scan_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    insert_id          UUID REFERENCES cutting_inserts (insert_id) ON DELETE CASCADE,
    edge_id            UUID REFERENCES insert_edges (edge_id) ON DELETE CASCADE,
    directus_files_id  UUID NOT NULL REFERENCES directus_files (id) ON DELETE CASCADE,
    condition          TEXT NOT NULL,
    condition_note     TEXT,
    scanned_on         DATE,
    operation_id       UUID REFERENCES manufacturing_operations (operation_id) ON DELETE SET NULL,
    notes              TEXT,
    render_status      TEXT NOT NULL DEFAULT 'pending',
    render_error       TEXT,
    rendered_at        TIMESTAMPTZ,
    cache_key          TEXT,
    source_format      TEXT,
    source_width       INTEGER,
    source_height      INTEGER,
    grid_width         INTEGER,
    grid_height        INTEGER,
    pixel_pitch_x_um   NUMERIC,
    pixel_pitch_y_um   NUMERIC,
    z_min_um           NUMERIC,
    z_max_um           NUMERIC,
    owner              UUID REFERENCES directus_users (id) ON DELETE SET NULL,
    owner_person_id    UUID REFERENCES people (person_id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    version            INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT surface_scans_one_item_check CHECK (num_nonnulls(insert_id, edge_id) = 1),
    CONSTRAINT surface_scans_condition_check CHECK (condition IN ('new', 'worn', 'cleaned', 'other')),
    CONSTRAINT surface_scans_render_status_check CHECK (render_status IN ('pending', 'rendering', 'done', 'failed')),
    CONSTRAINT surface_scans_insert_file_key UNIQUE (insert_id, directus_files_id),
    CONSTRAINT surface_scans_edge_file_key UNIQUE (edge_id, directus_files_id)
);

CREATE INDEX idx_surface_scans_insert_id ON surface_scans (insert_id);
CREATE INDEX idx_surface_scans_edge_id ON surface_scans (edge_id);
CREATE INDEX idx_surface_scans_directus_files_id ON surface_scans (directus_files_id);
-- The worker polls for rows that still need a render: only those are indexed (done and failed are the great majority).
CREATE INDEX idx_surface_scans_render_status ON surface_scans (render_status) WHERE render_status IN ('pending', 'rendering');
-- FK columns that ON DELETE SET NULL scans when an operation or a person is deleted; most rows have neither.
CREATE INDEX idx_surface_scans_operation_id ON surface_scans (operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX idx_surface_scans_owner_person_id ON surface_scans (owner_person_id) WHERE owner_person_id IS NOT NULL;

COMMENT ON TABLE surface_scans IS 'One topography scan (an Alicona .al3d or any file SurfaceTopography reads) of one cutting insert or one insert edge, with the condition the item was in. Not a Test. The file is a pointer row in directus_files on the archive share; the surface-scan worker renders it into a decimated height grid and a thumbnail (MinIO, prefix surface-scans/<cache_key>/) that the d1-surface-scan endpoint serves. Exactly one of insert_id and edge_id is set.';
COMMENT ON COLUMN surface_scans.scan_id IS 'Primary key.';
COMMENT ON COLUMN surface_scans.insert_id IS 'The cutting insert this scan belongs to when it shows the whole insert; NULL when edge_id is set. Exactly one of insert_id and edge_id is set.';
COMMENT ON COLUMN surface_scans.edge_id IS 'The insert edge this scan belongs to when it shows one cutting edge; NULL when insert_id is set. Exactly one of insert_id and edge_id is set.';
COMMENT ON COLUMN surface_scans.directus_files_id IS 'The scan file: a row in directus_files (a pointer to the archive share, storage star, or an upload). The same file can be filed once per insert and once per edge.';
COMMENT ON COLUMN surface_scans.condition IS 'The condition the insert or edge was in when scanned: new, worn, cleaned or other (say which in condition_note).';
COMMENT ON COLUMN surface_scans.condition_note IS 'Free note on the condition, e.g. what other means or how the edge was cleaned.';
COMMENT ON COLUMN surface_scans.scanned_on IS 'The day the item was scanned; NULL when unknown.';
COMMENT ON COLUMN surface_scans.operation_id IS 'The manufacturing operation that wore the edge or insert to this condition; NULL when unknown or not applicable.';
COMMENT ON COLUMN surface_scans.notes IS 'Free-text note on the scan.';
COMMENT ON COLUMN surface_scans.render_status IS 'Where the render stands: pending (new, or Render again was pressed), rendering (the worker has it), done (the grid, meta and thumbnail objects exist and the columns below are filled) or failed (see render_error). Set by the surface-scan worker and by POST /d1-surface-scan/<id>/render; the viewer is served only when it is done.';
COMMENT ON COLUMN surface_scans.render_error IS 'Why the last render failed (an unreadable or unsupported file, a missing file); NULL unless render_status is failed. Cleared when a render is requested again.';
COMMENT ON COLUMN surface_scans.rendered_at IS 'When the last successful render finished; NULL until then.';
COMMENT ON COLUMN surface_scans.cache_key IS 'Names the derived objects under surface-scans/<cache_key>/ in MinIO: the file''s content_sha256 from file_fingerprints when the crawler has hashed it, otherwise the provisional key p-<directus_files_id>-<size>-<mtime>. Set by the worker, which never hashes a file itself. Also the ETag of the served objects.';
COMMENT ON COLUMN surface_scans.source_format IS 'Name of the SurfaceTopography reader that opened the file (for example al3d); NULL until rendered.';
COMMENT ON COLUMN surface_scans.source_width IS 'Width of the file''s height map in pixels, before decimation; NULL until rendered.';
COMMENT ON COLUMN surface_scans.source_height IS 'Height of the file''s height map in pixels, before decimation; NULL until rendered.';
COMMENT ON COLUMN surface_scans.grid_width IS 'Width in cells of the decimated grid the viewer loads (at most 1024 on the longer side); NULL until rendered.';
COMMENT ON COLUMN surface_scans.grid_height IS 'Height in cells of the decimated grid the viewer loads; NULL until rendered.';
COMMENT ON COLUMN surface_scans.pixel_pitch_x_um IS 'Cell size along x of the decimated grid in micrometres (the source pitch times the decimation factor); NULL until rendered.';
COMMENT ON COLUMN surface_scans.pixel_pitch_y_um IS 'Cell size along y of the decimated grid in micrometres; NULL until rendered.';
COMMENT ON COLUMN surface_scans.z_min_um IS 'Lowest height in the decimated grid in micrometres, ignoring cells with no data; NULL until rendered. A range the file states, not a roughness value.';
COMMENT ON COLUMN surface_scans.z_max_um IS 'Highest height in the decimated grid in micrometres, ignoring cells with no data; NULL until rendered.';
COMMENT ON COLUMN surface_scans.owner IS 'Legacy login that owns the scan (directus_users), kept hidden as on insert_edges; ownership is owner_person_id.';
COMMENT ON COLUMN surface_scans.owner_person_id IS 'The person who added the scan; filled with the creator by the d1-owner-default hook. Informational only: scans are reference data that every lab member can edit.';
COMMENT ON COLUMN surface_scans.created_at IS 'When the scan row was created.';
COMMENT ON COLUMN surface_scans.updated_at IS 'Last update time, maintained by the occ_surface_scans trigger.';
COMMENT ON COLUMN surface_scans.version IS 'Optimistic-concurrency counter, incremented by the occ_surface_scans trigger.';

CREATE TRIGGER occ_surface_scans
    BEFORE UPDATE ON surface_scans
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();
CREATE TRIGGER audit_surface_scans
    AFTER INSERT OR UPDATE OR DELETE ON surface_scans
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- Directus metadata.
INSERT INTO directus_collections (collection, icon, note, display_template, hidden, sort, color, translations)
VALUES ('surface_scans', 'view_in_ar',
        'Topography scans of cutting inserts and insert edges, viewed in 3D in STARbase',
        '{{condition}} {{scanned_on}}', false, 101, '#E91E63',
        '[{"language":"en-US","translation":"Surface Scans","singular":"Surface Scan","plural":"Surface Scans"}]')
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (
    collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width,
    translations, note
)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json,
       v.readonly, v.hidden, v.sort, v.width, v.translations::json, v.note
FROM (VALUES
    ('surface_scans', 'scan_id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', NULL, NULL),
    ('surface_scans', 'insert_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{insert_code}}","enableCreate":false}',
        'related-values', '{"template":"{{insert_code}}"}', false, false, 2, 'half',
        '[{"language":"en-US","translation":"Insert"}]', 'Set this or Edge, not both.'),
    ('surface_scans', 'edge_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{edge_code}}","enableCreate":false}',
        'related-values', '{"template":"{{edge_code}}"}', false, false, 3, 'half',
        '[{"language":"en-US","translation":"Edge"}]', 'Set this or Insert, not both.'),
    ('surface_scans', 'directus_files_id', 'file', 'file', NULL, 'file', NULL, false, false, 4, 'full',
        '[{"language":"en-US","translation":"Scan file"}]',
        'The topography file from the library. Adding it makes the file visible to everyone in the lab.'),
    ('surface_scans', 'condition', NULL, 'select-dropdown',
        '{"choices":[{"text":"New","value":"new"},{"text":"Worn","value":"worn"},{"text":"Cleaned","value":"cleaned"},{"text":"Other","value":"other"}]}',
        'labels', '{"choices":[{"text":"New","value":"new","foreground":"#2E7D32","background":"#E8F5E9"},{"text":"Worn","value":"worn","foreground":"#E65100","background":"#FFF3E0"},{"text":"Cleaned","value":"cleaned","foreground":"#1565C0","background":"#E3F2FD"},{"text":"Other","value":"other","foreground":"#616161","background":"#F5F5F5"}]}',
        false, false, 5, 'half', '[{"language":"en-US","translation":"Condition"}]',
        'The condition the insert or edge was in when scanned.'),
    ('surface_scans', 'condition_note', NULL, 'input', NULL, NULL, NULL, false, false, 6, 'half',
        '[{"language":"en-US","translation":"Condition note"}]', 'For example what Other means.'),
    ('surface_scans', 'scanned_on', NULL, 'datetime', NULL, 'datetime', '{"relative":false}', false, false, 7, 'half',
        '[{"language":"en-US","translation":"Scanned on"}]', 'The day the item was scanned.'),
    ('surface_scans', 'operation_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{pass_code}}","enableCreate":false}',
        'related-values', '{"template":"{{pass_code}}"}', false, false, 8, 'half',
        '[{"language":"en-US","translation":"Worn by operation"}]', 'The operation that wore the edge, if known.'),
    ('surface_scans', 'notes', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 9, 'full', NULL, NULL),
    ('surface_scans', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":false}',
        'related-values', '{"template":"{{full_name}}"}', false, false, 10, 'half',
        '[{"language":"en-US","translation":"Added by"}]', NULL),
    ('surface_scans', 'render_status', NULL, 'select-dropdown',
        '{"choices":[{"text":"Pending","value":"pending"},{"text":"Rendering","value":"rendering"},{"text":"Done","value":"done"},{"text":"Failed","value":"failed"}]}',
        'labels', '{"choices":[{"text":"Pending","value":"pending","foreground":"#616161","background":"#F5F5F5"},{"text":"Rendering","value":"rendering","foreground":"#1565C0","background":"#E3F2FD"},{"text":"Done","value":"done","foreground":"#2E7D32","background":"#E8F5E9"},{"text":"Failed","value":"failed","foreground":"#C62828","background":"#FFEBEE"}]}',
        true, true, 20, 'half', '[{"language":"en-US","translation":"Render status"}]',
        'Set by the render worker, or to Pending by Render again.'),
    ('surface_scans', 'render_error', NULL, 'input-multiline', NULL, NULL, NULL, true, true, 21, 'full',
        '[{"language":"en-US","translation":"Render error"}]', NULL),
    ('surface_scans', 'rendered_at', NULL, 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 22, 'half',
        '[{"language":"en-US","translation":"Rendered at"}]', NULL),
    ('surface_scans', 'cache_key', NULL, 'input', NULL, NULL, NULL, true, true, 23, 'full',
        '[{"language":"en-US","translation":"Cache key"}]', NULL),
    ('surface_scans', 'source_format', NULL, 'input', NULL, NULL, NULL, true, true, 24, 'half',
        '[{"language":"en-US","translation":"Source format"}]', NULL),
    ('surface_scans', 'source_width', NULL, 'input', NULL, NULL, NULL, true, true, 25, 'half',
        '[{"language":"en-US","translation":"Source width (px)"}]', NULL),
    ('surface_scans', 'source_height', NULL, 'input', NULL, NULL, NULL, true, true, 26, 'half',
        '[{"language":"en-US","translation":"Source height (px)"}]', NULL),
    ('surface_scans', 'grid_width', NULL, 'input', NULL, NULL, NULL, true, true, 27, 'half',
        '[{"language":"en-US","translation":"Grid width (cells)"}]', NULL),
    ('surface_scans', 'grid_height', NULL, 'input', NULL, NULL, NULL, true, true, 28, 'half',
        '[{"language":"en-US","translation":"Grid height (cells)"}]', NULL),
    ('surface_scans', 'pixel_pitch_x_um', NULL, 'input', '{"suffix":"µm"}', NULL, NULL, true, true, 29, 'half',
        '[{"language":"en-US","translation":"Pixel pitch x"}]', NULL),
    ('surface_scans', 'pixel_pitch_y_um', NULL, 'input', '{"suffix":"µm"}', NULL, NULL, true, true, 30, 'half',
        '[{"language":"en-US","translation":"Pixel pitch y"}]', NULL),
    ('surface_scans', 'z_min_um', NULL, 'input', '{"suffix":"µm"}', NULL, NULL, true, true, 31, 'half',
        '[{"language":"en-US","translation":"Lowest point"}]', NULL),
    ('surface_scans', 'z_max_um', NULL, 'input', '{"suffix":"µm"}', NULL, NULL, true, true, 32, 'half',
        '[{"language":"en-US","translation":"Highest point"}]', NULL),
    ('surface_scans', 'owner', 'm2o', 'select-dropdown-m2o', '{"template":"{{first_name}} {{last_name}}"}', 'user', NULL,
        true, true, 40, 'half', NULL, NULL),
    ('surface_scans', 'created_at', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 41, 'half', NULL, NULL),
    ('surface_scans', 'updated_at', 'date-updated', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 42, 'half', NULL, NULL),
    ('surface_scans', 'version', NULL, 'input', NULL, NULL, NULL, true, true, 43, 'half', NULL, NULL)
) v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
SELECT v.many_collection, v.many_field, v.one_collection, v.one_field, v.one_deselect_action
FROM (VALUES
    ('surface_scans', 'insert_id', 'cutting_inserts', NULL, 'nullify'),
    ('surface_scans', 'edge_id', 'insert_edges', NULL, 'nullify'),
    ('surface_scans', 'directus_files_id', 'directus_files', NULL, 'nullify'),
    ('surface_scans', 'operation_id', 'manufacturing_operations', NULL, 'nullify'),
    ('surface_scans', 'owner_person_id', 'people', NULL, 'nullify'),
    ('surface_scans', 'owner', 'directus_users', NULL, 'nullify')
) v(many_collection, many_field, one_collection, one_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- Permissions: the rows scripts/access_rules.json generates ("unfiltered": surface_scans create/read/update/delete for
-- Lab Member, like insert_edges) and the Lab Viewer read row (`gen_access_rules.py --viewer-values`).
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT 'surface_scans', v.action, '{}'::json, '{}'::json, NULL, '*', '20000002-0000-0000-0000-000000000002'
FROM (VALUES ('create'), ('read'), ('update'), ('delete')) v(action)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = 'surface_scans' AND p.action = v.action
);
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT 'surface_scans', 'read', '{}'::json, '{}'::json, NULL, '*', '20000002-0000-0000-0000-000000000003'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000003' AND p.collection = 'surface_scans' AND p.action = 'read'
);

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- Dropping the table drops every surface scan row (the derived MinIO objects are cache and stay); no other table
-- references it. Directus metadata and permission rows go with it.
DELETE FROM directus_permissions WHERE collection = 'surface_scans';
DELETE FROM directus_relations WHERE many_collection = 'surface_scans' OR one_collection = 'surface_scans';
DELETE FROM directus_fields WHERE collection = 'surface_scans';
DELETE FROM directus_collections WHERE collection = 'surface_scans';

DROP TRIGGER IF EXISTS audit_surface_scans ON surface_scans;
DROP TRIGGER IF EXISTS occ_surface_scans ON surface_scans;
DROP TABLE IF EXISTS surface_scans;
