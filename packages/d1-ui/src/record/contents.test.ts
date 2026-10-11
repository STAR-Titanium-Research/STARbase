import { describe, expect, it } from 'vitest';
import { contentsModel, type ContentsEntry } from './contents';

const entries: ContentsEntry[] = [
	{ id: 'details', title: 'Details', count: null },
	{ id: 'samples', title: 'Samples', count: 3 },
	{ id: 'files', title: 'Files', count: 0 },
];

describe('contentsModel', () => {
	it('marks an entry with a zero count as empty, and null or positive counts as not', () => {
		const m = contentsModel(entries, new Set());
		expect(m.map((e) => e.empty)).toEqual([false, false, true]);
	});

	it('marks the first entry in page order whose id is visible as current', () => {
		const m = contentsModel(entries, new Set(['files', 'samples']));
		expect(m.map((e) => e.current)).toEqual([false, true, false]);
	});

	it('has no current entry when none is visible', () => {
		expect(contentsModel(entries, new Set()).some((e) => e.current)).toBe(false);
	});

	it('keeps the order and the fields', () => {
		const m = contentsModel(entries, new Set(['details']));
		expect(m.map((e) => e.id)).toEqual(['details', 'samples', 'files']);
		expect(m[1]).toMatchObject({ title: 'Samples', count: 3 });
	});
});
