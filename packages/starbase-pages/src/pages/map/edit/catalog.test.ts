import { describe, expect, it } from 'vitest';
import { checkFieldsOf, existingIds, loadedRecordOf, methodsOf, testTypesOf } from './catalog';

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
