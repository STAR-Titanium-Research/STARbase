import { describe, expect, it } from 'vitest';
import type { DraftOperation, DraftSample, DraftTest } from '@d1/ui';
import { KEY_SETTING_FIELDS } from '../model/formSlots';
import { collectionFor, formDefsFor, keySettingsFor, TEXT_OVERRIDES } from './draftForm';

const defs = (...names: string[]) => names.map((field) => ({ field, meta: {} }));
const sample = (over: Partial<DraftSample> = {}): DraftSample => ({ key: 'n1', kind: 'sample', values: {}, ...over });
const op = (over: Partial<DraftOperation> = {}): DraftOperation => ({ key: 'n2', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n3' }], ...over });
const test = (over: Partial<DraftTest> = {}): DraftTest => ({ key: 'n4', kind: 'test', workState: 'planned', values: {}, ...over });
const names = (list: { field: string }[]) => list.map((d) => d.field);

describe('collectionFor', () => {
	it('maps each kind of draft item to its collection', () => {
		expect(collectionFor(sample())).toBe('physical_samples');
		expect(collectionFor(op())).toBe('manufacturing_operations');
		expect(collectionFor(test())).toBe('test_sessions');
	});
});

describe('formDefsFor', () => {
	const common = ['sample_id', 'output_sample_id', 'operation_id', 'session_id', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'operation_sequence'];
	const codes = ['sample_code', 'pass_code', 'test_code'];
	const all = defs(...common, ...codes, 'current_status', 'planned_date', 'method_id', 'notes');
	const rest = ['planned_date', 'method_id', 'notes'];

	it('leaves out what the draft sets itself, and on a new record the codes', () => {
		expect(names(formDefsFor(all, op()))).toEqual(['current_status', ...rest]);
		expect(names(formDefsFor(all, test()))).toEqual(['current_status', ...rest]);
	});

	it('a new sample also loses its status, which the draft sets', () => {
		expect(names(formDefsFor(all, sample()))).toEqual(rest);
	});

	it('an existing record keeps its codes (shown read-only) and, for a sample, its status', () => {
		const existing = { id: 'x', version: 1 };
		expect(names(formDefsFor(all, op({ existing })))).toEqual([...codes, 'current_status', ...rest]);
		expect(names(formDefsFor(all, sample({ existing })))).toEqual([...codes, 'current_status', ...rest]);
	});

	it('compact keeps only the key fields, in the form order', () => {
		const list = defs('a', 'b', 'c', 'sample_id');
		expect(names(formDefsFor(list, op(), { compact: true, keyFields: ['c', 'a', 'sample_id'] }))).toEqual(['a', 'c']);
		expect(formDefsFor(list, op(), { compact: true })).toEqual([]);
		expect(names(formDefsFor(list, op(), { keyFields: ['a'] }))).toEqual(['a', 'b', 'c']); // keyFields alone does nothing
	});

	it('skips rows with no field name', () => {
		expect(formDefsFor([null, {}, { field: 'notes' }], op())).toEqual([{ field: 'notes' }]);
	});
});

describe('TEXT_OVERRIDES', () => {
	it('shows the process category and the codes as read-only text', () => {
		for (const f of ['process_category', 'sample_code', 'pass_code', 'test_code']) {
			expect(TEXT_OVERRIDES[f]).toMatchObject({ kind: 'text', readonly: true, required: false });
		}
	});
});

describe('keySettingsFor', () => {
	it('is the fields of the key settings table the map draws, for a process category', () => {
		expect(keySettingsFor('machining')).toEqual([
			'machining_cutting_speed_m_per_min', 'machining_feed_mm_per_rev', 'machining_axial_depth_of_cut_mm', 'machining_coolant_used',
		]);
		expect(keySettingsFor('sintering')).toEqual(['sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_mould_diameter_mm']);
	});

	it('every category of the table gives exactly its fields', () => {
		for (const [category, list] of Object.entries(KEY_SETTING_FIELDS)) {
			if (category === 'test') continue;
			expect(keySettingsFor(category)).toEqual(list.flatMap((d) => d.fields.map((f) => f.field)));
		}
	});

	it('sample prep has none', () => {
		expect(keySettingsFor('sample_prep')).toEqual([]);
	});

	it('a test type gives its type, standard and headline result', () => {
		expect(keySettingsFor('tensile')).toEqual(['test_type', 'tensile_uts_mpa']);
		expect(keySettingsFor('charpy')).toEqual(['test_type', 'charpy_specimen_standard', 'charpy_absorbed_energy_j']);
		expect(keySettingsFor('sem')).toEqual(['test_type']);
	});

	it('the headline fields of a test type are among the fields the map reads for a test', () => {
		const fromTable = new Set(KEY_SETTING_FIELDS.test.flatMap((d) => d.fields.map((f) => f.field)));
		for (const type of ['tensile', 'compression', 'hardness', 'charpy', 'tribology']) {
			for (const f of keySettingsFor(type)) expect(fromTable.has(f)).toBe(true);
		}
	});

	it('nothing for no value', () => {
		expect(keySettingsFor(null)).toEqual([]);
		expect(keySettingsFor(undefined)).toEqual([]);
		expect(keySettingsFor('')).toEqual([]);
	});
});
