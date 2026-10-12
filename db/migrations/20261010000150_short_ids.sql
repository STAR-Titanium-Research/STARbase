-- migrate:up
-- Short IDs (stream T0a, spec docs/superpowers/specs/2026-10-10-record-codes-design.md §1).
--
-- Why: codes (sample, operation, test) now follow their fields and can change, and a printed
-- label, a finder search or a note needs a handle that never changes. The records' UUIDs never
-- change but are 36 characters long. The short ID is the first 8 hex characters of the UUID,
-- lengthened one character at a time on a clash, unique across samples, operations and tests
-- together (one registry), and never changed or reused.
--
-- No advisory lock: a global lock taken in a BEFORE trigger on manufacturing_operations would
-- invert the lock order against mfg_op_assign_numbers (rollup lock first). The registry's
-- primary key settles races: INSERT ... ON CONFLICT DO NOTHING, and try a longer prefix.
-- Registry rows are kept when a record is deleted, so a deleted sample's label never resolves to
-- a different record.

-- The back-fill below takes ACCESS EXCLUSIVE on physical_samples, manufacturing_operations and
-- test_sessions. If live writers hold locks on them the migration fails fast instead of queueing
-- every Directus read behind it. Apply only through dbmate (one transaction: `psql -f` failing
-- mid-back-fill would leave the user triggers disabled), ideally with Directus stopped.
SET LOCAL lock_timeout = '10s';

CREATE TABLE short_ids (
    short_id   TEXT PRIMARY KEY CHECK (short_id ~ '^[0-9a-f]{8,32}$'),
    collection TEXT NOT NULL CHECK (collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions')),
    record_id  UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT short_ids_record_unique UNIQUE (collection, record_id)
);

COMMENT ON TABLE short_ids IS
    'Registry of permanent short IDs (first 8+ hex characters of the record UUID) for physical_samples, manufacturing_operations and test_sessions. Unique across the three tables; rows are never deleted, so an ID is never reused. Bookkeeping: written only by claim_short_id().';
COMMENT ON COLUMN short_ids.short_id IS 'The short ID: lower-case hex, 8 characters, more only after a clash.';
COMMENT ON COLUMN short_ids.collection IS 'Which table the record is in.';
COMMENT ON COLUMN short_ids.record_id IS 'The record''s primary key (sample_id, operation_id or session_id). The record may since have been deleted.';
COMMENT ON COLUMN short_ids.created_at IS 'When the short ID was assigned.';

CREATE FUNCTION claim_short_id(p_collection TEXT, p_record_id UUID)
    RETURNS TEXT
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_hex TEXT := replace(p_record_id::text, '-', '');
    v_len INTEGER := 8;
    v_got TEXT;
BEGIN
    SELECT s.short_id INTO v_got
    FROM public.short_ids s
    WHERE s.collection = p_collection AND s.record_id = p_record_id;
    IF v_got IS NOT NULL THEN
        RETURN v_got;
    END IF;
    LOOP
        INSERT INTO public.short_ids (short_id, collection, record_id)
        VALUES (left(v_hex, v_len), p_collection, p_record_id)
        ON CONFLICT (short_id) DO NOTHING
        RETURNING short_id INTO v_got;
        IF v_got IS NOT NULL THEN
            RETURN v_got;
        END IF;
        v_len := v_len + 1;
        IF v_len > 32 THEN
            RAISE EXCEPTION 'no free short ID for % %', p_collection, p_record_id;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION claim_short_id(TEXT, UUID) IS
    'Returns the record''s short ID, assigning it on first call: the shortest unused prefix (8+ hex characters) of the UUID, registered in short_ids.';

CREATE FUNCTION trg_assign_short_id()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- TG_ARGV[0] names the primary-key column; defaults are filled before BEFORE triggers.
        NEW.short_id := public.claim_short_id(TG_TABLE_NAME, (to_jsonb(NEW) ->> TG_ARGV[0])::uuid);
    ELSIF NEW.short_id IS DISTINCT FROM OLD.short_id THEN
        RAISE EXCEPTION 'short_id never changes (% %)', TG_TABLE_NAME, OLD.short_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_assign_short_id() IS
    'BEFORE INSERT / UPDATE OF short_id: assigns the short ID of a new record (argument: its primary-key column) and refuses any change to it.';

-- Columns first, nullable, so the back-fill can fill them.
ALTER TABLE physical_samples ADD COLUMN short_id TEXT;
ALTER TABLE manufacturing_operations ADD COLUMN short_id TEXT;
ALTER TABLE test_sessions ADD COLUMN short_id TEXT;

-- backfill:start
-- With the tables' user triggers off, so 10k rows do not each bump version, write an audit row
-- and refresh the rollup. Refuse to run if one is not in its normal state ('O'): ENABLE TRIGGER
-- USER below would switch a disabled trigger on and reset an ENABLE REPLICA / ENABLE ALWAYS one
-- to 'O'.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger
               WHERE NOT tgisinternal AND tgenabled <> 'O'
                 AND tgrelid IN ('physical_samples'::regclass, 'manufacturing_operations'::regclass,
                                 'test_sessions'::regclass)) THEN
        RAISE EXCEPTION 'a user trigger on physical_samples / manufacturing_operations / test_sessions is not enabled in its normal state (disabled, ENABLE REPLICA or ENABLE ALWAYS); restore it first (ENABLE TRIGGER USER below would change it)';
    END IF;
END $$;
ALTER TABLE physical_samples DISABLE TRIGGER USER;
ALTER TABLE manufacturing_operations DISABLE TRIGGER USER;
ALTER TABLE test_sessions DISABLE TRIGGER USER;
UPDATE physical_samples SET short_id = claim_short_id('physical_samples', sample_id);
UPDATE manufacturing_operations SET short_id = claim_short_id('manufacturing_operations', operation_id);
UPDATE test_sessions SET short_id = claim_short_id('test_sessions', session_id);
ALTER TABLE physical_samples ENABLE TRIGGER USER;
ALTER TABLE manufacturing_operations ENABLE TRIGGER USER;
ALTER TABLE test_sessions ENABLE TRIGGER USER;
-- backfill:end

ALTER TABLE physical_samples ALTER COLUMN short_id SET NOT NULL,
    ADD CONSTRAINT physical_samples_short_id_unique UNIQUE (short_id);
ALTER TABLE manufacturing_operations ALTER COLUMN short_id SET NOT NULL,
    ADD CONSTRAINT manufacturing_operations_short_id_unique UNIQUE (short_id);
ALTER TABLE test_sessions ALTER COLUMN short_id SET NOT NULL,
    ADD CONSTRAINT test_sessions_short_id_unique UNIQUE (short_id);

COMMENT ON COLUMN physical_samples.short_id IS
    'Permanent short ID (8+ hex characters of sample_id), unique across samples, operations and tests. Never changes; printed on labels. Assigned by trigger.';
COMMENT ON COLUMN manufacturing_operations.short_id IS
    'Permanent short ID (8+ hex characters of operation_id), unique across samples, operations and tests. Never changes. Assigned by trigger.';
COMMENT ON COLUMN test_sessions.short_id IS
    'Permanent short ID (8+ hex characters of session_id), unique across samples, operations and tests. Never changes. Assigned by trigger.';

CREATE TRIGGER physical_samples_short_id
    BEFORE INSERT OR UPDATE OF short_id ON physical_samples
    FOR EACH ROW EXECUTE FUNCTION trg_assign_short_id('sample_id');
CREATE TRIGGER mfg_op_short_id
    BEFORE INSERT OR UPDATE OF short_id ON manufacturing_operations
    FOR EACH ROW EXECUTE FUNCTION trg_assign_short_id('operation_id');
CREATE TRIGGER test_sessions_short_id
    BEFORE INSERT OR UPDATE OF short_id ON test_sessions
    FOR EACH ROW EXECUTE FUNCTION trg_assign_short_id('session_id');

COMMENT ON TRIGGER physical_samples_short_id ON physical_samples IS 'Assigns and protects short_id.';
COMMENT ON TRIGGER mfg_op_short_id ON manufacturing_operations IS 'Assigns and protects short_id.';
COMMENT ON TRIGGER test_sessions_short_id ON test_sessions IS 'Assigns and protects short_id.';

CREATE FUNCTION record_by_short_id(p_short_id TEXT)
    RETURNS TABLE (collection TEXT, record_id UUID)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $$
    SELECT s.collection, s.record_id
    FROM public.short_ids s
    WHERE s.short_id = lower(btrim(p_short_id))
      AND CASE s.collection
              WHEN 'physical_samples' THEN EXISTS (SELECT 1 FROM public.physical_samples p WHERE p.sample_id = s.record_id)
              WHEN 'manufacturing_operations' THEN EXISTS (SELECT 1 FROM public.manufacturing_operations m WHERE m.operation_id = s.record_id)
              WHEN 'test_sessions' THEN EXISTS (SELECT 1 FROM public.test_sessions t WHERE t.session_id = s.record_id)
          END;
$$;

COMMENT ON FUNCTION record_by_short_id(TEXT) IS
    'Finds the live record with this short ID (case-insensitive): its table and primary key. No row when unknown or deleted.';

INSERT INTO directus_fields (collection, field, interface, options, readonly, hidden, sort, width, note, searchable)
SELECT v.collection, 'short_id', 'input', '{"font":"monospace"}'::json, TRUE, FALSE, v.sort, 'half',
       'Permanent ID: never changes. Printed on labels; type it in the finder.', TRUE
FROM (VALUES ('physical_samples', 2), ('manufacturing_operations', 13), ('test_sessions', 1)) AS v (collection, sort)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = 'short_id');

-- migrate:down
DELETE FROM directus_fields
WHERE field = 'short_id' AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
DROP FUNCTION IF EXISTS record_by_short_id(TEXT);
DROP TRIGGER IF EXISTS test_sessions_short_id ON test_sessions;
DROP TRIGGER IF EXISTS mfg_op_short_id ON manufacturing_operations;
DROP TRIGGER IF EXISTS physical_samples_short_id ON physical_samples;
ALTER TABLE test_sessions DROP COLUMN IF EXISTS short_id;
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS short_id;
ALTER TABLE physical_samples DROP COLUMN IF EXISTS short_id;
DROP FUNCTION IF EXISTS trg_assign_short_id();
DROP FUNCTION IF EXISTS claim_short_id(TEXT, UUID);
DROP TABLE IF EXISTS short_ids;
