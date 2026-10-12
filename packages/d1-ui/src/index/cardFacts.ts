// What a card shows for a row, from the same column table the list's table uses: the head (the first
// column, as a link; the second as a line under a code), up to four facts after it, and the sort
// choices the cards toolbar offers in place of the table's column headers. Pure, so it is all tested.

import type { ColumnDef, IndexDef } from './indexConfig';
import { cellText, sortKey } from './indexView';

type Row = Record<string, unknown>;

export interface CardFact {
	label: string;
	value: string;
}
export interface CardHead {
	/** The first column's text: the row's link. Empty when the row has none (the card then says "—"). */
	link: string;
	/** The first column is a code, so it is set in the monospace face and the next column is the title. */
	mono: boolean;
	/** The title line under a code; empty for a list whose first column is already a name. */
	sub: string;
}

export const MAX_CARD_FACTS = 4;

const firstIsCode = (def: IndexDef): boolean => def.columns[0]?.format === 'code';

export function cardHead(def: IndexDef, row: Row): CardHead {
	const first = def.columns[0];
	if (!first) return { link: '', mono: false, sub: '' };
	const mono = firstIsCode(def);
	const second = def.columns[1];
	return { link: cellText(row, first, def), mono, sub: mono && second ? cellText(row, second, def) : '' };
}

// The columns after the head, formatted like the table's cells; a column with nothing in it is left
// out rather than shown as an empty label.
export function cardFacts(def: IndexDef, row: Row): CardFact[] {
	const skip = firstIsCode(def) && def.columns[1] ? 2 : 1;
	const out: CardFact[] = [];
	for (const c of def.columns.slice(skip)) {
		const value = cellText(row, c, def);
		if (value === '') continue;
		out.push({ label: c.label, value });
		if (out.length === MAX_CARD_FACTS) break;
	}
	return out;
}

// A plain left click, as opposed to the browser's own link actions (open in a new tab, copy address).
export function isPlainClick(e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
	return !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0);
}

// ---- sorting without column headers ----------------------------------------------------------------

export interface SortOption {
	value: string;
	label: string;
}

// Every column the page can sort by, both ways round, in the same keys the table's headers use. The
// list's own default order (often by creation time, which is no column) comes first when no column
// carries it; a current sort the options do not hold (a saved view's) is added so the select never
// shows a choice that is not the real one.
export function sortOptions(def: IndexDef, current: string, sortable: (c: ColumnDef) => boolean = () => true): SortOption[] {
	const out: SortOption[] = [];
	for (const c of def.columns) {
		if (!sortable(c)) continue;
		const key = sortKey(c);
		out.push({ value: key, label: `${c.label}, ascending` }, { value: `-${key}`, label: `${c.label}, descending` });
	}
	const has = (v: string) => out.some((o) => o.value === v);
	if (!has(def.defaultSort)) out.unshift({ value: def.defaultSort, label: 'Default order' });
	if (!has(current)) out.unshift({ value: current, label: 'Saved view order' });
	return out;
}
