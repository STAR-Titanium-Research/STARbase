-- migrate:up
-- Review finding 4.8: expand_tool_box_intake() (migration 022) had two bugs.
--
-- 1. It copied only the legacy `owner` column (a directus_users FK) onto cloned boxes and left
--    the inserts and edges it creates with no owner at all. The visible owner is
--    owner_person_id (people, migration 061), so every cloned box, insert and edge came out with
--    a NULL owner in the UI. It now copies owner_person_id and, for compatibility, owner onto the
--    cloned boxes and onto every insert and edge it creates (including box 1's).
-- 2. The batch's base sequence was COUNT(*) of the insert type's other boxes. After a box is
--    deleted the count is lower than the highest code in use, so the next intake generated a
--    code that already exists and failed on tool_boxes_code_unique. The base is now the highest
--    existing number in codes of the form '<short_code>-<n>' (any insert type: the unique
--    constraint is global), and the whole computation runs under a transaction-scoped advisory
--    lock keyed on the short code, so concurrent intakes cannot both pick the same range. The
--    old FOR UPDATE on insert_types is dropped: it serialised the same intakes but also blocked
--    unrelated edits of the type row.
--
-- 3. It was not idempotent. The function is now also called by the intake_tool_boxes trigger
--    (migration 125), while the deleted box-intake Directus hook stays loaded until Directus is
--    restarted (no auto-reload on the Windows bind mount), so during a deploy the hook calls it a
--    second time for a box the trigger has already expanded: box 1 was renamed again and a second
--    set of boxes, inserts and edges was created. The function now returns without doing anything
--    unless the box still carries its 'TMP-' placeholder code (migration 022's default), which the
--    first expansion overwrites. The comparison uses COLLATE "C": the code columns use the
--    natural_sort collation since migration 116.
--
-- Everything else is unchanged: clone boxes get package_quantity = 0 (the no-re-expansion
-- sentinel), codes follow {short_code}-{box_seq}-{insert_pos}{edge_letter}, at most 20 edges.
CREATE OR REPLACE FUNCTION expand_tool_box_intake(p_first_box_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_box          tool_boxes%ROWTYPE;
    v_it           insert_types%ROWTYPE;
    v_short_code   TEXT;
    v_prefix       TEXT;      -- '<short_code>-': what the numeric suffix is read after
    v_base_seq     INTEGER;   -- highest box number already in use for this short code
    v_box_seq      INTEGER;
    v_box_id       UUID;
    v_box_code     TEXT;
    v_insert_id    UUID;
    v_insert_code  TEXT;
    -- Supports up to 20 edges per insert (A–T). Extend if needed.
    v_edge_letters TEXT[] := ARRAY[
        'A','B','C','D','E','F','G','H','I','J',
        'K','L','M','N','O','P','Q','R','S','T'
    ];
    v_ins_num      INTEGER;
    v_edge_idx     INTEGER;
BEGIN
    -- Fetch the box that was just created.
    SELECT * INTO v_box FROM tool_boxes WHERE tool_box_id = p_first_box_id;
    IF NOT FOUND OR v_box.insert_type_id IS NULL THEN
        RETURN;  -- nothing to expand without an insert type
    END IF;
    -- Idempotence: an expanded box no longer has its placeholder code, so a second call (the old
    -- hook after the trigger, a retry) is a no-op. See the header comment, point 3.
    IF left(v_box.tool_box_code COLLATE "C", 4) IS DISTINCT FROM 'TMP-' THEN
        RETURN;
    END IF;

    SELECT * INTO v_it
    FROM   insert_types
    WHERE  insert_type_id = v_box.insert_type_id;

    -- Resolve short code: explicit field preferred, auto-derive as fallback.
    v_short_code := COALESCE(
        NULLIF(TRIM(v_it.short_code), ''),
        generate_insert_short_code(v_it.type_code)
    );
    IF v_short_code IS NULL OR v_short_code = '' THEN
        RAISE EXCEPTION 'expand_tool_box_intake: cannot derive short_code for insert_type %', v_box.insert_type_id;
    END IF;
    v_prefix := v_short_code || '-';

    -- Serialise concurrent intakes that would draw box numbers from the same range; released
    -- at the end of the transaction.
    PERFORM pg_advisory_xact_lock(hashtextextended('expand_tool_box_intake:' || v_short_code, 0));

    -- Base sequence = highest number already used in '<short_code>-<n>' box codes (not
    -- COUNT(*), which falls behind after a delete). COLLATE "C" keeps the string functions and
    -- the regex independent of the natural_sort collation on tool_box_code.
    SELECT COALESCE(MAX(substr(b.tool_box_code COLLATE "C", length(v_prefix) + 1)::INTEGER), 0)
    INTO   v_base_seq
    FROM   tool_boxes AS b
    WHERE  b.tool_box_id <> p_first_box_id
      AND  left(b.tool_box_code COLLATE "C", length(v_prefix)) = v_prefix
      AND  substr(b.tool_box_code COLLATE "C", length(v_prefix) + 1) ~ '^[0-9]{1,9}$';

    -- Create N boxes (1..package_quantity). Box 1 = the row that was just created.
    FOR v_box_seq IN 1 .. GREATEST(COALESCE(v_box.package_quantity, 1), 1) LOOP

        v_box_code := v_prefix || (v_base_seq + v_box_seq);

        IF v_box_seq = 1 THEN
            -- Overwrite the placeholder code on the first (existing) box.
            UPDATE tool_boxes
            SET    tool_box_code = v_box_code
            WHERE  tool_box_id   = p_first_box_id;
            v_box_id := p_first_box_id;

        ELSE
            -- Clone the first box's metadata into additional box rows.
            -- package_quantity = 0 is the sentinel that prevents re-expansion of these rows.
            v_box_id := uuid_generate_v4();
            INSERT INTO tool_boxes (
                tool_box_id,   tool_box_code,         insert_type_id,
                description,   location,              owner,
                owner_person_id,
                notes,         package_quantity
            ) VALUES (
                v_box_id,      v_box_code,            v_box.insert_type_id,
                v_box.description, v_box.location,    v_box.owner,
                v_box.owner_person_id,
                v_box.notes,   0
            );
        END IF;

        -- ── Cutting inserts for this box ──────────────────────────────────────
        FOR v_ins_num IN 1 .. GREATEST(COALESCE(v_it.inserts_per_box, 0), 0) LOOP
            v_insert_id   := uuid_generate_v4();
            v_insert_code := v_box_code || '-' || v_ins_num;

            INSERT INTO cutting_inserts (
                insert_id,    insert_code,   tool_box_id,
                insert_type_id, insert_number,
                owner,        owner_person_id
            ) VALUES (
                v_insert_id,  v_insert_code, v_box_id,
                v_box.insert_type_id, v_ins_num,
                v_box.owner,  v_box.owner_person_id
            );

            -- ── Edges for this insert ─────────────────────────────────────────
            FOR v_edge_idx IN 1 .. GREATEST(COALESCE(v_it.edge_count, 0), 0) LOOP
                INSERT INTO insert_edges (
                    edge_id,           edge_code,
                    insert_id,         edge_identifier,
                    owner,             owner_person_id
                ) VALUES (
                    uuid_generate_v4(),
                    v_insert_code || v_edge_letters[v_edge_idx],
                    v_insert_id,
                    v_edge_letters[v_edge_idx],
                    v_box.owner,       v_box.owner_person_id
                );
            END LOOP;

        END LOOP;

    END LOOP;
END;
$$;

COMMENT ON FUNCTION expand_tool_box_intake(UUID) IS
    'Expands a tool_box intake row (package_quantity >= 1) into package_quantity boxes plus their '
    'cutting_inserts and insert_edges, with codes {short_code}-{box_seq}-{insert_pos}{edge_letter}. '
    'Box numbers continue from the highest existing {short_code}-<n> code under an advisory lock. '
    'Cloned boxes, inserts and edges inherit the first box''s owner_person_id and owner. '
    'Idempotent: does nothing unless the box still has its TMP- placeholder code. '
    'Clone boxes receive package_quantity=0 to prevent recursive re-expansion.';

-- migrate:down
-- Restore the function and comment exactly as 20260621000022_insert_box_intake.sql defined them.
CREATE OR REPLACE FUNCTION expand_tool_box_intake(p_first_box_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_box          tool_boxes%ROWTYPE;
    v_it           insert_types%ROWTYPE;
    v_short_code   TEXT;
    v_base_seq     INTEGER;   -- boxes of this type that existed before this batch
    v_box_seq      INTEGER;
    v_box_id       UUID;
    v_box_code     TEXT;
    v_insert_id    UUID;
    v_insert_code  TEXT;
    -- Supports up to 20 edges per insert (A–T). Extend if needed.
    v_edge_letters TEXT[] := ARRAY[
        'A','B','C','D','E','F','G','H','I','J',
        'K','L','M','N','O','P','Q','R','S','T'
    ];
    v_ins_num      INTEGER;
    v_edge_idx     INTEGER;
BEGIN
    -- Fetch the box Directus just created.
    SELECT * INTO v_box FROM tool_boxes WHERE tool_box_id = p_first_box_id;
    IF NOT FOUND OR v_box.insert_type_id IS NULL THEN
        RETURN;  -- nothing to expand without an insert type
    END IF;

    -- Lock the insert_type row to serialise concurrent intakes of the same type,
    -- preventing box-sequence collisions under simultaneous writes.
    SELECT * INTO v_it
    FROM   insert_types
    WHERE  insert_type_id = v_box.insert_type_id
    FOR UPDATE;

    -- Resolve short code: explicit field preferred, auto-derive as fallback.
    v_short_code := COALESCE(
        NULLIF(TRIM(v_it.short_code), ''),
        generate_insert_short_code(v_it.type_code)
    );
    IF v_short_code IS NULL OR v_short_code = '' THEN
        RAISE EXCEPTION 'expand_tool_box_intake: cannot derive short_code for insert_type %', v_box.insert_type_id;
    END IF;

    -- Base sequence = boxes of this type that existed BEFORE this batch.
    SELECT COUNT(*) INTO v_base_seq
    FROM   tool_boxes
    WHERE  insert_type_id = v_box.insert_type_id
      AND  tool_box_id   <> p_first_box_id;

    -- Create N boxes (1..package_quantity). Box 1 = the row Directus created.
    FOR v_box_seq IN 1 .. GREATEST(COALESCE(v_box.package_quantity, 1), 1) LOOP

        v_box_code := v_short_code || '-' || (v_base_seq + v_box_seq);

        IF v_box_seq = 1 THEN
            -- Overwrite the placeholder code on the first (existing) box.
            UPDATE tool_boxes
            SET    tool_box_code = v_box_code
            WHERE  tool_box_id   = p_first_box_id;
            v_box_id := p_first_box_id;

        ELSE
            -- Clone the first box's metadata into additional box rows.
            -- package_quantity = 0 is the sentinel that prevents the hook from
            -- re-expanding these clone rows.
            v_box_id := uuid_generate_v4();
            INSERT INTO tool_boxes (
                tool_box_id,   tool_box_code,         insert_type_id,
                description,   location,              owner,
                notes,         package_quantity
            ) VALUES (
                v_box_id,      v_box_code,            v_box.insert_type_id,
                v_box.description, v_box.location,    v_box.owner,
                v_box.notes,   0
            );
        END IF;

        -- ── Cutting inserts for this box ──────────────────────────────────────
        FOR v_ins_num IN 1 .. GREATEST(COALESCE(v_it.inserts_per_box, 0), 0) LOOP
            v_insert_id   := uuid_generate_v4();
            v_insert_code := v_box_code || '-' || v_ins_num;

            INSERT INTO cutting_inserts (
                insert_id,    insert_code,   tool_box_id,
                insert_type_id, insert_number
            ) VALUES (
                v_insert_id,  v_insert_code, v_box_id,
                v_box.insert_type_id, v_ins_num
            );

            -- ── Edges for this insert ─────────────────────────────────────────
            FOR v_edge_idx IN 1 .. GREATEST(COALESCE(v_it.edge_count, 0), 0) LOOP
                INSERT INTO insert_edges (
                    edge_id,           edge_code,
                    insert_id,         edge_identifier
                ) VALUES (
                    uuid_generate_v4(),
                    v_insert_code || v_edge_letters[v_edge_idx],
                    v_insert_id,
                    v_edge_letters[v_edge_idx]
                );
            END LOOP;

        END LOOP;

    END LOOP;
END;
$$;

COMMENT ON FUNCTION expand_tool_box_intake(UUID) IS
    'Called by the Directus box-intake hook after a tool_box is created with package_quantity >= 1. '
    'Generates codes in the pattern {short_code}-{box_seq}-{insert_pos}{edge_letter} '
    'and creates all child cutting_inserts and insert_edges. '
    'Clone boxes receive package_quantity=0 to prevent recursive re-expansion.';
