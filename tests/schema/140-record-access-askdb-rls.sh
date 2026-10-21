# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Record access: restricted flag and access tables (migration 165) =="
# Each check is its own rolled-back transaction (ids prefix a1000000-0000-4000-8000-). A rejected
# statement aborts psql (ON_ERROR_STOP), so the error text is what is asserted on.
RA_MIG=$(migration record_access)
[[ -f "$RA_MIG" ]] && ok "found migration 165" || bad "migration 165 is missing ($RA_MIG)"
RA_P1='a1000000-0000-4000-8000-0000000000a1'
RA_P2='a1000000-0000-4000-8000-0000000000a2'
RA_P3='a1000000-0000-4000-8000-0000000000a3'
RA_S='a1000000-0000-4000-8000-0000000000b1'
RA_M='a1000000-0000-4000-8000-0000000000b2'
RA_O='a1000000-0000-4000-8000-0000000000b3'
RA_T='a1000000-0000-4000-8000-0000000000b4'
RA_C='a1000000-0000-4000-8000-0000000000b5'
RA_J='a1000000-0000-4000-8000-0000000000b6'
# the five tables: table:parent column:parent table:second role
RA_TABLES="sample_access:sample_id:physical_samples:edit operation_access:operation_id:manufacturing_operations:edit test_access:session_id:test_sessions:edit campaign_access:campaign_id:campaigns:edit project_access:project_id:projects:investigator"
RA_PARENT_ID() { case "$1" in sample_id) echo "$RA_S";; operation_id) echo "$RA_O";; session_id) echo "$RA_T";; campaign_id) echo "$RA_C";; project_id) echo "$RA_J";; esac; }
ra_sql() { # ra_sql <statements>: run them after the fixture records, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('$RA_P1', 'RA One'), ('$RA_P2', 'RA Two'), ('$RA_P3', 'RA Three');
INSERT INTO projects (project_id, project_code, project_name) VALUES ('$RA_J', 'ZZ-RA-001', 'record access probe');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('$RA_S', 'TEST-RA-001');
INSERT INTO manufacturing_methods (method_id, method_code, method_name) VALUES ('$RA_M', 'T-RA', 'record access test method');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code) VALUES ('$RA_O', '$RA_M', '$RA_S', 'TEST-RA-OP');
INSERT INTO test_sessions (session_id, sample_id) VALUES ('$RA_T', '$RA_S');
INSERT INTO campaigns (campaign_id, name, campaign_type) VALUES ('$RA_C', 'RA campaign', 'machining_trial');
$1
ROLLBACK;
SQL
}
run_eq "the five access tables exist" \
    "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('sample_access','operation_access','test_access','campaign_access','project_access')" \
    "campaign_access,operation_access,project_access,sample_access,test_access"
for ra_spec in $RA_TABLES; do
    IFS=: read -r ra_t ra_pc ra_pt ra_r2 <<<"$ra_spec"
    ra_pid=$(RA_PARENT_ID "$ra_pc")
    run_eq "$ra_t: columns, types and defaults are as specified" \
        "SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '-'), '; ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$ra_t'" \
        "access_id uuid NO gen_random_uuid(); $ra_pc uuid NO -; person_id uuid NO -; role text NO -; added_by_person_id uuid YES -; created_at timestamp with time zone NO now(); team_access_id uuid YES -"
    # migration 182 split the unique key: a person's own entry is unique per record (team_access_id NULL, same name as 165's constraint),
    # a team's derived row per record and grant
    run_eq "$ra_t: primary key access_id, unique ($ra_pc, person_id) for own entries and per team grant for derived rows, index on person_id" \
        "SELECT (SELECT string_agg(a.attname, ',') FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) WHERE i.indrelid = 'public.$ra_t'::regclass AND i.indisprimary)
         || '/' || coalesce((SELECT string_agg(pg_get_constraintdef(c.oid), ',') FROM pg_constraint c WHERE c.conrelid = 'public.$ra_t'::regclass AND c.contype = 'u'), 'no constraint')
         || '/' || (SELECT string_agg(indexname || ' ' || regexp_replace(indexdef, '^.* USING btree ', ''), '; ' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = '$ra_t' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexname <> '${ra_t}_pkey')
         || '/' || (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = '$ra_t' AND indexdef LIKE '%(person_id)%' AND indexname <> '${ra_t}_pkey')" \
        "access_id/no constraint/${ra_t}_${ra_pc}_person_id_key ($ra_pc, person_id) WHERE (team_access_id IS NULL); ${ra_t}_${ra_pc}_person_id_team_key ($ra_pc, person_id, team_access_id) WHERE (team_access_id IS NOT NULL)/1"
    run_eq "$ra_t: parent, person and team grant foreign keys cascade, added_by_person_id is set NULL" \
        "SELECT string_agg(a.attname || '>' || c.confrelid::regclass::text || ':' || c.confdeltype::text, ',' ORDER BY a.attname COLLATE \"C\") FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] WHERE c.conrelid = 'public.$ra_t'::regclass AND c.contype = 'f'" \
        "$(printf '%s\n' 'added_by_person_id>people:n' 'person_id>people:c' "$ra_pc>$ra_pt:c" "team_access_id>${ra_t%_access}_team_access:c" | LC_ALL=C sort | paste -sd, -)"
    run_eq "$ra_t has the audit trigger of migration 121" \
        "SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.$ra_t'::regclass AND NOT t.tgisinternal AND t.tgfoid = 'audit_trigger_function'::regproc AND (t.tgtype & 1) = 1 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16" "1"
    run_eq "$ra_t has no OCC version column" \
        "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$ra_t' AND column_name = 'version'" "0"
    # roles: view and $ra_r2 are accepted; the other table's second role, owner and NULL are not
    ra_other=$([[ "$ra_r2" == edit ]] && echo investigator || echo edit)
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', 'view'), ('$ra_pid', '$RA_P2', '$ra_r2');
SELECT 'ra_roles:' || string_agg(role, ',' ORDER BY role) FROM $ra_t WHERE $ra_pc = '$ra_pid';
SELECT 'ra_defaults:' || (added_by_person_id IS NULL) || ':' || (created_at IS NOT NULL) || ':' || (access_id IS NOT NULL) FROM $ra_t WHERE person_id = '$RA_P1';")
    grep -qx "ra_roles:$ra_r2,view" <<<"$ra_out" && ok "$ra_t accepts the roles view and $ra_r2" || bad "$ra_t does not accept view and $ra_r2 (output: $ra_out)"
    grep -qx "ra_defaults:true:true:true" <<<"$ra_out" && ok "$ra_t fills access_id and created_at, and added_by_person_id stays NULL" || bad "$ra_t defaults are wrong (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', '$ra_other');")
    grep -q "${ra_t}_role_check" <<<"$ra_out" && ok "$ra_t refuses the role $ra_other (check constraint)" || bad "$ra_t accepted the role $ra_other (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', 'owner');")
    grep -q "${ra_t}_role_check" <<<"$ra_out" && ok "$ra_t refuses the role owner" || bad "$ra_t accepted the role owner (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', NULL);")
    grep -q 'not-null constraint' <<<"$ra_out" && ok "$ra_t refuses a NULL role" || bad "$ra_t accepted a NULL role (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', 'view');
INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', '$ra_r2');")
    grep -q 'duplicate key' <<<"$ra_out" && ok "$ra_t: a person is listed once per record (unique key)" || bad "$ra_t listed a person twice on one record (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', 'a1000000-0000-4000-8000-0000000000ff', 'view');")
    grep -q 'foreign key' <<<"$ra_out" && ok "$ra_t: a grant for a person that does not exist is refused" || bad "$ra_t accepted an unknown person (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('a1000000-0000-4000-8000-0000000000fe', '$RA_P1', 'view');")
    grep -q 'foreign key' <<<"$ra_out" && ok "$ra_t: a grant on a record that does not exist is refused" || bad "$ra_t accepted an unknown record (output: $ra_out)"
    # cascades: the person's rows go with the person (only theirs); the record's list goes with the record;
    # deleting the person who added a grant keeps the grant and clears added_by_person_id
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role, added_by_person_id) VALUES ('$ra_pid', '$RA_P1', 'view', '$RA_P3'), ('$ra_pid', '$RA_P2', '$ra_r2', '$RA_P3');
DELETE FROM people WHERE person_id = '$RA_P1';
SELECT 'ra_person_cascade:' || string_agg(person_id::text, ',') FROM $ra_t;
DELETE FROM people WHERE person_id = '$RA_P3';
SELECT 'ra_added_by:' || count(*) || ':' || count(added_by_person_id) FROM $ra_t;")
    grep -qx "ra_person_cascade:$RA_P2" <<<"$ra_out" && ok "$ra_t: deleting a person removes their access rows and only theirs" || bad "$ra_t rows did not follow their person (output: $ra_out)"
    grep -qx "ra_added_by:1:0" <<<"$ra_out" && ok "$ra_t: deleting the person who added a grant keeps it and clears added_by_person_id" || bad "$ra_t added_by_person_id did not clear (output: $ra_out)"
    case "$ra_pc" in
        sample_id)    ra_del="DELETE FROM test_sessions WHERE sample_id = '$RA_S'; DELETE FROM manufacturing_operations WHERE sample_id = '$RA_S'; DELETE FROM physical_samples WHERE sample_id = '$RA_S';";;
        operation_id) ra_del="DELETE FROM manufacturing_operations WHERE operation_id = '$RA_O';";;
        session_id)   ra_del="DELETE FROM test_sessions WHERE session_id = '$RA_T';";;
        campaign_id)  ra_del="DELETE FROM campaigns WHERE campaign_id = '$RA_C';";;
        project_id)   ra_del="DELETE FROM projects WHERE project_id = '$RA_J';";;
    esac
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', 'view'), ('$ra_pid', '$RA_P2', '$ra_r2');
$ra_del
SELECT 'ra_parent_cascade:' || count(*) FROM $ra_t;")
    grep -qx "ra_parent_cascade:0" <<<"$ra_out" && ok "$ra_t: deleting the record removes its whole access list" || bad "$ra_t rows survived their record (output: $ra_out)"
    ra_out=$(ra_sql "INSERT INTO $ra_t ($ra_pc, person_id, role) VALUES ('$ra_pid', '$RA_P1', 'view');
UPDATE $ra_t SET role = '$ra_r2' WHERE person_id = '$RA_P1';
DELETE FROM $ra_t WHERE person_id = '$RA_P1';
SELECT 'ra_audit:' || string_agg(action_type, ',' ORDER BY log_id) FROM audit_logs WHERE table_name = '$ra_t';
SELECT 'ra_audit_key:' || count(*) FROM audit_logs WHERE table_name = '$ra_t' AND record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$';
SELECT 'ra_audit_changed:' || (changed_fields -> 'role' ->> 'old') || '>' || (changed_fields -> 'role' ->> 'new') FROM audit_logs WHERE table_name = '$ra_t' AND action_type = 'UPDATE';")
    grep -qx "ra_audit:INSERT,UPDATE,DELETE" <<<"$ra_out" && ok "$ra_t: INSERT, UPDATE and DELETE each write an audit row" || bad "$ra_t audit rows are wrong (output: $ra_out)"
    grep -qx "ra_audit_key:3" <<<"$ra_out" && ok "$ra_t: audit record_id is the access_id" || bad "$ra_t audit record_id is not the access_id (output: $ra_out)"
    grep -qx "ra_audit_changed:view>$ra_r2" <<<"$ra_out" && ok "$ra_t: the audit row of a role change records old and new" || bad "$ra_t audit changed_fields is wrong (output: $ra_out)"
    run_eq "$ra_t: the table, every column and the person index have comments (without: none)" \
        "SELECT coalesce(string_agg(x, ', '), '') FROM (
            SELECT c.relname AS x FROM pg_class c WHERE c.oid IN ('public.$ra_t'::regclass, 'public.${ra_t}_person_idx'::regclass) AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
            UNION ALL
            SELECT a.attname FROM pg_attribute a WHERE a.attrelid = 'public.$ra_t'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND coalesce(col_description(a.attrelid, a.attnum), '') = '') q" ""
done
# the restricted flag
RA_PARENTS="physical_samples manufacturing_operations test_sessions campaigns projects"
for ra_pt in $RA_PARENTS; do
    run_eq "$ra_pt.restricted is BOOLEAN NOT NULL DEFAULT false" \
        "SELECT data_type || ' ' || is_nullable || ' ' || column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$ra_pt' AND column_name = 'restricted'" \
        "boolean NO false"
    run_eq "$ra_pt: no row is restricted after the migration" "SELECT count(*) FROM $ra_pt WHERE restricted" "0"
    run_eq "idx_${ra_pt}_restricted is a partial index WHERE restricted" \
        "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = '$ra_pt' AND indexname = 'idx_${ra_pt}_restricted' AND indexdef LIKE '%(restricted) WHERE restricted%'" "1"
    run_eq "$ra_pt.restricted and its index have comments" \
        "SELECT (coalesce(col_description('public.$ra_pt'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.$ra_pt'::regclass AND attname = 'restricted')), '') <> '')::text || '/' || (coalesce(obj_description('public.idx_${ra_pt}_restricted'::regclass, 'pg_class'), '') <> '')::text" \
        "true/true"
done
ra_out=$(ra_sql "SELECT 'ra_new_rows:' || ((SELECT restricted::int FROM physical_samples WHERE sample_id = '$RA_S') + (SELECT restricted::int FROM manufacturing_operations WHERE operation_id = '$RA_O') + (SELECT restricted::int FROM test_sessions WHERE session_id = '$RA_T') + (SELECT restricted::int FROM campaigns WHERE campaign_id = '$RA_C') + (SELECT restricted::int FROM projects WHERE project_id = '$RA_J'));")
grep -qx "ra_new_rows:0" <<<"$ra_out" \
    && ok "a record inserted without the column is unrestricted (the default, so no insert path needs to know the flag)" \
    || bad "a new record is not unrestricted by default (output: $ra_out)"
# Directus metadata as the migration leaves it
run_eq "the five access tables are hidden Directus collections" \
    "SELECT string_agg(collection, ',' ORDER BY collection) FROM directus_collections WHERE collection IN ('sample_access','operation_access','test_access','campaign_access','project_access') AND hidden" \
    "campaign_access,operation_access,project_access,sample_access,test_access"
run_eq "each parent foreign key has a relation with one_field 'access'" \
    "SELECT string_agg(many_collection || '.' || many_field || '>' || one_collection, ',' ORDER BY many_collection) FROM directus_relations WHERE one_field = 'access'" \
    "campaign_access.campaign_id>campaigns,operation_access.operation_id>manufacturing_operations,project_access.project_id>projects,sample_access.sample_id>physical_samples,test_access.session_id>test_sessions"
run_eq "person_id of each access table has a relation to people, with no alias" \
    "SELECT string_agg(many_collection, ',' ORDER BY many_collection) FROM directus_relations WHERE many_field = 'person_id' AND one_collection = 'people' AND one_field IS NULL AND many_collection IN ('sample_access','operation_access','test_access','campaign_access','project_access')" \
    "campaign_access,operation_access,project_access,sample_access,test_access"
run_eq "each relation exists once (no duplicates)" \
    "SELECT count(*) FROM (SELECT many_collection, many_field FROM directus_relations WHERE many_collection IN ('sample_access','operation_access','test_access','campaign_access','project_access') GROUP BY 1, 2 HAVING count(*) > 1) d" "0"
run_eq "the five 'access' alias fields are hidden o2m rows on the parents" \
    "SELECT string_agg(collection, ',' ORDER BY collection) FROM directus_fields WHERE field = 'access' AND special = 'o2m' AND hidden AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects')" \
    "campaigns,manufacturing_operations,physical_samples,projects,test_sessions"
run_eq "the five 'restricted' fields are hidden and read-only" \
    "SELECT string_agg(collection, ',' ORDER BY collection) FROM directus_fields WHERE field = 'restricted' AND hidden AND readonly AND collection IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects')" \
    "campaigns,manufacturing_operations,physical_samples,projects,test_sessions"
# every alias resolves: relation + alias field + a real column behind each side
run_eq "every access alias resolves (relation, alias field and both columns exist; unresolved: none)" \
    "SELECT coalesce(string_agg(r.many_collection, ', '), '') FROM directus_relations r
     WHERE r.one_field = 'access'
       AND (NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = r.one_collection AND f.field = 'access')
         OR NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = r.many_collection AND c.column_name = r.many_field)
         OR NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = r.one_collection AND c.column_name = 'restricted'))" ""
# down, then up again, in one rolled-back transaction: down removes everything (columns, tables, metadata),
# up restores it, a relation that points somewhere else stops the migration
ra_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$RA_MIG")
ra_down=$(awk '/-- migrate:down/{f=1;next}f' "$RA_MIG")
ra_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
-- 167 and 166 depend on 165's columns and tables, so they go down first (as on a real rollback)
$tr_down
$to_down
$ll_down
$rr_down
$la_down
CREATE TEMP TABLE ra_before AS
  SELECT (SELECT count(*) FROM directus_relations WHERE many_collection LIKE '%\_access') AS rels,
         (SELECT count(*) FROM directus_fields WHERE field IN ('access','restricted')) AS flds,
         (SELECT count(*) FROM directus_collections WHERE collection LIKE '%\_access') AS cols;
$ra_down
SELECT 'ra_down_tables:' || count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('sample_access','operation_access','test_access','campaign_access','project_access');
SELECT 'ra_down_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'restricted' AND table_name IN ('physical_samples','manufacturing_operations','test_sessions','campaigns','projects');
SELECT 'ra_down_indexes:' || count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx\_%\_restricted';
SELECT 'ra_down_meta:' || (SELECT count(*) FROM directus_relations WHERE many_collection LIKE '%\_access') || '/' || (SELECT count(*) FROM directus_fields WHERE field IN ('access','restricted') OR collection LIKE '%\_access') || '/' || (SELECT count(*) FROM directus_collections WHERE collection LIKE '%\_access');
$ra_up
SELECT 'ra_up_again:' || (a.rels = (SELECT count(*) FROM directus_relations WHERE many_collection LIKE '%\_access')) || '/' || (a.flds = (SELECT count(*) FROM directus_fields WHERE field IN ('access','restricted'))) || '/' || (a.cols = (SELECT count(*) FROM directus_collections WHERE collection LIKE '%\_access')) FROM ra_before a;
ROLLBACK;
SQL
)
grep -qx "ra_down_tables:0" <<<"$ra_out" && ok "165 down drops the five tables" || bad "165 down left a table (output: $ra_out)"
grep -qx "ra_down_columns:0" <<<"$ra_out" && ok "165 down drops the restricted columns" || bad "165 down left a restricted column (output: $ra_out)"
grep -qx "ra_down_indexes:0" <<<"$ra_out" && ok "165 down drops the partial indexes" || bad "165 down left an index (output: $ra_out)"
grep -qx "ra_down_meta:0/0/0" <<<"$ra_out" && ok "165 down removes the Directus relations, fields and collections it added" || bad "165 down left Directus metadata (output: $ra_out)"
grep -qx "ra_up_again:true/true/true" <<<"$ra_out" && ok "165 up after down restores the same metadata" || bad "165 up after down differs (output: $ra_out)"
ra_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$tr_down
$to_down
$ll_down
$rr_down
$la_down
$ra_down
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field) VALUES ('sample_access', 'sample_id', 'projects', NULL);
$ra_up
ROLLBACK;
SQL
)
grep -q "access rules need" <<<"$ra_out" && ok "165 stops when a relation it needs already points at another collection" || bad "165 did not stop on a relation pointing elsewhere (output: $ra_out)"
ra_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$tr_down
$to_down
$ll_down
$rr_down
$la_down
$ra_down
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field) VALUES ('campaign_samples', 'sample_id', 'physical_samples', 'access');
$ra_up
ROLLBACK;
SQL
)
grep -q "already used by another relation" <<<"$ra_out" && ok "165 stops when the alias 'access' is already taken on a parent" || bad "165 did not stop on a taken alias (output: $ra_out)"

echo "== Migration 168: Ask-DB row-level security (policies, security_invoker views, d1_embedder, reapply and reverse) =="
# Everything runs in rolled-back transactions as the owner (d1, which bypasses row security) with SET LOCAL ROLE d1_llm_readonly /
# d1_llm_app to read as the Ask-DB role, and a throwaway embedder-like role. Fixture (LLK = key prefix):
#   restricted project PR holding campaign CR (not restricted itself) with sample SC; restricted sample SR (operation, test, files,
#   force analysis); open project PO and campaign CO; open samples SO and S2; operations OO (open), ORR (on SR), OC (on SC), OCAMP
#   (open sample, campaign CR) and OX (restricted flag, open sample); one embedding per source, a lot note, an unknown source and an orphan.
LLK=e1680000-0000-4000-8000-0000000000
LL_VEC="('['||array_to_string(array_fill(0.1::real, ARRAY[768]),',')||']')::vector"
LL_TABLES="physical_samples manufacturing_operations test_sessions campaigns projects campaign_samples sample_genealogy sample_stock_provenance sample_co_owners sample_data_files operation_data_files operation_files prep_steps machining_force_analysis fast_run_data diag_layer session_data_files test_sessions_subject project_investigators semantic_embeddings"
# the test database may hold other samples and genealogy edges (earlier sections), so those two are counted by the fixture's key
ll_where() { case "$1" in
    physical_samples) echo "WHERE sample_code LIKE 'FXRLS-%'" ;;
    sample_genealogy) echo "WHERE child_sample_id::text LIKE 'e1680000%' OR parent_sample_id::text LIKE 'e1680000%'" ;;
esac; }
ll_counts() { local t; for t in $LL_TABLES; do printf "SELECT '%s:%s:' || count(*) FROM %s %s;\n" "$1" "$t" "$t" "$(ll_where "$t")"; done; }
ll_views() { cat <<VSQL
SELECT '$1_rollup_hidden_project:' || count(*) FROM project_rollup WHERE project_id = '${LLK}a1';
SELECT '$1_rollup_open_project:' || (count(*) > 0) FROM project_rollup WHERE project_id = '${LLK}a2';
SELECT '$1_view_rollup_hidden_project:' || count(*) FROM v_project_rollup WHERE project_id = '${LLK}a1';
SELECT '$1_view_rollup_open_project:' || (count(*) > 0) FROM v_project_rollup WHERE project_id = '${LLK}a2';
SELECT '$1_view_samples:' || coalesce(string_agg(sample_code, ',' ORDER BY sample_code), '') FROM v_complete_sample_history WHERE sample_code LIKE 'FXRLS-%';
SELECT '$1_view_ops:' || count(*) FROM v_manufacturing_operations_full WHERE outcome_notes = 'fx';
SELECT '$1_view_tests:' || count(*) FROM v_test_sessions_full WHERE session_id IN ('${LLK}91', '${LLK}92');
SELECT '$1_view_genealogy:' || count(*) FROM v_sample_genealogy_flat WHERE child_sample_code LIKE 'FXRLS-%' OR parent_sample_code LIKE 'FXRLS-%';
SELECT '$1_view_stock:' || coalesce(string_agg(sample_code, ',' ORDER BY sample_code), '') FROM v_stock_provenance WHERE sample_code LIKE 'FXRLS-%';
VSQL
}
ll_fixture="
INSERT INTO directus_users (id) VALUES ('${LLK}01');
INSERT INTO directus_files (id) VALUES ('${LLK}f1'), ('${LLK}f2');
INSERT INTO projects (project_id, project_code, project_name, restricted) VALUES ('${LLK}a1', 'FXRLS-PR', 'x', true), ('${LLK}a2', 'FXRLS-PO', 'x', false);
INSERT INTO campaigns (campaign_id, project_id, campaign_type, name, restricted) VALUES
  ('${LLK}b1', '${LLK}a1', 'testing_campaign', 'FXRLS under the restricted project', false), ('${LLK}b2', '${LLK}a2', 'testing_campaign', 'FXRLS open', false);
INSERT INTO physical_samples (sample_id, sample_code, restricted) VALUES
  ('${LLK}c1', 'FXRLS-SR', true), ('${LLK}c2', 'FXRLS-SO', false), ('${LLK}c3', 'FXRLS-S2', false), ('${LLK}c4', 'FXRLS-SC', false);
INSERT INTO campaign_samples (campaign_id, sample_id) VALUES ('${LLK}b1', '${LLK}c4'), ('${LLK}b2', '${LLK}c2'), ('${LLK}b2', '${LLK}c1');
INSERT INTO sample_genealogy (child_sample_id, parent_sample_id) VALUES ('${LLK}c2', '${LLK}c3'), ('${LLK}c2', '${LLK}c1'), ('${LLK}c1', '${LLK}c3');
INSERT INTO raw_stock_lots (lot_id, lot_code, stock_type, inbound_mass_grams, remaining_mass_grams, notes) VALUES ('${LLK}d1', 'FXRLS-LOT', 'powder', 1, 1, 'lot note');
INSERT INTO sample_stock_provenance (sample_id, lot_id) VALUES ('${LLK}c1', '${LLK}d1'), ('${LLK}c2', '${LLK}d1');
INSERT INTO sample_co_owners (sample_id, user_id) VALUES ('${LLK}c1', '${LLK}01'), ('${LLK}c2', '${LLK}01');
INSERT INTO project_investigators (project_id, user_id) VALUES ('${LLK}a1', '${LLK}01'), ('${LLK}a2', '${LLK}01');
INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES ('${LLK}c1', '${LLK}f1'), ('${LLK}c2', '${LLK}f2');
INSERT INTO manufacturing_operations (operation_id, sample_id, method_id, project_id, campaign_id, restricted, outcome_notes) VALUES
  ('${LLK}e1', '${LLK}c1', (SELECT method_id FROM manufacturing_methods ORDER BY method_code LIMIT 1), '${LLK}a1', NULL, false, 'fx'),
  ('${LLK}e2', '${LLK}c2', (SELECT method_id FROM manufacturing_methods ORDER BY method_code LIMIT 1), '${LLK}a2', '${LLK}b2', false, 'fx'),
  ('${LLK}e3', '${LLK}c4', (SELECT method_id FROM manufacturing_methods ORDER BY method_code LIMIT 1), NULL, NULL, false, 'fx'),
  ('${LLK}e4', '${LLK}c2', (SELECT method_id FROM manufacturing_methods ORDER BY method_code LIMIT 1), NULL, '${LLK}b1', false, 'fx'),
  ('${LLK}e5', '${LLK}c2', (SELECT method_id FROM manufacturing_methods ORDER BY method_code LIMIT 1), NULL, NULL, true, 'fx');
INSERT INTO operation_data_files (operation_id, directus_files_id) VALUES ('${LLK}e1', '${LLK}f1'), ('${LLK}e2', '${LLK}f2');
INSERT INTO operation_files (operation_id, file_path) VALUES ('${LLK}e1', '/fx/1'), ('${LLK}e2', '/fx/2');
INSERT INTO prep_steps (operation_id) VALUES ('${LLK}e1'), ('${LLK}e2');
INSERT INTO machining_force_analysis (id, operation_id) VALUES ('${LLK}71', '${LLK}e1'), ('${LLK}72', '${LLK}e2');
INSERT INTO fast_run_data (operation_id) VALUES ('${LLK}e1'), ('${LLK}e2');
INSERT INTO diag_layer (analysis_id, name, role, geometry) VALUES ('${LLK}71', 'fx', 'mask', '{}'), ('${LLK}72', 'fx', 'mask', '{}');
INSERT INTO test_sessions (session_id, sample_id) VALUES ('${LLK}91', '${LLK}c1'), ('${LLK}92', '${LLK}c2');
INSERT INTO session_data_files (session_id, directus_files_id) VALUES ('${LLK}91', '${LLK}f1'), ('${LLK}92', '${LLK}f2');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item) VALUES ('${LLK}91', 'physical_samples', '${LLK}c1'), ('${LLK}92', 'physical_samples', '${LLK}c2');
INSERT INTO semantic_embeddings (source_table, source_id, source_column, content_text, content_hash, embedding, model_name)
  SELECT v.t, v.i::uuid, 'notes', 'fx', 'h', $LL_VEC, 'm' FROM (VALUES
    ('physical_samples', '${LLK}c1'), ('physical_samples', '${LLK}c2'), ('manufacturing_operations', '${LLK}e1'), ('manufacturing_operations', '${LLK}e2'),
    ('test_sessions', '${LLK}91'), ('test_sessions', '${LLK}92'), ('raw_stock_lots', '${LLK}d1'), ('campaigns', '${LLK}b2'),
    ('physical_samples', '${LLK}ff')) AS v (t, i);
SELECT 'fixture_drift:' || d1_private.readers_drift_count();
"
ll_out=$($PSQL -q -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$ll_fixture
$(ll_counts own)
SET LOCAL ROLE d1_llm_readonly;
$(ll_counts llm)
$(ll_views llm)
SELECT 'llm_all_views_readable:' || count(*) FROM (SELECT count(*) FROM v_complete_sample_history UNION ALL SELECT count(*) FROM v_llm_query_targets UNION ALL SELECT count(*) FROM v_manufacturing_operations_full UNION ALL SELECT count(*) FROM v_project_rollup UNION ALL SELECT count(*) FROM v_sample_genealogy_flat UNION ALL SELECT count(*) FROM v_schema_dictionary UNION ALL SELECT count(*) FROM v_stock_provenance UNION ALL SELECT count(*) FROM v_test_sessions_full UNION ALL SELECT count(*) FROM v_tooling_hierarchy) x;
SELECT 'llm_lot_visible:' || count(*) FROM raw_stock_lots WHERE lot_id = '${LLK}d1';
RESET ROLE;
SET LOCAL ROLE d1_llm_app;
$(ll_counts app)
RESET ROLE;
SELECT 'owner_rollup_hidden_project:' || (count(*) > 0) FROM project_rollup WHERE project_id = '${LLK}a1';
SELECT 'owner_view_ops:' || count(*) FROM v_manufacturing_operations_full WHERE outcome_notes = 'fx';
-- the usage grant is what makes the five record tables readable at all; the hidden set itself stays ungranted
SELECT 'grant_usage:' || has_schema_privilege('d1_llm_readonly', 'd1_private', 'USAGE');
SELECT 'grant_execute:' || has_function_privilege('d1_llm_readonly', 'd1_private.is_hidden(text, uuid)', 'EXECUTE');
SELECT 'grant_public_usage:' || has_schema_privilege('public', 'd1_private', 'USAGE');
SELECT 'ungranted_d1_private_tables:' || count(*) FROM pg_class c WHERE c.relnamespace = 'd1_private'::regnamespace AND c.relkind IN ('r', 'v', 'p') AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT');
-- completeness: every granted table has row security or is a named reference table; every granted view is security_invoker
SELECT 'unprotected_tables:' || coalesce(string_agg(c.relname, ',' ORDER BY c.relname), 'none') FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT') AND NOT c.relrowsecurity
   AND c.relname <> ALL (ARRAY['alloying_elements','cutting_inserts','diag_recipes','equipment','etchants','facilities','fast_recipes','filter_profiles','insert_edges','insert_types','manufacturers','manufacturing_methods','material_alloying_elements','material_iso_classifications','materials','prep_recipe_steps','prep_recipes','raw_stock_lots','tool_boxes','tool_setup','tools']);
SELECT 'reference_tables:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT') AND NOT c.relrowsecurity;
SELECT 'rls_tables:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT');
SELECT 'rls_tables_with_both_policies:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity
   AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'a1a_open' AND p.polpermissive AND p.polcmd = '*' AND p.polroles = ARRAY[0::oid]) = 1
   AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'a1a_llm_hide' AND NOT p.polpermissive AND p.polcmd = 'r' AND p.polroles = ARRAY['d1_llm_readonly'::regrole::oid]) = 1;
SELECT 'views_not_invoker:' || coalesce(string_agg(c.relname, ',' ORDER BY c.relname), 'none') FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT') AND NOT coalesce('security_invoker=true' = ANY (c.reloptions), false);
SELECT 'granted_views:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT');
-- semantic_embeddings: every source the embedder backfills (v_embeddings_source_notes) is named in the policy; anything else is denied
SELECT 'embedding_sources_not_in_policy:' || coalesce(string_agg(s.t, ',' ORDER BY s.t), 'none')
  FROM (SELECT DISTINCT (regexp_matches(pg_get_viewdef('v_embeddings_source_notes'::regclass), '''(\w+)''::text AS source_table', 'g'))[1] AS t) s
 WHERE position('''' || s.t || '''' IN (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = 'semantic_embeddings'::regclass AND p.polname = 'a1a_llm_hide')) = 0;
SELECT 'embedding_sources:' || count(DISTINCT t) FROM (SELECT (regexp_matches(pg_get_viewdef('v_embeddings_source_notes'::regclass), '''(\w+)''::text AS source_table', 'g'))[1] AS t) x;
-- d1_embedder: SELECT, INSERT and UPDATE by hand-made grants; the backfill's INSERT ... ON CONFLICT DO UPDATE must keep working
CREATE ROLE p1_embedder NOLOGIN;
GRANT USAGE ON SCHEMA public TO p1_embedder;
GRANT SELECT, INSERT, UPDATE ON semantic_embeddings TO p1_embedder;
SET LOCAL ROLE p1_embedder;
SELECT 'embedder_sees_all:' || count(*) FROM semantic_embeddings;
INSERT INTO semantic_embeddings (source_table, source_id, source_column, content_text, content_hash, embedding, model_name)
  VALUES ('physical_samples', '${LLK}c1', 'notes_new', 'fresh', 'h1', $LL_VEC, 'm');
INSERT INTO semantic_embeddings (source_table, source_id, source_column, content_text, content_hash, embedding, model_name)
  VALUES ('physical_samples', '${LLK}c1', 'notes_new', 'changed', 'h2', $LL_VEC, 'm')
  ON CONFLICT (source_table, source_id, source_column, model_name) DO UPDATE SET content_text = EXCLUDED.content_text, content_hash = EXCLUDED.content_hash, updated_at = now();
SELECT 'embedder_upsert:' || content_text || '/' || content_hash FROM semantic_embeddings WHERE source_id = '${LLK}c1' AND source_column = 'notes_new';
UPDATE semantic_embeddings SET content_hash = 'h3' WHERE source_id = '${LLK}c1' AND source_column = 'notes_new';
SELECT 'embedder_update:' || content_hash FROM semantic_embeddings WHERE source_id = '${LLK}c1' AND source_column = 'notes_new';
RESET ROLE;
ROLLBACK;
SQL
)
if grep -q "^ERROR" <<<"$ll_out"; then bad "the Ask-DB row security fixture ran into an error: $(grep -m3 -A2 '^ERROR' <<<"$ll_out" | cut -c1-400)"; fi
expect_fixed ll_out "fixture_drift:0" "168: the fixture leaves readers_drift() empty (hidden_records is in step)"
# table: rows the owner sees (all the fixture's rows) : rows the Ask-DB role sees
LL_EXPECT="physical_samples:4:2 manufacturing_operations:5:1 test_sessions:2:1 campaigns:2:1 projects:2:1 campaign_samples:3:1 sample_genealogy:3:1 sample_stock_provenance:2:1 sample_co_owners:2:1 sample_data_files:2:1 operation_data_files:2:1 operation_files:2:1 prep_steps:2:1 machining_force_analysis:2:1 fast_run_data:2:1 diag_layer:2:1 session_data_files:2:1 test_sessions_subject:2:1 project_investigators:2:1 semantic_embeddings:9:4"
for e in $LL_EXPECT; do
    IFS=: read -r t n_own n_llm <<<"$e"
    expect_fixed ll_out "own:$t:$n_own" "168: the owner role (d1) sees every $t row ($n_own: row security does not apply to the owner)"
    expect_fixed ll_out "llm:$t:$n_llm" "168: d1_llm_readonly sees $n_llm of the $n_own $t rows (no restricted tree)"
    expect_fixed ll_out "app:$t:$n_llm" "168: d1_llm_app (the plugin's member login) is covered by the same policies on $t"
done
expect_fixed ll_out "llm_rollup_hidden_project:0" "168: project_rollup rows of the restricted project are hidden from the role"
expect_fixed ll_out "llm_rollup_open_project:true" "168: project_rollup rows of the open project are readable"
expect_fixed ll_out "owner_rollup_hidden_project:true" "168: the owner still sees the restricted project's rollup rows"
expect_fixed ll_out "llm_view_rollup_hidden_project:0" "168: v_project_rollup (security_invoker, reads the hidden set through is_hidden) hides the restricted project"
expect_fixed ll_out "llm_view_rollup_open_project:true" "168: v_project_rollup still lists the open project"
expect_fixed ll_out "llm_view_samples:FXRLS-S2,FXRLS-SO" "168: v_complete_sample_history lists only the unrestricted samples (no restricted sample, none under the restricted project)"
expect_fixed ll_out "llm_view_ops:1" "168: v_manufacturing_operations_full lists only the open operation"
expect_fixed ll_out "owner_view_ops:5" "168: the owner sees all five operations through the view"
expect_fixed ll_out "llm_view_tests:1" "168: v_test_sessions_full lists only the open test"
expect_fixed ll_out "llm_view_genealogy:1" "168: v_sample_genealogy_flat lists only the edge between two visible samples"
expect_fixed ll_out "llm_view_stock:FXRLS-SO" "168: v_stock_provenance lists only the visible sample"
expect_fixed ll_out "llm_all_views_readable:9" "168: all nine granted views still answer for the role (usage and execute grants are in place)"
expect_fixed ll_out "llm_lot_visible:1" "168: reference tables stay readable (a stock lot)"
expect_fixed ll_out "grant_usage:true" "168: the role has USAGE on d1_private (a policy runs with the querying role's privileges)"
expect_fixed ll_out "grant_execute:true" "168: the role may EXECUTE d1_private.is_hidden"
expect_fixed ll_out "grant_public_usage:false" "168: PUBLIC still has no USAGE on d1_private"
expect_fixed ll_out "ungranted_d1_private_tables:0" "168: no d1_private table is readable by the role (hidden_records and the backups stay ungranted)"
expect_fixed ll_out "unprotected_tables:none" "168: every table granted to d1_llm_readonly has row security on or is a named reference table"
expect_fixed ll_out "reference_tables:21" "168: the reference list is current (21 granted tables without row security, all named)"
expect_fixed ll_out "rls_tables:21" "168: 21 granted tables have row security on, none is FORCEd"
expect_fixed ll_out "rls_tables_with_both_policies:21" "168: each has the permissive FOR ALL TO PUBLIC policy and the restrictive FOR SELECT TO d1_llm_readonly one"
expect_fixed ll_out "views_not_invoker:none" "168: every view granted to d1_llm_readonly is security_invoker (a CREATE OR REPLACE VIEW without WITH (security_invoker = true) fails here)"
expect_fixed ll_out "granted_views:9" "168: nine views are granted to the role"
expect_fixed ll_out "embedding_sources_not_in_policy:none" "168: every source v_embeddings_source_notes embeds is named in the semantic_embeddings policy"
expect_fixed ll_out "embedding_sources:4" "168: the embedder backfills four sources today (samples, operations, tests, stock lots), all named in the policy"
expect_fixed ll_out "embedder_sees_all:9" "168: a d1_embedder-like role (SELECT, INSERT, UPDATE grants) still sees every embedding row"
expect_fixed ll_out "embedder_upsert:changed/h2" "168: the embedder's INSERT ... ON CONFLICT DO UPDATE still works"
expect_fixed ll_out "embedder_update:h3" "168: the embedder's UPDATE still works"

# a flip of restricted, a move into a restricted campaign and an unrestricting change what the role sees at once
ll_flip=$($PSQL -q -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$ll_fixture
SET LOCAL ROLE d1_llm_readonly;
SELECT 'flip0_samples:' || count(*) FROM physical_samples WHERE sample_code LIKE 'FXRLS-%';
SELECT 'flip0_ops:' || count(*) FROM manufacturing_operations;
RESET ROLE;
UPDATE physical_samples SET restricted = true WHERE sample_id = '${LLK}c2';
SET LOCAL ROLE d1_llm_readonly;
SELECT 'flip1_samples:' || count(*) FROM physical_samples WHERE sample_code LIKE 'FXRLS-%';
SELECT 'flip1_ops:' || count(*) FROM manufacturing_operations;
SELECT 'flip1_embeddings:' || count(*) FROM semantic_embeddings;
RESET ROLE;
UPDATE physical_samples SET restricted = false WHERE sample_id = '${LLK}c2';
SET LOCAL ROLE d1_llm_readonly;
SELECT 'flip2_samples:' || count(*) FROM physical_samples WHERE sample_code LIKE 'FXRLS-%';
RESET ROLE;
INSERT INTO campaign_samples (campaign_id, sample_id) VALUES ('${LLK}b1', '${LLK}c3');
SET LOCAL ROLE d1_llm_readonly;
SELECT 'move_in_samples:' || count(*) FROM physical_samples WHERE sample_code LIKE 'FXRLS-%';
SELECT 'move_in_genealogy:' || count(*) FROM sample_genealogy WHERE child_sample_id::text LIKE 'e1680000%' OR parent_sample_id::text LIKE 'e1680000%';
RESET ROLE;
DELETE FROM campaign_samples WHERE campaign_id = '${LLK}b1' AND sample_id = '${LLK}c3';
SET LOCAL ROLE d1_llm_readonly;
SELECT 'move_out_samples:' || count(*) FROM physical_samples WHERE sample_code LIKE 'FXRLS-%';
RESET ROLE;
UPDATE projects SET restricted = false WHERE project_id = '${LLK}a1';
SET LOCAL ROLE d1_llm_readonly;
SELECT 'unrestrict_project_projects:' || count(*) FROM projects;
SELECT 'unrestrict_project_campaigns:' || count(*) FROM campaigns;
SELECT 'unrestrict_project_rollup:' || (count(*) > 0) FROM project_rollup WHERE project_id = '${LLK}a1';
RESET ROLE;
UPDATE projects SET restricted = true WHERE project_id = '${LLK}a2';
SET LOCAL ROLE d1_llm_readonly;
SELECT 'restrict_open_project_ops:' || count(*) FROM manufacturing_operations;
SELECT 'restrict_open_project_rollup:' || count(*) FROM project_rollup WHERE project_id = '${LLK}a2';
RESET ROLE;
ROLLBACK;
SQL
)
expect_fixed ll_flip "flip0_samples:2" "168: before the flips the role sees the two open samples"
expect_fixed ll_flip "flip1_samples:1" "168: restricting an open sample hides it from the role in the same transaction"
expect_fixed ll_flip "flip1_ops:0" "168: and its operation"
expect_fixed ll_flip "flip1_embeddings:1" "168: and its embeddings, its operation's and its test's (only the stock lot's note stays)"
expect_fixed ll_flip "flip2_samples:2" "168: unrestricting it brings it back"
expect_fixed ll_flip "move_in_samples:1" "168: a sample added to a campaign of a restricted project is hidden at once"
expect_fixed ll_flip "move_in_genealogy:0" "168: and so is every genealogy edge to it"
expect_fixed ll_flip "move_out_samples:2" "168: removing it brings it back"
expect_fixed ll_flip "unrestrict_project_projects:2" "168: unrestricting the project shows it"
expect_fixed ll_flip "unrestrict_project_campaigns:2" "168: and its campaign"
expect_fixed ll_flip "unrestrict_project_rollup:true" "168: and its rollup rows"
expect_fixed ll_flip "restrict_open_project_ops:1" "168: restricting the open project hides the operation in it and the one on a sample of its campaign (one open operation is left)"
expect_fixed ll_flip "restrict_open_project_rollup:0" "168: and its rollup rows"

# apply, reapply, reverse: down turns row security, the view option and the grants off; up (twice) puts them back
ll_cycle=$($PSQL -q -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$ll_fixture
$ll_down
SELECT 'dn_rls:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity;
SELECT 'dn_policies:' || count(*) FROM pg_policy WHERE polname IN ('a1a_open', 'a1a_llm_hide');
SELECT 'dn_invoker_views:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND 'security_invoker=true' = ANY (coalesce(c.reloptions, ARRAY[]::text[])) AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT');
SELECT 'dn_usage:' || has_schema_privilege('d1_llm_readonly', 'd1_private', 'USAGE');
SELECT 'dn_execute:' || has_function_privilege('d1_llm_readonly', 'd1_private.is_hidden(text, uuid)', 'EXECUTE');
SELECT 'dn_grants_kept:' || has_table_privilege('d1_llm_readonly', 'physical_samples', 'SELECT') || '/' || has_table_privilege('d1_llm_readonly', 'v_project_rollup', 'SELECT');
$ll_up
$ll_up
SELECT 'up2_rls:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity;
SELECT 'up2_policies:' || count(*) FROM pg_policy WHERE polname IN ('a1a_open', 'a1a_llm_hide');
SELECT 'up2_invoker_views:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND 'security_invoker=true' = ANY (coalesce(c.reloptions, ARRAY[]::text[])) AND has_table_privilege('d1_llm_readonly', c.oid, 'SELECT');
SET LOCAL ROLE d1_llm_readonly;
SELECT 'up2_samples:' || count(*) FROM physical_samples WHERE sample_code LIKE 'FXRLS-%';
SELECT 'up2_embeddings:' || count(*) FROM semantic_embeddings;
RESET ROLE;
ROLLBACK;
SQL
)
expect_fixed ll_cycle "dn_rls:0" "168 down: row security is off on every table"
expect_fixed ll_cycle "dn_policies:0" "168 down: both policies are gone everywhere"
expect_fixed ll_cycle "dn_invoker_views:0" "168 down: the views are not security_invoker any more"
expect_fixed ll_cycle "dn_usage:false" "168 down: the USAGE grant is revoked"
expect_fixed ll_cycle "dn_execute:false" "168 down: the EXECUTE grant is revoked"
expect_fixed ll_cycle "dn_grants_kept:true/true" "168 down: the table and view grants of migration 132 are untouched"
expect_fixed ll_cycle "up2_rls:21" "168 up, twice: row security is on for the 21 record-bound tables"
expect_fixed ll_cycle "up2_policies:42" "168 up, twice: 42 policies, no duplicates"
expect_fixed ll_cycle "up2_invoker_views:9" "168 up, twice: the nine views are security_invoker again"
expect_fixed ll_cycle "up2_samples:2" "168 up, twice: the role sees the same rows as before"
expect_fixed ll_cycle "up2_embeddings:4" "168 up, twice: and the same embeddings"

# a database without the role (a copy restored from a dump without the cluster's roles: the Directus smoke harness) applies 168 with a notice
ll_norole=$($PSQL -q -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
$ll_down
ALTER ROLE d1_llm_readonly RENAME TO d1_llm_readonly_renamed_by_test;
$ll_up
SELECT 'norole_policies:' || count(*) FROM pg_policy WHERE polname IN ('a1a_open', 'a1a_llm_hide');
SELECT 'norole_rls:' || count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relrowsecurity;
ROLLBACK;
SQL
)
expect_fixed ll_norole "norole_policies:0" "168 on a database without d1_llm_readonly: applies with a notice and creates no policy"
expect_fixed ll_norole "norole_rls:0" "168 on a database without d1_llm_readonly: enables no row security"
