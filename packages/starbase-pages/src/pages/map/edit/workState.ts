// Planned or done at Create (R9, ADR-0019 amendment): which draft items have a state to choose, and what choosing Done changes. Pure, no Vue:
// the rail's toggle and the chip on the card both ask this, so one press is the same one undoable step from either.

import type { DraftItem, DraftOperation, DraftTest } from '@d1/ui';
import type { DraftAction, WorkState } from './draft';

/** The field holding when the work happened: only a record that is done has one (a planned record has `planned_date`). */
export const DONE_DATE_FIELD = { operation: 'operation_date', test: 'session_date' } as const;

/** A new operation or test can be planned or done at Create; a sample has no state of its own, and a record that exists is marked done by Mark done. */
export const canChooseWork = (item: DraftItem | null | undefined): item is DraftOperation | DraftTest =>
	!!item && item.kind !== 'sample' && !item.existing && !item.remove;

const blank = (v: unknown): boolean => v === undefined || v === null || v === '';

/**
 * The actions that make `item` planned or done, to be applied as one step: the state, and for Done the date it happened (`now` unless the
 * item already carries one, so Done, Planned and Done again asks for it once). Planned leaves the date where it is: Create does not write a
 * date for planned work, and the person gets it back with Done.
 */
export function workStateActions(item: DraftItem, state: WorkState, now: Date = new Date()): DraftAction[] {
	if (!canChooseWork(item) || item.workState === state) return [];
	const actions: DraftAction[] = [{ type: 'setWorkState', key: item.key, workState: state }];
	if (state === 'done') {
		const field = DONE_DATE_FIELD[item.kind];
		if (blank(item.values[field])) actions.push({ type: 'setValues', key: item.key, values: { [field]: now.toISOString() } });
	}
	return actions;
}

/** The state a drawn card stands for, from the items it is made of (a stack of passes is several): their state when it is the same, planned when they differ; null when it has no state to choose. */
export function groupWorkState(items: readonly DraftItem[]): WorkState | null {
	if (!items.length || !items.every(canChooseWork)) return null;
	return items.every((i) => i.workState === 'done') ? 'done' : 'planned';
}
