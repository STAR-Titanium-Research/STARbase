// Directus endpoint: d1-surface-scan  (mounted at /d1-surface-scan)
//
// The server half of the surface-scan viewer (ADR-0021; spec docs/superpowers/specs/2026-10-15-surface-scans-design.md,
// "Derived data" and the routes below). A surface scan is one topography file of one cutting insert or insert edge
// (table surface_scans, migration 192); the surface-scan worker renders it into three objects in MinIO and fills the row.
// Browsers never reach MinIO: they ask here, and this endpoint serves the objects after reading the scan row as the caller.
//
//   GET  /d1-surface-scan/scans?insert_id=<uuid>&edge_id=<uuid>   (at least one; an edge page passes both)
//        -> { data: [ scan ] }, at most LIST_CAP rows, newest scanned_on first. A scan is a READABLE row when the caller may see its file,
//        { scan_id, insert_id, edge_id, locked: false, condition, scanned_on, operation: {id,label}|null, notes, condition_note,
//          added_by: {person_id,name}|null, file: {id,name}, render_status, render_error, rendered_at, grid: {width,height}|null, can_edit },
//        and a LOCKED row when they may not: { scan_id, insert_id, edge_id, locked: true, condition, scanned_on, operation } and nothing else
//        (not the file, notes, condition note, who added it, or anything about the render). 400 when neither id is given.
//   GET  /d1-surface-scan/:id/grid    -> the decimated height grid, float32 little-endian, micrometres, NaN = no data
//   GET  /d1-surface-scan/:id/meta    -> meta.json (width, height, pixel pitch, z range, source size and format, decimation)
//   GET  /d1-surface-scan/:id/thumb   -> thumb.png (height map, at most 320 px)
//        200 with ETag "<cache_key>" and Cache-Control: private, no-cache (the browser keeps the object but asks every time, so
//        a change of permissions or of the render shows at once; an unchanged object answers 304 to If-None-Match);
//        403 FILE_LOCKED for a scan whose file the caller may not see, decided BEFORE the ETag/304 branch and before anything is said
//        about the render; 404 while render_status is not 'done', and for a scan the caller cannot read at all (the same answer, so it
//        does not say which scans exist); 502 when MinIO cannot be reached or refuses the reader; 503 while MinIO is not configured on
//        this server. Every error reply carries Cache-Control: no-store and no ETag.
//        ACCESS LOG: an administrator's GRID read (the 3D open) of a scan a member in their place could not read (the file is owned, and they are
//        not one of its readers) writes one row in d1_private.surface_scan_access_log (scan, file, administrator, reason admin_read) before
//        anything is sent; a failed log row is a 500 and no data. Not a general audit: meta, thumb, the list, /assets and Data Studio are not logged.
//   POST /d1-surface-scan/:id/render  -> 200 { data: { scan_id, render_status: 'pending' } }
//        "Render again": sets render_status = 'pending' as the caller (needs update permission on the scan, which carries the file
//        filter, 403 otherwise; 403 FILE_LOCKED first for a file they may not see) and clears the PRIVATE render_error in the same
//        transaction. From any state but pending: a scan stuck in 'rendering' (a worker that died) can be queued again too. Already
//        pending: nothing is written.
//   POST /d1-surface-scan/:id/result  -> 200 { data: { scan_id, render_status, version } }   ADMINISTRATORS ONLY (403 otherwise)
//        The worker's report, { version, render_status: 'done'|'failed', render_error?, columns? } with columns = { cache_key, source_format,
//        source_width, source_height, grid_width, grid_height, pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um, rendered_at? }.
//        400 INVALID_PAYLOAD (extensions.field) for a wrong type or a cache_key that is not a plain name; 409 VERSION_CONFLICT when the row
//        is not 'rendering' at that version. One transaction: the row is claimed, d1_private.surface_scan_renders is upserted.
//
// THE visibility rule (ADR-0023, canSeeFile), used by every route: the caller may see a scan's file when they are an administrator, or the file
// has no owner (directus_files.owner_person_id and owner_team_id both null), or file_readers has a row for (file, the caller's login).
// Where the data lives (migration 205): the link facts stay on surface_scans, the file-derived render values (cache_key, render_error,
// rendered_at, source_*, grid_*, pixel_pitch_*, z_*) are in d1_private.surface_scan_renders, which only this endpoint reads. A member cannot read
// directus_files_id, notes or render_status through Directus, so after the row permission is checked as the caller this endpoint reads those
// with the database, once the rule has said the caller may see the file.
//
// Every route needs a signed-in user (401 otherwise). Errors have the Directus shape
// { errors: [{ message, extensions: { code, source: 'd1-surface-scan' } }] }.
//
// How it runs (the d1-build pattern):
//   * The row permission is checked, and the rows and the operation label are read, through Directus's ItemsService with req.accountability,
//     so permissions and hooks apply exactly as for any other read or save. Writes (Render again) go through ItemsService too.
//   * The object key is built here from the private row's cache_key (surface-scans/<cache_key>/<grid.bin|meta.json|thumb.png>). The
//     worker writes it, but it is checked to be a plain name before it is used: a hand-edited value can never climb out of the prefix or
//     reach another object (objectStore.js refuses any key outside it as well).
//   * Every write transaction starts with set_config('d1.actor_identity', <caller>, true), so the audit trigger names the caller.
//   * Testable without Directus or MinIO: mount(router, { database, services, getSchema, logger, env }, store) takes
//     everything it uses; the store is the small module objectStore.js (a fake in the tests).
// No build step (the d1-usage pattern): Directus loads these files as they are.

import { pipeline } from 'node:stream/promises';

import { createObjectStore, PREFIX } from './objectStore.js';

const SOURCE = 'd1-surface-scan';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What the three routes serve: the object's file name under surface-scans/<cache_key>/ and its content type.
export const OBJECTS = {
	grid: { file: 'grid.bin', type: 'application/octet-stream' },
	meta: { file: 'meta.json', type: 'application/json; charset=utf-8' },
	thumb: { file: 'thumb.png', type: 'image/png' },
};
export { PREFIX };
export const CACHE_CONTROL = 'private, no-cache';
// The most scans one GET /scans answers (an item has a handful; the cap only keeps a runaway row count from becoming a huge reply).
export const LIST_CAP = 200;
// Lab Viewer role id (scripts/access_rules.json "viewer.role", the same constant as d1-record-access): the role reads and changes nothing.
export const LAB_VIEWER_ROLE_ID = '10000001-0000-0000-0000-000000000003';
// The columns of surface_scans a member may read through Directus (migration 205: the link facts only). The caller's row permission is
// checked by reading these AS the caller; everything else (the file, notes, render state) is read here with the database, after the
// visibility rule has said the caller may see it.
const PUBLIC_FIELDS = ['scan_id', 'insert_id', 'edge_id', 'condition', 'scanned_on', 'operation_id'];
const LIST_SORT = ['-scanned_on', '-created_at'];
const OPERATION_FIELDS = ['operation_id', 'pass_code'];
const OPERATION_FALLBACK = 'Operation';

// The private render row, in the order resultUpsert binds it: the error of a failed render, when it finished, the cache key and what the file said.
const RESULT_COLUMNS = [
	'render_error', 'rendered_at', 'cache_key', 'source_format', 'source_width', 'source_height', 'grid_width', 'grid_height',
	'pixel_pitch_x_um', 'pixel_pitch_y_um', 'z_min_um', 'z_max_um',
];
const RENDER_ERROR_MAX = 2000;
const INT_MAX = 2147483647;

// The SQL this endpoint sends (one place, so the tests and the migration can be checked against it). The file's owner columns and the
// caller's file_readers row come with every scan row: they are the whole input of the visibility rule (canSeeFile).
//   scanDetail   one scan, bindings [caller user, scan id]
//   scanDetails  many scans, bindings [caller user, scan ids as one csv]
//   accessLog    one administrator grid read of a file they could not read as a member, bindings [scan, file, administrator, reason]
//   renderErrorClear / resultClaim / resultUpsert   the private render row (d1_private.surface_scan_renders, migration 205)
const SCAN_COLUMNS = `s.scan_id, s.insert_id, s.edge_id, s.directus_files_id, s.condition_note, s.notes, s.render_status, s.version, s.owner_person_id,
       f.filename_download, f.title, f.owner_person_id AS file_owner_person_id, f.owner_team_id AS file_owner_team_id,
       EXISTS (SELECT 1 FROM file_readers fr WHERE fr.directus_files_id = s.directus_files_id AND fr.user_id = ?) AS is_reader,
       r.cache_key, r.render_error, r.rendered_at, r.grid_width, r.grid_height, p.full_name AS added_by_name`;
const SCAN_JOINS = `FROM surface_scans s
  LEFT JOIN directus_files f ON f.id = s.directus_files_id
  LEFT JOIN d1_private.surface_scan_renders r ON r.scan_id = s.scan_id
  LEFT JOIN people p ON p.person_id = s.owner_person_id`;
export const SQL = {
	setActor: "SELECT set_config('d1.actor_identity', ?, true)",
	scanDetail: `SELECT ${SCAN_COLUMNS}\n  ${SCAN_JOINS}\n WHERE s.scan_id = ?`,
	accessLog: 'INSERT INTO d1_private.surface_scan_access_log (scan_id, directus_files_id, read_by_user, reason) VALUES (?, ?, ?, ?)',
	// The worker's report: claim the row (only a row the worker still holds, 'rendering', at the version it read; the OCC trigger bumps version), then
	// upsert the private row. Bindings: [render_status, scan, version] and [scan, ...RESULT_COLUMNS in order].
	resultClaim: "UPDATE surface_scans SET render_status = ? WHERE scan_id = ? AND version = ? AND render_status = 'rendering' RETURNING scan_id, render_status, version",
	resultUpsert: `INSERT INTO d1_private.surface_scan_renders (scan_id, ${RESULT_COLUMNS.join(', ')}, updated_at)
VALUES (?, ${RESULT_COLUMNS.map(() => '?').join(', ')}, now())
ON CONFLICT (scan_id) DO UPDATE SET ${RESULT_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
	renderErrorClear: 'UPDATE d1_private.surface_scan_renders SET render_error = NULL, updated_at = now() WHERE scan_id = ?',
	scanDetails: `SELECT ${SCAN_COLUMNS}\n  ${SCAN_JOINS}\n WHERE s.scan_id = ANY(string_to_array(?, ',')::uuid[])`,
};

// Why an access-log row was written (the d1-inbox sem-settings log says the same).
export const ADMIN_READ_REASON = 'admin_read';

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const rowsOf = (out) => out?.rows ?? [];
const toIso = (v) => (v instanceof Date ? v.toISOString() : isBlank(v) ? null : String(v));
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

// THE visibility rule, used by every route here: the caller may see a scan's file when they are an administrator, or the file has no owner
// (owner_person_id and owner_team_id both null: unowned and legacy files stay open, ADR-0022 decision 5), or file_readers has a row for the
// (file, caller's login). `file` is a row of SQL.scanDetail(s): the owner columns of directus_files and is_reader. A scan whose file row is
// gone (the foreign key cascades, so this does not happen) is not visible to a member.
export function canSeeFile(admin, file) {
	if (admin === true) return true;
	if (!file || file.directus_files_id == null) return false;
	const owned = !isBlank(file.file_owner_person_id) || !isBlank(file.file_owner_team_id);
	return !owned || file.is_reader === true;
}
// An administrator reading a file a member in their place could not: the only reads that are logged (grid reads, ADR-0023 decision 5).
export const isAdminOverride = (admin, file) => admin === true && !canSeeFile(false, file);
export function isViewerAccountability(acc) {
	const ids = [acc?.role, ...(Array.isArray(acc?.roles) ? acc.roles : [])].filter((id) => typeof id === 'string');
	return ids.some((id) => id.toLowerCase() === LAB_VIEWER_ROLE_ID);
}

const invalid = (message, field) => new HttpError(400, 'INVALID_PAYLOAD', message, field ? { field } : {});
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// POST /:id/result body: { version, render_status: 'done'|'failed', render_error?, columns? }. Returns the values to store, in RESULT_COLUMNS order.
//   done:   columns required, with a valid cache_key; every other column optional (a number of the right kind, or null); render_error absent or null.
//   failed: render_error optional text (kept to RENDER_ERROR_MAX characters), no columns; every derived value is stored as NULL.
// Anything else (an unknown key, a string for a number, a negative size) is a 400 INVALID_PAYLOAD naming the field, so a worker bug fails loudly.
export function parseResult(body, now = new Date()) {
	if (!isObject(body)) throw invalid('Send a JSON object.');
	const unknown = Object.keys(body).filter((k) => !['version', 'render_status', 'render_error', 'columns'].includes(k));
	if (unknown.length) throw invalid(`Unknown field: ${unknown[0]}.`, unknown[0]);
	if (!Number.isInteger(body.version) || body.version < 1 || body.version > INT_MAX) throw invalid('version must be the whole number you read.', 'version');
	if (body.render_status !== 'done' && body.render_status !== 'failed') throw invalid("render_status must be 'done' or 'failed'.", 'render_status');
	let error = null;
	if (!isBlank(body.render_error)) {
		if (typeof body.render_error !== 'string') throw invalid('render_error must be text.', 'render_error');
		error = body.render_error.trim().slice(0, RENDER_ERROR_MAX);
	}
	const out = Object.fromEntries(RESULT_COLUMNS.map((c) => [c, null]));
	if (body.render_status === 'failed') {
		if (body.columns !== undefined && body.columns !== null) throw invalid('A failed render has no columns.', 'columns');
		out.render_error = error;
		return { version: body.version, render_status: 'failed', values: RESULT_COLUMNS.map((c) => out[c]) };
	}
	if (error !== null) throw invalid('A finished render has no render_error.', 'render_error');
	const cols = body.columns;
	if (!isObject(cols)) throw invalid('columns is required for a finished render.', 'columns');
	const allowed = RESULT_COLUMNS.filter((c) => c !== 'render_error');
	const extra = Object.keys(cols).filter((k) => !allowed.includes(k));
	if (extra.length) throw invalid(`Unknown column: ${extra[0]}.`, `columns.${extra[0]}`);
	if (!validCacheKey(cols.cache_key)) throw invalid('cache_key must be a plain name (letters, digits, dot, dash, underscore).', 'columns.cache_key');
	out.cache_key = cols.cache_key;
	const ifSet = (name, check, what) => {
		const v = cols[name];
		if (v === undefined || v === null) return null;
		if (!check(v)) throw invalid(`${name} must be ${what}.`, `columns.${name}`);
		return v;
	};
	const wholeNumber = (v) => Number.isInteger(v) && v >= 1 && v <= INT_MAX;
	const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e12;
	const height = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e12;
	out.source_format = ifSet('source_format', (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 100, 'a name of at most 100 characters');
	for (const c of ['source_width', 'source_height', 'grid_width', 'grid_height']) out[c] = ifSet(c, wholeNumber, 'a whole number of at least 1');
	for (const c of ['pixel_pitch_x_um', 'pixel_pitch_y_um']) out[c] = ifSet(c, positive, 'a positive number');
	for (const c of ['z_min_um', 'z_max_um']) out[c] = ifSet(c, height, 'a number');
	if (out.z_min_um !== null && out.z_max_um !== null && out.z_min_um > out.z_max_um) throw invalid('z_min_um is above z_max_um.', 'columns.z_min_um');
	let at = now;
	if (cols.rendered_at !== undefined && cols.rendered_at !== null) {
		at = typeof cols.rendered_at === 'string' ? new Date(cols.rendered_at) : null;
		if (!at || Number.isNaN(at.getTime())) throw invalid('rendered_at must be a time (ISO 8601).', 'columns.rendered_at');
	}
	out.rendered_at = at.toISOString();
	return { version: body.version, render_status: 'done', values: RESULT_COLUMNS.map((c) => out[c]) };
}

const fileName = (row) => (isBlank(row.filename_download) ? (isBlank(row.title) ? '(file)' : row.title) : row.filename_download);

// GET /scans, one row. `base` is the row read as the caller (the link facts), `detail` the database row (or undefined), `operation` the label
// the caller could read. A LOCKED row has the facts about the shared insert or edge and nothing else: not the file, notes, condition note, who
// added it or anything about the render. A readable row has everything; can_edit is the update rule (the file is visible) minus the Lab Viewer.
export function shapeScan(base, detail, { admin, viewer, operation }) {
	const head = { scan_id: base.scan_id, insert_id: base.insert_id ?? null, edge_id: base.edge_id ?? null };
	const facts = { condition: base.condition ?? null, scanned_on: toIso(base.scanned_on), operation: operation ?? null };
	if (!detail || !canSeeFile(admin, detail)) return { ...head, locked: true, ...facts };
	const grid = detail.grid_width != null && detail.grid_height != null ? { width: Number(detail.grid_width), height: Number(detail.grid_height) } : null;
	return {
		...head,
		locked: false,
		...facts,
		notes: detail.notes ?? null,
		condition_note: detail.condition_note ?? null,
		added_by: isBlank(detail.owner_person_id) ? null : { person_id: detail.owner_person_id, name: detail.added_by_name ?? null },
		file: { id: detail.directus_files_id, name: fileName(detail) },
		render_status: detail.render_status ?? null,
		render_error: detail.render_error ?? null,
		rendered_at: toIso(detail.rendered_at),
		grid,
		can_edit: !viewer,
	};
}

export class HttpError extends Error {
	constructor(status, code, message, extra = {}) {
		super(message);
		this.status = status;
		this.code = code;
		this.extra = extra;
	}
}

// The worker's cache keys are a content hash (64 hex) or p-<directus_files_id>-<size>-<mtime>: letters, digits, dot, dash,
// underscore. No slash, nothing that starts with a dot, no "..": a name, never a path.
export function validCacheKey(key) {
	return typeof key === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(key) && !key.includes('..');
}

export function objectKey(cacheKey, object) {
	if (!validCacheKey(cacheKey) || !Object.hasOwn(OBJECTS, object)) return null;
	return `${PREFIX}${cacheKey}/${OBJECTS[object].file}`;
}

export const etagOf = (cacheKey) => `"${cacheKey}"`;

// If-None-Match against one strong ETag: a list, weak validators (W/"x") and * all count.
export function matchesEtag(header, etag) {
	if (typeof header !== 'string' || !header.trim()) return false;
	if (header.trim() === '*') return true;
	return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

export function mount(router, context, store) {
	const { database, logger, services, getSchema } = context;
	const env = context.env ?? {};

	const sendError = (res, err) => {
		const known = err instanceof HttpError;
		if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
		if (res.headersSent) return res.destroy?.(err);
		// No ETag here and never a cached error: the cache key does not change when a scan is rendered again, so a
		// browser that kept a 404 would go on showing it.
		res.set('Cache-Control', 'no-store');
		return res.status(known ? err.status : 500).json({
			errors: [{
				message: known ? err.message : 'Something went wrong on the server.',
				extensions: { ...(known ? err.extra : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
			}],
		});
	};
	// Routes: need a signed-in user, hand the handler the request, turn every failure into a Directus-shaped answer.
	const route = (fn) => async (req, res) => {
		try {
			const acc = req.accountability;
			if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
			await fn({ req, res, acc });
		} catch (err) {
			sendError(res, err);
		}
	};
	const idParam = (req) => {
		const id = req.params?.id;
		if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', 'That surface scan does not exist.');
		return id.toLowerCase();
	};

	const queryUuid = (req, name) => {
		const v = req.query?.[name];
		if (v === undefined || v === null || v === '') return null;
		if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, 'INVALID_PAYLOAD', `${name} must be an id.`);
		return v.toLowerCase();
	};
	// The label of each operation the caller may read (pass_code), read as the caller: one they may not read keeps the bare id with a generic label.
	async function operationLabels(schema, acc, ids) {
		const wanted = [...new Set(ids.filter(Boolean))];
		const labels = new Map();
		if (wanted.length === 0) return labels;
		try {
			const rows = await new services.ItemsService('manufacturing_operations', { schema, accountability: acc })
				.readByQuery({ filter: { operation_id: { _in: wanted } }, fields: OPERATION_FIELDS, limit: -1 });
			for (const o of Array.isArray(rows) ? rows : []) labels.set(o.operation_id, { id: o.operation_id, label: isBlank(o.pass_code) ? OPERATION_FALLBACK : String(o.pass_code) });
		} catch (err) {
			if (!isDenied(err)) throw err;
		}
		return labels;
	}
	// Every write transaction names the person first, so the audit trigger knows who.
	const inTransaction = (userId, work) =>
		database.transaction(async (trx) => {
			await trx.raw(SQL.setActor, [String(userId)]);
			return work(trx);
		});
	const isDenied = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
	const schemaOf = async (req) => req.schema ?? (await getSchema());
	const itemsFor = (schema, acc, knex) =>
		new services.ItemsService('surface_scans', { schema, accountability: acc, ...(knex ? { knex } : {}) });
	// The scan as the caller may read it: the row permission is checked as the caller (the link facts, through ItemsService; a scan they cannot read
	// and one that does not exist are the same 404), then the database row with the file's owner columns and the caller's file_readers row.
	async function readScan(req, acc, id) {
		try {
			const row = await itemsFor(await schemaOf(req), acc).readOne(id, { fields: ['scan_id'] });
			if (!row) throw new HttpError(404, 'NOT_FOUND', 'That surface scan does not exist.');
		} catch (err) {
			if (isDenied(err) || err?.status === 404 || err?.code === 'ROUTE_NOT_FOUND') {
				throw new HttpError(404, 'NOT_FOUND', 'That surface scan does not exist.');
			}
			throw err;
		}
		const [detail] = rowsOf(await database.raw(SQL.scanDetail, [String(acc.user), id]));
		if (!detail) throw new HttpError(404, 'NOT_FOUND', 'That surface scan does not exist.');
		return detail;
	}
	// The visibility rule, before anything else is said about the scan: 403 FILE_LOCKED (no-store, no ETag, like every error here).
	const requireVisible = (acc, detail) => {
		if (!canSeeFile(acc.admin === true, detail)) {
			throw new HttpError(403, 'FILE_LOCKED', 'This scan\'s file belongs to someone else, so it cannot be shown.');
		}
	};

	// GET /scans?insert_id=<uuid>&edge_id=<uuid>: the scans of an insert and/or an edge (an edge page passes both), as the list the panel shows.
	// The rows (and so the row permission, and the operation label) are read AS THE CALLER through ItemsService, for the link facts a member may
	// read; what hangs off the file (file, notes, adder, render) is read with the database and handed out only for a scan whose file the caller
	// may see (canSeeFile). A scan whose file they may not see is still a row, as a locked placeholder (ADR-0023 decision 2).
	router.get('/scans', route(async ({ req, res, acc }) => {
		const insertId = queryUuid(req, 'insert_id');
		const edgeId = queryUuid(req, 'edge_id');
		if (!insertId && !edgeId) throw new HttpError(400, 'INVALID_PAYLOAD', 'Give insert_id, edge_id or both.');
		const clauses = [];
		if (insertId) clauses.push({ insert_id: { _eq: insertId } });
		if (edgeId) clauses.push({ edge_id: { _eq: edgeId } });
		const schema = await schemaOf(req);
		let bases;
		try {
			bases = await itemsFor(schema, acc).readByQuery({
				filter: clauses.length === 1 ? clauses[0] : { _or: clauses },
				fields: PUBLIC_FIELDS,
				sort: LIST_SORT,
				limit: LIST_CAP,
			});
		} catch (err) {
			if (isDenied(err)) throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to read surface scans.');
			throw err;
		}
		bases = Array.isArray(bases) ? bases : [];
		if (bases.length === 0) return res.json({ data: [] });
		const details = new Map(rowsOf(await database.raw(SQL.scanDetails, [String(acc.user), bases.map((b) => b.scan_id).join(',')])).map((d) => [d.scan_id, d]));
		const operations = await operationLabels(schema, acc, bases.map((b) => b.operation_id));
		const admin = acc.admin === true;
		const viewer = isViewerAccountability(acc);
		res.json({
			data: bases.map((b) => shapeScan(b, details.get(b.scan_id), { admin, viewer, operation: b.operation_id ? operations.get(b.operation_id) ?? { id: b.operation_id, label: OPERATION_FALLBACK } : null })),
		});
	}));

	for (const object of Object.keys(OBJECTS)) {
		router.get(`/:id/${object}`, route(async ({ req, res, acc }) => {
			const id = idParam(req);
			const scan = await readScan(req, acc, id);
			// the lock comes BEFORE everything that says anything about the scan (its render state, its ETag, a 304)
			requireVisible(acc, scan);
			if (scan.render_status !== 'done') {
				throw new HttpError(404, 'NOT_RENDERED', 'That surface scan has not been rendered yet.', { render_status: scan.render_status ?? null });
			}
			const key = objectKey(scan.cache_key, object);
			if (!key) throw new HttpError(404, 'NOT_RENDERED', 'That surface scan has no rendered data.', { render_status: scan.render_status });
			if (!store) throw new HttpError(503, 'STORE_UNCONFIGURED', 'The object store is not configured on this server (MINIO_ENDPOINT).');

			// An administrator opening (the grid of) a scan a member in their place could not read is logged BEFORE anything is sent, the 304 included
			// (it confirms a read): a failed log is a 500 and no data. Only the grid read is logged, which is the 3D open; the thumbnail, the meta,
			// the list, /assets and Data Studio are not (ADR-0023 decision 5: not a general audit).
			if (object === 'grid' && isAdminOverride(acc.admin === true, scan)) {
				await inTransaction(acc.user, (trx) => trx.raw(SQL.accessLog, [id, scan.directus_files_id, String(acc.user), ADMIN_READ_REASON]));
			}

			// ETag and Cache-Control private go on the 200 and the 304 only (an error reply must not be cached).
			const etag = etagOf(scan.cache_key);
			if (matchesEtag(req.headers?.['if-none-match'], etag)) {
				res.set('Cache-Control', CACHE_CONTROL);
				res.set('ETag', etag);
				return res.status(304).end();
			}

			// Stop the download from MinIO when the browser goes away.
			const abort = new AbortController();
			res.on?.('close', () => { if (!res.writableFinished) abort.abort(); });
			let found;
			try {
				found = await store.get(key, { signal: abort.signal });
			} catch (err) {
				logger?.warn?.(`${SOURCE}: object store failed for ${key}: ${err?.message || err}`);
				throw new HttpError(502, 'STORE_UNAVAILABLE', 'The rendered data could not be fetched from the object store.');
			}
			if (!found) throw new HttpError(404, 'OBJECT_MISSING', 'The rendered data is missing; render the scan again.');

			res.status(200);
			res.set('Cache-Control', CACHE_CONTROL);
			res.set('ETag', etag);
			res.set('X-Content-Type-Options', 'nosniff');
			res.set('Content-Type', OBJECTS[object].type);
			if (found.size != null) res.set('Content-Length', String(found.size));
			try {
				await pipeline(found.body, res);
			} catch (err) {
				// The headers are gone: all that is left is to cut the connection (a closed tab is not worth a log line).
				if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger?.warn?.(`${SOURCE}: streaming ${key} failed: ${err?.message || err}`);
				res.destroy?.();
			}
		}));
	}

	router.post('/:id/render', route(async ({ req, res, acc }) => {
		const id = idParam(req);
		const scan = await readScan(req, acc, id);
		// a scan whose file the caller may not see is not theirs to queue (the update below enforces the same file filter as a second line)
		requireVisible(acc, scan);
		if (scan.render_status !== 'pending') {
			try {
				const schema = await schemaOf(req);
				await inTransaction(acc.user, async (trx) => {
					await itemsFor(schema, acc, trx).updateOne(id, { render_status: 'pending' });
					// the error of the last render is private (d1_private.surface_scan_renders): cleared in the same transaction
					await trx.raw(SQL.renderErrorClear, [id]);
				});
			} catch (err) {
				if (isDenied(err)) throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to change that surface scan.');
				throw err;
			}
			await clearDataCache(req);
		}
		res.json({ data: { scan_id: id, render_status: 'pending' } });
	}));

	// POST /:id/result: the worker reports a render (done with its columns, or failed with an error), ADMINISTRATORS ONLY (the worker's machine
	// user is one). The render columns are private now, so this is the only way they are written. One transaction names the actor, claims the row
	// (render_status 'rendering' and the version the worker read, else 409 VERSION_CONFLICT: somebody queued it again, the worker rereads and
	// retries) and upserts d1_private.surface_scan_renders. The Directus data cache is cleared after the commit (render_status is a public column).
	router.post('/:id/result', route(async ({ req, res, acc }) => {
		if (acc.admin !== true) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator can report a render result.');
		const id = idParam(req);
		const result = parseResult(req.body);
		const row = await inTransaction(acc.user, async (trx) => {
			const [claimed] = rowsOf(await trx.raw(SQL.resultClaim, [result.render_status, id, result.version]));
			if (!claimed) {
				throw new HttpError(409, 'VERSION_CONFLICT', 'The scan changed since you read it (or is no longer rendering). Read it again.');
			}
			await trx.raw(SQL.resultUpsert, [id, ...result.values]);
			return claimed;
		});
		await clearDataCache(req);
		res.json({ data: { scan_id: row.scan_id, render_status: row.render_status, version: row.version } });
	}));

	// Knex writes bypass the Directus services that clear the data cache, and ItemsService only does so when it owns the
	// transaction, so clear it after the commit (as d1-build and d1-record-access do).
	async function clearDataCache(req) {
		const on = env.CACHE_ENABLED === true || env.CACHE_ENABLED === 'true' || env.CACHE_ENABLED === 1 || env.CACHE_ENABLED === '1';
		if (!on) return;
		try {
			const schema = await schemaOf(req);
			await new services.UtilsService({ schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
		} catch (err) {
			logger?.warn?.(`${SOURCE}: could not clear the data cache: ${err?.message || err}`);
		}
	}
}

export default {
	id: SOURCE,
	handler: (router, context) => mount(router, context, createObjectStore(context.env)),
};
