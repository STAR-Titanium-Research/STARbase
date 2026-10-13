import { describe, expect, it } from 'vitest';
import { forgetListPrefs, nextRadioIndex, readListPrefs, writeListPrefs } from './listPrefs';

function fakeStorage(initial: Record<string, string> = {}): Storage {
	const m = new Map(Object.entries(initial));
	return {
		get length() { return m.size; },
		clear: () => m.clear(),
		getItem: (k) => m.get(k) ?? null,
		key: (i) => [...m.keys()][i] ?? null,
		removeItem: (k) => void m.delete(k),
		setItem: (k, v) => void m.set(k, String(v)),
	};
}
const throwing = (): Storage => ({
	get length() { return 0; },
	clear() { throw new Error('blocked'); },
	getItem() { throw new Error('blocked'); },
	key() { throw new Error('blocked'); },
	removeItem() { throw new Error('blocked'); },
	setItem() { throw new Error('blocked'); },
});

describe('readListPrefs', () => {
	const DEFAULT = { view: 'table', density: 'normal' };

	it('defaults to the table at normal density', () => {
		expect(readListPrefs('samples', fakeStorage())).toEqual(DEFAULT);
		expect(readListPrefs('samples', null)).toEqual(DEFAULT);
	});

	it('round-trips what was written, per list', () => {
		const s = fakeStorage();
		writeListPrefs('samples', { view: 'cards', density: 'roomy' }, s);
		writeListPrefs('operations', { view: 'table', density: 'compact' }, s);
		expect(s.getItem('d1.list.samples')).toBe('{"view":"cards","density":"roomy"}');
		expect(readListPrefs('samples', s)).toEqual({ view: 'cards', density: 'roomy' });
		expect(readListPrefs('operations', s)).toEqual({ view: 'table', density: 'compact' });
		expect(readListPrefs('tools', s)).toEqual(DEFAULT);
	});

	it('falls back to the default for junk', () => {
		for (const raw of ['not json', 'null', '[]', '42', '"cards"', '{}']) {
			expect(readListPrefs('x', fakeStorage({ 'd1.list.x': raw })), raw).toEqual(DEFAULT);
		}
	});

	it('keeps a valid half and defaults the other', () => {
		expect(readListPrefs('x', fakeStorage({ 'd1.list.x': '{"view":"cards","density":"huge"}' }))).toEqual({ view: 'cards', density: 'normal' });
		expect(readListPrefs('x', fakeStorage({ 'd1.list.x': '{"view":"grid","density":"roomy"}' }))).toEqual({ view: 'table', density: 'roomy' });
	});

	it('does not throw when storage is blocked', () => {
		expect(readListPrefs('x', throwing())).toEqual(DEFAULT);
		expect(() => writeListPrefs('x', { view: 'cards', density: 'compact' }, throwing())).not.toThrow();
		expect(() => writeListPrefs('x', { view: 'cards', density: 'compact' }, null)).not.toThrow();
	});
});

describe('nextRadioIndex', () => {
	it('moves with the arrows and wraps', () => {
		expect(nextRadioIndex(3, 0, 'ArrowRight')).toBe(1);
		expect(nextRadioIndex(3, 2, 'ArrowRight')).toBe(0);
		expect(nextRadioIndex(3, 0, 'ArrowLeft')).toBe(2);
		expect(nextRadioIndex(3, 1, 'ArrowDown')).toBe(2);
		expect(nextRadioIndex(3, 1, 'ArrowUp')).toBe(0);
	});

	it('jumps to the ends with Home and End and ignores other keys', () => {
		expect(nextRadioIndex(3, 1, 'Home')).toBe(0);
		expect(nextRadioIndex(3, 1, 'End')).toBe(2);
		expect(nextRadioIndex(3, 1, 'Enter')).toBeNull();
		expect(nextRadioIndex(0, 0, 'ArrowRight')).toBeNull();
	});
});

describe('forgetListPrefs', () => {
	it('clears only list-pref keys', () => {
		const storage = fakeStorage({
			'd1.list.samples': '{"view":"cards","density":"roomy"}',
			'd1.list.projects': '{"view":"cards"}',
			'starbase.theme': 'dark',
			'd1.listing': 'keep',
			other: 'x',
		});
		forgetListPrefs(storage);
		expect(storage.getItem('d1.list.samples')).toBeNull();
		expect(storage.getItem('d1.list.projects')).toBeNull();
		expect(storage.getItem('starbase.theme')).toBe('dark');
		expect(storage.getItem('d1.listing')).toBe('keep');
		expect(storage.getItem('other')).toBe('x');
		expect(readListPrefs('samples', storage)).toEqual({ view: 'table', density: 'normal' });
	});
	it('does nothing without storage, and survives storage that throws', () => {
		expect(() => forgetListPrefs(null)).not.toThrow();
		expect(() => forgetListPrefs(throwing())).not.toThrow();
	});
});
