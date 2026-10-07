#!/usr/bin/env bash
# Phase 6 AI-readiness test: verifies the durable-core half of the text-to-SQL
# capability — the semantic dictionary view, the LLM query-target menu, the
# pgvector embedding store, and the read-only role's grant isolation: an explicit
# allow-list of lab tables and views (migration …132) — never audit_logs, people,
# Machine_Operators or any directus_* table — and no write privilege anywhere.
# Requires a running Postgres with DATABASE_URL set (superuser, to create roles),
# or a local stack via `make up`.
#
# Usage:  DATABASE_URL=postgres://d1:pw@localhost:5432/d1_db bash tests/phase6_text_to_sql.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. postgres://d1:pw@localhost:5432/d1_db)}"
PSQL="psql $DATABASE_URL --no-psqlrc -t -A"

# A login role that inherits the d1_llm_readonly group — this is exactly what the
# runbook tells the operator to provision for the plugin (migration …132 creates
# d1_llm_app NOLOGIN; the operator adds LOGIN + a password). Read-only + statement
# timeout are pinned here too (group-role SETs are not inherited by members).
LLM_USER="phase6_llm_app"
LLM_PW="phase6_pw"

cleanup() { $PSQL -c "DROP ROLE IF EXISTS $LLM_USER" >/dev/null 2>&1; }
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run_eq() {
    local label="$1" sql="$2" expected="$3" result
    result=$($PSQL -c "$sql" 2>&1) || { bad "$label (psql error: $result)"; return; }
    [[ "$result" == "$expected" ]] && ok "$label" || bad "$label (got '$result', want '$expected')"
}
# Assert a query run as the LLM login role FAILS *and* for the right reason: the
# error text must contain $3 (default "permission denied"), so a typo or a missing
# table cannot pass as a denial.
deny() {
    local label="$1" sql="$2" want="${3:-permission denied}" out
    out=$(PGPASSWORD="$LLM_PW" psql "${LLM_DSN}" --no-psqlrc -t -A -c "$sql" 2>&1)
    if [[ $? -eq 0 ]]; then
        bad "$label (UNEXPECTEDLY ALLOWED)"
    elif [[ "$out" == *"$want"* ]]; then
        ok "$label (denied: ${out##*ERROR:  })"
    else
        bad "$label (failed, but not with '$want': $out)"
    fi
}
# Same, but first switches the session's default_transaction_read_only OFF — what a
# guard bypass using set_config() would do. The grants alone must still refuse the
# write with "permission denied"; the read-only default is only the second layer.
deny_rw() {
    local label="$1" sql="$2" out
    out=$(PGPASSWORD="$LLM_PW" psql "${LLM_DSN}" --no-psqlrc -t -A \
        -c "SET default_transaction_read_only = off" -c "$sql" 2>&1)
    if [[ $? -eq 0 ]]; then
        bad "$label (UNEXPECTEDLY ALLOWED with read-only switched off)"
    elif [[ "$out" == *"permission denied"* ]]; then
        ok "$label (denied: ${out##*ERROR:  })"
    else
        bad "$label (failed, but not with 'permission denied': $out)"
    fi
}
allow() {
    local label="$1" sql="$2" out
    out=$(PGPASSWORD="$LLM_PW" psql "${LLM_DSN}" --no-psqlrc -t -A -c "$sql" 2>&1)
    if [[ $? -eq 0 ]]; then ok "$label"; else bad "$label (error: $out)"; fi
}

echo "== AI-readiness objects exist =="
run_eq "v_schema_dictionary view exists" \
    "SELECT 'y' FROM pg_views WHERE viewname='v_schema_dictionary'" "y"
run_eq "v_llm_query_targets view exists" \
    "SELECT 'y' FROM pg_views WHERE viewname='v_llm_query_targets'" "y"
run_eq "v_embeddings_source_notes view exists" \
    "SELECT 'y' FROM pg_views WHERE viewname='v_embeddings_source_notes'" "y"
run_eq "semantic_embeddings table exists" \
    "SELECT 'y' FROM pg_tables WHERE tablename='semantic_embeddings'" "y"
run_eq "hnsw vector index exists" \
    "SELECT 'y' FROM pg_indexes WHERE indexname='semantic_embeddings_hnsw_idx'" "y"
run_eq "d1_llm_readonly role exists" \
    "SELECT 'y' FROM pg_roles WHERE rolname='d1_llm_readonly'" "y"

echo "== Semantic dictionary is populated =="
run_eq "dictionary has the sample-history view's columns" \
    "SELECT CASE WHEN COUNT(*) > 5 THEN 'y' ELSE 'n' END
     FROM v_schema_dictionary WHERE object_name='v_complete_sample_history'" "y"
run_eq "dictionary carries column comments" \
    "SELECT CASE WHEN COUNT(*) > 0 THEN 'y' ELSE 'n' END
     FROM v_schema_dictionary WHERE column_comment IS NOT NULL" "y"

echo "== Query-target menu is the data views only =="
run_eq "menu lists v_complete_sample_history" \
    "SELECT 'y' FROM v_llm_query_targets WHERE view_name='v_complete_sample_history'" "y"
run_eq "menu excludes the internal embeddings source" \
    "SELECT COALESCE(MAX('y'),'n') FROM v_llm_query_targets
     WHERE view_name='v_embeddings_source_notes'" "n"

echo "== Read-only role config is set (defence-in-depth) =="
run_eq "role is default_transaction_read_only" \
    "SELECT 'y' FROM pg_roles WHERE rolname='d1_llm_readonly'
       AND 'default_transaction_read_only=on' = ANY(rolconfig)" "y"
run_eq "role has a statement_timeout" \
    "SELECT 'y' FROM pg_roles WHERE rolname='d1_llm_readonly'
       AND EXISTS (SELECT 1 FROM unnest(rolconfig) AS c
                   WHERE c LIKE 'statement_timeout=%')" "y"
run_eq "migration created d1_llm_app as a member of d1_llm_readonly" \
    "SELECT 'y' FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = 'd1_llm_readonly'
       JOIN pg_roles r ON r.oid = m.member AND r.rolname = 'd1_llm_app'" "y"
run_eq "d1_llm_app is default_transaction_read_only" \
    "SELECT 'y' FROM pg_roles WHERE rolname='d1_llm_app'
       AND 'default_transaction_read_only=on' = ANY(rolconfig)" "y"

echo "== Allow-list: privileges per has_table_privilege (migration …132) =="
# Writes: not a single relation in public may be writable by the role.
run_eq "role has no write-ish privilege on any relation in public" \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')
       AND (has_table_privilege('d1_llm_readonly', c.oid, 'INSERT')
         OR has_table_privilege('d1_llm_readonly', c.oid, 'UPDATE')
         OR has_table_privilege('d1_llm_readonly', c.oid, 'DELETE')
         OR has_table_privilege('d1_llm_readonly', c.oid, 'TRUNCATE')
         OR has_table_privilege('d1_llm_readonly', c.oid, 'REFERENCES')
         OR has_table_privilege('d1_llm_readonly', c.oid, 'TRIGGER'))" "0"
for t in physical_samples manufacturing_operations test_sessions materials \
         raw_stock_lots tools projects campaigns; do
    run_eq "role has no INSERT/UPDATE/DELETE on core table $t" \
        "SELECT CASE WHEN has_table_privilege('d1_llm_readonly', '$t', 'INSERT')
                       OR has_table_privilege('d1_llm_readonly', '$t', 'UPDATE')
                       OR has_table_privilege('d1_llm_readonly', '$t', 'DELETE')
                     THEN 'writable' ELSE 'read-only' END" "read-only"
done
# Excluded relations: no SELECT. Each must exist (so the check cannot pass vacuously)
# except directus_users, which is only a stub in some environments.
for t in audit_logs people '"Machine_Operators"' schema_migrations archive_metadata_edits \
         force_crawler_state v_embeddings_source_notes; do
    run_eq "role has no SELECT on $t" \
        "SELECT CASE WHEN to_regclass('public.$t') IS NULL THEN 'MISSING'
                     WHEN has_table_privilege('d1_llm_readonly', to_regclass('public.$t'), 'SELECT')
                     THEN 'READABLE' ELSE 'denied' END" "denied"
done
run_eq "role has no SELECT on any directus_* table" \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'directus\_%' AND c.relkind IN ('r','v')
       AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT')" "0"
run_eq "role cannot read directus_users" \
    "SELECT CASE WHEN to_regclass('public.directus_users') IS NULL THEN 'denied'
                 WHEN has_table_privilege('d1_llm_readonly', 'public.directus_users', 'SELECT')
                 THEN 'READABLE' ELSE 'denied' END" "denied"
# Allowed: the curated views, and the tables the plugin needs.
run_eq "role can SELECT all 9 allow-listed views" \
    "SELECT count(*) FROM unnest(ARRAY['v_complete_sample_history','v_llm_query_targets',
        'v_manufacturing_operations_full','v_project_rollup','v_sample_genealogy_flat',
        'v_schema_dictionary','v_stock_provenance','v_test_sessions_full',
        'v_tooling_hierarchy']) AS v(name)
     WHERE has_table_privilege('d1_llm_readonly', v.name, 'SELECT')" "9"
run_eq "role can SELECT semantic_embeddings (read by /api/search)" \
    "SELECT has_table_privilege('d1_llm_readonly', 'semantic_embeddings', 'SELECT')" "t"
run_eq "role can SELECT the lab base tables" \
    "SELECT count(*) FROM unnest(ARRAY['physical_samples','manufacturing_operations',
        'test_sessions','materials','raw_stock_lots','tools','projects','campaigns']) AS t(name)
     WHERE has_table_privilege('d1_llm_readonly', t.name, 'SELECT')" "8"
# No auto-grant: a table created tomorrow must stay invisible until a migration grants it.
run_eq "no default privilege grants new tables to the role" \
    "SELECT count(*) FROM pg_default_acl a, aclexplode(a.defaclacl) x
     WHERE x.grantee = 'd1_llm_readonly'::regrole" "0"
probe_out=$($PSQL -c "BEGIN;
    CREATE TABLE phase6_new_table_probe (x int);
    SELECT 'probe=' || has_table_privilege('d1_llm_readonly', 'phase6_new_table_probe', 'SELECT')::text;
    ROLLBACK;" 2>&1)
if [[ "$probe_out" == *"probe=false"* ]]; then
    ok "a newly created table is NOT readable by the role (no default-privileges grant)"
else
    bad "a newly created table is readable by the role ($probe_out)"
fi

echo "== Grant isolation: provision a login member like the runbook does =="
$PSQL -c "DROP ROLE IF EXISTS $LLM_USER" >/dev/null 2>&1
$PSQL -c "CREATE ROLE $LLM_USER LOGIN PASSWORD '$LLM_PW' IN ROLE d1_llm_readonly" >/dev/null 2>&1
# Pin read-only + timeout on the login role (member roles do NOT inherit group SETs).
$PSQL -c "ALTER ROLE $LLM_USER SET default_transaction_read_only = on" >/dev/null 2>&1
$PSQL -c "ALTER ROLE $LLM_USER SET statement_timeout = '5000ms'" >/dev/null 2>&1

# Build a DSN for the LLM login role from the host/port/db of DATABASE_URL.
LLM_DSN=$($PSQL -c "SELECT regexp_replace(
    '$DATABASE_URL',
    '://[^@]+@',
    '://$LLM_USER:$LLM_PW@')")

allow "LLM role reads an allow-listed view" \
    "SELECT count(*) FROM v_complete_sample_history"
allow "LLM role reads the schema dictionary" \
    "SELECT count(*) FROM v_schema_dictionary"
allow "LLM role reads a base table" \
    "SELECT count(*) FROM physical_samples"
allow "LLM role reads machining params on manufacturing_operations" \
    "SELECT count(machining_feed_mm_per_rev) FROM manufacturing_operations"
allow "LLM role reads semantic_embeddings" \
    "SELECT count(*) FROM semantic_embeddings"
# Everything below must fail with "permission denied" (not just any error).
deny  "LLM role cannot read the audit log" \
    "SELECT count(*) FROM audit_logs"
deny  "LLM role cannot read people (email addresses)" \
    "SELECT count(*) FROM people"
deny  "LLM role cannot read Machine_Operators" \
    'SELECT count(*) FROM "Machine_Operators"'
deny  "LLM role cannot read schema_migrations" \
    "SELECT count(*) FROM schema_migrations"
deny  "LLM role cannot read Directus credentials (directus_users)" \
    "SELECT count(*) FROM directus_users"
deny  "LLM role cannot read Directus settings (holds API keys)" \
    "SELECT count(*) FROM directus_settings"
deny  "LLM role cannot read the embedding backfill source view" \
    "SELECT count(*) FROM v_embeddings_source_notes"
deny_rw "LLM role cannot INSERT into a core table (read-only off)" \
    "INSERT INTO physical_samples (sample_code, form) VALUES ('PHASE6-X','coupon')"
deny_rw "LLM role cannot UPDATE a core table (read-only off)" \
    "UPDATE physical_samples SET notes = 'x'"
deny_rw "LLM role cannot DELETE from a core table (read-only off)" \
    "DELETE FROM physical_samples"
deny_rw "LLM role cannot TRUNCATE a core table (read-only off)" \
    "TRUNCATE physical_samples"
# (audit_logs is not used here: its DO INSTEAD NOTHING rules rewrite a write to
# nothing before privileges are checked, so it reports success without writing.)
deny_rw "LLM role cannot UPDATE people (read-only off)" \
    "UPDATE people SET email = 'x'"
deny  "LLM role cannot INSERT while the read-only default holds" \
    "INSERT INTO physical_samples (sample_code, form) VALUES ('PHASE6-X','coupon')" \
    "read-only transaction"
deny  "LLM role is read-only (no temp table create)" \
    "CREATE TEMP TABLE t (x int)" "read-only transaction"

# The schema dictionary is the prompt source and lists every table; the plugin
# filters it by privilege, so denied tables must drop out and allowed ones stay.
denied_listed=$(PGPASSWORD="$LLM_PW" psql "${LLM_DSN}" --no-psqlrc -t -A -c \
    "SELECT count(DISTINCT object_name) FROM v_schema_dictionary
     WHERE has_table_privilege(to_regclass(format('public.%I', object_name)), 'SELECT')
       AND object_name IN ('audit_logs','people','Machine_Operators','schema_migrations')" 2>&1)
if [[ "$denied_listed" == "0" ]]; then
    ok "privilege-filtered dictionary lists no denied table"
else
    bad "privilege-filtered dictionary still lists denied tables (got '$denied_listed')"
fi
allowed_listed=$(PGPASSWORD="$LLM_PW" psql "${LLM_DSN}" --no-psqlrc -t -A -c \
    "SELECT count(DISTINCT object_name) FROM v_schema_dictionary
     WHERE has_table_privilege(to_regclass(format('public.%I', object_name)), 'SELECT')
       AND object_name IN ('physical_samples','v_complete_sample_history')" 2>&1)
if [[ "$allowed_listed" == "2" ]]; then
    ok "privilege-filtered dictionary keeps the lab tables and views"
else
    bad "privilege-filtered dictionary lost allowed objects (got '$allowed_listed')"
fi

echo "== pgvector similarity search works =="
# A 768-dim probe vector; cosine-orders the (possibly empty) embedding set.
run_eq "cosine <=> query executes against semantic_embeddings" \
    "SELECT 'y' FROM (
       SELECT embedding_id FROM semantic_embeddings
       ORDER BY embedding <=> ('['||array_to_string(array_fill(0.1::real, ARRAY[768]),',')||']')::vector
       LIMIT 1
     ) AS _probe
     UNION ALL SELECT 'y' LIMIT 1" "y"

echo
echo "Phase 6: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
