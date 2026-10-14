import { describe, expect, it } from 'vitest';
import { buildNav, type Bookmark } from '../nav/navConfig';
import {
	FINDER_SOURCES, MIN_QUERY, isSearchable, localHits, mergeHits, rankHit, sourceParams, toHits, visibleSources,
	type FinderHit, type FinderSource,
} from './finder';

const source = (collection: string): FinderSource => FINDER_SOURCES.find((s) => s.collection === collection)!;

const bookmark = (id: number, name: string, collection: string): Bookmark => ({
	id, bookmark: name, collection, user: 'u1', role: null, filter: null, search: null, layout_query: null,
});

const everything = new Set(FINDER_SOURCES.map((s) => s.collection).concat(['projects', 'campaigns', 'physical_samples']));

describe('localHits', () => {
	const nav = buildNav(everything, [bookmark(7, 'My samples', 'physical_samples'), bookmark(8, 'Slow tests', 'test_sessions')], false);

	it('finds the Samples page and a saved view by name', () => {
		const hits = localHits('sam', nav);
		expect(hits.find((h) => h.group === 'Pages' && h.label === 'Samples')?.to).toBe('/home/samples');
		const view = hits.find((h) => h.group === 'Saved views');
		expect(view).toMatchObject({ label: 'My samples', detail: 'Samples', to: '/home/samples?bookmark=7' });
		expect(hits.some((h) => h.label === 'Slow tests')).toBe(false);
	});

	it('offers Print labels as an app page, and the other Tools entries', () => {
		expect(localHits('print', nav).map((h) => [h.label, h.to])).toEqual([['Print labels', '/home/labels']]);
		expect(localHits('data studio', nav).map((h) => h.label)).toEqual(['Data Studio']);
	});

	it('offers nothing below the minimum length', () => {
		expect(localHits('s', nav)).toEqual([]);
		expect(MIN_QUERY).toBe(2);
	});
});

describe('sourceParams', () => {
	it('ORs _icontains over the match fields, 5 results, the source fields', () => {
		const p = sourceParams(source('physical_samples'), 'ab12');
		expect(p.limit).toBe(5);
		expect(p.fields).toEqual(source('physical_samples').fields);
		expect(JSON.parse(p.filter as string)).toEqual({
			_or: [{ sample_code: { _icontains: 'ab12' } }, { nickname: { _icontains: 'ab12' } }],
		});
	});

	it('adds the exact short_id clause for hex input on a short-id source, lower-cased', () => {
		const or = JSON.parse(sourceParams(source('physical_samples'), 'A1B2C3D4').filter as string)._or;
		expect(or).toContainEqual({ short_id: { _eq: 'a1b2c3d4' } });
	});

	it('does not for non-hex input, or for sources without short ids', () => {
		expect(sourceParams(source('physical_samples'), 'sample-x').filter).not.toContain('short_id');
		expect(sourceParams(source('people'), 'a1b2c3d4').filter).not.toContain('_eq');
	});

	it('asks for the fields operationLabel needs', () => {
		expect(source('manufacturing_operations').fields).toEqual(
			expect.arrayContaining(['pass_code', 'operation_sequence', 'sample_id.sample_code']),
		);
	});
});

describe('rankHit', () => {
	it('orders exact short id, exact code, prefix, contains', () => {
		expect(rankHit('a1b2c3d4', 'S-0042', true)).toBe(0);
		expect(rankHit('s-0042', 'S-0042', false)).toBe(1);
		expect(rankHit('s-00', 'S-0042', false)).toBe(2);
		expect(rankHit('042', 'S-0042', false)).toBe(3);
		expect(rankHit('zzz', 'S-0042', false)).toBe(3);
	});
});

describe('toHits', () => {
	it('labels and routes each source', () => {
		const op = toHits(source('manufacturing_operations'), 'cut', [{ operation_id: 'o1', pass_code: null, operation_sequence: 2, sample_id: { sample_code: 'S-1' } }]);
		expect(op[0]).toMatchObject({ group: 'Operations', label: 'S-1 · step 2', to: '/home/operations/o1' });
		const test = toHits(source('test_sessions'), 'ten', [{ session_id: 't1', test_code: null, test_type: 'tensile' }]);
		expect(test[0]).toMatchObject({ label: 'Test', detail: 'tensile', to: '/home/tests/t1' });
		const sample = toHits(source('physical_samples'), 'nick', [{ sample_id: 's1', sample_code: 'S-9', nickname: 'nick one' }]);
		expect(sample[0]).toMatchObject({ label: 'S-9', detail: 'nick one', to: '/home/samples/s1' });
		const person = toHits(source('people'), 'jo', [{ person_id: 'p1', full_name: 'Jo Smith & Co' }]);
		expect(person[0].to).toBe('/home/people?q=Jo%20Smith%20%26%20Co');
		const project = toHits(source('projects'), 'pr', [{ project_id: 'pj1', project_code: 'PRJ-1', project_name: 'Alpha' }]);
		expect(project[0]).toMatchObject({ label: 'PRJ-1', detail: 'Alpha', to: '/home/projects/pj1' });
	});

	it('names the kind of an inventory hit as its detail', () => {
		const kinds: Array<[string, string, string]> = [
			['tools', 'tool_code', 'Tool'], ['tool_boxes', 'tool_box_code', 'Tool box'], ['cutting_inserts', 'insert_code', 'Cutting insert'],
			['insert_edges', 'edge_code', 'Insert edge'], ['raw_stock_lots', 'lot_code', 'Raw stock lot'],
		];
		for (const [collection, codeField, kind] of kinds) {
			const [hit] = toHits(source(collection), 'x', [{ [`${collection}_id`]: 1, id: 1, [codeField]: 'X-1' }]);
			expect(hit).toMatchObject({ group: 'Inventory', label: 'X-1', detail: kind });
		}
	});

	it('opens inventory rows in their index page drawer by primary key', () => {
		const lot = toHits(source('raw_stock_lots'), 'lot', [{ lot_id: 'L1', lot_code: 'LOT-1' }]);
		expect(lot[0]).toMatchObject({ group: 'Inventory', label: 'LOT-1', to: '/home/stock-lots?open=L1' });
	});

	it('opens a tool box, cutting insert or insert edge on its record page (the index page only opens drawers)', () => {
		const rows: [string, string, string, string][] = [
			['tool_boxes', 'tool_box_id', 'tool_box_code', '/home/tool-boxes/B%201'],
			['cutting_inserts', 'insert_id', 'insert_code', '/home/inserts/B%201'],
			['insert_edges', 'edge_id', 'edge_code', '/home/edges/B%201'],
		];
		for (const [collection, pk, code, to] of rows) {
			const [hit] = toHits(source(collection), 'b', [{ [pk]: 'B 1', [code]: 'B-1' }]);
			expect(hit.to).toBe(to);
		}
	});

	it('ranks an exact short-id match first', () => {
		const rows = [{ sample_id: 's1', sample_code: 'S-1', short_id: 'a1b2c3d4' }, { sample_id: 's2', sample_code: 'a1b2c3d4x', short_id: 'ffffffff' }];
		const hits = toHits(source('physical_samples'), 'a1b2c3d4', rows);
		expect(hits.map((h) => h.rank)).toEqual([0, 2]);
	});
});

describe('mergeHits', () => {
	const hit = (group: FinderHit['group'], label: string, rank: number): FinderHit => ({ group, label, to: `/${label}`, rank });

	it('keeps the spec group order whatever order the groups arrive in', () => {
		const merged = mergeHits('ab', [[hit('People', 'p', 3)], [hit('Samples', 's', 3)], [hit('Pages', 'pg', 3)], [hit('Saved views', 'v', 3)], [hit('Inventory', 'i', 3)]]);
		expect(merged.map((h) => h.group)).toEqual(['Pages', 'Saved views', 'Samples', 'People', 'Inventory']);
	});

	it('puts an exact short id first inside Samples', () => {
		const merged = mergeHits('a1b2c3d4', [[hit('Samples', 'contains', 3), hit('Samples', 'short', 0), hit('Samples', 'prefix', 2)]]);
		expect(merged.map((h) => h.label)).toEqual(['short', 'prefix', 'contains']);
	});

	it('caps a remote group at 5, the merged Inventory sources included', () => {
		const inv = Array.from({ length: 8 }, (_, i) => hit('Inventory', `i${i}`, 3 - (i % 3)));
		expect(mergeHits('ab', [inv.slice(0, 4), inv.slice(4)]).length).toBe(5);
	});

	it('does not cap local groups', () => {
		const pages = Array.from({ length: 8 }, (_, i) => hit('Pages', `pg${i}`, 3));
		expect(mergeHits('ab', [pages]).length).toBe(8);
	});

	it('returns nothing for a query below the minimum', () => {
		expect(mergeHits('a', [[hit('Samples', 's', 3)]])).toEqual([]);
		expect(isSearchable('a ')).toBe(false);
		expect(isSearchable('ab')).toBe(true);
	});
});

describe('visibleSources', () => {
	it('drops sources whose collection is hidden', () => {
		const some = visibleSources(new Set(['physical_samples', 'tools']));
		expect(some.map((s) => s.collection)).toEqual(['physical_samples', 'tools']);
	});

	it('is empty when the collections list failed', () => {
		expect(visibleSources(null)).toEqual([]);
	});

	it('covers the five inventory sources', () => {
		expect(FINDER_SOURCES.filter((s) => s.group === 'Inventory').map((s) => s.collection)).toEqual(
			['tools', 'tool_boxes', 'cutting_inserts', 'insert_edges', 'raw_stock_lots'],
		);
	});
});

describe('hits carry their record', () => {
	it('every remote source says which record a row is', () => {
		const cases: [string, any][] = [
			['physical_samples', { sample_id: 's1', sample_code: 'S-1' }],
			['manufacturing_operations', { operation_id: 'o1' }],
			['test_sessions', { session_id: 't1' }],
			['campaigns', { campaign_id: 'c1' }],
			['projects', { project_id: 'p1' }],
			['people', { person_id: 'pe1', full_name: 'Jo' }],
			['raw_stock_lots', { lot_id: 'L1', lot_code: 'LOT-1' }],
		];
		for (const [collection, row] of cases) {
			const [hit] = toHits(source(collection), 'x', [row]);
			expect(hit.record, collection).toEqual({ collection, id: Object.values(row)[0] });
		}
		for (const src of FINDER_SOURCES) expect(typeof src.record, src.collection).toBe('function');
	});
});
