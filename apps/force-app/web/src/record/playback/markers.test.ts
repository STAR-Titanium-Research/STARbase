import { describe, expect, it } from 'vitest';
import type { Cache } from '@d1/force-plotting';
import { computeMarkers, markerFraction } from './markers';

function cache(t0 = 0, n = 1000, fs = 100): Cache {
	const t = new Float32Array(n), Fx = new Float32Array(n), Fy = new Float32Array(n);
	const Fz = new Float32Array(n), rpm = new Float32Array(n), revs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		t[i] = t0 + i / fs;
		Fx[i] = Math.sin(i / 20) * 10; Fy[i] = 5; Fz[i] = 1;
	}
	Fx[300] = 400;     // Fx peak at t0 + 3 s
	Fy[700] = -900;    // Fy peak is NEGATIVE: |F| decides, not the signed max
	Fz[100] = 50;
	return { N: n, Fs: fs, feed: 0.1, diam: 80, csSec: t0 + 2, ceSec: t0 + 8, t, Fx, Fy, Fz, rpm, revs };
}

describe('computeMarkers (#104)', () => {
	it('marks cut start/end and each axis |F| peak, sorted by time', () => {
		const m = computeMarkers(cache());
		expect(m.map((x) => [x.kind, x.axis ?? null, Number(x.t.toFixed(2))])).toEqual([
			['peak', 'Fz', 1],
			['cut-start', null, 2],
			['peak', 'Fx', 3],
			['peak', 'Fy', 7],
			['cut-end', null, 8],
		]);
		expect(m.find((x) => x.axis === 'Fy')!.label).toContain('-900');
	});

	it('gives a peak a seek time one sample later, clamped at the last sample', () => {
		const c = cache();
		const fx = computeMarkers(c).find((x) => x.axis === 'Fx')!;
		expect(fx.seekT).toBeCloseTo(fx.t + 0.01, 4);
		c.Fz[c.N - 1] = 1e6;
		const fz = computeMarkers(c).find((x) => x.axis === 'Fz')!;
		expect(fz.seekT).toBe(fz.t);
		expect(computeMarkers(c).find((x) => x.kind === 'cut-start')!.seekT).toBeUndefined();
	});

	it('adds a saved crop start when it differs from the detected start', () => {
		const m = computeMarkers(cache(), { cropStartSec: 4.5 });
		expect(m.find((x) => x.kind === 'crop')?.t).toBeCloseTo(4.5, 5);
		expect(computeMarkers(cache(), { cropStartSec: 2 }).some((x) => x.kind === 'crop')).toBe(false);
	});

	it('works in the cache time base of a cut-window cache (#110)', () => {
		const m = computeMarkers(cache(15));
		expect(m.find((x) => x.kind === 'cut-start')!.t).toBeCloseTo(17, 4);
		expect(m.find((x) => x.axis === 'Fx')!.t).toBeCloseTo(18, 4);
	});

	it('drops markers outside the cache', () => {
		const c = { ...cache(), csSec: -5, ceSec: 99 };
		const m = computeMarkers(c, { cropStartSec: 1e6 });
		expect(m.every((x) => x.kind === 'peak')).toBe(true);
	});

	it('handles an empty cache', () => {
		expect(computeMarkers({ ...cache(), N: 0 })).toEqual([]);
	});
});

describe('markerFraction', () => {
	it('maps cache time onto the scrub bar', () => {
		expect(markerFraction(15, 15, 10)).toBe(0);
		expect(markerFraction(20, 15, 10)).toBe(0.5);
		expect(markerFraction(99, 15, 10)).toBe(1);
		expect(markerFraction(15, 15, 0)).toBe(0);
	});
});
