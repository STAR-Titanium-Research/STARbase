// Which columns a list shows and in what order (the View rail's Columns dropdown). The stored value is the
// shown columns' fields in order, or null for "every column, in the def's order" (listPrefs.ts keeps it
// valid). The def's first column (the code, the row's link) is always shown and always first. Pure.

import type { ColumnDef, IndexDef } from './indexConfig';
import { validColumns } from './listPrefs';

const allFields = (def: IndexDef): string[] => def.columns.map((c) => c.field);
const byField = (def: IndexDef, fields: readonly string[]): ColumnDef[] => fields.flatMap((f) => def.columns.find((c) => c.field === f) ?? []);

/** The shown columns, in order. */
export function shownColumns(def: IndexDef, stored: string[] | null): ColumnDef[] {
	return byField(def, stored ?? allFields(def));
}

/** The hidden ones, in the def's order. */
export function hiddenColumns(def: IndexDef, stored: string[] | null): ColumnDef[] {
	const shown = new Set(stored ?? allFields(def));
	return def.columns.filter((c) => !shown.has(c.field));
}

/** The dropdown button's text: "9 of 13 shown". */
export const columnsSummary = (def: IndexDef, stored: string[] | null): string => `${shownColumns(def, stored).length} of ${def.columns.length} shown`;

/** The first column cannot be hidden or moved. */
export const isFixedColumn = (def: IndexDef, field: string): boolean => def.columns[0]?.field === field;

/** A column shown or hidden: it joins the end of the shown ones. */
export function toggleColumn(def: IndexDef, stored: string[] | null, field: string): string[] | null {
	if (isFixedColumn(def, field)) return stored;
	const shown = stored ?? allFields(def);
	return validColumns(def, shown.includes(field) ? shown.filter((f) => f !== field) : [...shown, field]);
}

/** A shown column moved to `to` (its index among the shown columns, which is at least 1: the first column stays first). */
export function moveColumn(def: IndexDef, stored: string[] | null, field: string, to: number): string[] | null {
	const shown = [...(stored ?? allFields(def))];
	const from = shown.indexOf(field);
	if (from < 1 || isFixedColumn(def, field)) return stored;
	shown.splice(from, 1);
	shown.splice(Math.min(Math.max(to, 1), shown.length), 0, field);
	return validColumns(def, shown);
}

/** Columns whose label contains the search text (any case); every column for an empty search. */
export function matchColumns(columns: readonly ColumnDef[], search: string): ColumnDef[] {
	const q = search.trim().toLowerCase();
	return q ? columns.filter((c) => c.label.toLowerCase().includes(q)) : [...columns];
}
