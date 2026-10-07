-- migrate:up
-- Review finding 5.2: v_manufacturing_operations_full and v_test_sessions_full INNER JOINed
-- physical_samples on manufacturing_operations.sample_id / test_sessions.sample_id. Both columns
-- have been nullable for a long time (034: an operation can carry only output_sample_id; 063: a
-- test session's subject can be a non-sample item recorded in test_sessions_subject), so those
-- rows silently vanished from the views and every text-to-SQL count over them was too low
-- (reproduced: 3 operations in the table, 2 in the view; 1 test session vs 0).
--
-- The fix is LEFT JOIN physical_samples in both views. The column list, types and order are
-- unchanged (ps.sample_id / ps.sample_code simply become NULL for such rows), so
-- CREATE OR REPLACE VIEW is enough: nothing depends on either view, and the comments and the
-- text-to-SQL SELECT grant on the views survive. The bodies below are the definitions from
-- 20261002000116_natural_code_collation.sql, verbatim apart from that one join.

CREATE OR REPLACE VIEW v_manufacturing_operations_full AS
 SELECT mo.operation_id,
    mo.pass_code,
    mo.operation_date,
    mo.operation_sequence,
    mo.operator_name,
    mo.recorded_metadata,
    mo.capture_software,
    mo.capture_frequency_khz,
    mo.file_storage_pointer,
    mo.force_file_id,
    mo.outcome_notes,
    mo.created_at,
    ps.sample_id,
    ps.sample_code,
    mm.method_id,
    mm.method_name,
    mm.method_code,
    p.project_code,
    p.project_name,
    e.equipment_code,
    e.equipment_name,
    t.tool_code,
    ie.edge_code AS insert_edge_code,
    ci.insert_code,
    tb.tool_box_code,
    -- process discriminator + inline parameters (appended)
    mo.process_category,
    mo.machining_operation_subtype,
    mo.machining_feed_mm_per_rev,
    mo.machining_cutting_speed_m_per_min,
    mo.machining_spindle_speed_rpm,
    mo.machining_axial_depth_of_cut_mm,
    mo.machining_radial_depth_of_cut_mm,
    mo.machining_coolant_pressure_bar,
    mo.machining_workpiece_diameter_mm,
    mo.machining_cutting_length_mm,
    mo.am_process_variant,
    mo.am_laser_power_w,
    mo.am_scan_speed_mm_per_s,
    mo.am_energy_density_j_per_mm3,
    mo.am_hatch_spacing_mm,
    mo.am_layer_thickness_mm,
    mo.sintering_max_force_kn,
    mo.sintering_max_temp_celsius,
    mo.sintering_power_at_max_t_kw,
    mo.sintering_mould_diameter_mm,
    mo.deform_deformation_type,
    mo.deform_deformation_temp_celsius,
    mo.deform_strain_rate_per_sec,
    mo.deform_roll_speed_m_per_min,
    mo.deform_total_reduction_pct,
    mo.ht_treatment_type,
    mo.ht_peak_temp_celsius,
    mo.ht_heating_rate_c_per_min,
    mo.ht_cooling_rate_c_per_min,
    mo.ht_hold_time_min
   FROM manufacturing_operations mo
     LEFT JOIN physical_samples ps ON mo.sample_id = ps.sample_id
     JOIN manufacturing_methods mm ON mo.method_id = mm.method_id
     LEFT JOIN projects p ON mo.project_id = p.project_id
     LEFT JOIN equipment e ON mo.equipment_id = e.equipment_id
     LEFT JOIN tools t ON mo.tool_id = t.tool_id
     LEFT JOIN insert_edges ie ON mo.insert_edge_id = ie.edge_id
     LEFT JOIN cutting_inserts ci ON ie.insert_id = ci.insert_id
     LEFT JOIN tool_boxes tb ON ci.tool_box_id = tb.tool_box_id;

CREATE OR REPLACE VIEW v_test_sessions_full AS
SELECT
    ts.session_id,
    ts.session_date,
    ts.test_type,
    ts.operator_name,
    ts.capture_software,
    ts.capture_frequency_khz,
    ts.file_storage_pointer,
    ts.file_size_gb,
    ts.status,
    ts.summary_stats,
    ts.plot_uris,
    ts.notes,
    ts.created_at,
    ps.sample_id,
    ps.sample_code,
    p.project_code,
    p.project_name,
    e.equipment_code,
    e.equipment_name,
    ie.edge_code                    AS insert_edge_code,
    ci.insert_code,
    tb.tool_box_code
FROM test_sessions AS ts
LEFT JOIN physical_samples AS ps ON ts.sample_id = ps.sample_id
LEFT JOIN projects AS p ON ts.project_id = p.project_id
LEFT JOIN equipment AS e ON ts.equipment_id = e.equipment_id
LEFT JOIN insert_edges AS ie ON ts.insert_edge_id = ie.edge_id
LEFT JOIN cutting_inserts AS ci ON ie.insert_id = ci.insert_id
LEFT JOIN tool_boxes AS tb ON ci.tool_box_id = tb.tool_box_id;

-- CREATE OR REPLACE VIEW keeps the view comments set in migration 116.

-- migrate:down
-- Back to the INNER JOIN definitions from 20261002000116_natural_code_collation.sql. Rows
-- without a sample drop out of the views again; no data is changed.
CREATE OR REPLACE VIEW v_manufacturing_operations_full AS
 SELECT mo.operation_id,
    mo.pass_code,
    mo.operation_date,
    mo.operation_sequence,
    mo.operator_name,
    mo.recorded_metadata,
    mo.capture_software,
    mo.capture_frequency_khz,
    mo.file_storage_pointer,
    mo.force_file_id,
    mo.outcome_notes,
    mo.created_at,
    ps.sample_id,
    ps.sample_code,
    mm.method_id,
    mm.method_name,
    mm.method_code,
    p.project_code,
    p.project_name,
    e.equipment_code,
    e.equipment_name,
    t.tool_code,
    ie.edge_code AS insert_edge_code,
    ci.insert_code,
    tb.tool_box_code,
    -- process discriminator + inline parameters (appended)
    mo.process_category,
    mo.machining_operation_subtype,
    mo.machining_feed_mm_per_rev,
    mo.machining_cutting_speed_m_per_min,
    mo.machining_spindle_speed_rpm,
    mo.machining_axial_depth_of_cut_mm,
    mo.machining_radial_depth_of_cut_mm,
    mo.machining_coolant_pressure_bar,
    mo.machining_workpiece_diameter_mm,
    mo.machining_cutting_length_mm,
    mo.am_process_variant,
    mo.am_laser_power_w,
    mo.am_scan_speed_mm_per_s,
    mo.am_energy_density_j_per_mm3,
    mo.am_hatch_spacing_mm,
    mo.am_layer_thickness_mm,
    mo.sintering_max_force_kn,
    mo.sintering_max_temp_celsius,
    mo.sintering_power_at_max_t_kw,
    mo.sintering_mould_diameter_mm,
    mo.deform_deformation_type,
    mo.deform_deformation_temp_celsius,
    mo.deform_strain_rate_per_sec,
    mo.deform_roll_speed_m_per_min,
    mo.deform_total_reduction_pct,
    mo.ht_treatment_type,
    mo.ht_peak_temp_celsius,
    mo.ht_heating_rate_c_per_min,
    mo.ht_cooling_rate_c_per_min,
    mo.ht_hold_time_min
   FROM manufacturing_operations mo
     JOIN physical_samples ps ON mo.sample_id = ps.sample_id
     JOIN manufacturing_methods mm ON mo.method_id = mm.method_id
     LEFT JOIN projects p ON mo.project_id = p.project_id
     LEFT JOIN equipment e ON mo.equipment_id = e.equipment_id
     LEFT JOIN tools t ON mo.tool_id = t.tool_id
     LEFT JOIN insert_edges ie ON mo.insert_edge_id = ie.edge_id
     LEFT JOIN cutting_inserts ci ON ie.insert_id = ci.insert_id
     LEFT JOIN tool_boxes tb ON ci.tool_box_id = tb.tool_box_id;

CREATE OR REPLACE VIEW v_test_sessions_full AS
SELECT
    ts.session_id,
    ts.session_date,
    ts.test_type,
    ts.operator_name,
    ts.capture_software,
    ts.capture_frequency_khz,
    ts.file_storage_pointer,
    ts.file_size_gb,
    ts.status,
    ts.summary_stats,
    ts.plot_uris,
    ts.notes,
    ts.created_at,
    ps.sample_id,
    ps.sample_code,
    p.project_code,
    p.project_name,
    e.equipment_code,
    e.equipment_name,
    ie.edge_code                    AS insert_edge_code,
    ci.insert_code,
    tb.tool_box_code
FROM test_sessions AS ts
INNER JOIN physical_samples AS ps ON ts.sample_id = ps.sample_id
LEFT JOIN projects AS p ON ts.project_id = p.project_id
LEFT JOIN equipment AS e ON ts.equipment_id = e.equipment_id
LEFT JOIN insert_edges AS ie ON ts.insert_edge_id = ie.edge_id
LEFT JOIN cutting_inserts AS ci ON ie.insert_id = ci.insert_id
LEFT JOIN tool_boxes AS tb ON ci.tool_box_id = tb.tool_box_id;
