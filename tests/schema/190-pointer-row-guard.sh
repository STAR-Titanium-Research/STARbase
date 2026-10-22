# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Migration 206: pointer-row write guard on directus_files (ADR-0023, forged pointer rows) =="
PG_MIG=$(migration pointer_row_write_guard)
if [[ -f "$PG_MIG" ]]; then
pg_up=$(migration_up "$PG_MIG")
pg_down=$(migration_down "$PG_MIG")
# down then up inside a rolled-back transaction: proves both and leaves the database as it was. set_config(..., true) is the transaction-local form of what the
# indexer and the crawler set for the whole session.
pg_out=$($PSQL -q 2>&1 <<SQL
BEGIN;
$pg_down
SELECT 'pg_dn_trigger:' || (SELECT count(*) FROM pg_trigger WHERE tgname = 'directus_files_pointer_row_guard' AND NOT tgisinternal);
SELECT 'pg_dn_function:' || (to_regprocedure('d1_private.trg_pointer_row_write_guard()') IS NOT NULL);
INSERT INTO directus_files (id, storage, metadata) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'star', '{"archive_path":"Users/x/a.al3d"}');
SELECT 'pg_dn_forged_insert:accepted';
DELETE FROM directus_files WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
$pg_up
SELECT 'pg_up_trigger:' || (SELECT count(*) FROM pg_trigger WHERE tgname = 'directus_files_pointer_row_guard' AND NOT tgisinternal);
SELECT 'pg_comments:' || (SELECT count(*) FROM pg_description d WHERE d.objoid IN (to_regprocedure('d1_private.trg_pointer_row_write_guard()')::oid, (SELECT oid FROM pg_trigger WHERE tgname = 'directus_files_pointer_row_guard' AND NOT tgisinternal)));
-- a Directus write: the setting is not on
SELECT set_config('d1.archive_writer', '', true);
DO \$\$ BEGIN INSERT INTO directus_files (id, storage, metadata) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'star', '{"archive_path":"Users/x/a.al3d"}');
    RAISE NOTICE 'pg_forged_insert:accepted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'pg_forged_insert:refused'; END \$\$;
INSERT INTO directus_files (id, storage) VALUES ('bbbbbbbb-0000-4000-8000-000000000002', 'local');
SELECT 'pg_local_insert:accepted';
DO \$\$ BEGIN UPDATE directus_files SET storage = 'star', metadata = '{"archive_path":"Users/x/a.al3d"}' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
    RAISE NOTICE 'pg_local_to_star:accepted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'pg_local_to_star:refused'; END \$\$;
-- an archive writer
SELECT set_config('d1.archive_writer', 'on', true);
INSERT INTO directus_files (id, storage, metadata) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'star', '{"archive_path":"Users/x/a.al3d"}');
SELECT 'pg_writer_insert:accepted';
-- back to a Directus write: the pointer cannot move, everything else can change
SELECT set_config('d1.archive_writer', '', true);
DO \$\$ BEGIN UPDATE directus_files SET metadata = '{"archive_path":"Users/y/b.al3d"}' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
    RAISE NOTICE 'pg_repoint:accepted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'pg_repoint:refused'; END \$\$;
DO \$\$ BEGIN UPDATE directus_files SET id = 'bbbbbbbb-0000-4000-8000-000000000003' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
    RAISE NOTICE 'pg_reid:accepted'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'pg_reid:refused'; END \$\$;
UPDATE directus_files SET type = 'image/x', metadata = '{"archive_path":"Users/x/a.al3d","note":"n"}' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
SELECT 'pg_other_edit:' || (metadata::jsonb ->> 'note') FROM directus_files WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
DELETE FROM directus_files WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
SELECT 'pg_delete:' || (SELECT count(*) FROM directus_files WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001');
$pg_down
SELECT 'pg_redown_trigger:' || (SELECT count(*) FROM pg_trigger WHERE tgname = 'directus_files_pointer_row_guard' AND NOT tgisinternal);
ROLLBACK;
SQL
)
expect_match pg_out "^pg_dn_trigger:0$" "down: the trigger is dropped"
expect_match pg_out "^pg_dn_function:false$" "down: the function is dropped"
expect_match pg_out "pg_dn_forged_insert:accepted" "down: the old behaviour is back (a star row can be inserted by anyone)"
expect_match pg_out "^pg_up_trigger:1$" "up after down: the trigger is back"
expect_match pg_out "^pg_comments:2$" "the function and the trigger have a COMMENT"
expect_match pg_out "pg_forged_insert:refused" "a Directus write cannot create a storage 'star' row (the forged pointer row)"
expect_match pg_out "^pg_local_insert:accepted$" "a Directus write can still create a row of another storage"
expect_match pg_out "pg_local_to_star:refused" "a Directus write cannot turn a row into a pointer row"
expect_match pg_out "^pg_writer_insert:accepted$" "an archive writer (d1.archive_writer = 'on') can create a pointer row"
expect_match pg_out "pg_repoint:refused" "a Directus write cannot change a pointer row's archive_path"
expect_match pg_out "pg_reid:refused" "a Directus write cannot change a pointer row's id"
expect_match pg_out "^pg_other_edit:n$" "a Directus write can still edit the rest of a pointer row (type, other metadata keys)"
expect_match pg_out "^pg_delete:0$" "a pointer row can be deleted"
expect_match pg_out "^pg_redown_trigger:0$" "down runs again after up"
else
bad "the pointer-row write guard migration is missing (db/migrations/*_pointer_row_write_guard.sql)"
fi
