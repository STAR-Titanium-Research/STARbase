-- migrate:up
-- Review finding 4.7 (part 1): move the owner cascade out of the Directus owner-cascade hook.
--
-- The hook ran after commit on items.update, with a root knex connection and up to four separate
-- statements: a failure was only logged (the API had already answered success), the statements
-- were not one transaction, and an UPDATE issued from SQL, a plugin or a script never cascaded.
-- ADR-0002 says business logic must not live in Directus config, so the rule is now a pair of
-- BEFORE UPDATE row triggers that run in the writer's own transaction (an error aborts the save
-- and reaches the caller).
--
-- Behaviour kept from the hook (core/extensions/owner-cascade/index.js, removed in the same commit):
--   * tool_boxes.cascade_ownership = TRUE on save: every cutting_insert of the box and every
--     insert_edge of those inserts gets the box's owner_person_id (the value written in the same
--     UPDATE, or the stored one if the UPDATE did not touch it; a NULL owner is propagated too);
--   * cutting_inserts.cascade_ownership = TRUE: every edge of the insert gets its owner_person_id;
--   * the flag is reset to FALSE afterwards (here: on the row being written, so no second UPDATE);
--   * only owner_person_id is propagated, never the legacy owner column.
-- Differences, both deliberate: children that already have the right owner are not rewritten, so
-- they get no pointless version bump and audit row; and an INSERT is not cascaded (the hook was
-- update-only, and a new box has no children to reach).
--
-- A row stored with cascade_ownership = TRUE (possible only through an INSERT) cascades on its
-- next UPDATE and is reset then, rather than staying armed for ever.

CREATE FUNCTION trg_tool_boxes_cascade_ownership() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE cutting_inserts
    SET    owner_person_id = NEW.owner_person_id
    WHERE  tool_box_id = NEW.tool_box_id
      AND  owner_person_id IS DISTINCT FROM NEW.owner_person_id;

    UPDATE insert_edges
    SET    owner_person_id = NEW.owner_person_id
    WHERE  insert_id IN (SELECT insert_id FROM cutting_inserts WHERE tool_box_id = NEW.tool_box_id)
      AND  owner_person_id IS DISTINCT FROM NEW.owner_person_id;

    NEW.cascade_ownership := FALSE;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_tool_boxes_cascade_ownership() IS
    'BEFORE UPDATE trigger body for tool_boxes: when cascade_ownership is TRUE, copies the box''s '
    'owner_person_id onto its cutting_inserts and their insert_edges, then resets the flag. '
    'Replaces the Directus owner-cascade hook (review 4.7).';

CREATE FUNCTION trg_cutting_inserts_cascade_ownership() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE insert_edges
    SET    owner_person_id = NEW.owner_person_id
    WHERE  insert_id = NEW.insert_id
      AND  owner_person_id IS DISTINCT FROM NEW.owner_person_id;

    NEW.cascade_ownership := FALSE;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_cutting_inserts_cascade_ownership() IS
    'BEFORE UPDATE trigger body for cutting_inserts: when cascade_ownership is TRUE, copies the '
    'insert''s owner_person_id onto its insert_edges, then resets the flag. Replaces the Directus '
    'owner-cascade hook (review 4.7).';

CREATE TRIGGER cascade_ownership_tool_boxes
    BEFORE UPDATE ON tool_boxes
    FOR EACH ROW WHEN (NEW.cascade_ownership)
    EXECUTE FUNCTION trg_tool_boxes_cascade_ownership();

CREATE TRIGGER cascade_ownership_cutting_inserts
    BEFORE UPDATE ON cutting_inserts
    FOR EACH ROW WHEN (NEW.cascade_ownership)
    EXECUTE FUNCTION trg_cutting_inserts_cascade_ownership();

COMMENT ON TRIGGER cascade_ownership_tool_boxes ON tool_boxes IS
    'Owner cascade: a save with cascade_ownership = TRUE reassigns the box''s inserts and edges to its owner_person_id.';
COMMENT ON TRIGGER cascade_ownership_cutting_inserts ON cutting_inserts IS
    'Owner cascade: a save with cascade_ownership = TRUE reassigns the insert''s edges to its owner_person_id.';

-- migrate:down
DROP TRIGGER IF EXISTS cascade_ownership_cutting_inserts ON cutting_inserts;
DROP TRIGGER IF EXISTS cascade_ownership_tool_boxes ON tool_boxes;
DROP FUNCTION IF EXISTS trg_cutting_inserts_cascade_ownership();
DROP FUNCTION IF EXISTS trg_tool_boxes_cascade_ownership();
-- The Directus owner-cascade hook is restored by reverting this commit's removal of
-- core/extensions/owner-cascade/ (git history); the schema carries nothing for it.
