import { describe, expect, it } from 'vitest';
import {
	beginUploadItem, bulkDeleteBlockReason, deleteAfterConfirmBlockReason, bulkDeleteSkipReason, canUploadCapture, cleanupSkipReason, idsToLookUp, pageSizeFor, cleanupCandidates, cleanupCutoff, finishUploadItem, finishUploads,
	isBulkSelectable, isClientFilter, isCleanupCandidate, matchesFilter, needsMorePages, planBulkDelete,
	pruneSelection, requestUploadCancel, rowState, selectableIds, serverStatusFor, shouldStopUploads,
	startUploadProgress, summarizeCleanup, summarizeDeleteResults, toggleAll, toggleId, uploadProgressText,
	type ListCapture, type RowFacts,
} from './captureList';

const DAY = 24 * 3600;
const NOW_MS = Date.UTC(2026, 9, 6, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

const cap = (id: string, over: Partial<ListCapture> = {}): ListCapture => ({
	id, size_mb: 100, finalized: true, mtime: NOW_S - 40 * DAY, ...over,
});
const facts = (over: Partial<RowFacts> = {}): RowFacts => ({
	uploadedKnown: true, uploaded: {}, queuedIds: new Set(), remoteComplete: null, ...over,
});

describe('rowState', () => {
	it('reads each state, with busy and incomplete ahead of upload state', () => {
		const f = facts({ uploaded: { up: true }, queuedIds: new Set(['q']) });
		expect(rowState(cap('up'), f)).toBe('uploaded');
		expect(rowState(cap('q'), f)).toBe('queued');
		expect(rowState(cap('n'), f)).toBe('not_uploaded');
		expect(rowState(cap('i', { finalized: false }), f)).toBe('incomplete');
		expect(rowState(cap('r', { recording: true, finalized: false }), f)).toBe('working');
		expect(rowState(cap('d', { discarding: true }), f)).toBe('working');
		expect(rowState(cap('c', { recovering: true }), f)).toBe('working');
	});

	it('unknown upload state is unknown, never uploaded or not uploaded', () => {
		expect(rowState(cap('a'), facts({ uploadedKnown: false, uploaded: { a: true } }))).toBe('unknown');
	});
});

describe('filter', () => {
	const f = facts({ uploaded: { up: true }, queuedIds: new Set(['q']) });
	const rows = [cap('up'), cap('q'), cap('n'), cap('i', { finalized: false }), cap('w', { discarding: true })];
	const ids = (flt: Parameters<typeof matchesFilter>[1]) => rows.filter((c) => matchesFilter(c, flt, f)).map((c) => c.id);

	it('chips select the right rows', () => {
		expect(ids('all')).toHaveLength(5);
		expect(ids('uploaded')).toEqual(['up']);
		expect(ids('incomplete')).toEqual(['i']);
	});

	it('"not uploaded" keeps queued rows, which are not safe either, and drops incomplete ones', () => {
		expect(ids('not_uploaded')).toEqual(['q', 'n']);
	});

	it('"not uploaded" keeps finalized rows whose state is unknown', () => {
		const unknown = facts({ uploadedKnown: false });
		expect(rows.filter((c) => matchesFilter(c, 'not_uploaded', unknown)).map((c) => c.id)).toEqual(['up', 'q', 'n']);
	});

	it('maps chips to what the server can apply', () => {
		expect(serverStatusFor('all')).toBeUndefined();
		expect(serverStatusFor('incomplete')).toBe('incomplete');
		expect(serverStatusFor('uploaded')).toBe('finalized');
		expect(serverStatusFor('not_uploaded')).toBe('finalized');
		expect(isClientFilter('uploaded')).toBe(true);
		expect(isClientFilter('incomplete')).toBe(false);
	});

	it('needsMorePages stops when full or exhausted', () => {
		expect(needsMorePages({ loaded: 200, total: 900, matched: 10, wanted: 100 })).toBe(true);
		expect(needsMorePages({ loaded: 200, total: 900, matched: 100, wanted: 100 })).toBe(false);
		expect(needsMorePages({ loaded: 900, total: 900, matched: 3, wanted: 100 })).toBe(false);
	});
});

describe('selection', () => {
	it('only finalized, idle captures are selectable', () => {
		expect(isBulkSelectable(cap('a'))).toBe(true);
		expect(isBulkSelectable(cap('a', { finalized: false }))).toBe(false);
		expect(isBulkSelectable(cap('a', { recording: true }))).toBe(false);
		expect(isBulkSelectable(cap('a', { discarding: true }))).toBe(false);
		expect(isBulkSelectable(cap('a', { recovering: true }))).toBe(false);
	});

	it('toggleAll selects the selectable rows only, then clears them', () => {
		const rows = [cap('a'), cap('b'), cap('inc', { finalized: false })];
		const sel = toggleAll(new Set(), rows);
		expect([...sel].sort()).toEqual(['a', 'b']);
		expect(toggleAll(sel, rows).size).toBe(0);
		// A partial selection completes rather than clearing.
		expect([...toggleAll(new Set(['a']), rows)].sort()).toEqual(['a', 'b']);
		expect(selectableIds(rows)).toEqual(['a', 'b']);
	});

	it('toggleId does not mutate its input', () => {
		const s = new Set(['a']);
		expect([...toggleId(s, 'b')].sort()).toEqual(['a', 'b']);
		expect([...toggleId(s, 'a')]).toEqual([]);
		expect([...s]).toEqual(['a']);
	});

	it('pruneSelection drops ids that are gone or became unsafe', () => {
		const rows = [cap('a'), cap('b', { recovering: true })];
		expect([...pruneSelection(new Set(['a', 'b', 'gone']), rows)]).toEqual(['a']);
	});
});

describe('bulk delete plan', () => {
	it('is blocked when upload state is unknown', () => {
		expect(bulkDeleteBlockReason(facts({ uploadedKnown: false }))).toMatch(/database/);
		expect(bulkDeleteBlockReason(facts())).toBeNull();
	});

	it('totals the space and flags only-copy items', () => {
		const rows = [cap('up', { size_mb: 10.005 }), cap('n', { size_mb: 20 }), cap('bk', { size_mb: 5 }), cap('q', { size_mb: 1 })];
		const f = facts({ uploaded: { up: true }, queuedIds: new Set(['q']), remoteComplete: new Set(['bk']) });
		const plan = planBulkDelete(new Set(['up', 'n', 'bk', 'q']), rows, f);
		expect(plan.items.map((i) => i.id)).toEqual(['up', 'q', 'n', 'bk']);
		expect(plan.totalMb).toBeCloseTo(36.01, 2);
		expect(plan.items.filter((i) => i.onlyCopy).map((i) => i.id).sort()).toEqual(['n', 'q']);
		expect(plan.onlyCopyCount).toBe(2);
	});

	it('treats every non-uploaded item as an only copy when the remote state is unknown', () => {
		const plan = planBulkDelete(new Set(['n']), [cap('n')], facts({ remoteComplete: null }));
		expect(plan.onlyCopyCount).toBe(1);
	});

	it('skips selected ids that are gone, incomplete or busy', () => {
		const rows = [cap('ok'), cap('inc', { finalized: false }), cap('busy', { recovering: true })];
		const plan = planBulkDelete(new Set(['ok', 'inc', 'busy', 'gone']), rows, facts());
		expect(plan.items.map((i) => i.id)).toEqual(['ok']);
		expect(plan.skipped.sort()).toEqual(['busy', 'gone', 'inc']);
	});
});

describe('cleanup candidates', () => {
	const f = facts({
		uploaded: { old_up: true, new_up: true, old_up_q: true, inc: true, busy: true, nomtime: true },
		queuedIds: new Set(['old_up_q']),
	});
	const rows = [
		cap('old_up', { mtime: NOW_S - 60 * DAY }),
		cap('new_up', { mtime: NOW_S - 5 * DAY }),
		cap('old_not', { mtime: NOW_S - 90 * DAY }),
		cap('old_unq', { mtime: NOW_S - 90 * DAY }),
		cap('old_up_q', { mtime: NOW_S - 60 * DAY }),
		cap('inc', { mtime: NOW_S - 90 * DAY, finalized: false }),
		cap('busy', { mtime: NOW_S - 90 * DAY, recovering: true }),
		cap('nomtime', { mtime: 0 }),
	];

	it('picks only old, finalized, positively uploaded, idle captures', () => {
		expect(cleanupCandidates(rows, f, 30, NOW_MS).map((c) => c.id)).toEqual(['old_up']);
	});

	it('never picks a not-uploaded, incomplete, queued or busy capture at any age', () => {
		for (const days of [0, 1, 30, 3650]) {
			const ids = cleanupCandidates(rows, f, days, NOW_MS).map((c) => c.id);
			for (const bad of ['old_not', 'old_unq', 'old_up_q', 'inc', 'busy', 'nomtime']) expect(ids).not.toContain(bad);
		}
	});

	it('picks nothing at all when upload state is unknown', () => {
		expect(cleanupCandidates(rows, { ...f, uploadedKnown: false }, 0, NOW_MS)).toEqual([]);
	});

	it('is strict about the age boundary', () => {
		const c = cap('x', { mtime: NOW_S - 30 * DAY });
		const ff = facts({ uploaded: { x: true } });
		// Exactly 30 days old is not "older than 30 days"; it is older than 29 and not than 31.
		expect(isCleanupCandidate(c, ff, cleanupCutoff(30, NOW_MS))).toBe(false);
		expect(isCleanupCandidate(c, ff, cleanupCutoff(31, NOW_MS))).toBe(false);
		expect(isCleanupCandidate(c, ff, cleanupCutoff(29, NOW_MS))).toBe(true);
	});

	it('re-checking against fresh state drops a capture that became unsafe', () => {
		const cutoff = cleanupCutoff(30, NOW_MS);
		const c = rows[0];
		expect(isCleanupCandidate(c, f, cutoff)).toBe(true);
		expect(isCleanupCandidate({ ...c, recovering: true }, f, cutoff)).toBe(false);
		expect(isCleanupCandidate(c, { ...f, uploaded: {} }, cutoff)).toBe(false);
	});

	it('summarizes count, space and age range', () => {
		const s = summarizeCleanup([cap('a', { size_mb: 1.5, mtime: 100 }), cap('b', { size_mb: 2.25, mtime: 300 })]);
		expect(s).toEqual({ count: 2, totalMb: 3.75, oldest: 100, newest: 300 });
		expect(summarizeCleanup([])).toEqual({ count: 0, totalMb: 0, oldest: null, newest: null });
	});
});

describe('delete results', () => {
	it('counts per outcome and sums only what was actually freed', () => {
		const s = summarizeDeleteResults([
			{ id: 'a', outcome: 'deleted', freed_mb: 10.5 },
			{ id: 'b', outcome: 'deleted', freed_mb: 4.25 },
			{ id: 'c', outcome: 'failed', reason: 'HTTP 409' },
			{ id: 'd', outcome: 'skipped', reason: 'busy' },
		]);
		expect(s.deleted).toBe(2);
		expect(s.freedMb).toBe(14.75);
		expect(s.failed.map((r) => r.id)).toEqual(['c']);
		expect(s.skipped.map((r) => r.id)).toEqual(['d']);
	});
});

describe('upload progress', () => {
	it('counts items, names the current one and reports n of m', () => {
		let p = startUploadProgress(3);
		p = beginUploadItem(p, 'Sample A');
		expect(uploadProgressText(p)).toBe('Uploading 1 of 3: Sample A');
		p = finishUploadItem(p, 'uploaded');
		p = beginUploadItem(p, 'Sample B');
		expect(uploadProgressText(p)).toBe('Uploading 2 of 3: Sample B');
		p = finishUploadItem(p, 'failed');
		p = beginUploadItem(p, 'Sample C');
		p = finishUploadItem(p, 'skipped');
		expect(p.finished).toBe(true);
		expect(uploadProgressText(p)).toBe('1 uploaded, 1 failed, 1 skipped');
	});

	it('cancel is honoured between items and the summary says what was not attempted', () => {
		let p = startUploadProgress(4);
		p = finishUploadItem(beginUploadItem(p, 'A'), 'uploaded');
		p = beginUploadItem(p, 'B');
		p = requestUploadCancel(p);
		expect(uploadProgressText(p)).toContain('Cancelling after this one');
		p = finishUploadItem(p, 'uploaded');
		expect(shouldStopUploads(p)).toBe(true);
		expect(p.finished).toBe(false);
		p = finishUploads(p);
		expect(uploadProgressText(p)).toBe('2 uploaded, 2 not attempted (cancelled)');
	});

	it('an empty run is finished at once', () => {
		expect(startUploadProgress(0).finished).toBe(true);
	});
});

describe('partial upload (orphan operation row)', () => {
	// An upload that died after the operation row was created: the row exists, no analysis row or files.
	const f = facts({ partial: { orphan: true } });

	it('is its own state: not uploaded, so the Upload action and the only-copy warning apply', () => {
		expect(rowState(cap('orphan'), f)).toBe('partial');
		expect(matchesFilter(cap('orphan'), 'not_uploaded', f)).toBe(true);
		expect(matchesFilter(cap('orphan'), 'uploaded', f)).toBe(false);
	});

	it('is never a cleanup candidate, however old', () => {
		const old = cap('orphan', { mtime: NOW_S - 400 * DAY });
		expect(isCleanupCandidate(old, f, cleanupCutoff(30, NOW_MS))).toBe(false);
		expect(cleanupCandidates([old, cap('ok', { mtime: NOW_S - 400 * DAY })], facts({ partial: { orphan: true }, uploaded: { ok: true } }), 30, NOW_MS).map((c) => c.id)).toEqual(['ok']);
	});

	it('shows as the only copy in the bulk-delete plan', () => {
		const plan = planBulkDelete(new Set(['orphan']), [cap('orphan')], f);
		expect(plan.items[0]).toMatchObject({ state: 'partial', onlyCopy: true });
		expect(plan.onlyCopyCount).toBe(1);
	});
});

describe('canUploadCapture', () => {
	it('is on offer for a not-uploaded and for a partially uploaded capture', () => {
		expect(canUploadCapture(cap('n'), facts())).toBe(true);
		expect(canUploadCapture(cap('orphan'), facts({ partial: { orphan: true } }))).toBe(true);
	});

	it('is off once uploaded, queued, incomplete, or with an unknown upload state', () => {
		expect(canUploadCapture(cap('up'), facts({ uploaded: { up: true } }))).toBe(false);
		expect(canUploadCapture(cap('q'), facts({ queuedIds: new Set(['q']) }))).toBe(false);
		expect(canUploadCapture(cap('i', { finalized: false }), facts())).toBe(false);
		expect(canUploadCapture(cap('n'), facts({ uploadedKnown: false }))).toBe(false);
	});

	it('is off while an upload (or delete) is already running for the row, so Upload all skips it', () => {
		const f = facts({ busyIds: new Set(['n']) });
		expect(canUploadCapture(cap('n'), f)).toBe(false);
		expect(canUploadCapture(cap('other'), f)).toBe(true);
	});
});

describe('busy captures (an upload is running for them)', () => {
	const f = facts({ uploaded: { up: true }, busyIds: new Set(['up']) });
	const old = cap('up', { mtime: NOW_S - 400 * DAY });

	it('are not selectable and are dropped from the bulk-delete plan', () => {
		expect(isBulkSelectable(old, f)).toBe(false);
		expect(isBulkSelectable(old, facts())).toBe(true);
		expect(selectableIds([old, cap('other')], f)).toEqual(['other']);
		expect(toggleAll(new Set(), [old, cap('other')], f)).toEqual(new Set(['other']));
		const plan = planBulkDelete(new Set(['up', 'other']), [old, cap('other')], f);
		expect(plan.items.map((i) => i.id)).toEqual(['other']);
		expect(plan.skipped).toEqual(['up']);
	});

	it('are never cleanup candidates', () => {
		expect(isCleanupCandidate(old, f, cleanupCutoff(30, NOW_MS))).toBe(false);
		expect(isCleanupCandidate(old, facts({ uploaded: { up: true } }), cleanupCutoff(30, NOW_MS))).toBe(true);
	});
});

describe('per-item re-check right before a delete', () => {
	const cutoff = cleanupCutoff(30, NOW_MS);
	const old = cap('a', { mtime: NOW_S - 400 * DAY });

	it('bulk: skips a capture that has gone, one that became busy, and everything when the state is unknown', () => {
		expect(bulkDeleteSkipReason(null, facts())).toMatch(/no longer on disk/);
		expect(bulkDeleteSkipReason(old, facts({ busyIds: new Set(['a']) }))).toMatch(/busy/);
		expect(bulkDeleteSkipReason({ ...old, recovering: true }, facts())).toMatch(/no longer safe/);
		expect(bulkDeleteSkipReason(old, facts({ uploadedKnown: false }))).toMatch(/could not be reached/);
		expect(bulkDeleteSkipReason(old, facts())).toBeNull();
	});

	it('cleanup: judges the fresh upload state, not the preview it was planned from', () => {
		// The preview said uploaded; fresh facts say the analysis row is gone (or never completed).
		expect(cleanupSkipReason(old, facts({ uploaded: { a: false } }), cutoff)).toMatch(/no longer safe/);
		expect(cleanupSkipReason(old, facts({ uploaded: { a: true }, busyIds: new Set(['a']) }), cutoff)).toMatch(/busy/);
		expect(cleanupSkipReason(null, facts({ uploaded: { a: true } }), cutoff)).toMatch(/no longer on disk/);
		expect(cleanupSkipReason(old, facts({ uploaded: { a: true } }), cutoff)).toBeNull();
	});
});

describe('paging cost with a browser-side chip', () => {
	it('asks for the largest page for Uploaded / Not uploaded, the normal one otherwise', () => {
		expect(pageSizeFor('uploaded', 200, 500)).toBe(500);
		expect(pageSizeFor('not_uploaded', 200, 500)).toBe(500);
		expect(pageSizeFor('all', 200, 500)).toBe(200);
		expect(pageSizeFor('incomplete', 200, 500)).toBe(200);
	});

	it('looks up only the ids that have not been looked up yet', () => {
		const rows = [cap('a'), cap('b'), cap('c')];
		expect(idsToLookUp(rows, new Set(['a', 'b'])).map((c) => c.id)).toEqual(['c']);
		expect(idsToLookUp(rows, new Set()).map((c) => c.id)).toEqual(['a', 'b', 'c']);
		expect(idsToLookUp(rows, new Set(['a', 'b', 'c']))).toEqual([]);
	});
});

describe('deleteAfterConfirmBlockReason', () => {
	const cap = { id: 'a', finalized: true } as any;
	it('goes ahead for an idle row still on disk', () => {
		expect(deleteAfterConfirmBlockReason(cap, { busyIds: new Set() })).toBeNull();
	});
	it('stops when an upload (Upload all reached the row while the dialog was open) is running for it', () => {
		expect(deleteAfterConfirmBlockReason(cap, { busyIds: new Set(['a']) })).toMatch(/busy/);
	});
	it('stops when the capture is gone', () => {
		expect(deleteAfterConfirmBlockReason(null, { busyIds: new Set() })).toMatch(/no longer on disk/);
	});
});
