// What Create will make, in words (E4: the button says "Create 2 operations, 4 samples"), and the draft's default name
// (E3: "<first sample code> · <date>"). Pure, no Vue.

import type { DraftBody, DraftItem } from '@d1/ui';

export interface Counts {
	/** New operation records: one per row. */
	operations: number;
	tests: number;
	samples: number;
	/** Existing operations that are given an input (attach). */
	attached: number;
	/** Existing records whose fields are changed (an attached operation with edited fields counts here too). */
	changed: number;
	/** Planned records that are deleted. */
	removed: number;
}

const hasChanges = (item: DraftItem) => Object.keys(item.values).length > 0;

export function countDraft(body: DraftBody): Counts {
	const c: Counts = { operations: 0, tests: 0, samples: 0, attached: 0, changed: 0, removed: 0 };
	for (const item of body.items) {
		if (item.remove) {
			c.removed += 1;
			continue;
		}
		if (!item.existing) {
			if (item.kind === 'sample') c.samples += 1;
			else if (item.kind === 'test') c.tests += 1;
			else c.operations += item.rows.length;
			continue;
		}
		if (item.kind === 'operation' && item.attach) c.attached += 1;
		if (hasChanges(item)) c.changed += 1;
	}
	return c;
}

/** True when Create would write nothing: no new record, no attach, no edit, no delete (a draft of only picked existing samples). */
export const makesNothing = (body: DraftBody): boolean => Object.values(countDraft(body)).every((n) => n === 0);

/** What the disabled Create button says when the draft would make nothing: what to do next. */
export const NOTHING_TO_MAKE = 'Add an operation, test or new sample to create';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Create 2 operations, 4 samples", plus the changes to records that exist; what to do next when the draft would make nothing. */
export function summaryText(body: DraftBody): string {
	const c = countDraft(body);
	const made = [
		c.operations ? plural(c.operations, 'operation') : '',
		c.tests ? plural(c.tests, 'test') : '',
		c.samples ? plural(c.samples, 'sample') : '',
	].filter(Boolean);
	const other = [
		c.attached ? `attach ${plural(c.attached, 'operation')}` : '',
		c.changed ? `change ${plural(c.changed, 'record')}` : '',
		c.removed ? `delete ${plural(c.removed, 'planned record')}` : '',
	].filter(Boolean);
	if (!made.length && !other.length) return NOTHING_TO_MAKE;
	if (made.length) return [`Create ${made.join(', ')}`, ...other].join('; ');
	return [`${other[0][0].toUpperCase()}${other[0].slice(1)}`, ...other.slice(1)].join('; ');
}

/** The same in the list of drafts, without the verb: "2 operations, 4 samples". */
export function summaryList(body: DraftBody): string {
	const c = countDraft(body);
	const parts = [
		c.operations ? plural(c.operations, 'operation') : '',
		c.tests ? plural(c.tests, 'test') : '',
		c.samples ? plural(c.samples, 'sample') : '',
		c.attached ? plural(c.attached, 'attached operation') : '',
	].filter(Boolean);
	return parts.length ? parts.join(', ') : 'Empty';
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface NameCtx {
	/** The code of an item's sample, when it is known (the loaded record of an existing sample). */
	codeOf?: (item: DraftItem) => string | null | undefined;
	today?: Date;
}

/** "<first sample code> · <date>"; a new sample has no number yet, so its template's tail stands in. */
export function defaultName(body: DraftBody, ctx: NameCtx = {}): string {
	const date = isoDay(ctx.today ?? new Date());
	const first = body.items.find((i) => i.kind === 'sample');
	let code = first ? ctx.codeOf?.(first) : null;
	if (!code && first && typeof first.values.sample_code === 'string') code = first.values.sample_code.replace(/^\{seq\}-?/, '');
	return code ? `${code} · ${date}` : `New process · ${date}`;
}
