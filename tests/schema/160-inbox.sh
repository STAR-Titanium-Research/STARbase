# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Found files inbox: uni alias, share folder, candidates, folder cache, scan requests, crawler state, prefs =="
# Spec docs/superpowers/specs/2026-10-15-found-files-inbox-design.md section 4. Each check is its own rolled-back
# transaction (ids prefix a2000000-0000-4000-8000-). A rejected statement aborts psql (ON_ERROR_STOP), so the error
# text is what is asserted on. The CI database has the stub directus_files and directus_users (id only), so the
# fixture rows set just the id.
FI_MIG=$(migration found_files_inbox)
[[ -n "$FI_MIG" && -f "$FI_MIG" ]] && ok "found the found files inbox migration (${FI_MIG:-none})" || bad "the found files inbox migration is missing (db/migrations/*_found_files_inbox.sql)"
FI_P1='a2000000-0000-4000-8000-0000000000a1'
FI_P2='a2000000-0000-4000-8000-0000000000a2'
FI_T1='a2000000-0000-4000-8000-0000000000b1'
FI_F1='a2000000-0000-4000-8000-0000000000c1'
FI_F2='a2000000-0000-4000-8000-0000000000c2'
FI_F3='a2000000-0000-4000-8000-0000000000c3'
FI_U1='a2000000-0000-4000-8000-0000000000d1'
FI_U2='a2000000-0000-4000-8000-0000000000d2'
FI_A65=$(printf 'a%.0s' $(seq 1 65))
FI_A64=$(printf 'a%.0s' $(seq 1 64))
fi_sql() { # fi_sql <statements>: run them after fixture people, a team, files and users, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('$FI_P1', 'Inbox Test One'), ('$FI_P2', 'Inbox Test Two');
INSERT INTO teams (team_id, name) VALUES ('$FI_T1', 'Inbox Test Team');
INSERT INTO directus_files (id) VALUES ('$FI_F1'), ('$FI_F2'), ('$FI_F3');
INSERT INTO directus_users (id) VALUES ('$FI_U1'), ('$FI_U2');
$1
ROLLBACK;
SQL
}
fi_new_tables="'file_candidates', 'inbox_dirs', 'inbox_scan_requests', 'inbox_crawler_state', 'inbox_prefs'"
run_eq "the five new tables are in d1_private" \
    "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relkind = 'r' AND c.relname IN ($fi_new_tables)" \
    "file_candidates,inbox_crawler_state,inbox_dirs,inbox_prefs,inbox_scan_requests"
run_eq "none of them is in public, v_schema_dictionary, directus_collections or directus_fields (not exposed in Directus)" \
    "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ($fi_new_tables)) || ',' || (SELECT count(*) FROM v_schema_dictionary WHERE object_name IN ($fi_new_tables)) || ',' || (SELECT count(*) FROM directus_collections WHERE collection IN ($fi_new_tables)) || ',' || (SELECT count(*) FROM directus_fields WHERE collection IN ($fi_new_tables))" "0,0,0,0"
run_eq "d1_llm_readonly cannot read candidates, folders, requests, crawler state or prefs" \
    "SELECT bool_or(has_table_privilege('d1_llm_readonly', 'd1_private.' || t, 'SELECT')) FROM unnest(ARRAY['file_candidates', 'inbox_dirs', 'inbox_scan_requests', 'inbox_crawler_state', 'inbox_prefs']) AS t" "f"
# people.uni_alias / people.scan_while_former
run_eq "people.uni_alias is nullable text and scan_while_former is boolean NOT NULL" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'people' AND column_name IN ('uni_alias', 'scan_while_former')" \
    "scan_while_former:boolean:NO,uni_alias:text:YES"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'a' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias 'a' (one character) is rejected" || bad "one-character uni_alias was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'a/b' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias 'a/b' (a slash) is rejected" || bad "uni_alias with a slash was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'a\\b' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias with a backslash is rejected" || bad "uni_alias with a backslash was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = '$FI_A65' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "a 65-character uni_alias is rejected" || bad "65-character uni_alias was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = '..' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias '..' is rejected (it would walk out of Users/)" || bad "uni_alias '..' was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = '.snapshot' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias '.snapshot' (a leading dot) is rejected" || bad "uni_alias with a leading dot was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = '.ab' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias '.ab' (a leading dot) is rejected" || bad "uni_alias '.ab' was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'a b' WHERE person_id = '$FI_P1';")
grep -q 'check constraint' <<<"$fi_out" && ok "uni_alias with a space is rejected" || bad "uni_alias with a space was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'abc12de' WHERE person_id = '$FI_P1';
UPDATE people SET uni_alias = '$FI_A64' WHERE person_id = '$FI_P2';
SELECT 'fi_alias:' || uni_alias || ':' || scan_while_former FROM people WHERE person_id = '$FI_P1';")
grep -q 'fi_alias:abc12de:false' <<<"$fi_out" && ok "uni_alias 'abc12de' (and a 64-character one) is accepted; scan_while_former defaults to false" || bad "valid uni_alias failed (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'ab.c_d-1' WHERE person_id = '$FI_P1';
SELECT 'fi_alias_chars:' || uni_alias FROM people WHERE person_id = '$FI_P1';")
grep -q 'fi_alias_chars:ab.c_d-1' <<<"$fi_out" && ok "uni_alias may contain dot, underscore and hyphen" || bad "uni_alias with . _ - failed (output: $fi_out)"
fi_out=$(fi_sql "UPDATE people SET uni_alias = 'Abc12de' WHERE person_id = '$FI_P1';
UPDATE people SET uni_alias = 'aBC12DE' WHERE person_id = '$FI_P2';")
grep -q 'duplicate key' <<<"$fi_out" && ok "a uni_alias that differs only in case is rejected (unique on lower)" || bad "case-different duplicate uni_alias was not rejected (output: $fi_out)"
run_eq "people_uni_alias_key is a unique index on lower(uni_alias), partial WHERE uni_alias IS NOT NULL (so any number of people may have no alias)" \
    "SELECT (indexdef LIKE 'CREATE UNIQUE INDEX people_uni_alias_key ON public.people USING btree (lower(uni_alias)) WHERE (uni_alias IS NOT NULL)') FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'people_uni_alias_key'" "t"
fi_out=$(fi_sql "SELECT 'fi_nulls:' || count(*) FROM people WHERE person_id IN ('$FI_P1', '$FI_P2') AND uni_alias IS NULL;
UPDATE people SET uni_alias = 'solo01' WHERE person_id = '$FI_P1';
SELECT 'fi_nulls_after:' || count(*) FROM people WHERE person_id IN ('$FI_P1', '$FI_P2') AND uni_alias IS NULL;")
grep -q 'fi_nulls:2' <<<"$fi_out" && grep -q 'fi_nulls_after:1' <<<"$fi_out" && ok "two people without an alias coexist, and one of them can take an alias while the other stays without" || bad "NULL aliases misbehaved (output: $fi_out)"
# A new people row cannot carry an alias or the Former switch (a Lab Member can create people; only an administrator may UPDATE these)
fi_out=$(fi_sql "INSERT INTO people (full_name, uni_alias) VALUES ('Inbox Squatter', 'squat1');")
grep -q 'uni_alias and scan_while_former can only be set by an update' <<<"$fi_out" && ok "inserting a person with a uni_alias is refused (an alias can only be set by an update)" || bad "insert with uni_alias was not refused (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO people (full_name, scan_while_former) VALUES ('Inbox Squatter', true);")
grep -q 'uni_alias and scan_while_former can only be set by an update' <<<"$fi_out" && ok "inserting a person with scan_while_former true is refused" || bad "insert with scan_while_former was not refused (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO people (full_name, scan_while_former) VALUES ('Inbox Plain', false);
UPDATE people SET uni_alias = 'plain01', scan_while_former = true WHERE full_name = 'Inbox Plain';
SELECT 'fi_ins_upd:' || uni_alias || ':' || scan_while_former FROM people WHERE full_name = 'Inbox Plain';")
grep -q 'fi_ins_upd:plain01:true' <<<"$fi_out" && ok "a person inserted without them can be given an alias and the Former switch by an update" || bad "insert-then-update of alias failed (output: $fi_out)"
run_eq "the insert guard is a BEFORE INSERT row trigger on people" \
    "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.people'::regclass AND tgname = 'people_inbox_columns_insert' AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 AND (tgtype & 1) = 1" "1"
# teams.share_folder
run_eq "teams_share_folder_key is a unique index on lower(share_folder), partial WHERE share_folder IS NOT NULL" \
    "SELECT (indexdef LIKE 'CREATE UNIQUE INDEX teams_share_folder_key ON public.teams USING btree (lower(share_folder)) WHERE (share_folder IS NOT NULL)') FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'teams_share_folder_key'" "t"
run_eq "teams.share_folder is nullable text" \
    "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'share_folder'" "text:YES"
fi_out=$(fi_sql "UPDATE teams SET share_folder = 'x/y' WHERE team_id = '$FI_T1';")
grep -q 'check constraint' <<<"$fi_out" && ok "share_folder 'x/y' is rejected" || bad "share_folder with a slash was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = 'x\\y' WHERE team_id = '$FI_T1';")
grep -q 'check constraint' <<<"$fi_out" && ok "share_folder 'x\\y' is rejected" || bad "share_folder with a backslash was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = '' WHERE team_id = '$FI_T1';")
grep -q 'check constraint' <<<"$fi_out" && ok "an empty share_folder is rejected" || bad "empty share_folder was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = '   ' WHERE team_id = '$FI_T1';")
grep -q 'check constraint' <<<"$fi_out" && ok "a blank share_folder is rejected" || bad "blank share_folder was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = ' Lab' WHERE team_id = '$FI_T1';")
grep -q 'teams_share_folder_trim_check' <<<"$fi_out" && ok "a share_folder with a leading blank is rejected" || bad "leading blank in share_folder was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = 'Lab ' WHERE team_id = '$FI_T1';")
grep -q 'teams_share_folder_trim_check' <<<"$fi_out" && ok "a share_folder with a trailing blank is rejected" || bad "trailing blank in share_folder was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = '..' WHERE team_id = '$FI_T1';")
grep -q 'check constraint' <<<"$fi_out" && ok "share_folder '..' is rejected (it would walk out of Shared/)" || bad "share_folder '..' was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE teams SET share_folder = 'Alloy Group 2026' WHERE team_id = '$FI_T1';
SELECT 'fi_folder:' || share_folder FROM teams WHERE team_id = '$FI_T1';")
grep -q 'fi_folder:Alloy Group 2026' <<<"$fi_out" && ok "a share_folder with spaces is accepted" || bad "valid share_folder failed (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO teams (team_id, name, share_folder) VALUES ('a2000000-0000-4000-8000-0000000000b2', 'Inbox Test Team Two', 'Shared Lab');
UPDATE teams SET share_folder = 'SHARED LAB' WHERE team_id = '$FI_T1';")
grep -q 'duplicate key' <<<"$fi_out" && ok "a share_folder that differs only in case is rejected (unique on lower)" || bad "case-different duplicate share_folder was not rejected (output: $fi_out)"
# file_candidates
FI_C="INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'Users/abc12de/a.tif');
SELECT 'fi_cand:' || state || ':' || match_strength || ':' || extracted || ':' || matches || ':' || (candidate_id IS NOT NULL) || ':' || (first_seen_at IS NOT NULL) || ':' || coalesce(decided_at::text, '<null>') FROM d1_private.file_candidates;")
grep -q 'fi_cand:new:none:{}:\[\]:true:true:<null>' <<<"$fi_out" && ok "a candidate inserts with state new, match_strength none, empty extracted and matches" || bad "candidate defaults are wrong (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_team_id, kind, origin, rel_path) VALUES ('$FI_F1', '$FI_T1', 'document', 'backlog', 'Shared/Lab/a.pdf');
SELECT 'fi_team_cand:' || count(*) FROM d1_private.file_candidates;")
grep -q 'fi_team_cand:1' <<<"$fi_out" && ok "a candidate owned by a team inserts" || bad "team-owned candidate failed (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, owner_team_id, kind, origin, rel_path) VALUES ('$FI_F1', '$FI_P1', '$FI_T1', 'image', 'new', 'x.tif');")
grep -q 'check constraint' <<<"$fi_out" && ok "a candidate with both a person and a team owner is rejected" || bad "candidate with two owners was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, kind, origin, rel_path) VALUES ('$FI_F1', 'image', 'new', 'x.tif');")
grep -q 'check constraint' <<<"$fi_out" && ok "a candidate with no owner is rejected" || bad "candidate with no owner was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'video', 'new', 'x.tif');")
grep -q 'check constraint' <<<"$fi_out" && ok "an unknown candidate kind is rejected" || bad "bad kind was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'old', 'x.tif');")
grep -q 'check constraint' <<<"$fi_out" && ok "an unknown candidate origin is rejected" || bad "bad origin was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'deleted');")
grep -q 'check constraint' <<<"$fi_out" && ok "an unknown candidate state is rejected" || bad "bad state was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, match_strength) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'strong');")
grep -q 'check constraint' <<<"$fi_out" && ok "an unknown match_strength is rejected" || bad "bad match_strength was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state, link_kind, linked_collection, linked_junction_id, link_batch_id) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', 'magic', 'physical_samples', gen_random_uuid(), gen_random_uuid());")
grep -q 'file_candidates_link_kind_check' <<<"$fi_out" && ok "an unknown link_kind is rejected (by the link_kind check itself)" || bad "bad link_kind was not rejected (output: $fi_out)"
FI_LINK="'physical_samples', gen_random_uuid(), gen_random_uuid()"
FI_CL="INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state, link_kind, linked_collection, linked_junction_id, link_batch_id)"
fi_out=$(fi_sql "$FI_CL VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', NULL, $FI_LINK);")
grep -q 'file_candidates_linked_bookkeeping_check' <<<"$fi_out" && ok "a linked candidate without a link_kind is rejected" || bad "linked without link_kind was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_CL VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', 'manual', NULL, gen_random_uuid(), gen_random_uuid());")
grep -q 'file_candidates_linked_bookkeeping_check' <<<"$fi_out" && ok "a linked candidate without a linked_collection is rejected" || bad "linked without linked_collection was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_CL VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', 'manual', 'physical_samples', NULL, gen_random_uuid());")
grep -q 'file_candidates_linked_bookkeeping_check' <<<"$fi_out" && ok "a linked candidate without a linked_junction_id is rejected" || bad "linked without linked_junction_id was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_CL VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', 'manual', 'physical_samples', gen_random_uuid(), NULL);")
grep -q 'file_candidates_linked_bookkeeping_check' <<<"$fi_out" && ok "a linked candidate without a link_batch_id is rejected" || bad "linked without link_batch_id was not rejected (output: $fi_out)"
for fi_col in "link_kind = 'auto'" "linked_collection = 'test_sessions'" "linked_junction_id = gen_random_uuid()" "link_batch_id = gen_random_uuid()"; do
    fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif');
UPDATE d1_private.file_candidates SET $fi_col;")
    grep -q 'file_candidates_unlinked_bookkeeping_check' <<<"$fi_out" && ok "a candidate that is not linked cannot carry link bookkeeping ($fi_col)" || bad "unlinked candidate with $fi_col was not rejected (output: $fi_out)"
done
fi_out=$(fi_sql "$FI_CL VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', 'manual', 'any_future_collection', gen_random_uuid(), gen_random_uuid());
SELECT 'fi_linked_any:' || linked_collection FROM d1_private.file_candidates;")
grep -q 'fi_linked_any:any_future_collection' <<<"$fi_out" && ok "linked_collection is not limited to a list (a later link target needs no migration)" || bad "linked_collection was limited (output: $fi_out)"
fi_out=$(fi_sql "$FI_CL VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif', 'linked', 'manual', $FI_LINK);
UPDATE d1_private.file_candidates SET state = 'new', link_kind = NULL, linked_collection = NULL, linked_junction_id = NULL, link_batch_id = NULL, decided_at = NULL;
SELECT 'fi_undo:' || state || ':' || (link_kind IS NULL) FROM d1_private.file_candidates;")
grep -q 'fi_undo:new:true' <<<"$fi_out" && ok "an undo (state new, all four link columns cleared in one UPDATE) is accepted" || bad "undo update was refused (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO directus_files (id) VALUES ('a2000000-0000-4000-8000-0000000000c4'), ('a2000000-0000-4000-8000-0000000000c5');
$FI_C VALUES ('$FI_F1', '$FI_P1', 'sem_image', 'new', 'a.tif'), ('$FI_F2', '$FI_P1', 'surface_scan', 'backlog', 'b.al3d'), ('$FI_F3', '$FI_P1', 'other', 'new', 'c.mat'), ('a2000000-0000-4000-8000-0000000000c4', '$FI_P1', 'document', 'new', 'd.pdf');
UPDATE d1_private.file_candidates SET state = 'linked', link_kind = 'bulk', linked_collection = 'test_sessions', linked_junction_id = gen_random_uuid(), link_batch_id = gen_random_uuid(), match_strength = 'edge_code' WHERE directus_files_id = '$FI_F1';
UPDATE d1_private.file_candidates SET state = 'dismissed', match_strength = 'code' WHERE directus_files_id = '$FI_F2';
UPDATE d1_private.file_candidates SET state = 'gone', match_strength = 'short_id' WHERE directus_files_id = '$FI_F3';
UPDATE d1_private.file_candidates SET state = 'linked', link_kind = 'auto', linked_collection = 'manufacturing_operations', linked_junction_id = gen_random_uuid(), link_batch_id = gen_random_uuid() WHERE directus_files_id = 'a2000000-0000-4000-8000-0000000000c4';
$FI_CL VALUES ('a2000000-0000-4000-8000-0000000000c5', '$FI_P1', 'image', 'new', 'e.tif', 'linked', 'manual', $FI_LINK);
SELECT 'fi_values:' || count(*) FROM d1_private.file_candidates;")
grep -q 'fi_values:5' <<<"$fi_out" && ok "every allowed kind, origin, state, match_strength and link_kind value is accepted" || bad "allowed values were refused (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif'), ('$FI_F1', '$FI_P2', 'image', 'new', 'a.tif');")
grep -q 'duplicate key' <<<"$fi_out" && ok "directus_files_id is unique: one candidate per file" || bad "second candidate for a file was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('a2000000-0000-4000-8000-0000000000ff', '$FI_P1', 'image', 'new', 'a.tif');")
grep -q 'foreign key' <<<"$fi_out" && ok "a candidate for a directus_files row that does not exist is rejected" || bad "candidate without a file was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif');
DELETE FROM directus_files WHERE id = '$FI_F1';
SELECT 'fi_cascade_file:' || count(*) FROM d1_private.file_candidates;")
grep -q 'fi_cascade_file:0' <<<"$fi_out" && ok "deleting the directus_files row removes its candidate (cascade)" || bad "candidate survived its file's deletion (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif'), ('$FI_F2', '$FI_P2', 'image', 'new', 'b.tif');
DELETE FROM people WHERE person_id = '$FI_P1';
SELECT 'fi_cascade_person:' || count(*) FROM d1_private.file_candidates;")
grep -q 'fi_cascade_person:1' <<<"$fi_out" && ok "deleting a person removes their candidates and only theirs" || bad "candidates did not follow their person (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_team_id, kind, origin, rel_path) VALUES ('$FI_F1', '$FI_T1', 'image', 'new', 'a.tif');
DELETE FROM teams WHERE team_id = '$FI_T1';
SELECT 'fi_cascade_team:' || count(*) FROM d1_private.file_candidates;")
grep -q 'fi_cascade_team:0' <<<"$fi_out" && ok "deleting a team removes its candidates" || bad "candidates did not follow their team (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, duplicate_of) SELECT '$FI_F2', '$FI_P2', 'image', 'new', 'copy.tif', candidate_id FROM d1_private.file_candidates;
SELECT 'fi_dup_set:' || count(*) FROM d1_private.file_candidates WHERE duplicate_of IS NOT NULL;
DELETE FROM d1_private.file_candidates WHERE directus_files_id = '$FI_F1';
SELECT 'fi_dup_cleared:' || count(*) || ':' || count(*) FILTER (WHERE duplicate_of IS NULL) FROM d1_private.file_candidates;")
grep -q 'fi_dup_set:1' <<<"$fi_out" && grep -q 'fi_dup_cleared:1:1' <<<"$fi_out" && ok "duplicate_of points at another candidate and is cleared when that one goes (ON DELETE SET NULL)" || bad "duplicate_of did not behave (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif');
UPDATE d1_private.file_candidates SET duplicate_of = candidate_id;")
grep -q 'check constraint' <<<"$fi_out" && ok "a candidate cannot be a duplicate of itself" || bad "self-duplicate was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, kind_confidence) VALUES ('$FI_F1', '$FI_P1', 'sem_image', 'new', 'a.tif', 1.5);")
grep -q 'check constraint' <<<"$fi_out" && ok "a kind_confidence above 1 is rejected" || bad "kind_confidence 1.5 was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, kind_confidence, size_bytes, matches, extracted, suggested_collection, suggested_record_id) VALUES ('$FI_F1', '$FI_P1', 'sem_image', 'new', 'a.tif', 0.875, 1234, '[{\"collection\":\"physical_samples\",\"record_id\":\"$FI_F2\",\"via\":\"short_id\",\"token\":\"3fa9c1d2\"}]', '{\"kv\": 15}', 'physical_samples', '$FI_F2');
SELECT 'fi_conf:' || kind_confidence || ':' || size_bytes || ':' || suggested_collection FROM d1_private.file_candidates;")
grep -q 'fi_conf:0.875:1234:physical_samples' <<<"$fi_out" && ok "a candidate with a confidence, a size, matches and a suggestion inserts" || bad "full candidate row failed (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, size_bytes) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif', -1);")
grep -q 'check constraint' <<<"$fi_out" && ok "a negative size_bytes is rejected" || bad "negative size_bytes was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, matches) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif', '{}');")
grep -q 'check constraint' <<<"$fi_out" && ok "matches must be a JSON array" || bad "non-array matches was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, extracted) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif', '[]');")
grep -q 'check constraint' <<<"$fi_out" && ok "extracted must be a JSON object" || bad "non-object extracted was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, suggested_collection) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif', 'physical_samples');")
grep -q 'check constraint' <<<"$fi_out" && ok "a suggested collection without a suggested record is rejected" || bad "half a suggestion was not rejected (output: $fi_out)"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', NULL);")
grep -q 'not-null' <<<"$fi_out" && ok "rel_path is required" || bad "NULL rel_path was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, decided_by) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif', 'a2000000-0000-4000-8000-0000000000ff');")
grep -q 'foreign key' <<<"$fi_out" && ok "decided_by must be a directus user" || bad "decided_by without a user was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, decided_by) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif', '$FI_U1');
DELETE FROM directus_users WHERE id = '$FI_U1';
SELECT 'fi_decider:' || count(*) || ':' || count(decided_by) FROM d1_private.file_candidates;")
grep -q 'fi_decider:1:0' <<<"$fi_out" && ok "deleting the user who decided keeps the candidate and clears decided_by" || bad "decided_by did not clear (output: $fi_out)"
run_eq "file_candidates indexes cover (owner_person_id, state), (owner_team_id, state), (link_batch_id), (suggested_record_id), (duplicate_of)" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname = 'd1_private' AND tablename = 'file_candidates' AND (indexdef LIKE '%(owner_person_id, state)%' OR indexdef LIKE '%(owner_team_id, state)%' OR indexdef LIKE '%(link_batch_id)%' OR indexdef LIKE '%(suggested_record_id)%' OR indexdef LIKE '%(duplicate_of)%')" "5"
# auto_undone_at: an undone auto-link is remembered so the crawler's auto-link never links the file again (Opus review B1)
run_eq "file_candidates.auto_undone_at is nullable timestamptz" \
    "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'file_candidates' AND column_name = 'auto_undone_at'" "timestamp with time zone:YES"
fi_out=$(fi_sql "$FI_C VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'x.tif'), ('$FI_F2', '$FI_P1', 'image', 'new', 'y.tif');
UPDATE d1_private.file_candidates SET auto_undone_at = now() WHERE directus_files_id = '$FI_F1';
SELECT 'fi_undone:' || count(*) || ':' || count(auto_undone_at) FROM d1_private.file_candidates;
$FI_CL VALUES ('$FI_F3', '$FI_P1', 'image', 'new', 'z.tif', 'linked', 'manual', $FI_LINK);
UPDATE d1_private.file_candidates SET auto_undone_at = now() WHERE directus_files_id = '$FI_F3';
SELECT 'fi_undone_linked:' || state || ':' || (auto_undone_at IS NOT NULL) FROM d1_private.file_candidates WHERE directus_files_id = '$FI_F3';")
grep -q 'fi_undone:2:1' <<<"$fi_out" && grep -q 'fi_undone_linked:linked:true' <<<"$fi_out" && ok "auto_undone_at is NULL by default, can be set on a new file, and does not disturb the link bookkeeping CHECKs on a linked one" || bad "auto_undone_at behaved wrongly (output: $fi_out)"
# A changed alias or share folder starts the owner's folder over: the old cache rows and the undecided / dismissed / gone
# candidates go, linked ones stay, and an UPDATE that does not change the value deletes nothing.
fi_seed_person="UPDATE people SET uni_alias = 'old01' WHERE person_id = '$FI_P1';
INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id) VALUES ('Users/old01', '$FI_P1'), ('Users/old01/sem', '$FI_P1');
INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id) VALUES ('Users/other', '$FI_P2');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state) VALUES
  ('$FI_F1', '$FI_P1', 'image', 'new', 'Users/old01/a.tif', 'new'),
  ('$FI_F2', '$FI_P1', 'image', 'backlog', 'Users/old01/b.tif', 'dismissed'),
  ('$FI_F3', '$FI_P1', 'image', 'new', 'Users/old01/c.tif', 'gone');
INSERT INTO directus_files (id) VALUES ('a2000000-0000-4000-8000-0000000000c4'), ('a2000000-0000-4000-8000-0000000000c5');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state, link_kind, linked_collection, linked_junction_id, link_batch_id)
  VALUES ('a2000000-0000-4000-8000-0000000000c4', '$FI_P1', 'image', 'new', 'Users/old01/d.tif', 'linked', 'manual', 'physical_samples', gen_random_uuid(), gen_random_uuid());
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state) VALUES
  ('a2000000-0000-4000-8000-0000000000c5', '$FI_P2', 'image', 'new', 'Users/other/e.tif', 'new');"
fi_out=$(fi_sql "$fi_seed_person
UPDATE people SET uni_alias = 'new01' WHERE person_id = '$FI_P1';
SELECT 'fi_alias_chg_dirs:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P2');
SELECT 'fi_alias_chg_cands:' || coalesce(string_agg(state || '@' || (owner_person_id = '$FI_P1')::text, ',' ORDER BY state, owner_person_id), '') FROM d1_private.file_candidates;")
grep -q 'fi_alias_chg_dirs:0:1' <<<"$fi_out" && ok "changing a uni_alias deletes the old owner's folder cache rows and nobody else's" || bad "alias change did not clear the folder cache (output: $fi_out)"
grep -q 'fi_alias_chg_cands:linked@true,new@false' <<<"$fi_out" && ok "changing a uni_alias deletes the owner's new, gone and dismissed candidates; the linked one and other people's stay" || bad "alias change left or removed the wrong candidates (output: $fi_out)"
fi_out=$(fi_sql "$fi_seed_person
UPDATE people SET uni_alias = 'old01', notes = 'touched' WHERE person_id = '$FI_P1';
UPDATE people SET uni_alias = NULL WHERE person_id = '$FI_P2';
SELECT 'fi_alias_same:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$FI_P1');")
grep -q 'fi_alias_same:2:4' <<<"$fi_out" && ok "an UPDATE that leaves the uni_alias as it was deletes nothing" || bad "an unchanged alias deleted rows (output: $fi_out)"
# a change of letter case only is the same alias (uniqueness is case-insensitive): nothing is wiped; NULL to a value and back still is a change
fi_out=$(fi_sql "$fi_seed_person
UPDATE people SET uni_alias = 'OLD01' WHERE person_id = '$FI_P1';
SELECT 'fi_alias_case:' || (SELECT uni_alias FROM people WHERE person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$FI_P1');
UPDATE people SET uni_alias = 'Old01x' WHERE person_id = '$FI_P1';
SELECT 'fi_alias_real:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$FI_P1');")
grep -q 'fi_alias_case:OLD01:2:4' <<<"$fi_out" && ok "changing only the letter case of a uni_alias (old01 to OLD01) wipes nothing: dismissals and the folder cache stay" || bad "a case-only alias change wiped rows (output: $fi_out)"
grep -q 'fi_alias_real:0:1' <<<"$fi_out" && ok "a different alias after a case change still starts the folder over" || bad "a real alias change after a case change did not wipe (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id) VALUES ('Users/never', '$FI_P1');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'Users/never/a.tif', 'dismissed');
UPDATE people SET uni_alias = 'first01' WHERE person_id = '$FI_P1';
SELECT 'fi_alias_null_to_value:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$FI_P1');")
grep -q 'fi_alias_null_to_value:0:0' <<<"$fi_out" && ok "giving a person their first uni_alias (NULL to a value) still starts their folder over" || bad "NULL to a value did not wipe (output: $fi_out)"
fi_out=$(fi_sql "$fi_seed_person
UPDATE people SET uni_alias = NULL WHERE person_id = '$FI_P1';
SELECT 'fi_alias_clear:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_person_id = '$FI_P1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$FI_P1');")
grep -q 'fi_alias_clear:0:1' <<<"$fi_out" && ok "clearing a uni_alias also starts the folder over (linked candidate kept)" || bad "clearing the alias did not clear the cache (output: $fi_out)"
fi_seed_team="UPDATE teams SET share_folder = 'OldFolder' WHERE team_id = '$FI_T1';
INSERT INTO teams (team_id, name, share_folder) VALUES ('a2000000-0000-4000-8000-0000000000b2', 'Inbox Test Team Two', 'OtherFolder');
INSERT INTO d1_private.inbox_dirs (rel_path, owner_team_id) VALUES ('Shared/OldFolder', '$FI_T1'), ('Shared/OldFolder/x', '$FI_T1'), ('Shared/OtherFolder', 'a2000000-0000-4000-8000-0000000000b2');
INSERT INTO directus_files (id) VALUES ('a2000000-0000-4000-8000-0000000000c4'), ('a2000000-0000-4000-8000-0000000000c5');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_team_id, kind, origin, rel_path, state) VALUES
  ('$FI_F1', '$FI_T1', 'image', 'new', 'Shared/OldFolder/a.tif', 'new'),
  ('$FI_F2', '$FI_T1', 'image', 'backlog', 'Shared/OldFolder/b.tif', 'dismissed'),
  ('$FI_F3', '$FI_T1', 'image', 'new', 'Shared/OldFolder/c.tif', 'gone');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_team_id, kind, origin, rel_path, state, link_kind, linked_collection, linked_junction_id, link_batch_id)
  VALUES ('a2000000-0000-4000-8000-0000000000c4', '$FI_T1', 'image', 'new', 'Shared/OldFolder/d.tif', 'linked', 'bulk', 'test_sessions', gen_random_uuid(), gen_random_uuid());
INSERT INTO d1_private.file_candidates (directus_files_id, owner_team_id, kind, origin, rel_path, state) VALUES
  ('a2000000-0000-4000-8000-0000000000c5', 'a2000000-0000-4000-8000-0000000000b2', 'image', 'new', 'Shared/OtherFolder/e.tif', 'new');"
fi_out=$(fi_sql "$fi_seed_team
UPDATE teams SET share_folder = 'NewFolder' WHERE team_id = '$FI_T1';
SELECT 'fi_team_chg_dirs:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_team_id = '$FI_T1') || ':' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_team_id = 'a2000000-0000-4000-8000-0000000000b2');
SELECT 'fi_team_chg_cands:' || coalesce(string_agg(state || '@' || (owner_team_id = '$FI_T1')::text, ',' ORDER BY state, owner_team_id), '') FROM d1_private.file_candidates;")
grep -q 'fi_team_chg_dirs:0:1' <<<"$fi_out" && ok "changing a share_folder deletes the old owner team's folder cache rows and no other team's" || bad "share folder change did not clear the folder cache (output: $fi_out)"
grep -q 'fi_team_chg_cands:linked@true,new@false' <<<"$fi_out" && ok "changing a share_folder deletes the team's new, gone and dismissed candidates; the linked one and other teams' stay" || bad "share folder change left or removed the wrong candidates (output: $fi_out)"
fi_out=$(fi_sql "$fi_seed_team
UPDATE teams SET share_folder = 'OldFolder', description = 'touched' WHERE team_id = '$FI_T1';
SELECT 'fi_team_same:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_team_id = '$FI_T1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_team_id = '$FI_T1');")
grep -q 'fi_team_same:2:4' <<<"$fi_out" && ok "an UPDATE that leaves the share_folder as it was deletes nothing" || bad "an unchanged share folder deleted rows (output: $fi_out)"
fi_out=$(fi_sql "$fi_seed_team
UPDATE teams SET share_folder = 'oldfolder' WHERE team_id = '$FI_T1';
SELECT 'fi_team_case:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_team_id = '$FI_T1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_team_id = '$FI_T1');
UPDATE teams SET share_folder = 'OldFolder2' WHERE team_id = '$FI_T1';
SELECT 'fi_team_real:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_team_id = '$FI_T1') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_team_id = '$FI_T1');
UPDATE teams SET share_folder = NULL WHERE team_id = 'a2000000-0000-4000-8000-0000000000b2';
SELECT 'fi_team_to_null:' || (SELECT count(*) FROM d1_private.inbox_dirs WHERE owner_team_id = 'a2000000-0000-4000-8000-0000000000b2') || ':' || (SELECT count(*) FROM d1_private.file_candidates WHERE owner_team_id = 'a2000000-0000-4000-8000-0000000000b2');
UPDATE teams SET share_folder = 'Back' WHERE team_id = 'a2000000-0000-4000-8000-0000000000b2';")
grep -q 'fi_team_case:2:4' <<<"$fi_out" && ok "changing only the letter case of a share_folder (OldFolder to oldfolder) wipes nothing" || bad "a case-only share folder change wiped rows (output: $fi_out)"
grep -q 'fi_team_real:0:1' <<<"$fi_out" && ok "a different share_folder after a case change still starts the folder over" || bad "a real share folder change after a case change did not wipe (output: $fi_out)"
grep -q 'fi_team_to_null:0:0' <<<"$fi_out" && ok "clearing a share_folder (value to NULL) still starts the folder over" || bad "value to NULL did not wipe a team (output: $fi_out)"
run_eq "the alias and folder triggers are AFTER UPDATE OF row triggers with a WHEN condition" \
    "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname IN ('people_inbox_alias_changed', 'teams_inbox_folder_changed') AND (tgtype & 1) = 1 AND (tgtype & 2) = 0 AND (tgtype & 16) = 16 AND tgqual IS NOT NULL" "people_inbox_alias_changed,teams_inbox_folder_changed"
# inbox_dirs
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id, dir_mtime, last_listed_at) VALUES ('Users/abc12de', '$FI_P1', now(), now());
INSERT INTO d1_private.inbox_dirs (rel_path, owner_team_id) VALUES ('Shared/Lab', '$FI_T1');
SELECT 'fi_dirs:' || count(*) || ':' || count(baselined_at) FROM d1_private.inbox_dirs;")
grep -q 'fi_dirs:2:0' <<<"$fi_out" && ok "folder cache rows insert for a person and for a team; baselined_at starts NULL" || bad "inbox_dirs insert failed (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id, owner_team_id) VALUES ('Users/x', '$FI_P1', '$FI_T1');")
grep -q 'check constraint' <<<"$fi_out" && ok "a folder row with both owners is rejected" || bad "inbox_dirs with two owners was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_dirs (rel_path) VALUES ('Users/x');")
grep -q 'check constraint' <<<"$fi_out" && ok "a folder row with no owner is rejected" || bad "inbox_dirs with no owner was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id) VALUES ('Users/x', '$FI_P1'), ('Users/x', '$FI_P2');")
grep -q 'duplicate key' <<<"$fi_out" && ok "rel_path is the primary key of the folder cache" || bad "duplicate rel_path was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id) VALUES ('Users/x', '$FI_P1');
INSERT INTO d1_private.inbox_dirs (rel_path, owner_team_id) VALUES ('Shared/y', '$FI_T1');
DELETE FROM people WHERE person_id = '$FI_P1';
SELECT 'fi_dirs_cascade:' || count(*) FROM d1_private.inbox_dirs;
DELETE FROM teams WHERE team_id = '$FI_T1';
SELECT 'fi_dirs_cascade_team:' || count(*) FROM d1_private.inbox_dirs;")
grep -q 'fi_dirs_cascade:1' <<<"$fi_out" && grep -q 'fi_dirs_cascade_team:0' <<<"$fi_out" && ok "folder rows go with their person and their team" || bad "inbox_dirs did not cascade (output: $fi_out)"
# inbox_scan_requests
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id, requested_by) VALUES ('person', '$FI_P1', '$FI_U1');
INSERT INTO d1_private.inbox_scan_requests (scope, requested_by) VALUES ('all', '$FI_U2');
SELECT 'fi_req:' || count(*) || ':' || count(*) FILTER (WHERE status = 'queued') || ':' || count(requested_at) || ':' || count(started_at) FROM d1_private.inbox_scan_requests;")
grep -q 'fi_req:2:2:2:0' <<<"$fi_out" && ok "scan requests insert as queued with requested_at set (person and all scope)" || bad "scan request defaults are wrong (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, requested_by) VALUES ('team', '$FI_U1');")
grep -q 'check constraint' <<<"$fi_out" && ok "an unknown scan request scope is rejected" || bad "bad scope was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, status, requested_by) VALUES ('all', 'cancelled', '$FI_U1');")
grep -q 'check constraint' <<<"$fi_out" && ok "an unknown scan request status is rejected" || bad "bad status was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, requested_by) VALUES ('person', '$FI_U1');")
grep -q 'check constraint' <<<"$fi_out" && ok "a person-scope request without a person is rejected" || bad "person scope without a person was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id, requested_by) VALUES ('all', '$FI_P1', '$FI_U1');")
grep -q 'check constraint' <<<"$fi_out" && ok "an all-scope request with a person is rejected" || bad "all scope with a person was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, status, requested_by) VALUES ('all', 'running', '$FI_U1'), ('all', 'done', '$FI_U1'), ('all', 'failed', '$FI_U1');
SELECT 'fi_req_status:' || count(*) FROM d1_private.inbox_scan_requests;")
grep -q 'fi_req_status:3' <<<"$fi_out" && ok "running, done and failed are accepted statuses" || bad "allowed statuses were refused (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id, requested_by) VALUES ('person', '$FI_P1', '$FI_U1');
DELETE FROM directus_users WHERE id = '$FI_U1';
SELECT 'fi_req_user:' || count(*) || ':' || count(requested_by) FROM d1_private.inbox_scan_requests;
DELETE FROM people WHERE person_id = '$FI_P1';
SELECT 'fi_req_person:' || count(*) FROM d1_private.inbox_scan_requests;")
grep -q 'fi_req_user:1:0' <<<"$fi_out" && grep -q 'fi_req_person:0' <<<"$fi_out" && ok "a request keeps its row when the user goes and goes with its person" || bad "scan request foreign keys did not behave (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id, requested_by) VALUES ('person', '$FI_P1', '$FI_U1');
INSERT INTO d1_private.inbox_scan_requests (scope, person_id, requested_by) VALUES ('person', '$FI_P1', '$FI_U1');")
grep -q 'inbox_scan_requests_one_open_per_person_key' <<<"$fi_out" && ok "a second queued request for the same person is refused (one open request per person)" || bad "second queued request was not refused (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id, status) VALUES ('person', '$FI_P1', 'running');
INSERT INTO d1_private.inbox_scan_requests (scope, person_id) VALUES ('person', '$FI_P1');")
grep -q 'inbox_scan_requests_one_open_per_person_key' <<<"$fi_out" && ok "a queued request is refused while the person's earlier one is running" || bad "queued request next to a running one was not refused (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id) VALUES ('person', '$FI_P1');
UPDATE d1_private.inbox_scan_requests SET status = 'done', finished_at = now() WHERE person_id = '$FI_P1';
INSERT INTO d1_private.inbox_scan_requests (scope, person_id) VALUES ('person', '$FI_P1');
UPDATE d1_private.inbox_scan_requests SET status = 'failed' WHERE person_id = '$FI_P1' AND status = 'queued';
INSERT INTO d1_private.inbox_scan_requests (scope, person_id) VALUES ('person', '$FI_P1');
SELECT 'fi_open_ok:' || count(*) || ':' || count(*) FILTER (WHERE status = 'queued') FROM d1_private.inbox_scan_requests WHERE person_id = '$FI_P1';")
grep -q 'fi_open_ok:3:1' <<<"$fi_out" && ok "once the first request is done (or failed) the person can queue another" || bad "new request after a finished one failed (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_scan_requests (scope, person_id) VALUES ('person', '$FI_P1'), ('person', '$FI_P2');
INSERT INTO d1_private.inbox_scan_requests (scope) VALUES ('all'), ('all');
SELECT 'fi_open_many:' || count(*) FROM d1_private.inbox_scan_requests;")
grep -q 'fi_open_many:4' <<<"$fi_out" && ok "different people each have one open request, and scan-all requests are not limited by it" || bad "open-request index was too strict (output: $fi_out)"
run_eq "the user foreign keys are indexed, partial on NOT NULL (file_candidates.decided_by, inbox_scan_requests.requested_by)" \
    "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'd1_private' AND ((indexname = 'idx_file_candidates_decided_by' AND indexdef LIKE '%(decided_by) WHERE (decided_by IS NOT NULL)') OR (indexname = 'idx_inbox_scan_requests_requested_by' AND indexdef LIKE '%(requested_by) WHERE (requested_by IS NOT NULL)'))" \
    "idx_file_candidates_decided_by,idx_inbox_scan_requests_requested_by"
run_eq "scan requests have an index for claiming queued rows and one for the per-person rate limit" \
    "SELECT count(*) FROM pg_indexes WHERE schemaname = 'd1_private' AND tablename = 'inbox_scan_requests' AND (indexdef LIKE '%(status, requested_at)%' OR indexdef LIKE '%(person_id, requested_at%')" "2"
# inbox_crawler_state (singleton)
run_eq "inbox_crawler_state is seeded with exactly one row" "SELECT count(*) FROM d1_private.inbox_crawler_state" "1"
run_eq "the seeded state row has the defaults (running, interval 30 minutes, 60 MB/s, zero counters, no unmatched folders, never heartbeated)" \
    "SELECT desired_state || ':' || interval_minutes || ':' || read_mb_per_s::int || ':' || files_registered || ':' || error_count || ':' || unmatched_folders || ':' || (last_heartbeat_at IS NULL) FROM d1_private.inbox_crawler_state" "running:30:60:0:0:[]:true"
run_eq "the column defaults themselves are desired_state 'running', interval 30, read rate 60 (not just the seeded row)" \
    "SELECT string_agg(column_name || '=' || column_default, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'inbox_crawler_state' AND column_name IN ('desired_state', 'interval_minutes', 'read_mb_per_s')" "desired_state='running'::text,interval_minutes=30,read_mb_per_s=60"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_crawler_state (id) VALUES ('a2000000-0000-4000-8000-0000000000ee');")
grep -q 'check constraint' <<<"$fi_out" && ok "a second inbox_crawler_state row with another id is rejected (singleton check)" || bad "second state row was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_crawler_state (id) VALUES ('00000000-0000-0000-0000-000000000001');")
grep -q 'duplicate key' <<<"$fi_out" && ok "a second inbox_crawler_state row with the singleton id is rejected (primary key)" || bad "duplicate singleton row was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE d1_private.inbox_crawler_state SET desired_state = 'stopped';")
grep -q 'check constraint' <<<"$fi_out" && ok "desired_state other than running / paused is rejected" || bad "bad desired_state was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE d1_private.inbox_crawler_state SET interval_minutes = 0;")
grep -q 'check constraint' <<<"$fi_out" && ok "an interval of 0 minutes is rejected" || bad "interval 0 was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE d1_private.inbox_crawler_state SET read_mb_per_s = 0;")
grep -q 'check constraint' <<<"$fi_out" && ok "a read throttle of 0 MB/s is rejected" || bad "read_mb_per_s 0 was not rejected (output: $fi_out)"
fi_out=$(fi_sql "UPDATE d1_private.inbox_crawler_state SET desired_state = 'paused', interval_minutes = 5, read_mb_per_s = 12.5, unmatched_folders = '[\"Users/zz\"]', last_heartbeat_at = now(), files_registered = 40, error_count = 2, last_error = 'x';
SELECT 'fi_state_upd:' || desired_state || ':' || interval_minutes || ':' || unmatched_folders FROM d1_private.inbox_crawler_state;")
grep -q 'fi_state_upd:paused:5:\["Users/zz"\]' <<<"$fi_out" && ok "the state row takes the admin settings and the daemon's status" || bad "state row update failed (output: $fi_out)"
fi_out=$(fi_sql "UPDATE d1_private.inbox_crawler_state SET unmatched_folders = '{}';")
grep -q 'check constraint' <<<"$fi_out" && ok "unmatched_folders must be a JSON array" || bad "non-array unmatched_folders was not rejected (output: $fi_out)"
# inbox_prefs (the auto-link opt-in; migration 170's user_prefs.prefs is validated by the d1-usage endpoint and owned by it)
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_prefs (user_id) VALUES ('$FI_U1');
SELECT 'fi_prefs:' || auto_link || ':' || (updated_at IS NOT NULL) FROM d1_private.inbox_prefs;")
grep -q 'fi_prefs:false:true' <<<"$fi_out" && ok "auto-link is off by default" || bad "inbox_prefs default is wrong (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_prefs (user_id) VALUES ('$FI_U1'), ('$FI_U1');")
grep -q 'duplicate key' <<<"$fi_out" && ok "one inbox_prefs row per user" || bad "second prefs row was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_prefs (user_id) VALUES ('a2000000-0000-4000-8000-0000000000ff');")
grep -q 'foreign key' <<<"$fi_out" && ok "prefs for a user that does not exist are rejected" || bad "prefs without a user were not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.inbox_prefs (user_id, auto_link) VALUES ('$FI_U1', true), ('$FI_U2', false);
DELETE FROM directus_users WHERE id = '$FI_U1';
SELECT 'fi_prefs_cascade:' || count(*) FROM d1_private.inbox_prefs;")
grep -q 'fi_prefs_cascade:1' <<<"$fi_out" && ok "deleting a user removes their inbox prefs, and only theirs" || bad "inbox prefs did not follow their user (output: $fi_out)"
# Comments on every new table, column and index, and on the new people and teams columns.
run_eq "every new table, column and index has a comment (without: none)" \
    "SELECT coalesce(string_agg(x, ', ' ORDER BY x), '') FROM (
        SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname IN ($fi_new_tables) AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname IN ($fi_new_tables) AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
           AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
        UNION ALL
        SELECT i.indexname FROM pg_indexes i JOIN pg_class ic ON ic.relname = i.indexname AND ic.relnamespace = to_regnamespace(i.schemaname)
         WHERE i.schemaname = 'd1_private' AND i.tablename IN ($fi_new_tables) AND coalesce(obj_description(ic.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT 'people.' || a.attname FROM pg_attribute a
         WHERE a.attrelid = 'public.people'::regclass AND a.attname IN ('uni_alias', 'scan_while_former') AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
        UNION ALL
        SELECT 'teams.' || a.attname FROM pg_attribute a
         WHERE a.attrelid = 'public.teams'::regclass AND a.attname = 'share_folder' AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
        UNION ALL
        SELECT i.indexname FROM pg_indexes i JOIN pg_class ic ON ic.relname = i.indexname AND ic.relnamespace = to_regnamespace(i.schemaname)
         WHERE i.schemaname = 'public' AND i.indexname IN ('people_uni_alias_key', 'teams_share_folder_key') AND coalesce(obj_description(ic.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT 'missing index ' || n FROM unnest(ARRAY['people_uni_alias_key', 'teams_share_folder_key']) AS n WHERE to_regclass('public.' || n) IS NULL) q" ""
# Down and up again, inside one rolled-back transaction: down removes everything (the alias and folder columns with their data),
# up brings it all back, including the seeded singleton row.
if [[ -n "$FI_MIG" && -f "$FI_MIG" ]]; then
    fi_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$FI_MIG")
    fi_down=$(awk '/-- migrate:down/{f=1;next}f' "$FI_MIG")
    fi_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('$FI_P1', 'Inbox Test One');
UPDATE people SET uni_alias = 'abc12de', scan_while_former = true WHERE person_id = '$FI_P1';
INSERT INTO teams (team_id, name, share_folder) VALUES ('$FI_T1', 'Inbox Test Team', 'Alloy Group');
INSERT INTO directus_files (id) VALUES ('$FI_F1');
INSERT INTO directus_users (id) VALUES ('$FI_U1');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path) VALUES ('$FI_F1', '$FI_P1', 'image', 'new', 'a.tif');
INSERT INTO d1_private.inbox_prefs (user_id, auto_link) VALUES ('$FI_U1', true);
-- migration 198's table references file_candidates; its own down runs first in a real rollback
DROP TABLE IF EXISTS d1_private.file_thumbnails;
$fi_down
SELECT 'fi_dn_tables:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relname IN ($fi_new_tables);
SELECT 'fi_dn_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'people' AND column_name IN ('uni_alias', 'scan_while_former')) OR (table_name = 'teams' AND column_name = 'share_folder'));
SELECT 'fi_dn_indexes:' || count(*) FROM pg_indexes WHERE indexname IN ('people_uni_alias_key', 'teams_share_folder_key');
SELECT 'fi_dn_triggers:' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('people_inbox_columns_insert', 'people_inbox_alias_changed', 'teams_inbox_folder_changed')) || ',' || (SELECT count(*) FROM pg_proc WHERE proname IN ('people_inbox_columns_insert_guard', 'inbox_person_alias_changed', 'inbox_team_folder_changed'));
SELECT 'fi_dn_people:' || count(*) FROM people WHERE person_id = '$FI_P1';
SELECT 'fi_dn_files:' || count(*) FROM directus_files WHERE id = '$FI_F1';
$fi_up
SELECT 'fi_up_tables:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relkind = 'r' AND c.relname IN ($fi_new_tables);
SELECT 'fi_up_columns:' || count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'people' AND column_name IN ('uni_alias', 'scan_while_former')) OR (table_name = 'teams' AND column_name = 'share_folder'));
SELECT 'fi_up_triggers:' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('people_inbox_columns_insert', 'people_inbox_alias_changed', 'teams_inbox_folder_changed')) || ',' || (SELECT count(*) FROM pg_proc WHERE proname IN ('people_inbox_columns_insert_guard', 'inbox_person_alias_changed', 'inbox_team_folder_changed'));
SELECT 'fi_up_state:' || count(*) FROM d1_private.inbox_crawler_state;
SELECT 'fi_up_alias:' || coalesce(uni_alias, '<null>') || ':' || scan_while_former FROM people WHERE person_id = '$FI_P1';
ROLLBACK;
SQL
)
    grep -q 'fi_dn_tables:0' <<<"$fi_out" && grep -q 'fi_dn_columns:0' <<<"$fi_out" && grep -q 'fi_dn_indexes:0' <<<"$fi_out" && ok "down drops the five tables, the three columns and both unique indexes" || bad "down left objects behind (output: $fi_out)"
    grep -q 'fi_dn_triggers:0,0' <<<"$fi_out" && grep -q 'fi_up_triggers:3,3' <<<"$fi_out" && ok "down drops the three trigger functions and triggers; up brings them back" || bad "triggers did not round-trip (output: $fi_out)"
    grep -q 'fi_dn_people:1' <<<"$fi_out" && grep -q 'fi_dn_files:1' <<<"$fi_out" && ok "down keeps the people and files rows (only the new columns and tables go)" || bad "down removed people or files rows (output: $fi_out)"
    grep -q 'fi_up_tables:5' <<<"$fi_out" && grep -q 'fi_up_columns:3' <<<"$fi_out" && grep -q 'fi_up_state:1' <<<"$fi_out" && grep -q 'fi_up_alias:<null>:false' <<<"$fi_out" && ok "up again restores the five tables, the three columns and the seeded state row (alias data is not kept: lossy by design)" || bad "up after down failed (output: $fi_out)"
fi

echo "== Inbox thumbnails: d1_private.file_thumbnails =="
# Spec section 14 of the found files inbox design; plan docs/superpowers/plans/2026-10-16-inbox-thumbnails.md. Same fixture helper as above (fi_sql).
FT_MIG=$(migration file_thumbnails)
[[ -n "$FT_MIG" && -f "$FT_MIG" ]] && ok "found the file thumbnails migration (${FT_MIG:-none})" || bad "the file thumbnails migration is missing (db/migrations/*_file_thumbnails.sql)"
FT_CAND="INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path) VALUES ('$FI_F1', '$FI_P1', 'sem_image', 'new', 'a.tif');"
FT_ROW="INSERT INTO d1_private.file_thumbnails (candidate_id, thumb, preview, source_size, source_mtime) SELECT candidate_id, '\\xffd8ffe0'::bytea, '\\xffd8ffe0aabbcc'::bytea, 1234, '2026-10-10T09:00:00Z' FROM d1_private.file_candidates WHERE directus_files_id = '$FI_F1';"
run_eq "file_thumbnails is a d1_private table, in no Directus-facing place (public, v_schema_dictionary, directus_collections, directus_fields)" \
    "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'd1_private' AND tablename = 'file_thumbnails') || ',' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'file_thumbnails') || ',' || (SELECT count(*) FROM v_schema_dictionary WHERE object_name = 'file_thumbnails') || ',' || (SELECT count(*) FROM directus_collections WHERE collection = 'file_thumbnails') || ',' || (SELECT count(*) FROM directus_fields WHERE collection = 'file_thumbnails')" "1,0,0,0,0"
run_eq "d1_llm_readonly cannot read the thumbnails" \
    "SELECT has_table_privilege('d1_llm_readonly', 'd1_private.file_thumbnails', 'SELECT')" "f"
run_eq "file_thumbnails columns and types match the contract" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'file_thumbnails'" \
    "candidate_id:uuid:NO,thumb:bytea:YES,preview:bytea:YES,thumb_width:integer:YES,thumb_height:integer:YES,preview_width:integer:YES,preview_height:integer:YES,source_size:bigint:NO,source_mtime:timestamp with time zone:NO,failed_reason:text:YES,created_at:timestamp with time zone:NO"
run_eq "the key and the foreign key have the repo's names, and the foreign key cascades from file_candidates" \
    "SELECT string_agg(conname || ':' || contype::text || ':' || coalesce(confrelid::regclass::text, '-') || ':' || coalesce(nullif(confdeltype::text, ' '), '-'), ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'd1_private.file_thumbnails'::regclass AND contype IN ('p', 'f')" \
    "file_thumbnails_candidate_id_fkey:f:d1_private.file_candidates:c,file_thumbnails_pkey:p:-:-"
fi_out=$(fi_sql "$FT_CAND
$FT_ROW
SELECT 'ft_row:' || octet_length(thumb) || ':' || octet_length(preview) || ':' || source_size || ':' || (created_at IS NOT NULL) || ':' || (thumb_width IS NULL) FROM d1_private.file_thumbnails;")
grep -q 'ft_row:4:7:1234:true:true' <<<"$fi_out" && ok "a picture pair stores the bytes as written, with created_at defaulted and the sizes optional" || bad "a thumbnail row did not store as written (output: $fi_out)"
fi_out=$(fi_sql "$FT_CAND
$FT_ROW
$FT_ROW")
grep -q 'file_thumbnails_pkey' <<<"$fi_out" && ok "a candidate has at most one picture pair" || bad "a second picture pair for one candidate was not rejected (output: $fi_out)"
fi_out=$(fi_sql "INSERT INTO d1_private.file_thumbnails (candidate_id, thumb, preview, source_size, source_mtime) VALUES (gen_random_uuid(), '\\x00', '\\x00', 1, now());")
grep -q 'file_thumbnails_candidate_id_fkey' <<<"$fi_out" && ok "pictures for an unknown candidate are rejected (foreign key)" || bad "a picture for a candidate that does not exist was not rejected (output: $fi_out)"
for ft_col in source_size source_mtime; do
    fi_out=$(fi_sql "$FT_CAND
INSERT INTO d1_private.file_thumbnails (candidate_id, thumb, preview, source_size, source_mtime) SELECT candidate_id, '\\x00', '\\x00', 1, now() FROM d1_private.file_candidates;
UPDATE d1_private.file_thumbnails SET $ft_col = NULL;")
    grep -q "null value in column \"$ft_col\"" <<<"$fi_out" && ok "file_thumbnails.$ft_col cannot be NULL" || bad "file_thumbnails.$ft_col accepted NULL (output: $fi_out)"
done
# a picture pair or a failure marker, never a mixture (file_thumbnails_pictures_or_failure_check)
FT_MARK="INSERT INTO d1_private.file_thumbnails (candidate_id, source_size, source_mtime, failed_reason) SELECT candidate_id, 1234, '2026-10-10T09:00:00Z', 'could not be decoded' FROM d1_private.file_candidates WHERE directus_files_id = '$FI_F1';"
fi_out=$(fi_sql "$FT_CAND
$FT_MARK
SELECT 'ft_marker:' || (thumb IS NULL) || ':' || (preview IS NULL) || ':' || failed_reason FROM d1_private.file_thumbnails;")
grep -q 'ft_marker:true:true:could not be decoded' <<<"$fi_out" && ok "a failure marker (both pictures NULL, failed_reason set) is accepted" || bad "a failure marker was not accepted (output: $fi_out)"
for ft_case in \
    "thumb = NULL|only the thumbnail missing" \
    "preview = NULL|only the preview missing" \
    "failed_reason = 'x'|pictures and a failure reason together"; do
    fi_out=$(fi_sql "$FT_CAND
$FT_ROW
UPDATE d1_private.file_thumbnails SET ${ft_case%%|*};")
    grep -q 'file_thumbnails_pictures_or_failure_check' <<<"$fi_out" && ok "a row with ${ft_case##*|} is rejected" || bad "a row with ${ft_case##*|} was accepted (output: $fi_out)"
done
fi_out=$(fi_sql "$FT_CAND
$FT_MARK
UPDATE d1_private.file_thumbnails SET failed_reason = NULL;")
grep -q 'file_thumbnails_pictures_or_failure_check' <<<"$fi_out" && ok "a marker without a reason (neither pictures nor failed_reason) is rejected" || bad "a row with no pictures and no reason was accepted (output: $fi_out)"
for ft_col in thumb_width thumb_height preview_width preview_height; do
    fi_out=$(fi_sql "$FT_CAND
$FT_ROW
UPDATE d1_private.file_thumbnails SET $ft_col = 0;")
    grep -q "file_thumbnails_${ft_col}_check" <<<"$fi_out" && ok "file_thumbnails.$ft_col must be positive when set" || bad "file_thumbnails.$ft_col accepted 0 (output: $fi_out)"
done
fi_out=$(fi_sql "$FT_CAND
$FT_ROW
UPDATE d1_private.file_thumbnails SET source_size = -1;")
grep -q 'file_thumbnails_source_size_check' <<<"$fi_out" && ok "file_thumbnails.source_size cannot be negative" || bad "a negative source_size was accepted (output: $fi_out)"
fi_out=$(fi_sql "$FT_CAND
$FT_ROW
DELETE FROM d1_private.file_candidates WHERE directus_files_id = '$FI_F1';
SELECT 'ft_cascade_candidate:' || count(*) FROM d1_private.file_thumbnails;")
grep -q 'ft_cascade_candidate:0' <<<"$fi_out" && ok "deleting a candidate deletes its pictures" || bad "pictures outlived their candidate (output: $fi_out)"
fi_out=$(fi_sql "$FT_CAND
$FT_ROW
DELETE FROM directus_files WHERE id = '$FI_F1';
SELECT 'ft_cascade_file:' || (SELECT count(*) FROM d1_private.file_candidates) || ':' || (SELECT count(*) FROM d1_private.file_thumbnails);")
grep -q 'ft_cascade_file:0:0' <<<"$fi_out" && ok "deleting the file row removes its candidate and the pictures with it" || bad "pictures outlived their file (output: $fi_out)"
run_eq "the table, every column and the key and foreign key have a comment (without: none)" \
    "SELECT coalesce(string_agg(x, ', ' ORDER BY x), '') FROM (
        SELECT c.relname AS x FROM pg_class c WHERE c.oid = 'd1_private.file_thumbnails'::regclass AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT a.attname FROM pg_attribute a WHERE a.attrelid = 'd1_private.file_thumbnails'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
        UNION ALL
        SELECT conname FROM pg_constraint WHERE conrelid = 'd1_private.file_thumbnails'::regclass AND contype IN ('p', 'f') AND coalesce(obj_description(oid, 'pg_constraint'), '') = '') q" ""
run_eq "the pictures-or-failure check has a comment" \
    "SELECT (coalesce(obj_description(oid, 'pg_constraint'), '') <> '')::text FROM pg_constraint WHERE conrelid = 'd1_private.file_thumbnails'::regclass AND conname = 'file_thumbnails_pictures_or_failure_check'" "true"
# Down and up again, inside one rolled-back transaction: down drops the table (the candidate stays), up brings it back empty.
if [[ -n "$FT_MIG" && -f "$FT_MIG" ]]; then
    ft_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$FT_MIG")
    ft_down=$(awk '/-- migrate:down/{f=1;next}f' "$FT_MIG")
    fi_out=$(fi_sql "$FT_CAND
$FT_ROW
$ft_down
SELECT 'ft_dn_table:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relname = 'file_thumbnails';
SELECT 'ft_dn_candidates:' || count(*) FROM d1_private.file_candidates;
$ft_up
SELECT 'ft_up_table:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relkind = 'r' AND c.relname = 'file_thumbnails';
SELECT 'ft_up_rows:' || count(*) FROM d1_private.file_thumbnails;
SELECT 'ft_up_check:' || count(*) || ':' || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'file_thumbnails' AND column_name = 'failed_reason') FROM pg_constraint WHERE conrelid = 'd1_private.file_thumbnails'::regclass AND conname = 'file_thumbnails_pictures_or_failure_check';
INSERT INTO d1_private.file_thumbnails (candidate_id, source_size, source_mtime, failed_reason) SELECT candidate_id, 1, now(), 'x' FROM d1_private.file_candidates;
SELECT 'ft_up_marker:' || count(*) FROM d1_private.file_thumbnails WHERE thumb IS NULL;")
    grep -q 'ft_dn_table:0' <<<"$fi_out" && grep -q 'ft_dn_candidates:1' <<<"$fi_out" && ok "down drops the thumbnails table and keeps the candidates" || bad "down left the table or removed candidates (output: $fi_out)"
    grep -q 'ft_up_table:1' <<<"$fi_out" && grep -q 'ft_up_rows:0' <<<"$fi_out" && grep -q 'ft_up_check:1:1' <<<"$fi_out" && grep -q 'ft_up_marker:1' <<<"$fi_out" && ok "up again restores the table, empty, with failed_reason and the pictures-or-failure check (the pictures are made again from the share)" || bad "up after down failed (output: $fi_out)"
fi

echo "== Ignored folders: d1_private.inbox_ignored_dirs =="
# Spec section 15 of the found files inbox design; migration 199. Each check is its own rolled-back transaction (ids as in the section above).
IG_MIG=$(migration inbox_ignored_dirs)
[[ -n "$IG_MIG" && -f "$IG_MIG" ]] && ok "found the ignored folders migration (${IG_MIG:-none})" || bad "the ignored folders migration is missing (db/migrations/*_inbox_ignored_dirs.sql)"
ig_sql() { # ig_sql <statements>: run them after fixture people, a team and users, in a transaction that is rolled back
    $PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('$FI_P1', 'Inbox Test One'), ('$FI_P2', 'Inbox Test Two');
INSERT INTO teams (team_id, name) VALUES ('$FI_T1', 'Inbox Test Team');
INSERT INTO directus_users (id) VALUES ('$FI_U1'), ('$FI_U2');
$1
ROLLBACK;
SQL
}
run_eq "inbox_ignored_dirs is in d1_private and nowhere in public" \
    "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relkind = 'r' AND c.relname = 'inbox_ignored_dirs') || ',' || (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'inbox_ignored_dirs')" "1,0"
run_eq "it is not exposed in Directus (v_schema_dictionary, directus_collections, directus_fields)" \
    "SELECT (SELECT count(*) FROM v_schema_dictionary WHERE object_name = 'inbox_ignored_dirs') || ',' || (SELECT count(*) FROM directus_collections WHERE collection = 'inbox_ignored_dirs') || ',' || (SELECT count(*) FROM directus_fields WHERE collection = 'inbox_ignored_dirs')" "0,0,0"
run_eq "d1_llm_readonly cannot read it" "SELECT has_table_privilege('d1_llm_readonly', 'd1_private.inbox_ignored_dirs', 'SELECT')" "f"
run_eq "the columns are the contract's (ignored_id uuid PK default, two nullable owners, rel_folder NOT NULL, created_at NOT NULL default now(), created_by nullable)" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || (column_default IS NOT NULL), ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'd1_private' AND table_name = 'inbox_ignored_dirs'" \
    "created_at:timestamp with time zone:NO:true,created_by:uuid:YES:false,ignored_id:uuid:NO:true,owner_person_id:uuid:YES:false,owner_team_id:uuid:YES:false,rel_folder:text:NO:false"
run_eq "the constraints are named {table}_{description}_{type}" \
    "SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'd1_private.inbox_ignored_dirs'::regclass" \
    "inbox_ignored_dirs_created_by_fkey,inbox_ignored_dirs_one_owner_check,inbox_ignored_dirs_owner_person_id_fkey,inbox_ignored_dirs_owner_team_id_fkey,inbox_ignored_dirs_pkey,inbox_ignored_dirs_rel_folder_form_check,inbox_ignored_dirs_rel_folder_parts_check"
run_eq "the foreign keys delete as inbox_dirs' do: owners CASCADE, created_by SET NULL" \
    "SELECT string_agg(conname || '=' || confdeltype::text, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'd1_private.inbox_ignored_dirs'::regclass AND contype = 'f'" \
    "inbox_ignored_dirs_created_by_fkey=n,inbox_ignored_dirs_owner_person_id_fkey=c,inbox_ignored_dirs_owner_team_id_fkey=c"
run_eq "inbox_ignored_dirs_owner_folder_key is unique on (coalesce(owner_person_id, owner_team_id), lower(rel_folder))" \
    "SELECT (indexdef LIKE 'CREATE UNIQUE INDEX inbox_ignored_dirs_owner_folder_key ON d1_private.inbox_ignored_dirs USING btree (COALESCE(owner_person_id, owner_team_id), lower(rel_folder))') FROM pg_indexes WHERE schemaname = 'd1_private' AND indexname = 'inbox_ignored_dirs_owner_folder_key'" "t"
run_eq "the owner and user foreign keys are indexed, partial on NOT NULL" \
    "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'd1_private' AND tablename = 'inbox_ignored_dirs' AND ((indexname = 'idx_inbox_ignored_dirs_owner_person' AND indexdef LIKE '%(owner_person_id) WHERE (owner_person_id IS NOT NULL)') OR (indexname = 'idx_inbox_ignored_dirs_owner_team' AND indexdef LIKE '%(owner_team_id) WHERE (owner_team_id IS NOT NULL)') OR (indexname = 'idx_inbox_ignored_dirs_created_by' AND indexdef LIKE '%(created_by) WHERE (created_by IS NOT NULL)'))" \
    "idx_inbox_ignored_dirs_created_by,idx_inbox_ignored_dirs_owner_person,idx_inbox_ignored_dirs_owner_team"
run_eq "the table has no audit or OCC trigger (derived bookkeeping, like the other d1_private inbox tables)" \
    "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'd1_private.inbox_ignored_dirs'::regclass AND NOT tgisinternal" "0"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder, created_by) VALUES ('$FI_P1', 'World-Ti Paper/Drafts', '$FI_U1');
INSERT INTO d1_private.inbox_ignored_dirs (owner_team_id, rel_folder) VALUES ('$FI_T1', 'Old runs');
SELECT 'ig_rows:' || count(*) || ':' || count(ignored_id) || ':' || count(created_at) || ':' || count(created_by) FROM d1_private.inbox_ignored_dirs;")
grep -q 'ig_rows:2:2:2:1' <<<"$fi_out" && ok "a person rule and a team rule insert, with a generated id and time; created_by is optional" || bad "rule inserts failed (output: $fi_out)"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, owner_team_id, rel_folder) VALUES ('$FI_P1', '$FI_T1', 'x');")
grep -q 'inbox_ignored_dirs_one_owner_check' <<<"$fi_out" && ok "a rule with both owners is rejected" || bad "a rule with two owners was not rejected (output: $fi_out)"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (rel_folder) VALUES ('x');")
grep -q 'inbox_ignored_dirs_one_owner_check' <<<"$fi_out" && ok "a rule with no owner is rejected" || bad "a rule with no owner was not rejected (output: $fi_out)"
for ig_bad in '' '/a' 'a/' '/' 'a//b' '.' '..' './a' 'a/.' 'a/./b' '../a' 'a/..' 'a/../b'; do
    fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$FI_P1', '$ig_bad');")
    grep -q 'inbox_ignored_dirs_rel_folder_\(form\|parts\)_check' <<<"$fi_out" && ok "the folder '$ig_bad' is rejected (leading or trailing slash, empty, . or .. part)" || bad "the folder '$ig_bad' was not rejected (output: $fi_out)"
done
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$FI_P1', 'World-Ti Paper'), ('$FI_P1', 'World-Ti Paper 2'), ('$FI_P1', 'a.b/..c/d.'), ('$FI_P1', 'a/b/c');
SELECT 'ig_ok:' || count(*) FROM d1_private.inbox_ignored_dirs;")
grep -q 'ig_ok:4' <<<"$fi_out" && ok "ordinary folders are accepted, also with dots inside a name and a sibling that shares a prefix" || bad "valid folders were rejected (output: $fi_out)"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$FI_P1', 'World-Ti Paper');
INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$FI_P1', 'WORLD-ti paper');")
grep -q 'inbox_ignored_dirs_owner_folder_key' <<<"$fi_out" && ok "the same folder twice for one owner is rejected, ignoring case" || bad "a duplicate rule was not rejected (output: $fi_out)"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_team_id, rel_folder) VALUES ('$FI_T1', 'Old runs');
INSERT INTO d1_private.inbox_ignored_dirs (owner_team_id, rel_folder) VALUES ('$FI_T1', 'OLD RUNS');")
grep -q 'inbox_ignored_dirs_owner_folder_key' <<<"$fi_out" && ok "the same folder twice for one team is rejected, ignoring case" || bad "a duplicate team rule was not rejected (output: $fi_out)"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$FI_P1', 'Shared'), ('$FI_P2', 'Shared');
INSERT INTO d1_private.inbox_ignored_dirs (owner_team_id, rel_folder) VALUES ('$FI_T1', 'Shared');
SELECT 'ig_owners:' || count(*) FROM d1_private.inbox_ignored_dirs;")
grep -q 'ig_owners:3' <<<"$fi_out" && ok "two people and a team may each ignore a folder of the same name" || bad "the same folder for different owners was rejected (output: $fi_out)"
fi_out=$(ig_sql "INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder, created_by) VALUES ('$FI_P1', 'a', '$FI_U1'), ('$FI_P2', 'a', '$FI_U2');
INSERT INTO d1_private.inbox_ignored_dirs (owner_team_id, rel_folder) VALUES ('$FI_T1', 'b');
DELETE FROM directus_users WHERE id = '$FI_U1';
SELECT 'ig_user:' || count(*) || ':' || count(created_by) FROM d1_private.inbox_ignored_dirs;
DELETE FROM people WHERE person_id = '$FI_P1';
SELECT 'ig_person:' || count(*) FROM d1_private.inbox_ignored_dirs;
DELETE FROM teams WHERE team_id = '$FI_T1';
SELECT 'ig_team:' || count(*) FROM d1_private.inbox_ignored_dirs;")
grep -q 'ig_user:3:1' <<<"$fi_out" && grep -q 'ig_person:2' <<<"$fi_out" && grep -q 'ig_team:1' <<<"$fi_out" && ok "deleting a user keeps their rules (created_by becomes NULL); deleting a person or a team deletes their rules, and only theirs" || bad "foreign key actions are wrong (output: $fi_out)"
run_eq "every column, index and the table of inbox_ignored_dirs has a comment (without: none)" \
    "SELECT coalesce(string_agg(x, ', ' ORDER BY x), '') FROM (
        SELECT c.relname AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname = 'inbox_ignored_dirs' AND coalesce(obj_description(c.oid, 'pg_class'), '') = ''
        UNION ALL
        SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'd1_private' AND c.relname = 'inbox_ignored_dirs' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
           AND coalesce(col_description(a.attrelid, a.attnum), '') = ''
        UNION ALL
        SELECT i.indexname FROM pg_indexes i JOIN pg_class ic ON ic.relname = i.indexname AND ic.relnamespace = to_regnamespace(i.schemaname)
         WHERE i.schemaname = 'd1_private' AND i.tablename = 'inbox_ignored_dirs' AND coalesce(obj_description(ic.oid, 'pg_class'), '') = '') q" ""
# Down and up again, inside one rolled-back transaction.
if [[ -n "$IG_MIG" && -f "$IG_MIG" ]]; then
    ig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$IG_MIG")
    ig_down=$(awk '/-- migrate:down/{f=1;next}f' "$IG_MIG")
    fi_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO people (person_id, full_name) VALUES ('$FI_P1', 'Inbox Test One');
INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$FI_P1', 'a/b');
$ig_down
SELECT 'ig_dn_table:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relname = 'inbox_ignored_dirs';
SELECT 'ig_dn_people:' || count(*) FROM people WHERE person_id = '$FI_P1';
$ig_up
SELECT 'ig_up_table:' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'd1_private' AND c.relkind = 'r' AND c.relname = 'inbox_ignored_dirs';
SELECT 'ig_up_rows:' || count(*) FROM d1_private.inbox_ignored_dirs;
ROLLBACK;
SQL
)
    grep -q 'ig_dn_table:0' <<<"$fi_out" && grep -q 'ig_dn_people:1' <<<"$fi_out" && ok "down drops the table and keeps the people" || bad "down left the table behind or removed people (output: $fi_out)"
    grep -q 'ig_up_table:1' <<<"$fi_out" && grep -q 'ig_up_rows:0' <<<"$fi_out" && ok "up again brings back an empty table (the rules are not kept: lossy by design)" || bad "up after down failed (output: $fi_out)"
fi

echo "== d1-inbox: the endpoint's own SQL, run against Postgres =="
# core/extensions/d1-inbox/sql_check.mjs prints a PREPARE for every statement the endpoint sends (SQL.* and the list, count and accept queries
# buildListQuery builds, ? turned into $n). They are prepared here in a rolled-back transaction, so a column or table the real schema lacks fails the
# build (the endpoint's node tests use a fake knex and cannot see that); then the summary, the list count and accept-all's selection run on seeded
# rows: an original and its copy, a copy of a gone original and of a linked one, a file already on its record, a surface scan, an ambiguous match;
# then a link, an undo, a dismiss, a restore and two rescan requests against the table's CHECKs and its unique index.
# Needs node (GitHub's runners have it; the docker schema-test image may not: then this block is skipped with a note).
if command -v node >/dev/null 2>&1; then
    IB_U=a1b00000-0000-4000-8000-000000000001
    IB_P=a1b00000-0000-4000-8000-000000000002
    IB_S=a1b00000-0000-4000-8000-000000000003
    IB_Q=a1b00000-0000-4000-8000-000000000008
    ib_prep=$(node core/extensions/d1-inbox/sql_check.mjs 2>&1)
    ib_n=$(grep -c '^PREPARE ' <<<"$ib_prep")
    ib_out=$($PSQL -v ON_ERROR_STOP=1 2>&1 <<SQL
BEGIN;
INSERT INTO directus_users (id) VALUES ('$IB_U');
INSERT INTO people (person_id, full_name, user_id) VALUES ('$IB_P', 'Inbox Person', '$IB_U');
INSERT INTO people (person_id, full_name) VALUES ('$IB_Q', 'Inbox Other Person');
UPDATE people SET uni_alias = 'ibx1' WHERE person_id = '$IB_P';
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('$IB_S', 'IBX-001');
INSERT INTO directus_files (id, filename_download) SELECT ('a1b00000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'f' || g || '.tif' FROM generate_series(1, 20) g;
CREATE TEMP TABLE ib_seed (n int, kind text, origin text, state text, strength text, with_suggestion boolean, matches int, dup int, rel text, who text DEFAULT 'p');
INSERT INTO ib_seed (n, kind, origin, state, strength, with_suggestion, matches, dup, rel) VALUES
  (1,  'image',        'new',     'new',    'short_id', true,  1, NULL, 'a'),
  (2,  'image',        'new',     'new',    'short_id', true,  1, 1,    'b'),
  (3,  'image',        'new',     'new',    'short_id', true,  1, NULL, 'c'),
  (4,  'image',        'backlog', 'new',    'short_id', true,  1, NULL, 'd'),
  (5,  'image',        'new',     'gone',   'none',     false, 0, NULL, 'e'),
  (6,  'image',        'new',     'new',    'short_id', true,  1, 5,    'f'),
  (7,  'surface_scan', 'new',     'new',    'short_id', true,  1, NULL, 'g'),
  (8,  'image',        'new',     'new',    'short_id', false, 2, NULL, 'h'),
  (9,  'image',        'new',     'linked', 'none',     false, 0, NULL, 'i'),
  (10, 'image',        'new',     'new',    'short_id', true,  1, 9,    'j');
INSERT INTO ib_seed (n, kind, origin, state, strength, with_suggestion, matches, dup, rel, who) VALUES
  (11, 'image',        'new',     'dismissed', 'none',  false, 0, NULL, 'k', 'q'),
  (12, 'image',        'new',     'new',    'none',     false, 0, 11,   'l', 'p'),
  (13, 'image',        'new',     'linked', 'none',     false, 0, NULL, 'm', 'q'),
  (14, 'image',        'new',     'new',    'none',     false, 0, 13,   'n', 'p'),
  (15, 'image',        'new',     'new',    'none',     false, 0, NULL, 'o', 'q'),
  (16, 'image',        'new',     'new',    'none',     false, 0, 15,   'p', 'p'),
  (17, 'image',        'new',     'dismissed', 'none',  false, 0, NULL, 'r', 'p'),
  (18, 'image',        'new',     'new',    'none',     false, 0, 17,   's', 'p'),
  (19, 'image',        'new',     'gone',   'none',     false, 0, NULL, 't', 'q'),
  (20, 'image',        'new',     'new',    'none',     false, 0, 19,   'u', 'p');
-- a: an original in this inbox (counted, acceptable)         b: its copy (listed, not counted, not acceptable)
-- c: already on its record, see the junction row below (not counted, not acceptable)                  d: older, exact match (counted as older, acceptable)
-- e: a gone original   f: a copy of it (counted)             g: a surface scan (counted, never acceptable)   h: two records named (counted, never acceptable)
-- i: a linked original j: a copy of it (not counted, hidden from the list)
-- Copies across inboxes (owner q is another person; the originals k, m, o, t are q's, r is this person's own):
-- k: q dismissed it   l: a copy of it here (listed AND counted: another person dismissing a file must not hide yours)
-- m: q linked it      n: a copy of it here (hidden, not counted)       o: q's, still undecided   p: its copy here (listed, not counted)
-- r: this person dismissed it   s: its copy here (hidden, not counted: the same owner)   t: q's, gone   u: its copy here (listed and counted)
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, state, match_strength, suggested_collection, suggested_record_id, matches, rel_path,
                                        link_kind, linked_collection, linked_junction_id, link_batch_id)
SELECT ('a1b00000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, CASE WHEN who = 'q' THEN '$IB_Q'::uuid ELSE '$IB_P'::uuid END, kind, origin, state, strength,
       CASE WHEN with_suggestion THEN 'physical_samples' END, CASE WHEN with_suggestion THEN '$IB_S'::uuid END,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('collection', 'physical_samples', 'record_id', '$IB_S', 'via', 'short_id', 'token', 'abcd123' || i)), '[]'::jsonb) FROM generate_series(1, matches) i),
       'Users/ibx1/' || rel || '.tif',
       CASE WHEN state = 'linked' THEN 'manual' END, CASE WHEN state = 'linked' THEN 'physical_samples' END,
       CASE WHEN state = 'linked' THEN gen_random_uuid() END, CASE WHEN state = 'linked' THEN gen_random_uuid() END
  FROM ib_seed ORDER BY n;
UPDATE d1_private.file_candidates c SET duplicate_of = o.candidate_id
  FROM ib_seed s JOIN ib_seed t ON t.n = s.dup JOIN d1_private.file_candidates o ON o.rel_path = 'Users/ibx1/' || t.rel || '.tif'
 WHERE c.rel_path = 'Users/ibx1/' || s.rel || '.tif' AND s.dup IS NOT NULL;
INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES ('$IB_S', 'a1b00000-0000-4000-8000-000000000103');
$ib_prep
SELECT 'ib_prepared:' || count(*) FROM pg_prepared_statements WHERE name <> '';
CREATE TEMP TABLE ib_sm AS EXECUTE summary('$IB_P', '');
SELECT 'ib_summary_new:' || coalesce(sum(n) FILTER (WHERE origin = 'new'), 0) FROM ib_sm;
SELECT 'ib_summary_older_exact:' || coalesce(sum(n) FILTER (WHERE origin = 'backlog' AND exact), 0) FROM ib_sm;
CREATE TEMP TABLE ib_cnt AS EXECUTE count_new('$IB_P', '');
SELECT 'ib_list_new_total:' || total FROM ib_cnt;
CREATE TEMP TABLE ib_ls AS EXECUTE list_new('$IB_P', '', 50, 0);
SELECT 'ib_list_copies:' || coalesce(string_agg(regexp_replace(rel_path, '^.*/', '') || '=' || CASE WHEN duplicate_owner_person_id = '$IB_P' THEN 'me' WHEN duplicate_owner_person_id = '$IB_Q' THEN 'q' ELSE '-' END, ',' ORDER BY rel_path), '') FROM ib_ls WHERE duplicate_of IS NOT NULL;
CREATE TEMP TABLE ib_acc AS EXECUTE accept_open('$IB_P', '');
SELECT 'ib_accept:' || coalesce(string_agg(c.rel_path, ',' ORDER BY c.rel_path), '') FROM d1_private.file_candidates c WHERE c.candidate_id IN (SELECT candidate_id FROM ib_acc);
SELECT candidate_id AS ib_a FROM d1_private.file_candidates WHERE rel_path = 'Users/ibx1/a.tif' \gset
SELECT gen_random_uuid() AS ib_j, gen_random_uuid() AS ib_b \gset
-- a prepared INSERT/UPDATE cannot feed CREATE TABLE AS: ib_run runs one and answers how many rows it changed
CREATE FUNCTION pg_temp.ib_run(stmt text) RETURNS int LANGUAGE plpgsql AS \$f\$ DECLARE n int; BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END \$f\$;
SELECT pg_temp.ib_run(format('EXECUTE marklinked(%L, %L, %L, %L, %L, false, %L)', '$IB_U', 'manual', 'physical_samples', :'ib_j', :'ib_b', :'ib_a')) AS ib_n1 \gset
SELECT 'ib_linked:' || :ib_n1 || ':' || state || ':' || link_kind FROM d1_private.file_candidates WHERE candidate_id = :'ib_a';
SELECT pg_temp.ib_run(format('EXECUTE marklinked(%L, %L, %L, %L, %L, false, %L)', '$IB_U', 'manual', 'physical_samples', :'ib_j', :'ib_b', :'ib_a')) AS ib_n2 \gset
SELECT 'ib_linked_twice:' || :ib_n2;
SELECT pg_temp.ib_run(format('EXECUTE resetbatch(%L, %L)', :'ib_a', :'ib_b')) AS ib_n3 \gset
SELECT 'ib_undone:' || :ib_n3 || ':' || state || ':' || coalesce(link_kind, '-') || ':' || coalesce(link_batch_id::text, '-') FROM d1_private.file_candidates WHERE candidate_id = :'ib_a';
SELECT 'ib_manual_undo_mark:' || (auto_undone_at IS NULL) FROM d1_private.file_candidates WHERE candidate_id = :'ib_a';
-- an undone AUTO link is remembered (auto_undone_at), also when a person later links the file by hand and undoes that
SELECT candidate_id AS ib_h FROM d1_private.file_candidates WHERE rel_path = 'Users/ibx1/h.tif' \gset
SELECT gen_random_uuid() AS ib_hj, gen_random_uuid() AS ib_hb, gen_random_uuid() AS ib_hb2 \gset
SELECT pg_temp.ib_run(format('EXECUTE marklinked(%L, %L, %L, %L, %L, false, %L)', '$IB_U', 'auto', 'physical_samples', :'ib_hj', :'ib_hb', :'ib_h')) AS ib_n7 \gset
SELECT 'ib_auto_linked_mark:' || (auto_undone_at IS NULL) FROM d1_private.file_candidates WHERE candidate_id = :'ib_h';
SELECT pg_temp.ib_run(format('EXECUTE resetbatch(%L, %L)', :'ib_h', :'ib_hb')) AS ib_n8 \gset
SELECT 'ib_auto_undone:' || :ib_n8 || ':' || state || ':' || coalesce(link_kind, '-') || ':' || (auto_undone_at IS NOT NULL) FROM d1_private.file_candidates WHERE candidate_id = :'ib_h';
SELECT pg_temp.ib_run(format('EXECUTE marklinked(%L, %L, %L, %L, %L, false, %L)', '$IB_U', 'manual', 'physical_samples', :'ib_hj', :'ib_hb2', :'ib_h')) AS ib_n9 \gset
SELECT pg_temp.ib_run(format('EXECUTE resetbatch(%L, %L)', :'ib_h', :'ib_hb2')) AS ib_n10 \gset
SELECT 'ib_auto_undone_kept:' || :ib_n9 || ':' || :ib_n10 || ':' || state || ':' || (auto_undone_at IS NOT NULL) FROM d1_private.file_candidates WHERE candidate_id = :'ib_h';
SELECT pg_temp.ib_run(format('EXECUTE dismiss(%L, %L)', '$IB_U', :'ib_a')) AS ib_n4 \gset
SELECT 'ib_dismissed:' || :ib_n4 || ':' || state FROM d1_private.file_candidates WHERE candidate_id = :'ib_a';
SELECT pg_temp.ib_run(format('EXECUTE restore(%L)', :'ib_a')) AS ib_n5 \gset
SELECT 'ib_restored:' || :ib_n5 || ':' || state FROM d1_private.file_candidates WHERE candidate_id = :'ib_a';
-- restore and undo forget that the file's folder was listed (the crawler then lists it again and can mark a vanished file gone), for that owner only
INSERT INTO people (person_id, full_name) VALUES ('a1b00000-0000-4000-8000-000000000007', 'Inbox Other Owner');
INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id, dir_mtime, last_listed_at, baselined_at) VALUES
  ('Users/ibx1', '$IB_P', now(), now(), now()), ('Users/ibx1/other', '$IB_P', now(), now(), NULL), ('Users/ibx2', 'a1b00000-0000-4000-8000-000000000007', now(), now(), now());
-- (ib_run's row count is 0 for this UPDATE through EXECUTE, so the rows themselves are checked)
SELECT pg_temp.ib_run(format('EXECUTE relistdirs(%L)', :'ib_a')) AS ib_n11 \gset
SELECT 'ib_relist:' || (last_listed_at IS NULL) || ':' || (dir_mtime IS NULL) || ':' || (baselined_at IS NOT NULL) FROM d1_private.inbox_dirs WHERE rel_path = 'Users/ibx1';
SELECT 'ib_relist_others:' || (last_listed_at IS NOT NULL AND dir_mtime IS NOT NULL) FROM d1_private.inbox_dirs WHERE rel_path = 'Users/ibx1/other';
UPDATE d1_private.file_candidates SET rel_path = 'Users/ibx2/z.tif' WHERE rel_path = 'Users/ibx1/j.tif';
SELECT candidate_id AS ib_jj FROM d1_private.file_candidates WHERE rel_path = 'Users/ibx2/z.tif' \gset
SELECT pg_temp.ib_run(format('EXECUTE relistdirs(%L)', :'ib_jj')) AS ib_n12 \gset
SELECT 'ib_relist_foreign:' || (last_listed_at IS NOT NULL AND dir_mtime IS NOT NULL) FROM d1_private.inbox_dirs WHERE rel_path = 'Users/ibx2';
SELECT 'ib_prefs:' || pg_temp.ib_run(format('EXECUTE prefsput(%L, true)', '$IB_U'));
SELECT 'ib_first_rescan:' || pg_temp.ib_run(format('EXECUTE rescaninsert(%L, %L)', '$IB_P', '$IB_U'));
CREATE TEMP TABLE ib_flags (v text);
DO \$\$ BEGIN
  PERFORM pg_temp.ib_run(format('EXECUTE rescaninsert(%L, %L)', '$IB_P', '$IB_U'));
  INSERT INTO ib_flags VALUES ('inserted');
EXCEPTION WHEN unique_violation THEN INSERT INTO ib_flags VALUES ('refused');
END \$\$;
SELECT 'ib_second_rescan:' || v FROM ib_flags;
-- stream F1: a surface scan added from the Inbox. The feature check, the scan lookup undo and a repeated add use, the link bookkeeping with
-- linked_collection 'surface_scans' (the scan id as the junction id) against the table's CHECK, and the list falling back to that id.
INSERT INTO tool_boxes (tool_box_id, tool_box_code) VALUES ('a1b00000-0000-4000-8000-000000000004', 'IBX-BOX');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id) VALUES ('a1b00000-0000-4000-8000-000000000005', 'IBX-INS', 'a1b00000-0000-4000-8000-000000000004');
INSERT INTO surface_scans (scan_id, insert_id, directus_files_id, condition)
  VALUES ('a1b00000-0000-4000-8000-000000000006', 'a1b00000-0000-4000-8000-000000000005', 'a1b00000-0000-4000-8000-000000000107', 'worn');
CREATE TEMP TABLE ib_st AS EXECUTE scantableexists;
SELECT 'ib_scan_table:' || available FROM ib_st;
CREATE TEMP TABLE ib_sb AS EXECUTE scanbyid('a1b00000-0000-4000-8000-000000000006');
SELECT 'ib_scan_by_id:' || (insert_id = 'a1b00000-0000-4000-8000-000000000005')::text || ':' || (edge_id IS NULL)::text || ':' || (directus_files_id = 'a1b00000-0000-4000-8000-000000000107')::text FROM ib_sb;
-- S5: the scan row above is on the file of seed g (a surface scan, still undecided here). Where the table exists the summary and the new/older/open lists
-- leave g out (the Alicona dialog already added it); a surface scan file with NO scan row (h is made one for this check) is still counted and listed; the
-- queries without the exclusion (an older database) are unchanged; the linked and dismissed tabs keep scan files.
UPDATE d1_private.file_candidates SET kind = 'surface_scan' WHERE rel_path = 'Users/ibx1/h.tif';
CREATE TEMP TABLE ib_sm_plain AS EXECUTE summary('$IB_P', '');
SELECT 'ib_scan_summary_plain:' || coalesce(sum(n) FILTER (WHERE origin = 'new'), 0) FROM ib_sm_plain;
CREATE TEMP TABLE ib_sm_scans AS EXECUTE summarywithscans('$IB_P', '');
SELECT 'ib_scan_summary_excl:' || coalesce(sum(n) FILTER (WHERE origin = 'new'), 0) FROM ib_sm_scans;
CREATE TEMP TABLE ib_cnt_scans AS EXECUTE count_new_scans('$IB_P', '');
SELECT 'ib_scan_count_excl:' || total FROM ib_cnt_scans;
CREATE TEMP TABLE ib_ls_scans AS EXECUTE list_new_scans('$IB_P', '', 50, 0);
SELECT 'ib_scan_list_excl:' || (count(*) FILTER (WHERE rel_path = 'Users/ibx1/g.tif') || ':' || count(*) FILTER (WHERE rel_path = 'Users/ibx1/h.tif')) FROM ib_ls_scans;
CREATE TEMP TABLE ib_ls_old AS EXECUTE list_new('$IB_P', '', 50, 0);
SELECT 'ib_scan_list_plain:' || count(*) FILTER (WHERE rel_path = 'Users/ibx1/g.tif') FROM ib_ls_old;
CREATE TEMP TABLE ib_open_scans AS EXECUTE count_open_scans('$IB_P', '');
CREATE TEMP TABLE ib_open_plain AS EXECUTE count_open('$IB_P', '');
SELECT 'ib_scan_open_diff:' || ((SELECT total FROM ib_open_plain) - (SELECT total FROM ib_open_scans));
CREATE TEMP TABLE ib_swf AS EXECUTE scansoffiles('a1b00000-0000-4000-8000-000000000107,a1b00000-0000-4000-8000-000000000108');
SELECT 'ib_scans_of_files:' || count(*) || ':' || coalesce(max(directus_files_id::text), '') FROM ib_swf;
SELECT candidate_id AS ib_g FROM d1_private.file_candidates WHERE rel_path = 'Users/ibx1/g.tif' \gset
SELECT pg_temp.ib_run(format('EXECUTE marklinked(%L, %L, %L, %L, %L, false, %L)', '$IB_U', 'auto', 'surface_scans', 'a1b00000-0000-4000-8000-000000000006', gen_random_uuid(), :'ib_g')) AS ib_n6 \gset
SELECT 'ib_scan_linked:' || :ib_n6 || ':' || state || ':' || linked_collection FROM d1_private.file_candidates WHERE candidate_id = :'ib_g';
CREATE TEMP TABLE ib_ll AS EXECUTE list_linked('$IB_P', 'auto', 50, 0);
SELECT 'ib_scan_list:' || coalesce(string_agg(linked_record_id::text, ','), '') FROM ib_ll WHERE linked_collection = 'surface_scans';
CREATE TEMP TABLE ib_ll_scans AS EXECUTE list_linked_scans('$IB_P', 'auto', 50, 0);
SELECT 'ib_scan_list_linked_kept:' || coalesce(string_agg(linked_record_id::text, ','), '') FROM ib_ll_scans WHERE linked_collection = 'surface_scans';
-- stream D (ADR-0022): the imaging settings the link saves through d1_private.save_sem_settings and the undo removes. File ...0101 is saved; ...0103 has a
-- sample junction row, ...0107 a surface scan row and ...0105 no link: after the undo's delete only ...0105's settings are gone.
CREATE TEMP TABLE ib_sv AS EXECUTE savesemsettings('a1b00000-0000-4000-8000-000000000101', '{"kv": 15, "magnification": 5000, "ocr_confidence": {"kv": 0.9}}', 'inbox');
SELECT 'ib_sem_saved:' || saved FROM ib_sv;
SELECT 'ib_sem_row:' || kv || ':' || magnification || ':' || read_by FROM d1_private.sem_image_settings WHERE directus_files_id = 'a1b00000-0000-4000-8000-000000000101';
CREATE TEMP TABLE ib_sv2 AS EXECUTE savesemsettings('a1b00000-0000-4000-8000-000000000103', '{"kv": 10}', 'inbox');
CREATE TEMP TABLE ib_sv3 AS EXECUTE savesemsettings('a1b00000-0000-4000-8000-000000000105', '{"kv": 10}', 'inbox');
CREATE TEMP TABLE ib_sv4 AS EXECUTE savesemsettings('a1b00000-0000-4000-8000-000000000107', '{"kv": 10}', 'inbox');
-- (ib_run's row count is 0 for a DELETE through EXECUTE, so the rows left are checked)
SELECT pg_temp.ib_run(format('EXECUTE deleteunlinkedsemsettings(%L)', 'a1b00000-0000-4000-8000-000000000103,a1b00000-0000-4000-8000-000000000105,a1b00000-0000-4000-8000-000000000107')) AS ib_sd \gset
SELECT 'ib_sem_kept:' || coalesce(string_agg(right(directus_files_id::text, 3), ',' ORDER BY directus_files_id), '') FROM d1_private.sem_image_settings;
-- the owner of a file, for the settings route's decision (the same row read back)
UPDATE directus_files SET owner_person_id = '$IB_P' WHERE id = 'a1b00000-0000-4000-8000-000000000101';
CREATE TEMP TABLE ib_sf AS EXECUTE semfile('a1b00000-0000-4000-8000-000000000101');
SELECT 'ib_sem_file:' || (owner_person_id = '$IB_P')::text || ':' || (owner_team_id IS NULL)::text FROM ib_sf;
CREATE TEMP TABLE ib_sg AS EXECUTE semsettingsget('a1b00000-0000-4000-8000-000000000101');
SELECT 'ib_sem_get:' || kv || ':' || magnification || ':' || coalesce(sources ->> 'kv', '-') FROM ib_sg;
-- the owner's correction: the value, the manual mark, the user; a field that is not a setting and a value out of range are refused
SELECT 'ib_sem_correct:' || pg_temp.ib_run(format('EXECUTE semcorrect(%L, %L, %L, %L)', 'a1b00000-0000-4000-8000-000000000101', 'kv', '20', '$IB_U')) AS ib_cc \gset
SELECT 'ib_sem_corrected:' || kv || ':' || (sources ->> 'kv') || ':' || (corrected_by = '$IB_U')::text FROM d1_private.sem_image_settings WHERE directus_files_id = 'a1b00000-0000-4000-8000-000000000101';
CREATE TEMP TABLE ib_sflags (v text);
DO \$\$ BEGIN
  PERFORM pg_temp.ib_run(format('EXECUTE semcorrect(%L, %L, %L, %L)', 'a1b00000-0000-4000-8000-000000000101', 'read_by', '"x"', '$IB_U'));
  INSERT INTO ib_sflags VALUES ('read_by:changed');
EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO ib_sflags VALUES ('read_by:refused');
END \$\$;
DO \$\$ BEGIN
  PERFORM pg_temp.ib_run(format('EXECUTE semcorrect(%L, %L, %L, %L)', 'a1b00000-0000-4000-8000-000000000101', 'kv', '99', '$IB_U'));
  INSERT INTO ib_sflags VALUES ('kv99:changed');
EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO ib_sflags VALUES ('kv99:refused');
END \$\$;
DO \$\$ BEGIN
  PERFORM pg_temp.ib_run(format('EXECUTE semaccessloginsert(%L, %L, %L)', 'a1b00000-0000-4000-8000-000000000101', '$IB_U', '  '));
  INSERT INTO ib_sflags VALUES ('blank_reason:inserted');
EXCEPTION WHEN check_violation THEN INSERT INTO ib_sflags VALUES ('blank_reason:refused');
END \$\$;
SELECT 'ib_sem_refused:' || string_agg(v, ',' ORDER BY v) FROM ib_sflags;
-- an administrator's read is logged with a reason (ib_run's row count is 0 through EXECUTE, so the table is read back)
SELECT pg_temp.ib_run(format('EXECUTE semaccessloginsert(%L, %L, %L)', 'a1b00000-0000-4000-8000-000000000101', '$IB_U', 'admin_read')) AS ib_sl \gset
SELECT 'ib_sem_log_row:' || count(*) || ':' || min(reason) FROM d1_private.sem_settings_access_log WHERE directus_files_id = 'a1b00000-0000-4000-8000-000000000101';
-- Ignored folders (spec section 15): the rule statements, run on rows of their own after everything above (ids a1b00000-...-0000000002NN).
INSERT INTO directus_files (id) SELECT ('a1b00000-0000-4000-8000-0000000002' || lpad(g::text, 2, '0'))::uuid FROM generate_series(1, 7) g;
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, rel_path, state) VALUES
  ('a1b00000-0000-4000-8000-000000000201', '$IB_P', 'image', 'new', 'Users/ibx1/Ign Dir/a.tif', 'new'),
  ('a1b00000-0000-4000-8000-000000000202', '$IB_P', 'image', 'new', 'Users/ibx1/ign dir/sub/b.tif', 'new'),
  ('a1b00000-0000-4000-8000-000000000203', '$IB_P', 'image', 'new', 'Users/ibx1/Ign Dir 2/c.tif', 'new'),
  ('a1b00000-0000-4000-8000-000000000204', '$IB_P', 'image', 'new', 'Users/ibx1/Ign Dir/gone.tif', 'gone'),
  ('a1b00000-0000-4000-8000-000000000205', '$IB_Q', 'image', 'new', 'Users/ibx1/Ign Dir/q.tif', 'new'),
  ('a1b00000-0000-4000-8000-000000000206', '$IB_P', 'image', 'new', 'Users/ibx1/x/Ign Dir/d.tif', 'new'),
  ('a1b00000-0000-4000-8000-000000000207', '$IB_P', 'image', 'new', 'Users/ibx1/Ign Dir/e.tif', 'new');
SELECT pg_temp.ib_run(format('EXECUTE ignoredinsert(%L, NULL, %L, %L)', '$IB_P', 'Ign Dir', '$IB_U')) AS ib_ign_n \gset
SELECT 'ib_ign_insert:' || :ib_ign_n || ':' || count(*) || ':' || bool_and(rel_folder = 'Ign Dir' AND owner_person_id = '$IB_P' AND owner_team_id IS NULL AND created_by = '$IB_U') FROM d1_private.inbox_ignored_dirs;
SELECT ignored_id AS ib_ign_id FROM d1_private.inbox_ignored_dirs \gset
CREATE TEMP TABLE ib_ig_cnt AS EXECUTE ignoredcount('$IB_P', NULL);
SELECT 'ib_ign_count:' || n FROM ib_ig_cnt;
CREATE TEMP TABLE ib_ig_cnt_other AS EXECUTE ignoredcount(NULL, 'a2000000-0000-4000-8000-0000000000b1');
SELECT 'ib_ign_count_other_owner:' || n FROM ib_ig_cnt_other;
CREATE TEMP TABLE ib_ig_find AS EXECUTE ignoredfind('$IB_P', NULL, 'IGN DIR');
SELECT 'ib_ign_find_any_case:' || count(*) FROM ib_ig_find;
CREATE TEMP TABLE ib_ig_find2 AS EXECUTE ignoredfind('$IB_Q', NULL, 'IGN DIR');
SELECT 'ib_ign_find_other_owner:' || count(*) FROM ib_ig_find2;
CREATE TEMP TABLE ib_ig_flags (v text);
DO \$\$ BEGIN
  PERFORM pg_temp.ib_run(format('EXECUTE ignoredinsert(%L, NULL, %L, NULL)', '$IB_P', 'ign DIR'));
  INSERT INTO ib_ig_flags VALUES ('inserted');
EXCEPTION WHEN unique_violation THEN INSERT INTO ib_ig_flags VALUES ('refused');
END \$\$;
SELECT 'ib_ign_duplicate:' || v FROM ib_ig_flags;
CREATE TEMP TABLE ib_ig_list AS EXECUTE ignoredlist('$IB_P', '');
SELECT 'ib_ign_list:' || count(*) || ':' || bool_and(owner_name = 'Inbox Person' AND owner_team_id IS NULL) FROM ib_ig_list;
CREATE TEMP TABLE ib_ig_byid AS EXECUTE ignoredbyid(:'ib_ign_id');
SELECT 'ib_ign_by_id:' || count(*) || ':' || bool_and(rel_folder = 'Ign Dir' AND owner_person_id = '$IB_P') FROM ib_ig_byid;
-- review Minor2: the owner's remaining rules, read after a delete to see whether the removed folder is still covered by a rule above it
CREATE TEMP TABLE ib_ig_own AS EXECUTE ignoredofowner('$IB_P', NULL);
SELECT 'ib_ign_of_owner:' || count(*) || ':' || min(rel_folder) FROM ib_ig_own;
CREATE TEMP TABLE ib_ig_own_other AS EXECUTE ignoredofowner('$IB_Q', NULL);
SELECT 'ib_ign_of_owner_other:' || count(*) FROM ib_ig_own_other;
-- the owner's open candidates (review Minor1: by owner only, never gone or another owner's; which of them lie under the rule is decided in JS by isIgnored, so no
-- lowercasing prefix in SQL can disagree with it). The ids to dismiss are then the ones on whole path parts, ignoring case (a, e and sub/b: not 'Ign Dir 2', not x/Ign Dir).
SELECT 'ib_ign_open_owner:' || (pg_temp.ib_run(format('EXECUTE openunderfolder(%L, NULL)', '$IB_P')) = (SELECT count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$IB_P' AND state = 'new'));
SELECT 'ib_ign_open_owner_only:' || pg_temp.ib_run(format('EXECUTE openunderfolder(%L, NULL)', 'a1b00000-0000-4000-8000-0000000000e1'));
SELECT string_agg(candidate_id::text, ',') AS ib_ign_ids FROM d1_private.file_candidates
 WHERE owner_person_id = '$IB_P' AND state = 'new' AND starts_with(lower(rel_path), lower('Users/ibx1/Ign Dir/')) \gset
SELECT 'ib_ign_open_under:' || array_length(string_to_array(:'ib_ign_ids', ','), 1);
-- the same dismissal statement as POST /dismiss
SELECT 'ib_ign_dismissed:' || pg_temp.ib_run(format('EXECUTE dismiss(%L, %L)', '$IB_U', :'ib_ign_ids'));
SELECT 'ib_ign_states:' || string_agg(regexp_replace(rel_path, '^Users/ibx1/', '') || '=' || state, ',' ORDER BY rel_path COLLATE "C") FROM d1_private.file_candidates WHERE directus_files_id::text LIKE 'a1b00000-0000-4000-8000-0000000002%';
SELECT 'ib_ign_open_after:' || count(*) FROM d1_private.file_candidates WHERE owner_person_id = '$IB_P' AND state = 'new' AND starts_with(lower(rel_path), lower('Users/ibx1/Ign Dir/'));
-- Review M1: files the crawler registered AFTER the rule was added (it loads the rules once per scan) stay open under the folder. The list, its count, the summary,
-- accept-all's selection and its candidate reads leave an undecided row under a rule of ITS OWNER out; a linked row under a rule is still listed in the Linked tab.
-- Rows (ids ...0208 to ...0216): 208 late (P, under Ign Dir, exact match), 209 late in a sub folder, other letter case, 210 linked under the rule, 211 a sibling folder that
-- shares the prefix (not under the rule), 212 team row under the team's rule, 213 team row outside it, 214 to 216 a rule of two parts (Deep/Down): 214 under it (other letter case), 215 beside it, 216 a sibling that shares the prefix. The rule of ANOTHER owner (Q ignores 'Ign Dir 2') must not hide P's 211.
INSERT INTO teams (team_id, name, share_folder) VALUES ('a1b00000-0000-4000-8000-0000000000c1', 'Inbox Rules Team', 'Ibx Team');
INSERT INTO d1_private.inbox_ignored_dirs (owner_team_id, rel_folder) VALUES ('a1b00000-0000-4000-8000-0000000000c1', 'old');
INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) VALUES ('$IB_Q', 'Ign Dir 2'), ('$IB_P', 'Deep/Down');
CREATE TEMP TABLE ib_m1_cnt0 AS EXECUTE count_new('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
CREATE TEMP TABLE ib_m1_open0 AS EXECUTE count_open('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
CREATE TEMP TABLE ib_m1_sm0 AS EXECUTE summary('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
CREATE TEMP TABLE ib_m1_acc0 AS EXECUTE accept_open('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
INSERT INTO directus_files (id) SELECT ('a1b00000-0000-4000-8000-0000000002' || lpad(g::text, 2, '0'))::uuid FROM generate_series(8, 16) g;
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, owner_team_id, kind, origin, state, match_strength, suggested_collection, suggested_record_id, matches, rel_path,
                                        link_kind, linked_collection, linked_junction_id, link_batch_id)
SELECT ('a1b00000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid, CASE WHEN n NOT IN (12, 13) THEN '$IB_P'::uuid END, CASE WHEN n IN (12, 13) THEN 'a1b00000-0000-4000-8000-0000000000c1'::uuid END,
       'image', 'new', st, 'short_id', 'physical_samples', '$IB_S'::uuid,
       jsonb_build_array(jsonb_build_object('collection', 'physical_samples', 'record_id', '$IB_S', 'via', 'short_id', 'token', 'abcd1234')), path,
       CASE WHEN st = 'linked' THEN 'manual' END, CASE WHEN st = 'linked' THEN 'physical_samples' END,
       CASE WHEN st = 'linked' THEN gen_random_uuid() END, CASE WHEN st = 'linked' THEN gen_random_uuid() END
  FROM (VALUES (8, 'new', 'Users/ibx1/Ign Dir/late.tif'), (9, 'new', 'users/IBX1/ign dir/sub/late2.tif'), (10, 'linked', 'Users/ibx1/Ign Dir/linked.tif'),
               (11, 'new', 'Users/ibx1/Ign Dir 2/ok.tif'), (12, 'new', 'Shared/Ibx Team/Old/late.tif'), (13, 'new', 'Shared/Ibx Team/Older/ok.tif'),
               (14, 'new', 'Users/ibx1/deep/down/x.tif'), (15, 'new', 'Users/ibx1/Deep/other.tif'), (16, 'new', 'Users/ibx1/Deep/Down2/y.tif')) v(n, st, path);
CREATE TEMP TABLE ib_m1_ls AS EXECUTE list_new('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1', 200, 0);
SELECT 'ib_ign_late_listed:' || coalesce(string_agg(rel_path, ',' ORDER BY rel_path COLLATE "C") FILTER (WHERE directus_files_id::text ~ '^a1b00000-0000-4000-8000-0000000002(08|09|10|11|12|13|14|15|16)$'), '') FROM ib_m1_ls;
CREATE TEMP TABLE ib_m1_ls_scans AS EXECUTE list_new_scans('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1', 200, 0);
SELECT 'ib_ign_late_listed_scans:' || coalesce(string_agg(rel_path, ',' ORDER BY rel_path COLLATE "C") FILTER (WHERE directus_files_id::text ~ '^a1b00000-0000-4000-8000-0000000002(08|09|10|11|12|13|14|15|16)$'), '') FROM ib_m1_ls_scans;
CREATE TEMP TABLE ib_m1_cnt AS EXECUTE count_new('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
SELECT 'ib_ign_late_count:' || ((SELECT total FROM ib_m1_cnt) - (SELECT total FROM ib_m1_cnt0));
CREATE TEMP TABLE ib_m1_open AS EXECUTE count_open('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
SELECT 'ib_ign_late_open_count:' || ((SELECT total FROM ib_m1_open) - (SELECT total FROM ib_m1_open0));
CREATE TEMP TABLE ib_m1_sm AS EXECUTE summary('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
SELECT 'ib_ign_late_summary:' || (coalesce(sum(n) FILTER (WHERE owner_person_id IS NOT NULL), 0) - (SELECT coalesce(sum(n) FILTER (WHERE owner_person_id IS NOT NULL), 0) FROM ib_m1_sm0))
       || ':' || (coalesce(sum(n) FILTER (WHERE owner_team_id IS NOT NULL), 0) - (SELECT coalesce(sum(n) FILTER (WHERE owner_team_id IS NOT NULL), 0) FROM ib_m1_sm0)) FROM ib_m1_sm;
CREATE TEMP TABLE ib_m1_sm_scans AS EXECUTE summarywithscans('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
SELECT 'ib_ign_late_summary_scans:' || ((SELECT coalesce(sum(n), 0) FROM ib_m1_sm_scans) = (SELECT coalesce(sum(n), 0) FROM ib_m1_sm));
CREATE TEMP TABLE ib_m1_acc AS EXECUTE accept_open('$IB_P', 'a1b00000-0000-4000-8000-0000000000c1');
SELECT 'ib_ign_late_accept:' || coalesce(string_agg(c.rel_path, ',' ORDER BY c.rel_path COLLATE "C") FILTER (WHERE c.candidate_id NOT IN (SELECT candidate_id FROM ib_m1_acc0)), '')
  FROM d1_private.file_candidates c WHERE c.candidate_id IN (SELECT candidate_id FROM ib_m1_acc);
SELECT string_agg(candidate_id::text, ',') AS ib_m1_ids FROM d1_private.file_candidates WHERE directus_files_id::text ~ '^a1b00000-0000-4000-8000-0000000002(08|09|10|11|12|13|14|15|16)$' \gset
CREATE TEMP TABLE ib_m1_byid AS EXECUTE acceptcandidatesbyid(:'ib_m1_ids');
SELECT 'ib_ign_late_accept_read:' || coalesce(string_agg(c.rel_path, ',' ORDER BY c.rel_path COLLATE "C"), '') FROM d1_private.file_candidates c WHERE c.candidate_id IN (SELECT candidate_id FROM ib_m1_byid);
CREATE TEMP TABLE ib_m1_lock AS EXECUTE acceptcandidatesforupdate(:'ib_m1_ids');
SELECT 'ib_ign_late_accept_lock:' || ((SELECT count(*) FROM ib_m1_lock) = (SELECT count(*) FROM ib_m1_byid));
CREATE TEMP TABLE ib_m1_lk AS EXECUTE list_linked('$IB_P', 'manual', 200, 0);
SELECT 'ib_ign_linked_listed:' || coalesce(string_agg(rel_path, ',' ORDER BY rel_path COLLATE "C") FILTER (WHERE rel_path ~ 'linked[.]tif$'), '') FROM ib_m1_lk;
DELETE FROM d1_private.inbox_ignored_dirs WHERE owner_team_id IS NOT NULL OR owner_person_id = '$IB_Q' OR rel_folder = 'Deep/Down';
-- removing the rule: the folder's cache rows are RESET (kept, mtime and listed time NULL; any case, below it, this owner only)
INSERT INTO d1_private.inbox_dirs (rel_path, owner_person_id, dir_mtime, last_listed_at) VALUES
  ('Users/ibx1/Ign Dir', '$IB_P', now(), now()), ('Users/ibx1/ign dir/sub', '$IB_P', now(), now()), ('Users/ibx1/Ign Dir 2', '$IB_P', now(), now());
SELECT pg_temp.ib_run(format('EXECUTE ignoredresetdirs(%L, NULL, %L, %L)', '$IB_P', 'Users/ibx1/Ign Dir', 'Users/ibx1/Ign Dir/')) AS ib_ign_r1 \gset
SELECT 'ib_ign_dirs:' || string_agg(rel_path || '=' || (dir_mtime IS NULL) || (last_listed_at IS NULL), ',' ORDER BY rel_path COLLATE "C") FROM d1_private.inbox_dirs WHERE rel_path LIKE 'Users/ibx1/%ign dir%' OR rel_path LIKE 'Users/ibx1/Ign Dir%';
SELECT pg_temp.ib_run(format('EXECUTE ignoredresetdirs(%L, NULL, %L, %L)', 'a1b00000-0000-4000-8000-000000000007', 'Users/ibx1/Ign Dir 2', 'Users/ibx1/Ign Dir 2/')) AS ib_ign_r2 \gset
SELECT 'ib_ign_reset_wrong_owner_kept:' || (dir_mtime IS NOT NULL AND last_listed_at IS NOT NULL) FROM d1_private.inbox_dirs WHERE rel_path = 'Users/ibx1/Ign Dir 2';
SELECT 'ib_ign_deleted:' || pg_temp.ib_run(format('EXECUTE ignoreddelete(%L)', :'ib_ign_id'));
SELECT 'ib_ign_rules_left:' || count(*) FROM d1_private.inbox_ignored_dirs;
-- GET /siblings: the other pictures linked to the same sample through the junction rows the links made (not another person's, not the file itself), with the size of the link batch
INSERT INTO directus_files (id, filename_download) SELECT ('a1b00000-0000-4000-8000-0000000003' || lpad(g::text, 2, '0'))::uuid, 'sib' || g || '.tif' FROM generate_series(1, 3) g;
SELECT gen_random_uuid() AS ib_sj1, gen_random_uuid() AS ib_sj2, gen_random_uuid() AS ib_sj3 \gset
INSERT INTO sample_data_files (id, sample_id, directus_files_id) VALUES
  (:'ib_sj1', '$IB_S', 'a1b00000-0000-4000-8000-000000000301'), (:'ib_sj2', '$IB_S', 'a1b00000-0000-4000-8000-000000000302'), (:'ib_sj3', '$IB_S', 'a1b00000-0000-4000-8000-000000000303');
INSERT INTO d1_private.file_candidates (directus_files_id, owner_person_id, kind, origin, state, match_strength, matches, rel_path, link_kind, linked_collection, linked_junction_id, link_batch_id, decided_at) VALUES
  ('a1b00000-0000-4000-8000-000000000301', '$IB_P', 'sem_image', 'new', 'linked', 'none', '[]'::jsonb, 'Users/ibx1/s1.tif', 'manual', 'physical_samples', :'ib_sj1', gen_random_uuid(), now() - interval '3 hours'),
  ('a1b00000-0000-4000-8000-000000000302', '$IB_P', 'image', 'new', 'linked', 'none', '[]'::jsonb, 'Users/ibx1/s2.tif', 'manual', 'physical_samples', :'ib_sj2', gen_random_uuid(), now() - interval '2 hours'),
  ('a1b00000-0000-4000-8000-000000000303', '$IB_Q', 'sem_image', 'new', 'linked', 'none', '[]'::jsonb, 'Users/ibx1/s3.tif', 'manual', 'physical_samples', :'ib_sj3', gen_random_uuid(), now());
SELECT candidate_id AS ib_sib_self FROM d1_private.file_candidates WHERE directus_files_id = 'a1b00000-0000-4000-8000-000000000301' \gset
CREATE TEMP TABLE ib_sib AS EXECUTE siblings_list_physical_samples('$IB_P', '', 'sem_image,image', 'physical_samples', '$IB_S', :'ib_sib_self', 7, 0);
SELECT 'ib_sib_list:' || coalesce(string_agg(rel_path || ':' || link_batch_size, ',' ORDER BY decided_at DESC), '') FROM ib_sib;
CREATE TEMP TABLE ib_sib_cnt AS EXECUTE siblings_count_physical_samples('$IB_P', '', 'sem_image,image', 'physical_samples', '$IB_S', :'ib_sib_self');
SELECT 'ib_sib_count:' || total FROM ib_sib_cnt;
ROLLBACK;
SQL
)
    expect_fixed ib_out "ib_prepared:$ib_n" "every statement of d1-inbox ($ib_n, with the list, count and accept variants) prepares against the real schema"
    expect_fixed ib_out "ib_summary_new:6" "summary: counts the original, a copy of a gone original, a surface scan, an ambiguous file and a copy whose original ANOTHER person dismissed; not a copy of a file still in an inbox, a copy of a linked file, a copy of one this person dismissed, or a file already on its record"
    expect_fixed ib_out "ib_summary_older_exact:1" "summary: older files with an exact match are counted"
    expect_fixed ib_out "ib_list_new_total:9" "list: a copy is listed (marked) while its original is undecided, hidden once the original is linked or dismissed by the same owner, and listed (not hidden) when another owner dismissed it"
    expect_fixed ib_out "ib_list_copies:b.tif=me,f.tif=me,l.tif=q,p.tif=q,u.tif=q" "list: a copy whose original another owner dismissed (l) stays; a copy of a linked original (n) and of one this owner dismissed (s) are gone; the list says whose inbox each original is in (duplicate_owner_*_id)"
    expect_fixed ib_out "ib_accept:Users/ibx1/a.tif,Users/ibx1/d.tif" "accept-all selects only exact one-record matches that are not copies, surface scans or already on their record"
    expect_fixed ib_out "ib_linked:1:linked:manual" "link bookkeeping passes the table's CHECKs (state, kind, collection, junction and batch together)"
    expect_fixed ib_out "ib_linked_twice:0" "a second link of a file no longer new changes nothing"
    expect_fixed ib_out "ib_undone:1:new:-:-" "undo clears all four link columns together"
    expect_fixed ib_out "ib_manual_undo_mark:true" "undo of a manual link leaves auto_undone_at NULL"
    expect_fixed ib_out "ib_auto_linked_mark:true" "an auto link does not set auto_undone_at"
    expect_fixed ib_out "ib_auto_undone:1:new:-:true" "undo of an AUTO link clears the link columns and sets auto_undone_at, in one UPDATE"
    expect_fixed ib_out "ib_auto_undone_kept:1:1:new:true" "a later manual link and its undo neither clear nor re-set the mark (a person may link the file; automation never does)"
    expect_fixed ib_out "ib_dismissed:1:dismissed" "dismiss moves a new file to dismissed"
    expect_fixed ib_out "ib_restored:1:new" "restore moves it back to new"
    expect_fixed ib_out "ib_relist:true:true:true" "restore / undo: the file's folder row forgets it was listed (last_listed_at and dir_mtime NULL), its owner's baselined_at stays"
    expect_fixed ib_out "ib_relist_others:true" "restore / undo: another folder of the same owner keeps its cache row"
    expect_fixed ib_out "ib_relist_foreign:true" "restore / undo: a folder row cached for another owner is left alone"
    expect_fixed ib_out "ib_scan_table:true" "the surface_scans feature check (information_schema) answers yes where the table exists"
    expect_fixed ib_out "ib_scan_by_id:true:true:true" "the scan lookup undo and a repeated add use returns the item and the file"
    expect_fixed ib_out "ib_scan_summary_plain:6" "summary without the scan exclusion (a database that has no surface_scans table) is unchanged"
    expect_fixed ib_out "ib_scan_summary_excl:5" "summary with the exclusion leaves out the surface scan file that already has a scan row (g) and still counts one that has none (h)"
    expect_fixed ib_out "ib_scan_count_excl:8" "the new list's total leaves out the surface scan file that already has a scan row"
    expect_fixed ib_out "ib_scan_list_excl:0:1" "the new list drops g (it has a scan) and keeps h (a surface scan file with none)"
    expect_fixed ib_out "ib_scan_list_plain:1" "the list without the exclusion still shows g (older databases)"
    expect_fixed ib_out "ib_scan_open_diff:1" "the open list's total differs by exactly that one file"
    expect_fixed ib_out "ib_scans_of_files:1:a1b00000-0000-4000-8000-000000000107" "the up-front check of POST /link finds the files that already have a scan row, and only those"
    expect_fixed ib_out "ib_scan_list_linked_kept:a1b00000-0000-4000-8000-000000000006" "the linked tab keeps a scan file after the exclusion variant (it is only for undecided tabs)"
    expect_fixed ib_out "ib_scan_linked:1:linked:surface_scans" "a surface scan add passes the link CHECKs (linked_collection surface_scans with the scan id as the junction id)"
    expect_fixed ib_out "ib_scan_list:a1b00000-0000-4000-8000-000000000006" "the Recently linked list names the scan id as the linked record without joining a table that may not exist yet"
    expect_fixed ib_out "ib_sem_saved:true" "stream D: save_sem_settings (called as the link calls it) saves a row and answers true"
    expect_fixed ib_out "ib_sem_row:15.00:5000:inbox" "stream D: the saved row holds the mapped keys and read_by inbox; ocr_confidence is ignored by the function"
    expect_fixed ib_out "ib_sem_kept:101,103,107" "stream D: undo's delete removes the settings of a file with no link left (105) and keeps those of a file still linked (103 sample junction row, 107 surface scan row)"
    expect_fixed ib_out "ib_sem_file:true:true" "stream D: the settings route reads the file's owner columns from directus_files"
    expect_fixed ib_out "ib_sem_get:15.00:5000:-" "stream D: the settings route reads the row (values as numeric text; no source is invented when extracted carried none)"
    expect_fixed ib_out "ib_sem_corrected:20.00:manual:true" "stream D: a correction sets the value, marks it manual and names the user"
    expect_fixed ib_out "ib_sem_refused:blank_reason:refused,kv99:refused,read_by:refused" "stream D: a correction of read_by, or of kv out of range, is refused (the route answers 400), and so is a blank log reason"
    expect_fixed ib_out "ib_sem_log_row:1:admin_read" "stream D: an administrator's read inserts one access log row with the reason admin_read"
    expect_fixed ib_out "ib_sib_list:Users/ibx1/s2.tif:1" "siblings: the other pictures linked to the same sample, found through the junction row of each link, are this person's own, not the file itself and not another person's; each says the size of its link batch"
    expect_fixed ib_out "ib_sib_count:1" "siblings: the count query answers the same set"
    expect_fixed ib_out "ib_prefs:1" "the auto-link preference upserts"
    expect_fixed ib_out "ib_first_rescan:1" "a rescan request is queued"
    expect_fixed ib_out "ib_second_rescan:refused" "a second queued rescan for one person is refused by the unique index (the endpoint answers 429)"
    expect_fixed ib_out "ib_ign_insert:1:1:true" "an ignored folder rule inserts for a person (the other owner column NULL, created_by set)"
    expect_fixed ib_out "ib_ign_count:1" "the rule count for the 200-rule cap is per owner"
    expect_fixed ib_out "ib_ign_count_other_owner:0" "...and another owner (a team) has none"
    expect_fixed ib_out "ib_ign_find_any_case:1" "the duplicate check finds the rule whatever the letter case"
    expect_fixed ib_out "ib_ign_find_other_owner:0" "...and for the same folder another owner has no rule"
    expect_fixed ib_out "ib_ign_duplicate:refused" "the unique index refuses the same folder in another case for one owner (the endpoint answers 409 ALREADY_IGNORED)"
    expect_fixed ib_out "ib_ign_list:1:true" "the rule list names the owner (person full name)"
    expect_fixed ib_out "ib_ign_by_id:1:true" "a rule is found by its id with its owner and folder"
    expect_fixed ib_out "ib_ign_of_owner:1:Ign Dir" "the owner's rules are read for the 'still covered by another rule' answer of a delete"
    expect_fixed ib_out "ib_ign_of_owner_other:0" "...and another owner's rules are not part of it"
    expect_fixed ib_out "ib_ign_open_owner:true" "the open files of an owner are selected by owner and state only (never gone ones; the rule is applied in JS, not by a SQL prefix)"
    expect_fixed ib_out "ib_ign_open_owner_only:0" "...and an owner with no open files has none"
    expect_fixed ib_out "ib_ign_open_under:3" "the open files under the rule (a, e and sub/b), on whole path parts and ignoring case: not 'Ign Dir 2', not a gone file, not another owner's, not x/Ign Dir"
    expect_fixed ib_out "ib_ign_dismissed:3" "the rule's dismissal is the very statement of POST /dismiss"
    expect_fixed ib_out "ib_ign_states:Ign Dir 2/c.tif=new,Ign Dir/a.tif=dismissed,Ign Dir/e.tif=dismissed,Ign Dir/gone.tif=gone,Ign Dir/q.tif=new,ign dir/sub/b.tif=dismissed,x/Ign Dir/d.tif=new" "only the open files under the rule changed state"
    expect_fixed ib_out "ib_ign_open_after:0" "nothing open is left under the rule"
    expect_fixed ib_out "ib_ign_late_listed:Shared/Ibx Team/Older/ok.tif,Users/ibx1/Deep/Down2/y.tif,Users/ibx1/Deep/other.tif,Users/ibx1/Ign Dir 2/ok.tif" "list (M1): a row registered under an ignored folder after the rule (any letter case, in a sub folder, a team's rule too) is not listed; a sibling that shares the prefix, and a folder another owner ignores, stay; a linked row is not in the undecided tabs"
    expect_fixed ib_out "ib_ign_late_listed_scans:Shared/Ibx Team/Older/ok.tif,Users/ibx1/Deep/Down2/y.tif,Users/ibx1/Deep/other.tif,Users/ibx1/Ign Dir 2/ok.tif" "the same in the variant where the surface_scans table exists"
    expect_fixed ib_out "ib_ign_late_count:4" "count (M1): the late rows are not counted either (only the four rows outside every rule are; a rule of two parts covers its folder, not a sibling that shares the prefix)"
    expect_fixed ib_out "ib_ign_late_open_count:4" "the open tab's count leaves them out too"
    expect_fixed ib_out "ib_ign_late_summary:3:1" "summary (M1): the badge counts the three person rows and the one team row outside the rules, not the late ones"
    expect_fixed ib_out "ib_ign_late_summary_scans:true" "...and the surface_scans variant of the summary agrees"
    expect_fixed ib_out "ib_ign_late_accept:Shared/Ibx Team/Older/ok.tif,Users/ibx1/Deep/Down2/y.tif,Users/ibx1/Deep/other.tif,Users/ibx1/Ign Dir 2/ok.tif" "accept-all (M1): selects the rows outside every rule, never a late one under a rule"
    expect_fixed ib_out "ib_ign_late_accept_read:Shared/Ibx Team/Older/ok.tif,Users/ibx1/Deep/Down2/y.tif,Users/ibx1/Deep/other.tif,Users/ibx1/Ign Dir 2/ok.tif,Users/ibx1/Ign Dir/linked.tif" "accept-all's candidate read (M1): an undecided late row reads as not found, a decided one is still returned (its answer stays NOT_NEW)"
    expect_fixed ib_out "ib_ign_late_accept_lock:true" "...and the locking read returns the same rows"
    expect_fixed ib_out "ib_ign_linked_listed:Users/ibx1/Ign Dir/linked.tif" "a linked file under a rule is still listed in the Linked tab"
    expect_fixed ib_out "ib_ign_dirs:Users/ibx1/Ign Dir=truetrue,Users/ibx1/Ign Dir 2=falsefalse,Users/ibx1/ign dir/sub=truetrue" "the rows are kept with dir_mtime and last_listed_at NULL; a sibling that shares a prefix is untouched"
    expect_fixed ib_out "ib_ign_reset_wrong_owner_kept:true" "another owner's reset of the same path changes nothing: the row keeps its times"
    expect_fixed ib_out "ib_ign_deleted:1" "a rule is deleted by id"
    expect_fixed ib_out "ib_ign_rules_left:0" "...and none is left"
else
    echo "  skip: node is not installed here, so the d1-inbox SQL is not run (CI has node)"
fi
