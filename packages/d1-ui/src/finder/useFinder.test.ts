import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ExplorerHost } from '../host';
import { buildNav } from '../nav/navConfig';
import { FINDER_DEBOUNCE_MS, useFinder } from './useFinder';

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
