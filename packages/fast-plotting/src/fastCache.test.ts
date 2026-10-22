import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTrace, resetTraceCache, type SeriesMeta } from './fastCache';

const CATALOG: SeriesMeta[] = [{ key: 'a', label: 'A', unit: '', group: 'x', min: null, max: null }];
const CSV = 'time_s,a\n0,1\n1,2\n';

beforeEach(() => resetTraceCache());

describe('loadTrace', () => {
	it('downloads once when several loads of one log are in flight at the same time', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const fetcher = vi.fn(async () => { await gate; return CSV; });
		const loads = [loadTrace('log-1', CATALOG, fetcher), loadTrace('log-1', CATALOG, fetcher), loadTrace('log-1', CATALOG, fetcher)];
		release();
		const traces = await Promise.all(loads);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(traces[1]).toBe(traces[0]);
		expect(traces[0].n).toBe(2);
	});

	it('serves a later load from the cache', async () => {
		const fetcher = vi.fn(async () => CSV);
		const first = await loadTrace('log-2', CATALOG, fetcher);
		expect(await loadTrace('log-2', CATALOG, fetcher)).toBe(first);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('keeps different logs apart', async () => {
		const fetcher = vi.fn(async () => CSV);
		await Promise.all([loadTrace('a', CATALOG, fetcher), loadTrace('b', CATALOG, fetcher)]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('forgets a failed download, so the next load tries again', async () => {
		const fetcher = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(CSV);
		const both = await Promise.allSettled([loadTrace('log-3', CATALOG, fetcher), loadTrace('log-3', CATALOG, fetcher)]);
		expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect((await loadTrace('log-3', CATALOG, fetcher)).n).toBe(2);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
