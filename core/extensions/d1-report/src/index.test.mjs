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
import { Readable } from 'node:stream';
import { recordLink, EXPLORER_PAGES, renderSampleReport, renderOperationReport, conformAppendix, parseConformCsv } from './render.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OP_A = '22222222-2222-4222-8222-222222222222';
const OP_B = '33333333-3333-4333-8333-333333333333';
const TEST_ID = '44444444-4444-4444-8444-444444444444';
const OP_CF = '88888888-8888-4888-8888-888888888888';
const LOG_CF = '99999999-9999-4999-8999-999999999999';
const FILE_CF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = '55555555-5555-4555-8555-555555555555';
const PROJ_A = '66666666-6666-4666-8666-666666666666';
const PROJ_B = '77777777-7777-4777-8777-777777777777';

const forbidden = () => Object.assign(new Error('You do not have permission'), { code: 'FORBIDDEN', status: 403 });

// Data the fake ItemsService serves, keyed by collection.
const DATA = {
	physical_samples: [
		{ sample_id: SID, sample_code: 'S-001', owner_person_id: PERSON, project_id: PROJ_A, nickname: 'nick', form: 'round_bar', diameter_mm: 10 },
	],
	people: [{ person_id: PERSON, full_name: 'Ada Lovelace', email: 'ada@example.org' }],
	manufacturing_operations: [
		{ operation_id: OP_A, sample_id: SID, campaign_id: null, project_id: PROJ_A, process_category: 'machining' },
		{ operation_id: OP_B, sample_id: SID, campaign_id: null, project_id: PROJ_B, process_category: 'machining' },
	],
	test_sessions: [{ session_id: TEST_ID, sample_id: SID, campaign_id: null, project_id: PROJ_B, test_type: 'tensile' }],
	sample_genealogy: [],
	campaigns: [],
	manufacturing_methods: [],
	projects: [
		{ project_id: PROJ_A, project_code: 'PRJ-ALPHA', project_name: 'Alpha Project' },
		{ project_id: PROJ_B, project_code: 'PRJ-BETA', project_name: 'Beta Project' },
	],
	equipment: [],
	machining_force_analysis: [],
	fast_run_data: [],
	conform_run_data: [], // filled in with the Conform fixtures below
	conform_logs: [],
};

const PK = {
	physical_samples: 'sample_id',
	people: 'person_id',
	manufacturing_operations: 'operation_id',
	test_sessions: 'session_id',
	projects: 'project_id',
	conform_logs: 'log_id',
	conform_run_data: 'id',
};

// `allowed` maps collection -> predicate(row) | true. Unlisted collections are forbidden.
// `env_override` is passed to endpoint.handler's env param.
function harness(allowed, env_override) {
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

	// Directus's AssetsService, as d1-report uses it for the Conform CSV: getAsset(id) -> {stream}.
	const assetCalls = [];
	class AssetsService {
		constructor(opts) {
			this.opts = opts;
		}
		async getAsset(id) {
			assetCalls.push({ id, accountability: this.opts.accountability });
			return { stream: Readable.from([Buffer.from(cfCsv())]) };
		}
	}

	const dbCalls = [];
	const viewRows = {
		v_complete_sample_history: [
			{ sample_id: SID, sample_code: 'S-001', material_name: 'Ti-64', project_code: 'PRJ-ALPHA', project_name: 'Alpha Project', project_document_number: 'DOC-ALPHA-1' },
		],
		v_manufacturing_operations_full: [
			{ operation_id: OP_A, sample_id: SID, method_name: 'Turning', operation_date: '2026-01-02', project_code: 'PRJ-ALPHA', project_name: 'Alpha Project' },
			{ operation_id: OP_B, sample_id: SID, method_name: 'Milling', operation_date: '2026-01-03', project_code: 'PRJ-BETA', project_name: 'Beta Project' },
		],
		v_test_sessions_full: [
			{ session_id: TEST_ID, sample_id: SID, test_type: 'tensile', session_date: '2026-02-01', project_code: 'PRJ-BETA', project_name: 'Beta Project' },
		],
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
	const env = env_override !== undefined ? env_override : { PUBLIC_URL: 'https://lims.example.org' };
	endpoint.handler(router, {
		database,
		env,
		logger,
		services: { ItemsService, AssetsService },
		getSchema: async () => ({ collections: {} }),
	});
	return { routes, dbCalls, constructed, assetCalls };
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

test('sample: the views carry project code and name, shown only for projects the caller can read', async () => {
	const everything = { physical_samples: true, manufacturing_operations: true, test_sessions: true };
	// No access to projects at all: nothing of any project leaks from the root-knex views.
	const none = await get(harness(everything).routes, '/sample/:id', SID, user);
	assert.equal(none.out.status, 200);
	for (const secret of ['PRJ-ALPHA', 'Alpha Project', 'DOC-ALPHA-1', 'PRJ-BETA', 'Beta Project']) {
		assert.doesNotMatch(none.out.body, new RegExp(secret), secret);
	}
	// Row filter: only project A is readable. The sample and its A-operation show A; the B-operation
	// and the B-test do not show B.
	const onlyA = await get(
		harness({ ...everything, projects: (r) => r.project_id === PROJ_A }).routes, '/sample/:id', SID, user);
	assert.match(onlyA.out.body, /PRJ-ALPHA/);
	assert.doesNotMatch(onlyA.out.body, /PRJ-BETA|Beta Project/);
	// All readable: both appear.
	const all = await get(harness({ ...everything, projects: true }).routes, '/sample/:id', SID, user);
	assert.match(all.out.body, /PRJ-ALPHA/);
	assert.match(all.out.body, /PRJ-BETA/);
});

test('sample: project ids are checked in one projects read through the caller accountability', async () => {
	const h = harness({ physical_samples: true, manufacturing_operations: true, test_sessions: true, projects: true });
	const { req } = await get(h.routes, '/sample/:id', SID, user);
	const reads = h.constructed.filter((c) => c.collection === 'projects');
	assert.equal(reads.length, 1);
	assert.equal(reads[0].opts.accountability, req.accountability);
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

// ---- Label redirects to Explorer page ---------------------------------------------------

async function getRedirect(routes, route, query) {
	const out = { status: 200, headers: {}, body: '' };
	const res = {
		status(code) {
			out.status = code;
			return res;
		},
		redirect(location) {
			out.redirectTo = location;
			return res;
		},
	};
	const req = { query, accountability: { user: 'test' }, schema: { collections: {} } };
	await routes[route](req, res);
	return out;
}

test('GET /label encodes query parameters', async () => {
	const { routes } = harness({});
	const out = await getRedirect(routes, '/label', { codes: 'S 001&x=1' });
	assert.equal(out.status, 302);
	// URL.searchParams encodes spaces as +, & as %26, = as %3D
	assert.ok(out.redirectTo.includes('codes=S+001%26x%3D1') || out.redirectTo.includes('codes=S%20001%26x%3D1'));
});

test('GET /label includes PUBLIC_URL as base when set', async () => {
	const { routes } = harness({}, { PUBLIC_URL: 'https://d1.example.org/lab' });
	const out = await getRedirect(routes, '/label', { ids: SID });
	assert.equal(out.status, 302);
	assert.equal(out.redirectTo, `https://d1.example.org/lab/d1-links/go/p/labels?ids=${SID}`);
});

test('GET /label uses root-relative path when PUBLIC_URL is empty', async () => {
	const { routes } = harness({}, { PUBLIC_URL: '' });
	const out = await getRedirect(routes, '/label', { codes: 'S-001' });
	assert.equal(out.status, 302);
	assert.equal(out.redirectTo, '/d1-links/go/p/labels?codes=S-001');
});

test('GET /labels includes PUBLIC_URL as base when set', async () => {
	const { routes } = harness({}, { PUBLIC_URL: 'https://d1.example.org/lab/' });
	const out = await getRedirect(routes, '/labels', {});
	assert.equal(out.status, 302);
	assert.equal(out.redirectTo, 'https://d1.example.org/lab/d1-links/go/p/labels');
});

const LIMS = 'https://lims.example.org';

test('recordLink: the permanent link on the Directus host, whatever the collection', () => {
	assert.equal(recordLink(LIMS, 'physical_samples', SID), `${LIMS}/d1-links/go/r/physical_samples/${SID}`);
	assert.equal(recordLink(`${LIMS}///`, 'equipment', 'a/b c'), `${LIMS}/d1-links/go/r/equipment/a%2Fb%20c`);
	assert.equal(recordLink('', 'projects', 'p1'), '/d1-links/go/r/projects/p1');
	assert.equal(recordLink(undefined, 'projects', 'p1'), '/d1-links/go/r/projects/p1');
});

test('every report links through permanent links, with no Directus Home or STARbase address in it', async () => {
	const env = { PUBLIC_URL: LIMS, STARBASE_URL: 'https://starbase.example.org' };
	const h = harness({ physical_samples: true, manufacturing_operations: true, test_sessions: true, people: true, sample_genealogy: true }, env);
	const sample = await get(h.routes, '/sample/:id', SID, user);
	assert.ok(sample.out.body.includes(`${LIMS}/d1-links/go/r/physical_samples/${SID}`), 'sample report');
	const op = await get(h.routes, '/operation/:id', OP_A, user);
	assert.ok(op.out.body.includes(`${LIMS}/d1-links/go/r/manufacturing_operations/${OP_A}`), 'operation report');
	assert.ok(op.out.body.includes(`${LIMS}/d1-links/go/r/physical_samples/${SID}`), "operation report's sample link");
	const t = await get(h.routes, '/test/:id', TEST_ID, user);
	assert.ok(t.out.body.includes(`${LIMS}/d1-links/go/r/test_sessions/${TEST_ID}`), 'test report');
	for (const body of [sample.out.body, op.out.body, t.out.body]) {
		assert.ok(!body.includes('/admin/home/'), 'a Directus Home link is left');
		assert.ok(!body.includes('starbase.example.org'), 'the front end is printed');
	}
});

test('GET /label and /labels go to the labels page through the permanent link, query kept', async () => {
	const { routes } = harness({}, { PUBLIC_URL: `${LIMS}/` });
	assert.equal((await getRedirect(routes, '/label', { ids: SID, codes: 'S 1' })).redirectTo, `${LIMS}/d1-links/go/p/labels?ids=${SID}&codes=S+1`);
	assert.equal((await getRedirect(routes, '/label', {})).redirectTo, `${LIMS}/d1-links/go/p/labels`);
	assert.equal((await getRedirect(routes, '/labels', {})).redirectTo, `${LIMS}/d1-links/go/p/labels`);
	const { routes: bare } = harness({}, {});
	assert.equal((await getRedirect(bare, '/label', { codes: 'S-001' })).redirectTo, '/d1-links/go/p/labels?codes=S-001');
});

test('the PDF shows choice labels, not stored codes', () => {
	const sample = renderSampleReport({
		sample: { sample_id: 'aaaa-1', sample_code: '1-X', form: 'tensile_coupon', material_name: 'Ti64' },
		surfaceFinish: 'medium_machined', ops: [{ operation_id: 'o1', pass_code: 'P1', method_name: 'Turning', machining_operation_subtype: 'MT-F' }], parents: [],
		children: [{ child_sample_code: '1-Y', child_form: 'bend_bar' }], tests: [], qrSvg: '', recordUrl: '/x',
	});
	for (const text of ['Medium machined', 'Tensile coupon (ISO 6892)', 'Turning · Turning – Facing', 'Bend bar (ISO 7438)']) {
		assert.ok(sample.includes(text), text);
	}
	for (const code of ['medium_machined', '>tensile_coupon<', 'MT-F', 'bend_bar']) assert.ok(!sample.includes(code), `still shows ${code}`);
	const op = renderOperationReport({
		op: { operation_id: 'o1', pass_code: 'P1', method_name: 'Milling', process_category: 'machining', machining_operation_subtype: 'MM-D' },
		qrSvg: '', recordUrl: '/x', publicUrl: '',
	});
	assert.ok(op.includes('Milling – Drilling'));
	assert.ok(!op.includes('MM-D'));
});

// ---------------------------------------------------------------------------
// Conform run appendix
// ---------------------------------------------------------------------------

// 300 one-second rows. The run window is rows 60..239 (three 60 s steps), so the
// first and last 60 rows must not be plotted. 2025-07-01 is BST: 12:00Z = 13:00 UK.
const CF_START = '2025-07-01T12:00:00.000Z';
const CF_SERIES = [
	{ key: 'wheel_speed_rpm', label: 'Wheel speed', unit: 'rpm', group: 'speed' },
	{ key: 'wheel_speed_demand_rpm', label: 'Wheel speed demand', unit: 'rpm', group: 'speed' },
	{ key: 'motor_torque_pct', label: 'Motor torque', unit: '%', group: 'torque' },
	{ key: 'tooling1_c', label: 'Tooling 1 (behind abutment)', unit: '°C', group: 'temp' },
	{ key: 'tooling2_c', label: 'Tooling 2 (die exit)', unit: '°C', group: 'temp' },
	{ key: 'wheel_temp_c', label: 'Wheel temperature', unit: '°C', group: 'temp' },
	{ key: 'ips_output_pct', label: 'IPS output', unit: '%', group: 'ips' },
];
function cfCsv(series = CF_SERIES) {
	const lines = ['time_s,' + series.map((c) => c.key).join(',')];
	for (let i = 0; i < 300; i++) {
		const step = Math.floor(i / 100);
		const v = { wheel_speed_rpm: 5 + step, wheel_speed_demand_rpm: 5 + step, motor_torque_pct: 30 + (i % 7), tooling1_c: 400 + step * 20 + i / 50, tooling2_c: 380 + step * 10, wheel_temp_c: 200 + i / 30, ips_output_pct: 40 + step };
		lines.push(i + ',' + series.map((c) => v[c.key]).join(','));
	}
	return lines.join('\r\n') + '\r\n';
}
const CF_RANGE = (min, max) => ({ min, max, range: max - min });
const CF_RUN = {
	status: 'done',
	window_start: '2025-07-01T12:01:00.000Z',
	window_end: '2025-07-01T12:04:00.000Z',
	summary: {
		duration_s: 179, extruding_s: 175, mean_wheel_speed_rpm: 6, mean_torque_pct: 33, mean_tooling1_c: 430, peak_torque_pct: 36,
		peak_motor_current_a: 41.2, peak_tooling1_c: 462, peak_wheel_temp_c: 207, ips_setpoint_c: 450,
		energy_kwh: { motor: 1.5, ips: 2.25, cooling: 0.25, total: 4 }, avg_demand_kw: 80.4, missing: [],
	},
	steps: [0, 1, 2].map((k) => ({
		start: new Date(Date.parse(CF_START) + (60 + k * 60) * 1000).toISOString(),
		end: new Date(Date.parse(CF_START) + (119 + k * 60) * 1000).toISOString(),
		duration_s: 60, ips_setpoint_c: 450, wheel_speed_rpm: 5 + k, wheel_temp_c: CF_RANGE(200, 204), tooling1_c: CF_RANGE(410, 420), tooling2_c: null,
		mean_torque_pct: 33, energy_kwh: 1.3,
	})),
};
const CF_LOG = { log_start: CF_START, series: CF_SERIES };

test('conformAppendix: four panels, summary, three steps, window rows only', () => {
	const trace = parseConformCsv(cfCsv(), CF_SERIES);
	assert.equal(trace.time.length, 300);
	const { toggles, blocks } = conformAppendix(CF_RUN, CF_LOG, trace);
	for (const t of ['Wheel speed', 'Motor torque', 'Temperatures', 'IPS output']) assert.ok(blocks.includes(`>${t}<`), `panel ${t}`);
	assert.ok(blocks.includes('Extruding time') && blocks.includes('Energy (total)'));
	const stepsTable = blocks.split('class="tbl cf-steps"')[1].split('</table>')[0];
	assert.equal((stepsTable.match(/<tr>/g) || []).length - 1, 3, 'header row + 3 step rows');
	// Window is 12:01:00 to 12:04:00, i.e. rows 60..239: 180 points per line.
	assert.deepEqual([...blocks.matchAll(/data-rows="(\d+)"/g)].map((m) => m[1]), ['180', '180', '180', '180']);
	// UK local time (BST), not UTC.
	assert.ok(blocks.includes('13:01:00') && !blocks.includes('12:01:00'));
	assert.ok(toggles.includes('data-block="conform-trace"'));
});

test('conformAppendix: a missing channel drops its line, a missing panel its box', () => {
	const series = CF_SERIES.filter((c) => c.key !== 'ips_output_pct' && c.key !== 'tooling2_c');
	const trace = parseConformCsv(cfCsv(series), series);
	const { blocks } = conformAppendix(CF_RUN, { ...CF_LOG, series }, trace);
	assert.ok(!blocks.includes('>IPS output<'));
	assert.ok(!blocks.includes('Tooling 2'));
	assert.ok(blocks.includes('>Temperatures<'));
});

test('conformAppendix: an unreadable log still shows the summary and steps', () => {
	const { blocks } = conformAppendix(CF_RUN, null, null);
	assert.ok(blocks.includes('Conform log not visible to you'));
	assert.ok(blocks.includes('Extruding time'));
	assert.ok(!blocks.includes('data-rows'));
	assert.deepEqual(conformAppendix(null, CF_LOG, null), { toggles: '', blocks: '' });
	assert.deepEqual(conformAppendix({ ...CF_RUN, status: 'no_window' }, CF_LOG, null), { toggles: '', blocks: '' });
});

test('conformAppendix: missing power channels are named', () => {
	const run = { ...CF_RUN, summary: { ...CF_RUN.summary, energy_kwh: { motor: 1, ips: null, cooling: null, total: 1 }, missing: ['ips', 'cooling'] } };
	const { blocks } = conformAppendix(run, null, null);
	assert.ok(/not measured: ips, cooling/i.test(blocks));
});

test('parseConformCsv: blank cells are NaN, column i+1 follows series[i]', () => {
	const t = parseConformCsv('time_s,a,b\n0,1,\n1,,4\n', [{ key: 'a' }, { key: 'b' }]);
	assert.deepEqual(t.time, [0, 1]);
	assert.equal(t.cols.a[0], 1);
	assert.ok(Number.isNaN(t.cols.a[1]) && Number.isNaN(t.cols.b[0]));
	assert.equal(t.cols.b[1], 4);
});

DATA.manufacturing_operations.push({ operation_id: OP_CF, sample_id: null, campaign_id: null, project_id: PROJ_A, process_category: 'conform', pass_code: '01-07-25-CF-001-8dia' });
DATA.conform_run_data.push({ id: 1, operation_id: OP_CF, log_id: LOG_CF, ...CF_RUN });
DATA.conform_logs.push({ log_id: LOG_CF, directus_files_id: FILE_CF, ...CF_LOG });
const conformHarness = (over = {}) => harness({ manufacturing_operations: true, conform_run_data: true, conform_logs: true, ...over });

test('operation report: a conform op renders the Conform appendix (log fetched through the caller)', async () => {
	const h = conformHarness();
	const { out } = await get(h.routes, '/operation/:id', OP_CF, user);
	assert.equal(out.status, 200);
	assert.ok(out.body.includes('Conform (continuous extrusion)'), 'category label');
	assert.ok(out.body.includes('>Wheel speed<') && out.body.includes('Energy (total)'));
	assert.deepEqual([...out.body.matchAll(/data-rows="(\d+)"/g)].map((m) => m[1]), ['180', '180', '180', '180']);
	assert.deepEqual(h.assetCalls, [{ id: FILE_CF, accountability: user }]);
});

test('operation report: a conform log the caller cannot read gives the placeholder, not an error', async () => {
	const h = conformHarness({ conform_logs: false });
	const { out } = await get(h.routes, '/operation/:id', OP_CF, user);
	assert.equal(out.status, 200);
	assert.ok(out.body.includes('Conform log not visible to you'));
	assert.ok(out.body.includes('Extruding time'));
	assert.equal(h.assetCalls.length, 0);
});
