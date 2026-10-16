-- migrate:up
-- Trigram indexes on the file name and title, for the Ctrl K finder (docs/superpowers/specs/2026-10-16-finder-reach-and-preview-design.md).
--
-- Why: the finder now searches files through GET /files with _icontains (ILIKE '%word%') on filename_download and title. With no index that
-- is a sequential scan of all of directus_files (about 255,000 rows, most of them pointer rows of the lab share), 67 to 159 ms for a query that
-- matches little, every keystroke pause. With a trigram index the same query took 0.03 ms (measured in a rolled-back transaction on a copy of
-- live). The extension is already installed (migration 1); the statement is repeated so this file does not depend on that.
--
-- Cost: each index builds in about 1.4 s on the current table, and a plain CREATE INDEX blocks writes to directus_files while it builds (reads
-- are not blocked), so the crawler's registrations wait that long. CONCURRENTLY is not used: the migration runs in a transaction.
SET LOCAL lock_timeout = '10s';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS directus_files_filename_download_trgm ON directus_files USING gin (filename_download gin_trgm_ops);
CREATE INDEX IF NOT EXISTS directus_files_title_trgm ON directus_files USING gin (title gin_trgm_ops);

COMMENT ON INDEX directus_files_filename_download_trgm IS 'Trigram index for ILIKE / _icontains on the file name (the Ctrl K finder). migration 201.';
COMMENT ON INDEX directus_files_title_trgm IS 'Trigram index for ILIKE / _icontains on the file title (the Ctrl K finder). migration 201.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
-- The extension stays: other indexes use it.
DROP INDEX IF EXISTS directus_files_title_trgm;
DROP INDEX IF EXISTS directus_files_filename_download_trgm;
