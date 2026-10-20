// Run with: node --test core/extensions/d1-bulk-actions/index.ownership.test.mjs
// The ownership and access kinds of d1-bulk-actions (assign_team, change_owner, share_access, remove_access): per-row outcomes, warnings, preview, undo and
// revert, and the held summary mail. The rules themselves (can-manage, Rulings O3/O4/O5) are d1-record-access's own bodies, so this world is a fake knex
// with just enough triggers (none: the snapshots ignore derived rows and the owner grant) and a fake ItemsService whose manage rule reads the same tables.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLLECTIONS } from '../d1-record-access/index.js';
import {
  ACCESS_KINDS, KINDS, MAILING_KINDS, WARN_TEAM_MANAGERS_LOSE, WARN_YOU_LOSE_MANAGE, mount, summaryContent,
} from './index.js';

// ---- ids and the world ----------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R = { member: ID(31), super: ID(32) };
const POLICY = { admin: ID(41), member: ID(42) };
const P = { ann: ID(101), bob: ID(102), eve: ID(103), adm: ID(104), nell: ID(105), cy: ID(106), zed: ID(107) };
const U = { ann: ID(201), bob: ID(202), eve: ID(203), admin: ID(204), cy: ID(206) };
const S = { one: ID(1), two: ID(2), three: ID(3), four: ID(4), five: ID(5) };
const T = { alpha: ID(301), nomgr: ID(302), beta: ID(303) };
const CAMP = ID(21);
const PRJ = ID(11);
const T0 = new Date('2026-10-20T12:00:00.000Z');
const SAMPLE_CODES = { [S.one]: 'SM-001', [S.two]: 'SM-002', [S.three]: 'SM-003', [S.four]: 'SM-004', [S.five]: 'SM-005' };

const sample = (id, owner, extra = {}) => ({
  sample_id: id, sample_code: SAMPLE_CODES[id], owner_person_id: owner, owner_team_id: null, restricted: false, current_status: 'active', project_id: null, ...extra,
});

// Ann owns 1-3, Bob owns 4, team Alpha (manager Eve) owns 5. Bob can view 1; team Beta (manager Ann) can view 3. Everybody reads everything.
const baseTables = () => ({
  people: [
    { person_id: P.ann, full_name: 'Ann Owner', email: 'ann@people.example', user_id: U.ann, active: true },
    { person_id: P.bob, full_name: 'Bob Other', email: null, user_id: U.bob, active: true },
    { person_id: P.eve, full_name: 'Eve Manager', email: null, user_id: U.eve, active: true },
    { person_id: P.adm, full_name: 'Ada Admin', email: null, user_id: U.admin, active: true },
    { person_id: P.nell, full_name: 'Nell Nologin', email: 'nell@people.example', user_id: null, active: true },
    { person_id: P.cy, full_name: 'Cy Noaddress', email: 'cy@people.example', user_id: U.cy, active: true },
    { person_id: P.zed, full_name: 'Zed Inactive', email: 'zed@people.example', user_id: null, active: false },
  ],
  directus_users: [
    { id: U.ann, email: 'ann@login.example', role: R.member },
    { id: U.bob, email: 'bob@login.example', role: R.member },
    { id: U.eve, email: 'eve@login.example', role: R.member },
    { id: U.admin, email: 'admin@login.example', role: R.super },
    { id: U.cy, email: '', role: R.member }, // a login with no address: People's address is NOT used
  ],
  directus_access: [{ role: R.member, user: null, policy: POLICY.member }, { role: R.super, user: null, policy: POLICY.admin }],
  directus_policies: [{ id: POLICY.admin, admin_access: true }, { id: POLICY.member, admin_access: false }],
  teams: [
    { team_id: T.alpha, name: 'Alpha lab' },
    { team_id: T.nomgr, name: 'Leaderless crew' },
    { team_id: T.beta, name: 'Beta crew' },
  ],
  team_members: [
    { team_id: T.alpha, person_id: P.eve, is_manager: true },
    { team_id: T.alpha, person_id: P.bob, is_manager: false },
    { team_id: T.alpha, person_id: P.cy, is_manager: false },
    { team_id: T.alpha, person_id: P.nell, is_manager: false },
    { team_id: T.alpha, person_id: P.zed, is_manager: false },
    { team_id: T.alpha, person_id: P.ann, is_manager: false },
    { team_id: T.nomgr, person_id: P.bob, is_manager: false },
    { team_id: T.beta, person_id: P.ann, is_manager: true },
  ],
  physical_samples: [
    sample(S.one, P.ann), sample(S.two, P.ann), sample(S.three, P.ann), sample(S.four, P.bob), sample(S.five, null, { owner_team_id: T.alpha }),
  ],
  projects: [{ project_id: PRJ, project_code: 'PRJ-1', project_name: 'Project', principal_investigator_person: P.ann, restricted: false }],
  campaigns: [{ campaign_id: CAMP, campaign_code: 'CMP-1', name: 'Campaign', owner_person_id: P.ann, owner_team_id: null, restricted: false }],
  manufacturing_operations: [],
  test_sessions: [],
  sample_access: [
    { sample_id: S.one, person_id: P.bob, role: 'view', team_access_id: null },
    { sample_id: S.one, person_id: P.ann, role: 'own', team_access_id: null }, // the database-held owner grant: never snapshotted
  ],
  sample_team_access: [
    { team_access_id: ID(801), sample_id: S.three, team_id: T.beta, role: 'view', trust_new_members: false },
    { team_access_id: ID(802), sample_id: S.five, team_id: T.alpha, role: 'own', trust_new_members: false }, // the owning team's grant
  ],
  sample_team_pending: [],
  sample_co_owners: [],
  sample_readers: [S.one, S.two, S.three, S.four, S.five].flatMap((record_id) => [U.ann, U.bob, U.eve, U.cy].map((user_id) => ({ record_id, user_id }))),
  project_access: [], project_team_access: [], project_team_pending: [], project_readers: [],
  campaign_access: [], campaign_team_access: [], campaign_team_pending: [], campaign_readers: [],
  operation_access: [], operation_team_access: [], operation_team_pending: [], operation_readers: [],
  test_access: [], test_team_access: [], test_team_pending: [], test_readers: [],
  bulk_actions: [],
  bulk_action_rows: [],
});

// ---- a tiny in-memory knex -----------------------------------------------------------------------------

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
let seq = 8000;

function makeDb(tables, log) {
  const db = (table) => {
    const preds = [];
    let order = null;
    let max = Infinity;
    let skip = 0;
    const rows = () => {
      let out = (tables[table] ??= []).filter((r) => preds.every((p) => p(r)));
      if (order) out = [...out].sort((a, b) => (a[order.col] < b[order.col] ? -1 : a[order.col] > b[order.col] ? 1 : 0) * (order.dir === 'desc' ? -1 : 1));
      return out.slice(skip, skip + max);
    };
    const project = (row, cols) => (row === undefined ? undefined : cols.length ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : { ...row });
    const q = {
      where(a, v) {
        if (a && typeof a === 'object') for (const [k, val] of Object.entries(a)) preds.push((r) => same(r[k], val));
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
      update: async (changes) => {
        const hit = rows();
        log.updates.push({ table, changes: { ...changes } });
        for (const r of hit) Object.assign(r, changes);
        return hit.length;
      },
      del: async () => {
        const hit = new Set(rows());
        tables[table] = (tables[table] ?? []).filter((r) => !hit.has(r));
        log.deletes.push({ table, n: hit.size });
        return hit.size;
      },
      // awaited directly: a plain INSERT; .returning(col) and .onConflict(raw).merge(patch) are the other two ways knex ends one
      insert(input) {
        const list = (Array.isArray(input) ? input : [input]).map((r) => ({ ...r }));
        const put = (upsert = null) => {
          for (const rec of list) {
            if (table === 'bulk_actions') {
              rec.action_id ??= ID(seq++);
              rec.state ??= 'applied';
              rec.revert_of ??= null;
            }
            if (table === 'bulk_action_rows') {
              rec.revert_outcome ??= null;
              rec.revert_reason ??= null;
            }
            if (/_team_access$/.test(table)) {
              rec.team_access_id ??= ID(seq++);
              rec.trust_new_members ??= false;
            }
            if (upsert) {
              const found = (tables[table] ?? []).find((r) => (r.team_access_id ?? null) === null && upsert.cols.every((c) => same(r[c], rec[c])));
              if (found) {
                Object.assign(found, upsert.patch);
                continue;
              }
            }
            log.inserts.push({ table, row: rec });
            (tables[table] ??= []).push(rec);
          }
          return list;
        };
        let done = null;
        const run = () => (done ??= Promise.resolve(put()));
        return {
          then: (resolve, reject) => run().then(resolve, reject),
          returning: async (col) => put().map((r) => ({ [col]: r[col] })),
          onConflict: (raw) => ({ merge: async (patch) => { put({ cols: raw.bindings.slice(0, 2), patch }); } }),
        };
      },
    };
    return q;
  };
  db.raw = (sql, bindings) => {
    log.raw.push({ sql, bindings, inTx: log.depth > 0 });
    const answer = Promise.resolve({ rows: [] });
    answer.bindings = bindings;
    return answer;
  };
  return db;
}

// ---- a harness ------------------------------------------------------------------------------------------

const guardError = (reason) => Object.assign(new Error(reason), { name: 'DirectusError', status: 403, code: 'FORBIDDEN', extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard' } });
const RESTRICT_REFUSED = 'Restricting a record is not available yet. Ask an administrator.';

function setup({ tables = baseTables(), env = { PUBLIC_URL: 'https://lab.example' }, canRead = () => true, mailFail = false, sweep = false, getSchema = null, now = T0, beforeTransaction = null } = {}) {
  const log = { inserts: [], updates: [], deletes: [], raw: [], locks: [], depth: 0, caches: [], errors: [], warnings: [], clock: now, mail: [], timers: [] };
  const root = makeDb(tables, log);
  const database = Object.assign((t) => root(t), {
    raw: (...a) => root.raw(...a),
    transaction: async (work) => {
      await beforeTransaction?.();
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
  class ItemsService {
    constructor(collection, options) {
      this.collection = collection;
      this.options = options;
    }
    get key() { return COLLECTIONS[this.collection].key; }
    db() { return this.options.knex ?? root; }
    async readOne(id, query) {
      const acc = this.options.accountability;
      if (acc && !canRead(acc.user, this.collection, id)) throw Object.assign(new Error('You do not have permission to access this.'), { status: 403, code: 'FORBIDDEN' });
      const row = await this.db()(this.collection).where(this.key, id).first();
      if (!row) throw Object.assign(new Error('not found'), { status: 403, code: 'FORBIDDEN' });
      return Object.fromEntries(query.fields.map((f) => [f, row[f] ?? null]));
    }
    // the manage rule (the record's delete rule): its owner, or a manager of the team that owns it; read from the tables of the transaction
    async readByQuery(query) {
      const id = query.filter._and[0][this.key]._eq;
      const db = this.db();
      const rec = await db(this.collection).where(this.key, id).first();
      const me = await db('people').where('user_id', this.options.accountability.user).first('person_id');
      const owns = Boolean(rec && me && rec.owner_person_id && same(rec.owner_person_id, me.person_id));
      const viaTeam = Boolean(rec?.owner_team_id && me && await db('team_members').where('team_id', rec.owner_team_id).where('person_id', me.person_id).where('is_manager', true).first('person_id'));
      return owns || viaTeam ? [{ [this.key]: id }] : [];
    }
    async updateOne(id, data) {
      if ('restricted' in data && this.options.accountability?.admin !== true) throw guardError(RESTRICT_REFUSED);
      await this.db()(this.collection).where(this.key, id).update(data);
      return id;
    }
  }
  class MailService {
    constructor(options) { this.options = options; }
    async send(data) {
      log.mail.push({ ...data, schema: this.options.schema });
      if (mailFail) throw new Error(typeof mailFail === 'string' ? mailFail : 'SMTP refused');
      return { messageId: 'x' };
    }
  }
  const handlers = {};
  const reg = (method) => (path, fn) => { handlers[`${method} ${path}`] = fn; };
  const router = { get: reg('GET'), post: reg('POST') };
  const timers = {
    set(fn, ms) { const handle = { fn, ms, cleared: false, unref() {} }; log.timers.push(handle); return handle; },
    clear(handle) { handle.cleared = true; },
    sweep,
  };
  const { swept } = mount(router, {
    database,
    services: { ItemsService, MailService, UtilsService: class { async clearCache(arg) { log.caches.push(arg); } } },
    emitter: { emitAction() {} },
    env,
    logger: { error(m) { log.errors.push(m); }, warn(m) { log.warnings.push(m); } },
    ...(getSchema ? { getSchema } : {}),
  }, () => log.clock, timers);
  const fire = async (n = log.timers.length - 1) => { // run a scheduled mail timer's callback and let its work finish
    await log.timers[n].fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { tables, handlers, log, database, swept, fire };
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
    Promise.resolve(h({ accountability: acc, params, query, body, schema: { fake: 'schema' }, method }, res)).catch(reject);
  });
}
const errorOf = (r) => r.body?.errors?.[0];
const row = (tables, collection, id) => tables[collection].find((r) => same(r[COLLECTIONS[collection].key], id));
const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r]));
const preview = (h, acc, collection, body) => call(h.handlers['POST /:collection/preview'], { acc, params: { collection }, body });
const apply = (h, acc, collection, body) => call(h.handlers['POST /:collection/apply'], { acc, params: { collection }, body });
const undo = (h, acc, id) => call(h.handlers['POST /:action_id/undo'], { acc, params: { action_id: id } });
const revert = (h, acc, id) => call(h.handlers['POST /:action_id/revert'], { acc, params: { action_id: id } });
const getOne = (h, acc, id) => call(h.handlers['GET /:action_id'], { acc, params: { action_id: id }, method: 'GET' });

// the request bodies
const assignBody = (ids, team) => ({ kind: 'assign_team', ids, params: { team_id: team } });
const ownerBody = (ids, person) => ({ kind: 'change_owner', ids, params: { person_id: person } });
const shareBody = (ids, target, role) => ({ kind: 'share_access', ids, params: { ...target, role } });
const removeBody = (ids, target) => ({ kind: 'remove_access', ids, params: target });
const person = (id) => ({ person_id: id });
const team = (id) => ({ team_id: id });

const ranOk = async (h, acc, body, collection = 'physical_samples') => {
  const r = await apply(h, acc, collection, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const peopleOf = (tables, id) => tables.sample_access.filter((r) => same(r.sample_id, id) && !r.team_access_id).map((r) => `${r.person_id}:${r.role}`).sort();
const teamsOf = (tables, id) => tables.sample_team_access.filter((r) => same(r.sample_id, id)).map((r) => `${r.team_id}:${r.role}`).sort();

// ---- the kinds ------------------------------------------------------------------------------------------

test('the four ownership and access kinds are known; three of them mail', () => {
  assert.deepEqual(ACCESS_KINDS, ['assign_team', 'change_owner', 'share_access', 'remove_access']);
  assert.deepEqual(MAILING_KINDS, ['assign_team', 'change_owner', 'share_access']);
  for (const kind of ACCESS_KINDS) assert.ok(KINDS.includes(kind));
});

test('request validation: targets, roles and applicability are 400s before any record is touched', async () => {
  const h = setup();
  const acc = admin(U.admin);
  const bad = async (collection, body, code = 'INVALID_PAYLOAD') => {
    for (const fn of [preview, apply]) {
      const r = await fn(h, acc, collection, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(errorOf(r).extensions.code, code, JSON.stringify(body));
    }
  };
  await bad('physical_samples', { kind: 'assign_team', ids: [S.one] });
  await bad('physical_samples', assignBody([S.one], 'nope'));
  await bad('physical_samples', assignBody([S.one], ID(999))); // no such team
  await bad('physical_samples', { kind: 'change_owner', ids: [S.one], params: { team_id: T.alpha } });
  await bad('physical_samples', ownerBody([S.one], ID(999))); // no such person
  await bad('physical_samples', ownerBody([S.one], P.zed)); // not active
  await bad('physical_samples', shareBody([S.one], {}, 'view')); // no target
  await bad('physical_samples', shareBody([S.one], { person_id: P.eve, team_id: T.alpha }, 'view')); // both
  await bad('physical_samples', shareBody([S.one], person(P.eve), 'owner'));
  await bad('physical_samples', shareBody([S.one], person(P.eve), 'investigator')); // a project role
  await bad('physical_samples', shareBody([S.one], person(P.eve), undefined));
  await bad('physical_samples', shareBody([S.one], person(P.zed), 'view'));
  await bad('physical_samples', shareBody([S.one], team(ID(999)), 'view'));
  await bad('physical_samples', removeBody([S.one], {}));
  await bad('physical_samples', removeBody([S.one], { person_id: 'x' }));
  await bad('projects', ownerBody([PRJ], P.eve), 'NOT_APPLICABLE');
  await bad('projects', shareBody([PRJ], person(P.eve), 'view'), 'NOT_APPLICABLE');
  await bad('projects', removeBody([PRJ], person(P.eve)), 'NOT_APPLICABLE');
  assert.deepEqual(h.log.inserts, []);
  assert.deepEqual(h.log.updates, []);
  // removing access for a person or team that is gone is not a 400: it is simply not listed
  const gone = await preview(h, acc, 'physical_samples', removeBody([S.one], person(ID(999))));
  assert.equal(gone.status, 200);
  assert.equal(gone.body.results[0].status, 'noop');
});

// ---- assign_team ----------------------------------------------------------------------------------------

test('assign_team preview: ok with the Ruling O5 warning when the caller loses manage rights, skips with plain reasons, noop, and nothing is written', async () => {
  const h = setup();
  const before = structuredClone(h.tables);
  // Ann owns 1-3 (S.three is also shared with Beta), Bob owns 4, Alpha owns 5; Alpha is managed by Eve, not by Ann
  const r = await preview(h, member(U.ann), 'physical_samples', assignBody([S.one, S.two, S.four, S.five, ID(404)], T.alpha));
  assert.equal(r.status, 200);
  const res = byId(r.body.results);
  assert.deepEqual(res[S.one], { id: S.one, code: 'SM-001', status: 'ok', warning: WARN_YOU_LOSE_MANAGE });
  assert.equal(res[S.two].status, 'ok');
  assert.deepEqual(res[S.four], { id: S.four, code: 'SM-004', status: 'skip', reason: 'You are not the owner of this record.' }); // manage is checked first
  assert.deepEqual(res[S.five], { id: S.five, code: 'SM-005', status: 'skip', reason: 'You are not the owner of this record.' });
  assert.equal(res[ID(404)].status, 'skip');
  assert.equal(res[ID(404)].code, null);
  assert.deepEqual(r.body.counts, { total: 5, ok: 2, noop: 0, skip: 3 });
  assert.deepEqual(h.tables, before, 'a preview never writes');
  assert.equal(h.log.timers.length, 0);
  assert.equal(h.tables.bulk_actions.length, 0);
});

test('assign_team to a team the caller manages carries no warning; an administrator gets none and a noop for a team that owns it already', async () => {
  const h = setup();
  let r = await preview(h, member(U.ann), 'physical_samples', assignBody([S.one], T.beta));
  assert.deepEqual(r.body.results[0], { id: S.one, code: 'SM-001', status: 'ok' });
  r = await preview(h, admin(U.admin), 'physical_samples', assignBody([S.one, S.five], T.alpha));
  assert.deepEqual(r.body.results.map((x) => [x.code, x.status, x.warning]), [['SM-001', 'ok', undefined], ['SM-005', 'noop', undefined]]);
});

test('assign_team: a team with no manager is skipped with the existing wording; a project cannot be owned by a team (skip), whoever asks', async () => {
  const h = setup();
  const r = await preview(h, member(U.ann), 'physical_samples', assignBody([S.one], T.nomgr));
  assert.deepEqual(r.body.results[0], { id: S.one, code: 'SM-001', status: 'skip', reason: 'That team has no manager to look after the record — add a manager first' });
  const p = await preview(h, admin(U.admin), 'projects', assignBody([PRJ], T.alpha));
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.results[0], { id: PRJ, code: 'PRJ-1', status: 'skip', reason: 'A team cannot own this kind of record.' });
});

test('a previous team owner losing its managers is warned about when the acting person manages it through that team', async () => {
  const h = setup();
  // Eve manages Alpha, which owns S.five: handing it to Beta (managed by Ann) drops Eve
  const r = await preview(h, member(U.eve), 'physical_samples', assignBody([S.five], T.beta));
  assert.deepEqual(r.body.results[0].warning, `${WARN_TEAM_MANAGERS_LOSE} ${WARN_YOU_LOSE_MANAGE}`);
});

test('assign_team apply: the owner moves to the team in one update, the previous owner stays on as Can edit, the journal holds before and after, mail is pending', async () => {
  const h = setup({ env: { PUBLIC_URL: 'https://lab.example', CACHE_ENABLED: 'true' } });
  const out = await ranOk(h, member(U.ann), assignBody([S.one, S.two, S.four], T.alpha));
  assert.deepEqual(out.counts, { total: 3, applied: 2, noop: 0, skipped: 1, failed: 0 });
  assert.equal(row(h.tables, 'physical_samples', S.one).owner_team_id, T.alpha);
  assert.equal(row(h.tables, 'physical_samples', S.one).owner_person_id, null);
  assert.ok(peopleOf(h.tables, S.one).includes(`${P.ann}:edit`), 'Ann stays on as Can edit');
  assert.equal(row(h.tables, 'physical_samples', S.four).owner_person_id, P.bob, 'not Ann\'s record: untouched');
  const journal = byId(h.tables.bulk_action_rows.map((x) => ({ id: x.record_id, ...x })));
  assert.deepEqual(JSON.parse(journal[S.one].before), { owner_person_id: P.ann, owner_team_id: null, restricted: false, people: [{ person_id: P.bob, role: 'view' }], teams: [] });
  assert.deepEqual(JSON.parse(journal[S.one].after), {
    owner_person_id: null, owner_team_id: T.alpha, restricted: false, people: [{ person_id: P.ann, role: 'edit' }, { person_id: P.bob, role: 'view' }].sort((a, b) => a.person_id.localeCompare(b.person_id)), teams: [],
  });
  assert.equal(journal[S.four].outcome, 'skipped');
  assert.equal(journal[S.four].before, null, 'snapshots are kept only for applied rows');
  assert.equal(h.log.caches.length, 1);
  // the held mail
  const action = h.tables.bulk_actions[0];
  assert.equal(action.mail_state, 'pending');
  assert.equal(action.mail_due_at.getTime(), new Date(out.undo_until).getTime() + 2000);
  assert.equal(h.log.timers.length, 1);
  assert.equal(h.log.timers[0].ms, 62_000);
  assert.equal(h.log.mail.length, 0, 'nothing is mailed inside the window');
  // the writes ran with the actor set, inside transactions
  assert.ok(h.log.raw.filter((c) => c.sql.includes('d1.actor_identity')).every((c) => c.bindings[0] === U.ann && c.inTx));
});

test('apply and preview agree record by record for every access kind', async () => {
  const bodies = [
    assignBody([S.one, S.four, S.five, ID(404)], T.alpha), ownerBody([S.one, S.four, S.five, ID(404)], P.eve), shareBody([S.one, S.two, S.four, ID(404)], person(P.bob), 'view'),
    shareBody([S.one, S.three, S.five], team(T.beta), 'view'), removeBody([S.one, S.two, S.four], person(P.bob)), removeBody([S.one, S.three, S.five], team(T.beta)),
  ];
  const norm = { ok: 'applied', noop: 'noop', skip: 'skipped' };
  for (const body of bodies) {
    for (const acc of [member(U.ann), admin(U.admin)]) {
      const p = await preview(setup(), acc, 'physical_samples', body);
      const x = await apply(setup(), acc, 'physical_samples', body);
      assert.deepEqual(p.body.results.map((r) => [r.id, r.code, norm[r.status], r.reason]), x.body.results.map((r) => [r.id, r.code, r.outcome, r.reason]), `${body.kind} as ${acc.user}`);
    }
  }
});

// ---- change_owner ---------------------------------------------------------------------------------------

test('change_owner preview and apply: noop for the owner already, not-the-owner skip, the previous owner stays on as Can edit and the new owner\'s own row goes', async () => {
  const h = setup();
  const p = await preview(h, admin(U.admin), 'physical_samples', ownerBody([S.one, S.four], P.bob));
  assert.deepEqual(p.body.results.map((r) => [r.code, r.status]), [['SM-001', 'ok'], ['SM-004', 'noop']]);
  const skip = await preview(h, member(U.ann), 'physical_samples', ownerBody([S.four], P.eve));
  assert.equal(skip.body.results[0].reason, 'You are not the owner of this record.');
  const out = await ranOk(h, member(U.ann), ownerBody([S.one, S.two], P.bob));
  assert.deepEqual(out.counts, { total: 2, applied: 2, noop: 0, skipped: 0, failed: 0 });
  const one = row(h.tables, 'physical_samples', S.one);
  assert.equal(one.owner_person_id, P.bob);
  assert.equal(one.owner_team_id, null);
  assert.deepEqual(peopleOf(h.tables, S.one).filter((x) => !x.endsWith(':own')), [`${P.ann}:edit`], 'Bob\'s view row became the owner');
  assert.equal(h.tables.bulk_actions[0].mail_state, 'pending');
});

test('change_owner from a team: warns that the outgoing managers are not kept; the new owner\'s blocked_by is a warning too', async () => {
  const world = baseTables();
  world.sample_readers = world.sample_readers.filter((r) => !(r.record_id === S.five && r.user_id === U.bob)); // Bob cannot read S.five
  const h = setup({ tables: world });
  const r = await preview(h, member(U.eve), 'physical_samples', ownerBody([S.five], P.bob));
  assert.equal(r.body.results[0].status, 'ok');
  assert.match(r.body.results[0].warning, /do not keep their access/);
  assert.match(r.body.results[0].warning, /no longer be able to manage/);
  assert.match(r.body.results[0].warning, /Bob Other cannot open this record yet/);
  // a person with no login at all
  const nobody = await preview(h, admin(U.admin), 'physical_samples', ownerBody([S.one], P.nell));
  assert.match(nobody.body.results[0].warning, /Nell Nologin has no D1 login yet/);
  // a new owner who can open it: no warning
  const fine = await preview(h, admin(U.admin), 'physical_samples', ownerBody([S.one], P.bob));
  assert.equal(fine.body.results[0].warning, undefined);
});

// ---- share_access ---------------------------------------------------------------------------------------

test('share_access with a person: adds when absent, changes the level when present, noop at that level, refuses the owner', async () => {
  const h = setup();
  const p = await preview(h, member(U.ann), 'physical_samples', shareBody([S.one, S.two, S.three], person(P.bob), 'view'));
  assert.deepEqual(p.body.results.map((r) => [r.code, r.status]), [['SM-001', 'noop'], ['SM-002', 'ok'], ['SM-003', 'ok']]);
  const edit = await preview(h, member(U.ann), 'physical_samples', shareBody([S.one], person(P.bob), 'edit'));
  assert.equal(edit.body.results[0].status, 'ok');
  const own = await preview(h, member(U.ann), 'physical_samples', shareBody([S.one], person(P.ann), 'edit'));
  assert.deepEqual(own.body.results[0], { id: S.one, code: 'SM-001', status: 'skip', reason: 'That person is the owner already.' });
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.bob), 'edit'));
  assert.deepEqual(out.counts, { total: 2, applied: 2, noop: 0, skipped: 0, failed: 0 });
  assert.ok(peopleOf(h.tables, S.one).includes(`${P.bob}:edit`));
  assert.ok(peopleOf(h.tables, S.two).includes(`${P.bob}:edit`));
  const j = h.tables.bulk_action_rows.find((x) => x.record_id === S.one);
  assert.deepEqual(JSON.parse(j.before).people, [{ person_id: P.bob, role: 'view' }]);
  assert.deepEqual(JSON.parse(j.after).people, [{ person_id: P.bob, role: 'edit' }]);
  assert.equal(h.tables.bulk_actions[0].mail_state, 'pending');
});

test('share_access with a team: adds, changes, noop, and the owning team is refused (it is the owner, not a share)', async () => {
  const h = setup();
  const p = await preview(h, admin(U.admin), 'physical_samples', shareBody([S.one, S.three, S.five], team(T.beta), 'view'));
  assert.deepEqual(p.body.results.map((r) => [r.code, r.status]), [['SM-001', 'ok'], ['SM-003', 'noop'], ['SM-005', 'ok']]);
  const owning = await preview(h, admin(U.admin), 'physical_samples', shareBody([S.five], team(T.alpha), 'view'));
  assert.equal(owning.body.results[0].status, 'skip');
  assert.match(owning.body.results[0].reason, /owns this record/);
  await ranOk(h, member(U.ann), shareBody([S.one, S.three], team(T.beta), 'edit'));
  assert.deepEqual(teamsOf(h.tables, S.one), [`${T.beta}:edit`]);
  assert.deepEqual(teamsOf(h.tables, S.three), [`${T.beta}:edit`]);
});

test('share_access: an old co-owner (the old table) counts as Can edit; sharing at that level is a noop, a lower one converts the row', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ sample_id: S.two, user_id: U.eve });
  const h = setup({ tables: world });
  assert.equal((await preview(h, member(U.ann), 'physical_samples', shareBody([S.two], person(P.eve), 'edit'))).body.results[0].status, 'noop');
  const out = await ranOk(h, member(U.ann), shareBody([S.two], person(P.eve), 'view'));
  assert.equal(out.counts.applied, 1);
  assert.deepEqual(world.sample_co_owners, [], 'the old row is dropped when the access row is written');
  assert.ok(peopleOf(world, S.two).includes(`${P.eve}:view`));
  const j = h.tables.bulk_action_rows.find((x) => x.record_id === S.two);
  assert.deepEqual(JSON.parse(j.before).people, [{ person_id: P.eve, role: 'edit' }], 'the snapshot reads an old co-owner as Can edit');
});

// ---- remove_access --------------------------------------------------------------------------------------

test('remove_access: removes a listed person or team, noop when not listed, refuses the owner and the owning team with reasons', async () => {
  const h = setup();
  const p = await preview(h, member(U.ann), 'physical_samples', removeBody([S.one, S.two, S.three], person(P.bob)));
  assert.deepEqual(p.body.results.map((r) => [r.code, r.status]), [['SM-001', 'ok'], ['SM-002', 'noop'], ['SM-003', 'noop']]);
  const owner = await preview(h, member(U.ann), 'physical_samples', removeBody([S.one], person(P.ann)));
  assert.deepEqual(owner.body.results[0], {
    id: S.one, code: 'SM-001', status: 'skip', reason: 'That person is the owner of this record, so their access cannot be removed. Change the owner instead.',
  });
  const teams = await preview(h, admin(U.admin), 'physical_samples', removeBody([S.one, S.three, S.five], team(T.beta)));
  assert.deepEqual(teams.body.results.map((r) => [r.code, r.status]), [['SM-001', 'noop'], ['SM-003', 'ok'], ['SM-005', 'noop']]);
  const owning = await preview(h, admin(U.admin), 'physical_samples', removeBody([S.five], team(T.alpha)));
  assert.equal(owning.body.results[0].status, 'skip');
  assert.match(owning.body.results[0].reason, /owns this record/);
  const out = await ranOk(h, member(U.ann), removeBody([S.one], person(P.bob)));
  assert.equal(out.counts.applied, 1);
  assert.ok(!peopleOf(h.tables, S.one).includes(`${P.bob}:view`));
  assert.equal(h.tables.bulk_actions[0].mail_state, 'none', 'removing access mails nobody');
  assert.equal(h.log.timers.length, 0);
});

test('remove_access of an old co-owner is a real change (the snapshot sees the old row), not a noop', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ sample_id: S.two, user_id: U.eve });
  const h = setup({ tables: world });
  const out = await ranOk(h, member(U.ann), removeBody([S.two], person(P.eve)));
  assert.equal(out.counts.applied, 1);
  assert.deepEqual(world.sample_co_owners, []);
});

// ---- partial success, visibility ------------------------------------------------------------------------

test('partial success: unreadable, not the owner, noop and applied in one action; the counts and the journal tell them apart', async () => {
  const hidden = S.three;
  const h = setup({ canRead: (user, collection, id) => id !== hidden });
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two, S.three, S.four, ID(404)], person(P.bob), 'view'));
  assert.deepEqual(out.counts, { total: 5, applied: 1, noop: 1, skipped: 3, failed: 0 });
  assert.deepEqual(byId(out.results)[S.three], { id: S.three, code: null, outcome: 'skipped', reason: 'That record does not exist, or you cannot see it.' });
  assert.deepEqual(byId(out.results)[S.four], { id: S.four, code: 'SM-004', outcome: 'skipped', reason: 'You are not the owner of this record.' });
  assert.equal(h.tables.bulk_action_rows.length, 5);
  assert.equal(h.tables.bulk_actions[0].n_applied, 1);
  assert.equal(h.tables.bulk_actions[0].n_skipped, 4);
});

test('a database error on one record fails that record (generic words, logged) and the rest go on', async () => {
  const world = baseTables();
  const h = setup({ tables: world });
  const real = h.database.transaction;
  let thrown = false;
  h.database.transaction = async (work) => real(async (trx) => {
    const wrapped = (t) => {
      const q = trx(t);
      if (t !== 'sample_access') return q;
      return {
        ...q,
        insert: (...args) => {
          if (!thrown) {
            thrown = true;
            throw Object.assign(new Error('connection reset: secret host'), { code: '08006' });
          }
          return q.insert(...args);
        },
      };
    };
    return work(Object.assign(wrapped, { raw: trx.raw }));
  });
  const out = await apply(h, member(U.ann), 'physical_samples', shareBody([S.one, S.two], person(P.eve), 'view'));
  const res = out.body.results;
  assert.equal(res.filter((r) => r.outcome === 'failed').length, 1);
  assert.ok(res.every((r) => r.reason === undefined || r.reason === 'Something went wrong changing this record.'));
  assert.ok(!JSON.stringify(out.body).includes('secret host'));
  assert.ok(h.log.errors.some((m) => m.includes('secret host')));
  assert.equal(out.body.counts.applied, 1);
});

test('snapshots reach administrators only, in the journal read', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), assignBody([S.one], T.beta));
  const asAnn = await getOne(h, member(U.ann), out.action_id);
  assert.equal(asAnn.status, 200);
  assert.equal(asAnn.body.rows[0].before, null);
  assert.equal(asAnn.body.rows[0].after, null);
  assert.equal(asAnn.body.action.mail_state, 'pending');
  const asAdmin = await getOne(h, admin(U.admin), out.action_id);
  assert.equal(JSON.parse(JSON.stringify(asAdmin.body.rows[0].before)).owner_person_id, P.ann);
  assert.equal(asAdmin.body.rows[0].after.owner_team_id, T.beta);
  assert.equal((await getOne(h, member(U.bob), out.action_id)).status, 404);
});

// ---- undo and revert ------------------------------------------------------------------------------------

test('undo of a share puts the list back through remove, add and change; mail is cancelled and its timer cleared', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.bob), 'edit'));
  const before = { s1: peopleOf(h.tables, S.one), s2: peopleOf(h.tables, S.two) };
  assert.ok(before.s1.includes(`${P.bob}:edit`));
  const r = await undo(h, member(U.ann), out.action_id);
  assert.equal(r.body.state, 'undone');
  assert.deepEqual(r.body.results.map((x) => x.revert_outcome), ['reverted', 'reverted']);
  assert.ok(peopleOf(h.tables, S.one).includes(`${P.bob}:view`), 'back to Can view');
  assert.ok(!peopleOf(h.tables, S.two).some((x) => x.startsWith(P.bob)), 'the added person is removed');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'cancelled');
  assert.equal(h.log.timers[0].cleared, true);
  await h.fire(0); // even if the timer fired, there is nothing to send
  assert.equal(h.log.mail.length, 0);
  const rev = h.tables.bulk_actions.find((a) => a.revert_of === out.action_id);
  assert.equal(rev.mail_state, 'none');
  assert.equal(rev.kind, 'share_access');
});

test('undo of a team share and of a team removal', async () => {
  const h = setup();
  const added = await ranOk(h, member(U.ann), shareBody([S.one, S.three], team(T.beta), 'edit'));
  assert.equal((await undo(h, member(U.ann), added.action_id)).body.state, 'undone');
  assert.deepEqual(teamsOf(h.tables, S.one), []);
  assert.deepEqual(teamsOf(h.tables, S.three), [`${T.beta}:view`], 'the level it had');
  const removed = await ranOk(h, member(U.ann), removeBody([S.three], team(T.beta)));
  assert.deepEqual(teamsOf(h.tables, S.three), []);
  assert.equal((await undo(h, member(U.ann), removed.action_id)).body.state, 'undone');
  assert.deepEqual(teamsOf(h.tables, S.three), [`${T.beta}:view`]);
});

test('undo of a person removal restores the entry at its level', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), removeBody([S.one], person(P.bob)));
  assert.ok(!peopleOf(h.tables, S.one).includes(`${P.bob}:view`));
  assert.equal((await undo(h, member(U.ann), out.action_id)).body.state, 'undone');
  assert.ok(peopleOf(h.tables, S.one).includes(`${P.bob}:view`));
});

test('undo of assign_team by the previous owner is refused (Ruling O5: she can no longer manage it); the administrator\'s revert puts it back', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), assignBody([S.one], T.alpha));
  const r = await undo(h, member(U.ann), out.action_id);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'partly_reverted');
  assert.deepEqual(r.body.results.map((x) => [x.revert_outcome, x.reason]), [['refused', 'You can no longer manage this record, so it cannot be handed back. Ask an administrator to revert it.']]);
  assert.equal(row(h.tables, 'physical_samples', S.one).owner_team_id, T.alpha, 'left as it is');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'pending', 'a refused undo changed nothing, so the mail still goes');
  assert.equal(h.log.timers[0].cleared, false);
  await h.fire(0);
  assert.deepEqual(h.log.mail.map((m) => m.to), ['eve@login.example'], 'the manager of the new owner team is told');
  const rev = await revert(h, admin(U.admin), out.action_id);
  assert.equal(rev.body.state, 'reverted');
  const one = row(h.tables, 'physical_samples', S.one);
  assert.equal(one.owner_person_id, P.ann);
  assert.equal(one.owner_team_id, null);
  assert.deepEqual(peopleOf(h.tables, S.one).filter((x) => !x.endsWith(':own')), [`${P.bob}:view`], 'Ann\'s Can edit row is gone: she owns it again');
});

test('undo of assign_team to a team the actor manages works: she still manages it afterwards', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), assignBody([S.one], T.beta));
  const r = await undo(h, member(U.ann), out.action_id);
  assert.equal(r.body.state, 'undone');
  assert.equal(row(h.tables, 'physical_samples', S.one).owner_person_id, P.ann);
  assert.equal(row(h.tables, 'physical_samples', S.one).owner_team_id, null);
});

test('revert of change_owner from a team: refused when the old team has no manager now, reverted once it has one', async () => {
  const h = setup();
  const out = await ranOk(h, admin(U.admin), ownerBody([S.five], P.bob));
  assert.equal(row(h.tables, 'physical_samples', S.five).owner_person_id, P.bob);
  h.tables.team_members = h.tables.team_members.filter((m) => !(m.team_id === T.alpha && m.is_manager)); // Alpha lost its manager
  let r = await revert(h, admin(U.admin), out.action_id);
  assert.equal(r.body.state, 'partly_reverted');
  assert.deepEqual(r.body.results.map((x) => [x.revert_outcome, x.reason]), [['refused', 'The team that owned this record has no manager now, so it cannot be handed back.']]);
  assert.equal(row(h.tables, 'physical_samples', S.five).owner_person_id, P.bob);
  h.tables.team_members.push({ team_id: T.alpha, person_id: P.eve, is_manager: true });
  r = await revert(h, admin(U.admin), out.action_id);
  assert.equal(r.body.state, 'reverted');
  assert.equal(row(h.tables, 'physical_samples', S.five).owner_team_id, T.alpha);
  assert.equal(row(h.tables, 'physical_samples', S.five).owner_person_id, null);
  assert.ok(!peopleOf(h.tables, S.five).some((x) => x.startsWith(P.bob)), 'the person owner is not left behind as Can edit');
});

test('revert is changed_since when the access list moved on (a person was shared since)', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.eve), 'view'));
  h.tables.sample_access.find((r) => r.sample_id === S.one && r.person_id === P.bob).role = 'edit'; // changed since: Bob's level
  const r = await revert(h, admin(U.admin), out.action_id);
  const res = byId(r.body.results);
  assert.equal(res[S.one].revert_outcome, 'changed_since');
  assert.equal(res[S.two].revert_outcome, 'reverted');
  assert.equal(r.body.state, 'partly_reverted');
});

test('a revert that put anything back cancels a mail still held; one that changed nothing leaves it', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.one], person(P.eve), 'view'));
  h.tables.sample_access.push({ sample_id: S.one, person_id: P.cy, role: 'view', team_access_id: null }); // changed since
  const r = await revert(h, admin(U.admin), out.action_id);
  assert.equal(r.body.results[0].revert_outcome, 'changed_since');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'pending');
  h.tables.sample_access.pop();
  await revert(h, admin(U.admin), out.action_id);
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'cancelled');
});

test('the revert is journaled and sends no mail, a revert of it is refused', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.eve), 'view'));
  h.log.clock = new Date(T0.getTime() + 3_600_000);
  const r = await revert(h, admin(U.admin), out.action_id);
  assert.equal(r.body.state, 'reverted');
  assert.equal(h.log.mail.length, 0);
  const again = await revert(h, admin(U.admin), r.body.revert_action_id);
  assert.equal(again.status, 409);
  assert.equal(errorOf(again).extensions.code, 'CANNOT_REVERT_A_REVERT');
});

// ---- the summary mail -----------------------------------------------------------------------------------

test('the timer sends one mail per recipient with the records listed; the owner of the action is never mailed; the state becomes sent', async () => {
  const h = setup();
  // Alpha's managers: Eve. Ann (who acts) is a plain member. Make Ann a manager too: she must not be mailed.
  h.tables.team_members.find((m) => m.team_id === T.alpha && m.person_id === P.ann).is_manager = true;
  const out = await ranOk(h, member(U.ann), assignBody([S.one, S.two], T.alpha));
  assert.equal(h.log.mail.length, 0);
  h.log.clock = new Date(h.log.timers[0].ms + T0.getTime());
  await h.fire(0);
  assert.equal(h.log.mail.length, 1, 'one mail per recipient: Eve only');
  const [mail] = h.log.mail;
  assert.equal(mail.to, 'eve@login.example');
  assert.equal(mail.subject, 'Ann Owner made the team Alpha lab the owner of 2 samples');
  assert.match(mail.text, /SM-001: https:\/\/lab\.example\/admin\/home\/samples\/00000000-0000-4000-8000-000000000001/);
  assert.match(mail.text, /SM-002/);
  assert.match(mail.text, /As a manager of Alpha lab/);
  assert.match(mail.html, /<a href="https:\/\/lab\.example\/admin\/home\/samples\//);
  assert.deepEqual(mail.schema, { fake: 'schema' }, 'the schema of the request that ran the action is kept for the timer');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'sent');
  await h.fire(0); // a second firing finds it sent
  assert.equal(h.log.mail.length, 1);
});

test('change_owner mails the new owner once, a single record reads as the single-record mail', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), ownerBody([S.one], P.bob));
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.equal(h.log.mail[0].to, 'bob@login.example');
  assert.equal(h.log.mail[0].subject, 'Ann Owner made you the owner of sample SM-001');
  assert.match(h.log.mail[0].text, /Open it here: https:\/\/lab\.example\//);
});

test('upper-case ids are stored lower-case, so the mail still links the record (the readers tables hold lower-case ids)', async () => {
  const hex = 'abcdef00-0000-4000-8000-00000000000a'; // an id with letters in it, unlike the plain-digit ids above
  const world = baseTables();
  world.physical_samples.push(sample(hex, P.ann, { sample_code: 'SM-HEX' }));
  world.sample_readers.push(...[U.ann, U.bob].map((user_id) => ({ record_id: hex, user_id })));
  const h = setup({ tables: world });
  const out = await ranOk(h, member(U.ann), ownerBody([hex.toUpperCase(), hex], P.bob));
  assert.equal(out.counts.total, 1, 'the same id in two cases is one record');
  assert.deepEqual(h.tables.bulk_action_rows.map((r) => r.record_id), [hex], 'stored as the readers tables hold it');
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.match(h.log.mail[0].text, new RegExp(`/samples/${hex}`));
  assert.doesNotMatch(h.log.mail[0].text, /cannot open/i);
});

test('share_access with a person mails them; with a team mails each active member that has an address, never the actor', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.eve), 'edit'));
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.equal(h.log.mail[0].to, 'eve@login.example');
  assert.match(h.log.mail[0].subject, /gave you access to 2 samples/);
  assert.match(h.log.mail[0].text, /Your role: Can edit\./);
  h.log.mail.length = 0;
  await ranOk(h, member(U.ann), shareBody([S.two, S.three], team(T.alpha), 'view'));
  await h.fire();
  // Alpha: Eve and Bob (login addresses); not Cy (a login with no address), Nell (no login), Zed (inactive) or Ann (the actor)
  assert.deepEqual(h.log.mail.map((m) => m.to).sort(), ['bob@login.example', 'eve@login.example']);
  assert.ok(h.log.mail.every((m) => /gave you access to 2 samples via Alpha lab/.test(m.subject)));
});

test('a team member waiting for approval on a record is not told about it, and is mailed the rest (as in the single-record mail)', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), shareBody([S.two, S.three], team(T.alpha), 'view'));
  const grant = h.tables.sample_team_access.find((g) => same(g.sample_id, S.two) && same(g.team_id, T.alpha));
  h.tables.sample_team_pending.push({ team_access_id: grant.team_access_id, person_id: P.bob, state: 'pending' });
  await h.fire();
  const to = (who) => h.log.mail.filter((m) => m.to === who);
  assert.equal(to('eve@login.example').length, 1);
  assert.match(to('eve@login.example')[0].subject, /gave you access to 2 samples/);
  assert.equal(to('bob@login.example').length, 1);
  assert.match(to('bob@login.example')[0].subject, /gave you access to sample SM-003 via Alpha lab/, 'Bob waits on SM-002, so only SM-003 is his');
  assert.doesNotMatch(to('bob@login.example')[0].text, /SM-002/);
});

test('a team member waiting on every record of the action is not mailed at all', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), shareBody([S.two], team(T.alpha), 'view'));
  h.tables.sample_team_pending.push({ team_access_id: h.tables.sample_team_access.find((g) => same(g.sample_id, S.two) && same(g.team_id, T.alpha)).team_access_id, person_id: P.bob, state: 'declined' });
  await h.fire();
  assert.deepEqual(h.log.mail.map((m) => m.to), ['eve@login.example']);
});

test('a mail failure is logged without the recipient address, even when the transport quotes it', async () => {
  const h = setup({ mailFail: 'Recipient address rejected: <bob@login.example>' });
  await ranOk(h, member(U.ann), ownerBody([S.one], P.bob));
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  const failed = h.log.warnings.filter((m) => m.includes('was not sent'));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /Recipient address rejected/);
  assert.doesNotMatch(failed[0], /@/);
});

test('a person with no login is mailed at their People address with no link', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.nell), 'view'));
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.equal(h.log.mail[0].to, 'nell@people.example');
  assert.doesNotMatch(h.log.mail[0].text, /https:\/\//);
  assert.match(h.log.mail[0].text, /cannot open some of them yet/);
});

test('a changed level mails nobody (only a new grant is told), and a mix mails only the new ones', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), shareBody([S.one], person(P.bob), 'edit')); // Bob had Can view: a change
  await h.fire(0);
  assert.equal(h.log.mail.length, 0);
  assert.equal(h.tables.bulk_actions[0].mail_state, 'sent');
  const mixed = await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.bob), 'view')); // S.one: edit to view (a change), S.two: new
  assert.equal(mixed.counts.applied, 2);
  await h.fire();
  assert.equal(h.log.mail.length, 1);
  assert.match(h.log.mail[0].subject, /sample SM-002/, 'only SM-002 is new');
  assert.doesNotMatch(h.log.mail[0].text, /SM-001/);
  const teams = await ranOk(h, member(U.ann), shareBody([S.three], team(T.beta), 'edit')); // Beta had Can view on S.three: a change
  await h.fire();
  assert.equal(h.log.mail.length, 1, 'a team level change mails nobody');
  assert.equal(teams.counts.applied, 1);
});

test('an undo that put only some records back leaves the mail pending for the rest', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.eve), 'view'));
  h.tables.sample_access.push({ sample_id: S.one, person_id: P.cy, role: 'view', team_access_id: null }); // S.one changed since: its undo is changed_since
  const r = await undo(h, member(U.ann), out.action_id);
  assert.equal(r.body.state, 'partly_reverted');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'pending');
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.match(h.log.mail[0].subject, /sample SM-001/, 'the one still applied; SM-002 was put back and is not announced');
  assert.doesNotMatch(h.log.mail[0].text, /SM-002/);
});

test('a recipient who cannot read a record gets its code but no link', async () => {
  const world = baseTables();
  world.sample_readers = world.sample_readers.filter((r) => !(r.record_id === S.two && r.user_id === U.eve));
  const h = setup({ tables: world });
  await ranOk(h, member(U.ann), shareBody([S.one, S.two], person(P.eve), 'view'));
  await h.fire(0);
  const [mail] = h.log.mail;
  assert.match(mail.text, /SM-001: https:\/\//);
  assert.match(mail.text, /^- SM-002$/m);
  assert.match(mail.text, /cannot open some of them yet/);
});

test('a failed email never undoes the change: the mail is claimed (sent), the failure is logged', async () => {
  const h = setup({ mailFail: true });
  const out = await ranOk(h, member(U.ann), ownerBody([S.one], P.bob));
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.equal(row(h.tables, 'physical_samples', S.one).owner_person_id, P.bob);
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'sent');
  assert.ok(h.log.warnings.some((m) => m.includes('was not sent') && m.includes('SMTP refused')));
});

test('undo and the timer cannot both win: the sender claims under the row lock, an undo that came first leaves nothing to send', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.two], person(P.eve), 'view'));
  h.log.locks.length = 0;
  await h.fire(0); // sender first: claims it
  assert.ok(h.log.locks.includes('bulk_actions'), 'the sender re-reads the action under a row lock');
  assert.equal(h.log.mail.length, 1);
  const r = await undo(h, member(U.ann), out.action_id); // the undo still undoes the change (the mail has gone) but cannot cancel it
  assert.equal(r.body.state, 'undone');
  assert.equal(h.tables.bulk_actions.find((a) => a.action_id === out.action_id).mail_state, 'sent');
  assert.equal(h.log.mail.length, 1);
});

test('a mail built after a partial revert lists only what is still applied', async () => {
  const h = setup();
  const out = await ranOk(h, member(U.ann), shareBody([S.one, S.two, S.three], person(P.eve), 'view'));
  // an administrator put SM-002 back (outside the helper: directly mark it reverted) and the mail is still pending
  h.tables.bulk_action_rows.find((x) => x.record_id === S.two).revert_outcome = 'reverted';
  await h.fire(0);
  assert.equal(h.log.mail.length, 1);
  assert.match(h.log.mail[0].text, /SM-001/);
  assert.match(h.log.mail[0].text, /SM-003/);
  assert.doesNotMatch(h.log.mail[0].text, /SM-002/);
  assert.equal(out.counts.applied, 3);
});

test('an action that changed nothing, and kinds that mail nobody, have no timer and no pending mail', async () => {
  const h = setup();
  await ranOk(h, member(U.ann), shareBody([S.one], person(P.bob), 'view')); // already so: noop
  await ranOk(h, admin(U.admin), { kind: 'restrict', ids: [S.one], params: {} });
  assert.equal(h.log.timers.length, 0);
  assert.deepEqual(h.tables.bulk_actions.map((a) => a.mail_state), ['none', 'none']);
});

test('the startup sweep sends every overdue pending action, re-arms those not yet due, and ignores sent and cancelled ones', async () => {
  const first = setup();
  const a = await ranOk(first, member(U.ann), shareBody([S.one], person(P.eve), 'view')); // pending, due 62 s after the start
  const b = await ranOk(first, member(U.ann), ownerBody([S.two], P.bob)); // pending, made not yet due below
  const c = await ranOk(first, member(U.ann), shareBody([S.three], person(P.eve), 'view')); // cancelled below
  const { tables } = first;
  tables.bulk_actions.find((x) => x.action_id === b.action_id).mail_due_at = new Date(T0.getTime() + 600_000);
  tables.bulk_actions.find((x) => x.action_id === c.action_id).mail_state = 'cancelled';
  // a restart 90 s later: the world is the database; the timers are gone
  const h = setup({ tables, sweep: true, now: new Date(T0.getTime() + 90_000), getSchema: async () => ({ restarted: true }) });
  await h.swept;
  assert.equal(h.log.mail.length, 1, 'only the overdue one is mailed');
  assert.equal(h.log.mail[0].to, 'eve@login.example');
  assert.deepEqual(h.log.mail[0].schema, { restarted: true }, 'with no request, the schema comes from getSchema');
  assert.equal(tables.bulk_actions.find((x) => x.action_id === a.action_id).mail_state, 'sent');
  assert.equal(tables.bulk_actions.find((x) => x.action_id === b.action_id).mail_state, 'pending');
  assert.equal(h.log.timers.length, 1, 'the one not yet due is armed again');
  assert.equal(h.log.timers[0].ms, 600_000 - 90_000);
  assert.equal(tables.bulk_actions.find((x) => x.action_id === c.action_id).mail_state, 'cancelled');
  // a second sweep (another restart) finds nothing overdue left
  const again = setup({ tables, sweep: true, now: new Date(T0.getTime() + 90_000) });
  await again.swept;
  assert.equal(again.log.mail.length, 0);
});

// An apply that was cut off leaves counts null and mail_state 'none' (it never reached its finally): the world below is that, made from a real apply.
async function cutOff(kindBody, acc = member(U.ann)) {
  const first = setup();
  const out = await ranOk(first, acc, kindBody);
  const action = first.tables.bulk_actions.find((x) => x.action_id === out.action_id);
  Object.assign(action, { n_applied: null, n_skipped: null, n_failed: null, mail_state: 'none', mail_due_at: null });
  return { tables: first.tables, action, out };
}

test('an action whose apply was cut off is finalised by the startup sweep: counts recounted, revertable, its mail goes out once', async () => {
  const { tables, action, out } = await cutOff(ownerBody([S.one, S.two], P.bob));
  const h = setup({ tables, sweep: true, now: new Date(T0.getTime() + 6 * 60_000) });
  await h.swept;
  assert.equal(action.n_applied, 2);
  assert.equal(action.n_skipped, 0);
  assert.equal(action.n_failed, 0);
  assert.equal(action.undo_until.getTime(), T0.getTime() + 60_000);
  assert.equal(action.mail_state, 'sent', 'made pending and due now, then sent by the same sweep');
  assert.equal(h.log.mail.length, 1);
  assert.equal(h.log.mail[0].to, 'bob@login.example');
  // the journal now reports the real counts, and an administrator's revert no longer answers STILL_APPLYING
  const one = await getOne(h, admin(U.admin), out.action_id);
  assert.equal(one.body.action.n_applied, 2);
  const r = await revert(h, admin(U.admin), out.action_id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'reverted');
  assert.equal(row(tables, 'physical_samples', S.one).owner_person_id, P.ann);
  // another restart changes and mails nothing more
  const again = setup({ tables, sweep: true, now: new Date(T0.getTime() + 12 * 60_000) });
  await again.swept;
  assert.equal(again.log.mail.length, 0);
  assert.equal(action.n_applied, 2);
});

test('a young action with null counts is left alone by the sweep and still answers STILL_APPLYING', async () => {
  const { tables, action, out } = await cutOff(ownerBody([S.one], P.bob));
  const young = setup({ tables, sweep: true, now: new Date(T0.getTime() + 4 * 60_000) });
  await young.swept;
  assert.equal(action.n_applied, null, 'still within the time an apply may take');
  assert.equal(action.mail_state, 'none');
  assert.equal(young.log.mail.length, 0);
  const r = await revert(young, admin(U.admin), out.action_id);
  assert.equal(errorOf(r).extensions.code, 'STILL_APPLYING');
});

test('finalising a cut-off action only counts what was journaled: other outcomes, a kind that mails nobody, and an action that changed nothing', async () => {
  const { tables, action } = await cutOff(shareBody([S.one, S.two, S.three], person(P.eve), 'view'));
  // one record changed, one skipped, one failed, one no-op journaled before the cut
  Object.assign(tables.bulk_action_rows.find((r) => r.record_id === S.three), { outcome: 'skipped', before: null, after: null });
  tables.bulk_action_rows.push(
    { action_id: action.action_id, record_id: ID(77), record_code: 'X', outcome: 'failed', reason: 'x', before: null, after: null, revert_outcome: null, revert_reason: null },
    { action_id: action.action_id, record_id: ID(78), record_code: 'Y', outcome: 'noop', reason: null, before: null, after: null, revert_outcome: null, revert_reason: null },
  );
  tables.bulk_action_rows = tables.bulk_action_rows.filter((r) => r.record_id !== S.two);
  const h = setup({ tables, sweep: true, now: new Date(T0.getTime() + 10 * 60_000) });
  await h.swept;
  assert.deepEqual([action.n_applied, action.n_skipped, action.n_failed], [1, 2, 1]);
  const none = await cutOff({ kind: 'restrict', ids: [S.one], params: {} }, admin(U.admin));
  const h2 = setup({ tables: none.tables, sweep: true, now: new Date(T0.getTime() + 10 * 60_000) });
  await h2.swept;
  assert.equal(none.action.n_applied, 1);
  assert.equal(none.action.mail_state, 'none', 'a kind that mails nobody stays none');
  assert.equal(h2.log.mail.length, 0);
});

test('finalising never touches an action that finished meanwhile (counts already written under the row lock)', async () => {
  const { tables, action } = await cutOff(ownerBody([S.one], P.bob));
  // the apply finishes between the sweep's look at the action and its lock on it
  const h = setup({
    tables, sweep: true, now: new Date(T0.getTime() + 10 * 60_000),
    beforeTransaction: () => Object.assign(action, { n_applied: 5, n_skipped: 0, n_failed: 0 }),
  });
  await h.swept;
  assert.equal(action.n_applied, 5, 'the real counts stand');
  assert.equal(action.mail_state, 'none');
  assert.equal(h.log.mail.length, 0);
});

test('the sweep is quiet when there is nothing to send and survives a database error', async () => {
  const h = setup({ sweep: true });
  await h.swept;
  assert.equal(h.log.warnings.length, 0);
  const world = baseTables();
  Object.defineProperty(world, 'bulk_actions', { get() { throw new Error('boom'); }, enumerable: true, configurable: true });
  const broken = setup({ tables: world, sweep: true });
  await broken.swept;
  assert.ok(broken.log.warnings.some((m) => m.includes('sweep of held summary mails failed')));
});

test('Lab Viewer and a stranger: nothing new changes the refusals of the framework (viewer 403 on every kind)', async () => {
  const world = baseTables();
  world.directus_users.push({ id: ID(299), email: 'v@x', role: '10000001-0000-0000-0000-000000000003' });
  const h = setup({ tables: world });
  for (const body of [assignBody([S.one], T.alpha), ownerBody([S.one], P.bob), shareBody([S.one], person(P.bob), 'view'), removeBody([S.one], person(P.bob))]) {
    for (const fn of [preview, apply]) {
      const r = await fn(h, member(ID(299)), 'physical_samples', body);
      assert.equal(r.status, 403);
      assert.equal(errorOf(r).extensions.code, 'READ_ONLY_ROLE');
    }
  }
  assert.deepEqual(h.log.inserts, []);
});

// ---- the mail text (pure) -------------------------------------------------------------------------------

test('summaryContent lists the first 20 codes then "and N more", escapes everything, and words each mode', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ code: `SM-${String(i + 1).padStart(3, '0')}`, link: `https://lab.example/admin/home/samples/${i + 1}`, blocked: false }));
  const m = summaryContent({ adder: 'Ann <b>Owner</b>', kind: 'sample', items, mode: 'owner' });
  assert.equal(m.subject, 'Ann <b>Owner</b> made you the owner of 25 samples');
  assert.equal(m.text.split('\n').filter((l) => l.startsWith('- SM-')).length, 20);
  assert.match(m.text, /^- and 5 more$/m);
  assert.match(m.html, /<li>and 5 more<\/li>/);
  assert.ok(!m.html.includes('<b>Owner</b>'), 'the adder is escaped');
  assert.match(m.html, /&lt;b&gt;Owner&lt;\/b&gt;/);
  const team = summaryContent({ adder: 'Ann', kind: 'sample', items: items.slice(0, 2), mode: 'team_owner', teamName: 'Alpha "lab"' });
  assert.match(team.subject, /made the team Alpha "lab" the owner of 2 samples/);
  assert.match(team.text, /As a manager of Alpha "lab"/);
  assert.match(team.html, /Alpha &quot;lab&quot;/);
  const share = summaryContent({ adder: 'Ann', kind: 'campaign', items: items.slice(0, 3), mode: 'share', role: 'Can view', teamName: 'Alpha' });
  assert.equal(share.subject, 'Ann gave you access to 3 campaigns via Alpha');
  assert.match(share.text, /Your role: Can view\./);
  const exactly20 = summaryContent({ adder: 'Ann', kind: 'sample', items: items.slice(0, 20), mode: 'owner' });
  assert.doesNotMatch(exactly20.text, /and \d+ more/);
  const blocked = summaryContent({ adder: 'Ann', kind: 'sample', items: [{ code: 'SM-001', link: 'https://x', blocked: true }], mode: 'share', role: 'Can view', blockedReason: 'no_login' });
  assert.doesNotMatch(blocked.text, /https:/);
  assert.match(blocked.text, /D1 login/);
});
