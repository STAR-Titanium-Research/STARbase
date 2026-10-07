import { describe, expect, it } from 'vitest';
import { createStableMax, niceCeil } from './rpmScale';

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
