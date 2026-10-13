import { describe, expect, it } from 'vitest';
import { starbaseRoutes } from './routes';
import IndexRoute from './pages/IndexRoute.vue';
import SettingsPage from './pages/SettingsPage.vue';

describe('starbaseRoutes', () => {
	const paths = starbaseRoutes.map((r) => r.path);
	it('has every page of the Home module', () => {
		for (const p of ['', 'register-sample', 'people', 'projects', 'projects/:id', 'campaigns/:id', 'samples/:id', 'operations/:id', 'tests/:id', 'labels', 'settings', ':slug']) {
			expect(paths).toContain(p);
		}
	});
	it('has no other route', () => {
		expect(paths).toHaveLength(12);
	});
	it('settings resolves to SettingsPage, not IndexRoute', () => {
		const settings = starbaseRoutes.find((r) => r.path === 'settings');
		expect(settings?.component).toBe(SettingsPage);
		expect(settings?.component).not.toBe(IndexRoute);
		expect(paths.indexOf('settings')).toBeLessThan(paths.indexOf(':slug'));
	});
	it('puts the catch-all index route last, so static paths win', () => {
		expect(paths[paths.length - 1]).toBe(':slug');
	});
	it('uses relative paths, so each host mounts them where it wants', () => {
		for (const p of paths) expect(p.startsWith('/')).toBe(false);
	});
});
