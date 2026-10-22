-- migrate:up
-- Saved measurements of an inbox picture (the view box's Measure tool, docs/superpowers/specs/2026-10-20-inbox-file-viewer-design.md decision 6).
--
-- Why: Measure draws one line, circle or polygon on the stored preview and forgets it when the person leaves the page. A person measuring a
-- feature across a series of images wants to keep each shape, name it ("grain A"), see them all in a list, copy the numbers into a spreadsheet and
-- find them again next time. This table keeps them, one row per shape, per found file.
--
-- UNIT-FREE: a row stores the shape's corners in pixels of the ORIGINAL image (the file's own pixel grid, whatever size the preview is drawn at), never
-- micrometres. The micrometres and square micrometres are worked out when a shape is shown, from the file's pixel size (extracted.pixel_size_nm), so
-- the points are in original pixels, so they follow the file's scale: a corrected pixel size or a better scale re-measures every saved shape. `points` is a JSON array of {"x": n, "y": n}
-- objects: a line has its two ends, a circle its centre and then one point on its rim, a polygon its corners in the order they were clicked (3 to 200;
-- closed implicitly). The shape of each element (finite, non-negative numbers) is checked by the d1-inbox endpoint, which is the only writer; the
-- table checks what a CHECK can say cheaply (an array of the right length for the kind).
--
-- Like the other inbox tables (migrations 193, 198, 199) it is in d1_private: outside the Directus schema scan (never a collection, so Directus's
-- REST cannot read or write it), not in v_schema_dictionary, not granted to d1_llm_readonly, no audit or OCC triggers (personal working notes, not
-- lab records). People reach it only through the d1-inbox endpoint (GET, POST /files/:id/measurements, PATCH, DELETE /files/:id/measurements/:id),
-- which lets whoever can SEE the file read them and its owner (the person, or an active member of the owner team) or the row's author change them.
-- The write guard of migration 206 (d1.archive_writer) protects directus_files pointer rows; this table is not one, so it does not apply.
--
-- A measurement belongs to the found file (file_candidates.candidate_id) it was made on and goes with it (ON DELETE CASCADE). created_by is the Directus
-- user who saved it (ON DELETE SET NULL: the measurement outlives the login, as decided_by does in migration 193).
SET LOCAL lock_timeout = '10s';

CREATE TABLE d1_private.inbox_measurements (
    measurement_id UUID        NOT NULL DEFAULT gen_random_uuid(),
    candidate_id   UUID        NOT NULL,
    kind           TEXT        NOT NULL,
    points         JSONB       NOT NULL,
    label          TEXT        NOT NULL DEFAULT '',
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT inbox_measurements_pkey PRIMARY KEY (measurement_id),
    CONSTRAINT inbox_measurements_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES d1_private.file_candidates (candidate_id) ON DELETE CASCADE,
    CONSTRAINT inbox_measurements_created_by_fkey FOREIGN KEY (created_by) REFERENCES directus_users (id) ON DELETE SET NULL,
    CONSTRAINT inbox_measurements_kind_check CHECK (kind IN ('line', 'circle', 'polygon')),
    CONSTRAINT inbox_measurements_points_check CHECK (
        CASE
            WHEN jsonb_typeof(points) <> 'array' THEN false -- (a CASE, not AND: AND does not promise to stop before jsonb_array_length fails on a non-array)
            WHEN kind = 'polygon' THEN jsonb_array_length(points) BETWEEN 3 AND 200
            ELSE jsonb_array_length(points) = 2
        END
    ),
    CONSTRAINT inbox_measurements_label_check CHECK (char_length(label) <= 120)
);
-- A file's measurements are read together, oldest first (the list numbers them 1, 2, 3 in that order).
CREATE INDEX idx_inbox_measurements_candidate ON d1_private.inbox_measurements (candidate_id, created_at, measurement_id);
CREATE INDEX idx_inbox_measurements_created_by ON d1_private.inbox_measurements (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE d1_private.inbox_measurements IS 'Saved measurements (a line, a circle or a polygon) a person made on the preview of a found file in the Inbox view box, migration 211; spec 2026-10-20-inbox-file-viewer-design.md decision 6. One row per shape, per found file. Unit-free: the corners are in pixels of the ORIGINAL image and the micrometres are worked out when shown, from the file''s pixel size. Written only by the d1-inbox endpoint; readable by whoever can see the file, changeable by its owner (the person or an active member of the owner team) and by the row''s author. In d1_private, so never a Directus collection; no audit or OCC triggers (personal working notes). Rows go with their found file (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_measurements.measurement_id IS 'Surrogate key of the measurement.';
COMMENT ON COLUMN d1_private.inbox_measurements.candidate_id IS 'The found file (d1_private.file_candidates) the shape was drawn on. Deleted with the candidate (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_measurements.kind IS 'What the shape is: line, circle or polygon (inbox_measurements_kind_check).';
COMMENT ON COLUMN d1_private.inbox_measurements.points IS 'The shape''s corners as a JSON array of {"x": number, "y": number}, in pixels of the original image (not the preview, and not micrometres). A line: its two ends. A circle: the centre, then one point on its rim. A polygon: 3 to 200 corners in the order they were clicked, closed implicitly. The endpoint checks every element is a finite, non-negative pair of numbers.';
COMMENT ON COLUMN d1_private.inbox_measurements.label IS 'The person''s name for the shape ("grain A"); empty for none (the list then says Line, Circle or Polygon). At most 120 characters.';
COMMENT ON COLUMN d1_private.inbox_measurements.created_by IS 'The Directus user who saved the measurement; NULL once that user is deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN d1_private.inbox_measurements.created_at IS 'When the measurement was saved; the list is ordered by it and numbers the shapes in that order.';
COMMENT ON INDEX d1_private.inbox_measurements_pkey IS 'One row per measurement.';
COMMENT ON INDEX d1_private.idx_inbox_measurements_candidate IS 'The measurements of one found file, oldest first (the list read, and the cascade when the candidate is deleted).';
COMMENT ON INDEX d1_private.idx_inbox_measurements_created_by IS 'Measurements saved by one Directus user (the foreign key). Partial: only rows whose user still exists.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
-- The measurements go with the table: they are a person's working notes and nothing else refers to them. The found files stay.
DROP TABLE IF EXISTS d1_private.inbox_measurements;
