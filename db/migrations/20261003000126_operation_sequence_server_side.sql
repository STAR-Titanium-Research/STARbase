-- migrate:up
-- Review finding 4.5: operation numbers and operation codes were built in the browser.
--
-- Before this migration:
--   * the d1-operation-sequence Directus hook filled operation_sequence with max+1 for the sample
--     AFTER the form had already composed pass_code, so a new heat-treatment / deformation /
--     additive operation was stored with a code that lacked its number (e.g. "5-AA-MF-...-HTA-800C"
--     instead of "...-HTA1-800C"), and nothing rewrote the code;
--   * the read-then-write was not locked, so two operations created at once on one sample got the
--     same number;
--   * the sintering counter in the interface was COUNT(sintering ops)+1, which hands out a number
--     that already exists once any earlier operation has been deleted.
-- ADR-0002 says nothing the system depends on lives in Directus, so both numbers are now assigned
-- by a BEFORE trigger on manufacturing_operations:
--
--   operation_sequence  NULL on insert and sample_id set  ->  max(operation_sequence)+1 for that
--                       sample, under a row lock on the parent physical_samples row (SELECT ...
--                       FOR NO KEY UPDATE; it does not block the foreign-key checks of other
--                       writers). A row lock rather than an advisory lock: advisory locks live in
--                       the shared lock table, and one transaction that loads the operations of
--                       ~13,000 samples exhausted it ("out of shared memory"); row locks do not.
--                       A value the caller supplies (e.g. a machining pass number) is never
--                       overwritten. Imported rows (source_system IS NOT NULL) are not numbered:
--                       importers keep the NULL semantics they had before this trigger, because
--                       they write their own numbers in a later pass (scripts/migrate_legacy.py
--                       numbers FAST runs by leaving the column NULL and the machining operations
--                       explicitly; auto-numbering the FAST rows in insertion order made the
--                       explicit numbers duplicate them). scripts/migrate_legacy.py now tags its
--                       rows source_system = 'legacy_migration'. A {seq} placeholder in the code
--                       of an imported row collapses to nothing, as for a sample-less operation.
--   pass_code           the interface still composes the readable part of the code (alloy, method,
--                       parameters; see d1-operation-code), but leaves the two database-owned
--                       numbers as placeholders that the trigger fills in:
--                         {seq}  ->  the row's operation_sequence (empty when there is none, which
--                                    is what the interface produced for a sample-less operation);
--                         {mf}   ->  the next sintering "MF" number: 1 + the highest MF number found
--                                    in the pass_code of any sintering operation, under a global
--                                    advisory lock. It is a max+1 over live codes, so a deleted
--                                    middle number is never handed out again while a higher one
--                                    exists.
--                       A pass_code without a placeholder (a typed override, an import) is stored
--                       exactly as given. The code format is unchanged.
--
-- The trigger also runs on UPDATE (and returns at once unless pass_code changed) so that
-- "regenerate" on an existing operation cannot store a raw placeholder. It is deliberately not
-- declared UPDATE OF pass_code: a column-list trigger would block ALTER COLUMN pass_code TYPE, which
-- the natural-sort collation migration's down section needs.
--
-- Deploy order: a NOT VALID CHECK on pass_code rejects a literal {seq} / {mf} (see the constraint
-- below), so an interface bundle that runs before this migration gets an error instead of
-- storing placeholder codes.
--
-- Not done here: UNIQUE(pass_code) and UNIQUE(sample_id, operation_sequence). Production may already
-- hold duplicates; that needs a data check first (see the review-fix plan, section 2).
--
-- Lock order (deadlocks): refresh_project_rollup() (migration 118) takes the rollup advisory lock in
-- the statement-level refresh trigger and holds it to commit. This BEFORE ROW trigger takes its own
-- locks (the per-sample row lock, the MF counter lock) earlier in the statement, so a transaction that
-- wrote operations for sample X and then sample Y could deadlock against one writing only Y: the
-- first holds the rollup lock and waits for Y, the second holds Y and waits for the rollup lock.
-- The trigger therefore takes the rollup lock FIRST (same key as migration 118), so the order is
-- always rollup -> sample -> MF counter (and rollup -> sample_code counter in migration 127).
-- Every operation write already queues on that lock at the end of its statement, so this adds no
-- serialisation, only moves it earlier. A transaction that locks a sample row by other means
-- (e.g. a plain UPDATE of physical_samples) before it writes an operation can still deadlock with
-- one that takes the rollup lock first; Postgres aborts one of the two with SQLSTATE 40P01.

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

-- Deploy-order guard: if the new interface bundle runs before this migration, the placeholders are
-- sent to a database with no trigger and would be stored literally. BEFORE triggers run before
-- CHECK constraints, so every valid placeholder insert is rewritten first and passes; a literal
-- {seq} or {mf} that survives is rejected. NOT VALID: rows already stored are not scanned (a row
-- that already holds a literal placeholder can no longer be updated until it is corrected).
ALTER TABLE manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_pass_code_no_placeholder_check
    CHECK (pass_code !~ '\{(seq|mf)\}') NOT VALID;

COMMENT ON CONSTRAINT manufacturing_operations_pass_code_no_placeholder_check ON manufacturing_operations IS
    'Rejects a pass_code that still contains the {seq} / {mf} placeholders after the assign-numbers trigger ran (interface deployed before the migration). Not validated against existing rows.';

COMMENT ON COLUMN manufacturing_operations.operation_sequence IS
    'Ordering of this operation within the sample lifecycle (1 = first). Left NULL on insert, it is '
    'assigned by the database as max+1 for the sample (not for imported rows, source_system set); '
    'a supplied value (e.g. a machining pass number) is kept.';

COMMENT ON COLUMN manufacturing_operations.pass_code IS
    'Human-readable operation code, e.g. 9-AA-MR-2023-03-23-F9 or 22-04-21-MF1-950C_11kN_20dia. '
    'The placeholders {seq} (operation_sequence) and {mf} (next sintering MF number) are replaced '
    'by the database on insert; any other value is stored as given. Not the PK.';

-- migrate:down
ALTER TABLE manufacturing_operations DROP CONSTRAINT IF EXISTS manufacturing_operations_pass_code_no_placeholder_check;
DROP TRIGGER IF EXISTS mfg_op_assign_numbers ON manufacturing_operations;
DROP FUNCTION IF EXISTS trg_manufacturing_operations_assign_numbers();

-- Restore the column comments exactly as 20260618000007_manufacturing_operations.sql left them.
COMMENT ON COLUMN manufacturing_operations.operation_sequence IS
    'Ordering of this operation within the sample lifecycle (1 = first).';
COMMENT ON COLUMN manufacturing_operations.pass_code IS
    'Human-readable pass identifier, e.g. 9-AA-MR-2023-03-23-F9.'
    ' Generated by generate_pass_code(). Not the PK.';
