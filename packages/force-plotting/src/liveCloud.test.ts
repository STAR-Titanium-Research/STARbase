// Regression coverage for the FRM point-cloud math. Written after two real bugs:
//   1. The live FRM map briefly rendering solid WHITE right after a recording stopped, before the
//      finished trace fully replotted — root-caused to buildCloud() computing on a degenerate/empty
//      Cache (idxOfTime returning -1 on an empty `t` array), which propagated NaN through the
//      position/colour arrays; WebGL rendering NaN vertex colours is undefined behaviour that
//      commonly paints solid white. These tests pin the "must return null, never NaN" contract.
//   2. No control over how the live map decimates a long/dense cut (see LiveFrm.vue's pointStride
//      handling, not covered here since it's DOM/three.js-bound) — buildCloud's own `stride` param
//      (used by the FINISHED/FrmCloud path) is covered here for the same reason: it must never
//      produce fewer/more points than expected, or leave any NaN in the output.
import { describe, expect, it } from 'vitest';
import { axisAutoLimits, buildCloud, COLORMAPS, withHeight, type CloudParams } from './liveCloud';
import type { Cache } from './liveCache';

function makeCache(overrides: Partial<Cache> = {}): Cache {
	const N = overrides.N ?? 100;
	const t = overrides.t ?? Float32Array.from({ length: N }, (_, i) => i * 0.01);
	// revs climbs steadily so buildCloud's spiral math (measured mode) has real motion to compute.
	const revs = overrides.revs ?? Float32Array.from({ length: N }, (_, i) => i * 0.02);
	const Fz = overrides.Fz ?? Float32Array.from({ length: N }, (_, i) => Math.sin(i * 0.3) * 50);
	return {
		N, Fs: 1000, feed: 0.05, diam: 80, csSec: 0, ceSec: (N - 1) * 0.01,
		t, Fx: overrides.Fx ?? Float32Array.from({ length: N }, () => 1),
		Fy: overrides.Fy ?? Float32Array.from({ length: N }, () => 1),
		Fz, rpm: overrides.rpm ?? Float32Array.from({ length: N }, () => 1200),
		revs,
		...overrides,
	};
}

function baseParams(overrides: Partial<CloudParams> = {}): CloudParams {
	return {
		channel: 'Fz',
		path: {
			kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
			speedMode: 'measured', rpm: 1200, vc: 0, timeScale: 1, ppr: 1,
		},
		window: { cropStartSec: 0, cropEndSec: 1e9, stride: 1 },
		gridding: false, gridN: 400,
		colormap: COLORMAPS.viridis,
		cmin: null, cmax: null, zSeries: 'none',
		...overrides,
	};
}

function assertNoNaN(arr: Float32Array, label: string) {
	for (let i = 0; i < arr.length; i++) {
		expect(arr[i], `${label}[${i}] is NaN`).not.toBeNaN();
	}
}

describe('buildCloud - degenerate input safety (the white-screen bug)', () => {
	it('returns null for a completely empty cache (N=0, empty arrays)', () => {
		const c = makeCache({ N: 0, t: new Float32Array(0), revs: new Float32Array(0), Fz: new Float32Array(0) });
		expect(buildCloud(c, baseParams())).toBeNull();
	});

	it('returns null when t is empty but N is inconsistently non-zero', () => {
		// Exactly the shape a partially-loaded/parsed cache could have for one tick.
		const c = makeCache({ N: 50, t: new Float32Array(0) });
		expect(buildCloud(c, baseParams())).toBeNull();
	});

	it('never returns NaN in pos/col for a degenerate crop window (cropStart at/after cropEnd)', () => {
		const c = makeCache();
		const cloud = buildCloud(c, baseParams({ window: { cropStartSec: 0.5, cropEndSec: 0.5, stride: 1 } }));
		// Either null (no points in window) or, if a single boundary point sneaks in, must be finite.
		if (cloud) {
			assertNoNaN(cloud.pos, 'pos');
			assertNoNaN(cloud.col!, 'col');
		}
	});

	it('never returns NaN for a single-sample cache', () => {
		const c = makeCache({ N: 1, t: Float32Array.of(0), revs: Float32Array.of(0), Fz: Float32Array.of(10), Fx: Float32Array.of(1), Fy: Float32Array.of(1), rpm: Float32Array.of(1200) });
		const cloud = buildCloud(c, baseParams({ window: { cropStartSec: 0, cropEndSec: 1, stride: 1 } }));
		if (cloud) {
			assertNoNaN(cloud.pos, 'pos');
			assertNoNaN(cloud.col!, 'col');
			expect(cloud.cmax).toBeGreaterThan(cloud.cmin - 1e-9);
		}
	});
});

describe('buildCloud - normal operation', () => {
	it('produces one point per sample at stride=1 over the full window', () => {
		const c = makeCache({ N: 200 });
		const cloud = buildCloud(c, baseParams());
		expect(cloud).not.toBeNull();
		expect(cloud!.count).toBe(200);
		assertNoNaN(cloud!.pos, 'pos');
		assertNoNaN(cloud!.col!, 'col');
	});

	it('stride thins the point count roughly by the stride factor', () => {
		const c = makeCache({ N: 200 });
		const full = buildCloud(c, baseParams({ window: { cropStartSec: 0, cropEndSec: 1e9, stride: 1 } }))!;
		const thinned = buildCloud(c, baseParams({ window: { cropStartSec: 0, cropEndSec: 1e9, stride: 4 } }))!;
		expect(thinned.count).toBeLessThan(full.count);
		// ceil(200/4) = 50
		expect(thinned.count).toBe(50);
	});

	it('respects the crop window (points outside cropStart/cropEnd are excluded)', () => {
		const c = makeCache({ N: 1000 }); // t goes 0..9.99 at dt=0.01
		const cloud = buildCloud(c, baseParams({ window: { cropStartSec: 2, cropEndSec: 4, stride: 1 } }))!;
		expect(cloud).not.toBeNull();
		// ~200 samples in a 2s window at dt=0.01
		expect(cloud.count).toBeGreaterThan(150);
		expect(cloud.count).toBeLessThan(250);
	});

	it('gridding mode never exceeds gridN^2 cells and stays NaN-free', () => {
		const c = makeCache({ N: 2000 });
		const cloud = buildCloud(c, baseParams({ gridding: true, gridN: 16 }))!;
		expect(cloud).not.toBeNull();
		expect(cloud.count).toBeLessThanOrEqual(16 * 16);
		assertNoNaN(cloud.pos, 'pos');
		assertNoNaN(cloud.col!, 'col');
	});

	it('manual cmin/cmax override the auto percentile scale', () => {
		const c = makeCache({ N: 100 });
		const cloud = buildCloud(c, baseParams({ cmin: -5, cmax: 5 }))!;
		expect(cloud.cmin).toBe(-5);
		expect(cloud.cmax).toBe(5);
	});
});

describe('axisAutoLimits', () => {
	it('returns a safe default [0,1] for an empty axis array', () => {
		const c = makeCache({ N: 0, t: new Float32Array(0), Fz: new Float32Array(0), revs: new Float32Array(0) });
		expect(axisAutoLimits(c, 'Fz')).toEqual([0, 1]);
	});

	it('returns finite, ordered [lo, hi] for real data', () => {
		const c = makeCache({ N: 500 });
		const [lo, hi] = axisAutoLimits(c, 'Fz');
		expect(Number.isFinite(lo)).toBe(true);
		expect(Number.isFinite(hi)).toBe(true);
		expect(hi).toBeGreaterThan(lo);
	});

	it('never collapses to lo===hi even for a constant signal', () => {
		const c = makeCache({ N: 100, Fz: Float32Array.from({ length: 100 }, () => 42) });
		const [lo, hi] = axisAutoLimits(c, 'Fz');
		expect(hi).toBeGreaterThan(lo);
	});

	// NaN sorts to the END of a Float32Array, so the degenerate-range fallback could pick one up
	// and then propagate it through `hi = lo + 1`. These limits go straight into shader uniforms
	// and the colour-scale editor's axis, where one NaN bound blanks the render.
	it('never returns NaN for a channel carrying NaN samples', () => {
		const Fz = Float32Array.from({ length: 100 }, (_, i) => (i % 2 ? NaN : 7));
		const [lo, hi] = axisAutoLimits(makeCache({ N: 100, Fz }), 'Fz');
		expect(Number.isFinite(lo)).toBe(true);
		expect(Number.isFinite(hi)).toBe(true);
		expect(hi).toBeGreaterThan(lo);
	});

	it('never returns NaN for an all-NaN channel', () => {
		const Fz = Float32Array.from({ length: 50 }, () => NaN);
		const [lo, hi] = axisAutoLimits(makeCache({ N: 50, Fz }), 'Fz');
		expect(Number.isFinite(lo)).toBe(true);
		expect(Number.isFinite(hi)).toBe(true);
		expect(hi).toBeGreaterThan(lo);
	});
});

describe('COLORMAPS', () => {
	for (const name of Object.keys(COLORMAPS)) {
		it(`${name} stays within [0,1] and NaN-free across the domain (including out-of-range input)`, () => {
			const fn = COLORMAPS[name];
			for (const x of [0, 0.25, 0.5, 0.75, 1, -1, 2, NaN]) {
				const [r, g, b] = fn(x);
				for (const [ch, v] of [['r', r], ['g', g], ['b', b]] as const) {
					expect(v, `${name}(${x}).${ch} is NaN`).not.toBeNaN();
					expect(v, `${name}(${x}).${ch} out of [0,1]`).toBeGreaterThanOrEqual(0);
					expect(v).toBeLessThanOrEqual(1);
				}
			}
		});
	}
});

describe('withHeight (Lite 3D "Z = Fx/Fy/Fz")', () => {
	it.each([['ungridded', false], ['gridded', true]])('bakes zv into pos z (%s) so the view is not flat', (_n, gridding) => {
		const c = makeCache({ N: 400 });
		const cloud = withHeight(buildCloud(c, baseParams({ zSeries: 'Fz', gridding, gridN: 12 }))!);
		expect(cloud.zv).toBeDefined();
		let minZ = Infinity, maxZ = -Infinity;
		for (let k = 0; k < cloud.count; k++) {
			const z = cloud.pos[k * 3 + 2];
			expect(z).toBe(cloud.zv![k]);
			minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
		}
		expect(maxZ - minZ).toBeGreaterThan(0);   // not flat
	});
	it('leaves pos untouched without a Z series', () => {
		const cloud = withHeight(buildCloud(makeCache({ N: 100 }), baseParams())!);
		expect(cloud.zv).toBeUndefined();
		for (let k = 0; k < cloud.count; k++) expect(cloud.pos[k * 3 + 2]).toBe(0);
	});
});
