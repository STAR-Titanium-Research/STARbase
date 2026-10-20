// Grouping a list's page by a filter field (the View rail's "Group by"): which fields can group and the sort
// the query adds so a group's rows are together (the headers' text is indexView's rowGroupLabel). Pure, so it is all tested.
//
// Only the rows of the page on screen are grouped: the server sorts by the group field first and then by the
// person's sort, so a group that runs on to the next page continues under the same header there.

import type { FilterDef, IndexDef } from './indexConfig';
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

/**
 * The fields that make a group: the query asks for them and sorts by them (an enum by its field, a relation by what its
 * rows show: the display field, then the fallback that names a row without one, so uncoded campaigns neither merge
 * nor land in "No campaign"). Empty when the list cannot be grouped by `field`.
 */
export function groupKeys(def: IndexDef, field: string | null, readable: Readable = null): string[] {
	const f = groupFilter(def, field, readable);
	if (!f) return [];
	if (f.options.kind !== 'relation') return [f.field];
	return [`${f.field}.${f.options.display}`, ...(f.options.fallback ? [`${f.field}.${f.options.fallback}`] : [])];
}

/** The query's sort: the group's keys first, then the person's sort (which wins when it is the group's own first key, so its direction holds). */
export function sortWithGroup(keys: readonly string[], sort: string): string[] {
	if (!keys.length) return [sort];
	return sort === keys[0] || sort === `-${keys[0]}` ? [sort, ...keys.slice(1)] : [...keys, sort];
}
