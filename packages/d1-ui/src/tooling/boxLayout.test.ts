import { describe, expect, it } from 'vitest';
import { slotGrid } from './boxLayout';

describe('slotGrid', () => {
	it('puts one slot in a 1 x 1 grid', () => {
		expect(slotGrid(1)).toEqual({ columns: 1, rows: 1, cells: [{ number: 1, column: 0, row: 0 }] });
	});

	it('stands 2 slots in one column of two, and 3 in one column of three', () => {
		expect(slotGrid(2)).toMatchObject({ columns: 1, rows: 2 });
		expect(slotGrid(3)).toMatchObject({ columns: 1, rows: 3 });
	});

	it('lays 4 slots out 2 x 2 in reading order', () => {
		const g = slotGrid(4);
		expect([g.columns, g.rows]).toEqual([2, 2]);
		expect(g.cells.map((c) => [c.column, c.row])).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]]);
	});

	it('lays 5 slots out 2 x 3', () => {
		const g = slotGrid(5);
		expect([g.columns, g.rows]).toEqual([2, 3]);
		expect(g.cells[4]).toEqual({ number: 5, column: 0, row: 2 });
	});

	it('lays 10 slots out 2 columns x 5 rows in reading order, numbered from 1', () => {
		const g = slotGrid(10);
		expect([g.columns, g.rows]).toEqual([2, 5]);
		expect(g.cells).toHaveLength(10);
		expect(g.cells[0]).toEqual({ number: 1, column: 0, row: 0 });
		expect(g.cells[1]).toEqual({ number: 2, column: 1, row: 0 });
		expect(g.cells[2]).toEqual({ number: 3, column: 0, row: 1 });
		expect(g.cells[9]).toEqual({ number: 10, column: 1, row: 4 });
	});

	it('lays 12 slots out 3 x 4 and 50 slots out 5 x 10', () => {
		expect(slotGrid(12)).toMatchObject({ columns: 3, rows: 4 });
		const g = slotGrid(50);
		expect([g.columns, g.rows]).toEqual([5, 10]);
		expect(g.cells).toHaveLength(50);
		expect(g.cells[49]).toEqual({ number: 50, column: 4, row: 9 });
	});

	it('is always portrait: never more columns than rows', () => {
		for (let n = 1; n <= 120; n++) {
			const g = slotGrid(n);
			expect(g.rows).toBeGreaterThanOrEqual(g.columns);
		}
	});

	it('numbers every slot once, with no cell outside the grid', () => {
		for (const n of [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 20, 25, 50, 60, 101]) {
			const g = slotGrid(n);
			expect(g.cells.map((c) => c.number)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
			expect(g.columns * g.rows).toBeGreaterThanOrEqual(n);
			expect(g.cells.every((c) => c.column < g.columns && c.row < g.rows)).toBe(true);
		}
	});

	it('gives an empty tray one empty slot-sized cell for sizing, and survives junk', () => {
		expect(slotGrid(0)).toEqual({ columns: 1, rows: 1, cells: [] });
		expect(slotGrid(-3)).toEqual({ columns: 1, rows: 1, cells: [] });
		expect(slotGrid(Number.NaN)).toEqual({ columns: 1, rows: 1, cells: [] });
		expect(slotGrid(4.7).cells).toHaveLength(4);
	});
});
