-- migrate:up
-- Ask-the-database row-level security (A1a Task 5; spec docs/superpowers/specs/2026-10-12-record-access-design.md section 7).
--
-- The text-to-SQL plugin reads with ONE shared login (d1_llm_app, a member of d1_llm_readonly), so it cannot know which member is
-- asking: the policy is keyed on the role. d1_llm_readonly must never see a Restricted record, or a record under a Restricted
-- project, campaign or sample, whoever is asking. What is hidden is decided once by the recompute of migration 166
-- (d1_private.hidden_records, read through the SECURITY DEFINER d1_private.is_hidden), so this migration states no restriction logic
-- of its own: the five record tables carry one line each, the children say "my parent is visible" (which runs under the parent's own
-- policy), and project_rollup and semantic_embeddings are scoped the same way.
--
-- Per table: ENABLE ROW LEVEL SECURITY, a PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true) policy (every other
-- non-owner role keeps what it has: notably d1_embedder, which has SELECT, INSERT and UPDATE on semantic_embeddings by hand-made
-- grants, and whose INSERT ... ON CONFLICT DO UPDATE must keep working) and an AS RESTRICTIVE FOR SELECT TO d1_llm_readonly
-- policy. The owner (d1, which Directus and the migrations use) bypasses row security; it is NOT forced.
--
-- Tables: every table migration 20261003000132 grants the role (42). 21 are record-bound and get policies; the 21 reference
-- tables (materials, tools, equipment, ... listed in the assertion below and in tests/phase1_schema.sh) carry no record key and no
-- policy. A table granted to the role later must get a policy or join the reference list: the assertion at the end of this
-- migration and phase1 both fail otherwise.
--
-- Views: the nine granted v_* views ran as their owner and would bypass the policies. They become security_invoker (Postgres 16),
-- so they read the tables as the querying role. CREATE OR REPLACE VIEW without a WITH (...) clause resets the option: a later
-- migration that redefines any LLM-granted view must say WITH (security_invoker = true) (CONTRIBUTING, the db-migration skill;
-- phase1 asserts it). v_project_rollup (migration 167) reads the hidden set through is_hidden() so it works for the invoker.
--
-- Grants: USAGE on schema d1_private and EXECUTE on d1_private.is_hidden(text, uuid) go to the role. A policy expression runs with
-- the QUERYING role's privileges (only the function body runs as its owner), so without them every query on the five record tables
-- fails with "permission denied for schema d1_private" and Ask-DB breaks. d1_private.hidden_records and every other d1_private table
-- stay ungranted (the role must not list restricted ids). The SQL guard (plugins/llm-text-to-sql/app/lib/sql_guard.py) rejects
-- schema-qualified calls and every schema but public, so the model cannot call is_hidden.
--
-- semantic_embeddings carries (source_table, source_id), so it is scoped by what it embeds: a sample, operation or test row is
-- visible iff that record is visible; raw_stock_lots notes (a reference table, an embedding source of v_embeddings_source_notes)
-- are visible; any other source_table is hidden (fail closed).
SET LOCAL lock_timeout = '10s';

DO $do$
DECLARE
    r record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN
        RAISE EXCEPTION 'role d1_llm_readonly does not exist (migration 20261003000132 creates it)';
    END IF;

    GRANT USAGE ON SCHEMA d1_private TO d1_llm_readonly;
    GRANT EXECUTE ON FUNCTION d1_private.is_hidden(text, uuid) TO d1_llm_readonly;

    FOR r IN SELECT * FROM (VALUES
        -- the five record tables: one line each
        ('physical_samples',            $e$NOT d1_private.is_hidden('physical_samples', sample_id)$e$),
        ('manufacturing_operations',    $e$NOT d1_private.is_hidden('manufacturing_operations', operation_id)$e$),
        ('test_sessions',               $e$NOT d1_private.is_hidden('test_sessions', session_id)$e$),
        ('campaigns',                   $e$NOT d1_private.is_hidden('campaigns', campaign_id)$e$),
        ('projects',                    $e$NOT d1_private.is_hidden('projects', project_id)$e$),
        -- children: the parent is visible (the subquery runs under the parent's own policy)
        ('campaign_samples',            $e$campaign_id IN (SELECT campaign_id FROM campaigns) AND sample_id IN (SELECT sample_id FROM physical_samples)$e$),
        ('sample_genealogy',            $e$child_sample_id IN (SELECT sample_id FROM physical_samples) AND parent_sample_id IN (SELECT sample_id FROM physical_samples)$e$),
        ('sample_stock_provenance',     $e$sample_id IN (SELECT sample_id FROM physical_samples)$e$),
        ('sample_co_owners',            $e$sample_id IN (SELECT sample_id FROM physical_samples)$e$),
        ('sample_data_files',           $e$sample_id IN (SELECT sample_id FROM physical_samples)$e$),
        ('operation_data_files',        $e$operation_id IN (SELECT operation_id FROM manufacturing_operations)$e$),
        ('operation_files',             $e$operation_id IN (SELECT operation_id FROM manufacturing_operations)$e$),
        ('prep_steps',                  $e$operation_id IN (SELECT operation_id FROM manufacturing_operations)$e$),
        ('machining_force_analysis',    $e$operation_id IN (SELECT operation_id FROM manufacturing_operations)$e$),
        ('fast_run_data',               $e$operation_id IN (SELECT operation_id FROM manufacturing_operations)$e$),
        ('diag_layer',                  $e$analysis_id IN (SELECT id FROM machining_force_analysis)$e$),
        ('session_data_files',          $e$session_id IN (SELECT session_id FROM test_sessions)$e$),
        ('test_sessions_subject',       $e$test_sessions_id IN (SELECT session_id FROM test_sessions)$e$),
        ('project_investigators',       $e$project_id IN (SELECT project_id FROM projects)$e$),
        -- the rollup cache: its own flag (derived from hidden_records), the project and the campaign
        ('project_rollup',              $e$NOT restricted AND project_id IN (SELECT project_id FROM projects) AND (campaign_id IS NULL OR campaign_id IN (SELECT campaign_id FROM campaigns))$e$),
        -- what an embedding is about
        ('semantic_embeddings',         $e$CASE source_table
                                            WHEN 'physical_samples' THEN source_id IN (SELECT sample_id FROM physical_samples)
                                            WHEN 'manufacturing_operations' THEN source_id IN (SELECT operation_id FROM manufacturing_operations)
                                            WHEN 'test_sessions' THEN source_id IN (SELECT session_id FROM test_sessions)
                                            WHEN 'raw_stock_lots' THEN true
                                            ELSE false END$e$)
    ) AS v (tbl, expr)
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
        EXECUTE format('DROP POLICY IF EXISTS a1a_open ON public.%I', r.tbl);
        EXECUTE format('CREATE POLICY a1a_open ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)', r.tbl);
        EXECUTE format('DROP POLICY IF EXISTS a1a_llm_hide ON public.%I', r.tbl);
        EXECUTE format('CREATE POLICY a1a_llm_hide ON public.%I AS RESTRICTIVE FOR SELECT TO d1_llm_readonly USING (%s)', r.tbl, r.expr);
        EXECUTE format('COMMENT ON POLICY a1a_open ON public.%I IS %L', r.tbl,
            'A1a (migration 168): permissive, every command, every role: row security only restricts d1_llm_readonly, through a1a_llm_hide.');
        EXECUTE format('COMMENT ON POLICY a1a_llm_hide ON public.%I IS %L', r.tbl,
            'A1a (migration 168): the Ask-the-database role never sees a restricted record or one under a restricted project, campaign or sample (d1_private.hidden_records).');
    END LOOP;
END
$do$;

-- the nine granted views read as the querying role
ALTER VIEW v_complete_sample_history        SET (security_invoker = true);
ALTER VIEW v_llm_query_targets              SET (security_invoker = true);
ALTER VIEW v_manufacturing_operations_full  SET (security_invoker = true);
ALTER VIEW v_project_rollup                 SET (security_invoker = true);
ALTER VIEW v_sample_genealogy_flat          SET (security_invoker = true);
ALTER VIEW v_schema_dictionary              SET (security_invoker = true);
ALTER VIEW v_stock_provenance               SET (security_invoker = true);
ALTER VIEW v_test_sessions_full             SET (security_invoker = true);
ALTER VIEW v_tooling_hierarchy              SET (security_invoker = true);

-- Completeness: every table granted to the role has row security enabled or is a named reference table; every granted view is
-- security_invoker. (tests/phase1_schema.sh asserts the same on every later migration.)
DO $do$
DECLARE
    reference text[] := ARRAY['alloying_elements','cutting_inserts','diag_recipes','equipment','etchants','facilities','fast_recipes',
        'filter_profiles','insert_edges','insert_types','manufacturers','manufacturing_methods','material_alloying_elements',
        'material_iso_classifications','materials','prep_recipe_steps','prep_recipes','raw_stock_lots','tool_boxes','tool_setup','tools'];
    bad text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT')
       AND NOT c.relrowsecurity AND c.relname <> ALL (reference);
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'tables granted to d1_llm_readonly with no row security and not in the reference list: %', bad;
    END IF;
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
       AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT')
       AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false);
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'views granted to d1_llm_readonly that are not security_invoker: %', bad;
    END IF;
END
$do$;

-- migrate:down
DO $do$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['physical_samples','manufacturing_operations','test_sessions','campaigns','projects','campaign_samples',
        'sample_genealogy','sample_stock_provenance','sample_co_owners','sample_data_files','operation_data_files','operation_files',
        'prep_steps','machining_force_analysis','fast_run_data','diag_layer','session_data_files','test_sessions_subject',
        'project_investigators','project_rollup','semantic_embeddings']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS a1a_llm_hide ON public.%I', t);
        EXECUTE format('DROP POLICY IF EXISTS a1a_open ON public.%I', t);
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END LOOP;
END
$do$;

ALTER VIEW v_complete_sample_history        RESET (security_invoker);
ALTER VIEW v_llm_query_targets              RESET (security_invoker);
ALTER VIEW v_manufacturing_operations_full  RESET (security_invoker);
ALTER VIEW v_project_rollup                 RESET (security_invoker);
ALTER VIEW v_sample_genealogy_flat          RESET (security_invoker);
ALTER VIEW v_schema_dictionary              RESET (security_invoker);
ALTER VIEW v_stock_provenance               RESET (security_invoker);
ALTER VIEW v_test_sessions_full             RESET (security_invoker);
ALTER VIEW v_tooling_hierarchy              RESET (security_invoker);

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN
        REVOKE EXECUTE ON FUNCTION d1_private.is_hidden(text, uuid) FROM d1_llm_readonly;
        REVOKE USAGE ON SCHEMA d1_private FROM d1_llm_readonly;
    END IF;
END
$do$;
