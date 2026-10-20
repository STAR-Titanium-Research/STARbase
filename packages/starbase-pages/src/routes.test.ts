import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { starbaseRoutes } from './routes';
import ToolingPage from './pages/tooling/ToolingPage.vue';
import IndexRoute from './pages/IndexRoute.vue';
import ReportBugPage from './pages/ReportBugPage.vue';
import CrawlerPage from './pages/CrawlerPage.vue';
import InboxPage from './pages/InboxPage.vue';
import InboxFilePage from './inbox/InboxFilePage.vue';
import SettingsPage from './pages/SettingsPage.vue';

describe('starbaseRoutes', () => {
	const paths = starbaseRoutes.map((r) => r.path);
	it('has every page of the Home module', () => {
		for (const p of ['', 'register-sample', 'people', 'teams/:id', 'projects', 'projects/:id', 'campaigns/:id', 'samples/:id', 'operations/:id', 'tests/:id', 'labels', 'settings', 'report-bug', 'crawler', 'inbox', 'inbox/file/:candidateId', 'map', ':kind(tool-boxes|inserts|edges)/:id', ':slug']) {
			expect(paths).toContain(p);
		}
	});
	it('has no other route', () => {
		expect(paths).toHaveLength(19);
	});
	it('settings resolves to SettingsPage, not IndexRoute', () => {
		const settings = starbaseRoutes.find((r) => r.path === 'settings');
		expect(settings?.component).toBe(SettingsPage);
		expect(settings?.component).not.toBe(IndexRoute);
		expect(paths.indexOf('settings')).toBeLessThan(paths.indexOf(':slug'));
	});
	it('report-bug resolves to ReportBugPage, ahead of the catch-all', () => {
		expect(starbaseRoutes.find((r) => r.path === 'report-bug')?.component).toBe(ReportBugPage);
		expect(paths.indexOf('report-bug')).toBeLessThan(paths.indexOf(':slug'));
	});
	it('crawler resolves to CrawlerPage, ahead of the catch-all', () => {
		expect(starbaseRoutes.find((r) => r.path === 'crawler')?.component).toBe(CrawlerPage);
		expect(paths.indexOf('crawler')).toBeLessThan(paths.indexOf(':slug'));
	});
	it('inbox resolves to InboxPage, ahead of the catch-all', () => {
		expect(starbaseRoutes.find((r) => r.path === 'inbox')?.component).toBe(InboxPage);
		expect(paths.indexOf('inbox')).toBeLessThan(paths.indexOf(':slug'));
	});
	it('inbox/file/:candidateId resolves to InboxFilePage with the id as a prop, ahead of the catch-all', () => {
		const record = starbaseRoutes.find((r) => r.path === 'inbox/file/:candidateId');
		expect(record?.component).toBe(InboxFilePage);
		expect(record?.props).toBe(true);
		expect(paths.indexOf('inbox/file/:candidateId')).toBeLessThan(paths.indexOf(':slug'));
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', children: starbaseRoutes }] });
		const m = router.resolve('/inbox/file/abc?kind=sem_image');
		expect(m.matched.at(-1)?.components?.default).toBe(InboxFilePage);
		expect(m.params.candidateId).toBe('abc');
	});
	it('serves tool boxes, inserts and edges from one route record, ahead of the catch-all', () => {
		const record = starbaseRoutes.find((r) => r.path === ':kind(tool-boxes|inserts|edges)/:id');
		expect(record?.component).toBe(ToolingPage);
		expect(paths.indexOf(record!.path)).toBeLessThan(paths.indexOf(':slug'));
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', children: starbaseRoutes }] });
		const matched = ['/tool-boxes/b1', '/inserts/i1', '/edges/e1'].map((p) => router.resolve(p));
		// The same record for all three, so the component instance survives moving between them.
		expect(new Set(matched.map((m) => m.matched.at(-1)))).toEqual(new Set([router.resolve('/tool-boxes/b1').matched.at(-1)]));
		expect(matched.map((m) => [m.params.kind, m.params.id])).toEqual([['tool-boxes', 'b1'], ['inserts', 'i1'], ['edges', 'e1']]);
		// Other collections still reach their index page.
		expect(router.resolve('/samples').matched.at(-1)?.components?.default).toBe(IndexRoute);
	});
	it('map is a lazy route ahead of the catch-all, so the Process map code loads only when opened', () => {
		const map = starbaseRoutes.find((r) => r.path === 'map');
		expect(typeof map?.component).toBe('function');
		expect(paths.indexOf('map')).toBeLessThan(paths.indexOf(':slug'));
	});
	it('puts the catch-all index route last, so static paths win', () => {
		expect(paths[paths.length - 1]).toBe(':slug');
	});
	it('uses relative paths, so each host mounts them where it wants', () => {
		for (const p of paths) expect(p.startsWith('/')).toBe(false);
	});
});
