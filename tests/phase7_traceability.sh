#!/usr/bin/env bash
# Phase 7 traceability test: verifies the recursive lineage functions walk a
# sample's genealogy forward and backward without dead ends, resolve raw-stock
# origins, and produce a chronological event timeline.
# Requires a running Postgres with DATABASE_URL set, or a local stack via `make up`.
#
# Usage:  DATABASE_URL=postgres://d1:secret@localhost:5432/d1_test bash tests/phase7_traceability.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL must be set (e.g. postgres://d1:pw@localhost:5432/d1_db)}"
PSQL="psql $DATABASE_URL --no-psqlrc -t -A -v ON_ERROR_STOP=1"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run_eq() {
    local label="$1" sql="$2" expected="$3" result
    result=$($PSQL -c "$sql" 2>&1) || { bad "$label (psql error: $result)"; return; }
    [[ "$result" == "$expected" ]] && ok "$label" || bad "$label (got '$result', want '$expected')"
}

# The fixture rows below are removed again on exit (also after a failure or Ctrl-C), and any
# leftovers of an earlier killed run are removed first. Only the P7-* rows this script creates
# are touched. Rows written to audit_logs stay: it is append-only by design.
FIXTURE_CODES="'P7-BILLET','P7-DISC','P7-PIECE-A','P7-PIECE-B'"
# Also the diamond (P7-D-*) and ladder (P7-L-*) fixtures of the "visit each sample once" checks.
FIXTURE_MATCH="(sample_code IN ($FIXTURE_CODES) OR sample_code LIKE 'P7-D-%' OR sample_code LIKE 'P7-L-%')"
cleanup_fixture() {
    $PSQL -c "
BEGIN;
DELETE FROM test_sessions            WHERE sample_id IN (SELECT sample_id FROM physical_samples WHERE $FIXTURE_MATCH);
DELETE FROM manufacturing_operations WHERE sample_id IN (SELECT sample_id FROM physical_samples WHERE $FIXTURE_MATCH);
DELETE FROM sample_stock_provenance  WHERE sample_id IN (SELECT sample_id FROM physical_samples WHERE $FIXTURE_MATCH)
                                        OR lot_id IN (SELECT lot_id FROM raw_stock_lots WHERE lot_code = 'P7-LOT-001');
DELETE FROM sample_genealogy         WHERE child_sample_id  IN (SELECT sample_id FROM physical_samples WHERE $FIXTURE_MATCH)
                                        OR parent_sample_id IN (SELECT sample_id FROM physical_samples WHERE $FIXTURE_MATCH);
DELETE FROM physical_samples         WHERE $FIXTURE_MATCH;
DELETE FROM raw_stock_lots           WHERE lot_code = 'P7-LOT-001';
COMMIT;" >/dev/null
}
on_exit() {
    local status=$? err
    if ! err=$(cleanup_fixture 2>&1 >/dev/null); then
        printf '\033[31mFAIL\033[0m could not remove the P7-* fixture rows: %s\n' "$err" >&2
        status=1
    fi
    exit "$status"
}
trap on_exit EXIT

echo "== Traceability functions exist =="
for fn in f_trace_ancestors f_trace_descendants f_trace_stock_origins f_sample_timeline; do
    run_eq "$fn exists" \
        "SELECT proname FROM pg_proc WHERE proname = '$fn'" "$fn"
done

echo "== Build an isolated lineage fixture (BILLET → DISC → PIECE-A/B) =="
if ! cleanup_fixture >/dev/null 2>&1; then
    bad "could not clear leftover P7-* fixture rows from an earlier run"
    echo "Phase 7: $pass passed, $fail failed"
    exit 1
fi
# One DO block = one transaction: either the whole fixture exists or none of it. A failure
# here is fatal (every later check depends on it), not something to swallow.
if ! fixture_err=$($PSQL -c "
DO \$\$
DECLARE v_lot uuid; v_mid uuid; v_mat uuid;
        v_billet uuid; v_disc uuid; v_pa uuid; v_pb uuid;
BEGIN
  SELECT material_id INTO v_mat FROM materials LIMIT 1;
  SELECT method_id   INTO v_mid FROM manufacturing_methods LIMIT 1;
  INSERT INTO raw_stock_lots (lot_code, stock_type, supplier_name, material_id,
                              inbound_mass_grams, remaining_mass_grams)
    VALUES ('P7-LOT-001','billet','P7Supplier', v_mat, 10000, 5000)
    RETURNING lot_id INTO v_lot;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-BILLET','billet') RETURNING sample_id INTO v_billet;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-DISC','disc')     RETURNING sample_id INTO v_disc;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-PIECE-A','coupon') RETURNING sample_id INTO v_pa;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-PIECE-B','coupon') RETURNING sample_id INTO v_pb;
  INSERT INTO sample_genealogy (child_sample_id,parent_sample_id,relationship_type) VALUES
    (v_disc,v_billet,'cut_from'), (v_pa,v_disc,'cut_from'), (v_pb,v_disc,'cut_from');
  INSERT INTO sample_stock_provenance (sample_id,lot_id,mass_used_grams) VALUES (v_billet,v_lot,5000);
  INSERT INTO manufacturing_operations (sample_id,method_id,pass_code,operation_date,operator_name)
    VALUES (v_pa,v_mid,'P7-PIECE-A-F1','2026-01-10','alice');
  -- Use 'registered' (valid under both the old and new status constraints) so
  -- the CI full-rollback reversibility check is not blocked by this fixture row.
  INSERT INTO test_sessions (sample_id,test_type,session_date,status)
    VALUES (v_pa,'other','2026-01-12','registered');
END \$\$;
" 2>&1 >/dev/null); then
    bad "fixture creation failed: $fixture_err"
    echo "Phase 7: $pass passed, $fail failed (fixture missing; remaining checks skipped)"
    exit 1
fi
ok "fixture created"

PA="(SELECT sample_id FROM physical_samples WHERE sample_code='P7-PIECE-A')"
BILLET="(SELECT sample_id FROM physical_samples WHERE sample_code='P7-BILLET')"

echo "== Reverse traceability (ancestors) =="
run_eq "PIECE-A has 3 ancestor rows (self + DISC + BILLET)" \
    "SELECT count(*) FROM f_trace_ancestors($PA)" "3"
run_eq "PIECE-A root ancestor is the billet" \
    "SELECT sample_code FROM f_trace_ancestors($PA) ORDER BY depth DESC LIMIT 1" "P7-BILLET"

echo "== Cradle: raw-stock origins =="
run_eq "PIECE-A traces back to the originating lot" \
    "SELECT lot_code FROM f_trace_stock_origins($PA)" "P7-LOT-001"

echo "== Forward traceability (descendants) =="
run_eq "BILLET has 4 descendant rows (self + DISC + 2 pieces)" \
    "SELECT count(*) FROM f_trace_descendants($BILLET)" "4"
run_eq "BILLET reaches PIECE-A at depth 2" \
    "SELECT depth FROM f_trace_descendants($BILLET) WHERE sample_code='P7-PIECE-A'" "2"

echo "== Chronological timeline =="
run_eq "PIECE-A timeline has 2 events" \
    "SELECT count(*) FROM f_sample_timeline($PA)" "2"
run_eq "First timeline event is the manufacturing operation" \
    "SELECT event_type FROM f_sample_timeline($PA) ORDER BY event_date LIMIT 1" \
    "manufacturing_operation"

echo "== Genealogy walks visit each sample once (diamond, cycle, ladder) =="
# Diamond D-A -> D-B, D-A -> D-C, D-B -> D-D, D-C -> D-D (parent -> child): two paths from A to D.
# Cycle D-X -> D-Y -> D-Z -> D-X must terminate. Ladder: a top, 30 levels of two samples, a
# bottom, each level the parent of both samples of the next: 2^30 paths, 62 samples. Shortcut:
# D-S1 -> D-S2 -> D-S3 plus D-S1 -> D-S3, so D-S3 is at depth 1 through the direct edge. All inside
# one DO block (one transaction); the timing check raises when a walk takes 1 s or more.
if ! diamond_err=$($PSQL -c "
DO \$\$
DECLARE a uuid; b uuid; c uuid; d uuid; x uuid; y uuid; z uuid; s1 uuid; s2 uuid; s3 uuid; r record;
        top uuid; bottom uuid; prev uuid[]; cur uuid[]; i int; t0 timestamptz;
BEGIN
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-A','coupon') RETURNING sample_id INTO a;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-B','coupon') RETURNING sample_id INTO b;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-C','coupon') RETURNING sample_id INTO c;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-D','coupon') RETURNING sample_id INTO d;
  INSERT INTO sample_genealogy (child_sample_id,parent_sample_id,relationship_type,fraction) VALUES
    (b,a,'cut_from',0.5), (c,a,'cut_from',0.5), (d,b,'derived_from',0.25), (d,c,'sintered_from',0.75);
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-X','coupon') RETURNING sample_id INTO x;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-Y','coupon') RETURNING sample_id INTO y;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-Z','coupon') RETURNING sample_id INTO z;
  INSERT INTO sample_genealogy (child_sample_id,parent_sample_id) VALUES (y,x), (z,y), (x,z);

  IF (SELECT count(*) FROM f_trace_ancestors(d)) <> 4 THEN RAISE EXCEPTION 'diamond ancestors: want 4 rows'; END IF;
  IF (SELECT count(*) FROM f_trace_ancestors(d) WHERE sample_id = a) <> 1 THEN RAISE EXCEPTION 'diamond: A not exactly once'; END IF;
  IF (SELECT depth FROM f_trace_ancestors(d) WHERE sample_id = a) <> 2 THEN RAISE EXCEPTION 'diamond: A not at depth 2'; END IF;
  -- tie between B and C (both depth 1 parents of D, both parents of nothing else): lowest sample_id wins
  IF (SELECT path FROM f_trace_ancestors(d) WHERE sample_id = a) <> ARRAY[d, least(b,c), a] THEN
    RAISE EXCEPTION 'diamond: path to A is not the lowest-id shortest path'; END IF;
  IF (SELECT count(*) FROM f_trace_descendants(a)) <> 4 THEN RAISE EXCEPTION 'diamond descendants: want 4 rows'; END IF;
  IF (SELECT depth FROM f_trace_descendants(a) WHERE sample_id = d) <> 2 THEN RAISE EXCEPTION 'diamond: D not at depth 2'; END IF;
  -- the edge columns come from the edge that reached the sample on the reported path
  IF (SELECT fraction FROM f_trace_descendants(a) WHERE sample_id = d)
     IS DISTINCT FROM (SELECT fraction FROM sample_genealogy WHERE parent_sample_id = least(b,c) AND child_sample_id = d)
  THEN RAISE EXCEPTION 'diamond: edge fraction does not match the path'; END IF;

  -- the root row: depth 0, no edge, a one-element path
  SELECT * INTO r FROM f_trace_descendants(a) WHERE depth = 0;
  IF r.sample_id <> a OR r.relationship_type IS NOT NULL OR r.fraction IS NOT NULL OR r.path <> ARRAY[a] THEN
    RAISE EXCEPTION 'root row: want (0, a, NULL, NULL, {a}), got %', r; END IF;

  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-S1','coupon') RETURNING sample_id INTO s1;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-S2','coupon') RETURNING sample_id INTO s2;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-D-S3','coupon') RETURNING sample_id INTO s3;
  INSERT INTO sample_genealogy (child_sample_id,parent_sample_id,relationship_type,fraction) VALUES
    (s2,s1,'cut_from',0.5), (s3,s2,'cut_from',0.4), (s3,s1,'derived_from',0.9);
  SELECT * INTO r FROM f_trace_descendants(s1) WHERE sample_id = s3;
  IF r.depth <> 1 OR r.path <> ARRAY[s1, s3] OR r.relationship_type <> 'derived_from' OR r.fraction <> 0.9 THEN
    RAISE EXCEPTION 'shortcut: want S3 at depth 1 via the direct edge, got %', r; END IF;
  SELECT * INTO r FROM f_trace_ancestors(s3) WHERE sample_id = s1;
  IF r.depth <> 1 OR r.path <> ARRAY[s3, s1] THEN RAISE EXCEPTION 'shortcut ancestors: got %', r; END IF;

  IF (SELECT count(*) FROM f_trace_ancestors(x)) <> 3 THEN RAISE EXCEPTION 'cycle ancestors: want 3 rows'; END IF;
  IF (SELECT count(*) FROM f_trace_descendants(x)) <> 3 THEN RAISE EXCEPTION 'cycle descendants: want 3 rows'; END IF;
  IF (SELECT count(*) FROM f_trace_ancestors(gen_random_uuid())) <> 0 THEN RAISE EXCEPTION 'unknown sample: want 0 rows'; END IF;

  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-L-TOP','coupon') RETURNING sample_id INTO top;
  prev := ARRAY[top];
  FOR i IN 1..30 LOOP
    cur := '{}';
    FOR k IN 0..1 LOOP
      INSERT INTO physical_samples (sample_code, form) VALUES ('P7-L-' || i || '-' || k, 'coupon') RETURNING sample_id INTO x;
      cur := cur || x;
      INSERT INTO sample_genealogy (child_sample_id,parent_sample_id) SELECT x, p FROM unnest(prev) AS p;
    END LOOP;
    prev := cur;
  END LOOP;
  INSERT INTO physical_samples (sample_code, form) VALUES ('P7-L-BOTTOM','coupon') RETURNING sample_id INTO bottom;
  INSERT INTO sample_genealogy (child_sample_id,parent_sample_id) SELECT bottom, p FROM unnest(prev) AS p;

  t0 := clock_timestamp();
  IF (SELECT count(*) FROM f_trace_ancestors(bottom)) <> 62 THEN RAISE EXCEPTION 'ladder ancestors: want 62 rows'; END IF;
  IF clock_timestamp() - t0 >= interval '1 second' THEN RAISE EXCEPTION 'ladder ancestors took %', clock_timestamp() - t0; END IF;
  IF (SELECT depth FROM f_trace_ancestors(bottom) WHERE sample_id = top) <> 31 THEN RAISE EXCEPTION 'ladder: top not at depth 31'; END IF;
  t0 := clock_timestamp();
  IF (SELECT count(*) FROM f_trace_descendants(top)) <> 62 THEN RAISE EXCEPTION 'ladder descendants: want 62 rows'; END IF;
  IF clock_timestamp() - t0 >= interval '1 second' THEN RAISE EXCEPTION 'ladder descendants took %', clock_timestamp() - t0; END IF;
  IF (SELECT count(DISTINCT sample_id) FROM f_trace_descendants(top)) <> 62 THEN RAISE EXCEPTION 'ladder: a sample repeats'; END IF;
END \$\$;
" 2>&1 >/dev/null); then
    bad "diamond / cycle / ladder checks failed: $diamond_err"
else
    ok "diamond: A once at depth 2 from D (and D once from A), lowest-id shortest path, edge matches"
    ok "root row is depth 0 with no edge; a direct shortcut edge wins over a longer route"
    ok "cycle terminates with each sample once, in both directions; unknown sample gives no rows"
    ok "30-level ladder (2^30 paths): 62 rows in under 1 s, both directions, each sample once"
fi

echo
echo "Phase 7: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
