import { describe, expect, it } from 'vitest';
import { buildPolar, radialFrac, radialScale, type PolarParams } from './polar';
import type { AngleParams } from './angle';
import type { Cache } from './liveCache';

function makeCache(overrides: Partial<Cache> = {}): Cache {
	const N = overrides.N ?? 40;
	return {
		N, Fs: 1000, feed: 0.05, diam: 80, csSec: 0, ceSec: (N - 1) * 0.01,
		t: overrides.t ?? Float32Array.from({ length: N }, (_, i) => i * 0.01),
		revs: overrides.revs ?? Float32Array.from({ length: N }, (_, i) => i * 0.02),
		Fx: overrides.Fx ?? Float32Array.from({ length: N }, () => 3),
		Fy: overrides.Fy ?? Float32Array.from({ length: N }, () => 4),
		Fz: overrides.Fz ?? Float32Array.from({ length: N }, () => 1),
		rpm: overrides.rpm ?? Float32Array.from({ length: N }, () => 1200),
		...overrides,
	};
}
function angleParams(overrides: Partial<AngleParams> = {}): AngleParams {
	return { source: 'tacho', ppr: 1, offsetDeg: 0, direction: 1, engagementN: 5, ...overrides };
}
function polarParams(overrides: Partial<PolarParams> = {}): PolarParams {
	return {
		radius: 'Fxy', angle: angleParams(), window: { cropStartSec: 0, cropEndSec: 1e9, stride: 1 },
		bins: 0, ...overrides,
	};
}

describe('buildPolar', () => {
	it('Fxy radius equals hypot(Fx, Fy)', () => {
		const c = makeCache();
		const r = buildPolar(c, polarParams());
		expect(r).not.toBeNull();
		expect(r!.unit).toBe('N');
		for (const v of r!.r) expect(v).toBeCloseTo(5, 5); // hypot(3,4)=5
	});

	it('returns null when radius=Mz and the cache has no Mz channel', () => {
		const c = makeCache();
		const r = buildPolar(c, polarParams({ radius: 'Mz' }));
		expect(r).toBeNull();
	});

	it('counts dropped points for NaN angle (force_vector below engagement)', () => {
		const N = 6;
		const c = makeCache({ N, Fx: new Float32Array(N).fill(0.01), Fy: new Float32Array(N).fill(0.01) });
		const r = buildPolar(c, polarParams({ angle: angleParams({ source: 'force_vector', engagementN: 5 }) }));
		expect(r).not.toBeNull();
		expect(r!.dropped).toBe(N);
		expect(r!.count).toBe(0);
	});

	it('a synthetic 4-flute Mz signal shows four maxima across angular bins', () => {
		const N = 720;
		const t = Float32Array.from({ length: N }, (_, i) => i * 0.001);
		// One full revolution over the window; revs_cum goes 0..1.
		const revs = Float32Array.from({ length: N }, (_, i) => i / N);
		const Mz = new Float32Array(N);
		for (let i = 0; i < N; i++) {
			const phi = (i / N) * 2 * Math.PI;
			Mz[i] = 10 * (1 + 0.3 * Math.cos(4 * phi));
		}
		const c = makeCache({ N, t, revs, Mz } as Partial<Cache>);
		const bins = 36;
		const r = buildPolar(c, polarParams({ radius: 'Mz', bins }));
		expect(r).not.toBeNull();
		expect(r!.unit).toBe('N·m');
		const perBin = new Map<number, number[]>();
		for (let k = 0; k < r!.count; k++) {
			const b = Math.min(bins - 1, Math.floor((r!.phi[k] / (2 * Math.PI)) * bins));
			(perBin.get(b) ?? perBin.set(b, []).get(b)!).push(r!.r[k]);
		}
		const means = Array.from({ length: bins }, (_, b) => {
			const vs = perBin.get(b) ?? [];
			return vs.length ? vs.reduce((a, x) => a + x, 0) / vs.length : 0;
		});
		let maxima = 0;
		for (let b = 0; b < bins; b++) {
			const prev = means[(b - 1 + bins) % bins], next = means[(b + 1) % bins];
			if (means[b] > prev && means[b] > next) maxima++;
		}
		expect(maxima).toBe(4);
	});
});

describe('radialScale / radialFrac (negative values)', () => {
	it('non-negative data keeps the old mapping: centre = 0, outer = rMax * 1.05', () => {
		const s = radialScale(2, 10);
		expect(s.lo).toBe(0);
		expect(s.hi).toBeCloseTo(10.5, 10);
		expect(radialFrac(5.25, s)).toBeCloseTo(0.5, 10);
	});
	// Old code: (r / rMax) * radius, so -4 with rMax 8 gave a NEGATIVE radius, i.e. the point was
	// drawn 180 degrees from its angle.
	it('a negative value is nearer the centre than a positive one, never mirrored', () => {
		const s = radialScale(-4, 8);
		expect(s.lo).toBe(-4);
		expect(radialFrac(-4, s)).toBe(0);
		expect(radialFrac(0, s)).toBeGreaterThan(0);
		expect(radialFrac(8, s)).toBeGreaterThan(radialFrac(0, s));
		for (const v of [-4, -1, 0, 3, 8]) {
			const f = radialFrac(v, s);
			expect(f).toBeGreaterThanOrEqual(0);
			expect(f).toBeLessThanOrEqual(1);
		}
	});
	it('mapping is strictly increasing in the value', () => {
		const s = radialScale(-10, -2);
		const fs = [-10, -8, -6, -4, -2].map((v) => radialFrac(v, s));
		for (let i = 1; i < fs.length; i++) expect(fs[i]).toBeGreaterThan(fs[i - 1]);
	});
	it('all-negative data does not invert the scale', () => {
		const s = radialScale(-9, -3);
		expect(s.hi).toBeGreaterThan(s.lo);
		expect(radialFrac(-3, s)).toBeGreaterThan(radialFrac(-9, s));
	});
	it('a caller-supplied outer value wins; degenerate input stays a valid scale', () => {
		expect(radialScale(0, 5, 20).hi).toBe(20);
		const s = radialScale(0, 0);
		expect(s.hi).toBeGreaterThan(s.lo);
		expect(Number.isFinite(radialFrac(0, s))).toBe(true);
	});
});
