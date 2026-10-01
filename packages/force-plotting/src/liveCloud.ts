// Colourises a tool path built by path.ts into a renderable point cloud. Positions used
// to be computed here directly (a hardcoded turning spiral); that geometry now lives in
// path.ts (buildPath) so it can be swapped for a straight pass or real machine XYZ. This
// file's only job is: pick points along the path, look up their channel value, map to a
// colour. See docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md §3.
import type { Cache } from './liveCache';
import { buildPath, type PathBounds, type PathParams, type PathWindow } from './path';

export type SpeedMode = 'measured' | 'rpm' | 'vc';
export type Axis = 'Fx' | 'Fy' | 'Fz';
export type CloudChannel = 'Fx' | 'Fy' | 'Fz' | 'Mz';

export interface CloudParams {
	channel: CloudChannel;
	path: PathParams;
	window: PathWindow;
	gridding: boolean;     // bin into a grid (mean colour per cell) vs raw scatter
	gridN: number;         // grid resolution per axis when gridding
	// Optional: when omitted `col` is not built (FrmCloud colours from `val` via colorizeValues).
	colormap?: (x: number) => [number, number, number];
	// Manual colour-scale limits (N). When either is null/undefined the limit is auto-computed
	// from the data (prctile 1 / 99, mirroring process_force.m's canonical FRM colour scale).
	cmin?: number | null;
	cmax?: number | null;
	// Optional force-as-height overlay for a flat path (turning spiral / linear feed); ignored
	// for a machine_xyz path, which already carries real Z.
	zSeries?: 'none' | CloudChannel;
}

export interface Cloud {
	pos: Float32Array;   // stride 3
	col?: Float32Array;  // stride 3, rgb 0..1 -- only when CloudParams.colormap is given
	count: number;
	bounds: PathBounds;
	cmin: number; cmax: number;   // colour-scale limits actually applied (for the colorbar)
	val: Float32Array;   // the channel value behind each point's colour, so a host can recolour without a rebuild
	zv?: Float32Array;  // centred -0.5..0.5 force-as-height, only set for flat (z-constant) paths
}

function percentile(sorted: Float32Array, p: number): number {
	const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
	return sorted[i];
}

// Auto colour limits (prctile 1/99) over the WHOLE cached channel array — NOT the current crop
// and NOT decimation-dependent. Sampled to ~400k for speed. Returns [0, 1] for a missing/empty
// channel array (e.g. axisAutoLimits(c, 'Mz') on a cache with no torque channel).
// Memoised per (cache object, channel): the dashboard and each FRM pane ask for the same range.
const autoLimitsMemo = new WeakMap<Cache, Map<CloudChannel, [number, number]>>();
export function axisAutoLimits(c: Cache, channel: CloudChannel): [number, number] {
	let byChannel = autoLimitsMemo.get(c);
	if (!byChannel) { byChannel = new Map(); autoLimitsMemo.set(c, byChannel); }
	let r = byChannel.get(channel);
	if (!r) { r = computeAutoLimits(c, channel); byChannel.set(channel, r); }
	return r;
}
function computeAutoLimits(c: Cache, channel: CloudChannel): [number, number] {
	const a = (c as any)[channel] as Float32Array | undefined;
	if (!a || a.length === 0) return [0, 1];
	const stride = Math.max(1, Math.floor(a.length / 400_000));
	const s = new Float32Array(Math.ceil(a.length / stride));
	for (let i = 0, k = 0; i < a.length; i += stride, k++) s[k] = a[i];
	s.sort();
	let lo = percentile(s, 1), hi = percentile(s, 99);
	if (!(hi > lo)) { lo = s[0]; hi = s[s.length - 1]; if (!(hi > lo)) hi = lo + 1; }
	// A channel carrying NaN sorts those to the END, so the fallback above can pick one up and
	// then `hi = lo + 1` propagates it. Callers feed this straight into shader uniforms and into
	// the colour-scale editor's axis, where a single NaN bound silently blanks the whole render
	// (NaN fails every comparison), so never hand one back.
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [0, 1];
	return [lo, hi];
}

export function buildCloud(c: Cache, p: CloudParams): Cloud | null {
	const path = buildPath(c, p.path, p.window);
	if (!path) return null;

	// Guard the channel lookup the same way axisAutoLimits above does: a CloudChannel value
	// (e.g. 'Mz') that the cache simply doesn't carry (a v1/no-trailer file) must produce "no
	// data", never an index-into-undefined crash.
	const channelArr = (c as any)[p.channel] as Float32Array | undefined;
	if (!channelArr || channelArr.length === 0) return null;
	const m = path.count;
	const fv = new Float32Array(m);
	for (let k = 0; k < m; k++) fv[k] = channelArr[path.idx[k]];

	// colour scale: manual limits when supplied, else percentile-clamped like the app —
	// prctile(DATA,1) / prctile(DATA,99), matching process_force.m's prctile(cc,[1 99]).
	// The sort is O(N log N) on up to millions of points, so only pay for it when a limit is
	// actually auto-derived (or the supplied pair is degenerate).
	let sorted: Float32Array | null = null;
	const getSorted = () => (sorted ??= fv.slice().sort());
	let lo = Number.isFinite(p.cmin as number) ? (p.cmin as number) : percentile(getSorted(), 1);
	let hi = Number.isFinite(p.cmax as number) ? (p.cmax as number) : percentile(getSorted(), 99);
	if (!(hi > lo)) { const s = getSorted(); lo = s[0]; hi = s[s.length - 1]; if (!(hi > lo)) hi = lo + 1; }
	const span = hi - lo || 1;

	// Optional force-as-height overlay. Gated on the PATH'S OWN Z actually being flat
	// (bounds.minZ === maxZ), not on path.kind — a turning_spiral/linear_feed path is always
	// flat, but so is a machine_xyz path over a single constant-depth pass (today's real milling
	// captures, once that path model has a data source). In that case there is no genuine 3D
	// shape to lose, so the overlay is exactly as valid as for the other two path kinds. A
	// machine_xyz path with real depth variation has minZ !== maxZ and correctly keeps its own
	// Z untouched below.
	const isFlatZ = path.bounds.minZ === path.bounds.maxZ;
	let zSrc: Float32Array | null = null;
	if (isFlatZ && p.zSeries && p.zSeries !== 'none') zSrc = ((c as any)[p.zSeries] as Float32Array | undefined) ?? null;

	// zlo/zhi computed ONCE, over the whole (ungridded) window, so the gridded and raw-scatter
	// renders of the same window normalise `zv` identically — computed here, before the gridding
	// branch, specifically so gridCloud can share it rather than losing the overlay entirely.
	let zlo = Infinity, zhi = -Infinity;
	if (zSrc) for (let k = 0; k < m; k++) { const v = zSrc[path.idx[k]]; if (v < zlo) zlo = v; if (v > zhi) zhi = v; }
	const zspan = (zhi - zlo) || 1;

	if (p.gridding) return gridCloud(path, fv, lo, span, p, zSrc, zlo, zspan);

	const pos = new Float32Array(m * 3);
	const cm = p.colormap, col = cm ? new Float32Array(m * 3) : undefined;
	let zv: Float32Array | undefined;
	if (zSrc) zv = new Float32Array(m);
	for (let k = 0; k < m; k++) {
		pos[k * 3] = path.pos[k * 3]; pos[k * 3 + 1] = path.pos[k * 3 + 1];
		pos[k * 3 + 2] = zSrc ? 0 : path.pos[k * 3 + 2];   // machine_xyz's real Z passes through when there's no overlay
		if (col) { const [rr, gg, bb] = cm!((fv[k] - lo) / span); col[k * 3] = rr; col[k * 3 + 1] = gg; col[k * 3 + 2] = bb; }
		if (zv && zSrc) zv[k] = (zSrc[path.idx[k]] - zlo) / zspan - 0.5;
	}
	return { pos, col, count: m, bounds: path.bounds, cmin: lo, cmax: hi, val: fv, zv };
}

// Bin the scatter into a gridN x gridN grid on X/Y; emit one point per non-empty cell at its
// centre, coloured by the mean channel value there, at the MEAN Z of the points in that cell.
// This is a 2.5-D reduction: two points at the same (x,y) but different z (e.g. a repeated axial
// pass) collapse into one cell. For a flat path every z is identical so this changes nothing.
// Also emits `zv` (mean force-as-height per cell, normalised against the SAME zlo/zspan the
// ungridded path uses) whenever an overlay is requested — gridding must not silently drop the
// 3D overlay the way it used to before this seam existed.
function gridCloud(
	path: { pos: Float32Array; idx: Int32Array; count: number; bounds: PathBounds },
	fv: Float32Array, lo: number, span: number, p: CloudParams, zSrc: Float32Array | null,
	zlo: number, zspan: number,
): Cloud {
	const { minX, maxX, minY, maxY } = path.bounds;
	const G = Math.max(8, Math.round(p.gridN) || 400);
	const wx = (maxX - minX) || 1, wy = (maxY - minY) || 1;
	const m = path.count;
	const sum = new Float64Array(G * G), sumZ = new Float64Array(G * G), cnt = new Uint32Array(G * G);
	for (let k = 0; k < m; k++) {
		const x = path.pos[k * 3], y = path.pos[k * 3 + 1];
		// Bin the OVERLAY series (zSrc) when one is requested, else the path's own Z — matching
		// the ungridded path's convention that zSrc, not real Z, drives height once an overlay
		// is active.
		const z = zSrc ? zSrc[path.idx[k]] : path.pos[k * 3 + 2];
		let gx = Math.floor(((x - minX) / wx) * (G - 1e-9));
		let gy = Math.floor(((y - minY) / wy) * (G - 1e-9));
		if (gx < 0) gx = 0; else if (gx >= G) gx = G - 1;
		if (gy < 0) gy = 0; else if (gy >= G) gy = G - 1;
		const idx2 = gy * G + gx;
		sum[idx2] += fv[k]; sumZ[idx2] += z; cnt[idx2]++;
	}
	const cx = wx / G, cy = wy / G;
	const xsg: number[] = [], ysg: number[] = [], zsg: number[] = [], cg: number[] = [];
	for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
		const idx2 = gy * G + gx; const n = cnt[idx2]; if (!n) continue;
		xsg.push(minX + (gx + 0.5) * cx); ysg.push(minY + (gy + 0.5) * cy);
		zsg.push(sumZ[idx2] / n); cg.push(sum[idx2] / n);
	}
	const n = cg.length;
	const pos = new Float32Array(n * 3);
	const cm = p.colormap, col = cm ? new Float32Array(n * 3) : undefined;
	let zv: Float32Array | undefined;
	if (zSrc) zv = new Float32Array(n);
	for (let k = 0; k < n; k++) {
		pos[k * 3] = xsg[k]; pos[k * 3 + 1] = ysg[k];
		pos[k * 3 + 2] = zSrc ? 0 : zsg[k];   // real (unbinned-overlay) Z; zero when the overlay drives height instead
		if (col) { const [rr, gg, bb] = cm!((cg[k] - lo) / span); col[k * 3] = rr; col[k * 3 + 1] = gg; col[k * 3 + 2] = bb; }
		if (zv) zv[k] = (zsg[k] - zlo) / zspan - 0.5;
	}
	return { pos, col, count: n, bounds: path.bounds, cmin: lo, cmax: lo + span, val: Float32Array.from(cg), zv };
}

// ---- colormaps (0..1 -> rgb 0..1) ----
// NaN fails both comparisons below and falls through unclamped — exactly the kind of invalid
// vertex-colour value that renders as undefined (often solid white) garbage on the GPU. Defend
// here too, not just at the buildCloud call site, since colormap functions are also used directly
// (e.g. the colorbar gradient in FrmCloud.vue).
const clamp01 = (v: number) => (Number.isNaN(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);

// True viridis via linear interpolation over the reference control points
// (matplotlib == MATLAB viridis, sampled at 0.1 spacing). A polynomial fit — the
// old approach — overshoots and drifts off the green→yellow ramp; piecewise-linear
// over these anchors tracks the real map closely and matches process_force.m's
// colormap(ax, viridis). For pixel-exact output, the host MATLAB render is the
// source of truth; this is the interactive Live approximation.
const VIRIDIS_ANCHORS: [number, number, number][] = [
	[0.267004, 0.004874, 0.329415], // 0.0
	[0.282623, 0.140926, 0.457517], // 0.1
	[0.253935, 0.265254, 0.529983], // 0.2
	[0.206756, 0.371758, 0.553117], // 0.3
	[0.163625, 0.471133, 0.558148], // 0.4
	[0.127568, 0.566949, 0.550556], // 0.5
	[0.134692, 0.658636, 0.517649], // 0.6
	[0.266941, 0.748751, 0.440573], // 0.7
	[0.477504, 0.821444, 0.318195], // 0.8
	[0.741388, 0.873449, 0.149561], // 0.9
	[0.993248, 0.906157, 0.143936], // 1.0
];

function lutLerp(anchors: [number, number, number][], x: number): [number, number, number] {
	x = clamp01(x);
	const last = anchors.length - 1;
	const s = x * last;
	const i = Math.min(last - 1, Math.floor(s));
	const f = s - i;
	const a = anchors[i], b = anchors[i + 1];
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function viridis(x: number): [number, number, number] { return lutLerp(VIRIDIS_ANCHORS, x); }
function inferno(x: number): [number, number, number] {
	x = clamp01(x);
	const r = -0.0002 + x * (0.1065 + x * (11.6035 + x * (-42.1403 + x * (60.1300 + x * (-35.0665 + x * 7.3641)))));
	const g = 0.0009 + x * (-0.3852 + x * (2.1873 + x * (-2.4184 + x * (2.7095 + x * (-1.8895 + x * 0.4443)))));
	const b = 0.0139 + x * (2.9950 + x * (-16.0958 + x * (40.6117 + x * (-46.3423 + x * (24.0722 + x * -4.6595)))));
	return [clamp01(r), clamp01(g), clamp01(b)];
}
function grayscale(x: number): [number, number, number] { const v = clamp01(x); return [v, v, v]; }

// CloudCompare's own scalar-field ramps, added for the colour-scale editor port. BGYR is
// CloudCompare's default scale and the one the port's plan names explicitly; BWR is its diverging
// scale, which is what the signed-force cases this feature is built around (symmetrical about
// zero, symmetric log) actually want -- a sequential ramp buries the sign change those modes exist
// to expose, since +50 N and -50 N land at opposite ends of the ramp with no visual "zero".
const BGYR_ANCHORS: [number, number, number][] = [
	[0, 0, 1],   // blue
	[0, 1, 0],   // green
	[1, 1, 0],   // yellow
	[1, 0, 0],   // red
];
const BWR_ANCHORS: [number, number, number][] = [
	[0, 0, 1],   // blue
	[1, 1, 1],   // white (lands on zero under a symmetrical range)
	[1, 0, 0],   // red
];
function bgyr(x: number): [number, number, number] { return lutLerp(BGYR_ANCHORS, x); }
function bwr(x: number): [number, number, number] { return lutLerp(BWR_ANCHORS, x); }

export const COLORMAPS: Record<string, (x: number) => [number, number, number]> = {
	viridis, inferno, grayscale, bgyr, bwr,
};

// Display names for the keys above. Keys stay short and stable (they're persisted in
// workspace.plot.colormap and passed in the live pop-out's querystring); this is purely what a
// picker shows, so every consumer spells them the same way.
export const COLORMAP_LABELS: Record<string, string> = {
	viridis: 'Viridis',
	inferno: 'Inferno',
	grayscale: 'Greyscale',
	bgyr: 'Blue → Green → Yellow → Red',
	bwr: 'Blue → White → Red',
};
export function colormapLabel(key: string): string { return COLORMAP_LABELS[key] ?? key; }
