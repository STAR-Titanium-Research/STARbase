# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== File fingerprints table (T0e) =="
# Each check is its own rolled-back transaction (prefix 9d000000-0000-4000-8000-). A rejected statement
# aborts psql (ON_ERROR_STOP), so the error text is what is asserted on. The CI database has the stub
# directus_files (id only, migration 030), so the fixture row sets just the id.
FF_MIG=$(migration file_fingerprints)
[[ -f "$FF_MIG" ]] && ok "found migration 159" || bad "migration 159 is missing ($FF_MIG)"
FF_F='9d000000-0000-4000-8000-000000000001'
FF_H64=$(printf 'a%.0s' $(seq 1 64))
FF_H63=$(printf 'a%.0s' $(seq 1 63))
FF_HUP=$(printf 'A%.0s' $(seq 1 64))
ff_sql() { # ff_sql <statements>: run them after a fixture directus_files row, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_files (id) VALUES ('$FF_F');
$1
ROLLBACK;
SQL
}
run_eq "file_fingerprints exists" "SELECT to_regclass('public.file_fingerprints')::TEXT" "file_fingerprints"
run_eq "file_fingerprints has both indexes" \
    "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'file_fingerprints' AND indexname IN ('file_fingerprints_content_idx', 'file_fingerprints_data_idx')" \
    "file_fingerprints_content_idx,file_fingerprints_data_idx"
run_eq "file_fingerprints_data_idx is partial (data_sha256 IS NOT NULL)" \
    "SELECT count(*) FROM pg_indexes WHERE indexname = 'file_fingerprints_data_idx' AND indexdef LIKE '%WHERE (data_sha256 IS NOT NULL)%'" "1"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_sha256, data_variable, data_rows, data_cols, size_bytes, source_mtime)
    VALUES ('$FF_F', '$FF_H64', '$FF_H64', 'DATA', 10, 3, 1234, now());
SELECT 'ff_row:' || status || ':' || data_variable || ':' || data_rows || 'x' || data_cols FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_row:done:DATA:10x3' <<<"$ff_out" && ok "a done fingerprint for a file inserts (status defaults to done)" || bad "done fingerprint insert failed (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256) VALUES ('$FF_F', '$FF_H63');")
grep -q 'check constraint' <<<"$ff_out" && ok "a 63-character content_sha256 is rejected (check_violation)" || bad "63-character content_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256) VALUES ('$FF_F', '$FF_HUP');")
grep -q 'check constraint' <<<"$ff_out" && ok "an upper-case content_sha256 is rejected (check_violation)" || bad "upper-case content_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_sha256) VALUES ('$FF_F', '$FF_H64', '$FF_H63');")
grep -q 'check constraint' <<<"$ff_out" && ok "a 63-character data_sha256 is rejected (check_violation)" || bad "63-character data_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_variable) VALUES ('$FF_F', '$FF_H64', 'Data');")
grep -q 'check constraint' <<<"$ff_out" && ok "a data_variable other than data / DATA is rejected" || bad "bad data_variable was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256, data_rows) VALUES ('$FF_F', '$FF_H64', -1);")
grep -q 'check constraint' <<<"$ff_out" && ok "a negative data_rows is rejected" || bad "negative data_rows was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status, content_sha256) VALUES ('$FF_F', 'weird', '$FF_H64');")
grep -q 'check constraint' <<<"$ff_out" && ok "an unknown status is rejected" || bad "unknown status was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status) VALUES ('$FF_F', 'done');")
grep -q 'file_fingerprints_done_has_hash' <<<"$ff_out" && ok "status done with a NULL content_sha256 is rejected" || bad "done without content_sha256 was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status) VALUES ('9d000000-0000-4000-8000-000000000002', 'missing');")
grep -q 'foreign key' <<<"$ff_out" && ok "a fingerprint for a file that does not exist is rejected (foreign key)" || bad "fingerprint without a file was not rejected (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status, error_message) VALUES ('$FF_F', 'missing', 'not on the share');
SELECT 'ff_missing:' || status || ':' || coalesce(content_sha256, '<null>') || ':' || coalesce(data_sha256, '<null>') FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_missing:missing:<null>:<null>' <<<"$ff_out" && ok "status missing with NULL hashes is accepted" || bad "missing fingerprint with NULL hashes failed (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, status, error_message) VALUES ('$FF_F', 'error', 'unreadable');
SELECT 'ff_error:' || status FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_error:error' <<<"$ff_out" && ok "status error with NULL hashes is accepted" || bad "error fingerprint with NULL hashes failed (output: $ff_out)"
ff_out=$(ff_sql "INSERT INTO file_fingerprints (directus_files_id, content_sha256) VALUES ('$FF_F', '$FF_H64');
DELETE FROM directus_files WHERE id = '$FF_F';
SELECT 'ff_cascade:' || count(*) FROM file_fingerprints WHERE directus_files_id = '$FF_F';")
grep -q 'ff_cascade:0' <<<"$ff_out" && ok "deleting the directus_files row removes its fingerprint" || bad "fingerprint survived its file's deletion (output: $ff_out)"
run_eq "file_fingerprints has a table comment" "SELECT count(*) FROM pg_description WHERE objoid = 'public.file_fingerprints'::regclass AND objsubid = 0 AND description <> ''" "1"
run_eq "every file_fingerprints column has a comment (without: none)" \
    "SELECT coalesce(string_agg(a.attname, ', '), '') FROM pg_attribute a WHERE a.attrelid = 'public.file_fingerprints'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND coalesce(col_description(a.attrelid, a.attnum), '') = ''" ""
run_eq "both file_fingerprints indexes have a comment" \
    "SELECT count(*) FROM pg_class c WHERE c.relname IN ('file_fingerprints_content_idx', 'file_fingerprints_data_idx') AND coalesce(obj_description(c.oid, 'pg_class'), '') <> ''" "2"
run_eq "data_sha256's comment says how the hash is taken (uint64 shape, float64, per-column digests, DATA)" \
    "SELECT count(*) FROM pg_description WHERE objoid = 'public.file_fingerprints'::regclass AND objsubid = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.file_fingerprints'::regclass AND attname = 'data_sha256') AND description ~* 'uint64' AND description ~* 'float64' AND description ~* 'each column' AND description ~ 'otherwise DATA'" "1"

echo "== Per-user usage scores (migration 163) =="
# Each check is its own rolled-back transaction (users prefix 9e000000-0000-4000-8000-). A rejected
# statement aborts psql (ON_ERROR_STOP), so the error text is what is asserted on. The CI database
# has the stub directus_users (id only matters), so the fixture users set just the id.
UU_MIG=$(migration user_usage)
[[ -f "$UU_MIG" ]] && ok "found migration 163" || bad "migration 163 is missing ($UU_MIG)"
UU_A='9e000000-0000-4000-8000-000000000001'
UU_B='9e000000-0000-4000-8000-000000000002'
uu_sql() { # uu_sql <statements>: run them after two fixture users, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$UU_A'), ('$UU_B');
$1
ROLLBACK;
SQL
}
run_eq "user_usage and user_usage_cursor are in d1_private" \
    "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relname IN ('user_usage', 'user_usage_cursor')" \
    "user_usage,user_usage_cursor"
run_eq "neither table is in public (Directus would list it as a collection)" \
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('user_usage', 'user_usage_cursor')" "0"
run_eq "the (user_id, kind) index exists" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname = 'd1_private' AND indexname = 'user_usage_user_kind_idx' AND indexdef LIKE '%(user_id, kind)%'" "1"
run_eq "the tables are not in v_schema_dictionary (the Ask-DB prompt)" \
    "SELECT count(*) FROM v_schema_dictionary WHERE object_name IN ('user_usage', 'user_usage_cursor')" "0"
run_eq "d1_llm_readonly cannot read the usage tables" \
    "SELECT has_table_privilege('d1_llm_readonly', 'd1_private.user_usage', 'SELECT') OR has_table_privilege('d1_llm_readonly', 'd1_private.user_usage_cursor', 'SELECT')" "f"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target, score) VALUES ('$UU_A', 'page', 'samples', 1.5);
SELECT 'uu_row:' || score || ':' || pinned || ':' || coalesce(hidden_at::text, '<null>') FROM d1_private.user_usage WHERE user_id = '$UU_A';")
grep -q 'uu_row:1.5:false:<null>' <<<"$uu_out" && ok "a usage row inserts with pinned false and not hidden by default" || bad "usage row insert failed (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'other', 'samples');")
grep -q 'check constraint' <<<"$uu_out" && ok "a kind other than page / record is rejected" || bad "bad kind was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples');
INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples');")
grep -q 'duplicate key' <<<"$uu_out" && ok "one row per user, kind and target (primary key)" || bad "duplicate usage row was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples'), ('$UU_B', 'page', 'samples'), ('$UU_A', 'record', 'samples');
SELECT 'uu_same_target:' || count(*) FROM d1_private.user_usage;")
grep -q 'uu_same_target:3' <<<"$uu_out" && ok "two users (and two kinds) can hold the same target" || bad "same target for another user or kind failed (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('9e000000-0000-4000-8000-0000000000ff', 'page', 'samples');")
grep -q 'foreign key' <<<"$uu_out" && ok "usage for a user that does not exist is rejected (foreign key)" || bad "usage without a user was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples'), ('$UU_B', 'page', 'samples');
INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES ('$UU_A', 7), ('$UU_B', 9);
DELETE FROM directus_users WHERE id = '$UU_A';
SELECT 'uu_cascade:' || (SELECT count(*) FROM d1_private.user_usage) || ',' || (SELECT count(*) FROM d1_private.user_usage_cursor);")
grep -q 'uu_cascade:1,1' <<<"$uu_out" && ok "deleting a user removes their usage rows and cursor, and only theirs" || bad "usage rows did not follow their user (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES ('$UU_A', 1), ('$UU_A', 2);")
grep -q 'duplicate key' <<<"$uu_out" && ok "one cursor per user" || bad "second cursor for a user was not rejected (output: $uu_out)"
run_eq "both tables and their columns and the index have comments (without: none)" \
    "SELECT coalesce(string_agg(x, ', '), '') FROM (
        SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname IN ('user_usage', 'user_usage_cursor', 'user_usage_user_kind_idx')
           AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname IN ('user_usage', 'user_usage_cursor') AND a.attnum > 0 AND NOT a.attisdropped
           AND coalesce(col_description(a.attrelid, a.attnum), '') = '') q" ""
# The d1-usage endpoint's own statements, run against Postgres. The strings below are the SQL constants of
# core/extensions/d1-usage/index.js (`SQL`), with `?` placeholders as the endpoint sends them; a node test in
# that extension fails if this file and index.js drift apart. Each is PREPAREd with ? turned into $1, $2, ...
# directus_activity is Directus-managed (stub or absent in CI), so a TEMP table of the same name and shape
# (from db/schema.sql) shadows it inside each rolled-back transaction.
UU_SQL_LOCK="SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))"
UU_SQL_GETROW="SELECT score, last_at, pinned, hidden_at FROM d1_private.user_usage WHERE user_id = ? AND kind = ? AND target = ?"
UU_SQL_UPSERT="INSERT INTO d1_private.user_usage (user_id, kind, target, score, last_at, pinned, hidden_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, kind, target) DO UPDATE SET score = EXCLUDED.score, last_at = EXCLUDED.last_at, pinned = EXCLUDED.pinned, hidden_at = EXCLUDED.hidden_at"
UU_SQL_LIST="SELECT kind, target, score, last_at, pinned FROM d1_private.user_usage WHERE user_id = ? AND kind <> 'view' AND pinned = false AND (hidden_at IS NULL OR last_at > hidden_at)"
UU_SQL_GETCURSOR="SELECT last_activity_id FROM d1_private.user_usage_cursor WHERE user_id = ?"
UU_SQL_SETCURSOR="INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET last_activity_id = EXCLUDED.last_activity_id"
UU_SQL_STARTID="SELECT id FROM directus_activity WHERE \"timestamp\" < ? ORDER BY id DESC LIMIT 1"
UU_SQL_MAXID="SELECT id FROM directus_activity ORDER BY id DESC LIMIT 1"
UU_SQL_ACTIVITY="SELECT id, collection, item, \"timestamp\" FROM directus_activity WHERE \"user\" = ? AND id > ? AND action IN ('create', 'update') AND collection IN (?, ?, ?, ?, ?, ?, ?) ORDER BY id LIMIT 500"
UU_SQL_DELUNPINNED="DELETE FROM d1_private.user_usage WHERE user_id = ? AND pinned = false"
UU_SQL_ZEROPINNED="UPDATE d1_private.user_usage SET score = 0 WHERE user_id = ? AND pinned = true"
UU_SQL_GETPINS="SELECT kind, target FROM d1_private.user_usage WHERE user_id = ? AND pinned = true ORDER BY pin_order, kind, target"
UU_SQL_PINAPPEND="UPDATE d1_private.user_usage SET pin_order = (SELECT coalesce(max(pin_order), -1) + 1 FROM d1_private.user_usage WHERE user_id = ? AND pin_order IS NOT NULL) WHERE user_id = ? AND kind = ? AND target = ? AND pin_order IS NULL"
UU_SQL_CLEARPINORDER="UPDATE d1_private.user_usage SET pin_order = NULL WHERE user_id = ? AND kind = ? AND target = ?"
UU_SQL_COMPACTPINS="UPDATE d1_private.user_usage u SET pin_order = r.n FROM (SELECT kind, target, row_number() OVER (ORDER BY pin_order, kind, target) - 1 AS n FROM d1_private.user_usage WHERE user_id = ? AND pin_order IS NOT NULL) r WHERE u.user_id = ? AND u.kind = r.kind AND u.target = r.target"
UU_SQL_SETPINORDER="UPDATE d1_private.user_usage SET pin_order = ? WHERE user_id = ? AND kind = ? AND target = ? AND pinned = true"
UU_SQL_UNPINALL="UPDATE d1_private.user_usage SET pinned = false, pin_order = NULL WHERE user_id = ? AND (pinned = true OR pin_order IS NOT NULL)"
UU_SQL_GETPREFS="SELECT pins_seeded, prefs FROM d1_private.user_prefs WHERE user_id = ?"
UU_SQL_MARKSEEDED="INSERT INTO d1_private.user_prefs (user_id, pins_seeded) VALUES (?, true) ON CONFLICT (user_id) DO UPDATE SET pins_seeded = true, updated_at = now()"
UU_SQL_SETPREFS="INSERT INTO d1_private.user_prefs (user_id, prefs) VALUES (?, ?::jsonb) ON CONFLICT (user_id) DO UPDATE SET prefs = d1_private.user_prefs.prefs || EXCLUDED.prefs, updated_at = now()"
uu_prepare() { # uu_prepare <name> <sql with ?>: a PREPARE with the placeholders numbered
    printf 'PREPARE %s AS ' "$1"
    awk '{ s = $0; out = ""; n = 0; while ((i = index(s, "?")) > 0) { n++; out = out substr(s, 1, i - 1) "$" n; s = substr(s, i + 1) } print out s ";" }' <<<"$2"
}
uu_stmt() { # uu_stmt <statements>: the real statements prepared, two users and a shadow directus_activity, then ROLLBACK
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$UU_A'), ('$UU_B');
CREATE TEMP TABLE directus_activity (id integer PRIMARY KEY, action varchar(45) NOT NULL, "user" uuid,
    "timestamp" timestamptz NOT NULL DEFAULT now(), collection varchar(64) NOT NULL, item varchar(255) NOT NULL);
$(uu_prepare lock "$UU_SQL_LOCK")
$(uu_prepare getrow "$UU_SQL_GETROW")
$(uu_prepare upsert "$UU_SQL_UPSERT")
$(uu_prepare list "$UU_SQL_LIST")
$(uu_prepare getcursor "$UU_SQL_GETCURSOR")
$(uu_prepare setcursor "$UU_SQL_SETCURSOR")
$(uu_prepare startid "$UU_SQL_STARTID")
$(uu_prepare maxid "$UU_SQL_MAXID")
$(uu_prepare activity "$UU_SQL_ACTIVITY")
$(uu_prepare delunpinned "$UU_SQL_DELUNPINNED")
$(uu_prepare zeropinned "$UU_SQL_ZEROPINNED")
$(uu_prepare getpins "$UU_SQL_GETPINS")
$(uu_prepare pinappend "$UU_SQL_PINAPPEND")
$(uu_prepare clearpinorder "$UU_SQL_CLEARPINORDER")
$(uu_prepare compactpins "$UU_SQL_COMPACTPINS")
$(uu_prepare setpinorder "$UU_SQL_SETPINORDER")
$(uu_prepare unpinall "$UU_SQL_UNPINALL")
$(uu_prepare getprefs "$UU_SQL_GETPREFS")
$(uu_prepare markseeded "$UU_SQL_MARKSEEDED")
$(uu_prepare setprefs "$UU_SQL_SETPREFS")
$1
ROLLBACK;
SQL
}
UU_TS="'2026-10-12 09:00:00+00'"
uu_out=$(uu_stmt "EXECUTE lock('$UU_A');
EXECUTE upsert('$UU_A', 'page', 'samples', 1, $UU_TS, false, NULL);
EXECUTE upsert('$UU_B', 'page', 'samples', 7, $UU_TS, true, NULL);
EXECUTE upsert('$UU_A', 'page', 'samples', 2.5, $UU_TS, true, NULL);
SELECT 'uu_up:' || count(*) || ',' || (SELECT score || '/' || pinned FROM d1_private.user_usage WHERE user_id = '$UU_A') || ',' || (SELECT score FROM d1_private.user_usage WHERE user_id = '$UU_B') FROM d1_private.user_usage;
CREATE TEMP TABLE got AS EXECUTE getrow('$UU_A', 'page', 'samples');
CREATE TEMP TABLE got2 AS EXECUTE getrow('$UU_A', 'page', 'other');
SELECT 'uu_get:' || (SELECT count(*) FROM got) || ',' || (SELECT count(*) FROM got2);")
grep -q 'uu_up:2,2.5/true,7' <<<"$uu_out" && ok "the visit upsert's ON CONFLICT (user_id, kind, target) updates one user's row and leaves another user's alone" || bad "visit upsert gave the wrong rows (output: $uu_out)"
grep -q 'uu_get:1,0' <<<"$uu_out" && ok "the row lookup finds the user's row and only that one" || bad "row lookup gave the wrong rows (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'visible', 1, $UU_TS, false, NULL);
EXECUTE upsert('$UU_A', 'page', 'revisited', 1, '2026-10-12 10:00:00+00', false, '2026-10-12 09:00:00+00');
EXECUTE upsert('$UU_A', 'page', 'hidden', 1, $UU_TS, false, '2026-10-12 09:00:00+00');
EXECUTE upsert('$UU_A', 'record', 'hidden_later', 1, $UU_TS, false, '2026-10-12 11:00:00+00');
EXECUTE upsert('$UU_B', 'page', 'bobs', 1, $UU_TS, false, NULL);
CREATE TEMP TABLE listed AS EXECUTE list('$UU_A');
SELECT 'uu_list:' || string_agg(kind || '/' || target, ',' ORDER BY target) FROM listed;")
grep -qx 'uu_list:page/revisited,page/visible' <<<"$uu_out" && ok "the list predicate hides an item until it is used again after hidden_at, and returns only the caller's rows" || bad "list predicate gave the wrong rows (output: $uu_out)"
uu_out=$(uu_stmt "INSERT INTO directus_activity (id, action, \"user\", collection, item)
    SELECT g, 'update', '$UU_A', 'physical_samples', gen_random_uuid()::text FROM generate_series(1, 600) g;
INSERT INTO directus_activity (id, action, \"user\", collection, item) VALUES
    (601, 'update', '$UU_B', 'physical_samples', 'b'), (602, 'delete', '$UU_A', 'physical_samples', 'x'),
    (603, 'create', '$UU_A', 'directus_users', 'y'), (604, 'create', '$UU_A', 'campaigns', 'z');
UPDATE directus_activity SET \"timestamp\" = now() - interval '40 days' WHERE id <= 2;
CREATE TEMP TABLE page1 AS EXECUTE activity('$UU_A', 0, 'physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'people', 'equipment');
SELECT 'uu_fold1:' || count(*) || ',' || min(id) || ',' || max(id) || ',' || count(*) FILTER (WHERE id > 600) FROM page1;
CREATE TEMP TABLE page2 AS EXECUTE activity('$UU_A', 550, 'physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'people', 'equipment');
SELECT 'uu_fold2:' || count(*) || ',' || min(id) || ',' || max(id) || ',' || string_agg(DISTINCT collection, ',') FROM page2;
CREATE TEMP TABLE sid AS EXECUTE startid(now() - interval '30 days');
CREATE TEMP TABLE mid AS EXECUTE maxid;
SELECT 'uu_ids:' || (SELECT id FROM sid) || ',' || (SELECT id FROM mid);")
grep -q 'uu_fold1:500,1,500,0' <<<"$uu_out" && ok "the fold scan takes at most 500 of the user's rows, oldest id first, and no one else's" || bad "fold scan page 1 is wrong (output: $uu_out)"
grep -q 'uu_fold2:51,551,604,campaigns,physical_samples' <<<"$uu_out" && ok "the fold scan from a cursor skips other users, deletes and other collections" || bad "fold scan from a cursor is wrong (output: $uu_out)"
grep -q 'uu_ids:2,604' <<<"$uu_out" && ok "the first-fold start id is the newest activity older than the cutoff; the newest id is the maximum" || bad "start id / max id statements are wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE setcursor('$UU_A', 5);
EXECUTE setcursor('$UU_A', 9);
EXECUTE setcursor('$UU_B', 1);
CREATE TEMP TABLE cur AS EXECUTE getcursor('$UU_A');
SELECT 'uu_cursor:' || (SELECT last_activity_id FROM cur) || ',' || (SELECT count(*) FROM d1_private.user_usage_cursor);")
grep -q 'uu_cursor:9,2' <<<"$uu_out" && ok "the cursor upsert keeps one row per user and the lookup returns the user's own" || bad "cursor statements are wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'pinned', 4, $UU_TS, true, NULL);
EXECUTE upsert('$UU_A', 'page', 'plain', 4, $UU_TS, false, NULL);
EXECUTE upsert('$UU_B', 'page', 'plain', 4, $UU_TS, false, NULL);
EXECUTE delunpinned('$UU_A');
EXECUTE zeropinned('$UU_A');
SELECT 'uu_clear2:' || coalesce(string_agg((user_id = '$UU_A')::text || '/' || target || '/' || score, ',' ORDER BY user_id, target), '') FROM d1_private.user_usage;")
grep -q 'uu_clear2:true/pinned/0,false/plain/4' <<<"$uu_out" && ok "clear deletes the caller's unpinned rows, zeroes the pinned ones, and leaves other users' rows" || bad "clear statements gave the wrong rows (output: $uu_out)"
# The sidebar statements (migration 170), same way.
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'visible', 1, $UU_TS, false, NULL);
EXECUTE upsert('$UU_A', 'page', 'pinned', 1, $UU_TS, true, NULL);
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, false, NULL);
EXECUTE upsert('$UU_A', 'record', 'campaigns:x', 1, $UU_TS, false, NULL);
CREATE TEMP TABLE listed AS EXECUTE list('$UU_A');
SELECT 'uu_home:' || string_agg(kind || '/' || target, ',' ORDER BY target) FROM listed;")
grep -qx 'uu_home:record/campaigns:x,page/visible' <<<"$uu_out" && ok "the Home list leaves out pinned rows and view rows" || bad "Home list predicate is wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'view', '12');
EXECUTE upsert('$UU_A', 'record', 'campaigns:x', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'record', 'campaigns:x');
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
CREATE TEMP TABLE pins AS EXECUTE getpins('$UU_A');
SELECT 'uu_pins1:' || (SELECT string_agg(kind || '/' || target, ',') FROM pins);
SELECT 'uu_pins1b:' || string_agg(target || '=' || pin_order, ',' ORDER BY user_id, pin_order) FROM d1_private.user_usage;")
grep -q 'uu_pins1:page/a,view/12,record/campaigns:x' <<<"$uu_out" && ok "a new pin goes last, whatever its kind, and the pin list is in order" || bad "pin append or list is wrong (output: $uu_out)"
grep -q 'uu_pins1b:a=0,12=1,campaigns:x=2,a=0' <<<"$uu_out" && ok "pinning again keeps the place, and another user's order starts at 0 on its own" || bad "pin append is not per user or not idempotent (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'page', 'b', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'b');
EXECUTE upsert('$UU_A', 'page', 'c', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'c');
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE upsert('$UU_B', 'page', 'b', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'b');
EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, false, NULL);
EXECUTE clearpinorder('$UU_A', 'page', 'a');
EXECUTE compactpins('$UU_A', '$UU_A');
SELECT 'uu_gap:' || string_agg((user_id = '$UU_A')::text || '/' || target || '=' || coalesce(pin_order::text, 'null'), ',' ORDER BY user_id, target) FROM d1_private.user_usage;")
grep -q 'uu_gap:true/a=null,true/b=0,true/c=1,false/a=0,false/b=1' <<<"$uu_out" && ok "an unpin clears its order and compaction closes the gap, for that user only" || bad "gap closing is wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'view', '12');
EXECUTE upsert('$UU_A', 'page', 'plain', 3, $UU_TS, false, NULL);
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE setpinorder(1, '$UU_A', 'page', 'a');
EXECUTE setpinorder(0, '$UU_A', 'view', '12');
EXECUTE setpinorder(7, '$UU_A', 'page', 'plain');
EXECUTE setpinorder(9, '$UU_A', 'page', 'a');
EXECUTE setpinorder(1, '$UU_A', 'page', 'a');
CREATE TEMP TABLE pins AS EXECUTE getpins('$UU_A');
SELECT 'uu_reorder:' || (SELECT string_agg(kind || '/' || target, ',') FROM pins) || ',' || (SELECT coalesce(pin_order::text, 'null') FROM d1_private.user_usage WHERE user_id = '$UU_A' AND target = 'plain') || ',' || (SELECT pin_order FROM d1_private.user_usage WHERE user_id = '$UU_B');")
grep -q 'uu_reorder:view/12,page/a,null,0' <<<"$uu_out" && ok "setting the order writes the caller's pinned rows only (not unpinned rows, not other users)" || bad "set order is wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE upsert('$UU_A', 'page', 'a', 2, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'page', 'a');
EXECUTE upsert('$UU_A', 'view', '12', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_A', '$UU_A', 'view', '12');
EXECUTE upsert('$UU_B', 'page', 'a', 0, $UU_TS, true, NULL);
EXECUTE pinappend('$UU_B', '$UU_B', 'page', 'a');
EXECUTE unpinall('$UU_A');
SELECT 'uu_unpinall:' || string_agg((user_id = '$UU_A')::text || '/' || target || '/' || pinned || '/' || coalesce(pin_order::text, 'null') || '/' || score, ',' ORDER BY user_id, target) FROM d1_private.user_usage;")
grep -q 'uu_unpinall:true/12/false/null/0,true/a/false/null/2,false/a/true/0/0' <<<"$uu_out" && ok "unpin-all clears the caller's pins and orders, keeps scores, and leaves other users alone" || bad "unpin-all is wrong (output: $uu_out)"
uu_out=$(uu_stmt "CREATE TEMP TABLE p0 AS EXECUTE getprefs('$UU_A');
EXECUTE setprefs('$UU_A', '{\"theme\": \"dark\"}');
EXECUTE setprefs('$UU_A', '{\"sidebarCollapsed\": true, \"theme\": \"light\"}');
EXECUTE markseeded('$UU_A');
EXECUTE setprefs('$UU_B', '{\"autoCollapse\": false}');
EXECUTE markseeded('$UU_A');
CREATE TEMP TABLE p1 AS EXECUTE getprefs('$UU_A');
CREATE TEMP TABLE p2 AS EXECUTE getprefs('$UU_B');
SELECT 'uu_prefs:' || (SELECT count(*) FROM p0) || ',' || (SELECT pins_seeded || ':' || (prefs->>'theme') || ':' || (prefs->>'sidebarCollapsed') FROM p1) || ',' || (SELECT pins_seeded || ':' || (prefs->>'autoCollapse') FROM p2) || ',' || (SELECT count(*) FROM d1_private.user_prefs);")
grep -q 'uu_prefs:0,true:light:true,false:false,2' <<<"$uu_out" && ok "prefs upsert merges keys, marking seeded keeps them, a first prefs write leaves pins_seeded false, one row per user" || bad "prefs statements are wrong (output: $uu_out)"
uu_out=$(uu_stmt "EXECUTE setprefs('$UU_A', '{}');
UPDATE d1_private.user_prefs SET updated_at = '2000-01-01';
EXECUTE setprefs('$UU_A', '{\"theme\": \"dark\"}');
SELECT 'uu_prefs_ts:' || (updated_at > '2020-01-01') FROM d1_private.user_prefs;
UPDATE d1_private.user_prefs SET updated_at = '2000-01-01';
EXECUTE markseeded('$UU_A');
SELECT 'uu_seed_ts:' || (updated_at > '2020-01-01') FROM d1_private.user_prefs;")
grep -q 'uu_prefs_ts:t' <<<"$uu_out" && grep -q 'uu_seed_ts:t' <<<"$uu_out" && ok "every prefs write sets updated_at" || bad "updated_at not set on a prefs write (output: $uu_out)"

echo "== Pin order, view pins and user preferences (migration 170) =="
# Same rolled-back-transaction pattern as migration 163 (fixture users UU_A / UU_B, set above).
[[ -f "$UP" ]] && ok "found migration 170" || bad "migration 170 is missing ($UP)"
up_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$UP")
run_eq "user_usage has pin_order (nullable integer)" \
    "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'user_usage' AND column_name = 'pin_order'" "integer:YES"
run_eq "user_prefs is in d1_private, not public, and not in v_schema_dictionary" \
    "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'd1_private' AND tablename = 'user_prefs') || ',' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_prefs') || ',' || (SELECT count(*) FROM v_schema_dictionary WHERE object_name = 'user_prefs')" "1,0,0"
run_eq "d1_llm_readonly cannot read user_prefs" \
    "SELECT has_table_privilege('d1_llm_readonly', 'd1_private.user_prefs', 'SELECT')" "f"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target, pinned, pin_order) VALUES ('$UU_A', 'view', '12', true, 0);
SELECT 'up_view:' || kind || ':' || target || ':' || pin_order FROM d1_private.user_usage WHERE user_id = '$UU_A';")
grep -q 'up_view:view:12:0' <<<"$uu_out" && ok "kind view is accepted, with a pin_order" || bad "view row insert failed (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'other', '1');")
grep -q 'check constraint' <<<"$uu_out" && ok "a kind other than page / record / view is still rejected" || bad "bad kind was not rejected after migration 170 (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'page', 'samples');
SELECT 'up_null:' || coalesce(pin_order::text, '<null>') FROM d1_private.user_usage WHERE user_id = '$UU_A';")
grep -q 'up_null:<null>' <<<"$uu_out" && ok "pin_order is NULL until a row is pinned" || bad "pin_order default is not NULL (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('$UU_A');
SELECT 'up_prefs:' || pins_seeded || ':' || prefs || ':' || (updated_at IS NOT NULL) FROM d1_private.user_prefs WHERE user_id = '$UU_A';")
grep -q 'up_prefs:false:{}:true' <<<"$uu_out" && ok "a preferences row defaults to pins_seeded false and empty prefs" || bad "user_prefs defaults are wrong (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('$UU_A'), ('$UU_A');")
grep -q 'duplicate key' <<<"$uu_out" && ok "one preferences row per user" || bad "second preferences row was not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('9e000000-0000-4000-8000-0000000000ff');")
grep -q 'foreign key' <<<"$uu_out" && ok "preferences for a user that does not exist are rejected (foreign key)" || bad "prefs without a user were not rejected (output: $uu_out)"
uu_out=$(uu_sql "INSERT INTO d1_private.user_prefs (user_id) VALUES ('$UU_A'), ('$UU_B');
DELETE FROM directus_users WHERE id = '$UU_A';
SELECT 'up_cascade:' || count(*) FROM d1_private.user_prefs;")
grep -q 'up_cascade:1' <<<"$uu_out" && ok "deleting a user removes their preferences row, and only theirs" || bad "prefs did not follow their user (output: $uu_out)"
run_eq "user_prefs, its columns and pin_order have comments (without: none)" \
    "SELECT coalesce(string_agg(x, ', '), '') FROM (
        SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname = 'user_prefs' AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND a.attnum > 0 AND NOT a.attisdropped AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
           AND (c.relname = 'user_prefs' OR (c.relname = 'user_usage' AND a.attname = 'pin_order'))) q" ""
# Back-fill and down: run 170's down (back to the 163 shape), seed pins out of order, run its up, check the numbering,
# then add a view pin and run the down again (the view row goes, the order column goes, the old CHECK is back).
uu_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$UU_A'), ('$UU_B');
$up_down
INSERT INTO d1_private.user_usage (user_id, kind, target, pinned, last_at) VALUES
  ('$UU_A', 'page',   'samples',            true,  '2026-10-03'),
  ('$UU_A', 'record', 'physical_samples:x', true,  '2026-10-01'),
  ('$UU_A', 'page',   'tests',              true,  '2026-10-02'),
  ('$UU_A', 'page',   'people',             false, '2026-09-01'),
  ('$UU_B', 'page',   'samples',            true,  '2026-10-05'),
  ('$UU_B', 'page',   'tests',              true,  '2026-10-05');
$up_up
SELECT 'up_bf_a:' || string_agg(target || '=' || pin_order, ',' ORDER BY pin_order) FROM d1_private.user_usage WHERE user_id = '$UU_A' AND pinned;
SELECT 'up_bf_b:' || string_agg(target || '=' || pin_order, ',' ORDER BY pin_order) FROM d1_private.user_usage WHERE user_id = '$UU_B' AND pinned;
SELECT 'up_bf_unpinned:' || coalesce(pin_order::text, '<null>') FROM d1_private.user_usage WHERE user_id = '$UU_A' AND target = 'people';
INSERT INTO d1_private.user_usage (user_id, kind, target, pinned, pin_order) VALUES ('$UU_A', 'view', '12', true, 3);
$up_down
SELECT 'up_dn_kinds:' || string_agg(DISTINCT kind, ',') FROM d1_private.user_usage;
SELECT 'up_dn_rows:' || count(*) FROM d1_private.user_usage;
SELECT 'up_dn_pinned:' || count(*) FROM d1_private.user_usage WHERE pinned;
SELECT 'up_dn_column:' || count(*) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'user_usage' AND column_name = 'pin_order';
SELECT 'up_dn_prefs:' || coalesce(to_regclass('d1_private.user_prefs')::text, 'gone');
SAVEPOINT s;
INSERT INTO d1_private.user_usage (user_id, kind, target) VALUES ('$UU_A', 'view', '13');
ROLLBACK;
SQL
)
grep -q 'up_bf_a:samples=0,tests=1,physical_samples:x=2' <<<"$uu_out" && ok "up numbers existing pins by last_at, newest first (as U1 showed them), from 0" || bad "back-fill order is wrong (output: $uu_out)"
grep -q 'up_bf_b:samples=0,tests=1' <<<"$uu_out" && ok "up numbers each user's pins separately (ties broken by kind, target)" || bad "second user's back-fill is wrong (output: $uu_out)"
grep -q 'up_bf_unpinned:<null>' <<<"$uu_out" && ok "up leaves unpinned rows without a pin_order" || bad "unpinned row got a pin_order (output: $uu_out)"
grep -q 'up_dn_kinds:page,record' <<<"$uu_out" && grep -q 'up_dn_rows:6' <<<"$uu_out" && ok "down deletes the view rows and keeps the page and record rows" || bad "down left the wrong rows (output: $uu_out)"
grep -q 'up_dn_pinned:5' <<<"$uu_out" && ok "down keeps pinned = true on the page and record pins" || bad "down lost pinned flags (output: $uu_out)"
grep -q 'up_dn_column:0' <<<"$uu_out" && grep -q 'up_dn_prefs:gone' <<<"$uu_out" && ok "down drops pin_order and user_prefs" || bad "down left pin_order or user_prefs (output: $uu_out)"
grep -q 'check constraint' <<<"$uu_out" && ok "down restores the old CHECK (kind view is rejected again)" || bad "down did not restore the CHECK (output: $uu_out)"
