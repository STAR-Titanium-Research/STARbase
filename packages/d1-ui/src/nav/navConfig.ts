import { indexRoute } from '../recordRoute';

// The sidebar tree, as data. Grouping is the lab's, not the Directus collection tree's (there,
// samples sit under "inventory" and tests under "projects"). buildNav() then trims the tree to
// what this user can see and hangs their saved views (bookmarks) under the right entries.

export interface NavLink {
	label: string;
	// App route, without /admin.
	to: string;
	// The collection the user must be able to read for the entry to show; none = always shown.
	collection?: string;
	adminOnly?: boolean;
	newTab?: boolean;
}

export interface NavGroup {
	id: 'main' | 'dashboards' | 'records' | 'inventory' | 'resources' | 'tools';
	label: string | null;
	collapsible: boolean;
	links: NavLink[];
}

export const NAV_GROUPS: NavGroup[] = [
	{
		id: 'main',
		label: null,
		collapsible: false,
		links: [{ label: 'Home', to: '/home' }],
	},
	{
		id: 'dashboards',
		label: 'Dashboards',
		collapsible: false,
		links: [
			{ label: 'Force', to: '/d1-force-dashboard' },
			{ label: 'FAST', to: '/d1-fast-dashboard' },
		],
	},
	{
		id: 'records',
		label: 'Records',
		collapsible: false,
		links: [
			{ label: 'Projects', to: '/home/projects', collection: 'projects' },
			{ label: 'Campaigns', to: '/home/campaigns', collection: 'campaigns' },
			{ label: 'Samples', to: '/home/samples', collection: 'physical_samples' },
			{ label: 'Operations', to: '/home/operations', collection: 'manufacturing_operations' },
			{ label: 'Tests', to: '/home/tests', collection: 'test_sessions' },
			{ label: 'People', to: '/home/people', collection: 'people' },
		],
	},
	{
		id: 'inventory',
		label: 'Inventory',
		collapsible: true,
		links: [
			{ label: 'Tools', to: '/home/tools', collection: 'tools' },
			{ label: 'Tool boxes', to: '/home/tool-boxes', collection: 'tool_boxes' },
			{ label: 'Cutting inserts', to: '/home/inserts', collection: 'cutting_inserts' },
			{ label: 'Insert edges', to: '/home/edges', collection: 'insert_edges' },
			{ label: 'Raw stock lots', to: '/home/stock-lots', collection: 'raw_stock_lots' },
		],
	},
	{
		id: 'resources',
		label: 'Resources',
		collapsible: true,
		links: [
			{ label: 'Equipment', to: '/home/equipment', collection: 'equipment' },
			{ label: 'Materials', to: '/home/materials', collection: 'materials' },
			{ label: 'Machine operators', to: '/home/machine-operators', collection: 'Machine_Operators' },
			{ label: 'Insert types', to: '/home/insert-types', collection: 'insert_types' },
			{ label: 'ISO classes', to: '/home/iso-classes', collection: 'material_iso_classifications' },
			{ label: 'Methods', to: '/home/methods', collection: 'manufacturing_methods' },
			{ label: 'Manufacturers', to: '/home/manufacturers', collection: 'manufacturers' },
			{ label: 'Facilities', to: '/home/facilities', collection: 'facilities' },
			{ label: 'Prep recipes', to: '/home/prep-recipes', collection: 'prep_recipes' },
			{ label: 'Etchants', to: '/home/etchants', collection: 'etchants' },
			{ label: 'FAST recipes', to: '/home/fast-recipes', collection: 'fast_recipes' },
		],
	},
	{
		id: 'tools',
		label: 'Tools',
		collapsible: false,
		links: [
			{ label: 'Print labels', to: '/d1-report/labels', newTab: true },
			{ label: 'Report a bug', to: '/report-bug' },
			{ label: 'Data Studio', to: '/content' },
			{ label: 'Force Crawler', to: '/d1-force-crawler', adminOnly: true },
		],
	},
];

// A saved view, as /presets returns it (only the fields the Explorer asks for).
export interface Bookmark {
	id: number;
	bookmark: string;
	collection: string;
	user: string | null;
	role: string | null;
	filter: unknown;
	search: string | null;
	layout_query: unknown;
}

export interface VisibleNav {
	// Omit, so `links` is the bookmarked list and not an intersection with the plain one.
	groups: Array<Omit<NavGroup, 'links'> & { links: Array<NavLink & { bookmarks: Bookmark[] }> }>;
}

// Global views first, then the role's, then the user's own; A-Z inside each band.
function bookmarkBand(b: Bookmark): number {
	if (b.user) return 2;
	if (b.role) return 1;
	return 0;
}

function sortBookmarks(list: Bookmark[]): Bookmark[] {
	return [...list].sort(
		(a, b) => bookmarkBand(a) - bookmarkBand(b)
			|| a.bookmark.localeCompare(b.bookmark, undefined, { sensitivity: 'base' }),
	);
}

// visibleCollections is what GET /collections returned; null means that call failed, in which
// case only the entries that need no collection stay (spec section 8).
export function buildNav(visibleCollections: Set<string> | null, bookmarks: Bookmark[], isAdmin: boolean): VisibleNav {
	const byCollection = new Map<string, Bookmark[]>();
	for (const b of bookmarks) {
		const list = byCollection.get(b.collection);
		if (list) list.push(b);
		else byCollection.set(b.collection, [b]);
	}

	const groups: VisibleNav['groups'] = [];
	for (const group of NAV_GROUPS) {
		const links = group.links
			.filter((link) => {
				if (link.adminOnly && !isAdmin) return false;
				if (!link.collection) return true;
				return visibleCollections !== null && visibleCollections.has(link.collection);
			})
			.map((link) => ({
				...link,
				bookmarks: link.collection ? sortBookmarks(byCollection.get(link.collection) ?? []) : [],
			}));
		if (links.length) groups.push({ ...group, links });
	}
	return { groups };
}

// Where a saved view opens: its collection's page with ?bookmark=<id> (see indexRoute for the
// bespoke pages and the Data Studio fallback).
export function linkForBookmark(b: Bookmark): string {
	return indexRoute(b.collection, { bookmark: b.id });
}
