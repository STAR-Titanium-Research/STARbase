import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { canonicalPath, configureLinks, resetLinks, resolveLink, routeTarget, starbaseLinks } from '@d1/ui';
import {
	CampaignPage, HomeView, IndexRoute, LabelsPage, OperationPage, PeopleView, ProjectPage, ProjectsIndex, RegisterSample, SamplePage, TestPage,
} from '@d1/starbase-pages';
import { buildRoutes } from './router';
import { plotRoutes } from './plot/routes';

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

describe('the plot pages', () => {
	it('are STARbase pages inside the shell, and the dashboards resolve to them', () => {
		configureLinks(starbaseLinks('https://d1-server.tail54eeb6.ts.net'));
		const router = createRouter({ history: createMemoryHistory(), routes: buildRoutes(plotRoutes) });
		expect(router.resolve('/plot/force?operation=9').name).toBe('plot-force');
		const fast = resolveLink('/d1-fast-dashboard?operation=3');
		expect(fast).toEqual({ kind: 'route', to: '/plot/fast?operation=3' });
		if (fast.kind === 'route') expect(router.resolve(fast.to).name).toBe('plot-fast');
		expect(router.resolve('/plot/force').matched).toHaveLength(2);
	});
	// Carried decision (Task 8): a bare /plot is not a page. It would otherwise fall into the generic ':slug'
	// index route ("There is no page called plot") and ping /home/plot as a usage target.
	it('a bare /plot goes to the Force plotter, keeping its query, and is never the generic index page', async () => {
		configureLinks(starbaseLinks('https://d1-server.tail54eeb6.ts.net'));
		const router = createRouter({ history: createMemoryHistory(), routes: buildRoutes(plotRoutes) });
		await router.push('/plot?operation=9');
		expect(router.currentRoute.value.name).toBe('plot-force');
		expect(router.currentRoute.value.fullPath).toBe('/plot/force?operation=9');
		await router.push('/plot/');
		expect(router.currentRoute.value.name).toBe('plot-force');
	});
	it('the plot pages count as the dashboards for usage pings and the nav; /plot counts as nothing', () => {
		configureLinks(starbaseLinks('https://d1-server.tail54eeb6.ts.net'));
		expect(canonicalPath('/plot/force?operation=9')).toBe('/d1-force-dashboard?operation=9');
		expect(canonicalPath('/plot/fast?operation=3')).toBe('/d1-fast-dashboard?operation=3');
		expect(routeTarget(canonicalPath('/plot'))).toBeNull();
	});
});
