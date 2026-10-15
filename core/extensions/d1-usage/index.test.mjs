// Run with: node --test core/extensions/d1-usage/index.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ext, { PAGE_KEYS, RECORD_COLLECTIONS, SQL, bump, decay, mount, validTarget } from './index.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-12T09:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);

const ALICE = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';
const S1 = '11111111-aaaa-4aaa-8aaa-000000000001';
const S2 = '11111111-aaaa-4aaa-8aaa-000000000002';
const OP1 = '22222222-bbbb-4bbb-8bbb-000000000001';

// A stateful fake of the slice of knex the endpoint uses: raw() and transaction(). It keeps the two
// d1_private tables and a directus_activity table in memory and answers by the statement it is given,
// honouring the user_id / "user" bindings (so isolation is really tested) and throwing on any SQL it
// does not know. transaction() snapshots the state and restores it if the callback throws.
// `log` records every statement; `txLog` the statements of each transaction (lock must come first).
function fakeDb({ activity = [], failOnUpsertNumber = 0 } = {}) {
    const state = { usage: new Map(), cursors: new Map(), prefs: new Map(), activity };
    const log = [];
    const txLog = [];
    let upserts = 0;
    const key = (u, k, t) => `${u}|${k}|${t}`;

    function exec(sql, b = []) {
        log.push({ sql, bindings: b });
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.startsWith('SELECT score, last_at, pinned, hidden_at FROM d1_private.user_usage')) {
            const r = state.usage.get(key(b[0], b[1], b[2]));
            return { rows: r ? [{ ...r }] : [] };
        }
        if (sql.startsWith('INSERT INTO d1_private.user_usage_cursor')) {
            state.cursors.set(b[0], b[1]);
            return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO d1_private.user_usage (')) {
            upserts += 1;
            if (failOnUpsertNumber && upserts === failOnUpsertNumber) throw new Error('boom');
            // ON CONFLICT leaves pin_order alone; a new row has none.
            const prev = state.usage.get(key(b[0], b[1], b[2]));
            state.usage.set(key(b[0], b[1], b[2]), {
                score: b[3], last_at: b[4], pinned: b[5], hidden_at: b[6], pin_order: prev?.pin_order ?? null,
            });
            return { rows: [] };
        }
        if (sql.startsWith('SELECT kind, target, score, last_at, pinned FROM d1_private.user_usage')) {
            assert.ok(sql.includes('user_id = ?'));
            assert.ok(sql.includes("kind <> 'view' AND pinned = false"), 'Home leaves out view and pinned rows');
            return {
                rows: [...state.usage]
                    .filter(([k, r]) => k.startsWith(`${b[0]}|`) && !k.startsWith(`${b[0]}|view|`) && !r.pinned
                        && (r.hidden_at == null || r.last_at > r.hidden_at))
                    .map(([k, r]) => {
                        const [, kind, ...rest] = k.split('|');
                        return { kind, target: rest.join('|'), score: r.score, last_at: r.last_at, pinned: r.pinned };
                    }),
            };
        }
        if (sql.startsWith('SELECT last_activity_id FROM d1_private.user_usage_cursor')) {
            return { rows: state.cursors.has(b[0]) ? [{ last_activity_id: state.cursors.get(b[0]) }] : [] };
        }
        if (sql.startsWith('SELECT id FROM directus_activity WHERE "timestamp" < ?')) {
            const older = state.activity.filter((a) => a.timestamp < b[0]).map((a) => a.id);
            return { rows: older.length ? [{ id: Math.max(...older) }] : [] };
        }
        if (sql === 'SELECT id FROM directus_activity ORDER BY id DESC LIMIT 1') {
            const ids = state.activity.map((a) => a.id);
            return { rows: ids.length ? [{ id: Math.max(...ids) }] : [] };
        }
        if (sql.startsWith('SELECT id, collection, item, "timestamp" FROM directus_activity')) {
            assert.ok(sql.includes('"user" = ?'), 'the user column must be quoted');
            assert.ok(sql.includes("action IN ('create', 'update')"));
            assert.ok(sql.includes('LIMIT 500'));
            const cols = b.slice(2);
            return {
                rows: state.activity
                    .filter((a) => a.user === b[0] && a.id > b[1] && ['create', 'update'].includes(a.action)
                        && cols.includes(a.collection))
                    .sort((x, y) => x.id - y.id)
                    .slice(0, 500)
                    .map(({ id, collection, item, timestamp }) => ({ id, collection, item, timestamp })),
            };
        }
        if (sql.startsWith('DELETE FROM d1_private.user_usage WHERE user_id = ? AND pinned = false')) {
            for (const [k, r] of [...state.usage]) if (k.startsWith(`${b[0]}|`) && !r.pinned) state.usage.delete(k);
            return { rows: [] };
        }
        if (sql.startsWith('UPDATE d1_private.user_usage SET score = 0 WHERE user_id = ? AND pinned = true')) {
            for (const [k, r] of state.usage) if (k.startsWith(`${b[0]}|`) && r.pinned) r.score = 0;
            return { rows: [] };
        }
        // -- pins and preferences (migration 170) --
        const mine = (user) => [...state.usage].filter(([k]) => k.startsWith(`${user}|`));
        const split = (k) => {
            const [, kind, ...rest] = k.split('|');
            return { kind, target: rest.join('|') };
        };
        if (sql.startsWith('SELECT kind, target FROM d1_private.user_usage')) {
            assert.ok(sql.includes('user_id = ?') && sql.includes('ORDER BY pin_order'));
            return {
                rows: mine(b[0])
                    .filter(([, r]) => r.pinned)
                    .sort(([ka, ra], [kb, rb]) => (ra.pin_order ?? 1e9) - (rb.pin_order ?? 1e9) || (ka < kb ? -1 : 1))
                    .map(([k]) => split(k)),
            };
        }
        if (sql.startsWith('UPDATE d1_private.user_usage SET pin_order = (SELECT')) {
            // bindings: user, user, kind, target. Appends only to a row without an order.
            const r = state.usage.get(key(b[1], b[2], b[3]));
            if (r && r.pin_order == null) {
                const orders = mine(b[0]).map(([, x]) => x.pin_order).filter((o) => o != null);
                r.pin_order = orders.length ? Math.max(...orders) + 1 : 0;
            }
            return { rows: [] };
        }
        if (sql.startsWith('UPDATE d1_private.user_usage SET pin_order = NULL WHERE user_id = ? AND kind = ?')) {
            const r = state.usage.get(key(b[0], b[1], b[2]));
            if (r) r.pin_order = null;
            return { rows: [] };
        }
        if (sql.startsWith('UPDATE d1_private.user_usage u SET pin_order = r.n')) {
            assert.deepEqual(b[0], b[1]);
            const rows = mine(b[0]).filter(([, r]) => r.pin_order != null)
                .sort(([ka, ra], [kb, rb]) => ra.pin_order - rb.pin_order || (ka < kb ? -1 : 1));
            rows.forEach(([, r], i) => { r.pin_order = i; });
            return { rows: [] };
        }
        if (sql.startsWith('UPDATE d1_private.user_usage SET pin_order = ? WHERE user_id = ?')) {
            assert.ok(sql.includes('pinned = true'));
            const r = state.usage.get(key(b[1], b[2], b[3]));
            if (r && r.pinned) r.pin_order = b[0];
            return { rows: [] };
        }
        if (sql.startsWith('UPDATE d1_private.user_usage SET pinned = false, pin_order = NULL')) {
            for (const [, r] of mine(b[0])) if (r.pinned || r.pin_order != null) { r.pinned = false; r.pin_order = null; }
            return { rows: [] };
        }
        if (sql.startsWith('SELECT pins_seeded, prefs FROM d1_private.user_prefs')) {
            const r = state.prefs.get(b[0]);
            return { rows: r ? [{ pins_seeded: r.pins_seeded, prefs: structuredClone(r.prefs) }] : [] };
        }
        if (sql.startsWith('INSERT INTO d1_private.user_prefs (user_id, pins_seeded)')) {
            const r = state.prefs.get(b[0]) ?? { pins_seeded: false, prefs: {}, updated_at: null };
            state.prefs.set(b[0], { ...r, pins_seeded: true, updated_at: 'now' });
            return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO d1_private.user_prefs (user_id, prefs)')) {
            assert.equal(typeof b[1], 'string', 'prefs go in as one JSON text');
            const r = state.prefs.get(b[0]) ?? { pins_seeded: false, prefs: {}, updated_at: null };
            state.prefs.set(b[0], { ...r, prefs: { ...r.prefs, ...JSON.parse(b[1]) }, updated_at: 'now' });
            return { rows: [] };
        }
        throw new Error(`fakeDb: unknown SQL: ${sql}`);
    }

    return {
        state,
        log,
        txLog,
        raw: async (sql, b) => exec(sql, b),
        transaction: async (fn) => {
            const snap = {
                usage: new Map([...state.usage].map(([k, v]) => [k, { ...v }])),
                cursors: new Map(state.cursors),
                prefs: new Map([...state.prefs].map(([k, v]) => [k, structuredClone(v)])),
            };
            const mine = [];
            txLog.push(mine);
            const trx = { raw: async (sql, b) => (mine.push(sql), exec(sql, b)) };
            try {
                return await fn(trx);
            } catch (e) {
                state.usage = snap.usage;
                state.cursors = snap.cursors;
                state.prefs = snap.prefs;
                throw e;
            }
        },
    };
}

function setup(dbOpts) {
    const handlers = {};
    const router = {
        get: (p, fn) => (handlers['GET ' + p] = fn),
        post: (p, fn) => (handlers['POST ' + p] = fn),
    };
    const db = fakeDb(dbOpts);
    const logs = { warn: [], error: [] };
    const clock = { now: T0 };
    mount(router, {
        database: db,
        logger: { warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
    }, () => clock.now);
    const call = (route, user, body) => new Promise((resolve) => {
        const out = { status: 200, body: undefined };
        const res = {
            status(c) { out.status = c; return res; },
            json(b) { out.body = b; resolve(out); return res; },
            end() { resolve(out); return res; },
        };
        handlers[route]({ accountability: user === null ? null : { user }, body }, res);
    });
    return { db, logs, clock, call };
}

// -- pure helpers -------------------------------------------------------------------------------

test('decay halves the score every 10 days and never grows', () => {
    assert.equal(decay(8, T0, T0), 8);
    assert.ok(Math.abs(decay(8, T0, at(10)) - 4) < 1e-12);
    assert.ok(Math.abs(decay(8, T0, at(30)) - 1) < 1e-12);
    assert.equal(decay(8, at(5), T0), 8, 'a last_at in the future counts as now');
    assert.equal(decay(0, T0, at(3)), 0);
});

test('bump: a new row, a later use, and a use older than last_at', () => {
    const fresh = bump(null, 3, T0);
    assert.deepEqual([fresh.score, fresh.last_at.getTime()], [3, T0.getTime()]);
    const later = bump({ score: 2, last_at: T0 }, 1, at(10));
    assert.ok(Math.abs(later.score - 2) < 1e-12, '2 halves to 1, plus 1');
    assert.equal(later.last_at.getTime(), at(10).getTime());
    // An edit from 10 days before last_at is worth half its weight, and last_at stays put.
    const older = bump({ score: 2, last_at: at(10) }, 3, T0);
    assert.ok(Math.abs(older.score - 3.5) < 1e-12);
    assert.equal(older.last_at.getTime(), at(10).getTime());
});

test('validTarget accepts only known page keys and <collection>:<id> of the seven collections', () => {
    assert.equal(RECORD_COLLECTIONS.length, 7);
    assert.deepEqual([...RECORD_COLLECTIONS].sort(), [
        'campaigns', 'equipment', 'manufacturing_operations', 'people', 'physical_samples', 'projects', 'test_sessions',
    ]);
    for (const k of ['samples', 'action:log-operation', 'projects']) assert.equal(validTarget('page', k), true, k);
    for (const c of RECORD_COLLECTIONS) {
        assert.equal(validTarget('record', `${c}:${S1}`), true, c);
        assert.equal(validTarget('record', `${c}:42`), false, `${c} integer id (all keys are uuid)`);
    }
    const bad = [
        ['page', 'nope'], ['page', 'my-samples'], ['page', 'home'], ['page', ''], ['page', 'action:'], ['page', `physical_samples:${S1}`],
        ['page', "samples'; DROP TABLE x;--"], ['page', 'x'.repeat(500)], ['page', 5], ['page', null], ['page', undefined],
        ['record', 'samples'], ['record', `directus_users:${S1}`], ['record', `physical_samples:`],
        ['record', `physical_samples:${S1.toUpperCase()}`], ['record', 'physical_samples:0'], ['record', 'physical_samples:123'],
        ['record', 'physical_samples:-1'], ['record', 'physical_samples:1.5'], ['record', 'physical_samples:12345678901234567890'],
        ['record', `:${S1}`], ['record', `physical_samples:${S1}:x`], ['record', "physical_samples:1' OR '1'='1"],
        ['record', `physical_samples:${'1'.repeat(300)}`], ['record', 'campaigns'],
        ['record', 'home'], ['other', 'home'], [undefined, 'home'],
    ];
    for (const [kind, target] of bad) assert.equal(validTarget(kind, target), false, `${kind} ${String(target).slice(0, 30)}`);
});

test('validTarget: kind view is a positive integer preset id as text', () => {
    for (const t of ['1', '42', '2147483647']) assert.equal(validTarget('view', t), true, t);
    const bad = ['x', '0', '', '-1', '01', '1.5', '1e3', ' 1', '2147483648', '12345678901', '1; DROP TABLE x', 'samples', 42, null, undefined, ['1']];
    for (const t of bad) assert.equal(validTarget('view', t), false, String(t));
    assert.equal(validTarget('page', '42'), false);
});

test('PAGE_KEYS is one literal list of quoted keys in the file (the kit drift test reads it as text)', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const block = src.match(/export const PAGE_KEYS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(block, 'export const PAGE_KEYS = new Set([...]);');
    const keys = [...block[1].matchAll(/^\s*'([^']+)',\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [...PAGE_KEYS]);
    assert.ok(PAGE_KEYS instanceof Set && PAGE_KEYS.size > 20);
    for (const k of ['samples', 'projects', 'force-dashboard', 'action:log-operation', 'action:register-sample']) assert.ok(PAGE_KEYS.has(k), k);
});

test('the default export is an endpoint with the right id', () => {
    assert.equal(ext.id, 'd1-usage');
    assert.equal(typeof ext.handler, 'function');
});

// -- auth and validation ------------------------------------------------------------------------

const ROUTES = [
    ['GET /', undefined],
    ['POST /visit', { kind: 'page', target: 'samples' }],
    ['POST /pin', { kind: 'page', target: 'samples', pinned: true }],
    ['POST /hide', { kind: 'page', target: 'samples' }],
    ['POST /clear', {}],
    ['GET /nav', undefined],
    ['POST /pin-order', { items: [] }],
    ['POST /prefs', { theme: 'dark' }],
    ['POST /pins/reset', {}],
];

test('every route answers 401 without a signed-in user and runs no SQL', async () => {
    const { db, call } = setup();
    for (const [route, body] of ROUTES) {
        assert.equal((await call(route, null, body)).status, 401, route);
    }
    assert.equal(db.log.length, 0);
});

test('invalid bodies get 400 and write nothing', async () => {
    const { db, call } = setup();
    const cases = [
        ['POST /visit', undefined], ['POST /visit', 'samples'], ['POST /visit', []], ['POST /visit', {}],
        ['POST /visit', { kind: 'page', target: 'not-a-page' }],
        ['POST /visit', { kind: 'record', target: 'samples' }],
        ['POST /visit', { kind: 'record', target: 'users:1' }],
        ['POST /visit', { kind: 'record', target: "physical_samples:1' OR 1=1" }],
        ['POST /visit', { kind: 'nope', target: 'samples' }],
        ['POST /visit', { kind: 'page', target: ['samples'] }],
        ['POST /hide', { kind: 'page', target: 'zzz' }],
        ['POST /pin', { kind: 'page', target: 'samples' }],
        ['POST /pin', { kind: 'page', target: 'samples', pinned: 'yes' }],
        ['POST /pin', { kind: 'page', target: 'zzz', pinned: true }],
        ['POST /pin', { kind: 'view', target: 'x', pinned: true }],
        ['POST /pin', { kind: 'view', target: '0', pinned: true }],
        ['POST /pin-order', undefined], ['POST /pin-order', {}], ['POST /pin-order', { items: 'samples' }],
        ['POST /pin-order', { items: [{ kind: 'page', target: 'nope' }] }],
        ['POST /pin-order', { items: [{ kind: 'view', target: '0' }] }],
        ['POST /pin-order', { items: [{ kind: 'other', target: 'samples' }] }],
        ['POST /pin-order', { items: ['samples'] }],
        ['POST /prefs', undefined], ['POST /prefs', {}], ['POST /prefs', []], ['POST /prefs', 'dark'],
        ['POST /prefs', { colour: 'red' }],
        ['POST /prefs', { theme: 'dark', colour: 'red' }],
        ['POST /prefs', { theme: 'blue' }], ['POST /prefs', { theme: true }],
        ['POST /prefs', { sidebarCollapsed: 'yes' }], ['POST /prefs', { sidebarCollapsed: 1 }],
        ['POST /prefs', { autoCollapse: null }],
        ['POST /prefs', { __proto__: null, constructor: true }],
    ];
    for (const [route, body] of cases) {
        const r = await call(route, ALICE, body);
        assert.equal(r.status, 400, `${route} ${JSON.stringify(body)}`);
    }
    assert.equal(db.log.length, 0, 'nothing touched the database');
});

test('a database failure is a 500 with a logged error, not a crash', async () => {
    const { logs, call } = setup({ failOnUpsertNumber: 1 });
    const r = await call('POST /visit', ALICE, { kind: 'page', target: 'samples' });
    assert.equal(r.status, 500);
    assert.equal(logs.error.length, 1);
});

test('every statement sent is one of the constant SQL strings, and a lock comes first in each transaction', async () => {
    const { db, call } = setup();
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S1}` });
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: true });
    await call('POST /hide', ALICE, { kind: 'page', target: 'samples' });
    await call('GET /', ALICE);
    await call('POST /clear', ALICE);
    await call('GET /nav', ALICE);
    await call('POST /pin', ALICE, { kind: 'view', target: '42', pinned: true });
    await call('POST /pin', ALICE, { kind: 'page', target: 'tests', pinned: true });
    await call('POST /pin', ALICE, { kind: 'view', target: '42', pinned: false });
    await call('POST /pin-order', ALICE, { items: [{ kind: 'page', target: 'tests' }, { kind: 'page', target: 'samples' }, { kind: 'page', target: 'projects' }] });
    await call('POST /prefs', ALICE, { theme: 'dark' });
    await call('POST /pins/reset', ALICE);
    const allowed = new Set(Object.values(SQL));
    for (const { sql } of db.log) assert.ok(allowed.has(sql), `not a constant statement: ${sql}`);
    assert.ok(db.txLog.length >= 12);
    for (const tx of db.txLog) assert.equal(tx[0], SQL.lock, 'each transaction locks the user first');
});

test('the schema test (tests/phase1_schema.sh) runs the same SQL strings as index.js', () => {
    // The shell file keeps each statement on one line, with \" for a double quote; compare as the shell sees it.
    const sh = readFileSync(new URL('../../../tests/phase1_schema.sh', import.meta.url), 'utf8').replaceAll('\\"', '"');
    for (const [name, sql] of Object.entries(SQL)) assert.ok(sh.includes(sql), `phase1_schema.sh is missing SQL.${name}: ${sql}`);
});

// -- visit, list, decay -------------------------------------------------------------------------

test('visit adds weight 1, action pages 3, and fades the old score first', async () => {
    const { db, clock, call } = setup();
    assert.equal((await call('POST /visit', ALICE, { kind: 'page', target: 'samples' })).status, 204);
    const row = () => db.state.usage.get(`${ALICE}|page|samples`);
    assert.equal(row().score, 1);
    clock.now = at(10);
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' });
    assert.ok(Math.abs(row().score - 1.5) < 1e-12, '1 halves to 0.5, plus 1');
    assert.equal(row().last_at.getTime(), at(10).getTime());
    await call('POST /visit', ALICE, { kind: 'page', target: 'action:log-operation' });
    assert.equal(db.state.usage.get(`${ALICE}|page|action:log-operation`).score, 3);
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S1}` });
    assert.equal(db.state.usage.get(`${ALICE}|record|physical_samples:${S1}`).score, 1);
});

test('GET returns scores decayed to now, by score; each list is separate; pinned and view rows are left out', async () => {
    const { clock, call } = setup();
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' }); // 1 at T0
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' });
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' }); // 2 at T0
    await call('POST /visit', ALICE, { kind: 'page', target: 'people' }); // pinned below: not listed
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S1}` });
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S2}` }); // pinned below
    await call('POST /visit', ALICE, { kind: 'view', target: '42' }); // a view is never a Home row
    await call('POST /pin', ALICE, { kind: 'page', target: 'people', pinned: true });
    await call('POST /pin', ALICE, { kind: 'page', target: 'equipment', pinned: true });
    await call('POST /pin', ALICE, { kind: 'record', target: `physical_samples:${S2}`, pinned: true });
    await call('POST /pin', ALICE, { kind: 'view', target: '7', pinned: true });
    clock.now = at(10);
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.pages.map((p) => p.target), ['tests', 'samples']);
    assert.ok(Math.abs(out.pages[0].score - 1) < 1e-12);
    assert.ok(Math.abs(out.pages[1].score - 0.5) < 1e-12);
    assert.deepEqual(Object.keys(out.pages[0]).sort(), ['last_at', 'pinned', 'score', 'target']);
    assert.deepEqual(out.pages.map((p) => p.pinned), [false, false]);
    assert.deepEqual(out.records.map((r) => r.target), [`physical_samples:${S1}`]);
    // Unpinning an item puts it back in Home, at the score it earned.
    await call('POST /pin', ALICE, { kind: 'page', target: 'people', pinned: false });
    const again = (await call('GET /', ALICE)).body;
    assert.deepEqual(again.pages.map((p) => p.target).sort(), ['people', 'samples', 'tests']);
});

test('lists are capped at 15 each, and an old unpinned score fades out of the list', async () => {
    const { clock, call } = setup();
    for (const k of [...PAGE_KEYS].slice(0, 20)) await call('POST /visit', ALICE, { kind: 'page', target: k });
    const out = (await call('GET /', ALICE)).body;
    assert.equal(out.pages.length, 15);
    clock.now = at(200);
    const later = (await call('GET /', ALICE)).body;
    assert.equal(later.pages.length, 0, 'faded below the floor');
});

test('two users never see each other\'s rows', async () => {
    const { call } = setup();
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' });
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S1}` });
    await call('POST /visit', BOB, { kind: 'page', target: 'tests' });
    await call('POST /pin', BOB, { kind: 'page', target: 'people', pinned: true });
    const a = (await call('GET /', ALICE)).body;
    const b = (await call('GET /', BOB)).body;
    assert.deepEqual(a.pages.map((p) => p.target), ['samples']);
    assert.deepEqual(a.records.map((r) => r.target), [`physical_samples:${S1}`]);
    assert.deepEqual(b.pages.map((p) => p.target), ['tests'], 'Bob\'s pinned page is not a Home row');
    assert.deepEqual(b.records, []);
    // A clear by Bob leaves Alice's rows alone.
    await call('POST /clear', BOB);
    assert.equal((await call('GET /', ALICE)).body.pages.length, 1);
});

// -- hide, pin, clear ---------------------------------------------------------------------------

test('hide removes an item from the list, and using it again brings it back', async () => {
    const { clock, call } = setup();
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' });
    clock.now = at(1);
    assert.equal((await call('POST /hide', ALICE, { kind: 'page', target: 'samples' })).status, 204);
    assert.deepEqual((await call('GET /', ALICE)).body.pages, []);
    clock.now = at(2);
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' });
    assert.deepEqual((await call('GET /', ALICE)).body.pages.map((p) => p.target), ['samples']);
});

test('hiding something that has no row yet hides it until it is used', async () => {
    const { clock, call } = setup();
    await call('POST /hide', ALICE, { kind: 'page', target: 'tests' });
    assert.deepEqual((await call('GET /', ALICE)).body.pages, []);
    clock.now = at(1);
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' });
    assert.equal((await call('GET /', ALICE)).body.pages.length, 1);
});

test('pin upserts a missing row, pinning un-hides, hiding un-pins, an unpinned zero row is not listed', async () => {
    const { db, clock, call } = setup();
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: true });
    assert.deepEqual([...db.state.usage].map(([k, r]) => [k, r.pinned, r.score]), [[`${ALICE}|page|samples`, true, 0]]);
    assert.deepEqual((await call('GET /', ALICE)).body.pages, [], 'pinned rows are not Home rows');
    clock.now = at(1);
    await call('POST /hide', ALICE, { kind: 'page', target: 'samples' });
    assert.equal(db.state.usage.get(`${ALICE}|page|samples`).pinned, false, 'hide unpins');
    assert.notEqual(db.state.usage.get(`${ALICE}|page|samples`).hidden_at, null);
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: true });
    assert.equal(db.state.usage.get(`${ALICE}|page|samples`).hidden_at, null, 'pinning un-hides');
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: false });
    assert.deepEqual((await call('GET /', ALICE)).body.pages, [], 'nothing earned, nothing left to show');
});

test('clear deletes unpinned rows, zeroes pinned ones, and does not refold old activity', async () => {
    const activity = [
        { id: 1, user: ALICE, action: 'update', collection: 'physical_samples', item: S1, timestamp: at(-1) },
    ];
    const { db, call } = setup({ activity });
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' });
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' });
    await call('POST /pin', ALICE, { kind: 'page', target: 'tests', pinned: true });
    await call('GET /', ALICE); // folds the sample edit
    assert.equal(db.state.usage.has(`${ALICE}|record|physical_samples:${S1}`), true);
    assert.equal((await call('POST /clear', ALICE)).status, 204);
    assert.equal(db.state.usage.has(`${ALICE}|page|samples`), false);
    assert.equal(db.state.usage.has(`${ALICE}|record|physical_samples:${S1}`), false);
    assert.deepEqual([...db.state.usage].map(([k, r]) => [k, r.pinned, r.score]), [[`${ALICE}|page|tests`, true, 0]]);
    assert.equal(db.state.cursors.get(ALICE), 1, 'cursor moved to the newest activity id');
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.pages, [], 'the pinned page is not a Home row');
    assert.deepEqual(out.records, [], 'old activity is not folded back in');
    assert.deepEqual(pinsOf(db, ALICE), ['page|tests=0'], 'the pin stays');
});

// -- the activity fold --------------------------------------------------------------------------

const act = (id, user, action, collection, item, timestamp) => ({ id, user, action, collection, item, timestamp });

test('the first GET starts 30 days back; the fold counts the user\'s creates and updates only, once', async () => {
    const activity = [
        act(1, ALICE, 'update', 'physical_samples', S2, at(-40)), // older than 30 days: skipped
        act(2, ALICE, 'update', 'physical_samples', S2, at(-35)),
        act(3, ALICE, 'update', 'physical_samples', S1, at(-10)),
        act(4, BOB, 'update', 'physical_samples', S2, at(-9)), // another user's edit
        act(5, ALICE, 'delete', 'physical_samples', S2, at(-8)), // not create/update
        act(6, ALICE, 'create', 'directus_users', S1, at(-7)), // not one of the seven
        act(7, ALICE, 'create', 'manufacturing_operations', OP1, at(-5)),
        act(8, ALICE, 'update', 'physical_samples', S1, at(-5)),
    ];
    const { db, call } = setup({ activity });
    const out = (await call('GET /', ALICE)).body;
    const byTarget = Object.fromEntries(out.records.map((r) => [r.target, r.score]));
    assert.deepEqual(Object.keys(byTarget).sort(), [`manufacturing_operations:${OP1}`, `physical_samples:${S1}`]);
    // S1: weight 3 at day -10 and again at day -5, each faded to day 0.
    const expectS1 = 3 * 0.5 ** (10 / 10) + 3 * 0.5 ** (5 / 10);
    assert.ok(Math.abs(byTarget[`physical_samples:${S1}`] - expectS1) < 1e-9);
    assert.ok(Math.abs(byTarget[`manufacturing_operations:${OP1}`] - 3 * 0.5 ** 0.5) < 1e-9);
    assert.equal(db.state.cursors.get(ALICE), 8);
    // Idempotent: a second GET, and a third, change nothing.
    const upsertsBefore = db.log.filter((l) => l.sql.startsWith('INSERT INTO d1_private.user_usage (')).length;
    assert.deepEqual((await call('GET /', ALICE)).body, out);
    assert.deepEqual((await call('GET /', ALICE)).body, out);
    assert.equal(db.log.filter((l) => l.sql.startsWith('INSERT INTO d1_private.user_usage (')).length, upsertsBefore);
    // Bob's GET folds his own row only.
    const bob = (await call('GET /', BOB)).body;
    assert.deepEqual(bob.records.map((r) => r.target), [`physical_samples:${S2}`]);
    assert.ok(Math.abs(bob.records[0].score - 3 * 0.5 ** 0.9) < 1e-9);
});

test('the fold query binds the user and exactly the seven collections', async () => {
    const { db, call } = setup();
    await call('GET /', ALICE);
    const q = db.log.find((l) => l.sql.startsWith('SELECT id, collection, item, "timestamp"'));
    assert.deepEqual(q.bindings, [ALICE, 0, ...RECORD_COLLECTIONS]);
    assert.equal((q.sql.match(/\?/g) ?? []).length, 2 + 7);
});

test('a user with no matching activity still gets the cursor moved to the newest id (no rescans), once the page is short', async () => {
    const activity = [
        act(1, BOB, 'update', 'physical_samples', S1, at(-2)),
        act(2, ALICE, 'delete', 'physical_samples', S1, at(-2)),
        act(3, BOB, 'update', 'physical_samples', S2, at(-1)),
    ];
    const { db, call } = setup({ activity });
    await call('GET /', ALICE);
    assert.equal(db.state.cursors.get(ALICE), 3);
    const safeRead = db.log.findIndex((l) => l.sql === SQL.startId && l.bindings[0].getTime() === T0.getTime() - 5 * 60 * 1000);
    const scan = db.log.findIndex((l) => l.sql === SQL.activity);
    assert.ok(safeRead >= 0 && safeRead < scan, 'the newest id older than 5 minutes is read before the scan');
    // Later activity by her is found from the moved cursor.
    activity.push(act(4, ALICE, 'update', 'physical_samples', S2, at(-0.5)));
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.records.map((r) => r.target), [`physical_samples:${S2}`]);
    assert.equal(db.state.cursors.get(ALICE), 4);
});

test('the cursor never passes activity younger than 5 minutes: a write still uncommitted is folded once it shows', async () => {
    // Bob's id 4 is visible and recent; Alice's id 3 (a long import) has not committed yet.
    const activity = [
        act(1, BOB, 'update', 'physical_samples', S2, at(-1)),
        act(4, BOB, 'update', 'physical_samples', S2, new Date(T0.getTime() - 60 * 1000)),
    ];
    const { db, clock, call } = setup({ activity });
    await call('GET /', ALICE);
    assert.equal(db.state.cursors.get(ALICE), 1, 'stops at the newest row older than 5 minutes');
    // The import commits: its row has the lower id 3 and an old timestamp.
    activity.push(act(3, ALICE, 'create', 'physical_samples', S1, new Date(T0.getTime() - 90 * 1000)));
    clock.now = new Date(T0.getTime() + 10 * 60 * 1000);
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.records.map((r) => r.target), [`physical_samples:${S1}`], 'the late row is folded, not skipped');
    assert.equal(db.state.cursors.get(ALICE), 4, 'now old enough, the cursor moves on');
    // The last folded row counts too: a row of hers newer than the lag moves the cursor to itself.
    activity.push(act(5, ALICE, 'update', 'physical_samples', S1, new Date(clock.now.getTime() - 60 * 1000)));
    await call('GET /', ALICE);
    assert.equal(db.state.cursors.get(ALICE), 5);
});

test('later activity is folded on the next GET, advancing the cursor', async () => {
    const activity = [act(1, ALICE, 'update', 'physical_samples', S1, at(-2))];
    const { db, call } = setup({ activity });
    await call('GET /', ALICE);
    activity.push(act(2, ALICE, 'update', 'physical_samples', S1, at(-1)));
    const out = (await call('GET /', ALICE)).body;
    assert.equal(db.state.cursors.get(ALICE), 2);
    const expected = 3 * 0.5 ** 0.2 + 3 * 0.5 ** 0.1;
    assert.ok(Math.abs(out.records[0].score - expected) < 1e-9);
});

test('the fold reads at most 500 rows per call and picks up the rest next time', async () => {
    const activity = [];
    for (let i = 1; i <= 600; i++) {
        const item = `33333333-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`;
        activity.push(act(i, ALICE, 'create', 'campaigns', item, at(-1)));
    }
    const { db, call } = setup({ activity });
    // The cursor starts at 0 (nothing is older than 30 days).
    const first = (await call('GET /', ALICE)).body;
    assert.equal(db.state.cursors.get(ALICE), 500);
    assert.equal([...db.state.usage.keys()].filter((k) => k.startsWith(`${ALICE}|record|`)).length, 500);
    assert.equal(first.records.length, 15);
    await call('GET /', ALICE);
    assert.equal(db.state.cursors.get(ALICE), 600);
    assert.equal([...db.state.usage.keys()].filter((k) => k.startsWith(`${ALICE}|record|`)).length, 600);
});

test('a failure mid-fold rolls back the cursor and the scores, and the GET still answers', async () => {
    const activity = [
        act(1, ALICE, 'update', 'physical_samples', S1, at(-3)),
        act(2, ALICE, 'update', 'physical_samples', S2, at(-2)),
    ];
    const { db, logs, call } = setup({ activity, failOnUpsertNumber: 2 });
    const r = await call('GET /', ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { pages: [], records: [] });
    assert.equal(db.state.cursors.has(ALICE), false, 'cursor not advanced');
    assert.equal(db.state.usage.size, 0, 'no partial scores');
    assert.equal(logs.warn.length, 1);
    // The next GET (the fake no longer fails) folds both, once.
    const ok = await call('GET /', ALICE);
    assert.equal(ok.body.records.length, 2);
    assert.equal(db.state.cursors.get(ALICE), 2);
});

test('an edit older than a later hide does not un-hide the record; a newer edit does', async () => {
    const activity = [];
    const { clock, call } = setup({ activity });
    const target = `physical_samples:${S1}`;
    await call('POST /visit', ALICE, { kind: 'record', target });
    clock.now = at(1);
    await call('POST /hide', ALICE, { kind: 'record', target });
    // An edit made before the hide, only now reaching the fold.
    activity.push(act(1, ALICE, 'update', 'physical_samples', S1, at(0.5)));
    assert.deepEqual((await call('GET /', ALICE)).body.records, []);
    // An edit made after the hide counts as using it again.
    activity.push(act(2, ALICE, 'update', 'physical_samples', S1, at(1.5)));
    clock.now = at(2);
    assert.deepEqual((await call('GET /', ALICE)).body.records.map((r) => r.target), [target]);
});

test('folded activity keeps a record\'s pin and its place in the order', async () => {
    const activity = [act(1, ALICE, 'update', 'physical_samples', S1, at(-1))];
    const { db, call } = setup({ activity });
    const target = `physical_samples:${S1}`;
    await call('POST /pin', ALICE, { kind: 'page', target: 'tests', pinned: true });
    await call('POST /pin', ALICE, { kind: 'record', target, pinned: true });
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.records, [], 'a pinned record is not a Home row');
    const row = db.state.usage.get(`${ALICE}|record|${target}`);
    assert.equal(row.pinned, true);
    assert.equal(row.pin_order, 1);
    assert.ok(row.score > 2, 'the edit still counted');
    // Unpinned, it shows in Home with that score.
    await call('POST /pin', ALICE, { kind: 'record', target, pinned: false });
    assert.deepEqual((await call('GET /', ALICE)).body.records.map((r) => r.target), [target]);
});

// -- sidebar pins, order and preferences --------------------------------------------------------

const pg = (target) => ({ kind: 'page', target });
const vw = (target) => ({ kind: 'view', target });
const rc = (target) => ({ kind: 'record', target });
const nav = async (call, user) => (await call('GET /nav', user)).body;
const pinsOf = (db, user) => [...db.state.usage]
    .filter(([k, r]) => k.startsWith(`${user}|`) && r.pinned)
    .sort(([, x], [, y]) => x.pin_order - y.pin_order)
    .map(([k, r]) => `${k.split('|').slice(1).join('|')}=${r.pin_order}`);

test('nav seeds samples and projects once', async () => {
    const { db, call } = setup();
    const first = await nav(call, ALICE);
    assert.deepEqual(first.pins, [pg('samples'), pg('projects')]);
    assert.deepEqual(first.prefs, {});
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'page|projects=1']);
    assert.equal(db.state.prefs.get(ALICE).pins_seeded, true);
    // The same again: nothing new.
    assert.deepEqual((await nav(call, ALICE)).pins, [pg('samples'), pg('projects')]);
    // Unpin both: the next GET does not bring them back.
    await call('POST /pin', ALICE, { ...pg('samples'), pinned: false });
    await call('POST /pin', ALICE, { ...pg('projects'), pinned: false });
    assert.deepEqual((await nav(call, ALICE)).pins, []);
    assert.deepEqual((await nav(call, ALICE)).pins, []);
    // Another person is seeded on their own first call.
    assert.deepEqual((await nav(call, BOB)).pins, [pg('samples'), pg('projects')]);
});

test('nav seeding runs in the GET\'s own transaction, lock first, and a failure seeds nothing', async () => {
    const { db, call } = setup({ failOnUpsertNumber: 2 });
    const r = await call('GET /nav', ALICE);
    assert.equal(r.status, 500);
    assert.equal(db.state.usage.size, 0, 'rolled back');
    assert.equal(db.state.prefs.size, 0, 'pins_seeded not set either');
    assert.equal(db.txLog.length, 1);
    assert.equal(db.txLog[0][0], SQL.lock);
    // The next call seeds properly.
    assert.deepEqual((await nav(call, ALICE)).pins, [pg('samples'), pg('projects')]);
});

test('nav seeding for a person who already pinned in U1 appends samples and projects after their pins, once', async () => {
    const { db, call } = setup();
    // Pins made before the seed (the fake has no migration back-fill; pin appends 0, 1).
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    await call('POST /pin', ALICE, { ...pg('samples'), pinned: true });
    assert.deepEqual((await nav(call, ALICE)).pins, [pg('tests'), pg('samples'), pg('projects')]);
    assert.deepEqual(pinsOf(db, ALICE), ['page|tests=0', 'page|samples=1', 'page|projects=2']);
    await call('POST /pin', ALICE, { ...pg('projects'), pinned: false });
    assert.deepEqual((await nav(call, ALICE)).pins, [pg('tests'), pg('samples')], 'seeded once');
});

test('setting prefs first does not count as seeding', async () => {
    const { call } = setup();
    await call('POST /prefs', ALICE, { theme: 'dark' });
    const out = await nav(call, ALICE);
    assert.deepEqual(out.pins, [pg('samples'), pg('projects')]);
    assert.deepEqual(out.prefs, { theme: 'dark' });
});

test('nav orders pages, views and records together by pin_order', async () => {
    const { call } = setup();
    const rec = `physical_samples:${S1}`;
    await call('POST /pin', ALICE, { ...vw('42'), pinned: true });
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    await call('POST /pin', ALICE, { ...rc(rec), pinned: true });
    await call('POST /pin', ALICE, { ...pg('equipment'), pinned: true });
    // The person had pins before the first nav call: seeding appends samples and projects after them.
    const out = await nav(call, ALICE);
    assert.deepEqual(out.pins, [vw('42'), pg('tests'), rc(rec), pg('equipment'), pg('samples'), pg('projects')]);
    assert.deepEqual(Object.keys(out.pins[0]).sort(), ['kind', 'target']);
    await call('POST /pin-order', ALICE, { items: [rc(rec), pg('projects'), vw('42'), pg('equipment'), pg('samples'), pg('tests')] });
    assert.deepEqual((await nav(call, ALICE)).pins, [rc(rec), pg('projects'), vw('42'), pg('equipment'), pg('samples'), pg('tests')]);
});

test('nav returns prefs as stored (no defaults filled in)', async () => {
    const { call } = setup();
    await call('POST /prefs', ALICE, { sidebarCollapsed: true });
    assert.deepEqual((await nav(call, ALICE)).prefs, { sidebarCollapsed: true });
    assert.deepEqual((await nav(call, BOB)).prefs, {});
});

test('pin appends to the end and unpin closes the gap', async () => {
    const { db, call } = setup();
    await nav(call, ALICE); // samples=0, projects=1
    assert.equal((await call('POST /pin', ALICE, { ...vw('42'), pinned: true })).status, 204);
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    await call('POST /pin', ALICE, { ...pg('people'), pinned: true });
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'page|projects=1', 'view|42=2', 'page|tests=3', 'page|people=4']);
    // Pinning something already pinned keeps its place.
    await call('POST /pin', ALICE, { ...pg('projects'), pinned: true });
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'page|projects=1', 'view|42=2', 'page|tests=3', 'page|people=4']);
    // Unpin from the middle: later pins move up.
    assert.equal((await call('POST /pin', ALICE, { ...pg('projects'), pinned: false })).status, 204);
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'view|42=1', 'page|tests=2', 'page|people=3']);
    assert.equal(db.state.usage.get(`${ALICE}|page|projects`).pin_order, null);
    // Unpinning something never pinned changes nothing.
    await call('POST /pin', ALICE, { ...pg('tools'), pinned: false });
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'view|42=1', 'page|tests=2', 'page|people=3']);
    // A new pin goes after the last.
    await call('POST /pin', ALICE, { ...pg('projects'), pinned: true });
    assert.equal(db.state.usage.get(`${ALICE}|page|projects`).pin_order, 4);
});

test('pin keeps a row\'s earned score and last_at', async () => {
    const { db, clock, call } = setup();
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' });
    clock.now = at(3);
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    const row = db.state.usage.get(`${ALICE}|page|tests`);
    assert.equal(row.score, 1);
    assert.equal(row.last_at.getTime(), T0.getTime());
    assert.equal(row.pin_order, 0);
});

test('pin-order rewrites the order', async () => {
    const { db, call } = setup();
    await nav(call, ALICE);
    await call('POST /pin', ALICE, { ...vw('7'), pinned: true });
    const r = await call('POST /pin-order', ALICE, { items: [vw('7'), pg('projects'), pg('samples')] });
    assert.equal(r.status, 204);
    assert.deepEqual(pinsOf(db, ALICE), ['view|7=0', 'page|projects=1', 'page|samples=2']);
    assert.deepEqual((await nav(call, ALICE)).pins, [vw('7'), pg('projects'), pg('samples')]);
    // An empty list is right for a person with no pins.
    await call('POST /pin', ALICE, { ...vw('7'), pinned: false });
    await call('POST /pin', ALICE, { ...pg('projects'), pinned: false });
    await call('POST /pin', ALICE, { ...pg('samples'), pinned: false });
    assert.equal((await call('POST /pin-order', ALICE, { items: [] })).status, 204);
});

test('pin-order with a missing, extra, duplicate or foreign item is 409 and changes nothing', async () => {
    const { db, call } = setup();
    await nav(call, ALICE);
    await call('POST /pin', ALICE, { ...vw('7'), pinned: true });
    await call('POST /pin', BOB, { ...pg('people'), pinned: true });
    const before = pinsOf(db, ALICE);
    const bobBefore = pinsOf(db, BOB);
    const stale = [
        [pg('samples'), pg('projects')], // missing the view
        [pg('samples'), pg('projects'), vw('7'), pg('tests')], // extra, not pinned
        [pg('samples'), pg('projects'), vw('7'), pg('people')], // Bob's pin, not hers
        [pg('samples'), pg('samples'), vw('7')], // duplicate, one missing
        [pg('samples'), pg('samples'), pg('projects'), vw('7')], // duplicate
        [pg('samples'), pg('projects'), vw('8')], // wrong view id
        [],
    ];
    for (const items of stale) {
        const r = await call('POST /pin-order', ALICE, { items });
        assert.equal(r.status, 409, JSON.stringify(items));
        assert.deepEqual(r.body, { error: 'pins changed' });
        assert.deepEqual(pinsOf(db, ALICE), before);
    }
    assert.deepEqual(pinsOf(db, BOB), bobBefore);
    const updates = db.log.filter((l) => l.sql === SQL.setPinOrder);
    assert.equal(updates.length, 0, 'no order was written');
    // A target that does not belong to its kind is malformed (400), not stale.
    const r = await call('POST /pin-order', ALICE, { items: [pg('samples'), pg('projects'), pg('7')] });
    assert.equal(r.status, 400);
});

test('pin-order is all-or-nothing: a failure while writing rolls the whole order back', async () => {
    const { db, call } = setup();
    await nav(call, ALICE);
    await call('POST /pin', ALICE, { ...vw('7'), pinned: true });
    const before = pinsOf(db, ALICE);
    let n = 0;
    const realTx = db.transaction;
    db.transaction = (fn) => realTx((trx) => fn({
        raw: async (sql, b) => {
            if (sql === SQL.setPinOrder && (n += 1) === 2) throw new Error('boom');
            return trx.raw(sql, b);
        },
    }));
    const r = await call('POST /pin-order', ALICE, { items: [vw('7'), pg('projects'), pg('samples')] });
    db.transaction = realTx;
    assert.equal(r.status, 500);
    assert.deepEqual(pinsOf(db, ALICE), before);
});

test('prefs merges known keys; unknown key or wrong type is 400', async () => {
    const { db, logs, call } = setup();
    assert.equal((await call('POST /prefs', ALICE, { theme: 'dark' })).status, 204);
    assert.equal((await call('POST /prefs', ALICE, { sidebarCollapsed: true, autoCollapse: false })).status, 204);
    assert.deepEqual(db.state.prefs.get(ALICE).prefs, { theme: 'dark', sidebarCollapsed: true, autoCollapse: false });
    assert.equal((await call('POST /prefs', ALICE, { theme: 'system' })).status, 204);
    assert.deepEqual(db.state.prefs.get(ALICE).prefs, { theme: 'system', sidebarCollapsed: true, autoCollapse: false });
    assert.equal(db.state.prefs.get(ALICE).updated_at, 'now');
    assert.ok(SQL.setPrefs.includes('updated_at = now()'), 'updated_at is set on every write');
    assert.ok(SQL.setPrefs.includes('||'), 'merged, not replaced');
    const before = structuredClone(db.state.prefs.get(ALICE));
    const writes = db.log.length;
    for (const body of [{ theme: 'blue' }, { colour: 'red' }, { theme: 'dark', pinsSeeded: true }, { autoCollapse: 'no' }, {}]) {
        assert.equal((await call('POST /prefs', ALICE, body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(db.state.prefs.get(ALICE), before, 'nothing written');
    assert.equal(db.log.length, writes, 'no SQL for a bad body');
    assert.equal(logs.error.length, 0);
});

test('prefs cannot reach pins_seeded and are per person', async () => {
    const { db, call } = setup();
    await call('POST /prefs', ALICE, { theme: 'light' });
    assert.equal(db.state.prefs.get(ALICE).pins_seeded, false);
    assert.equal(db.state.prefs.has(BOB), false);
    assert.equal((await call('POST /prefs', ALICE, { pins_seeded: true })).status, 400);
});

test('pins/reset leaves exactly samples, projects', async () => {
    const { db, call } = setup();
    await nav(call, ALICE);
    await call('POST /pin', ALICE, { ...vw('7'), pinned: true });
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    await call('POST /pin', ALICE, { ...rc(`physical_samples:${S1}`), pinned: true });
    await call('POST /pin-order', ALICE, { items: [pg('tests'), vw('7'), pg('projects'), rc(`physical_samples:${S1}`), pg('samples')] });
    assert.equal((await call('POST /pins/reset', ALICE)).status, 204);
    assert.deepEqual((await nav(call, ALICE)).pins, [pg('samples'), pg('projects')]);
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'page|projects=1']);
    for (const [k, r] of db.state.usage) {
        if (k !== `${ALICE}|page|samples` && k !== `${ALICE}|page|projects`) {
            assert.equal(r.pinned, false, k);
            assert.equal(r.pin_order, null, k);
        }
    }
    assert.equal(db.state.prefs.get(ALICE).pins_seeded, true);
});

test('pins/reset works for a person who was never seeded, and seeds only once', async () => {
    const { db, call } = setup();
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    assert.equal((await call('POST /pins/reset', ALICE)).status, 204);
    assert.deepEqual(pinsOf(db, ALICE), ['page|samples=0', 'page|projects=1']);
    assert.equal(db.state.prefs.get(ALICE).pins_seeded, true);
    await call('POST /pin', ALICE, { ...pg('samples'), pinned: false });
    assert.deepEqual((await nav(call, ALICE)).pins, [pg('projects')], 'not seeded again');
});

test('pins/reset keeps preferences and earned scores', async () => {
    const { db, call } = setup();
    await call('POST /prefs', ALICE, { theme: 'dark' });
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' });
    await call('POST /pins/reset', ALICE);
    assert.deepEqual(db.state.prefs.get(ALICE).prefs, { theme: 'dark' });
    assert.equal(db.state.usage.get(`${ALICE}|page|tests`).score, 1);
});

test('hide clears pin_order and closes the gap', async () => {
    const { db, call } = setup();
    await nav(call, ALICE);
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    await call('POST /hide', ALICE, { ...pg('samples') });
    assert.equal(db.state.usage.get(`${ALICE}|page|samples`).pin_order, null);
    assert.deepEqual(pinsOf(db, ALICE), ['page|projects=0', 'page|tests=1']);
    // Hiding a view unpins it too.
    await call('POST /pin', ALICE, { ...vw('9'), pinned: true });
    await call('POST /hide', ALICE, { ...vw('9') });
    assert.deepEqual(pinsOf(db, ALICE), ['page|projects=0', 'page|tests=1']);
});

test('every new route touches only the caller\'s rows', async () => {
    const { db, call } = setup();
    await nav(call, ALICE);
    await nav(call, BOB);
    await call('POST /pin', BOB, { ...vw('5'), pinned: true });
    await call('POST /prefs', BOB, { theme: 'dark' });
    const bobPins = pinsOf(db, BOB);
    const bobPrefs = structuredClone(db.state.prefs.get(BOB));
    await call('POST /pin', ALICE, { ...pg('tests'), pinned: true });
    await call('POST /pin', ALICE, { ...pg('samples'), pinned: false });
    await call('POST /pin-order', ALICE, { items: [pg('tests'), pg('projects')] });
    await call('POST /prefs', ALICE, { autoCollapse: true });
    await call('POST /pins/reset', ALICE);
    await call('POST /hide', ALICE, { ...pg('projects') });
    assert.deepEqual(pinsOf(db, BOB), bobPins);
    assert.deepEqual(db.state.prefs.get(BOB), bobPrefs);
    assert.deepEqual((await nav(call, BOB)).pins, [pg('samples'), pg('projects'), vw('5')]);
    // Every statement of the pin routes binds the caller as user.
    const alice = db.log.filter((l) => l.bindings?.includes(ALICE));
    assert.ok(alice.length > 0);
    for (const l of db.log) if (l.bindings?.includes(BOB)) assert.ok(!l.bindings.includes(ALICE) || l.sql === SQL.lock, l.sql);
});

// Lab Viewer (migration 185): a read-only account role keeps its own prefs, pins and usage. This endpoint writes only the caller's rows of two d1_private tables
// with knex (never ItemsService, so Directus permissions do not apply and a policy with read rows only does not matter), and it has no role check: nothing here refuses a viewer.
test('Lab Viewer: pins, prefs and usage keep working; every write is a d1_private statement bound to the caller, through knex and no Directus permission', async () => {
    const VIEWER = 'c3333333-3333-4333-8333-333333333333';
    const { db, call } = setup();
    assert.equal((await call('POST /prefs', VIEWER, { theme: 'dark', sidebarCollapsed: true })).status, 204);
    assert.equal((await call('POST /pin', VIEWER, { ...pg('tests'), pinned: true })).status, 204);
    assert.equal((await call('POST /visit', VIEWER, { kind: 'record', target: `physical_samples:${S1}` })).status, 204);
    assert.equal((await call('POST /hide', VIEWER, { ...pg('projects') })).status, 204);
    assert.equal((await call('POST /pins/reset', VIEWER)).status, 204);
    assert.equal((await call('GET /nav', VIEWER)).status, 200);
    assert.deepEqual(db.state.prefs.get(VIEWER).prefs, { theme: 'dark', sidebarCollapsed: true });
    const writes = db.log.filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l.sql));
    assert.ok(writes.length > 0);
    for (const l of writes) assert.match(l.sql, /d1_private\./, l.sql);
    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    assert.ok(!/ItemsService|READ_ONLY_ROLE|isLabViewer/.test(source), 'the endpoint neither goes through Directus permissions nor refuses a role');
});
