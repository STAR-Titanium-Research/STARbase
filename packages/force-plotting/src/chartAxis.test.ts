import { describe, expect, it } from 'vitest';
import { axisLabels, dbSeries, firstDecade, labelsThatFit, logTicks, niceScale, niceTicksIn, toDb } from './chartAxis';
import { fmtHz } from './filterResponse';

describe('niceScale', () => {
	it('uses 1, 2, 2.5 or 5 x 10^n steps with five or six ticks and the top tick above the data', () => {
		const s = niceScale(0, 163.3);
		expect(s.ticks).toEqual([0, 50, 100, 150, 200]);
		expect(s.hi).toBe(200);
		expect(niceScale(0, 93.6).ticks).toEqual([0, 20, 40, 60, 80, 100]);
		expect(niceScale(0, 71.4).ticks).toEqual([0, 20, 40, 60, 80]);
		expect(niceScale(0, 7).ticks).toEqual([0, 2, 4, 6, 8]);
	});
	it('offers the 2.5 step', () => {
		expect(niceScale(0, 11).ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5]);
	});
	it('grows below the data too, across zero', () => {
		const s = niceScale(-8.2, 23);
		expect(s.lo).toBeLessThanOrEqual(-8.2);
		expect(s.hi).toBeGreaterThanOrEqual(23);
		expect(s.ticks).toContain(0);
		expect(s.ticks.length).toBeLessThanOrEqual(6);
	});
	it('never returns more than maxTicks, and survives a flat range', () => {
		for (const [lo, hi] of [[0, 1], [0, 1e-4], [-3, 3], [1195, 1205], [0, 12345]]) {
			const t = niceScale(lo, hi).ticks;
			expect(t.length).toBeGreaterThanOrEqual(3);
			expect(t.length).toBeLessThanOrEqual(6);
			expect(t[t.length - 1]).toBeGreaterThanOrEqual(hi);
		}
		expect(niceScale(5, 5).ticks.length).toBeGreaterThan(1);
	});
	it('keeps decimal steps free of float noise', () => {
		expect(niceScale(0, 0.3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
	});
});

describe('niceTicksIn', () => {
	it('stays inside the range', () => {
		expect(niceTicksIn(0, 8)).toEqual([0, 2, 4, 6, 8]);
		expect(niceTicksIn(0.4, 7.3, 6)).toEqual([2, 4, 6]);
	});
	it('thins out for a narrower axis', () => {
		expect(niceTicksIn(0, 8, 4).length).toBeLessThanOrEqual(4);
	});
});

describe('axisLabels and fmtFreq', () => {
	it('writes a real minus sign', () => {
		expect(axisLabels([-20, 0, 20])).toEqual(['−20', '0', '20']);
	});
	it('writes 1k and 10k on a frequency axis', () => {
		expect([10, 100, 1000, 2500, 10000, 0.5].map((f) => fmtHz(f, false))).toEqual(['10', '100', '1k', '2.5k', '10k', '0.5']);
	});
});

describe('spectrum helpers', () => {
	it('converts to dB re 1 N without -Infinity', () => {
		expect(toDb(1)).toBe(0);
		expect(toDb(0.1)).toBeCloseTo(-20);
		expect(Number.isFinite(toDb(0))).toBe(true);
		expect(dbSeries({ f: [1, 2], amp: [10, 1] })).toEqual({ f: [1, 2], amp: [20, 0] });
	});
	it('starts a log axis at the decade of the first non-zero bin, at least 1 Hz', () => {
		expect(firstDecade([0, 6.4, 12.8])).toBe(1);
		expect(firstDecade([0, 25, 50])).toBe(10);
		expect(firstDecade([0, 0.5, 1])).toBe(1);
		expect(firstDecade([])).toBe(1);
	});
	it('keeps the leftmost label and drops ones that would collide, whatever the input order', () => {
		const spans = [{ x0: 100, x1: 160 }, { x0: 10, x1: 70 }, { x0: 120, x1: 180 }, { x0: 165, x1: 200 }];
		expect(labelsThatFit(spans)).toEqual([true, true, false, true]);
	});
});

describe('logTicks', () => {
	it('labels the decades and adds the 2-9 lines of each decade as minor ticks', () => {
		const t = logTicks(10, 10000);
		expect(t.major).toEqual([10, 100, 1000, 10000]);
		expect(t.minor.length).toBe(8 * 3);
		expect(t.minor).toContain(20);
		expect(t.minor).toContain(5000);
	});
	it('labels 1, 2 and 5 when the range is inside one decade', () => {
		expect(logTicks(150, 900).major).toEqual([200, 500]);
	});
	it('is empty for a range a log axis cannot show', () => {
		expect(logTicks(0, 100)).toEqual({ major: [], minor: [] });
	});
});
