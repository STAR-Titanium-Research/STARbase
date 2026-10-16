-- migrate:up
-- Thumbnails and a full view for the Inbox (stream A of docs/superpowers/plans/2026-10-16-inbox-thumbnails.md; spec
-- docs/superpowers/specs/2026-10-15-found-files-inbox-design.md section 14; decision: ADR-0020, which still holds).
--
-- Why: the Inbox shows a file as an icon and a name, so people cannot tell one SEM image from another without opening it on the share.
-- Directus declares no storage for the share, so its asset route cannot serve a pointer row, and serving share bytes is out of scope.
-- Instead the inbox crawler (which already holds the image bytes in memory when it registers a file, and reads older ones through
-- fs_readonly in a throttled backfill) writes two small DERIVED pictures into this table, and the d1-inbox endpoint serves them
-- (GET /d1-inbox/files/:candidate_id/thumb and /preview) to whoever may see the candidate. The share is still only read; the pictures are
-- reduced copies, replaceable from the share at any time, never the original.
--
-- The table is in d1_private (migration 141): outside the Directus schema scan, so it is never a collection and its bytes are never readable
-- through Directus's REST API; not in v_schema_dictionary; not granted to d1_llm_readonly; no OCC or audit triggers (derived, replaceable).
-- Rows go with their candidate (ON DELETE CASCADE); the crawler also deletes the row when it marks a file gone.
--
-- Key and foreign key follow migration 193's naming: file_candidates_pkey (candidate_id) is what file_thumbnails_candidate_id_fkey references.
CREATE TABLE d1_private.file_thumbnails (
    candidate_id   UUID        NOT NULL,
    thumb          BYTEA       NOT NULL,
    preview        BYTEA       NOT NULL,
    thumb_width    INTEGER,
    thumb_height   INTEGER,
    preview_width  INTEGER,
    preview_height INTEGER,
    source_size    BIGINT      NOT NULL,
    source_mtime   TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT file_thumbnails_pkey PRIMARY KEY (candidate_id),
    CONSTRAINT file_thumbnails_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES d1_private.file_candidates (candidate_id) ON DELETE CASCADE,
    CONSTRAINT file_thumbnails_thumb_width_check CHECK (thumb_width IS NULL OR thumb_width > 0),
    CONSTRAINT file_thumbnails_thumb_height_check CHECK (thumb_height IS NULL OR thumb_height > 0),
    CONSTRAINT file_thumbnails_preview_width_check CHECK (preview_width IS NULL OR preview_width > 0),
    CONSTRAINT file_thumbnails_preview_height_check CHECK (preview_height IS NULL OR preview_height > 0),
    CONSTRAINT file_thumbnails_source_size_check CHECK (source_size >= 0)
);

COMMENT ON TABLE d1_private.file_thumbnails IS 'The two small derived JPEG pictures of an image or SEM image candidate (a thumbnail of about 320 px for the Inbox row and a preview of about 1600 px for the full view), migration 198; spec 2026-10-15-found-files-inbox-design.md section 14. Written by the inbox crawler (at registration from the bytes it already holds, and by a throttled backfill for older files); read only by the d1-inbox endpoint, which serves them to whoever may see the candidate. d1_private is outside the Directus schema scan, so the bytes are never readable through its REST API. Derived and replaceable from the share (a reduced copy, never the original): no audit or OCC triggers. Rows go with their candidate (ON DELETE CASCADE) and are deleted when the file is marked gone.';
COMMENT ON COLUMN d1_private.file_thumbnails.candidate_id IS 'The found file this picture belongs to (primary key, one row per candidate). Deleted with the candidate (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.file_thumbnails.thumb IS 'JPEG bytes of the row thumbnail: about 320 px on the long side, usually 10 to 25 KB. Served as image/jpeg by GET /d1-inbox/files/:candidate_id/thumb.';
COMMENT ON COLUMN d1_private.file_thumbnails.preview IS 'JPEG bytes of the full-view preview: about 1600 px on the long side, usually 150 to 400 KB. A reduced copy, never the original. Served as image/jpeg by GET /d1-inbox/files/:candidate_id/preview.';
COMMENT ON COLUMN d1_private.file_thumbnails.thumb_width IS 'Width of thumb in pixels; NULL when the writer did not record it. Greater than 0.';
COMMENT ON COLUMN d1_private.file_thumbnails.thumb_height IS 'Height of thumb in pixels; NULL when the writer did not record it. Greater than 0.';
COMMENT ON COLUMN d1_private.file_thumbnails.preview_width IS 'Width of preview in pixels; NULL when the writer did not record it. Greater than 0.';
COMMENT ON COLUMN d1_private.file_thumbnails.preview_height IS 'Height of preview in pixels; NULL when the writer did not record it. Greater than 0.';
COMMENT ON COLUMN d1_private.file_thumbnails.source_size IS 'size_bytes of the file when the pictures were made. The crawler backfills a candidate whose size or modification time differs from this and source_mtime (the file changed on the share).';
COMMENT ON COLUMN d1_private.file_thumbnails.source_mtime IS 'The file''s modification time on the share when the pictures were made; see source_size.';
COMMENT ON COLUMN d1_private.file_thumbnails.created_at IS 'When the pictures were made (default now()).';
COMMENT ON CONSTRAINT file_thumbnails_pkey ON d1_private.file_thumbnails IS 'One picture pair per candidate.';
COMMENT ON CONSTRAINT file_thumbnails_candidate_id_fkey ON d1_private.file_thumbnails IS 'The pictures go with their candidate. The primary key doubles as the index of this foreign key.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
-- The pictures are derived and replaceable: the crawler makes them again from the share once the table is back.
DROP TABLE IF EXISTS d1_private.file_thumbnails;
