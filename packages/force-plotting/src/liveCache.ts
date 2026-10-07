// Parsed live-cache store, kept in a SEPARATE module so the LRU map is a true
// singleton — evaluated once and shared across every FrmCloud mount. (Declaring it
// at the top of a <script setup> would instead recreate it on each mount, since
// setup() runs per-instance, defeating the "keep the data for a bit after switching
// operations" requirement.)

export interface Cache {
	N: number; Fs: number; feed: number; diam: number; csSec: number; ceSec: number;
	t: Float32Array; Fx: Float32Array; Fy: Float32Array; Fz: Float32Array;
	rpm: Float32Array; revs: Float32Array;
	// D1LC v2 trailer fields (see write_d1lc's `extras` parameter). Absent on a v1 file, or on
	// a v2 file that simply doesn't carry that channel.
	Mz?: Float32Array; X?: Float32Array; Y?: Float32Array; Z?: Float32Array;
	// Optional so hand-built test fixtures (and any other in-memory Cache construction) don't
	// need to set it; parseCache always populates it from the real file's header.
	version?: number;
}

// First index with t[i] >= sec (binary search over a sorted time axis). Returns t.length-1
// for a `sec` past the end (callers that need a distinct "nothing here" break on t[i] > end),
// and -1 for an empty array. The single copy: path.ts, polar.ts and signalStats.ts all used
// to carry their own byte-identical version.
export function idxOfTime(t: Float32Array, sec: number): number {
	if (t.length === 0) return -1;
	let lo = 0, hi = t.length - 1, ans = t.length - 1;
	while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] >= sec) { ans = m; hi = m - 1; } else lo = m + 1; }
	return ans;
}

// A plot stride as every builder applies it (a positive integer, 1 when unset or invalid). One copy,
// because a pick has to walk exactly the samples a renderer drew: path.ts, polar.ts and the GPU
// static attributes (frmCloudShader.ts) all use it.
export function normStride(stride: number): number { return Math.max(1, Math.round(stride) || 1); }

const MAGIC = 0x44314c43; // 'D1LC'
const KNOWN_TRAILER_NAMES = ['Mz', 'X', 'Y', 'Z'] as const;

// Parse live_cache.bin (little-endian): 32-byte header then six float32[N] arrays, then
// (version >= 2 only) a trailer of named float32[N] extras. Layout MUST match
// scripts/matlab/process_force.m's write_live_cache and apps/force-app/backend/app/d1lc.py.
// A v1 file (or a header with no version byte set, as in legacy fixtures) parses to exactly
// the six mandatory arrays; the optional trailer fields stay undefined.
export function parseCache(ab: ArrayBuffer): Cache {
	const dv = new DataView(ab);
	if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad live-cache magic');
	const version = dv.getUint32(4, true);
	const N = dv.getUint32(8, true);
	const Fs = dv.getFloat32(12, true);
	const feed = dv.getFloat32(16, true);
	const diam = dv.getFloat32(20, true);
	const csSec = dv.getFloat32(24, true);
	const ceSec = dv.getFloat32(28, true);
	let off = 32;
	const take = () => { const a = new Float32Array(ab, off, N); off += N * 4; return a; };
	const t = take(), Fx = take(), Fy = take(), Fz = take(), rpm = take(), revs = take();
	const cache: Cache = { N, Fs, feed, diam, csSec, ceSec, t, Fx, Fy, Fz, rpm, revs, version };

	if (version >= 2 && off + 4 <= ab.byteLength) {
		const extraCount = dv.getUint32(off, true); off += 4;
		for (let e = 0; e < extraCount; e++) {
			if (off + 8 > ab.byteLength) break;
			const nameBytes = new Uint8Array(ab, off, 8); off += 8;
			let name = '';
			for (let i = 0; i < 8 && nameBytes[i] !== 0; i++) name += String.fromCharCode(nameBytes[i]);
			if (off + N * 4 > ab.byteLength) break;
			const arr = new Float32Array(ab, off, N); off += N * 4;
			if ((KNOWN_TRAILER_NAMES as readonly string[]).includes(name)) (cache as any)[name] = arr;
			// unknown names are read past (to keep `off` correct for subsequent entries) and dropped
		}
	}
	return cache;
}

// Decimate a cache by keeping every `stride`-th sample (indices 0, stride, 2·stride…),
// matching the filter-service's slice exactly. Used in compare mode so the raw pane plots
// the SAME sample set as the service-decimated filtered pane — identical spiral positions,
// only the force (colour) differs.
export function decimateCache(c: Cache, stride: number): Cache {
	if (stride <= 1) return c;
	const pick = (a: Float32Array) => {
		const n = Math.ceil(a.length / stride);
		const o = new Float32Array(n);
		for (let i = 0, k = 0; i < a.length; i += stride, k++) o[k] = a[i];
		return o;
	};
	const out: Cache = {
		...c, N: Math.ceil(c.N / stride), t: pick(c.t), Fx: pick(c.Fx), Fy: pick(c.Fy), Fz: pick(c.Fz),
		rpm: pick(c.rpm), revs: pick(c.revs),
	};
	if (c.Mz) out.Mz = pick(c.Mz);
	if (c.X) out.X = pick(c.X);
	if (c.Y) out.Y = pick(c.Y);
	if (c.Z) out.Z = pick(c.Z);
	return out;
}

export interface EnvSeries { t: number[]; min: number[]; max: number[] }

// Bucketed min/max envelope for ForceDashboard's ForceChart (kind='env'), which reads its plot
// data from machining_force_analysis.series — a JSONB column, NOT the live_cache_file binary.
// The MATLAB/crawler ingestion pipeline populates this column; force-app's direct-upload path
// (uploadCutToDatabase/uploadCaptureColdStart) has to build the same shape itself, or the chart
// silently renders "no data" despite the peaks/FRM map all working fine off live_cache_file —
// exactly the bug this fixes. Bucketed (not one point per sample) to keep the JSON payload sane:
// a full-resolution 300k-point cache would serialise to tens of MB, when a chart only ever needs
// enough resolution for its pixel width.
export function buildSeriesEnvelope(c: Cache, buckets = 2000): { Fx: EnvSeries; Fy: EnvSeries; Fz: EnvSeries; RPM: EnvSeries } {
	const n = c.N;
	const stride = Math.max(1, Math.ceil(n / buckets));
	const nb = Math.ceil(n / stride);
	const mk = (): EnvSeries => ({ t: new Array(nb), min: new Array(nb), max: new Array(nb) });
	const out = { Fx: mk(), Fy: mk(), Fz: mk(), RPM: mk() };
	const srcs = { Fx: c.Fx, Fy: c.Fy, Fz: c.Fz, RPM: c.rpm };
	for (let b = 0, i0 = 0; i0 < n; b++, i0 += stride) {
		const i1 = Math.min(n, i0 + stride);
		out.Fx.t[b] = out.Fy.t[b] = out.Fz.t[b] = out.RPM.t[b] = c.t[i0];
		for (const key of ['Fx', 'Fy', 'Fz', 'RPM'] as const) {
			const src = srcs[key];
			let lo = Infinity, hi = -Infinity;
			for (let i = i0; i < i1; i++) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
			out[key].min[b] = lo; out[key].max[b] = hi;
		}
	}
	return out;
}

// Generic single-series version of buildSeriesEnvelope's min/max bucketing, for callers that
// aren't a D1LC Cache -- e.g. the Diagnostics Workbench's WorkingSet (t, resid_z), which is
// already decimated to the WorkingSet floor (>=5M points) but still far too many for ForceChart
// to render one SVG path point per sample without redrawing a multi-MB path on every crop-drag
// pointer frame.
export function bucketEnvelope(t: Float32Array, v: Float32Array, buckets = 2000): EnvSeries {
	const n = Math.min(t.length, v.length);
	const stride = Math.max(1, Math.ceil(n / buckets));
	const nb = Math.ceil(n / stride);
	const out: EnvSeries = { t: new Array(nb), min: new Array(nb), max: new Array(nb) };
	for (let b = 0, i0 = 0; i0 < n; b++, i0 += stride) {
		const i1 = Math.min(n, i0 + stride);
		out.t[b] = t[i0];
		let lo = Infinity, hi = -Infinity;
		for (let i = i0; i < i1; i++) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
		out.min[b] = lo; out.max[b] = hi;
	}
	return out;
}

// Module-scoped LRU: survives component unmount, so revisiting a recently-viewed
// operation is instant and issues no network request.
const MEM = new Map<string, Cache>();
const MEM_CAP = 6;

export function cacheGet(id: string): Cache | undefined {
	const v = MEM.get(id);
	if (v) { MEM.delete(id); MEM.set(id, v); }   // bump to most-recent
	return v;
}
export function cachePut(id: string, v: Cache) {
	MEM.set(id, v);
	while (MEM.size > MEM_CAP) MEM.delete(MEM.keys().next().value as string);
}
