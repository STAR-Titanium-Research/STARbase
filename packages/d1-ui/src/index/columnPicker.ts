// Which columns a list shows and in what order (the View rail's Columns dropdown). The stored value is
// listPrefs.ts's ColumnPrefs (what is hidden, and the order of all), or null for "every column, in the def's order".
// The def's first column (the code, the row's link) is always shown and always first. Pure.

import type { ColumnDef, IndexDef } from './indexConfig';
import { validColumns } from './listPrefs';
import type { ColumnPrefs } from './listPrefs';

const resolve = (def: IndexDef, stored: ColumnPrefs | null): ColumnPrefs => stored ?? { order: def.columns.slice(1).map((c) => c.field), hidden: [] };
const byField = (def: IndexDef, fields: readonly string[]): ColumnDef[] => fields.flatMap((f) => def.columns.find((c) => c.field === f) ?? []);

/** The shown columns, in order: the first column, then the others in the person's order that are not hidden. */
export function shownColumns(def: IndexDef, stored: ColumnPrefs | null): ColumnDef[] {
	const { order, hidden } = resolve(def, stored);
	return [...def.columns.slice(0, 1), ...byField(def, order.filter((f) => !hidden.includes(f)))];
}

/** The hidden ones, in the person's order. */
export function hiddenColumns(def: IndexDef, stored: ColumnPrefs | null): ColumnDef[] {
	const { order, hidden } = resolve(def, stored);
	return byField(def, order.filter((f) => hidden.includes(f)));
}

/** The dropdown button's text: "9 of 13 shown". */
export const columnsSummary = (def: IndexDef, stored: ColumnPrefs | null): string => `${shownColumns(def, stored).length} of ${def.columns.length} shown`;

/** The first column cannot be hidden or moved. */
export const isFixedColumn = (def: IndexDef, field: string): boolean => def.columns[0]?.field === field;

/** A column shown or hidden; shown again, it is back where it was in the order. */
export function toggleColumn(def: IndexDef, stored: ColumnPrefs | null, field: string): ColumnPrefs | null {
	if (isFixedColumn(def, field)) return stored;
	const { order, hidden } = resolve(def, stored);
	return validColumns(def, { order, hidden: hidden.includes(field) ? hidden.filter((f) => f !== field) : [...hidden, field] });
}

/** A shown column moved to `to` (its index among the shown columns, which is at least 1: the first column stays first). */
export function moveColumn(def: IndexDef, stored: ColumnPrefs | null, field: string, to: number): ColumnPrefs | null {
	const { order, hidden } = resolve(def, stored);
	if (isFixedColumn(def, field) || !order.includes(field) || hidden.includes(field)) return stored;
	const rest = order.filter((f) => f !== field);
	// It goes before the shown column now at that place (one less than `to`: the first column is not in the order), else last.
	const before = rest.filter((f) => !hidden.includes(f))[Math.max(to, 1) - 1];
	rest.splice(before === undefined ? rest.length : rest.indexOf(before), 0, field);
	return validColumns(def, { order: rest, hidden });
}

/** Columns whose label contains the search text (any case); every column for an empty search. */
export function matchColumns(columns: readonly ColumnDef[], search: string): ColumnDef[] {
	const q = search.trim().toLowerCase();
	return q ? columns.filter((c) => c.label.toLowerCase().includes(q)) : [...columns];
}
