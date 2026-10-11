// The index page's URL <-> state <-> Directus /items request. Pure: no Vue, no network, so the
// whole query story (spec section 5) is testable and the same code runs in any host.
//
// URL keys: bookmark, q, f.<field> (one per chip filter), sort, page, open.

import type { Bookmark } from '../nav/navConfig';
import type { IndexDef } from './indexConfig';

export const PAGE_SIZE = 50;
// What a short ID looks like (8-32 hex characters): the finder and the search box match it exactly.
export const SHORT_ID_RE = /^[0-9a-f]{8,32}$/i;

export interface IndexState {
	bookmark: number | null;
	q: string;
	// chip filters, field -> chosen value (bool chips use 'true' / 'false')
	filters: Record<string, string>;
	// a field, with a leading '-' for descending; null = the bookmark's or the page's default
	sort: string | null;
	page: number;
	// primary key of the row whose drawer is open
	open: string | null;
}

type RawQuery = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function stateFromQuery(query: RawQuery): IndexState {
	const bookmark = Number(first(query.bookmark));
	const page = Number(first(query.page));
	const filters: Record<string, string> = {};
	for (const [key, raw] of Object.entries(query)) {
		if (!key.startsWith('f.') || key.length === 2) continue;
		const value = first(raw);
		if (value) filters[key.slice(2)] = value;
	}
	return {
		bookmark: Number.isInteger(bookmark) && bookmark > 0 ? bookmark : null,
		q: first(query.q) ?? '',
		filters,
		sort: first(query.sort) || null,
		page: Number.isInteger(page) && page >= 1 ? page : 1,
		open: first(query.open) || null,
	};
}

// Defaults are left out so a plain list has a plain URL.
export function queryFromState(s: IndexState): Record<string, string> {
	const out: Record<string, string> = {};
	if (s.bookmark !== null) out.bookmark = String(s.bookmark);
	if (s.q) out.q = s.q;
	for (const [field, value] of Object.entries(s.filters)) if (value) out[`f.${field}`] = value;
	if (s.sort) out.sort = s.sort;
	if (s.page > 1) out.page = String(s.page);
	if (s.open) out.open = s.open;
	return out;
}

// 'sample_id.sample_code' -> { sample_id: { sample_code: cond } }
export function nested(path: string, cond: unknown): Record<string, unknown> {
	return path.split('.').reduceRight<unknown>((inner, key) => ({ [key]: inner }), cond) as Record<string, unknown>;
}

// layout_query.tabular.sort[0] of a saved view, if it has one.
export function bookmarkSort(b: Bookmark | null): string | null {
	const lq = b?.layout_query as { tabular?: { sort?: unknown } } | null | undefined;
	const sort = lq?.tabular?.sort;
	const head = Array.isArray(sort) ? sort[0] : sort;
	return typeof head === 'string' && head ? head : null;
}

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
}

function searchClause(def: IndexDef, q: string): Record<string, unknown> | null {
	const text = q.trim();
	if (!text) return null;
	const or: Record<string, unknown>[] = def.searchFields.map((f) => nested(f, { _icontains: text }));
	if (def.hasShortId && SHORT_ID_RE.test(text)) or.push({ short_id: { _eq: text.toLowerCase() } });
	return or.length ? { _or: or } : null;
}

// Params for GET /items/<collection>. `fields` and `sort` are arrays (axios sends them as
// fields[]=a&fields[]=b, which Directus accepts, and the d1-home pages already do the same);
// `filter` is a JSON string, which Directus parses from the query string. A chip whose field
// the page does not offer is dropped, so a hand-edited URL cannot send Directus an unknown field.
export function buildItemsParams(def: IndexDef, s: IndexState, bookmark: Bookmark | null): Record<string, unknown> {
	const fields = [def.primaryKey];
	for (const c of def.columns) {
		const f = c.relation ? `${c.field}.${c.relation.display}` : c.field;
		if (!fields.includes(f)) fields.push(f);
	}

	const and: unknown[] = [];
	if (isNonEmptyObject(def.fixedFilter)) and.push(def.fixedFilter);
	if (bookmark && isNonEmptyObject(bookmark.filter)) and.push(bookmark.filter);
	for (const [field, value] of Object.entries(s.filters)) {
		const chip = def.filters.find((f) => f.field === field);
		if (!chip || !value) continue;
		and.push({ [field]: { _eq: chip.options.kind === 'bool' ? value === 'true' : value } });
	}
	const search = searchClause(def, s.q);
	if (search) and.push(search);

	const params: Record<string, unknown> = {
		fields,
		sort: [s.sort ?? bookmarkSort(bookmark) ?? def.defaultSort],
		limit: PAGE_SIZE,
		page: s.page,
		meta: 'filter_count',
	};
	if (and.length) params.filter = JSON.stringify({ _and: and });
	return params;
}

// "Open in Data Studio": Directus has no URL parameter for an ad-hoc filter, so only a bare
// bookmark carries over; with a search or chips it opens the plain list and says so.
export function dataStudioLink(def: IndexDef, s: IndexState): { to: string; note: string | null } {
	const base = `/content/${def.collection}`;
	const chips = Object.values(s.filters).some(Boolean);
	if (s.q.trim() || chips) {
		return { to: base, note: "Opens the full list: the Data Studio can't take this search or these filters." };
	}
	return { to: s.bookmark !== null ? `${base}?bookmark=${s.bookmark}` : base, note: null };
}
