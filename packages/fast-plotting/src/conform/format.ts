// The one way a Conform figure is written: the Operation page, the plotter and the PDF appendix all use these formats.
//   energy in kWh to 2 decimals; average demand in kW to 2 decimals;
//   a length of time under an hour as `12 min 05 s`, otherwise `1 h 23 min`; clock times `HH:MM:SS` in UK time.
// Pure: no Vue, no I/O.
import { formatUkDateTime, formatUkTime } from './clock';

export const DASH = '–';

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

/** One line of a log in a picker: its file name and when it starts, in UK time. */
export const candidateLabel = (l: { source_filename: string; log_start: string }): string => `${l.source_filename} · ${formatUkDateTime(l.log_start)}`;

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
