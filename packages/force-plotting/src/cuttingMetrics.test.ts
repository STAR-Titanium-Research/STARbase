import { describe, expect, it } from 'vitest';
import {
	AXIS_MAPS, AXIS_MAP_BY_SUBTYPE_KEY, DEFAULT_AXIS_MAP, formatAxisMap, LEGACY_AXIS_MAP_KEY, readAxisMapsBySubtype, removeLegacyAxisMap, resolveAxisMap, subtypeMapKey, writeAxisMapForSubtype, computeCuttingMetrics, midWindowDiameter, opKindFromSubtype, parseAxisMap, usesSpiralDiameter,
	type CuttingInputs,
} from './cuttingMetrics';

// Fixtures use Fc = Fz (600 N) so the arithmetic below stays put; the default has its own test.
const FZ_MAP = { Fc: 'Fz', Ff: 'Fx', Fp: 'Fy' } as const;

// Constant forces: Fx = 200 N, Fy = -100 N, Fz = 600 N (min = max = mean). 1000 rpm throughout.
const axis = (v: number) => ({ n: 100, mean: v, rms: Math.abs(v), std: 0, min: v, max: v, p2p: 0, effBits: null, railLoPct: 0, railHiPct: 0, clipped: false });
const RES = Math.sqrt(200 ** 2 + 100 ** 2 + 600 ** 2);   // 640.3124 N
const baseStats: CuttingInputs['stats'] = {
	windowSec: [0, 0], cacheCropStartSec: 0,
	axes: { Fx: axis(200), Fy: axis(-100), Fz: axis(600) },
	rpm: { mean: 1000, std: 0, min: 1000, max: 1000 },
	resultant: { mean: RES, peak: RES },
};
const inp = (o: Partial<CuttingInputs> = {}): CuttingInputs => ({
	stats: baseStats, axisMap: FZ_MAP, opKind: 'turning', spiral: false, diameterMm: 100, feedMmPerRev: 0.1, apMm: 2, ...o,
});

describe('computeCuttingMetrics', () => {
	it('matches the hand calculation for a constant cut', () => {
		const m = computeCuttingMetrics(inp());
		expect(m.resultant.mean.value).toBeCloseTo(640.3124, 4);
		expect(m.Fc.mean.value).toBe(600);
		expect(m.Ff.mean.value).toBe(200);
		expect(m.Fp.mean.value).toBe(100);   // |-100|
		expect(m.Fp.peak.value).toBe(100);
		expect(m.vcMPerMin.value).toBeCloseTo(314.159265, 5);   // pi * 100 mm * 1000 rpm / 1000
		expect(m.pcW.value).toBeCloseTo(3141.59265, 4);          // 600 N * 314.159 m/min / 60
		expect(m.kcMPa.value).toBe(3000);                        // 600 / (2 mm * 0.1 mm/rev)
	});
	it('follows the axis mapping', () => {
		const m = computeCuttingMetrics(inp({ axisMap: { Fc: 'Fx', Ff: 'Fz', Fp: 'Fy' } }));
		expect(m.Fc.mean.value).toBe(200);
		expect(m.kcMPa.value).toBe(1000);
	});
	it('uses the diameter at the window midpoint of the spiral', () => {
		// 60 s window, 1000 rpm, f = 0.01: mid is 30 s => 500 revs => D = 100 - 2 * 0.01 * 500 = 90
		expect(midWindowDiameter(100, 0.01, 1000, 30)).toBeCloseTo(90, 9);
		const m = computeCuttingMetrics(inp({ spiral: true, feedMmPerRev: 0.01, stats: { ...baseStats, windowSec: [0, 60] } }));
		expect(m.diameterMidMm.value).toBeCloseTo(90, 9);
		expect(m.vcMPerMin.value).toBeCloseTo(Math.PI * 90, 9);
	});
	it('reports a window past the disc centre as unavailable', () => {
		const m = computeCuttingMetrics(inp({ spiral: true, feedMmPerRev: 0.1, stats: { ...baseStats, windowSec: [0, 60] } }));
		expect(m.vcMPerMin.value).toBeNull();
		expect(m.pcW.value).toBeNull();
		expect(m.kcMPa.value).toBe(3000);   // kc needs no speed
	});
	it('says why each metric is unavailable when an input is missing', () => {
		const noFeed = computeCuttingMetrics(inp({ feedMmPerRev: null }));
		expect(noFeed.kcMPa).toEqual({ value: null, reason: 'feed not recorded' });
		expect(noFeed.pcW.value).toBeCloseTo(3141.59265, 4);   // power does not need the feed
		expect(computeCuttingMetrics(inp({ apMm: undefined })).kcMPa.reason).toBe('depth of cut not recorded');
		expect(computeCuttingMetrics(inp({ apMm: 0 })).kcMPa.reason).toBe('depth of cut not recorded');
		const noD = computeCuttingMetrics(inp({ diameterMm: 0 }));
		expect(noD.vcMPerMin.reason).toBe('diameter missing');
		expect(noD.pcW.reason).toBe('diameter missing');
		expect(noD.kcMPa.value).toBe(3000);
	});
	it('zero RPM makes speed and power unavailable but not kc or the forces', () => {
		const m = computeCuttingMetrics(inp({ stats: { ...baseStats, rpm: { mean: 0, std: 0, min: 0, max: 0 } } }));
		expect(m.vcMPerMin.reason).toBe('RPM is zero in this window');
		expect(m.pcW.reason).toBe('RPM is zero in this window');
		expect(m.kcMPa.value).toBe(3000);
		expect(m.Fc.mean.value).toBe(600);
	});
	it('milling and unknown ops keep only the resultant', () => {
		for (const kind of ['milling', 'unknown'] as const) {
			const m = computeCuttingMetrics(inp({ opKind: kind }));
			expect(m.resultant.mean.value).toBeCloseTo(640.3124, 4);
			expect(m.Fc.mean.value).toBeNull();
			expect(m.pcW.value).toBeNull();
			expect(m.kcMPa.value).toBeNull();
			expect(m.kcMPa.reason).toMatch(kind === 'milling' ? /milling/ : /unknown/);
		}
	});
	it('uses |min|/|max| for the peak of a signed axis', () => {
		const stats = { ...baseStats, axes: { ...baseStats.axes, Fz: { ...axis(600), min: -900, max: 700 } } };
		expect(computeCuttingMetrics(inp({ stats })).Fc.peak.value).toBe(900);
	});
	it('handles an empty window', () => {
		const e = { ...axis(0), n: 0 };
		const m = computeCuttingMetrics(inp({ stats: { ...baseStats, axes: { Fx: e, Fy: e, Fz: e } } }));
		expect(m.resultant.mean.value).toBeNull();
		expect(m.Fc.mean.value).toBeNull();
	});
});

describe('which operations spiral', () => {
	// The reviewer's example: D = 80 mm, f = 0.2 mm/rev, n = 1000 rpm, window midpoint 10 s after the origin.
	const stats = { ...baseStats, windowSec: [9, 11] as [number, number] };
	const ex = (o: Partial<CuttingInputs>) => computeCuttingMetrics(inp({ diameterMm: 80, feedMmPerRev: 0.2, stats, ...o }));

	it('OD turning, boring and threading keep the constant diameter', () => {
		for (const sub of ['MT-O', 'MT-R', 'MT-B', 'MT-H', 'MT-D', 'MT-Other', '', null]) {
			const spiral = usesSpiralDiameter(sub);
			expect(spiral).toBe(false);
			const m = ex({ spiral });
			expect(m.diameterMidMm.value).toBe(80);
			expect(m.vcMPerMin.value).toBeCloseTo(251.327, 3);   // pi * 80 * 1000 / 1000
		}
	});
	it('facing, grooving and parting use the diameter at the window midpoint', () => {
		for (const sub of ['MT-F', 'MT-G', 'MT-P', 'mt-face', 'MT-Facing']) {
			expect(usesSpiralDiameter(sub)).toBe(true);
			const m = ex({ spiral: true });
			expect(m.diameterMidMm.value).toBeCloseTo(80 - 2 * 0.2 * 1000 * 10 / 60, 9);   // 13.33 mm
			expect(m.vcMPerMin.value).toBeCloseTo(Math.PI * m.diameterMidMm.value! * 1000 / 1000, 9);
		}
	});
	it('measures the shrinkage from the active crop start, not the cache start', () => {
		// Saved crop starts at 6 s: the window midpoint is 4 s into the spiral, not 10 s.
		const withCrop = ex({ spiral: true, spiralOriginSec: 6 });
		expect(withCrop.diameterMidMm.value).toBeCloseTo(80 - 2 * 0.2 * 1000 * 4 / 60, 9);   // 53.33 mm
		// No override: falls back to the cache crop start (0 s here).
		expect(ex({ spiral: true }).diameterMidMm.value).toBeCloseTo(80 - 2 * 0.2 * 1000 * 10 / 60, 9);
	});
	it('uses the geometry feed of the spiral, not the operation feed, for D_mid (kc keeps the op feed)', () => {
		const m = ex({ spiral: true, feedMmPerRev: 0.2, spiralFeedMmPerRev: 0.1, spiralOriginSec: 0 });
		expect(m.diameterMidMm.value).toBeCloseTo(80 - 2 * 0.1 * 1000 * 10 / 60, 9);   // 46.67 mm
		expect(m.kcMPa.value).toBe(600 / (2 * 0.2));
		// No usable geometry feed: constant D, as before.
		expect(ex({ spiral: true, spiralFeedMmPerRev: 0 }).diameterMidMm.value).toBe(80);
	});
});

describe('helpers', () => {
	it('classifies subtypes', () => {
		expect(opKindFromSubtype('MT-Facing')).toBe('turning');
		expect(opKindFromSubtype(' mm-slot')).toBe('milling');
		expect(opKindFromSubtype('')).toBe('unknown');
		expect(opKindFromSubtype(null)).toBe('unknown');
	});
	it('offers six axis mappings and falls back to the default', () => {
		expect(AXIS_MAPS).toHaveLength(6);
		expect(parseAxisMap('Fx/Fz/Fy')).toEqual({ Fc: 'Fx', Ff: 'Fz', Fp: 'Fy' });
		expect(parseAxisMap('nonsense')).toEqual(DEFAULT_AXIS_MAP);
		expect(parseAxisMap(null)).toEqual(DEFAULT_AXIS_MAP);
	});
});

describe('default axis map', () => {
	it('is the owner standard: Fc = Fx, Ff = Fy, Fp = Fz', () => {
		expect(DEFAULT_AXIS_MAP).toEqual({ Fc: 'Fx', Ff: 'Fy', Fp: 'Fz' });
		expect(formatAxisMap(DEFAULT_AXIS_MAP)).toBe('Fc = Fx, Ff = Fy, Fp = Fz');
		const m = computeCuttingMetrics(inp({ axisMap: DEFAULT_AXIS_MAP }));
		expect(m.Fc.mean.value).toBe(200);
		expect(m.Ff.mean.value).toBe(100);
		expect(m.Fp.mean.value).toBe(600);
	});
});

class MemStore {
	d = new Map<string, string>();
	getItem(k: string) { return this.d.has(k) ? this.d.get(k)! : null; }
	setItem(k: string, v: string) { this.d.set(k, v); }
	removeItem(k: string) { this.d.delete(k); }
}

describe('per-subtype axis map storage', () => {
	it('falls back to the default with nothing stored or no storage', () => {
		expect(resolveAxisMap('MT-F', new MemStore())).toEqual(DEFAULT_AXIS_MAP);
		expect(resolveAxisMap('MT-F', null)).toEqual(DEFAULT_AXIS_MAP);
	});
	it('remembers an override per subtype, case-insensitively, leaving others alone', () => {
		const st = new MemStore();
		writeAxisMapForSubtype('mt-f', { Fc: 'Fz', Ff: 'Fx', Fp: 'Fy' }, st);
		expect(resolveAxisMap('MT-F', st)).toEqual({ Fc: 'Fz', Ff: 'Fx', Fp: 'Fy' });
		expect(resolveAxisMap('MT-O', st)).toEqual(DEFAULT_AXIS_MAP);
		writeAxisMapForSubtype('MT-O', { Fc: 'Fy', Ff: 'Fx', Fp: 'Fz' }, st);
		expect(resolveAxisMap('MT-F', st).Fc).toBe('Fz');
		expect(resolveAxisMap('MT-O', st).Fc).toBe('Fy');
	});
	it('uses "default" for an empty or unknown subtype', () => {
		expect(subtypeMapKey(null)).toBe('default');
		expect(subtypeMapKey('  ')).toBe('default');
		const st = new MemStore();
		writeAxisMapForSubtype('', { Fc: 'Fy', Ff: 'Fx', Fp: 'Fz' }, st);
		expect(resolveAxisMap(undefined, st).Fc).toBe('Fy');
	});
	it('ignores corrupt storage and bad entries', () => {
		const st = new MemStore();
		st.setItem(AXIS_MAP_BY_SUBTYPE_KEY, '{not json');
		expect(readAxisMapsBySubtype(st)).toEqual({});
		st.setItem(AXIS_MAP_BY_SUBTYPE_KEY, '[1,2]');
		expect(readAxisMapsBySubtype(st)).toEqual({});
		st.setItem(AXIS_MAP_BY_SUBTYPE_KEY, JSON.stringify({ 'MT-F': 'bogus', 'MT-O': 'Fz/Fx/Fy', 'MT-P': 7 }));
		expect(readAxisMapsBySubtype(st)).toEqual({ 'MT-O': 'Fz/Fx/Fy' });
		writeAxisMapForSubtype('MT-F', DEFAULT_AXIS_MAP, st);   // a write repairs the blob
		expect(readAxisMapsBySubtype(st)).toEqual({ 'MT-O': 'Fz/Fx/Fy', 'MT-F': 'Fx/Fy/Fz' });
	});
	it('never throws when storage does', () => {
		const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
		expect(resolveAxisMap('MT-F', bad)).toEqual(DEFAULT_AXIS_MAP);
		expect(() => writeAxisMapForSubtype('MT-F', DEFAULT_AXIS_MAP, bad)).not.toThrow();
		expect(() => removeLegacyAxisMap(bad)).not.toThrow();
	});
	it('removes the legacy single key', () => {
		const st = new MemStore();
		st.setItem(LEGACY_AXIS_MAP_KEY, 'Fz/Fx/Fy');
		removeLegacyAxisMap(st);
		expect(st.getItem(LEGACY_AXIS_MAP_KEY)).toBeNull();
	});
});
