// Run with: node --test core/extensions/d1-next-number/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext from './index.js';

function mountAll(database, services = {}) {
    const handlers = {};
    const router = {
        get: (path, fn) => (handlers['GET ' + path] = fn),
        post: (path, fn) => (handlers['POST ' + path] = fn),
    };
    ext.handler(router, { database, logger: { error: () => {} }, services });
    return handlers;
}

function mount(database) {
    return mountAll(database)['GET /sample'];
}

function call(handler, accountability, query = {}, body = undefined) {
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
        handler({ accountability, query, body, schema: 'SCHEMA' }, res);
    });
}

const ok = { raw: async () => ({ rows: [{ next: '37' }] }) };

test('refuses anonymous and API-only callers', async () => {
    const h = mount(ok);
    assert.equal((await call(h, null)).status, 401);
    assert.equal((await call(h, {})).status, 401);
});

test('a signed-in user without app access is 403 (matches d1-ask)', async () => {
    const h = mount(ok);
    assert.equal((await call(h, { user: 'u', app: false, admin: false })).status, 403);
});

test('exclude given more than once is a 400, not silently ignored', async () => {
    const h = mount(ok);
    const id = '11111111-2222-3333-4444-555555555555';
    const r = await call(h, { user: 'u', app: true }, { exclude: [id, id] });
    assert.equal(r.status, 400);
});

test('returns the number for an app user and for an admin', async () => {
    const h = mount(ok);
    assert.deepEqual((await call(h, { user: 'u', app: true })).body, { next: 37 });
    assert.deepEqual((await call(h, { user: 'u', admin: true })).body, { next: 37 });
});

test('passes a valid exclude uuid and rejects a bad one', async () => {
    let args;
    const h = mount({ raw: async (_sql, a) => ((args = a), { rows: [{ next: 5 }] }) });
    const id = '11111111-2222-3333-4444-555555555555';
    assert.equal((await call(h, { user: 'u', app: true }, { exclude: id })).body.next, 5);
    assert.deepEqual(args, [id]);
    assert.equal((await call(h, { user: 'u', app: true }, { exclude: "x'; drop" })).status, 400);
});

test('a database failure is a 500, never a made-up number', async () => {
    const h = mount({ raw: async () => { throw new Error('boom'); } });
    const r = await call(h, { user: 'u', app: true });
    assert.equal(r.status, 500);
    assert.equal(r.body.next, undefined);
});

// ---------------------------------------------------------------------------------------------
// POST /operation-code: the live preview of an operation's code (T0b).
// preview_operation_code reads the saved operation with the database role's rights and checks
// nothing, so the endpoint must authorise the operation and the sample as the user first.

const SAMPLE = '11111111-2222-3333-4444-555555555555';
const OTHER_SAMPLE = '99999999-2222-3333-4444-555555555555';
const OP = 'aaaaaaaa-2222-3333-4444-555555555555';
const METHOD = 'bbbbbbbb-2222-3333-4444-555555555555';
const EQUIP = 'cccccccc-2222-3333-4444-555555555555';
const user = { user: 'u', app: true };

function forbidden() {
    return Object.assign(new Error('You do not have permission to access this.'), { status: 403, code: 'FORBIDDEN' });
}

// An ItemsService stub that records its constructions and reads, and answers from a table:
// a missing entry throws the forbidden error Directus gives for "not readable or not there".
function itemsStub(rows) {
    const log = { made: [], reads: [] };
    class ItemsService {
        constructor(collection, opts) {
            log.made.push({ collection, opts });
            this.collection = collection;
        }
        async readOne(id, query) {
            log.reads.push({ collection: this.collection, id, query });
            const row = rows[this.collection + ':' + id];
            if (!row) throw forbidden();
            return row;
        }
    }
    return { services: { ItemsService }, log };
}

// code: the merged-row preview; saved_rule: the rule's value for the saved row (existing operations only).
function previewDb(code = 'S-1-F1-30MPM', savedRule = 'S-1-F1-30MPM') {
    const seen = { calls: [] };
    return {
        seen,
        raw: async (sql, args) => (seen.calls.push({ sql, args }), { rows: [{ code, saved_rule: savedRule }] }),
    };
}

function mountPreview(rows = {}, db = previewDb()) {
    const { services, log } = itemsStub(rows);
    const h = mountAll(db, services)['POST /operation-code'];
    return { h, log, db };
}

const sampleRows = { ['physical_samples:' + SAMPLE]: { sample_code: 'S-1' } };

test('the preview route is registered as POST /operation-code', () => {
    assert.equal(typeof mountAll(ok, itemsStub({}).services)['POST /operation-code'], 'function');
});

test('preview: refuses anonymous callers (401) and users without app access (403)', async () => {
    const { h } = mountPreview(sampleRows);
    assert.equal((await call(h, null, {}, { values: {} })).status, 401);
    assert.equal((await call(h, {}, {}, { values: {} })).status, 401);
    assert.equal((await call(h, { user: 'u', app: false, admin: false }, {}, { values: {} })).status, 403);
});

test('preview: a bad body is a 400', async () => {
    const { h } = mountPreview(sampleRows);
    const bodies = [
        undefined, null, 'x', {}, { values: null }, { values: [] }, { values: 'x' },
        { values: {}, operation_id: 'not-a-uuid' }, { values: {}, operation_id: 5 },
        { values: { sample_id: 'nope' } }, { values: { method_id: 7 } },
        { values: { equipment_id: { equipment_id: 'x' } } },
    ];
    for (const body of bodies) {
        const r = await call(h, user, {}, body);
        assert.equal(r.status, 400, JSON.stringify(body));
    }
});

test('preview: a sample the user cannot read is a 403 and the SQL is never called', async () => {
    const { h, db } = mountPreview({});
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE } });
    assert.equal(r.status, 403);
    assert.equal(db.seen.calls.length, 0);
});

test('preview: an operation the user cannot read is a 403 and the SQL is never called', async () => {
    const { h, db } = mountPreview(sampleRows);
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE }, operation_id: OP });
    assert.equal(r.status, 403);
    assert.equal(db.seen.calls.length, 0);
});

test('preview: a new operation passes (values json, null, sample code) to the SQL and returns {code}', async () => {
    const { h, db, log } = mountPreview(sampleRows);
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE, machining_feed_mm_per_rev: 0.1 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { code: 'S-1-F1-30MPM', frozen: false, automatic: true });
    assert.equal(db.seen.calls.length, 1);
    assert.match(db.seen.calls[0].sql, /preview_operation_code\(\?::jsonb, \?::uuid, \?\)/);
    assert.doesNotMatch(db.seen.calls[0].sql, /saved_rule/);
    assert.equal(db.seen.calls[0].args.length, 3);
    const [json, opId, sampleCode] = db.seen.calls[0].args;
    assert.deepEqual(JSON.parse(json), { sample_id: SAMPLE, machining_feed_mm_per_rev: 0.1 });
    assert.equal(opId, null);
    assert.equal(sampleCode, 'S-1');
    // read as the requesting user, with the request's schema
    assert.deepEqual(log.made, [{ collection: 'physical_samples', opts: { accountability: user, schema: 'SCHEMA' } }]);
    assert.deepEqual(log.reads, [{ collection: 'physical_samples', id: SAMPLE, query: { fields: ['sample_code'] } }]);
});

test('preview: an edit reads the operation, and the sample of the saved operation when values has none', async () => {
    const rows = { ...sampleRows, ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE } };
    const { h, db, log } = mountPreview(rows);
    const r = await call(h, user, {}, { values: { machining_feed_mm_per_rev: 0.2 }, operation_id: OP });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { code: 'S-1-F1-30MPM', frozen: false, automatic: true });
    assert.equal(log.reads[0].collection, 'manufacturing_operations');
    assert.equal(log.reads[0].id, OP);
    assert.equal(log.reads[1].collection, 'physical_samples');
    assert.equal(log.reads[1].id, SAMPLE);
    assert.equal(log.reads.length, 2); // the saved sample is the merged one: read once
    assert.match(
        db.seen.calls[0].sql,
        /preview_operation_code\(\?::jsonb, \?::uuid, \?\) AS code, preview_operation_code\('\{\}'::jsonb, \?::uuid, \?\) AS saved_rule/,
    );
    assert.deepEqual(db.seen.calls[0].args.slice(1), [OP, 'S-1', OP, 'S-1']);
});

test("preview: values.sample_id wins for the code; the saved sample still gives the saved-row rule", async () => {
    const rows = {
        ...sampleRows,
        ['physical_samples:' + OTHER_SAMPLE]: { sample_code: 'S-9' },
        ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE, pass_code: 'S-1-F1-30MPM' },
    };
    const { h, db, log } = mountPreview(rows);
    const r = await call(h, user, {}, { values: { sample_id: OTHER_SAMPLE }, operation_id: OP });
    assert.equal(r.status, 200);
    assert.equal(r.body.automatic, true);
    assert.deepEqual(db.seen.calls[0].args.slice(1), [OP, 'S-9', OP, 'S-1']);
    // both samples read as the user, with the request's schema
    assert.deepEqual(log.reads.map((x) => [x.collection, x.id]), [
        ['manufacturing_operations', OP], ['physical_samples', SAMPLE], ['physical_samples', OTHER_SAMPLE],
    ]);
    for (const m of log.made) assert.deepEqual(m.opts, { accountability: user, schema: 'SCHEMA' });
});

test("preview: the saved operation's sample unreadable is a 403 even when values names another sample", async () => {
    const rows = {
        ['physical_samples:' + OTHER_SAMPLE]: { sample_code: 'S-9' },
        ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE },
    };
    const { h, db } = mountPreview(rows);
    const r = await call(h, user, {}, { values: { sample_id: OTHER_SAMPLE }, operation_id: OP });
    assert.equal(r.status, 403);
    assert.equal(db.seen.calls.length, 0);
});

// automatic: the trigger's test on the SAVED row (pass_code NULL, or equal to the rule's value for it).
const opRow = (pass_code) => ({
    ...sampleRows,
    ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE, source_system: null, pass_code },
});

test('preview: automatic is true when the saved code equals the rule for the saved row', async () => {
    // the merged-row preview differs (a field edit in the form): it does not matter
    const { h } = mountPreview(opRow('S-1-F1-30MPM'), previewDb('S-1-F1-45MPM', 'S-1-F1-30MPM'));
    const r = await call(h, user, {}, { values: { machining_cutting_speed_m_per_min: 45 }, operation_id: OP });
    assert.deepEqual(r.body, { code: 'S-1-F1-45MPM', frozen: false, automatic: true });
});

test('preview: automatic is false when the saved code differs from the rule for the saved row (typed)', async () => {
    // the live example: a typed code; even a merged preview equal to it does not make it automatic
    const { h } = mountPreview(opRow('DEMO-TI64-001-F1'), previewDb('DEMO-TI64-001-F1', 'DEMO-TI64-001-F5-60MPM'));
    const r = await call(h, user, {}, { values: {}, operation_id: OP });
    assert.deepEqual(r.body, { code: 'DEMO-TI64-001-F1', frozen: false, automatic: false });
});

test('preview: automatic compares exactly (no trim, case matters), as the trigger does', async () => {
    for (const saved of [' S-1-F1-30MPM', 's-1-f1-30mpm']) {
        const { h } = mountPreview(opRow(saved), previewDb('S-1-F1-30MPM', 'S-1-F1-30MPM'));
        const r = await call(h, user, {}, { values: {}, operation_id: OP });
        assert.equal(r.body.automatic, false, JSON.stringify(saved));
    }
});

test('preview: automatic is true when the saved code is NULL, whatever the rule gives', async () => {
    for (const rule of ['S-1-F1-30MPM', null]) {
        const { h } = mountPreview(opRow(null), previewDb(null, rule));
        const r = await call(h, user, {}, { values: {}, operation_id: OP });
        assert.deepEqual(r.body, { code: null, frozen: false, automatic: true });
    }
});

test('preview: automatic is false when the saved code is set and the rule gives NULL', async () => {
    const { h } = mountPreview(opRow('SOMETHING'), previewDb(null, null));
    const r = await call(h, user, {}, { values: {}, operation_id: OP });
    assert.equal(r.body.automatic, false);
});

test('preview: a saved operation with no sample reads no sample and passes null sample codes', async () => {
    const rows = { ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: null, pass_code: null } };
    const { h, db, log } = mountPreview(rows);
    const r = await call(h, user, {}, { values: {}, operation_id: OP });
    assert.equal(r.status, 200);
    assert.deepEqual(log.reads.map((x) => x.collection), ['manufacturing_operations']);
    assert.deepEqual(db.seen.calls[0].args.slice(1), [OP, null, OP, null]);
});

test('preview: no sample at all previews with a null sample code', async () => {
    const { h, db, log } = mountPreview({});
    const r = await call(h, user, {}, { values: { machining_operation_subtype: 'F' } });
    assert.equal(r.status, 200);
    assert.equal(db.seen.calls[0].args[2], null);
    assert.equal(log.reads.length, 0);
});

test('preview: a null code from the database is {code: null}', async () => {
    const { h } = mountPreview(sampleRows, previewDb(null));
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE } });
    assert.deepEqual(r.body, { code: null, frozen: false, automatic: true });
});

test('preview: only whitelisted keys reach the SQL', async () => {
    const { h, db } = mountPreview(sampleRows);
    await call(h, user, {}, {
        values: {
            sample_id: SAMPLE, pass_code: 'TYPED', machining_cutting_speed_m_per_min: 30,
            notes: 'free text', operation_id: OP, created_at: 'x', source_system: null, evil: { a: 1 },
        },
    });
    const sent = JSON.parse(db.seen.calls[0].args[0]);
    assert.deepEqual(sent, { sample_id: SAMPLE, pass_code: 'TYPED', machining_cutting_speed_m_per_min: 30, source_system: null });
});

test('preview: an m2o value given as an object is reduced to its key', async () => {
    const { h, db } = mountPreview(sampleRows);
    const r = await call(h, user, {}, {
        values: {
            sample_id: { sample_id: SAMPLE },
            method_id: { method_id: METHOD },
            equipment_id: { equipment_id: EQUIP },
        },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(db.seen.calls[0].args[0]), { sample_id: SAMPLE, method_id: METHOD, equipment_id: EQUIP });
    // and the sample read used the reduced id
    assert.equal(db.seen.calls[0].args[2], 'S-1');
});

test('preview: a database failure is a 500 with a generic message', async () => {
    const { h } = mountPreview(sampleRows, { raw: async () => { throw new Error('boom: secret detail'); } });
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE } });
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(r.body), /secret/);
});

test('preview: a value Postgres cannot read as its column type is a 400, not a 500', async () => {
    const bad = Object.assign(new Error('invalid input syntax for type numeric'), { code: '22P02' });
    const { h } = mountPreview(sampleRows, { raw: async () => { throw bad; } });
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE, machining_feed_mm_per_rev: 'abc' } });
    assert.equal(r.status, 400);
});

test('preview: an unexpected error from the access check is a 500, not a 403', async () => {
    const services = { ItemsService: class { async readOne() { throw new Error('db down'); } } };
    const h = mountAll(previewDb(), services)['POST /operation-code'];
    const r = await call(h, user, {}, { values: { sample_id: SAMPLE } });
    assert.equal(r.status, 500);
});

test("preview: the saved operation's sample being unreadable is a 403 with no SQL", async () => {
    // the operation is readable, values has no sample_id, the saved sample is not in the table
    const rows = { ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE } };
    const { h, db } = mountPreview(rows);
    const r = await call(h, user, {}, { values: { machining_feed_mm_per_rev: 0.2 }, operation_id: OP });
    assert.equal(r.status, 403);
    assert.equal(db.seen.calls.length, 0);
});

test('preview: values.sample_id null sends a null sample code for the code, the saved one for the saved-row rule', async () => {
    const rows = { ...sampleRows, ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE } };
    const { h, db, log } = mountPreview(rows);
    const r = await call(h, user, {}, { values: { sample_id: null }, operation_id: OP });
    assert.equal(r.status, 200);
    assert.deepEqual(log.reads.map((x) => x.collection), ['manufacturing_operations', 'physical_samples']);
    assert.deepEqual(db.seen.calls[0].args.slice(1), [OP, null, OP, 'S-1']);
});

test('preview: a read that returns nothing instead of throwing fails closed (403, no SQL)', async () => {
    for (const rows of [{}, { ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE } }]) {
        const db = previewDb();
        class ItemsService {
            async readOne(id) {
                return rows['manufacturing_operations:' + id] ?? null;
            }
        }
        const h = mountAll(db, { ItemsService })['POST /operation-code'];
        // case 1: the operation read returns null; case 2: the operation is fine and the sample read returns null
        const body = Object.keys(rows).length
            ? { values: { sample_id: SAMPLE }, operation_id: OP }
            : { values: {}, operation_id: OP };
        const r = await call(h, user, {}, body);
        assert.equal(r.status, 403);
        assert.equal(db.seen.calls.length, 0);
    }
});

test('preview: a frozen (experiment_sheet) operation answers its saved code with frozen: true and no SQL', async () => {
    const rows = {
        ...sampleRows,
        ['manufacturing_operations:' + OP]: {
            operation_id: OP, sample_id: SAMPLE, source_system: 'experiment_sheet', pass_code: 'IMPORTED-CODE',
        },
    };
    const { h, db, log } = mountPreview(rows);
    const r = await call(h, user, {}, { values: { machining_feed_mm_per_rev: 0.2 }, operation_id: OP });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { code: 'IMPORTED-CODE', frozen: true, automatic: false });
    assert.equal(db.seen.calls.length, 0);
    assert.deepEqual(log.reads[0].query, {
        fields: ['operation_id', 'sample_id', 'source_system', 'pass_code'],
    });
});

test('preview: a frozen operation with no saved code answers {code: null, frozen: true}', async () => {
    const rows = {
        ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: null, source_system: 'experiment_sheet', pass_code: null },
    };
    const { h, db } = mountPreview(rows);
    const r = await call(h, user, {}, { values: {}, operation_id: OP });
    assert.deepEqual(r.body, { code: null, frozen: true, automatic: false });
    assert.equal(db.seen.calls.length, 0);
});

test('preview: a saved operation from any other source is previewed with frozen: false', async () => {
    const rows = {
        ...sampleRows,
        ['manufacturing_operations:' + OP]: { operation_id: OP, sample_id: SAMPLE, source_system: 'legacy_import', pass_code: 'X' },
    };
    const { h, db } = mountPreview(rows);
    const r = await call(h, user, {}, { values: {}, operation_id: OP });
    // saved 'X' is not the rule's value for the saved row: typed
    assert.deepEqual(r.body, { code: 'S-1-F1-30MPM', frozen: false, automatic: false });
    assert.equal(db.seen.calls.length, 1);
});
