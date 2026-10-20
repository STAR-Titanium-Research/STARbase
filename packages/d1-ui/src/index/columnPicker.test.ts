import { describe, expect, it } from 'vitest';
import { columnsSummary, hiddenColumns, isFixedColumn, matchColumns, moveColumn, shownColumns, toggleColumn } from './columnPicker';
import { indexDefBySlug } from './indexConfig';

const samples = indexDefBySlug('samples')!;
const F = samples.columns.map((c) => c.field);
const fields = (cols: { field: string }[]) => cols.map((c) => c.field);

describe('the shown and hidden columns', () => {
	it("shows every column, in the def's order, when nothing is stored", () => {
		expect(fields(shownColumns(samples, null))).toEqual(F);
		expect(hiddenColumns(samples, null)).toEqual([]);
		expect(columnsSummary(samples, null)).toBe(`${F.length} of ${F.length} shown`);
	});
	it("shows the stored ones in the stored order, and lists the rest as hidden in the def's order", () => {
		const stored = [F[0], F[3], F[1]];
		expect(fields(shownColumns(samples, stored))).toEqual(stored);
		expect(fields(hiddenColumns(samples, stored))).toEqual(F.filter((f) => !stored.includes(f)));
		expect(columnsSummary(samples, stored)).toBe(`3 of ${F.length} shown`);
	});
	it('knows the first column is fixed', () => {
		expect(isFixedColumn(samples, F[0])).toBe(true);
		expect(isFixedColumn(samples, F[1])).toBe(false);
	});
});

describe('toggleColumn', () => {
	it('hides a column, and shows it again at the end', () => {
		const hidden = toggleColumn(samples, null, F[2]);
		expect(hidden).toEqual(F.filter((f) => f !== F[2]));
		expect(toggleColumn(samples, hidden, F[2])).toEqual([...F.filter((f) => f !== F[2]), F[2]]);
	});
	it("goes back to null (the default) when every column is shown in the def's order", () => {
		expect(toggleColumn(samples, F.filter((f) => f !== F.at(-1)), F.at(-1)!)).toBeNull();
	});
	it('never hides the first column', () => {
		expect(toggleColumn(samples, null, F[0])).toBeNull();
		expect(toggleColumn(samples, [F[0], F[1]], F[0])).toEqual([F[0], F[1]]);
	});
});

describe('moveColumn', () => {
	it('moves a shown column to a position among the shown ones', () => {
		expect(moveColumn(samples, null, F[3], 1)).toEqual([F[0], F[3], F[1], F[2], ...F.slice(4)]);
		expect(moveColumn(samples, [F[0], F[1], F[2]], F[1], 2)).toEqual([F[0], F[2], F[1]]);
	});
	it('keeps the first column first, and a column that is not shown where it is', () => {
		expect(moveColumn(samples, null, F[2], 0)?.[0]).toBe(F[0]);
		expect(moveColumn(samples, null, F[0], 3)).toBeNull();
		expect(moveColumn(samples, [F[0], F[1]], F[4], 1)).toEqual([F[0], F[1]]);
	});
	it('clamps to the end of the list', () => {
		expect(moveColumn(samples, [F[0], F[1], F[2]], F[1], 99)).toEqual([F[0], F[2], F[1]]);
	});
});

describe('matchColumns', () => {
	it('filters by label, any case, and keeps every column for an empty search', () => {
		expect(fields(matchColumns(samples.columns, 'MATER'))).toEqual(['material_id']);
		expect(matchColumns(samples.columns, '  ')).toHaveLength(F.length);
		expect(matchColumns(samples.columns, 'zzz')).toEqual([]);
	});
});
