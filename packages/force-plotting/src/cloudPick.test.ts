import { describe, expect, it } from 'vitest';
import {
	createClickTracker, displayedKeep, findNearestPathIndex, formatPointInfo, octreePathParams, pickNearest, pickSpiral, pointInfo, settleRing,
	recentreWindow,
} from './cloudPick';
import type { Cache } from './liveCache';
import { buildPath, type PathParams, type TurningSpiralParams } from './path';
import { createMapProjector } from './mapProjector';
import { phase0Samples, spiralAnchor, spiralPointAt } from './frmCloudShader';
import { cacheCoversBuild, mappableWindow, parseOctreeBuild } from './octreeBuild';
import * as THREE from 'three';

describe('pickNearest', () => {
	const pts = [{ px: 0, py: 0 }, { px: 10, py: 10 }, { px: 12, py: 10 }, { px: 100, py: 100 }];
	const project = (k: number) => pts[k];
	it('picks the nearest point', () => {
		expect(pickNearest(4, project, 11.5, 10, 20)).toBe(2);
		expect(pickNearest(4, project, 1, 1, 20)).toBe(0);
	});
	it('returns null when nothing is within the radius', () => {
		expect(pickNearest(4, project, 50, 50, 10)).toBeNull();
		expect(pickNearest(4, project, 3, 0, 3)).toBe(0);   // exactly on the radius counts
		expect(pickNearest(4, project, 3.1, 0, 3)).toBeNull();
	});
	it('skips points rejected by keep()', () => {
		expect(pickNearest(4, project, 12, 10, 20, (k) => k !== 2)).toBe(1);
	});
	it('skips points that project to null', () => {
		const p = (k: number) => (k === 2 ? null : pts[k]);
		expect(pickNearest(4, p, 12, 10, 20)).toBe(1);
	});
	it('handles n = 0', () => {
		expect(pickNearest(0, project, 0, 0, 100)).toBeNull();
	});
});

describe('recentreWindow', () => {
	it('returns null when the marker is inside the window', () => {
		expect(recentreWindow(10, 20, 15, 0, 100)).toBeNull();
		expect(recentreWindow(10, 20, 10, 0, 100)).toBeNull();
		expect(recentreWindow(10, 20, 20, 0, 100)).toBeNull();
	});
	it('returns null when not zoomed', () => {
		expect(recentreWindow(null, null, 50, 0, 100)).toBeNull();
		expect(recentreWindow(10, null, 50, 0, 100)).toBeNull();
		expect(recentreWindow(null, 20, 50, 0, 100)).toBeNull();
	});
	it('centres on t keeping the width', () => {
		expect(recentreWindow(10, 20, 50, 0, 100)).toEqual({ start: 45, end: 55 });
	});
	it('shifts instead of shrinking at the left edge', () => {
		expect(recentreWindow(40, 60, 2, 0, 100)).toEqual({ start: 0, end: 20 });
	});
	it('shifts instead of shrinking at the right edge', () => {
		expect(recentreWindow(10, 30, 99, 0, 100)).toEqual({ start: 80, end: 100 });
	});
	it('returns the full range when the width covers it', () => {
		expect(recentreWindow(-5, 105, 200, 0, 100)).toEqual({ start: 0, end: 100 });
		expect(recentreWindow(0, 100, 150, 0, 100)).toEqual({ start: 0, end: 100 });
	});
});

describe('findNearestPathIndex', () => {
	const idx = Int32Array.from([10, 20, 30, 40]);
	it('clamps below and above the path', () => {
		expect(findNearestPathIndex(idx, 4, 0)).toBe(0);
		expect(findNearestPathIndex(idx, 4, 500)).toBe(3);
	});
	it('picks the nearer neighbour between entries', () => {
		expect(findNearestPathIndex(idx, 4, 24)).toBe(1);
		expect(findNearestPathIndex(idx, 4, 26)).toBe(2);
		expect(findNearestPathIndex(idx, 4, 20)).toBe(1);
	});
	it('returns -1 when empty', () => {
		expect(findNearestPathIndex(new Int32Array(0), 0, 5)).toBe(-1);
		expect(findNearestPathIndex(idx, 0, 5)).toBe(-1);
	});
});

function makeCache(withRpm = true): Cache {
	const N = 60;
	const mk = (f: (i: number) => number) => Float32Array.from({ length: N }, (_, i) => f(i));
	return {
		N, Fs: 1000, feed: 0.05, diam: 80, csSec: 0.05, ceSec: 0.5,
		t: mk((i) => i * 0.01), revs: mk((i) => i * 0.03),
		Fx: mk((i) => i + 0.5), Fy: mk((i) => -i), Fz: mk((i) => i * 2),
		rpm: withRpm ? mk(() => 1200) : new Float32Array(0),
	};
}

describe('pointInfo / formatPointInfo', () => {
	it('reads the sample from the cache', () => {
		const c = makeCache();
		const p = pointInfo(c, 7, 1.5, -2.5, 38);
		expect(p.i).toBe(7);
		expect(p.t).toBeCloseTo(0.07, 6);
		expect(p).toMatchObject({ x: 1.5, y: -2.5, rho: 38, Fx: 7.5, Fy: -7, Fz: 14, rpm: 1200 });
	});
	it('omits rho and rpm when unavailable', () => {
		const p = pointInfo(makeCache(false), 3, 0, 0);
		expect('rho' in p).toBe(false);
		expect('rpm' in p).toBe(false);
	});
	it('formats tab-separated key/value lines with units', () => {
		const text = formatPointInfo({ i: 7, t: 0.5, x: 1, y: 2, rho: 3, Fx: 4, Fy: 5, Fz: 6, rpm: 1200 });
		expect(text.split('\n')).toEqual([
			'i\t7', 't (s)\t0.5', 'x (mm)\t1', 'y (mm)\t2', 'rho (mm)\t3',
			'Fx (N)\t4', 'Fy (N)\t5', 'Fz (N)\t6', 'rpm\t1200',
		]);
	});
	it('omits undefined optional fields', () => {
		const text = formatPointInfo({ i: 1, t: 2, x: 3, y: 4, Fx: 5, Fy: 6, Fz: 7 });
		expect(text).not.toContain('rho');
		expect(text).not.toContain('rpm');
		expect(text.split('\n')).toHaveLength(7);
	});
});

describe('octreePathParams', () => {
	it('matches buildPath in a hand-built measured-mode configuration', () => {
		const c = makeCache();
		const { path, window } = octreePathParams(c, 10, 4);
		expect(path).toMatchObject({ kind: 'turning_spiral', speedMode: 'measured', feed: 0.05, diam: 80, innerDiam: 10, ppr: 4, rpm: 1200 });
		// the whole cache, from its own t: deliberately not the header's csSec (0.05) / ceSec (0.5)
		expect(window.cropStartSec).toBe(c.t[0]);
		expect(window.cropEndSec).toBe(c.t[c.N - 1]);
		expect(window.stride).toBe(1);

		const hand: PathParams = {
			kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 10,
			speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 4,
		};
		const a = buildPath(c, path, window)!;
		const b = buildPath(c, hand, { cropStartSec: c.t[0], cropEndSec: c.t[c.N - 1], stride: 1 })!;
		expect(a.count).toBeGreaterThan(0);
		expect(a.count).toBe(b.count);
		expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
		expect(Array.from(a.idx)).toEqual(Array.from(b.idx));
		// the path spans the whole cache, first sample (r = 0) to last
		expect(a.idx[0]).toBe(0);
		expect(a.idx[a.count - 1]).toBe(c.N - 1);
	});
	it('anchors at t[0] even when csSec is not on the same time base', () => {
		const c = makeCache();
		c.csSec = 0.0123; c.ceSec = 9;   // header values that don't line up with t
		const { window } = octreePathParams(c, 0, 1);
		expect(window).toEqual({ cropStartSec: c.t[0], cropEndSec: c.t[c.N - 1], stride: 1 });
		const a = buildPath(c, octreePathParams(c, 0, 1).path, window)!;
		expect(a.idx[0]).toBe(0);
		expect(a.pos[0]).toBeCloseTo(c.diam / 2, 5);   // r = 0 at the first sample: on the +x axis at rho0
		expect(a.pos[1]).toBeCloseTo(0, 5);
	});
	it('falls back to rpm 0 when the cache carries no rpm', () => {
		const { path } = octreePathParams(makeCache(false), 0, 1);
		expect(path.kind === 'turning_spiral' && path.rpm).toBe(0);
	});
});

describe('octreePathParams with a build manifest', () => {
	const build = parseOctreeBuild({
		schema: 1, kind: 'octree', speed_mode: 'measured', feed: 0.08, diam: 60, inner_diam: 5, ppr: 3,
		cut_start_sec: 0.1, cut_end_sec: 0.4, crop_source: 'override',
	})!;
	it('takes feed, diameters, ppr and the window from the manifest, not the cache or the row', () => {
		const c = makeCache();
		const { path, window } = octreePathParams(c, 10, 4, build);
		expect(path).toMatchObject({ kind: 'turning_spiral', speedMode: 'measured', feed: 0.08, diam: 60, innerDiam: 5, ppr: 3 });
		expect(window).toEqual({ cropStartSec: Math.fround(0.1), cropEndSec: Math.fround(0.4), stride: 1 });   // float32 like t; not t[0]..t[N-1]
	});
	it('anchors r = 0 at the first cache sample at the manifest start', () => {
		const c = makeCache();
		const { path, window } = octreePathParams(c, 10, 4, build);
		const a = buildPath(c, path, window)!;
		expect(a.count).toBeGreaterThan(0);
		expect(c.t[a.idx[0]]).toBeGreaterThanOrEqual(0.1 - 1e-6);
		expect(c.t[a.idx[0]]).toBeLessThan(0.1 + 0.011);
		expect(c.t[a.idx[a.count - 1]]).toBeLessThanOrEqual(0.4 + 1e-6);
		expect(a.pos[0]).toBeCloseTo(30, 5);   // the manifest's diam / 2 at the anchor
	});
	it('keeps the row-based behaviour when there is no manifest (or null)', () => {
		const c = makeCache();
		expect(octreePathParams(c, 10, 4, null)).toEqual(octreePathParams(c, 10, 4));
		expect(octreePathParams(c, 10, 4, undefined).window.cropStartSec).toBe(c.t[0]);
	});
});

describe('displayedKeep', () => {
	const vals = Float32Array.from([1, 5, 9]);
	const idx = Int32Array.from([0, 1, 2]);
	it('is undefined when nothing is hidden', () => {
		expect(displayedKeep(vals, idx, { dispMin: 2, dispMax: 8, greyOutOfRange: true })).toBeUndefined();
		expect(displayedKeep(undefined, idx, { dispMin: 2, dispMax: 8 })).toBeUndefined();
	});
	it('keeps only values inside the displayed range', () => {
		const keep = displayedKeep(vals, idx, { dispMin: 2, dispMax: 8 })!;
		expect([0, 1, 2].map(keep)).toEqual([false, true, false]);
	});
});

describe('createClickTracker', () => {
	const ev = (x: number, y: number, button = 2, pointerType = 'mouse') => ({ clientX: x, clientY: y, button, pointerType }) as PointerEvent;
	it('tells a click from a drag on the right-button release', () => {
		const t = createClickTracker();
		t.down(ev(10, 10)); expect(t.up(ev(12, 11))).toBe(true);
		t.down(ev(10, 10)); expect(t.up(ev(30, 10))).toBe(false);
	});
	it('forgets the press after the release', () => {
		const t = createClickTracker();
		t.down(ev(10, 10)); t.up(ev(10, 10));
		expect(t.up(ev(10, 10))).toBe(false);
	});
	it('ignores other buttons and touch', () => {
		const t = createClickTracker();
		t.down(ev(10, 10, 0)); expect(t.up(ev(10, 10, 0))).toBe(false);
		t.down(ev(10, 10, 2, 'touch')); expect(t.up(ev(10, 10, 2, 'touch'))).toBe(false);
	});
	it('does not open for a release with no recorded press', () => {
		expect(createClickTracker().up(ev(10, 10))).toBe(false);
	});
});

describe('pickSpiral', () => {
	const c = makeCache();
	// a hand-rolled ortho view: 5 px per mm, origin at (400, 400)
	const project = (x: number, y: number) => ({ px: 400 + x * 5, py: 400 - y * 5 });
	const path: TurningSpiralParams = {
		kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0, speedMode: 'measured', rpm: 0, vc: 0, timeScale: 1, ppr: 1,
	};
	it('finds the sample buildPath would, without a path (stride 1)', () => {
		const ref = buildPath(c, path, { cropStartSec: 0.1, cropEndSec: 0.4, stride: 1 })!;
		for (const k of [0, 7, 15, ref.count - 1]) {
			const p = project(ref.pos[k * 3], ref.pos[k * 3 + 1]);
			const hit = pickSpiral(c, path, 0.1, 0.4, 1, project, p.px + 0.3, p.py - 0.2, 8)!;
			expect(hit.i).toBe(ref.idx[k]);
			expect(hit.x).toBeCloseTo(ref.pos[k * 3], 4);
			expect(hit.y).toBeCloseTo(ref.pos[k * 3 + 1], 4);
			expect(hit.rho).toBeCloseTo(ref.rho![k], 4);
		}
	});
	it('only offers the GPU\'s phase-0 samples at stride > 1', () => {
		const ref = buildPath(c, path, { cropStartSec: 0.1, cropEndSec: 0.4, stride: 1 })!;
		const k = ref.idx.indexOf(11);                    // not a multiple of 3: not drawn at stride 3
		const p = project(ref.pos[k * 3], ref.pos[k * 3 + 1]);
		const hit = pickSpiral(c, path, 0.1, 0.4, 3, project, p.px, p.py, 40)!;
		expect(hit.i % 3).toBe(0);
	});
	it('ignores samples outside the crop, hidden by keep(), or off-screen, and returns null when nothing is near', () => {
		const ref = buildPath(c, path, { cropStartSec: 0.1, cropEndSec: 0.4, stride: 1 })!;
		const k0 = project(ref.pos[0], ref.pos[1]);
		const outside = pickSpiral(c, path, 0.3, 0.4, 1, project, k0.px, k0.py, 1);   // sample 10 is before this crop
		expect(outside === null || outside.i >= 30).toBe(true);
		const hidden = pickSpiral(c, path, 0.1, 0.4, 1, project, k0.px, k0.py, 1, (i) => i !== 10);
		expect(hidden === null || hidden.i !== 10).toBe(true);
		expect(pickSpiral(c, path, 0.1, 0.4, 1, () => null, k0.px, k0.py, 1000)).toBeNull();
		expect(pickSpiral(c, path, 10, 20, 1, project, 400, 400, 1000)).toBeNull();
	});
	it('does not place samples past the inner-diameter cut-out', () => {
		const donut: TurningSpiralParams = { ...path, innerDiam: 79.9 };
		const hit = pickSpiral(c, donut, 0.1, 0.5, 1, project, 400, 400, 1000);
		expect(hit).not.toBeNull();
		expect(hit!.rho).toBeGreaterThanOrEqual(39.95 - 1e-3);
	});
});

// A long synthetic turning-spiral cache: steady 3 rev/s, so rho winds in from the outer radius.
function spiralCache(n: number): Cache {
	const Fs = 5000, t = new Float32Array(n), revs = new Float32Array(n), rpm = new Float32Array(n).fill(180);
	for (let i = 0; i < n; i++) { t[i] = i / Fs; revs[i] = (3 * i) / Fs; }
	const z = () => new Float32Array(n);
	return { N: n, Fs, feed: 0.05, diam: 80, csSec: 0, ceSec: (n - 1) / Fs, t, Fx: z(), Fy: z(), Fz: z(), rpm, revs };
}

describe('pickSpiral with a radius cull', () => {
	const W = 800, H = 800;
	// a flat top-down ortho view over +-45 mm, panned a little
	function view(zoom = 1, cx = 1.5, cy = -2) {
		const cam = new THREE.OrthographicCamera(-45, 45, 45, -45, 0.1, 1e6);
		cam.position.set(cx, cy, 10); cam.zoom = zoom;
		cam.updateProjectionMatrix(); cam.updateMatrixWorld();
		const proj = createMapProjector();
		proj.setup(cam, null, W, H);
		return proj;
	}
	const base: TurningSpiralParams = {
		kind: 'turning_spiral', feed: 0.05, diam: 80, innerDiam: 0, speedMode: 'measured', rpm: 180, vc: 20, timeScale: 1, ppr: 1,
	};
	// clicks just beside drawn samples (so there is a winner), plus a few that land on nothing
	function onSpiral(c: Cache, path: TurningSpiralParams, proj: ReturnType<typeof createMapProjector>,
		indices = [50, 4000, 12345, 30001, 39000]): [number, number][] {
		const out: [number, number][] = [[400, 400], [10, 10]];
		for (const i of indices) {
			const v = spiralPointAt(c, path, 0, 8, i);
			const p = v.visible ? proj.project(v.x, v.y, 0) : null;
			if (p) out.push([p.px + 1.3, p.py - 0.7]);
		}
		return out;
	}

	for (const mode of ['measured', 'rpm', 'vc'] as const) {
		for (const stride of [1, 3, 7]) {
			for (const innerDiam of [0, 39.5]) {
				it(`returns the unculled winner: ${mode}, stride ${stride}, inner diameter ${innerDiam}`, () => {
					const c = spiralCache(40000);
					const path: TurningSpiralParams = { ...base, speedMode: mode, innerDiam };
					const proj = view();
					const project = (x: number, y: number) => proj.project(x, y, 0);
					let hits = 0;
					for (const [px, py] of onSpiral(c, path, proj)) {
						const plain = pickSpiral(c, path, 0, 8, stride, project, px, py, 8);
						const disc = proj.discAt(px, py, 8);
						expect(disc).not.toBeNull();
						const culled = pickSpiral(c, path, 0, 8, stride, project, px, py, 8, undefined, disc);
						expect(culled).toEqual(plain);
						if (plain) hits++;
					}
					expect(hits).toBeGreaterThan(0);   // not vacuous: some clicks land on the spiral
				});
			}
		}
	}

	it('also agrees when keep() hides samples and the view is zoomed', () => {
		const c = spiralCache(40000);
		const proj = view(3, 40, 0);   // panned onto the ring so the zoomed view still sees the spiral
		const project = (x: number, y: number) => proj.project(x, y, 0);
		const keep = (i: number) => i % 5 !== 0;
		let hits = 0;
		for (const [px, py] of onSpiral(c, base, proj, Array.from({ length: 400 }, (_, k) => k * 97))) {
			const plain = pickSpiral(c, base, 0, 8, 1, project, px, py, 12, keep);
			const culled = pickSpiral(c, base, 0, 8, 1, project, px, py, 12, keep, proj.discAt(px, py, 12));
			expect(culled).toEqual(plain);
			if (plain) hits++;
		}
		expect(hits).toBeGreaterThan(0);
	});

	it('is faster on a 1M-sample cache (timing is logged, not asserted)', () => {
		const c = spiralCache(1_000_000);
		const proj = view();
		const project = (x: number, y: number) => proj.project(x, y, 0);
		const px = 430, py = 380;
		// the pre-fold baseline: per-sample Vector3.project through the camera
		const cam = new THREE.OrthographicCamera(-45, 45, 45, -45, 0.1, 1e6);
		cam.position.set(1.5, -2, 10); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
		const v = new THREE.Vector3(), o = { px: 0, py: 0 };
		const legacy = (x: number, y: number) => {
			v.set(x, y, 0).project(cam);
			if (!(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1)) return null;
			o.px = (v.x + 1) / 2 * W; o.py = (1 - v.y) / 2 * H;
			return o;
		};
		const time = (cull: boolean) => {
			const t0 = performance.now();
			let r = null;
			for (let k = 0; k < 3; k++) r = pickSpiral(c, base, 0, 200, 1, project, px, py, 8, undefined, cull ? proj.discAt(px, py, 8) : null);
			return { ms: (performance.now() - t0) / 3, r };
		};
		time(true); time(false);   // warm up
		const culled = time(true), plain = time(false);
		const t0 = performance.now();
		const old = pickSpiral(c, base, 0, 200, 1, legacy, px, py, 8);
		const oldMs = performance.now() - t0;
		console.log(`pickSpiral 1M samples: Vector3.project ${oldMs.toFixed(1)} ms, folded ${plain.ms.toFixed(1)} ms, folded + cull ${culled.ms.toFixed(1)} ms`);
		expect(culled.r).toEqual(plain.r);
		expect(old).toEqual(plain.r);
	});
});

describe('settleRing', () => {
	it('keeps the old object for sub-quarter-pixel moves', () => {
		const cur = { x: 10, y: 10 };
		expect(settleRing(cur, 10.1, 10.2)).toBe(cur);
		expect(settleRing(cur, 11, 10)).toEqual({ x: 11, y: 10 });
		expect(settleRing(null, 1, 2)).toEqual({ x: 1, y: 2 });
	});
});

// The octree is integrated on the host in doubles from every raw sample; the browser sees a float32,
// possibly decimated live cache. These tests build both from one double-precision truth and check the
// map places each cache sample where the octree has it.
describe('octree anchor: float32 + decimated cache, override mid-step, override before the cache', () => {
	const Fs = 2560, FEED = 0.05, DIAM = 80, PPR = 2;
	const rawT = (k: number) => k / Fs;                              // doubles, like MATLAB's Time column
	const rawRevs = (k: number) => 3 * rawT(k) + 2 * rawT(k) ** 2;   // cumulative raw revs (double)
	// A cache over raw samples [k0, k0 + n*step), every `step`-th, stored as float32 like write_live_cache.
	function cacheOver(k0: number, n: number, step: number): { c: Cache; raw: number[] } {
		const raw = Array.from({ length: n }, (_, j) => k0 + j * step);
		const c: Cache = {
			N: n, Fs, feed: FEED, diam: DIAM, csSec: rawT(k0), ceSec: rawT(raw[n - 1]),
			t: Float32Array.from(raw, rawT), revs: Float32Array.from(raw, rawRevs),
			Fx: new Float32Array(n), Fy: new Float32Array(n), Fz: new Float32Array(n), rpm: new Float32Array(n).fill(180),
		};
		return { c, raw };
	}
	// The octree's own position of raw sample k for an octree starting at raw sample kc.
	const truth = (k: number, kc: number) => {
		const r = (rawRevs(k) - rawRevs(kc)) / PPR, rho = DIAM / 2 - FEED * r;
		return { x: rho * Math.cos(2 * Math.PI * r), y: rho * Math.sin(2 * Math.PI * r) };
	};
	const manifest = (kc: number, ke: number, revs = true) => parseOctreeBuild({
		schema: 1, kind: 'octree', speed_mode: 'measured', feed: FEED, diam: DIAM, inner_diam: 0, ppr: PPR,
		cut_start_sec: rawT(kc), cut_end_sec: rawT(ke), crop_source: 'override', ...(revs ? { revs_cs: rawRevs(kc) } : {}),
	})!;
	const project = (x: number, y: number) => ({ px: 400 + x * 20, py: 400 - y * 20 });
	// first k at/after `from` whose t is not a float32 value and rounds BELOW the double (a start the
	// double comparison would skip)
	const roundsDown = (from: number) => { let k = from; while (!(Math.fround(rawT(k)) < rawT(k))) k++; return k; };

	// Click each of a few cache samples at the octree's position for it; the map must offer that sample
	// (or an immediate neighbour on the same pixel) at the octree's position for it.
	function expectAligned(c: Cache, raw: number[], build: ReturnType<typeof manifest>, kc: number, js: number[]) {
		const g = octreePathParams(c, 0, 1, build);
		for (const j of js) {
			const tr = truth(raw[j], kc), p = project(tr.x, tr.y);
			const hit = pickSpiral(c, g.path as TurningSpiralParams, g.window.cropStartSec, g.window.cropEndSec, 1, project, p.px, p.py, 2, undefined, null, g.anchor)!;
			expect(hit, `sample ${j}`).not.toBeNull();
			expect(Math.abs(hit.i - j)).toBeLessThanOrEqual(1);
			const at = truth(raw[hit.i], kc);
			expect(hit.x).toBeCloseTo(at.x, 3);
			expect(hit.y).toBeCloseTo(at.y, 3);
		}
	}

	it('float32 cache, non-representable start: sample 0 is inside the window and on the octree', () => {
		const k0 = roundsDown(6758);
		const { c, raw } = cacheOver(k0, 400, 1);
		const b = manifest(k0, raw[399]);
		// the old comparison (the double start vs float32 t) drops sample 0
		expect(phase0Samples(c, rawT(k0), rawT(raw[399]), 1).k0).toBe(1);
		const g = octreePathParams(c, 0, 1, b);
		expect(phase0Samples(c, g.window.cropStartSec, g.window.cropEndSec, 1)).toMatchObject({ k0: 0, n: 400 });
		expect(mappableWindow(c, b)!.start).toBe(c.t[0]);
		expectAligned(c, raw, b, k0, [0, 1, 40, 399]);
	});
	it('decimated cache, start mid-step: anchored on the host revs_cs, not on the next cache sample', () => {
		const step = 4, k0 = roundsDown(6000), kc = k0 + 2 * step + 1;   // between cache samples 2 and 3
		const { c, raw } = cacheOver(k0, 300, step);
		const b = manifest(kc, raw[299]);
		// the old anchor (first cache sample >= start) is up to a step late: visibly off the octree
		const lateJ = c.t.findIndex((t) => t >= rawT(kc));
		const late = spiralPointAt(c, octreePathParams(c, 0, 1, b).path as any, rawT(kc), rawT(raw[299]), 60);
		const tr = truth(raw[60], kc);
		expect(Math.hypot(late.x - tr.x, late.y - tr.y)).toBeGreaterThan(0.02);
		expect(raw[lateJ]).toBeGreaterThan(kc);
		expectAligned(c, raw, b, kc, [lateJ, lateJ + 1, 60, 299]);
		expect(mappableWindow(c, b)!.start).toBe(Math.fround(rawT(kc)));   // the window starts at the crop, between cache samples
	});
	it('start before the cache: maps the overlap, anchored on the host revs_cs', () => {
		const step = 2, k0 = 5000, kc = k0 - 300;   // the octree starts 300 raw samples before the cache
		const { c, raw } = cacheOver(k0, 200, step);
		const b = manifest(kc, raw[199]);
		expect(cacheCoversBuild(c, b)).toBe(true);
		expect(mappableWindow(c, b)).toEqual({ start: c.t[0], end: Math.fround(rawT(raw[199])) });
		expectAligned(c, raw, b, kc, [0, 1, 100, 199]);
		// without revs_cs there is no anchor to find in the cache: not mappable (the older behaviour)
		expect(mappableWindow(c, manifest(kc, raw[199], false))).toBeNull();
	});
	it('a manifest without revs_cs still includes a float32 t[0] that rounded below the start', () => {
		const k0 = roundsDown(7000);
		const { c, raw } = cacheOver(k0, 300, 1);
		const b = manifest(k0, raw[299], false);
		const g = octreePathParams(c, 0, 1, b);
		expect(g.anchor).toEqual(spiralAnchor(c, g.window.cropStartSec));
		expect(g.anchor.revsCs).toBe(c.revs[0]);
		expect(phase0Samples(c, g.window.cropStartSec, g.window.cropEndSec, 1).k0).toBe(0);
		expectAligned(c, raw, b, k0, [0, 1, 150]);
	});
	it('the crop ends on the float32 end sample too', () => {
		const k0 = roundsDown(6758), ke = (() => { let k = k0 + 200; while (!(Math.fround(rawT(k)) > rawT(k))) k++; return k; })();
		const { c } = cacheOver(k0, 300, 1);
		const g = octreePathParams(c, 0, 1, manifest(k0, ke));
		const s = phase0Samples(c, g.window.cropStartSec, g.window.cropEndSec, 1);
		expect(k0 + s.k0 + s.n - 1).toBe(ke);   // the sample at ke is drawn (a double end would stop one short)
	});
});
