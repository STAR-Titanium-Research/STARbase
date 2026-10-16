import { SHORT_ID_RE, nested } from '../index/indexQuery';
import { indexDefByCollection } from '../index/indexConfig';
import { linkForBookmark, type VisibleNav } from '../nav/navConfig';
import { operationLabel } from '../operationLabel';
import { indexRoute, recordRoute } from '../recordRoute';

// The Ctrl K finder's logic, kept free of Vue and of the host so it can be tested on its own.
// The overlay (a later task) does the fetching: it asks visibleSources() what to query, sends
// sourceParams() (pass 1: codes and names) and deepParams() (pass 2: notes, location, owner...) to
// the source's path, turns the rows into hits with toHits() and passes the lot to mergeHits()
// together with the local hits.

export type FinderGroup = 'Pages' | 'Saved views' | 'Samples' | 'Operations' | 'Tests' | 'Campaigns' | 'Projects' | 'People' | 'Inventory' | 'Reference' | 'Files';

export interface FinderHit {
	group: FinderGroup;
	label: string;
	detail?: string;
	to: string;
	rank: number;
	// The record behind a hit from a remote source (not Pages, not Saved views): lets a host pick it instead of opening it.
	record?: { collection: string; id: string };
	// A pass 2 hit (the words are in a field the label does not show): that field's name, e.g. "notes" or "owner".
	matchedIn?: string;
	// Where in the value it was found, for a field on the row itself (notes, location). Never set for a field read through a relation (project, owner):
	// the finder names that field and shows nothing of its value, so it cannot reveal a project code the user may not read.
	matchedSnippet?: string;
	// The "More in <Page>…" row that ends a group with hits left out. Not a record: it opens that page searched for the query.
	more?: true;
}

export interface FinderSource {
	group: FinderHit['group'];
	collection: string;
	// What to ask Directus for: enough for label/detail/to (and short_id when shortId is set).
	fields: string[];
	// _icontains on each of these (pass 1).
	match: string[];
	// Pass 2: more fields a word may be found in, each with the name shown as "matched in <label>". A dotted field reads through a relation, but only one
	// whose records every reader may read: Directus joins the related table without its row rules, so a match in it could reveal a record the user may not
	// read (that is why a sample's project code is not here).
	deep?: Array<{ field: string; label: string }>;
	// The request path when it is not /items/<collection> (files have an endpoint of their own).
	path?: string;
	// Only asked about a query whose longest word has this many characters (an index on the field works on trigrams, which a word of 1 or 2 characters has none of).
	minWord?: number;
	// The collection has a short_id column: a hex input is also tried as an exact short id.
	shortId?: boolean;
	// Only the finder uses this source: a form's record picker keeps reading that collection by the field's own template.
	finderOnly?: boolean;
	label(row: any): string;
	detail?(row: any): string;
	to(row: any): string;
	// The record a row is, as collection and key.
	record(row: any): { collection: string; id: string };
}

// Below this a query is noise: nothing remote is asked and no local hit is offered.
export const MIN_QUERY = 2;

// Spec section 6: Pages and Saved views first, then the table's order.
const GROUP_ORDER: FinderGroup[] = ['Pages', 'Saved views', 'Samples', 'Operations', 'Tests', 'Campaigns', 'Projects', 'People', 'Inventory', 'Reference', 'Files'];
// Hits shown per remote group. One more is asked of the server, so a full group can tell it has more ("More in <Page>…").
const REMOTE_LIMIT = 5;
export const FETCH_LIMIT = REMOTE_LIMIT + 1;
// Pass 2 asks for more: rows pass 1 already shows are dropped from it, and must not use up its places.
const DEEP_LIMIT = 10;
// All remote groups together (Pages and Saved views excluded): the best ranked stay.
const RECORD_CAP = 12;
// A longer query is cut here: every word is one more clause in a GET url.
const MAX_WORDS = 6;
// ... and each word at this many characters, so a pasted block of text cannot overflow the request's header limit.
const MAX_WORD_LENGTH = 100;
// Pass 2 hits rank below every pass 1 hit.
export const DEEP_RANK = 4;
// Characters kept on each side of the word in a matched-in snippet.
const SNIPPET_CONTEXT = 30;
const LOCAL_GROUPS = new Set<FinderGroup>(['Pages', 'Saved views']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// An inventory code finds its row and opens the row's record page (tool boxes, cutting inserts, insert edges), or the index page with that row's drawer. The key comes
// from indexConfig so a renamed primary key cannot leave the finder behind.
function inventory(collection: string, codeField: string, kind: string, extra: string[] = []): FinderSource {
	const def = indexDefByCollection(collection);
	const pk = def?.primaryKey ?? `${collection}_id`;
	const rowTarget = def?.rowTarget;
	return {
		group: 'Inventory',
		collection,
		fields: [pk, codeField, ...extra],
		match: [codeField],
		label: (r) => str(r[codeField]) || String(r[pk]),
		// The code alone does not say what it is: a tool box and an insert edge look alike.
		detail: () => kind,
		to: (r) => (rowTarget === 'record' ? recordRoute(collection, String(r[pk])) : indexRoute(collection, { open: String(r[pk]) })),
		record: (r) => ({ collection, id: String(r[pk]) }),
	};
}

export const FINDER_SOURCES: FinderSource[] = [
	{
		group: 'Samples',
		collection: 'physical_samples',
		fields: ['sample_id', 'sample_code', 'nickname', 'short_id'],
		match: ['sample_code', 'nickname'],
		deep: [
			{ field: 'notes', label: 'notes' },
			{ field: 'legacy_notes', label: 'legacy notes' },
			{ field: 'location', label: 'location' },
			{ field: 'owner_person_id.full_name', label: 'owner' },
		],
		shortId: true,
		label: (r) => str(r.sample_code) || 'Sample',
		detail: (r) => str(r.nickname),
		to: (r) => recordRoute('physical_samples', r.sample_id),
		record: (r) => ({ collection: 'physical_samples', id: String(r.sample_id) }),
	},
	{
		group: 'Operations',
		collection: 'manufacturing_operations',
		// operationLabel falls back to the sample code and step when there is no pass code.
		fields: ['operation_id', 'pass_code', 'operation_sequence', 'sample_id.sample_code', 'short_id'],
		match: ['pass_code'],
		deep: [{ field: 'outcome_notes', label: 'outcome notes' }],
		shortId: true,
		label: (r) => operationLabel(r),
		to: (r) => recordRoute('manufacturing_operations', r.operation_id),
		record: (r) => ({ collection: 'manufacturing_operations', id: String(r.operation_id) }),
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
		record: (r) => ({ collection: 'test_sessions', id: String(r.session_id) }),
	},
	{
		group: 'Campaigns',
		collection: 'campaigns',
		fields: ['campaign_id', 'campaign_code', 'name'],
		match: ['campaign_code', 'name'],
		label: (r) => str(r.campaign_code) || str(r.name) || 'Campaign',
		detail: (r) => (str(r.campaign_code) ? str(r.name) : ''),
		to: (r) => recordRoute('campaigns', r.campaign_id),
		record: (r) => ({ collection: 'campaigns', id: String(r.campaign_id) }),
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
		record: (r) => ({ collection: 'projects', id: String(r.project_id) }),
	},
	{
		group: 'People',
		collection: 'people',
		fields: ['person_id', 'full_name'],
		match: ['full_name'],
		label: (r) => str(r.full_name) || 'Person',
		// The People page has no per-person route: it opens searched for the name.
		to: (r) => `/home/people?q=${encodeURIComponent(str(r.full_name))}`,
		record: (r) => ({ collection: 'people', id: String(r.person_id) }),
	},
	inventory('tools', 'tool_code', 'Tool'),
	inventory('tool_boxes', 'tool_box_code', 'Tool box'),
	inventory('cutting_inserts', 'insert_code', 'Cutting insert'),
	inventory('insert_edges', 'edge_code', 'Insert edge'),
	inventory('raw_stock_lots', 'lot_code', 'Raw stock lot'),
	// Equipment is found by its name as well as its code (codes are slugs of the name, so people type the name).
	{
		...inventory('equipment', 'equipment_code', 'Equipment', ['equipment_name']),
		match: ['equipment_code', 'equipment_name'],
		deep: [{ field: 'notes', label: 'notes' }, { field: 'location', label: 'location' }],
		label: (r) => str(r.equipment_name) || str(r.equipment_code),
	},
	// Materials open the Materials page's drawer (rowTarget in indexConfig), found by alloy code or common name.
	{
		...inventory('materials', 'alloy_code', 'Material', ['common_name']),
		group: 'Reference',
		finderOnly: true,
		match: ['alloy_code', 'common_name'],
		label: (r) => str(r.alloy_code) || str(r.common_name) || 'Material',
		detail: (r) => (str(r.alloy_code) ? str(r.common_name) : ''),
	},
	// Files and SEM images, through /files: whatever Directus lets this user read (since migration 196 an owned file is owner-only), with no rule of the
	// finder's own. The share path is not matched: it is not a column (directus_files keeps it in the metadata JSON as archive_path, which a filter cannot reach).
	// The owner is not shown either: owner_person_id has a foreign key but no Directus relation, so owner_person_id.full_name is not a field /files can read.
	{
		group: 'Files',
		collection: 'directus_files',
		path: '/files',
		finderOnly: true,
		// migration 201: trigram indexes on lower(filename_download) and lower(title), which a word under 3 characters cannot use (it would scan every file).
		minWord: 3,
		fields: ['id', 'filename_download', 'title', 'type'],
		match: ['filename_download', 'title'],
		label: (r) => str(r.filename_download) || str(r.title) || 'File',
		detail: (r) => str(r.type),
		// Directus's own file page (the Inbox has no page per file).
		to: (r) => `/files/${encodeURIComponent(String(r.id))}`,
		record: (r) => ({ collection: 'directus_files', id: String(r.id) }),
	},
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

// Directus reads a few whole values as something else before they reach a filter (true, false and null become a boolean or null; $NOW, $CURRENT_USER and
// the like are variables), which breaks the _icontains of the whole request. _icontains ignores case, so a capital letter makes the word an ordinary string,
// and a leading $ is dropped. Only words that were already broken change.
function safeWord(word: string): string {
	const w = word.replace(/^\$+/, '').slice(0, MAX_WORD_LENGTH);
	return /^(true|false|null)$/i.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
}

// The words of a query: split on whitespace. A row must match each of them, a word in any of the fields.
export function queryWords(q: string): string[] {
	return q.trim().split(/\s+/).map(safeWord).filter(Boolean).slice(0, MAX_WORDS);
}

// Whether a source is worth asking about this query (see FinderSource.minWord).
export function askable(src: FinderSource, q: string): boolean {
	const min = src.minWord;
	return !min || queryWords(q).some((w) => w.length >= min);
}

// One word in any of the fields. A hex word is also tried as an exact short id when the source has them (and the caller asks for it).
function wordClause(src: FinderSource, word: string, fields: string[], withShortId: boolean): Record<string, unknown> {
	const or: unknown[] = fields.map((field) => nested(field, { _icontains: word }));
	if (withShortId && src.shortId && SHORT_ID_RE.test(word)) or.push({ short_id: { _eq: word.toLowerCase() } });
	return { _or: or };
}

// The one clause of a one-word query (exactly the filter it has always built), an _and of them for several words.
function wordsFilter(src: FinderSource, q: string, fields: string[], withShortId: boolean): Record<string, unknown> {
	const words = queryWords(q);
	const clauses = (words.length ? words : [q.trim().slice(0, MAX_WORD_LENGTH)]).map((w) => wordClause(src, w, fields, withShortId));
	return clauses.length === 1 ? clauses[0] : { _and: clauses };
}

// Pass 1: params for GET <path>, in the shapes indexQuery uses (fields as an array, filter as a JSON string).
export function sourceParams(src: FinderSource, q: string): Record<string, unknown> {
	return { fields: src.fields, filter: JSON.stringify(wordsFilter(src, q, src.match, true)), limit: FETCH_LIMIT };
}

// Pass 2: the notes/location/owner fields, or null for a source that has none. One word is looked for in those fields only (pass 1 has the rest);
// several may be spread over both kinds of field, so then the code and name fields are searched too.
export function deepParams(src: FinderSource, q: string): Record<string, unknown> | null {
	if (!src.deep?.length) return null;
	const multi = queryWords(q).length > 1;
	const deepFields = src.deep.map((d) => d.field);
	const fields = multi ? [...src.match, ...deepFields] : deepFields;
	return {
		fields: [...new Set([...src.fields, ...deepFields])],
		filter: JSON.stringify(wordsFilter(src, q, fields, multi)),
		limit: DEEP_LIMIT,
	};
}

// 0 exact short id, 1 exact code, 2 prefix, 3 contains (or matched on a field the label does not show; pass 2 hits are ranked 4 by toHits).
export function rankHit(q: string, label: string, exactShortId: boolean): number {
	if (exactShortId) return 0;
	const needle = q.trim().toLowerCase();
	const text = label.trim().toLowerCase();
	if (text === needle) return 1;
	if (text.startsWith(needle)) return 2;
	return 3;
}

function valueAt(row: any, path: string): string {
	let v: any = row;
	for (const key of path.split('.')) v = v?.[key];
	return typeof v === 'string' ? v.toLowerCase() : '';
}

// Would pass 1 have found this row: every word in a code/name field (or the word is the row's exact short id)?
function foundByPass1(src: FinderSource, row: any, words: string[]): boolean {
	return words.every((w) => src.match.some((f) => valueAt(row, f).includes(w)) || (!!src.shortId && SHORT_ID_RE.test(w) && str(row.short_id).toLowerCase() === w));
}

// The first pass 2 field that holds one of the words: what the row is "matched in", and a short piece of the value around the word when the field is
// the row's own (a dotted field is another record's, and only its name is given).
function matchedIn(src: FinderSource, row: any, words: string[]): { label: string; snippet?: string } | undefined {
	for (const d of src.deep ?? []) {
		const value = valueAt(row, d.field);
		const word = words.find((w) => value.includes(w));
		if (word === undefined) continue;
		if (d.field.includes('.')) return { label: d.label };
		const at = value.indexOf(word);
		const from = Math.max(0, at - SNIPPET_CONTEXT);
		const to = Math.min(value.length, at + word.length + SNIPPET_CONTEXT);
		return { label: d.label, snippet: `${from > 0 ? '…' : ''}${(row[d.field] as string).slice(from, to)}${to < value.length ? '…' : ''}` };
	}
	return undefined;
}

// Rows from one source as hits. An exact short-id match is read off the row's own short_id. Rows that answer deepParams (pass 2) rank 4 and say what
// they matched in; one that pass 1 would have found anyway is left to pass 1.
export function toHits(src: FinderSource, q: string, rows: any[], pass: 1 | 2 = 1): FinderHit[] {
	const needle = q.trim().toLowerCase();
	const words = queryWords(q).map((w) => w.toLowerCase());
	return rows.flatMap((row) => {
		if (pass === 2 && foundByPass1(src, row, words)) return [];
		const label = src.label(row);
		const exactShortId = !!src.shortId && SHORT_ID_RE.test(needle) && str(row.short_id).toLowerCase() === needle;
		const hit: FinderHit = { group: src.group, label, to: src.to(row), rank: pass === 2 ? DEEP_RANK : rankHit(q, label, exactShortId), record: src.record(row) };
		const detail = src.detail?.(row);
		if (detail) hit.detail = detail;
		if (pass === 2) {
			const where = matchedIn(src, row, words);
			if (where) {
				hit.matchedIn = where.label;
				if (where.snippet) hit.matchedSnippet = where.snippet;
			}
		}
		return [hit];
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

// The page a "More in" row opens: the Explorer page searched for the query (?q=, the index page's own search). The People page reads ?q= too, Projects
// has no search to give, and files have Directus's own list.
function moreTarget(collection: string, q: string): { title: string; to: string } {
	const text = q.trim();
	if (collection === 'people') return { title: 'People', to: `/home/people?q=${encodeURIComponent(text)}` };
	if (collection === 'directus_files') return { title: 'Files', to: '/files' };
	const title = indexDefByCollection(collection)?.title ?? (collection === 'projects' ? 'Projects' : collection);
	return { title, to: indexRoute(collection, { query: { q: text } }) };
}

// The same record found twice (pass 1 and pass 2, or two answers racing) counts once, at its best rank.
function dedupe(hits: FinderHit[]): FinderHit[] {
	const key = (h: FinderHit) => (h.record ? `${h.record.collection}:${h.record.id}` : null);
	const best = new Map<string, FinderHit>();
	for (const h of hits) {
		const k = key(h);
		if (k === null) continue;
		const seen = best.get(k);
		if (!seen || h.rank < seen.rank) best.set(k, h);
	}
	return hits.filter((h) => {
		const k = key(h);
		return k === null || best.get(k) === h;
	});
}

// Groups in spec order, best rank first inside each (ties keep their arrival order). A remote group shows at most 5 hits (Inventory is six sources but
// one group), all remote groups together at most 12: the best ranked stay, kept in group order (a tie goes to the earlier group). A group that lost hits
// ends with a "More in <Page>…" row for the page that lost the most (a group left with no hit shown keeps just that row); those rows are not counted in the
// 12. The Explorer page searches one phrase in its code and name fields, so the row is only offered for a one-word query and for pass 1 hits that were left
// out: it would find nothing for the others.
export function mergeHits(q: string, groups: FinderHit[][]): FinderHit[] {
	if (!isSearchable(q)) return [];
	const all = dedupe(groups.flat());
	const out: FinderHit[] = [];
	const remote: Array<{ group: FinderGroup; shown: FinderHit[]; lost: FinderHit[] }> = [];
	for (const group of GROUP_ORDER) {
		const inGroup = all.filter((h) => h.group === group).sort((a, b) => a.rank - b.rank);
		if (LOCAL_GROUPS.has(group)) out.push(...inGroup);
		else remote.push({ group, shown: inGroup.slice(0, REMOTE_LIMIT), lost: inGroup.slice(REMOTE_LIMIT) });
	}
	if (remote.reduce((n, r) => n + r.shown.length, 0) > RECORD_CAP) {
		// The sort is stable over group order then rank order, so a tie goes to the earlier group.
		const best = new Set(remote.flatMap((r) => r.shown).sort((a, b) => a.rank - b.rank).slice(0, RECORD_CAP));
		for (const r of remote) {
			r.lost.push(...r.shown.filter((h) => !best.has(h)));
			r.shown = r.shown.filter((h) => best.has(h));
		}
	}
	const single = queryWords(q).length === 1;
	for (const { group, shown, lost } of remote) {
		out.push(...shown);
		const counts = new Map<string, number>();
		for (const h of single ? lost : []) if (h.record && h.rank < DEEP_RANK) counts.set(h.record.collection, (counts.get(h.record.collection) ?? 0) + 1);
		const [collection] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
		if (collection) {
			const target = moreTarget(collection, q);
			out.push({ group, label: `More in ${target.title}…`, to: target.to, rank: Number.POSITIVE_INFINITY, more: true });
		}
	}
	return out;
}
