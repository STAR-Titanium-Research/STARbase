import { describe, expect, it } from 'vitest';
import { RIGHT_DEFAULT, layoutColumns, layoutMode, startingGrid, tabForNumberKey, tabTarget } from './forceLayout';

const TYPES = ['signals', 'frm', 'wear', 'doctor'];
const OLD_DEFAULT = [
	{ i: 'signals', type: 'signals', x: 0, y: 0, w: 6, h: 20, channels: ['Fx', 'Fy', 'Fz'], rpm: false },
	{ i: 'frm', type: 'frm', x: 6, y: 0, w: 6, h: 20 },
];

describe('layoutMode / layoutColumns', () => {
	it('is four columns from 1800px, lists folded to a 44px tab below, stacked under 900px', () => {
		expect(layoutMode(1828)).toBe('wide'); expect(layoutMode(1800)).toBe('wide');
		expect(layoutMode(1799)).toBe('folded'); expect(layoutMode(900)).toBe('folded');
		expect(layoutMode(899)).toBe('stacked');
		expect(layoutColumns('wide')).toBe('256px 330px minmax(0, 1fr)');
		expect(layoutColumns('folded')).toBe('44px 300px minmax(0, 1fr)');
		expect(layoutColumns('stacked')).toBe('minmax(0, 1fr)');
	});
});

describe('startingGrid', () => {
	it('puts the FRM left of Signals by default', () => {
		const g = startingGrid(null, TYPES);
		expect(g.map((p) => p.type)).toEqual(['frm', 'signals']);
		expect(g[0].x).toBeLessThan(g[1].x);
	});
	it('hands out copies, so closing a panel never edits the default', () => {
		const g = startingGrid(undefined, TYPES);
		g[0].x = 99;
		expect(RIGHT_DEFAULT[0].x).toBe(0);
	});
	it('moves the old untouched default (Signals left, FRM right) to the new one', () => {
		expect(startingGrid(OLD_DEFAULT, TYPES)).toEqual(RIGHT_DEFAULT);
	});
	it('keeps an arrangement the user made, including one that puts Signals left', () => {
		const mine = [{ ...OLD_DEFAULT[0], w: 4 }, { ...OLD_DEFAULT[1], x: 4, w: 8 }];
		expect(startingGrid(mine, TYPES)).toEqual(mine);
		const withWear = [...OLD_DEFAULT, { i: 'wear-1', type: 'wear', x: 0, y: 20, w: 6, h: 10 }];
		expect(startingGrid(withWear, TYPES)).toEqual(withWear);
	});
	it('falls back to the default for a grid with an unknown panel type, an empty or a malformed value', () => {
		expect(startingGrid([{ i: 'x', type: 'nope', x: 0, y: 0, w: 1, h: 1 }], TYPES)).toEqual(RIGHT_DEFAULT);
		expect(startingGrid([], TYPES)).toEqual(RIGHT_DEFAULT);
		expect(startingGrid('junk', TYPES)).toEqual(RIGHT_DEFAULT);
		expect(startingGrid([null], TYPES)).toEqual(RIGHT_DEFAULT);
	});
});

describe('tab keys', () => {
	it('moves between tabs with the arrow keys, wrapping, and to the ends with Home / End', () => {
		expect(tabTarget('ArrowRight', 4, 5)).toBe(0);
		expect(tabTarget('ArrowLeft', 0, 5)).toBe(4);
		expect(tabTarget('ArrowRight', 1, 5)).toBe(2);
		expect(tabTarget('Home', 3, 5)).toBe(0);
		expect(tabTarget('End', 0, 5)).toBe(4);
		expect(tabTarget('Tab', 0, 5)).toBeNull();
	});
	const ev = (key: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }> = {}) =>
		({ key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...over });
	it('keys 1-5 pick a tab', () => {
		expect(tabForNumberKey(ev('1'), 5)).toBe(0);
		expect(tabForNumberKey(ev('5'), 5)).toBe(4);
		expect(tabForNumberKey(ev('6'), 5)).toBeNull();
		expect(tabForNumberKey(ev('0'), 5)).toBeNull();
		expect(tabForNumberKey(ev('a'), 5)).toBeNull();
		expect(tabForNumberKey(ev('12'), 5)).toBeNull();
	});
	it('ignores them with a modifier or while typing in a field', () => {
		expect(tabForNumberKey(ev('2', { ctrlKey: true }), 5)).toBeNull();
		expect(tabForNumberKey(ev('2', { metaKey: true }), 5)).toBeNull();
		expect(tabForNumberKey(ev('2', { altKey: true }), 5)).toBeNull();
		const typing = { closest: (sel: string) => (sel.includes('input') ? {} : null) };
		expect(tabForNumberKey(ev('2', { target: typing }), 5)).toBeNull();
		expect(tabForNumberKey(ev('2', { target: { closest: () => null } }), 5)).toBe(1);
	});
});
