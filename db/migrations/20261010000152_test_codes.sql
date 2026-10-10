-- migrate:up
-- Test codes (stream T0a, spec docs/superpowers/specs/2026-10-10-record-codes-design.md §2).
--
-- Why: a test session had no code, so it could not be searched for, written on a sample bag or
-- named in a file. The code is {subject code}-{TYPE}{n}, e.g. 116-RK-MH-2024-12-18-SEM1:
--   * subject = the earliest linked valid subject of the test, sample or insert edge (across
--     both kinds, so adding a sample to an edge test does not rename it);
--   * n = the next number for (subject, type) from test_code_counters, never reused;
--   * the code follows the subject and the type: a new number when either changes, the same
--     number when only the subject's own code is corrected (cascade triggers below);
--   * a code written by a person is kept (test_code_is_manual); clearing it goes back to
--     automatic; a test that loses all its subjects keeps its last code.
-- The number is drawn when a subject is linked: Directus inserts the test first and the
-- junction rows after, and the junction's sync issues the UPDATE this trigger acts on.

ALTER TABLE test_sessions
    ADD COLUMN test_code TEXT,
    ADD COLUMN test_code_number INTEGER CHECK (test_code_number > 0),
    ADD COLUMN test_code_type TEXT,
    ADD COLUMN test_code_is_manual BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN test_code_subject_collection TEXT
        CHECK (test_code_subject_collection IN ('physical_samples', 'insert_edges')),
    ADD COLUMN test_code_subject_id UUID,
    ADD CONSTRAINT test_sessions_test_code_unique UNIQUE (test_code);

COMMENT ON COLUMN test_sessions.test_code IS
    'Readable test code, {subject code}-{TYPE}{n} (e.g. 116-RK-MH-2024-12-18-SEM1). Assigned by the database when the first subject is linked; follows the subject and type unless typed by hand (test_code_is_manual). Unique.';
COMMENT ON COLUMN test_sessions.test_code_number IS 'The n of an automatic test_code, drawn from test_code_counters.';
COMMENT ON COLUMN test_sessions.test_code_type IS 'The test_type the current number was drawn for; a different test_type draws a new number.';
COMMENT ON COLUMN test_sessions.test_code_is_manual IS 'True when test_code was written by a person: it is then kept as written. Clearing test_code sets it back to false.';
COMMENT ON COLUMN test_sessions.test_code_subject_collection IS 'Kind of subject the automatic code is built on: physical_samples or insert_edges.';
COMMENT ON COLUMN test_sessions.test_code_subject_id IS 'The subject the automatic code is built on (sample_id or edge_id; no FK, the subject may be removed and the code kept).';

CREATE FUNCTION test_type_code(p_test_type TEXT)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT CASE p_test_type
        WHEN 'tensile' THEN 'TEN' WHEN 'hardness' THEN 'HRD' WHEN 'charpy' THEN 'CHP'
        WHEN 'compression' THEN 'CMP' WHEN 'tribology' THEN 'TRB' WHEN 'optical_microscopy' THEN 'OM'
        WHEN 'sem' THEN 'SEM' WHEN 'tem' THEN 'TEM' WHEN 'xrd' THEN 'XRD' WHEN 'alicona' THEN 'ALI'
        WHEN 'clemx' THEN 'CLX' WHEN 'dct' THEN 'DCT' WHEN 'ct_scan' THEN 'CT' WHEN 'fatigue' THEN 'FAT'
        WHEN 'creep' THEN 'CRP' WHEN 'dma' THEN 'DMA' WHEN 'other' THEN 'OTH'
    END;
$$;

COMMENT ON FUNCTION test_type_code(TEXT) IS 'The test-code abbreviation of a test_type (sem -> SEM, hardness -> HRD ...); NULL for an unknown or missing type.';

CREATE FUNCTION test_code_subject(p_session_id UUID, OUT collection TEXT, OUT subject_id UUID, OUT subject_code TEXT)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $$
    SELECT s.collection, coalesce(p.sample_id, e.edge_id), coalesce(p.sample_code, e.edge_code)
    FROM public.test_sessions_subject s
    LEFT JOIN public.physical_samples p
           ON s.collection = 'physical_samples'
          AND p.sample_id = CASE WHEN s.item ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 THEN lower(s.item)::uuid END
    LEFT JOIN public.insert_edges e
           ON s.collection = 'insert_edges'
          AND e.edge_id = CASE WHEN s.item ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                               THEN lower(s.item)::uuid END
    WHERE s.test_sessions_id = p_session_id
      AND (p.sample_id IS NOT NULL OR e.edge_id IS NOT NULL)
    ORDER BY s.linked_at, s.id
    LIMIT 1;
$$;

COMMENT ON FUNCTION test_code_subject(UUID) IS
    'The subject a test''s code is built on: its earliest linked valid subject, sample or insert edge, with that subject''s code. No row when it has none.';

CREATE TABLE test_code_counters (
    subject_collection TEXT NOT NULL CHECK (subject_collection IN ('physical_samples', 'insert_edges')),
    subject_id         UUID NOT NULL,
    test_type          TEXT NOT NULL,
    last_number        INTEGER NOT NULL CHECK (last_number > 0),
    PRIMARY KEY (subject_collection, subject_id, test_type)
);

COMMENT ON TABLE test_code_counters IS
    'Bookkeeping for test codes: the last number handed out per (subject, test type), so a number is never handed out twice. Written only by next_test_code_number(); no OCC or audit (no user edits it).';
COMMENT ON COLUMN test_code_counters.subject_collection IS 'physical_samples or insert_edges.';
COMMENT ON COLUMN test_code_counters.subject_id IS 'The sample or edge (no FK: the counter outlives a deleted subject, which keeps numbers from being reused).';
COMMENT ON COLUMN test_code_counters.test_type IS 'The test_type the numbers are for.';
COMMENT ON COLUMN test_code_counters.last_number IS 'The highest number handed out so far.';

CREATE FUNCTION next_test_code_number(p_collection TEXT, p_subject_id UUID, p_test_type TEXT)
    RETURNS INTEGER
    LANGUAGE sql
    SET search_path = pg_catalog, public
AS $$
    INSERT INTO public.test_code_counters AS c (subject_collection, subject_id, test_type, last_number)
    VALUES (p_collection, p_subject_id, p_test_type, 1)
    ON CONFLICT (subject_collection, subject_id, test_type)
    DO UPDATE SET last_number = c.last_number + 1
    RETURNING c.last_number;
$$;

COMMENT ON FUNCTION next_test_code_number(TEXT, UUID, TEXT) IS
    'Hands out the next test-code number for (subject, test type); the counter row lock serialises concurrent callers.';

CREATE FUNCTION trg_test_sessions_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_sub  RECORD;
    v_abbr TEXT;
    v_n    INTEGER;
    v_code TEXT;
BEGIN
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
    IF NEW.test_code_number IS NULL
       OR NEW.test_code_subject_collection IS DISTINCT FROM v_sub.collection
       OR NEW.test_code_subject_id IS DISTINCT FROM v_sub.subject_id
       OR NEW.test_code_type IS DISTINCT FROM NEW.test_type THEN
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
        NEW.test_code := v_code;
    ELSE
        -- 5. Same subject, type and number: follow the subject's (possibly corrected) code.
        NEW.test_code := v_sub.subject_code || '-' || v_abbr || NEW.test_code_number;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_test_sessions_set_code() IS
    'BEFORE INSERT / UPDATE on test_sessions: keeps test_code = {subject code}-{TYPE}{n} up to date (spec 2026-10-10-record-codes §2). Typed codes are kept; clearing the code returns to automatic.';

CREATE TRIGGER test_sessions_set_code
    BEFORE INSERT OR UPDATE ON test_sessions
    FOR EACH ROW EXECUTE FUNCTION trg_test_sessions_set_code();

COMMENT ON TRIGGER test_sessions_set_code ON test_sessions IS 'Assigns and updates the automatic test_code.';

-- A corrected subject code flows into the automatic codes built on it (same numbers): clearing
-- the code makes the trigger above rebuild it with the number it already has.
-- Only tests whose code subject is still their primary subject (sample_id / insert_edge_id) and
-- whose type still matches the code are touched: a test that lost its subjects, or whose type was
-- cleared, keeps its code (clearing it here would leave NULL), and renaming a subject does not
-- lock rows of tests that have moved on.
CREATE FUNCTION trg_cascade_test_codes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    -- The triggers below deliberately have no UPDATE OF column list and no WHEN clause: Postgres
    -- refuses ALTER COLUMN TYPE on a column a trigger names, and migration 116 (natural-sort
    -- collation) alters sample_code and edge_code in both directions.
    IF TG_TABLE_NAME = 'physical_samples' THEN
        IF OLD.sample_code IS NOT DISTINCT FROM NEW.sample_code THEN RETURN NULL; END IF;
        UPDATE public.test_sessions
        SET test_code = NULL
        WHERE NOT test_code_is_manual
          AND test_code_subject_collection = 'physical_samples'
          AND test_code_subject_id = NEW.sample_id
          AND sample_id = NEW.sample_id
          AND test_type IS NOT DISTINCT FROM test_code_type;
    ELSE
        IF OLD.edge_code IS NOT DISTINCT FROM NEW.edge_code THEN RETURN NULL; END IF;
        UPDATE public.test_sessions
        SET test_code = NULL
        WHERE NOT test_code_is_manual
          AND test_code_subject_collection = 'insert_edges'
          AND test_code_subject_id = NEW.edge_id
          AND insert_edge_id = NEW.edge_id
          AND test_type IS NOT DISTINCT FROM test_code_type;
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trg_cascade_test_codes() IS
    'AFTER UPDATE on physical_samples / insert_edges, acts only when sample_code / edge_code changed: rebuilds the automatic test codes built on that subject, keeping their numbers. Only touches tests whose code subject is still their primary subject and whose type still matches the code (an orphaned test, or one whose type was cleared, keeps its code)';

CREATE TRIGGER physical_samples_cascade_test_codes
    AFTER UPDATE ON physical_samples
    FOR EACH ROW
    EXECUTE FUNCTION trg_cascade_test_codes();
CREATE TRIGGER insert_edges_cascade_test_codes
    AFTER UPDATE ON insert_edges
    FOR EACH ROW
    EXECUTE FUNCTION trg_cascade_test_codes();

COMMENT ON TRIGGER physical_samples_cascade_test_codes ON physical_samples IS 'A corrected sample code flows into its tests'' automatic codes.';
COMMENT ON TRIGGER insert_edges_cascade_test_codes ON insert_edges IS 'A corrected edge code flows into its tests'' automatic codes.';

INSERT INTO directus_fields (collection, field, interface, options, readonly, hidden, sort, width, note, searchable)
SELECT v.collection, v.field, v.interface, v.options::json, v.readonly, v.hidden, v.sort, v.width, v.note, TRUE
FROM (VALUES
    ('test_sessions', 'test_code', 'input',
     '{"placeholder":"Assigned automatically when a subject is linked","trim":true,"font":"monospace"}',
     FALSE, FALSE, 1, 'half',
     'Follows the subject and the test type. Type your own to keep it fixed; clear it to go back to automatic.'),
    ('test_sessions', 'test_code_number', 'input', NULL, TRUE, TRUE, 900, 'full', NULL),
    ('test_sessions', 'test_code_type', 'input', NULL, TRUE, TRUE, 901, 'full', NULL),
    ('test_sessions', 'test_code_is_manual', 'boolean', NULL, TRUE, TRUE, 902, 'full', NULL),
    ('test_sessions', 'test_code_subject_collection', 'input', NULL, TRUE, TRUE, 903, 'full', NULL),
    ('test_sessions', 'test_code_subject_id', 'input', NULL, TRUE, TRUE, 904, 'full', NULL)
) AS v (collection, field, interface, options, readonly, hidden, sort, width, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- migrate:down
DELETE FROM directus_fields
WHERE collection = 'test_sessions'
  AND field IN ('test_code', 'test_code_number', 'test_code_type', 'test_code_is_manual',
                'test_code_subject_collection', 'test_code_subject_id');
DROP TRIGGER IF EXISTS insert_edges_cascade_test_codes ON insert_edges;
DROP TRIGGER IF EXISTS physical_samples_cascade_test_codes ON physical_samples;
DROP FUNCTION IF EXISTS trg_cascade_test_codes();
DROP TRIGGER IF EXISTS test_sessions_set_code ON test_sessions;
DROP FUNCTION IF EXISTS trg_test_sessions_set_code();
DROP FUNCTION IF EXISTS next_test_code_number(TEXT, UUID, TEXT);
DROP TABLE IF EXISTS test_code_counters;
DROP FUNCTION IF EXISTS test_code_subject(UUID);
DROP FUNCTION IF EXISTS test_type_code(TEXT);
ALTER TABLE test_sessions
    DROP CONSTRAINT IF EXISTS test_sessions_test_code_unique,
    DROP COLUMN IF EXISTS test_code_subject_id,
    DROP COLUMN IF EXISTS test_code_subject_collection,
    DROP COLUMN IF EXISTS test_code_is_manual,
    DROP COLUMN IF EXISTS test_code_type,
    DROP COLUMN IF EXISTS test_code_number,
    DROP COLUMN IF EXISTS test_code;
