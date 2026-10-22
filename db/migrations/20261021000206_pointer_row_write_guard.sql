-- migrate:up
-- Close the "forged pointer row" hole (ADR-0023 known limit; docs/superpowers/specs/2026-10-21-forged-pointer-rows-options.md, option 4).
--
-- A pointer row is a directus_files row with storage = 'star': it names a file on the read-only archive share through
-- metadata.archive_path, and its id is uuid5(NS, 'file:' + archive_path). The surface-scan worker trusts a row whose id matches its
-- path (plugins/surface-scan-worker/app/lib/archive.py, check_identity). Lab Members may write id, storage, filename_disk and metadata on
-- directus_files (migrations 196 and 201), so a member who knew the path of someone else's file could create such a row, which is unowned,
-- add a surface scan of it and have it rendered lab-wide.
--
-- The rule enforced here: only the archive writers (the archive indexer and the inbox crawler) create a pointer row or change what it
-- points at. A writer says so by setting the session setting d1.archive_writer = 'on' on its connection (psycopg2 option
-- `-c d1.archive_writer=on`); Directus never sets it, so nothing that goes through Directus (REST, GraphQL, Flows, an extension) can create
-- or repoint a pointer row, whatever the member field lists say. Directus, the indexer and the crawler share one Postgres role, so the
-- setting, not the role, is what tells them apart.
--
-- Guarded: an INSERT of a row with storage = 'star'; an UPDATE that gives a row storage = 'star' or changes the id, storage,
-- filename_disk or metadata.archive_path of a row that has it. Not guarded: titles, folders, descriptions, tags, the owner columns (the
-- crawler stamps them, administrators change them), other metadata keys, deleting a row, rows with any other storage.
-- Rows forged before this migration are not touched: see the detection query in docs/runbooks/inbox-crawler.md ("Forged pointer rows").

-- The trigger reads these three columns. Real Directus has them all (so this does nothing on a real database); the CI stub of
-- directus_files (migration 030) has only id, filename_download and type, so they are added there, idempotently. `down` leaves them.
ALTER TABLE directus_files ADD COLUMN IF NOT EXISTS storage VARCHAR(255);
ALTER TABLE directus_files ADD COLUMN IF NOT EXISTS filename_disk VARCHAR(255);
ALTER TABLE directus_files ADD COLUMN IF NOT EXISTS metadata JSON;

CREATE FUNCTION d1_private.trg_pointer_row_write_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
    IF COALESCE(pg_catalog.current_setting('d1.archive_writer', TRUE), '') = 'on' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.storage IS NOT DISTINCT FROM 'star' THEN
            RAISE EXCEPTION 'Only the archive indexer and the inbox crawler can register a file of the archive share (storage "star").'
                USING ERRCODE = 'insufficient_privilege',
                      HINT = 'A pointer row names a file on the share; it is made by scripts/index_archive.py or the inbox crawler, never by a user (ADR-0023).';
        END IF;
    ELSIF NEW.storage IS NOT DISTINCT FROM 'star' OR OLD.storage IS NOT DISTINCT FROM 'star' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.storage IS DISTINCT FROM OLD.storage
           OR NEW.filename_disk IS DISTINCT FROM OLD.filename_disk
           OR (NEW.metadata::jsonb ->> 'archive_path') IS DISTINCT FROM (OLD.metadata::jsonb ->> 'archive_path') THEN
            RAISE EXCEPTION 'Only the archive indexer and the inbox crawler can change what a file of the archive share points at.'
                USING ERRCODE = 'insufficient_privilege',
                      HINT = 'The id, storage, filename_disk and metadata.archive_path of a pointer row (storage "star") are written by scripts/index_archive.py and the inbox crawler only (ADR-0023).';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION d1_private.trg_pointer_row_write_guard() IS 'Trigger function (migration 206): a directus_files row of the archive share (storage "star") is created, or repointed, only inside a session that set d1.archive_writer = ''on'' (the archive indexer and the inbox crawler). Directus never sets it, so no user write can forge a pointer row.';

CREATE TRIGGER directus_files_pointer_row_guard BEFORE INSERT OR UPDATE ON directus_files
    FOR EACH ROW EXECUTE FUNCTION d1_private.trg_pointer_row_write_guard();
COMMENT ON TRIGGER directus_files_pointer_row_guard ON directus_files IS 'Only the archive indexer and the inbox crawler (d1.archive_writer = ''on'') create or repoint a storage "star" row (migration 206, ADR-0023).';

-- migrate:down
DROP TRIGGER IF EXISTS directus_files_pointer_row_guard ON directus_files;
DROP FUNCTION IF EXISTS d1_private.trg_pointer_row_write_guard();
