// Run with: npm test   (node --test; needs `npm ci` for qrcode / the SDK)
//
// Endpoint-level tests with a fake Directus: `ItemsService` enforces a permission
// table (the caller's accountability), `database` is a recording fake for the v_*
// views. They prove the d1-report endpoints (a) read through the caller's
// accountability, (b) answer "not permitted" exactly like "not found", and (c)
// never touch the root database handle for a row the caller cannot read.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import endpoint from './index.js';
import { readFileSync } from 'node:fs';
import { adminRecordUrl, EXPLORER_PAGES } from './render.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OP_A = '22222222-2222-4222-8222-222222222222';
const OP_B = '33333333-3333-4333-8333-333333333333';
const TEST_ID = '44444444-4444-4444-8444-444444444444';
const PERSON = '55555555-5555-4555-8555-555555555555';

const forbidden = () => Object.assign(new Error('You do not have permission'), { code: 'FORBIDDEN', status: 403 });

// Data the fake ItemsService serves, keyed by collection.
const DATA = {
	physical_samples: [
		{ sample_id: SID, sample_code: 'S-001', owner_person_id: PERSON, nickname: 'nick', form: 'round_bar', diameter_mm: 10 },
	],
	people: [{ person_id: PERSON, full_name: 'Ada Lovelace', email: 'ada@example.org' }],
	manufacturing_operations: [
		{ operation_id: OP_A, sample_id: SID, campaign_id: null, process_category: 'machining' },
		{ operation_id: OP_B, sample_id: SID, campaign_id: null, process_category: 'machining' },
	],
	test_sessions: [{ session_id: TEST_ID, sample_id: SID, campaign_id: null, test_type: 'tensile' }],
	sample_genealogy: [],
	campaigns: [],
	manufacturing_methods: [],
	projects: [],
	equipment: [],
	machining_force_analysis: [],
	fast_run_data: [],
};

const PK = {
	physical_samples: 'sample_id',
	people: 'person_id',
	manufacturing_operations: 'operation_id',
	test_sessions: 'session_id',
};

// `allowed` maps collection -> predicate(row) | true. Unlisted collections are forbidden.
function harness(allowed) {
	const constructed = [];
	class ItemsService {
		constructor(collection, opts) {
			this.collection = collection;
			constructed.push({ collection, opts });
		}
		rows() {
			const rule = allowed[this.collection];
			if (!rule) throw forbidden();
			return (DATA[this.collection] || []).filter((r) => rule === true || rule(r));
		}
		async readOne(id) {
			const row = this.rows().find((r) => String(r[PK[this.collection]]) === String(id));
			if (!row) throw forbidden(); // Directus: missing and forbidden look the same
			return row;
		}
		async readByQuery({ filter }) {
			const rows = this.rows();
			const match = (r, f) =>
				Object.entries(f).every(([k, cond]) => {
					if (k === '_and') return cond.every((c) => match(r, c));
					if (cond._eq !== undefined) return String(r[k]) === String(cond._eq);
					if (cond._in) return cond._in.map(String).includes(String(r[k]));
					return true;
				});
			return rows.filter((r) => (filter ? match(r, filter) : true));
		}
	}

	const dbCalls = [];
	const viewRows = {
		v_complete_sample_history: [{ sample_id: SID, sample_code: 'S-001', material_name: 'Ti-64' }],
		v_manufacturing_operations_full: [
			{ operation_id: OP_A, sample_id: SID, method_name: 'Turning', operation_date: '2026-01-02' },
			{ operation_id: OP_B, sample_id: SID, method_name: 'Milling', operation_date: '2026-01-03' },
		],
		v_test_sessions_full: [{ session_id: TEST_ID, sample_id: SID, test_type: 'tensile', session_date: '2026-02-01' }],
		v_sample_genealogy_flat: [],
	};
	const database = (table) => {
		const base = table.split(' as ')[0];
		const call = { table: base, whereIn: null };
		dbCalls.push(call);
		let rows = [...(viewRows[base] || [])];
		const chain = new Proxy(
			{},
			{
				get(_t, prop) {
					if (prop === 'then') return (res, rej) => Promise.resolve(rows).then(res, rej);
					if (prop === 'first') return async () => rows[0];
					if (prop === 'whereIn')
						return (col, ids) => {
							call.whereIn = ids;
							rows = rows.filter((r) => ids.map(String).includes(String(r[col])));
							return chain;
						};
					return () => chain;
				},
			}
		);
		return chain;
	};

	const routes = {};
	const router = { get: (path, fn) => (routes[path] = fn) };
	const logger = { error: () => {} };
	endpoint.handler(router, {
		database,
		env: { PUBLIC_URL: 'https://lims.example.org' },
		logger,
		services: { ItemsService },
		getSchema: async () => ({ collections: {} }),
	});
	return { routes, dbCalls, constructed };
}

async function get(routes, route, id, accountability) {
	const out = { status: 200, headers: {}, body: '' };
	const res = {
		status(code) {
			out.status = code;
			return res;
		},
		set(k, v) {
			out.headers[k] = v;
			return res;
		},
		type(t) {
			out.headers['Content-Type'] = t;
			return res;
		},
		send(body) {
			out.body = body;
			return res;
		},
	};
	const req = { params: { id }, accountability, schema: { collections: { marker: true } } };
	await routes[route](req, res);
	return { out, req };
}

const user = { user: 'u1', role: 'r1' };

test('unauthenticated requests are 401', async () => {
	const { routes } = harness({ physical_samples: true });
	for (const [route, id] of [['/sample/:id', SID], ['/operation/:id', OP_A], ['/test/:id', TEST_ID]]) {
		const { out } = await get(routes, route, id, {});
		assert.equal(out.status, 401);
	}
});

test('sample: not permitted answers exactly like not found, and the database is never read', async () => {
	const denied = harness({}); // no collection readable
	const missing = harness({ physical_samples: true });
	const a = await get(denied.routes, '/sample/:id', SID, user);
	const b = await get(missing.routes, '/sample/:id', '99999999-9999-4999-8999-999999999999', user);
	const c = await get(missing.routes, '/sample/:id', 'NO-SUCH-CODE', user);
	for (const r of [a, b, c]) {
		assert.equal(r.out.status, 404);
		assert.equal(r.out.body, 'Sample not found.');
	}
	assert.equal(denied.dbCalls.length, 0, 'root database must not be read for an unreadable sample');
	// A row-level filter that hides this sample behaves the same.
	const filtered = harness({ physical_samples: () => false });
	const d = await get(filtered.routes, '/sample/:id', 'S-001', user);
	assert.deepEqual([d.out.status, d.out.body], [404, 'Sample not found.']);
	assert.equal(filtered.dbCalls.length, 0);
});

test('sample: reads go through the caller accountability and schema', async () => {
	const h = harness({ physical_samples: true });
	const { req } = await get(h.routes, '/sample/:id', 'S-001', user);
	assert.ok(h.constructed.length > 0);
	for (const c of h.constructed) {
		assert.equal(c.opts.accountability, req.accountability);
		assert.equal(c.opts.schema, req.schema);
	}
});

test('sample: only operations the caller may read are fetched; owner needs people access', async () => {
	const h = harness({
		physical_samples: true,
		manufacturing_operations: (r) => r.operation_id === OP_A, // OP_B hidden
		test_sessions: true,
		// people and sample_genealogy are NOT readable
	});
	const { out } = await get(h.routes, '/sample/:id', SID, user);
	assert.equal(out.status, 200);
	const opCall = h.dbCalls.find((c) => c.table === 'v_manufacturing_operations_full');
	assert.deepEqual(opCall.whereIn, [OP_A]);
	assert.match(out.body, /Turning/);
	assert.doesNotMatch(out.body, /Milling/);
	assert.doesNotMatch(out.body, /ada@example\.org/);
	assert.ok(!h.dbCalls.some((c) => c.table === 'v_sample_genealogy_flat'), 'lineage hidden without sample_genealogy access');
});

test('sample: a caller who can read people sees the owner', async () => {
	const h = harness({ physical_samples: true, people: true, manufacturing_operations: true, test_sessions: true, sample_genealogy: true });
	const { out } = await get(h.routes, '/sample/:id', SID, user);
	assert.equal(out.status, 200);
	assert.match(out.body, /ada@example\.org/);
});

test('operation: forbidden, missing and malformed ids are indistinguishable', async () => {
	const denied = harness({});
	const open = harness({ manufacturing_operations: true });
	const rs = [
		await get(denied.routes, '/operation/:id', OP_A, user),
		await get(open.routes, '/operation/:id', '99999999-9999-4999-8999-999999999999', user),
		await get(open.routes, '/operation/:id', "not-a-uuid'; drop", user),
	];
	for (const r of rs) assert.deepEqual([r.out.status, r.out.body], [404, 'Operation not found.']);
	const ok = await get(open.routes, '/operation/:id', OP_A, user);
	assert.equal(ok.out.status, 200);
});

test('operation: related collections the caller cannot read are left blank, not an error', async () => {
	const h = harness({ manufacturing_operations: true }); // physical_samples etc. forbidden
	const { out } = await get(h.routes, '/operation/:id', OP_A, user);
	assert.equal(out.status, 200);
	assert.equal(h.dbCalls.length, 0);
});

test('test session: forbidden, missing and malformed ids are indistinguishable', async () => {
	const denied = harness({});
	const open = harness({ test_sessions: true });
	const rs = [
		await get(denied.routes, '/test/:id', TEST_ID, user),
		await get(open.routes, '/test/:id', '99999999-9999-4999-8999-999999999999', user),
		await get(open.routes, '/test/:id', 'x', user),
	];
	for (const r of rs) assert.deepEqual([r.out.status, r.out.body], [404, 'Test not found.']);
	const ok = await get(open.routes, '/test/:id', TEST_ID, user);
	assert.equal(ok.out.status, 200);
});

// ---- QR / in-report link target -------------------------------------------------------

test('adminRecordUrl: records with an Explorer page open there', () => {
	assert.equal(adminRecordUrl('https://lims.example.org', 'physical_samples', SID), `https://lims.example.org/admin/home/samples/${SID}`);
	assert.equal(adminRecordUrl('https://lims.example.org', 'manufacturing_operations', OP_A), `https://lims.example.org/admin/home/operations/${OP_A}`);
	assert.equal(adminRecordUrl('https://lims.example.org', 'test_sessions', TEST_ID), `https://lims.example.org/admin/home/tests/${TEST_ID}`);
	assert.equal(adminRecordUrl('https://lims.example.org', 'campaigns', 'c1'), 'https://lims.example.org/admin/home/campaigns/c1');
	assert.equal(adminRecordUrl('https://lims.example.org', 'projects', 'p1'), 'https://lims.example.org/admin/home/projects/p1');
});

test('adminRecordUrl: anything else goes to the Data Studio form', () => {
	assert.equal(adminRecordUrl('https://lims.example.org', 'equipment', 'e1'), 'https://lims.example.org/admin/content/equipment/e1');
});

test('adminRecordUrl: trims trailing slashes and encodes the id', () => {
	assert.equal(adminRecordUrl('https://lims.example.org///', 'physical_samples', 'a/b c'), 'https://lims.example.org/admin/home/samples/a%2Fb%20c');
	assert.equal(adminRecordUrl('', 'physical_samples', 'x'), '/admin/home/samples/x');
	assert.equal(adminRecordUrl(undefined, 'physical_samples', 'x'), '/admin/home/samples/x');
});

test('EXPLORER_PAGES matches RECORD_PAGES in the kit (packages/d1-ui/src/recordRoute.ts)', () => {
	// d1-report cannot import the kit, so its copy of the table is checked against the source.
	const src = readFileSync(new URL('../../../../packages/d1-ui/src/recordRoute.ts', import.meta.url), 'utf8');
	const body = /const RECORD_PAGES[^=]*=\s*\{([^}]*)\}/.exec(src);
	assert.ok(body, 'RECORD_PAGES not found in recordRoute.ts');
	const kit = {};
	for (const m of body[1].matchAll(/(\w+)\s*:\s*'\/home\/([^']+)'/g)) kit[m[1]] = m[2];
	assert.ok(Object.keys(kit).length >= 5, 'parsed too few RECORD_PAGES entries');
	assert.deepEqual(EXPLORER_PAGES, kit);
});

test('reports link back to the Explorer page of the record, not the Data Studio form', async () => {
	const h = harness({ physical_samples: true, manufacturing_operations: true, test_sessions: true, people: true, sample_genealogy: true });
	const sample = await get(h.routes, '/sample/:id', SID, user);
	assert.ok(sample.out.body.includes(`/admin/home/samples/${SID}`), 'sample report');
	assert.ok(!sample.out.body.includes('/admin/content/physical_samples/'), 'no Data Studio sample link left');
	const op = await get(h.routes, '/operation/:id', OP_A, user);
	assert.ok(op.out.body.includes(`/admin/home/operations/${OP_A}`), 'operation report QR target');
	const t = await get(h.routes, '/test/:id', TEST_ID, user);
	assert.ok(t.out.body.includes(`/admin/home/tests/${TEST_ID}`), 'test report QR target');
});
