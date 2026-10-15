import { describe, expect, it } from 'vitest';
import type { DraftItem } from '@d1/ui';
import { SAMPLE_KEY_FIELDS, formTitle, keyFieldsFor, withCategory } from './railForm';

const op = (values: Record<string, unknown> = {}, existing?: { id: string; version: number }): DraftItem => ({ key: 'n1', kind: 'operation', workState: 'planned', values, rows: [{ key: 'n2' }], ...(existing ? { existing } : {}) });
const test = (values: Record<string, unknown> = {}): DraftItem => ({ key: 'n1', kind: 'test', workState: 'planned', values });
const sample = (): DraftItem => ({ key: 'n1', kind: 'sample', values: {} });

describe('the compact form of an item', () => {
	it('a sample draws what its code is made of and what it is', () => {
		expect(keyFieldsFor(sample())).toEqual(SAMPLE_KEY_FIELDS);
		expect(SAMPLE_KEY_FIELDS.slice(0, 2)).toEqual(['material_id', 'primary_method_id']);
	});

	it('an operation draws its method, machine and planned date, then the key settings of its category', () => {
		const none = keyFieldsFor(op());
		expect(none).toEqual(['method_id', 'equipment_id', 'planned_date']);
		const machining = keyFieldsFor(op({ process_category: 'machining' }));
		expect(machining.slice(0, 3)).toEqual(['method_id', 'equipment_id', 'planned_date']);
		expect(machining.length).toBeGreaterThan(3);
	});

	it('an operation that exists takes its category from the record', () => {
		const item = op({}, { id: 'o1', version: 1 });
		expect(keyFieldsFor(item, { process_category: 'machining' }).length).toBeGreaterThan(3);
		expect(keyFieldsFor(item, {}).length).toBe(3);
	});

	it('a test always draws its type, then that type\'s own fields, the machine and the planned date', () => {
		expect(keyFieldsFor(test())).toEqual(['test_type', 'equipment_id', 'planned_date']);
		const tensile = keyFieldsFor(test({ test_type: 'tensile' }));
		expect(tensile).toEqual(['test_type', 'tensile_uts_mpa', 'equipment_id', 'planned_date']);
	});
});

describe('changing the method', () => {
	const categoryOf = (id: string) => (id === 'mt' ? ('machining' as const) : id === 'mf' ? ('sintering' as const) : undefined);

	it('sets the process category of the new method with it', () => {
		expect(withCategory(op({ method_id: 'mf', process_category: 'sintering' }), { method_id: 'mt' }, categoryOf)).toEqual({ method_id: 'mt', process_category: 'machining' });
	});

	it('clears a category the new method has none of (nothing for a new record, null for one that exists)', () => {
		expect(withCategory(op({ method_id: 'mt', process_category: 'machining' }), { method_id: 'mx' }, categoryOf)).toEqual({ method_id: 'mx', process_category: undefined });
		expect(withCategory(op({}, { id: 'o', version: 1 }), { method_id: 'mx' }, categoryOf)).toEqual({ method_id: 'mx', process_category: null });
	});

	it('leaves other changes alone, and a method that did not change', () => {
		const item = op({ method_id: 'mt' });
		expect(withCategory(item, { feed: 1 }, categoryOf)).toEqual({ feed: 1 });
		expect(withCategory(item, { method_id: 'mt' }, categoryOf)).toEqual({ method_id: 'mt' });
		expect(withCategory(test({ test_type: 'a' }), { method_id: 'mt' }, categoryOf)).toEqual({ method_id: 'mt' });
	});
});

describe('the section title', () => {
	it('says new for what is not a record yet', () => {
		expect(formTitle(sample())).toBe('New sample');
		expect(formTitle(op())).toBe('New operation');
		expect(formTitle(test())).toBe('New test');
		expect(formTitle(op({}, { id: 'o', version: 1 }))).toBe('Operation');
	});
});
