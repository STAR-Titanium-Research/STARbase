\restrict dbmate

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: audit_trigger_function(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_trigger_function() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_row_before    JSONB;
    v_row_after     JSONB;
    v_record_id     TEXT;
    v_changed       JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_row_before := to_jsonb(OLD);
        v_row_after  := NULL;
        v_record_id  := COALESCE(
            v_row_before ->> 'sample_id',
            v_row_before ->> 'operation_id',
            v_row_before ->> 'session_id',
            v_row_before ->> 'campaign_id',
            v_row_before ->> 'lot_id',
            v_row_before ->> 'material_id',
            v_row_before ->> 'project_id',
            v_row_before ->> 'tool_box_id',
            v_row_before ->> 'insert_id',
            v_row_before ->> 'edge_id',
            v_row_before ->> 'equipment_id',
            v_row_before ->> 'tool_id',
            v_row_before ->> 'insert_type_id',
            v_row_before ->> 'method_id',
            v_row_before ->> 'parameter_id',
            v_row_before ->> 'symbol',
            v_row_before ->> 'iso_code',
            'unknown'
        );
        v_changed := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_row_before := NULL;
        v_row_after  := to_jsonb(NEW);
        v_record_id  := COALESCE(
            v_row_after ->> 'sample_id',
            v_row_after ->> 'operation_id',
            v_row_after ->> 'session_id',
            v_row_after ->> 'campaign_id',
            v_row_after ->> 'lot_id',
            v_row_after ->> 'material_id',
            v_row_after ->> 'project_id',
            v_row_after ->> 'tool_box_id',
            v_row_after ->> 'insert_id',
            v_row_after ->> 'edge_id',
            v_row_after ->> 'equipment_id',
            v_row_after ->> 'tool_id',
            v_row_after ->> 'insert_type_id',
            v_row_after ->> 'method_id',
            v_row_after ->> 'parameter_id',
            v_row_after ->> 'symbol',
            v_row_after ->> 'iso_code',
            'unknown'
        );
        v_changed := NULL;
    ELSE
        v_row_before := to_jsonb(OLD);
        v_row_after  := to_jsonb(NEW);
        v_record_id  := COALESCE(
            v_row_after ->> 'sample_id',
            v_row_after ->> 'operation_id',
            v_row_after ->> 'session_id',
            v_row_after ->> 'campaign_id',
            v_row_after ->> 'lot_id',
            v_row_after ->> 'material_id',
            v_row_after ->> 'project_id',
            v_row_after ->> 'tool_box_id',
            v_row_after ->> 'insert_id',
            v_row_after ->> 'edge_id',
            v_row_after ->> 'equipment_id',
            v_row_after ->> 'tool_id',
            v_row_after ->> 'insert_type_id',
            v_row_after ->> 'method_id',
            v_row_after ->> 'parameter_id',
            v_row_after ->> 'symbol',
            v_row_after ->> 'iso_code',
            'unknown'
        );
        SELECT jsonb_object_agg(
            k,
            jsonb_build_object('old', v_row_before -> k, 'new', v_row_after -> k)
        )
        INTO v_changed
        FROM jsonb_each(v_row_after) AS t (k, v)
        WHERE (v_row_before -> k) IS DISTINCT FROM (v_row_after -> k);
    END IF;

    INSERT INTO audit_logs (
        table_name, record_id, action_type, actor_identity,
        row_before, row_after, changed_fields
    ) VALUES (
        TG_TABLE_NAME, v_record_id, TG_OP,
        current_setting('d1.actor_identity', TRUE),
        v_row_before, v_row_after, v_changed
    );

    RETURN NEW;
END;
$$;


--
-- Name: diag_requeue_on_recipe_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.diag_requeue_on_recipe_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.diag_recipe IS DISTINCT FROM OLD.diag_recipe
       OR NEW.tool_setup_id IS DISTINCT FROM OLD.tool_setup_id THEN
        NEW.diag_status := 'pending';
        NEW.diag_requested_at := now();
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: expand_tool_box_intake(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expand_tool_box_intake(p_first_box_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: FUNCTION expand_tool_box_intake(p_first_box_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.expand_tool_box_intake(p_first_box_id uuid) IS 'Called by the Directus box-intake hook after a tool_box is created with package_quantity >= 1. Generates codes in the pattern {short_code}-{box_seq}-{insert_pos}{edge_letter} and creates all child cutting_inserts and insert_edges. Clone boxes receive package_quantity=0 to prevent recursive re-expansion.';


--
-- Name: f_sample_timeline(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_sample_timeline(p_sample_id uuid) RETURNS TABLE(event_date timestamp with time zone, event_type text, event_id uuid, label text, detail jsonb)
    LANGUAGE sql STABLE
    AS $$
    SELECT
        mo.operation_date            AS event_date,
        'manufacturing_operation'    AS event_type,
        mo.operation_id              AS event_id,
        mo.pass_code::TEXT           AS label,
        jsonb_build_object(
            'method_id', mo.method_id,
            'sequence', mo.operation_sequence,
            'operator', mo.operator_name
        )                            AS detail
    FROM manufacturing_operations AS mo
    WHERE mo.sample_id = p_sample_id

    UNION ALL

    SELECT
        ts.session_date,
        'test_session',
        ts.session_id,
        ts.test_type,
        jsonb_build_object(
            'status', ts.status,
            'file_storage_pointer', ts.file_storage_pointer
        )
    FROM test_sessions AS ts
    WHERE ts.sample_id = p_sample_id

    ORDER BY event_date ASC NULLS LAST;
$$;


--
-- Name: FUNCTION f_sample_timeline(p_sample_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.f_sample_timeline(p_sample_id uuid) IS 'Chronological cradle-to-grave event stream (manufacturing operations + test sessions) for a single sample, ordered by date.';


--
-- Name: f_trace_ancestors(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_trace_ancestors(p_sample_id uuid) RETURNS TABLE(depth integer, sample_id uuid, sample_code text, form text, relationship_type text, fraction numeric, path uuid[])
    LANGUAGE sql STABLE
    AS $$
    WITH RECURSIVE up AS (
        SELECT
            0                       AS depth,
            ps.sample_id,
            ps.sample_code::TEXT    AS sample_code,
            ps.form,
            NULL::TEXT              AS relationship_type,
            NULL::NUMERIC           AS fraction,
            ARRAY[ps.sample_id]     AS path
        FROM physical_samples AS ps
        WHERE ps.sample_id = p_sample_id

        UNION ALL

        SELECT
            up.depth + 1,
            parent.sample_id,
            parent.sample_code::TEXT,
            parent.form,
            sg.relationship_type,
            sg.fraction,
            up.path || parent.sample_id
        FROM up
        INNER JOIN sample_genealogy AS sg ON sg.child_sample_id = up.sample_id
        INNER JOIN physical_samples AS parent
            ON parent.sample_id = sg.parent_sample_id
        WHERE NOT (parent.sample_id = ANY (up.path))
    )
    SELECT depth, sample_id, sample_code, form, relationship_type, fraction, path
    FROM up;
$$;


--
-- Name: FUNCTION f_trace_ancestors(p_sample_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.f_trace_ancestors(p_sample_id uuid) IS 'Reverse traceability: every ancestor of a sample (depth 0 = the sample itself), walking child→parent through sample_genealogy. Cycle-guarded.';


--
-- Name: f_trace_descendants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_trace_descendants(p_sample_id uuid) RETURNS TABLE(depth integer, sample_id uuid, sample_code text, form text, relationship_type text, fraction numeric, path uuid[])
    LANGUAGE sql STABLE
    AS $$
    WITH RECURSIVE down AS (
        SELECT
            0                       AS depth,
            ps.sample_id,
            ps.sample_code::TEXT    AS sample_code,
            ps.form,
            NULL::TEXT              AS relationship_type,
            NULL::NUMERIC           AS fraction,
            ARRAY[ps.sample_id]     AS path
        FROM physical_samples AS ps
        WHERE ps.sample_id = p_sample_id

        UNION ALL

        SELECT
            down.depth + 1,
            child.sample_id,
            child.sample_code::TEXT,
            child.form,
            sg.relationship_type,
            sg.fraction,
            down.path || child.sample_id
        FROM down
        INNER JOIN sample_genealogy AS sg ON sg.parent_sample_id = down.sample_id
        INNER JOIN physical_samples AS child
            ON child.sample_id = sg.child_sample_id
        WHERE NOT (child.sample_id = ANY (down.path))
    )
    SELECT depth, sample_id, sample_code, form, relationship_type, fraction, path
    FROM down;
$$;


--
-- Name: FUNCTION f_trace_descendants(p_sample_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.f_trace_descendants(p_sample_id uuid) IS 'Forward traceability: every descendant of a sample (depth 0 = the sample itself), walking parent→child through sample_genealogy. Cycle-guarded.';


--
-- Name: f_trace_stock_origins(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.f_trace_stock_origins(p_sample_id uuid) RETURNS TABLE(via_sample_id uuid, via_sample_code text, depth integer, lot_id uuid, lot_code text, stock_type text, supplier_name text, mass_used_grams numeric)
    LANGUAGE sql STABLE
    AS $$
    SELECT
        a.sample_id          AS via_sample_id,
        a.sample_code        AS via_sample_code,
        a.depth,
        rsl.lot_id,
        rsl.lot_code::TEXT   AS lot_code,
        rsl.stock_type,
        rsl.supplier_name,
        ssp.mass_used_grams
    FROM f_trace_ancestors(p_sample_id) AS a
    INNER JOIN sample_stock_provenance AS ssp ON ssp.sample_id = a.sample_id
    INNER JOIN raw_stock_lots AS rsl ON rsl.lot_id = ssp.lot_id;
$$;


--
-- Name: FUNCTION f_trace_stock_origins(p_sample_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.f_trace_stock_origins(p_sample_id uuid) IS 'Full reverse traceability to raw material: every raw_stock_lot feeding a sample or any of its ancestors, with the ancestor it entered through.';


--
-- Name: fill_campaign_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_campaign_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.campaign_code IS NULL OR NEW.campaign_code = '' THEN
        NEW.campaign_code := next_campaign_code();
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fill_cutting_insert_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_cutting_insert_code() RETURNS trigger
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


--
-- Name: fill_insert_edge_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_insert_edge_code() RETURNS trigger
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


--
-- Name: fill_project_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_project_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.project_code IS NULL OR NEW.project_code = '' THEN
        NEW.project_code := next_project_code();
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fill_tool_box_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_tool_box_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.tool_box_code IS NULL OR NEW.tool_box_code = '' THEN
        NEW.tool_box_code := 'TMP-' || uuid_generate_v4()::TEXT;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: generate_force_file_id(text, numeric, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_force_file_id(p_pass_code text, p_cutting_speed_m_per_min numeric, p_feed_mm_per_rev numeric, p_depth_of_cut_mm numeric) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    SELECT
        p_pass_code
        || '-' || p_cutting_speed_m_per_min::TEXT || 'MPM'
        || '_' || p_feed_mm_per_rev::TEXT || 'feed'
        || '_' || p_depth_of_cut_mm::TEXT || 'DoC'
$$;


--
-- Name: FUNCTION generate_force_file_id(p_pass_code text, p_cutting_speed_m_per_min numeric, p_feed_mm_per_rev numeric, p_depth_of_cut_mm numeric); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.generate_force_file_id(p_pass_code text, p_cutting_speed_m_per_min numeric, p_feed_mm_per_rev numeric, p_depth_of_cut_mm numeric) IS 'Generates the force-file human-readable ID from pass parameters. Pattern: {pass_code}-{Vc}MPM_{feed}feed_{DoC}DoC. The MinIO object key is built from this ID; it is regenerable from the operation row.';


--
-- Name: generate_insert_short_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_insert_short_code(p_type_code text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    SELECT LEFT(REGEXP_REPLACE(p_type_code, '[^A-Za-z0-9]', '', 'g'), 6)
$$;


--
-- Name: FUNCTION generate_insert_short_code(p_type_code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.generate_insert_short_code(p_type_code text) IS 'Strips non-alphanumeric chars from p_type_code and returns the first 6 characters. Used as a fallback when insert_types.short_code is not set.';


--
-- Name: generate_pass_code(text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_pass_code(p_sample_code text, p_pass_type text, p_pass_number integer) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    SELECT p_sample_code || '-' || p_pass_type || p_pass_number::TEXT
$$;


--
-- Name: FUNCTION generate_pass_code(p_sample_code text, p_pass_type text, p_pass_number integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.generate_pass_code(p_sample_code text, p_pass_type text, p_pass_number integer) IS 'Generates the machining-pass pseudonym. Pattern: {sample_code}-{pass_type}{n}. Pass types: F=facing, R=roughing. E.g. generate_pass_code(''9-AA-MR-2023-03-23'', ''F'', 9) → 9-AA-MR-2023-03-23-F9.';


--
-- Name: generate_sample_code(integer, text, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_sample_code(p_sequence integer, p_alloy_code text, p_method_code text, p_manufactured_date date) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    SELECT
        p_sequence::TEXT
        || '-' || p_alloy_code
        || '-' || p_method_code
        || '-' || TO_CHAR(p_manufactured_date, 'YYYY-MM-DD')
$$;


--
-- Name: FUNCTION generate_sample_code(p_sequence integer, p_alloy_code text, p_method_code text, p_manufactured_date date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.generate_sample_code(p_sequence integer, p_alloy_code text, p_method_code text, p_manufactured_date date) IS 'Generates the human-readable sample pseudonym. Pattern: {seq}-{alloy_code}-{method_code}-{YYYY-MM-DD}. E.g. generate_sample_code(10, ''AA'', ''MF'', ''2023-06-03'') → 10-AA-MF-2023-06-03.';


--
-- Name: mfg_op_link_genealogy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mfg_op_link_genealogy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: next_campaign_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_campaign_code() RETURNS text
    LANGUAGE sql
    AS $_$
    SELECT (COALESCE(MAX(campaign_code::INTEGER), 0) + 1)::TEXT
    FROM   campaigns
    WHERE  campaign_code ~ '^[0-9]+$';
$_$;


--
-- Name: next_project_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_project_code() RETURNS text
    LANGUAGE sql
    AS $_$
    SELECT (COALESCE(MAX(project_code::INTEGER), 0) + 1)::TEXT
    FROM   projects
    WHERE  project_code ~ '^[0-9]+$';
$_$;


--
-- Name: occ_update_trigger_function(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.occ_update_trigger_function() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.version    := OLD.version + 1;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;


--
-- Name: refresh_project_rollup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_project_rollup() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id)
    SELECT row_id, project_id, kind, code, detail, campaign_id FROM v_project_rollup;
END;
$$;


--
-- Name: trg_refresh_project_rollup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_refresh_project_rollup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM refresh_project_rollup();
    RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Machine_Operators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Machine_Operators" (
    id integer NOT NULL,
    "Name" character varying(255),
    equipment uuid,
    photo uuid,
    user_id uuid
);


--
-- Name: Machine_Operators_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."Machine_Operators_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: Machine_Operators_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."Machine_Operators_id_seq" OWNED BY public."Machine_Operators".id;


--
-- Name: alloying_elements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alloying_elements (
    symbol character varying(4) NOT NULL,
    element_name text NOT NULL,
    atomic_number integer NOT NULL,
    atomic_weight numeric(10,4),
    density_g_per_cm3 numeric(10,4),
    melting_point_k numeric(10,2),
    boiling_point_k numeric(10,2),
    electronegativity numeric(6,3),
    atomic_radius_pm numeric(8,2)
);


--
-- Name: TABLE alloying_elements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.alloying_elements IS 'Periodic-table reference for elements used in alloy compositions.';


--
-- Name: COLUMN alloying_elements.symbol; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.symbol IS 'Chemical symbol, e.g. Ti, Al, V. Primary key.';


--
-- Name: COLUMN alloying_elements.element_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.element_name IS 'Full element name, e.g. Titanium.';


--
-- Name: COLUMN alloying_elements.atomic_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.atomic_number IS 'Atomic number (Z). Unique.';


--
-- Name: COLUMN alloying_elements.atomic_weight; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.atomic_weight IS 'Standard atomic weight (g/mol).';


--
-- Name: COLUMN alloying_elements.density_g_per_cm3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.density_g_per_cm3 IS 'Elemental density at STP (g/cm³).';


--
-- Name: COLUMN alloying_elements.melting_point_k; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.melting_point_k IS 'Melting point in Kelvin.';


--
-- Name: COLUMN alloying_elements.boiling_point_k; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.boiling_point_k IS 'Boiling point in Kelvin.';


--
-- Name: COLUMN alloying_elements.electronegativity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.electronegativity IS 'Pauling electronegativity.';


--
-- Name: COLUMN alloying_elements.atomic_radius_pm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.alloying_elements.atomic_radius_pm IS 'Atomic radius in picometres.';


--
-- Name: archive_metadata_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.archive_metadata_edits (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    directus_files_id uuid,
    archive_path text NOT NULL,
    field_path text NOT NULL,
    old_value text,
    new_value text NOT NULL,
    reason text,
    edited_by text,
    edited_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE archive_metadata_edits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.archive_metadata_edits IS 'Audit trail of in-place corrections made to metadata fields inside archive files (e.g. stale SampleName in a .mat capture). The archive itself has no version history, so this table is the only record of what changed.';


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    log_id bigint NOT NULL,
    event_timestamp timestamp with time zone DEFAULT now() NOT NULL,
    table_name text NOT NULL,
    record_id text NOT NULL,
    action_type text NOT NULL,
    actor_identity text,
    row_before jsonb,
    row_after jsonb,
    changed_fields jsonb,
    CONSTRAINT audit_logs_action_type_check CHECK ((action_type = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])))
);


--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_logs IS 'Append-only immutable audit trail. Every INSERT/UPDATE/DELETE on a core table produces one row here via the audit_trigger_function trigger.';


--
-- Name: COLUMN audit_logs.record_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.record_id IS 'Primary-key value of the affected row, cast to TEXT for portability.';


--
-- Name: COLUMN audit_logs.actor_identity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.actor_identity IS 'User ID or machine-token identity, set via SET LOCAL d1.actor_identity.';


--
-- Name: COLUMN audit_logs.row_before; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.row_before IS 'Full row state before the mutation (NULL for INSERT).';


--
-- Name: COLUMN audit_logs.row_after; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.row_after IS 'Full row state after the mutation (NULL for DELETE).';


--
-- Name: COLUMN audit_logs.changed_fields; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_logs.changed_fields IS 'For UPDATE: JSONB object keyed by column with {old, new} sub-objects.';


--
-- Name: audit_logs_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_log_id_seq OWNED BY public.audit_logs.log_id;


--
-- Name: campaign_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_samples (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    campaign_id uuid NOT NULL,
    sample_id uuid NOT NULL
);


--
-- Name: TABLE campaign_samples; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.campaign_samples IS 'M2M junction: which physical samples belong to a campaign (a sample may span many campaigns).';


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    campaign_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    project_id uuid,
    campaign_type text NOT NULL,
    campaign_code text DEFAULT ''::text,
    name text NOT NULL,
    owner uuid,
    default_equipment_id uuid,
    default_material_id uuid,
    start_date date,
    end_date date,
    status text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    owner_person_id uuid,
    CONSTRAINT campaigns_campaign_type_check CHECK ((campaign_type = ANY (ARRAY['machining_trial'::text, 'testing_campaign'::text])))
);


--
-- Name: TABLE campaigns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.campaigns IS 'Optional grouping under a project: machining trial (operations) or testing campaign (sessions).';


--
-- Name: cutting_inserts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cutting_inserts (
    insert_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    insert_code character varying(64) DEFAULT ''::character varying NOT NULL,
    tool_box_id uuid NOT NULL,
    insert_type_id uuid,
    insert_number integer,
    is_depleted boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    location text,
    owner uuid,
    cascade_ownership boolean DEFAULT false NOT NULL,
    owner_person_id uuid
);


--
-- Name: TABLE cutting_inserts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cutting_inserts IS 'Parent level of the tooling hierarchy. One physical insert with N edges. insert_code is the human-readable pseudonym (e.g. H13A-#2).';


--
-- Name: COLUMN cutting_inserts.insert_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cutting_inserts.insert_code IS 'Human-readable code: type-insert# (e.g. H13A-#2). Unique. Never the PK.';


--
-- Name: COLUMN cutting_inserts.insert_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cutting_inserts.insert_number IS 'Sequential number of this insert within its tool_box.';


--
-- Name: COLUMN cutting_inserts.is_depleted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cutting_inserts.is_depleted IS 'TRUE when all edges of this insert have been consumed.';


--
-- Name: COLUMN cutting_inserts.location; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cutting_inserts.location IS 'Physical storage location of this insert.';


--
-- Name: COLUMN cutting_inserts.owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cutting_inserts.owner IS 'Owner / responsible person for this insert.';


--
-- Name: diag_layer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diag_layer (
    layer_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    analysis_id uuid NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    geometry jsonb NOT NULL,
    value jsonb,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT diag_layer_role_ck CHECK ((role = ANY (ARRAY['mask'::text, 'label'::text, 'seed'::text])))
);


--
-- Name: diag_recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diag_recipes (
    recipe_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying(128) NOT NULL,
    recipe jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE diag_recipes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.diag_recipes IS 'Named diagnostics recipe library; applying one copies its document onto machining_force_analysis.diag_recipe.';


--
-- Name: directus_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_access (
    id uuid NOT NULL,
    role uuid,
    "user" uuid,
    policy uuid NOT NULL,
    sort integer
);


--
-- Name: directus_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_activity (
    id integer NOT NULL,
    action character varying(45) NOT NULL,
    "user" uuid,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip character varying(50),
    user_agent text,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    origin character varying(255)
);


--
-- Name: directus_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_activity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_activity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_activity_id_seq OWNED BY public.directus_activity.id;


--
-- Name: directus_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_collections (
    collection character varying(64) NOT NULL,
    icon character varying(64),
    note text,
    display_template character varying(255),
    hidden boolean DEFAULT false NOT NULL,
    singleton boolean DEFAULT false NOT NULL,
    translations json,
    archive_field character varying(64),
    archive_app_filter boolean DEFAULT true NOT NULL,
    archive_value character varying(255),
    unarchive_value character varying(255),
    sort_field character varying(64),
    accountability character varying(255) DEFAULT 'all'::character varying,
    color character varying(255),
    item_duplication_fields json,
    sort integer,
    "group" character varying(64),
    collapse character varying(255) DEFAULT 'open'::character varying NOT NULL,
    preview_url character varying(255),
    versioning boolean DEFAULT false NOT NULL
);


--
-- Name: directus_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_comments (
    id uuid NOT NULL,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    comment text NOT NULL,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    date_updated timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    user_updated uuid
);


--
-- Name: directus_dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_dashboards (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    icon character varying(64) DEFAULT 'dashboard'::character varying NOT NULL,
    note text,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    color character varying(255)
);


--
-- Name: directus_deployment_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_deployment_projects (
    id uuid NOT NULL,
    deployment uuid NOT NULL,
    external_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    url character varying(255),
    framework character varying(255),
    deployable boolean DEFAULT true NOT NULL
);


--
-- Name: directus_deployment_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_deployment_runs (
    id uuid NOT NULL,
    project uuid NOT NULL,
    external_id character varying(255) NOT NULL,
    target character varying(255) NOT NULL,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    status character varying(255),
    url character varying(255),
    started_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: directus_deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_deployments (
    id uuid NOT NULL,
    provider character varying(255) NOT NULL,
    credentials text,
    options text,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    webhook_ids json,
    webhook_secret character varying(255),
    last_synced_at timestamp with time zone
);


--
-- Name: directus_extensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_extensions (
    enabled boolean DEFAULT true NOT NULL,
    id uuid NOT NULL,
    folder character varying(255) NOT NULL,
    source character varying(255) NOT NULL,
    bundle uuid
);


--
-- Name: directus_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_fields (
    id integer NOT NULL,
    collection character varying(64) NOT NULL,
    field character varying(64) NOT NULL,
    special character varying(64),
    interface character varying(64),
    options json,
    display character varying(64),
    display_options json,
    readonly boolean DEFAULT false NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    sort integer,
    width character varying(30) DEFAULT 'full'::character varying,
    translations json,
    note text,
    conditions json,
    required boolean DEFAULT false,
    "group" character varying(64),
    validation json,
    validation_message text,
    searchable boolean DEFAULT true NOT NULL
);


--
-- Name: directus_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_fields_id_seq OWNED BY public.directus_fields.id;


--
-- Name: directus_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_files (
    id uuid NOT NULL,
    storage character varying(255) NOT NULL,
    filename_disk character varying(255),
    filename_download character varying(255) NOT NULL,
    title character varying(255),
    type character varying(255),
    folder uuid,
    uploaded_by uuid,
    created_on timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    modified_by uuid,
    modified_on timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    charset character varying(50),
    filesize bigint,
    width integer,
    height integer,
    duration integer,
    embed character varying(200),
    description text,
    location text,
    tags text,
    metadata json,
    focal_point_x integer,
    focal_point_y integer,
    tus_id character varying(64),
    tus_data json,
    uploaded_on timestamp with time zone
);


--
-- Name: directus_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_flows (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    icon character varying(64),
    color character varying(255),
    description text,
    status character varying(255) DEFAULT 'active'::character varying NOT NULL,
    trigger character varying(255),
    accountability character varying(255) DEFAULT 'all'::character varying,
    options json,
    operation uuid,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid
);


--
-- Name: directus_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_folders (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    parent uuid
);


--
-- Name: directus_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_migrations (
    version character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: directus_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_notifications (
    id integer NOT NULL,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    status character varying(255) DEFAULT 'inbox'::character varying,
    recipient uuid NOT NULL,
    sender uuid,
    subject character varying(255) NOT NULL,
    message text,
    collection character varying(64),
    item character varying(255)
);


--
-- Name: directus_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_notifications_id_seq OWNED BY public.directus_notifications.id;


--
-- Name: directus_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_operations (
    id uuid NOT NULL,
    name character varying(255),
    key character varying(255) NOT NULL,
    type character varying(255) NOT NULL,
    position_x integer NOT NULL,
    position_y integer NOT NULL,
    options json,
    resolve uuid,
    reject uuid,
    flow uuid NOT NULL,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid
);


--
-- Name: directus_panels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_panels (
    id uuid NOT NULL,
    dashboard uuid NOT NULL,
    name character varying(255),
    icon character varying(64) DEFAULT NULL::character varying,
    color character varying(10),
    show_header boolean DEFAULT false NOT NULL,
    note text,
    type character varying(255) NOT NULL,
    position_x integer NOT NULL,
    position_y integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    options json,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid
);


--
-- Name: directus_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_permissions (
    id integer NOT NULL,
    collection character varying(64) NOT NULL,
    action character varying(10) NOT NULL,
    permissions json,
    validation json,
    presets json,
    fields text,
    policy uuid NOT NULL
);


--
-- Name: directus_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_permissions_id_seq OWNED BY public.directus_permissions.id;


--
-- Name: directus_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_policies (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    icon character varying(64) DEFAULT 'badge'::character varying NOT NULL,
    description text,
    ip_access text,
    enforce_tfa boolean DEFAULT false NOT NULL,
    admin_access boolean DEFAULT false NOT NULL,
    app_access boolean DEFAULT false NOT NULL
);


--
-- Name: directus_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_presets (
    id integer NOT NULL,
    bookmark character varying(255),
    "user" uuid,
    role uuid,
    collection character varying(64),
    search character varying(100),
    layout character varying(100) DEFAULT 'tabular'::character varying,
    layout_query json,
    layout_options json,
    refresh_interval integer,
    filter json,
    icon character varying(64) DEFAULT 'bookmark'::character varying,
    color character varying(255)
);


--
-- Name: directus_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_presets_id_seq OWNED BY public.directus_presets.id;


--
-- Name: directus_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_relations (
    id integer NOT NULL,
    many_collection character varying(64) NOT NULL,
    many_field character varying(64) NOT NULL,
    one_collection character varying(64),
    one_field character varying(64),
    one_collection_field character varying(64),
    one_allowed_collections text,
    junction_field character varying(64),
    sort_field character varying(64),
    one_deselect_action character varying(255) DEFAULT 'nullify'::character varying NOT NULL
);


--
-- Name: directus_relations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_relations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_relations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_relations_id_seq OWNED BY public.directus_relations.id;


--
-- Name: directus_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_revisions (
    id integer NOT NULL,
    activity integer NOT NULL,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    data json,
    delta json,
    parent integer,
    version uuid
);


--
-- Name: directus_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_revisions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_revisions_id_seq OWNED BY public.directus_revisions.id;


--
-- Name: directus_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_roles (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    icon character varying(64) DEFAULT 'supervised_user_circle'::character varying NOT NULL,
    description text,
    parent uuid
);


--
-- Name: directus_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_sessions (
    token character varying(64) NOT NULL,
    "user" uuid,
    expires timestamp with time zone NOT NULL,
    ip character varying(255),
    user_agent text,
    share uuid,
    origin character varying(255),
    next_token character varying(64)
);


--
-- Name: directus_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_settings (
    id integer NOT NULL,
    project_name character varying(100) DEFAULT 'Directus'::character varying NOT NULL,
    project_url character varying(255),
    project_color character varying(255) DEFAULT '#6644FF'::character varying NOT NULL,
    project_logo uuid,
    public_foreground uuid,
    public_background uuid,
    public_note text,
    auth_login_attempts integer DEFAULT 25,
    auth_password_policy character varying(100),
    storage_asset_transform character varying(7) DEFAULT 'all'::character varying,
    storage_asset_presets json,
    custom_css text,
    storage_default_folder uuid,
    basemaps json,
    mapbox_key character varying(255),
    module_bar json,
    project_descriptor character varying(100),
    default_language character varying(255) DEFAULT 'en-US'::character varying NOT NULL,
    custom_aspect_ratios json,
    public_favicon uuid,
    default_appearance character varying(255) DEFAULT 'auto'::character varying NOT NULL,
    default_theme_light character varying(255),
    theme_light_overrides json,
    default_theme_dark character varying(255),
    theme_dark_overrides json,
    report_error_url character varying(255),
    report_bug_url character varying(255),
    report_feature_url character varying(255),
    public_registration boolean DEFAULT false NOT NULL,
    public_registration_verify_email boolean DEFAULT true NOT NULL,
    public_registration_role uuid,
    public_registration_email_filter json,
    visual_editor_urls json,
    project_id uuid,
    mcp_enabled boolean DEFAULT false NOT NULL,
    mcp_allow_deletes boolean DEFAULT false NOT NULL,
    mcp_prompts_collection character varying(255) DEFAULT NULL::character varying,
    mcp_system_prompt_enabled boolean DEFAULT true NOT NULL,
    mcp_system_prompt text,
    project_owner character varying(255),
    project_usage character varying(255),
    org_name character varying(255),
    product_updates boolean,
    project_status character varying(255),
    ai_openai_api_key text,
    ai_anthropic_api_key text,
    ai_system_prompt text,
    ai_google_api_key text,
    ai_openai_compatible_api_key text,
    ai_openai_compatible_base_url text,
    ai_openai_compatible_name text,
    ai_openai_compatible_models json,
    ai_openai_compatible_headers json,
    ai_openai_allowed_models json,
    ai_anthropic_allowed_models json,
    ai_google_allowed_models json,
    collaborative_editing_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: directus_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.directus_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: directus_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.directus_settings_id_seq OWNED BY public.directus_settings.id;


--
-- Name: directus_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_shares (
    id uuid NOT NULL,
    name character varying(255),
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    role uuid,
    password character varying(255),
    user_created uuid,
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    date_start timestamp with time zone,
    date_end timestamp with time zone,
    times_used integer DEFAULT 0,
    max_uses integer
);


--
-- Name: directus_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_translations (
    id uuid NOT NULL,
    language character varying(255) NOT NULL,
    key character varying(255) NOT NULL,
    value text NOT NULL
);


--
-- Name: directus_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_users (
    id uuid NOT NULL,
    first_name character varying(50),
    last_name character varying(50),
    email character varying(128),
    password character varying(255),
    location character varying(255),
    title character varying(50),
    description text,
    tags json,
    avatar uuid,
    language character varying(255) DEFAULT NULL::character varying,
    tfa_secret character varying(255),
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    role uuid,
    token character varying(255),
    last_access timestamp with time zone,
    last_page character varying(255),
    provider character varying(128) DEFAULT 'default'::character varying NOT NULL,
    external_identifier character varying(255),
    auth_data json,
    email_notifications boolean DEFAULT true,
    appearance character varying(255),
    theme_dark character varying(255),
    theme_light character varying(255),
    theme_light_overrides json,
    theme_dark_overrides json,
    text_direction character varying(255) DEFAULT 'auto'::character varying NOT NULL
);


--
-- Name: directus_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.directus_versions (
    id uuid NOT NULL,
    key character varying(64) NOT NULL,
    name character varying(255),
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL,
    hash character varying(255),
    date_created timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    date_updated timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_created uuid,
    user_updated uuid,
    delta json
);


--
-- Name: equipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment (
    equipment_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    equipment_code character varying(64) NOT NULL,
    equipment_name text NOT NULL,
    equipment_type text NOT NULL,
    location text,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    manufacturer text,
    project_id uuid,
    capabilities text,
    image uuid,
    manufacturer_id uuid,
    facility_id uuid,
    image_url text
);


--
-- Name: TABLE equipment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.equipment IS 'Physical machines and rigs used in manufacturing and testing.';


--
-- Name: COLUMN equipment.equipment_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.equipment.equipment_code IS 'Short identifier, e.g. NLX-2500. Unique.';


--
-- Name: COLUMN equipment.equipment_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.equipment.equipment_type IS 'Category, e.g. CNC_Lathe, FAST_Press, SEM, Hardness_Tester.';


--
-- Name: COLUMN equipment.manufacturer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.equipment.manufacturer IS 'Machine/equipment manufacturer name.';


--
-- Name: COLUMN equipment.image; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.equipment.image IS 'Photo of the machine (Directus File Library / MinIO). URL imports are downloaded for offline viewing.';


--
-- Name: COLUMN equipment.facility_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.equipment.facility_id IS 'Lab / centre that houses this machine. Drives the tiered facility -> machine picker.';


--
-- Name: COLUMN equipment.image_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.equipment.image_url IS 'URL of an externally-sourced photo of the machine (manufacturer/facility page). The `image` file field is for uploaded photos.';


--
-- Name: etchants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.etchants (
    etchant_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    composition text,
    suited_metals text,
    notes text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    owner_person_id uuid
);


--
-- Name: TABLE etchants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.etchants IS 'Extensible list of metallographic etchants used in sample preparation.';


--
-- Name: facilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facilities (
    facility_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    code character varying(16) NOT NULL,
    notes text
);


--
-- Name: TABLE facilities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.facilities IS 'Physical labs / centres that house equipment. Used to group and filter the machine picker.';


--
-- Name: COLUMN facilities.code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.facilities.code IS 'Short unique facility code, e.g. SORBY, RDC, RTC, METLAB, MECHLAB.';


--
-- Name: fast_log_qa_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fast_log_qa_backup (
    id bigint NOT NULL,
    operation_id uuid,
    operation_date timestamp with time zone,
    recipe text,
    batch text,
    max_temp_celsius numeric,
    max_force_kn numeric,
    coshh_ref text,
    ptc_top_celsius numeric,
    ptc_bot_celsius numeric,
    mass_grams numeric,
    mould_diameter_mm numeric,
    outcome_notes text,
    backed_up_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fast_log_qa_backup_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fast_log_qa_backup_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fast_log_qa_backup_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fast_log_qa_backup_id_seq OWNED BY public.fast_log_qa_backup.id;


--
-- Name: fast_recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fast_recipes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    machine character varying(8) NOT NULL,
    program_nr integer,
    name text NOT NULL,
    group_name text,
    source_file text,
    target_temp_c numeric,
    target_force_kn numeric,
    hold_time_min numeric,
    params jsonb,
    date_created timestamp with time zone,
    date_changed timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fast_recipes_machine_chk CHECK (((machine)::text = ANY ((ARRAY['25'::character varying, '250'::character varying])::text[])))
);


--
-- Name: TABLE fast_recipes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fast_recipes IS 'FAST sintering recipe definitions (ECS_Prog.mdb::Rezept for 25, PROGS/*.rcp for 250).';


--
-- Name: fast_run_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fast_run_data (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    operation_id uuid NOT NULL,
    directus_files_id uuid,
    staged_file uuid,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    error_message text,
    machine_format character varying(8),
    import_archive_path text,
    plant text,
    recipe text,
    run_start timestamp with time zone,
    n_rows integer,
    duration_s numeric,
    series jsonb,
    summary jsonb,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fast_run_data_status_chk CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'done'::character varying, 'error'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: TABLE fast_run_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.fast_run_data IS 'Normalised FAST sintering trace per operation (canonical CSV + series catalog + run metadata). Populated by scripts/fast_orchestrator.py.';


--
-- Name: COLUMN fast_run_data.staged_file; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fast_run_data.staged_file IS 'Raw browser-uploaded CSV awaiting host normalisation (deleted after processing).';


--
-- Name: COLUMN fast_run_data.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fast_run_data.status IS 'Import work-queue: pending -> processing -> done | error | skipped.';


--
-- Name: COLUMN fast_run_data.import_archive_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.fast_run_data.import_archive_path IS 'Archive path to read+normalise on the host (host-only access).';


--
-- Name: filter_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    chain jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE filter_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.filter_profiles IS 'Named FRM filter-chain library; applying a profile copies its chain onto an operation.';


--
-- Name: force_crawler_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.force_crawler_state (
    id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
    desired_state character varying(16) DEFAULT 'paused'::character varying NOT NULL,
    workers integer DEFAULT 2 NOT NULL,
    throttle_seconds numeric DEFAULT 5 NOT NULL,
    file_like text,
    op_code_like text,
    daemon_pid integer,
    daemon_started_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    current_activity text,
    processed_count integer DEFAULT 0 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    last_discover_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    series_points integer DEFAULT 3000 NOT NULL,
    fft_points integer DEFAULT 3000 NOT NULL,
    frm_downsample_step integer DEFAULT 5 NOT NULL,
    frm_dpi integer DEFAULT 300 NOT NULL,
    live_cache_points integer DEFAULT 250000 NOT NULL,
    pulses_per_rev integer DEFAULT 1 NOT NULL,
    grid_density integer DEFAULT 2048 NOT NULL,
    grid_method text DEFAULT 'splat'::text NOT NULL,
    octree_threshold integer,
    octree_min_node_px real DEFAULT 1 NOT NULL,
    octree_budget_cap integer DEFAULT 25000000 NOT NULL,
    grid_pregen boolean DEFAULT false NOT NULL,
    CONSTRAINT force_crawler_state_desired_chk CHECK (((desired_state)::text = ANY ((ARRAY['running'::character varying, 'paused'::character varying])::text[]))),
    CONSTRAINT force_crawler_state_singleton CHECK ((id = '00000000-0000-0000-0000-000000000001'::uuid))
);


--
-- Name: TABLE force_crawler_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.force_crawler_state IS 'Singleton control+status row for the host-side force-crawler daemon. Admin edits desired_state/workers/throttle/scope; the daemon (scripts/force_orchestrator.py --daemon) reads it live and reports heartbeat/activity back.';


--
-- Name: COLUMN force_crawler_state.series_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.series_points IS 'Points per downsampled force/RPM envelope (series.json).';


--
-- Name: COLUMN force_crawler_state.fft_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.fft_points IS 'Points per FFT spectrum, spread across the full 0..Nyquist range.';


--
-- Name: COLUMN force_crawler_state.frm_downsample_step; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.frm_downsample_step IS 'FRM point-cloud stride: keeps every Nth sample (data(1:N:end)) — 1 = full density, higher = sparser/faster.';


--
-- Name: COLUMN force_crawler_state.frm_dpi; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.frm_dpi IS 'exportgraphics Resolution for the FRM PNGs.';


--
-- Name: COLUMN force_crawler_state.live_cache_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.live_cache_points IS 'Target points per axis in live_cache.bin (the browser Live-mode point cloud). Larger = finer signal/FRM but bigger download.';


--
-- Name: COLUMN force_crawler_state.pulses_per_rev; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.pulses_per_rev IS 'Global default tacho pulses-per-revolution for tachorpm (PulsesPerRev). Overridable per-row via machining_force_analysis.pulses_per_rev.';


--
-- Name: COLUMN force_crawler_state.grid_density; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.grid_density IS 'Interpolated-grid resolution N (N×N cells); capped at 8192.';


--
-- Name: COLUMN force_crawler_state.grid_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.grid_method IS 'Grid interpolation: splat (Gaussian, GPU) or natural (Delaunay).';


--
-- Name: COLUMN force_crawler_state.octree_threshold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.octree_threshold IS 'Auto-route to the octree view above this many points.';


--
-- Name: COLUMN force_crawler_state.octree_min_node_px; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.octree_min_node_px IS 'Potree LOD: min projected node size (px) before culling.';


--
-- Name: COLUMN force_crawler_state.octree_budget_cap; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.octree_budget_cap IS 'Potree point-budget hard cap (GPU safety).';


--
-- Name: COLUMN force_crawler_state.grid_pregen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.force_crawler_state.grid_pregen IS 'Pre-build the interpolated-grid octree during the crawl for ops above octree_threshold (heavier; off by default).';


--
-- Name: insert_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insert_edges (
    edge_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    edge_code character varying(64) DEFAULT ''::character varying NOT NULL,
    insert_id uuid NOT NULL,
    edge_identifier character varying(16) DEFAULT ''::character varying NOT NULL,
    is_used boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    owner uuid,
    owner_person_id uuid
);


--
-- Name: TABLE insert_edges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.insert_edges IS 'Child level of the tooling hierarchy. Each physical cutting point on an insert. edge_code is the human-readable pseudonym (e.g. H13A-#2-fC).';


--
-- Name: COLUMN insert_edges.edge_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_edges.edge_code IS 'Human-readable code: type-insert#-edge (e.g. H13A-#2-fC). Unique.';


--
-- Name: COLUMN insert_edges.edge_identifier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_edges.edge_identifier IS 'Single edge label within the insert, e.g. A, B, fC, fA. Not globally unique.';


--
-- Name: COLUMN insert_edges.is_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_edges.is_used IS 'TRUE once this edge has been consumed by a machining pass.';


--
-- Name: insert_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insert_types (
    insert_type_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type_code character varying(64) NOT NULL,
    manufacturer text,
    iso_designation text,
    substrate text,
    coating text,
    geometry_notes text,
    datasheet_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    op_type text,
    mounting_style_code text,
    inserts_per_box integer,
    edge_count integer,
    nose_radius_mm numeric(8,3),
    cutting_edge_length_mm numeric(8,3),
    included_angle_deg numeric(8,3),
    fixing_hole_diameter_mm numeric(8,3),
    material_class text,
    short_code character varying(16),
    image uuid,
    manufacturer_id uuid
);


--
-- Name: TABLE insert_types; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.insert_types IS 'Cutting-insert catalogue: grades, coatings, geometries (e.g. Sandvik CNMG).';


--
-- Name: COLUMN insert_types.type_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.type_code IS 'Manufacturer part or grade code. Unique.';


--
-- Name: COLUMN insert_types.substrate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.substrate IS 'Insert material: carbide, PCBN, PCD, ceramic, etc.';


--
-- Name: COLUMN insert_types.op_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.op_type IS 'Primary operation type, e.g. Roughing, Finishing, Semi-Finishing.';


--
-- Name: COLUMN insert_types.mounting_style_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.mounting_style_code IS 'Insert fixing/clamping style code (IFS), e.g. P, M, S.';


--
-- Name: COLUMN insert_types.inserts_per_box; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.inserts_per_box IS 'Standard box quantity from manufacturer.';


--
-- Name: COLUMN insert_types.edge_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.edge_count IS 'Number of usable cutting edges per insert.';


--
-- Name: COLUMN insert_types.nose_radius_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.nose_radius_mm IS 'Corner/nose radius RE in millimetres.';


--
-- Name: COLUMN insert_types.cutting_edge_length_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.cutting_edge_length_mm IS 'Cutting edge length L in millimetres.';


--
-- Name: COLUMN insert_types.included_angle_deg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.included_angle_deg IS 'Included/relief angle ESPR in degrees.';


--
-- Name: COLUMN insert_types.fixing_hole_diameter_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.fixing_hole_diameter_mm IS 'Fixing hole diameter in millimetres, if applicable.';


--
-- Name: COLUMN insert_types.material_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.material_class IS 'ISO 513 TMC1 material classification code, e.g. P, M, K, S.';


--
-- Name: COLUMN insert_types.short_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.short_code IS 'Short 4-8 char prefix used in auto-generated box/insert/edge codes (e.g. CCMT09). Auto-derived from type_code on first intake if left blank. Two types may not share the same short_code.';


--
-- Name: COLUMN insert_types.image; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.insert_types.image IS 'Photo of the insert type (Directus File Library / MinIO).';


--
-- Name: machining_force_analysis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.machining_force_analysis (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    operation_id uuid NOT NULL,
    directus_files_id uuid NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    fingerprint text,
    error_message text,
    file_version numeric,
    sample_rate integer,
    feed numeric,
    cut_diameter numeric,
    surface_speed numeric,
    depth_of_cut numeric,
    max_rpm numeric,
    dyno_gain numeric,
    n_raw bigint,
    cut_start_idx bigint,
    cut_end_idx bigint,
    peak_fx numeric,
    peak_fy numeric,
    peak_fz numeric,
    mean_rpm numeric,
    series jsonb,
    fft jsonb,
    matlab_version text,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    frm_fx uuid,
    frm_fy uuid,
    frm_fz uuid,
    trigger_time timestamp with time zone,
    live_cache_file uuid,
    live_render_points integer,
    pulses_per_rev integer,
    render_status text,
    render_bounds jsonb,
    render_axis text,
    render_colormap text,
    render_cmin numeric,
    render_cmax numeric,
    render_file uuid,
    render_error text,
    render_requested_at timestamp with time zone,
    octree_status text,
    octree_path text,
    octree_points bigint,
    octree_error text,
    octree_requested_at timestamp with time zone,
    grid_octree_status text,
    grid_octree_path text,
    grid_octree_points bigint,
    grid_octree_error text,
    grid_octree_requested_at timestamp with time zone,
    grid_fidelity real,
    grid_arm_ratio real,
    grid_cell_mm real,
    inner_diameter real DEFAULT 0 NOT NULL,
    outer_diameter real,
    filter_chain jsonb,
    filter_baked boolean DEFAULT false NOT NULL,
    crop_start_idx_override bigint,
    crop_end_idx_override bigint,
    diag_status text,
    diag_path text,
    diag_points bigint,
    diag_error text,
    diag_requested_at timestamp with time zone,
    diag_version integer,
    diag_metrics jsonb,
    tool_setup_id uuid,
    diag_recipe jsonb,
    diag_recipe_hash text,
    doctor_dismissed jsonb,
    CONSTRAINT machining_force_analysis_status_chk CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'done'::character varying, 'error'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: TABLE machining_force_analysis; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.machining_force_analysis IS 'ABFPA-faithful force-analysis results per machining .mat file (FRM fingerprint, force envelopes, spectra, cut metrics). Populated read-only by scripts/force_orchestrator.py.';


--
-- Name: COLUMN machining_force_analysis.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.status IS 'Work-queue state: pending -> processing -> done | error | skipped.';


--
-- Name: COLUMN machining_force_analysis.dyno_gain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.dyno_gain IS 'Dynamometer gain (N/V) stored in the file metadata. A value of 1 means the capture was effectively uncalibrated.';


--
-- Name: COLUMN machining_force_analysis.trigger_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.trigger_time IS 'metadata.TriggerTime read from the source .mat file, when present (the actual recording time, not the DB row creation time).';


--
-- Name: COLUMN machining_force_analysis.live_render_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.live_render_points IS 'Client render request: desired live_cache.bin point count (1 = full 1:1). Consumed and cleared by the host orchestrator.';


--
-- Name: COLUMN machining_force_analysis.pulses_per_rev; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.pulses_per_rev IS 'Tacho pulses-per-revolution actually used to produce this row''s current PNGs/metrics. NULL = never processed under this feature yet.';


--
-- Name: COLUMN machining_force_analysis.inner_diameter; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.inner_diameter IS 'Inner diameter (mm) for donut/diaphragm discs; 0 = solid disc (spiral runs to radius 0).';


--
-- Name: COLUMN machining_force_analysis.outer_diameter; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.outer_diameter IS 'Outer (cut) diameter override in mm; NULL/0 = use the .mat metadata CutDiameter.';


--
-- Name: COLUMN machining_force_analysis.filter_chain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.filter_chain IS 'Active signal-filter chain (despike/detrend/lowpass/notch JSON); NULL = raw. Baked into all derived outputs on reprocess.';


--
-- Name: COLUMN machining_force_analysis.filter_baked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.filter_baked IS 'True once every derived output (Lite cache, Full octree, FRM PNGs) has been reprocessed with filter_chain. False = light apply (chain saved; Lite recomputes live; other outputs still raw).';


--
-- Name: COLUMN machining_force_analysis.crop_start_idx_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.crop_start_idx_override IS 'Human-corrected cut-start sample index; NULL = follow the derived cut_start_idx. Wins over the derived value in the viewer and on replay.';


--
-- Name: COLUMN machining_force_analysis.crop_end_idx_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.crop_end_idx_override IS 'Human-corrected cut-end sample index; NULL = follow the derived cut_end_idx.';


--
-- Name: COLUMN machining_force_analysis.tool_setup_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.tool_setup_id IS 'Optional link to the tool_setup that supplies this cut''s mount_deg and h_matrix for the diagnostics pipeline. NULL means the pipeline uses the mount_deg=0.0/no-correction defaults, unchanged from Phases 1-5.';


--
-- Name: COLUMN machining_force_analysis.diag_recipe; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.diag_recipe IS 'The recipe this cut''s diagnostics were built from. NULL means the built-in default (scripts/diag/recipe.py DEFAULT_RECIPE).';


--
-- Name: COLUMN machining_force_analysis.diag_recipe_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.diag_recipe_hash IS 'Identity of the recipe the CURRENT diag artifacts were baked from. Staleness has two independent axes: diag_version tracks code changes, this tracks configuration changes. A baked artifact is reusable only when both match.';


--
-- Name: COLUMN machining_force_analysis.doctor_dismissed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.machining_force_analysis.doctor_dismissed IS 'Metadata Doctor dismissals, keyed by check id: {"<checkId>":{"sig","at","by"}}. A dismissal only suppresses a finding whose recomputed signature still matches, so it lapses when the compared values change.';


--
-- Name: manufacturers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manufacturers (
    manufacturer_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    notes text,
    "Logo" uuid
);


--
-- Name: manufacturing_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manufacturing_methods (
    method_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    method_code character varying(8) NOT NULL,
    method_name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: TABLE manufacturing_methods; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.manufacturing_methods IS 'Catalogue of physical-transformation process types, e.g. FAST/SPS, Turning.';


--
-- Name: COLUMN manufacturing_methods.method_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_methods.method_code IS 'Short code used in sample_code generation, e.g. MF=FAST, MO=Forged, MR=Rolled.';


--
-- Name: manufacturing_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.manufacturing_operations (
    operation_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sample_id uuid,
    method_id uuid NOT NULL,
    project_id uuid,
    equipment_id uuid,
    tool_id uuid,
    insert_edge_id uuid,
    operator_name text,
    operation_sequence integer,
    pass_code character varying(128),
    operation_date timestamp with time zone,
    recorded_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    capture_software text,
    capture_frequency_khz numeric(10,4),
    file_storage_pointer text,
    force_file_id text,
    nc_program_text text,
    nc_program_file_uri text,
    outcome_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    operator integer,
    process_category text,
    machining_operation_subtype text,
    machining_spindle_speed_rpm numeric(8,2),
    machining_cutting_speed_m_per_min numeric(8,3),
    machining_feed_mm_per_rev numeric(8,4),
    machining_axial_depth_of_cut_mm numeric(8,4),
    machining_radial_depth_of_cut_mm numeric(8,4),
    machining_cutting_length_mm numeric(8,2),
    machining_workpiece_diameter_mm numeric(8,3),
    machining_new_edge boolean,
    machining_coolant_used boolean,
    machining_coolant_pressure_bar numeric(6,2),
    machining_tacho_used boolean,
    machining_force_captured boolean,
    machining_chips_collected boolean,
    machining_chips_ref_code text,
    machining_experiment_sheet_url text,
    machining_legacy_insert_edge_id text,
    machining_legacy_machining_uid text,
    sintering_recipe_number text,
    sintering_batch_number text,
    sintering_mould_diameter_mm numeric(8,3),
    sintering_atmosphere text,
    sintering_tc_pyro_control text,
    sintering_max_temp_celsius numeric(8,2),
    sintering_max_force_kn numeric(8,3),
    sintering_voltage_at_max_t_v numeric(8,3),
    sintering_power_at_max_t_kw numeric(8,3),
    sintering_ptc_top_celsius numeric(8,2),
    sintering_ptc_bot_celsius numeric(8,2),
    sintering_coshh_ref text,
    sintering_material_type_note text,
    ht_treatment_type text,
    ht_atmosphere text,
    ht_peak_temp_celsius numeric(8,2),
    ht_hold_time_min numeric(8,2),
    ht_heating_rate_c_per_min numeric(8,3),
    ht_cooling_method text,
    ht_cooling_rate_c_per_min numeric(8,3),
    ht_quench_medium text,
    deform_deformation_type text,
    deform_deformation_temp_celsius numeric(8,2),
    deform_pass_count integer,
    deform_total_reduction_pct numeric(6,2),
    deform_reduction_per_pass_pct numeric(6,2),
    deform_strain_rate_per_sec numeric(10,4),
    deform_roll_speed_m_per_min numeric(8,3),
    deform_lubricant text,
    am_process_variant text,
    am_layer_thickness_mm numeric(8,4),
    am_laser_power_w numeric(8,2),
    am_scan_speed_mm_per_s numeric(8,2),
    am_hatch_spacing_mm numeric(8,4),
    am_energy_density_j_per_mm3 numeric(10,4),
    am_build_atmosphere text,
    am_preheat_temp_celsius numeric(8,2),
    owner uuid,
    output_sample_id uuid,
    source_recipe_id uuid,
    gcode_file uuid,
    source_run_uid text,
    source_system text,
    sintering_mass_grams numeric(10,3),
    material_id uuid,
    campaign_id uuid,
    owner_person_id uuid,
    operator_person_id uuid,
    code_sort text GENERATED ALWAYS AS ((lpad(COALESCE((regexp_match((pass_code)::text, '^\d+'::text))[1], ''::text), 8, '0'::text) || regexp_replace((COALESCE(pass_code, ''::character varying))::text, '^\d+'::text, ''::text))) STORED,
    fast_recipe_id uuid,
    CONSTRAINT manufacturing_operations_has_sample CHECK (((sample_id IS NOT NULL) OR (output_sample_id IS NOT NULL) OR (source_system IS NOT NULL))),
    CONSTRAINT manufacturing_operations_process_category_check CHECK ((process_category = ANY (ARRAY['machining'::text, 'sintering'::text, 'heat_treatment'::text, 'deformation'::text, 'additive'::text, 'sample_prep'::text])))
);


--
-- Name: TABLE manufacturing_operations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.manufacturing_operations IS 'Unified operation log for all manufacturing steps on a sample. Replaces separate FAST Runs and Machining Operations sheets. Method-specific fields are stored in recorded_metadata JSONB.';


--
-- Name: COLUMN manufacturing_operations.sample_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.sample_id IS 'Input sample / workpiece consumed or acted on (machining, FAST-embed). NULL for purely generative steps (additive from powder).';


--
-- Name: COLUMN manufacturing_operations.method_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.method_id IS 'The manufacturing method used, e.g. FAST, Turning. FK to manufacturing_methods.';


--
-- Name: COLUMN manufacturing_operations.operation_sequence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.operation_sequence IS 'Ordering of this operation within the sample lifecycle (1 = first).';


--
-- Name: COLUMN manufacturing_operations.pass_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.pass_code IS 'Human-readable pass identifier, e.g. 9-AA-MR-2023-03-23-F9. Generated by generate_pass_code(). Not the PK.';


--
-- Name: COLUMN manufacturing_operations.recorded_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.recorded_metadata IS 'JSONB bag of method-specific parameters. Keys are defined in method_parameters. E.g. {"peak_temperature_celsius": 1100, "atmosphere": "Argon"} for FAST.';


--
-- Name: COLUMN manufacturing_operations.capture_software; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.capture_software IS 'Data-capture app and version, e.g. MATLAB ABFP 0.18. Needed to parse force files.';


--
-- Name: COLUMN manufacturing_operations.capture_frequency_khz; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.capture_frequency_khz IS 'Sampling frequency in kilohertz, e.g. 25.6. Needed to interpret force files.';


--
-- Name: COLUMN manufacturing_operations.file_storage_pointer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.file_storage_pointer IS 'MinIO URI of the raw data file for this operation, if one was captured.';


--
-- Name: COLUMN manufacturing_operations.force_file_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.force_file_id IS 'Human-readable force-file ID (e.g. 9-AA-MR-2023-03-23-F9-20MPM_0.05feed_0.1DoC). Generated by generate_force_file_id(). Maps to the MinIO object key.';


--
-- Name: COLUMN manufacturing_operations.nc_program_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.nc_program_text IS 'Inline NC/G-code program text for machining passes.';


--
-- Name: COLUMN manufacturing_operations.nc_program_file_uri; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.nc_program_file_uri IS 'MinIO URI for the G-code file if stored as an artifact.';


--
-- Name: COLUMN manufacturing_operations.process_category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.process_category IS 'Process family that selects the typed parameter panel in the UI (machining / sintering / heat_treatment / deformation / additive).';


--
-- Name: COLUMN manufacturing_operations.owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.owner IS 'Researcher who owns this operation (defaults to the creating user; editable). Distinct from operator_name (the technician who ran it).';


--
-- Name: COLUMN manufacturing_operations.output_sample_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.output_sample_id IS 'New sample produced by this operation (additive, FAST). NULL when the step only modifies the input in place (machining).';


--
-- Name: COLUMN manufacturing_operations.source_recipe_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.manufacturing_operations.source_recipe_id IS 'Prep recipe this operation was pre-filled from (steps are copied into prep_steps, then editable).';


--
-- Name: material_alloying_elements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_alloying_elements (
    material_id uuid NOT NULL,
    symbol character varying(4) NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    weight_percent numeric(6,3),
    CONSTRAINT material_alloying_elements_weight_percent_check CHECK (((weight_percent IS NULL) OR ((weight_percent >= (0)::numeric) AND (weight_percent <= (100)::numeric))))
);


--
-- Name: TABLE material_alloying_elements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.material_alloying_elements IS 'M2M: elemental composition of each alloy (mirrors AppSheet Alloy Codes.Alloying Elements EnumList).';


--
-- Name: material_iso_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_iso_classifications (
    iso_code character varying(4) NOT NULL,
    description text NOT NULL,
    colour_hex character varying(7)
);


--
-- Name: TABLE material_iso_classifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.material_iso_classifications IS 'ISO 513 material-group codes (P, M, K, N, S, H) for cutting-tool selection.';


--
-- Name: COLUMN material_iso_classifications.iso_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.material_iso_classifications.iso_code IS 'Single-letter ISO group code, e.g. P, M, K, N, S, H.';


--
-- Name: COLUMN material_iso_classifications.colour_hex; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.material_iso_classifications.colour_hex IS 'ISO-assigned colour for the group, e.g. #0066CC for P (blue).';


--
-- Name: materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.materials (
    material_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    alloy_code character varying(32) NOT NULL,
    common_name text NOT NULL,
    iso_code character varying(4),
    density_g_per_cm3 numeric(8,4),
    export_controlled boolean DEFAULT false NOT NULL,
    datasheet_url text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE materials; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.materials IS 'Alloy/material catalogue. alloy_code (e.g. AA = Ti-6Al-4V) is the human-readable key used in sample codes.';


--
-- Name: COLUMN materials.alloy_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.materials.alloy_code IS 'Short code used in sample_code generation, e.g. AA for Ti-6Al-4V.';


--
-- Name: COLUMN materials.common_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.materials.common_name IS 'Human-readable material name, e.g. Ti-6Al-4V Grade 5.';


--
-- Name: COLUMN materials.density_g_per_cm3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.materials.density_g_per_cm3 IS 'Theoretical density in grams per cubic centimetre.';


--
-- Name: COLUMN materials.export_controlled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.materials.export_controlled IS 'TRUE if subject to ITAR/ECJU export controls. Drives RBAC visibility.';


--
-- Name: operation_data_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operation_data_files (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    operation_id uuid NOT NULL,
    directus_files_id uuid NOT NULL
);


--
-- Name: operation_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operation_files (
    file_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    operation_id uuid NOT NULL,
    file_path text NOT NULL,
    file_name text,
    file_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE operation_files; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.operation_files IS 'External file links (network-share paths) attached to a manufacturing operation.';


--
-- Name: people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people (
    person_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    full_name text NOT NULL,
    email text,
    user_id uuid,
    is_operator boolean DEFAULT false NOT NULL,
    is_researcher boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    notes text,
    legacy_machine_operator_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE people; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.people IS 'Unified identity for anyone attributed on a record (operator, researcher, owner). Optionally linked to a Directus login via user_id; pure technicians have none.';


--
-- Name: COLUMN people.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.people.user_id IS 'Directus login, if this person is an app user. NULL for operators without an account.';


--
-- Name: COLUMN people.legacy_machine_operator_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.people.legacy_machine_operator_id IS 'Source Machine_Operators.id, kept so operator FKs can be remapped and for provenance.';


--
-- Name: physical_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.physical_samples (
    sample_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sample_code character varying(64) NOT NULL,
    material_id uuid,
    project_id uuid,
    form text,
    mass_grams numeric(12,4),
    diameter_mm numeric(10,4),
    length_mm numeric(10,4),
    thickness_mm numeric(10,4),
    current_status text DEFAULT 'active'::text NOT NULL,
    manufactured_date date,
    export_controlled boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    nickname text,
    location text,
    surface_finish text,
    legacy_notes text,
    width_mm numeric(10,4),
    owner uuid,
    manufacturing_route text,
    mounted boolean,
    mounting_method text,
    item_type text,
    stock_category text,
    primary_method_id uuid,
    owner_person_id uuid,
    gauge_length_mm numeric(8,3),
    gauge_width_mm numeric(8,3),
    code_sort text GENERATED ALWAYS AS ((lpad(COALESCE((regexp_match((sample_code)::text, '^\d+'::text))[1], ''::text), 8, '0'::text) || regexp_replace((COALESCE(sample_code, ''::character varying))::text, '^\d+'::text, ''::text))) STORED,
    CONSTRAINT physical_samples_item_type_check CHECK ((item_type = ANY (ARRAY['sample'::text, 'equipment'::text, 'miscellaneous'::text]))),
    CONSTRAINT physical_samples_status_check CHECK ((current_status = ANY (ARRAY['active'::text, 'consumed'::text, 'destroyed'::text, 'archived'::text]))),
    CONSTRAINT physical_samples_stock_category_check CHECK ((stock_category = ANY (ARRAY['bulk'::text, 'powder'::text, 'specialty'::text])))
);


--
-- Name: TABLE physical_samples; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.physical_samples IS 'The central entity: every physical sample created in the lab. sample_id is the durable hidden PK; sample_code is the human-readable label.';


--
-- Name: COLUMN physical_samples.sample_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.sample_id IS 'UUID primary key. All foreign keys in other tables point here. Never changes.';


--
-- Name: COLUMN physical_samples.sample_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.sample_code IS 'Human-readable pseudonym, e.g. 10-AA-MF-2023-06-03. Generated by generate_sample_code(). Unique-constrained. NOT the primary key.';


--
-- Name: COLUMN physical_samples.form; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.form IS 'Physical form, e.g. disc, billet, powder-compact, coupon.';


--
-- Name: COLUMN physical_samples.mass_grams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.mass_grams IS 'Current mass of the sample in grams.';


--
-- Name: COLUMN physical_samples.diameter_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.diameter_mm IS 'Outer diameter in millimetres, if applicable.';


--
-- Name: COLUMN physical_samples.length_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.length_mm IS 'Length in millimetres, if applicable.';


--
-- Name: COLUMN physical_samples.thickness_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.thickness_mm IS 'Thickness in millimetres, if applicable.';


--
-- Name: COLUMN physical_samples.current_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.current_status IS 'Lifecycle state: active | consumed | destroyed | archived.';


--
-- Name: COLUMN physical_samples.export_controlled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.export_controlled IS 'TRUE if subject to ITAR/ECJU controls. May be inherited from material or project.';


--
-- Name: COLUMN physical_samples.nickname; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.nickname IS 'Informal human label for the sample (e.g. "FAST Control", "UD Rolled Control").';


--
-- Name: COLUMN physical_samples.location; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.location IS 'Physical storage location of the sample.';


--
-- Name: COLUMN physical_samples.surface_finish; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.surface_finish IS 'Surface finish state, e.g. Mirror, Machined, As-sintered.';


--
-- Name: COLUMN physical_samples.legacy_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.legacy_notes IS 'Free-text notes carried over verbatim from the legacy AppSheet Inventory sheet.';


--
-- Name: COLUMN physical_samples.width_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.width_mm IS 'Width in millimetres (x dimension), if applicable.';


--
-- Name: COLUMN physical_samples.owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.owner IS 'Primary owner / responsible person for this sample.';


--
-- Name: COLUMN physical_samples.manufacturing_route; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.manufacturing_route IS 'Free-text manufacturing route label from legacy AppSheet (e.g. FAST, Rolled, Cast).';


--
-- Name: COLUMN physical_samples.mounted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.mounted IS 'TRUE if the sample has been mounted in resin or a holder.';


--
-- Name: COLUMN physical_samples.mounting_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.mounting_method IS 'Mounting method used, e.g. Hot Press, Cold Mount.';


--
-- Name: COLUMN physical_samples.item_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.item_type IS 'AppSheet Item Type: sample | equipment | miscellaneous. Distinct from form/geometry.';


--
-- Name: COLUMN physical_samples.gauge_length_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.gauge_length_mm IS 'Gauge length of a test coupon (e.g. ISO 6892 tensile). NULL for non-specimen forms.';


--
-- Name: COLUMN physical_samples.gauge_width_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.physical_samples.gauge_width_mm IS 'Gauge (reduced-section) width of a test coupon. NULL for non-specimen forms.';


--
-- Name: prep_recipe_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prep_recipe_steps (
    step_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    recipe_id uuid NOT NULL,
    step_order integer DEFAULT 1 NOT NULL,
    step_type text,
    grit text,
    suspension_um numeric(8,3),
    cloth text,
    etchant_id uuid,
    duration_s numeric(8,2),
    force_n numeric(8,2),
    rpm numeric(8,2),
    temperature_c numeric(8,2),
    lubricant text,
    resin_type text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT prep_recipe_steps_step_type_check CHECK ((step_type = ANY (ARRAY['sectioning'::text, 'mounting'::text, 'grinding'::text, 'polishing'::text, 'etching'::text, 'cleaning'::text, 'other'::text])))
);


--
-- Name: prep_recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prep_recipes (
    recipe_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    description text,
    suited_materials text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    owner_person_id uuid
);


--
-- Name: TABLE prep_recipes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prep_recipes IS 'Reusable sample-preparation recipe (an ordered set of prep steps).';


--
-- Name: prep_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prep_steps (
    step_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    operation_id uuid NOT NULL,
    step_order integer DEFAULT 1 NOT NULL,
    step_type text,
    grit text,
    suspension_um numeric(8,3),
    cloth text,
    etchant_id uuid,
    duration_s numeric(8,2),
    force_n numeric(8,2),
    rpm numeric(8,2),
    temperature_c numeric(8,2),
    lubricant text,
    resin_type text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT prep_steps_step_type_check CHECK ((step_type = ANY (ARRAY['sectioning'::text, 'mounting'::text, 'grinding'::text, 'polishing'::text, 'etching'::text, 'cleaning'::text, 'other'::text])))
);


--
-- Name: project_investigators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_investigators (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    person_id uuid
);


--
-- Name: TABLE project_investigators; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.project_investigators IS 'M2M junction: Directus users who are secondary investigators on a project.';


--
-- Name: project_rollup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_rollup (
    row_id text NOT NULL,
    project_id uuid,
    kind text,
    code text,
    detail text,
    campaign_id uuid
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    project_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    project_code character varying(32) DEFAULT ''::character varying NOT NULL,
    project_name text NOT NULL,
    description text,
    document_number text,
    principal_investigator_name text,
    start_date date,
    end_date date,
    export_controlled boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    principal_investigator uuid,
    "Image" uuid,
    principal_investigator_person uuid
);


--
-- Name: TABLE projects; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.projects IS 'Research campaigns / projects grouping related operations and test sessions. E.g. AI4340 – FAST Rolled Plate Detection.';


--
-- Name: COLUMN projects.project_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.projects.project_code IS 'Short unique identifier, e.g. AI4340. Used in document numbering.';


--
-- Name: COLUMN projects.document_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.projects.document_number IS 'AMRC GESS controlled-document number, e.g. AI4340-AMRC-ES-230323-01.';


--
-- Name: COLUMN projects.export_controlled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.projects.export_controlled IS 'TRUE if the project is subject to ITAR/ECJU controls. Propagates to samples.';


--
-- Name: raw_stock_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_stock_lots (
    lot_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    lot_code character varying(64) NOT NULL,
    stock_type text NOT NULL,
    material_id uuid,
    supplier_name text,
    supplier_part_number text,
    mesh_size_micrometres numeric(10,3),
    purity_percent numeric(7,4),
    inbound_mass_grams numeric(12,4) NOT NULL,
    remaining_mass_grams numeric(12,4) NOT NULL,
    received_date date,
    certificate_url text,
    export_controlled boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT raw_stock_lots_inbound_mass_check CHECK ((inbound_mass_grams > (0)::numeric)),
    CONSTRAINT raw_stock_lots_remaining_mass_check CHECK ((remaining_mass_grams >= (0)::numeric)),
    CONSTRAINT raw_stock_lots_stock_type_check CHECK ((stock_type = ANY (ARRAY['swarf'::text, 'powder'::text, 'billet'::text, 'chemical'::text, 'other'::text])))
);


--
-- Name: TABLE raw_stock_lots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.raw_stock_lots IS 'Inbound material ledger. Every manufactured sample must trace back to one or more lots here to maintain material provenance (the weakest link in the legacy data).';


--
-- Name: COLUMN raw_stock_lots.lot_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.lot_code IS 'Human-readable lot identifier, unique across all stock.';


--
-- Name: COLUMN raw_stock_lots.stock_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.stock_type IS 'Form of the raw stock: swarf, powder, billet, chemical, or other.';


--
-- Name: COLUMN raw_stock_lots.mesh_size_micrometres; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.mesh_size_micrometres IS 'Powder mesh/particle size in micrometres. NULL for non-powder stock.';


--
-- Name: COLUMN raw_stock_lots.purity_percent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.purity_percent IS 'Material purity as a percentage (0–100). NULL for alloys/billets.';


--
-- Name: COLUMN raw_stock_lots.inbound_mass_grams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.inbound_mass_grams IS 'Total mass received in grams. Must be > 0.';


--
-- Name: COLUMN raw_stock_lots.remaining_mass_grams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.remaining_mass_grams IS 'Current remaining mass in grams. Decremented as material is consumed.';


--
-- Name: COLUMN raw_stock_lots.certificate_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_stock_lots.certificate_url IS 'URI to material certificate or datasheet in MinIO or external source.';


--
-- Name: sample_co_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_co_owners (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sample_id uuid NOT NULL,
    user_id uuid NOT NULL,
    person_id uuid
);


--
-- Name: TABLE sample_co_owners; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sample_co_owners IS 'M2M junction: which Directus users are co-owners of a given physical sample.';


--
-- Name: COLUMN sample_co_owners.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sample_co_owners.user_id IS 'UUID of a directus_users record. No hard FK so the auth layer stays swappable.';


--
-- Name: sample_data_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_data_files (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sample_id uuid NOT NULL,
    directus_files_id uuid NOT NULL
);


--
-- Name: sample_genealogy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_genealogy (
    child_sample_id uuid NOT NULL,
    parent_sample_id uuid NOT NULL,
    relationship_type text DEFAULT 'derived_from'::text NOT NULL,
    fraction numeric(5,4),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    CONSTRAINT sample_genealogy_no_self_loop CHECK ((child_sample_id <> parent_sample_id)),
    CONSTRAINT sample_genealogy_relationship_check CHECK ((relationship_type = ANY (ARRAY['derived_from'::text, 'cut_from'::text, 'sintered_from'::text, 'powder_from'::text])))
);


--
-- Name: TABLE sample_genealogy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sample_genealogy IS 'Self-referential lineage: which samples were produced from which others. Captures the Parent/Contains structure in the legacy Inventory sheet.';


--
-- Name: COLUMN sample_genealogy.relationship_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sample_genealogy.relationship_type IS 'Nature of the derivation: derived_from, cut_from, sintered_from, powder_from.';


--
-- Name: COLUMN sample_genealogy.fraction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sample_genealogy.fraction IS 'Fraction of parent mass that became this child (0–1). NULL if unknown.';


--
-- Name: sample_stock_provenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_stock_provenance (
    sample_id uuid NOT NULL,
    lot_id uuid NOT NULL,
    mass_used_grams numeric(12,4),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL
);


--
-- Name: TABLE sample_stock_provenance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sample_stock_provenance IS 'Many-to-many: which raw_stock_lots contributed to which physical_samples. Enables full material-provenance tracing back to inbound material receipts.';


--
-- Name: COLUMN sample_stock_provenance.mass_used_grams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sample_stock_provenance.mass_used_grams IS 'Mass of raw stock consumed to produce this sample, in grams.';


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: semantic_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.semantic_embeddings (
    embedding_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    source_table text NOT NULL,
    source_id uuid NOT NULL,
    source_column text NOT NULL,
    content_text text NOT NULL,
    content_hash text NOT NULL,
    embedding public.vector(768) NOT NULL,
    model_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE semantic_embeddings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.semantic_embeddings IS 'pgvector store for unstructured note text (spec §6 hybrid search). One row per (source_table, source_id, source_column, model_name); derived data — rebuildable from the source rows, so not audited.';


--
-- Name: COLUMN semantic_embeddings.source_table; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.source_table IS 'Name of the table the embedded text came from (e.g. physical_samples).';


--
-- Name: COLUMN semantic_embeddings.source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.source_id IS 'Primary key (UUID) of the source row the embedded text belongs to.';


--
-- Name: COLUMN semantic_embeddings.source_column; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.source_column IS 'Name of the text column embedded (e.g. notes, outcome_notes).';


--
-- Name: COLUMN semantic_embeddings.content_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.content_text IS 'The exact text that was embedded; kept for re-ranking and display.';


--
-- Name: COLUMN semantic_embeddings.content_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.content_hash IS 'SHA-256 of content_text; lets the backfill skip unchanged rows.';


--
-- Name: COLUMN semantic_embeddings.embedding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.embedding IS 'pgvector embedding (dimension 768, nomic-embed-text). Cosine distance.';


--
-- Name: COLUMN semantic_embeddings.model_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.semantic_embeddings.model_name IS 'Embedding model that produced this vector; part of the uniqueness key.';


--
-- Name: session_data_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_data_files (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    session_id uuid NOT NULL,
    directus_files_id uuid NOT NULL
);


--
-- Name: test_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_sessions (
    session_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    sample_id uuid,
    equipment_id uuid,
    insert_edge_id uuid,
    project_id uuid,
    operator_name text,
    session_date timestamp with time zone,
    test_type text,
    capture_software text,
    capture_frequency_khz numeric(10,4),
    file_storage_pointer text,
    file_size_gb numeric(10,4),
    summary_stats jsonb,
    plot_uris jsonb,
    status text DEFAULT 'registered'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    data_file_uri text,
    data_file_size_gb numeric(10,4),
    tensile_specimen_geometry text,
    tensile_gauge_length_mm numeric(8,3),
    tensile_gauge_diameter_mm numeric(8,3),
    tensile_gauge_width_mm numeric(8,3),
    tensile_gauge_thickness_mm numeric(8,3),
    tensile_crosshead_speed_mm_per_min numeric(8,3),
    tensile_strain_rate_per_s numeric(10,6),
    tensile_test_temp_celsius numeric(8,2),
    tensile_extensometer_used boolean,
    tensile_yield_strength_mpa numeric(10,3),
    tensile_uts_mpa numeric(10,3),
    tensile_elongation_pct numeric(8,3),
    tensile_reduction_of_area_pct numeric(8,3),
    tensile_youngs_modulus_gpa numeric(8,3),
    tensile_fracture_mode text,
    hardness_hardness_scale text,
    hardness_load_gf numeric(10,3),
    hardness_dwell_time_s numeric(6,2),
    hardness_indenter_type text,
    hardness_n_indentations integer,
    hardness_surface_finish text,
    hardness_mean_hardness numeric(10,3),
    hardness_std_dev_hardness numeric(10,3),
    hardness_min_hardness numeric(10,3),
    hardness_max_hardness numeric(10,3),
    charpy_specimen_standard text,
    charpy_notch_type text,
    charpy_notch_depth_mm numeric(6,3),
    charpy_specimen_width_mm numeric(6,3),
    charpy_specimen_height_mm numeric(6,3),
    charpy_test_temp_celsius numeric(8,2),
    charpy_orientation text,
    charpy_absorbed_energy_j numeric(8,3),
    charpy_lateral_expansion_mm numeric(6,3),
    charpy_shear_fracture_pct numeric(6,2),
    compression_specimen_diameter_mm numeric(8,3),
    compression_specimen_height_mm numeric(8,3),
    compression_crosshead_speed_mm_per_min numeric(8,3),
    compression_strain_rate_per_s numeric(10,6),
    compression_test_temp_celsius numeric(8,2),
    compression_lubrication text,
    compression_yield_strength_mpa numeric(10,3),
    compression_peak_stress_mpa numeric(10,3),
    compression_strain_at_fracture_pct numeric(8,3),
    sem_imaging_mode text,
    sem_accelerating_voltage_kv numeric(6,2),
    sem_working_distance_mm numeric(6,2),
    sem_magnification_range text,
    sem_beam_current_na numeric(8,4),
    sem_coating_material text,
    sem_coating_thickness_nm numeric(8,2),
    sem_etchant text,
    sem_step_size_um numeric(8,4),
    xrd_radiation_source text,
    xrd_wavelength_angstrom numeric(8,5),
    xrd_two_theta_range_deg text,
    xrd_step_size_deg numeric(6,4),
    xrd_scan_speed_deg_per_min numeric(6,3),
    xrd_detector_type text,
    xrd_sample_prep text,
    test_category text,
    owner uuid,
    operator integer,
    campaign_id uuid,
    tribology_test_standard text,
    tribology_configuration text,
    tribology_counterface_material text,
    tribology_normal_load_n numeric(10,3),
    tribology_sliding_speed_m_per_s numeric(10,4),
    tribology_sliding_distance_m numeric(12,3),
    tribology_lubrication text,
    tribology_test_temp_celsius numeric(8,2),
    tribology_coefficient_of_friction numeric(8,4),
    tribology_wear_rate_mm3_per_nm numeric(14,8),
    tribology_wear_volume_mm3 numeric(12,6),
    optical_microscopy_mode text,
    optical_microscopy_objective_magnification text,
    optical_microscopy_etchant text,
    optical_microscopy_etch_time_s numeric(8,2),
    optical_microscopy_image_scale_um_per_px numeric(10,5),
    optical_microscopy_notable_features text,
    tem_operating_voltage_kv numeric(6,1),
    tem_imaging_mode text,
    tem_camera_length_mm numeric(8,2),
    tem_specimen_prep text,
    tem_magnification_range text,
    tem_notable_features text,
    alicona_objective_magnification text,
    alicona_vertical_resolution_nm numeric(10,2),
    alicona_lateral_resolution_um numeric(10,4),
    alicona_measured_area text,
    alicona_sa_um numeric(10,4),
    alicona_sz_um numeric(10,4),
    clemx_analysis_type text,
    clemx_objective_magnification text,
    clemx_n_fields_analysed integer,
    clemx_etchant text,
    clemx_mean_grain_size_um numeric(10,3),
    clemx_astm_grain_size_number numeric(6,2),
    clemx_phase_fraction_pct numeric(6,2),
    dct_beam_energy_kev numeric(8,2),
    dct_voxel_size_um numeric(10,4),
    dct_n_projections integer,
    dct_scan_time_min numeric(8,2),
    dct_n_grains_indexed integer,
    dct_notable_features text,
    ct_scan_tube_voltage_kv numeric(8,2),
    ct_scan_tube_current_ua numeric(10,2),
    ct_scan_voxel_size_um numeric(10,4),
    ct_scan_n_projections integer,
    ct_scan_exposure_time_ms numeric(10,2),
    ct_scan_filter_material text,
    ct_scan_porosity_pct numeric(8,4),
    ct_scan_notable_features text,
    fatigue_loading_mode text,
    fatigue_stress_ratio_r numeric(6,3),
    fatigue_max_stress_mpa numeric(10,3),
    fatigue_stress_amplitude_mpa numeric(10,3),
    fatigue_frequency_hz numeric(10,3),
    fatigue_waveform text,
    fatigue_test_temp_celsius numeric(8,2),
    fatigue_cycles_to_failure bigint,
    fatigue_runout boolean,
    creep_applied_stress_mpa numeric(10,3),
    creep_test_temp_celsius numeric(8,2),
    creep_atmosphere text,
    creep_time_to_rupture_h numeric(12,3),
    creep_steady_state_creep_rate_per_s numeric(16,12),
    creep_rupture_elongation_pct numeric(8,3),
    creep_reduction_of_area_pct numeric(8,3),
    dma_deformation_mode text,
    dma_frequency_hz numeric(10,3),
    dma_temperature_range text,
    dma_heating_rate_c_per_min numeric(8,3),
    dma_amplitude_um numeric(10,3),
    dma_storage_modulus_mpa numeric(12,3),
    dma_loss_modulus_mpa numeric(12,3),
    dma_tan_delta numeric(10,5),
    dma_glass_transition_celsius numeric(8,2),
    owner_person_id uuid,
    operator_person_id uuid,
    CONSTRAINT test_sessions_status_check CHECK ((status = ANY (ARRAY['registered'::text, 'pending_processing'::text, 'processing'::text, 'processed'::text, 'analysing'::text, 'analysed'::text, 'failed'::text]))),
    CONSTRAINT test_sessions_test_category_check CHECK ((test_category = ANY (ARRAY['nde'::text, 'destructive'::text, 'dynamic'::text, 'other'::text]))),
    CONSTRAINT test_sessions_test_type_check CHECK ((test_type = ANY (ARRAY['tensile'::text, 'hardness'::text, 'charpy'::text, 'compression'::text, 'tribology'::text, 'optical_microscopy'::text, 'sem'::text, 'tem'::text, 'xrd'::text, 'alicona'::text, 'clemx'::text, 'dct'::text, 'ct_scan'::text, 'fatigue'::text, 'creep'::text, 'dma'::text, 'other'::text])))
);


--
-- Name: TABLE test_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.test_sessions IS 'Experimental test-session ledger. One row per test run / data-capture event. file_storage_pointer links to the raw file in MinIO (10–100 GB).';


--
-- Name: COLUMN test_sessions.sample_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.sample_id IS 'The sample under test. FK to physical_samples.';


--
-- Name: COLUMN test_sessions.insert_edge_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.insert_edge_id IS 'The specific cutting-edge used in this test. FK to insert_edges.';


--
-- Name: COLUMN test_sessions.test_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.test_type IS 'Category of test, e.g. force_measurement, microstructure, hardness, SEM.';


--
-- Name: COLUMN test_sessions.capture_software; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.capture_software IS 'Data-capture app and version, e.g. MATLAB ABFP 0.18.';


--
-- Name: COLUMN test_sessions.capture_frequency_khz; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.capture_frequency_khz IS 'Sampling frequency in kilohertz (e.g. 25.6). Required to interpret raw files.';


--
-- Name: COLUMN test_sessions.file_storage_pointer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.file_storage_pointer IS 'MinIO S3 URI for the raw data file, e.g. s3://d1-data/AI4340/9-AA-MR-...';


--
-- Name: COLUMN test_sessions.file_size_gb; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.file_size_gb IS 'Raw file size in gigabytes as reported by the capture client.';


--
-- Name: COLUMN test_sessions.summary_stats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.summary_stats IS 'JSON statistics written back by the async heavy-data worker after parsing.';


--
-- Name: COLUMN test_sessions.plot_uris; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.plot_uris IS 'JSON array of MinIO URIs for SVG/PNG plots rendered by the worker.';


--
-- Name: COLUMN test_sessions.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.status IS 'Pipeline lifecycle status. Canonical set (see db migration 0013 and each plugin app/lib/statuses.py): registered | pending_processing | processing | processed | analysing | analysed | failed.';


--
-- Name: COLUMN test_sessions.owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.test_sessions.owner IS 'Researcher who owns this test session (defaults to the creating user; editable).';


--
-- Name: test_sessions_subject; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_sessions_subject (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    test_sessions_id uuid NOT NULL,
    collection character varying(64) NOT NULL,
    item character varying(255) NOT NULL
);


--
-- Name: TABLE test_sessions_subject; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.test_sessions_subject IS 'M2A junction: the subject(s) a test targets — a physical_sample, an insert_edge, or a future testable collection.';


--
-- Name: tool_boxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_boxes (
    tool_box_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tool_box_code character varying(64) DEFAULT ''::character varying NOT NULL,
    description text,
    location text,
    insert_type_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    package_quantity integer,
    owner uuid,
    cascade_ownership boolean DEFAULT true NOT NULL,
    project_id uuid,
    owner_person_id uuid,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: TABLE tool_boxes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tool_boxes IS 'Grandparent level of the 3-tier tooling hierarchy. A box holds a batch of identical cutting inserts.';


--
-- Name: COLUMN tool_boxes.tool_box_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tool_boxes.tool_box_code IS 'Unique label on the physical box, e.g. BOX-H13A-001.';


--
-- Name: COLUMN tool_boxes.insert_type_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tool_boxes.insert_type_id IS 'Default insert type for this box. Individual inserts may override.';


--
-- Name: COLUMN tool_boxes.package_quantity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tool_boxes.package_quantity IS 'Number of boxes received in this delivery (intake batch size). expand_tool_box_intake() creates this many box records plus their inserts and edges. Set to 0 or NULL to skip auto-expansion (manual entry or legacy import).';


--
-- Name: COLUMN tool_boxes.owner; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tool_boxes.owner IS 'Owner / responsible person for this box.';


--
-- Name: tool_setup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_setup (
    setup_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    setup_code character varying(64) NOT NULL,
    mount_deg numeric DEFAULT 0 NOT NULL,
    h_matrix jsonb,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: TABLE tool_setup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tool_setup IS 'Mount geometry + H-matrix FRF correction for a dynamometer setup. Cuts reference a setup by FK (machining_force_analysis.tool_setup_id) rather than each carrying a near-duplicate FRF file.';


--
-- Name: COLUMN tool_setup.h_matrix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tool_setup.h_matrix IS 'Optional 3x3 correction matrix (row-major JSON array of arrays), applied to (Fx,Fy,Fz) before frame_transform. NULL = no correction (identity). Measuring an FRF is a bench procedure, out of scope for this app -- the worker only applies a supplied matrix.';


--
-- Name: tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tools (
    tool_id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tool_code character varying(64) NOT NULL,
    tool_name text NOT NULL,
    tool_type text,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    manufacturer text,
    datasheet_url text,
    op_type text,
    cutter_diameter_mm numeric(8,3),
    shank_width_mm numeric(8,3),
    shank_length_mm numeric(8,3),
    overall_length_mm numeric(8,3),
    shank_type text,
    cutting_direction text,
    insert_clamping_system text,
    project_id uuid,
    image uuid,
    manufacturer_id uuid
);


--
-- Name: TABLE tools; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tools IS 'Tool holders used in machining operations.';


--
-- Name: COLUMN tools.tool_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.tool_type IS 'Category, e.g. Turning, Milling.';


--
-- Name: COLUMN tools.manufacturer; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.manufacturer IS 'Tool holder manufacturer name.';


--
-- Name: COLUMN tools.datasheet_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.datasheet_url IS 'Link to manufacturer datasheet or product page.';


--
-- Name: COLUMN tools.op_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.op_type IS 'Operation type, e.g. External, Internal, Face.';


--
-- Name: COLUMN tools.cutter_diameter_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.cutter_diameter_mm IS 'Cutter/body diameter in millimetres.';


--
-- Name: COLUMN tools.shank_width_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.shank_width_mm IS 'Shank width B in millimetres.';


--
-- Name: COLUMN tools.shank_length_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.shank_length_mm IS 'Shank length in millimetres.';


--
-- Name: COLUMN tools.overall_length_mm; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.overall_length_mm IS 'Overall tool length in millimetres.';


--
-- Name: COLUMN tools.shank_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.shank_type IS 'Shank interface type, e.g. Capto, HSK, ISO.';


--
-- Name: COLUMN tools.cutting_direction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.cutting_direction IS 'Cutting direction: Right-Hand, Left-Hand, Neutral.';


--
-- Name: COLUMN tools.insert_clamping_system; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.insert_clamping_system IS 'Insert clamping system code, e.g. P-clamp, S-clamp.';


--
-- Name: COLUMN tools.image; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tools.image IS 'Photo of the tool (Directus File Library / MinIO).';


--
-- Name: v_complete_sample_history; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_complete_sample_history AS
 SELECT ps.sample_id,
    ps.sample_code,
    ps.form,
    ps.mass_grams,
    ps.diameter_mm,
    ps.length_mm,
    ps.thickness_mm,
    ps.current_status,
    ps.manufactured_date,
    ps.export_controlled,
    ps.notes,
    ps.created_at,
    ps.updated_at,
    m.alloy_code,
    m.common_name AS material_name,
    m.iso_code AS material_iso_code,
    m.density_g_per_cm3,
    p.project_code,
    p.project_name,
    p.document_number AS project_document_number
   FROM ((public.physical_samples ps
     LEFT JOIN public.materials m ON ((ps.material_id = m.material_id)))
     LEFT JOIN public.projects p ON ((ps.project_id = p.project_id)));


--
-- Name: VIEW v_complete_sample_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_complete_sample_history IS 'Flat sample profile with material and project context. Primary LLM target for sample-centric queries. Join manufacturing_operations or test_sessions for events.';


--
-- Name: v_embeddings_source_notes; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_embeddings_source_notes AS
 SELECT 'physical_samples'::text AS source_table,
    ps.sample_id AS source_id,
    'notes'::text AS source_column,
    ps.notes AS content_text
   FROM public.physical_samples ps
  WHERE ((ps.notes IS NOT NULL) AND (length(TRIM(BOTH FROM ps.notes)) > 0))
UNION ALL
 SELECT 'manufacturing_operations'::text AS source_table,
    mo.operation_id AS source_id,
    'outcome_notes'::text AS source_column,
    mo.outcome_notes AS content_text
   FROM public.manufacturing_operations mo
  WHERE ((mo.outcome_notes IS NOT NULL) AND (length(TRIM(BOTH FROM mo.outcome_notes)) > 0))
UNION ALL
 SELECT 'test_sessions'::text AS source_table,
    ts.session_id AS source_id,
    'notes'::text AS source_column,
    ts.notes AS content_text
   FROM public.test_sessions ts
  WHERE ((ts.notes IS NOT NULL) AND (length(TRIM(BOTH FROM ts.notes)) > 0))
UNION ALL
 SELECT 'raw_stock_lots'::text AS source_table,
    rsl.lot_id AS source_id,
    'notes'::text AS source_column,
    rsl.notes AS content_text
   FROM public.raw_stock_lots rsl
  WHERE ((rsl.notes IS NOT NULL) AND (length(TRIM(BOTH FROM rsl.notes)) > 0));


--
-- Name: VIEW v_embeddings_source_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_embeddings_source_notes IS 'All embeddable free-text notes across the schema, one row each, as the canonical backfill source for semantic_embeddings (spec §6).';


--
-- Name: v_llm_query_targets; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_llm_query_targets AS
 SELECT c.relname AS view_name,
    obj_description(c.oid, 'pg_class'::name) AS description
   FROM (pg_class c
     JOIN pg_namespace n ON ((c.relnamespace = n.oid)))
  WHERE ((n.nspname = 'public'::name) AND (c.relkind = 'v'::"char") AND (c.relname ~~ 'v\_%'::text) AND (c.relname <> ALL (ARRAY['v_llm_query_targets'::name, 'v_embeddings_source_notes'::name])))
  ORDER BY c.relname;


--
-- Name: VIEW v_llm_query_targets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_llm_query_targets IS 'Menu of flattened v_* views the text-to-SQL LLM is allowed to query, with their business-logic descriptions. Mirrors the plugin SQL-guard allow-list.';


--
-- Name: v_manufacturing_operations_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_manufacturing_operations_full AS
 SELECT mo.operation_id,
    mo.pass_code,
    mo.operation_date,
    mo.operation_sequence,
    mo.operator_name,
    mo.recorded_metadata,
    mo.capture_software,
    mo.capture_frequency_khz,
    mo.file_storage_pointer,
    mo.force_file_id,
    mo.outcome_notes,
    mo.created_at,
    ps.sample_id,
    ps.sample_code,
    mm.method_id,
    mm.method_name,
    mm.method_code,
    p.project_code,
    p.project_name,
    e.equipment_code,
    e.equipment_name,
    t.tool_code,
    ie.edge_code AS insert_edge_code,
    ci.insert_code,
    tb.tool_box_code,
    mo.process_category,
    mo.machining_operation_subtype,
    mo.machining_feed_mm_per_rev,
    mo.machining_cutting_speed_m_per_min,
    mo.machining_spindle_speed_rpm,
    mo.machining_axial_depth_of_cut_mm,
    mo.machining_radial_depth_of_cut_mm,
    mo.machining_coolant_pressure_bar,
    mo.machining_workpiece_diameter_mm,
    mo.machining_cutting_length_mm,
    mo.am_process_variant,
    mo.am_laser_power_w,
    mo.am_scan_speed_mm_per_s,
    mo.am_energy_density_j_per_mm3,
    mo.am_hatch_spacing_mm,
    mo.am_layer_thickness_mm,
    mo.sintering_max_force_kn,
    mo.sintering_max_temp_celsius,
    mo.sintering_power_at_max_t_kw,
    mo.sintering_mould_diameter_mm,
    mo.deform_deformation_type,
    mo.deform_deformation_temp_celsius,
    mo.deform_strain_rate_per_sec,
    mo.deform_roll_speed_m_per_min,
    mo.deform_total_reduction_pct,
    mo.ht_treatment_type,
    mo.ht_peak_temp_celsius,
    mo.ht_heating_rate_c_per_min,
    mo.ht_cooling_rate_c_per_min,
    mo.ht_hold_time_min
   FROM ((((((((public.manufacturing_operations mo
     JOIN public.physical_samples ps ON ((mo.sample_id = ps.sample_id)))
     JOIN public.manufacturing_methods mm ON ((mo.method_id = mm.method_id)))
     LEFT JOIN public.projects p ON ((mo.project_id = p.project_id)))
     LEFT JOIN public.equipment e ON ((mo.equipment_id = e.equipment_id)))
     LEFT JOIN public.tools t ON ((mo.tool_id = t.tool_id)))
     LEFT JOIN public.insert_edges ie ON ((mo.insert_edge_id = ie.edge_id)))
     LEFT JOIN public.cutting_inserts ci ON ((ie.insert_id = ci.insert_id)))
     LEFT JOIN public.tool_boxes tb ON ((ci.tool_box_id = tb.tool_box_id)));


--
-- Name: VIEW v_manufacturing_operations_full; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_manufacturing_operations_full IS 'Operations with fully denormalized method, sample, tooling, and project context. Use recorded_metadata JSONB for method-specific parameters.';


--
-- Name: COLUMN v_manufacturing_operations_full.process_category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v_manufacturing_operations_full.process_category IS 'Process type discriminator: which family of parameters applies (machining, sintering, additive, deformation, heat_treatment).';


--
-- Name: COLUMN v_manufacturing_operations_full.machining_operation_subtype; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v_manufacturing_operations_full.machining_operation_subtype IS 'Machining sub-type (e.g. turning, milling) when process_category = machining.';


--
-- Name: v_project_rollup; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_project_rollup AS
 WITH ops AS (
         SELECT o.operation_id,
            o.sample_id,
            o.method_id,
            o.project_id,
            o.equipment_id,
            o.tool_id,
            o.insert_edge_id,
            o.operator_name,
            o.operation_sequence,
            o.pass_code,
            o.operation_date,
            o.recorded_metadata,
            o.capture_software,
            o.capture_frequency_khz,
            o.file_storage_pointer,
            o.force_file_id,
            o.nc_program_text,
            o.nc_program_file_uri,
            o.outcome_notes,
            o.created_at,
            o.updated_at,
            o.version,
            o.operator,
            o.process_category,
            o.machining_operation_subtype,
            o.machining_spindle_speed_rpm,
            o.machining_cutting_speed_m_per_min,
            o.machining_feed_mm_per_rev,
            o.machining_axial_depth_of_cut_mm,
            o.machining_radial_depth_of_cut_mm,
            o.machining_cutting_length_mm,
            o.machining_workpiece_diameter_mm,
            o.machining_new_edge,
            o.machining_coolant_used,
            o.machining_coolant_pressure_bar,
            o.machining_tacho_used,
            o.machining_force_captured,
            o.machining_chips_collected,
            o.machining_chips_ref_code,
            o.machining_experiment_sheet_url,
            o.machining_legacy_insert_edge_id,
            o.machining_legacy_machining_uid,
            o.sintering_recipe_number,
            o.sintering_batch_number,
            o.sintering_mould_diameter_mm,
            o.sintering_atmosphere,
            o.sintering_tc_pyro_control,
            o.sintering_max_temp_celsius,
            o.sintering_max_force_kn,
            o.sintering_voltage_at_max_t_v,
            o.sintering_power_at_max_t_kw,
            o.sintering_ptc_top_celsius,
            o.sintering_ptc_bot_celsius,
            o.sintering_coshh_ref,
            o.sintering_material_type_note,
            o.ht_treatment_type,
            o.ht_atmosphere,
            o.ht_peak_temp_celsius,
            o.ht_hold_time_min,
            o.ht_heating_rate_c_per_min,
            o.ht_cooling_method,
            o.ht_cooling_rate_c_per_min,
            o.ht_quench_medium,
            o.deform_deformation_type,
            o.deform_deformation_temp_celsius,
            o.deform_pass_count,
            o.deform_total_reduction_pct,
            o.deform_reduction_per_pass_pct,
            o.deform_strain_rate_per_sec,
            o.deform_roll_speed_m_per_min,
            o.deform_lubricant,
            o.am_process_variant,
            o.am_layer_thickness_mm,
            o.am_laser_power_w,
            o.am_scan_speed_mm_per_s,
            o.am_hatch_spacing_mm,
            o.am_energy_density_j_per_mm3,
            o.am_build_atmosphere,
            o.am_preheat_temp_celsius,
            o.owner,
            o.output_sample_id,
            o.source_recipe_id,
            o.gcode_file,
            o.source_run_uid,
            o.source_system,
            o.sintering_mass_grams,
            o.material_id,
            o.campaign_id,
            COALESCE(o.project_id, c.project_id) AS proj
           FROM (public.manufacturing_operations o
             LEFT JOIN public.campaigns c ON ((c.campaign_id = o.campaign_id)))
          WHERE (COALESCE(o.project_id, c.project_id) IS NOT NULL)
        )
 SELECT md5(('operation:'::text || (ops.operation_id)::text)) AS row_id,
    ops.proj AS project_id,
    'operation'::text AS kind,
    ops.pass_code AS code,
    ops.machining_operation_subtype AS detail,
    ops.campaign_id
   FROM ops
UNION ALL
 SELECT DISTINCT md5(((('tool:'::text || (ops.proj)::text) || ':'::text) || (t.tool_id)::text)) AS row_id,
    ops.proj AS project_id,
    'tool'::text AS kind,
    t.tool_code AS code,
    t.tool_name AS detail,
    NULL::uuid AS campaign_id
   FROM (ops
     JOIN public.tools t ON ((t.tool_id = ops.tool_id)))
UNION ALL
 SELECT DISTINCT md5(((('edge:'::text || (ops.proj)::text) || ':'::text) || (e.edge_id)::text)) AS row_id,
    ops.proj AS project_id,
    'insert_edge'::text AS kind,
    e.edge_code AS code,
    NULL::text AS detail,
    NULL::uuid AS campaign_id
   FROM (ops
     JOIN public.insert_edges e ON ((e.edge_id = ops.insert_edge_id)))
UNION ALL
 SELECT DISTINCT md5(((('insert:'::text || (ops.proj)::text) || ':'::text) || (ci.insert_id)::text)) AS row_id,
    ops.proj AS project_id,
    'cutting_insert'::text AS kind,
    ci.insert_code AS code,
    NULL::text AS detail,
    NULL::uuid AS campaign_id
   FROM ((ops
     JOIN public.insert_edges e ON ((e.edge_id = ops.insert_edge_id)))
     JOIN public.cutting_inserts ci ON ((ci.insert_id = e.insert_id)))
UNION ALL
 SELECT DISTINCT md5(((('sample:'::text || (ops.proj)::text) || ':'::text) || (s.sample_id)::text)) AS row_id,
    ops.proj AS project_id,
    'sample'::text AS kind,
    s.sample_code AS code,
    s.nickname AS detail,
    NULL::uuid AS campaign_id
   FROM (ops
     JOIN public.physical_samples s ON ((s.sample_id = ops.sample_id)))
UNION ALL
 SELECT DISTINCT md5(((('material:'::text || (ops.proj)::text) || ':'::text) || (m.material_id)::text)) AS row_id,
    ops.proj AS project_id,
    'material'::text AS kind,
    m.alloy_code AS code,
    m.common_name AS detail,
    NULL::uuid AS campaign_id
   FROM (ops
     JOIN public.materials m ON ((m.material_id = ops.material_id)))
UNION ALL
 SELECT DISTINCT md5(((('equipment:'::text || (ops.proj)::text) || ':'::text) || (eq.equipment_id)::text)) AS row_id,
    ops.proj AS project_id,
    'equipment'::text AS kind,
    eq.equipment_code AS code,
    eq.equipment_name AS detail,
    NULL::uuid AS campaign_id
   FROM (ops
     JOIN public.equipment eq ON ((eq.equipment_id = ops.equipment_id)));


--
-- Name: VIEW v_project_rollup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_project_rollup IS 'Live read-only rollup of a project: operations (direct + via campaign) and the distinct tooling/samples/materials/equipment used. Provenance, not ownership.';


--
-- Name: v_sample_genealogy_flat; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_sample_genealogy_flat AS
 SELECT sg.relationship_type,
    sg.fraction,
    child_s.sample_id AS child_sample_id,
    child_s.sample_code AS child_sample_code,
    child_s.form AS child_form,
    child_s.current_status AS child_status,
    parent_s.sample_id AS parent_sample_id,
    parent_s.sample_code AS parent_sample_code,
    parent_s.form AS parent_form
   FROM ((public.sample_genealogy sg
     JOIN public.physical_samples child_s ON ((sg.child_sample_id = child_s.sample_id)))
     JOIN public.physical_samples parent_s ON ((sg.parent_sample_id = parent_s.sample_id)));


--
-- Name: VIEW v_sample_genealogy_flat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_sample_genealogy_flat IS 'Flat parent-child lineage pairs. For forward traceability: WHERE parent_sample_code = ''...''. For reverse: WHERE child_sample_code = ''...''.';


--
-- Name: v_schema_dictionary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_schema_dictionary AS
 SELECT c.relname AS object_name,
    a.attnum AS column_position,
    a.attname AS column_name,
    a.attnotnull AS is_not_null,
        CASE c.relkind
            WHEN 'r'::"char" THEN 'table'::text
            WHEN 'v'::"char" THEN 'view'::text
            WHEN 'm'::"char" THEN 'materialized_view'::text
            ELSE (c.relkind)::text
        END AS object_type,
    format_type(a.atttypid, a.atttypmod) AS data_type,
    obj_description(c.oid, 'pg_class'::name) AS object_comment,
    col_description(c.oid, (a.attnum)::integer) AS column_comment
   FROM ((pg_class c
     JOIN pg_namespace n ON ((c.relnamespace = n.oid)))
     JOIN pg_attribute a ON ((c.oid = a.attrelid)))
  WHERE ((n.nspname = 'public'::name) AND (c.relkind = ANY (ARRAY['r'::"char", 'v'::"char"])) AND (a.attnum > 0) AND (NOT a.attisdropped))
  ORDER BY c.relname, a.attnum;


--
-- Name: VIEW v_schema_dictionary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_schema_dictionary IS 'Flat semantic dictionary: every public table/view column with its native COMMENT, type, and nullability. Primary LLM context source (spec §6).';


--
-- Name: v_stock_provenance; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_stock_provenance AS
 SELECT ps.sample_id,
    ps.sample_code,
    rsl.lot_id,
    rsl.lot_code,
    rsl.stock_type,
    rsl.supplier_name,
    rsl.inbound_mass_grams,
    rsl.remaining_mass_grams,
    ssp.mass_used_grams,
    mat.alloy_code,
    mat.common_name AS material_name
   FROM (((public.sample_stock_provenance ssp
     JOIN public.physical_samples ps ON ((ssp.sample_id = ps.sample_id)))
     JOIN public.raw_stock_lots rsl ON ((ssp.lot_id = rsl.lot_id)))
     LEFT JOIN public.materials mat ON ((rsl.material_id = mat.material_id)));


--
-- Name: VIEW v_stock_provenance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_stock_provenance IS 'Material provenance: which raw_stock_lots fed which physical_samples. Enables full cradle-to-gate traceability from inbound receipt to sample.';


--
-- Name: v_test_sessions_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_test_sessions_full AS
 SELECT ts.session_id,
    ts.session_date,
    ts.test_type,
    ts.operator_name,
    ts.capture_software,
    ts.capture_frequency_khz,
    ts.file_storage_pointer,
    ts.file_size_gb,
    ts.status,
    ts.summary_stats,
    ts.plot_uris,
    ts.notes,
    ts.created_at,
    ps.sample_id,
    ps.sample_code,
    p.project_code,
    p.project_name,
    e.equipment_code,
    e.equipment_name,
    ie.edge_code AS insert_edge_code,
    ci.insert_code,
    tb.tool_box_code
   FROM ((((((public.test_sessions ts
     JOIN public.physical_samples ps ON ((ts.sample_id = ps.sample_id)))
     LEFT JOIN public.projects p ON ((ts.project_id = p.project_id)))
     LEFT JOIN public.equipment e ON ((ts.equipment_id = e.equipment_id)))
     LEFT JOIN public.insert_edges ie ON ((ts.insert_edge_id = ie.edge_id)))
     LEFT JOIN public.cutting_inserts ci ON ((ie.insert_id = ci.insert_id)))
     LEFT JOIN public.tool_boxes tb ON ((ci.tool_box_id = tb.tool_box_id)));


--
-- Name: VIEW v_test_sessions_full; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_test_sessions_full IS 'Test sessions with fully denormalized sample, equipment, and tooling context. plot_uris and summary_stats are populated by the async heavy-data worker.';


--
-- Name: v_tooling_hierarchy; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_tooling_hierarchy AS
 SELECT tb.tool_box_id,
    tb.tool_box_code,
    tb.description AS tool_box_description,
    tb.location AS tool_box_location,
    ci.insert_id,
    ci.insert_code,
    ci.insert_number,
    ci.is_depleted AS insert_depleted,
    ie.edge_id,
    ie.edge_code,
    ie.edge_identifier,
    ie.is_used AS edge_used,
    it.type_code AS insert_type_code,
    it.manufacturer AS insert_manufacturer,
    it.substrate AS insert_substrate
   FROM (((public.tool_boxes tb
     LEFT JOIN public.cutting_inserts ci ON ((tb.tool_box_id = ci.tool_box_id)))
     LEFT JOIN public.insert_edges ie ON ((ci.insert_id = ie.insert_id)))
     LEFT JOIN public.insert_types it ON ((ci.insert_type_id = it.insert_type_id)));


--
-- Name: VIEW v_tooling_hierarchy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_tooling_hierarchy IS 'Full denormalized view of the 3-tier tooling hierarchy: tool_boxes → cutting_inserts → insert_edges.';


--
-- Name: Machine_Operators id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine_Operators" ALTER COLUMN id SET DEFAULT nextval('public."Machine_Operators_id_seq"'::regclass);


--
-- Name: audit_logs log_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN log_id SET DEFAULT nextval('public.audit_logs_log_id_seq'::regclass);


--
-- Name: directus_activity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_activity ALTER COLUMN id SET DEFAULT nextval('public.directus_activity_id_seq'::regclass);


--
-- Name: directus_fields id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_fields ALTER COLUMN id SET DEFAULT nextval('public.directus_fields_id_seq'::regclass);


--
-- Name: directus_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications ALTER COLUMN id SET DEFAULT nextval('public.directus_notifications_id_seq'::regclass);


--
-- Name: directus_permissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_permissions ALTER COLUMN id SET DEFAULT nextval('public.directus_permissions_id_seq'::regclass);


--
-- Name: directus_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets ALTER COLUMN id SET DEFAULT nextval('public.directus_presets_id_seq'::regclass);


--
-- Name: directus_relations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_relations ALTER COLUMN id SET DEFAULT nextval('public.directus_relations_id_seq'::regclass);


--
-- Name: directus_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions ALTER COLUMN id SET DEFAULT nextval('public.directus_revisions_id_seq'::regclass);


--
-- Name: directus_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings ALTER COLUMN id SET DEFAULT nextval('public.directus_settings_id_seq'::regclass);


--
-- Name: fast_log_qa_backup id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_log_qa_backup ALTER COLUMN id SET DEFAULT nextval('public.fast_log_qa_backup_id_seq'::regclass);


--
-- Name: Machine_Operators Machine_Operators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine_Operators"
    ADD CONSTRAINT "Machine_Operators_pkey" PRIMARY KEY (id);


--
-- Name: alloying_elements alloying_elements_atomic_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alloying_elements
    ADD CONSTRAINT alloying_elements_atomic_number_unique UNIQUE (atomic_number);


--
-- Name: alloying_elements alloying_elements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alloying_elements
    ADD CONSTRAINT alloying_elements_pkey PRIMARY KEY (symbol);


--
-- Name: archive_metadata_edits archive_metadata_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_metadata_edits
    ADD CONSTRAINT archive_metadata_edits_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (log_id);


--
-- Name: campaign_samples campaign_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_samples
    ADD CONSTRAINT campaign_samples_pkey PRIMARY KEY (id);


--
-- Name: campaign_samples campaign_samples_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_samples
    ADD CONSTRAINT campaign_samples_unique UNIQUE (campaign_id, sample_id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (campaign_id);


--
-- Name: cutting_inserts cutting_inserts_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cutting_inserts
    ADD CONSTRAINT cutting_inserts_code_unique UNIQUE (insert_code);


--
-- Name: cutting_inserts cutting_inserts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cutting_inserts
    ADD CONSTRAINT cutting_inserts_pkey PRIMARY KEY (insert_id);


--
-- Name: diag_layer diag_layer_name_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diag_layer
    ADD CONSTRAINT diag_layer_name_uq UNIQUE (analysis_id, name);


--
-- Name: diag_layer diag_layer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diag_layer
    ADD CONSTRAINT diag_layer_pkey PRIMARY KEY (layer_id);


--
-- Name: diag_recipes diag_recipes_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diag_recipes
    ADD CONSTRAINT diag_recipes_name_unique UNIQUE (name);


--
-- Name: diag_recipes diag_recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diag_recipes
    ADD CONSTRAINT diag_recipes_pkey PRIMARY KEY (recipe_id);


--
-- Name: directus_access directus_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_pkey PRIMARY KEY (id);


--
-- Name: directus_activity directus_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_activity
    ADD CONSTRAINT directus_activity_pkey PRIMARY KEY (id);


--
-- Name: directus_collections directus_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_collections
    ADD CONSTRAINT directus_collections_pkey PRIMARY KEY (collection);


--
-- Name: directus_comments directus_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_comments
    ADD CONSTRAINT directus_comments_pkey PRIMARY KEY (id);


--
-- Name: directus_dashboards directus_dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_dashboards
    ADD CONSTRAINT directus_dashboards_pkey PRIMARY KEY (id);


--
-- Name: directus_deployment_projects directus_deployment_projects_deployment_external_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_projects
    ADD CONSTRAINT directus_deployment_projects_deployment_external_id_unique UNIQUE (deployment, external_id);


--
-- Name: directus_deployment_projects directus_deployment_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_projects
    ADD CONSTRAINT directus_deployment_projects_pkey PRIMARY KEY (id);


--
-- Name: directus_deployment_runs directus_deployment_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_runs
    ADD CONSTRAINT directus_deployment_runs_pkey PRIMARY KEY (id);


--
-- Name: directus_deployments directus_deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployments
    ADD CONSTRAINT directus_deployments_pkey PRIMARY KEY (id);


--
-- Name: directus_deployments directus_deployments_provider_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployments
    ADD CONSTRAINT directus_deployments_provider_unique UNIQUE (provider);


--
-- Name: directus_extensions directus_extensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_extensions
    ADD CONSTRAINT directus_extensions_pkey PRIMARY KEY (id);


--
-- Name: directus_fields directus_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_fields
    ADD CONSTRAINT directus_fields_pkey PRIMARY KEY (id);


--
-- Name: directus_files directus_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_pkey PRIMARY KEY (id);


--
-- Name: directus_flows directus_flows_operation_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_flows
    ADD CONSTRAINT directus_flows_operation_unique UNIQUE (operation);


--
-- Name: directus_flows directus_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_flows
    ADD CONSTRAINT directus_flows_pkey PRIMARY KEY (id);


--
-- Name: directus_folders directus_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_folders
    ADD CONSTRAINT directus_folders_pkey PRIMARY KEY (id);


--
-- Name: directus_migrations directus_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_migrations
    ADD CONSTRAINT directus_migrations_pkey PRIMARY KEY (version);


--
-- Name: directus_notifications directus_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications
    ADD CONSTRAINT directus_notifications_pkey PRIMARY KEY (id);


--
-- Name: directus_operations directus_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_pkey PRIMARY KEY (id);


--
-- Name: directus_operations directus_operations_reject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_reject_unique UNIQUE (reject);


--
-- Name: directus_operations directus_operations_resolve_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_resolve_unique UNIQUE (resolve);


--
-- Name: directus_panels directus_panels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_panels
    ADD CONSTRAINT directus_panels_pkey PRIMARY KEY (id);


--
-- Name: directus_permissions directus_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_permissions
    ADD CONSTRAINT directus_permissions_pkey PRIMARY KEY (id);


--
-- Name: directus_policies directus_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_policies
    ADD CONSTRAINT directus_policies_pkey PRIMARY KEY (id);


--
-- Name: directus_presets directus_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets
    ADD CONSTRAINT directus_presets_pkey PRIMARY KEY (id);


--
-- Name: directus_relations directus_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_relations
    ADD CONSTRAINT directus_relations_pkey PRIMARY KEY (id);


--
-- Name: directus_revisions directus_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_pkey PRIMARY KEY (id);


--
-- Name: directus_roles directus_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_roles
    ADD CONSTRAINT directus_roles_pkey PRIMARY KEY (id);


--
-- Name: directus_sessions directus_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sessions
    ADD CONSTRAINT directus_sessions_pkey PRIMARY KEY (token);


--
-- Name: directus_settings directus_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_pkey PRIMARY KEY (id);


--
-- Name: directus_shares directus_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_pkey PRIMARY KEY (id);


--
-- Name: directus_translations directus_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_translations
    ADD CONSTRAINT directus_translations_pkey PRIMARY KEY (id);


--
-- Name: directus_users directus_users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_email_unique UNIQUE (email);


--
-- Name: directus_users directus_users_external_identifier_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_external_identifier_unique UNIQUE (external_identifier);


--
-- Name: directus_users directus_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_pkey PRIMARY KEY (id);


--
-- Name: directus_users directus_users_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_token_unique UNIQUE (token);


--
-- Name: directus_versions directus_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_pkey PRIMARY KEY (id);


--
-- Name: equipment equipment_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_code_unique UNIQUE (equipment_code);


--
-- Name: equipment equipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_pkey PRIMARY KEY (equipment_id);


--
-- Name: etchants etchants_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etchants
    ADD CONSTRAINT etchants_name_key UNIQUE (name);


--
-- Name: etchants etchants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etchants
    ADD CONSTRAINT etchants_pkey PRIMARY KEY (etchant_id);


--
-- Name: facilities facilities_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_code_unique UNIQUE (code);


--
-- Name: facilities facilities_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_name_unique UNIQUE (name);


--
-- Name: facilities facilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facilities
    ADD CONSTRAINT facilities_pkey PRIMARY KEY (facility_id);


--
-- Name: fast_log_qa_backup fast_log_qa_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_log_qa_backup
    ADD CONSTRAINT fast_log_qa_backup_pkey PRIMARY KEY (id);


--
-- Name: fast_recipes fast_recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_recipes
    ADD CONSTRAINT fast_recipes_pkey PRIMARY KEY (id);


--
-- Name: fast_run_data fast_run_data_operation_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_run_data
    ADD CONSTRAINT fast_run_data_operation_uniq UNIQUE (operation_id);


--
-- Name: fast_run_data fast_run_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_run_data
    ADD CONSTRAINT fast_run_data_pkey PRIMARY KEY (id);


--
-- Name: filter_profiles filter_profiles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profiles
    ADD CONSTRAINT filter_profiles_name_key UNIQUE (name);


--
-- Name: filter_profiles filter_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profiles
    ADD CONSTRAINT filter_profiles_pkey PRIMARY KEY (id);


--
-- Name: force_crawler_state force_crawler_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.force_crawler_state
    ADD CONSTRAINT force_crawler_state_pkey PRIMARY KEY (id);


--
-- Name: insert_edges insert_edges_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_edges
    ADD CONSTRAINT insert_edges_code_unique UNIQUE (edge_code);


--
-- Name: insert_edges insert_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_edges
    ADD CONSTRAINT insert_edges_pkey PRIMARY KEY (edge_id);


--
-- Name: insert_types insert_types_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_types
    ADD CONSTRAINT insert_types_code_unique UNIQUE (type_code);


--
-- Name: insert_types insert_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_types
    ADD CONSTRAINT insert_types_pkey PRIMARY KEY (insert_type_id);


--
-- Name: machining_force_analysis machining_force_analysis_file_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_file_unique UNIQUE (directus_files_id);


--
-- Name: machining_force_analysis machining_force_analysis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_pkey PRIMARY KEY (id);


--
-- Name: manufacturers manufacturers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturers
    ADD CONSTRAINT manufacturers_name_key UNIQUE (name);


--
-- Name: manufacturers manufacturers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturers
    ADD CONSTRAINT manufacturers_pkey PRIMARY KEY (manufacturer_id);


--
-- Name: manufacturing_methods manufacturing_methods_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_methods
    ADD CONSTRAINT manufacturing_methods_code_unique UNIQUE (method_code);


--
-- Name: manufacturing_methods manufacturing_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_methods
    ADD CONSTRAINT manufacturing_methods_pkey PRIMARY KEY (method_id);


--
-- Name: manufacturing_operations manufacturing_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_pkey PRIMARY KEY (operation_id);


--
-- Name: material_alloying_elements material_alloying_elements_natural_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_alloying_elements
    ADD CONSTRAINT material_alloying_elements_natural_key UNIQUE (material_id, symbol);


--
-- Name: material_alloying_elements material_alloying_elements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_alloying_elements
    ADD CONSTRAINT material_alloying_elements_pkey PRIMARY KEY (id);


--
-- Name: material_iso_classifications material_iso_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_iso_classifications
    ADD CONSTRAINT material_iso_classifications_pkey PRIMARY KEY (iso_code);


--
-- Name: materials materials_alloy_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_alloy_code_unique UNIQUE (alloy_code);


--
-- Name: materials materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_pkey PRIMARY KEY (material_id);


--
-- Name: operation_data_files operation_data_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_data_files
    ADD CONSTRAINT operation_data_files_pkey PRIMARY KEY (id);


--
-- Name: operation_data_files operation_data_files_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_data_files
    ADD CONSTRAINT operation_data_files_unique UNIQUE (operation_id, directus_files_id);


--
-- Name: operation_files operation_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_files
    ADD CONSTRAINT operation_files_pkey PRIMARY KEY (file_id);


--
-- Name: operation_files operation_files_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_files
    ADD CONSTRAINT operation_files_unique UNIQUE (operation_id, file_path);


--
-- Name: people people_legacy_mo_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_legacy_mo_id_unique UNIQUE (legacy_machine_operator_id);


--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (person_id);


--
-- Name: people people_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_user_id_unique UNIQUE (user_id);


--
-- Name: physical_samples physical_samples_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_samples
    ADD CONSTRAINT physical_samples_code_unique UNIQUE (sample_code);


--
-- Name: physical_samples physical_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_samples
    ADD CONSTRAINT physical_samples_pkey PRIMARY KEY (sample_id);


--
-- Name: prep_recipe_steps prep_recipe_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_recipe_steps
    ADD CONSTRAINT prep_recipe_steps_pkey PRIMARY KEY (step_id);


--
-- Name: prep_recipes prep_recipes_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_recipes
    ADD CONSTRAINT prep_recipes_name_key UNIQUE (name);


--
-- Name: prep_recipes prep_recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_recipes
    ADD CONSTRAINT prep_recipes_pkey PRIMARY KEY (recipe_id);


--
-- Name: prep_steps prep_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_steps
    ADD CONSTRAINT prep_steps_pkey PRIMARY KEY (step_id);


--
-- Name: project_investigators project_investigators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_investigators
    ADD CONSTRAINT project_investigators_pkey PRIMARY KEY (id);


--
-- Name: project_investigators project_investigators_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_investigators
    ADD CONSTRAINT project_investigators_unique UNIQUE (project_id, user_id);


--
-- Name: project_rollup project_rollup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_rollup
    ADD CONSTRAINT project_rollup_pkey PRIMARY KEY (row_id);


--
-- Name: projects projects_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_code_unique UNIQUE (project_code);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (project_id);


--
-- Name: raw_stock_lots raw_stock_lots_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_stock_lots
    ADD CONSTRAINT raw_stock_lots_code_unique UNIQUE (lot_code);


--
-- Name: raw_stock_lots raw_stock_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_stock_lots
    ADD CONSTRAINT raw_stock_lots_pkey PRIMARY KEY (lot_id);


--
-- Name: sample_co_owners sample_co_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_co_owners
    ADD CONSTRAINT sample_co_owners_pkey PRIMARY KEY (id);


--
-- Name: sample_co_owners sample_co_owners_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_co_owners
    ADD CONSTRAINT sample_co_owners_unique UNIQUE (sample_id, user_id);


--
-- Name: sample_data_files sample_data_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_data_files
    ADD CONSTRAINT sample_data_files_pkey PRIMARY KEY (id);


--
-- Name: sample_data_files sample_data_files_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_data_files
    ADD CONSTRAINT sample_data_files_unique UNIQUE (sample_id, directus_files_id);


--
-- Name: sample_genealogy sample_genealogy_pair_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_genealogy
    ADD CONSTRAINT sample_genealogy_pair_unique UNIQUE (child_sample_id, parent_sample_id);


--
-- Name: sample_genealogy sample_genealogy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_genealogy
    ADD CONSTRAINT sample_genealogy_pkey PRIMARY KEY (id);


--
-- Name: sample_stock_provenance sample_stock_provenance_pair_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stock_provenance
    ADD CONSTRAINT sample_stock_provenance_pair_unique UNIQUE (sample_id, lot_id);


--
-- Name: sample_stock_provenance sample_stock_provenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stock_provenance
    ADD CONSTRAINT sample_stock_provenance_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: semantic_embeddings semantic_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semantic_embeddings
    ADD CONSTRAINT semantic_embeddings_pkey PRIMARY KEY (embedding_id);


--
-- Name: semantic_embeddings semantic_embeddings_source_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.semantic_embeddings
    ADD CONSTRAINT semantic_embeddings_source_uq UNIQUE (source_table, source_id, source_column, model_name);


--
-- Name: session_data_files session_data_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_data_files
    ADD CONSTRAINT session_data_files_pkey PRIMARY KEY (id);


--
-- Name: session_data_files session_data_files_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_data_files
    ADD CONSTRAINT session_data_files_unique UNIQUE (session_id, directus_files_id);


--
-- Name: test_sessions test_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: test_sessions_subject test_sessions_subject_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions_subject
    ADD CONSTRAINT test_sessions_subject_pkey PRIMARY KEY (id);


--
-- Name: tool_boxes tool_boxes_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_boxes
    ADD CONSTRAINT tool_boxes_code_unique UNIQUE (tool_box_code);


--
-- Name: tool_boxes tool_boxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_boxes
    ADD CONSTRAINT tool_boxes_pkey PRIMARY KEY (tool_box_id);


--
-- Name: tool_setup tool_setup_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_setup
    ADD CONSTRAINT tool_setup_code_unique UNIQUE (setup_code);


--
-- Name: tool_setup tool_setup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_setup
    ADD CONSTRAINT tool_setup_pkey PRIMARY KEY (setup_id);


--
-- Name: tools tools_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_code_unique UNIQUE (tool_code);


--
-- Name: tools tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (tool_id);


--
-- Name: archive_metadata_edits_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX archive_metadata_edits_file_idx ON public.archive_metadata_edits USING btree (directus_files_id);


--
-- Name: campaign_samples_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_samples_campaign_idx ON public.campaign_samples USING btree (campaign_id);


--
-- Name: campaign_samples_sample_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_samples_sample_idx ON public.campaign_samples USING btree (sample_id);


--
-- Name: diag_layer_analysis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX diag_layer_analysis_idx ON public.diag_layer USING btree (analysis_id);


--
-- Name: directus_activity_timestamp_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX directus_activity_timestamp_index ON public.directus_activity USING btree ("timestamp");


--
-- Name: directus_revisions_activity_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX directus_revisions_activity_index ON public.directus_revisions USING btree (activity);


--
-- Name: directus_revisions_parent_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX directus_revisions_parent_index ON public.directus_revisions USING btree (parent);


--
-- Name: fast_recipes_name_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fast_recipes_name_uniq ON public.fast_recipes USING btree (machine, lower(name)) WHERE (program_nr IS NULL);


--
-- Name: fast_recipes_prog_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fast_recipes_prog_uniq ON public.fast_recipes USING btree (machine, program_nr) WHERE (program_nr IS NOT NULL);


--
-- Name: fast_run_data_operation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fast_run_data_operation_id_idx ON public.fast_run_data USING btree (operation_id);


--
-- Name: fast_run_data_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fast_run_data_status_idx ON public.fast_run_data USING btree (status);


--
-- Name: idx_campaigns_campaign_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_campaign_type ON public.campaigns USING btree (campaign_type);


--
-- Name: idx_campaigns_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_project_id ON public.campaigns USING btree (project_id);


--
-- Name: idx_mfg_ops_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mfg_ops_campaign_id ON public.manufacturing_operations USING btree (campaign_id);


--
-- Name: idx_operation_files_operation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operation_files_operation_id ON public.operation_files USING btree (operation_id);


--
-- Name: idx_project_rollup_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_rollup_project_id ON public.project_rollup USING btree (project_id);


--
-- Name: idx_test_sessions_campaign_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_test_sessions_campaign_id ON public.test_sessions USING btree (campaign_id);


--
-- Name: insert_types_short_code_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX insert_types_short_code_unique ON public.insert_types USING btree (short_code) WHERE (short_code IS NOT NULL);


--
-- Name: machining_force_analysis_operation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machining_force_analysis_operation_id_idx ON public.machining_force_analysis USING btree (operation_id);


--
-- Name: machining_force_analysis_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX machining_force_analysis_status_idx ON public.machining_force_analysis USING btree (status);


--
-- Name: manufacturing_operations_code_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manufacturing_operations_code_sort_idx ON public.manufacturing_operations USING btree (code_sort);


--
-- Name: manufacturing_operations_fast_recipe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manufacturing_operations_fast_recipe_idx ON public.manufacturing_operations USING btree (fast_recipe_id);


--
-- Name: manufacturing_operations_metadata_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manufacturing_operations_metadata_gin_idx ON public.manufacturing_operations USING gin (recorded_metadata);


--
-- Name: manufacturing_operations_output_sample_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manufacturing_operations_output_sample_idx ON public.manufacturing_operations USING btree (output_sample_id);


--
-- Name: manufacturing_operations_sample_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX manufacturing_operations_sample_seq_idx ON public.manufacturing_operations USING btree (sample_id, operation_sequence);


--
-- Name: manufacturing_operations_source_run_uid_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX manufacturing_operations_source_run_uid_key ON public.manufacturing_operations USING btree (source_run_uid) WHERE (source_run_uid IS NOT NULL);


--
-- Name: physical_samples_code_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX physical_samples_code_sort_idx ON public.physical_samples USING btree (code_sort);


--
-- Name: prep_recipe_steps_recipe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prep_recipe_steps_recipe_idx ON public.prep_recipe_steps USING btree (recipe_id, step_order);


--
-- Name: prep_steps_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prep_steps_operation_idx ON public.prep_steps USING btree (operation_id, step_order);


--
-- Name: semantic_embeddings_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semantic_embeddings_hnsw_idx ON public.semantic_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: semantic_embeddings_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX semantic_embeddings_source_idx ON public.semantic_embeddings USING btree (source_table, source_id);


--
-- Name: test_sessions_subject_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_sessions_subject_parent_idx ON public.test_sessions_subject USING btree (test_sessions_id);


--
-- Name: test_sessions_subject_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_sessions_subject_target_idx ON public.test_sessions_subject USING btree (collection, item);


--
-- Name: audit_logs audit_logs_no_delete; Type: RULE; Schema: public; Owner: -
--

CREATE RULE audit_logs_no_delete AS
    ON DELETE TO public.audit_logs DO INSTEAD NOTHING;


--
-- Name: audit_logs audit_logs_no_update; Type: RULE; Schema: public; Owner: -
--

CREATE RULE audit_logs_no_update AS
    ON UPDATE TO public.audit_logs DO INSTEAD NOTHING;


--
-- Name: campaigns audit_campaigns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_campaigns AFTER INSERT OR DELETE OR UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: cutting_inserts audit_cutting_inserts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_cutting_inserts AFTER INSERT OR DELETE OR UPDATE ON public.cutting_inserts FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: insert_edges audit_insert_edges; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_insert_edges AFTER INSERT OR DELETE OR UPDATE ON public.insert_edges FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: manufacturing_operations audit_manufacturing_operations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_manufacturing_operations AFTER INSERT OR DELETE OR UPDATE ON public.manufacturing_operations FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: physical_samples audit_physical_samples; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_physical_samples AFTER INSERT OR DELETE OR UPDATE ON public.physical_samples FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: projects audit_projects; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_projects AFTER INSERT OR DELETE OR UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: raw_stock_lots audit_raw_stock_lots; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_raw_stock_lots AFTER INSERT OR DELETE OR UPDATE ON public.raw_stock_lots FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: test_sessions audit_test_sessions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_test_sessions AFTER INSERT OR DELETE OR UPDATE ON public.test_sessions FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: tool_boxes audit_tool_boxes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_tool_boxes AFTER INSERT OR DELETE OR UPDATE ON public.tool_boxes FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_function();


--
-- Name: machining_force_analysis diag_requeue_on_recipe_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER diag_requeue_on_recipe_change BEFORE UPDATE ON public.machining_force_analysis FOR EACH ROW EXECUTE FUNCTION public.diag_requeue_on_recipe_change();


--
-- Name: etchants etchants_occ; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER etchants_occ BEFORE UPDATE ON public.etchants FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: campaigns fill_campaign_code_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fill_campaign_code_trigger BEFORE INSERT ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.fill_campaign_code();


--
-- Name: cutting_inserts fill_cutting_insert_code_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fill_cutting_insert_code_trigger BEFORE INSERT ON public.cutting_inserts FOR EACH ROW EXECUTE FUNCTION public.fill_cutting_insert_code();


--
-- Name: insert_edges fill_insert_edge_code_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fill_insert_edge_code_trigger BEFORE INSERT ON public.insert_edges FOR EACH ROW EXECUTE FUNCTION public.fill_insert_edge_code();


--
-- Name: projects fill_project_code_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fill_project_code_trigger BEFORE INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION public.fill_project_code();


--
-- Name: tool_boxes fill_tool_box_code_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fill_tool_box_code_trigger BEFORE INSERT ON public.tool_boxes FOR EACH ROW EXECUTE FUNCTION public.fill_tool_box_code();


--
-- Name: manufacturing_operations mfg_op_genealogy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER mfg_op_genealogy AFTER INSERT OR UPDATE OF sample_id, output_sample_id, method_id ON public.manufacturing_operations FOR EACH ROW EXECUTE FUNCTION public.mfg_op_link_genealogy();


--
-- Name: campaigns occ_campaigns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_campaigns BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: cutting_inserts occ_cutting_inserts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_cutting_inserts BEFORE UPDATE ON public.cutting_inserts FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: equipment occ_equipment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_equipment BEFORE UPDATE ON public.equipment FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: insert_edges occ_insert_edges; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_insert_edges BEFORE UPDATE ON public.insert_edges FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: insert_types occ_insert_types; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_insert_types BEFORE UPDATE ON public.insert_types FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: manufacturing_methods occ_manufacturing_methods; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_manufacturing_methods BEFORE UPDATE ON public.manufacturing_methods FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: manufacturing_operations occ_manufacturing_operations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_manufacturing_operations BEFORE UPDATE ON public.manufacturing_operations FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: physical_samples occ_physical_samples; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_physical_samples BEFORE UPDATE ON public.physical_samples FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: projects occ_projects; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_projects BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: raw_stock_lots occ_raw_stock_lots; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_raw_stock_lots BEFORE UPDATE ON public.raw_stock_lots FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: test_sessions occ_test_sessions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_test_sessions BEFORE UPDATE ON public.test_sessions FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: tool_boxes occ_tool_boxes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_tool_boxes BEFORE UPDATE ON public.tool_boxes FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: tools occ_tools; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occ_tools BEFORE UPDATE ON public.tools FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: prep_recipe_steps prep_recipe_steps_occ; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prep_recipe_steps_occ BEFORE UPDATE ON public.prep_recipe_steps FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: prep_recipes prep_recipes_occ; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prep_recipes_occ BEFORE UPDATE ON public.prep_recipes FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: prep_steps prep_steps_occ; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prep_steps_occ BEFORE UPDATE ON public.prep_steps FOR EACH ROW EXECUTE FUNCTION public.occ_update_trigger_function();


--
-- Name: campaigns refresh_rollup_campaigns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refresh_rollup_campaigns AFTER INSERT OR DELETE OR UPDATE ON public.campaigns FOR EACH STATEMENT EXECUTE FUNCTION public.trg_refresh_project_rollup();


--
-- Name: manufacturing_operations refresh_rollup_ops; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refresh_rollup_ops AFTER INSERT OR DELETE OR UPDATE ON public.manufacturing_operations FOR EACH STATEMENT EXECUTE FUNCTION public.trg_refresh_project_rollup();


--
-- Name: Machine_Operators Machine_Operators_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine_Operators"
    ADD CONSTRAINT "Machine_Operators_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: archive_metadata_edits archive_metadata_edits_directus_files_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.archive_metadata_edits
    ADD CONSTRAINT archive_metadata_edits_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: campaign_samples campaign_samples_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_samples
    ADD CONSTRAINT campaign_samples_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(campaign_id) ON DELETE CASCADE;


--
-- Name: campaign_samples campaign_samples_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_samples
    ADD CONSTRAINT campaign_samples_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_default_equipment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_default_equipment_id_fkey FOREIGN KEY (default_equipment_id) REFERENCES public.equipment(equipment_id) ON DELETE SET NULL;


--
-- Name: campaigns campaigns_default_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_default_material_id_fkey FOREIGN KEY (default_material_id) REFERENCES public.materials(material_id) ON DELETE SET NULL;


--
-- Name: campaigns campaigns_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_owner_fkey FOREIGN KEY (owner) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: campaigns campaigns_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: campaigns campaigns_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id) ON DELETE SET NULL;


--
-- Name: cutting_inserts cutting_inserts_insert_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cutting_inserts
    ADD CONSTRAINT cutting_inserts_insert_type_id_fkey FOREIGN KEY (insert_type_id) REFERENCES public.insert_types(insert_type_id) ON DELETE SET NULL;


--
-- Name: cutting_inserts cutting_inserts_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cutting_inserts
    ADD CONSTRAINT cutting_inserts_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: cutting_inserts cutting_inserts_tool_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cutting_inserts
    ADD CONSTRAINT cutting_inserts_tool_box_id_fkey FOREIGN KEY (tool_box_id) REFERENCES public.tool_boxes(tool_box_id) ON DELETE CASCADE;


--
-- Name: diag_layer diag_layer_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diag_layer
    ADD CONSTRAINT diag_layer_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.machining_force_analysis(id) ON DELETE CASCADE;


--
-- Name: directus_access directus_access_policy_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_policy_foreign FOREIGN KEY (policy) REFERENCES public.directus_policies(id) ON DELETE CASCADE;


--
-- Name: directus_access directus_access_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE CASCADE;


--
-- Name: directus_access directus_access_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_access
    ADD CONSTRAINT directus_access_user_foreign FOREIGN KEY ("user") REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_collections directus_collections_group_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_collections
    ADD CONSTRAINT directus_collections_group_foreign FOREIGN KEY ("group") REFERENCES public.directus_collections(collection);


--
-- Name: directus_comments directus_comments_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_comments
    ADD CONSTRAINT directus_comments_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_comments directus_comments_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_comments
    ADD CONSTRAINT directus_comments_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: directus_dashboards directus_dashboards_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_dashboards
    ADD CONSTRAINT directus_dashboards_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_deployment_projects directus_deployment_projects_deployment_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_projects
    ADD CONSTRAINT directus_deployment_projects_deployment_foreign FOREIGN KEY (deployment) REFERENCES public.directus_deployments(id) ON DELETE CASCADE;


--
-- Name: directus_deployment_projects directus_deployment_projects_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_projects
    ADD CONSTRAINT directus_deployment_projects_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_deployment_runs directus_deployment_runs_project_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_runs
    ADD CONSTRAINT directus_deployment_runs_project_foreign FOREIGN KEY (project) REFERENCES public.directus_deployment_projects(id) ON DELETE CASCADE;


--
-- Name: directus_deployment_runs directus_deployment_runs_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployment_runs
    ADD CONSTRAINT directus_deployment_runs_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_deployments directus_deployments_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_deployments
    ADD CONSTRAINT directus_deployments_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_files directus_files_folder_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_folder_foreign FOREIGN KEY (folder) REFERENCES public.directus_folders(id) ON DELETE SET NULL;


--
-- Name: directus_files directus_files_modified_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_modified_by_foreign FOREIGN KEY (modified_by) REFERENCES public.directus_users(id);


--
-- Name: directus_files directus_files_uploaded_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_files
    ADD CONSTRAINT directus_files_uploaded_by_foreign FOREIGN KEY (uploaded_by) REFERENCES public.directus_users(id);


--
-- Name: directus_flows directus_flows_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_flows
    ADD CONSTRAINT directus_flows_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_folders directus_folders_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_folders
    ADD CONSTRAINT directus_folders_parent_foreign FOREIGN KEY (parent) REFERENCES public.directus_folders(id);


--
-- Name: directus_notifications directus_notifications_recipient_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications
    ADD CONSTRAINT directus_notifications_recipient_foreign FOREIGN KEY (recipient) REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_notifications directus_notifications_sender_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_notifications
    ADD CONSTRAINT directus_notifications_sender_foreign FOREIGN KEY (sender) REFERENCES public.directus_users(id);


--
-- Name: directus_operations directus_operations_flow_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_flow_foreign FOREIGN KEY (flow) REFERENCES public.directus_flows(id) ON DELETE CASCADE;


--
-- Name: directus_operations directus_operations_reject_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_reject_foreign FOREIGN KEY (reject) REFERENCES public.directus_operations(id);


--
-- Name: directus_operations directus_operations_resolve_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_resolve_foreign FOREIGN KEY (resolve) REFERENCES public.directus_operations(id);


--
-- Name: directus_operations directus_operations_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_operations
    ADD CONSTRAINT directus_operations_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_panels directus_panels_dashboard_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_panels
    ADD CONSTRAINT directus_panels_dashboard_foreign FOREIGN KEY (dashboard) REFERENCES public.directus_dashboards(id) ON DELETE CASCADE;


--
-- Name: directus_panels directus_panels_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_panels
    ADD CONSTRAINT directus_panels_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_permissions directus_permissions_policy_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_permissions
    ADD CONSTRAINT directus_permissions_policy_foreign FOREIGN KEY (policy) REFERENCES public.directus_policies(id) ON DELETE CASCADE;


--
-- Name: directus_presets directus_presets_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets
    ADD CONSTRAINT directus_presets_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE CASCADE;


--
-- Name: directus_presets directus_presets_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_presets
    ADD CONSTRAINT directus_presets_user_foreign FOREIGN KEY ("user") REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_revisions directus_revisions_activity_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_activity_foreign FOREIGN KEY (activity) REFERENCES public.directus_activity(id) ON DELETE CASCADE;


--
-- Name: directus_revisions directus_revisions_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_parent_foreign FOREIGN KEY (parent) REFERENCES public.directus_revisions(id);


--
-- Name: directus_revisions directus_revisions_version_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_revisions
    ADD CONSTRAINT directus_revisions_version_foreign FOREIGN KEY (version) REFERENCES public.directus_versions(id) ON DELETE CASCADE;


--
-- Name: directus_roles directus_roles_parent_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_roles
    ADD CONSTRAINT directus_roles_parent_foreign FOREIGN KEY (parent) REFERENCES public.directus_roles(id);


--
-- Name: directus_sessions directus_sessions_share_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sessions
    ADD CONSTRAINT directus_sessions_share_foreign FOREIGN KEY (share) REFERENCES public.directus_shares(id) ON DELETE CASCADE;


--
-- Name: directus_sessions directus_sessions_user_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_sessions
    ADD CONSTRAINT directus_sessions_user_foreign FOREIGN KEY ("user") REFERENCES public.directus_users(id) ON DELETE CASCADE;


--
-- Name: directus_settings directus_settings_project_logo_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_project_logo_foreign FOREIGN KEY (project_logo) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_background_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_background_foreign FOREIGN KEY (public_background) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_favicon_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_favicon_foreign FOREIGN KEY (public_favicon) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_foreground_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_foreground_foreign FOREIGN KEY (public_foreground) REFERENCES public.directus_files(id);


--
-- Name: directus_settings directus_settings_public_registration_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_public_registration_role_foreign FOREIGN KEY (public_registration_role) REFERENCES public.directus_roles(id) ON DELETE SET NULL;


--
-- Name: directus_settings directus_settings_storage_default_folder_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_settings
    ADD CONSTRAINT directus_settings_storage_default_folder_foreign FOREIGN KEY (storage_default_folder) REFERENCES public.directus_folders(id) ON DELETE SET NULL;


--
-- Name: directus_shares directus_shares_collection_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_collection_foreign FOREIGN KEY (collection) REFERENCES public.directus_collections(collection) ON DELETE CASCADE;


--
-- Name: directus_shares directus_shares_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE CASCADE;


--
-- Name: directus_shares directus_shares_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_shares
    ADD CONSTRAINT directus_shares_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_users directus_users_role_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_users
    ADD CONSTRAINT directus_users_role_foreign FOREIGN KEY (role) REFERENCES public.directus_roles(id) ON DELETE SET NULL;


--
-- Name: directus_versions directus_versions_collection_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_collection_foreign FOREIGN KEY (collection) REFERENCES public.directus_collections(collection) ON DELETE CASCADE;


--
-- Name: directus_versions directus_versions_user_created_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_user_created_foreign FOREIGN KEY (user_created) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: directus_versions directus_versions_user_updated_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.directus_versions
    ADD CONSTRAINT directus_versions_user_updated_foreign FOREIGN KEY (user_updated) REFERENCES public.directus_users(id);


--
-- Name: equipment equipment_facility_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES public.facilities(facility_id) ON DELETE SET NULL;


--
-- Name: equipment equipment_image_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_image_fkey FOREIGN KEY (image) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: equipment equipment_manufacturer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES public.manufacturers(manufacturer_id) ON DELETE SET NULL;


--
-- Name: equipment equipment_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id) ON DELETE SET NULL;


--
-- Name: etchants etchants_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etchants
    ADD CONSTRAINT etchants_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: fast_run_data fast_run_data_directus_files_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_run_data
    ADD CONSTRAINT fast_run_data_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: fast_run_data fast_run_data_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_run_data
    ADD CONSTRAINT fast_run_data_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.manufacturing_operations(operation_id) ON DELETE CASCADE;


--
-- Name: fast_run_data fast_run_data_staged_file_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fast_run_data
    ADD CONSTRAINT fast_run_data_staged_file_fkey FOREIGN KEY (staged_file) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: insert_edges insert_edges_insert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_edges
    ADD CONSTRAINT insert_edges_insert_id_fkey FOREIGN KEY (insert_id) REFERENCES public.cutting_inserts(insert_id) ON DELETE CASCADE;


--
-- Name: insert_edges insert_edges_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_edges
    ADD CONSTRAINT insert_edges_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: insert_types insert_types_image_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_types
    ADD CONSTRAINT insert_types_image_fkey FOREIGN KEY (image) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: insert_types insert_types_manufacturer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insert_types
    ADD CONSTRAINT insert_types_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES public.manufacturers(manufacturer_id) ON DELETE SET NULL;


--
-- Name: Machine_Operators machine_operators_equipment_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine_Operators"
    ADD CONSTRAINT machine_operators_equipment_foreign FOREIGN KEY (equipment) REFERENCES public.equipment(equipment_id) ON DELETE SET NULL;


--
-- Name: Machine_Operators machine_operators_photo_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Machine_Operators"
    ADD CONSTRAINT machine_operators_photo_foreign FOREIGN KEY (photo) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: machining_force_analysis machining_force_analysis_directus_files_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE CASCADE;


--
-- Name: machining_force_analysis machining_force_analysis_frm_fx_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_frm_fx_fkey FOREIGN KEY (frm_fx) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: machining_force_analysis machining_force_analysis_frm_fy_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_frm_fy_fkey FOREIGN KEY (frm_fy) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: machining_force_analysis machining_force_analysis_frm_fz_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_frm_fz_fkey FOREIGN KEY (frm_fz) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: machining_force_analysis machining_force_analysis_live_cache_file_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_live_cache_file_fkey FOREIGN KEY (live_cache_file) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: machining_force_analysis machining_force_analysis_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.manufacturing_operations(operation_id) ON DELETE CASCADE;


--
-- Name: machining_force_analysis machining_force_analysis_render_file_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_render_file_fkey FOREIGN KEY (render_file) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: machining_force_analysis machining_force_analysis_tool_setup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.machining_force_analysis
    ADD CONSTRAINT machining_force_analysis_tool_setup_id_fkey FOREIGN KEY (tool_setup_id) REFERENCES public.tool_setup(setup_id) ON DELETE SET NULL;


--
-- Name: manufacturers manufacturers_logo_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturers
    ADD CONSTRAINT manufacturers_logo_foreign FOREIGN KEY ("Logo") REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(campaign_id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_equipment_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_equipment_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(equipment_id);


--
-- Name: manufacturing_operations manufacturing_operations_fast_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_fast_recipe_id_fkey FOREIGN KEY (fast_recipe_id) REFERENCES public.fast_recipes(id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_gcode_file_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_gcode_file_fkey FOREIGN KEY (gcode_file) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_insert_edge_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_insert_edge_fkey FOREIGN KEY (insert_edge_id) REFERENCES public.insert_edges(edge_id);


--
-- Name: manufacturing_operations manufacturing_operations_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(material_id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_method_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_method_fkey FOREIGN KEY (method_id) REFERENCES public.manufacturing_methods(method_id);


--
-- Name: manufacturing_operations manufacturing_operations_operator_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_operator_foreign FOREIGN KEY (operator) REFERENCES public."Machine_Operators"(id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_operator_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_operator_person_id_fkey FOREIGN KEY (operator_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_output_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_output_sample_id_fkey FOREIGN KEY (output_sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_project_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_project_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id);


--
-- Name: manufacturing_operations manufacturing_operations_sample_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_sample_fkey FOREIGN KEY (sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: manufacturing_operations manufacturing_operations_source_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_source_recipe_id_fkey FOREIGN KEY (source_recipe_id) REFERENCES public.prep_recipes(recipe_id) ON DELETE SET NULL;


--
-- Name: manufacturing_operations manufacturing_operations_tool_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_tool_fkey FOREIGN KEY (tool_id) REFERENCES public.tools(tool_id);


--
-- Name: material_alloying_elements material_alloying_elements_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_alloying_elements
    ADD CONSTRAINT material_alloying_elements_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(material_id) ON DELETE CASCADE;


--
-- Name: material_alloying_elements material_alloying_elements_symbol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_alloying_elements
    ADD CONSTRAINT material_alloying_elements_symbol_fkey FOREIGN KEY (symbol) REFERENCES public.alloying_elements(symbol) ON DELETE RESTRICT;


--
-- Name: materials materials_iso_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_iso_code_fkey FOREIGN KEY (iso_code) REFERENCES public.material_iso_classifications(iso_code);


--
-- Name: operation_data_files operation_data_files_directus_files_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_data_files
    ADD CONSTRAINT operation_data_files_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE CASCADE;


--
-- Name: operation_data_files operation_data_files_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_data_files
    ADD CONSTRAINT operation_data_files_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.manufacturing_operations(operation_id) ON DELETE CASCADE;


--
-- Name: operation_files operation_files_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operation_files
    ADD CONSTRAINT operation_files_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.manufacturing_operations(operation_id) ON DELETE CASCADE;


--
-- Name: people people_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: physical_samples physical_samples_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_samples
    ADD CONSTRAINT physical_samples_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(material_id);


--
-- Name: physical_samples physical_samples_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_samples
    ADD CONSTRAINT physical_samples_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: physical_samples physical_samples_primary_method_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_samples
    ADD CONSTRAINT physical_samples_primary_method_id_fkey FOREIGN KEY (primary_method_id) REFERENCES public.manufacturing_methods(method_id) ON DELETE SET NULL;


--
-- Name: physical_samples physical_samples_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.physical_samples
    ADD CONSTRAINT physical_samples_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id);


--
-- Name: prep_recipe_steps prep_recipe_steps_etchant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_recipe_steps
    ADD CONSTRAINT prep_recipe_steps_etchant_id_fkey FOREIGN KEY (etchant_id) REFERENCES public.etchants(etchant_id) ON DELETE SET NULL;


--
-- Name: prep_recipe_steps prep_recipe_steps_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_recipe_steps
    ADD CONSTRAINT prep_recipe_steps_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.prep_recipes(recipe_id) ON DELETE CASCADE;


--
-- Name: prep_recipes prep_recipes_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_recipes
    ADD CONSTRAINT prep_recipes_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: prep_steps prep_steps_etchant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_steps
    ADD CONSTRAINT prep_steps_etchant_id_fkey FOREIGN KEY (etchant_id) REFERENCES public.etchants(etchant_id) ON DELETE SET NULL;


--
-- Name: prep_steps prep_steps_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prep_steps
    ADD CONSTRAINT prep_steps_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.manufacturing_operations(operation_id) ON DELETE CASCADE;


--
-- Name: project_investigators project_investigators_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_investigators
    ADD CONSTRAINT project_investigators_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(person_id) ON DELETE CASCADE;


--
-- Name: project_investigators project_investigators_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_investigators
    ADD CONSTRAINT project_investigators_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id) ON DELETE CASCADE;


--
-- Name: projects projects_image_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_image_foreign FOREIGN KEY ("Image") REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: projects projects_principal_investigator_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_principal_investigator_fkey FOREIGN KEY (principal_investigator) REFERENCES public.directus_users(id) ON DELETE SET NULL;


--
-- Name: projects projects_principal_investigator_person_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_principal_investigator_person_fkey FOREIGN KEY (principal_investigator_person) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: raw_stock_lots raw_stock_lots_material_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_stock_lots
    ADD CONSTRAINT raw_stock_lots_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.materials(material_id);


--
-- Name: sample_co_owners sample_co_owners_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_co_owners
    ADD CONSTRAINT sample_co_owners_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(person_id) ON DELETE CASCADE;


--
-- Name: sample_co_owners sample_co_owners_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_co_owners
    ADD CONSTRAINT sample_co_owners_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: sample_data_files sample_data_files_directus_files_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_data_files
    ADD CONSTRAINT sample_data_files_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE CASCADE;


--
-- Name: sample_data_files sample_data_files_sample_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_data_files
    ADD CONSTRAINT sample_data_files_sample_id_fkey FOREIGN KEY (sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: sample_genealogy sample_genealogy_child_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_genealogy
    ADD CONSTRAINT sample_genealogy_child_fkey FOREIGN KEY (child_sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: sample_genealogy sample_genealogy_parent_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_genealogy
    ADD CONSTRAINT sample_genealogy_parent_fkey FOREIGN KEY (parent_sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: sample_stock_provenance sample_stock_provenance_lot_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stock_provenance
    ADD CONSTRAINT sample_stock_provenance_lot_fkey FOREIGN KEY (lot_id) REFERENCES public.raw_stock_lots(lot_id) ON DELETE CASCADE;


--
-- Name: sample_stock_provenance sample_stock_provenance_sample_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_stock_provenance
    ADD CONSTRAINT sample_stock_provenance_sample_fkey FOREIGN KEY (sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: session_data_files session_data_files_directus_files_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_data_files
    ADD CONSTRAINT session_data_files_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES public.directus_files(id) ON DELETE CASCADE;


--
-- Name: session_data_files session_data_files_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_data_files
    ADD CONSTRAINT session_data_files_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.test_sessions(session_id) ON DELETE CASCADE;


--
-- Name: test_sessions test_sessions_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(campaign_id) ON DELETE SET NULL;


--
-- Name: test_sessions test_sessions_equipment_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_equipment_fkey FOREIGN KEY (equipment_id) REFERENCES public.equipment(equipment_id);


--
-- Name: test_sessions test_sessions_insert_edge_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_insert_edge_fkey FOREIGN KEY (insert_edge_id) REFERENCES public.insert_edges(edge_id);


--
-- Name: test_sessions test_sessions_operator_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_operator_fkey FOREIGN KEY (operator) REFERENCES public."Machine_Operators"(id) ON DELETE SET NULL;


--
-- Name: test_sessions test_sessions_operator_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_operator_person_id_fkey FOREIGN KEY (operator_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: test_sessions test_sessions_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: test_sessions test_sessions_project_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_project_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id);


--
-- Name: test_sessions test_sessions_sample_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_sample_fkey FOREIGN KEY (sample_id) REFERENCES public.physical_samples(sample_id) ON DELETE CASCADE;


--
-- Name: test_sessions_subject test_sessions_subject_test_sessions_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions_subject
    ADD CONSTRAINT test_sessions_subject_test_sessions_id_fkey FOREIGN KEY (test_sessions_id) REFERENCES public.test_sessions(session_id) ON DELETE CASCADE;


--
-- Name: tool_boxes tool_boxes_insert_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_boxes
    ADD CONSTRAINT tool_boxes_insert_type_id_fkey FOREIGN KEY (insert_type_id) REFERENCES public.insert_types(insert_type_id);


--
-- Name: tool_boxes tool_boxes_owner_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_boxes
    ADD CONSTRAINT tool_boxes_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES public.people(person_id) ON DELETE SET NULL;


--
-- Name: tool_boxes tool_boxes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_boxes
    ADD CONSTRAINT tool_boxes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id) ON DELETE SET NULL;


--
-- Name: tools tools_image_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_image_fkey FOREIGN KEY (image) REFERENCES public.directus_files(id) ON DELETE SET NULL;


--
-- Name: tools tools_manufacturer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES public.manufacturers(manufacturer_id) ON DELETE SET NULL;


--
-- Name: tools tools_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(project_id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260618000001'),
    ('20260618000002'),
    ('20260618000003'),
    ('20260618000004'),
    ('20260618000005'),
    ('20260618000006'),
    ('20260618000007'),
    ('20260618000008'),
    ('20260618000009'),
    ('20260618000010'),
    ('20260618000011'),
    ('20260618000012'),
    ('20260619000013'),
    ('20260619000014'),
    ('20260619000015'),
    ('20260619000016'),
    ('20260620000017'),
    ('20260620000018'),
    ('20260620000019'),
    ('20260620000020'),
    ('20260620000021'),
    ('20260621000022'),
    ('20260621000023'),
    ('20260621000024'),
    ('20260621000025'),
    ('20260621000026'),
    ('20260621000027'),
    ('20260621000028'),
    ('20260622000029'),
    ('20260623000030'),
    ('20260623000031'),
    ('20260623000032'),
    ('20260624000030'),
    ('20260624000031'),
    ('20260624000032'),
    ('20260624000033'),
    ('20260624000034'),
    ('20260624000035'),
    ('20260625000036'),
    ('20260625000037'),
    ('20260625000038'),
    ('20260626000039'),
    ('20260627000040'),
    ('20260627000041'),
    ('20260627000042'),
    ('20260627000043'),
    ('20260627000044'),
    ('20260627000045'),
    ('20260627000046'),
    ('20260628000047'),
    ('20260628000048'),
    ('20260628000049'),
    ('20260629000050'),
    ('20260629000051'),
    ('20260701000052'),
    ('20260701000053'),
    ('20260703000054'),
    ('20260703000055'),
    ('20260703000056'),
    ('20260703000057'),
    ('20260703000058'),
    ('20260703000059'),
    ('20260703000060'),
    ('20260703000061'),
    ('20260703000062'),
    ('20260703000063'),
    ('20260703000064'),
    ('20260703000065'),
    ('20260703000066'),
    ('20260703000067'),
    ('20260704000068'),
    ('20260704000069'),
    ('20260704000070'),
    ('20260704000071'),
    ('20260704000072'),
    ('20260704000073'),
    ('20260705000035'),
    ('20260705000074'),
    ('20260705000075'),
    ('20260705000076'),
    ('20260705000077'),
    ('20260705000078'),
    ('20260706000079'),
    ('20260706000080'),
    ('20260708000081'),
    ('20260708000082'),
    ('20260708000083'),
    ('20260709000084'),
    ('20260710000085'),
    ('20260710000086'),
    ('20260710000087'),
    ('20260710000088'),
    ('20260710000089'),
    ('20260711000090'),
    ('20260711000091'),
    ('20260711000092'),
    ('20260712000093'),
    ('20260713000094'),
    ('20260717000095'),
    ('20260721000096'),
    ('20260721000097'),
    ('20260722000098'),
    ('20260722000099'),
    ('20260722000100'),
    ('20260722000101'),
    ('20260723000102'),
    ('20260828000103'),
    ('20260830000104'),
    ('20260831000105'),
    ('20260901000106'),
    ('20260903000107'),
    ('20260903000108'),
    ('20260903000109'),
    ('20260903000110'),
    ('20260911000111'),
    ('20260913000112'),
    ('20260918000113'),
    ('20260930000114'),
    ('20260930000115'),
    ('20260930000116'),
    ('20260930000117'),
    ('20260930000118');
