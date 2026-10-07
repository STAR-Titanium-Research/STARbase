// Run with: node --test core/extensions/d1-next-number/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext from './index.js';

function mount(database) {
    let handler;
    const router = { get: (_path, fn) => (handler = fn) };
    ext.handler(router, { database, logger: { error: () => {} } });
    return handler;
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
