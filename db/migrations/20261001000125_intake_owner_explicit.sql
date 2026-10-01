-- migrate:up
-- Bulk intake: the intake form's owner is the explicit choice for the whole
-- batch, so expand_tool_box_intake sets owner_person_id on every generated
-- box, insert and edge itself. The code-filling triggers stop making
-- ownership decisions (a manual insert/edge is owned by the login via the
-- d1-owner-default hook, not by its parent). The clone INSERT no longer
-- copies the legacy login-based owner column, and intakes now serialise on
-- the short_code (pg_advisory_xact_lock), not just the insert type row.

CREATE OR REPLACE FUNCTION expand_tool_box_intake(p_first_box_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_box          tool_boxes%ROWTYPE;
    v_it           insert_types%ROWTYPE;
    v_short_code   TEXT;
    v_base_seq     INTEGER;
    v_box_seq      INTEGER;
    v_box_id       UUID;
    v_box_code     TEXT;
    v_insert_id    UUID;
    v_insert_code  TEXT;
    v_edge_letters TEXT[] := ARRAY[
        'A','B','C','D','E','F','G','H','I','J',
        'K','L','M','N','O','P','Q','R','S','T'
    ];
    v_ins_num      INTEGER;
    v_edge_idx     INTEGER;
BEGIN
    SELECT * INTO v_box FROM tool_boxes WHERE tool_box_id = p_first_box_id;
    IF NOT FOUND OR v_box.insert_type_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO v_it
    FROM   insert_types
    WHERE  insert_type_id = v_box.insert_type_id
    FOR UPDATE;

    v_short_code := COALESCE(
        NULLIF(TRIM(v_it.short_code), ''),
        generate_insert_short_code(v_it.type_code)
    );
    IF v_short_code IS NULL OR v_short_code = '' THEN
        RAISE EXCEPTION 'expand_tool_box_intake: cannot derive short_code for insert_type %', v_box.insert_type_id;
    END IF;

    -- Two insert types can resolve to the same short_code, and the FOR UPDATE
    -- above only serialises intakes of the same type; lock the short_code itself
    -- so concurrent intakes can't read the same MAX and reissue a box code.
    PERFORM pg_advisory_xact_lock(hashtext(v_short_code));

    -- Highest number ever used under this short_code prefix (tool_box_code's
    -- uniqueness domain), so deleted boxes or shared prefixes never collide.
    SELECT COALESCE(MAX((regexp_match(tool_box_code, '-(\d+)$'))[1]::INTEGER), 0)
    INTO   v_base_seq
    FROM   tool_boxes
    WHERE  tool_box_code LIKE v_short_code || '-%'
      AND  tool_box_id   <> p_first_box_id;

    FOR v_box_seq IN 1 .. GREATEST(COALESCE(v_box.package_quantity, 1), 1) LOOP

        v_box_code := v_short_code || '-' || (v_base_seq + v_box_seq);

        IF v_box_seq = 1 THEN
            UPDATE tool_boxes
            SET    tool_box_code = v_box_code
            WHERE  tool_box_id   = p_first_box_id;
            v_box_id := p_first_box_id;
        ELSE
            -- package_quantity = 0 prevents the box-intake hook re-expanding clones.
            v_box_id := uuid_generate_v4();
            INSERT INTO tool_boxes (
                tool_box_id,   tool_box_code,      insert_type_id,
                description,   location,           notes,
                package_quantity, project_id,      owner_person_id
            ) VALUES (
                v_box_id,      v_box_code,         v_box.insert_type_id,
                v_box.description, v_box.location, v_box.notes,
                0,             v_box.project_id,   v_box.owner_person_id
            );
        END IF;

        FOR v_ins_num IN 1 .. GREATEST(COALESCE(v_it.inserts_per_box, 0), 0) LOOP
            v_insert_id   := uuid_generate_v4();
            v_insert_code := v_box_code || '-' || v_ins_num;

            INSERT INTO cutting_inserts (
                insert_id,      insert_code,   tool_box_id,
                insert_type_id, insert_number, owner_person_id
            ) VALUES (
                v_insert_id,          v_insert_code, v_box_id,
                v_box.insert_type_id, v_ins_num,     v_box.owner_person_id
            );

            FOR v_edge_idx IN 1 .. GREATEST(COALESCE(v_it.edge_count, 0), 0) LOOP
                INSERT INTO insert_edges (
                    edge_id,   edge_code,
                    insert_id, edge_identifier, owner_person_id
                ) VALUES (
                    uuid_generate_v4(),
                    v_insert_code || v_edge_letters[v_edge_idx],
                    v_insert_id,
                    v_edge_letters[v_edge_idx],
                    v_box.owner_person_id
                );
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION fill_cutting_insert_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_box_code TEXT;
BEGIN
    IF NEW.insert_number IS NULL THEN
        SELECT COALESCE(MAX(insert_number), 0) + 1 INTO NEW.insert_number
        FROM   cutting_inserts
        WHERE  tool_box_id = NEW.tool_box_id;
    END IF;
    IF NEW.insert_code IS NULL OR NEW.insert_code = '' OR NEW.insert_code LIKE 'TMP-%' THEN
        SELECT tool_box_code INTO v_box_code FROM tool_boxes WHERE tool_box_id = NEW.tool_box_id;
        NEW.insert_code := COALESCE(v_box_code, 'BOX') || '-' || NEW.insert_number;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fill_insert_edge_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_insert_code TEXT;
    v_edge_count  INTEGER;
BEGIN
    IF NEW.edge_identifier IS NULL OR NEW.edge_identifier = '' THEN
        SELECT COUNT(*) INTO v_edge_count FROM insert_edges WHERE insert_id = NEW.insert_id;
        NEW.edge_identifier := CHR(65 + v_edge_count);
    END IF;
    IF NEW.edge_code IS NULL OR NEW.edge_code = '' OR NEW.edge_code LIKE 'TMP-%' THEN
        SELECT insert_code INTO v_insert_code FROM cutting_inserts WHERE insert_id = NEW.insert_id;
        NEW.edge_code := COALESCE(v_insert_code, 'INS') || NEW.edge_identifier;
    END IF;
    RETURN NEW;
END;
$$;

-- migrate:down
-- Restore the migration-114 bodies (owner-from-parent branches and the legacy
-- owner column in the clone INSERT), copied verbatim.
CREATE OR REPLACE FUNCTION expand_tool_box_intake(p_first_box_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_box          tool_boxes%ROWTYPE;
    v_it           insert_types%ROWTYPE;
    v_short_code   TEXT;
    v_base_seq     INTEGER;   -- highest existing sequence number for this insert type
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

    -- Base sequence = highest box number that has ever existed under this
    -- short_code prefix (the actual collision domain tool_box_code's unique
    -- constraint lives in — see note above on why this isn't scoped to
    -- insert_type_id).
    SELECT COALESCE(MAX((regexp_match(tool_box_code, '-(\d+)$'))[1]::INTEGER), 0)
    INTO   v_base_seq
    FROM   tool_boxes
    WHERE  tool_box_code LIKE v_short_code || '-%'
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
            -- re-expanding these clone rows. project_id and owner_person_id are
            -- carried over so every box in the batch keeps the same project and
            -- owner as the box the user actually filled in.
            v_box_id := uuid_generate_v4();
            INSERT INTO tool_boxes (
                tool_box_id,   tool_box_code,         insert_type_id,
                description,   location,              owner,
                notes,         package_quantity,      project_id,
                owner_person_id
            ) VALUES (
                v_box_id,      v_box_code,            v_box.insert_type_id,
                v_box.description, v_box.location,    v_box.owner,
                v_box.notes,   0,                     v_box.project_id,
                v_box.owner_person_id
            );
        END IF;

        -- ── Cutting inserts for this box ──────────────────────────────────────
        -- owner_person_id is intentionally left out of this INSERT: the
        -- fill_cutting_insert_code BEFORE INSERT trigger backfills it from the
        -- parent tool_box whenever it is NULL, so bulk expansion and manual
        -- single-insert creation inherit ownership the same way.
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

CREATE OR REPLACE FUNCTION fill_cutting_insert_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_box_code TEXT;
BEGIN
    IF NEW.insert_number IS NULL THEN
        SELECT COALESCE(MAX(insert_number), 0) + 1 INTO NEW.insert_number
        FROM   cutting_inserts
        WHERE  tool_box_id = NEW.tool_box_id;
    END IF;

    IF NEW.insert_code IS NULL OR NEW.insert_code = '' OR NEW.insert_code LIKE 'TMP-%' THEN
        SELECT tool_box_code INTO v_box_code
        FROM   tool_boxes
        WHERE  tool_box_id = NEW.tool_box_id;
        NEW.insert_code := COALESCE(v_box_code, 'BOX') || '-' || NEW.insert_number;
    END IF;

    IF NEW.owner_person_id IS NULL THEN
        SELECT owner_person_id INTO NEW.owner_person_id
        FROM   tool_boxes
        WHERE  tool_box_id = NEW.tool_box_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fill_insert_edge_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_insert_code TEXT;
    v_edge_count  INTEGER;
BEGIN
    IF NEW.edge_identifier IS NULL OR NEW.edge_identifier = '' THEN
        SELECT COUNT(*) INTO v_edge_count
        FROM   insert_edges
        WHERE  insert_id = NEW.insert_id;
        NEW.edge_identifier := CHR(65 + v_edge_count); -- 'A' + existing count
    END IF;

    IF NEW.edge_code IS NULL OR NEW.edge_code = '' OR NEW.edge_code LIKE 'TMP-%' THEN
        SELECT insert_code INTO v_insert_code
        FROM   cutting_inserts
        WHERE  insert_id = NEW.insert_id;
        NEW.edge_code := COALESCE(v_insert_code, 'INS') || NEW.edge_identifier;
    END IF;

    IF NEW.owner_person_id IS NULL THEN
        SELECT owner_person_id INTO NEW.owner_person_id
        FROM   cutting_inserts
        WHERE  insert_id = NEW.insert_id;
    END IF;

    RETURN NEW;
END;
$$;
