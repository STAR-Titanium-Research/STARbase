import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPlaybackEngine } from './engine';
import { RecordClient } from '../liveClient';
import type { Cache } from '@d1/force-plotting';

// A synthetic cut: 10 s at 100 Hz, constant 600 rpm (=10 rev/s), cut starts at t=0.
function makeCache(n = 1000, fs = 100): Cache {
	const t = new Float32Array(n), Fx = new Float32Array(n), Fy = new Float32Array(n);
	const Fz = new Float32Array(n), rpm = new Float32Array(n), revs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		t[i] = i / fs;
		Fx[i] = i; Fy[i] = -i; Fz[i] = Math.sin(i / 10) * 100;
		rpm[i] = 600; revs[i] = (600 / 60) * (i / fs);
	}
	return { N: n, Fs: fs, feed: 0.1, diam: 80, csSec: 0, ceSec: (n - 1) / fs, t, Fx, Fy, Fz, rpm, revs };
}

// Fs=1000 makes binSize = round(1000/200) = 5, so envelope bins span several samples — the case
// the Fs=100 fixture above cannot exercise (there binSize == 1 and every bin is one sample).
function makeDenseCache(n = 10000, fs = 1000): Cache {
	const t = new Float32Array(n), Fx = new Float32Array(n), Fy = new Float32Array(n);
	const Fz = new Float32Array(n), rpm = new Float32Array(n), revs = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		t[i] = i / fs;
		// Peak deliberately in the MIDDLE, not at the end: a monotonic ramp would let a
		// last-sample-only peak scan look correct by accident.
		Fx[i] = i === 1234 ? 9999 : Math.sin(i / 7) * 10;
		Fy[i] = -Fx[i];
		Fz[i] = i === 2345 ? -8888 : Math.cos(i / 11) * 10;
		rpm[i] = 600; revs[i] = (600 / 60) * (i / fs);
	}
	return { N: n, Fs: fs, feed: 0.1, diam: 80, csSec: 0, ceSec: (n - 1) / fs, t, Fx, Fy, Fz, rpm, revs };
}

// A MATLAB-ingested cache: only the cut window is stored, so t[0] is an absolute offset into the
// original signal (process_force.m caches `cutstart:cutend`). 5 s at 100 Hz starting at t=15 s.
function makeOffsetCache(t0 = 15, n = 500, fs = 100): Cache {
	const c = makeCache(n, fs);
	for (let i = 0; i < n; i++) c.t[i] = t0 + i / fs;
	return { ...c, csSec: t0, ceSec: t0 + (n - 1) / fs };
}

// Deterministic clock + manual frame pump, so no rAF and no wall-clock flake.
function harness() {
	let clock = 0;
	const frames: (() => void)[] = [];
	const client = new RecordClient();
	const engine = createPlaybackEngine(client, {
		baseUrl: 'http://x',
		now: () => clock,
		schedule: (cb) => { frames.push(cb); return frames.length; },
		cancel: () => {},
	});
	const tick = (ms: number) => { clock += ms; const f = frames.shift(); f?.(); };
	return { client, engine, tick, get clock() { return clock; } };
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ fs: 100, f: [], spectra: {} }) }) as any)); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('playback engine', () => {
	it('loads a cache and reports its duration without playing', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		expect(h.engine.state.loaded).toBe(true);
		expect(h.engine.state.duration).toBeCloseTo(9.99, 2);
		expect(h.engine.state.playing).toBe(false);
		expect(h.engine.state.tSec).toBe(0);
	});

	it('advances the playhead by elapsed x speed', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.play();
		h.tick(1000);
		expect(h.engine.state.tSec).toBeCloseTo(1.0, 2);
		h.engine.setSpeed(2);
		h.tick(1000);
		expect(h.engine.state.tSec).toBeCloseTo(3.0, 2);
	});

	it('pause freezes the playhead across elapsed time', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.play(); h.tick(1000);
		h.engine.pause();
		const at = h.engine.state.tSec;
		h.tick(5000);
		expect(h.engine.state.tSec).toBe(at);
	});

	it('SEEK INVARIANT: buffers after seek(t) equal buffers after playing to t', () => {
		const played = harness();
		played.engine.load(makeCache(), { ppr: 1, stride: 1 });
		played.engine.play();
		for (let i = 0; i < 5; i++) played.tick(1000);   // play through to t=5
		played.engine.pause();

		const sought = harness();
		sought.engine.load(makeCache(), { ppr: 1, stride: 1 });
		sought.engine.seek(played.engine.state.tSec);

		expect(sought.client.frm.count).toBe(played.client.frm.count);
		expect(sought.client.frm.xy.slice(0, played.client.frm.count * 2))
			.toEqual(played.client.frm.xy.slice(0, played.client.frm.count * 2));
		expect(sought.client.trace.t).toEqual(played.client.trace.t);
		expect(sought.client.trace.fz).toEqual(played.client.trace.fz);
	});

	it('seeking backwards truncates rather than appending', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.seek(8);
		const far = h.client.frm.count;
		h.engine.seek(2);
		expect(h.client.frm.count).toBeLessThan(far);
		expect(h.engine.state.tSec).toBe(2);
	});

	it('clamps seeks to [0, duration]', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.seek(-5);
		expect(h.engine.state.tSec).toBe(0);
		h.engine.seek(9999);
		expect(h.engine.state.tSec).toBeCloseTo(h.engine.state.duration, 5);
	});

	describe('a cache that does not start at t=0 (#110)', () => {
		it('starts the playhead at the first sample and reports the cut length', () => {
			const h = harness();
			h.engine.load(makeOffsetCache(), { ppr: 1, stride: 1 });
			expect(h.engine.state.t0).toBeCloseTo(15, 5);
			expect(h.engine.state.tSec).toBeCloseTo(15, 5);
			expect(h.engine.state.duration).toBeCloseTo(4.99, 2);
		});

		it('plots from the very first second of playback', () => {
			// Regression: the playhead started at 0, and idxOfTime() maps every t < t[0] to index 0, so
			// the first 15 s of "playback" appended nothing at all.
			const h = harness();
			h.engine.load(makeOffsetCache(), { ppr: 1, stride: 1 });
			h.engine.play();
			h.tick(1000);
			expect(h.engine.state.tSec).toBeCloseTo(16, 2);
			expect(h.client.trace.t.length).toBeGreaterThan(50);
			expect(h.client.frm.count).toBeGreaterThan(50);
		});

		it('clamps seeks to [t0, end] and replays from t0 after the end', () => {
			const h = harness();
			h.engine.load(makeOffsetCache(), { ppr: 1, stride: 1 });
			h.engine.seek(3);
			expect(h.engine.state.tSec).toBeCloseTo(15, 5);
			h.engine.seek(999);
			expect(h.engine.state.tSec).toBeCloseTo(19.99, 2);
			// At the end, Play restarts from the first sample, not from 0.
			h.engine.play();
			expect(h.engine.state.tSec).toBeCloseTo(15, 5);
			expect(h.engine.state.playing).toBe(true);
		});

		it('draws every sample once played to the end', () => {
			const h = harness();
			h.engine.load(makeOffsetCache(), { ppr: 1, stride: 1 });
			h.engine.play();
			for (let i = 0; i < 10; i++) h.tick(1000);
			expect(h.engine.state.playing).toBe(false);
			expect(h.client.status.nTotal).toBe(500);
		});
	});

	it('computes timeline markers at load and clears them on a failed load (#104)', () => {
		const h = harness();
		h.engine.load(makeDenseCache(), { ppr: 1, stride: 1, cropStartSec: 2 });
		const kinds = h.engine.state.markers.map((m) => m.kind);
		expect(kinds).toContain('crop');
		expect(h.engine.state.markers.find((m) => m.axis === 'Fx')!.t).toBeCloseTo(1.234, 3);
		h.engine.load({ ...makeCache(1), N: 1 } as Cache, { ppr: 1, stride: 1 });
		expect(h.engine.state.markers).toEqual([]);
	});

	it('seeking to a peak marker includes the peak sample, so the shown peak is the real one (#104)', () => {
		const h = harness();
		h.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		for (const [axis, want] of [['Fx', 9999], ['Fz', 8888]] as const) {
			const m = h.engine.state.markers.find((x) => x.axis === axis)!;
			h.engine.seek(m.seekT ?? m.t);
			expect(h.client.status.peaks[axis]).toBeCloseTo(want, 0);
			h.engine.seek(0);
			h.engine.seek(m.t);                 // the peak sample's own time stops one sample short
			expect(h.client.status.peaks[axis]).toBeLessThan(want - 1);
		}
	});

	it('stops at the end and reports not playing', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.play();
		for (let i = 0; i < 15; i++) h.tick(1000);
		expect(h.engine.state.playing).toBe(false);
		expect(h.engine.state.tSec).toBeCloseTo(h.engine.state.duration, 5);
	});

	it('trims the trace to the retained history, like the live path', () => {
		const h = harness();
		h.client.retainFloorSec = 2;
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.seek(9);
		const t = h.client.trace.t;
		expect(t[0]).toBeGreaterThanOrEqual(9 - 2 - 0.5);
	});

	describe('window changes (#105/#76)', () => {
		it('rebuilds already-trimmed history when a view asks for a wider window', () => {
			const h = harness();
			h.client.retainFloorSec = 2;
			h.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			h.engine.seek(9);
			expect(h.client.trace.t[0]).toBeGreaterThan(6.5);
			// No playback and no seek: the wider window must apply while paused.
			h.client.setWindowDemand('panel', 6);
			expect(h.client.trace.t[0]).toBeLessThan(3.1);
			expect(h.client.trace.t[0]).toBeGreaterThanOrEqual(3 - 0.01);
		});

		it('a rebuilt trace equals one played through with that window all along', () => {
			const played = harness();
			played.client.retainFloorSec = 6;
			played.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			played.engine.play();
			for (let i = 0; i < 25; i++) played.tick(333);
			played.engine.pause();

			const widened = harness();
			widened.client.retainFloorSec = 2;
			widened.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			widened.engine.play();
			for (let i = 0; i < 25; i++) widened.tick(333);
			widened.engine.pause();
			widened.client.setWindowDemand('panel', 6);

			expect(widened.client.trace.t).toEqual(played.client.trace.t);
			expect(widened.client.trace.fz).toEqual(played.client.trace.fz);
			expect(widened.client.trace.sub.Fx1).toEqual(played.client.trace.sub.Fx1);
		});

		it('a long forward seek builds the same trace as playing there', () => {
			const played = harness();
			played.client.retainFloorSec = 2;
			played.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			played.engine.play();
			for (let i = 0; i < 25; i++) played.tick(333);
			played.engine.pause();

			const sought = harness();
			sought.client.retainFloorSec = 2;
			sought.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			sought.engine.seek(1);
			sought.engine.seek(played.engine.state.tSec);
			expect(sought.client.trace.t).toEqual(played.client.trace.t);
			expect(sought.client.trace.fx).toEqual(played.client.trace.fx);
		});

		it('withdrawing a demand does not throw away history needed by the floor', () => {
			const h = harness();
			h.client.retainFloorSec = 2;
			h.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			h.client.setWindowDemand('panel', 5);
			h.engine.seek(9);
			expect(h.client.retainSec).toBe(5);
			h.client.setWindowDemand('panel', null);
			expect(h.client.retainSec).toBe(2);
		});
	});

	it('reports running peaks and rpm from the cache, not re-derived', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.seek(5);
		expect(h.client.status.rpm).toBeCloseTo(600, 5);
		expect(h.client.status.peaks.Fx).toBeGreaterThan(0);
		expect(h.client.status.tSec).toBeCloseTo(5, 5);
	});

	describe('Tacho channel in replay (#108)', () => {
		it('fills Tacho with the cache rpm envelope, not a flat zero line', () => {
			const h = harness();
			const c = makeDenseCache();
			for (let i = 0; i < c.N; i++) c.rpm[i] = 600 + (i % 50);   // varies inside each 5-sample bin
			h.engine.load(c, { ppr: 1, stride: 1 });
			h.engine.seek(3);
			const tacho = h.client.trace.sub.Tacho;
			expect(h.client.status.tachoKind).toBe('rpm');
			expect(tacho.length).toBe(h.client.trace.t.length);
			expect(tacho.length).toBeGreaterThan(0);
			for (const [lo, hi] of tacho) { expect(lo).toBeGreaterThanOrEqual(600); expect(hi).toBeLessThanOrEqual(649); expect(hi).toBeGreaterThanOrEqual(lo); }
			expect(tacho.some(([lo, hi]) => hi > lo)).toBe(true);   // the bin spread is kept
		});
		it('leaves Tacho EMPTY, and says none, when the cache has no measured rpm', () => {
			const h = harness();
			const c = makeCache();
			c.rpm.fill(0);
			h.engine.load(c, { ppr: 1, stride: 1 });
			h.engine.seek(5);
			expect(h.client.status.tachoKind).toBe('none');
			expect(h.client.trace.t.length).toBeGreaterThan(0);
			expect(h.client.trace.sub.Tacho).toEqual([]);
		});
		it('SEEK INVARIANT holds for the Tacho bins too', () => {
			const a = harness(), b = harness();
			const c = makeDenseCache();
			for (let i = 0; i < c.N; i++) c.rpm[i] = 600 + (i % 37);
			a.engine.load(c, { ppr: 1, stride: 1 });
			b.engine.load(c, { ppr: 1, stride: 1 });
			a.engine.seek(4.2);
			b.engine.play();
			for (let k = 0; k < 42; k++) b.tick(100);
			b.engine.seek(4.2);
			expect(b.client.trace.sub.Tacho).toEqual(a.client.trace.sub.Tacho);
		});
		it('returns the client to the live default once the replay is reset', () => {
			const h = harness();
			const c = makeCache();
			c.rpm.fill(0);
			h.engine.load(c, { ppr: 1, stride: 1 });
			expect(h.client.status.tachoKind).toBe('none');
			h.client.reset();
			expect(h.client.status.tachoKind).toBe('signal');
		});
	});

	it('rejects a degenerate cache instead of dividing by zero', () => {
		const h = harness();
		const bad = { ...makeCache(1), N: 1 } as Cache;
		h.engine.load(bad, { ppr: 1, stride: 1 });
		expect(h.engine.state.loaded).toBe(false);
		expect(h.engine.state.error).toBeTruthy();
	});

	it('makes no network call other than the spectrum request', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.engine.seek(5);
		for (const call of (globalThis.fetch as any).mock.calls) {
			expect(String(call[0])).toContain('/dsp/spectrum');
		}
	});
	it('accumulates peaks over the whole range, not just the last sample', () => {
		// Regression: the peak scan looped `for (i = target-1; i < target; i++)` — exactly one
		// sample — so every peak except the newest was ignored.
		const h = harness();
		h.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		h.engine.seek(5);   // well past both spikes (i=1234 and i=2345, i.e. t=1.234 / 2.345)
		expect(h.client.status.peaks.Fx).toBeCloseTo(9999, 0);
		expect(h.client.status.peaks.Fz).toBeCloseTo(8888, 0);
	});

	it('reports the same peaks whether played through or sought to', () => {
		const played = harness();
		played.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		played.engine.play();
		for (let i = 0; i < 15; i++) played.tick(333);
		played.engine.pause();

		const sought = harness();
		sought.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		sought.engine.seek(played.engine.state.tSec);

		expect(sought.client.status.peaks.Fx).toBeCloseTo(played.client.status.peaks.Fx, 3);
		expect(sought.client.status.peaks.Fz).toBeCloseTo(played.client.status.peaks.Fz, 3);
	});

	it('SEEK INVARIANT holds when bins span several samples (binSize > 1)', () => {
		// The Fs=100 fixture gives binSize == 1, which cannot catch bins being split at frame
		// boundaries. At Fs=1000 binSize is 5, and ticks of 333 ms land mid-bin.
		const played = harness();
		played.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		played.engine.play();
		for (let i = 0; i < 15; i++) played.tick(333);
		played.engine.pause();

		const sought = harness();
		sought.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		sought.engine.seek(played.engine.state.tSec);

		expect(sought.client.trace.t).toEqual(played.client.trace.t);
		expect(sought.client.trace.fz).toEqual(played.client.trace.fz);
		expect(sought.client.frm.count).toBe(played.client.frm.count);
	});

	it('drops spectrogram history that is ahead of the playhead after seeking back', () => {
		// fftHistory feeds the spectrogram/waterfall. Without this, scrubbing back keeps showing
		// spectra from later in the cut.
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		h.client.fftHistory.push({ t: 1, spectra: {} }, { t: 8, spectra: {} }, { t: 9, spectra: {} });
		h.engine.seek(2);
		expect(h.client.fftHistory.every((e) => e.t <= 2)).toBe(true);
	});

	it('clears a stale spectrum error once a later request succeeds', async () => {
		const f = vi.fn()
			.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'down' } as any)
			.mockResolvedValue({ ok: true, status: 200, json: async () => ({ fs: 100, f: [1, 2], spectra: { Fz: [1, 2] } }) } as any);
		vi.stubGlobal('fetch', f);
		const h = harness();
		// The dense fixture, not the sparse one: at Fs=100 the trailing window is only 100 samples,
		// under the 256-sample floor, so no spectrum request is ever issued and this would pass
		// vacuously.
		h.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
		h.engine.seek(5);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.engine.state.error).toBeTruthy();
		h.engine.seek(6);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.engine.state.error).toBeNull();
	});
	it('regression: a non-1 ppr changes how fast the spiral winds in, not just a cosmetic scale', () => {
		// pickReplayCut fetches the cut's real pulses-per-rev from Directus and passes it here.
		// Before that fix it silently used cfg.ppr (the recording form's leftover value, usually
		// 1) instead — on a cut whose real ppr was higher, the spiral wound in too slowly and
		// visibly stopped short of the centre ("a donut that never reaches the middle") instead of
		// reaching it, because r = revs / ppr grows slower the larger ppr is.
		const wrong = harness();
		wrong.engine.load(makeCache(), { ppr: 1, stride: 1 });   // as if ppr were left at 1
		wrong.engine.seek(wrong.engine.state.duration);
		const rWrong = Math.hypot(wrong.client.frm.xy[(wrong.client.frm.count - 1) * 2], wrong.client.frm.xy[(wrong.client.frm.count - 1) * 2 + 1]);

		const right = harness();
		right.engine.load(makeCache(), { ppr: 4, stride: 1 });   // the cut's real ppr
		right.engine.seek(right.engine.state.duration);
		const rRight = Math.hypot(right.client.frm.xy[(right.client.frm.count - 1) * 2], right.client.frm.xy[(right.client.frm.count - 1) * 2 + 1]);

		// Same cache, same duration, different ppr: the two runs must NOT land at the same radius.
		expect(Math.abs(rWrong - rRight)).toBeGreaterThan(1);
	});

	it('stops the spiral at the given inner radius instead of always reaching the centre', () => {
		const h = harness();
		h.engine.load(makeCache(), { ppr: 1, innerDiam: 40, stride: 1 });   // inner radius 20mm
		h.engine.seek(h.engine.state.duration);
		let minR = Infinity;
		for (let i = 0; i < h.client.frm.count; i++) {
			const r = Math.hypot(h.client.frm.xy[i * 2], h.client.frm.xy[i * 2 + 1]);
			if (r < minR) minR = r;
		}
		expect(minR).toBeGreaterThanOrEqual(20 - 0.5);
	});

	it('sets frm.cLo/cHi from the whole cut at load, matching the finished-cut colour scale', () => {
		// Regression: LiveFrm.vue previously coloured points against a RUNNING max as they arrived,
		// so a point drawn early in playback locked in a colour computed against a narrower range
		// than the cut's real one and was never recoloured once the true range was known. Playback
		// has the whole cache up front, so it can (and now does) set the same percentile-based
		// bounds the finished-cut view uses, once, before any point is drawn.
		const h = harness();
		expect(h.client.frm.cLo).toBeUndefined();
		h.engine.load(makeCache(), { ppr: 1, stride: 1 });
		expect(h.client.frm.cLo).toBeDefined();
		expect(h.client.frm.cHi).toBeDefined();
		expect(h.client.frm.cHi!).toBeGreaterThan(h.client.frm.cLo!);
	});

	it('colours FRM points from the requested axis, not a hardcoded one', () => {
		// makeCache sets Fx[i] = i (monotonic) and Fz[i] = a bounded sine. client.frm.cx/cy/cz now
		// always carry all three axis forces (so the colour axis can switch instantly at render time
		// without a data rebuild) — what `axis` at load() actually controls is the percentile colour
		// scale (cLo/cHi), which must reflect the requested axis's own range, not a hardcoded one.
		const c = makeCache();
		const hFx = harness();
		hFx.engine.load(c, { ppr: 1, stride: 1, axis: 'Fx' });
		hFx.engine.seek(hFx.engine.state.duration);
		const hFz = harness();
		hFz.engine.load(c, { ppr: 1, stride: 1, axis: 'Fz' });
		hFz.engine.seek(hFz.engine.state.duration);
		// Fx grows unbounded with the cut; Fz stays inside [-100, 100]. If colouring still fell back
		// to a hardcoded axis, both scales would come out identical.
		expect(hFx.client.frm.cHi!).toBeGreaterThan(200);
		expect(hFz.client.frm.cHi!).toBeLessThan(200);
	});
	it('setAxis recolours already-drawn points, not just future ones', () => {
		// Regression: colorAxis was frozen at load() with nothing watching a later change, so
		// FrmPanel's Fx/Fy/Fz toggle silently did nothing once a cut was already loaded and points
		// had been drawn. client.frm.cx/cy/cz never change (all three are always stored up front) —
		// what setAxis must update is the colour SCALE (cLo/cHi), which LiveFrm.vue then re-reads to
		// recolour the whole accumulated spiral from the already-resident cx/cy/cz.
		const h = harness();
		h.engine.load(makeDenseCache(), { ppr: 1, stride: 1, axis: 'Fz' });
		h.engine.seek(5);
		const beforeCLo = h.client.frm.cLo, beforeCHi = h.client.frm.cHi;

		h.engine.setAxis('Fx');

		// makeDenseCache's Fx and Fz series are unrelated (Fx = i, Fz = a bounded sine), so a genuine
		// recolour changes the axis's own cLo/cHi.
		expect(h.client.frm.cLo === beforeCLo && h.client.frm.cHi === beforeCHi).toBe(false);
	});

	// #63/#66/#50. The workspace (and therefore this engine) is an app-lifetime module singleton
	// since #25, but RecordPage still tore the engine down in onBeforeUnmount -- so the FIRST
	// navigation away from Record permanently killed replay for the rest of the session: the cut
	// cache was nulled while state.loaded stayed true (transport bar looked alive, every control
	// silently no-opped -> #63/#66) and the spectrum client latched disposed with no way back, so
	// FFT/Power/Spectrogram/Waterfall never rendered again -> #50. Navigation must SUSPEND, not
	// destroy.
	describe('suspend (navigating away from the Record page)', () => {
		it('stops the frame loop without discarding the loaded cut', () => {
			const h = harness();
			h.engine.load(makeCache(), { ppr: 1, stride: 1 });
			h.engine.play();
			h.tick(100);
			const tAtSuspend = h.engine.state.tSec;
			expect(tAtSuspend).toBeGreaterThan(0);

			h.engine.suspend();

			expect(h.engine.state.playing).toBe(false);
			// The cut itself must survive -- this is what #63/#66 lost.
			expect(h.engine.state.loaded).toBe(true);
			expect(h.engine.state.duration).toBeCloseTo(9.99, 2);
			expect(h.engine.state.tSec).toBeCloseTo(tAtSuspend, 5);
		});

		it('still seeks and still requests spectra after being suspended and resumed', async () => {
			// Dense fixture on purpose: the spectrum window is FFT_WINDOW_SEC (1 s) wide and is only
			// sent once it holds >= 256 samples, so the 100 Hz makeCache() never requests one at all.
			const h = harness();
			h.engine.load(makeDenseCache(), { ppr: 1, stride: 1 });
			h.engine.play();
			h.tick(100);

			h.engine.suspend();              // leave the Record page
			(globalThis.fetch as any).mockClear();

			// Come back and scrub: a commit-seek force-requests a spectrum, so a live spectrum
			// client must still issue the /dsp/spectrum call. A disposed one silently drops it.
			h.engine.seek(5, { commit: true });
			await new Promise((r) => setTimeout(r, 0));

			expect(h.engine.state.tSec).toBeCloseTo(5, 5);
			const calls = (globalThis.fetch as any).mock.calls as any[][];
			expect(calls.some((c) => String(c[0]).includes('/dsp/spectrum'))).toBe(true);
		});

		it("leaves a live recording's state alone when nothing is playing", () => {
			// Leaving the Record page mid-cut suspends playback. That must not reset the live cut to
			// 'idle', or the page can't adopt the server's 'done' when the operator comes back.
			const h = harness();
			h.client.status.state = 'recording';
			h.engine.suspend();
			expect(h.client.status.state).toBe('recording');
		});

		it('returns to idle when suspended mid-playback', () => {
			const h = harness();
			h.engine.load(makeCache(), { ppr: 1, stride: 1 });
			h.engine.play();
			expect(h.client.status.state).toBe('recording');
			h.engine.suspend();
			expect(h.client.status.state).toBe('idle');
		});

		it('can play again after a suspend, advancing the playhead', () => {
			const h = harness();
			h.engine.load(makeCache(), { ppr: 1, stride: 1 });
			h.engine.suspend();

			h.engine.play();
			const before = h.engine.state.tSec;
			h.tick(100);

			expect(h.engine.state.playing).toBe(true);
			expect(h.engine.state.tSec).toBeGreaterThan(before);
		});
	});
});
