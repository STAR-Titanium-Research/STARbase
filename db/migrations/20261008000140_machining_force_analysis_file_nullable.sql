-- migrate:up
-- Issue #190. The Force App's save dialog links an uploaded capture to its operation by POSTing
-- a machining_force_analysis row. A long cut (over MAT_MAX_BYTES in apps/force-app/backend/app/
-- finalize.py, about 6 minutes at 51.2 kHz x 10 columns) has no capture.mat, only the decimated
-- live cache, so the row goes in with directus_files_id = NULL. The column was NOT NULL (it was
-- written for the archive crawler, where every row starts from a .mat), so Directus answered
-- 400 "Value can't be null" and the whole save looked failed after both uploads had finished.
--
-- Dropping NOT NULL keeps the UNIQUE constraint (several NULLs are allowed, one row per real
-- file still holds) and the FK. Such rows are status 'done' and carry live_cache_file + series;
-- scripts/force_orchestrator.py never claims them (discover() only enqueues from .mat files and
-- resets rows that join a file) and refuses to process one if it is set to pending by hand.

ALTER TABLE machining_force_analysis
    ALTER COLUMN directus_files_id DROP NOT NULL;

COMMENT ON COLUMN machining_force_analysis.directus_files_id IS
    'Source .mat file (directus_files). NULL for a Force App cut over the recorder''s .mat size limit: the row then has only live_cache_file and series, and the archive crawler ignores it.';

-- migrate:down
-- Refuse rather than delete or invent a file: the NULL rows are real uploaded cuts.
DO $$
DECLARE
    n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM machining_force_analysis WHERE directus_files_id IS NULL;
    IF n > 0 THEN
        RAISE EXCEPTION 'cannot restore NOT NULL on machining_force_analysis.directus_files_id: % row(s) have no .mat file (Force App cuts over the .mat size limit). Delete or link them first.', n;
    END IF;
END
$$;

ALTER TABLE machining_force_analysis
    ALTER COLUMN directus_files_id SET NOT NULL;

COMMENT ON COLUMN machining_force_analysis.directus_files_id IS NULL;
