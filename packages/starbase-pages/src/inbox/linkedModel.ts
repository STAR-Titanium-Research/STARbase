// What a found file that is linked says about its link, as plain functions (no Vue, no network): the Link card's words and where it goes, whether the link can
// be changed or undone safely, and the strip of the other pictures on the same record. Spec: docs/superpowers/specs/2026-10-20-inbox-file-viewer-design.md,
// extended by the maintainer's choice of the "Link card" (A) and the "Linked record strip with siblings" (C).
import { formatDate, recordRoute } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { ADDED_SCAN_LEAD, isAddedScan, scanTarget } from './inboxScan';
import { linkTarget } from './inboxModel';

/** How many other pictures the strip shows; the rest are counted ("+5"). The siblings call asks for exactly this many. */
export const SIBLINGS_SHOWN = 6;

const HOW: Record<'manual' | 'bulk' | 'auto', string> = { manual: 'manually', bulk: 'accepted in bulk', auto: 'automatically' };

export interface LinkCardView {
	/** "Linked to", or "Added as a surface scan of": the words before the record's code. */
	lead: string;
	/** The record's code ("S-0042"), or null when the caller may not read the record (nothing is named then). */
	code: string | null;
	/** The words under the code: "Ti-6Al-4V fatigue bar · by Alice A · manually · 22 Oct 2026". */
	meta: string;
	/** Where the record's page is, null when it is not named. */
	route: string | null;
	/** "Open sample", "Open operation", "Open test", "Open insert" or "Open edge". */
	openLabel: string;
	/** A surface scan was ADDED, not linked: there is no other record to change it to, and no siblings. */
	scan: boolean;
	/** How many files Undo would put back (the link batch). 1 when the server does not say. */
	batch: number;
}

/** The record's own noun: "sample", "operation", "test", "insert" or "edge"; "record" when the page does not know the collection. */
function nounOf(file: FoundFile): string {
	if (isAddedScan(file)) return scanTarget(file)?.collection === 'insert_edges' ? 'edge' : 'insert';
	return linkTarget(file.linked_collection)?.noun ?? 'record';
}

/** The Link card of a file, or null when it is not linked (an unlinked file shows nothing). */
export function linkCardView(file: FoundFile): LinkCardView | null {
	if (file.state !== 'linked') return null;
	const scan = isAddedScan(file);
	const target = scan ? scanTarget(file) : file.linked_collection && file.linked_record_id ? { collection: file.linked_collection, id: file.linked_record_id } : null;
	const noun = nounOf(file);
	const pieces = [
		file.linked_title,
		file.decided_by_name ? `by ${file.decided_by_name}` : null,
		file.link_kind ? HOW[file.link_kind] : null,
		file.decided_at ? formatDate(file.decided_at) : null,
	].filter((p): p is string => !!p);
	return {
		lead: scan ? `${ADDED_SCAN_LEAD} of` : 'Linked to',
		code: file.linked_label ?? null,
		meta: pieces.join(' · '),
		route: target ? recordRoute(target.collection, target.id) : null,
		openLabel: `Open ${noun}`,
		scan,
		batch: Math.max(1, file.link_batch_size ?? 1),
	};
}

/** Why Change… is not offered, or null when it is: it is an undo followed by a new link, and an undo takes the whole batch with it. */
export function changeBlocked(view: LinkCardView): string | null {
	if (view.scan) return 'A surface scan was added to an insert or an edge, not linked to a record. Undo it to add it again.';
	return view.batch > 1 ? `This file was linked together with ${view.batch - 1} other${view.batch === 2 ? '' : 's'}. Undo that link first to link this one elsewhere.` : null;
}

/** The sentence of the Undo confirm: the file goes back to the Inbox, and so does every other file of its batch. */
export function undoConfirmText(view: LinkCardView): string {
	if (view.batch > 1) return `This undoes the link of all ${view.batch} files linked together. They go back to your Inbox.`;
	return 'The file goes back to your Inbox.';
}

/** The refusal text when Change undid the old link but the new one was refused. */
export const CHANGE_HALF_DONE = 'The old link was removed, but the new one could not be made';

export interface SiblingsView {
	/** The pictures the strip draws (the first SIBLINGS_SHOWN). */
	shown: FoundFile[];
	/** Pictures beyond the strip: "+5". */
	more: number;
	/** Every picture linked to the record, this one included: "12 images". */
	count: number;
	/** "12 images" / "2 images". */
	countText: string;
}

/** The strip: `rows` are the other pictures newest link first, `total` how many others there are in all (the server counts, the strip draws a few). */
export function siblingsView(rows: readonly FoundFile[], total: number): SiblingsView | null {
	const others = Math.max(total, rows.length);
	if (others === 0) return null;
	const shown = rows.slice(0, SIBLINGS_SHOWN);
	const count = others + 1;
	return { shown, more: Math.max(0, others - shown.length), count, countText: `${count} images` };
}

/** "3fa9c1d2_A3.tif, linked 14 Oct 2026": what a sibling's button says to a screen reader (its picture says nothing). */
export const siblingLabel = (file: FoundFile, name: string): string => (file.decided_at ? `${name}, linked ${formatDate(file.decided_at)}` : name);

/** Does this file have siblings to look for: a picture linked to a sample, operation or test (not a surface scan, not a document, not an unlinked file)? */
export const hasSiblings = (file: FoundFile): boolean =>
	file.state === 'linked' && (file.kind === 'sem_image' || file.kind === 'image') && !!file.linked_record_id && linkTarget(file.linked_collection) !== null;
