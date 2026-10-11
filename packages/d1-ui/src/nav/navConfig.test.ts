import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, buildNav, linkForBookmark } from './navConfig';
import type { Bookmark } from './navConfig';

const allCollections = new Set(NAV_GROUPS.flatMap((g) => g.links).flatMap((l) => (l.collection ? [l.collection] : [])));
const memberCollections = new Set(allCollections);
for (const c of ['etchants', 'prep_recipes', 'Machine_Operators']) memberCollections.delete(c);

const bm = (id: number, name: string, collection: string, over: Partial<Bookmark> = {}): Bookmark => ({
	id, bookmark: name, collection, user: null, role: null, filter: null, search: null, layout_query: null, ...over,
});

const labels = (nav: ReturnType<typeof buildNav>, id: string) => nav.groups.find((g) => g.id === id)?.links.map((l) => l.label);

describe('NAV_GROUPS', () => {
	it('has the groups of the spec in order', () => {
		expect(NAV_GROUPS.map((g) => g.id)).toEqual(['main', 'dashboards', 'records', 'inventory', 'resources', 'tools']);
		expect(NAV_GROUPS.map((g) => g.collapsible)).toEqual([false, false, false, true, true, false]);
		expect(NAV_GROUPS[0].label).toBeNull();
	});

	it('has the link labels and routes of the spec in order', () => {
		const flat = (id: string) => NAV_GROUPS.find((g) => g.id === id)!.links.map((l) => [l.label, l.to]);
		expect(flat('main')).toEqual([['Home', '/home']]);
		expect(flat('dashboards')).toEqual([['Force', '/d1-force-dashboard'], ['FAST', '/d1-fast-dashboard']]);
		expect(flat('records').map(([l]) => l)).toEqual(['Projects', 'Campaigns', 'Samples', 'Operations', 'Tests', 'People']);
		expect(flat('records')[0]).toEqual(['Projects', '/home/projects']);
		expect(flat('inventory').map(([l]) => l)).toEqual(['Tools', 'Tool boxes', 'Cutting inserts', 'Insert edges', 'Raw stock lots']);
		expect(flat('resources').map(([l]) => l)).toEqual([
			'Equipment', 'Materials', 'Machine operators', 'Insert types', 'ISO classes', 'Methods', 'Manufacturers', 'Facilities',
			'Prep recipes', 'Etchants', 'FAST recipes',
		]);
		expect(flat('tools')).toEqual([
			['Print labels', '/d1-report/labels'], ['Report a bug', '/report-bug'], ['Data Studio', '/content'], ['Force Crawler', '/d1-force-crawler'],
		]);
	});

	it('opens Print labels in a new tab and marks only Force Crawler admin-only', () => {
		const flat = NAV_GROUPS.flatMap((g) => g.links);
		expect(flat.filter((l) => l.newTab).map((l) => l.label)).toEqual(['Print labels']);
		expect(flat.filter((l) => l.adminOnly).map((l) => l.label)).toEqual(['Force Crawler']);
	});

	it('covers 22 collections, each once', () => {
		const list = NAV_GROUPS.flatMap((g) => g.links).flatMap((l) => (l.collection ? [l.collection] : []));
		expect(list).toHaveLength(22);
		expect(new Set(list).size).toBe(22);
	});
});

describe('buildNav', () => {
	it('shows everything to an admin who can read everything', () => {
		const nav = buildNav(allCollections, [], true);
		expect(nav.groups.map((g) => g.id)).toEqual(NAV_GROUPS.map((g) => g.id));
		expect(nav.groups.flatMap((g) => g.links)).toHaveLength(NAV_GROUPS.flatMap((g) => g.links).length);
	});

	it('drops the entries that a member\'s 19 collections do not include', () => {
		expect(memberCollections.size).toBe(19);
		const nav = buildNav(memberCollections, [], false);
		const all = nav.groups.flatMap((g) => g.links.map((l) => l.label));
		for (const gone of ['Etchants', 'Prep recipes', 'Machine operators', 'Force Crawler']) expect(all).not.toContain(gone);
		expect(labels(nav, 'resources')).toHaveLength(8);
		expect(all).toContain('Samples');
	});

	it('keeps only the entries without a collection when /collections failed', () => {
		const nav = buildNav(null, [bm(1, 'View', 'physical_samples')], false);
		expect(nav.groups.map((g) => g.id)).toEqual(['main', 'dashboards', 'tools']);
		expect(labels(nav, 'main')).toEqual(['Home']);
		expect(labels(nav, 'dashboards')).toEqual(['Force', 'FAST']);
		expect(labels(nav, 'tools')).toEqual(['Print labels', 'Report a bug', 'Data Studio']);
	});

	it('shows Force Crawler to admins only', () => {
		expect(labels(buildNav(null, [], true), 'tools')).toContain('Force Crawler');
		expect(labels(buildNav(null, [], false), 'tools')).not.toContain('Force Crawler');
	});

	it('drops a group left with no visible entry', () => {
		const noInventory = new Set(allCollections);
		for (const c of ['tools', 'tool_boxes', 'cutting_inserts', 'insert_edges', 'raw_stock_lots']) noInventory.delete(c);
		const nav = buildNav(noInventory, [], true);
		expect(nav.groups.map((g) => g.id)).not.toContain('inventory');
		expect(nav.groups.map((g) => g.id)).toContain('resources');
	});

	it('nests bookmarks under their collection: global, then role, then own, A-Z in each', () => {
		const bookmarks = [
			bm(1, 'zeta mine', 'physical_samples', { user: 'u1' }),
			bm(2, 'Beta role', 'physical_samples', { role: 'r1' }),
			bm(3, 'beta global', 'physical_samples'),
			bm(4, 'Alpha global', 'physical_samples'),
			bm(5, 'alpha mine', 'physical_samples', { user: 'u1' }),
			bm(6, 'Alpha role', 'physical_samples', { role: 'r1' }),
			bm(7, 'Open ops', 'manufacturing_operations'),
			bm(8, 'Done tests', 'test_sessions'),
		];
		const nav = buildNav(allCollections, bookmarks, false);
		const records = nav.groups.find((g) => g.id === 'records')!.links;
		const names = (label: string) => records.find((l) => l.label === label)!.bookmarks.map((b) => b.bookmark);
		expect(names('Samples')).toEqual(['Alpha global', 'beta global', 'Alpha role', 'Beta role', 'alpha mine', 'zeta mine']);
		expect(names('Operations')).toEqual(['Open ops']);
		expect(names('Tests')).toEqual(['Done tests']);
		expect(names('Campaigns')).toEqual([]);
	});

	it('hides the bookmarks of a collection the user cannot see, and does not mutate its input', () => {
		const bookmarks = [bm(2, 'B', 'etchants'), bm(1, 'A', 'etchants')];
		const nav = buildNav(memberCollections, bookmarks, false);
		expect(nav.groups.flatMap((g) => g.links).flatMap((l) => l.bookmarks)).toEqual([]);
		expect(bookmarks.map((b) => b.id)).toEqual([2, 1]);
	});
});

describe('linkForBookmark', () => {
	it('opens the collection page with the bookmark id', () => {
		expect(linkForBookmark(bm(3, 'x', 'physical_samples'))).toBe('/home/samples?bookmark=3');
		expect(linkForBookmark(bm(9, 'x', 'manufacturing_operations'))).toBe('/home/operations?bookmark=9');
		expect(linkForBookmark(bm(4, 'x', 'test_sessions'))).toBe('/home/tests?bookmark=4');
	});

	it('links the bespoke pages plainly, since they ignore the bookmark', () => {
		expect(linkForBookmark(bm(6, 'x', 'projects'))).toBe('/home/projects');
		expect(linkForBookmark(bm(8, 'x', 'people'))).toBe('/home/people');
	});

	it('falls back to the Data Studio list for a collection with no page', () => {
		expect(linkForBookmark(bm(5, 'x', 'audit_logs'))).toBe('/content/audit_logs?bookmark=5');
	});
});
