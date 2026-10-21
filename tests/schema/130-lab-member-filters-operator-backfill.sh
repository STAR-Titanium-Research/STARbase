# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Lab Member filters put _some only where Directus accepts it =="
# Directus 11 (api apply-query/filter) handles `_some`/`_none` only directly under an O2M field at the
# top of a query, or at the top of the subquery another legal `_some` opens. Anywhere else, e.g.
# `sample_id.co_owners._some` (after a to-one hop), it throws `"_some" can only be used with top level
# relational alias field`. A `_some` subquery also applies the related collection's own permission
# rows, so one bad row 400s every collection whose rule reaches it: 20 Lab Member collections on
# live after hotfix 20261009000142, which kept the outermost `_some` even where it was illegal
# (migration 20261010000160). CI has no Directus, so this checks the stored JSON against that rule,
# using directus_relations for which fields are O2M.
SOME_LINT=$(mktemp)
cat > "$SOME_LINT" <<'PY'
import json, sys
doc = json.loads(sys.stdin.read())
o2m = {(r["one_collection"], r["one_field"]): r["many_collection"] for r in doc["relations"] if r["one_field"]}
m2o = {(r["many_collection"], r["many_field"]): r["one_collection"] for r in doc["relations"] if r["one_collection"]}
bad = []
def scope(coll, node, top, where):
    for key, val in (node or {}).items():
        if key in ("_and", "_or"):
            for sub in val:
                scope(coll, sub, top, where)
        elif not key.startswith("_") and isinstance(val, dict):
            field(coll, key, val, top, where)
def field(coll, key, val, top, where):
    first = next(iter(val), None)
    if first in ("_some", "_none"):
        if top and (coll, key) in o2m:
            scope(o2m[(coll, key)], val[first], True, where)
        else:
            bad.append(f"{where}: {coll}.{key}.{first}")
        return
    if any(k in ("_some", "_none") for k in val):
        bad.append(f"{where}: {coll}.{key} ({'/'.join(val)})")
    nxt = o2m.get((coll, key)) or m2o.get((coll, key))
    for k, v in val.items():
        if nxt and not k.startswith("_") and isinstance(v, dict):
            field(nxt, k, v, False, where)
for row in doc["rows"]:
    for col in ("permissions", "validation"):
        scope(row["collection"], row[col], True, f'{row["policy"]} {row["collection"]}.{row["action"]} {col}')
print(f"illegal:{len(bad)}")
for b in bad[:20]:
    print("  " + b)
PY
some_rows_sql="json_build_object(
  'relations', (SELECT coalesce(json_agg(json_build_object('many_collection', many_collection, 'many_field', many_field,
                 'one_collection', one_collection, 'one_field', one_field)), '[]') FROM directus_relations),
  'rows', (SELECT coalesce(json_agg(json_build_object('policy', policy, 'collection', collection, 'action', action,
                 'permissions', permissions::json, 'validation', validation::json)), '[]') FROM directus_permissions))"
lint_out=$($PSQL -c "SELECT $some_rows_sql" 2>&1 | python3 "$SOME_LINT" 2>&1)
grep -qx "illegal:0" <<<"$lint_out" \
    && ok "no stored permission or validation filter has a _some Directus would reject" \
    || bad "a stored permission filter has a _some Directus 11 rejects (400s the whole policy): $lint_out"
# The lint itself must catch the live failure: the hotfix-142 shape of manufacturing_operations.read.
lint_neg=$(python3 "$SOME_LINT" 2>&1 <<'JSON'
{"relations": [{"many_collection": "manufacturing_operations", "many_field": "sample_id", "one_collection": "physical_samples", "one_field": null},
               {"many_collection": "sample_co_owners", "many_field": "sample_id", "one_collection": "physical_samples", "one_field": "co_owners"}],
 "rows": [{"policy": "p", "collection": "manufacturing_operations", "action": "read", "validation": null,
           "permissions": {"_or": [{"sample_id": {"co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}}]}},
          {"policy": "p", "collection": "physical_samples", "action": "read", "validation": null,
           "permissions": {"_or": [{"co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}]}}]}
JSON
)
grep -qx "illegal:1" <<<"$lint_neg" \
    && ok "the _some lint flags sample_id.co_owners._some (after a to-one hop) and passes top-level co_owners._some" \
    || bad "the _some lint does not tell legal from illegal _some: $lint_neg"

# Migration 20261010000160 from a live-shaped state: seed two rows as hotfix 142 left them on live
# (a read and an update row with `_some` after a to-one hop), apply up, then down. Rolled back.
MIG=$(migration lab_member_some_only_where_directus_accepts_it)
mig_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$MIG")
mig_down=$(awk '/-- migrate:down/{f=1;next}f' "$MIG")
# 160 is a snapshot of the rules of 2026-10-10, so what it must leave is main's filters (the frozen fixture), not the
# current generator output: 166 (record access) is taken down first and rewrites these rows again.
gen_perm() { python3 -c 'import json,sys; c,a=sys.argv[1:3]; print(json.dumps(next(x["permissions"] for x in json.load(open("tests/scripts/fixtures/lab_member_rules_main.json")) if (x["collection"],x["action"])==(c,a))))' "$1" "$2"; }
gen_mo_read=$(gen_perm manufacturing_operations read)
gen_cs_update=$(gen_perm campaign_samples update)
live_mo_read='{"_or":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'
live_cs_update='{"_or":[{"campaign_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"sample_id":{"co_owners":{"_some":{"user_id":{"_eq":"$CURRENT_USER"}}}}}]}'
sm_out=$($PSQL 2>&1 <<SQL
BEGIN;
-- 185 (Lab Viewer) hangs a trigger on 166's lock function: its down goes first
$lv_down
$ll_down
$rr_down
$la_down
$mig_down
SELECT 'down_backup_gone:' || (to_regclass('d1_private.lab_member_some_fix_backup') IS NULL);
UPDATE directus_permissions SET permissions = '$live_mo_read'
 WHERE policy = '$LM' AND collection = 'manufacturing_operations' AND action = 'read';
UPDATE directus_permissions SET permissions = '$live_cs_update'
 WHERE policy = '$LM' AND collection = 'campaign_samples' AND action = 'update';
CREATE TEMP TABLE _before AS SELECT id, policy, permissions::text AS p, validation::text AS v, fields FROM directus_permissions;
SELECT 'pre_lint:' || $some_rows_sql;
$mig_up
SELECT 'up_mo_read:' || (permissions::jsonb = '$gen_mo_read'::jsonb) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'manufacturing_operations' AND action = 'read';
SELECT 'up_cs_update:' || (permissions::jsonb = '$gen_cs_update'::jsonb) FROM directus_permissions
 WHERE policy = '$LM' AND collection = 'campaign_samples' AND action = 'update';
SELECT 'up_other_untouched:' || count(*) FROM directus_permissions d FULL JOIN _before b USING (id)
 WHERE d.id IS NULL OR b.id IS NULL OR d.validation::text IS DISTINCT FROM b.v OR d.fields IS DISTINCT FROM b.fields
    OR (b.policy <> '$LM' AND d.permissions::text IS DISTINCT FROM b.p);
SELECT 'up_lint:' || $some_rows_sql;
$mig_down
SELECT 'down_exact:' || count(*) FROM directus_permissions d FULL JOIN _before b USING (id)
 WHERE (d.permissions::text, d.validation::text, d.fields) IS DISTINCT FROM (b.p, b.v, b.fields);
ROLLBACK;
SQL
)
pre_lint=$(sed -n 's/^pre_lint://p' <<<"$sm_out" | python3 "$SOME_LINT" 2>&1 | head -1)
up_lint=$(sed -n 's/^up_lint://p' <<<"$sm_out" | python3 "$SOME_LINT" 2>&1)
[[ "$pre_lint" =~ ^illegal:[1-9] ]] && ok "the live-shaped state before up fails the _some lint ($pre_lint)" \
    || bad "the live-shaped state should fail the _some lint, got: $pre_lint"
grep -qx "illegal:0" <<<"$up_lint" && ok "up: no Lab Member filter has an illegal _some" || bad "up: still illegal: $up_lint"
expect_fixed sm_out "up_mo_read:true" "up: manufacturing_operations.read is the generated filter (amnesty kept)"
expect_fixed sm_out "up_cs_update:true" "up: update rows are fixed too, not only reads (campaign_samples.update)"
expect_fixed sm_out "up_other_untouched:0" "up: only Lab Member permissions change (validation, fields and other policies kept)"
expect_fixed sm_out "down_exact:0" "down: every permission row is back exactly as before up"
expect_fixed sm_out "down_backup_gone:true" "down: the backup table is dropped"
rm -f "$SOME_LINT"

echo "== Operator backfill is safe on an empty database =="
# The generated backfill maps legacy Machine_Operators ids to people by name. Only ids a run still
# points at are mapped, so a fresh database (as CI builds) neither fails the name check nor gains
# the NEW people. Each case runs the up SQL in its own rolled-back transaction (its temp table is
# ON COMMIT DROP, but a second CREATE in one transaction would clash).
OPB=$(migration operator_backfill)
opb_up=$(awk '/-- migrate:up/{f=1;next}/-- migrate:down/{f=0}f' "$OPB")
opb_fixture="INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('c0000123-0000-4000-8000-0000000000a1', 'T-C-OB', 'operator backfill test method');
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('c0000123-0000-4000-8000-0000000000d1', 'TEST-OB-001');"
opb_out=$($PSQL 2>&1 <<SQL
BEGIN;
UPDATE manufacturing_operations SET operator = NULL WHERE operator IS NOT NULL;
UPDATE test_sessions SET operator = NULL WHERE operator IS NOT NULL;
CREATE TEMP TABLE _opb_before AS SELECT count(*) AS n FROM people;
$opb_up
SELECT 'empty_people_unchanged:' || ((SELECT count(*) FROM people) = (SELECT n FROM _opb_before));
ROLLBACK;
SQL
)
expect_line opb_out "empty_people_unchanged:true" "no run points at an operator: up succeeds and adds no people"
opb_out=$($PSQL 2>&1 <<SQL
BEGIN;
$opb_fixture
INSERT INTO "Machine_Operators" (id) VALUES (121), (228) ON CONFLICT (id) DO NOTHING;
INSERT INTO people (person_id, full_name) VALUES ('c0000123-0000-4000-8000-0000000000f1', 'Nick Weston');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code, operator)
VALUES ('c0000123-0000-4000-8000-0000000000c1', 'c0000123-0000-4000-8000-0000000000a1', 'c0000123-0000-4000-8000-0000000000d1', 'TEST-OB-OP', 121);
INSERT INTO test_sessions (session_id, sample_id, operator)
VALUES ('c0000123-0000-4000-8000-0000000000e1', 'c0000123-0000-4000-8000-0000000000d1', 228);
$opb_up
SELECT 'map:' || operator_person_id FROM manufacturing_operations WHERE operation_id = 'c0000123-0000-4000-8000-0000000000c1';
SELECT 'new:' || p.full_name || '/' || p.is_operator FROM test_sessions s JOIN people p ON p.person_id = s.operator_person_id
 WHERE s.session_id = 'c0000123-0000-4000-8000-0000000000e1';
ROLLBACK;
SQL
)
expect_line opb_out "map:c0000123-0000-4000-8000-0000000000f1" "a referenced MAP operator is linked to its person"
expect_line opb_out "new:Kyle Marshall/true" "a referenced NEW operator gets a new operator person"
opb_out=$($PSQL 2>&1 <<SQL
BEGIN;
$opb_fixture
INSERT INTO "Machine_Operators" (id) VALUES (113) ON CONFLICT (id) DO NOTHING;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, pass_code, operator)
VALUES ('c0000123-0000-4000-8000-0000000000c1', 'c0000123-0000-4000-8000-0000000000a1', 'c0000123-0000-4000-8000-0000000000d1', 'TEST-OB-OP', 113);
$opb_up
ROLLBACK;
SQL
)
grep -qF "names missing or ambiguous in people: Xinzef" <<<"$opb_out" \
    && ok "a referenced operator whose person is missing still fails, naming only that person" \
    || bad "a referenced operator whose person is missing still fails, naming only that person (psql output: $opb_out)"
