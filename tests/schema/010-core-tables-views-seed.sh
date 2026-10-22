# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Core tables exist =="
for tbl in \
    alloying_elements material_iso_classifications materials \
    manufacturing_methods equipment tools insert_types \
    projects raw_stock_lots \
    tool_boxes cutting_inserts insert_edges \
    physical_samples sample_genealogy sample_stock_provenance \
    manufacturing_operations test_sessions audit_logs
do
    run "$tbl exists" \
        "SELECT to_regclass('public.$tbl')::TEXT"
done

echo "== Views exist =="
for view in \
    v_complete_sample_history v_tooling_hierarchy v_sample_genealogy_flat \
    v_manufacturing_operations_full v_stock_provenance v_test_sessions_full \
    v_project_rollup
do
    run "$view exists" \
        "SELECT to_regclass('public.$view')::TEXT"
done

echo "== Extensions loaded =="
run "uuid-ossp"  "SELECT extname FROM pg_extension WHERE extname = 'uuid-ossp'"
run "vector"     "SELECT extname FROM pg_extension WHERE extname = 'vector'"
run "pg_trgm"    "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'"

echo "== Seed data present =="
run "ISO groups seeded" \
    "SELECT iso_code FROM material_iso_classifications WHERE iso_code = 'S'"
run "Ti-6Al-4V seeded" \
    "SELECT alloy_code FROM materials WHERE alloy_code = 'AA'"
run "FAST method seeded" \
    "SELECT method_code FROM manufacturing_methods WHERE method_code = 'MF'"
# migration 129 back-fills process_category before the seed runs on a fresh install, so the seed carries it
run_eq "seeded methods carry the process_category migration 129 maps" \
    "SELECT string_agg(method_code || '=' || COALESCE(process_category, 'NULL'), ',' ORDER BY method_code)
       FROM manufacturing_methods WHERE method_code IN ('HT','MC','MF','MM','MO','MR')" \
    "HT=heat_treatment,MC=machining,MF=sintering,MM=machining,MO=deformation,MR=deformation"
run "Equipment seeded" \
    "SELECT equipment_code FROM equipment WHERE equipment_code = 'NLX-2500'"
echo "== Code-generation functions =="
run_eq "generate_sample_code" \
    "SELECT generate_sample_code(10, 'AA', 'MF', '2023-06-03'::DATE)" \
    "10-AA-MF-2023-06-03"

run_eq "generate_pass_code" \
    "SELECT generate_pass_code('9-AA-MR-2023-03-23', 'F', 9)" \
    "9-AA-MR-2023-03-23-F9"

run_eq "generate_force_file_id" \
    "SELECT generate_force_file_id('9-AA-MR-2023-03-23-F9', 20, 0.05, 0.1)" \
    "9-AA-MR-2023-03-23-F9-20MPM_0.05feed_0.1DoC"
