import { describe, expect, it } from 'vitest';
import {
	canOpenScan, canRenderAgain, conditionLabel, isInProgress, LOCKED_SCAN_TEXT, normaliseScan, POLL_MAX, renderStatusStyle, scanOwner, scanPath, scanQuery,
	SCANS_PATH, shouldPoll, sortScans, type ScanRow,
} from './scanModel';

// A readable row of GET /d1-surface-scan/scans (spec 2026-10-21, "Endpoint contract").
const raw = (o: Record<string, unknown> = {}) => ({
	scan_id: 's1', insert_id: 'i1', edge_id: null, locked: false, condition: 'worn', scanned_on: '2026-09-30',
	operation: { id: 'o1', label: 'OP-7' }, notes: null, condition_note: ' flank wear ', added_by: { person_id: 'p1', name: 'Ada' },
	file: { id: 'f1', name: 'edge-A.al3d' }, render_status: 'done', render_error: null, rendered_at: '2026-10-01T10:00:00Z', grid: { width: 192, height: 128 }, can_edit: true,
	...o,
});
// A locked row: only what the spec lists.
const lockedRaw = (o: Record<string, unknown> = {}) => ({
	scan_id: 'sL', insert_id: 'i1', edge_id: null, locked: true, condition: 'cleaned', scanned_on: '2026-10-02', operation: { id: 'o2', label: 'OP-9' }, ...o,
});
const row = (o: Partial<ScanRow> = {}): ScanRow => ({ ...normaliseScan(raw()), ...o });

describe('normaliseScan', () => {
	it('reads a readable row', () => {
		expect(normaliseScan(raw())).toEqual({
			id: 's1', insertId: 'i1', edgeId: null, locked: false, file: { id: 'f1', name: 'edge-A.al3d' }, condition: 'worn', conditionNote: ' flank wear ',
			scannedOn: '2026-09-30', operation: { id: 'o1', label: 'OP-7' }, notes: null, status: 'done', renderError: null, canEdit: true,
		});
	});
	it('reads a locked row as condition, date and operation only, and drops anything else the body holds', () => {
		const expected = {
			id: 'sL', insertId: 'i1', edgeId: null, locked: true, file: null, condition: 'cleaned', conditionNote: null, scannedOn: '2026-10-02',
			operation: { id: 'o2', label: 'OP-9' }, notes: null, status: null, renderError: null, canEdit: null,
		};
		expect(normaliseScan(lockedRaw())).toEqual(expected);
		// even if a faulty server sent more, a locked row shows none of it
		expect(normaliseScan(lockedRaw({ file: { id: 'f9', name: 'secret.al3d' }, notes: 'private', condition_note: 'private', render_status: 'done', render_error: 'x', can_edit: true }))).toEqual(expected);
	});
	it('treats only locked === true as locked', () => {
		expect(normaliseScan(raw({ locked: undefined })).locked).toBe(false);
		expect(normaliseScan(raw({ locked: 'true' })).locked).toBe(false);
	});
	it('keeps the row when the file or the operation is a bare id, and has none for a missing one', () => {
		const r = normaliseScan(raw({ file: 'f9', operation: 'o9' }));
		expect(r.file).toEqual({ id: 'f9', name: '(file)' });
		expect(r.operation).toEqual({ id: 'o9', label: 'Operation' });
		const n = normaliseScan(raw({ file: null, operation: null }));
		expect(n.file).toBeNull();
		expect(n.operation).toBeNull();
		expect(normaliseScan(raw({ file: { id: 'f1' }, operation: { id: 'o1' } }))).toMatchObject({ file: { name: '(file)' }, operation: { label: 'Operation' } });
	});
	it('reads an unknown condition or status as null, not as a guess, and can_edit only when it is a boolean', () => {
		const r = normaliseScan(raw({ condition: 'broken', render_status: 'queued', can_edit: 'yes' }));
		expect(r.condition).toBeNull();
		expect(r.status).toBeNull();
		expect(r.canEdit).toBeNull();
		expect(conditionLabel(null)).toBe('Unknown');
		expect(renderStatusStyle(null).tone).toBe('neutral');
	});
});

describe('scanQuery', () => {
	it('asks for an insert page’s own scans', () => {
		expect(scanQuery({ insertId: 'i1' })).toEqual({ insert_id: 'i1' });
	});
	it('asks an edge page for the edge and its insert: both ids', () => {
		expect(scanQuery({ edgeId: 'e1', insertId: 'i1' })).toEqual({ insert_id: 'i1', edge_id: 'e1' });
		expect(scanQuery({ edgeId: 'e1' })).toEqual({ edge_id: 'e1' });
	});
	it('asks for nothing when it is given nothing (the endpoint wants an id)', () => {
		expect(scanQuery({})).toBeNull();
		expect(scanQuery({ insertId: '', edgeId: null })).toBeNull();
	});
});

describe('what can be done with a scan', () => {
	it('opens a finished render only, and renders again a failed or a finished one (never one in progress)', () => {
		for (const [status, open, again, busy] of [
			['pending', false, false, true], ['rendering', false, false, true], ['done', true, true, false], ['failed', false, true, false],
		] as const) {
			const r = row({ status });
			expect([canOpenScan(r), canRenderAgain(r), isInProgress(r)]).toEqual([open, again, busy]);
		}
	});
	it('polls while something is queued or running, and gives up eventually', () => {
		expect(shouldPoll([row({ status: 'done' })], 0)).toBe(false);
		expect(shouldPoll([row({ status: 'done' }), row({ status: 'pending' })], 0)).toBe(true);
		expect(shouldPoll([row({ status: 'rendering' })], POLL_MAX)).toBe(false);
	});
	it('offers nothing on a locked scan: it cannot be opened, rendered again or waited for', () => {
		for (const status of ['pending', 'rendering', 'done', 'failed'] as const) {
			const r = row({ locked: true, status });
			expect([canOpenScan(r), canRenderAgain(r), isInProgress(r)]).toEqual([false, false, false]);
		}
		expect(shouldPoll([normaliseScan(lockedRaw())], 0)).toBe(false);
		expect(LOCKED_SCAN_TEXT).toBe('A surface scan you cannot open: its file belongs to someone else');
	});
	it('words the statuses for people', () => {
		expect(renderStatusStyle('failed')).toEqual({ label: 'Render failed', tone: 'danger' });
		expect(renderStatusStyle('done').label).toBe('Ready');
	});
});

describe('sortScans', () => {
	it('puts the newest scan first and the undated ones last, keeping the read order otherwise', () => {
		const a = row({ id: 'a', scannedOn: '2026-01-01' });
		const b = row({ id: 'b', scannedOn: null });
		const c = row({ id: 'c', scannedOn: '2026-05-01' });
		const d = row({ id: 'd', scannedOn: null });
		expect(sortScans([a, b, c, d]).map((r) => r.id)).toEqual(['c', 'a', 'b', 'd']);
	});
});

describe('scanOwner and scanPath', () => {
	it("tells an insert's scan from the edge's own on an edge page", () => {
		expect(scanOwner(row({ edgeId: 'e1' }), 'e1')).toBe('own');
		expect(scanOwner(row({ edgeId: null, insertId: 'i1' }), 'e1')).toBe('insert');
		expect(scanOwner(row({ edgeId: null, insertId: 'i1' }), null)).toBe('own');
	});
	it('builds the endpoint paths of the spec', () => {
		expect(SCANS_PATH).toBe('/d1-surface-scan/scans');
		expect(scanPath('abc', 'grid')).toBe('/d1-surface-scan/abc/grid');
		expect(scanPath('a/b', 'render')).toBe('/d1-surface-scan/a%2Fb/render');
	});
});
