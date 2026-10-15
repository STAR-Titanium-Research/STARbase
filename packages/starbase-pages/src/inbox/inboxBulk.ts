// What the Inbox does in bulk and says about it, as plain functions (no Vue, no network): Accept all (what it would link, the confirm), one
// Undo per batch, the rescan messages and the consent text of the auto-link switch. Split from inboxModel.ts, which has the rows.
import type { FilesQuery, FoundFile, LinkedItem, Skipped } from './inboxApi';
import { linkTarget, needsReadNotice, type InboxFilters } from './inboxModel';
import { isAddedScan } from './inboxScan';

/** What Accept all sends: the tab and the filters on screen, narrowed to exact short-ID matches (the endpoint links nothing else). */
export function acceptFilter(f: InboxFilters): FilesQuery {
	const q: FilesQuery = { tab: f.tab, strength: f.strength === 'any' ? 'short_id' : f.strength };
	if (f.kind !== 'any') q.kind = f.kind;
	if (f.folder) q.folder = f.folder;
	if (f.from) q.from = f.from;
	if (f.to) q.to = f.to;
	if (f.owner !== 'any') q.owner = f.owner;
	return q;
}

// ---- Accept all ----

/** Would Accept all link this file? The server decides; this is the page's estimate of it (decision D9: exact short ID, one record). */
export function isAcceptable(f: FoundFile): boolean {
	return (
		f.state === 'new' &&
		f.match_strength === 'short_id' &&
		!!f.suggested_record_id &&
		!!linkTarget(f.suggested_collection) &&
		f.kind !== 'surface_scan' &&
		// a copy of a file still in another Inbox is shown (marked), but Accept all leaves it (reason COPY)
		!f.duplicate_of &&
		f.suggested_can_edit !== false
	);
}

export interface AcceptPreview {
	/** How many of the files on screen Accept all would link (an estimate: the server's dry run, asked on click, is the count that counts). */
	count: number;
	/** Of those, documents and other files, each read once to fingerprint it. */
	reads: number;
	/** Every matching file is on screen, so `count` is the whole count and not just the first page's. */
	exact: boolean;
}

/** What Accept all would do with these rows; `loadedAll` says the rows are every file the filter matches. */
export function acceptPreview(rows: readonly FoundFile[], loadedAll = true): AcceptPreview {
	const acceptable = rows.filter(isAcceptable);
	return { count: acceptable.length, reads: acceptable.filter((f) => needsReadNotice(f.kind)).length, exact: loadedAll };
}

const files = (n: number) => `${n} found file${n === 1 ? '' : 's'}`;

/** What the confirm is about: the dry run's count, whether more files matched than one run takes, and whether documents may be among them. */
export interface AcceptPlan {
	count: number;
	hasMore: boolean;
	/** The filter can include documents or other files: linking reads each once to fingerprint it. */
	mayRead: boolean;
}

/** The confirm's text: names the count, what is linked, what is read and that it can be undone. */
export function acceptConfirmText(p: AcceptPlan): string {
	const reads = p.mayRead ? ' Any documents or other files among them are read once to fingerprint them.' : '';
	const more = p.hasMore ? ' More files match than one run takes: this links the first 500, and you can run it again afterwards.' : '';
	return `Link ${files(p.count)} to the record that ${p.count === 1 ? 'its' : 'each'} short ID names? Only exact short-ID matches to a record you can edit are linked.${reads}${more} You can undo the whole batch afterwards.`;
}

/** The kinds a filter can reach: does Accept all possibly read documents? (A kind filter on pictures cannot.) */
export const mayReadDocuments = (f: InboxFilters): boolean => f.kind === 'any' || f.kind === 'document' || f.kind === 'other';

const REASON_WORDS: Record<string, [string, string]> = {
	SURFACE_SCAN: ['surface scan (added one by one)', 'surface scans (added one by one)'],
	NOT_EDITABLE: ['file whose record you cannot edit', 'files whose record you cannot edit'],
	COPY: ['copy of another file', 'copies of other files'],
	ALREADY_ON_RECORD: ['file already on that record', 'files already on that record'],
	NOT_NEW: ['file that is no longer new', 'files that are no longer new'],
	NO_SUGGESTION: ['file with no record to link to', 'files with no record to link to'],
	COLLECTION_NOT_SUPPORTED: ['file for a kind of record that cannot be linked yet', 'files for a kind of record that cannot be linked yet'],
};

/** "Left for you to decide: 2 files whose record you cannot edit, 1 surface scan (added one by one)." null when nothing was left. */
export function skippedText(skipped: readonly Skipped[], total: number = skipped.length): string | null {
	if (!skipped.length) return null;
	const counts = new Map<string, number>();
	for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
	const parts = [...counts].map(([reason, n]) => {
		const words = REASON_WORDS[reason];
		const plain = reason.toLowerCase().replace(/_/g, ' ');
		return `${n} ${words ? words[n === 1 ? 0 : 1] : n === 1 ? `file (${plain})` : `files (${plain})`}`;
	});
	// the endpoint names at most 200 of the files it left (skipped_total says how many in all)
	const more = total > skipped.length ? ` ${total - skipped.length} more are not listed.` : '';
	return `Left for you to decide: ${parts.join(', ')}.${more}`;
}

export interface AcceptPair {
	file: string;
	record: string;
}

/**
 * "3fa9c1d2_A1.tif to S-0042": where the files go. A file the page cannot name (the dry run listed it, but it is not among the rows on screen)
 * is left out of the pairs, and `all` says whether none was. `names` finds a file's name and its suggested record by id (the rows on screen);
 * an item of the dry run may carry the record's label itself.
 */
export function acceptPairs(
	ids: readonly string[],
	items: readonly LinkedItem[],
	names: (candidateId: string) => { file: string; record: string | null } | null,
): { pairs: AcceptPair[]; all: boolean } {
	const pairs: AcceptPair[] = [];
	for (const id of ids) {
		const known = names(id);
		if (!known) continue;
		pairs.push({ file: known.file, record: items.find((i) => i.candidate_id === id)?.label ?? known.record ?? 'a record' });
	}
	return { pairs, all: pairs.length === ids.length };
}

/** The number is shown when it is the whole count; with more files than the page holds the button just says Accept all and the confirm counts. */
export const acceptButtonText = (p: AcceptPreview): string => (p.exact && p.count > 0 ? `Accept all (${p.count})` : 'Accept all');

/** "Linked 12 found files. 3 were left for you to decide." */
export function acceptResultText(linked: number, skipped: number): string {
	const left = skipped > 0 ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} left for you to decide.` : '';
	return `Linked ${files(linked)}.${left}`;
}

export function linkResultText(linked: number): string {
	return `Linked ${files(linked)}.`;
}

// ---- Undo: one per batch ----

export interface Batch {
	id: string;
	count: number;
	kind: 'manual' | 'bulk' | 'auto' | null;
	/** The newest decision time of the batch (ISO). */
	at: string | null;
	/** How many of its files were added as surface scans (the rest were linked to records). */
	scans: number;
}

/** The batches among linked rows, newest first. A row with no batch id (it cannot be undone as a batch) is not in any. */
export function batchesOf(rows: readonly FoundFile[]): Batch[] {
	const by = new Map<string, Batch>();
	for (const f of rows) {
		if (f.state !== 'linked' || !f.link_batch_id) continue;
		const b = by.get(f.link_batch_id) ?? { id: f.link_batch_id, count: 0, kind: f.link_kind, at: null, scans: 0 };
		b.count += 1;
		if (isAddedScan(f)) b.scans += 1;
		if (f.decided_at && (!b.at || f.decided_at > b.at)) b.at = f.decided_at;
		by.set(f.link_batch_id, b);
	}
	return [...by.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

export const BATCH_KIND_TEXT: Record<'manual' | 'bulk' | 'auto', string> = { manual: 'Linked by you', bulk: 'Accepted in bulk', auto: 'Linked automatically' };

export function batchTitle(b: Batch): string {
	const n = `${b.count} file${b.count === 1 ? '' : 's'}`;
	// a surface scan is added, never linked: a batch of scans says so, and a mixed batch says how many
	if (b.scans > 0 && b.scans === b.count) return `Added as ${b.count === 1 ? 'a surface scan' : 'surface scans'}, ${n}`;
	const how = b.kind ? BATCH_KIND_TEXT[b.kind] : 'Linked';
	return b.scans > 0 ? `${how}, ${n} (${b.scans} added as ${b.scans === 1 ? 'a surface scan' : 'surface scans'})` : `${how}, ${n}`;
}

export interface LinkedGroup {
	/** The batch the rows were linked in, with its one Undo; null for rows that carry no batch id (they cannot be undone as a batch). */
	batch: Batch | null;
	rows: FoundFile[];
}

/** The Recently linked rows, one group per batch (newest first, each with its one Undo), then the rows with no batch. */
export function groupLinked(rows: readonly FoundFile[]): LinkedGroup[] {
	const groups: LinkedGroup[] = batchesOf(rows).map((b) => ({ batch: b, rows: rows.filter((f) => f.link_batch_id === b.id && f.state === 'linked') }));
	const loose = rows.filter((f) => !f.link_batch_id || f.state !== 'linked');
	return loose.length ? [...groups, { batch: null, rows: loose }] : groups;
}

export function undoResultText(undone: number): string {
	return `Undone: ${undone} found file${undone === 1 ? '' : 's'} back in your Inbox.`;
}

// ---- rescan ----

export const RESCAN_QUEUED_TEXT = 'Rescan requested. New files appear here within a few minutes.';

/**
 * The 429 message. The endpoint answers 429 both inside the 10-minute limit and when a scan of the folder is already queued or running
 * (coordinator note, stream A review), so the message says both. It may say when to ask again (seconds); without it the rule is said.
 */
export function rateLimitMessage(retryAfterSeconds?: number | null): string {
	const base = 'A scan of your folder is already queued or ran recently. A folder can be rescanned once every 10 minutes.';
	if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
		const m = Math.ceil(retryAfterSeconds / 60);
		return `${base} Try again in ${m} minute${m === 1 ? '' : 's'}.`;
	}
	return `${base} Try again in a few minutes.`;
}

// ---- the auto-link switch ----

export const AUTO_LINK_TITLE = 'Link new pictures for me';

/** What the switch does, said before it is turned on (decision D10). Each entry is one short paragraph. */
export const AUTO_LINK_CONSENT: readonly string[] = [
	'When this is on, a new image in your personal folder is linked for you as soon as it is found, if its file name or path carries the short ID of exactly one record that you can edit.',
	'Documents are never linked automatically. Surface scans, files with no short ID, files that name a record only by its code and files that match more than one record stay in your Inbox for you to decide.',
	'Team folders are never linked automatically.',
	'Every automatic link is listed under "Recently auto-linked" on this page and in the Recently linked tab of your Inbox, and you can undo it there. Nothing on the share is ever changed.',
];

export const AUTO_LINK_OFF_NOTE = 'Off. New files wait in your Inbox until you link them.';
export const AUTO_LINK_ON_NOTE = 'On. New pictures that name one of your records by short ID are linked for you.';

// ---- the Inbox page's lead line ----

/** The line under the heading when a person has no folder at all: nothing will ever arrive until an administrator sets one. */
export const NO_FOLDER_TEXT = 'No folder on the share is connected to you yet. An administrator sets your uni alias on the People page (and a share folder on a team).';
