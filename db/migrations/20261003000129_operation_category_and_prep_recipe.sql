-- migrate:up
-- Two rules about manufacturing_operations that lived in Directus and now live in Postgres.
-- (Part 2, the prep-recipe trigger, is at the end of the up section; stream I was given four
-- migration slots, so both share this file.)
--
-- Part 1 -- review finding 4.11: the process category came from a method-code map hard-coded in the
-- d1-process-category interface, a second copy of the CASE in 20260623000031_process_category.sql.
-- The copies had already diverged: the interface knew MT and MP, the SQL did not (MP, "Sample
-- Preparation", was added to the data in 20260625000036 after the SQL map was written). Worse, the
-- interface's `immediate` watcher emitted null for any code it did not know, blanking a stored
-- category when an existing operation was opened.
--
-- The map now lives in one place, the database:
--   * manufacturing_methods.process_category holds each method's category, back-filled here from the
--     union of the two old maps (MT is in the old interface map but in no seed or migration; it is
--     kept so a method with that code on a deployment keeps its category);
--   * a BEFORE trigger on manufacturing_operations fills process_category from the method when an
--     operation is inserted without one, or when its method_id changes and the same statement does
--     not set a category. A method with no category (a new method nobody mapped yet) leaves the
--     operation's own value alone -- the trigger never writes NULL over a stored value;
--   * the interface reads manufacturing_methods.process_category and only displays it (and still
--     sets the form value on a new record, because Directus field conditions that show the typed
--     parameter panels need it in the form before the first save).
--
-- No back-fill of existing manufacturing_operations rows: the down section could not tell the rows it
-- changed from the rest, and rows with a NULL category on a mapped method get one the next time their
-- method is set.

ALTER TABLE manufacturing_methods
    ADD COLUMN process_category TEXT;

ALTER TABLE manufacturing_methods
    ADD CONSTRAINT manufacturing_methods_process_category_check
    CHECK (process_category IN ('machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep'));

COMMENT ON COLUMN manufacturing_methods.process_category IS
    'Process family of operations done with this method (machining / sintering / heat_treatment / '
    'deformation / additive / sample_prep). Copied onto manufacturing_operations.process_category when '
    'an operation is created or its method changes; NULL means "not mapped", and then an operation '
    'keeps whatever category it already has.';

UPDATE manufacturing_methods
SET process_category = CASE
        WHEN method_code IN ('MC','MM','MC2','MEDM','MCO','MX','MS','MT') THEN 'machining'
        WHEN method_code IN ('MF','MHIP')                                 THEN 'sintering'
        WHEN method_code IN ('HT')                                        THEN 'heat_treatment'
        WHEN method_code IN ('MO','MR')                                   THEN 'deformation'
        WHEN method_code IN ('MAM','MW','MAE')                            THEN 'additive'
        WHEN method_code IN ('MP')                                        THEN 'sample_prep'
    END
WHERE process_category IS NULL;

CREATE FUNCTION trg_manufacturing_operations_derive_category() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_category TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.process_category IS NOT NULL THEN
            RETURN NEW;                      -- an explicit category (an import, an API client) wins
        END IF;
    ELSIF NEW.method_id IS NOT DISTINCT FROM OLD.method_id
          OR NEW.process_category IS DISTINCT FROM OLD.process_category THEN
        RETURN NEW;                          -- method unchanged, or the category was set deliberately
    END IF;

    SELECT mm.process_category INTO v_category
    FROM   public.manufacturing_methods mm
    WHERE  mm.method_id = NEW.method_id;

    IF v_category IS NOT NULL THEN
        NEW.process_category := v_category;  -- never assigns NULL over a stored value
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_manufacturing_operations_derive_category() IS
    'BEFORE INSERT / UPDATE on manufacturing_operations: sets process_category from '
    'manufacturing_methods.process_category when the operation has none, or when its method changes '
    'without a category being set in the same statement. Never writes NULL (review 4.11).';

CREATE TRIGGER mfg_op_derive_category
    BEFORE INSERT OR UPDATE ON manufacturing_operations
    FOR EACH ROW EXECUTE FUNCTION trg_manufacturing_operations_derive_category();

COMMENT ON TRIGGER mfg_op_derive_category ON manufacturing_operations IS
    'Derives process_category from the operation''s manufacturing method (review 4.11).';

-- Part 2 -- review finding 4.12: applying a prep recipe.
--
-- The d1-apply-prep-recipe hook ran after commit (an action hook with the root connection): it did
-- not check that the operation is a sample-preparation one, inserted the steps outside the write's
-- transaction, and a failure left the operation saved without its steps while the user saw success.
-- The copy is now an AFTER trigger in the writer's transaction:
--   * fires when an operation is inserted with source_recipe_id, or source_recipe_id changes to a
--     recipe (the hook acted whenever the update payload carried one);
--   * the operation must be a Sample Preparation one (process_category = 'sample_prep', which the
--     trigger above derives from the MP method); otherwise the write is rejected with an error;
--   * existing prep_steps are never clobbered (the recipe is copied only into an operation that has
--     no steps yet) and an empty recipe copies nothing -- both as before;
--   * the copies are independent rows, editable per sample without touching the recipe.
-- Any error aborts the whole save, so an operation can no longer be stored half-applied.

CREATE FUNCTION trg_manufacturing_operations_apply_prep_recipe() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.source_recipe_id IS NULL THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.source_recipe_id IS NOT DISTINCT FROM OLD.source_recipe_id THEN
        RETURN NULL;
    END IF;
    IF NEW.process_category IS DISTINCT FROM 'sample_prep' THEN
        RAISE EXCEPTION 'source_recipe_id can only be set on a Sample Preparation operation (operation % has process_category %)',
            NEW.operation_id, COALESCE(NEW.process_category, 'NULL')
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.prep_steps ps WHERE ps.operation_id = NEW.operation_id) THEN
        RETURN NULL;   -- never clobber steps that are already there
    END IF;

    INSERT INTO public.prep_steps (
        operation_id, step_order, step_type, grit, suspension_um, cloth, etchant_id,
        duration_s, force_n, rpm, temperature_c, lubricant, resin_type, notes)
    SELECT NEW.operation_id, rs.step_order, rs.step_type, rs.grit, rs.suspension_um, rs.cloth, rs.etchant_id,
           rs.duration_s, rs.force_n, rs.rpm, rs.temperature_c, rs.lubricant, rs.resin_type, rs.notes
    FROM   public.prep_recipe_steps rs
    WHERE  rs.recipe_id = NEW.source_recipe_id
    ORDER  BY rs.step_order;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trg_manufacturing_operations_apply_prep_recipe() IS
    'AFTER INSERT / UPDATE on manufacturing_operations: copies the steps of source_recipe_id into '
    'prep_steps when the operation is a Sample Preparation one with no steps yet; rejects the write '
    'for any other operation. Replaces the d1-apply-prep-recipe Directus hook (review 4.12).';

CREATE TRIGGER mfg_op_apply_prep_recipe
    AFTER INSERT OR UPDATE ON manufacturing_operations
    FOR EACH ROW EXECUTE FUNCTION trg_manufacturing_operations_apply_prep_recipe();

COMMENT ON TRIGGER mfg_op_apply_prep_recipe ON manufacturing_operations IS
    'Copies a prep recipe''s steps into the operation''s prep_steps (review 4.12).';

-- migrate:down
DROP TRIGGER IF EXISTS mfg_op_apply_prep_recipe ON manufacturing_operations;
DROP FUNCTION IF EXISTS trg_manufacturing_operations_apply_prep_recipe();
-- (Steps already copied stay: they are ordinary prep_steps rows.)
DROP TRIGGER IF EXISTS mfg_op_derive_category ON manufacturing_operations;
DROP FUNCTION IF EXISTS trg_manufacturing_operations_derive_category();
ALTER TABLE manufacturing_methods DROP CONSTRAINT IF EXISTS manufacturing_methods_process_category_check;
ALTER TABLE manufacturing_methods DROP COLUMN IF EXISTS process_category;
