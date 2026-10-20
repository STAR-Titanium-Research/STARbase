// How one list is shown, remembered per browser and per list (spec decisions 3-4): a table, a card grid or
// a compact list, three row densities, which columns show and in what order, rows per page and a group-by
// field. These are preferences of the person, not of the page, so they live in localStorage and stay out of
// the URL (which carries only what is being looked at: the filters, the sort and the page).

import { browserStorage } from '../storage';
import type { IndexDef } from './indexConfig';

export type ListView = 'table' | 'cards' | 'list';
export type Density = 'compact' | 'normal' | 'roomy';
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export interface ListPrefs {
	view: ListView;
	density: Density;
	/** Hidden columns and column order; null = all shown, in the def's order. */
	columns: ColumnPrefs | null;
	pageSize: PageSize;
	/** The filter field rows are grouped by (an enum or relation filter of the def); null = not grouped. */
	groupBy: string | null;
}

export const LIST_VIEWS: readonly ListView[] = ['table', 'cards', 'list'];
export const DENSITIES: readonly Density[] = ['compact', 'normal', 'roomy'];
export const DEFAULT_PAGE_SIZE: PageSize = 50;
export const DEFAULT_LIST_PREFS: Readonly<ListPrefs> = { view: 'table', density: 'normal', columns: null, pageSize: DEFAULT_PAGE_SIZE, groupBy: null };

// Every key this module and the record pages' View rail (record/recordView.ts, `d1.view.<kind>`) keep: "Forget my list views" removes them all.
const KEY_PREFIXES = ['d1.list.', 'd1.view.'];
export const listPrefsKey = (slug: string): string => `d1.list.${slug}`;

/** The filters a list can be grouped by: the enum and relation ones (a bool, a flag or a team is not a value a row has). */
export const groupFilters = (def: IndexDef) => def.filters.filter((f) => f.options.kind === 'enum' || f.options.kind === 'relation');

/**
 * The person's columns as stored: which are hidden and the order of them all, neither naming the def's first column
 * (the row's link: always shown, always first). Storing what is hidden, not what is shown, means a column added to
 * the list later shows for people who customised, at the end.
 */
export interface ColumnPrefs {
	order: string[];
	hidden: string[];
}

/**
 * Stored columns checked against the def: unknown columns dropped, each once, columns the value does not name
 * added to the end of the order (shown); null when that is the default (everything shown, in the def's order).
 * The first shape, a list of the shown columns, is still read: what it leaves out is hidden.
 */
export function validColumns(def: IndexDef, stored: unknown): ColumnPrefs | null {
	const rest = def.columns.slice(1).map((c) => c.field);
	const known = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((f): f is string => typeof f === 'string' && rest.includes(f)))] : []);
	let order: string[];
	let hidden: string[];
	if (Array.isArray(stored)) {
		order = known(stored);
		hidden = rest.filter((f) => !order.includes(f));
	} else if (stored && typeof stored === 'object') {
		order = known((stored as ColumnPrefs).order);
		hidden = known((stored as ColumnPrefs).hidden);
	} else return null;
	order = [...order, ...rest.filter((f) => !order.includes(f))];
	return !hidden.length && order.every((f, i) => f === rest[i]) ? null : { order, hidden };
}

// The stored value is a JSON object; each field is checked on its own, so a good one survives a bad
// one. Nothing stored, a broken value or blocked storage gives the default. Columns and the group-by field
// are checked against the list's def: one that is no longer there is dropped.
export function readListPrefs(slug: string, def: IndexDef, storage: Storage | null = browserStorage()): ListPrefs {
	const prefs: ListPrefs = { ...DEFAULT_LIST_PREFS };
	try {
		const raw = storage?.getItem(listPrefsKey(slug));
		if (!raw) return prefs;
		const v: unknown = JSON.parse(raw);
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const { view, density, columns, pageSize, groupBy } = v as Record<string, unknown>;
			if (LIST_VIEWS.includes(view as ListView)) prefs.view = view as ListView;
			if (DENSITIES.includes(density as Density)) prefs.density = density as Density;
			if (PAGE_SIZES.includes(pageSize as PageSize)) prefs.pageSize = pageSize as PageSize;
			prefs.columns = validColumns(def, columns);
			if (typeof groupBy === 'string' && groupFilters(def).some((f) => f.field === groupBy)) prefs.groupBy = groupBy;
		}
	} catch {
		// broken value or blocked storage: the default stands
	}
	return prefs;
}

export function writeListPrefs(slug: string, prefs: ListPrefs, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(
			listPrefsKey(slug),
			JSON.stringify({ view: prefs.view, density: prefs.density, columns: prefs.columns, pageSize: prefs.pageSize, groupBy: prefs.groupBy }),
		);
	} catch {
		// private mode or blocked storage: the choice just is not remembered
	}
}

// Settings → Index pages → "Forget my list views": removes every list's saved view settings and every record
// page's View rail settings (and whether each rail was open), and only those (the keys under KEY_PREFIXES), so
// the next visit to each page starts at the defaults.
export function forgetListPrefs(storage: Storage | null = browserStorage()): void {
	try {
		if (!storage) return;
		const keys: string[] = [];
		for (let i = 0; i < storage.length; i++) {
			const k = storage.key(i);
			if (k && KEY_PREFIXES.some((p) => k.startsWith(p))) keys.push(k);
		}
		for (const k of keys) storage.removeItem(k);
	} catch {
		// blocked storage: nothing was remembered, so nothing is forgotten
	}
}

// Which radio gets focus (and is chosen) after `key` in a group of `count`, currently on `current`.
// Arrows wrap; Home and End jump to the ends; any other key is not ours (null).
export function nextRadioIndex(count: number, current: number, key: string): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
			return (current + 1) % count;
		case 'ArrowLeft':
		case 'ArrowUp':
			return (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}
