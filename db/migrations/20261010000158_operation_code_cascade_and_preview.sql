-- migrate:up
-- A corrected sample code reaches the codes of its operations; a preview of the operation code for
-- the form (stream T0b, spec 2026-10-10-record-codes-design.md §3).
--
-- Why: an operation code starts with the code of its input sample (TEST-S-F2-30MPM). Migration 157
-- keeps the code equal to the rule when the operation changes; when the sample's code is corrected
-- (a typo, a re-numbering) the operation is not touched, so its code goes stale. T0a already
-- carries a corrected sample code into the test codes (physical_samples_cascade_test_codes); this
-- does the same for the operation codes, next to it.
--
-- Lock order: the rollup advisory lock (key 'refresh_project_rollup', migration 118) comes first,
-- then the sample row. Renaming a sample updates operations, which refreshes the rollup, and an
-- operation insert takes the rollup lock and then its sample row (migration 157): a statement that
-- locked the sample row first and the rollup lock afterwards would deadlock with it. A
-- statement-level BEFORE UPDATE trigger on physical_samples takes the rollup lock before Postgres
-- locks any sample row of the statement (row-level BEFORE triggers run after the row is locked).
--
-- Trigger shape: no column list (UPDATE OF) and no WHEN clause: migration 116's down retypes code
-- columns, which Postgres refuses while a trigger names the column. The cascade checks for a
-- changed sample_code in its own body.

CREATE FUNCTION trg_physical_samples_rollup_lock()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Same key as refresh_project_rollup() (migration 118) and the operation trigger (157).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('refresh_project_rollup', 0));
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trg_physical_samples_rollup_lock() IS
    'BEFORE UPDATE (statement level) on physical_samples: takes the project_rollup advisory lock before Postgres locks any sample row, so a sample update and an operation write always lock rollup first, then the sample row (no deadlock). Statement level because row-level BEFORE triggers run after the row is locked. Spec 2026-10-10-record-codes §3.';

CREATE TRIGGER physical_samples_rollup_lock
    BEFORE UPDATE ON physical_samples
    FOR EACH STATEMENT EXECUTE FUNCTION trg_physical_samples_rollup_lock();

COMMENT ON TRIGGER physical_samples_rollup_lock ON physical_samples IS
    'Rollup advisory lock first, sample rows after (lock order, T0b). Statement level on purpose; no column list or WHEN (migration 116).';

CREATE FUNCTION trg_cascade_operation_codes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.sample_code IS NOT DISTINCT FROM OLD.sample_code THEN
        RETURN NULL;
    END IF;
    -- Only an operation whose code is the rule's value for the old sample code (an automatic one) is
    -- rewritten, and only when the new value differs. A typed code is not the rule's value and stays;
    -- experiment_sheet rows are frozen. In the operation trigger (157) the written code equals the
    -- rule's value for the new sample code, so the operation stays automatic.
    UPDATE public.manufacturing_operations m
    SET pass_code = public.operation_code_for(m, NEW.sample_code)
    WHERE m.sample_id = NEW.sample_id
      AND m.source_system IS DISTINCT FROM 'experiment_sheet'
      AND m.pass_code IS NOT DISTINCT FROM public.operation_code_for(m, OLD.sample_code)
      AND public.operation_code_for(m, NEW.sample_code) IS DISTINCT FROM m.pass_code;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trg_cascade_operation_codes() IS
    'AFTER UPDATE on physical_samples, acts only when sample_code changed: rewrites the codes of the sample''s automatic operations (pass_code equal to the rule''s value for the old sample code) with the new sample code, keeping their numbers. Typed codes and experiment_sheet rows are left alone. Spec 2026-10-10-record-codes §3.';

CREATE TRIGGER physical_samples_cascade_operation_codes
    AFTER UPDATE ON physical_samples
    FOR EACH ROW EXECUTE FUNCTION trg_cascade_operation_codes();

COMMENT ON TRIGGER physical_samples_cascade_operation_codes ON physical_samples IS
    'A corrected sample code flows into its operations'' automatic codes (next to physical_samples_cascade_test_codes). No UPDATE OF / WHEN (migration 116).';

CREATE FUNCTION preview_operation_code(p_values JSONB, p_operation_id UUID, p_sample_code TEXT)
    RETURNS TEXT
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_saved     public.manufacturing_operations;
    v_have      BOOLEAN := FALSE;
    v_vals      JSONB := coalesce(p_values, '{}'::jsonb);
    v_op        public.manufacturing_operations;
    v_category  TEXT;
BEGIN
    IF p_operation_id IS NOT NULL THEN
        SELECT * INTO v_saved FROM public.manufacturing_operations WHERE operation_id = p_operation_id;
        v_have := FOUND;
    END IF;

    -- The row as it would be saved: the saved one with the values written over it.
    IF v_have THEN
        v_op := jsonb_populate_record(NULL::public.manufacturing_operations, to_jsonb(v_saved) || v_vals);
    ELSE
        v_op := jsonb_populate_record(NULL::public.manufacturing_operations, v_vals);
    END IF;

    -- Category from the method, as the trigger mfg_op_derive_category does: a new operation without
    -- one, or an operation whose method changed in these values without a category being given.
    IF v_op.method_id IS NOT NULL
       AND (v_op.process_category IS NULL
            OR (v_vals ? 'method_id' AND NOT v_vals ? 'process_category'
                AND v_op.method_id IS DISTINCT FROM CASE WHEN v_have THEN v_saved.method_id END)) THEN
        SELECT mm.process_category INTO v_category
        FROM public.manufacturing_methods mm WHERE mm.method_id = v_op.method_id;
        IF v_category IS NOT NULL THEN
            v_op.process_category := v_category;
        END IF;
    END IF;

    -- The number, as the operation trigger (157) gives it: a new operation with a sample and no
    -- number, or an operation that moved to another sample or method without its number being set,
    -- takes max+1 over the sample's other operations (imported rows, source_system set, keep theirs).
    IF v_op.sample_id IS NOT NULL AND v_op.source_system IS NULL
       AND ((NOT v_have AND v_op.operation_sequence IS NULL)
            OR (v_have
                AND v_op.operation_sequence IS NOT DISTINCT FROM v_saved.operation_sequence
                AND (v_op.sample_id IS DISTINCT FROM v_saved.sample_id
                     OR v_op.method_id IS DISTINCT FROM v_saved.method_id))) THEN
        SELECT coalesce(max(mo.operation_sequence), 0) + 1 INTO v_op.operation_sequence
        FROM public.manufacturing_operations mo
        WHERE mo.sample_id = v_op.sample_id AND mo.operation_id IS DISTINCT FROM v_op.operation_id;
    END IF;

    RETURN public.operation_code_for(v_op, p_sample_code);
END;
$$;

COMMENT ON FUNCTION preview_operation_code(JSONB, UUID, TEXT) IS
    'The operation code the form would show: the saved operation (p_operation_id, if any) with p_values written over it, its category taken from the method when none is given and its number estimated as the trigger would, run through operation_code_for with p_sample_code. A preview only, no writes; the trigger decides on save (concurrent writers can take the number first). Spec 2026-10-10-record-codes §3.';

-- migrate:down
DROP TRIGGER IF EXISTS physical_samples_cascade_operation_codes ON physical_samples;
DROP TRIGGER IF EXISTS physical_samples_rollup_lock ON physical_samples;
DROP FUNCTION IF EXISTS preview_operation_code(JSONB, UUID, TEXT);
DROP FUNCTION IF EXISTS trg_cascade_operation_codes();
DROP FUNCTION IF EXISTS trg_physical_samples_rollup_lock();
