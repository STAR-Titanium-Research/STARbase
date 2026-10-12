-- migrate:up
-- The primary subject of a test is the earliest linked one (stream T0a, spec §2, decision Q34).
--
-- Why: test codes (next migration) are built from the primary subject, and 20261007000139 picks
-- the subject with the lowest junction id, a random UUID: linking a second sample could make it
-- the primary and rename the test. The junction gets the time each row was linked, and the sync
-- orders by it. Rows that exist before this migration are all stamped '-infinity' (a constant,
-- so they tie), and the id breaks the tie: their order is the old lowest-id rule, so no existing
-- test changes its primary subject. New rows get clock_timestamp() (not now(): two rows linked in
-- one transaction must still differ).

ALTER TABLE test_sessions_subject
    ADD COLUMN linked_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity';
ALTER TABLE test_sessions_subject
    ALTER COLUMN linked_at SET DEFAULT clock_timestamp();

COMMENT ON COLUMN test_sessions_subject.linked_at IS
    'When this subject was linked to the test. The earliest valid subject is the test''s primary subject (sync_test_session_primary_subject). Rows linked before this column existed carry -infinity, so among them the lowest junction id wins (the previous rule).';

CREATE OR REPLACE FUNCTION sync_test_session_primary_subject(p_session_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    v_uuid_re CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_sample  UUID;
    v_edge    UUID;
    r         RECORD;
BEGIN
    IF p_session_id IS NULL THEN
        RETURN;
    END IF;

    -- Serialise concurrent subject changes of one test: without the lock two transactions that
    -- each add or remove a subject could both read the junction before the other committed and
    -- the last writer would store a stale primary subject. Waits for any other transaction that
    -- is syncing (or editing) this test; a test row that is already gone is simply not locked.
    PERFORM 1 FROM test_sessions WHERE session_id = p_session_id FOR UPDATE;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'physical_samples'
        ORDER BY s.linked_at, s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM physical_samples p WHERE p.sample_id = r.item::uuid) THEN
            v_sample := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'insert_edges'
        ORDER BY s.linked_at, s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM insert_edges e WHERE e.edge_id = r.item::uuid) THEN
            v_edge := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    UPDATE test_sessions
    SET sample_id = v_sample,
        insert_edge_id = v_edge
    WHERE session_id = p_session_id
      AND (sample_id IS DISTINCT FROM v_sample OR insert_edge_id IS DISTINCT FROM v_edge);
END;
$$;

COMMENT ON FUNCTION sync_test_session_primary_subject(UUID) IS
    'Recomputes test_sessions.sample_id and insert_edge_id (derived from test_sessions_subject (primary subject); do not write directly) for one test: the earliest linked valid subject of each kind.';

INSERT INTO directus_fields (collection, field, interface, readonly, hidden, note)
SELECT 'test_sessions_subject', 'linked_at', 'datetime', TRUE, TRUE, 'When the subject was linked; the earliest is the primary subject.'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'test_sessions_subject' AND field = 'linked_at');

-- migrate:down
DELETE FROM directus_fields WHERE collection = 'test_sessions_subject' AND field = 'linked_at';

CREATE OR REPLACE FUNCTION sync_test_session_primary_subject(p_session_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    v_uuid_re CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_sample  UUID;
    v_edge    UUID;
    r         RECORD;
BEGIN
    IF p_session_id IS NULL THEN
        RETURN;
    END IF;

    -- Serialise concurrent subject changes of one test: without the lock two transactions that
    -- each add or remove a subject could both read the junction before the other committed and
    -- the last writer would store a stale primary subject. Waits for any other transaction that
    -- is syncing (or editing) this test; a test row that is already gone is simply not locked.
    PERFORM 1 FROM test_sessions WHERE session_id = p_session_id FOR UPDATE;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'physical_samples'
        ORDER BY s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM physical_samples p WHERE p.sample_id = r.item::uuid) THEN
            v_sample := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'insert_edges'
        ORDER BY s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM insert_edges e WHERE e.edge_id = r.item::uuid) THEN
            v_edge := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    UPDATE test_sessions
    SET sample_id = v_sample,
        insert_edge_id = v_edge
    WHERE session_id = p_session_id
      AND (sample_id IS DISTINCT FROM v_sample OR insert_edge_id IS DISTINCT FROM v_edge);
END;
$$;

COMMENT ON FUNCTION sync_test_session_primary_subject(UUID) IS
    'Recomputes test_sessions.sample_id and insert_edge_id (derived from test_sessions_subject (primary subject); do not write directly) for one test.';

ALTER TABLE test_sessions_subject DROP COLUMN IF EXISTS linked_at;
