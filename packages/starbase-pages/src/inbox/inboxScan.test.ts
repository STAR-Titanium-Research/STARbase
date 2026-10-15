import { describe, expect, it } from 'vitest';
import { InboxApiError } from './inboxApi';
import { foundFile } from './fakeInboxServer';
import {
	CONDITION_LABEL, CONDITION_NOTE_MAX, NOTES_MAX, SCAN_ALREADY_TEXT, SCAN_ITEM_CHOICES, SCAN_CONDITIONS, VISIBILITY_WARNING, emptyScanAdd, isAddedScan, scanAddProblems, scanAddedText,
	scanErrorText, scanItemSearchParams, scanLinkItem, scanTarget, suggestedScanItem, toScanItemOption, type ScanItemOption,
} from './inboxScan';

const INSERT = '00000000-0000-4000-8000-000000000201';
const EDGE = '00000000-0000-4000-8000-000000000202';
const OP = '00000000-0000-4000-8000-000000000102';
const file = foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/H13A-2_fC_worn.al3d' });
const insert: ScanItemOption = { kind: 'insert', id: INSERT, label: 'H13A-#2', detail: '' };
const edge: ScanItemOption = { kind: 'edge', id: EDGE, label: 'H13A-#2-fC', detail: 'Insert H13A-#2' };

describe('the words are the Alicona dialog\'s own', () => {
	it('the four conditions and their labels, and the lab-wide warning, are reused, not copied', () => {
		expect([...SCAN_CONDITIONS]).toEqual(['new', 'worn', 'cleaned', 'other']);
		expect(SCAN_CONDITIONS.map((c) => CONDITION_LABEL[c])).toEqual(['New', 'Worn', 'Cleaned', 'Other']);
		expect(VISIBILITY_WARNING).toContain('Adding a surface scan makes this file visible to every lab member');
		expect(SCAN_ITEM_CHOICES).toEqual([{ value: 'insert', label: 'Insert' }, { value: 'edge', label: 'Edge' }]);
	});
});

describe('the insert or edge picker', () => {
	it('searches an insert by its code and an edge by its code, as the signed-in user, a few at a time', () => {
		expect(scanItemSearchParams('insert', ' H13 ')).toEqual({ fields: ['insert_id', 'insert_code'], filter: JSON.stringify({ insert_code: { _icontains: 'H13' } }), sort: ['insert_code'], limit: 8 });
		expect(scanItemSearchParams('edge', 'fC')).toEqual({ fields: ['edge_id', 'edge_code', 'insert_id.insert_code'], filter: JSON.stringify({ edge_code: { _icontains: 'fC' } }), sort: ['edge_code'], limit: 8 });
	});

	it('reads a row: the code is the label, an edge names its insert, a row with no id is nothing', () => {
		expect(toScanItemOption('insert', { insert_id: INSERT, insert_code: 'H13A-#2' })).toEqual(insert);
		expect(toScanItemOption('edge', { edge_id: EDGE, edge_code: 'H13A-#2-fC', insert_id: { insert_code: 'H13A-#2' } })).toEqual(edge);
		expect(toScanItemOption('edge', { edge_id: EDGE, edge_code: '', insert_id: null })).toEqual({ kind: 'edge', id: EDGE, label: 'Edge', detail: '' });
		expect(toScanItemOption('insert', { insert_code: 'x' })).toBeNull();
	});

	it('a path that names an insert or an edge starts with it chosen; a sample is no item for a scan', () => {
		expect(suggestedScanItem({ suggested_collection: 'insert_edges', suggested_record_id: EDGE, suggested_label: 'H13A-#2-fC' })).toEqual({ kind: 'edge', id: EDGE, label: 'H13A-#2-fC', detail: '' });
		expect(suggestedScanItem({ suggested_collection: 'cutting_inserts', suggested_record_id: INSERT, suggested_label: null })).toMatchObject({ kind: 'insert', label: 'Insert' });
		expect(suggestedScanItem({ suggested_collection: 'physical_samples', suggested_record_id: INSERT, suggested_label: 'S-1' })).toBeNull();
		expect(suggestedScanItem({ suggested_collection: null, suggested_record_id: null, suggested_label: null })).toBeNull();
	});
});

describe('the form', () => {
	it('starts with no condition chosen (the crawler never guesses it)', () => {
		expect(emptyScanAdd().condition).toBeNull();
		expect(emptyScanAdd(insert).item).toEqual(insert);
	});

	it('cannot be sent without an item and a condition, and says what is missing in the order it is filled in', () => {
		expect(scanAddProblems(emptyScanAdd(), file)).toEqual(['Choose the insert or edge the surface scan belongs to.', 'Choose the condition.']);
		expect(scanAddProblems({ ...emptyScanAdd(insert) }, file)).toEqual(['Choose the condition.']);
		expect(scanAddProblems({ ...emptyScanAdd(), condition: 'worn' }, file)).toEqual(['Choose the insert or edge the surface scan belongs to.']);
		expect(scanAddProblems({ ...emptyScanAdd(insert), condition: 'worn' }, file)).toEqual([]);
	});

	it('uses the Alicona dialog\'s rules: "other" needs a note, a date is a day and not in the future', () => {
		expect(scanAddProblems({ ...emptyScanAdd(insert), condition: 'other' }, file)).toEqual(['Say in the note what the condition is.']);
		expect(scanAddProblems({ ...emptyScanAdd(insert), condition: 'other', conditionNote: 'chipped' }, file)).toEqual([]);
		expect(scanAddProblems({ ...emptyScanAdd(insert), condition: 'new', date: '2026-10-16' }, file, '2026-10-15')).toEqual(['The scan date cannot be in the future.']);
		expect(scanAddProblems({ ...emptyScanAdd(insert), condition: 'new', date: '15/10/2026' }, file, '2026-10-15')).toEqual(['The date is not a date.']);
		expect(scanAddProblems({ ...emptyScanAdd(insert), condition: 'new', date: '2026-10-15' }, file, '2026-10-15')).toEqual([]);
	});

	it('bounds the notes as the endpoint does', () => {
		const ok = { ...emptyScanAdd(insert), condition: 'worn' as const };
		expect(scanAddProblems({ ...ok, conditionNote: 'x'.repeat(CONDITION_NOTE_MAX) }, file)).toEqual([]);
		expect(scanAddProblems({ ...ok, conditionNote: 'x'.repeat(CONDITION_NOTE_MAX + 1) }, file)).toEqual([`The condition note is too long (${CONDITION_NOTE_MAX} characters at most).`]);
		expect(scanAddProblems({ ...ok, notes: 'x'.repeat(NOTES_MAX + 1) }, file)).toEqual([`The notes are too long (${NOTES_MAX} characters at most).`]);
	});
});

describe('the item POST /d1-inbox/link takes', () => {
	it('an insert and a condition, and nothing else the person did not set', () => {
		expect(scanLinkItem(file, { ...emptyScanAdd(insert), condition: 'worn' })).toEqual({ candidate_id: file.candidate_id, collection: 'surface_scans', insert_id: INSERT, condition: 'worn' });
	});

	it('an edge with every optional field, trimmed; never both insert_id and edge_id, and no record_id', () => {
		const item = scanLinkItem(file, { item: edge, condition: 'cleaned', operationId: OP, date: '2026-10-14', conditionNote: '  ultrasonic bath ', notes: ' after pass 3 ' });
		expect(item).toEqual({ candidate_id: file.candidate_id, collection: 'surface_scans', edge_id: EDGE, condition: 'cleaned', operation_id: OP, scanned_on: '2026-10-14', condition_note: 'ultrasonic bath', notes: 'after pass 3' });
		expect(item).not.toHaveProperty('insert_id');
		expect(item).not.toHaveProperty('record_id');
	});

	it('is null while the form cannot be sent (no item, no condition)', () => {
		expect(scanLinkItem(file, emptyScanAdd(insert))).toBeNull();
		expect(scanLinkItem(file, { ...emptyScanAdd(), condition: 'new' })).toBeNull();
	});
});

describe('every refusal has words, and none says a surface scan is linked or attached', () => {
	const err = (code: string, status: number, extensions: Record<string, unknown> = {}, message = 'server words') => new InboxApiError(message, { status, code, extensions: { ...extensions, code } });

	it.each([
		['FORBIDDEN', 403, 'You are not allowed to add surface scans.'],
		['READ_ONLY_ROLE', 403, 'Your role is read-only, so you cannot add surface scans.'],
		['ALREADY_ADDED', 409, 'That file is already added as a surface scan of this insert or edge.'],
		['SURFACE_SCANS_UNAVAILABLE', 409, 'Surface scans are not available yet.'],
		['NOT_A_SURFACE_SCAN', 409, 'Only a surface scan file can be added to an insert or an edge.'],
		['SURFACE_SCAN', 409, 'A surface scan is added to an insert or an edge.'],
		['NOT_NEW', 409, 'That file is no longer new. Restore it first if you dismissed it.'],
		['ALREADY_LINKED', 409, 'Someone already dealt with that file.'],
	])('%s (%i)', (code, status, text) => {
		expect(scanErrorText(err(code, status))).toEqual({ message: text, field: null });
	});

	it('NOT_FOUND names the insert, edge or operation only when the endpoint says it is a surface scan reference; for the file itself it says the file is not in the inbox', () => {
		const ref = 'That insert, edge or operation does not exist, or you cannot see it. Choose another.';
		// d1-inbox's scanRefMissing sends collection 'surface_scans'; notInInbox sends only the candidate id
		expect(scanErrorText(err('NOT_FOUND', 404, { collection: 'surface_scans', candidate_id: 'c1', record_id: 'i1' }))).toEqual({ message: ref, field: null });
		expect(scanErrorText(err('NOT_FOUND', 404, { candidate_id: 'c1' }, 'That file is not in your inbox.'))).toEqual({ message: 'That file is not in your inbox.', field: null });
		expect(scanErrorText(err('NOT_FOUND', 404))).toEqual({ message: 'That file is not in your inbox.', field: null });
		expect(scanErrorText(new InboxApiError('x', { status: 404, code: 'NOT_FOUND' }))).toEqual({ message: 'That file is not in your inbox.', field: null });
	});

	it.each([
		['condition', 'Choose the condition: new, worn, cleaned or other.'],
		['insert_id', 'Choose one insert or one edge for the surface scan, not both and not neither.'],
		['edge_id', 'Choose one insert or one edge for the surface scan, not both and not neither.'],
		['operation_id', 'That operation is not valid. Choose another operation, or none.'],
		['scanned_on', 'The scan date is not a valid day. Use the date box, or leave it empty.'],
		['condition_note', `The condition note is too long (${CONDITION_NOTE_MAX} characters at most).`],
		['notes', `The notes are too long (${NOTES_MAX} characters at most).`],
		['candidate_id', 'That file cannot be added as a surface scan.'],
	])('INVALID_PAYLOAD on %s names the control and says what is wrong', (field, text) => {
		expect(scanErrorText(err('INVALID_PAYLOAD', 400, { field }))).toEqual({ message: text, field });
	});

	it('an unknown field or code shows the endpoint\'s own words; a network error its own', () => {
		expect(scanErrorText(err('INVALID_PAYLOAD', 400, { field: 'nope' }, 'Something odd.'))).toEqual({ message: 'Something odd.', field: 'nope' });
		expect(scanErrorText(err('SOMETHING_NEW', 418, {}, 'Teapot.'))).toEqual({ message: 'Teapot.', field: null });
		expect(scanErrorText(new Error('Network down'))).toEqual({ message: 'Network down', field: null });
		expect(scanErrorText('x')).toEqual({ message: 'Could not add that surface scan.', field: null });
	});

	it('the glossary: nothing said about a surface scan uses "link" or "attach"', () => {
		const all = [
			SCAN_ALREADY_TEXT, scanAddedText('H13A-#2'),
			...['NOT_FOUND', 'FORBIDDEN', 'READ_ONLY_ROLE', 'ALREADY_ADDED', 'SURFACE_SCANS_UNAVAILABLE', 'NOT_A_SURFACE_SCAN', 'SURFACE_SCAN', 'NOT_NEW', 'ALREADY_LINKED'].map((c) => scanErrorText(err(c, 409)).message),
			...['condition', 'insert_id', 'edge_id', 'operation_id', 'scanned_on', 'condition_note', 'notes', 'candidate_id'].map((f) => scanErrorText(err('INVALID_PAYLOAD', 400, { field: f })).message),
		].join(' ');
		expect(all).not.toMatch(/\blink|attach/i);
		expect(scanAddedText('H13A-#2')).toBe('Added as a surface scan of H13A-#2. It is now visible to every lab member.');
		expect(SCAN_ALREADY_TEXT).toBe('That file was already added.');
	});
});

describe('a row added as a surface scan', () => {
	const added = { linked_collection: 'surface_scans', linked_insert_id: null, linked_edge_id: EDGE };

	it('is told from a linked row, and routes by the insert or edge the endpoint names', () => {
		expect(isAddedScan(added)).toBe(true);
		expect(isAddedScan({ linked_collection: 'physical_samples' })).toBe(false);
		expect(scanTarget(added)).toEqual({ collection: 'insert_edges', id: EDGE });
		expect(scanTarget({ ...added, linked_insert_id: INSERT, linked_edge_id: null })).toEqual({ collection: 'cutting_inserts', id: INSERT });
		expect(scanTarget({ linked_collection: 'surface_scans', linked_insert_id: null, linked_edge_id: null })).toBeNull();
		expect(scanTarget({ linked_collection: 'physical_samples', linked_insert_id: INSERT, linked_edge_id: null })).toBeNull();
	});
});
