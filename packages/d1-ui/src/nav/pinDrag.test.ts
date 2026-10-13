import { describe, expect, it } from 'vitest';
import { dropIndex, dropResult, moveAmongShown, sameOrder, savedIndexFor } from './pinDrag';
import type { PinRef, ResolvedPin } from './sidebarModel';

const page = (t: string): PinRef => ({ kind: 'page', target: t });
const shownOf = (...ts: string[]): ResolvedPin[] => ts.map((t) => ({ ref: page(t), label: t, hint: null, to: `/home/${t}`, icon: 'home' }));
const targets = (l: PinRef[]) => l.map((p) => p.target);

describe('dropIndex', () => {
	it('is before the row in its upper half and after it in its lower half', () => {
		expect(dropIndex(2, 0.2)).toBe(2);
		expect(dropIndex(2, 0.5)).toBe(3);
		expect(dropIndex(2, 0.9)).toBe(3);
	});
});

describe('savedIndexFor', () => {
	// c is saved between b and d but not shown (a pin the person lost).
	const pins = [page('a'), page('b'), page('c'), page('d')];
	const shown = shownOf('a', 'b', 'd');

	it('maps a position among the rows shown to the saved list', () => {
		expect(savedIndexFor(pins, shown, 0)).toBe(0);
		expect(savedIndexFor(pins, shown, 2)).toBe(3);
	});

	it('puts a drop after the last row at the end of the saved list', () => {
		expect(savedIndexFor(pins, shown, 3)).toBe(4);
	});

	it('puts a drop after the last row of a cut list before the first row cut', () => {
		expect(savedIndexFor(pins, shown, 1)).toBe(1);
		expect(savedIndexFor([page('a'), page('b'), page('d')], shown, 2)).toBe(2);
	});
});

describe('dropResult', () => {
	const pins = [page('a'), page('b'), page('c')];
	const shown = shownOf('a', 'b', 'c');

	it('moves a pinned row', () => {
		const r = dropResult(pins, shown, page('c'), 0);
		expect(r.pinFirst).toBe(false);
		expect(targets(r.next)).toEqual(['c', 'a', 'b']);
	});

	it('moves a pinned row to the end', () => {
		expect(targets(dropResult(pins, shown, page('a'), 3).next)).toEqual(['b', 'c', 'a']);
	});

	it('drops onto its own place without changing the order', () => {
		const r = dropResult(pins, shown, page('b'), 1);
		expect(sameOrder(r.next, pins)).toBe(true);
		expect(sameOrder(dropResult(pins, shown, page('b'), 2).next, pins)).toBe(true);
	});

	it('inserts an unpinned item where it was dropped and says it has to be pinned first', () => {
		const r = dropResult(pins, shown, page('x'), 1);
		expect(r.pinFirst).toBe(true);
		expect(targets(r.next)).toEqual(['a', 'x', 'b', 'c']);
		expect(targets(dropResult(pins, shown, page('x'), 3).next)).toEqual(['a', 'b', 'c', 'x']);
	});
});

describe('moveAmongShown', () => {
	const pins = [page('a'), page('b'), page('c'), page('d')];

	it('moves one row among those shown', () => {
		const shown = shownOf('a', 'b', 'c', 'd');
		expect(targets(moveAmongShown(pins, shown, page('c'), -1)!)).toEqual(['a', 'c', 'b', 'd']);
		expect(targets(moveAmongShown(pins, shown, page('b'), 1)!)).toEqual(['a', 'c', 'b', 'd']);
	});

	it('steps over a pin that is not shown', () => {
		const shown = shownOf('a', 'b', 'd'); // c is not shown
		expect(targets(moveAmongShown(pins, shown, page('b'), 1)!)).toEqual(['a', 'c', 'd', 'b']);
		expect(targets(moveAmongShown(pins, shown, page('d'), -1)!)).toEqual(['a', 'd', 'b', 'c']);
	});

	it('is null at the ends and for a pin that is not shown', () => {
		const shown = shownOf('a', 'b', 'c', 'd');
		expect(moveAmongShown(pins, shown, page('a'), -1)).toBeNull();
		expect(moveAmongShown(pins, shown, page('d'), 1)).toBeNull();
		expect(moveAmongShown(pins, shown, page('zz'), 1)).toBeNull();
	});
});
