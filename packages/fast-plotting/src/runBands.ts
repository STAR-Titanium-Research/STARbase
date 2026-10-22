// Geometry of the run-window bands drawn behind a plot (Conform: every run window on the log). Pure, so the
// clipping, the label fitting and the opening zoom are tested without a chart.
import { clock } from './chartMath';
import { formatUkTime } from './conform/clock';
import type { RunWindowBand } from './profile';

/**
 * The time under the pointer. `elapsed` is the time since the log start (what the axis counts); with a clock origin
 * (`startMs`, epoch ms of time zero) `clock` is also the UK local time of day (`wall`), for the tooltip. Without one
 * (FAST) `clock` is the elapsed time and `elapsed` is empty. The axis badge shows `elapsed`, falling back to `clock`.
 */
export function hoverTime(elapsedS: number, startMs: number | null | undefined): { clock: string; elapsed: string; wall: boolean } {
	const elapsed = clock(elapsedS);
	const wall = startMs != null ? formatUkTime(startMs + elapsedS * 1000) : '';
	return { clock: wall || elapsed, elapsed: wall ? elapsed : '', wall: !!wall };
}

/** How a band is drawn: a faint wash over its span, or (the current run, view already on it) just its two edges. */
export interface DrawnBand {
	key: string; x: number; width: number; current: boolean;
	/** The label to print in the top margin (cut to fit, `''` for none) and where it starts. */
	label: string; labelX: number;
	/** `edges`: draw the band as 1px lines at the ends that are in view, no wash. */
	mode: 'wash' | 'edges';
	/** Which ends of the band are inside the view (an end outside it has no edge line). */
	startsInView: boolean; endsInView: boolean;
}

const CHAR_PX = 6.4;   // an average glyph of the 11px chart text

/** A label cut to fit `widthPx` with an ellipsis; empty when not even a few characters fit. */
export function fitLabel(label: string, widthPx: number): string {
	const room = Math.floor((widthPx - 8) / CHAR_PX);
	if (room < 3) return '';
	return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
}

/**
 * Whether the view lies on the band: neither end of the view is more than `tolerance` of the band's length outside it. The
 * plot opens on the run's own window with a little context (see `windowZoom`), so for the current run this is the usual case,
 * and a wash over the whole plot would only grey the data.
 */
export function viewIsOnBand(band: { startS: number; endS: number }, x0: number, x1: number, tolerance = 0.1): boolean {
	const len = band.endS - band.startS;
	return len > 0 && x0 >= band.startS - tolerance * len && x1 <= band.endS + tolerance * len;
}

/**
 * The bands inside the visible window [x0, x1] (seconds), as pixel boxes from `sx`. A band outside it is dropped. The current
 * run's band is drawn as its two edges when the view is on it. A label starts at `labelMinX` at the earliest (the y axis unit
 * sits to its left) and is cut to fit what is left of the band.
 */
export function drawBands(bands: RunWindowBand[], x0: number, x1: number, sx: (t: number) => number, labelMinX = 0): DrawnBand[] {
	const out: DrawnBand[] = [];
	for (const b of bands) {
		const a = Math.max(x0, b.startS), z = Math.min(x1, b.endS);
		if (!(z > a)) continue;
		const x = sx(a), width = sx(z) - x;
		const labelX = Math.max(x + 4, labelMinX);
		out.push({
			key: b.operationId, x, width, current: b.current,
			label: fitLabel(b.label, x + width - labelX + 4), labelX,
			mode: b.current && viewIsOnBand(b, x0, x1) ? 'edges' : 'wash',
			startsInView: b.startS >= x0, endsInView: b.endS <= x1,
		});
	}
	return out;
}

/** The view that opens on a run's window: the window with a little context either side, kept inside the trace. */
export function windowZoom(band: { startS: number; endS: number }, traceStart: number, traceEnd: number, pad = 0.03): { start: number; end: number } | null {
	const len = band.endS - band.startS;
	if (!(len > 0)) return null;
	const margin = Math.max(5, len * pad);
	const start = Math.max(traceStart, band.startS - margin), end = Math.min(traceEnd, band.endS + margin);
	return end > start ? { start, end } : null;
}
