-- migrate:up
-- A file belongs to its provenance owner (ADR-0022; spec docs/superpowers/specs/2026-10-16-sem-data-bar-reader-design.md sections 3 and 4,
-- decisions D7 to D10; plan docs/superpowers/plans/2026-10-16-sem-reader.md task C1).
--
-- Why: the inbox crawler finds files in Users/<uni alias> and Shared/<folder> and registers a directus_files pointer row for each. Until now
-- anyone who could read that row could read the file (ADR-0014: directus_files and /assets are "open until A1b"), so linking a colleague's
-- file published it. The maintainer's rule (2026-10-16): a file is visible only to the user whose folder it came from. The path of a pointer row
-- cannot carry that rule (any Lab Member can edit archive_path, ADR-0021), so the owner is a stamp the crawler writes:
--
--   * directus_files.owner_person_id / owner_team_id   at most one set, ON DELETE RESTRICT (deleting an owner must not silently open their
--     files: deactivate the person instead). Partial indexes (WHERE NOT NULL). Members cannot write them: the Lab Member create and update
--     field lists of directus_files below leave both out (the pattern of people.uni_alias, migration 193). There is NO Postgres trigger,
--     because Directus uses one database role for every user, so a trigger cannot tell an administrator from a member.
--   * the back-fill (D10): the live crawler has registered pointer rows already, and d1_private.file_candidates.owner_* (written by the crawler,
--     exactly one per row, so a trusted source unlike the editable archive_path) says whose they are. Every candidate that is not 'linked' stamps
--     its file, EXCEPT a file that is linked anywhere: the candidate's state does not say so (a file linked in Data Studio's picker or the Alicona
--     dialog keeps a dismissed, new or gone candidate), so the back-fill also leaves alone every file that has a row in sample_data_files,
--     operation_data_files, session_data_files or surface_scans (the crawler's own definition, inbox_crawler/db.py already_linked; all four tables
--     exist at this migration, so no existence guard is needed). A file with no candidate and an existing stamp are left alone too, so nobody
--     loses access they have today.
--   * public.file_readers   WHO MAY READ AN OWNED FILE, one row per (file, login): the owner's login, or the login of every member of the owning
--     team. This is the ADR-0014 readers pattern (migration 166) and it is here because the plan's step 4 probe could not run: the team test
--     "the caller is in the owning team" is a to-many hop (team -> members) inside `_some`, which Directus 11.17 refuses (ADR-0016 context;
--     access_rules.json: `_some` is legal only directly under a top-level to-many alias). A hidden top-level alias `readers` on directus_files over
--     this table makes the whole rule one legal membership test. The table is public (not d1_private) because Directus only sees public tables.
--     It is kept by triggers on directus_files (owner columns), team_members (join, leave) and people (a login added or removed), and
--     d1_private.file_readers_drift_count() proves it equals what the owner columns say. Derived data: not audited, like the other readers tables.
--   * the Directus rules (scripts/access_rules.json "custom", pasted by gen_access_rules.py): Lab Member and Lab Viewer read directus_files (and so
--     /assets) only when both owner columns are null or the caller has a file_readers row; Lab Member UPDATE and DELETE of a file carry the same test
--     in its bare-hop form (`readers.user_id`, no `_some`, the form access_rules.json prescribes for update and delete: a legal `_some` would apply the
--     readers table's own rule for the action), so a member cannot rewrite or delete (and so cascade away the settings of) a file they cannot read;
--     Lab Member create and update list every directus_files column except the two owners; file_readers is readable for the caller's own rows (the `_some` applies the related rule for the same
--     action). Administrators are not filtered. The rows are `python3 scripts/gen_access_rules.py --values --only directus_files,file_readers`
--     and `--viewer-values` (a snapshot of the rules on 2026-10-16, as in migrations 166 and 185). What they replace is kept in
--     d1_private.directus_files_rules_backup so `down` restores the exact old rows.
--
-- Not done here: linked and legacy files stay open (D10), the junction creates and surface_scans.create still accept an owned file's id (outside this
-- stream), and surface scans stay lab-wide until their own stream (spec section 11).
-- After applying: flush Redis and restart Directus (it caches permissions and reads relations at start-up). The new `readers` alias on a system
-- collection could not be tried against a live Directus here: physical-test item SEM3 checks it with two accounts.
SET LOCAL lock_timeout = '10s';

-- 1. The owner columns.
ALTER TABLE directus_files
    ADD COLUMN owner_person_id UUID,
    ADD COLUMN owner_team_id UUID,
    ADD CONSTRAINT directus_files_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES people (person_id) ON DELETE RESTRICT,
    ADD CONSTRAINT directus_files_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES teams (team_id) ON DELETE RESTRICT,
    ADD CONSTRAINT directus_files_one_owner_check CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1);

CREATE INDEX idx_directus_files_owner_person_id ON directus_files (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX idx_directus_files_owner_team_id ON directus_files (owner_team_id) WHERE owner_team_id IS NOT NULL;

COMMENT ON COLUMN directus_files.owner_person_id IS 'Provenance owner (ADR-0022): the person whose personal folder on the lab share (Users/<uni alias>) this file came from. Only that person''s login, and administrators, can read the file (and so /assets/<id>) and link it; NULL together with owner_team_id NULL means the file is open, as before. At most one of owner_person_id and owner_team_id is set. Stamped by the inbox crawler when it registers the pointer row, and never overwritten by it; Lab Members cannot write it (Directus field lists, as people.uni_alias). The owner is the person, not the alias text, so a renamed or reassigned alias does not move the file. ON DELETE RESTRICT: a person who owns files cannot be deleted, deactivate them instead. migration 196.';
COMMENT ON COLUMN directus_files.owner_team_id IS 'Provenance owner (ADR-0022): the team whose shared folder on the lab share (Shared/<share folder>) this file came from. Every member of the team can read the file; see owner_person_id for the rule, the stamping and who can change it. At most one of owner_person_id and owner_team_id is set. ON DELETE RESTRICT: a team that owns files cannot be deleted. migration 196.';
COMMENT ON INDEX idx_directus_files_owner_person_id IS 'Files owned by a person (partial: most files have no owner); used by the readers refresh when a person gets or loses a login. migration 196.';
COMMENT ON INDEX idx_directus_files_owner_team_id IS 'Files owned by a team (partial: most files have no owner); used by the readers refresh when a member joins or leaves. migration 196.';
COMMENT ON CONSTRAINT directus_files_one_owner_check ON directus_files IS 'A file has at most one provenance owner, a person or a team, never both (ADR-0022).';

-- 2. The back-fill (D10): found files that are not linked anywhere take the owner the crawler recorded. The statement between the markers is
-- run on its own by tests/phase1_schema.sh.
-- backfill:begin
UPDATE directus_files f
   SET owner_person_id = c.owner_person_id,
       owner_team_id = c.owner_team_id
  FROM d1_private.file_candidates c
 WHERE c.directus_files_id = f.id
   AND c.state <> 'linked'
   AND f.owner_person_id IS NULL
   AND f.owner_team_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM sample_data_files j WHERE j.directus_files_id = f.id)
   AND NOT EXISTS (SELECT 1 FROM operation_data_files j WHERE j.directus_files_id = f.id)
   AND NOT EXISTS (SELECT 1 FROM session_data_files j WHERE j.directus_files_id = f.id)
   AND NOT EXISTS (SELECT 1 FROM surface_scans j WHERE j.directus_files_id = f.id);
-- backfill:end

-- 3. The readers table.
CREATE TABLE file_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    directus_files_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT file_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT file_readers_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES directus_files (id) ON DELETE CASCADE,
    CONSTRAINT file_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT file_readers_directus_files_id_user_id_key UNIQUE (directus_files_id, user_id)
);
CREATE INDEX idx_file_readers_user_id ON file_readers (user_id);

COMMENT ON TABLE file_readers IS 'Who may read each OWNED file (ADR-0022, the readers pattern of ADR-0014): one row per file and login, for the owning person''s login or for the login of every member of the owning team. A file with no owner has no rows here (the Directus rule opens it with its own leaf). Derived: kept by triggers on directus_files, team_members and people, never written by hand or by Directus users; d1_private.file_readers_drift_count() must be 0. Hidden Directus collection behind the readers alias of directus_files, the membership test of the Lab Member and Lab Viewer read rule. migration 196.';
COMMENT ON COLUMN file_readers.reader_id IS 'Surrogate key (Directus needs a single-column primary key).';
COMMENT ON COLUMN file_readers.directus_files_id IS 'The owned file. The row disappears with the file.';
COMMENT ON COLUMN file_readers.user_id IS 'The Directus login that may read the file: the owner person''s user_id, or the user_id of a member of the owning team. The row disappears with the login.';
COMMENT ON INDEX idx_file_readers_user_id IS 'The lookup of the read rule: does this login have a row for this file.';

-- 4. The functions that keep it. file_readers_expected is the model (what the owner columns say), file_readers_refresh makes the table equal it for
-- a scope (one file, one team's files, one person's files, or everything when all three are NULL), the trigger functions only say which scope.
CREATE FUNCTION d1_private.file_readers_expected(p_file UUID DEFAULT NULL, p_team UUID DEFAULT NULL, p_person UUID DEFAULT NULL)
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

CREATE FUNCTION d1_private.file_readers_refresh(p_file UUID DEFAULT NULL, p_team UUID DEFAULT NULL, p_person UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE sql AS $fn$
    DELETE FROM file_readers r
     WHERE ((p_file IS NULL AND p_team IS NULL AND p_person IS NULL)
            OR r.directus_files_id = p_file
            OR r.directus_files_id IN (SELECT f.id FROM directus_files f WHERE f.owner_team_id = p_team OR f.owner_person_id = p_person))
       AND NOT EXISTS (SELECT 1 FROM d1_private.file_readers_expected(p_file, p_team, p_person) e
                        WHERE e.directus_files_id = r.directus_files_id AND e.user_id = r.user_id);
    INSERT INTO file_readers (directus_files_id, user_id)
    SELECT e.directus_files_id, e.user_id FROM d1_private.file_readers_expected(p_file, p_team, p_person) e
    ON CONFLICT (directus_files_id, user_id) DO NOTHING;
$fn$;
COMMENT ON FUNCTION d1_private.file_readers_refresh(UUID, UUID, UUID) IS 'Makes file_readers equal file_readers_expected for one file, the files of one team, the files of one person, or every file when all arguments are NULL (migration 196). Diffs: only missing rows are inserted and only wrong rows deleted. Called by the triggers below, and once by this migration for the back-fill.';
REVOKE ALL ON FUNCTION d1_private.file_readers_refresh(UUID, UUID, UUID) FROM PUBLIC;

CREATE FUNCTION d1_private.file_readers_drift_count() RETURNS BIGINT
LANGUAGE sql STABLE AS $fn$
    SELECT (SELECT count(*) FROM (SELECT e.directus_files_id, e.user_id FROM d1_private.file_readers_expected() e
                                  EXCEPT SELECT r.directus_files_id, r.user_id FROM file_readers r) missing)
         + (SELECT count(*) FROM (SELECT r.directus_files_id, r.user_id FROM file_readers r
                                  EXCEPT SELECT e.directus_files_id, e.user_id FROM d1_private.file_readers_expected() e) extra);
$fn$;
COMMENT ON FUNCTION d1_private.file_readers_drift_count() IS 'How many (file, login) pairs differ between file_readers and what the owner columns, team_members and people.user_id imply (migration 196). 0 when the triggers have kept the table right; SELECT d1_private.file_readers_refresh() repairs any other value.';

CREATE FUNCTION d1_private.trg_file_readers_on_file() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
    PERFORM d1_private.file_readers_refresh(p_file => NEW.id);
    RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION d1_private.trg_file_readers_on_file() IS 'Trigger function (migration 196): a file got, changed or lost its owner, so refresh that file''s readers.';

CREATE FUNCTION d1_private.trg_file_readers_on_member() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        PERFORM d1_private.file_readers_refresh(p_team => OLD.team_id);
    END IF;
    IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.team_id IS DISTINCT FROM OLD.team_id) THEN
        PERFORM d1_private.file_readers_refresh(p_team => NEW.team_id);
    END IF;
    RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION d1_private.trg_file_readers_on_member() IS 'Trigger function (migration 196): a person joined, left or moved between teams, so refresh the readers of the files each affected team owns.';

CREATE FUNCTION d1_private.trg_file_readers_on_person() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    t RECORD;
BEGIN
    PERFORM d1_private.file_readers_refresh(p_person => NEW.person_id);
    FOR t IN SELECT tm.team_id FROM team_members tm WHERE tm.person_id = NEW.person_id LOOP
        PERFORM d1_private.file_readers_refresh(p_team => t.team_id);
    END LOOP;
    RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION d1_private.trg_file_readers_on_person() IS 'Trigger function (migration 196): a person''s login was set, changed or removed, so refresh the readers of the files they own and of the files of every team they are in.';

-- 5. Back-fill the readers for the files just stamped, THEN attach the triggers (so the back-fill does not fire one per row).
SELECT d1_private.file_readers_refresh();

CREATE TRIGGER directus_files_owner_ins_sync AFTER INSERT ON directus_files
    FOR EACH ROW WHEN (NEW.owner_person_id IS NOT NULL OR NEW.owner_team_id IS NOT NULL)
    EXECUTE FUNCTION d1_private.trg_file_readers_on_file();
CREATE TRIGGER directus_files_owner_upd_sync AFTER UPDATE OF owner_person_id, owner_team_id ON directus_files
    FOR EACH ROW WHEN (OLD.owner_person_id IS DISTINCT FROM NEW.owner_person_id OR OLD.owner_team_id IS DISTINCT FROM NEW.owner_team_id)
    EXECUTE FUNCTION d1_private.trg_file_readers_on_file();
CREATE TRIGGER team_members_file_owner_sync AFTER INSERT OR DELETE OR UPDATE OF team_id, person_id ON team_members
    FOR EACH ROW EXECUTE FUNCTION d1_private.trg_file_readers_on_member();
CREATE TRIGGER people_file_owner_sync AFTER UPDATE OF user_id ON people
    FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
    EXECUTE FUNCTION d1_private.trg_file_readers_on_person();
COMMENT ON TRIGGER directus_files_owner_ins_sync ON directus_files IS 'A file registered with an owner gets its readers rows (migration 196).';
COMMENT ON TRIGGER directus_files_owner_upd_sync ON directus_files IS 'Stamping, changing or clearing a file''s owner refreshes its readers rows (migration 196).';
COMMENT ON TRIGGER team_members_file_owner_sync ON team_members IS 'A member joining, leaving or moving refreshes the readers of the files the team owns (migration 196).';
COMMENT ON TRIGGER people_file_owner_sync ON people IS 'A login added to, changed on or removed from a person refreshes the readers of their files and of their teams'' files (migration 196).';

-- 6. The Directus metadata the read rule walks: the readers table as a hidden collection, the file relation with the hidden alias `readers` on
-- directus_files, the user relation (no alias) and the hidden read-only alias field. Same shape as migration 166.
INSERT INTO directus_collections (collection, icon, note, hidden, sort)
SELECT 'file_readers', 'lock', 'Derived: who may read each owned file (ADR-0022, migration 196); written only by the recompute triggers', TRUE, 104
WHERE NOT EXISTS (SELECT 1 FROM directus_collections c WHERE c.collection = 'file_readers');

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
SELECT v.many_collection, v.many_field, v.one_collection, v.one_field, v.deselect
FROM (VALUES
    ('file_readers', 'directus_files_id', 'directus_files', 'readers', 'delete'),
    ('file_readers', 'user_id', 'directus_users', NULL, 'nullify')
) AS v (many_collection, many_field, one_collection, one_field, deselect)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, note)
SELECT 'directus_files', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}'::json, 'related-values', TRUE, TRUE, 93, 'full',
    'Hidden alias over file_readers.directus_files_id: who may read the file, the membership test the read rule uses (ADR-0022, migration 196).'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = 'directus_files' AND f.field = 'readers');

-- 7. The permission rows. What they replace is kept for `down`. The block between the markers is replayed on its own by tests/phase1_schema.sh.
-- rules:begin
CREATE TABLE d1_private.directus_files_rules_backup AS
SELECT p.policy, p.action, p.permissions, p.validation, p.fields
  FROM directus_permissions p
 WHERE p.collection = 'directus_files'
   AND p.policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003');
COMMENT ON TABLE d1_private.directus_files_rules_backup IS 'The Lab Member and Lab Viewer directus_files permission rows as they were before migration 196, so its down section restores them exactly. Dropped by that down.';
COMMENT ON COLUMN d1_private.directus_files_rules_backup.policy IS 'The policy id of the saved directus_permissions row (Lab Member or Lab Viewer).';
COMMENT ON COLUMN d1_private.directus_files_rules_backup.action IS 'The action of the saved row: create, read, update or delete.';
COMMENT ON COLUMN d1_private.directus_files_rules_backup.permissions IS 'The saved filter (JSON, possibly NULL).';
COMMENT ON COLUMN d1_private.directus_files_rules_backup.validation IS 'The saved validation (JSON, possibly NULL).';
COMMENT ON COLUMN d1_private.directus_files_rules_backup.fields IS 'The saved comma-separated field list (possibly NULL).';

DROP TABLE IF EXISTS pg_temp._file_owner_rules;
CREATE TEMP TABLE _file_owner_rules (policy UUID, collection TEXT, action TEXT, permissions JSON, validation JSON, fields TEXT);
INSERT INTO _file_owner_rules (policy, collection, action, permissions, validation, fields)
SELECT v.policy::uuid, v.collection, v.action, v.permissions::json, v.validation::json, v.fields
FROM (VALUES
    -- Lab Member (python3 scripts/gen_access_rules.py --values --only directus_files,file_readers)
    ('20000002-0000-0000-0000-000000000002', 'directus_files', 'create', '{}', '{}', 'id,storage,filename_disk,filename_download,title,type,folder,uploaded_by,created_on,modified_by,modified_on,charset,filesize,width,height,duration,embed,description,location,tags,metadata,focal_point_x,focal_point_y,tus_id,tus_data,uploaded_on'),
    ('20000002-0000-0000-0000-000000000002', 'directus_files', 'read', '{"_or":[{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]},{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    ('20000002-0000-0000-0000-000000000002', 'directus_files', 'update', '{"_or":[{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]},{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}]}', '{}', 'id,storage,filename_disk,filename_download,title,type,folder,uploaded_by,created_on,modified_by,modified_on,charset,filesize,width,height,duration,embed,description,location,tags,metadata,focal_point_x,focal_point_y,tus_id,tus_data,uploaded_on'),
    ('20000002-0000-0000-0000-000000000002', 'directus_files', 'delete', '{"_or":[{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]},{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}]}', '{}', '*'),
    ('20000002-0000-0000-0000-000000000002', 'file_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    -- Lab Viewer (python3 scripts/gen_access_rules.py --viewer-values): the Lab Member read rows under the viewer's policy
    ('20000002-0000-0000-0000-000000000003', 'directus_files', 'read', '{"_or":[{"_and":[{"owner_person_id":{"_null":true}},{"owner_team_id":{"_null":true}}]},{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    ('20000002-0000-0000-0000-000000000003', 'file_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*')
) AS v (policy, collection, action, permissions, validation, fields);

-- A Lab Viewer row only where the Lab Viewer policy exists (migration 185 creates it).
DELETE FROM _file_owner_rules r
 WHERE r.policy = '20000002-0000-0000-0000-000000000003'
   AND NOT EXISTS (SELECT 1 FROM directus_policies pol WHERE pol.id = r.policy);

UPDATE directus_permissions p
   SET permissions = r.permissions, validation = r.validation, fields = r.fields
  FROM _file_owner_rules r
 WHERE p.policy = r.policy AND p.collection = r.collection AND p.action = r.action;

INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
SELECT r.collection, r.action, r.permissions, r.validation, r.fields, r.policy
  FROM _file_owner_rules r
 WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = r.policy AND p.collection = r.collection AND p.action = r.action);

DROP TABLE pg_temp._file_owner_rules;
-- rules:end

-- migrate:down
-- Rules first (so no filter names an alias that is gone), then metadata, triggers, functions, the readers table and the columns. Files that were
-- stamped lose their stamp with the columns: after `down`, every file is open again, as before migration 196.
DO $$
BEGIN
    -- skipped when the backup is already gone (a second down does nothing)
    IF to_regclass('d1_private.directus_files_rules_backup') IS NOT NULL THEN
        DELETE FROM directus_permissions
         WHERE collection = 'file_readers'
           AND policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003');

        DELETE FROM directus_permissions p
         WHERE p.collection = 'directus_files'
           AND p.policy IN ('20000002-0000-0000-0000-000000000002', '20000002-0000-0000-0000-000000000003')
           AND NOT EXISTS (SELECT 1 FROM d1_private.directus_files_rules_backup b WHERE b.policy = p.policy AND b.action = p.action);

        UPDATE directus_permissions p
           SET permissions = b.permissions, validation = b.validation, fields = b.fields
          FROM d1_private.directus_files_rules_backup b
         WHERE p.collection = 'directus_files' AND p.policy = b.policy AND p.action = b.action;

        DROP TABLE d1_private.directus_files_rules_backup;
    END IF;
END
$$;

DELETE FROM directus_fields WHERE collection = 'directus_files' AND field = 'readers';
DELETE FROM directus_relations WHERE many_collection = 'file_readers';
DELETE FROM directus_collections WHERE collection = 'file_readers';

DROP TRIGGER IF EXISTS people_file_owner_sync ON people;
DROP TRIGGER IF EXISTS team_members_file_owner_sync ON team_members;
DROP TRIGGER IF EXISTS directus_files_owner_upd_sync ON directus_files;
DROP TRIGGER IF EXISTS directus_files_owner_ins_sync ON directus_files;

DROP FUNCTION IF EXISTS d1_private.trg_file_readers_on_person();
DROP FUNCTION IF EXISTS d1_private.trg_file_readers_on_member();
DROP FUNCTION IF EXISTS d1_private.trg_file_readers_on_file();
DROP FUNCTION IF EXISTS d1_private.file_readers_drift_count();
DROP FUNCTION IF EXISTS d1_private.file_readers_refresh(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS d1_private.file_readers_expected(UUID, UUID, UUID);

DROP TABLE IF EXISTS file_readers;

DROP INDEX IF EXISTS idx_directus_files_owner_team_id;
DROP INDEX IF EXISTS idx_directus_files_owner_person_id;
ALTER TABLE directus_files
    DROP CONSTRAINT IF EXISTS directus_files_one_owner_check,
    DROP CONSTRAINT IF EXISTS directus_files_owner_team_id_fkey,
    DROP CONSTRAINT IF EXISTS directus_files_owner_person_id_fkey,
    DROP COLUMN IF EXISTS owner_team_id,
    DROP COLUMN IF EXISTS owner_person_id;
