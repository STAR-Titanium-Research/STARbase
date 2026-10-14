// Run with: node --test core/extensions/d1-build/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import endpoint, {
  COLLECTION_PK, HttpError, KIND_COLLECTION, LIMITS, RESERVED_FIELDS, SQL, buildPlan, computeChecks, mount, orderOperations,
  parseRequired, summarise, validateDraftBody, validateName,
} from './index.js';

// ---- fakes -----------------------------------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ALICE = ID(1);
const BOB = ID(2);
const NOW = new Date('2026-10-14T09:00:00.000Z');

// An Express-ish router that remembers its handlers, and a response that remembers what was sent.
function fakeRouter() {
  const routes = new Map();
  const add = (method) => (path, fn) => routes.set(`${method} ${path}`, fn);
  return { routes, get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE') };
}
function fakeRes() {
  const res = { statusCode: 200, body: undefined, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

// The tables of d1_private that d1-build uses, behind a fake knex: raw(sql, bindings) is answered by the SQL text.
function fakeWorld() {
  return {
    drafts: [], seq: 0, clock: 0,
    // records the caller can read (what ItemsService answers), by collection then lower-case id
    records: { physical_samples: new Map(), manufacturing_operations: new Map(), test_sessions: new Map() },
    required: [], // directus_fields rows { collection, field, translations }
    refOps: [], refTests: [], refSubjects: [], // what points at a sample
    deniedReads: new Set(),
  };
}
const seed = (world, collection, rows) => {
  for (const r of rows) world.records[collection].set(r[COLLECTION_PK[collection]].toLowerCase(), r);
};
// The csv argument of the "any of these ids" statements.
const csvOf = (b) => String(b[0]).split(',').filter(Boolean);
function fakeServices(world, log = { built: [], reads: [] }) {
  class ItemsService {
    constructor(collection, options) {
      this.collection = collection;
      log.built.push({ collection, options });
    }

    async readByQuery(query) {
      log.reads.push({ collection: this.collection, query });
      if (world.deniedReads.has(this.collection)) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
      const pk = COLLECTION_PK[this.collection];
      const rows = [];
      for (const id of query.filter[pk]._in) {
        const r = world.records[this.collection]?.get(String(id).toLowerCase());
        if (r) rows.push(Object.fromEntries(query.fields.map((f) => [f, r[f]])));
      }
      return rows;
    }
  }
  return { ItemsService, log };
}
function fakeDatabase(world) {
  const stamp = () => new Date(NOW.getTime() + (world.clock += 1000));
  const draft = (id, user) => world.drafts.find((d) => d.draft_id === id && d.user_id === user);
  const pick = (d) => ({ draft_id: d.draft_id, name: d.name, body: d.body, version: d.version, updated_at: d.updated_at });
  const raw = async (sql, b = []) => {
    switch (sql) {
      case SQL.listDrafts:
        return { rows: world.drafts.filter((d) => d.user_id === b[0]).sort((x, y) => y.updated_at - x.updated_at).map(pick) };
      case SQL.getDraft: {
        const d = draft(b[0], b[1]);
        return { rows: d ? [pick(d)] : [] };
      }
      case SQL.insertDraft: {
        const d = {
          draft_id: ID(900 + (world.seq += 1)), user_id: b[0], name: b[1], body: JSON.parse(b[2]), version: 1,
          updated_at: stamp(),
        };
        world.drafts.push(d);
        return { rows: [pick(d)] };
      }
      case SQL.updateDraft: {
        const [name, body, id, user, version] = b;
        const d = draft(id, user);
        if (!d || d.version !== version) return { rows: [] };
        if (name !== null) d.name = name;
        if (body !== null) d.body = JSON.parse(body);
        d.version += 1;
        d.updated_at = stamp();
        return { rows: [pick(d)] };
      }
      case SQL.deleteDraft: {
        const before = world.drafts.length;
        world.drafts = world.drafts.filter((d) => !(d.draft_id === b[0] && d.user_id === b[1]));
        return { rows: [], rowCount: before - world.drafts.length };
      }
      case SQL.requiredFields:
        return { rows: world.required };
      case SQL.sampleInfo:
        return { rows: csvOf(b).map((id) => world.records.physical_samples.get(id)).filter(Boolean)
          .map((r) => ({ sample_id: r.sample_id, sample_code: r.sample_code, current_status: r.current_status })) };
      case SQL.refsOperations:
        return { rows: world.refOps.filter((r) => csvOf(b).includes(r.sample_id) || csvOf(b).includes(r.output_sample_id)) };
      case SQL.refsTests:
        return { rows: world.refTests.filter((r) => csvOf(b).includes(r.sample_id)) };
      case SQL.refsSubjects:
        return { rows: world.refSubjects.filter((r) => csvOf(b).includes(r.sample_id)) };
      default:
        throw new Error(`unexpected SQL: ${sql}`);
    }
  };
  return { raw };
}

function setup() {
  const world = fakeWorld();
  const router = fakeRouter();
  const logged = [];
  const logger = { error: (m) => logged.push(m), warn: (m) => logged.push(m) };
  const fake = fakeServices(world);
  mount(router, { database: fakeDatabase(world), logger, services: { ItemsService: fake.ItemsService }, getSchema: async () => ({ schema: true }) }, () => NOW);
  const call = async (method, path, { user = ALICE, params = {}, body, admin = false } = {}) => {
    const handler = router.routes.get(`${method} ${path}`);
    assert.ok(handler, `no route ${method} ${path}`);
    const res = fakeRes();
    await handler({ accountability: user ? { user, admin } : null, params, body }, res);
    return res;
  };
  return { world, router, call, logged, log: fake.log };
}

const emptyBody = () => ({ v: 1, projectId: null, campaignId: null, items: [], wires: [], positions: {} });
const op = (key, extra = {}) => ({ key, kind: 'operation', workState: 'planned', values: {}, rows: [{ key: `${key}r1` }], ...extra });
const sample = (key, extra = {}) => ({ key, kind: 'sample', values: {}, ...extra });
const test_ = (key, extra = {}) => ({ key, kind: 'test', workState: 'planned', values: {}, ...extra });

// ---- validateDraftBody -----------------------------------------------------------------------------------------------

test('validateDraftBody: an empty draft and a built one are accepted as they are', () => {
  const empty = emptyBody();
  assert.deepEqual(validateDraftBody(empty), { ok: true, body: empty });
  const built = {
    ...emptyBody(),
    projectId: ID(50),
    items: [sample('n1', { existing: { id: ID(10), version: 3 } }), op('n2', { values: { method_id: ID(11) } }), test_('n3', { workState: 'done' })],
    wires: [{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }, { from: { key: 'n2', row: 0 }, to: { key: 'n3' } }],
    positions: { n1: { x: 0, y: 10 }, n2: { x: 200.5, y: -3 } },
  };
  assert.equal(validateDraftBody(built).ok, true);
});

test('validateDraftBody: every malformed shape is refused with a plain message', () => {
  const good = () => emptyBody();
  const cases = [
    [null, /object/],
    [[], /object/],
    [{ ...good(), v: 2 }, /v: 1/],
    [{ ...good(), v: undefined }, /v: 1/],
    [{ ...good(), projectId: 'x' }, /projectId/],
    [{ ...good(), campaignId: 5 }, /campaignId/],
    [{ ...good(), items: {} }, /items/],
    [{ ...good(), wires: null }, /wires/],
    [{ ...good(), positions: [] }, /positions/],
    [{ ...good(), items: [null] }, /items\[0\]/],
    [{ ...good(), items: [{ ...sample('bad key!') }] }, /key/],
    [{ ...good(), items: [{ ...sample('a'), kind: 'node' }] }, /kind/],
    [{ ...good(), items: [{ ...sample('a'), values: [] }] }, /values/],
    [{ ...good(), items: [{ ...sample('a'), values: { 'Sample Code': 1 } }] }, /field name/],
    [{ ...good(), items: [{ ...sample('a'), values: { sample_id: ID(1) } }] }, /sample_id/],
    [{ ...good(), items: [{ ...sample('a'), values: { current_status: 'active' } }] }, /current_status/],
    [{ ...good(), items: [op('a', { values: { sample_id: ID(1) } })] }, /sample_id/],
    [{ ...good(), items: [op('a', { values: { work_state: 'done' } })] }, /work_state/],
    [{ ...good(), items: [op('a', { values: { batch_id: ID(1) } })] }, /batch_id/],
    [{ ...good(), items: [test_('a', { values: { subject: [] } })] }, /subject/],
    [{ ...good(), items: [sample('a', { existing: { id: 'nope', version: 1 } })] }, /existing/],
    [{ ...good(), items: [sample('a', { existing: { id: ID(1), version: 1.5 } })] }, /existing/],
    [{ ...good(), items: [sample('a', { remove: false })] }, /remove/],
    [{ ...good(), items: [op('a', { workState: 'maybe' })] }, /workState/],
    [{ ...good(), items: [op('a', { workState: undefined })] }, /workState/],
    [{ ...good(), items: [sample('a', { attach: true })] }, /attach/],
    [{ ...good(), items: [op('a', { attach: false })] }, /attach/],
    [{ ...good(), items: [op('a', { rows: 'one' })] }, /rows/],
    [{ ...good(), items: [op('a', { rows: [{ key: '' }] })] }, /rows\[0\]/],
    [{ ...good(), wires: [null] }, /wires\[0\]/],
    [{ ...good(), wires: [{ from: { key: 'a' } }] }, /to/],
    [{ ...good(), wires: [{ from: { key: 'a', row: -1 }, to: { key: 'b' } }] }, /row/],
    [{ ...good(), wires: [{ from: { key: 'a' }, to: { key: 'b', row: 'x' } }] }, /row/],
    [{ ...good(), positions: { 'a b': { x: 1, y: 1 } } }, /positions/],
    [{ ...good(), positions: { a: { x: 'one', y: 1 } } }, /positions.a/],
    [{ ...good(), positions: { a: { x: Infinity, y: 1 } } }, /positions.a/],
  ];
  for (const [input, message] of cases) {
    const out = validateDraftBody(input);
    assert.equal(out.ok, false, JSON.stringify(input));
    assert.match(out.message, message, JSON.stringify(input));
    assert.doesNotMatch(out.message, /undefined|\[object/);
  }
});

test('validateDraftBody: size limits', () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(`n${i}`));
  assert.match(validateDraftBody({ ...emptyBody(), items: many(LIMITS.items + 1, (k) => sample(k)) }).message, /at most/);
  assert.match(validateDraftBody({ ...emptyBody(), wires: many(LIMITS.wires + 1, () => ({ from: { key: 'a' }, to: { key: 'b' } })) }).message, /at most/);
  assert.match(validateDraftBody({ ...emptyBody(), items: [op('a', { rows: many(LIMITS.rows + 1, (k) => ({ key: k })) })] }).message, /too many rows/);
  assert.match(validateDraftBody({ ...emptyBody(), items: [sample('a', { values: { notes: 'x'.repeat(LIMITS.bodyChars) } })] }).message, /too large/);
});

test('validateDraftBody: an item may carry extra properties of its own, which are kept', () => {
  const body = { ...emptyBody(), items: [sample('a', { label: 'my disc' })] };
  assert.equal(validateDraftBody(body).body.items[0].label, 'my disc');
});

test('the reserved fields are the wiring-owned ones, per kind', () => {
  for (const kind of Object.keys(KIND_COLLECTION)) assert.ok(RESERVED_FIELDS[kind].includes('version'), kind);
  assert.ok(RESERVED_FIELDS.operation.includes('output_sample_id'));
  assert.ok(RESERVED_FIELDS.test.includes('subject'));
  assert.ok(!RESERVED_FIELDS.operation.includes('planned_date'), 'the planned date is the draft\'s to set');
});

test('validateName: trimmed, 1 to 200 characters', () => {
  assert.deepEqual(validateName('  Cut run  '), { ok: true, name: 'Cut run' });
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName(5).ok, false);
  assert.equal(validateName(null).ok, false);
  assert.equal(validateName('x'.repeat(LIMITS.name)).ok, true);
  assert.equal(validateName('x'.repeat(LIMITS.name + 1)).ok, false);
});

// ---- summarise -------------------------------------------------------------------------------------------------------

test('summarise: what Create would make, in words', () => {
  assert.equal(summarise(emptyBody()), 'Empty');
  assert.equal(summarise(undefined), 'Empty');
  const body = {
    ...emptyBody(),
    items: [
      sample('s1'), sample('s2'), sample('s3'), sample('s4'),
      op('o1', { rows: [{ key: 'a' }, { key: 'b' }] }),
      op('o2'),
      test_('t1'),
    ],
  };
  assert.equal(summarise(body), '3 operations, 4 samples, 1 test');
});

test('summarise: a sample already on the map is not made again; edits and removals are counted apart', () => {
  const body = {
    ...emptyBody(),
    items: [
      sample('s1', { existing: { id: ID(10), version: 1 } }),
      sample('s2'),
      op('o1', { existing: { id: ID(11), version: 1 }, values: { machining_feed_mm_per_rev: 0.2 } }),
      op('o2', { existing: { id: ID(12), version: 1 }, attach: true }),
      op('o3', { existing: { id: ID(13), version: 1 }, remove: true }),
      op('o4', { rows: [] }),
    ],
  };
  assert.equal(summarise(body), '1 operation, 1 sample, 2 changes to existing records, 1 removal');
});

// ---- the router and its drafts ---------------------------------------------------------------------------------------

test('the module registers as the d1-build endpoint', () => {
  assert.equal(endpoint.id, 'd1-build');
  const router = fakeRouter();
  endpoint.handler(router, { database: fakeDatabase(fakeWorld()), logger: {} });
  for (const r of ['GET /drafts', 'POST /drafts', 'GET /drafts/:id', 'PATCH /drafts/:id', 'DELETE /drafts/:id']) {
    assert.ok(router.routes.has(r), r);
  }
});

test('every route needs a signed-in user', async () => {
  const { router, call, world } = setup();
  for (const key of router.routes.keys()) {
    const [method, path] = key.split(' ');
    const res = await call(method, path, { user: null, params: { id: ID(900) }, body: {} });
    assert.equal(res.statusCode, 401, key);
    assert.equal(res.body.errors[0].extensions.code, 'UNAUTHORIZED');
    assert.equal(res.body.errors[0].extensions.source, 'd1-build');
  }
  assert.equal(world.drafts.length, 0);
});

test('POST /drafts keeps a draft for its owner, with the name given or a dated default', async () => {
  const { call, world } = setup();
  const body = { ...emptyBody(), items: [sample('n1')] };
  const named = await call('POST', '/drafts', { body: { name: '  First cut  ', body } });
  assert.equal(named.statusCode, 201);
  assert.deepEqual(Object.keys(named.body.data).sort(), ['body', 'id', 'name', 'updated_at', 'version']);
  assert.equal(named.body.data.name, 'First cut');
  assert.equal(named.body.data.version, 1);
  assert.deepEqual(named.body.data.body, body);
  assert.match(named.body.data.updated_at, /^2026-10-14T09:00:0\d\.000Z$/);
  const unnamed = await call('POST', '/drafts', { body: { body } });
  assert.equal(unnamed.body.data.name, 'Draft · 2026-10-14');
  assert.equal(world.drafts.length, 2);
  assert.ok(world.drafts.every((d) => d.user_id === ALICE));
});

test('POST /drafts refuses a bad body or name with 400 and stores nothing', async () => {
  const { call, world } = setup();
  for (const payload of [undefined, null, [], {}, { body: { v: 2 } }, { body: emptyBody(), name: '  ' }, { body: emptyBody(), name: 7 }]) {
    const res = await call('POST', '/drafts', { body: payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.body.errors[0].extensions.code, 'INVALID_PAYLOAD');
  }
  assert.equal(world.drafts.length, 0);
});

test('GET /drafts lists only the caller\'s drafts, newest first, with a summary line', async () => {
  const { call } = setup();
  const one = await call('POST', '/drafts', { body: { name: 'older', body: { ...emptyBody(), items: [sample('n1')] } } });
  await call('POST', '/drafts', { user: BOB, body: { name: 'bobs', body: emptyBody() } });
  const two = await call('POST', '/drafts', { body: { name: 'newer', body: { ...emptyBody(), items: [op('n1'), sample('n2'), sample('n3')] } } });
  const res = await call('GET', '/drafts');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.map((d) => d.name), ['newer', 'older']);
  assert.deepEqual(res.body.data.map((d) => d.id), [two.body.data.id, one.body.data.id]);
  assert.deepEqual(res.body.data.map((d) => d.summary), ['1 operation, 2 samples', '1 sample']);
  assert.deepEqual(Object.keys(res.body.data[0]).sort(), ['id', 'name', 'summary', 'updated_at']);
  assert.equal(res.body.data[0].body, undefined, 'the list does not carry the bodies');
  assert.deepEqual((await call('GET', '/drafts', { user: BOB })).body.data.map((d) => d.name), ['bobs']);
  assert.deepEqual((await call('GET', '/drafts', { user: ID(3) })).body.data, []);
});

test('GET /drafts/:id: the owner reads it; anyone else, or a bad id, gets 404', async () => {
  const { call } = setup();
  const made = (await call('POST', '/drafts', { body: { name: 'mine', body: emptyBody() } })).body.data;
  const mine = await call('GET', '/drafts/:id', { params: { id: made.id } });
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.body.data, made);
  for (const [user, id] of [[BOB, made.id], [ALICE, ID(404)], [ALICE, 'not-a-uuid'], [ALICE, undefined]]) {
    const res = await call('GET', '/drafts/:id', { user, params: { id } });
    assert.equal(res.statusCode, 404, String(id));
    assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND');
  }
});

test('PATCH /drafts/:id: a save at the stored version bumps it; a stale one is a 409 and changes nothing', async () => {
  const { call, world } = setup();
  const made = (await call('POST', '/drafts', { body: { name: 'mine', body: emptyBody() } })).body.data;
  const next = { ...emptyBody(), items: [sample('n1')] };
  const saved = await call('PATCH', '/drafts/:id', { params: { id: made.id }, body: { body: next, version: 1 } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.data.version, 2);
  assert.equal(saved.body.data.name, 'mine', 'a body-only save keeps the name');
  assert.deepEqual(saved.body.data.body, next);
  const renamed = await call('PATCH', '/drafts/:id', { params: { id: made.id }, body: { name: ' Renamed ', version: 2 } });
  assert.equal(renamed.body.data.name, 'Renamed');
  assert.deepEqual(renamed.body.data.body, next, 'a name-only save keeps the body');
  assert.equal(renamed.body.data.version, 3);

  const stale = await call('PATCH', '/drafts/:id', { params: { id: made.id }, body: { body: emptyBody(), version: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.errors[0].extensions.code, 'CONFLICT');
  assert.match(stale.body.errors[0].message, /another tab/);
  assert.equal(world.drafts[0].version, 3);
  assert.deepEqual(world.drafts[0].body, next);
});

test('PATCH /drafts/:id: someone else\'s draft is a 404 whatever the version; bad input is a 400', async () => {
  const { call, world } = setup();
  const made = (await call('POST', '/drafts', { body: { name: 'mine', body: emptyBody() } })).body.data;
  const other = await call('PATCH', '/drafts/:id', { user: BOB, params: { id: made.id }, body: { name: 'taken', version: 1 } });
  assert.equal(other.statusCode, 404);
  assert.equal(world.drafts[0].name, 'mine');
  const gone = await call('PATCH', '/drafts/:id', { params: { id: ID(404) }, body: { name: 'x', version: 1 } });
  assert.equal(gone.statusCode, 404);
  const bad = [
    undefined, [], {}, { name: 'x' }, { name: 'x', version: 0 }, { name: 'x', version: '1' }, { version: 1 },
    { name: ' ', version: 1 }, { body: { v: 3 }, version: 1 }, { body: emptyBody(), name: 5, version: 1 },
  ];
  for (const payload of bad) {
    const res = await call('PATCH', '/drafts/:id', { params: { id: made.id }, body: payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(world.drafts[0].version, 1);
});

test('DELETE /drafts/:id: the owner discards it; anyone else gets 404 and it stays', async () => {
  const { call, world } = setup();
  const made = (await call('POST', '/drafts', { body: { name: 'mine', body: emptyBody() } })).body.data;
  const other = await call('DELETE', '/drafts/:id', { user: BOB, params: { id: made.id } });
  assert.equal(other.statusCode, 404);
  assert.equal(world.drafts.length, 1);
  const res = await call('DELETE', '/drafts/:id', { params: { id: made.id } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(world.drafts.length, 0);
  assert.equal((await call('DELETE', '/drafts/:id', { params: { id: made.id } })).statusCode, 404);
});

test('an unexpected failure is a plain 500 and is logged, not leaked', async () => {
  const router = fakeRouter();
  const logged = [];
  mount(router, {
    database: { raw: async () => { throw new Error('connection to server at "10.0.0.5" refused'); } },
    logger: { error: (m) => logged.push(m) },
  }, () => NOW);
  const res = fakeRes();
  await router.routes.get('GET /drafts')({ accountability: { user: ALICE } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.errors[0].extensions.code, 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(res.body), /10\.0\.0\.5/);
  assert.match(logged[0], /10\.0\.0\.5/);
});

test('HttpError carries its status, code and extras', () => {
  const e = new HttpError(409, 'CHECKS', 'no', { checks: [] });
  assert.equal(e.status, 409);
  assert.equal(e.code, 'CHECKS');
  assert.deepEqual(e.extra, { checks: [] });
});

// ---- planning: orderOperations ---------------------------------------------------------------------------------------

test('orderOperations: a record waits for the one that makes its sample, the rest keep the draft order', () => {
  const rec = (key, index, input, output, after) => ({ key, index, input, output, after });
  // draft order: c, b, a — but b works on what a makes, and c on what b makes
  const out = orderOperations([
    rec('c', 0, 'item:s2', null),
    rec('b', 1, 'item:s1', 'item:s2'),
    rec('a', 2, 'id:root', 'item:s1'),
  ]);
  assert.deepEqual(out.order.map((r) => r.key), ['a', 'b', 'c']);
  assert.deepEqual(out.cyclic, []);
});

test('orderOperations: in-place passes on one sample keep the order they were laid out in', () => {
  const rec = (key, index) => ({ key, index, input: 'id:disc', output: null });
  const out = orderOperations([rec('p3', 2), rec('p1', 0), rec('p2', 1)]);
  assert.deepEqual(out.order.map((r) => r.key), ['p1', 'p2', 'p3']);
});

test('orderOperations: an explicit operation-to-operation wire orders its two ends', () => {
  const out = orderOperations([
    { key: 'second', index: 0, input: 'id:x', output: null, after: ['first'] },
    { key: 'first', index: 1, input: 'id:x', output: null },
    { key: 'unrelated', index: 2, input: null, output: 'item:y', after: ['gone'] },
  ]);
  assert.deepEqual(out.order.map((r) => r.key), ['first', 'second', 'unrelated']);
});

test('orderOperations: rows of one operation (one input, several outputs) stay together in row order', () => {
  const out = orderOperations([0, 1, 2, 3].map((i) => ({ key: `r${i}`, index: i, input: 'id:disc', output: `item:n${i}` })));
  assert.deepEqual(out.order.map((r) => r.key), ['r0', 'r1', 'r2', 'r3']);
});

test('orderOperations: a loop is reported and still returned, in draft order', () => {
  const out = orderOperations([
    { key: 'a', index: 0, input: 'item:y', output: 'item:x' },
    { key: 'b', index: 1, input: 'item:x', output: 'item:y' },
    { key: 'c', index: 2, input: 'id:z', output: null },
  ]);
  assert.deepEqual(out.order.map((r) => r.key), ['c', 'a', 'b']);
  assert.deepEqual(out.cyclic, ['a', 'b']);
  assert.deepEqual(orderOperations([]), { order: [], cyclic: [] });
});

// ---- planning: buildPlan and the checks ------------------------------------------------------------------------------

const METHOD = ID(20);
const MATERIAL = ID(21);
const ENV = ID(22);
const sampleRow = (n, extra = {}) => ({
  sample_id: ID(n), version: 1, sample_code: `S-${n}`, current_status: 'active', material_id: MATERIAL, form: 'disc',
  primary_method_id: METHOD, project_id: null, ...extra,
});
const opRow = (n, extra = {}) => ({
  operation_id: ID(n), version: 1, pass_code: `OP-${n}`, sample_id: null, output_sample_id: null, method_id: METHOD,
  work_state: 'planned', batch_id: null, ...extra,
});
const testRow = (n, extra = {}) => ({ session_id: ID(n), version: 1, test_code: `T-${n}`, work_state: 'planned', test_type: 'hardness', ...extra });
const known = (...rows) => new Map(rows.map((r) => [String(r.operation_id ?? r.session_id ?? r.sample_id).toLowerCase(), r]));
const REQUIRED = parseRequired([
  { collection: 'physical_samples', field: 'material_id', translations: [{ language: 'en-US', translation: 'Material' }] },
  { collection: 'physical_samples', field: 'form', translations: [{ language: 'en-US', translation: 'Form' }] },
  { collection: 'physical_samples', field: 'primary_method_id', translations: '[{"language":"en-US","translation":"Primary method"}]' },
  { collection: 'manufacturing_operations', field: 'method_id', translations: null },
  { collection: 'manufacturing_operations', field: 'operation_date', translations: [{ language: 'en-US', translation: 'Operation date' }] },
  { collection: 'manufacturing_operations', field: 'sample_id', translations: null },
  { collection: 'test_sessions', field: 'test_type', translations: [{ language: 'en-US', translation: 'Test type' }] },
  { collection: 'test_sessions', field: 'session_date', translations: [{ language: 'en-US', translation: 'Session date' }] },
]);
const draft = (items, wires = []) => ({ ...emptyBody(), items, wires });
const wire = (from, to) => ({ from, to });
const w = (key, row) => (row === undefined ? { key } : { key, row });
const mop = (key, values = {}, extra = {}) => op(key, { values: { method_id: METHOD, ...values }, ...extra });
const code = (v = 'X') => ({ sample_code: v });
const where = (checks, key, field) => checks.filter((c) => c.key === key && (field === undefined || c.field === field));
const levels = (checks) => checks.map((c) => `${c.level}:${c.key}:${c.field ?? '-'}`).sort();

test('parseRequired: labels come from the English translation, else the field name', () => {
  assert.deepEqual(REQUIRED.physical_samples, [
    { field: 'material_id', label: 'Material' }, { field: 'form', label: 'Form' }, { field: 'primary_method_id', label: 'Primary method' },
  ]);
  assert.deepEqual(REQUIRED.manufacturing_operations[0], { field: 'method_id', label: 'method_id' });
  assert.deepEqual(parseRequired(undefined), {});
  assert.deepEqual(parseRequired([{ collection: 'a', field: 'f', translations: 'not json' }]), { a: [{ field: 'f', label: 'f' }] });
});

// A cut: one existing disc, one planned operation with three rows, three planned pieces.
function cutDraft(extra = {}) {
  return draft(
    [
      sample('s0', { existing: { id: ID(10), version: 1 } }),
      mop('o1', {}, { rows: [{ key: 'r1' }, { key: 'r2' }, { key: 'r3' }], ...extra }),
      sample('n10', { values: code('{seq}-A-MC-2026-10-14') }),
      sample('n2', { values: code('{seq}-A-MC-2026-10-14') }),
      sample('n3', { values: code('{seq}-A-MC-2026-10-14') }),
    ],
    [
      wire(w('s0'), w('o1')),
      wire(w('o1', 0), w('n10')),
      wire(w('o1', 1), w('n2')),
      wire(w('o1', 2), w('n3')),
    ],
  );
}

test('a planned cut: three rows tied by one batch, three planned pieces that inherit, only warnings', () => {
  const { checks, plan } = buildPlan(cutDraft(), { existing: known(sampleRow(10)), required: REQUIRED });
  assert.deepEqual(levels(checks), ['warn:o1:equipment_id', 'warn:o1:planned_date']);
  // the pieces, in key order (n2 before n10), planned, with what they inherit from the disc and the method
  assert.deepEqual(plan.samples.map((s) => [s.key, s.planned]), [['n2', true], ['n3', true], ['n10', true]]);
  for (const s of plan.samples) {
    assert.equal(s.values.material_id, MATERIAL);
    assert.equal(s.values.form, 'disc');
    assert.equal(s.values.primary_method_id, METHOD);
    assert.equal(s.values.sample_code, '{seq}-A-MC-2026-10-14');
  }
  // one operation record per row, all on the disc, each with its own output, tied by the batch of the operation
  assert.deepEqual(plan.operations.map((r) => [r.key, r.itemKey, r.rowIndex, r.input, r.output, r.batchKey]), [
    ['r1', 'o1', 0, `id:${ID(10)}`, 'item:n10', 'o1'],
    ['r2', 'o1', 1, `id:${ID(10)}`, 'item:n2', 'o1'],
    ['r3', 'o1', 2, `id:${ID(10)}`, 'item:n3', 'o1'],
  ]);
  assert.deepEqual(plan.batches.map((b) => b.key), ['o1']);
  assert.deepEqual(plan.removals, { tests: [], operations: [], samples: [] });
  assert.deepEqual(plan.edits, []);
});

test('an operation with one row is not batched', () => {
  const body = draft([sample('s0', { existing: { id: ID(10), version: 1 } }), mop('o1')], [wire(w('s0'), w('o1'))]);
  const { plan } = buildPlan(body, { existing: known(sampleRow(10)) });
  assert.equal(plan.operations[0].batchKey, null);
  assert.deepEqual(plan.batches, []);
});

test('every check is { key, field?, level, text }, in plain words, never the glossary words it must not use', () => {
  const body = draft([mop('o1', { method_id: '' }), sample('n1'), test_('t1')]);
  const { checks } = buildPlan(body, { required: REQUIRED });
  assert.ok(checks.length >= 4);
  for (const c of checks) {
    assert.deepEqual(Object.keys(c).filter((k) => !['key', 'field', 'level', 'text'].includes(k)), []);
    assert.ok(['block', 'warn'].includes(c.level));
    assert.ok(typeof c.text === 'string' && c.text.endsWith('.') || c.text.endsWith('review.'), c.text);
    assert.doesNotMatch(c.text, /\bnode\b|\bsave\b|supervisor|undefined|null/i, c.text);
  }
});

test('an operation needs a method, and something to work on or make', () => {
  const body = draft([mop('o1', { method_id: '  ' }), sample('s0', { existing: { id: ID(10), version: 1 } })]);
  const { checks } = buildPlan(body, { existing: known(sampleRow(10)) });
  assert.deepEqual(where(checks, 'o1', 'method_id'), [{ key: 'o1', field: 'method_id', level: 'block', text: 'Choose a method.' }]);
  assert.equal(where(checks, 'o1').filter((c) => c.level === 'block' && !c.field).length, 1);
  assert.match(where(checks, 'o1').find((c) => !c.field && c.level === 'block').text, /Wire a sample into this operation/);
  // an output alone is enough: the operation makes a sample from nothing (a sintering run)
  const made = draft([mop('o1'), sample('n1', { values: code() })], [wire(w('o1', 0), w('n1'))]);
  assert.deepEqual(buildPlan(made, {}).checks.filter((c) => c.level === 'block'), []);
});

test('in place: wiring the same sample back out leaves no output, and passes keep the draft order', () => {
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('p2'), mop('p1')],
    [wire(w('s0'), w('p2')), wire(w('p2', 0), w('s0')), wire(w('s0'), w('p1'))],
  );
  const { checks, plan } = buildPlan(body, { existing: known(sampleRow(10)) });
  assert.deepEqual(checks.filter((c) => c.level === 'block'), []);
  assert.deepEqual(plan.operations.map((r) => [r.itemKey, r.input, r.output]), [['p2', `id:${ID(10)}`, null], ['p1', `id:${ID(10)}`, null]]);
});

test('an operation wired from another operation continues on the sample that one leaves behind', () => {
  // s0 -> a (in place) -> b -> n1 (b makes n1 from s0, because a leaves s0 in place)
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('b'), mop('a'), sample('n1', { values: code() })],
    [wire(w('s0'), w('a')), wire(w('a', 0), w('b', 0)), wire(w('b', 0), w('n1'))],
  );
  const { checks, plan } = buildPlan(body, { existing: known(sampleRow(10)) });
  assert.deepEqual(checks.filter((c) => c.level === 'block'), []);
  // a is written first although b is first in the draft
  assert.deepEqual(plan.operations.map((r) => [r.itemKey, r.input, r.output]), [
    ['a', `id:${ID(10)}`, null], ['b', `id:${ID(10)}`, 'item:n1'],
  ]);
  // and a chain through a made sample: s0 -> a -> n1 -> b2 -> n2
  const chain = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('b2'), mop('a2'), sample('n1', { values: code() }), sample('n2', { values: code() })],
    [wire(w('s0'), w('a2')), wire(w('a2', 0), w('n1')), wire(w('n1'), w('b2')), wire(w('b2', 0), w('n2'))],
  );
  const out = buildPlan(chain, { existing: known(sampleRow(10)) }).plan.operations;
  assert.deepEqual(out.map((r) => r.itemKey), ['a2', 'b2']);
});

test('what a sample inherits flows down a chain, and its own values win', () => {
  const body = draft(
    [
      sample('s0', { existing: { id: ID(10), version: 1 } }),
      mop('a', { method_id: ID(31) }), mop('b', { method_id: ID(32) }),
      sample('n1', { values: { ...code(), form: 'ring' } }), sample('n2', { values: code() }),
    ],
    [wire(w('s0'), w('a')), wire(w('a', 0), w('n1')), wire(w('n1'), w('b')), wire(w('b', 0), w('n2'))],
  );
  const { plan } = buildPlan(body, { existing: known(sampleRow(10, { form: 'bar' })) });
  const by = Object.fromEntries(plan.samples.map((s) => [s.key, s.values]));
  assert.equal(by.n1.form, 'ring');
  assert.equal(by.n1.primary_method_id, ID(31));
  assert.equal(by.n1.material_id, MATERIAL);
  assert.equal(by.n2.form, 'ring', 'inherited from n1, not from the disc');
  assert.equal(by.n2.primary_method_id, ID(32));
});

test('the draft\'s project goes on new samples unless the card says otherwise', () => {
  const body = { ...draft([sample('n1', { values: code() }), sample('n2', { values: { ...code(), project_id: ID(61) } })]), projectId: ID(60) };
  const by = Object.fromEntries(buildPlan(body, {}).plan.samples.map((s) => [s.key, s.values.project_id]));
  assert.deepEqual(by, { n1: ID(60), n2: ID(61) });
});

test('a new sample needs a code', () => {
  const { checks } = buildPlan(draft([sample('n1'), sample('n2', { values: { sample_code: '   ' } })]), {});
  assert.deepEqual(where(checks, 'n1', 'sample_code').map((c) => c.level), ['block']);
  assert.deepEqual(where(checks, 'n2', 'sample_code').map((c) => c.level), ['block']);
});

test('a test needs a type and a sample, which may come through an operation', () => {
  const lone = buildPlan(draft([test_('t1')]), {}).checks;
  assert.deepEqual(where(lone, 't1').filter((c) => c.level === 'block').map((c) => c.field).sort(), ['subject', 'test_type']);
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('o1'), sample('n1', { values: code() }), test_('t1', { values: { test_type: 'hardness' } }), test_('t2', { values: { test_type: 'tensile' } })],
    [wire(w('s0'), w('o1')), wire(w('o1', 0), w('n1')), wire(w('s0'), w('t1')), wire(w('o1', 0), w('t2')), wire(w('n1'), w('t2'))],
  );
  const { checks, plan } = buildPlan(body, { existing: known(sampleRow(10)) });
  assert.deepEqual(checks.filter((c) => c.level === 'block'), []);
  assert.deepEqual(plan.tests.map((t) => [t.key, t.subjects]), [['t1', [`id:${ID(10)}`]], ['t2', ['item:n1']]]);
});

test('an operation on a free sample: the test is wired to the sample the operation leaves in place', () => {
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('o1'), test_('t1', { values: { test_type: 'hardness' } })],
    [wire(w('s0'), w('o1')), wire(w('o1', 0), w('t1'))],
  );
  assert.deepEqual(buildPlan(body, { existing: known(sampleRow(10)) }).plan.tests[0].subjects, [`id:${ID(10)}`]);
});

test('planned records need only their structure; done ones need what the forms mark required', () => {
  const planned = draft([mop('o1', {}, { workState: 'planned' }), test_('t1', { values: { test_type: 'hardness' } })]);
  const p = buildPlan(planned, { required: REQUIRED }).checks.filter((c) => c.level === 'block');
  assert.deepEqual(levels(p), ['block:o1:-', 'block:t1:subject']);
  const done = draft([mop('o1', {}, { workState: 'done' }), test_('t1', { workState: 'done', values: { test_type: 'hardness' } })]);
  const d = buildPlan(done, { required: REQUIRED }).checks.filter((c) => c.level === 'block');
  assert.deepEqual(levels(d), ['block:o1:-', 'block:o1:operation_date', 'block:t1:session_date', 'block:t1:subject']);
  assert.equal(where(d, 'o1', 'operation_date')[0].text, 'Operation date is required.');
  // a field the wiring sets (sample_id) is never asked of the card; a method is not asked twice
  assert.deepEqual(where(buildPlan(draft([mop('o1', { method_id: '' }, { workState: 'done' })]), { required: REQUIRED }).checks, 'o1', 'method_id').length, 1);
  assert.equal(where(d, 'o1', 'sample_id').length, 0);
  // filled in, a done operation passes
  const ok = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('o1', { operation_date: '2026-10-14' }, { workState: 'done' })],
    [wire(w('s0'), w('o1'))],
  );
  assert.deepEqual(buildPlan(ok, { existing: known(sampleRow(10)), required: REQUIRED }).checks.filter((c) => c.level === 'block'), []);
});

test('a sample made by a done operation needs what the forms require, after inheriting; one made by a planned operation does not', () => {
  const bare = sampleRow(10, { material_id: null, form: null });
  const make = (workState) => draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), mop('o1', { operation_date: '2026-10-14' }, { workState }), sample('n1', { values: code() })],
    [wire(w('s0'), w('o1')), wire(w('o1', 0), w('n1'))],
  );
  const done = buildPlan(make('done'), { existing: known(bare), required: REQUIRED });
  assert.deepEqual(levels(done.checks.filter((c) => c.level === 'block')), ['block:n1:form', 'block:n1:material_id']);
  assert.equal(where(done.checks, 'n1', 'form')[0].text, 'Form is required.');
  assert.equal(done.plan.samples[0].planned, false);
  const planned = buildPlan(make('planned'), { existing: known(bare), required: REQUIRED });
  assert.deepEqual(planned.checks.filter((c) => c.level === 'block'), []);
  assert.equal(planned.plan.samples[0].planned, true);
  // a sample with nothing to inherit from is asked for everything until filled in
  const free = buildPlan(draft([sample('n1', { values: code() })]), { required: REQUIRED }).checks;
  assert.deepEqual(levels(free), ['block:n1:form', 'block:n1:material_id', 'block:n1:primary_method_id']);
  const filled = buildPlan(draft([sample('n1', { values: { ...code(), material_id: MATERIAL, form: 'bar', primary_method_id: METHOD } })]), { required: REQUIRED }).checks;
  assert.deepEqual(filled, []);
});

test('warnings: no machine, no planned date; a chosen machine and date clear them', () => {
  const bare = buildPlan(draft([mop('o1'), test_('t1', { values: { test_type: 'x' } })]), {}).checks.filter((c) => c.level === 'warn');
  assert.deepEqual(levels(bare), ['warn:o1:equipment_id', 'warn:o1:planned_date', 'warn:t1:equipment_id', 'warn:t1:planned_date']);
  const set = buildPlan(draft([mop('o1', { equipment_id: ENV, planned_date: '2026-10-20' }), mop('o2', { equipment_id: ENV }, { workState: 'done' })]), {}).checks;
  assert.deepEqual(levels(set.filter((c) => c.level === 'warn')), []);
});

test('wires: dangling, impossible and doubled wires are blocking checks', () => {
  const s = (k) => sample(k, { values: code() });
  const dangling = buildPlan(draft([mop('o1')], [wire(w('ghost'), w('o1'))]), {}).checks;
  assert.match(where(dangling, 'o1').find((c) => c.level === 'block' && /no longer in the draft/.test(c.text)).text, /A wire points/);
  const odd = buildPlan(draft([s('n1'), s('n2')], [wire(w('n1'), w('n2'))]), {}).checks;
  assert.equal(where(odd, 'n1').filter((c) => /cannot be wired/.test(c.text)).length, 1);
  const twoIn = buildPlan(draft([s('n1'), s('n2'), mop('o1')], [wire(w('n1'), w('o1')), wire(w('n2'), w('o1'))]), {}).checks;
  assert.equal(where(twoIn, 'o1').filter((c) => /More than one wire/.test(c.text)).length, 1);
  const twoOut = buildPlan(draft([s('n1'), s('n2'), mop('o1')], [wire(w('o1', 0), w('n1')), wire(w('o1', 0), w('n2'))]), {}).checks;
  assert.equal(where(twoOut, 'o1').filter((c) => /More than one sample is wired out/.test(c.text)).length, 1);
  const badRow = buildPlan(draft([s('n1'), mop('o1')], [wire(w('o1', 3), w('n1'))]), {}).checks;
  assert.equal(where(badRow, 'o1').filter((c) => /does not have/.test(c.text)).length, 1);
  const several = buildPlan(draft([s('n1'), mop('o1', {}, { rows: [{ key: 'a' }, { key: 'b' }] })], [wire(w('o1'), w('n1'))]), {}).checks;
  assert.equal(where(several, 'o1').filter((c) => /Say which row/.test(c.text)).length, 1);
});

test('two operations that make the same sample, and operations wired in a loop, are refused', () => {
  const two = draft(
    [mop('o1'), mop('o2'), sample('n1', { values: code() })],
    [wire(w('o1', 0), w('n1')), wire(w('o2', 0), w('n1'))],
  );
  assert.equal(where(buildPlan(two, {}).checks, 'n1').filter((c) => /More than one operation makes/.test(c.text)).length, 1);
  const loop = draft([mop('a'), mop('b')], [wire(w('a', 0), w('b', 0)), wire(w('b', 0), w('a', 0))]);
  const checks = buildPlan(loop, {}).checks;
  assert.ok(checks.some((c) => c.level === 'block' && /wired in a loop/.test(c.text)));
});

test('two cards with one key are a blocking check, and the first card wins', () => {
  const { checks, plan } = buildPlan(draft([sample('n1', { values: code('A') }), sample('n1', { values: code('B') })]), {});
  assert.ok(checks.some((c) => c.level === 'block' && c.key === 'n1' && /share a key/.test(c.text)));
  assert.deepEqual(plan.samples.map((s) => s.values.sample_code), ['A']);
});

// -- records that exist already

test('an existing record that is gone or no longer readable blocks; one that was only added is just reviewed when it changed', () => {
  const body = draft([
    sample('s1', { existing: { id: ID(10), version: 1 } }),
    sample('s2', { existing: { id: ID(11), version: 1 } }),
    sample('s3', { existing: { id: ID(12), version: 1 } }),
  ]);
  const { checks } = buildPlan(body, { existing: known(sampleRow(10), sampleRow(11, { version: 4 })) });
  assert.deepEqual(levels(checks), ['block:s3:-', 'warn:s2:-']);
  assert.match(where(checks, 's3')[0].text, /no longer exists, or you can no longer see it/);
  assert.equal(where(checks, 's2')[0].text, 'Changed since you added it — review.');
});

test('an edit made against an older version is blocking; the same record unchanged is a warning', () => {
  const edit = draft([mop('o1', { machining_feed_mm_per_rev: 0.2 }, { existing: { id: ID(40), version: 2 } })]);
  const { checks, plan } = buildPlan(edit, { existing: known(opRow(40, { version: 3 })) });
  assert.deepEqual(levels(checks), ['block:o1:-']);
  assert.deepEqual(plan.edits, [{ key: 'o1', collection: 'manufacturing_operations', id: ID(40), version: 2, values: { method_id: METHOD, machining_feed_mm_per_rev: 0.2 } }]);
  const fresh = buildPlan(edit, { existing: known(opRow(40, { version: 2 })) });
  assert.deepEqual(fresh.checks, []);
  const plain = draft([op('o1', { existing: { id: ID(40), version: 2 } })]);
  assert.deepEqual(levels(buildPlan(plain, { existing: known(opRow(40, { version: 3 })) }).checks), ['warn:o1:-']);
  assert.deepEqual(buildPlan(plain, { existing: known(opRow(40, { version: 2 })) }).plan.edits, [], 'no values, no edit');
});

test('attach: an existing operation without an input gets one from a wire; once it has an input it is blocking', () => {
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), op('o1', { existing: { id: ID(40), version: 1 }, attach: true })],
    [wire(w('s0'), w('o1'))],
  );
  const ok = buildPlan(body, { existing: known(sampleRow(10), opRow(40)) });
  assert.deepEqual(ok.checks, []);
  assert.deepEqual(ok.plan.operations.map((r) => [r.key, r.mode, r.existingId, r.version, r.input, r.output]), [
    ['o1r1', 'attach', ID(40), 1, `id:${ID(10)}`, null],
  ]);
  const taken = buildPlan(body, { existing: known(sampleRow(10), opRow(40, { sample_id: ID(11) })) });
  assert.deepEqual(levels(taken.checks), ['block:o1:-']);
  assert.match(where(taken.checks, 'o1')[0].text, /got an input in the meantime/);
  const unwired = buildPlan(draft([op('o1', { existing: { id: ID(40), version: 1 }, attach: true })]), { existing: known(opRow(40)) });
  assert.match(where(unwired.checks, 'o1')[0].text, /Wire a sample into this operation to attach it/);
});

test('the wires of an existing operation that is not being attached are left alone', () => {
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 } }), sample('s1', { existing: { id: ID(11), version: 1 } }), op('o1', { existing: { id: ID(40), version: 1 } })],
    [wire(w('s0'), w('o1')), wire(w('o1', 0), w('s1'))],
  );
  const { checks, plan } = buildPlan(body, { existing: known(sampleRow(10), sampleRow(11), opRow(40, { sample_id: ID(12) })) });
  assert.deepEqual(checks, []);
  assert.deepEqual(plan.operations, []);
});

test('a new operation can be wired from the output of an existing one', () => {
  const body = draft(
    [op('old', { existing: { id: ID(40), version: 1 } }), mop('o1'), sample('n1', { values: code() })],
    [wire(w('old', 0), w('o1', 0)), wire(w('o1', 0), w('n1'))],
  );
  const ctx = { existing: known(opRow(40, { sample_id: ID(10), output_sample_id: ID(11) }), sampleRow(10), sampleRow(11, { form: 'bar' })) };
  const { checks, plan } = buildPlan(body, ctx);
  assert.deepEqual(checks.filter((c) => c.level === 'block'), []);
  assert.equal(plan.operations[0].input, `id:${ID(11)}`, 'continues on the existing operation\'s output');
  assert.equal(plan.samples[0].values.form, 'bar', 'and inherits from it');
});

// -- removals

test('removing a planned operation takes its planned output with it', () => {
  const body = draft([op('o1', { existing: { id: ID(40), version: 1 }, remove: true })]);
  const ctx = {
    existing: known(opRow(40, { sample_id: ID(10), output_sample_id: ID(11) })),
    outputs: new Map([[ID(11), { code: 'S-11', status: 'planned' }]]),
    refs: [{ kind: 'operation', id: ID(40), work_state: 'planned', sampleIds: [ID(10), ID(11)] }],
  };
  const { checks, plan } = buildPlan(body, ctx);
  assert.deepEqual(checks, []);
  assert.deepEqual(plan.removals, { tests: [], operations: [{ key: 'o1', id: ID(40) }], samples: [{ key: 'o1', id: ID(11) }] });
});

test('an output that is no longer planned stays when its operation is removed', () => {
  const body = draft([op('o1', { existing: { id: ID(40), version: 1 }, remove: true })]);
  const ctx = { existing: known(opRow(40, { output_sample_id: ID(11) })), outputs: new Map([[ID(11), { code: 'S-11', status: 'active' }]]) };
  assert.deepEqual(buildPlan(body, ctx).plan.removals.samples, []);
});

test('removal is refused while something done hangs off the output, and asks for the planned ones to go too', () => {
  const body = draft([op('o1', { existing: { id: ID(40), version: 1 }, remove: true })]);
  const base = { existing: known(opRow(40, { sample_id: ID(10), output_sample_id: ID(11) })), outputs: new Map([[ID(11), { code: 'S-11', status: 'planned' }]]) };
  const done = buildPlan(body, { ...base, refs: [{ kind: 'test', id: ID(50), work_state: 'done', sampleIds: [ID(11)] }] }).checks;
  assert.deepEqual(done, [{ key: 'o1', level: 'block', text: 'Something done hangs off S-11, so it cannot be removed.' }]);
  const planned = buildPlan(body, { ...base, refs: [{ kind: 'operation', id: ID(41), work_state: 'planned', sampleIds: [ID(11)] }] }).checks;
  assert.deepEqual(planned, [{ key: 'o1', level: 'block', text: 'Something planned still hangs off S-11. Remove that too.' }]);
  // removed in the same draft, it no longer hangs there
  const both = draft([
    op('o1', { existing: { id: ID(40), version: 1 }, remove: true }),
    op('o2', { existing: { id: ID(41), version: 1 }, remove: true }),
  ]);
  const ctx = {
    existing: known(opRow(40, { sample_id: ID(10), output_sample_id: ID(11) }), opRow(41, { sample_id: ID(11) })),
    outputs: base.outputs,
    refs: [{ kind: 'operation', id: ID(41), work_state: 'planned', sampleIds: [ID(11)] }],
  };
  const out = buildPlan(both, ctx);
  assert.deepEqual(out.checks, []);
  assert.deepEqual(out.plan.removals.operations.map((r) => r.key), ['o1', 'o2']);
});

test('done records are never deleted from the map', () => {
  const body = draft([
    op('o1', { existing: { id: ID(40), version: 1 }, remove: true }),
    test_('t1', { existing: { id: ID(50), version: 1 }, remove: true }),
    sample('s1', { existing: { id: ID(10), version: 1 }, remove: true }),
  ]);
  const { checks, plan } = buildPlan(body, { existing: known(opRow(40, { work_state: 'done' }), testRow(50, { work_state: 'done' }), sampleRow(10)) });
  assert.deepEqual(levels(checks), ['block:o1:-', 'block:s1:-', 'block:t1:-']);
  assert.ok(checks.every((c) => c.text === 'Done records are never deleted from the map.'));
  assert.deepEqual(plan.removals, { tests: [], operations: [], samples: [] });
});

test('a planned test and a planned sample can be removed; a removed record that is already gone is a warning', () => {
  const body = draft([
    test_('t1', { existing: { id: ID(50), version: 1 }, remove: true }),
    sample('s1', { existing: { id: ID(10), version: 1 }, remove: true }),
    test_('t2', { existing: { id: ID(51), version: 1 }, remove: true }),
  ]);
  const ctx = { existing: known(testRow(50), sampleRow(10, { current_status: 'planned' })), outputs: new Map([[ID(10), { code: 'S-10', status: 'planned' }]]) };
  const { checks, plan } = buildPlan(body, ctx);
  assert.deepEqual(levels(checks), ['warn:t2:-']);
  assert.deepEqual(plan.removals, { tests: [{ key: 't1', id: ID(50) }], operations: [], samples: [{ key: 's1', id: ID(10) }] });
});

test('new cards cannot be wired to something that is being removed', () => {
  const body = draft(
    [sample('s0', { existing: { id: ID(10), version: 1 }, remove: true }), mop('o1')],
    [wire(w('s0'), w('o1'))],
  );
  const ctx = { existing: known(sampleRow(10, { current_status: 'planned' })), outputs: new Map([[ID(10), { code: 'S-10', status: 'planned' }]]) };
  const { checks } = buildPlan(body, ctx);
  assert.ok(checks.some((c) => c.key === 'o1' && c.level === 'block' && /being removed/.test(c.text)));
  // and one wired to the output of a removed operation, through an existing sample that goes
  const via = draft(
    [op('old', { existing: { id: ID(40), version: 1 }, remove: true }), sample('keep', { existing: { id: ID(11), version: 1 } }), mop('o2')],
    [wire(w('keep'), w('o2'))],
  );
  const c2 = buildPlan(via, {
    existing: known(opRow(40, { output_sample_id: ID(11) }), sampleRow(11)),
    outputs: new Map([[ID(11), { code: 'S-11', status: 'planned' }]]),
  }).checks;
  assert.ok(c2.some((c) => c.key === 'o2' && c.level === 'block' && /S-11, which is being removed/.test(c.text)));
});

// -- the route

test('POST /drafts/:id/check answers the checks for the owner\'s draft, reading records as the caller', async () => {
  const { call, world, log } = setup();
  seed(world, 'physical_samples', [sampleRow(10)]);
  world.required = [{ collection: 'manufacturing_operations', field: 'operation_date', translations: [{ language: 'en-US', translation: 'Operation date' }] }];
  const body = draft([sample('s0', { existing: { id: ID(10), version: 1 } }), mop('o1', {}, { workState: 'done' })], [wire(w('s0'), w('o1'))]);
  const made = (await call('POST', '/drafts', { body: { name: 'x', body } })).body.data;
  const res = await call('POST', '/drafts/:id/check', { params: { id: made.id } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.data), ['checks']);
  assert.deepEqual(levels(res.body.data.checks), ['block:o1:operation_date', 'warn:o1:equipment_id']);
  // the record read went through ItemsService with the caller's accountability and the schema
  assert.deepEqual(log.built.map((b) => [b.collection, b.options.accountability.user, b.options.schema, 'knex' in b.options]), [
    ['physical_samples', ALICE, { schema: true }, false],
  ]);
  assert.deepEqual(log.reads.map((r) => r.collection), ['physical_samples']);
  assert.deepEqual(log.reads[0].query.filter, { sample_id: { _in: [ID(10)] } });
  assert.equal((await call('POST', '/drafts/:id/check', { user: BOB, params: { id: made.id } })).statusCode, 404);
  assert.equal((await call('POST', '/drafts/:id/check', { params: { id: ID(404) } })).statusCode, 404);
});

test('check: a record the caller may not read is reported gone; the stale version shows as a warning', async () => {
  const { call, world } = setup();
  seed(world, 'physical_samples', [sampleRow(10, { version: 5 })]);
  const body = draft([sample('s0', { existing: { id: ID(10), version: 1 } }), op('o1', { existing: { id: ID(40), version: 1 } })]);
  const made = (await call('POST', '/drafts', { body: { name: 'x', body } })).body.data;
  world.deniedReads.add('manufacturing_operations');
  const res = await call('POST', '/drafts/:id/check', { params: { id: made.id } });
  assert.deepEqual(levels(res.body.data.checks), ['block:o1:-', 'warn:s0:-']);
});

test('check: for a removal it reads the planned output and what points at it, as the system', async () => {
  const { call, world } = setup();
  seed(world, 'manufacturing_operations', [opRow(40, { sample_id: ID(10), output_sample_id: ID(11) })]);
  seed(world, 'physical_samples', [sampleRow(11, { current_status: 'planned' })]);
  world.refTests = [{ session_id: ID(50), work_state: 'done', sample_id: ID(11) }];
  world.refSubjects = [{ session_id: ID(50), work_state: 'done', sample_id: ID(11) }, { session_id: ID(51), work_state: 'planned', sample_id: ID(11) }];
  world.refOps = [{ operation_id: ID(40), work_state: 'planned', sample_id: ID(10), output_sample_id: ID(11) }];
  const body = draft([op('o1', { existing: { id: ID(40), version: 1 }, remove: true })]);
  const made = (await call('POST', '/drafts', { body: { name: 'x', body } })).body.data;
  const res = await call('POST', '/drafts/:id/check', { params: { id: made.id } });
  assert.deepEqual(res.body.data.checks, [{ key: 'o1', level: 'block', text: 'Something done hangs off S-11, so it cannot be removed.' }]);
});

test('computeChecks is buildPlan\'s checks', () => {
  const body = draft([sample('n1')]);
  assert.deepEqual(computeChecks(body, {}), buildPlan(body, {}).checks);
});
