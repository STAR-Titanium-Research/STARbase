-- migrate:up
-- Fixes three intake-form issues reported against the insert-box workflow:
--
-- 1. expand_tool_box_intake() computed the next box sequence number with
--    COUNT(*) scoped to insert_type_id, which (a) undercounts, and produces
--    a duplicate tool_box_code, once an earlier box in the sequence has been
--    deleted, and (b) scopes to the wrong thing: tool_box_code is unique
--    across ALL insert types, but two insert_type rows can resolve to the
--    same short_code (explicitly, or because both leave short_code blank
--    and their type_code text happens to truncate to the same 6 characters,
--    e.g. 'CNMG120408-MF' and 'CNMG120408-PM' both derive to 'CNMG12'), in
--    which case each one's independent insert_type_id-scoped counter starts
--    back at 1 and collides with the other's boxes. Switched to
--    MAX(parsed suffix) scoped by the resolved short_code prefix — the
--    actual namespace tool_box_code's uniqueness lives in — so the sequence
--    keeps advancing correctly in both cases.
-- 2. Cloned boxes (package_quantity > 1) copied the legacy `owner` column but
--    dropped `project_id` and `owner_person_id`, so every box after the first
--    in a batch lost its project and owner. Now copied through.
-- 3. project_code / campaign_code / cutting_inserts.insert_code /
--    insert_edges.edge_code are all human codes meant to be auto-generated,
--    but only tool_box_code had a fill-on-save mechanism. Directus derives a
--    field's "required" behaviour from the database column (NOT NULL with no
--    default counts as required) as well as from directus_fields.required, so
--    a BEFORE INSERT trigger alone is not enough to stop the form blocking on
--    a blank value — each column also needs a real column DEFAULT:
--      - project_code / campaign_code get a self-contained DEFAULT that
--        continues the existing plain numeric convention already used by
--        hand-entered rows (matches how they look today: "9", "10", "11").
--      - cutting_inserts.insert_code / insert_edges.edge_code can't be given
--        a self-contained DEFAULT (the real code depends on sibling columns
--        of the same row, e.g. tool_box_id, which a column DEFAULT cannot
--        see), so they get the same TMP- placeholder pattern tool_box_code
--        already uses; a BEFORE INSERT trigger then replaces the placeholder
--        with the real {parent_code}-{n} / {parent_code}{LETTER} code.
--    The insert/edge triggers also backfill owner_person_id from the
--    immediate parent when it is left blank, so new cutting_inserts and
--    insert_edges inherit the box's owner by default (cascade_ownership
--    remains for explicitly pushing an owner change down to existing
--    children).

-- ── expand_tool_box_intake: sequence-collision fix + project/owner passthrough ─
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

-- ── tool_boxes: fill placeholder code even when Directus sends an explicit
--    NULL or empty string (a column DEFAULT does not apply in that case) ──────
CREATE OR REPLACE FUNCTION fill_tool_box_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.tool_box_code IS NULL OR NEW.tool_box_code = '' THEN
        NEW.tool_box_code := 'TMP-' || uuid_generate_v4()::TEXT;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_tool_box_code_trigger ON tool_boxes;
CREATE TRIGGER fill_tool_box_code_trigger
    BEFORE INSERT ON tool_boxes
    FOR EACH ROW EXECUTE FUNCTION fill_tool_box_code();

-- cutting_inserts.insert_code can't get a self-contained column DEFAULT (the
-- real code needs the parent box's code), so give it the same TMP- sentinel
-- tool_box_code uses purely so Directus's schema introspection sees a
-- default and stops treating the field as required.
ALTER TABLE cutting_inserts
    ALTER COLUMN insert_code SET DEFAULT ('TMP-' || uuid_generate_v4()::TEXT);

-- ── cutting_inserts: auto-generate insert_code/insert_number and inherit
--    owner_person_id from the parent tool_box when left blank ────────────────
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

DROP TRIGGER IF EXISTS fill_cutting_insert_code_trigger ON cutting_inserts;
CREATE TRIGGER fill_cutting_insert_code_trigger
    BEFORE INSERT ON cutting_inserts
    FOR EACH ROW EXECUTE FUNCTION fill_cutting_insert_code();

-- insert_edges.edge_code can't get a self-contained column DEFAULT either
-- (needs the parent insert's code); same TMP- sentinel trick as above.
-- edge_identifier is also NOT NULL with no default (Directus infers
-- "required" from that regardless of directus_fields.required), so it needs
-- a blank-string default too, which the trigger below already treats as
-- "not set yet".
ALTER TABLE insert_edges
    ALTER COLUMN edge_code SET DEFAULT ('TMP-' || uuid_generate_v4()::TEXT),
    ALTER COLUMN edge_identifier SET DEFAULT '';

-- ── insert_edges: auto-generate edge_code/edge_identifier and inherit
--    owner_person_id from the parent cutting_insert when left blank ──────────
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

DROP TRIGGER IF EXISTS fill_insert_edge_code_trigger ON insert_edges;
CREATE TRIGGER fill_insert_edge_code_trigger
    BEFORE INSERT ON insert_edges
    FOR EACH ROW EXECUTE FUNCTION fill_insert_edge_code();

-- ── projects / campaigns: auto-number the code when left blank, continuing
--    the existing plain-integer convention already used by hand-entered rows.
--    Unlike the insert/edge codes above, this doesn't need sibling row data,
--    so it can be a real, self-contained column DEFAULT — which is what
--    makes Directus stop treating the field as required in the first place.
CREATE OR REPLACE FUNCTION next_project_code()
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT (COALESCE(MAX(project_code::INTEGER), 0) + 1)::TEXT
    FROM   projects
    WHERE  project_code ~ '^[0-9]+$';
$$;

ALTER TABLE projects ALTER COLUMN project_code SET DEFAULT next_project_code();

-- Trigger backstop: a DEFAULT is skipped when the client sends an explicit
-- NULL or '' rather than omitting the field.
CREATE OR REPLACE FUNCTION fill_project_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.project_code IS NULL OR NEW.project_code = '' THEN
        NEW.project_code := next_project_code();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_project_code_trigger ON projects;
CREATE TRIGGER fill_project_code_trigger
    BEFORE INSERT ON projects
    FOR EACH ROW EXECUTE FUNCTION fill_project_code();

CREATE OR REPLACE FUNCTION next_campaign_code()
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT (COALESCE(MAX(campaign_code::INTEGER), 0) + 1)::TEXT
    FROM   campaigns
    WHERE  campaign_code ~ '^[0-9]+$';
$$;

ALTER TABLE campaigns ALTER COLUMN campaign_code SET DEFAULT next_campaign_code();

CREATE OR REPLACE FUNCTION fill_campaign_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.campaign_code IS NULL OR NEW.campaign_code = '' THEN
        NEW.campaign_code := next_campaign_code();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_campaign_code_trigger ON campaigns;
CREATE TRIGGER fill_campaign_code_trigger
    BEFORE INSERT ON campaigns
    FOR EACH ROW EXECUTE FUNCTION fill_campaign_code();

-- ── Directus metadata: these codes are now auto-generated, so they no longer
--    need to block the form when left blank ──────────────────────────────────
UPDATE directus_fields
SET    required = false,
       options   = '{"placeholder":"Auto-generated on save"}'
WHERE  (collection, field) IN (
    ('projects', 'project_code'),
    ('cutting_inserts', 'insert_code'),
    ('insert_edges', 'edge_code')
);

-- Clarify that this is usable edges per insert, not a per-edge index.
UPDATE directus_fields
SET    translations = '[{"language":"en-US","translation":"Usable Edges Per Insert"}]'
WHERE  collection = 'insert_types' AND field = 'edge_count';

-- migrate:down
DROP TRIGGER IF EXISTS fill_campaign_code_trigger ON campaigns;
DROP FUNCTION IF EXISTS fill_campaign_code();
ALTER TABLE campaigns ALTER COLUMN campaign_code DROP DEFAULT;
DROP FUNCTION IF EXISTS next_campaign_code();

DROP TRIGGER IF EXISTS fill_project_code_trigger ON projects;
DROP FUNCTION IF EXISTS fill_project_code();
ALTER TABLE projects ALTER COLUMN project_code DROP DEFAULT;
DROP FUNCTION IF EXISTS next_project_code();

DROP TRIGGER IF EXISTS fill_insert_edge_code_trigger ON insert_edges;
DROP FUNCTION IF EXISTS fill_insert_edge_code();
ALTER TABLE insert_edges
    ALTER COLUMN edge_code DROP DEFAULT,
    ALTER COLUMN edge_identifier DROP DEFAULT;

DROP TRIGGER IF EXISTS fill_cutting_insert_code_trigger ON cutting_inserts;
DROP FUNCTION IF EXISTS fill_cutting_insert_code();
ALTER TABLE cutting_inserts ALTER COLUMN insert_code DROP DEFAULT;

DROP TRIGGER IF EXISTS fill_tool_box_code_trigger ON tool_boxes;
DROP FUNCTION IF EXISTS fill_tool_box_code();

UPDATE directus_fields
SET    required = true, options = NULL
WHERE  collection = 'projects' AND field = 'project_code';

UPDATE directus_fields
SET    required = true, options = NULL
WHERE  (collection, field) IN (
    ('cutting_inserts', 'insert_code'),
    ('insert_edges', 'edge_code')
);

UPDATE directus_fields
SET    translations = '[{"language":"en-US","translation":"Edge #"}]'
WHERE  collection = 'insert_types' AND field = 'edge_count';

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

    SELECT COUNT(*) INTO v_base_seq
    FROM   tool_boxes
    WHERE  insert_type_id = v_box.insert_type_id
      AND  tool_box_id   <> p_first_box_id;

    FOR v_box_seq IN 1 .. GREATEST(COALESCE(v_box.package_quantity, 1), 1) LOOP

        v_box_code := v_short_code || '-' || (v_base_seq + v_box_seq);

        IF v_box_seq = 1 THEN
            UPDATE tool_boxes
            SET    tool_box_code = v_box_code
            WHERE  tool_box_id   = p_first_box_id;
            v_box_id := p_first_box_id;
        ELSE
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
