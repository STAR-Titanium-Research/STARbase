import { describe, expect, it } from 'vitest';
import { createSparkDomain, createStableMax, niceCeil, sparkPoints } from './rpmScale';

describe('niceCeil', () => {
	it('rounds up to a nice step', () => {
		expect(niceCeil(1500)).toBe(1500);
		expect(niceCeil(1501)).toBe(2000);
		expect(niceCeil(1320)).toBe(1500);
		expect(niceCeil(110)).toBe(120);
		expect(niceCeil(99)).toBe(100);
		expect(niceCeil(8001)).toBe(10000);
		expect(niceCeil(0)).toBe(1);
		expect(niceCeil(NaN)).toBe(1);
	});
});

describe('createStableMax (#67)', () => {
	it('does not move with noise inside one nice step', () => {
		const s = createStableMax();
		const seen = new Set<number>();
		// RPM noise around 1180 with no target: want = rpm * 1.1, roughly 1265..1331.
		for (let i = 0; i < 200; i++) seen.add(s.update((1180 + Math.sin(i) * 30) * 1.1, i * 16));
		expect([...seen]).toEqual([1500]);
	});

	it('grows at once', () => {
		const s = createStableMax();
		s.update(1300, 0);
		expect(s.update(2600, 10)).toBe(3000);
	});

	it('shrinks only after the lower value has held for a while', () => {
		const s = createStableMax({ shrinkAfterMs: 1000 });
		s.update(2600, 0);                      // 3000
		expect(s.update(900, 100)).toBe(3000);
		expect(s.update(950, 600)).toBe(3000);
		expect(s.update(900, 1200)).toBe(1000);  // largest wanted while low: 950 -> 1000
	});

	it('a brief return to the high value cancels a pending shrink', () => {
		const s = createStableMax({ shrinkAfterMs: 1000 });
		s.update(2600, 0);
		s.update(900, 100);
		s.update(2600, 600);
		expect(s.update(900, 1200)).toBe(3000);
	});

	it('never goes below the floor and survives junk', () => {
		const s = createStableMax({ floor: 100 });
		expect(s.update(0, 0)).toBe(100);
		expect(s.update(NaN, 1)).toBe(100);
		s.update(5000, 2);
		s.reset();
		expect(s.value).toBe(100);
	});
});

describe('sparkline domain (#188)', () => {
	// 40..80 RPM sine, against a 3000 RPM target (the gauge's max would be 5000).
	const hist = Array.from({ length: 80 }, (_, i) => 60 + 20 * Math.sin(i / 5));
	const ySpan = (pts: string) => {
		const ys = pts.split(' ').map((p) => Number(p.split(',')[1]));
		return Math.max(...ys) - Math.min(...ys);
	};

	it('gives an empty history the minimum span from zero, without storing it', () => {
		const tr = createSparkDomain({ minSpan: 20 });
		expect(tr.update([], 0)).toEqual({ lo: 0, hi: 20 });
		expect(tr.update([500, 510], 0).lo).toBeGreaterThan(400);
	});

	it('fills most of the box for a low RPM against a high target', () => {
		const tr = createSparkDomain();
		const dom = tr.update(hist, 0);
		expect(ySpan(sparkPoints(hist, dom)) / 34).toBeGreaterThanOrEqual(0.5);
		// The old behaviour, for contrast: scaled to the gauge max.
		const old = hist.map((v) => 38 - (Math.min(v, 5000) / 5000) * 34);
		expect((Math.max(...old) - Math.min(...old)) / 34).toBeLessThan(0.05);
	});

	it('keeps a minimum span so steady noise does not fill the box', () => {
		const tr = createSparkDomain();
		const noise = Array.from({ length: 60 }, (_, i) => 3000 + (i % 2 ? 2 : -2));
		const dom = tr.update(noise, 0);
		expect(dom.hi - dom.lo).toBeGreaterThanOrEqual(300);          // 10 % of the top value
		expect(ySpan(sparkPoints(noise, dom)) / 34).toBeLessThan(0.1);
	});

	it('does not move while the data stays inside it, and recentres when it leaves', () => {
		const tr = createSparkDomain();
		const d1 = { ...tr.update(hist, 0) };
		const d2 = { ...tr.update([...hist, 61, 62], 16) };
		expect(d2).toEqual(d1);
		const d3 = tr.update([...hist, 400], 32);
		expect(d3.hi).toBeGreaterThanOrEqual(400);
	});

	it('never goes below zero RPM', () => {
		const tr = createSparkDomain();
		expect(tr.update([0, 3, 1], 0).lo).toBe(0);
	});
});
