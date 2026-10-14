-- migrate:up
-- Teams (People 2, Task 1; spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md sections 2.1 and 2.5).
-- A team is a named group of people that a record's owner can give access to as one entry (the grants arrive with migration 182).
-- This migration is the groundwork: the three tables, the rule that a team keeps a manager, the history of who joined and left,
-- and the Directus registration.
--
--   * teams          one row per team: name (unique ignoring case and blanks), colour from a fixed palette, optional logo, description;
--   * team_members   a person in a team, with a manager flag; a surrogate key (Directus wants one primary-key field) and a person is in a team once (unique team, person);
--   * team_events    the history of a team: created, renamed, members added, removed, made or unmade manager. The kinds that
--                    only the sharing code writes (shared, unshared, approved, declined, trust_set, trust_unset) are allowed now so that
--                    migration 182 does not have to change the check.
--
-- A team with at least one member must have at least one manager. The check is a deferred constraint trigger, so it runs at COMMIT:
-- a team can be created and its first manager added in one transaction, and a manager can be swapped for another in one transaction,
-- but a transaction that leaves members and no manager is refused (SQLSTATE 23514). A team with no members is allowed (the last member left).
--
-- History is written by triggers, so every route (the teams endpoint, Data Studio, SQL) leaves the same trail. The actor is the person whose
-- user_id is in the transaction setting d1.actor_identity (the actor-identity hook sets it; null when unset or not a user id). Deleting a team
-- deletes its events with it (ON DELETE CASCADE) and logs none; deleting a person logs their removal from each team with person_id left null.
--
-- Directus: the three tables are visible collections grouped under People. A Lab Member reads all three (no filter) and cannot create, update
-- or delete: the teams endpoint writes them. Administrators and Lab Admins have full access (admin_access). The read rows are listed in
-- scripts/access_rules.json ("unfiltered") like every other Lab Member grant, so configure_users_and_policies.sql carries them too.
-- Not granted to the Ask-the-database role (d1_llm_readonly): it must not ask who is in which team. teams and team_members are audited
-- (audit_logs); team_events is itself the history and is not.
-- Down: drops the Directus registration, the three tables (and their triggers) and the functions.

CREATE SCHEMA IF NOT EXISTS d1_private;

-- 1. Tables.
CREATE TABLE teams (
    team_id UUID NOT NULL DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL DEFAULT 'teal',
    logo UUID,
    created_by_person_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT teams_pkey PRIMARY KEY (team_id),
    CONSTRAINT teams_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT teams_color_check CHECK (color IN ('teal', 'blue', 'indigo', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'slate')),
    CONSTRAINT teams_logo_fkey FOREIGN KEY (logo) REFERENCES directus_files (id) ON DELETE SET NULL,
    CONSTRAINT teams_created_by_person_id_fkey FOREIGN KEY (created_by_person_id) REFERENCES people (person_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX teams_name_key ON teams (lower(btrim(name)));

CREATE TABLE team_members (
    member_id UUID NOT NULL DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL,
    person_id UUID NOT NULL,
    is_manager BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT team_members_pkey PRIMARY KEY (member_id),
    CONSTRAINT team_members_team_id_person_id_key UNIQUE (team_id, person_id),
    CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (team_id) ON DELETE CASCADE,
    CONSTRAINT team_members_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE
);
CREATE INDEX team_members_person_idx ON team_members (person_id);

CREATE TABLE team_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY,
    team_id UUID NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_person_id UUID,
    kind TEXT NOT NULL,
    person_id UUID,
    collection TEXT,
    record_id UUID,
    detail JSONB,
    CONSTRAINT team_events_pkey PRIMARY KEY (event_id),
    CONSTRAINT team_events_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams (team_id) ON DELETE CASCADE,
    CONSTRAINT team_events_actor_person_id_fkey FOREIGN KEY (actor_person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT team_events_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE SET NULL,
    CONSTRAINT team_events_kind_check CHECK (kind IN ('created', 'renamed', 'member_added', 'member_removed', 'manager_set', 'manager_unset',
        'shared', 'unshared', 'approved', 'declined', 'trust_set', 'trust_unset'))
);
CREATE INDEX team_events_team_idx ON team_events (team_id, event_id);

COMMENT ON TABLE teams IS 'A named group of people that a record''s owner can give access to as one entry (migration 182 adds the grants). Written through the teams endpoint; audited. Deleting a team deletes its members and its history.';
COMMENT ON COLUMN teams.team_id IS 'Surrogate key of the team.';
COMMENT ON COLUMN teams.name IS 'The team''s name. Unique ignoring case and surrounding blanks (teams_name_key); never blank.';
COMMENT ON COLUMN teams.description IS 'What the team is for; optional.';
COMMENT ON COLUMN teams.color IS 'The team''s colour, one of the palette keys teal, blue, indigo, violet, pink, red, orange, amber, green, slate. Default teal. Used for the team tile when there is no logo.';
COMMENT ON COLUMN teams.logo IS 'Optional logo image (directus_files.id); png, jpeg or svg up to 1 MB, enforced by the teams endpoint. NULL when the file is deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN teams.created_by_person_id IS 'The person who created the team; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN teams.created_at IS 'When the team was created.';
COMMENT ON INDEX teams_name_key IS 'Two teams cannot share a name, ignoring case and surrounding blanks.';

COMMENT ON TABLE team_members IS 'A person in a team. A team with at least one member has at least one manager (checked at commit by d1_private.team_has_manager(), which locks the team row so concurrent checks serialise). Written through the teams endpoint; audited. Rows go with the team and with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN team_members.member_id IS 'Surrogate key of the membership (Directus needs a single primary-key field); a person is in a team once (team_members_team_id_person_id_key).';
COMMENT ON COLUMN team_members.team_id IS 'The team (teams.team_id). Deleted with it.';
COMMENT ON COLUMN team_members.person_id IS 'The member (people.person_id), not a login. Deleted with the person.';
COMMENT ON COLUMN team_members.is_manager IS 'True for a team manager: can add and remove members, edit the team, and approve pending members. A team keeps at least one while it has members.';
COMMENT ON COLUMN team_members.joined_at IS 'When the person joined the team.';
COMMENT ON INDEX team_members_person_idx IS 'Finds the teams of one person.';

COMMENT ON TABLE team_events IS 'The history of a team, in order of event_id. Written by the triggers on teams and team_members (created, renamed, member_added, member_removed, manager_set, manager_unset) and by the sharing code of migration 182 (shared, unshared, approved, declined, trust_set, trust_unset). Not audited itself. Deleted with the team.';
COMMENT ON COLUMN team_events.event_id IS 'Order of the events (identity).';
COMMENT ON COLUMN team_events.team_id IS 'The team the event belongs to (teams.team_id). Deleted with it.';
COMMENT ON COLUMN team_events.at IS 'When it happened.';
COMMENT ON COLUMN team_events.actor_person_id IS 'The person who did it, from the transaction setting d1.actor_identity; NULL when unknown or when that person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN team_events.kind IS 'created, renamed, member_added, member_removed, manager_set, manager_unset, shared, unshared, approved, declined, trust_set or trust_unset.';
COMMENT ON COLUMN team_events.person_id IS 'The member the event is about (member_*, manager_*, approved, declined); NULL when the event is about the team or the person was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN team_events.collection IS 'The record type of a sharing event (for example physical_samples); NULL for the others.';
COMMENT ON COLUMN team_events.record_id IS 'The record of a sharing event; NULL for the others.';
COMMENT ON COLUMN team_events.detail IS 'Extra facts as JSON: created {name}, renamed {from, to}, member_added {is_manager}, member_removed {was_manager}; free for the sharing events.';
COMMENT ON INDEX team_events_team_idx IS 'The history of one team in order.';

-- 2. The functions.
-- The person behind the transaction: people.user_id = the setting d1.actor_identity, when that is a user id (null otherwise).
CREATE OR REPLACE FUNCTION d1_private.team_actor_person()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT pe.person_id FROM people pe
     WHERE pe.user_id::text = lower(nullif(btrim(current_setting('d1.actor_identity', true)), ''))
     LIMIT 1
$$;
COMMENT ON FUNCTION d1_private.team_actor_person() IS 'The person whose login is the current actor (the transaction setting d1.actor_identity, set by the actor-identity hook), or NULL when it is unset, is not a user id or matches no person. Used by the team history triggers. Migration 181.';

-- A team that has members must have a manager. Deferred, so it is judged at commit on the final state.
CREATE OR REPLACE FUNCTION d1_private.team_has_manager()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    t uuid;
BEGIN
    -- the lock below only serialises the checks under READ COMMITTED: under REPEATABLE READ the second check would wait for the
    -- first commit and then still read its old snapshot (both managers in place), so it is refused there (as refresh_readers is)
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'd1_private.team_has_manager needs READ COMMITTED (the transaction is %): the manager check must see what a concurrent change committed',
            current_setting('transaction_isolation')
            USING ERRCODE = 'feature_not_supported';
    END IF;
    -- in team order, so that two transactions moving members between the same two teams lock them in the same order
    FOR t IN SELECT DISTINCT x FROM unnest(CASE TG_OP
                                              WHEN 'INSERT' THEN ARRAY[NEW.team_id]
                                              WHEN 'DELETE' THEN ARRAY[OLD.team_id]
                                              ELSE ARRAY[OLD.team_id, NEW.team_id] END) AS x
             ORDER BY x
    LOOP
        -- serialise the checks of one team: two transactions that each remove or demote one of two managers would otherwise both
        -- pass (each sees the other's manager still in place). The second check waits for the first commit, then sees its result.
        PERFORM 1 FROM teams WHERE team_id = t FOR NO KEY UPDATE;   -- no row (a deleted team) = nothing to lock or check
        IF EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t)
           AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t AND m.is_manager) THEN
            RAISE EXCEPTION 'A team must keep at least one manager'
                USING ERRCODE = 'check_violation', TABLE = 'team_members', CONSTRAINT = 'team_members_need_manager',
                      DETAIL = format('Team %s has members and no manager.', t),
                      HINT = 'Make another member a manager first, or remove every member.';
        END IF;
    END LOOP;
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_has_manager() IS 'Deferred constraint trigger function of team_members (INITIALLY DEFERRED, so judged at COMMIT; it first locks the team row FOR NO KEY UPDATE so two transactions removing different managers are checked one after the other; the old and new team of a moved member are locked in team_id order): a team with at least one member and no manager raises check_violation (23514) "A team must keep at least one manager". A team with no members passes. Raises feature_not_supported (0A000) outside READ COMMITTED, where the lock would not make the check see a concurrent commit. Migration 181.';

CREATE OR REPLACE FUNCTION d1_private.teams_history()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO team_events (team_id, actor_person_id, kind, detail)
        VALUES (NEW.team_id, d1_private.team_actor_person(), 'created', jsonb_build_object('name', NEW.name));
    ELSE
        INSERT INTO team_events (team_id, actor_person_id, kind, detail)
        VALUES (NEW.team_id, d1_private.team_actor_person(), 'renamed', jsonb_build_object('from', OLD.name, 'to', NEW.name));
    END IF;
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.teams_history() IS 'History trigger function of teams: an insert logs created {name}, a name change logs renamed {from, to}. The actor comes from d1.actor_identity (d1_private.team_actor_person). Migration 181.';

CREATE OR REPLACE FUNCTION d1_private.team_members_history()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO team_events (team_id, actor_person_id, kind, person_id, detail)
        VALUES (NEW.team_id, d1_private.team_actor_person(), 'member_added', NEW.person_id, jsonb_build_object('is_manager', NEW.is_manager));
    ELSIF TG_OP = 'DELETE' THEN
        -- the team itself being deleted: its events go with it, so none is logged (the key would not exist any more)
        IF EXISTS (SELECT 1 FROM teams t WHERE t.team_id = OLD.team_id) THEN
            INSERT INTO team_events (team_id, actor_person_id, kind, person_id, detail)
            VALUES (OLD.team_id, d1_private.team_actor_person(), 'member_removed',
                    (SELECT pe.person_id FROM people pe WHERE pe.person_id = OLD.person_id),  -- NULL when the person is being deleted too
                    jsonb_build_object('was_manager', OLD.is_manager));
        END IF;
    ELSE
        INSERT INTO team_events (team_id, actor_person_id, kind, person_id)
        VALUES (NEW.team_id, d1_private.team_actor_person(), CASE WHEN NEW.is_manager THEN 'manager_set' ELSE 'manager_unset' END, NEW.person_id);
    END IF;
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_members_history() IS 'History trigger function of team_members: an insert logs member_added {is_manager}, a delete logs member_removed {was_manager} (nothing when the team itself is being deleted; person_id is NULL when the person is being deleted too), an is_manager change logs manager_set or manager_unset. The actor comes from d1.actor_identity. Migration 181.';

-- Nobody calls these directly: they run as triggers.
REVOKE ALL ON FUNCTION d1_private.team_actor_person() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_has_manager() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.teams_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_members_history() FROM PUBLIC;

-- 3. Triggers.
CREATE CONSTRAINT TRIGGER team_members_need_manager
    AFTER INSERT OR DELETE OR UPDATE OF is_manager, team_id ON team_members
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION d1_private.team_has_manager();

CREATE TRIGGER teams_history_insert
    AFTER INSERT ON teams
    FOR EACH ROW EXECUTE FUNCTION d1_private.teams_history();
CREATE TRIGGER teams_history_rename
    AFTER UPDATE OF name ON teams
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
    EXECUTE FUNCTION d1_private.teams_history();

CREATE TRIGGER team_members_history_insert
    AFTER INSERT ON team_members
    FOR EACH ROW EXECUTE FUNCTION d1_private.team_members_history();
CREATE TRIGGER team_members_history_delete
    AFTER DELETE ON team_members
    FOR EACH ROW EXECUTE FUNCTION d1_private.team_members_history();
CREATE TRIGGER team_members_history_manager
    AFTER UPDATE OF is_manager ON team_members
    FOR EACH ROW WHEN (OLD.is_manager IS DISTINCT FROM NEW.is_manager)
    EXECUTE FUNCTION d1_private.team_members_history();

CREATE TRIGGER audit_teams
    AFTER INSERT OR UPDATE OR DELETE ON teams
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
CREATE TRIGGER audit_team_members
    AFTER INSERT OR UPDATE OR DELETE ON team_members
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- 4. Directus: three visible collections grouped under People (next to it), their relations, fields, and the Lab Member read rows.
INSERT INTO directus_collections (collection, icon, note, display_template, hidden, "group", sort)
SELECT v.collection, v.icon, v.note, v.display_template, FALSE, 'people', v.sort
FROM (VALUES
    ('teams', 'diversity_3', 'Named groups of people that a record''s owner can give access to as one entry', '{{name}}', 4),
    ('team_members', 'person_add', 'Who is in which team, and who manages it', NULL, 5),
    ('team_events', 'history', 'History of each team: who joined, left, was made manager, what was shared', NULL, 6)
) AS v (collection, icon, note, display_template, sort)
WHERE NOT EXISTS (SELECT 1 FROM directus_collections AS c WHERE c.collection = v.collection);

DO $$
DECLARE
    r        RECORD;
    existing RECORD;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('team_members', 'team_id', 'teams', 'members', 'delete'),
            ('team_members', 'person_id', 'people', NULL, 'nullify'),
            ('teams', 'logo', 'directus_files', NULL, 'nullify'),
            ('teams', 'created_by_person_id', 'people', NULL, 'nullify'),
            ('team_events', 'team_id', 'teams', NULL, 'delete'),
            ('team_events', 'actor_person_id', 'people', NULL, 'nullify'),
            ('team_events', 'person_id', 'people', NULL, 'nullify')
        ) AS v (many_collection, many_field, one_collection, one_field, deselect)
    LOOP
        SELECT * INTO existing
        FROM directus_relations
        WHERE many_collection = r.many_collection AND many_field = r.many_field
        ORDER BY id
        LIMIT 1;

        IF NOT FOUND THEN
            IF r.one_field IS NOT NULL AND EXISTS (
                SELECT 1 FROM directus_relations
                WHERE one_collection = r.one_collection AND one_field = r.one_field
            ) THEN
                RAISE EXCEPTION 'teams: cannot add relation %.% -> %: alias %.% is already used by another relation',
                    r.many_collection, r.many_field, r.one_collection, r.one_collection, r.one_field;
            END IF;
            INSERT INTO directus_relations
                (many_collection, many_field, one_collection, one_field, one_deselect_action)
            VALUES (r.many_collection, r.many_field, r.one_collection, r.one_field, r.deselect);
        END IF;
    END LOOP;
END
$$;

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, required, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.readonly, (v.field = 'member_id'), v.sort, v.width, v.required, v.note
FROM (VALUES
    ('teams', 'name', NULL, 'input', NULL, 'raw', FALSE, 1, 'half', TRUE, NULL),
    ('teams', 'color', NULL, 'select-dropdown',
        '{"choices":[{"text":"Teal","value":"teal"},{"text":"Blue","value":"blue"},{"text":"Indigo","value":"indigo"},{"text":"Violet","value":"violet"},{"text":"Pink","value":"pink"},{"text":"Red","value":"red"},{"text":"Orange","value":"orange"},{"text":"Amber","value":"amber"},{"text":"Green","value":"green"},{"text":"Slate","value":"slate"}]}',
        'labels', FALSE, 2, 'half', FALSE, NULL),
    ('teams', 'description', NULL, 'input-multiline', NULL, 'raw', FALSE, 3, 'full', FALSE, NULL),
    ('teams', 'logo', 'file', 'file-image', NULL, 'image', FALSE, 4, 'half', FALSE, 'png, jpeg or svg, up to 1 MB (checked by the teams endpoint)'),
    ('teams', 'created_by_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":false}', 'related-values', TRUE, 5, 'half', FALSE, NULL),
    ('teams', 'created_at', NULL, 'datetime', NULL, 'datetime', TRUE, 6, 'half', FALSE, NULL),
    ('teams', 'members', 'o2m', 'list-o2m', '{"template":"{{person_id.full_name}}","enableCreate":false,"enableSelect":false}', 'related-values', TRUE, 7, 'full', FALSE,
        'The members of the team (team_members.team_id); changed through the teams endpoint'),
    ('team_members', 'member_id', 'uuid', 'input', NULL, 'raw', TRUE, 0, 'half', FALSE, 'Surrogate key'),
    ('team_members', 'team_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{name}}","enableCreate":false}', 'related-values', FALSE, 1, 'half', TRUE, NULL),
    ('team_members', 'person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":false}', 'related-values', FALSE, 2, 'half', TRUE, NULL),
    ('team_members', 'is_manager', 'cast-boolean', 'boolean', NULL, 'boolean', FALSE, 3, 'half', FALSE, NULL),
    ('team_members', 'joined_at', NULL, 'datetime', NULL, 'datetime', TRUE, 4, 'half', FALSE, NULL),
    ('team_events', 'team_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{name}}","enableCreate":false}', 'related-values', TRUE, 1, 'half', FALSE, NULL),
    ('team_events', 'at', NULL, 'datetime', NULL, 'datetime', TRUE, 2, 'half', FALSE, NULL),
    ('team_events', 'kind', NULL, 'input', NULL, 'raw', TRUE, 3, 'half', FALSE, NULL),
    ('team_events', 'actor_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":false}', 'related-values', TRUE, 4, 'half', FALSE, NULL),
    ('team_events', 'person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":false}', 'related-values', TRUE, 5, 'half', FALSE, NULL)
) AS v (collection, field, special, interface, options, display, readonly, sort, width, required, note)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields AS f WHERE f.collection = v.collection AND f.field = v.field
);

-- A Lab Member reads teams and team_members (no filter); only the teams endpoint writes them. team_events has NO Lab Member row: its
-- history names records and people the reader may not be allowed to see, so it is served only by GET /d1-teams/:id, which hides what
-- the caller cannot read.
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT v.collection, 'read', '{}'::json, '{}'::json, NULL, '*', '20000002-0000-0000-0000-000000000002'::uuid
FROM (VALUES ('teams'), ('team_members')) AS v (collection)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions AS p
     WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = v.collection AND p.action = 'read'
);

-- migrate:down
SET LOCAL lock_timeout = '10s';

DELETE FROM directus_permissions
WHERE policy = '20000002-0000-0000-0000-000000000002' AND collection IN ('teams', 'team_members', 'team_events');
DELETE FROM directus_fields WHERE collection IN ('teams', 'team_members', 'team_events');
DELETE FROM directus_relations WHERE many_collection IN ('teams', 'team_members', 'team_events');
DELETE FROM directus_collections WHERE collection IN ('teams', 'team_members', 'team_events');

DROP TABLE IF EXISTS team_events;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;

DROP FUNCTION IF EXISTS d1_private.team_members_history();
DROP FUNCTION IF EXISTS d1_private.teams_history();
DROP FUNCTION IF EXISTS d1_private.team_has_manager();
DROP FUNCTION IF EXISTS d1_private.team_actor_person();
