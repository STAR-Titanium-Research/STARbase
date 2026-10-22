import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, VIEW_KEY, readOpenScanFolders, readViewSettings, scanStripKey, useViewSettings, writeOpenScanFolders, writeViewSettings } from './useViewSettings';

/** A Storage that holds strings in a Map, for the tests. */
function memory(initial: Record<string, string> = {}): Storage & { map: Map<string, string> } {
	const map = new Map(Object.entries(initial));
	return {
		map,
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (k: string) => map.get(k) ?? null,
		key: (i: number) => [...map.keys()][i] ?? null,
		removeItem: (k: string) => void map.delete(k),
		setItem: (k: string, v: string) => void map.set(k, v),
	};
}
const throwing = (): Storage => {
	const boom = () => {
		throw new Error('blocked');
	};
	return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
};

describe('the Inbox view settings', () => {
	it('uses the key d1.list.inbox and defaults to the sheet and an open rail', () => {
		expect(VIEW_KEY).toBe('d1.list.inbox');
		expect(DEFAULT_VIEW).toEqual({
			preview: 'sheet', railOpen: true, boxRailOpen: true, zoom: 'fit', scaleBar: true, contrast: false, compareList: false, compare: 'off', linkZoom: true, commonScale: true,
		});
		expect(readViewSettings(memory())).toEqual(DEFAULT_VIEW);
	});

	it('reads what was stored', () => {
		const all = { preview: 'box', railOpen: false, boxRailOpen: false, zoom: 'actual', scaleBar: false, contrast: true, compareList: true, compare: 'side', linkZoom: false, commonScale: false };
		const s = memory({ [VIEW_KEY]: JSON.stringify(all) });
		expect(readViewSettings(s)).toEqual(all);
	});

	it('gives the defaults for invalid JSON, and for JSON that is not an object', () => {
		for (const raw of ['{not json', '', 'null', '[1,2]', '"sheet"', '42']) expect(readViewSettings(memory({ [VIEW_KEY]: raw }))).toEqual(DEFAULT_VIEW);
	});

	it('checks each field on its own: a good one survives a bad one, an unknown value falls back', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'box', railOpen: 'yes' }) });
		expect(readViewSettings(s)).toEqual({ ...DEFAULT_VIEW, preview: 'box' });
	});

	it('falls back per field for the view box settings: an unknown zoom, a non-boolean overlay', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ zoom: '2:1', scaleBar: 'on', contrast: 1, boxRailOpen: null, railOpen: false }) });
		expect(readViewSettings(s)).toEqual({ ...DEFAULT_VIEW, railOpen: false });
		const old = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'box', railOpen: true }) }); // stored before the view box existed
		expect(readViewSettings(old)).toEqual({ ...DEFAULT_VIEW, preview: 'box' });
	});

	it('falls back per field for the compare settings: an unknown mode, non-boolean switches; a good one survives', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ compare: 'stacked', compareList: 'yes', linkZoom: 0, commonScale: null, preview: 'box' }) });
		expect(readViewSettings(s)).toEqual({ ...DEFAULT_VIEW, preview: 'box' });
		const some = memory({ [VIEW_KEY]: JSON.stringify({ compare: 'side', linkZoom: false, commonScale: 'no' }) });
		expect(readViewSettings(some)).toEqual({ ...DEFAULT_VIEW, compare: 'side', linkZoom: false });
		// stored before Compare existed: the compare defaults (link and common scale on, compare off)
		const old = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'sheet', zoom: 'actual' }) });
		expect(readViewSettings(old)).toMatchObject({ compare: 'off', compareList: false, linkZoom: true, commonScale: true, zoom: 'actual' });
	});

	it('saves a compare change through useViewSettings', () => {
		const s = memory();
		const v = useViewSettings(s);
		v.set({ compare: 'side', linkZoom: false, compareList: true });
		expect(JSON.parse(s.map.get(VIEW_KEY)!)).toMatchObject({ compare: 'side', linkZoom: false, compareList: true, commonScale: true });
	});

	it('does not throw when storage is missing or throws on every call, and reads the defaults', () => {
		expect(readViewSettings(null)).toEqual(DEFAULT_VIEW);
		expect(readViewSettings(throwing())).toEqual(DEFAULT_VIEW);
		expect(() => writeViewSettings(DEFAULT_VIEW, throwing())).not.toThrow();
		expect(() => writeViewSettings(DEFAULT_VIEW, null)).not.toThrow();
	});

	it('writes every field under the key and reads them back', () => {
		const s = memory();
		const v = {
			preview: 'box', railOpen: false, boxRailOpen: false, zoom: 'actual', scaleBar: false, contrast: true, compareList: true, compare: 'side', linkZoom: false, commonScale: false,
		} as const;
		writeViewSettings(v, s);
		expect(JSON.parse(s.map.get(VIEW_KEY)!)).toEqual(v);
		expect(readViewSettings(s)).toEqual(v);
	});

	it('useViewSettings starts from the stored value and saves each change; with blocked storage it still changes in memory', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'box' }) });
		const v = useViewSettings(s);
		expect(v.settings.preview).toBe('box');
		v.set({ preview: 'sheet', railOpen: false, zoom: 'actual' });
		expect(v.settings).toMatchObject({ preview: 'sheet', railOpen: false, zoom: 'actual' });
		expect(JSON.parse(s.map.get(VIEW_KEY)!)).toMatchObject({ preview: 'sheet', railOpen: false, zoom: 'actual' });

		const blocked = useViewSettings(throwing());
		expect(blocked.settings).toEqual(DEFAULT_VIEW);
		blocked.set({ preview: 'box' });
		expect(blocked.settings.preview).toBe('box');
	});
});

describe('the open scan progress folders', () => {
	it('is per person, starts empty and remembers what was written', () => {
		const s = memory();
		expect(scanStripKey('u1')).toBe('d1.list.inbox.scan.u1');
		expect(readOpenScanFolders('u1', s)).toEqual([]);
		writeOpenScanFolders('u1', ['p1', 't2'], s);
		expect(readOpenScanFolders('u1', s)).toEqual(['p1', 't2']);
		expect(readOpenScanFolders('u2', s)).toEqual([]);
	});
	it('gives none for a broken value and does not throw on blocked storage', () => {
		for (const raw of ['{x', '"p1"', '{"a":1}', '[1,"p1",null]']) expect(readOpenScanFolders('u1', memory({ [scanStripKey('u1')]: raw }))).toEqual(raw === '[1,"p1",null]' ? ['p1'] : []);
		expect(readOpenScanFolders('u1', throwing())).toEqual([]);
		expect(() => writeOpenScanFolders('u1', ['p1'], throwing())).not.toThrow();
	});
});
