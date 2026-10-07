// Pure geometry for ColorScaleEditor.vue's four draggable handles. Extracted from the component
// so it can be tested directly: the tie-breaking below looks like an edge case but is the normal
// state of a freshly seeded scale, and got it wrong once already (see pickHandle).
import type { Histogram } from './histogram';
import type { ColorScale } from './colorScale';

export type HandleKey = 'satMin' | 'satMax' | 'dispMin' | 'dispMax';
export type HandleStyle = 'flag' | 'circle';

export interface HandleGeom {
	key: HandleKey;
	style: HandleStyle;
	pct: number;       // 0..100 across the strip
	dotY?: number;     // flags only: the curve-riding dot's y, top-down px
}

export const HIT_PX = 10;

/**
 * Half-height of the band around a displayed-range circle that belongs to it rather than to a
 * co-located saturation flag. Deliberately narrow: a flag draws a triangle, a full-height stem AND
 * a dot on the curve, so all of that should stay grabbable -- only the circle's immediate
 * neighbourhood goes to the circle.
 */
export const CIRCLE_BAND_PX = 12;

/**
 * Nearest handle within `HIT_PX` of `px`, or null. Handles routinely share an x position, so ties
 * are split vertically: a grab within `CIRCLE_BAND_PX` of mid-height takes the displayed-range
 * circle, anything else takes the saturation flag whose stem runs the full height there.
 *
 * Why ties are the normal case, not an edge case: the strip's domain is the auto-detected data
 * range, which is also what seeds satMin/satMax -- so satMin sits exactly at the left edge, where
 * a wide-open dispMin (the OPEN_DISP default) also clamps to. A tie-break that just preferred
 * saturation left dispMin impossible to drag on every freshly seeded scale; a nearest-anchor one
 * over-corrected and gave the circle everything below a quarter height, so the flag's own stem
 * stopped responding wherever the two shared an x.
 */
export function pickHandle(
	handles: HandleGeom[], px: number, py: number, width: number, height: number,
	lastDragged?: HandleKey | null,
): HandleKey | null {
	const candidates = handles
		.map((h) => ({ ...h, dist: Math.abs((h.pct / 100) * width - px) }))
		.filter((h) => h.dist <= HIT_PX);
	if (!candidates.length) return null;
	const best = Math.min(...candidates.map((c) => c.dist));
	// Within a pixel counts as tied -- an exact float comparison missed co-located handles whose
	// positions differed only by rounding.
	const tied = candidates.filter((c) => c.dist <= best + 1);
	if (tied.length === 1) return tied[0].key;
	const wantCircle = Math.abs(py - height / 2) <= CIRCLE_BAND_PX;
	// A pointer in the circle band belongs to a circle, anywhere else to a flag -- unless the tie
	// has none of that style, in which case whatever is there.
	const group = tied.some((c) => (c.style === 'circle') === wantCircle)
		? tied.filter((c) => (c.style === 'circle') === wantCircle)
		: tied;
	if (group.length === 1) return group[0].key;
	// Two ends of the same range sitting on top of each other (a collapsed range, or an open
	// displayed range clamped to the same edge): split by which side of them the pointer is, so
	// either end can be pulled out -- picking the first always left the other one unreachable.
	const lows = group.filter((c) => c.key === 'satMin' || c.key === 'dispMin');
	const highs = group.filter((c) => c.key === 'satMax' || c.key === 'dispMax');
	const x = (group[0].pct / 100) * width;
	if (px > x + 0.5 && highs.length) return highs[0].key;
	if (px < x - 0.5 && lows.length) return lows[0].key;
	return (
		group.find((c) => c.key === lastDragged)?.key ??
		highs[0]?.key ??
		group[0].key
	);
}

/**
 * The ColorScale fields a drag of `key` to `value` should set.
 *
 * Under `symmetrical` a saturation drag has to move BOTH ends: applyParams derives the symmetric
 * magnitude as max(|satMin|, |satMax|), so setting just the dragged end leaves the opposite one
 * holding the larger magnitude and the drag is immediately undone -- dragging satMax from 35 down
 * to 30 against satMin = -35 recomputes M = 35 and snaps it straight back, i.e. the handle looks
 * frozen. Mirroring both ends is also what CloudCompare does in this mode.
 */
export function handleDragPatch(
	s: ColorScale, key: HandleKey, value: number, eps: number,
): Partial<ColorScale> {
	if (key === 'satMin' || key === 'satMax') {
		// The unshaped range a shaping param is applied to (see ColorScale.baseMin). A drag edits the
		// base, so the shaped satMin/satMax follow and unticking the param restores a sensible range.
		const bMin = s.baseMin ?? s.satMin, bMax = s.baseMax ?? s.satMax;
		if (s.symmetrical) {
			const m = Math.max(Math.abs(value), eps);
			// The dragged side sets the magnitude; the other base end keeps whatever fits inside it.
			let lo = key === 'satMin' ? -m : Math.max(bMin, -m);
			let hi = key === 'satMax' ? m : Math.min(bMax, m);
			if (!(hi > lo)) { lo = -m; hi = m; }
			return { satMin: -m, satMax: m, baseMin: lo, baseMax: hi };
		}
		// Clamp against the SHAPED range (satMin/satMax), not the base: with always-show-zero on and a
		// base of [25, 35] the shaped range is [0, 35], so satMax may be dragged down to ~0 even
		// though that is below the base's own minimum. When the dragged end passes the opposite BASE
		// end, the base slides along at its own width rather than the handle sticking at that end.
		const width = bMax - bMin;
		if (key === 'satMin') {
			const v = Math.min(value, s.satMax - eps);
			return bMax < v + eps ? { satMin: v, baseMin: v, baseMax: v + width } : { satMin: v, baseMin: v };
		}
		const v = Math.max(value, s.satMin + eps);
		return bMin > v - eps ? { satMax: v, baseMax: v, baseMin: v - width } : { satMax: v, baseMax: v };
	}
	return key === 'dispMin'
		? { dispMin: Math.min(value, s.dispMax - eps) }
		: { dispMax: Math.max(value, s.dispMin + eps) };
}

/**
 * Height of the distribution curve at value `v`, as 0..1 of the chart. Linearly interpolated
 * between bin centres -- a close (sub-pixel at these sizes) approximation of ColorBar's smoothed
 * path rather than an exact solve of it, which is enough for a marker to visually sit ON the curve.
 */
export function curveHeightFrac(histogram: Histogram | null | undefined, v: number): number {
	const h = histogram;
	if (!h || !h.bins.length || h.max <= 0 || !Number.isFinite(v)) return 0;
	const n = h.bins.length;
	const bspan = h.hi > h.lo ? h.hi - h.lo : 1e-9;
	const t = ((v - h.lo) / bspan) * n - 0.5;      // position in bin-centre space
	const i0 = Math.floor(t);
	const f = t - i0;
	const at = (i: number) => h.bins[Math.max(0, Math.min(n - 1, i))] / h.max;
	const y = at(i0) + (at(i0 + 1) - at(i0)) * f;
	return Math.max(0, Math.min(1, y));
}
