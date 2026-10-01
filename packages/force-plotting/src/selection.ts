// Shared selection state for the Diagnostics Workbench: a WorkingSet is the decimated,
// off-GPU point set the D1AN file provides; a Selection is a predicate over it, evaluated the
// same way regardless of which panel produced it (time brush in the Signal panel, attribute
// threshold or spatial lasso or a cluster pick in the Spatial panel) -- that symmetry is what
// makes cross-panel highlighting work without each panel needing to know about the others.
import type { DiagAttrs } from './diagAttrs';

/** Every per-point channel the diag pipeline produces, camelCased. Defined once here and
 *  imported wherever a channel is named (the Spatial selector, DiagScatter, RecipePanel). */
export type ChannelKey =
	| 'tsaResid' | 'residZ' | 'giStar' | 'giSig' | 'clusterId' | 'glosh' | 'envBand' | 'segmentId'
	| 'inverted' | 'gridFill' | 'gridSupport' | 'gmmId' | 'gmmProb';

export interface WorkingSet {
	n: number;
	t: Float32Array;
	rev: Float32Array;
	x: Float32Array;
	y: Float32Array;
	tsaResid: Float32Array;
	residZ: Float32Array;
	giStar: Float32Array;
	giSig: Float32Array;
	clusterId: Float32Array;
	glosh: Float32Array;
	envBand: Float32Array;
	segmentId: Float32Array;
	inverted: Float32Array;
	gridFill: Float32Array;
	gridSupport: Float32Array;
	gmmId: Float32Array;
	gmmProb: Float32Array;
}

// snake_case D1AN column -> camelCase WorkingSet field. Every column here must also be in
// scripts/diag/runner.py::PUBLIC_COLUMNS, or every preview/bake response fails this check.
const COLUMN_MAP: Record<string, keyof WorkingSet> = {
	t: 't', rev: 'rev', x: 'x', y: 'y',
	tsa_resid: 'tsaResid', resid_z: 'residZ', gi_star: 'giStar', gi_sig: 'giSig',
	cluster_id: 'clusterId', glosh: 'glosh', env_band: 'envBand', segment_id: 'segmentId',
	inverted: 'inverted', grid_fill: 'gridFill', grid_support: 'gridSupport',
	gmm_id: 'gmmId', gmm_prob: 'gmmProb',
};

// A file missing one of these is not a usable diag artifact -- every bake and preview has
// always produced them, so absence means real corruption, not staleness.
const REQUIRED_COLUMNS = new Set([
	't', 'rev', 'x', 'y', 'tsa_resid', 'resid_z', 'gi_star', 'gi_sig',
	'cluster_id', 'glosh', 'env_band', 'segment_id',
]);

// Phase H slice 2 added these columns to PUBLIC_COLUMNS without bumping DIAG_VERSION -- a row
// baked before that ships an attrs.d1an with only the 12 REQUIRED_COLUMNS. That is not
// corruption, it is "these steps were never run on this bake", which is exactly what each
// value here already means when a fresh bake has them at their documented neutral fill
// (runner.py::PUBLIC_COLUMNS's fill-default logic). Missing is backfilled the same way,
// rather than thrown on, so an old bake keeps loading until it is naturally re-baked.
const NEUTRAL_FILL: Record<string, number> = {
	inverted: 0, grid_fill: 0, grid_support: 0, gmm_id: -1, gmm_prob: 0,
};

export function workingSetFromD1an(attrs: DiagAttrs): WorkingSet {
	for (const col of REQUIRED_COLUMNS) {
		if (!(col in attrs.columns)) {
			throw new Error(`D1AN file is missing required column '${col}'`);
		}
	}
	const ws = { n: attrs.n } as WorkingSet;
	for (const [snake, camel] of Object.entries(COLUMN_MAP)) {
		const col = attrs.columns[snake] ?? new Float32Array(attrs.n).fill(NEUTRAL_FILL[snake] ?? 0);
		(ws as unknown as Record<string, Float32Array>)[camel] = col;
	}
	return ws;
}

/** Read one channel's value for point `i`. Used by the shader-free JS predicate path. */
export const CHANNEL_ACCESSOR: Record<ChannelKey, (ws: WorkingSet, i: number) => number> = {
	tsaResid: (ws, i) => ws.tsaResid[i],
	residZ: (ws, i) => ws.residZ[i],
	giStar: (ws, i) => ws.giStar[i],
	giSig: (ws, i) => ws.giSig[i],
	clusterId: (ws, i) => ws.clusterId[i],
	glosh: (ws, i) => ws.glosh[i],
	envBand: (ws, i) => ws.envBand[i],
	segmentId: (ws, i) => ws.segmentId[i],
	inverted: (ws, i) => ws.inverted[i],
	gridFill: (ws, i) => ws.gridFill[i],
	gridSupport: (ws, i) => ws.gridSupport[i],
	gmmId: (ws, i) => ws.gmmId[i],
	gmmProb: (ws, i) => ws.gmmProb[i],
};

export type Selection =
	| { kind: 'time'; t0: number; t1: number }
	| { kind: 'attribute'; column: ChannelKey; min: number; max: number }
	| { kind: 'lasso'; polygon: [number, number][] }
	| { kind: 'cluster'; id: number }
	| null;

// Standard even-odd ray-casting point-in-polygon test.
function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		const crosses = yi > py !== yj > py;
		if (crosses && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

export function matches(ws: WorkingSet, sel: Selection, i: number): boolean {
	if (sel == null) return true;
	switch (sel.kind) {
		case 'time':
			return ws.t[i] >= sel.t0 && ws.t[i] <= sel.t1;
		case 'attribute': {
			const v = CHANNEL_ACCESSOR[sel.column](ws, i);
			// A NaN (a masked-out point) is never "in range".
			return Number.isFinite(v) && v >= sel.min && v <= sel.max;
		}
		case 'lasso':
			return pointInPolygon(ws.x[i], ws.y[i], sel.polygon);
		case 'cluster':
			return ws.clusterId[i] === sel.id;
		default:
			return false;
	}
}

export interface SelectionStats {
	n: number;
	tMin: number;
	tMax: number;
	rMin: number;
	rMax: number;
	meanResidZ: number;
}

const ZERO_STATS: SelectionStats = { n: 0, tMin: 0, tMax: 0, rMin: 0, rMax: 0, meanResidZ: 0 };

export function computeStats(ws: WorkingSet, sel: Selection): SelectionStats {
	let n = 0;
	let tMin = Infinity;
	let tMax = -Infinity;
	let rMin = Infinity;
	let rMax = -Infinity;
	let sum = 0;
	for (let i = 0; i < ws.n; i++) {
		if (!matches(ws, sel, i)) continue;
		// Skip masked-out points (NaN residZ): they must not pull the mean or count.
		if (!Number.isFinite(ws.residZ[i])) continue;
		n++;
		const t = ws.t[i];
		if (t < tMin) tMin = t;
		if (t > tMax) tMax = t;
		const r = Math.hypot(ws.x[i], ws.y[i]);
		if (r < rMin) rMin = r;
		if (r > rMax) rMax = r;
		sum += ws.residZ[i];
	}
	if (n === 0) return { ...ZERO_STATS };
	return { n, tMin, tMax, rMin, rMax, meanResidZ: sum / n };
}

export interface ClusterRow {
	/** HDBSCAN cluster id; -1 is the noise "cluster". */
	id: number;
	n: number;
	/** n / ws.n, so the rows sum to 1. */
	fraction: number;
	/** null when the row came from a viewport recompute, whose response carries only
	 *  {x, y, cluster_id} -- there is no resid_z/gi_star for those points to average. The
	 *  table renders null as "—" rather than borrowing the bake's numbers for other points. */
	meanAbsResidZ: number | null;
	maxGiStar: number | null;
	rMin: number;
	rMax: number;
}

/** Per-cluster summary over the whole WorkingSet. Sorted by size descending; the noise row
 *  (id -1), if present, always sorts last regardless of size. */
export function clusterStats(ws: WorkingSet): ClusterRow[] {
	// n counts cluster membership (from cluster_id, valid even for a masked point); the
	// residZ / giStar accumulators only take finite contributions, so a partly- or
	// fully-masked cluster yields a real number, never NaN (mirrors the maxGi === -Infinity
	// guard below).
	const acc = new Map<number, { n: number; nFinite: number; sumAbs: number; maxGi: number; rMin: number; rMax: number }>();
	for (let i = 0; i < ws.n; i++) {
		const id = ws.clusterId[i];
		let a = acc.get(id);
		if (!a) {
			a = { n: 0, nFinite: 0, sumAbs: 0, maxGi: -Infinity, rMin: Infinity, rMax: -Infinity };
			acc.set(id, a);
		}
		a.n++;
		if (Number.isFinite(ws.residZ[i])) {
			a.nFinite++;
			a.sumAbs += Math.abs(ws.residZ[i]);
		}
		if (Number.isFinite(ws.giStar[i]) && ws.giStar[i] > a.maxGi) a.maxGi = ws.giStar[i];
		const r = Math.hypot(ws.x[i], ws.y[i]);
		if (r < a.rMin) a.rMin = r;
		if (r > a.rMax) a.rMax = r;
	}
	const rows: ClusterRow[] = [];
	for (const [id, a] of acc) {
		rows.push({
			id,
			n: a.n,
			fraction: ws.n ? a.n / ws.n : 0,
			meanAbsResidZ: a.nFinite ? a.sumAbs / a.nFinite : 0,
			maxGiStar: a.maxGi === -Infinity ? 0 : a.maxGi,
			rMin: a.rMin === Infinity ? 0 : a.rMin,
			rMax: a.rMax === -Infinity ? 0 : a.rMax,
		});
	}
	rows.sort((p, q) => {
		if (p.id === -1) return 1;
		if (q.id === -1) return -1;
		return q.n - p.n;
	});
	return rows;
}

/** 1st/99th percentile of the finite values -- NaN is dropped, since a masked channel (resid_z
 *  under a paint mask) is full of it. [0, 1] when nothing is finite. */
export function percentileRange(a: Float32Array): [number, number] {
	const s = Float32Array.from(a).filter((v) => Number.isFinite(v)).sort();
	if (s.length === 0) return [0, 1];
	const lo = s[Math.floor(0.01 * (s.length - 1))];
	const hi = s[Math.floor(0.99 * (s.length - 1))];
	return hi > lo ? [lo, hi] : [lo, lo + 1];
}
