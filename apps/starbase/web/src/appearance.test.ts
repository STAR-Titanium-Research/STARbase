import { describe, expect, it } from 'vitest';
import { applyTheme, cacheTheme, cachedTheme, nextTheme } from './appearance';

function root() {
	const attrs = new Map<string, string>();
	return { attrs, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) };
}

describe('applyTheme', () => {
	it('sets data-theme for light and dark, and removes it for system', () => {
		const r = root();
		applyTheme(r, 'dark');
		expect(r.attrs.get('data-theme')).toBe('dark');
		applyTheme(r, 'light');
		expect(r.attrs.get('data-theme')).toBe('light');
		applyTheme(r, 'system');
		expect(r.attrs.has('data-theme')).toBe(false);
	});
});

describe('nextTheme', () => {
	it('cycles System, Light, Dark', () => {
		expect(nextTheme('system')).toBe('light');
		expect(nextTheme('light')).toBe('dark');
		expect(nextTheme('dark')).toBe('system');
	});
});

describe('the cached choice', () => {
	const store = () => {
		const m = new Map<string, string>();
		return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
	};
	it('round-trips light and dark, and forgets system', () => {
		const s = store();
		expect(cachedTheme(s)).toBe('system');
		cacheTheme('dark', s);
		expect(cachedTheme(s)).toBe('dark');
		cacheTheme('system', s);
		expect(cachedTheme(s)).toBe('system');
	});
	it('survives storage that throws or is missing', () => {
		const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
		expect(cachedTheme(bad)).toBe('system');
		expect(() => cacheTheme('dark', bad)).not.toThrow();
		expect(cachedTheme(null)).toBe('system');
	});
});
