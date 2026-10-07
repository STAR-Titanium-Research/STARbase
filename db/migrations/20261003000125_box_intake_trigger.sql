-- migrate:up
-- Review finding 4.7 (part 2): move the box intake out of the Directus box-intake hook.
--
-- The hook called expand_tool_box_intake(key) after commit on items.create. A failure inside the
-- function was only logged, so the API reported success for a box that never got its inserts and
-- edges (migration 113 documents one such silent abort), and boxes created from SQL, a plugin or
-- a script were never expanded. The call is now an AFTER INSERT row trigger on tool_boxes: it
-- runs in the writer's transaction, so an error (for example "cannot derive short_code") aborts
-- the insert and reaches the caller.
--
-- When it fires, matching the hook: package_quantity >= 1 (NULL = manual entry, 0 = the clone
-- sentinel expand_tool_box_intake() gives its own rows, so it never recurses).
-- One condition is added, checked inside the trigger function rather than in the WHEN clause (a
-- column named in a WHEN clause blocks ALTER COLUMN ... TYPE, which migration 116's down and up
-- do to tool_box_code and tests/phase1_schema.sh replays): tool_box_code must still be the placeholder default ('TMP-<uuid>',
-- migration 022). The intake form leaves the code blank; every other writer of tool_boxes sets a
-- real code. Without this, scripts/migrate_legacy.py (which loads the legacy inventory's
-- "Package Quantity" - the inserts in the manufacturer package, not a number of boxes - with
-- explicit codes) would have each legacy box exploded into N boxes and its code overwritten.
-- A box created with a typed code and a quantity is therefore left alone; the hook would have
-- overwritten the typed code.

CREATE FUNCTION trg_tool_boxes_intake() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    -- Only the intake form leaves the code at its placeholder default (see the header comment).
    IF left(NEW.tool_box_code COLLATE "C", 4) = 'TMP-' THEN
        PERFORM expand_tool_box_intake(NEW.tool_box_id);
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trg_tool_boxes_intake() IS
    'AFTER INSERT trigger body for tool_boxes: expands an intake form row (package_quantity >= 1, '
    'placeholder TMP- code) via expand_tool_box_intake(). Replaces the Directus box-intake hook (review 4.7).';

-- Trigger name sorts after audit_tool_boxes, so the INSERT is audited before the expansion's UPDATE.
CREATE TRIGGER intake_tool_boxes
    AFTER INSERT ON tool_boxes
    FOR EACH ROW
    WHEN (NEW.package_quantity >= 1)
    EXECUTE FUNCTION trg_tool_boxes_intake();

COMMENT ON TRIGGER intake_tool_boxes ON tool_boxes IS
    'Intake: a new box with package_quantity >= 1 and no explicit code is expanded into that many boxes with their inserts and edges.';

COMMENT ON FUNCTION expand_tool_box_intake(UUID) IS
    'Expands a tool_box intake row (package_quantity >= 1) into package_quantity boxes plus their '
    'cutting_inserts and insert_edges, with codes {short_code}-{box_seq}-{insert_pos}{edge_letter}. '
    'Box numbers continue from the highest existing {short_code}-<n> code under an advisory lock. '
    'Cloned boxes, inserts and edges inherit the first box''s owner_person_id and owner. '
    'Idempotent: does nothing unless the box still has its TMP- placeholder code. '
    'Called by the intake_tool_boxes trigger on tool_boxes. '
    'Clone boxes receive package_quantity=0 to prevent recursive re-expansion.';

-- migrate:down
DROP TRIGGER IF EXISTS intake_tool_boxes ON tool_boxes;
DROP FUNCTION IF EXISTS trg_tool_boxes_intake();
-- Back to the comment 20261003000123 set.
COMMENT ON FUNCTION expand_tool_box_intake(UUID) IS
    'Expands a tool_box intake row (package_quantity >= 1) into package_quantity boxes plus their '
    'cutting_inserts and insert_edges, with codes {short_code}-{box_seq}-{insert_pos}{edge_letter}. '
    'Box numbers continue from the highest existing {short_code}-<n> code under an advisory lock. '
    'Cloned boxes, inserts and edges inherit the first box''s owner_person_id and owner. '
    'Idempotent: does nothing unless the box still has its TMP- placeholder code. '
    'Clone boxes receive package_quantity=0 to prevent recursive re-expansion.';
-- The Directus box-intake hook is restored by reverting this commit's removal of
-- core/extensions/box-intake/ (git history); the schema carries nothing for it.
