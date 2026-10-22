-- migrate:up
-- A Conform log can be made only from a file its creator uploaded to the Conform Logs folder (ADR-0022, "a file belongs to its
-- provenance owner"; security review of migration 208).
--
-- The finding. Migration 208 gave Lab Member a create row on conform_logs with no filter and no validation, and the field list includes
-- directus_files_id. Directus does not filter create, and a `validation` sees only the payload (it cannot follow directus_files_id to the
-- file), so any member could create a log that points at ANY file id, someone else's included. Nothing confidential leaks through that:
-- the browser reads the file through /assets and d1-report through the caller's accountability, both filtered by the directus_files read
-- rule, so an owned file stays closed and an unowned one was already readable by every member. But the log takes the file hostage:
--   * d1-conform-guard refuses every non-admin update of a file a log points at (migration 210's plan, review round 1), so the file's
--     owner can no longer rename, move or replace it;
--   * conform_logs.directus_files_id does not cascade, so the owner cannot delete their file while the log exists, cannot delete the log
--     (delete is limited to its creator), and once the creator links a run to it the log cannot be deleted at all (migration 210).
-- Only an administrator could undo it. It also breaks ADR-0022's rule that only the file's owner links it.
--
-- The fix, in three places (the hooks say it in words, this trigger is the backstop for every writer):
--   1. d1-access-guard (core/extensions/d1-access-guard, rules.json from scripts/access_rules.json): a non-admin create of a log is refused
--      unless directus_files_id is a file whose uploaded_by is the caller and whose folder is the Conform Logs folder
--      (c04f1000-0000-4000-8000-000000000001, migration 210), with the same words for a file id that does not exist. The same hook
--      refuses a non-admin update that changes directus_files.uploaded_by, which the Lab Member field list allows (narrowing it waits for
--      SEM3), so nobody can restamp another member's unowned file as theirs and then pass the rule.
--   2. d1-conform-guard: the file lock applies only to a log made by the file's own uploader, so a log that already points at someone
--      else's file (made before this migration) no longer freezes that file.
--   3. This migration: a BEFORE INSERT OR UPDATE OF directus_files_id, created_by trigger on conform_logs that refuses (insufficient_privilege)
--      a log whose file was not uploaded by its creator (created_by, which Directus stamps: special user-created) or is not in the Conform
--      Logs folder. A row with no creator (SQL, scripts, imports) is not checked, as the hooks do not check internal calls. Unlike the hook,
--      the trigger cannot tell an administrator from a member (Directus uses one database role), so it holds administrators to the rule too:
--      an administrator who really means to attach someone else's file does it by SQL, where created_by is not set.
--      A file id that does not exist is left to the foreign key.
--
-- Rows that already break the rule are not changed (the feature is a day old and is expected to have none). The up raises a NOTICE with
-- their count; to list them:
--   SELECT l.log_id, l.created_by, f.uploaded_by, f.folder FROM conform_logs l JOIN directus_files f ON f.id = l.directus_files_id
--   WHERE l.created_by IS NOT NULL AND (f.uploaded_by IS DISTINCT FROM l.created_by OR f.folder IS DISTINCT FROM 'c04f1000-0000-4000-8000-000000000001');
-- An administrator then unlinks the runs (or re-uploads the file as its owner) and deletes the log.
--
-- No permission row changes: the Lab Member create row of conform_logs stays `{}` with no validation, because neither can reach the file.
-- Directus caches permissions and schema; the hooks are read at start: restart Directus after deploying.
SET LOCAL lock_timeout = '10s';

-- The trigger reads these two columns. Real Directus has both (so this does nothing on a real database); the CI stub of directus_files
-- (migration 030) does not, so they are added there, idempotently, as migration 206 does. `down` leaves them.
ALTER TABLE directus_files ADD COLUMN IF NOT EXISTS uploaded_by UUID;
ALTER TABLE directus_files ADD COLUMN IF NOT EXISTS folder UUID;

CREATE FUNCTION conform_logs_file_owner_guard() RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_found    BOOLEAN := false;
    v_uploader UUID;
    v_folder   UUID;
BEGIN
    IF NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.directus_files_id IS NOT DISTINCT FROM OLD.directus_files_id
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
        RETURN NEW;
    END IF;
    SELECT true, f.uploaded_by, f.folder INTO v_found, v_uploader, v_folder
    FROM public.directus_files f WHERE f.id = NEW.directus_files_id;
    IF NOT coalesce(v_found, false) THEN
        RETURN NEW; -- the foreign key refuses an unknown file
    END IF;
    IF v_uploader IS DISTINCT FROM NEW.created_by OR v_folder IS DISTINCT FROM 'c04f1000-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION 'A Conform log can only be made from a file its creator uploaded to the Conform Logs folder.'
            USING ERRCODE = 'insufficient_privilege',
                  HINT = 'Upload the log yourself (STARbase does it into the Conform Logs folder); a file belongs to whoever uploaded it (ADR-0022).';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION conform_logs_file_owner_guard() IS
    'BEFORE INSERT / UPDATE OF directus_files_id, created_by on conform_logs: refuses (insufficient_privilege) a log whose file was not uploaded by the log''s creator (directus_files.uploaded_by = created_by) or is not in the Conform Logs folder (c04f1000-0000-4000-8000-000000000001). A row with no creator (SQL, scripts) is not checked; an unknown file is left to the foreign key. ADR-0022; d1-access-guard words the same rule for members first.';

CREATE TRIGGER conform_logs_file_owner_guard
    BEFORE INSERT OR UPDATE OF directus_files_id, created_by ON conform_logs
    FOR EACH ROW EXECUTE FUNCTION conform_logs_file_owner_guard();
COMMENT ON TRIGGER conform_logs_file_owner_guard ON conform_logs IS
    'Refuses a Conform log made from a file its creator did not upload to the Conform Logs folder (ADR-0022).';

COMMENT ON COLUMN conform_logs.directus_files_id IS
    'The normalised CSV in Directus Files ("Conform Logs" folder): time_s, every kept channel, then the four derived power channels. The file must have been uploaded by the log''s creator into that folder (trigger conform_logs_file_owner_guard, ADR-0022). The file is deleted only after its log row.';

-- Rows made before this migration that break the rule: counted, not changed (see the header for the query that lists them).
DO $do$
DECLARE
    v_bad INTEGER;
BEGIN
    SELECT count(*) INTO v_bad
    FROM conform_logs l JOIN directus_files f ON f.id = l.directus_files_id
    WHERE l.created_by IS NOT NULL
      AND (f.uploaded_by IS DISTINCT FROM l.created_by OR f.folder IS DISTINCT FROM 'c04f1000-0000-4000-8000-000000000001'::uuid);
    IF v_bad > 0 THEN
        RAISE NOTICE 'migration 211: % Conform log(s) point at a file their creator did not upload to the Conform Logs folder; they are kept (list them with the query in the migration header)', v_bad;
    END IF;
END
$do$;

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- The stub columns uploaded_by and folder stay (real Directus has them; another migration's test may use them), as 206 leaves its own.
DROP TRIGGER IF EXISTS conform_logs_file_owner_guard ON conform_logs;
DROP FUNCTION IF EXISTS conform_logs_file_owner_guard();

COMMENT ON COLUMN conform_logs.directus_files_id IS 'The normalised CSV in Directus Files ("Conform Logs" folder): time_s, every kept channel, then the four derived power channels. The file is deleted only after its log row.';
