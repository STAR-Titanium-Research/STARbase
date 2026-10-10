-- migrate:up
-- The operation code rule in Postgres (stream T0b, spec 2026-10-10-record-codes-design.md §3).
--
-- Why: the code was composed in the browser (d1-operation-code) and in a second copy in
-- packages/force-plotting, only for new operations, and saved codes went stale when their fields
-- changed. One rule, here, used by the trigger (next migration), the sample-code cascade, the
-- form's live preview and later the Force App. A faithful port of OperationCode.vue's autoCode
-- with three deliberate changes: (1) sintering = DD-MM-YY-MF{machine}-{run}[-params], machine
-- from the equipment (FCT HP D <n>) or source_system fast_<n>, run = sintering_run_number (typed
-- from the FAST machine or imported, never invented: Q48) — the old rule treated the number after
-- MF as a running counter, but in every imported FAST code it is the machine; (2) the date is
-- UTC, which is what all 10,048 imported FAST codes use; (3) no {seq}/{mf} placeholders.

CREATE FUNCTION code_num(p NUMERIC)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT CASE
        WHEN p IS NULL THEN NULL
        WHEN p = 0 THEN '0'
        ELSE trim_scale(round(p, 5 - floor(log(abs(p)))::int))::text
    END;
$$;

COMMENT ON FUNCTION code_num(NUMERIC) IS
    'A number as operation codes write it: 6 significant digits, no trailing zeros (80 -> 80, 0.05 -> 0.05, 1932.080 -> 1932.08).';

ALTER TABLE manufacturing_operations ADD COLUMN sintering_run_number INTEGER CHECK (sintering_run_number > 0);

COMMENT ON COLUMN manufacturing_operations.sintering_run_number IS
    'FAST/SPS run number as the machine shows it (typed on a hand-logged operation, read from the machine file by the importer). Part of the sintering code; never invented. Unique per machine (equipment).';

-- runbackfill:start
-- FAST imports carry the run in source_run_uid ('fast25|4624'). Back-filled with the table's user
-- triggers off (10k rows: no version bumps, audit rows or rollup refreshes for a derived value).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'
               AND tgrelid = 'manufacturing_operations'::regclass) THEN
        RAISE EXCEPTION 'a user trigger on manufacturing_operations is not in its normal state';
    END IF;
END $$;
ALTER TABLE manufacturing_operations DISABLE TRIGGER USER;
UPDATE manufacturing_operations
SET sintering_run_number = split_part(source_run_uid, '|', 2)::int
WHERE source_system IN ('fast_25', 'fast_250')
  AND source_run_uid ~ '^fast[0-9]+\|[0-9]+$';
ALTER TABLE manufacturing_operations ENABLE TRIGGER USER;
-- runbackfill:end

CREATE UNIQUE INDEX manufacturing_operations_sintering_run_unique
    ON manufacturing_operations (equipment_id, sintering_run_number)
    WHERE process_category = 'sintering' AND sintering_run_number IS NOT NULL;

COMMENT ON INDEX manufacturing_operations_sintering_run_unique IS
    'One operation per FAST machine run.';

CREATE FUNCTION operation_code_for(op manufacturing_operations, p_sample_code TEXT)
    RETURNS TEXT
    LANGUAGE plpgsql
    STABLE
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_sample  TEXT := coalesce(p_sample_code, '');
    v_seq     TEXT := coalesce(op.operation_sequence::text, '');
    v_token   TEXT := '';
    v_parts   TEXT[] := '{}';
    v_code    TEXT;
    v_machine TEXT;
BEGIN
    IF op.process_category = 'sintering' THEN
        SELECT substring(e.equipment_name FROM '^FCT HP D (\d+)$') INTO v_machine
        FROM public.equipment e WHERE e.equipment_id = op.equipment_id;
        v_machine := coalesce(v_machine, substring(op.source_system FROM '^fast_(\d+)$'));
        IF v_machine IS NULL OR op.sintering_run_number IS NULL OR op.operation_date IS NULL THEN
            RETURN NULL;
        END IF;
        v_parts := array_remove(ARRAY[
            code_num(op.sintering_max_temp_celsius) || 'C',
            code_num(op.sintering_max_force_kn) || 'kN',
            code_num(op.sintering_mould_diameter_mm) || 'dia'], NULL);
        v_code := to_char(op.operation_date AT TIME ZONE 'UTC', 'DD-MM-YY')
                  || '-MF' || v_machine || '-' || op.sintering_run_number;
        IF cardinality(v_parts) > 0 THEN
            v_code := v_code || '-' || array_to_string(v_parts, '_');
        END IF;
        RETURN v_code;
    ELSIF op.process_category = 'machining' THEN
        v_token := coalesce(op.machining_operation_subtype, '') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.machining_cutting_speed_m_per_min) || 'MPM',
            code_num(op.machining_feed_mm_per_rev) || 'feed',
            code_num(op.machining_axial_depth_of_cut_mm) || 'DoC'], NULL);
    ELSIF op.process_category = 'heat_treatment' THEN
        v_token := 'HT' || coalesce(CASE op.ht_treatment_type
            WHEN 'anneal' THEN 'A' WHEN 'solution_treat' THEN 'S' WHEN 'age' THEN 'AG'
            WHEN 'quench' THEN 'Q' WHEN 'temper' THEN 'T' WHEN 'stress_relieve' THEN 'SR'
            WHEN 'normalise' THEN 'N' WHEN 'other' THEN 'X' END, '') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.ht_peak_temp_celsius) || 'C',
            code_num(op.ht_hold_time_min) || 'min',
            CASE op.ht_cooling_method
                WHEN 'furnace' THEN 'FC' WHEN 'air' THEN 'AC' WHEN 'water_quench' THEN 'WQ'
                WHEN 'oil_quench' THEN 'OQ' WHEN 'forced_air' THEN 'FA' WHEN 'other' THEN 'X' END], NULL);
    ELSIF op.process_category = 'deformation' THEN
        v_token := coalesce(CASE op.deform_deformation_type
            WHEN 'rolling' THEN 'DR' WHEN 'forging' THEN 'DF' WHEN 'extrusion' THEN 'DE'
            WHEN 'drawing' THEN 'DD' WHEN 'other' THEN 'DX' END, 'D') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.deform_deformation_temp_celsius) || 'C',
            code_num(op.deform_total_reduction_pct) || 'pct',
            code_num(op.deform_pass_count) || 'p'], NULL);
    ELSIF op.process_category = 'additive' THEN
        v_token := coalesce(op.am_process_variant, 'AM') || v_seq;
        v_parts := array_remove(ARRAY[
            code_num(op.am_laser_power_w) || 'W',
            code_num(op.am_scan_speed_mm_per_s) || 'mmps',
            code_num(op.am_layer_thickness_mm) || 'mm'], NULL);
    ELSE
        RETURN nullif(CASE WHEN v_sample <> '' AND v_seq <> '' THEN v_sample || '-' || v_seq ELSE v_sample END, '');
    END IF;

    v_code := v_sample;
    IF v_token <> '' THEN
        v_code := CASE WHEN v_code <> '' THEN v_code || '-' || v_token ELSE v_token END;
    END IF;
    IF v_code <> '' AND cardinality(v_parts) > 0 THEN
        v_code := v_code || '-' || array_to_string(v_parts, '_');
    END IF;
    RETURN nullif(v_code, '');
END;
$$;

COMMENT ON FUNCTION operation_code_for(manufacturing_operations, TEXT) IS
    'The operation code the rule gives for this row and its input sample''s code (spec 2026-10-10-record-codes §3); NULL when none can be built (e.g. sintering without a run number).';

INSERT INTO directus_fields (collection, field, interface, options, readonly, hidden, sort, width, note, "group", searchable)
SELECT 'manufacturing_operations', 'sintering_run_number', 'input', '{"min":1,"step":1}'::json, FALSE, FALSE,
       0, 'half', 'Run number shown on the FAST machine. Part of the code; leave empty until known.',
       'sintering_machine_group', TRUE
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number');

-- migrate:down
DELETE FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number';
DROP FUNCTION IF EXISTS operation_code_for(manufacturing_operations, TEXT);
DROP INDEX IF EXISTS manufacturing_operations_sintering_run_unique;
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS sintering_run_number;
DROP FUNCTION IF EXISTS code_num(NUMERIC);
