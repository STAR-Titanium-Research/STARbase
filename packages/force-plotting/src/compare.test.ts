import { describe, expect, it } from 'vitest';
import { alignAndDiff, cropWindowSec, diffEnvelopes, diffStats, diffWindow, intersectWindows, type EnvelopeSeries } from './compare';

const SPR = 256;

// A repeatable "tool signature" waveform -- what a real cut's TSA signature would look like:
// a fundamental plus a harmonic, nothing random. Two passes sharing this exactly is the
// synthetic stand-in for "the tool/machine behaved the same both times".
function makeSignature(revs: Float32Array): Float32Array {
	const out = new Float32Array(revs.length);
	for (let i = 0; i < revs.length; i++) {
		out[i] = Math.sin(2 * Math.PI * revs[i]) + 0.5 * Math.sin(2 * Math.PI * 3 * revs[i]);
	}
	return out;
}

function revGrid(nRev: number, spr: number, offset = 0): Float32Array {
	const n = nRev * spr;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = offset + i / spr;
	return out;
}

describe('alignAndDiff', () => {
	it('recovers an anomaly present in only one pass, cancelling the shared tool signature', () => {
		// THE ground-truth test: two passes sharing the exact same repeatable waveform, one
		// with an extra anomaly the other never had. The diff must isolate that anomaly and
		// go quiet everywhere the two passes actually agreed.
		const revA = revGrid(20, SPR);
		const sigA = makeSignature(revA);
		const revB = revGrid(20, SPR);
		const sigB = makeSignature(revB);
		const hitIdx = Math.round(10 * SPR);
		sigB[hitIdx] += 5.0;

		const { rev, diff } = alignAndDiff(revA, sigA, revB, sigB, SPR);
		let peakIdx = 0;
		for (let i = 1; i < diff.length; i++) {
			if (Math.abs(diff[i]) > Math.abs(diff[peakIdx])) peakIdx = i;
		}
		expect(Math.abs(rev[peakIdx] - 10.0)).toBeLessThan(0.05);
		expect(Math.abs(diff[peakIdx])).toBeGreaterThan(4.0);
		// away from the anomaly, both passes agree -- the diff should be ~0
		const farIdx = Math.round(2 * SPR);
		expect(Math.abs(diff[farIdx])).toBeLessThan(0.01);
	});

	it('resamples only the overlapping revolution range when passes cover different spans', () => {
		const revA = revGrid(20, SPR, 0); // covers 0..20
		const revB = revGrid(20, SPR, 5); // covers 5..25
		const sigA = makeSignature(revA);
		const sigB = makeSignature(revB);
		const { rev } = alignAndDiff(revA, sigA, revB, sigB, SPR);
		expect(rev[0]).toBeCloseTo(5.0, 2);
		expect(rev[rev.length - 1]).toBeLessThanOrEqual(20.0 + 1e-6);
	});

	it('throws when the two revolution ranges do not overlap at all', () => {
		const revA = revGrid(5, SPR, 0); // 0..5
		const revB = revGrid(5, SPR, 10); // 10..15
		const sigA = makeSignature(revA);
		const sigB = makeSignature(revB);
		expect(() => alignAndDiff(revA, sigA, revB, sigB, SPR)).toThrow(/overlap/);
	});

	it('throws when a rev/sig pair has mismatched lengths', () => {
		const revA = revGrid(5, SPR);
		const sigA = new Float32Array(revA.length - 1);
		const revB = revGrid(5, SPR);
		const sigB = makeSignature(revB);
		expect(() => alignAndDiff(revA, sigA, revB, sigB, SPR)).toThrow(/length/);
	});
});

describe('alignAndDiff on passes of different length', () => {
	it('differences only the overlapping range of a short and a long pass', () => {
		const revA = revGrid(10, SPR);            // [0, 10)
		const revB = revGrid(20, SPR, 4);         // [4, 24)
		const sigA = new Float32Array(revA.length).fill(3);
		const sigB = new Float32Array(revB.length).fill(1);
		const { rev, diff } = alignAndDiff(revA, sigA, revB, sigB, SPR);
		expect(rev[0]).toBeCloseTo(4, 5);
		expect(rev[rev.length - 1]).toBeLessThan(10);
		expect(rev.length).toBeGreaterThan(5 * SPR - 2);
		for (const d of diff) expect(d).toBeCloseTo(2, 5);
	});

	it('throws when the passes do not overlap', () => {
		expect(() => alignAndDiff(revGrid(2, SPR), new Float32Array(2 * SPR), revGrid(2, SPR, 5), new Float32Array(2 * SPR), SPR)).toThrow(/overlap/);
	});
});

describe('diffEnvelopes', () => {
	const env = (t0: number, t1: number, n: number, mid: (t: number) => number, half = 1): EnvelopeSeries => {
		const t = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
		return { t, min: t.map((x) => mid(x) - half), max: t.map((x) => mid(x) + half) };
	};

	it('is current minus reference, with mean and RMS, across different lengths and rates', () => {
		const cur = env(0, 10, 500, () => 12);
		const ref = env(2, 8, 90, () => 10, 3);   // other length, rate and envelope width
		const d = diffEnvelopes(cur, ref)!;
		expect(d.t[0]).toBeCloseTo(2, 3);
		expect(d.t[d.t.length - 1]).toBeLessThanOrEqual(8);
		expect(d.mean).toBeCloseTo(2, 4);
		expect(d.rms).toBeCloseTo(2, 4);
	});

	it('separates mean from RMS when the delta changes sign', () => {
		const cur = env(0, 10, 400, (t) => 10 + Math.sin(2 * Math.PI * t));
		const ref = env(0, 10, 400, () => 10);
		const d = diffEnvelopes(cur, ref)!;
		expect(Math.abs(d.mean)).toBeLessThan(0.05);
		expect(d.rms).toBeCloseTo(Math.SQRT1_2, 1);
	});

	it('returns null for missing, too-short or disjoint inputs', () => {
		const a = env(0, 5, 50, () => 1);
		expect(diffEnvelopes(null, a)).toBeNull();
		expect(diffEnvelopes(a, undefined)).toBeNull();
		expect(diffEnvelopes(a, { t: [1], min: [0], max: [0] })).toBeNull();
		expect(diffEnvelopes(a, env(6, 9, 30, () => 1))).toBeNull();
	});

	it('caps the output size on a long recording', () => {
		const a = env(0, 600, 60000, () => 1);
		expect(diffEnvelopes(a, a)!.t.length).toBeLessThanOrEqual(4001);
	});

	it('is restricted to a window, so lead-in/out outside the crop does not leak into the stats', () => {
		// Both cuts have junk outside 3..8 s (tool approaching / leaving); the cut itself differs by 2 N.
		const cur = env(0, 10, 1000, (t) => (t >= 3 && t <= 8 ? 12 : 500));
		const ref = env(0, 10, 1000, () => 10);
		const whole = diffEnvelopes(cur, ref)!;
		expect(whole.mean).toBeGreaterThan(100);
		const d = diffEnvelopes(cur, ref, { start: 3.1, end: 7.9 })!;
		expect(d.t[0]).toBeGreaterThanOrEqual(3.1 - 1e-3);
		expect(d.t[d.t.length - 1]).toBeLessThanOrEqual(7.9 + 1e-3);
		expect(d.mean).toBeCloseTo(2, 4);
		expect(d.rms).toBeCloseTo(2, 4);
	});

	it('returns null when the window misses the overlap', () => {
		const a = env(0, 10, 100, () => 1);
		expect(diffEnvelopes(a, a, { start: 20, end: 30 })).toBeNull();
		expect(diffEnvelopes(a, a, { start: 5, end: 5 })).toBeNull();
	});
});

describe('Difference windowing helpers', () => {
	it('cropWindowSec: a saved override wins over the auto-crop, in seconds', () => {
		expect(cropWindowSec({ sample_rate: 1000, cut_start_idx: 2000, cut_end_idx: 9000 })).toEqual({ start: 2, end: 9 });
		expect(cropWindowSec({ sample_rate: 1000, cut_start_idx: 2000, cut_end_idx: 9000, crop_start_idx_override: 3000, crop_end_idx_override: 8000 }))
			.toEqual({ start: 3, end: 8 });
	});

	it('cropWindowSec: null (unbounded) without a usable crop or rate', () => {
		expect(cropWindowSec(null)).toBeNull();
		expect(cropWindowSec({ cut_start_idx: 1, cut_end_idx: 5 })).toBeNull();
		expect(cropWindowSec({ sample_rate: 1000, cut_start_idx: 5, cut_end_idx: 5 })).toBeNull();
		expect(cropWindowSec({ sample_rate: 1000, cut_start_idx: null, cut_end_idx: null })).toBeNull();
	});

	it('intersectWindows: null is unbounded; disjoint windows come back empty', () => {
		expect(intersectWindows(null, undefined)).toBeNull();
		expect(intersectWindows({ start: 2, end: 9 }, null)).toEqual({ start: 2, end: 9 });
		expect(intersectWindows({ start: 2, end: 9 }, { start: 5, end: 20 })).toEqual({ start: 5, end: 9 });
		const none = intersectWindows({ start: 0, end: 3 }, { start: 5, end: 8 })!;
		expect(none.end).toBeLessThanOrEqual(none.start);
	});

	it('diffWindow: both crops, then the zoom when both ends are set', () => {
		const a = { start: 2, end: 9 }, b = { start: 4, end: 12 };
		expect(diffWindow(a, b, null, null)).toEqual({ start: 4, end: 9 });
		expect(diffWindow(a, b, 5, 7)).toEqual({ start: 5, end: 7 });
		expect(diffWindow(a, b, 6, null)).toEqual({ start: 4, end: 9 });   // a half-set zoom is ignored
		expect(diffWindow(null, null, null, null)).toBeNull();
		expect(diffWindow(null, b, 0, 100)).toEqual({ start: 4, end: 12 });
	});
});

describe('diffStats', () => {
	it('computes mean and RMS', () => {
		const s = diffStats(new Float32Array([1, -1, 3, -3]));
		expect(s.mean).toBeCloseTo(0);
		expect(s.rms).toBeCloseTo(Math.sqrt(5));
		expect(diffStats(new Float32Array(0))).toEqual({ mean: 0, rms: 0 });
	});
});
