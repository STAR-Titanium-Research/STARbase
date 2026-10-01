// Coverage for histogram.ts: bin-edge behaviour, NaN handling, and -- the property the live
// accumulator's whole design depends on -- that pushing in chunks (as a live recording arrives)
// produces the exact same result as a one-shot recompute over the same data (histogramFrom).
import { describe, expect, it } from 'vitest';
import { createAccumulator, histogramFrom } from './histogram';

function series(vals: number[]): Float32Array {
	return Float32Array.from(vals);
}

describe('histogramFrom', () => {
	it('bins values evenly across [lo, hi)', () => {
		// 10 bins over [0,10): 0..9 each land in their own bin exactly.
		const h = histogramFrom(series([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 10, 0, 10, 10);
		expect(Array.from(h.bins)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
		expect(h.total).toBe(10);
		expect(h.max).toBe(1);
	});
	it('clamps a value at or above hi into the last bin, not off the end', () => {
		const h = histogramFrom(series([10, 10, 10]), 3, 0, 10, 10);
		expect(h.bins[9]).toBe(3);
		expect(h.total).toBe(3);
	});
	it('clamps a value below lo into the first bin', () => {
		const h = histogramFrom(series([-5, -5]), 2, 0, 10, 10);
		expect(h.bins[0]).toBe(2);
	});
	it('skips NaN/Infinity rather than crashing or corrupting a bin', () => {
		const h = histogramFrom(series([1, NaN, 2, Infinity, -Infinity, 3]), 6, 0, 10, 10);
		expect(h.total).toBe(3);   // only the finite samples count -- same as the accumulator
		expect(Array.from(h.bins).reduce((a, b) => a + b, 0)).toBe(3);   // only the 3 finite ones landed
	});
	it('agrees with the incremental accumulator when the data contains NaN/Infinity', () => {
		const data = series([1, NaN, 2, Infinity, -Infinity, 3, NaN, 7]);
		const acc = createAccumulator(0, 10, 10);
		acc.push(data, 0, data.length);
		expect(histogramFrom(data, data.length, 0, 10, 10)).toEqual(acc.snapshot());
	});
	it('only scans the first `count` elements, ignoring the rest of a larger backing array', () => {
		const arr = series([1, 1, 1, 9, 9, 9]);   // backing buffer bigger than what's "live"
		const h = histogramFrom(arr, 3, 0, 10, 10);   // only the first 3 (all value 1) count
		expect(h.total).toBe(3);
		expect(h.bins[1]).toBe(3);
		expect(h.bins[9]).toBe(0);
	});
	it('does not divide by zero on a degenerate [lo, hi) range', () => {
		expect(() => histogramFrom(series([1, 2, 3]), 3, 5, 5, 10)).not.toThrow();
	});
});

describe('createAccumulator', () => {
	it('push() in one call matches histogramFrom over the same data', () => {
		const data = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.1) * 50);
		const acc = createAccumulator(-50, 50, 32);
		acc.push(data, 0, data.length);
		expect(acc.snapshot()).toEqual(histogramFrom(data, data.length, -50, 50, 32));
	});
	it('pushing in several chunks matches pushing all at once (the live-append case)', () => {
		const data = Float32Array.from({ length: 1000 }, (_, i) => ((i * 37) % 211) - 100);
		const whole = createAccumulator(-100, 100, 40);
		whole.push(data, 0, data.length);

		const chunked = createAccumulator(-100, 100, 40);
		for (let i = 0; i < data.length; i += 137) chunked.push(data, i, Math.min(i + 137, data.length));

		expect(chunked.snapshot()).toEqual(whole.snapshot());
	});
	it('sawOutOfRange is false while every pushed value stays inside [lo, hi)', () => {
		const acc = createAccumulator(0, 10, 10);
		acc.push(series([1, 2, 3]), 0, 3);
		expect(acc.sawOutOfRange()).toBe(false);
	});
	it('sawOutOfRange flips true the moment a value falls outside the window, and still counts it', () => {
		const acc = createAccumulator(0, 10, 10);
		acc.push(series([1, 2, 999]), 0, 3);
		expect(acc.sawOutOfRange()).toBe(true);
		expect(acc.snapshot().total).toBe(3);
	});
	it('rebin() resets counts and starts fresh under the new range', () => {
		const acc = createAccumulator(0, 10, 10);
		acc.push(series([1, 2, 3]), 0, 3);
		acc.rebin(0, 100);
		const snap = acc.snapshot();
		expect(snap.total).toBe(0);
		expect(snap.max).toBe(0);
		expect(snap.lo).toBe(0); expect(snap.hi).toBe(100);
		expect(acc.sawOutOfRange()).toBe(false);
	});
	it('snapshot() returns an independent copy -- a later push does not mutate a held snapshot', () => {
		const acc = createAccumulator(0, 10, 5);
		acc.push(series([1]), 0, 1);
		const snap = acc.snapshot();
		acc.push(series([1, 1, 1]), 0, 3);
		expect(snap.total).toBe(1);            // unaffected by the push after the snapshot was taken
		expect(acc.snapshot().total).toBe(4);  // a fresh snapshot does see it
	});
});
