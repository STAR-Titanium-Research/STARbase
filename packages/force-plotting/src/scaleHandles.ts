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
	// Coincident saturation flags (e.g. a collapsed range): split by which side of them the pointer
	// is, so satMax can still be pulled out rightwards instead of satMin always winning.
	const flags = tied.filter((c) => c.style === 'flag');
	if (!wantCircle && flags.length === 2) {
		const x = (flags[0].pct / 100) * width;
		if (px > x + 0.5) return 'satMax';
		if (px < x - 0.5) return 'satMin';
		return lastDragged === 'satMin' || lastDragged === 'satMax' ? lastDragged : 'satMax';
	}
	return (
		tied.find((c) => (c.style === 'circle') === wantCircle)?.key ??
		tied.find((c) => c.key === lastDragged)?.key ??
		tied[0].key
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
		if (s.symmetrical) {
			const m = Math.max(Math.abs(value), eps);
			return { satMin: -m, satMax: m };
		}
		return key === 'satMin'
			? { satMin: Math.min(value, s.satMax - eps) }
			: { satMax: Math.max(value, s.satMin + eps) };
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
