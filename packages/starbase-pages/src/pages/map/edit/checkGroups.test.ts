import { describe, expect, it } from 'vitest';
import type { Check } from '@d1/ui';
import { groupChecks } from './checkGroups';

const c = (key: string, level: 'block' | 'warn', text: string): Check => ({ key, level, text });

describe('groupChecks', () => {
	it('is empty for no checks', () => {
		expect(groupChecks([])).toEqual([]);
	});

	it('groups by card, cards with blocking checks first, then the ones that only warn', () => {
		const groups = groupChecks([c('n1', 'warn', 'no machine'), c('n2', 'block', 'no method'), c('n3', 'warn', 'no date'), c('n4', 'block', 'no type')]);
		expect(groups.map((g) => g.key)).toEqual(['n2', 'n4', 'n1', 'n3']);
		expect(groups.map((g) => g.blocking)).toEqual([1, 1, 0, 0]);
	});

	it("lists a card's blocking checks before its warnings, keeping the order inside each", () => {
		const [g] = groupChecks([c('n1', 'warn', 'w1'), c('n1', 'block', 'b1'), c('n1', 'warn', 'w2'), c('n1', 'block', 'b2')]);
		expect(g.checks.map((x) => x.text)).toEqual(['b1', 'b2', 'w1', 'w2']);
		expect(g.blocking).toBe(2);
	});

	it('keeps the order cards first appeared in within a tier', () => {
		const groups = groupChecks([c('n3', 'block', 'a'), c('n1', 'block', 'b'), c('n3', 'block', 'c')]);
		expect(groups.map((g) => g.key)).toEqual(['n3', 'n1']);
		expect(groups[0].checks).toHaveLength(2);
	});
});
