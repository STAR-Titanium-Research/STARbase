// Run with: node --test core/extensions/d1-access-guard/index.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import hook, { RESTRICT_ADMIN_ONLY } from './index.js';

// Until A1b a non-admin cannot change `restricted` at all (RESTRICT_ADMIN_ONLY). Most tests below exercise the owner-only logic that stays underneath
// it for A1b, so the switch is opened for the whole file; the "until A1b" tests close it again around their own calls.
process.env.D1_A1B_RESTRICT_OPEN = 'true';
async function untilA1b(work) {
  delete process.env.D1_A1B_RESTRICT_OPEN;
  try {
    return await work();
  } finally {
    process.env.D1_A1B_RESTRICT_OPEN = 'true';
  }
}

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
      const field = query.fields[0];
      const cond = query.filter._and[0][field];
      if (cond._in) return cond._in.filter((id) => canUpdate(this.collection, id, query)).map((id) => ({ [field]: id }));
      const id = cond._eq;
      return canUpdate(this.collection, id, query) ? [{ [field]: id }] : [];
    }
  }
  hook({ filter: (name, fn) => (filters[name] = fn) }, { services: { ItemsService } });
  return { filters, log };
}

// A knex stand-in. Three kinds of query:
//   db(table).whereIn(pk, keys).select(...) -> the rows of `existing` (or of `tables[table]` when given);
//   db(table).where(column, id).whereRaw(sql).first(column) -> the row when `table:id` is in `created`
//     (the parent was written by this transaction), else undefined. An entry `table:id@N` is a row written
//     here whose OCC version is N (N > 1: it existed and was UPDATED here); a plain `table:id` was inserted
//     here (version 1). The fake applies the `version = 1` part of the SQL, as Postgres would;
//   the A1a reads (sample_readers, restricted flags, a campaign's contents): where(column, id) or
//     where({column: value}) with first / select, answered from `tables[table]` when that table is given. An
//     unlisted table answers "present and unrestricted" to first() and no rows to select(), so the older tests
//     need not know about them.
// `calls` records the first two shapes only (what the older tests assert on); `lookups` the A1a reads.
function fakeDb(existing = [], created = [], tables = {}) {
  // d1_private.hidden_records is always there (empty unless a test lists rows): the guard reads it for every move
  if (!tables['d1_private.hidden_records']) tables = { ...tables, 'd1_private.hidden_records': [] };
  const calls = [];
  const lookups = [];
  const db = (table) => {
    const preds = [];
    const q = {};
    const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    let whereIn = null;
    let eq = null;
    q.whereIn = (column, keys) => {
      whereIn = { column, keys };
      preds.push((r) => keys.map(String).includes(String(r[column])));
      return q;
    };
    q.where = (a, v) => {
      if (a && typeof a === 'object') {
        for (const [k, x] of Object.entries(a)) preds.push((r) => String(r[k]) === String(x));
      } else {
        eq = { column: a, id: v };
        preds.push((r) => String(r[a]) === String(v));
      }
      return q;
    };
    let sql = null;
    q.whereRaw = (text) => {
      sql = text;
      return q;
    };
    const project = (row, columns) => (columns.length ? Object.fromEntries(columns.map((c) => [c, row[c]])) : row);
    q.select = async (...columns) => {
      if (tables[table]) {
        lookups.push({ table, op: 'select', columns });
        return rows().map((r) => project(r, columns));
      }
      if (whereIn) {
        calls.push({ table, column: whereIn.column, keys: whereIn.keys, columns });
        return existing;
      }
      lookups.push({ table, op: 'select', columns });
      return [];
    };
    q.first = async (...selected) => {
      if (sql) {
        const column = eq.column;
        const id = eq.id;
        calls.push({ table, column, id, sql, selected: selected[0] });
        const entry = created.find((c) => c === `${table}:${id}` || c.startsWith(`${table}:${id}@`));
        if (!entry) return undefined;
        const version = entry.includes('@') ? Number(entry.split('@')[1]) : 1;
        if (/version\s*=\s*1/.test(sql) && version !== 1) return undefined;
        return { [column]: id };
      }
      lookups.push({ table, op: 'first', selected });
      if (tables[table]) return rows()[0];
      return { record_id: 'present', restricted: false, sample_id: null };
    };
    return q;
  };
  db.calls = calls;
  db.lookups = lookups;
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
  assert.ok(['junction', 'owner', 'restricted'].includes(err.extensions.kind), err.extensions.kind);
  assert.match(`${err.extensions.parent ?? err.extensions.collection} ${err.extensions.id}`, re);
  assert.equal(err.extensions.reason, err.message);
  assert.doesNotMatch(err.message, /_|ADR|[0-9a-f]{8}-|\b(s|p|c|t|k|o)\d\b/i, 'the message is plain words');
  return true;
};

test('registers an items.create, an items.delete and an items.update filter', () => {
  assert.deepEqual(Object.keys(mount().filters).sort(), ['items.create', 'items.delete', 'items.update']);
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

test('sample_co_owners create: allowed when the caller may manage the sample (its owner)', async () => {
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
  assert.ok(!sent.includes('co_owners'), "it is the sample's delete rule since A1: the owner, not a co-owner");
  assert.ok(sent.includes('owner_person_id'));
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
  assert.deepEqual(Object.keys(guards).sort(), ['campaigns', 'manufacturing_operations', 'physical_samples', 'test_sessions']);
  for (const [collection, g] of Object.entries(guards)) {
    assert.equal(g.field, 'owner_person_id', collection);
    assert.equal(g.valueKey, 'person_id', collection);
    // the delete rule: the owner (with the restriction gates of operations, tests and campaigns, which
    // mention co-owners of the sample), never a plain "any editor"; scripts/gen_access_rules.py's pytest
    // proves who passes it. The generated list also names restricted as an owner-only field.
    assert.ok(JSON.stringify(g.filter).includes('$CURRENT_USER'), collection);
    assert.ok(JSON.stringify(g.filter).includes('owner_person_id'), collection);
    assert.deepEqual(g.fields.map((f) => f.field), ['owner_person_id', 'owner_team_id', 'restricted'], collection);
  }
});

// ---- team ownership (migration 177): owner_team_id is guarded like owner_person_id -------------------

// A stand-in that answers each rule as the database would for a person who is `owner`, a team `manager` or a plain team `member`
// of a team-owned record: the delete rule names the manager's `manage` row and no Can edit role, the update rule names `edit`.
const roleOf = (query) => {
  const text = JSON.stringify(query.filter);
  return { names_edit: /"edit"/.test(text), names_manage: /"manage"/.test(text) };
};

test('the shipped rules guard owner_team_id with the same delete rule as owner_person_id, in each of the four records', () => {
  const guards = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')).ownerGuards;
  for (const [collection, g] of Object.entries(guards)) {
    assert.deepEqual(g.fields[1], { field: 'owner_team_id', valueKey: 'team_id' }, collection);
    const rule = JSON.stringify(g.filter);
    // the delete rule: the person owner, or a manager of the owning team (derived `manage` row); never the `edit` role
    assert.ok(rule.includes('owner_person_id') && rule.includes('"manage"'), collection);
    assert.ok(!rule.includes('"edit"'), `${collection}: a plain member of the owning team (edit) must not pass`);
  }
});

test('owner_team_id change: a plain member of the owning team (edit, not manage) is refused', async () => {
  // the fake plays the database: only a rule that names `manage` and not the Can edit role lets the caller through when they hold
  // an `edit` row; a manager (manage row) passes the delete rule and the update rule alike
  for (const [collection, pk] of [['physical_samples', 'sample_id'], ['manufacturing_operations', 'operation_id'], ['test_sessions', 'session_id'], ['campaigns', 'campaign_id']]) {
    const asMember = (_c, _id, query) => {
      const { names_edit, names_manage } = roleOf(query);
      return names_edit && names_manage; // the update rule (edit, manage) passes a member; the delete rule (manage only) does not
    };
    const { filters, log } = mount({ canUpdate: asMember });
    const database = ownerDb([{ [pk]: 'k1', owner_person_id: null, owner_team_id: 'team-a' }]);
    await assert.rejects(
      filters['items.update']({ owner_team_id: 'team-b' }, { collection, keys: ['k1'] }, ctx({ database })),
      denied(new RegExp(`${collection} k1`)),
      collection,
    );
    assert.equal(log.reads.length, 1, collection);
  }
});

test('owner_team_id change: a manager of the owning team (manage row) may hand the record over, set or clear the team', async () => {
  const asManager = (_c, _id, query) => roleOf(query).names_manage; // both rules name `manage`
  for (const [collection, pk] of [['physical_samples', 'sample_id'], ['manufacturing_operations', 'operation_id'], ['test_sessions', 'session_id'], ['campaigns', 'campaign_id']]) {
    for (const next of ['team-b', null, { team_id: 'team-b' }]) {
      const { filters, log } = mount({ canUpdate: asManager });
      const payload = { owner_team_id: next };
      const database = ownerDb([{ [pk]: 'k1', owner_person_id: null, owner_team_id: 'team-a' }]);
      assert.equal(await filters['items.update'](payload, { collection, keys: ['k1'] }, ctx({ database })), payload);
      assert.equal(log.reads.length, 1, collection);
    }
  }
});

test('owner_team_id change: the same team sent back (a form save) is not a change; a member who changes nothing else is not asked', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: null, owner_team_id: 'team-a' }]);
  await filters['items.update']({ owner_team_id: 'team-a', notes: 'x' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database }));
  await filters['items.update']({ owner_team_id: { team_id: 'team-a' } }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database }));
  await filters['items.update']({ notes: 'x' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database }));
  assert.equal(log.reads.length, 0);
});

test('owner_team_id change: setting a team on an unowned record, or on a person-owned one, needs the delete rule', async () => {
  for (const row of [{ owner_person_id: null, owner_team_id: null }, { owner_person_id: 'p1', owner_team_id: null }]) {
    const { filters, log } = mount({ canUpdate: () => false });
    const database = ownerDb([{ sample_id: 's1', ...row }]);
    await assert.rejects(
      filters['items.update']({ owner_team_id: 'team-a' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
      denied(/physical_samples s1/),
    );
    assert.equal(log.reads.length, 1);
  }
});

test('owner_team_id change: refusal is the owner kind; admins and internal calls are not checked', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const database = ownerDb([{ session_id: 't1', owner_person_id: null, owner_team_id: 'team-a' }]);
  const err = await refusal(filters['items.update']({ owner_team_id: 'team-b' }, { collection: 'test_sessions', keys: ['t1'] }, ctx({ database })));
  assert.equal(err.extensions.kind, 'owner');
  assert.equal(err.extensions.collection, 'test_sessions');
  const meta = { collection: 'test_sessions', keys: ['t1'] };
  await filters['items.update']({ owner_team_id: 'team-b' }, meta, ctx({ database, accountability: { user: 'a', admin: true } }));
  await filters['items.update']({ owner_team_id: 'team-b' }, meta, ctx({ database, accountability: null }));
});

test('owner change: a co-owner (who cannot delete) is refused', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p-owner' }]);
  await assert.rejects(
    filters['items.update']({ owner_person_id: 'p-me' }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    denied(/physical_samples s1/),
  );
  assert.deepEqual(database.calls, [
    { table: 'physical_samples', column: 'sample_id', keys: ['s1'], columns: ['sample_id', 'owner_person_id', 'owner_team_id', 'restricted'] },
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

test('owner change: a payload without a guarded field is untouched', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1' }]);
  const payload = { sample_code: 'X-2', notes: 'x' };
  assert.equal(
    await filters['items.update'](payload, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    payload,
  );
  assert.equal(log.reads.length, 0);
  assert.equal(database.calls.length, 0);
});

// A move of a record that touches nothing Restricted is the editor's to make (the old project_id behaviour).
test('a move of an unrestricted record by an editor still passes, after reading the flags', async () => {
  const { filters, log } = mount({ canUpdate: () => false });
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1', restricted: false, project_id: 'p-old' }]);
  const payload = { sample_code: 'X-2', project_id: 'p9' };
  assert.equal(
    await filters['items.update'](payload, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })),
    payload,
  );
  assert.equal(log.reads.length, 0);
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
  for (const collection of ['projects', 'etchants', 'sample_co_owners']) {
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
    ['sample_co_owners', { sample_id: 's1', user_id: 'u' }, "Only the sample's owner can add co-owners.", 'physical_samples'],
    ['campaign_samples', { campaign_id: 'c1', sample_id: 's1' }, 'You can only add samples to a campaign you own or can edit.', 'campaigns'],
    ['project_investigators', { project_id: 'p1', user_id: 'u' }, "Only the project's principal investigator can add investigators.", 'projects'],
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

// ---- A1a: owner-only Restricted, restricted-aware moves, and the two campaign guards ------------------

// The tests below tell the update rule (an editor passes) from the delete rule (only the owner passes)
// by the filter sent: the update rules name the Can edit role or the co-owners, the delete rules do not (a team manager's `manage` row is in both).
const isDeleteRule = (query) => !/"edit"|co_owners/.test(JSON.stringify(query.filter));
// "Everyone may update; only the listed records are owned by the caller."
const ownsOnly = (...owned) => (collection, id, query) => !isDeleteRule(query) || owned.includes(`${collection}:${id}`);
const kindOf = (err) => [err.extensions.kind, err.message];

test('the shipped rules list the guarded fields, the moving keys and the two junction rules', () => {
  const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));
  assert.deepEqual(rules.restrictedKeys.campaigns, ['project_id']);
  assert.deepEqual(rules.restrictedKeys.manufacturing_operations, ['project_id', 'campaign_id', 'sample_id']);
  // the junction guards of the co-owner and the investigator are the parent's DELETE rule (the owner / the PI)
  for (const collection of ['sample_co_owners', 'project_investigators']) {
    const [check] = RULES[collection];
    assert.ok(!/"edit"|co_owners/.test(JSON.stringify(check.filter)), `${collection}: the owner, not an editor`);
    assert.ok(JSON.stringify(check.filter).includes('$CURRENT_USER'));
  }
});

test('restricted: the owner switches it; a co-owner and a Can edit person are refused (kind restricted)', async () => {
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1', restricted: false }]);
  const meta = { collection: 'physical_samples', keys: ['s1'] };
  const owner = mount({ canUpdate: ownsOnly('physical_samples:s1') });
  assert.deepEqual(await owner.filters['items.update']({ restricted: true }, meta, ctx({ database })), { restricted: true });
  for (const who of ['a co-owner', 'a Can edit person']) {
    const editor = mount({ canUpdate: ownsOnly() });
    const err = await refusal(editor.filters['items.update']({ restricted: true }, meta, ctx({ database })));
    assert.deepEqual(kindOf(err), ['restricted', "Only the sample's owner can restrict it or lift the restriction."], who);
    assert.deepEqual([err.extensions.collection, err.extensions.id], ['physical_samples', 's1']);
    assert.ok(isDeleteRule(editor.log.reads[0].query), 'the owner rule (delete) decided');
  }
});

test('restricted: lifting it needs the owner too, a value sent unchanged does not, and every guarded record type is covered', async () => {
  const cases = [
    ['physical_samples', 'sample_id'],
    ['manufacturing_operations', 'operation_id'],
    ['test_sessions', 'session_id'],
    ['campaigns', 'campaign_id'],
  ];
  for (const [collection, pk] of cases) {
    const lock = ownerDb([{ [pk]: 'k1', owner_person_id: 'p1', restricted: true }]);
    const editor = mount({ canUpdate: ownsOnly() });
    const err = await refusal(editor.filters['items.update']({ restricted: false }, { collection, keys: ['k1'] }, ctx({ database: lock })));
    assert.equal(err.extensions.kind, 'restricted', collection);
    // an editor saving the whole form: the same value comes back, which is not a change
    await editor.filters['items.update']({ restricted: true, notes: 'x' }, { collection, keys: ['k1'] }, ctx({ database: lock }));
    await editor.filters['items.update']({ restricted: 'true' }, { collection, keys: ['k1'] }, ctx({ database: lock }));
    const open = ownerDb([{ [pk]: 'k1', owner_person_id: 'p1', restricted: false }]);
    await editor.filters['items.update']({ restricted: false }, { collection, keys: ['k1'] }, ctx({ database: open }));
  }
});

test('restricted: admins and internal calls are not checked; a batch is checked per key', async () => {
  const database = ownerDb([
    { sample_id: 's1', owner_person_id: 'p1', restricted: false },
    { sample_id: 's2', owner_person_id: 'p2', restricted: false },
  ]);
  const meta = { collection: 'physical_samples', keys: ['s1', 's2'] };
  const none = mount({ canUpdate: ownsOnly() });
  await none.filters['items.update']({ restricted: true }, meta, ctx({ database, accountability: { user: 'a', admin: true } }));
  await none.filters['items.update']({ restricted: true }, meta, ctx({ database, accountability: null }));
  assert.equal(none.log.reads.length, 0);
  const some = mount({ canUpdate: ownsOnly('physical_samples:s1') });
  const err = await refusal(some.filters['items.update']({ restricted: true }, meta, ctx({ database })));
  assert.equal(err.extensions.id, 's2');
  assert.deepEqual(some.log.reads.map((r) => r.query.filter._and[0].sample_id._eq), ['s1', 's2']);
});

test('restricted: a payload that changes the owner and the flag is refused as an owner change', async () => {
  const database = ownerDb([{ sample_id: 's1', owner_person_id: 'p1', restricted: false }]);
  const { filters } = mount({ canUpdate: ownsOnly() });
  const err = await refusal(filters['items.update']({ owner_person_id: 'p2', restricted: true }, { collection: 'physical_samples', keys: ['s1'] }, ctx({ database })));
  assert.equal(err.extensions.kind, 'owner');
});

// ---- moves of a restricted record -------------------------------------------------------------------

const sampleTables = (extra = {}) => ({
  physical_samples: [
    { sample_id: 's-open', owner_person_id: 'p1', restricted: false, project_id: 'pj-open' },
    { sample_id: 's-locked', owner_person_id: 'p1', restricted: true, project_id: 'pj-open' },
    { sample_id: 's-in-locked-project', owner_person_id: 'p1', restricted: false, project_id: 'pj-locked' },
  ],
  projects: [
    { project_id: 'pj-open', restricted: false },
    { project_id: 'pj-open2', restricted: false },
    { project_id: 'pj-locked', restricted: true },
    { project_id: 'pj-locked2', restricted: true },
  ],
  ...extra,
});

test('moving a restricted sample, or a sample out of or into a restricted project, needs the owner', async () => {
  const meta = (key) => ({ collection: 'physical_samples', keys: [key] });
  const moves = [
    ['s-locked', 'pj-open2', 'the sample itself is restricted'],
    ['s-in-locked-project', 'pj-open2', 'out of a restricted project'],
    ['s-open', 'pj-locked', 'into a restricted project'],
  ];
  for (const [key, to, why] of moves) {
    const editor = mount({ canUpdate: ownsOnly() });
    const err = await refusal(editor.filters['items.update']({ project_id: to }, meta(key), ctx({ database: fakeDb([], [], sampleTables()) })));
    assert.deepEqual(kindOf(err), ['restricted', "Only the sample's owner can move it into or out of something restricted."], why);
    // the owner passes
    const owner = mount({ canUpdate: ownsOnly(`physical_samples:${key}`) });
    await owner.filters['items.update']({ project_id: to }, meta(key), ctx({ database: fakeDb([], [], sampleTables()) }));
  }
});

test('a move that touches nothing restricted, or the same value, passes for an editor', async () => {
  const { filters, log } = mount({ canUpdate: ownsOnly() });
  const meta = { collection: 'physical_samples', keys: ['s-open'] };
  await filters['items.update']({ project_id: 'pj-open2' }, meta, ctx({ database: fakeDb([], [], sampleTables()) }));
  await filters['items.update']({ project_id: 'pj-open', notes: 'form save' }, { collection: 'physical_samples', keys: ['s-locked'] }, ctx({ database: fakeDb([], [], sampleTables()) }));
  await filters['items.update']({ project_id: { project_id: 'pj-open' } }, { collection: 'physical_samples', keys: ['s-locked'] }, ctx({ database: fakeDb([], [], sampleTables()) }));
  assert.equal(log.reads.length, 0);
  // a nested object that names the new project is read by its key
  await assert.rejects(
    filters['items.update']({ project_id: { project_id: 'pj-locked' } }, meta, ctx({ database: fakeDb([], [], sampleTables()) })),
    denied(/physical_samples s-open/),
  );
});

test('operations and tests: moving between campaigns, samples and projects of a restricted parent needs the owner', async () => {
  for (const collection of ['manufacturing_operations', 'test_sessions']) {
    const pk = collection === 'test_sessions' ? 'session_id' : 'operation_id';
    const tables = {
      [collection]: [
        { [pk]: 'r1', owner_person_id: 'p1', restricted: false, project_id: 'pj-open', campaign_id: 'c-open', sample_id: 's-open' },
        { [pk]: 'r2', owner_person_id: 'p1', restricted: false, project_id: 'pj-open', campaign_id: 'c-open', sample_id: 's-locked' },
        { [pk]: 'r3', owner_person_id: 'p1', restricted: true, project_id: 'pj-open', campaign_id: 'c-open', sample_id: 's-open' },
      ],
      physical_samples: sampleTables().physical_samples,
      projects: sampleTables().projects,
      campaigns: [{ campaign_id: 'c-open', restricted: false }, { campaign_id: 'c-open2', restricted: false }, { campaign_id: 'c-locked', restricted: true }],
    };
    const attempt = async (key, payload, canUpdate = ownsOnly()) =>
      refusal(mount({ canUpdate }).filters['items.update'](payload, { collection, keys: [key] }, ctx({ database: fakeDb([], [], tables) })));
    const refusedFor = async (key, payload) => {
      const err = await attempt(key, payload);
      assert.equal(err.extensions.kind, 'restricted', `${collection} ${JSON.stringify(payload)}`);
    };
    await refusedFor('r1', { campaign_id: 'c-locked' });          // into a restricted campaign
    await refusedFor('r1', { sample_id: 's-locked' });            // onto a restricted sample
    await refusedFor('r2', { project_id: 'pj-open2' });           // the current sample is restricted
    await refusedFor('r2', { sample_id: 's-open' });              // off a restricted sample
    await refusedFor('r3', { campaign_id: 'c-open2' });           // the record itself is restricted
    await refusedFor('r1', { project_id: 'pj-locked' });          // into a restricted project
    // the owner passes, and an unrestricted move by an editor passes
    await mount({ canUpdate: ownsOnly(`${collection}:r2`) }).filters['items.update']({ project_id: 'pj-open2' }, { collection, keys: ['r2'] }, ctx({ database: fakeDb([], [], tables) }));
    await mount({ canUpdate: ownsOnly() }).filters['items.update']({ campaign_id: 'c-open2', project_id: 'pj-open2' }, { collection, keys: ['r1'] }, ctx({ database: fakeDb([], [], tables) }));
  }
});

test('a move is checked per key in a batch and not at all for admins and internal calls', async () => {
  const tables = sampleTables();
  const meta = { collection: 'physical_samples', keys: ['s-open', 's-locked'] };
  const owner = mount({ canUpdate: ownsOnly('physical_samples:s-locked') });
  await owner.filters['items.update']({ project_id: 'pj-open2' }, meta, ctx({ database: fakeDb([], [], tables) })); // only s-locked needs the owner
  assert.deepEqual(owner.log.reads.map((r) => r.query.filter._and[0].sample_id._eq), ['s-locked']);
  await assert.rejects(mount({ canUpdate: ownsOnly() }).filters['items.update']({ project_id: 'pj-open2' }, meta, ctx({ database: fakeDb([], [], tables) })), denied(/s-locked/));
  const free = mount({ canUpdate: ownsOnly() });
  await free.filters['items.update']({ project_id: 'pj-open2' }, meta, ctx({ database: fakeDb([], [], tables), accountability: { user: 'a', admin: true } }));
  await free.filters['items.update']({ project_id: 'pj-open2' }, meta, ctx({ database: fakeDb([], [], tables), accountability: null }));
  assert.equal(free.log.reads.length, 0);
});

// ---- campaign_samples: the sample must be one the caller can read, and a restricted one needs its owner ----

const readers = (...ids) => ({ sample_readers: ids.map((id) => ({ record_id: id, user_id: 'user-1' })) });

test('campaign_samples create: a sample the caller cannot read is refused even when the update rule would pass', async () => {
  const { filters } = mount({ canUpdate: ownsOnly() });
  const database = fakeDb([], [], { ...readers('s-readable'), physical_samples: [{ sample_id: 's-readable', restricted: false }, { sample_id: 's-hidden', restricted: false }] });
  const meta = { collection: 'campaign_samples' };
  await filters['items.create']({ campaign_id: 'c1', sample_id: 's-readable' }, meta, ctx({ database }));
  const err = await refusal(filters['items.create']({ campaign_id: 'c1', sample_id: 's-hidden' }, meta, ctx({ database })));
  assert.deepEqual(kindOf(err), ['junction', 'You cannot see that sample, so you cannot add it to a campaign.']);
  assert.deepEqual([err.extensions.parent, err.extensions.id], ['physical_samples', 's-hidden']);
  // the lookup is one sample_readers read for the caller, in the request's transaction
  const lookup = database.lookups.find((l) => l.table === 'sample_readers');
  assert.deepEqual(lookup, { table: 'sample_readers', op: 'first', selected: ['record_id'] });
});

test('campaign_samples create: a restricted sample needs its owner (the delete rule), an unrestricted one does not', async () => {
  const tables = { ...readers('s-locked', 's-open'), physical_samples: [{ sample_id: 's-locked', restricted: true }, { sample_id: 's-open', restricted: false }] };
  const meta = { collection: 'campaign_samples' };
  const editor = mount({ canUpdate: ownsOnly() });
  await editor.filters['items.create']({ campaign_id: 'c1', sample_id: 's-open' }, meta, ctx({ database: fakeDb([], [], tables) }));
  const err = await refusal(editor.filters['items.create']({ campaign_id: 'c1', sample_id: 's-locked' }, meta, ctx({ database: fakeDb([], [], tables) })));
  assert.deepEqual(kindOf(err), ['junction', "Only the sample's owner can add a restricted sample to a campaign."]);
  const owner = mount({ canUpdate: ownsOnly('physical_samples:s-locked') });
  await owner.filters['items.create']({ campaign_id: 'c1', sample_id: 's-locked' }, meta, ctx({ database: fakeDb([], [], tables) }));
});

test('campaign_samples update: repointing to an unreadable or restricted sample is checked, a new sample made here is not', async () => {
  const tables = { ...readers('s-open'), physical_samples: [{ sample_id: 's-open', restricted: false }], campaign_samples: [{ id: 5, campaign_id: 'c1', sample_id: 's-open' }] };
  const meta = { collection: 'campaign_samples', keys: [5] };
  const { filters } = mount({ canUpdate: ownsOnly() });
  const db = () => fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's-open' }], [], tables);
  await assert.rejects(filters['items.update']({ sample_id: 's-hidden' }, meta, ctx({ database: db() })), denied(/physical_samples s-hidden/));
  // a sample inserted by this very request: the update rule fails, the new-here exemption holds, the reader lookup is skipped
  const created = fakeDb([{ id: 5, campaign_id: 'c1', sample_id: 's-open' }], ['physical_samples:s-new'], tables);
  const noUpdate = mount({ canUpdate: (c) => c !== 'physical_samples' });
  await noUpdate.filters['items.update']({ sample_id: 's-new' }, meta, ctx({ database: created }));
  assert.ok(!created.lookups.some((l) => l.table === 'sample_readers'));
});

test('campaign_samples create: a sample created in this request needs no reader row', async () => {
  const { filters } = mount({ canUpdate: () => false });
  const database = fakeDb([], ['campaigns:c-new', 'physical_samples:s-new'], { sample_readers: [] });
  await filters['items.create']({ campaign_id: 'c-new', sample_id: 's-new' }, { collection: 'campaign_samples' }, ctx({ database }));
});

// ---- test_sessions_subject: a restricted test, or a test on a restricted sample, needs the test's owner ----

test('test_sessions_subject create: a restricted test or a test on a restricted sample needs the test owner', async () => {
  const tables = {
    test_sessions: [
      { session_id: 't-open', restricted: false, sample_id: 's-open' },
      { session_id: 't-locked', restricted: true, sample_id: 's-open' },
      { session_id: 't-on-locked', restricted: false, sample_id: 's-locked' },
      { session_id: 't-empty', restricted: false, sample_id: null },
    ],
    physical_samples: [{ sample_id: 's-open', restricted: false }, { sample_id: 's-locked', restricted: true }],
  };
  const meta = { collection: 'test_sessions_subject' };
  const subject = (id) => ({ test_sessions_id: id, collection: 'physical_samples', item: 'x' });
  const editor = mount({ canUpdate: ownsOnly() });
  for (const ok of ['t-open', 't-empty']) await editor.filters['items.create'](subject(ok), meta, ctx({ database: fakeDb([], [], tables) }));
  for (const id of ['t-locked', 't-on-locked']) {
    const err = await refusal(editor.filters['items.create'](subject(id), meta, ctx({ database: fakeDb([], [], tables) })));
    assert.deepEqual(kindOf(err), ['junction', "Only the test's owner can change the samples of a restricted test or of a test on a restricted sample."], id);
    const owner = mount({ canUpdate: ownsOnly(`test_sessions:${id}`) });
    await owner.filters['items.create'](subject(id), meta, ctx({ database: fakeDb([], [], tables) }));
  }
});

// ---- a campaign's project change ----------------------------------------------------------------------

function campaignWorld(extra = {}) {
  return {
    campaigns: [{ campaign_id: 'c1', owner_person_id: 'p1', restricted: false, project_id: 'pj-open' }],
    campaign_samples: [{ id: 1, campaign_id: 'c1', sample_id: 's-open' }, { id: 2, campaign_id: 'c1', sample_id: 's-locked' }, { id: 3, campaign_id: 'c2', sample_id: 's-x' }],
    physical_samples: [
      { sample_id: 's-open', restricted: false, project_id: 'pj-open' },
      { sample_id: 's-locked', restricted: true, project_id: 'pj-open' },
      { sample_id: 's-in-locked-project', restricted: false, project_id: 'pj-locked' },
      { sample_id: 's-x', restricted: true, project_id: 'pj-open' },
    ],
    projects: sampleTables().projects,
    manufacturing_operations: [],
    test_sessions: [],
    ...extra,
  };
}
const moveCampaign = (canUpdate, tables, payload = { project_id: 'pj-mine' }, accountability) =>
  mount({ canUpdate }).filters['items.update'](payload, { collection: 'campaigns', keys: ['c1'] }, ctx({ database: fakeDb([], [], tables), ...(accountability !== undefined ? { accountability } : {}) }));

test('a campaign project change: a Can edit person is refused, the owner of an unrestricted campaign passes', async () => {
  const unrestricted = campaignWorld({ campaign_samples: [{ id: 1, campaign_id: 'c1', sample_id: 's-open' }] });
  const editor = await refusal(moveCampaign(ownsOnly(), unrestricted));
  assert.deepEqual(kindOf(editor), ['restricted', "Only the campaign's owner can move it to another project."]);
  await moveCampaign(ownsOnly('campaigns:c1'), unrestricted);
  // the same value, or no change of project, is not a move
  await moveCampaign(ownsOnly(), unrestricted, { project_id: 'pj-open', notes: 'form save' });
});

test('a campaign project change: the owner is refused while the campaign holds a restricted sample they do not own', async () => {
  const tables = campaignWorld();
  const err = await refusal(moveCampaign(ownsOnly('campaigns:c1'), tables));
  assert.deepEqual(kindOf(err), ['restricted', 'This campaign holds restricted records you do not own, so only an administrator can move it to another project.']);
  await moveCampaign(ownsOnly('campaigns:c1', 'physical_samples:s-locked'), tables); // owns everything restricted in it
});

test('a campaign project change: a restricted operation or test with that campaign, or a sample of a restricted project, counts', async () => {
  const base = { campaign_samples: [{ id: 1, campaign_id: 'c1', sample_id: 's-open' }] };
  const withOp = campaignWorld({ ...base, manufacturing_operations: [{ operation_id: 'o1', campaign_id: 'c1', restricted: true }, { operation_id: 'o2', campaign_id: 'c1', restricted: false }] });
  await assert.rejects(moveCampaign(ownsOnly('campaigns:c1'), withOp), denied(/campaigns c1/));
  await moveCampaign(ownsOnly('campaigns:c1', 'manufacturing_operations:o1'), withOp);
  const withTest = campaignWorld({ ...base, test_sessions: [{ session_id: 't1', campaign_id: 'c1', restricted: true }] });
  await assert.rejects(moveCampaign(ownsOnly('campaigns:c1'), withTest), denied(/campaigns c1/));
  await moveCampaign(ownsOnly('campaigns:c1', 'test_sessions:t1'), withTest);
  const inLockedProject = campaignWorld({ campaign_samples: [{ id: 1, campaign_id: 'c1', sample_id: 's-in-locked-project' }] });
  await assert.rejects(moveCampaign(ownsOnly('campaigns:c1'), inLockedProject), denied(/campaigns c1/));
  await moveCampaign(ownsOnly('campaigns:c1', 'physical_samples:s-in-locked-project'), inLockedProject);
  // the rows of ANOTHER campaign do not count
  await moveCampaign(ownsOnly('campaigns:c1'), campaignWorld({ campaign_samples: [{ id: 1, campaign_id: 'c1', sample_id: 's-open' }, { id: 3, campaign_id: 'c2', sample_id: 's-x' }] }));
});

test('a campaign project change: the owners of what is restricted are asked in one read per record type', async () => {
  const tables = campaignWorld({
    campaign_samples: [{ id: 1, campaign_id: 'c1', sample_id: 's-locked' }, { id: 2, campaign_id: 'c1', sample_id: 's-x' }],
  });
  const owner = mount({ canUpdate: ownsOnly('campaigns:c1', 'physical_samples:s-locked', 'physical_samples:s-x') });
  await owner.filters['items.update']({ project_id: 'pj-mine' }, { collection: 'campaigns', keys: ['c1'] }, ctx({ database: fakeDb([], [], tables) }));
  const sampleReads = owner.log.reads.filter((r) => r.collection === 'physical_samples');
  assert.equal(sampleReads.length, 1);
  assert.deepEqual(sampleReads[0].query.filter._and[0], { sample_id: { _in: ['s-locked', 's-x'] } });
  // one sample not owned: refused
  await assert.rejects(moveCampaign(ownsOnly('campaigns:c1', 'physical_samples:s-locked'), tables), denied(/campaigns c1/));
});

test('a campaign project change by an admin or an internal call is not checked; an owner change in the same payload still checks the contents', async () => {
  const tables = campaignWorld();
  await moveCampaign(ownsOnly(), tables, { project_id: 'pj-mine' }, { user: 'a', admin: true });
  await moveCampaign(ownsOnly(), tables, { project_id: 'pj-mine' }, null);
  await assert.rejects(moveCampaign(ownsOnly('campaigns:c1'), tables, { project_id: 'pj-mine', owner_person_id: 'p2' }), denied(/campaigns c1/));
});

test('a refused move names the record and keeps the plain-words contract', async () => {
  const err = await refusal(moveCampaign(ownsOnly(), campaignWorld()));
  assert.deepEqual(
    { ...err.extensions },
    { code: 'FORBIDDEN', reason: err.message, source: 'd1-access-guard', kind: 'restricted', collection: 'campaigns', id: 'c1' },
  );
});

// ---- clearing a gating key is a move (review I1) ----------------------------------------------------------

test("clearing project_id, campaign_id or sample_id takes a record out of its parent's gate: the owner is needed when the OLD parent is restricted", async () => {
  const tables = sampleTables();
  const clear = (collection, key, payload, canUpdate = ownsOnly()) =>
    refusal(mount({ canUpdate }).filters['items.update'](payload, { collection, keys: [key] }, ctx({ database: fakeDb([], [], tables) })));
  // a sample out of a restricted project, a restricted sample out of an open one
  for (const key of ['s-in-locked-project', 's-locked']) {
    const err = await clear('physical_samples', key, { project_id: null });
    assert.deepEqual(kindOf(err), ['restricted', "Only the sample's owner can move it into or out of something restricted."], key);
    await mount({ canUpdate: ownsOnly(`physical_samples:${key}`) }).filters['items.update']({ project_id: null }, { collection: 'physical_samples', keys: [key] }, ctx({ database: fakeDb([], [], tables) }));
  }
  // an unrestricted sample out of an unrestricted project: an editor may
  await mount({ canUpdate: ownsOnly() }).filters['items.update']({ project_id: null }, { collection: 'physical_samples', keys: ['s-open'] }, ctx({ database: fakeDb([], [], tables) }));
  // clearing a key that is already empty is not a move
  tables.physical_samples.push({ sample_id: 's-none', owner_person_id: 'p1', restricted: true, project_id: null });
  await mount({ canUpdate: ownsOnly() }).filters['items.update']({ project_id: null }, { collection: 'physical_samples', keys: ['s-none'] }, ctx({ database: fakeDb([], [], tables) }));
  // operations and tests: out of a restricted sample, out of a restricted campaign
  for (const collection of ['manufacturing_operations', 'test_sessions']) {
    const pk = collection === 'test_sessions' ? 'session_id' : 'operation_id';
    const t = {
      [collection]: [{ [pk]: 'r1', owner_person_id: 'p1', restricted: false, project_id: 'pj-open', campaign_id: 'c-locked', sample_id: 's-locked' }],
      physical_samples: tables.physical_samples,
      projects: tables.projects,
      campaigns: [{ campaign_id: 'c-locked', restricted: true }],
    };
    for (const payload of [{ sample_id: null }, { campaign_id: null }]) {
      const err = await refusal(mount({ canUpdate: ownsOnly() }).filters['items.update'](payload, { collection, keys: ['r1'] }, ctx({ database: fakeDb([], [], t) })));
      assert.equal(err.extensions.kind, 'restricted', `${collection} ${JSON.stringify(payload)}`);
      await mount({ canUpdate: ownsOnly(`${collection}:r1`) }).filters['items.update'](payload, { collection, keys: ['r1'] }, ctx({ database: fakeDb([], [], t) }));
    }
  }
});

test('clearing campaigns.project_id needs the campaign owner, and the owner of what is restricted in it', async () => {
  const tables = campaignWorld();
  const clear = (canUpdate) => moveCampaign(canUpdate, tables, { project_id: null });
  assert.deepEqual(kindOf(await refusal(clear(ownsOnly()))), ['restricted', "Only the campaign's owner can move it to another project."]);
  await assert.rejects(clear(ownsOnly('campaigns:c1')), denied(/campaigns c1/)); // holds a restricted sample they do not own
  await clear(ownsOnly('campaigns:c1', 'physical_samples:s-locked'));
});

// ---- the restricted flag spelled the Postgres way (review I2) ---------------------------------------------

test('restricted: every Postgres spelling of the stored value is "unchanged", every other spelling is a change', async () => {
  const stored = (value) => ownerDb([{ sample_id: 's1', owner_person_id: 'p1', restricted: value }]);
  const meta = { collection: 'physical_samples', keys: ['s1'] };
  const passes = async (value, sent) => {
    const { filters, log } = mount({ canUpdate: ownsOnly() });
    await filters['items.update']({ restricted: sent }, meta, ctx({ database: stored(value) }));
    assert.equal(log.reads.length, 0, `${JSON.stringify(sent)} over ${value}`);
  };
  const refused = async (value, sent) => {
    const { filters } = mount({ canUpdate: ownsOnly() });
    const err = await refusal(filters['items.update']({ restricted: sent }, meta, ctx({ database: stored(value) })));
    assert.equal(err.extensions.kind, 'restricted', `${JSON.stringify(sent)} over ${value}`);
  };
  // stored false: only false spellings are unchanged; 't', '1', 'yes', 'ON', ' Y ' restrict the record (refused for an editor)
  for (const sent of [false, 'false', 'f', 'F', 'no', 'N', 'off', 'OFF', '0', 0, ' false ']) await passes(false, sent);
  for (const sent of [true, 'true', 't', 'T', '1', 1, 'yes', 'y', 'on', 'ON', ' Y ', 'TRUE']) await refused(false, sent);
  // stored true: the mirror image
  for (const sent of [true, 'true', 't', '1', 1, 'yes', 'y', 'on', ' TRUE ']) await passes(true, sent);
  for (const sent of [false, 'false', 'f', '0', 0, 'no', 'n', 'off']) await refused(true, sent);
  // anything not recognised is a change (the guard runs, the database then decides)
  for (const sent of [null, undefined, '', 'maybe', 'tru', 'ye', 2, {}, []]) {
    await refused(false, sent);
    await refused(true, sent);
  }
});

// ---- removing a sample from a restricted campaign (review M5, ruling) -----------------------------------

test('campaign_samples delete: a restricted campaign needs the campaign owner, an open one does not, admins are not checked', async () => {
  const tables = {
    campaigns: [{ campaign_id: 'c-open', restricted: false }, { campaign_id: 'c-locked', restricted: true }],
    campaign_samples: [{ id: 1, campaign_id: 'c-open', sample_id: 's1' }, { id: 2, campaign_id: 'c-locked', sample_id: 's2' }, { id: 3, campaign_id: 'c-locked', sample_id: 's3' }],
  };
  const del = (canUpdate, keys, accountability) =>
    mount({ canUpdate }).filters['items.delete'](keys, { collection: 'campaign_samples' }, ctx({ database: fakeDb([], [], tables), ...(accountability !== undefined ? { accountability } : {}) }));
  await del(ownsOnly(), [1]);
  const err = await refusal(del(ownsOnly(), [2]));
  assert.deepEqual(kindOf(err), ['junction', "Only the campaign's owner can remove samples from a restricted campaign."]);
  assert.deepEqual([err.extensions.parent, err.extensions.id], ['campaigns', 'c-locked']);
  await del(ownsOnly('campaigns:c-locked'), [2, 3]);
  await del(ownsOnly('campaigns:c-locked'), [1, 2]);
  await assert.rejects(del(ownsOnly(), [1, 3]), denied(/campaigns c-locked/));
  const free = mount({ canUpdate: ownsOnly() });
  await free.filters['items.delete']([2], { collection: 'campaign_samples' }, ctx({ database: fakeDb([], [], tables), accountability: { user: 'a', admin: true } }));
  await free.filters['items.delete']([2], { collection: 'campaign_samples' }, ctx({ database: fakeDb([], [], tables), accountability: null }));
  assert.equal(free.log.reads.length, 0);
  // other collections are not this hook's business
  await mount({ canUpdate: ownsOnly() }).filters['items.delete']([2], { collection: 'sample_co_owners' }, ctx({ database: fakeDb([], [], tables) }));
});

// ---- the update rule is NOT granted to everyone (review M7) --------------------------------------------------

test('campaign_samples create: a reader whose update rule on the sample is not granted (a Can view person) is refused; an editor who is a reader passes', async () => {
  const tables = { ...readers('s1'), physical_samples: [{ sample_id: 's1', restricted: false }] };
  const meta = { collection: 'campaign_samples' };
  const campaignOnly = (c) => c === 'campaigns'; // the campaign's update rule passes, the sample's does not
  await assert.rejects(
    mount({ canUpdate: campaignOnly }).filters['items.create']({ campaign_id: 'c1', sample_id: 's1' }, meta, ctx({ database: fakeDb([], [], tables) })),
    denied(/physical_samples s1/),
  );
  // the update rule passes but the person is no reader (a legacy co-owner of a sample in a restricted project): refused
  await assert.rejects(
    mount({ canUpdate: () => true }).filters['items.create']({ campaign_id: 'c1', sample_id: 's1' }, meta, ctx({ database: fakeDb([], [], { ...tables, sample_readers: [] }) })),
    denied(/physical_samples s1/),
  );
  await mount({ canUpdate: () => true }).filters['items.create']({ campaign_id: 'c1', sample_id: 's1' }, meta, ctx({ database: fakeDb([], [], tables) }));
});

// ---- A1a final review I1: "involved" is decided from hidden_records, not the parent's own flag ---------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hid = (kind, ...ids) => ids.map((record_id) => ({ kind, record_id }));
const HIDDEN = 'd1_private.hidden_records';

test('the shipped switch is ON in A1a: restrictions are admin-only until A1b flips it', () => {
  assert.equal(RESTRICT_ADMIN_ONLY, true);
});

test('I1 (a): repointing a subject row off a hidden sample needs the test owner, whether the hiding is a flag or only a restricted project', async () => {
  const T = ID(1);
  const S = ID(2);
  const S3 = ID(3);
  const meta = { collection: 'test_sessions_subject', keys: [10] };
  // the sample S is hidden only through hidden_records (its project is restricted: neither S nor T carries the flag)
  const tables = {
    test_sessions_subject: [{ id: 10, test_sessions_id: T, item: S, collection: 'physical_samples' }],
    test_sessions: [{ session_id: T, restricted: false, sample_id: S }],
    physical_samples: [{ sample_id: S, restricted: false }, { sample_id: S3, restricted: false }],
    [HIDDEN]: [...hid('physical_samples', S), ...hid('test_sessions', T)],
  };
  const db = () => fakeDb([], [], tables);
  const editor = mount({ canUpdate: ownsOnly() }); // a co-owner of S passes the update rule, not the delete rule
  const err = await refusal(editor.filters['items.update']({ item: S3 }, meta, ctx({ database: db() })));
  assert.deepEqual(kindOf(err), ['junction', "Only the test's owner can change the samples of a test that sits under something restricted."]);
  assert.deepEqual([err.extensions.parent, err.extensions.id], ['test_sessions', T]);
  await mount({ canUpdate: ownsOnly(`test_sessions:${T}`) }).filters['items.update']({ item: S3 }, meta, ctx({ database: db() }));
  // the same value (a form save) is not a move, and a change of an unrelated field is not either
  await editor.filters['items.update']({ item: S, collection: 'physical_samples' }, meta, ctx({ database: db() }));
  // moving it ONTO a hidden sample is involved too, even when the test is open
  const open = { ...tables, test_sessions: [{ session_id: T, restricted: false, sample_id: S3 }], [HIDDEN]: hid('physical_samples', S), test_sessions_subject: [{ id: 10, test_sessions_id: T, item: S3, collection: 'physical_samples' }] };
  await assert.rejects(editor.filters['items.update']({ item: S }, meta, ctx({ database: fakeDb([], [], open) })), denied(/test_sessions /));
  // nothing hidden: an editor may repoint it
  await editor.filters['items.update']({ item: S3 }, meta, ctx({ database: fakeDb([], [], { ...tables, [HIDDEN]: [], physical_samples: [{ sample_id: S, restricted: false }, { sample_id: S3, restricted: false }] }) }));
  // admins and internal calls are not checked
  await editor.filters['items.update']({ item: S3 }, meta, ctx({ database: db(), accountability: { user: 'a', admin: true } }));
  await editor.filters['items.update']({ item: S3 }, meta, ctx({ database: db(), accountability: null }));
});

test('I1 (b): deleting a subject row of a hidden test, or of a hidden sample, needs the test owner; an open one does not', async () => {
  const T = ID(1);
  const S = ID(2);
  const TO = ID(4);
  const tables = {
    test_sessions_subject: [{ id: 10, test_sessions_id: T, item: S, collection: 'physical_samples' }, { id: 11, test_sessions_id: TO, item: ID(5), collection: 'physical_samples' }],
    test_sessions: [{ session_id: T, restricted: false, sample_id: S }, { session_id: TO, restricted: false, sample_id: ID(5) }],
    physical_samples: [{ sample_id: S, restricted: false }, { sample_id: ID(5), restricted: false }],
    [HIDDEN]: hid('physical_samples', S),
  };
  const del = (canUpdate, keys, accountability) =>
    mount({ canUpdate }).filters['items.delete'](keys, { collection: 'test_sessions_subject' }, ctx({ database: fakeDb([], [], tables), ...(accountability !== undefined ? { accountability } : {}) }));
  const err = await refusal(del(ownsOnly(), [10]));
  assert.deepEqual(kindOf(err), ['junction', "Only the test's owner can change the samples of a test that sits under something restricted."]);
  await del(ownsOnly(`test_sessions:${T}`), [10]);
  await del(ownsOnly(), [11]); // nothing hidden
  await assert.rejects(del(ownsOnly(), [10, 11]), denied(/test_sessions /));
  await del(ownsOnly(), [10], { user: 'a', admin: true });
  await del(ownsOnly(), [10], null);
});

test('I1 (b2): creating a subject row on a hidden sample for an open test is refused for an editor', async () => {
  const T = ID(1);
  const S = ID(2);
  const tables = {
    test_sessions: [{ session_id: T, restricted: false, sample_id: null }],
    physical_samples: [{ sample_id: S, restricted: false }],
    [HIDDEN]: hid('physical_samples', S),
  };
  const meta = { collection: 'test_sessions_subject' };
  const row = { test_sessions_id: T, collection: 'physical_samples', item: S };
  await assert.rejects(mount({ canUpdate: ownsOnly() }).filters['items.create'](row, meta, ctx({ database: fakeDb([], [], tables) })), denied(/test_sessions /));
  await mount({ canUpdate: ownsOnly(`test_sessions:${T}`) }).filters['items.create'](row, meta, ctx({ database: fakeDb([], [], tables) }));
  await mount({ canUpdate: ownsOnly() }).filters['items.create']({ ...row, item: ID(9) }, meta, ctx({ database: fakeDb([], [], { ...tables, [HIDDEN]: [] }) }));
});

test('I1 (c): an operation or test moves off a sample, a campaign or a project that is hidden only through a restricted project: the owner is needed', async () => {
  const O = ID(20);
  const S2 = ID(21);
  const S3 = ID(22);
  const C = ID(23);
  const P = ID(24);
  for (const collection of ['manufacturing_operations', 'test_sessions']) {
    const pk = collection === 'test_sessions' ? 'session_id' : 'operation_id';
    // every flag is false: S2, C and the record are hidden only because P is restricted (hidden_records says so)
    const tables = {
      [collection]: [{ [pk]: O, owner_person_id: 'p1', restricted: false, project_id: null, campaign_id: C, sample_id: S2 }],
      physical_samples: [{ sample_id: S2, restricted: false }, { sample_id: S3, restricted: false }],
      campaigns: [{ campaign_id: C, restricted: false }, { campaign_id: ID(25), restricted: false }],
      projects: [{ project_id: P, restricted: false }, { project_id: ID(26), restricted: false }],
      [HIDDEN]: [...hid('physical_samples', S2), ...hid('campaigns', C), ...hid(collection, O)],
    };
    const payloads = [{ sample_id: S3 }, { sample_id: null }, { campaign_id: null }, { campaign_id: ID(25) }, { project_id: ID(26) }];
    for (const payload of payloads) {
      const meta = { collection, keys: [O] };
      const err = await refusal(mount({ canUpdate: ownsOnly() }).filters['items.update'](payload, meta, ctx({ database: fakeDb([], [], tables) })));
      assert.equal(err.extensions.kind, 'restricted', `${collection} ${JSON.stringify(payload)}`);
      await mount({ canUpdate: ownsOnly(`${collection}:${O}`) }).filters['items.update'](payload, meta, ctx({ database: fakeDb([], [], tables) }));
    }
    // the same payloads for a record that is NOT hidden: an editor may do them
    const open = { ...tables, [HIDDEN]: [] };
    for (const payload of payloads) await mount({ canUpdate: ownsOnly() }).filters['items.update'](payload, { collection, keys: [O] }, ctx({ database: fakeDb([], [], open) }));
  }
});

test('I1 (c2): a sample that a hidden campaign shields (hidden_records only) cannot be moved to another project by an editor', async () => {
  const S = ID(30);
  const tables = {
    physical_samples: [{ sample_id: S, owner_person_id: 'p1', restricted: false, project_id: ID(31) }],
    projects: [{ project_id: ID(31), restricted: false }, { project_id: ID(32), restricted: false }],
    [HIDDEN]: hid('physical_samples', S),
  };
  const meta = { collection: 'physical_samples', keys: [S] };
  await assert.rejects(mount({ canUpdate: ownsOnly() }).filters['items.update']({ project_id: ID(32) }, meta, ctx({ database: fakeDb([], [], tables) })), denied(/physical_samples /));
  await mount({ canUpdate: ownsOnly(`physical_samples:${S}`) }).filters['items.update']({ project_id: ID(32) }, meta, ctx({ database: fakeDb([], [], tables) }));
});

test('I1 (d): removing a sample from an unrestricted campaign of a restricted project (hidden_records) needs the campaign owner', async () => {
  const C = ID(40);
  const COPEN = ID(41);
  const tables = {
    campaigns: [{ campaign_id: C, restricted: false }, { campaign_id: COPEN, restricted: false }],
    campaign_samples: [{ id: 1, campaign_id: C, sample_id: ID(42) }, { id: 2, campaign_id: COPEN, sample_id: ID(43) }],
    [HIDDEN]: hid('campaigns', C),
  };
  const del = (canUpdate, keys) => mount({ canUpdate }).filters['items.delete'](keys, { collection: 'campaign_samples' }, ctx({ database: fakeDb([], [], tables) }));
  const err = await refusal(del(ownsOnly(), [1]));
  assert.deepEqual(kindOf(err), ['junction', "Only the campaign's owner can remove samples from a restricted campaign."]);
  await del(ownsOnly(`campaigns:${C}`), [1]);
  await del(ownsOnly(), [2]); // a visible campaign keeps the junction rule only
});

test('an empty or missing hidden_records row never makes the guard looser: the flag alone still counts', async () => {
  const S = ID(50);
  const tables = {
    physical_samples: [{ sample_id: S, owner_person_id: 'p1', restricted: true, project_id: ID(51) }],
    projects: [{ project_id: ID(51), restricted: false }, { project_id: ID(52), restricted: false }],
    [HIDDEN]: [],
  };
  await assert.rejects(
    mount({ canUpdate: ownsOnly() }).filters['items.update']({ project_id: ID(52) }, { collection: 'physical_samples', keys: [S] }, ctx({ database: fakeDb([], [], tables) })),
    denied(/physical_samples /),
  );
});

// ---- A1b switch (maintainer ruling): no non-admin may change `restricted` in A1a --------------------------------

test('until A1b: an owner (or a co-owner, or an editor) PATCHing restricted on any of the four records is refused; an admin is not', async () => {
  await untilA1b(async () => {
    for (const [collection, pk] of [['physical_samples', 'sample_id'], ['manufacturing_operations', 'operation_id'], ['test_sessions', 'session_id'], ['campaigns', 'campaign_id']]) {
      const database = () => ownerDb([{ [pk]: 'k1', owner_person_id: 'p1', restricted: false }]);
      const meta = { collection, keys: ['k1'] };
      // the OWNER passes the delete rule and is still refused
      for (const who of ['owner', 'editor']) {
        const { filters } = mount({ canUpdate: who === 'owner' ? () => true : ownsOnly() });
        const err = await refusal(filters['items.update']({ restricted: true }, meta, ctx({ database: database() })));
        assert.deepEqual(kindOf(err), ['restricted', 'Restricting a record is not available yet. Ask an administrator.'], `${collection} ${who}`);
        assert.equal(err.extensions.collection, collection);
      }
      const { filters } = mount({ canUpdate: () => true });
      // lifting it, and a value spelled the other way, are changes too
      const locked = ownerDb([{ [pk]: 'k1', owner_person_id: 'p1', restricted: true }]);
      await assert.rejects(filters['items.update']({ restricted: false }, meta, ctx({ database: locked })), denied(new RegExp(collection)));
      await assert.rejects(filters['items.update']({ restricted: 't', notes: 'x' }, meta, ctx({ database: database() })), denied(new RegExp(collection)));
      // a form save that sends the stored value, and any other field, still pass
      await filters['items.update']({ restricted: false, notes: 'x' }, meta, ctx({ database: database() }));
      await filters['items.update']({ notes: 'x' }, meta, ctx({ database: database() }));
      // admins and internal calls
      await filters['items.update']({ restricted: true }, meta, ctx({ database: database(), accountability: { user: 'a', admin: true } }));
      await filters['items.update']({ restricted: true }, meta, ctx({ database: database(), accountability: null }));
    }
  });
});

test('until A1b: a project PI PATCHing restricted on a project is refused, an admin is not, a form save is fine', async () => {
  await untilA1b(async () => {
    const tables = { projects: [{ project_id: 'pj1', restricted: false }] };
    const meta = { collection: 'projects', keys: ['pj1'] };
    const { filters } = mount({ canUpdate: () => true });
    const err = await refusal(filters['items.update']({ restricted: true }, meta, ctx({ database: fakeDb([], [], tables) })));
    assert.deepEqual(kindOf(err), ['restricted', 'Restricting a record is not available yet. Ask an administrator.']);
    await filters['items.update']({ restricted: false, notes: 'x' }, meta, ctx({ database: fakeDb([], [], tables) }));
    await filters['items.update']({ restricted: true }, meta, ctx({ database: fakeDb([], [], tables), accountability: { user: 'a', admin: true } }));
  });
});

test('until A1b: creating a record already restricted is refused for a member, creating an open one is not', async () => {
  await untilA1b(async () => {
    const { filters } = mount({ canUpdate: () => true });
    for (const collection of ['physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects']) {
      const meta = { collection };
      const err = await refusal(filters['items.create']({ restricted: true }, meta, ctx()));
      assert.equal(err.extensions.kind, 'restricted', collection);
      await assert.rejects(filters['items.create']([{ restricted: false }, { restricted: 'yes' }], meta, ctx()), denied(new RegExp(collection)));
      await filters['items.create']({ restricted: false }, meta, ctx());
      await filters['items.create']({ restricted: 'f' }, meta, ctx());
      await filters['items.create']({ notes: 'x' }, meta, ctx());
      await filters['items.create']({ restricted: true }, meta, ctx({ accountability: { user: 'a', admin: true } }));
      await filters['items.create']({ restricted: true }, meta, ctx({ accountability: null }));
    }
  });
});

test('with the switch open (A1b), the owner-only rules underneath apply again: the owner may restrict, an editor may not', async () => {
  const meta = { collection: 'physical_samples', keys: ['s1'] };
  const database = () => ownerDb([{ sample_id: 's1', owner_person_id: 'p1', restricted: false }]);
  await mount({ canUpdate: () => true }).filters['items.update']({ restricted: true }, meta, ctx({ database: database() }));
  const err = await refusal(mount({ canUpdate: ownsOnly() }).filters['items.update']({ restricted: true }, meta, ctx({ database: database() })));
  assert.equal(err.message, "Only the sample's owner can restrict it or lift the restriction.");
});

test('I1: a nested { sample_id } item is read like a bare id, on update and on create', async () => {
  const T = ID(60);
  const S = ID(61);
  const S3 = ID(62);
  const tables = {
    test_sessions_subject: [{ id: 10, test_sessions_id: T, item: S3, collection: 'physical_samples' }],
    test_sessions: [{ session_id: T, restricted: false, sample_id: S3 }],
    physical_samples: [{ sample_id: S, restricted: false }, { sample_id: S3, restricted: false }],
    [HIDDEN]: hid('physical_samples', S),
  };
  const editor = () => mount({ canUpdate: ownsOnly() });
  // moving onto the hidden sample S with the nested form, from an open one
  await assert.rejects(
    editor().filters['items.update']({ item: { sample_id: S } }, { collection: 'test_sessions_subject', keys: [10] }, ctx({ database: fakeDb([], [], tables) })),
    denied(/test_sessions /),
  );
  // the same nested value as stored is not a move; a nested object naming the open sample is fine
  await editor().filters['items.update']({ item: { sample_id: S3 } }, { collection: 'test_sessions_subject', keys: [10] }, ctx({ database: fakeDb([], [], tables) }));
  // creating a subject row on the hidden sample with the nested form
  const row = { test_sessions_id: T, collection: 'physical_samples', item: { sample_id: S } };
  await assert.rejects(editor().filters['items.create'](row, { collection: 'test_sessions_subject' }, ctx({ database: fakeDb([], [], tables) })), denied(/test_sessions /));
  await mount({ canUpdate: ownsOnly(`test_sessions:${T}`) }).filters['items.create'](row, { collection: 'test_sessions_subject' }, ctx({ database: fakeDb([], [], tables) }));
  // a nested item of another collection is not a sample
  await editor().filters['items.create']({ ...row, collection: 'something_else' }, { collection: 'test_sessions_subject' }, ctx({ database: fakeDb([], [], tables) }));
});

// ---- Ruling O3: a record becomes team-owned only through Transfer ownership ---------------------------------

const OWNABLE = ['physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns'];

test('a non-admin cannot create a record with owner_team_id (Ruling O3), on all four ownable collections', async () => {
  const { filters } = mount();
  for (const collection of OWNABLE) {
    await assert.rejects(
      filters['items.create']({ owner_team_id: 'team-1' }, { collection }, ctx()),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'FORBIDDEN');
        assert.equal(err.message, 'A record becomes team-owned through Transfer ownership');
        assert.equal(err.extensions.source, 'd1-access-guard');
        assert.equal(err.extensions.kind, 'owner');
        assert.equal(err.extensions.collection, collection);
        return true;
      },
      collection,
    );
  }
});

test('a batch create is refused when any item sets owner_team_id; a nested team object counts too', async () => {
  const { filters } = mount();
  await assert.rejects(filters['items.create']([{ nickname: 'a' }, { owner_team_id: 'team-1' }], { collection: 'physical_samples' }, ctx()), /Transfer ownership/);
  await assert.rejects(filters['items.create']({ owner_team_id: { team_id: 'team-1' } }, { collection: 'campaigns' }, ctx()), /Transfer ownership/);
});

test('owner_team_id null, empty or absent is fine on create; so is a person owner', async () => {
  const { filters } = mount();
  for (const payload of [{ nickname: 'a' }, { owner_team_id: null }, { owner_team_id: '' }, { owner_person_id: 'p1', owner_team_id: null }]) {
    assert.equal(await filters['items.create'](payload, { collection: 'physical_samples' }, ctx()), payload);
  }
});

test('an admin and an internal call may create a team-owned record; other collections are not touched', async () => {
  const { filters } = mount();
  const payload = { owner_team_id: 'team-1' };
  assert.equal(await filters['items.create'](payload, { collection: 'physical_samples' }, ctx({ accountability: { user: 'a', admin: true } })), payload);
  assert.equal(await filters['items.create'](payload, { collection: 'physical_samples' }, ctx({ accountability: null })), payload);
  assert.equal(await filters['items.create'](payload, { collection: 'projects' }, ctx()), payload);
  assert.equal(await filters['items.create'](payload, { collection: 'sample_genealogy' }, ctx()), payload);
});
