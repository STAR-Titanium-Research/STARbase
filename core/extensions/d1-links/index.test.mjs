// Run with: node --test core/extensions/d1-links/index.test.mjs   (CI's lint job runs every core/extensions/*/index.test.mjs)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ext, { mount, starbaseUrlFrom, goTarget, RECORD_PAGES } from './index.js';

// A fake express router: collects every GET handler by its path (string or RegExp source).
function routes(env) {
	const r = {};
	mount({ get: (path, fn) => { r[path instanceof RegExp ? path.source : path] = fn; } }, env);
	return r;
}
function run(handler, req) {
	const out = { status: 200, headers: {}, body: undefined, location: undefined, type: undefined };
	const res = {
		status(c) { out.status = c; return res; },
		set(k, v) { out.headers[k] = v; return res; },
		json(b) { out.body = b; return res; },
		type(t) { out.type = t; return res; },
		send(b) { out.body = b; return res; },
		redirect(a, b) { if (b === undefined) { out.location = a; } else { out.status = a; out.location = b; } return res; },
	};
	handler({ accountability: null, params: {}, originalUrl: '/d1-links/go', query: {}, ...req }, res);
	return out;
}
// GET /d1-links (the signed-in JSON answer), as a signed-in user unless told otherwise.
const info = (env, accountability = { user: 'u1' }) => run(routes(env)['/'], { accountability });
const STAR = { STARBASE_URL: 'https://starbase.example.org/', PUBLIC_URL: 'https://d1.example.org' };
const P = '^\\/go\\/p\\/(.*)$';

test('starbaseUrlFrom: an http(s) address without its trailing slash, else null', () => {
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'https://starbase.tail54eeb6.ts.net/' }), 'https://starbase.tail54eeb6.ts.net');
	assert.equal(starbaseUrlFrom({ STARBASE_URL: '  ' }), null);
	assert.equal(starbaseUrlFrom({}), null);
	assert.equal(starbaseUrlFrom(undefined), null);
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'javascript:alert(1)' }), null);
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'not a url' }), null);
});

test('GET /d1-links tells a signed-in user where STARbase is', () => {
	const out = info({ STARBASE_URL: 'https://starbase.tail54eeb6.ts.net' });
	assert.equal(out.status, 200);
	assert.deepEqual(out.body, { starbaseUrl: 'https://starbase.tail54eeb6.ts.net' });
	assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('unset: null, so the edit frame tells nobody and Data Studio hides its link', () => {
	assert.deepEqual(info({}).body, { starbaseUrl: null });
});

test('not an absolute http(s) address: null, whatever the setting says (a relative path, a script URL)', () => {
	assert.deepEqual(info({ STARBASE_URL: '/starbase' }).body, { starbaseUrl: null });
	assert.deepEqual(info({ STARBASE_URL: 'javascript:alert(1)' }).body, { starbaseUrl: null });
	assert.deepEqual(info({ STARBASE_URL: 'ftp://starbase.example' }).body, { starbaseUrl: null });
	assert.deepEqual(info({ STARBASE_URL: 'http://127.0.0.1:5190' }).body, { starbaseUrl: 'http://127.0.0.1:5190' });
});

test('not signed in: 401', () => {
	assert.equal(info({ STARBASE_URL: 'https://s.example' }, null).status, 401);
	assert.equal(info({ STARBASE_URL: 'https://s.example' }, { user: null }).status, 401);
});

test('mounts at /d1-links', () => {
	assert.equal(ext.id, 'd1-links');
});

test('RECORD_PAGES matches RECORD_PAGES in the kit (packages/d1-ui/src/recordRoute.ts)', () => {
	const src = readFileSync(new URL('../../../packages/d1-ui/src/recordRoute.ts', import.meta.url), 'utf8');
	const body = /const RECORD_PAGES[^=]*=\s*\{([^}]*)\}/.exec(src);
	assert.ok(body);
	const kit = {};
	for (const m of body[1].matchAll(/(\w+)\s*:\s*'\/home\/([^']+)'/g)) kit[m[1]] = m[2];
	assert.deepEqual(RECORD_PAGES, kit);
});

test('GET /go: STARbase Home, public, no-store', () => {
	const out = run(routes(STAR)['/go'], {});
	assert.equal(out.status, 302);
	assert.equal(out.location, 'https://starbase.example.org/');
	assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('GET /go/r: a record with a STARbase page opens there, id encoded', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	assert.equal(run(h, { params: { collection: 'physical_samples', id: 'a/b c' } }).location, 'https://starbase.example.org/samples/a%2Fb%20c');
	assert.equal(run(h, { params: { collection: 'projects', id: 'p1' } }).location, 'https://starbase.example.org/projects/p1');
});

test('GET /go/r: any other collection opens its Data Studio form on PUBLIC_URL', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	assert.equal(run(h, { params: { collection: 'equipment', id: 'e1' } }).location, 'https://d1.example.org/admin/content/equipment/e1');
});

test('GET /go/r: an Object.prototype name is no STARbase page (opens its Data Studio form)', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	// 'constructor' is the one all-lowercase Object.prototype name (the others fail the collection pattern: 400).
	assert.equal(run(h, { params: { collection: 'constructor', id: '1' } }).location, 'https://d1.example.org/admin/content/constructor/1');
	assert.equal(run(h, { params: { collection: 'toString', id: '1' } }).status, 400);
});

test('GET /go/r: a bad collection is 400', () => {
	const h = routes(STAR)['/go/r/:collection/:id'];
	for (const c of ['Physical', '1abc', 'a-b', '../x', '']) assert.equal(run(h, { params: { collection: c, id: '1' } }).status, 400, c);
});

test('GET /go/p: a STARbase page, query kept as sent', () => {
	const h = routes(STAR)[P];
	const out = run(h, { originalUrl: '/d1-links/go/p/plot/force?operation=9&x=a%20b' });
	assert.equal(out.status, 302);
	assert.equal(out.location, 'https://starbase.example.org/plot/force?operation=9&x=a%20b');
	assert.equal(run(h, { originalUrl: '/d1-links/go/p/labels' }).location, 'https://starbase.example.org/labels');
	// The raw path is split before decoding, so an encoded slash stays inside its segment.
	assert.equal(run(h, { originalUrl: '/d1-links/go/p/samples/a%2Fb' }).location, 'https://starbase.example.org/samples/a%2Fb');
});

test('GET /go/p: never leaves STARbase (.., //, backslash, scheme, empty segment) → 400', () => {
	const h = routes(STAR)[P];
	for (const bad of ['../x', 'a/../../x', '..', '.', '%2e%2e/x', 'a//b', '/evil.example', 'a\\b', 'a%5Cb', 'https:/x', 'javascript:alert(1)', 'a/', '%E0%A4%A']) {
		const out = run(h, { originalUrl: '/d1-links/go/p/' + bad });
		assert.equal(out.status, 400, bad);
		assert.equal(out.location, undefined, bad);
	}
});

test('STARBASE_URL unset or not http(s): every /go route answers 503 with plain text', () => {
	for (const env of [{}, { STARBASE_URL: 'javascript:alert(1)' }, { STARBASE_URL: '/x' }]) {
		const r = routes(env);
		for (const [h, req] of [[r['/go'], {}], [r['/go/r/:collection/:id'], { params: { collection: 'projects', id: '1' } }], [r[P], { originalUrl: '/d1-links/go/p/labels' }]]) {
			const out = run(h, req);
			assert.equal(out.status, 503);
			assert.equal(out.type, 'text/plain');
			assert.match(out.body, /STARbase address is not configured/);
		}
	}
});

test('goTarget never builds a location off STARbase or PUBLIC_URL', () => {
	const t = goTarget(STAR, 'p', ['plot', 'force'], '?operation=1');
	assert.equal(new URL(t.location).origin, 'https://starbase.example.org');
});
