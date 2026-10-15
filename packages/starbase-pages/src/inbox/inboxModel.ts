// The Inbox page's rules as plain functions (no Vue, no network), so they are tested on their own: the tabs, the filters that live in the
// URL, how a file's suggestion reads ("short ID `3fa9c1d2` in the file name"), the match-strength labels, what Accept all would do, the
// words for the rate limit, the consent text of the auto-link switch, and the batches the Undo buttons work on.
//
// Words on screen (CONTEXT.md, Files on the share): found file, Inbox, link, "Older files" for the backlog, uni alias, share folder. A
// surface scan is "added", never "linked" or "attached".
import type { FileKind, FilesQuery, FoundFile, InboxTab, MatchStrength } from './inboxApi';
import { SCAN_ADD_LABEL } from './inboxScan';

// ---- tabs ----

export interface TabDef {
	id: InboxTab;
	label: string;
}

export const TABS: readonly TabDef[] = [
	{ id: 'new', label: 'New' },
	{ id: 'older', label: 'Older files' },
	{ id: 'linked', label: 'Recently linked' },
	{ id: 'dismissed', label: 'Dismissed' },
];

export const isTab = (v: unknown): v is InboxTab => TABS.some((t) => t.id === v);

/** What an empty tab says. */
export const EMPTY_TEXT: Record<InboxTab, string> = {
	new: 'Nothing new. Files you save in your folder on the share appear here after the next scan.',
	older: 'No older files match a record.',
	linked: 'Nothing linked yet.',
	dismissed: 'Nothing dismissed.',
};

// ---- kinds ----

/** The kinds drawn as rows; documents and anything else go under "Other files", collapsed. */
export const IMAGE_KINDS: readonly FileKind[] = ['sem_image', 'surface_scan', 'image'];
export const OTHER_KINDS: readonly FileKind[] = ['document', 'other'];
export const isOtherKind = (k: FileKind): boolean => OTHER_KINDS.includes(k);

/** Until the SEM tag is validated on real images (spec section 7) it is worded as a guess. */
export function kindLabel(kind: FileKind): string {
	switch (kind) {
		case 'sem_image': return 'Possible SEM image';
		case 'surface_scan': return 'Surface scan';
		case 'image': return 'Image';
		case 'document': return 'Document';
		default: return 'File';
	}
}

/**
 * No thumbnail in v1: a found file is a pointer row (storage 'star') whose bytes Directus cannot serve, and serving share bytes through
 * Directus is out of scope (spec section 13). Every row shows its kind's icon, and the page asks the asset route for nothing.
 */
export const hasThumbnail = (_kind: FileKind): boolean => false;

export const KIND_FILTER_ITEMS: ReadonlyArray<{ value: string; text: string }> = [
	{ value: 'any', text: 'Any kind' },
	{ value: 'sem_image', text: 'SEM images' },
	{ value: 'image', text: 'Other images' },
	{ value: 'surface_scan', text: 'Surface scans' },
	{ value: 'document', text: 'Documents' },
	{ value: 'other', text: 'Other files' },
];

// ---- match strength ----

export const STRENGTH_LABEL: Record<MatchStrength, string> = {
	short_id: 'Exact short ID',
	code: 'Record code',
	edge_code: 'Insert edge code (weaker)',
	none: 'No match',
};

/** "Exact match": the two strengths that name a record outright (what Home's "older files match a record" counts). */
export const EXACT_MATCH = 'short_id,code';

export const STRENGTH_FILTER_ITEMS: ReadonlyArray<{ value: string; text: string }> = [
	{ value: 'any', text: 'Any match' },
	{ value: EXACT_MATCH, text: 'Exact match' },
	{ value: 'short_id', text: STRENGTH_LABEL.short_id },
	{ value: 'code', text: STRENGTH_LABEL.code },
	{ value: 'edge_code', text: STRENGTH_LABEL.edge_code },
	{ value: 'none', text: STRENGTH_LABEL.none },
];

const STRENGTHS: readonly string[] = ['short_id', 'code', 'edge_code', 'none'];
const KINDS: readonly string[] = ['sem_image', 'surface_scan', 'image', 'document', 'other'];

// ---- the filters, in the URL ----

export interface InboxFilters {
	tab: InboxTab;
	/** 'any' or one kind. */
	kind: string;
	/** Text the folder part of the path contains. */
	folder: string;
	/** YYYY-MM-DD or ''. */
	from: string;
	to: string;
	/** 'any', 'me' (my personal folder) or 'team:<team_id>'. */
	owner: string;
	/** 'any', or a comma list of match strengths in the server's order ('short_id', 'short_id,code'). */
	strength: string;
}

export const DEFAULT_FILTERS: InboxFilters = { tab: 'new', kind: 'any', folder: '', from: '', to: '', owner: 'any', strength: 'any' };

const text = (v: unknown): string => {
	const one = Array.isArray(v) ? v[0] : v;
	return typeof one === 'string' ? one : '';
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string => {
	const t = text(v);
	return DAY.test(t) && !Number.isNaN(Date.parse(t)) ? t : '';
};

/** A comma list of strengths: the known ones once each, in the server's order; 'any' when none is known (or 'any' is in it with others). */
function strengthList(v: string): string {
	const asked = v.split(',').map((x) => x.trim());
	const known = STRENGTHS.filter((s) => asked.includes(s));
	return known.length ? known.join(',') : 'any';
}

/** The filters a URL query describes; anything unknown or malformed is the default. */
export function parseFilters(query: Record<string, unknown>): InboxFilters {
	const tab = text(query.tab);
	const kind = text(query.kind);
	const strength = text(query.strength);
	const owner = text(query.owner);
	return {
		tab: isTab(tab) ? tab : 'new',
		kind: KINDS.includes(kind) ? kind : 'any',
		folder: text(query.folder).trim(),
		from: day(query.from),
		to: day(query.to),
		owner: owner === 'me' || /^team:[0-9a-f-]{8,}$/i.test(owner) ? owner : 'any',
		strength: strengthList(strength),
	};
}

/** The URL query for the filters; defaults are left out, so the default view is {}. */
export function filtersToQuery(f: InboxFilters): Record<string, string> {
	const out: Record<string, string> = {};
	if (f.tab !== 'new') out.tab = f.tab;
	if (f.kind !== 'any') out.kind = f.kind;
	if (f.folder) out.folder = f.folder;
	if (f.from) out.from = f.from;
	if (f.to) out.to = f.to;
	if (f.owner !== 'any') out.owner = f.owner;
	if (f.strength !== 'any') out.strength = f.strength;
	return out;
}

/** Are any filters (not the tab) set? The page offers "Clear filters" then. */
export const hasActiveFilters = (f: InboxFilters): boolean =>
	f.kind !== 'any' || !!f.folder || !!f.from || !!f.to || f.owner !== 'any' || f.strength !== 'any';

/** What the page asks the server for: the picture rows and, apart, the Other files section. Null = no request for that part. */
export interface ListPlan {
	main: FilesQuery | null;
	other: FilesQuery | null;
	/** The kind filter names a kind of Other files: that section opens by itself. */
	openOther: boolean;
}

export const PAGE_SIZE = 50;

export function listPlan(f: InboxFilters, page = 0): ListPlan {
	const base: FilesQuery = { tab: f.tab, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
	if (f.folder) base.folder = f.folder;
	if (f.from) base.from = f.from;
	if (f.to) base.to = f.to;
	if (f.owner !== 'any') base.owner = f.owner;
	if (f.strength !== 'any') base.strength = f.strength;
	const kinds = f.kind === 'any' ? null : (f.kind as FileKind);
	const wantsOther = kinds !== null && isOtherKind(kinds);
	return {
		main: kinds === null ? { ...base, kind: IMAGE_KINDS.join(',') } : wantsOther ? null : { ...base, kind: kinds },
		other: kinds === null ? { ...base, kind: OTHER_KINDS.join(',') } : wantsOther ? { ...base, kind: kinds } : null,
		openOther: wantsOther,
	};
}

// ---- how a file reads ----

export const nameOf = (relPath: string): string => relPath.split('/').pop() || relPath;

export function folderOf(relPath: string): string {
	const i = relPath.lastIndexOf('/');
	return i < 0 ? '' : relPath.slice(0, i);
}

export function sizeText(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = bytes / 1024;
	let u = 0;
	while (v >= 1000 && u < units.length - 1) {
		v /= 1024;
		u += 1;
	}
	return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[u]}`;
}

/** What the crawler read from an SEM image, as one line: "15 kV · ×5,000 · 2 µm · JEOL". Only keys it actually found are shown. */
export function extractedText(extracted: Record<string, unknown>): string {
	const parts: string[] = [];
	const kv = extracted.kv ?? extracted.kV;
	if (typeof kv === 'number' || (typeof kv === 'string' && kv)) parts.push(`${kv} kV`);
	const mag = extracted.magnification;
	if (typeof mag === 'number' && Number.isFinite(mag)) parts.push(`×${mag.toLocaleString('en-GB')}`);
	else if (typeof mag === 'string' && mag) parts.push(mag.startsWith('×') || mag.toLowerCase().startsWith('x') ? mag : `×${mag}`);
	const bar = extracted.scale_bar;
	if (typeof bar === 'string' && bar) parts.push(bar);
	const inst = extracted.instrument;
	if (typeof inst === 'string' && inst) parts.push(inst);
	return parts.join(' · ');
}

/** The Inbox a file is in, for a row that is not in the caller's own: "Additive (team folder)". */
export const ownerText = (f: Pick<FoundFile, 'owner'>): string => (f.owner.kind === 'team' ? `${f.owner.name} (team folder)` : f.owner.name);

/**
 * "Copy of a file in Ann's Inbox": the same image in two Inboxes shows once (D11); the copy says so. The server names the owner only when the
 * original is in the caller's own folder or a team's (or the caller is an administrator): for anyone else it sends { kind: 'other' }, and the
 * words then name nobody.
 */
export function duplicateText(f: Pick<FoundFile, 'duplicate_of' | 'duplicate_of_owner'>): string | null {
	if (!f.duplicate_of) return null;
	const who = f.duplicate_of_owner;
	if (typeof who === 'string' && who) return `Copy of a file in ${who}'s Inbox`;
	if (who && typeof who === 'object') return 'Copy of a file someone else also has';
	return 'Copy of another found file';
}

// ---- suggestions ----

export interface LinkTarget {
	collection: string;
	/** "sample": how the picker and the buttons name the record. */
	noun: string;
	/** The field a code of this kind is in ("sample code"), for the suggestion text. */
	codeName: string;
	/** The fields the picker searches and shows (finder's sources use the same). */
	searchFields: string[];
	idField: string;
}

/** v1 link targets (plan B2): samples, operations and tests. */
export const LINK_TARGETS: readonly LinkTarget[] = [
	{ collection: 'physical_samples', noun: 'sample', codeName: 'sample code', searchFields: ['sample_code', 'nickname'], idField: 'sample_id' },
	{ collection: 'manufacturing_operations', noun: 'operation', codeName: 'operation code', searchFields: ['pass_code'], idField: 'operation_id' },
	{ collection: 'test_sessions', noun: 'test', codeName: 'test code', searchFields: ['test_code'], idField: 'session_id' },
];

export const linkTarget = (collection: string | null | undefined): LinkTarget | null => LINK_TARGETS.find((t) => t.collection === collection) ?? null;

/** Where in the path a token sits: the file's name, one of its folders, or (a case change aside) not at all. */
export function whereInPath(relPath: string, token: string): 'file name' | 'folder name' | 'path' {
	const t = token.toLowerCase();
	if (!t) return 'path';
	if (nameOf(relPath).toLowerCase().includes(t)) return 'file name';
	return folderOf(relPath).toLowerCase().includes(t) ? 'folder name' : 'path';
}

export interface Suggestion {
	/** "short ID `3fa9c1d2` in the file name" */
	text: string;
	/** The suggested record, named by the server ("S-0042"), or just its kind when the server did not resolve it. */
	record: string;
	/** A weaker kind of match (an insert edge code): shown muted, and never taken by Accept all. */
	weak: boolean;
	/** The link target this suggestion points at, when the page can link there. */
	target: LinkTarget | null;
}

/**
 * Why a file is suggested for a record, in a few words. Only a file that names exactly one record has a suggestion: two or more records
 * sharing a token are never flagged (decision D4), so such a file has none.
 */
export function suggestionOf(f: FoundFile): Suggestion | null {
	if (f.match_strength === 'none' || !f.suggested_collection || !f.suggested_record_id) return null;
	const m = f.matches.find((x) => x.record_id === f.suggested_record_id) ?? f.matches[0];
	const token = m?.token ?? '';
	const via = m?.via || f.match_strength;
	const target = linkTarget(f.suggested_collection);
	let what: string;
	if (via === 'short_id') what = 'short ID';
	else if (via === 'edge_code') what = 'insert edge code';
	else what = target?.codeName ?? 'record code';
	const place = token ? ` in the ${whereInPath(f.rel_path, token)}` : '';
	const quoted = token ? ` \`${token}\`` : '';
	const noun = target?.noun ?? (f.suggested_collection === 'insert_edges' ? 'insert edge' : 'record');
	return {
		text: `${what}${quoted}${place}`,
		record: f.suggested_label ?? `a ${noun}`,
		weak: f.match_strength === 'edge_code' || via === 'edge_code',
		target,
	};
}

// ---- the row's buttons ----

export const DOCUMENT_NOTICE = 'Linking reads this file once to fingerprint it.';

export type PrimaryAction =
	| { kind: 'link'; label: string }
	| { kind: 'pick'; label: string }
	/** A surface scan: opens its own form (inboxScan.ts), because it is ADDED to an insert or an edge with a condition the person chooses. */
	| { kind: 'scan'; label: string };

/**
 * The row's main button. A surface scan is ADDED through its own form (it is never sent to a sample, operation or test). A file with a
 * suggestion the page can link, and the caller may edit, links straight to it; any other file opens the record picker.
 */
export function primaryAction(f: FoundFile): PrimaryAction {
	if (f.kind === 'surface_scan') return { kind: 'scan', label: SCAN_ADD_LABEL };
	const s = suggestionOf(f);
	if (s?.target && f.suggested_can_edit !== false) return { kind: 'link', label: 'Link' };
	return { kind: 'pick', label: 'Link to…' };
}

/** "Change" (pick another record) is offered next to Link when there is a suggestion to change. */
export const canChange = (f: FoundFile): boolean => f.kind !== 'surface_scan' && primaryAction(f).kind === 'link';

/** The line under a document row's Link button: linking reads it once. */
export const needsReadNotice = (kind: FileKind): boolean => kind !== 'sem_image' && kind !== 'image' && kind !== 'surface_scan';
