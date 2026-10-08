// Run with: node --test core/extensions/d1-access-guard/index.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import hook from './index.js';

const RULES = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')).guards;

// An ItemsService stand-in. `canUpdate(collection, id)` decides whether the parent row comes back;
// every construction and read is recorded.
function mount({ canUpdate = () => true, readError = null } = {}) {
  const filters = {};
  const log = { built: [], reads: [] };
  class ItemsService {
    constructor(collection, options) {
      this.collection = collection;
      log.built.push({ collection, options });
    }
    async readByQuery(query) {
      log.reads.push({ collection: this.collection, query });
      if (readError) throw readError;
      const id = query.filter._and[0][query.fields[0]]._eq;
      return canUpdate(this.collection, id) ? [{ [query.fields[0]]: id }] : [];
    }
  }
  hook({ filter: (name, fn) => (filters[name] = fn) }, { services: { ItemsService } });
  return { filters, log };
}

// db(table).whereIn(pk, keys).select(...) -> the rows of `existing`.
// db(table).where(column, id).whereRaw(sql).first(column) -> the row when `table:id` is in `created`
// (the parent was written by this transaction), else undefined. An entry `table:id@N` is a row written
// here whose OCC version is N (N > 1: it existed and was UPDATED here); a plain `table:id` was inserted
// here (version 1). The fake applies the `version = 1` part of the SQL, as Postgres would.
function fakeDb(existing = [], created = []) {
  const calls = [];
  const db = (table) => ({
    whereIn: (column, keys) => ({
      select: async (...columns) => {
        calls.push({ table, column, keys, columns });
        return existing;
      },
    }),
    where: (column, id) => ({
      whereRaw: (sql) => ({
        first: async (selected) => {
          calls.push({ table, column, id, sql, selected });
          const entry = created.find((c) => c === `${table}:${id}` || c.startsWith(`${table}:${id}@`));
          if (!entry) return undefined;
          const version = entry.includes('@') ? Number(entry.split('@')[1]) : 1;
          if (/version\s*=\s*1/.test(sql) && version !== 1) return undefined;
          return { [column]: id };
        },
      }),
    }),
  });
  db.calls = calls;
  return db;
}

const member = { user: 'user-1', admin: false };
const ctx = (overrides = {}) => ({
  database: fakeDb(),
  schema: { collections: { campaign_samples: { primary: 'id' } } },
  accountability: member,
  ...overrides,
});
// A refusal as the guard throws it: a 403 FORBIDDEN carrying the marker and structured details, with
// a user-facing message in plain words. `re` matches "<parent or collection> <id>" of the details
// (which record was refused); the message itself never names tables, ids or ADRs.
const denied = (re) => (err) => {
  assert.equal(err.status, 403);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.extensions.code, 'FORBIDDEN');
  assert.equal(err.extensions.source, 'd1-access-guard');
  assert.ok(['junction', 'owner'].includes(err.extensions.kind), err.extensions.kind);
  assert.match(`${err.extensions.parent ?? err.extensions.collection} ${err.extensions.id}`, re);
  assert.equal(err.extensions.reason, err.message);
  assert.doesNotMatch(err.message, /_|ADR|[0-9a-f]{8}-|\b(s|p|c|t|k|o)\d\b/i, 'the message is plain words');
  return true;
};

test('registers an items.create and an items.update filter', () => {
  assert.deepEqual(Object.keys(mount().filters).sort(), ['items.create', 'items.update']);
});

test('the shipped rules guard exactly the four visibility junctions', () => {
  assert.deepEqual(Object.keys(RULES).sort(), [
    'campaign_samples',
    'project_investigators',
    'sample_co_owners',
    'test_sessions_subject',
  ]);
  assert.deepEqual(RULES.campaign_samples.map((c) => c.parent), ['campaigns', 'physical_samples']);
  assert.deepEqual(RULES.test_sessions_subject.map((c) => [c.field, c.parent, c.key]), [
    ['test_sessions_id', 'test_sessions', 'session_id'],
  ]);
  for (const checks of Object.values(RULES)) {
    for (const c of checks) assert.ok(JSON.stringify(c.filter).includes('$CURRENT_USER'), c.parent);
  }
});

test('sample_co_owners create: allowed when the caller may update the sample', async () => {
  const { filters, log } = mount();
  const payload = { sample_id: 's1', user_id: 'u9' };
  assert.equal(await filters['items.create'](payload, { collection: 'sample_co_owners' }, ctx()), payload);
  assert.equal(log.reads.length, 1);
  const [{ collection, query }] = log.reads;
  assert.equal(collection, 'physical_samples');
  assert.deepEqual(query.fields, ['sample_id']);
  assert.equal(query.limit, 1);
  assert.deepEqual(query.filter._and[0], { sample_id: { _eq: 's1' } });
  const sent = JSON.stringify(query.filter._and[1]);
  assert.ok(sent.includes('user-1'), 'the caller replaces $CURRENT_USER');
  assert.ok(!sent.includes('$CURRENT_USER'));
  assert.ok(sent.includes('co_owners'), "it is the sample's update rule: owner or co-owner");
});

test('the read runs as the caller, inside the request transaction', async () => {
  const { filters, log } = mount();
  const c = ctx();
  await filters['items.create']({ sample_id: 's1' }, { collection: 'sample_co_owners' }, c);
  assert.equal(log.built[0].options.knex, c.database);
  assert.equal(log.built[0].options.schema, c.schema);
  assert.equal(log.built[0].options.accountability, member);
});

test('sample_co_owners create: refused when the caller cannot update the sample (self-grant)', async () => {
  const { filters } = mount({ canUpdate: () => false });
  await assert.rejects(
    filters['items.create']({ sample_id: 's1', user_id: 'user-1' }, { collection: 'sample_co_owners' }, ctx()),
    denied(/physical_samples s1/),
  );
});

test('project_investigators create is checked against the project', async () => {
  const { filters, log } = mount({ canUpdate: (c) => c !== 'projects' });
  await assert.rejects(
    filters['items.create']({ project_id: 'p1', user_id: 'user-1' }, { collection: 'project_investigators' }, ctx()),
    denied(/projects p1/),
  );
  assert.equal(log.reads[0].collection, 'projects');
  assert.ok(JSON.stringify(log.reads[0].query.filter).includes('principal_investigator_person'));
});

test('campaign_samples create needs the campaign AND the sample', async () => {
  const both = mount();
  await both.filters['items.create']({ campaign_id: 'c1', sample_id: 's1' }, { collection: 'campaign_samples' }, ctx());
  assert.deepEqual(both.log.reads.map((r) => r.collection), ['campaigns', 'physical_samples']);

  const noSample = mount({ canUpdate: (c) => c === 'campaigns' });
  await assert.rejects(
    noSample.filters['items.create']({ campaign_id: 'c1', sample_id: 's1' }, { collection: 'campaign_samples' }, ctx()),
    denied(/physical_samples s1/),
  );

  const noCampaign = mount({ canUpdate: (c) => c === 'physical_samples' });
  await assert.rejects(
    noCampaign.filters['items.create']({ campaign_id: 'c1', sample_id: 's1' }, { collection: 'campaign_samples' }, ctx()),
    denied(/campaigns c1/),
  );
});

// A subject row sets test_sessions.sample_id (migration 139), and a sample's owner reads the tests on it.
// Without this guard a member could add their own sample to a colleague's test and read and edit it.
test('test_sessions_subject create is checked against the test (derived sample_id self-grant)', async () => {
  const meta = { collection: 'test_sessions_subject' };
  const payload = { test_sessions_id: 't1', collection: 'physical_samples', item: 'my-sample' };
  const ok = mount();
  assert.equal(await ok.filters['items.create'](payload, meta, ctx()), payload);
  assert.equal(ok.log.reads.length, 1);
  assert.equal(ok.log.reads[0].collection, 'test_sessions');
  assert.deepEqual(ok.log.reads[0].query.filter._and[0], { session_id: { _eq: 't1' } });
  const sent = JSON.stringify(ok.log.reads[0].query.filter._and[1]);
  assert.ok(sent.includes('user-1') && sent.includes('owner_person_id'), "the test's update rule, as the caller");

  const { filters } = mount({ canUpdate: (c) => c !== 'test_sessions' });
  await assert.rejects(filters['items.create'](payload, meta, ctx()), denied(/test_sessions t1/));
});

test('test_sessions_subject update: repointing the test is checked, naming another item is not', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = fakeDb([{ id: 9, test_sessions_id: 't1' }]);
  const meta = { collection: 'test_sessions_subject', keys: [9] };
  await assert.rejects(filters['items.update']({ test_sessions_id: 't2' }, meta, ctx({ database })), denied(/test_sessions t2/));
  // the row already belongs to a test the caller could change; swapping its item grants nothing new
  await filters['items.update']({ item: 'another' }, meta, ctx({ database }));
  await filters['items.update']({ test_sessions_id: 't1' }, meta, ctx({ database }));
  assert.equal(log.reads.length, 1);
});

test('an array payload checks every item', async () => {
  const { filters } = mount({ canUpdate: (_c, id) => id !== 's2' });
  await assert.rejects(
    filters['items.create'](
      [{ sample_id: 's1' }, { sample_id: 's2' }],
      { collection: 'sample_co_owners' },
      ctx(),
    ),
    denied(/s2/),
  );
});

test('admins and internal calls are not checked', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const payload = { sample_id: 's1' };
  const meta = { collection: 'sample_co_owners' };
  await filters['items.create'](payload, meta, ctx({ accountability: { user: 'a', admin: true } }));
  await filters['items.create'](payload, meta, ctx({ accountability: null }));
  await filters['items.create'](payload, meta, ctx({ accountability: { user: null, admin: false } }));
  await filters['items.update']({ sample_id: 's2' }, { ...meta, keys: [1] }, ctx({ accountability: { user: 'a', admin: true } }));
  assert.equal(log.reads.length, 0);
});

test('other collections are left alone', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  for (const collection of ['physical_samples', 'campaigns', 'sample_genealogy', 'session_data_files', undefined]) {
    await filters['items.create']({ sample_id: 's1' }, { collection }, ctx());
    await filters['items.update']({ sample_id: 's1' }, { collection, keys: [1] }, ctx());
  }
  assert.equal(log.reads.length, 0);
});

// ---- a parent created in the same request (nested create) ----------------------------------------
// Creating a new project with investigators, a sample with co-owners or a campaign with samples runs
// the junction filter after the parent insert, in the same transaction. The creator may have named
// someone else as owner or PI, so the parent's update rule need not hold; the row is theirs to build.

test('a parent inserted by this transaction passes without its update rule (project + investigators)', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = fakeDb([], ['projects:p-new']);
  const payload = { project_id: 'p-new', user_id: 'u9' };
  assert.equal(
    await filters['items.create'](payload, { collection: 'project_investigators' }, ctx({ database })),
    payload,
  );
  assert.equal(log.reads.length, 1, 'the update rule is still tried first');
  assert.equal(database.calls.length, 1);
  const [call] = database.calls;
  assert.deepEqual([call.table, call.column, call.id, call.selected], ['projects', 'project_id', 'p-new', 'project_id']);
  assert.match(call.sql, /xmin\s*=\s*pg_current_xact_id\(\)::xid\s+AND\s+version\s*=\s*1/);
});

test('a pre-existing parent merely UPDATED in this transaction is not "created here" (xmin alone would match)', async () => {
  const { filters } = mount({ canUpdate: () => false });
  // Same xmin as ours, but OCC version 2: it existed before and an FK action or trigger updated it.
  const database = fakeDb([], ['projects:p-old@2', 'physical_samples:s-old@5', 'test_sessions:t-old@2', 'campaigns:c-old@3']);
  const cases = [
    ['project_investigators', { project_id: 'p-old', user_id: 'user-1' }, /projects p-old/],
    ['sample_co_owners', { sample_id: 's-old', user_id: 'user-1' }, /physical_samples s-old/],
    ['test_sessions_subject', { test_sessions_id: 't-old', collection: 'physical_samples', item: 'x' }, /test_sessions t-old/],
    ['campaign_samples', { campaign_id: 'c-old', sample_id: 's1' }, /campaigns c-old/],
  ];
  for (const [collection, payload, re] of cases) {
    await assert.rejects(filters['items.create'](payload, { collection }, ctx({ database })), denied(re), collection);
  }
});

test('a parent that merely exists is not "created here": the update rule decides (self-grant stays closed)', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const database = fakeDb([], ['projects:other']);
  await assert.rejects(
    filters['items.create']({ project_id: 'p1', user_id: 'user-1' }, { collection: 'project_investigators' }, ctx({ database })),
    denied(/projects p1/),
  );
  assert.equal(database.calls.length, 1, 'the transaction check ran and found nothing');
});

test('a parent the caller may update does not need the transaction check', async () => {
  const { filters } = mount();
  const database = fakeDb();
  await filters['items.create']({ sample_id: 's1', user_id: 'u9' }, { collection: 'sample_co_owners' }, ctx({ database }));
  assert.equal(database.calls.length, 0);
});

test('a new sample with co-owners and a new test with subjects pass', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const database = fakeDb([], ['physical_samples:s-new', 'test_sessions:t-new']);
  await filters['items.create']({ sample_id: 's-new', user_id: 'u9' }, { collection: 'sample_co_owners' }, ctx({ database }));
  await filters['items.create'](
    { test_sessions_id: 't-new', collection: 'physical_samples', item: 'x' },
    { collection: 'test_sessions_subject' },
    ctx({ database }),
  );
  await assert.rejects(
    filters['items.create']({ test_sessions_id: 't-old', collection: 'physical_samples', item: 'x' }, { collection: 'test_sessions_subject' }, ctx({ database })),
    denied(/test_sessions t-old/),
  );
});

test('campaign_samples: a new campaign still needs the sample update rule, unless the sample is new too', async () => {
  const meta = { collection: 'campaign_samples' };
  // new campaign (not the caller's to update), someone else's existing sample: refused on the sample
  const rule = mount({ canUpdate: () => false });
  await assert.rejects(
    rule.filters['items.create']({ campaign_id: 'c-new', sample_id: 's-old' }, meta, ctx({ database: fakeDb([], ['campaigns:c-new']) })),
    denied(/physical_samples s-old/),
  );
  // new campaign + a sample the caller may update: allowed
  const mine = mount({ canUpdate: (c) => c === 'physical_samples' });
  await mine.filters['items.create']({ campaign_id: 'c-new', sample_id: 's-mine' }, meta, ctx({ database: fakeDb([], ['campaigns:c-new']) }));
  // new campaign + new sample (both created in the request): allowed
  const both = mount({ canUpdate: () => false });
  await both.filters['items.create'](
    { campaign_id: 'c-new', sample_id: 's-new' },
    meta,
    ctx({ database: fakeDb([], ['campaigns:c-new', 'physical_samples:s-new']) }),
  );
  // an existing campaign the caller does not own with a new sample: refused on the campaign
  await assert.rejects(
    both.filters['items.create']({ campaign_id: 'c-old', sample_id: 's-new' }, meta, ctx({ database: fakeDb([], ['physical_samples:s-new']) })),
    denied(/campaigns c-old/),
  );
});

test('a repoint to a parent created in this transaction passes too', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const database = fakeDb([{ id: 5, sample_id: 's1' }], ['physical_samples:s-new']);
  await filters['items.update']({ sample_id: 's-new' }, { collection: 'sample_co_owners', keys: [5] }, ctx({ database }));
});

test('no parent key, or a brand-new nested parent, passes (the database or the creator decides)', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  await filters['items.create']({ user_id: 'u9' }, { collection: 'sample_co_owners' }, ctx());
  await filters['items.create']({ sample_id: null, user_id: 'u9' }, { collection: 'sample_co_owners' }, ctx());
  await filters['items.create']({ sample_id: { sample_code: 'NEW-1' } }, { collection: 'sample_co_owners' }, ctx());
  assert.equal(log.reads.length, 0);
});

test('a nested parent object that carries a key is checked by that key', async () => {
  const { filters } = mount({ canUpdate: () => false });
  await assert.rejects(
    filters['items.create']({ sample_id: { sample_id: 's7' } }, { collection: 'sample_co_owners' }, ctx()),
    denied(/s7/),
  );
});

test('a 403 from the read means "cannot update"; any other error is rethrown', async () => {
  const forbiddenRead = Object.assign(new Error('nope'), { code: 'FORBIDDEN', status: 403 });
  await assert.rejects(
    mount({ readError: forbiddenRead }).filters['items.create']({ sample_id: 's1' }, { collection: 'sample_co_owners' }, ctx()),
    denied(/s1/),
  );
  const boom = new Error('connection lost');
  await assert.rejects(
    mount({ readError: boom }).filters['items.create']({ sample_id: 's1' }, { collection: 'sample_co_owners' }, ctx()),
    (err) => err === boom,
  );
});

test('update: repointing the sample key is checked, and refused without the right', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = fakeDb([{ id: 5, sample_id: 's1' }]);
  await assert.rejects(
    filters['items.update']({ sample_id: 's2' }, { collection: 'sample_co_owners', keys: [5] }, ctx({ database })),
    denied(/s2/),
  );
  assert.deepEqual(database.calls[0], { table: 'sample_co_owners', column: 'id', keys: [5], columns: ['id', 'sample_id'] });
  assert.equal(log.reads.length, 1);
});

test('update: a key sent with its current value is not a change', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's1' }]);
  const payload = { campaign_id: 'c1', sample_id: 's1', note: 'x' };
  assert.equal(
    await filters['items.update'](payload, { collection: 'campaign_samples', keys: [5] }, ctx({ database })),
    payload,
  );
  assert.equal(log.reads.length, 0);
});

// campaign_samples grants through the PAIR of keys (campaign owner AND sample editor), so moving
// either key re-checks both on the row as it will be after the update.
test('update: repointing the campaign key of a campaign_samples row also needs the sample', async () => {
  const meta = { collection: 'campaign_samples', keys: [5] };
  const database = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's1' }]);
  // owns the new campaign, may not edit the row's sample: refused (the old gap)
  const noSample = mount({ canUpdate: (c) => c === 'campaigns' });
  await assert.rejects(
    noSample.filters['items.update']({ campaign_id: 'c2' }, meta, ctx({ database })),
    denied(/physical_samples s1/),
  );
  assert.deepEqual(noSample.log.reads.map((r) => [r.collection, r.query.filter._and[0]]), [
    ['campaigns', { campaign_id: { _eq: 'c2' } }],
    ['physical_samples', { sample_id: { _eq: 's1' } }],
  ]);
  // owns the new campaign and may edit the sample: allowed
  const both = mount();
  await both.filters['items.update']({ campaign_id: 'c2' }, meta, ctx({ database }));
  assert.deepEqual(both.log.reads.map((r) => r.collection), ['campaigns', 'physical_samples']);
});

test('update: repointing the sample key of a campaign_samples row also needs the campaign', async () => {
  const meta = { collection: 'campaign_samples', keys: [5] };
  const database = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's1' }]);
  // may edit the new sample, does not own the row's campaign: refused
  const noCampaign = mount({ canUpdate: (c) => c === 'physical_samples' });
  await assert.rejects(
    noCampaign.filters['items.update']({ sample_id: 's2' }, meta, ctx({ database })),
    denied(/campaigns c1/),
  );
  const both = mount();
  await both.filters['items.update']({ sample_id: 's2' }, meta, ctx({ database }));
  assert.deepEqual(both.log.reads.map((r) => r.query.filter._and[0]), [
    { campaign_id: { _eq: 'c1' } },
    { sample_id: { _eq: 's2' } },
  ]);
});

test('update: repointing both keys of a campaign_samples row checks the new pair', async () => {
  const database = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's1' }]);
  const { filters, log } = mount({ canUpdate: (_c, id) => id !== 's2' });
  await assert.rejects(
    filters['items.update']({ campaign_id: 'c2', sample_id: 's2' }, { collection: 'campaign_samples', keys: [5] }, ctx({ database })),
    denied(/s2/),
  );
  assert.deepEqual(log.reads.map((r) => r.query.filter._and[0]), [
    { campaign_id: { _eq: 'c2' } },
    { sample_id: { _eq: 's2' } },
  ]);
});

test('update: a batch repoint checks the merged row of every key', async () => {
  const database = fakeDb([
    { id: 5, campaign_id: 'c1', sample_id: 's1' },
    { id: 6, campaign_id: 'c1', sample_id: 's7' },
  ]);
  const { filters } = mount({ canUpdate: (c, id) => c === 'campaigns' || id !== 's7' });
  await assert.rejects(
    filters['items.update']({ campaign_id: 'c2' }, { collection: 'campaign_samples', keys: [5, 6] }, ctx({ database })),
    denied(/s7/),
  );
});

test('update: the junction row read selects every guarded column', async () => {
  const database = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's1' }]);
  const { filters } = mount();
  await filters['items.update']({ campaign_id: 'c2' }, { collection: 'campaign_samples', keys: [5] }, ctx({ database }));
  assert.deepEqual(database.calls[0], {
    table: 'campaign_samples',
    column: 'id',
    keys: [5],
    columns: ['id', 'campaign_id', 'sample_id'],
  });
});

test('update: a campaign_samples row sent with both keys unchanged checks nothing', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's1' }]);
  await filters['items.update']({ campaign_id: 'c1', sample_id: 's1' }, { collection: 'campaign_samples', keys: [5] }, ctx({ database }));
  assert.equal(log.reads.length, 0);
});

test('update: changing the person (user_id) or other columns checks nothing', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = fakeDb([{ id: 5, sample_id: 's1' }]);
  await filters['items.update']({ user_id: 'u9' }, { collection: 'sample_co_owners', keys: [5] }, ctx({ database }));
  assert.equal(log.reads.length, 0);
  assert.equal(database.calls.length, 0);
});

test('update: clearing a parent key grants nothing', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  await filters['items.update']({ sample_id: null }, { collection: 'sample_co_owners', keys: [5] }, ctx({ database: fakeDb([{ id: 5, sample_id: 's1' }]) }));
  assert.equal(log.reads.length, 0);
});

// ---- owner guard: changing the owner column needs the record's delete rule ----------------------

// db(table).whereIn(pk, keys).select(...) -> the rows of `existing` for those keys.
function ownerDb(existing) {
  const calls = [];
  const db = (table) => ({
    whereIn: (column, keys) => ({
      select: async (...columns) => {
        calls.push({ table, column, keys, columns });
        return existing.filter((row) => keys.includes(row[column]));
      },
    }),
  });
  db.calls = calls;
  return db;
}

test('the shipped rules guard the owner column where update is wider than delete', () => {
  const guards = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')).ownerGuards;
  assert.deepEqual(Object.keys(guards).sort(), ['manufacturing_operations', 'physical_samples', 'test_sessions']);
  for (const [collection, g] of Object.entries(guards)) {
    assert.equal(g.field, 'owner_person_id', collection);
    assert.equal(g.valueKey, 'person_id', collection);
    // the delete rule: the owner only, not the co-owners the update rule also lets in
    assert.ok(JSON.stringify(g.filter).includes('$CURRENT_USER'), collection);
    assert.ok(!JSON.stringify(g.filter).includes('co_owners'), collection);
  }
});

test('owner change: a co-owner (who cannot delete) is refused', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p-owner' }]);
  await assert.rejects(
    filters['items.update']({ owner_person_id: 'p-me' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    denied(/physical_samples s1/),
  );
  assert.deepEqual(database.calls, [
    { table: 'physical_samples', column: 'sample_id', keys: ['s1'], columns: ['sample_id', 'owner_person_id'] },
  ]);
  // the check is the delete rule (owner only), run as the caller on the sample itself
  const [{ collection, query }] = log.reads;
  assert.equal(collection, 'physical_samples');
  assert.deepEqual(query.filter._and[0], { sample_id: { _eq: 's1' } });
  const sent = JSON.stringify(query.filter._and[1]);
  assert.ok(sent.includes('user-1') && !sent.includes('$CURRENT_USER') && !sent.includes('co_owners'));
});

test('owner change: the owner handing over is allowed', async () => {
  const { filters, log } = mount({ canUpdate: () => true });
  const payload = { owner_person_id: 'p-new', notes: 'x' };
  const database = ownerDb([{ operation_id: 'o1', owner_person_id: 'p-me' }]);
  assert.equal(
    await filters['items.update'](payload, { collection: 'manufacturing_operations', keys: ['o1'] }, ctx({ database })),
    payload,
  );
  assert.equal(log.reads.length, 1);
  assert.equal(log.reads[0].collection, 'manufacturing_operations');
});

test('owner change: each guarded collection is checked against its own key', async () => {
  for (const [collection, pk] of [['physical_samples', 'sample_id'], ['manufacturing_operations', 'operation_id'], ['test_sessions', 'session_id']]) {
    const { filters, log } = mount({ canUpdate: () => false });
    const database = ownerDb([{ [pk]: 'k1', owner_person_id: 'p1' }]);
    await assert.rejects(
      filters['items.update']({ owner_person_id: 'p2' }, { collection, keys: ['k1'] }, ctx({ database })),
      denied(new RegExp(`${collection} k1`)),
    );
    assert.deepEqual(log.reads[0].query.fields, [pk]);
  }
});

test('owner change: admins and internal calls are not checked', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1' }]);
  const meta = { collection: 'physical_samples', keys: ['s1'] };
  await filters['items.update']({ owner_person_id: 'p2' }, meta, ctx({ database, accountability: { user: 'a', admin: true } }));
  await filters['items.update']({ owner_person_id: 'p2' }, meta, ctx({ database, accountability: null }));
  await filters['items.update']({ owner_person_id: 'p2' }, meta, ctx({ database, accountability: { user: null, admin: false } }));
  assert.equal(log.reads.length, 0);
  assert.equal(database.calls.length, 0);
});

test('owner change: a payload without the owner field is untouched', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1' }]);
  const payload = { sample_code: 'X-2', project_id: 'p9' };
  assert.equal(
    await filters['items.update'](payload, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    payload,
  );
  assert.equal(log.reads.length, 0);
  assert.equal(database.calls.length, 0);
});

test('owner change: sending the current owner back (a form save) is not a change', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1' }]);
  const payload = { owner_person_id: 'p1', notes: 'x' };
  await filters['items.update'](payload, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database }));
  await filters['items.update']({ owner_person_id: { person_id: 'p1' } }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database }));
  assert.equal(log.reads.length, 0);
});

test('owner change: clearing the owner is a change; clearing an empty owner is not', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  await assert.rejects(
    filters['items.update'](
      { owner_person_id: null },
      { collection: 'test_sessions', keys: ['t1'] },
      ctx({ database: ownerDb([{ session_id: 't1', owner_person_id: 'p1' }]) }),
    ),
    denied(/test_sessions t1/),
  );
  await filters['items.update'](
    { owner_person_id: null },
    { collection: 'test_sessions', keys: ['t2'] },
    ctx({ database: ownerDb([{ session_id: 't2', owner_person_id: null }]) }),
  );
  assert.equal(log.reads.length, 1);
});

test('owner change: setting an owner on an unowned record needs the delete rule too', async () => {
  const { filters } = mount({ canUpdate: () => false });
  await assert.rejects(
    filters['items.update'](
      { owner_person_id: 'p-me' },
      { collection: 'physical_samples', keys: ['s1'] },
      ctx({ database: ownerDb([{ sample_id: 's1', owner_person_id: null }]) }),
    ),
    denied(/s1/),
  );
});

test('owner change: a nested new person (no key) is a change', async () => {
  const { filters } = mount({ canUpdate: () => false });
  await assert.rejects(
    filters['items.update'](
      { owner_person_id: { full_name: 'New Person' } },
      { collection: 'physical_samples', keys: ['s1'] },
      ctx({ database: ownerDb([{ sample_id: 's1', owner_person_id: 'p1' }]) }),
    ),
    denied(/s1/),
  );
});

test('owner change: a batch update is checked per key, and one refused key refuses the batch', async () => {
  const { filters, log } = mount({ canUpdate: (_c, id) => id !== 's2' });
  const database = ownerDb([
    { sample_id: 's1', owner_person_id: 'p-me' },
    { sample_id: 's2', owner_person_id: 'p-other' },
    { sample_id: 's3', owner_person_id: 'p-me' },
  ]);
  await assert.rejects(
    filters['items.update']({ owner_person_id: 'p-new' }, { collection: 'physical_samples', keys: ['s1', 's2', 's3'] }, ctx({ database })),
    denied(/s2/),
  );
  assert.deepEqual(log.reads.map((r) => r.query.filter._and[0].sample_id._eq), ['s1', 's2']);
  assert.deepEqual(database.calls[0].keys, ['s1', 's2', 's3']);

  const ok = mount({ canUpdate: () => true });
  await ok.filters['items.update']({ owner_person_id: 'p-new' }, { collection: 'physical_samples', keys: ['s1', 's3'] }, ctx({ database }));
  assert.equal(ok.log.reads.length, 2);
});

test('owner change: only the keys whose owner actually changes are checked', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([
    { sample_id: 's1', owner_person_id: 'p-new' },
    { sample_id: 's2', owner_person_id: 'p-new' },
  ]);
  await filters['items.update']({ owner_person_id: 'p-new' }, { collection: 'physical_samples', keys: ['s1', 's2'] }, ctx({ database }));
  assert.equal(log.reads.length, 0);
});

test('owner change: a 403 from the read means "not the owner"; other errors are rethrown', async () => {
  const forbiddenRead = Object.assign(new Error('nope'), { code: 'FORBIDDEN', status: 403 });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1' }]);
  await assert.rejects(
    mount({ readError: forbiddenRead }).filters['items.update']({ owner_person_id: 'p2' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    denied(/s1/),
  );
  const boom = new Error('connection lost');
  await assert.rejects(
    mount({ readError: boom }).filters['items.update']({ owner_person_id: 'p2' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    (err) => err === boom,
  );
});

test('owner change: collections without an owner guard, and creates, are left alone', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ id: 1, owner_person_id: 'p1' }]);
  for (const collection of ['campaigns', 'projects', 'etchants', 'sample_co_owners']) {
    await filters['items.update']({ owner_person_id: 'p2' }, { collection, keys: [1] }, ctx({ database }));
  }
  await filters['items.create']({ owner_person_id: 'p2' }, { collection: 'physical_samples' }, ctx({ database }));
  assert.equal(log.reads.length, 0);
  assert.equal(database.calls.length, 0);
});

// ---- what the person sees --------------------------------------------------------------------------

const refusal = (promise) => promise.then(() => assert.fail('expected a refusal'), (err) => err);

test('refusal texts and details, by what was refused', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const create = (collection, payload) => refusal(filters['items.create'](payload, { collection }, ctx()));
  const cases = [
    ['sample_co_owners', { sample_id: 's1', user_id: 'u' }, 'You can only add this to a sample you own or co-own.', 'physical_samples'],
    ['campaign_samples', { campaign_id: 'c1', sample_id: 's1' }, "Only the campaign's owner can add samples to it.", 'campaigns'],
    ['project_investigators', { project_id: 'p1', user_id: 'u' }, "Only the project's principal investigator can add investigators to it.", 'projects'],
    ['test_sessions_subject', { test_sessions_id: 't1', collection: 'physical_samples', item: 'x' }, 'You can only change the samples of a test you own, or of a test on a sample you own or co-own.', 'test_sessions'],
  ];
  for (const [collection, payload, message, parent] of cases) {
    const err = await create(collection, payload);
    assert.equal(err.message, message);
    assert.equal(err.name, 'DirectusError');
    assert.deepEqual(
      { ...err.extensions, id: undefined },
      { code: 'FORBIDDEN', reason: message, source: 'd1-access-guard', kind: 'junction', collection, parent, id: undefined },
    );
  }
});

test('refusal text of an owner change, by record', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const nouns = { physical_samples: ['sample_id', 'sample'], manufacturing_operations: ['operation_id', 'operation'], test_sessions: ['session_id', 'test'] };
  for (const [collection, [pk, noun]] of Object.entries(nouns)) {
    const database = ownerDb([{ [pk]: 'k1', owner_person_id: 'p1' }]);
    const err = await refusal(
      filters['items.update']({ owner_person_id: 'p2' }, { collection, keys: ['k1'] }, ctx({ database })),
    );
    assert.equal(err.message, `Only the ${noun}'s owner can hand it to someone else.`);
    assert.deepEqual(err.extensions, {
      code: 'FORBIDDEN', reason: err.message, source: 'd1-access-guard', kind: 'owner', collection, id: 'k1',
    });
  }
});
