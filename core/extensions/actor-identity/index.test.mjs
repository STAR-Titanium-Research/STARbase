// Run with: node --test core/extensions/actor-identity/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import hook from './index.js';

function mount() {
  const filters = {};
  const warnings = [];
  hook({ filter: (name, fn) => (filters[name] = fn) }, { logger: { warn: (m) => warnings.push(m) } });
  return { filters, warnings };
}

function fakeDb(isTransaction) {
  const calls = [];
  return { isTransaction, calls, raw: async (sql, args) => calls.push([sql, args]) };
}

test('sets the GUC with is_local = true on a transaction and returns the payload unchanged', async () => {
  const { filters } = mount();
  const db = fakeDb(true);
  const payload = { a: 1 };
  const out = await filters['items.update'](payload, {}, { database: db, accountability: { user: 'u-1' } });
  assert.equal(out, payload);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0][0], /set_config\('d1\.actor_identity', \?, true\)/);
  assert.deepEqual(db.calls[0][1], ['u-1']);
});

test('unauthenticated writes are attributed to "public"', async () => {
  const { filters } = mount();
  const db = fakeDb(true);
  await filters['items.create']({}, {}, { database: db, accountability: null });
  assert.deepEqual(db.calls[0][1], ['public']);
});

test('on a connection pool it does not pretend to set the actor, and warns once', async () => {
  const { filters, warnings } = mount();
  const db = fakeDb(false);
  const payload = {};
  assert.equal(await filters['items.delete'](payload, {}, { database: db, accountability: { user: 'u-1' } }), payload);
  await filters['items.update'](payload, {}, { database: db, accountability: { user: 'u-1' } });
  assert.equal(db.calls.length, 0);
  assert.equal(warnings.length, 1);
});

test('registers create, update and delete filters', () => {
  const { filters } = mount();
  assert.deepEqual(Object.keys(filters).sort(), ['items.create', 'items.delete', 'items.update']);
});
