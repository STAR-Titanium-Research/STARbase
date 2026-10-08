// Run with: node --test core/extensions/campaign-inherit/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import defaultOwner from '../d1-default-owner/index.js';
import inherit from './index.js';

// A knex stand-in for the three tables the hooks read.
//   db('campaigns' | 'projects').where(col, id).select(...).first()  -> the row
//   db('people').where('user_id', id).first('person_id')              -> the person
function fakeDb({ campaigns = {}, projects = {}, people = {} } = {}) {
  const tables = {
    campaigns: (id) => campaigns[id],
    projects: (id) => projects[id],
    people: (id) => people[id],
  };
  return (table) => ({
    where: (_column, value) => {
      const chain = { select: () => chain, first: async () => tables[table](value) };
      return chain;
    },
  });
}

// Directus loads a folder's hooks alphabetically; run the filters in that order, as it does.
function loadInOrder(hooks) {
  const filters = [];
  for (const [, hook] of Object.entries(hooks).sort(([a], [b]) => a.localeCompare(b))) {
    hook({ filter: (name, fn) => name === 'items.create' && filters.push(fn) });
  }
  return async (payload, collection, context) => {
    for (const fn of filters) payload = await fn(payload, { collection }, context);
    return payload;
  };
}

const run = loadInOrder({ 'campaign-inherit': inherit, 'd1-default-owner': defaultOwner });

const db = fakeDb({
  campaigns: { c1: { project_id: 'p1', owner_person_id: 'person-owner', default_equipment_id: 'eq1', default_material_id: 'm1' } },
  projects: { p1: { principal_investigator_person: 'person-pi' } },
  people: { creator: { person_id: 'person-creator' } },
});
const ctx = { database: db, accountability: { user: 'creator' } };

test('a campaign under a project is owned by its creator, not the project PI', async () => {
  const campaign = await run({ project_id: 'p1' }, 'campaigns', ctx);
  assert.equal(campaign.owner_person_id, 'person-creator');
});

test('an operation in a campaign is owned by its creator, not the campaign owner', async () => {
  const op = await run({ campaign_id: 'c1' }, 'manufacturing_operations', ctx);
  assert.equal(op.owner_person_id, 'person-creator');
  // the other defaults still come from the campaign
  assert.equal(op.project_id, 'p1');
  assert.equal(op.equipment_id, 'eq1');
  assert.equal(op.material_id, 'm1');
});

test('a test in a campaign is owned by its creator and gets project and equipment but no material', async () => {
  const session = await run({ campaign_id: 'c1' }, 'test_sessions', ctx);
  assert.equal(session.owner_person_id, 'person-creator');
  assert.equal(session.project_id, 'p1');
  assert.equal(session.equipment_id, 'eq1');
  assert.ok(!('material_id' in session));
});

test('an owner named in the payload is kept, and so are explicit project and equipment', async () => {
  const op = await run(
    { campaign_id: 'c1', owner_person_id: 'person-chosen', project_id: 'p9', equipment_id: 'eq9' },
    'manufacturing_operations',
    ctx,
  );
  assert.deepEqual(
    [op.owner_person_id, op.project_id, op.equipment_id],
    ['person-chosen', 'p9', 'eq9'],
  );
  const campaign = await run({ project_id: 'p1', owner_person_id: 'person-chosen' }, 'campaigns', ctx);
  assert.equal(campaign.owner_person_id, 'person-chosen');
});

test('campaign-inherit alone never writes an owner', async () => {
  const filters = [];
  inherit({ filter: (_name, fn) => filters.push(fn) });
  const campaign = await filters[0]({ project_id: 'p1' }, { collection: 'campaigns' }, ctx);
  const op = await filters[0]({ campaign_id: 'c1' }, { collection: 'manufacturing_operations' }, ctx);
  assert.ok(!('owner_person_id' in campaign));
  assert.ok(!('owner_person_id' in op));
});

test('a user with no People row leaves the owner blank (as before)', async () => {
  const noPerson = { database: db, accountability: { user: 'stranger' } };
  const op = await run({ campaign_id: 'c1' }, 'manufacturing_operations', noPerson);
  assert.ok(!('owner_person_id' in op) || op.owner_person_id == null);
});
