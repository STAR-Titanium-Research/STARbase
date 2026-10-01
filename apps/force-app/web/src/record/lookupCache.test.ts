import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../directusClient', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));
const auth = vi.hoisted(() => ({ state: { user: { id: 'u' }, offline: false, accessToken: 'at' as string | null, refreshToken: 'rt' as string | null } }));
vi.mock('../authStore', () => ({ authStore: auth }));
vi.mock('./labampApi', () => ({ labamp: {} }));

import { setLookupStore, syncLookups, lookupStatus, cachedRows, type KvStore } from './lookupCache';
import { resolveMachiningMethodId } from './directusLookups';
import { searchSamples, searchOperators, searchEquipment, searchTools, searchEdges, searchInserts, getMethods } from './directusLookups';

const mem = () => {
	const m = new Map<string, any>();
	const s: KvStore = { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
	return { m, s };
};
const netErr = () => Object.assign(new Error('Network Error'), { response: undefined });

const ROWS: Record<string, any[]> = {
	physical_samples: [
		{ sample_id: 's1', sample_code: 'AA-MF-001', diameter_mm: 25, nickname: 'Ti rod', code_sort: '0001' },
		{ sample_id: 's2', sample_code: 'AA-MF-002', diameter_mm: 30, nickname: null, code_sort: '0002' },
		{ sample_id: 's3', sample_code: null, diameter_mm: null, nickname: 'legacy', code_sort: '0000' },
	],
	people: [
		{ person_id: 'p1', full_name: 'Ada Lovelace', is_operator: true },
		{ person_id: 'p2', full_name: 'Not An Operator', is_operator: false },
	],
	equipment: [
		{ equipment_id: 'e1', equipment_name: 'NLX 2500', equipment_code: 'NLX', equipment_type: 'Machining', is_active: true },
		{ equipment_id: 'e2', equipment_name: 'SEM', equipment_code: 'SEM', equipment_type: 'Microscope', is_active: true },
		{ equipment_id: 'e3', equipment_name: 'Retired lathe', equipment_code: 'OLD', equipment_type: 'Machining', is_active: false },
	],
	tools: [
		{ tool_id: 't1', tool_code: 'T-1', tool_name: 'Turn holder', tool_type: 'Turning', is_active: true },
		{ tool_id: 't2', tool_code: 'T-2', tool_name: 'End mill', tool_type: 'Milling', is_active: true },
	],
	cutting_inserts: [
		{ insert_id: 'i1', insert_code: 'INS-1', insert_number: 1, insert_type_id: { type_code: 'CNMG' }, is_depleted: false },
		{ insert_id: 'i2', insert_code: 'INS-2', insert_number: 2, insert_type_id: null, is_depleted: true },
	],
	insert_edges: [
		{ edge_id: 'd1', edge_code: 'INS-1-A', edge_identifier: 'A', is_used: false, insert_id: { insert_id: 'i1', insert_code: 'INS-1' } },
		{ edge_id: 'd2', edge_code: 'INS-1-B', edge_identifier: 'B', is_used: true, insert_id: { insert_id: 'i1', insert_code: 'INS-1' } },
		{ edge_id: 'd3', edge_code: 'INS-9-A', edge_identifier: 'A', is_used: false, insert_id: { insert_id: 'i9', insert_code: 'INS-9' } },
	],
	manufacturing_methods: [
		{ method_id: 'm1', method_name: 'Turning', method_code: 'MT' },
	],
};

beforeEach(() => {
	get.mockReset();
	setLookupStore(mem().s);
	auth.state.offline = false; auth.state.accessToken = 'at'; auth.state.refreshToken = 'rt';
	lookupStatus.counts = {}; lookupStatus.syncedAt = null; lookupStatus.error = null;
});

// Snapshot everything while "online", then cut the network.
async function snapshotThenGoOffline() {
	get.mockImplementation(async (url: string) => ({ data: { data: ROWS[url.replace('/items/', '')] ?? [] } }));
	await syncLookups();
	get.mockReset();
	get.mockRejectedValue(netErr());
}

describe('syncLookups', () => {
	it('stores every entity and records when', async () => {
		await snapshotThenGoOffline();
		expect(lookupStatus.syncedAt).not.toBeNull();
		expect(lookupStatus.counts.samples).toBe(3);
		expect((await cachedRows('edges'))?.length).toBe(3);
	});

	it('pages until a short page', async () => {
		const page = (n: number) => Array.from({ length: n }, (_, i) => ({ sample_id: `x${i}-${n}`, sample_code: 'c' }));
		get.mockImplementation(async (url: string, cfg: any) => {
			if (url !== '/items/physical_samples') return { data: { data: [] } };
			return { data: { data: cfg.params.page === 1 ? page(1000) : cfg.params.page === 2 ? page(1000).map((r) => ({ ...r, sample_id: 'b' + r.sample_id })) : page(5).map((r) => ({ ...r, sample_id: 'c' + r.sample_id })) } };
		});
		await syncLookups();
		expect(lookupStatus.counts.samples).toBe(2005);
	});

	it('a failed entity keeps its previous snapshot', async () => {
		await snapshotThenGoOffline();
		get.mockImplementation(async (url: string) => {
			if (url === '/items/physical_samples') throw Object.assign(new Error('x'), { response: { status: 500 } });
			return { data: { data: [] } };
		});
		await syncLookups();
		expect(lookupStatus.counts.samples).toBe(3);      // kept
		expect(lookupStatus.counts.people).toBe(0);       // others refreshed
		expect(lookupStatus.error).toMatch(/physical_samples/);
	});

	it('a partly failed sync is not stamped fresh, and only the failed entity is retried', async () => {
		const ok = async (url: string) => ({ data: { data: ROWS[url.replace('/items/', '')] ?? [] } });
		get.mockImplementation(async (url: string) => {
			if (url === '/items/tools') throw Object.assign(new Error('x'), { response: { status: 500 } });
			return ok(url);
		});
		await syncLookups();
		expect(lookupStatus.syncedAt).toBeNull();            // NOT fresh: a retry is still owed
		expect(lookupStatus.error).toMatch(/tools/);
		expect(lookupStatus.counts.samples).toBe(3);         // the rest did land

		get.mockReset();
		get.mockImplementation(ok);
		await syncLookups(['tools']);                        // what the background timer does
		expect(get.mock.calls.every(([url]) => url === '/items/tools')).toBe(true);
		expect(lookupStatus.syncedAt).not.toBeNull();        // now nothing is failing
		expect(lookupStatus.error).toBeNull();
		expect(lookupStatus.counts.tools).toBe(2);
	});

	it('does nothing without a server session', async () => {
		auth.state.offline = true; auth.state.accessToken = null; auth.state.refreshToken = null;
		await syncLookups();
		expect(get).not.toHaveBeenCalled();
	});
});

describe('pickers with the server unreachable', () => {
	beforeEach(snapshotThenGoOffline);

	it('samples: matches code or nickname, newest code first', async () => {
		expect((await searchSamples('')).map((x) => x.id)).toEqual(['s2', 's1', 's3']);
		expect((await searchSamples('ti r')).map((x) => x.id)).toEqual(['s1']);
		expect((await searchSamples('aa-mf-002'))[0]).toMatchObject({ id: 's2', label: 'AA-MF-002', extra: { diameter_mm: 30 } });
	});

	it('operators: only is_operator people', async () => {
		expect((await searchOperators('')).map((x) => x.id)).toEqual(['p1']);
		expect(await searchOperators('not an')).toEqual([]);
	});

	it('equipment: active only; machining category preferred, falling back to all', async () => {
		expect((await searchEquipment('', 'turning')).map((x) => x.id)).toEqual(['e1']);
		expect((await searchEquipment('sem', 'turning')).map((x) => [x.id, x.extra?.categoryFallback])).toEqual([['e2', true]]);
		expect((await searchEquipment('')).map((x) => x.id)).toEqual(['e1', 'e2']);
	});

	it('tools: filtered by category, with the fallback flag when nothing fits', async () => {
		expect((await searchTools('', 'Milling')).map((x) => x.id)).toEqual(['t2']);
		expect((await searchTools('', 'Grinding')).every((x) => x.extra?.categoryFallback)).toBe(true);
	});

	it('inserts hide depleted ones; edges hide used ones and follow the chosen insert', async () => {
		expect((await searchInserts('')).map((x) => x.id)).toEqual(['i1']);
		expect((await searchEdges('')).map((x) => x.id)).toEqual(['d1', 'd3']);
		expect((await searchEdges('', 'i1')).map((x) => x.id)).toEqual(['d1']);
		expect((await searchEdges('')).find((x) => x.id === 'd1')?.extra).toEqual({ insertId: 'i1', insertLabel: 'INS-1' });
	});

	it('methods resolve after a restart (no in-memory copy) from the snapshot', async () => {
		expect((await getMethods()).map((m) => m.id)).toEqual(['m1']);
	});
});

describe('when there is nothing to fall back on', () => {
	it('the original network error stands', async () => {
		get.mockRejectedValue(netErr());
		await expect(searchOperators('x')).rejects.toThrow('Network Error');
	});

	it('a real server error is not masked by stale data', async () => {
		await snapshotThenGoOffline();
		get.mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));
		await expect(searchOperators('x')).rejects.toThrow('forbidden');
	});

	it('an offline session goes straight to the snapshot without touching the network', async () => {
		await snapshotThenGoOffline();
		auth.state.offline = true;
		get.mockClear();
		expect((await searchOperators('')).length).toBe(1);
		expect(get).not.toHaveBeenCalled();
	});
});

describe('methods list', () => {
	it('an offline (possibly empty or stale) answer is not memoized over the real one', async () => {
		vi.resetModules();
		const m = await import('./directusLookups');
		const c = await import('./lookupCache');
		c.setLookupStore(mem().s);                         // no snapshot: an empty list offline...
		auth.state.offline = true;
		expect(await m.getMethods().catch(() => [])).toEqual([]);

		auth.state.offline = false;                        // ...then the network returns
		get.mockReset();
		get.mockResolvedValue({ data: { data: ROWS.manufacturing_methods } });
		expect((await m.getMethods()).map((x) => x.id)).toEqual(['m1']);   // fetched, not stuck on []
		get.mockClear();
		await m.getMethods();
		expect(get).not.toHaveBeenCalled();                // a real answer IS memoized
	});
});
