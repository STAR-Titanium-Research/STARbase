// Words for the 2D view: an insert's state and its "3/4 fresh" caption.

import { edgeSummary, type ToolingInsert } from '@d1/ui';

export const STATE_LABEL: Record<ToolingInsert['state'], string> = {
	fresh: 'fresh', 'partly-used': 'part used', used: 'used', depleted: 'depleted',
};

// "3/4 fresh" for the slot caption (the 4 is the type's edge count: a missing edge is not fresh, a duplicate record is not
// counted); "depleted" or "no edges" where a count would mislead.
export function freshCaption(insert: ToolingInsert): string {
	if (insert.depleted) return 'depleted';
	if (insert.edges.length === 0) return 'no edges';
	const { fresh, total } = edgeSummary(insert);
	return `${fresh}/${total} fresh`;
}
