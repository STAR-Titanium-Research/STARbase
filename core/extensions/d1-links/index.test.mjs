// Run with: node --test core/extensions/d1-links/index.test.mjs   (CI's lint job runs every core/extensions/*/index.test.mjs)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext, { mount, starbaseUrlFrom } from './index.js';

function call(env, accountability = { user: 'u1' }) {
	let handler;
	mount({ get: (path, fn) => { assert.equal(path, '/'); handler = fn; } }, env);
	const out = { status: 200, headers: {}, body: undefined };
	const res = {
		status(c) { out.status = c; return res; },
		set(k, v) { out.headers[k] = v; return res; },
		json(b) { out.body = b; return res; },
	};
	handler({ accountability }, res);
	return out;
}

test('starbaseUrlFrom: an http(s) address without its trailing slash, else null', () => {
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'https://starbase.tail54eeb6.ts.net/' }), 'https://starbase.tail54eeb6.ts.net');
	assert.equal(starbaseUrlFrom({ STARBASE_URL: '  ' }), null);
	assert.equal(starbaseUrlFrom({}), null);
	assert.equal(starbaseUrlFrom(undefined), null);
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'javascript:alert(1)' }), null);
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'not a url' }), null);
});

test('GET /d1-links tells a signed-in user where STARbase is', () => {
	const out = call({ STARBASE_URL: 'https://starbase.tail54eeb6.ts.net' });
	assert.equal(out.status, 200);
	assert.deepEqual(out.body, { starbaseUrl: 'https://starbase.tail54eeb6.ts.net' });
	assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('unset: null, so the edit frame tells nobody and Data Studio hides its link', () => {
	assert.deepEqual(call({}).body, { starbaseUrl: null });
});

test('not an absolute http(s) address: null, whatever the setting says (a relative path, a script URL)', () => {
	assert.deepEqual(call({ STARBASE_URL: '/starbase' }).body, { starbaseUrl: null });
	assert.deepEqual(call({ STARBASE_URL: 'javascript:alert(1)' }).body, { starbaseUrl: null });
	assert.deepEqual(call({ STARBASE_URL: 'ftp://starbase.example' }).body, { starbaseUrl: null });
	assert.deepEqual(call({ STARBASE_URL: 'http://127.0.0.1:5190' }).body, { starbaseUrl: 'http://127.0.0.1:5190' });
});

test('not signed in: 401', () => {
	assert.equal(call({ STARBASE_URL: 'https://s.example' }, null).status, 401);
	assert.equal(call({ STARBASE_URL: 'https://s.example' }, { user: null }).status, 401);
});

test('mounts at /d1-links', () => {
	assert.equal(ext.id, 'd1-links');
});
