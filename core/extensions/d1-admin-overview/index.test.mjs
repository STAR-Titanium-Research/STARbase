// Run with: node --test core/extensions/d1-admin-overview/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext from './index.js';

function mount(database, warnings = []) {
    const handlers = {};
    const router = { get: (path, fn) => (handlers['GET ' + path] = fn) };
    ext.handler(router, { database, logger: { warn: (m) => warnings.push(m), error: () => {} } });
    return handlers['GET /'];
}

function call(handler, accountability, query = {}) {
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
        handler({ accountability, query }, res);
    });
}

const admin = { user: 'u', admin: true, app: true };

// A fake knex: raw() picks its answer by a marker in the SQL (the longest matching marker wins, so the
// recent-files list beats the count query). `overrides` maps a marker to a value or an Error to throw;
// `calls` records every SQL text.
function fakeDb(overrides = {}, calls = []) {
    const answers = {
        'count(*)::int AS n FROM directus_files': { rows: [{ n: '3' }] },
        'ORDER BY metadata': {
            rows: [
                { id: 'f1', filename_download: 'a.mat', missing_since: '2026-10-10T00:00:00Z' },
                { id: 'f2', filename_download: 'b.mat', missing_since: '2026-10-09T00:00:00Z' },
            ],
        },
        to_regclass: { rows: [{ t: 'file_fingerprints' }] },
        'FROM file_fingerprints': { rows: [{ status: 'done', n: '10' }, { status: 'error', n: 2 }] },
        'FROM force_crawler_state': {
            rows: [{
                desired_state: 'running',
                current_activity: 'scanning',
                last_heartbeat_at: '2026-10-12T09:00:00Z',
                processed_count: 5,
                error_count: 1,
            }],
        },
        'FROM machining_force_analysis': { rows: [{ status: 'pending', n: '7' }, { status: 'done', n: '40' }] },
        'now() AS t': { rows: [{ t: new Date('2026-10-12T09:00:10Z') }] },
        to_regproc: { rows: [{ f: 'd1_private.readers_drift_count' }] },
        'readers_drift_count() AS n': { rows: [{ n: '0', checked_at: new Date('2026-10-12T09:00:05Z') }] },
        'FROM physical_samples': { rows: [{ n: '4' }] },
        'FROM campaigns': { rows: [{ n: '2' }] },
        'FROM manufacturing_operations': { rows: [{ n: '27' }] },
    };
    const merged = { ...answers, ...overrides };
    return {
        raw: async (sql) => {
            calls.push(sql);
            const key = Object.keys(merged)
                .filter((k) => sql.includes(k))
                .sort((a, b) => b.length - a.length)[0];
            const v = merged[key];
            if (v instanceof Error) throw v;
            return v;
        },
    };
}

test('refuses anonymous callers with 401 and non-admins with 403', async () => {
    const calls = [];
    const h = mount(fakeDb({}, calls));
    assert.equal((await call(h, null)).status, 401);
    assert.equal((await call(h, {})).status, 401);
    assert.equal((await call(h, { admin: true })).status, 401);
    assert.equal((await call(h, { user: 'u', app: true, admin: false })).status, 403);
    assert.equal(calls.length, 0, 'no SQL for a refused caller');
});

test('returns the full overview shape for an admin', async () => {
    const r = await call(mount(fakeDb()), admin);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
        missingFiles: {
            count: 3,
            recent: [
                { id: 'f1', filename_download: 'a.mat', missing_since: '2026-10-10T00:00:00Z' },
                { id: 'f2', filename_download: 'b.mat', missing_since: '2026-10-09T00:00:00Z' },
            ],
        },
        fingerprints: { done: 10, error: 2, missing: 0 },
        crawler: {
            state: {
                desired_state: 'running',
                current_activity: 'scanning',
                last_heartbeat_at: '2026-10-12T09:00:00Z',
                processed_count: 5,
                error_count: 1,
            },
            analyses: { pending: 7, processing: 0, done: 40, error: 0 },
        },
        ownerless: { samples: 4, campaigns: 2, machiningOperations: 27 },
        readers_drift: { count: 0, checked_at: '2026-10-12T09:00:05.000Z', flagged: false },
        serverTime: '2026-10-12T09:00:10.000Z',
    });
});

test('the SQL follows the agreed rules', async () => {
    const calls = [];
    await call(mount(fakeDb({}, calls)), admin);
    const all = calls.join('\n');
    assert.match(all, /\(metadata::jsonb->>'missing'\) = 'true'/);
    assert.match(all, /metadata::jsonb->>'missing_since'/);
    assert.match(all, /LIMIT 10/);
    assert.match(all, /owner_person_id IS NULL/);
    assert.match(all, /process_category IS NULL OR process_category <> 'sintering'/);
});

test('a missing file_fingerprints table gives zeros, not an error', async () => {
    const calls = [];
    const r = await call(mount(fakeDb({ to_regclass: { rows: [{ t: null }] } }, calls)), admin);
    assert.deepEqual(r.body.fingerprints, { done: 0, error: 0, missing: 0 });
    assert.ok(!calls.some((s) => s.includes('FROM file_fingerprints')));
});

test('an empty force_crawler_state gives state null but keeps the analyses', async () => {
    const r = await call(mount(fakeDb({ 'FROM force_crawler_state': { rows: [] } })), admin);
    assert.equal(r.body.crawler.state, null);
    assert.equal(r.body.crawler.analyses.done, 40);
});

test('one failing part is null (and logged); the others are still served', async () => {
    const warnings = [];
    const r = await call(
        mount(fakeDb({ 'FROM machining_force_analysis': new Error('boom') }), warnings),
        admin,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.crawler, null);
    assert.equal(r.body.missingFiles.count, 3);
    assert.equal(r.body.fingerprints.done, 10);
    assert.equal(r.body.ownerless.samples, 4);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /crawler.*boom/);
});

test('every part failing still answers 200 with nulls', async () => {
    const database = {
        raw: async () => {
            throw new Error('db down');
        },
    };
    const r = await call(mount(database), admin);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { missingFiles: null, fingerprints: null, crawler: null, ownerless: null, readers_drift: null, serverTime: null });
});

test('serverTime is the database clock as ISO, and null when its query fails', async () => {
    const ok = await call(mount(fakeDb({ 'now() AS t': { rows: [{ t: '2026-10-12T09:00:20Z' }] } })), admin);
    assert.equal(ok.body.serverTime, '2026-10-12T09:00:20.000Z');
    const bad = await call(mount(fakeDb({ 'now() AS t': new Error('x') })), admin);
    assert.equal(bad.body.serverTime, null);
    assert.equal(bad.body.crawler.state.processed_count, 5, 'other parts unaffected');
});

const DRIFT_SQL = 'readers_drift_count() AS n';
const driftCalls = (calls) => calls.filter((sql) => sql.includes(DRIFT_SQL)).length;

test('readers_drift: the count is returned from d1_private.readers_drift_count() and a non-zero count is flagged', async () => {
    const calls = [];
    const ok = await call(mount(fakeDb({}, calls)), admin);
    assert.deepEqual(ok.body.readers_drift, { count: 0, checked_at: '2026-10-12T09:00:05.000Z', flagged: false });
    assert.ok(calls.some((sql) => sql.includes('d1_private.readers_drift_count()')));
    const drift = fakeDb({ [DRIFT_SQL]: { rows: [{ n: '7', checked_at: '2026-10-12T10:00:00Z' }] } });
    const bad = await call(mount(drift), admin);
    assert.deepEqual(bad.body.readers_drift, { count: 7, checked_at: '2026-10-12T10:00:00.000Z', flagged: true });
    assert.equal(bad.status, 200);
});

test('readers_drift: before migration 166 (no function) or on a failing query it is null, and the rest is served', async () => {
    const calls = [];
    const none = await call(mount(fakeDb({ to_regproc: { rows: [{ f: null }] } }, calls)), admin);
    assert.equal(none.body.readers_drift, null);
    assert.equal(driftCalls(calls), 0);
    const warnings = [];
    const broken = await call(mount(fakeDb({ [DRIFT_SQL]: new Error('boom') }), warnings), admin);
    assert.equal(broken.body.readers_drift, null);
    assert.equal(broken.body.ownerless.samples, 4);
    assert.match(warnings[0], /readers_drift.*boom/);
});

test('readers_drift: cached for a minute, recomputed by ?refresh=1 and after the minute', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const calls = [];
    const h = mount(fakeDb({}, calls));
    await call(h, admin);
    await call(h, admin);
    assert.equal(driftCalls(calls), 1, 'the second request reuses the value');
    t.mock.timers.tick(59_000);
    await call(h, admin);
    assert.equal(driftCalls(calls), 1, 'still inside the minute');
    await call(h, admin, { refresh: '1' });
    assert.equal(driftCalls(calls), 2, '?refresh=1 recomputes');
    await call(h, admin);
    assert.equal(driftCalls(calls), 2, 'and the refreshed value is the cached one');
    t.mock.timers.tick(61_000);
    await call(h, admin);
    assert.equal(driftCalls(calls), 3, 'after the minute it recomputes');
});

test('readers_drift: a refreshed value replaces a cached non-zero one', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    let n = '3';
    const database = { raw: async (sql) => (sql.includes(DRIFT_SQL) ? { rows: [{ n, checked_at: new Date(Date.now()) }] } : sql.includes('to_regproc') ? { rows: [{ f: 'x' }] } : { rows: [] }) };
    const h = mount(database);
    assert.equal((await call(h, admin)).body.readers_drift.count, 3);
    n = '0';
    assert.equal((await call(h, admin)).body.readers_drift.count, 3, 'cached');
    const r = await call(h, admin, { refresh: '1' });
    assert.deepEqual([r.body.readers_drift.count, r.body.readers_drift.flagged], [0, false]);
});

test('readers_drift: a non-admin still gets 403 and no SQL, with or without ?refresh=1', async () => {
    const calls = [];
    const h = mount(fakeDb({}, calls));
    assert.equal((await call(h, { user: 'u', app: true, admin: false }, { refresh: '1' })).status, 403);
    assert.equal((await call(h, null, { refresh: '1' })).status, 401);
    assert.equal(calls.length, 0);
});
