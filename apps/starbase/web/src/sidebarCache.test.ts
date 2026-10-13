import { describe, expect, it } from 'vitest';
import { cacheLayoutPrefs, cachedLayoutPrefs, pickLayoutPrefs } from './sidebarCache';

const store = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('the cached sidebar preferences', () => {
	it('default to expanded with automatic collapse when nothing is cached', () => {
		expect(cachedLayoutPrefs(store())).toEqual({ sidebarCollapsed: false, autoCollapse: true });
	});
	it('round-trip', () => {
		const s = store();
		cacheLayoutPrefs({ sidebarCollapsed: true, autoCollapse: false }, s);
		expect(cachedLayoutPrefs(s)).toEqual({ sidebarCollapsed: true, autoCollapse: false });
	});
	it('ignore junk and survive storage that throws or is missing', () => {
		const s = store();
		s.setItem('starbase.sidebar', '{"sidebarCollapsed":"yes","autoCollapse":3}');
		expect(cachedLayoutPrefs(s)).toEqual({ sidebarCollapsed: false, autoCollapse: true });
		s.setItem('starbase.sidebar', 'not json');
		expect(cachedLayoutPrefs(s)).toEqual({ sidebarCollapsed: false, autoCollapse: true });
		const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
		expect(cachedLayoutPrefs(bad)).toEqual({ sidebarCollapsed: false, autoCollapse: true });
		expect(() => cacheLayoutPrefs({ sidebarCollapsed: true, autoCollapse: true }, bad)).not.toThrow();
		expect(cachedLayoutPrefs(null)).toEqual({ sidebarCollapsed: false, autoCollapse: true });
	});
});

describe('the initial layout choice', () => {
	const cached = { sidebarCollapsed: true, autoCollapse: false };
	const server = { sidebarCollapsed: false, autoCollapse: true };
	it('is the cached choice until the preferences have loaded (a rail draws as a rail at first paint)', () => {
		expect(pickLayoutPrefs(false, server, cached)).toEqual(cached);
	});
	it('follows the loaded preferences afterwards', () => {
		expect(pickLayoutPrefs(true, server, cached)).toEqual(server);
	});
});
