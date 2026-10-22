# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Migration 204: bulk actions journal (up, constraints, cascade, ungranted, down) =="
BA_MIG=$(migration bulk_actions)
if [[ -f "$BA_MIG" ]]; then
ba_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$BA_MIG")
ba_down=$(awk '/-- migrate:down/{f=1;next}f' "$BA_MIG")
# The migration is applied by the CI run already; the down then up inside a rolled-back transaction proves both and leaves the database as it was.
ba_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
$ba_down
SELECT 'ba_dn_tables:' || coalesce(to_regclass('bulk_actions')::text, 'gone') || ',' || coalesce(to_regclass('bulk_action_rows')::text, 'gone');
$ba_up
SELECT 'ba_up_tables:' || (to_regclass('bulk_actions') IS NOT NULL) || ',' || (to_regclass('bulk_action_rows') IS NOT NULL);
SELECT 'ba_uncommented:' || (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('bulk_actions', 'bulk_action_rows')
    AND col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) IS NULL);
SELECT 'ba_table_comments:' || (SELECT count(*) FROM pg_description d JOIN pg_class k ON k.oid = d.objoid WHERE d.objsubid = 0 AND k.relname IN ('bulk_actions', 'bulk_action_rows'));
SELECT 'ba_llm_granted:' || (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = 'd1_llm_readonly' AND table_name IN ('bulk_actions', 'bulk_action_rows'));
INSERT INTO bulk_actions (action_id, actor_user, collection, kind, params, undo_until)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 'physical_samples', 'edit_field', '{"field":"mounted","value":true}', now() + interval '60 seconds');
SELECT 'ba_defaults:' || state || ',' || mail_state FROM bulk_actions WHERE action_id = 'aaaaaaaa-0000-4000-8000-000000000001';
INSERT INTO bulk_action_rows (action_id, record_id, outcome, before, after)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'r1', 'applied', '{"mounted":null}', '{"mounted":true}');
INSERT INTO bulk_actions (actor_user, collection, kind, params, undo_until, revert_of)
    VALUES (gen_random_uuid(), 'physical_samples', 'edit_field', '{}', now(), 'aaaaaaaa-0000-4000-8000-000000000001');
DO \$\$ BEGIN INSERT INTO bulk_actions (actor_user, collection, kind, params, undo_until) VALUES (gen_random_uuid(), 'campaigns', 'delete_all', '{}', now());
    RAISE NOTICE 'ba_kind_check:accepted'; EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ba_kind_check:refused'; END \$\$;
DO \$\$ BEGIN INSERT INTO bulk_action_rows (action_id, record_id, outcome) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'r2', 'exploded');
    RAISE NOTICE 'ba_outcome_check:accepted'; EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ba_outcome_check:refused'; END \$\$;
DO \$\$ BEGIN INSERT INTO bulk_action_rows (action_id, record_id, outcome) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'r1', 'applied');
    RAISE NOTICE 'ba_pk:accepted'; EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ba_pk:refused'; END \$\$;
DO \$\$ BEGIN INSERT INTO bulk_action_rows (action_id, record_id, outcome) VALUES ('aaaaaaaa-0000-4000-8000-000000000002', 'r1', 'applied');
    RAISE NOTICE 'ba_fk:accepted'; EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ba_fk:refused'; END \$\$;
DELETE FROM bulk_actions WHERE revert_of IS NOT NULL;
DELETE FROM bulk_actions WHERE action_id = 'aaaaaaaa-0000-4000-8000-000000000001';
SELECT 'ba_cascade:' || (SELECT count(*) FROM bulk_action_rows);
$ba_down
SELECT 'ba_redown_tables:' || coalesce(to_regclass('bulk_actions')::text, 'gone') || ',' || coalesce(to_regclass('bulk_action_rows')::text, 'gone');
ROLLBACK;
SQL
)
expect_match ba_out "^ba_dn_tables:gone,gone$" "down: both tables are dropped"
expect_match ba_out "^ba_up_tables:true,true$" "up after down: both tables are back"
expect_match ba_out "^ba_uncommented:0$" "every column of both tables has a COMMENT"
expect_match ba_out "^ba_table_comments:2$" "both tables have a COMMENT"
expect_match ba_out "^ba_llm_granted:0$" "the Ask-the-database role has no grant on the journal (it holds record data)"
expect_match ba_out "^ba_defaults:applied,pending$" "a new action starts applied, with its summary email pending"
expect_match ba_out "ba_kind_check:refused" "an unknown kind is refused by the CHECK"
expect_match ba_out "ba_outcome_check:refused" "an unknown row outcome is refused by the CHECK"
expect_match ba_out "ba_pk:refused" "a record appears once per action (primary key)"
expect_match ba_out "ba_fk:refused" "a journal row needs its action"
expect_match ba_out "^ba_cascade:0$" "deleting an action deletes its rows"
expect_match ba_out "^ba_redown_tables:gone,gone$" "down runs again after up"
else
bad "the bulk actions migration is missing ($BA_MIG)"
fi
