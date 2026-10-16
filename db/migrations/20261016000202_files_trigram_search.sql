-- migrate:up
-- Trigram indexes on the file name and title, for the Ctrl K finder (docs/superpowers/specs/2026-10-16-finder-reach-and-preview-design.md).
--
-- Why: the finder searches files through GET /files with _icontains on filename_download and title. Directus 11.17 turns that into
-- LOWER(column) LIKE '%word%', so the index must be on lower(column): a trigram index on the bare column is NOT used for that form (seq scan,
-- 78 ms). Without any index it is a sequential scan of all of directus_files (about 255,000 rows, most of them pointer rows of the lab share),
-- 67 to 159 ms for a query that matches little, at every keystroke pause. With these expression indexes the same LOWER(..) LIKE form took about
-- 0.05 ms (measured on a copy of live, after ANALYZE). The extension is already installed (migration 1); the statement is repeated so this file
-- does not depend on that.
--
-- Limits: pg_trgm needs a word of at least 3 characters to have a trigram, so a 1 or 2 character word still scans; the finder therefore asks for
-- files only when its longest word has 3 characters or more. A word that matches a large share of the files (e.g. "tif") is answered by a seq
-- scan that stops at the first rows, which is fast anyway.
--
-- Cost: each index builds in about 1.4 s on the current table, and a plain CREATE INDEX blocks writes to directus_files while it builds (reads
-- are not blocked), so the crawler's registrations wait that long. CONCURRENTLY is not used: the migration runs in a transaction. ANALYZE makes
-- the planner know the new expressions at once instead of waiting for autovacuum (without it a fresh expression index is not chosen).
SET LOCAL lock_timeout = '10s';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS directus_files_filename_download_lower_trgm ON directus_files USING gin (lower(filename_download) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS directus_files_title_lower_trgm ON directus_files USING gin (lower(title) gin_trgm_ops);

COMMENT ON INDEX directus_files_filename_download_lower_trgm IS 'Trigram index on lower(filename_download), for the LOWER(..) LIKE that Directus builds for _icontains (the Ctrl K finder). migration 201.';
COMMENT ON INDEX directus_files_title_lower_trgm IS 'Trigram index on lower(title), for the LOWER(..) LIKE that Directus builds for _icontains (the Ctrl K finder). migration 201.';

ANALYZE directus_files;

-- migrate:down
SET LOCAL lock_timeout = '10s';
-- The extension stays: it was installed by migration 1, not by this one.
DROP INDEX IF EXISTS directus_files_title_lower_trgm;
DROP INDEX IF EXISTS directus_files_filename_download_lower_trgm;
