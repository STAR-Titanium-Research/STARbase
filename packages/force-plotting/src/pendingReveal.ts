// The "reveal this time once the map is ready" request both map views (FrmCloud, FrmOctree) hold.
// A chart's "show on map" can arrive before the view has a camera, a cache or uploaded geometry
// (first activation, a cut still loading), so the request waits here and the view's draw/render
// loop applies it once it can. It is a single slot, not a queue: only the latest request matters,
// and a different cut makes any held request meaningless, so the view drops it then.

export function createPendingReveal() {
	let t: number | null = null;
	return {
		/** Keep `sec` until the view can apply it (replaces any earlier request). */
		hold(sec: number) { t = sec; },
		/** Forget the request: a different cut, or the time turned out to be unmappable. */
		drop() { t = null; },
		/** Whether a request is waiting (a cheap test for a per-frame loop). */
		get held(): boolean { return t != null; },
		/** The held time, clearing it; null when none. Call it only once the view CAN apply it. */
		take(): number | null { const v = t; t = null; return v; },
	};
}
