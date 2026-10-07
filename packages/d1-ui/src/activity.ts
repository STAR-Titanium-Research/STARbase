// Activity binning for the Sparkline: dates in, per-ISO-week counts out.
//
// Weeks are ISO 8601 weeks (Monday first; week 1 holds the first Thursday of the year), taken in
// the browser's local time because that is the calendar the researcher sees. A date is counted in
// the week of its local calendar day, so the bins are correct across year boundaries: 2026-12-31
// and 2027-01-01 are both in ISO week 53 of 2026, one bin, labelled by the Monday that starts it.
//
// Why the pages bin on the client rather than with `aggregate` + `groupBy=week(date)`:
//   - `operation_date` and `session_date` are TIMESTAMPTZ, so a plain groupBy on them is one
//     group per timestamp, and the date-function form (`year(...)`, `week(...)`) answers with
//     keys that depend on the database driver;
//   - SQL `week()` is the ISO week but `year()` is the calendar year, so the pair (year, week)
//     puts 1 January 2027 into "week 53 of 2027", a bin that does not exist. Only the client can
//     assign both from the same Monday.
// So the pages read only the date (and the parent id) of the rows inside the window, newest first,
// capped (see `ACTIVITY_ROW_CAP` in activityRows.ts), and bin here. Rows beyond the cap are the
// oldest ones, and the caller shows a "truncated" note.

export const DEFAULT_WEEKS = 26;

export interface WeekInfo {
	/** The Monday that starts the week, as YYYY-MM-DD (local calendar). */
	start: string;
	isoYear: number;
	isoWeek: number;
}

export interface WeeklyActivity {
	/** Oldest first; the last entry is the week containing `now`. */
	weeks: WeekInfo[];
	ops: number[];
	tests: number[];
	totalOps: number;
	totalTests: number;
}

const DAY_MS = 86_400_000;

function ymd(d: Date): string {
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

// Local midnight of the Monday of the week containing `d`.
export function weekStart(d: Date): Date {
	const day = (d.getDay() + 6) % 7; // Monday = 0
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

// ISO week number and ISO week-year of a local calendar day.
export function isoWeek(d: Date): { isoYear: number; isoWeek: number } {
	// The Thursday of this week decides the year; week 1 is the week with the year's first Thursday.
	const monday = weekStart(d);
	const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
	const isoYear = thursday.getFullYear();
	const dayOfYear = Math.round(
		(Date.UTC(thursday.getFullYear(), thursday.getMonth(), thursday.getDate()) - Date.UTC(isoYear, 0, 1)) / DAY_MS,
	);
	return { isoYear, isoWeek: Math.floor(dayOfYear / 7) + 1 };
}

// The `count` Mondays ending with the week that contains `now`, oldest first.
export function lastWeeks(count: number, now: Date = new Date()): WeekInfo[] {
	const n = Math.max(0, Math.floor(count));
	const current = weekStart(now);
	const out: WeekInfo[] = [];
	for (let i = n - 1; i >= 0; i--) {
		// Built from the calendar fields, not by subtracting milliseconds: a DST change must not
		// move a Monday to the Sunday before it.
		const monday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7 * i);
		out.push({ start: ymd(monday), ...isoWeek(monday) });
	}
	return out;
}

// First instant of the oldest week in the window, as an ISO string for a `_gte` filter.
export function windowStart(count: number = DEFAULT_WEEKS, now: Date = new Date()): string {
	const first = lastWeeks(count, now)[0];
	if (!first) return now.toISOString();
	const [y, m, d] = first.start.split('-').map(Number);
	return new Date(y, m - 1, d).toISOString();
}

// Counts per week. Dates outside the window, in the future, or unparseable are ignored.
export function binWeekly(
	dates: ReadonlyArray<string | Date | null | undefined>,
	count: number = DEFAULT_WEEKS,
	now: Date = new Date(),
): number[] {
	const weeks = lastWeeks(count, now);
	const index = new Map(weeks.map((w, i) => [w.start, i]));
	const counts = new Array<number>(weeks.length).fill(0);
	for (const value of dates) {
		if (value === null || value === undefined || value === '') continue;
		const d = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(d.getTime())) continue;
		const i = index.get(ymd(weekStart(d)));
		if (i !== undefined) counts[i] += 1;
	}
	return counts;
}

export function weeklyActivity(
	opDates: ReadonlyArray<string | Date | null | undefined>,
	testDates: ReadonlyArray<string | Date | null | undefined>,
	count: number = DEFAULT_WEEKS,
	now: Date = new Date(),
): WeeklyActivity {
	const ops = binWeekly(opDates, count, now);
	const tests = binWeekly(testDates, count, now);
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	return { weeks: lastWeeks(count, now), ops, tests, totalOps: sum(ops), totalTests: sum(tests) };
}

// Groups rows by a key (e.g. project_id) into their dates, so one fetch can feed many sparklines.
export function datesByKey<T>(
	rows: ReadonlyArray<T>,
	keyOf: (row: T) => string | null | undefined,
	dateOf: (row: T) => string | null | undefined,
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const row of rows) {
		const key = keyOf(row);
		const date = dateOf(row);
		if (!key || !date) continue;
		const list = out.get(key);
		if (list) list.push(date);
		else out.set(key, [date]);
	}
	return out;
}
