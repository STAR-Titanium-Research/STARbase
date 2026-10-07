// The tool-path seam: turns a Cache + parameters into a stride-3 array of positions.
// Extracted so the geometry that used to be hardwired into buildCloud() (a turning
// spiral) is one of three interchangeable models. See
// docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md §1.
import { type Cache, idxOfTime, normStride } from './liveCache';

export type PathKind = 'turning_spiral' | 'linear_feed' | 'machine_xyz';
export type SpeedMode = 'measured' | 'rpm' | 'vc';

export interface PathWindow {
	cropStartSec: number;
	cropEndSec: number;
	stride: number;
}

export interface TurningSpiralParams {
	kind: 'turning_spiral';
	feed: number;          // mm/rev
	diam: number;           // mm
	innerDiam: number;      // mm — spiral stops here (0 = solid disc)
	speedMode: SpeedMode;
	rpm: number;
	vc: number;
	timeScale: number;
	ppr: number;
}

export interface LinearFeedParams {
	kind: 'linear_feed';
	feedRate: number;   // mm/min along +X
	timeScale: number;
	yOffset: number;    // mm — constant Y for this pass
	zOffset: number;    // mm — constant Z (axial depth reference), informational
}

export interface MachineXyzParams {
	kind: 'machine_xyz';
	xKey: 'X' | 'Y' | 'Z';
	yKey: 'X' | 'Y' | 'Z';
	zKey: 'X' | 'Y' | 'Z';
	scale: number;       // mm per stored unit
	origin: 'first_sample' | 'absolute';
}

export type PathParams = TurningSpiralParams | LinearFeedParams | MachineXyzParams;

export interface PathBounds {
	minX: number; maxX: number;
	minY: number; maxY: number;
	minZ: number; maxZ: number;
}

export interface PathResult {
	pos: Float32Array;   // stride 3 — [x0,y0,z0, x1,y1,z1, ...]
	idx: Int32Array;     // cache index of each emitted point
	count: number;
	bounds: PathBounds;
	// turning_spiral only: geometric radial position (mm from the part's center axis) per
	// emitted point, aligned 1:1 with pos/idx. Undefined for linear_feed/machine_xyz, which
	// have no analogous "radius" concept.
	rho?: Float32Array;
}

/**
 * Build the tool path for one crop window. Returns null for a degenerate cache
 * (N === 0, empty t, or a crop that selects nothing) — callers MUST handle null.
 */
export function buildPath(c: Cache, p: PathParams, w: PathWindow): PathResult | null {
	const t = c.t;
	if (!t || t.length === 0 || c.N === 0) return null;
	const cs = idxOfTime(t, w.cropStartSec);
	if (cs < 0) return null;
	const stride = normStride(w.stride);

	if (p.kind === 'turning_spiral') return buildTurningSpiral(c, p, w, cs, stride);
	if (p.kind === 'linear_feed') return buildLinearFeed(c, p, w, cs, stride);
	return buildMachineXyz(c, p, w, cs, stride);
}

function buildTurningSpiral(
	c: Cache, p: TurningSpiralParams, w: PathWindow, cs: number, stride: number,
): PathResult | null {
	const t = c.t, revs = c.revs;
	const F = p.feed, rho0 = p.diam / 2;
	const innerR = Math.max(0, (p.innerDiam || 0) / 2);
	const revsCs = revs[cs], tCs = t[cs];
	const revPerSec = p.rpm / 60;
	const ts = p.timeScale > 0 ? p.timeScale : 1;
	const ppr = p.ppr > 0 ? p.ppr : 1;
	const K = F * p.vc * 1000 / (Math.PI * 120);

	const cap = Math.max(1, Math.ceil((c.N - cs) / stride) + 1);
	const pos = new Float32Array(cap * 3);
	const idx = new Int32Array(cap);
	const rhoArr = new Float32Array(cap);
	let m = 0;
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (let i = cs; i < c.N; i += stride) {
		if (t[i] > w.cropEndSec) break;
		let r: number, rho: number;
		if (p.speedMode === 'vc') {
			const under = rho0 * rho0 - 2 * K * (t[i] - tCs) * ts;
			if (under < innerR * innerR) break;
			rho = Math.sqrt(under);
			r = (rho0 - rho) / F;
		} else {
			r = p.speedMode === 'rpm' ? revPerSec * (t[i] - tCs) * ts : (revs[i] - revsCs) / ppr;
			rho = rho0 - F * r;
			if (rho < innerR) break;
		}
		const theta = 2 * Math.PI * r;
		const x = rho * Math.cos(theta), y = rho * Math.sin(theta);
		pos[m * 3] = x; pos[m * 3 + 1] = y; pos[m * 3 + 2] = 0;
		idx[m] = i;
		rhoArr[m] = rho;
		m++;
		if (x < minX) minX = x; if (x > maxX) maxX = x;
		if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	if (!m) return null;
	return {
		pos: pos.subarray(0, m * 3), idx: idx.subarray(0, m), count: m,
		bounds: { minX, maxX, minY, maxY, minZ: 0, maxZ: 0 },
		rho: rhoArr.subarray(0, m),
	};
}

/**
 * Look up the geometric radial position (rho, mm) at each of a set of bucket timestamps, via
 * the cache's own raw t[] index (nearest sample). `path` must come from a turning_spiral
 * buildPath call made with `stride: 1` — the lookup assumes `path.idx` is the contiguous run
 * [cs, cs+1, cs+2, ...], which only holds at stride 1. Returns NaN for any bucket time before
 * the path's start, after its end, or past wherever the spiral stopped early (cut-out /
 * inner-diameter reached) — callers must render a blank tick for NaN, never clamp to the last
 * valid value.
 */
export function alignRhoToBuckets(path: PathResult, c: Cache, bucketTimes: ArrayLike<number>): Float32Array {
	const out = new Float32Array(bucketTimes.length);
	if (!path.rho || !path.count) { out.fill(NaN); return out; }
	const cs = path.idx[0];
	const lastIdx = path.idx[path.count - 1];
	for (let i = 0; i < bucketTimes.length; i++) {
		const j = idxOfTime(c.t, bucketTimes[i]);
		out[i] = (j < cs || j > lastIdx) ? NaN : path.rho[j - cs];
	}
	return out;
}

/**
 * The radial position (rho) of a measured-speed turning spiral, WITHOUT building the path.
 *
 * ForceDashboard's second x-axis only needs rho at the chart's bucket times. Going through
 * buildPath() allocated pos/idx/rho for every sample (~100 MB at 5M points) and ran cos/sin per
 * point, and it did so on every crop-handle drag because the crop start moves rho (review 3.10).
 * measuredRhoSpan() is one allocation-free scan for where the spiral stops; alignMeasuredRho() is
 * then O(buckets). Both mirror buildTurningSpiral's measured branch exactly (stride 1, no crop
 * end): `alignMeasuredRho(measuredRhoSpan(c, p, s), c, ts)` equals
 * `alignRhoToBuckets(buildPath(c, p, {cropStartSec: s, cropEndSec: Infinity, stride: 1}), c, ts)`.
 */
export interface MeasuredRhoSpan {
	cs: number;       // first sample of the spiral (the crop start)
	end: number;      // one past the last sample before rho reaches the inner radius
	rho0: number; feed: number; ppr: number; revsCs: number;
}

export function measuredRhoSpan(c: Cache, p: TurningSpiralParams, cropStartSec: number): MeasuredRhoSpan | null {
	const t = c.t;
	if (!t || t.length === 0 || c.N === 0) return null;
	const cs = idxOfTime(t, cropStartSec);
	if (cs < 0) return null;
	const revs = c.revs;
	const rho0 = p.diam / 2, feed = p.feed;
	const innerR = Math.max(0, (p.innerDiam || 0) / 2);
	const ppr = p.ppr > 0 ? p.ppr : 1;
	const revsCs = revs[cs];
	let end = cs;
	while (end < c.N && !(rho0 - feed * ((revs[end] - revsCs) / ppr) < innerR)) end++;   // `!(<)`, not `>=`: a NaN rho does not stop buildPath
	if (end === cs) return null;   // buildPath returns null here too
	return { cs, end, rho0, feed, ppr, revsCs };
}

/** rho (mm) at each bucket time via the nearest raw sample; NaN before the start / past the stop. */
export function alignMeasuredRho(span: MeasuredRhoSpan | null, c: Cache, bucketTimes: ArrayLike<number>): Float32Array {
	const out = new Float32Array(bucketTimes.length);
	if (!span) { out.fill(NaN); return out; }
	const revs = c.revs;
	for (let i = 0; i < bucketTimes.length; i++) {
		const j = idxOfTime(c.t, bucketTimes[i]);
		out[i] = (j < span.cs || j >= span.end) ? NaN : span.rho0 - span.feed * ((revs[j] - span.revsCs) / span.ppr);
	}
	return out;
}

function buildLinearFeed(
	c: Cache, p: LinearFeedParams, w: PathWindow, cs: number, stride: number,
): PathResult | null {
	const t = c.t;
	const ts = p.timeScale > 0 ? p.timeScale : 1;
	const vPerSec = p.feedRate / 60;   // mm/s
	const tCs = t[cs];
	const cap = Math.max(1, Math.ceil((c.N - cs) / stride) + 1);
	const pos = new Float32Array(cap * 3);
	const idx = new Int32Array(cap);
	let m = 0;
	let minX = Infinity, maxX = -Infinity;
	for (let i = cs; i < c.N; i += stride) {
		if (t[i] > w.cropEndSec) break;
		const x = vPerSec * (t[i] - tCs) * ts;
		pos[m * 3] = x; pos[m * 3 + 1] = p.yOffset; pos[m * 3 + 2] = p.zOffset;
		idx[m] = i;
		m++;
		if (x < minX) minX = x; if (x > maxX) maxX = x;
	}
	if (!m) return null;
	return {
		pos: pos.subarray(0, m * 3), idx: idx.subarray(0, m), count: m,
		bounds: { minX, maxX, minY: p.yOffset, maxY: p.yOffset, minZ: p.zOffset, maxZ: p.zOffset },
	};
}

function buildMachineXyz(
	c: Cache, p: MachineXyzParams, w: PathWindow, cs: number, stride: number,
): PathResult | null {
	const src: Record<'X' | 'Y' | 'Z', Float32Array | undefined> = { X: c.X, Y: c.Y, Z: c.Z };
	const xs = src[p.xKey], ys = src[p.yKey], zs = src[p.zKey];
	if (!xs || !ys || !zs) return null;
	if (xs.length !== c.N || ys.length !== c.N || zs.length !== c.N) return null;

	const t = c.t;
	const ox = p.origin === 'first_sample' ? xs[cs] : 0;
	const oy = p.origin === 'first_sample' ? ys[cs] : 0;
	const oz = p.origin === 'first_sample' ? zs[cs] : 0;
	const cap = Math.max(1, Math.ceil((c.N - cs) / stride) + 1);
	const pos = new Float32Array(cap * 3);
	const idx = new Int32Array(cap);
	let m = 0;
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
	for (let i = cs; i < c.N; i += stride) {
		if (t[i] > w.cropEndSec) break;
		const x = (xs[i] - ox) * p.scale, y = (ys[i] - oy) * p.scale, z = (zs[i] - oz) * p.scale;
		pos[m * 3] = x; pos[m * 3 + 1] = y; pos[m * 3 + 2] = z;
		idx[m] = i;
		m++;
		if (x < minX) minX = x; if (x > maxX) maxX = x;
		if (y < minY) minY = y; if (y > maxY) maxY = y;
		if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
	}
	if (!m) return null;
	return { pos: pos.subarray(0, m * 3), idx: idx.subarray(0, m), count: m, bounds: { minX, maxX, minY, maxY, minZ, maxZ } };
}
