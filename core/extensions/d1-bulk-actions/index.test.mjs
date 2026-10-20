// Run with: node --test core/extensions/d1-bulk-actions/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLLECTIONS } from '../d1-record-access/index.js';
import { BULK_FIELDS, KINDS, canonical, checkValue, mount, normaliseValue, snapshotsEqual } from './index.js';

// ---- ids and the world ----------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = { member: ID(31), super: ID(32), viewer: '10000001-0000-0000-0000-000000000003' };
const POLICY = { admin: ID(41), member: ID(42) };
const P = { ann: ID(101), bob: ID(102), eve: ID(103), adm: ID(104) };
const U = { ann: ID(201), bob: ID(202), eve: ID(203), admin: ID(204), viewer: ID(205) };
const S = { one: ID(1), two: ID(2), three: ID(3), four: ID(4), five: ID(5) };
const PRJ = { open: ID(11), hidden: ID(12) };
const CAMP = ID(21);
const T0 = new Date('2026-10-20T12:00:00.000Z');

const baseTables = () => ({
  people: [
    { person_id: P.ann, full_name: 'Ann Owner', user_id: U.ann },
    { person_id: P.bob, full_name: 'Bob Other', user_id: U.bob },
    { person_id: P.eve, full_name: 'Eve Owner', user_id: U.eve },
    { person_id: P.adm, full_name: 'Ada Admin', user_id: U.admin },
  ],
  directus_users: [
    { id: U.ann, email: 'ann@login.example', role: R.member },
    { id: U.bob, email: 'bob@login.example', role: R.member },
    { id: U.eve, email: 'eve@login.example', role: R.member },
    { id: U.admin, email: 'admin@login.example', role: R.super },
    { id: U.viewer, email: 'viewer@login.example', role: R.viewer },
  ],
  directus_access: [{ role: R.member, user: null, policy: POLICY.member }, { role: R.super, user: null, policy: POLICY.admin }],
  directus_policies: [{ id: POLICY.admin, admin_access: true }, { id: POLICY.member, admin_access: false }],
  physical_samples: [
    { sample_id: S.one, sample_code: 'SM-001', owner_person_id: P.ann, owner_team_id: null, restricted: false, current_status: 'active', project_id: null, mounted: null, export_controlled: false, manufactured_date: '2026-01-02' },
    { sample_id: S.two, sample_code: 'SM-002', owner_person_id: P.ann, owner_team_id: null, restricted: false, current_status: 'active', project_id: null, mounted: true, export_controlled: false, manufactured_date: null },
    { sample_id: S.three, sample_code: 'SM-003', owner_person_id: P.ann, owner_team_id: null, restricted: true, current_status: 'consumed', project_id: PRJ.open, mounted: null, export_controlled: false, manufactured_date: null },
    { sample_id: S.four, sample_code: 'SM-004', owner_person_id: P.bob, owner_team_id: null, restricted: false, current_status: 'active', project_id: null, mounted: null, export_controlled: false, manufactured_date: null },
    { sample_id: S.five, sample_code: 'SM-005', owner_person_id: P.bob, owner_team_id: null, restricted: false, current_status: 'active', project_id: null, mounted: null, export_controlled: false, manufactured_date: null },
  ],
  projects: [
    { project_id: PRJ.open, project_code: 'PRJ-1', project_name: 'Open project', restricted: false },
    { project_id: PRJ.hidden, project_code: 'PRJ-2', project_name: 'Hidden project', restricted: true },
  ],
  campaigns: [{ campaign_id: CAMP, campaign_code: 'CMP-1', name: 'Campaign', owner_person_id: P.ann, owner_team_id: null, restricted: false }],
  manufacturing_operations: [],
  test_sessions: [],
  sample_access: [
    { sample_id: S.one, person_id: P.bob, role: 'view', team_access_id: null },
    { sample_id: S.one, person_id: P.ann, role: 'own', team_access_id: null }, // the database-held owner grant: never snapshotted
  ],
  sample_team_access: [],
  bulk_actions: [],
  bulk_action_rows: [],
});

// ---- a tiny in-memory knex ----------------------------------------------------------------------------

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
let seq = 7000;

function makeDb(tables, log) {
  const db = (table) => {
    const preds = [];
    let order = null;
    let max = Infinity;
    let skip = 0;
    const rows = () => {
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (order) out = [...out].sort((a, b) => (a[order.col] < b[order.col] ? -1 : a[order.col] > b[order.col] ? 1 : 0) * (order.dir === 'desc' ? -1 : 1));
      return out.slice(skip, skip + max);
    };
    const project = (row, cols) => (row === undefined ? undefined : cols.length ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : { ...row });
    const q = {
      where(a, v) {
        if (typeof a === 'object') for (const [k, val] of Object.entries(a)) preds.push((r) => same(r[k], val));
        else preds.push((r) => same(r[a], v));
        return q;
      },
      whereIn(c, values) { preds.push((r) => values.some((v) => same(r[c], v))); return q; },
      whereNull(c) { preds.push((r) => r[c] === null || r[c] === undefined); return q; },
      orderBy(col, dir = 'asc') { order = { col, dir }; return q; },
      limit(n) { max = n; return q; },
      offset(n) { skip = n; return q; },
      forUpdate() { log.locks.push(table); return q; },
      select: async (...cols) => rows().map((r) => project(r, cols)),
      first: async (...cols) => project(rows()[0], cols),
      insert(input) {
        if (log.failTable === table) throw new Error('connection reset: secret host');
        const list = (Array.isArray(input) ? input : [input]).map((r) => ({ ...r }));
        for (const rec of list) {
          if (table === 'bulk_actions') {
            rec.action_id ??= ID(seq++);
            rec.state ??= 'applied';
            rec.revert_of ??= null;
          }
          if (table === 'bulk_action_rows') {
            rec.revert_outcome ??= null;
            rec.revert_reason ??= null;
            if ((tables[table] ?? []).some((r) => same(r.action_id, rec.action_id) && r.record_id === rec.record_id)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          log.inserts.push({ table, row: rec });
          (tables[table] ??= []).push(rec);
        }
        const done = Promise.resolve(list);
        done.returning = async (col) => list.map((r) => ({ [col]: r[col] }));
        return done;
      },
      update: async (changes) => {
        const hit = rows();
        log.updates.push({ table, changes: { ...changes } });
        for (const r of hit) Object.assign(r, changes);
        return hit.length;
      },
    };
    return q;
  };
  db.raw = async (sql, bindings) => {
    log.raw.push({ sql, bindings, inTx: log.depth > 0 });
    return { rows: [] };
  };
  return db;
}

// ---- a harness ------------------------------------------------------------------------------------------

const guardError = (reason) => Object.assign(new Error(reason), { name: 'DirectusError', status: 403, code: 'FORBIDDEN', extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard' } });
const RESTRICT_REFUSED = 'Restricting a record is not available yet. Ask an administrator.';

// canRead(user, collection, id) decides the caller's reads; guard(acc, collection, id, data) may throw (default: only an administrator restricts).
function setup({ tables = baseTables(), env = {}, canRead = () => true, guard = null, afterUpdate = null, failTable = null } = {}) {
  const log = { failTable, inserts: [], updates: [], raw: [], locks: [], reads: [], writes: [], depth: 0, events: [], caches: [], errors: [], warnings: [], emitted: [], clock: T0 };
  const root = makeDb(tables, log);
  const database = Object.assign((t) => root(t), {
    raw: (...a) => root.raw(...a),
    transaction: async (work) => {
      const snapshot = structuredClone(tables);
      const trx = makeDb(tables, log);
      log.depth += 1;
      try {
        return await work(trx);
      } catch (err) {
        for (const key of Object.keys(tables)) delete tables[key];
        Object.assign(tables, snapshot);
        throw err;
      } finally {
        log.depth -= 1;
      }
    },
  });
  const defaultGuard = (acc, collection, id, data) => {
    if ('restricted' in data && acc.admin !== true) throw guardError(RESTRICT_REFUSED);
  };
  class ItemsService {
    constructor(collection, options) {
      this.collection = collection;
      this.options = options;
    }
    get key() { return COLLECTIONS[this.collection]?.key ?? (this.collection === 'projects' ? 'project_id' : null); }
    db() { return this.options.knex ?? root; }
    async readOne(id, query) {
      log.reads.push({ collection: this.collection, id, caller: this.options.accountability?.user ?? 'system' });
      const acc = this.options.accountability;
      if (acc && !canRead(acc.user, this.collection, id, query.fields)) throw Object.assign(new Error('You do not have permission to access this.'), { status: 403, code: 'FORBIDDEN' });
      const row = await this.db()(this.collection).where(this.key, id).first();
      if (!row) throw Object.assign(new Error('not found'), { status: 403, code: 'FORBIDDEN' });
      return Object.fromEntries(query.fields.map((f) => [f, row[f] ?? null]));
    }
    async updateOne(id, data, opts = {}) {
      const acc = this.options.accountability;
      log.writes.push({ collection: this.collection, id, data, inTrx: Boolean(this.options.knex), caller: acc?.user, opts });
      if (guard) await guard(acc, this.collection, id, data);
      else defaultGuard(acc, this.collection, id, data);
      await this.db()(this.collection).where(this.key, id).update(data);
      if (afterUpdate) await afterUpdate(this.db(), this.collection, id, data);
      opts.bypassEmitAction?.({ event: [`${this.collection}.items.update`], meta: { keys: [id], payload: data, collection: this.collection }, context: { database: root } });
      return id;
    }
  }
  const handlers = {};
  const reg = (method) => (path, fn) => { handlers[`${method} ${path}`] = fn; };
  const router = { get: reg('GET'), post: reg('POST') };
  mount(router, {
    database,
    services: {
      ItemsService,
      UtilsService: class { async clearCache(arg) { log.caches.push(arg); } },
    },
    emitter: { emitAction(event, meta, context) { log.emitted.push({ event, meta, context, committed: log.depth === 0 }); } },
    env,
    logger: { error(m) { log.errors.push(m); }, warn(m) { log.warnings.push(m); } },
  }, () => log.clock);
  return { tables, handlers, log, database };
}

const admin = (user) => ({ user, admin: true, app: true });
const member = (user) => ({ user, admin: false, app: true });

function call(h, { acc, params = {}, query = {}, body, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const out = { status: 200, body: undefined };
    const res = {
      status(code) { out.status = code; return res; },
      json(b) { out.body = b; resolve(out); return res; },
    };
    Promise.resolve(h({ accountability: acc, params, query, body, schema: {}, method }, res)).catch(reject);
  });
}
const errorOf = (r) => r.body?.errors?.[0];
const row = (tables, collection, id) => tables[collection].find((r) => same(r[COLLECTIONS[collection].key], id));
const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r]));

// the request bodies
const restrictBody = (ids, kind = 'restrict') => ({ kind, ids, params: {} });
const editBody = (ids, field, value) => ({ kind: 'edit_field', ids, params: { field, value } });
const preview = (h, acc, collection, body) => call(h.handlers['POST /:collection/preview'], { acc, params: { collection }, body });
const apply = (h, acc, collection, body) => call(h.handlers['POST /:collection/apply'], { acc, params: { collection }, body });
const undo = (h, acc, id) => call(h.handlers['POST /:action_id/undo'], { acc, params: { action_id: id } });
const revert = (h, acc, id) => call(h.handlers['POST /:action_id/revert'], { acc, params: { action_id: id } });

// ---- plumbing ---------------------------------------------------------------------------------------------

test('401 without a user, on every route', async () => {
  const h = setup();
  for (const route of ['POST /:collection/preview', 'POST /:collection/apply', 'POST /:action_id/undo', 'POST /:action_id/revert', 'GET /', 'GET /:action_id']) {
    const r = await call(h.handlers[route], { acc: { user: null }, params: { collection: 'physical_samples', action_id: ID(9) }, body: {} });
    assert.equal(r.status, 401, route);
    assert.equal(errorOf(r).extensions.code, 'UNAUTHORIZED');
    assert.equal(errorOf(r).extensions.source, 'd1-bulk-actions');
  }
});

test('a Lab Viewer is refused on preview, apply, undo and revert (nothing to preview), but may list', async () => {
  const h = setup();
  const acc = member(U.viewer);
  for (const r of [await preview(h, acc, 'physical_samples', restrictBody([S.one])), await apply(h, acc, 'physical_samples', restrictBody([S.one])), await undo(h, acc, ID(9)), await revert(h, acc, ID(9))]) {
    assert.equal(r.status, 403);
    assert.equal(errorOf(r).extensions.code, 'READ_ONLY_ROLE');
  }
  assert.equal(h.log.writes.length, 0);
  const list = await call(h.handlers['GET /'], { acc, method: 'GET' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.actions, []);
});

test('the server knows exactly these kinds', () => {
  assert.deepEqual(KINDS, ['restrict', 'unrestrict', 'edit_field', 'assign_team', 'change_owner', 'share_access', 'remove_access']);
});

// ---- validation -------------------------------------------------------------------------------------------

test('request validation: collection, kind, ids, field and value are 400s before anything is read or written', async () => {
  const h = setup();
  const acc = admin(U.admin);
  const bad = async (collection, body, code = 'INVALID_PAYLOAD', status = 400) => {
    for (const fn of [preview, apply]) {
      const r = await fn(h, acc, collection, body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(errorOf(r).extensions.code, code, JSON.stringify(body));
    }
  };
  await bad('constructor', restrictBody([S.one]));
  await bad('nope', restrictBody([S.one]));
  await bad('physical_samples', { ids: [S.one] }); // no kind
  await bad('physical_samples', restrictBody([S.one], 'delete_everything'));
  await bad('physical_samples', restrictBody([S.one], 'assign_team')); // no team_id
  await bad('physical_samples', restrictBody([]));
  await bad('physical_samples', { kind: 'restrict' });
  await bad('physical_samples', restrictBody(['not-a-uuid']));
  await bad('physical_samples', restrictBody([S.one, 7]));
  await bad('physical_samples', restrictBody(Array.from({ length: 101 }, (_, i) => ID(1000 + i))));
  await bad('projects', restrictBody([PRJ.open]), 'NOT_APPLICABLE');
  await bad('projects', restrictBody([PRJ.open], 'unrestrict'), 'NOT_APPLICABLE');
  await bad('projects', editBody([PRJ.open], 'project_name', 'x'), 'NOT_APPLICABLE');
  await bad('physical_samples', { kind: 'edit_field', ids: [S.one] }); // no params
  await bad('physical_samples', editBody([S.one], 'sample_code', 'X')); // not on the allow-list
  await bad('physical_samples', editBody([S.one], 'constructor', 'X'));
  await bad('physical_samples', { kind: 'edit_field', ids: [S.one], params: { field: 'current_status' } }); // value missing (null clears)
  await bad('physical_samples', editBody([S.one], 'current_status', 'exploded'));
  await bad('physical_samples', editBody([S.one], 'current_status', 'planned')); // planned is left out
  await bad('physical_samples', editBody([S.one], 'current_status', null)); // NOT NULL: cannot be cleared
  await bad('physical_samples', editBody([S.one], 'mounted', 'yes'));
  await bad('physical_samples', editBody([S.one], 'manufactured_date', '2026-02-30'));
  await bad('physical_samples', editBody([S.one], 'manufactured_date', '20 October'));
  await bad('physical_samples', editBody([S.one], 'project_id', 'not-a-uuid'));
  await bad('physical_samples', editBody([S.one], 'project_id', PRJ.hidden.replace(/12$/, '99'))); // does not exist
  assert.equal(h.log.writes.length, 0);
  assert.equal(h.tables.bulk_actions.length, 0);
});

test('a relation value the caller cannot read is refused like one that does not exist (no probing for hidden ids)', async () => {
  const h = setup({ canRead: (user, collection, id) => !(collection === 'projects' && id === PRJ.hidden) });
  const r = await preview(h, member(U.ann), 'physical_samples', editBody([S.one], 'project_id', PRJ.hidden));
  assert.equal(r.status, 400);
  assert.match(errorOf(r).message, /does not exist, or you cannot see it/);
  const ok = await preview(h, member(U.ann), 'physical_samples', editBody([S.one], 'project_id', PRJ.open));
  assert.equal(ok.status, 200);
});

test('the ids are de-duplicated (case-insensitively) before the cap and before any work', async () => {
  const h = setup();
  const r = await preview(h, admin(U.admin), 'physical_samples', restrictBody([S.one, S.one, S.one.toUpperCase(), S.two, ...Array.from({ length: 150 }, () => S.one)]));
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 2);
  assert.equal(r.body.counts.total, 2);
  const exactly100 = Array.from({ length: 100 }, (_, i) => ID(2000 + i));
  assert.equal((await preview(h, admin(U.admin), 'physical_samples', restrictBody(exactly100))).status, 200);
});

test('the allow-list is sane: every field has a kind, enums have values, relations name a table, and only the four ownable collections have one', () => {
  assert.deepEqual(Object.keys(BULK_FIELDS).sort(), ['campaigns', 'manufacturing_operations', 'physical_samples', 'test_sessions']);
  for (const [collection, fields] of Object.entries(BULK_FIELDS)) {
    assert.ok(COLLECTIONS[collection].ownerTeam, collection);
    for (const [field, def] of Object.entries(fields)) {
      assert.ok(['enum', 'relation', 'bool', 'date'].includes(def.kind), `${collection}.${field}`);
      assert.equal(typeof def.clearable, 'boolean');
      if (def.kind === 'enum') assert.ok(def.values.length > 1);
      if (def.kind === 'relation') assert.ok(COLLECTIONS[def.relation.collection]);
    }
  }
  assert.ok(!BULK_FIELDS.physical_samples.current_status.values.includes('planned'));
});

test('pure helpers: normalise, canonical, checkValue', () => {
  assert.equal(normaliseValue('date', new Date('2026-03-04T00:00:00Z')), '2026-03-04');
  assert.equal(normaliseValue('date', '2026-03-04T10:00:00Z'), '2026-03-04');
  assert.equal(normaliseValue('bool', 't'), true);
  assert.equal(normaliseValue('relation', ID(1).toUpperCase()), ID(1));
  assert.equal(normaliseValue('enum', ''), null);
  assert.ok(snapshotsEqual({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 }));
  assert.ok(!snapshotsEqual({ a: 1 }, { a: 2 }));
  assert.equal(canonical({ b: undefined, a: null }), '{"a":null,"b":null}');
  assert.throws(() => checkValue({ kind: 'bool', label: 'X', clearable: true }, 'yes'), /yes or no/);
  assert.equal(checkValue({ kind: 'bool', label: 'X', clearable: true }, null), null);
});

// ---- preview ----------------------------------------------------------------------------------------------

test('preview classifies each record (ok, noop, skip with the guard text, skip as not found with no code) and never writes', async () => {
  const hidden = ID(77);
  const tables = baseTables();
  tables.physical_samples.push({ sample_id: hidden, sample_code: 'SM-SECRET', owner_person_id: P.eve, owner_team_id: null, restricted: true, current_status: 'active', project_id: null, mounted: null, export_controlled: false, manufactured_date: null });
  const h = setup({ tables, canRead: (user, collection, id) => id !== hidden });
  const before = structuredClone(tables);
  // an administrator restricts: S.one ok, S.three already restricted (noop), the hidden one is not found
  let r = await preview(h, admin(U.admin), 'physical_samples', restrictBody([S.one, S.three, hidden, ID(404)]));
  assert.equal(r.status, 200);
  const res = byId(r.body.results);
  assert.deepEqual(res[S.one], { id: S.one, code: 'SM-001', status: 'ok' });
  assert.deepEqual(res[S.three], { id: S.three, code: 'SM-003', status: 'noop' });
  assert.deepEqual(res[hidden], { id: hidden, code: null, status: 'skip', reason: 'That record does not exist, or you cannot see it.' });
  assert.equal(res[ID(404)].status, 'skip');
  assert.equal(res[ID(404)].code, null);
  assert.deepEqual(r.body.counts, { total: 4, ok: 1, noop: 1, skip: 2 });
  // a member is refused by the guard, whose text is the reason
  r = await preview(h, member(U.ann), 'physical_samples', restrictBody([S.one, S.two]));
  assert.deepEqual(r.body.results.map((x) => [x.status, x.reason]), [['skip', RESTRICT_REFUSED], ['skip', RESTRICT_REFUSED]]);
  assert.deepEqual(r.body.counts, { total: 2, ok: 0, noop: 0, skip: 2 });
  // the checks really ran (updateOne was called in a transaction) and left nothing behind
  assert.ok(h.log.writes.length >= 3 && h.log.writes.every((w) => w.inTrx));
  assert.deepEqual(tables, before);
  assert.equal(h.log.inserts.length, 0);
  assert.equal(h.log.emitted.length, 0, 'a preview emits no action events');
  assert.equal(h.log.caches.length, 0);
  assert.ok(h.log.writes.every((w) => typeof w.opts.bypassEmitAction === 'function' && w.opts.autoPurgeCache === false));
});

test('preview and apply agree record by record (same outcomes, same reasons)', async () => {
  const body = restrictBody([S.one, S.three, S.four, ID(404)]);
  for (const acc of [admin(U.admin), member(U.ann)]) {
    const a = setup();
    const p = await preview(a, acc, 'physical_samples', body);
    const b = setup();
    const x = await apply(b, acc, 'physical_samples', body);
    const norm = { ok: 'applied', noop: 'noop', skip: 'skipped' };
    assert.deepEqual(p.body.results.map((r) => [r.id, r.code, norm[r.status], r.reason]), x.body.results.map((r) => [r.id, r.code, r.outcome, r.reason]));
  }
});

test('edit_field preview: already-equal is noop, a different value is ok, null clears', async () => {
  const h = setup();
  let r = await preview(h, member(U.ann), 'physical_samples', editBody([S.one, S.three], 'current_status', 'active'));
  assert.deepEqual(r.body.results.map((x) => x.status), ['noop', 'ok']);
  r = await preview(h, member(U.ann), 'physical_samples', editBody([S.one, S.two], 'mounted', null));
  assert.deepEqual(r.body.results.map((x) => x.status), ['noop', 'ok']); // S.one is already null
  r = await preview(h, member(U.ann), 'physical_samples', editBody([S.one], 'manufactured_date', '2026-01-02'));
  assert.equal(r.body.results[0].status, 'noop');
});

// ---- apply ------------------------------------------------------------------------------------------------

test('apply restrict as an administrator: applied and noop, journaled with snapshots, undo window, events after commit, cache cleared once', async () => {
  const h = setup({ env: { CACHE_ENABLED: 'true' } });
  const r = await apply(h, admin(U.admin), 'physical_samples', restrictBody([S.one, S.three, S.two]));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.counts, { total: 3, applied: 2, noop: 1, skipped: 0, failed: 0 });
  assert.deepEqual(byId(r.body.results)[S.three], { id: S.three, code: 'SM-003', outcome: 'noop' });
  assert.equal(row(h.tables, 'physical_samples', S.one).restricted, true);
  assert.equal(row(h.tables, 'physical_samples', S.two).restricted, true);
  // the action row
  const [action] = h.tables.bulk_actions;
  assert.equal(action.action_id, r.body.action_id);
  assert.equal(action.actor_user, U.admin);
  assert.equal(action.actor_person, P.adm);
  assert.equal(action.collection, 'physical_samples');
  assert.equal(action.kind, 'restrict');
  assert.equal(action.mail_state, 'none');
  assert.equal(action.n_applied, 2);
  assert.equal(action.n_skipped, 1);
  assert.equal(action.n_failed, 0);
  assert.equal(r.body.undo_until, new Date(T0.getTime() + 60_000).toISOString());
  assert.equal(action.undo_until.toISOString(), r.body.undo_until);
  // the journal rows
  const rows = byId(h.tables.bulk_action_rows.map((x) => ({ id: x.record_id, ...x })));
  assert.equal(h.tables.bulk_action_rows.length, 3);
  assert.equal(rows[S.one].outcome, 'applied');
  assert.equal(rows[S.one].record_code, 'SM-001');
  const before = JSON.parse(rows[S.one].before);
  const after = JSON.parse(rows[S.one].after);
  assert.equal(before.restricted, false);
  assert.equal(after.restricted, true);
  assert.deepEqual(before.people, [{ person_id: P.bob, role: 'view' }]); // the owner's own grant is not part of the snapshot
  assert.equal(before.owner_person_id, P.ann);
  assert.equal(rows[S.three].outcome, 'noop');
  // the change and its journal row commit in the same transaction (the row insert happened inside a transaction)
  assert.ok(h.log.inserts.some((i) => i.table === 'bulk_action_rows' && i.row.record_id === S.one));
  // the actor is set for every write transaction, so the audit trigger names the caller
  const actorCalls = h.log.raw.filter((c) => c.sql.includes('d1.actor_identity'));
  assert.ok(actorCalls.length >= 3 && actorCalls.every((c) => c.bindings[0] === U.admin && c.inTx));
  // the writes ran as the caller, inside a transaction, with their events held back
  assert.ok(h.log.writes.every((w) => w.caller === U.admin && w.inTrx && typeof w.opts.bypassEmitAction === 'function'));
  assert.equal(h.log.emitted.length, 2, 'one event per applied record, emitted once each row committed');
  assert.ok(h.log.emitted.every((e) => e.committed));
  assert.equal(h.log.caches.length, 1, 'the cache is cleared once for the whole action');
});

test('apply restrict as a member: the guard refuses, its text is the reason, nothing is written, but the action is journaled', async () => {
  const h = setup();
  const r = await apply(h, member(U.ann), 'physical_samples', restrictBody([S.one, S.two]));
  assert.deepEqual(r.body.counts, { total: 2, applied: 0, noop: 0, skipped: 2, failed: 0 });
  assert.ok(r.body.results.every((x) => x.outcome === 'skipped' && x.reason === RESTRICT_REFUSED));
  assert.equal(row(h.tables, 'physical_samples', S.one).restricted, false);
  assert.equal(h.tables.bulk_actions.length, 1);
  assert.equal(h.tables.bulk_actions[0].n_skipped, 2);
  assert.equal(h.tables.bulk_action_rows.length, 2);
  assert.ok(h.tables.bulk_action_rows.every((x) => x.outcome === 'skipped' && x.reason === RESTRICT_REFUSED));
  assert.equal(h.log.emitted.length, 0);
  assert.equal(h.log.caches.length, 0);
});

test('unrestrict mirrors restrict', async () => {
  const h = setup();
  const r = await apply(h, admin(U.admin), 'physical_samples', restrictBody([S.three, S.one], 'unrestrict'));
  assert.deepEqual(r.body.counts, { total: 2, applied: 1, noop: 1, skipped: 0, failed: 0 });
  assert.equal(row(h.tables, 'physical_samples', S.three).restricted, false);
});

test('apply edit_field with partial success: applied, noop, refused by a rule, failed with a message, failed by a database error (generic and logged)', async () => {
  const guard = (acc, collection, id, data) => {
    if (id === S.two) throw guardError('Only the owner can change this.');
    if (id === S.four) throw Object.assign(new Error('Value for field "current_status" is invalid.'), { status: 400, code: 'FAILED_VALIDATION' });
    if (id === S.five) throw Object.assign(new Error('insert or update on table "physical_samples" violates foreign key constraint "x_fkey"'), { code: '23503' });
  };
  const h = setup({ guard });
  const r = await apply(h, member(U.ann), 'physical_samples', editBody([S.one, S.two, S.three, S.four, S.five], 'current_status', 'archived'));
  const res = byId(r.body.results);
  assert.equal(res[S.one].outcome, 'applied');
  assert.deepEqual(res[S.two], { id: S.two, code: 'SM-002', outcome: 'skipped', reason: 'Only the owner can change this.' });
  assert.equal(res[S.three].outcome, 'applied');
  assert.deepEqual(res[S.four], { id: S.four, code: 'SM-004', outcome: 'failed', reason: 'Value for field "current_status" is invalid.' });
  assert.equal(res[S.five].outcome, 'failed');
  assert.equal(res[S.five].reason, 'Something went wrong changing this record.', 'a database error is never shown');
  assert.ok(!JSON.stringify(r.body).includes('foreign key'));
  assert.ok(h.log.errors.some((m) => m.includes('foreign key')));
  assert.deepEqual(r.body.counts, { total: 5, applied: 2, noop: 0, skipped: 1, failed: 2 });
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'archived');
  assert.equal(row(h.tables, 'physical_samples', S.two).current_status, 'active');
  assert.equal(row(h.tables, 'physical_samples', S.five).current_status, 'active');
  assert.equal(h.tables.bulk_actions[0].n_applied, 2);
  assert.equal(h.tables.bulk_actions[0].n_skipped, 1);
  assert.equal(h.tables.bulk_actions[0].n_failed, 2);
  assert.equal(h.tables.bulk_action_rows.length, 5);
});

test('every field kind applies: enum, relation, bool, date, and null clears', async () => {
  const h = setup();
  const acc = member(U.ann);
  assert.equal((await apply(h, acc, 'physical_samples', editBody([S.one], 'project_id', PRJ.open))).body.counts.applied, 1);
  assert.equal(row(h.tables, 'physical_samples', S.one).project_id, PRJ.open);
  assert.equal((await apply(h, acc, 'physical_samples', editBody([S.one], 'mounted', true))).body.counts.applied, 1);
  assert.equal(row(h.tables, 'physical_samples', S.one).mounted, true);
  assert.equal((await apply(h, acc, 'physical_samples', editBody([S.one], 'manufactured_date', '2026-05-06'))).body.counts.applied, 1);
  assert.equal(row(h.tables, 'physical_samples', S.one).manufactured_date, '2026-05-06');
  assert.equal((await apply(h, acc, 'physical_samples', editBody([S.two], 'mounted', null))).body.counts.applied, 1);
  assert.equal(row(h.tables, 'physical_samples', S.two).mounted, null);
  assert.equal((await apply(h, acc, 'physical_samples', editBody([S.three], 'project_id', null))).body.counts.applied, 1);
  assert.equal(row(h.tables, 'physical_samples', S.three).project_id, null);
  const clear = h.tables.bulk_actions.at(-1);
  assert.deepEqual(JSON.parse(clear.params), { field: 'project_id', value: null });
  const j = h.tables.bulk_action_rows.find((x) => x.action_id === clear.action_id);
  assert.deepEqual(JSON.parse(j.before), { project_id: PRJ.open });
  assert.deepEqual(JSON.parse(j.after), { project_id: null });
});

test('a record the caller cannot read is skipped as not found and never journaled with a code', async () => {
  const h = setup({ canRead: (user, collection, id) => id !== S.two });
  const r = await apply(h, member(U.ann), 'physical_samples', editBody([S.one, S.two], 'mounted', false));
  assert.deepEqual(byId(r.body.results)[S.two], { id: S.two, code: null, outcome: 'skipped', reason: 'That record does not exist, or you cannot see it.' });
  assert.equal(h.tables.bulk_action_rows.find((x) => x.record_id === S.two).record_code, null);
  assert.equal(row(h.tables, 'physical_samples', S.two).mounted, true);
});

test('Directus accepting an update that changes nothing (a hook put it back) is a noop, not an applied change', async () => {
  const h = setup({ afterUpdate: async (db, collection, id) => { await db(collection).where(COLLECTIONS[collection].key, id).update({ current_status: 'active' }); } });
  const r = await apply(h, member(U.ann), 'physical_samples', editBody([S.three], 'current_status', 'active'));
  assert.equal(r.body.results[0].outcome, 'applied'); // consumed -> active, kept by the hook
  const r2 = await apply(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  assert.equal(r2.body.results[0].outcome, 'noop');
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'active');
  assert.equal(h.log.emitted.length, 1);
});

test('the other three collections work too (campaigns edit, operations and tests have fields)', async () => {
  const tables = baseTables();
  const OP = ID(61);
  const TS = ID(71);
  tables.manufacturing_operations.push({ operation_id: OP, pass_code: 'OP-1', owner_person_id: P.ann, owner_team_id: null, restricted: false, project_id: null, campaign_id: null, planned_date: null });
  tables.test_sessions.push({ session_id: TS, test_code: 'T-1', owner_person_id: P.ann, owner_team_id: null, restricted: false, status: 'registered', project_id: null, campaign_id: null, planned_date: null });
  const h = setup({ tables });
  const acc = member(U.ann);
  assert.equal((await apply(h, acc, 'campaigns', editBody([CAMP], 'end_date', '2026-12-01'))).body.counts.applied, 1);
  assert.equal(row(tables, 'campaigns', CAMP).end_date, '2026-12-01');
  assert.equal((await apply(h, acc, 'manufacturing_operations', editBody([OP], 'campaign_id', CAMP))).body.counts.applied, 1);
  assert.equal((await apply(h, acc, 'test_sessions', editBody([TS], 'status', 'processed'))).body.counts.applied, 1);
  assert.equal((await apply(h, admin(U.admin), 'test_sessions', restrictBody([TS]))).body.results[0].code, 'T-1');
  assert.equal(row(tables, 'test_sessions', TS).restricted, true);
});

// ---- undo and revert ----------------------------------------------------------------------------------------

async function ran(h, acc, collection, body) {
  const r = await apply(h, acc, collection, body);
  assert.equal(r.status, 200);
  return r.body.action_id;
}

test('undo by the actor inside the window restores the records, journals the revert and sets the state to undone', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one, S.two, S.four], 'current_status', 'archived'));
  h.log.clock = new Date(T0.getTime() + 59_000);
  const r = await undo(h, member(U.ann), id);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'undone');
  // S.four belongs to Bob: Ann's apply on it also worked (the fake does not model ownership), so three rows came back
  assert.deepEqual(r.body.results.map((x) => x.revert_outcome), ['reverted', 'reverted', 'reverted']);
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'active');
  assert.equal(row(h.tables, 'physical_samples', S.four).current_status, 'active');
  const original = h.tables.bulk_actions.find((a) => a.action_id === id);
  assert.equal(original.state, 'undone');
  const rev = h.tables.bulk_actions.find((a) => a.revert_of === id);
  assert.equal(rev.action_id, r.body.revert_action_id);
  assert.equal(rev.kind, 'edit_field');
  assert.equal(rev.mail_state, 'none');
  assert.equal(rev.actor_user, U.ann);
  assert.equal(rev.undo_until.getTime(), rev.created_at.getTime(), 'a revert has no undo window');
  assert.equal(rev.n_applied, 3);
  assert.ok(h.tables.bulk_action_rows.filter((x) => x.action_id === id).every((x) => x.revert_outcome === 'reverted'));
  assert.equal(h.tables.bulk_action_rows.filter((x) => x.action_id === rev.action_id).length, 3);
  assert.equal(h.log.emitted.length, 6, 'the apply and the undo each emit an event per record');
});

test('undo is refused for a non-administrator once the window has closed (403), allowed for an administrator, and a stranger sees 404', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  h.log.clock = new Date(T0.getTime() + 60_001 + 60_000); // the window ends 60 s after the answer was ready
  let r = await undo(h, member(U.ann), id);
  assert.equal(r.status, 403);
  assert.equal(errorOf(r).extensions.code, 'UNDO_WINDOW_CLOSED');
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'archived');
  r = await undo(h, member(U.bob), id);
  assert.equal(r.status, 404);
  assert.equal(errorOf(r).extensions.code, 'NOT_FOUND');
  r = await undo(h, admin(U.admin), id);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'undone');
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'active');
});

test('the window is exactly undo_until: one millisecond before is allowed, at undo_until it is closed', async () => {
  const h = setup();
  const x = await apply(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  const until = new Date(x.body.undo_until).getTime();
  h.log.clock = new Date(until);
  assert.equal((await undo(h, member(U.ann), x.body.action_id)).status, 403);
  h.log.clock = new Date(until - 1);
  assert.equal((await undo(h, member(U.ann), x.body.action_id)).status, 200);
});

test('revert is administrators only, at any time; a second revert of a finished action is 409', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one, S.two], 'current_status', 'consumed'));
  h.log.clock = new Date(T0.getTime() + 86_400_000);
  let r = await revert(h, member(U.ann), id);
  assert.equal(r.status, 403);
  assert.equal(errorOf(r).extensions.code, 'FORBIDDEN');
  r = await revert(h, admin(U.admin), id);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'reverted');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === id).state, 'reverted');
  assert.equal(h.tables.bulk_actions.find((a) => a.revert_of === id).actor_user, U.admin);
  r = await revert(h, admin(U.admin), id);
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'ALREADY_REVERTED');
  r = await undo(h, admin(U.admin), id);
  assert.equal(r.status, 409);
});

test('revert skips a record changed since (changed_since), reverts the rest and marks the action partly_reverted; a later revert retries only that one', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one, S.two], 'current_status', 'consumed'));
  row(h.tables, 'physical_samples', S.two).current_status = 'destroyed'; // someone changed it afterwards
  let r = await revert(h, admin(U.admin), id);
  assert.equal(r.body.state, 'partly_reverted');
  const res = byId(r.body.results);
  assert.equal(res[S.one].revert_outcome, 'reverted');
  assert.equal(res[S.two].revert_outcome, 'changed_since');
  assert.match(res[S.two].reason, /Changed since/);
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'active');
  assert.equal(row(h.tables, 'physical_samples', S.two).current_status, 'destroyed', 'a changed record is left alone');
  const rows = byId(h.tables.bulk_action_rows.filter((x) => x.action_id === id).map((x) => ({ id: x.record_id, ...x })));
  assert.equal(rows[S.two].revert_outcome, 'changed_since');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === id).state, 'partly_reverted');
  // it is back as it was after the action: the retry now reverts it, and only it
  row(h.tables, 'physical_samples', S.two).current_status = 'consumed';
  const writesBefore = h.log.writes.length;
  r = await revert(h, admin(U.admin), id);
  assert.equal(r.body.state, 'reverted');
  assert.deepEqual(r.body.results.map((x) => [x.id, x.revert_outcome]), [[S.two, 'reverted']]);
  assert.equal(h.log.writes.length - writesBefore, 1);
  assert.equal(row(h.tables, 'physical_samples', S.two).current_status, 'active');
});

test('a record whose access changed since a restrict is changed_since too (the snapshot holds the access list)', async () => {
  const h = setup();
  const id = await ran(h, admin(U.admin), 'physical_samples', restrictBody([S.one, S.two]));
  h.tables.sample_access.push({ sample_id: S.one, person_id: P.eve, role: 'edit', team_access_id: null }); // shared since
  h.tables.sample_access.push({ sample_id: S.two, person_id: P.eve, role: 'view', team_access_id: ID(900) }); // a derived row: ignored
  const r = await revert(h, admin(U.admin), id);
  const res = byId(r.body.results);
  assert.equal(res[S.one].revert_outcome, 'changed_since');
  assert.equal(res[S.two].revert_outcome, 'reverted');
  assert.equal(row(h.tables, 'physical_samples', S.one).restricted, true);
  assert.equal(row(h.tables, 'physical_samples', S.two).restricted, false);
});

test('a team grant changing the snapshot (and the owner team) is noticed as well', async () => {
  const h = setup();
  const id = await ran(h, admin(U.admin), 'physical_samples', restrictBody([S.one]));
  h.tables.sample_team_access.push({ sample_id: S.one, team_id: ID(300), role: 'view', trust_new_members: false, team_access_id: ID(301) });
  const r = await revert(h, admin(U.admin), id);
  assert.equal(r.body.results[0].revert_outcome, 'changed_since');
  // the owning team's own grant (role 'own') is never part of the snapshot
  const h2 = setup();
  const id2 = await ran(h2, admin(U.admin), 'physical_samples', restrictBody([S.two]));
  h2.tables.sample_team_access.push({ sample_id: S.two, team_id: ID(300), role: 'own', trust_new_members: false, team_access_id: ID(301) });
  assert.equal((await revert(h2, admin(U.admin), id2)).body.results[0].revert_outcome, 'reverted');
});

test('a rule that now forbids the restore is refused with its reason, and the record is left as it is', async () => {
  let refuse = false;
  const guard = (acc, collection, id, data) => { if (refuse && acc.user === U.ann) throw guardError('Only an administrator can change this now.'); };
  const h = setup({ guard });
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  refuse = true;
  const r = await undo(h, member(U.ann), id);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.revert_outcome, x.reason]), [['refused', 'Only an administrator can change this now.']]);
  assert.equal(r.body.state, 'partly_reverted');
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'archived');
  assert.equal(h.tables.bulk_action_rows.find((x) => x.record_id === S.one && x.revert_outcome).revert_reason, 'Only an administrator can change this now.');
  // the administrator can retry it
  refuse = false;
  assert.equal((await revert(h, admin(U.admin), id)).body.state, 'reverted');
});

test('undo of a record the actor can no longer read is refused as not found', async () => {
  let hide = false;
  const h = setup({ canRead: (user, collection, id) => !(hide && id === S.one) });
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one, S.two], 'mounted', false));
  hide = true;
  const r = await undo(h, member(U.ann), id);
  const res = byId(r.body.results);
  assert.equal(res[S.one].revert_outcome, 'refused');
  assert.equal(res[S.two].revert_outcome, 'reverted');
  assert.equal(r.body.state, 'partly_reverted');
});

test('a revert cannot be reverted (409), whoever asks, and neither can it be undone', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  const r = await undo(h, member(U.ann), id);
  const revId = r.body.revert_action_id;
  for (const fn of [revert, undo]) {
    const x = await fn(h, admin(U.admin), revId);
    assert.equal(x.status, 409);
    assert.equal(errorOf(x).extensions.code, 'CANNOT_REVERT_A_REVERT');
  }
  // its own actor, inside what would have been a window, is refused the same way
  const y = await undo(h, member(U.ann), revId);
  assert.equal(y.status, 409);
});

test('an action that changed nothing has nothing to revert (409), and bad or unknown ids are 400 and 404', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'active')); // already active: noop
  const r = await revert(h, admin(U.admin), id);
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'NOTHING_TO_REVERT');
  assert.equal((await revert(h, admin(U.admin), 'not-a-uuid')).status, 400);
  assert.equal((await revert(h, admin(U.admin), ID(9))).status, 404);
  assert.equal((await undo(h, member(U.ann), ID(9))).status, 404);
});

test('revert locks the action row and each record, and runs every write as the person who reverts', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  h.log.locks.length = 0;
  h.log.writes.length = 0;
  await revert(h, admin(U.admin), id);
  assert.ok(h.log.locks.includes('bulk_actions') && h.log.locks.includes('physical_samples'));
  assert.ok(h.log.writes.every((w) => w.caller === U.admin && w.inTrx));
});

// ---- the journal --------------------------------------------------------------------------------------------

test('GET lists: an administrator sees every action, anyone else only their own; newest first; paged', async () => {
  const h = setup();
  const a = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'mounted', false));
  h.log.clock = new Date(T0.getTime() + 1000);
  const b = await ran(h, member(U.bob), 'physical_samples', editBody([S.four], 'mounted', false));
  h.log.clock = new Date(T0.getTime() + 2000);
  const c = await ran(h, admin(U.admin), 'physical_samples', restrictBody([S.five]));
  const list = (acc, query) => call(h.handlers['GET /'], { acc, query, method: 'GET' });
  let r = await list(admin(U.admin));
  assert.deepEqual(r.body.actions.map((x) => x.action_id), [c, b, a]);
  assert.equal(r.body.actions[0].actor_name, 'Ada Admin');
  assert.equal(r.body.actions[0].kind, 'restrict');
  assert.equal(r.body.actions[0].state, 'applied');
  assert.deepEqual(r.body.actions[2].params, { field: 'mounted', value: false });
  assert.equal(r.body.actions[2].n_applied, 1);
  r = await list(member(U.ann));
  assert.deepEqual(r.body.actions.map((x) => x.action_id), [a]);
  r = await list(member(U.bob));
  assert.deepEqual(r.body.actions.map((x) => x.action_id), [b]);
  r = await list(member(U.eve));
  assert.deepEqual(r.body.actions, []);
  r = await list(admin(U.admin), { limit: '2' });
  assert.equal(r.body.actions.length, 2);
  assert.equal(r.body.has_more, true);
  r = await list(admin(U.admin), { limit: '2', offset: '2' });
  assert.deepEqual(r.body.actions.map((x) => x.action_id), [a]);
  assert.equal(r.body.has_more, false);
});

test('a Lab Admin (admin policy through the role, acc.admin not set) is an administrator for the list, undo and revert', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'mounted', false));
  const labAdmin = member(U.admin); // acc.admin false: only the policy walk knows
  const list = await call(h.handlers['GET /'], { acc: labAdmin, method: 'GET' });
  assert.equal(list.body.actions.length, 1);
  assert.equal((await revert(h, labAdmin, id)).status, 200);
});

test('GET one action: the actor and administrators see it with its rows, anyone else a 404', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.two, S.one, ID(404)], 'mounted', true));
  const get = (acc, action_id = id) => call(h.handlers['GET /:action_id'], { acc, params: { action_id }, method: 'GET' });
  const r = await get(member(U.ann));
  assert.equal(r.status, 200);
  assert.equal(r.body.action.action_id, id);
  assert.equal(r.body.action.actor_name, 'Ann Owner');
  assert.deepEqual(r.body.rows.map((x) => [x.record_code, x.outcome]), [[null, 'skipped'], ['SM-001', 'applied'], ['SM-002', 'noop']]);
  // the snapshots can hold what the actor may not see: only an administrator gets them
  assert.ok(r.body.rows.every((x) => x.before === null && x.after === null));
  const adminView = await get(admin(U.admin));
  assert.equal(adminView.status, 200);
  assert.deepEqual(adminView.body.rows[1].before, { mounted: null });
  assert.deepEqual(adminView.body.rows[1].after, { mounted: true });
  assert.equal(adminView.body.rows[0].before, null, 'a skipped row has no snapshots');
  for (const acc of [member(U.bob), member(U.eve)]) {
    const x = await get(acc);
    assert.equal(x.status, 404);
    assert.equal(errorOf(x).extensions.code, 'NOT_FOUND');
  }
  assert.equal((await get(admin(U.admin), 'not-a-uuid')).status, 400);
  assert.equal((await get(admin(U.admin), ID(9))).status, 404);
});

test('an unexpected error answers 500 in the Directus shape without leaking the message, and is logged', async () => {
  const broken = setup({ failTable: 'bulk_actions' });
  const r = await apply(broken, admin(U.admin), 'physical_samples', restrictBody([S.one]));
  assert.equal(r.status, 500);
  assert.equal(errorOf(r).extensions.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(errorOf(r).extensions.source, 'd1-bulk-actions');
  assert.equal(errorOf(r).message, 'Something went wrong on the server.');
  assert.ok(broken.log.errors.some((m) => m.includes('secret host')));
  assert.ok(!JSON.stringify(r.body).includes('secret host'));
});

test('an action whose records are all reverted but whose state was never written (a crash) is put right by the next revert, which answers 409', async () => {
  const h = setup();
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'current_status', 'archived'));
  h.tables.bulk_action_rows.find((x) => x.action_id === id && x.record_id === S.one).revert_outcome = 'reverted';
  const r = await revert(h, admin(U.admin), id);
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'ALREADY_REVERTED');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === id).state, 'reverted');
});

test('snapshots are journaled only for changed records: skipped, noop and failed rows store null before and after', async () => {
  const guard = (acc, collection, id) => { if (id === S.two) throw guardError('Only the owner can change this.'); };
  const h = setup({ guard });
  await apply(h, member(U.ann), 'physical_samples', editBody([S.one, S.two, S.three, ID(404)], 'current_status', 'consumed'));
  const rows = byId(h.tables.bulk_action_rows.map((x) => ({ id: x.record_id, ...x })));
  assert.equal(rows[S.one].outcome, 'applied');
  assert.ok(rows[S.one].before && rows[S.one].after);
  for (const id of [S.two, S.three, ID(404)]) {
    assert.notEqual(rows[id].outcome, 'applied');
    assert.equal(rows[id].before, null, id);
    assert.equal(rows[id].after, null, id);
  }
  // a revert's own rows follow the same rule: changed_since keeps no snapshots
  const id = h.tables.bulk_actions[0].action_id;
  row(h.tables, 'physical_samples', S.one).current_status = 'destroyed';
  await revert(h, admin(U.admin), id);
  const revRows = h.tables.bulk_action_rows.filter((x) => x.action_id !== id);
  assert.ok(revRows.length > 0 && revRows.every((x) => x.outcome === 'skipped' && x.before === null && x.after === null));
});

test('a field Directus hides from the caller makes the record a skip: its value is neither read as the system nor journaled nor returned', async () => {
  const tables = baseTables();
  row(tables, 'physical_samples', S.one).mounted = true;
  const h = setup({ tables, canRead: (user, collection, id, fields) => !(fields ?? []).includes('mounted') });
  const body = editBody([S.one, S.two], 'mounted', false);
  const p = await preview(h, member(U.ann), 'physical_samples', body);
  assert.deepEqual(p.body.results.map((x) => x.status), ['skip', 'skip']);
  assert.ok(p.body.results.every((x) => x.reason === 'You do not have permission to change this record.'));
  const a = await apply(h, member(U.ann), 'physical_samples', body);
  assert.deepEqual(a.body.results.map((x) => x.outcome), ['skipped', 'skipped']);
  assert.ok(h.tables.bulk_action_rows.every((x) => x.before === null && x.after === null));
  assert.equal(row(tables, 'physical_samples', S.one).mounted, true);
  assert.equal(h.log.writes.length, 0);
  // the field's value was never read with system rights
  assert.ok(h.log.reads.filter((r) => r.caller === 'system').length === 0);
});

test('undo of a field edit the actor can no longer read is refused, not failed', async () => {
  let hide = false;
  const h = setup({ canRead: (user, collection, id, fields) => !(hide && (fields ?? []).includes('mounted')) });
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one], 'mounted', false));
  hide = true;
  const r = await undo(h, member(U.ann), id);
  assert.equal(r.body.results[0].revert_outcome, 'refused');
  assert.equal(row(h.tables, 'physical_samples', S.one).mounted, false);
});

test('an action is not undoable or revertable while its apply is running (counts null): 409 STILL_APPLYING; they are written when it finishes', async () => {
  let counts;
  const tables = baseTables();
  const h = setup({ tables, canRead: () => { counts ??= tables.bulk_actions.map((a) => a.n_applied); return true; } });
  const id = await ran(h, member(U.ann), 'physical_samples', editBody([S.one, S.two], 'current_status', 'archived'));
  assert.deepEqual(counts, [null], 'the action row exists, with no counts, while records are being applied');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === id).n_applied, 2);

  h.tables.bulk_actions.find((a) => a.action_id === id).n_applied = null; // as if the apply were still running
  const u = await undo(h, member(U.ann), id);
  assert.equal(u.status, 409);
  assert.equal(errorOf(u).extensions.code, 'STILL_APPLYING');
  assert.equal(errorOf(u).message, 'That bulk action is still being applied. Try again in a moment.');
  assert.equal(errorOf(await revert(h, admin(U.admin), id)).extensions.code, 'STILL_APPLYING');
  assert.equal(row(h.tables, 'physical_samples', S.one).current_status, 'archived', 'nothing was reverted');
});

test('a database error while checking one record fails that record only: the rest are applied and the counts are written', async () => {
  const h = setup({ canRead: (user, collection, id) => { if (id === S.two) throw new Error('connection reset: secret host'); return true; } });
  const r = await apply(h, member(U.ann), 'physical_samples', editBody([S.one, S.two, S.three], 'current_status', 'archived'));
  assert.equal(r.status, 200);
  const res = byId(r.body.results);
  assert.deepEqual([res[S.one].outcome, res[S.two].outcome, res[S.three].outcome], ['applied', 'failed', 'applied']);
  assert.equal(res[S.two].reason, 'Something went wrong changing this record.');
  assert.ok(h.log.errors.some((m) => m.includes('secret host')));
  const action = h.tables.bulk_actions.find((a) => a.action_id === r.body.action_id);
  assert.deepEqual([action.n_applied, action.n_failed], [2, 1]);
});
