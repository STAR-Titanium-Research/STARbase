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
    { person_id: P.ann, full_name: 'Ann Member', email: 'ann@people.example', is_researcher: true, is_operator: false, active: true, notes: 'hello', user_id: U.ann },
    { person_id: P.bob, full_name: 'Bob Member', email: null, is_researcher: true, is_operator: true, active: true, notes: null, user_id: U.bob },
    { person_id: P.cy, full_name: 'Cy Nologin', email: 'cy@people.example', is_researcher: false, is_operator: true, active: false, notes: null, user_id: null },
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

function mount({ tables = baseTables(), raw = {}, env = {} } = {}) {
  const db = makeDb(tables, raw);
  const errors = [];
  const handlers = {};
  const router = { get: (path, fn) => (handlers[`GET ${path}`] = fn), patch: (path, fn) => (handlers[`PATCH ${path}`] = fn) };
  const cleared = [];
  const services = {
    UtilsService: class {
      constructor(opts) { this.opts = opts; }
      async clearCache(arg) { cleared.push({ opts: this.opts, arg, committed: db.log.tx.every((t) => t.committed) }); }
    },
  };
  ext.handler(router, { database: db, services, logger: { sink: errors, error(m) { this.sink.push(m); }, warn() {} }, env });
  return { db, tables, handlers, errors, cleared };
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
    person_id: P.ann, full_name: 'Ann Member', email: 'ann@people.example', is_researcher: true, is_operator: false, active: true, notes: 'hello', user_id: U.ann,
    login: { status: 'active', role_id: R.member, role_name: 'Lab Member', last_access: '2026-10-13T08:00:00.000Z', email: 'ann@login.example' },
    attention: ['possible_duplicate'],
  });
  assert.equal(byName['Bob Member'].login.status, 'invited');
  assert.equal(byName['Bob Member'].login.last_access, null);
  assert.deepEqual(byName['Bob Member'].attention, ['invite_not_accepted', 'possible_duplicate']);
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

const COUNTS = { 'SELECT owns': [{ owns: 3, shared: 2, investigator: 1 }] };
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
  assert.deepEqual(own.body, { owns: 3, shared: 2, investigator: 1 });
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
