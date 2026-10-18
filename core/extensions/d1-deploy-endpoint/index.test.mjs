// Run with: node --test core/extensions/d1-deploy-endpoint/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext, {
    AGENT_AUTH_ERROR,
    MAX_ACK,
    MAX_ACK_CHARS,
    parseOffset,
    sanitiseAck,
} from './index.js';

const ADMIN = { user: 'admin-uuid', admin: true };
const ENV = { DEPLOY_AGENT_TOKEN: 'tok', DEPLOY_AGENT_URL: 'http://agent:8212/' };
const RUN = '20261018T091500Z';

// Mount the endpoint on a fake router; returns call(key, req) -> { status, body }.
function mount(env, fetchImpl) {
    const routes = {};
    const router = {
        get: (p, fn) => (routes[`GET ${p}`] = fn),
        post: (p, fn) => (routes[`POST ${p}`] = fn),
    };
    const logger = { error: () => {} };
    ext.handler(router, { env, logger });
    globalThis.fetch = fetchImpl;
    return (key, req) =>
        new Promise((resolve) => {
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
            routes[key](req, res);
        });
}

// Fetch stub that records the call and answers with a JSON body.
function recorder(status = 200, payload = { ok: true }) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(payload), { status });
    };
    return { calls, impl };
}

const ROUTES = [
    ['GET /state', {}],
    ['POST /check', {}],
    ['POST /deploy', { body: {} }],
    ['GET /runs', {}],
    ['GET /runs/:id', { params: { id: RUN }, query: {} }],
];

for (const [key, extra] of ROUTES) {
    test(`${key}: anonymous is 401`, async () => {
        const { impl, calls } = recorder();
        const call = mount(ENV, impl);
        assert.equal((await call(key, { accountability: {}, ...extra })).status, 401);
        assert.equal(calls.length, 0);
    });

    test(`${key}: non-admin app user is 403`, async () => {
        const { impl, calls } = recorder();
        const call = mount(ENV, impl);
        const acc = { user: 'u', admin: false, app: true };
        assert.equal((await call(key, { accountability: acc, ...extra })).status, 403);
        assert.equal(calls.length, 0);
    });

    test(`${key}: missing token is 503 not_configured`, async () => {
        const { impl, calls } = recorder();
        const call = mount({}, impl);
        const r = await call(key, { accountability: ADMIN, ...extra });
        assert.equal(r.status, 503);
        assert.equal(r.body.code, 'not_configured');
        assert.equal(calls.length, 0);
    });

    test(`${key}: unreachable agent is 502 agent_unreachable`, async () => {
        const call = mount(ENV, async () => {
            throw new TypeError('fetch failed');
        });
        const r = await call(key, { accountability: ADMIN, ...extra });
        assert.equal(r.status, 502);
        assert.equal(r.body.code, 'agent_unreachable');
    });

    test(`${key}: sends the token and the admin id as actor`, async () => {
        const { impl, calls } = recorder();
        const call = mount(ENV, impl);
        await call(key, { accountability: ADMIN, ...extra });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.headers['X-Deploy-Token'], 'tok');
        assert.equal(calls[0].init.headers['X-Deploy-Actor'], 'admin-uuid');
    });
}

test('routes hit the matching agent paths (trailing slash on the URL is trimmed)', async () => {
    const { impl, calls } = recorder();
    const call = mount(ENV, impl);
    for (const [key, extra] of ROUTES) await call(key, { accountability: ADMIN, ...extra });
    assert.deepEqual(
        calls.map((c) => `${c.init.method} ${c.url}`),
        [
            'GET http://agent:8212/state',
            'POST http://agent:8212/check',
            'POST http://agent:8212/deploy',
            'GET http://agent:8212/runs',
            `GET http://agent:8212/runs/${RUN}?offset=0`,
        ],
    );
});

test('default agent URL is host.docker.internal:8212', async () => {
    const { impl, calls } = recorder();
    const call = mount({ DEPLOY_AGENT_TOKEN: 't' }, impl);
    await call('GET /state', { accountability: ADMIN });
    assert.equal(calls[0].url, 'http://host.docker.internal:8212/state');
});

test('agent status and JSON are relayed verbatim (409 busy, 202 started, 404)', async () => {
    for (const [status, payload] of [
        [409, { code: 'busy' }],
        [202, { id: RUN }],
        [404, { error: 'no such run' }],
    ]) {
        const call = mount(ENV, async () => new Response(JSON.stringify(payload), { status }));
        const r = await call('POST /deploy', { accountability: ADMIN, body: {} });
        assert.equal(r.status, status);
        assert.deepEqual(JSON.parse(r.body), payload);
    }
});

for (const status of [401, 403]) {
    test(`agent ${status} (bad token) is 502 agent_auth, not the user's fault`, async () => {
        const call = mount(ENV, async () => new Response('{}', { status }));
        const r = await call('GET /state', { accountability: ADMIN });
        assert.equal(r.status, 502);
        assert.equal(r.body.error, AGENT_AUTH_ERROR);
        assert.equal(r.body.code, 'agent_auth');
    });
}

test('POST /deploy forwards only ack; client-chosen actor and extra keys are dropped', async () => {
    const { impl, calls } = recorder(202, { id: RUN });
    const call = mount(ENV, impl);
    const body = { ack: ['db/migrations/a.sql'], actor: 'someone-else', extra: 1 };
    await call('POST /deploy', { accountability: ADMIN, body });
    assert.deepEqual(JSON.parse(calls[0].init.body), { ack: ['db/migrations/a.sql'] });
    assert.equal(calls[0].init.headers['X-Deploy-Actor'], 'admin-uuid');
});

test('POST /deploy without ack forwards an empty ack list', async () => {
    const { impl, calls } = recorder(202, { id: RUN });
    const call = mount(ENV, impl);
    await call('POST /deploy', { accountability: ADMIN, body: undefined });
    assert.deepEqual(JSON.parse(calls[0].init.body), { ack: [] });
});

test('POST /deploy rejects a bad ack with 400 and never calls the agent', async () => {
    const bad = [
        'x',
        { a: 1 },
        [1],
        [''],
        ['x'.repeat(MAX_ACK_CHARS + 1)],
        Array.from({ length: MAX_ACK + 1 }, () => 'a'),
    ];
    for (const ack of bad) {
        const { impl, calls } = recorder();
        const call = mount(ENV, impl);
        const r = await call('POST /deploy', { accountability: ADMIN, body: { ack } });
        assert.equal(r.status, 400, JSON.stringify(ack).slice(0, 40));
        assert.equal(calls.length, 0);
    }
});

test('GET /runs/:id rejects malformed ids with 400', async () => {
    for (const id of ['x', '../state', '20261018T091500', '20261018T091500Zx', undefined]) {
        const { impl, calls } = recorder();
        const call = mount(ENV, impl);
        const r = await call('GET /runs/:id', {
            accountability: ADMIN,
            params: { id },
            query: {},
        });
        assert.equal(r.status, 400, String(id));
        assert.equal(calls.length, 0);
    }
});

test('GET /runs/:id rejects bad offsets and passes a good one through', async () => {
    for (const offset of ['-1', '1.5', 'abc', '1e3', ['1', '2'], '9'.repeat(20)]) {
        const { impl, calls } = recorder();
        const call = mount(ENV, impl);
        const r = await call('GET /runs/:id', {
            accountability: ADMIN,
            params: { id: RUN },
            query: { offset },
        });
        assert.equal(r.status, 400, String(offset));
        assert.equal(calls.length, 0);
    }
    const { impl, calls } = recorder();
    const call = mount(ENV, impl);
    await call('GET /runs/:id', {
        accountability: ADMIN,
        params: { id: RUN },
        query: { offset: '1234' },
    });
    assert.equal(calls[0].url, `http://agent:8212/runs/${RUN}?offset=1234`);
});

test('sanitiseAck and parseOffset basics', () => {
    assert.deepEqual(sanitiseAck({}), { ack: [] });
    assert.deepEqual(sanitiseAck({ ack: ['a'] }), { ack: ['a'] });
    assert.ok(sanitiseAck({ ack: 'a' }).error);
    assert.deepEqual(parseOffset(undefined), { offset: 0 });
    assert.deepEqual(parseOffset('0'), { offset: 0 });
    assert.ok(parseOffset('-3').error);
});
