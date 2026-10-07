-- migrate:up
-- Review finding 5.4: OCC triggers were missing on tables that carry the version / updated_at pair.
--
-- tool_setup (105) and diag_layer (108) declare version INTEGER and updated_at but never got the
-- occ_<table> BEFORE UPDATE trigger, so version never moved: a client following the documented
-- pattern (UPDATE ... WHERE version = <known>) could never detect a concurrent edit, and
-- updated_at stayed at its insert time. Attach the shared occ_update_trigger_function() to both.
--
-- Tables that have updated_at but NO version column (diag_recipes, fast_recipes, fast_run_data,
-- machining_force_analysis, force_crawler_state, semantic_embeddings) are deliberately left alone:
-- adding the column would change the Directus items API and the workers' write-back for tables
-- they own, and several are worker-written derived data. Add `version` plus the trigger in a
-- migration of their own if a table needs optimistic concurrency. schema_migrations.version is
-- dbmate's bookkeeping, not an OCC column.

CREATE TRIGGER occ_tool_setup
    BEFORE UPDATE ON tool_setup
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();

CREATE TRIGGER occ_diag_layer
    BEFORE UPDATE ON diag_layer
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();

COMMENT ON TRIGGER occ_tool_setup ON tool_setup IS
    'Optimistic concurrency: bumps version and updated_at on every UPDATE (occ_update_trigger_function).';
COMMENT ON TRIGGER occ_diag_layer ON diag_layer IS
    'Optimistic concurrency: bumps version and updated_at on every UPDATE (occ_update_trigger_function).';

-- migrate:down
DROP TRIGGER IF EXISTS occ_diag_layer ON diag_layer;
DROP TRIGGER IF EXISTS occ_tool_setup ON tool_setup;
