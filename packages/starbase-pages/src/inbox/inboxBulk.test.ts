import { describe, expect, it } from 'vitest';
import {
	AUTO_LINK_CONSENT, acceptButtonText, acceptConfirmText, acceptFilter, acceptPairs, acceptPreview, acceptResultText, batchTitle, batchesOf, groupLinked, isAcceptable,
	mayReadDocuments, rateLimitMessage, skippedText, undoResultText,
} from './inboxBulk';
import { DEFAULT_FILTERS } from './inboxModel';
import { exactMatch, foundFile } from './fakeInboxServer';

describe('Accept all', () => {
	const exactOne = exactMatch();
	const exactDoc = exactMatch({ kind: 'document', rel_path: 'Users/a/3fa9c1d2.pdf' });
	const exactScan = exactMatch({ kind: 'surface_scan' });
	const weak = foundFile({ match_strength: 'code' });
	const done = exactMatch({ state: 'linked' });
	const noEdit = exactMatch({ suggested_can_edit: false });
	const rows = [exactOne, exactDoc, exactScan, weak, done, noEdit, foundFile()];

	it('counts only exact short-ID matches to one record the person can edit, not scans', () => {
		expect(rows.map(isAcceptable)).toEqual([true, true, false, false, false, false, false]);
		expect(acceptPreview(rows)).toEqual({ count: 2, reads: 1, exact: true });
	});
	it('says when the rows on screen are not every matching file, so the count is only the first page', () => {
		expect(acceptPreview(rows, false)).toEqual({ count: 2, reads: 1, exact: false });
	});
	it('the confirm names the count, the rule, what is read and the undo', () => {
		expect(acceptConfirmText({ count: 12, hasMore: false, mayRead: false })).toBe('Link 12 found files to the record that each short ID names? Only exact short-ID matches to a record you can edit are linked. You can undo the whole batch afterwards.');
		expect(acceptConfirmText({ count: 1, hasMore: false, mayRead: true })).toContain('Link 1 found file to the record that its short ID names?');
		expect(acceptConfirmText({ count: 5, hasMore: false, mayRead: true })).toContain('Any documents or other files among them are read once to fingerprint them.');
		expect(acceptConfirmText({ count: 500, hasMore: true, mayRead: false })).toContain('this links the first 500, and you can run it again afterwards');
	});
	it('a filter on pictures cannot read a document; any other can', () => {
		expect([mayReadDocuments(DEFAULT_FILTERS), mayReadDocuments({ ...DEFAULT_FILTERS, kind: 'sem_image' }), mayReadDocuments({ ...DEFAULT_FILTERS, kind: 'document' })]).toEqual([true, false, true]);
	});
	it('says what is left for the person, grouped by reason', () => {
		expect(skippedText([])).toBeNull();
		expect(skippedText([{ candidate_id: 'a', reason: 'SURFACE_SCAN' }, { candidate_id: 'b', reason: 'NOT_EDITABLE' }, { candidate_id: 'c', reason: 'NOT_EDITABLE' }]))
			.toBe('Left for you to decide: 1 surface scan (added one by one), 2 files whose record you cannot edit.');
		expect(skippedText([{ candidate_id: 'a', reason: 'SOMETHING_NEW' }])).toBe('Left for you to decide: 1 file (something new).');
	});
	it('names where the files go, leaving out a file the page cannot name, and says whether it named them all', () => {
		const names = (id: string) => (id === 'a' ? { file: 'x.tif', record: 'S-1' } : id === 'b' ? { file: 'y.tif', record: null } : null);
		expect(acceptPairs(['a', 'b'], [{ candidate_id: 'b', collection: 'physical_samples', record_id: 'r', label: 'S-2' }], names)).toEqual({ pairs: [{ file: 'x.tif', record: 'S-1' }, { file: 'y.tif', record: 'S-2' }], all: true });
		expect(acceptPairs(['a', 'zz'], [], names)).toEqual({ pairs: [{ file: 'x.tif', record: 'S-1' }], all: false });
	});
	it('sends the tab and filters on screen, narrowed to exact short IDs', () => {
		expect(acceptFilter({ ...DEFAULT_FILTERS, tab: 'older', folder: 'sem', kind: 'sem_image' })).toEqual({ tab: 'older', strength: 'short_id', kind: 'sem_image', folder: 'sem' });
	});
	it('words the button and the result', () => {
		expect(acceptButtonText({ count: 0, reads: 0, exact: true })).toBe('Accept all');
		expect(acceptButtonText({ count: 4, reads: 0, exact: true })).toBe('Accept all (4)');
		expect(acceptButtonText({ count: 4, reads: 0, exact: false })).toBe('Accept all');
		expect(acceptResultText(12, 3)).toBe('Linked 12 found files. 3 were left for you to decide.');
		expect(acceptResultText(1, 1)).toBe('Linked 1 found file. 1 was left for you to decide.');
		expect(acceptResultText(2, 0)).toBe('Linked 2 found files.');
	});
});

describe('batches (one Undo each)', () => {
	const mk = (batch: string | null, at: string, kind: 'manual' | 'bulk' | 'auto' = 'bulk') => foundFile({ state: 'linked', link_batch_id: batch, decided_at: at, link_kind: kind });
	it('groups linked rows by batch, newest first, and leaves rows with no batch out', () => {
		const rows = [mk('b1', '2026-10-14T10:00:00Z'), mk('b2', '2026-10-15T10:00:00Z', 'auto'), mk('b1', '2026-10-14T10:05:00Z'), mk(null, '2026-10-15T11:00:00Z'), foundFile()];
		const bs = batchesOf(rows);
		expect(bs.map((b) => [b.id, b.count, b.kind, b.at])).toEqual([['b2', 1, 'auto', '2026-10-15T10:00:00Z'], ['b1', 2, 'bulk', '2026-10-14T10:05:00Z']]);
		expect(batchTitle(bs[0])).toBe('Linked automatically, 1 file');
		expect(batchTitle(bs[1])).toBe('Accepted in bulk, 2 files');
		expect(undoResultText(2)).toBe('Undone: 2 found files back in your Inbox.');
	});
});

describe('batches that added surface scans', () => {
	const scan = (batch: string) => foundFile({ state: 'linked', link_batch_id: batch, decided_at: '2026-10-15T10:00:00Z', link_kind: 'manual', linked_collection: 'surface_scans', linked_record_id: 's1', linked_insert_id: 'i1', linked_edge_id: null });
	const sample = (batch: string) => foundFile({ state: 'linked', link_batch_id: batch, decided_at: '2026-10-15T10:00:00Z', link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: 'p1' });
	it('say they were added, never linked', () => {
		expect(batchTitle(batchesOf([scan('b1')])[0])).toBe('Added as a surface scan, 1 file');
		expect(batchTitle(batchesOf([scan('b1'), scan('b1')])[0])).toBe('Added as surface scans, 2 files');
	});
	it('a batch of both says how many were scans', () => {
		const [b] = batchesOf([sample('b1'), scan('b1')]);
		expect(b.scans).toBe(1);
		expect(batchTitle(b)).toBe('Linked by you, 2 files (1 added as a surface scan)');
		expect(batchTitle(batchesOf([sample('b2')])[0])).toBe('Linked by you, 1 file');
	});
});

describe('groupLinked', () => {
	it('one group per batch, newest first, then the rows that have no batch', () => {
		const a = foundFile({ state: 'linked', link_batch_id: 'b1', decided_at: '2026-10-14T10:00:00Z', link_kind: 'bulk' });
		const b = foundFile({ state: 'linked', link_batch_id: 'b2', decided_at: '2026-10-15T10:00:00Z', link_kind: 'manual' });
		const c = foundFile({ state: 'linked', link_batch_id: 'b1', decided_at: '2026-10-14T10:01:00Z', link_kind: 'bulk' });
		const loose = foundFile({ state: 'linked', link_batch_id: null });
		const groups = groupLinked([a, b, c, loose]);
		expect(groups.map((g) => [g.batch?.id ?? null, g.rows.length])).toEqual([['b2', 1], ['b1', 2], [null, 1]]);
		expect(groupLinked([])).toEqual([]);
	});
});

describe('the rate-limit message', () => {
	it('says the rule, and when to ask again if the server said', () => {
		expect(rateLimitMessage()).toBe('A scan of your folder is already queued or ran recently. A folder can be rescanned once every 10 minutes. Try again in a few minutes.');
		expect(rateLimitMessage(61)).toBe('A scan of your folder is already queued or ran recently. A folder can be rescanned once every 10 minutes. Try again in 2 minutes.');
		expect(rateLimitMessage(30)).toBe('A scan of your folder is already queued or ran recently. A folder can be rescanned once every 10 minutes. Try again in 1 minute.');
		expect(rateLimitMessage(0)).toContain('a few minutes');
	});
});

describe('the auto-link consent text', () => {
	const all = AUTO_LINK_CONSENT.join(' ');
	it('names what is linked, that documents never are, and where the undo is', () => {
		expect(all).toContain('short ID of exactly one record that you can edit');
		expect(all).toContain('Documents are never linked automatically');
		expect(all).toContain('Team folders are never linked automatically');
		expect(all).toContain('Recently auto-linked');
		expect(all).toContain('undo it there');
	});
	it('does not call anything "attached" and never says a surface scan is linked', () => {
		expect(all.toLowerCase()).not.toContain('attach');
		expect(all).not.toMatch(/surface scans? (is|are) linked/i);
	});
});
