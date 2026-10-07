-- migrate:up transaction:false
-- Partial index for the lookup of audit_attribute_directus_activity() (migration 128), built
-- CONCURRENTLY (see 20261003000130 for why: a plain CREATE INDEX blocks every audited write, and
-- the section must hold one statement).
--
-- That trigger runs once per directus_activity row, that is per Directus write, and looks for this
-- transaction's audit rows that have no actor yet (actor_identity IS NULL AND event_timestamp =
-- transaction_timestamp()). Without an index that is a scan of the whole, ever-growing audit_logs
-- on every API write. The index is partial so the rows that already have an actor are not in it.
-- If a concurrent build is interrupted, DROP the INVALID index and run the migration again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_unattributed ON audit_logs (event_timestamp) WHERE actor_identity IS NULL;

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_logs_unattributed;
