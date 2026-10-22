import { describe, expect, it } from 'vitest';
import { STAT_READS } from './labStatReads';

/** Whether a row of `manufacturing_operations` with this category passes a `process_category` filter of the shape the reads use. */
function passes(filter: unknown, category: string): boolean {
	const c = (filter as { process_category?: { _eq?: string; _nin?: string[] } } | undefined)?.process_category;
	if (!c) return true;
	if (c._eq !== undefined) return category === c._eq;
	if (c._nin) return !c._nin.includes(category);
	throw new Error('an unexpected filter');
}

const read = (key: string) => STAT_READS.find((r) => r.key === key)!;

describe('Home lab stats', () => {
	it('keeps the six tiles, in order', () => {
		expect(STAT_READS.map((r) => r.key)).toEqual(['samples', 'machining', 'fast', 'tests', 'projects', 'campaigns']);
	});

	it('does not count Conform runs as Machining, or as FAST', () => {
		expect(passes(read('machining').filter, 'conform')).toBe(false);
		expect(passes(read('fast').filter, 'conform')).toBe(false);
	});

	it('still counts machining and every other non-sintering category as Machining, and sintering as FAST', () => {
		for (const category of ['machining', 'deformation', 'coating']) expect(passes(read('machining').filter, category), category).toBe(true);
		expect(passes(read('machining').filter, 'sintering')).toBe(false);
		expect(passes(read('fast').filter, 'sintering')).toBe(true);
		expect(passes(read('fast').filter, 'machining')).toBe(false);
	});
});
