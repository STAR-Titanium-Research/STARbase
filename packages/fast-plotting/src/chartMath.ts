// Pure helpers for the FAST charts and the plot grid: axis ticks, hover lookup, clock labels, series
// styles and tile placement. Kept out of FastChart.vue / FastDashboard.vue so they can be tested.

const NICE = [1, 2, 2.5, 5];

/** The smallest nice step (1, 2, 2.5 or 5 times a power of ten) that is at least `rough`. */
export function niceStep(rough: number, steps: number[] = NICE): number {
	if (!(rough > 0)) return 1;
	const pow = 10 ** Math.floor(Math.log10(rough));
	for (const m of [...steps, 10]) if (m * pow >= rough * (1 - 1e-9)) return m * pow;
	return 10 * pow;
}

const clean = (v: number) => +v.toPrecision(12);

/**
 * Ticks for a value axis: nice steps, about `target` of them, the first at or below the data minimum and
 * the last strictly above the data maximum (so the line never touches the top of the plot).
 */
export function niceTicks(lo: number, hi: number, target = 5): { ticks: number[]; step: number } {
	if (!(hi > lo)) hi = lo + 1;
	const step = niceStep((hi - lo) / target);
	const first = Math.floor(lo / step + 1e-9), last = Math.floor(hi / step + 1e-9) + 1;
	const ticks: number[] = [];
	for (let k = first; k <= last; k++) ticks.push(clean(k * step));
	return { ticks, step };
}

/** Ticks inside [lo, hi] only, for an axis whose range is fixed (the time axis). */
export function ticksWithin(lo: number, hi: number, target: number, steps: number[] = NICE): { ticks: number[]; step: number } {
	const step = niceStep((hi - lo) / Math.max(1, target), steps);
	const ticks: number[] = [];
	for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) ticks.push(clean(k * step));
	return { ticks, step };
}

function decimals(step: number): number {
	const s = String(clean(step));
	const dot = s.indexOf('.');
	return dot < 0 ? 0 : s.length - dot - 1;
}

/** A tick label: as many decimals as the step needs, a real minus sign. */
export function tickLabel(v: number, step: number): string {
	return v.toFixed(decimals(step)).replace('-', '−');
}

/** A unit as printed: the catalog stores degrees Celsius as "C". */
export function unitLabel(unit: string): string {
	return unit === 'C' ? '°C' : unit;
}

/** The index of the sample nearest to time `t` in an ascending time array. */
export function indexAt(time: ArrayLike<number>, t: number): number {
	let lo = 0, hi = time.length - 1;
	if (hi < 0) return -1;
	while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (time[mid] <= t) lo = mid; else hi = mid; }
	return Math.abs(time[hi] - t) < Math.abs(time[lo] - t) ? hi : lo;
}

/** Elapsed seconds as a clock: 18:00, or 1:02:03 from an hour. */
export function clock(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const [h, m, ss] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
	const two = (v: number) => String(v).padStart(2, '0');
	return h ? `${h}:${two(m)}:${two(ss)}` : `${two(m)}:${two(ss)}`;
}

// Series 1-3 take the chart tokens, with the token's own value as the fallback (outside the kit's frame
// they are not defined). Each series after the first also gets a dash pattern, so hue is never the only cue.
const SERIES_COLOURS = ['var(--d1-series-1, #2a78d6)', 'var(--d1-series-2, #eb6834)', 'var(--d1-series-3, #1baf7a)'];
const SERIES_DASHES: Array<string | null> = [null, '6 3', '2 3', '8 3 2 3', '4 2', '1 3'];
export function seriesStyle(index: number): { color: string; dash: string | null } {
	return { color: SERIES_COLOURS[index % SERIES_COLOURS.length], dash: SERIES_DASHES[index % SERIES_DASHES.length] };
}

export type TileSpan = 'sm' | 'wide' | 'tall' | 'big';
export interface Placement { row: number; col: number; rowSpan: number; colSpan: number; }

/**
 * Where a 2-wide (or `cols`-wide) CSS grid puts the tiles, in order, the way `grid-auto-flow: row` does
 * (the cursor only moves forward). A single column ignores the spans. `rows` is the grid's row count.
 */
export function placeTiles(spans: TileSpan[], cols: number): { placements: Placement[]; rows: number } {
	const taken = new Set<string>();
	const placements: Placement[] = [];
	let row = 0, col = 0, rows = 0;
	for (const span of spans) {
		const colSpan = cols < 2 ? 1 : span === 'wide' || span === 'big' ? 2 : 1;
		const rowSpan = cols < 2 ? 1 : span === 'tall' || span === 'big' ? 2 : 1;
		const fits = (r: number, c: number) => {
			if (c + colSpan > cols) return false;
			for (let i = 0; i < rowSpan; i++) for (let j = 0; j < colSpan; j++) if (taken.has(`${r + i},${c + j}`)) return false;
			return true;
		};
		while (!fits(row, col)) { col++; if (col >= cols) { col = 0; row++; } }
		for (let i = 0; i < rowSpan; i++) for (let j = 0; j < colSpan; j++) taken.add(`${row + i},${col + j}`);
		placements.push({ row, col, rowSpan, colSpan });
		rows = Math.max(rows, row + rowSpan);
		col += colSpan;
		if (col >= cols) { col = 0; row++; }
	}
	return { placements, rows };
}
