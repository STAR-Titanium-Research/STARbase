import { FINDER_SOURCES } from './finder/finder';
import { INDEX_DEFS } from './index/indexConfig';
import { indexRoute } from './recordRoute';

// The pure half of the Home "Frequently used" panel (spec
// docs/superpowers/specs/2026-10-12-explorer-frequently-used-design.md): which target a route is,
// the 10-minute repeat filter, the display labels of pages and records, and the suggestions that
// fill an empty list. Free of Vue and of the host, so it is tested on its own and a standalone
// Explorer reuses it. The server half is core/extensions/d1-usage (POST /d1-usage/visit ...).

export type UsageKind = 'page' | 'record';

// The page keys the endpoint accepts. A copy of PAGE_KEYS in core/extensions/d1-usage/index.js: the
// drift test in usage.test.ts reads that file and compares, so the two cannot differ unnoticed.
// Keep one key per line, in the endpoint's order.
export const PAGE_KEYS: readonly string[] = [
	'campaigns',
	'samples',
	'operations',
	'tests',
	'tools',
	'tool-boxes',
	'inserts',
	'edges',
	'stock-lots',
	'equipment',
	'materials',
	'machine-operators',
	'insert-types',
	'iso-classes',
	'methods',
	'manufacturers',
	'facilities',
	'prep-recipes',
	'etchants',
	'fast-recipes',
	'projects',
	'people',
	'force-dashboard',
	'fast-dashboard',
	'action:register-sample',
	'action:log-operation',
	'action:print-labels',
];

// The seven collections whose records are counted, as the endpoint's RECORD_COLLECTIONS.
export const RECORD_COLLECTIONS: readonly string[] = [
	'physical_samples',
	'manufacturing_operations',
	'test_sessions',
	'campaigns',
	'projects',
	'people',
	'equipment',
];

export interface PageInfo {
	key: string;
	label: string;
	// An app route (no /admin), or a server page for the quick action that prints labels.
	to: string;
	// Opens in a new tab (a server page, not an app route).
	newTab?: boolean;
}

// What each page key is called and where it goes. The index pages come from INDEX_DEFS (their title
// and slug), so a renamed page cannot leave this behind; the rest are written out.
const EXTRA_PAGES: PageInfo[] = [
	{ key: 'projects', label: 'Projects', to: '/home/projects' },
	{ key: 'people', label: 'People', to: '/home/people' },
	{ key: 'force-dashboard', label: 'Force dashboard', to: '/d1-force-dashboard' },
	{ key: 'fast-dashboard', label: 'FAST dashboard', to: '/d1-fast-dashboard' },
	{ key: 'action:register-sample', label: 'Register a sample', to: '/content/physical_samples/+' },
	{ key: 'action:log-operation', label: 'Log an operation', to: '/content/manufacturing_operations/+' },
	{ key: 'action:print-labels', label: 'Print labels', to: '/d1-report/labels', newTab: true },
];

export const PAGES: Record<string, PageInfo> = Object.fromEntries(
	[...INDEX_DEFS.map((d): PageInfo => ({ key: d.slug, label: d.title, to: `/home/${d.slug}` })), ...EXTRA_PAGES].map((p) => [p.key, p]),
);

// The pages the panel offers while a user has little or no history, best first. "My samples" is a
// saved view (a bookmark) of the samples page, so the plain Samples page stands in for it.
export const SUGGESTED_PAGES: readonly string[] = ['samples', 'action:log-operation', 'action:register-sample', 'operations'];

const SLUG_PAGES = new Set(PAGE_KEYS.filter((k) => !k.includes(':') && !k.endsWith('-dashboard')));
const DASHBOARD_PATHS: Record<string, string> = { '/d1-force-dashboard': 'force-dashboard', '/d1-fast-dashboard': 'fast-dashboard' };
const ACTION_PATHS: Record<string, string> = {
	'/content/physical_samples/+': 'action:register-sample',
	'/content/manufacturing_operations/+': 'action:log-operation',
	'/d1-report/labels': 'action:print-labels',
};
// The Explorer page of one record: /home/<slug>/<id>.
const RECORD_SLUGS: Record<string, string> = {
	samples: 'physical_samples',
	operations: 'manufacturing_operations',
	tests: 'test_sessions',
	campaigns: 'campaigns',
	projects: 'projects',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INT_ID = /^[1-9][0-9]{0,17}$/;

// A route's path, without its query, hash, trailing slash or the app's /admin base.
function cleanPath(path: string): string {
	const bare = path.split(/[?#]/)[0].replace(/\/+$/, '');
	return bare.startsWith('/admin/') ? bare.slice('/admin'.length) : bare;
}

// The page key of an Explorer page (or quick action form, or dashboard) at this path, else null.
// Record pages (/home/samples/<id>) are not pages: see recordTarget and routeTarget.
export function pageTarget(path: string): string | null {
	const p = cleanPath(path);
	const direct = DASHBOARD_PATHS[p] ?? ACTION_PATHS[p];
	if (direct) return direct;
	const m = /^\/home\/([^/]+)$/.exec(p);
	return m && SLUG_PAGES.has(m[1]) ? m[1] : null;
}

// "<collection>:<id>" for one of the seven collections with a uuid or positive-integer id, else null.
export function recordTarget(collection: string, id: string | number | null | undefined): string | null {
	if (!RECORD_COLLECTIONS.includes(collection)) return null;
	const value = String(id ?? '').toLowerCase();
	return UUID.test(value) || INT_ID.test(value) ? `${collection}:${value}` : null;
}

// What a route is, as a ping: a page key, or the record whose Explorer page it is. null = nothing to count.
export function routeTarget(path: string): { kind: UsageKind; target: string } | null {
	const page = pageTarget(path);
	if (page) return { kind: 'page', target: page };
	const m = /^\/home\/([^/]+)\/([^/]+)$/.exec(cleanPath(path));
	const collection = m ? RECORD_SLUGS[m[1]] : undefined;
	if (!m || !collection) return null;
	let id: string;
	try {
		id = decodeURIComponent(m[2]);
	} catch {
		return null;
	}
	const target = recordTarget(collection, id);
	return target ? { kind: 'record', target } : null;
}

// True the first time a target is seen and again once the window has passed since the last time it
// was let through: a user reloading or going back and forth is one visit, not many. The clock is
// injectable for tests.
export function createRepeatFilter(windowMs = 10 * 60 * 1000, now: () => number = Date.now): (target: string) => boolean {
	const lastSent = new Map<string, number>();
	return (target) => {
		const t = now();
		const before = lastSent.get(target);
		if (before !== undefined && t - before < windowMs) return false;
		lastSent.set(target, t);
		return true;
	};
}

// One list entry as the panel shows it.
export interface UsageEntry {
	target: string;
	label: string;
	to: string;
	pinned: boolean;
	newTab?: boolean;
	// Offered because the list is short, not because it was used.
	suggested?: boolean;
}

// The real entries, then suggestions (flagged `suggested`, skipping any already in the list) while
// there are fewer than n in all. More than n real entries are all kept: the panel does the cutting.
export function mergeWithSuggestions<T extends { target: string }>(items: T[], suggestions: T[], n: number): Array<T & { suggested?: true }> {
	const out: Array<T & { suggested?: true }> = [...items];
	const have = new Set(items.map((i) => i.target));
	for (const s of suggestions) {
		if (out.length >= n) break;
		if (have.has(s.target)) continue;
		out.push({ ...s, suggested: true });
	}
	return out;
}

// The suggested pages as entries, for mergeWithSuggestions.
export function suggestedPageEntries(): UsageEntry[] {
	return SUGGESTED_PAGES.flatMap((key) => {
		const page = PAGES[key];
		return page ? [{ target: key, label: page.label, to: page.to, pinned: false, newTab: page.newTab }] : [];
	});
}

// An entry for a page key from the endpoint, or null for a key this build does not know.
export function pageEntry(key: string, pinned: boolean): UsageEntry | null {
	const page = PAGES[key];
	return page ? { target: key, label: page.label, to: page.to, pinned, newTab: page.newTab } : null;
}

// How a record collection is loaded and shown: the primary key, the fields its label needs, and the
// label and route. The six the finder searches reuse its sources (one definition of what a sample or
// an operation is called); equipment, which the finder lacks, opens its drawer on the equipment page.
interface RecordDef {
	idField: string;
	fields: string[];
	label(row: any): string;
	to(row: any): string;
}

const ID_FIELDS: Record<string, string> = {
	physical_samples: 'sample_id',
	manufacturing_operations: 'operation_id',
	test_sessions: 'session_id',
	campaigns: 'campaign_id',
	projects: 'project_id',
	people: 'person_id',
	equipment: 'equipment_id',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function recordDef(collection: string): RecordDef | null {
	const idField = ID_FIELDS[collection];
	if (!idField) return null;
	if (collection === 'equipment') {
		return {
			idField,
			fields: [idField, 'equipment_code', 'equipment_name'],
			label: (r) => str(r.equipment_name) || str(r.equipment_code) || 'Equipment',
			to: (r) => indexRoute('equipment', { open: String(r[idField]) }),
		};
	}
	const src = FINDER_SOURCES.find((s) => s.collection === collection);
	return src ? { idField, fields: src.fields, label: src.label, to: src.to } : null;
}

// The GET /items/<collection> parameters that load the labels of these records in one request.
export function recordRequest(collection: string, ids: string[]): { fields: string[]; filter: string; limit: number } | null {
	const def = recordDef(collection);
	if (!def || ids.length === 0) return null;
	return { fields: def.fields, filter: JSON.stringify({ [def.idField]: { _in: ids } }), limit: ids.length };
}

// The entries for the rows a collection answered with. `used` is the endpoint's items of this
// collection (their targets are "<collection>:<id>"), in its order, which the result keeps; one
// whose row did not come back (deleted, or not readable by this user) is left out without a trace.
export function recordEntries(collection: string, rows: any[], used: Array<{ target: string; pinned: boolean }>): UsageEntry[] {
	const def = recordDef(collection);
	if (!def) return [];
	const byId = new Map<string, any>();
	for (const row of rows) byId.set(String(row?.[def.idField]).toLowerCase(), row);
	return used.flatMap((u) => {
		const row = byId.get(u.target.slice(collection.length + 1).toLowerCase());
		return row ? [{ target: u.target, label: def.label(row), to: def.to(row), pinned: u.pinned }] : [];
	});
}

// "collection:id" split in two, or null when it is not one of ours.
export function splitRecordTarget(target: string): { collection: string; id: string } | null {
	const i = target.indexOf(':');
	if (i < 1) return null;
	const collection = target.slice(0, i);
	return RECORD_COLLECTIONS.includes(collection) ? { collection, id: target.slice(i + 1) } : null;
}
