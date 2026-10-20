// Grouping a list's page by a filter field (the View rail's "Group by"): which fields can group and the sort
// the query adds so a group's rows are together (the headers' text is indexView's rowGroupLabel). Pure, so it is all tested.
//
// Only the rows of the page on screen are grouped: the server sorts by the group field first and then by the
// person's sort, so a group that runs on to the next page continues under the same header there.

import type { ColumnDef, FilterDef, IndexDef } from './indexConfig';
import { groupFilters } from './listPrefs';

type Readable = ReadonlySet<string> | null;

export interface GroupChoice {
	value: string;
	label: string;
}

// A relation filter groups by what its rows show (the project's code), so it needs that collection readable
// (`readable` null = not known: tried, as the chips and sorts are).
const usable = (f: FilterDef, readable: Readable): boolean => f.options.kind !== 'relation' || !readable || readable.has(f.options.collection);

/** The fields the list can be grouped by: its enum and relation filters. */
export function groupChoices(def: IndexDef, readable: Readable = null): GroupChoice[] {
	return groupFilters(def).filter((f) => usable(f, readable)).map((f) => ({ value: f.field, label: f.label }));
}

function groupFilter(def: IndexDef, field: string | null, readable: Readable): FilterDef | null {
	if (!field) return null;
	const f = groupFilters(def).find((x) => x.field === field);
	return f && usable(f, readable) ? f : null;
}

/** The field the query sorts a group by (a relation by what it shows), or null when the list cannot be grouped by `field`. */
export function groupSortKey(def: IndexDef, field: string | null, readable: Readable = null): string | null {
	const f = groupFilter(def, field, readable);
	return f ? (f.options.kind === 'relation' ? `${f.field}.${f.options.display}` : f.field) : null;
}

/** The column that reads the group's value out of a row: the list's own column for the field, else one made from the filter. */
export function groupColumn(def: IndexDef, field: string): ColumnDef | null {
	const own = def.columns.find((c) => c.field === field);
	if (own) return own;
	const f = groupFilters(def).find((x) => x.field === field);
	if (!f) return null;
	return f.options.kind === 'relation' ? { field, label: f.label, relation: { collection: f.options.collection, display: f.options.display } } : { field, label: f.label };
}

/** The Directus field to ask for so rows carry the group's value, when the list's columns do not already ask for it. */
export function groupFetchField(def: IndexDef, field: string | null, readable: Readable = null): string | null {
	const key = groupSortKey(def, field, readable);
	if (!key || def.columns.some((c) => c.field === field)) return null;
	return key;
}

/** The query's sort: the group field first, then the person's sort (which wins when it is that same field, so its direction holds). */
export function sortWithGroup(groupKey: string | null, sort: string): string[] {
	if (!groupKey || sort === groupKey || sort === `-${groupKey}`) return [sort];
	return [groupKey, sort];
}
