// The tray grid of a tool box: slots numbered 1..count in reading order (left to right, then down).
// Columns and rows are zero-based on each cell. An empty box gets a 1 x 1 grid with no cells, so the
// empty tray still has a size.

export interface SlotCell { number: number; column: number; row: number }
export interface SlotGrid { columns: number; rows: number; cells: SlotCell[] }

// Portrait: the long side of the tray runs down the stage (rows >= columns). The columns are the pick of
// 1..n that is closest to a 1.8 : 1 tall tray, with a small charge for each empty slot in the last row.
// 1 -> 1 x 1, 4 -> 2 x 2, 5 -> 2 x 3, 10 -> 2 x 5, 12 -> 3 x 4, 50 -> 5 x 10.
const TARGET_ASPECT = 1.8;
const EMPTY_SLOT_COST = 0.1;

function portraitColumns(n: number): number {
	let best = 1;
	let bestCost = Infinity;
	for (let columns = 1; columns <= n; columns++) {
		const rows = Math.ceil(n / columns);
		if (rows < columns) break;
		const cost = Math.abs(Math.log(rows / columns / TARGET_ASPECT)) + (rows * columns - n) * EMPTY_SLOT_COST;
		if (cost < bestCost - 1e-9) { best = columns; bestCost = cost; }
	}
	return best;
}

export function slotGrid(count: number): SlotGrid {
	const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	if (n === 0) return { columns: 1, rows: 1, cells: [] };
	const columns = portraitColumns(n);
	const rows = Math.ceil(n / columns);
	const cells: SlotCell[] = [];
	for (let i = 0; i < n; i++) cells.push({ number: i + 1, column: i % columns, row: Math.floor(i / columns) });
	return { columns, rows, cells };
}
