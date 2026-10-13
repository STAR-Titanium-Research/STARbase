import { indexRoute } from '../recordRoute';
import type { NavIconName } from './navIcons';

// The sidebar tree, as data. Grouping is the lab's, not the Directus collection tree's (there,
// samples sit under "inventory" and tests under "projects"). buildNav() then trims the tree to
// what this user can see and hangs their saved views (bookmarks) under the right entries.

export interface NavLink {
	label: string;
	// The page's own 16px outline icon (see navIcons.ts).
	icon: NavIconName;
	// App route, without /admin.
	to: string;
	// The collection the user must be able to read for the entry to show; none = always shown.
	collection?: string;
	adminOnly?: boolean;
	newTab?: boolean;
}

export interface NavGroup {
	id: 'main' | 'records' | 'analysis' | 'inventory' | 'reference' | 'more' | 'admin';
	label: string | null;
	collapsible: boolean;
	links: NavLink[];
}

export const NAV_GROUPS: NavGroup[] = [
	{
		id: 'main',
		label: null,
		collapsible: false,
		links: [{ label: 'Home', icon: 'home', to: '/home' }],
	},
	{
		id: 'records',
		label: 'Records',
		collapsible: false,
		links: [
			{ label: 'Projects', icon: 'folder', to: '/home/projects', collection: 'projects' },
			{ label: 'Campaigns', icon: 'flag', to: '/home/campaigns', collection: 'campaigns' },
			{ label: 'Samples', icon: 'test-tube', to: '/home/samples', collection: 'physical_samples' },
			{ label: 'Operations', icon: 'cog', to: '/home/operations', collection: 'manufacturing_operations' },
			{ label: 'Tests', icon: 'clipboard-check', to: '/home/tests', collection: 'test_sessions' },
			{ label: 'People', icon: 'users', to: '/home/people', collection: 'people' },
		],
	},
	{
		id: 'analysis',
		label: 'Analysis',
		collapsible: false,
		links: [
			{ label: 'Force plotter', icon: 'activity', to: '/d1-force-dashboard' },
			{ label: 'FAST plotter', icon: 'zap', to: '/d1-fast-dashboard' },
		],
	},
	{
		id: 'inventory',
		label: 'Inventory',
		collapsible: true,
		links: [
			{ label: 'Tools', icon: 'wrench', to: '/home/tools', collection: 'tools' },
			{ label: 'Tool boxes', icon: 'briefcase', to: '/home/tool-boxes', collection: 'tool_boxes' },
			{ label: 'Cutting inserts', icon: 'diamond', to: '/home/inserts', collection: 'cutting_inserts' },
			{ label: 'Insert edges', icon: 'triangle-right', to: '/home/edges', collection: 'insert_edges' },
			{ label: 'Raw stock lots', icon: 'cylinder', to: '/home/stock-lots', collection: 'raw_stock_lots' },
		],
	},
	{
		id: 'reference',
		label: 'Reference',
		collapsible: true,
		links: [
			{ label: 'Equipment', icon: 'drill', to: '/home/equipment', collection: 'equipment' },
			{ label: 'Materials', icon: 'layers', to: '/home/materials', collection: 'materials' },
			{ label: 'Machine operators', icon: 'hard-hat', to: '/home/machine-operators', collection: 'Machine_Operators' },
			{ label: 'Insert types', icon: 'shapes', to: '/home/insert-types', collection: 'insert_types' },
			{ label: 'ISO classes', icon: 'tag', to: '/home/iso-classes', collection: 'material_iso_classifications' },
			{ label: 'Methods', icon: 'workflow', to: '/home/methods', collection: 'manufacturing_methods' },
			{ label: 'Manufacturers', icon: 'factory', to: '/home/manufacturers', collection: 'manufacturers' },
			{ label: 'Facilities', icon: 'building-2', to: '/home/facilities', collection: 'facilities' },
			{ label: 'Prep recipes', icon: 'flask-conical', to: '/home/prep-recipes', collection: 'prep_recipes' },
			{ label: 'Etchants', icon: 'droplet', to: '/home/etchants', collection: 'etchants' },
			{ label: 'FAST recipes', icon: 'flame', to: '/home/fast-recipes', collection: 'fast_recipes' },
		],
	},
	{
		id: 'more',
		label: 'More',
		collapsible: false,
		links: [
			{ label: 'Print labels', icon: 'printer', to: '/home/labels' },
			{ label: 'Report a bug', icon: 'bug', to: '/report-bug' },
			{ label: 'Settings', icon: 'settings', to: '/home/settings' },
		],
	},
	{
		id: 'admin',
		label: 'Admin',
		collapsible: false,
		links: [
			{ label: 'Data Studio', icon: 'database', to: '/content' },
			{ label: 'Force Crawler', icon: 'radar', to: '/crawler', adminOnly: true },
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

// The filter for GET /presets: only saved views meant for this user. An admin can read every
// user's presets, so without it the sidebar would list other people's private bookmarks. Own
// views, or shared ones (no user) that are global (no role) or for this user's role. Directus
// resolves the $CURRENT_* variables on the server.
export const BOOKMARK_VISIBILITY_FILTER = {
	_and: [
		{ bookmark: { _nnull: true } },
		{
			_or: [
				{ user: { _eq: '$CURRENT_USER' } },
				{
					_and: [
						{ user: { _null: true } },
						{ _or: [{ role: { _null: true } }, { role: { _eq: '$CURRENT_ROLE' } }] },
					],
				},
			],
		},
	],
};

// Who is looking: an unknown id or role (not loaded yet, or the request failed) filters nothing
// here, the server filter above already did.
export interface NavViewer {
	id?: string | null;
	role?: string | null;
}

// The same rule as the server filter, as a second line of defence.
function visibleTo(b: Bookmark, me: NavViewer): boolean {
	if (b.user) return !me.id || b.user === me.id;
	if (b.role) return !me.role || b.role === me.role;
	return true;
}

// The strict form of the rule, for a view fetched by id (GET /presets/<id>, which an admin can do
// for anyone's): whose it is must be known to say yes. user = null (the signed-in user is not
// loaded yet) admits only global views, because nothing else can be judged. A user with no role
// (role null) sees no role-shared view.
export function bookmarkVisibleToUser(b: Pick<Bookmark, 'user' | 'role'>, user: { id: string; role?: string | null } | null): boolean {
	if (b.user) return !!user && b.user === user.id;
	if (b.role) return !!user && !!user.role && b.role === user.role;
	return true;
}

// The saved view a named link should open (the Home tile for failed tests): global first, then the
// role's, then the user's own, lowest id first inside each. Views this user may not see are never
// picked, whatever the request returned.
export function pickBookmarkId(rows: Array<Pick<Bookmark, 'id' | 'user' | 'role'>>, user: { id: string; role?: string | null } | null): number | null {
	const mine = rows.filter((r) => bookmarkVisibleToUser(r, user)).sort((a, b) => a.id - b.id);
	const pick = mine.find((r) => !r.user && !r.role) ?? mine.find((r) => !r.user) ?? mine[0];
	return pick ? pick.id : null;
}

// Projects and People are bespoke pages that ignore a saved view (see indexRoute), so a view
// listed under them would open the plain list: they get none.
const BESPOKE_PAGES = new Set(['projects', 'people']);

// visibleCollections is what GET /collections returned; null means that call failed, in which
// case only the entries that need no collection stay (spec section 8).
export function buildNav(visibleCollections: Set<string> | null, bookmarks: Bookmark[], isAdmin: boolean, me: NavViewer = {}): VisibleNav {
	const byCollection = new Map<string, Bookmark[]>();
	for (const b of bookmarks) {
		if (!visibleTo(b, me)) continue;
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
				bookmarks: link.collection && !BESPOKE_PAGES.has(link.collection) ? sortBookmarks(byCollection.get(link.collection) ?? []) : [],
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
