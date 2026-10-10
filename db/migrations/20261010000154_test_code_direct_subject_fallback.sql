-- migrate:up
-- Test codes: a subject written directly on the test is coded too (stream T0a follow-up to 152).
--
-- Why (found on the live database 2026-10-10, during a demo): trg_test_sessions_set_code() found
-- the code's subject only through the junction test_sessions_subject. Directus inserts a test
-- first and its junction rows after; normally the junction's AFTER trigger
-- test_sessions_subject_sync_primary then UPDATEs test_sessions.sample_id, which re-fires this
-- BEFORE trigger and assigns the code. But when the client writes sample_id (or insert_edge_id)
-- directly in the INSERT, e.g. Directus "Save as copy", which copies the hidden derived sample_id,
-- or an importer that sets sample_id, the junction insert that follows derives the same primary,
-- the sync's UPDATE changes nothing (it only updates when the value changes), this trigger never
-- runs again, and the test stays with NO code. Reproduced on live: a copy POSTed with sample_id set
-- and a nested subject create got test_code = NULL.
--
-- The fix: when the junction yields no subject, fall back to the directly written sample_id, else
-- insert_edge_id (when that row exists). Nothing else changes. A test that loses all its
-- subjects still keeps its last code: the sync then sets sample_id / insert_edge_id to NULL, so
-- the fallback finds nothing and step 3 keeps the code. The cascade on a corrected sample / edge
-- code (trg_cascade_test_codes) filters on sample_id / insert_edge_id and the code's type, which
-- fallback-coded tests satisfy, so they follow a renamed subject like any other.
-- Only the function body is replaced; the trigger itself is unchanged.

CREATE OR REPLACE FUNCTION trg_test_sessions_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_sub  RECORD;
    v_abbr TEXT;
    v_n    INTEGER;
    v_code TEXT;
    v_draw BOOLEAN;
BEGIN
    -- The bookkeeping columns belong to this trigger, not to the client: a client that clones a
    -- test (Directus "Save as copy", GET-then-POST) would otherwise carry the source's number and
    -- subject along, and clearing the copied code would rebuild the source's exact code.
    IF TG_OP = 'INSERT' THEN
        NEW.test_code_number := NULL;
        NEW.test_code_type := NULL;
        NEW.test_code_subject_collection := NULL;
        NEW.test_code_subject_id := NULL;
    ELSE
        NEW.test_code_number := OLD.test_code_number;
        NEW.test_code_type := OLD.test_code_type;
        NEW.test_code_subject_collection := OLD.test_code_subject_collection;
        NEW.test_code_subject_id := OLD.test_code_subject_id;
    END IF;

    -- Fast exit: nothing the code depends on changed.
    IF TG_OP = 'UPDATE'
       AND NEW.test_code IS NOT DISTINCT FROM OLD.test_code
       AND NEW.test_code_is_manual IS NOT DISTINCT FROM OLD.test_code_is_manual
       AND NEW.test_type IS NOT DISTINCT FROM OLD.test_type
       AND NEW.sample_id IS NOT DISTINCT FROM OLD.sample_id
       AND NEW.insert_edge_id IS NOT DISTINCT FROM OLD.insert_edge_id THEN
        RETURN NEW;
    END IF;

    -- 1. A code written by a person is kept; a cleared code goes back to automatic.
    IF TG_OP = 'INSERT' THEN
        IF nullif(btrim(NEW.test_code), '') IS NOT NULL THEN
            NEW.test_code := btrim(NEW.test_code);
            NEW.test_code_is_manual := TRUE;
            RETURN NEW;
        END IF;
        NEW.test_code := NULL;
        NEW.test_code_is_manual := FALSE;
    ELSIF NEW.test_code IS DISTINCT FROM OLD.test_code THEN
        IF nullif(btrim(NEW.test_code), '') IS NULL THEN
            NEW.test_code := NULL;
            NEW.test_code_is_manual := FALSE;
        ELSE
            NEW.test_code := btrim(NEW.test_code);
            NEW.test_code_is_manual := TRUE;
            RETURN NEW;
        END IF;
    END IF;

    -- 2. Typed codes are left alone.
    IF NEW.test_code_is_manual THEN
        RETURN NEW;
    END IF;

    -- 3. No subject (or no type): keep whatever code there is.
    SELECT * INTO v_sub FROM public.test_code_subject(NEW.session_id);
    -- 3a. The junction has no subject (yet): use the subject written directly on the test. Directus
    -- "Save as copy" and importers write sample_id / insert_edge_id in the INSERT; the junction
    -- rows follow, the sync's UPDATE is then a no-op and this trigger would not run again.
    -- Once the last junction row is removed the sync clears both columns, so a test that lost all
    -- its subjects finds nothing here and keeps its code (step 3).
    IF v_sub.subject_id IS NULL THEN
        IF NEW.sample_id IS NOT NULL THEN
            SELECT 'physical_samples', p.sample_id, p.sample_code
              INTO v_sub.collection, v_sub.subject_id, v_sub.subject_code
              FROM public.physical_samples p WHERE p.sample_id = NEW.sample_id;
        END IF;
        IF v_sub.subject_id IS NULL AND NEW.insert_edge_id IS NOT NULL THEN
            SELECT 'insert_edges', e.edge_id, e.edge_code
              INTO v_sub.collection, v_sub.subject_id, v_sub.subject_code
              FROM public.insert_edges e WHERE e.edge_id = NEW.insert_edge_id;
        END IF;
    END IF;
    v_abbr := public.test_type_code(NEW.test_type);
    IF v_sub.subject_id IS NULL OR v_sub.subject_code IS NULL OR v_abbr IS NULL THEN
        RETURN NEW;
    END IF;

    -- 4. New subject, new type or no number yet: draw the next free number.
    v_draw := NEW.test_code_number IS NULL
           OR NEW.test_code_subject_collection IS DISTINCT FROM v_sub.collection
           OR NEW.test_code_subject_id IS DISTINCT FROM v_sub.subject_id
           OR NEW.test_code_type IS DISTINCT FROM NEW.test_type;
    IF NOT v_draw THEN
        -- 5. Same subject, type and number: follow the subject's (possibly corrected) code. If that
        -- code is already used by another test (typed by hand, or the subject was renamed to a name
        -- another test's code is built on), draw a new number instead of failing on UNIQUE.
        v_code := v_sub.subject_code || '-' || v_abbr || NEW.test_code_number;
        v_draw := EXISTS (SELECT 1 FROM public.test_sessions t
                          WHERE t.test_code = v_code AND t.session_id <> NEW.session_id);
    END IF;
    IF v_draw THEN
        LOOP
            v_n := public.next_test_code_number(v_sub.collection, v_sub.subject_id, NEW.test_type);
            v_code := v_sub.subject_code || '-' || v_abbr || v_n;
            -- skip a number someone typed by hand on another test
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.test_sessions t
                                  WHERE t.test_code = v_code AND t.session_id <> NEW.session_id);
        END LOOP;
        NEW.test_code_number := v_n;
        NEW.test_code_type := NEW.test_type;
        NEW.test_code_subject_collection := v_sub.collection;
        NEW.test_code_subject_id := v_sub.subject_id;
    END IF;
    NEW.test_code := v_code;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_test_sessions_set_code() IS
    'BEFORE INSERT / UPDATE on test_sessions: keeps test_code = {subject code}-{TYPE}{n} up to date (spec 2026-10-10-record-codes §2). Typed codes are kept; clearing the code returns to automatic. The subject is the earliest linked junction subject, or, when the junction has none yet, the directly written sample_id / insert_edge_id (Save as copy, importers). The test_code_* bookkeeping columns are the trigger''s own: reset on INSERT, ignored on UPDATE.';

-- migrate:down
-- Back to migration 152's function, byte for byte.
CREATE OR REPLACE FUNCTION trg_test_sessions_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_sub  RECORD;
    v_abbr TEXT;
    v_n    INTEGER;
    v_code TEXT;
    v_draw BOOLEAN;
BEGIN
    -- The bookkeeping columns belong to this trigger, not to the client: a client that clones a
    -- test (Directus "Save as copy", GET-then-POST) would otherwise carry the source's number and
    -- subject along, and clearing the copied code would rebuild the source's exact code.
    IF TG_OP = 'INSERT' THEN
        NEW.test_code_number := NULL;
        NEW.test_code_type := NULL;
        NEW.test_code_subject_collection := NULL;
        NEW.test_code_subject_id := NULL;
    ELSE
        NEW.test_code_number := OLD.test_code_number;
        NEW.test_code_type := OLD.test_code_type;
        NEW.test_code_subject_collection := OLD.test_code_subject_collection;
        NEW.test_code_subject_id := OLD.test_code_subject_id;
    END IF;

    -- Fast exit: nothing the code depends on changed.
    IF TG_OP = 'UPDATE'
       AND NEW.test_code IS NOT DISTINCT FROM OLD.test_code
       AND NEW.test_code_is_manual IS NOT DISTINCT FROM OLD.test_code_is_manual
       AND NEW.test_type IS NOT DISTINCT FROM OLD.test_type
       AND NEW.sample_id IS NOT DISTINCT FROM OLD.sample_id
       AND NEW.insert_edge_id IS NOT DISTINCT FROM OLD.insert_edge_id THEN
        RETURN NEW;
    END IF;

    -- 1. A code written by a person is kept; a cleared code goes back to automatic.
    IF TG_OP = 'INSERT' THEN
        IF nullif(btrim(NEW.test_code), '') IS NOT NULL THEN
            NEW.test_code := btrim(NEW.test_code);
            NEW.test_code_is_manual := TRUE;
            RETURN NEW;
        END IF;
        NEW.test_code := NULL;
        NEW.test_code_is_manual := FALSE;
    ELSIF NEW.test_code IS DISTINCT FROM OLD.test_code THEN
        IF nullif(btrim(NEW.test_code), '') IS NULL THEN
            NEW.test_code := NULL;
            NEW.test_code_is_manual := FALSE;
        ELSE
            NEW.test_code := btrim(NEW.test_code);
            NEW.test_code_is_manual := TRUE;
            RETURN NEW;
        END IF;
    END IF;

    -- 2. Typed codes are left alone.
    IF NEW.test_code_is_manual THEN
        RETURN NEW;
    END IF;

    -- 3. No subject (or no type): keep whatever code there is.
    SELECT * INTO v_sub FROM public.test_code_subject(NEW.session_id);
    v_abbr := public.test_type_code(NEW.test_type);
    IF v_sub.subject_id IS NULL OR v_sub.subject_code IS NULL OR v_abbr IS NULL THEN
        RETURN NEW;
    END IF;

    -- 4. New subject, new type or no number yet: draw the next free number.
    v_draw := NEW.test_code_number IS NULL
           OR NEW.test_code_subject_collection IS DISTINCT FROM v_sub.collection
           OR NEW.test_code_subject_id IS DISTINCT FROM v_sub.subject_id
           OR NEW.test_code_type IS DISTINCT FROM NEW.test_type;
    IF NOT v_draw THEN
        -- 5. Same subject, type and number: follow the subject's (possibly corrected) code. If that
        -- code is already used by another test (typed by hand, or the subject was renamed to a name
        -- another test's code is built on), draw a new number instead of failing on UNIQUE.
        v_code := v_sub.subject_code || '-' || v_abbr || NEW.test_code_number;
        v_draw := EXISTS (SELECT 1 FROM public.test_sessions t
                          WHERE t.test_code = v_code AND t.session_id <> NEW.session_id);
    END IF;
    IF v_draw THEN
        LOOP
            v_n := public.next_test_code_number(v_sub.collection, v_sub.subject_id, NEW.test_type);
            v_code := v_sub.subject_code || '-' || v_abbr || v_n;
            -- skip a number someone typed by hand on another test
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.test_sessions t
                                  WHERE t.test_code = v_code AND t.session_id <> NEW.session_id);
        END LOOP;
        NEW.test_code_number := v_n;
        NEW.test_code_type := NEW.test_type;
        NEW.test_code_subject_collection := v_sub.collection;
        NEW.test_code_subject_id := v_sub.subject_id;
    END IF;
    NEW.test_code := v_code;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_test_sessions_set_code() IS
    'BEFORE INSERT / UPDATE on test_sessions: keeps test_code = {subject code}-{TYPE}{n} up to date (spec 2026-10-10-record-codes §2). Typed codes are kept; clearing the code returns to automatic. The test_code_* bookkeeping columns are the trigger''s own: reset on INSERT, ignored on UPDATE.';
