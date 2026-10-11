import { SHORT_ID_RE } from '../index/indexQuery';
import { indexDefByCollection } from '../index/indexConfig';
import { linkForBookmark, type VisibleNav } from '../nav/navConfig';
import { operationLabel } from '../operationLabel';
import { indexRoute, recordRoute } from '../recordRoute';

// The Ctrl K finder's logic, kept free of Vue and of the host so it can be tested on its own.
// The overlay (a later task) does the fetching: it asks visibleSources() what to query, sends
// sourceParams() to GET /items/<collection>, turns the rows into hits with toHits() and passes
// the lot to mergeHits() together with the local hits.

export type FinderGroup = 'Pages' | 'Saved views' | 'Samples' | 'Operations' | 'Tests' | 'Campaigns' | 'Projects' | 'People' | 'Inventory';

export interface FinderHit {
	group: FinderGroup;
	label: string;
	detail?: string;
	to: string;
	rank: number;
}

export interface FinderSource {
	group: FinderHit['group'];
	collection: string;
	// What to ask Directus for: enough for label/detail/to (and short_id when shortId is set).
	fields: string[];
	// _icontains on each of these.
	match: string[];
	// The collection has a short_id column: a hex input is also tried as an exact short id.
	shortId?: boolean;
	label(row: any): string;
	detail?(row: any): string;
	to(row: any): string;
}

// Below this a query is noise: nothing remote is asked and no local hit is offered.
export const MIN_QUERY = 2;

// Spec section 6: Pages and Saved views first, then the table's order.
const GROUP_ORDER: FinderGroup[] = ['Pages', 'Saved views', 'Samples', 'Operations', 'Tests', 'Campaigns', 'Projects', 'People', 'Inventory'];
const REMOTE_LIMIT = 5;
const LOCAL_GROUPS = new Set<FinderGroup>(['Pages', 'Saved views']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// An inventory code finds its row and opens the index page with that row's drawer. The key comes
// from indexConfig so a renamed primary key cannot leave the finder behind.
function inventory(collection: string, codeField: string, extra: string[] = []): FinderSource {
	const pk = indexDefByCollection(collection)?.primaryKey ?? `${collection}_id`;
	return {
		group: 'Inventory',
		collection,
		fields: [pk, codeField, ...extra],
		match: [codeField],
		label: (r) => str(r[codeField]) || String(r[pk]),
		to: (r) => indexRoute(collection, { open: String(r[pk]) }),
	};
}

export const FINDER_SOURCES: FinderSource[] = [
	{
		group: 'Samples',
		collection: 'physical_samples',
		fields: ['sample_id', 'sample_code', 'nickname', 'short_id'],
		match: ['sample_code', 'nickname'],
		shortId: true,
		label: (r) => str(r.sample_code) || 'Sample',
		detail: (r) => str(r.nickname),
		to: (r) => recordRoute('physical_samples', r.sample_id),
	},
	{
		group: 'Operations',
		collection: 'manufacturing_operations',
		// operationLabel falls back to the sample code and step when there is no pass code.
		fields: ['operation_id', 'pass_code', 'operation_sequence', 'sample_id.sample_code', 'short_id'],
		match: ['pass_code'],
		shortId: true,
		label: (r) => operationLabel(r),
		to: (r) => recordRoute('manufacturing_operations', r.operation_id),
	},
	{
		group: 'Tests',
		collection: 'test_sessions',
		fields: ['session_id', 'test_code', 'test_type', 'short_id'],
		match: ['test_code'],
		shortId: true,
		label: (r) => str(r.test_code) || 'Test',
		detail: (r) => str(r.test_type),
		to: (r) => recordRoute('test_sessions', r.session_id),
	},
	{
		group: 'Campaigns',
		collection: 'campaigns',
		fields: ['campaign_id', 'campaign_code', 'name'],
		match: ['campaign_code', 'name'],
		label: (r) => str(r.campaign_code) || str(r.name) || 'Campaign',
		detail: (r) => (str(r.campaign_code) ? str(r.name) : ''),
		to: (r) => recordRoute('campaigns', r.campaign_id),
	},
	{
		// projects and people have no indexConfig def, so their keys are written out here.
		group: 'Projects',
		collection: 'projects',
		fields: ['project_id', 'project_code', 'project_name'],
		match: ['project_code', 'project_name'],
		label: (r) => str(r.project_code) || str(r.project_name) || 'Project',
		detail: (r) => (str(r.project_code) ? str(r.project_name) : ''),
		to: (r) => recordRoute('projects', r.project_id),
	},
	{
		group: 'People',
		collection: 'people',
		fields: ['person_id', 'full_name'],
		match: ['full_name'],
		label: (r) => str(r.full_name) || 'Person',
		// The People page has no per-person route: it opens searched for the name.
		to: (r) => `/home/people?q=${encodeURIComponent(str(r.full_name))}`,
	},
	inventory('tools', 'tool_code'),
	inventory('tool_boxes', 'tool_box_code'),
	inventory('cutting_inserts', 'insert_code'),
	inventory('insert_edges', 'edge_code'),
	inventory('raw_stock_lots', 'lot_code'),
];

// Only the sources whose collection the user can read; null (the /collections call failed) leaves
// only the local hits.
export function visibleSources(visible: Set<string> | null): FinderSource[] {
	if (visible === null) return [];
	return FINDER_SOURCES.filter((s) => visible.has(s.collection));
}

export function isSearchable(q: string): boolean {
	return q.trim().length >= MIN_QUERY;
}

// Params for GET /items/<collection>, in the shapes indexQuery uses (fields as an array, filter
// as a JSON string).
export function sourceParams(src: FinderSource, q: string): Record<string, unknown> {
	const text = q.trim();
	const or: unknown[] = src.match.map((field) => ({ [field]: { _icontains: text } }));
	if (src.shortId && SHORT_ID_RE.test(text)) or.push({ short_id: { _eq: text.toLowerCase() } });
	return { fields: src.fields, filter: JSON.stringify({ _or: or }), limit: REMOTE_LIMIT };
}

// 0 exact short id, 1 exact code, 2 prefix, 3 contains (or matched on a field the label does not show).
export function rankHit(q: string, label: string, exactShortId: boolean): number {
	if (exactShortId) return 0;
	const needle = q.trim().toLowerCase();
	const text = label.trim().toLowerCase();
	if (text === needle) return 1;
	if (text.startsWith(needle)) return 2;
	return 3;
}

// Rows from one source as hits. An exact short-id match is read off the row's own short_id.
export function toHits(src: FinderSource, q: string, rows: any[]): FinderHit[] {
	const needle = q.trim().toLowerCase();
	return rows.map((row) => {
		const label = src.label(row);
		const exactShortId = !!src.shortId && SHORT_ID_RE.test(needle) && str(row.short_id).toLowerCase() === needle;
		const hit: FinderHit = { group: src.group, label, to: src.to(row), rank: rankHit(q, label, exactShortId) };
		const detail = src.detail?.(row);
		if (detail) hit.detail = detail;
		return hit;
	});
}

// Pages (the sidebar's labels) and saved views, matched in the browser.
export function localHits(q: string, nav: VisibleNav): FinderHit[] {
	if (!isSearchable(q)) return [];
	const needle = q.trim().toLowerCase();
	const hits: FinderHit[] = [];
	for (const group of nav.groups) {
		for (const link of group.links) {
			if (link.label.toLowerCase().includes(needle)) {
				hits.push({ group: 'Pages', label: link.label, to: link.to, rank: rankHit(q, link.label, false) });
			}
			for (const b of link.bookmarks) {
				if (b.bookmark.toLowerCase().includes(needle)) {
					hits.push({ group: 'Saved views', label: b.bookmark, detail: link.label, to: linkForBookmark(b), rank: rankHit(q, b.bookmark, false) });
				}
			}
		}
	}
	return hits;
}

// Groups in spec order, best rank first inside each (ties keep their arrival order), and no more
// than 5 from any remote group (Inventory is five sources but one group).
export function mergeHits(q: string, groups: FinderHit[][]): FinderHit[] {
	if (!isSearchable(q)) return [];
	const all = groups.flat();
	const out: FinderHit[] = [];
	for (const group of GROUP_ORDER) {
		const inGroup = all.filter((h) => h.group === group).sort((a, b) => a.rank - b.rank);
		out.push(...(LOCAL_GROUPS.has(group) ? inGroup : inGroup.slice(0, REMOTE_LIMIT)));
	}
	return out;
}
