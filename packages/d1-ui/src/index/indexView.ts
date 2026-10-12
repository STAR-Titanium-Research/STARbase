// The index page's pure view logic: what a cell shows, the paging line, the sort toggle, the chip
// options, and the one rule the URL needs beyond indexQuery.ts (a saved view's own search fills the
// search box when the URL has none). No Vue and no network, so it is all unit-tested.

import { formatDate, formatNumber } from '../format';
import { operationLabel } from '../operationLabel';
import type { Bookmark } from '../nav/navConfig';
import type { ColumnDef, IndexDef, SelectAction } from './indexConfig';
import { indexDefByCollection } from './indexConfig';
import { PAGE_SIZE, bookmarkSort, queryFromState } from './indexQuery';
import type { IndexState } from './indexQuery';
import { thumbFields } from './thumbs';

type Row = Record<string, unknown>;

// ---- cells -------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

// Fields the page asks for that buildItemsParams does not: the operation label falls back to the
// step number when the operation has no pass code, and a campaign card names the owner. A nested
// field of a collection the user cannot read is refused (taking the whole list with it), so the
// owner is only asked for when `people` is readable (null = not known: tried).
export function extraFields(def: IndexDef, readable: ReadonlySet<string> | null = null): string[] {
	const out: string[] = [];
	if (def.collection === 'manufacturing_operations' && def.columns.some((c) => c.field === 'pass_code')) out.push('operation_sequence');
	// Which dashboard an operation belongs to (a sintering run has no force figure).
	if (def.collection === 'manufacturing_operations') out.push('process_category');
	if (def.collection === 'campaigns' && (!readable || readable.has('people'))) out.push('owner_person_id.full_name');
	// The thumbnail's own fields (a sample's form and dimensions, an image list's file field).
	out.push(...thumbFields(def.collection));
	return out;
}

// The related row's display value. A bare key (the role may not read that collection) or null shows
// nothing, never the raw key.
export function relationText(value: unknown, display: string): string {
	if (!isRecord(value)) return '';
	const shown = value[display];
	return shown === null || shown === undefined ? '' : String(shown);
}

export function cellText(row: Row, col: ColumnDef, def: IndexDef): string {
	const value = row[col.field];
	if (col.relation) return relationText(value, col.relation.display);
	if (col.format === 'code' && def.collection === 'manufacturing_operations' && col.field === 'pass_code') {
		return operationLabel(row as Parameters<typeof operationLabel>[0]);
	}
	if (value === null || value === undefined || value === '') return '';
	switch (col.format) {
		case 'date':
			return formatDate(String(value));
		case 'bool':
			return value === true ? 'Yes' : value === false ? 'No' : '';
		case 'number':
			return formatNumber(value as number | string);
	}
	if (Array.isArray(value)) return value.map(String).join(', ');
	if (isRecord(value)) return JSON.stringify(value);
	return String(value);
}

// ---- paging and sorting -----------------------------------------------------------------------

const grouped = (n: number): string => n.toLocaleString('en-GB');

// "Showing 1-50 of 1,206"; an empty page says so instead of "1-0".
export function rangeText(page: number, shown: number, total: number | null): string {
	if (total === null) return '';
	if (total === 0 || shown === 0) return `Showing 0 of ${grouped(total)}`;
	const from = (page - 1) * PAGE_SIZE + 1;
	return `Showing ${grouped(from)}-${grouped(from + shown - 1)} of ${grouped(total)}`;
}

export const hasNextPage = (page: number, total: number | null): boolean => total !== null && page * PAGE_SIZE < total;

// Clicking a header: ascending first, then descending, then back. A column the page is not sorted
// by starts ascending.
export function nextSort(current: string, field: string): string {
	return current === field ? `-${field}` : field;
}

// What a header click sorts by: the column's own field, or the related row's display field for a
// relation (sorting a foreign key would order by UUID).
export function sortKey(col: ColumnDef): string {
	return col.relation ? `${col.field}.${col.relation.display}` : col.field;
}

// The sort the URL asks for, if the page offers it: a column's sort key either way round, the def's
// own default or the saved view's sort. Anything else (a hand-edited ?sort=) is dropped, so Directus
// is never sent a field the page does not show. `sortable` leaves out a relation column whose
// related collection the user cannot read.
export function validSort(
	def: IndexDef,
	requested: string | null,
	bookmark: Bookmark | null,
	sortable: (c: ColumnDef) => boolean = () => true,
): string | null {
	if (!requested) return null;
	if (requested === def.defaultSort || requested === bookmarkSort(bookmark)) return requested;
	for (const c of def.columns) {
		if (!sortable(c)) continue;
		const key = sortKey(c);
		if (requested === key || requested === `-${key}`) return requested;
	}
	return null;
}

export function sortDirection(current: string, field: string): 'asc' | 'desc' | null {
	if (current === field) return 'asc';
	if (current === `-${field}`) return 'desc';
	return null;
}

// ---- the URL ----------------------------------------------------------------------------------

type RawQuery = Record<string, unknown>;

// The URL's own q (even an empty one, which means "cleared") beats the saved view's search; only a
// URL with no q at all takes the saved view's.
export function hasExplicitQ(query: RawQuery): boolean {
	return query.q !== undefined;
}

export function effectiveState(raw: IndexState, qExplicit: boolean, bookmark: Bookmark | null): IndexState {
	if (qExplicit || !bookmark?.search) return raw;
	return { ...raw, q: bookmark.search };
}

// The query to write for a state. An emptied search box over a saved view that has a search is kept
// as q= (empty): dropping it would let the saved view's search come back.
export function queryForState(s: IndexState, bookmark: Bookmark | null, qExplicit: boolean): Record<string, string> {
	const out = queryFromState(s);
	if (s.q === '' && qExplicit && bookmark?.search) out.q = '';
	return out;
}

// A change of search, chips, sort or saved view starts again from page 1; the drawer's ?open goes too.
export function withChange(s: IndexState, patch: Partial<IndexState>): IndexState {
	const next = { ...s, ...patch };
	if (!('page' in patch)) next.page = 1;
	if (!('open' in patch)) next.open = null;
	return next;
}

export function hasActiveFilters(s: IndexState): boolean {
	return s.q.trim() !== '' || Object.values(s.filters).some(Boolean);
}

// ---- chip options -----------------------------------------------------------------------------

export interface ChipOption {
	value: string;
	label: string;
}

// The key a relation chip filters on: the related collection's primary key. Projects have no
// index page of their own, so it is named here.
export function relationKey(collection: string): string | null {
	if (collection === 'projects') return 'project_id';
	return indexDefByCollection(collection)?.primaryKey ?? null;
}

export function relationOptionParams(key: string, display: string, fallback?: string): Record<string, unknown> {
	const fields = [...new Set([key, display, ...(fallback ? [fallback] : [])])];
	return { fields, sort: [display], limit: 200 };
}

// The label is the display field, else the fallback field (a campaign without a code shows its name),
// else the key.
export function relationOptions(rows: unknown, key: string, display: string, fallback?: string): ChipOption[] {
	const list = Array.isArray(rows) ? rows : [];
	const out: ChipOption[] = [];
	for (const r of list) {
		if (!isRecord(r)) continue;
		const value = r[key];
		if (value === null || value === undefined || value === '') continue;
		const blank = (x: unknown) => x === null || x === undefined || x === '';
		const label = !blank(r[display]) ? r[display] : fallback && !blank(r[fallback]) ? r[fallback] : value;
		out.push({ value: String(value), label: String(label) });
	}
	return out;
}

export function enumOptionParams(field: string): Record<string, unknown> {
	return { groupBy: [field], aggregate: { count: '*' }, limit: 200 };
}

// Distinct non-empty values from the groupBy rows, A-Z.
export function enumOptions(rows: unknown, field: string): ChipOption[] {
	const list = Array.isArray(rows) ? rows : [];
	const seen = new Set<string>();
	for (const r of list) {
		if (!isRecord(r)) continue;
		const v = r[field];
		if (v === null || v === undefined || v === '') continue;
		seen.add(String(v));
	}
	return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map((v) => ({ value: v, label: v }));
}

export const BOOL_OPTIONS: ChipOption[] = [
	{ value: 'true', label: 'Yes' },
	{ value: 'false', label: 'No' },
];

// The chosen value always has an option, so a link carrying a value outside the loaded list (or past
// the 200 cap) still shows what it filters by.
export function withSelected(options: ChipOption[], selected: string | undefined): ChipOption[] {
	if (!selected || options.some((o) => o.value === selected)) return options;
	return [{ value: selected, label: selected }, ...options];
}

// ---- ticked rows -------------------------------------------------------------------------------

// The most rows one select action takes: the keys travel in the address (about 37 characters each), and a
// reload of a longer one can be refused by the proxy.
export const SELECT_MAX = 100;

// The route the select button goes to: the action's page with the ticked keys as one comma list.
export function selectionRoute(action: SelectAction, keys: string[]): string {
	return `${action.path}?${action.param}=${keys.map(encodeURIComponent).join(',')}`;
}
