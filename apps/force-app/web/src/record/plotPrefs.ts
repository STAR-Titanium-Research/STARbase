// The Record page's plot options (time window, FRM axis/colormap/point size/stride, polar
// settings), persisted across launches (#108). The grid layout was already remembered; these
// reset to their defaults on every start.
//
// Parsed field by field: a value from an older build, a hand edit, or a half-written entry
// falls back to that field's default instead of reaching a plot as NaN or an unknown enum, and
// one bad field never costs the others.
import { COLORMAPS } from '@d1/force-plotting';
import { clampWindowSec, DEFAULT_WINDOW_SEC } from './plotWindow';

export type Axis = 'Fx' | 'Fy' | 'Fz';
export interface PlotPrefs {
	forceMode: 'time' | 'fft'; frmAxis: Axis; colormap: string; pointSize: number; windowSec: number; liveFrmStride: number;
	polarRadius: 'Mz' | 'Fz' | 'Fxy'; polarAngleSource: 'tacho' | 'force_vector'; polarBins: number;
}

export const PLOT_PREFS_KEY = 'force-app.record.plot.v1';
/** FrmPanel's live-map decimation choices. */
export const FRM_STRIDES = [1, 2, 5, 10, 25, 50];

export function defaultPlotPrefs(): PlotPrefs {
	return {
		forceMode: 'time', frmAxis: 'Fz', colormap: 'viridis', pointSize: 1.8, windowSec: DEFAULT_WINDOW_SEC, liveFrmStride: 1,
		polarRadius: 'Fz', polarAngleSource: 'tacho', polarBins: 36,
	};
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], d: T): T {
	return allowed.includes(v as T) ? (v as T) : d;
}
function num(v: unknown, lo: number, hi: number, d: number): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}

/** Stored JSON (or null) -> a complete, valid PlotPrefs. Never throws. */
export function parsePlotPrefs(raw: string | null): PlotPrefs {
	const d = defaultPlotPrefs();
	let o: any;
	try { o = raw ? JSON.parse(raw) : null; } catch { return d; }
	if (!o || typeof o !== 'object' || Array.isArray(o)) return d;
	return {
		forceMode: oneOf(o.forceMode, ['time', 'fft'] as const, d.forceMode),
		frmAxis: oneOf(o.frmAxis, ['Fx', 'Fy', 'Fz'] as const, d.frmAxis),
		colormap: typeof o.colormap === 'string' && Object.prototype.hasOwnProperty.call(COLORMAPS, o.colormap) ? o.colormap : d.colormap,
		pointSize: num(o.pointSize, 1, 5, d.pointSize),
		windowSec: clampWindowSec(o.windowSec, d.windowSec),
		liveFrmStride: oneOf(o.liveFrmStride, FRM_STRIDES, d.liveFrmStride),
		polarRadius: oneOf(o.polarRadius, ['Mz', 'Fz', 'Fxy'] as const, d.polarRadius),
		polarAngleSource: oneOf(o.polarAngleSource, ['tacho', 'force_vector'] as const, d.polarAngleSource),
		polarBins: Math.round(num(o.polarBins, 4, 720, d.polarBins)),
	};
}

export function loadPlotPrefs(): PlotPrefs {
	try { return parsePlotPrefs(localStorage.getItem(PLOT_PREFS_KEY)); } catch { return defaultPlotPrefs(); }
}

export function savePlotPrefs(p: PlotPrefs): void {
	try { localStorage.setItem(PLOT_PREFS_KEY, JSON.stringify(p)); } catch { /* storage full or blocked: not worth an error */ }
}
