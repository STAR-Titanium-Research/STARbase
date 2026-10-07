-- migrate:up
-- Review finding 5.1: refresh_project_rollup() (migration 051) rebuilds the whole project_rollup
-- cache with DELETE + INSERT ... SELECT FROM v_project_rollup, fired once per statement on
-- manufacturing_operations and campaigns. Two sessions writing DIFFERENT operations raced:
-- A's uncommitted refresh holds the old cache rows; B's DELETE waits, then finds them gone and
-- INSERTs the same row_ids A just committed -> "duplicate key value violates unique constraint
-- project_rollup_pkey", and B's user-facing write fails.
--
-- Fix: serialise the refreshes with a transaction-scoped advisory lock taken before the DELETE.
-- A waiting session then runs its refresh after the other has committed, and (READ COMMITTED,
-- fresh statement snapshot per statement inside the function) sees the committed cache and the
-- committed base rows, so the result is the live derivation either way. A genuinely incremental
-- per-project refresh is not clear-cut here (v_project_rollup is a multi-branch UNION over
-- operations, tests, tools and campaigns), so that is left for a materialised-view / async
-- refresh redesign; the cost stays O(rows in the rollup) per statement.
--
-- Caveat: the lock is held to the end of the transaction, so a transaction that updates rows
-- in an order that conflicts with another writer can now deadlock where it used to queue. The
-- server detects and aborts one side (SQLSTATE 40P01); callers retry as for any OCC conflict.
-- The operation and sample-code triggers (migrations 126, 127) take this same lock before their own
-- per-sample / counter locks, so the order is always rollup -> sample -> counter.
CREATE OR REPLACE FUNCTION refresh_project_rollup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Fixed key; xact-scoped so it is released on COMMIT or ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtextextended('refresh_project_rollup', 0));
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id)
    SELECT row_id, project_id, kind, code, detail, campaign_id FROM v_project_rollup;
END;
$$;

COMMENT ON FUNCTION refresh_project_rollup() IS
    'Rebuilds the project_rollup cache from v_project_rollup. Takes a transaction-scoped advisory '
    'lock first so concurrent refreshes queue instead of failing with a duplicate key (review 5.1).';

-- migrate:down
-- Restore the body from 20260629000051_project_rollup_table.sql (no lock, no comment).
CREATE OR REPLACE FUNCTION refresh_project_rollup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id)
    SELECT row_id, project_id, kind, code, detail, campaign_id FROM v_project_rollup;
END;
$$;

COMMENT ON FUNCTION refresh_project_rollup() IS NULL;
