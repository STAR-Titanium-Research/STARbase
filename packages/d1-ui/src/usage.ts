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
	'build-process',
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
	{ key: 'build-process', label: 'Build a process', to: '/map?edit=new' },
	{ key: 'action:register-sample', label: 'Register a sample', to: '/content/physical_samples/+' },
	{ key: 'action:log-operation', label: 'Log an operation', to: '/content/manufacturing_operations/+' },
	{ key: 'action:print-labels', label: 'Print labels', to: '/home/labels' },
];

export const PAGES: Record<string, PageInfo> = Object.fromEntries(
	[...INDEX_DEFS.map((d): PageInfo => ({ key: d.slug, label: d.title, to: `/home/${d.slug}` })), ...EXTRA_PAGES].map((p) => [p.key, p]),
);

// The pages the panel offers while a user has little or no history, best first. "My samples" is a
// saved view (a bookmark) of the samples page, so the plain Samples page stands in for it.
export const SUGGESTED_PAGES: readonly string[] = ['samples', 'action:log-operation', 'action:register-sample', 'operations'];

// Build a process is the Process map in edit mode: it has no /home/<slug> page (see pageTarget).
const BUILD_PROCESS = 'build-process';
const SLUG_PAGES = new Set(PAGE_KEYS.filter((k) => !k.includes(':') && !k.endsWith('-dashboard') && k !== BUILD_PROCESS));
const DASHBOARD_PATHS: Record<string, string> = { '/d1-force-dashboard': 'force-dashboard', '/d1-fast-dashboard': 'fast-dashboard' };
const ACTION_PATHS: Record<string, string> = {
	'/content/physical_samples/+': 'action:register-sample',
	'/content/manufacturing_operations/+': 'action:log-operation',
	'/home/labels': 'action:print-labels',
	'/d1-report/labels': 'action:print-labels', // the old label page, now a redirect
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
	// The Process map in edit mode (?edit=new on a blank canvas, ?edit=<draft> on a draft) is Build a process; the map itself has no key.
	if (p === '/map') return new URLSearchParams(path.split('#')[0].split('?')[1] ?? '').get('edit') ? BUILD_PROCESS : null;
	const m = /^\/home\/([^/]+)$/.exec(p);
	return m && SLUG_PAGES.has(m[1]) ? m[1] : null;
}

// "<collection>:<id>" for one of the seven collections with a uuid id (all seven have uuid keys), else null.
export function recordTarget(collection: string, id: string | number | null | undefined): string | null {
	if (!RECORD_COLLECTIONS.includes(collection)) return null;
	const value = String(id ?? '').toLowerCase();
	return UUID.test(value) ? `${collection}:${value}` : null;
}

// What a route is, as a ping: a page key, or the record whose Explorer page it is. null = nothing to
// count. An equipment item has no page of its own, only a drawer on the equipment list (?open=<id>):
// opening one counts as a visit to that item. People have neither a page nor a drawer, so a person
// is counted only when edited (the activity fold) or pinned.
export function routeTarget(path: string): { kind: UsageKind; target: string } | null {
	const page = pageTarget(path);
	if (page === 'equipment') {
		const open = new URLSearchParams(path.split('#')[0].split('?')[1] ?? '').get('open');
		const target = open ? recordTarget('equipment', open) : null;
		if (target) return { kind: 'record', target };
	}
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

// The repeat filter: a target is let through the first time it is seen and again once the window has
// passed since it last was. Calling the filter checks and marks in one step. A sender that must only
// count a ping once it is really on its way uses peek (would it pass?), mark (it is on its way) and
// unmark (it failed: let the next try through). The clock is injectable for tests.
export interface RepeatFilter {
	(target: string): boolean;
	peek(target: string): boolean;
	mark(target: string): void;
	unmark(target: string): void;
}

export function createRepeatFilter(windowMs = 10 * 60 * 1000, now: () => number = Date.now): RepeatFilter {
	const lastSent = new Map<string, number>();
	const peek = (target: string) => {
		const before = lastSent.get(target);
		return before === undefined || now() - before >= windowMs;
	};
	const mark = (target: string) => void lastSent.set(target, now());
	const unmark = (target: string) => void lastSent.delete(target);
	const send = (target: string) => {
		if (!peek(target)) return false;
		mark(target);
		return true;
	};
	return Object.assign(send, { peek, mark, unmark });
}

// One list entry as the panel shows it. `pinned` is the endpoint's vestigial field (always false
// now that pinned rows are left out of GET /d1-usage); the panel never reads it.
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
	// A non-uuid id would make Postgres reject the whole `_in` and drop every record of the collection.
	const good = ids.filter((id) => UUID.test(id));
	if (!def || good.length === 0) return null;
	return { fields: def.fields, filter: JSON.stringify({ [def.idField]: { _in: good } }), limit: good.length };
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

// -- List changes (pure, so the panel's optimistic updates and their reverts are tested) -------------

// The list without the entries that are pinned (as `isPinned` says: the shared sidebar pins state).
// Pins live in the sidebar only, so a pinned row leaves the panel the moment it is pinned, and comes
// back in its old place if the pin is undone (a failed save rolls the pin back). `kind` is how the
// panel's list is pinned: 'page' for pages and quick actions, 'record' for records.
export function withoutPinned<T extends { target: string }>(list: T[], kind: 'page' | 'record', isPinned: (p: { kind: 'page' | 'record'; target: string }) => boolean): T[] {
	return list.filter((e) => !isPinned({ kind, target: e.target }));
}

// The list without this entry, and where it was (for restoreEntry).
export function removeEntry(list: UsageEntry[], target: string): { list: UsageEntry[]; index: number } {
	return { list: list.filter((e) => e.target !== target), index: list.findIndex((e) => e.target === target) };
}

// Put a removed entry back at about its old place (clamped to the list as it is now), unless it is
// already there. Touches no other entry.
export function restoreEntry(list: UsageEntry[], entry: UsageEntry, index: number): UsageEntry[] {
	if (list.some((e) => e.target === entry.target)) return list;
	const at = Math.max(0, Math.min(index, list.length));
	return [...list.slice(0, at), entry, ...list.slice(at)];
}

// -- Dismissed suggestions (a per-browser convenience, never sent to the server) --------------------

export const DISMISSED_KEY = 'd1.usage.dismissed';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

// The browser's storage, or null when it is missing or refuses (private window, blocked site data).
function browserStore(): KeyValueStore | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

// The suggestion keys this browser dismissed. Every read is guarded: no storage, or junk in it, is
// the empty set.
export function readDismissed(store: KeyValueStore | null = browserStore()): Set<string> {
	try {
		const parsed: unknown = JSON.parse(store?.getItem(DISMISSED_KEY) ?? '[]');
		return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
	} catch {
		return new Set();
	}
}

// Remembers the set; a storage that refuses is ignored (the dismissal then lasts until the page reloads).
export function writeDismissed(keys: Set<string>, store: KeyValueStore | null = browserStore()): void {
	try {
		store?.setItem(DISMISSED_KEY, JSON.stringify([...keys]));
	} catch {
		// Storage is a convenience only.
	}
}

export function withoutDismissed<T extends { target: string }>(suggestions: T[], dismissed: Set<string>): T[] {
	return suggestions.filter((s) => !dismissed.has(s.target));
}
