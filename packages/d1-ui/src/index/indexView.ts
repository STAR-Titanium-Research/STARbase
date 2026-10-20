// The index page's pure view logic: what a cell shows, the paging line, the sort toggle, the chip
// options, and the one rule the URL needs beyond indexQuery.ts (a saved view's own search fills the
// search box when the URL has none). No Vue and no network, so it is all unit-tested.

import { choiceKindFor, choiceLabel } from '../choiceLabels';
import type { ChoiceKind } from '../choiceLabels';
import { formatDate, formatNumber } from '../format';
import { operationLabel } from '../operationLabel';
import type { Bookmark } from '../nav/navConfig';
import type { ColumnDef, IndexDef, SelectAction } from './indexConfig';
import { indexDefByCollection } from './indexConfig';
import { bookmarkSort, queryFromState } from './indexQuery';
import { DEFAULT_LIST_PREFS, groupFilters } from './listPrefs';
import type { Density, ListPrefs } from './listPrefs';
import { dataStudioRoute, recordRoute } from '../recordRoute';
import type { IndexState } from './indexQuery';
import { thumbFields } from './thumbs';

type Row = Record<string, unknown>;

// What a click on a row (or ?open=<key> from the finder) does. A 'record' def navigates to the record's Explorer page. A 'drawer' def opens
// the edit drawer, which is an editable form with Save: not for a Lab Viewer (migration 185: reads everything, changes nothing), who gets the
// record in Data Studio instead, where its read-only policy shows the form read-only.
export type RowOpen = { kind: 'navigate'; to: string } | { kind: 'studio'; to: string } | { kind: 'drawer' };
export function rowOpen(rowTarget: 'record' | 'drawer', viewer: boolean | null | undefined, collection: string, pk: string): RowOpen {
	if (rowTarget === 'record') return { kind: 'navigate', to: recordRoute(collection, pk) };
	return viewer ? { kind: 'studio', to: dataStudioRoute(collection, pk) } : { kind: 'drawer' };
}

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
	// The owning team's name (a team-owned campaign has no owner person); a role that cannot read teams does not ask for it.
	if (def.collection === 'campaigns' && (!readable || readable.has('teams'))) out.push('owner_team_id.name');
	// The thumbnail's own fields (a sample's form and dimensions, an image list's file field).
	out.push(...thumbFields(def.collection));
	// The row's accent colour (the ISO classes' colour_hex).
	if (def.accentField && !def.columns.some((c) => c.field === def.accentField)) out.push(def.accentField);
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
	const choice = choiceKindFor(def.collection, col.field);
	if (choice) return choiceLabel(choice, value);
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

// "1–50 of 1,206" (the View rail's count); an empty page says so instead of "1–0".
export function rangeText(page: number, shown: number, total: number | null, pageSize: number): string {
	if (total === null) return '';
	if (total === 0 || shown === 0) return `0 of ${grouped(total)}`;
	const from = (page - 1) * pageSize + 1;
	return `${grouped(from)}–${grouped(from + shown - 1)} of ${grouped(total)}`;
}

export const hasNextPage = (page: number, total: number | null, pageSize: number): boolean => total !== null && page * pageSize < total;
export const pageCount = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / pageSize));

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
// own default (either way round: the rail's direction button) or the saved view's sort. Anything else (a hand-edited ?sort=) is dropped, so Directus
// is never sent a field the page does not show. `sortable` leaves out a relation column whose
// related collection the user cannot read.
export function validSort(
	def: IndexDef,
	requested: string | null,
	bookmark: Bookmark | null,
	sortable: (c: ColumnDef) => boolean = () => true,
): string | null {
	if (!requested) return null;
	if (requested === def.defaultSort || requested === flipSort(def.defaultSort) || requested === bookmarkSort(bookmark)) return requested;
	for (const c of def.columns) {
		if (!sortable(c)) continue;
		const key = sortKey(c);
		if (requested === key || requested === `-${key}`) return requested;
	}
	return null;
}

// "-created_at" <-> "created_at": the same field the other way round.
export const flipSort = (sort: string): string => (sort.startsWith('-') ? sort.slice(1) : `-${sort}`);

/** A sort split into its field and direction (the rail's field select and direction button). */
export const splitSort = (sort: string): { key: string; desc: boolean } => (sort.startsWith('-') ? { key: sort.slice(1), desc: true } : { key: sort, desc: false });

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

// The note under the filters when the Team filter shows only the newest of a larger team (the endpoint's cap).
export function teamTruncatedNote(limit: number): string {
	return `Showing the latest ${grouped(limit)} of this team's records.`;
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
// `kind`: the column is one of the four coded dropdowns (choiceKindFor), so its chips read the label, not the code.
export function enumOptions(rows: unknown, field: string, kind: ChoiceKind | null = null): ChipOption[] {
	const list = Array.isArray(rows) ? rows : [];
	const seen = new Set<string>();
	for (const r of list) {
		if (!isRecord(r)) continue;
		const v = r[field];
		if (v === null || v === undefined || v === '') continue;
		seen.add(String(v));
	}
	return [...seen].map((v) => ({ value: v, label: kind ? choiceLabel(kind, v) : v }))
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
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

// A sample's code: what its "Force (n)" button searches the operations list for.
export const plotCode = (row: Row): string => (typeof row.sample_code === 'string' ? row.sample_code : '');

// ---- ticked rows -------------------------------------------------------------------------------

// The most rows one select action takes: the keys travel in the address (about 37 characters each), and a
// reload of a longer one can be refused by the proxy.
export const SELECT_MAX = 100;

// The route the select button goes to: the action's page with the ticked keys as one comma list.
export function selectionRoute(action: SelectAction, keys: string[]): string {
	return `${action.path}?${action.param}=${keys.map(encodeURIComponent).join(',')}`;
}

/**
 * The header text of a row's group: its value (a relation by what it shows, else by the fallback that names a row
 * without one), or "No project or not visible" for a row with none: Directus also gives null for a related row
 * the person may not read.
 */
export function rowGroupLabel(def: IndexDef, field: string, row: Row): string {
	const f = groupFilters(def).find((x) => x.field === field);
	if (!f) return '';
	const o = f.options;
	const text = o.kind === 'relation' ? relationText(row[field], o.display) || (o.fallback ? relationText(row[field], o.fallback) : '') : cellText(row, { field, label: f.label }, def);
	return text || `No ${f.label.toLowerCase()} or not visible`;
}

/** The header to draw above row `i`: its group's label when it starts a group, else null. */
export function groupHeader(rows: readonly Row[], i: number, labelOf: (row: Row) => string): string | null {
	const label = labelOf(rows[i]);
	return i === 0 || labelOf(rows[i - 1]) !== label ? label : null;
}

// ---- the View rail's summary ------------------------------------------------------------------

/** The page width (px) from which an index page's View rail is open by default; narrower, it is the 36px tab (and under 1100px a button). */
export const RAIL_OPEN_FROM = 1500;
export const railOpensByDefault = (width: number): boolean => width >= RAIL_OPEN_FROM;

const DENSITY_LABEL: Record<Density, string> = { compact: 'Compact', normal: 'Normal', roomy: 'Roomy' };

/** What the collapsed rail's tab says after "View": "Normal · Created ↓". */
export function viewSummary(def: IndexDef, prefs: ListPrefs, sort: string): string {
	const { key, desc } = splitSort(sort);
	const col = def.columns.find((c) => sortKey(c) === key);
	return `${DENSITY_LABEL[prefs.density]} · ${col?.label ?? 'Default order'} ${desc ? '↓' : '↑'}`;
}

/** The dot on the tab: the view is not the default (layout, density, columns, rows per page, grouping, or a sort other than the list's own). */
export function viewChanged(def: IndexDef, prefs: ListPrefs, sort: string): boolean {
	const d = DEFAULT_LIST_PREFS;
	return prefs.view !== d.view || prefs.density !== d.density || prefs.columns !== d.columns || prefs.pageSize !== d.pageSize || prefs.groupBy !== d.groupBy || sort !== def.defaultSort;
}
