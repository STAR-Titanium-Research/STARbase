// Directus endpoint: d1-surface-scan  (mounted at /d1-surface-scan)
//
// The server half of the surface-scan viewer (ADR-0021; spec docs/superpowers/specs/2026-10-15-surface-scans-design.md,
// "Derived data" and the routes below). A surface scan is one topography file of one cutting insert or insert edge
// (table surface_scans, migration 192); the surface-scan worker renders it into three objects in MinIO and fills the row.
// Browsers never reach MinIO: they ask here, and this endpoint serves the objects after reading the scan row as the caller.
//
//   GET  /d1-surface-scan/:id/grid    -> the decimated height grid, float32 little-endian, micrometres, NaN = no data
//   GET  /d1-surface-scan/:id/meta    -> meta.json (width, height, pixel pitch, z range, source size and format, decimation)
//   GET  /d1-surface-scan/:id/thumb   -> thumb.png (height map, at most 320 px)
//        200 with ETag "<cache_key>" and Cache-Control: private, no-cache (the browser keeps the object but asks every time, so
//        a change of permissions or of the render shows at once; an unchanged object answers 304 to If-None-Match);
//        404 while render_status is not 'done', and for a scan the caller cannot read (the same answer, so it does not say
//        which scans exist); 502 when MinIO cannot be reached; 503 while MinIO is not configured on this server.
//   POST /d1-surface-scan/:id/render  -> 200 { data: { scan_id, render_status: 'pending' } }
//        "Render again": sets render_status = 'pending' and clears render_error, as the caller (needs update permission on
//        the scan, 403 otherwise). From any state but pending: a scan stuck in 'rendering' (a worker that died) can be
//        queued again too. Already pending: nothing is written.
//
// Every route needs a signed-in user (401 otherwise). Errors have the Directus shape
// { errors: [{ message, extensions: { code, source: 'd1-surface-scan' } }] }.
//
// How it runs (the d1-build pattern):
//   * The scan row is read, and written, through Directus's ItemsService with req.accountability, so permissions and hooks
//     apply exactly as for any other read or save (reference data: every Lab Member and Lab Viewer reads, ADR-0011).
//   * The object key is built here from the row's cache_key (surface-scans/<cache_key>/<grid.bin|meta.json|thumb.png>). The
//     row is writable by every member, so cache_key is checked to be a plain name before it is used: a hand-edited value can
//     never climb out of the prefix or reach another object (objectStore.js refuses any key outside it as well).
//   * The write transaction starts with set_config('d1.actor_identity', <caller>, true), so the audit trigger names the caller.
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
const READ_FIELDS = ['scan_id', 'render_status', 'cache_key'];

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

	const isDenied = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
	const schemaOf = async (req) => req.schema ?? (await getSchema());
	const itemsFor = (schema, acc, knex) =>
		new services.ItemsService('surface_scans', { schema, accountability: acc, ...(knex ? { knex } : {}) });
	// The scan row as the caller may read it. A scan the caller cannot read and one that does not exist are the same 404.
	async function readScan(req, acc, id) {
		const items = itemsFor(await schemaOf(req), acc);
		try {
			const row = await items.readOne(id, { fields: READ_FIELDS });
			if (!row) throw new HttpError(404, 'NOT_FOUND', 'That surface scan does not exist.');
			return row;
		} catch (err) {
			if (isDenied(err) || err?.status === 404 || err?.code === 'ROUTE_NOT_FOUND') {
				throw new HttpError(404, 'NOT_FOUND', 'That surface scan does not exist.');
			}
			throw err;
		}
	}

	for (const object of Object.keys(OBJECTS)) {
		router.get(`/:id/${object}`, route(async ({ req, res, acc }) => {
			const id = idParam(req);
			const scan = await readScan(req, acc, id);
			if (scan.render_status !== 'done') {
				throw new HttpError(404, 'NOT_RENDERED', 'That surface scan has not been rendered yet.', { render_status: scan.render_status ?? null });
			}
			const key = objectKey(scan.cache_key, object);
			if (!key) throw new HttpError(404, 'NOT_RENDERED', 'That surface scan has no rendered data.', { render_status: scan.render_status });
			if (!store) throw new HttpError(503, 'STORE_UNCONFIGURED', 'The object store is not configured on this server (MINIO_ENDPOINT).');

			const etag = etagOf(scan.cache_key);
			res.set('Cache-Control', CACHE_CONTROL);
			res.set('ETag', etag);
			res.set('X-Content-Type-Options', 'nosniff');
			if (matchesEtag(req.headers?.['if-none-match'], etag)) return res.status(304).end();

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
		if (scan.render_status !== 'pending') {
			try {
				const schema = await schemaOf(req);
				await database.transaction(async (trx) => {
					await trx.raw("SELECT set_config('d1.actor_identity', ?, true)", [String(acc.user)]);
					await itemsFor(schema, acc, trx).updateOne(id, { render_status: 'pending', render_error: null });
				});
			} catch (err) {
				if (isDenied(err)) throw new HttpError(403, 'FORBIDDEN', 'You are not allowed to change that surface scan.');
				throw err;
			}
			await clearDataCache(req);
		}
		res.json({ data: { scan_id: id, render_status: 'pending' } });
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
