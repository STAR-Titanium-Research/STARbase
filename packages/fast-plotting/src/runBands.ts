// Geometry of the run-window bands drawn behind a plot (Conform: every run window on the log). Pure, so the
// clipping, the label fitting and the opening zoom are tested without a chart.
import { clock } from './chartMath';
import { formatUkTime } from './conform/clock';
import type { RunWindowBand } from './profile';

/**
 * The time shown under the pointer. With a clock origin (`startMs`, epoch ms of time zero) it is the UK local time
 * of day with the elapsed time beside it; without one (FAST) it is the elapsed time alone.
 */
export function hoverTime(elapsedS: number, startMs: number | null | undefined): { clock: string; elapsed: string; wall: boolean } {
	const elapsed = clock(elapsedS);
	const wall = startMs != null ? formatUkTime(startMs + elapsedS * 1000) : '';
	return { clock: wall || elapsed, elapsed: wall ? elapsed : '', wall: !!wall };
}

export interface DrawnBand { key: string; x: number; width: number; label: string; current: boolean }

const CHAR_PX = 6.4;   // an average glyph of the 11px chart text

/** A label cut to fit `widthPx` with an ellipsis; empty when not even a few characters fit. */
export function fitLabel(label: string, widthPx: number): string {
	const room = Math.floor((widthPx - 8) / CHAR_PX);
	if (room < 3) return '';
	return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
}

/** The bands inside the visible window [x0, x1] (seconds), as pixel boxes from `sx`. A band outside it is dropped. */
export function drawBands(bands: RunWindowBand[], x0: number, x1: number, sx: (t: number) => number): DrawnBand[] {
	const out: DrawnBand[] = [];
	for (const b of bands) {
		const a = Math.max(x0, b.startS), z = Math.min(x1, b.endS);
		if (!(z > a)) continue;
		const x = sx(a), width = sx(z) - x;
		out.push({ key: b.operationId, x, width, label: fitLabel(b.label, width), current: b.current });
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
