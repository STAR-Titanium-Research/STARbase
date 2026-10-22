// UK local clock times (Europe/London) for stored UTC instants, and typed UK clock times back to instants.
// The lab reads and types clock times in UK time, which is GMT in winter and BST in summer, so a typed "13:38:20"
// is a different instant on either side of a clock change. This is the one UK-time module: the plotter, the
// Operation page and the Process map all use it.

const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const PARTS = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
	hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const toMs = (t: string | number): number => (typeof t === 'number' ? t : Date.parse(t));
const DISPLAY_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' });

/** `17 Mar 2025` in UK local time, the kit's display form of a date. Empty string for an invalid instant. ISO dates belong in inputs only. */
export function formatUkDate(t: string | number): string {
	const ms = toMs(t);
	return Number.isNaN(ms) ? '' : DISPLAY_DATE.format(ms);
}

/** `17 Mar 2025, 13:38:20` in UK local time. Empty string for an invalid instant. */
export function formatUkDateTimeDisplay(t: string | number): string {
	const ms = toMs(t);
	return Number.isNaN(ms) ? '' : `${DISPLAY_DATE.format(ms)}, ${TIME.format(ms)}`;
}

/** `HH:MM:SS` in UK local time. Empty string for an invalid instant. */
export function formatUkTime(t: string | number): string {
	const ms = toMs(t);
	return Number.isNaN(ms) ? '' : TIME.format(ms);
}

/** `YYYY-MM-DD HH:MM:SS` in UK local time. Empty string for an invalid instant. */
export function formatUkDateTime(t: string | number): string {
	const ms = toMs(t);
	return Number.isNaN(ms) ? '' : `${DATE.format(ms)} ${TIME.format(ms)}`;
}

/** `YYYY-MM-DD` in UK local time. Empty string for an invalid instant. */
export function ukDate(t: string | number): string {
	const ms = toMs(t);
	return Number.isNaN(ms) ? '' : DATE.format(ms);
}

/** The UK wall clock at instant `ms`, as the UTC-epoch the same digits would be (so a difference of two is a length of time on the clock). */
function wallMs(ms: number): number {
	const p: Record<string, number> = {};
	for (const part of PARTS.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant (epoch ms) of a UK clock time written `YYYY-MM-DD HH:MM[:SS]` (a `T` between date and time is fine, as a
 * datetime-local input gives it). NaN for anything else or a day that does not exist. A time the spring clock change skips
 * is read as an hour later (the instant just after the gap); one the autumn change repeats is read as its first occurrence (BST).
 */
export function ukLocalToMs(local: string): number {
	const m = LOCAL.exec(local.trim());
	if (!m) return NaN;
	const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
	const wall = Date.UTC(y, mo - 1, d, h, mi, s);
	const check = new Date(wall);
	if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return NaN;
	// The offset is 0 (GMT) or 1 h (BST): try BST first so a repeated autumn hour reads as its first pass.
	for (const offset of [3_600_000, 0]) {
		const ms = wall - offset;
		if (wallMs(ms) === wall) return ms;
	}
	// In the spring gap neither fits: the clock jumped from 01:00 to 02:00, so read it as GMT (the hour after).
	return wall;
}

/** `YYYY-MM-DDTHH:MM:SS` in UK time, the value of a `datetime-local` input with `step="1"`. Empty string for an invalid instant. */
export function ukInputValue(t: string | number | null | undefined): string {
	if (t === null || t === undefined || t === '') return '';
	const ms = toMs(t);
	if (Number.isNaN(ms)) return '';
	return new Date(wallMs(ms)).toISOString().slice(0, 19);
}
