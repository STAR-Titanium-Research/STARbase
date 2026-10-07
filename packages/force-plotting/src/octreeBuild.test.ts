import { describe, expect, it } from 'vitest';
import { noGeometryReason, buildWindowF32, cacheCoversBuild, mappableWindow, parseOctreeBuild } from './octreeBuild';
import type { Cache } from './liveCache';

const good = {
	schema: 1, kind: 'octree', speed_mode: 'measured', feed: 0.05, diam: 80, inner_diam: 10, ppr: 2,
	cut_start_sec: 0.264, cut_end_sec: 3.867, crop_source: 'override', n_points: 18015, built_at: '2026-10-06T12:00:00Z',
};

function cacheOf(t0: number, t1: number, n = 101): Cache {
	const t = Float32Array.from({ length: n }, (_, i) => t0 + (t1 - t0) * i / (n - 1));
	const z = new Float32Array(n);
	return { N: n, Fs: 1000, feed: 0.05, diam: 80, csSec: t0, ceSec: t1, t, Fx: z, Fy: z, Fz: z, rpm: z, revs: z };
}

describe('parseOctreeBuild', () => {
	it('reads a well-formed manifest', () => {
		expect(parseOctreeBuild(good)).toEqual({
			feed: 0.05, diam: 80, innerDiam: 10, ppr: 2, cutStartSec: 0.264, cutEndSec: 3.867,
		});
	});
	it('reads revs_cs when present and finite, and treats a malformed one as absent', () => {
		expect(parseOctreeBuild({ ...good, revs_cs: 12.5 })!.revsCs).toBe(12.5);
		expect(parseOctreeBuild({ ...good, revs_cs: 0 })!.revsCs).toBe(0);
		expect('revsCs' in parseOctreeBuild(good)!).toBe(false);
		for (const bad of ['1', NaN, Infinity, null]) expect(parseOctreeBuild({ ...good, revs_cs: bad })!.revsCs).toBeUndefined();
	});
	it('accepts a zero-length window and a zero inner diameter', () => {
		expect(parseOctreeBuild({ ...good, inner_diam: 0, cut_end_sec: 0.264 })).not.toBeNull();
	});
	it('ignores anything that is not a well-formed schema 1 manifest', () => {
		expect(parseOctreeBuild(null)).toBeNull();
		expect(parseOctreeBuild('x')).toBeNull();
		expect(parseOctreeBuild({ ...good, schema: 2 })).toBeNull();
		expect(parseOctreeBuild({ ...good, schema: undefined })).toBeNull();
		for (const k of ['feed', 'diam', 'inner_diam', 'ppr', 'cut_start_sec', 'cut_end_sec']) {
			expect(parseOctreeBuild({ ...good, [k]: undefined })).toBeNull();
			expect(parseOctreeBuild({ ...good, [k]: '1' })).toBeNull();
			expect(parseOctreeBuild({ ...good, [k]: NaN })).toBeNull();
			expect(parseOctreeBuild({ ...good, [k]: Infinity })).toBeNull();
		}
		expect(parseOctreeBuild({ ...good, ppr: 0 })).toBeNull();
		expect(parseOctreeBuild({ ...good, ppr: -1 })).toBeNull();
		expect(parseOctreeBuild({ ...good, cut_end_sec: 0.1 })).toBeNull();
	});
});

describe('cacheCoversBuild / mappableWindow', () => {
	const build = parseOctreeBuild(good)!;
	it('treats a missing build as covered, with the cache range as the window', () => {
		const c = cacheOf(0.264, 3.867);
		expect(cacheCoversBuild(c, null)).toBe(true);
		expect(mappableWindow(c)).toEqual({ start: c.t[0], end: c.t[c.N - 1] });
		expect(mappableWindow({ ...c, N: 0 })).toBeNull();
	});
	it('covers a build that starts at or after the first cache sample (within half a sample)', () => {
		expect(cacheCoversBuild(cacheOf(0.264, 3.867), build)).toBe(true);
		expect(cacheCoversBuild(cacheOf(0.1, 4), build)).toBe(true);
		expect(cacheCoversBuild(cacheOf(0.2644, 3.867, 3601), build)).toBe(true);   // t[0] a hair late: inside half a sample (0.5 ms)
		expect(cacheCoversBuild(cacheOf(0.266, 3.867, 3601), build)).toBe(false);
	});
	it('does not cover a build that starts before the cache', () => {
		const c = cacheOf(1, 4);
		expect(cacheCoversBuild(c, build)).toBe(false);
		expect(mappableWindow(c, build)).toBeNull();
	});
	it('clips the window to the cache and the build', () => {
		expect(mappableWindow(cacheOf(0.1, 4), build)).toEqual({ start: Math.fround(0.264), end: Math.fround(3.867) });
		const c = cacheOf(0.264, 3, 101);
		const w = mappableWindow(c, build)!;
		expect(w.start).toBeCloseTo(0.264, 6);   // the build's start, or t[0] a float32 rounding away
		expect(w.end).toBe(c.t[c.N - 1]);
		expect(mappableWindow(cacheOf(5, 6), build)).toBeNull();
	});
});

describe('float32 window and revs_cs', () => {
	const legacy = parseOctreeBuild(good)!;
	const exact = parseOctreeBuild({ ...good, revs_cs: 3.25 })!;
	it('rounds the build window the way the cache stores t', () => {
		expect(buildWindowF32(legacy)).toEqual({ start: Math.fround(0.264), end: Math.fround(3.867) });
	});
	it('includes a float32 t[0] that rounded below the double start', () => {
		let k = 6758; while (!(Math.fround(k / 25600) < k / 25600)) k++;
		const t0 = k / 25600;                          // not a float32 value
		expect(Math.fround(t0)).toBeLessThan(t0);      // the case the double comparison got wrong
		const c = cacheOf(Math.fround(t0), 3.867, 101);
		const b = { ...legacy, cutStartSec: t0 };
		expect(cacheCoversBuild(c, b)).toBe(true);
		expect(mappableWindow(c, b)!.start).toBe(c.t[0]);
	});
	it('with revs_cs a crop starting before the cache maps the overlap', () => {
		const c = cacheOf(1, 4);
		expect(cacheCoversBuild(c, exact)).toBe(true);
		expect(mappableWindow(c, exact)).toEqual({ start: c.t[0], end: Math.fround(3.867) });
		expect(mappableWindow(c, legacy)).toBeNull();           // no revs_cs: the anchor needs a sample
		expect(mappableWindow(cacheOf(5, 6), exact)).toBeNull();   // no overlap at all
	});
});

describe('noGeometryReason', () => {
	it('is loading only while the manifest is pending and a cache is there', () => {
		expect(noGeometryReason(true, false)).toBe('loading');
		expect(noGeometryReason(false, false)).toBe('no-cache');
		expect(noGeometryReason(false, true)).toBe('no-cache');
	});
});
