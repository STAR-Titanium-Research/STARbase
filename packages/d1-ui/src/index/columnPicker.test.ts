import { describe, expect, it } from 'vitest';
import { columnsSummary, hiddenColumns, isFixedColumn, matchColumns, moveColumn, shownColumns, toggleColumn } from './columnPicker';
import { indexDefBySlug } from './indexConfig';
import type { ColumnPrefs } from './listPrefs';

const samples = indexDefBySlug('samples')!;
const F = samples.columns.map((c) => c.field);
const REST = F.slice(1);
const fields = (cols: { field: string }[]) => cols.map((c) => c.field);
const shown = (p: ColumnPrefs | null) => fields(shownColumns(samples, p));

describe('the shown and hidden columns', () => {
	it("shows every column, in the def's order, when nothing is stored", () => {
		expect(shown(null)).toEqual(F);
		expect(hiddenColumns(samples, null)).toEqual([]);
		expect(columnsSummary(samples, null)).toBe(`${F.length} of ${F.length} shown`);
	});
	it('shows the others in the stored order except the hidden ones, which are listed in that order', () => {
		const stored: ColumnPrefs = { order: [REST[2], REST[0], REST[1], ...REST.slice(3)], hidden: [REST[1], REST[4]] };
		expect(shown(stored)).toEqual([F[0], REST[2], REST[0], ...REST.slice(3).filter((f) => f !== REST[4])]);
		expect(fields(hiddenColumns(samples, stored))).toEqual([REST[1], REST[4]]);
		expect(columnsSummary(samples, stored)).toBe(`${F.length - 2} of ${F.length} shown`);
	});
	it('knows the first column is fixed', () => {
		expect(isFixedColumn(samples, F[0])).toBe(true);
		expect(isFixedColumn(samples, F[1])).toBe(false);
	});
});

describe('toggleColumn', () => {
	it('hides a column, and shows it again where it was in the order', () => {
		const hidden = toggleColumn(samples, null, F[2]);
		expect(hidden).toEqual({ order: REST, hidden: [F[2]] });
		expect(shown(hidden)).toEqual(F.filter((f) => f !== F[2]));
		expect(toggleColumn(samples, hidden, F[2])).toBeNull();
	});
	it('keeps a moved column in its place when it is hidden and shown again', () => {
		const moved = moveColumn(samples, null, F[4], 1);
		expect(shown(toggleColumn(samples, toggleColumn(samples, moved, F[4]), F[4]))).toEqual(shown(moved));
	});
	it('never hides the first column', () => {
		expect(toggleColumn(samples, null, F[0])).toBeNull();
		const stored = { order: REST, hidden: [F[1]] };
		expect(toggleColumn(samples, stored, F[0])).toBe(stored);
	});
});

describe('moveColumn', () => {
	it('moves a shown column to a position among the shown ones', () => {
		expect(shown(moveColumn(samples, null, F[3], 1))).toEqual([F[0], F[3], F[1], F[2], ...F.slice(4)]);
		expect(shown(moveColumn(samples, { order: REST, hidden: [F[3]] }, F[1], 2))).toEqual([F[0], F[2], F[1], ...F.slice(4)]);
	});
	it('puts a column past a hidden one without losing where the hidden one is', () => {
		const moved = moveColumn(samples, { order: REST, hidden: [F[2]] }, F[1], 2)!;
		expect(shown(moved)).toEqual([F[0], F[3], F[1], ...F.slice(4)]);
		expect(shown(toggleColumn(samples, moved, F[2]))).toContain(F[2]);
	});
	it('keeps the first column first, and a hidden or unknown column where it is', () => {
		expect(shown(moveColumn(samples, null, F[2], 0))[0]).toBe(F[0]);
		expect(moveColumn(samples, null, F[0], 3)).toBeNull();
		const stored = { order: REST, hidden: [F[4]] };
		expect(moveColumn(samples, stored, F[4], 1)).toBe(stored);
		expect(moveColumn(samples, stored, 'nope', 1)).toBe(stored);
	});
	it('clamps to the end of the list', () => {
		expect(shown(moveColumn(samples, null, F[1], 99))).toEqual([F[0], ...F.slice(2), F[1]]);
	});
});

describe('matchColumns', () => {
	it('filters by label, any case, and keeps every column for an empty search', () => {
		expect(fields(matchColumns(samples.columns, 'MATER'))).toEqual(['material_id']);
		expect(matchColumns(samples.columns, '  ')).toHaveLength(F.length);
		expect(matchColumns(samples.columns, 'zzz')).toEqual([]);
	});
});
