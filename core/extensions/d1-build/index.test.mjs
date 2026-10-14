// Run with: node --test core/extensions/d1-build/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import endpoint, {
  HttpError, KIND_COLLECTION, LIMITS, RESERVED_FIELDS, SQL, mount, summarise, validateDraftBody, validateName,
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
  return { drafts: [], seq: 0, clock: 0 };
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
  mount(router, { database: fakeDatabase(world), logger }, () => NOW);
  const call = async (method, path, { user = ALICE, params = {}, body, admin = false } = {}) => {
    const handler = router.routes.get(`${method} ${path}`);
    assert.ok(handler, `no route ${method} ${path}`);
    const res = fakeRes();
    await handler({ accountability: user ? { user, admin } : null, params, body }, res);
    return res;
  };
  return { world, router, call, logged };
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
