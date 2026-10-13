// Run with: node --test core/extensions/d1-bug-report-endpoint/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import endpoint, { buildIssue } from './index.js';

const base = {
    title: 'Plot is blank',
    description: 'Nothing renders after opening the force plot.',
    kind: 'bug',
    area: 'dashboards',
    route: '/plot/force',
    reporterEmail: 'a@b.ac.uk',
    role: 'Lab Member',
};

test('buildIssue prefixes the title and labels by kind', () => {
    const r = buildIssue(base);
    assert.equal(r.title, '[Bug] Plot is blank');
    assert.deepEqual(r.labels, ['in-app-report', 'starbase-report', 'bug', 'area:starbase']);
});

test('buildIssue maps feature to enhancement and does not double the prefix', () => {
    const r = buildIssue({ ...base, kind: 'feature', title: '[Feature] Dark mode' });
    assert.equal(r.title, '[Feature] Dark mode');
    assert.ok(r.labels.includes('enhancement'));
    assert.ok(!r.labels.includes('bug'));
    assert.equal(buildIssue({ ...base, kind: 'feature' }).title, '[Feature] Plot is blank');
});

test('buildIssue tags by the picker, not by a prefix the reporter typed', () => {
    const r = buildIssue({ ...base, kind: 'bug', title: '[Feature] sneaky' });
    assert.equal(r.title, '[Bug] [Feature] sneaky');
});

test('buildIssue falls back to bug / general for unknown kind and area', () => {
    const r = buildIssue({ ...base, kind: 'nonsense', area: 'security' });
    assert.ok(r.title.startsWith('[Bug]'));
    assert.match(r.body, /\*\*Area:\*\* general {2}\n/);
    assert.deepEqual(r.labels, ['in-app-report', 'starbase-report', 'bug', 'area:starbase']);
});

test('buildIssue rejects a blank title', () => {
    assert.deepEqual(buildIssue({ ...base, title: '   ' }), { error: 'A title is required.' });
});

test('buildIssue never turns a scope into a label, whatever the client sends', () => {
    const r = buildIssue({ ...base, area: 'data-entry', scope: 'manufacturing_operations' });
    assert.ok(r.labels.every((l) => !l.startsWith('collection:') && !l.startsWith('page:')));
    assert.equal(r.labels.length, 4);
});

test('buildIssue puts the area and a valid scope in the body', () => {
    const coll = buildIssue({ ...base, area: 'data-entry', scope: 'manufacturing_operations' });
    assert.match(coll.body, /\*\*Area:\*\* data-entry › manufacturing_operations/);
    const page = buildIssue({ ...base, area: 'dashboards', scope: 'force-plot' });
    assert.match(page.body, /\*\*Area:\*\* dashboards › force-plot/);
});

test('buildIssue drops a malformed collection or an unlisted / foreign page', () => {
    const bad = buildIssue({ ...base, area: 'data-entry', scope: 'x`; drop table' });
    assert.match(bad.body, /\*\*Area:\*\* data-entry {2}\n/);
    assert.ok(!bad.body.includes('drop table'));
    const unlisted = buildIssue({ ...base, area: 'dashboards', scope: 'not-a-page' });
    assert.match(unlisted.body, /\*\*Area:\*\* dashboards {2}\n/);
    const foreign = buildIssue({ ...base, area: 'reports', scope: 'force-plot' });
    assert.match(foreign.body, /\*\*Area:\*\* reports {2}\n/);
});

test('buildIssue body carries reporter, role, route and source, never silently dropped', () => {
    const { body } = buildIssue(base);
    assert.match(body, /Nothing renders after opening the force plot\./);
    assert.match(body, /\*\*Reported by:\*\* a@b\.ac\.uk \(Lab Member\)/);
    assert.match(body, /\*\*Route at time of report:\*\* `\/plot\/force`/);
    assert.match(body, /\*\*Source:\*\* STARbase/);
    const anon = buildIssue({ ...base, reporterEmail: '', role: '' }).body;
    assert.match(anon, /\*\*Reported by:\*\* _unknown_/);
});

test('buildIssue says so when there is no description', () => {
    assert.match(buildIssue({ ...base, description: '  ' }).body, /_\(no description provided\)_/);
});

test('buildIssue neutralises backticks in the route so it cannot break out of the code span', () => {
    const { body } = buildIssue({ ...base, route: '/x`<img src=x onerror=1>`' });
    assert.ok(!/`\/x`/.test(body));
    assert.ok(!body.includes('`<img'));
});

test('buildIssue truncates an oversized title to GitHub-friendly length', () => {
    const r = buildIssue({ ...base, title: 'x'.repeat(400) });
    assert.ok(r.title.length <= 250);
});

test('buildIssue attaches diagnostics and console in the right sections', () => {
    const { body } = buildIssue({
        ...base,
        diagnostics: 'Browser: Firefox',
        consoleTail: '2026-10-01T10:00:01Z ERROR boom',
    });
    assert.match(body, /\*\*Browser state at time of report\*\*\s+```\nBrowser: Firefox\n```/);
    assert.match(body, /<details><summary>Browser console \(auto-attached\)<\/summary>/);
    assert.match(body, /ERROR boom/);
});

test('buildIssue omits attachment sections when none are supplied', () => {
    const { body } = buildIssue(base);
    assert.ok(!body.includes('<details>'));
    assert.ok(!body.includes('Browser state at time of report'));
});

test('buildIssue keeps attachments from closing their own fence', () => {
    const { body } = buildIssue({ ...base, consoleTail: 'a ``` <script>alert(1)</script>' });
    const fences = body.match(/^```$/gm) || [];
    assert.equal(fences.length, 2);
});

test('buildIssue redacts tokens and bearer credentials in diagnostics and console', () => {
    const { body } = buildIssue({
        ...base,
        diagnostics: 'URL: https://x/y?access_token=abc123&y=1',
        consoleTail: 'Authorization: Bearer eyJhbGci.def.ghi password=hunter2 secret=shh api_key=k3y refresh_token=r3f',
    });
    for (const leaked of ['abc123', 'eyJhbGci', 'hunter2', 'shh', 'k3y', 'r3f']) {
        assert.ok(!body.includes(leaked), `${leaked} leaked`);
    }
    assert.match(body, /access_token=<redacted>/);
    assert.match(body, /Bearer <redacted>/);
});

test('buildIssue tail-truncates an oversized console (keeps the newest lines)', () => {
    const { body } = buildIssue({ ...base, consoleTail: `OLD${'x'.repeat(20000)}NEWEST` });
    assert.ok(!body.includes('OLD'));
    assert.ok(body.includes('NEWEST'));
});

function fakeRouter() {
    const routes = {};
    return {
        routes,
        post: (p, h) => (routes[`POST ${p}`] = h),
        get: (p, h) => (routes[`GET ${p}`] = h),
    };
}

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
}

const ctx = (database, env = { BUG_REPORT_RELAY_URL: 'http://relay.test' }) => ({
    env,
    database,
    logger: { error() {} },
});

const fakeDb = () => {
    const chain = {
        leftJoin: () => chain,
        where: () => chain,
        first: async () => ({ email: 'a@b.ac.uk', role: 'Lab Member' }),
    };
    return () => chain;
};

test('only POST /report is mounted (no recent-issues route)', () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    assert.deepEqual(Object.keys(router.routes), ['POST /report']);
    assert.equal(endpoint.id, 'd1-bug-report');
});

test('POST /report requires a logged-in user', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    const res = fakeRes();
    await router.routes['POST /report']({ accountability: {}, body: base }, res);
    assert.equal(res.statusCode, 401);
});

test('POST /report forwards the built issue to the relay and returns its answer', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, url: 'https://gh/1', number: 1 }), { status: 200 });
    };
    try {
        const res = fakeRes();
        await router.routes['POST /report']({ accountability: { user: 'u1' }, body: base }, res);
        assert.deepEqual(res.body, { ok: true, url: 'https://gh/1', number: 1 });
        assert.equal(calls[0].url, 'http://relay.test/report');
        const sent = JSON.parse(calls[0].init.body);
        assert.equal(sent.title, '[Bug] Plot is blank');
        assert.deepEqual(sent.labels, ['in-app-report', 'starbase-report', 'bug', 'area:starbase']);
        assert.match(sent.body, /a@b\.ac\.uk \(Lab Member\)/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('POST /report takes the reporter from the session, not from the body', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push(init);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
        await router.routes['POST /report'](
            { accountability: { user: 'u1' }, body: { ...base, reporterEmail: 'forged@evil.test', role: 'Administrator' } },
            fakeRes(),
        );
        const sent = JSON.parse(calls[0].body);
        assert.ok(!sent.body.includes('forged@evil.test'));
        assert.match(sent.body, /a@b\.ac\.uk \(Lab Member\)/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('POST /report defaults to the compose relay host when BUG_REPORT_RELAY_URL is unset', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb(), {}));
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
        await router.routes['POST /report']({ accountability: { user: 'u1' }, body: base }, fakeRes());
        assert.equal(calls[0], 'http://bug-report-relay:8211/report');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('POST /report answers a blank title as ok:false without calling the relay', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}'); };
    try {
        const res = fakeRes();
        await router.routes['POST /report']({ accountability: { user: 'u1' }, body: { ...base, title: '' } }, res);
        assert.deepEqual(res.body, { ok: false, reason: 'A title is required.' });
        assert.equal(called, false);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('POST /report reports an unreachable relay as ok:false instead of throwing', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
        const res = fakeRes();
        await router.routes['POST /report']({ accountability: { user: 'u1' }, body: base }, res);
        assert.equal(res.body.ok, false);
        assert.match(res.body.reason, /ECONNREFUSED/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('POST /report reports a relay HTTP error as ok:false', async () => {
    const router = fakeRouter();
    endpoint.handler(router, ctx(fakeDb()));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 502 });
    try {
        const res = fakeRes();
        await router.routes['POST /report']({ accountability: { user: 'u1' }, body: base }, res);
        assert.deepEqual(res.body, { ok: false, reason: 'bug-report relay error (HTTP 502)' });
    } finally {
        globalThis.fetch = realFetch;
    }
});
