// Points of interest on the replay timeline (#104): where the cut starts and ends, a human-saved
// crop, and when each axis hit its largest |force|. Computed once per loaded cut, so the transport
// bar can draw them and jump to them without scanning the cache itself.
import type { Cache } from '@d1/force-plotting';

export type MarkerKind = 'cut-start' | 'cut-end' | 'crop' | 'peak';
export interface TimelineMarker {
	/** Cache time (the same base as PlaybackState.tSec). */
	t: number;
	kind: MarkerKind;
	/** The force axis, for a peak marker. */
	axis?: 'Fx' | 'Fy' | 'Fz';
	/**
	 * Where a click should seek, when that is not `t`. A render at time T covers samples [0, T), so
	 * seeking to a peak sample's own time would leave that sample out and show a lower peak; this
	 * is the next sample's time, which includes it (or `t` itself for the last sample).
	 */
	seekT?: number;
	/** Tooltip text. */
	label: string;
}

const AXES = ['Fx', 'Fy', 'Fz'] as const;

/**
 * Markers inside the cache's own time range, sorted by time. A cut start/end equal to the cache's
 * first/last sample is still a marker — for a MATLAB cache, which holds only the cut window, that
 * is exactly where the cut is — but a value outside the range (or not finite) is not.
 */
export function computeMarkers(c: Cache, o: { cropStartSec?: number | null } = {}): TimelineMarker[] {
	if (!c || c.N < 1) return [];
	const t0 = c.t[0], t1 = c.t[c.N - 1];
	// Float32 cache times against float64 header values: allow a hair either side.
	const eps = 1e-4;
	const inRange = (t: number | null | undefined): t is number => t != null && Number.isFinite(t) && t >= t0 - eps && t <= t1 + eps;
	const clamp = (t: number) => Math.min(t1, Math.max(t0, t));
	const out: TimelineMarker[] = [];
	if (inRange(c.csSec)) out.push({ t: clamp(c.csSec), kind: 'cut-start', label: `Cut start · ${c.csSec.toFixed(2)} s` });
	if (inRange(c.ceSec)) out.push({ t: clamp(c.ceSec), kind: 'cut-end', label: `Cut end · ${c.ceSec.toFixed(2)} s` });
	const crop = o.cropStartSec;
	if (inRange(crop) && Math.abs(crop - c.csSec) > eps) {
		out.push({ t: clamp(crop), kind: 'crop', label: `Saved crop start · ${crop.toFixed(2)} s` });
	}
	for (const axis of AXES) {
		const a = c[axis];
		let best = -1, bestAbs = -Infinity;
		for (let i = 0; i < c.N; i++) {
			const v = Math.abs(a[i]);
			if (v > bestAbs) { bestAbs = v; best = i; }
		}
		if (best < 0 || !Number.isFinite(bestAbs)) continue;
		out.push({ t: c.t[best], seekT: best + 1 < c.N ? c.t[best + 1] : c.t[best], kind: 'peak', axis, label: `${axis} peak · ${a[best].toFixed(0)} N at ${c.t[best].toFixed(2)} s` });
	}
	return out.sort((x, y) => x.t - y.t);
}

/** Where a marker sits along the scrub bar, 0..1. */
export function markerFraction(t: number, t0: number, duration: number): number {
	if (!(duration > 0)) return 0;
	return Math.min(1, Math.max(0, (t - t0) / duration));
}
