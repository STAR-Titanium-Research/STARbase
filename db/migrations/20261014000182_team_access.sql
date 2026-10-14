-- migrate:up
-- Team grants (People 2, Task 2; spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md section 2, as ruled by D1 and D2 in
-- docs/superpowers/plans/2026-10-14-people-2-teams.md). A record's owner can give a team access to a record as one entry. The grant is
-- EXPANDED into ordinary <type>_access rows, one per active member, marked by team_access_id ("derived rows"): the readers machinery of
-- migration 166, the Restricted gates and the Lab Member edit filters read access rows by person, so a derived row works exactly like a
-- person's own entry without any rule, alias or filter changing (Ruling D1).
--
--   * <type>_team_access (sample, operation, test, campaign, project): one row per team and record: the access level (role: the same values
--     as <type>_access), trust_new_members, who added it, when. Unique (record, team). Deleted with the record and with the team.
--   * <type>_team_pending: a member who joined the team after the grant, while the grant does not trust new members, waits here
--     (state pending) until someone approves (a derived row is made) or declines (state declined, kept so they are not asked again).
--   * <type>_access.team_access_id: NULL for a person's own entry, the grant for a derived row. A person can have their own entry AND
--     derived rows on one record (one per team), so UNIQUE (record, person) becomes two partial unique indexes: (record, person) WHERE
--     team_access_id IS NULL (same name as the old constraint; an upsert of a person's own entry names it with
--     ON CONFLICT (record, person_id) WHERE team_access_id IS NULL) and (record, person, team_access_id) WHERE team_access_id IS NOT NULL.
--
-- Bookkeeping (row-level AFTER triggers, SECURITY DEFINER; each sets the transaction setting d1.team_sync to 'on' around its writes and puts
-- the previous value back):
--   grant inserted        -> a derived row for every current member (role and added_by of the grant); event shared
--   grant role changed    -> the derived rows take the new role
--   trust off -> on       -> the grant's pending rows become derived rows (declined rows stay); event trust_set (trust_unset the other way)
--   grant deleted         -> derived and pending rows go by ON DELETE CASCADE; event unshared (none when the whole team is being deleted)
--   member added          -> per grant of the team: trusted -> a derived row, otherwise a pending row
--   member removed        -> their derived and pending rows for the team's grants go (an UPDATE of team_id or person_id is leave + join)
--   a grant cannot be moved to another record or team (raises): remove it and add a new one.
-- Each bookkeeping function first takes the global readers lock (d1_private.team_lock; READ COMMITTED only), so a grant and a joiner
-- committed at the same time cannot miss each other.
-- The readers triggers of the access tables fire on the derived rows like on any other row (one recompute per statement: the bookkeeping
-- writes each type in one INSERT ... SELECT / DELETE). Their UPDATE triggers now also compare team_access_id.
--
-- Guard: BEFORE INSERT/UPDATE/DELETE on each <type>_access: touching a row whose old or new team_access_id is set raises 42501 "Team access
-- rows are managed by the team's grant" unless d1.team_sync is 'on', or the write is a foreign-key cascade: inside another trigger
-- (pg_trigger_depth() > 1) a DELETE passes (grant, record, person or team deleted) and so does an UPDATE that keeps team_access_id
-- (added_by_person_id SET NULL); an INSERT never does. A statement from Data Studio, the API or psql runs at depth 1 and is refused. It is a
-- guard against mistakes, not a security boundary: a session that can run SQL can set the flag itself.
--
-- The same guard on the five <type>_team_pending tables (d1_private.team_pending_guard, BEFORE INSERT/UPDATE/DELETE): a pending or declined row
-- is written only by the bookkeeping, team_decide (d1.team_sync = 'on') or a foreign-key cascade (a DELETE at depth > 1: a deleted grant, record,
-- team or person; an UPDATE at depth > 1 that changes only decided_by_person_id, the SET NULL of a deleted person).
--
-- Lock order: BEFORE STATEMENT triggers (<table>_lock_first) on team_members, the five <type>_team_access tables and a DELETE on teams take the
-- global readers lock (d1_private.team_readers_lock: the body of 166's trg_readers_lock, as people_readers_lock does there) before the statement
-- takes any row or foreign-key lock, so a team change (or a team delete, which cascades into grants, members and derived rows) cannot deadlock
-- with a write that holds the readers lock and wants the same people, record or team row.
--
-- Functions (d1_private, SECURITY DEFINER, EXECUTE revoked from PUBLIC, not granted to the Ask-the-database role):
--   team_decide(collection, team_access_id, person_id, 'approve' | 'decline'), team_pending_actionable(collection, team_access_id,
--   person_id) (Ruling D2), team_drift() / team_drift_count() (derived rows against the active members), team_kinds() (the five types).
--   collection is the record's collection: physical_samples, manufacturing_operations, test_sessions, campaigns or projects.
-- People admin (migration 180's three functions, replaced): person_access_list(p, 'teams') lists the derived rows (source team, granted_by
-- the team's name) and 'shared' and 'investigator' leave them out; person_access returns (owns, shared, investigator, teams, waiting)
-- (a new return type: dropped and created); people_attention gains the key former_in_team.
--
-- The ten new tables are audited, not registered in Directus (the record-access and teams endpoints read and write them) and not granted to
-- d1_llm_readonly. Down: puts 180's functions and 166's update trigger functions back, deletes the derived rows, drops the column, the
-- indexes and the new tables and functions, and restores each UNIQUE (record, person_id) constraint under its migration-165 name.
SET LOCAL lock_timeout = '10s';
CREATE SCHEMA IF NOT EXISTS d1_private;

-- 1. The five record types.
CREATE OR REPLACE FUNCTION d1_private.team_kinds()
RETURNS TABLE (kind text, collection text, fk text, owner_column text, roles text[], noun text)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
    VALUES ('sample'::text, 'physical_samples'::text, 'sample_id'::text, 'owner_person_id'::text, ARRAY['view', 'edit']::text[], 'sample'::text),
           ('operation', 'manufacturing_operations', 'operation_id', 'owner_person_id', ARRAY['view', 'edit'], 'manufacturing operation'),
           ('test', 'test_sessions', 'session_id', 'owner_person_id', ARRAY['view', 'edit'], 'test session'),
           ('campaign', 'campaigns', 'campaign_id', 'owner_person_id', ARRAY['view', 'edit'], 'campaign'),
           ('project', 'projects', 'project_id', 'principal_investigator_person', ARRAY['view', 'investigator'], 'project')
$$;
COMMENT ON FUNCTION d1_private.team_kinds() IS 'The five record types a team can be given access to: kind (the table prefix: <kind>_access, <kind>_team_access, <kind>_team_pending, <kind>_readers), collection (the record table), fk (its key column, the same name in the access tables), owner_column (owner_person_id, or principal_investigator_person for projects), roles (the access levels of <kind>_access), noun. Migration 182.';

-- 2. The bookkeeping and guard functions (created before the triggers that call them).

-- One order for every team change: the bookkeeping reads the members of a team (a grant added) or the grants of a team (a member added)
-- and then writes from what it read. Two transactions doing one each (a grant and a joiner, a trust change and a joiner) would each miss the
-- other's uncommitted row and leave a member with neither a derived nor a pending row. So each takes, BEFORE it reads, the global
-- transaction-scoped lock the readers recompute takes anyway (its access-table writes would take it a moment later): the second waits for
-- the first to commit and, under READ COMMITTED, its next statement sees the result.
CREATE OR REPLACE FUNCTION d1_private.team_lock()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Team access bookkeeping needs READ COMMITTED (the transaction is %)', current_setting('transaction_isolation')
            USING ERRCODE = 'feature_not_supported';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('d1_readers', 0));
END
$$;
COMMENT ON FUNCTION d1_private.team_lock() IS 'Called first by the team bookkeeping (team_grant_sync, team_member_sync, team_decide): raises feature_not_supported outside READ COMMITTED, then takes the global readers lock (pg_advisory_xact_lock(hashtextextended(''d1_readers'', 0)), the lock of d1_private.refresh_readers) before anything is read, so concurrent grant, trust, decision and membership changes are applied one after the other and each sees the previous one committed. Migration 182.';

-- The BEFORE STATEMENT lock trigger of team_members and the team grant tables. The same body as 166's d1_private.trg_readers_lock, in a function of
-- its own so that 166's down (which drops trg_readers_lock without CASCADE) is not blocked by triggers of this migration.
CREATE OR REPLACE FUNCTION d1_private.team_readers_lock()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('d1_readers', 0));
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.team_readers_lock() IS 'BEFORE STATEMENT trigger function on team_members and the five <kind>_team_access tables: takes the global readers lock (as d1_private.trg_readers_lock does for people, samples and operations) before the statement takes any row or foreign-key lock, so the lock order is always readers lock, then rows. Migration 182.';

-- The derived rows of a grant follow it.
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
COMMENT ON FUNCTION d1_private.team_grant_sync() IS 'Row trigger function of the five <kind>_team_access tables (TG_ARGV[0] = kind), AFTER INSERT / UPDATE / DELETE: an inserted grant gets a derived <kind>_access row (team_access_id set, the grant''s role and added_by_person_id) for every current member of the team and logs shared; a role change is copied to the derived rows; trust_new_members turned on makes the pending rows derived rows (declined rows stay) and logs trust_set, turned off logs trust_unset; a deleted grant logs unshared (its rows go by ON DELETE CASCADE; nothing is logged when the team is being deleted). Moving a grant to another record or team raises feature_not_supported. Writes with d1.team_sync = on. Migration 182.';

-- A member's derived and pending rows follow their membership.
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
COMMENT ON FUNCTION d1_private.team_member_sync() IS 'Row trigger function of team_members, AFTER INSERT / DELETE / UPDATE OF team_id, person_id: a new member gets, for each grant of the team on any of the five record types, a derived <kind>_access row when the grant trusts new members and a pending <kind>_team_pending row otherwise; a removed member loses their derived and pending (and declined) rows for the team''s grants at once; a changed team or person is a removal then an addition. Writes with d1.team_sync = on. Migration 182.';

-- Derived rows are written only by the bookkeeping.
CREATE OR REPLACE FUNCTION d1_private.team_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    cascade boolean;
BEGIN
    -- a foreign-key cascade runs inside the referential trigger (depth > 1): it may delete a derived row (its grant, record, person or team
    -- went) or update it without touching team_access_id (added_by_person_id SET NULL); it never inserts one
    cascade := pg_trigger_depth() > 1 AND CASE TG_OP
                                               WHEN 'DELETE' THEN true
                                               WHEN 'UPDATE' THEN OLD.team_access_id IS NOT DISTINCT FROM NEW.team_access_id
                                               ELSE false END;
    IF ((TG_OP <> 'INSERT' AND OLD.team_access_id IS NOT NULL) OR (TG_OP <> 'DELETE' AND NEW.team_access_id IS NOT NULL))
       AND coalesce(current_setting('d1.team_sync', true), '') <> 'on'
       AND NOT cascade THEN
        RAISE EXCEPTION 'Team access rows are managed by the team''s grant'
            USING ERRCODE = 'insufficient_privilege', TABLE = TG_TABLE_NAME,
                  DETAIL = 'A row with team_access_id set is derived from a team grant (<type>_team_access): it follows the grant and the team''s members.',
                  HINT = 'Change the team''s grant or its members instead.';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;
COMMENT ON FUNCTION d1_private.team_access_guard() IS 'Row trigger function of the five <kind>_access tables, BEFORE INSERT / UPDATE / DELETE: inserting, changing or deleting a row whose old or new team_access_id is set (a derived row, or turning a person''s own entry into one) raises insufficient_privilege (42501) "Team access rows are managed by the team''s grant", unless the transaction setting d1.team_sync is on (the bookkeeping triggers and team_decide set it) or it is a foreign-key cascade inside another trigger (pg_trigger_depth() > 1): a DELETE (a deleted grant, record, team or person) or an UPDATE that keeps team_access_id (added_by_person_id SET NULL); an INSERT is never let through that way. Rows with team_access_id NULL pass. A guard against edits behind the bookkeeping (Data Studio, the API), not a security boundary. Migration 182.';

-- The pending tables are written only by the bookkeeping (and cascades).
CREATE OR REPLACE FUNCTION d1_private.team_pending_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    cascade boolean;
BEGIN
    -- a foreign-key cascade runs inside the referential trigger (depth > 1): it deletes a row (its grant, record, person or team went) or
    -- sets decided_by_person_id NULL (its decider was deleted); it never inserts one or changes who waits or what they wait for
    cascade := pg_trigger_depth() > 1 AND CASE TG_OP
                                               WHEN 'DELETE' THEN true
                                               WHEN 'UPDATE' THEN OLD.team_access_id = NEW.team_access_id AND OLD.person_id = NEW.person_id
                                                                   AND OLD.state = NEW.state AND OLD.decided_at IS NOT DISTINCT FROM NEW.decided_at
                                               ELSE false END;
    IF coalesce(current_setting('d1.team_sync', true), '') <> 'on' AND NOT cascade THEN
        RAISE EXCEPTION 'Pending team members are managed by the team''s grant'
            USING ERRCODE = 'insufficient_privilege', TABLE = TG_TABLE_NAME,
                  DETAIL = 'A pending or declined row follows the team''s members and the grant''s trust setting (the team bookkeeping and team_decide write it).',
                  HINT = 'Approve or decline through the teams endpoint, or change the team''s members or grant.';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$$;
COMMENT ON FUNCTION d1_private.team_pending_guard() IS 'Row trigger function of the five <kind>_team_pending tables, BEFORE INSERT / UPDATE / DELETE: raises insufficient_privilege (42501) "Pending team members are managed by the team''s grant" unless the transaction setting d1.team_sync is on (the bookkeeping triggers and team_decide set it) or it is a foreign-key cascade inside another trigger (pg_trigger_depth() > 1): a DELETE (a deleted grant, record, team or person) or an UPDATE that changes only decided_by_person_id (SET NULL). An INSERT never passes that way. A guard against edits behind the bookkeeping (Data Studio, the API), not a security boundary. Migration 182.';

-- 3. Tables, the access-table column and indexes, triggers.
DO $do$
DECLARE
    k     record;
    ta    text;
    tp    text;
    acc   text;
    roles text;
BEGIN
    FOR k IN SELECT * FROM d1_private.team_kinds() LOOP
        ta := k.kind || '_team_access';
        tp := k.kind || '_team_pending';
        acc := k.kind || '_access';
        roles := (SELECT string_agg(quote_literal(r), ', ') FROM unnest(k.roles) AS r);

        EXECUTE format($f$
            CREATE TABLE public.%1$I (
                team_access_id UUID NOT NULL DEFAULT gen_random_uuid(),
                %2$I UUID NOT NULL,
                team_id UUID NOT NULL,
                role TEXT NOT NULL,
                trust_new_members BOOLEAN NOT NULL DEFAULT false,
                added_by_person_id UUID,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT %1$s_pkey PRIMARY KEY (team_access_id),
                CONSTRAINT %1$s_%2$s_fkey FOREIGN KEY (%2$I) REFERENCES public.%3$I (%2$I) ON DELETE CASCADE,
                CONSTRAINT %1$s_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams (team_id) ON DELETE CASCADE,
                CONSTRAINT %1$s_added_by_person_id_fkey FOREIGN KEY (added_by_person_id) REFERENCES public.people (person_id) ON DELETE SET NULL,
                CONSTRAINT %1$s_role_check CHECK (role IN (%4$s)),
                CONSTRAINT %1$s_%2$s_team_id_key UNIQUE (%2$I, team_id)
            )$f$, ta, k.fk, k.collection, roles);
        EXECUTE format('CREATE INDEX %1$s_team_idx ON public.%1$I (team_id)', ta);

        EXECUTE format($f$
            CREATE TABLE public.%1$I (
                team_access_id UUID NOT NULL,
                person_id UUID NOT NULL,
                state TEXT NOT NULL,
                decided_by_person_id UUID,
                decided_at TIMESTAMPTZ,
                CONSTRAINT %1$s_pkey PRIMARY KEY (team_access_id, person_id),
                CONSTRAINT %1$s_team_access_id_fkey FOREIGN KEY (team_access_id) REFERENCES public.%2$I (team_access_id) ON DELETE CASCADE,
                CONSTRAINT %1$s_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people (person_id) ON DELETE CASCADE,
                CONSTRAINT %1$s_decided_by_person_id_fkey FOREIGN KEY (decided_by_person_id) REFERENCES public.people (person_id) ON DELETE SET NULL,
                CONSTRAINT %1$s_state_check CHECK (state IN ('pending', 'declined'))
            )$f$, tp, ta);
        EXECUTE format('CREATE INDEX %1$s_person_idx ON public.%1$I (person_id)', tp);

        -- the access table: the column, its foreign key, and the unique key split in two partial unique indexes
        EXECUTE format('ALTER TABLE public.%1$I ADD COLUMN team_access_id UUID', acc);
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_team_access_id_fkey FOREIGN KEY (team_access_id) REFERENCES public.%2$I (team_access_id) ON DELETE CASCADE', acc, ta);
        EXECUTE format('ALTER TABLE public.%1$I DROP CONSTRAINT %1$s_%2$s_person_id_key', acc, k.fk);
        EXECUTE format('CREATE UNIQUE INDEX %1$s_%2$s_person_id_key ON public.%1$I (%2$I, person_id) WHERE team_access_id IS NULL', acc, k.fk);
        EXECUTE format('CREATE UNIQUE INDEX %1$s_%2$s_person_id_team_key ON public.%1$I (%2$I, person_id, team_access_id) WHERE team_access_id IS NOT NULL', acc, k.fk);
        EXECUTE format('CREATE INDEX %1$s_team_access_idx ON public.%1$I (team_access_id) WHERE team_access_id IS NOT NULL', acc);

        -- triggers
        EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function()', ta);
        EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function()', tp);
        EXECUTE format('CREATE TRIGGER %1$s_sync_ins AFTER INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION d1_private.team_grant_sync(%2$L)', ta, k.kind);
        EXECUTE format('CREATE TRIGGER %1$s_sync_upd AFTER UPDATE ON public.%1$I FOR EACH ROW
                          WHEN (OLD.%3$I IS DISTINCT FROM NEW.%3$I OR OLD.team_id IS DISTINCT FROM NEW.team_id
                                OR OLD.role IS DISTINCT FROM NEW.role OR OLD.trust_new_members IS DISTINCT FROM NEW.trust_new_members)
                          EXECUTE FUNCTION d1_private.team_grant_sync(%2$L)', ta, k.kind, k.fk);
        EXECUTE format('CREATE TRIGGER %1$s_sync_del AFTER DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION d1_private.team_grant_sync(%2$L)', ta, k.kind);
        EXECUTE format('CREATE TRIGGER %1$s_team_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION d1_private.team_access_guard()', acc);
        EXECUTE format('CREATE TRIGGER %1$s_team_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION d1_private.team_pending_guard()', tp);
        -- the readers lock before the statement takes any row or foreign-key lock (lock order: readers lock first, as people_readers_lock in 166)
        EXECUTE format('CREATE TRIGGER %1$s_lock_first BEFORE INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH STATEMENT EXECUTE FUNCTION d1_private.team_readers_lock()', ta);
        EXECUTE format('COMMENT ON TRIGGER %1$s_lock_first ON public.%1$I IS %2$L', ta, 'Takes the global readers lock before the statement locks any row (the record and team foreign keys) and before the bookkeeping writes derived rows: otherwise a grant written while another transaction holds the readers lock and wants the same record row (a delete of the record) deadlocks (migration 182).');

        -- comments
        EXECUTE format('COMMENT ON TABLE public.%I IS %L', ta, format('A team''s access to a %s (Ruling D1): expanded into derived %s rows (team_access_id = this row) for every active member of the team, by d1_private.team_grant_sync and team_member_sync. One row per team and %s. Written through the record-access endpoint; audited; not in Directus and not granted to the Ask-the-database role. Deleted with the %s and with the team (and its derived and pending rows with it). Migration 182.', k.noun, acc, k.noun, k.noun));
        EXECUTE format('COMMENT ON COLUMN public.%I.team_access_id IS %L', ta, 'Surrogate key of the team grant; the derived access rows and the pending rows point at it.');
        EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L', ta, k.fk, format('The %s the team has access to (%s.%s). Deleted with it.', k.noun, k.collection, k.fk));
        EXECUTE format('COMMENT ON COLUMN public.%I.team_id IS %L', ta, 'The team (teams.team_id). Deleted with it.');
        EXECUTE format('COMMENT ON COLUMN public.%I.role IS %L', ta, format('The access level the members get, copied to every derived row: %s.', array_to_string(k.roles, ' or ')));
        EXECUTE format('COMMENT ON COLUMN public.%I.trust_new_members IS %L', ta, 'Trust future members: true lets a member who joins later in at once (a derived row); false (the default) makes them pending until someone approves. Members at the time of the grant are always in.');
        EXECUTE format('COMMENT ON COLUMN public.%I.added_by_person_id IS %L', ta, 'The person who gave the team access; copied to the derived rows. NULL when unknown or when that person was deleted (ON DELETE SET NULL).');
        EXECUTE format('COMMENT ON COLUMN public.%I.created_at IS %L', ta, 'When the team was given access.');
        EXECUTE format('COMMENT ON INDEX public.%I IS %L', ta || '_team_idx', 'Finds the grants of one team (a member joining or leaving, the team page).');

        EXECUTE format('COMMENT ON TABLE public.%I IS %L', tp, format('Members of a team who joined after it was given access to a %s, while its grant (%s) does not trust new members: pending until approved (d1_private.team_decide makes a derived %s row and deletes this row) or declined (kept, so they are not asked again; approving later still works). Removed when the member leaves the team, and with the grant and the person. Audited; not granted to the Ask-the-database role. Migration 182.', k.noun, ta, acc));
        EXECUTE format('COMMENT ON COLUMN public.%I.team_access_id IS %L', tp, format('The team grant (%s.team_access_id). Deleted with it.', ta));
        EXECUTE format('COMMENT ON COLUMN public.%I.person_id IS %L', tp, 'The member waiting (people.person_id). Deleted with the person.');
        EXECUTE format('COMMENT ON COLUMN public.%I.state IS %L', tp, 'pending (waiting for a decision) or declined (someone said no; not counted as waiting).');
        EXECUTE format('COMMENT ON COLUMN public.%I.decided_by_person_id IS %L', tp, 'Who declined; NULL while pending, when unknown or when that person was deleted (ON DELETE SET NULL).');
        EXECUTE format('COMMENT ON COLUMN public.%I.decided_at IS %L', tp, 'When it was declined; NULL while pending.');
        EXECUTE format('COMMENT ON INDEX public.%I IS %L', tp || '_person_idx', 'Finds what one person is waiting for (the person panel, Home).');

        EXECUTE format('COMMENT ON COLUMN public.%I.team_access_id IS %L', acc, format('NULL for a person''s own entry. Set on a derived row: the team grant (%s) it comes from. Derived rows are written only by the team bookkeeping (a guard refuses other writes), deleted with their grant; a person can have their own entry and one derived row per team on the same record.', ta));
        EXECUTE format('COMMENT ON INDEX public.%I IS %L', format('%s_%s_person_id_key', acc, k.fk), 'A person has at most one own entry per record (rows with team_access_id NULL). Upserts name it: ON CONFLICT (record, person_id) WHERE team_access_id IS NULL. Was the UNIQUE constraint of the same name before migration 182.');
        EXECUTE format('COMMENT ON INDEX public.%I IS %L', format('%s_%s_person_id_team_key', acc, k.fk), 'A person has at most one derived row per record and team grant.');
        EXECUTE format('COMMENT ON INDEX public.%I IS %L', acc || '_team_access_idx', 'The derived rows of one grant (the cascade of a deleted grant, the role and trust updates).');
    END LOOP;
END
$do$;

CREATE TRIGGER team_members_access_sync_ins
    AFTER INSERT ON team_members
    FOR EACH ROW EXECUTE FUNCTION d1_private.team_member_sync();
CREATE TRIGGER team_members_access_sync_del
    AFTER DELETE ON team_members
    FOR EACH ROW EXECUTE FUNCTION d1_private.team_member_sync();
CREATE TRIGGER team_members_access_sync_upd
    AFTER UPDATE OF team_id, person_id ON team_members
    FOR EACH ROW WHEN (OLD.team_id IS DISTINCT FROM NEW.team_id OR OLD.person_id IS DISTINCT FROM NEW.person_id)
    EXECUTE FUNCTION d1_private.team_member_sync();
CREATE TRIGGER team_members_lock_first
    BEFORE INSERT OR UPDATE OR DELETE ON team_members
    FOR EACH STATEMENT EXECUTE FUNCTION d1_private.team_readers_lock();
CREATE TRIGGER teams_lock_first
    BEFORE DELETE ON teams
    FOR EACH STATEMENT EXECUTE FUNCTION d1_private.team_readers_lock();
COMMENT ON TRIGGER teams_lock_first ON teams IS 'Takes the global readers lock before a DELETE of teams locks any row or cascades into team_members and the grant tables: otherwise deleting a team (which then deletes its members, grants and derived rows) while another transaction holds the readers lock and adds a member or a grant of that team deadlocks (migration 182).';
COMMENT ON TRIGGER team_members_lock_first ON team_members IS 'Takes the global readers lock before the statement locks any row (the team and person foreign keys take KEY SHARE on them) and before team_member_sync writes derived rows: otherwise a member added while another transaction holds the readers lock and updates the person (people.user_id, FOR UPDATE on the row) deadlocks (migration 182).';

-- The access tables now hold own entries and derived team rows.
COMMENT ON TABLE sample_access IS 'Who has access to a sample, by person (a person with no login can be listed; the grant starts working when an admin links the login). A person''s own entry: one row per person and sample (team_access_id NULL), written only through the record-access endpoint (A1a). A team given access adds derived rows (team_access_id set, migration 182): one per member and team grant, written only by the team bookkeeping; audited; no OCC version. Rows go with the sample and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE operation_access IS 'Who has access to a manufacturing operation, by person (a person with no login can be listed; the grant starts working when an admin links the login). A person''s own entry: one row per person and manufacturing operation (team_access_id NULL), written only through the record-access endpoint (A1a). A team given access adds derived rows (team_access_id set, migration 182): one per member and team grant, written only by the team bookkeeping; audited; no OCC version. Rows go with the manufacturing operation and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE test_access IS 'Who has access to a test session, by person (a person with no login can be listed; the grant starts working when an admin links the login). A person''s own entry: one row per person and test session (team_access_id NULL), written only through the record-access endpoint (A1a). A team given access adds derived rows (team_access_id set, migration 182): one per member and team grant, written only by the team bookkeeping; audited; no OCC version. Rows go with the test session and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE campaign_access IS 'Who has access to a campaign, by person (a person with no login can be listed; the grant starts working when an admin links the login). A person''s own entry: one row per person and campaign (team_access_id NULL), written only through the record-access endpoint (A1a). A team given access adds derived rows (team_access_id set, migration 182): one per member and team grant, written only by the team bookkeeping; audited; no OCC version. Rows go with the campaign and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE project_access IS 'Who has access to a project, by person (a person with no login can be listed; the grant starts working when an admin links the login). A person''s own entry: one row per person and project (team_access_id NULL), written only through the record-access endpoint (A1a). A team given access adds derived rows (team_access_id set, migration 182): one per member and team grant, written only by the team bookkeeping; audited; no OCC version. Rows go with the project and with the person (ON DELETE CASCADE).';

-- 4. Deciding on a pending member, whether it is worth asking (Ruling D2), and the drift check.
CREATE OR REPLACE FUNCTION d1_private.team_decide(collection text, team_access_id uuid, person_id uuid, decision text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    p_coll     text := $1;
    p_ta       uuid := $2;
    p_person   uuid := $3;
    p_decision text := $4;
    k          record;
    g          record;
    st         text;
    actor      uuid := d1_private.team_actor_person();
    prev       text := current_setting('d1.team_sync', true);
BEGIN
    IF p_decision IS NULL OR p_decision NOT IN ('approve', 'decline') THEN
        RAISE EXCEPTION 'team_decide: decision must be approve or decline, got %', coalesce(p_decision, 'NULL') USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO k FROM d1_private.team_kinds() tk WHERE tk.collection = p_coll;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team_decide: unknown collection %', coalesce(p_coll, 'NULL') USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM d1_private.team_lock();
    EXECUTE format('SELECT g.%I AS rec, g.team_id, g.role, g.added_by_person_id FROM public.%I g WHERE g.team_access_id = $1', k.fk, k.kind || '_team_access')
        INTO g USING p_ta;
    EXECUTE format('SELECT p.state FROM public.%I p WHERE p.team_access_id = $1 AND p.person_id = $2 FOR UPDATE', k.kind || '_team_pending')
        INTO st USING p_ta, p_person;
    IF st IS NULL OR g.rec IS NULL THEN
        RAISE EXCEPTION 'Nothing to decide: that person is not pending or declined on this team grant'
            USING ERRCODE = 'no_data_found', DETAIL = format('%s grant %s, person %s', p_coll, p_ta, p_person);
    END IF;
    PERFORM set_config('d1.team_sync', 'on', true);
    IF p_decision = 'approve' THEN
        EXECUTE format('DELETE FROM public.%I WHERE team_access_id = $1 AND person_id = $2', k.kind || '_team_pending') USING p_ta, p_person;
        EXECUTE format('INSERT INTO public.%I (%I, person_id, role, added_by_person_id, team_access_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
                       k.kind || '_access', k.fk)
            USING g.rec, p_person, g.role, g.added_by_person_id, p_ta;
    ELSE
        EXECUTE format('UPDATE public.%I SET state = ''declined'', decided_by_person_id = $3, decided_at = now() WHERE team_access_id = $1 AND person_id = $2',
                       k.kind || '_team_pending')
            USING p_ta, p_person, actor;
    END IF;
    INSERT INTO team_events (team_id, actor_person_id, kind, person_id, collection, record_id, detail)
    VALUES (g.team_id, actor, CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'declined' END, p_person, k.collection, g.rec,
            jsonb_build_object('level', g.role, 'was', st));
    PERFORM set_config('d1.team_sync', coalesce(prev, ''), true);
END
$$;
COMMENT ON FUNCTION d1_private.team_decide(text, uuid, uuid, text) IS 'Decide on a member waiting for a team grant: collection is the record''s collection (physical_samples, manufacturing_operations, test_sessions, campaigns, projects), team_access_id the grant, person_id the member, decision approve or decline. approve deletes the pending (or declined) row and inserts the derived <kind>_access row (the grant''s role and added_by); decline sets state declined, decided_by_person_id (the actor of d1.actor_identity) and decided_at. Logs approved or declined (person, record, detail {level, was}). Raises no_data_found when the person has no pending or declined row on the grant, invalid_parameter_value for an unknown collection or decision. The caller checks who may decide. SECURITY DEFINER; not granted to the Ask-the-database role. Migration 182.';

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
COMMENT ON FUNCTION d1_private.team_pending_actionable(text, uuid, uuid) IS 'Ruling D2: whether a member waiting on a team grant is worth asking about (shown on Home, in emails, counted as waiting): only a pending row (not declined), and only while approving it would raise the person''s access. A view grant: their login is not in the <kind>_readers table for the record (a person with no login: true). An investigator grant (projects; broader than view, Ruling D2b): they are not the project''s PI and not an investigator of it already (project_access role investigator, their own or derived, or a project_investigators row of their login); being a reader of the project does not count. An edit grant (Ruling D2a): they have no edit-level <kind>_access row on the record (their own or derived), are not its owner (owner_column of team_kinds) and, for a sample, not a co-owner (sample_co_owners): the people the Lab Member update rules already let edit (the PI of the record''s project is not one of them). False for an unknown grant or person; raises invalid_parameter_value for an unknown collection. Migration 182.';

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
COMMENT ON FUNCTION d1_private.team_drift() IS 'The derived <kind>_access rows against the team grants and their active members (members with no pending or declined row on the grant), on all five types: missing (an active member has no derived row), extra (a derived row for someone who is not an active member, or on another record than its grant''s), role (a derived row''s role differs from its grant''s). Empty when the bookkeeping is right. Migration 182.';

CREATE OR REPLACE FUNCTION d1_private.team_drift_count()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT count(*) FROM d1_private.team_drift() $$;
COMMENT ON FUNCTION d1_private.team_drift_count() IS 'The number of rows d1_private.team_drift() returns (0 when the derived rows match the grants and members). Migration 182.';

-- 5. The readers update triggers of migration 166: a change of team_access_id is a change too.
CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(o.sample_id) || array_agg(n.sample_id)
      INTO v_seed_s
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.sample_id, n.person_id, n.role, n.team_access_id) IS DISTINCT FROM (o.sample_id, o.person_id, o.role, o.team_access_id);
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_access_upd() IS 'Statement trigger function (UPDATE on sample_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage). Migration 182 adds team_access_id to the change test (a derived row turned direct or moved to another grant is recomputed too).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_operation_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
BEGIN
    SELECT array_agg(o.operation_id) || array_agg(n.operation_id)
      INTO v_seed_o
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.operation_id, n.person_id, n.team_access_id) IS DISTINCT FROM (o.operation_id, o.person_id, o.team_access_id);
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_operation_access_upd() IS 'Statement trigger function (UPDATE on operation_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage). Migration 182 adds team_access_id to the change test (a derived row turned direct or moved to another grant is recomputed too).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
BEGIN
    SELECT array_agg(o.session_id) || array_agg(n.session_id)
      INTO v_seed_t
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.session_id, n.person_id, n.team_access_id) IS DISTINCT FROM (o.session_id, o.person_id, o.team_access_id);
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_access_upd() IS 'Statement trigger function (UPDATE on test_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage). Migration 182 adds team_access_id to the change test (a derived row turned direct or moved to another grant is recomputed too).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
BEGIN
    SELECT array_agg(o.campaign_id) || array_agg(n.campaign_id)
      INTO v_seed_c
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.campaign_id, n.person_id, n.team_access_id) IS DISTINCT FROM (o.campaign_id, o.person_id, o.team_access_id);
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_access_upd() IS 'Statement trigger function (UPDATE on campaign_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage). Migration 182 adds team_access_id to the change test (a derived row turned direct or moved to another grant is recomputed too).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_p
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.project_id, n.person_id, n.role, n.team_access_id) IS DISTINCT FROM (o.project_id, o.person_id, o.role, o.team_access_id);
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_access_upd() IS 'Statement trigger function (UPDATE on project_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage). Migration 182 adds team_access_id to the change test (a derived row turned direct or moved to another grant is recomputed too).';

-- 6. People admin (migration 180's functions): the team sources, the waiting count and the former_in_team attention key.
CREATE OR REPLACE FUNCTION d1_private.people_attention()
RETURNS TABLE (key text, person_ids uuid[], user_ids uuid[])
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    WITH
    -- a usable login (active, invited or suspended: what the People page lists) that nobody is linked to; archived and draft ones are not people the lab acts on
    lw AS (
        SELECT u.id FROM directus_users u
         WHERE u.status IN ('active', 'invited', 'suspended') AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.user_id = u.id)
    ),
    -- an invited login that was never accepted, with its person when it has one
    inv AS (
        SELECT u.id AS uid, pe.person_id AS pid
          FROM directus_users u LEFT JOIN people pe ON pe.user_id = u.id
         WHERE u.status = 'invited'
    ),
    -- no email on the person and none on the linked login
    me AS (
        SELECT pe.person_id AS pid
          FROM people pe LEFT JOIN directus_users u ON u.id = pe.user_id
         WHERE nullif(btrim(pe.email), '') IS NULL AND nullif(btrim(u.email), '') IS NULL
    ),
    -- the same normalised full name, or the same email ignoring case
    dup AS (
        SELECT pe.person_id AS pid
          FROM people pe
         WHERE nullif(lower(btrim(pe.full_name)), '') IS NOT NULL
           AND (SELECT count(*) FROM people o WHERE lower(btrim(o.full_name)) = lower(btrim(pe.full_name))) > 1
        UNION
        SELECT pe.person_id
          FROM people pe
         WHERE nullif(lower(btrim(pe.email)), '') IS NOT NULL
           AND (SELECT count(*) FROM people o WHERE lower(btrim(o.email)) = lower(btrim(pe.email))) > 1
    ),
    -- a former person whose login still works
    fla AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe JOIN directus_users u ON u.id = pe.user_id
         WHERE pe.active = false AND u.status = 'active'
    ),
    -- a suspended login whose person still owns records (or is the PI of a project)
    sor AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe JOIN directus_users u ON u.id = pe.user_id
         WHERE u.status = 'suspended'
           AND (EXISTS (SELECT 1 FROM physical_samples r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM campaigns r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM manufacturing_operations r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM test_sessions r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM projects r WHERE r.principal_investigator_person = pe.person_id))
    ),
    -- a former person who is still a member of a team (and so keeps the team's access), with their login when it exists
    fit AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe LEFT JOIN directus_users u ON u.id = pe.user_id
         WHERE pe.active = false AND EXISTS (SELECT 1 FROM team_members m WHERE m.person_id = pe.person_id)
    ),
    items (ord, key, person_ids, user_ids) AS (
        SELECT 1, 'login_without_person'::text, '{}'::uuid[],
               coalesce((SELECT array_agg(lw.id ORDER BY lw.id) FROM lw), '{}')
        UNION ALL
        SELECT 2, 'invite_not_accepted',
               coalesce((SELECT array_agg(inv.pid ORDER BY inv.pid) FILTER (WHERE inv.pid IS NOT NULL) FROM inv), '{}'),
               coalesce((SELECT array_agg(inv.uid ORDER BY inv.uid) FROM inv), '{}')
        UNION ALL
        SELECT 3, 'missing_email', coalesce((SELECT array_agg(me.pid ORDER BY me.pid) FROM me), '{}'), '{}'::uuid[]
        UNION ALL
        SELECT 4, 'possible_duplicate', coalesce((SELECT array_agg(dup.pid ORDER BY dup.pid) FROM dup), '{}'), '{}'::uuid[]
        UNION ALL
        SELECT 5, 'former_login_active',
               coalesce((SELECT array_agg(fla.pid ORDER BY fla.pid) FROM fla), '{}'),
               coalesce((SELECT array_agg(fla.uid ORDER BY fla.uid) FROM fla), '{}')
        UNION ALL
        SELECT 6, 'suspended_owns_records',
               coalesce((SELECT array_agg(sor.pid ORDER BY sor.pid) FROM sor), '{}'),
               coalesce((SELECT array_agg(sor.uid ORDER BY sor.uid) FROM sor), '{}')
        UNION ALL
        SELECT 7, 'former_in_team',
               coalesce((SELECT array_agg(fit.pid ORDER BY fit.pid) FROM fit), '{}'),
               coalesce((SELECT array_agg(fit.uid ORDER BY fit.uid) FILTER (WHERE fit.uid IS NOT NULL) FROM fit), '{}')
    )
    SELECT i.key, i.person_ids, i.user_ids FROM items i
     WHERE cardinality(i.person_ids) > 0 OR cardinality(i.user_ids) > 0
     ORDER BY i.ord
$$;
COMMENT ON FUNCTION d1_private.people_attention() IS 'What needs an administrator''s attention on the People page: one row per key, only keys with at least one hit, in a fixed order. login_without_person (user_ids: active, invited or suspended logins no person is linked to; archived and draft ones are left out, as on the People page), invite_not_accepted (logins with status invited; person_ids are their people, if any), missing_email (people with no email and no email on the linked login), possible_duplicate (people sharing lower(btrim(full_name)) or lower(email)), former_login_active (people.active = false whose linked login is still active), suspended_owns_records (a suspended login whose person owns a sample, campaign, operation or test, or is the PI of a project), former_in_team (people.active = false who are still a member of a team; user_ids are their logins, if any). Count an item by user_ids for login_without_person and invite_not_accepted, by person_ids for the others (former_login_active, suspended_owns_records and former_in_team also fill user_ids with the same people''s logins where they have one). SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migrations 180, 182.';

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
COMMENT ON FUNCTION d1_private.person_access_list(uuid, text) IS 'The records behind one count of d1_private.person_access, for the person panel. which = owns: records with owner_person_id = the person in physical_samples, campaigns, manufacturing_operations and test_sessions (level and source owner), and projects they are PI of (level and source pi). which = shared: the person''s own view / edit rows in the five *_access tables (team_access_id NULL; source access, granted_by the adder''s full_name, added_at the grant date) and the sample_co_owners rows of the person''s login (source co_owner, level edit). which = investigator: their own project_access rows with role investigator (source access) and project_investigators rows of the person''s login (source investigator_junction). which = teams: the rows their teams give them (derived rows, team_access_id set) at any level (source team, granted_by the team''s name, added_at when the row was made); a record shared with the person and with their team appears under both. Any other value raises invalid_parameter_value. Ordered by collection, then record_id. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migrations 180, 182.';

DROP FUNCTION d1_private.person_access(uuid);
CREATE FUNCTION d1_private.person_access(p uuid)
RETURNS TABLE (owns int, shared int, investigator int, teams int, waiting int)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    SELECT (SELECT count(*)::int FROM d1_private.person_access_list(p, 'owns')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'shared')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'investigator')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'teams')),
           (SELECT count(*)::int FROM (
                SELECT 'physical_samples'::text AS c, x.team_access_id FROM sample_team_pending x WHERE x.person_id = p AND x.state = 'pending'
                UNION ALL SELECT 'manufacturing_operations', x.team_access_id FROM operation_team_pending x WHERE x.person_id = p AND x.state = 'pending'
                UNION ALL SELECT 'test_sessions', x.team_access_id FROM test_team_pending x WHERE x.person_id = p AND x.state = 'pending'
                UNION ALL SELECT 'campaigns', x.team_access_id FROM campaign_team_pending x WHERE x.person_id = p AND x.state = 'pending'
                UNION ALL SELECT 'projects', x.team_access_id FROM project_team_pending x WHERE x.person_id = p AND x.state = 'pending') w
             WHERE d1_private.team_pending_actionable(w.c, w.team_access_id, p))
$$;
COMMENT ON FUNCTION d1_private.person_access(uuid) IS 'The counts of the person panel, always one row: owns (records they own in samples, campaigns, operations and tests, plus projects they are PI of), shared (their own view / edit rows in the five *_access tables, plus the sample_co_owners rows of their login), investigator (their own project_access rows with role investigator, plus the project_investigators rows of their login), teams (the access rows their teams give them, any level), waiting (their pending rows on team grants that d1_private.team_pending_actionable says are worth asking about, Ruling D2). The first four count the rows d1_private.person_access_list returns for the same person. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migrations 180, 182 (teams and waiting added: a new return type).';

-- No grant to d1_llm_readonly (the Ask-the-database role); nobody else calls these directly either.
REVOKE ALL ON FUNCTION d1_private.people_attention() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.person_access_list(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.person_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_kinds() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_readers_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_grant_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_member_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_access_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_pending_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_decide(text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_pending_actionable(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_drift() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.team_drift_count() FROM PUBLIC;

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- 1. Migration 180's people-admin functions (person_access goes back to three columns: dropped first).
DROP FUNCTION IF EXISTS d1_private.person_access(uuid);
-- 1. The attention items.
CREATE OR REPLACE FUNCTION d1_private.people_attention()
RETURNS TABLE (key text, person_ids uuid[], user_ids uuid[])
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    WITH
    -- a usable login (active, invited or suspended: what the People page lists) that nobody is linked to; archived and draft ones are not people the lab acts on
    lw AS (
        SELECT u.id FROM directus_users u
         WHERE u.status IN ('active', 'invited', 'suspended') AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.user_id = u.id)
    ),
    -- an invited login that was never accepted, with its person when it has one
    inv AS (
        SELECT u.id AS uid, pe.person_id AS pid
          FROM directus_users u LEFT JOIN people pe ON pe.user_id = u.id
         WHERE u.status = 'invited'
    ),
    -- no email on the person and none on the linked login
    me AS (
        SELECT pe.person_id AS pid
          FROM people pe LEFT JOIN directus_users u ON u.id = pe.user_id
         WHERE nullif(btrim(pe.email), '') IS NULL AND nullif(btrim(u.email), '') IS NULL
    ),
    -- the same normalised full name, or the same email ignoring case
    dup AS (
        SELECT pe.person_id AS pid
          FROM people pe
         WHERE nullif(lower(btrim(pe.full_name)), '') IS NOT NULL
           AND (SELECT count(*) FROM people o WHERE lower(btrim(o.full_name)) = lower(btrim(pe.full_name))) > 1
        UNION
        SELECT pe.person_id
          FROM people pe
         WHERE nullif(lower(btrim(pe.email)), '') IS NOT NULL
           AND (SELECT count(*) FROM people o WHERE lower(btrim(o.email)) = lower(btrim(pe.email))) > 1
    ),
    -- a former person whose login still works
    fla AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe JOIN directus_users u ON u.id = pe.user_id
         WHERE pe.active = false AND u.status = 'active'
    ),
    -- a suspended login whose person still owns records (or is the PI of a project)
    sor AS (
        SELECT pe.person_id AS pid, u.id AS uid
          FROM people pe JOIN directus_users u ON u.id = pe.user_id
         WHERE u.status = 'suspended'
           AND (EXISTS (SELECT 1 FROM physical_samples r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM campaigns r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM manufacturing_operations r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM test_sessions r WHERE r.owner_person_id = pe.person_id)
             OR EXISTS (SELECT 1 FROM projects r WHERE r.principal_investigator_person = pe.person_id))
    ),
    items (ord, key, person_ids, user_ids) AS (
        SELECT 1, 'login_without_person'::text, '{}'::uuid[],
               coalesce((SELECT array_agg(lw.id ORDER BY lw.id) FROM lw), '{}')
        UNION ALL
        SELECT 2, 'invite_not_accepted',
               coalesce((SELECT array_agg(inv.pid ORDER BY inv.pid) FILTER (WHERE inv.pid IS NOT NULL) FROM inv), '{}'),
               coalesce((SELECT array_agg(inv.uid ORDER BY inv.uid) FROM inv), '{}')
        UNION ALL
        SELECT 3, 'missing_email', coalesce((SELECT array_agg(me.pid ORDER BY me.pid) FROM me), '{}'), '{}'::uuid[]
        UNION ALL
        SELECT 4, 'possible_duplicate', coalesce((SELECT array_agg(dup.pid ORDER BY dup.pid) FROM dup), '{}'), '{}'::uuid[]
        UNION ALL
        SELECT 5, 'former_login_active',
               coalesce((SELECT array_agg(fla.pid ORDER BY fla.pid) FROM fla), '{}'),
               coalesce((SELECT array_agg(fla.uid ORDER BY fla.uid) FROM fla), '{}')
        UNION ALL
        SELECT 6, 'suspended_owns_records',
               coalesce((SELECT array_agg(sor.pid ORDER BY sor.pid) FROM sor), '{}'),
               coalesce((SELECT array_agg(sor.uid ORDER BY sor.uid) FROM sor), '{}')
    )
    SELECT i.key, i.person_ids, i.user_ids FROM items i
     WHERE cardinality(i.person_ids) > 0 OR cardinality(i.user_ids) > 0
     ORDER BY i.ord
$$;
COMMENT ON FUNCTION d1_private.people_attention() IS 'What needs an administrator''s attention on the People page: one row per key, only keys with at least one hit, in a fixed order. login_without_person (user_ids: active, invited or suspended logins no person is linked to; archived and draft ones are left out, as on the People page), invite_not_accepted (logins with status invited; person_ids are their people, if any), missing_email (people with no email and no email on the linked login), possible_duplicate (people sharing lower(btrim(full_name)) or lower(email)), former_login_active (people.active = false whose linked login is still active), suspended_owns_records (a suspended login whose person owns a sample, campaign, operation or test, or is the PI of a project). Count an item by user_ids for login_without_person and invite_not_accepted, by person_ids for the others (the person-based keys also fill user_ids with the same people''s logins where they have one). SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migration 180.';

-- 2. The access list of one person: the single source of the counts below.
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
        -- view / edit entries on the five access tables, and the old sample co-owner rows of the person's login
        RETURN QUERY
        SELECT 'physical_samples'::text, a.sample_id, a.role, 'access'::text, g.full_name, a.created_at
          FROM sample_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'campaigns', a.campaign_id, a.role, 'access', g.full_name, a.created_at
          FROM campaign_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'manufacturing_operations', a.operation_id, a.role, 'access', g.full_name, a.created_at
          FROM operation_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'test_sessions', a.session_id, a.role, 'access', g.full_name, a.created_at
          FROM test_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'projects', a.project_id, a.role, 'access', g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role IN ('view', 'edit')
        UNION ALL
        SELECT 'physical_samples', c.sample_id, 'edit', 'co_owner', NULL, NULL
          FROM sample_co_owners c JOIN people pe ON pe.user_id = c.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSIF which = 'investigator' THEN
        -- investigator entries on projects: the access table and the old junction rows of the person's login
        RETURN QUERY
        SELECT 'projects'::text, a.project_id, 'investigator'::text, 'access'::text, g.full_name, a.created_at
          FROM project_access a LEFT JOIN people g ON g.person_id = a.added_by_person_id
         WHERE a.person_id = p AND a.role = 'investigator'
        UNION ALL
        SELECT 'projects', i.project_id, 'investigator', 'investigator_junction', NULL, NULL
          FROM project_investigators i JOIN people pe ON pe.user_id = i.user_id WHERE pe.person_id = p
        ORDER BY 1, 2;
    ELSE
        RAISE EXCEPTION 'person_access_list: which must be owns, shared or investigator, got %', coalesce(which, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
END
$$;
COMMENT ON FUNCTION d1_private.person_access_list(uuid, text) IS 'The records behind one count of d1_private.person_access, for the person panel. which = owns: records with owner_person_id = the person in physical_samples, campaigns, manufacturing_operations and test_sessions (level and source owner), and projects they are PI of (level and source pi). which = shared: view / edit rows of the person in the five *_access tables (source access, granted_by the adder''s full_name, added_at the grant date) and the sample_co_owners rows of the person''s login (source co_owner, level edit). which = investigator: project_access rows with role investigator (source access) and project_investigators rows of the person''s login (source investigator_junction). Any other value raises invalid_parameter_value. Ordered by collection, then record_id. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migration 180.';

-- 3. The three counts.
CREATE OR REPLACE FUNCTION d1_private.person_access(p uuid)
RETURNS TABLE (owns int, shared int, investigator int)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
    SELECT (SELECT count(*)::int FROM d1_private.person_access_list(p, 'owns')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'shared')),
           (SELECT count(*)::int FROM d1_private.person_access_list(p, 'investigator'))
$$;
COMMENT ON FUNCTION d1_private.person_access(uuid) IS 'The three counts of the person panel, always one row: owns (records they own in samples, campaigns, operations and tests, plus projects they are PI of), shared (view / edit rows of theirs in the five *_access tables, plus the sample_co_owners rows of their login), investigator (project_access rows with role investigator, plus the project_investigators rows of their login). Counts the rows d1_private.person_access_list returns for the same person. SECURITY INVOKER, read-only; not granted to the Ask-the-database role. Migration 180.';

-- No grant to d1_llm_readonly (the Ask-the-database role): it must not ask who owns what, who is suspended or whose invite is open.
REVOKE ALL ON FUNCTION d1_private.people_attention() FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.person_access_list(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.person_access(uuid) FROM PUBLIC;

-- 1b. Migration 165's table comments of the access tables.
COMMENT ON TABLE sample_access IS 'Who has access to a sample, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and sample. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the sample and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE operation_access IS 'Who has access to a manufacturing operation, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and manufacturing operation. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the manufacturing operation and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE test_access IS 'Who has access to a test session, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and test session. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the test session and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE campaign_access IS 'Who has access to a campaign, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and campaign. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the campaign and with the person (ON DELETE CASCADE).';
COMMENT ON TABLE project_access IS 'Who has access to a project, by person (a person with no login can be listed; the grant starts working when an admin links the login). One row per person and project. Written only through the record-access endpoint (A1a); audited; no OCC version. Rows go with the project and with the person (ON DELETE CASCADE).';

-- 2. Migration 166's readers update trigger functions.
CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(o.sample_id) || array_agg(n.sample_id)
      INTO v_seed_s
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.sample_id, n.person_id, n.role) IS DISTINCT FROM (o.sample_id, o.person_id, o.role);
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_access_upd() IS 'Statement trigger function (UPDATE on sample_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_operation_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
BEGIN
    SELECT array_agg(o.operation_id) || array_agg(n.operation_id)
      INTO v_seed_o
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.operation_id, n.person_id) IS DISTINCT FROM (o.operation_id, o.person_id);
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_operation_access_upd() IS 'Statement trigger function (UPDATE on operation_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
BEGIN
    SELECT array_agg(o.session_id) || array_agg(n.session_id)
      INTO v_seed_t
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.session_id, n.person_id) IS DISTINCT FROM (o.session_id, o.person_id);
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_access_upd() IS 'Statement trigger function (UPDATE on test_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
BEGIN
    SELECT array_agg(o.campaign_id) || array_agg(n.campaign_id)
      INTO v_seed_c
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.campaign_id, n.person_id) IS DISTINCT FROM (o.campaign_id, o.person_id);
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_access_upd() IS 'Statement trigger function (UPDATE on campaign_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_access_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_p
      FROM old_rows o JOIN new_rows n ON n.access_id = o.access_id
     WHERE (n.project_id, n.person_id, n.role) IS DISTINCT FROM (o.project_id, o.person_id, o.role);
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_access_upd() IS 'Statement trigger function (UPDATE on project_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

-- 3. The bookkeeping triggers, the derived rows, the column and its indexes; each UNIQUE (record, person_id) back under its 165 name.
DROP TRIGGER IF EXISTS team_members_access_sync_ins ON team_members;
DROP TRIGGER IF EXISTS team_members_access_sync_del ON team_members;
DROP TRIGGER IF EXISTS team_members_access_sync_upd ON team_members;
DROP TRIGGER IF EXISTS team_members_lock_first ON team_members;
DROP TRIGGER IF EXISTS teams_lock_first ON teams;
DO $do$
DECLARE
    k   record;
    acc text;
BEGIN
    FOR k IN SELECT * FROM d1_private.team_kinds() LOOP
        acc := k.kind || '_access';
        EXECUTE format('DROP TRIGGER IF EXISTS %1$s_team_guard ON public.%1$I', acc);
        EXECUTE format('DELETE FROM public.%I WHERE team_access_id IS NOT NULL', acc);   -- the readers triggers recompute what they gave
        EXECUTE format('ALTER TABLE public.%I DROP COLUMN team_access_id', acc);          -- its foreign key and the three indexes on it go too
        EXECUTE format('DROP INDEX IF EXISTS public.%I', format('%s_%s_person_id_key', acc, k.fk));
        EXECUTE format('ALTER TABLE public.%1$I ADD CONSTRAINT %1$s_%2$s_person_id_key UNIQUE (%2$I, person_id)', acc, k.fk);
        EXECUTE format('DROP TABLE IF EXISTS public.%I', k.kind || '_team_pending');
        EXECUTE format('DROP TABLE IF EXISTS public.%I', k.kind || '_team_access');
    END LOOP;
END
$do$;

-- 4. The functions.
DROP FUNCTION IF EXISTS d1_private.team_drift_count();
DROP FUNCTION IF EXISTS d1_private.team_drift();
DROP FUNCTION IF EXISTS d1_private.team_pending_actionable(text, uuid, uuid);
DROP FUNCTION IF EXISTS d1_private.team_decide(text, uuid, uuid, text);
DROP FUNCTION IF EXISTS d1_private.team_pending_guard();
DROP FUNCTION IF EXISTS d1_private.team_access_guard();
DROP FUNCTION IF EXISTS d1_private.team_member_sync();
DROP FUNCTION IF EXISTS d1_private.team_grant_sync();
DROP FUNCTION IF EXISTS d1_private.team_lock();
DROP FUNCTION IF EXISTS d1_private.team_readers_lock();
DROP FUNCTION IF EXISTS d1_private.team_kinds();
