import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ExplorerHost } from '../host';
import { buildNav } from '../nav/navConfig';
import { FINDER_DEBOUNCE_MS, SCAN_IDLE_MS, useFinder } from './useFinder';
import { openHit } from './finderNav';

const visible = new Set(['physical_samples', 'manufacturing_operations', 'campaigns']);

function setup(get: (path: string) => Promise<any>) {
	const calls: Array<{ path: string; params: any }> = [];
	const host = {
		api: { get: (path: string, cfg?: any) => { calls.push({ path, params: cfg?.params }); return get(path); } },
	} as unknown as ExplorerHost;
	const nav = ref(buildNav(visible, [], false));
	const finder = useFinder(host, nav, ref<Set<string> | null>(visible));
	return { finder, calls };
}

const rowsFor = (path: string) => {
	if (path === '/items/physical_samples') return { data: { data: [{ sample_id: 's1', sample_code: '12-ABC', nickname: 'disc', short_id: 'aaaaaaaa' }] } };
	if (path === '/items/campaigns') return { data: { data: [{ campaign_id: 'c1', campaign_code: 'CAMP-12', name: 'Twelve' }] } };
	return { data: { data: [] } };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useFinder', () => {
	it('asks again for the typed query when the readable collections arrive late', async () => {
		const calls: string[] = [];
		const host = { api: { get: async (path: string) => { calls.push(path); return rowsFor(path); } } } as unknown as ExplorerHost;
		const sources = ref<Set<string> | null>(null);
		const finder = useFinder(host, ref(buildNav(null, [], false)), sources);
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		// nothing to ask yet: an empty answer, not a pending one
		expect(calls).toEqual([]);
		expect(finder.hits.value).toEqual([]);
		sources.value = visible;
		await vi.advanceTimersByTimeAsync(0);
		// samples and operations are asked twice: pass 1 (code, name) and pass 2 (notes, location...)
		expect(calls.sort()).toEqual(['/items/campaigns', '/items/manufacturing_operations', '/items/manufacturing_operations', '/items/physical_samples', '/items/physical_samples']);
		expect(finder.loading.value).toBe(false);
		expect(finder.hits.value.map((h) => h.group)).toEqual(['Samples', 'Campaigns']);
	});

	it('does not search when the collections arrive and nothing searchable is typed', async () => {
		const calls: string[] = [];
		const host = { api: { get: async (path: string) => { calls.push(path); return rowsFor(path); } } } as unknown as ExplorerHost;
		const sources = ref<Set<string> | null>(null);
		const finder = useFinder(host, ref(buildNav(null, [], false)), sources);
		finder.query.value = 's';
		sources.value = visible;
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toEqual([]);
		expect(finder.loading.value).toBe(false);
	});

	it('asks the server nothing below the minimum length, but still matches pages', async () => {
		const { finder, calls } = setup(async (p) => rowsFor(p));
		finder.query.value = 's';
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toEqual([]);
		expect(finder.hits.value).toEqual([]);
		expect(finder.loading.value).toBe(false);
	});

	it('shows local hits at once and the records after the debounce', async () => {
		const { finder, calls } = setup(async (p) => rowsFor(p));
		finder.query.value = 'sam';
		expect(finder.hits.value.map((h) => h.group)).toEqual(['Pages']);
		expect(finder.loading.value).toBe(true);
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS - 1);
		expect(calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls.map((c) => c.path).sort()).toEqual(['/items/campaigns', '/items/manufacturing_operations', '/items/manufacturing_operations', '/items/physical_samples', '/items/physical_samples']);
		expect(finder.loading.value).toBe(false);
		expect(finder.hits.value.map((h) => h.group)).toEqual(['Pages', 'Samples', 'Campaigns']);
	});

	it('only queries the collections the user can read', async () => {
		const { finder, calls } = setup(async (p) => rowsFor(p));
		finder.query.value = 'ab';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		expect(calls.some((c) => c.path === '/items/tools')).toBe(false);
	});

	it('drops only the group whose request failed', async () => {
		const { finder } = setup(async (p) => {
			if (p === '/items/manufacturing_operations') throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
			return rowsFor(p);
		});
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		expect(finder.loading.value).toBe(false);
		expect(finder.hits.value.map((h) => h.group)).toEqual(['Samples', 'Campaigns']);
	});

	it('discards an answer to a query that was typed over', async () => {
		let release: (() => void) | undefined;
		const { finder } = setup((p) => {
			if (p === '/items/physical_samples') return new Promise((res) => { release = () => res(rowsFor(p)); });
			return Promise.resolve(rowsFor(p));
		});
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		finder.query.value = '1';
		release?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value).toEqual([]);
		expect(finder.loading.value).toBe(false);
	});

	it('does not show the previous query\'s records while the next is pending', async () => {
		const { finder } = setup(async (p) => rowsFor(p));
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		expect(finder.hits.value.some((h) => h.group === 'Samples')).toBe(true);
		finder.query.value = '12-';
		expect(finder.hits.value.some((h) => h.group === 'Samples')).toBe(false);
	});
});

describe('useFinder with a scanned label', () => {
	const typed = 'D1 SAMPLE\rS-0123 - 1a2b3c4d\rTi-6Al-4V\r';
	const sample = { data: { data: [{ sample_id: 'uuid-1', sample_code: 'S-0123', short_id: '1a2b3c4d' }] } };

	function scanSetup(get: (path: string, params: any) => Promise<any>) {
		const calls: Array<{ path: string; filter: any }> = [];
		const host = { api: { get: (path: string, cfg?: any) => { calls.push({ path, filter: JSON.parse(cfg.params.filter) }); return get(path, cfg?.params); } } } as unknown as ExplorerHost;
		const opened: string[] = [];
		const finder = useFinder(host, ref(buildNav(visible, [], false)), ref<Set<string> | null>(visible), { onOpen: (to) => opened.push(to) });
		return { finder, calls, opened };
	}

	it('opens the sample once the scanner has gone quiet, and runs no search', async () => {
		const { finder, calls, opened } = scanSetup(async () => sample);
		finder.query.value = typed;
		expect(finder.scan.value).toEqual({ status: 'reading' });
		expect(finder.hits.value).toEqual([]);
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(opened).toEqual(['/home/samples/uuid-1']);
		expect(calls).toEqual([{ path: '/items/physical_samples', filter: { short_id: { _eq: '1a2b3c4d' } } }]);
	});

	it('waits while more of the label keeps arriving', async () => {
		const { finder, calls, opened } = scanSetup(async () => sample);
		finder.query.value = 'D1 SAMPLE\rS-0123 - 1a2b3c4d\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS - 50);
		finder.query.value += '2026-10-01 - DP\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS - 50);
		expect(calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(50);
		expect(opened).toHaveLength(1);
	});

	it('reads a pasted label at once', async () => {
		const { finder, opened } = scanSetup(async () => sample);
		finder.query.value = typed;
		finder.readScanNow();
		await vi.advanceTimersByTimeAsync(0);
		expect(opened).toHaveLength(1);
	});

	it('shows the decoded label and the reason when the sample is not found, and opens nothing', async () => {
		const { finder, opened } = scanSetup(async () => ({ data: { data: [] } }));
		finder.query.value = typed;
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(opened).toEqual([]);
		expect(finder.scan.value).toMatchObject({ status: 'done', outcome: { kind: 'failed', reason: 'not_found', code: 'S-0123', lines: ['Ti-6Al-4V'] } });
	});

	it('drops a lookup that was typed over, and leaves the scan when the text stops being one', async () => {
		let release: (() => void) | undefined;
		const { finder, opened } = scanSetup(() => new Promise((res) => { release = () => res(sample); }));
		finder.query.value = typed;
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(finder.scan.value).toEqual({ status: 'resolving' });
		finder.query.value = 'S-01';
		release?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(opened).toEqual([]);
		expect(finder.scan.value).toBeNull();
	});
});

describe('useFinder after a failed scan', () => {
	it('says when a scan settled without opening, so the box can select its text', async () => {
		const host = { api: { get: async () => ({ data: { data: [] } }) } } as unknown as ExplorerHost;
		let settled = 0;
		const finder = useFinder(host, ref(buildNav(visible, [], false)), ref<Set<string> | null>(visible), { onSettled: () => settled++ });
		finder.query.value = 'D1 SAMPLE\rS-0123 - 1a2b3c4d\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(settled).toBe(1);
		// the next scan lands after the old text (or replaces it): the last label is the one read
		finder.query.value += 'D1 SAMPLE\rT-9 - 99999999\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(settled).toBe(2);
		expect(finder.scan.value).toMatchObject({ status: 'done', outcome: { kind: 'failed', code: 'T-9' } });
	});
});

describe('useFinder waits for a finished label', () => {
	it('does not read a bare header or an unfinished code line on a pause; Enter finishes it', async () => {
		const calls: string[] = [];
		const host = { api: { get: async (p: string) => { calls.push(p); return { data: { data: [{ sample_id: 'u1', sample_code: 'S-1', short_id: '1a2b3c4d' }] } }; } } } as unknown as ExplorerHost;
		const opened: string[] = [];
		const finder = useFinder(host, ref(buildNav(visible, [], false)), ref<Set<string> | null>(visible), { onOpen: (to) => opened.push(to) });
		finder.query.value = 'D1 SAMPLE';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS * 4);
		finder.query.value = 'D1 SAMPLE\rS-1 | 1a2b3c4d';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS * 4);
		expect(calls).toEqual([]);
		expect(finder.scan.value).toEqual({ status: 'reading' });
		// the user presses Enter: the box adds the line break
		finder.query.value += '\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(opened).toEqual(['/home/samples/u1']);
	});
});

describe('useFinder with a label scanned into a non-empty box', () => {
	function open() {
		const host = { api: { get: async () => ({ data: { data: [{ sample_id: 'u1', sample_code: 'S-1', short_id: '1a2b3c4d' }] } }) } } as unknown as ExplorerHost;
		const opened: string[] = [];
		const finder = useFinder(host, ref(buildNav(visible, [], false)), ref<Set<string> | null>(visible), { onOpen: (to) => opened.push(to) });
		return { finder, opened };
	}
	it('drops an earlier non-D1 search and reads the label', async () => {
		const { finder, opened } = open();
		finder.query.value = 'tita';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		finder.query.value += 'D1 SAMPLE\rS-1 | 1a2b3c4d\r';
		expect(finder.query.value).toBe('D1 SAMPLE\rS-1 | 1a2b3c4d\r');
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(opened).toEqual(['/home/samples/u1']);
	});
	it('reads a label glued onto the trimmed end of an earlier label', async () => {
		const { finder, opened } = open();
		finder.query.value = 'D1 SAMPLE\rOLD-1 | 11111111\rTi-6Al-4V';
		finder.query.value += 'D1 SAMPLE\rS-1 | 1a2b3c4d\r';
		expect(finder.query.value).toBe('D1 SAMPLE\rS-1 | 1a2b3c4d\r');
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(opened).toEqual(['/home/samples/u1']);
	});
	it('leaves a query that merely contains no header alone', async () => {
		const { finder } = open();
		finder.query.value = 'S-0123';
		expect(finder.query.value).toBe('S-0123');
	});
});

describe('useFinder retry', () => {
	it('reads a settled scan again on request, and opens it once the lookup works', async () => {
		let up = false;
		const host = { api: { get: async () => { if (!up) throw new Error('Network Error'); return { data: { data: [{ sample_id: 'u1', sample_code: 'S-1', short_id: '1a2b3c4d' }] } }; } } } as unknown as ExplorerHost;
		const opened: string[] = [];
		const finder = useFinder(host, ref(buildNav(visible, [], false)), ref<Set<string> | null>(visible), { onOpen: (to) => opened.push(to) });
		finder.query.value = 'D1 SAMPLE\rS-1 | 1a2b3c4d\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(finder.scan.value).toMatchObject({ status: 'done', outcome: { kind: 'failed', reason: 'network' } });
		up = true;
		finder.readScanNow();
		await vi.advanceTimersByTimeAsync(0);
		expect(opened).toEqual(['/home/samples/u1']);
	});
});

describe('useFinder hands a scanned sample to onOpen as a record too', () => {
	it('onOpen gets the route and the record, which the Finder routes through openHit', async () => {
		const host = { api: { get: async () => ({ data: { data: [{ sample_id: 'u1', sample_code: 'S-1', short_id: '1a2b3c4d' }] } }) } } as unknown as ExplorerHost;
		const calls: unknown[][] = [];
		const finder = useFinder(host, ref(buildNav(visible, [], false)), ref<Set<string> | null>(visible), {
			onOpen: (to, record) => {
				// what Finder.vue does with it
				openHit({ to, record }, (t) => calls.push(['navigate', t]), pick);
			},
		});
		let pick: ((r: { collection: string; id: string }) => void) | undefined;
		finder.query.value = 'D1 SAMPLE\rS-1 | 1a2b3c4d\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(calls).toEqual([['navigate', '/home/samples/u1']]); // no pickRecord: navigates as before

		calls.length = 0;
		pick = (r) => calls.push(['pick', r]);
		finder.query.value = '';
		finder.query.value = 'D1 SAMPLE\rS-1 | 1a2b3c4d\r';
		await vi.advanceTimersByTimeAsync(SCAN_IDLE_MS);
		expect(calls).toEqual([['pick', { collection: 'physical_samples', id: 'u1' }]]);
	});
});

describe('useFinder streams its answers', () => {
	const all = new Set(['physical_samples', 'manufacturing_operations', 'campaigns', 'directus_files']);
	// A host whose every request waits for the test to answer it.
	function held() {
		const pending: Array<{ path: string; params: any; answer: (rows: any[]) => void; fail: () => void }> = [];
		const host = {
			api: {
				get: (path: string, cfg?: any) => new Promise((resolve, reject) => {
					pending.push({ path, params: cfg?.params, answer: (rows) => resolve({ data: { data: rows } }), fail: () => reject(new Error('boom')) });
				}),
			},
		} as unknown as ExplorerHost;
		const finder = useFinder(host, ref(buildNav(all, [], false)), ref<Set<string> | null>(all));
		const take = (path: string, pass: 1 | 2 = 1) => pending.filter((p) => p.path === path)[pass - 1];
		return { finder, pending, take };
	}

	it('shows the first group to answer at once, adds the others as they come, and loads until all have settled', async () => {
		const { finder, pending, take } = held();
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		// samples (2), operations (2), campaigns, files: every request is out at once
		expect(pending.map((p) => p.path).sort()).toEqual(['/files', '/items/campaigns', '/items/manufacturing_operations', '/items/manufacturing_operations', '/items/physical_samples', '/items/physical_samples']);
		take('/items/campaigns').answer([{ campaign_id: 'c1', campaign_code: 'CAMP-12', name: 'Twelve' }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value.map((h) => h.group)).toEqual(['Campaigns']);
		expect(finder.loading.value).toBe(true);
		take('/items/physical_samples').answer([{ sample_id: 's1', sample_code: '12-ABC' }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value.map((h) => h.group)).toEqual(['Samples', 'Campaigns']);
		expect(finder.loading.value).toBe(true);
		for (const p of pending) if (p.path !== '/items/campaigns' && p.path !== '/items/physical_samples') p.answer([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.loading.value).toBe(true); // samples' pass 2 is still out
		take('/items/physical_samples', 2).answer([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.loading.value).toBe(false);
	});

	it('drops an answer to a query typed over, whichever pass and group it was', async () => {
		const { finder, pending } = held();
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		const old = [...pending];
		finder.query.value = '123';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		old.find((p) => p.path === '/items/campaigns')!.answer([{ campaign_id: 'c1', campaign_code: 'CAMP-12', name: 'Twelve' }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value.some((h) => h.group === 'Campaigns')).toBe(false);
		expect(finder.loading.value).toBe(true);
		// the old query's answers do not end the new query's loading either
		for (const p of old) p.answer([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.loading.value).toBe(true);
		for (const p of pending.slice(old.length)) p.answer([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.loading.value).toBe(false);
	});

	it('shows a pass 2 row as matched in a field, below the pass 1 rows, and not twice', async () => {
		const { finder, pending } = held();
		finder.query.value = 'anneal';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		const [pass1, pass2] = pending.filter((p) => p.path === '/items/physical_samples');
		// pass 2 comes first, and carries the pass 1 row too (its code matches) besides a notes row
		pass2.answer([
			{ sample_id: 's2', sample_code: 'S-2', notes: 'Annealed in air' },
			{ sample_id: 's1', sample_code: 'ANNEAL-1', notes: 'anneal' },
		]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value.map((h) => [h.label, h.rank, h.matchedIn])).toEqual([['S-2', 4, 'notes']]);
		pass1.answer([{ sample_id: 's1', sample_code: 'ANNEAL-1' }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value.map((h) => [h.label, h.rank, h.matchedIn])).toEqual([['ANNEAL-1', 2, undefined], ['S-2', 4, 'notes']]);
	});

	it('asks for files from /files', async () => {
		const { finder, take } = held();
		finder.query.value = 'scan';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		const files = take('/files');
		expect(JSON.parse(files.params.filter)).toEqual({ _or: [{ filename_download: { _icontains: 'scan' } }, { title: { _icontains: 'scan' } }] });
		files.answer([{ id: 'f1', filename_download: 'scan.tif', type: 'image/tiff' }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value).toEqual([expect.objectContaining({ group: 'Files', label: 'scan.tif', to: '/files/f1', rank: 2 })]);
	});

	it('loses only the pass 2 answer when its request fails (a relation the user may not read)', async () => {
		const { finder, pending, take } = held();
		finder.query.value = '12';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		take('/items/physical_samples', 2).fail();
		take('/items/physical_samples').answer([{ sample_id: 's1', sample_code: '12-ABC' }]);
		for (const p of pending) if (p.path !== '/items/physical_samples') p.answer([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(finder.hits.value.map((h) => h.label)).toEqual(['12-ABC']);
		expect(finder.loading.value).toBe(false);
	});

	it('ends loading with no hits when there is nothing to ask', async () => {
		const host = { api: { get: async () => ({ data: { data: [] } }) } } as unknown as ExplorerHost;
		const none = new Set<string>();
		const finder = useFinder(host, ref(buildNav(none, [], false)), ref<Set<string> | null>(none));
		finder.query.value = 'qqq';
		await vi.advanceTimersByTimeAsync(FINDER_DEBOUNCE_MS);
		expect(finder.loading.value).toBe(false);
		expect(finder.hits.value).toEqual([]);
	});
});
