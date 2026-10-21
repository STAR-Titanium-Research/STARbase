// The shape of the real field definitions of manufacturing_operations and test_sessions (from `GET /fields/<collection>` on the local stack: the
// group each field is in, read-only, the interface), cut down to the families the tests need. Test data only, not imported by production code.

import type { FieldDef } from '@d1/ui';

interface Opts {
	group?: string | null;
	ro?: boolean;
	special?: string[];
	iface?: string;
	type?: string;
}
const col = (field: string, o: Opts = {}): FieldDef => ({
	field,
	type: o.type ?? 'string',
	schema: { is_nullable: true },
	meta: { group: o.group ?? null, readonly: !!o.ro, hidden: true, special: o.special ?? null, interface: o.iface ?? 'input' },
});
const m2o = (field: string, group: string | null = null): FieldDef => col(field, { group, special: ['m2o'], iface: 'select-dropdown-m2o', type: 'uuid' });
const grp = (field: string, parent: string | null = null): FieldDef => ({ field, type: 'alias', schema: null, meta: { group: parent, special: ['alias', 'no-data', 'group'], interface: 'group-detail' } });

export const OPERATION_DEFS: FieldDef[] = [
	col('operation_id', { ro: true }), m2o('sample_id', 'grp_what'), m2o('output_sample_id', 'grp_what'), m2o('method_id', 'grp_what'), m2o('project_id', 'grp_who_where'),
	m2o('equipment_id', 'grp_who_where'), m2o('tool_id', 'grp_tooling'), m2o('insert_edge_id', 'grp_tooling'), col('pass_code', { group: 'grp_what' }),
	col('operation_date', { group: 'grp_what', type: 'timestamp' }), col('planned_date', { group: 'grp_who_where', type: 'date' }),
	col('recorded_metadata', { type: 'json' }), col('capture_software', { group: 'grp_legacy' }), col('nc_program_text', { group: 'grp_legacy' }),
	col('force_file_id', { ro: true }), col('nc_program_file_uri', { ro: true }), col('outcome_notes', { group: 'grp_notes_files' }),
	col('process_category', { group: 'grp_what' }), col('machining_operation_subtype', { group: 'grp_what' }),
	col('machining_spindle_speed_rpm', { group: 'grp_cutting', type: 'decimal' }), col('machining_cutting_speed_m_per_min', { group: 'grp_cutting', type: 'decimal' }),
	col('machining_feed_mm_per_rev', { group: 'grp_cutting', type: 'decimal' }), col('machining_coolant_used', { group: 'grp_cutting', type: 'boolean' }),
	col('machining_new_edge', { group: 'grp_tooling', type: 'boolean' }), col('machining_chips_collected', { group: 'grp_cutting', type: 'boolean' }),
	col('machining_chips_ref_code', { group: 'grp_cutting' }), col('machining_force_captured', { group: 'grp_capture', type: 'boolean' }),
	col('machining_experiment_sheet_url'), col('machining_legacy_insert_edge_id', { group: 'grp_legacy' }), col('machining_legacy_machining_uid', { group: 'grp_legacy' }),
	col('sintering_recipe_number', { group: 'sintering_machine_group' }), col('sintering_batch_number', { group: 'sintering_machine_group' }),
	col('sintering_max_temp_celsius', { group: 'sintering_machine_group', type: 'decimal' }), col('sintering_max_force_kn', { group: 'sintering_machine_group', type: 'decimal' }),
	col('sintering_mould_diameter_mm', { group: 'sintering_machine_group', type: 'decimal' }), col('sintering_mass_grams', { group: 'sintering_machine_group', type: 'decimal' }),
	col('sintering_run_number', { group: 'sintering_machine_group', type: 'integer' }), m2o('fast_recipe_id', 'sintering_machine_group'),
	col('sintering_voltage_at_max_t_v', { group: 'sintering_qa_group', type: 'decimal' }), col('sintering_coshh_ref', { group: 'sintering_qa_group' }),
	col('ht_peak_temp_celsius', { group: 'grp_heat_treatment', type: 'decimal' }), col('ht_hold_time_min', { group: 'grp_heat_treatment', type: 'decimal' }),
	col('deform_total_reduction_pct', { group: 'grp_deformation', type: 'decimal' }), col('am_laser_power_w', { group: 'grp_additive', type: 'decimal' }),
	col('operator', { type: 'integer', special: ['m2o'], iface: 'select-dropdown-m2o' }), m2o('owner'), col('gcode_file', { special: ['file'], iface: 'file', type: 'uuid' }),
	col('source_run_uid', { ro: true }), col('source_system', { ro: true }), m2o('source_recipe_id', 'grp_sample_prep'), m2o('material_id', 'grp_who_where'),
	m2o('campaign_id', 'grp_who_where'), m2o('owner_person_id', 'grp_who_where'), m2o('operator_person_id', 'grp_who_where'), m2o('batch_id'),
	col('work_state', { group: 'grp_who_where', ro: true }), m2o('done_by_person_id', 'grp_who_where'), col('restricted', { ro: true, type: 'boolean' }),
	{ field: 'additional_operators', type: 'alias', schema: null, meta: { group: 'grp_who_where', special: ['m2m'], interface: 'list-m2m' } },
	{ field: 'data_files', type: 'alias', schema: null, meta: { group: null, special: ['files'], interface: 'files' } },
	grp('grp_what'), grp('grp_who_where'), grp('grp_cutting'), grp('grp_tooling'), grp('grp_legacy'), grp('grp_capture'), grp('grp_notes_files'), grp('grp_sample_prep'),
	col('conform_run_number', { group: 'grp_conform', type: 'integer' }), col('conform_feedstock', { group: 'grp_conform' }), col('conform_feedstock_form', { group: 'grp_conform' }),
	col('conform_feed_mass_g', { group: 'grp_conform', type: 'decimal' }), col('conform_die_diameter_mm', { group: 'grp_conform', type: 'decimal' }),
	col('conform_tooling_id', { group: 'grp_conform' }), col('conform_wheel_speed_rpm', { group: 'grp_conform', type: 'decimal' }),
	col('conform_ips_setpoint_c', { group: 'grp_conform', type: 'decimal' }), col('conform_extrusion_length_mm', { group: 'grp_conform', type: 'decimal' }),
	col('conform_extrusion_mass_g', { group: 'grp_conform', type: 'decimal' }), col('conform_yield_pct', { group: 'grp_conform', type: 'decimal' }),
	col('conform_flash_mass_g', { group: 'grp_conform', type: 'decimal' }), grp('grp_conform'),
	grp('grp_heat_treatment'), grp('grp_deformation'), grp('grp_additive'), grp('grp_sintering'), grp('sintering_machine_group', 'grp_sintering'), grp('sintering_qa_group', 'grp_sintering'),
];

export const TEST_DEFS: FieldDef[] = [
	col('session_id', { ro: true }), m2o('equipment_id', 'grp_who_where'), m2o('insert_edge_id'), m2o('project_id', 'grp_who_where'), col('session_date', { group: 'grp_what', type: 'timestamp' }),
	col('test_type', { group: 'grp_what' }), col('test_category', { group: 'grp_what' }), col('status', { group: 'grp_what' }), col('notes', { group: 'grp_notes_files' }),
	col('summary_stats', { ro: true, type: 'json' }), col('plot_uris', { ro: true, type: 'json' }), col('data_file_uri'), col('data_file_size_gb', { type: 'decimal' }),
	col('file_size_gb', { type: 'decimal' }), col('file_storage_pointer'), col('capture_software'),
	col('tensile_specimen_geometry', { group: 'grp_tensile_params' }), col('tensile_gauge_length_mm', { group: 'grp_tensile_params', type: 'decimal' }),
	col('tensile_crosshead_speed_mm_per_min', { group: 'grp_tensile_params', type: 'decimal' }), col('tensile_extensometer_used', { group: 'grp_tensile_params', type: 'boolean' }),
	col('tensile_yield_strength_mpa', { group: 'grp_tensile_results', type: 'decimal' }), col('tensile_uts_mpa', { group: 'grp_tensile_results', type: 'decimal' }),
	col('tensile_fracture_mode', { group: 'grp_tensile_results' }),
	col('hardness_hardness_scale', { group: 'grp_hardness_params' }), col('hardness_load_gf', { group: 'grp_hardness_params', type: 'decimal' }),
	col('hardness_mean_hardness', { group: 'grp_hardness_results', type: 'decimal' }), col('hardness_std_dev_hardness', { group: 'grp_hardness_results', type: 'decimal' }),
	col('charpy_notch_type', { group: 'grp_charpy_params' }), col('charpy_test_temp_celsius', { group: 'grp_charpy_params', type: 'decimal' }),
	col('charpy_absorbed_energy_j', { group: 'grp_charpy_results', type: 'decimal' }),
	col('compression_strain_rate_per_s', { group: 'grp_compression_params', type: 'decimal' }), col('compression_yield_strength_mpa', { group: 'grp_compression_result', type: 'decimal' }),
	col('tribology_normal_load_n', { group: 'grp_tribology_params', type: 'decimal' }), col('tribology_coefficient_of_friction', { group: 'grp_tribology_results', type: 'decimal' }),
	col('fatigue_max_stress_mpa', { group: 'grp_fatigue_params', type: 'decimal' }), col('fatigue_cycles_to_failure', { group: 'grp_fatigue_results', type: 'bigInteger' }),
	col('creep_applied_stress_mpa', { group: 'grp_creep_params', type: 'decimal' }), col('creep_time_to_rupture_h', { group: 'grp_creep_results', type: 'decimal' }),
	col('clemx_etchant', { group: 'grp_clemx_params' }), col('clemx_mean_grain_size_um', { group: 'grp_clemx_results', type: 'decimal' }),
	col('optical_microscopy_etchant', { group: 'grp_optical_microscopy_params' }), col('optical_microscopy_notable_features', { group: 'grp_optical_microscopy_results' }),
	col('tem_notable_features', { group: 'grp_tem_results' }),
	m2o('owner'), col('operator', { type: 'integer', special: ['m2o'], iface: 'select-dropdown-m2o' }), m2o('owner_person_id', 'grp_who_where'), m2o('operator_person_id', 'grp_who_where'),
	col('test_code', { group: 'grp_legacy' }), col('test_code_number', { ro: true, type: 'integer' }), col('test_code_type', { ro: true }), col('test_code_is_manual', { ro: true, type: 'boolean' }),
	col('test_code_subject_collection', { ro: true }), col('test_code_subject_id', { ro: true, type: 'uuid' }), col('restricted', { ro: true, type: 'boolean' }),
	col('work_state', { group: 'grp_who_where', ro: true }), m2o('batch_id'),
	grp('grp_what'), grp('grp_who_where'), grp('grp_notes_files'), grp('grp_legacy'), grp('grp_tensile_params'), grp('grp_tensile_results'), grp('grp_hardness_params'),
	grp('grp_hardness_results'), grp('grp_charpy_params'), grp('grp_charpy_results'), grp('grp_compression_params'), grp('grp_compression_result'), grp('grp_tribology_params'),
	grp('grp_tribology_results'), grp('grp_fatigue_params'), grp('grp_fatigue_results'), grp('grp_creep_params'), grp('grp_creep_results'), grp('grp_clemx_params'),
	grp('grp_clemx_results'), grp('grp_optical_microscopy_params'), grp('grp_optical_microscopy_results'), grp('grp_tem_results'),
];
