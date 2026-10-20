import { describe, expect, it } from 'vitest';
import { defaultChain, type FilterChain } from './filterChain';
import { butterDb, FLOOR_DB, filterResponse, fmtHz, logFrequencies, meanRpm, notchDb, notchFrequencies, stopBands } from './filterResponse';

const NY = 12800;
const chainWith = (patch: (c: FilterChain) => void): FilterChain => { const c = defaultChain(); patch(c); return c; };

describe('butterDb', () => {
	it('is -3 dB at the cut-off for every order, low-pass and high-pass', () => {
		for (const order of [1, 2, 4, 8]) {
			expect(butterDb('lowpass', 2000, 2000, order, NY)).toBeCloseTo(-3.01, 1);
			expect(butterDb('highpass', 50, 50, order, NY)).toBeCloseTo(-3.01, 1);
		}
	});
	it('passes the pass band and rolls off steeply above the cut-off', () => {
		expect(butterDb('lowpass', 20, 2000, 4, NY)).toBeGreaterThan(-0.001);
		expect(butterDb('highpass', 5000, 50, 4, NY)).toBeGreaterThan(-0.001);
		// one decade above a 4th-order cut-off is close to -80 dB (the bilinear warp bends it a little)
		expect(butterDb('lowpass', 800, 80, 4, NY)).toBeLessThan(-75);
	});
	it('stays finite at Nyquist', () => {
		expect(Number.isFinite(butterDb('lowpass', NY, 2000, 4, NY))).toBe(true);
	});
});

describe('notchDb', () => {
	it('bottoms out at the notch frequency and is ~-3 dB at half the width (f0 / Q) either side', () => {
		const q = 30, f0 = 50;
		expect(notchDb(f0, f0, q, NY)).toBe(FLOOR_DB);
		expect(notchDb(f0 - f0 / q / 2, f0, q, NY)).toBeCloseTo(-3, 0);
		expect(notchDb(f0 + f0 / q / 2, f0, q, NY)).toBeCloseTo(-3, 0);
		expect(notchDb(f0 * 3, f0, q, NY)).toBeGreaterThan(-0.1);
		expect(notchDb(1, f0, q, NY)).toBeGreaterThan(-0.1);
	});
	it('is narrower for a higher Q', () => {
		expect(notchDb(52, 50, 60, NY)).toBeGreaterThan(notchDb(52, 50, 10, NY));
	});
});

describe('filterResponse', () => {
	const f = logFrequencies(10, NY, 400);
	it('is flat at 0 dB with no stage on', () => {
		const r = filterResponse(defaultChain(), f, { nyquist: NY, rpm: 1200 });
		expect(r.stages).toEqual([]);
		expect(Math.max(...r.combined)).toBe(0);
		expect(Math.min(...r.combined)).toBe(0);
	});
	it('sums the stages (dB add) into the combined curve', () => {
		const c = chainWith((x) => { x.highpass = { on: true, cutoff_hz: 50, order: 4 }; x.lowpass = { on: true, cutoff_hz: 2000, order: 4 }; });
		const r = filterResponse(c, [50, 2000, 500], { nyquist: NY });
		expect(r.stages.map((s) => s.id)).toEqual(['highpass', 'lowpass']);
		expect(r.combined[0]).toBeCloseTo(r.stages[0].db[0] + r.stages[1].db[0], 6);
		expect(r.stages[0].db[0]).toBeCloseTo(-3.01, 1);
		expect(r.stages[1].db[1]).toBeCloseTo(-3.01, 1);
		expect(r.combined[2]).toBeGreaterThan(-0.1);
	});
	it('puts a notch at each harmonic of the rotation frequency, and none without a speed', () => {
		const c = chainWith((x) => { x.notch = { on: true, harmonics: [1, 2, 3], q: 30 }; });
		const withRpm = filterResponse(c, [20, 40, 60, 50], { nyquist: NY, rpm: 1200 });   // 20 Hz fundamental
		expect(withRpm.combined.slice(0, 3)).toEqual([FLOOR_DB, FLOOR_DB, FLOOR_DB]);
		expect(withRpm.combined[3]).toBeGreaterThan(-3);
		const none = filterResponse(c, [20], { nyquist: NY, rpm: 0 });
		expect(none.stages).toEqual([]);
		expect(none.combined[0]).toBe(0);
	});
	it('doubles the dB figures for a zero-phase (two pass) run', () => {
		const c = chainWith((x) => { x.lowpass = { on: true, cutoff_hz: 2000, order: 4 }; });
		expect(filterResponse(c, [2000], { nyquist: NY, passes: 2 }).combined[0]).toBeCloseTo(-6.02, 1);
	});
	it('skips a stage whose cut-off is not below Nyquist (the service skips it too)', () => {
		const c = chainWith((x) => { x.lowpass = { on: true, cutoff_hz: NY, order: 4 }; });
		expect(filterResponse(c, [1000], { nyquist: NY }).stages).toEqual([]);
	});
	it('draws a highpass-mode detrend as a 2nd-order high-pass and ignores DC removal', () => {
		const hp = chainWith((x) => { x.detrend = { on: true, mode: 'highpass', cutoff_hz: 5 }; });
		expect(filterResponse(hp, [5], { nyquist: NY }).combined[0]).toBeCloseTo(-3.01, 1);
		const dc = chainWith((x) => { x.detrend = { on: true, mode: 'dc', cutoff_hz: 5 }; });
		expect(filterResponse(dc, [5], { nyquist: NY }).stages).toEqual([]);
	});
});

describe('stopBands and helpers', () => {
	it('returns a band per active stage and one per notch harmonic', () => {
		const c = chainWith((x) => {
			x.highpass = { on: true, cutoff_hz: 50, order: 4 };
			x.lowpass = { on: true, cutoff_hz: 2000, order: 4 };
			x.notch = { on: true, harmonics: [1, 2], q: 20 };
		});
		const b = stopBands(c, { nyquist: NY, rpm: 3000 });   // 50 Hz fundamental
		expect(b.map((x) => x.label)).toEqual(['High-pass 50 Hz', 'Low-pass 2 kHz', 'Notch 50 Hz', 'Notch 100 Hz']);
		expect(b[0]).toMatchObject({ f0: 0, f1: 50 });
		expect(b[1]).toMatchObject({ f0: 2000, f1: NY });
		expect(b[2].f0).toBeCloseTo(48.75);
		expect(b[2].f1).toBeCloseTo(51.25);
	});
	it('is empty for no chain or an idle one', () => {
		expect(stopBands(null, { nyquist: NY })).toEqual([]);
		expect(stopBands(defaultChain(), { nyquist: NY, rpm: 1200 })).toEqual([]);
	});
	it('lists notch frequencies below Nyquist only', () => {
		const c = chainWith((x) => { x.notch = { on: true, harmonics: [1, 1000], q: 30 }; });
		expect(notchFrequencies(c, 1200, NY)).toEqual([20]);
	});
	it('takes the mean of the rpm channel, as the service does', () => {
		expect(meanRpm(new Float32Array([1000, 1200, 1400]))).toBeCloseTo(1200);
		expect(meanRpm([])).toBe(0);
		expect(meanRpm(null)).toBe(0);
	});
	it('formats frequencies', () => {
		expect([50, 2000, 3200, 12800, 0.5].map((f) => fmtHz(f))).toEqual(['50 Hz', '2 kHz', '3.2 kHz', '12.8 kHz', '0.5 Hz']);
	});
	it('spaces frequencies logarithmically including both ends', () => {
		expect(logFrequencies(10, 10000, 4).map((x) => Math.round(x))).toEqual([10, 100, 1000, 10000]);
	});
});
