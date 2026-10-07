// The octree build manifest (`d1_build.json`, published by scripts/force_orchestrator.py next to
// metadata.json): the geometry and cut window the host actually integrated the spiral with. The map
// rebuilds the octree's path from the live cache, so it needs those values, not whatever the row says
// now (inner diameter, ppr and the official crop can all change after a build). Octrees built before
// the manifest existed have none: callers fall back to the cache window and row values.
import type { Cache } from './liveCache';

export interface OctreeBuild {
	feed: number; diam: number; innerDiam: number; ppr: number;   // mm/rev, mm, mm, pulses per rev
	cutStartSec: number; cutEndSec: number;   // the file's Time axis, the same as the live cache's `t`
	// Cumulative raw revolutions at cutStartSec in the live cache's `revs` units (host-integrated, a
	// double): the exact r = 0 anchor, independent of the cache's float32 t and any decimation.
	// Absent in manifests written before it existed: the anchor is then looked up in the cache.
	revsCs?: number;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The manifest as an OctreeBuild, or null for anything that isn't a well-formed schema 1 manifest
 * (wrong schema, a missing or non-finite number, ppr <= 0, an end before the start). Null means
 * "ignore it": a half-trusted manifest would misplace every pick, while the old fallback only misses.
 */
export function parseOctreeBuild(raw: unknown): OctreeBuild | null {
	if (!raw || typeof raw !== 'object') return null;
	const m = raw as Record<string, unknown>;
	if (m.schema !== 1) return null;
	if (!num(m.feed) || !num(m.diam) || !num(m.inner_diam) || !num(m.ppr)
		|| !num(m.cut_start_sec) || !num(m.cut_end_sec)) return null;
	if (m.ppr <= 0 || m.cut_end_sec < m.cut_start_sec) return null;
	const out: OctreeBuild = {
		feed: m.feed, diam: m.diam, innerDiam: m.inner_diam, ppr: m.ppr,
		cutStartSec: m.cut_start_sec, cutEndSec: m.cut_end_sec,
	};
	if (num(m.revs_cs)) out.revsCs = m.revs_cs;   // optional: a malformed one is the same as absent
	return out;
}

/**
 * The build's window as the cache's float32 `t` sees it. The cache stores t as float32 but the manifest
 * holds doubles, so a start of k/Fs is not a float32 value: compared as a double it falls above the
 * cache's own first sample (~48% of starts) and the shader's `aT >= cropStart` test would drop it.
 * Rounding both ends the way the cache was written (single(t)) keeps exactly the samples inside.
 */
export function buildWindowF32(build: OctreeBuild): { start: number; end: number } {
	return { start: Math.fround(build.cutStartSec), end: Math.fround(build.cutEndSec) };
}

/** Half a sample: how far before t[0] a build's cut start may be and still land on the cache's first sample. */
export function cacheEpsilon(c: Cache): number {
	return c.N > 1 ? Math.max(1e-6, (c.t[1] - c.t[0]) / 2) : 1e-6;
}

/**
 * Can the r = 0 anchor be placed? With the manifest's revs_cs it always can (it is the anchor's own
 * value, whatever the cache holds). Without it (an older manifest) the anchor is looked up in the cache,
 * so the cache has to reach back to the cut start. No build, or an empty cache, is not a conflict.
 */
export function cacheCoversBuild(c: Cache, build: OctreeBuild | null | undefined): boolean {
	if (!build || !c.N || build.revsCs !== undefined) return true;
	return buildWindowF32(build).start >= c.t[0] - cacheEpsilon(c);
}

/**
 * The span of time the map can place a sample for: the build's window intersected with the cache's own
 * t range (the cache's range alone without a build). A crop that starts before the cache maps the
 * overlap. null when the two don't overlap, or (no revs_cs) the cache doesn't cover the build's start.
 */
export function mappableWindow(c: Cache, build?: OctreeBuild | null): { start: number; end: number } | null {
	if (!c.N) return null;
	const lo = c.t[0], hi = c.t[c.N - 1];
	if (!build) return { start: lo, end: hi };
	if (!cacheCoversBuild(c, build)) return null;
	const w = buildWindowF32(build);
	const start = Math.max(lo, w.start), end = Math.min(hi, w.end);
	return end >= start ? { start, end } : null;
}

/**
 * Why the octree map has no geometry to pick with: 'no-cache' (no sample cache for this cut), or
 * 'loading' (the cache is here but the build manifest fetch hasn't settled, so the geometry isn't known yet).
 */
export function noGeometryReason(haveCache: boolean, buildReady: boolean): 'no-cache' | 'loading' {
	return haveCache && !buildReady ? 'loading' : 'no-cache';
}
