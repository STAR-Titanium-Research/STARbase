-- migrate:up
-- Conform runs, review round 1 (docs/superpowers/plans/2026-10-21-conform-runs.md, "Review round 1 (Opus): fixes", stream F1;
-- migrations 207 to 209 are on a pushed branch but not merged, and this one still goes in on top of them rather than editing them).
-- Two Opus reviews of the merged branch found these gaps, and the maintainer decided that logs are readable by every lab member
-- while run records stay private. What this does:
--
--   1. conform_logs.source_sha256: the lowercase hex SHA-256 of the uploaded file's raw bytes, NOT NULL and UNIQUE, so the same
--      file cannot be uploaded twice (the browser looks the hash up first and offers to link the existing log; Directus turns the
--      unique violation into RECORD_NOT_UNIQUE on source_sha256). The table is new, so there is nothing to back-fill; a row that
--      already exists on a database that ran 208 gets the SHA-256 of its own log_id as a placeholder (hash-shaped, unique, and it
--      matches no real file, so such an old log is simply never found by the duplicate check).
--   2. conform_logs.run_windows: JSONB [{operation_id, start, end}], sorted by start, only runs that have both window ends,
--      start and end as UTC ISO-8601 with milliseconds. Kept by an AFTER trigger on conform_run_data (insert, update of the
--      operation, log or window, delete), under the same per-log advisory lock the window guard takes. The browser draws the
--      bands of a log from it without reading other people's run records: logs are lab-wide, runs are private, so a run the
--      caller cannot read is shown as "Other run". Back-filled here from the existing runs.
--   3. A BEFORE DELETE trigger on conform_logs refuses to delete a log that a run still uses (restrict_violation), so the
--      ON DELETE SET NULL of conform_run_data.log_id is never reached: a run keeps its log until someone unlinks it. The Directus
--      hook d1-conform-guard says the same thing in words before the database does (Directus turns an unknown database error into
--      a 500 "An unexpected error occurred" for a non-admin).
--   4. Access (scripts/access_rules.json, `gen_access_rules.py --values --only conform_logs,directus_folders`, `--viewer-values`):
--        conform_logs read: no filter, for Lab Member and Lab Viewer (208 limited it to the uploader and to readers of a linked run);
--        conform_logs create: the field list gains source_sha256 (run_windows is kept by the trigger, never written);
--        conform_run_data create: still `{}` in the policy, because Directus does not filter create; the new `guards.conform_run_data`
--          rule of d1-access-guard refuses a create or a repoint unless the caller passes the operation's update rule (and the log
--          exists). Update and delete already need that rule (208).
--   5. The "Conform Logs" folder of Directus Files, fixed id c04f1000-0000-4000-8000-000000000001, seeded here (guarded by
--      to_regclass: CI has no directus_folders table), and one read row on directus_folders for Lab Member and Lab Viewer that
--      shows only that folder. The browser uploads into it by id.
--   6. conform_logs gets collection sort 13 under manufacturing_methods (it shared 11 with fast_recipes).
--   7. Migration 207's adoption gap: its down turns Conform operations back into `deformation` and keeps method CF (filed under
--      `deformation`) when an operation still uses it; its up only re-files the method. This migration, which runs after 207 on a
--      re-up, sets operations whose method is CF and whose category is `deformation` to `conform`, and their lineage edges
--      (output sample from input sample) back to `extruded_from`. Only those, so it also covers data that predates 207.
--
-- The down section restores the state of 208/209: the permission rows, the sort, the comment on conform_run_data.log_id, the
-- collection's field rows, and drops the new columns, triggers and functions. It does not undo the adoption in 7 (207's down maps
-- every conform operation back to deformation) and it keeps the folder when a file is filed in it (deleting the folder would
-- null the files' folder); an up that runs again keeps that folder.
-- Directus caches permissions and schema: restart Directus after applying.
SET LOCAL lock_timeout = '10s';

-- 1. The file fingerprint.
ALTER TABLE conform_logs ADD COLUMN source_sha256 TEXT;
UPDATE conform_logs SET source_sha256 = encode(sha256(convert_to(log_id::text, 'UTF8')), 'hex') WHERE source_sha256 IS NULL;
ALTER TABLE conform_logs ALTER COLUMN source_sha256 SET NOT NULL;
ALTER TABLE conform_logs
    ADD CONSTRAINT conform_logs_source_sha256_key UNIQUE (source_sha256),
    ADD CONSTRAINT conform_logs_source_sha256_check CHECK (source_sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN conform_logs.source_sha256 IS
    'Lowercase hex SHA-256 of the uploaded file''s raw bytes, computed in the browser. Unique: the same file is never uploaded twice (the browser looks the hash up first and offers to link the existing log).';
COMMENT ON CONSTRAINT conform_logs_source_sha256_key ON conform_logs IS
    'One log per uploaded file (the unique violation reaches the browser as RECORD_NOT_UNIQUE on source_sha256).';
COMMENT ON CONSTRAINT conform_logs_source_sha256_check ON conform_logs IS
    'A SHA-256 written as 64 lowercase hex digits.';

-- 2. The run windows of a log, kept by a trigger on conform_run_data.
ALTER TABLE conform_logs ADD COLUMN run_windows JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN conform_logs.run_windows IS
    'The run windows on this log, a JSON array of {operation_id, start, end} sorted by start (UTC ISO-8601 with milliseconds), only for runs that have both window ends. Kept by the sync_run_windows trigger of conform_run_data; never written by a member. Logs are readable by every lab member and run records are private, so the bands of a log are drawn from this and a run the caller cannot read is shown as "Other run".';

CREATE FUNCTION conform_logs_refresh_run_windows(p_log_id UUID) RETURNS VOID
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_windows JSONB;
BEGIN
    IF p_log_id IS NULL THEN
        RETURN;
    END IF;
    -- The lock of the window guard (migration 208): a delete of a run, which the guard does not see, cannot overwrite the list of a
    -- transaction that is adding another window to the same log. The next statement takes a new snapshot after the lock is granted.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('conform_run_data_window:' || p_log_id::text, 0));
    SELECT coalesce(pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                   'operation_id', r.operation_id,
                   'start', pg_catalog.to_char(r.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'end', pg_catalog.to_char(r.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
               ORDER BY r.window_start, r.operation_id), '[]'::jsonb)
    INTO v_windows
    FROM public.conform_run_data r
    WHERE r.log_id = p_log_id AND r.window_start IS NOT NULL AND r.window_end IS NOT NULL;
    UPDATE public.conform_logs SET run_windows = v_windows
    WHERE log_id = p_log_id AND run_windows IS DISTINCT FROM v_windows;
END;
$$;

COMMENT ON FUNCTION conform_logs_refresh_run_windows(UUID) IS
    'Recomputes conform_logs.run_windows for one log from its conform_run_data rows (only runs with both window ends, sorted by start), under the per-log advisory lock of the window guard. Called by the sync_run_windows trigger.';

CREATE FUNCTION conform_run_data_sync_run_windows() RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.operation_id IS NOT DISTINCT FROM NEW.operation_id
       AND OLD.log_id IS NOT DISTINCT FROM NEW.log_id
       AND OLD.window_start IS NOT DISTINCT FROM NEW.window_start
       AND OLD.window_end IS NOT DISTINCT FROM NEW.window_end THEN
        RETURN NULL;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM public.conform_logs_refresh_run_windows(OLD.log_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.log_id IS DISTINCT FROM OLD.log_id) THEN
        PERFORM public.conform_logs_refresh_run_windows(NEW.log_id);
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION conform_run_data_sync_run_windows() IS
    'AFTER INSERT / UPDATE / DELETE on conform_run_data: refreshes conform_logs.run_windows of the log the run left and of the log it joined. An update that changes none of operation_id, log_id and the window does nothing.';

CREATE TRIGGER sync_run_windows
    AFTER INSERT OR UPDATE OF operation_id, log_id, window_start, window_end OR DELETE ON conform_run_data
    FOR EACH ROW EXECUTE FUNCTION conform_run_data_sync_run_windows();
COMMENT ON TRIGGER sync_run_windows ON conform_run_data IS
    'Keeps conform_logs.run_windows equal to the run windows of the log.';

-- back-fill from the runs that exist (none, on a database that has only just had 208)
SELECT conform_logs_refresh_run_windows(log_id) FROM conform_logs;

-- 3. A log a run still uses cannot be deleted.
CREATE FUNCTION conform_logs_refuse_delete_in_use() RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.conform_run_data r WHERE r.log_id = OLD.log_id) THEN
        RAISE EXCEPTION 'conform log % is still used by a run: unlink it from the run first', OLD.log_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

COMMENT ON FUNCTION conform_logs_refuse_delete_in_use() IS
    'BEFORE DELETE on conform_logs: refuses (restrict_violation) a log that some conform_run_data row still uses, so the ON DELETE SET NULL of conform_run_data.log_id is never reached. The d1-conform-guard hook words the same refusal for people.';

CREATE TRIGGER refuse_delete_in_use
    BEFORE DELETE ON conform_logs
    FOR EACH ROW EXECUTE FUNCTION conform_logs_refuse_delete_in_use();
COMMENT ON TRIGGER refuse_delete_in_use ON conform_logs IS
    'Refuses to delete a log that a Conform run still uses.';

COMMENT ON COLUMN conform_run_data.log_id IS
    'The Conform log this run is a window of; NULL until a log is linked. A log that a run still uses cannot be deleted (unlink it first), so this is never set to NULL by a log delete.';

-- 4. Directus metadata of the two new columns, and the collection's place in the tree.
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width,
       v.translations::json, v.note
FROM (VALUES
    ('conform_logs', 'source_sha256', NULL, 'input', NULL, 'raw', NULL, true, false, 9, 'full', NULL, NULL),
    ('conform_logs', 'run_windows', 'cast-json', 'input-code', NULL, 'raw', NULL, true, true, 23, 'full', NULL, NULL)
) v (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

UPDATE directus_collections SET sort = 13 WHERE collection = 'conform_logs' AND "group" = 'manufacturing_methods';

-- 5. Access. Snapshot of `gen_access_rules.py --values --only conform_logs,directus_folders` and `--viewer-values` on 2026-10-22.
-- conform_logs: the rows 208 wrote are changed in place (Lab Member create and read; Lab Viewer read).
UPDATE directus_permissions
SET permissions = '{}'::json
WHERE policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003')
  AND collection = 'conform_logs' AND action = 'read';
UPDATE directus_permissions
SET fields = 'log_id,directus_files_id,equipment_id,source_filename,source_sha256,log_start,log_end,n_rows,duration_s,series,totals,constants'
WHERE policy = '20000002-0000-0000-0000-000000000002' AND collection = 'conform_logs' AND action = 'create';

-- the folder row, for both policies
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT 'directus_folders', 'read', '{"id":{"_eq":"c04f1000-0000-4000-8000-000000000001"}}'::json, '{}'::json, NULL, '*', p.policy
FROM (VALUES ('20000002-0000-0000-0000-000000000002'::uuid), ('20000002-0000-0000-0000-000000000003'::uuid)) AS p (policy)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions d
    WHERE d.policy = p.policy AND d.collection = 'directus_folders' AND d.action = 'read'
);

-- 5b. The folder. CI has only the stub tables, so no directus_folders there.
DO $do$
BEGIN
    IF to_regclass('public.directus_folders') IS NOT NULL THEN
        INSERT INTO directus_folders (id, name, parent)
        VALUES ('c04f1000-0000-4000-8000-000000000001', 'Conform Logs', NULL)
        ON CONFLICT (id) DO NOTHING;
    END IF;
END
$do$;

-- 7. Migration 207's adoption gap: Conform operations that its down turned back into deformation (method CF kept under
-- deformation, then re-filed by its up), and any CF operation that predates 207.
UPDATE manufacturing_operations o
SET process_category = 'conform'
FROM manufacturing_methods m
WHERE m.method_id = o.method_id AND m.method_code = 'CF' AND m.process_category = 'conform'
  AND o.process_category = 'deformation';

UPDATE sample_genealogy g
SET relationship_type = 'extruded_from'
FROM manufacturing_operations o
WHERE o.process_category = 'conform' AND o.sample_id IS NOT NULL AND o.output_sample_id IS NOT NULL
  AND g.parent_sample_id = o.sample_id AND g.child_sample_id = o.output_sample_id
  AND g.relationship_type = 'derived_from';

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- The adoption of Conform operations (7 above) is not undone: migration 207's down maps every conform operation back to
-- deformation, and nothing here can tell the adopted ones from the rest.

-- 6, 5. Access and the folder as 208 left them.
DELETE FROM directus_permissions
WHERE collection = 'directus_folders' AND action = 'read'
  AND policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003');

DO $do$
DECLARE
    v_used BOOLEAN := false;
BEGIN
    IF to_regclass('public.directus_folders') IS NOT NULL THEN
        -- a folder with files in it stays (deleting it would take the files out of it); directus_files.folder is a real
        -- column in Directus and absent from the CI stub
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'directus_files' AND column_name = 'folder') THEN
            EXECUTE 'SELECT EXISTS (SELECT 1 FROM directus_files WHERE folder = $1)' INTO v_used USING 'c04f1000-0000-4000-8000-000000000001'::uuid;
        END IF;
        IF NOT v_used THEN
            DELETE FROM directus_folders WHERE id = 'c04f1000-0000-4000-8000-000000000001';
        END IF;
    END IF;
END
$do$;

UPDATE directus_permissions
SET permissions = '{"_or":[{"created_by":{"_eq":"$CURRENT_USER"}},{"runs":{"_some":{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}'::json
WHERE policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003')
  AND collection = 'conform_logs' AND action = 'read';
UPDATE directus_permissions
SET fields = 'log_id,directus_files_id,equipment_id,source_filename,log_start,log_end,n_rows,duration_s,series,totals,constants'
WHERE policy = '20000002-0000-0000-0000-000000000002' AND collection = 'conform_logs' AND action = 'create';

UPDATE directus_collections SET sort = 11 WHERE collection = 'conform_logs' AND "group" = 'manufacturing_methods';
DELETE FROM directus_fields WHERE collection = 'conform_logs' AND field IN ('source_sha256', 'run_windows');

-- 3, 2, 1. The triggers and functions, then the columns (the constraints go with source_sha256).
DROP TRIGGER IF EXISTS refuse_delete_in_use ON conform_logs;
DROP FUNCTION IF EXISTS conform_logs_refuse_delete_in_use();
DROP TRIGGER IF EXISTS sync_run_windows ON conform_run_data;
DROP FUNCTION IF EXISTS conform_run_data_sync_run_windows();
DROP FUNCTION IF EXISTS conform_logs_refresh_run_windows(UUID);

COMMENT ON COLUMN conform_run_data.log_id IS 'The Conform log this run is a window of; NULL until a log is linked (or after the log was deleted).';

ALTER TABLE conform_logs DROP COLUMN IF EXISTS run_windows;
ALTER TABLE conform_logs DROP COLUMN IF EXISTS source_sha256;
