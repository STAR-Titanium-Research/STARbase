import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, VIEW_KEY, readViewSettings, useViewSettings, writeViewSettings } from './useViewSettings';

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
		expect(DEFAULT_VIEW).toEqual({ preview: 'sheet', railOpen: true });
		expect(readViewSettings(memory())).toEqual(DEFAULT_VIEW);
	});

	it('reads what was stored', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'box', railOpen: false }) });
		expect(readViewSettings(s)).toEqual({ preview: 'box', railOpen: false });
	});

	it('gives the defaults for invalid JSON, and for JSON that is not an object', () => {
		for (const raw of ['{not json', '', 'null', '[1,2]', '"sheet"', '42']) expect(readViewSettings(memory({ [VIEW_KEY]: raw }))).toEqual(DEFAULT_VIEW);
	});

	it('checks each field on its own: a good one survives a bad one, an unknown value falls back', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'box', railOpen: 'yes' }) });
		expect(readViewSettings(s)).toEqual({ ...DEFAULT_VIEW, preview: 'box' });
	});

	it('does not throw when storage is missing or throws on every call, and reads the defaults', () => {
		expect(readViewSettings(null)).toEqual(DEFAULT_VIEW);
		expect(readViewSettings(throwing())).toEqual(DEFAULT_VIEW);
		expect(() => writeViewSettings(DEFAULT_VIEW, throwing())).not.toThrow();
		expect(() => writeViewSettings(DEFAULT_VIEW, null)).not.toThrow();
	});

	it('writes the two fields under the key and reads them back', () => {
		const s = memory();
		writeViewSettings({ preview: 'box', railOpen: false }, s);
		expect(JSON.parse(s.map.get(VIEW_KEY)!)).toEqual({ preview: 'box', railOpen: false });
		expect(readViewSettings(s)).toEqual({ preview: 'box', railOpen: false });
	});

	it('useViewSettings starts from the stored value and saves each change; with blocked storage it still changes in memory', () => {
		const s = memory({ [VIEW_KEY]: JSON.stringify({ preview: 'box' }) });
		const v = useViewSettings(s);
		expect(v.settings.preview).toBe('box');
		v.set({ preview: 'sheet', railOpen: false });
		expect(v.settings).toMatchObject({ preview: 'sheet', railOpen: false });
		expect(JSON.parse(s.map.get(VIEW_KEY)!)).toMatchObject({ preview: 'sheet', railOpen: false });

		const blocked = useViewSettings(throwing());
		expect(blocked.settings).toEqual(DEFAULT_VIEW);
		blocked.set({ preview: 'box' });
		expect(blocked.settings.preview).toBe('box');
	});
});
