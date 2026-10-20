import { describe, expect, it } from 'vitest';
import { nearestIndex } from './hoverIndex';

describe('nearestIndex', () => {
	const xs = [0, 1, 2, 4, 8];
	it('finds the nearest sample by value', () => {
		expect(nearestIndex(xs, 0)).toBe(0);
		expect(nearestIndex(xs, 2.9)).toBe(2);
		expect(nearestIndex(xs, 3.1)).toBe(3);
		expect(nearestIndex(xs, 100)).toBe(4);
		expect(nearestIndex(xs, -5)).toBe(0);
	});
	it('ties go to the lower index', () => { expect(nearestIndex(xs, 3)).toBe(2); });
	it('respects the [lo, hi] bounds', () => { expect(nearestIndex(xs, 0, 2, 4)).toBe(2); });
	it('works on a zoomed window and on non-uniform x (a frequency axis)', () => {
		const t = Array.from({ length: 1001 }, (_, i) => i / 1000);
		expect(nearestIndex(t, 0.45, 400, 500)).toBe(450);
		expect(nearestIndex(t, 0.4004, 401, 500)).toBe(401);   // the plot only shows iA..iB
		expect(nearestIndex([0, 10, 20, 50, 100, 200], 55)).toBe(3);
	});
});
