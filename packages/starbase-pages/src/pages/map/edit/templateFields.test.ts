import { describe, expect, it } from 'vitest';
import type { DraftOperation, DraftTest } from '@d1/ui';
import { OPERATION_DEFS, TEST_DEFS } from './templateFields.fixtures';
import { allowedForTemplate, isSetting, neverInATemplate } from './templateFields';
import { cleanTemplateValues, templateValuesOf } from './templates';

const op = (values: Record<string, unknown>, existing = true): DraftOperation => ({ key: 'n1', kind: 'operation', workState: 'done', rows: [{ key: 'n2' }], values, ...(existing ? { existing: { id: 'o1', version: 1 } } : {}) }) as DraftOperation;
const test = (values: Record<string, unknown>): DraftTest => ({ key: 'n1', kind: 'test', workState: 'done', existing: { id: 't1', version: 1 }, values }) as DraftTest;

/** What a done FAST/SPS operation read from the database holds (the probe of the review: identity, files, owner and imports among the settings). */
const FAST_RECORD = {
	operation_id: 'o1', sample_id: 's1', output_sample_id: 's2', method_id: 'mf', process_category: 'sintering', equipment_id: 'fast1', operator_person_id: 'p1', owner: 'user-9',
	owner_person_id: 'p9', sintering_run_number: 412, sintering_recipe_number: 'R-7', sintering_batch_number: 'B-3', sintering_max_temp_celsius: 1450, sintering_max_force_kn: 30,
	sintering_mould_diameter_mm: 20, sintering_mass_grams: 14.2, sintering_voltage_at_max_t_v: 4.1, sintering_coshh_ref: 'C-1', source_system: 'fast-crawler', source_run_uid: 'u-1',
	source_recipe_id: 'rec1', fast_recipe_id: 'rec2', recorded_metadata: { a: 1 }, gcode_file: 'file-1', operation_date: '2026-10-01', work_state: 'done', pass_code: 'FAST-412',
	machining_legacy_machining_uid: 'old', version: 4, restricted: false,
};

describe('a recorded FAST/SPS operation as a template (a second one must be creatable: migration 156 makes machine + run number unique)', () => {
	const kept = templateValuesOf(op({}), FAST_RECORD, OPERATION_DEFS);

	it('keeps the method, machine, operator and the machine settings of the form', () => {
		expect(kept).toEqual({
			method_id: 'mf', process_category: 'sintering', equipment_id: 'fast1', operator_person_id: 'p1', sintering_recipe_number: 'R-7', sintering_max_temp_celsius: 1450,
			sintering_max_force_kn: 30, sintering_mould_diameter_mm: 20,
		});
	});

	it('never keeps the run number, the batch, the mass, the QA readings, the import, the recipes, the metadata, the owner or the file', () => {
		for (const f of ['sintering_run_number', 'sintering_batch_number', 'sintering_mass_grams', 'sintering_voltage_at_max_t_v', 'sintering_coshh_ref', 'source_system', 'source_run_uid', 'source_recipe_id', 'fast_recipe_id', 'recorded_metadata', 'owner', 'owner_person_id', 'gcode_file', 'machining_legacy_machining_uid']) {
			expect(kept, f).not.toHaveProperty(f);
		}
	});
});

describe('a recorded Conform run as a template', () => {
	const CONFORM_RECORD = {
		method_id: 'cf', process_category: 'conform', equipment_id: 'conform1', conform_run_number: 12, conform_feedstock: 'Ti swarf', conform_feedstock_form: 'swarf',
		conform_feed_mass_g: 410, conform_die_diameter_mm: 8, conform_tooling_id: 'AB-3', conform_wheel_speed_rpm: 5, conform_ips_setpoint_c: 300,
		conform_extrusion_length_mm: 900, conform_extrusion_mass_g: 380, conform_yield_pct: 92.7, conform_flash_mass_g: 12,
	};
	const kept = templateValuesOf(op({}), CONFORM_RECORD, OPERATION_DEFS);

	it('keeps the feedstock, die, tooling and setpoints', () => {
		expect(kept).toEqual({
			method_id: 'cf', process_category: 'conform', equipment_id: 'conform1', conform_feedstock: 'Ti swarf', conform_feedstock_form: 'swarf', conform_die_diameter_mm: 8,
			conform_tooling_id: 'AB-3', conform_wheel_speed_rpm: 5, conform_ips_setpoint_c: 300,
		});
	});
	it('never keeps the run number or what this run charged and produced', () => {
		for (const f of ['conform_run_number', 'conform_feed_mass_g', 'conform_extrusion_length_mm', 'conform_extrusion_mass_g', 'conform_yield_pct', 'conform_flash_mass_g']) {
			expect(kept, f).not.toHaveProperty(f);
		}
	});
});

describe('a done test as a template: results, status, files and codes never travel (one family at a time)', () => {
	const RESULTS: Record<string, Record<string, unknown>> = {
		tensile: { test_type: 'tensile', tensile_gauge_length_mm: 25, tensile_crosshead_speed_mm_per_min: 1, tensile_extensometer_used: true, tensile_yield_strength_mpa: 880, tensile_uts_mpa: 960, tensile_fracture_mode: 'cup-cone' },
		hardness: { test_type: 'hardness', hardness_hardness_scale: 'HV', hardness_load_gf: 500, hardness_mean_hardness: 351, hardness_std_dev_hardness: 4 },
		charpy: { test_type: 'charpy', charpy_notch_type: 'V', charpy_test_temp_celsius: -20, charpy_absorbed_energy_j: 61 },
		compression: { test_type: 'compression', compression_strain_rate_per_s: 0.001, compression_yield_strength_mpa: 700 },
		tribology: { test_type: 'tribology', tribology_normal_load_n: 10, tribology_coefficient_of_friction: 0.4 },
		fatigue: { test_type: 'fatigue', fatigue_max_stress_mpa: 500, fatigue_cycles_to_failure: 120000 },
		creep: { test_type: 'creep', creep_applied_stress_mpa: 200, creep_time_to_rupture_h: 33 },
		clemx: { test_type: 'clemx', clemx_etchant: 'Kroll', clemx_mean_grain_size_um: 12 },
		optical: { test_type: 'optical', optical_microscopy_etchant: 'Kroll', optical_microscopy_notable_features: 'twins' },
	};
	const PIPELINE = {
		status: 'analysed', summary_stats: { n: 3 }, plot_uris: ['s3://x'], data_file_uri: 's3://data', data_file_size_gb: 1.2, file_size_gb: 1.2, file_storage_pointer: 'p', capture_software: 'x',
		test_code_number: 17, test_code_type: 'TEN', test_code_is_manual: false, test_code_subject_collection: 'physical_samples', test_code_subject_id: 'sample-uuid', owner: 'user-9',
		owner_person_id: 'p9', equipment_id: 'inst1', operator_person_id: 'p1', session_date: '2026-10-01', work_state: 'done', test_code: 'T-17', notes: 'jaws',
	};
	const RESULT_FIELDS = [
		'tensile_yield_strength_mpa', 'tensile_uts_mpa', 'tensile_fracture_mode', 'hardness_mean_hardness', 'hardness_std_dev_hardness', 'charpy_absorbed_energy_j', 'compression_yield_strength_mpa',
		'tribology_coefficient_of_friction', 'fatigue_cycles_to_failure', 'creep_time_to_rupture_h', 'clemx_mean_grain_size_um', 'optical_microscopy_notable_features',
	];

	for (const [family, params] of Object.entries(RESULTS)) {
		it(`${family}: the type, the machine, the operator and the parameters stay; no result, status, file or code does`, () => {
			const out = templateValuesOf(test({}), { ...params, ...PIPELINE, session_id: 't1', version: 3 }, TEST_DEFS);
			expect(out.test_type).toBe(params.test_type);
			expect(out.equipment_id).toBe('inst1');
			expect(out.operator_person_id).toBe('p1');
			for (const f of Object.keys(PIPELINE)) if (!['equipment_id', 'operator_person_id'].includes(f)) expect(out, f).not.toHaveProperty(f);
			for (const f of RESULT_FIELDS) expect(out, f).not.toHaveProperty(f);
			// And what is kept is exactly the type, the setup and the parameters of this family.
			const setup = new Set(['test_type', 'equipment_id', 'operator_person_id']);
			const parameters = Object.keys(params).filter((f) => !RESULT_FIELDS.includes(f));
			expect(Object.keys(out).sort()).toEqual([...new Set([...setup, ...parameters])].sort());
		});
	}

	it('the "never whether it is done" promise is true of the status of a test', () => {
		expect(templateValuesOf(test({}), { test_type: 'tensile', status: 'analysed', work_state: 'done' }, TEST_DEFS)).toEqual({ test_type: 'tensile' });
	});
});

describe('the allow-list reads the form', () => {
	const byName = new Map(OPERATION_DEFS.map((d) => [d.field, d] as const));

	it('a field of a settings group is a setting; one of a results group, legacy, capture or who/where is not', () => {
		for (const f of ['machining_feed_mm_per_rev', 'machining_new_edge', 'ht_peak_temp_celsius', 'deform_total_reduction_pct', 'am_laser_power_w', 'sintering_max_temp_celsius']) expect(isSetting(f, byName), f).toBe(true);
		for (const f of ['sintering_voltage_at_max_t_v', 'machining_force_captured', 'nc_program_text', 'capture_software', 'planned_date', 'outcome_notes', 'pass_code', 'recorded_metadata']) expect(isSetting(f, byName), f).toBe(false);
	});

	it('a link to another record, a file or a read-only field is never a setting, and an unknown field is not one', () => {
		for (const f of ['fast_recipe_id', 'gcode_file', 'source_system', 'owner', 'data_files', 'additional_operators', 'no_such_field']) expect(isSetting(f, byName), f).toBe(false);
	});

	it('a settings field added to a group tomorrow is kept without a change here, a result field added to a results group is not', () => {
		const grown = [...TEST_DEFS, { field: 'tensile_poissons_ratio', type: 'decimal', schema: {}, meta: { group: 'grp_tensile_params' } }, { field: 'tensile_toughness_mj', type: 'decimal', schema: {}, meta: { group: 'grp_tensile_results' } }];
		const out = templateValuesOf(test({}), { test_type: 'tensile', tensile_poissons_ratio: 0.3, tensile_toughness_mj: 50 }, grown);
		expect(out).toEqual({ test_type: 'tensile', tensile_poissons_ratio: 0.3 });
	});

	it('the deny-list holds on its own, with no definitions: nothing known to be wrong is kept, the rest is not lost', () => {
		const out = allowedForTemplate('operation', { method_id: 'm', sintering_run_number: 4, owner: 'u', gcode_file: 'f', test_code_subject_id: 's', machining_feed_mm_per_rev: 0.2 }, []);
		expect(out).toEqual({ method_id: 'm', machining_feed_mm_per_rev: 0.2 });
		for (const f of ['sintering_run_number', 'source_system', 'owner', 'gcode_file', 'test_code_subject_id', 'test_code_number', 'status', 'data_file_uri', 'machining_legacy_x', 'x_notable_features', 'x_recipe_id']) expect(neverInATemplate(f), f).toBe(true);
		expect(neverInATemplate('machining_feed_mm_per_rev')).toBe(false);
	});
});

describe('values are cleaned again when a template is used', () => {
	it('drops a column the table no longer has and what the draft refuses, keeps the rest and a template\'s own notes', () => {
		const stale = { method_id: 'mf', equipment_id: 'e1', sintering_max_temp_celsius: 1400, dropped_in_a_migration: 1, operation_id: 'x', sintering_run_number: 3, owner: 'u', outcome_notes: 'kept on purpose' };
		expect(cleanTemplateValues('manufacturing_operations', stale, OPERATION_DEFS, { notes: true })).toEqual({ method_id: 'mf', equipment_id: 'e1', sintering_max_temp_celsius: 1400, outcome_notes: 'kept on purpose' });
		expect(cleanTemplateValues('manufacturing_operations', stale, OPERATION_DEFS)).not.toHaveProperty('outcome_notes');
	});
});
