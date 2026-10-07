-- migrate:up
-- Review finding 5.3: audit coverage and record_id.
--
-- ADR-0003 says every mutation of a business table is audited, but only 9 of the ~60 public
-- tables carried an audit_* trigger. The gaps included tables Lab Members can edit freely
-- (people, materials, the reference tables), the genealogy / provenance / co-owner link tables,
-- and machining_force_analysis. Deleting a person nulls owners through ON DELETE SET NULL and
-- deleting a sample cascades into genealogy and force-analysis rows, none of it traceable.
--
-- 1. audit_trigger_function() no longer guesses record_id from a fixed list of ~17 column names
--    (which mis-reported e.g. an operation as its sample_id, an edge as its insert_id, and logged
--    'unknown' for most other tables). record_id is now the row's real primary key, read from
--    pg_index (composite keys are joined with ':'). 'unknown' is only possible for a table with
--    no primary key, and a schema test asserts every audited table has one.
--    Existing audit rows are append-only and keep the old record_id; new rows use the PK.
-- 2. Trigger arguments name columns to leave out of the row_before / row_after / changed_fields
--    snapshots. machining_force_analysis stores large worker-written envelopes (series, fft,
--    diag_metrics); the worker rewrites the row on every status change, so snapshotting them would
--    copy hundreds of KB into audit_logs per update. Those three columns are omitted; every other
--    column, and the fact that the row changed, is still logged.
-- 3. audit_<table> (AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW) is attached to every business
--    table that lacked it. Left out on purpose:
--      audit_logs            the log itself
--      schema_migrations     dbmate bookkeeping
--      directus_*            Directus system tables (Directus keeps its own activity log)
--      project_rollup        derived cache, rebuilt by trigger from v_project_rollup (051)
--      semantic_embeddings   derived pgvector store, rebuildable from source rows (migration 058)
--      force_crawler_state   singleton control/heartbeat row the crawler daemon rewrites every few
--                            seconds; operational state, not lab data
--
-- Keep the 20261003000120 hardening: SECURITY DEFINER, pinned search_path, qualified names.

CREATE OR REPLACE FUNCTION audit_trigger_function()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_omit          TEXT[] := CASE WHEN TG_NARGS > 0 THEN TG_ARGV ELSE ARRAY[]::TEXT[] END;
    v_src           JSONB;
    v_row_before    JSONB;
    v_row_after     JSONB;
    v_record_id     TEXT;
    v_changed       JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_src := pg_catalog.to_jsonb(OLD);
    ELSE
        v_src := pg_catalog.to_jsonb(NEW);
    END IF;

    -- The row's own primary key (composite keys in key order, joined with ':').
    SELECT pg_catalog.string_agg(v_src ->> a.attname::TEXT, ':' ORDER BY k.ord)
    INTO   v_record_id
    FROM   pg_catalog.pg_index AS i
    CROSS  JOIN LATERAL pg_catalog.unnest(i.indkey::SMALLINT[]) WITH ORDINALITY AS k (attnum, ord)
    JOIN   pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE  i.indrelid = TG_RELID
      AND  i.indisprimary;
    v_record_id := COALESCE(v_record_id, 'unknown');  -- only a table without a primary key

    IF TG_OP = 'DELETE' THEN
        v_row_before := v_src - v_omit;
        v_row_after  := NULL;
        v_changed    := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_row_before := NULL;
        v_row_after  := v_src - v_omit;
        v_changed    := NULL;
    ELSE
        v_row_before := pg_catalog.to_jsonb(OLD) - v_omit;
        v_row_after  := v_src - v_omit;
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
    'Generic audit trigger: one audit_logs row per INSERT/UPDATE/DELETE with record_id = the row''s '
    'primary key (composite keys joined with '':''), before/after JSON and, for UPDATE, the changed '
    'fields. Trigger arguments name columns to omit from the snapshots (large derived payloads). '
    'SECURITY DEFINER with a pinned search_path (pg_catalog, public).';

-- One audit trigger per table. Trigger name: audit_<lower-case table name>.

CREATE TRIGGER audit_machine_operators
    AFTER INSERT OR UPDATE OR DELETE ON "Machine_Operators"
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_alloying_elements
    AFTER INSERT OR UPDATE OR DELETE ON alloying_elements
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_archive_metadata_edits
    AFTER INSERT OR UPDATE OR DELETE ON archive_metadata_edits
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_campaign_samples
    AFTER INSERT OR UPDATE OR DELETE ON campaign_samples
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_diag_layer
    AFTER INSERT OR UPDATE OR DELETE ON diag_layer
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_diag_recipes
    AFTER INSERT OR UPDATE OR DELETE ON diag_recipes
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_equipment
    AFTER INSERT OR UPDATE OR DELETE ON equipment
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_etchants
    AFTER INSERT OR UPDATE OR DELETE ON etchants
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_facilities
    AFTER INSERT OR UPDATE OR DELETE ON facilities
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_fast_recipes
    AFTER INSERT OR UPDATE OR DELETE ON fast_recipes
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_fast_run_data
    AFTER INSERT OR UPDATE OR DELETE ON fast_run_data
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_filter_profiles
    AFTER INSERT OR UPDATE OR DELETE ON filter_profiles
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_insert_types
    AFTER INSERT OR UPDATE OR DELETE ON insert_types
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_machining_force_analysis
    AFTER INSERT OR UPDATE OR DELETE ON machining_force_analysis
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function('series', 'fft', 'diag_metrics');

CREATE TRIGGER audit_manufacturers
    AFTER INSERT OR UPDATE OR DELETE ON manufacturers
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_manufacturing_methods
    AFTER INSERT OR UPDATE OR DELETE ON manufacturing_methods
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_material_alloying_elements
    AFTER INSERT OR UPDATE OR DELETE ON material_alloying_elements
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_material_iso_classifications
    AFTER INSERT OR UPDATE OR DELETE ON material_iso_classifications
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_materials
    AFTER INSERT OR UPDATE OR DELETE ON materials
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_operation_data_files
    AFTER INSERT OR UPDATE OR DELETE ON operation_data_files
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_operation_files
    AFTER INSERT OR UPDATE OR DELETE ON operation_files
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_people
    AFTER INSERT OR UPDATE OR DELETE ON people
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_prep_recipe_steps
    AFTER INSERT OR UPDATE OR DELETE ON prep_recipe_steps
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_prep_recipes
    AFTER INSERT OR UPDATE OR DELETE ON prep_recipes
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_prep_steps
    AFTER INSERT OR UPDATE OR DELETE ON prep_steps
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_project_investigators
    AFTER INSERT OR UPDATE OR DELETE ON project_investigators
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_sample_co_owners
    AFTER INSERT OR UPDATE OR DELETE ON sample_co_owners
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_sample_data_files
    AFTER INSERT OR UPDATE OR DELETE ON sample_data_files
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_sample_genealogy
    AFTER INSERT OR UPDATE OR DELETE ON sample_genealogy
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_sample_stock_provenance
    AFTER INSERT OR UPDATE OR DELETE ON sample_stock_provenance
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_session_data_files
    AFTER INSERT OR UPDATE OR DELETE ON session_data_files
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_test_sessions_subject
    AFTER INSERT OR UPDATE OR DELETE ON test_sessions_subject
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_tool_setup
    AFTER INSERT OR UPDATE OR DELETE ON tool_setup
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_tools
    AFTER INSERT OR UPDATE OR DELETE ON tools
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- Comment every new trigger.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'Machine_Operators',
        'alloying_elements',
        'archive_metadata_edits',
        'campaign_samples',
        'diag_layer',
        'diag_recipes',
        'equipment',
        'etchants',
        'facilities',
        'fast_recipes',
        'fast_run_data',
        'filter_profiles',
        'insert_types',
        'machining_force_analysis',
        'manufacturers',
        'manufacturing_methods',
        'material_alloying_elements',
        'material_iso_classifications',
        'materials',
        'operation_data_files',
        'operation_files',
        'people',
        'prep_recipe_steps',
        'prep_recipes',
        'prep_steps',
        'project_investigators',
        'sample_co_owners',
        'sample_data_files',
        'sample_genealogy',
        'sample_stock_provenance',
        'session_data_files',
        'test_sessions_subject',
        'tool_setup',
        'tools'
    ] LOOP
        EXECUTE format(
            'COMMENT ON TRIGGER %I ON %I IS %L',
            'audit_' || lower(t), t,
            'Immutable audit trail (ADR-0003): one audit_logs row per INSERT, UPDATE or DELETE, keyed by the primary key.');
    END LOOP;
END;
$$;

-- migrate:down
DROP TRIGGER IF EXISTS audit_tools ON tools;
DROP TRIGGER IF EXISTS audit_tool_setup ON tool_setup;
DROP TRIGGER IF EXISTS audit_test_sessions_subject ON test_sessions_subject;
DROP TRIGGER IF EXISTS audit_session_data_files ON session_data_files;
DROP TRIGGER IF EXISTS audit_sample_stock_provenance ON sample_stock_provenance;
DROP TRIGGER IF EXISTS audit_sample_genealogy ON sample_genealogy;
DROP TRIGGER IF EXISTS audit_sample_data_files ON sample_data_files;
DROP TRIGGER IF EXISTS audit_sample_co_owners ON sample_co_owners;
DROP TRIGGER IF EXISTS audit_project_investigators ON project_investigators;
DROP TRIGGER IF EXISTS audit_prep_steps ON prep_steps;
DROP TRIGGER IF EXISTS audit_prep_recipes ON prep_recipes;
DROP TRIGGER IF EXISTS audit_prep_recipe_steps ON prep_recipe_steps;
DROP TRIGGER IF EXISTS audit_people ON people;
DROP TRIGGER IF EXISTS audit_operation_files ON operation_files;
DROP TRIGGER IF EXISTS audit_operation_data_files ON operation_data_files;
DROP TRIGGER IF EXISTS audit_materials ON materials;
DROP TRIGGER IF EXISTS audit_material_iso_classifications ON material_iso_classifications;
DROP TRIGGER IF EXISTS audit_material_alloying_elements ON material_alloying_elements;
DROP TRIGGER IF EXISTS audit_manufacturing_methods ON manufacturing_methods;
DROP TRIGGER IF EXISTS audit_manufacturers ON manufacturers;
DROP TRIGGER IF EXISTS audit_machining_force_analysis ON machining_force_analysis;
DROP TRIGGER IF EXISTS audit_insert_types ON insert_types;
DROP TRIGGER IF EXISTS audit_filter_profiles ON filter_profiles;
DROP TRIGGER IF EXISTS audit_fast_run_data ON fast_run_data;
DROP TRIGGER IF EXISTS audit_fast_recipes ON fast_recipes;
DROP TRIGGER IF EXISTS audit_facilities ON facilities;
DROP TRIGGER IF EXISTS audit_etchants ON etchants;
DROP TRIGGER IF EXISTS audit_equipment ON equipment;
DROP TRIGGER IF EXISTS audit_diag_recipes ON diag_recipes;
DROP TRIGGER IF EXISTS audit_diag_layer ON diag_layer;
DROP TRIGGER IF EXISTS audit_campaign_samples ON campaign_samples;
DROP TRIGGER IF EXISTS audit_archive_metadata_edits ON archive_metadata_edits;
DROP TRIGGER IF EXISTS audit_alloying_elements ON alloying_elements;
DROP TRIGGER IF EXISTS audit_machine_operators ON "Machine_Operators";

-- Restore the function as 20261003000120_audit_hardening.sql left it (legacy record_id
-- guessing, hardened search_path). Audit rows written meanwhile keep their record_id.
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
