// UK local clock times (Europe/London) for stored UTC instants.

const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

const toMs = (t: string | number): number => (typeof t === 'number' ? t : Date.parse(t));

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
