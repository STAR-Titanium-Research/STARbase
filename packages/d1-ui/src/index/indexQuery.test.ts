import { describe, expect, it } from 'vitest';
import { INDEX_DEFS, indexDefBySlug } from './indexConfig';
import {
	PAGE_SIZE, SHORT_ID_RE, bookmarkSort, buildItemsParams, dataStudioLink, nested, queryFromState, stateFromQuery,
} from './indexQuery';
import type { IndexState } from './indexQuery';
import type { Bookmark } from '../nav/navConfig';

const samples = indexDefBySlug('samples')!;
const tools = indexDefBySlug('tools')!;

const state = (over: Partial<IndexState> = {}): IndexState => ({
	bookmark: null, q: '', filters: {}, sort: null, page: 1, open: null, ...over,
});
const bm = (over: Partial<Bookmark> = {}): Bookmark => ({
	id: 7, bookmark: 'Mine', collection: 'physical_samples', user: null, role: null, filter: null, search: null, layout_query: null, ...over,
});
const parsedFilter = (p: Record<string, unknown>) => JSON.parse(p.filter as string);

describe('stateFromQuery / queryFromState', () => {
	it('round-trips a full state', () => {
		const full = state({ bookmark: 7, q: 'ti64', filters: { project_id: 'p1', current_status: 'active' }, sort: '-created_at', page: 3, open: 'abc' });
		expect(stateFromQuery(queryFromState(full))).toEqual(full);
	});

	it('round-trips the defaults, and leaves them out of the URL', () => {
		expect(queryFromState(state())).toEqual({});
		expect(stateFromQuery({})).toEqual(state());
		expect(stateFromQuery(queryFromState(state()))).toEqual(state());
	});

	it('reads f.<field> into filters', () => {
		expect(stateFromQuery({ 'f.project_id': 'abc', 'f.': 'x', 'f.status': '' }).filters).toEqual({ project_id: 'abc' });
	});

	it('falls back to page 1 for a non-numeric, fractional or non-positive page', () => {
		for (const page of ['abc', '', '0', '-2', '1.5', '1e2', '0x10', ' 5', '1000000000000']) expect(stateFromQuery({ page }).page).toBe(1);
		expect(stateFromQuery({ page: '4' }).page).toBe(4);
	});

	it('ignores a bad bookmark id and takes the first of repeated keys', () => {
		expect(stateFromQuery({ bookmark: 'x' }).bookmark).toBeNull();
		expect(stateFromQuery({ bookmark: ['5', '6'], q: ['a', 'b'] })).toMatchObject({ bookmark: 5, q: 'a' });
	});
});

describe('nested', () => {
	it('nests a dotted path', () => {
		expect(nested('sample_id.sample_code', { _eq: 1 })).toEqual({ sample_id: { sample_code: { _eq: 1 } } });
		expect(nested('name', 2)).toEqual({ name: 2 });
	});
});

describe('bookmarkSort', () => {
	it('reads layout_query.tabular.sort[0]', () => {
		expect(bookmarkSort(bm({ layout_query: { tabular: { sort: ['-operation_date', 'x'] } } }))).toBe('-operation_date');
	});
	it('is null without one', () => {
		expect(bookmarkSort(null)).toBeNull();
		expect(bookmarkSort(bm())).toBeNull();
		expect(bookmarkSort(bm({ layout_query: { tabular: {} } }))).toBeNull();
	});
});

describe('buildItemsParams', () => {
	it('asks for the pk and the columns, relations by their display field', () => {
		const p = buildItemsParams(samples, state(), null);
		expect(p.fields).toEqual(expect.arrayContaining(['sample_id', 'sample_code', 'material_id.alloy_code', 'project_id.project_code']));
		expect((p.fields as string[])[0]).toBe('sample_id');
		expect(p.fields).not.toContain('project_id');
	});

	it('pages 50 at a time and counts the matches', () => {
		const p = buildItemsParams(samples, state({ page: 3 }), null);
		expect(p).toMatchObject({ limit: PAGE_SIZE, page: 3, meta: 'filter_count' });
		expect(PAGE_SIZE).toBe(50);
	});

	it('has no filter key when nothing applies', () => {
		expect('filter' in buildItemsParams(samples, state(), null)).toBe(false);
		expect('filter' in buildItemsParams(samples, state({ q: '   ' }), bm({ filter: {} }))).toBe(false);
	});

	it('keeps the bookmark filter unchanged inside _and, stacked with a chip and the search', () => {
		const filter = { _and: [{ owner_person_id: { user_id: { _eq: '$CURRENT_USER' } } }] };
		const p = buildItemsParams(samples, state({ q: 'ti', filters: { project_id: 'p1' } }), bm({ filter }));
		expect(typeof p.filter).toBe('string');
		const and = parsedFilter(p)._and;
		expect(and).toHaveLength(3);
		expect(and[0]).toEqual(filter);
		expect(and[1]).toEqual({ project_id: { _eq: 'p1' } });
		expect(and[2]).toEqual({ _or: [{ sample_code: { _icontains: 'ti' } }, { nickname: { _icontains: 'ti' } }] });
	});

	it('searches through a relation path as a nested filter', () => {
		const def = INDEX_DEFS.find((d) => d.searchFields.some((f) => f.includes('.')))!;
		const dotted = def.searchFields.find((f) => f.includes('.'))!;
		const [head, tail] = dotted.split('.');
		const or = parsedFilter(buildItemsParams(def, state({ q: 'zz' }), null))._and[0]._or;
		expect(or).toContainEqual({ [head]: { [tail]: { _icontains: 'zz' } } });
	});

	it('adds an exact short_id match for a short-ID-looking search, only where the collection has one', () => {
		const withId = parsedFilter(buildItemsParams(samples, state({ q: 'A1B2C3D4' }), null))._and[0]._or;
		expect(withId).toContainEqual({ short_id: { _eq: 'a1b2c3d4' } });
		const without = parsedFilter(buildItemsParams(tools, state({ q: 'a1b2c3d4' }), null))._and[0]._or;
		expect(JSON.stringify(without)).not.toContain('short_id');
		const notHex = parsedFilter(buildItemsParams(samples, state({ q: 'ti64alloy' }), null))._and[0]._or;
		expect(JSON.stringify(notHex)).not.toContain('short_id');
		expect(SHORT_ID_RE.test('a1b2c3d4')).toBe(true);
		expect(SHORT_ID_RE.test('a1b2c3d')).toBe(false);
	});

	it('turns a bool chip into a real boolean', () => {
		const def = INDEX_DEFS.find((d) => d.filters.some((f) => f.options.kind === 'bool'))!;
		const field = def.filters.find((f) => f.options.kind === 'bool')!.field;
		expect(parsedFilter(buildItemsParams(def, state({ filters: { [field]: 'true' } }), null))._and).toEqual([{ [field]: { _eq: true } }]);
		expect(parsedFilter(buildItemsParams(def, state({ filters: { [field]: 'false' } }), null))._and).toEqual([{ [field]: { _eq: false } }]);
		// a junk value is dropped, not read as false
		expect('filter' in buildItemsParams(def, state({ filters: { [field]: 'banana' } }), null)).toBe(false);
	});

	it('drops a chip for a field the page does not offer', () => {
		expect('filter' in buildItemsParams(samples, state({ filters: { not_a_filter: 'x' } }), null)).toBe(false);
	});

	it('ANDs in the fixed filter first', () => {
		const def = { ...samples, fixedFilter: { is_active: { _eq: true } } };
		expect(parsedFilter(buildItemsParams(def, state({ filters: { project_id: 'p' } }), null))._and[0]).toEqual({ is_active: { _eq: true } });
	});

	it('sorts by the URL, else the bookmark, else the default', () => {
		const sorted = bm({ layout_query: { tabular: { sort: ['-operation_date'] } } });
		expect(buildItemsParams(samples, state({ sort: 'sample_code' }), sorted).sort).toEqual(['sample_code']);
		expect(buildItemsParams(samples, state(), sorted).sort).toEqual(['-operation_date']);
		expect(buildItemsParams(samples, state(), bm()).sort).toEqual([samples.defaultSort]);
		expect(buildItemsParams(samples, state(), null).sort).toEqual(['-created_at']);
	});
});

describe('dataStudioLink', () => {
	const note = "Opens the full list: the Data Studio can't take this search or these filters.";
	it('carries a lone bookmark to the Data Studio list', () => {
		expect(dataStudioLink(samples, state({ bookmark: 7 }))).toEqual({ to: '/content/physical_samples?bookmark=7', note: null });
		expect(dataStudioLink(samples, state())).toEqual({ to: '/content/physical_samples', note: null });
	});
	it('opens the plain list, with a note, when there is a search or a chip', () => {
		expect(dataStudioLink(samples, state({ bookmark: 7, q: 'x' }))).toEqual({ to: '/content/physical_samples', note });
		expect(dataStudioLink(samples, state({ filters: { project_id: 'p' } }))).toEqual({ to: '/content/physical_samples', note });
	});
});

describe('buildItemsParams: unreadable relation columns', () => {
	const fieldsOf = (readable: ReadonlySet<string> | null) => buildItemsParams(samples, state(), null, readable).fields as string[];

	it('asks for the related display only where the related collection is readable', () => {
		const fields = fieldsOf(new Set(['materials']));
		expect(fields).toContain('material_id.alloy_code');
		// projects is not readable: the bare key, never project_id.project_code
		expect(fields).toContain('project_id');
		expect(fields).not.toContain('project_id.project_code');
	});

	it('asks for every relation when the readable set is not known', () => {
		const fields = fieldsOf(null);
		expect(fields).toContain('material_id.alloy_code');
		expect(fields).toContain('project_id.project_code');
	});

	it('asks for none when nothing is readable, keeping the primary key first', () => {
		const fields = fieldsOf(new Set());
		expect(fields[0]).toBe('sample_id');
		expect(fields.some((f) => f.includes('.'))).toBe(false);
	});
});
