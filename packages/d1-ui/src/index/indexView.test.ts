import { describe, expect, it } from 'vitest';
import { indexDefBySlug } from './indexConfig';
import type { IndexState } from './indexQuery';
import type { Bookmark } from '../nav/navConfig';
import {
	BOOL_OPTIONS, cellText, effectiveState, enumOptionParams, enumOptions, extraFields, hasActiveFilters, hasExplicitQ, hasNextPage,
	nextSort, queryForState, sortKey, rangeText, relationKey, relationOptionParams, relationOptions, relationText, sortDirection, withChange,
	validSort, withSelected,
} from './indexView';

const samples = indexDefBySlug('samples')!;
const operations = indexDefBySlug('operations')!;
const tools = indexDefBySlug('tools')!;
const col = (def: typeof samples, field: string) => def.columns.find((c) => c.field === field)!;

const state = (over: Partial<IndexState> = {}): IndexState => ({
	bookmark: null, q: '', filters: {}, sort: null, page: 1, open: null, ...over,
});
const bm = (over: Partial<Bookmark> = {}): Bookmark => ({
	id: 7, bookmark: 'Mine', collection: 'physical_samples', user: null, role: null, filter: null, search: null, layout_query: null, ...over,
});

describe('cellText', () => {
	it('shows a relation by its display value, never a bare key', () => {
		const material = col(samples, 'material_id');
		expect(cellText({ material_id: { alloy_code: 'Ti64' } }, material, samples)).toBe('Ti64');
		expect(cellText({ material_id: 'a-uuid' }, material, samples)).toBe('');
		expect(cellText({ material_id: null }, material, samples)).toBe('');
		expect(relationText({ alloy_code: null }, 'alloy_code')).toBe('');
	});

	it('formats dates, numbers and booleans, and leaves nulls empty', () => {
		expect(cellText({ created_at: '2026-03-05T10:00:00Z' }, col(samples, 'created_at'), samples)).toBe('5 Mar 2026');
		expect(cellText({ created_at: null }, col(samples, 'created_at'), samples)).toBe('');
		expect(cellText({ is_active: true }, col(tools, 'is_active'), tools)).toBe('Yes');
		expect(cellText({ is_active: false }, col(tools, 'is_active'), tools)).toBe('No');
		expect(cellText({ is_active: null }, col(tools, 'is_active'), tools)).toBe('');
		const qty = indexDefBySlug('tool-boxes')!;
		expect(cellText({ package_quantity: 1250 }, col(qty, 'package_quantity'), qty)).toBe('1,250');
		expect(cellText({ package_quantity: 0 }, col(qty, 'package_quantity'), qty)).toBe('0');
	});

	it('shows plain text as it is, arrays joined', () => {
		expect(cellText({ nickname: 'Bar 3' }, col(samples, 'nickname'), samples)).toBe('Bar 3');
		const recipes = indexDefBySlug('prep-recipes')!;
		expect(cellText({ suited_materials: ['Ti64', 'IN718'] }, col(recipes, 'suited_materials'), recipes)).toBe('Ti64, IN718');
	});

	it('labels an operation by its pass code, else sample and step', () => {
		const code = col(operations, 'pass_code');
		expect(cellText({ pass_code: 'MF-0412' }, code, operations)).toBe('MF-0412');
		expect(cellText({ pass_code: null, operation_sequence: 2, sample_id: { sample_code: 'Ti64-P-0091' } }, code, operations)).toBe('Ti64-P-0091 · step 2');
		expect(cellText({ pass_code: '', sample_id: null }, code, operations)).toBe('Uncoded operation');
	});

	it('asks for the step number only on the operations page', () => {
		expect(extraFields(operations)).toEqual(['operation_sequence']);
		expect(extraFields(samples)).toEqual([]);
	});
});

describe('paging', () => {
	it('writes the range with grouped thousands', () => {
		expect(rangeText(1, 50, 1206)).toBe('Showing 1-50 of 1,206');
		expect(rangeText(2, 50, 1206)).toBe('Showing 51-100 of 1,206');
		expect(rangeText(25, 6, 1206)).toBe('Showing 1,201-1,206 of 1,206');
	});
	it('does not write 1-0 for nothing, and nothing before the total is known', () => {
		expect(rangeText(1, 0, 0)).toBe('Showing 0 of 0');
		expect(rangeText(9, 0, 120)).toBe('Showing 0 of 120');
		expect(rangeText(1, 0, null)).toBe('');
	});
	it('knows when there is a next page', () => {
		expect(hasNextPage(1, 51)).toBe(true);
		expect(hasNextPage(1, 50)).toBe(false);
		expect(hasNextPage(2, 100)).toBe(false);
		expect(hasNextPage(1, null)).toBe(false);
	});
});

describe('sorting', () => {
	it('goes ascending, then descending, then ascending again', () => {
		expect(nextSort('-created_at', 'name')).toBe('name');
		expect(nextSort('name', 'name')).toBe('-name');
		expect(nextSort('-name', 'name')).toBe('name');
	});
	it('sorts a relation column by the related display field', () => {
		expect(sortKey(col(samples, 'material_id'))).toBe('material_id.alloy_code');
		expect(sortKey(col(samples, 'nickname'))).toBe('nickname');
	});
	it('reports the direction of the sorted column only', () => {
		expect(sortDirection('name', 'name')).toBe('asc');
		expect(sortDirection('-name', 'name')).toBe('desc');
		expect(sortDirection('-name', 'code')).toBeNull();
	});
});

describe('validSort (the URL sort)', () => {
	it('accepts a column sort key either way round, and the default', () => {
		expect(validSort(samples, 'nickname', null)).toBe('nickname');
		expect(validSort(samples, '-nickname', null)).toBe('-nickname');
		expect(validSort(samples, 'material_id.alloy_code', null)).toBe('material_id.alloy_code');
		expect(validSort(samples, samples.defaultSort, null)).toBe(samples.defaultSort);
	});
	it('accepts the active saved view sort', () => {
		const b = bm({ layout_query: { tabular: { sort: ['-weight'] } } });
		expect(validSort(samples, '-weight', b)).toBe('-weight');
		expect(validSort(samples, '-weight', null)).toBeNull();
	});
	it('drops anything else: unknown fields, junk, the wrong relation spelling, nothing', () => {
		expect(validSort(samples, 'password', null)).toBeNull();
		expect(validSort(samples, '--nickname', null)).toBeNull();
		expect(validSort(samples, 'nickname,-form', null)).toBeNull();
		expect(validSort(samples, 'material_id', null)).toBeNull();
		expect(validSort(samples, '', null)).toBeNull();
		expect(validSort(samples, null, null)).toBeNull();
	});
	it('drops a relation column the user cannot sort by', () => {
		const sortable = (c: { relation?: unknown }) => !c.relation;
		expect(validSort(samples, 'material_id.alloy_code', null, sortable)).toBeNull();
		expect(validSort(samples, 'nickname', null, sortable)).toBe('nickname');
	});
});

describe('a saved view search', () => {
	it('fills q when the URL has no q', () => {
		const b = bm({ search: 'ti64' });
		expect(effectiveState(state({ bookmark: 7 }), hasExplicitQ({}), b).q).toBe('ti64');
	});
	it('yields to a q in the URL, even an empty one', () => {
		const b = bm({ search: 'ti64' });
		expect(effectiveState(state({ q: 'in718' }), hasExplicitQ({ q: 'in718' }), b).q).toBe('in718');
		expect(effectiveState(state({ q: '' }), hasExplicitQ({ q: '' }), b).q).toBe('');
	});
	it('is left alone without a bookmark or a search', () => {
		expect(effectiveState(state(), false, null).q).toBe('');
		expect(effectiveState(state(), false, bm({ search: null })).q).toBe('');
	});
	it('keeps an emptied box in the URL only where a saved view would refill it', () => {
		expect(queryForState(state({ bookmark: 7 }), bm({ search: 'ti64' }), true)).toEqual({ bookmark: '7', q: '' });
		expect(queryForState(state({ bookmark: 7 }), bm({ search: 'ti64' }), false)).toEqual({ bookmark: '7' });
		expect(queryForState(state({ bookmark: 7 }), bm(), true)).toEqual({ bookmark: '7' });
		expect(queryForState(state(), null, true)).toEqual({});
	});
});

describe('withChange', () => {
	it('starts from page 1 and closes the drawer', () => {
		expect(withChange(state({ page: 4, open: 'x' }), { q: 'ti' })).toMatchObject({ q: 'ti', page: 1, open: null });
	});
	it('keeps a page or open it is told to set', () => {
		expect(withChange(state({ page: 1 }), { page: 3 }).page).toBe(3);
		expect(withChange(state(), { open: 'abc' }).open).toBe('abc');
	});
	it('reports whether a search or chip is active', () => {
		expect(hasActiveFilters(state())).toBe(false);
		expect(hasActiveFilters(state({ q: ' ' }))).toBe(false);
		expect(hasActiveFilters(state({ q: 'a' }))).toBe(true);
		expect(hasActiveFilters(state({ filters: { status: 'x' } }))).toBe(true);
	});
});

describe('chip options', () => {
	it('names the key a relation filters on', () => {
		expect(relationKey('projects')).toBe('project_id');
		expect(relationKey('materials')).toBe('material_id');
		expect(relationKey('material_iso_classifications')).toBe('iso_code');
		expect(relationKey('nope')).toBeNull();
	});

	it('requests a relation list by key and display, A-Z', () => {
		expect(relationOptionParams('project_id', 'project_code')).toEqual({ fields: ['project_id', 'project_code'], sort: ['project_code'], limit: 200 });
		expect(relationOptionParams('iso_code', 'iso_code').fields).toEqual(['iso_code']);
	});

	it('reads relation options, falling back to the key for a missing display', () => {
		const rows = [{ project_id: 'p1', project_code: 'STAR-01' }, { project_id: 'p2', project_code: null }, { project_id: null, project_code: 'x' }];
		expect(relationOptions(rows, 'project_id', 'project_code')).toEqual([
			{ value: 'p1', label: 'STAR-01' },
			{ value: 'p2', label: 'p2' },
		]);
		expect(relationOptions(undefined, 'a', 'b')).toEqual([]);
	});

	it('requests enum values with groupBy and reads them distinct, A-Z, without nulls', () => {
		expect(enumOptionParams('status')).toEqual({ groupBy: ['status'], aggregate: { count: '*' }, limit: 200 });
		const rows = [{ status: 'planned' }, { status: 'active' }, { status: null }, { status: '' }, { status: 'active' }, { status: 'Complete' }];
		expect(enumOptions(rows, 'status').map((o) => o.value)).toEqual(['active', 'Complete', 'planned']);
	});

	it('offers yes and no for a boolean', () => {
		expect(BOOL_OPTIONS.map((o) => o.value)).toEqual(['true', 'false']);
	});

	it('adds a chosen value the list does not hold', () => {
		const list = [{ value: 'a', label: 'A' }];
		expect(withSelected(list, 'a')).toBe(list);
		expect(withSelected(list, undefined)).toBe(list);
		expect(withSelected(list, 'zzz')[0]).toEqual({ value: 'zzz', label: 'zzz' });
	});
});
