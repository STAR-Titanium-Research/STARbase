-- migrate:up transaction:false
-- Index on audit_logs (table_name, record_id), built CONCURRENTLY.
--
-- Migration 128 originally created this index in its own transaction with a plain CREATE INDEX,
-- which blocks every audited write (every INSERT/UPDATE/DELETE on a business table) for as long as
-- the build takes on a large audit_logs. CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, hence this separate file with dbmate's `transaction:false` option (it must be on both the
-- up and the down marker). It holds a single statement on purpose: dbmate sends a section in one
-- call, and Postgres runs several statements sent that way in an implicit transaction, which
-- CONCURRENTLY rejects. It runs after 128: 128's trigger works without the index, only slower, and
-- dbmate applies the files in version order.
--
-- Serves the common "history of this record" query. If a concurrent build is interrupted,
-- Postgres leaves an INVALID index behind and IF NOT EXISTS would then skip it: DROP INDEX the
-- invalid one and run the migration again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_table_record ON audit_logs (table_name, record_id);

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY IF EXISTS idx_audit_logs_table_record;
