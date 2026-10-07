// Picking and linking helpers shared by the FRM map (FrmCloud, FrmOctree) and the Signals
// charts (ForceChart), so a map point and a moment on a chart can point at each other.
//
// Time is the shared key. The charts plot envelope buckets (a bucket index into
// EnvSeries.t), while the map works in live-cache sample indices (PathResult.idx). The two
// meet through `t`: idxOfTime(cache.t, seconds) turns a chart time into a cache index, and
// cache.t[i] turns a picked point back into a chart time. Decimated caches (compare,
// filtered) keep the true `t`, so the key survives decimation.
//
// Octree points carry no time (only x, y and Fx/Fy/Fz), so an octree pick works by position:
// the octree is built host-side with FIXED geometry (measured tacho speed, auto cut start,
// feed and diameter from the .mat) in the same mm frame as Lite's measured mode, centred on
// the part axis with theta = 0 at the cut start (scripts/matlab/process_force.m:168-176,227
// against the measured branch of path.ts). Rebuilding that path from the live cache with
// octreePathParams() gives every sample an (x, y), which can be projected through the octree
// camera and picked like any other cloud.
import type { Cache } from './liveCache';
import type { PathParams, PathWindow } from './path';
import { nearestIndex } from './hoverIndex';
import { buildWindowF32, type OctreeBuild } from './octreeBuild';
import {
	phase0Samples, spiralAnchor, spiralPlaceInto, spiralPositionInto, spiralRadiusInto, spiralUniformValues,
	type SpiralPos, type SpiralUniformParams,
} from './frmCloudShader';

export interface PointInfo {
	i: number;       // cache sample index
	t: number;       // seconds, on the same axis as the charts
	x: number; y: number;   // mm
	rho?: number;    // mm from the part axis (turning spiral only)
	Fx: number; Fy: number; Fz: number;   // N
	rpm?: number;
}

export interface PointMenuEvent {
	clientX: number; clientY: number;
	point: PointInfo | null;   // null: nothing under the cursor, or the pick can't resolve a sample
	reason?: 'gridded' | 'no-cache' | 'outside-crop' | 'outside-cache' | 'loading';   // why the time items are unavailable
}

/**
 * The index k (0..n-1) whose projected screen position is nearest (px, py) and within
 * radiusPx, or null. `project` returns null for a point that isn't drawn; `keep` filters
 * points out (e.g. hidden by the displayed range). Linear scan: it runs over up to ~3M
 * points per right-click, so the loop does nothing beyond the two callbacks.
 */
export function pickNearest(
	n: number, project: (k: number) => { px: number; py: number } | null,
	px: number, py: number, radiusPx: number, keep?: (k: number) => boolean,
): number | null {
	let best = -1, bestD = radiusPx * radiusPx;
	for (let k = 0; k < n; k++) {
		if (keep && !keep(k)) continue;
		const p = project(k);
		if (!p) continue;
		const dx = p.px - px, dy = p.py - py;
		const d = dx * dx + dy * dy;
		if (d <= bestD) { bestD = d; best = k; }
	}
	return best < 0 ? null : best;
}

/** Everything the menu shows or copies for cache sample i, at map position (x, y). */
export function pointInfo(c: Cache, i: number, x: number, y: number, rho?: number): PointInfo {
	const info: PointInfo = { i, t: c.t[i], x, y, Fx: c.Fx[i], Fy: c.Fy[i], Fz: c.Fz[i] };
	if (rho !== undefined) info.rho = rho;
	if (c.rpm && c.rpm.length > i) info.rpm = c.rpm[i];
	return info;
}

/** Tab-separated "key\tvalue" lines (units in the key), for the clipboard. */
export function formatPointInfo(p: PointInfo): string {
	const rows: [string, number][] = [['i', p.i], ['t (s)', p.t], ['x (mm)', p.x], ['y (mm)', p.y]];
	if (p.rho !== undefined) rows.push(['rho (mm)', p.rho]);
	rows.push(['Fx (N)', p.Fx], ['Fy (N)', p.Fy], ['Fz (N)', p.Fz]);
	if (p.rpm !== undefined) rows.push(['rpm', p.rpm]);
	return rows.map(([k, v]) => `${k}\t${v}`).join('\n');
}

/**
 * A chart zoom window of the same width centred on t, clamped into [min, max] (shifted, never
 * shrunk), so a marker that sits off-screen comes into view. null means "leave the zoom
 * alone": not zoomed (start/end null) or t is already inside [start, end].
 */
export function recentreWindow(
	start: number | null, end: number | null, t: number, min: number, max: number,
): { start: number; end: number } | null {
	if (start == null || end == null) return null;
	if (t >= start && t <= end) return null;
	const w = end - start;
	if (w >= max - min) return { start: min, end: max };
	let s = t - w / 2;
	if (s < min) s = min;
	if (s + w > max) s = max - w;
	return { start: s, end: s + w };
}

/**
 * Position k in the ascending idx[0..count) whose cache index is nearest i (ties to the lower
 * k), or -1 when empty. Rings use this because a strided path doesn't hold every cache index.
 */
export function findNearestPathIndex(idx: Int32Array, count: number, i: number): number {
	return count > 0 ? nearestIndex(idx, i, 0, count - 1) : -1;
}

// ---- small pieces both map views share (FrmCloud, FrmOctree) ----

/** Pick radius in CSS px for a given point size: a few px of slack around even the smallest dot. */
export function pickRadius(pointSize: number | undefined, fallback = 1.5): number {
	return Math.max(8, (pointSize || fallback) * 2);
}

/**
 * Tells a right-click from a right-drag (the map views pan on right-drag): record the right press
 * with `down`, and ask on the right-button release with `up`. The menu opens from the release, not
 * from `contextmenu`: that event fires on button RELEASE only on Windows, while macOS and Linux
 * fire it on press, when a click and a drag can't be told apart yet.
 */
export function createClickTracker(slopPx = 4) {
	let x = NaN, y = NaN;
	const isRight = (ev: PointerEvent) => ev.pointerType === 'mouse' && ev.button === 2;
	return {
		down(ev: PointerEvent) { if (isRight(ev)) { x = ev.clientX; y = ev.clientY; } },
		/** true for a right-button release within slopPx of its press (and forgets the press). */
		up(ev: PointerEvent): boolean {
			if (!isRight(ev) || Number.isNaN(x)) return false;   // not a right release, or no press seen (it began outside the canvas)
			const click = Math.hypot(ev.clientX - x, ev.clientY - y) <= slopPx;
			x = y = NaN;
			return click;
		},
	};
}

/**
 * The displayed-range hide as a pick filter, or undefined when nothing is hidden: a point whose
 * value is outside [dispMin, dispMax] isn't drawn unless greyOutOfRange (colorizeValues and the
 * map shaders' uDisp/uGreyOOR test), so it must not be pickable either.
 */
export function displayedKeep(
	vals: ArrayLike<number> | undefined, idx: Int32Array,
	s: { dispMin: number; dispMax: number; greyOutOfRange?: boolean },
): ((k: number) => boolean) | undefined {
	const keep = displayedKeepIndex(vals, s);
	return keep && ((k) => keep(idx[k]));
}

/** The same rule for a caller that walks cache indices directly (no path idx array). */
export function displayedKeepIndex(
	vals: ArrayLike<number> | undefined,
	s: { dispMin: number; dispMax: number; greyOutOfRange?: boolean },
): ((i: number) => boolean) | undefined {
	if (s.greyOutOfRange || !vals) return undefined;
	return (i) => { const v = vals[i]; return v >= s.dispMin && v <= s.dispMax; };
}

/**
 * Pick on a turning spiral without building a path: walk the samples the GPU draws (phase0Samples),
 * place each with the shader's own maths (spiralPositionInto, nothing allocated per sample), let
 * `project` map (x, y, cache index) to canvas px (null = not drawn), and return the winner with its
 * position recomputed. This is what both map views use for a right-click: a full path costs ~20 B
 * per sample (about 100 MB at 5M), too much to build and drop on every click.
 *
 * `cull` (flat views only: Lite 2D, octree top-down) is the click's world point and a world radius
 * that covers the pick radius (MapProjector.discAt). A spiral is centred on the origin, so a sample
 * at radius rho is at least |rho - rhoClick| from the click; one further than `cull.r` can't be
 * within the pick radius, and is skipped right after the radius step, before the cos/sin, the
 * projection and the keep() test. Same winner as without it, for a fraction of the work.
 *
 * `anchor` is the spiral's r = 0 point; by default the cache sample at the crop start (spiralAnchor).
 * The octree passes the host's own (octreePathParams), which needs no sample at the start.
 */
export function pickSpiral(
	c: Cache, p: Omit<SpiralUniformParams, 'tCs' | 'revsCs'>, cropStart: number, cropEnd: number, stride: number,
	project: (x: number, y: number, i: number) => { px: number; py: number } | null,
	px: number, py: number, radiusPx: number, keep?: (i: number) => boolean,
	cull?: { x: number; y: number; r: number } | null,
	anchor: { tCs: number; revsCs: number } = spiralAnchor(c, cropStart),
): { i: number; x: number; y: number; rho: number } | null {
	const s = phase0Samples(c, cropStart, cropEnd, stride);
	if (!s.n) return null;
	const u = spiralUniformValues({ ...p, ...anchor });
	const out: SpiralPos = { x: 0, y: 0, rho: 0, visible: false };
	const at = (j: number) => (s.k0 + j) * s.stride;
	const rhoClick = cull ? Math.hypot(cull.x, cull.y) : 0, rhoReach = cull ? cull.r : 0;
	const j = pickNearest(s.n, (j) => {
		const i = at(j);
		const r = spiralRadiusInto(u, c.t[i], c.revs[i], cropStart, cropEnd, out);
		if (!out.visible || (cull && Math.abs(out.rho - rhoClick) > rhoReach)) return null;
		spiralPlaceInto(r, out);
		return project(out.x, out.y, i);
	}, px, py, radiusPx, keep && ((j) => keep(at(j))));
	if (j === null) return null;
	const i = at(j);
	spiralPositionInto(u, c.t[i], c.revs[i], cropStart, cropEnd, out);
	return { i, x: out.x, y: out.y, rho: out.rho };
}

/** A ring overlay's next position: `cur` itself when it moved < 0.25 px, so idle redraws don't touch reactivity. */
export function settleRing(
	cur: { x: number; y: number } | null, px: number, py: number,
): { x: number; y: number } {
	return cur && Math.abs(cur.x - px) < 0.25 && Math.abs(cur.y - py) < 0.25 ? cur : { x: px, y: py };
}

/**
 * The path, window and r = 0 anchor that reproduce the octree's own geometry from a live cache:
 * measured tacho speed, and the feed, diameters and ppr the octree was built with.
 *
 * With the build manifest (`build`, d1_build.json) those come from it, and the window is its
 * [cut_start_sec, cut_end_sec] rounded to float32 (the cache's own t precision, see buildWindowF32):
 * the cut the host actually integrated, which differs from the cache's whenever the official crop
 * changed after the live cache was written, or inner diameter / ppr were edited after the build.
 * The anchor is then the manifest's own { cut_start_sec, revs_cs } when it has revs_cs: exact for any
 * cache decimation or crop start, with no cache sample needed at the start. Without revs_cs (an older
 * manifest) it is looked up in the cache at the window start, so the caller checks cacheCoversBuild().
 *
 * Without a manifest (an octree built before it existed) the cache's header feed and diameter, the
 * given innerDiam and ppr, and the whole cache as the window: the live cache IS the octree's window
 * by construction (write_live_cache keeps only the auto-cut samples), so the window is the cache's own
 * first and last `t`. It is NOT csSec/ceSec: those are (cutstart-1)/Fs and (cutend-1)/Fs, which equal
 * t[0]/t[N-1] only while the cache's Time column is exactly (n-1)/Fs; any other Time base would move
 * the spiral's r = 0 anchor off the first sample, and every ring and pick would sit off the octree's
 * points. `rpm` is unused by measured mode; it is set to the last sample's for completeness.
 */
export function octreePathParams(
	c: Cache, innerDiam: number, ppr: number, build?: OctreeBuild | null,
): { path: PathParams; window: PathWindow; anchor: { tCs: number; revsCs: number } } {
	const rpm = c.rpm && c.rpm.length ? c.rpm[c.rpm.length - 1] : 0;
	const path: PathParams = {
		kind: 'turning_spiral', feed: build ? build.feed : c.feed, diam: build ? build.diam : c.diam,
		innerDiam: build ? build.innerDiam : innerDiam,
		speedMode: 'measured', rpm, vc: 0, timeScale: 1, ppr: build ? build.ppr : ppr,
	};
	let window: PathWindow;
	if (build) {
		const w = buildWindowF32(build);
		window = { cropStartSec: w.start, cropEndSec: w.end, stride: 1 };
	} else {
		window = { cropStartSec: c.N ? c.t[0] : 0, cropEndSec: c.N ? c.t[c.N - 1] : 0, stride: 1 };
	}
	const anchor = build && build.revsCs !== undefined
		? { tCs: build.cutStartSec, revsCs: build.revsCs }
		: spiralAnchor(c, window.cropStartSec);
	return { path, window, anchor };
}
