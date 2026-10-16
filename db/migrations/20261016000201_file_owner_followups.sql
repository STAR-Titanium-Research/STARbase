-- migrate:up
-- Two follow-ups of the SEM reader rehearsal on a copy of the live database (physical-test backlog SEM18 and SEM19).
--
-- SEM19: a team's files were readable by every member with a login, while the Inbox (d1-inbox) counts only active members, so a Former
-- member whose login was still active could read a team file by id and saw an empty Inbox. A team owner now counts active members only, and
-- flipping people.active refreshes the readers. A PERSON owner is unchanged: an inactive owner keeps reading their own files (SEM18).
--
-- SEM18: deleting a person (or a team) that owns files is refused by the foreign key (ON DELETE RESTRICT), but Directus showed the raw
-- constraint error with a 500. A BEFORE DELETE trigger raises the same refusal with a message an administrator can act on.

CREATE OR REPLACE FUNCTION d1_private.file_readers_expected(p_file UUID DEFAULT NULL, p_team UUID DEFAULT NULL, p_person UUID DEFAULT NULL)
RETURNS TABLE (directus_files_id UUID, user_id UUID)
LANGUAGE sql STABLE AS $fn$
    SELECT f.id, p.user_id
      FROM directus_files f
      JOIN people p ON p.person_id = f.owner_person_id
     WHERE p.user_id IS NOT NULL
       AND ((p_file IS NULL AND p_team IS NULL AND p_person IS NULL) OR f.id = p_file OR f.owner_team_id = p_team OR f.owner_person_id = p_person)
    UNION
    SELECT f.id, p.user_id
      FROM directus_files f
      JOIN team_members tm ON tm.team_id = f.owner_team_id
      JOIN people p ON p.person_id = tm.person_id
     WHERE p.user_id IS NOT NULL
       AND p.active
       AND ((p_file IS NULL AND p_team IS NULL AND p_person IS NULL) OR f.id = p_file OR f.owner_team_id = p_team OR f.owner_person_id = p_person)
$fn$;
COMMENT ON FUNCTION d1_private.file_readers_expected(UUID, UUID, UUID) IS 'The model of file_readers (migration 196, changed by 201): the (file, login) pairs the owner columns imply, for one file, the files of one team, the files of one person, or all owned files when every argument is NULL. A person owner counts when they have a login (active or not); a team owner counts every ACTIVE member with a login.';

DROP TRIGGER IF EXISTS people_file_owner_sync ON people;
CREATE TRIGGER people_file_owner_sync AFTER UPDATE OF user_id, active ON people
    FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id OR OLD.active IS DISTINCT FROM NEW.active)
    EXECUTE FUNCTION d1_private.trg_file_readers_on_person();
COMMENT ON TRIGGER people_file_owner_sync ON people IS 'A login added to, changed on or removed from a person, or the person going active or inactive, refreshes the readers of their files and of their teams'' files (migration 196, changed by 201).';

SELECT d1_private.file_readers_refresh();

CREATE FUNCTION d1_private.trg_people_owns_files() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM directus_files f WHERE f.owner_person_id = OLD.person_id;
    IF n > 0 THEN
        RAISE EXCEPTION '% cannot be deleted: they own % found file(s) on the share. Set them inactive instead, or re-stamp their files first (runbook: An alias handed to someone else).', COALESCE(NULLIF(OLD.full_name, ''), OLD.person_id::text), n
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Set them inactive instead, or re-stamp their files to the right person first (docs/runbooks/inbox-crawler.md, "An alias handed to someone else").';
    END IF;
    RETURN OLD;
END
$fn$;
COMMENT ON FUNCTION d1_private.trg_people_owns_files() IS 'Trigger function (migration 201): refuses to delete a person who owns files, with a message that says what to do. The foreign key (ON DELETE RESTRICT, migration 196) still holds; this only replaces its raw error.';

CREATE TRIGGER people_owns_files_guard BEFORE DELETE ON people
    FOR EACH ROW EXECUTE FUNCTION d1_private.trg_people_owns_files();
COMMENT ON TRIGGER people_owns_files_guard ON people IS 'A person who owns files cannot be deleted; says why (migration 201).';

CREATE FUNCTION d1_private.trg_teams_owns_files() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM directus_files f WHERE f.owner_team_id = OLD.team_id;
    IF n > 0 THEN
        RAISE EXCEPTION 'The team % cannot be deleted: it owns % found file(s) on the share. Re-stamp them first (runbook: An alias handed to someone else).', OLD.name, n
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Re-stamp the team''s files to the right owner first (docs/runbooks/inbox-crawler.md, "An alias handed to someone else").';
    END IF;
    RETURN OLD;
END
$fn$;
COMMENT ON FUNCTION d1_private.trg_teams_owns_files() IS 'Trigger function (migration 201): refuses to delete a team that owns files, with a message that says what to do. The foreign key (migration 196) still holds.';

CREATE TRIGGER teams_owns_files_guard BEFORE DELETE ON teams
    FOR EACH ROW EXECUTE FUNCTION d1_private.trg_teams_owns_files();
COMMENT ON TRIGGER teams_owns_files_guard ON teams IS 'A team that owns files cannot be deleted; says why (migration 201).';

-- migrate:down
DROP TRIGGER IF EXISTS teams_owns_files_guard ON teams;
DROP TRIGGER IF EXISTS people_owns_files_guard ON people;
DROP FUNCTION IF EXISTS d1_private.trg_teams_owns_files();
DROP FUNCTION IF EXISTS d1_private.trg_people_owns_files();

DROP TRIGGER IF EXISTS people_file_owner_sync ON people;
CREATE TRIGGER people_file_owner_sync AFTER UPDATE OF user_id ON people
    FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
    EXECUTE FUNCTION d1_private.trg_file_readers_on_person();
COMMENT ON TRIGGER people_file_owner_sync ON people IS 'A login added to, changed on or removed from a person refreshes the readers of their files and of their teams'' files (migration 196).';

CREATE OR REPLACE FUNCTION d1_private.file_readers_expected(p_file UUID DEFAULT NULL, p_team UUID DEFAULT NULL, p_person UUID DEFAULT NULL)
RETURNS TABLE (directus_files_id UUID, user_id UUID)
LANGUAGE sql STABLE AS $fn$
    SELECT f.id, p.user_id
      FROM directus_files f
      JOIN people p ON p.person_id = f.owner_person_id
     WHERE p.user_id IS NOT NULL
       AND ((p_file IS NULL AND p_team IS NULL AND p_person IS NULL) OR f.id = p_file OR f.owner_team_id = p_team OR f.owner_person_id = p_person)
    UNION
    SELECT f.id, p.user_id
      FROM directus_files f
      JOIN team_members tm ON tm.team_id = f.owner_team_id
      JOIN people p ON p.person_id = tm.person_id
     WHERE p.user_id IS NOT NULL
       AND ((p_file IS NULL AND p_team IS NULL AND p_person IS NULL) OR f.id = p_file OR f.owner_team_id = p_team OR f.owner_person_id = p_person)
$fn$;
COMMENT ON FUNCTION d1_private.file_readers_expected(UUID, UUID, UUID) IS 'The model of file_readers (migration 196): the (file, login) pairs the owner columns imply, for one file, the files of one team, the files of one person, or all owned files when every argument is NULL. A person owner counts when they have a login; a team owner counts every member with a login.';

SELECT d1_private.file_readers_refresh();
