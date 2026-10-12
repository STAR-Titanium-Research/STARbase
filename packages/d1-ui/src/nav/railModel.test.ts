import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, buildNav } from './navConfig';
import type { Bookmark } from './navConfig';
import { RAIL_SECTIONS, activeSection, followPage, railSections, restoreSection } from './railModel';

const allCollections = new Set(NAV_GROUPS.flatMap((g) => g.links).flatMap((l) => (l.collection ? [l.collection] : [])));
const bm = (id: number, name: string, collection: string): Bookmark => ({
	id, bookmark: name, collection, user: null, role: null, filter: null, search: null, layout_query: null,
});

const adminNav = () => buildNav(allCollections, [], true);

describe('RAIL_SECTIONS', () => {
	it('has the five sections of the spec in order, with the groups each holds', () => {
		expect(RAIL_SECTIONS.map((s) => [s.id, s.label, s.groupIds])).toEqual([
			['home', 'Home', ['main']],
			['records', 'Records', ['records']],
			['analysis', 'Analysis', ['dashboards']],
			['kit', 'Kit', ['inventory', 'resources']],
			['tools', 'Tools', ['tools']],
		]);
	});

	it('gives every section a short glyph, never a v-icon name', () => {
		for (const s of RAIL_SECTIONS) expect(s.icon.length).toBeLessThanOrEqual(2);
	});
});

describe('railSections', () => {
	it('puts every link of NAV_GROUPS in exactly one section', () => {
		const sections = railSections(adminNav());
		const placed = sections.flatMap((s) => s.groups.flatMap((g) => g.links.map((l) => l.to)));
		const all = NAV_GROUPS.flatMap((g) => g.links.map((l) => l.to));
		expect([...placed].sort()).toEqual([...all].sort());
		expect(new Set(placed).size).toBe(placed.length);
	});

	it('keeps the order of the groups inside a section', () => {
		const kit = railSections(adminNav()).find((s) => s.id === 'kit')!;
		expect(kit.groups.map((g) => g.id)).toEqual(['inventory', 'resources']);
	});

	it('drops a section with no visible link', () => {
		// Nothing readable (or the collections request failed): Home, Analysis (no collection needed) and Tools survive.
		const none = railSections(buildNav(null, [], false));
		expect(none.map((s) => s.id)).toEqual(['home', 'analysis', 'tools']);
		// A member without any Kit collection.
		const noKit = new Set(allCollections);
		for (const g of NAV_GROUPS.filter((x) => x.id === 'inventory' || x.id === 'resources')) {
			for (const l of g.links) if (l.collection) noKit.delete(l.collection);
		}
		expect(railSections(buildNav(noKit, [], false)).map((s) => s.id)).toEqual(['home', 'records', 'analysis', 'tools']);
	});

	it('keeps a section when only one of its groups has links', () => {
		const some = new Set(allCollections);
		for (const g of NAV_GROUPS.filter((x) => x.id === 'resources')) {
			for (const l of g.links) if (l.collection) some.delete(l.collection);
		}
		const kit = railSections(buildNav(some, [], false)).find((s) => s.id === 'kit')!;
		expect(kit.groups.map((g) => g.id)).toEqual(['inventory']);
	});

	it('hides Force Crawler from a non-admin', () => {
		const tools = railSections(buildNav(allCollections, [], false)).find((s) => s.id === 'tools')!;
		expect(tools.groups[0].links.map((l) => l.label)).toEqual(['Print labels', 'Report a bug', 'Data Studio']);
	});
});

describe('activeSection', () => {
	const sections = railSections(adminNav());

	it('names the section holding the current page', () => {
		expect(activeSection(sections, '/home/samples', {})).toBe('records');
		expect(activeSection(sections, '/home/samples/12', {})).toBe('records');
		expect(activeSection(sections, '/d1-force-dashboard', {})).toBe('analysis');
		expect(activeSection(sections, '/d1-fast-dashboard', {})).toBe('analysis');
		expect(activeSection(sections, '/home/tools', {})).toBe('kit');
		expect(activeSection(sections, '/home/facilities', {})).toBe('kit');
		expect(activeSection(sections, '/report-bug', {})).toBe('tools');
		expect(activeSection(sections, '/home', {})).toBe('home');
	});

	it('follows a saved view, whether or not it is listed in the sidebar', () => {
		expect(activeSection(sections, '/home/samples', { bookmark: '3' })).toBe('records');
		const withView = railSections(buildNav(allCollections, [bm(3, 'My samples', 'physical_samples')], true));
		expect(activeSection(withView, '/home/samples', { bookmark: '3' })).toBe('records');
		expect(activeSection(withView, '/home/operations', { bookmark: ['9'] })).toBe('records');
	});

	it('is null for a page that is in no section', () => {
		expect(activeSection(sections, '/somewhere-else', {})).toBeNull();
		expect(activeSection([], '/home/samples', {})).toBeNull();
	});
});

describe('followPage', () => {
	const sections = railSections(adminNav());

	it("shows the page's section, and Home for a page in none", () => {
		expect(followPage(sections, '/home/samples', {})).toBe('records');
		expect(followPage(sections, '/d1-force-dashboard', {})).toBe('analysis');
		expect(followPage(sections, '/somewhere-else', {})).toBe('home');
	});
});

describe('restoreSection', () => {
	const sections = railSections(adminNav());

	it('gives back a remembered section that exists, Home included', () => {
		expect(restoreSection(sections, 'records')).toBe('records');
		expect(restoreSection(sections, 'kit')).toBe('kit');
		expect(restoreSection(sections, 'home')).toBe('home');
	});

	it('gives null for nothing, something unknown or a section this user does not have', () => {
		expect(restoreSection(sections, null)).toBeNull();
		expect(restoreSection(sections, 'nope')).toBeNull();
		expect(restoreSection(railSections(buildNav(null, [], false)), 'kit')).toBeNull();
	});
});
