import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ExplorerHost } from '../host';
import { buildNav } from '../nav/navConfig';
import { FINDER_DEBOUNCE_MS, SCAN_IDLE_MS, useFinder } from './useFinder';

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
		expect(calls.sort()).toEqual(['/items/campaigns', '/items/manufacturing_operations', '/items/physical_samples']);
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
		expect(calls.map((c) => c.path).sort()).toEqual(['/items/campaigns', '/items/manufacturing_operations', '/items/physical_samples']);
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
