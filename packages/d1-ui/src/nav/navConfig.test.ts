import { describe, expect, it } from 'vitest';
import { NAV_ICONS } from './navIcons';
import { BOOKMARK_VISIBILITY_FILTER, NAV_GROUPS, bookmarkVisibleToUser, buildNav, linkForBookmark, pickBookmarkId } from './navConfig';
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
		expect(NAV_GROUPS.map((g) => g.id)).toEqual(['main', 'records', 'analysis', 'inventory', 'reference', 'more', 'admin']);
		expect(NAV_GROUPS.map((g) => g.collapsible)).toEqual([false, false, false, true, true, false, false]);
		expect(NAV_GROUPS[0].label).toBeNull();
	});

	it('has the link labels and routes of the spec in order', () => {
		const flat = (id: string) => NAV_GROUPS.find((g) => g.id === id)!.links.map((l) => [l.label, l.to]);
		expect(flat('main')).toEqual([['Home', '/home']]);
		expect(flat('analysis')).toEqual([['Force plotter', '/d1-force-dashboard'], ['FAST plotter', '/d1-fast-dashboard'], ['Process map', '/map']]);
		expect(flat('records').map(([l]) => l)).toEqual(['Projects', 'Campaigns', 'Samples', 'Operations', 'Tests', 'People']);
		expect(flat('records')[0]).toEqual(['Projects', '/home/projects']);
		expect(flat('inventory').map(([l]) => l)).toEqual(['Tools', 'Tool boxes', 'Cutting inserts', 'Insert edges', 'Raw stock lots']);
		expect(flat('reference').map(([l]) => l)).toEqual([
			'Equipment', 'Materials', 'Machine operators', 'Insert types', 'ISO classes', 'Methods', 'Manufacturers', 'Facilities',
			'Prep recipes', 'Etchants', 'FAST recipes',
		]);
		expect(flat('more')).toEqual([['Print labels', '/home/labels'], ['Report a bug', '/report-bug'], ['Settings', '/home/settings']]);
		expect(flat('admin')).toEqual([['Data Studio', '/content'], ['Force Crawler', '/crawler']]);
	});

	it('gives every link an icon that NAV_ICONS has', () => {
		for (const l of NAV_GROUPS.flatMap((g) => g.links)) {
			expect(l.icon, l.label).toBeTruthy();
			expect(Object.keys(NAV_ICONS), l.label).toContain(l.icon);
		}
	});

	it('opens no link in a new tab and marks only Force Crawler admin-only', () => {
		const flat = NAV_GROUPS.flatMap((g) => g.links);
		expect(flat.filter((l) => l.newTab).map((l) => l.label)).toEqual([]);
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
		expect(labels(nav, 'reference')).toHaveLength(8);
		expect(all).toContain('Samples');
	});

	it('keeps only the entries without a collection when /collections failed', () => {
		const nav = buildNav(null, [bm(1, 'View', 'physical_samples')], false);
		expect(nav.groups.map((g) => g.id)).toEqual(['main', 'analysis', 'more', 'admin']);
		expect(labels(nav, 'main')).toEqual(['Home']);
		expect(labels(nav, 'analysis')).toEqual(['Force plotter', 'FAST plotter', 'Process map']);
		expect(labels(nav, 'more')).toEqual(['Print labels', 'Report a bug', 'Settings']);
		expect(labels(nav, 'admin')).toEqual(['Data Studio']);
	});

	it('shows Force Crawler to admins only', () => {
		expect(labels(buildNav(null, [], true), 'admin')).toContain('Force Crawler');
		expect(labels(buildNav(null, [], false), 'admin')).not.toContain('Force Crawler');
	});

	it('drops a group left with no visible entry', () => {
		const noInventory = new Set(allCollections);
		for (const c of ['tools', 'tool_boxes', 'cutting_inserts', 'insert_edges', 'raw_stock_lots']) noInventory.delete(c);
		const nav = buildNav(noInventory, [], true);
		expect(nav.groups.map((g) => g.id)).not.toContain('inventory');
		expect(nav.groups.map((g) => g.id)).toContain('reference');
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

describe('bookmark visibility', () => {
	const names = (nav: ReturnType<typeof buildNav>) =>
		nav.groups.flatMap((g) => g.links).flatMap((l) => l.bookmarks).map((b) => b.bookmark).sort();
	const mixed = [
		bm(1, 'global', 'physical_samples'),
		bm(2, 'my role', 'physical_samples', { role: 'r1' }),
		bm(3, 'other role', 'physical_samples', { role: 'r2' }),
		bm(4, 'mine', 'physical_samples', { user: 'u1' }),
		bm(5, 'theirs', 'physical_samples', { user: 'u2' }),
		bm(6, 'theirs in my role', 'physical_samples', { user: 'u2', role: 'r1' }),
	];

	it('drops other users\' bookmarks and other roles\' shared ones, given who is looking', () => {
		const nav = buildNav(allCollections, mixed, true, { id: 'u1', role: 'r1' });
		expect(names(nav)).toEqual(['global', 'mine', 'my role']);
	});

	it('filters nothing it cannot judge when the user or role is unknown', () => {
		expect(names(buildNav(allCollections, mixed, true))).toHaveLength(6);
		expect(names(buildNav(allCollections, mixed, true, { id: 'u1' }))).toEqual(['global', 'mine', 'my role', 'other role']);
	});

	it('asks the server only for own views and shared ones for this user\'s role', () => {
		expect(BOOKMARK_VISIBILITY_FILTER).toEqual({
			_and: [
				{ bookmark: { _nnull: true } },
				{
					_or: [
						{ user: { _eq: '$CURRENT_USER' } },
						{ _and: [{ user: { _null: true } }, { _or: [{ role: { _null: true } }, { role: { _eq: '$CURRENT_ROLE' } }] }] },
					],
				},
			],
		});
	});
});

describe('saved views under bespoke pages', () => {
	it('does not nest saved views under Projects or People, whose pages ignore them', () => {
		const nav = buildNav(allCollections, [bm(1, 'P', 'projects'), bm(2, 'Q', 'people'), bm(3, 'S', 'physical_samples')], true);
		const links = nav.groups.flatMap((g) => g.links);
		expect(links.find((l) => l.label === 'Projects')!.bookmarks).toEqual([]);
		expect(links.find((l) => l.label === 'People')!.bookmarks).toEqual([]);
		expect(links.find((l) => l.label === 'Samples')!.bookmarks.map((b) => b.id)).toEqual([3]);
	});
});

describe('bookmarkVisibleToUser (the strict rule for a view fetched by id)', () => {
	const me = { id: 'u1', role: 'r1' };
	it('admits own views and global or same-role shared ones', () => {
		expect(bookmarkVisibleToUser({ user: 'u1', role: null }, me)).toBe(true);
		expect(bookmarkVisibleToUser({ user: null, role: null }, me)).toBe(true);
		expect(bookmarkVisibleToUser({ user: null, role: 'r1' }, me)).toBe(true);
	});
	it('rejects another user view (even one in my role) and another role view', () => {
		expect(bookmarkVisibleToUser({ user: 'u2', role: null }, me)).toBe(false);
		expect(bookmarkVisibleToUser({ user: 'u2', role: 'r1' }, me)).toBe(false);
		expect(bookmarkVisibleToUser({ user: null, role: 'r2' }, me)).toBe(false);
	});
	it('rejects role views for a user with no role, and everything but global views while the user is unknown', () => {
		expect(bookmarkVisibleToUser({ user: null, role: 'r1' }, { id: 'u1', role: null })).toBe(false);
		expect(bookmarkVisibleToUser({ user: 'u1', role: null }, null)).toBe(false);
		expect(bookmarkVisibleToUser({ user: null, role: 'r1' }, null)).toBe(false);
		expect(bookmarkVisibleToUser({ user: null, role: null }, null)).toBe(true);
	});
});

describe('pickBookmarkId', () => {
	const row = (id: number, user: string | null, role: string | null) => ({ id, user, role });
	const me = { id: 'u1', role: 'r1' };
	it('prefers the global view, then a role view, then the user own', () => {
		expect(pickBookmarkId([row(3, 'u1', null), row(2, null, 'r1'), row(5, null, null)], me)).toBe(5);
		expect(pickBookmarkId([row(3, 'u1', null), row(2, null, 'r1')], me)).toBe(2);
		expect(pickBookmarkId([row(3, 'u1', null)], me)).toBe(3);
	});
	it('never picks another user private view, which an admin can read', () => {
		expect(pickBookmarkId([row(1, 'u2', null)], me)).toBeNull();
		expect(pickBookmarkId([row(1, 'u2', null), row(4, 'u1', null)], me)).toBe(4);
		expect(pickBookmarkId([], me)).toBeNull();
	});
});
