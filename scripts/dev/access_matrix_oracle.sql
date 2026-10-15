-- The independent oracle of the record access model: schema ref, a per-record, per-user evaluation of the whole visibility rule in plain
-- SQL, written from the spec's tables (docs/superpowers/specs/2026-10-12-record-access-design.md section 1), NOT from the production
-- functions d1_private.* of migration 166 (which are the same model, promoted and made fast: tests/readers_matrix.sh asserts they
-- agree with this file for every record and user). COPY ONLY: loaded into throwaway databases (the schema test, the smoke copy), never
-- into a real one. scripts/dev/access_matrix_fixture.sql adds the data and the expected-id queries on top of it.
--
-- u = a directus_users id. me(person): the person is u's. The two intended changes against the first attempt (spec section 1):
--   * the operation/test gate on the sample's campaigns is exact (ruling 19): gate_s_star replaces gate_s in rec_gates;
--   * the orphan amnesty is narrowed to runs open to everyone (amnesty_open).
-- Read-only operation model: op_read (full read = ordinary OR amnesty), op_read_ordinary (what operation_readers holds).
\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS ref;

CREATE OR REPLACE FUNCTION ref.id(label text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('smoke-access-' || label)::uuid $$;

-- Lab Viewer (migration 185): a login whose account role is Lab Viewer (10000001-0000-0000-0000-000000000003) and that is not suspended reads every record of
-- every type, Restricted included. Written here from that sentence, not from d1_private.v_viewers.
CREATE OR REPLACE FUNCTION ref.viewer(u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM directus_users x WHERE x.id = u AND x.role = '10000001-0000-0000-0000-000000000003' AND x.status <> 'suspended') $$;

CREATE OR REPLACE FUNCTION ref.me(person uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT person IS NOT NULL AND EXISTS (SELECT 1 FROM people WHERE person_id = person AND user_id = u) $$;

CREATE OR REPLACE FUNCTION ref.pi_of(project uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM projects x WHERE x.project_id = project AND ref.me(x.principal_investigator_person, u)) $$;

-- on the project's list: PI, an old investigator row, any access entry
CREATE OR REPLACE FUNCTION ref.p_listed(p uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.pi_of(p, u)
        OR EXISTS (SELECT 1 FROM project_investigators i WHERE i.project_id = p AND i.user_id = u)
        OR EXISTS (SELECT 1 FROM project_access a WHERE a.project_id = p AND ref.me(a.person_id, u)) $$;

-- an investigator: an old investigator row or an access entry with role investigator (not the PI)
CREATE OR REPLACE FUNCTION ref.p_invs(p uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM project_investigators i WHERE i.project_id = p AND i.user_id = u)
        OR EXISTS (SELECT 1 FROM project_access a WHERE a.project_id = p AND a.role = 'investigator' AND ref.me(a.person_id, u)) $$;

-- P: no project, an unrestricted project, or on its list
CREATE OR REPLACE FUNCTION ref.gate_p(p uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT p IS NULL OR EXISTS (SELECT 1 FROM projects x WHERE x.project_id = p AND (NOT x.restricted OR ref.p_listed(p, u))) $$;

CREATE OR REPLACE FUNCTION ref.c_pi(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c AND ref.pi_of(x.project_id, u)) $$;

CREATE OR REPLACE FUNCTION ref.c_listed(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c AND ref.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM campaign_access a WHERE a.campaign_id = c AND ref.me(a.person_id, u))
        OR ref.c_pi(c, u) $$;

-- C: no campaign, or (unrestricted or on its list) and its project lets the caller in. "A campaign lets u in".
CREATE OR REPLACE FUNCTION ref.gate_c(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT c IS NULL OR EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c
                                   AND (NOT x.restricted OR ref.c_listed(c, u)) AND ref.gate_p(x.project_id, u)) $$;

-- who acts as the owner of a campaign, operation or test: its person owner, or a manager of the team that owns it (the access level manage, People 3)
CREATE OR REPLACE FUNCTION ref.c_owner(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c AND ref.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM campaign_access a WHERE a.campaign_id = c AND a.role = 'manage' AND ref.me(a.person_id, u)) $$;
CREATE OR REPLACE FUNCTION ref.o_owner(o uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM manufacturing_operations x WHERE x.operation_id = o AND ref.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM operation_access a WHERE a.operation_id = o AND a.role = 'manage' AND ref.me(a.person_id, u)) $$;
CREATE OR REPLACE FUNCTION ref.t_owner(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM test_sessions x WHERE x.session_id = t AND ref.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM test_access a WHERE a.session_id = t AND a.role = 'manage' AND ref.me(a.person_id, u)) $$;

-- on a sample's list: owner, co-owner, access entry, PI of its project, PI of a campaign's project
CREATE OR REPLACE FUNCTION ref.s_listed(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM physical_samples x WHERE x.sample_id = s
                      AND (ref.me(x.owner_person_id, u) OR ref.pi_of(x.project_id, u)))
        OR EXISTS (SELECT 1 FROM sample_co_owners o WHERE o.sample_id = s AND o.user_id = u)
        OR EXISTS (SELECT 1 FROM sample_access a WHERE a.sample_id = s AND ref.me(a.person_id, u))
        OR EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s AND ref.c_pi(cs.campaign_id, u)) $$;

CREATE OR REPLACE FUNCTION ref.gate_s(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT s IS NULL OR EXISTS (SELECT 1 FROM physical_samples x WHERE x.sample_id = s AND (NOT x.restricted OR ref.s_listed(s, u))) $$;

-- the owner of a sample: its owner, or a manager of the team that owns it (the access level manage is held only by such a manager, People 3)
CREATE OR REPLACE FUNCTION ref.s_owner(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM physical_samples x WHERE x.sample_id = s AND ref.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM sample_access a WHERE a.sample_id = s AND a.role = 'manage' AND ref.me(a.person_id, u)) $$;

-- an editor of a sample: the owner, a co-owner, an access entry with role edit or manage (manage = a manager of the owning team, People 3)
CREATE OR REPLACE FUNCTION ref.s_editor(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM physical_samples x WHERE x.sample_id = s AND ref.me(x.owner_person_id, u))
        OR EXISTS (SELECT 1 FROM sample_co_owners o WHERE o.sample_id = s AND o.user_id = u)
        OR EXISTS (SELECT 1 FROM sample_access a WHERE a.sample_id = s AND a.role IN ('edit', 'manage') AND ref.me(a.person_id, u)) $$;

-- the sample is campaign-shielded from u: it belongs to at least one campaign and no campaign of it lets u in
CREATE OR REPLACE FUNCTION ref.s_shielded(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s)
       AND NOT EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s AND ref.gate_c(cs.campaign_id, u)) $$;

-- S* (ruling 19): no sample; or the sample is unrestricted or lists u, and (u is on the sample's list, or investigates the sample's
-- own project, or the sample is not campaign-shielded from u)
CREATE OR REPLACE FUNCTION ref.gate_s_star(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT s IS NULL OR (ref.gate_s(s, u)
                         AND (ref.s_listed(s, u)
                              OR EXISTS (SELECT 1 FROM physical_samples x WHERE x.sample_id = s AND ref.p_invs(x.project_id, u))
                              OR NOT ref.s_shielded(s, u))) $$;

CREATE OR REPLACE FUNCTION ref.s_read(s uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM physical_samples x WHERE x.sample_id = s AND (
            ref.viewer(u)
            OR ref.s_listed(s, u)
            OR (NOT x.restricted AND (
                ref.p_invs(x.project_id, u)
                OR EXISTS (SELECT 1 FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
                            WHERE cs.sample_id = s
                              AND ((ref.c_owner(c.campaign_id, u) AND ref.gate_p(c.project_id, u))
                                   OR (NOT c.restricted AND ref.p_invs(c.project_id, u)))))))) $$;

-- operations and tests: gates (S*, P of the sample's project, P, C), then the record's own rule
CREATE OR REPLACE FUNCTION ref.rec_gates(sample uuid, project uuid, campaign uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.gate_s_star(sample, u)
       AND (sample IS NULL OR ref.gate_p((SELECT x.project_id FROM physical_samples x WHERE x.sample_id = sample), u))
       AND ref.gate_p(project, u)
       AND ref.gate_c(campaign, u) $$;

-- the ordinary read (no amnesty)
CREATE OR REPLACE FUNCTION ref.rec_read(restricted boolean, owner uuid, project uuid, campaign uuid, sample uuid, acc_any boolean, u uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_gates(sample, project, campaign, u) AND (
                ref.me(owner, u) OR acc_any OR ref.pi_of(project, u) OR ref.c_pi(campaign, u)
                OR (NOT restricted AND (
                    ref.s_read(sample, u) OR ref.p_invs(project, u)
                    OR EXISTS (SELECT 1 FROM campaigns c WHERE c.campaign_id = campaign
                                  AND (ref.c_owner(c.campaign_id, u) OR ref.p_invs(c.project_id, u)))))) $$;

-- the narrowed orphan amnesty: an operation with no owner, project or campaign, not restricted, and either no sample or a sample that is
-- unrestricted with an open project (none or unrestricted) and either in no campaign or in at least one campaign open to everyone
-- (unrestricted, open project). Open to everyone: no user argument.
DROP FUNCTION IF EXISTS ref.amnesty_open(uuid, uuid, uuid, boolean, uuid);
-- owner_team: the owning team (People 3); a team-owned operation has an owner, so it is not an orphan
CREATE OR REPLACE FUNCTION ref.amnesty_open(owner uuid, owner_team uuid, project uuid, campaign uuid, restricted boolean, sample uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT owner IS NULL AND owner_team IS NULL AND project IS NULL AND campaign IS NULL AND NOT restricted
       AND (sample IS NULL OR EXISTS (
            SELECT 1 FROM physical_samples s
             WHERE s.sample_id = sample AND NOT s.restricted
               AND (s.project_id IS NULL OR NOT (SELECT p.restricted FROM projects p WHERE p.project_id = s.project_id))
               AND (NOT EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s.sample_id)
                    OR EXISTS (SELECT 1 FROM campaign_samples cs JOIN campaigns c ON c.campaign_id = cs.campaign_id
                                WHERE cs.sample_id = s.sample_id AND NOT c.restricted
                                  AND (c.project_id IS NULL OR NOT (SELECT p.restricted FROM projects p WHERE p.project_id = c.project_id)))))) $$;

CREATE OR REPLACE FUNCTION ref.rec_update(restricted boolean, owner uuid, project uuid, campaign uuid, sample uuid, acc_edit boolean, u uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_gates(sample, project, campaign, u)
       AND (ref.me(owner, u) OR acc_edit OR (NOT restricted AND sample IS NOT NULL AND ref.s_editor(sample, u))) $$;

DROP FUNCTION IF EXISTS ref.rec_delete(uuid, uuid, uuid, uuid, uuid);
-- is_owner: u is the record's person owner or holds a manage row (a manager of the team that owns it)
CREATE OR REPLACE FUNCTION ref.rec_delete(is_owner boolean, project uuid, campaign uuid, sample uuid, u uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_gates(sample, project, campaign, u) AND is_owner $$;

-- an operation: the ordinary read, the amnesty (everyone), the full read (their OR)
CREATE OR REPLACE FUNCTION ref.op_read_ordinary(o uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.viewer(u) OR ref.rec_read(x.restricted, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id,
                        EXISTS (SELECT 1 FROM operation_access a WHERE a.operation_id = x.operation_id AND ref.me(a.person_id, u)), u)
      FROM manufacturing_operations x WHERE x.operation_id = o $$;
CREATE OR REPLACE FUNCTION ref.op_open(o uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.amnesty_open(x.owner_person_id, x.owner_team_id, x.project_id, x.campaign_id, x.restricted, x.sample_id)
      FROM manufacturing_operations x WHERE x.operation_id = o $$;
CREATE OR REPLACE FUNCTION ref.op_read(o uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT coalesce(ref.op_read_ordinary(o, u), false) OR coalesce(ref.op_open(o), false) $$;
CREATE OR REPLACE FUNCTION ref.op_update(o uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_update(x.restricted, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id,
                          EXISTS (SELECT 1 FROM operation_access a WHERE a.operation_id = x.operation_id AND a.role IN ('edit', 'manage') AND ref.me(a.person_id, u)), u)
      FROM manufacturing_operations x WHERE x.operation_id = o $$;
CREATE OR REPLACE FUNCTION ref.op_delete(o uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_delete(ref.o_owner(x.operation_id, u),
                          x.project_id, x.campaign_id, x.sample_id, u)
      FROM manufacturing_operations x WHERE x.operation_id = o $$;

CREATE OR REPLACE FUNCTION ref.test_read(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.viewer(u) OR ref.rec_read(x.restricted, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id,
                        EXISTS (SELECT 1 FROM test_access a WHERE a.session_id = x.session_id AND ref.me(a.person_id, u)), u)
      FROM test_sessions x WHERE x.session_id = t $$;
CREATE OR REPLACE FUNCTION ref.test_update(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_update(x.restricted, x.owner_person_id, x.project_id, x.campaign_id, x.sample_id,
                          EXISTS (SELECT 1 FROM test_access a WHERE a.session_id = x.session_id AND a.role IN ('edit', 'manage') AND ref.me(a.person_id, u)), u)
      FROM test_sessions x WHERE x.session_id = t $$;
CREATE OR REPLACE FUNCTION ref.test_delete(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT ref.rec_delete(ref.t_owner(x.session_id, u),
                          x.project_id, x.campaign_id, x.sample_id, u)
      FROM test_sessions x WHERE x.session_id = t $$;

CREATE OR REPLACE FUNCTION ref.c_read(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM campaigns x WHERE x.campaign_id = c AND (ref.viewer(u) OR ref.gate_p(x.project_id, u) AND (
            ref.c_listed(c, u)
            OR (NOT x.restricted AND (
                ref.p_invs(x.project_id, u)
                OR EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.campaign_id = c AND ref.s_editor(cs.sample_id, u))))))) $$;
CREATE OR REPLACE FUNCTION ref.c_update(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c AND ref.gate_p(x.project_id, u)
                      AND (ref.me(x.owner_person_id, u)
                           OR EXISTS (SELECT 1 FROM campaign_access a WHERE a.campaign_id = c AND a.role IN ('edit', 'manage') AND ref.me(a.person_id, u)))) $$;
CREATE OR REPLACE FUNCTION ref.c_delete(c uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c AND ref.gate_p(x.project_id, u)
                      AND ref.c_owner(c, u)) $$;

CREATE OR REPLACE FUNCTION ref.pj_read(p uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM projects x WHERE x.project_id = p AND (
            ref.viewer(u)
            OR ref.p_listed(p, u)
            OR (NOT x.restricted AND (
                EXISTS (SELECT 1 FROM campaigns c WHERE c.project_id = p AND ref.c_owner(c.campaign_id, u) AND ref.c_read(c.campaign_id, u))
                OR EXISTS (SELECT 1 FROM physical_samples s WHERE s.project_id = p AND ref.s_editor(s.sample_id, u) AND ref.s_read(s.sample_id, u))
                OR EXISTS (SELECT 1 FROM manufacturing_operations o WHERE o.project_id = p AND ref.o_owner(o.operation_id, u) AND ref.op_read(o.operation_id, u))
                OR EXISTS (SELECT 1 FROM test_sessions t WHERE t.project_id = p AND ref.t_owner(t.session_id, u) AND ref.test_read(t.session_id, u)))))) $$;

-- a campaign_samples row, from the rule as the first attempt wrote it (sample gate AND (campaign read OR sample read)), which the readers
-- design shows equal to "readers of the sample, or, for an unrestricted sample, readers of the campaign"
CREATE OR REPLACE FUNCTION ref.cs_read(j uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT ref.viewer(u) OR (ref.gate_s(cs.sample_id, u) AND (ref.c_read(cs.campaign_id, u) OR ref.s_read(cs.sample_id, u)))
                       FROM campaign_samples cs WHERE cs.id = j), false) $$;

-- hidden from the Ask-the-database role (spec section 7), from the flags: restricted, or its project restricted; a campaign also when
-- its project is; a sample when any campaign it belongs to is hidden; an operation or test when its sample, project or campaign is
CREATE OR REPLACE FUNCTION ref.campaign_hidden(c uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM campaigns x WHERE x.campaign_id = c
                      AND (x.restricted OR EXISTS (SELECT 1 FROM projects p WHERE p.project_id = x.project_id AND p.restricted))) $$;
CREATE OR REPLACE FUNCTION ref.sample_hidden(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM physical_samples x WHERE x.sample_id = s
                      AND (x.restricted OR EXISTS (SELECT 1 FROM projects p WHERE p.project_id = x.project_id AND p.restricted)))
        OR EXISTS (SELECT 1 FROM campaign_samples cs WHERE cs.sample_id = s AND ref.campaign_hidden(cs.campaign_id)) $$;
CREATE OR REPLACE FUNCTION ref.hidden(kind text, id uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN CASE kind
        WHEN 'projects' THEN EXISTS (SELECT 1 FROM projects x WHERE x.project_id = id AND x.restricted)
        WHEN 'campaigns' THEN ref.campaign_hidden(id)
        WHEN 'physical_samples' THEN ref.sample_hidden(id)
        WHEN 'manufacturing_operations' THEN EXISTS (SELECT 1 FROM manufacturing_operations x
                WHERE x.operation_id = id AND (x.restricted OR EXISTS (SELECT 1 FROM projects p WHERE p.project_id = x.project_id AND p.restricted)
                                               OR (x.sample_id IS NOT NULL AND ref.sample_hidden(x.sample_id))
                                               OR (x.campaign_id IS NOT NULL AND ref.campaign_hidden(x.campaign_id))))
        WHEN 'test_sessions' THEN EXISTS (SELECT 1 FROM test_sessions x
                WHERE x.session_id = id AND (x.restricted OR EXISTS (SELECT 1 FROM projects p WHERE p.project_id = x.project_id AND p.restricted)
                                             OR (x.sample_id IS NOT NULL AND ref.sample_hidden(x.sample_id))
                                             OR (x.campaign_id IS NOT NULL AND ref.campaign_hidden(x.campaign_id))))
    END;
END $$;
