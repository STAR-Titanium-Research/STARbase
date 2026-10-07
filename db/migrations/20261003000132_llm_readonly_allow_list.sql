-- migrate:up
-- Text-to-SQL role: back to an explicit allow-list (ADR-0009, review findings 5.8 / 6.4).
--
-- Migration 20260701000052 gave d1_llm_readonly `SELECT ON ALL TABLES` plus a default
-- privilege for every future table, minus a 12-name deny-list. That is a deny-list: it
-- left audit_logs (full row JSON of every change), people (email), Machine_Operators and,
-- on a live Directus database, directus_activity / directus_revisions / directus_notifications
-- readable by LLM-authored SQL, and every table added later was readable by default.
-- A SQL-guard bypass (see plugins/llm-text-to-sql/app/lib/sql_guard.py) therefore reached
-- all of it. Here the role loses everything and is granted exactly the lab tables and
-- views the plugin needs. A new table is invisible to the LLM until a later migration
-- grants it, and a view that is DROPped and recreated must be re-granted (CREATE OR
-- REPLACE keeps the grant).
--
-- NOT granted: audit_logs, people, Machine_Operators, archive_metadata_edits (an audit
-- trail of who corrected what), force_crawler_state (daemon control row), schema_migrations,
-- every directus_* table, v_embeddings_source_notes (the embedding backfill reads it as the
-- writer role, not as this one). semantic_embeddings IS granted: /api/search reads it
-- through this role; the SQL guard keeps LLM-authored SQL off it.
--
-- Functions: tables are the boundary. The public functions are not SECURITY DEFINER (the
-- audit trigger function returns trigger and cannot be called), so refresh_project_rollup(),
-- expand_tool_box_intake() and the generate_*() helpers run with this role's own rights and
-- fail on the first write. EXECUTE cannot be revoked from a role that inherits it through
-- PUBLIC, and the f_trace_* grants from 20260619000015 are kept.
--
-- Roles. d1_llm_readonly stays a NOLOGIN privilege bundle. This migration also creates
-- d1_llm_app, the NOLOGIN member the plugin connects as; the runbook (docs/runbooks/
-- text-to-sql.md) then only has to ALTER ROLE d1_llm_app LOGIN PASSWORD '...'. If an
-- operator already created d1_llm_app by hand it is left as it is (login and password
-- untouched) apart from membership and the read-only settings. Role-level SET values are
-- not inherited from the group, so they are set on the member too; the plugin also pins
-- read-only and a statement timeout per connection.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_app') THEN
        CREATE ROLE d1_llm_app NOLOGIN IN ROLE d1_llm_readonly;
        -- Marker the down section uses to tell "created here" from "created by hand".
        COMMENT ON ROLE d1_llm_app IS
            'text-to-SQL login member; created NOLOGIN by migration 20261003000132 (set LOGIN and a password per docs/runbooks/text-to-sql.md)';
    ELSE
        GRANT d1_llm_readonly TO d1_llm_app;
    END IF;
END
$$;

ALTER ROLE d1_llm_app SET default_transaction_read_only = on;
ALTER ROLE d1_llm_app SET statement_timeout = '5000ms';
ALTER ROLE d1_llm_app SET idle_in_transaction_session_timeout = '10000ms';

-- 1. Take everything away, and stop future tables from being granted automatically.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM d1_llm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE d1 IN SCHEMA public
    REVOKE SELECT ON TABLES FROM d1_llm_readonly;

-- 2. Grant the lab tables and views, SELECT only.
GRANT SELECT ON
    alloying_elements,
    campaign_samples,
    campaigns,
    cutting_inserts,
    diag_layer,
    diag_recipes,
    equipment,
    etchants,
    facilities,
    fast_recipes,
    fast_run_data,
    filter_profiles,
    insert_edges,
    insert_types,
    machining_force_analysis,
    manufacturers,
    manufacturing_methods,
    manufacturing_operations,
    material_alloying_elements,
    material_iso_classifications,
    materials,
    operation_data_files,
    operation_files,
    physical_samples,
    prep_recipe_steps,
    prep_recipes,
    prep_steps,
    project_investigators,
    project_rollup,
    projects,
    raw_stock_lots,
    sample_co_owners,
    sample_data_files,
    sample_genealogy,
    sample_stock_provenance,
    semantic_embeddings,
    session_data_files,
    test_sessions,
    test_sessions_subject,
    tool_boxes,
    tool_setup,
    tools
TO d1_llm_readonly;

GRANT SELECT ON
    v_complete_sample_history,
    v_llm_query_targets,
    v_manufacturing_operations_full,
    v_project_rollup,
    v_sample_genealogy_flat,
    v_schema_dictionary,
    v_stock_provenance,
    v_test_sessions_full,
    v_tooling_hierarchy
TO d1_llm_readonly;

-- migrate:down
-- Restore the previous (deny-list) state exactly: SELECT on every table, the default
-- privilege for future tables, then the 12 revokes from 20260701000052.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO d1_llm_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE d1 IN SCHEMA public
    GRANT SELECT ON TABLES TO d1_llm_readonly;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'directus_users', 'directus_sessions', 'directus_settings',
        'directus_shares', 'directus_deployments',
        'directus_flows', 'directus_operations',
        'directus_policies', 'directus_permissions', 'directus_access',
        'directus_roles',
        'schema_migrations'
    ] LOOP
        IF EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
        ) THEN
            EXECUTE format('REVOKE SELECT ON public.%I FROM d1_llm_readonly', t);
        END IF;
    END LOOP;
END $$;

-- d1_llm_app: drop it only if this migration created it AND nobody has since turned it
-- into a working login (the runbook sets LOGIN + a password). A promoted role is in use by
-- the plugin; it keeps its membership of d1_llm_readonly, which is what the hand-made role
-- the runbook used to describe had.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'd1_llm_app'
            AND NOT rolcanlogin
            AND shobj_description(oid, 'pg_authid') LIKE '%created NOLOGIN by migration 20261003000132%'
    ) THEN
        DROP OWNED BY d1_llm_app;
        DROP ROLE d1_llm_app;
    END IF;
END
$$;
