// The tray grid of a tool box: slots numbered 1..count in reading order (left to right, then down).
// Columns and rows are zero-based on each cell. An empty box gets a 1 x 1 grid with no cells, so the
// empty tray still has a size.

export interface SlotCell { number: number; column: number; row: number }
export interface SlotGrid { columns: number; rows: number; cells: SlotCell[] }

export function slotGrid(count: number): SlotGrid {
	const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	if (n === 0) return { columns: 1, rows: 1, cells: [] };
	// Wider than tall: 10 -> 5 x 2, 50 -> 12 x 5. Up to four slots stay on one row.
	const columns = n <= 4 ? n : Math.ceil(Math.sqrt(n * 2.5));
	const rows = Math.ceil(n / columns);
	const cells: SlotCell[] = [];
	for (let i = 0; i < n; i++) cells.push({ number: i + 1, column: i % columns, row: Math.floor(i / columns) });
	return { columns, rows, cells };
}
