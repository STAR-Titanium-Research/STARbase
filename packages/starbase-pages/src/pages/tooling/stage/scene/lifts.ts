// A focused insert is raised out of its pocket; these are the lifts (mm) per insert and how they ease.

import type { ToolingFocus } from '@d1/ui';

export const LIFT_MM = 9;

export function liftTargets(focus: ToolingFocus): Map<string, number> {
	return new Map(focus.kind === 'box' ? [] : [[focus.insertId, LIFT_MM]]);
}

// The lifts at eased progress `e` (0 to 1) between two sets; an insert absent from a set sits at 0.
export function stepLifts(from: ReadonlyMap<string, number>, to: ReadonlyMap<string, number>, e: number): Map<string, number> {
	const out = new Map<string, number>();
	for (const id of new Set([...from.keys(), ...to.keys()])) {
		const a = from.get(id) ?? 0;
		const b = to.get(id) ?? 0;
		const v = a + (b - a) * e;
		if (v !== 0) out.set(id, v);
	}
	return out;
}
