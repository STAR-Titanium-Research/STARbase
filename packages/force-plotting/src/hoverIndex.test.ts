import { describe, expect, it } from 'vitest';
import { hoverIndexAt, nearestIndex } from './hoverIndex';

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
});

describe('hoverIndexAt', () => {
	// 1001 samples at 1 kHz: t = 0 .. 1.000 s.
	const xs = Array.from({ length: 1001 }, (_, i) => i / 1000);

	it('full view: fraction maps linearly onto the samples', () => {
		expect(hoverIndexAt(xs, 0, 1, 0.5)).toBe(500);
		expect(hoverIndexAt(xs, 0, 1, 0)).toBe(0);
		expect(hoverIndexAt(xs, 0, 1, 1)).toBe(1000);
	});

	// Zoomed to 0.40..0.50 s. The pointer in the middle of the plot is at t = 0.45 s, i.e. sample
	// 450. The old index-fraction maths (0.5 * 1000) put the crosshair at sample 500 (t = 0.50 s).
	it('zoomed view: the pointer maps into the visible window, not the whole record', () => {
		expect(hoverIndexAt(xs, 0.4, 0.5, 0.5)).toBe(450);
		expect(hoverIndexAt(xs, 0.4, 0.5, 0)).toBe(400);
		expect(hoverIndexAt(xs, 0.4, 0.5, 1)).toBe(500);
	});

	it('clamps the fraction and keeps the result inside [iA, iB]', () => {
		expect(hoverIndexAt(xs, 0.4, 0.5, -3, 400, 500)).toBe(400);
		expect(hoverIndexAt(xs, 0.4, 0.5, 9, 400, 500)).toBe(500);
		// window edge falls between samples: nearest could be iA - 1, but the plot only shows iA..iB
		expect(hoverIndexAt(xs, 0.4004, 0.5, 0, 401, 500)).toBe(401);
	});

	it('works on non-uniform x (a frequency axis)', () => {
		const f = [0, 10, 20, 50, 100, 200];
		expect(hoverIndexAt(f, 10, 100, 0.5)).toBe(3);   // 55 Hz -> 50
	});
});
