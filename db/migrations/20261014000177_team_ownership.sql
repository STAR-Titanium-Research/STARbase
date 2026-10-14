-- migrate:up
-- Team ownership (People 3, Task 1; spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md decisions 13-14, as ruled by O1 and O2 in
-- docs/superpowers/plans/2026-10-14-people-3-team-ownership.md). A sample, campaign, manufacturing operation or test session (never a project) can be
-- owned by a team instead of a person: its managers act as the owner, its members can edit.
--
--   * owner_team_id (teams.team_id, ON DELETE RESTRICT, indexed) on physical_samples, manufacturing_operations, test_sessions and campaigns, with
--     CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1): a record has a person owner, a team owner or none. A team that owns records cannot
--     be deleted. Set only through Transfer ownership (the record-access endpoint, Task 3); read-only in Data Studio forms.
--   * The owner grant (Ruling O1): setting owner_team_id keeps exactly one hidden grant <type>_team_access.role = 'own' (trust_new_members on,
--     added_by = the actor) for that team, and removes it when the owner is cleared or changed. The grant is expanded like any other (migration 176)
--     into derived <type>_access rows, one per member: role 'manage' for a team manager, 'edit' for any other member. A change of
--     team_members.is_manager updates the derived rows of every owner grant of the team. An owner grant is always trusted (a CHECK), so a joiner of
--     the owning team has Can edit at once and an owner grant never has pending rows. Ruling O2: the endpoint never shows the grant as a team entry.
--     If the new owner team already had a view/edit share on the record, that share is replaced by the owner grant.
--   * <type>_access.role accepts 'manage' (the four types only, never project_access), but only on a derived row (CHECK role <> 'manage' OR
--     team_access_id IS NOT NULL): the bookkeeping is the only writer, as for every derived row. <type>_team_access.role accepts 'own'
--     (CHECK own_trusted_check: an own grant trusts new members); a guard (d1_private.team_grant_guard) lets only the bookkeeping write an own
--     grant, and only for the record's owner_team_id, and refuses turning a grant into an own grant or back.
--   * Wherever the readers machinery of migration 166 and migration 176 treated role 'edit' as an editor, 'manage' counts too (Ruling O1):
--     s_editor, v_s_editor / v_s_list, campaign_candidates, project_candidates, readers_of_project and team_pending_actionable. (The owner-only
--     paths of the readers, such as a campaign owner reading its samples, still test owner_person_id: a team owner's managers are editors there.)
--     The Lab Member rules (who may update or delete in Directus) are migration 178.
--   * team_drift() covers owner grants: derived roles follow the manager flag; every team-owned record has exactly one own grant, for its team;
--     an owner grant has no pending row. person_access_list(p, 'owns') adds the records a team owns where p manages the team (source team_owner).
--   * Directus: owner_team_id is a many-to-one to teams (select-dropdown-m2o), read-only in forms.
-- Bookkeeping triggers: AFTER INSERT / UPDATE OF owner_team_id on the four record tables (d1_private.team_owner_sync; a BEFORE STATEMENT
-- trigger first takes the global readers lock on every table, as migration 176 did for the grant tables: campaigns and test_sessions have none of
-- their own before their rows are locked); AFTER UPDATE OF is_manager on team_members (d1_private.team_manager_sync).
-- No team history event for an owner grant (shared / unshared / trust_*): Transfer ownership is what the endpoint records.
-- Down: puts migration 176's and 166's functions and views back, deletes the owner grants (and with them the derived rows), drops the columns,
-- constraints, triggers and the new functions. It refuses while any record is owned by a team (transfer those to a person first).
SET LOCAL lock_timeout = '10s';
CREATE SCHEMA IF NOT EXISTS d1_private;

-- 1. The derived role of a grant for one member.
CREATE OR REPLACE FUNCTION d1_private.team_derived_role(grant_role text, is_manager boolean)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
    SELECT CASE WHEN grant_role = 'own' THEN CASE WHEN is_manager THEN 'manage' ELSE 'edit' END ELSE grant_role END
$$;
COMMENT ON FUNCTION d1_private.team_derived_role(text, boolean) IS 'The role of the derived <type>_access row a team grant gives one member: the grant''s own role, except for an owner grant (role own), which gives manage to a team manager and edit to any other member. Migration 177.';

-- 2. The bookkeeping and guard functions.
CREATE OR REPLACE FUNCTION d1_private.team_grant_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k       record;
    owner   uuid;
    cascade boolean;
BEGIN
    -- turning a grant into an owner grant, or an owner grant into another level, is never allowed (the owner grant follows owner_team_id)
    IF TG_OP = 'UPDATE' AND (OLD.role = 'own') IS DISTINCT FROM (NEW.role = 'own') THEN
        RAISE EXCEPTION 'An owner grant cannot be changed into another level or back'
            USING ERRCODE = 'feature_not_supported', TABLE = TG_TABLE_NAME,
                  HINT = 'Change owner_team_id of the record (Transfer ownership) instead.';
    END IF;
    -- a foreign-key cascade inside another trigger (depth > 1): the record, the team or the adder went (a delete, or added_by_person_id SET NULL)
    cascade := pg_trigger_depth() > 1 AND CASE TG_OP
                                               WHEN 'DELETE' THEN true
                                               WHEN 'UPDATE' THEN OLD.role = NEW.role AND OLD.team_id = NEW.team_id
                                               ELSE false END;
    IF ((TG_OP <> 'INSERT' AND OLD.role = 'own') OR (TG_OP <> 'DELETE' AND NEW.role = 'own'))
       AND coalesce(current_setting('d1.team_sync', true), '') <> 'on'
       AND NOT cascade THEN
        RAISE EXCEPTION 'The owner grant of a team-owned record is managed by owner_team_id'
            USING ERRCODE = 'insufficient_privilege', TABLE = TG_TABLE_NAME,
                  DETAIL = 'A grant with role own is made and removed by the team ownership bookkeeping when owner_team_id of the record changes.',
                  HINT = 'Change owner_team_id of the record (Transfer ownership) instead.';
    END IF;
    -- an owner grant only for the team that owns the record
    IF TG_OP <> 'DELETE' AND NEW.role = 'own' THEN
        SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.kind = TG_ARGV[0];
        EXECUTE format('SELECT x.owner_team_id FROM public.%I x WHERE x.%I = $1', k.collection, k.fk)
            INTO owner USING (to_jsonb(NEW) ->> k.fk)::uuid;
        IF owner IS DISTINCT FROM NEW.team_id THEN
            RAISE EXCEPTION 'An owner grant must be for the team that owns the record'
                USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME,
                      DETAIL = format('Team %s is not owner_team_id of the %s.', NEW.team_id, k.noun);
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;
COMMENT ON FUNCTION d1_private.team_grant_guard() IS 'Row trigger function of the four <kind>_team_access tables of the ownable types (TG_ARGV[0] = kind), BEFORE INSERT / UPDATE / DELETE: a row with role own (old or new) is written only by the team ownership bookkeeping (d1.team_sync = on, d1_private.team_owner_sync) or a foreign-key cascade inside another trigger (pg_trigger_depth() > 1: a DELETE, or added_by_person_id SET NULL), else insufficient_privilege (42501) "The owner grant of a team-owned record is managed by owner_team_id"; turning a grant into an owner grant or back raises feature_not_supported; an own grant for a team other than the record''s owner_team_id raises check_violation. A guard against edits behind the bookkeeping, not a security boundary. Migration 177.';

-- The owner grant of a record follows its owner_team_id.
CREATE OR REPLACE FUNCTION d1_private.team_owner_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k     record;
    ta    text;
    rec   uuid;
    prev  text := current_setting('d1.team_sync', true);
BEGIN
    PERFORM d1_private.team_lock();
    SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.kind = TG_ARGV[0];
    ta := k.kind || '_team_access';
    rec := (to_jsonb(NEW) ->> k.fk)::uuid;
    PERFORM set_config('d1.team_sync', 'on', true);
    -- the owner grant of any other team goes (its derived rows with it; an owner grant logs no history event)
    EXECUTE format('DELETE FROM public.%I WHERE %I = $1 AND role = ''own'' AND team_id IS DISTINCT FROM $2', ta, k.fk)
        USING rec, NEW.owner_team_id;
    IF NEW.owner_team_id IS NOT NULL THEN
        -- a view / edit share of the new owner team is replaced by the owner grant (one grant per team and record)
        EXECUTE format('DELETE FROM public.%I WHERE %I = $1 AND team_id = $2 AND role <> ''own''', ta, k.fk)
            USING rec, NEW.owner_team_id;
        EXECUTE format('INSERT INTO public.%I (%I, team_id, role, trust_new_members, added_by_person_id)
                        VALUES ($1, $2, ''own'', true, $3) ON CONFLICT DO NOTHING', ta, k.fk)
            USING rec, NEW.owner_team_id, d1_private.team_actor_person();
    END IF;
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_owner_sync() IS 'Row trigger function of physical_samples, manufacturing_operations, test_sessions and campaigns (TG_ARGV[0] = kind), AFTER INSERT (owner_team_id not null) and AFTER UPDATE OF owner_team_id (changed): keeps exactly one owner grant (<kind>_team_access role own, trust_new_members on, added_by_person_id the actor of d1.actor_identity) for the record''s owner_team_id: the owner grant of any other team is deleted, a view / edit share of the new owner team is replaced, and clearing owner_team_id deletes the owner grant. The grant''s derived rows (manage for a team manager, edit for any other member) follow by team_grant_sync; their deletion by ON DELETE CASCADE. Takes the global readers lock first (team_lock; READ COMMITTED only). Writes with d1.team_sync = on. Migration 177.';

-- A member's manager flag decides the role of their derived rows on the team's owner grants.
CREATE OR REPLACE FUNCTION d1_private.team_manager_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k     record;
    prev  text := current_setting('d1.team_sync', true);
BEGIN
    PERFORM d1_private.team_lock();
    PERFORM set_config('d1.team_sync', 'on', true);
    FOR k IN SELECT * FROM d1_private.team_kinds() tk WHERE tk.owner_column = 'owner_person_id' LOOP
        EXECUTE format('UPDATE public.%I a SET role = d1_private.team_derived_role(g.role, $3)
                          FROM public.%I g
                         WHERE g.team_access_id = a.team_access_id AND g.team_id = $1 AND g.role = ''own'' AND a.person_id = $2
                           AND a.role IS DISTINCT FROM d1_private.team_derived_role(g.role, $3)', k.kind || '_access', k.kind || '_team_access')
            USING NEW.team_id, NEW.person_id, NEW.is_manager;
    END LOOP;
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_manager_sync() IS 'Row trigger function of team_members, AFTER UPDATE OF is_manager (changed): the member''s derived rows on the team''s owner grants (role own) become manage when they are now a manager and edit when they are not, on the four ownable types; so demoting a manager removes their owner powers at once. Takes the global readers lock first (team_lock). Writes with d1.team_sync = on. Migration 177.';

-- 3. Columns, constraints, indexes, triggers.
DO $do$
DECLARE
    k   record;
    acc text;
    ta  text;
BEGIN
    FOR k IN SELECT * FROM d1_private.team_kinds() tk WHERE tk.owner_column = 'owner_person_id' LOOP
        acc := k.kind || '_access';
        ta := k.kind || '_team_access';
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN owner_team_id UUID', k.collection);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES public.teams (team_id) ON DELETE RESTRICT', k.collection);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_one_owner_check CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1)', k.collection);
        EXECUTE format('CREATE INDEX %1$s_owner_team_idx ON public.%1$I (owner_team_id)', k.collection);
        EXECUTE format('COMMENT ON COLUMN public.%I.owner_team_id IS %L', k.collection,
            format('The team that owns the %s, instead of a person (owner_person_id): at most one of the two is set (%s_one_owner_check). Set only through Transfer ownership (the record-access endpoint); read-only in Data Studio forms. Setting it keeps one owner grant (%s role own) whose derived %s rows give the team''s managers the level manage and its other members edit. ON DELETE RESTRICT: a team that owns records cannot be deleted. Migration 177.', k.noun, k.collection, ta, acc));
        EXECUTE format('COMMENT ON INDEX public.%I IS %L', k.collection || '_owner_team_idx', format('Finds the records a team owns (the team page, the RESTRICT check of a team delete): %s.', k.collection));
        EXECUTE format('COMMENT ON CONSTRAINT %1$s_one_owner_check ON public.%1$I IS %2$L', k.collection, 'A record has a person owner, a team owner or no owner, never both. Migration 177.');

        -- the access level manage, only on a derived row; the owner grant, always trusted
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_role_check', acc);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_role_check CHECK (role IN (''view'', ''edit'', ''manage''))', acc);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_manage_derived_check CHECK (role <> ''manage'' OR team_access_id IS NOT NULL)', acc);
        EXECUTE format('COMMENT ON CONSTRAINT %1$s_manage_derived_check ON public.%1$I IS %2$L', acc, 'The level manage is written only by the team ownership bookkeeping: a derived row (team_access_id set) of an owner grant. Migration 177.');
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_role_check', ta);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_role_check CHECK (role IN (''view'', ''edit'', ''own''))', ta);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_own_trusted_check CHECK (role <> ''own'' OR trust_new_members)', ta);
        EXECUTE format('COMMENT ON CONSTRAINT %1$s_own_trusted_check ON public.%1$I IS %2$L', ta, 'An owner grant (role own) always trusts new members: a joiner of the owning team has Can edit at once and an owner grant never has pending rows. Migration 177.');
        EXECUTE format('COMMENT ON COLUMN public.%I.role IS %L', ta, 'The access level the members get, copied to every derived row: view or edit; or own for the owner grant of a team-owned record (written only by the ownership bookkeeping; its derived rows are manage for a team manager and edit for any other member).');

        -- triggers
        EXECUTE format('CREATE TRIGGER %1$s_owner_team_lock BEFORE INSERT OR UPDATE OF owner_team_id ON public.%1$I FOR EACH STATEMENT EXECUTE FUNCTION d1_private.team_readers_lock()', k.collection);
        EXECUTE format('COMMENT ON TRIGGER %1$s_owner_team_lock ON public.%1$I IS %2$L', k.collection, 'Takes the global readers lock before the statement locks any row when owner_team_id is written (the team foreign key takes KEY SHARE on the team), so a team change or delete cannot deadlock with it (the lock order of migration 176). Migration 177.');
        EXECUTE format('CREATE TRIGGER %1$s_owner_team_ins AFTER INSERT ON public.%1$I FOR EACH ROW WHEN (NEW.owner_team_id IS NOT NULL) EXECUTE FUNCTION d1_private.team_owner_sync(%2$L)', k.collection, k.kind);
        EXECUTE format('CREATE TRIGGER %1$s_owner_team_upd AFTER UPDATE OF owner_team_id ON public.%1$I FOR EACH ROW WHEN (OLD.owner_team_id IS DISTINCT FROM NEW.owner_team_id) EXECUTE FUNCTION d1_private.team_owner_sync(%2$L)', k.collection, k.kind);
        EXECUTE format('CREATE TRIGGER %1$s_own_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION d1_private.team_grant_guard(%2$L)', ta, k.kind);
    END LOOP;
END
$do$;

CREATE TRIGGER team_members_manager_sync
    AFTER UPDATE OF is_manager ON team_members
    FOR EACH ROW WHEN (OLD.is_manager IS DISTINCT FROM NEW.is_manager)
    EXECUTE FUNCTION d1_private.team_manager_sync();

-- 4. The functions of migration 176 that expand grants, now by the derived role.
CREATE OR REPLACE FUNCTION d1_private.team_grant_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k     record;
    acc   text;
    pend  text;
    prev  text := current_setting('d1.team_sync', true);
    rec   uuid;
BEGIN
    PERFORM d1_private.team_lock();
    SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.kind = TG_ARGV[0];
    acc := k.kind || '_access';
    pend := k.kind || '_team_pending';
    PERFORM set_config('d1.team_sync', 'on', true);
    IF TG_OP = 'INSERT' THEN
        rec := (to_jsonb(NEW) ->> k.fk)::uuid;
        EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id)
                        SELECT $1, m.person_id, d1_private.team_derived_role($2, m.is_manager), $3, $4 FROM public.team_members m WHERE m.team_id = $5', acc, k.fk)
            USING rec, NEW.role, NEW.added_by_person_id, NEW.team_access_id, NEW.team_id;
        -- an owner grant (role own) logs no event: Transfer ownership is what the endpoint records
        IF NEW.role <> 'own' THEN
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (NEW.team_id, d1_private.team_actor_person(), 'shared', k.collection, rec,
                    jsonb_build_object('level', NEW.role, 'trust_new_members', NEW.trust_new_members));
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        rec := (to_jsonb(NEW) ->> k.fk)::uuid;
        IF rec IS DISTINCT FROM (to_jsonb(OLD) ->> k.fk)::uuid OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
            RAISE EXCEPTION 'A team grant cannot move to another record or team'
                USING ERRCODE = 'feature_not_supported', TABLE = TG_TABLE_NAME,
                      HINT = 'Remove the team from the record and add it again.';
        END IF;
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            EXECUTE format('UPDATE public.%I SET role = $1 WHERE team_access_id = $2 AND role IS DISTINCT FROM $1', acc)
                USING NEW.role, NEW.team_access_id;
        END IF;
        IF NEW.trust_new_members AND NOT OLD.trust_new_members THEN
            EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id)
                            SELECT $1, p.person_id, $2, $3, $4 FROM public.%I p WHERE p.team_access_id = $4 AND p.state = ''pending''
                            ON CONFLICT DO NOTHING', acc, k.fk, pend)
                USING rec, NEW.role, NEW.added_by_person_id, NEW.team_access_id;
            EXECUTE format('DELETE FROM public.%I WHERE team_access_id = $1 AND state = ''pending''', pend) USING NEW.team_access_id;
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (NEW.team_id, d1_private.team_actor_person(), 'trust_set', k.collection, rec, jsonb_build_object('level', NEW.role));
        ELSIF OLD.trust_new_members AND NOT NEW.trust_new_members THEN
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (NEW.team_id, d1_private.team_actor_person(), 'trust_unset', k.collection, rec, jsonb_build_object('level', NEW.role));
        END IF;
    ELSE
        -- the derived and pending rows go by ON DELETE CASCADE. No event when the team itself is being deleted (its history goes with it), or for an owner grant.
        IF OLD.role <> 'own' AND EXISTS (SELECT 1 FROM teams t WHERE t.team_id = OLD.team_id) THEN
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (OLD.team_id, d1_private.team_actor_person(), 'unshared', k.collection, (to_jsonb(OLD) ->> k.fk)::uuid,
                    jsonb_build_object('level', OLD.role));
        END IF;
    END IF;
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_grant_sync() IS 'Row trigger function of the five <kind>_team_access tables (TG_ARGV[0] = kind), AFTER INSERT / UPDATE / DELETE: an inserted grant gets a derived <kind>_access row (team_access_id set, the grant''s role and added_by_person_id) for every current member of the team and logs shared; a role change is copied to the derived rows; trust_new_members turned on makes the pending rows derived rows (declined rows stay) and logs trust_set, turned off logs trust_unset; a deleted grant logs unshared (its rows go by ON DELETE CASCADE; nothing is logged when the team is being deleted). Moving a grant to another record or team raises feature_not_supported. Writes with d1.team_sync = on. Migration 176; 177 gives an owner grant (role own) a derived row by the member''s manager flag (manage for a team manager, edit for any other member; d1_private.team_derived_role) and logs no shared / unshared event for it.';

CREATE OR REPLACE FUNCTION d1_private.team_member_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k     record;
    ta    text;
    has   boolean;
    prev  text := current_setting('d1.team_sync', true);
BEGIN
    PERFORM d1_private.team_lock();
    PERFORM set_config('d1.team_sync', 'on', true);
    FOR k IN SELECT * FROM d1_private.team_kinds() LOOP
        ta := k.kind || '_team_access';
        IF TG_OP IN ('DELETE', 'UPDATE') THEN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I g WHERE g.team_id = $1)', ta) INTO has USING OLD.team_id;
            IF has THEN
                EXECUTE format('DELETE FROM public.%I a USING public.%I g
                                 WHERE g.team_access_id = a.team_access_id AND g.team_id = $1 AND a.person_id = $2', k.kind || '_access', ta)
                    USING OLD.team_id, OLD.person_id;
                EXECUTE format('DELETE FROM public.%I p USING public.%I g
                                 WHERE g.team_access_id = p.team_access_id AND g.team_id = $1 AND p.person_id = $2', k.kind || '_team_pending', ta)
                    USING OLD.team_id, OLD.person_id;
            END IF;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I g WHERE g.team_id = $1)', ta) INTO has USING NEW.team_id;
            IF has THEN
                EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id)
                                SELECT g.%I, $2, d1_private.team_derived_role(g.role, $3), g.added_by_person_id, g.team_access_id FROM public.%I g
                                 WHERE g.team_id = $1 AND g.trust_new_members
                                ON CONFLICT DO NOTHING', k.kind || '_access', k.fk, k.fk, ta)
                    USING NEW.team_id, NEW.person_id, NEW.is_manager;
                EXECUTE format('INSERT INTO public.%I (team_access_id, person_id, state)
                                SELECT g.team_access_id, $2, ''pending'' FROM public.%I g
                                 WHERE g.team_id = $1 AND NOT g.trust_new_members
                                ON CONFLICT DO NOTHING', k.kind || '_team_pending', ta)
                    USING NEW.team_id, NEW.person_id;
            END IF;
        END IF;
    END LOOP;
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_member_sync() IS 'Row trigger function of team_members, AFTER INSERT / DELETE / UPDATE OF team_id, person_id: a new member gets, for each grant of the team on any of the five record types, a derived <kind>_access row when the grant trusts new members and a pending <kind>_team_pending row otherwise; a removed member loses their derived and pending (and declined) rows for the team''s grants at once; a changed team or person is a removal then an addition. Writes with d1.team_sync = on. Migration 176; 177: the derived row of an owner grant (always trusted) has the role manage for a new member who is a manager and edit otherwise.';

CREATE OR REPLACE FUNCTION d1_private.team_pending_actionable(collection text, team_access_id uuid, person_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    p_coll   text := $1;
    p_ta     uuid := $2;
    p_person uuid := $3;
    k        record;
    g        record;
    login    uuid;
    found_it boolean;
BEGIN
    SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.collection = p_coll;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team_pending_actionable: unknown collection %', coalesce(p_coll, 'NULL') USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- only a pending row is ever actionable (declined is decided)
    EXECUTE format('SELECT g.%I AS rec, g.role FROM public.%I g JOIN public.%I p ON p.team_access_id = g.team_access_id
                     WHERE g.team_access_id = $1 AND p.person_id = $2 AND p.state = ''pending''', k.fk, k.kind || '_team_access', k.kind || '_team_pending')
        INTO g USING p_ta, p_person;
    IF g.rec IS NULL THEN
        RETURN false;
    END IF;
    SELECT l.id INTO login FROM people pe JOIN directus_users l ON l.id = pe.user_id WHERE pe.person_id = p_person;
    IF g.role = 'view' THEN
        -- would raise their access when their login does not read the record yet (a person with no login: always)
        IF login IS NULL THEN
            RETURN true;
        END IF;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I r WHERE r.record_id = $1 AND r.user_id = $2)', k.kind || '_readers')
            INTO found_it USING g.rec, login;
        RETURN NOT found_it;
    END IF;
    IF g.role = 'investigator' THEN
        -- an investigator reads what is in the project, more than a reader of it: unless they are its PI or an investigator already
        -- (an investigator entry of their own or derived, or an old project_investigators row of their login); being a reader is not enough
        RETURN NOT (EXISTS (SELECT 1 FROM projects x WHERE x.project_id = g.rec AND x.principal_investigator_person = p_person)
                 OR EXISTS (SELECT 1 FROM project_access a WHERE a.project_id = g.rec AND a.person_id = p_person AND a.role = 'investigator')
                 OR (login IS NOT NULL AND EXISTS (SELECT 1 FROM project_investigators i WHERE i.project_id = g.rec AND i.user_id = login)));
    END IF;
    -- edit (Ruling D2a): unless they can edit it already under the Lab Member update rules: an edit-level entry of their own or derived,
    -- the record's owner (owner_column), or a sample's co-owner. The PI of the record's project is not an editor, so approving does raise them.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I a WHERE a.%I = $1 AND a.person_id = $2 AND a.role IN (''edit'', ''manage''))
                        OR EXISTS (SELECT 1 FROM public.%I x WHERE x.%I = $1 AND x.%I = $2)',
                   k.kind || '_access', k.fk, k.collection, k.fk, k.owner_column)
        INTO found_it USING g.rec, p_person;
    IF found_it THEN
        RETURN false;
    END IF;
    IF k.kind = 'sample' AND login IS NOT NULL
       AND EXISTS (SELECT 1 FROM sample_co_owners o WHERE o.sample_id = g.rec AND o.user_id = login) THEN
        RETURN false;
    END IF;
    RETURN true;
END
$$;
COMMENT ON FUNCTION d1_private.team_pending_actionable(text, uuid, uuid) IS 'Ruling D2: whether a member waiting on a team grant is worth asking about (shown on Home, in emails, counted as waiting): only a pending row (not declined), and only while approving it would raise the person''s access. A view grant: their login is not in the <kind>_readers table for the record (a person with no login: true). An investigator grant (projects; broader than view, Ruling D2b): they are not the project''s PI and not an investigator of it already (project_access role investigator, their own or derived, or a project_investigators row of their login); being a reader of the project does not count. An edit grant (Ruling D2a): they have no edit-level (edit or manage) <kind>_access row on the record (their own or derived), are not its owner (owner_column of team_kinds) and, for a sample, not a co-owner (sample_co_owners): the people the Lab Member update rules already let edit (the PI of the record''s project is not one of them). False for an unknown grant or person; raises invalid_parameter_value for an unknown collection. Migration 176; 177 counts a manage row (an owning team''s manager) as edit.';

CREATE OR REPLACE FUNCTION d1_private.team_drift()
RETURNS TABLE (collection text, team_access_id uuid, person_id uuid, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k record;
BEGIN
    FOR k IN SELECT * FROM d1_private.team_kinds() LOOP
        RETURN QUERY EXECUTE format($q$
            WITH want AS (
                SELECT g.team_access_id AS ta, g.%2$I AS rec, m.person_id AS pid, d1_private.team_derived_role(g.role, m.is_manager) AS role
                  FROM public.%3$I g JOIN public.team_members m ON m.team_id = g.team_id
                 WHERE NOT EXISTS (SELECT 1 FROM public.%4$I p WHERE p.team_access_id = g.team_access_id AND p.person_id = m.person_id)),
            have AS (
                SELECT a.team_access_id AS ta, a.%2$I AS rec, a.person_id AS pid, a.role FROM public.%1$I a WHERE a.team_access_id IS NOT NULL)
            SELECT %5$L::text, coalesce(w.ta, h.ta), coalesce(w.pid, h.pid),
                   CASE WHEN h.pid IS NULL THEN 'missing' WHEN w.pid IS NULL THEN 'extra' ELSE 'role' END
              FROM want w FULL JOIN have h ON h.ta = w.ta AND h.pid = w.pid AND h.rec = w.rec
             WHERE w.pid IS NULL OR h.pid IS NULL OR w.role IS DISTINCT FROM h.role$q$,
            k.kind || '_access', k.fk, k.kind || '_team_access', k.kind || '_team_pending', k.collection);
        IF k.owner_column = 'owner_person_id' THEN
            -- the owner grants: every team-owned record has exactly one, for its team; an owner grant never has a pending or declined row
            RETURN QUERY EXECUTE format($q$
                SELECT %4$L::text, NULL::uuid, NULL::uuid, 'own_missing'::text
                  FROM public.%1$I r
                 WHERE r.owner_team_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM public.%2$I g WHERE g.%3$I = r.%3$I AND g.team_id = r.owner_team_id AND g.role = 'own')
                UNION ALL
                SELECT %4$L::text, g.team_access_id, NULL::uuid, 'own_extra'::text
                  FROM public.%2$I g
                 WHERE g.role = 'own'
                   AND NOT EXISTS (SELECT 1 FROM public.%1$I r WHERE r.%3$I = g.%3$I AND r.owner_team_id = g.team_id)
                UNION ALL
                SELECT %4$L::text, p.team_access_id, p.person_id, 'own_pending'::text
                  FROM public.%5$I p JOIN public.%2$I g ON g.team_access_id = p.team_access_id
                 WHERE g.role = 'own'$q$,
                k.collection, k.kind || '_team_access', k.fk, k.collection, k.kind || '_team_pending');
        END IF;
    END LOOP;
END
$$;
COMMENT ON FUNCTION d1_private.team_drift() IS 'The derived <kind>_access rows against the team grants and their active members (members with no pending or declined row on the grant), on all five types: missing (an active member has no derived row), extra (a derived row for someone who is not an active member, or on another record than its grant''s), role (a derived row''s role differs from the role its grant gives that member: the grant''s level, or for an owner grant manage for a manager and edit for any other member). On the four ownable types also own_missing (a record has an owner_team_id and no owner grant of that team; team_access_id and person_id are NULL), own_extra (an owner grant whose team is not the record''s owner_team_id; person_id is NULL) and own_pending (an owner grant has a pending or declined row). Empty when the bookkeeping is right. Migrations 176, 177.';

CREATE OR REPLACE FUNCTION d1_private.person_access_list(p uuid, which text)
RETURNS TABLE (collection text, record_id uuid, level text, source text, granted_by text, added_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
    IF which = 'owns' THEN
        -- the records the person owns, the records a team owns where they are a manager, and the projects they are PI of
        RETURN QUERY
        SELECT 'physical_samples'::text, r.sample_id, 'owner'::text, 'owner'::text, NULL::text, NULL::timestamptz
          FROM physical_samples r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'campaigns', r.campaign_id, 'owner', 'owner', NULL, NULL FROM campaigns r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'manufacturing_operations', r.operation_id, 'owner', 'owner', NULL, NULL FROM manufacturing_operations r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'test_sessions', r.session_id, 'owner', 'owner', NULL, NULL FROM test_sessions r WHERE r.owner_person_id = p
        UNION ALL
        -- the records a team owns where the person is one of the team's managers (the owner's powers: share, transfer, restrict, delete)
        SELECT 'physical_samples', r.sample_id, 'owner', 'team_owner', t.name, NULL
          FROM physical_samples r JOIN teams t ON t.team_id = r.owner_team_id
          JOIN team_members m ON m.team_id = r.owner_team_id AND m.person_id = p AND m.is_manager
        UNION ALL
        SELECT 'campaigns', r.campaign_id, 'owner', 'team_owner', t.name, NULL
          FROM campaigns r JOIN teams t ON t.team_id = r.owner_team_id
          JOIN team_members m ON m.team_id = r.owner_team_id AND m.person_id = p AND m.is_manager
        UNION ALL
        SELECT 'manufacturing_operations', r.operation_id, 'owner', 'team_owner', t.name, NULL
          FROM manufacturing_operations r JOIN teams t ON t.team_id = r.owner_team_id
          JOIN team_members m ON m.team_id = r.owner_team_id AND m.person_id = p AND m.is_manager
        UNION ALL
        SELECT 'test_sessions', r.session_id, 'owner', 'team_owner', t.name, NULL
          FROM test_sessions r JOIN teams t ON t.team_id = r.owner_team_id
          JOIN team_members m ON m.team_id = r.owner_team_id AND m.person_id = p AND m.is_manager
        UNION ALL
        SELECT 'projects', r.project_id, 'pi', 'pi', NULL, NULL FROM projects r WHERE r.principal_investigator_person = p
        ORDER BY 1, 2;
    ELSIF which = 'shared' THEN
        -- the person's own view / edit entries on the five access tables (not the rows a team gives them), and the old sample co-owner rows of their login
        RETURN QUERY
        SELECT 'physical_samples'::text, a.sample_id, a.role, 'access'::text, g.full_name, a.created_at
          FROM sample_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'campaigns', a.campaign_id, a.role, 'access', g.full_name, a.created_at
          FROM campaign_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'manufacturing_operations', a.operation_id, a.role, 'access', g.full_name, a.created_at
          FROM operation_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'test_sessions', a.session_id, a.role, 'access', g.full_name, a.created_at
          FROM test_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'projects', a.project_id, a.role, 'access', g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'physical_samples', c.sample_id, 'edit', 'co_owner', NULL, NULL
          FROM sample_co_owners c JOIN people pe ON pe.user_id = c.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSIF which = 'investigator' THEN
        -- the person's own investigator entries on projects (not a team's), and the old junction rows of their login
        RETURN QUERY
        SELECT 'projects'::text, a.project_id, 'investigator'::text, 'access'::text, g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role = 'investigator' AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'projects', i.project_id, 'investigator', 'investigator_junction', NULL, NULL
          FROM project_investigators i JOIN people pe ON pe.user_id = i.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSIF which = 'teams' THEN
        -- the rows the person's teams give them (derived rows), at any level; granted_by is the team's name
        RETURN QUERY
        SELECT 'physical_samples'::text, a.sample_id, a.role, 'team'::text, t.name, a.created_at
          FROM sample_access a JOIN sample_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'campaigns', a.campaign_id, a.role, 'team', t.name, a.created_at
          FROM campaign_access a JOIN campaign_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'manufacturing_operations', a.operation_id, a.role, 'team', t.name, a.created_at
          FROM operation_access a JOIN operation_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'test_sessions', a.session_id, a.role, 'team', t.name, a.created_at
          FROM test_access a JOIN test_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'projects', a.project_id, a.role, 'team', t.name, a.created_at
          FROM project_access a JOIN project_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        ORDER BY 1, 2;
    ELSE
        RAISE EXCEPTION 'person_access_list: which must be owns, shared, investigator or teams, got %', coalesce(which, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
END
$$;
COMMENT ON FUNCTION d1_private.person_access_list(uuid, text) IS 'The records behind one count of d1_private.person_access, for the person panel. which = owns: records with owner_person_id = the person in physical_samples, campaigns, manufacturing_operations and test_sessions (level and source owner), and projects they are PI of (level and source pi); migration 177 adds the records a team owns (owner_team_id) where the person is a manager of that team (level owner, source team_owner, granted_by the team''s name). which = shared: the person''s own view / edit rows in the five *_access tables (team_access_id NULL; source access, granted_by the adder''s full_name, added_at the grant date) and the sample_co_owners rows of the person''s login (source co_owner, level edit). which = investigator: their own project_access rows with role investigator (source access) and project_investigators rows of the person''s login (source investigator_junction). which = teams: the rows their teams give them (derived rows, team_access_id set) at any level (source team, granted_by the team''s name, added_at when the row was made); a record shared with the person and with their team appears under both. Any other value raises invalid_parameter_value. Ordered by collection, then record_id. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migrations 174, 176, 177.';

-- 5. The readers machinery of migration 166: a manage row is an editor like an edit row.
CREATE OR REPLACE FUNCTION d1_private.s_editor(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s AND d1_private.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM public.sample_co_owners o WHERE o.sample_id = s AND o.user_id = u)
        OR EXISTS (SELECT 1 FROM public.sample_access a WHERE a.sample_id = s AND a.role IN ('edit', 'manage') AND d1_private.me(a.person_id, u)));
END
$$;
CREATE OR REPLACE FUNCTION d1_private.campaign_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT c.campaign_id AS record_id, d1_private.person_login(c.owner_person_id) AS user_id FROM campaigns c WHERE c.campaign_id = ANY (ids)
        UNION ALL
        SELECT a.campaign_id, d1_private.person_login(a.person_id) FROM campaign_access a WHERE a.campaign_id = ANY (ids)
        UNION ALL
        SELECT c.campaign_id, d1_private.project_logins(c.project_id, false) FROM campaigns c WHERE c.campaign_id = ANY (ids) AND c.project_id IS NOT NULL
        UNION ALL
        SELECT cs.campaign_id, d1_private.person_login(s.owner_person_id)
          FROM campaign_samples cs JOIN physical_samples s ON s.sample_id = cs.sample_id WHERE cs.campaign_id = ANY (ids)
        UNION ALL
        SELECT cs.campaign_id, l.id FROM campaign_samples cs JOIN sample_co_owners o ON o.sample_id = cs.sample_id JOIN directus_users l ON l.id = o.user_id
         WHERE cs.campaign_id = ANY (ids)
        UNION ALL
        SELECT cs.campaign_id, d1_private.person_login(a.person_id)
          FROM campaign_samples cs JOIN sample_access a ON a.sample_id = cs.sample_id AND a.role IN ('edit', 'manage') WHERE cs.campaign_id = ANY (ids)
    ) q WHERE q.user_id IS NOT NULL $$;
CREATE OR REPLACE FUNCTION d1_private.project_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT p.project_id AS record_id, d1_private.project_logins(p.project_id, false) AS user_id FROM projects p WHERE p.project_id = ANY (ids)
        UNION ALL
        SELECT c.project_id, d1_private.person_login(c.owner_person_id) FROM campaigns c WHERE c.project_id = ANY (ids)
        UNION ALL
        SELECT s.project_id, d1_private.person_login(s.owner_person_id) FROM physical_samples s WHERE s.project_id = ANY (ids)
        UNION ALL
        SELECT s.project_id, l.id FROM physical_samples s JOIN sample_co_owners o ON o.sample_id = s.sample_id JOIN directus_users l ON l.id = o.user_id WHERE s.project_id = ANY (ids)
        UNION ALL
        SELECT s.project_id, d1_private.person_login(a.person_id) FROM physical_samples s JOIN sample_access a ON a.sample_id = s.sample_id AND a.role IN ('edit', 'manage') WHERE s.project_id = ANY (ids)
        UNION ALL
        SELECT o.project_id, d1_private.person_login(o.owner_person_id) FROM manufacturing_operations o WHERE o.project_id = ANY (ids)
        UNION ALL
        SELECT t.project_id, d1_private.person_login(t.owner_person_id) FROM test_sessions t WHERE t.project_id = ANY (ids)
    ) q WHERE q.user_id IS NOT NULL $$;
CREATE OR REPLACE FUNCTION d1_private.readers_of_project(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    -- the unrestricted projects among ids (a restricted project is read by its list alone)
    WITH pr AS MATERIALIZED (SELECT x.project_id FROM projects x WHERE x.project_id = ANY (ids) AND NOT x.restricted),
    -- the samples of those projects: their editors read the project
    ps AS MATERIALIZED (SELECT s.sample_id, s.project_id, s.owner_person_id FROM physical_samples s
                         WHERE s.project_id = ANY (ids) AND EXISTS (SELECT 1 FROM pr WHERE pr.project_id = s.project_id))
    -- the list of the project (PI, investigators, access entries)
    SELECT l.project_id, l.user_id FROM d1_private.v_p_list l WHERE l.project_id = ANY (ids)
    UNION
    -- the owner of a campaign of an unrestricted project (on the campaign's list; the project's gate P passes everyone)
    SELECT c.project_id, lp.user_id FROM campaigns c JOIN pr ON pr.project_id = c.project_id JOIN d1_private.v_login_person lp ON lp.person_id = c.owner_person_id
    UNION
    -- the editors of its samples (on the sample's list)
    SELECT ps.project_id, lp.user_id FROM ps JOIN d1_private.v_login_person lp ON lp.person_id = ps.owner_person_id
    UNION
    SELECT ps.project_id, o.user_id FROM ps JOIN sample_co_owners o ON o.sample_id = ps.sample_id
    UNION
    SELECT ps.project_id, lp.user_id FROM ps JOIN sample_access a ON a.sample_id = ps.sample_id AND a.role IN ('edit', 'manage') JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id
    UNION
    -- the owner of an operation / test in it that they can read: operation_readers / test_readers already hold exactly that (the ordinary
    -- read; sync_readers() recomputes operations and tests before projects, and every operation whose readers could have changed is in its closure)
    SELECT o.project_id, pe.user_id FROM manufacturing_operations o JOIN pr ON pr.project_id = o.project_id
      JOIN people pe ON pe.person_id = o.owner_person_id AND pe.user_id IS NOT NULL
      JOIN operation_readers r ON r.record_id = o.operation_id AND r.user_id = pe.user_id
     WHERE o.project_id = ANY (ids)
    UNION
    SELECT t.project_id, pe.user_id FROM test_sessions t JOIN pr ON pr.project_id = t.project_id
      JOIN people pe ON pe.person_id = t.owner_person_id AND pe.user_id IS NOT NULL
      JOIN test_readers r ON r.record_id = t.session_id AND r.user_id = pe.user_id
     WHERE t.project_id = ANY (ids);
END
$$;
CREATE OR REPLACE VIEW d1_private.v_s_editor AS
    SELECT s.sample_id, lp.user_id FROM public.physical_samples s JOIN d1_private.v_login_person lp ON lp.person_id = s.owner_person_id
    UNION ALL
    SELECT o.sample_id, o.user_id FROM public.sample_co_owners o
    UNION ALL
    SELECT a.sample_id, lp.user_id FROM public.sample_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role IN ('edit', 'manage');
CREATE OR REPLACE VIEW d1_private.v_s_list AS
    SELECT e.sample_id, e.user_id FROM d1_private.v_s_editor e
    UNION ALL
    SELECT a.sample_id, lp.user_id FROM public.sample_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role NOT IN ('edit', 'manage')
    UNION ALL
    SELECT s.sample_id, pi.user_id FROM public.physical_samples s JOIN d1_private.v_p_pi pi ON pi.project_id = s.project_id
    UNION ALL
    SELECT cs.sample_id, pi.user_id FROM public.campaign_samples cs JOIN public.campaigns c ON c.campaign_id = cs.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id;

-- 6. Directus: owner_team_id is a many-to-one to teams, read-only in forms.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES ('physical_samples'), ('manufacturing_operations'), ('test_sessions'), ('campaigns')) AS v (collection)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection = r.collection AND many_field = 'owner_team_id') THEN
            INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
            VALUES (r.collection, 'owner_team_id', 'teams', NULL, 'nullify');
        END IF;
    END LOOP;
END
$$;

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, required, note)
SELECT v.collection, 'owner_team_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{name}}","enableCreate":false}'::json, 'related-values', TRUE, FALSE, 9, 'half', FALSE,
       'The team that owns this record instead of a person; set through Transfer ownership'
FROM (VALUES ('physical_samples'), ('manufacturing_operations'), ('test_sessions'), ('campaigns')) AS v (collection)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields AS f WHERE f.collection = v.collection AND f.field = 'owner_team_id');

-- No grant to d1_llm_readonly (the Ask-the-database role); nobody else calls these directly.
REVOKE ALL ON FUNCTION d1_private.team_derived_role(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_grant_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_owner_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_manager_sync() FROM PUBLIC;

-- migrate:down
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM physical_samples WHERE owner_team_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM manufacturing_operations WHERE owner_team_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM test_sessions WHERE owner_team_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM campaigns WHERE owner_team_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Cannot roll back migration 177: records are owned by a team'
            USING ERRCODE = 'feature_not_supported', HINT = 'Transfer them to a person first (their owner grants and manage rows go with owner_team_id).';
    END IF;
END
$$;

-- 6. Directus.
DELETE FROM directus_fields WHERE field = 'owner_team_id' AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns');
DELETE FROM directus_relations WHERE many_field = 'owner_team_id' AND many_collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns');

-- 5. The readers machinery of migration 166, as it was (the views first: v_s_list reads v_s_editor).
CREATE OR REPLACE VIEW d1_private.v_s_editor AS
    SELECT s.sample_id, lp.user_id FROM public.physical_samples s JOIN d1_private.v_login_person lp ON lp.person_id = s.owner_person_id
    UNION ALL
    SELECT o.sample_id, o.user_id FROM public.sample_co_owners o
    UNION ALL
    SELECT a.sample_id, lp.user_id FROM public.sample_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role = 'edit';
CREATE OR REPLACE VIEW d1_private.v_s_list AS
    SELECT e.sample_id, e.user_id FROM d1_private.v_s_editor e
    UNION ALL
    SELECT a.sample_id, lp.user_id FROM public.sample_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role <> 'edit'
    UNION ALL
    SELECT s.sample_id, pi.user_id FROM public.physical_samples s JOIN d1_private.v_p_pi pi ON pi.project_id = s.project_id
    UNION ALL
    SELECT cs.sample_id, pi.user_id FROM public.campaign_samples cs JOIN public.campaigns c ON c.campaign_id = cs.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id;
CREATE OR REPLACE FUNCTION d1_private.readers_of_project(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    -- the unrestricted projects among ids (a restricted project is read by its list alone)
    WITH pr AS MATERIALIZED (SELECT x.project_id FROM projects x WHERE x.project_id = ANY (ids) AND NOT x.restricted),
    -- the samples of those projects: their editors read the project
    ps AS MATERIALIZED (SELECT s.sample_id, s.project_id, s.owner_person_id FROM physical_samples s
                         WHERE s.project_id = ANY (ids) AND EXISTS (SELECT 1 FROM pr WHERE pr.project_id = s.project_id))
    -- the list of the project (PI, investigators, access entries)
    SELECT l.project_id, l.user_id FROM d1_private.v_p_list l WHERE l.project_id = ANY (ids)
    UNION
    -- the owner of a campaign of an unrestricted project (on the campaign's list; the project's gate P passes everyone)
    SELECT c.project_id, lp.user_id FROM campaigns c JOIN pr ON pr.project_id = c.project_id JOIN d1_private.v_login_person lp ON lp.person_id = c.owner_person_id
    UNION
    -- the editors of its samples (on the sample's list)
    SELECT ps.project_id, lp.user_id FROM ps JOIN d1_private.v_login_person lp ON lp.person_id = ps.owner_person_id
    UNION
    SELECT ps.project_id, o.user_id FROM ps JOIN sample_co_owners o ON o.sample_id = ps.sample_id
    UNION
    SELECT ps.project_id, lp.user_id FROM ps JOIN sample_access a ON a.sample_id = ps.sample_id AND a.role = 'edit' JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id
    UNION
    -- the owner of an operation / test in it that they can read: operation_readers / test_readers already hold exactly that (the ordinary
    -- read; sync_readers() recomputes operations and tests before projects, and every operation whose readers could have changed is in its closure)
    SELECT o.project_id, pe.user_id FROM manufacturing_operations o JOIN pr ON pr.project_id = o.project_id
      JOIN people pe ON pe.person_id = o.owner_person_id AND pe.user_id IS NOT NULL
      JOIN operation_readers r ON r.record_id = o.operation_id AND r.user_id = pe.user_id
     WHERE o.project_id = ANY (ids)
    UNION
    SELECT t.project_id, pe.user_id FROM test_sessions t JOIN pr ON pr.project_id = t.project_id
      JOIN people pe ON pe.person_id = t.owner_person_id AND pe.user_id IS NOT NULL
      JOIN test_readers r ON r.record_id = t.session_id AND r.user_id = pe.user_id
     WHERE t.project_id = ANY (ids);
END
$$;
CREATE OR REPLACE FUNCTION d1_private.project_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT p.project_id AS record_id, d1_private.project_logins(p.project_id, false) AS user_id FROM projects p WHERE p.project_id = ANY (ids)
        UNION ALL
        SELECT c.project_id, d1_private.person_login(c.owner_person_id) FROM campaigns c WHERE c.project_id = ANY (ids)
        UNION ALL
        SELECT s.project_id, d1_private.person_login(s.owner_person_id) FROM physical_samples s WHERE s.project_id = ANY (ids)
        UNION ALL
        SELECT s.project_id, l.id FROM physical_samples s JOIN sample_co_owners o ON o.sample_id = s.sample_id JOIN directus_users l ON l.id = o.user_id WHERE s.project_id = ANY (ids)
        UNION ALL
        SELECT s.project_id, d1_private.person_login(a.person_id) FROM physical_samples s JOIN sample_access a ON a.sample_id = s.sample_id AND a.role = 'edit' WHERE s.project_id = ANY (ids)
        UNION ALL
        SELECT o.project_id, d1_private.person_login(o.owner_person_id) FROM manufacturing_operations o WHERE o.project_id = ANY (ids)
        UNION ALL
        SELECT t.project_id, d1_private.person_login(t.owner_person_id) FROM test_sessions t WHERE t.project_id = ANY (ids)
    ) q WHERE q.user_id IS NOT NULL $$;
CREATE OR REPLACE FUNCTION d1_private.campaign_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT c.campaign_id AS record_id, d1_private.person_login(c.owner_person_id) AS user_id FROM campaigns c WHERE c.campaign_id = ANY (ids)
        UNION ALL
        SELECT a.campaign_id, d1_private.person_login(a.person_id) FROM campaign_access a WHERE a.campaign_id = ANY (ids)
        UNION ALL
        SELECT c.campaign_id, d1_private.project_logins(c.project_id, false) FROM campaigns c WHERE c.campaign_id = ANY (ids) AND c.project_id IS NOT NULL
        UNION ALL
        SELECT cs.campaign_id, d1_private.person_login(s.owner_person_id)
          FROM campaign_samples cs JOIN physical_samples s ON s.sample_id = cs.sample_id WHERE cs.campaign_id = ANY (ids)
        UNION ALL
        SELECT cs.campaign_id, l.id FROM campaign_samples cs JOIN sample_co_owners o ON o.sample_id = cs.sample_id JOIN directus_users l ON l.id = o.user_id
         WHERE cs.campaign_id = ANY (ids)
        UNION ALL
        SELECT cs.campaign_id, d1_private.person_login(a.person_id)
          FROM campaign_samples cs JOIN sample_access a ON a.sample_id = cs.sample_id AND a.role = 'edit' WHERE cs.campaign_id = ANY (ids)
    ) q WHERE q.user_id IS NOT NULL $$;
CREATE OR REPLACE FUNCTION d1_private.s_editor(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s AND d1_private.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM public.sample_co_owners o WHERE o.sample_id = s AND o.user_id = u)
        OR EXISTS (SELECT 1 FROM public.sample_access a WHERE a.sample_id = s AND a.role = 'edit' AND d1_private.me(a.person_id, u)));
END
$$;

-- 4. The functions of migration 176, as they were.
CREATE OR REPLACE FUNCTION d1_private.person_access_list(p uuid, which text)
RETURNS TABLE (collection text, record_id uuid, level text, source text, granted_by text, added_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
    IF which = 'owns' THEN
        -- the records the person owns, and the projects they are PI of
        RETURN QUERY
        SELECT 'physical_samples'::text, r.sample_id, 'owner'::text, 'owner'::text, NULL::text, NULL::timestamptz
          FROM physical_samples r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'campaigns', r.campaign_id, 'owner', 'owner', NULL, NULL FROM campaigns r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'manufacturing_operations', r.operation_id, 'owner', 'owner', NULL, NULL FROM manufacturing_operations r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'test_sessions', r.session_id, 'owner', 'owner', NULL, NULL FROM test_sessions r WHERE r.owner_person_id = p
        UNION ALL
        SELECT 'projects', r.project_id, 'pi', 'pi', NULL, NULL FROM projects r WHERE r.principal_investigator_person = p
        ORDER BY 1, 2;
    ELSIF which = 'shared' THEN
        -- the person's own view / edit entries on the five access tables (not the rows a team gives them), and the old sample co-owner rows of their login
        RETURN QUERY
        SELECT 'physical_samples'::text, a.sample_id, a.role, 'access'::text, g.full_name, a.created_at
          FROM sample_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'campaigns', a.campaign_id, a.role, 'access', g.full_name, a.created_at
          FROM campaign_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'manufacturing_operations', a.operation_id, a.role, 'access', g.full_name, a.created_at
          FROM operation_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'test_sessions', a.session_id, a.role, 'access', g.full_name, a.created_at
          FROM test_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'projects', a.project_id, a.role, 'access', g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit') AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'physical_samples', c.sample_id, 'edit', 'co_owner', NULL, NULL
          FROM sample_co_owners c JOIN people pe ON pe.user_id = c.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSIF which = 'investigator' THEN
        -- the person's own investigator entries on projects (not a team's), and the old junction rows of their login
        RETURN QUERY
        SELECT 'projects'::text, a.project_id, 'investigator'::text, 'access'::text, g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role = 'investigator' AND a.team_access_id IS NULL
        UNION ALL
        SELECT 'projects', i.project_id, 'investigator', 'investigator_junction', NULL, NULL
          FROM project_investigators i JOIN people pe ON pe.user_id = i.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSIF which = 'teams' THEN
        -- the rows the person's teams give them (derived rows), at any level; granted_by is the team's name
        RETURN QUERY
        SELECT 'physical_samples'::text, a.sample_id, a.role, 'team'::text, t.name, a.created_at
          FROM sample_access a JOIN sample_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'campaigns', a.campaign_id, a.role, 'team', t.name, a.created_at
          FROM campaign_access a JOIN campaign_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'manufacturing_operations', a.operation_id, a.role, 'team', t.name, a.created_at
          FROM operation_access a JOIN operation_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'test_sessions', a.session_id, a.role, 'team', t.name, a.created_at
          FROM test_access a JOIN test_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        UNION ALL
        SELECT 'projects', a.project_id, a.role, 'team', t.name, a.created_at
          FROM project_access a JOIN project_team_access g ON g.team_access_id = a.team_access_id JOIN teams t ON t.team_id = g.team_id
         WHERE a.person_id = p
        ORDER BY 1, 2;
    ELSE
        RAISE EXCEPTION 'person_access_list: which must be owns, shared, investigator or teams, got %', coalesce(which, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
END
$$;
COMMENT ON FUNCTION d1_private.person_access_list(uuid, text) IS 'The records behind one count of d1_private.person_access, for the person panel. which = owns: records with owner_person_id = the person in physical_samples, campaigns, manufacturing_operations and test_sessions (level and source owner), and projects they are PI of (level and source pi). which = shared: the person''s own view / edit rows in the five *_access tables (team_access_id NULL; source access, granted_by the adder''s full_name, added_at the grant date) and the sample_co_owners rows of the person''s login (source co_owner, level edit). which = investigator: their own project_access rows with role investigator (source access) and project_investigators rows of the person''s login (source investigator_junction). which = teams: the rows their teams give them (derived rows, team_access_id set) at any level (source team, granted_by the team''s name, added_at when the row was made); a record shared with the person and with their team appears under both. Any other value raises invalid_parameter_value. Ordered by collection, then record_id. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migrations 174, 176.';

CREATE OR REPLACE FUNCTION d1_private.team_drift()
RETURNS TABLE (collection text, team_access_id uuid, person_id uuid, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k record;
BEGIN
    FOR k IN SELECT * FROM d1_private.team_kinds() LOOP
        RETURN QUERY EXECUTE format($q$
            WITH want AS (
                SELECT g.team_access_id AS ta, g.%2$I AS rec, m.person_id AS pid, g.role
                  FROM public.%3$I g JOIN public.team_members m ON m.team_id = g.team_id
                 WHERE NOT EXISTS (SELECT 1 FROM public.%4$I p WHERE p.team_access_id = g.team_access_id AND p.person_id = m.person_id)),
            have AS (
                SELECT a.team_access_id AS ta, a.%2$I AS rec, a.person_id AS pid, a.role FROM public.%1$I a WHERE a.team_access_id IS NOT NULL)
            SELECT %5$L::text, coalesce(w.ta, h.ta), coalesce(w.pid, h.pid),
                   CASE WHEN h.pid IS NULL THEN 'missing' WHEN w.pid IS NULL THEN 'extra' ELSE 'role' END
              FROM want w FULL JOIN have h ON h.ta = w.ta AND h.pid = w.pid AND h.rec = w.rec
             WHERE w.pid IS NULL OR h.pid IS NULL OR w.role IS DISTINCT FROM h.role$q$,
            k.kind || '_access', k.fk, k.kind || '_team_access', k.kind || '_team_pending', k.collection);
    END LOOP;
END
$$;
COMMENT ON FUNCTION d1_private.team_drift() IS 'The derived <kind>_access rows against the team grants and their active members (members with no pending or declined row on the grant), on all five types: missing (an active member has no derived row), extra (a derived row for someone who is not an active member, or on another record than its grant''s), role (a derived row''s role differs from its grant''s). Empty when the bookkeeping is right. Migration 176.';

CREATE OR REPLACE FUNCTION d1_private.team_pending_actionable(collection text, team_access_id uuid, person_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    p_coll   text := $1;
    p_ta     uuid := $2;
    p_person uuid := $3;
    k        record;
    g        record;
    login    uuid;
    found_it boolean;
BEGIN
    SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.collection = p_coll;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team_pending_actionable: unknown collection %', coalesce(p_coll, 'NULL') USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- only a pending row is ever actionable (declined is decided)
    EXECUTE format('SELECT g.%I AS rec, g.role FROM public.%I g JOIN public.%I p ON p.team_access_id = g.team_access_id
                     WHERE g.team_access_id = $1 AND p.person_id = $2 AND p.state = ''pending''', k.fk, k.kind || '_team_access', k.kind || '_team_pending')
        INTO g USING p_ta, p_person;
    IF g.rec IS NULL THEN
        RETURN false;
    END IF;
    SELECT l.id INTO login FROM people pe JOIN directus_users l ON l.id = pe.user_id WHERE pe.person_id = p_person;
    IF g.role = 'view' THEN
        -- would raise their access when their login does not read the record yet (a person with no login: always)
        IF login IS NULL THEN
            RETURN true;
        END IF;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I r WHERE r.record_id = $1 AND r.user_id = $2)', k.kind || '_readers')
            INTO found_it USING g.rec, login;
        RETURN NOT found_it;
    END IF;
    IF g.role = 'investigator' THEN
        -- an investigator reads what is in the project, more than a reader of it: unless they are its PI or an investigator already
        -- (an investigator entry of their own or derived, or an old project_investigators row of their login); being a reader is not enough
        RETURN NOT (EXISTS (SELECT 1 FROM projects x WHERE x.project_id = g.rec AND x.principal_investigator_person = p_person)
                 OR EXISTS (SELECT 1 FROM project_access a WHERE a.project_id = g.rec AND a.person_id = p_person AND a.role = 'investigator')
                 OR (login IS NOT NULL AND EXISTS (SELECT 1 FROM project_investigators i WHERE i.project_id = g.rec AND i.user_id = login)));
    END IF;
    -- edit (Ruling D2a): unless they can edit it already under the Lab Member update rules: an edit-level entry of their own or derived,
    -- the record's owner (owner_column), or a sample's co-owner. The PI of the record's project is not an editor, so approving does raise them.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I a WHERE a.%I = $1 AND a.person_id = $2 AND a.role = ''edit'')
                        OR EXISTS (SELECT 1 FROM public.%I x WHERE x.%I = $1 AND x.%I = $2)',
                   k.kind || '_access', k.fk, k.collection, k.fk, k.owner_column)
        INTO found_it USING g.rec, p_person;
    IF found_it THEN
        RETURN false;
    END IF;
    IF k.kind = 'sample' AND login IS NOT NULL
       AND EXISTS (SELECT 1 FROM sample_co_owners o WHERE o.sample_id = g.rec AND o.user_id = login) THEN
        RETURN false;
    END IF;
    RETURN true;
END
$$;
COMMENT ON FUNCTION d1_private.team_pending_actionable(text, uuid, uuid) IS 'Ruling D2: whether a member waiting on a team grant is worth asking about (shown on Home, in emails, counted as waiting): only a pending row (not declined), and only while approving it would raise the person''s access. A view grant: their login is not in the <kind>_readers table for the record (a person with no login: true). An investigator grant (projects; broader than view, Ruling D2b): they are not the project''s PI and not an investigator of it already (project_access role investigator, their own or derived, or a project_investigators row of their login); being a reader of the project does not count. An edit grant (Ruling D2a): they have no edit-level <kind>_access row on the record (their own or derived), are not its owner (owner_column of team_kinds) and, for a sample, not a co-owner (sample_co_owners): the people the Lab Member update rules already let edit (the PI of the record''s project is not one of them). False for an unknown grant or person; raises invalid_parameter_value for an unknown collection. Migration 176.';

CREATE OR REPLACE FUNCTION d1_private.team_member_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k     record;
    ta    text;
    has   boolean;
    prev  text := current_setting('d1.team_sync', true);
BEGIN
    PERFORM d1_private.team_lock();
    PERFORM set_config('d1.team_sync', 'on', true);
    FOR k IN SELECT * FROM d1_private.team_kinds() LOOP
        ta := k.kind || '_team_access';
        IF TG_OP IN ('DELETE', 'UPDATE') THEN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I g WHERE g.team_id = $1)', ta) INTO has USING OLD.team_id;
            IF has THEN
                EXECUTE format('DELETE FROM public.%I a USING public.%I g
                                 WHERE g.team_access_id = a.team_access_id AND g.team_id = $1 AND a.person_id = $2', k.kind || '_access', ta)
                    USING OLD.team_id, OLD.person_id;
                EXECUTE format('DELETE FROM public.%I p USING public.%I g
                                 WHERE g.team_access_id = p.team_access_id AND g.team_id = $1 AND p.person_id = $2', k.kind || '_team_pending', ta)
                    USING OLD.team_id, OLD.person_id;
            END IF;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I g WHERE g.team_id = $1)', ta) INTO has USING NEW.team_id;
            IF has THEN
                EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id)
                                SELECT g.%I, $2, g.role, g.added_by_person_id, g.team_access_id FROM public.%I g
                                 WHERE g.team_id = $1 AND g.trust_new_members
                                ON CONFLICT DO NOTHING', k.kind || '_access', k.fk, k.fk, ta)
                    USING NEW.team_id, NEW.person_id;
                EXECUTE format('INSERT INTO public.%I (team_access_id, person_id, state)
                                SELECT g.team_access_id, $2, ''pending'' FROM public.%I g
                                 WHERE g.team_id = $1 AND NOT g.trust_new_members
                                ON CONFLICT DO NOTHING', k.kind || '_team_pending', ta)
                    USING NEW.team_id, NEW.person_id;
            END IF;
        END IF;
    END LOOP;
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_member_sync() IS 'Row trigger function of team_members, AFTER INSERT / DELETE / UPDATE OF team_id, person_id: a new member gets, for each grant of the team on any of the five record types, a derived <kind>_access row when the grant trusts new members and a pending <kind>_team_pending row otherwise; a removed member loses their derived and pending (and declined) rows for the team''s grants at once; a changed team or person is a removal then an addition. Writes with d1.team_sync = on. Migration 176.';

CREATE OR REPLACE FUNCTION d1_private.team_grant_sync()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    k     record;
    acc   text;
    pend  text;
    prev  text := current_setting('d1.team_sync', true);
    rec   uuid;
BEGIN
    PERFORM d1_private.team_lock();
    SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.kind = TG_ARGV[0];
    acc := k.kind || '_access';
    pend := k.kind || '_team_pending';
    PERFORM set_config('d1.team_sync', 'on', true);
    IF TG_OP = 'INSERT' THEN
        rec := (to_jsonb(NEW) ->> k.fk)::uuid;
        EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id)
                        SELECT $1, m.person_id, $2, $3, $4 FROM public.team_members m WHERE m.team_id = $5', acc, k.fk)
            USING rec, NEW.role, NEW.added_by_person_id, NEW.team_access_id, NEW.team_id;
        INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
        VALUES (NEW.team_id, d1_private.team_actor_person(), 'shared', k.collection, rec,
                jsonb_build_object('level', NEW.role, 'trust_new_members', NEW.trust_new_members));
    ELSIF TG_OP = 'UPDATE' THEN
        rec := (to_jsonb(NEW) ->> k.fk)::uuid;
        IF rec IS DISTINCT FROM (to_jsonb(OLD) ->> k.fk)::uuid OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
            RAISE EXCEPTION 'A team grant cannot move to another record or team'
                USING ERRCODE = 'feature_not_supported', TABLE = TG_TABLE_NAME,
                      HINT = 'Remove the team from the record and add it again.';
        END IF;
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            EXECUTE format('UPDATE public.%I SET role = $1 WHERE team_access_id = $2 AND role IS DISTINCT FROM $1', acc)
                USING NEW.role, NEW.team_access_id;
        END IF;
        IF NEW.trust_new_members AND NOT OLD.trust_new_members THEN
            EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id)
                            SELECT $1, p.person_id, $2, $3, $4 FROM public.%I p WHERE p.team_access_id = $4 AND p.state = ''pending''
                            ON CONFLICT DO NOTHING', acc, k.fk, pend)
                USING rec, NEW.role, NEW.added_by_person_id, NEW.team_access_id;
            EXECUTE format('DELETE FROM public.%I WHERE team_access_id = $1 AND state = ''pending''', pend) USING NEW.team_access_id;
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (NEW.team_id, d1_private.team_actor_person(), 'trust_set', k.collection, rec, jsonb_build_object('level', NEW.role));
        ELSIF OLD.trust_new_members AND NOT NEW.trust_new_members THEN
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (NEW.team_id, d1_private.team_actor_person(), 'trust_unset', k.collection, rec, jsonb_build_object('level', NEW.role));
        END IF;
    ELSE
        -- the derived and pending rows go by ON DELETE CASCADE. No event when the team itself is being deleted (its history goes with it).
        IF EXISTS (SELECT 1 FROM teams t WHERE t.team_id = OLD.team_id) THEN
            INSERT INTO team_events (team_id, actor_person_id, kind, collection, record_id, detail)
            VALUES (OLD.team_id, d1_private.team_actor_person(), 'unshared', k.collection, (to_jsonb(OLD) ->> k.fk)::uuid,
                    jsonb_build_object('level', OLD.role));
        END IF;
    END IF;
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_grant_sync() IS 'Row trigger function of the five <kind>_team_access tables (TG_ARGV[0] = kind), AFTER INSERT / UPDATE / DELETE: an inserted grant gets a derived <kind>_access row (team_access_id set, the grant''s role and added_by_person_id) for every current member of the team and logs shared; a role change is copied to the derived rows; trust_new_members turned on makes the pending rows derived rows (declined rows stay) and logs trust_set, turned off logs trust_unset; a deleted grant logs unshared (its rows go by ON DELETE CASCADE; nothing is logged when the team is being deleted). Moving a grant to another record or team raises feature_not_supported. Writes with d1.team_sync = on. Migration 176.';

-- 3. Triggers, constraints, columns. The owner grants go first (their derived rows with them: a delete at depth > 1 passes the guard on the access tables).
DROP TRIGGER IF EXISTS team_members_manager_sync ON team_members;
DO $do$
DECLARE
    k   record;
    acc text;
    ta  text;
BEGIN
    FOR k IN SELECT * FROM d1_private.team_kinds() tk WHERE tk.owner_column = 'owner_person_id' LOOP
        acc := k.kind || '_access';
        ta := k.kind || '_team_access';
        EXECUTE format('DROP TRIGGER IF EXISTS %1$s_own_guard ON public.%1$I', ta);
        EXECUTE format('DROP TRIGGER IF EXISTS %1$s_owner_team_upd ON public.%1$I', k.collection);
        EXECUTE format('DROP TRIGGER IF EXISTS %1$s_owner_team_ins ON public.%1$I', k.collection);
        EXECUTE format('DROP TRIGGER IF EXISTS %1$s_owner_team_lock ON public.%1$I', k.collection);
        EXECUTE format('DELETE FROM public.%I WHERE role = ''own''', ta);
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_own_trusted_check', ta);
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_role_check', ta);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_role_check CHECK (role IN (''view'', ''edit''))', ta);
        EXECUTE format('COMMENT ON COLUMN public.%I.role IS %L', ta, format('The access level the members get, copied to every derived row: %s.', array_to_string(k.roles, ' or ')));
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_manage_derived_check', acc);
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_role_check', acc);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_role_check CHECK (role IN (''view'', ''edit''))', acc);
        EXECUTE format('DROP INDEX public.%I', k.collection || '_owner_team_idx');
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_one_owner_check', k.collection);
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_owner_team_id_fkey', k.collection);
        EXECUTE format('ALTER TABLE public.%I DROP COLUMN owner_team_id', k.collection);
    END LOOP;
END
$do$;

-- 2, 1. The new functions.
DROP FUNCTION IF EXISTS d1_private.team_manager_sync();
DROP FUNCTION IF EXISTS d1_private.team_owner_sync();
DROP FUNCTION IF EXISTS d1_private.team_grant_guard();
DROP FUNCTION IF EXISTS d1_private.team_derived_role(text, boolean);
