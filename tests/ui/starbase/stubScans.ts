import type { Request, Route } from '@playwright/test';
import { syntheticScan, type SyntheticScan } from './syntheticScan';

// The surface-scan part of the d1-server stand-in (stubD1.ts): one tool box with two cutting inserts and three
// edges, the surface scans of the first insert and its first edge (one of them locked: its file belongs to someone else),
// the file library for the Add dialog, and the d1-surface-scan endpoint (GET /scans, meta, grid, thumb, render). Same
// shapes as the real endpoint (docs/superpowers/specs/2026-10-21-surface-scan-privacy-design.md, "Endpoint contract"):
// /scans answers a readable row in full and a locked row as condition, date and operation only, and meta, grid and thumb
// of a locked scan answer 403 FILE_LOCKED before anything else. The grid is made up (syntheticScan.ts). A queued render
// finishes on its own: each read of the scan list moves a pending scan to rendering and a rendering one to done.

export const STUB_TOOLING = {
	boxId: '00000000-0000-4000-8000-0000000000b1',
	boxCode: 'TB-0001',
	insertId: '00000000-0000-4000-8000-0000000000a1',
	insertCode: 'CNMG12-1',
	insert2Id: '00000000-0000-4000-8000-0000000000a2',
	edgeId: '00000000-0000-4000-8000-0000000000e1',
	edgeCode: 'CNMG12-1-A',
	edge2Id: '00000000-0000-4000-8000-0000000000e2',
	edge3Id: '00000000-0000-4000-8000-0000000000e3',
} as const;

export const STUB_LIBRARY = [
	{ id: 'file-new-1', storage: 'star', filename_download: 'Alicona-edgeA-after-12min.al3d', filesize: 18_400_000, metadata: { archive_path: 'Alicona/2026/Alicona-edgeA-after-12min.al3d' } },
	{ id: 'file-new-2', storage: 'star', filename_download: 'Alicona-edgeA-cleaned.al3d', filesize: 17_900_000, metadata: { archive_path: 'Alicona/2026/Alicona-edgeA-cleaned.al3d' } },
	// An uploaded file (not on the archive share): the worker could not read it, so the dialog's filter (storage = star) must not list it.
	{ id: 'file-upload-1', storage: 'local', filename_download: 'uploaded-by-hand.al3d', filesize: 1_000, metadata: null },
];

type Status = 'pending' | 'rendering' | 'done' | 'failed';
/** What the stand-in knows about a scan; GET /scans shows a locked one as condition, date and operation only. */
export interface StubScanRow {
	scan_id: string;
	insert_id: string | null;
	edge_id: string | null;
	/** The scan's file belongs to someone else (the caller is neither its owner nor an administrator). */
	locked: boolean;
	condition: string;
	condition_note: string | null;
	scanned_on: string | null;
	notes: string | null;
	render_status: Status;
	render_error: string | null;
	version: number;
	file: { id: string; name: string };
	operation: { id: string; label: string } | null;
	can_edit: boolean;
}

export interface StubScans {
	rows: StubScanRow[];
	/** Bodies of every POST /items/surface_scans. */
	created: Array<Record<string, unknown>>;
	/** Ids of every POST /d1-surface-scan/<id>/render. */
	renders: string[];
	/** "GET /d1-surface-scan/<id>/<part>" of every call, in order. */
	endpoint: string[];
	/** The query string of every GET /d1-surface-scan/scans, in order (an edge page sends both ids). */
	listed: string[];
	/** Ids of done scans whose rendered files are gone: meta, grid and thumb answer 404 OBJECT_MISSING until the scan is rendered again. */
	objectMissing: string[];
	/** A POST /items/surface_scans answers 403 with this text, once, when set. */
	refuseCreate: string | null;
	/** Same, but as the d1-access-guard words it (extensions.source, kind, reason): a file the person cannot read. */
	refuseCreateGuard: string | null;
	scan: SyntheticScan;
}

const T = STUB_TOOLING;

export function stubScans(): StubScans {
	return {
		rows: [
			{
				scan_id: 'scan-insert-new', insert_id: T.insertId, edge_id: null, locked: false, condition: 'new', condition_note: 'As received', scanned_on: '2026-06-12', notes: null,
				render_status: 'done', render_error: null, version: 1, file: { id: 'file-old-0', name: 'CNMG12-1-new.al3d' }, operation: null, can_edit: true,
			},
			// Someone else's file: this person sees that the insert has a scan, its condition, date and operation, and nothing more.
			{
				scan_id: 'scan-insert-locked', insert_id: T.insertId, edge_id: null, locked: true, condition: 'cleaned', condition_note: 'PRIVATE condition note', scanned_on: '2026-08-20', notes: 'PRIVATE notes',
				render_status: 'done', render_error: null, version: 1, file: { id: 'file-private-0', name: 'PRIVATE-owner-file.al3d' }, operation: { id: 'op-1', label: 'OP-TURN-7' }, can_edit: false,
			},
			{
				scan_id: 'scan-edge-worn', insert_id: null, edge_id: T.edgeId, locked: false, condition: 'worn', condition_note: 'Flank wear land about 0.2 mm', scanned_on: '2026-09-30', notes: null,
				render_status: 'done', render_error: null, version: 1, file: { id: 'file-old-1', name: 'CNMG12-1-A-worn.al3d' },
				operation: { id: 'op-1', label: 'OP-TURN-7' }, can_edit: true,
			},
			{
				scan_id: 'scan-edge-bad', insert_id: null, edge_id: T.edgeId, locked: false, condition: 'cleaned', condition_note: null, scanned_on: '2026-10-02', notes: null,
				render_status: 'failed', render_error: 'SurfaceTopography could not read this file: unsupported file version', version: 1,
				file: { id: 'file-old-2', name: 'CNMG12-1-A-cleaned.al3d' }, operation: null, can_edit: true,
			},
		],
		created: [],
		renders: [],
		endpoint: [],
		listed: [],
		objectMissing: [],
		refuseCreate: null,
		refuseCreateGuard: null,
		scan: syntheticScan(),
	};
}

/** One row as GET /d1-surface-scan/scans sends it. A locked row carries no file, notes, render state or author. */
function shapeRow(r: StubScanRow): Record<string, unknown> {
	const head = { scan_id: r.scan_id, insert_id: r.insert_id, edge_id: r.edge_id, locked: r.locked, condition: r.condition, scanned_on: r.scanned_on, operation: r.operation };
	if (r.locked) return head;
	return {
		...head, notes: r.notes, condition_note: r.condition_note, added_by: { person_id: 'person-1', name: 'Test Person' }, file: r.file, render_status: r.render_status,
		render_error: r.render_error, rendered_at: r.render_status === 'done' ? '2026-10-01T10:00:00Z' : null, grid: r.render_status === 'done' ? { width: 192, height: 128 } : null, can_edit: r.can_edit,
	};
}

const BOX = {
	tool_box_id: T.boxId, tool_box_code: T.boxCode, description: 'CNMG test box', location: 'Cabinet 2', package_quantity: 10, notes: null,
	created_at: '2026-01-05T09:00:00Z', updated_at: '2026-01-05T09:00:00Z', version: 1, project_id: null, owner_person_id: null,
	insert_type_id: {
		insert_type_id: 'it-1', type_code: 'CNMG-120408', iso_designation: 'CNMG120408', manufacturer: 'Acme', manufacturer_id: null, coating: 'TiAlN', substrate: 'WC-Co',
		material_class: 'P', inserts_per_box: 10, edge_count: 8, nose_radius_mm: 0.8, cutting_edge_length_mm: 12, included_angle_deg: 80, fixing_hole_diameter_mm: null,
	},
};
const INSERTS = [
	{ insert_id: T.insertId, insert_code: T.insertCode, tool_box_id: T.boxId, insert_number: 1, is_depleted: false, location: null, notes: null, created_at: null, updated_at: null, version: 1 },
	{ insert_id: T.insert2Id, insert_code: 'CNMG12-2', tool_box_id: T.boxId, insert_number: 2, is_depleted: false, location: null, notes: null, created_at: null, updated_at: null, version: 1 },
];
const edge = (id: string, insertId: string, code: string, letter: string, used: boolean) => ({
	edge_id: id, edge_code: code, edge_identifier: letter, is_used: used, notes: null, created_at: null, updated_at: null, version: 1, insert_id: insertId,
});
const EDGES = [
	edge(T.edgeId, T.insertId, T.edgeCode, 'A', true),
	edge(T.edge2Id, T.insertId, 'CNMG12-1-B', 'B', false),
	edge(T.edge3Id, T.insert2Id, 'CNMG12-2-A', 'A', false),
];
const OPERATION = { operation_id: 'op-1', pass_code: 'OP-TURN-7', operation_sequence: 1, operation_date: '2026-09-29', process_category: 'machining', sample_id: { sample_code: 'S-0042' } };

const answer = async (p: Promise<unknown>): Promise<true> => {
	await p;
	return true;
};

export interface RouteCtx {
	route: Route;
	req: Request;
	url: URL;
	path: string;
	method: string;
	cors: Record<string, string>;
	json: (data: unknown, status?: number) => Promise<void>;
	scans: StubScans;
}

/** Answers what the tooling pages, the Surface scans panel and the d1-surface-scan endpoint ask; false when the request is not theirs. */
export async function handleScanRoute(c: RouteCtx): Promise<boolean> {
	const { path, method, scans, json } = c;
	const raw = decodeURIComponent(c.url.search);

	if (path === '/d1-surface-scan/scans' && method === 'GET') {
		scans.listed.push(c.url.search);
		const edgeId = c.url.searchParams.get('edge_id');
		const insertId = c.url.searchParams.get('insert_id');
		if (!edgeId && !insertId) return answer(json({ errors: [{ message: 'insert_id or edge_id is required', extensions: { code: 'INVALID_QUERY' } }] }, 400));
		const rows = scans.rows.filter((r) => (r.edge_id !== null && r.edge_id === edgeId) || (r.insert_id !== null && r.insert_id === insertId));
		const out = rows.map(shapeRow);
		// A queued render moves on with every read of the list: pending, then rendering, then done.
		for (const r of scans.rows) {
			if (r.render_status === 'pending') r.render_status = 'rendering';
			else if (r.render_status === 'rendering') r.render_status = 'done';
		}
		return answer(json({ data: out }));
	}

	const ep = /^\/d1-surface-scan\/([^/]+)\/(meta|grid|thumb|render)$/.exec(path);
	if (ep) {
		const [, id, part] = ep;
		scans.endpoint.push(`${method} ${path}`);
		const row = scans.rows.find((r) => r.scan_id === id);
		if (part === 'render' && method === 'POST') {
			if (!row) return answer(json({ errors: [{ message: 'Not found', extensions: { code: 'ROUTE_NOT_FOUND' } }] }, 404));
			scans.renders.push(id);
			scans.objectMissing = scans.objectMissing.filter((m) => m !== id); // rendering again puts the files back
			row.render_status = 'pending';
			row.render_error = null;
			return answer(c.route.fulfill({ status: 204, headers: c.cors }));
		}
		if (method !== 'GET') return false;
		// The visibility rule runs first (before the 404 and the ETag branch): a locked scan answers 403 FILE_LOCKED, never cached.
		if (row?.locked) return answer(c.route.fulfill({ status: 403, headers: { ...c.cors, 'cache-control': 'no-store' }, json: { errors: [{ message: "This scan's file belongs to someone else.", extensions: { code: 'FILE_LOCKED' } }] } }));
		if (!row || row.render_status !== 'done') return answer(json({ errors: [{ message: 'Not found', extensions: { code: 'NOT_RENDERED' } }] }, 404));
		// A done scan whose files are gone from the object store (spec of the endpoint: 404 OBJECT_MISSING).
		if (scans.objectMissing.includes(id)) return answer(json({ errors: [{ message: 'The rendered data is missing; render the scan again.', extensions: { code: 'OBJECT_MISSING' } }] }, 404));
		const cache = { 'cache-control': 'private', etag: `"stub-${id}"` };
		if (part === 'meta') return answer(json(scans.scan.meta));
		if (part === 'grid') return answer(c.route.fulfill({ status: 200, headers: { ...c.cors, ...cache, 'content-type': 'application/octet-stream' }, body: scans.scan.grid }));
		return answer(c.route.fulfill({ status: 200, headers: { ...c.cors, ...cache, 'content-type': 'image/png' }, body: scans.scan.thumb }));
	}

	if (path === '/items/surface_scans' && method === 'POST') {
		const body = (c.req.postDataJSON() ?? {}) as Record<string, any>;
		scans.created.push(body);
		if (scans.refuseCreateGuard) {
			const reason = scans.refuseCreateGuard;
			scans.refuseCreateGuard = null;
			return answer(json({ errors: [{ message: reason, extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard', kind: 'junction', collection: 'surface_scans', parent: 'directus_files' } }] }, 403));
		}
		if (scans.refuseCreate) {
			const message = scans.refuseCreate;
			scans.refuseCreate = null;
			return answer(json({ errors: [{ message, extensions: { code: 'FORBIDDEN' } }] }, 403));
		}
		const file = STUB_LIBRARY.find((f) => f.id === body.directus_files_id);
		if (scans.rows.some((r) => r.directus_files_id.id === body.directus_files_id && (r.edge_id ?? r.insert_id) === (body.edge_id ?? body.insert_id))) {
			return answer(json({ errors: [{ message: 'Value for field "directus_files_id" in collection "surface_scans" has to be unique.', extensions: { code: 'RECORD_NOT_UNIQUE' } }] }, 400));
		}
		const row: StubScanRow = {
			scan_id: `scan-new-${scans.created.length}`, insert_id: body.insert_id ?? null, edge_id: body.edge_id ?? null, locked: false, condition: body.condition, condition_note: body.condition_note ?? null,
			scanned_on: body.scanned_on ?? null, notes: null, render_status: 'pending', render_error: null, version: 1,
			file: { id: body.directus_files_id, name: file?.filename_download ?? 'new.al3d' },
			operation: body.operation_id ? { id: body.operation_id, label: OPERATION.pass_code } : null, can_edit: true,
		};
		scans.rows.push(row);
		return answer(json({ data: { scan_id: row.scan_id } }));
	}

	if (path === '/files' && method === 'GET') {
		// Like Directus: the filter decides. Only the storage clause is evaluated here (the dialog always sends it).
		const onlyArchive = /\[storage\]\[_eq\]=star\b/.test(raw) || /"storage":\{"_eq":"star"\}/.test(raw);
		return answer(json({ data: STUB_LIBRARY.filter((f) => !onlyArchive || f.storage === 'star') }));
	}

	if (method !== 'GET') return false;
	const item = /^\/items\/(tool_boxes|cutting_inserts|insert_edges|manufacturing_operations)(?:\/([^/]+))?$/.exec(path);
	if (!item) return false;
	const [, collection, id] = item;
	const forbidden = () => answer(json({ errors: [{ extensions: { code: 'FORBIDDEN' } }] }, 403));
	if (collection === 'tool_boxes') return !id ? answer(json({ data: [BOX] })) : id === T.boxId ? answer(json({ data: BOX })) : forbidden();
	if (collection === 'cutting_inserts') {
		if (!id) return answer(json({ data: INSERTS }));
		const row = INSERTS.find((i) => i.insert_id === id);
		return row ? answer(json({ data: row })) : forbidden();
	}
	if (collection === 'insert_edges') {
		if (!id) return answer(json({ data: EDGES }));
		const row = EDGES.find((e) => e.edge_id === id);
		if (!row) return answer(json({ errors: [{ extensions: { code: 'FORBIDDEN' } }] }, 403));
		const parent = INSERTS.find((i) => i.insert_id === row.insert_id)!;
		return answer(json({ data: { ...row, insert_id: { insert_id: parent.insert_id, insert_code: parent.insert_code, tool_box_id: parent.tool_box_id } } }));
	}
	// manufacturing_operations: the one operation, for an edge's history and for the Add dialog's picker (the aggregate reads get nothing).
	if (raw.includes('aggregate')) return false;
	return answer(json({ data: raw.includes(T.edgeId) || raw.includes(T.insertId) ? [OPERATION] : [] }));
}
