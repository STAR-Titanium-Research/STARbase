// Correctness gate for the Phase-5 GPU rewrite: computeSpiralVertexJS (the shader's exact JS
// mirror) must reproduce buildPath's buildTurningSpiral output byte-for-byte-ish (float
// tolerance only) at every crop window this test tries, INCLUDING a narrowed one — that's the
// case a naive per-vertex discard could get wrong if the crop-start-anchored phase (revsCs/tCs)
// weren't recomputed per window. See frmCloudShader.ts's top comment for the monotonicity/
// contiguous-prefix assumptions this relies on (checked against real caches before writing this).
import { describe, expect, it } from 'vitest';
import { buildPath, type TurningSpiralParams } from './path';
import { idxOfTime, type Cache } from './liveCache';
import {
	buildStaticAttributes, computeSpiralVertexJS, phase0Samples, spiralPlaceInto, spiralPositionInto, spiralRadiusInto, spiralUniformValues,
	type SpiralPos, type SpiralUniformParams,
} from './frmCloudShader';

function makeCache(): Cache {
	const N = 2000;
	const t = Float32Array.from({ length: N }, (_, i) => i * 0.01);
	// A realistic non-uniform-but-monotonic revs curve (spindle ramps up then holds), never
	// decreasing — matches what the real-cache probe found (see frmCloudShader.ts).
	const revs = Float32Array.from({ length: N }, (_, i) => {
		const rampSamples = 200;
		return i < rampSamples ? 0.02 * (i * i) / rampSamples : 0.02 * rampSamples + 0.6 * (i - rampSamples);
	});
	const mk = (f: (i: number) => number) => Float32Array.from({ length: N }, (_, i) => f(i));
	return {
		N, Fs: 100, feed: 0.05, diam: 80, csSec: 0, ceSec: (N - 1) * 0.01,
		t, revs,
		Fx: mk((i) => Math.sin(i * 0.05) * 30), Fy: mk((i) => Math.cos(i * 0.05) * 30),
		Fz: mk((i) => Math.sin(i * 0.08) * 50 + 10), rpm: mk(() => 1200),
	};
}

const cache = makeCache();

function checkWindow(
	pathParams: TurningSpiralParams, cropStartSec: number, cropEndSec: number, label: string,
) {
	const path = buildPath(cache, pathParams, { cropStartSec, cropEndSec, stride: 1 });
	expect(path, `${label}: expected a non-null path`).not.toBeNull();
	if (!path) return;
	const cs = idxOfTime(cache.t, cropStartSec);
	const uParams: SpiralUniformParams = {
		feed: pathParams.feed, diam: pathParams.diam, innerDiam: pathParams.innerDiam,
		speedMode: pathParams.speedMode, rpm: pathParams.rpm, vc: pathParams.vc,
		timeScale: pathParams.timeScale, ppr: pathParams.ppr,
		tCs: cache.t[cs], revsCs: cache.revs[cs],
	};
	// Every point buildPath actually emitted must be visible in the shader mirror, at the same
	// (x,y), within float tolerance.
	for (let k = 0; k < path.count; k++) {
		const i = path.idx[k];
		const v = computeSpiralVertexJS(cache.t[i], cache.revs[i], uParams, cropStartSec, cropEndSec);
		expect(v.visible, `${label} @k=${k} (i=${i}) should be visible`).toBe(true);
		expect(v.x).toBeCloseTo(path.pos[k * 3], 4);
		expect(v.y).toBeCloseTo(path.pos[k * 3 + 1], 4);
	}
	// The sample immediately after where buildPath stopped (whether by cropEnd or the
	// inner-diameter break) must be invisible in the shader mirror — confirms the discard
	// boundary lines up, not just the retained points.
	const lastEmittedIdx = path.idx[path.count - 1];
	if (lastEmittedIdx + 1 < cache.N) {
		const i = lastEmittedIdx + 1;
		const v = computeSpiralVertexJS(cache.t[i], cache.revs[i], uParams, cropStartSec, cropEndSec);
		if (cache.t[i] > cropEndSec) expect(v.visible, `${label}: past cropEnd should be invisible`).toBe(false);
		// (if it stopped on the inner-diameter break instead, this next sample's rho may still
		// legitimately be >= innerR by a hair depending on cache shape — only assert the
		// unambiguous cropEnd case here; the inner-diameter boundary is covered by the
		// donut-cut case below via an explicit rho check instead.)
	}
}

describe('frmCloudShader: computeSpiralVertexJS matches buildTurningSpiral', () => {
	const base: TurningSpiralParams = {
		kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
		speedMode: 'measured', rpm: 1200, vc: 0, timeScale: 1, ppr: 1,
	};

	it('full window, measured mode', () => checkWindow(base, 0, 1e9, 'full-measured'));
	it('narrowed window (crop start dragged inward)', () => checkWindow(base, 5, 12, 'narrowed'));
	it('narrowed-to-30% window near the end of the cut', () => checkWindow(base, 15, 19.99, 'narrow-30pct'));
	it('rpm mode, narrowed window', () =>
		checkWindow({ ...base, speedMode: 'rpm', rpm: 900 }, 3, 10, 'rpm-narrowed'));
	it('vc mode, narrowed window', () =>
		checkWindow({ ...base, speedMode: 'vc', vc: 120 }, 3, 10, 'vc-narrowed'));
	it('donut cut (inner diameter stops the spiral early)', () => {
		const donut = { ...base, diam: 80, innerDiam: 40 };
		checkWindow(donut, 0, 1e9, 'donut-full');
		// explicit inner-diameter boundary check: the first sample past where buildPath stopped
		// must have rho < innerR in the shader mirror too (not just "invisible for some reason").
		const path = buildPath(cache, donut, { cropStartSec: 0, cropEndSec: 1e9, stride: 1 });
		const lastIdx = path!.idx[path!.count - 1];
		if (lastIdx + 1 < cache.N) {
			const uParams: SpiralUniformParams = {
				feed: donut.feed, diam: donut.diam, innerDiam: donut.innerDiam, speedMode: donut.speedMode,
				rpm: donut.rpm, vc: donut.vc, timeScale: donut.timeScale, ppr: donut.ppr,
				tCs: cache.t[0], revsCs: cache.revs[0],
			};
			const v = computeSpiralVertexJS(cache.t[lastIdx + 1], cache.revs[lastIdx + 1], uParams, 0, 1e9);
			expect(v.rho).toBeLessThan(20);   // innerR = innerDiam/2 = 20
		}
	});
	it('narrowed window with a non-zero crop start still anchors r=0 at the new start (rho=rho0)', () => {
		const path = buildPath(cache, base, { cropStartSec: 5, cropEndSec: 1e9, stride: 1 });
		expect(path).not.toBeNull();
		// first emitted point is exactly at the crop-start sample -> r=0 -> rho=rho0=40
		expect(Math.hypot(path!.pos[0], path!.pos[1])).toBeCloseTo(40, 3);
	});
});

// FrmCloud.vue's real UI exposes stride 1/2/5/10/25 ("show every Nth point") specifically for
// the large ops the GPU rewrite targets, and buildStaticAttributes decimates the STATIC gpu
// buffer from index 0 (phase-0-anchored) while buildPath's exact-count refine (used for both the
// "N pts" readout and the old CPU path) decimates from the crop-start index (cs-anchored) — see
// buildStaticAttributes's doc comment. This suite checks that phase mismatch never produces a
// wrong or wildly-off render, only a bounded, cosmetic point-count difference.
describe('frmCloudShader: buildStaticAttributes under stride > 1 (GPU-buffer phase vs. cs-anchored count)', () => {
	const base: TurningSpiralParams = {
		kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0,
		speedMode: 'measured', rpm: 1200, vc: 0, timeScale: 1, ppr: 1,
	};

	function countVisibleInStaticBuffer(
		pathParams: TurningSpiralParams, cropStartSec: number, cropEndSec: number, stride: number,
	): number {
		const { aT, aRevs, count } = buildStaticAttributes(cache, 'Fx', stride);
		const cs = idxOfTime(cache.t, cropStartSec);
		const uParams: SpiralUniformParams = {
			feed: pathParams.feed, diam: pathParams.diam, innerDiam: pathParams.innerDiam,
			speedMode: pathParams.speedMode, rpm: pathParams.rpm, vc: pathParams.vc,
			timeScale: pathParams.timeScale, ppr: pathParams.ppr,
			tCs: cache.t[cs], revsCs: cache.revs[cs],
		};
		let n = 0;
		for (let k = 0; k < count; k++) {
			const v = computeSpiralVertexJS(aT[k], aRevs[k], uParams, cropStartSec, cropEndSec);
			// Every point the shader marks visible must still land at a sane, finite position —
			// per-vertex math never depends on decimation phase, only on that vertex's own aT/aRevs.
			expect(Number.isFinite(v.x)).toBe(true);
			expect(Number.isFinite(v.y)).toBe(true);
			if (v.visible) n++;
		}
		return n;
	}

	// 503 is coprime (or at least non-divisible) w.r.t. every stride below, so cropStart's index
	// (cs=503 exactly, via t[503] — never hand-pick a float seconds value and hope idxOfTime lands
	// on it, f32 rounding isn't that reliable) sits OFF-phase from the phase-0 buffer's kept
	// indices (0, stride, 2*stride, ...) for every one of them. Anchoring the window here (instead
	// of at cs=0 or cs=500, both divisible by every stride tested) is what actually exercises the
	// phase-0-vs-cs-anchored mismatch these tests exist to bound — a window starting exactly on a
	// multiple of stride would make both decimations select the identical index set and pass
	// trivially regardless of whether the ≤1 bound holds.
	const CS_OFFPHASE = 503;
	const cropStart = cache.t[CS_OFFPHASE];

	for (const stride of [2, 5, 10, 25]) {
		it(`stride=${stride}: crop start is genuinely off-phase (test sanity check)`, () => {
			expect(idxOfTime(cache.t, cropStart)).toBe(CS_OFFPHASE);
			expect(CS_OFFPHASE % stride).not.toBe(0);
		});

		it(`stride=${stride}: full window count is within 1 of the cs-anchored exact count`, () => {
			const exact = buildPath(cache, base, { cropStartSec: cropStart, cropEndSec: 1e9, stride });
			expect(exact).not.toBeNull();
			const gpuCount = countVisibleInStaticBuffer(base, cropStart, 1e9, stride);
			expect(Math.abs(gpuCount - exact!.count)).toBeLessThanOrEqual(1);
		});

		it(`stride=${stride}: narrowed window count is within 1 of the cs-anchored exact count`, () => {
			const cropEnd = cache.t[CS_OFFPHASE + 1000];
			const exact = buildPath(cache, base, { cropStartSec: cropStart, cropEndSec: cropEnd, stride });
			expect(exact).not.toBeNull();
			const gpuCount = countVisibleInStaticBuffer(base, cropStart, cropEnd, stride);
			expect(Math.abs(gpuCount - exact!.count)).toBeLessThanOrEqual(1);
		});
	}

	it('donut cut under stride=10 still discards correctly past the inner-diameter boundary', () => {
		const donut = { ...base, diam: 80, innerDiam: 40 };
		const exact = buildPath(cache, donut, { cropStartSec: cropStart, cropEndSec: 1e9, stride: 10 });
		expect(exact).not.toBeNull();
		const gpuCount = countVisibleInStaticBuffer(donut, cropStart, 1e9, 10);
		expect(Math.abs(gpuCount - exact!.count)).toBeLessThanOrEqual(1);
	});
});

// The allocation-free position function is what picks run; computeSpiralVertexJS wraps it, so this
// pins the two together across all three speed modes and the donut cut-out.
describe('frmCloudShader: spiralPositionInto matches computeSpiralVertexJS', () => {
	const modes: SpiralUniformParams[] = [
		{ feed: 0.05, diam: 80, innerDiam: 0, speedMode: 'measured', rpm: 1200, vc: 0, timeScale: 1, ppr: 1, tCs: 5, revsCs: cache.revs[500] },
		{ feed: 0.05, diam: 80, innerDiam: 30, speedMode: 'rpm', rpm: 1200, vc: 0, timeScale: 1, ppr: 1, tCs: 5, revsCs: 0 },
		{ feed: 0.05, diam: 80, innerDiam: 30, speedMode: 'vc', rpm: 0, vc: 100, timeScale: 2, ppr: 1, tCs: 5, revsCs: 0 },
	];
	for (const p of modes) {
		it(`${p.speedMode}: same x, y, rho and visibility at every sample, one reused out object`, () => {
			const u = spiralUniformValues(p);
			const out: SpiralPos = { x: 0, y: 0, rho: 0, visible: false };
			for (let i = 0; i < cache.N; i += 7) {
				const ref = computeSpiralVertexJS(cache.t[i], cache.revs[i], p, 5, 15);
				spiralPositionInto(u, cache.t[i], cache.revs[i], 5, 15, out);
				expect(out).toEqual(ref);
			}
		});
		it(`${p.speedMode}: the radius step alone gives rho and visibility, and the place step finishes x, y`, () => {
			const u = spiralUniformValues(p);
			const whole: SpiralPos = { x: 0, y: 0, rho: 0, visible: false };
			const split: SpiralPos = { x: 123, y: 456, rho: 0, visible: false };
			for (let i = 0; i < cache.N; i += 7) {
				spiralPositionInto(u, cache.t[i], cache.revs[i], 5, 15, whole);
				split.x = 123; split.y = 456;
				const r = spiralRadiusInto(u, cache.t[i], cache.revs[i], 5, 15, split);
				expect(split.rho).toBe(whole.rho);
				expect(split.visible).toBe(whole.visible);
				expect([split.x, split.y]).toEqual([123, 456]);   // no trig yet
				spiralPlaceInto(r, split);
				expect(split).toEqual(whole);
			}
		});
	}
});

// The pick replays the GPU's sampling: phase-0 indices (buildStaticAttributes) inside the crop's
// time window. Brute force over the static buffer is the reference.
describe('frmCloudShader: phase0Samples', () => {
	function brute(cropStart: number, cropEnd: number, stride: number): number[] {
		const { aT, count } = buildStaticAttributes(cache, 'Fx', stride);
		const out: number[] = [];
		for (let k = 0; k < count; k++) if (aT[k] >= cropStart && aT[k] <= cropEnd) out.push(k * stride);
		return out;
	}
	function viaRange(cropStart: number, cropEnd: number, stride: number): number[] {
		const s = phase0Samples(cache, cropStart, cropEnd, stride);
		return Array.from({ length: s.n }, (_, j) => (s.k0 + j) * s.stride);
	}
	for (const stride of [1, 2, 5, 10, 25]) {
		it(`stride=${stride}: matches the static buffer's crop test, off-phase crop`, () => {
			const a = cache.t[503], b = cache.t[1503];
			expect(viaRange(a, b, stride)).toEqual(brute(a, b, stride));
		});
	}
	it('keeps both crop edges inclusive and handles times between samples', () => {
		expect(viaRange(cache.t[10], cache.t[20], 1)).toEqual(brute(cache.t[10], cache.t[20], 1));
		const mid0 = (cache.t[10] + cache.t[11]) / 2, mid1 = (cache.t[20] + cache.t[21]) / 2;
		expect(viaRange(mid0, mid1, 1)).toEqual(brute(mid0, mid1, 1));
		expect(viaRange(mid0, mid1, 1)[0]).toBe(11);
	});
	it('is empty for a window before, after, or between the samples, and for a reversed crop', () => {
		expect(phase0Samples(cache, -5, -1, 1).n).toBe(0);
		expect(phase0Samples(cache, 1e6, 2e6, 1).n).toBe(0);
		expect(phase0Samples(cache, cache.t[10] + 0.001, cache.t[10] + 0.002, 1).n).toBe(0);
		expect(phase0Samples(cache, 10, 5, 1).n).toBe(0);
		expect(phase0Samples(cache, cache.t[11], cache.t[14], 5).n).toBe(0);   // no multiple of 5 in [11, 14]
	});
	it('runs to the last sample when the crop end is past the recording', () => {
		const v = viaRange(cache.t[1990], 1e9, 1);
		expect(v[v.length - 1]).toBe(cache.N - 1);
	});
});
