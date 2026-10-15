// What a surface scan row is, as the panels read it. Contract: docs/superpowers/specs/2026-10-15-surface-scans-design.md
// ("Row contract"). Pure: no Vue, no three.js.

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
	file: ScanFile | null;
	condition: ScanCondition | null;
	conditionNote: string | null;
	scannedOn: string | null;
	operation: { id: string; label: string } | null;
	notes: string | null;
	status: RenderStatus | null;
	renderError: string | null;
	version: number | null;
}

// The columns a list reads. The two relations are expanded for their label only; a role that may not read
// the file or the operation gets the bare id back and the row still shows.
export const SCAN_FIELDS = [
	'scan_id', 'insert_id', 'edge_id', 'condition', 'condition_note', 'scanned_on', 'notes',
	'render_status', 'render_error', 'rendered_at', 'version',
	'directus_files_id.id', 'directus_files_id.filename_download', 'directus_files_id.title',
	'operation_id.operation_id', 'operation_id.pass_code', 'operation_id.operation_date', 'operation_id.process_category',
];

/** The read filter of a record's scans. An edge's page lists its own scans and its insert's. */
export function scanFilter(target: { insertId?: string | null; edgeId?: string | null }): Record<string, unknown> {
	const clauses: Record<string, unknown>[] = [];
	if (target.edgeId) clauses.push({ edge_id: { _eq: target.edgeId } });
	if (target.insertId) clauses.push({ insert_id: { _eq: target.insertId } });
	if (clauses.length === 0) return { scan_id: { _null: true } }; // nothing to ask for: matches nothing
	return clauses.length === 1 ? clauses[0] : { _or: clauses };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

const isCondition = (v: unknown): v is ScanCondition => (SCAN_CONDITIONS as readonly string[]).includes(v as string);
const isStatus = (v: unknown): v is RenderStatus => v === 'pending' || v === 'rendering' || v === 'done' || v === 'failed';

function fileOf(v: unknown): ScanFile | null {
	if (typeof v === 'string') return v ? { id: v, name: '(file)' } : null;
	if (typeof v !== 'object' || v === null) return null;
	const f = v as Record<string, unknown>;
	const id = str(f.id);
	if (!id) return null;
	return { id, name: str(f.filename_download) ?? str(f.title) ?? '(file)' };
}

function operationOf(v: unknown): ScanRow['operation'] {
	if (typeof v === 'string') return v ? { id: v, label: 'Operation' } : null;
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	const id = str(o.operation_id);
	if (!id) return null;
	return { id, label: str(o.pass_code) ?? 'Operation' };
}

/** One row of GET /items/surface_scans with SCAN_FIELDS. Anything unreadable becomes null; the row still shows. */
export function normaliseScan(raw: any): ScanRow {
	return {
		id: String(raw?.scan_id ?? ''),
		insertId: str(raw?.insert_id),
		edgeId: str(raw?.edge_id),
		file: fileOf(raw?.directus_files_id),
		condition: isCondition(raw?.condition) ? raw.condition : null,
		conditionNote: str(raw?.condition_note),
		scannedOn: str(raw?.scanned_on),
		operation: operationOf(raw?.operation_id),
		notes: str(raw?.notes),
		status: isStatus(raw?.render_status) ? raw.render_status : null,
		renderError: str(raw?.render_error),
		version: typeof raw?.version === 'number' ? raw.version : null,
	};
}

export const conditionLabel = (c: ScanCondition | null): string => (c ? CONDITION_LABEL[c] : 'Unknown');

export const renderStatusStyle = (s: RenderStatus | null): { label: string; tone: ScanTone } =>
	s ? RENDER_STYLE[s] : { label: 'Unknown', tone: 'neutral' };

/** Only a finished render can be looked at in 3D (the endpoint answers 404 until then). */
export const canOpenScan = (row: ScanRow): boolean => row.status === 'done';

/** "Render again" is offered on a failed render only. */
export const canRenderAgain = (row: ScanRow): boolean => row.status === 'failed';

export const isInProgress = (row: ScanRow): boolean => row.status === 'pending' || row.status === 'rendering';

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
export type ScanPart = 'grid' | 'meta' | 'thumb' | 'render';
export const scanPath = (scanId: string, part: ScanPart): string => `${SCAN_ENDPOINT}/${encodeURIComponent(scanId)}/${part}`;
