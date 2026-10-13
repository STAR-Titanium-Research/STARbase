import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, resolveLink, starbaseLinks } from '@d1/ui';
import {
	CampaignPage, HomeView, IndexRoute, LabelsPage, OperationPage, PeopleView, ProjectPage, ProjectsIndex, RegisterSample, SamplePage, TestPage,
} from '@d1/starbase-pages';
import { buildRoutes } from './router';

afterEach(() => resetLinks());
const memoryRouter = () => createRouter({ history: createMemoryHistory(), routes: buildRoutes() });

describe('STARbase routes', () => {
	it('every Directus-form link lands on the same page component as in the Directus module (spec §5)', () => {
		configureLinks(starbaseLinks('https://d1-server.tail54eeb6.ts.net'));
		const router = memoryRouter();
		const cases: [string, unknown][] = [
			['/home', HomeView], ['/home/register-sample', RegisterSample], ['/home/people', PeopleView], ['/home/projects', ProjectsIndex],
			['/home/projects/p1', ProjectPage], ['/home/campaigns/c1', CampaignPage], ['/home/samples/a%2Fb', SamplePage],
			['/home/operations/o1', OperationPage], ['/home/tests/t1', TestPage], ['/home/labels?ids=1,2', LabelsPage], ['/home/samples', IndexRoute],
		];
		for (const [path, component] of cases) {
			const r = resolveLink(path);
			expect(r.kind, path).toBe('route');
			if (r.kind === 'route') expect(router.resolve(r.to).matched.at(-1)?.components?.default, path).toBe(component);
		}
	});
	it('the pages are children of the shell route, so their relative paths work', () => {
		const shell = buildRoutes().find((r) => r.path === '/');
		expect(shell?.children?.map((c) => c.path)).toEqual(expect.arrayContaining(['', 'samples/:id', ':slug']));
	});
	it('the sign-in pages are public and outside the shell', () => {
		const router = memoryRouter();
		for (const p of ['/signin', '/signin/done']) {
			const r = router.resolve(p);
			expect(r.meta.public, p).toBe(true);
			expect(r.matched, p).toHaveLength(1);
		}
	});
	it('an old /home link redirects with its query and encoding', async () => {
		const router = memoryRouter();
		await router.push('/home/samples/a%2Fb?x=1');
		expect(router.currentRoute.value.fullPath).toBe('/samples/a%2Fb?x=1');
	});
});
