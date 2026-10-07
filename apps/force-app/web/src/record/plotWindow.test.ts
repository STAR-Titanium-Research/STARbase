import { describe, expect, it } from 'vitest';
import { clampWindowSec, firstAtOrAfter, windowView, WINDOW_MAX_SEC } from './plotWindow';

const ramp = (n: number, dt = 0.1, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + i * dt);

describe('clampWindowSec', () => {
	it('keeps a sensible value and clamps to the allowed range', () => {
		expect(clampWindowSec(12)).toBe(12);
		expect(clampWindowSec(0.2)).toBe(1);
		expect(clampWindowSec(9999)).toBe(WINDOW_MAX_SEC);
		expect(clampWindowSec('30')).toBe(30);
	});
	it('falls back for a cleared input, NaN, or junk', () => {
		expect(clampWindowSec('', 7)).toBe(7);
		expect(clampWindowSec(NaN, 7)).toBe(7);
		expect(clampWindowSec(0, 7)).toBe(7);
		expect(clampWindowSec(-3, 7)).toBe(7);
		expect(clampWindowSec(null, 7)).toBe(7);
		expect(clampWindowSec({}, 7)).toBe(7);
	});
});

describe('firstAtOrAfter', () => {
	it('binary-searches an ascending array', () => {
		const t = [0, 1, 2, 3];
		expect(firstAtOrAfter(t, -1)).toBe(0);
		expect(firstAtOrAfter(t, 1)).toBe(1);
		expect(firstAtOrAfter(t, 1.5)).toBe(2);
		expect(firstAtOrAfter(t, 9)).toBe(4);
		expect(firstAtOrAfter([], 0)).toBe(0);
	});
});

describe('windowView', () => {
	it('is null with nothing to draw', () => {
		expect(windowView([], 12)).toBeNull();
	});

	it('scrolls a fixed-width range once history is longer than the window', () => {
		const t = ramp(601);                 // 0..60 s
		const v = windowView(t, 12)!;
		expect(v.x1).toBeCloseTo(60, 6);
		expect(v.x0).toBeCloseTo(48, 6);
		// One sample before the left edge, so the envelope reaches it.
		expect(t[v.i0]).toBeLessThan(48);
		expect(t[v.i0 + 1]).toBeGreaterThanOrEqual(48 - 1e-9);
	});

	it('applies a changed window to the SAME data at once (#105)', () => {
		const t = ramp(601);
		const narrow = windowView(t, 5)!, wide = windowView(t, 30)!;
		expect(narrow.x1 - narrow.x0).toBeCloseTo(5, 6);
		expect(wide.x1 - wide.x0).toBeCloseTo(30, 6);
		expect(wide.i0).toBeLessThan(narrow.i0);
	});

	it('keeps the range a full window wide before history fills it', () => {
		const t = ramp(21, 0.1, 15);         // 15..17 s, e.g. the start of a replay
		const v = windowView(t, 12)!;
		expect(v).toEqual({ i0: 0, x0: 15, x1: 27 });
	});

	it('clamps an unusable window instead of drawing nothing', () => {
		const v = windowView(ramp(601), 0)!;
		expect(v.x1 - v.x0).toBeCloseTo(12, 6);
	});
});
