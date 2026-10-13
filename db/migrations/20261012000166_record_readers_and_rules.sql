-- migrate:up
-- Record readers (A1a Task 2, redone; spec docs/superpowers/specs/2026-10-12-record-access-design.md sections 2 and 3, rulings 18
-- to 20). The first attempt wrote each record type's read rule as one Directus filter of 76 leaves; on a seeded copy that failed
-- the performance gate (every bare to-many hop is a LEFT JOIN). So WHO CAN READ EACH RECORD is decided once, in SQL, when the
-- data change, stored in per-type readers tables, and the Directus read rule shrinks to one membership test on them:
--
--   * five tables <type>_readers(reader_id identity, record_id -> parent, user_id -> directus_users), UNIQUE (record_id,
--     user_id), index on user_id: sample_readers, operation_readers, test_readers, campaign_readers, project_readers;
--     plus campaign_sample_readers (the junction row's readers), operation_open_to_all (the ownerless runs every member may
--     read: the orphan amnesty, narrowed) and d1_private.hidden_records (what the Ask-the-database role must not see);
--   * d1_private.* functions: the visibility model (me, pi_of, gate_p, gate_c, s_read, rec_read, c_read, pj_read and their
--     helpers: the plain-SQL model scripts/dev/access_matrix_oracle.sql evaluates independently), the candidate sets and
--     readers_of_<type>() on top of them, operation_open_of(), hidden_of(), readers_closure(), refresh_readers(),
--     readers_rebuild(), readers_drift(), readers_drift_count(), is_hidden();
--   * statement-level AFTER triggers with transition tables on every input (the spec's trigger-coverage table), which only say
--     WHICH ids to recompute (no visibility logic in a trigger); refresh_readers() takes ONE global advisory lock before it reads
--     anything, expands the closure, diffs against the tables (never delete-all) and refreshes the project rollup when the
--     hidden set changed. A BEFORE-statement trigger on physical_samples and manufacturing_operations takes the same lock first,
--     and refresh_project_rollup() takes it before its own, so the lock order is always readers lock, then rollup lock (the
--     row triggers of migrations 126, 127 and 157 take the rollup lock during those statements).
--
-- Two intended changes against the first attempt's model, made once, here (spec section 1): the operation/test gate on the
-- sample's campaigns is exact (an operation or test whose sample is campaign-shielded from the caller, with no other way in, is
-- hidden too), and the orphan amnesty is narrowed to runs open to everyone (operation_open_to_all).
--
-- Preflight (data): sample_co_owners.user_id and project_investigators.user_id have no foreign key today, so a deleted login
-- leaves dangling rows the readers function would try to insert as readers. This migration COUNTS and REPORTS them (NOTICE) and
-- adds FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE to both only when the count is 0; with dangling
-- rows it stops with an error that names the cleanup step (scripts/a1_clean_dangling_legacy_logins.sql, runbook
-- docs/runbooks/a1-record-access-cutover.md): clean up first, deliberately, then apply.
--
-- Backfill: ends with SELECT d1_private.readers_rebuild() and a NOTICE of the row counts. Directus reads relations at start-up:
-- restart it (and flush Redis) after applying. Apply TOGETHER WITH 167 and the Task 3 extensions (see the rules part below).
-- Down: rules first (second part), then triggers, functions, tables and metadata; the two foreign keys are dropped.
SET LOCAL lock_timeout = '10s';

-- 1. Preflight: dangling legacy logins, then the two foreign keys.
DO $$
DECLARE
    n_co BIGINT;
    n_pi BIGINT;
BEGIN
    SELECT count(*) INTO n_co FROM sample_co_owners c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id);
    SELECT count(*) INTO n_pi FROM project_investigators i WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = i.user_id);
    RAISE NOTICE 'A1a readers preflight: % dangling sample_co_owners.user_id row(s), % dangling project_investigators.user_id row(s)', n_co, n_pi;
    IF n_co + n_pi > 0 THEN
        RAISE EXCEPTION 'A1a readers: % sample_co_owners row(s) and % project_investigators row(s) name a login that no longer exists (directus_users). Clean them up first with scripts/a1_clean_dangling_legacy_logins.sql (runbook docs/runbooks/a1-record-access-cutover.md, step "dangling legacy logins"), then apply this migration again.', n_co, n_pi
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.sample_co_owners'::regclass AND c.contype = 'f'
                      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sample_co_owners'::regclass AND attname = 'user_id')]) THEN
        ALTER TABLE sample_co_owners ADD CONSTRAINT sample_co_owners_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.project_investigators'::regclass AND c.contype = 'f'
                      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.project_investigators'::regclass AND attname = 'user_id')]) THEN
        ALTER TABLE project_investigators ADD CONSTRAINT project_investigators_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE;
    END IF;
END
$$;

-- 2. The readers tables.
CREATE SCHEMA IF NOT EXISTS d1_private;

CREATE TABLE IF NOT EXISTS sample_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT sample_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT sample_readers_record_id_fkey FOREIGN KEY (record_id) REFERENCES physical_samples (sample_id) ON DELETE CASCADE,
    CONSTRAINT sample_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT sample_readers_record_id_user_id_key UNIQUE (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS sample_readers_user_idx ON sample_readers (user_id);

CREATE TABLE IF NOT EXISTS operation_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT operation_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT operation_readers_record_id_fkey FOREIGN KEY (record_id) REFERENCES manufacturing_operations (operation_id) ON DELETE CASCADE,
    CONSTRAINT operation_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT operation_readers_record_id_user_id_key UNIQUE (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS operation_readers_user_idx ON operation_readers (user_id);

CREATE TABLE IF NOT EXISTS test_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT test_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT test_readers_record_id_fkey FOREIGN KEY (record_id) REFERENCES test_sessions (session_id) ON DELETE CASCADE,
    CONSTRAINT test_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT test_readers_record_id_user_id_key UNIQUE (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS test_readers_user_idx ON test_readers (user_id);

CREATE TABLE IF NOT EXISTS campaign_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT campaign_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT campaign_readers_record_id_fkey FOREIGN KEY (record_id) REFERENCES campaigns (campaign_id) ON DELETE CASCADE,
    CONSTRAINT campaign_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT campaign_readers_record_id_user_id_key UNIQUE (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS campaign_readers_user_idx ON campaign_readers (user_id);

CREATE TABLE IF NOT EXISTS project_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT project_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT project_readers_record_id_fkey FOREIGN KEY (record_id) REFERENCES projects (project_id) ON DELETE CASCADE,
    CONSTRAINT project_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT project_readers_record_id_user_id_key UNIQUE (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_readers_user_idx ON project_readers (user_id);

CREATE TABLE IF NOT EXISTS campaign_sample_readers (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    user_id UUID NOT NULL,
    CONSTRAINT campaign_sample_readers_pkey PRIMARY KEY (reader_id),
    CONSTRAINT campaign_sample_readers_record_id_fkey FOREIGN KEY (record_id) REFERENCES campaign_samples (id) ON DELETE CASCADE,
    CONSTRAINT campaign_sample_readers_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE,
    CONSTRAINT campaign_sample_readers_record_id_user_id_key UNIQUE (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS campaign_sample_readers_user_idx ON campaign_sample_readers (user_id);

CREATE TABLE IF NOT EXISTS operation_open_to_all (
    reader_id BIGINT GENERATED ALWAYS AS IDENTITY,
    record_id UUID NOT NULL,
    CONSTRAINT operation_open_to_all_pkey PRIMARY KEY (reader_id),
    CONSTRAINT operation_open_to_all_record_id_fkey FOREIGN KEY (record_id) REFERENCES manufacturing_operations (operation_id) ON DELETE CASCADE,
    CONSTRAINT operation_open_to_all_record_id_key UNIQUE (record_id)
);

CREATE TABLE IF NOT EXISTS d1_private.hidden_records (
    kind TEXT NOT NULL,
    record_id UUID NOT NULL,
    CONSTRAINT hidden_records_pkey PRIMARY KEY (kind, record_id),
    CONSTRAINT hidden_records_kind_check CHECK (kind IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects'))
);

COMMENT ON TABLE sample_readers IS 'Derived cache (A1a): every login that may read each sample, as decided by d1_private.readers_of_sample(). Kept by statement triggers on the inputs (d1_private.refresh_readers), never written by hand, never audited, not granted to the LLM role. Lab Member reads only its own rows (the Directus read rule of the record type is one membership test on this table). d1_private.readers_drift() finds a difference, readers_rebuild() repairs it.';
COMMENT ON COLUMN sample_readers.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN sample_readers.record_id IS 'The sample (physical_samples.sample_id). Deleted with it.';
COMMENT ON COLUMN sample_readers.user_id IS 'The login (directus_users.id) that may read the sample; a person with no login has no row until the login is linked. Deleted with the login.';
COMMENT ON INDEX sample_readers_user_idx IS 'The membership test: "is user_id a reader" (every Directus read rule of the type and its children).';
COMMENT ON TABLE operation_readers IS 'Derived cache (A1a): every login that may read each manufacturing operation by the ordinary path (the ownerless runs open to everyone are in operation_open_to_all). See sample_readers.';
COMMENT ON COLUMN operation_readers.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN operation_readers.record_id IS 'The manufacturing operation (manufacturing_operations.operation_id). Deleted with it.';
COMMENT ON COLUMN operation_readers.user_id IS 'The login (directus_users.id) that may read the operation. Deleted with the login.';
COMMENT ON INDEX operation_readers_user_idx IS 'The membership test: "is user_id a reader" (every Directus read rule of the type and its children).';
COMMENT ON TABLE test_readers IS 'Derived cache (A1a): every login that may read each test session. See sample_readers.';
COMMENT ON COLUMN test_readers.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN test_readers.record_id IS 'The test session (test_sessions.session_id). Deleted with it.';
COMMENT ON COLUMN test_readers.user_id IS 'The login (directus_users.id) that may read the test session. Deleted with the login.';
COMMENT ON INDEX test_readers_user_idx IS 'The membership test: "is user_id a reader" (every Directus read rule of the type and its children).';
COMMENT ON TABLE campaign_readers IS 'Derived cache (A1a): every login that may read each campaign. See sample_readers.';
COMMENT ON COLUMN campaign_readers.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN campaign_readers.record_id IS 'The campaign (campaigns.campaign_id). Deleted with it.';
COMMENT ON COLUMN campaign_readers.user_id IS 'The login (directus_users.id) that may read the campaign. Deleted with the login.';
COMMENT ON INDEX campaign_readers_user_idx IS 'The membership test: "is user_id a reader" (every Directus read rule of the type and its children).';
COMMENT ON TABLE project_readers IS 'Derived cache (A1a): every login that may read each project. See sample_readers.';
COMMENT ON COLUMN project_readers.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN project_readers.record_id IS 'The project (projects.project_id). Deleted with it.';
COMMENT ON COLUMN project_readers.user_id IS 'The login (directus_users.id) that may read the project. Deleted with the login.';
COMMENT ON INDEX project_readers_user_idx IS 'The membership test: "is user_id a reader" (every Directus read rule of the type and its children).';
COMMENT ON TABLE campaign_sample_readers IS 'Derived cache (A1a): every login that may read each campaign_samples row (readers of its sample, or, for an unrestricted sample, readers of its campaign), so the campaign_samples read rule is one membership test. See sample_readers.';
COMMENT ON COLUMN campaign_sample_readers.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN campaign_sample_readers.record_id IS 'The junction row (campaign_samples.id). Deleted with it.';
COMMENT ON COLUMN campaign_sample_readers.user_id IS 'The login (directus_users.id) that may read the junction row. Deleted with the login.';
COMMENT ON INDEX campaign_sample_readers_user_idx IS 'The membership test: "is user_id a reader".';
COMMENT ON TABLE operation_open_to_all IS 'Derived cache (A1a): the manufacturing operations every member may read, the narrowed orphan amnesty (ownerless legacy FAST runs with no project or campaign, unrestricted, on no restricted sample, and open to everyone). Every Lab Member may read this table; the operations read rule is operation_readers OR a row here.';
COMMENT ON COLUMN operation_open_to_all.reader_id IS 'Surrogate key (Directus needs a single-column key).';
COMMENT ON COLUMN operation_open_to_all.record_id IS 'The manufacturing operation (manufacturing_operations.operation_id), at most once. Deleted with it.';
COMMENT ON TABLE d1_private.hidden_records IS 'Derived cache (A1a): the records the Ask-the-database role must not see (restricted, or under a restricted project, campaign or sample), by collection name and key. Filled by d1_private.hidden_of() inside refresh_readers(); read through d1_private.is_hidden() by the role-level row security of migration 168 and by the project_rollup refresh. Not granted to any role.';
COMMENT ON COLUMN d1_private.hidden_records.kind IS 'The collection: physical_samples, manufacturing_operations, test_sessions, campaigns or projects.';
COMMENT ON COLUMN d1_private.hidden_records.record_id IS 'The record''s primary key (no foreign key: the recompute and the delete triggers remove the rows of records that no longer exist).';

-- 3. The visibility model (the promoted ref.* helpers of scripts/dev/access_matrix_oracle.sql, same shapes). Plain SQL,
-- STABLE, no search_path pin and every object schema-qualified, so the planner inlines them (a SET clause would stop that); only
-- the entry points below pin the path. They read base tables only, never a readers table.

CREATE OR REPLACE FUNCTION d1_private.uniq(a uuid[]) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[]) FROM unnest(a) AS x WHERE x IS NOT NULL $$;
COMMENT ON FUNCTION d1_private.uniq(uuid[]) IS 'The distinct non-null elements of an id array (never NULL: the empty array).';

-- the login of a person (people.user_id), only when that login exists in directus_users: how every candidate query reaches a login
CREATE OR REPLACE FUNCTION d1_private.person_login(person uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT l.id FROM public.people p JOIN public.directus_users l ON l.id = p.user_id WHERE p.person_id = person $$;
COMMENT ON FUNCTION d1_private.person_login(uuid) IS 'The login (directus_users.id) of a person, or NULL when the person has no login (or it was deleted). The candidate queries of readers_of_* reach every login through this inner join, so a dangling user_id is never emitted as a reader.';

-- "me(person)": the person is the login u's
-- The helpers are plpgsql (RETURN (SELECT ...)), not LANGUAGE sql: a SQL function whose body has a subquery is never inlined and is re-planned
-- on every query that calls it, which made a per-pair evaluation of the readers of one project cost 20 ms; plpgsql keeps the plan for the session.
CREATE OR REPLACE FUNCTION d1_private.me(person uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT person IS NOT NULL AND EXISTS (SELECT 1 FROM public.people p WHERE p.person_id = person AND p.user_id = u));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.pi_of(project uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.projects x WHERE x.project_id = project AND d1_private.me(x.principal_investigator_person, u)));
END
$$;

-- on the project's list: the PI, an old investigator row, any access entry
CREATE OR REPLACE FUNCTION d1_private.p_listed(p uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT d1_private.pi_of(p, u)
        OR EXISTS (SELECT 1 FROM public.project_investigators i WHERE i.project_id = p AND i.user_id = u)
        OR EXISTS (SELECT 1 FROM public.project_access a WHERE a.project_id = p AND d1_private.me(a.person_id, u)));
END
$$;

-- an investigator: an old investigator row or an access entry with role investigator (not the PI)
CREATE OR REPLACE FUNCTION d1_private.p_invs(p uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.project_investigators i WHERE i.project_id = p AND i.user_id = u)
        OR EXISTS (SELECT 1 FROM public.project_access a WHERE a.project_id = p AND a.role = 'investigator' AND d1_private.me(a.person_id, u)));
END
$$;

-- P: no project, an unrestricted project, or on its list
CREATE OR REPLACE FUNCTION d1_private.gate_p(p uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT p IS NULL OR EXISTS (SELECT 1 FROM public.projects x WHERE x.project_id = p AND (NOT x.restricted OR d1_private.p_listed(p, u))));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.c_pi(c uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.campaigns x WHERE x.campaign_id = c AND d1_private.pi_of(x.project_id, u)));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.c_listed(c uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.campaigns x WHERE x.campaign_id = c AND d1_private.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM public.campaign_access a WHERE a.campaign_id = c AND d1_private.me(a.person_id, u))
        OR d1_private.c_pi(c, u));
END
$$;

-- C: no campaign, or (unrestricted or on its list) and its project lets the caller in
CREATE OR REPLACE FUNCTION d1_private.gate_c(c uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT c IS NULL OR EXISTS (SELECT 1 FROM public.campaigns x WHERE x.campaign_id = c
                                   AND (NOT x.restricted OR d1_private.c_listed(c, u)) AND d1_private.gate_p(x.project_id, u)));
END
$$;

-- on a sample's list: owner, co-owner, access entry, PI of its project, PI of a campaign's project
CREATE OR REPLACE FUNCTION d1_private.s_listed(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s
                      AND (d1_private.me(x.owner_person_id, u) OR d1_private.pi_of(x.project_id, u)))
        OR EXISTS (SELECT 1 FROM public.sample_co_owners o WHERE o.sample_id = s AND o.user_id = u)
        OR EXISTS (SELECT 1 FROM public.sample_access a WHERE a.sample_id = s AND d1_private.me(a.person_id, u))
        OR EXISTS (SELECT 1 FROM public.campaign_samples cs WHERE cs.sample_id = s AND d1_private.c_pi(cs.campaign_id, u)));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.gate_s(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT s IS NULL OR EXISTS (SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s AND (NOT x.restricted OR d1_private.s_listed(s, u))));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.s_editor(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s AND d1_private.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM public.sample_co_owners o WHERE o.sample_id = s AND o.user_id = u)
        OR EXISTS (SELECT 1 FROM public.sample_access a WHERE a.sample_id = s AND a.role = 'edit' AND d1_private.me(a.person_id, u)));
END
$$;

-- campaign-shielded from u (ruling 19): the sample is in at least one campaign and no campaign of it lets u in
CREATE OR REPLACE FUNCTION d1_private.s_shielded(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.campaign_samples cs WHERE cs.sample_id = s)
       AND NOT EXISTS (SELECT 1 FROM public.campaign_samples cs WHERE cs.sample_id = s AND d1_private.gate_c(cs.campaign_id, u)));
END
$$;

-- S*: the gate an operation or test passes on its sample: no sample; or the sample is unrestricted or lists u, AND (u is on the
-- sample's list, or investigates the sample's own project, or the sample is not campaign-shielded from u)
CREATE OR REPLACE FUNCTION d1_private.gate_s_star(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT s IS NULL OR EXISTS (SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s
                                   AND (NOT x.restricted OR d1_private.s_listed(s, u))
                                   AND (d1_private.s_listed(s, u) OR d1_private.p_invs(x.project_id, u) OR NOT d1_private.s_shielded(s, u))));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.s_read(s uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (
        SELECT 1 FROM public.physical_samples x WHERE x.sample_id = s AND (
            d1_private.s_listed(s, u)
            OR (NOT x.restricted AND (
                d1_private.p_invs(x.project_id, u)
                OR EXISTS (SELECT 1 FROM public.campaign_samples cs JOIN public.campaigns c ON c.campaign_id = cs.campaign_id
                            WHERE cs.sample_id = s
                              AND ((d1_private.me(c.owner_person_id, u) AND d1_private.gate_p(c.project_id, u))
                                   OR (NOT c.restricted AND d1_private.p_invs(c.project_id, u)))))))));
END
$$;

-- operations and tests: the gates (S*, P of the sample's project, P of its project, C), then the record's own rule
CREATE OR REPLACE FUNCTION d1_private.rec_gates(sample uuid, project uuid, campaign uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT d1_private.gate_s_star(sample, u)
       AND (sample IS NULL OR d1_private.gate_p((SELECT x.project_id FROM public.physical_samples x WHERE x.sample_id = sample), u))
       AND d1_private.gate_p(project, u)
       AND d1_private.gate_c(campaign, u));
END
$$;

-- the ordinary read of an operation or test (the orphan amnesty is operation_open_of, not part of it)
CREATE OR REPLACE FUNCTION d1_private.rec_read(restricted boolean, owner uuid, project uuid, campaign uuid, sample uuid, acc_any boolean, u uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT d1_private.rec_gates(sample, project, campaign, u) AND (
                d1_private.me(owner, u) OR acc_any OR d1_private.pi_of(project, u) OR d1_private.c_pi(campaign, u)
                OR (NOT restricted AND (
                    d1_private.s_read(sample, u) OR d1_private.p_invs(project, u)
                    OR EXISTS (SELECT 1 FROM public.campaigns c WHERE c.campaign_id = campaign
                                  AND (d1_private.me(c.owner_person_id, u) OR d1_private.p_invs(c.project_id, u)))))));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.can_read_sample(id uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT d1_private.s_read(id, u));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.can_read_operation(id uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT d1_private.rec_read(x.restricted, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id,
                               EXISTS (SELECT 1 FROM public.operation_access a WHERE a.operation_id = x.operation_id AND d1_private.me(a.person_id, u)), u)
      FROM public.manufacturing_operations x WHERE x.operation_id = id);
END
$$;

CREATE OR REPLACE FUNCTION d1_private.can_read_test(id uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT d1_private.rec_read(x.restricted, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id,
                               EXISTS (SELECT 1 FROM public.test_access a WHERE a.session_id = x.session_id AND d1_private.me(a.person_id, u)), u)
      FROM public.test_sessions x WHERE x.session_id = id);
END
$$;

CREATE OR REPLACE FUNCTION d1_private.can_read_campaign(c uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (
        SELECT 1 FROM public.campaigns x WHERE x.campaign_id = c AND d1_private.gate_p(x.project_id, u) AND (
            d1_private.c_listed(c, u)
            OR (NOT x.restricted AND (
                d1_private.p_invs(x.project_id, u)
                OR EXISTS (SELECT 1 FROM public.campaign_samples cs WHERE cs.campaign_id = c AND d1_private.s_editor(cs.sample_id, u)))))));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.can_read_project(p uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (
        SELECT 1 FROM public.projects x WHERE x.project_id = p AND (
            d1_private.p_listed(p, u)
            OR (NOT x.restricted AND (
                EXISTS (SELECT 1 FROM public.campaigns c WHERE c.project_id = p AND d1_private.me(c.owner_person_id, u) AND d1_private.can_read_campaign(c.campaign_id, u))
                OR EXISTS (SELECT 1 FROM public.physical_samples s WHERE s.project_id = p AND d1_private.s_editor(s.sample_id, u) AND d1_private.s_read(s.sample_id, u))
                OR EXISTS (SELECT 1 FROM public.manufacturing_operations o WHERE o.project_id = p AND d1_private.me(o.owner_person_id, u) AND d1_private.can_read_operation(o.operation_id, u))
                OR EXISTS (SELECT 1 FROM public.test_sessions t WHERE t.project_id = p AND d1_private.me(t.owner_person_id, u) AND d1_private.can_read_test(t.session_id, u)))))));
END
$$;

-- a campaign_samples row: readers of its sample, or (the sample unrestricted and) readers of its campaign
CREATE OR REPLACE FUNCTION d1_private.can_read_campaign_sample(j uuid, u uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.campaign_samples cs JOIN public.physical_samples s ON s.sample_id = cs.sample_id
                    WHERE cs.id = j AND (d1_private.s_read(cs.sample_id, u) OR (NOT s.restricted AND d1_private.can_read_campaign(cs.campaign_id, u)))));
END
$$;

-- hidden from the Ask-the-database role (spec section 7): written straight from the flags
CREATE OR REPLACE FUNCTION d1_private.campaign_hidden(c uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.campaigns x LEFT JOIN public.projects p ON p.project_id = x.project_id
                    WHERE x.campaign_id = c AND (x.restricted OR coalesce(p.restricted, false))));
END
$$;

CREATE OR REPLACE FUNCTION d1_private.sample_hidden(s uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN (SELECT EXISTS (SELECT 1 FROM public.physical_samples x LEFT JOIN public.projects p ON p.project_id = x.project_id
                    WHERE x.sample_id = s
                      AND (x.restricted OR coalesce(p.restricted, false)
                           OR EXISTS (SELECT 1 FROM public.campaign_samples cs WHERE cs.sample_id = s AND d1_private.campaign_hidden(cs.campaign_id)))));
END
$$;

-- 4. Candidates: for each record the union of every login the positive paths can reach. Every branch reaches a login through an
-- inner join to directus_users (person_login(), or the join itself for the legacy user_id columns). The per-pair predicate
-- (can_read_*) then keeps the ones that pass; readers_of_* never cross records with users.

-- the logins of the project of each project-bound row: PI, old investigator rows, access entries (any role / investigator only)
CREATE OR REPLACE FUNCTION d1_private.project_logins(p uuid, only_investigators boolean) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
    SELECT d1_private.person_login(x.principal_investigator_person) FROM public.projects x WHERE x.project_id = p AND NOT only_investigators
    UNION
    SELECT l.id FROM public.project_investigators i JOIN public.directus_users l ON l.id = i.user_id WHERE i.project_id = p
    UNION
    SELECT d1_private.person_login(a.person_id) FROM public.project_access a WHERE a.project_id = p AND (NOT only_investigators OR a.role = 'investigator') $$;
COMMENT ON FUNCTION d1_private.project_logins(uuid, boolean) IS 'The logins on a project: the PI, the old investigator rows and the access entries (only_investigators: just the investigators, not the PI and not the Can view entries). Inner join to directus_users.';

CREATE OR REPLACE FUNCTION d1_private.sample_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT s.sample_id AS record_id, d1_private.person_login(s.owner_person_id) AS user_id
          FROM physical_samples s WHERE s.sample_id = ANY (ids)
        UNION ALL
        SELECT o.sample_id, l.id FROM sample_co_owners o JOIN directus_users l ON l.id = o.user_id WHERE o.sample_id = ANY (ids)
        UNION ALL
        SELECT a.sample_id, d1_private.person_login(a.person_id) FROM sample_access a WHERE a.sample_id = ANY (ids)
        UNION ALL
        SELECT s.sample_id, d1_private.project_logins(s.project_id, false) FROM physical_samples s WHERE s.sample_id = ANY (ids) AND s.project_id IS NOT NULL
        UNION ALL
        SELECT cs.sample_id, d1_private.person_login(c.owner_person_id)
          FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id WHERE cs.sample_id = ANY (ids)
        UNION ALL
        SELECT cs.sample_id, d1_private.project_logins(c.project_id, false)
          FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id WHERE cs.sample_id = ANY (ids) AND c.project_id IS NOT NULL
    ) q WHERE q.user_id IS NOT NULL $$;
COMMENT ON FUNCTION d1_private.sample_candidates(uuid[]) IS 'Candidate readers of each sample: its owner, co-owners, access entries, the logins of its project (PI, investigators, access entries) and of its campaigns'' owners and projects. A superset of readers_of_sample(); every login through an inner join to directus_users.';

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
COMMENT ON FUNCTION d1_private.campaign_candidates(uuid[]) IS 'Candidate readers of each campaign: its owner, access entries, the logins of its project, and the editors of its samples (owner, co-owners, Can edit entries). A superset of readers_of_campaign().';

CREATE OR REPLACE FUNCTION d1_private.operation_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT o.operation_id AS record_id, d1_private.person_login(o.owner_person_id) AS user_id FROM manufacturing_operations o WHERE o.operation_id = ANY (ids)
        UNION ALL
        SELECT a.operation_id, d1_private.person_login(a.person_id) FROM operation_access a WHERE a.operation_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, d1_private.person_login(p.principal_investigator_person)
          FROM manufacturing_operations o JOIN projects p ON p.project_id = o.project_id WHERE o.operation_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, d1_private.person_login(p.principal_investigator_person)
          FROM manufacturing_operations o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN projects p ON p.project_id = c.project_id WHERE o.operation_id = ANY (ids)
        UNION ALL
        -- the inherited paths exist only for an unrestricted operation
        SELECT o.operation_id, d1_private.project_logins(o.project_id, true) FROM manufacturing_operations o
         WHERE o.operation_id = ANY (ids) AND NOT o.restricted AND o.project_id IS NOT NULL
        UNION ALL
        SELECT o.operation_id, d1_private.person_login(c.owner_person_id) FROM manufacturing_operations o JOIN campaigns c ON c.campaign_id = o.campaign_id
         WHERE o.operation_id = ANY (ids) AND NOT o.restricted
        UNION ALL
        SELECT o.operation_id, d1_private.project_logins(c.project_id, true) FROM manufacturing_operations o JOIN campaigns c ON c.campaign_id = o.campaign_id
         WHERE o.operation_id = ANY (ids) AND NOT o.restricted AND c.project_id IS NOT NULL
        UNION ALL
        SELECT o.operation_id, sc.user_id FROM manufacturing_operations o JOIN d1_private.sample_candidates(
            ARRAY(SELECT DISTINCT x.sample_id FROM manufacturing_operations x WHERE x.operation_id = ANY (ids) AND NOT x.restricted AND x.sample_id IS NOT NULL)) sc
            ON sc.record_id = o.sample_id
         WHERE o.operation_id = ANY (ids) AND NOT o.restricted
    ) q WHERE q.user_id IS NOT NULL $$;
COMMENT ON FUNCTION d1_private.operation_candidates(uuid[]) IS 'Candidate readers of each operation: owner, access entries, the PI of its project and of its campaign''s project and, unless restricted, the investigators of its project and its campaign''s project, the campaign''s owner and the candidates of its sample. A superset of readers_of_operation().';

CREATE OR REPLACE FUNCTION d1_private.test_candidates(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT o.session_id AS record_id, d1_private.person_login(o.owner_person_id) AS user_id FROM test_sessions o WHERE o.session_id = ANY (ids)
        UNION ALL
        SELECT a.session_id, d1_private.person_login(a.person_id) FROM test_access a WHERE a.session_id = ANY (ids)
        UNION ALL
        SELECT o.session_id, d1_private.person_login(p.principal_investigator_person)
          FROM test_sessions o JOIN projects p ON p.project_id = o.project_id WHERE o.session_id = ANY (ids)
        UNION ALL
        SELECT o.session_id, d1_private.person_login(p.principal_investigator_person)
          FROM test_sessions o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN projects p ON p.project_id = c.project_id WHERE o.session_id = ANY (ids)
        UNION ALL
        SELECT o.session_id, d1_private.project_logins(o.project_id, true) FROM test_sessions o
         WHERE o.session_id = ANY (ids) AND NOT o.restricted AND o.project_id IS NOT NULL
        UNION ALL
        SELECT o.session_id, d1_private.person_login(c.owner_person_id) FROM test_sessions o JOIN campaigns c ON c.campaign_id = o.campaign_id
         WHERE o.session_id = ANY (ids) AND NOT o.restricted
        UNION ALL
        SELECT o.session_id, d1_private.project_logins(c.project_id, true) FROM test_sessions o JOIN campaigns c ON c.campaign_id = o.campaign_id
         WHERE o.session_id = ANY (ids) AND NOT o.restricted AND c.project_id IS NOT NULL
        UNION ALL
        SELECT o.session_id, sc.user_id FROM test_sessions o JOIN d1_private.sample_candidates(
            ARRAY(SELECT DISTINCT x.sample_id FROM test_sessions x WHERE x.session_id = ANY (ids) AND NOT x.restricted AND x.sample_id IS NOT NULL)) sc
            ON sc.record_id = o.sample_id
         WHERE o.session_id = ANY (ids) AND NOT o.restricted
    ) q WHERE q.user_id IS NOT NULL $$;
COMMENT ON FUNCTION d1_private.test_candidates(uuid[]) IS 'Candidate readers of each test session (the same sources as operation_candidates, with test_access). A superset of readers_of_test().';

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
COMMENT ON FUNCTION d1_private.project_candidates(uuid[]) IS 'Candidate readers of each project: its list (PI, investigators, access entries) and the owners of what is in it (campaigns, operations, tests) and the editors of its samples. A superset of readers_of_project().';

-- 5. The readers as the rule is stated: candidates, then the per-pair predicate (the *_spec functions: the executable specification,
-- used by the tests; readers_of_project is the production function). The set-based production versions follow in 5b.
CREATE OR REPLACE FUNCTION d1_private.readers_of_sample_spec(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT c.record_id, c.user_id FROM d1_private.sample_candidates(ids) c WHERE d1_private.can_read_sample(c.record_id, c.user_id) $$;
COMMENT ON FUNCTION d1_private.readers_of_sample_spec(uuid[]) IS 'Every login that may read each sample (the rule as candidates then the per-pair predicate can_read_sample; the production readers_of_sample is the set-based equal).';

CREATE OR REPLACE FUNCTION d1_private.readers_of_operation_spec(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT c.record_id, c.user_id FROM d1_private.operation_candidates(ids) c WHERE d1_private.can_read_operation(c.record_id, c.user_id) $$;
COMMENT ON FUNCTION d1_private.readers_of_operation_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_operation).';

CREATE OR REPLACE FUNCTION d1_private.readers_of_test_spec(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT c.record_id, c.user_id FROM d1_private.test_candidates(ids) c WHERE d1_private.can_read_test(c.record_id, c.user_id) $$;
COMMENT ON FUNCTION d1_private.readers_of_test_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_test).';

CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_spec(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT c.record_id, c.user_id FROM d1_private.campaign_candidates(ids) c WHERE d1_private.can_read_campaign(c.record_id, c.user_id) $$;
COMMENT ON FUNCTION d1_private.readers_of_campaign_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_campaign).';

CREATE OR REPLACE FUNCTION d1_private.readers_of_project_spec(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT c.record_id, c.user_id FROM d1_private.project_candidates(ids) c WHERE d1_private.can_read_project(c.record_id, c.user_id) $$;
COMMENT ON FUNCTION d1_private.readers_of_project_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_project).';

-- the logins that may read each campaign_samples row (ids are junction ids): readers of its sample, or, for an unrestricted
-- sample, readers of its campaign
CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_sample_spec(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT cs.id AS record_id, c.user_id FROM campaign_samples cs JOIN d1_private.sample_candidates(ARRAY(SELECT x.sample_id FROM campaign_samples x WHERE x.id = ANY (ids))) c ON c.record_id = cs.sample_id
         WHERE cs.id = ANY (ids)
        UNION ALL
        SELECT cs.id, c.user_id FROM campaign_samples cs JOIN d1_private.campaign_candidates(ARRAY(SELECT x.campaign_id FROM campaign_samples x WHERE x.id = ANY (ids))) c ON c.record_id = cs.campaign_id
         WHERE cs.id = ANY (ids)
    ) q WHERE d1_private.can_read_campaign_sample(q.record_id, q.user_id) $$;
COMMENT ON FUNCTION d1_private.readers_of_campaign_sample_spec(uuid[]) IS 'The rule as candidates then the per-pair predicate (the executable specification of readers_of_campaign_sample).';


-- 5b. The production readers_of_*: the same rule, set-based. The *_spec functions above are the rule as candidates-then-predicate (a
-- per-pair evaluation: about a millisecond a pair on the seeded copy, minutes for the 14 thousand operations); these compute the same
-- sets with one query per type: the positive paths with their gates written inline against pair relations (views over the base
-- tables), so a project-sized recompute is a few hundred milliseconds. tests/readers_matrix.sh asserts three-way equality: these = the
-- *_spec functions = the independent oracle ref.* (scripts/dev/access_matrix_oracle.sql), for every record and user of the fixture and of
-- the random universes. The pair relations read base tables only; every user_id they emit is a foreign key to directus_users (people.user_id,
-- and the sample_co_owners and project_investigators columns this migration constrains), so no join to the logins is needed, where the
-- candidate functions above join them to stay defensive.
-- The five production functions below are plpgsql wrappers (RETURN QUERY) of one static query each, so the plan is cached per session: the SQL
-- language re-plans a query of this size on every call (6 to 20 ms each on the seeded copy, more than the work itself for a small closure),
-- plpgsql plans it for the first five calls and then reuses a generic plan, which on the seeded copy runs a 14 thousand operation array as
-- fast as a custom plan does.
CREATE OR REPLACE VIEW d1_private.v_login_person AS
    SELECT p.person_id, p.user_id FROM public.people p WHERE p.user_id IS NOT NULL;
COMMENT ON VIEW d1_private.v_login_person IS 'People that have a login (people.user_id is a foreign key to directus_users, so it exists): how the pair relations below reach a login.';

CREATE OR REPLACE VIEW d1_private.v_p_pi AS
    SELECT x.project_id, lp.user_id FROM public.projects x JOIN d1_private.v_login_person lp ON lp.person_id = x.principal_investigator_person;
COMMENT ON VIEW d1_private.v_p_pi IS '(project, login): the project''s principal investigator.';

CREATE OR REPLACE VIEW d1_private.v_p_invs AS
    SELECT i.project_id, i.user_id FROM public.project_investigators i
    UNION ALL
    SELECT a.project_id, lp.user_id FROM public.project_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role = 'investigator';
COMMENT ON VIEW d1_private.v_p_invs IS '(project, login): an investigator of the project (an old investigator row or an access entry with role investigator), not the PI.';

CREATE OR REPLACE VIEW d1_private.v_p_list AS
    SELECT pi.project_id, pi.user_id FROM d1_private.v_p_pi pi
    UNION ALL
    SELECT i.project_id, i.user_id FROM public.project_investigators i
    UNION ALL
    SELECT a.project_id, lp.user_id FROM public.project_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id;
COMMENT ON VIEW d1_private.v_p_list IS '(project, login): on the project''s list: the PI, an old investigator row, any access entry (the gate P passes for a restricted project).';

CREATE OR REPLACE VIEW d1_private.v_c_list AS
    SELECT c.campaign_id, lp.user_id FROM public.campaigns c JOIN d1_private.v_login_person lp ON lp.person_id = c.owner_person_id
    UNION ALL
    SELECT a.campaign_id, lp.user_id FROM public.campaign_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id
    UNION ALL
    SELECT c.campaign_id, pi.user_id FROM public.campaigns c JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id;
COMMENT ON VIEW d1_private.v_c_list IS '(campaign, login): on the campaign''s list: its owner, an access entry, the PI of its project.';

CREATE OR REPLACE VIEW d1_private.v_s_editor AS
    SELECT s.sample_id, lp.user_id FROM public.physical_samples s JOIN d1_private.v_login_person lp ON lp.person_id = s.owner_person_id
    UNION ALL
    SELECT o.sample_id, o.user_id FROM public.sample_co_owners o
    UNION ALL
    SELECT a.sample_id, lp.user_id FROM public.sample_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role = 'edit';
COMMENT ON VIEW d1_private.v_s_editor IS '(sample, login): an editor of the sample: its owner, a co-owner, a Can edit entry.';

CREATE OR REPLACE VIEW d1_private.v_s_list AS
    SELECT e.sample_id, e.user_id FROM d1_private.v_s_editor e
    UNION ALL
    SELECT a.sample_id, lp.user_id FROM public.sample_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.role <> 'edit'
    UNION ALL
    SELECT s.sample_id, pi.user_id FROM public.physical_samples s JOIN d1_private.v_p_pi pi ON pi.project_id = s.project_id
    UNION ALL
    SELECT cs.sample_id, pi.user_id FROM public.campaign_samples cs JOIN public.campaigns c ON c.campaign_id = cs.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id;
COMMENT ON VIEW d1_private.v_s_list IS '(sample, login): on the sample''s list: owner, co-owner, any access entry, the PI of its project, the PI of a campaign''s project.';

CREATE OR REPLACE FUNCTION d1_private.readers_of_sample(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT r.record_id, r.user_id FROM (
        -- on the list: always a reader
        SELECT l.sample_id AS record_id, l.user_id FROM d1_private.v_s_list l WHERE l.sample_id = ANY (ids)
        UNION ALL
        -- inherited, only for an unrestricted sample: the investigators of its project
        SELECT s.sample_id, i.user_id FROM physical_samples s JOIN d1_private.v_p_invs i ON i.project_id = s.project_id
         WHERE s.sample_id = ANY (ids) AND NOT s.restricted
        UNION ALL
        -- the owner of a campaign it is in, while the campaign's project lets them in
        SELECT cs.sample_id, lp.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id
          JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_login_person lp ON lp.person_id = c.owner_person_id
          LEFT JOIN projects cp ON cp.project_id = c.project_id
         WHERE cs.sample_id = ANY (ids) AND NOT s.restricted
           AND (cp.project_id IS NULL OR NOT cp.restricted
                OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = lp.user_id))
        UNION ALL
        -- the investigators of an unrestricted campaign's project
        SELECT cs.sample_id, i.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id
          JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_p_invs i ON i.project_id = c.project_id
         WHERE cs.sample_id = ANY (ids) AND NOT s.restricted AND NOT c.restricted
    ) r;
END
$$;
COMMENT ON FUNCTION d1_private.readers_of_sample(uuid[]) IS 'Every login that may read each sample (the single statement of the rule; sample_readers materialises it): the logins on its list, and for an unrestricted sample the investigators of its project, the owners of the campaigns it is in (while the campaign''s project lets them in) and the investigators of an unrestricted campaign''s project. Set-based; equal to readers_of_sample_spec() and to the oracle ref.s_read.';

CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT x.record_id, x.user_id FROM (
        SELECT l.campaign_id AS record_id, l.user_id FROM d1_private.v_c_list l WHERE l.campaign_id = ANY (ids)
        UNION ALL
        SELECT c.campaign_id, i.user_id FROM campaigns c JOIN d1_private.v_p_invs i ON i.project_id = c.project_id
         WHERE c.campaign_id = ANY (ids) AND NOT c.restricted
        UNION ALL
        SELECT cs.campaign_id, e.user_id FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
          JOIN d1_private.v_s_editor e ON e.sample_id = cs.sample_id
         WHERE cs.campaign_id = ANY (ids) AND NOT c.restricted
    ) x
    JOIN campaigns c ON c.campaign_id = x.record_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE p.project_id IS NULL OR NOT p.restricted
       OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = p.project_id AND pl.user_id = x.user_id);
END
$$;
COMMENT ON FUNCTION d1_private.readers_of_campaign(uuid[]) IS 'Every login that may read each campaign (campaign_readers materialises it): the logins on its list, and for an unrestricted campaign the investigators of its project and the editors of its samples, all while its project lets them in. Set-based; equal to readers_of_campaign_spec() and to the oracle ref.c_read.';

-- Order dependence (performance): readers_of_operation and readers_of_test take the readers of an operation's sample from sample_readers,
-- readers_of_campaign_sample takes those of its sample and campaign from sample_readers / campaign_readers, and readers_of_project takes the
-- owners that can read their operations / tests from operation_readers / test_readers, instead of recomputing them. sync_readers() and
-- readers_rebuild() bring the tables up in that order (samples, operations, tests, campaigns, projects, junction rows) and every record whose
-- readers could have changed is in the closure, so each table is current when the next is derived from it; tests/readers_matrix.sh asserts the
-- equality with the *_spec functions and the oracle on the synced fixture and after every random mutation.
CREATE OR REPLACE FUNCTION d1_private.readers_of_operation(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    WITH o AS MATERIALIZED (SELECT x.operation_id, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id, x.restricted
                              FROM manufacturing_operations x WHERE x.operation_id = ANY (ids)),
    paths AS (
        SELECT o.operation_id AS rid, lp.user_id AS uid FROM o JOIN d1_private.v_login_person lp ON lp.person_id = o.owner_person_id
        UNION ALL
        SELECT a.operation_id, lp.user_id FROM operation_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.operation_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN d1_private.v_p_pi pi ON pi.project_id = o.project_id
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id
        UNION ALL
        -- the inherited paths exist only for an unrestricted operation
        SELECT o.operation_id, i.user_id FROM o JOIN d1_private.v_p_invs i ON i.project_id = o.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, lp.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = c.owner_person_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_invs i ON i.project_id = c.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, r.user_id FROM o
          JOIN sample_readers r ON r.record_id = o.sample_id
         WHERE NOT o.restricted
    )
    SELECT DISTINCT pa.rid, pa.uid FROM paths pa
      JOIN o ON o.operation_id = pa.rid
      LEFT JOIN physical_samples s ON s.sample_id = o.sample_id
      LEFT JOIN projects sp ON sp.project_id = s.project_id
      LEFT JOIN projects pr ON pr.project_id = o.project_id
      LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
      LEFT JOIN projects cp ON cp.project_id = c.project_id
     WHERE
       -- P(its project)
       (pr.project_id IS NULL OR NOT pr.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = pr.project_id AND pl.user_id = pa.uid))
       -- P(its sample's project)
       AND (sp.project_id IS NULL OR NOT sp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = sp.project_id AND pl.user_id = pa.uid))
       -- C(its campaign): unrestricted or on its list, and its project lets them in
       AND (c.campaign_id IS NULL OR (
              (NOT c.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = c.campaign_id AND cl.user_id = pa.uid))
              AND (cp.project_id IS NULL OR NOT cp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = pa.uid))))
       -- S*(its sample): unrestricted or on its list, and (on its list, or investigates its own project, or not campaign-shielded)
       AND (s.sample_id IS NULL OR (
              (NOT s.restricted OR EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid))
              AND (EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid)
                   OR EXISTS (SELECT 1 FROM d1_private.v_p_invs i WHERE i.project_id = s.project_id AND i.user_id = pa.uid)
                   OR NOT (EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = s.sample_id)
                           AND NOT EXISTS (SELECT 1 FROM campaign_samples x JOIN campaigns xc ON xc.campaign_id = x.campaign_id
                                             LEFT JOIN projects xp ON xp.project_id = xc.project_id
                                            WHERE x.sample_id = s.sample_id
                                              AND (NOT xc.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = xc.campaign_id AND cl.user_id = pa.uid))
                                              AND (xp.project_id IS NULL OR NOT xp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = xp.project_id AND pl.user_id = pa.uid)))))));
END
$$;
COMMENT ON FUNCTION d1_private.readers_of_operation(uuid[]) IS 'Every login that may read each operation by the ordinary path (operation_readers materialises it; the ownerless runs open to everyone are operation_open_of()): the positive paths (owner, access entry, the PI of its project and of its campaign''s project, and for an unrestricted operation the investigators, the campaign owner, the readers of its sample) kept when the gates hold (P of its project and of its sample''s project, C of its campaign, the exact S* of its sample). Set-based; equal to readers_of_operation_spec() and to the oracle.';

CREATE OR REPLACE FUNCTION d1_private.readers_of_test(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    WITH o AS MATERIALIZED (SELECT x.session_id AS operation_id, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id, x.restricted
                              FROM test_sessions x WHERE x.session_id = ANY (ids)),
    paths AS (
        SELECT o.operation_id AS rid, lp.user_id AS uid FROM o JOIN d1_private.v_login_person lp ON lp.person_id = o.owner_person_id
        UNION ALL
        SELECT a.session_id, lp.user_id FROM test_access a JOIN d1_private.v_login_person lp ON lp.person_id = a.person_id WHERE a.session_id = ANY (ids)
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN d1_private.v_p_pi pi ON pi.project_id = o.project_id
        UNION ALL
        SELECT o.operation_id, pi.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_pi pi ON pi.project_id = c.project_id
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN d1_private.v_p_invs i ON i.project_id = o.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, lp.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_login_person lp ON lp.person_id = c.owner_person_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, i.user_id FROM o JOIN campaigns c ON c.campaign_id = o.campaign_id JOIN d1_private.v_p_invs i ON i.project_id = c.project_id WHERE NOT o.restricted
        UNION ALL
        SELECT o.operation_id, r.user_id FROM o
          JOIN sample_readers r ON r.record_id = o.sample_id
         WHERE NOT o.restricted
    )
    SELECT DISTINCT pa.rid, pa.uid FROM paths pa
      JOIN o ON o.operation_id = pa.rid
      LEFT JOIN physical_samples s ON s.sample_id = o.sample_id
      LEFT JOIN projects sp ON sp.project_id = s.project_id
      LEFT JOIN projects pr ON pr.project_id = o.project_id
      LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
      LEFT JOIN projects cp ON cp.project_id = c.project_id
     WHERE
       (pr.project_id IS NULL OR NOT pr.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = pr.project_id AND pl.user_id = pa.uid))
       AND (sp.project_id IS NULL OR NOT sp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = sp.project_id AND pl.user_id = pa.uid))
       AND (c.campaign_id IS NULL OR (
              (NOT c.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = c.campaign_id AND cl.user_id = pa.uid))
              AND (cp.project_id IS NULL OR NOT cp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = cp.project_id AND pl.user_id = pa.uid))))
       AND (s.sample_id IS NULL OR (
              (NOT s.restricted OR EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid))
              AND (EXISTS (SELECT 1 FROM d1_private.v_s_list sl WHERE sl.sample_id = s.sample_id AND sl.user_id = pa.uid)
                   OR EXISTS (SELECT 1 FROM d1_private.v_p_invs i WHERE i.project_id = s.project_id AND i.user_id = pa.uid)
                   OR NOT (EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = s.sample_id)
                           AND NOT EXISTS (SELECT 1 FROM campaign_samples x JOIN campaigns xc ON xc.campaign_id = x.campaign_id
                                             LEFT JOIN projects xp ON xp.project_id = xc.project_id
                                            WHERE x.sample_id = s.sample_id
                                              AND (NOT xc.restricted OR EXISTS (SELECT 1 FROM d1_private.v_c_list cl WHERE cl.campaign_id = xc.campaign_id AND cl.user_id = pa.uid))
                                              AND (xp.project_id IS NULL OR NOT xp.restricted OR EXISTS (SELECT 1 FROM d1_private.v_p_list pl WHERE pl.project_id = xp.project_id AND pl.user_id = pa.uid)))))));
END
$$;
COMMENT ON FUNCTION d1_private.readers_of_test(uuid[]) IS 'Every login that may read each test session (test_readers materialises it): the same paths and gates as readers_of_operation, with test_access. Set-based; equal to readers_of_test_spec() and to the oracle.';

CREATE OR REPLACE FUNCTION d1_private.readers_of_campaign_sample(ids uuid[]) RETURNS TABLE (record_id uuid, user_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT q.record_id, q.user_id FROM (
        SELECT cs.id AS record_id, r.user_id FROM campaign_samples cs JOIN sample_readers r ON r.record_id = cs.sample_id WHERE cs.id = ANY (ids)
        UNION ALL
        SELECT cs.id, r.user_id FROM campaign_samples cs
          JOIN physical_samples s ON s.sample_id = cs.sample_id AND NOT s.restricted
          JOIN campaign_readers r ON r.record_id = cs.campaign_id
         WHERE cs.id = ANY (ids)
    ) q;
END
$$;
COMMENT ON FUNCTION d1_private.readers_of_campaign_sample(uuid[]) IS 'Every login that may read each campaign_samples row (ids are campaign_samples.id): readers of its sample, or, for an unrestricted sample, readers of its campaign (campaign_sample_readers materialises it). Composed from sample_readers and campaign_readers, which sync_readers() has just brought up to date (it recomputes samples and campaigns before the junction rows), and equal to readers_of_campaign_sample_spec() and to the oracle ref.cs_read whenever those tables are in sync.';

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
COMMENT ON FUNCTION d1_private.readers_of_project(uuid[]) IS 'Every login that may read each project (project_readers materialises it): its list, and for an unrestricted project the owners of its campaigns, the editors of its samples and the owners of operations and tests in it that can read them (taken from operation_readers and test_readers, which sync_readers() has just brought up to date, and which hold exactly the per-pair can_read_operation / can_read_test). Equal to readers_of_project_spec() and to the oracle ref.p_read whenever those tables are in sync.';

-- the operations every member may read: ownerless (owner, project and campaign null), unrestricted, and on no sample, or on an
-- unrestricted sample with an open project (none or unrestricted) that is in no campaign or in at least one campaign open to everyone
CREATE OR REPLACE FUNCTION d1_private.operation_open_of(ids uuid[]) RETURNS TABLE (record_id uuid) LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    SELECT o.operation_id FROM manufacturing_operations o
     WHERE o.operation_id = ANY (ids) AND o.owner_person_id IS NULL AND o.project_id IS NULL AND o.campaign_id IS NULL AND NOT o.restricted
       AND (o.sample_id IS NULL
            OR EXISTS (SELECT 1 FROM physical_samples s LEFT JOIN projects sp ON sp.project_id = s.project_id
                        WHERE s.sample_id = o.sample_id AND NOT s.restricted AND coalesce(NOT sp.restricted, true)
                          AND (NOT EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s.sample_id)
                               OR EXISTS (SELECT 1 FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id LEFT JOIN projects cp ON cp.project_id = c.project_id
                                           WHERE cs.sample_id = s.sample_id AND NOT c.restricted AND coalesce(NOT cp.restricted, true))))) $$;
COMMENT ON FUNCTION d1_private.operation_open_of(uuid[]) IS 'The operations every member may read (the narrowed orphan amnesty; operation_open_to_all materialises it).';

CREATE OR REPLACE FUNCTION d1_private.hidden_of(kind text, ids uuid[]) RETURNS TABLE (record_id uuid) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
    IF kind = 'projects' THEN
        RETURN QUERY SELECT p.project_id FROM projects p WHERE p.project_id = ANY (ids) AND p.restricted;
    ELSIF kind = 'campaigns' THEN
        RETURN QUERY SELECT c.campaign_id FROM campaigns c WHERE c.campaign_id = ANY (ids) AND d1_private.campaign_hidden(c.campaign_id);
    ELSIF kind = 'physical_samples' THEN
        RETURN QUERY SELECT s.sample_id FROM physical_samples s WHERE s.sample_id = ANY (ids) AND d1_private.sample_hidden(s.sample_id);
    ELSIF kind = 'manufacturing_operations' THEN
        RETURN QUERY SELECT o.operation_id FROM manufacturing_operations o LEFT JOIN projects p ON p.project_id = o.project_id
                      WHERE o.operation_id = ANY (ids)
                        AND (o.restricted OR coalesce(p.restricted, false)
                             OR (o.sample_id IS NOT NULL AND d1_private.sample_hidden(o.sample_id))
                             OR (o.campaign_id IS NOT NULL AND d1_private.campaign_hidden(o.campaign_id)));
    ELSIF kind = 'test_sessions' THEN
        RETURN QUERY SELECT t.session_id FROM test_sessions t LEFT JOIN projects p ON p.project_id = t.project_id
                      WHERE t.session_id = ANY (ids)
                        AND (t.restricted OR coalesce(p.restricted, false)
                             OR (t.sample_id IS NOT NULL AND d1_private.sample_hidden(t.sample_id))
                             OR (t.campaign_id IS NOT NULL AND d1_private.campaign_hidden(t.campaign_id)));
    ELSE
        RAISE EXCEPTION 'hidden_of: unknown kind %', kind;
    END IF;
END
$$;
COMMENT ON FUNCTION d1_private.hidden_of(text, uuid[]) IS 'The records of one collection (physical_samples, manufacturing_operations, test_sessions, campaigns, projects) that the Ask-the-database role must not see: restricted, or under a restricted project; a campaign also when its project is; a sample when any campaign it belongs to is hidden; an operation or test when its sample, project or campaign is hidden. Written straight from the flags (hidden_records materialises it).';

-- for the row security of the Ask-DB role (migration 168): is the record hidden from it
CREATE OR REPLACE FUNCTION d1_private.is_hidden(kind text, id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (SELECT 1 FROM d1_private.hidden_records h WHERE h.kind = is_hidden.kind AND h.record_id = id) $$;
COMMENT ON FUNCTION d1_private.is_hidden(text, uuid) IS 'Whether a record is in d1_private.hidden_records (SECURITY DEFINER: the Ask-DB role may call it from a row-security policy without any grant on the table).';

-- 6. The recompute (spec section 2, "Recompute"). refresh_readers() takes ONE global advisory lock before it reads anything, then
-- (in later statements, each with a fresh snapshot, so each contains whatever the previous holder of the lock committed) expands
-- the closure of the seeds, recomputes the functions over it and diffs against the tables; when the hidden set changed it
-- refreshes the project rollup. It must run under READ COMMITTED (a REPEATABLE READ snapshot would not see the other
-- transaction's commit, which the protocol relies on), and raises otherwise.

CREATE OR REPLACE FUNCTION d1_private.readers_closure(
    seed_s uuid[], seed_o uuid[], seed_t uuid[], seed_c uuid[], seed_p uuid[],
    touch_s uuid[], touch_c uuid[], touch_p uuid[], touch_j uuid[],
    OUT s_all uuid[], OUT o_all uuid[], OUT t_all uuid[], OUT c_all uuid[], OUT p_all uuid[], OUT j_all uuid[])
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
    cd uuid[];
BEGIN
    seed_s := coalesce(seed_s, '{}'); seed_o := coalesce(seed_o, '{}'); seed_t := coalesce(seed_t, '{}');
    seed_c := coalesce(seed_c, '{}'); seed_p := coalesce(seed_p, '{}');
    touch_s := coalesce(touch_s, '{}'); touch_c := coalesce(touch_c, '{}'); touch_p := coalesce(touch_p, '{}'); touch_j := coalesce(touch_j, '{}');
    -- Cd: the campaigns that cascade: seed campaigns and the campaigns of a seed project
    cd := d1_private.uniq(seed_c || ARRAY(SELECT c.campaign_id FROM campaigns c WHERE c.project_id = ANY (seed_p)));
    -- C*: Cd, touched campaigns, and the campaigns that hold a seed sample (an editor of the sample is a reader of the campaign)
    c_all := d1_private.uniq(cd || touch_c || ARRAY(SELECT cs.campaign_id FROM campaign_samples cs WHERE cs.sample_id = ANY (seed_s)));
    -- S*: seed and touched samples, the samples of a seed project, the samples in Cd
    s_all := d1_private.uniq(seed_s || touch_s
                             || ARRAY(SELECT s.sample_id FROM physical_samples s WHERE s.project_id = ANY (seed_p))
                             || ARRAY(SELECT cs.sample_id FROM campaign_samples cs WHERE cs.campaign_id = ANY (cd)));
    -- O*, T*: seed operations (tests), those of a seed project, of a campaign in Cd, or on a sample in S*
    o_all := d1_private.uniq(seed_o || ARRAY(SELECT o.operation_id FROM manufacturing_operations o
                                              WHERE o.project_id = ANY (seed_p) OR o.campaign_id = ANY (cd) OR o.sample_id = ANY (s_all)));
    t_all := d1_private.uniq(seed_t || ARRAY(SELECT t.session_id FROM test_sessions t
                                              WHERE t.project_id = ANY (seed_p) OR t.campaign_id = ANY (cd) OR t.sample_id = ANY (s_all)));
    -- P*: seed and touched projects, and the project of every record in C*, S*, O*, T*
    p_all := d1_private.uniq(seed_p || touch_p
                             || ARRAY(SELECT c.project_id FROM campaigns c WHERE c.campaign_id = ANY (c_all))
                             || ARRAY(SELECT s.project_id FROM physical_samples s WHERE s.sample_id = ANY (s_all))
                             || ARRAY(SELECT o.project_id FROM manufacturing_operations o WHERE o.operation_id = ANY (o_all))
                             || ARRAY(SELECT t.project_id FROM test_sessions t WHERE t.session_id = ANY (t_all)));
    -- J*: the junction rows of a sample in S* and the touched junction rows. The rows of a campaign in C* are added by sync_readers() only when
    -- that campaign's readers CHANGED (a junction row's readers are the sample's readers or, for an unrestricted sample, the campaign's, so an
    -- unchanged campaign leaves the rest of its rows alone: adding a sample to a campaign of 800 samples touches 1 row, not 800)
    j_all := d1_private.uniq(touch_j || ARRAY(SELECT cs.id FROM campaign_samples cs WHERE cs.sample_id = ANY (s_all)));
END
$$;
COMMENT ON FUNCTION d1_private.readers_closure(uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[]) IS 'What a set of seeds makes stale (spec section 2, closure table): the samples, operations, tests, campaigns, projects and campaign_samples rows whose readers must be recomputed. Seeds are records whose own inputs changed; touches are parents that only need their own recompute. The junction rows are those of a sample in S* and the touched ones; sync_readers() adds the rows of a campaign whose readers changed. STABLE: it runs in the statement that follows the lock, so it reads everything the previous holder committed.';

-- the diff: for each type, delete the rows of the closure the function no longer returns, insert the missing ones (never delete-all)
CREATE OR REPLACE FUNCTION d1_private.sync_readers(s_all uuid[], o_all uuid[], t_all uuid[], c_all uuid[], p_all uuid[], j_all uuid[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    hidden_changes BIGINT;
    changed_c uuid[];
BEGIN
    IF coalesce(cardinality(s_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id, w.user_id FROM d1_private.readers_of_sample(s_all) w),
             gone AS (DELETE FROM sample_readers r WHERE r.record_id = ANY (s_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id AND w.user_id = r.user_id))
        INSERT INTO sample_readers (record_id, user_id)
        SELECT w.record_id, w.user_id FROM want w
         WHERE NOT EXISTS (SELECT 1 FROM sample_readers r WHERE r.record_id = w.record_id AND r.user_id = w.user_id)
        ON CONFLICT (record_id, user_id) DO NOTHING;
    END IF;

    IF coalesce(cardinality(o_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id, w.user_id FROM d1_private.readers_of_operation(o_all) w),
             gone AS (DELETE FROM operation_readers r WHERE r.record_id = ANY (o_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id AND w.user_id = r.user_id))
        INSERT INTO operation_readers (record_id, user_id)
        SELECT w.record_id, w.user_id FROM want w
         WHERE NOT EXISTS (SELECT 1 FROM operation_readers r WHERE r.record_id = w.record_id AND r.user_id = w.user_id)
        ON CONFLICT (record_id, user_id) DO NOTHING;
    END IF;

    IF coalesce(cardinality(o_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id FROM d1_private.operation_open_of(o_all) w),
             gone AS (DELETE FROM operation_open_to_all r WHERE r.record_id = ANY (o_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id))
        INSERT INTO operation_open_to_all (record_id)
        SELECT w.record_id FROM want w
         WHERE NOT EXISTS (SELECT 1 FROM operation_open_to_all r WHERE r.record_id = w.record_id)
        ON CONFLICT (record_id) DO NOTHING;
    END IF;

    IF coalesce(cardinality(t_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id, w.user_id FROM d1_private.readers_of_test(t_all) w),
             gone AS (DELETE FROM test_readers r WHERE r.record_id = ANY (t_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id AND w.user_id = r.user_id))
        INSERT INTO test_readers (record_id, user_id)
        SELECT w.record_id, w.user_id FROM want w
         WHERE NOT EXISTS (SELECT 1 FROM test_readers r WHERE r.record_id = w.record_id AND r.user_id = w.user_id)
        ON CONFLICT (record_id, user_id) DO NOTHING;
    END IF;

    -- the campaigns whose readers changed: their junction rows are recomputed too (below)
    IF coalesce(cardinality(c_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id, w.user_id FROM d1_private.readers_of_campaign(c_all) w),
             gone AS (DELETE FROM campaign_readers r WHERE r.record_id = ANY (c_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id AND w.user_id = r.user_id) RETURNING r.record_id),
             added AS (INSERT INTO campaign_readers (record_id, user_id)
                       SELECT w.record_id, w.user_id FROM want w
                        WHERE NOT EXISTS (SELECT 1 FROM campaign_readers r WHERE r.record_id = w.record_id AND r.user_id = w.user_id)
                       ON CONFLICT (record_id, user_id) DO NOTHING RETURNING record_id)
        SELECT array_agg(DISTINCT u.record_id) INTO changed_c FROM (SELECT g.record_id FROM gone g UNION ALL SELECT a.record_id FROM added a) u;
    END IF;

    IF coalesce(cardinality(p_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id, w.user_id FROM d1_private.readers_of_project(p_all) w),
             gone AS (DELETE FROM project_readers r WHERE r.record_id = ANY (p_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id AND w.user_id = r.user_id))
        INSERT INTO project_readers (record_id, user_id)
        SELECT w.record_id, w.user_id FROM want w
         WHERE NOT EXISTS (SELECT 1 FROM project_readers r WHERE r.record_id = w.record_id AND r.user_id = w.user_id)
        ON CONFLICT (record_id, user_id) DO NOTHING;
    END IF;

    IF changed_c IS NOT NULL THEN
        j_all := d1_private.uniq(j_all || ARRAY(SELECT cs.id FROM campaign_samples cs WHERE cs.campaign_id = ANY (changed_c)));
    END IF;
    IF coalesce(cardinality(j_all), 0) > 0 THEN
        WITH want AS MATERIALIZED (SELECT w.record_id, w.user_id FROM d1_private.readers_of_campaign_sample(j_all) w),
             gone AS (DELETE FROM campaign_sample_readers r WHERE r.record_id = ANY (j_all)
                         AND NOT EXISTS (SELECT 1 FROM want w WHERE w.record_id = r.record_id AND w.user_id = r.user_id))
        INSERT INTO campaign_sample_readers (record_id, user_id)
        SELECT w.record_id, w.user_id FROM want w
         WHERE NOT EXISTS (SELECT 1 FROM campaign_sample_readers r WHERE r.record_id = w.record_id AND r.user_id = w.user_id)
        ON CONFLICT (record_id, user_id) DO NOTHING;
    END IF;

    -- hidden_records has no foreign key: this diff also drops the rows of records that no longer exist (their ids are seeds)
    WITH want AS MATERIALIZED (
             SELECT 'physical_samples'::text AS kind, w.record_id FROM d1_private.hidden_of('physical_samples', s_all) w
             UNION ALL SELECT 'manufacturing_operations', w.record_id FROM d1_private.hidden_of('manufacturing_operations', o_all) w
             UNION ALL SELECT 'test_sessions', w.record_id FROM d1_private.hidden_of('test_sessions', t_all) w
             UNION ALL SELECT 'campaigns', w.record_id FROM d1_private.hidden_of('campaigns', c_all) w
             UNION ALL SELECT 'projects', w.record_id FROM d1_private.hidden_of('projects', p_all) w),
         have AS MATERIALIZED (
             SELECT h.kind, h.record_id FROM d1_private.hidden_records h
              WHERE (h.kind = 'physical_samples' AND h.record_id = ANY (s_all))
                 OR (h.kind = 'manufacturing_operations' AND h.record_id = ANY (o_all))
                 OR (h.kind = 'test_sessions' AND h.record_id = ANY (t_all))
                 OR (h.kind = 'campaigns' AND h.record_id = ANY (c_all))
                 OR (h.kind = 'projects' AND h.record_id = ANY (p_all))),
         gone AS (DELETE FROM d1_private.hidden_records h USING have x WHERE h.kind = x.kind AND h.record_id = x.record_id
                     AND NOT EXISTS (SELECT 1 FROM want w WHERE w.kind = x.kind AND w.record_id = x.record_id) RETURNING x.kind),
         added AS (INSERT INTO d1_private.hidden_records (kind, record_id)
                   SELECT w.kind, w.record_id FROM want w WHERE NOT EXISTS (SELECT 1 FROM have x WHERE x.kind = w.kind AND x.record_id = w.record_id)
                   RETURNING kind)
    SELECT (SELECT count(*) FROM gone WHERE kind IN ('physical_samples', 'manufacturing_operations'))
         + (SELECT count(*) FROM added WHERE kind IN ('physical_samples', 'manufacturing_operations')) INTO hidden_changes;

    -- the rollup's restricted column is derived from hidden_records (the operation and sample rows), so it follows the diff of those two kinds, and
    -- is written after it. A campaign or project that turns restricted changes the hidden status of its operations, which the diff of the operations
    -- shows; a test session's hidden status is not in the rollup, so a test insert or delete no longer rebuilds the whole cache.
    IF hidden_changes > 0 THEN
        PERFORM public.refresh_project_rollup();
    END IF;
END
$$;
COMMENT ON FUNCTION d1_private.sync_readers(uuid[], uuid[], uuid[], uuid[], uuid[], uuid[]) IS 'Recompute the readers of the given ids (samples, operations, tests, campaigns, projects, campaign_samples rows) with the d1_private functions and diff them into the tables, operation_open_to_all and hidden_records, then refresh the project rollup when the hidden set changed. Called by refresh_readers() and readers_rebuild(), which hold the lock.';

CREATE OR REPLACE FUNCTION d1_private.refresh_readers(
    seed_s uuid[], seed_o uuid[], seed_t uuid[], seed_c uuid[], seed_p uuid[],
    touch_s uuid[], touch_c uuid[], touch_p uuid[], touch_j uuid[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    cl record;
BEGIN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'd1_private.refresh_readers needs READ COMMITTED (the transaction is %): a later statement must see what the previous holder of the readers lock committed', pg_catalog.current_setting('transaction_isolation')
            USING ERRCODE = 'feature_not_supported';
    END IF;
    -- ONE global, transaction-scoped lock, BEFORE anything is read; held to the end of the writer's transaction
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('d1_readers', 0));
    SELECT * INTO cl FROM d1_private.readers_closure(seed_s, seed_o, seed_t, seed_c, seed_p, touch_s, touch_c, touch_p, touch_j);
    PERFORM d1_private.sync_readers(cl.s_all, cl.o_all, cl.t_all, cl.c_all, cl.p_all, cl.j_all);
END
$$;
COMMENT ON FUNCTION d1_private.refresh_readers(uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[]) IS 'Recompute the readers affected by a change (spec section 2): seeds are records whose own inputs changed (samples, operations, tests, campaigns, projects), touches are parents that only need their own recompute (samples, campaigns, projects, campaign_samples rows). One global advisory lock first, the closure and the diff in later statements; raises unless READ COMMITTED. Called only by the statement triggers.';

CREATE OR REPLACE FUNCTION d1_private.readers_rebuild() RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'd1_private.readers_rebuild needs READ COMMITTED (the transaction is %)', pg_catalog.current_setting('transaction_isolation')
            USING ERRCODE = 'feature_not_supported';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('d1_readers', 0));
    PERFORM d1_private.sync_readers(
        ARRAY(SELECT s.sample_id FROM physical_samples s),
        ARRAY(SELECT o.operation_id FROM manufacturing_operations o),
        ARRAY(SELECT t.session_id FROM test_sessions t),
        ARRAY(SELECT c.campaign_id FROM campaigns c),
        ARRAY(SELECT p.project_id FROM projects p),
        ARRAY(SELECT cs.id FROM campaign_samples cs));
    -- records that no longer exist and left rows in hidden_records (no foreign key)
    DELETE FROM d1_private.hidden_records h
     WHERE NOT EXISTS (SELECT 1 FROM physical_samples s WHERE h.kind = 'physical_samples' AND s.sample_id = h.record_id)
       AND NOT EXISTS (SELECT 1 FROM manufacturing_operations o WHERE h.kind = 'manufacturing_operations' AND o.operation_id = h.record_id)
       AND NOT EXISTS (SELECT 1 FROM test_sessions t WHERE h.kind = 'test_sessions' AND t.session_id = h.record_id)
       AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE h.kind = 'campaigns' AND c.campaign_id = h.record_id)
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE h.kind = 'projects' AND p.project_id = h.record_id);
END
$$;
COMMENT ON FUNCTION d1_private.readers_rebuild() IS 'Recompute every readers table, operation_open_to_all and hidden_records from the functions (the migration''s backfill, the TRUNCATE repair, the operator''s repair after a restore). Takes the same global lock as refresh_readers(); raises unless READ COMMITTED.';

-- the lock-order trigger: BEFORE a statement on physical_samples or manufacturing_operations the readers lock is taken, so the
-- order is always readers lock, then rollup lock (the row triggers of migrations 126, 127 and 157 take the rollup lock during
-- those statements)
CREATE OR REPLACE FUNCTION d1_private.trg_readers_lock() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('d1_readers', 0));
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.trg_readers_lock() IS 'BEFORE STATEMENT trigger function on physical_samples and manufacturing_operations: takes the global readers lock before the statement''s own triggers take the rollup lock, so the lock order is always readers lock, then rollup lock.';

-- refresh_project_rollup() (migration 118): the same body, the readers lock first
CREATE OR REPLACE FUNCTION refresh_project_rollup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Lock order (migration 166): the readers lock, then the rollup lock. Fixed keys; xact-scoped, released on COMMIT or ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtextextended('d1_readers', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('refresh_project_rollup', 0));
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id)
    SELECT row_id, project_id, kind, code, detail, campaign_id FROM v_project_rollup;
END;
$$;

-- the drift check: every difference between the tables and the functions (without taking the lock)
CREATE OR REPLACE FUNCTION d1_private.readers_drift() RETURNS TABLE (kind text, record_id uuid, user_id uuid, problem text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
    s_all uuid[] := ARRAY(SELECT s.sample_id FROM physical_samples s);
    o_all uuid[] := ARRAY(SELECT o.operation_id FROM manufacturing_operations o);
    t_all uuid[] := ARRAY(SELECT t.session_id FROM test_sessions t);
    c_all uuid[] := ARRAY(SELECT c.campaign_id FROM campaigns c);
    p_all uuid[] := ARRAY(SELECT p.project_id FROM projects p);
    j_all uuid[] := ARRAY(SELECT cs.id FROM campaign_samples cs);
BEGIN
    RETURN QUERY
    WITH want AS MATERIALIZED (
             SELECT 'sample_readers'::text AS k, w.record_id AS rid, w.user_id AS uid FROM d1_private.readers_of_sample(s_all) w
             UNION ALL SELECT 'operation_readers', w.record_id, w.user_id FROM d1_private.readers_of_operation(o_all) w
             UNION ALL SELECT 'test_readers', w.record_id, w.user_id FROM d1_private.readers_of_test(t_all) w
             UNION ALL SELECT 'campaign_readers', w.record_id, w.user_id FROM d1_private.readers_of_campaign(c_all) w
             UNION ALL SELECT 'project_readers', w.record_id, w.user_id FROM d1_private.readers_of_project(p_all) w
             UNION ALL SELECT 'campaign_sample_readers', w.record_id, w.user_id FROM d1_private.readers_of_campaign_sample(j_all) w
             UNION ALL SELECT 'operation_open_to_all', w.record_id, NULL::uuid FROM d1_private.operation_open_of(o_all) w
             UNION ALL SELECT 'hidden:physical_samples', w.record_id, NULL::uuid FROM d1_private.hidden_of('physical_samples', s_all) w
             UNION ALL SELECT 'hidden:manufacturing_operations', w.record_id, NULL::uuid FROM d1_private.hidden_of('manufacturing_operations', o_all) w
             UNION ALL SELECT 'hidden:test_sessions', w.record_id, NULL::uuid FROM d1_private.hidden_of('test_sessions', t_all) w
             UNION ALL SELECT 'hidden:campaigns', w.record_id, NULL::uuid FROM d1_private.hidden_of('campaigns', c_all) w
             UNION ALL SELECT 'hidden:projects', w.record_id, NULL::uuid FROM d1_private.hidden_of('projects', p_all) w),
         have AS MATERIALIZED (
             SELECT 'sample_readers'::text AS k, r.record_id AS rid, r.user_id AS uid FROM sample_readers r
             UNION ALL SELECT 'operation_readers', r.record_id, r.user_id FROM operation_readers r
             UNION ALL SELECT 'test_readers', r.record_id, r.user_id FROM test_readers r
             UNION ALL SELECT 'campaign_readers', r.record_id, r.user_id FROM campaign_readers r
             UNION ALL SELECT 'project_readers', r.record_id, r.user_id FROM project_readers r
             UNION ALL SELECT 'campaign_sample_readers', r.record_id, r.user_id FROM campaign_sample_readers r
             UNION ALL SELECT 'operation_open_to_all', r.record_id, NULL::uuid FROM operation_open_to_all r
             UNION ALL SELECT 'hidden:' || h.kind, h.record_id, NULL::uuid FROM d1_private.hidden_records h)
    SELECT coalesce(w.k, h.k), coalesce(w.rid, h.rid), coalesce(w.uid, h.uid),
           CASE WHEN h.rid IS NULL THEN 'missing' ELSE 'extra' END
      FROM want w FULL JOIN have h ON h.k = w.k AND h.rid = w.rid AND h.uid IS NOT DISTINCT FROM w.uid
     WHERE w.rid IS NULL OR h.rid IS NULL;
END
$$;
COMMENT ON FUNCTION d1_private.readers_drift() IS 'Every row the functions would add (missing) or remove (extra) in the readers tables, operation_open_to_all, campaign_sample_readers and hidden_records (kind hidden:<collection>). Recomputes everything without taking the lock; empty means the tables equal the functions. The admin overview shows its count; readers_rebuild() repairs it.';

CREATE OR REPLACE FUNCTION d1_private.readers_drift_count() RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT count(*) FROM d1_private.readers_drift() $$;
COMMENT ON FUNCTION d1_private.readers_drift_count() IS 'The number of rows readers_drift() returns (0 when the tables equal the functions).';

-- 7. The recompute triggers (spec section 2, trigger coverage): one AFTER statement trigger per input and event, with transition tables.
CREATE OR REPLACE FUNCTION d1_private.trg_readers_physical_samples_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(r.sample_id)
      INTO v_seed_s
      FROM new_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_physical_samples_ins() IS 'Statement trigger function (INSERT on physical_samples): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_physical_samples_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(n.sample_id),
           array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_s, v_touch_p
      FROM old_rows o JOIN new_rows n ON n.sample_id = o.sample_id
     WHERE (n.owner_person_id, n.project_id, n.restricted) IS DISTINCT FROM (o.owner_person_id, o.project_id, o.restricted);
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_physical_samples_upd() IS 'Statement trigger function (UPDATE on physical_samples): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_physical_samples_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(r.sample_id),
           array_agg(r.project_id)
      INTO v_seed_s, v_touch_p
      FROM old_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_physical_samples_del() IS 'Statement trigger function (DELETE on physical_samples): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_manufacturing_operations_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
BEGIN
    SELECT array_agg(r.operation_id)
      INTO v_seed_o
      FROM new_rows r;
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_manufacturing_operations_ins() IS 'Statement trigger function (INSERT on manufacturing_operations): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_manufacturing_operations_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(n.operation_id),
           array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_o, v_touch_p
      FROM old_rows o JOIN new_rows n ON n.operation_id = o.operation_id
     WHERE (n.owner_person_id, n.project_id, n.campaign_id, n.sample_id, n.restricted) IS DISTINCT FROM (o.owner_person_id, o.project_id, o.campaign_id, o.sample_id, o.restricted);
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_manufacturing_operations_upd() IS 'Statement trigger function (UPDATE on manufacturing_operations): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_manufacturing_operations_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(r.operation_id),
           array_agg(r.project_id)
      INTO v_seed_o, v_touch_p
      FROM old_rows r;
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_manufacturing_operations_del() IS 'Statement trigger function (DELETE on manufacturing_operations): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_sessions_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
BEGIN
    SELECT array_agg(r.session_id)
      INTO v_seed_t
      FROM new_rows r;
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_sessions_ins() IS 'Statement trigger function (INSERT on test_sessions): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_sessions_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(n.session_id),
           array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_t, v_touch_p
      FROM old_rows o JOIN new_rows n ON n.session_id = o.session_id
     WHERE (n.owner_person_id, n.project_id, n.campaign_id, n.sample_id, n.restricted) IS DISTINCT FROM (o.owner_person_id, o.project_id, o.campaign_id, o.sample_id, o.restricted);
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_sessions_upd() IS 'Statement trigger function (UPDATE on test_sessions): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_sessions_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(r.session_id),
           array_agg(r.project_id)
      INTO v_seed_t, v_touch_p
      FROM old_rows r;
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_sessions_del() IS 'Statement trigger function (DELETE on test_sessions): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaigns_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
BEGIN
    SELECT array_agg(r.campaign_id)
      INTO v_seed_c
      FROM new_rows r;
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaigns_ins() IS 'Statement trigger function (INSERT on campaigns): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaigns_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(n.campaign_id),
           array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_c, v_touch_p
      FROM old_rows o JOIN new_rows n ON n.campaign_id = o.campaign_id
     WHERE (n.owner_person_id, n.project_id, n.restricted) IS DISTINCT FROM (o.owner_person_id, o.project_id, o.restricted);
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaigns_upd() IS 'Statement trigger function (UPDATE on campaigns): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaigns_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
    v_touch_p uuid[];
BEGIN
    SELECT array_agg(r.campaign_id),
           array_agg(r.project_id)
      INTO v_seed_c, v_touch_p
      FROM old_rows r;
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, d1_private.uniq(v_touch_p), NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaigns_del() IS 'Statement trigger function (DELETE on campaigns): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_projects_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(r.project_id)
      INTO v_seed_p
      FROM new_rows r;
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_projects_ins() IS 'Statement trigger function (INSERT on projects): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_projects_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(n.project_id)
      INTO v_seed_p
      FROM old_rows o JOIN new_rows n ON n.project_id = o.project_id
     WHERE (n.principal_investigator_person, n.restricted) IS DISTINCT FROM (o.principal_investigator_person, o.restricted);
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_projects_upd() IS 'Statement trigger function (UPDATE on projects): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_projects_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(r.project_id)
      INTO v_seed_p
      FROM old_rows r;
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_projects_del() IS 'Statement trigger function (DELETE on projects): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_investigators_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(r.project_id)
      INTO v_seed_p
      FROM new_rows r;
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_investigators_ins() IS 'Statement trigger function (INSERT on project_investigators): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_investigators_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(o.project_id) || array_agg(n.project_id)
      INTO v_seed_p
      FROM old_rows o JOIN new_rows n ON n.id = o.id
     WHERE (n.project_id, n.user_id) IS DISTINCT FROM (o.project_id, o.user_id);
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_investigators_upd() IS 'Statement trigger function (UPDATE on project_investigators): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_investigators_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(r.project_id)
      INTO v_seed_p
      FROM old_rows r;
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_investigators_del() IS 'Statement trigger function (DELETE on project_investigators): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_access_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(r.project_id)
      INTO v_seed_p
      FROM new_rows r;
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_access_ins() IS 'Statement trigger function (INSERT on project_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

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

CREATE OR REPLACE FUNCTION d1_private.trg_readers_project_access_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_p uuid[];
BEGIN
    SELECT array_agg(r.project_id)
      INTO v_seed_p
      FROM old_rows r;
    IF v_seed_p IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, NULL, d1_private.uniq(v_seed_p), NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_project_access_del() IS 'Statement trigger function (DELETE on project_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_samples_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
    v_touch_c uuid[];
    v_touch_j uuid[];
BEGIN
    SELECT array_agg(r.sample_id),
           array_agg(r.campaign_id),
           array_agg(r.id)
      INTO v_seed_s, v_touch_c, v_touch_j
      FROM new_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_c), NULL, d1_private.uniq(v_touch_j));
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_samples_ins() IS 'Statement trigger function (INSERT on campaign_samples): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_samples_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
    v_touch_c uuid[];
    v_touch_j uuid[];
BEGIN
    SELECT array_agg(o.sample_id) || array_agg(n.sample_id),
           array_agg(o.campaign_id) || array_agg(n.campaign_id),
           array_agg(n.id)
      INTO v_seed_s, v_touch_c, v_touch_j
      FROM old_rows o JOIN new_rows n ON n.id = o.id
     WHERE (n.campaign_id, n.sample_id) IS DISTINCT FROM (o.campaign_id, o.sample_id);
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_c), NULL, d1_private.uniq(v_touch_j));
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_samples_upd() IS 'Statement trigger function (UPDATE on campaign_samples): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_samples_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
    v_touch_c uuid[];
BEGIN
    SELECT array_agg(r.sample_id),
           array_agg(r.campaign_id)
      INTO v_seed_s, v_touch_c
      FROM old_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, d1_private.uniq(v_touch_c), NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_samples_del() IS 'Statement trigger function (DELETE on campaign_samples): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_co_owners_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(r.sample_id)
      INTO v_seed_s
      FROM new_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_co_owners_ins() IS 'Statement trigger function (INSERT on sample_co_owners): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_co_owners_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(o.sample_id) || array_agg(n.sample_id)
      INTO v_seed_s
      FROM old_rows o JOIN new_rows n ON n.id = o.id
     WHERE (n.sample_id, n.user_id) IS DISTINCT FROM (o.sample_id, o.user_id);
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_co_owners_upd() IS 'Statement trigger function (UPDATE on sample_co_owners): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_co_owners_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(r.sample_id)
      INTO v_seed_s
      FROM old_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_co_owners_del() IS 'Statement trigger function (DELETE on sample_co_owners): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_access_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(r.sample_id)
      INTO v_seed_s
      FROM new_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_access_ins() IS 'Statement trigger function (INSERT on sample_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

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

CREATE OR REPLACE FUNCTION d1_private.trg_readers_sample_access_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_s uuid[];
BEGIN
    SELECT array_agg(r.sample_id)
      INTO v_seed_s
      FROM old_rows r;
    IF v_seed_s IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(d1_private.uniq(v_seed_s), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_sample_access_del() IS 'Statement trigger function (DELETE on sample_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_operation_access_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
BEGIN
    SELECT array_agg(r.operation_id)
      INTO v_seed_o
      FROM new_rows r;
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_operation_access_ins() IS 'Statement trigger function (INSERT on operation_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

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

CREATE OR REPLACE FUNCTION d1_private.trg_readers_operation_access_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_o uuid[];
BEGIN
    SELECT array_agg(r.operation_id)
      INTO v_seed_o
      FROM old_rows r;
    IF v_seed_o IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, d1_private.uniq(v_seed_o), NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_operation_access_del() IS 'Statement trigger function (DELETE on operation_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_access_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
BEGIN
    SELECT array_agg(r.session_id)
      INTO v_seed_t
      FROM new_rows r;
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_access_ins() IS 'Statement trigger function (INSERT on test_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

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

CREATE OR REPLACE FUNCTION d1_private.trg_readers_test_access_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_t uuid[];
BEGIN
    SELECT array_agg(r.session_id)
      INTO v_seed_t
      FROM old_rows r;
    IF v_seed_t IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, d1_private.uniq(v_seed_t), NULL, NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_test_access_del() IS 'Statement trigger function (DELETE on test_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_access_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
BEGIN
    SELECT array_agg(r.campaign_id)
      INTO v_seed_c
      FROM new_rows r;
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_access_ins() IS 'Statement trigger function (INSERT on campaign_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

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

CREATE OR REPLACE FUNCTION d1_private.trg_readers_campaign_access_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    v_seed_c uuid[];
BEGIN
    SELECT array_agg(r.campaign_id)
      INTO v_seed_c
      FROM old_rows r;
    IF v_seed_c IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(NULL, NULL, NULL, d1_private.uniq(v_seed_c), NULL, NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_campaign_access_del() IS 'Statement trigger function (DELETE on campaign_access): says which records to recompute and calls d1_private.refresh_readers; no visibility logic (spec section 2, trigger coverage).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_people_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    pids uuid[];
BEGIN
    SELECT array_agg(n.person_id) INTO pids
      FROM old_rows o JOIN new_rows n ON n.person_id = o.person_id
     WHERE n.user_id IS DISTINCT FROM o.user_id;
    IF pids IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM d1_private.refresh_readers(
        ARRAY(SELECT s.sample_id FROM physical_samples s WHERE s.owner_person_id = ANY (pids)
              UNION SELECT a.sample_id FROM sample_access a WHERE a.person_id = ANY (pids)),
        ARRAY(SELECT o.operation_id FROM manufacturing_operations o WHERE o.owner_person_id = ANY (pids)
              UNION SELECT a.operation_id FROM operation_access a WHERE a.person_id = ANY (pids)),
        ARRAY(SELECT t.session_id FROM test_sessions t WHERE t.owner_person_id = ANY (pids)
              UNION SELECT a.session_id FROM test_access a WHERE a.person_id = ANY (pids)),
        ARRAY(SELECT c.campaign_id FROM campaigns c WHERE c.owner_person_id = ANY (pids)
              UNION SELECT a.campaign_id FROM campaign_access a WHERE a.person_id = ANY (pids)),
        ARRAY(SELECT p.project_id FROM projects p WHERE p.principal_investigator_person = ANY (pids)
              UNION SELECT a.project_id FROM project_access a WHERE a.person_id = ANY (pids)),
        NULL, NULL, NULL, NULL);
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_people_upd() IS 'Statement trigger function (UPDATE on people): a login linked, unlinked or changed (people.user_id) reaches every record whose owner, PI or access entry is the person; refresh_readers recomputes their closure (spec section 2, trigger coverage row 45).';

CREATE OR REPLACE FUNCTION d1_private.trg_readers_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    PERFORM d1_private.readers_rebuild();
    RETURN NULL;
END
$$;

COMMENT ON FUNCTION d1_private.trg_readers_truncate() IS 'Statement trigger function (TRUNCATE of any input table): rebuilds every readers table (a TRUNCATE ... CASCADE also emptied the readers tables through their foreign keys).';

DROP TRIGGER IF EXISTS physical_samples_readers_ins ON physical_samples;
CREATE TRIGGER physical_samples_readers_ins AFTER INSERT ON physical_samples REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_physical_samples_ins();
COMMENT ON TRIGGER physical_samples_readers_ins ON physical_samples IS 'Recomputes the readers of what a INSERT of physical_samples can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS physical_samples_readers_upd ON physical_samples;
CREATE TRIGGER physical_samples_readers_upd AFTER UPDATE ON physical_samples REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_physical_samples_upd();
COMMENT ON TRIGGER physical_samples_readers_upd ON physical_samples IS 'Recomputes the readers of what a UPDATE of physical_samples can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS physical_samples_readers_del ON physical_samples;
CREATE TRIGGER physical_samples_readers_del AFTER DELETE ON physical_samples REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_physical_samples_del();
COMMENT ON TRIGGER physical_samples_readers_del ON physical_samples IS 'Recomputes the readers of what a DELETE of physical_samples can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS manufacturing_operations_readers_ins ON manufacturing_operations;
CREATE TRIGGER manufacturing_operations_readers_ins AFTER INSERT ON manufacturing_operations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_manufacturing_operations_ins();
COMMENT ON TRIGGER manufacturing_operations_readers_ins ON manufacturing_operations IS 'Recomputes the readers of what a INSERT of manufacturing_operations can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS manufacturing_operations_readers_upd ON manufacturing_operations;
CREATE TRIGGER manufacturing_operations_readers_upd AFTER UPDATE ON manufacturing_operations REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_manufacturing_operations_upd();
COMMENT ON TRIGGER manufacturing_operations_readers_upd ON manufacturing_operations IS 'Recomputes the readers of what a UPDATE of manufacturing_operations can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS manufacturing_operations_readers_del ON manufacturing_operations;
CREATE TRIGGER manufacturing_operations_readers_del AFTER DELETE ON manufacturing_operations REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_manufacturing_operations_del();
COMMENT ON TRIGGER manufacturing_operations_readers_del ON manufacturing_operations IS 'Recomputes the readers of what a DELETE of manufacturing_operations can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS test_sessions_readers_ins ON test_sessions;
CREATE TRIGGER test_sessions_readers_ins AFTER INSERT ON test_sessions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_test_sessions_ins();
COMMENT ON TRIGGER test_sessions_readers_ins ON test_sessions IS 'Recomputes the readers of what a INSERT of test_sessions can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS test_sessions_readers_upd ON test_sessions;
CREATE TRIGGER test_sessions_readers_upd AFTER UPDATE ON test_sessions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_test_sessions_upd();
COMMENT ON TRIGGER test_sessions_readers_upd ON test_sessions IS 'Recomputes the readers of what a UPDATE of test_sessions can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS test_sessions_readers_del ON test_sessions;
CREATE TRIGGER test_sessions_readers_del AFTER DELETE ON test_sessions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_test_sessions_del();
COMMENT ON TRIGGER test_sessions_readers_del ON test_sessions IS 'Recomputes the readers of what a DELETE of test_sessions can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaigns_readers_ins ON campaigns;
CREATE TRIGGER campaigns_readers_ins AFTER INSERT ON campaigns REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaigns_ins();
COMMENT ON TRIGGER campaigns_readers_ins ON campaigns IS 'Recomputes the readers of what a INSERT of campaigns can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaigns_readers_upd ON campaigns;
CREATE TRIGGER campaigns_readers_upd AFTER UPDATE ON campaigns REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaigns_upd();
COMMENT ON TRIGGER campaigns_readers_upd ON campaigns IS 'Recomputes the readers of what a UPDATE of campaigns can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaigns_readers_del ON campaigns;
CREATE TRIGGER campaigns_readers_del AFTER DELETE ON campaigns REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaigns_del();
COMMENT ON TRIGGER campaigns_readers_del ON campaigns IS 'Recomputes the readers of what a DELETE of campaigns can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS projects_readers_ins ON projects;
CREATE TRIGGER projects_readers_ins AFTER INSERT ON projects REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_projects_ins();
COMMENT ON TRIGGER projects_readers_ins ON projects IS 'Recomputes the readers of what a INSERT of projects can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS projects_readers_upd ON projects;
CREATE TRIGGER projects_readers_upd AFTER UPDATE ON projects REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_projects_upd();
COMMENT ON TRIGGER projects_readers_upd ON projects IS 'Recomputes the readers of what a UPDATE of projects can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS projects_readers_del ON projects;
CREATE TRIGGER projects_readers_del AFTER DELETE ON projects REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_projects_del();
COMMENT ON TRIGGER projects_readers_del ON projects IS 'Recomputes the readers of what a DELETE of projects can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS project_investigators_readers_ins ON project_investigators;
CREATE TRIGGER project_investigators_readers_ins AFTER INSERT ON project_investigators REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_project_investigators_ins();
COMMENT ON TRIGGER project_investigators_readers_ins ON project_investigators IS 'Recomputes the readers of what a INSERT of project_investigators can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS project_investigators_readers_upd ON project_investigators;
CREATE TRIGGER project_investigators_readers_upd AFTER UPDATE ON project_investigators REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_project_investigators_upd();
COMMENT ON TRIGGER project_investigators_readers_upd ON project_investigators IS 'Recomputes the readers of what a UPDATE of project_investigators can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS project_investigators_readers_del ON project_investigators;
CREATE TRIGGER project_investigators_readers_del AFTER DELETE ON project_investigators REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_project_investigators_del();
COMMENT ON TRIGGER project_investigators_readers_del ON project_investigators IS 'Recomputes the readers of what a DELETE of project_investigators can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS project_access_readers_ins ON project_access;
CREATE TRIGGER project_access_readers_ins AFTER INSERT ON project_access REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_project_access_ins();
COMMENT ON TRIGGER project_access_readers_ins ON project_access IS 'Recomputes the readers of what a INSERT of project_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS project_access_readers_upd ON project_access;
CREATE TRIGGER project_access_readers_upd AFTER UPDATE ON project_access REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_project_access_upd();
COMMENT ON TRIGGER project_access_readers_upd ON project_access IS 'Recomputes the readers of what a UPDATE of project_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS project_access_readers_del ON project_access;
CREATE TRIGGER project_access_readers_del AFTER DELETE ON project_access REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_project_access_del();
COMMENT ON TRIGGER project_access_readers_del ON project_access IS 'Recomputes the readers of what a DELETE of project_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaign_samples_readers_ins ON campaign_samples;
CREATE TRIGGER campaign_samples_readers_ins AFTER INSERT ON campaign_samples REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaign_samples_ins();
COMMENT ON TRIGGER campaign_samples_readers_ins ON campaign_samples IS 'Recomputes the readers of what a INSERT of campaign_samples can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaign_samples_readers_upd ON campaign_samples;
CREATE TRIGGER campaign_samples_readers_upd AFTER UPDATE ON campaign_samples REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaign_samples_upd();
COMMENT ON TRIGGER campaign_samples_readers_upd ON campaign_samples IS 'Recomputes the readers of what a UPDATE of campaign_samples can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaign_samples_readers_del ON campaign_samples;
CREATE TRIGGER campaign_samples_readers_del AFTER DELETE ON campaign_samples REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaign_samples_del();
COMMENT ON TRIGGER campaign_samples_readers_del ON campaign_samples IS 'Recomputes the readers of what a DELETE of campaign_samples can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS sample_co_owners_readers_ins ON sample_co_owners;
CREATE TRIGGER sample_co_owners_readers_ins AFTER INSERT ON sample_co_owners REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_sample_co_owners_ins();
COMMENT ON TRIGGER sample_co_owners_readers_ins ON sample_co_owners IS 'Recomputes the readers of what a INSERT of sample_co_owners can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS sample_co_owners_readers_upd ON sample_co_owners;
CREATE TRIGGER sample_co_owners_readers_upd AFTER UPDATE ON sample_co_owners REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_sample_co_owners_upd();
COMMENT ON TRIGGER sample_co_owners_readers_upd ON sample_co_owners IS 'Recomputes the readers of what a UPDATE of sample_co_owners can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS sample_co_owners_readers_del ON sample_co_owners;
CREATE TRIGGER sample_co_owners_readers_del AFTER DELETE ON sample_co_owners REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_sample_co_owners_del();
COMMENT ON TRIGGER sample_co_owners_readers_del ON sample_co_owners IS 'Recomputes the readers of what a DELETE of sample_co_owners can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS sample_access_readers_ins ON sample_access;
CREATE TRIGGER sample_access_readers_ins AFTER INSERT ON sample_access REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_sample_access_ins();
COMMENT ON TRIGGER sample_access_readers_ins ON sample_access IS 'Recomputes the readers of what a INSERT of sample_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS sample_access_readers_upd ON sample_access;
CREATE TRIGGER sample_access_readers_upd AFTER UPDATE ON sample_access REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_sample_access_upd();
COMMENT ON TRIGGER sample_access_readers_upd ON sample_access IS 'Recomputes the readers of what a UPDATE of sample_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS sample_access_readers_del ON sample_access;
CREATE TRIGGER sample_access_readers_del AFTER DELETE ON sample_access REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_sample_access_del();
COMMENT ON TRIGGER sample_access_readers_del ON sample_access IS 'Recomputes the readers of what a DELETE of sample_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS operation_access_readers_ins ON operation_access;
CREATE TRIGGER operation_access_readers_ins AFTER INSERT ON operation_access REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_operation_access_ins();
COMMENT ON TRIGGER operation_access_readers_ins ON operation_access IS 'Recomputes the readers of what a INSERT of operation_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS operation_access_readers_upd ON operation_access;
CREATE TRIGGER operation_access_readers_upd AFTER UPDATE ON operation_access REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_operation_access_upd();
COMMENT ON TRIGGER operation_access_readers_upd ON operation_access IS 'Recomputes the readers of what a UPDATE of operation_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS operation_access_readers_del ON operation_access;
CREATE TRIGGER operation_access_readers_del AFTER DELETE ON operation_access REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_operation_access_del();
COMMENT ON TRIGGER operation_access_readers_del ON operation_access IS 'Recomputes the readers of what a DELETE of operation_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS test_access_readers_ins ON test_access;
CREATE TRIGGER test_access_readers_ins AFTER INSERT ON test_access REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_test_access_ins();
COMMENT ON TRIGGER test_access_readers_ins ON test_access IS 'Recomputes the readers of what a INSERT of test_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS test_access_readers_upd ON test_access;
CREATE TRIGGER test_access_readers_upd AFTER UPDATE ON test_access REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_test_access_upd();
COMMENT ON TRIGGER test_access_readers_upd ON test_access IS 'Recomputes the readers of what a UPDATE of test_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS test_access_readers_del ON test_access;
CREATE TRIGGER test_access_readers_del AFTER DELETE ON test_access REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_test_access_del();
COMMENT ON TRIGGER test_access_readers_del ON test_access IS 'Recomputes the readers of what a DELETE of test_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaign_access_readers_ins ON campaign_access;
CREATE TRIGGER campaign_access_readers_ins AFTER INSERT ON campaign_access REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaign_access_ins();
COMMENT ON TRIGGER campaign_access_readers_ins ON campaign_access IS 'Recomputes the readers of what a INSERT of campaign_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaign_access_readers_upd ON campaign_access;
CREATE TRIGGER campaign_access_readers_upd AFTER UPDATE ON campaign_access REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaign_access_upd();
COMMENT ON TRIGGER campaign_access_readers_upd ON campaign_access IS 'Recomputes the readers of what a UPDATE of campaign_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS campaign_access_readers_del ON campaign_access;
CREATE TRIGGER campaign_access_readers_del AFTER DELETE ON campaign_access REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_campaign_access_del();
COMMENT ON TRIGGER campaign_access_readers_del ON campaign_access IS 'Recomputes the readers of what a DELETE of campaign_access can change (A1a, migration 166). Statement trigger with transition tables; fires before refresh_rollup_* (readers lock first).';
DROP TRIGGER IF EXISTS people_readers_upd ON people;
CREATE TRIGGER people_readers_upd AFTER UPDATE ON people REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_people_upd();
COMMENT ON TRIGGER people_readers_upd ON people IS 'A login linked, unlinked or changed (people.user_id) recomputes the readers of every record the person owns, leads or is listed on (A1a, migration 166).';
DROP TRIGGER IF EXISTS physical_samples_readers_trunc ON physical_samples;
CREATE TRIGGER physical_samples_readers_trunc AFTER TRUNCATE ON physical_samples FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER physical_samples_readers_trunc ON physical_samples IS 'A TRUNCATE of physical_samples rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS manufacturing_operations_readers_trunc ON manufacturing_operations;
CREATE TRIGGER manufacturing_operations_readers_trunc AFTER TRUNCATE ON manufacturing_operations FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER manufacturing_operations_readers_trunc ON manufacturing_operations IS 'A TRUNCATE of manufacturing_operations rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS test_sessions_readers_trunc ON test_sessions;
CREATE TRIGGER test_sessions_readers_trunc AFTER TRUNCATE ON test_sessions FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER test_sessions_readers_trunc ON test_sessions IS 'A TRUNCATE of test_sessions rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS campaigns_readers_trunc ON campaigns;
CREATE TRIGGER campaigns_readers_trunc AFTER TRUNCATE ON campaigns FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER campaigns_readers_trunc ON campaigns IS 'A TRUNCATE of campaigns rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS projects_readers_trunc ON projects;
CREATE TRIGGER projects_readers_trunc AFTER TRUNCATE ON projects FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER projects_readers_trunc ON projects IS 'A TRUNCATE of projects rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS sample_access_readers_trunc ON sample_access;
CREATE TRIGGER sample_access_readers_trunc AFTER TRUNCATE ON sample_access FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER sample_access_readers_trunc ON sample_access IS 'A TRUNCATE of sample_access rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS operation_access_readers_trunc ON operation_access;
CREATE TRIGGER operation_access_readers_trunc AFTER TRUNCATE ON operation_access FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER operation_access_readers_trunc ON operation_access IS 'A TRUNCATE of operation_access rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS test_access_readers_trunc ON test_access;
CREATE TRIGGER test_access_readers_trunc AFTER TRUNCATE ON test_access FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER test_access_readers_trunc ON test_access IS 'A TRUNCATE of test_access rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS campaign_access_readers_trunc ON campaign_access;
CREATE TRIGGER campaign_access_readers_trunc AFTER TRUNCATE ON campaign_access FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER campaign_access_readers_trunc ON campaign_access IS 'A TRUNCATE of campaign_access rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS project_access_readers_trunc ON project_access;
CREATE TRIGGER project_access_readers_trunc AFTER TRUNCATE ON project_access FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER project_access_readers_trunc ON project_access IS 'A TRUNCATE of project_access rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS campaign_samples_readers_trunc ON campaign_samples;
CREATE TRIGGER campaign_samples_readers_trunc AFTER TRUNCATE ON campaign_samples FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER campaign_samples_readers_trunc ON campaign_samples IS 'A TRUNCATE of campaign_samples rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS sample_co_owners_readers_trunc ON sample_co_owners;
CREATE TRIGGER sample_co_owners_readers_trunc AFTER TRUNCATE ON sample_co_owners FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER sample_co_owners_readers_trunc ON sample_co_owners IS 'A TRUNCATE of sample_co_owners rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS project_investigators_readers_trunc ON project_investigators;
CREATE TRIGGER project_investigators_readers_trunc AFTER TRUNCATE ON project_investigators FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER project_investigators_readers_trunc ON project_investigators IS 'A TRUNCATE of project_investigators rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS people_readers_trunc ON people;
CREATE TRIGGER people_readers_trunc AFTER TRUNCATE ON people FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER people_readers_trunc ON people IS 'A TRUNCATE of people rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS directus_users_readers_trunc ON directus_users;
CREATE TRIGGER directus_users_readers_trunc AFTER TRUNCATE ON directus_users FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_truncate();
COMMENT ON TRIGGER directus_users_readers_trunc ON directus_users IS 'A TRUNCATE of directus_users rebuilds the readers tables (A1a, migration 166).';
DROP TRIGGER IF EXISTS physical_samples_readers_lock ON physical_samples;
CREATE TRIGGER physical_samples_readers_lock BEFORE INSERT OR UPDATE OR DELETE ON physical_samples FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_lock();
COMMENT ON TRIGGER physical_samples_readers_lock ON physical_samples IS 'Takes the global readers lock before the statement''s row triggers take the rollup lock (migrations 126, 127, 157): the lock order is always readers lock, then rollup lock (A1a, migration 166).';
DROP TRIGGER IF EXISTS manufacturing_operations_readers_lock ON manufacturing_operations;
CREATE TRIGGER manufacturing_operations_readers_lock BEFORE INSERT OR UPDATE OR DELETE ON manufacturing_operations FOR EACH STATEMENT EXECUTE FUNCTION d1_private.trg_readers_lock();
COMMENT ON TRIGGER manufacturing_operations_readers_lock ON manufacturing_operations IS 'Takes the global readers lock before the statement''s row triggers take the rollup lock (migrations 126, 127, 157): the lock order is always readers lock, then rollup lock (A1a, migration 166).';

-- the write functions are called by the statement triggers (SECURITY DEFINER) and by the owner; nobody else needs them
REVOKE ALL ON FUNCTION d1_private.refresh_readers(uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.sync_readers(uuid[], uuid[], uuid[], uuid[], uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION d1_private.readers_rebuild() FROM PUBLIC;

-- 8. The Directus metadata the rules walk (as migration 165 does for the access lists): hidden collections, the parent relations
-- with the hidden O2M alias `readers` (`open_to_all` for the amnesty set), the readers' user_id -> directus_users relations
-- (no alias), and the hidden read-only alias fields. scripts/configure_directus.sql keeps them (phase1 checks after it runs).
INSERT INTO directus_collections (collection, icon, note, hidden, sort)
SELECT v.collection, 'lock', v.note, TRUE, v.sort
FROM (VALUES
    ('sample_readers', 'Derived: who may read each sample (A1a, migration 166); written only by the recompute triggers', 97),
    ('operation_readers', 'Derived: who may read each operation (A1a, migration 166); written only by the recompute triggers', 98),
    ('test_readers', 'Derived: who may read each test session (A1a, migration 166); written only by the recompute triggers', 99),
    ('campaign_readers', 'Derived: who may read each campaign (A1a, migration 166); written only by the recompute triggers', 100),
    ('project_readers', 'Derived: who may read each project (A1a, migration 166); written only by the recompute triggers', 101),
    ('campaign_sample_readers', 'Derived: who may read each campaign_samples row (A1a, migration 166); written only by the recompute triggers', 102),
    ('operation_open_to_all', 'Derived: the operations every member may read, the narrowed orphan amnesty (A1a, migration 166)', 103)
) AS v (collection, note, sort)
WHERE NOT EXISTS (SELECT 1 FROM directus_collections AS c WHERE c.collection = v.collection);

DO $$
DECLARE
    r        RECORD;
    existing RECORD;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('sample_readers', 'record_id', 'physical_samples', 'readers', 'delete'),
            ('operation_readers', 'record_id', 'manufacturing_operations', 'readers', 'delete'),
            ('test_readers', 'record_id', 'test_sessions', 'readers', 'delete'),
            ('campaign_readers', 'record_id', 'campaigns', 'readers', 'delete'),
            ('project_readers', 'record_id', 'projects', 'readers', 'delete'),
            ('campaign_sample_readers', 'record_id', 'campaign_samples', 'readers', 'delete'),
            ('operation_open_to_all', 'record_id', 'manufacturing_operations', 'open_to_all', 'delete'),
            ('sample_readers', 'user_id', 'directus_users', NULL, 'nullify'),
            ('operation_readers', 'user_id', 'directus_users', NULL, 'nullify'),
            ('test_readers', 'user_id', 'directus_users', NULL, 'nullify'),
            ('campaign_readers', 'user_id', 'directus_users', NULL, 'nullify'),
            ('project_readers', 'user_id', 'directus_users', NULL, 'nullify'),
            ('campaign_sample_readers', 'user_id', 'directus_users', NULL, 'nullify')
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
                RAISE EXCEPTION 'A1a: cannot add relation %.% -> %: alias %.% is already used by another relation',
                    r.many_collection, r.many_field, r.one_collection, r.one_collection, r.one_field;
            END IF;
            INSERT INTO directus_relations
                (many_collection, many_field, one_collection, one_field, one_deselect_action)
            VALUES (r.many_collection, r.many_field, r.one_collection, r.one_field, r.deselect);
        ELSIF existing.one_collection IS DISTINCT FROM r.one_collection THEN
            RAISE EXCEPTION 'A1a: directus_relations has %.% -> % but the readers rules need -> %',
                r.many_collection, r.many_field, existing.one_collection, r.one_collection;
        ELSIF existing.one_field IS DISTINCT FROM r.one_field THEN
            RAISE EXCEPTION 'A1a: relation %.% has the alias % but the readers rules walk %',
                r.many_collection, r.many_field, existing.one_field, r.one_field;
        END IF;
    END LOOP;
END
$$;

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, TRUE, TRUE, v.sort, v.width, v.note
FROM (VALUES
    ('physical_samples', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 93, 'full',
        'Hidden alias over sample_readers.record_id: who may read the sample, the membership test the read rule uses (A1a, migration 166).'),
    ('manufacturing_operations', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 93, 'full',
        'Hidden alias over operation_readers.record_id: who may read the operation, the membership test the read rule uses (A1a, migration 166).'),
    ('manufacturing_operations', 'open_to_all', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 94, 'full',
        'Hidden alias over operation_open_to_all.record_id: the amnesty leaf of the operations read rule (A1a, migration 166).'),
    ('test_sessions', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 93, 'full',
        'Hidden alias over test_readers.record_id: who may read the test session, the membership test the read rule uses (A1a, migration 166).'),
    ('campaigns', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 93, 'full',
        'Hidden alias over campaign_readers.record_id: who may read the campaign, the membership test the read rule uses (A1a, migration 166).'),
    ('projects', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 93, 'full',
        'Hidden alias over project_readers.record_id: who may read the project, the membership test the read rule uses (A1a, migration 166).'),
    ('campaign_samples', 'readers', 'o2m', 'list-o2m', '{"enableCreate":false,"enableSelect":false}', 'related-values', 93, 'full',
        'Hidden alias over campaign_sample_readers.record_id: who may read the junction row, the membership test the read rule uses (A1a, migration 166).')
) AS v (collection, field, special, interface, options, display, sort, width, note)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields AS f WHERE f.collection = v.collection AND f.field = v.field
);

-- 9. Backfill: every readers table from the functions (a no-op diff when the tables are already right).
SELECT d1_private.readers_rebuild();

DO $$
BEGIN
    RAISE NOTICE 'A1a readers backfill: % sample_readers, % operation_readers, % test_readers, % campaign_readers, % project_readers, % campaign_sample_readers, % operation_open_to_all, % hidden_records; drift rows: %',
        (SELECT count(*) FROM sample_readers), (SELECT count(*) FROM operation_readers), (SELECT count(*) FROM test_readers),
        (SELECT count(*) FROM campaign_readers), (SELECT count(*) FROM project_readers), (SELECT count(*) FROM campaign_sample_readers),
        (SELECT count(*) FROM operation_open_to_all), (SELECT count(*) FROM d1_private.hidden_records), d1_private.readers_drift_count();
END
$$;

-- 10. The Lab Member rows (second part of this migration; spec section 3). Read visibility is the readers tables above, so the read
-- rule of each record type is ONE membership test on them (`readers._some.user_id = $CURRENT_USER`; the operations rule ORs the
-- `open_to_all` leaf, the narrowed orphan amnesty), a child of a record reads through one bare hop to its parent's readers
-- (`operation_id.readers.user_id`), campaign_samples through its own `readers` alias, sample_genealogy through the one two-hop OR left;
-- update, delete and manage of operations, tests and campaigns are the reader term AND the editor or owner test (a bare hop, never
-- `_some`: a legal `_some` applies the readers table's own rule for the action), campaign_samples update and delete need the junction's
-- own reader term too; sample_co_owners update and delete are owner-only (before, any co-owner could repoint or delete a co-owner row,
-- which on a restricted sample leaks it). The five access tables, the readers tables, campaign_sample_readers and operation_open_to_all
-- get a Lab Member read row (own rows only, operation_open_to_all every row) and no other grant: only the recompute triggers and the
-- record-access endpoint write them. project_rollup is untouched here (migration 167 refines it). The eleven *_params tables have no
-- rows to rule: migration 20260623000032 dropped them (their fields are columns of manufacturing_operations and test_sessions).
--
-- The rows are `python3 scripts/gen_access_rules.py --values --only <the collections above>` (a snapshot of the rules on 2026-10-13, as in
-- 20261012000161). A Lab Member row whose permissions or validation differ is updated; a missing row is inserted (fields '*'). What it
-- changes or adds is kept in d1_private.lab_member_access_rules_backup for `down`, which removes this block FIRST (before the readers).
--
-- Apply this TOGETHER WITH migration 167 and the Task 3 extensions of the same release (d1-access-guard with the owner-only restricted
-- field and the manage-rule junction guards, and d1-record-access, the only writer of the access tables). Directus caches permissions
-- and reads relations at start-up: flush Redis and restart Directus after applying.

CREATE TABLE IF NOT EXISTS d1_private.lab_member_access_rules_backup (
    id          INTEGER PRIMARY KEY,
    permissions JSON,
    validation  JSON,
    inserted    BOOLEAN NOT NULL DEFAULT FALSE
);
COMMENT ON TABLE d1_private.lab_member_access_rules_backup IS
    'Migration 20261012000166: the Lab Member permission rows it changed (directus_permissions.id with the old permissions and validation) or inserted (inserted = true). `migrate:down` restores or deletes them and drops the table.';

CREATE TEMP TABLE _lm_access_rules (collection TEXT, action TEXT, filter JSON, validation JSON, fields TEXT) ON COMMIT DROP;
INSERT INTO _lm_access_rules (collection, action, filter, validation, fields) VALUES
    ('physical_samples', 'create', '{}', '{}', '*'),
    ('physical_samples', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('physical_samples', 'update', '{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit"]}}}]}]}', '{}', '*'),
    ('physical_samples', 'delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('manufacturing_operations', 'create', '{}', '{}', '*'),
    ('manufacturing_operations', 'read', '{"_or":[{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"open_to_all":{"_some":{"record_id":{"_nnull":true}}}}]}', '{}', '*'),
    ('manufacturing_operations', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit"]}}}]},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}]}]}]}', '{}', '*'),
    ('manufacturing_operations', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}', '{}', '*'),
    ('test_sessions', 'create', '{}', '{}', '*'),
    ('test_sessions', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('test_sessions', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit"]}}}]},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}]}]}]}', '{}', '*'),
    ('test_sessions', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}', '{}', '*'),
    ('campaigns', 'create', '{}', '{}', '*'),
    ('campaigns', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('campaigns', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_and":[{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"access":{"role":{"_in":["edit"]}}}]}]}]}', '{}', '*'),
    ('campaigns', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}', '{}', '*'),
    ('projects', 'create', '{}', '{}', '*'),
    ('projects', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('projects', 'update', '{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('projects', 'delete', '{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('sample_co_owners', 'create', '{}', '{}', '*'),
    ('sample_co_owners', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_co_owners', 'update', '{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_co_owners', 'delete', '{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_stock_provenance', 'create', '{}', '{}', '*'),
    ('sample_stock_provenance', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_stock_provenance', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}', '{}', '*'),
    ('sample_stock_provenance', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}', '{}', '*'),
    ('sample_data_files', 'create', '{}', '{}', '*'),
    ('sample_data_files', 'read', '{"sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_data_files', 'update', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}', '{}', '*'),
    ('sample_data_files', 'delete', '{"_or":[{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}', '{}', '*'),
    ('sample_genealogy', 'create', '{}', '{}', '*'),
    ('sample_genealogy', 'read', '{"_or":[{"child_sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"parent_sample_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}]}', '{}', '*'),
    ('sample_genealogy', 'update', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"child_sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}', '{}', '*'),
    ('sample_genealogy', 'delete', '{"_or":[{"child_sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"child_sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"child_sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"child_sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}', '{}', '*'),
    ('campaign_samples', 'create', '{}', '{}', '*'),
    ('campaign_samples', 'read', '{"readers":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('campaign_samples', 'update', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}]}', '{}', '*'),
    ('campaign_samples', 'delete', '{"_and":[{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}},{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"sample_id":{"access":{"role":{"_in":["edit"]}}}}]}]}]}', '{}', '*'),
    ('operation_data_files', 'create', '{}', '{}', '*'),
    ('operation_data_files', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('operation_data_files', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('operation_data_files', 'delete', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('machining_force_analysis', 'create', '{}', '{}', '*'),
    ('machining_force_analysis', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('machining_force_analysis', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('fast_run_data', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_data_files', 'create', '{}', '{}', '*'),
    ('session_data_files', 'read', '{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_data_files', 'update', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_data_files', 'delete', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('operation_additional_operators', 'create', '{}', '{}', '*'),
    ('operation_additional_operators', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('operation_additional_operators', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('operation_additional_operators', 'delete', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_additional_operators', 'create', '{}', '{}', '*'),
    ('session_additional_operators', 'read', '{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('session_additional_operators', 'update', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('session_additional_operators', 'delete', '{"_and":[{"session_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"session_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"session_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"session_id":{"restricted":{"_eq":false}}},{"_or":[{"session_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"session_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"session_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"session_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('test_sessions_subject', 'create', '{}', '{}', '*'),
    ('test_sessions_subject', 'read', '{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('test_sessions_subject', 'update', '{"_and":[{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"test_sessions_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"test_sessions_id":{"restricted":{"_eq":false}}},{"_or":[{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"test_sessions_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('test_sessions_subject', 'delete', '{"_and":[{"test_sessions_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"test_sessions_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"test_sessions_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"access":{"role":{"_in":["edit"]}}}}]},{"_and":[{"test_sessions_id":{"restricted":{"_eq":false}}},{"_or":[{"test_sessions_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"test_sessions_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"test_sessions_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"test_sessions_id":{"sample_id":{"access":{"role":{"_in":["edit"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('project_investigators', 'create', '{}', '{}', '*'),
    ('project_investigators', 'read', '{"project_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('project_investigators', 'update', '{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('project_investigators', 'delete', '{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('sample_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('operation_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('test_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('campaign_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('project_access', 'read', '{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '{}', '*'),
    ('sample_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('operation_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('test_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('campaign_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('project_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('campaign_sample_readers', 'read', '{"user_id":{"_eq":"$CURRENT_USER"}}', '{}', '*'),
    ('operation_open_to_all', 'read', '{}', '{}', '*');

-- First keep the rows that are about to change, then change exactly those.
INSERT INTO d1_private.lab_member_access_rules_backup (id, permissions, validation)
SELECT p.id, p.permissions, p.validation
  FROM directus_permissions p
  JOIN _lm_access_rules g ON g.collection = p.collection AND g.action = p.action
 WHERE p.policy = '20000002-0000-0000-0000-000000000002'
   AND (p.permissions::jsonb IS DISTINCT FROM g.filter::jsonb
        OR p.validation::jsonb IS DISTINCT FROM g.validation::jsonb)
ON CONFLICT (id) DO NOTHING;

UPDATE directus_permissions p
   SET permissions = g.filter, validation = g.validation
  FROM _lm_access_rules g, d1_private.lab_member_access_rules_backup b
 WHERE b.id = p.id AND NOT b.inserted
   AND g.collection = p.collection AND g.action = p.action;

WITH added AS (
    INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy)
    SELECT g.collection, g.action, g.filter, g.validation, g.fields, '20000002-0000-0000-0000-000000000002'
      FROM _lm_access_rules g
     WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p
                        WHERE p.policy = '20000002-0000-0000-0000-000000000002'
                          AND p.collection = g.collection AND p.action = g.action)
    RETURNING id
)
INSERT INTO d1_private.lab_member_access_rules_backup (id, inserted)
SELECT id, TRUE FROM added;


-- migrate:down
SET LOCAL lock_timeout = '10s';

-- the Lab Member rows first (they walk the readers aliases), then the readers
DELETE FROM directus_permissions p
 USING d1_private.lab_member_access_rules_backup b
 WHERE b.id = p.id AND b.inserted;

UPDATE directus_permissions p
   SET permissions = b.permissions, validation = b.validation
  FROM d1_private.lab_member_access_rules_backup b
 WHERE b.id = p.id AND NOT b.inserted;

DROP TABLE IF EXISTS d1_private.lab_member_access_rules_backup;

DROP TRIGGER IF EXISTS physical_samples_readers_ins ON physical_samples;
DROP TRIGGER IF EXISTS physical_samples_readers_upd ON physical_samples;
DROP TRIGGER IF EXISTS physical_samples_readers_del ON physical_samples;
DROP TRIGGER IF EXISTS manufacturing_operations_readers_ins ON manufacturing_operations;
DROP TRIGGER IF EXISTS manufacturing_operations_readers_upd ON manufacturing_operations;
DROP TRIGGER IF EXISTS manufacturing_operations_readers_del ON manufacturing_operations;
DROP TRIGGER IF EXISTS test_sessions_readers_ins ON test_sessions;
DROP TRIGGER IF EXISTS test_sessions_readers_upd ON test_sessions;
DROP TRIGGER IF EXISTS test_sessions_readers_del ON test_sessions;
DROP TRIGGER IF EXISTS campaigns_readers_ins ON campaigns;
DROP TRIGGER IF EXISTS campaigns_readers_upd ON campaigns;
DROP TRIGGER IF EXISTS campaigns_readers_del ON campaigns;
DROP TRIGGER IF EXISTS projects_readers_ins ON projects;
DROP TRIGGER IF EXISTS projects_readers_upd ON projects;
DROP TRIGGER IF EXISTS projects_readers_del ON projects;
DROP TRIGGER IF EXISTS project_investigators_readers_ins ON project_investigators;
DROP TRIGGER IF EXISTS project_investigators_readers_upd ON project_investigators;
DROP TRIGGER IF EXISTS project_investigators_readers_del ON project_investigators;
DROP TRIGGER IF EXISTS project_access_readers_ins ON project_access;
DROP TRIGGER IF EXISTS project_access_readers_upd ON project_access;
DROP TRIGGER IF EXISTS project_access_readers_del ON project_access;
DROP TRIGGER IF EXISTS campaign_samples_readers_ins ON campaign_samples;
DROP TRIGGER IF EXISTS campaign_samples_readers_upd ON campaign_samples;
DROP TRIGGER IF EXISTS campaign_samples_readers_del ON campaign_samples;
DROP TRIGGER IF EXISTS sample_co_owners_readers_ins ON sample_co_owners;
DROP TRIGGER IF EXISTS sample_co_owners_readers_upd ON sample_co_owners;
DROP TRIGGER IF EXISTS sample_co_owners_readers_del ON sample_co_owners;
DROP TRIGGER IF EXISTS sample_access_readers_ins ON sample_access;
DROP TRIGGER IF EXISTS sample_access_readers_upd ON sample_access;
DROP TRIGGER IF EXISTS sample_access_readers_del ON sample_access;
DROP TRIGGER IF EXISTS operation_access_readers_ins ON operation_access;
DROP TRIGGER IF EXISTS operation_access_readers_upd ON operation_access;
DROP TRIGGER IF EXISTS operation_access_readers_del ON operation_access;
DROP TRIGGER IF EXISTS test_access_readers_ins ON test_access;
DROP TRIGGER IF EXISTS test_access_readers_upd ON test_access;
DROP TRIGGER IF EXISTS test_access_readers_del ON test_access;
DROP TRIGGER IF EXISTS campaign_access_readers_ins ON campaign_access;
DROP TRIGGER IF EXISTS campaign_access_readers_upd ON campaign_access;
DROP TRIGGER IF EXISTS campaign_access_readers_del ON campaign_access;
DROP TRIGGER IF EXISTS people_readers_upd ON people;
DROP TRIGGER IF EXISTS physical_samples_readers_trunc ON physical_samples;
DROP TRIGGER IF EXISTS manufacturing_operations_readers_trunc ON manufacturing_operations;
DROP TRIGGER IF EXISTS test_sessions_readers_trunc ON test_sessions;
DROP TRIGGER IF EXISTS campaigns_readers_trunc ON campaigns;
DROP TRIGGER IF EXISTS projects_readers_trunc ON projects;
DROP TRIGGER IF EXISTS sample_access_readers_trunc ON sample_access;
DROP TRIGGER IF EXISTS operation_access_readers_trunc ON operation_access;
DROP TRIGGER IF EXISTS test_access_readers_trunc ON test_access;
DROP TRIGGER IF EXISTS campaign_access_readers_trunc ON campaign_access;
DROP TRIGGER IF EXISTS project_access_readers_trunc ON project_access;
DROP TRIGGER IF EXISTS campaign_samples_readers_trunc ON campaign_samples;
DROP TRIGGER IF EXISTS sample_co_owners_readers_trunc ON sample_co_owners;
DROP TRIGGER IF EXISTS project_investigators_readers_trunc ON project_investigators;
DROP TRIGGER IF EXISTS people_readers_trunc ON people;
DROP TRIGGER IF EXISTS directus_users_readers_trunc ON directus_users;
DROP TRIGGER IF EXISTS physical_samples_readers_lock ON physical_samples;
DROP TRIGGER IF EXISTS manufacturing_operations_readers_lock ON manufacturing_operations;
DROP FUNCTION IF EXISTS d1_private.trg_readers_physical_samples_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_physical_samples_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_physical_samples_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_manufacturing_operations_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_manufacturing_operations_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_manufacturing_operations_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_test_sessions_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_test_sessions_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_test_sessions_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaigns_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaigns_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaigns_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_projects_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_projects_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_projects_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_project_investigators_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_project_investigators_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_project_investigators_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_project_access_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_project_access_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_project_access_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaign_samples_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaign_samples_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaign_samples_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_sample_co_owners_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_sample_co_owners_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_sample_co_owners_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_sample_access_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_sample_access_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_sample_access_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_operation_access_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_operation_access_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_operation_access_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_test_access_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_test_access_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_test_access_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaign_access_ins();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaign_access_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_campaign_access_del();
DROP FUNCTION IF EXISTS d1_private.trg_readers_people_upd();
DROP FUNCTION IF EXISTS d1_private.trg_readers_truncate();

-- the project rollup refresh as migration 118 left it (no readers lock)
CREATE OR REPLACE FUNCTION refresh_project_rollup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Fixed key; xact-scoped so it is released on COMMIT or ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtextextended('refresh_project_rollup', 0));
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id)
    SELECT row_id, project_id, kind, code, detail, campaign_id FROM v_project_rollup;
END;
$$;

DROP VIEW IF EXISTS d1_private.v_s_list;
DROP VIEW IF EXISTS d1_private.v_s_editor;
DROP VIEW IF EXISTS d1_private.v_c_list;
DROP VIEW IF EXISTS d1_private.v_p_list;
DROP VIEW IF EXISTS d1_private.v_p_invs;
DROP VIEW IF EXISTS d1_private.v_p_pi;
DROP VIEW IF EXISTS d1_private.v_login_person;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
              WHERE p.pronamespace = 'd1_private'::regnamespace
                AND p.proname = ANY (ARRAY[
                    'uniq', 'person_login', 'me', 'pi_of', 'p_listed', 'p_invs', 'gate_p', 'c_pi', 'c_listed', 'gate_c', 's_listed',
                    'gate_s', 's_editor', 's_shielded', 'gate_s_star', 's_read', 'rec_gates', 'rec_read', 'can_read_sample',
                    'can_read_operation', 'can_read_test', 'can_read_campaign', 'can_read_project', 'can_read_campaign_sample',
                    'campaign_hidden', 'sample_hidden', 'project_logins', 'sample_candidates', 'campaign_candidates',
                    'operation_candidates', 'test_candidates', 'project_candidates', 'readers_of_sample', 'readers_of_operation',
                    'readers_of_test', 'readers_of_campaign', 'readers_of_project', 'readers_of_campaign_sample', 'operation_open_of',
                    'readers_of_sample_spec', 'readers_of_operation_spec', 'readers_of_test_spec', 'readers_of_campaign_spec', 'readers_of_campaign_sample_spec', 'readers_of_project_spec',
                    'hidden_of', 'is_hidden', 'readers_closure', 'sync_readers', 'refresh_readers', 'readers_rebuild',
                    'trg_readers_lock', 'readers_drift', 'readers_drift_count'])
    LOOP
        EXECUTE 'DROP FUNCTION ' || r.sig;
    END LOOP;
END
$$;

DELETE FROM directus_fields
 WHERE (collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'campaign_samples') AND field = 'readers')
    OR (collection = 'manufacturing_operations' AND field = 'open_to_all')
    OR collection IN ('sample_readers', 'operation_readers', 'test_readers', 'campaign_readers', 'project_readers', 'campaign_sample_readers', 'operation_open_to_all');

DELETE FROM directus_relations
 WHERE many_collection IN ('sample_readers', 'operation_readers', 'test_readers', 'campaign_readers', 'project_readers', 'campaign_sample_readers', 'operation_open_to_all');

DELETE FROM directus_collections
 WHERE collection IN ('sample_readers', 'operation_readers', 'test_readers', 'campaign_readers', 'project_readers', 'campaign_sample_readers', 'operation_open_to_all');

DROP TABLE IF EXISTS campaign_sample_readers;
DROP TABLE IF EXISTS operation_open_to_all;
DROP TABLE IF EXISTS project_readers;
DROP TABLE IF EXISTS campaign_readers;
DROP TABLE IF EXISTS test_readers;
DROP TABLE IF EXISTS operation_readers;
DROP TABLE IF EXISTS sample_readers;
DROP TABLE IF EXISTS d1_private.hidden_records;

ALTER TABLE sample_co_owners DROP CONSTRAINT IF EXISTS sample_co_owners_user_id_fkey;
ALTER TABLE project_investigators DROP CONSTRAINT IF EXISTS project_investigators_user_id_fkey;
