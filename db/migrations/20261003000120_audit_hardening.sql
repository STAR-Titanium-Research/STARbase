-- migrate:up
-- Review finding 5.7: harden the audit trail.
--
-- 1. audit_trigger_function() is SECURITY DEFINER but had no pinned search_path and wrote to an
--    unqualified audit_logs. A role that can create objects in a schema ahead of public on its
--    search_path could shadow audit_logs (or a function the body calls) and have the definer
--    run its code. The function now carries SET search_path = pg_catalog, public and every
--    reference is schema-qualified. The body is otherwise the one from 20260628000047_campaigns.sql
--    (record_id resolution is reworked in the next migration).
-- 2. audit_logs is append-only through the DO INSTEAD NOTHING rules on UPDATE and DELETE, but
--    rules do not fire for TRUNCATE, so any role holding TRUNCATE could wipe the log. TRUNCATE is
--    revoked from every role except the table owner, and a BEFORE TRUNCATE trigger now raises for
--    the owner too. (The owner can still DROP the trigger; that is a schema change and goes through
--    a migration, which is the audit trail's own boundary.)
--
-- Note for CI and operators: anything that purges data with TRUNCATE ... CASCADE must skip
-- audit_logs; tables are removed by the rollback's DROP TABLE, which is not blocked.

CREATE OR REPLACE FUNCTION audit_trigger_function()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row_before    JSONB;
    v_row_after     JSONB;
    v_record_id     TEXT;
    v_changed       JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_row_before := pg_catalog.to_jsonb(OLD);
        v_row_after  := NULL;
        v_record_id  := COALESCE(
            v_row_before ->> 'sample_id',
            v_row_before ->> 'operation_id',
            v_row_before ->> 'session_id',
            v_row_before ->> 'campaign_id',
            v_row_before ->> 'lot_id',
            v_row_before ->> 'material_id',
            v_row_before ->> 'project_id',
            v_row_before ->> 'tool_box_id',
            v_row_before ->> 'insert_id',
            v_row_before ->> 'edge_id',
            v_row_before ->> 'equipment_id',
            v_row_before ->> 'tool_id',
            v_row_before ->> 'insert_type_id',
            v_row_before ->> 'method_id',
            v_row_before ->> 'parameter_id',
            v_row_before ->> 'symbol',
            v_row_before ->> 'iso_code',
            'unknown'
        );
        v_changed := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_row_before := NULL;
        v_row_after  := pg_catalog.to_jsonb(NEW);
        v_record_id  := COALESCE(
            v_row_after ->> 'sample_id',
            v_row_after ->> 'operation_id',
            v_row_after ->> 'session_id',
            v_row_after ->> 'campaign_id',
            v_row_after ->> 'lot_id',
            v_row_after ->> 'material_id',
            v_row_after ->> 'project_id',
            v_row_after ->> 'tool_box_id',
            v_row_after ->> 'insert_id',
            v_row_after ->> 'edge_id',
            v_row_after ->> 'equipment_id',
            v_row_after ->> 'tool_id',
            v_row_after ->> 'insert_type_id',
            v_row_after ->> 'method_id',
            v_row_after ->> 'parameter_id',
            v_row_after ->> 'symbol',
            v_row_after ->> 'iso_code',
            'unknown'
        );
        v_changed := NULL;
    ELSE
        v_row_before := pg_catalog.to_jsonb(OLD);
        v_row_after  := pg_catalog.to_jsonb(NEW);
        v_record_id  := COALESCE(
            v_row_after ->> 'sample_id',
            v_row_after ->> 'operation_id',
            v_row_after ->> 'session_id',
            v_row_after ->> 'campaign_id',
            v_row_after ->> 'lot_id',
            v_row_after ->> 'material_id',
            v_row_after ->> 'project_id',
            v_row_after ->> 'tool_box_id',
            v_row_after ->> 'insert_id',
            v_row_after ->> 'edge_id',
            v_row_after ->> 'equipment_id',
            v_row_after ->> 'tool_id',
            v_row_after ->> 'insert_type_id',
            v_row_after ->> 'method_id',
            v_row_after ->> 'parameter_id',
            v_row_after ->> 'symbol',
            v_row_after ->> 'iso_code',
            'unknown'
        );
        SELECT pg_catalog.jsonb_object_agg(
            k,
            pg_catalog.jsonb_build_object('old', v_row_before -> k, 'new', v_row_after -> k)
        )
        INTO v_changed
        FROM pg_catalog.jsonb_each(v_row_after) AS t (k, v)
        WHERE (v_row_before -> k) IS DISTINCT FROM (v_row_after -> k);
    END IF;

    INSERT INTO public.audit_logs (
        table_name, record_id, action_type, actor_identity,
        row_before, row_after, changed_fields
    ) VALUES (
        TG_TABLE_NAME, v_record_id, TG_OP,
        pg_catalog.current_setting('d1.actor_identity', TRUE),
        v_row_before, v_row_after, v_changed
    );

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION audit_trigger_function() IS
    'Generic audit trigger: writes one audit_logs row per INSERT/UPDATE/DELETE with the before/after '
    'JSON and, for UPDATE, the changed fields. SECURITY DEFINER with a pinned search_path '
    '(pg_catalog, public) so a caller cannot shadow audit_logs or the functions it calls.';

-- audit_logs: no TRUNCATE for anyone but the owner, and a guard that stops the owner too.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT a.grantee
        FROM   pg_class c
        CROSS  JOIN LATERAL aclexplode(c.relacl) AS a
        WHERE  c.oid = 'public.audit_logs'::regclass
          AND  a.privilege_type = 'TRUNCATE'
          AND  a.grantee <> c.relowner
    LOOP
        IF r.grantee = 0 THEN
            EXECUTE 'REVOKE TRUNCATE ON audit_logs FROM PUBLIC';
        ELSE
            -- regrole's text output is already quoted where needed.
            EXECUTE 'REVOKE TRUNCATE ON audit_logs FROM ' || r.grantee::regrole::text;
        END IF;
    END LOOP;
END;
$$;

CREATE FUNCTION audit_logs_block_truncate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE is not allowed'
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION audit_logs_block_truncate() IS
    'Raises on TRUNCATE of audit_logs. The UPDATE/DELETE rules cannot catch TRUNCATE, so this '
    'statement-level trigger closes that gap (review 5.7).';

CREATE TRIGGER audit_logs_no_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_truncate();

COMMENT ON TRIGGER audit_logs_no_truncate ON audit_logs IS
    'Makes audit_logs append-only for TRUNCATE as well as UPDATE and DELETE (see the no_update/no_delete rules).';

-- migrate:down
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
DROP FUNCTION IF EXISTS audit_logs_block_truncate();
-- The TRUNCATE revocation is not undone: no role other than the owner held the privilege on the
-- reference schema, and re-granting it would re-open the hole. Re-grant by hand if a deployment
-- really relied on it.

-- Restore the function exactly as 20260628000047_campaigns.sql left it (no search_path, no comment).
CREATE OR REPLACE FUNCTION audit_trigger_function()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
AS $$
DECLARE
    v_row_before    JSONB;
    v_row_after     JSONB;
    v_record_id     TEXT;
    v_changed       JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_row_before := to_jsonb(OLD);
        v_row_after  := NULL;
        v_record_id  := COALESCE(
            v_row_before ->> 'sample_id',
            v_row_before ->> 'operation_id',
            v_row_before ->> 'session_id',
            v_row_before ->> 'campaign_id',
            v_row_before ->> 'lot_id',
            v_row_before ->> 'material_id',
            v_row_before ->> 'project_id',
            v_row_before ->> 'tool_box_id',
            v_row_before ->> 'insert_id',
            v_row_before ->> 'edge_id',
            v_row_before ->> 'equipment_id',
            v_row_before ->> 'tool_id',
            v_row_before ->> 'insert_type_id',
            v_row_before ->> 'method_id',
            v_row_before ->> 'parameter_id',
            v_row_before ->> 'symbol',
            v_row_before ->> 'iso_code',
            'unknown'
        );
        v_changed := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_row_before := NULL;
        v_row_after  := to_jsonb(NEW);
        v_record_id  := COALESCE(
            v_row_after ->> 'sample_id',
            v_row_after ->> 'operation_id',
            v_row_after ->> 'session_id',
            v_row_after ->> 'campaign_id',
            v_row_after ->> 'lot_id',
            v_row_after ->> 'material_id',
            v_row_after ->> 'project_id',
            v_row_after ->> 'tool_box_id',
            v_row_after ->> 'insert_id',
            v_row_after ->> 'edge_id',
            v_row_after ->> 'equipment_id',
            v_row_after ->> 'tool_id',
            v_row_after ->> 'insert_type_id',
            v_row_after ->> 'method_id',
            v_row_after ->> 'parameter_id',
            v_row_after ->> 'symbol',
            v_row_after ->> 'iso_code',
            'unknown'
        );
        v_changed := NULL;
    ELSE
        v_row_before := to_jsonb(OLD);
        v_row_after  := to_jsonb(NEW);
        v_record_id  := COALESCE(
            v_row_after ->> 'sample_id',
            v_row_after ->> 'operation_id',
            v_row_after ->> 'session_id',
            v_row_after ->> 'campaign_id',
            v_row_after ->> 'lot_id',
            v_row_after ->> 'material_id',
            v_row_after ->> 'project_id',
            v_row_after ->> 'tool_box_id',
            v_row_after ->> 'insert_id',
            v_row_after ->> 'edge_id',
            v_row_after ->> 'equipment_id',
            v_row_after ->> 'tool_id',
            v_row_after ->> 'insert_type_id',
            v_row_after ->> 'method_id',
            v_row_after ->> 'parameter_id',
            v_row_after ->> 'symbol',
            v_row_after ->> 'iso_code',
            'unknown'
        );
        SELECT jsonb_object_agg(
            k,
            jsonb_build_object('old', v_row_before -> k, 'new', v_row_after -> k)
        )
        INTO v_changed
        FROM jsonb_each(v_row_after) AS t (k, v)
        WHERE (v_row_before -> k) IS DISTINCT FROM (v_row_after -> k);
    END IF;

    INSERT INTO audit_logs (
        table_name, record_id, action_type, actor_identity,
        row_before, row_after, changed_fields
    ) VALUES (
        TG_TABLE_NAME, v_record_id, TG_OP,
        current_setting('d1.actor_identity', TRUE),
        v_row_before, v_row_after, v_changed
    );

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION audit_trigger_function() IS NULL;
