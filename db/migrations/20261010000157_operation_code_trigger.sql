-- migrate:up
-- Operation codes follow their fields (stream T0b, spec 2026-10-10-record-codes-design.md §3).
--
-- Why: until now the code (pass_code) was composed in the browser and stored once, so a saved code
-- went stale the moment the speed, the sample or the method of the operation changed. Migration 156
-- put the rule in Postgres (operation_code_for); this trigger applies it.
--
-- Replaces: trigger mfg_op_assign_numbers / trg_manufacturing_operations_assign_numbers() (126),
-- which numbered the operation and replaced the {seq} / {mf} placeholders of a client-composed
-- code. The {mf} running counter is gone for good: the number after MF is the machine, the run
-- number is typed or imported, never invented (Q48). An old client that still sends a code with a
-- {seq} or {mf} placeholder is treated as sending no code, so the database builds it.
--
-- Typed or automatic: a code is automatic when it is empty/NULL or is exactly what the rule gives
-- for the row as it was before the change (so every code the rule built follows its fields). Any
-- other code (a person's own, a legacy one that is not the rule's value) is typed and is never
-- rewritten; clearing the field, or writing exactly the rule's value, makes it automatic again.
-- An operation with no code yet counts as automatic, but only gets one once something its code is
-- built from changes (an edit of the notes leaves it NULL). Operations with source_system
-- 'experiment_sheet' are frozen: they keep their code whatever changes (a person may still type
-- a new one, but clearing the code, or writing a {seq}/{mf} placeholder, keeps the saved one); imported rows (source_system set) keep a NULL
-- sequence as under 126.
--
-- operation_sequence: a new operation with a sample and no number gets max+1 for the sample (as
-- under 126, typed code or not); when the sample or the method of an automatic operation changes
-- (and the number was not set by hand) it gets the next number of the sample it is now in.
--
-- Lock order: rollup advisory lock (same key as refresh_project_rollup, migration 118), then the
-- sample row FOR NO KEY UPDATE. Only a statement that needs a number takes them: the fast exit
-- below returns before anything is locked when nothing the code is built from changed (a notes
-- edit, a status update, a bulk update of unrelated columns).
--
-- Trigger shape: no column list (UPDATE OF) and no WHEN clause naming pass_code. Migration 116's
-- down retypes code columns, which Postgres refuses while a trigger names the column.
--
-- The trigger sorts after mfg_op_derive_category, so process_category is already derived when it runs.

SET LOCAL lock_timeout = '10s';

-- seqbackfill:start
-- The imported/legacy machining operations have no operation_sequence, but their codes carry the
-- pass number (S-F7-30MPM, S-F2_1-60MPM, S-F3_30MPM_0.05feed: sample code, then letter + number).
-- Read it into the column so the rule can rebuild those codes. Done with the table's user triggers
-- on (the audited, versioned change is wanted; ~50 rows) and before the new trigger exists, so
-- nothing rewrites the codes. Frozen rows are included (the number is read, the code is untouched).
-- A number is not taken when another machining operation of the sample already has it for the same
-- letter, or when two candidates would share it (the rule would then give two operations one code);
-- those stay NULL. What was filled is kept in d1_private.operation_sequence_backfill so the down
-- can undo exactly that.
CREATE SCHEMA IF NOT EXISTS d1_private;
CREATE TABLE IF NOT EXISTS d1_private.operation_sequence_backfill (
    operation_id UUID    PRIMARY KEY,
    filled       INTEGER NOT NULL
);
COMMENT ON TABLE d1_private.operation_sequence_backfill IS
    'Migration 157: the operation_sequence values read out of existing machining codes. The down puts these rows back to NULL.';
DO $$
DECLARE
    v_filled INTEGER;
    v_left   INTEGER;
BEGIN
    WITH cand AS (
        -- token = what follows "<sample code>-" up to the next "-" (F3, F2_1, F3_30MPM_0.05feed);
        -- the number is the digits right after its leading letters (F2_1 gives 2, a bare "7" none).
        -- st = the subtype as the rule writes it in the code (MT-F gives F).
        SELECT mo.operation_id, mo.sample_id,
               regexp_replace(coalesce(mo.machining_operation_subtype, ''), '^[A-Z]{2}-', '') AS st,
               substring(split_part(substr(mo.pass_code, length(ps.sample_code) + 2), '-', 1) FROM '^[A-Za-z]+(\d+)') AS digits
        FROM public.manufacturing_operations mo
        JOIN public.physical_samples ps ON ps.sample_id = mo.sample_id
        WHERE mo.process_category = 'machining'
          AND mo.operation_sequence IS NULL
          AND left(mo.pass_code, length(ps.sample_code) + 1) = ps.sample_code || '-'
    ), num AS (
        SELECT operation_id, sample_id, st, digits::int AS n,
               count(*) OVER (PARTITION BY sample_id, st, digits::int) AS same_candidates
        FROM cand
        WHERE digits IS NOT NULL AND length(digits) <= 9
    ), ins AS (
        -- never create a duplicate code: skip a number another operation of the sample already has
        -- for the same letter, and numbers two candidates would share
        INSERT INTO d1_private.operation_sequence_backfill (operation_id, filled)
        SELECT n.operation_id, n.n FROM num n
        WHERE n.same_candidates = 1
          AND NOT EXISTS (
              SELECT 1 FROM public.manufacturing_operations o
              WHERE o.sample_id = n.sample_id AND o.operation_id <> n.operation_id
                AND o.process_category = 'machining' AND o.operation_sequence = n.n
                AND regexp_replace(coalesce(o.machining_operation_subtype, ''), '^[A-Z]{2}-', '') = n.st)
        ON CONFLICT (operation_id) DO NOTHING
        RETURNING operation_id, filled
    )
    UPDATE public.manufacturing_operations mo
    SET operation_sequence = ins.filled
    FROM ins
    WHERE mo.operation_id = ins.operation_id;
    GET DIAGNOSTICS v_filled = ROW_COUNT;
    SELECT count(*) INTO v_left FROM public.manufacturing_operations
    WHERE process_category = 'machining' AND operation_sequence IS NULL;
    RAISE NOTICE 'operation_sequence back-fill: % machining operations filled from their code, % machining operations still without a number', v_filled, v_left;
END $$;
-- seqbackfill:end

DROP TRIGGER mfg_op_assign_numbers ON manufacturing_operations;
DROP FUNCTION trg_manufacturing_operations_assign_numbers();

CREATE FUNCTION trg_mfg_op_set_code()
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

CREATE TRIGGER mfg_op_set_code
    BEFORE INSERT OR UPDATE ON manufacturing_operations
    FOR EACH ROW EXECUTE FUNCTION trg_mfg_op_set_code();

COMMENT ON TRIGGER mfg_op_set_code ON manufacturing_operations IS
    'Numbers the operation and keeps an automatic pass_code equal to the code rule (T0b). No UPDATE OF / WHEN on pass_code: migration 116''s down retypes code columns.';

COMMENT ON COLUMN manufacturing_operations.operation_sequence IS
    'Ordering of this operation within the sample lifecycle (1 = first); the number in its code. Left NULL on insert it is assigned by the database as max+1 for the sample (not for imported rows, source_system set); a supplied value (e.g. a machining pass number) is kept. An automatic operation that moves to another sample or method gets the next number there.';

COMMENT ON COLUMN manufacturing_operations.pass_code IS
    'Human-readable operation code, e.g. TEST-S-F2-30MPM_0.1feed_1DoC or 22-04-21-MF25-4624-950C_11kN_20dia. Kept up to date by the database from the operation''s fields (operation_code_for) unless a person typed a different one; clear it to make it automatic again. Not the PK.';

-- migrate:down
-- Undo the sequence back-fill first (the new trigger would rebuild the codes of the rows it touches), then put
-- back migration 126's trigger, function and comments exactly as they were.
DROP TRIGGER IF EXISTS mfg_op_set_code ON manufacturing_operations;
DROP FUNCTION IF EXISTS trg_mfg_op_set_code();
UPDATE manufacturing_operations mo SET operation_sequence = NULL
FROM d1_private.operation_sequence_backfill b
WHERE mo.operation_id = b.operation_id AND mo.operation_sequence = b.filled;
DROP TABLE IF EXISTS d1_private.operation_sequence_backfill;

CREATE FUNCTION trg_manufacturing_operations_assign_numbers() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_mf BIGINT;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.pass_code IS NOT DISTINCT FROM OLD.pass_code THEN
        RETURN NEW;
    END IF;

    -- Lock order: the rollup lock before any lock below (see the header). Same key as
    -- refresh_project_rollup() in migration 118.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('refresh_project_rollup', 0));

    -- Per-sample operation number.
    IF NEW.operation_sequence IS NULL
       AND NEW.sample_id IS NOT NULL
       AND NEW.source_system IS NULL          -- imported rows keep their NULL (see the header)
       AND (TG_OP = 'INSERT' OR NEW.pass_code LIKE '%{seq}%')
    THEN
        -- Serialise writers for this sample on its parent row (no row is locked when sample_id
        -- points at nothing; the foreign key rejects the write afterwards).
        PERFORM 1
        FROM    public.physical_samples ps
        WHERE   ps.sample_id = NEW.sample_id
        FOR NO KEY UPDATE;
        SELECT COALESCE(max(mo.operation_sequence), 0) + 1
        INTO   NEW.operation_sequence
        FROM   public.manufacturing_operations mo
        WHERE  mo.sample_id = NEW.sample_id;
    END IF;

    -- Placeholders in the client-composed code.
    IF NEW.pass_code LIKE '%{seq}%' THEN
        NEW.pass_code := replace(NEW.pass_code, '{seq}', COALESCE(NEW.operation_sequence::text, ''));
    END IF;

    IF NEW.pass_code LIKE '%{mf}%' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('manufacturing_operations.sintering_mf_counter', 0));
        SELECT COALESCE(max((substring(mo.pass_code FROM '(?:^|-)MF(\d{1,9})(?:-|$)'))::bigint), 0) + 1
        INTO   v_mf
        FROM   public.manufacturing_operations mo
        WHERE  mo.process_category = 'sintering'
          AND  mo.operation_id IS DISTINCT FROM NEW.operation_id;
        NEW.pass_code := replace(NEW.pass_code, '{mf}', v_mf::text);
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_manufacturing_operations_assign_numbers() IS
    'BEFORE INSERT / UPDATE on manufacturing_operations (UPDATE only when pass_code changes): assigns operation_sequence '
    '(max+1 per sample, serialised on the sample row) when NULL and the row is not an import (source_system IS NULL), and replaces the {seq} and {mf} placeholders '
    'in a client-composed pass_code with the operation number and the next sintering MF number '
    '(review 4.5). Replaces the d1-operation-sequence Directus hook.';

CREATE TRIGGER mfg_op_assign_numbers
    BEFORE INSERT OR UPDATE ON manufacturing_operations
    FOR EACH ROW EXECUTE FUNCTION trg_manufacturing_operations_assign_numbers();

COMMENT ON TRIGGER mfg_op_assign_numbers ON manufacturing_operations IS
    'Assigns operation_sequence and fills the {seq} / {mf} placeholders of pass_code server-side (review 4.5).';

COMMENT ON COLUMN manufacturing_operations.operation_sequence IS
    'Ordering of this operation within the sample lifecycle (1 = first). Left NULL on insert, it is '
    'assigned by the database as max+1 for the sample (not for imported rows, source_system set); '
    'a supplied value (e.g. a machining pass number) is kept.';

COMMENT ON COLUMN manufacturing_operations.pass_code IS
    'Human-readable operation code, e.g. 9-AA-MR-2023-03-23-F9 or 22-04-21-MF1-950C_11kN_20dia. '
    'The placeholders {seq} (operation_sequence) and {mf} (next sintering MF number) are replaced '
    'by the database on insert; any other value is stored as given. Not the PK.';

