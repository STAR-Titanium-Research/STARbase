# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Migration 166: the record readers (tables, functions, triggers, backfill, metadata) =="
# The readers tables materialise who may read each record (spec section 2); tests/readers_matrix.sh proves the contents (the
# mutation matrix, the oracle, the random differential test). Here: the shape of everything the migration creates, the dangling-login
# preflight, the metadata, and that the migration reapplies and reverses.
rd_out=$($PSQL 2>&1 <<SQL
SELECT 'drift:' || d1_private.readers_drift_count();
SELECT 'table:' || t || ':' || (SELECT string_agg(c.column_name || '/' || c.is_nullable || '/' || coalesce(c.identity_generation, '-'), ',' ORDER BY c.ordinal_position)
                                 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t)
  FROM unnest(ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers']) t;
SELECT 'open_table:' || (SELECT string_agg(c.column_name || '/' || c.is_nullable || '/' || coalesce(c.identity_generation, '-'), ',' ORDER BY c.ordinal_position)
                          FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'operation_open_to_all');
-- keys: primary key reader_id, UNIQUE (record_id, user_id) (UNIQUE (record_id) for the open set), an index on user_id, cascading foreign keys
SELECT 'keys:' || t || ':' || (SELECT string_agg(pg_get_constraintdef(c.oid), ' | ' ORDER BY c.contype, pg_get_constraintdef(c.oid)) FROM pg_constraint c WHERE c.conrelid = ('public.' || t)::regclass)
  FROM unnest(ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all']) t;
SELECT 'user_index:' || t || ':' || count(*) FROM unnest(ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers']) t
  JOIN pg_indexes i ON i.schemaname = 'public' AND i.tablename = t AND i.indexdef LIKE '%(user_id)' GROUP BY t;
SELECT 'hidden_records:' || (SELECT string_agg(column_name || '/' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'hidden_records')
       || ':' || (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'd1_private.hidden_records'::regclass AND contype = 'p');
SELECT 'comments:' || count(*) FILTER (WHERE obj_description(c.oid, 'pg_class') IS NULL) || '/' || (SELECT count(*) FROM information_schema.columns k WHERE k.table_schema = 'public'
         AND k.table_name = ANY (ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all'])
         AND col_description(('public.' || k.table_name)::regclass, k.ordinal_position::int) IS NULL)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all']);
-- the legacy user_id columns have foreign keys to directus_users, ON DELETE CASCADE
SELECT 'legacy_fk:' || (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.sample_co_owners'::regclass AND contype = 'f' AND confrelid = 'public.directus_users'::regclass AND confdeltype = 'c')
       || '/' || (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.project_investigators'::regclass AND contype = 'f' AND confrelid = 'public.directus_users'::regclass AND confdeltype = 'c');
-- derived data: no audit trigger, no grant to the LLM role (when it exists)
SELECT 'audited:' || count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid = 'audit_trigger_function'::regproc
   AND t.tgrelid = ANY (ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all']::regclass[]);
SELECT 'llm_grants:' || CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly')
       THEN (SELECT count(*) FROM unnest(ARRAY['public.sample_readers','public.operation_readers','public.test_readers','public.campaign_readers','public.project_readers','public.campaign_sample_readers','public.operation_open_to_all','d1_private.hidden_records']) t
              WHERE has_table_privilege('d1_llm_readonly', t, 'SELECT'))::text ELSE '0' END;
SELECT 'in_dictionary:' || count(DISTINCT object_name) FROM v_schema_dictionary WHERE object_name = ANY (ARRAY['sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all']);
-- the functions: SECURITY DEFINER with a pinned search_path where they write or are called by the policies
SELECT 'definer:' || string_agg(p.proname || '=' || (p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, public%'), ',' ORDER BY p.proname)
  FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace
   AND p.proname IN ('refresh_readers','sync_readers','readers_rebuild','is_hidden','trg_readers_lock','trg_readers_truncate','trg_readers_people_upd');
SELECT 'trigger_functions_definer:' || count(*) FILTER (WHERE p.prosecdef AND p.proconfig::text LIKE '%search_path=pg_catalog, public%') || '/' || count(*)
  FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace AND p.proname LIKE 'trg\_readers\_%';
SELECT 'stable:' || string_agg(p.proname || '=' || p.provolatile::text, ',' ORDER BY p.proname)
  FROM pg_proc p WHERE p.pronamespace = 'd1_private'::regnamespace
   AND p.proname IN ('readers_of_sample','readers_of_operation','readers_of_test','readers_of_campaign','readers_of_project','readers_of_campaign_sample','operation_open_of','hidden_of','readers_closure','readers_drift','readers_drift_count','is_hidden');
SELECT 'refresh_volatile:' || (SELECT provolatile::text FROM pg_proc WHERE proname = 'refresh_readers' AND pronamespace = 'd1_private'::regnamespace);
SELECT 'refresh_not_public:' || (NOT has_function_privilege('public', 'd1_private.refresh_readers(uuid[],uuid[],uuid[],uuid[],uuid[],uuid[],uuid[],uuid[],uuid[])', 'EXECUTE'));
SELECT 'is_hidden_not_public:' || (NOT has_function_privilege('public', 'd1_private.is_hidden(text,uuid)', 'EXECUTE'));
-- the lock order: the global readers lock comes first in refresh_readers (before any read), readers_rebuild and refresh_project_rollup
SELECT 'lock_first:' || (position('pg_advisory_xact_lock' IN prosrc) < position('readers_closure' IN prosrc)) FROM pg_proc WHERE proname = 'refresh_readers' AND pronamespace = 'd1_private'::regnamespace;
SELECT 'rollup_lock_order:' || (position('d1_readers' IN prosrc) > 0 AND position('d1_readers' IN prosrc) < position('refresh_project_rollup' IN prosrc)) FROM pg_proc WHERE proname = 'refresh_project_rollup' AND pronamespace = 'public'::regnamespace;
SELECT 'isolation_check:' || (position('read committed' IN prosrc) > 0) FROM pg_proc WHERE proname = 'refresh_readers' AND pronamespace = 'd1_private'::regnamespace;
-- the order of the recompute inside sync_readers is load-bearing (spec section 2, rule 1): a readers_of_* function that reads another type's readers
-- table must be called after that type's block. Dependencies are found from the function sources, so a new dependency is checked without editing this.
CREATE TEMP VIEW rd_sync_order AS
WITH fn(t, f) AS (VALUES ('sample', 'readers_of_sample'), ('operation', 'readers_of_operation'), ('test', 'readers_of_test'),
                         ('campaign', 'readers_of_campaign'), ('project', 'readers_of_project'), ('campaign_sample', 'readers_of_campaign_sample')),
     tbl(t, tn) AS (VALUES ('sample', 'sample_readers'), ('operation', 'operation_readers'), ('test', 'test_readers'),
                           ('campaign', 'campaign_readers'), ('project', 'project_readers'), ('campaign_sample', 'campaign_sample_readers')),
     deps AS (SELECT f.f AS user_f, h.f AS dep_f FROM fn f
                JOIN pg_proc p ON p.proname = f.f AND p.pronamespace = 'd1_private'::regnamespace
                JOIN tbl g ON p.prosrc ~ ('\y' || g.tn || '\y') JOIN fn h ON h.t = g.t WHERE h.t <> f.t)
SELECT user_f, dep_f FROM deps;
SELECT 'sync_order:' || count(*) FILTER (WHERE position(d.user_f || '(' IN s.prosrc) <= position(d.dep_f || '(' IN s.prosrc)) || '/' || count(*)
  FROM rd_sync_order d, pg_proc s WHERE s.proname = 'sync_readers' AND s.pronamespace = 'd1_private'::regnamespace;
-- the same check on a sync_readers whose project block comes first: it must see violations (the check can fail)
SELECT 'sync_order_sabotaged:' || count(*) FILTER (WHERE position(d.user_f || '(' IN ('readers_of_project(' || s.prosrc)) <= position(d.dep_f || '(' IN ('readers_of_project(' || s.prosrc))) || '/' || count(*)
  FROM rd_sync_order d, pg_proc s WHERE s.proname = 'sync_readers' AND s.pronamespace = 'd1_private'::regnamespace;
-- the Directus metadata the rules walk
SELECT 'meta_collections:' || count(*) || '/' || count(*) FILTER (WHERE hidden) FROM directus_collections WHERE collection IN ('sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all');
SELECT 'meta_relations:' || count(*) FILTER (WHERE one_field IN ('readers','open_to_all')) || '/' || count(*) FILTER (WHERE one_collection = 'directus_users' AND one_field IS NULL)
  FROM directus_relations WHERE many_collection IN ('sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all');
SELECT 'meta_fields:' || count(*) || '/' || count(*) FILTER (WHERE hidden AND readonly AND special = 'o2m') FROM directus_fields
 WHERE (field = 'readers' AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects','campaign_samples')) OR (collection = 'manufacturing_operations' AND field = 'open_to_all');
-- every readers alias resolves: relation + alias field + a real column behind each side
SELECT 'alias_unresolved:' || coalesce(string_agg(r.many_collection, ','), '') FROM directus_relations r
 WHERE r.one_field IN ('readers', 'open_to_all')
   AND (NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = r.one_collection AND f.field = r.one_field)
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = r.many_collection AND c.column_name = r.many_field));
SQL
)
expect_fixed rd_out "drift:0" "the backfill left readers_drift() empty (every readers table equals the functions)"
for t in sample_readers operation_readers test_readers campaign_readers project_readers campaign_sample_readers; do
    expect_fixed rd_out "table:$t:reader_id/NO/ALWAYS,record_id/NO/-,user_id/NO/-" "$t: reader_id (identity), record_id and user_id, all NOT NULL"
    expect_fixed rd_out "user_index:$t:1" "$t has an index on user_id (the membership test)"
done
expect_fixed rd_out "open_table:reader_id/NO/ALWAYS,record_id/NO/-" "operation_open_to_all: reader_id (identity) and record_id"
for spec in sample_readers:physical_samples:sample_id operation_readers:manufacturing_operations:operation_id test_readers:test_sessions:session_id campaign_readers:campaigns:campaign_id project_readers:projects:project_id campaign_sample_readers:campaign_samples:id; do
    IFS=: read -r t parent pk <<<"$spec"
    expect_fixed rd_out "keys:$t:FOREIGN KEY (record_id) REFERENCES $parent($pk) ON DELETE CASCADE | FOREIGN KEY (user_id) REFERENCES directus_users(id) ON DELETE CASCADE | PRIMARY KEY (reader_id) | UNIQUE (record_id, user_id)" \
             "$t: primary key, UNIQUE (record_id, user_id), cascading foreign keys to $parent and directus_users"
done
expect_fixed rd_out "keys:operation_open_to_all:FOREIGN KEY (record_id) REFERENCES manufacturing_operations(operation_id) ON DELETE CASCADE | PRIMARY KEY (reader_id) | UNIQUE (record_id)" "operation_open_to_all: primary key, UNIQUE (record_id), cascading foreign key"
expect_fixed rd_out "hidden_records:kind/NO,record_id/NO:PRIMARY KEY (kind, record_id)" "d1_private.hidden_records(kind, record_id) with a composite key and no foreign key"
expect_fixed rd_out "comments:0/0" "every readers table and column carries a COMMENT"
expect_fixed rd_out "legacy_fk:1/1" "sample_co_owners.user_id and project_investigators.user_id have ON DELETE CASCADE foreign keys to directus_users"
expect_fixed rd_out "audited:0" "the readers tables carry no audit trigger (derived data)"
expect_fixed rd_out "llm_grants:0" "no readers table and not hidden_records is granted to d1_llm_readonly"
expect_fixed rd_out "in_dictionary:7" "the readers tables are listed in v_schema_dictionary like every public table (decided: left listed; the LLM role has no grant on them, so a query fails with permission denied)"
expect_fixed rd_out "definer:is_hidden=true,readers_rebuild=true,refresh_readers=true,sync_readers=true,trg_readers_lock=true,trg_readers_people_upd=true,trg_readers_truncate=true" "the write functions and is_hidden are SECURITY DEFINER with a pinned search_path"
expect_fixed rd_out "stable:hidden_of=s,is_hidden=s,operation_open_of=s,readers_closure=s,readers_drift=s,readers_drift_count=s,readers_of_campaign=s,readers_of_campaign_sample=s,readers_of_operation=s,readers_of_project=s,readers_of_sample=s,readers_of_test=s" "the readers_of_* family, operation_open_of, hidden_of, the closure and the drift check are STABLE"
expect_fixed rd_out "refresh_volatile:v" "refresh_readers is VOLATILE (each statement takes a fresh snapshot)"
expect_fixed rd_out "refresh_not_public:true" "refresh_readers is not executable by PUBLIC"
expect_fixed rd_out "is_hidden_not_public:true" "is_hidden is not executable by PUBLIC (the Ask-DB grant belongs to its own migration)"
expect_fixed rd_out "sync_order:0/6" "sync_readers recomputes every type after the readers tables its function reads (6 dependencies found from the sources: operation, test and junction rows on samples, junction rows on campaigns, projects on operations and tests)"
expect_fixed rd_out "sync_order_sabotaged:2/6" "the order check fails when the project block is moved first"
expect_fixed rd_out "lock_first:true" "refresh_readers takes the global advisory lock before it reads (the closure)"
expect_fixed rd_out "rollup_lock_order:true" "refresh_project_rollup takes the readers lock before the rollup lock (lock order)"
expect_fixed rd_out "isolation_check:true" "refresh_readers checks for READ COMMITTED"
expect_fixed rd_out "meta_collections:7/7" "the seven readers collections exist in Directus and are hidden"
expect_fixed rd_out "meta_relations:7/6" "seven record_id -> parent relations carry the readers or open_to_all alias, six user_id relations point to directus_users with no alias"
expect_fixed rd_out "meta_fields:7/7" "the seven hidden read-only alias fields exist (readers on six collections, open_to_all on operations)"
expect_fixed rd_out "alias_unresolved:" "every readers alias resolves (relation, alias field and both columns)"
# trigger coverage (spec section 2): one statement trigger per row of the table, with transition tables, and a TRUNCATE trigger per input table
RD_TRIG_TABLES="physical_samples manufacturing_operations test_sessions campaigns projects project_investigators project_access campaign_samples sample_co_owners sample_access operation_access test_access campaign_access"
rd_trig_expect=""
for t in $RD_TRIG_TABLES; do for ev in ins upd del; do rd_trig_expect+="${t}_readers_${ev}|$t "; done; done
rd_trig_expect+="people_readers_upd|people "
rd_trig_expect+="directus_users_readers_ins|directus_users directus_users_readers_upd|directus_users directus_users_readers_del|directus_users "  # migration 185: the viewer set
rd_trunc_expect=""
for t in physical_samples manufacturing_operations test_sessions campaigns projects sample_access operation_access test_access campaign_access project_access campaign_samples sample_co_owners project_investigators people directus_users; do
    rd_trunc_expect+="${t}_readers_trunc|$t "
done
trig_out=$($PSQL 2>&1 <<SQL
SELECT 'row_triggers:' || count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND t.tgname LIKE '%\_readers\_%' AND t.tgname !~ '_(trunc|lock)$';
SELECT 'bad_shape:' || coalesce(string_agg(t.tgname, ','), '') FROM pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgname ~ '_readers_(ins|upd|del)$'
   AND NOT ((t.tgtype & 1) = 0 AND (t.tgtype & 2) = 0                                   -- FOR EACH STATEMENT, AFTER
            AND (t.tgnewtable IS NOT NULL OR t.tgoldtable IS NOT NULL)                   -- with transition tables
            AND t.tgattr::text = ''                                                    -- no UPDATE OF column list (not allowed with transition tables)
            AND ((t.tgname LIKE '%\_ins' AND (t.tgtype & 4) = 4 AND t.tgnewtable IS NOT NULL AND t.tgoldtable IS NULL)
              OR (t.tgname LIKE '%\_upd' AND (t.tgtype & 16) = 16 AND t.tgnewtable IS NOT NULL AND t.tgoldtable IS NOT NULL)
              OR (t.tgname LIKE '%\_del' AND (t.tgtype & 8) = 8 AND t.tgoldtable IS NOT NULL AND t.tgnewtable IS NULL)));
SELECT 'trunc_bad:' || coalesce(string_agg(t.tgname, ','), '') FROM pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgname LIKE '%\_readers\_trunc' AND NOT ((t.tgtype & 1) = 0 AND (t.tgtype & 32) = 32 AND (t.tgtype & 2) = 0);
SELECT 'lock_bad:' || coalesce(string_agg(t.tgname, ','), '') FROM pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgname LIKE '%\_readers\_lock' AND t.tgname <> 'people_readers_lock' AND NOT ((t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16);
-- the people lock: BEFORE STATEMENT UPDATE OF user_id only (the seeds of people_readers_upd are gathered after it, and it precedes the row lock)
SELECT 'people_lock_shape:' || (SELECT (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 0 AND (t.tgtype & 8) = 0 AND (t.tgtype & 16) = 16
                                       AND t.tgattr::text = (SELECT attnum::text FROM pg_attribute WHERE attrelid = 'people'::regclass AND attname = 'user_id')
                                       AND t.tgfoid = 'd1_private.trg_readers_lock'::regproc
                                  FROM pg_trigger t WHERE t.tgname = 'people_readers_lock' AND t.tgrelid = 'people'::regclass);
-- they fire before the rollup's (sorted by name): the readers triggers sort before refresh_rollup_*
SELECT 'order_ok:' || (SELECT bool_and(r.tgname < 'refresh_rollup_') FROM pg_trigger r WHERE NOT r.tgisinternal AND r.tgname ~ '_readers_(ins|upd|del)$' AND r.tgrelid IN ('manufacturing_operations'::regclass, 'campaigns'::regclass, 'physical_samples'::regclass));
SELECT 'lock_before_rollup_lock:' || ('manufacturing_operations_readers_lock' < 'mfg_op_rollup_lock' AND 'physical_samples_readers_lock' < 'physical_samples_rollup_lock');
SQL
)
for pair in $rd_trig_expect $rd_trunc_expect manufacturing_operations_readers_lock\|manufacturing_operations physical_samples_readers_lock\|physical_samples people_readers_lock\|people; do
    IFS='|' read -r name tbl <<<"$pair"
    n=$($PSQL -c "SELECT count(*) FROM pg_trigger WHERE tgname = '$name' AND tgrelid = 'public.$tbl'::regclass AND NOT tgisinternal")
    [[ "$n" == 1 ]] && ok "trigger $name exists on $tbl" || bad "trigger $name is missing on $tbl"
done
expect_fixed trig_out "row_triggers:43" "43 insert, update and delete triggers (13 tables x 3, plus people update, plus the three of directus_users of migration 185)"
expect_fixed trig_out "bad_shape:" "every insert, update and delete trigger is a statement-level AFTER trigger with transition tables and no column list"
expect_fixed trig_out "trunc_bad:" "every TRUNCATE trigger is a statement-level AFTER TRUNCATE trigger"
expect_fixed trig_out "lock_bad:" "the lock triggers are BEFORE STATEMENT on insert, update and delete"
expect_fixed trig_out "people_lock_shape:true" "people_readers_lock is BEFORE STATEMENT UPDATE OF user_id and calls trg_readers_lock (the seeds of people_readers_upd are gathered under the lock)"
expect_fixed trig_out "order_ok:true" "the readers triggers sort before refresh_rollup_* (readers lock first)"
expect_fixed trig_out "lock_before_rollup_lock:true" "the BEFORE-statement readers lock sorts before the rollup lock triggers of migrations 126, 127 and 157"

# the dangling-login preflight, the reapply and the reverse, in one rolled-back transaction each
rd_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$LA")
rd_down=$(awk '/-- migrate:down/{f=1;next}f' "$LA")
RDK=d0000000-0000-4000-8000-0000000000
rd_dangling=$($PSQL -v ON_ERROR_STOP=0 2>&1 <<SQL
BEGIN;
$tr_down
$to_down
$ll_down
$rr_down
$la_down
INSERT INTO projects (project_id, project_code, project_name) VALUES ('${RDK}a1', 'TRD-P', 'readers preflight');
INSERT INTO project_investigators (project_id, user_id) VALUES ('${RDK}a1', '${RDK}e1');
$la_up
ROLLBACK;
SQL
)
grep -q "name a login that no longer exists" <<<"$rd_dangling" && grep -q "scripts/a1_clean_dangling_legacy_logins.sql" <<<"$rd_dangling" && grep -q "1 project_investigators row" <<<"$rd_dangling" \
    && ok "166 stops with a clear message that names the cleanup step when a legacy row names a deleted login" \
    || bad "166 did not stop on a dangling project_investigators.user_id row (psql output: $(cut -c1-500 <<<"$rd_dangling"))"
# the operator's cleanup script: dry run by default, apply=1 deletes; here the database has no dangling rows, so both change nothing and say so
rd_clean=$(psql "$DATABASE_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -f scripts/a1_clean_dangling_legacy_logins.sql 2>&1)
rd_clean_apply=$(psql "$DATABASE_URL" --no-psqlrc -X -q -v ON_ERROR_STOP=1 -v apply=1 -f scripts/a1_clean_dangling_legacy_logins.sql 2>&1)
grep -q "dry run: nothing was changed" <<<"$rd_clean" && ok "scripts/a1_clean_dangling_legacy_logins.sql is a dry run by default (it lists the rows and rolls back)" \
    || bad "the cleanup script did not run as a dry run (psql output: $(cut -c1-400 <<<"$rd_clean"))"
grep -q "^applied" <<<"$rd_clean_apply" && ok "scripts/a1_clean_dangling_legacy_logins.sql with apply=1 commits" || bad "the cleanup script with apply=1 did not commit (psql output: $(cut -c1-400 <<<"$rd_clean_apply"))"
# the same two DELETEs, then 166 applies and adds both foreign keys
rd_after=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$tr_down
$to_down
$ll_down
$rr_down
$la_down
INSERT INTO projects (project_id, project_code, project_name) VALUES ('${RDK}a1', 'TRD-P', 'readers preflight');
INSERT INTO project_investigators (project_id, user_id) VALUES ('${RDK}a1', '${RDK}e1');
DELETE FROM sample_co_owners c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id);
DELETE FROM project_investigators i WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = i.user_id);
$la_up
SELECT 'after_cleanup_up:ok';
ROLLBACK;
SQL
)
grep -q "^after_cleanup_up:ok" <<<"$rd_after" && ok "after the dangling rows are removed 166 applies and adds both foreign keys" || bad "166 did not apply after the cleanup (psql output: $(cut -c1-500 <<<"$rd_after"))"
rd_cycle=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
CREATE TEMP TABLE rd_before AS SELECT 'sample_readers' AS k, count(*) AS n FROM sample_readers UNION ALL SELECT 'operation_readers', count(*) FROM operation_readers
  UNION ALL SELECT 'project_readers', count(*) FROM project_readers UNION ALL SELECT 'campaign_sample_readers', count(*) FROM campaign_sample_readers
  UNION ALL SELECT 'open', count(*) FROM operation_open_to_all UNION ALL SELECT 'hidden', count(*) FROM d1_private.hidden_records;
-- a second up changes nothing and leaves no drift (the Lab Member rows part keeps a temp table until commit)
DROP TABLE IF EXISTS _lm_access_rules;
$la_up
SELECT 'up2_drift:' || d1_private.readers_drift_count();
SELECT 'up2_same:' || count(*) FROM (SELECT 'sample_readers' AS k, count(*) AS n FROM sample_readers UNION ALL SELECT 'operation_readers', count(*) FROM operation_readers
  UNION ALL SELECT 'project_readers', count(*) FROM project_readers UNION ALL SELECT 'campaign_sample_readers', count(*) FROM campaign_sample_readers
  UNION ALL SELECT 'open', count(*) FROM operation_open_to_all UNION ALL SELECT 'hidden', count(*) FROM d1_private.hidden_records EXCEPT SELECT * FROM rd_before) x;
-- down removes everything it created
$tr_down
$to_down
$ll_down
$rr_down
$la_down
SELECT 'dn_tables:' || count(*) FROM pg_tables WHERE tablename IN ('sample_readers','operation_readers','test_readers','campaign_readers','project_readers','campaign_sample_readers','operation_open_to_all') OR (schemaname = 'd1_private' AND tablename IN ('hidden_records', 'readers_added_fks'));
SELECT 'dn_functions:' || count(*) FROM pg_proc WHERE pronamespace = 'd1_private'::regnamespace AND (proname LIKE 'readers\_%' OR proname LIKE 'trg\_readers\_%' OR proname IN ('refresh_readers','sync_readers','is_hidden','hidden_of','operation_open_of','can_read_sample','s_read','rec_read'));
SELECT 'dn_triggers:' || count(*) FROM pg_trigger WHERE tgname LIKE '%\_readers\_%';
SELECT 'dn_views:' || count(*) FROM pg_views WHERE schemaname = 'd1_private' AND viewname LIKE 'v\_%';
SELECT 'dn_meta:' || (SELECT count(*) FROM directus_relations WHERE many_collection LIKE '%\_readers' OR many_collection = 'operation_open_to_all') || '/' || (SELECT count(*) FROM directus_fields WHERE field IN ('readers','open_to_all') OR collection LIKE '%\_readers' OR collection = 'operation_open_to_all')
       || '/' || (SELECT count(*) FROM directus_collections WHERE collection LIKE '%\_readers' OR collection = 'operation_open_to_all');
SELECT 'dn_fks:' || count(*) FROM pg_constraint WHERE conname IN ('sample_co_owners_user_id_fkey','project_investigators_user_id_fkey');
SELECT 'dn_rollup_unlocked:' || (position('d1_readers' IN prosrc) = 0) FROM pg_proc WHERE proname = 'refresh_project_rollup' AND pronamespace = 'public'::regnamespace;
-- and up again gives the same tables, drift empty
DROP TABLE IF EXISTS _lm_access_rules;
$la_up
$rr_up
$ll_up
SELECT 'up3_drift:' || d1_private.readers_drift_count();
SELECT 'up3_same:' || count(*) FROM (SELECT 'sample_readers' AS k, count(*) AS n FROM sample_readers UNION ALL SELECT 'operation_readers', count(*) FROM operation_readers
  UNION ALL SELECT 'project_readers', count(*) FROM project_readers UNION ALL SELECT 'campaign_sample_readers', count(*) FROM campaign_sample_readers
  UNION ALL SELECT 'open', count(*) FROM operation_open_to_all UNION ALL SELECT 'hidden', count(*) FROM d1_private.hidden_records EXCEPT SELECT * FROM rd_before) x;
ROLLBACK;
SQL
)
expect_fixed rd_cycle "up2_drift:0" "a second up leaves readers_drift() empty"
expect_fixed rd_cycle "up2_same:0" "a second up changes no row count (the backfill is a zero diff)"
expect_fixed rd_cycle "dn_tables:0" "down drops the seven readers tables and hidden_records"
expect_fixed rd_cycle "dn_functions:0" "down drops every d1_private function it created"
expect_fixed rd_cycle "dn_triggers:0" "down drops every readers trigger"
expect_fixed rd_cycle "dn_views:0" "down drops the pair-relation views"
expect_fixed rd_cycle "dn_meta:0/0/0" "down removes the Directus relations, fields and collections it added"
expect_fixed rd_cycle "dn_fks:0" "down drops the two legacy foreign keys it added"
expect_fixed rd_cycle "dn_rollup_unlocked:true" "down restores refresh_project_rollup() without the readers lock"
expect_fixed rd_cycle "up3_drift:0" "up after down gives drift 0"
expect_fixed rd_cycle "up3_same:0" "up after down rebuilds the same readers tables"

echo "== Migrations 166 and 167: Lab Member record access rules apply, reapply and reverse =="
# The database was migrated to the head, so 166 and 167 are applied. 167 goes down first (it rewrites the project_rollup
# row 166 left), then 166: main's rows must be back exactly (the frozen generator output of 2026-10-12 is
# tests/scripts/fixtures/lab_member_rules_main.json). Up again must give 166's rows, a second up must change nothing
# and keep the first backup, the second down must restore the same rows (ids included), and 166 + 167 up must give
# the generated rows (the head). Everything runs in a rolled-back transaction.
rules_main_json=$(python3 -c "import json;print(json.dumps(json.load(open('tests/scripts/fixtures/lab_member_rules_main.json'))))")
la_out=$($PSQL 2>&1 <<SQL
BEGIN;
CREATE TEMP TABLE _gen AS
  SELECT * FROM json_to_recordset(\$rules\$$rules_json\$rules\$::json)
    AS x(collection text, action text, permissions jsonb, validation jsonb, fields text, ruled boolean);
CREATE TEMP TABLE _main AS
  SELECT * FROM json_to_recordset(\$m\$$rules_main_json\$m\$::json) AS x(collection text, action text, permissions jsonb);
CREATE TEMP TABLE head_rows AS SELECT * FROM directus_permissions WHERE policy = '$LM';
SELECT 'head_backup_rows:' || count(*) FROM d1_private.lab_member_access_rules_backup;
$tr_down
$ll_down
$rr_down
$la_down
SELECT 'dn_backup:' || coalesce(to_regclass('d1_private.lab_member_access_rules_backup')::text, 'gone');
SELECT 'dn_main_rows:' || count(*) FROM _main;
SELECT 'dn_matches_main:' || count(*) FROM _main m JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = m.collection AND p.action = m.action AND p.permissions::jsonb = m.permissions;
SELECT 'dn_access_rows:' || count(*) FROM directus_permissions WHERE policy = '$LM' AND collection LIKE '%\_access';
CREATE TEMP TABLE old_rows AS SELECT * FROM directus_permissions WHERE policy = '$LM';
$la_up
-- 184 (team ownership rules) only rewrites rows 166 wrote: 166 + 184 give the generated rules
$tr_up
SELECT 'up_exact:' || count(*) FROM _gen g JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = g.collection AND p.action = g.action AND p.permissions::jsonb = g.permissions
 AND (g.fields = '*' OR p.fields = g.fields) AND (g.validation = '{}'::jsonb OR p.validation::jsonb = g.validation)
 WHERE g.ruled AND g.collection <> 'project_rollup';
SELECT 'up_access_rows:' || count(*) FROM directus_permissions WHERE policy = '$LM' AND collection LIKE '%\_access';
SELECT 'up_backup_rows:' || count(*) FROM d1_private.lab_member_access_rules_backup;
SELECT 'up_backup_inserted:' || count(*) FROM d1_private.lab_member_access_rules_backup WHERE inserted;
SELECT 'up_backup_commented:' || (obj_description('d1_private.lab_member_access_rules_backup'::regclass, 'pg_class') IS NOT NULL);
SELECT 'up_llm_select:' || has_table_privilege('d1_llm_readonly', 'd1_private.lab_member_access_rules_backup', 'SELECT');
SELECT 'up_in_dictionary:' || count(*) FROM v_schema_dictionary WHERE object_name LIKE 'lab\_member\_access%';
CREATE TEMP TABLE up_rows AS SELECT * FROM directus_permissions WHERE policy = '$LM';
$tr_down
DROP TABLE _lm_access_rules;
$la_up
$tr_up
SELECT 'up2_backup_rows:' || count(*) FROM d1_private.lab_member_access_rules_backup;
-- (migration 196's file_readers read row is deleted by its down and inserted again by its up, so it has a new id: left out of this comparison)
SELECT 'up2_unchanged:' || count(*) FROM ((SELECT to_jsonb(r) FROM up_rows r WHERE r.collection <> 'file_readers' EXCEPT SELECT to_jsonb(p) FROM directus_permissions p WHERE p.policy = '$LM' AND p.collection <> 'file_readers')
  UNION ALL (SELECT to_jsonb(p) FROM directus_permissions p WHERE p.policy = '$LM' AND p.collection <> 'file_readers' EXCEPT SELECT to_jsonb(r) FROM up_rows r WHERE r.collection <> 'file_readers')) x;
SELECT 'up2_backup_still_old:' || count(*) FROM d1_private.lab_member_access_rules_backup b JOIN old_rows o ON o.id = b.id
 WHERE b.permissions::jsonb IS DISTINCT FROM o.permissions::jsonb;
$tr_down
$la_down
SELECT 'dn2_exact:' || count(*) FROM ((SELECT to_jsonb(r) FROM old_rows r EXCEPT SELECT to_jsonb(p) FROM directus_permissions p WHERE p.policy = '$LM')
  UNION ALL (SELECT to_jsonb(p) FROM directus_permissions p WHERE p.policy = '$LM' EXCEPT SELECT to_jsonb(r) FROM old_rows r)) x;
SELECT 'dn2_backup:' || coalesce(to_regclass('d1_private.lab_member_access_rules_backup')::text, 'gone');
DROP TABLE _lm_access_rules;
$la_up
$rr_up
$ll_up
$tr_up
SELECT 'up3_exact_as_head:' || count(*) FROM ((SELECT permissions::jsonb, collection, action FROM head_rows EXCEPT SELECT permissions::jsonb, collection, action FROM directus_permissions WHERE policy = '$LM')
  UNION ALL (SELECT permissions::jsonb, collection, action FROM directus_permissions WHERE policy = '$LM' EXCEPT SELECT permissions::jsonb, collection, action FROM head_rows)) x;
SELECT 'final_exact:' || count(*) FROM _gen g JOIN directus_permissions p
  ON p.policy = '$LM' AND p.collection = g.collection AND p.action = g.action AND p.permissions::jsonb = g.permissions
 AND (g.fields = '*' OR p.fields = g.fields) AND (g.validation = '{}'::jsonb OR p.validation::jsonb = g.validation)
 WHERE g.ruled;
ROLLBACK;
SQL
)
expect_fixed la_out "dn_backup:gone" "down drops the backup table"
expect_fixed la_out "dn_main_rows:72" "(setup) main's frozen Lab Member filters hold 72 rows"
expect_fixed la_out "dn_matches_main:72" "167 down then 166 down: every ruled Lab Member row is exactly main's filter again"
expect_fixed la_out "dn_access_rows:0" "down: the five access table rows it inserted are gone"
la_n=$(grep -o '^final_exact:[0-9]*' <<<"$la_out" | cut -d: -f2)
[[ "${la_n:-0}" -eq "${gen_n:-x}" ]] && ok "166 + 167 up: every ruled row matches the generated rules ($la_n rows)" || bad "up: ruled rows differ from the generated rules (psql output: $la_out)"
[[ "$(grep -o '^up_exact:[0-9]*' <<<"$la_out" | cut -d: -f2)" -eq "$(( ${gen_n:-0} - 7 ))" ]] \
    && ok "166 (with 184's rule rows): every ruled row but project_rollup (167's), people update (169's), people create (194's) and the four create/update field lists of 174 matches the generated rules" || bad "166 alone: ruled rows differ (psql output: $la_out)"
expect_fixed la_out "up_access_rows:5" "up: the five access tables get their own-rows read row"
expect_fixed la_out "up_backup_inserted:12" "up: exactly the twelve new rows (five access tables, six readers tables, operation_open_to_all) are recorded as inserted"
expect_fixed la_out "up_backup_commented:true" "up: the backup table has a comment"
expect_fixed la_out "up_llm_select:false" "up: the LLM role cannot read the backup"
expect_fixed la_out "up_in_dictionary:0" "up: the backup is not in v_schema_dictionary (the Ask-DB prompt)"
expect_fixed la_out "up2_unchanged:0" "a second up changes no Lab Member row"
expect_fixed la_out "up2_backup_still_old:0" "a second up keeps the first backup (the old permissions)"
expect_fixed la_out "dn2_exact:0" "down after a second up restores the rows exactly (ids, filters, fields)"
expect_fixed la_out "dn2_backup:gone" "down after a second up drops the backup table"
expect_fixed la_out "up3_exact_as_head:0" "up again gives the rows the database had at the head"
[[ "$(grep -o '^up2_backup_rows:[0-9]*' <<<"$la_out" | cut -d: -f2)" == "$(grep -o '^up_backup_rows:[0-9]*' <<<"$la_out" | cut -d: -f2)" ]] \
    && ok "a second up adds no backup rows" || bad "a second up changed the backup (psql output: $la_out)"

echo "== Migration 167: the project rollup carries restricted =="
# The cache (project_rollup) and the view behind it gain `restricted`; the refresh copies it; flipping a sample's flag
# refreshes the cache; the Lab Member rule lets the PI read every row and an investigator only restricted = false rows.
# All inside one rolled-back transaction: seed, check, then 167's down and up again.
RR=$(migration project_rollup_restricted)
rr_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RR")
rr_down=$(awk '/-- migrate:down/{f=1;next}f' "$RR")
RRK=c0000000-0000-4000-8000-0000000000
rr_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO manufacturing_methods (method_id, method_code, method_name) VALUES ('${RRK}e1', 'T-RR-M', 'rollup restricted test');
INSERT INTO projects (project_id, project_code, project_name) VALUES ('${RRK}b1', 'TRR-P', 'rollup restricted test');
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, restricted) VALUES ('${RRK}f1', '${RRK}b1', 'testing_campaign', 'trr restricted campaign', true);
INSERT INTO physical_samples (sample_id, sample_code, restricted) VALUES ('${RRK}d1', 'TRR-S1', true), ('${RRK}d2', 'TRR-S2', false);
INSERT INTO tools (tool_id, tool_code, tool_name) VALUES ('${RRK}a1', 'TRR-TOOL-A', 'only restricted ops'), ('${RRK}a2', 'TRR-TOOL-B', 'restricted and open ops');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, project_id, campaign_id, tool_id, pass_code, restricted) VALUES
    ('${RRK}c1', '${RRK}e1', '${RRK}d1', '${RRK}b1', NULL, '${RRK}a1', 'TRR-O1', false),   -- under a restricted sample
    ('${RRK}c2', '${RRK}e1', '${RRK}d2', '${RRK}b1', NULL, '${RRK}a1', 'TRR-O2', true),    -- restricted itself
    ('${RRK}c3', '${RRK}e1', '${RRK}d2', NULL, '${RRK}f1', '${RRK}a2', 'TRR-O3', false),   -- in a restricted campaign (project through it)
    ('${RRK}c4', '${RRK}e1', '${RRK}d2', '${RRK}b1', NULL, '${RRK}a2', 'TRR-O4', false),   -- nothing restricted
    ('${RRK}c5', '${RRK}e1', '${RRK}d2', '${RRK}b1', NULL, NULL, 'TRR-O5', false);
SELECT 'col:' || is_nullable || '/' || column_default FROM information_schema.columns WHERE table_name = 'project_rollup' AND column_name = 'restricted';
SELECT 'view_last_col:' || (SELECT attname FROM pg_attribute WHERE attrelid = 'v_project_rollup'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum DESC LIMIT 1);
SELECT 'ops:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
SELECT 'tools:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'tool' AND project_id = '${RRK}b1';
SELECT 'samples:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'sample' AND project_id = '${RRK}b1';
SELECT 'cache_eq_view:' || (SELECT count(*) FROM (SELECT row_id, restricted FROM project_rollup EXCEPT SELECT row_id, restricted FROM v_project_rollup) x);
UPDATE physical_samples SET restricted = true WHERE sample_id = '${RRK}d2';
SELECT 'flip_ops:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
SELECT 'flip_tools:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'tool' AND project_id = '${RRK}b1';
SELECT 'flip_samples:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'sample' AND project_id = '${RRK}b1';
UPDATE physical_samples SET restricted = false WHERE sample_id = '${RRK}d2';
SELECT 'unflip_ops:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
SELECT 'rule_restricted:' || (permissions::jsonb @> '{"_or":[{"_and":[{"restricted":{"_eq":false}}]}]}'::jsonb) FROM directus_permissions WHERE policy = '$LM' AND collection = 'project_rollup' AND action = 'read';
SELECT 'backup:' || count(*) FROM d1_private.project_rollup_restricted_backup;
SELECT 'trigger:' || count(*) FROM pg_trigger WHERE tgname = 'refresh_rollup_samples' AND tgrelid = 'physical_samples'::regclass;
-- restricted is DERIVED from d1_private.hidden_records (the readers of migration 166), so it also follows what the own flags missed:
-- a campaign_samples row, a projects.restricted flip (neither fires a rollup trigger), a restricted project's campaign, a sample's other campaign
INSERT INTO campaign_samples (campaign_id, sample_id) VALUES ('${RRK}f1', '${RRK}d2');
SELECT 'cs_ops:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
SELECT 'cs_sample:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'sample' AND project_id = '${RRK}b1';
DELETE FROM campaign_samples WHERE campaign_id = '${RRK}f1' AND sample_id = '${RRK}d2';
SELECT 'cs_back:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
UPDATE projects SET restricted = true WHERE project_id = '${RRK}b1';
SELECT 'pj_flip:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
UPDATE projects SET restricted = false WHERE project_id = '${RRK}b1';
SELECT 'pj_back:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
-- an operation on a sample held only by a restricted campaign (the campaign is neither the operation's nor the sample's own flag)
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, restricted) VALUES ('${RRK}f3', NULL, 'testing_campaign', 'trr sample campaign', true);
INSERT INTO physical_samples (sample_id, sample_code, restricted) VALUES ('${RRK}d3', 'TRR-S3', false);
INSERT INTO campaign_samples (campaign_id, sample_id) VALUES ('${RRK}f3', '${RRK}d3');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, project_id, pass_code) VALUES ('${RRK}c7', '${RRK}e1', '${RRK}d3', '${RRK}b1', 'TRR-O7');
SELECT 'heldby:' || (SELECT restricted FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1' AND code = 'TRR-O7')
       || '/' || (SELECT restricted FROM project_rollup WHERE kind = 'sample' AND project_id = '${RRK}b1' AND code = 'TRR-S3')
       || '/' || d1_private.is_hidden('manufacturing_operations', '${RRK}c7') || '/' || d1_private.is_hidden('physical_samples', '${RRK}d3');
-- an operation in a restricted PROJECT's campaign: restricted although neither its own flag nor its campaign's is set
INSERT INTO projects (project_id, project_code, project_name, restricted) VALUES ('${RRK}b2', 'TRR-P2', 'rollup restricted project', true);
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, restricted) VALUES ('${RRK}f2', '${RRK}b2', 'testing_campaign', 'trr campaign of a restricted project', false);
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, campaign_id, pass_code) VALUES ('${RRK}c6', '${RRK}e1', '${RRK}d2', '${RRK}f2', 'TRR-O6');
SELECT 'inproject:' || (SELECT restricted FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b2' AND code = 'TRR-O6') || '/' || d1_private.is_hidden('manufacturing_operations', '${RRK}c6');
SELECT 'drift:' || d1_private.readers_drift_count();
$ll_down
$rr_down
SELECT 'dn_col:' || count(*) FROM information_schema.columns WHERE table_name = 'project_rollup' AND column_name = 'restricted';
SELECT 'dn_view_col:' || count(*) FROM information_schema.columns WHERE table_name = 'v_project_rollup' AND column_name = 'restricted';
SELECT 'dn_trigger:' || count(*) FROM pg_trigger WHERE tgname = 'refresh_rollup_samples';
SELECT 'dn_rule_restricted:' || (permissions::jsonb::text LIKE '%"restricted"%') FROM directus_permissions WHERE policy = '$LM' AND collection = 'project_rollup' AND action = 'read';
SELECT 'dn_backup:' || coalesce(to_regclass('d1_private.project_rollup_restricted_backup')::text, 'gone');
SELECT 'dn_view_comment:' || (obj_description('v_project_rollup'::regclass, 'pg_class') IS NOT NULL);
SELECT 'dn_cache_eq_view:' || (SELECT count(*) FROM (SELECT row_id FROM project_rollup EXCEPT SELECT row_id FROM v_project_rollup) x);
$rr_up
$ll_up
SELECT 'up2_col:' || count(*) FROM information_schema.columns WHERE table_name = 'project_rollup' AND column_name = 'restricted';
SELECT 'up2_ops:' || string_agg(code || '=' || restricted, ',' ORDER BY code) FROM project_rollup WHERE kind = 'operation' AND project_id = '${RRK}b1';
SELECT 'up2_rule_restricted:' || (permissions::jsonb @> '{"_or":[{"_and":[{"restricted":{"_eq":false}}]}]}'::jsonb) FROM directus_permissions WHERE policy = '$LM' AND collection = 'project_rollup' AND action = 'read';
ROLLBACK;
SQL
)
expect_fixed rr_out "col:NO/false" "project_rollup.restricted is NOT NULL DEFAULT false"
expect_fixed rr_out "view_last_col:restricted" "v_project_rollup gains restricted as its last column"
expect_fixed rr_out "ops:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=false,TRR-O5=false" "an operation row is restricted when the operation, its sample or its campaign is"
expect_fixed rr_out "tools:TRR-TOOL-A=true,TRR-TOOL-B=false" "a tool used only by restricted operations is restricted, one with an open operation is not"
expect_fixed rr_out "samples:TRR-S1=true,TRR-S2=false" "a sample row carries the sample's own flag"
expect_fixed rr_out "cache_eq_view:0" "the cache equals the view (restricted included) after the inserts"
expect_fixed rr_out "flip_ops:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=true,TRR-O5=true" "flipping a sample's flag refreshes the cache: its operations turn restricted"
expect_fixed rr_out "flip_tools:TRR-TOOL-A=true,TRR-TOOL-B=true" "...and a tool whose every operation is now restricted turns restricted"
expect_fixed rr_out "flip_samples:TRR-S1=true,TRR-S2=true" "...and the sample row follows"
expect_fixed rr_out "unflip_ops:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=false,TRR-O5=false" "flipping it back restores the rows"
expect_fixed rr_out "cs_ops:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=true,TRR-O5=true" "a campaign_samples insert refreshes the cache: the operations on a sample that joined a restricted campaign turn restricted"
expect_fixed rr_out "cs_sample:TRR-S1=true,TRR-S2=true" "...and so does the sample row"
expect_fixed rr_out "cs_back:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=false,TRR-O5=false" "deleting the junction row restores them"
expect_fixed rr_out "pj_flip:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=true,TRR-O5=true" "flipping projects.restricted refreshes the cache (no rollup trigger fires for it): everything in the project is restricted"
expect_fixed rr_out "pj_back:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=false,TRR-O5=false" "...and flipping it back restores the rows"
expect_fixed rr_out "heldby:true/true/true/true" "an operation on a sample held only by a restricted campaign is restricted in the rollup and hidden from the Ask-DB role (own flags alone missed it)"
expect_fixed rr_out "inproject:true/true" "an operation in a restricted project's campaign is restricted in the rollup and hidden from the Ask-DB role"
expect_fixed rr_out "drift:0" "the readers tables are right after all of it"
expect_fixed rr_out "rule_restricted:true" "the Lab Member project_rollup rule tests restricted = false for investigators"
expect_fixed rr_out "backup:1" "the old rule is kept in the backup table"
expect_fixed rr_out "trigger:1" "a statement trigger on physical_samples refreshes the cache"
expect_fixed rr_out "dn_col:0" "down: the column is gone"
expect_fixed rr_out "dn_view_col:0" "down: the view is back without it"
expect_fixed rr_out "dn_trigger:0" "down: the trigger is gone"
expect_fixed rr_out "dn_rule_restricted:false" "down: the old Lab Member rule is back"
expect_fixed rr_out "dn_backup:gone" "down: the backup table is dropped"
expect_fixed rr_out "dn_view_comment:true" "down: the view keeps its comment"
expect_fixed rr_out "dn_cache_eq_view:0" "down: the cache equals the old view"
expect_fixed rr_out "up2_col:1" "a second up works (the column is back)"
expect_fixed rr_out "up2_ops:TRR-O1=true,TRR-O2=true,TRR-O3=true,TRR-O4=false,TRR-O5=false,TRR-O7=true" "a second up refills the cache (restricted derived from hidden_records again)"
expect_fixed rr_out "up2_rule_restricted:true" "a second up puts the rule back"
