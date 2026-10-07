import { describe, expect, it } from 'vitest';
import { buildPath, alignRhoToBuckets, alignMeasuredRho, measuredRhoSpan, type TurningSpiralParams } from './path';
import type { Cache } from './liveCache';

function makeCache(overrides: Partial<Cache> = {}): Cache {
	const N = overrides.N ?? 50;
	const t = overrides.t ?? Float32Array.from({ length: N }, (_, i) => i * 0.01);
	const revs = overrides.revs ?? Float32Array.from({ length: N }, (_, i) => i * 0.02);
	return {
		N, Fs: 1000, feed: 0.05, diam: 80, csSec: 0, ceSec: (N - 1) * 0.01,
		t, revs,
		Fx: overrides.Fx ?? Float32Array.from({ length: N }, () => 1),
		Fy: overrides.Fy ?? Float32Array.from({ length: N }, () => 1),
		Fz: overrides.Fz ?? Float32Array.from({ length: N }, () => 1),
		rpm: overrides.rpm ?? Float32Array.from({ length: N }, () => 1200),
		...overrides,
	};
}
const WINDOW = { cropStartSec: 0, cropEndSec: 1e9, stride: 1 };

describe('buildPath / turning_spiral', () => {
	it('spirals inward and stops at innerDiam', () => {
		// revs climbs to ~1 revolution over the 50-sample window (i*0.02), so feed must be large
		// enough that even under 1 full revolution the radius crosses innerDiam before the window ends.
		const c = makeCache();
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 40, diam: 80, innerDiam: 20,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
		}, WINDOW);
		expect(r).not.toBeNull();
		expect(r!.count).toBeGreaterThan(0);
		expect(r!.count).toBeLessThan(c.N);
		expect(r!.pos.length).toBe(r!.count * 3);
		for (let k = 0; k < r!.count; k++) expect(r!.pos[k * 3 + 2]).toBe(0);
	});

	it('idx maps each emitted point back to its source sample', () => {
		const c = makeCache({ N: 20 });
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
		}, { cropStartSec: 0, cropEndSec: 1e9, stride: 3 });
		expect(r).not.toBeNull();
		expect(r!.idx.length).toBe(r!.count);
		for (let k = 1; k < r!.count; k++) expect(r!.idx[k]).toBe(r!.idx[k - 1] + 3);
	});

	it('rpm speed model advances angle linearly in time (feed=0 => constant radius)', () => {
		const c = makeCache({ N: 100 });
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 0, diam: 80, innerDiam: 0,
			speedMode: 'rpm', rpm: 600, vc: 0, timeScale: 1, ppr: 1,
		}, WINDOW);
		expect(r).not.toBeNull();
		for (let k = 0; k < r!.count; k++) {
			const x = r!.pos[k * 3], y = r!.pos[k * 3 + 1];
			expect(Math.hypot(x, y)).toBeCloseTo(40, 4);
		}
	});

	it('vc speed model shrinks radius per the K coefficient', () => {
		const c = makeCache({ N: 100 });
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 0.1, diam: 80, innerDiam: 0,
			speedMode: 'vc', rpm: 0, vc: 120, timeScale: 1, ppr: 1,
		}, WINDOW);
		expect(r).not.toBeNull();
		const rad0 = Math.hypot(r!.pos[0], r!.pos[1]);
		const radLast = Math.hypot(r!.pos[(r!.count - 1) * 3], r!.pos[(r!.count - 1) * 3 + 1]);
		expect(radLast).toBeLessThan(rad0);
	});

	it('exposes rho matching hypot(x,y) at every emitted point', () => {
		const c = makeCache();
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 40, diam: 80, innerDiam: 20,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
		}, WINDOW);
		expect(r).not.toBeNull();
		expect(r!.rho).toBeDefined();
		expect(r!.rho!.length).toBe(r!.count);
		for (let k = 0; k < r!.count; k++) {
			expect(r!.rho![k]).toBeCloseTo(Math.hypot(r!.pos[k * 3], r!.pos[k * 3 + 1]), 4);
		}
		expect(r!.rho![0]).toBeCloseTo(40, 4); // diam/2 at the crop start (r=0)
	});
});

describe('buildPath / linear_feed', () => {
	it('leaves rho undefined (no geometric radius concept for a straight pass)', () => {
		const c = makeCache({ N: 20 });
		const r = buildPath(c, {
			kind: 'linear_feed', feedRate: 100, timeScale: 1, yOffset: 0, zOffset: 0,
		}, WINDOW);
		expect(r).not.toBeNull();
		expect(r!.rho).toBeUndefined();
	});

	it('advances x at feedRate mm/min, holds y and z constant', () => {
		const c = makeCache({ N: 601, t: Float32Array.from({ length: 601 }, (_, i) => i * 0.01) }); // 6s window
		const r = buildPath(c, {
			kind: 'linear_feed', feedRate: 100, timeScale: 1, yOffset: 5, zOffset: -2,
		}, WINDOW);
		expect(r).not.toBeNull();
		expect(r!.pos[0]).toBeCloseTo(0, 5);
		const lastX = r!.pos[(r!.count - 1) * 3];
		expect(lastX).toBeCloseTo(10, 1); // 100 mm/min * 6s/60 = 10mm
		for (let k = 0; k < r!.count; k++) {
			expect(r!.pos[k * 3 + 1]).toBeCloseTo(5, 6);
			expect(r!.pos[k * 3 + 2]).toBeCloseTo(-2, 6);
		}
	});
});

describe('buildPath / machine_xyz', () => {
	it('zeroes the start under first_sample origin', () => {
		const N = 10;
		const c = makeCache({
			N,
			X: Float32Array.from({ length: N }, (_, i) => 10 + i),
			Y: Float32Array.from({ length: N }, (_, i) => 5 - i * 0.5),
			Z: Float32Array.from({ length: N }, () => 1),
		} as Partial<Cache>);
		const r = buildPath(c, {
			kind: 'machine_xyz', xKey: 'X', yKey: 'Y', zKey: 'Z', scale: 1, origin: 'first_sample',
		}, WINDOW);
		expect(r).not.toBeNull();
		expect(r!.pos[0]).toBeCloseTo(0, 6);
		expect(r!.pos[1]).toBeCloseTo(0, 6);
		expect(r!.pos[2]).toBeCloseTo(0, 6);
	});

	it('keeps absolute coordinates under origin=absolute', () => {
		const N = 5;
		const c = makeCache({ N, X: Float32Array.from({ length: N }, () => 42) } as Partial<Cache>);
		const r = buildPath(c, {
			kind: 'machine_xyz', xKey: 'X', yKey: 'X', zKey: 'X', scale: 1, origin: 'absolute',
		}, WINDOW);
		expect(r).not.toBeNull();
		expect(r!.pos[0]).toBeCloseTo(42, 6);
	});

	it('returns null when a named array is missing', () => {
		const c = makeCache({ N: 5 });
		const r = buildPath(c, {
			kind: 'machine_xyz', xKey: 'X', yKey: 'Y', zKey: 'Z', scale: 1, origin: 'absolute',
		}, WINDOW);
		expect(r).toBeNull();
	});

	it('returns null when a named array has the wrong length', () => {
		const c = makeCache({ N: 5, X: Float32Array.from({ length: 3 }, () => 1) } as Partial<Cache>);
		const r = buildPath(c, {
			kind: 'machine_xyz', xKey: 'X', yKey: 'X', zKey: 'X', scale: 1, origin: 'absolute',
		}, WINDOW);
		expect(r).toBeNull();
	});
});

describe('buildPath / degenerate input', () => {
	it('returns null for an empty cache', () => {
		const c = makeCache({ N: 0, t: new Float32Array(0), revs: new Float32Array(0) });
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
		}, WINDOW);
		expect(r).toBeNull();
	});

	it('returns null when the crop selects nothing', () => {
		// cropStartSec beyond the data clamps idxOfTime to the last sample (same convention as
		// today's liveCloud.ts); cropEndSec before that clamped sample's time then breaks the
		// loop on its very first iteration, emitting zero points.
		const c = makeCache({ N: 20 });
		const r = buildPath(c, {
			kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
		}, { cropStartSec: 1000, cropEndSec: 0, stride: 1 });
		expect(r).toBeNull();
	});
});

describe('alignRhoToBuckets', () => {
	// N=100, t=i*0.01 (0..0.99s), revs=i*0.02. Crop starts at i=10 (t=0.10s, revs=0.2). With
	// feed=40/diam=80/innerDiam=20 (innerR = innerDiam/2 = 10): rho=40-40*r,
	// r=(revs[i]-0.2)/1 => rho<10 first at i=48 (revs=0.96 => r=0.76 => rho=9.6), so the path
	// covers i=10..47 (rho[47]=10.4).
	const c = makeCache({ N: 100 });
	const r = buildPath(c, {
		kind: 'turning_spiral', feed: 40, diam: 80, innerDiam: 20,
		speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
	}, { cropStartSec: 0.1, cropEndSec: 1e9, stride: 1 });

	it('returns the path rho at an in-range bucket time', () => {
		expect(r).not.toBeNull();
		// i=20: revs=0.4, r=0.2, rho=40-40*0.2=32
		const out = alignRhoToBuckets(r!, c, [0.20]);
		expect(out[0]).toBeCloseTo(32, 4);
	});

	it('returns NaN for a bucket time before the crop start', () => {
		const out = alignRhoToBuckets(r!, c, [0.05]);
		expect(Number.isNaN(out[0])).toBe(true);
	});

	it('returns NaN for a bucket time past where the spiral stopped (cut-out)', () => {
		// t[60]=0.60 is past i=47, the last index the spiral actually reached before innerDiam.
		const out = alignRhoToBuckets(r!, c, [0.60]);
		expect(Number.isNaN(out[0])).toBe(true);
	});

	it('returns an all-NaN array of the right length when rho is absent (e.g. no path)', () => {
		const empty = buildPath(c, {
			kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
		}, { cropStartSec: 1000, cropEndSec: 0, stride: 1 });
		expect(empty).toBeNull();
		const out = alignRhoToBuckets({ pos: new Float32Array(0), idx: new Int32Array(0), count: 0, bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 } }, c, [0.1, 0.2]);
		expect(out.length).toBe(2);
		expect(Number.isNaN(out[0])).toBe(true);
		expect(Number.isNaN(out[1])).toBe(true);
	});
});

describe('measuredRhoSpan / alignMeasuredRho (no path build)', () => {
	const P = (over: Partial<TurningSpiralParams> = {}): TurningSpiralParams => ({
		kind: 'turning_spiral', feed: 40, diam: 80, innerDiam: 20,
		speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1, ...over,
	});
	const via = (c: Cache, p: TurningSpiralParams, start: number, ts: number[]) => {
		const path = buildPath(c, p, { cropStartSec: start, cropEndSec: c.t[c.N - 1], stride: 1 });
		return path ? alignRhoToBuckets(path, c, ts) : new Float32Array(ts.length).fill(NaN);
	};

	// The reference is buildPath + alignRhoToBuckets, which is what the dashboard used to run on
	// every crop drag. Same numbers, none of the pos/idx/rho allocations.
	it('matches buildPath + alignRhoToBuckets for several crop starts, including the cut-out', () => {
		const c = makeCache({ N: 100 });
		const ts = Array.from({ length: 120 }, (_, i) => i * 0.0085 - 0.05);   // before, inside and past the data
		for (const start of [0, 0.03, 0.1, 0.5, 0.9]) {
			const got = alignMeasuredRho(measuredRhoSpan(c, P(), start), c, ts);
			const want = via(c, P(), start, ts);
			expect(got.length).toBe(want.length);
			for (let i = 0; i < ts.length; i++) {
				if (Number.isNaN(want[i])) expect(Number.isNaN(got[i])).toBe(true);
				else expect(got[i]).toBeCloseTo(want[i], 5);
			}
		}
	});
	it('stops where the spiral reaches the inner diameter (same bound as the path)', () => {
		const c = makeCache({ N: 100 });
		const span = measuredRhoSpan(c, P(), 0.1)!;
		expect(span.cs).toBe(10);
		expect(span.end).toBe(48);   // see alignRhoToBuckets' fixture: i = 10..47
	});
	it('is null when buildPath would be (already inside the inner radius at the crop start)', () => {
		const c = makeCache({ N: 100 });
		expect(measuredRhoSpan(c, P({ innerDiam: 200 }), 0.1)).toBeNull();
		const out = alignMeasuredRho(null, c, [0.1, 0.2]);
		expect(Array.from(out).every(Number.isNaN)).toBe(true);
	});
	it('a crop drag changes rho (it is measured from the crop start), so the span is rebuilt per start', () => {
		const c = makeCache({ N: 100 });
		const a = alignMeasuredRho(measuredRhoSpan(c, P(), 0.1), c, [0.2])[0];
		const b = alignMeasuredRho(measuredRhoSpan(c, P(), 0.15), c, [0.2])[0];
		expect(a).toBeCloseTo(32, 4);
		expect(b).not.toBeCloseTo(a, 3);
	});
});
