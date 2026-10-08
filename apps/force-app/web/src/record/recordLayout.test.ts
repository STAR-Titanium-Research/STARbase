import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, dockPanel, oppositeSide, parseDismissedIds, parseSavedLayout } from './recordLayout';

const KNOWN = { options: {}, force: {}, frm: {} };
const item = (i: string, type: string, extra: object = {}) => ({ i, type, x: 0, y: 0, w: 2, h: 2, ...extra });

describe('parseSavedLayout (nit: unknown panel type must be skipped, invariant 11)', () => {
	it('keeps the known panels when a newer release saved one this version does not know', () => {
		const raw = JSON.stringify([item('a', 'options'), item('b', 'hologram'), item('c', 'force', { mode: 'psd' })]);
		const out = parseSavedLayout(raw, KNOWN)!;
		expect(out.map((p) => p.i)).toEqual(['a', 'c']);
		expect((out[1] as any).mode).toBe('psd');
	});

	it('drops entries without a usable grid position or id', () => {
		const raw = JSON.stringify([item('a', 'frm'), { i: 'b', type: 'frm' }, null, 7, item('c', 'frm', { w: 'wide' })]);
		expect(parseSavedLayout(raw, KNOWN)!.map((p) => p.i)).toEqual(['a']);
	});

	it('does not accept inherited keys as panel types', () => {
		expect(parseSavedLayout(JSON.stringify([item('a', 'toString')]), KNOWN)).toBeNull();
	});

	it('returns null (use the default) when nothing is readable or nothing survives', () => {
		expect(parseSavedLayout(null, KNOWN)).toBeNull();
		expect(parseSavedLayout('{not json', KNOWN)).toBeNull();
		expect(parseSavedLayout('{"a":1}', KNOWN)).toBeNull();
		expect(parseSavedLayout(JSON.stringify([item('a', 'gone')]), KNOWN)).toBeNull();
	});

	it('keeps an empty layout: the operator closed every panel', () => {
		expect(parseSavedLayout('[]', KNOWN)).toEqual([]);
	});
});

describe('parseDismissedIds (nit: JSON.parse outside try)', () => {
	it('reads a saved list', () => {
		expect([...parseDismissedIds('["a","b"]')]).toEqual(['a', 'b']);
	});
	it('treats damaged or foreign data as none instead of throwing in setup', () => {
		expect(parseDismissedIds('{oops').size).toBe(0);
		expect(parseDismissedIds('{"a":1}').size).toBe(0);
		expect(parseDismissedIds(null).size).toBe(0);
		expect([...parseDismissedIds('["a",3,null]')]).toEqual(['a']);
	});
});

describe('dockPanel (#136: move the Recording & Metadata panel to the other side)', () => {
	const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
		a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	const noOverlaps = (l: { i: string; x: number; y: number; w: number; h: number }[]) =>
		l.every((a, n) => l.slice(n + 1).every((b) => !overlaps(a, b)));
	const bottom = (l: { y: number; h: number }[]) => Math.max(...l.map((p) => p.y + p.h));
	const byId = <T extends { i: string }>(l: T[], id: string): T => l.find((p) => p.i === id)!;

	it('docks the full-height panel on the right and shifts the others across, same bottom row', () => {
		const out = dockPanel(DEFAULT_LAYOUT, 'options', 'right', 12);
		expect(byId(out, 'options').x).toBe(10);
		for (const id of ['overview', 'force', 'tacho', 'frm', 'rpm']) {
			expect(byId(out, id).x).toBe(byId(DEFAULT_LAYOUT, id).x - 2);
			expect(byId(out, id).y).toBe(byId(DEFAULT_LAYOUT, id).y);
			expect(byId(out, id).w).toBe(byId(DEFAULT_LAYOUT, id).w);
		}
		expect(noOverlaps(out)).toBe(true);
		expect(bottom(out)).toBe(bottom(DEFAULT_LAYOUT));
		// Columns 0-1 are not left empty: something starts at x=0.
		expect(Math.min(...out.map((p) => p.x))).toBe(0);
	});

	it('docking back on the left restores the default', () => {
		const right = dockPanel(DEFAULT_LAYOUT, 'options', 'right', 12);
		expect(dockPanel(right, 'options', 'left', 12)).toEqual(DEFAULT_LAYOUT);
	});

	it('does not mutate its input and leaves an already-docked panel alone', () => {
		const copy = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
		const out = dockPanel(DEFAULT_LAYOUT, 'options', 'left', 12);
		expect(DEFAULT_LAYOUT).toEqual(copy);
		expect(out).toEqual(DEFAULT_LAYOUT);
		expect(out).not.toBe(DEFAULT_LAYOUT);
	});

	it('keeps extra fields and ignores an unknown id', () => {
		const out = dockPanel(DEFAULT_LAYOUT, 'options', 'right', 12);
		expect(byId(out, 'tacho')).toMatchObject({ mode: 'time', channels: ['Tacho'] });
		expect(dockPanel(DEFAULT_LAYOUT, 'nope', 'right', 12)).toEqual(DEFAULT_LAYOUT);
	});

	it('works for a panel in the middle of a row of panels', () => {
		const l = [
			{ i: 'a', type: 'frm', x: 0, y: 0, w: 4, h: 5 },
			{ i: 'b', type: 'options', x: 4, y: 0, w: 2, h: 5 },
			{ i: 'c', type: 'frm', x: 6, y: 0, w: 6, h: 5 },
		];
		const right = dockPanel(l, 'b', 'right', 12);
		expect(right.map((p) => [p.i, p.x])).toEqual([['a', 0], ['b', 10], ['c', 4]]);
		expect(noOverlaps(right)).toBe(true);
		const left = dockPanel(l, 'b', 'left', 12);
		expect(left.map((p) => [p.i, p.x])).toEqual([['a', 2], ['b', 0], ['c', 6]]);
		expect(noOverlaps(left)).toBe(true);
	});

	it('moves panels stacked in the same columns together with the docked one', () => {
		const l = [
			{ i: 'options', type: 'options', x: 0, y: 0, w: 2, h: 14 },
			{ i: 'rpm', type: 'rpm', x: 0, y: 14, w: 2, h: 8 },
			{ i: 'force', type: 'force', x: 2, y: 0, w: 6, h: 12 },
			{ i: 'frm', type: 'frm', x: 8, y: 0, w: 4, h: 22 },
		];
		const out = dockPanel(l, 'options', 'right', 12);
		expect(byId(out, 'options').x).toBe(10);
		expect(byId(out, 'rpm')).toMatchObject({ x: 10, y: 14 });
		expect(byId(out, 'force').x).toBe(0);
		expect(byId(out, 'frm').x).toBe(6);
		expect(noOverlaps(out)).toBe(true);
		expect(bottom(out)).toBe(bottom(l));
		const back = dockPanel(out, 'options', 'left', 12);
		expect(back).toEqual(l);
	});

	it('keeps a narrower stacked panel at its offset inside the strip', () => {
		const l = [
			{ i: 'options', type: 'options', x: 0, y: 0, w: 3, h: 10 },
			{ i: 'rpm', type: 'rpm', x: 1, y: 10, w: 2, h: 4 },
			{ i: 'force', type: 'force', x: 3, y: 0, w: 9, h: 14 },
		];
		const out = dockPanel(l, 'options', 'right', 12);
		expect(byId(out, 'options').x).toBe(9);
		expect(byId(out, 'rpm').x).toBe(10);
		expect(noOverlaps(out)).toBe(true);
	});

	it('mirrors the whole layout when a panel straddles the strip edge', () => {
		const l = [
			{ i: 'options', type: 'options', x: 0, y: 0, w: 2, h: 14 },
			{ i: 'wide', type: 'force', x: 0, y: 14, w: 5, h: 6 },
			{ i: 'force', type: 'force', x: 2, y: 0, w: 6, h: 14 },
			{ i: 'frm', type: 'frm', x: 8, y: 0, w: 4, h: 14 },
			{ i: 'rpm', type: 'rpm', x: 5, y: 14, w: 7, h: 6 },
		];
		const out = dockPanel(l, 'options', 'right', 12);
		expect(byId(out, 'options').x).toBe(10);
		expect(byId(out, 'wide').x).toBe(7);
		expect(byId(out, 'rpm').x).toBe(0);
		expect(noOverlaps(out)).toBe(true);
		expect(bottom(out)).toBe(bottom(l));
		for (const o of l) expect(byId(out, o.i)).toMatchObject({ y: o.y, w: o.w, h: o.h });
	});

	it('oppositeSide says where the button sends the panel', () => {
		expect(oppositeSide(DEFAULT_LAYOUT, 'options')).toBe('right');
		const right = dockPanel(DEFAULT_LAYOUT, 'options', 'right', 12);
		expect(oppositeSide(right, 'options')).toBe('left');
		expect(oppositeSide(DEFAULT_LAYOUT, 'nope')).toBe('right');
	});
});
