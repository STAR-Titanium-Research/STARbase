# shellcheck shell=bash
# Sourced by tests/phase1_schema.sh after tests/schema/lib.sh; not run on its own.

echo "== Operation code rule: code_num, operation_code_for, the run number (T0b) =="
# One rolled-back transaction. Rows for operation_code_for are built in memory with jsonb_populate_record.
# CI has no FCT HP D machines (the live ones come from the Lab Equipment import), so two are created here.
OC_MIG=$(migration operation_code_rule)
oc_backfill=$(awk '/^-- runbackfill:start/{f=1;next}/^-- runbackfill:end/{f=0}f' "$OC_MIG" 2>/dev/null)
oc_guard=$(printf '%s\n' "$oc_backfill" | awk '/^DO \$\$/{f=1} f{print} f && /^END \$\$;/{exit}')
[[ -n "$oc_backfill" && -n "$oc_guard" ]] && ok "found the run-number back-fill and its guard in the migration" \
    || bad "could not extract the run-number back-fill / guard from $OC_MIG"
OC_E25='9a000000-0000-4000-8000-000000000025'
OC_E250='9a000000-0000-4000-8000-000000000250'
oc_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO equipment (equipment_id, equipment_code, equipment_name, equipment_type) VALUES
    ('$OC_E25',  'T-OC-FCT25',  'FCT HP D 25',  'FAST_Press'),
    ('$OC_E250', 'T-OC-FCT250', 'FCT HP D 250', 'FAST_Press');
INSERT INTO manufacturing_methods (method_id, method_code, method_name)
VALUES ('9a000000-0000-4000-8000-000000000001', 'T-OC-M', 'operation code rule test method');

SELECT 'cn:' || coalesce(code_num(0), '') || '|' || coalesce(code_num(0.05), '') || '|' || coalesce(code_num(1932.080), '')
    || '|' || coalesce(code_num(30.000), '') || '|' || coalesce(code_num(123456789), '') || '|' || coalesce(code_num(-5.50), '')
    || '|' || coalesce(code_num(NULL), '');

CREATE FUNCTION pg_temp.oc(j jsonb, s text DEFAULT 'TEST-OC-001') RETURNS text LANGUAGE sql AS
\$f\$ SELECT coalesce(operation_code_for(jsonb_populate_record(NULL::manufacturing_operations, j), s), '<null>') \$f\$;

SELECT 'm_full:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"F","operation_sequence":8,"machining_cutting_speed_m_per_min":30,"machining_feed_mm_per_rev":0.1,"machining_axial_depth_of_cut_mm":1}');
SELECT 'm_speed:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"F","operation_sequence":8,"machining_cutting_speed_m_per_min":30}');
SELECT 'm_none:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"F","operation_sequence":8}');
SELECT 'm_mt:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"MT-F","operation_sequence":8,"machining_cutting_speed_m_per_min":30}');
SELECT 'm_mm:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"MM-R","operation_sequence":8}');
SELECT 'm_word:' || pg_temp.oc('{"process_category":"machining","machining_operation_subtype":"facing","operation_sequence":8}');
SELECT 'ht:' || pg_temp.oc('{"process_category":"heat_treatment","ht_treatment_type":"anneal","operation_sequence":2,"ht_peak_temp_celsius":1050,"ht_hold_time_min":60,"ht_cooling_method":"furnace"}');
SELECT 'def:' || pg_temp.oc('{"process_category":"deformation","deform_deformation_type":"rolling","operation_sequence":3,"deform_deformation_temp_celsius":900,"deform_total_reduction_pct":50,"deform_pass_count":4}');
SELECT 'def_unknown:' || pg_temp.oc('{"process_category":"deformation","deform_deformation_type":"weird","operation_sequence":3}');
SELECT 'am:' || pg_temp.oc('{"process_category":"additive","operation_sequence":4,"am_laser_power_w":200,"am_scan_speed_mm_per_s":800,"am_layer_thickness_mm":0.03}');
SELECT 'sint_utc:' || pg_temp.oc('{"process_category":"sintering","equipment_id":"$OC_E25","sintering_run_number":9500,"operation_date":"2026-10-09T23:30:00Z","sintering_max_temp_celsius":1150,"sintering_max_force_kn":101,"sintering_mould_diameter_mm":80}', NULL);
SELECT 'sint_norun:' || pg_temp.oc('{"process_category":"sintering","equipment_id":"$OC_E25","operation_date":"2026-10-09T23:30:00Z","sintering_max_temp_celsius":1150}', NULL);
SELECT 'sint_src250:' || pg_temp.oc('{"process_category":"sintering","source_system":"fast_250","sintering_run_number":12,"operation_date":"2026-01-02T12:00:00Z"}', NULL);
SELECT 'sint_equip250:' || pg_temp.oc('{"process_category":"sintering","equipment_id":"$OC_E250","sintering_run_number":12,"operation_date":"2026-01-02T12:00:00Z"}', NULL);
SELECT 'prep:' || pg_temp.oc('{"process_category":"sample_prep","operation_sequence":5}');
SELECT 'nothing:' || pg_temp.oc('{}', NULL);

-- the back-fill, on FAST-shaped rows carrying their code and run only in pass_code / source_run_uid
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, source_run_uid, equipment_id, operation_date,
    sintering_max_temp_celsius, sintering_max_force_kn, sintering_mould_diameter_mm, pass_code) VALUES
    ('9a000000-0000-4000-8000-000000000101', '9a000000-0000-4000-8000-000000000001', 'sintering', 'fast_25', 'fast25|4624', '$OC_E25',
        '2016-10-12T10:00:00Z', 1200, 14, 20, '12-10-16-MF25-4624-1200C_14kN_20dia'),
    ('9a000000-0000-4000-8000-000000000102', '9a000000-0000-4000-8000-000000000001', 'sintering', 'fast_25', 'fast25|9686', '$OC_E25',
        '2025-02-13T08:00:00Z', NULL, NULL, NULL, '13-02-25-MF25-9686'),
    ('9a000000-0000-4000-8000-000000000103', '9a000000-0000-4000-8000-000000000001', 'sintering', 'fast_250', 'fast250|77', '$OC_E250',
        '2024-03-05T09:00:00Z', 1100, 30, NULL, '05-03-24-MF250-77-1100C_30kN');
SELECT 'bf_before:' || count(*) FROM manufacturing_operations WHERE operation_id::text LIKE '9a000000-0000-4000-8000-0000000001%' AND sintering_run_number IS NULL;
SAVEPOINT guard_test;
ALTER TABLE manufacturing_operations ENABLE ALWAYS TRIGGER mfg_op_short_id;
$oc_guard
ROLLBACK TO guard_test;
SELECT COALESCE(max(log_id), 0) AS lid FROM audit_logs \gset
$oc_backfill
SELECT 'bf_runs:' || string_agg(sintering_run_number::text, ',' ORDER BY operation_id) FROM manufacturing_operations
  WHERE operation_id::text LIKE '9a000000-0000-4000-8000-0000000001%';
SELECT 'bf_same:' || count(*) FILTER (WHERE operation_code_for(m, NULL) = m.pass_code) || '/' || count(*)
  FROM manufacturing_operations m WHERE operation_id::text LIKE '9a000000-0000-4000-8000-0000000001%';
SELECT 'bf_audit:' || count(*) FROM audit_logs WHERE log_id > :lid AND table_name = 'manufacturing_operations';
SELECT 'bf_triggers:' || count(*) FILTER (WHERE tgenabled <> 'O') FROM pg_trigger
  WHERE NOT tgisinternal AND tgrelid = 'manufacturing_operations'::regclass;

-- one operation per machine run
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number, operation_date, pass_code)
VALUES ('9a000000-0000-4000-8000-000000000111', '9a000000-0000-4000-8000-000000000001', 'sintering', 'test', '$OC_E25', 9500, '2026-10-09T23:30:00Z', 'TEST-OC-RUN-A');
DO \$\$ BEGIN
  INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number, operation_date, pass_code)
  VALUES ('9a000000-0000-4000-8000-000000000112', '9a000000-0000-4000-8000-000000000001', 'sintering', 'test', '$OC_E25', 9500, '2026-10-10T08:00:00Z', 'TEST-OC-RUN-B');
  RAISE NOTICE 'uniq_same:missing';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uniq_same:ok';
END \$\$;
DO \$\$ BEGIN
  INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number, operation_date, pass_code)
  VALUES ('9a000000-0000-4000-8000-000000000113', '9a000000-0000-4000-8000-000000000001', 'sintering', 'test', '$OC_E250', 9500, '2026-10-09T23:30:00Z', 'TEST-OC-RUN-C');
  RAISE NOTICE 'uniq_other:ok';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'uniq_other:refused';
END \$\$;
SELECT 'df:' || coalesce("group", '<null>') || '/' || coalesce(required::text, '<null>') || '/' || coalesce(hidden::text, '<null>') || '/' || count(*) OVER ()
  FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'sintering_run_number';
ROLLBACK;
SQL
)
expect_match oc_out "^cn:0|0.05|1932.08|30|123457000|-5.5|$" "code_num writes 6 significant digits without trailing zeros (0, 0.05, 1932.08, 30, 123457000, -5.5, NULL)"
expect_match oc_out "^m_full:TEST-OC-001-F8-30MPM_0.1feed_1DoC$" "machining code: sample, subtype + sequence, then the set parameters"
expect_match oc_out "^m_speed:TEST-OC-001-F8-30MPM$" "machining code with only the speed set"
expect_match oc_out "^m_none:TEST-OC-001-F8$" "machining code with no parameters"
expect_match oc_out "^m_mt:TEST-OC-001-F8-30MPM$" "machining code: a subtype stored as method code + letter (MT-F) gives the bare letter, as every stored code has it"
expect_match oc_out "^m_mm:TEST-OC-001-R8$" "machining code: MM-R gives R"
expect_match oc_out "^m_word:TEST-OC-001-facing8$" "machining code: a subtype without a method prefix is used as it is"
expect_match oc_out "^ht:TEST-OC-001-HTA2-1050C_60min_FC$" "heat treatment code"
expect_match oc_out "^def:TEST-OC-001-DR3-900C_50pct_4p$" "deformation code"
expect_match oc_out "^def_unknown:TEST-OC-001-D3$" "deformation code with an unknown type falls back to D"
expect_match oc_out "^am:TEST-OC-001-AM4-200W_800mmps_0.03mm$" "additive code without a process variant"
expect_match oc_out "^sint_utc:09-10-26-MF25-9500-1150C_101kN_80dia$" "sintering code: UTC date, machine from the equipment, run number"
expect_match oc_out "^sint_norun:<null>$" "sintering code is NULL without a run number (never invented)"
expect_match oc_out "^sint_src250:02-01-26-MF250-12$" "sintering code takes the machine from source_system when there is no equipment"
expect_match oc_out "^sint_equip250:02-01-26-MF250-12$" "sintering code: machine 250 from the equipment name"
expect_match oc_out "^prep:TEST-OC-001-5$" "a category without its own rule gives sample code + sequence"
expect_match oc_out "^nothing:<null>$" "no category and no sample gives NULL"
expect_match oc_out "^bf_before:3$" "(setup) the three FAST-shaped rows have no run number before the back-fill"
expect_match oc_out "is not in its normal state" "the run-number back-fill guard refuses a user trigger that is ENABLE ALWAYS"
expect_match oc_out "^bf_runs:4624,9686,77$" "the back-fill reads the run number from source_run_uid"
expect_match oc_out "^bf_same:3/3$" "operation_code_for reproduces the imported FAST code for every back-filled row"
expect_match oc_out "^bf_audit:0$" "the back-fill writes no audit rows"
expect_match oc_out "^bf_triggers:0$" "every user trigger on manufacturing_operations is enabled again after the back-fill"
expect_match oc_out "uniq_same:ok" "a second sintering operation with the same machine and run is refused"
expect_match oc_out "uniq_other:ok" "the same run number on the other machine is allowed"
expect_match oc_out "^df:sintering_machine_group/false/false/1$" "the run number field is in the sintering group, not required, not hidden"
echo "== Operation codes follow their fields (T0b) =="
# One rolled-back transaction. A person's typed code is kept; an automatic one is rebuilt from the
# rule (operation_code_for) whenever a field it is built from changes. Prefix 9b000000-0000-4000-8000-.
OT_MIG=$(migration operation_code_trigger)
ot_seqfill=$(awk '/^-- seqbackfill:start/{f=1;next}/^-- seqbackfill:end/{f=0}f' "$OT_MIG" 2>/dev/null)
[[ -n "$ot_seqfill" ]] && ok "found the sequence back-fill in the migration" \
    || bad "could not extract the sequence back-fill from $OT_MIG"
OT_P='9b000000-0000-4000-8000-'
ot_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('${OT_P}000000000001', 'TEST-OT-001'), ('${OT_P}000000000002', 'TEST-OT-002'), ('${OT_P}000000000003', 'TEST-OT-003'),
    ('${OT_P}000000000004', 'TEST-OT-004');
INSERT INTO manufacturing_methods (method_id, method_code, method_name) VALUES
    ('${OT_P}000000000011', 'T-OT-M1', 'operation code trigger test method 1'),
    ('${OT_P}000000000012', 'T-OT-M2', 'operation code trigger test method 2');
INSERT INTO equipment (equipment_id, equipment_code, equipment_name, equipment_type) VALUES
    ('${OT_P}000000000021', 'T-OT-FCT25',  'FCT HP D 25',  'FAST_Press'),
    ('${OT_P}000000000022', 'T-OT-FCT250', 'FCT HP D 250', 'FAST_Press');

-- new_auto: a machining operation without a code gets its number and the rule's code
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype,
    machining_cutting_speed_m_per_min, machining_feed_mm_per_rev, machining_axial_depth_of_cut_mm)
VALUES ('${OT_P}000000000101', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 'F', 30, 0.1, 1);
SELECT 'new_auto:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- param_follow
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 45 WHERE operation_id = '${OT_P}000000000101';
SELECT 'param_follow:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- resend: the same code written again changes nothing and the op stays automatic
UPDATE manufacturing_operations SET pass_code = pass_code WHERE operation_id = '${OT_P}000000000101';
SELECT 'resend:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET machining_feed_mm_per_rev = 0.2 WHERE operation_id = '${OT_P}000000000101';
SELECT 'resend_follow:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- notes: nothing the code is built from changed
UPDATE manufacturing_operations SET outcome_notes = 'just a note' WHERE operation_id = '${OT_P}000000000101';
SELECT 'notes:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- subtype_keeps_number
UPDATE manufacturing_operations SET machining_operation_subtype = 'R' WHERE operation_id = '${OT_P}000000000101';
SELECT 'subtype:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- sample_change: TEST-OT-002 already has one operation (number 1)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${OT_P}000000000102', '${OT_P}000000000011', '${OT_P}000000000002', 'machining', 'F');
SELECT 'other_first:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000102';
UPDATE manufacturing_operations SET sample_id = '${OT_P}000000000002' WHERE operation_id = '${OT_P}000000000101';
SELECT 'sample_change:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- method_change: a third operation on TEST-OT-002 raises the highest number to 3, so the moved one gets 4
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${OT_P}000000000103', '${OT_P}000000000011', '${OT_P}000000000002', 'machining', 'F');
UPDATE manufacturing_operations SET method_id = '${OT_P}000000000012' WHERE operation_id = '${OT_P}000000000101';
SELECT 'method_change:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- typed: a code a person wrote is kept, and later field changes leave it alone
UPDATE manufacturing_operations SET pass_code = 'MY-OP-CODE' WHERE operation_id = '${OT_P}000000000101';
SELECT 'typed:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 50 WHERE operation_id = '${OT_P}000000000101';
SELECT 'typed_kept:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- typed_equals_rule: writing exactly the rule's value makes it automatic again
SELECT operation_code_for(m, 'TEST-OT-002') AS rule_value FROM manufacturing_operations m WHERE operation_id = '${OT_P}000000000101' \gset
UPDATE manufacturing_operations SET pass_code = :'rule_value' WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 55 WHERE operation_id = '${OT_P}000000000101';
SELECT 'typed_equals_rule:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- cleared: NULL rebuilds from the rule
UPDATE manufacturing_operations SET pass_code = 'MY-OP-CODE' WHERE operation_id = '${OT_P}000000000101';
UPDATE manufacturing_operations SET pass_code = NULL WHERE operation_id = '${OT_P}000000000101';
SELECT 'cleared:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- placeholder: an old client's {seq} code counts as automatic (TEST-OT-001 has no operation left)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype, pass_code)
VALUES ('${OT_P}000000000111', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 'F', '{seq}-whatever');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype,
    machining_cutting_speed_m_per_min, pass_code)
VALUES ('${OT_P}000000000112', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 'F', 30, 'TEST-OT-001-F{seq}-30MPM');
SELECT 'placeholder_a:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000111';
SELECT 'placeholder_b:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000112';
-- clear_move: clearing the code in the same statement as a sample change still takes the next number there
UPDATE manufacturing_operations SET sample_id = '${OT_P}000000000001', pass_code = NULL WHERE operation_id = '${OT_P}000000000101';
SELECT 'clear_move:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000101';
-- legacy_kept: a stored code that is not the rule's value counts as typed
ALTER TABLE manufacturing_operations DISABLE TRIGGER mfg_op_set_code;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, machining_operation_subtype,
    machining_cutting_speed_m_per_min, machining_feed_mm_per_rev, machining_axial_depth_of_cut_mm, pass_code)
VALUES ('${OT_P}000000000121', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 9, 'F', 30, 0.05, 0.1, 'TEST-OT-001-F9-30MPM_0.05feed_0.1DoC_');
-- null_code_becomes_auto: no code yet counts as automatic, but only once something it is built from changes
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, machining_operation_subtype,
    machining_cutting_speed_m_per_min)
VALUES ('${OT_P}000000000122', '${OT_P}000000000011', '${OT_P}000000000001', 'machining', 20, 'F', 30);
ALTER TABLE manufacturing_operations ENABLE TRIGGER mfg_op_set_code;
UPDATE manufacturing_operations SET machining_feed_mm_per_rev = 0.07 WHERE operation_id = '${OT_P}000000000121';
SELECT 'legacy_kept:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000121';
UPDATE manufacturing_operations SET outcome_notes = 'a note' WHERE operation_id = '${OT_P}000000000122';
SELECT 'null_notes:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000122';
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 31 WHERE operation_id = '${OT_P}000000000122';
SELECT 'null_speed:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000122';
-- frozen: an experiment_sheet row keeps its code; a person may still rename it
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, source_system,
    machining_operation_subtype, machining_cutting_speed_m_per_min, pass_code)
VALUES ('${OT_P}000000000131', '${OT_P}000000000011', '${OT_P}000000000003', 'machining', 1, 'experiment_sheet', 'F', 30, 'EXP-SHEET-OLD');
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 60 WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = 'EXP-SHEET-RENAMED' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_typed:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
-- frozen: clearing the code (NULL, or blank) keeps the saved one; typing a new one stores it
UPDATE manufacturing_operations SET pass_code = NULL WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_clear:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = '   ' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_blank:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = 'X-{seq}-{mf}' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_placeholder:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
UPDATE manufacturing_operations SET pass_code = 'EXP-SHEET-RENAMED-2' WHERE operation_id = '${OT_P}000000000131';
SELECT 'frozen_retyped:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000131';
-- fast_follow: a FAST-shaped row follows its temperature
INSERT INTO manufacturing_operations (operation_id, method_id, process_category, source_system, equipment_id, sintering_run_number,
    operation_date, sintering_max_temp_celsius, sintering_max_force_kn, sintering_mould_diameter_mm, pass_code)
VALUES ('${OT_P}000000000141', '${OT_P}000000000011', 'sintering', 'fast_25', '${OT_P}000000000021', 4624,
    '2016-10-12T10:00:00Z', 1200, 14, 20, '12-10-16-MF25-4624-1200C_14kN_20dia');
UPDATE manufacturing_operations SET sintering_max_temp_celsius = 1250 WHERE operation_id = '${OT_P}000000000141';
SELECT 'fast_follow:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000141';
-- sinter_hand: a hand-made sintering operation has no code until it has a run number
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, equipment_id, operation_date)
VALUES ('${OT_P}000000000142', '${OT_P}000000000011', '${OT_P}000000000003', 'sintering', '${OT_P}000000000022', '2026-03-05T09:00:00Z');
SELECT 'sinter_hand_norun:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000142';
UPDATE manufacturing_operations SET sintering_run_number = 400 WHERE operation_id = '${OT_P}000000000142';
SELECT 'sinter_hand_run:' || pass_code FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000142';
-- an old client's {mf} placeholder is automatic too, and the run number is never invented
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, equipment_id, operation_date, pass_code)
VALUES ('${OT_P}000000000143', '${OT_P}000000000011', '${OT_P}000000000003', 'sintering', '${OT_P}000000000022', '2026-03-06T09:00:00Z', '06-03-26-MF{mf}');
SELECT 'mf_placeholder:' || coalesce(pass_code, '<null>') FROM manufacturing_operations WHERE operation_id = '${OT_P}000000000143';
-- seq_backfill: the extracted back-fill, run as the migration runs it (before mfg_op_set_code exists,
-- so with that trigger disabled; the other user triggers stay on). Imported rows keep a NULL sequence.
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, source_system, machining_operation_subtype, operation_sequence, pass_code) VALUES
    ('${OT_P}000000000151', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-F2_1-60MPM'),
    ('${OT_P}000000000152', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'N/R'),
    ('${OT_P}000000000153', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-F3_30MPM_0.05feed'),
    ('${OT_P}000000000154', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-F5-30MPM'),
    ('${OT_P}000000000155', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'F', 5, 'TEST-OT-004-F5-X'),
    ('${OT_P}000000000156', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-R', NULL, 'TEST-OT-004-R6-a'),
    ('${OT_P}000000000157', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-R', NULL, 'TEST-OT-004-R6-b'),
    ('${OT_P}000000000158', '${OT_P}000000000011', '${OT_P}000000000004', 'machining', 'test', 'MT-F', NULL, 'TEST-OT-004-7-x');
SELECT 'bf_before:' || count(*) FROM manufacturing_operations WHERE operation_id::text LIKE '${OT_P}00000000015%' AND operation_sequence IS NULL;
ALTER TABLE manufacturing_operations DISABLE TRIGGER mfg_op_set_code;
$ot_seqfill
ALTER TABLE manufacturing_operations ENABLE TRIGGER mfg_op_set_code;
SELECT 'bf_seq:' || string_agg(coalesce(operation_sequence::text, '<null>'), ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id::text LIKE '${OT_P}00000000015%';
SELECT 'bf_codes:' || string_agg(pass_code, ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id::text LIKE '${OT_P}00000000015%';
SELECT 'bf_ledger:' || count(*) || ':' || string_agg(filled::text, ',' ORDER BY filled) FROM d1_private.operation_sequence_backfill WHERE operation_id::text LIKE '${OT_P}%';
SELECT 'trg:' || count(*) FILTER (WHERE tgname = 'mfg_op_set_code' AND tgenabled = 'O')
    || '/' || count(*) FILTER (WHERE tgname = 'mfg_op_assign_numbers') FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = 'manufacturing_operations'::regclass;
ROLLBACK;
SQL
)
expect_line ot_out "new_auto:1:TEST-OT-001-F1-30MPM_0.1feed_1DoC" "a new machining operation gets number 1 and the rule's code"
expect_line ot_out "param_follow:1:TEST-OT-001-F1-45MPM_0.1feed_1DoC" "changing the speed rewrites the code and keeps the number"
expect_line ot_out "resend:TEST-OT-001-F1-45MPM_0.1feed_1DoC" "writing the same code again changes nothing"
expect_line ot_out "resend_follow:TEST-OT-001-F1-45MPM_0.2feed_1DoC" "an operation whose code was written again still follows its fields"
expect_line ot_out "notes:1:TEST-OT-001-F1-45MPM_0.2feed_1DoC" "changing only the notes leaves code and number alone"
expect_line ot_out "subtype:1:TEST-OT-001-R1-45MPM_0.2feed_1DoC" "changing the subtype keeps the number"
expect_line ot_out "other_first:1:TEST-OT-002-F1" "(setup) the first operation on TEST-OT-002 is number 1"
expect_line ot_out "sample_change:2:TEST-OT-002-R2-45MPM_0.2feed_1DoC" "moving to another sample takes that sample's next number"
expect_line ot_out "method_change:4:TEST-OT-002-R4-45MPM_0.2feed_1DoC" "changing the method takes the next number on the sample"
expect_line ot_out "typed:MY-OP-CODE" "a typed code is stored as written"
expect_line ot_out "typed_kept:MY-OP-CODE" "a typed code survives a later field change"
expect_line ot_out "typed_equals_rule:TEST-OT-002-R4-55MPM_0.2feed_1DoC" "writing exactly the rule's value keeps the operation automatic"
expect_line ot_out "cleared:TEST-OT-002-R4-55MPM_0.2feed_1DoC" "clearing the code rebuilds it from the rule"
expect_line ot_out "placeholder_a:1:TEST-OT-001-F1" "an old client's {seq}-whatever code is replaced by the rule's code"
expect_line ot_out "placeholder_b:2:TEST-OT-001-F2-30MPM" "an old client's code with a {seq} placeholder is replaced by the rule's code"
expect_line ot_out "clear_move:3:TEST-OT-001-R3-55MPM_0.2feed_1DoC" "clearing the code in the same statement as a sample change takes the next number on the new sample"
expect_line ot_out "legacy_kept:TEST-OT-001-F9-30MPM_0.05feed_0.1DoC_" "a stored code that is not the rule's value counts as typed and is kept"
expect_line ot_out "null_notes:<null>" "an operation with no code stays without one when only the notes change"
expect_line ot_out "null_speed:TEST-OT-001-F20-31MPM" "an operation with no code gets the rule's code once a field it is built from changes"
expect_line ot_out "frozen:EXP-SHEET-OLD" "an experiment_sheet operation keeps its code when a field changes"
expect_line ot_out "frozen_typed:EXP-SHEET-RENAMED" "a person can still rename an experiment_sheet operation"
expect_line ot_out "frozen_clear:EXP-SHEET-RENAMED" "clearing the code of an experiment_sheet operation keeps its code"
expect_line ot_out "frozen_blank:EXP-SHEET-RENAMED" "blanking the code of an experiment_sheet operation keeps its code"
expect_line ot_out "frozen_placeholder:EXP-SHEET-RENAMED" "writing a {seq}/{mf} placeholder to an experiment_sheet operation keeps its code"
expect_line ot_out "frozen_retyped:EXP-SHEET-RENAMED-2" "typing a new code on an experiment_sheet operation stores it"
expect_line ot_out "fast_follow:12-10-16-MF25-4624-1250C_14kN_20dia" "a FAST operation's code follows its temperature"
expect_line ot_out "sinter_hand_norun:<null>" "a hand-made sintering operation has no code before it has a run number"
expect_line ot_out "sinter_hand_run:05-03-26-MF250-400" "a run number gives it the code"
expect_line ot_out "mf_placeholder:<null>" "an old client's {mf} code is automatic: no run number, no code, no invented MF number"
expect_line ot_out "bf_before:7" "(setup) the seven back-fill candidates have no sequence"
expect_line ot_out "bf_seq:2,<null>,3,<null>,5,<null>,<null>,<null>" "the back-fill reads F2_1 as 2 and F3_30MPM_0.05feed as 3, and leaves N/R, a taken number, two candidates sharing one and a bare-digit token NULL"
expect_line ot_out "bf_codes:TEST-OT-004-F2_1-60MPM,N/R,TEST-OT-004-F3_30MPM_0.05feed,TEST-OT-004-F5-30MPM,TEST-OT-004-F5-X,TEST-OT-004-R6-a,TEST-OT-004-R6-b,TEST-OT-004-7-x" "the back-fill leaves every code as it was"
expect_line ot_out "bf_ledger:2:2,3" "the back-fill ledger holds exactly the two filled rows"
expect_line ot_out "trg:1/0" "mfg_op_set_code is on the table and mfg_op_assign_numbers is gone"
echo "== Sample code corrections reach operation codes; the code preview (T0b) =="
# One rolled-back transaction for the cascade and the preview (prefix 9c000000-0000-4000-8000-), then a
# two-session lock-order check on committed rows that are deleted afterwards.
CS_MIG=$(migration operation_code_cascade_and_preview)
[[ -f "$CS_MIG" ]] && ok "found migration 158" || bad "migration 158 is missing ($CS_MIG)"
CS_P='9c000000-0000-4000-8000-'
cs_out=$($PSQL 2>&1 <<SQL
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${CS_P}000000000001', 'TEST-OC-CAS');
INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category) VALUES
    ('${CS_P}000000000011', 'T-OC-M1', 'operation code cascade test machining', 'machining'),
    ('${CS_P}000000000012', 'T-OC-M2', 'operation code cascade test heat treatment', 'heat_treatment');
-- an automatic, a typed and a frozen operation on the sample, and a test coded on it (T0a)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype,
    machining_cutting_speed_m_per_min, machining_feed_mm_per_rev)
VALUES ('${CS_P}000000000101', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F', 30, 0.1);
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype, pass_code)
VALUES ('${CS_P}000000000102', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F', 'MY-TYPED-OC');
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, operation_sequence, source_system,
    machining_operation_subtype, pass_code)
VALUES ('${CS_P}000000000103', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 3, 'experiment_sheet', 'F', 'EXP-OLD-OC');
INSERT INTO test_sessions (session_id, test_type, sample_id) VALUES ('${CS_P}000000000201', 'sem', '${CS_P}000000000001');
SELECT 'cas_before:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
SELECT 'cas_test_before:' || test_code FROM test_sessions WHERE session_id = '${CS_P}000000000201';
UPDATE physical_samples SET sample_code = 'TEST-OC-CAS2' WHERE sample_id = '${CS_P}000000000001';
SELECT 'cascade_auto:' || operation_sequence || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
SELECT 'cascade_typed:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000102';
SELECT 'cascade_frozen:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000103';
SELECT 'cascade_tests_still:' || test_code FROM test_sessions WHERE session_id = '${CS_P}000000000201';
-- the renamed operation is still automatic: it follows a later field change
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 45 WHERE operation_id = '${CS_P}000000000101';
SELECT 'cascade_still_auto:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
-- a change that is not the code leaves the operations alone
UPDATE physical_samples SET nickname = 'nick' WHERE sample_id = '${CS_P}000000000001';
SELECT 'cascade_nick:' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';

-- preview_new: the preview of a new operation is what a real insert with those values then gets
SELECT preview_operation_code('{"process_category":"machining","sample_id":"${CS_P}000000000001","machining_operation_subtype":"F","machining_cutting_speed_m_per_min":30}'::jsonb, NULL, 'TEST-OC-CAS2') AS pn \gset
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype, machining_cutting_speed_m_per_min)
VALUES ('${CS_P}000000000104', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F', 30);
SELECT 'preview_new:' || (:'pn' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000104';
-- preview_edit: the preview of an edit is what the UPDATE then gives
SELECT preview_operation_code('{"machining_feed_mm_per_rev":0.2}'::jsonb, '${CS_P}000000000101', 'TEST-OC-CAS2') AS pe \gset
UPDATE manufacturing_operations SET machining_feed_mm_per_rev = 0.2 WHERE operation_id = '${CS_P}000000000101';
SELECT 'preview_edit:' || (:'pe' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000101';
-- preview_method: only a method, no category: the category comes from the method
SELECT preview_operation_code('{"method_id":"${CS_P}000000000011","sample_id":"${CS_P}000000000001","machining_operation_subtype":"F"}'::jsonb, NULL, 'TEST-OC-CAS2') AS pm \gset
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, machining_operation_subtype)
VALUES ('${CS_P}000000000105', '${CS_P}000000000011', '${CS_P}000000000001', 'F');
SELECT 'preview_method:' || (:'pm' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000105';
-- preview_method_edit: a saved operation moved to a heat-treatment method (category and number follow)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_P}000000000106', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F');
SELECT preview_operation_code('{"method_id":"${CS_P}000000000012"}'::jsonb, '${CS_P}000000000106', 'TEST-OC-CAS2') AS pme \gset
UPDATE manufacturing_operations SET method_id = '${CS_P}000000000012' WHERE operation_id = '${CS_P}000000000106';
SELECT 'preview_method_edit:' || (:'pme' = pass_code) || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000106';
-- derive_category_exact: the preview derives the category exactly as mfg_op_derive_category does
-- (A) method changed and a category passed along that equals the saved one: the trigger still derives
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_P}000000000107', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F');
SELECT preview_operation_code('{"method_id":"${CS_P}000000000012","process_category":"machining"}'::jsonb, '${CS_P}000000000107', 'TEST-OC-CAS2') AS pa \gset
UPDATE manufacturing_operations SET method_id = '${CS_P}000000000012', process_category = 'machining' WHERE operation_id = '${CS_P}000000000107';
SELECT 'preview_cat_a:' || (:'pa' = pass_code) || ':' || process_category || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000107';
-- (B) a saved operation whose category is NULL keeps it when only another value is edited
ALTER TABLE manufacturing_operations DISABLE TRIGGER mfg_op_derive_category;
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, machining_operation_subtype)
VALUES ('${CS_P}000000000108', '${CS_P}000000000011', '${CS_P}000000000001', 'F');
ALTER TABLE manufacturing_operations ENABLE TRIGGER mfg_op_derive_category;
SELECT preview_operation_code('{"machining_cutting_speed_m_per_min":30}'::jsonb, '${CS_P}000000000108', 'TEST-OC-CAS2') AS pb \gset
UPDATE manufacturing_operations SET machining_cutting_speed_m_per_min = 30 WHERE operation_id = '${CS_P}000000000108';
SELECT 'preview_cat_b:' || (:'pb' = pass_code) || ':' || coalesce(process_category, '<null>') || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000108';
-- (C) a category set to NULL on a saved operation stays NULL (the method did not change)
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_P}000000000109', '${CS_P}000000000011', '${CS_P}000000000001', 'machining', 'F');
SELECT preview_operation_code('{"process_category":null}'::jsonb, '${CS_P}000000000109', 'TEST-OC-CAS2') AS pc \gset
UPDATE manufacturing_operations SET process_category = NULL WHERE operation_id = '${CS_P}000000000109';
SELECT 'preview_cat_c:' || (:'pc' = pass_code) || ':' || coalesce(process_category, '<null>') || ':' || pass_code FROM manufacturing_operations WHERE operation_id = '${CS_P}000000000109';
-- no values and no saved row gives NULL, not an error; a NULL values object is read as empty
SELECT 'preview_empty:' || coalesce(preview_operation_code('{}'::jsonb, NULL, NULL), '<null>');
SELECT 'preview_nullvalues:' || coalesce(preview_operation_code(NULL, NULL, 'TEST-OC-CAS2'), '<null>');
-- the triggers' shape and the comments on every new object
SELECT 'shape:' || string_agg(tgname || '/' || (tgtype & 1) || '/' || (tgtype & 2) || '/' || (tgtype & 4) || '/' || (tgtype & 8) || '/' || (tgtype & 16)
    || '/' || (tgattr::text = '')::text || '/' || (tgqual IS NULL)::text || '/' || (obj_description(oid, 'pg_trigger') IS NOT NULL)::text, ',' ORDER BY tgname)
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'physical_samples'::regclass
  AND tgname IN ('physical_samples_rollup_lock', 'physical_samples_cascade_operation_codes');
SELECT 'shape_ops:' || string_agg(tgname || '/' || (tgtype & 1) || '/' || (tgtype & 2) || '/' || (tgtype & 4) || '/' || (tgtype & 8) || '/' || (tgtype & 16) || '/' || (tgattr::text = '')::text || '/' || (tgqual IS NULL)::text || '/' || (obj_description(oid, 'pg_trigger') IS NOT NULL)::text, ',' ORDER BY tgname)
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'manufacturing_operations'::regclass AND tgname = 'mfg_op_rollup_lock';
SELECT 'fn_comments:' || count(*) FILTER (WHERE obj_description(p.oid, 'pg_proc') IS NOT NULL) || '/' || count(*)
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('trg_physical_samples_rollup_lock', 'trg_cascade_operation_codes', 'preview_operation_code', 'trg_manufacturing_operations_rollup_lock');
ROLLBACK;
SQL
)
expect_line cs_out "cas_before:1:TEST-OC-CAS-F1-30MPM_0.1feed" "(setup) the automatic operation carries the sample's first code"
expect_line cs_out "cas_test_before:TEST-OC-CAS-SEM1" "(setup) the test on the sample carries the sample's first code"
expect_line cs_out "cascade_auto:1:TEST-OC-CAS2-F1-30MPM_0.1feed" "renaming the sample renames its automatic operation, sequence unchanged"
expect_line cs_out "cascade_typed:MY-TYPED-OC" "a typed operation code is kept when the sample is renamed"
expect_line cs_out "cascade_frozen:EXP-OLD-OC" "an experiment_sheet operation code is kept when the sample is renamed"
expect_line cs_out "cascade_tests_still:TEST-OC-CAS2-SEM1" "the test code cascade (T0a) still runs next to the operation cascade"
expect_line cs_out "cascade_still_auto:TEST-OC-CAS2-F1-45MPM_0.1feed" "a renamed operation is still automatic: it follows a later field change"
expect_line cs_out "cascade_nick:TEST-OC-CAS2-F1-45MPM_0.1feed" "a sample change that is not its code leaves operation codes alone"
expect_line cs_out "preview_new:true:TEST-OC-CAS2-F4-30MPM" "preview_operation_code of a new operation equals the code a real insert gets"
expect_line cs_out "preview_edit:true:TEST-OC-CAS2-F1-45MPM_0.2feed" "preview_operation_code of an edit equals the code the UPDATE gives"
expect_line cs_out "preview_method:true:TEST-OC-CAS2-F5" "a preview with only a method takes the category from the method, as the insert does"
expect_line cs_out "preview_method_edit:true:TEST-OC-CAS2-HT6" "a preview of a method change takes the new category and the next number, as the UPDATE does"
expect_line cs_out "preview_empty:<null>" "a preview of nothing is NULL"
expect_line cs_out "preview_nullvalues:TEST-OC-CAS2" "a NULL values object is read as empty"
expect_line cs_out "shape:physical_samples_cascade_operation_codes/1/0/0/0/16/true/true/true,physical_samples_rollup_lock/0/2/0/8/16/true/true/true" "the two triggers: row AFTER UPDATE and statement BEFORE UPDATE OR DELETE, no column list, no WHEN, commented"
expect_line cs_out "shape_ops:mfg_op_rollup_lock/0/2/4/8/16/true/true/true" "mfg_op_rollup_lock: statement BEFORE INSERT OR UPDATE OR DELETE, no column list, no WHEN, commented"
expect_line cs_out "fn_comments:4/4" "every new function has a comment"
expect_line cs_out "preview_cat_a:true:heat_treatment:TEST-OC-CAS2-HT7" "preview: a method change derives the category even when the same category is passed (as the UPDATE does)"
expect_line cs_out "preview_cat_b:true:<null>:TEST-OC-CAS2-8" "preview: a saved NULL category is not derived by an edit of another value (as the UPDATE)"
expect_line cs_out "preview_cat_c:true:<null>:TEST-OC-CAS2-9" "preview: a category set to NULL stays NULL (as the UPDATE)"

# lock_order: session A locks a sample row and, later in its transaction, refreshes the rollup (any
# operation write does); session B writes an operation of that sample (rollup lock, then the sample
# row). Without the statement-level trigger A takes the sample row first and B the rollup lock first:
# deadlock. With it A takes the rollup lock before locking the sample row, so B simply waits.
CS_L='9c000000-0000-4000-8000-0000000000'
$PSQL -c "
    DELETE FROM manufacturing_operations WHERE operation_id IN ('${CS_L}f1','${CS_L}f2');
    DELETE FROM physical_samples WHERE sample_id = '${CS_L}f0';
    DELETE FROM manufacturing_methods WHERE method_id = '${CS_L}fa';
" > /dev/null 2>&1 || true
cs_fx=$($PSQL -v ON_ERROR_STOP=1 -c "
    INSERT INTO manufacturing_methods (method_id, method_code, method_name, process_category)
    VALUES ('${CS_L}fa', 'T-OC-LK', 'operation code lock order test method', 'machining');
    INSERT INTO physical_samples (sample_id, sample_code) VALUES ('${CS_L}f0', 'TEST-OC-LOCK');
    INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
    VALUES ('${CS_L}f1', '${CS_L}fa', '${CS_L}f0', 'machining', 'F');
" 2>&1) && ok "(setup) lock-order fixtures committed" || bad "lock-order fixtures could not be committed: $cs_fx"
cs_a_log=$(mktemp); cs_b_log=$(mktemp)
psql "$DATABASE_URL" --no-psqlrc -q -v ON_ERROR_STOP=1 > "$cs_a_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL lock_timeout = '10s';
UPDATE physical_samples SET nickname = nickname WHERE sample_id = '${CS_L}f0';
SELECT pg_sleep(1.5);
UPDATE manufacturing_operations SET outcome_notes = 'lo-a' WHERE operation_id = '${CS_L}f1';
COMMIT;
SQL
cs_a_pid=$!
sleep 0.5
psql "$DATABASE_URL" --no-psqlrc -q -v ON_ERROR_STOP=1 > "$cs_b_log" 2>&1 <<SQL
BEGIN;
SET LOCAL lock_timeout = '10s';
INSERT INTO manufacturing_operations (operation_id, method_id, sample_id, process_category, machining_operation_subtype)
VALUES ('${CS_L}f2', '${CS_L}fa', '${CS_L}f0', 'machining', 'F');
COMMIT;
SQL
cs_b_rc=$?
wait "$cs_a_pid"; cs_a_rc=$?
[[ $cs_a_rc -eq 0 ]] && ok "lock_order: session A (sample row, then an operation write) committed" || bad "lock_order: session A failed: $(cat "$cs_a_log")"
[[ $cs_b_rc -eq 0 ]] && ok "lock_order: session B (operation insert on the same sample) committed" || bad "lock_order: session B failed: $(cat "$cs_b_log")"
if grep -qi "deadlock detected" "$cs_a_log" "$cs_b_log"; then bad "lock_order: deadlock detected: $(cat "$cs_a_log" "$cs_b_log")"; else ok "lock_order: no deadlock between a sample update and an operation insert"; fi
run_eq "lock_order: both writes landed, B's operation numbered after A's" \
    "SELECT string_agg(right(operation_id::text, 2) || ':' || coalesce(operation_sequence::text, ''), ',' ORDER BY operation_id) FROM manufacturing_operations WHERE operation_id IN ('${CS_L}f1','${CS_L}f2')" \
    "f1:1,f2:2"
rm -f "$cs_a_log" "$cs_b_log"
$PSQL -c "
    DELETE FROM manufacturing_operations WHERE operation_id IN ('${CS_L}f1','${CS_L}f2');
    DELETE FROM physical_samples WHERE sample_id = '${CS_L}f0';
    DELETE FROM manufacturing_methods WHERE method_id = '${CS_L}fa';
" > /dev/null 2>&1 || true
run_eq "lock_order: fixtures removed" "SELECT count(*) FROM physical_samples WHERE sample_code = 'TEST-OC-LOCK'" "0"
