// Run with: node --test core/extensions/d1-surface-scan/index.test.mjs   (CI's lint job runs every core/extensions/*/index.test.mjs)
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

import endpoint, { CACHE_CONTROL, OBJECTS, etagOf, matchesEtag, mount, objectKey, validCacheKey } from './index.js';
import { PREFIX, createObjectStore, safeKey, signGet } from './objectStore.js';

// ---- fakes -----------------------------------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALICE = ID(1);
const SCAN = ID(10);
const HASH = 'a'.repeat(64);
const GRID = Buffer.from([0, 0, 128, 63, 0, 0, 192, 127]); // 1.0 and NaN as float32 little-endian

// An Express-ish router that remembers its handlers, and a response that is a real Writable (the endpoint pipes into it).
function fakeRouter() {
	const routes = new Map();
	const add = (method) => (path, fn) => routes.set(`${method} ${path}`, fn);
	return { routes, get: add('GET'), post: add('POST') };
}
class FakeRes extends Writable {
	constructor() {
		super();
		this.statusCode = 200;
		this.headers = {};
		this.chunks = [];
		this.body = undefined;
		this.headersSent = false;
		this.destroyedBy = undefined;
	}
	_write(chunk, _enc, cb) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); cb(); }
	status(code) { this.statusCode = code; return this; }
	set(k, v) { this.headers[k] = v; return this; }
	json(b) { this.body = b; this.headersSent = true; this.end(); return this; }
	get bytes() { return Buffer.concat(this.chunks); }
	destroy(err) { this.destroyedBy = err ?? true; return super.destroy(err); }
}

// The scan rows the caller may read, behind a fake ItemsService: readOne throws Directus's FORBIDDEN for a row it may not read.
function fakeWorld() {
	return { rows: new Map(), hidden: new Set(), updateDenied: false, ops: [], built: [], reads: [], raw: [], txs: 0, cacheCleared: 0 };
}
function fakeServices(world) {
	class ItemsService {
		constructor(collection, options) {
			this.collection = collection;
			this.options = options;
			world.built.push({ collection, options });
		}
		async readOne(id, query) {
			world.reads.push({ collection: this.collection, id, query, accountability: this.options.accountability });
			const row = world.rows.get(id);
			if (!row || world.hidden.has(id)) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
			return Object.fromEntries(query.fields.map((f) => [f, row[f]]));
		}
		async updateOne(id, data) {
			if (world.updateDenied) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
			Object.assign(world.rows.get(id), data);
			world.ops.push({ op: 'update', id, data, knex: this.options.knex, accountability: this.options.accountability });
			return id;
		}
	}
	class UtilsService {
		async clearCache() { world.cacheCleared += 1; }
	}
	return { ItemsService, UtilsService };
}
const fakeDatabase = (world) => ({
	transaction: async (work) => {
		world.txs += 1;
		const trx = { raw: async (sql, bindings) => { world.raw.push({ sql, bindings }); } };
		return work(trx);
	},
});
function fakeStore(objects = {}, { fail = null } = {}) {
	const calls = [];
	return {
		calls,
		async get(key, options) {
			calls.push({ key, options });
			if (fail) throw fail;
			const bytes = objects[key];
			if (!bytes) return null;
			return { body: Readable.from([bytes]), size: bytes.length };
		},
	};
}
const WARNINGS = [];
const logger = { warn: (m) => WARNINGS.push(m), error: (m) => WARNINGS.push(m) };

// Mounts the endpoint on a fake router over a world of one done scan, and returns a caller for its routes.
function setup({ store = fakeStore({ [`${PREFIX}${HASH}/grid.bin`]: GRID, [`${PREFIX}${HASH}/meta.json`]: Buffer.from('{"width":2}'), [`${PREFIX}${HASH}/thumb.png`]: Buffer.from([137, 80, 78, 71]) }), env = {}, row } = {}) {
	const world = fakeWorld();
	world.rows.set(SCAN, { scan_id: SCAN, render_status: 'done', cache_key: HASH, render_error: null, ...row });
	const router = fakeRouter();
	mount(router, { database: fakeDatabase(world), services: fakeServices(world), getSchema: async () => ({ schema: true }), logger, env }, store);
	const call = async (method, path, { id = SCAN, user = ALICE, headers = {} } = {}) => {
		const handler = router.routes.get(`${method} ${path}`);
		assert.ok(handler, `route ${method} ${path} is mounted`);
		const res = new FakeRes();
		const accountability = user === null ? null : { user, role: 'role-1' };
		await handler({ params: { id }, accountability, headers }, res);
		await new Promise((resolve) => setImmediate(resolve));
		return res;
	};
	return { world, router, store, call };
}

// ---- the signature ---------------------------------------------------------------------------------------------------

test('signGet reproduces the AWS Signature Version 4 example for a GET object request', () => {
	// docs.aws.amazon.com "Signature Calculations for the Authorization Header", example 1 (GET Object with a Range header)
	const headers = signGet({
		url: 'https://examplebucket.s3.amazonaws.com/test.txt',
		accessKey: 'AKIAIOSFODNN7EXAMPLE',
		secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
		region: 'us-east-1',
		date: new Date('2013-05-24T00:00:00Z'),
		extraHeaders: { range: 'bytes=0-9' },
	});
	assert.equal(headers['x-amz-date'], '20130524T000000Z');
	assert.equal(headers['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	assert.equal(
		headers.authorization,
		'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
		+ 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
		+ 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
	);
	assert.equal(headers.host, undefined, 'Host is left to fetch');
});

// ---- the keys --------------------------------------------------------------------------------------------------------

test('validCacheKey: a content hash or a provisional key, never a path', () => {
	assert.ok(validCacheKey(HASH));
	assert.ok(validCacheKey(`p-${ID(7)}-123456-1760000000.5`));
	for (const bad of [null, undefined, '', 'a/b', '../x', 'a..b', '.hidden', 'x'.repeat(201), 'a b', 'a\\b', 'a%2Fb', 5]) {
		assert.equal(validCacheKey(bad), false, String(bad));
	}
});

test('objectKey builds surface-scans/<key>/<file> for the three objects only', () => {
	assert.equal(objectKey(HASH, 'grid'), `surface-scans/${HASH}/grid.bin`);
	assert.equal(objectKey(HASH, 'meta'), `surface-scans/${HASH}/meta.json`);
	assert.equal(objectKey(HASH, 'thumb'), `surface-scans/${HASH}/thumb.png`);
	assert.equal(objectKey(HASH, 'toString'), null);
	assert.equal(objectKey('../secrets', 'grid'), null);
	assert.deepEqual(Object.keys(OBJECTS), ['grid', 'meta', 'thumb']);
});

test('safeKey keeps every request under the surface-scans prefix', () => {
	assert.ok(safeKey(`surface-scans/${HASH}/grid.bin`));
	for (const bad of ['d1-files/x', 'surface-scans/', 'surface-scans//x', 'surface-scans/../x', 'surface-scans/a/./b', 'other/surface-scans/x', 'surface-scans/a?b', 5, null]) {
		assert.equal(safeKey(bad), false, String(bad));
	}
});

test('matchesEtag: one tag, a list, a weak tag and * all match; anything else does not', () => {
	const tag = etagOf(HASH);
	assert.equal(tag, `"${HASH}"`);
	assert.ok(matchesEtag(tag, tag));
	assert.ok(matchesEtag(`"other", ${tag}`, tag));
	assert.ok(matchesEtag(`W/${tag}`, tag));
	assert.ok(matchesEtag('*', tag));
	assert.equal(matchesEtag('"other"', tag), false);
	assert.equal(matchesEtag('', tag), false);
	assert.equal(matchesEtag(undefined, tag), false);
});

// ---- the object store ------------------------------------------------------------------------------------------------

const ENV = { MINIO_ENDPOINT: 'http://minio:9000/', MINIO_ROOT_USER: 'user', MINIO_ROOT_PASSWORD: 'secret', MINIO_BUCKET: 'd1-files' };

test('createObjectStore is null until MinIO is configured', () => {
	assert.equal(createObjectStore({}), null);
	assert.equal(createObjectStore({ MINIO_ENDPOINT: 'http://minio:9000', MINIO_ROOT_USER: 'u' }), null);
	assert.equal(createObjectStore({ ...ENV, MINIO_ENDPOINT: 'minio:9000' }), null);
	assert.ok(createObjectStore(ENV));
});

test('the store GETs the object path-style with a signed request and returns a stream', async () => {
	const seen = [];
	const fetchImpl = async (url, init) => {
		seen.push({ url, init });
		return new Response(GRID, { status: 200, headers: { 'content-length': String(GRID.length) } });
	};
	const store = createObjectStore(ENV, { fetchImpl, now: () => new Date('2026-10-15T10:00:00Z') });
	const got = await store.get(`surface-scans/${HASH}/grid.bin`);
	assert.equal(got.size, GRID.length);
	assert.deepEqual(Buffer.concat(await got.body.toArray()), GRID);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, `http://minio:9000/d1-files/surface-scans/${HASH}/grid.bin`);
	assert.equal(seen[0].init.method, 'GET');
	assert.equal(seen[0].init.redirect, 'error');
	assert.match(seen[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=user\/20261015\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
	assert.equal(seen[0].init.headers['x-amz-date'], '20261015T100000Z');
});

test('the store answers null for a missing object and throws for anything else', async () => {
	const answer = (status) => createObjectStore(ENV, { fetchImpl: async () => new Response(status === 200 ? 'x' : 'no', { status }) });
	assert.equal(await answer(404).get(`surface-scans/${HASH}/grid.bin`), null);
	await assert.rejects(answer(403).get(`surface-scans/${HASH}/grid.bin`), /403/);
	await assert.rejects(answer(500).get(`surface-scans/${HASH}/grid.bin`), /500/);
});

test('the store refuses a key outside the prefix before any request is made', async () => {
	let called = 0;
	const store = createObjectStore(ENV, { fetchImpl: async () => { called += 1; return new Response('x'); } });
	await assert.rejects(store.get('d1-files/secret.bin'), /prefix/);
	await assert.rejects(store.get('surface-scans/../secret.bin'), /prefix/);
	assert.equal(called, 0);
});

// ---- GET grid / meta / thumb -----------------------------------------------------------------------------------------

test('mounts the four routes at /d1-surface-scan', () => {
	assert.equal(endpoint.id, 'd1-surface-scan');
	const { router } = setup();
	assert.deepEqual([...router.routes.keys()], ['GET /:id/grid', 'GET /:id/meta', 'GET /:id/thumb', 'POST /:id/render']);
});

test('GET grid streams the object with its ETag, Cache-Control private and its content type', async () => {
	const { call, world, store } = setup();
	const res = await call('GET', '/:id/grid');
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.bytes, GRID);
	assert.equal(res.headers.ETag, `"${HASH}"`);
	assert.equal(res.headers['Cache-Control'], CACHE_CONTROL);
	assert.match(res.headers['Cache-Control'], /\bprivate\b/);
	assert.equal(res.headers['Content-Type'], 'application/octet-stream');
	assert.equal(res.headers['Content-Length'], String(GRID.length));
	assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
	assert.deepEqual(store.calls.map((c) => c.key), [`surface-scans/${HASH}/grid.bin`]);
	// the row was read as the caller, through ItemsService, for the fields the endpoint needs and no more
	assert.equal(world.reads.length, 1);
	assert.equal(world.reads[0].collection, 'surface_scans');
	assert.deepEqual(world.reads[0].accountability, { user: ALICE, role: 'role-1' });
	assert.deepEqual(world.reads[0].query.fields, ['scan_id', 'render_status', 'cache_key']);
});

test('GET meta and thumb serve their own objects and content types', async () => {
	const { call } = setup();
	const meta = await call('GET', '/:id/meta');
	assert.equal(meta.statusCode, 200);
	assert.equal(meta.bytes.toString(), '{"width":2}');
	assert.equal(meta.headers['Content-Type'], 'application/json; charset=utf-8');
	const thumb = await call('GET', '/:id/thumb');
	assert.equal(thumb.statusCode, 200);
	assert.deepEqual(thumb.bytes, Buffer.from([137, 80, 78, 71]));
	assert.equal(thumb.headers['Content-Type'], 'image/png');
});

test('an unchanged object answers 304 to If-None-Match without touching the store', async () => {
	const { call, store } = setup();
	const res = await call('GET', '/:id/grid', { headers: { 'if-none-match': `"${HASH}"` } });
	assert.equal(res.statusCode, 304);
	assert.equal(res.bytes.length, 0);
	assert.equal(res.headers.ETag, `"${HASH}"`);
	assert.match(res.headers['Cache-Control'], /private/);
	assert.equal(store.calls.length, 0);
	const stale = await call('GET', '/:id/grid', { headers: { 'if-none-match': '"old"' } });
	assert.equal(stale.statusCode, 200);
});

test('not signed in: 401, and nothing is read', async () => {
	const { call, world } = setup();
	const res = await call('GET', '/:id/grid', { user: null });
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.errors[0].extensions.code, 'UNAUTHORIZED');
	assert.equal(res.body.errors[0].extensions.source, 'd1-surface-scan');
	assert.equal(world.reads.length, 0);
});

test('404 until render_status is done, naming the state', async () => {
	for (const state of ['pending', 'rendering', 'failed']) {
		const { call, store } = setup({ row: { render_status: state, cache_key: null } });
		const res = await call('GET', '/:id/grid');
		assert.equal(res.statusCode, 404, state);
		assert.equal(res.body.errors[0].extensions.code, 'NOT_RENDERED');
		assert.equal(res.body.errors[0].extensions.render_status, state);
		assert.equal(store.calls.length, 0);
	}
});

test('a scan the caller cannot read and one that does not exist give the same 404', async () => {
	const { call, world } = setup();
	world.hidden.add(SCAN);
	const hidden = await call('GET', '/:id/grid');
	const missing = await call('GET', '/:id/grid', { id: ID(99) });
	const malformed = await call('GET', '/:id/grid', { id: 'not-a-uuid' });
	for (const res of [hidden, missing, malformed]) {
		assert.equal(res.statusCode, 404);
		assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND');
	}
	assert.deepEqual(hidden.body, missing.body);
});

test('a done scan whose cache_key is not a plain name is never fetched (a hand-edited row cannot climb out of the prefix)', async () => {
	for (const key of ['../other/grid', 'a/b', '..', null, '', 'a..b']) {
		const { call, store } = setup({ row: { cache_key: key } });
		const res = await call('GET', '/:id/grid');
		assert.equal(res.statusCode, 404, String(key));
		assert.equal(store.calls.length, 0, String(key));
	}
});

test('an object that is gone from the store: 404 OBJECT_MISSING', async () => {
	const { call } = setup({ store: fakeStore({}) });
	const res = await call('GET', '/:id/grid');
	assert.equal(res.statusCode, 404);
	assert.equal(res.body.errors[0].extensions.code, 'OBJECT_MISSING');
});

test('the store failing: 502 without its message; MinIO not configured: 503', async () => {
	const down = setup({ store: fakeStore({}, { fail: new Error('connect ECONNREFUSED 10.0.0.5:9000') }) });
	const res = await down.call('GET', '/:id/grid');
	assert.equal(res.statusCode, 502);
	assert.equal(res.body.errors[0].extensions.code, 'STORE_UNAVAILABLE');
	assert.doesNotMatch(JSON.stringify(res.body), /ECONNREFUSED|10\.0\.0\.5/);
	const unset = setup({ store: null });
	const res2 = await unset.call('GET', '/:id/grid');
	assert.equal(res2.statusCode, 503);
	assert.equal(res2.body.errors[0].extensions.code, 'STORE_UNCONFIGURED');
});

test('a failure while streaming cuts the connection instead of sending an error page', async () => {
	const broken = {
		calls: [],
		async get() {
			return { body: Readable.from((async function* () { yield Buffer.from([1]); throw new Error('reset'); })()), size: 99 };
		},
	};
	const { call } = setup({ store: broken });
	const res = await call('GET', '/:id/grid');
	assert.ok(res.destroyedBy);
	assert.equal(res.body, undefined);
});

// ---- POST render -----------------------------------------------------------------------------------------------------

test('POST render queues the scan again as the caller: pending, error cleared, in a transaction that names the actor first', async () => {
	const { call, world } = setup({ row: { render_status: 'failed', render_error: 'cannot read file' } });
	const res = await call('POST', '/:id/render');
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, { data: { scan_id: SCAN, render_status: 'pending' } });
	assert.equal(world.txs, 1);
	assert.deepEqual(world.raw, [{ sql: "SELECT set_config('d1.actor_identity', ?, true)", bindings: [ALICE] }]);
	assert.equal(world.ops.length, 1);
	assert.deepEqual(world.ops[0].data, { render_status: 'pending', render_error: null });
	assert.ok(world.ops[0].knex, 'the write runs on the transaction');
	assert.deepEqual(world.ops[0].accountability, { user: ALICE, role: 'role-1' });
	assert.equal(world.rows.get(SCAN).render_status, 'pending');
});

test('POST render also re-queues a scan stuck in rendering or already rendered, and leaves a pending one alone', async () => {
	for (const state of ['rendering', 'done']) {
		const { call, world } = setup({ row: { render_status: state } });
		assert.equal((await call('POST', '/:id/render')).statusCode, 200);
		assert.equal(world.ops.length, 1, state);
	}
	const { call, world } = setup({ row: { render_status: 'pending' } });
	const res = await call('POST', '/:id/render');
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.data.render_status, 'pending');
	assert.equal(world.ops.length, 0);
	assert.equal(world.txs, 0);
});

test('POST render without update permission: 403, nothing changes', async () => {
	const { call, world } = setup({ row: { render_status: 'failed' } });
	world.updateDenied = true;
	const res = await call('POST', '/:id/render');
	assert.equal(res.statusCode, 403);
	assert.equal(res.body.errors[0].extensions.code, 'FORBIDDEN');
	assert.equal(world.rows.get(SCAN).render_status, 'failed');
});

test('POST render: 401 when not signed in, 404 for a scan the caller cannot read or a bad id', async () => {
	const { call, world } = setup({ row: { render_status: 'failed' } });
	assert.equal((await call('POST', '/:id/render', { user: null })).statusCode, 401);
	world.hidden.add(SCAN);
	assert.equal((await call('POST', '/:id/render')).statusCode, 404);
	assert.equal((await call('POST', '/:id/render', { id: 'nope' })).statusCode, 404);
	assert.equal(world.ops.length, 0);
});

test('POST render clears the Directus data cache after the commit when it is on', async () => {
	const on = setup({ env: { CACHE_ENABLED: 'true' }, row: { render_status: 'failed' } });
	await on.call('POST', '/:id/render');
	assert.equal(on.world.cacheCleared, 1);
	const off = setup({ row: { render_status: 'failed' } });
	await off.call('POST', '/:id/render');
	assert.equal(off.world.cacheCleared, 0);
});
