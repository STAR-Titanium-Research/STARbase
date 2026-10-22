import { describe, expect, it } from 'vitest';
import type { DraftOperation, DraftTest } from '@d1/ui';
import { kindChange } from './kindChange';
import { keyFieldsFor } from './railForm';

const op = (values: Record<string, unknown>): DraftOperation => ({ key: 'n1', kind: 'operation', workState: 'planned', rows: [{ key: 'n1r' }], values });
const test = (values: Record<string, unknown>): DraftTest => ({ key: 'n2', kind: 'test', workState: 'planned', values });
const fields = (i: DraftOperation | DraftTest) => keyFieldsFor(i);

describe('kindChange: an operation', () => {
	it('Turning to Milling (both machining) drops nothing', () => {
		const item = op({ method_id: 'turn', process_category: 'machining', machining_feed_mm_per_rev: 0.2 });
		expect(kindChange(item, { methodId: 'mill', category: 'machining' }, fields)).toEqual({ patch: { method_id: 'mill', process_category: 'machining' }, dropped: [] });
	});

	it('Turning to FAST drops the machining settings that were set and sets the method and category', () => {
		const item = op({ method_id: 'turn', process_category: 'machining', machining_feed_mm_per_rev: 0.2, machining_axial_depth_of_cut_mm: 1 });
		const { patch, dropped } = kindChange(item, { methodId: 'fast', category: 'sintering' }, fields);
		expect(dropped.sort()).toEqual(['machining_axial_depth_of_cut_mm', 'machining_feed_mm_per_rev']);
		expect(patch).toMatchObject({ method_id: 'fast', process_category: 'sintering', machining_feed_mm_per_rev: undefined, machining_axial_depth_of_cut_mm: undefined });
		expect('machining_feed_mm_per_rev' in patch).toBe(true);
	});

	it('leaves alone a setting of the old kind that has no value, and what both kinds share', () => {
		const item = op({ method_id: 'turn', process_category: 'machining', equipment_id: 'e1', planned_date: '2026-10-22' });
		const { patch, dropped } = kindChange(item, { methodId: 'fast', category: 'sintering' }, fields);
		expect(dropped).toEqual([]);
		expect(Object.keys(patch).sort()).toEqual(['method_id', 'process_category']);
	});

	it('the same method changes nothing', () => {
		const item = op({ method_id: 'turn', process_category: 'machining', machining_feed_mm_per_rev: 0.2 });
		expect(kindChange(item, { methodId: 'turn', category: 'machining' }, fields).dropped).toEqual([]);
	});

	it('a first choice (no method yet) drops nothing', () => {
		expect(kindChange(op({}), { methodId: 'turn', category: 'machining' }, fields)).toEqual({ patch: { method_id: 'turn', process_category: 'machining' }, dropped: [] });
	});

	it('a method with no category clears the category', () => {
		const { patch } = kindChange(op({ method_id: 'turn', process_category: 'machining' }), { methodId: 'x', category: null }, fields);
		expect(patch).toEqual({ method_id: 'x', process_category: undefined });
	});
});

describe('kindChange: a test', () => {
	it('Tensile to Hardness drops the tensile result', () => {
		const item = test({ test_type: 'tensile', tensile_uts_mpa: 900 });
		const { patch, dropped } = kindChange(item, { testType: 'hardness' }, fields);
		expect(dropped).toEqual(['tensile_uts_mpa']);
		expect(patch).toEqual({ test_type: 'hardness', tensile_uts_mpa: undefined });
	});

	it('the same type drops nothing', () => {
		expect(kindChange(test({ test_type: 'tensile', tensile_uts_mpa: 900 }), { testType: 'tensile' }, fields)).toEqual({ patch: { test_type: 'tensile' }, dropped: [] });
	});
});
