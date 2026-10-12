import { describe, expect, it } from 'vitest';
import type { FinderHit } from './finder';
import { isFinderShortcut, isModalOpen, moveIndex, optionId, toSections } from './finderNav';

const hit = (group: FinderHit['group'], label: string): FinderHit => ({ group, label, to: `/x/${label}`, rank: 3 });

describe('toSections', () => {
	it('groups contiguous hits and numbers the options across groups', () => {
		const sections = toSections([hit('Pages', 'a'), hit('Samples', 'b'), hit('Samples', 'c'), hit('People', 'd')], 'f');
		expect(sections.map((s) => [s.group, s.items.map((i) => i.index)])).toEqual([
			['Pages', [0]],
			['Samples', [1, 2]],
			['People', [3]],
		]);
		expect(sections[1].items[1]).toMatchObject({ id: optionId('f', 2), hit: { label: 'c' } });
		expect(sections.map((s) => s.headingId)).toEqual(['f-grp-0', 'f-grp-1', 'f-grp-2']);
	});

	it('is empty for no hits', () => {
		expect(toSections([], 'f')).toEqual([]);
	});
});

describe('moveIndex', () => {
	it('moves one step and wraps at both ends', () => {
		expect(moveIndex(0, 1, 3)).toBe(1);
		expect(moveIndex(2, 1, 3)).toBe(0);
		expect(moveIndex(0, -1, 3)).toBe(2);
		expect(moveIndex(2, -1, 3)).toBe(1);
	});

	it('starts at the first on down and the last on up when nothing is active', () => {
		expect(moveIndex(-1, 1, 4)).toBe(0);
		expect(moveIndex(-1, -1, 4)).toBe(3);
		expect(moveIndex(9, 1, 4)).toBe(0);
	});

	it('has no active option in an empty list', () => {
		expect(moveIndex(0, 1, 0)).toBe(-1);
		expect(moveIndex(-1, -1, 0)).toBe(-1);
	});

	it('stays put in a one-item list', () => {
		expect(moveIndex(0, 1, 1)).toBe(0);
		expect(moveIndex(0, -1, 1)).toBe(0);
	});
});

describe('isFinderShortcut', () => {
	const key = (over: Partial<Parameters<typeof isFinderShortcut>[0]>) => ({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

	it('accepts Ctrl K and Cmd K, in either case', () => {
		expect(isFinderShortcut(key({ ctrlKey: true }))).toBe(true);
		expect(isFinderShortcut(key({ metaKey: true }))).toBe(true);
		expect(isFinderShortcut(key({ ctrlKey: true, key: 'K' }))).toBe(true);
	});

	it('rejects a bare K, other keys and extra modifiers', () => {
		expect(isFinderShortcut(key({}))).toBe(false);
		expect(isFinderShortcut(key({ ctrlKey: true, key: 'j' }))).toBe(false);
		expect(isFinderShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(isFinderShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
	});
});

describe('isModalOpen', () => {
	it('asks the document for the selector it is given, and says whether anything matched', () => {
		const asked: string[] = [];
		const doc = (found: boolean) => ({ querySelector: (sel: string) => (asked.push(sel), found ? {} : null) });
		expect(isModalOpen(doc(true), '#some-outlet > *')).toBe(true);
		expect(isModalOpen(doc(false), '#some-outlet > *')).toBe(false);
		expect(asked).toEqual(['#some-outlet > *', '#some-outlet > *']);
	});
});
