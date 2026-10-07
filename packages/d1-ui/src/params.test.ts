import { describe, expect, it } from 'vitest';
import { fieldLabel, fieldUnit, paramColumns, paramFields, paramPrefix, paramRows, type ParamFieldDef } from './params';

const showWhen = (discriminator: string, value: string) => [
	{ name: `show when ${value}`, hidden: false, rule: { _and: [{ [discriminator]: { _eq: value } }] } },
];

interface Spec {
	type?: string;
	suffix?: string;
	label?: string;
	when?: string;
	sort?: number;
	choices?: { text: string; value: string }[];
}

const op = (field: string, s: Spec = {}): ParamFieldDef => ({
	field,
	type: s.type ?? 'decimal',
	meta: {
		sort: s.sort ?? 0,
		options: s.suffix || s.choices ? { suffix: s.suffix, choices: s.choices } : null,
		translations: s.label ? [{ language: 'en-US', translation: s.label }] : null,
		conditions: s.when ? showWhen('process_category', s.when) : null,
	},
});

const defs: ParamFieldDef[] = [
	op('machining_feed_mm_per_rev', { suffix: 'mm/rev', label: 'Feed', when: 'machining', sort: 2 }),
	op('machining_spindle_speed_rpm', { suffix: 'rpm', label: 'Spindle speed', when: 'machining', sort: 1 }),
	op('machining_coolant_used', { type: 'boolean', label: 'Coolant Used?', when: 'machining', sort: 3 }),
	op('sintering_max_temp_celsius', { suffix: '°C', label: 'Max temperature', when: 'sintering' }),
	op('sintering_batch_number', { type: 'string', when: 'sintering' }),
	op('ht_cooling_method', {
		type: 'string',
		when: 'heat_treatment',
		choices: [{ text: 'Water quench', value: 'water_quench' }],
	}),
	op('pass_code', { type: 'string' }),
	{ field: 'machining_buttons', schema: null, meta: { conditions: showWhen('process_category', 'machining') } },
];

describe('fieldUnit and fieldLabel', () => {
	it('reads the unit from the input suffix', () => {
		expect(fieldUnit(defs[0])).toBe('mm/rev');
		expect(fieldUnit(defs[3])).toBe('°C');
		expect(fieldUnit(defs[4])).toBe('');
	});
	it('prefers the English translation and drops a trailing question mark', () => {
		expect(fieldLabel(defs[0])).toBe('Feed');
		expect(fieldLabel(defs[2])).toBe('Coolant Used');
	});
	it('falls back to the column name without its prefix', () => {
		expect(fieldLabel(defs[4], 'sintering_')).toBe('Batch number');
	});
});

describe('paramFields', () => {
	it('picks the fields a condition shows for the category, in form order', () => {
		expect(paramFields(defs, 'process_category', 'machining').map((f) => f.field)).toEqual([
			'machining_spindle_speed_rpm',
			'machining_feed_mm_per_rev',
			'machining_coolant_used',
		]);
	});
	it('never picks a presentation-only field or another category', () => {
		const all = paramFields(defs, 'process_category', 'sintering').map((f) => f.field);
		expect(all).toEqual(['sintering_batch_number', 'sintering_max_temp_celsius']);
	});
	it('falls back to the column prefix when no field carries a condition', () => {
		const bare = defs.map((d) => ({ ...d, meta: { ...d.meta, conditions: null } }));
		expect(paramFields(bare, 'process_category', 'heat_treatment').map((f) => f.field)).toEqual(['ht_cooling_method']);
	});
	it('is empty for a missing or unknown category', () => {
		expect(paramFields(defs, 'process_category', null)).toEqual([]);
		expect(paramFields(defs, 'process_category', 'sample_prep')).toEqual([]);
	});
	it('understands _in, _or and rules on other fields', () => {
		const f: ParamFieldDef = {
			field: 'am_layer_height_mm',
			meta: { conditions: [{ hidden: false, rule: { _or: [{ process_category: { _in: ['machining', 'additive'] } }, { other: { _eq: 1 } }] } }] },
		};
		expect(paramFields([f], 'process_category', 'additive')).toHaveLength(1);
		expect(paramFields([f], 'process_category', 'sintering')).toHaveLength(0);
	});
	it('ignores base fields that share the category condition (tool_id, nc_program_text ...)', () => {
		const base = (field: string, type: string, special?: string[]): ParamFieldDef => ({
			field,
			type,
			meta: { sort: 1, special, conditions: showWhen('process_category', 'machining') },
		});
		const withBase: ParamFieldDef[] = [
			...defs,
			base('tool_id', 'uuid', ['m2o']),
			base('insert_edge_id', 'uuid', ['m2o']),
			base('gcode_file', 'uuid', ['file']),
			base('nc_program_text', 'text'),
			base('operation_sequence', 'integer'),
			base('capture_software', 'string'),
			base('file_storage_pointer', 'string'),
			// a prefixed relation or alias is still not a measured value
			base('machining_tool_ref', 'uuid', ['m2o']),
		];
		expect(paramFields(withBase, 'process_category', 'machining').map((f) => f.field)).toEqual([
			'machining_spindle_speed_rpm',
			'machining_feed_mm_per_rev',
			'machining_coolant_used',
		]);
		const noConditions = withBase.map((d) => ({ ...d, meta: { ...d.meta, conditions: null } }));
		expect(paramFields(noConditions, 'process_category', 'machining')).toHaveLength(3);
		expect(paramRows(withBase, { process_category: 'machining', tool_id: 'u-1', nc_program_text: 'G01 X0', machining_feed_mm_per_rev: 0.2 }, 'process_category').map((r) => r.field)).toEqual([
			'machining_feed_mm_per_rev',
		]);
	});
	it('works for test types through the test_type discriminator', () => {
		const t: ParamFieldDef = { field: 'tensile_uts_mpa', meta: { conditions: showWhen('test_type', 'tensile') } };
		expect(paramFields([t], 'test_type', 'tensile')).toHaveLength(1);
		expect(paramFields([t], 'test_type', 'hardness')).toHaveLength(0);
	});
});

describe('paramRows', () => {
	const row = {
		process_category: 'machining',
		machining_feed_mm_per_rev: '0.0500',
		machining_spindle_speed_rpm: 1200,
		machining_coolant_used: false,
		pass_code: 'X',
	};
	it('formats values with their units and leaves out empty ones', () => {
		expect(paramRows(defs, row, 'process_category')).toEqual([
			{ field: 'machining_spindle_speed_rpm', label: 'Spindle speed', value: '1,200', unit: 'rpm' },
			{ field: 'machining_feed_mm_per_rev', label: 'Feed', value: '0.05', unit: 'mm/rev' },
			{ field: 'machining_coolant_used', label: 'Coolant Used', value: 'No', unit: '' },
		]);
	});
	it('shows the label of a select choice', () => {
		expect(paramRows(defs, { process_category: 'heat_treatment', ht_cooling_method: 'water_quench' }, 'process_category')).toEqual([
			{ field: 'ht_cooling_method', label: 'Cooling method', value: 'Water quench', unit: '' },
		]);
	});
	it('keeps the characters of text that merely looks numeric', () => {
		const rows = paramRows(defs, { process_category: 'sintering', sintering_batch_number: '007' }, 'process_category');
		expect(rows[0].value).toBe('007');
	});
	it('is empty without a row or a category', () => {
		expect(paramRows(defs, null, 'process_category')).toEqual([]);
		expect(paramRows(defs, { process_category: null }, 'process_category')).toEqual([]);
	});
});

describe('paramColumns and paramPrefix', () => {
	it('lists the columns to request', () => {
		expect(paramColumns(defs, 'process_category', 'sintering')).toEqual(['sintering_batch_number', 'sintering_max_temp_celsius']);
	});
	it('maps categories and test types to their prefix', () => {
		expect(paramPrefix('process_category', 'heat_treatment')).toBe('ht_');
		expect(paramPrefix('process_category', 'sample_prep')).toBeNull();
		expect(paramPrefix('test_type', 'ct_scan')).toBe('ct_scan_');
		expect(paramPrefix('test_type', 'other')).toBeNull();
	});
});
