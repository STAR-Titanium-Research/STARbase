// The one way a Conform figure is written: the Operation page, the plotter and the PDF appendix all use these formats.
//   energy in kWh to 2 decimals; average demand in kW to 2 decimals;
//   a length of time under an hour as `12 min 05 s`, otherwise `1 h 23 min`; clock times `HH:MM:SS` in UK time.
// Pure: no Vue, no I/O.
import { formatUkDateTimeDisplay, formatUkTime } from './clock';

/** What a figure with no reading prints as: an em dash, with no unit. */
export const DASH = '—';

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `n` to `digits` decimals with no unit, or null when there is no reading. */
export function fixed(n: number | null | undefined, digits: number): string | null {
	return finite(n) ? n.toFixed(digits) : null;
}

/** The number of an energy in kWh, 2 decimals (`7.52`); null for no reading. The unit is `KWH_UNIT`. */
export const kwhNumber = (n: number | null | undefined): string | null => fixed(n, 2);
export const KWH_UNIT = 'kWh';
export const KW_UNIT = 'kW';

/** `7.52 kWh`; a dash for no reading. */
export function formatKwh(n: number | null | undefined): string {
	const v = fixed(n, 2);
	return v === null ? DASH : `${v} ${KWH_UNIT}`;
}

/** `30.70 kW`; a dash for no reading. */
export function formatKw(n: number | null | undefined): string {
	const v = fixed(n, 2);
	return v === null ? DASH : `${v} ${KW_UNIT}`;
}

/** A length of time: `12 min 05 s` under an hour, `1 h 23 min` from an hour. A dash for no reading. */
export function formatDuration(seconds: number | null | undefined): string {
	if (!finite(seconds) || seconds < 0) return DASH;
	const s = Math.round(seconds);
	if (s < 3600) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
	return `${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} min`;
}

/** `13:38:20 – 13:53:19` in UK time; empty when either end is missing. */
export function formatClockRange(start: string | null | undefined, end: string | null | undefined): string {
	return start && end ? `${formatUkTime(start)} – ${formatUkTime(end)}` : '';
}

// ---- choosing a log that is already uploaded (the Operation page and the plotter word it the same way)

/** One line of a log in a picker: its file name and when it starts, in UK time (`run.csv · 17 Mar 2025, 09:00:00`). */
export const candidateLabel = (l: { source_filename: string; log_start: string }): string => `${l.source_filename} · ${formatUkDateTimeDisplay(l.log_start)}`;

/** What the picker says when no log qualifies. Without a run date the search is around today. */
export function candidatesEmptyText(operationDate: string | null | undefined): string {
	return operationDate
		? "No Conform log from this machine starts within a day of this run's date."
		: 'No Conform log from this machine starts within a day of today (this run has no date).';
}

/** A run window on a log, as `Ti swarf: 13:38:20 – 13:53:19`. */
export const windowLine = (w: { label: string; start: string; end: string }): string => `${w.label}: ${formatClockRange(w.start, w.end)}`;

/**
 * The note for a log whose whole length is one run's window, so no other run can take any of it. The plan's wording:
 * "The whole log is <label>'s window: narrow that run's window first". A run the reader cannot see is "another run".
 */
export function wholeLogNote(
	log: { log_start: string; log_end: string },
	windows: { label: string; readable?: boolean; start: string; end: string }[],
): string | null {
	const start = Date.parse(log.log_start);
	const end = Date.parse(log.log_end);
	const w = windows.find((x) => Date.parse(x.start) <= start && Date.parse(x.end) >= end);
	if (!w) return null;
	const who = w.readable === false ? 'another run' : w.label;
	return `The whole log is ${who}'s window: narrow that run's window first`;
}

// ---- one table of Conform figures (labels in sentence case, units, number rule), for all three surfaces

/**
 * DESIGN.md 5b's number rule: integers from 100, one decimal from 10, up to two below, without trailing zeros.
 * Null for no reading.
 */
export function niceNumber(n: number | null | undefined): string | null {
	if (!finite(n)) return null;
	const a = Math.abs(n);
	const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
	return String(Number(n.toFixed(digits)));
}

type FigureKind = 'nice' | 'kwh' | 'kw' | 'duration';
export interface ConformFigure { label: string; unit: string; kind: FigureKind }

/** Every Conform summary figure, keyed by its `ConformSummary` key (energy parts as `energy_<part>`). */
export const CONFORM_FIGURES = {
	duration_s: { label: 'Duration', unit: '', kind: 'duration' },
	extruding_s: { label: 'Extruding time', unit: '', kind: 'duration' },
	mean_wheel_speed_rpm: { label: 'Mean wheel speed', unit: 'rpm', kind: 'nice' },
	mean_torque_pct: { label: 'Mean motor torque', unit: '%', kind: 'nice' },
	mean_tooling1_c: { label: 'Mean tooling 1', unit: '°C', kind: 'nice' },
	peak_torque_pct: { label: 'Peak motor torque', unit: '%', kind: 'nice' },
	peak_motor_current_a: { label: 'Peak motor current', unit: 'A', kind: 'nice' },
	peak_tooling1_c: { label: 'Peak tooling 1', unit: '°C', kind: 'nice' },
	peak_wheel_temp_c: { label: 'Peak wheel temperature', unit: '°C', kind: 'nice' },
	ips_setpoint_c: { label: 'IPS setpoint', unit: '°C', kind: 'nice' },
	energy_motor: { label: 'Motor energy', unit: KWH_UNIT, kind: 'kwh' },
	energy_ips: { label: 'IPS energy', unit: KWH_UNIT, kind: 'kwh' },
	energy_cooling: { label: 'Cooling energy', unit: KWH_UNIT, kind: 'kwh' },
	energy_total: { label: 'Total energy', unit: KWH_UNIT, kind: 'kwh' },
	avg_demand_kw: { label: 'Average demand', unit: KW_UNIT, kind: 'kw' },
} as const satisfies Record<string, ConformFigure>;
export type ConformFigureKey = keyof typeof CONFORM_FIGURES;

/** The number of a figure without its unit (`402`, `8.04`, `7.52`, `12 min 05 s`), or null for no reading. */
export function figureNumber(key: ConformFigureKey, value: number | null | undefined): string | null {
	const f: ConformFigure = CONFORM_FIGURES[key];
	if (!finite(value)) return null;
	if (f.kind === 'duration') return formatDuration(value);
	if (f.kind === 'kwh' || f.kind === 'kw') return fixed(value, 2);
	return niceNumber(value);
}

/** A figure with its unit (`402 °C`, `7.52 kWh`, `12 min 05 s`), or an em dash with no unit for no reading. */
export function formatFigure(key: ConformFigureKey, value: number | null | undefined): string {
	const n = figureNumber(key, value);
	if (n === null) return DASH;
	const unit = CONFORM_FIGURES[key].unit;
	return unit ? `${n} ${unit}` : n;
}

// ---- the run status, worded and toned the same on every surface

export type ConformStatus = 'no_log' | 'no_window' | 'done' | 'error';
export type ConformTone = 'neutral' | 'warning' | 'success' | 'danger';
export const CONFORM_STATUS: Record<ConformStatus, { label: string; tone: ConformTone; hint: string }> = {
	no_log: { label: 'No log', tone: 'neutral', hint: 'No Conform log is linked to this run' },
	no_window: { label: 'No run window', tone: 'warning', hint: 'A log is linked, but the run window is not set' },
	done: { label: 'Window set', tone: 'success', hint: 'The run window and its summary are saved' },
	error: { label: 'Failed', tone: 'danger', hint: 'The log could not be processed' },
};
