// The index page's URL <-> state <-> Directus /items request. Pure: no Vue, no network, so the
// whole query story (spec section 5) is testable and the same code runs in any host.
//
// URL keys: bookmark, q, f.<field> (one per chip filter), sort, page, open.

import type { Bookmark } from '../nav/navConfig';
import { groupKeys, sortWithGroup } from './groupBy';
import type { IndexDef } from './indexConfig';
import { DEFAULT_PAGE_SIZE } from './listPrefs';

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

// Plain digits only ('1e2', '0x10', ' 5' are junk), capped so a hand-edited URL can't send 1e+21.
const MAX_INT = 1_000_000_000;
function positiveInt(v: string | undefined): number | null {
	if (!v || !/^\d+$/.test(v)) return null;
	const n = Number(v);
	return n >= 1 && n <= MAX_INT ? n : null;
}

// A saved-view chip toggles: clicking the one that is on clears it (back to the whole list), any other turns it on.
export function toggledBookmark(current: number | null, clicked: number): number | null {
	return current === clicked ? null : clicked;
}

export function stateFromQuery(query: RawQuery): IndexState {
	const bookmark = positiveInt(first(query.bookmark));
	const page = positiveInt(first(query.page));
	const filters: Record<string, string> = {};
	for (const [key, raw] of Object.entries(query)) {
		if (!key.startsWith('f.') || key.length === 2) continue;
		const value = first(raw);
		if (value) filters[key.slice(2)] = value;
	}
	return {
		bookmark,
		q: first(query.q) ?? '',
		filters,
		sort: first(query.sort) || null,
		page: page ?? 1,
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

// A filter that matches no row: a team with no readable records (or whose ids could not be had) shows an empty list, never every row.
// A nil uuid is a valid value for every primary key the Team filter is used on, and no record has it.
export const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';

// Params for GET /items/<collection>. `fields` and `sort` are arrays (axios sends them as
// fields[]=a&fields[]=b, which Directus accepts, and the STARbase pages already do the same);
// `filter` is a JSON string, which Directus parses from the query string. A chip whose field
// the page does not offer is dropped, so a hand-edited URL cannot send Directus an unknown field.
// `readable` is the set of collections the user may read (null = not known: every relation is
// tried). A relation column whose collection is not in it is asked for as the bare key, because a
// nested field of a collection the user cannot read is refused; the page then shows that cell blank.
// `teamIds`: the ids of the chosen team's records the viewer can read (GET /d1-teams/:id/records), for the Team chip (`f.team`) when it is set:
// the primary key must be one of them (none, or ids not known: nothing matches, so a hidden record can never slip in).
// `view`: how the person looks at the list (View rail, not the URL): rows per page, and the filter field rows are grouped by (sorted by it first).
export interface ViewParams {
	pageSize?: number;
	groupBy?: string | null;
}
export function buildItemsParams(
	def: IndexDef,
	s: IndexState,
	bookmark: Bookmark | null,
	readable: ReadonlySet<string> | null = null,
	teamIds: readonly string[] | null = null,
	view: ViewParams = {},
): Record<string, unknown> {
	const fields = [def.primaryKey];
	for (const c of def.columns) {
		const f = c.relation && (!readable || readable.has(c.relation.collection)) ? `${c.field}.${c.relation.display}` : c.field;
		if (!fields.includes(f)) fields.push(f);
	}
	const group = groupKeys(def, view.groupBy ?? null, readable);
	for (const f of group) if (!fields.includes(f)) fields.push(f);

	const and: unknown[] = [];
	if (isNonEmptyObject(def.fixedFilter)) and.push(def.fixedFilter);
	if (bookmark && isNonEmptyObject(bookmark.filter)) and.push(bookmark.filter);
	for (const [field, value] of Object.entries(s.filters)) {
		const chip = def.filters.find((f) => f.field === field);
		if (!chip || !value) continue;
		if (chip.options.kind === 'bool') {
			if (value !== 'true' && value !== 'false') continue; // junk is dropped, not read as false
			and.push({ [field]: { _eq: value === 'true' } });
		} else if (chip.options.kind === 'team') {
			and.push({ [def.primaryKey]: { _in: teamIds?.length ? [...teamIds] : [NO_MATCH_ID] } });
		} else if (chip.options.kind === 'flag') {
			if (value === 'true') and.push(chip.options.filter); // a flag is on or off: anything else is dropped
		} else {
			and.push({ [field]: { _eq: value } });
		}
	}
	const search = searchClause(def, s.q);
	if (search) and.push(search);

	const params: Record<string, unknown> = {
		fields,
		sort: sortWithGroup(group, s.sort ?? bookmarkSort(bookmark) ?? def.defaultSort),
		limit: view.pageSize ?? DEFAULT_PAGE_SIZE,
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
