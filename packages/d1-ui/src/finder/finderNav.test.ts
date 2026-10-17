import { describe, expect, it } from 'vitest';
import type { FinderHit } from './finder';
import { bestIndex, isFinderShortcut, isModalOpen, isTypingKey, moveIndex, openHit, optionId, paneAllowed, sameHitIndex, shouldOpenFinder, toSections, widenLatch } from './finderNav';

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

describe('isTypingKey', () => {
	it('is true for a printable character', () => {
		expect(isTypingKey({ key: 'D' })).toBe(true);
		expect(isTypingKey({ key: '|' })).toBe(true);
		expect(isTypingKey({ key: '1', ctrlKey: false })).toBe(true);
	});
	it('is false for Space, Enter, Tab, arrows and shortcuts', () => {
		for (const key of [' ', 'Enter', 'Tab', 'ArrowDown', 'Escape', 'Shift']) expect(isTypingKey({ key })).toBe(false);
		expect(isTypingKey({ key: 'k', ctrlKey: true })).toBe(false);
		expect(isTypingKey({ key: 'k', metaKey: true })).toBe(false);
		expect(isTypingKey({ key: 'a', altKey: true })).toBe(false);
	});
});

describe('shouldOpenFinder', () => {
	const press = (over: Record<string, unknown> = {}) => ({
		key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, prevented: 0,
		preventDefault() { this.prevented++; }, ...over,
	});
	const doc = (modal: boolean) => ({ querySelector: () => (modal ? {} : null) });

	it('opens on Ctrl K with the finder closed and no modal', () => {
		const e = press();
		expect(shouldOpenFinder(e, false, doc(false))).toBe(true);
		expect(e.prevented).toBe(1);
	});
	it('does not open when the finder is already open', () => {
		expect(shouldOpenFinder(press(), true, doc(false))).toBe(false);
	});
	it('does not open over a drawer or dialog', () => {
		expect(shouldOpenFinder(press(), false, doc(true))).toBe(false);
	});
	it('ignores a plain k and leaves it alone', () => {
		const e = press({ ctrlKey: false });
		expect(shouldOpenFinder(e, false, doc(false))).toBe(false);
		expect(e.prevented).toBe(0);
	});
	it("still keeps the browser's own Ctrl K away when it does not open", () => {
		const open = press();
		shouldOpenFinder(open, true, doc(false));
		const modal = press();
		shouldOpenFinder(modal, false, doc(true));
		expect([open.prevented, modal.prevented]).toEqual([1, 1]);
	});
});

describe('openHit', () => {
	const sample: FinderHit = { group: 'Samples', label: 'S-1', to: '/home/samples/s1', rank: 1, record: { collection: 'physical_samples', id: 's1' } };

	it('navigates to the hit by default', () => {
		const calls: unknown[] = [];
		openHit(sample, (to) => calls.push(['navigate', to]));
		expect(calls).toEqual([['navigate', '/home/samples/s1']]);
	});

	it('with pickRecord, a record hit goes to the callback as collection + id and does not navigate', () => {
		const calls: unknown[] = [];
		openHit(sample, (to) => calls.push(['navigate', to]), (r) => calls.push(['pick', r]));
		expect(calls).toEqual([['pick', { collection: 'physical_samples', id: 's1' }]]);
	});

	it('a pickRecord that declines (returns false) leaves the hit to navigate, as if the host had none', () => {
		const calls: unknown[] = [];
		openHit(sample, (to) => calls.push(['navigate', to]), (r) => { calls.push(['pick', r]); return false; });
		expect(calls).toEqual([['pick', { collection: 'physical_samples', id: 's1' }], ['navigate', '/home/samples/s1']]);
	});

	it('with pickRecord, a hit that is not a record (a page) still navigates', () => {
		const calls: unknown[] = [];
		openHit(hit('Pages', 'Samples'), (to) => calls.push(['navigate', to]), (r) => calls.push(['pick', r]));
		expect(calls).toEqual([['navigate', '/x/Samples']]);
	});
});

const h = (group: FinderHit['group'], label: string, rank = 3, more?: true): FinderHit => ({ group, label, to: `/x/${label}`, rank, ...(more ? { more } : {}) });

describe('bestIndex', () => {
	it('is the first row when it is a pass 1 hit, and -1 for no rows', () => {
		expect(bestIndex([h('Pages', 'a', 2), h('Samples', 'b', 4)])).toBe(0);
		expect(bestIndex([])).toBe(-1);
	});

	it('skips pass 2 hits (rank 4) while a pass 1 hit exists', () => {
		expect(bestIndex([h('Samples', 'deep', 4), h('Samples', 'deeper', 4), h('Operations', 'code', 3)])).toBe(2);
	});

	it('is the first row when every hit is pass 2, and never a "More in" row', () => {
		expect(bestIndex([h('Samples', 'deep', 4), h('Operations', 'deeper', 4)])).toBe(0);
		expect(bestIndex([h('Samples', 'more', Number.POSITIVE_INFINITY, true), h('Operations', 'code', 3)])).toBe(1);
	});
});

describe('sameHitIndex', () => {
	it('finds the hit the user had made active in the new list', () => {
		expect(sameHitIndex(h('Samples', 'b'), [h('Samples', 'a'), h('Samples', 'x', 1), h('Samples', 'b')])).toBe(2);
	});

	it('falls back to the best match when it is gone or there was none', () => {
		expect(sameHitIndex(h('Samples', 'gone'), [h('Samples', 'deep', 4), h('Samples', 'code', 2)])).toBe(1);
		expect(sameHitIndex(undefined, [h('Samples', 'deep', 4), h('Samples', 'code', 2)])).toBe(1);
		expect(sameHitIndex(h('Samples', 'a'), [])).toBe(-1);
	});
});

describe('the preview pane', () => {
	const rec: FinderHit = { group: 'Samples', label: 'A', to: '/a', rank: 3, record: { collection: 'physical_samples', id: '1' } };
	const page: FinderHit = { group: 'Pages', label: 'Samples', to: '/home/samples', rank: 3 };
	const more: FinderHit = { group: 'Samples', label: 'More in Samples…', to: '/x', rank: Infinity, more: true };

	it('is not allowed for a host that picks the record, below the width, or over a scan', () => {
		expect(paneAllowed({ pickRecord: false, roomy: true, scanning: false })).toBe(true);
		expect(paneAllowed({ pickRecord: true, roomy: true, scanning: false })).toBe(false);
		expect(paneAllowed({ pickRecord: false, roomy: false, scanning: false })).toBe(false);
		expect(paneAllowed({ pickRecord: false, roomy: true, scanning: true })).toBe(false);
	});

	it('widens on the first record hit, not for pages, saved views or a "More in" row', () => {
		expect(widenLatch(false, true, false, [])).toBe(false);
		expect(widenLatch(false, true, false, [page, more])).toBe(false);
		expect(widenLatch(false, true, false, [page, rec])).toBe(true);
	});

	it('stays wide while the record hits are gone between two answers, and resets when the box cannot be searched or holds a scan', () => {
		expect(widenLatch(true, true, false, [])).toBe(true);
		expect(widenLatch(true, false, false, [])).toBe(false);
		expect(widenLatch(true, true, true, [rec])).toBe(false);
	});
});
