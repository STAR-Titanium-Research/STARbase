// What the Mark done dialog asks and answers (spec E6, §6.2). Pure, no Vue.

import { isoDay } from './summary';

export interface MarkDoneAnswer {
	/** YYYY-MM-DD. */
	date: string;
	/** The People row of who did it; null lets the server take the caller's own. */
	personId: string | null;
}

/** The form's own field names (the form model is a values object keyed by field). */
export const DATE_FIELD = 'done_date';
export const PERSON_FIELD = 'done_by';

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isIsoDay(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [y, m, d] = value.split('-').map(Number);
	const at = new Date(Date.UTC(y, m - 1, d));
	return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** The form's values as they start: today, and the signed-in person once they are known. */
export function initialAnswer(personId: string | null | undefined, today: Date = new Date()): Record<string, unknown> {
	return { [DATE_FIELD]: isoDay(today), ...(personId ? { [PERSON_FIELD]: personId } : {}) };
}

/** The answer to emit, or null while the date is not a day (Mark done stays disabled). A date-time value keeps its day part. */
export function answerOf(values: Record<string, unknown>): MarkDoneAnswer | null {
	const raw = values[DATE_FIELD];
	const date = typeof raw === 'string' ? raw.slice(0, 10) : '';
	if (!isIsoDay(date)) return null;
	const person = values[PERSON_FIELD];
	return { date, personId: typeof person === 'string' && person ? person : null };
}

/** "Mark Cut MF-12 done" / the dialog's lead line: what is being marked, and how many records go together. */
export function leadText(count: number, collection: string): string {
	if (count <= 1) return 'Say when it was done and who did it.';
	const what = collection === 'test_sessions' ? 'tests' : 'operations';
	return `All ${count} ${what} of this card are marked done together. Say when they were done and who did them.`;
}
