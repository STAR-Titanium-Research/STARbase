// Run with: node --test core/extensions/d1-teams/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext from './index.js';

// ---- ids and the world ----------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LAB_ADMIN_ROLE = '10000001-0000-0000-0000-000000000001';
const R = { member: ID(31), super: ID(32) };
const POLICY = { admin: ID(41), member: ID(42) };
const P = { ann: ID(101), bob: ID(102), cy: ID(103), eve: ID(104), fay: ID(105), gus: ID(106), adm: ID(107) };
const U = { ann: ID(201), bob: ID(202), eve: ID(203), fay: ID(204), admin: ID(205), stranger: ID(206), noperson: ID(207) };
const T = { additive: ID(301), beta: ID(302) };
const S = { one: ID(1), two: ID(2), three: ID(3) };
const PROJECT = ID(5);
const GRANT = { s1: ID(401), s2: ID(402), s3: ID(403), pr: ID(404) };
const FILE = { png: ID(501), pdf: ID(502), big: ID(503), svg: ID(504), huge: ID(505) };
const KINDS = ['sample', 'operation', 'test', 'campaign', 'project'];

// Ann manages Additive with Bob; Fay manages Beta; Eve owns SM-001 and the project, Fay owns SM-002, Ann owns SM-003.
// Additive has a view grant on SM-001, an edit grant on SM-002, a view grant on SM-003 and an investigator grant on the project.
// Cy waits on three of them (declined on SM-003).
const baseTables = () => ({
  people: [
    { person_id: P.ann, full_name: 'Ann Manager', email: 'ann@people.example', user_id: U.ann },
    { person_id: P.bob, full_name: 'Bob Member', email: 'bob@people.example', user_id: U.bob },
    { person_id: P.cy, full_name: 'Cy Nologin', email: 'cy@people.example', user_id: null },
    { person_id: P.eve, full_name: 'Eve Owner', email: 'eve@people.example', user_id: U.eve },
    { person_id: P.fay, full_name: 'Fay Owner', email: 'fay@people.example', user_id: U.fay },
    { person_id: P.gus, full_name: 'Gus Newcomer', email: 'gus@people.example', user_id: null },
  ],
  directus_users: [
    { id: U.ann, email: 'ann@login.example', status: 'active', role: R.member },
    { id: U.bob, email: 'bob@login.example', status: 'active', role: R.member },
    { id: U.eve, email: 'eve@login.example', status: 'active', role: R.member },
    { id: U.fay, email: 'fay@login.example', status: 'active', role: R.member },
    { id: U.stranger, email: 'stranger@login.example', status: 'active', role: R.member },
    { id: U.noperson, email: 'noperson@login.example', status: 'active', role: R.member },
    { id: U.admin, email: 'admin@login.example', status: 'active', role: R.super },
  ],
  directus_access: [
    { role: R.member, user: null, policy: POLICY.member },
    { role: R.super, user: null, policy: POLICY.admin },
  ],
  directus_policies: [
    { id: POLICY.admin, admin_access: true },
    { id: POLICY.member, admin_access: false },
  ],
  directus_files: [
    { id: FILE.png, type: 'image/png', filesize: '2048' },
    { id: FILE.svg, type: 'image/svg+xml', filesize: 1048576 },
    { id: FILE.pdf, type: 'application/pdf', filesize: '2048' },
    { id: FILE.big, type: 'image/jpeg', filesize: '1048577' }, // bigint columns come back as strings
    { id: FILE.huge, type: 'image/png', filesize: null },
  ],
  teams: [
    { team_id: T.additive, name: 'Additive', description: 'Powder people', color: 'teal', logo: null, created_by_person_id: P.ann, created_at: '2026-10-01T00:00:00Z' },
    { team_id: T.beta, name: 'Beta', description: null, color: 'blue', logo: null, created_by_person_id: P.fay, created_at: '2026-10-02T00:00:00Z' },
  ],
  team_members: [
    { member_id: ID(601), team_id: T.additive, person_id: P.ann, is_manager: true, joined_at: '2026-10-01T00:00:00Z' },
    { member_id: ID(602), team_id: T.additive, person_id: P.bob, is_manager: false, joined_at: '2026-10-03T00:00:00Z' },
    { member_id: ID(603), team_id: T.beta, person_id: P.fay, is_manager: true, joined_at: '2026-10-02T00:00:00Z' },
  ],
  team_events: [],
  physical_samples: [
    { sample_id: S.one, sample_code: 'SM-001', nickname: 'Bar A', owner_person_id: P.eve },
    { sample_id: S.two, sample_code: 'SM-002', nickname: null, owner_person_id: P.fay },
    { sample_id: S.three, sample_code: 'SM-003', nickname: 'Disc', owner_person_id: P.ann },
  ],
  projects: [{ project_id: PROJECT, project_code: 'PRJ1', project_name: 'Project One', principal_investigator_person: P.eve }],
  // Ann reads SM-001 and SM-003 (hers); she does not read SM-002 or the project. Eve reads her own.
  sample_readers: [
    { record_id: S.one, user_id: U.ann }, { record_id: S.three, user_id: U.ann }, { record_id: S.one, user_id: U.eve }, { record_id: S.two, user_id: U.fay },
  ],
  project_readers: [{ record_id: PROJECT, user_id: U.eve }],
  sample_team_access: [
    { team_access_id: GRANT.s1, sample_id: S.one, team_id: T.additive, role: 'view', trust_new_members: false },
    { team_access_id: GRANT.s2, sample_id: S.two, team_id: T.additive, role: 'edit', trust_new_members: false },
    { team_access_id: GRANT.s3, sample_id: S.three, team_id: T.additive, role: 'view', trust_new_members: false },
  ],
  project_team_access: [{ team_access_id: GRANT.pr, project_id: PROJECT, team_id: T.additive, role: 'investigator', trust_new_members: false }],
  sample_team_pending: [
    { team_access_id: GRANT.s1, person_id: P.cy, state: 'pending' },
    { team_access_id: GRANT.s2, person_id: P.cy, state: 'pending' },
    { team_access_id: GRANT.s3, person_id: P.cy, state: 'declined' },
  ],
  project_team_pending: [{ team_access_id: GRANT.pr, person_id: P.cy, state: 'pending' }],
  sample_access: [],
});

// ---- a tiny in-memory knex plus raw() answers ----------------------------------------------------------

const same = (a, b) => String(a) === String(b);
const pgError = (code, constraint, message = `error ${code}`) => Object.assign(new Error(message), { code, constraint });

function makeDb(tables, rawAnswers) {
  const log = { tx: [], statements: [] };
  const db = (table) => {
    const preds = [];
    let order = null;
    let max = Infinity;
    const rows = () => {
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (order) out = [...out].sort((a, b) => (a[order.col] < b[order.col] ? -1 : a[order.col] > b[order.col] ? 1 : 0) * (order.dir === 'desc' ? -1 : 1));
      return out.slice(0, max);
    };
    const project = (row, cols) => (row === undefined ? undefined : cols.length ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : { ...row });
    const q = {
      where(a, v) { preds.push((r) => same(r[a], v)); return q; },
      whereIn(c, values) { preds.push((r) => values.some((v) => same(r[c], v))); return q; },
      orderBy(col, dir = 'asc') { order = { col, dir }; return q; },
      limit(n) { max = n; return q; },
      select: async (...cols) => rows().map((r) => project(r, cols)),
      first: async (...cols) => project(rows()[0], cols),
      insert(row) {
        const rec = { ...row };
        log.statements.push({ op: 'insert', table, row: rec });
        if (table === 'teams') {
          if ((tables.teams ?? []).some((t) => String(t.name).trim().toLowerCase() === String(rec.name).trim().toLowerCase())) throw pgError('23505', 'teams_name_key');
          rec.team_id ??= ID(900 + (tables.teams ?? []).length);
          rec.color ??= 'teal';
          rec.description ??= null;
          rec.logo ??= null;
        }
        if (table === 'team_members') {
          if ((tables.team_members ?? []).some((m) => same(m.team_id, rec.team_id) && same(m.person_id, rec.person_id))) throw pgError('23505', 'team_members_team_id_person_id_key');
          rec.member_id ??= ID(950 + (tables.team_members ?? []).length);
          rec.joined_at ??= '2026-10-14T12:00:00Z';
          rec.is_manager ??= false;
        }
        (tables[table] ??= []).push(rec);
        if (table === 'team_members') {
          // the sync trigger: a trusted grant gives a derived row, any other a pending row
          for (const kind of KINDS) {
            for (const g of (tables[`${kind}_team_access`] ?? []).filter((x) => same(x.team_id, rec.team_id))) {
              if (g.trust_new_members) (tables[`${kind}_access`] ??= []).push({ person_id: rec.person_id, team_access_id: g.team_access_id });
              else (tables[`${kind}_team_pending`] ??= []).push({ team_access_id: g.team_access_id, person_id: rec.person_id, state: 'pending' });
            }
          }
        }
        const done = Promise.resolve([rec]);
        done.returning = async (col) => [{ [col]: rec[col] }];
        return done;
      },
      update: async (changes) => {
        const hit = rows();
        log.statements.push({ op: 'update', table, changes: { ...changes } });
        if (table === 'teams' && changes.name !== undefined) {
          const clash = (tables.teams ?? []).some((t) => !hit.includes(t) && String(t.name).trim().toLowerCase() === String(changes.name).trim().toLowerCase());
          if (clash) throw pgError('23505', 'teams_name_key');
        }
        for (const r of hit) Object.assign(r, changes);
        return hit.length;
      },
      del: async () => {
        const hit = rows();
        log.statements.push({ op: 'delete', table });
        // owner_team_id of the four record tables is a foreign key ON DELETE RESTRICT (migration 183): a team that owns a record stays
        if (table === 'teams') {
          for (const t of hit) {
            for (const collection of ['physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns']) {
              if ((tables[collection] ?? []).some((r) => same(r.owner_team_id, t.team_id))) throw pgError('23503', collection + '_owner_team_id_fkey', 'violates foreign key constraint');
            }
          }
        }
        tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r));
        if (table === 'teams') {
          for (const t of hit) {
            for (const name of ['team_members', 'team_events']) tables[name] = (tables[name] ?? []).filter((r) => !same(r.team_id, t.team_id));
            for (const kind of KINDS) {
              const gone = (tables[`${kind}_team_access`] ?? []).filter((g) => same(g.team_id, t.team_id)).map((g) => String(g.team_access_id));
              tables[`${kind}_team_access`] = (tables[`${kind}_team_access`] ?? []).filter((g) => !gone.includes(String(g.team_access_id)));
              tables[`${kind}_team_pending`] = (tables[`${kind}_team_pending`] ?? []).filter((g) => !gone.includes(String(g.team_access_id)));
            }
          }
        }
        if (table === 'team_members') {
          for (const m of hit) {
            for (const kind of KINDS) {
              const mine = (tables[`${kind}_team_access`] ?? []).filter((g) => same(g.team_id, m.team_id)).map((g) => String(g.team_access_id));
              tables[`${kind}_team_pending`] = (tables[`${kind}_team_pending`] ?? []).filter((p) => !(mine.includes(String(p.team_access_id)) && same(p.person_id, m.person_id)));
            }
          }
        }
        return hit.length;
      },
    };
    return q;
  };
  db.raw = async (sql, bindings) => {
    for (const [prefix, answer] of Object.entries(rawAnswers)) {
      if (sql.startsWith(prefix)) return { rows: typeof answer === 'function' ? answer(bindings) : answer };
    }
    return { rows: [] };
  };
  // A transaction: the same tables, restored when the work throws. At COMMIT the deferred constraint of migration 181 is judged:
  // a team with members and no manager rolls everything back with SQLSTATE 23514 (thrown by the transaction call, not the callback).
  db.transaction = async (work) => {
    const snapshot = structuredClone(tables);
    const entry = { raw: [], committed: false };
    log.tx.push(entry);
    const trx = makeDb(tables, rawAnswers);
    const trxRaw = trx.raw;
    trx.raw = async (sql, bindings) => { entry.raw.push({ sql, bindings }); return trxRaw(sql, bindings); };
    trx.log = log;
    const rollback = () => {
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, snapshot);
    };
    try {
      const out = await work(trx);
      for (const t of new Set((tables.team_members ?? []).map((m) => String(m.team_id)))) {
        const mine = tables.team_members.filter((m) => String(m.team_id) === t);
        if (!mine.some((m) => m.is_manager)) throw pgError('23514', 'team_members_need_manager', 'A team must keep at least one manager');
      }
      entry.committed = true;
      return out;
    } catch (err) {
      rollback();
      throw err;
    }
  };
  db.log = log;
  return db;
}

// ---- a harness ------------------------------------------------------------------------------------------

function mount({ tables = baseTables(), env = {}, mailFail = false, notActionable = [], decideFail = null, breakAfterCommit = [] } = {}) {
  const decided = [];
  const mails = [];
  const cleared = [];
  const errors = [];
  const warnings = [];
  const actionable = (b) => !notActionable.some(([coll, ta, person]) => coll === b[0] && same(ta, b[1]) && same(person, b[2]));
  const kindOf = (collection) => ({ physical_samples: 'sample', manufacturing_operations: 'operation', test_sessions: 'test', campaigns: 'campaign', projects: 'project' })[collection];
  const raw = {
    'SELECT d1_private.team_pending_actionable': (b) => [{ ok: actionable(b) }],
    // d1_private.team_decide(collection, team_access_id, person_id, decision): approve makes a derived row, decline marks the row
    'SELECT d1_private.team_decide': (b) => {
      if (decideFail) throw decideFail;
      const [collection, ta, person, decision] = b;
      const kind = kindOf(collection);
      const pending = (tables[`${kind}_team_pending`] ?? []).find((p) => same(p.team_access_id, ta) && same(p.person_id, person));
      if (!pending) throw Object.assign(new Error('Nothing to decide'), { code: 'P0002' });
      decided.push({ collection, team_access_id: ta, person_id: person, decision });
      if (decision === 'approve') {
        tables[`${kind}_team_pending`] = tables[`${kind}_team_pending`].filter((p) => p !== pending);
        (tables[`${kind}_access`] ??= []).push({ person_id: person, team_access_id: ta });
      } else pending.state = 'declined';
      return [];
    },
  };
  const db = makeDb(tables, raw);
  // What the endpoint sees as `database`: reads of the tables in breakAfterCommit throw once a transaction has committed (to test that a
  // committed write never answers 500). Reads before the write, and everything inside a transaction, are untouched.
  const broken = new Set(breakAfterCommit);
  const database = Object.assign((table) => {
    if (broken.has(table) && db.log.tx.length && db.log.tx.every((t) => t.committed)) throw new Error(`reading ${table} failed`);
    return db(table);
  }, { raw: (...a) => db.raw(...a), transaction: (...a) => db.transaction(...a), log: db.log });
  const handlers = {};
  const order = [];
  const reg = (method) => (path, fn) => { handlers[`${method} ${path}`] = fn; order.push(`${method} ${path}`); };
  const router = { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') };
  const services = {
    UtilsService: class {
      constructor(opts) { this.opts = opts; }
      async clearCache(arg) { cleared.push({ opts: this.opts, arg, committed: db.log.tx.every((t) => t.committed) }); }
    },
    MailService: class {
      constructor(opts) { this.opts = opts; }
      async send(msg) {
        if (mailFail) throw new Error('mail down');
        mails.push({ ...msg, committed: db.log.tx.every((t) => t.committed) });
      }
    },
  };
  ext.handler(router, {
    database, services, env,
    logger: { error(m) { errors.push(m); }, warn(m) { warnings.push(m); } },
  });
  return { db, tables, handlers, order, mails, cleared, errors, warnings, decided };
}

const admin = (user) => ({ user, admin: true, app: true });
const member = (user) => ({ user, admin: false, app: true });

function call(h, { acc, params = {}, query = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const out = { status: 200, body: undefined };
    const res = {
      status(code) { out.status = code; return res; },
      json(b) { out.body = b; resolve(out); return res; },
    };
    Promise.resolve(h({ accountability: acc, params, query, body, schema: {} }, res)).catch(reject);
  });
}
const errorOf = (r) => r.body?.errors?.[0];
const names = (list) => list.map((x) => x.full_name ?? x.name);

// ---- plumbing ---------------------------------------------------------------------------------------------

test('401 without a user, on every route', async () => {
  const { handlers } = mount();
  const routes = ['GET /', 'GET /pending', 'GET /:id', 'POST /', 'PATCH /:id', 'DELETE /:id', 'POST /:id/members', 'PATCH /:id/members/:person_id',
    'DELETE /:id/members/:person_id', 'POST /pending/decide'];
  for (const route of routes) {
    const r = await call(handlers[route], { acc: { user: null }, params: { id: T.additive, person_id: P.bob } });
    assert.equal(r.status, 401, route);
    assert.equal(errorOf(r).extensions.code, 'UNAUTHORIZED');
    assert.equal(errorOf(r).extensions.source, 'd1-teams');
  }
});

test('/pending routes are registered before /:id, so the path is not read as a team id', () => {
  const { order } = mount();
  assert.ok(order.indexOf('GET /pending') < order.indexOf('GET /:id'));
  assert.ok(order.includes('DELETE /:id') && order.includes('DELETE /:id/members/:person_id'));
});

test('a malformed team id is a 400, not a database error', async () => {
  const { handlers } = mount();
  const r = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: 'not-a-uuid' } });
  assert.equal(r.status, 400);
  assert.equal(errorOf(r).extensions.code, 'INVALID_PAYLOAD');
});

// ---- GET / and GET /:id -----------------------------------------------------------------------------------

test('GET / lists every team with member count, managers and the caller\'s flags', async () => {
  const { handlers } = mount();
  const r = await call(handlers['GET /'], { acc: member(U.bob) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.teams.map((t) => t.name), ['Additive', 'Beta']);
  const additive = r.body.teams[0];
  assert.equal(additive.team_id, T.additive);
  assert.equal(additive.member_count, 2);
  assert.deepEqual(additive.managers, [{ person_id: P.ann, full_name: 'Ann Manager' }]);
  assert.equal(additive.color, 'teal');
  assert.equal(additive.description, 'Powder people');
  assert.equal(additive.logo, null);
  assert.equal(additive.is_member, true);
  assert.equal(additive.is_manager, false);
  const beta = r.body.teams[1];
  assert.equal(beta.is_member, false);
  assert.equal(beta.is_manager, false);
  const ann = await call(handlers['GET /'], { acc: member(U.ann) });
  assert.equal(ann.body.teams[0].is_manager, true);
  // a login with no person is simply a member of nothing
  const none = await call(handlers['GET /'], { acc: member(U.noperson) });
  assert.equal(none.status, 200);
  assert.ok(none.body.teams.every((t) => !t.is_member && !t.is_manager));
});

test('GET /:id returns the team, its members, counts and only the records the caller reads', async () => {
  const tables = baseTables();
  tables.directus_users.find((u) => u.id === U.bob).status = 'invited';
  const { handlers } = mount({ tables });
  const r = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.equal(r.status, 200);
  assert.equal(r.body.team.name, 'Additive');
  assert.deepEqual(r.body.members.map((m) => [m.full_name, m.is_manager, m.can_sign_in]), [['Ann Manager', true, true], ['Bob Member', false, true]]);
  assert.equal(r.body.members[1].joined_at, '2026-10-03T00:00:00.000Z');
  assert.deepEqual(r.body.counts, { view: 2, edit: 1, investigator: 1, owns: 0 }); // counted over every grant, readable or not
  // Ann reads SM-001 and SM-003; SM-002 (edit) and the project are hidden
  assert.deepEqual(r.body.records.map((x) => [x.collection, x.id, x.kind, x.code, x.title, x.role]), [
    ['physical_samples', S.one, 'sample', 'SM-001', 'Bar A', 'view'],
    ['physical_samples', S.three, 'sample', 'SM-003', 'Disc', 'view'],
  ]);
  assert.equal(r.body.hidden_count, 2);
  assert.deepEqual(r.body.events, []);
});

test('GET /:id: a member with no person in the team still sees counts, members and an empty list; an administrator sees every record', async () => {
  const { handlers } = mount();
  const stranger = await call(handlers['GET /:id'], { acc: member(U.stranger), params: { id: T.additive } });
  assert.equal(stranger.status, 200);
  assert.deepEqual(stranger.body.records, []);
  assert.equal(stranger.body.hidden_count, 4);
  assert.deepEqual(stranger.body.counts, { view: 2, edit: 1, investigator: 1, owns: 0 });
  const adm = await call(handlers['GET /:id'], { acc: admin(U.admin), params: { id: T.additive } });
  assert.equal(adm.body.records.length, 4);
  assert.equal(adm.body.hidden_count, 0);
  assert.ok(adm.body.records.some((x) => x.kind === 'project' && x.code === 'PRJ1' && x.role === 'investigator'));
});

test('GET /:id answers 404 for a team that does not exist', async () => {
  const { handlers } = mount();
  const r = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: ID(999) } });
  assert.equal(r.status, 404);
  assert.equal(errorOf(r).extensions.code, 'NOT_FOUND');
});

test('GET /:id: the history is the last 20 newest first, ?events=all gives every one; sharing events name only readable records', async () => {
  const tables = baseTables();
  for (let i = 1; i <= 25; i += 1) tables.team_events.push({ event_id: i, team_id: T.additive, at: `2026-10-01T00:${String(i).padStart(2, '0')}:00Z`, actor_person_id: P.ann, kind: 'member_added', person_id: P.bob, collection: null, record_id: null, detail: { is_manager: false } });
  tables.team_events.push({ event_id: 26, team_id: T.additive, at: '2026-10-02T00:00:00Z', actor_person_id: P.eve, kind: 'shared', person_id: null, collection: 'physical_samples', record_id: S.one, detail: { level: 'view' } });
  tables.team_events.push({ event_id: 27, team_id: T.additive, at: '2026-10-02T01:00:00Z', actor_person_id: P.fay, kind: 'shared', person_id: null, collection: 'physical_samples', record_id: S.two, detail: { level: 'edit' } });
  tables.team_events.push({ event_id: 28, team_id: T.beta, at: '2026-10-02T02:00:00Z', actor_person_id: P.fay, kind: 'created', person_id: null, collection: null, record_id: null, detail: { name: 'Beta' } });
  const { handlers } = mount({ tables });
  const r = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.equal(r.body.events.length, 20);
  assert.deepEqual(r.body.events.slice(0, 2).map((e) => e.event_id), [27, 26]);
  assert.equal(r.body.events[19].event_id, 8);
  const shared = r.body.events[1];
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.actor_name, 'Eve Owner');
  assert.equal(shared.record_code, 'SM-001'); // Ann reads SM-001
  assert.equal(shared.collection, 'physical_samples');
  const hidden = r.body.events[0]; // Ann does not read SM-002
  assert.equal(hidden.record_id, null);
  assert.equal(hidden.record_code, null);
  assert.equal(hidden.collection, null);
  assert.equal(hidden.record_hidden, true);
  const added = r.body.events[2];
  assert.equal(added.person_name, 'Bob Member');
  assert.deepEqual(added.detail, { is_manager: false });
  const all = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: T.additive }, query: { events: 'all' } });
  assert.equal(all.body.events.length, 27); // the other team's event is not in it
});

test('GET /:id: an event about a record the caller cannot read drops the person and the detail, keeping kind, time and actor', async () => {
  const tables = baseTables();
  tables.team_events.push(
    { event_id: 1, team_id: T.additive, at: '2026-10-02T00:00:00Z', actor_person_id: P.fay, kind: 'approved', person_id: P.cy, collection: 'physical_samples', record_id: S.two, detail: { level: 'edit', note: 'secret' } },
    { event_id: 2, team_id: T.additive, at: '2026-10-02T01:00:00Z', actor_person_id: P.eve, kind: 'approved', person_id: P.cy, collection: 'physical_samples', record_id: S.one, detail: { level: 'view' } },
  );
  const { handlers } = mount({ tables });
  const ann = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: T.additive } });
  const [readable, hidden] = ann.body.events; // newest first: SM-001 (Ann reads it), then SM-002 (she does not)
  assert.equal(readable.person_name, 'Cy Nologin');
  assert.deepEqual(readable.detail, { level: 'view' });
  assert.equal(hidden.record_hidden, true);
  assert.equal(hidden.kind, 'approved');
  assert.equal(hidden.at, '2026-10-02T00:00:00.000Z');
  assert.equal(hidden.actor_person_id, P.fay);
  assert.equal(hidden.actor_name, 'Fay Owner');
  assert.equal(hidden.person_id, null);
  assert.equal(hidden.person_name, null);
  assert.equal(hidden.detail, null);
  assert.doesNotMatch(JSON.stringify(hidden), /Cy Nologin|secret|SM-002/);
  // an administrator reads every record, so nothing is dropped
  const adm = await call(handlers['GET /:id'], { acc: admin(U.admin), params: { id: T.additive } });
  assert.equal(adm.body.events[1].person_name, 'Cy Nologin');
  assert.equal(adm.body.events[1].record_hidden, false);
  assert.deepEqual(adm.body.events[1].detail, { level: 'edit', note: 'secret' });
});

// ---- POST / -----------------------------------------------------------------------------------------------

test('POST / creates a team and makes the caller its manager in one transaction', async () => {
  const { handlers, tables, db, cleared } = mount({ env: { CACHE_ENABLED: 'true' } });
  const r = await call(handlers['POST /'], { acc: member(U.bob), body: { name: '  Ceramics  ', description: 'Kilns', color: 'violet' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Ceramics');
  assert.equal(r.body.color, 'violet');
  assert.equal(r.body.description, 'Kilns');
  assert.equal(r.body.member_count, 1);
  assert.deepEqual(r.body.managers, [{ person_id: P.bob, full_name: 'Bob Member' }]);
  assert.equal(r.body.is_manager, true);
  const team = tables.teams.find((t) => t.name === 'Ceramics');
  assert.equal(team.created_by_person_id, P.bob);
  assert.deepEqual(tables.team_members.filter((m) => m.team_id === team.team_id).map((m) => [m.person_id, m.is_manager]), [[P.bob, true]]);
  // the actor is set first, and the cache is cleared after the commit
  assert.match(db.log.tx[0].raw[0].sql, /set_config\('d1\.actor_identity'/);
  assert.deepEqual(db.log.tx[0].raw[0].bindings, [U.bob]);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].committed, true);
});

test('POST /: a failure reading the team back after the commit is logged and answers the known team, never a 500', async () => {
  const { handlers, tables, errors } = mount({ breakAfterCommit: ['team_members'] });
  const r = await call(handlers['POST /'], { acc: member(U.bob), body: { name: 'Ceramics', description: 'Kilns', color: 'violet' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Ceramics');
  assert.equal(r.body.color, 'violet');
  assert.equal(r.body.description, 'Kilns');
  assert.equal(r.body.member_count, 1);
  assert.deepEqual(r.body.managers, [{ person_id: P.bob, full_name: 'Bob Member' }]);
  assert.equal(r.body.is_manager, true);
  assert.equal(r.body.team_id, tables.teams.find((t) => t.name === 'Ceramics').team_id);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /committed but reading it back failed/);
});

test('POST / defaults the colour to teal and an absent description to null', async () => {
  const { handlers } = mount();
  const r = await call(handlers['POST /'], { acc: member(U.bob), body: { name: 'Plain' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.color, 'teal');
  assert.equal(r.body.description, null);
});

test('POST / refuses a name already taken, ignoring case and blanks: 409 TEAM_NAME_TAKEN', async () => {
  const { handlers, tables } = mount();
  const r = await call(handlers['POST /'], { acc: member(U.bob), body: { name: '  ADDITIVE ' } });
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'TEAM_NAME_TAKEN');
  assert.equal(tables.teams.length, 2);
});

test('POST / answers 409 NO_PERSON for a login with no person, and 400 for a bad body', async () => {
  const { handlers } = mount();
  const none = await call(handlers['POST /'], { acc: member(U.noperson), body: { name: 'Orphans' } });
  assert.equal(none.status, 409);
  assert.equal(errorOf(none).extensions.code, 'NO_PERSON');
  const adminNone = await call(handlers['POST /'], { acc: admin(U.admin), body: { name: 'Orphans' } });
  assert.equal(adminNone.status, 409); // an administrator with no person cannot manage a team either
  for (const body of [undefined, {}, { name: '   ' }, { name: 5 }, { name: 'X', color: 'magenta' }, { name: 'X', description: 7 }]) {
    const r = await call(handlers['POST /'], { acc: member(U.bob), body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(errorOf(r).extensions.code, 'INVALID_PAYLOAD');
  }
});

// ---- PATCH /:id -------------------------------------------------------------------------------------------

test('PATCH /:id: a manager edits name, description and colour', async () => {
  const { handlers, tables } = mount();
  const r = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body: { name: 'Additive Mfg', description: '', color: 'amber' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Additive Mfg');
  assert.equal(r.body.color, 'amber');
  assert.equal(r.body.description, null);
  assert.equal(tables.teams[0].name, 'Additive Mfg');
});

test('PATCH /:id: a failure reading the team back after the commit is logged and answers what is known, never a 500', async () => {
  const { handlers, tables, errors } = mount({ breakAfterCommit: ['team_members'] });
  const r = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body: { name: 'Renamed', color: 'pink' } });
  assert.equal(r.status, 200);
  assert.equal(tables.teams.find((t) => t.team_id === T.additive).name, 'Renamed');
  assert.equal(r.body.team_id, T.additive);
  assert.equal(r.body.name, 'Renamed');
  assert.equal(r.body.color, 'pink');
  assert.equal(r.body.description, 'Powder people');
  assert.equal(errors.length, 1);
});

test('PATCH /:id: a non-manager (a plain member, or a stranger) is refused 403; an administrator may', async () => {
  const { handlers, tables } = mount();
  for (const user of [U.bob, U.stranger, U.noperson]) {
    const r = await call(handlers['PATCH /:id'], { acc: member(user), params: { id: T.additive }, body: { name: 'Hijacked' } });
    assert.equal(r.status, 403, String(user));
    assert.equal(errorOf(r).extensions.code, 'FORBIDDEN');
  }
  assert.equal(tables.teams[0].name, 'Additive');
  const adm = await call(handlers['PATCH /:id'], { acc: admin(U.admin), params: { id: T.additive }, body: { name: 'By Admin' } });
  assert.equal(adm.status, 200);
  assert.equal(tables.teams[0].name, 'By Admin');
});

test('PATCH /:id: renaming onto another team\'s name is 409 TEAM_NAME_TAKEN; renaming to its own name in another case is fine', async () => {
  const { handlers, tables } = mount();
  const clash = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body: { name: ' beta' } });
  assert.equal(clash.status, 409);
  assert.equal(errorOf(clash).extensions.code, 'TEAM_NAME_TAKEN');
  const own = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body: { name: 'ADDITIVE' } });
  assert.equal(own.status, 200);
  assert.equal(tables.teams[0].name, 'ADDITIVE');
});

test('PATCH /:id: a logo must be a png, jpeg or svg of at most 1 MB (else 400 BAD_LOGO); null clears it', async () => {
  const { handlers, tables } = mount();
  const patch = (body) => call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body });
  for (const [label, logo] of [['a pdf', FILE.pdf], ['over 1 MB', FILE.big], ['no size', FILE.huge], ['a missing file', ID(999)], ['not an id', 'nope']]) {
    const r = await patch({ logo });
    assert.equal(r.status, 400, label);
    assert.equal(errorOf(r).extensions.code, 'BAD_LOGO', label);
  }
  assert.equal(tables.teams[0].logo, null);
  const png = await patch({ logo: FILE.png });
  assert.equal(png.status, 200);
  assert.equal(png.body.logo, FILE.png);
  const svg = await patch({ logo: FILE.svg }); // exactly 1 MB passes
  assert.equal(svg.status, 200);
  assert.equal(tables.teams[0].logo, FILE.svg);
  const cleared = await patch({ logo: null });
  assert.equal(cleared.status, 200);
  assert.equal(tables.teams[0].logo, null);
});

test('PATCH /:id: an empty body, a bad colour or a blank name is 400; an unknown team is 404', async () => {
  const { handlers } = mount();
  for (const body of [{}, undefined, { color: 'magenta' }, { name: ' ' }, { description: 3 }]) {
    const r = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const missing = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: ID(999) }, body: { name: 'X' } });
  assert.equal(missing.status, 404);
});

// ---- DELETE /:id ------------------------------------------------------------------------------------------

test('DELETE /:id removes the team and mails each affected record\'s owner once, listing the records', async () => {
  const { handlers, tables, mails, cleared } = mount({ env: { CACHE_ENABLED: 'true' } });
  const r = await call(handlers['DELETE /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.equal(r.status, 200);
  assert.equal(tables.teams.some((t) => t.team_id === T.additive), false);
  assert.equal(tables.team_members.some((m) => m.team_id === T.additive), false);
  assert.equal(tables.sample_team_access.length, 0);
  // Eve owns SM-001 and the project (one mail), Fay SM-002 (one mail); Ann owns SM-003 but she deleted the team herself
  assert.deepEqual(mails.map((m) => m.to).sort(), ['eve@login.example', 'fay@login.example']);
  const eve = mails.find((m) => m.to === 'eve@login.example');
  assert.match(eve.subject, /Additive was deleted/);
  assert.match(eve.text, /Additive was deleted; it no longer has access to/);
  assert.match(eve.text, /sample SM-001/i);
  assert.match(eve.text, /project PRJ1/i);
  assert.doesNotMatch(eve.text, /SM-002/);
  assert.equal(eve.committed, true);
  assert.equal(cleared.length, 1);
  assert.equal(r.body.deleted, true);
});

test('DELETE /:id: a non-manager is refused; an administrator may; the team stays after a refusal', async () => {
  const { handlers, tables, mails } = mount();
  const refused = await call(handlers['DELETE /:id'], { acc: member(U.bob), params: { id: T.additive } });
  assert.equal(refused.status, 403);
  assert.equal(tables.teams.length, 2);
  assert.equal(mails.length, 0);
  const adm = await call(handlers['DELETE /:id'], { acc: admin(U.admin), params: { id: T.additive } });
  assert.equal(adm.status, 200);
  assert.equal(tables.teams.length, 1);
  assert.equal(mails.length, 3); // an administrator is not an owner: Eve, Fay and Ann are all told
  assert.equal((await call(handlers['DELETE /:id'], { acc: admin(U.admin), params: { id: T.additive } })).status, 404);
});

test('DELETE /:id: a mail failure never undoes the delete', async () => {
  const { handlers, tables, warnings } = mount({ mailFail: true });
  const r = await call(handlers['DELETE /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.equal(r.status, 200);
  assert.equal(tables.teams.some((t) => t.team_id === T.additive), false);
  assert.ok(warnings.length >= 1);
});

test('DELETE /:id: a failure after the commit (reading the owners for the mail) is logged and answers 200 deleted', async () => {
  const { handlers, tables, mails, errors } = mount({ breakAfterCommit: ['people'] });
  const r = await call(handlers['DELETE /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { deleted: true, owners_mailed: 0 });
  assert.equal(tables.teams.some((t) => t.team_id === T.additive), false);
  assert.equal(mails.length, 0);
  assert.equal(errors.length, 1);
});

test('DELETE /:id: HTML in the team name is escaped in the mail', async () => {
  const tables = baseTables();
  tables.teams[0].name = '<b>Additive</b>';
  const { handlers, mails } = mount({ tables });
  await call(handlers['DELETE /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.ok(mails.length > 0);
  for (const m of mails) {
    assert.doesNotMatch(m.html, /<b>Additive<\/b>/);
    assert.match(m.html, /&lt;b&gt;Additive&lt;\/b&gt;/);
  }
});

// ---- members ----------------------------------------------------------------------------------------------

test('POST /:id/members adds the person, answers the pending counts and mails each owner once, listing their records', async () => {
  const { handlers, tables, mails, cleared, db } = mount({ env: { CACHE_ENABLED: 'true' } });
  const r = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { pending: 4, owners_asked: 2, owned_edit: 0 }); // no record is owned by Additive
  assert.deepEqual(tables.team_members.filter((m) => m.person_id === P.gus).map((m) => [m.team_id, m.is_manager]), [[T.additive, false]]);
  assert.match(db.log.tx[0].raw[0].sql, /set_config\('d1\.actor_identity'/);
  // Eve owns SM-001 and the project: one mail with both; Fay owns SM-002; Ann (the adder) owns SM-003 and is not mailed
  assert.deepEqual(mails.map((m) => m.to).sort(), ['eve@login.example', 'fay@login.example']);
  const eve = mails.find((m) => m.to === 'eve@login.example');
  assert.match(eve.subject, /Gus Newcomer/);
  assert.match(eve.text, /sample SM-001/i);
  assert.match(eve.text, /project PRJ1/i);
  assert.doesNotMatch(eve.text, /SM-002|SM-003/);
  assert.equal(eve.committed, true);
  assert.equal(cleared.length, 1);
});

test('POST /:id/members: a pending row that is not worth asking about (Ruling D2) is neither counted nor mailed', async () => {
  const { handlers, mails } = mount({ notActionable: [['physical_samples', GRANT.s1, P.gus], ['projects', GRANT.pr, P.gus]] });
  const r = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.deepEqual(r.body, { pending: 2, owners_asked: 1, owned_edit: 0 });
  assert.deepEqual(mails.map((m) => m.to), ['fay@login.example']);
});

test('POST /:id/members: a team with no grants answers zeros; an owner with no login is mailed at their People address', async () => {
  const quiet = mount();
  const r = await call(quiet.handlers['POST /:id/members'], { acc: member(U.fay), params: { id: T.beta }, body: { person_id: P.cy } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { pending: 0, owners_asked: 0, owned_edit: 0 });
  assert.equal(quiet.mails.length, 0);
  const tables = baseTables();
  tables.physical_samples[0].owner_person_id = P.cy; // Cy has no login
  const { handlers, mails } = mount({ tables });
  await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.ok(mails.some((m) => m.to === 'cy@people.example'));
});

test('POST /:id/members: a failure after the commit (reading the owners for the mail) is logged and answers 201; no mail', async () => {
  const { handlers, tables, mails, errors } = mount({ breakAfterCommit: ['people'] });
  const r = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { pending: 4, owners_asked: 2, owned_edit: 0 }); // no record is owned by Additive
  assert.equal(tables.team_members.some((m) => m.person_id === P.gus), true);
  assert.equal(mails.length, 0);
  assert.equal(errors.length, 1);
});

test('POST /:id/members: is_manager adds a manager', async () => {
  const { handlers, tables } = mount();
  await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.beta }, body: { person_id: P.gus, is_manager: true } });
  // Ann is not a manager of Beta
  assert.equal(tables.team_members.some((m) => m.person_id === P.gus), false);
  const ok = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus, is_manager: true } });
  assert.equal(ok.status, 201);
  assert.equal(tables.team_members.find((m) => m.person_id === P.gus).is_manager, true);
});

test('POST /:id/members: 403 for a non-manager, 400 for a bad body, 404 for an unknown person, 409 for someone already in', async () => {
  const { handlers, tables } = mount();
  const refused = await call(handlers['POST /:id/members'], { acc: member(U.bob), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.equal(refused.status, 403);
  assert.equal(errorOf(refused).extensions.code, 'FORBIDDEN');
  for (const body of [undefined, {}, { person_id: 'nope' }, { person_id: P.gus, is_manager: 'yes' }]) {
    const r = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const unknown = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: ID(998) } });
  assert.equal(unknown.status, 404);
  const dup = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.bob } });
  assert.equal(dup.status, 409);
  assert.equal(errorOf(dup).extensions.code, 'ALREADY_MEMBER');
  assert.equal(tables.team_members.length, 3);
  const noTeam = await call(handlers['POST /:id/members'], { acc: admin(U.admin), params: { id: ID(999) }, body: { person_id: P.gus } });
  assert.equal(noTeam.status, 404);
});

test('POST /:id/members: a mail failure never undoes the add', async () => {
  const { handlers, tables } = mount({ mailFail: true });
  const r = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { pending: 4, owners_asked: 2, owned_edit: 0 }); // no record is owned by Additive
  assert.equal(tables.team_members.some((m) => m.person_id === P.gus), true);
});

test('PATCH /:id/members/:person_id sets and clears the manager flag', async () => {
  const { handlers, tables } = mount();
  const up = await call(handlers['PATCH /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.bob }, body: { is_manager: true } });
  assert.equal(up.status, 200);
  assert.equal(up.body.is_manager, true);
  assert.equal(tables.team_members.find((m) => m.person_id === P.bob).is_manager, true);
  const down = await call(handlers['PATCH /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.ann }, body: { is_manager: false } });
  assert.equal(down.status, 200); // Bob is a manager now, so Ann may step down
  assert.equal(tables.team_members.find((m) => m.person_id === P.ann).is_manager, false);
});

test('PATCH /:id/members/:person_id: the last manager cannot be demoted: 409 LAST_MANAGER from the commit, and nothing changes', async () => {
  const { handlers, tables, cleared } = mount({ env: { CACHE_ENABLED: 'true' } });
  const r = await call(handlers['PATCH /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.ann }, body: { is_manager: false } });
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'LAST_MANAGER');
  assert.equal(errorOf(r).message, 'Make someone else a manager first');
  assert.equal(tables.team_members.find((m) => m.person_id === P.ann).is_manager, true);
  assert.equal(cleared.length, 0); // nothing committed, nothing to clear
});

test('PATCH /:id/members/:person_id: 403 for a non-manager, 400 for a bad body, 404 for a non-member', async () => {
  const { handlers } = mount();
  const refused = await call(handlers['PATCH /:id/members/:person_id'], { acc: member(U.bob), params: { id: T.additive, person_id: P.bob }, body: { is_manager: true } });
  assert.equal(refused.status, 403);
  const bad = await call(handlers['PATCH /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.bob }, body: { is_manager: 'yes' } });
  assert.equal(bad.status, 400);
  const gone = await call(handlers['PATCH /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.gus }, body: { is_manager: true } });
  assert.equal(gone.status, 404);
});

test('DELETE /:id/members/:person_id: a manager removes a member, a member leaves, an administrator removes anyone', async () => {
  const { handlers, tables } = mount();
  const self = await call(handlers['DELETE /:id/members/:person_id'], { acc: member(U.bob), params: { id: T.additive, person_id: P.bob } });
  assert.equal(self.status, 200);
  assert.equal(tables.team_members.some((m) => m.person_id === P.bob), false);
  // Bob's pending rows would go with him (the trigger); here: Cy's stay
  const again = await call(handlers['DELETE /:id/members/:person_id'], { acc: member(U.bob), params: { id: T.additive, person_id: P.bob } });
  assert.equal(again.status, 404);

  const second = mount();
  await call(second.handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  const byManager = await call(second.handlers['DELETE /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.gus } });
  assert.equal(byManager.status, 200);
  assert.equal(second.tables.sample_team_pending.some((p) => p.person_id === P.gus), false);
  const byAdmin = await call(second.handlers['DELETE /:id/members/:person_id'], { acc: admin(U.admin), params: { id: T.additive, person_id: P.bob } });
  assert.equal(byAdmin.status, 200);
});

test('DELETE /:id/members/:person_id: 403 when neither a manager, an administrator nor the person themself', async () => {
  const { handlers, tables } = mount();
  for (const user of [U.bob, U.stranger]) {
    const r = await call(handlers['DELETE /:id/members/:person_id'], { acc: member(user), params: { id: T.additive, person_id: P.ann } });
    assert.equal(r.status, 403, String(user));
  }
  assert.equal(tables.team_members.length, 3);
});

test('DELETE /:id/members/:person_id: the last manager cannot leave while others remain (409 LAST_MANAGER); the last member can', async () => {
  const { handlers, tables } = mount();
  const blocked = await call(handlers['DELETE /:id/members/:person_id'], { acc: member(U.ann), params: { id: T.additive, person_id: P.ann } });
  assert.equal(blocked.status, 409);
  assert.equal(errorOf(blocked).extensions.code, 'LAST_MANAGER');
  assert.equal(errorOf(blocked).message, 'Make someone else a manager first');
  assert.equal(tables.team_members.some((m) => m.person_id === P.ann), true);
  // Fay is the only member of Beta: leaving empties the team, which is allowed
  const last = await call(handlers['DELETE /:id/members/:person_id'], { acc: member(U.fay), params: { id: T.beta, person_id: P.fay } });
  assert.equal(last.status, 200);
  assert.equal(tables.team_members.some((m) => m.team_id === T.beta), false);
});

test('a check violation that is not the manager rule is not reported as LAST_MANAGER', async () => {
  const tables = baseTables();
  const { handlers, db, errors } = mount({ tables });
  const real = db.transaction;
  db.transaction = async (work) => real(async (trx) => { await work(trx); throw Object.assign(new Error('teams_color_check'), { code: '23514', constraint: 'teams_color_check' }); });
  const r = await call(handlers['PATCH /:id'], { acc: member(U.ann), params: { id: T.additive }, body: { color: 'red' } });
  assert.equal(r.status, 500);
  assert.equal(errorOf(r).extensions.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(errors.length, 1);
});

// ---- /pending ---------------------------------------------------------------------------------------------

const keyed = (records) => records.map((x) => `${x.kind}:${x.code}:${x.role}`).sort();

test('GET /pending lists only actionable rows on records the caller owns, grouped by joiner and team', async () => {
  const { handlers } = mount();
  const eve = await call(handlers['GET /pending'], { acc: member(U.eve) });
  assert.equal(eve.status, 200);
  assert.equal(eve.body.items.length, 1);
  const item = eve.body.items[0];
  assert.deepEqual([item.team_id, item.team_name, item.person_id, item.full_name], [T.additive, 'Additive', P.cy, 'Cy Nologin']);
  assert.deepEqual(keyed(item.records), ['project:PRJ1:investigator', 'sample:SM-001:view']); // SM-002 is Fay's
  assert.deepEqual(item.records.find((x) => x.kind === 'sample'), { collection: 'physical_samples', id: S.one, kind: 'sample', code: 'SM-001', title: 'Bar A', role: 'view' });
  const fay = await call(handlers['GET /pending'], { acc: member(U.fay) });
  assert.deepEqual(keyed(fay.body.items[0].records), ['sample:SM-002:edit']);
  // Ann owns SM-003, but Cy's row there is declined; Bob and a stranger own nothing
  for (const user of [U.ann, U.bob, U.stranger, U.noperson]) {
    assert.deepEqual((await call(handlers['GET /pending'], { acc: member(user) })).body, { items: [] }, String(user));
  }
});

test('GET /pending: an administrator sees only the records they own, like anyone; one that is not worth asking about (D2) is left out', async () => {
  const none = mount();
  assert.deepEqual((await call(none.handlers['GET /pending'], { acc: admin(U.admin) })).body, { items: [] }); // no person at all
  const tables = baseTables();
  tables.people.push({ person_id: P.adm, full_name: 'Ada Admin', email: 'ada@people.example', user_id: U.admin });
  tables.physical_samples[1].owner_person_id = P.adm; // SM-002, edit grant, Cy pending
  tables.physical_samples[2].owner_person_id = P.adm; // SM-003: Cy's row is declined
  const { handlers } = mount({ tables });
  const r = await call(handlers['GET /pending'], { acc: admin(U.admin) });
  assert.equal(r.body.items.length, 1);
  assert.deepEqual(keyed(r.body.items[0].records), ['sample:SM-002:edit']); // not Eve's SM-001 or the project
  const dropped = mount({ tables, notActionable: [['physical_samples', GRANT.s2, P.cy]] });
  assert.deepEqual((await call(dropped.handlers['GET /pending'], { acc: admin(U.admin) })).body, { items: [] });
});

test('GET /pending: two joiners or two teams make separate items', async () => {
  const tables = baseTables();
  tables.sample_team_pending.push({ team_access_id: GRANT.s1, person_id: P.gus, state: 'pending' });
  const { handlers } = mount({ tables });
  const r = await call(handlers['GET /pending'], { acc: member(U.eve) });
  assert.deepEqual(r.body.items.map((i) => i.full_name).sort(), ['Cy Nologin', 'Gus Newcomer']);
});

// ---- POST /pending/decide ---------------------------------------------------------------------------------

const decide = (handlers, user, body, acc = member(user)) => call(handlers['POST /pending/decide'], { acc, body });

test('decide approve: approves every record the caller manages for that joiner and team, and mails the joiner once', async () => {
  const { handlers, decided, tables, mails, cleared, db } = mount({ env: { CACHE_ENABLED: 'true' } });
  const r = await decide(handlers, U.eve, { team_id: T.additive, person_id: P.cy, decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.body.decided, 2);
  assert.deepEqual(decided.map((d) => [d.collection, d.team_access_id, d.person_id, d.decision]).sort(), [
    ['physical_samples', GRANT.s1, P.cy, 'approve'],
    ['projects', GRANT.pr, P.cy, 'approve'],
  ]);
  // Fay's SM-002 row was not Eve's to decide
  assert.equal(tables.sample_team_pending.some((p) => p.team_access_id === GRANT.s2 && p.state === 'pending'), true);
  assert.match(db.log.tx[0].raw[0].sql, /set_config\('d1\.actor_identity'/);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'cy@people.example'); // no login: the People address
  assert.match(mails[0].text, /Additive/);
  assert.match(mails[0].text, /SM-001/);
  assert.match(mails[0].text, /PRJ1/);
  assert.doesNotMatch(mails[0].text, /SM-002/);
  assert.equal(mails[0].committed, true);
  assert.equal(cleared.length, 1);
});

test('decide decline: declines without mailing anyone', async () => {
  const { handlers, decided, mails } = mount();
  const r = await decide(handlers, U.fay, { team_id: T.additive, person_id: P.cy, decision: 'decline' });
  assert.equal(r.status, 200);
  assert.equal(r.body.decided, 1);
  assert.deepEqual(decided.map((d) => [d.collection, d.decision]), [['physical_samples', 'decline']]);
  assert.equal(mails.length, 0);
});

test('decide with records: only those, and each must be one the caller manages (403 otherwise, nothing applied)', async () => {
  const { handlers, decided } = mount();
  const only = await decide(handlers, U.eve, { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: S.one }] });
  assert.equal(only.status, 200);
  assert.equal(only.body.decided, 1);
  assert.deepEqual(decided.map((d) => d.team_access_id), [GRANT.s1]);

  const other = mount();
  // SM-001 is Eve's, SM-002 is Fay's: Eve may not decide SM-002, so nothing at all is applied
  const r = await decide(other.handlers, U.eve, {
    team_id: T.additive, person_id: P.cy, decision: 'approve',
    records: [{ collection: 'physical_samples', id: S.one }, { collection: 'physical_samples', id: S.two }],
  });
  assert.equal(r.status, 403);
  assert.equal(errorOf(r).extensions.code, 'FORBIDDEN');
  assert.deepEqual(other.decided, []);
  assert.equal(other.mails.length, 0);
  assert.equal(other.tables.sample_team_pending.some((p) => p.team_access_id === GRANT.s1 && p.person_id === P.cy && p.state === 'pending'), true);
  assert.equal(other.tables.sample_access.length, 0);
});

test('decide without records: an administrator acts only on records they own (403 when the queue holds none of theirs)', async () => {
  const tables = baseTables();
  tables.people.push({ person_id: P.adm, full_name: 'Ada Admin', email: 'ada@people.example', user_id: U.admin });
  tables.physical_samples[1].owner_person_id = P.adm;
  const mine = mount({ tables });
  const r = await decide(mine.handlers, U.admin, { team_id: T.additive, person_id: P.cy, decision: 'approve' }, admin(U.admin));
  assert.equal(r.status, 200);
  assert.equal(r.body.decided, 1);
  assert.deepEqual(mine.decided.map((d) => d.team_access_id), [GRANT.s2]); // Eve's SM-001 and the project are left alone
  const none = mount();
  const refused = await decide(none.handlers, U.admin, { team_id: T.additive, person_id: P.cy, decision: 'approve' }, admin(U.admin));
  assert.equal(refused.status, 403);
  assert.deepEqual(none.decided, []);
});

test('decide with records: an administrator decides any single record; a stranger with nothing of their own is 403', async () => {
  const adm = mount();
  const r = await decide(adm.handlers, U.admin, { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: S.two }] }, admin(U.admin));
  assert.equal(r.status, 200);
  assert.equal(adm.decided.length, 1);
  const stranger = mount();
  const refused = await decide(stranger.handlers, U.stranger, { team_id: T.additive, person_id: P.cy, decision: 'approve' });
  assert.equal(refused.status, 403);
  const refusedRecord = await decide(stranger.handlers, U.stranger, { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: S.one }] });
  assert.equal(refusedRecord.status, 403);
  assert.deepEqual(stranger.decided, []);
});

test('decide: nothing waiting is 200 with decided 0; a record that is not waiting is 409; bad input is 400; an unknown record 404', async () => {
  const { handlers, decided } = mount();
  const none = await decide(handlers, U.eve, { team_id: T.beta, person_id: P.cy, decision: 'approve' });
  assert.equal(none.status, 200);
  assert.equal(none.body.decided, 0);
  const notWaiting = await decide(handlers, U.ann, { team_id: T.additive, person_id: P.bob, decision: 'approve', records: [{ collection: 'physical_samples', id: S.three }] });
  assert.equal(notWaiting.status, 409);
  assert.equal(errorOf(notWaiting).extensions.code, 'NOTHING_TO_DECIDE');
  const missing = await decide(handlers, U.admin, { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: ID(997) }] }, admin(U.admin));
  assert.equal(missing.status, 404);
  for (const body of [
    undefined, {}, { team_id: T.additive, person_id: P.cy, decision: 'maybe' }, { team_id: 'x', person_id: P.cy, decision: 'approve' },
    { team_id: T.additive, person_id: P.cy, decision: 'approve', records: 'all' },
    { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'people', id: S.one }] },
    { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'constructor', id: S.one }] },
    { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: 'x' }] },
  ]) {
    const r = await decide(handlers, U.eve, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(decided, []);
});

test('decide: approving a declined row works (the owner changed their mind); the database\'s "nothing to decide" is a 409', async () => {
  const { handlers, decided } = mount();
  const r = await decide(handlers, U.ann, { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: S.three }] });
  assert.equal(r.status, 200);
  assert.deepEqual(decided.map((d) => d.team_access_id), [GRANT.s3]);
  const failing = mount({ decideFail: Object.assign(new Error('Nothing to decide'), { code: 'P0002' }) });
  const f = await decide(failing.handlers, U.eve, { team_id: T.additive, person_id: P.cy, decision: 'approve' });
  assert.equal(f.status, 409);
  assert.equal(errorOf(f).extensions.code, 'NOTHING_TO_DECIDE');
});

test('decide: a failure after the commit (reading the team and joiner for the mail) is logged and answers 200 with what was decided', async () => {
  const { handlers, decided, mails, errors } = mount({ breakAfterCommit: ['teams'] });
  const r = await decide(handlers, U.eve, { team_id: T.additive, person_id: P.cy, decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.body.decided, 2);
  assert.equal(decided.length, 2);
  assert.equal(mails.length, 0);
  assert.equal(errors.length, 1);
});

test('decide: the same record listed twice is decided once', async () => {
  const { handlers, decided } = mount();
  const r = await decide(handlers, U.eve, {
    team_id: T.additive, person_id: P.cy, decision: 'approve',
    records: [{ collection: 'physical_samples', id: S.one }, { collection: 'physical_samples', id: S.one.toUpperCase() }, { collection: 'projects', id: PROJECT }, { collection: 'physical_samples', id: S.one }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.decided, 2);
  assert.deepEqual(r.body.records, [{ collection: 'physical_samples', id: S.one }, { collection: 'projects', id: PROJECT }]);
  assert.deepEqual(decided.map((d) => d.team_access_id), [GRANT.s1, GRANT.pr]); // team_decide ran once per record, no second NOTHING_TO_DECIDE
});

test('decide: a mail failure never undoes the approval', async () => {
  const { handlers, decided, warnings } = mount({ mailFail: true });
  const r = await decide(handlers, U.eve, { team_id: T.additive, person_id: P.cy, decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.body.decided, 2);
  assert.equal(decided.length, 2);
  assert.ok(warnings.length >= 1);
});

// ---- team ownership (migration 183, People 3 Task 3) ---------------------------------------------------------------------
// Beta (manager Fay, member Bob) owns SM-004 and SM-005. Additive has a view grant on SM-004; Cy waits on it. The owner grant (role own)
// is the database's: it is in the world so the endpoint's reads can skip it.

const S4 = ID(4);
const S5 = ID(5);
const OWN = { s4: ID(411), s5: ID(412) };
const teamOwnedWorld = () => {
  const t = baseTables();
  t.team_members.push({ member_id: ID(604), team_id: T.beta, person_id: P.bob, is_manager: false, joined_at: '2026-10-04T00:00:00Z' });
  t.physical_samples.push(
    { sample_id: S4, sample_code: 'SM-004', nickname: 'Team bar', owner_person_id: null, owner_team_id: T.beta },
    { sample_id: S5, sample_code: 'SM-005', nickname: null, owner_person_id: null, owner_team_id: T.beta },
  );
  t.sample_readers.push({ record_id: S4, user_id: U.fay }, { record_id: S5, user_id: U.fay }, { record_id: S4, user_id: U.ann });
  t.sample_team_access.push(
    { team_access_id: OWN.s4, sample_id: S4, team_id: T.beta, role: 'own', trust_new_members: true },
    { team_access_id: OWN.s5, sample_id: S5, team_id: T.beta, role: 'own', trust_new_members: true },
    { team_access_id: ID(413), sample_id: S4, team_id: T.additive, role: 'view', trust_new_members: false },
  );
  t.sample_team_pending.push({ team_access_id: ID(413), person_id: P.cy, state: 'pending' });
  return t;
};

test('DELETE /:id: a team that owns records is refused 409 TEAM_OWNS_RECORDS with counts per collection; nothing is deleted or mailed', async () => {
  const tables = teamOwnedWorld();
  tables.campaigns = [{ campaign_id: ID(7), campaign_code: 'CMP-1', owner_person_id: null, owner_team_id: T.beta }];
  tables.manufacturing_operations = [];
  tables.test_sessions = [];
  const { handlers, mails, cleared } = mount({ tables, env: { CACHE_ENABLED: 'true' } });
  const r = await call(handlers['DELETE /:id'], { acc: member(U.fay), params: { id: T.beta } });
  assert.equal(r.status, 409);
  const e = errorOf(r);
  assert.equal(e.extensions.code, 'TEAM_OWNS_RECORDS');
  assert.equal(e.extensions.source, 'd1-teams');
  assert.deepEqual(e.extensions.counts, { physical_samples: 2, manufacturing_operations: 0, test_sessions: 0, campaigns: 1 });
  assert.equal(e.message, 'Beta owns 2 samples and 1 campaign. Transfer ownership of them to a person or another team before deleting the team.');
  assert.ok(tables.teams.some((t) => t.team_id === T.beta), 'the team stays');
  assert.ok(tables.team_members.some((m) => m.team_id === T.beta), 'its members stay');
  assert.equal(tables.sample_team_access.filter((g) => g.team_id === T.beta).length, 2, 'its grants stay');
  assert.equal(mails.length, 0);
  assert.equal(cleared.length, 0, 'nothing changed, so no cache clear');
  // an administrator is refused the same way; the singular reads "1 sample"
  const one = teamOwnedWorld();
  one.physical_samples = one.physical_samples.filter((s) => s.sample_id !== S5);
  const adm = mount({ tables: one });
  const a = await call(adm.handlers['DELETE /:id'], { acc: admin(U.admin), params: { id: T.beta } });
  assert.deepEqual([a.status, errorOf(a).extensions.code], [409, 'TEAM_OWNS_RECORDS']);
  assert.match(errorOf(a).message, /^Beta owns 1 sample\./);
});

test('DELETE /:id: a team that only has a share on records (no owner_team_id) is deleted as before; a non-manager is refused before anything is read', async () => {
  const { handlers, tables } = mount({ tables: teamOwnedWorld() });
  assert.equal((await call(handlers['DELETE /:id'], { acc: member(U.ann), params: { id: T.additive } })).status, 200);
  assert.ok(!tables.teams.some((t) => t.team_id === T.additive));
  const plain = await call(handlers['DELETE /:id'], { acc: member(U.bob), params: { id: T.beta } });
  assert.equal(plain.status, 403, 'a plain member of the owning team cannot delete it');
});

test('DELETE /:id: the managers of an owning team are mailed (once) when a team that has a share on its record is deleted', async () => {
  const { handlers, mails } = mount({ tables: teamOwnedWorld() });
  const r = await call(handlers['DELETE /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.equal(r.status, 200);
  // Eve, Fay (SM-002 and the managers of Beta, which owns SM-004) are the owners; Ann deleted it herself
  const fay = mails.filter((m) => m.to === 'fay@login.example');
  assert.equal(fay.length, 1);
  assert.match(fay[0].text, /sample SM-002/i);
  assert.match(fay[0].text, /sample SM-004/i);
  assert.equal(mails.filter((m) => m.to === 'bob@login.example').length, 0, 'a plain member of the owning team is not an owner');
});

test('GET /:id: counts gain owns (the records the team owns), the owner grant shows as a record with role own', async () => {
  const { handlers } = mount({ tables: teamOwnedWorld() });
  const beta = await call(handlers['GET /:id'], { acc: member(U.fay), params: { id: T.beta } });
  assert.equal(beta.status, 200);
  assert.deepEqual(beta.body.counts, { view: 0, edit: 0, investigator: 0, owns: 2 });
  assert.deepEqual(beta.body.records.map((r) => [r.code, r.role]), [['SM-004', 'own'], ['SM-005', 'own']]);
  const additive = await call(handlers['GET /:id'], { acc: member(U.ann), params: { id: T.additive } });
  assert.deepEqual(additive.body.counts, { view: 3, edit: 1, investigator: 1, owns: 0 });
});

test('POST /:id/members: owned_edit is the number of records the team owns; a team that owns none answers 0', async () => {
  const { handlers } = mount({ tables: teamOwnedWorld() });
  const owning = await call(handlers['POST /:id/members'], { acc: member(U.fay), params: { id: T.beta }, body: { person_id: P.gus } });
  assert.equal(owning.status, 201);
  assert.deepEqual(owning.body, { pending: 0, owners_asked: 0, owned_edit: 2 });
  const none = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.equal(none.body.owned_edit, 0);
});

test('POST /:id/members: a joiner waiting on a record a team owns asks the owning team\'s managers (not the caller), once', async () => {
  const tables = teamOwnedWorld();
  // Gus joins Additive, which has a (not trusting) view grant on SM-004, owned by Beta
  const { handlers, mails } = mount({ tables });
  const r = await call(handlers['POST /:id/members'], { acc: member(U.ann), params: { id: T.additive }, body: { person_id: P.gus } });
  assert.equal(r.status, 201);
  const fay = mails.filter((m) => m.to === 'fay@login.example');
  assert.equal(fay.length, 1, 'one mail for all of Fay\'s records');
  assert.match(fay[0].text, /sample SM-004/i);
  assert.match(fay[0].text, /sample SM-002/i);
  assert.equal(mails.filter((m) => m.to === 'bob@login.example').length, 0, 'a plain member of Beta is not asked');
});

test('GET /pending: a manager of the owning team sees the waiting joiners on records the team owns; a plain member and the other team\'s manager do not', async () => {
  const { handlers } = mount({ tables: teamOwnedWorld() });
  const fay = await call(handlers['GET /pending'], { acc: member(U.fay) });
  assert.deepEqual(keyed(fay.body.items[0].records), ['sample:SM-002:edit', 'sample:SM-004:view'], 'her own SM-002 and the team-owned SM-004');
  assert.deepEqual(fay.body.items.map((i) => [i.team_name, i.full_name]), [['Additive', 'Cy Nologin']]);
  for (const user of [U.bob, U.ann]) {
    const body = (await call(handlers['GET /pending'], { acc: member(user) })).body;
    assert.ok(!JSON.stringify(body).includes('SM-004'), `${user} does not own SM-004`);
  }
  // demoted manager: no longer the owner
  const demoted = teamOwnedWorld();
  demoted.team_members.find((m) => m.team_id === T.beta && m.person_id === P.fay).is_manager = false;
  demoted.team_members.find((m) => m.team_id === T.beta && m.person_id === P.bob).is_manager = true;
  const after = mount({ tables: demoted });
  assert.ok(!JSON.stringify((await call(after.handlers['GET /pending'], { acc: member(U.fay) })).body).includes('SM-004'));
  assert.ok(JSON.stringify((await call(after.handlers['GET /pending'], { acc: member(U.bob) })).body).includes('SM-004'));
});

test('decide: a manager of the owning team decides the records the team owns; a plain member is refused (403, nothing applied)', async () => {
  const { handlers, decided, tables } = mount({ tables: teamOwnedWorld() });
  const plain = await call(handlers['POST /pending/decide'], { acc: member(U.bob), body: { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: S4 }] } });
  assert.deepEqual([plain.status, errorOf(plain).extensions.code], [403, 'FORBIDDEN']);
  assert.equal(decided.length, 0);
  const one = await call(handlers['POST /pending/decide'], { acc: member(U.fay), body: { team_id: T.additive, person_id: P.cy, decision: 'approve', records: [{ collection: 'physical_samples', id: S4 }] } });
  assert.equal(one.status, 200);
  assert.deepEqual(decided.map((d) => d.team_access_id), [ID(413)]);
  assert.ok(!tables.sample_team_pending.some((p) => p.team_access_id === ID(413) && p.person_id === P.cy));
  // without `records`: the whole queue of the caller, which now includes SM-002 (hers) and nothing of Eve's
  const all = await call(handlers['POST /pending/decide'], { acc: member(U.fay), body: { team_id: T.additive, person_id: P.cy, decision: 'decline' } });
  assert.deepEqual([all.status, all.body.decided], [200, 1]);
});
