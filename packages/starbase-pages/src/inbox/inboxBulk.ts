// What the Inbox does in bulk and says about it, as plain functions (no Vue, no network): Accept all (what it would link, the confirm), one
// Undo per batch, the rescan messages and the consent text of the auto-link switch. Split from inboxModel.ts, which has the rows.
import type { FilesQuery, FoundFile } from './inboxApi';
import { linkTarget, needsReadNotice, type InboxFilters } from './inboxModel';

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
		f.suggested_can_edit !== false
	);
}

export interface AcceptPreview {
	count: number;
	/** Of those, documents and other files, each read once to fingerprint it. */
	reads: number;
}

/** What Accept all would do with these rows. A server count over the whole filter (meta.acceptable) wins over the rows on screen. */
export function acceptPreview(rows: readonly FoundFile[], serverCount: number | null = null): AcceptPreview {
	const acceptable = rows.filter(isAcceptable);
	return { count: serverCount ?? acceptable.length, reads: acceptable.filter((f) => needsReadNotice(f.kind)).length };
}

const files = (n: number) => `${n} found file${n === 1 ? '' : 's'}`;

/** The confirm's text: names the count, what is linked and that it can be undone. */
export function acceptConfirmText(p: AcceptPreview): string {
	const reads = p.reads > 0 ? ` Linking ${p.reads === 1 ? 'one of them reads it' : `${p.reads} of them reads each`} once to fingerprint it.` : '';
	return `Link ${files(p.count)} to the record that ${p.count === 1 ? 'its' : 'each'} short ID names? Only exact short-ID matches to a record you can edit are linked.${reads} You can undo the whole batch afterwards.`;
}

export const acceptButtonText = (p: AcceptPreview): string => (p.count > 0 ? `Accept all (${p.count})` : 'Accept all');

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
}

/** The batches among linked rows, newest first. A row with no batch id (it cannot be undone as a batch) is not in any. */
export function batchesOf(rows: readonly FoundFile[]): Batch[] {
	const by = new Map<string, Batch>();
	for (const f of rows) {
		if (f.state !== 'linked' || !f.link_batch_id) continue;
		const b = by.get(f.link_batch_id) ?? { id: f.link_batch_id, count: 0, kind: f.link_kind, at: null };
		b.count += 1;
		if (f.decided_at && (!b.at || f.decided_at > b.at)) b.at = f.decided_at;
		by.set(f.link_batch_id, b);
	}
	return [...by.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

export const BATCH_KIND_TEXT: Record<'manual' | 'bulk' | 'auto', string> = { manual: 'Linked by you', bulk: 'Accepted in bulk', auto: 'Linked automatically' };

export function batchTitle(b: Batch): string {
	const how = b.kind ? BATCH_KIND_TEXT[b.kind] : 'Linked';
	return `${how}, ${b.count} file${b.count === 1 ? '' : 's'}`;
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
