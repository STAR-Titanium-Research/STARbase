-- migrate:up
-- Natural ("numeric-aware") ordering for the human-readable ID codes (issue #115).
--
-- The codes start with a running number and often end with one ("151-AG-MF-2026-10-1",
-- "9-AA-MR-2023-03-23-F10"). Under the default collation they sort as plain text, so
-- "1000-…" < "151-…" < "99-…" and "…-F10" < "…-F9". Directus (and any ORDER BY) sorts in
-- the column's collation, so we give each code column an ICU collation with numeric
-- ordering (und-u-kn): every run of digits compares as a number, anywhere in the string.
-- Equality and uniqueness are unchanged: the collation is deterministic, so two codes
-- are equal only when they are byte-for-byte identical.
--
-- Why the extra steps:
--   * Postgres refuses to change the collation of a column that a view or a generated
--     column reads. The seven views below read one or more code columns, so they are
--     dropped and recreated verbatim from their latest migrations (with their comments
--     and the text-to-SQL read grant). Their code columns then inherit the collation.
--     v_project_rollup selects o.* in a CTE, which Postgres expanded when migration 050
--     ran; it is written out here as that expansion, so the stored definition is unchanged
--     and the later columns' down migrations are not blocked by the view.
--   * The project rollup is covered too. v_project_rollup UNIONs the natural_sort codes
--     (pass_code, tool_code, sample_code, ...) with alloy_code and equipment_code, and the
--     project_rollup cache table (the one Directus shows, refreshed from the view) stores the
--     code as plain TEXT, so ordering it still compared text. The view's code column is now
--     explicitly COLLATE natural_sort (an explicit collation wins in a UNION, rather than
--     relying on the default collation losing the implicit-collation tie-break) and
--     project_rollup.code is natural_sort too. refresh_project_rollup() needs no change: it
--     copies the view's rows, and a collation only affects comparison, not the stored text.
--   * alloy_code, equipment_code and campaign_code are human-readable codes that Directus
--     lists and sorts ("FAST-2" < "FAST-10"), so they get natural_sort as well. Nothing else
--     depends on their collation: the unique indexes on alloy_code / equipment_code are
--     rebuilt (equality stays byte-wise) and the views that read them are dropped and
--     recreated here.
--   * code_sort (migration 085, a generated zero-padded copy of the code) reads
--     sample_code / pass_code, so it is dropped and re-added with the same expression,
--     same values and default collation. The Force App still sorts its sample picker on it.

CREATE COLLATION IF NOT EXISTS natural_sort (PROVIDER = ICU, LOCALE = 'und-u-kn');

COMMENT ON COLLATION natural_sort IS
    'ICU root collation with numeric ordering (und-u-kn): digit runs compare as numbers, so'
    ' 9-AA-… < 10-AA-… < 151-AA-… and …-F9 < …-F10. Deterministic (equality is byte-wise).'
    ' Used by the human-readable code columns (sample_code, pass_code, tool_code, …).';

-- 1. Drop everything that reads a code column.
DROP VIEW v_project_rollup;
DROP VIEW v_complete_sample_history;
DROP VIEW v_manufacturing_operations_full;
DROP VIEW v_sample_genealogy_flat;
DROP VIEW v_stock_provenance;
DROP VIEW v_test_sessions_full;
DROP VIEW v_tooling_hierarchy;

ALTER TABLE physical_samples DROP COLUMN code_sort;
ALTER TABLE manufacturing_operations DROP COLUMN code_sort;

-- 2. Switch the code columns to natural ordering (types unchanged).
ALTER TABLE physical_samples ALTER COLUMN sample_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE manufacturing_operations ALTER COLUMN pass_code TYPE VARCHAR(128) COLLATE natural_sort;
ALTER TABLE tools ALTER COLUMN tool_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE tool_boxes ALTER COLUMN tool_box_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE cutting_inserts ALTER COLUMN insert_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE insert_edges ALTER COLUMN edge_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE raw_stock_lots ALTER COLUMN lot_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE projects ALTER COLUMN project_code TYPE VARCHAR(32) COLLATE natural_sort;
ALTER TABLE materials ALTER COLUMN alloy_code TYPE VARCHAR(32) COLLATE natural_sort;
ALTER TABLE equipment ALTER COLUMN equipment_code TYPE VARCHAR(64) COLLATE natural_sort;
ALTER TABLE campaigns ALTER COLUMN campaign_code TYPE TEXT COLLATE natural_sort;
-- The project_rollup cache (migration 051) is what Directus lists; its code column is TEXT.
ALTER TABLE project_rollup ALTER COLUMN code TYPE TEXT COLLATE natural_sort;

-- 3. Re-add code_sort exactly as migration 085 defined it (default collation).
ALTER TABLE manufacturing_operations
    ADD COLUMN code_sort TEXT GENERATED ALWAYS AS (
        lpad(coalesce((regexp_match(pass_code, '^\d+'))[1], ''), 8, '0') || regexp_replace(coalesce(pass_code, ''), '^\d+', '')
    ) STORED;

ALTER TABLE physical_samples
    ADD COLUMN code_sort TEXT GENERATED ALWAYS AS (
        lpad(coalesce((regexp_match(sample_code, '^\d+'))[1], ''), 8, '0') || regexp_replace(coalesce(sample_code, ''), '^\d+', '')
    ) STORED;

CREATE INDEX manufacturing_operations_code_sort_idx ON manufacturing_operations (code_sort);
CREATE INDEX physical_samples_code_sort_idx ON physical_samples (code_sort);

COMMENT ON COLUMN manufacturing_operations.code_sort IS
    'Generated: pass_code with its leading number zero-padded to 8 digits (text sort key).'
    ' Superseded for ordering by the natural_sort collation on pass_code; kept for the'
    ' Force App, which sorts on it. Not for display.';
COMMENT ON COLUMN physical_samples.code_sort IS
    'Generated: sample_code with its leading number zero-padded to 8 digits (text sort key;'
    ' codes without a leading number sort first). Superseded for ordering by the natural_sort'
    ' collation on sample_code; kept for the Force App sample picker. Not for display.';

-- 4. Recreate the views verbatim.
-- v_complete_sample_history (verbatim from 20260618000012_views.sql)
CREATE VIEW v_complete_sample_history AS
SELECT
    ps.sample_id,
    ps.sample_code,
    ps.form,
    ps.mass_grams,
    ps.diameter_mm,
    ps.length_mm,
    ps.thickness_mm,
    ps.current_status,
    ps.manufactured_date,
    ps.export_controlled,
    ps.notes,
    ps.created_at,
    ps.updated_at,
    m.alloy_code,
    m.common_name                   AS material_name,
    m.iso_code                      AS material_iso_code,
    m.density_g_per_cm3,
    p.project_code,
    p.project_name,
    p.document_number               AS project_document_number
FROM physical_samples AS ps
LEFT JOIN materials AS m ON ps.material_id = m.material_id
LEFT JOIN projects AS p ON ps.project_id = p.project_id;

COMMENT ON VIEW v_complete_sample_history
    IS 'Flat sample profile with material and project context. Primary LLM target for'
       ' sample-centric queries. Join manufacturing_operations or test_sessions for events.';

-- v_tooling_hierarchy (verbatim from 20260618000012_views.sql)
CREATE VIEW v_tooling_hierarchy AS
SELECT
    tb.tool_box_id,
    tb.tool_box_code,
    tb.description                  AS tool_box_description,
    tb.location                     AS tool_box_location,
    ci.insert_id,
    ci.insert_code,
    ci.insert_number,
    ci.is_depleted                  AS insert_depleted,
    ie.edge_id,
    ie.edge_code,
    ie.edge_identifier,
    ie.is_used                      AS edge_used,
    it.type_code                    AS insert_type_code,
    it.manufacturer                 AS insert_manufacturer,
    it.substrate                    AS insert_substrate
FROM tool_boxes AS tb
LEFT JOIN cutting_inserts AS ci ON tb.tool_box_id = ci.tool_box_id
LEFT JOIN insert_edges AS ie ON ci.insert_id = ie.insert_id
LEFT JOIN insert_types AS it ON ci.insert_type_id = it.insert_type_id;

COMMENT ON VIEW v_tooling_hierarchy
    IS 'Full denormalized view of the 3-tier tooling hierarchy:'
       ' tool_boxes → cutting_inserts → insert_edges.';

-- v_sample_genealogy_flat (verbatim from 20260618000012_views.sql)
CREATE VIEW v_sample_genealogy_flat AS
SELECT
    sg.relationship_type,
    sg.fraction,
    child_s.sample_id               AS child_sample_id,
    child_s.sample_code             AS child_sample_code,
    child_s.form                    AS child_form,
    child_s.current_status          AS child_status,
    parent_s.sample_id              AS parent_sample_id,
    parent_s.sample_code            AS parent_sample_code,
    parent_s.form                   AS parent_form
FROM sample_genealogy AS sg
INNER JOIN physical_samples AS child_s ON sg.child_sample_id = child_s.sample_id
INNER JOIN physical_samples AS parent_s ON sg.parent_sample_id = parent_s.sample_id;

COMMENT ON VIEW v_sample_genealogy_flat
    IS 'Flat parent-child lineage pairs. For forward traceability:'
       ' WHERE parent_sample_code = ''...''. For reverse: WHERE child_sample_code = ''...''.';

-- v_manufacturing_operations_full (verbatim from 20260701000053_enrich_manufacturing_ops_view.sql; view comment from 20260618000012_views.sql)
CREATE VIEW v_manufacturing_operations_full AS
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

COMMENT ON COLUMN v_manufacturing_operations_full.process_category IS
    'Process type discriminator: which family of parameters applies (machining, sintering, additive, deformation, heat_treatment).';
COMMENT ON COLUMN v_manufacturing_operations_full.machining_operation_subtype IS
    'Machining sub-type (e.g. turning, milling) when process_category = machining.';
COMMENT ON VIEW v_manufacturing_operations_full
    IS 'Operations with fully denormalized method, sample, tooling, and project context.'
       ' Use recorded_metadata JSONB for method-specific parameters.';

-- v_stock_provenance (verbatim from 20260618000012_views.sql)
CREATE VIEW v_stock_provenance AS
SELECT
    ps.sample_id,
    ps.sample_code,
    rsl.lot_id,
    rsl.lot_code,
    rsl.stock_type,
    rsl.supplier_name,
    rsl.inbound_mass_grams,
    rsl.remaining_mass_grams,
    ssp.mass_used_grams,
    mat.alloy_code,
    mat.common_name                 AS material_name
FROM sample_stock_provenance AS ssp
INNER JOIN physical_samples AS ps ON ssp.sample_id = ps.sample_id
INNER JOIN raw_stock_lots AS rsl ON ssp.lot_id = rsl.lot_id
LEFT JOIN materials AS mat ON rsl.material_id = mat.material_id;

COMMENT ON VIEW v_stock_provenance
    IS 'Material provenance: which raw_stock_lots fed which physical_samples.'
       ' Enables full cradle-to-gate traceability from inbound receipt to sample.';

-- v_test_sessions_full (verbatim from 20260618000012_views.sql)
CREATE VIEW v_test_sessions_full AS
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

COMMENT ON VIEW v_test_sessions_full
    IS 'Test sessions with fully denormalized sample, equipment, and tooling context.'
       ' plot_uris and summary_stats are populated by the async heavy-data worker.';

-- v_project_rollup (verbatim from 20260629000050_project_rollup.sql; its o.* written out as 050 expanded it)
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
       'operation'::text AS kind, pass_code COLLATE natural_sort AS code,
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
GRANT SELECT ON
    v_complete_sample_history,
    v_tooling_hierarchy,
    v_sample_genealogy_flat,
    v_manufacturing_operations_full,
    v_stock_provenance,
    v_test_sessions_full,
    v_project_rollup
TO d1_llm_readonly;

-- migrate:down
DROP VIEW v_project_rollup;
DROP VIEW v_complete_sample_history;
DROP VIEW v_manufacturing_operations_full;
DROP VIEW v_sample_genealogy_flat;
DROP VIEW v_stock_provenance;
DROP VIEW v_test_sessions_full;
DROP VIEW v_tooling_hierarchy;

ALTER TABLE physical_samples DROP COLUMN code_sort;
ALTER TABLE manufacturing_operations DROP COLUMN code_sort;

ALTER TABLE physical_samples ALTER COLUMN sample_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE manufacturing_operations ALTER COLUMN pass_code TYPE VARCHAR(128) COLLATE pg_catalog."default";
ALTER TABLE tools ALTER COLUMN tool_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE tool_boxes ALTER COLUMN tool_box_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE cutting_inserts ALTER COLUMN insert_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE insert_edges ALTER COLUMN edge_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE raw_stock_lots ALTER COLUMN lot_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE projects ALTER COLUMN project_code TYPE VARCHAR(32) COLLATE pg_catalog."default";
ALTER TABLE materials ALTER COLUMN alloy_code TYPE VARCHAR(32) COLLATE pg_catalog."default";
ALTER TABLE equipment ALTER COLUMN equipment_code TYPE VARCHAR(64) COLLATE pg_catalog."default";
ALTER TABLE campaigns ALTER COLUMN campaign_code TYPE TEXT COLLATE pg_catalog."default";
ALTER TABLE project_rollup ALTER COLUMN code TYPE TEXT COLLATE pg_catalog."default";

ALTER TABLE manufacturing_operations
    ADD COLUMN code_sort TEXT GENERATED ALWAYS AS (
        lpad(coalesce((regexp_match(pass_code, '^\d+'))[1], ''), 8, '0') || regexp_replace(coalesce(pass_code, ''), '^\d+', '')
    ) STORED;

ALTER TABLE physical_samples
    ADD COLUMN code_sort TEXT GENERATED ALWAYS AS (
        lpad(coalesce((regexp_match(sample_code, '^\d+'))[1], ''), 8, '0') || regexp_replace(coalesce(sample_code, ''), '^\d+', '')
    ) STORED;

CREATE INDEX manufacturing_operations_code_sort_idx ON manufacturing_operations (code_sort);
CREATE INDEX physical_samples_code_sort_idx ON physical_samples (code_sort);

-- v_complete_sample_history (verbatim from 20260618000012_views.sql)
CREATE VIEW v_complete_sample_history AS
SELECT
    ps.sample_id,
    ps.sample_code,
    ps.form,
    ps.mass_grams,
    ps.diameter_mm,
    ps.length_mm,
    ps.thickness_mm,
    ps.current_status,
    ps.manufactured_date,
    ps.export_controlled,
    ps.notes,
    ps.created_at,
    ps.updated_at,
    m.alloy_code,
    m.common_name                   AS material_name,
    m.iso_code                      AS material_iso_code,
    m.density_g_per_cm3,
    p.project_code,
    p.project_name,
    p.document_number               AS project_document_number
FROM physical_samples AS ps
LEFT JOIN materials AS m ON ps.material_id = m.material_id
LEFT JOIN projects AS p ON ps.project_id = p.project_id;

COMMENT ON VIEW v_complete_sample_history
    IS 'Flat sample profile with material and project context. Primary LLM target for'
       ' sample-centric queries. Join manufacturing_operations or test_sessions for events.';

-- v_tooling_hierarchy (verbatim from 20260618000012_views.sql)
CREATE VIEW v_tooling_hierarchy AS
SELECT
    tb.tool_box_id,
    tb.tool_box_code,
    tb.description                  AS tool_box_description,
    tb.location                     AS tool_box_location,
    ci.insert_id,
    ci.insert_code,
    ci.insert_number,
    ci.is_depleted                  AS insert_depleted,
    ie.edge_id,
    ie.edge_code,
    ie.edge_identifier,
    ie.is_used                      AS edge_used,
    it.type_code                    AS insert_type_code,
    it.manufacturer                 AS insert_manufacturer,
    it.substrate                    AS insert_substrate
FROM tool_boxes AS tb
LEFT JOIN cutting_inserts AS ci ON tb.tool_box_id = ci.tool_box_id
LEFT JOIN insert_edges AS ie ON ci.insert_id = ie.insert_id
LEFT JOIN insert_types AS it ON ci.insert_type_id = it.insert_type_id;

COMMENT ON VIEW v_tooling_hierarchy
    IS 'Full denormalized view of the 3-tier tooling hierarchy:'
       ' tool_boxes → cutting_inserts → insert_edges.';

-- v_sample_genealogy_flat (verbatim from 20260618000012_views.sql)
CREATE VIEW v_sample_genealogy_flat AS
SELECT
    sg.relationship_type,
    sg.fraction,
    child_s.sample_id               AS child_sample_id,
    child_s.sample_code             AS child_sample_code,
    child_s.form                    AS child_form,
    child_s.current_status          AS child_status,
    parent_s.sample_id              AS parent_sample_id,
    parent_s.sample_code            AS parent_sample_code,
    parent_s.form                   AS parent_form
FROM sample_genealogy AS sg
INNER JOIN physical_samples AS child_s ON sg.child_sample_id = child_s.sample_id
INNER JOIN physical_samples AS parent_s ON sg.parent_sample_id = parent_s.sample_id;

COMMENT ON VIEW v_sample_genealogy_flat
    IS 'Flat parent-child lineage pairs. For forward traceability:'
       ' WHERE parent_sample_code = ''...''. For reverse: WHERE child_sample_code = ''...''.';

-- v_manufacturing_operations_full (verbatim from 20260701000053_enrich_manufacturing_ops_view.sql; view comment from 20260618000012_views.sql)
CREATE VIEW v_manufacturing_operations_full AS
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

COMMENT ON COLUMN v_manufacturing_operations_full.process_category IS
    'Process type discriminator: which family of parameters applies (machining, sintering, additive, deformation, heat_treatment).';
COMMENT ON COLUMN v_manufacturing_operations_full.machining_operation_subtype IS
    'Machining sub-type (e.g. turning, milling) when process_category = machining.';
COMMENT ON VIEW v_manufacturing_operations_full
    IS 'Operations with fully denormalized method, sample, tooling, and project context.'
       ' Use recorded_metadata JSONB for method-specific parameters.';

-- v_stock_provenance (verbatim from 20260618000012_views.sql)
CREATE VIEW v_stock_provenance AS
SELECT
    ps.sample_id,
    ps.sample_code,
    rsl.lot_id,
    rsl.lot_code,
    rsl.stock_type,
    rsl.supplier_name,
    rsl.inbound_mass_grams,
    rsl.remaining_mass_grams,
    ssp.mass_used_grams,
    mat.alloy_code,
    mat.common_name                 AS material_name
FROM sample_stock_provenance AS ssp
INNER JOIN physical_samples AS ps ON ssp.sample_id = ps.sample_id
INNER JOIN raw_stock_lots AS rsl ON ssp.lot_id = rsl.lot_id
LEFT JOIN materials AS mat ON rsl.material_id = mat.material_id;

COMMENT ON VIEW v_stock_provenance
    IS 'Material provenance: which raw_stock_lots fed which physical_samples.'
       ' Enables full cradle-to-gate traceability from inbound receipt to sample.';

-- v_test_sessions_full (verbatim from 20260618000012_views.sql)
CREATE VIEW v_test_sessions_full AS
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

COMMENT ON VIEW v_test_sessions_full
    IS 'Test sessions with fully denormalized sample, equipment, and tooling context.'
       ' plot_uris and summary_stats are populated by the async heavy-data worker.';

-- v_project_rollup (verbatim from 20260629000050_project_rollup.sql; its o.* written out as 050 expanded it)
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
GRANT SELECT ON
    v_complete_sample_history,
    v_tooling_hierarchy,
    v_sample_genealogy_flat,
    v_manufacturing_operations_full,
    v_stock_provenance,
    v_test_sessions_full,
    v_project_rollup
TO d1_llm_readonly;

-- The SQL linter (sqlfluff 3.2.4) cannot parse DROP COLLATION.
-- noqa: disable=PRS
DROP COLLATION natural_sort;
-- noqa: enable=PRS
