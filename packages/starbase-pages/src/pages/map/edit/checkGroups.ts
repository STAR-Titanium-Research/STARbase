// The rail's Checks section groups what is missing by card (spec E5): blocking first, then warnings. Pure, no Vue.

import type { Check, DraftKey } from '@d1/ui';

export interface CheckGroup {
	key: DraftKey;
	/** Blocking checks of this card first, then its warnings, each in the order they came in. */
	checks: Check[];
	blocking: number;
}

/**
 * One group per card (draft key), cards with blocking checks first (red), then the cards that only warn; inside a tier the
 * cards keep the order their first check came in, so the list does not jump about while someone types.
 */
export function groupChecks(list: readonly Check[]): CheckGroup[] {
	const byKey = new Map<DraftKey, Check[]>();
	for (const c of list) {
		const mine = byKey.get(c.key);
		if (mine) mine.push(c);
		else byKey.set(c.key, [c]);
	}
	const groups: CheckGroup[] = [...byKey].map(([key, checks]) => {
		const block = checks.filter((c) => c.level === 'block');
		return { key, checks: [...block, ...checks.filter((c) => c.level !== 'block')], blocking: block.length };
	});
	return [...groups.filter((g) => g.blocking > 0), ...groups.filter((g) => g.blocking === 0)];
}
