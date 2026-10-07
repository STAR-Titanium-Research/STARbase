import { describe, expect, it } from 'vitest';
import type { Cache } from './liveCache';
import { computeSignalStats, resolveStatsWindow } from './signalStats';

const cache = { csSec: 2, ceSec: 9 };

describe('resolveStatsWindow', () => {
	// The old `cropStartSec || c.csSec` read a crop that really starts at 0 s as "unset" and analysed
	// from the cache's own start (2 s) instead.
	it('honours a crop start of 0', () => {
		expect(resolveStatsWindow(0, 5, cache)).toEqual([0, 5]);
	});
	it('uses the cache crop when the dashboard has none (the 0/0 default, or nulls)', () => {
		expect(resolveStatsWindow(0, 0, cache)).toEqual([2, 9]);
		expect(resolveStatsWindow(null, null, cache)).toEqual([2, 9]);
		expect(resolveStatsWindow(undefined, undefined, cache)).toEqual([2, 9]);
	});
	it('a set crop passes through unchanged', () => {
		expect(resolveStatsWindow(1.5, 4, cache)).toEqual([1.5, 4]);
	});
	it('a missing start falls back to the cache start when the end is set', () => {
		expect(resolveStatsWindow(null, 4, cache)).toEqual([2, 4]);
	});
});

describe('computeSignalStats resultant', () => {
	it('reports the per-sample resultant mean and peak over the window', () => {
		const N = 200;
		const f = (v: number) => new Float32Array(N).fill(v);
		const c = {
			N, Fs: 100, feed: 0.1, diam: 100, csSec: 0, ceSec: 1.99,
			t: Float32Array.from({ length: N }, (_, i) => i / 100),
			Fx: f(3), Fy: f(4), Fz: f(12), rpm: f(500), revs: f(0), version: 1,
		} as unknown as Cache;
		const s = computeSignalStats(c, 0.5, 1.5);
		expect(s.resultant.mean).toBeCloseTo(13, 5);   // sqrt(9 + 16 + 144)
		expect(s.resultant.peak).toBeCloseTo(13, 5);
		expect(s.cacheCropStartSec).toBe(0);
	});
});
