import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import { fakeServer, httpError } from './fakeBuildServer';
import { useEditCatalog } from './useEditCatalog';

const make = () => {
	const server = fakeServer();
	return { ...server, catalog: useEditCatalog(server.api, async () => []) };
};

describe('useEditCatalog', () => {
	it('reads picked samples whole: the card, the version, and the record with its relations as ids', async () => {
		const { catalog, s } = make();
		const read = await catalog.loadSamples(['s1', 'nope']);
		expect([...read.keys()]).toEqual(['s1']);
		const one = read.get('s1')!;
		expect(one.version).toBe(4);
		expect(one.sample).toMatchObject({ id: 's1', code: 'PS-001' });
		expect(one.values.material_id).toBe('mat1');
		expect(one.values.project_id).toBe('proj1');
		expect(catalog.samples.get('s1')?.code).toBe('PS-001');
		expect(catalog.records.get('physical_samples:s1')?.values.material_id).toBe('mat1');
		expect(s.calls.filter((c) => c === 'GET /items/physical_samples')).toHaveLength(1);
	});

	it('reads nothing for nothing', async () => {
		const { catalog, s } = make();
		expect((await catalog.loadSamples([])).size).toBe(0);
		expect(s.calls).toEqual([]);
	});

	it('searches the samples by code, two letters at least', async () => {
		const { catalog } = make();
		expect(await catalog.searchSamples('p')).toEqual([]);
		expect((await catalog.searchSamples('PS-002')).map((r) => r.code)).toEqual(['PS-002']);
	});

	it('reads the methods and the field definitions once', async () => {
		const { catalog, s } = make();
		await Promise.all([catalog.ensure(), catalog.ensure()]);
		expect(catalog.methods.value.map((m) => m.code)).toEqual(['MF', 'HT', 'MC']);
		expect(s.calls.filter((c) => c === 'GET /items/manufacturing_methods')).toHaveLength(1);
	});

	it('marks a record asked for and not answered as gone', async () => {
		const { catalog } = make();
		await catalog.loadRecords({ physical_samples: ['s9'], manufacturing_operations: [], test_sessions: [] });
		expect(catalog.records.get('physical_samples:s9')).toBeNull();
	});

	it('asks once when the same samples are asked for while a read is on its way', async () => {
		const { catalog, s } = make();
		const [a, b] = await Promise.all([catalog.loadSamples(['s1']), catalog.loadSamples(['s1', 's2'])]);
		expect([...a.keys()]).toEqual(['s1']);
		expect([...b.keys()].sort()).toEqual(['s1', 's2']);
		// s1 was already being read: the second ask read only s2.
		expect(s.calls.filter((c) => c === 'GET /items/physical_samples')).toHaveLength(2);
	});

	it('remembers a read that failed, so it is not asked again on every change of the draft, until told to forget', async () => {
		const server = fakeServer();
		let asked = 0;
		const api = { ...server.api, get: async () => (asked++, Promise.reject(httpError(500))) } as unknown as HostApi;
		const catalog = useEditCatalog(api, async () => []);
		const want = { physical_samples: [], manufacturing_operations: ['o1'], test_sessions: [] };
		await catalog.loadRecords(want);
		await catalog.loadRecords(want);
		expect(asked).toBe(1);
		catalog.forgetFailed();
		await catalog.loadRecords(want);
		expect(asked).toBe(2);
	});

	it('a caller that finds the record being read waits for that read: it has the answer when its own call returns (a delete needs the version)', async () => {
		const server = fakeServer();
		const catalog = useEditCatalog(server.api, async () => []);
		const want = { physical_samples: [], manufacturing_operations: ['o1'], test_sessions: [] };
		const first = catalog.loadRecords(want); // the draft's own read, on its way
		await catalog.loadRecords(want);
		expect(catalog.records.has('manufacturing_operations:o1'), 'read by the time the second call returns').toBe(true);
		await first;
	});

	it('retry asks again for a record whose read failed (a delete must not stay stuck on one failure)', async () => {
		const server = fakeServer();
		let failing = true;
		let asked = 0;
		const api = { ...server.api, get: async (...a: Parameters<HostApi['get']>) => (asked++, failing ? Promise.reject(httpError(500)) : server.api.get(...a)) } as unknown as HostApi;
		const catalog = useEditCatalog(api, async () => []);
		const want = { physical_samples: [], manufacturing_operations: ['o1'], test_sessions: [] };
		await catalog.loadRecords(want);
		expect(catalog.records.has('manufacturing_operations:o1')).toBe(false);
		failing = false;
		await catalog.loadRecords(want);
		expect(asked, 'the draft\'s own reads leave the failed one alone').toBe(1);
		await catalog.loadRecords(want, { retry: true });
		expect(asked).toBe(2);
		expect(catalog.records.has('manufacturing_operations:o1')).toBe(true);
	});

	describe('operations to attach (slice 3)', () => {
		const orphan = (id: string, over: Record<string, unknown> = {}) => ({
			operation_id: id, pass_code: `CODE-${id}`, operation_sequence: 1, operation_date: null, planned_date: '2026-11-01', work_state: 'planned', version: 5, sample_id: null,
			method_id: { method_id: 'm-turn', method_name: 'Turning' }, owner_person_id: { full_name: 'Ada' }, output_sample_id: { sample_id: 's2', sample_code: 'PS-002' }, ...over,
		});

		it('lists the operations with no input sample, searched by words, a page at a time, and says when there is more', async () => {
			const { catalog, s } = make();
			s.rows.manufacturing_operations = [orphan('a'), orphan('b'), orphan('c', { sample_id: 's1' }), orphan('d', { pass_code: 'OTHER-d' })];
			const all = await catalog.searchOrphans('');
			expect(all.rows.map((r) => r.id)).toEqual(['a', 'b', 'd']);
			expect(all.more).toBe(false);
			expect((await catalog.searchOrphans('code')).rows.map((r) => r.id)).toEqual(['a', 'b']);
			expect((await catalog.searchOrphans('turning')).rows).toHaveLength(3);
			expect((await catalog.searchOrphans('ps-002')).rows).toHaveLength(3);
			expect((await catalog.searchOrphans('nothing like it')).rows).toEqual([]);
		});

		it('marks the operations whose sample already comes from another sample (another operation makes it from an input)', async () => {
			const { catalog, s } = make();
			s.rows.manufacturing_operations = [orphan('a'), orphan('b', { output_sample_id: { sample_id: 's1', sample_code: 'PS-001' } }), { operation_id: 'maker', sample_id: 's9', output_sample_id: 's1', version: 1 }];
			const { rows } = await catalog.searchOrphans('');
			expect(rows.map((r) => [r.id, r.origins])).toEqual([['a', []], ['b', ['s9']]]);
		});

		it('pages: a full page and one more row mean there is a next page', async () => {
			const { catalog, s } = make();
			s.rows.manufacturing_operations = Array.from({ length: 25 }, (_, i) => orphan(`o${i}`));
			const first = await catalog.searchOrphans('');
			expect(first.rows).toHaveLength(20);
			expect(first.more).toBe(true);
			const next = await catalog.searchOrphans('', 20);
			expect(next.rows.map((r) => r.id)).toEqual(['o20', 'o21', 'o22', 'o23', 'o24']);
			expect(next.more).toBe(false);
		});

		it('reads an operation to attach whole: the card the map draws, the version, the record with its relations as ids, and the sample it made', async () => {
			const { catalog, s } = make();
			s.rows.manufacturing_operations = [orphan('a', { equipment_id: { equipment_id: 'e1', equipment_name: 'Lathe' }, output_sample_id: 's2' })];
			const read = await catalog.loadOperations(['a', 'nope']);
			expect([...read.keys()]).toEqual(['a']);
			const one = read.get('a')!;
			expect(one.version).toBe(5);
			expect(one.hasInput).toBe(false);
			expect(one.values.method_id).toBe('m-turn');
			expect(one.values.equipment_id).toBe('e1');
			expect(catalog.operations.get('a')).toMatchObject({ id: 'a', methodName: 'Turning', workState: 'planned', sampleId: null, outputSampleId: 's2' });
			expect(catalog.records.get('manufacturing_operations:a')).toMatchObject({ version: 5, hasInput: false });
			// the sample it made is read as well, so the canvas can draw it
			expect(catalog.samples.get('s2')?.code).toBe('PS-002');
		});

		it('an operation that has an input by now is read as one (a fresh read at the pick sees it)', async () => {
			const { catalog, s } = make();
			s.rows.manufacturing_operations = [orphan('a')];
			await catalog.loadOperations(['a']);
			s.rows.manufacturing_operations = [orphan('a', { sample_id: 's1', version: 6 })];
			const cached = await catalog.loadOperations(['a']);
			expect(cached.get('a')?.version).toBe(5);
			const fresh = await catalog.loadOperations(['a'], { fresh: true });
			expect(fresh.get('a')).toMatchObject({ version: 6, hasInput: true });
			expect(catalog.records.get('manufacturing_operations:a')).toMatchObject({ version: 6, hasInput: true });
		});

		it('a read that fails leaves nothing and throws, so the picker can say so', async () => {
			const server = fakeServer();
			const api = { ...server.api, get: async () => Promise.reject(httpError(500)) } as unknown as HostApi;
			const catalog = useEditCatalog(api, async () => []);
			await expect(catalog.loadOperations(['a'], { fresh: true })).rejects.toThrow();
			await expect(catalog.searchOrphans('')).rejects.toThrow();
			expect(catalog.operations.size).toBe(0);
		});
	});

	it('does not ask for a record that is already being read', async () => {
		const server = fakeServer();
		let asked = 0;
		const api = { ...server.api, get: async (...a: Parameters<HostApi['get']>) => (asked++, server.api.get(...a)) } as unknown as HostApi;
		const catalog = useEditCatalog(api, async () => []);
		const want = { physical_samples: [], manufacturing_operations: ['o1'], test_sessions: [] };
		await Promise.all([catalog.loadRecords(want), catalog.loadRecords(want)]);
		expect(asked).toBe(1);
	});
});
