-- migrate:up
-- Conform runs, part 1 of 3: the `conform` process category, method CF, the machine, the lineage link, the code rule and
-- the inline parameter columns (docs/superpowers/specs/2026-10-21-conform-runs-design.md, "Data model"; ADR-0024, "Conform is
-- its own process category"; plan docs/superpowers/plans/2026-10-21-conform-runs.md, task A1). Part 2 is the next migration
-- (conform_logs, conform_run_data, access), part 3 the form layout.
--
-- Why. The lab's Conform machine (continuous rotary extrusion) could only be recorded as a generic `deformation` operation
-- with type "extrusion". A Conform run has its own parameters, a machine log shared between runs, derived energy and its own
-- plotter, and every per-category switch in the app (panel, plotter link, key settings, code rule) reads the scalar
-- manufacturing_operations.process_category, so Conform gets a category of its own, as FAST has `sintering`.
--
-- What this does.
--   1. `conform` joins both process_category CHECKs (manufacturing_operations, manufacturing_methods; the pattern of 129).
--   2. Method CF "Conform (continuous extrusion)" with category `conform`. No method CF existed (checked against the seeds
--      and every migration); the derive-category trigger of 129 then gives every CF operation its category.
--   3. The Conform machine (equipment_name 'Conform', seeded in 20260703000056 as 'deformation') also gets the `conform`
--      capability, so the Machine picker offers it for a Conform run. It keeps `deformation`: older records stay valid.
--      The capabilities field's dropdown (where that Directus field row exists) gains the choice.
--   4. `extruded_from` joins the sample_genealogy.relationship_type CHECK; mfg_op_link_genealogy (034) maps method CF, or
--      category `conform`, to it.
--   5. operation_code_for() (156) gets a conform branch: DD-MM-YY-CF-{run:03}-{die}dia, e.g. 17-03-25-CF-012-8dia. The date is
--      UTC, as for sintering. The die token is dropped when the die diameter is empty. A run number of 100 or more is written
--      in full (no truncation to three digits). Without a run number (or a date) there is nothing to build the code from, and
--      the branch falls back to the generic sample-code-and-sequence rule, so a Conform run still gets a code while it is
--      being typed. (The sintering branch returns NULL instead; the spec asks for the fallback here.)
--      trg_mfg_op_set_code() (157) lists the columns a code is built from in its fast exit: conform_run_number and
--      conform_die_diameter_mm join it, otherwise editing either would not rebuild the code. The function bodies are the
--      verbatim ones of 156 and 157 with only those additions.
--   6. The twelve inline conform_* columns on manufacturing_operations, the unique index (equipment_id, conform_run_number)
--      for Conform rows with a run number, and their Directus field rows: base hidden = true plus the condition
--      "show when conform" (the inline-parameter convention of 143), units in options.suffix, conform_feedstock_form as a
--      dropdown. The form layout (group grp_conform) is migration 208.
--
-- The down section restores every pre-image. It cannot restore data written under the new shape, and says where it is lossy:
-- operations with category `conform` go back to `deformation` (their pass_code is kept: the original code functions are
-- put back first, and they treat a conform-style code as typed), `extruded_from` edges go back to `derived_from`, the
-- conform_* values are dropped with their columns, and method CF is removed unless an operation or sample still uses it
-- (then it is kept, filed under `deformation`, and the next up adopts it again).
--
-- This migration takes strong locks on busy tables (ALTER TABLE, CREATE UNIQUE INDEX on manufacturing_operations): with live
-- writers it fails fast instead of queueing every reader behind it. Apply in a quiet window.
SET LOCAL lock_timeout = '10s';

-- 1. The category CHECKs.
ALTER TABLE manufacturing_operations DROP CONSTRAINT manufacturing_operations_process_category_check;
ALTER TABLE manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_process_category_check
    CHECK (process_category IN ('machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep', 'conform'));

ALTER TABLE manufacturing_methods DROP CONSTRAINT manufacturing_methods_process_category_check;
ALTER TABLE manufacturing_methods
    ADD CONSTRAINT manufacturing_methods_process_category_check
    CHECK (process_category IN ('machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep', 'conform'));

COMMENT ON COLUMN manufacturing_operations.process_category IS
    'Process family that selects the typed parameter panel in the UI (machining / sintering / heat_treatment / deformation / additive / sample_prep / conform).';
COMMENT ON COLUMN manufacturing_methods.process_category IS
    'Process family of operations done with this method (machining / sintering / heat_treatment / '
    'deformation / additive / sample_prep / conform). Copied onto manufacturing_operations.process_category when '
    'an operation is created or its method changes; NULL means "not mapped", and then an operation '
    'keeps whatever category it already has.';

-- 2. Method CF.
INSERT INTO manufacturing_methods (method_code, method_name, description, process_category)
VALUES ('CF', 'Conform (continuous extrusion)',
        'Continuous rotary extrusion on the Conform machine: feedstock (swarf, powder, granules or rod) is dragged by a '
        'grooved wheel into a die and leaves as one long extrusion, which is later sectioned into samples.',
        'conform')
ON CONFLICT (method_code) DO UPDATE
    SET method_name = EXCLUDED.method_name, description = EXCLUDED.description, process_category = EXCLUDED.process_category
    WHERE manufacturing_methods.process_category IS DISTINCT FROM 'conform';

-- 3. The machine and the capabilities dropdown.
UPDATE equipment
SET capabilities = coalesce(capabilities || ',conform', 'conform')
WHERE equipment_name = 'Conform'
  AND (',' || coalesce(capabilities, '') || ',') NOT LIKE '%,conform,%';

COMMENT ON COLUMN equipment.capabilities IS
    'CSV of process/test categories this machine can perform (machining, sintering, heat_treatment, deformation, additive, conform, nde, destructive, dynamic). Used to filter the Machine picker on operations and test sessions.';

UPDATE directus_fields
SET options = jsonb_set(options::jsonb, '{choices}',
        (options::jsonb -> 'choices') || '[{"text":"Conform (continuous extrusion)","value":"conform"}]'::jsonb)::json
WHERE collection = 'equipment' AND field = 'capabilities'
  AND jsonb_typeof(options::jsonb -> 'choices') = 'array'
  AND NOT (options::jsonb -> 'choices') @> '[{"value":"conform"}]'::jsonb;

-- 4. Lineage: input -> output of a Conform run is "extruded from".
ALTER TABLE sample_genealogy DROP CONSTRAINT sample_genealogy_relationship_check;
ALTER TABLE sample_genealogy
    ADD CONSTRAINT sample_genealogy_relationship_check
    CHECK (relationship_type IN ('derived_from', 'cut_from', 'sintered_from', 'powder_from', 'extruded_from'));

COMMENT ON COLUMN sample_genealogy.relationship_type IS
    'Nature of the derivation: derived_from, cut_from, sintered_from, powder_from, extruded_from (a Conform run''s output, from its feedstock).';

CREATE OR REPLACE FUNCTION mfg_op_link_genealogy() RETURNS trigger AS $$
DECLARE
    rel  TEXT := 'derived_from';
    code TEXT;
BEGIN
    IF NEW.sample_id IS NOT NULL AND NEW.output_sample_id IS NOT NULL
       AND NEW.sample_id <> NEW.output_sample_id THEN
        SELECT method_code INTO code FROM manufacturing_methods WHERE method_id = NEW.method_id;
        rel := CASE
            WHEN code = 'CF' OR NEW.process_category = 'conform'  THEN 'extruded_from'
            WHEN code IN ('MF','MHIP')                       THEN 'sintered_from'
            WHEN code IN ('MC','MM','MC2','MEDM','MCO','MX','MS') THEN 'cut_from'
            ELSE 'derived_from'
        END;
        INSERT INTO sample_genealogy (child_sample_id, parent_sample_id, relationship_type, notes)
        VALUES (NEW.output_sample_id, NEW.sample_id, rel,
                'Auto-linked from manufacturing operation ' || COALESCE(NEW.pass_code, NEW.operation_id::text))
        ON CONFLICT (child_sample_id, parent_sample_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6 (first, the code functions below read the new columns). The inline columns.
ALTER TABLE manufacturing_operations
    ADD COLUMN conform_run_number           INTEGER,
    ADD COLUMN conform_feedstock            TEXT,
    ADD COLUMN conform_feedstock_form       TEXT,
    ADD COLUMN conform_feed_mass_g          NUMERIC(10, 2),
    ADD COLUMN conform_die_diameter_mm      NUMERIC(8, 3),
    ADD COLUMN conform_tooling_id           TEXT,
    ADD COLUMN conform_extrusion_length_mm  NUMERIC(10, 1),
    ADD COLUMN conform_extrusion_mass_g     NUMERIC(10, 2),
    ADD COLUMN conform_yield_pct            NUMERIC(6, 2),
    ADD COLUMN conform_flash_mass_g         NUMERIC(10, 2),
    ADD COLUMN conform_wheel_speed_rpm      NUMERIC(8, 3),
    ADD COLUMN conform_ips_setpoint_c       NUMERIC(8, 1);

ALTER TABLE manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_conform_run_number_check CHECK (conform_run_number > 0),
    ADD CONSTRAINT manufacturing_operations_conform_feedstock_form_check
        CHECK (conform_feedstock_form IN ('swarf', 'powder', 'granules', 'rod'));

COMMENT ON COLUMN manufacturing_operations.conform_run_number IS
    'Conform run number as the lab numbers its runs (typed). Part of the Conform operation code (DD-MM-YY-CF-{run:03}-{die}dia). Unique per machine (equipment) among Conform operations.';
COMMENT ON COLUMN manufacturing_operations.conform_feedstock IS
    'Feedstock described in words, for a feedstock that is neither an input sample nor a raw stock lot (for example "TiSwarf, 60/40 mix"). The input sample or a raw stock lot linked through sample_stock_provenance is the structured record.';
COMMENT ON COLUMN manufacturing_operations.conform_feedstock_form IS
    'Physical form of the feedstock fed to the Conform wheel: swarf, powder, granules or rod.';
COMMENT ON COLUMN manufacturing_operations.conform_feed_mass_g IS
    'Mass of feedstock charged to the run, grams.';
COMMENT ON COLUMN manufacturing_operations.conform_die_diameter_mm IS
    'Die exit diameter, mm. Part of the Conform operation code (dropped from it when empty).';
COMMENT ON COLUMN manufacturing_operations.conform_tooling_id IS
    'Identifier of the abutment / die tooling used for the run (free text).';
COMMENT ON COLUMN manufacturing_operations.conform_extrusion_length_mm IS
    'Length of extrusion produced by the run, mm.';
COMMENT ON COLUMN manufacturing_operations.conform_extrusion_mass_g IS
    'Mass of the extrusion produced by the run, grams.';
COMMENT ON COLUMN manufacturing_operations.conform_yield_pct IS
    'Yield of the run, percent (extrusion mass over feedstock mass charged).';
COMMENT ON COLUMN manufacturing_operations.conform_flash_mass_g IS
    'Mass of flash (material that escaped around the tooling and did not leave through the die), grams.';
COMMENT ON COLUMN manufacturing_operations.conform_wheel_speed_rpm IS
    'Wheel speed setpoint, rpm. Filled from the first step of the machine log when the run window is set and this is empty; editable afterwards.';
COMMENT ON COLUMN manufacturing_operations.conform_ips_setpoint_c IS
    'IPS (induction preheat) setpoint, degrees Celsius. Filled from the first step of the machine log when the run window is set and this is empty; editable afterwards.';

CREATE UNIQUE INDEX manufacturing_operations_conform_run_unique
    ON manufacturing_operations (equipment_id, conform_run_number)
    WHERE process_category = 'conform' AND conform_run_number IS NOT NULL;

COMMENT ON INDEX manufacturing_operations_conform_run_unique IS
    'One Conform operation per machine and run number (rows without a run number or without a machine are not constrained).';

-- 5. The code rule (verbatim 156 with the conform branch) and the trigger's column list (verbatim 157 plus two columns).
CREATE OR REPLACE FUNCTION operation_code_for(op manufacturing_operations, p_sample_code TEXT)
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
        v_token := regexp_replace(coalesce(op.machining_operation_subtype, ''), '^[A-Z]{2}-', '') || v_seq;
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
    ELSIF op.process_category = 'conform' THEN
        -- DD-MM-YY-CF-{run:03}-{die}dia (UTC date as for sintering; the die token is dropped when the die is empty).
        -- Without a run number or a date there is nothing to build the code from yet: fall back to the generic
        -- sample-code rule below until they are typed (spec 2026-10-21-conform-runs-design.md, Operation code).
        IF op.conform_run_number IS NOT NULL AND op.operation_date IS NOT NULL THEN
            v_code := to_char(op.operation_date AT TIME ZONE 'UTC', 'DD-MM-YY') || '-CF-'
                      || CASE WHEN op.conform_run_number < 100 THEN lpad(op.conform_run_number::text, 3, '0')
                              ELSE op.conform_run_number::text END;
            IF op.conform_die_diameter_mm IS NOT NULL THEN
                v_code := v_code || '-' || code_num(op.conform_die_diameter_mm) || 'dia';
            END IF;
            RETURN v_code;
        END IF;
        RETURN nullif(CASE WHEN v_sample <> '' AND v_seq <> '' THEN v_sample || '-' || v_seq ELSE v_sample END, '');
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
    'The operation code the rule gives for this row and its input sample''s code (spec 2026-10-10-record-codes §3); NULL when none can be built (e.g. sintering without a run number). A machining subtype loses its two-letter method prefix (MT-F gives F), as in every stored code. A Conform run gives DD-MM-YY-CF-{run:03}-{die}dia (UTC date; the die token is dropped when empty) and falls back to the sample code and sequence while it has no run number or date.';

CREATE OR REPLACE FUNCTION trg_mfg_op_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_new_sample TEXT;
    v_old_sample TEXT;
    v_auto       BOOLEAN;
    v_written    BOOLEAN := FALSE;
    v_renumber   BOOLEAN := FALSE;
BEGIN
    -- Fast exit: on UPDATE nothing the code is built from changed and the code was not written.
    IF TG_OP = 'UPDATE'
       AND NEW.pass_code IS NOT DISTINCT FROM OLD.pass_code
       AND (NEW.sample_id, NEW.method_id, NEW.process_category, NEW.operation_sequence,
            NEW.machining_operation_subtype, NEW.machining_cutting_speed_m_per_min,
            NEW.machining_feed_mm_per_rev, NEW.machining_axial_depth_of_cut_mm,
            NEW.ht_treatment_type, NEW.ht_peak_temp_celsius, NEW.ht_hold_time_min, NEW.ht_cooling_method,
            NEW.deform_deformation_type, NEW.deform_deformation_temp_celsius,
            NEW.deform_total_reduction_pct, NEW.deform_pass_count,
            NEW.am_process_variant, NEW.am_laser_power_w, NEW.am_scan_speed_mm_per_s, NEW.am_layer_thickness_mm,
            NEW.sintering_max_temp_celsius, NEW.sintering_max_force_kn, NEW.sintering_mould_diameter_mm,
            NEW.sintering_run_number, NEW.operation_date, NEW.equipment_id, NEW.source_system,
            NEW.conform_run_number, NEW.conform_die_diameter_mm)
           IS NOT DISTINCT FROM
           (OLD.sample_id, OLD.method_id, OLD.process_category, OLD.operation_sequence,
            OLD.machining_operation_subtype, OLD.machining_cutting_speed_m_per_min,
            OLD.machining_feed_mm_per_rev, OLD.machining_axial_depth_of_cut_mm,
            OLD.ht_treatment_type, OLD.ht_peak_temp_celsius, OLD.ht_hold_time_min, OLD.ht_cooling_method,
            OLD.deform_deformation_type, OLD.deform_deformation_temp_celsius,
            OLD.deform_total_reduction_pct, OLD.deform_pass_count,
            OLD.am_process_variant, OLD.am_laser_power_w, OLD.am_scan_speed_mm_per_s, OLD.am_layer_thickness_mm,
            OLD.sintering_max_temp_celsius, OLD.sintering_max_force_kn, OLD.sintering_mould_diameter_mm,
            OLD.sintering_run_number, OLD.operation_date, OLD.equipment_id, OLD.source_system,
            OLD.conform_run_number, OLD.conform_die_diameter_mm) THEN
        RETURN NEW;
    END IF;

    -- A new operation with a sample and no sequence gets the next one (as migration 126 did),
    -- typed code or not; imported rows (source_system set) keep NULL.
    IF TG_OP = 'INSERT' AND NEW.operation_sequence IS NULL AND NEW.sample_id IS NOT NULL
       AND NEW.source_system IS NULL THEN
        v_renumber := TRUE;
    END IF;

    -- Frozen rows: never renamed automatically (a person may still type a code). Clearing the code
    -- (empty, or an old client's {seq}/{mf} placeholder) does not make a frozen row automatic:
    -- the saved code is kept.
    IF NEW.source_system = 'experiment_sheet' THEN
        IF TG_OP = 'UPDATE'
           AND (nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}')
           AND nullif(btrim(OLD.pass_code), '') IS NOT NULL THEN
            NEW.pass_code := OLD.pass_code;
        END IF;
        RETURN NEW;
    END IF;

    SELECT ps.sample_code INTO v_new_sample FROM public.physical_samples ps WHERE ps.sample_id = NEW.sample_id;

    -- Automatic or typed?
    IF TG_OP = 'INSERT' THEN
        v_auto := nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}';
        v_written := NOT v_auto;
    ELSIF NEW.pass_code IS DISTINCT FROM OLD.pass_code THEN
        IF nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}' THEN
            v_auto := TRUE;                 -- cleared, or an old client's placeholder: rebuild
        ELSE
            v_auto := FALSE;
            v_written := TRUE;              -- kept as written; the next edit compares the old row with the rule
        END IF;
    ELSE
        SELECT ps.sample_code INTO v_old_sample FROM public.physical_samples ps WHERE ps.sample_id = OLD.sample_id;
        -- No code yet counts as automatic (the 9 NULL codes and codeless sintering rows get one
        -- at their next edit); otherwise automatic means "is the rule's value for the old row".
        v_auto := OLD.pass_code IS NULL
                  OR OLD.pass_code = public.operation_code_for(OLD, v_old_sample);
    END IF;

    -- A new number when the sample or the method of an automatic operation changed (also when the
    -- same statement cleared the code or sent a placeholder), unless the sequence was set by hand.
    IF TG_OP = 'UPDATE' AND v_auto AND NEW.sample_id IS NOT NULL AND NEW.source_system IS NULL
       AND NEW.operation_sequence IS NOT DISTINCT FROM OLD.operation_sequence
       AND (NEW.sample_id IS DISTINCT FROM OLD.sample_id OR NEW.method_id IS DISTINCT FROM OLD.method_id) THEN
        v_renumber := TRUE;
    END IF;

    IF v_renumber THEN
        -- Lock order: rollup lock, then the sample row (as migration 126).
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('refresh_project_rollup', 0));
        PERFORM 1 FROM public.physical_samples ps WHERE ps.sample_id = NEW.sample_id FOR NO KEY UPDATE;
        SELECT coalesce(max(mo.operation_sequence), 0) + 1 INTO NEW.operation_sequence
        FROM public.manufacturing_operations mo
        WHERE mo.sample_id = NEW.sample_id AND mo.operation_id IS DISTINCT FROM NEW.operation_id;
    END IF;

    IF v_written THEN
        NEW.pass_code := btrim(NEW.pass_code);  -- typed (or the rule's own value): kept as written
    ELSIF v_auto THEN
        NEW.pass_code := public.operation_code_for(NEW, v_new_sample);
    END IF;
    RETURN NEW;
END;
$$;

-- 6 (cont.). Directus field rows for the twelve columns: hidden at the base, shown by the condition "show when conform".
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden,
                             sort, width, required, translations, note, conditions)
SELECT 'manufacturing_operations', v.field, NULL, v.interface, v.options::json, v.display, NULL, FALSE, TRUE,
       v.sort, 'half', FALSE, v.translation::json, v.note,
       '[{"name": "show when conform", "rule": {"_and": [{"process_category": {"_eq": "conform"}}]}, "hidden": false, "readonly": false, "required": false}]'::json
FROM (VALUES
    ('conform_run_number', 'input', '{"min": 1, "step": 1}', 'raw', 600,
        '[{"language": "en-US", "translation": "Conform run number"}]',
        'The lab''s number for this run. Part of the operation code; unique per machine.'),
    ('conform_feedstock', 'input', NULL, 'raw', 601,
        '[{"language": "en-US", "translation": "Feedstock (when not a sample or lot)"}]',
        'Describe the feedstock here when it is neither the input sample nor a raw stock lot.'),
    ('conform_feedstock_form', 'select-dropdown',
        '{"choices": [{"text": "Swarf", "value": "swarf"}, {"text": "Powder", "value": "powder"}, {"text": "Granules", "value": "granules"}, {"text": "Rod", "value": "rod"}]}',
        'labels', 602,
        '[{"language": "en-US", "translation": "Feedstock form"}]', NULL),
    ('conform_feed_mass_g', 'input', '{"step": 0.01, "suffix": "g"}', 'raw', 603,
        '[{"language": "en-US", "translation": "Feedstock mass charged"}]', NULL),
    ('conform_die_diameter_mm', 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', 604,
        '[{"language": "en-US", "translation": "Die exit diameter"}]',
        'Part of the operation code.'),
    ('conform_tooling_id', 'input', NULL, 'raw', 605,
        '[{"language": "en-US", "translation": "Abutment / die tooling"}]', NULL),
    ('conform_extrusion_length_mm', 'input', '{"step": 0.1, "suffix": "mm"}', 'raw', 606,
        '[{"language": "en-US", "translation": "Extrusion length"}]', NULL),
    ('conform_extrusion_mass_g', 'input', '{"step": 0.01, "suffix": "g"}', 'raw', 607,
        '[{"language": "en-US", "translation": "Extrusion mass"}]', NULL),
    ('conform_yield_pct', 'input', '{"step": 0.01, "suffix": "%"}', 'raw', 608,
        '[{"language": "en-US", "translation": "Yield"}]', NULL),
    ('conform_flash_mass_g', 'input', '{"step": 0.01, "suffix": "g"}', 'raw', 609,
        '[{"language": "en-US", "translation": "Flash mass"}]', NULL),
    ('conform_wheel_speed_rpm', 'input', '{"step": 0.001, "suffix": "rpm"}', 'raw', 610,
        '[{"language": "en-US", "translation": "Wheel speed setpoint"}]',
        'Filled from the machine log when the run window is set, if empty.'),
    ('conform_ips_setpoint_c', 'input', '{"step": 0.1, "suffix": "°C"}', 'raw', 611,
        '[{"language": "en-US", "translation": "IPS setpoint"}]',
        'Filled from the machine log when the run window is set, if empty.')
) AS v (field, interface, options, display, sort, translation, note)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields f WHERE f.collection = 'manufacturing_operations' AND f.field = v.field
);

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- The Directus rows and the columns go last; the code functions come back first, so that putting the operations back into
-- `deformation` below does not rebuild their codes (the original operation_code_for treats a conform-style code as typed).
CREATE OR REPLACE FUNCTION trg_mfg_op_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_new_sample TEXT;
    v_old_sample TEXT;
    v_auto       BOOLEAN;
    v_written    BOOLEAN := FALSE;
    v_renumber   BOOLEAN := FALSE;
BEGIN
    -- Fast exit: on UPDATE nothing the code is built from changed and the code was not written.
    IF TG_OP = 'UPDATE'
       AND NEW.pass_code IS NOT DISTINCT FROM OLD.pass_code
       AND (NEW.sample_id, NEW.method_id, NEW.process_category, NEW.operation_sequence,
            NEW.machining_operation_subtype, NEW.machining_cutting_speed_m_per_min,
            NEW.machining_feed_mm_per_rev, NEW.machining_axial_depth_of_cut_mm,
            NEW.ht_treatment_type, NEW.ht_peak_temp_celsius, NEW.ht_hold_time_min, NEW.ht_cooling_method,
            NEW.deform_deformation_type, NEW.deform_deformation_temp_celsius,
            NEW.deform_total_reduction_pct, NEW.deform_pass_count,
            NEW.am_process_variant, NEW.am_laser_power_w, NEW.am_scan_speed_mm_per_s, NEW.am_layer_thickness_mm,
            NEW.sintering_max_temp_celsius, NEW.sintering_max_force_kn, NEW.sintering_mould_diameter_mm,
            NEW.sintering_run_number, NEW.operation_date, NEW.equipment_id, NEW.source_system)
           IS NOT DISTINCT FROM
           (OLD.sample_id, OLD.method_id, OLD.process_category, OLD.operation_sequence,
            OLD.machining_operation_subtype, OLD.machining_cutting_speed_m_per_min,
            OLD.machining_feed_mm_per_rev, OLD.machining_axial_depth_of_cut_mm,
            OLD.ht_treatment_type, OLD.ht_peak_temp_celsius, OLD.ht_hold_time_min, OLD.ht_cooling_method,
            OLD.deform_deformation_type, OLD.deform_deformation_temp_celsius,
            OLD.deform_total_reduction_pct, OLD.deform_pass_count,
            OLD.am_process_variant, OLD.am_laser_power_w, OLD.am_scan_speed_mm_per_s, OLD.am_layer_thickness_mm,
            OLD.sintering_max_temp_celsius, OLD.sintering_max_force_kn, OLD.sintering_mould_diameter_mm,
            OLD.sintering_run_number, OLD.operation_date, OLD.equipment_id, OLD.source_system) THEN
        RETURN NEW;
    END IF;

    -- A new operation with a sample and no sequence gets the next one (as migration 126 did),
    -- typed code or not; imported rows (source_system set) keep NULL.
    IF TG_OP = 'INSERT' AND NEW.operation_sequence IS NULL AND NEW.sample_id IS NOT NULL
       AND NEW.source_system IS NULL THEN
        v_renumber := TRUE;
    END IF;

    -- Frozen rows: never renamed automatically (a person may still type a code). Clearing the code
    -- (empty, or an old client's {seq}/{mf} placeholder) does not make a frozen row automatic:
    -- the saved code is kept.
    IF NEW.source_system = 'experiment_sheet' THEN
        IF TG_OP = 'UPDATE'
           AND (nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}')
           AND nullif(btrim(OLD.pass_code), '') IS NOT NULL THEN
            NEW.pass_code := OLD.pass_code;
        END IF;
        RETURN NEW;
    END IF;

    SELECT ps.sample_code INTO v_new_sample FROM public.physical_samples ps WHERE ps.sample_id = NEW.sample_id;

    -- Automatic or typed?
    IF TG_OP = 'INSERT' THEN
        v_auto := nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}';
        v_written := NOT v_auto;
    ELSIF NEW.pass_code IS DISTINCT FROM OLD.pass_code THEN
        IF nullif(btrim(NEW.pass_code), '') IS NULL OR NEW.pass_code ~ '\{(seq|mf)\}' THEN
            v_auto := TRUE;                 -- cleared, or an old client's placeholder: rebuild
        ELSE
            v_auto := FALSE;
            v_written := TRUE;              -- kept as written; the next edit compares the old row with the rule
        END IF;
    ELSE
        SELECT ps.sample_code INTO v_old_sample FROM public.physical_samples ps WHERE ps.sample_id = OLD.sample_id;
        -- No code yet counts as automatic (the 9 NULL codes and codeless sintering rows get one
        -- at their next edit); otherwise automatic means "is the rule's value for the old row".
        v_auto := OLD.pass_code IS NULL
                  OR OLD.pass_code = public.operation_code_for(OLD, v_old_sample);
    END IF;

    -- A new number when the sample or the method of an automatic operation changed (also when the
    -- same statement cleared the code or sent a placeholder), unless the sequence was set by hand.
    IF TG_OP = 'UPDATE' AND v_auto AND NEW.sample_id IS NOT NULL AND NEW.source_system IS NULL
       AND NEW.operation_sequence IS NOT DISTINCT FROM OLD.operation_sequence
       AND (NEW.sample_id IS DISTINCT FROM OLD.sample_id OR NEW.method_id IS DISTINCT FROM OLD.method_id) THEN
        v_renumber := TRUE;
    END IF;

    IF v_renumber THEN
        -- Lock order: rollup lock, then the sample row (as migration 126).
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('refresh_project_rollup', 0));
        PERFORM 1 FROM public.physical_samples ps WHERE ps.sample_id = NEW.sample_id FOR NO KEY UPDATE;
        SELECT coalesce(max(mo.operation_sequence), 0) + 1 INTO NEW.operation_sequence
        FROM public.manufacturing_operations mo
        WHERE mo.sample_id = NEW.sample_id AND mo.operation_id IS DISTINCT FROM NEW.operation_id;
    END IF;

    IF v_written THEN
        NEW.pass_code := btrim(NEW.pass_code);  -- typed (or the rule's own value): kept as written
    ELSIF v_auto THEN
        NEW.pass_code := public.operation_code_for(NEW, v_new_sample);
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_mfg_op_set_code() IS
    'BEFORE INSERT / UPDATE on manufacturing_operations: keeps pass_code equal to the rule (operation_code_for) for operations whose code is automatic (empty, an old client''s {seq}/{mf} placeholder, or the rule''s own value for the row before the change); a typed code is kept; experiment_sheet rows are frozen (never renamed automatically, and clearing the code, or sending a placeholder, keeps the saved one; a new typed code is stored). Also numbers a new operation (max+1 per sample under the rollup lock and the sample row) and renumbers an automatic one that changes sample or method. Replaces trg_manufacturing_operations_assign_numbers (126). Spec 2026-10-10-record-codes §3.';

CREATE OR REPLACE FUNCTION operation_code_for(op manufacturing_operations, p_sample_code TEXT)
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
        v_token := regexp_replace(coalesce(op.machining_operation_subtype, ''), '^[A-Z]{2}-', '') || v_seq;
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
    'The operation code the rule gives for this row and its input sample''s code (spec 2026-10-10-record-codes §3); NULL when none can be built (e.g. sintering without a run number). A machining subtype loses its two-letter method prefix (MT-F gives F), as in every stored code.';

-- Lossy by nature: a Conform operation becomes a deformation operation (its pass_code is kept, the conform_* values go
-- with their columns below), an extruded_from edge becomes derived_from.
UPDATE manufacturing_operations SET process_category = 'deformation' WHERE process_category = 'conform';
UPDATE sample_genealogy SET relationship_type = 'derived_from' WHERE relationship_type = 'extruded_from';

-- Method CF goes unless something still uses it; then it stays, filed under `deformation` (the next up adopts it again).
DELETE FROM manufacturing_methods mm
WHERE mm.method_code = 'CF' AND mm.process_category = 'conform'
  AND NOT EXISTS (SELECT 1 FROM manufacturing_operations o WHERE o.method_id = mm.method_id)
  AND NOT EXISTS (SELECT 1 FROM physical_samples s WHERE s.primary_method_id = mm.method_id);
UPDATE manufacturing_methods SET process_category = 'deformation' WHERE method_code = 'CF' AND process_category = 'conform';

DELETE FROM directus_fields
WHERE collection = 'manufacturing_operations'
  AND field IN ('conform_run_number', 'conform_feedstock', 'conform_feedstock_form', 'conform_feed_mass_g',
                'conform_die_diameter_mm', 'conform_tooling_id', 'conform_extrusion_length_mm', 'conform_extrusion_mass_g',
                'conform_yield_pct', 'conform_flash_mass_g', 'conform_wheel_speed_rpm', 'conform_ips_setpoint_c');

DROP INDEX IF EXISTS manufacturing_operations_conform_run_unique;
ALTER TABLE manufacturing_operations
    DROP CONSTRAINT IF EXISTS manufacturing_operations_conform_run_number_check,
    DROP CONSTRAINT IF EXISTS manufacturing_operations_conform_feedstock_form_check;
ALTER TABLE manufacturing_operations
    DROP COLUMN IF EXISTS conform_run_number,
    DROP COLUMN IF EXISTS conform_feedstock,
    DROP COLUMN IF EXISTS conform_feedstock_form,
    DROP COLUMN IF EXISTS conform_feed_mass_g,
    DROP COLUMN IF EXISTS conform_die_diameter_mm,
    DROP COLUMN IF EXISTS conform_tooling_id,
    DROP COLUMN IF EXISTS conform_extrusion_length_mm,
    DROP COLUMN IF EXISTS conform_extrusion_mass_g,
    DROP COLUMN IF EXISTS conform_yield_pct,
    DROP COLUMN IF EXISTS conform_flash_mass_g,
    DROP COLUMN IF EXISTS conform_wheel_speed_rpm,
    DROP COLUMN IF EXISTS conform_ips_setpoint_c;

-- The genealogy trigger function as migration 034 left it.
CREATE OR REPLACE FUNCTION mfg_op_link_genealogy() RETURNS trigger AS $$
DECLARE
    rel  TEXT := 'derived_from';
    code TEXT;
BEGIN
    IF NEW.sample_id IS NOT NULL AND NEW.output_sample_id IS NOT NULL
       AND NEW.sample_id <> NEW.output_sample_id THEN
        SELECT method_code INTO code FROM manufacturing_methods WHERE method_id = NEW.method_id;
        rel := CASE
            WHEN code IN ('MF','MHIP')                       THEN 'sintered_from'
            WHEN code IN ('MC','MM','MC2','MEDM','MCO','MX','MS') THEN 'cut_from'
            ELSE 'derived_from'
        END;
        INSERT INTO sample_genealogy (child_sample_id, parent_sample_id, relationship_type, notes)
        VALUES (NEW.output_sample_id, NEW.sample_id, rel,
                'Auto-linked from manufacturing operation ' || COALESCE(NEW.pass_code, NEW.operation_id::text))
        ON CONFLICT (child_sample_id, parent_sample_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE sample_genealogy DROP CONSTRAINT sample_genealogy_relationship_check;
ALTER TABLE sample_genealogy
    ADD CONSTRAINT sample_genealogy_relationship_check
    CHECK (relationship_type IN ('derived_from', 'cut_from', 'sintered_from', 'powder_from'));
COMMENT ON COLUMN sample_genealogy.relationship_type IS
    'Nature of the derivation: derived_from, cut_from, sintered_from, powder_from.';

-- The capability: back to what the seed gave the machine, and the dropdown choice out.
UPDATE equipment
SET capabilities = nullif(trim(BOTH ',' FROM replace(',' || capabilities || ',', ',conform,', ',')), '')
WHERE equipment_name = 'Conform' AND (',' || coalesce(capabilities, '') || ',') LIKE '%,conform,%';

UPDATE directus_fields
SET options = jsonb_set(options::jsonb, '{choices}',
        coalesce((SELECT jsonb_agg(c) FROM jsonb_array_elements(options::jsonb -> 'choices') AS c WHERE c ->> 'value' <> 'conform'), '[]'::jsonb))::json
WHERE collection = 'equipment' AND field = 'capabilities'
  AND jsonb_typeof(options::jsonb -> 'choices') = 'array'
  AND (options::jsonb -> 'choices') @> '[{"value":"conform"}]'::jsonb;

COMMENT ON COLUMN equipment.capabilities IS
    'CSV of process/test categories this machine can perform (machining, sintering, heat_treatment, deformation, additive, nde, destructive, dynamic). Used to filter the Machine picker on operations and test sessions.';

ALTER TABLE manufacturing_methods DROP CONSTRAINT manufacturing_methods_process_category_check;
ALTER TABLE manufacturing_methods
    ADD CONSTRAINT manufacturing_methods_process_category_check
    CHECK (process_category IN ('machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep'));
ALTER TABLE manufacturing_operations DROP CONSTRAINT manufacturing_operations_process_category_check;
ALTER TABLE manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_process_category_check
    CHECK (process_category IN ('machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep'));

COMMENT ON COLUMN manufacturing_operations.process_category IS
    'Process family that selects the typed parameter panel in the UI (machining / sintering / heat_treatment / deformation / additive).';
COMMENT ON COLUMN manufacturing_methods.process_category IS
    'Process family of operations done with this method (machining / sintering / heat_treatment / '
    'deformation / additive / sample_prep). Copied onto manufacturing_operations.process_category when '
    'an operation is created or its method changes; NULL means "not mapped", and then an operation '
    'keeps whatever category it already has.';
