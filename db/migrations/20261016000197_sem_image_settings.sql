-- migrate:up
-- Imaging settings per SEM image, and the one function that writes them (ADR-0022; spec docs/superpowers/specs/2026-10-16-sem-data-bar-reader-design.md
-- sections 2 and 3, decisions D3, D4, D6, D9; plan docs/superpowers/plans/2026-10-16-sem-reader.md task C2).
--
-- Why: the inbox crawler reads an SEM image's settings (kV, spot, working distance, magnification, field width, pixel size, scale bar, detector, mode,
-- instrument, acquisition time) from its TIFF metadata or, for a PNG, BMP or JPEG export, from the data bar, and keeps them in
-- d1_private.file_candidates.extracted. When a person LINKS the image the settings are saved per image, so a record page can show them, and only the
-- file's owner can correct one. This migration is the database half:
--
--   * d1_private.sem_image_settings   one row per file: numeric columns with the unit in the name and CHECKs for the sanity ranges (kv 0.1 to 30,
--     working_distance_mm 0.1 to 50, magnification 5 to 1,000,000, spot 1 to 10; the derived sizes only have to be positive), sources (per field:
--     metadata, derived, ocr or manual) and flags (check_this, acquired_at = invalid_local_time, ...) as JSON objects, who read it and when, and who
--     corrected it. No audit trigger (derived bookkeeping, like file_candidates; the link itself is audited on its junction row). In d1_private:
--     outside the Directus schema scan, not in v_schema_dictionary, not granted to d1_llm_readonly; reached only through the d1-inbox endpoint,
--     which enforces the owner rule (settings follow the file: the endpoint answers "locked" to anyone but the owner and logs an administrator's read).
--   * d1_private.sem_settings_access_log   one row per administrator read of settings that are not theirs. No foreign keys: a log outlives the file
--     and the user it records (the same reason the settings' corrected_by has none).
--   * d1_private.file_candidates.classified_by   which profile and version set kind, kind_confidence and extracted (for example sem-2), so a
--     re-classification pass can skip rows that are current.
--   * d1_private.save_sem_settings(file, extracted, read_by) RETURNS boolean   the ONLY place `extracted` becomes columns. It maps the documented keys
--     and drops a value that is not of the right JSON type or is outside its range (the value AS GIVEN is tested against the range, then rounded to the
--     column's scale, so a bad value costs that field, never the link, and a value that rounding would bring inside the range, such as kv 0.095, is
--     still dropped). It MERGES into the row (ruling R12): only the keys present in `extracted` are updated, a key it does not carry keeps its stored
--     value and its stored sources and flags entries, and a key that is present but unusable (out of range, null, the wrong type) is dropped and does
--     not erase the stored value, so a re-read that carries fewer fields (a back-fill without OCR) cannot erase what an earlier read found. An updated key
--     takes the source the read gave it (or none), and loses the flag that was named after it; it keeps only the sources of the fields it saved and
--     never a source of 'manual' (only a person's correction is manual). It SKIPS every field whose stored source is 'manual' and takes no flag named
--     after one. It returns whether a row exists afterwards: false for an extracted with nothing usable on a file that has no row (no row is written);
--     true for a file that has one (left exactly as it is when nothing usable was given).
--   * d1_private.correct_sem_setting(file, field, value, user) RETURNS void   the owner's correction: sets the one field from a JSON value (same type and
--     range rules; unknown fields, such as read_by or sources, are refused), marks sources.<field> = 'manual', drops the flag named after the field,
--     and records corrected_by and corrected_at. The endpoint checks that the caller owns the file; the function checks the value.
--   * two helpers, sem_clean_number and sem_try_timestamptz (and sem_clean_text), so a malformed value is dropped instead of raising: Python has already
--     validated the values, this is the second line.
--
-- SECURITY INVOKER: nothing here needs more than the caller's own rights; the caller is the d1-inbox endpoint's database role.
-- Down drops both tables, the functions and the column. It is LOSSY: the crawler can read the values again, but the owners' manual corrections
-- (sources = manual, corrected_by, corrected_at) and the administrator access log cannot be recovered. Dump d1_private.sem_image_settings and
-- d1_private.sem_settings_access_log first if a rollback on real data is ever needed.
SET LOCAL lock_timeout = '10s';

CREATE TABLE d1_private.sem_image_settings (
    directus_files_id UUID NOT NULL,
    kv NUMERIC(6, 2),
    spot NUMERIC(4, 1),
    working_distance_mm NUMERIC(6, 2),
    magnification INTEGER,
    hfw_um NUMERIC(10, 2),
    pixel_size_nm NUMERIC(12, 4),
    scale_bar_um NUMERIC(12, 3),
    detector TEXT,
    mode TEXT,
    instrument TEXT,
    acquired_at TIMESTAMPTZ,
    sources JSONB NOT NULL DEFAULT '{}',
    flags JSONB NOT NULL DEFAULT '{}',
    read_by TEXT NOT NULL,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    corrected_by UUID,
    corrected_at TIMESTAMPTZ,
    CONSTRAINT sem_image_settings_pkey PRIMARY KEY (directus_files_id),
    CONSTRAINT sem_image_settings_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES directus_files (id) ON DELETE CASCADE,
    CONSTRAINT sem_image_settings_kv_check CHECK (kv BETWEEN 0.1 AND 30),
    CONSTRAINT sem_image_settings_spot_check CHECK (spot BETWEEN 1 AND 10),
    CONSTRAINT sem_image_settings_working_distance_mm_check CHECK (working_distance_mm BETWEEN 0.1 AND 50),
    CONSTRAINT sem_image_settings_magnification_check CHECK (magnification BETWEEN 5 AND 1000000),
    CONSTRAINT sem_image_settings_hfw_um_check CHECK (hfw_um > 0),
    CONSTRAINT sem_image_settings_pixel_size_nm_check CHECK (pixel_size_nm > 0),
    CONSTRAINT sem_image_settings_scale_bar_um_check CHECK (scale_bar_um > 0),
    CONSTRAINT sem_image_settings_text_length_check CHECK (char_length(detector) <= 200 AND char_length(mode) <= 200 AND char_length(instrument) <= 200),
    CONSTRAINT sem_image_settings_sources_object_check CHECK (jsonb_typeof(sources) = 'object'),
    CONSTRAINT sem_image_settings_flags_object_check CHECK (jsonb_typeof(flags) = 'object')
);

COMMENT ON TABLE d1_private.sem_image_settings IS 'Imaging settings of one SEM image (ADR-0022, spec 2026-10-16), one row per directus_files row, written when a person links the image (and by the SEM back-fill) through d1_private.save_sem_settings and corrected by its owner through d1_private.correct_sem_setting. Derived data: no audit or OCC trigger; the link is audited on its junction row. In d1_private: not exposed by Directus, not in v_schema_dictionary, not granted to the LLM role; read only through the d1-inbox endpoint, which shows it to the file''s owner (an administrator read-only and logged) and a locked answer to everyone else. Absent keys mean unknown, never zero. migration 197.';
COMMENT ON COLUMN d1_private.sem_image_settings.directus_files_id IS 'The image (directus_files.id). One row per file; the row is deleted with the file.';
COMMENT ON COLUMN d1_private.sem_image_settings.kv IS 'Accelerating voltage in kilovolts, 0.1 to 30 (CHECK); NULL when unknown or outside the range.';
COMMENT ON COLUMN d1_private.sem_image_settings.spot IS 'Spot size (the instrument''s dimensionless setting), 1 to 10 (CHECK); NULL when unknown or outside the range.';
COMMENT ON COLUMN d1_private.sem_image_settings.working_distance_mm IS 'Working distance in millimetres, 0.1 to 50 (CHECK); NULL when unknown or outside the range.';
COMMENT ON COLUMN d1_private.sem_image_settings.magnification IS 'Magnification as the instrument prints it (an integer), 5 to 1,000,000 (CHECK); derived from the screen-width constant and the horizontal field width when read from metadata; NULL when unknown, failed its cross-check or outside the range.';
COMMENT ON COLUMN d1_private.sem_image_settings.hfw_um IS 'Horizontal field width in micrometres (the width of the imaged area), greater than 0; NULL when unknown.';
COMMENT ON COLUMN d1_private.sem_image_settings.pixel_size_nm IS 'Size of one pixel in nanometres, greater than 0; NULL when unknown.';
COMMENT ON COLUMN d1_private.sem_image_settings.scale_bar_um IS 'Length the printed scale bar stands for, in micrometres, greater than 0; NULL when unknown.';
COMMENT ON COLUMN d1_private.sem_image_settings.detector IS 'Detector name as the instrument records it (for example ETD), up to 200 characters; NULL when unknown.';
COMMENT ON COLUMN d1_private.sem_image_settings.mode IS 'Imaging mode as the instrument records it (for example SE or BSE), up to 200 characters; NULL when unknown.';
COMMENT ON COLUMN d1_private.sem_image_settings.instrument IS 'Instrument name or model as recorded, up to 200 characters; NULL when unknown.';
COMMENT ON COLUMN d1_private.sem_image_settings.acquired_at IS 'When the image was taken. The instrument clock is UK time (Europe/London, D5); stored as the instant. NULL when unknown or when the local time does not exist (flags.acquired_at = invalid_local_time).';
COMMENT ON COLUMN d1_private.sem_image_settings.sources IS 'JSON object: for each saved field, where its value came from: metadata (TIFF tags), derived (calculated from metadata), ocr (read from the data bar) or manual (a person''s correction, never overwritten by a re-read). Only fields that have a value appear.';
COMMENT ON COLUMN d1_private.sem_image_settings.flags IS 'JSON object of notes on the read: check_this true (a value that could not be cross-checked), a field name with a reason (for example acquired_at = invalid_local_time), a metadata/bar mismatch. A re-read replaces it; a correction removes the flag named after the corrected field.';
COMMENT ON COLUMN d1_private.sem_image_settings.read_by IS 'The profile and version that read the values (for example sem-2), the same text as d1_private.file_candidates.classified_by.';
COMMENT ON COLUMN d1_private.sem_image_settings.read_at IS 'When the values were last read or saved from a read.';
COMMENT ON COLUMN d1_private.sem_image_settings.corrected_by IS 'The Directus user who last corrected a value (NULL when none has). No foreign key: the history outlives the user.';
COMMENT ON COLUMN d1_private.sem_image_settings.corrected_at IS 'When a value was last corrected by a person (NULL when none has).';

CREATE TABLE d1_private.sem_settings_access_log (
    id BIGSERIAL NOT NULL,
    directus_files_id UUID NOT NULL,
    read_by_user UUID NOT NULL,
    read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason TEXT NOT NULL,
    CONSTRAINT sem_settings_access_log_pkey PRIMARY KEY (id),
    CONSTRAINT sem_settings_access_log_reason_check CHECK (btrim(reason) <> '')
);
CREATE INDEX idx_sem_settings_access_log_directus_files_id ON d1_private.sem_settings_access_log (directus_files_id, read_at);

COMMENT ON TABLE d1_private.sem_settings_access_log IS 'One row per administrator read of the imaging settings of a file that is not the administrator''s own (ADR-0022 decision 3), written by the d1-inbox endpoint. No foreign keys: the log outlives the file and the user. migration 197.';
COMMENT ON COLUMN d1_private.sem_settings_access_log.id IS 'Surrogate key.';
COMMENT ON COLUMN d1_private.sem_settings_access_log.directus_files_id IS 'The file whose settings were read. Not a foreign key: kept when the file is deleted.';
COMMENT ON COLUMN d1_private.sem_settings_access_log.read_by_user IS 'The Directus user (an administrator) who read the settings. Not a foreign key.';
COMMENT ON COLUMN d1_private.sem_settings_access_log.read_at IS 'When the settings were read.';
COMMENT ON COLUMN d1_private.sem_settings_access_log.reason IS 'Why the read was allowed, in words (for example administrator read of a file owned by someone else). Required, not blank.';
COMMENT ON INDEX d1_private.idx_sem_settings_access_log_directus_files_id IS 'Who read the settings of a file, newest last.';

ALTER TABLE d1_private.file_candidates ADD COLUMN classified_by TEXT;
COMMENT ON COLUMN d1_private.file_candidates.classified_by IS 'The classifier profile and version that set kind, kind_confidence and extracted (for example sem-2); NULL for rows no profile version has classified. A re-classification pass (--reclassify) skips rows already at the current version. migration 197.';

-- Helpers: a value that is not of the right type or range becomes NULL instead of raising.
CREATE FUNCTION d1_private.sem_clean_number(p_field TEXT, p_value JSONB) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE WHEN r.v BETWEEN b.lo AND b.hi THEN round(r.v, b.scale) END
      FROM (VALUES
              ('kv', 0.1, 30::numeric, 2),
              ('spot', 1, 10, 1),
              ('working_distance_mm', 0.1, 50, 2),
              ('magnification', 5, 1000000, 0),
              ('hfw_um', 0.01, 99999999.99, 2),
              ('pixel_size_nm', 0.0001, 99999999.9999, 4),
              ('scale_bar_um', 0.001, 999999999.999, 3)
           ) AS b (field, lo, hi, scale)
     CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(p_value) = 'number' THEN (p_value #>> '{}')::numeric END AS v) r
     WHERE b.field = p_field
$fn$;
COMMENT ON FUNCTION d1_private.sem_clean_number(TEXT, JSONB) IS 'The numeric value of a JSON number for one imaging field: the value as given must be inside the range (so 0.095 is not a kv), and it is then rounded to the column''s scale (kv 0.1 to 30, spot 1 to 10, working_distance_mm 0.1 to 50, magnification 5 to 1,000,000, hfw_um, pixel_size_nm and scale_bar_um above 0 and inside their column); NULL for anything else (not a number, outside the range as given, unknown field). The one place the ranges live in code; the table CHECKs repeat the first four. migration 197.';

CREATE FUNCTION d1_private.sem_clean_text(p_value JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'string' AND char_length(btrim(p_value #>> '{}')) BETWEEN 1 AND 200 THEN btrim(p_value #>> '{}') END
$fn$;
COMMENT ON FUNCTION d1_private.sem_clean_text(JSONB) IS 'A JSON string trimmed, kept only when it is 1 to 200 characters long; NULL for anything else (not a string, blank, longer). migration 197.';

CREATE FUNCTION d1_private.sem_try_timestamptz(p_value JSONB) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) <> 'string'
       OR (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$' THEN
        RETURN NULL;
    END IF;
    RETURN (p_value #>> '{}')::timestamptz;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION d1_private.sem_try_timestamptz(JSONB) IS 'A JSON string of the form 2025-08-07T14:59:45+01:00 (date, time, and an offset or Z; no offset is refused because it would be read in the session''s time zone) as a timestamptz; NULL for anything else, including an impossible calendar date. migration 197.';

-- The only place `extracted` becomes columns.
CREATE FUNCTION d1_private.save_sem_settings(p_files_id UUID, p_extracted JSONB, p_read_by TEXT) RETURNS BOOLEAN
LANGUAGE sql SECURITY INVOKER AS $fn$
    WITH x AS (
        SELECT CASE WHEN jsonb_typeof(p_extracted) = 'object' THEN p_extracted ELSE '{}'::jsonb END AS j
    ), f AS (
        -- what this read carries: NULL for a key that is absent or unusable (wrong type, outside its range)
        SELECT d1_private.sem_clean_number('kv', j -> 'kv')::numeric(6, 2) AS kv,
               d1_private.sem_clean_number('spot', j -> 'spot')::numeric(4, 1) AS spot,
               d1_private.sem_clean_number('working_distance_mm', j -> 'working_distance_mm')::numeric(6, 2) AS working_distance_mm,
               d1_private.sem_clean_number('magnification', j -> 'magnification')::integer AS magnification,
               d1_private.sem_clean_number('hfw_um', j -> 'hfw_um')::numeric(10, 2) AS hfw_um,
               d1_private.sem_clean_number('pixel_size_nm', j -> 'pixel_size_nm')::numeric(12, 4) AS pixel_size_nm,
               d1_private.sem_clean_number('scale_bar_um', j -> 'scale_bar_um')::numeric(12, 3) AS scale_bar_um,
               d1_private.sem_clean_text(j -> 'detector') AS detector,
               d1_private.sem_clean_text(j -> 'mode') AS mode,
               d1_private.sem_clean_text(j -> 'instrument') AS instrument,
               d1_private.sem_try_timestamptz(j -> 'acquired_at') AS acquired_at,
               CASE WHEN jsonb_typeof(j -> 'sources') = 'object' THEN j -> 'sources' ELSE '{}'::jsonb END AS sources_in,
               CASE WHEN jsonb_typeof(j -> 'flags') = 'object' THEN j -> 'flags' ELSE '{}'::jsonb END AS flags_in
          FROM x
    ), n AS (
        -- the read to merge: only when at least one field survived; a source entry is kept only for a field this read saved and is never 'manual'
        SELECT f.*,
               (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                  FROM jsonb_each(f.sources_in) e
                 WHERE jsonb_typeof(e.value) = 'string' AND e.value <> '"manual"'::jsonb
                   AND CASE e.key
                           WHEN 'kv' THEN f.kv IS NOT NULL WHEN 'spot' THEN f.spot IS NOT NULL
                           WHEN 'working_distance_mm' THEN f.working_distance_mm IS NOT NULL WHEN 'magnification' THEN f.magnification IS NOT NULL
                           WHEN 'hfw_um' THEN f.hfw_um IS NOT NULL WHEN 'pixel_size_nm' THEN f.pixel_size_nm IS NOT NULL
                           WHEN 'scale_bar_um' THEN f.scale_bar_um IS NOT NULL WHEN 'detector' THEN f.detector IS NOT NULL
                           WHEN 'mode' THEN f.mode IS NOT NULL WHEN 'instrument' THEN f.instrument IS NOT NULL
                           WHEN 'acquired_at' THEN f.acquired_at IS NOT NULL ELSE false
                       END) AS sources
          FROM f
         WHERE num_nonnulls(f.kv, f.spot, f.working_distance_mm, f.magnification, f.hfw_um, f.pixel_size_nm, f.scale_bar_um,
                            f.detector, f.mode, f.instrument, f.acquired_at) > 0
    ), old AS (
        -- the stored row, locked so a correction made at the same moment is merged, not overwritten
        SELECT s.* FROM d1_private.sem_image_settings s WHERE s.directus_files_id = p_files_id FOR UPDATE
    ), jo AS (
        SELECT n.*,
               o.kv AS o_kv,
               o.spot AS o_spot,
               o.working_distance_mm AS o_working_distance_mm,
               o.magnification AS o_magnification,
               o.hfw_um AS o_hfw_um,
               o.pixel_size_nm AS o_pixel_size_nm,
               o.scale_bar_um AS o_scale_bar_um,
               o.detector AS o_detector,
               o.mode AS o_mode,
               o.instrument AS o_instrument,
               o.acquired_at AS o_acquired_at,
               o.sources AS o_sources, o.flags AS o_flags
          FROM n LEFT JOIN old o ON true
    ), u AS (
        -- the fields this read updates: it carries a usable value and the stored one is not a person's correction
        SELECT jo.*,
               array_remove(ARRAY[
                   CASE WHEN jo.kv IS NOT NULL AND coalesce(jo.o_sources ->> 'kv', '') <> 'manual' THEN 'kv' END,
                   CASE WHEN jo.spot IS NOT NULL AND coalesce(jo.o_sources ->> 'spot', '') <> 'manual' THEN 'spot' END,
                   CASE WHEN jo.working_distance_mm IS NOT NULL AND coalesce(jo.o_sources ->> 'working_distance_mm', '') <> 'manual' THEN 'working_distance_mm' END,
                   CASE WHEN jo.magnification IS NOT NULL AND coalesce(jo.o_sources ->> 'magnification', '') <> 'manual' THEN 'magnification' END,
                   CASE WHEN jo.hfw_um IS NOT NULL AND coalesce(jo.o_sources ->> 'hfw_um', '') <> 'manual' THEN 'hfw_um' END,
                   CASE WHEN jo.pixel_size_nm IS NOT NULL AND coalesce(jo.o_sources ->> 'pixel_size_nm', '') <> 'manual' THEN 'pixel_size_nm' END,
                   CASE WHEN jo.scale_bar_um IS NOT NULL AND coalesce(jo.o_sources ->> 'scale_bar_um', '') <> 'manual' THEN 'scale_bar_um' END,
                   CASE WHEN jo.detector IS NOT NULL AND coalesce(jo.o_sources ->> 'detector', '') <> 'manual' THEN 'detector' END,
                   CASE WHEN jo.mode IS NOT NULL AND coalesce(jo.o_sources ->> 'mode', '') <> 'manual' THEN 'mode' END,
                   CASE WHEN jo.instrument IS NOT NULL AND coalesce(jo.o_sources ->> 'instrument', '') <> 'manual' THEN 'instrument' END,
                   CASE WHEN jo.acquired_at IS NOT NULL AND coalesce(jo.o_sources ->> 'acquired_at', '') <> 'manual' THEN 'acquired_at' END
               ], NULL) AS upd
          FROM jo
    ), m AS (
        SELECT
               CASE WHEN coalesce(u.o_sources ->> 'kv', '') = 'manual' THEN u.o_kv ELSE coalesce(u.kv, u.o_kv) END AS kv,
               CASE WHEN coalesce(u.o_sources ->> 'spot', '') = 'manual' THEN u.o_spot ELSE coalesce(u.spot, u.o_spot) END AS spot,
               CASE WHEN coalesce(u.o_sources ->> 'working_distance_mm', '') = 'manual' THEN u.o_working_distance_mm ELSE coalesce(u.working_distance_mm, u.o_working_distance_mm) END AS working_distance_mm,
               CASE WHEN coalesce(u.o_sources ->> 'magnification', '') = 'manual' THEN u.o_magnification ELSE coalesce(u.magnification, u.o_magnification) END AS magnification,
               CASE WHEN coalesce(u.o_sources ->> 'hfw_um', '') = 'manual' THEN u.o_hfw_um ELSE coalesce(u.hfw_um, u.o_hfw_um) END AS hfw_um,
               CASE WHEN coalesce(u.o_sources ->> 'pixel_size_nm', '') = 'manual' THEN u.o_pixel_size_nm ELSE coalesce(u.pixel_size_nm, u.o_pixel_size_nm) END AS pixel_size_nm,
               CASE WHEN coalesce(u.o_sources ->> 'scale_bar_um', '') = 'manual' THEN u.o_scale_bar_um ELSE coalesce(u.scale_bar_um, u.o_scale_bar_um) END AS scale_bar_um,
               CASE WHEN coalesce(u.o_sources ->> 'detector', '') = 'manual' THEN u.o_detector ELSE coalesce(u.detector, u.o_detector) END AS detector,
               CASE WHEN coalesce(u.o_sources ->> 'mode', '') = 'manual' THEN u.o_mode ELSE coalesce(u.mode, u.o_mode) END AS mode,
               CASE WHEN coalesce(u.o_sources ->> 'instrument', '') = 'manual' THEN u.o_instrument ELSE coalesce(u.instrument, u.o_instrument) END AS instrument,
               CASE WHEN coalesce(u.o_sources ->> 'acquired_at', '') = 'manual' THEN u.o_acquired_at ELSE coalesce(u.acquired_at, u.o_acquired_at) END AS acquired_at,
               -- sources: the stored entries of fields not updated (manual ones among them), plus this read's entries for the fields it updates
               (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(coalesce(u.o_sources, '{}'::jsonb)) e
                 WHERE e.key <> ALL (u.upd))
               || (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(u.sources) e
                    WHERE e.key = ANY (u.upd)) AS sources,
               -- flags: the stored ones except those named after an updated field, plus this read's, except those named after a manual field
               (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(coalesce(u.o_flags, '{}'::jsonb)) e
                 WHERE e.key <> ALL (u.upd))
               || (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(u.flags_in) e
                    WHERE coalesce(u.o_sources ->> e.key, '') <> 'manual') AS flags
          FROM u
    ), ins AS (
        INSERT INTO d1_private.sem_image_settings AS t
               (directus_files_id, kv, spot, working_distance_mm, magnification, hfw_um, pixel_size_nm, scale_bar_um,
                detector, mode, instrument, acquired_at, sources, flags, read_by)
        SELECT p_files_id, m.kv, m.spot, m.working_distance_mm, m.magnification, m.hfw_um, m.pixel_size_nm, m.scale_bar_um,
               m.detector, m.mode, m.instrument, m.acquired_at, m.sources, m.flags, p_read_by
          FROM m
        ON CONFLICT (directus_files_id) DO UPDATE SET
            kv = EXCLUDED.kv, spot = EXCLUDED.spot, working_distance_mm = EXCLUDED.working_distance_mm, magnification = EXCLUDED.magnification,
            hfw_um = EXCLUDED.hfw_um, pixel_size_nm = EXCLUDED.pixel_size_nm, scale_bar_um = EXCLUDED.scale_bar_um,
            detector = EXCLUDED.detector, mode = EXCLUDED.mode, instrument = EXCLUDED.instrument, acquired_at = EXCLUDED.acquired_at,
            sources = EXCLUDED.sources, flags = EXCLUDED.flags, read_by = EXCLUDED.read_by, read_at = now()
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM ins)
        OR EXISTS (SELECT 1 FROM d1_private.sem_image_settings s WHERE s.directus_files_id = p_files_id)
$fn$;
COMMENT ON FUNCTION d1_private.save_sem_settings(UUID, JSONB, TEXT) IS 'The only place d1_private.file_candidates.extracted becomes imaging settings (migration 197, spec 2026-10-16 section 3). Maps kv, spot, working_distance_mm, magnification, hfw_um, pixel_size_nm, scale_bar_um, detector, mode, instrument, acquired_at, sources and flags; drops a value of the wrong JSON type or outside its range (tested as given, then rounded to the column''s scale). MERGES into the row (ruling R12): only keys present and usable in extracted are updated; a key it does not carry keeps its stored value, sources entry and flags, and a key that is present but unusable is dropped without erasing the stored value. An updated key takes the source the read gave it (none if it gave none) and loses the flag named after it; sources are kept only for saved fields and never as manual. SKIPS every field whose stored sources entry is manual (a person''s correction) and takes no flag named after such a field. Returns whether a row exists afterwards: false when nothing usable was given and the file has no row (no row written), true otherwise (an existing row is left exactly as it is when nothing usable was given).';

-- The owner's correction.
CREATE FUNCTION d1_private.correct_sem_setting(p_files_id UUID, p_field TEXT, p_value JSONB, p_user UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE
    v_num NUMERIC;
    v_text TEXT;
    v_ts TIMESTAMPTZ;
    v_rows INTEGER;
BEGIN
    IF p_field IS NULL OR p_field NOT IN ('kv', 'spot', 'working_distance_mm', 'magnification', 'hfw_um', 'pixel_size_nm', 'scale_bar_um',
                                          'detector', 'mode', 'instrument', 'acquired_at') THEN
        RAISE EXCEPTION 'sem_image_settings.% is not a correctable field', p_field USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_user IS NULL THEN
        RAISE EXCEPTION 'a correction needs the user who made it' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_field IN ('detector', 'mode', 'instrument') THEN
        v_text := d1_private.sem_clean_text(p_value);
        IF v_text IS NULL THEN
            RAISE EXCEPTION '% is not a valid value for %', p_value, p_field USING ERRCODE = 'invalid_parameter_value';
        END IF;
    ELSIF p_field = 'acquired_at' THEN
        v_ts := d1_private.sem_try_timestamptz(p_value);
        IF v_ts IS NULL THEN
            RAISE EXCEPTION '% is not a valid value for %', p_value, p_field USING ERRCODE = 'invalid_parameter_value';
        END IF;
    ELSE
        IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION '% is not a valid value for %', p_value, p_field USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_num := d1_private.sem_clean_number(p_field, p_value);
        IF v_num IS NULL THEN
            RAISE EXCEPTION 'value % is out of range for %', p_value, p_field USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END IF;

    UPDATE d1_private.sem_image_settings s
       SET kv = CASE WHEN p_field = 'kv' THEN v_num::numeric(6, 2) ELSE s.kv END,
           spot = CASE WHEN p_field = 'spot' THEN v_num::numeric(4, 1) ELSE s.spot END,
           working_distance_mm = CASE WHEN p_field = 'working_distance_mm' THEN v_num::numeric(6, 2) ELSE s.working_distance_mm END,
           magnification = CASE WHEN p_field = 'magnification' THEN v_num::integer ELSE s.magnification END,
           hfw_um = CASE WHEN p_field = 'hfw_um' THEN v_num::numeric(10, 2) ELSE s.hfw_um END,
           pixel_size_nm = CASE WHEN p_field = 'pixel_size_nm' THEN v_num::numeric(12, 4) ELSE s.pixel_size_nm END,
           scale_bar_um = CASE WHEN p_field = 'scale_bar_um' THEN v_num::numeric(12, 3) ELSE s.scale_bar_um END,
           detector = CASE WHEN p_field = 'detector' THEN v_text ELSE s.detector END,
           mode = CASE WHEN p_field = 'mode' THEN v_text ELSE s.mode END,
           instrument = CASE WHEN p_field = 'instrument' THEN v_text ELSE s.instrument END,
           acquired_at = CASE WHEN p_field = 'acquired_at' THEN v_ts ELSE s.acquired_at END,
           sources = s.sources || jsonb_build_object(p_field, 'manual'),
           flags = s.flags - p_field,
           corrected_by = p_user,
           corrected_at = now()
     WHERE s.directus_files_id = p_files_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'no sem_image_settings row for file %', p_files_id USING ERRCODE = 'no_data_found';
    END IF;
END
$fn$;
COMMENT ON FUNCTION d1_private.correct_sem_setting(UUID, TEXT, JSONB, UUID) IS 'A person''s correction of one imaging setting (migration 197): sets the column from a JSON value (numbers inside their range, text 1 to 200 characters, a time with an offset), marks sources.<field> as manual so no re-read overwrites it, removes the flag named after the field, and records corrected_by and corrected_at. Refuses a field that is not one of the eleven settings (read_by, sources, flags and the keys among them), a value of the wrong type or outside its range, a missing user and a file with no row. The d1-inbox endpoint decides who may call it (only the file''s owner).';

-- migrate:down
DROP FUNCTION IF EXISTS d1_private.correct_sem_setting(UUID, TEXT, JSONB, UUID);
DROP FUNCTION IF EXISTS d1_private.save_sem_settings(UUID, JSONB, TEXT);
DROP FUNCTION IF EXISTS d1_private.sem_try_timestamptz(JSONB);
DROP FUNCTION IF EXISTS d1_private.sem_clean_text(JSONB);
DROP FUNCTION IF EXISTS d1_private.sem_clean_number(TEXT, JSONB);
ALTER TABLE IF EXISTS d1_private.file_candidates DROP COLUMN IF EXISTS classified_by;
DROP TABLE IF EXISTS d1_private.sem_settings_access_log;
DROP TABLE IF EXISTS d1_private.sem_image_settings;
