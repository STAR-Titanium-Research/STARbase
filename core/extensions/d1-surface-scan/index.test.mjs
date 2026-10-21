// Run with: node --test core/extensions/d1-surface-scan/index.test.mjs   (CI's lint job runs every core/extensions/*/index.test.mjs)
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';

import endpoint, {
	CACHE_CONTROL, LAB_VIEWER_ROLE_ID, LIST_CAP, OBJECTS, SQL, canSeeFile, etagOf, isAdminOverride, matchesEtag, mount, objectKey, validCacheKey,
} from './index.js';
import { PREFIX, createObjectStore, safeKey, signGet } from './objectStore.js';

// ---- fakes -----------------------------------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HASH = 'a'.repeat(64);
const GRID = Buffer.from([0, 0, 128, 63, 0, 0, 192, 127]); // 1.0 and NaN as float32 little-endian

// The people of the cases. A login is a Directus user; a person has at most one. Team CREW has an active and an inactive member.
const ALICE = ID(1); // the owner of the files below (person P.alice)
const BOB = ID(2); // somebody else
const CAROL = ID(3); // an ACTIVE member of team CREW
const DAVE = ID(4); // an INACTIVE (Former) member of team CREW, who still has a login
const ERIN = ID(5); // an inactive person who OWNS files (and still has a login)
const ADMIN = ID(6); // an administrator (no personal files here)
const VIEWER = ID(7); // a Lab Viewer
const P = { alice: ID(101), bob: ID(102), carol: ID(103), dave: ID(104), erin: ID(105), admin: ID(106), viewer: ID(107) };
const TEAM = ID(200);
const PEOPLE = [
	{ person_id: P.alice, user_id: ALICE, full_name: 'Alice Archer', active: true },
	{ person_id: P.bob, user_id: BOB, full_name: 'Bob Baker', active: true },
	{ person_id: P.carol, user_id: CAROL, full_name: 'Carol Chen', active: true },
	{ person_id: P.dave, user_id: DAVE, full_name: 'Dave Diaz', active: false },
	{ person_id: P.erin, user_id: ERIN, full_name: 'Erin Evans', active: false },
	{ person_id: P.admin, user_id: ADMIN, full_name: 'Ada Admin', active: true },
	{ person_id: P.viewer, user_id: VIEWER, full_name: 'Vic Viewer', active: true },
];
const TEAM_MEMBERS = [P.carol, P.dave];
const SCAN = ID(10);
const INSERT = ID(20);
const EDGE = ID(21);
const FILE = ID(30);
const OPERATION = ID(40);

// What migration 196's file_readers holds for an owned file (file_readers_expected): the owner person's login, and the login of EVERY member of
// the owner team whether active or not (ADR-0022 "two team-membership rules differ on purpose"). An unowned file has no rows.
function readersOf(file) {
	const logins = new Set();
	const user = (personId) => PEOPLE.find((p) => p.person_id === personId)?.user_id;
	if (file.owner_person_id && user(file.owner_person_id)) logins.add(user(file.owner_person_id));
	if (file.owner_team_id) for (const m of TEAM_MEMBERS) if (user(m)) logins.add(user(m));
	return logins;
}

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

// The world behind the fakes: the scans, their private render rows, the files (with the owner columns), the people, and what the fakes were asked.
// Rows are plain objects keyed by their ids; `readers` is file_readers as 'file|login' strings.
function fakeWorld() {
	return {
		scans: new Map(), renders: new Map(), files: new Map(), readers: new Set(), operations: new Map(), hiddenOperations: new Set(),
		hidden: new Set(), readDenied: false, updateDenied: false, failAccessLog: false,
		ops: [], built: [], reads: [], lists: [], raw: [], txs: 0, cacheCleared: 0, accessLog: [], results: [],
	};
}
// What a member may read of surface_scans through Directus (migration 205): the link facts only. Asking for more is a 403, as in Directus.
const MEMBER_FIELDS = ['scan_id', 'insert_id', 'edge_id', 'condition', 'scanned_on', 'operation_id', 'created_at', 'updated_at', 'version'];
const forbidden = () => Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
function fakeServices(world) {
	const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f]]));
	const guardFields = (acc, fields) => { if (acc?.admin !== true && fields.some((f) => !MEMBER_FIELDS.includes(f))) throw forbidden(); };
	class ItemsService {
		constructor(collection, options) {
			this.collection = collection;
			this.options = options;
			world.built.push({ collection, options });
		}
		async readOne(id, query) {
			world.reads.push({ collection: this.collection, id, query, accountability: this.options.accountability });
			const row = world.scans.get(id);
			if (world.readDenied || !row || world.hidden.has(id)) throw forbidden();
			guardFields(this.options.accountability, query.fields);
			return pick(row, query.fields);
		}
		async readByQuery(query) {
			world.lists.push({ collection: this.collection, query, accountability: this.options.accountability });
			if (this.collection === 'manufacturing_operations') {
				const wanted = query.filter.operation_id._in;
				return [...world.operations.values()].filter((o) => wanted.includes(o.operation_id) && !world.hiddenOperations.has(o.operation_id)).map((o) => pick(o, query.fields));
			}
			if (world.readDenied) throw forbidden();
			guardFields(this.options.accountability, query.fields);
			const clauses = query.filter._or ?? [query.filter];
			const match = (row) => clauses.some((c) => ('insert_id' in c ? row.insert_id === c.insert_id._eq : row.edge_id === c.edge_id._eq));
			const rows = [...world.scans.values()].filter(match).filter((r) => !world.hidden.has(r.scan_id));
			rows.sort((a, b) => String(b.scanned_on ?? '').localeCompare(String(a.scanned_on ?? '')));
			return rows.slice(0, query.limit).map((r) => pick(r, query.fields));
		}
		async updateOne(id, data) {
			// a member's update field list has no render_error (migration 205); only an administrator may name it
			if (world.updateDenied || (this.options.accountability?.admin !== true && 'render_error' in data)) throw forbidden();
			Object.assign(world.scans.get(id), data);
			world.ops.push({ op: 'update', id, data, knex: this.options.knex, accountability: this.options.accountability });
			return id;
		}
	}
	class UtilsService {
		async clearCache() { world.cacheCleared += 1; }
	}
	return { ItemsService, UtilsService };
}
// knex.raw over the world: every SQL the endpoint sends is one of the SQL constants, and the fake answers each from the world. An SQL it does not
// know fails the test. (The real statements are checked against Postgres by the integration steps, not here.)
function detailRow(world, scanId, user) {
	const scan = world.scans.get(scanId);
	if (!scan) return null;
	const file = world.files.get(scan.directus_files_id);
	const render = world.renders.get(scanId) ?? {};
	const person = PEOPLE.find((p) => p.person_id === scan.owner_person_id);
	return {
		scan_id: scan.scan_id, insert_id: scan.insert_id, edge_id: scan.edge_id, directus_files_id: scan.directus_files_id,
		condition_note: scan.condition_note, notes: scan.notes, render_status: scan.render_status, version: scan.version, owner_person_id: scan.owner_person_id,
		filename_download: file?.filename_download ?? null, title: file?.title ?? null,
		file_owner_person_id: file?.owner_person_id ?? null, file_owner_team_id: file?.owner_team_id ?? null,
		is_reader: world.readers.has(`${scan.directus_files_id}|${user}`),
		cache_key: render.cache_key ?? null, render_error: render.render_error ?? null, rendered_at: render.rendered_at ?? null,
		grid_width: render.grid_width ?? null, grid_height: render.grid_height ?? null, added_by_name: person?.full_name ?? null,
	};
}
function fakeKnex(world) {
	const raw = async (sql, bindings = []) => {
		world.raw.push({ sql, bindings });
		if (sql === SQL.setActor) return { rows: [] };
		if (sql === SQL.scanDetail) {
			const row = detailRow(world, bindings[1], bindings[0]);
			return { rows: row ? [row] : [] };
		}
		if (sql === SQL.scanDetails) return { rows: String(bindings[1]).split(',').map((id) => detailRow(world, id, bindings[0])).filter(Boolean) };
		if (SQL.accessLog && sql === SQL.accessLog) {
			if (world.failAccessLog) throw new Error('log table is gone');
			const [scan, file, user, reason] = bindings;
			world.accessLog.push({ scan, file, user, reason });
			return { rows: [] };
		}
		if (SQL.renderErrorClear && sql === SQL.renderErrorClear) {
			if (world.failRenderErrorClear) throw new Error('private table is gone');
			const render = world.renders.get(bindings[0]);
			if (render) render.render_error = null;
			return { rows: [] };
		}
		if (SQL.resultClaim && sql === SQL.resultClaim) {
			const [status, scan, version] = bindings;
			const row = world.scans.get(scan);
			if (!row || row.version !== version || row.render_status !== 'rendering') return { rows: [] };
			row.render_status = status;
			row.version += 1;
			return { rows: [{ scan_id: scan, render_status: status, version: row.version }] };
		}
		if (SQL.resultUpsert && sql === SQL.resultUpsert) {
			if (world.failUpsert) throw new Error('private table is gone');
			const [scan, ...values] = bindings;
			world.results.push({ scan, values });
			return { rows: [] };
		}
		throw new Error(`the fake database does not know this SQL: ${sql}`);
	};
	return raw;
}
const fakeDatabase = (world) => {
	const raw = fakeKnex(world);
	return {
		raw,
		transaction: async (work) => {
			world.txs += 1;
			// a failed transaction undoes its writes: the fake keeps a copy of what a write can touch
			const saved = { scans: structuredClone([...world.scans]), renders: structuredClone([...world.renders]), results: [...world.results], accessLog: [...world.accessLog] };
			try {
				return await work({ raw });
			} catch (err) {
				world.scans = new Map(saved.scans);
				world.renders = new Map(saved.renders);
				world.results = saved.results;
				world.accessLog = saved.accessLog;
				throw err;
			}
		},
	};
};
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

const STORE_OBJECTS = () => ({
	[`${PREFIX}${HASH}/grid.bin`]: GRID,
	[`${PREFIX}${HASH}/meta.json`]: Buffer.from('{"width":2}'),
	[`${PREFIX}${HASH}/thumb.png`]: Buffer.from([137, 80, 78, 71]),
});

// Mounts the endpoint on a fake router over a world of one done scan of one unowned file (so, by default, every member sees it), and returns a
// caller for its routes. `row` overrides scan columns, `render` the private render row, `file` the file's columns (give it an owner to lock it for
// everybody but its readers, which are derived as migration 196 does).
function setup({ store = fakeStore(STORE_OBJECTS()), env = {}, row, render, file } = {}) {
	const world = fakeWorld();
	world.files.set(FILE, { id: FILE, filename_download: 'edge-1.al3d', title: null, owner_person_id: null, owner_team_id: null, ...file });
	for (const login of readersOf(world.files.get(FILE))) world.readers.add(`${FILE}|${login}`);
	world.scans.set(SCAN, {
		scan_id: SCAN, insert_id: INSERT, edge_id: null, directus_files_id: FILE, condition: 'worn', condition_note: 'cleaned with acetone',
		scanned_on: '2026-10-01', operation_id: OPERATION, notes: 'second pass', render_status: 'done', version: 3, owner_person_id: P.alice, created_at: '2026-10-02', ...row,
	});
	world.renders.set(SCAN, { scan_id: SCAN, cache_key: HASH, render_error: null, rendered_at: new Date('2026-10-02T10:00:00Z'), grid_width: 512, grid_height: 256, ...render });
	world.operations.set(OPERATION, { operation_id: OPERATION, pass_code: 'PASS-7' });
	const router = fakeRouter();
	mount(router, { database: fakeDatabase(world), services: fakeServices(world), getSchema: async () => ({ schema: true }), logger, env }, store);
	const call = async (method, path, { id = SCAN, user = ALICE, role = 'role-1', admin = false, headers = {}, query = {}, body } = {}) => {
		const handler = router.routes.get(`${method} ${path}`);
		assert.ok(handler, `route ${method} ${path} is mounted`);
		const res = new FakeRes();
		const accountability = user === null ? null : { user, role, ...(admin ? { admin: true } : {}) };
		await handler({ method, params: { id }, accountability, headers, query, body }, res);
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

const ENV = { MINIO_ENDPOINT: 'http://minio:9000/', MINIO_SURFACE_READER_USER: 'user', MINIO_SURFACE_READER_PASSWORD: 'secret', MINIO_BUCKET: 'd1-files' };

test('createObjectStore is null until MinIO is configured', () => {
	assert.equal(createObjectStore({}), null);
	assert.equal(createObjectStore({ MINIO_ENDPOINT: 'http://minio:9000', MINIO_SURFACE_READER_USER: 'u' }), null);
	// the root credentials are never used, even when they are all there is
	assert.equal(createObjectStore({ MINIO_ENDPOINT: 'http://minio:9000', MINIO_ROOT_USER: 'root', MINIO_ROOT_PASSWORD: 'rootsecret' }), null);
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
	await assert.rejects(answer(403).get(`surface-scans/${HASH}/grid.bin`), /403.*bootstrap-minio/);
	await assert.rejects(answer(500).get(`surface-scans/${HASH}/grid.bin`), /500/);
});

test('the store refuses a key outside the prefix before any request is made', async () => {
	let called = 0;
	const store = createObjectStore(ENV, { fetchImpl: async () => { called += 1; return new Response('x'); } });
	await assert.rejects(store.get('d1-files/secret.bin'), /prefix/);
	await assert.rejects(store.get('surface-scans/../secret.bin'), /prefix/);
	assert.equal(called, 0);
});

// ---- the visibility rule ---------------------------------------------------------------------------------------------

// A file gets a new owner (an administrator's re-stamp, a crawler move): the owner columns change and file_readers follows (migration 196's triggers).
function restamp(world, owner, fileId = FILE) {
	const file = world.files.get(fileId);
	Object.assign(file, { owner_person_id: null, owner_team_id: null, ...owner });
	for (const key of [...world.readers]) if (key.startsWith(`${fileId}|`)) world.readers.delete(key);
	for (const login of readersOf(file)) world.readers.add(`${fileId}|${login}`);
}
// A second scan (of the same insert unless told otherwise), over its own file.
function addScan(world, n, { row = {}, file = {} } = {}) {
	const fileId = ID(300 + n);
	world.files.set(fileId, { id: fileId, filename_download: `scan-${n}.al3d`, title: null, owner_person_id: null, owner_team_id: null });
	restamp(world, file, fileId);
	const id = ID(10 + n);
	world.scans.set(id, {
		scan_id: id, insert_id: INSERT, edge_id: null, directus_files_id: fileId, condition: 'new', condition_note: `note ${n}`, scanned_on: `2026-09-0${n}`,
		operation_id: null, notes: `notes ${n}`, render_status: 'done', version: 1, owner_person_id: P.bob, created_at: '2026-10-02', ...row,
	});
	world.renders.set(id, { scan_id: id, cache_key: `${n}`.repeat(64), render_error: null, rendered_at: null, grid_width: null, grid_height: null });
	return id;
}

test('canSeeFile: an administrator, an unowned file, or a file_readers row; nobody else', () => {
	const unowned = { directus_files_id: FILE, file_owner_person_id: null, file_owner_team_id: null, is_reader: false };
	const owned = { ...unowned, file_owner_person_id: P.alice };
	const ownedTeam = { ...unowned, file_owner_team_id: TEAM };
	assert.equal(canSeeFile(false, unowned), true);
	assert.equal(canSeeFile(false, owned), false);
	assert.equal(canSeeFile(false, ownedTeam), false);
	assert.equal(canSeeFile(false, { ...owned, is_reader: true }), true);
	assert.equal(canSeeFile(false, { ...ownedTeam, is_reader: true }), true);
	assert.equal(canSeeFile(true, owned), true);
	assert.equal(canSeeFile(true, ownedTeam), true);
	assert.equal(canSeeFile(false, null), false, 'no file row, no access for a member');
	assert.equal(canSeeFile(false, { ...unowned, directus_files_id: null }), false);
	assert.equal(canSeeFile(undefined, owned), false, 'only admin === true counts');
	assert.equal(canSeeFile('true', owned), false);
	assert.equal(canSeeFile(false, { ...owned, is_reader: 'yes' }), false, 'only a real true counts');
	// an administrator is "overriding" exactly when a member in their place would be refused
	assert.equal(isAdminOverride(true, owned), true);
	assert.equal(isAdminOverride(true, { ...owned, is_reader: true }), false, "an owner administrator reads their own file: nothing to log");
	assert.equal(isAdminOverride(true, unowned), false);
	assert.equal(isAdminOverride(false, owned), false, 'a member is refused, not logged');
});

// Who sees a file, case by case: [who, accountability, expected]. The decision is the same on grid, meta, thumb and /scans.
const WHO = {
	alice: { user: ALICE }, bob: { user: BOB }, carol: { user: CAROL }, dave: { user: DAVE }, erin: { user: ERIN },
	admin: { user: ADMIN, admin: true }, viewer: { user: VIEWER, role: LAB_VIEWER_ROLE_ID },
};
const CASES = [
	['a file owned by Alice', { owner_person_id: P.alice }, { alice: true, bob: false, carol: false, dave: false, erin: false, admin: true, viewer: false }],
	['a file owned by the team (active member Carol; inactive member Dave does not count since migration 201)', { owner_team_id: TEAM }, { alice: false, bob: false, carol: true, dave: false, erin: false, admin: true, viewer: false }],
	['a file owned by Erin, an inactive person who has a login', { owner_person_id: P.erin }, { alice: false, bob: false, carol: false, dave: false, erin: true, admin: true, viewer: false }],
	['a file with no owner', {}, { alice: true, bob: true, carol: true, dave: true, erin: true, admin: true, viewer: true }],
];

for (const [label, owner, expected] of CASES) {
	test(`${label}: grid, meta and thumb answer each person by the one rule`, async () => {
		for (const [who, sees] of Object.entries(expected)) {
			for (const object of Object.keys(OBJECTS)) {
				const { call } = setup({ file: owner });
				const res = await call('GET', `/:id/${object}`, WHO[who]);
				if (sees) {
					assert.equal(res.statusCode, 200, `${who} reads ${object}`);
				} else {
					assert.equal(res.statusCode, 403, `${who} is refused ${object}`);
					assert.equal(res.body.errors[0].extensions.code, 'FILE_LOCKED');
					assert.equal(res.body.errors[0].extensions.source, 'd1-surface-scan');
				}
			}
		}
	});

	test(`${label}: GET /scans shows each person a readable row or a locked one`, async () => {
		for (const [who, sees] of Object.entries(expected)) {
			const { call } = setup({ file: owner });
			const res = await call('GET', '/scans', { ...WHO[who], query: { insert_id: INSERT } });
			assert.equal(res.statusCode, 200, who);
			assert.equal(res.body.data.length, 1, `${who} still counts the scan`);
			assert.equal(res.body.data[0].locked, !sees, who);
		}
	});
}

test('the Lab Viewer reads what the rule lets any other member read, and can edit nothing', async () => {
	const open = setup();
	const res = await open.call('GET', '/scans', { ...WHO.viewer, query: { insert_id: INSERT } });
	assert.equal(res.body.data[0].locked, false);
	assert.equal(res.body.data[0].can_edit, false);
	const own = setup();
	assert.equal((await own.call('GET', '/scans', { ...WHO.alice, query: { insert_id: INSERT } })).body.data[0].can_edit, true);
	assert.equal((await own.call('GET', '/scans', { ...WHO.admin, query: { insert_id: INSERT } })).body.data[0].can_edit, true);
});

test('a file re-stamped to an owner locks its scan at once, for everyone but its readers (visibility is computed live)', async () => {
	const { call, world } = setup();
	assert.equal((await call('GET', '/:id/grid', WHO.bob)).statusCode, 200);
	restamp(world, { owner_person_id: P.alice });
	const locked = await call('GET', '/:id/grid', WHO.bob);
	assert.equal(locked.statusCode, 403);
	assert.equal(locked.body.errors[0].extensions.code, 'FILE_LOCKED');
	assert.equal((await call('GET', '/:id/grid', WHO.alice)).statusCode, 200);
	assert.equal((await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } })).body.data[0].locked, true);
	// and back: an administrator clears the owner
	restamp(world, {});
	assert.equal((await call('GET', '/:id/grid', WHO.bob)).statusCode, 200);
});

test('a scan whose file was moved to another file (the indexer repoints it) follows the new file', async () => {
	const { call, world } = setup();
	const other = ID(331);
	world.files.set(other, { id: other, filename_download: 'moved.al3d', title: null, owner_person_id: null, owner_team_id: null });
	restamp(world, { owner_person_id: P.alice }, other);
	assert.equal((await call('GET', '/:id/grid', WHO.bob)).statusCode, 200);
	world.scans.get(SCAN).directus_files_id = other;
	assert.equal((await call('GET', '/:id/grid', WHO.bob)).statusCode, 403);
	assert.equal((await call('GET', '/:id/grid', WHO.alice)).statusCode, 200);
});

// ---- GET /scans ------------------------------------------------------------------------------------------------------

test('GET /scans: a readable row has exactly the spec shape', async () => {
	const { call, world } = setup({ file: { owner_person_id: P.alice } });
	const res = await call('GET', '/scans', { ...WHO.alice, query: { insert_id: INSERT } });
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, {
		data: [{
			scan_id: SCAN,
			insert_id: INSERT,
			edge_id: null,
			locked: false,
			condition: 'worn',
			scanned_on: '2026-10-01',
			operation: { id: OPERATION, label: 'PASS-7' },
			notes: 'second pass',
			condition_note: 'cleaned with acetone',
			added_by: { person_id: P.alice, name: 'Alice Archer' },
			file: { id: FILE, name: 'edge-1.al3d' },
			render_status: 'done',
			render_error: null,
			rendered_at: '2026-10-02T10:00:00.000Z',
			grid: { width: 512, height: 256 },
			can_edit: true,
		}],
	});
	// the rows and the label were read AS THE CALLER, for the link facts a member may read (never the file, notes or render columns)
	assert.deepEqual(world.lists[0].accountability, { user: ALICE, role: 'role-1' });
	assert.equal(world.lists[0].collection, 'surface_scans');
	assert.deepEqual(world.lists[0].query.fields, ['scan_id', 'insert_id', 'edge_id', 'condition', 'scanned_on', 'operation_id']);
	assert.deepEqual(world.lists[0].query.filter, { insert_id: { _eq: INSERT } });
	assert.equal(world.lists[0].query.limit, LIST_CAP);
	assert.deepEqual(world.lists[1].accountability, { user: ALICE, role: 'role-1' });
	assert.equal(world.lists[1].collection, 'manufacturing_operations');
	assert.deepEqual(world.lists[1].query.fields, ['operation_id', 'pass_code']);
});

test('GET /scans: a locked row has the facts about the item and nothing else', async () => {
	const { call } = setup({ file: { owner_person_id: P.alice } });
	const res = await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } });
	assert.deepEqual(res.body, {
		data: [{
			scan_id: SCAN,
			insert_id: INSERT,
			edge_id: null,
			locked: true,
			condition: 'worn',
			scanned_on: '2026-10-01',
			operation: { id: OPERATION, label: 'PASS-7' },
		}],
	});
	// nothing of the file, the notes, the adder or the render leaks anywhere in the answer
	const text = JSON.stringify(res.body);
	for (const secret of [FILE, 'edge-1.al3d', 'second pass', 'acetone', 'Alice Archer', P.alice, HASH, 'done', '512']) {
		assert.ok(!text.includes(secret), `the locked row does not carry ${secret}`);
	}
});

test('GET /scans: a failed render shows its private error to a reader only', async () => {
	const world = setup({ row: { render_status: 'failed' }, render: { cache_key: null, render_error: 'cannot read /Users/alice/secret.al3d', grid_width: null, grid_height: null }, file: { owner_person_id: P.alice } });
	const mine = (await world.call('GET', '/scans', { ...WHO.alice, query: { insert_id: INSERT } })).body.data[0];
	assert.equal(mine.render_status, 'failed');
	assert.equal(mine.render_error, 'cannot read /Users/alice/secret.al3d');
	assert.equal(mine.grid, null);
	const theirs = (await world.call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } })).body.data[0];
	assert.ok(!JSON.stringify(theirs).includes('secret.al3d'));
	assert.equal('render_error' in theirs, false);
});

test('GET /scans: an edge page asks for both, gets the edge scans and its insert scans, newest first', async () => {
	const { call, world } = setup({ row: { scanned_on: '2026-10-01' } });
	const edgeScan = addScan(world, 1, { row: { insert_id: null, edge_id: EDGE, scanned_on: '2026-10-05' } });
	const otherInsert = addScan(world, 2, { row: { insert_id: ID(99), scanned_on: '2026-10-09' } });
	const res = await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT, edge_id: EDGE } });
	assert.deepEqual(res.body.data.map((r) => r.scan_id), [edgeScan, SCAN]);
	assert.ok(!res.body.data.some((r) => r.scan_id === otherInsert));
	assert.deepEqual(world.lists[0].query.filter, { _or: [{ insert_id: { _eq: INSERT } }, { edge_id: { _eq: EDGE } }] });
	const onlyEdge = await call('GET', '/scans', { ...WHO.bob, query: { edge_id: EDGE } });
	assert.deepEqual(onlyEdge.body.data.map((r) => r.scan_id), [edgeScan]);
	assert.deepEqual(world.lists.filter((l) => l.collection === 'surface_scans').at(-1).query.filter, { edge_id: { _eq: EDGE } });
});

test('GET /scans: readable and locked rows come in one list and the count includes the locked ones', async () => {
	const { call, world } = setup();
	const mine = addScan(world, 1, { file: { owner_person_id: P.alice }, row: { scanned_on: '2026-10-08' } });
	const theirs = addScan(world, 2, { file: { owner_person_id: P.bob }, row: { scanned_on: '2026-10-07' } });
	const res = await call('GET', '/scans', { ...WHO.alice, query: { insert_id: INSERT } });
	assert.deepEqual(res.body.data.map((r) => [r.scan_id, r.locked]), [[mine, false], [theirs, true], [SCAN, false]]);
	const forBob = await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } });
	assert.deepEqual(forBob.body.data.map((r) => [r.scan_id, r.locked]), [[mine, true], [theirs, false], [SCAN, false]]);
	// one database read for all the rows, not one a row
	assert.equal(world.raw.filter((r) => r.sql === SQL.scanDetails).length, 2);
	assert.equal(world.raw.filter((r) => r.sql === SQL.scanDetail).length, 0);
});

test('GET /scans: the operation label is the caller\'s own read; one they cannot read keeps the id and a plain label', async () => {
	const { call, world } = setup();
	world.hiddenOperations.add(OPERATION);
	const hidden = (await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } })).body.data[0];
	assert.deepEqual(hidden.operation, { id: OPERATION, label: 'Operation' });
	world.hiddenOperations.clear();
	world.operations.get(OPERATION).pass_code = ' ';
	assert.deepEqual((await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } })).body.data[0].operation, { id: OPERATION, label: 'Operation' });
	world.scans.get(SCAN).operation_id = null;
	assert.equal((await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } })).body.data[0].operation, null);
	assert.equal(world.lists.filter((l) => l.collection === 'manufacturing_operations').length, 2, 'no operation read when there is no operation id');
});

test('GET /scans: no scans is an empty list (no second read); bad input is 400; not signed in is 401; no read permission is 403', async () => {
	const { call, world } = setup();
	const none = await call('GET', '/scans', { query: { insert_id: ID(98) } });
	assert.deepEqual(none.body, { data: [] });
	assert.equal(world.raw.filter((r) => r.sql === SQL.scanDetails).length, 0);
	for (const query of [{}, { insert_id: 'nope' }, { edge_id: ['a', 'b'] }, { insert_id: '' }]) {
		const res = await call('GET', '/scans', { query });
		assert.equal(res.statusCode, 400, JSON.stringify(query));
		assert.equal(res.body.errors[0].extensions.code, 'INVALID_PAYLOAD');
		assert.equal(res.headers['Cache-Control'], 'no-store');
	}
	assert.equal((await call('GET', '/scans', { user: null, query: { insert_id: INSERT } })).statusCode, 401);
	world.readDenied = true;
	const denied = await call('GET', '/scans', { query: { insert_id: INSERT } });
	assert.equal(denied.statusCode, 403);
	assert.equal(denied.body.errors[0].extensions.code, 'FORBIDDEN');
});

test('GET /scans: every scan is read in one batch with the caller\'s login first and the ids as one csv', async () => {
	const { call, world } = setup();
	addScan(world, 1);
	await call('GET', '/scans', { ...WHO.bob, query: { insert_id: INSERT } });
	const q = world.raw.find((r) => r.sql === SQL.scanDetails);
	assert.equal(q.bindings[0], BOB);
	assert.deepEqual(q.bindings[1].split(',').sort(), [SCAN, ID(11)].sort());
});

test('GET /scans: an administrator reading a locked scan\'s list is not logged (only a grid read is)', async () => {
	const { call, world } = setup({ file: { owner_person_id: P.alice } });
	const res = await call('GET', '/scans', { ...WHO.admin, query: { insert_id: INSERT } });
	assert.equal(res.body.data[0].locked, false);
	assert.equal(world.accessLog.length, 0);
});

// ---- GET grid / meta / thumb -----------------------------------------------------------------------------------------

test('mounts the list, the three objects, render and result at /d1-surface-scan', () => {
	assert.equal(endpoint.id, 'd1-surface-scan');
	const { router } = setup();
	assert.deepEqual([...router.routes.keys()], ['GET /scans', 'GET /:id/grid', 'GET /:id/meta', 'GET /:id/thumb', 'POST /:id/render', 'POST /:id/result']);
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
	// the caller's row permission is checked as the caller, for the id alone (the other columns are not theirs to read); the rest is the database's
	assert.equal(world.reads.length, 1);
	assert.equal(world.reads[0].collection, 'surface_scans');
	assert.deepEqual(world.reads[0].accountability, { user: ALICE, role: 'role-1' });
	assert.deepEqual(world.reads[0].query.fields, ['scan_id']);
	const detail = world.raw.filter((r) => r.sql === SQL.scanDetail);
	assert.equal(detail.length, 1);
	assert.deepEqual(detail[0].bindings, [ALICE, SCAN]);
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

test('the cache key is the private render row\'s, never a column of the scan', async () => {
	const other = 'b'.repeat(64);
	const { call, store, world } = setup({ store: fakeStore({ [`${PREFIX}${other}/grid.bin`]: GRID }), render: { cache_key: other } });
	world.scans.get(SCAN).cache_key = HASH; // a stale public value (migration 205 drops the column) is ignored
	const res = await call('GET', '/:id/grid');
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers.ETag, `"${other}"`);
	assert.deepEqual(store.calls.map((c) => c.key), [`surface-scans/${other}/grid.bin`]);
	// a done scan with no private render row has nothing to serve
	const none = setup();
	none.world.renders.delete(SCAN);
	const gone = await none.call('GET', '/:id/grid');
	assert.equal(gone.statusCode, 404);
	assert.equal(gone.body.errors[0].extensions.code, 'NOT_RENDERED');
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

// A locked scan answers 403 FILE_LOCKED BEFORE the ETag/304 branch: a browser that holds the object (the file was re-stamped after it looked, or a
// shared lab PC) must not be told "not modified" about a file it may no longer see, and a locked answer carries neither ETag nor a cacheable header.
test('a locked scan answers 403 FILE_LOCKED even to a matching If-None-Match: no 304, no ETag, no-store, the store untouched', async () => {
	for (const object of Object.keys(OBJECTS)) {
		const { call, store } = setup({ file: { owner_person_id: P.alice } });
		const res = await call('GET', `/:id/${object}`, { ...WHO.bob, headers: { 'if-none-match': `"${HASH}"` } });
		assert.equal(res.statusCode, 403, object);
		assert.equal(res.body.errors[0].extensions.code, 'FILE_LOCKED');
		assert.equal(res.headers['Cache-Control'], 'no-store');
		assert.equal(res.headers.ETag, undefined);
		assert.equal(res.bytes.length, 0);
		assert.equal(store.calls.length, 0);
		assert.doesNotMatch(JSON.stringify(res.body), new RegExp(`${HASH}|edge-1|${FILE}`));
	}
});

test('the lock is decided before anything about the render: a locked scan that is not rendered is 403, not 404 NOT_RENDERED', async () => {
	for (const row of [{ render_status: 'pending' }, { render_status: 'failed' }, { render_status: 'rendering' }]) {
		const { call } = setup({ row, render: { cache_key: null }, file: { owner_person_id: P.alice } });
		const res = await call('GET', '/:id/grid', WHO.bob);
		assert.equal(res.statusCode, 403, row.render_status);
		assert.equal(res.body.errors[0].extensions.code, 'FILE_LOCKED');
		assert.equal(res.body.errors[0].extensions.render_status, undefined);
	}
});

test('a reader of the file gets the 304 and the 200 as before', async () => {
	const { call, store } = setup({ file: { owner_person_id: P.alice } });
	const same = await call('GET', '/:id/grid', { ...WHO.alice, headers: { 'if-none-match': `"${HASH}"` } });
	assert.equal(same.statusCode, 304);
	const fresh = await call('GET', '/:id/grid', WHO.alice);
	assert.equal(fresh.statusCode, 200);
	assert.equal(store.calls.length, 1);
});

// An error reply must not be cached and must not carry the ETag: the cache key stays the same when a scan is rendered again.
const assertUncacheable = (res, label) => {
	assert.equal(res.headers['Cache-Control'], 'no-store', `${label}: Cache-Control`);
	assert.equal(res.headers.ETag, undefined, `${label}: no ETag`);
};

test('every error reply carries Cache-Control: no-store and no ETag', async () => {
	assertUncacheable(await setup().call('GET', '/:id/grid', { user: null }), '401');
	assertUncacheable(await setup().call('GET', '/:id/grid', { id: 'nope' }), 'bad id');
	const hidden = setup();
	hidden.world.hidden.add(SCAN);
	assertUncacheable(await hidden.call('GET', '/:id/grid'), 'unreadable');
	const locked = await setup({ file: { owner_person_id: P.alice } }).call('GET', '/:id/grid', WHO.bob);
	assert.equal(locked.statusCode, 403);
	assertUncacheable(locked, 'locked');
	assertUncacheable(await setup({ row: { render_status: 'failed' }, render: { cache_key: null } }).call('GET', '/:id/grid'), 'not rendered');
	assertUncacheable(await setup({ render: { cache_key: '../x' } }).call('GET', '/:id/grid'), 'bad cache key');
	const missing = await setup({ store: fakeStore({}) }).call('GET', '/:id/grid');
	assert.equal(missing.statusCode, 404);
	assertUncacheable(missing, 'OBJECT_MISSING');
	const down = await setup({ store: fakeStore({}, { fail: new Error('down') }) }).call('GET', '/:id/grid');
	assert.equal(down.statusCode, 502);
	assertUncacheable(down, '502');
	const refused = await setup({ store: fakeStore({}, { fail: Object.assign(new Error('object store answered 403'), { status: 403 }) }) }).call('GET', '/:id/grid');
	assert.equal(refused.statusCode, 502, 'a refused reader is a server problem, not a missing scan');
	assert.equal(refused.body.errors[0].extensions.code, 'STORE_UNAVAILABLE');
	assertUncacheable(refused, 'refused reader');
	const unset = await setup({ store: null }).call('GET', '/:id/grid');
	assert.equal(unset.statusCode, 503);
	assertUncacheable(unset, '503');
	const noWrite = setup({ row: { render_status: 'failed' } });
	noWrite.world.updateDenied = true;
	assertUncacheable(await noWrite.call('POST', '/:id/render'), 'render 403');
});

test('ETag and Cache-Control private are on the 200 and the 304 only', async () => {
	const ok = await setup().call('GET', '/:id/grid');
	assert.equal(ok.statusCode, 200);
	assert.equal(ok.headers.ETag, `"${HASH}"`);
	assert.equal(ok.headers['Cache-Control'], CACHE_CONTROL);
	const notModified = await setup().call('GET', '/:id/grid', { headers: { 'if-none-match': `"${HASH}"` } });
	assert.equal(notModified.statusCode, 304);
	assert.equal(notModified.headers.ETag, `"${HASH}"`);
	assert.equal(notModified.headers['Cache-Control'], CACHE_CONTROL);
});

test('not signed in: 401, and nothing is read', async () => {
	const { call, world } = setup();
	const res = await call('GET', '/:id/grid', { user: null });
	assert.equal(res.statusCode, 401);
	assert.equal(res.body.errors[0].extensions.code, 'UNAUTHORIZED');
	assert.equal(res.body.errors[0].extensions.source, 'd1-surface-scan');
	assert.equal(world.reads.length, 0);
	assert.equal(world.raw.length, 0);
});

test('404 until render_status is done, naming the state', async () => {
	for (const state of ['pending', 'rendering', 'failed']) {
		const { call, store } = setup({ row: { render_status: state }, render: { cache_key: null } });
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
		const { call, store } = setup({ render: { cache_key: key } });
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

test('POST render queues the scan again as the caller: pending, the private error cleared in the same transaction, the actor named first', async () => {
	const { call, world } = setup({ row: { render_status: 'failed' }, render: { render_error: 'cannot read file', cache_key: null } });
	const res = await call('POST', '/:id/render');
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, { data: { scan_id: SCAN, render_status: 'pending' } });
	assert.equal(world.txs, 1);
	// in the one transaction: the actor, then the update as the caller, then the private error
	const inTx = world.raw.filter((r) => r.sql !== SQL.scanDetail);
	assert.deepEqual(inTx, [
		{ sql: "SELECT set_config('d1.actor_identity', ?, true)", bindings: [ALICE] },
		{ sql: SQL.renderErrorClear, bindings: [SCAN] },
	]);
	assert.equal(world.ops.length, 1);
	// render_error is no longer a column of the scan: the member's update names render_status only
	assert.deepEqual(world.ops[0].data, { render_status: 'pending' });
	assert.ok(world.ops[0].knex, 'the write runs on the transaction');
	assert.deepEqual(world.ops[0].accountability, { user: ALICE, role: 'role-1' });
	assert.equal(world.scans.get(SCAN).render_status, 'pending');
	assert.equal(world.renders.get(SCAN).render_error, null);
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

test('POST render without update permission (a Lab Viewer): 403, nothing changes', async () => {
	const { call, world } = setup({ row: { render_status: 'failed' }, render: { render_error: 'bad' } });
	world.updateDenied = true;
	const res = await call('POST', '/:id/render', WHO.viewer);
	assert.equal(res.statusCode, 403);
	assert.equal(res.body.errors[0].extensions.code, 'FORBIDDEN');
	assert.equal(world.scans.get(SCAN).render_status, 'failed');
	assert.equal(world.renders.get(SCAN).render_error, 'bad', 'a refused write does not clear the error');
});

test('POST render of a scan whose file the caller cannot see: 403 FILE_LOCKED, even when it is already pending; nothing is written', async () => {
	for (const state of ['failed', 'done', 'pending']) {
		const { call, world } = setup({ row: { render_status: state }, render: { render_error: 'bad' }, file: { owner_person_id: P.alice } });
		for (const who of [WHO.bob, WHO.carol, WHO.dave, WHO.viewer]) {
			const res = await call('POST', '/:id/render', who);
			assert.equal(res.statusCode, 403, `${state} ${who.user}`);
			assert.equal(res.body.errors[0].extensions.code, 'FILE_LOCKED');
			assertUncacheable(res, 'render locked');
		}
		assert.equal(world.ops.length, 0);
		assert.equal(world.txs, 0);
		assert.equal(world.renders.get(SCAN).render_error, 'bad');
	}
});

test('POST render: the file\'s owner, an active member of the owner team and an administrator may queue it again', async () => {
	for (const [who, owner] of [[WHO.alice, { owner_person_id: P.alice }], [WHO.carol, { owner_team_id: TEAM }], [WHO.dave, { owner_team_id: TEAM }], [WHO.erin, { owner_person_id: P.erin }], [WHO.admin, { owner_person_id: P.alice }]]) {
		const { call, world } = setup({ row: { render_status: 'failed' }, file: owner });
		const res = await call('POST', '/:id/render', who);
		assert.equal(res.statusCode, 200, who.user);
		assert.equal(world.ops.length, 1);
	}
});

test('POST render: the update and the private clear are one transaction (a failed clear undoes the update)', async () => {
	const { call, world } = setup({ row: { render_status: 'failed' }, render: { render_error: 'bad' }, env: { CACHE_ENABLED: 'true' } });
	world.failRenderErrorClear = true;
	const res = await call('POST', '/:id/render');
	assert.equal(res.statusCode, 500);
	assert.equal(world.scans.get(SCAN).render_status, 'failed');
	assert.equal(world.renders.get(SCAN).render_error, 'bad');
	assert.equal(world.cacheCleared, 0);
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

// ---- the administrator access log ------------------------------------------------------------------------------------

test('an administrator opening the grid of a scan they could not read as a member: one log row, written after the actor is named, before the data is sent', async () => {
	const { call, world, store } = setup({ file: { owner_person_id: P.alice } });
	const res = await call('GET', '/:id/grid', WHO.admin);
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.bytes, GRID);
	assert.deepEqual(world.accessLog, [{ scan: SCAN, file: FILE, user: ADMIN, reason: 'admin_read' }]);
	const writes = world.raw.filter((r) => r.sql === SQL.setActor || r.sql === SQL.accessLog);
	assert.deepEqual(writes.map((w) => w.sql), [SQL.setActor, SQL.accessLog]);
	assert.deepEqual(writes[0].bindings, [ADMIN]);
	assert.equal(world.txs, 1);
	assert.equal(store.calls.length, 1);
	// each open is its own row
	await call('GET', '/:id/grid', WHO.admin);
	assert.equal(world.accessLog.length, 2);
});

test('a team-owned file an administrator is not a reader of is logged too', async () => {
	const { call, world } = setup({ file: { owner_team_id: TEAM } });
	assert.equal((await call('GET', '/:id/grid', WHO.admin)).statusCode, 200);
	assert.equal(world.accessLog.length, 1);
});

test('nothing is logged when the administrator could have read it as a member: their own file, an unowned file, a file of their team', async () => {
	const own = setup({ file: { owner_person_id: P.alice } });
	own.world.readers.add(`${FILE}|${ADMIN}`); // the administrator is a reader (the owner, or a member of the owner team)
	assert.equal((await own.call('GET', '/:id/grid', WHO.admin)).statusCode, 200);
	assert.equal(own.world.accessLog.length, 0);
	assert.equal(own.world.txs, 0, 'no transaction is opened for nothing');
	const open = setup();
	assert.equal((await open.call('GET', '/:id/grid', WHO.admin)).statusCode, 200);
	assert.equal(open.world.accessLog.length, 0);
});

test('only the grid read is logged: meta and thumb are not, and neither is a member\'s read', async () => {
	const { call, world } = setup({ file: { owner_person_id: P.alice } });
	assert.equal((await call('GET', '/:id/meta', WHO.admin)).statusCode, 200);
	assert.equal((await call('GET', '/:id/thumb', WHO.admin)).statusCode, 200);
	assert.equal((await call('GET', '/scans', { ...WHO.admin, query: { insert_id: INSERT } })).statusCode, 200);
	assert.equal(world.accessLog.length, 0);
	assert.equal((await call('GET', '/:id/grid', WHO.alice)).statusCode, 200);
	assert.equal(world.accessLog.length, 0, 'the owner is not logged');
	assert.equal((await call('GET', '/:id/grid', WHO.bob)).statusCode, 403);
	assert.equal(world.accessLog.length, 0, 'a refused member is not logged');
});

test('the 304 of an administrator\'s grid read is logged as well (it confirms a read); a read that serves nothing is not', async () => {
	const notModified = setup({ file: { owner_person_id: P.alice } });
	const res = await notModified.call('GET', '/:id/grid', { ...WHO.admin, headers: { 'if-none-match': `"${HASH}"` } });
	assert.equal(res.statusCode, 304);
	assert.equal(notModified.world.accessLog.length, 1);
	const pending = setup({ row: { render_status: 'pending' }, render: { cache_key: null }, file: { owner_person_id: P.alice } });
	assert.equal((await pending.call('GET', '/:id/grid', WHO.admin)).statusCode, 404);
	assert.equal(pending.world.accessLog.length, 0);
	const unset = setup({ store: null, file: { owner_person_id: P.alice } });
	assert.equal((await unset.call('GET', '/:id/grid', WHO.admin)).statusCode, 503);
	assert.equal(unset.world.accessLog.length, 0);
});

test('a log row that cannot be written is a 500 and no data (the store is not even asked)', async () => {
	const { call, world, store } = setup({ file: { owner_person_id: P.alice } });
	world.failAccessLog = true;
	const res = await call('GET', '/:id/grid', WHO.admin);
	assert.equal(res.statusCode, 500);
	assert.equal(res.body.errors[0].extensions.code, 'INTERNAL_SERVER_ERROR');
	assert.equal(res.bytes.length, 0);
	assert.equal(res.headers['Cache-Control'], 'no-store');
	assert.equal(store.calls.length, 0);
	assert.equal(world.accessLog.length, 0);
});

// ---- POST result (the worker's report) -------------------------------------------------------------------------------

const COLUMNS = {
	cache_key: HASH, source_format: 'al3d', source_width: 4096, source_height: 3072, grid_width: 1024, grid_height: 768,
	pixel_pitch_x_um: 1.5, pixel_pitch_y_um: 1.5, z_min_um: -12.25, z_max_um: 40.5, rendered_at: '2026-10-21T09:30:00Z',
};
const DONE = { version: 3, render_status: 'done', columns: COLUMNS };
// A scan the worker holds: rendering, at version 3.
const claimed = (extra = {}) => setup({ row: { render_status: 'rendering', version: 3 }, render: { cache_key: null, grid_width: null, grid_height: null, rendered_at: null }, ...extra });

test('POST result: the worker reports a finished render: claimed and upserted in one transaction that names the actor first, then the cache is cleared', async () => {
	const { call, world } = claimed({ env: { CACHE_ENABLED: 'true' } });
	const res = await call('POST', '/:id/result', { ...WHO.admin, body: DONE });
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, { data: { scan_id: SCAN, render_status: 'done', version: 4 } });
	assert.equal(world.txs, 1);
	assert.deepEqual(world.raw.map((r) => r.sql), [SQL.setActor, SQL.resultClaim, SQL.resultUpsert]);
	assert.deepEqual(world.raw[0].bindings, [ADMIN]);
	assert.deepEqual(world.raw[1].bindings, ['done', SCAN, 3]);
	assert.deepEqual(world.raw[2].bindings, [
		SCAN, null, '2026-10-21T09:30:00.000Z', HASH, 'al3d', 4096, 3072, 1024, 768, 1.5, 1.5, -12.25, 40.5,
	]);
	assert.equal(world.scans.get(SCAN).render_status, 'done');
	assert.equal(world.cacheCleared, 1);
	// the SQL's own shape: a claim that only wins a 'rendering' row at the version read, and an upsert on the scan id
	assert.match(SQL.resultClaim, /WHERE scan_id = \? AND version = \? AND render_status = 'rendering'/);
	assert.match(SQL.resultUpsert, /INSERT INTO d1_private\.surface_scan_renders \(scan_id, render_error, rendered_at, cache_key, source_format, source_width, source_height, grid_width, grid_height, pixel_pitch_x_um, pixel_pitch_y_um, z_min_um, z_max_um, updated_at\)/);
	assert.match(SQL.resultUpsert, /ON CONFLICT \(scan_id\) DO UPDATE SET/);
});

test('POST result: a finished render needs only a cache_key, and rendered_at defaults to now', async () => {
	const { call, world } = claimed();
	const res = await call('POST', '/:id/result', { ...WHO.admin, body: { version: 3, render_status: 'done', columns: { cache_key: `p-${FILE}-123-1760000000.5` } } });
	assert.equal(res.statusCode, 200);
	const [, rendered, key, ...rest] = world.raw[2].bindings.slice(1);
	assert.match(rendered, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
	assert.equal(key, `p-${FILE}-123-1760000000.5`);
	assert.deepEqual(rest, Array(9).fill(null));
});

test('POST result: a failed render stores its error and nothing derived', async () => {
	const { call, world } = claimed();
	const res = await call('POST', '/:id/result', { ...WHO.admin, body: { version: 3, render_status: 'failed', render_error: '  cannot read the file  ' } });
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.data.render_status, 'failed');
	assert.deepEqual(world.raw[2].bindings, [SCAN, 'cannot read the file', null, null, null, null, null, null, null, null, null, null, null]);
	assert.equal(world.scans.get(SCAN).render_status, 'failed');
	// no error text is fine too; a long one is cut
	const bare = claimed();
	await bare.call('POST', '/:id/result', { ...WHO.admin, body: { version: 3, render_status: 'failed' } });
	assert.equal(bare.world.raw[2].bindings[1], null);
	const long = claimed();
	await long.call('POST', '/:id/result', { ...WHO.admin, body: { version: 3, render_status: 'failed', render_error: 'x'.repeat(5000) } });
	assert.equal(long.world.raw[2].bindings[1].length, 2000);
});

test('POST result: administrators only; a member, the file\'s owner and a Lab Viewer are refused with 403 before anything is read or written', async () => {
	for (const who of [WHO.alice, WHO.bob, WHO.carol, WHO.viewer]) {
		const { call, world } = claimed({ file: { owner_person_id: P.alice } });
		const res = await call('POST', '/:id/result', { ...who, body: DONE });
		assert.equal(res.statusCode, 403, who.user);
		assert.equal(res.body.errors[0].extensions.code, 'FORBIDDEN');
		assertUncacheable(res, 'result 403');
		assert.equal(world.raw.length, 0);
		assert.equal(world.txs, 0);
		assert.equal(world.scans.get(SCAN).render_status, 'rendering');
	}
	assert.equal((await claimed().call('POST', '/:id/result', { user: null, body: DONE })).statusCode, 401);
});

test('POST result: an administrator may report on a scan of a file that is not theirs (the worker\'s machine user is an administrator, and nothing is logged)', async () => {
	const { call, world } = claimed({ file: { owner_person_id: P.alice } });
	assert.equal((await call('POST', '/:id/result', { ...WHO.admin, body: DONE })).statusCode, 200);
	assert.equal(world.accessLog.length, 0);
});

test('POST result: a stale version, a scan that is not rendering, and a scan that does not exist are 409 VERSION_CONFLICT with nothing written', async () => {
	const stale = claimed();
	const res = await stale.call('POST', '/:id/result', { ...WHO.admin, body: { ...DONE, version: 2 } });
	assert.equal(res.statusCode, 409);
	assert.equal(res.body.errors[0].extensions.code, 'VERSION_CONFLICT');
	assertUncacheable(res, '409');
	assert.equal(stale.world.results.length, 0);
	assert.equal(stale.world.scans.get(SCAN).render_status, 'rendering');
	assert.equal(stale.world.cacheCleared, 0);
	for (const state of ['pending', 'done', 'failed']) {
		const { call, world } = setup({ row: { render_status: state, version: 3 } });
		const out = await call('POST', '/:id/result', { ...WHO.admin, body: DONE });
		assert.equal(out.statusCode, 409, state);
		assert.equal(out.body.errors[0].extensions.code, 'VERSION_CONFLICT');
		assert.equal(world.results.length, 0);
		assert.equal(world.scans.get(SCAN).render_status, state);
	}
	const missing = await claimed().call('POST', '/:id/result', { ...WHO.admin, id: ID(99), body: DONE });
	assert.equal(missing.statusCode, 409);
	assert.equal((await claimed().call('POST', '/:id/result', { ...WHO.admin, id: 'nope', body: DONE })).statusCode, 404);
});

test('POST result: a report that arrives twice wins once (the second sees the new version)', async () => {
	const { call, world } = claimed();
	assert.equal((await call('POST', '/:id/result', { ...WHO.admin, body: DONE })).statusCode, 200);
	const again = await call('POST', '/:id/result', { ...WHO.admin, body: DONE });
	assert.equal(again.statusCode, 409);
	assert.equal(world.results.length, 1);
});

test('POST result: Render again between the claim and the report beats the worker (it must read the new version)', async () => {
	const { call, world } = claimed();
	world.scans.get(SCAN).render_status = 'pending';
	world.scans.get(SCAN).version = 4;
	assert.equal((await call('POST', '/:id/result', { ...WHO.admin, body: DONE })).statusCode, 409);
});

test('POST result: a failed upsert undoes the claim (one transaction)', async () => {
	const { call, world } = claimed({ env: { CACHE_ENABLED: 'true' } });
	world.failUpsert = true;
	const res = await call('POST', '/:id/result', { ...WHO.admin, body: DONE });
	assert.equal(res.statusCode, 500);
	assert.equal(world.scans.get(SCAN).render_status, 'rendering');
	assert.equal(world.scans.get(SCAN).version, 3);
	assert.equal(world.cacheCleared, 0);
});

test('POST result: validation is a 400 INVALID_PAYLOAD naming the field, and nothing is touched', async () => {
	const withColumns = (patch) => ({ ...DONE, columns: { ...COLUMNS, ...patch } });
	const cases = [
		[null, undefined],
		['text', undefined],
		[[], undefined],
		[{ ...DONE, version: '3' }, 'version'],
		[{ ...DONE, version: 0 }, 'version'],
		[{ ...DONE, version: 1.5 }, 'version'],
		[{ ...DONE, version: undefined }, 'version'],
		[{ ...DONE, render_status: 'rendering' }, 'render_status'],
		[{ ...DONE, render_status: 'pending' }, 'render_status'],
		[{ ...DONE, render_status: undefined }, 'render_status'],
		[{ ...DONE, surprise: 1 }, 'surprise'],
		[{ ...DONE, render_error: 'oops' }, 'render_error'],
		[{ version: 3, render_status: 'failed', render_error: 5 }, 'render_error'],
		[{ version: 3, render_status: 'failed', columns: COLUMNS }, 'columns'],
		[{ version: 3, render_status: 'done' }, 'columns'],
		[{ ...DONE, columns: null }, 'columns'],
		[{ ...DONE, columns: [] }, 'columns'],
		[withColumns({ cache_key: undefined }), 'columns.cache_key'],
		[withColumns({ cache_key: '' }), 'columns.cache_key'],
		[withColumns({ cache_key: '../other' }), 'columns.cache_key'],
		[withColumns({ cache_key: 'a/b' }), 'columns.cache_key'],
		[withColumns({ cache_key: '..' }), 'columns.cache_key'],
		[withColumns({ cache_key: '.hidden' }), 'columns.cache_key'],
		[withColumns({ cache_key: 'x'.repeat(201) }), 'columns.cache_key'],
		[withColumns({ cache_key: 5 }), 'columns.cache_key'],
		[withColumns({ extra: 1 }), 'columns.extra'],
		[withColumns({ render_error: 'x' }), 'columns.render_error'],
		[withColumns({ source_format: '' }), 'columns.source_format'],
		[withColumns({ source_format: 7 }), 'columns.source_format'],
		[withColumns({ source_format: 'x'.repeat(101) }), 'columns.source_format'],
		[withColumns({ source_width: '4096' }), 'columns.source_width'],
		[withColumns({ source_height: 0 }), 'columns.source_height'],
		[withColumns({ grid_width: 10.5 }), 'columns.grid_width'],
		[withColumns({ grid_height: -1 }), 'columns.grid_height'],
		[withColumns({ grid_height: 2 ** 31 }), 'columns.grid_height'],
		[withColumns({ pixel_pitch_x_um: 0 }), 'columns.pixel_pitch_x_um'],
		[withColumns({ pixel_pitch_y_um: -2 }), 'columns.pixel_pitch_y_um'],
		[withColumns({ pixel_pitch_y_um: Number.NaN }), 'columns.pixel_pitch_y_um'],
		[withColumns({ z_min_um: '1' }), 'columns.z_min_um'],
		[withColumns({ z_max_um: Number.POSITIVE_INFINITY }), 'columns.z_max_um'],
		[withColumns({ z_min_um: 50, z_max_um: 40 }), 'columns.z_min_um'],
		[withColumns({ rendered_at: 'yesterday' }), 'columns.rendered_at'],
		[withColumns({ rendered_at: 5 }), 'columns.rendered_at'],
	];
	for (const [body, field] of cases) {
		const { call, world } = claimed();
		const res = await call('POST', '/:id/result', { ...WHO.admin, body });
		assert.equal(res.statusCode, 400, JSON.stringify(body));
		assert.equal(res.body.errors[0].extensions.code, 'INVALID_PAYLOAD');
		if (field) assert.equal(res.body.errors[0].extensions.field, field, JSON.stringify(body));
		assert.equal(world.txs, 0);
		assert.equal(world.results.length, 0);
		assert.equal(world.scans.get(SCAN).render_status, 'rendering');
		assertUncacheable(res, '400');
	}
});

test('POST result: null columns are stored as null, and z_min equal to z_max is fine', async () => {
	const { call, world } = claimed();
	const columns = { cache_key: HASH, source_format: null, source_width: null, pixel_pitch_x_um: null, z_min_um: 5, z_max_um: 5 };
	assert.equal((await call('POST', '/:id/result', { ...WHO.admin, body: { version: 3, render_status: 'done', columns } })).statusCode, 200);
	assert.deepEqual(world.raw[2].bindings.slice(4), [null, null, null, null, null, null, null, 5, 5]);
});

test('POST result: the data cache stays alone when it is off', async () => {
	const { call, world } = claimed();
	await call('POST', '/:id/result', { ...WHO.admin, body: DONE });
	assert.equal(world.cacheCleared, 0);
});
