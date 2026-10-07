// Run with: npm test   (node --test; needs `npm ci` for qrcode / the SDK)
//
// Unit tests for the label maths and request validation (label.js), plus endpoint tests
// with a fake Directus proving the label routes read through the CALLER's accountability.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import endpoint from './index.js';
import {
	LAYOUTS,
	MAX_LABELS,
	codeFontPt,
	initials,
	labelDate,
	orderRows,
	paginate,
	parseSelection,
	parseStart,
	renderLabelSheet,
	resolveLayout,
	sampleRecordUrl,
	slotPosition,
} from './label.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---- validation -------------------------------------------------------------------------

test('parseSelection: accepts comma / space separated and repeated ids, lower-cases and de-duplicates', () => {
	const a = uuid(1);
	const b = uuid(2).toUpperCase();
	assert.deepEqual(parseSelection({ ids: `${a}, ${b}\n${a}` }), { ids: [a, uuid(2)], codes: [] });
	assert.deepEqual(parseSelection({ ids: [a, uuid(2)] }).ids, [a, uuid(2)]);
	assert.deepEqual(parseSelection({ codes: '10-AA-MF-2023-06-03; S-2' }), { ids: [], codes: ['10-AA-MF-2023-06-03', 'S-2'] });
});

test('parseSelection: rejects empty, malformed, injected and non-text input', () => {
	for (const q of [
		{},
		{ ids: '' },
		{ ids: 'not-a-uuid' },
		{ ids: `${uuid(1)},drop table` },
		{ ids: `${uuid(1)}' OR '1'='1` },
		{ ids: { $ne: 'x' } },
		{ ids: [{ a: 1 }] },
		{ codes: '../etc/passwd' },
		{ codes: '<script>' },
		{ codes: 'x'.repeat(65) },
	]) {
		assert.ok(parseSelection(q).error, JSON.stringify(q));
	}
});

test('parseSelection: caps the number of distinct samples at MAX_LABELS', () => {
	const ids = (n) => Array.from({ length: n }, (_, i) => uuid(i + 1));
	assert.equal(parseSelection({ ids: ids(MAX_LABELS).join(',') }).ids.length, MAX_LABELS);
	assert.match(parseSelection({ ids: ids(MAX_LABELS + 1).join(',') }).error, /At most 200/);
	// a code may name a sample that is already in ids, so ids + codes are not capped together here
	assert.deepEqual(parseSelection({ ids: ids(MAX_LABELS).join(','), codes: 'A-1' }).codes, ['A-1']);
	assert.ok(parseSelection({ codes: Array.from({ length: MAX_LABELS + 1 }, (_, i) => `C-${i}`).join(',') }).error);
	// duplicates do not count twice
	assert.equal(parseSelection({ ids: Array(MAX_LABELS * 2).fill(uuid(1)) }).ids.length, 1);
});

test('resolveLayout: defaults to a4-21, knows both layouts, rejects the rest (incl. prototype keys)', () => {
	assert.equal(resolveLayout(undefined).key, 'a4-21');
	assert.equal(resolveLayout('single-50x25').key, 'single-50x25');
	for (const bad of ['a4', 'constructor', '__proto__', 'toString']) assert.equal(resolveLayout(bad), null);
});

test('parseStart: 1-based, bounded by the sheet; ignored for single labels', () => {
	const a4 = LAYOUTS['a4-21'];
	assert.deepEqual(parseStart(undefined, a4), { skip: 0 });
	assert.deepEqual(parseStart('1', a4), { skip: 0 });
	assert.deepEqual(parseStart('21', a4), { skip: 20 });
	for (const bad of ['0', '22', '-1', '2.5', 'x', '1e1']) assert.ok(parseStart(bad, a4).error, bad);
	assert.deepEqual(parseStart('7', LAYOUTS['single-50x25']), { skip: 0 });
});

// ---- layout maths -----------------------------------------------------------------------

test('a4-21 is the standard 3 x 7 grid of 63.5 x 38.1 mm labels, centred on A4', () => {
	const l = LAYOUTS['a4-21'];
	assert.equal(l.perPage, 21);
	assert.equal(l.marginLeft, 7.21);
	assert.equal(l.marginTop, 15.15);
	assert.equal(l.pitchX, 66.04);
	assert.equal(l.pitchY, 38.1);
	// last label ends inside the page on both axes
	const last = slotPosition(l, 20);
	assert.ok(last.x + l.labelW <= l.pageW && last.y + l.labelH <= l.pageH);
	assert.deepEqual(slotPosition(l, 0), { x: 7.21, y: 15.15 });
	assert.deepEqual(slotPosition(l, 3), { x: 7.21, y: 53.25 }); // first label of row 2
	assert.deepEqual(slotPosition(l, 1), { x: 73.25, y: 15.15 });
});

test('paginate: fills row by row, spills to a new page, honours a part-used first sheet', () => {
	const l = LAYOUTS['a4-21'];
	const p = paginate(23, l);
	assert.deepEqual(p.map((s) => s.length), [21, 2]);
	assert.equal(p[1][0].slot, 0);
	assert.equal(p[1][0].index, 21);

	const skipped = paginate(3, l, 19); // positions 20, 21 on page 1, then 1 on page 2
	assert.deepEqual(skipped.map((s) => s.map((x) => x.slot)), [[19, 20], [0]]);
	assert.deepEqual(skipped.flat().map((x) => x.index), [0, 1, 2]);

	assert.deepEqual(paginate(0, l), []);
	assert.equal(paginate(5, LAYOUTS['single-50x25']).length, 5); // one page per label
});

test('codeFontPt: shrinks long codes to fit, never beyond the cap or floor', () => {
	assert.equal(codeFontPt('S-1', 58.5, 14), 14);
	const long = codeFontPt('10-AA-MF-2023-06-03', 40, 14);
	assert.ok(long < 14 && long > 7);
	// the line really fits: 19 glyphs * 0.62 em * (pt * 0.3528 mm) <= width
	assert.ok(19 * 0.62 * long * 0.3528 <= 40 + 0.01);
	assert.equal(codeFontPt('x'.repeat(200), 20, 14), 7);
	assert.equal(codeFontPt('', 20, 14), 14);
});

test('labelDate: a timestamp falls on its day in D1_TIMEZONE (default Europe/London), not UTC', () => {
	const old = process.env.D1_TIMEZONE;
	try {
		delete process.env.D1_TIMEZONE;
		// 23:30 UTC on 4 Oct is 00:30 BST on 5 Oct; the process itself runs in UTC here.
		assert.equal(labelDate(null, '2026-10-04T23:30:00Z'), '2026-10-05');
		assert.equal(labelDate(null, new Date('2026-10-04T23:30:00Z')), '2026-10-05');
		// UTC midnight is 01:00 BST: same day. In winter (GMT) 00:30 UTC is still that day.
		assert.equal(labelDate(null, '2026-10-05T00:00:00Z'), '2026-10-05');
		assert.equal(labelDate(null, '2026-01-05T00:30:00Z'), '2026-01-05');
		process.env.D1_TIMEZONE = 'Pacific/Auckland'; // UTC+13 in October
		assert.equal(labelDate(null, '2026-10-04T12:30:00Z'), '2026-10-05');
		process.env.D1_TIMEZONE = 'America/New_York';
		assert.equal(labelDate(null, '2026-10-05T01:00:00Z'), '2026-10-04');
		process.env.D1_TIMEZONE = 'Not/AZone'; // a typo must not break printing: back to the default
		assert.equal(labelDate(null, '2026-10-04T23:30:00Z'), '2026-10-05');
	} finally {
		if (old === undefined) delete process.env.D1_TIMEZONE;
		else process.env.D1_TIMEZONE = old;
	}
});

test('initials and labelDate', () => {
	assert.equal(initials('Ada Lovelace'), 'AL');
	assert.equal(initials('  ada  king  lovelace '), 'AL');
	assert.equal(initials('Prince'), 'P');
	assert.equal(initials(null), '');
	assert.equal(labelDate('2026-03-04', '2020-01-01T00:00:00Z'), '2026-03-04');
	assert.equal(labelDate(null, '2020-01-02T12:00:00Z'), '2020-01-02'); // midday UTC: same day in most zones
	assert.equal(labelDate(null, null), '');
	assert.equal(labelDate(null, 'garbage'), '');
});

test('orderRows: requested order, ids then codes, one label per sample', () => {
	const rows = [
		{ sample_id: uuid(1), sample_code: 'A' },
		{ sample_id: uuid(2), sample_code: 'B' },
		{ sample_id: uuid(3), sample_code: 'C' },
	];
	const out = orderRows(rows, { ids: [uuid(3), uuid(1)], codes: ['B', 'C', 'ZZ'] });
	assert.deepEqual(out.map((r) => r.sample_code), ['C', 'A', 'B']);
});

test('sampleRecordUrl: the QR opens the app record (sign-in required), never a public route', () => {
	assert.equal(
		sampleRecordUrl('https://lims.example.org/', uuid(1)),
		`https://lims.example.org/admin/home/samples/${uuid(1)}`
	);
	assert.equal(sampleRecordUrl('https://lims.example.org', 'a/b'), 'https://lims.example.org/admin/home/samples/a%2Fb');
	assert.ok(!/d1-report|\/items\//.test(sampleRecordUrl('https://x', uuid(1))));
});

test('label: the QR encodes the record URL, not the report route', async () => {
	const { default: QRCode } = await import('qrcode');
	const { routes } = harness({ physical_samples: true });
	const out = await get(routes, '/label', { ids: S2, layout: 'a4-21' }, user);
	const expected = await QRCode.toString(sampleRecordUrl('https://lims.example.org/', S2), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
	assert.ok(out.body.includes(expected));
	const other = await QRCode.toString(`https://lims.example.org/d1-report/sample/${S2}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
	assert.ok(!out.body.includes(other));
});

test('renderLabelSheet: one sheet per page, escapes text, sets the page size', () => {
	const labels = Array.from({ length: 22 }, (_, i) => ({
		code: i === 0 ? '<b>X</b>' : `S-${i}`,
		material: 'Ti-6Al-4V',
		date: '2026-01-02',
		owner: 'AL',
		qrSvg: '<svg></svg>',
	}));
	const html = renderLabelSheet({ labels, layoutKey: 'a4-21', skip: 0, query: { ids: uuid(1) } });
	assert.equal((html.match(/class="sheet"/g) || []).length, 2);
	assert.equal((html.match(/class="label"/g) || []).length, 22);
	assert.ok(html.includes('@page{size:210mm 297mm;margin:0}'));
	assert.ok(html.includes('&lt;b&gt;X&lt;/b&gt;'));
	assert.ok(!html.includes('<b>X</b>'));
	assert.ok(html.includes(`name="ids" value="${uuid(1)}"`));
	const single = renderLabelSheet({ labels: labels.slice(0, 2), layoutKey: 'single-50x25' });
	assert.ok(single.includes('@page{size:50mm 25mm;margin:0}'));
	assert.ok(!single.includes('name="start"'));
});

// ---- endpoints --------------------------------------------------------------------------

const S1 = uuid(1);
const S2 = uuid(2);
const DATA = {
	physical_samples: [
		{ sample_id: S1, sample_code: '10-AA-MF-2023-06-03', material_id: 'm1', owner_person_id: 'p1', manufactured_date: '2026-03-04', created_at: '2026-03-05T00:00:00Z' },
		{ sample_id: S2, sample_code: 'S-2', material_id: null, owner_person_id: null, manufactured_date: null, created_at: '2026-04-01T00:00:00Z' },
	],
	materials: [{ material_id: 'm1', alloy_code: 'AA', common_name: 'Ti-6Al-4V' }],
	people: [{ person_id: 'p1', full_name: 'Ada Lovelace' }],
};
const forbidden = () => Object.assign(new Error('no'), { code: 'FORBIDDEN', status: 403 });

function harness(allowed) {
	const constructed = [];
	const queries = [];
	class ItemsService {
		constructor(collection, opts) {
			this.collection = collection;
			constructed.push({ collection, opts });
		}
		async readByQuery(q) {
			const rule = allowed[this.collection];
			if (!rule) throw forbidden();
			queries.push({ collection: this.collection, ...q });
			const count = q.aggregate?.count;
			const match = (r, f) =>
				Object.entries(f || {}).every(([k, c]) => {
					if (k === '_or') return c.some((x) => match(r, x));
					if (c._in) return c._in.map(String).includes(String(r[k]));
					if (c._icontains !== undefined) return String(r[k]).toLowerCase().includes(String(c._icontains).toLowerCase());
					return true;
				});
			const rows = (DATA[this.collection] || []).filter((r) => (rule === true || rule(r)) && match(r, q.filter));
			if (count) return [{ count: String(rows.length) }];
			return q.limit > 0 ? rows.slice(0, q.limit) : rows;
		}
	}
	const routes = {};
	endpoint.handler(
		{ get: (p, fn) => (routes[p] = fn) },
		{
			database: () => {
				throw new Error('labels must not use the root database handle');
			},
			env: { PUBLIC_URL: 'https://lims.example.org/' },
			logger: { error: () => {} },
			services: { ItemsService },
			getSchema: async () => ({ collections: {} }),
		}
	);
	return { routes, constructed, queries };
}

async function get(routes, route, query, accountability) {
	const out = { status: 200, headers: {}, body: '' };
	const res = {
		status(c) {
			out.status = c;
			return res;
		},
		set(k, v) {
			out.headers[k] = v;
			return res;
		},
		type(t) {
			out.headers['Content-Type'] = t.includes('/') ? `${t}; charset=utf-8` : t;
			return res;
		},
		send(b) {
			out.body = b;
			return res;
		},
	};
	await routes[route]({ query, accountability, schema: { collections: { marker: true } } }, res);
	return out;
}

const user = { user: 'u1', role: 'r1' };

test('label routes: unauthenticated is 401', async () => {
	const { routes } = harness({ physical_samples: true });
	for (const [r, q] of [['/label', { ids: S1 }], ['/labels', {}]]) {
		assert.equal((await get(routes, r, q, {})).status, 401);
		assert.equal((await get(routes, r, q, undefined)).status, 401);
	}
});

test('label: bad input is 400 and nothing is read', async () => {
	const { routes, queries } = harness({ physical_samples: true });
	assert.equal((await get(routes, '/label', {}, user)).status, 400);
	assert.equal((await get(routes, '/label', { ids: 'nope' }, user)).status, 400);
	assert.equal((await get(routes, '/label', { ids: S1, layout: 'huge' }, user)).status, 400);
	assert.equal((await get(routes, '/label', { ids: S1, start: '99' }, user)).status, 400);
	assert.equal(queries.length, 0);
});

test('parseSelection: a rejected token is not echoed back as markup', () => {
	const evil = '<a/href=//evil.example>Session_expired</a>';
	for (const q of [{ ids: evil }, { codes: evil }, { ids: `${uuid(1)},"><img src=x onerror=alert(1)>` }]) {
		const { error } = parseSelection(q);
		assert.ok(error, JSON.stringify(q));
		assert.ok(!/[<>"']/.test(error), error);
	}
});

test('label routes: every error response is text/plain, never HTML', async () => {
	const { routes } = harness({ physical_samples: true });
	const evil = '<a/href=//evil.example>Session_expired</a>';
	const cases = [
		['/label', { ids: evil }, user, 400],
		['/label', { codes: evil }, user, 400],
		['/label', { ids: S1, layout: evil }, user, 400],
		['/label', { ids: S1, start: evil }, user, 400],
		['/label', { ids: uuid(9) }, user, 404],
		['/label', { ids: S1 }, undefined, 401],
		['/labels', {}, undefined, 401],
	];
	for (const [r, q, acc, status] of cases) {
		const out = await get(routes, r, q, acc);
		assert.equal(out.status, status, r + JSON.stringify(q));
		assert.match(out.headers['Content-Type'], /^text\/plain/, r + JSON.stringify(q));
		assert.ok(!out.body.includes('<a/href'), out.body);
	}
});

test('label: 200 ticked samples plus one code already among them is accepted; 201 distinct are refused', async () => {
	const base = DATA.physical_samples.length;
	try {
		for (let i = 0; i < 205; i++) {
			DATA.physical_samples.push({ sample_id: uuid(1000 + i), sample_code: `BULK-${i}`, created_at: '2026-03-05T12:00:00Z' });
		}
		const { routes } = harness({ physical_samples: true });
		const ticked = (n) => Array.from({ length: n }, (_, i) => uuid(1000 + i)).join(',');
		const ok = await get(routes, '/label', { ids: ticked(MAX_LABELS), codes: 'BULK-0' }, user);
		assert.equal(ok.status, 200);
		assert.equal((ok.body.match(/class="label"/g) || []).length, MAX_LABELS);
		const tooMany = await get(routes, '/label', { ids: ticked(MAX_LABELS), codes: 'BULK-200' }, user);
		assert.equal(tooMany.status, 400);
		assert.match(tooMany.body, /At most 200/);
	} finally {
		DATA.physical_samples.length = base;
	}
});

test('label: renders code, QR to the admin record URL, material, date and owner initials', async () => {
	const { routes, constructed } = harness({ physical_samples: true, materials: true, people: true });
	const out = await get(routes, '/label', { ids: S1, codes: 'S-2' }, user);
	assert.equal(out.status, 200);
	assert.match(out.headers['Content-Type'], /text\/html/);
	assert.ok(out.headers['Content-Security-Policy']);
	assert.ok(out.body.includes('10-AA-MF-2023-06-03'));
	assert.ok(out.body.includes('Ti-6Al-4V'));
	assert.ok(out.body.includes('2026-03-04'));
	assert.ok(out.body.includes('Owner</span> AL'));
	assert.ok(out.body.includes('<svg'));
	assert.equal((out.body.match(/class="label"/g) || []).length, 2);
	// every read is made with the caller's accountability
	assert.ok(constructed.length > 0);
	for (const c of constructed) assert.equal(c.opts.accountability, user);
});

test('label: respects permissions (no material / owner without read access; unreadable samples look missing)', async () => {
	const noExtras = harness({ physical_samples: true });
	const out = await get(noExtras.routes, '/label', { ids: S1 }, user);
	assert.equal(out.status, 200);
	assert.ok(!out.body.includes('Ti-6Al-4V'));
	assert.ok(!out.body.includes('Owner</span>'));

	const denied = harness({});
	const missing = harness({ physical_samples: true });
	const a = await get(denied.routes, '/label', { ids: S1 }, user);
	const b = await get(missing.routes, '/label', { ids: uuid(9) }, user);
	assert.equal(a.status, 404);
	assert.equal(a.body, b.body);

	// row-level restriction: only S2 readable -> S1 gets no label, with a notice
	const some = harness({ physical_samples: (r) => r.sample_id === S2 });
	const partial = await get(some.routes, '/label', { ids: `${S1},${S2}` }, user);
	assert.equal((partial.body.match(/class="label"/g) || []).length, 1);
	assert.ok(!partial.body.includes('10-AA-MF-2023-06-03'));
	assert.ok(partial.body.includes('not found or you may not read'));
});

test('labels picker: shows the total when more samples exist than the page lists', async () => {
	const base = DATA.physical_samples.length;
	try {
		for (let i = 0; i < 205; i++) DATA.physical_samples.push({ sample_id: uuid(2000 + i), sample_code: `BULK-${i}`, created_at: '2026-03-05T12:00:00Z' });
		const { routes } = harness({ physical_samples: true });
		const out = await get(routes, '/labels', {}, user);
		assert.ok(out.body.includes(`(${MAX_LABELS} of ${base + 205}, newest first)`), out.body.match(/\(\d+[^)]*\)/)?.[0]);
		// a short list shows no "of N"
		const small = await get(routes, '/labels', { q: 's-2' }, user);
		assert.ok(!/of \d+, newest/.test(small.body));
	} finally {
		DATA.physical_samples.length = base;
	}
});

test('labels picker: lists readable samples through the caller, filters by search', async () => {
	const { routes, constructed } = harness({ physical_samples: true });
	const all = await get(routes, '/labels', {}, user);
	assert.equal(all.status, 200);
	assert.ok(all.body.includes(S1) && all.body.includes(S2));
	const some = await get(routes, '/labels', { q: 's-2' }, user);
	assert.ok(some.body.includes(S2) && !some.body.includes(S1));
	for (const c of constructed) assert.equal(c.opts.accountability, user);
});
