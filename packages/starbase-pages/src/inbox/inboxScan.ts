// Adding a surface scan from the Inbox, as plain functions (no Vue, no network): the insert or edge a found file is added to, what the form must hold
// before it can be sent, the item POST /d1-inbox/link takes for it, the words of every refusal, and how a row added as a surface scan reads.
//
// Contract: spec 2026-10-15-found-files-inbox-design.md section 8 ("As built, stream F1") and core/extensions/d1-inbox/index.js (parseScanItem,
// linkedItemOut). A surface scan is ADDED to an insert or an edge, never "linked" or "attached" (CONTEXT.md, Files on the share); "Link" is for samples,
// operations and tests. The conditions, their labels, the validation and the lab-wide warning are the Alicona dialog's own
// (pages/surface/addScanModel.ts, scanModel.ts): one set of words for the same act.
import { formProblems, todayIso, type ScanForm } from '../pages/surface/addScanModel';
import type { ScanCondition } from '../pages/surface/scanModel';
import { InboxApiError, type FoundFile, type ScanLinkItem } from './inboxApi';

export { CONDITION_LABEL, SCAN_CONDITIONS } from '../pages/surface/scanModel';
export { VISIBILITY_WARNING } from '../pages/surface/addScanModel';

// ---- the insert or edge ----

export type ScanItemKind = 'insert' | 'edge';

export interface ScanItemDef {
	kind: ScanItemKind;
	collection: 'cutting_inserts' | 'insert_edges';
	/** "Insert", "Edge": the choice's label and how the picker names the item. */
	label: string;
	idField: 'insert_id' | 'edge_id';
	codeField: 'insert_code' | 'edge_code';
	fields: string[];
}

export const SCAN_ITEMS: readonly ScanItemDef[] = [
	{ kind: 'insert', collection: 'cutting_inserts', label: 'Insert', idField: 'insert_id', codeField: 'insert_code', fields: ['insert_id', 'insert_code'] },
	{ kind: 'edge', collection: 'insert_edges', label: 'Edge', idField: 'edge_id', codeField: 'edge_code', fields: ['edge_id', 'edge_code', 'insert_id.insert_code'] },
];

export const scanItemDef = (kind: ScanItemKind): ScanItemDef => SCAN_ITEMS.find((d) => d.kind === kind) ?? SCAN_ITEMS[0];
export const SCAN_ITEM_CHOICES = SCAN_ITEMS.map((d) => ({ value: d.kind, label: d.label }));

/** The insert or edge a scan is added to, as the picker offers it. */
export interface ScanItemOption {
	kind: ScanItemKind;
	id: string;
	/** "H13A-#2" (an insert's code) or "H13A-#2-fC" (an edge's). */
	label: string;
	/** An edge also names its insert. */
	detail: string;
}

export const SCAN_ITEM_LIMIT = 8;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Params for GET /items/<collection>: an insert or edge whose code contains the typed text (read as the signed-in user). */
export function scanItemSearchParams(kind: ScanItemKind, q: string): Record<string, unknown> {
	const def = scanItemDef(kind);
	return { fields: def.fields, filter: JSON.stringify({ [def.codeField]: { _icontains: q.trim() } }), sort: [def.codeField], limit: SCAN_ITEM_LIMIT };
}

export function toScanItemOption(kind: ScanItemKind, row: any): ScanItemOption | null {
	const def = scanItemDef(kind);
	const id = row?.[def.idField];
	if (typeof id !== 'string' || !id) return null;
	const insert = kind === 'edge' ? str(row?.insert_id?.insert_code) : '';
	return { kind, id, label: str(row?.[def.codeField]) || def.label, detail: insert ? `Insert ${insert}` : '' };
}

/**
 * A found file whose path names an insert or an edge (the crawler's suggestion) starts with that item chosen. The person still chooses the condition
 * and confirms; any other suggestion (a sample, an operation) is not an item a scan can be added to.
 */
export function suggestedScanItem(f: Pick<FoundFile, 'suggested_collection' | 'suggested_record_id' | 'suggested_label'>): ScanItemOption | null {
	const def = SCAN_ITEMS.find((d) => d.collection === f.suggested_collection);
	if (!def || !f.suggested_record_id) return null;
	return { kind: def.kind, id: f.suggested_record_id, label: f.suggested_label ?? def.label, detail: '' };
}

// ---- the form ----

export interface ScanAddForm {
	item: ScanItemOption | null;
	/** Required and never preset: the crawler does not guess it. */
	condition: ScanCondition | null;
	operationId: string | null;
	/** YYYY-MM-DD or ''. */
	date: string;
	conditionNote: string;
	notes: string;
}

export const emptyScanAdd = (item: ScanItemOption | null = null): ScanAddForm => ({ item, condition: null, operationId: null, date: '', conditionNote: '', notes: '' });

/** The server's limits (parseScanItem): a condition note of 500 characters and notes of 2000. */
export const CONDITION_NOTE_MAX = 500;
export const NOTES_MAX = 2000;

/** Why the form cannot be sent yet, in the order it is filled in; empty when it can. The condition, date and note rules are the Alicona dialog's. */
export function scanAddProblems(f: ScanAddForm, file: Pick<FoundFile, 'directus_files_id' | 'candidate_id' | 'rel_path'>, today: string = todayIso()): string[] {
	const out: string[] = [];
	if (!f.item) out.push('Choose the insert or edge the surface scan belongs to.');
	const shared: ScanForm = {
		file: { id: file.directus_files_id || file.candidate_id, name: file.rel_path.split('/').pop() || file.rel_path, path: null, size: null },
		condition: f.condition,
		note: f.conditionNote,
		date: f.date,
		operationId: f.operationId,
	};
	out.push(...formProblems(shared, today));
	if (f.conditionNote.trim().length > CONDITION_NOTE_MAX) out.push(`The condition note is too long (${CONDITION_NOTE_MAX} characters at most).`);
	if (f.notes.trim().length > NOTES_MAX) out.push(`The notes are too long (${NOTES_MAX} characters at most).`);
	return out;
}

/** The item POST /d1-inbox/link takes: only what the person set, trimmed; null while the form cannot be sent. */
export function scanLinkItem(file: Pick<FoundFile, 'candidate_id' | 'directus_files_id' | 'rel_path'>, f: ScanAddForm): ScanLinkItem | null {
	if (scanAddProblems(f, file).length > 0 || !f.item || !f.condition) return null;
	const item: ScanLinkItem = { candidate_id: file.candidate_id, collection: 'surface_scans', condition: f.condition };
	if (f.item.kind === 'edge') item.edge_id = f.item.id;
	else item.insert_id = f.item.id;
	if (f.operationId) item.operation_id = f.operationId;
	if (f.date) item.scanned_on = f.date;
	const cn = f.conditionNote.trim();
	if (cn) item.condition_note = cn;
	const n = f.notes.trim();
	if (n) item.notes = n;
	return item;
}

// ---- what is said ----

export const SCAN_ADD_LABEL = 'Add a surface scan';
/** The line under a surface scan row's button. */
export const SCAN_ROW_NOTICE = 'Added to an insert or an edge, with the condition you choose.';
export const SCAN_ALREADY_TEXT = 'That file was already added.';
/** What a link to a sample, operation or test would be for a surface scan: the page never sends it, this is the answer if it is asked for. */
export const SCAN_NOT_LINKED = 'A surface scan is added to an insert or an edge.';

export const scanAddedText = (label: string): string => `Added as a surface scan of ${label}. It is now visible to every lab member.`;

const FIELD_TEXT: Record<string, string> = {
	condition: 'Choose the condition: new, worn, cleaned or other.',
	insert_id: 'Choose one insert or one edge for the surface scan, not both and not neither.',
	edge_id: 'Choose one insert or one edge for the surface scan, not both and not neither.',
	operation_id: 'That operation is not valid. Choose another operation, or none.',
	scanned_on: 'The scan date is not a valid day. Use the date box, or leave it empty.',
	condition_note: `The condition note is too long (${CONDITION_NOTE_MAX} characters at most).`,
	notes: `The notes are too long (${NOTES_MAX} characters at most).`,
	candidate_id: 'That file cannot be added as a surface scan.',
};

/**
 * The words for a refused or failed add (every code F1's endpoint answers for it, plus the shared ones). `field` is the form control a 400 names, so
 * the dialog can mark it; null otherwise. A code this does not know shows the endpoint's own message.
 */
export function scanErrorText(e: unknown): { message: string; field: string | null } {
	if (!(e instanceof InboxApiError)) return { message: e instanceof Error && e.message ? e.message : 'Could not add that surface scan.', field: null };
	const field = typeof e.extensions?.field === 'string' ? e.extensions.field : null;
	const own = e.message || 'Could not add that surface scan.';
	switch (e.code) {
		case 'INVALID_PAYLOAD': return { message: (field && FIELD_TEXT[field]) || own, field };
		case 'NOT_FOUND': return { message: 'That insert, edge or operation does not exist, or you cannot see it. Choose another.', field: null };
		case 'FORBIDDEN': return { message: 'You are not allowed to add surface scans.', field: null };
		case 'READ_ONLY_ROLE': return { message: 'Your role is read-only, so you cannot add surface scans.', field: null };
		case 'ALREADY_ADDED': return { message: 'That file is already added as a surface scan of this insert or edge.', field: null };
		case 'SURFACE_SCANS_UNAVAILABLE': return { message: 'Surface scans are not available yet.', field: null };
		case 'NOT_A_SURFACE_SCAN': return { message: 'Only a surface scan file can be added to an insert or an edge.', field: null };
		case 'SURFACE_SCAN': return { message: SCAN_NOT_LINKED, field: null };
		case 'NOT_NEW': return { message: 'That file is no longer new. Restore it first if you dismissed it.', field: null };
		case 'ALREADY_LINKED': return { message: 'Someone already dealt with that file.', field: null };
		default: return { message: own, field: null };
	}
}

// ---- a row that was added as a surface scan (Recently linked) ----

export const SURFACE_SCANS = 'surface_scans';

/** Was this file added as a surface scan (rather than linked to a record)? */
export const isAddedScan = (f: Pick<FoundFile, 'linked_collection'>): boolean => f.linked_collection === SURFACE_SCANS;

/**
 * The page of the insert or edge a scan was added to. STARbase has no page of its own for a scan row, so a linked row routes by what the endpoint names
 * (linked_edge_id, linked_insert_id); an edge wins when both are somehow set.
 */
export function scanTarget(f: Pick<FoundFile, 'linked_collection' | 'linked_insert_id' | 'linked_edge_id'>): { collection: 'insert_edges' | 'cutting_inserts'; id: string } | null {
	if (!isAddedScan(f)) return null;
	if (f.linked_edge_id) return { collection: 'insert_edges', id: f.linked_edge_id };
	if (f.linked_insert_id) return { collection: 'cutting_inserts', id: f.linked_insert_id };
	return null;
}

/** "Added as a surface scan of H13A-#2 (worn)": the row's line on the Recently linked tab (the label is the server's); this is the part before " of". */
export const ADDED_SCAN_LEAD = 'Added as a surface scan';
