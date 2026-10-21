-- migrate:up
-- Surface scans follow their file's provenance owner (ADR-0023; spec docs/superpowers/specs/2026-10-21-surface-scan-privacy-design.md; plan
-- docs/superpowers/plans/2026-10-21-surface-scan-privacy.md stream S1). It fulfils ADR-0022 decision 6 and supersedes decision 4 of ADR-0021.
--
-- Why: ADR-0022 made a file visible and linkable only to its provenance owner (directus_files.owner_person_id / owner_team_id; unowned and
-- already-linked legacy files stay open) and left surface scans lab-wide until this stream. Until now every Lab Member and Lab Viewer read every
-- surface_scans row, including directus_files_id and every value derived from the file (cache_key, source_*, grid_*, pixel_pitch_*, z_*,
-- render_error), the d1-surface-scan endpoint streamed the grid without looking at the file's owner, and a member could add someone else's owned
-- file as a scan (migration 196 says so). This migration is the database half; the endpoint, the worker and the STARbase panel are other streams of
-- the same release (the migration drops columns that today's endpoint, worker and panel read: deploy with Directus and the worker stopped, migrate,
-- restart Directus and flush Redis).
--
--   * The one visibility rule, used everywhere (endpoint, guard, filters): a scan's file is visible to an administrator, when the file has no owner
--     (owner_person_id and owner_team_id both NULL), or when file_readers has a row for (file, caller's login). A scan of a file the caller cannot
--     see stays visible as a LOCKED PLACEHOLDER: the Lab Member and Lab Viewer read row lists only the link facts (scan_id, insert_id, edge_id,
--     condition, scanned_on, operation_id, created_at, updated_at, version), so directus_files_id (the pointer-row id is uuid5('file:<path>'), so it
--     would let a guesser confirm a path), render_status, notes, condition_note and owner_person_id are readable through REST and GraphQL by
--     administrators only. The endpoint reads the rest with its own checks.
--   * File-derived data leaves the public row: d1_private.surface_scan_renders (render_error, rendered_at, cache_key, source_*, grid_*,
--     pixel_pitch_*, z_*), read only through the d1-surface-scan endpoint and written only through its administrator-only POST /:id/result route.
--     render_status stays on surface_scans (its CHECK and partial index): the worker polls and claims it. The twelve columns are copied over and
--     dropped; their Directus field rows go. No foreign key to directus_files (the indexer repoints those rows), no audit trigger (derived data).
--   * surface_scans_reset_render() now sets render_status back to pending and deletes the scan's surface_scan_renders row when the file changes.
--   * d1_private.surface_scan_access_log: one row per administrator 3D open (a `grid` read) of a scan the administrator could not read as a
--     non-administrator (confirmed Q3). Not a general audit: thumbnails, /assets and Data Studio stay unlogged. No foreign keys: a log outlives the
--     scan, the file and the user.
--   * The permission rows (scripts/access_rules.json custom.surface_scans, pasted by `gen_access_rules.py --values --only surface_scans` and
--     `--viewer-values`): create unchanged (the d1-access-guard now refuses a file the caller cannot read), read the nine link columns, update
--     and delete only for a scan whose file is unowned or whose file the caller can read (the m2o hop to the file, then the bare `readers` hop of
--     migrations 196 and 201, the shape the repo prescribes for update and delete rules), update without render_error (the render route clears
--     the private error instead). What they replace is kept in d1_private.surface_scans_rules_backup so `down` restores the exact old rows.
--   * Existing scans whose file is owned and whose adder's login has no file_readers row are COUNTED (a NOTICE); nothing is deleted. A scan whose
--     file later gets an owner (an administrator re-stamp, a crawler move) becomes private without any sync: visibility is computed live.
--   * Notes and COMMENTs that said the scan is lab-wide, or that owner_person_id is informational, are rewritten.
--
-- Down: restores the rules from the backup, re-adds the twelve columns (migration 192's types and COMMENTs), copies the values back (the OCC and
-- audit triggers are switched off for the copy, so version and updated_at do not move), puts 192's trigger function and the twelve field rows back and
-- drops the new tables. It is LOSSY for d1_private.surface_scan_access_log (the administrator log cannot be recovered; dump it first if a rollback on
-- real data is ever needed).
-- phase1's replay of migration 192's down runs this down first (a table that references surface_scans keeps 192's DROP TABLE from running).
-- After applying: flush Redis and restart Directus (it caches permissions and schema). Whether Directus accepts the m2o-then-bare-`readers` filter on a
-- live build, and what a non-owner can still reach through fields, filters, sorts, aggregates and GraphQL, are physical-test items SS5 and SS6.
SET LOCAL lock_timeout = '10s';

-- 1. The private tables.
CREATE TABLE d1_private.surface_scan_renders (
    scan_id           UUID NOT NULL,
    render_error      TEXT,
    rendered_at       TIMESTAMPTZ,
    cache_key         TEXT,
    source_format     TEXT,
    source_width      INTEGER,
    source_height     INTEGER,
    grid_width        INTEGER,
    grid_height       INTEGER,
    pixel_pitch_x_um  NUMERIC,
    pixel_pitch_y_um  NUMERIC,
    z_min_um          NUMERIC,
    z_max_um          NUMERIC,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT surface_scan_renders_pkey PRIMARY KEY (scan_id),
    CONSTRAINT surface_scan_renders_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.surface_scans (scan_id) ON DELETE CASCADE,
    -- the same pattern as validCacheKey() of the d1-surface-scan endpoint: a name, never a path
    CONSTRAINT surface_scan_renders_cache_key_check CHECK (cache_key ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$' AND cache_key !~ '[.][.]')
);

COMMENT ON TABLE d1_private.surface_scan_renders IS 'What the surface-scan worker derived from a scan''s file (ADR-0023): the render error, when it finished, the cache key of the MinIO objects, the source and grid sizes, the pixel pitch and the height range. One row per scan that has any of it; the row goes with the scan and is deleted when the scan''s file changes (surface_scans_reset_render). Moved out of surface_scans because these values come from a file only its owner may see: read only through the d1-surface-scan endpoint (which runs the file visibility rule first) and written only through its administrator-only POST /<id>/result route. In d1_private: not exposed by Directus, not in v_schema_dictionary, not granted to the LLM role. No foreign key to directus_files (the indexer repoints those rows) and no audit trigger (derived data). migration 205.';
COMMENT ON COLUMN d1_private.surface_scan_renders.scan_id IS 'The scan (surface_scans.scan_id). One row per scan; deleted with the scan.';
COMMENT ON COLUMN d1_private.surface_scan_renders.render_error IS 'Why the last render failed (an unreadable or unsupported file, a missing file); NULL unless surface_scans.render_status is failed. Cleared when a render is requested again.';
COMMENT ON COLUMN d1_private.surface_scan_renders.rendered_at IS 'When the last successful render finished; NULL until then.';
COMMENT ON COLUMN d1_private.surface_scan_renders.cache_key IS 'Names the derived objects under surface-scans/<cache_key>/ in MinIO: the file''s content_sha256 from file_fingerprints when the crawler has hashed it, otherwise the provisional key p-<directus_files_id>-<size>-<mtime>. Set by the worker (through POST /d1-surface-scan/<id>/result), which never hashes a file itself. Also the ETag of the served objects. CHECK: a name of letters, digits, dot, dash and underscore, at most 200 characters, no "..". Two files with identical bytes share objects; whoever can read one already holds the bytes of the other (ADR-0023 decision 9).';
COMMENT ON COLUMN d1_private.surface_scan_renders.source_format IS 'Name of the SurfaceTopography reader that opened the file (for example al3d); NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.source_width IS 'Width of the file''s height map in pixels, before decimation; NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.source_height IS 'Height of the file''s height map in pixels, before decimation; NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.grid_width IS 'Width in cells of the decimated grid the viewer loads (at most 1024 on the longer side); NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.grid_height IS 'Height in cells of the decimated grid the viewer loads; NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.pixel_pitch_x_um IS 'Cell size along x of the decimated grid in micrometres (the source pitch times the decimation factor); NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.pixel_pitch_y_um IS 'Cell size along y of the decimated grid in micrometres; NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.z_min_um IS 'Lowest height in the decimated grid in micrometres, ignoring cells with no data; NULL until rendered. A range the file states, not a roughness value.';
COMMENT ON COLUMN d1_private.surface_scan_renders.z_max_um IS 'Highest height in the decimated grid in micrometres, ignoring cells with no data; NULL until rendered.';
COMMENT ON COLUMN d1_private.surface_scan_renders.updated_at IS 'When this row was last written (by the result route, or by this migration''s copy: the scan''s updated_at at that time).';
COMMENT ON CONSTRAINT surface_scan_renders_cache_key_check ON d1_private.surface_scan_renders IS 'A cache key is a name, never a path (the pattern of validCacheKey in the d1-surface-scan endpoint).';

CREATE TABLE d1_private.surface_scan_access_log (
    id                BIGSERIAL NOT NULL,
    scan_id           UUID NOT NULL,
    directus_files_id UUID NOT NULL,
    read_by_user      UUID NOT NULL,
    read_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason            TEXT NOT NULL,
    CONSTRAINT surface_scan_access_log_pkey PRIMARY KEY (id),
    CONSTRAINT surface_scan_access_log_reason_check CHECK (btrim(reason) <> '')
);
CREATE INDEX idx_surface_scan_access_log_scan_id ON d1_private.surface_scan_access_log (scan_id, read_at);

COMMENT ON TABLE d1_private.surface_scan_access_log IS 'One row per administrator 3D open (a grid read through the d1-surface-scan endpoint) of a scan the administrator could not have read as a non-administrator, because its file belongs to someone else (ADR-0023 decision 5, shaped like sem_settings_access_log). Not a general audit: thumbnails and metadata reads, /assets and Data Studio are not logged, and a Directus administrator can read the file directly without a row. No foreign keys: the log outlives the scan, the file and the user. migration 205.';
COMMENT ON COLUMN d1_private.surface_scan_access_log.id IS 'Surrogate key.';
COMMENT ON COLUMN d1_private.surface_scan_access_log.scan_id IS 'The scan that was opened. Not a foreign key: kept when the scan is deleted.';
COMMENT ON COLUMN d1_private.surface_scan_access_log.directus_files_id IS 'The file the scan pointed at when it was opened. Not a foreign key: kept when the file is deleted.';
COMMENT ON COLUMN d1_private.surface_scan_access_log.read_by_user IS 'The Directus user (an administrator) who opened the scan. Not a foreign key.';
COMMENT ON COLUMN d1_private.surface_scan_access_log.read_at IS 'When the scan was opened.';
COMMENT ON COLUMN d1_private.surface_scan_access_log.reason IS 'Why the read was allowed, in words (for example administrator read of a scan whose file belongs to someone else). Required, not blank.';
COMMENT ON INDEX d1_private.idx_surface_scan_access_log_scan_id IS 'Who opened a scan, newest last.';

-- 2. The data move: every scan that has any of the twelve values gets a row, then the columns go. The copy keeps the scan's updated_at.
INSERT INTO d1_private.surface_scan_renders (
    scan_id, render_error, rendered_at, cache_key, source_format, source_width, source_height, grid_width, grid_height,
    pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um, updated_at
)
SELECT s.scan_id, s.render_error, s.rendered_at, s.cache_key, s.source_format, s.source_width, s.source_height, s.grid_width, s.grid_height,
       s.pixel_pitch_x_um, s.pixel_pitch_y_um, s.z_min_um, s.z_max_um, s.updated_at
  FROM surface_scans s
 WHERE num_nonnulls(
           s.render_error, s.rendered_at, s.cache_key, s.source_format, s.source_width, s.source_height, s.grid_width, s.grid_height,
           s.pixel_pitch_x_um, s.pixel_pitch_y_um, s.z_min_um, s.z_max_um
       ) > 0;

-- The function first (it names the moved columns), then the columns.
CREATE OR REPLACE FUNCTION surface_scans_reset_render() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.render_status := 'pending';
    DELETE FROM d1_private.surface_scan_renders WHERE scan_id = NEW.scan_id;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION surface_scans_reset_render() IS 'BEFORE UPDATE OF directus_files_id on surface_scans, only when the file changes: sets render_status back to pending and deletes the scan''s row in d1_private.surface_scan_renders (the error, cache key, sizes and heights derived from the old file), so the old render is never shown under the new file. migration 205 (migration 192 cleared columns of the scan row).';

ALTER TABLE surface_scans
    DROP COLUMN render_error,
    DROP COLUMN rendered_at,
    DROP COLUMN cache_key,
    DROP COLUMN source_format,
    DROP COLUMN source_width,
    DROP COLUMN source_height,
    DROP COLUMN grid_width,
    DROP COLUMN grid_height,
    DROP COLUMN pixel_pitch_x_um,
    DROP COLUMN pixel_pitch_y_um,
    DROP COLUMN z_min_um,
    DROP COLUMN z_max_um;

-- 3. Directus metadata and text. The twelve field rows go (the columns are gone); notes and COMMENTs that said the scan is lab-wide change.
DELETE FROM directus_fields
 WHERE collection = 'surface_scans'
   AND field IN ('render_error', 'rendered_at', 'cache_key', 'source_format', 'source_width', 'source_height', 'grid_width', 'grid_height',
                 'pixel_pitch_x_um', 'pixel_pitch_y_um', 'z_min_um', 'z_max_um');

UPDATE directus_fields
   SET note = 'The topography file from the library. Only the file''s owner (or their team) and administrators can see the file and its 3D view; other lab members see that the item has a scan. A file with no owner stays visible to everyone in the lab.'
 WHERE collection = 'surface_scans' AND field = 'directus_files_id';

COMMENT ON TABLE surface_scans IS 'One topography scan (an Alicona .al3d or any file SurfaceTopography reads) of one cutting insert or one insert edge, with the condition the item was in. Not a Test. The file is a pointer row in directus_files on the archive share; the surface-scan worker renders it into a decimated height grid and a thumbnail (MinIO, prefix surface-scans/<cache_key>/) that the d1-surface-scan endpoint serves. Exactly one of insert_id and edge_id is set. The scan follows its file''s provenance owner (ADR-0023): a member who cannot see the file (not its owner or team, not an administrator, and the file has an owner) sees only the condition, date and operation as a locked placeholder; the file, notes, adder and everything derived from the file (d1_private.surface_scan_renders) are hidden. Scans of files with no owner stay visible to every lab member.';
COMMENT ON COLUMN surface_scans.directus_files_id IS 'The scan file: a row in directus_files (a pointer to the archive share, storage star, or an upload). The same file can be filed once per insert and once per edge. Visible only to administrators and to people who can see the file (ADR-0023): the Lab Member read row leaves it out, and the d1-access-guard refuses to add or repoint a scan to a file the caller cannot read.';
COMMENT ON COLUMN surface_scans.render_status IS 'Where the render stands: pending (new, or Render again was pressed), rendering (the worker has it), done (the grid, meta and thumbnail objects exist and d1_private.surface_scan_renders is filled) or failed (see render_error in that table). Claimed by the surface-scan worker, finished through POST /d1-surface-scan/<id>/result, and set to pending by POST /d1-surface-scan/<id>/render; the viewer is served only when it is done. Not readable by members (it describes the file); the endpoint shows it to people who can see the file.';
COMMENT ON COLUMN surface_scans.owner_person_id IS 'The person who added the scan; filled with the creator by the d1-owner-default hook. It does not decide who sees the scan or its file (the file''s provenance owner does, ADR-0023); readable through Directus by administrators only, and shown by the endpoint to people who can see the file.';

-- 4. The permission rows. What they replace is kept for `down`. The block between the markers is replayed on its own by tests/phase1_schema.sh.
-- rules:begin
CREATE TABLE d1_private.surface_scans_rules_backup AS
SELECT p.policy, p.action, p.permissions, p.validation, p.fields
  FROM directus_permissions p
 WHERE p.collection = 'surface_scans'
   AND p.policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003');
COMMENT ON TABLE d1_private.surface_scans_rules_backup IS 'The Lab Member and Lab Viewer surface_scans permission rows as they were before migration 205, so its down section restores them exactly. Dropped by that down.';
COMMENT ON COLUMN d1_private.surface_scans_rules_backup.policy IS 'The policy id of the saved directus_permissions row (Lab Member or Lab Viewer).';
COMMENT ON COLUMN d1_private.surface_scans_rules_backup.action IS 'The action of the saved row: create, read, update or delete.';
COMMENT ON COLUMN d1_private.surface_scans_rules_backup.permissions IS 'The saved filter (JSON, possibly NULL).';
COMMENT ON COLUMN d1_private.surface_scans_rules_backup.validation IS 'The saved validation (JSON, possibly NULL).';
COMMENT ON COLUMN d1_private.surface_scans_rules_backup.fields IS 'The saved comma-separated field list (possibly NULL).';

DROP TABLE IF EXISTS pg_temp._surface_scan_rules;
CREATE TEMP TABLE _surface_scan_rules (policy UUID, collection TEXT, action TEXT, permissions JSON, validation JSON, fields TEXT);
INSERT INTO _surface_scan_rules (policy, collection, action, permissions, validation, fields)
SELECT v.policy::uuid, v.collection, v.action, v.permissions::json, v.validation::json, v.fields
FROM (VALUES
    -- Lab Member (python3 scripts/gen_access_rules.py --values --only surface_scans)
    ('20000002-0000-0000-0000-000000000002', 'surface_scans', 'create', '{}', '{}', 'insert_id,edge_id,directus_files_id,condition,condition_note,scanned_on,operation_id,notes,owner_person_id'),
    ('20000002-0000-0000-0000-000000000002', 'surface_scans', 'read', '{}', '{}', 'scan_id,insert_id,edge_id,condition,scanned_on,operation_id,created_at,updated_at,version'),
    ('20000002-0000-0000-0000-000000000002', 'surface_scans', 'update', '{"_or":[{"_and":[{"directus_files_id":{"owner_person_id":{"_null":true}}},{"directus_files_id":{"owner_team_id":{"_null":true}}}]},{"directus_files_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', 'insert_id,edge_id,directus_files_id,condition,condition_note,scanned_on,operation_id,notes,owner_person_id,render_status'),
    ('20000002-0000-0000-0000-000000000002', 'surface_scans', 'delete', '{"_or":[{"_and":[{"directus_files_id":{"owner_person_id":{"_null":true}}},{"directus_files_id":{"owner_team_id":{"_null":true}}}]},{"directus_files_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    -- Lab Viewer (python3 scripts/gen_access_rules.py --viewer-values): the Lab Member read row under the viewer's policy
    ('20000002-0000-0000-0000-000000000003', 'surface_scans', 'read', '{}', '{}', 'scan_id,insert_id,edge_id,condition,scanned_on,operation_id,created_at,updated_at,version')
) AS v (policy, collection, action, permissions, validation, fields);

-- A Lab Viewer row only where the Lab Viewer policy exists (migration 185 creates it).
DELETE FROM _surface_scan_rules r
 WHERE r.policy = '20000002-0000-0000-0000-000000000003'
   AND NOT EXISTS (SELECT 1 FROM directus_policies pol WHERE pol.id = r.policy);

UPDATE directus_permissions p
   SET permissions = r.permissions, validation = r.validation, fields = r.fields
  FROM _surface_scan_rules r
 WHERE p.policy = r.policy AND p.collection = r.collection AND p.action = r.action;

INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
SELECT r.collection, r.action, r.permissions, r.validation, r.fields, r.policy
  FROM _surface_scan_rules r
 WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = r.policy AND p.collection = r.collection AND p.action = r.action);

DROP TABLE pg_temp._surface_scan_rules;
-- rules:end

-- 5. Report, do not delete: scans whose file is owned and whose adder's login has no file_readers row (an unknown adder counts too). They stay, as
-- locked placeholders for everyone but the file's readers and administrators.
DO $notice$
DECLARE
    n_total BIGINT;
    n_unknown BIGINT;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE s.owner_person_id IS NULL)
      INTO n_total, n_unknown
      FROM surface_scans s
      JOIN directus_files f ON f.id = s.directus_files_id
     WHERE (f.owner_person_id IS NOT NULL OR f.owner_team_id IS NOT NULL)
       AND NOT EXISTS (
           SELECT 1
             FROM people p
             JOIN file_readers r ON r.user_id = p.user_id
            WHERE p.person_id = s.owner_person_id AND r.directus_files_id = f.id
       );
    RAISE NOTICE 'ADR-0023: % existing surface scan(s) point at an owned file their adder cannot read (% with no recorded adder). They are kept, and now show as locked placeholders to everyone but the file''s readers and administrators.', n_total, n_unknown;
END
$notice$;

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- Rules first: the backup's rows are put back (and the rows of this migration that have no backup row are removed), then the backup is dropped. Skipped
-- when the backup is already gone (a second down does nothing to the rules).
DO $$
BEGIN
    IF to_regclass('d1_private.surface_scans_rules_backup') IS NOT NULL THEN
        DELETE FROM directus_permissions p
         WHERE p.collection = 'surface_scans'
           AND p.policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003')
           AND NOT EXISTS (SELECT 1 FROM d1_private.surface_scans_rules_backup b WHERE b.policy = p.policy AND b.action = p.action);

        UPDATE directus_permissions p
           SET permissions = b.permissions, validation = b.validation, fields = b.fields
          FROM d1_private.surface_scans_rules_backup b
         WHERE p.collection = 'surface_scans' AND p.policy = b.policy AND p.action = b.action;

        INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
        SELECT 'surface_scans', b.action, b.permissions, b.validation, b.fields, b.policy
          FROM d1_private.surface_scans_rules_backup b
         WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = b.policy AND p.collection = 'surface_scans' AND p.action = b.action);

        DROP TABLE d1_private.surface_scans_rules_backup;
    END IF;
END
$$;

-- The twelve columns come back with migration 192's types (their position in the table is not restored).
ALTER TABLE surface_scans
    ADD COLUMN IF NOT EXISTS render_error TEXT,
    ADD COLUMN IF NOT EXISTS rendered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cache_key TEXT,
    ADD COLUMN IF NOT EXISTS source_format TEXT,
    ADD COLUMN IF NOT EXISTS source_width INTEGER,
    ADD COLUMN IF NOT EXISTS source_height INTEGER,
    ADD COLUMN IF NOT EXISTS grid_width INTEGER,
    ADD COLUMN IF NOT EXISTS grid_height INTEGER,
    ADD COLUMN IF NOT EXISTS pixel_pitch_x_um NUMERIC,
    ADD COLUMN IF NOT EXISTS pixel_pitch_y_um NUMERIC,
    ADD COLUMN IF NOT EXISTS z_min_um NUMERIC,
    ADD COLUMN IF NOT EXISTS z_max_um NUMERIC;

-- Copy the values back. The OCC and audit triggers are off for it, so version and updated_at do not move and no audit row is written; the reset
-- trigger only fires on a change of directus_files_id. Skipped when the private table is already gone (a second down).
ALTER TABLE surface_scans DISABLE TRIGGER occ_surface_scans;
ALTER TABLE surface_scans DISABLE TRIGGER audit_surface_scans;
DO $$
BEGIN
    IF to_regclass('d1_private.surface_scan_renders') IS NOT NULL THEN
        UPDATE surface_scans s
           SET render_error = r.render_error, rendered_at = r.rendered_at, cache_key = r.cache_key, source_format = r.source_format,
               source_width = r.source_width, source_height = r.source_height, grid_width = r.grid_width, grid_height = r.grid_height,
               pixel_pitch_x_um = r.pixel_pitch_x_um, pixel_pitch_y_um = r.pixel_pitch_y_um, z_min_um = r.z_min_um, z_max_um = r.z_max_um
          FROM d1_private.surface_scan_renders r
         WHERE r.scan_id = s.scan_id;
    END IF;
END
$$;
ALTER TABLE surface_scans ENABLE TRIGGER audit_surface_scans;
ALTER TABLE surface_scans ENABLE TRIGGER occ_surface_scans;

-- Migration 192's trigger function and texts.
CREATE OR REPLACE FUNCTION surface_scans_reset_render() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    NEW.render_status := 'pending';
    NEW.render_error := NULL;
    NEW.rendered_at := NULL;
    NEW.cache_key := NULL;
    NEW.source_format := NULL;
    NEW.source_width := NULL;
    NEW.source_height := NULL;
    NEW.grid_width := NULL;
    NEW.grid_height := NULL;
    NEW.pixel_pitch_x_um := NULL;
    NEW.pixel_pitch_y_um := NULL;
    NEW.z_min_um := NULL;
    NEW.z_max_um := NULL;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION surface_scans_reset_render() IS 'BEFORE UPDATE OF directus_files_id on surface_scans, only when the file changes: sets render_status back to pending and clears render_error, rendered_at, cache_key and every source_*, grid_*, pixel_pitch_* and z_* column, so the old render is never shown under the new file.';

COMMENT ON TABLE surface_scans IS 'One topography scan (an Alicona .al3d or any file SurfaceTopography reads) of one cutting insert or one insert edge, with the condition the item was in. Not a Test. The file is a pointer row in directus_files on the archive share; the surface-scan worker renders it into a decimated height grid and a thumbnail (MinIO, prefix surface-scans/<cache_key>/) that the d1-surface-scan endpoint serves. Exactly one of insert_id and edge_id is set.';
COMMENT ON COLUMN surface_scans.directus_files_id IS 'The scan file: a row in directus_files (a pointer to the archive share, storage star, or an upload). The same file can be filed once per insert and once per edge.';
COMMENT ON COLUMN surface_scans.render_status IS 'Where the render stands: pending (new, or Render again was pressed), rendering (the worker has it), done (the grid, meta and thumbnail objects exist and the columns below are filled) or failed (see render_error). Set by the surface-scan worker and by POST /d1-surface-scan/<id>/render; the viewer is served only when it is done.';
COMMENT ON COLUMN surface_scans.owner_person_id IS 'The person who added the scan; filled with the creator by the d1-owner-default hook. Informational only: scans are reference data that every lab member can edit.';
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

-- Migration 192's field rows (the twelve) and the file note, as they were.
INSERT INTO directus_fields (
    collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width,
    translations, note
)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json,
       v.readonly, v.hidden, v.sort, v.width, v.translations::json, v.note
FROM (VALUES
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
        '[{"language":"en-US","translation":"Highest point"}]', NULL)
) v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

UPDATE directus_fields
   SET note = 'The topography file from the library. Adding it makes the file visible to everyone in the lab.'
 WHERE collection = 'surface_scans' AND field = 'directus_files_id';

-- The new tables go last (surface_scan_renders references surface_scans, which stays).
DROP TABLE IF EXISTS d1_private.surface_scan_access_log;
DROP TABLE IF EXISTS d1_private.surface_scan_renders;
