// Turning what was typed into the run window's two ends (the Operation page's date-time fields). Pure.
//
// The fields show UK clock times to the second, but a stored window can have fractions of a second (a view saved from the
// plotter, a log whose rows are not on whole seconds). A field the user did not touch therefore keeps its stored instant
// exactly; truncating it to the second would move the window and could push it outside the log. A field the user did
// edit is read as a UK clock time and clamped to the log, and the person is told when that moved it.
import { formatUkDateTime, ukInputValue, ukLocalToMs } from './clock';

export type WindowResolution =
	| { ok: true; startMs: number; endMs: number; notes: string[] }
	| { ok: false; error: string };

/** What the two fields hold (UK local, as a datetime-local input gives it), the stored window, and the log it lies on. */
export function resolveWindowEntry(
	typed: { startLocal: string; endLocal: string },
	stored: { start: string | null; end: string | null },
	log: { log_start: string; log_end: string },
): WindowResolution {
	const lo = Date.parse(log.log_start);
	const hi = Date.parse(log.log_end);
	const notes: string[] = [];

	const read = (text: string, storedIso: string | null, which: 'start' | 'end'): number => {
		if (storedIso && text === ukInputValue(storedIso)) return Date.parse(storedIso);   // untouched: the exact instant
		const ms = ukLocalToMs(text);
		if (Number.isNaN(ms)) return NaN;
		if (ms < lo) {
			notes.push(`The ${which} was before the log, so it was moved to the log's first row (${formatUkDateTime(lo)}, UK time).`);
			return lo;
		}
		if (ms > hi) {
			notes.push(`The ${which} was after the log, so it was moved to the log's last row (${formatUkDateTime(hi)}, UK time).`);
			return hi;
		}
		return ms;
	};

	const startMs = read(typed.startLocal, stored.start, 'start');
	const endMs = read(typed.endLocal, stored.end, 'end');
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { ok: false, error: 'Enter the start and end of the run window as UK clock times.' };
	if (!(startMs < endMs)) return { ok: false, error: 'The window must start before it ends.' };
	return { ok: true, startMs, endMs, notes };
}
