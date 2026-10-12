// Run with: node --test core/extensions/d1-usage/index.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ext, { PAGE_KEYS, RECORD_COLLECTIONS, bump, decay, mount, validTarget } from './index.js';

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
    const state = { usage: new Map(), cursors: new Map(), activity };
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
            state.usage.set(key(b[0], b[1], b[2]), { score: b[3], last_at: b[4], pinned: b[5], hidden_at: b[6] });
            return { rows: [] };
        }
        if (sql.startsWith('SELECT kind, target, score, last_at, pinned FROM d1_private.user_usage')) {
            assert.ok(sql.includes('user_id = ?'));
            return {
                rows: [...state.usage]
                    .filter(([k, r]) => k.startsWith(`${b[0]}|`) && (r.hidden_at == null || r.last_at > r.hidden_at))
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
            };
            const mine = [];
            txLog.push(mine);
            const trx = { raw: async (sql, b) => (mine.push(sql), exec(sql, b)) };
            try {
                return await fn(trx);
            } catch (e) {
                state.usage = snap.usage;
                state.cursors = snap.cursors;
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
    for (const k of ['samples', 'action:log-operation', 'home']) assert.equal(validTarget('page', k), true, k);
    for (const c of RECORD_COLLECTIONS) {
        assert.equal(validTarget('record', `${c}:${S1}`), true, c);
        assert.equal(validTarget('record', `${c}:42`), true, `${c} integer id`);
    }
    const bad = [
        ['page', 'nope'], ['page', ''], ['page', 'action:'], ['page', `physical_samples:${S1}`],
        ['page', "samples'; DROP TABLE x;--"], ['page', 'x'.repeat(500)], ['page', 5], ['page', null], ['page', undefined],
        ['record', 'samples'], ['record', `directus_users:${S1}`], ['record', `physical_samples:`],
        ['record', `physical_samples:${S1.toUpperCase()}`], ['record', 'physical_samples:0'],
        ['record', 'physical_samples:-1'], ['record', 'physical_samples:1.5'], ['record', 'physical_samples:12345678901234567890'],
        ['record', `:${S1}`], ['record', `physical_samples:${S1}:x`], ['record', "physical_samples:1' OR '1'='1"],
        ['record', `physical_samples:${'1'.repeat(300)}`], ['record', 'campaigns'],
        ['record', 'home'], ['other', 'home'], [undefined, 'home'],
    ];
    for (const [kind, target] of bad) assert.equal(validTarget(kind, target), false, `${kind} ${String(target).slice(0, 30)}`);
});

test('PAGE_KEYS is one literal list of quoted keys in the file (the kit drift test reads it as text)', () => {
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const block = src.match(/export const PAGE_KEYS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(block, 'export const PAGE_KEYS = new Set([...]);');
    const keys = [...block[1].matchAll(/^\s*'([^']+)',\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [...PAGE_KEYS]);
    assert.ok(PAGE_KEYS instanceof Set && PAGE_KEYS.size > 20);
    for (const k of ['samples', 'my-samples', 'action:log-operation', 'action:register-sample']) assert.ok(PAGE_KEYS.has(k), k);
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

test('SQL is parameterised: the user id and the target never appear in statement text, and a lock comes first', async () => {
    const { db, call } = setup();
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S1}` });
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: true });
    await call('GET /', ALICE);
    await call('POST /clear', ALICE);
    for (const { sql } of db.log) {
        assert.ok(!sql.includes(ALICE) && !sql.includes(S1) && !sql.includes('samples\''), sql);
    }
    assert.ok(db.txLog.length >= 4);
    for (const tx of db.txLog) assert.ok(tx[0].includes('pg_advisory_xact_lock'), 'each transaction locks the user first');
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

test('GET returns scores decayed to now, pinned first, then by score; each list is separate', async () => {
    const { clock, call } = setup();
    await call('POST /visit', ALICE, { kind: 'page', target: 'samples' }); // 1 at T0
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' });
    await call('POST /visit', ALICE, { kind: 'page', target: 'tests' }); // 2 at T0
    await call('POST /visit', ALICE, { kind: 'record', target: `physical_samples:${S1}` });
    await call('POST /pin', ALICE, { kind: 'page', target: 'equipment', pinned: true }); // score 0, pinned
    clock.now = at(10);
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.pages.map((p) => p.target), ['equipment', 'tests', 'samples']);
    assert.deepEqual(out.pages.map((p) => p.pinned), [true, false, false]);
    assert.ok(Math.abs(out.pages[1].score - 1) < 1e-12);
    assert.ok(Math.abs(out.pages[2].score - 0.5) < 1e-12);
    assert.deepEqual(Object.keys(out.pages[0]).sort(), ['last_at', 'pinned', 'score', 'target']);
    assert.deepEqual(out.records.map((r) => r.target), [`physical_samples:${S1}`]);
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
    assert.deepEqual(b.pages.map((p) => p.target), ['people', 'tests']);
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

test('pin upserts a missing row, pinning un-hides, hiding un-pins, unpinning a zero row drops it', async () => {
    const { clock, call } = setup();
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: true });
    let out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.pages.map((p) => [p.target, p.pinned, p.score]), [['samples', true, 0]]);
    clock.now = at(1);
    await call('POST /hide', ALICE, { kind: 'page', target: 'samples' });
    assert.deepEqual((await call('GET /', ALICE)).body.pages, [], 'hide unpins and hides');
    await call('POST /pin', ALICE, { kind: 'page', target: 'samples', pinned: true });
    out = (await call('GET /', ALICE)).body;
    assert.equal(out.pages[0].pinned, true, 'pinning un-hides');
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
    assert.deepEqual(out.pages.map((p) => p.target), ['tests']);
    assert.deepEqual(out.records, [], 'old activity is not folded back in');
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

test('folded activity keeps a record\'s pin', async () => {
    const activity = [act(1, ALICE, 'update', 'physical_samples', S1, at(-1))];
    const { call } = setup({ activity });
    const target = `physical_samples:${S1}`;
    await call('POST /pin', ALICE, { kind: 'record', target, pinned: true });
    const out = (await call('GET /', ALICE)).body;
    assert.deepEqual(out.records.map((r) => [r.target, r.pinned]), [[target, true]]);
    assert.ok(out.records[0].score > 2);
});
