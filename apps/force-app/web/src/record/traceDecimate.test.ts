import { describe, expect, it } from 'vitest';
import { decimateMinMax, seriesRange, shouldDecimate } from './traceDecimate';

describe('seriesRange', () => {
	it('spans every array', () => {
		expect(seriesRange([new Float32Array([1, -2, 3]), [10, 0]])).toEqual([-2, 10]);
	});
	it('is null with no finite data', () => {
		expect(seriesRange([])).toBeNull();
		expect(seriesRange([[NaN]])).toBeNull();
	});
});

describe('decimateMinMax', () => {
	it('keeps first, min, max and last per column', () => {
		// 8 samples over [0, 8) into 2 columns of 4.
		const t = [0, 1, 2, 3, 4, 5, 6, 7];
		const v = [5, 9, -1, 2, 0, 0, 7, 3];
		const d = decimateMinMax(t, v, 0, 8, 2);
		expect(Array.from(d.first)).toEqual([5, 0]);
		expect(Array.from(d.min)).toEqual([-1, 0]);
		expect(Array.from(d.max)).toEqual([9, 7]);
		expect(Array.from(d.last)).toEqual([2, 3]);
	});

	it('keeps a one-sample spike at full height', () => {
		const N = 100_000;
		const t = new Float32Array(N), v = new Float32Array(N);
		for (let i = 0; i < N; i++) t[i] = i / N;
		v[54_321] = 500;
		const d = decimateMinMax(t, v, 0, 1, 300);
		expect(Math.max(...Array.from(d.max))).toBe(500);
	});

	it('puts the final sample (t === t1) in the last column', () => {
		const d = decimateMinMax([0, 1], [1, 2], 0, 1, 4);
		expect(d.last[3]).toBe(2);
	});

	it('leaves empty columns as NaN and ignores samples outside the window', () => {
		const d = decimateMinMax([0, 0.1, 5], [1, 2, 99], 0, 1, 4);
		expect(d.max[0]).toBe(2);
		expect(Number.isNaN(d.max[2])).toBe(true);
		expect(Array.from(d.max).includes(99)).toBe(false);
	});

	it('returns all-empty columns for a zero-length window', () => {
		const d = decimateMinMax([1, 1], [3, 4], 1, 1, 3);
		expect(Array.from(d.first).every(Number.isNaN)).toBe(true);
	});
});

describe('shouldDecimate', () => {
	it('only for clearly oversampled traces', () => {
		expect(shouldDecimate(250_000, 1600)).toBe(true);
		expect(shouldDecimate(2_000, 1600)).toBe(false);
	});
});
