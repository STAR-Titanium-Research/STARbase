import { describe, expect, it } from 'vitest';
import { buildNav, type Bookmark } from '../nav/navConfig';
import {
	FETCH_LIMIT, FINDER_SOURCES, MIN_QUERY, deepParams, isSearchable, localHits, mergeHits, queryWords, rankHit, sourceParams, toHits, visibleSources,
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
	it('ORs _icontains over the match fields, one more than the 5 shown, the source fields', () => {
		const p = sourceParams(source('physical_samples'), 'ab12');
		expect(p.limit).toBe(FETCH_LIMIT);
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

	it('covers the six inventory sources', () => {
		expect(FINDER_SOURCES.filter((s) => s.group === 'Inventory').map((s) => s.collection)).toEqual(
			['tools', 'tool_boxes', 'cutting_inserts', 'insert_edges', 'raw_stock_lots', 'equipment'],
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

describe('sourceParams with several words', () => {
	const filterOf = (collection: string, q: string) => JSON.parse(sourceParams(source(collection), q).filter as string);

	it('builds exactly the old filter for one word, whitespace around it or not', () => {
		const old = { _or: [{ sample_code: { _icontains: 'ab12' } }, { nickname: { _icontains: 'ab12' } }] };
		expect(filterOf('physical_samples', 'ab12')).toEqual(old);
		expect(filterOf('physical_samples', '  ab12  ')).toEqual(old);
	});

	it('ANDs one OR per word, each word on every match field', () => {
		expect(filterOf('campaigns', 'twelve  alpha')).toEqual({
			_and: [
				{ _or: [{ campaign_code: { _icontains: 'twelve' } }, { name: { _icontains: 'twelve' } }] },
				{ _or: [{ campaign_code: { _icontains: 'alpha' } }, { name: { _icontains: 'alpha' } }] },
			],
		});
	});

	it('tries only a hex word as a short id', () => {
		const and = filterOf('physical_samples', 'a1b2c3d4 steel')._and;
		expect(and[0]._or).toContainEqual({ short_id: { _eq: 'a1b2c3d4' } });
		expect(JSON.stringify(and[1])).not.toContain('short_id');
	});

	it('cuts a very long query at six words', () => {
		expect(filterOf('people', 'a1 b2 c3 d4 e5 f6 g7 h8')._and).toHaveLength(6);
		expect(queryWords('  one   two\tthree ')).toEqual(['one', 'two', 'three']);
	});
});

describe('deepParams (pass 2)', () => {
	const deep = (collection: string, q: string) => deepParams(source(collection), q)!;

	it('is null for a source with nothing more to look in', () => {
		expect(deepParams(source('test_sessions'), 'ab')).toBeNull();
		expect(deepParams(source('directus_files'), 'ab')).toBeNull();
		expect(deepParams(source('materials'), 'ab')).toBeNull();
	});

	it('looks for one word in the deep fields only, and asks for them as well as the hit fields', () => {
		const p = deep('physical_samples', 'anneal');
		expect(JSON.parse(p.filter as string)).toEqual({
			_or: [
				{ notes: { _icontains: 'anneal' } },
				{ legacy_notes: { _icontains: 'anneal' } },
				{ location: { _icontains: 'anneal' } },
				{ project_id: { project_code: { _icontains: 'anneal' } } },
				{ owner_person_id: { full_name: { _icontains: 'anneal' } } },
			],
		});
		expect(p.fields).toEqual(['sample_id', 'sample_code', 'nickname', 'short_id', 'notes', 'legacy_notes', 'location', 'project_id.project_code', 'owner_person_id.full_name']);
		expect(p.limit).toBe(10);
	});

	it('lets several words be spread over the code, name and deep fields', () => {
		const and = JSON.parse(deep('equipment', 'furnace shed').filter as string)._and;
		expect(and).toHaveLength(2);
		for (const clause of and) {
			expect(clause._or.map((c: any) => Object.keys(c)[0])).toEqual(['equipment_code', 'equipment_name', 'notes', 'location']);
		}
	});

	it('covers exactly the narrow list of fields', () => {
		const fieldsOf = (c: string) => source(c).deep?.map((d) => d.field);
		expect(fieldsOf('physical_samples')).toEqual(['notes', 'legacy_notes', 'location', 'project_id.project_code', 'owner_person_id.full_name']);
		expect(fieldsOf('equipment')).toEqual(['notes', 'location']);
		expect(fieldsOf('manufacturing_operations')).toEqual(['outcome_notes']);
		expect(FINDER_SOURCES.filter((s) => s.deep).map((s) => s.collection)).toEqual(['physical_samples', 'manufacturing_operations', 'equipment']);
	});
});

describe('toHits pass 2', () => {
	const sample = source('physical_samples');

	it('ranks 4 and says which field the word was found in', () => {
		const [h] = toHits(sample, 'anneal', [{ sample_id: 's1', sample_code: 'S-1', nickname: '', notes: 'Annealed 2h', location: 'Shed' }], 2);
		expect(h).toMatchObject({ group: 'Samples', label: 'S-1', rank: 4, matchedIn: 'notes', to: '/home/samples/s1' });
	});

	it('reads through the project and owner relations', () => {
		const rows = [
			{ sample_id: 's1', sample_code: 'S-1', project_id: { project_code: 'PRJ-ANNEAL' } },
			{ sample_id: 's2', sample_code: 'S-2', owner_person_id: { full_name: 'Ann Nealson' } },
		];
		expect(toHits(sample, 'prj-anneal', rows.slice(0, 1), 2).map((h) => h.matchedIn)).toEqual(['project']);
		expect(toHits(sample, 'nealson', rows.slice(1), 2).map((h) => h.matchedIn)).toEqual(['owner']);
	});

	it('drops a row pass 1 would have found anyway, and is never an exact short-id hit', () => {
		const rows = [
			{ sample_id: 's1', sample_code: 'ANNEAL-1', notes: 'anneal' },
			{ sample_id: 's2', sample_code: 'S-2', nickname: 'Anneal disc', notes: '' },
			{ sample_id: 's3', sample_code: 'S-3', notes: 'anneal' },
		];
		expect(toHits(sample, 'anneal', rows, 2).map((h) => h.label)).toEqual(['S-3']);
		const [h] = toHits(sample, 'a1b2c3d4', [{ sample_id: 's4', sample_code: 'S-4', short_id: 'ffffffff', location: 'rack a1b2c3d4' }], 2);
		expect(h.rank).toBe(4);
		// the same row, when its short id is the word, is a pass 1 hit
		expect(toHits(sample, 'a1b2c3d4', [{ sample_id: 's5', sample_code: 'S-5', short_id: 'a1b2c3d4', location: 'rack a1b2c3d4' }], 2)).toEqual([]);
	});

	it('with several words, matches each in a pass 1 or a pass 2 field', () => {
		const rows = [{ sample_id: 's1', sample_code: 'S-0042', notes: 'annealed' }, { sample_id: 's2', sample_code: 'S-0043', notes: 'annealed' }];
		// "s-0042" is in the code, "anneal" only in the notes: pass 1 (code and name only) would not find it
		expect(toHits(sample, 's-0042 anneal', rows, 2).map((h) => h.label)).toEqual(['S-0042', 'S-0043']);
		expect(toHits(sample, 's-0042 anneal', rows, 2)[0].matchedIn).toBe('notes');
	});

	it('gives a snippet of the value for a field on the row itself, and never for a relation', () => {
		const long = `${'x'.repeat(50)} Annealed in argon ${'y'.repeat(50)}`;
		const [own] = toHits(sample, 'annealed', [{ sample_id: 's1', sample_code: 'S-1', notes: long }], 2);
		expect(own.matchedSnippet).toMatch(/^….*Annealed.*…$/);
		expect(own.matchedSnippet!.length).toBeLessThan(long.length);
		const [short] = toHits(sample, 'shed', [{ sample_id: 's2', sample_code: 'S-2', location: 'Shed 4' }], 2);
		expect(short.matchedSnippet).toBe('Shed 4');
		const [project] = toHits(sample, 'prj-9', [{ sample_id: 's3', sample_code: 'S-3', project_id: { project_code: 'PRJ-9' } }], 2);
		expect(project).toMatchObject({ matchedIn: 'project' });
		expect(project.matchedSnippet).toBeUndefined();
		expect(JSON.stringify(project)).not.toContain('PRJ-9');
		const [owner] = toHits(sample, 'nealson', [{ sample_id: 's4', sample_code: 'S-4', owner_person_id: { full_name: 'Ann Nealson' } }], 2);
		expect(owner.matchedSnippet).toBeUndefined();
		expect(JSON.stringify(owner)).not.toContain('Nealson');
	});

	it('leaves matchedIn off when no deep field holds a word', () => {
		const [h] = toHits(sample, 'zzz', [{ sample_id: 's1', sample_code: 'S-1' }], 2);
		expect(h.matchedIn).toBeUndefined();
		expect(h.rank).toBe(4);
	});

	it('is pass 1 unless told otherwise', () => {
		const [h] = toHits(sample, 's-1', [{ sample_id: 's1', sample_code: 'S-1' }]);
		expect(h.rank).toBe(1);
		expect(h.matchedIn).toBeUndefined();
	});
});

describe('the new sources', () => {
	it('materials: alloy code as the label, common name as the detail, the Materials drawer', () => {
		const [hit] = toHits(source('materials'), 'ti', [{ material_id: 'm1', alloy_code: 'Ti-6Al-4V', common_name: 'Grade 5 titanium' }]);
		expect(hit).toMatchObject({
			group: 'Reference', label: 'Ti-6Al-4V', detail: 'Grade 5 titanium', to: '/home/materials?open=m1', rank: 2,
			record: { collection: 'materials', id: 'm1' },
		});
		expect(JSON.parse(sourceParams(source('materials'), 'ti').filter as string)._or).toEqual([
			{ alloy_code: { _icontains: 'ti' } }, { common_name: { _icontains: 'ti' } },
		]);
	});

	it('materials fall back to the common name, and keep out of the form pickers', () => {
		expect(toHits(source('materials'), 'x', [{ material_id: 'm2', alloy_code: null, common_name: 'Mystery' }])[0]).toMatchObject({ label: 'Mystery' });
		expect(source('materials').finderOnly).toBe(true);
		expect(source('directus_files').finderOnly).toBe(true);
	});

	it('files: asked of /files by filename and title, the filename as the label, the file type as the detail', () => {
		const files = source('directus_files');
		expect(files.path).toBe('/files');
		expect(JSON.parse(sourceParams(files, 'scan').filter as string)._or).toEqual([
			{ filename_download: { _icontains: 'scan' } }, { title: { _icontains: 'scan' } },
		]);
		const [first, plain, untitled] = toHits(files, 'scan', [
			{ id: 'f1', filename_download: 'scan 01.tif', title: 'Scan', type: 'image/tiff' },
			{ id: 'f 2', filename_download: 'scan.csv', type: 'text/csv' },
			{ id: 'f3', filename_download: '', title: 'Only a title' },
		]);
		expect(first).toMatchObject({ group: 'Files', label: 'scan 01.tif', detail: 'image/tiff', to: '/files/f1', record: { collection: 'directus_files', id: 'f1' } });
		expect(plain).toMatchObject({ label: 'scan.csv', detail: 'text/csv', to: '/files/f%202' });
		expect(untitled.label).toBe('Only a title');
	});

	it('both are searched only where the collection is readable', () => {
		expect(visibleSources(new Set(['materials', 'directus_files'])).map((s) => s.collection)).toEqual(['materials', 'directus_files']);
	});
});

describe('mergeHits ranking, caps and "More in" rows', () => {
	const rec = (group: FinderHit['group'], collection: string, id: string, rank: number, extra: Partial<FinderHit> = {}): FinderHit =>
		({ group, label: id, to: `/${collection}/${id}`, rank, record: { collection, id }, ...extra });
	const many = (group: FinderHit['group'], collection: string, prefix: string, n: number, rank = 3, from = 0) => Array.from({ length: n }, (_, i) => rec(group, collection, `${prefix}${from + i}`, rank));
	const samples = (n: number, rank = 3, from = 0) => many('Samples', 'physical_samples', 's', n, rank, from);

	it('puts a pass 2 hit (rank 4) below every pass 1 hit of its group', () => {
		const merged = mergeHits('ab', [[rec('Samples', 'physical_samples', 'deep', 4)], [rec('Samples', 'physical_samples', 'exact', 1), rec('Samples', 'physical_samples', 'contains', 3)]]);
		expect(merged.map((h) => h.label)).toEqual(['exact', 'contains', 'deep']);
	});

	it('counts a record found by both passes once, at its best rank', () => {
		const merged = mergeHits('ab', [[rec('Samples', 'physical_samples', 's1', 4, { matchedIn: 'notes' })], [rec('Samples', 'physical_samples', 's1', 2)]]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ rank: 2 });
		expect(merged[0].matchedIn).toBeUndefined();
		// whichever answer arrived first
		expect(mergeHits('ab', [[rec('Samples', 'physical_samples', 's1', 2)], [rec('Samples', 'physical_samples', 's1', 4)]])[0].rank).toBe(2);
	});

	it('ends a group that has more than 5 hits with a "More in <Page>…" row opening the Explorer search', () => {
		const merged = mergeHits('ab', [samples(6)]);
		expect(merged).toHaveLength(6);
		expect(merged.slice(0, 5).every((h) => !h.more)).toBe(true);
		expect(merged[5]).toMatchObject({ group: 'Samples', label: 'More in Samples…', more: true, to: '/home/samples?q=ab' });
		expect(merged[5].record).toBeUndefined();
	});

	it('has none for a query of several words (the Explorer search would find nothing), nor for hits left out that were only pass 2', () => {
		expect(mergeHits('ab cd', [samples(6)]).some((h) => h.more)).toBe(false);
		expect(mergeHits('ab', [samples(5), samples(3, 4, 5)]).some((h) => h.more)).toBe(false);
		// left out of the 12 as well: a pass 1 hit that lost its place to better ranked ones in other groups still counts
		expect(mergeHits('ab', [samples(5), samples(1, 3, 5)]).at(-1)).toMatchObject({ more: true });
	});

	it('has no such row when nothing was left out', () => {
		expect(mergeHits('ab', [samples(5)]).some((h) => h.more)).toBe(false);
	});

	it('names the page that lost the most in a group of several, and has a target for people, files and projects', () => {
		const tools = many('Inventory', 'tools', 't', 5);
		const lots = many('Inventory', 'raw_stock_lots', 'l', 3);
		const inv = mergeHits('ab', [tools, lots]);
		expect(inv.filter((h) => h.group === 'Inventory' && !h.more).map((h) => h.record?.collection)).toEqual(Array(5).fill('tools'));
		// 5 tools fill the group (all rank 3, arrival order), so the 3 lots are what was left out
		expect(inv.at(-1)).toMatchObject({ more: true, label: 'More in Raw stock lots…', to: '/home/stock-lots?q=ab' });
		const people = many('People', 'people', 'p', 6);
		expect(mergeHits('jo', [people]).at(-1)).toMatchObject({ label: 'More in People…', to: '/home/people?q=jo' });
		const files = many('Files', 'directus_files', 'f', 6);
		expect(mergeHits('jo', [files]).at(-1)).toMatchObject({ label: 'More in Files…', to: '/files' });
		const projects = many('Projects', 'projects', 'j', 6);
		expect(mergeHits('jo', [projects]).at(-1)).toMatchObject({ label: 'More in Projects…', to: '/home/projects' });
	});

	it('caps the whole record list at 12, keeping the best ranked across groups in group order', () => {
		const ops = many('Operations', 'manufacturing_operations', 'o', 5);
		const people = many('People', 'people', 'p', 5, 1);
		const merged = mergeHits('ab', [samples(5, 2), ops, people]);
		const records = merged.filter((h) => !h.more);
		expect(records).toHaveLength(12);
		// the three operations that missed the cut ranked lowest; all samples and people stay
		expect(records.filter((h) => h.group === 'Samples')).toHaveLength(5);
		expect(records.filter((h) => h.group === 'People')).toHaveLength(5);
		expect(records.filter((h) => h.group === 'Operations')).toHaveLength(2);
		expect(merged.map((h) => h.group)).toEqual([...Array(5).fill('Samples'), 'Operations', 'Operations', 'Operations', ...Array(5).fill('People')]);
		expect(merged[7]).toMatchObject({ more: true, label: 'More in Operations…', to: '/home/operations?q=ab' });
	});

	it('breaks a rank tie across groups in favour of the earlier group', () => {
		const ops = many('Operations', 'manufacturing_operations', 'o', 5);
		const tests = many('Tests', 'test_sessions', 't', 5);
		const merged = mergeHits('ab', [samples(5), ops, tests]).filter((h) => !h.more);
		expect(merged.filter((h) => h.group === 'Tests')).toHaveLength(2);
		expect(merged.filter((h) => h.group === 'Operations')).toHaveLength(5);
	});

	it('does not count Pages and Saved views in the 12, and gives a group with nothing left no heading', () => {
		const pages = Array.from({ length: 4 }, (_, i) => ({ group: 'Pages' as const, label: `pg${i}`, to: `/pg${i}`, rank: 3 }));
		const files = many('Files', 'directus_files', 'f', 5, 4);
		const merged = mergeHits('ab', [pages, samples(5), samples(5, 3, 5), files]);
		expect(merged.filter((h) => h.group === 'Pages')).toHaveLength(4);
		expect(merged.filter((h) => h.group === 'Samples' && !h.more)).toHaveLength(5);
		expect(merged.some((h) => h.group === 'Files')).toBe(true);
		const crowded = mergeHits('ab', [samples(5), many('Operations', 'manufacturing_operations', 'o', 5), many('Tests', 'test_sessions', 't', 5), files]);
		expect(crowded.some((h) => h.group === 'Files')).toBe(false);
	});
});
