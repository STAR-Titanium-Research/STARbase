// Run with: node --test core/extensions/d1-trace/index.test.mjs
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import ext from './index.js';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ROOT = id(1);
const PARENT = id(2);
const GRAND = id(3);
const CHILD = id(4);
const OP1 = id(101);
const OP2 = id(102);
const TS1 = id(201);
const LOT1 = id(301);

const PK = {
    physical_samples: 'sample_id',
    manufacturing_operations: 'operation_id',
    test_sessions: 'session_id',
    raw_stock_lots: 'lot_id',
};

// The tables behind the fake ItemsService, with columns the endpoint must never pass on.
const baseTables = () => ({
    physical_samples: [
        { sample_id: ROOT, sample_code: '9-AA-1', form: 'bar', nickname: 'Nick' },
        { sample_id: PARENT, sample_code: '9-AA-0', form: 'bar', nickname: 'Nick' },
        { sample_id: GRAND, sample_code: '9-A-0', form: 'rod', nickname: 'Nick' },
        { sample_id: CHILD, sample_code: '9-AA-2', form: 'coupon', nickname: 'Nick' },
    ],
    manufacturing_operations: [
        { operation_id: OP1, pass_code: 'P1', operation_sequence: 1, operation_date: '2026-01-02T00:00:00.000Z', operator_name: 'Secret Name' },
        { operation_id: OP2, pass_code: 'P2', operation_sequence: 2, operation_date: null, operator_name: 'Secret Name' },
    ],
    test_sessions: [
        { session_id: TS1, test_type: 'tensile', status: 'processed', session_date: '2026-01-03T00:00:00.000Z', file_storage_pointer: 's3://x' },
    ],
    raw_stock_lots: [{ lot_id: LOT1, lot_code: 'LOT-1', stock_type: 'rod', supplier_name: 'Acme' }],
    sample_genealogy: [
        { child_sample_id: ROOT, parent_sample_id: PARENT, relationship_type: 'cut_from', fraction: '0.5', notes: 'n' },
        { child_sample_id: PARENT, parent_sample_id: GRAND, relationship_type: 'cut_from', fraction: null, notes: 'n' },
        { child_sample_id: CHILD, parent_sample_id: ROOT, relationship_type: 'cut_from', fraction: null, notes: 'n' },
    ],
    sample_stock_provenance: [{ sample_id: GRAND, lot_id: LOT1, mass_used_grams: '120.5', notes: 'n' }],
});

// What the (permission-ignoring) SQL functions return: one row per reachable sample, with one
// shortest path.
const row = (depth, sample_id, ...path) => ({ depth, sample_id, path });
const baseFn = () => ({
    f_trace_ancestors: [row(0, ROOT, ROOT), row(1, PARENT, ROOT, PARENT), row(2, GRAND, ROOT, PARENT, GRAND)],
    f_trace_descendants: [row(0, ROOT, ROOT), row(1, CHILD, ROOT, CHILD)],
    f_trace_stock_origins: [{ via_sample_id: GRAND, depth: 2, lot_id: LOT1 }],
    f_sample_timeline: [
        { event_date: new Date('2026-01-02T00:00:00Z'), event_type: 'manufacturing_operation', event_id: OP1 },
        { event_date: new Date('2026-01-03T00:00:00Z'), event_type: 'test_session', event_id: TS1 },
        { event_date: null, event_type: 'manufacturing_operation', event_id: OP2 },
    ],
});

// The fake database applies the same grouping the endpoint's SQL does (one row per sample with its
// depth and every reached node it is linked to by a genealogy edge, rebuilt from the table; one row
// per lot and ancestor; newest-N events, oldest first), so the JS is tested against realistic input.
// The SQL text itself is exercised against Postgres by hand (see the physical-test backlog).
function emulate(fn, rows, root, genealogy = []) {
    if (fn === 'f_trace_ancestors' || fn === 'f_trace_descendants') {
        const up = fn === 'f_trace_ancestors';
        const depthOf = new Map(rows.map((r) => [r.sample_id, r.depth]));
        const out = rows
            .filter((r) => r.sample_id !== root)
            .map((r) => ({
                sample_id: r.sample_id,
                depth: r.depth,
                // shallowest first, then by id, as the SQL's array_agg ORDER BY p.depth, id
                prev: genealogy
                    .filter((e) => (up ? e.parent_sample_id : e.child_sample_id) === r.sample_id)
                    .map((e) => (up ? e.child_sample_id : e.parent_sample_id))
                    .filter((x) => depthOf.has(x))
                    .sort((x, y) => depthOf.get(x) - depthOf.get(y) || (x < y ? -1 : 1)),
            }));
        return out.sort((a, b) => a.depth - b.depth || (a.sample_id < b.sample_id ? -1 : 1)).slice(0, 501);
    }
    if (fn === 'f_trace_stock_origins') {
        const by = new Map();
        for (const r of rows) {
            const k = `${r.via_sample_id}|${r.lot_id}`;
            const g = by.get(k);
            if (!g || r.depth < g.depth) by.set(k, { via_sample_id: r.via_sample_id, lot_id: r.lot_id, depth: r.depth });
        }
        return [...by.values()].sort((a, b) => a.depth - b.depth).slice(0, 501);
    }
    const t = (e) => (e.event_date ? e.event_date.getTime() : null);
    const newest = [...rows]
        .sort((a, b) => (t(a) === null) - (t(b) === null) || (t(b) ?? 0) - (t(a) ?? 0))
        .slice(0, 501);
    return newest.sort((a, b) => (t(a) === null) - (t(b) === null) || (t(a) ?? 0) - (t(b) ?? 0));
}

const match = (r, f) =>
    Object.entries(f).every(([k, v]) => {
        if (k === '_and') return v.every((x) => match(r, x));
        if (k === '_or') return v.some((x) => match(r, x));
        if ('_in' in v) return v._in.includes(r[k]);
        if ('_eq' in v) return r[k] === v._eq;
        throw new Error(`fake ItemsService: unsupported filter ${k}`);
    });

// `readable` = ids the caller may read in the keyed collections; `strip` = fields a role may not
// read, per collection. Like Directus, fields ['*'] returns only readable fields and an explicit
// list naming a restricted field is refused with FORBIDDEN.
function mount({
    readable,
    denyCollections = [],
    strip = {},
    tables = baseTables(),
    fn = baseFn(),
    dbError = null,
    root = ROOT,
    onQuery = null,
} = {}) {
    const reads = [];
    const sqls = [];
    class ItemsService {
        constructor(collection, opts) {
            this.collection = collection;
            this.opts = opts;
        }
        async readByQuery(query) {
            reads.push({ collection: this.collection, opts: this.opts, query });
            const forbidden = () => Object.assign(new Error('no'), { code: 'FORBIDDEN' });
            if (denyCollections.includes(this.collection)) throw forbidden();
            const hide = strip[this.collection] ?? [];
            if (!query.fields.includes('*') && query.fields.some((f) => hide.includes(f))) throw forbidden();
            const pk = PK[this.collection];
            return (tables[this.collection] ?? [])
                .filter((r) => (pk ? readable.has(r[pk]) : true) && match(r, query.filter))
                .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !hide.includes(k))));
        }
    }
    const raw = async (sql, bindings = []) => {
        sqls.push(sql);
        if (dbError) throw dbError;
        const m = /FROM (f_\w+)\(/.exec(sql);
        if (m) onQuery?.(m[1]);
        if (!m) return { rows: [] };
        return { rows: emulate(m[1], fn[m[1]], bindings[0] ?? root, tables.sample_genealogy) };
    };
    const database = { raw, transaction: async (work) => work({ raw }) };
    let handler;
    const router = { get: (_p, h) => (handler = h) };
    ext.handler(router, {
        database,
        logger: { error: () => {}, warn: () => {} },
        services: { ItemsService },
        getSchema: async () => ({ fake: true }),
    });
    return { handler, reads, sqls };
}

function call(handler, accountability, sampleId = ROOT) {
    return new Promise((resolve) => {
        const out = { status: 200, body: undefined };
        const res = {
            status(code) {
                out.status = code;
                return res;
            },
            json(b) {
                out.body = b;
                resolve(out);
                return res;
            },
        };
        handler({ accountability, params: { id: sampleId } }, res);
    });
}

const user = { user: 'u', app: true, role: 'r' };
const all = new Set([ROOT, PARENT, GRAND, CHILD, OP1, OP2, TS1, LOT1]);

test('refuses anonymous callers (401) and users without app access (403)', async () => {
    const { handler } = mount({ readable: all });
    assert.equal((await call(handler, null)).status, 401);
    assert.equal((await call(handler, {})).status, 401);
    assert.equal((await call(handler, { user: 'u', app: false, admin: false })).status, 403);
});

test('errors are Directus-shaped ({ errors: [{ message }] }) so the UI can show their text', async () => {
    const { handler } = mount({ readable: new Set([PARENT]) });
    for (const [r, status] of [
        [await call(handler, null), 401],
        [await call(handler, { user: 'u', app: false }), 403],
        [await call(handler, user, 'nope'), 400],
        [await call(handler, user), 404],
    ]) {
        assert.equal(r.status, status);
        assert.equal(typeof r.body.errors[0].message, 'string');
        assert.ok(r.body.errors[0].message.length > 0);
        assert.equal(typeof r.body.errors[0].extensions.code, 'string');
        assert.equal(r.body.error, undefined);
    }
});

test('rejects an id that is not a uuid before touching the database', async () => {
    const { handler, reads, sqls } = mount({ readable: all });
    assert.equal((await call(handler, user, "x'; drop table physical_samples")).status, 400);
    assert.equal((await call(handler, user, null)).status, 400);
    assert.equal(reads.length, 0);
    assert.equal(sqls.length, 0);
});

test('a sample the caller cannot read is 404, same as a missing one, and nothing else is read', async () => {
    const { handler, reads, sqls } = mount({ readable: new Set([PARENT]) });
    const r = await call(handler, user);
    assert.equal(r.status, 404);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].collection, 'physical_samples');
    assert.equal(sqls.length, 0);
});

test('a fully readable sample returns the whole story, in order, and reads with the caller accountability', async () => {
    const { handler, reads } = mount({ readable: all });
    const r = await call(handler, user);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.deepEqual(b.sample, { sample_id: ROOT, sample_code: '9-AA-1', form: 'bar' });
    assert.deepEqual(
        b.ancestors.map((a) => [a.sample_code, a.depth, a.through_hidden, a.relationship_type, a.fraction]),
        [
            ['9-AA-0', 1, false, 'cut_from', 0.5],
            ['9-A-0', 2, false, 'cut_from', null],
        ],
    );
    assert.deepEqual(
        b.descendants.map((d) => [d.sample_code, d.relationship_type]),
        [['9-AA-2', 'cut_from']],
    );
    assert.deepEqual(b.stock_origins, [
        {
            lot_id: LOT1,
            lot_code: 'LOT-1',
            stock_type: 'rod',
            supplier_name: 'Acme',
            mass_used_grams: 120.5,
            via_sample_id: GRAND,
            via_sample_code: '9-A-0',
            depth: 2,
            through_hidden: false,
        },
    ]);
    assert.deepEqual(
        b.events.map((e) => [e.collection, e.id, e.label]),
        [
            ['manufacturing_operations', OP1, 'P1'],
            ['test_sessions', TS1, 'tensile'],
            ['manufacturing_operations', OP2, 'P2'],
        ],
    );
    assert.equal(b.events[0].date, '2026-01-02T00:00:00.000Z');
    assert.equal(b.events[0].sequence, 1);
    assert.equal(b.events[2].date, null);
    assert.equal(b.events[1].status, 'processed');
    assert.deepEqual(b.hidden, { stock_origins: 0, ancestors: 0, events: 0, descendants: 0 });
    for (const rd of reads) assert.equal(rd.opts.accountability, user);
});

test('never passes on operator names, file pointers, nicknames or paths', async () => {
    const { handler } = mount({ readable: all });
    const text = JSON.stringify((await call(handler, user)).body);
    for (const secret of ['Secret Name', 's3://x', 'Nick', '"path"', '"prev"']) assert.ok(!text.includes(secret), secret);
});

test('unreadable records are dropped and only counted; their codes do not appear', async () => {
    // Role cannot read the parent, the child, one operation, the test session and the lot.
    const { handler } = mount({ readable: new Set([ROOT, GRAND, OP1, OP2]) });
    const r = await call(handler, user);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.deepEqual(b.ancestors.map((a) => a.sample_id), [GRAND]);
    assert.equal(b.ancestors[0].through_hidden, true); // reached through the unreadable parent
    // the edge into a through-hidden row would describe the hidden parent: not passed on
    assert.equal(b.ancestors[0].relationship_type, null);
    assert.equal(b.ancestors[0].fraction, null);
    assert.deepEqual(b.descendants, []);
    assert.deepEqual(b.stock_origins, []);
    assert.deepEqual(b.events.map((e) => e.id), [OP1, OP2]);
    assert.deepEqual(b.hidden, { stock_origins: 1, ancestors: 1, events: 1, descendants: 1 });
    const text = JSON.stringify(b);
    for (const secret of ['9-AA-0', '9-AA-2', 'LOT-1', 'tensile', PARENT, CHILD, TS1, LOT1]) {
        assert.ok(!text.includes(secret), `${secret} leaked`);
    }
});

test('a stock origin that came via an unreadable sample hides that sample code', async () => {
    const { handler } = mount({ readable: new Set([ROOT, LOT1]) });
    const b = (await call(handler, user)).body;
    assert.equal(b.stock_origins.length, 1);
    assert.equal(b.stock_origins[0].via_sample_code, null);
    assert.equal(b.stock_origins[0].through_hidden, true);
});

test('a stock lot reached through a hidden ancestor is marked, one reached through readable ancestors is not', async () => {
    // GRAND and the lot are readable but PARENT (between the sample and GRAND) is not.
    const hiddenMiddle = mount({ readable: new Set([ROOT, GRAND, LOT1]) });
    const a = (await call(hiddenMiddle.handler, user)).body;
    assert.equal(a.stock_origins[0].via_sample_code, '9-A-0');
    assert.equal(a.stock_origins[0].through_hidden, true);
    const open = mount({ readable: all });
    assert.equal((await call(open.handler, user)).body.stock_origins[0].through_hidden, false);
});

test('a collection the role has no access to at all reads as all hidden, not an error', async () => {
    const { handler } = mount({ readable: all, denyCollections: ['test_sessions', 'raw_stock_lots'] });
    const r = await call(handler, user);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.events.map((e) => e.id), [OP1, OP2]);
    assert.equal(r.body.hidden.events, 1);
    assert.equal(r.body.hidden.stock_origins, 1);
});

test('a sample with no genealogy or events returns empty lists', async () => {
    const fn = {
        f_trace_ancestors: [row(0, ROOT, ROOT)],
        f_trace_descendants: [row(0, ROOT, ROOT)],
        f_trace_stock_origins: [],
        f_sample_timeline: [],
    };
    const { handler } = mount({ readable: all, fn });
    const b = (await call(handler, user)).body;
    assert.deepEqual([b.ancestors, b.descendants, b.stock_origins, b.events], [[], [], [], []]);
});

test('a database failure is a 500 with no partial data', async () => {
    const { handler } = mount({ readable: all, dbError: new Error('boom') });
    const r = await call(handler, user);
    assert.equal(r.status, 500);
    assert.equal(r.body.ancestors, undefined);
    assert.equal(r.body.errors[0].message, 'could not read the sample timeline');
});

test('admins are allowed even without the app flag', async () => {
    const { handler } = mount({ readable: all });
    assert.equal((await call(handler, { user: 'u', admin: true })).status, 200);
});

// ---- diamonds: the SQL functions return one row per sample, with one shortest path ----

const A = id(11);
const B = id(12);
const C = id(13);
const D = id(14);
const diamondTables = () => ({
    ...baseTables(),
    physical_samples: [A, B, C, D].map((sid, i) => ({ sample_id: sid, sample_code: `D-${'ABCD'[i]}`, form: 'bar' })),
    sample_genealogy: [
        { child_sample_id: B, parent_sample_id: A, relationship_type: 'cut_from', fraction: '0.5' },
        { child_sample_id: C, parent_sample_id: A, relationship_type: 'derived_from', fraction: null },
        { child_sample_id: D, parent_sample_id: B, relationship_type: 'cut_from', fraction: null },
        { child_sample_id: D, parent_sample_id: C, relationship_type: 'sintered_from', fraction: null },
    ],
    sample_stock_provenance: [],
    raw_stock_lots: [],
});
// A -> B, A -> C, B -> D, C -> D, as the functions list them: the far end appears once, reached
// through B (the lowest id), so the edge from C has to be found from the genealogy table.
const diamondFn = () => ({
    f_trace_ancestors: [row(0, D, D), row(1, B, D, B), row(1, C, D, C), row(2, A, D, B, A)],
    f_trace_descendants: [row(0, A, A), row(1, B, A, B), row(1, C, A, C), row(2, D, A, B, D)],
    f_trace_stock_origins: [],
    f_sample_timeline: [],
});
const diamond = (readable, rootId) =>
    mount({ readable: new Set(readable), tables: diamondTables(), fn: diamondFn(), root: rootId });

test('diamond ancestors: the shared ancestor is returned once', async () => {
    const { handler } = diamond([A, B, C, D], D);
    const b = (await call(handler, user, D)).body;
    assert.deepEqual(b.ancestors.map((x) => x.sample_code), ['D-B', 'D-C', 'D-A']);
    assert.equal(b.ancestors.filter((x) => x.sample_id === A).length, 1);
    assert.ok(b.ancestors.every((x) => !x.through_hidden));
    assert.deepEqual(b.hidden, { stock_origins: 0, ancestors: 0, events: 0, descendants: 0 });
});

test('diamond descendants: the shared descendant is returned once', async () => {
    const { handler } = diamond([A, B, C, D], A);
    const b = (await call(handler, user, A)).body;
    assert.deepEqual(b.descendants.map((x) => x.sample_code), ['D-B', 'D-C', 'D-D']);
    assert.equal(b.descendants.filter((x) => x.sample_id === D).length, 1);
});

test('diamond with one branch hidden: through_hidden only when EVERY path is hidden', async () => {
    // B unreadable: A is still reachable through C, so it is not "through hidden".
    const one = diamond([A, C, D], D);
    const a = (await call(one.handler, user, D)).body;
    assert.deepEqual(a.ancestors.map((x) => [x.sample_code, x.through_hidden]), [['D-C', false], ['D-A', false]]);
    assert.equal(a.hidden.ancestors, 1);
    // the edge shown for A comes from the readable branch (C -> A is derived_from, not cut_from)
    assert.equal(a.ancestors[1].relationship_type, 'derived_from');
    // both B and C unreadable: every path to A is hidden
    const both = diamond([A, D], D);
    const b = (await call(both.handler, user, D)).body;
    assert.deepEqual(b.ancestors.map((x) => [x.sample_code, x.through_hidden]), [['D-A', true]]);
    assert.equal(b.hidden.ancestors, 2);
});

test('a cycle back-edge never supplies the edge shown: the shallowest readable step does', async () => {
    // A -> B -> D -> E -> B. B's linked reached nodes are A (depth 0) and E (depth 3, a lower id);
    // the edge shown for B must be A -> B's, not the back-edge E -> B.
    const E = id(5);
    const tables = {
        ...baseTables(),
        physical_samples: [[A, 'D-A'], [B, 'D-B'], [D, 'D-D'], [E, 'D-E']].map(([sid, code]) => ({ sample_id: sid, sample_code: code, form: 'bar' })),
        sample_genealogy: [
            { child_sample_id: B, parent_sample_id: A, relationship_type: 'cut_from', fraction: '0.5' },
            { child_sample_id: D, parent_sample_id: B, relationship_type: 'cut_from', fraction: null },
            { child_sample_id: E, parent_sample_id: D, relationship_type: 'cut_from', fraction: null },
            { child_sample_id: B, parent_sample_id: E, relationship_type: 'derived_from', fraction: null },
        ],
        sample_stock_provenance: [],
        raw_stock_lots: [],
    };
    const fn = {
        f_trace_ancestors: [row(0, A, A)],
        f_trace_descendants: [row(0, A, A), row(1, B, A, B), row(2, D, A, B, D), row(3, E, A, B, D, E)],
        f_trace_stock_origins: [],
        f_sample_timeline: [],
    };
    const { handler } = mount({ readable: new Set([A, B, D, E]), tables, fn, root: A });
    const b = (await call(handler, user, A)).body;
    assert.deepEqual(b.descendants.map((x) => [x.sample_code, x.relationship_type]), [['D-B', 'cut_from'], ['D-D', 'cut_from'], ['D-E', 'cut_from']]);
});

test('a hidden sample reached by two paths is counted once', async () => {
    const { handler } = diamond([B, C, D], D); // A unreadable, but reached by two routes
    const b = (await call(handler, user, D)).body;
    assert.deepEqual(b.ancestors.map((x) => x.sample_code), ['D-B', 'D-C']);
    assert.equal(b.hidden.ancestors, 1);
    assert.ok(!JSON.stringify(b).includes('D-A'));
});

test('a lot reached through two paths to the same ancestor is listed once', async () => {
    const lot = id(302);
    const fn = diamondFn();
    fn.f_trace_stock_origins = [
        { via_sample_id: A, depth: 2, lot_id: lot },
        { via_sample_id: A, depth: 2, lot_id: lot },
    ];
    const tables = diamondTables();
    tables.raw_stock_lots = [{ lot_id: lot, lot_code: 'LOT-2', stock_type: 'bar', supplier_name: 'X' }];
    tables.sample_stock_provenance = [{ sample_id: A, lot_id: lot, mass_used_grams: '5' }];
    const { handler } = mount({ readable: new Set([A, B, C, D, lot]), tables, fn, root: D });
    const b = (await call(handler, user, D)).body;
    assert.equal(b.stock_origins.length, 1);
    assert.equal(b.stock_origins[0].mass_used_grams, 5);
    assert.equal(b.stock_origins[0].through_hidden, false);
});

// ---- field-level permissions ----

test('fields the role cannot read are absent from the output (sample, operation, test, lot)', async () => {
    const { handler } = mount({
        readable: all,
        strip: {
            physical_samples: ['form'],
            manufacturing_operations: ['pass_code', 'operation_date'],
            test_sessions: ['status'],
            raw_stock_lots: ['supplier_name'],
        },
    });
    const b = (await call(handler, user)).body;
    assert.equal(b.sample.form, null);
    assert.equal(b.sample.sample_code, '9-AA-1');
    assert.ok([...b.ancestors, ...b.descendants].every((n) => n.form === null && n.sample_code));
    assert.equal(b.events[0].label, null);
    assert.equal(b.events[0].date, null);
    assert.equal(b.events[0].sequence, 1);
    assert.equal(b.events[1].status, null);
    assert.equal(b.events[1].label, 'tensile');
    assert.equal(b.stock_origins[0].supplier_name, null);
    assert.equal(b.stock_origins[0].lot_code, 'LOT-1');
    const text = JSON.stringify(b);
    for (const leaked of ['coupon', '"bar"', 'P1', 'Acme', '2026-01-02']) assert.ok(!text.includes(leaked), leaked);
});

test('sample_genealogy and sample_stock_provenance fields are checked through ItemsService too', async () => {
    const stripped = mount({
        readable: all,
        strip: { sample_genealogy: ['fraction'], sample_stock_provenance: ['mass_used_grams'] },
    });
    const b = (await call(stripped.handler, user)).body;
    assert.equal(b.ancestors[0].relationship_type, 'cut_from');
    assert.equal(b.ancestors[0].fraction, null); // role cannot read it, though the table has 0.5
    assert.equal(b.stock_origins[0].mass_used_grams, null);
    assert.ok(stripped.reads.some((r) => r.collection === 'sample_genealogy'));
    assert.ok(stripped.reads.some((r) => r.collection === 'sample_stock_provenance'));

    // no access to the tables at all: nodes and lots are still shown, without the edge details
    const denied = mount({ readable: all, denyCollections: ['sample_genealogy', 'sample_stock_provenance'] });
    const d = (await call(denied.handler, user)).body;
    assert.equal(d.ancestors.length, 2);
    assert.deepEqual(d.ancestors.map((a) => [a.relationship_type, a.fraction]), [[null, null], [null, null]]);
    assert.equal(d.stock_origins[0].mass_used_grams, null);
    assert.equal(d.stock_origins.length, 1);
});

test('values are taken from ItemsService rows, never from the SQL function output', async () => {
    // The function rows carry poisoned values; none may reach the response.
    const fn = baseFn();
    fn.f_trace_ancestors[1] = { ...fn.f_trace_ancestors[1], sample_code: 'FROM-SQL', form: 'FROM-SQL', fraction: '9', relationship_type: 'FROM-SQL' };
    fn.f_trace_stock_origins[0] = { ...fn.f_trace_stock_origins[0], lot_code: 'FROM-SQL', mass_used_grams: '999', via_sample_code: 'FROM-SQL' };
    fn.f_sample_timeline[0] = { ...fn.f_sample_timeline[0], label: 'FROM-SQL', detail: { sequence: 99, status: 'FROM-SQL' } };
    const { handler } = mount({ readable: all, fn });
    const text = JSON.stringify((await call(handler, user)).body);
    assert.ok(!text.includes('FROM-SQL'));
    assert.ok(!text.includes('999'));
});

test('every read asks for all readable fields, so a restricted field cannot refuse the whole read', async () => {
    const { handler, reads } = mount({ readable: all, strip: { physical_samples: ['form'], sample_genealogy: ['fraction'] } });
    const r = await call(handler, user);
    assert.equal(r.status, 200);
    assert.ok(reads.length >= 6);
    for (const rd of reads) assert.deepEqual(rd.query.fields, ['*']);
});

// ---- bounds ----

test('the SQL is bounded: LIMIT 501 per section, de-duplicated, under a statement timeout', async () => {
    const { handler, sqls } = mount({ readable: all });
    await call(handler, user);
    const queries = sqls.filter((q) => !q.startsWith('SET LOCAL'));
    assert.equal(queries.length, 4);
    // every statement is preceded by its own SET LOCAL, within the single 8 s budget
    assert.equal(sqls.filter((q) => /^SET LOCAL statement_timeout = \d+$/.test(q)).length, 4);
    for (let i = 0; i < sqls.length; i += 2) assert.match(sqls[i], /^SET LOCAL statement_timeout = \d+$/);
    for (const q of queries) assert.match(q, /LIMIT 501/);
    assert.match(queries[0], /GROUP BY r.sample_id, r.depth/);
    assert.match(queries[1], /GROUP BY r.sample_id, r.depth/);
    assert.match(queries[2], /GROUP BY via_sample_id, lot_id/);
});

test('the statement timeout is the time left of one 8 s deadline, never per statement', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { handler, sqls } = mount({ readable: all, onQuery: () => t.mock.timers.tick(2500) });
    await call(handler, user);
    const timeouts = sqls.filter((q) => q.startsWith('SET LOCAL')).map((q) => Number(q.match(/= (\d+)/)[1]));
    assert.deepEqual(timeouts, [8000, 5500, 3000, 1000]); // 8000 - 3 x 2500 = 500, floored to 1 s
});

test('an exhausted deadline stops before the next statement and is a 503', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { handler, sqls } = mount({ readable: all, onQuery: () => t.mock.timers.tick(4500) });
    const r = await call(handler, user);
    assert.equal(r.status, 503);
    assert.match(r.body.errors[0].message, /too large to trace/);
    assert.equal(sqls.filter((q) => !q.startsWith('SET LOCAL')).length, 2); // the third never ran
});

test('a genealogy too large to trace within the timeout is a 503 with a readable message', async () => {
    const { handler } = mount({ readable: all, dbError: Object.assign(new Error('canceling statement'), { code: '57014' }) });
    const r = await call(handler, user);
    assert.equal(r.status, 503);
    assert.match(r.body.errors[0].message, /too large to trace/);
});

test('more than 500 ancestors are cut to the 500 nearest and flagged', async () => {
    const ids = Array.from({ length: 502 }, (_, i) => id(1000 + i));
    const fn = baseFn();
    fn.f_trace_ancestors = [row(0, ROOT, ROOT), ...ids.map((s, i) => row(i + 1, s, ROOT, s))];
    const tables = baseTables();
    tables.physical_samples.push(...ids.map((s, i) => ({ sample_id: s, sample_code: `N${i}`, form: 'bar' })));
    const { handler } = mount({ readable: new Set([...all, ...ids]), fn, tables });
    const b = (await call(handler, user)).body;
    assert.equal(b.ancestors.length, 500);
    assert.equal(b.ancestors[0].sample_code, 'N0');
    assert.equal(b.ancestors.at(-1).sample_code, 'N499');
    assert.equal(b.truncated.ancestors, true);
});

// 499 depth-1 ancestors (B unreadable, A1 and fillers readable), then D (reached via B at depth 2 and
// via X at depth 3) and X at depth 2: X is the 501st row and is cut.
function truncatedAncestors() {
    const B = id(4000), A1 = id(4001), D = id(4002), X = id(4003);
    const fillers = Array.from({ length: 497 }, (_, i) => id(4100 + i));
    const fn = baseFn();
    fn.f_trace_ancestors = [
        row(0, ROOT, ROOT),
        row(1, B, ROOT, B),
        row(1, A1, ROOT, A1),
        ...fillers.map((f) => row(1, f, ROOT, f)),
        row(2, D, ROOT, B, D),
        row(2, X, ROOT, A1, X),
    ];
    fn.f_trace_stock_origins = [{ via_sample_id: X, depth: 2, lot_id: LOT1 }];
    const tables = baseTables();
    // D is reached once (through B, the shortest route) but is also linked to X, which is cut from the list.
    const edge = (child_sample_id, parent_sample_id) => ({ child_sample_id, parent_sample_id, relationship_type: 'cut_from', fraction: null });
    tables.sample_genealogy.push(
        edge(ROOT, B), edge(ROOT, A1), ...fillers.map((f) => edge(ROOT, f)), edge(B, D), edge(A1, X), edge(X, D),
    );
    tables.physical_samples.push(...[B, A1, D, X, ...fillers].map((s, i) => ({ sample_id: s, sample_code: `T${i}`, form: 'bar' })));
    const readable = new Set([...all, A1, D, X, ...fillers]); // B is not readable
    return { D, X, ...mount({ readable, fn, tables }) };
}

test('a truncated ancestors list does not mark a row hidden because a step was cut from the list', async () => {
    const { handler, D } = truncatedAncestors();
    const b = (await call(handler, user)).body;
    assert.equal(b.truncated.ancestors, true);
    assert.equal(b.hidden.ancestors, 1); // B
    assert.equal(b.ancestors.length, 499);
    assert.equal(b.ancestors.find((a) => a.sample_id === D).through_hidden, false);
});

test('a stock lot via an ancestor that was cut from a truncated list is not marked through_hidden', async () => {
    const { handler, X } = truncatedAncestors();
    const b = (await call(handler, user)).body;
    const lot = b.stock_origins.find((s) => s.via_sample_id === X);
    assert.equal(lot.through_hidden, false);
});

test('more than 500 events keep the newest 500 (oldest first), and say so', async () => {
    const opIds = Array.from({ length: 503 }, (_, i) => id(2000 + i));
    const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000);
    const fn = baseFn();
    fn.f_sample_timeline = opIds.map((o, i) => ({ event_date: day(i), event_type: 'manufacturing_operation', event_id: o }));
    const tables = baseTables();
    tables.manufacturing_operations = opIds.map((o, i) => ({
        operation_id: o,
        pass_code: `OP${i}`,
        operation_sequence: i,
        operation_date: day(i).toISOString(),
    }));
    const { handler } = mount({ readable: new Set([...all, ...opIds]), fn, tables });
    const b = (await call(handler, user)).body;
    assert.equal(b.events.length, 500);
    assert.equal(b.events[0].label, 'OP3'); // OP0..OP2 (the oldest) were dropped
    assert.equal(b.events.at(-1).label, 'OP502');
    assert.equal(b.truncated.events, true);
});

test('when events are cut, undated ones go before dated ones', async () => {
    const opIds = Array.from({ length: 502 }, (_, i) => id(3000 + i));
    const fn = baseFn();
    fn.f_sample_timeline = opIds.map((o, i) => ({
        event_date: i < 400 ? new Date(Date.UTC(2026, 0, 1) + i * 86400000) : null,
        event_type: 'manufacturing_operation',
        event_id: o,
    }));
    const tables = baseTables();
    tables.manufacturing_operations = opIds.map((o, i) => ({
        operation_id: o,
        pass_code: `OP${i}`,
        operation_sequence: i,
        operation_date: i < 400 ? new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString() : null,
    }));
    const { handler } = mount({ readable: new Set([...all, ...opIds]), fn, tables });
    const b = (await call(handler, user)).body;
    assert.equal(b.events.length, 500);
    assert.equal(b.events[0].label, 'OP0'); // all 400 dated events survive
    assert.equal(b.events.filter((e) => e.date === null).length, 100);
    assert.equal(b.truncated.events, true);
});
