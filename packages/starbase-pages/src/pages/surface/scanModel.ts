// What a surface scan row is, as the panels read it. Contract: GET /d1-surface-scan/scans, in
// docs/superpowers/specs/2026-10-21-surface-scan-privacy-design.md ("Endpoint contract"): a readable row, or a locked
// one (the scan's file belongs to someone else) that carries only its condition, date and operation. Pure: no Vue, no three.js.

export const SCAN_CONDITIONS = ['new', 'worn', 'cleaned', 'other'] as const;
export type ScanCondition = (typeof SCAN_CONDITIONS)[number];

export const CONDITION_LABEL: Record<ScanCondition, string> = {
	new: 'New',
	worn: 'Worn',
	cleaned: 'Cleaned',
	other: 'Other',
};

export type RenderStatus = 'pending' | 'rendering' | 'done' | 'failed';
export type ScanTone = 'neutral' | 'info' | 'progress' | 'success' | 'danger';

const RENDER_STYLE: Record<RenderStatus, { label: string; tone: ScanTone }> = {
	pending: { label: 'Waiting to render', tone: 'info' },
	rendering: { label: 'Rendering', tone: 'progress' },
	done: { label: 'Ready', tone: 'success' },
	failed: { label: 'Render failed', tone: 'danger' },
};

export interface ScanFile {
	id: string;
	name: string;
}

export interface ScanRow {
	id: string;
	insertId: string | null;
	edgeId: string | null;
	/** The scan's file belongs to someone else: only condition, scannedOn and operation are set, everything else is null. */
	locked: boolean;
	file: ScanFile | null;
	condition: ScanCondition | null;
	conditionNote: string | null;
	scannedOn: string | null;
	operation: { id: string; label: string } | null;
	notes: string | null;
	status: RenderStatus | null;
	renderError: string | null;
	/** The endpoint's own answer for the caller (update permission on the row); null when it said nothing. */
	canEdit: boolean | null;
}

/**
 * The query of a record's scans. An edge's page passes its insert too and gets the edge's scans and its insert's; null
 * when there is nothing to ask for (the endpoint wants at least one id).
 */
export function scanQuery(target: { insertId?: string | null; edgeId?: string | null }): { insert_id?: string; edge_id?: string } | null {
	const q: { insert_id?: string; edge_id?: string } = {};
	if (target.insertId) q.insert_id = target.insertId;
	if (target.edgeId) q.edge_id = target.edgeId;
	return q.insert_id || q.edge_id ? q : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

const isCondition = (v: unknown): v is ScanCondition => (SCAN_CONDITIONS as readonly string[]).includes(v as string);
const isStatus = (v: unknown): v is RenderStatus => v === 'pending' || v === 'rendering' || v === 'done' || v === 'failed';

// `file` is `{id, name}`; a bare id string is tolerated.
function fileOf(v: unknown): ScanFile | null {
	if (typeof v === 'string') return v ? { id: v, name: '(file)' } : null;
	if (typeof v !== 'object' || v === null) return null;
	const f = v as Record<string, unknown>;
	const id = str(f.id);
	if (!id) return null;
	return { id, name: str(f.name) ?? '(file)' };
}

// `operation` is `{id, label}`, or null when the scan has none (or the caller may not read it).
function operationOf(v: unknown): ScanRow['operation'] {
	if (typeof v === 'string') return v ? { id: v, label: 'Operation' } : null;
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	const id = str(o.id);
	if (!id) return null;
	return { id, label: str(o.label) ?? 'Operation' };
}

/**
 * One row of GET /d1-surface-scan/scans. A locked row keeps what the endpoint sent (condition, date, operation) and nothing
 * else, whatever else the body holds: the panel must never show a file, notes or a render state of a scan it cannot open.
 */
export function normaliseScan(raw: any): ScanRow {
	const base = {
		id: String(raw?.scan_id ?? ''),
		insertId: str(raw?.insert_id),
		edgeId: str(raw?.edge_id),
		condition: isCondition(raw?.condition) ? raw.condition : null,
		scannedOn: str(raw?.scanned_on),
		operation: operationOf(raw?.operation),
	};
	if (raw?.locked === true) {
		return { ...base, locked: true, file: null, conditionNote: null, notes: null, status: null, renderError: null, canEdit: null };
	}
	return {
		...base,
		locked: false,
		file: fileOf(raw?.file),
		conditionNote: str(raw?.condition_note),
		notes: str(raw?.notes),
		status: isStatus(raw?.render_status) ? raw.render_status : null,
		renderError: str(raw?.render_error),
		canEdit: typeof raw?.can_edit === 'boolean' ? raw.can_edit : null,
	};
}

export const conditionLabel = (c: ScanCondition | null): string => (c ? CONDITION_LABEL[c] : 'Unknown');

export const renderStatusStyle = (s: RenderStatus | null): { label: string; tone: ScanTone } =>
	s ? RENDER_STYLE[s] : { label: 'Unknown', tone: 'neutral' };

/** Only a finished render can be looked at in 3D (the endpoint answers 404 until then). */
export const canOpenScan = (row: ScanRow): boolean => !row.locked && row.status === 'done';

/**
 * "Render again" is offered on a failed render, and on a finished one (its rendered files may be gone from the object
 * store: the endpoint then says so, OBJECT_MISSING). Not while a render is queued or running.
 */
export const canRenderAgain = (row: ScanRow): boolean => !row.locked && (row.status === 'failed' || row.status === 'done');

export const isInProgress = (row: ScanRow): boolean => !row.locked && (row.status === 'pending' || row.status === 'rendering');

/** The words on a locked scan's tile. */
export const LOCKED_SCAN_TEXT = 'A surface scan you cannot open: its file belongs to someone else';

/** Newest first by the day it was scanned, then the scans with no date. Stable. */
export function sortScans(rows: ScanRow[]): ScanRow[] {
	return rows
		.map((r, i) => ({ r, i }))
		.sort((a, b) => {
			const da = a.r.scannedOn ?? '';
			const db = b.r.scannedOn ?? '';
			if (da !== db) return da < db ? 1 : -1; // '' (no date) sorts last
			return a.i - b.i;
		})
		.map((x) => x.r);
}

/** Where a scan belongs, seen from the page showing it: the page's own item, or its insert's (on an edge page). */
export function scanOwner(row: ScanRow, pageEdgeId: string | null): 'own' | 'insert' {
	return pageEdgeId && row.edgeId !== pageEdgeId ? 'insert' : 'own';
}

// While a render is queued or running the panel asks again, gently, and gives up after a while.
export const POLL_MS = 4000;
export const POLL_MAX = 150; // 10 minutes
export const shouldPoll = (rows: ScanRow[], polls: number): boolean => polls < POLL_MAX && rows.some(isInProgress);

export const SCAN_ENDPOINT = '/d1-surface-scan';
export const SCANS_PATH = `${SCAN_ENDPOINT}/scans`;
export type ScanPart = 'grid' | 'meta' | 'thumb' | 'render';
export const scanPath = (scanId: string, part: ScanPart): string => `${SCAN_ENDPOINT}/${encodeURIComponent(scanId)}/${part}`;
