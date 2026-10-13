-- migrate:up
-- Project rollup carries the restricted flag (A1a Task 2c; spec docs/superpowers/specs/2026-10-12-record-access-design.md
-- section 3, "Everything attached follows its record"). project_rollup is a cache of v_project_rollup that the Explorer's
-- project page reads as the signed-in user. A Restricted record must not leak through it, so:
--   * project_rollup.restricted BOOLEAN NOT NULL DEFAULT false (default false: existing rows stay as visible as before);
--   * v_project_rollup gains `restricted` as its LAST column (CREATE OR REPLACE VIEW may only append), DERIVED FROM
--     d1_private.hidden_records (migration 166), not from the operation's own flags: an operation row is restricted iff the
--     operation is hidden (restricted, or under a restricted project, campaign or sample, including the sample's other campaigns
--     and the campaign's project); a sample row iff the sample is hidden; the tool, edge, insert, material and equipment rows are
--     derived from operations and are restricted only when EVERY operation behind them is (bool_and). The first attempt's own-flags
--     rule missed a restricted project's campaign, the sample's other campaigns and the sample's project. The view keeps its grant
--     to d1_llm_readonly and its comment;
--   * refresh_project_rollup() copies the column and takes the readers lock before its own (lock order: readers lock, then rollup
--     lock, as in 166); d1_private.refresh_readers() calls it whenever the hidden_records diff is not empty, which also covers
--     campaign_samples and projects.restricted, which fire no rollup trigger. A statement trigger on physical_samples UPDATE OF
--     restricted refreshes the cache too (the operations and campaigns triggers already do);
--   * the Lab Member read row of project_rollup: the PI of the project reads every row, an investigator (old table or
--     access role investigator) only restricted = false rows. Before this migration the rule had no restricted test
--     (the column did not exist), see migration 166. What it overwrites is kept in
--     d1_private.project_rollup_restricted_backup for `down`.
-- Apply TOGETHER WITH migration 166 and the Task 3 extensions (see 166's header); flush Redis and restart Directus.
-- Note for Task 5 (migration 168): v_project_rollup is granted to d1_llm_readonly and gets security_invoker there.
SET LOCAL lock_timeout = '10s';

ALTER TABLE project_rollup ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN project_rollup.restricted IS 'True when the row derives from a hidden record (d1_private.hidden_records: an operation that is restricted or under a restricted project, campaign or sample; a hidden sample; a tool, edge, insert, material or equipment used only by hidden operations). The Lab Member rule lets the project''s PI read every row and investigators only restricted = false rows.';

CREATE OR REPLACE VIEW v_project_rollup AS
WITH ops AS (
    -- o.* as migration 050 expanded it (later columns are not part of this view).
    SELECT o.operation_id, o.sample_id, o.method_id, o.project_id,
           o.equipment_id, o.tool_id, o.insert_edge_id, o.operator_name,
           o.operation_sequence, o.pass_code, o.operation_date, o.recorded_metadata,
           o.capture_software, o.capture_frequency_khz, o.file_storage_pointer, o.force_file_id,
           o.nc_program_text, o.nc_program_file_uri, o.outcome_notes, o.created_at,
           o.updated_at, o.version, o.process_category, o.machining_operation_subtype,
           o.machining_spindle_speed_rpm, o.machining_cutting_speed_m_per_min, o.machining_feed_mm_per_rev, o.machining_axial_depth_of_cut_mm,
           o.machining_radial_depth_of_cut_mm, o.machining_cutting_length_mm, o.machining_workpiece_diameter_mm, o.machining_new_edge,
           o.machining_coolant_used, o.machining_coolant_pressure_bar, o.machining_tacho_used, o.machining_force_captured,
           o.machining_chips_collected, o.machining_chips_ref_code, o.machining_experiment_sheet_url, o.machining_legacy_insert_edge_id,
           o.machining_legacy_machining_uid, o.sintering_recipe_number, o.sintering_batch_number, o.sintering_mould_diameter_mm,
           o.sintering_atmosphere, o.sintering_tc_pyro_control, o.sintering_max_temp_celsius, o.sintering_max_force_kn,
           o.sintering_voltage_at_max_t_v, o.sintering_power_at_max_t_kw, o.sintering_ptc_top_celsius, o.sintering_ptc_bot_celsius,
           o.sintering_coshh_ref, o.sintering_material_type_note, o.ht_treatment_type, o.ht_atmosphere,
           o.ht_peak_temp_celsius, o.ht_hold_time_min, o.ht_heating_rate_c_per_min, o.ht_cooling_method,
           o.ht_cooling_rate_c_per_min, o.ht_quench_medium, o.deform_deformation_type, o.deform_deformation_temp_celsius,
           o.deform_pass_count, o.deform_total_reduction_pct, o.deform_reduction_per_pass_pct, o.deform_strain_rate_per_sec,
           o.deform_roll_speed_m_per_min, o.deform_lubricant, o.am_process_variant, o.am_layer_thickness_mm,
           o.am_laser_power_w, o.am_scan_speed_mm_per_s, o.am_hatch_spacing_mm, o.am_energy_density_j_per_mm3,
           o.am_build_atmosphere, o.am_preheat_temp_celsius, o.operator, o.owner,
           o.output_sample_id, o.source_recipe_id, o.gcode_file, o.source_run_uid,
           o.source_system, o.sintering_mass_grams, o.material_id, o.campaign_id,
           COALESCE(o.project_id, c.project_id) AS proj,
           EXISTS (SELECT 1 FROM d1_private.hidden_records h
                    WHERE h.kind = 'manufacturing_operations' AND h.record_id = o.operation_id) AS op_restricted
    FROM manufacturing_operations o
    LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
    WHERE COALESCE(o.project_id, c.project_id) IS NOT NULL
)
SELECT md5('operation:' || operation_id::text) AS row_id, proj AS project_id,
       'operation'::text AS kind, pass_code AS code,
       machining_operation_subtype AS detail, campaign_id,
       op_restricted AS restricted -- noqa: RF04
FROM ops
UNION ALL
SELECT md5('tool:' || proj::text || ':' || t.tool_id::text), proj,
       'tool', t.tool_code, t.tool_name, NULL::uuid, bool_and(ops.op_restricted)
FROM ops JOIN tools t ON t.tool_id = ops.tool_id
GROUP BY proj, t.tool_id, t.tool_code, t.tool_name
UNION ALL
SELECT md5('edge:' || proj::text || ':' || e.edge_id::text), proj,
       'insert_edge', e.edge_code, NULL, NULL::uuid, bool_and(ops.op_restricted)
FROM ops JOIN insert_edges e ON e.edge_id = ops.insert_edge_id
GROUP BY proj, e.edge_id, e.edge_code
UNION ALL
SELECT md5('insert:' || proj::text || ':' || ci.insert_id::text), proj,
       'cutting_insert', ci.insert_code, NULL, NULL::uuid, bool_and(ops.op_restricted)
FROM ops JOIN insert_edges e ON e.edge_id = ops.insert_edge_id
         JOIN cutting_inserts ci ON ci.insert_id = e.insert_id
GROUP BY proj, ci.insert_id, ci.insert_code
UNION ALL
SELECT DISTINCT md5('sample:' || proj::text || ':' || s.sample_id::text), proj,
       'sample', s.sample_code, s.nickname, NULL::uuid,
       EXISTS (SELECT 1 FROM d1_private.hidden_records h WHERE h.kind = 'physical_samples' AND h.record_id = s.sample_id)
FROM ops JOIN physical_samples s ON s.sample_id = ops.sample_id
UNION ALL
SELECT md5('material:' || proj::text || ':' || m.material_id::text), proj,
       'material', m.alloy_code, m.common_name, NULL::uuid, bool_and(ops.op_restricted)
FROM ops JOIN materials m ON m.material_id = ops.material_id
GROUP BY proj, m.material_id, m.alloy_code, m.common_name
UNION ALL
SELECT md5('equipment:' || proj::text || ':' || eq.equipment_id::text), proj,
       'equipment', eq.equipment_code, eq.equipment_name, NULL::uuid, bool_and(ops.op_restricted)
FROM ops JOIN equipment eq ON eq.equipment_id = ops.equipment_id
GROUP BY proj, eq.equipment_id, eq.equipment_code, eq.equipment_name;

CREATE OR REPLACE FUNCTION refresh_project_rollup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Lock order (migration 166): the readers lock, then the rollup lock. Fixed keys; xact-scoped, released on COMMIT or ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtextextended('d1_readers', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('refresh_project_rollup', 0));
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id, restricted)
    SELECT row_id, project_id, kind, code, detail, campaign_id, restricted FROM v_project_rollup;
END;
$$;

CREATE TRIGGER refresh_rollup_samples
    AFTER UPDATE OF restricted ON physical_samples
    FOR EACH STATEMENT EXECUTE FUNCTION trg_refresh_project_rollup();
COMMENT ON TRIGGER refresh_rollup_samples ON physical_samples IS 'Flipping a sample''s restricted flag refreshes the project_rollup cache (its sample row and the operation rows under it carry the flag). Fires after physical_samples_readers_upd, which has already updated hidden_records.';

SELECT refresh_project_rollup();

-- The Lab Member rule of project_rollup (python3 scripts/gen_access_rules.py --values --only project_rollup).
CREATE SCHEMA IF NOT EXISTS d1_private;
CREATE TABLE IF NOT EXISTS d1_private.project_rollup_restricted_backup (
    id          INTEGER PRIMARY KEY,
    permissions JSON
);
COMMENT ON TABLE d1_private.project_rollup_restricted_backup IS
    'Migration 20261012000167: the Lab Member project_rollup read filter it replaced (directus_permissions.id, old permissions). `migrate:down` restores it and drops the table.';
INSERT INTO d1_private.project_rollup_restricted_backup (id, permissions)
SELECT p.id, p.permissions
  FROM directus_permissions p
 WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = 'project_rollup' AND p.action = 'read'
ON CONFLICT (id) DO NOTHING;
UPDATE directus_permissions p
   SET permissions = g.filter::json
  FROM (VALUES
    ('project_rollup', 'read', '{"_or":[{"project_id":{"principal_investigator_person":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"restricted":{"_eq":false}},{"_or":[{"project_id":{"secondary_investigators":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"project_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"project_id":{"access":{"role":{"_in":["investigator"]}}}}]}]}]}]}', '{}', '*')
  ) AS g (collection, action, filter, validation, fields)
 WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = g.collection AND p.action = g.action;

-- migrate:down
UPDATE directus_permissions p
   SET permissions = b.permissions
  FROM d1_private.project_rollup_restricted_backup b
 WHERE b.id = p.id;
DROP TABLE IF EXISTS d1_private.project_rollup_restricted_backup;

DROP TRIGGER IF EXISTS refresh_rollup_samples ON physical_samples;

CREATE OR REPLACE FUNCTION refresh_project_rollup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- Lock order (migration 166): the readers lock, then the rollup lock. Fixed keys; xact-scoped, released on COMMIT or ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtextextended('d1_readers', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('refresh_project_rollup', 0));
    DELETE FROM project_rollup;
    INSERT INTO project_rollup (row_id, project_id, kind, code, detail, campaign_id)
    SELECT row_id, project_id, kind, code, detail, campaign_id FROM v_project_rollup;
END;
$$;

-- A view cannot lose a column in place: drop it and make it again as migration 20261002000116 left it
-- (comment and the grant to the LLM role included).
DROP VIEW v_project_rollup;
CREATE VIEW v_project_rollup AS
WITH ops AS (
    -- o.* as migration 050 expanded it (later columns are not part of this view).
    SELECT o.operation_id, o.sample_id, o.method_id, o.project_id,
           o.equipment_id, o.tool_id, o.insert_edge_id, o.operator_name,
           o.operation_sequence, o.pass_code, o.operation_date, o.recorded_metadata,
           o.capture_software, o.capture_frequency_khz, o.file_storage_pointer, o.force_file_id,
           o.nc_program_text, o.nc_program_file_uri, o.outcome_notes, o.created_at,
           o.updated_at, o.version, o.process_category, o.machining_operation_subtype,
           o.machining_spindle_speed_rpm, o.machining_cutting_speed_m_per_min, o.machining_feed_mm_per_rev, o.machining_axial_depth_of_cut_mm,
           o.machining_radial_depth_of_cut_mm, o.machining_cutting_length_mm, o.machining_workpiece_diameter_mm, o.machining_new_edge,
           o.machining_coolant_used, o.machining_coolant_pressure_bar, o.machining_tacho_used, o.machining_force_captured,
           o.machining_chips_collected, o.machining_chips_ref_code, o.machining_experiment_sheet_url, o.machining_legacy_insert_edge_id,
           o.machining_legacy_machining_uid, o.sintering_recipe_number, o.sintering_batch_number, o.sintering_mould_diameter_mm,
           o.sintering_atmosphere, o.sintering_tc_pyro_control, o.sintering_max_temp_celsius, o.sintering_max_force_kn,
           o.sintering_voltage_at_max_t_v, o.sintering_power_at_max_t_kw, o.sintering_ptc_top_celsius, o.sintering_ptc_bot_celsius,
           o.sintering_coshh_ref, o.sintering_material_type_note, o.ht_treatment_type, o.ht_atmosphere,
           o.ht_peak_temp_celsius, o.ht_hold_time_min, o.ht_heating_rate_c_per_min, o.ht_cooling_method,
           o.ht_cooling_rate_c_per_min, o.ht_quench_medium, o.deform_deformation_type, o.deform_deformation_temp_celsius,
           o.deform_pass_count, o.deform_total_reduction_pct, o.deform_reduction_per_pass_pct, o.deform_strain_rate_per_sec,
           o.deform_roll_speed_m_per_min, o.deform_lubricant, o.am_process_variant, o.am_layer_thickness_mm,
           o.am_laser_power_w, o.am_scan_speed_mm_per_s, o.am_hatch_spacing_mm, o.am_energy_density_j_per_mm3,
           o.am_build_atmosphere, o.am_preheat_temp_celsius, o.operator, o.owner,
           o.output_sample_id, o.source_recipe_id, o.gcode_file, o.source_run_uid,
           o.source_system, o.sintering_mass_grams, o.material_id, o.campaign_id,
           COALESCE(o.project_id, c.project_id) AS proj
    FROM manufacturing_operations o
    LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
    WHERE COALESCE(o.project_id, c.project_id) IS NOT NULL
)
SELECT md5('operation:' || operation_id::text) AS row_id, proj AS project_id,
       'operation'::text AS kind, pass_code AS code,
       machining_operation_subtype AS detail, campaign_id
FROM ops
UNION ALL
SELECT DISTINCT md5('tool:' || proj::text || ':' || t.tool_id::text), proj,
       'tool', t.tool_code, t.tool_name, NULL::uuid
FROM ops JOIN tools t ON t.tool_id = ops.tool_id
UNION ALL
SELECT DISTINCT md5('edge:' || proj::text || ':' || e.edge_id::text), proj,
       'insert_edge', e.edge_code, NULL, NULL::uuid
FROM ops JOIN insert_edges e ON e.edge_id = ops.insert_edge_id
UNION ALL
SELECT DISTINCT md5('insert:' || proj::text || ':' || ci.insert_id::text), proj,
       'cutting_insert', ci.insert_code, NULL, NULL::uuid
FROM ops JOIN insert_edges e ON e.edge_id = ops.insert_edge_id
         JOIN cutting_inserts ci ON ci.insert_id = e.insert_id
UNION ALL
SELECT DISTINCT md5('sample:' || proj::text || ':' || s.sample_id::text), proj,
       'sample', s.sample_code, s.nickname, NULL::uuid
FROM ops JOIN physical_samples s ON s.sample_id = ops.sample_id
UNION ALL
SELECT DISTINCT md5('material:' || proj::text || ':' || m.material_id::text), proj,
       'material', m.alloy_code, m.common_name, NULL::uuid
FROM ops JOIN materials m ON m.material_id = ops.material_id
UNION ALL
SELECT DISTINCT md5('equipment:' || proj::text || ':' || eq.equipment_id::text), proj,
       'equipment', eq.equipment_code, eq.equipment_name, NULL::uuid
FROM ops JOIN equipment eq ON eq.equipment_id = ops.equipment_id;
COMMENT ON VIEW v_project_rollup
    IS 'Live read-only rollup of a project: operations (direct + via campaign) and the distinct tooling/samples/materials/equipment used. Provenance, not ownership.';
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN
        GRANT SELECT ON v_project_rollup TO d1_llm_readonly;
    END IF;
END
$do$;

ALTER TABLE project_rollup DROP COLUMN restricted;
SELECT refresh_project_rollup();
