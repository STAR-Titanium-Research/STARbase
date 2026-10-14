// The slots of the 2D grid, in reading order: the grid's own cells, then one extra cell per insert that has
// no slot number (marked "?"), so every insert stays selectable.

import type { ToolingInsert, ToolingModel } from '@d1/ui';

export interface Slot2D { key: string; label: string; insert: ToolingInsert | null }

export function gridSlots(model: ToolingModel): { columns: number; slots: Slot2D[] } {
	const byNumber = new Map<number, ToolingInsert>();
	for (const i of model.inserts) if (i.cell) byNumber.set(i.cell.number, i);
	const slots: Slot2D[] = model.grid.cells.map((c) => ({
		key: `n${c.number}`, label: String(c.number), insert: byNumber.get(c.number) ?? null,
	}));
	for (const i of model.inserts) if (!i.cell) slots.push({ key: `u${i.id}`, label: '?', insert: i });
	return { columns: model.grid.columns, slots };
}

export const STATE_LABEL: Record<ToolingInsert['state'], string> = {
	fresh: 'fresh', 'partly-used': 'part used', used: 'used', depleted: 'depleted',
};

// "3/4 fresh" for the slot caption; "depleted" or "no edges" where a count would mislead.
export function freshCaption(insert: ToolingInsert): string {
	if (insert.depleted) return 'depleted';
	if (insert.edges.length === 0) return 'no edges';
	return `${insert.edges.filter((e) => !e.used).length}/${insert.edges.length} fresh`;
}
