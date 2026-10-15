import { describe, expect, it } from 'vitest';
import {
	AUTO_LINK_CONSENT, acceptButtonText, acceptConfirmText, acceptPreview, acceptResultText, batchTitle, batchesOf, isAcceptable, rateLimitMessage, undoResultText,
} from './inboxBulk';
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
		expect(acceptPreview(rows)).toEqual({ count: 2, reads: 1 });
	});
	it('the server count over the whole filter wins', () => {
		expect(acceptPreview(rows, 37).count).toBe(37);
	});
	it('the confirm names the count, the rule and the undo', () => {
		expect(acceptConfirmText({ count: 12, reads: 0 })).toBe('Link 12 found files to the record that each short ID names? Only exact short-ID matches to a record you can edit are linked. You can undo the whole batch afterwards.');
		expect(acceptConfirmText({ count: 1, reads: 1 })).toContain('Link 1 found file to the record that its short ID names?');
		expect(acceptConfirmText({ count: 1, reads: 1 })).toContain('one of them reads it once to fingerprint it');
		expect(acceptConfirmText({ count: 5, reads: 3 })).toContain('3 of them reads each once to fingerprint it');
	});
	it('words the button and the result', () => {
		expect(acceptButtonText({ count: 0, reads: 0 })).toBe('Accept all');
		expect(acceptButtonText({ count: 4, reads: 0 })).toBe('Accept all (4)');
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
