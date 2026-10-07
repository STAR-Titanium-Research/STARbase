import { describe, expect, it } from 'vitest';
import { parseDismissedIds, parseSavedLayout } from './recordLayout';

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
