// Run with: node --test core/extensions/d1-people-admin/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext, { accountAdmin, attentionCount } from './index.js';
import { COLLECTIONS } from '../d1-record-access/index.js';

// ---- ids and the world ----------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LAB_ADMIN_ROLE = '10000001-0000-0000-0000-000000000001';
const R = { lab: LAB_ADMIN_ROLE, member: ID(31), super: ID(32) };
const POLICY = { admin: ID(41), member: ID(42) };
const P = { ann: ID(101), bob: ID(102), cy: ID(103), dee: ID(104) };
const U = { ann: ID(201), bob: ID(202), labAdmin: ID(203), superAdmin: ID(204), previewAdmin: ID(205), orphan: ID(299) };
const SAMPLE = ID(1);
const SAMPLE_GONE = ID(2);
const PROJECT = ID(5);

const baseTables = () => ({
  people: [
    { person_id: P.ann, full_name: 'Ann Member', email: 'ann@people.example', is_researcher: true, is_operator: false, active: true, notes: 'hello', user_id: U.ann, created_at: new Date('2026-03-01T09:30:00Z') },
    { person_id: P.bob, full_name: 'Bob Member', email: null, is_researcher: true, is_operator: true, active: true, notes: null, user_id: U.bob },
    { person_id: P.cy, full_name: 'Cy Nologin', email: 'cy@people.example', is_researcher: false, is_operator: true, active: false, notes: null, user_id: null, created_at: '2026-05-02T00:00:00Z' },
    { person_id: P.dee, full_name: 'Dee Labadmin', email: 'dee@people.example', is_researcher: true, is_operator: false, active: true, notes: null, user_id: U.labAdmin },
  ],
  directus_users: [
    { id: U.ann, email: 'ann@login.example', first_name: 'Ann', last_name: 'Member', status: 'active', role: R.member, last_access: new Date('2026-10-13T08:00:00Z') },
    { id: U.bob, email: 'bob@login.example', first_name: 'Bob', last_name: 'Member', status: 'invited', role: R.member, last_access: null },
    { id: U.labAdmin, email: 'dee@login.example', first_name: 'Dee', last_name: 'Labadmin', status: 'active', role: R.lab, last_access: null },
    { id: U.superAdmin, email: 'super@login.example', first_name: 'Su', last_name: 'Per', status: 'active', role: R.super, last_access: null },
    { id: U.previewAdmin, email: 'preview@login.example', first_name: 'Pre', last_name: 'View', status: 'active', role: null, last_access: null },
    { id: U.orphan, email: 'orphan@login.example', first_name: 'Olga', last_name: 'Orphan', status: 'suspended', role: R.member, last_access: '2026-09-01T10:00:00Z' },
  ],
  directus_roles: [
    { id: R.member, name: 'Lab Member' },
    { id: R.lab, name: 'Lab Admin' },
    { id: R.super, name: 'Super Admin' },
  ],
  // the Lab Admin and Super Admin roles reach the admin policy; the preview admin has it on the USER (role null)
  directus_access: [
    { role: R.member, user: null, policy: POLICY.member },
    { role: R.lab, user: null, policy: POLICY.admin },
    { role: R.super, user: null, policy: POLICY.admin },
    { role: null, user: U.previewAdmin, policy: POLICY.admin },
  ],
  directus_policies: [
    { id: POLICY.admin, admin_access: true },
    { id: POLICY.member, admin_access: false },
  ],
  physical_samples: [
    { sample_id: SAMPLE, sample_code: 'SM-001', nickname: 'Bar A' },
    { sample_id: SAMPLE_GONE, sample_code: 'SM-002', nickname: null },
  ],
  projects: [{ project_id: PROJECT, project_code: 'PRJ1', project_name: 'Project One' }],
  sample_readers: [{ record_id: SAMPLE, user_id: U.ann }], // Ann reads SM-001 but no longer reads SM-002
  project_readers: [{ record_id: PROJECT, user_id: U.ann }],
});

// ---- a tiny in-memory knex plus raw() answers ----------------------------------------------------------

const same = (a, b) => String(a) === String(b);
function makeDb(tables, rawAnswers) {
  const log = { raw: [], tx: [] };
  const db = (table) => {
    const preds = [];
    const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    const project = (row, cols) => (row === undefined ? undefined : cols.length ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : { ...row });
    const q = {
      where(a, v) { preds.push((r) => same(r[a], v)); return q; },
      // whereRaw('LOWER(??) = ?', ['email', value]): the e-mail comparison the endpoint and Directus use
      // (and lower(btrim(??)) = ? on people: the same, trimmed)
      whereRaw(_sql, bindings) { const v = bindings[bindings.length - 1]; preds.push((r) => String(r.email ?? '').trim().toLowerCase() === v); return q; },
      whereNull(a) { preds.push((r) => r[a] === null || r[a] === undefined); return q; },
      insert(row) {
        const rec = { ...row };
        if (table === 'people' && !rec.person_id) rec.person_id = ID(800 + (tables.people ?? []).length);
        if (table === 'directus_users' && !rec.id) rec.id = ID(700 + (tables.directus_users ?? []).length);
        (tables[table] ??= []).push(rec);
        const done = Promise.resolve([rec]);
        done.returning = async (col) => [{ [col]: rec[col] }];
        return done;
      },
      update: async (changes) => { const hit = rows(); for (const r of hit) Object.assign(r, changes); return hit.length; },
      del: async () => { const hit = rows(); tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r)); return hit.length; },
      whereIn(c, values) { preds.push((r) => values.some((v) => same(r[c], v))); return q; },
      select: async (...cols) => rows().map((r) => project(r, cols)),
      first: async (...cols) => project(rows()[0], cols),
    };
    return q;
  };
  db.raw = async (sql, bindings) => {
    log.raw.push({ sql, bindings });
    for (const [prefix, answer] of Object.entries(rawAnswers)) {
      if (sql.startsWith(prefix)) return { rows: typeof answer === 'function' ? answer(bindings) : answer };
    }
    return { rows: [] };
  };
  // a transaction: the same tables, restored if the work throws; log.tx records each one and whether it committed
  db.transaction = async (work) => {
    const snapshot = structuredClone(tables);
    const entry = { raw: [], committed: false };
    log.tx.push(entry);
    const trx = makeDb(tables, rawAnswers);
    const trxRaw = trx.raw;
    trx.raw = async (sql, bindings) => { entry.raw.push({ sql, bindings }); return trxRaw(sql, bindings); };
    try {
      const out = await work(trx);
      entry.committed = true;
      return out;
    } catch (err) {
      for (const key of Object.keys(tables)) delete tables[key];
      Object.assign(tables, snapshot);
      throw err;
    }
  };
  db.log = log;
  return db;
}

// ---- a harness ------------------------------------------------------------------------------------------

// How the fake UsersService.inviteUser behaves, mirroring Directus 11.17 (services/users.js): an unknown e-mail gets an 'invited'
// user; an 'invited' one has its role changed when a different role is asked; any other status is left alone. The mail itself
// is fire-and-forget in Directus, so it can never throw out of inviteUser. `mailFail` is the switch the endpoint is built to
// survive in case that ever changes: 'after' throws after the user is saved, 'before' throws before any row is written.
function mount({ tables = baseTables(), raw = {}, env = {}, mailFail = null, updateFail = null } = {}) {
  const db = makeDb(tables, raw);
  const errors = [];
  const warnings = [];
  const invites = [];
  const updates = [];
  const handlers = {};
  const router = {
    get: (path, fn) => (handlers[`GET ${path}`] = fn),
    patch: (path, fn) => (handlers[`PATCH ${path}`] = fn),
    post: (path, fn) => (handlers[`POST ${path}`] = fn),
  };
  const cleared = [];
  const services = {
    UtilsService: class {
      constructor(opts) { this.opts = opts; }
      async clearCache(arg) { cleared.push({ opts: this.opts, arg, committed: db.log.tx.every((t) => t.committed) }); }
    },
    UsersService: class {
      constructor(opts) { this.opts = opts; }
      // PATCH /logins writes through updateOne as the caller, on the transaction (verified in a throwaway directus/directus:11, which also
      // throws 422 UNPROCESSABLE_CONTENT "Cannot remove the last admin user from the system": `updateFail` stands in for that)
      async updateOne(id, changes) {
        updates.push({ id, changes: { ...changes }, accountability: this.opts.accountability, schema: this.opts.schema, inTransaction: this.opts.knex !== db });
        if (updateFail) throw updateFail;
        await this.opts.knex('directus_users').where('id', id).update(changes);
        return id;
      }
      async inviteUser(email, role, url, subject) {
        invites.push({ email, role, url, subject, accountability: this.opts.accountability, inTransaction: this.opts.knex !== db });
        if (mailFail === 'before') throw new Error('mail down');
        const knex = this.opts.knex;
        const user = await knex('directus_users').whereRaw('LOWER(??) = ?', ['email', email.toLowerCase()]).first();
        if (!user) await knex('directus_users').insert({ email, role, status: 'invited', first_name: null, last_name: null, last_access: null });
        else if (user.status === 'invited' && user.role !== role) {
          if (mailFail === 'update') throw new Error('role update refused');
          await knex('directus_users').where('id', user.id).update({ role });
        }
        if (mailFail === 'after') throw new Error('mail down');
      }
    },
  };
  ext.handler(router, { database: db, services, logger: { sink: errors, error(m) { this.sink.push(m); }, warn(m) { warnings.push(m); } }, env });
  return { db, tables, handlers, errors, warnings, invites, updates, cleared };
}

const admin = (user) => ({ user, admin: true, app: true });
const member = (user) => ({ user, admin: false, app: true });

function call(h, { acc, params = {}, query = {}, body } = {}) {
  return new Promise((resolve) => {
    const out = { status: 200, body: undefined };
    const res = {
      status(code) { out.status = code; return res; },
      json(b) { out.body = b; resolve(out); return res; },
    };
    h({ accountability: acc, params, query, body, schema: {} }, res);
  });
}
const errorOf = (r) => r.body?.errors?.[0];

// attention rows, as d1_private.people_attention() returns them (person-based keys also fill user_ids)
const ATTENTION = [
  { key: 'login_without_person', person_ids: [], user_ids: [U.superAdmin, U.previewAdmin, U.orphan] },
  { key: 'invite_not_accepted', person_ids: [P.bob], user_ids: [U.bob, ID(298)] }, // one invited login has no person
  { key: 'former_login_active', person_ids: [P.cy], user_ids: [ID(297)] },
  { key: 'possible_duplicate', person_ids: [P.ann, P.bob], user_ids: [U.ann, U.bob] },
];

// ---- tests ------------------------------------------------------------------------------------------------

test('401 without a user', async () => {
  const { handlers } = mount();
  for (const route of ['GET /people', 'GET /attention', 'GET /people/:person_id/access']) {
    const r = await call(handlers[route], { acc: { user: null }, params: { person_id: P.ann } });
    assert.equal(r.status, 401, route);
    assert.equal(errorOf(r).extensions.code, 'UNAUTHORIZED');
    assert.equal(errorOf(r).extensions.source, 'd1-people-admin');
  }
  const none = await call(mount().handlers['GET /people'], { acc: undefined });
  assert.equal(none.status, 401);
});

test('403 for a member on GET /people and GET /attention', async () => {
  const { handlers } = mount({ raw: { 'SELECT key': ATTENTION } });
  for (const route of ['GET /people', 'GET /attention']) {
    const r = await call(handlers[route], { acc: member(U.ann) });
    assert.equal(r.status, 403, route);
    assert.equal(errorOf(r).extensions.code, 'FORBIDDEN');
  }
});

test('GET /people as Lab Admin returns can_administer_accounts false', async () => {
  const { handlers } = mount();
  const r = await call(handlers['GET /people'], { acc: admin(U.labAdmin) });
  assert.equal(r.status, 200);
  assert.equal(r.body.can_administer_accounts, false);
});

test('GET /people as an account administrator returns can_administer_accounts true', async () => {
  const { handlers } = mount();
  const r = await call(handlers['GET /people'], { acc: admin(U.superAdmin) });
  assert.equal(r.status, 200);
  assert.equal(r.body.can_administer_accounts, true);
});

test('an admin with no role (the policy is on the user) is an account administrator', async () => {
  const { handlers, db } = mount();
  const r = await call(handlers['GET /people'], { acc: admin(U.previewAdmin) });
  assert.equal(r.status, 200);
  assert.equal(r.body.can_administer_accounts, true);
  assert.deepEqual(await accountAdmin(db, U.previewAdmin, LAB_ADMIN_ROLE), { admin: true, accounts: true });
});

test('accountAdmin: Lab Admin is admin but not accounts; a member is neither; D1_LAB_ADMIN_ROLE_ID overrides the default', async () => {
  const { db } = mount();
  assert.deepEqual(await accountAdmin(db, U.labAdmin, LAB_ADMIN_ROLE), { admin: true, accounts: false });
  assert.deepEqual(await accountAdmin(db, U.superAdmin, LAB_ADMIN_ROLE), { admin: true, accounts: true });
  assert.deepEqual(await accountAdmin(db, U.ann, LAB_ADMIN_ROLE), { admin: false, accounts: false });
  assert.deepEqual(await accountAdmin(db, null, LAB_ADMIN_ROLE), { admin: false, accounts: false });
  // with the Super Admin role named as "the Lab Admin role" in the env, the Lab Admin login becomes an account administrator
  const { handlers } = mount({ env: { D1_LAB_ADMIN_ROLE_ID: R.super } });
  assert.equal((await call(handlers['GET /people'], { acc: admin(U.labAdmin) })).body.can_administer_accounts, true);
  assert.equal((await call(handlers['GET /people'], { acc: admin(U.superAdmin) })).body.can_administer_accounts, false);
});

const TEAM = { alpha: ID(901), beta: ID(902) };
const MEMBERSHIPS = [
  { person_id: P.ann, team_id: TEAM.alpha, name: 'Alpha Team', color: 'blue', logo: ID(950), is_manager: true },
  { person_id: P.ann, team_id: TEAM.beta, name: 'Beta Team', color: 'teal', logo: null, is_manager: false },
  { person_id: P.cy, team_id: TEAM.beta, name: 'Beta Team', color: 'teal', logo: null, is_manager: false },
];

test('GET /people joins login status, role name and last_access, and lists logins without a person', async () => {
  const { handlers } = mount({ raw: { 'SELECT key': ATTENTION } });
  const r = await call(handlers['GET /people'], { acc: admin(U.superAdmin) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.roles, [
    { id: R.lab, name: 'Lab Admin' },
    { id: R.member, name: 'Lab Member' },
    { id: R.super, name: 'Super Admin' },
  ]);
  const byName = Object.fromEntries(r.body.people.map((p) => [p.full_name, p]));
  assert.deepEqual(r.body.people.map((p) => p.full_name), ['Ann Member', 'Bob Member', 'Cy Nologin', 'Dee Labadmin']);
  assert.deepEqual(byName['Ann Member'], {
    person_id: P.ann, full_name: 'Ann Member', email: 'ann@people.example', is_researcher: true, is_operator: false, active: true, notes: 'hello', user_id: U.ann, created_at: '2026-03-01T09:30:00.000Z',
    login: { status: 'active', role_id: R.member, role_name: 'Lab Member', last_access: '2026-10-13T08:00:00.000Z', email: 'ann@login.example' },
    attention: ['possible_duplicate'],
    teams: [],
  });
  assert.equal(byName['Bob Member'].login.status, 'invited');
  assert.equal(byName['Bob Member'].login.last_access, null);
  assert.deepEqual(byName['Bob Member'].attention, ['invite_not_accepted', 'possible_duplicate']);
  assert.equal(byName['Cy Nologin'].created_at, '2026-05-02T00:00:00.000Z'); // for the "recently added" sort
  assert.equal(byName['Bob Member'].created_at, null); // a row without one
  assert.equal(byName['Cy Nologin'].login, null);
  assert.equal(byName['Cy Nologin'].user_id, null);
  assert.equal(byName['Cy Nologin'].active, false);
  assert.deepEqual(byName['Cy Nologin'].attention, ['former_login_active']);
  assert.equal(byName['Dee Labadmin'].login.role_name, 'Lab Admin');
  assert.deepEqual(byName['Dee Labadmin'].attention, []);
  // logins no person is linked to, with their role name and last_access
  assert.deepEqual(r.body.logins_without_person.map((l) => l.user_id), [U.orphan, U.previewAdmin, U.superAdmin]);
  assert.deepEqual(r.body.logins_without_person[0], {
    user_id: U.orphan, email: 'orphan@login.example', first_name: 'Olga', last_name: 'Orphan', status: 'suspended', role_id: R.member, role_name: 'Lab Member',
    last_access: '2026-09-01T10:00:00.000Z',
  });
  assert.equal(r.body.logins_without_person[1].role_id, null);
  assert.equal(r.body.logins_without_person[1].role_name, null);
});

test('GET /people gives each person their teams (one query: team_members joined with teams)', async () => {
  const { handlers, db } = mount({ raw: { 'SELECT key': ATTENTION, 'SELECT tm.person_id': MEMBERSHIPS } });
  const r = await call(handlers['GET /people'], { acc: admin(U.superAdmin) });
  const byName = Object.fromEntries(r.body.people.map((p) => [p.full_name, p]));
  assert.deepEqual(byName['Ann Member'].teams, [
    { team_id: TEAM.alpha, name: 'Alpha Team', color: 'blue', logo: ID(950), is_manager: true },
    { team_id: TEAM.beta, name: 'Beta Team', color: 'teal', logo: null, is_manager: false },
  ]);
  assert.deepEqual(byName['Cy Nologin'].teams, [{ team_id: TEAM.beta, name: 'Beta Team', color: 'teal', logo: null, is_manager: false }]);
  assert.deepEqual(byName['Bob Member'].teams, []);
  assert.equal(db.log.raw.filter((x) => /team_members/.test(x.sql)).length, 1);
});

test('attentionCount counts login keys by user_ids and every other key by person_ids (never both)', () => {
  const people = [P.ann, P.bob, P.cy];
  const logins = [U.ann, U.bob, ID(250), ID(251)];
  assert.equal(attentionCount({ key: 'login_without_person', person_ids: people, user_ids: logins }), 4);
  assert.equal(attentionCount({ key: 'invite_not_accepted', person_ids: [P.bob], user_ids: logins }), 4);
  for (const key of ['missing_email', 'possible_duplicate', 'former_login_active', 'suspended_owns_records']) {
    assert.equal(attentionCount({ key, person_ids: people, user_ids: logins }), 3, key);
  }
  assert.equal(attentionCount({ key: 'missing_email', person_ids: [], user_ids: logins }), 0);
  assert.equal(attentionCount({ key: 'login_without_person' }), 0);
});

test('GET /attention counts by the rule and omits zero counts', async () => {
  const rows = [
    ...ATTENTION,
    { key: 'missing_email', person_ids: [], user_ids: [ID(260)] }, // person-based key with no people: zero, omitted
    { key: 'suspended_owns_records', person_ids: [P.ann], user_ids: [U.ann] },
  ];
  const { handlers, db } = mount({ raw: { 'SELECT key': rows } });
  const r = await call(handlers['GET /attention'], { acc: admin(U.superAdmin) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    items: [
      { key: 'login_without_person', count: 3 },
      { key: 'invite_not_accepted', count: 2 },
      { key: 'former_login_active', count: 1 },
      { key: 'possible_duplicate', count: 2 },
      { key: 'suspended_owns_records', count: 1 },
    ],
  });
  assert.match(db.log.raw[0].sql, /d1_private\.people_attention\(\)/);
  const empty = mount({ raw: { 'SELECT key': [] } });
  assert.deepEqual((await call(empty.handlers['GET /attention'], { acc: admin(U.superAdmin) })).body, { items: [] });
});

const COUNTS = { 'SELECT owns': [{ owns: 3, shared: 2, investigator: 1, teams: 4, waiting: 2 }], 'SELECT count(DISTINCT': [{ owners: 1 }] };
const SHARED = [
  { collection: 'physical_samples', record_id: SAMPLE, level: 'view', source: 'access', granted_by: 'Bob Member', added_at: new Date('2026-10-01T12:00:00Z') },
  { collection: 'physical_samples', record_id: SAMPLE_GONE, level: 'edit', source: 'access', granted_by: null, added_at: null },
  { collection: 'projects', record_id: PROJECT, level: 'investigator', source: 'access', granted_by: null, added_at: null },
  { collection: 'not_a_collection', record_id: ID(77), level: 'view', source: 'access', granted_by: null, added_at: null },
];
const accessRaw = () => ({ ...COUNTS, 'SELECT collection': (bindings) => (bindings[1] === 'shared' ? SHARED : []) });

test('member can read only their own access', async () => {
  const { handlers, db } = mount({ raw: accessRaw() });
  const own = await call(handlers['GET /people/:person_id/access'], { acc: member(U.ann), params: { person_id: P.ann } });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, { owns: 3, shared: 2, investigator: 1, teams: 4, waiting: 2, waiting_owners: 1 });
  assert.deepEqual(db.log.raw[0].bindings, [P.ann]);
  const other = await call(handlers['GET /people/:person_id/access'], { acc: member(U.ann), params: { person_id: P.bob } });
  assert.equal(other.status, 403);
  assert.equal(errorOf(other).extensions.code, 'FORBIDDEN');
  const noLogin = await call(handlers['GET /people/:person_id/access'], { acc: member(U.ann), params: { person_id: P.cy } });
  assert.equal(noLogin.status, 403);
  // an admin may read anyone's; an unknown person is a 404 for them; a bad id is a 400
  assert.equal((await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.bob } })).status, 200);
  assert.equal((await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: ID(555) } })).status, 404);
  assert.equal((await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: 'nope' } })).status, 400);
  assert.equal((await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.bob }, query: { list: 'all' } })).status, 400);
});

test('?list=shared returns kind/code/title from COLLECTIONS fields', async () => {
  const { handlers, db } = mount({ raw: accessRaw() });
  const r = await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.ann }, query: { list: 'shared' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.records, [
    { collection: 'physical_samples', id: SAMPLE, kind: COLLECTIONS.physical_samples.kind, code: 'SM-001', title: 'Bar A', level: 'view', source: 'access', granted_by: 'Bob Member', added_at: '2026-10-01T12:00:00.000Z' },
    { collection: 'physical_samples', id: SAMPLE_GONE, kind: 'sample', code: 'SM-002', title: null, level: 'edit', source: 'access', granted_by: null, added_at: null },
    { collection: 'projects', id: PROJECT, kind: 'project', code: 'PRJ1', title: 'Project One', level: 'investigator', source: 'access', granted_by: null, added_at: null },
  ]);
  assert.deepEqual(db.log.raw.find((x) => x.sql.startsWith('SELECT collection')).bindings, [P.ann, 'shared']);
  // without ?list there are only the counts
  const counts = await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.ann } });
  assert.equal('records' in counts.body, false);
});

test('?list=teams lists the rows the teams of the person give them (source team, granted_by the team)', async () => {
  const TEAMS = [{ collection: 'physical_samples', record_id: SAMPLE, level: 'view', source: 'team', granted_by: 'Alpha Team', added_at: new Date('2026-10-02T12:00:00Z') }];
  const { handlers, db } = mount({ raw: { ...COUNTS, 'SELECT collection': (bindings) => (bindings[1] === 'teams' ? TEAMS : []) } });
  const r = await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.ann }, query: { list: 'teams' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.teams, 4);
  assert.deepEqual(r.body.records, [
    { collection: 'physical_samples', id: SAMPLE, kind: 'sample', code: 'SM-001', title: 'Bar A', level: 'view', source: 'team', granted_by: 'Alpha Team', added_at: '2026-10-02T12:00:00.000Z' },
  ]);
  assert.deepEqual(db.log.raw.find((x) => x.sql.startsWith('SELECT collection')).bindings, [P.ann, 'teams']);
});

test('the access counts say how many records are waiting for approval and how many owners that is', async () => {
  const { handlers, db } = mount({ raw: { ...COUNTS, 'SELECT count(DISTINCT': [{ owners: '2' }] } });
  const r = await call(handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.ann } });
  assert.equal(r.body.waiting, 2);
  assert.equal(r.body.waiting_owners, 2);
  assert.deepEqual(db.log.raw.find((x) => x.sql.startsWith('SELECT count(DISTINCT')).bindings.slice(-1), [P.ann]);
  // nobody waiting: no owners query is needed and the count is 0
  const none = mount({ raw: { 'SELECT owns': [{ owns: 0, shared: 0, investigator: 0, teams: 0, waiting: 0 }] } });
  const n = await call(none.handlers['GET /people/:person_id/access'], { acc: admin(U.labAdmin), params: { person_id: P.ann } });
  assert.deepEqual(n.body, { owns: 0, shared: 0, investigator: 0, teams: 0, waiting: 0, waiting_owners: 0 });
  assert.equal(none.db.log.raw.some((x) => x.sql.startsWith('SELECT count(DISTINCT')), false);
});

test('a member does not see a record they no longer read in the list, but it is still counted', async () => {
  const { handlers } = mount({ raw: accessRaw() });
  const r = await call(handlers['GET /people/:person_id/access'], { acc: member(U.ann), params: { person_id: P.ann }, query: { list: 'shared' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.shared, 2); // the count is the full count
  assert.deepEqual(r.body.records.map((x) => x.id), [SAMPLE, PROJECT]); // SAMPLE_GONE is not in Ann's readers table
});

// ---- PATCH /logins/:user_id ---------------------------------------------------------------------------------

const PATCH = 'PATCH /logins/:user_id';
const patch = (handlers, acc, user, body) => call(handlers[PATCH], { acc, params: { user_id: user }, body });
const userRow = (tables, id) => tables.directus_users.find((u) => u.id === id);
const withSessions = () => {
  const tables = baseTables();
  tables.directus_sessions = [
    { token: 't1', user: U.ann }, { token: 't2', user: U.ann }, { token: 't3', user: U.bob },
  ];
  return tables;
};

test('lab admin cannot change a role', async () => {
  const { handlers, tables } = mount();
  for (const acc of [admin(U.labAdmin), member(U.ann)]) {
    const r = await patch(handlers, acc, U.ann, { role: R.super });
    assert.equal(r.status, 403);
    assert.equal(errorOf(r).extensions.code, 'ACCOUNTS_ADMIN_ONLY');
  }
  assert.equal(userRow(tables, U.ann).role, R.member);
  assert.equal((await patch(handlers, { user: null }, U.ann, { role: R.super })).status, 401);
});

test('writes through UsersService.updateOne as the caller, inside the transaction (the audit trail)', async () => {
  const { handlers, tables, updates, db } = mount();
  const caller = admin(U.superAdmin);
  assert.equal((await patch(handlers, caller, U.ann, { role: R.lab, status: 'suspended' })).status, 200);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, U.ann);
  assert.deepEqual(updates[0].changes, { role: R.lab, status: 'suspended' });
  assert.deepEqual(updates[0].accountability, caller); // not a system accountability: Directus records the activity under the caller
  assert.equal(updates[0].inTransaction, true);
  assert.deepEqual(updates[0].schema, {}); // req.schema is passed on
  assert.deepEqual(userRow(tables, U.ann), { ...userRow(tables, U.ann), role: R.lab, status: 'suspended' });
  assert.equal(db.log.tx[0].committed, true);
  // Directus's own last-admin check (422) is the same answer as ours: 409 LAST_ADMINISTRATOR, rolled back
  const last = mount({ updateFail: Object.assign(new Error("Can't process content. Cannot remove the last admin user from the system."), { code: 'UNPROCESSABLE_CONTENT', extensions: { reason: 'Cannot remove the last admin user from the system' } }) });
  const r = await patch(last.handlers, caller, U.ann, { role: R.member });
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'LAST_ADMINISTRATOR');
  assert.equal(last.db.log.tx.every((t) => !t.committed), true);
  // any other error from the service is a 500, not swallowed
  const broken = mount({ updateFail: new Error('boom') });
  assert.equal((await patch(broken.handlers, caller, U.ann, { role: R.member })).status, 500);
});

test('changes the role', async () => {
  const { handlers, tables, db } = mount();
  const r = await patch(handlers, admin(U.superAdmin), U.ann, { role: R.lab });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user_id: U.ann, role_id: R.lab, role_name: 'Lab Admin', status: 'active' });
  assert.equal(userRow(tables, U.ann).role, R.lab);
  assert.equal(userRow(tables, U.ann).status, 'active'); // the status was not sent: untouched
  // in one transaction, actor first
  assert.equal(db.log.tx.length, 1);
  assert.equal(db.log.tx[0].committed, true);
  assert.match(db.log.tx[0].raw[0].sql, /set_config\('d1\.actor_identity', \?, true\)/);
  assert.deepEqual(db.log.tx[0].raw[0].bindings, [U.superAdmin]);
});

test('an unknown role id, a malformed body or a missing login is refused', async () => {
  const { handlers, tables } = mount();
  const as = admin(U.superAdmin);
  const unknown = await patch(handlers, as, U.ann, { role: ID(999) });
  assert.equal(unknown.status, 400);
  assert.equal(errorOf(unknown).extensions.code, 'INVALID_PAYLOAD');
  assert.equal(userRow(tables, U.ann).role, R.member);
  assert.equal((await patch(handlers, as, U.ann, { role: 'nope' })).status, 400);
  assert.equal((await patch(handlers, as, U.ann, { role: null })).status, 400);
  assert.equal((await patch(handlers, as, U.ann, {})).status, 400);
  assert.equal((await patch(handlers, as, U.ann, undefined)).status, 400);
  assert.equal((await patch(handlers, as, 'nope', { role: R.lab })).status, 400);
  const gone = await patch(handlers, as, ID(777), { role: R.lab });
  assert.equal(gone.status, 404);
  assert.equal(errorOf(gone).extensions.code, 'NOT_FOUND');
});

test('a status other than active or suspended is refused', async () => {
  const { handlers, tables } = mount();
  for (const status of ['invited', 'draft', 'archived', '', null, 1]) {
    const r = await patch(handlers, admin(U.superAdmin), U.ann, { status });
    assert.equal(r.status, 400, String(status));
    assert.equal(errorOf(r).extensions.code, 'INVALID_PAYLOAD');
  }
  assert.equal(userRow(tables, U.ann).status, 'active');
});

test('refuses demoting the last account administrator', async () => {
  const tables = baseTables();
  userRow(tables, U.previewAdmin).status = 'suspended'; // Su Per is now the only active account administrator
  const { handlers, db } = mount({ tables });
  const as = admin(U.superAdmin);
  for (const role of [R.member, R.lab]) { // a role without admin, and the Lab Admin role (admin, but not account administrator)
    const r = await patch(handlers, as, U.superAdmin, { role });
    assert.equal(r.status, 409, role);
    assert.equal(errorOf(r).extensions.code, 'LAST_ADMINISTRATOR');
    assert.equal(errorOf(r).message, 'Make someone else an Administrator first');
    assert.equal(userRow(tables, U.superAdmin).role, R.super); // rolled back
  }
  assert.equal(db.log.tx.every((t) => !t.committed), true);
  // keeping the role is fine
  assert.equal((await patch(handlers, as, U.superAdmin, { role: R.super })).status, 200);
  // a second active account administrator makes the demotion allowed
  userRow(tables, U.previewAdmin).status = 'active';
  const ok = await patch(handlers, as, U.superAdmin, { role: R.member });
  assert.equal(ok.status, 200);
  assert.equal(userRow(tables, U.superAdmin).role, R.member);
});

test('refuses suspending the last account administrator; a non-administrator is never blocked', async () => {
  const tables = withSessions();
  userRow(tables, U.previewAdmin).status = 'suspended';
  tables.directus_sessions.push({ token: 't4', user: U.superAdmin });
  const { handlers } = mount({ tables });
  const r = await patch(handlers, admin(U.superAdmin), U.superAdmin, { status: 'suspended' });
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'LAST_ADMINISTRATOR');
  assert.equal(errorOf(r).message, 'Make someone else an Administrator first');
  assert.equal(userRow(tables, U.superAdmin).status, 'active');
  assert.equal(tables.directus_sessions.some((s) => s.user === U.superAdmin), true); // rolled back: the sessions are still there
  // suspending a login that is not an account administrator is not blocked
  assert.equal((await patch(handlers, admin(U.superAdmin), U.ann, { status: 'suspended' })).status, 200);
});

test('suspend ends sessions', async () => {
  const tables = withSessions();
  const { handlers, db } = mount({ tables });
  const r = await patch(handlers, admin(U.superAdmin), U.ann, { status: 'suspended' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user_id: U.ann, role_id: R.member, role_name: 'Lab Member', status: 'suspended' });
  assert.equal(userRow(tables, U.ann).status, 'suspended');
  assert.deepEqual(tables.directus_sessions.map((s) => s.token), ['t3']); // both sessions of Ann are gone, the one of Bob stays
  assert.equal(db.log.tx.length, 1);
  assert.equal(db.log.tx[0].committed, true);
  assert.deepEqual(db.log.tx[0].raw[0].bindings, [U.superAdmin]);
  assert.match(db.log.tx[0].raw[0].sql, /d1\.actor_identity/);
});

test('reactivate', async () => {
  const tables = withSessions();
  const { handlers } = mount({ tables });
  const r = await patch(handlers, admin(U.superAdmin), U.orphan, { status: 'active' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'active');
  assert.equal(userRow(tables, U.orphan).status, 'active');
  assert.equal(tables.directus_sessions.length, 3); // reactivating touches no sessions
});

test('the data cache is cleared after the commit, only when CACHE_ENABLED is on', async () => {
  const off = mount({ env: {} });
  await patch(off.handlers, admin(U.superAdmin), U.ann, { role: R.lab });
  assert.equal(off.cleared.length, 0);
  const on = mount({ env: { CACHE_ENABLED: 'true' } });
  await patch(on.handlers, admin(U.superAdmin), U.ann, { role: R.lab });
  assert.equal(on.cleared.length, 1);
  assert.deepEqual(on.cleared[0].arg, { system: false });
  assert.equal(on.cleared[0].committed, true);
  // a refused change clears nothing
  const refused = mount({ env: { CACHE_ENABLED: 'true' } });
  await patch(refused.handlers, admin(U.superAdmin), U.ann, { role: ID(999) });
  assert.equal(refused.cleared.length, 0);
});

// ---- PATCH: only a suspended login is reactivated ----------------------------------------------------------

test('status active is allowed only for a suspended login (an invited login would have an unacceptable invite)', async () => {
  const tables = baseTables();
  const { handlers, db } = mount({ tables });
  const as = admin(U.superAdmin);
  const invited = await patch(handlers, as, U.bob, { status: 'active' });
  assert.equal(invited.status, 409);
  assert.equal(errorOf(invited).extensions.code, 'NOT_SUSPENDED');
  assert.equal(errorOf(invited).message, 'Only a suspended login can be reactivated');
  assert.equal(userRow(tables, U.bob).status, 'invited');
  assert.equal(db.log.tx.every((t) => !t.committed), true);
  // already active: a no-op, allowed; suspended: reactivated
  assert.equal((await patch(handlers, as, U.ann, { status: 'active' })).status, 200);
  assert.equal(userRow(tables, U.ann).status, 'active');
  assert.equal((await patch(handlers, as, U.orphan, { status: 'active' })).status, 200);
  assert.equal(userRow(tables, U.orphan).status, 'active');
  // a role change on an invited login is not touched by this rule
  assert.equal((await patch(handlers, as, U.bob, { role: R.lab })).status, 200);
  assert.equal(userRow(tables, U.bob).status, 'invited');
});

test('an invite that has not been accepted cannot be suspended', async () => {
  const tables = withSessions();
  const { handlers, db, updates } = mount({ tables });
  const r = await patch(handlers, admin(U.superAdmin), U.bob, { status: 'suspended' });
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'NOT_ACTIVE');
  assert.equal(errorOf(r).message, 'An invite that has not been accepted cannot be suspended — delete the login instead');
  assert.equal(userRow(tables, U.bob).status, 'invited');
  assert.equal(tables.directus_sessions.some((s) => s.user === U.bob), true); // nothing was touched
  assert.equal(updates.length, 0);
  assert.equal(db.log.tx.every((t) => !t.committed), true);
});

// ---- POST /invite and POST /invite/resend ------------------------------------------------------------------

const MEMBER_ROLE = '10000001-0000-0000-0000-000000000002';
const INVITE_URL = 'https://sb.example/accept-invite';
const ENV = { STARBASE_URL: 'https://sb.example' };
const INVITE = 'POST /invite';
const RESEND = 'POST /invite/resend';
const invite = (handlers, acc, body) => call(handlers[INVITE], { acc, body });
const loginByEmail = (tables, email) => tables.directus_users.find((u) => u.email.toLowerCase() === email.toLowerCase());

test('invites and links an existing person', async () => {
  const { handlers, tables, db, invites } = mount({ env: ENV });
  const r = await invite(handlers, admin(U.superAdmin), { email: 'cy@new.example', person_id: P.cy, role: R.lab });
  assert.equal(r.status, 201);
  const created = loginByEmail(tables, 'cy@new.example');
  assert.deepEqual(r.body, { user_id: created.id, person_id: P.cy, status: 'invited', email_sent: true });
  assert.equal(created.status, 'invited');
  assert.equal(created.role, R.lab); // an account administrator may choose any role
  assert.equal(tables.people.find((p) => p.person_id === P.cy).user_id, created.id);
  assert.equal(tables.people.length, 4); // no person was created
  assert.equal(tables.people.find((p) => p.person_id === P.cy).is_researcher, true); // linking makes a researcher (the hook does the same)
  // Directus's own service sends the mail, inside the transaction, as the system, with the STARbase accept-invite address
  assert.equal(invites.length, 1);
  assert.deepEqual([invites[0].email, invites[0].role, invites[0].url], ['cy@new.example', R.lab, INVITE_URL]);
  assert.equal(invites[0].accountability.admin, true);
  assert.equal(invites[0].inTransaction, true);
  assert.equal(db.log.tx.length, 1);
  assert.equal(db.log.tx[0].committed, true);
  assert.deepEqual(db.log.tx[0].raw[0].bindings, [U.superAdmin]);
  assert.match(db.log.tx[0].raw[0].sql, /d1\.actor_identity/);
});

test('creates the person when none is given', async () => {
  const { handlers, tables, invites } = mount({ env: ENV });
  const r = await invite(handlers, admin(U.superAdmin), { email: ' Eve@New.example ', full_name: ' Eve New ' });
  assert.equal(r.status, 201);
  const created = loginByEmail(tables, 'eve@new.example');
  const person = tables.people.find((p) => p.full_name === 'Eve New');
  assert.equal(tables.people.length, 5);
  assert.equal(person.email, 'Eve@New.example');
  assert.equal(person.is_researcher, true);
  assert.equal(person.user_id, created.id);
  assert.deepEqual(r.body, { user_id: created.id, person_id: person.person_id, status: 'invited', email_sent: true });
  assert.equal(invites[0].role, MEMBER_ROLE); // no role asked: Lab Member
  // no person and no name: refused, nothing is created
  const before = tables.directus_users.length;
  for (const body of [{ email: 'x@new.example' }, { email: 'x@new.example', full_name: '  ' }]) {
    const bad = await invite(handlers, admin(U.superAdmin), body);
    assert.equal(bad.status, 400);
    assert.equal(errorOf(bad).extensions.code, 'INVALID_PAYLOAD');
  }
  assert.equal(tables.directus_users.length, before);
  assert.equal(invites.length, 1);
});

test('lab admin invite is forced to Lab Member', async () => {
  const { handlers, tables, invites } = mount({ env: { ...ENV, D1_LAB_MEMBER_ROLE_ID: R.member } });
  const as = admin(U.labAdmin);
  // no role: Lab Member (here named by D1_LAB_MEMBER_ROLE_ID)
  assert.equal((await invite(handlers, as, { email: 'a@new.example', full_name: 'A New' })).status, 201);
  assert.equal(invites[0].role, R.member);
  // the Lab Member role asked for explicitly is fine
  assert.equal((await invite(handlers, as, { email: 'b@new.example', full_name: 'B New', role: R.member })).status, 201);
  // any other role is not: 403, nothing created
  const before = { users: tables.directus_users.length, people: tables.people.length };
  for (const role of [R.super, R.lab]) {
    const r = await invite(handlers, as, { email: 'c@new.example', full_name: 'C New', role });
    assert.equal(r.status, 403, role);
    assert.equal(errorOf(r).extensions.code, 'ACCOUNTS_ADMIN_ONLY');
  }
  assert.deepEqual({ users: tables.directus_users.length, people: tables.people.length }, before);
  assert.equal(invites.length, 2);
  // the default Lab Member role id when the env names none
  const plain = mount({ env: ENV });
  await invite(plain.handlers, as, { email: 'd@new.example', full_name: 'D New' });
  assert.equal(plain.invites[0].role, MEMBER_ROLE);
});

test('who may invite, and which role', async () => {
  const { handlers, invites } = mount({ env: ENV });
  const body = { email: 'z@new.example', full_name: 'Z New' };
  assert.equal((await invite(handlers, { user: null }, body)).status, 401);
  const forbidden = await invite(handlers, member(U.ann), body);
  assert.equal(forbidden.status, 403);
  assert.equal(errorOf(forbidden).extensions.code, 'FORBIDDEN');
  // a role that does not exist, a malformed one, a bad e-mail, a bad person id
  const as = admin(U.superAdmin);
  assert.equal((await invite(handlers, as, { ...body, role: ID(999) })).status, 400);
  assert.equal((await invite(handlers, as, { ...body, role: 'nope' })).status, 400);
  for (const email of [undefined, '', 'not-an-email', 7]) assert.equal((await invite(handlers, as, { ...body, email })).status, 400, String(email));
  assert.equal((await invite(handlers, as, { email: 'z@new.example', person_id: 'nope' })).status, 400);
  assert.equal((await invite(handlers, as, undefined)).status, 400);
  assert.equal(invites.length, 0);
});

test('person must exist and have no login', async () => {
  const { handlers, tables, invites } = mount({ env: ENV });
  const as = admin(U.superAdmin);
  const has = await invite(handlers, as, { email: 'w@new.example', person_id: P.ann });
  assert.equal(has.status, 409);
  assert.equal(errorOf(has).extensions.code, 'PERSON_HAS_LOGIN');
  const gone = await invite(handlers, as, { email: 'w@new.example', person_id: ID(555) });
  assert.equal(gone.status, 404);
  assert.equal(errorOf(gone).extensions.code, 'NOT_FOUND');
  assert.equal(invites.length, 0);
  assert.equal(loginByEmail(tables, 'w@new.example'), undefined);
});

test('email with an active login is refused with its person', async () => {
  const { handlers, invites, tables } = mount({ env: ENV });
  const as = admin(U.superAdmin);
  const linked = await invite(handlers, as, { email: 'ANN@login.example', full_name: 'Ann Again' }); // any case
  assert.equal(linked.status, 409);
  assert.equal(errorOf(linked).extensions.code, 'EMAIL_HAS_LOGIN');
  assert.equal(errorOf(linked).extensions.person_id, P.ann);
  assert.equal(errorOf(linked).extensions.source, 'd1-people-admin');
  // a suspended login too; this one has no person, so no person_id
  const orphan = await invite(handlers, as, { email: 'orphan@login.example', full_name: 'Olga' });
  assert.equal(orphan.status, 409);
  assert.equal(errorOf(orphan).extensions.code, 'EMAIL_HAS_LOGIN');
  assert.equal('person_id' in errorOf(orphan).extensions, false);
  assert.equal(invites.length, 0);
  assert.equal(tables.people.length, 4);
});

test('email already invited resends', async () => {
  const { handlers, tables, invites } = mount({ env: ENV });
  // Bob's login is invited and already linked to Bob: no person is asked for or created, his role is kept
  const r = await invite(handlers, admin(U.labAdmin), { email: 'Bob@login.example' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user_id: U.bob, person_id: P.bob, status: 'invited', email_sent: true });
  assert.equal(invites.length, 1);
  assert.deepEqual([invites[0].email, invites[0].role, invites[0].url], ['bob@login.example', R.member, INVITE_URL]);
  assert.equal(tables.people.length, 4);
  assert.equal(tables.directus_users.length, 6);
  // a Lab Admin cannot change the role of an invited login by inviting again
  userRow(tables, U.bob).role = R.super;
  await invite(handlers, admin(U.labAdmin), { email: 'bob@login.example' });
  assert.equal(invites[1].role, R.super);
  assert.equal(userRow(tables, U.bob).role, R.super);
  // an account administrator who asks for a role changes it
  await invite(handlers, admin(U.superAdmin), { email: 'bob@login.example', role: R.lab });
  assert.equal(userRow(tables, U.bob).role, R.lab);
  // a person asked for that is not the one the login is linked to is refused, naming the linked one
  const other = await invite(handlers, admin(U.superAdmin), { email: 'bob@login.example', person_id: P.cy });
  assert.equal(other.status, 409);
  assert.equal(errorOf(other).extensions.code, 'EMAIL_HAS_LOGIN');
  assert.equal(errorOf(other).extensions.person_id, P.bob);
  // the linked person asked for explicitly is fine
  assert.equal((await invite(handlers, admin(U.superAdmin), { email: 'bob@login.example', person_id: P.bob })).status, 200);
});

test('an invited login with no person gets one linked', async () => {
  const tables = baseTables();
  tables.directus_users.push({ id: ID(260), email: 'loose@login.example', status: 'invited', role: R.member });
  const { handlers } = mount({ tables, env: ENV });
  assert.equal((await invite(handlers, admin(U.superAdmin), { email: 'loose@login.example' })).status, 400); // no person, no name
  const r = await invite(handlers, admin(U.superAdmin), { email: 'loose@login.example', person_id: P.cy });
  assert.equal(r.status, 200);
  assert.equal(r.body.user_id, ID(260));
  assert.equal(tables.people.find((p) => p.person_id === P.cy).user_id, ID(260));
});

test('mail failure keeps the login and reports email_sent false', async () => {
  const { handlers, tables, db, warnings, errors } = mount({ env: ENV, mailFail: 'after' });
  const r = await invite(handlers, admin(U.superAdmin), { email: 'cy@new.example', person_id: P.cy });
  assert.equal(r.status, 201);
  const created = loginByEmail(tables, 'cy@new.example');
  assert.deepEqual(r.body, { user_id: created.id, person_id: P.cy, status: 'invited', email_sent: false });
  assert.equal(tables.people.find((p) => p.person_id === P.cy).user_id, created.id); // the link stays
  assert.equal(db.log.tx[0].committed, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mail down/);
  assert.equal(errors.length, 0);
  // an error that left no login behind is not a mail failure: everything rolls back and the caller gets a 500
  const bad = mount({ env: ENV, mailFail: 'before' });
  const r2 = await invite(bad.handlers, admin(U.superAdmin), { email: 'eve@new.example', full_name: 'Eve New' });
  assert.equal(r2.status, 500);
  assert.equal(loginByEmail(bad.tables, 'eve@new.example'), undefined);
  assert.equal(bad.tables.people.length, 4);
});

test('503 when STARBASE_URL is unset', async () => {
  for (const env of [{}, { STARBASE_URL: '' }, { STARBASE_URL: '  ' }]) {
    const { handlers, invites, tables } = mount({ env });
    const body = { email: 'q@new.example', full_name: 'Q New' };
    const r = await invite(handlers, admin(U.superAdmin), body);
    assert.equal(r.status, 503);
    assert.equal(errorOf(r).extensions.code, 'STARBASE_URL_UNSET');
    const again = await call(handlers[RESEND], { acc: admin(U.superAdmin), body: { user_id: U.bob } });
    assert.equal(again.status, 503);
    assert.equal(invites.length, 0);
    assert.equal(tables.people.length, 4);
  }
});

test('the data cache is cleared after an invite commits', async () => {
  const on = mount({ env: { ...ENV, CACHE_ENABLED: 'true' } });
  await invite(on.handlers, admin(U.superAdmin), { email: 'k@new.example', full_name: 'K New' });
  assert.equal(on.cleared.length, 1);
  assert.equal(on.cleared[0].committed, true);
});

test('resend sends the invite again for an invited login', async () => {
  const { handlers, invites, tables } = mount({ env: ENV });
  const resend = (acc, user_id) => call(handlers[RESEND], { acc, body: { user_id } });
  for (const acc of [admin(U.labAdmin), admin(U.superAdmin)]) {
    const r = await resend(acc, U.bob);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { email_sent: true });
  }
  assert.equal(invites.length, 2);
  assert.deepEqual([invites[0].email, invites[0].role, invites[0].url], ['bob@login.example', R.member, INVITE_URL]);
  assert.equal(userRow(tables, U.bob).status, 'invited');
  // other statuses: 409 NOT_INVITED
  for (const id of [U.ann, U.orphan]) {
    const r = await resend(admin(U.superAdmin), id);
    assert.equal(r.status, 409);
    assert.equal(errorOf(r).extensions.code, 'NOT_INVITED');
  }
  assert.equal((await resend(admin(U.superAdmin), ID(777))).status, 404);
  assert.equal((await resend(admin(U.superAdmin), 'nope')).status, 400);
  assert.equal((await resend(admin(U.superAdmin), undefined)).status, 400);
  assert.equal((await resend(member(U.ann), U.bob)).status, 403);
  assert.equal((await resend({ user: null }, U.bob)).status, 401);
  assert.equal(invites.length, 2);
});

test('resend: a mail failure reports email_sent false', async () => {
  const { handlers, warnings } = mount({ env: ENV, mailFail: 'after' });
  const r = await call(handlers[RESEND], { acc: admin(U.superAdmin), body: { user_id: U.bob } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { email_sent: false });
  assert.equal(warnings.length, 1);
});

test('a failed role change on an invited login is an error, not a mail failure', async () => {
  const { handlers, tables, db, warnings } = mount({ env: ENV, mailFail: 'update' });
  const r = await invite(handlers, admin(U.superAdmin), { email: 'bob@login.example', role: R.lab });
  assert.equal(r.status, 500);
  assert.equal(userRow(tables, U.bob).role, R.member); // unchanged
  assert.equal(db.log.tx.every((t) => !t.committed), true); // rolled back
  assert.equal(warnings.length, 0);
});

// ---- POST /invite from the header: no person chosen, so an unlinked person with this e-mail is that person ------------

test('header invite: one unlinked person with the e-mail is linked, not duplicated', async () => {
  const tables = baseTables();
  const { handlers, invites } = mount({ tables, env: ENV });
  // Cy has no login and is not a researcher; the e-mail matches ignoring case and spaces; a name is not needed
  tables.people.find((p) => p.person_id === P.cy).email = ' CY@People.example ';
  const r = await invite(handlers, admin(U.superAdmin), { email: 'cy@people.example' });
  assert.equal(r.status, 201);
  const created = loginByEmail(tables, 'cy@people.example');
  assert.deepEqual(r.body, { user_id: created.id, person_id: P.cy, status: 'invited', email_sent: true });
  assert.equal(tables.people.length, 4); // nobody was inserted
  const cy = tables.people.find((p) => p.person_id === P.cy);
  assert.equal(cy.user_id, created.id);
  assert.equal(cy.is_researcher, true); // whoever is linked to a login is a researcher, as d1-person-link sets it
  assert.equal(invites.length, 1);
  // a full_name sent along changes nothing: still the existing person
  const again = mount({ tables: baseTables(), env: ENV });
  const r2 = await invite(again.handlers, admin(U.superAdmin), { email: 'CY@people.example', full_name: 'Somebody Else' });
  assert.equal(r2.body.person_id, P.cy);
  assert.equal(again.tables.people.length, 4);
  // a person who already has a login is not a candidate: Ann's e-mail on a person row with a login still creates a new person
  const linkedOnly = baseTables();
  linkedOnly.people.find((p) => p.person_id === P.ann).email = 'shared@people.example';
  const third = mount({ tables: linkedOnly, env: ENV });
  const r3 = await invite(third.handlers, admin(U.superAdmin), { email: 'shared@people.example', full_name: 'New Shared' });
  assert.equal(r3.status, 201);
  assert.equal(linkedOnly.people.length, 5);
});

test('header invite: several unlinked people with the e-mail is 409 PERSON_AMBIGUOUS, nothing is created', async () => {
  const tables = baseTables();
  tables.people.push({ person_id: ID(150), full_name: 'Cy Twin', email: 'cy@people.example', is_researcher: false, is_operator: false, active: true, notes: null, user_id: null });
  const { handlers, db, invites } = mount({ tables, env: ENV });
  const before = { users: tables.directus_users.length, people: tables.people.length };
  const r = await invite(handlers, admin(U.superAdmin), { email: 'Cy@People.example', full_name: 'Cy' });
  assert.equal(r.status, 409);
  assert.equal(errorOf(r).extensions.code, 'PERSON_AMBIGUOUS');
  assert.equal(errorOf(r).message, 'Several people have this email — invite from the right person\'s panel');
  assert.deepEqual([...errorOf(r).extensions.person_ids].sort(), [P.cy, ID(150)].sort());
  assert.deepEqual({ users: tables.directus_users.length, people: tables.people.length }, before);
  assert.equal(invites.length, 0);
  assert.equal(db.log.tx.every((t) => !t.committed), true);
  // choosing the person in the panel (person_id) is the way out
  assert.equal((await invite(handlers, admin(U.superAdmin), { email: 'cy@people.example', person_id: P.cy })).status, 201);
});

test('header invite: no person with the e-mail inserts a new one (is_researcher), as before', async () => {
  const { handlers, tables } = mount({ env: ENV });
  const r = await invite(handlers, admin(U.superAdmin), { email: 'nobody@new.example', full_name: 'No Body' });
  assert.equal(r.status, 201);
  assert.equal(tables.people.length, 5);
  assert.equal(tables.people.find((p) => p.full_name === 'No Body').is_researcher, true);
  // an invited login of yours with no person, e-mail matching an unlinked person: linked too
  const t2 = baseTables();
  t2.directus_users.push({ id: ID(261), email: 'cy@people.example', status: 'invited', role: R.member });
  const m2 = mount({ tables: t2, env: ENV });
  const r2 = await invite(m2.handlers, admin(U.superAdmin), { email: 'cy@people.example' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.person_id, P.cy);
  assert.equal(t2.people.find((p) => p.person_id === P.cy).user_id, ID(261));
});
