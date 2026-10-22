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
import { recordLink, EXPLORER_PAGES, renderSampleReport, renderOperationReport } from './render.js';
import { conformAppendix, parseConformCsv, fmtDuration, niceTicks, tickLabel } from './conform.js';
import { CONFORM_FIGURES, DASH, figureNumber, formatFigure, niceNumber } from './conformFigures.js';

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
// `assetError`, when given, is thrown by the fake AssetsService instead of serving the CSV.
function harness(allowed, env_override, assetError) {
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
			if (assetError) throw assetError;
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
	assert.ok(blocks.includes('Extruding time') && blocks.includes('Total energy'));
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

test('conformAppendix: summary and steps use the shared formats (kWh and kW to 2 decimals, "12 min 05 s", UK clock times)', () => {
	const { blocks } = conformAppendix(CF_RUN, null, null);
	const sum = blocks.split('class="tbl cf-sum"')[1].split('</table>')[0];
	assert.ok(sum.includes('2 min 59 s'), 'duration 179 s');
	assert.ok(sum.includes('2 min 55 s'), 'extruding 175 s');
	for (const kwh of ['1.50 kWh', '2.25 kWh', '0.25 kWh', '4.00 kWh']) assert.ok(sum.includes(kwh), kwh);
	assert.ok(sum.includes('80.40 kW'), 'average demand to 2 decimals');
	assert.ok(!sum.includes('4.000') && !sum.includes('80.4 kW'));
	// DESIGN 5b numbers: integers from 100, one decimal from 10, up to two below, no trailing zeros; labels in sentence case
	for (const text of ['>6 rpm<', '>33 %<', '>430 °C<', '>41.2 A<', '>462 °C<', '>207 °C<', '>450 °C<']) assert.ok(sum.includes(text), text);
	for (const label of ['Mean wheel speed', 'Mean tooling 1', 'Peak tooling 1', 'Motor energy', 'IPS energy', 'Cooling energy', 'Total energy', 'Average demand']) {
		assert.ok(sum.includes(`>${label}<`), label);
	}
	assert.ok(!sum.includes('Energy (') && !sum.includes('(behind abutment)'));
	const steps = blocks.split('class="tbl cf-steps"')[1].split('</table>')[0];
	assert.ok(steps.includes('1 min 00 s') && !steps.includes('60 s'), 'a 60 s step');
	assert.equal((steps.match(/>1\.30</g) || []).length, 3, 'step energy to 2 decimals');
	assert.ok(steps.includes('>410–420 (10)<') || steps.includes('>410–420 (10)</td>') || steps.includes('410–420 (10)'), 'ranges by the nice-number rule');
	assert.ok(steps.includes('>450<') && !steps.includes('450.0'), 'the IPS setpoint is an integer');
	assert.ok(steps.includes('13:02:00') && steps.includes('13:02:59'), 'HH:MM:SS UK time');
});

test('fmtDuration: under an hour "12 min 05 s", from an hour "1 h 23 min", a dash for nothing', () => {
	assert.equal(fmtDuration(725), '12 min 05 s');
	assert.equal(fmtDuration(0), '0 min 00 s');
	assert.equal(fmtDuration(59.6), '1 min 00 s', 'whole seconds first');
	assert.equal(fmtDuration(3599), '59 min 59 s');
	assert.equal(fmtDuration(3600), '1 h 00 min');
	assert.equal(fmtDuration(4985), '1 h 23 min', '83 min 05 s: the seconds are dropped, not rounded up');
	assert.equal(fmtDuration(4999), '1 h 23 min');
	assert.equal(fmtDuration(36000 + 61), '10 h 01 min');
	for (const bad of [null, undefined, '', 'x', NaN, -5]) assert.equal(fmtDuration(bad), '—');
});

test('conformAppendix: a window of fewer than 2 rows says "Run window too short to plot", 2 rows plot', () => {
	const trace = parseConformCsv(cfCsv(), CF_SERIES);
	const short = { ...CF_RUN, window_start: '2025-07-01T12:01:00.000Z', window_end: '2025-07-01T12:01:01.000Z' }; // row 60 only
	const out = conformAppendix(short, CF_LOG, trace).blocks;
	assert.ok(out.includes('Run window too short to plot'));
	assert.ok(!out.includes('data-rows') && !out.includes('not visible') && !out.includes('Could not load'));
	assert.ok(out.includes('Extruding time'), 'the summary is still there');
	const two = { ...CF_RUN, window_start: '2025-07-01T12:01:00.000Z', window_end: '2025-07-01T12:01:02.000Z' };
	assert.deepEqual([...conformAppendix(two, CF_LOG, trace).blocks.matchAll(/data-rows="(\d+)"/g)].map((m) => m[1]), ['2', '2', '2', '2']);
	const none = { ...CF_RUN, window_start: '2025-07-01T12:30:00.000Z', window_end: '2025-07-01T12:31:00.000Z' }; // after the last row
	assert.ok(conformAppendix(none, CF_LOG, trace).blocks.includes('Run window too short to plot'));
});

test('conformAppendix: "not visible to you" only for a forbidden read; any other failure says "Could not load the Conform log"', () => {
	const trace = parseConformCsv(cfCsv(), CF_SERIES);
	const hidden = conformAppendix(CF_RUN, CF_LOG, null, 'forbidden').blocks;
	assert.ok(hidden.includes('Conform log not visible to you') && !hidden.includes('Could not load'));
	const failed = conformAppendix(CF_RUN, CF_LOG, null, 'failed').blocks;
	assert.ok(failed.includes('Could not load the Conform log') && !failed.includes('not visible'));
	// worked out when the caller does not say: a log row that came back empty is forbidden, a log with no trace failed
	assert.ok(conformAppendix(CF_RUN, null, null).blocks.includes('not visible to you'));
	assert.ok(conformAppendix(CF_RUN, CF_LOG, null).blocks.includes('Could not load the Conform log'));
	assert.ok(conformAppendix(CF_RUN, CF_LOG, { time: [], cols: {} }).blocks.includes('Could not load the Conform log'), 'an empty CSV');
	// a trace in hand wins over nothing: no note at all
	const ok = conformAppendix(CF_RUN, CF_LOG, trace).blocks;
	assert.ok(!ok.includes('not visible') && !ok.includes('Could not load') && !ok.includes('too short'));
	// a log without any plottable channel says so rather than blaming the caller
	const series = [{ key: 'something_else', label: 'x', unit: '' }];
	const odd = conformAppendix(CF_RUN, { ...CF_LOG, series }, parseConformCsv(cfCsv(series), series)).blocks;
	assert.ok(odd.includes('none of the channels the plots use') && !odd.includes('not visible'));
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
	assert.ok(blocks.includes('Not measured: IPS, cooling. Energy excludes these.'), 'worded parts, not the raw keys');
	assert.ok(!/Not measured: ips/.test(blocks));
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
	assert.ok(out.body.includes('>Wheel speed<') && out.body.includes('Total energy'));
	assert.deepEqual([...out.body.matchAll(/data-rows="(\d+)"/g)].map((m) => m[1]), ['180', '180', '180', '180']);
	assert.deepEqual(h.assetCalls, [{ id: FILE_CF, accountability: user }]);
});

const FORBIDDEN_ASSET = Object.assign(new Error('You do not have permission to access this.'), { code: 'FORBIDDEN', status: 403 });

test('operation report: the log file read refused with 403 says "not visible to you"', async () => {
	const h = harness({ manufacturing_operations: true, conform_run_data: true, conform_logs: true }, undefined, FORBIDDEN_ASSET);
	const { out } = await get(h.routes, '/operation/:id', OP_CF, user);
	assert.equal(out.status, 200);
	assert.ok(out.body.includes('Conform log not visible to you'));
	assert.ok(!out.body.includes('Could not load the Conform log'));
	assert.ok(out.body.includes('Extruding time'));
	assert.equal(h.assetCalls.length, 1);
});

test('operation report: any other failure reading the log file says "Could not load the Conform log", not "not visible"', async () => {
	for (const err of [Object.assign(new Error('file gone'), { code: 'ENOENT' }), Object.assign(new Error('storage down'), { status: 500 })]) {
		const h = harness({ manufacturing_operations: true, conform_run_data: true, conform_logs: true }, undefined, err);
		const { out } = await get(h.routes, '/operation/:id', OP_CF, user);
		assert.equal(out.status, 200, 'the report is still produced');
		assert.ok(out.body.includes('Could not load the Conform log'), err.message);
		assert.ok(!out.body.includes('not visible to you'), err.message);
		assert.ok(out.body.includes('Extruding time'));
	}
});

test('operation report: a conform log the caller cannot read gives the placeholder, not an error', async () => {
	const h = conformHarness({ conform_logs: false });
	const { out } = await get(h.routes, '/operation/:id', OP_CF, user);
	assert.equal(out.status, 200);
	assert.ok(out.body.includes('Conform log not visible to you'));
	assert.ok(out.body.includes('Extruding time'));
	assert.equal(h.assetCalls.length, 0);
});

test('conformAppendix: no reading is an em dash with no unit (never "— rpm")', () => {
	const run = { ...CF_RUN, summary: { ...CF_RUN.summary, mean_wheel_speed_rpm: null, peak_motor_current_a: undefined, ips_setpoint_c: NaN, avg_demand_kw: null } };
	const sum = conformAppendix(run, null, null).blocks.split('class="tbl cf-sum"')[1].split('</table>')[0];
	assert.equal((sum.match(/>—</g) || []).length, 4);
	assert.ok(!/— (rpm|A|°C|kW)/.test(sum));
});

test('conformAppendix: an empty step list says why in words', () => {
	const { blocks } = conformAppendix({ ...CF_RUN, steps: [] }, null, null);
	assert.ok(blocks.includes('No step of a minute or more at one IPS setpoint and wheel speed in this window.'));
	assert.ok(!blocks.includes('No steps were found'));
});

test('conformAppendix: the run window line is "17 Mar 2025, 13:38:20 to 13:53:19 (UK time)"', () => {
	const run = { ...CF_RUN, window_start: '2025-03-17T13:38:20.000Z', window_end: '2025-03-17T13:53:19.000Z' };
	assert.ok(conformAppendix(run, null, null).blocks.includes('Run window 17 Mar 2025, 13:38:20 to 13:53:19 (UK time)'));
});

// ---- the plots: DESIGN 5b chart rules --------------------------------------------------------------------------------------

const panelSvgs = (blocks) => [...blocks.matchAll(/<svg [\s\S]*?<\/svg>/g)].map((m) => m[0]);
const tickTexts = (svg) => [...svg.matchAll(/<text [^>]*class="fp-tick"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test('niceTicks: steps of 1, 2, 2.5 or 5 x 10^n, 5 or 6 of them, and the top tick above the data on a y axis', () => {
	for (const [lo, hi] of [[0, 10], [3.2, 7.9], [20, 61.3], [398, 463], [0.0012, 0.0057], [-3, 8], [5, 7], [0, 1000], [30, 36.4], [200, 207]]) {
		const { ticks, step } = niceTicks(lo, hi, { cover: true });
		assert.ok(ticks.length >= 5 && ticks.length <= 6, `${lo}..${hi}: ${ticks.length} ticks`);
		assert.ok(ticks[0] <= lo + 1e-9 && ticks[ticks.length - 1] >= hi - 1e-9, `${lo}..${hi}: the ticks cover the data`);
		const m = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
		assert.ok([1, 2, 2.5, 5].some((k) => Math.abs(k - m) < 1e-9), `${lo}..${hi}: step ${step} is a nice one`);
	}
	assert.deepEqual(niceTicks(0, 10, { cover: true }).ticks, [0, 2, 4, 6, 8, 10]);
	assert.deepEqual(niceTicks(0, 7.9, { cover: true }).ticks, [0, 2, 4, 6, 8]);
	// a time axis never runs past its window: every tick is inside it
	const x = niceTicks(1.0, 4.0);
	assert.ok(x.ticks.every((v) => v >= 1 - 1e-9 && v <= 4 + 1e-9) && x.ticks.length >= 4 && x.ticks.length <= 7, x.ticks.join());
	const wide = niceTicks(1, 3.98);
	assert.deepEqual(wide.ticks, [1, 1.5, 2, 2.5, 3, 3.5]);
});

test('tickLabel: one number of decimals per axis, real minus signs', () => {
	assert.deepEqual([0, 0.5, 1, 1.5].map((v) => tickLabel(v, 0.5)), ['0.0', '0.5', '1.0', '1.5']);
	assert.deepEqual([0, 2.5, 5].map((v) => tickLabel(v, 2.5)), ['0.0', '2.5', '5.0']);
	assert.deepEqual([400, 420, 440].map((v) => tickLabel(v, 20)), ['400', '420', '440']);
	assert.equal(tickLabel(-5, 5), '−5');
	assert.equal(tickLabel(-0.0000000001, 1), '0');
});

test('conformAppendix: every plot has 5 to 6 ticks per axis, solid gridlines, outward ticks and axis titles with units', () => {
	const trace = parseConformCsv(cfCsv(), CF_SERIES);
	const svgs = panelSvgs(conformAppendix(CF_RUN, CF_LOG, trace).blocks);
	assert.equal(svgs.length, 4);
	for (const svg of svgs) {
		const labels = tickTexts(svg);
		assert.ok(labels.length >= 9 && labels.length <= 13, `ticks on both axes: ${labels.join(' ')}`);
		assert.ok(svg.includes('>Time since log start (min)<'), 'the x axis title has its unit');
		assert.ok(!/stroke-dasharray/.test(svg), 'gridlines are solid');
		assert.ok(svg.includes('stroke="#edf0f2"'), 'hairline gridlines');
		assert.ok(!svg.includes('preserveAspectRatio'));
	}
	// the y axis carries the unit of its series above the axis
	assert.deepEqual(svgs.map((svg) => (svg.match(/class="fp-axis">([^<]*)<\/text>/g) || []).map((t) => t.replace(/.*">|<\/text>/g, '')).filter((t) => t !== 'Time since log start (min)')), [['rpm'], ['%'], ['°C'], ['%']]);
	// elapsed minutes: the window is 1..4 min after the log start, so no clock times on the axis
	assert.ok(tickTexts(svgs[0]).includes('1.0') || tickTexts(svgs[0]).includes('1'), tickTexts(svgs[0]).join());
	assert.ok(!svgs[0].includes('13:0'));
});

test('conformAppendix: the plot areas sit two across, as the FAST appendix does (the CSS is in the datasheet <style>)', async () => {
	const h = conformHarness();
	const { out } = await get(h.routes, '/operation/:id', OP_CF, user);
	const html = out.body;
	assert.ok(html.includes('.cf-plots {'), 'the operation datasheet carries the Conform appendix CSS');
	const style = html.split('<style>')[1].split('</style>')[0];
	assert.ok(style.indexOf('.fast-plots {') < style.indexOf('.cf-plots {'), '.cf-plots follows .fast-plots');
	assert.match(style, /\.cf-plots \{[^}]*grid-template-columns:1fr 1fr/);
	for (const rule of ['.cf-window {', '.tbl {', '.cf-sum {', '.cf-sub {', '.cf-note {', '.fp-plot .fp-axis {']) assert.ok(style.includes(rule), rule);
	// the sample report is another template and does not carry them
	assert.ok(!renderSampleReport.toString().includes('.cf-plots'));
});

// ---- the mirrored figure table ---------------------------------------------------------------------------------------------

test('the mirrored figure table equals packages/fast-plotting/src/conform/format.ts (labels, units, kinds, the number rule)', () => {
	const ts = readFileSync(new URL('../../../../packages/fast-plotting/src/conform/format.ts', import.meta.url), 'utf8');
	const body = ts.split('export const CONFORM_FIGURES = {')[1].split('} as const')[0];
	const upstream = {};
	for (const m of body.matchAll(/^\s*(\w+): \{ label: '([^']*)', unit: ([^,]+), kind: '(\w+)' \},?$/gm)) {
		const unit = m[3] === 'KWH_UNIT' ? 'kWh' : m[3] === 'KW_UNIT' ? 'kW' : m[3].replace(/^'|'$/g, '');
		upstream[m[1]] = { label: m[2], unit, kind: m[4] };
	}
	assert.equal(Object.keys(upstream).length, 15, 'parsed every figure of format.ts');
	assert.deepEqual(CONFORM_FIGURES, upstream);
	assert.match(ts, /const digits = a >= 100 \? 0 : a >= 10 \? 1 : 2;/, 'niceNumber rule');
	assert.match(ts, /export const DASH = '—';/);
});

test('niceNumber / formatFigure: integers from 100, one decimal from 10, up to two below, no trailing zeros; a dash with no unit', () => {
	assert.deepEqual([402.4, 99.96, 45.25, 10, 8.04, 7.5, 0.5, 0.004, 0, -12.34].map(niceNumber), ['402', '100', '45.3', '10', '8.04', '7.5', '0.5', '0', '0', '-12.3']);
	assert.equal(niceNumber(null), null);
	assert.equal(niceNumber(NaN), null);
	assert.equal(formatFigure('mean_tooling1_c', 450.2), '450 °C');
	assert.equal(formatFigure('energy_total', 7.5), '7.50 kWh');
	assert.equal(formatFigure('avg_demand_kw', 30.7), '30.70 kW');
	assert.equal(formatFigure('duration_s', 725), '12 min 05 s');
	for (const key of Object.keys(CONFORM_FIGURES)) {
		assert.equal(formatFigure(key, null), DASH, key);
		assert.equal(figureNumber(key, undefined), null, key);
	}
});
