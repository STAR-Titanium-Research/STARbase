import { describe, expect, it } from 'vitest';
import {
	canOpenScan, canRenderAgain, conditionLabel, isInProgress, normaliseScan, POLL_MAX, renderStatusStyle, scanFilter, scanOwner, scanPath, shouldPoll,
	sortScans, type ScanRow,
} from './scanModel';

const raw = (o: Record<string, unknown> = {}) => ({
	scan_id: 's1', insert_id: 'i1', edge_id: null, condition: 'worn', condition_note: ' flank wear ', scanned_on: '2026-09-30', notes: null,
	render_status: 'done', render_error: null, version: 3,
	directus_files_id: { id: 'f1', filename_download: 'edge-A.al3d', title: 'x' },
	operation_id: { operation_id: 'o1', pass_code: 'OP-7' },
	...o,
});
const row = (o: Partial<ScanRow> = {}): ScanRow => ({ ...normaliseScan(raw()), ...o });

describe('normaliseScan', () => {
	it('reads a full row', () => {
		expect(normaliseScan(raw())).toEqual({
			id: 's1', insertId: 'i1', edgeId: null, file: { id: 'f1', name: 'edge-A.al3d' }, condition: 'worn', conditionNote: ' flank wear ',
			scannedOn: '2026-09-30', operation: { id: 'o1', label: 'OP-7' }, notes: null, status: 'done', renderError: null, version: 3,
		});
	});
	it('keeps the row when the file or the operation is unreadable (a bare id comes back)', () => {
		const r = normaliseScan(raw({ directus_files_id: 'f9', operation_id: 'o9' }));
		expect(r.file).toEqual({ id: 'f9', name: '(file)' });
		expect(r.operation).toEqual({ id: 'o9', label: 'Operation' });
	});
	it('falls back to the title, and to none for no file or operation', () => {
		expect(normaliseScan(raw({ directus_files_id: { id: 'f1', filename_download: null, title: 'Scan A' } })).file?.name).toBe('Scan A');
		const r = normaliseScan(raw({ directus_files_id: null, operation_id: null }));
		expect(r.file).toBeNull();
		expect(r.operation).toBeNull();
	});
	it('reads an unknown condition or status as null, not as a guess', () => {
		const r = normaliseScan(raw({ condition: 'broken', render_status: 'queued' }));
		expect(r.condition).toBeNull();
		expect(r.status).toBeNull();
		expect(conditionLabel(null)).toBe('Unknown');
		expect(renderStatusStyle(null).tone).toBe('neutral');
	});
});

describe('scanFilter', () => {
	it('asks for an insert page’s own scans', () => {
		expect(scanFilter({ insertId: 'i1' })).toEqual({ insert_id: { _eq: 'i1' } });
	});
	it('asks an edge page for the edge and its insert', () => {
		expect(scanFilter({ edgeId: 'e1', insertId: 'i1' })).toEqual({ _or: [{ edge_id: { _eq: 'e1' } }, { insert_id: { _eq: 'i1' } }] });
		expect(scanFilter({ edgeId: 'e1' })).toEqual({ edge_id: { _eq: 'e1' } });
	});
	it('matches nothing when it is given nothing', () => {
		expect(scanFilter({})).toEqual({ scan_id: { _null: true } });
	});
});

describe('what can be done with a scan', () => {
	it('opens a finished render only, and renders again a failed one only', () => {
		for (const [status, open, again, busy] of [
			['pending', false, false, true], ['rendering', false, false, true], ['done', true, false, false], ['failed', false, true, false],
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
		expect(scanPath('abc', 'grid')).toBe('/d1-surface-scan/abc/grid');
		expect(scanPath('a/b', 'render')).toBe('/d1-surface-scan/a%2Fb/render');
	});
});
