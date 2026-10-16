// Run with: node --test core/extensions/d1-edit-untracked/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import hook, { FALLBACK_PAGE, isEditFramePage } from './index.js';

function mount() {
  const filters = {};
  hook({ filter: (name, fn) => (filters[name] = fn) });
  return filters['users.update'];
}

// db('directus_users').where({ id }).first('last_page') -> the stored row.
function fakeDb(lastPageById) {
  return (table) => ({
    where: (clause) => ({
      first: async () => {
        assert.equal(table, 'directus_users');
        return clause.id in lastPageById ? { last_page: lastPageById[clause.id] } : undefined;
      },
    }),
  });
}

const EDIT = '/d1-edit/physical_samples/1f559dda-3173-4b6a-ad2a-f02d9ed675b9';

test('recognises only the edit-frame module paths', () => {
  assert.ok(isEditFramePage(EDIT));
  assert.ok(isEditFramePage('/d1-edit'));
  assert.ok(isEditFramePage('/d1-edit?x=1'));
  assert.ok(!isEditFramePage('/d1-editor/x'));
  assert.ok(!isEditFramePage('/content/physical_samples'));
  assert.ok(!isEditFramePage(null));
});

test('an edit-frame page keeps the previous last page', async () => {
  const out = await mount()({ last_page: EDIT }, { keys: ['u1'] }, { database: fakeDb({ u1: '/content/projects' }) });
  assert.deepEqual(out, { last_page: '/content/projects' });
});

test('falls back to /content when the previous page was an edit page too, or unknown', async () => {
  const f = mount();
  assert.equal((await f({ last_page: EDIT }, { keys: ['u1'] }, { database: fakeDb({ u1: EDIT }) })).last_page, FALLBACK_PAGE);
  assert.equal((await f({ last_page: EDIT }, { keys: ['u1'] }, { database: fakeDb({ u1: null }) })).last_page, FALLBACK_PAGE);
  assert.equal((await f({ last_page: EDIT }, { keys: ['u1'] }, {})).last_page, FALLBACK_PAGE);
  const failing = () => ({ where: () => ({ first: async () => { throw new Error('boom'); } }) });
  assert.equal((await f({ last_page: EDIT }, { keys: ['u1'] }, { database: failing })).last_page, FALLBACK_PAGE);
});

test('other updates pass through untouched', async () => {
  const f = mount();
  const payload = { last_page: '/content/physical_samples', first_name: 'A' };
  assert.equal(await f(payload, { keys: ['u1'] }, {}), payload);
  const other = { first_name: 'B' };
  assert.equal(await f(other, { keys: ['u1'] }, {}), other);
});

test('other fields in the same payload are kept', async () => {
  const out = await mount()({ last_page: EDIT, theme: 'dark' }, { keys: ['u1'] }, { database: fakeDb({ u1: '/users' }) });
  assert.deepEqual(out, { last_page: '/users', theme: 'dark' });
});
