// Run with: node --test core/extensions/d1-person-link/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import hook from './index.js';

// the hook with a fake knex whose people insert/update fails with `failWith` (or works)
function run({ failWith = null } = {}) {
  let handler;
  hook({ action: (event, fn) => { if (event === 'users.create') handler = fn; } });
  const db = (table) => {
    assert.equal(table, 'people');
    const q = {
      where: () => q,
      whereNull: () => q,
      whereRaw: () => q,
      limit: () => q,
      select: async () => [],
      first: async () => undefined,
      insert: async () => { if (failWith) throw failWith; },
      update: async () => { if (failWith) throw failWith; },
    };
    return q;
  };
  db.raw = (sql, bindings) => ({ sql, bindings });
  return handler({ key: 'u-1', payload: { email: 'New@Lab.example', first_name: 'New', last_name: 'Person' } }, { database: db });
}

test('creates a person for a new login', async () => {
  await run();
});

test('a foreign key or unique violation means the login was linked elsewhere (or rolled back): quiet', async () => {
  for (const code of ['23503', '23505']) {
    await run({ failWith: Object.assign(new Error('violates'), { code }) });
  }
});

test('any other database error still surfaces', async () => {
  await assert.rejects(run({ failWith: Object.assign(new Error('connection lost'), { code: '08006' }) }), /connection lost/);
});
