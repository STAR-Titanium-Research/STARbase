// Run with: node --test core/extensions/d1-ask-endpoint/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext, {
    MAX_CONTENT_CHARS,
    MAX_MESSAGES,
    UPSTREAM_AUTH_ERROR,
    sanitiseMessages,
} from './index.js';

function mount(env, fetchImpl) {
    let handler;
    const router = { post: (_path, fn) => (handler = fn) };
    const logger = { error: () => {} };
    ext.handler(router, { env, logger });
    globalThis.fetch = fetchImpl;
    return handler;
}

function call(handler, accountability, body) {
    return new Promise((resolve) => {
        const out = { status: 200, body: undefined };
        const res = {
            status(code) {
                out.status = code;
                return res;
            },
            set() {
                return res;
            },
            json(b) {
                out.body = b;
                resolve(out);
                return res;
            },
            send(b) {
                out.body = b;
                resolve(out);
                return res;
            },
        };
        handler({ accountability, body }, res);
    });
}

const okFetch = async (_url, init) =>
    new Response(JSON.stringify({ echoed: JSON.parse(init.body) }), { status: 200 });

const goodBody = { messages: [{ role: 'user', content: 'how many samples?' }] };
const ENV = { WORKER_WEBHOOK_SECRET: 's3cret' };

test('anonymous is 401', async () => {
    const h = mount(ENV, okFetch);
    assert.equal((await call(h, {}, goodBody)).status, 401);
});

test('API-only token (no admin, no app) is 403', async () => {
    const h = mount(ENV, okFetch);
    const r = await call(h, { user: 'u', admin: false, app: false }, goodBody);
    assert.equal(r.status, 403);
});

test('app user and admin are allowed', async () => {
    const h = mount(ENV, okFetch);
    assert.equal((await call(h, { user: 'u', app: true }, goodBody)).status, 200);
    assert.equal((await call(h, { user: 'u', admin: true }, goodBody)).status, 200);
});

test('missing secret is 503', async () => {
    const h = mount({}, okFetch);
    const r = await call(h, { user: 'u', app: true }, goodBody);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'text-to-SQL not configured');
});

test('only messages are forwarded; row_limit and extra keys are dropped', async () => {
    const h = mount(ENV, okFetch);
    const r = await call(
        h,
        { user: 'u', app: true },
        { ...goodBody, row_limit: 1e9, extra: 1 },
    );
    const forwarded = JSON.parse(r.body).echoed;
    assert.deepEqual(Object.keys(forwarded), ['messages']);
    assert.deepEqual(forwarded.messages, goodBody.messages);
});

test('row_count and truncated are relayed unchanged', async () => {
    const payload = {
        sql: 'SELECT 1',
        columns: ['a'],
        rows: [{ a: 1 }],
        row_count: 1,
        truncated: true,
        chart: null,
    };
    const h = mount(
        ENV,
        async () => new Response(JSON.stringify(payload), { status: 200 }),
    );
    const r = await call(h, { user: 'u', app: true }, goodBody);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), payload);
});

test('plugin 422 guard rejections are relayed with their status', async () => {
    const payload = { error: 'generated SQL rejected', reason: 'nope', sql: 'DROP' };
    const h = mount(
        ENV,
        async () => new Response(JSON.stringify(payload), { status: 422 }),
    );
    const r = await call(h, { user: 'u', app: true }, goodBody);
    assert.equal(r.status, 422);
    assert.deepEqual(JSON.parse(r.body), payload);
});

for (const status of [401, 403]) {
    test(`plugin ${status} (bad server secret) is 502, not the user's fault`, async () => {
        const h = mount(
            ENV,
            async () => new Response(JSON.stringify({ error: 'bad secret' }), { status }),
        );
        const r = await call(h, { user: 'u', app: true }, goodBody);
        assert.equal(r.status, 502);
        assert.equal(r.body.error, UPSTREAM_AUTH_ERROR);
        assert.equal(r.body.code, 'upstream_auth');
    });
}

test('unreachable plugin is 502', async () => {
    const h = mount(ENV, async () => {
        throw new TypeError('fetch failed');
    });
    const r = await call(h, { user: 'u', app: true }, goodBody);
    assert.equal(r.status, 502);
});

test('timeout is 504', async () => {
    const h = mount(ENV, async () => {
        throw new DOMException('timed out', 'TimeoutError');
    });
    const r = await call(h, { user: 'u', app: true }, goodBody);
    assert.equal(r.status, 504);
});

test('long conversations keep only the most recent MAX_MESSAGES', () => {
    const many = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({
        role: 'user',
        content: String(i),
    }));
    const { messages } = sanitiseMessages({ messages: many });
    assert.equal(messages.length, MAX_MESSAGES);
    assert.equal(messages.at(-1).content, String(MAX_MESSAGES + 4));
});

test('sanitiseMessages rejects bad input', () => {
    assert.ok(sanitiseMessages({}).error);
    assert.ok(sanitiseMessages({ messages: [] }).error);
    assert.ok(sanitiseMessages({ messages: [{ role: 'system', content: 'x' }] }).error);
    assert.ok(sanitiseMessages({ messages: [{ role: 'user', content: 5 }] }).error);
    assert.ok(
        sanitiseMessages({
            messages: [{ role: 'user', content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }],
        }).error,
    );
    assert.ok(
        !sanitiseMessages({
            messages: [{ role: 'user', content: 'x'.repeat(MAX_CONTENT_CHARS) }],
        }).error,
    );
});
