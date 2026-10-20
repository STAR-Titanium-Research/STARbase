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
	/** The shown columns' fields, in order (the def's first column always first); null = all of them, in the def's order. */
	columns: string[] | null;
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

/** The columns to keep from a stored list: the def's own, once each, the first one (the row's link) always and first; null when that is every column in the def's order. */
export function validColumns(def: IndexDef, stored: unknown): string[] | null {
	if (!Array.isArray(stored) || !def.columns.length) return null;
	const [first, ...rest] = def.columns.map((c) => c.field);
	const kept = [...new Set(stored.filter((f): f is string => typeof f === 'string' && rest.includes(f)))];
	return kept.length === rest.length && kept.every((f, i) => f === rest[i]) ? null : [first, ...kept];
}

// The stored value is a JSON object; each field is checked on its own, so a good one survives a bad
// one. Nothing stored, a broken value or blocked storage gives the default. With the list's def, columns
// and the group-by field are also checked against it: one that is no longer there is dropped.
export function readListPrefs(slug: string, storage: Storage | null = browserStorage(), def?: IndexDef): ListPrefs {
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
			if (def) {
				prefs.columns = validColumns(def, columns);
				if (typeof groupBy === 'string' && groupFilters(def).some((f) => f.field === groupBy)) prefs.groupBy = groupBy;
			} else {
				if (Array.isArray(columns) && columns.every((c) => typeof c === 'string')) prefs.columns = columns;
				if (typeof groupBy === 'string' && groupBy) prefs.groupBy = groupBy;
			}
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
