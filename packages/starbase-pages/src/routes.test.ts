import { describe, expect, it } from 'vitest';
import { starbaseRoutes } from './routes';

describe('starbaseRoutes', () => {
	const paths = starbaseRoutes.map((r) => r.path);
	it('has every page of the Home module', () => {
		for (const p of ['', 'register-sample', 'people', 'projects', 'projects/:id', 'campaigns/:id', 'samples/:id', 'operations/:id', 'tests/:id', 'labels', ':slug']) {
			expect(paths).toContain(p);
		}
	});
	it('has no other route', () => {
		expect(paths).toHaveLength(11);
	});
	it('puts the catch-all index route last, so static paths win', () => {
		expect(paths[paths.length - 1]).toBe(':slug');
	});
	it('uses relative paths, so each host mounts them where it wants', () => {
		for (const p of paths) expect(p.startsWith('/')).toBe(false);
	});
});
