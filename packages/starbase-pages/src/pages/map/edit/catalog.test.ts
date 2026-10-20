import { describe, expect, it } from 'vitest';
import { checkFieldsOf, existingIds, loadedRecordOf, methodsOf, testTypesOf, writableValues } from './catalog';

describe('methods', () => {
	it('are sorted by name, with the category when it is one the map knows', () => {
		const out = methodsOf([
			{ method_id: 'b', method_name: 'Turning', method_code: 'MC', process_category: 'machining' },
			{ method_id: 'a', method_name: 'FAST', method_code: 'MF', process_category: 'sintering' },
			{ method_id: 'c', method_name: 'Odd', method_code: 'MX', process_category: 'nonsense' },
			{ method_name: 'No id' },
		]);
		expect(out.map((m) => m.name)).toEqual(['FAST', 'Odd', 'Turning']);
		expect(out.find((m) => m.id === 'a')).toEqual({ id: 'a', name: 'FAST', code: 'MF', category: 'sintering' });
		expect(out.find((m) => m.id === 'c')?.category).toBeNull();
	});

	it('are named by their code when they have no name', () => {
		expect(methodsOf([{ method_id: 'a', method_code: 'MQ' }])[0].name).toBe('MQ');
	});
});

describe('test types', () => {
	it('are the choices of test_sessions.test_type', () => {
		const defs = [
			{ field: 'status', meta: {} },
			{ field: 'test_type', meta: { options: { choices: [{ text: 'Tensile', value: 'tensile' }, { value: 'xrd' }, { text: 'Empty', value: '' }, null] } } },
		];
		expect(testTypesOf(defs)).toEqual([
			{ value: 'tensile', name: 'Tensile' },
			{ value: 'xrd', name: 'xrd' },
		]);
	});

	it('are none when the field has no choices (or the definitions were not read)', () => {
		expect(testTypesOf([])).toEqual([]);
		expect(testTypesOf([{ field: 'test_type', meta: {} }])).toEqual([]);
	});
});

describe('field definitions for the checks', () => {
	it('carry required, hidden and read-only, and leave groups out', () => {
		const out = checkFieldsOf([
			{ field: 'notes_group', meta: { special: ['group'], interface: 'group-detail' } },
			{ field: 'method_id', meta: { required: true, translations: [{ language: 'en-US', translation: 'Method' }] }, schema: { foreign_key_table: 'manufacturing_methods' } },
			{ field: 'notes', meta: { readonly: true, hidden: true } },
		]);
		expect(out.map((f) => f.field)).toEqual(['method_id', 'notes']);
		expect(out[0]).toMatchObject({ required: true, label: 'Method' });
		expect(out[1]).toMatchObject({ required: false, hidden: true, readonly: true });
	});
});

describe('existing records', () => {
	it('read with a version become LoadedRecords; a row with none does not', () => {
		expect(loadedRecordOf({ sample_id: 'a', version: 4 })).toEqual({ version: 4, values: { sample_id: 'a', version: 4 } });
		expect(loadedRecordOf({ sample_id: 'a' })).toBeNull();
	});

	it('are listed by collection, each once', () => {
		const out = existingIds([
			{ kind: 'sample', existing: { id: 's1' } },
			{ kind: 'sample', existing: { id: 's1' } },
			{ kind: 'sample' },
			{ kind: 'operation', existing: { id: 'o1' } },
			{ kind: 'test', existing: { id: 't1' } },
		]);
		expect(out).toEqual({ physical_samples: ['s1'], manufacturing_operations: ['o1'], test_sessions: ['t1'] });
	});
});

describe('what a copy of an existing record may carry', () => {
	// A row read with fields=* : the columns, the keys and stamps the server refuses, and the alias arrays of the form.
	const row = {
		sample_id: 'real-1', sample_code: 'PS-001', short_id: 'ab12cd', code_sort: 'PS-000001', restricted: false, version: 4, created_at: '2026-10-01', created_by: 'u1',
		form: 'disc', mass_grams: 12.5, notes: null, material_id: 'mat1', co_owners: [{ user_id: 'u2' }], project_items: [1, 2], current_status: 'active',
	};
	const defs = [
		{ field: 'sample_id', type: 'uuid', schema: { is_primary_key: true }, meta: {} },
		{ field: 'sample_code', type: 'string', schema: {}, meta: {} },
		{ field: 'form', type: 'string', schema: {}, meta: {} },
		{ field: 'mass_grams', type: 'decimal', schema: {}, meta: {} },
		{ field: 'notes', type: 'text', schema: {}, meta: {} },
		{ field: 'material_id', type: 'uuid', schema: { foreign_key_table: 'materials' }, meta: { special: ['m2o'] } },
		{ field: 'short_id', type: 'string', schema: {}, meta: {} },
		{ field: 'co_owners', type: 'alias', meta: { special: ['m2m'] } },
		{ field: 'project_items', type: 'alias', meta: { special: ['o2m'] } },
		{ field: 'report_button', type: 'alias', meta: { special: ['no-data'] } },
	];

	it('is the real columns the draft may set: not the keys, stamps and codes the server refuses, not the alias arrays', () => {
		expect(writableValues('sample', row, defs)).toEqual({ sample_code: 'PS-001', form: 'disc', mass_grams: 12.5, notes: null, material_id: 'mat1' });
	});

	it('drops what each kind reserves (an operation\'s sample and work state, a test\'s subject)', () => {
		const op = { operation_id: 'o', sample_id: 's', output_sample_id: 't', work_state: 'planned', batch_id: 'b', method_id: 'm', short_id: 'x', feed: 1 };
		expect(writableValues('operation', op)).toEqual({ method_id: 'm', feed: 1 });
		expect(writableValues('sample', { form: 'disc', owner_person_id: 'p', owner_team_id: 't' })).toEqual({ form: 'disc' });
		expect(writableValues('test', { session_id: 's', subject: [1], work_state: 'done', test_type: 'tensile' })).toEqual({ test_type: 'tensile' });
	});

	it('without field definitions keeps plain values only (no arrays, no relations read as objects)', () => {
		expect(writableValues('sample', row)).toEqual({ sample_code: 'PS-001', form: 'disc', mass_grams: 12.5, notes: null, material_id: 'mat1' });
		expect(writableValues('sample', { form: 'd', material: { id: 1 } })).toEqual({ form: 'd' });
	});
});
