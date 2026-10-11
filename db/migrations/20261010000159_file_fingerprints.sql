-- migrate:up
-- File identity (stream T0e, spec docs/superpowers/specs/2026-10-10-record-codes-design.md §7).
--
-- Why: codes now follow their fields, and file names on the share keep the code they had at capture
-- time, so a file needs an identity of its own. content_sha256 covers the whole file; data_sha256
-- (.mat only) covers the decoded force array, so a metadata-only edit (the future .mat metadata
-- migration) keeps it. Filled by scripts/file_fingerprints.py, which runs on the host that can read
-- the share; the database only stores the result.
--
-- A fingerprint is derived data (it can be recomputed from the file at any time), so there is no
-- audit trigger and no OCC column.
SET LOCAL lock_timeout = '10s';

CREATE TABLE file_fingerprints (
    directus_files_id UUID PRIMARY KEY REFERENCES directus_files (id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'error', 'missing')),
    content_sha256    TEXT CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    data_sha256       TEXT CHECK (data_sha256 ~ '^[0-9a-f]{64}$'),
    data_variable     TEXT CHECK (data_variable IN ('data', 'DATA')),
    data_rows         BIGINT CHECK (data_rows >= 0),
    data_cols         BIGINT CHECK (data_cols >= 0),
    size_bytes        BIGINT CHECK (size_bytes >= 0),
    source_mtime      TIMESTAMPTZ,
    error_message     TEXT,
    hashed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT file_fingerprints_done_has_hash CHECK (status <> 'done' OR content_sha256 IS NOT NULL)
);

CREATE INDEX file_fingerprints_content_idx ON file_fingerprints (content_sha256);
CREATE INDEX file_fingerprints_data_idx ON file_fingerprints (data_sha256) WHERE data_sha256 IS NOT NULL;

COMMENT ON TABLE file_fingerprints IS
    'Content hashes of Directus files, one row per file (T0e). Derived data, recomputable from the file: written only by scripts/file_fingerprints.py, which reads the share; no audit trigger. Gives a file an identity that survives renames, copies and a metadata-only edit of a .mat file. Rows go with the file (ON DELETE CASCADE).';
COMMENT ON COLUMN file_fingerprints.directus_files_id IS 'The file (directus_files.id) this fingerprint belongs to. One fingerprint per file; deleted with the file.';
COMMENT ON COLUMN file_fingerprints.status IS 'done: the file was read and content_sha256 is set. error: the file was found but could not be (fully) read or decoded, see error_message (content_sha256 may still be set if the bytes were read). missing: the file was not on the share, so there is nothing to hash.';
COMMENT ON COLUMN file_fingerprints.content_sha256 IS 'SHA-256 (64 lower-case hex characters) of the whole file, byte for byte as stored on the share. Required when status is done.';
COMMENT ON COLUMN file_fingerprints.data_sha256 IS 'Force files (.mat) only, else NULL: the SHA-256 (64 lower-case hex characters) of the decoded force array, not of the bytes on disk, so a metadata-only edit of the file keeps it. Taken over the array''s MATLAB shape as two little-endian uint64 values (rows, then cols), followed, for each column in order, by the 32-byte SHA-256 digest of that column''s values as little-endian float64, top to bottom (each column is hashed on its own, so a chunked file can be read in one pass). The variable read is data when the file has it, otherwise DATA (see data_variable).';
COMMENT ON COLUMN file_fingerprints.data_variable IS 'Which .mat variable data_sha256 was taken from: data when the file has one, otherwise DATA. NULL when there is no data_sha256.';
COMMENT ON COLUMN file_fingerprints.data_rows IS 'Rows of the array behind data_sha256 (the first of the two shape values hashed). NULL when there is no data_sha256.';
COMMENT ON COLUMN file_fingerprints.data_cols IS 'Columns of the array behind data_sha256 (the second of the two shape values hashed). NULL when there is no data_sha256.';
COMMENT ON COLUMN file_fingerprints.size_bytes IS 'The directus_files.filesize the hash was taken against. With source_mtime it is the staleness key: when either no longer matches directus_files, the fingerprint is out of date and the file is hashed again.';
COMMENT ON COLUMN file_fingerprints.source_mtime IS 'The file''s modification time the hash was taken against: the share mtime from directus_files.metadata.modified, else directus_files.modified_on. With size_bytes it is the staleness key.';
COMMENT ON COLUMN file_fingerprints.error_message IS 'Why the file could not be (fully) hashed (status error or missing); NULL when status is done and nothing went wrong.';
COMMENT ON COLUMN file_fingerprints.hashed_at IS 'When this row was last computed.';
COMMENT ON INDEX file_fingerprints_content_idx IS 'Finds the file(s) with a given whole-file hash: duplicate and copy detection.';
COMMENT ON INDEX file_fingerprints_data_idx IS 'Finds the force file(s) with a given decoded-array hash, so a file whose metadata was rewritten is still recognised as the same data. Partial: only rows that have a data_sha256.';

-- migrate:down
DROP TABLE IF EXISTS file_fingerprints;
