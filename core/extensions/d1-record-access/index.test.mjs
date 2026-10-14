// Run with: node --test core/extensions/d1-record-access/index.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ext, { COLLECTIONS, mailContent, recipientAddress, recordLink, roleLabel, withTimeout } from './index.js';

// ---- ids and the world ----------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SAMPLE = ID(1);
const OPERATION = ID(2);
const TEST = ID(3);
const CAMPAIGN = ID(4);
const PROJECT = ID(5);
const OTHER_SAMPLE = ID(9);
const P = { owner: ID(101), co: ID(102), view: ID(103), nologin: ID(104), nomail: ID(105), inactive: ID(106), pi: ID(107), badlogin: ID(108), stranger: ID(109), editor: ID(110) };
const T = { alpha: ID(301), beta: ID(302), empty: ID(303) };
const U = { owner: ID(201), co: ID(202), view: ID(203), pi: ID(207), badlogin: ID(208), stranger: ID(209), editor: ID(210), orphan: ID(299) };

const baseTables = () => ({
  people: [
    { person_id: P.owner, full_name: 'Olive Owner', email: 'olive@people.example', user_id: U.owner, active: true },
    { person_id: P.co, full_name: 'Cory Coowner', email: null, user_id: U.co, active: true },
    { person_id: P.view, full_name: 'Vic Viewer', email: 'vic@people.example', user_id: U.view, active: true },
    { person_id: P.nologin, full_name: 'Nell Nologin', email: 'nell@people.example', user_id: null, active: true },
    { person_id: P.nomail, full_name: 'Nadia Nomail', email: null, user_id: null, active: true },
    { person_id: P.inactive, full_name: 'Ian Inactive', email: 'ian@people.example', user_id: null, active: false },
    { person_id: P.pi, full_name: 'Pia PI', email: 'pia@people.example', user_id: U.pi, active: true },
    { person_id: P.badlogin, full_name: 'Bo Badlogin', email: 'bo@people.example', user_id: U.badlogin, active: true },
    { person_id: P.stranger, full_name: 'Sam Stranger', email: null, user_id: U.stranger, active: true },
    { person_id: P.editor, full_name: 'Edda Editor', email: null, user_id: U.editor, active: true },
  ],
  directus_users: [
    { id: U.owner, email: 'owner@login.example', first_name: 'Olive', last_name: 'Owner' },
    { id: U.co, email: 'co@login.example', first_name: 'Cory', last_name: 'Coowner' },
    { id: U.view, email: 'vic@login.example', first_name: 'Vic', last_name: 'Viewer' },
    { id: U.pi, email: 'pia@login.example', first_name: 'Pia', last_name: 'PI' },
    { id: U.badlogin, email: '', first_name: 'Bo', last_name: 'Badlogin' }, // a login with no address: People's address is NOT used
    { id: U.stranger, email: 'sam@login.example', first_name: 'Sam', last_name: 'Stranger' },
    { id: U.editor, email: 'edda@login.example', first_name: 'Edda', last_name: 'Editor' },
    { id: U.orphan, email: 'orphan@login.example', first_name: 'Olga', last_name: 'Orphan' },
  ],
  physical_samples: [
    { sample_id: SAMPLE, owner_person_id: P.owner, restricted: false, project_id: PROJECT, sample_code: 'SM-001', nickname: 'Bar A' },
    { sample_id: OTHER_SAMPLE, owner_person_id: P.stranger, restricted: false, project_id: null, sample_code: 'SM-009', nickname: null },
  ],
  manufacturing_operations: [
    { operation_id: OPERATION, owner_person_id: P.owner, restricted: false, project_id: PROJECT, campaign_id: CAMPAIGN, sample_id: SAMPLE, pass_code: 'SM-001-F1' },
  ],
  test_sessions: [{ session_id: TEST, owner_person_id: P.owner, restricted: false, project_id: PROJECT, campaign_id: CAMPAIGN, sample_id: SAMPLE, test_code: 'SM-001-SEM1', test_type: 'sem' }],
  campaigns: [{ campaign_id: CAMPAIGN, owner_person_id: P.owner, restricted: false, project_id: PROJECT, campaign_code: 'CMP-1', name: 'Campaign one' }],
  projects: [{ project_id: PROJECT, principal_investigator_person: P.pi, restricted: false, project_code: 'PRJ1', project_name: 'Project One' }],
  sample_access: [], operation_access: [], test_access: [], campaign_access: [], project_access: [],
  teams: [
    { team_id: T.alpha, name: 'Alpha lab', color: 'blue', logo: null },
    { team_id: T.beta, name: 'Beta crew', color: 'green', logo: ID(400) },
    { team_id: T.empty, name: 'Empty team', color: null, logo: null },
  ],
  // Alpha: the owner, two readers, a co-owner, a login with no address, a person with no login, an inactive person, a stranger
  team_members: [P.owner, P.view, P.co, P.badlogin, P.nologin, P.inactive, P.stranger].map((person_id) => ({ team_id: T.alpha, person_id, is_manager: false }))
    .concat([{ team_id: T.beta, person_id: P.view, is_manager: true }]),
  sample_team_access: [], operation_team_access: [], test_team_access: [], campaign_team_access: [], project_team_access: [],
  sample_team_pending: [], operation_team_pending: [], test_team_pending: [], campaign_team_pending: [], project_team_pending: [],
  sample_co_owners: [], project_investigators: [],
  sample_readers: [], operation_readers: [], test_readers: [], campaign_readers: [], project_readers: [],
  directus_access: [], directus_policies: [],
});

// ---- a tiny in-memory knex: just the calls the endpoint makes, with transactions that roll back -----------

const same = (a, b) => String(a) === String(b);
function makeDb(initial, hook = null) {
  const store = { tables: structuredClone(initial) };
  const log = { events: [], raw: [], writes: [], compiled: [] };
  const over = (target, inTrx) => {
    const rowsOf = (table) => (target.tables[table] ??= []);
    const db = (table) => {
      if (target.broken && !inTrx) throw new Error('connection lost');
      const preds = [];
      const rows = () => rowsOf(table).filter((r) => preds.every((p) => p(r)));
      const project = (row, cols) => (row === undefined ? undefined : cols.length ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : { ...row });
      const q = {
        where(a, v) {
          if (a && typeof a === 'object') for (const [k, x] of Object.entries(a)) preds.push((r) => same(r[k], x));
          else preds.push((r) => same(r[a], v));
          return q;
        },
        whereIn(c, values) { preds.push((r) => values.some((v) => same(r[c], v))); return q; },
        whereNull(c) { preds.push((r) => r[c] === null || r[c] === undefined); return q; },
        whereNotNull(c) { preds.push((r) => r[c] !== null && r[c] !== undefined); return q; },
        select: async (...cols) => rows().map((r) => project(r, cols)),
        first: async (...cols) => project(rows()[0], cols),
        update: async (patch) => {
          const hit = rows();
          guard(table, hit);
          for (const r of hit) Object.assign(r, patch);
          log.writes.push({ table, op: 'update', patch, n: hit.length, inTrx });
          return hit.length;
        },
        del: async () => {
          const hit = new Set(rows());
          guard(table, [...hit]);
          target.tables[table] = rowsOf(table).filter((r) => !hit.has(r));
          log.writes.push({ table, op: 'delete', n: hit.size, inTrx });
          return hit.size;
        },
        // awaited directly it is a plain INSERT (a team grant: unique per record and team, like the table); .onConflict(...).merge() is an
        // upsert, and the conflict target must be the raw clause of the partial unique index, as in Postgres
        insert: (row) => ({
          onConflict: (conflict) => ({
            merge: async (patch) => {
              if (!conflict?.partialIndex) {
                // the own-entry unique key is a PARTIAL index since migration 182: a plain column list cannot infer it
                throw Object.assign(new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification'), { code: '42P10' });
              }
              const cols = conflict.partialIndex.columns;
              const found = rowsOf(table).find((r) => (r.team_access_id ?? null) === null && cols.every((c) => same(r[c], row[c])));
              if (found) Object.assign(found, patch);
              else rowsOf(table).push({ access_id: `acc-${rowsOf(table).length + 1}`, created_at: new Date('2026-10-13T09:00:00Z'), ...row });
              log.compiled.push({ table, target: conflict.target, patch });
              log.writes.push({ table, op: found ? 'upsert-update' : 'insert', row, inTrx });
            },
          }),
          then(resolve, reject) {
            return (async () => {
              if (/_team_access$/.test(table)) {
                const keys = Object.entries(row).filter(([k]) => /_id$/.test(k) && k !== 'added_by_person_id' && k !== 'team_access_id');
                if (rowsOf(table).some((r) => keys.every(([k, v]) => same(r[k], v)))) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
                rowsOf(table).push({ team_access_id: `ta-${rowsOf(table).length + 1}`, trust_new_members: false, created_at: new Date('2026-10-14T09:00:00Z'), ...row });
              } else rowsOf(table).push({ access_id: `acc-${rowsOf(table).length + 1}`, created_at: new Date('2026-10-13T09:00:00Z'), ...row });
              log.writes.push({ table, op: 'insert', row, inTrx });
            })().then(resolve, reject);
          },
        }),
      };
      return q;
    };
    // Postgres: only the team triggers may touch a derived row (team_access_id set) of an access table; anything else raises 42501
    const guard = (table, hit) => {
      if (/^(sample|operation|test|campaign|project)_access$/.test(table) && hit.some((r) => (r.team_access_id ?? null) !== null)) {
        throw Object.assign(new Error('Team access rows are managed by the team\'s grant'), { code: '42501' });
      }
    };
    // Lazy like knex's: a raw runs (and is logged) when awaited. The conflict clause is only ever passed to onConflict, never awaited; it is
    // rendered here (no knex: CI runs these tests without npm install) so the test sees the conflict target the endpoint hands to Postgres.
    db.raw = (sql, bindings) => {
      const answer = {
        sql,
        bindings,
        then: (resolve, reject) => {
          log.raw.push({ sql, bindings, inTrx });
          return Promise.resolve().then(() => (hook ? hook(sql, bindings, target) : { rows: [] })).then(resolve, reject);
        },
      };
      if (/^\(\?\?, \?\?\) WHERE \?\? IS NULL$/.test(sql)) {
        answer.partialIndex = { columns: bindings.slice(0, 2) };
        // knex renders ?? as a double-quoted identifier
        let i = 0;
        answer.target = sql.replaceAll('??', () => `"${bindings[i++]}"`);
      }
      return answer;
    };
    return db;
  };
  const db = over(store, false);
  db.transaction = async (fn) => {
    const working = { tables: structuredClone(store.tables) };
    const trx = over(working, true);
    trx.isTransaction = true;
    log.events.push('begin');
    try {
      const out = await fn(trx);
      store.tables = working.tables;
      log.events.push('commit');
      return out;
    } catch (err) {
      log.events.push('rollback');
      throw err;
    }
  };
  db.tables = () => store.tables;
  db.breakReads = () => { store.broken = true; };
  db.log = log;
  return db;
}

// ---- a harness: fake services, a router, requests ----------------------------------------------------------

const forbidden = () => Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });

function mount({ raw = null, tables = baseTables(), readable = () => true, manage = (c, id, user) => user === U.owner || (c === 'projects' && user === U.pi), mail = {}, env = { PUBLIC_URL: 'https://lab.example/' } } = {}) {
  const db = makeDb(tables, raw);
  const calls = { items: [], manage: [], reads: [], cache: [], mail: { built: [], sent: [] } };
  const keyOf = (collection) => COLLECTIONS[collection].key;
  class ItemsService {
    constructor(collection, options) { this.collection = collection; this.options = options; calls.items.push({ collection, options }); }
    async readOne(id, query) {
      calls.reads.push({ collection: this.collection, id, query });
      if (!readable(this.collection, id, this.options.accountability.user)) throw forbidden();
      return { [keyOf(this.collection)]: id };
    }
    async readByQuery(query) {
      const id = query.filter._and[0][keyOf(this.collection)]._eq;
      calls.manage.push({ collection: this.collection, id, query, user: this.options.accountability.user, knex: this.options.knex, events: [...db.log.events] });
      return manage(this.collection, id, this.options.accountability.user) ? [{ [keyOf(this.collection)]: id }] : [];
    }
  }
  class MailService {
    constructor(options) {
      calls.mail.built.push(options);
      if (mail.throwOnConstruct) throw new Error('Illegal transport given for email');
    }
    async send(data) {
      calls.mail.sent.push(data);
      if (mail.hang) return new Promise(() => {});
      if (mail.fail) throw new Error('SMTP refused');
      if (mail.failLate) return new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 20_000));
      return { messageId: 'x' };
    }
  }
  class UtilsService {
    constructor(options) { this.options = options; }
    async clearCache(args) { calls.cache.push({ args, accountability: this.options.accountability, events: [...db.log.events] }); }
  }
  const warnings = [];
  const errors = [];
  const handlers = {};
  const router = ['get', 'post', 'patch', 'delete'].reduce((r, m) => ({ ...r, [m]: (path, fn) => (handlers[`${m.toUpperCase()} ${path}`] = fn) }), {});
  ext.handler(router, {
    database: db,
    // methods that need their receiver, like pino's: a detached call (const warn = logger.warn) throws
    logger: { sink: { warnings, errors }, warn(m) { this.sink.warnings.push(m); }, error(m) { this.sink.errors.push(m); } },
    services: { ItemsService, MailService, UtilsService },
    env,
  });
  return { db, handlers, calls, warnings, errors };
}

const owner = { user: U.owner, admin: false, app: true };
const admin = { user: ID(250), admin: true, app: true };
const as = (user) => ({ user, admin: false, app: true });

function call(h, { acc = owner, collection = 'physical_samples', id = SAMPLE, body, params = {} } = {}) {
  return new Promise((resolve) => {
    const out = { status: 200, body: undefined };
    const res = {
      status(code) { out.status = code; return res; },
      json(b) { out.body = b; resolve(out); return res; },
    };
    h({ accountability: acc, params: { collection, id, ...params }, body, schema: 'SCHEMA' }, res);
  });
}
const errorOf = (r) => r.body?.errors?.[0];

// ---- routes and the shape of errors ---------------------------------------------------------------------------

test('registers the nine routes (the five of the people list and the four of the team entries)', () => {
  const { handlers } = mount();
  assert.deepEqual(Object.keys(handlers).sort(), [
    'DELETE /:collection/:id/entries/:person_id',
    'DELETE /:collection/:id/entries/team/:team_id',
    'GET /:collection/:id',
    'GET /:collection/:id/entries/team/:team_id/members',
    'PATCH /:collection/:id/entries/:person_id',
    'PATCH /:collection/:id/entries/team/:team_id',
    'POST /:collection/:id/entries',
    'POST /:collection/:id/entries/team/:team_id/members/:person_id',
    'POST /:collection/:id/transfer',
  ]);
});

test('401 without a user, on every route', async () => {
  const { handlers } = mount();
  for (const key of Object.keys(handlers)) {
    for (const acc of [null, {}, { user: null, role: null }]) {
      const r = await call(handlers[key], { acc, body: { person_id: P.view, role: 'view' }, params: { person_id: P.view } });
      assert.equal(r.status, 401, key);
      assert.equal(errorOf(r).extensions.code, 'UNAUTHORIZED');
      assert.equal(errorOf(r).extensions.source, 'd1-record-access');
    }
  }
});

test('the collection whitelist, the uuid and the role are checked (400)', async () => {
  const { handlers, db } = mount();
  for (const collection of ['people', 'directus_users', 'sample_access', 'physical_samples; drop', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal((await call(handlers['GET /:collection/:id'], { collection })).status, 400, String(collection));
  }
  assert.equal((await call(handlers['GET /:collection/:id'], { id: 'not-a-uuid' })).status, 400);
  const post = handlers['POST /:collection/:id/entries'];
  for (const body of [undefined, {}, { person_id: P.view }, { person_id: 'x', role: 'view' }, { person_id: P.view, role: 'admin' }]) {
    assert.equal((await call(post, { body })).status, 400, JSON.stringify(body));
  }
  // investigator only on projects; edit not on projects
  assert.equal((await call(post, { body: { person_id: P.view, role: 'investigator' } })).status, 400);
  assert.equal((await call(post, { collection: 'projects', id: PROJECT, acc: as(U.pi), body: { person_id: P.view, role: 'edit' } }, )).status, 400);
  assert.equal((await call(handlers['POST /:collection/:id/transfer'], { body: { person_id: 'nope' } })).status, 400);
  assert.equal((await call(handlers['PATCH /:collection/:id/entries/:person_id'], { params: { person_id: 'nope' }, body: { role: 'view' } })).status, 400);
  assert.deepEqual(db.log.writes, []);
});

test('a record the caller cannot read is a 404, and nothing about it is looked up (two-user isolation)', async () => {
  const world = baseTables();
  world.sample_access.push({ access_id: 'a1', sample_id: OTHER_SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.stranger, created_at: new Date() });
  const readable = (collection, id, user) => (user === U.owner ? id === SAMPLE : id === OTHER_SAMPLE);
  const { handlers, calls } = mount({ tables: world, readable, manage: () => false });
  const mine = await call(handlers['GET /:collection/:id'], { acc: owner, id: SAMPLE });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.entries, []);
  const theirs = await call(handlers['GET /:collection/:id'], { acc: owner, id: OTHER_SAMPLE });
  assert.equal(theirs.status, 404);
  assert.equal(errorOf(theirs).extensions.code, 'NOT_FOUND');
  const other = await call(handlers['GET /:collection/:id'], { acc: as(U.stranger), id: OTHER_SAMPLE });
  assert.equal(other.body.entries.length, 1);
  assert.equal(other.body.entries[0].name, 'Vic Viewer');
  assert.equal((await call(handlers['GET /:collection/:id'], { acc: as(U.stranger), id: SAMPLE })).status, 404);
  // the read ran as the caller, through ItemsService, with the request's schema
  assert.ok(calls.items.every((i) => i.options.accountability.user && i.options.schema === 'SCHEMA'));
  // an unreadable record answers 404 on the writes too, before the manage check
  const post = await call(handlers['POST /:collection/:id/entries'], { acc: as(U.stranger), id: SAMPLE, body: { person_id: P.view, role: 'view' } });
  assert.equal(post.status, 404);
  assert.equal(calls.manage.filter((m) => m.user === U.stranger && m.id === SAMPLE).length, 0);
});

// ---- who can manage ---------------------------------------------------------------------------------------------

test('can_manage: the owner and an admin; a co-owner, Can edit, viewer and stranger can read the list and not change it', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.co });
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.editor, role: 'edit', added_by_person_id: P.owner, created_at: new Date() });
  world.sample_access.push({ access_id: 'a2', sample_id: SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  const { handlers, calls } = mount({ tables: world });
  const get = handlers['GET /:collection/:id'];
  const post = handlers['POST /:collection/:id/entries'];
  const matrix = [['owner', owner, true], ['admin', admin, true], ['co-owner', as(U.co), false], ['can edit', as(U.editor), false], ['viewer', as(U.view), false], ['stranger', as(U.stranger), false]];
  for (const [who, acc, expected] of matrix) {
    const r = await call(get, { acc });
    assert.equal(r.status, 200, who);
    assert.equal(r.body.can_manage, expected, who);
    const w = await call(post, { acc, body: { person_id: P.nologin, role: 'view' } });
    assert.equal(w.status, expected ? 200 : 403, who);
    if (!expected) {
      assert.equal(errorOf(w).extensions.code, 'FORBIDDEN');
      assert.equal(errorOf(w).extensions.source, 'd1-record-access');
    }
    await call(handlers['DELETE /:collection/:id/entries/:person_id'], { acc: admin, params: { person_id: P.nologin } }); // reset
  }
  // an admin needs no manage read; everyone else is asked as themselves with their id in the manage filter (the delete rule)
  assert.ok(!calls.manage.some((m) => m.user === admin.user));
  const asked = calls.manage.find((m) => m.user === U.co);
  assert.deepEqual(asked.query.filter._and[0], { sample_id: { _eq: SAMPLE } });
  assert.ok(JSON.stringify(asked.query.filter).includes(U.co) && !JSON.stringify(asked.query.filter).includes('$CURRENT_USER'));
});

test('the manage filter is the record\'s own delete rule, from rules.json, for every collection', async () => {
  const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')).records;
  const ids = { physical_samples: SAMPLE, manufacturing_operations: OPERATION, test_sessions: TEST, campaigns: CAMPAIGN, projects: PROJECT };
  const { handlers, calls } = mount();
  for (const [collection, id] of Object.entries(ids)) {
    await call(handlers['GET /:collection/:id'], { collection, id, acc: as(U.view) });
    const asked = calls.manage.find((m) => m.collection === collection);
    assert.deepEqual(asked.query.filter._and[1], JSON.parse(JSON.stringify(rules[collection].manage).replaceAll('$CURRENT_USER', U.view)), collection);
  }
});

test('a record with no owner can be managed by an admin only', async () => {
  const world = baseTables();
  world.physical_samples[0].owner_person_id = null;
  const { handlers } = mount({ tables: world, manage: () => false });
  const body = { person_id: P.view, role: 'view' };
  assert.equal((await call(handlers['POST /:collection/:id/entries'], { acc: owner, body })).status, 403);
  assert.equal((await call(handlers['POST /:collection/:id/entries'], { acc: admin, body })).status, 200);
  const got = await call(handlers['GET /:collection/:id'], { acc: admin });
  assert.equal(got.body.owner, null);
  assert.equal(got.body.can_manage, true);
});

// ---- the list ------------------------------------------------------------------------------------------------------

test('GET: restricted, the owner, the project PI and the merged entries with their labels', async () => {
  const world = baseTables();
  world.physical_samples[0].restricted = true;
  world.sample_access.push(
    { access_id: 'a1', sample_id: SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.owner, created_at: new Date('2026-10-01T10:00:00Z') },
    { access_id: 'a2', sample_id: SAMPLE, person_id: P.nologin, role: 'edit', added_by_person_id: P.owner, created_at: new Date('2026-10-02T10:00:00Z') },
  );
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.co }, { id: 2, sample_id: SAMPLE, user_id: U.orphan });
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.co }, { record_id: SAMPLE, user_id: U.view }, { record_id: SAMPLE, user_id: U.orphan });
  world.project_readers.push({ record_id: PROJECT, user_id: U.owner }); // the caller reads the project, so its PI is named
  const { handlers } = mount({ tables: world });
  const r = await call(handlers['GET /:collection/:id']);
  assert.equal(r.status, 200);
  assert.equal(r.body.restricted, true);
  assert.deepEqual(r.body.owner, { person_id: P.owner, name: 'Olive Owner', can_sign_in: true });
  assert.deepEqual(r.body.project_pi, { person_id: P.pi, name: 'Pia PI', can_sign_in: true });
  assert.equal(r.body.can_manage, true);
  const by = Object.fromEntries(r.body.entries.map((e) => [e.name, e]));
  assert.deepEqual(by['Cory Coowner'], { person_id: P.co, name: 'Cory Coowner', role: 'edit', label: 'Co-owner · can edit', source: 'co_owner', can_sign_in: true, added_by: null, added_at: null, blocked_by: null });
  assert.deepEqual(by['Nell Nologin'], { person_id: P.nologin, name: 'Nell Nologin', role: 'edit', label: 'Can edit', source: 'access', can_sign_in: false, added_by: 'Olive Owner', added_at: '2026-10-02T10:00:00.000Z', blocked_by: { reason: 'no_login', collection: null, id: null, kind: null, code: null } });
  assert.equal(by['Vic Viewer'].label, 'Can view');
  // a login with no People row is listed by its login's name, with no person to manage
  assert.deepEqual([by['Olga Orphan'].person_id, by['Olga Orphan'].source, by['Olga Orphan'].can_sign_in], [null, 'co_owner', true]);
  assert.deepEqual(r.body.entries.map((e) => e.name), ['Cory Coowner', 'Nell Nologin', 'Olga Orphan', 'Vic Viewer']);
});

test('entries merge the access table with the old tables to the strongest role, one entry per person', async () => {
  const world = baseTables();
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.co, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.co });
  world.project_access.push({ access_id: 'a2', project_id: PROJECT, person_id: P.view, role: 'view', added_by_person_id: P.pi, created_at: new Date() });
  world.project_access.push({ access_id: 'a3', project_id: PROJECT, person_id: P.co, role: 'investigator', added_by_person_id: P.pi, created_at: new Date() });
  world.project_investigators.push({ id: 1, project_id: PROJECT, user_id: U.co }, { id: 2, project_id: PROJECT, user_id: U.view });
  const { handlers } = mount({ tables: world });
  const sample = (await call(handlers['GET /:collection/:id'])).body.entries;
  assert.equal(sample.length, 1);
  assert.deepEqual([sample[0].role, sample[0].source, sample[0].label], ['edit', 'co_owner', 'Co-owner · can edit']);
  const project = (await call(handlers['GET /:collection/:id'], { collection: 'projects', id: PROJECT, acc: as(U.pi) })).body.entries;
  assert.deepEqual(project.map((e) => [e.name, e.role, e.source, e.label]), [
    ['Cory Coowner', 'investigator', 'access', 'Secondary investigator'],
    ['Vic Viewer', 'investigator', 'investigator', 'Secondary investigator'],
  ]);
});

test('the owner never appears as an entry, even with a stale row', async () => {
  const world = baseTables();
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.owner, role: 'view', added_by_person_id: null, created_at: new Date() });
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.owner });
  const { handlers } = mount({ tables: world });
  assert.deepEqual((await call(handlers['GET /:collection/:id'])).body.entries, []);
});

const NONE = { collection: null, id: null, kind: null, code: null };
const entryFor = (rows, name) => Object.fromEntries(rows.map((e) => [e.name, e]))[name];
const grant = (table, key, recordId, personId) => ({ access_id: `g-${table}-${personId}`, [key]: recordId, person_id: personId, role: 'view', added_by_person_id: P.owner, created_at: new Date() });

test('blocked_by asks the record\'s OWN readers table: a login that is in it is not blocked, a login that is not is, a person with no login always is', async () => {
  const world = baseTables();
  world.sample_access.push(grant('sample_access', 'sample_id', SAMPLE, P.view), grant('sample_access', 'sample_id', SAMPLE, P.co), grant('sample_access', 'sample_id', SAMPLE, P.nologin), grant('sample_access', 'sample_id', SAMPLE, P.stranger));
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.view }, { record_id: SAMPLE, user_id: U.co });
  const { handlers } = mount({ tables: world });
  const list = (await call(handlers['GET /:collection/:id'])).body.entries;
  assert.equal(entryFor(list, 'Vic Viewer').blocked_by, null);
  assert.equal(entryFor(list, 'Cory Coowner').blocked_by, null);
  assert.deepEqual(entryFor(list, 'Nell Nologin').blocked_by, { reason: 'no_login', ...NONE });
  // a login with no readers row: blocked; the caller reads no parent of the sample (not a project reader), so nothing of the parent is named
  assert.deepEqual(entryFor(list, 'Sam Stranger').blocked_by, { reason: 'parent', ...NONE });
});

test('a sample in a restricted project: a person added to the sample IS a reader (the project gates no sample), so there is no false "will not take effect"', async () => {
  const world = baseTables();
  world.projects[0].restricted = true;
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.view });
  const { handlers, calls } = mount({ tables: world });
  const r = await add(handlers, { person_id: P.view, role: 'view' });
  assert.equal(r.body.entry.blocked_by, null);
  assert.ok(calls.mail.sent[0].text.includes('Bar A') && calls.mail.sent[0].text.includes('lab.example'), 'and the mail carries the title and the link');
});

test('a parent is named only to a caller who can read it, and never its code or PI to anyone else', async () => {
  const world = baseTables();
  world.projects[0].restricted = true;
  world.sample_access.push(grant('sample_access', 'sample_id', SAMPLE, P.stranger));
  const hidden = mount({ tables: world });
  const blind = await call(hidden.handlers['GET /:collection/:id']); // the owner reads the sample but NOT its restricted project
  assert.deepEqual(entryFor(blind.body.entries, 'Sam Stranger').blocked_by, { reason: 'parent', ...NONE });
  assert.equal(blind.body.project_pi, null, 'the PI of a project the caller cannot read is not named');
  assert.ok(!JSON.stringify(blind.body).includes('PRJ1') && !JSON.stringify(blind.body).includes('Pia PI'));
  // the same list for someone who reads the project: the parent is named
  const sighted = baseTables();
  sighted.projects[0].restricted = true;
  sighted.sample_access.push(grant('sample_access', 'sample_id', SAMPLE, P.stranger));
  sighted.project_readers.push({ record_id: PROJECT, user_id: U.owner });
  const seen = await call(mount({ tables: sighted }).handlers['GET /:collection/:id']);
  assert.deepEqual(entryFor(seen.body.entries, 'Sam Stranger').blocked_by, { reason: 'parent', collection: 'projects', id: PROJECT, kind: 'project', code: 'PRJ1' });
  assert.equal(seen.body.project_pi.name, 'Pia PI');
  // an admin reads every parent
  const asAdmin = await call(mount({ tables: world }).handlers['GET /:collection/:id'], { acc: admin });
  assert.equal(entryFor(asAdmin.body.entries, 'Sam Stranger').blocked_by.code, 'PRJ1');
});

test('operations: blocked by the sample, the campaign or the project from the readers table; hidden by a gate no parent explains is generic; admins are never blocked', async () => {
  const base = () => {
    const w = baseTables();
    w.operation_access.push(grant('operation_access', 'operation_id', OPERATION, P.view));
    w.sample_readers.push({ record_id: SAMPLE, user_id: U.owner });
    w.campaign_readers.push({ record_id: CAMPAIGN, user_id: U.owner });
    w.project_readers.push({ record_id: PROJECT, user_id: U.owner });
    return w;
  };
  const vic = (w, table, id) => w[table].push({ record_id: id, user_id: U.view });
  const get = async (world, acc = owner) =>
    entryFor((await call(mount({ tables: world }).handlers['GET /:collection/:id'], { collection: 'manufacturing_operations', id: OPERATION, acc })).body.entries, 'Vic Viewer').blocked_by;
  // 1. not a reader of the sample (nor of anything else): the nearest parent is the sample
  assert.deepEqual(await get(base()), { reason: 'parent', collection: 'physical_samples', id: SAMPLE, kind: 'sample', code: 'SM-001' });
  // 2. a reader of the sample, not of the campaign
  const w2 = base(); vic(w2, 'sample_readers', SAMPLE);
  assert.deepEqual(await get(w2), { reason: 'parent', collection: 'campaigns', id: CAMPAIGN, kind: 'campaign', code: 'CMP-1' });
  // 3. a reader of the sample and the campaign, not of the project
  const w3 = base(); vic(w3, 'sample_readers', SAMPLE); vic(w3, 'campaign_readers', CAMPAIGN);
  assert.deepEqual(await get(w3), { reason: 'parent', collection: 'projects', id: PROJECT, kind: 'project', code: 'PRJ1' });
  // 4. a reader of every parent but not of the operation (campaign shielding, the sample's own project): no parent explains it
  const w4 = base(); vic(w4, 'sample_readers', SAMPLE); vic(w4, 'campaign_readers', CAMPAIGN); vic(w4, 'project_readers', PROJECT);
  assert.deepEqual(await get(w4), { reason: 'parent', ...NONE });
  // 5. in the operation's own readers: not blocked, whatever the parents say
  const w5 = base(); vic(w5, 'operation_readers', OPERATION);
  assert.equal(await get(w5), null);
  // 6. an admin is not listed in any readers table and is not blocked
  const w6 = base(); w6.directus_users.find((u) => u.id === U.view).role = ID(900); w6.directus_access.push({ role: ID(900), user: null, policy: ID(901) }); w6.directus_policies.push({ id: ID(901), admin_access: true });
  assert.equal(await get(w6), null);
  // 7. a test: the same walk through test_readers
  const w7 = base(); w7.test_access.push(grant('test_access', 'session_id', TEST, P.view)); vic(w7, 'test_readers', TEST);
  const t = entryFor((await call(mount({ tables: w7 }).handlers['GET /:collection/:id'], { collection: 'test_sessions', id: TEST })).body.entries, 'Vic Viewer');
  assert.equal(t.blocked_by, null);
});

// ---- adding ---------------------------------------------------------------------------------------------------------

const add = (h, body, extra = {}) => call(h['POST /:collection/:id/entries'], { body, ...extra });

test('add: a login-less person with an address gets one mail, the row, and the entry back', async () => {
  const { handlers, db, calls } = mount();
  const r = await add(handlers, { person_id: P.nologin, role: 'edit' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'sent');
  assert.deepEqual([r.body.entry.person_id, r.body.entry.role, r.body.entry.label, r.body.entry.can_sign_in, r.body.entry.added_by], [P.nologin, 'edit', 'Can edit', false, 'Olive Owner']);
  assert.deepEqual(db.tables().sample_access.map((x) => [x.sample_id, x.person_id, x.role, x.added_by_person_id]), [[SAMPLE, P.nologin, 'edit', P.owner]]);
  assert.equal(calls.mail.sent.length, 1);
  assert.equal(calls.mail.sent[0].to, 'nell@people.example');
  assert.match(calls.mail.sent[0].subject, /Olive Owner gave you access to sample SM-001/);
  assert.deepEqual(calls.mail.built[0], { schema: 'SCHEMA', knex: db });
});

test('add: the actor is set first, in the write transaction, and everything commits together', async () => {
  const { handlers, db } = mount();
  await add(handlers, { person_id: P.view, role: 'view' });
  assert.deepEqual(db.log.events, ['begin', 'commit']);
  assert.equal(db.log.raw[0].inTrx, true);
  assert.match(db.log.raw[0].sql, /set_config\('d1\.actor_identity', \?, true\)/);
  assert.deepEqual(db.log.raw[0].bindings, [U.owner]);
  assert.ok(db.log.writes.every((w) => w.inTrx), 'every write ran in the transaction');
  assert.equal(db.log.raw.length, 1, 'and set_config is issued once, before the first write');
});

test('add: the address is the LOGIN\'s when there is a login, the People address only for a person with no login', async () => {
  const { handlers, calls } = mount();
  await add(handlers, { person_id: P.view, role: 'view' }); // login vic@login.example, people vic@people.example
  assert.equal(calls.mail.sent[0].to, 'vic@login.example');
  const r = await add(handlers, { person_id: P.badlogin, role: 'view' }); // login with no address, People has one
  assert.equal(r.body.email, 'skipped', 'no fallback to the People address for a person with a login');
  assert.equal(calls.mail.sent.length, 1);
  await add(handlers, { person_id: P.nologin, role: 'view' });
  assert.equal(calls.mail.sent[1].to, 'nell@people.example');
  assert.equal(recipientAddress({ user_id: U.view, email: 'p@x' }, { email: 'l@x' }), 'l@x');
  assert.equal(recipientAddress({ user_id: U.view, email: 'p@x' }, { email: '  ' }), null);
  assert.equal(recipientAddress({ user_id: U.view, email: 'p@x' }, null), null);
  assert.equal(recipientAddress({ user_id: null, email: ' p@x ' }, null), 'p@x');
  assert.equal(recipientAddress({ user_id: null, email: null }, null), null);
  assert.equal(recipientAddress(null, null), null);
});

test('add: a person with no address at all is skipped, the change stands', async () => {
  const { handlers, db, calls } = mount();
  const r = await add(handlers, { person_id: P.nomail, role: 'view' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'skipped');
  assert.equal(calls.mail.sent.length, 0);
  assert.equal(calls.mail.built.length, 0);
  assert.equal(db.tables().sample_access.length, 1);
});

test('add: a role change sends no mail, adding yourself sends none, a legacy co-owner re-added sends none', async () => {
  const world = baseTables();
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.nologin, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.co });
  const { handlers, db, calls } = mount({ tables: world });
  const change = await add(handlers, { person_id: P.nologin, role: 'edit' });
  assert.equal(change.body.email, 'skipped');
  assert.equal(db.tables().sample_access.find((x) => x.person_id === P.nologin).role, 'edit');
  assert.equal(db.tables().sample_access.length, 1, 'one row per person');
  // the admin adds themself (a person with their own login): no mail to the adder
  world.people.push({ person_id: ID(150), full_name: 'Ada Admin', email: 'ada@people.example', user_id: admin.user, active: true });
  const self = mount({ tables: world });
  const me = await add(self.handlers, { person_id: ID(150), role: 'view' }, { acc: admin });
  assert.equal(me.body.email, 'skipped');
  assert.equal(self.calls.mail.sent.length, 0);
  // re-adding a legacy co-owner converts the row: not a new grant
  const legacy = await add(handlers, { person_id: P.co, role: 'edit' });
  assert.equal(legacy.body.email, 'skipped');
  assert.equal(calls.mail.sent.length, 0);
  assert.deepEqual(db.tables().sample_co_owners, [], 'the old row is gone');
  assert.deepEqual(db.tables().sample_access.filter((x) => x.person_id === P.co).map((x) => x.role), ['edit']);
  assert.equal(legacy.body.entry.source, 'access');
});

test('add: every write deletes the person\'s old-table row in the same transaction (samples and projects)', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.view }, { id: 2, sample_id: OTHER_SAMPLE, user_id: U.view });
  world.project_investigators.push({ id: 1, project_id: PROJECT, user_id: U.view });
  const { handlers, db } = mount({ tables: world });
  await add(handlers, { person_id: P.view, role: 'view' });
  assert.deepEqual(db.tables().sample_co_owners.map((r) => r.sample_id), [OTHER_SAMPLE], 'only this sample\'s row of this person');
  assert.deepEqual(db.log.writes.map((w) => `${w.op}:${w.table}:${w.inTrx}`), ['insert:sample_access:true', 'delete:sample_co_owners:true']);
  await call(handlers['POST /:collection/:id/entries'], { collection: 'projects', id: PROJECT, acc: as(U.pi), body: { person_id: P.view, role: 'view' } });
  assert.deepEqual(db.tables().project_investigators, []);
  assert.deepEqual(db.tables().project_access.map((r) => [r.person_id, r.role]), [[P.view, 'view']]);
});

test('add: the owner (409), an unknown person and an inactive person (400) change nothing and send nothing', async () => {
  const { handlers, db, calls } = mount();
  const own = await add(handlers, { person_id: P.owner, role: 'edit' });
  assert.equal(own.status, 409);
  assert.equal(errorOf(own).extensions.code, 'CONFLICT');
  assert.equal((await add(handlers, { person_id: ID(777), role: 'view' })).status, 400);
  assert.equal((await add(handlers, { person_id: P.inactive, role: 'view' })).status, 400);
  assert.deepEqual(db.tables().sample_access, []);
  assert.deepEqual(db.log.events, ['begin', 'rollback', 'begin', 'rollback', 'begin', 'rollback']);
  assert.equal(calls.mail.sent.length, 0);
});

test('add: every record type has its own table, key and roles', async () => {
  const ids = { physical_samples: SAMPLE, manufacturing_operations: OPERATION, test_sessions: TEST, campaigns: CAMPAIGN, projects: PROJECT };
  const tablesOf = { physical_samples: 'sample_access', manufacturing_operations: 'operation_access', test_sessions: 'test_access', campaigns: 'campaign_access', projects: 'project_access' };
  const { handlers, db } = mount({ manage: () => true });
  for (const [collection, id] of Object.entries(ids)) {
    const role = collection === 'projects' ? 'investigator' : 'edit';
    const r = await call(handlers['POST /:collection/:id/entries'], { collection, id, body: { person_id: P.view, role } });
    assert.equal(r.status, 200, collection);
    assert.equal(r.body.entry.role, role);
    assert.equal(r.body.entry.label, role === 'investigator' ? 'Secondary investigator' : 'Can edit');
    assert.equal(db.tables()[tablesOf[collection]].length, 1, collection);
  }
  // each record type's upsert names the partial unique index of own rows (its own fk, person_id, WHERE team_access_id IS NULL)
  assert.deepEqual(db.log.compiled.map((c) => [c.table, c.target]), Object.entries(tablesOf).map(([collection, table]) => [table, `("${COLLECTIONS[collection].fk}", "person_id") WHERE "team_access_id" IS NULL`]));
  const mails = mount({ manage: () => true });
  const t = await call(mails.handlers['POST /:collection/:id/entries'], { collection: 'campaigns', id: CAMPAIGN, body: { person_id: P.nologin, role: 'view' } });
  assert.match(mails.calls.mail.sent[0].subject, /gave you access to campaign CMP-1/);
  assert.equal(t.body.email, 'sent');
});

// ---- the mail ---------------------------------------------------------------------------------------------------------

test('a MailService that throws on send or on construction still returns the change with email failed', async () => {
  for (const mail of [{ fail: true }, { throwOnConstruct: true }]) {
    const { handlers, db, warnings } = mount({ mail });
    const r = await add(handlers, { person_id: P.nologin, role: 'view' });
    assert.equal(r.status, 200, JSON.stringify(mail));
    assert.equal(r.body.email, 'failed');
    assert.equal(db.tables().sample_access.length, 1, 'the change stands');
    assert.equal(r.body.entry.person_id, P.nologin);
    assert.ok(warnings.some((w) => /d1-record-access: email for physical_samples/.test(w)));
  }
});

test('a MailService that hangs gives email failed after 10 s (fake timers), and the change stands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handlers, db } = mount({ mail: { hang: true } });
  const pending = add(handlers, { person_id: P.nologin, role: 'view' });
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(9_999);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  pending.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting at 9.999 s');
  t.mock.timers.tick(1);
  const r = await pending;
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'failed');
  assert.equal(db.tables().sample_access.length, 1);
});

test('withTimeout: resolves, rejects with the original error, times out, and a late rejection is not unhandled', async (t) => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50), /boom/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20_000));
  const raced = withTimeout(late, 10_000);
  t.mock.timers.tick(10_000);
  await assert.rejects(raced, /timed out after 10000 ms/);
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  t.mock.timers.tick(10_000); // the losing promise rejects now
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', listener);
  assert.deepEqual(unhandled, []);
});

test('the mail content: the adder, the role, the record and the link, every value HTML-escaped', () => {
  const m = mailContent({ adder: 'Olive <script>alert(1)</script> & Co', role: 'Can edit', kind: 'sample', code: 'SM-"001"', title: "Bar <b>A</b>", link: 'https://lab.example/admin/home/samples/abc?x=1&y=2' });
  assert.equal(m.subject, 'Olive <script>alert(1)</script> & Co gave you access to sample SM-"001"');
  assert.ok(!m.html.includes('<script>') && !m.html.includes('<b>'));
  for (const piece of ['Olive &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co', 'Can edit', 'SM-&quot;001&quot;', 'Bar &lt;b&gt;A&lt;/b&gt;', 'href="https://lab.example/admin/home/samples/abc?x=1&amp;y=2"']) {
    assert.ok(m.html.includes(piece), piece);
  }
  assert.ok(m.text.includes('Can edit') && m.text.includes('SM-"001"') && m.text.includes('https://lab.example/admin/home/samples/abc?x=1&y=2'));
  assert.ok(!/[\r\n]/.test(mailContent({ adder: 'A\r\nBcc: x@y', role: 'r', kind: 'sample', code: 'c\n', link: null }).subject));
  const t = mailContent({ adder: 'Olive', role: 'Owner', kind: 'project', code: 'PRJ1', link: 'https://x', transfer: true });
  assert.equal(t.subject, 'Olive made you the owner of project PRJ1');
  assert.notEqual(t.subject, mailContent({ adder: 'Olive', role: 'Owner', kind: 'project', code: 'PRJ1', link: 'https://x' }).subject);
  assert.match(t.html, /made you the owner of/);
  assert.equal(mailContent({}).subject, 'Someone gave you access to a record');
});

test('roleLabel and recordLink', () => {
  assert.equal(roleLabel('physical_samples', 'view'), 'Can view');
  assert.equal(roleLabel('physical_samples', 'edit'), 'Can edit');
  assert.equal(roleLabel('physical_samples', 'edit', 'co_owner'), 'Co-owner · can edit');
  assert.equal(roleLabel('projects', 'investigator', 'investigator'), 'Secondary investigator');
  assert.equal(recordLink('https://lab.example', 'samples_x', ID(1)), null);
  for (const name of ['constructor', '__proto__', 'toString']) assert.equal(recordLink('https://lab.example', name, ID(1)), null, name);
  assert.equal(recordLink('', 'physical_samples', SAMPLE), null, 'no PUBLIC_URL, no link');
  assert.equal(recordLink(undefined, 'physical_samples', SAMPLE), null);
  assert.equal(recordLink('https://lab.example/', 'physical_samples', SAMPLE), `https://lab.example/admin/home/samples/${SAMPLE}`);
  assert.equal(recordLink('https://lab.example//', 'projects', 'a b'), 'https://lab.example/admin/home/projects/a%20b');
  // STARbase wins when set; it serves the pages at its root
  assert.equal(recordLink('https://lab.example', 'physical_samples', SAMPLE, 'https://starbase.example/'), `https://starbase.example/samples/${SAMPLE}`);
  assert.equal(recordLink('', 'projects', 'a b', 'https://starbase.example'), 'https://starbase.example/projects/a%20b');
  assert.equal(recordLink('', 'samples_x', ID(1), 'https://starbase.example'), null);
});

test('the link map is the five STARbase page routes, and recordRoute\'s', () => {
  const index = readFileSync(new URL('../../../packages/starbase-pages/src/routes.ts', import.meta.url), 'utf8');
  const routes = Object.fromEntries([...index.matchAll(/path: '([a-z]+)\/:id', component: (\w+)Page/g)].map((m) => [m[2], m[1]]));
  delete routes.Team; // teams/:id is a page route too, but not a record page: no entry in the link map
  assert.deepEqual(routes, { Project: 'projects', Campaign: 'campaigns', Sample: 'samples', Operation: 'operations', Test: 'tests' });
  const byPage = { physical_samples: 'Sample', manufacturing_operations: 'Operation', test_sessions: 'Test', campaigns: 'Campaign', projects: 'Project' };
  assert.deepEqual(Object.keys(COLLECTIONS).sort(), Object.keys(byPage).sort());
  for (const [collection, page] of Object.entries(byPage)) assert.equal(COLLECTIONS[collection].segment, routes[page], collection);
  const kit = readFileSync(new URL('../../../packages/d1-ui/src/recordRoute.ts', import.meta.url), 'utf8');
  for (const [collection, cfg] of Object.entries(COLLECTIONS)) assert.ok(kit.includes(`${collection}: '/home/${cfg.segment}'`), collection);
});

// ---- change and remove -----------------------------------------------------------------------------------------------

test('PATCH: a role change converts an old-table entry in the same transaction and sends no mail', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.co });
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  const { handlers, db, calls } = mount({ tables: world });
  const patch = handlers['PATCH /:collection/:id/entries/:person_id'];
  const up = await call(patch, { params: { person_id: P.view }, body: { role: 'edit' } });
  assert.equal(up.status, 200);
  assert.equal(up.body.entry.role, 'edit');
  assert.equal(db.tables().sample_access.length, 1);
  const conv = await call(patch, { params: { person_id: P.co }, body: { role: 'view' } }); // a legacy co-owner downgraded: converted
  assert.equal(conv.status, 200);
  assert.deepEqual([conv.body.entry.role, conv.body.entry.source], ['view', 'access']);
  assert.deepEqual(db.tables().sample_co_owners, []);
  assert.equal(calls.mail.sent.length, 0);
  assert.equal(db.log.raw.length, 2, 'set_config once per write transaction');
  assert.equal((await call(patch, { params: { person_id: P.stranger }, body: { role: 'view' } })).status, 404, 'not on the list');
  assert.equal((await call(patch, { params: { person_id: ID(555) }, body: { role: 'view' } })).status, 404, 'no such person');
  assert.equal((await call(patch, { params: { person_id: P.view }, body: { role: 'investigator' } })).status, 400);
});

test('DELETE removes the access row and any old row, in one transaction', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.view });
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  const { handlers, db, calls } = mount({ tables: world });
  const del = handlers['DELETE /:collection/:id/entries/:person_id'];
  const r = await call(del, { params: { person_id: P.view } });
  assert.deepEqual([r.status, r.body], [200, { removed: true }]);
  assert.deepEqual([db.tables().sample_access, db.tables().sample_co_owners], [[], []]);
  assert.equal(calls.mail.sent.length, 0);
  assert.equal((await call(del, { params: { person_id: P.view } })).status, 404);
  // only a person with an old row (no access row): removed too
  world.project_investigators.push({ id: 5, project_id: PROJECT, user_id: U.view });
  const proj = mount({ tables: world, manage: () => true });
  assert.equal((await call(proj.handlers['DELETE /:collection/:id/entries/:person_id'], { collection: 'projects', id: PROJECT, params: { person_id: P.view } })).status, 200);
  assert.deepEqual(proj.db.tables().project_investigators, []);
  assert.equal((await call(del, { acc: as(U.view), params: { person_id: P.view } })).status, 403);
});

test('a failure part-way rolls the whole change back', async () => {
  const world = baseTables();
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.view });
  const { handlers, db, errors } = mount({ tables: world });
  const original = db.transaction;
  db.transaction = (fn) => original((trx) => fn(Object.assign((table) => {
    const q = trx(table);
    if (table === 'sample_co_owners') q.del = async () => { throw new Error('disk full'); };
    return q;
  }, { raw: trx.raw })));
  const r = await add(handlers, { person_id: P.view, role: 'view' });
  assert.equal(r.status, 500);
  assert.equal(errorOf(r).extensions.code, 'INTERNAL_SERVER_ERROR');
  assert.ok(!JSON.stringify(r.body).includes('disk full'), 'the cause stays in the log');
  assert.ok(errors.some((e) => /disk full/.test(e)));
  assert.deepEqual(db.tables().sample_access, []);
  assert.equal(db.tables().sample_co_owners.length, 1);
});

// ---- transfer ---------------------------------------------------------------------------------------------------------

const transfer = (h, personId, extra = {}) => call(h['POST /:collection/:id/transfer'], { body: { person_id: personId }, ...extra });

test('transfer: sets the owner, keeps the previous owner as Can edit, drops the new owner\'s rows, emails the new owner with its own subject', async () => {
  const world = baseTables();
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.view }, { id: 2, sample_id: SAMPLE, user_id: U.owner });
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.view });
  const { handlers, db, calls } = mount({ tables: world });
  const r = await transfer(handlers, P.view);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { owner: { person_id: P.view, name: 'Vic Viewer', can_sign_in: true }, email: 'sent', blocked_by: null });
  assert.equal(db.tables().physical_samples[0].owner_person_id, P.view);
  assert.deepEqual(db.tables().sample_access.map((x) => [x.person_id, x.role]), [[P.owner, 'edit']], 'the new owner has no row, the previous owner is Can edit');
  assert.deepEqual(db.tables().sample_co_owners, [], 'both old rows are gone');
  assert.equal(calls.mail.sent.length, 1);
  assert.equal(calls.mail.sent[0].to, 'vic@login.example');
  assert.equal(calls.mail.sent[0].subject, 'Olive Owner made you the owner of sample SM-001');
  assert.match(calls.mail.sent[0].text, /Owner/);
  assert.deepEqual(db.log.events, ['begin', 'commit']);
  assert.match(db.log.raw[0].sql, /d1\.actor_identity/);
  // the old owner is now an entry, the new one is the owner
  const got = await call(handlers['GET /:collection/:id'], { acc: as(U.view) });
  assert.equal(got.body.owner.name, 'Vic Viewer');
  assert.deepEqual(got.body.entries.map((e) => [e.name, e.role]), [['Olive Owner', 'edit']]);
});

test('transfer on a project keeps the previous PI as a Secondary investigator, and the PI is the owner column', async () => {
  const world = baseTables();
  world.project_investigators.push({ id: 1, project_id: PROJECT, user_id: U.pi });
  const { handlers, db, calls } = mount({ tables: world, manage: () => true });
  const r = await transfer(handlers, P.view, { collection: 'projects', id: PROJECT, acc: as(U.pi) });
  assert.equal(r.status, 200);
  assert.equal(db.tables().projects[0].principal_investigator_person, P.view);
  assert.deepEqual(db.tables().project_access.map((x) => [x.person_id, x.role]), [[P.pi, 'investigator']]);
  assert.deepEqual(db.tables().project_investigators, []);
  assert.match(calls.mail.sent[0].text, /Principal investigator/);
  assert.match(calls.mail.sent[0].subject, /made you the owner of project PRJ1/);
});

test('transfer: to the current owner is a 409; an unknown, inactive person is a 400; a non-manager gets 403; a failed mail does not undo it', async () => {
  const { handlers, db } = mount();
  assert.equal((await transfer(handlers, P.owner)).status, 409);
  assert.equal((await transfer(handlers, ID(777))).status, 400);
  assert.equal((await transfer(handlers, P.inactive)).status, 400);
  assert.equal((await transfer(handlers, P.view, { acc: as(U.co) })).status, 403);
  assert.equal(db.tables().physical_samples[0].owner_person_id, P.owner);
  const failing = mount({ mail: { fail: true } });
  const r = await transfer(failing.handlers, P.nologin);
  assert.deepEqual([r.status, r.body.email], [200, 'failed']);
  assert.equal(failing.db.tables().physical_samples[0].owner_person_id, P.nologin);
  const mute = mount();
  assert.equal((await transfer(mute.handlers, P.nomail)).body.email, 'skipped');
});

test('transfer of an ownerless record by an admin has no previous owner to keep', async () => {
  const world = baseTables();
  world.physical_samples[0].owner_person_id = null;
  const { handlers, db } = mount({ tables: world, manage: () => false });
  assert.equal((await transfer(handlers, P.view, { acc: owner })).status, 403);
  const r = await transfer(handlers, P.view, { acc: admin });
  assert.equal(r.status, 200);
  assert.deepEqual(db.tables().sample_access, []);
  assert.equal(db.tables().physical_samples[0].owner_person_id, P.view);
});

// ---- the data cache ---------------------------------------------------------------------------------------------------

test('the data cache is cleared after a change when caching is on, and not when it is off', async () => {
  const on = mount({ env: { PUBLIC_URL: 'https://lab.example', CACHE_ENABLED: true } });
  await add(on.handlers, { person_id: P.view, role: 'view' });
  assert.equal(on.calls.cache.length, 1);
  assert.deepEqual(on.calls.cache[0].args, { system: false });
  assert.equal(on.calls.cache[0].accountability.admin, true, 'UtilsService.clearCache wants admin accountability');
  assert.deepEqual(on.calls.cache[0].events, ['begin', 'commit'], 'after the commit');
  await on.handlers['PATCH /:collection/:id/entries/:person_id']({ accountability: owner, params: { collection: 'physical_samples', id: SAMPLE, person_id: P.view }, body: { role: 'edit' }, schema: 'S' }, { status: () => ({ json() {} }), json() {} });
  await transfer(on.handlers, P.nologin);
  assert.ok(on.calls.cache.length >= 2);
  const off = mount({ env: { PUBLIC_URL: 'https://lab.example', CACHE_ENABLED: false } });
  await add(off.handlers, { person_id: P.view, role: 'view' });
  assert.equal(off.calls.cache.length, 0);
});

test('a failing cache clear never fails the change', async () => {
  const world = baseTables();
  const db = makeDb(world);
  const handlers = {};
  const router = ['get', 'post', 'patch', 'delete'].reduce((r, m) => ({ ...r, [m]: (path, fn) => (handlers[`${m.toUpperCase()} ${path}`] = fn) }), {});
  const warnings = [];
  class ItemsService {
    constructor(collection) { this.collection = collection; }
    async readOne(id) { return { id }; }
    async readByQuery() { return [{ x: 1 }]; }
  }
  ext.handler(router, {
    database: db, logger: { sink: warnings, warn(m) { this.sink.push(m); }, error() {} },
    services: { ItemsService, MailService: class { constructor() { throw new Error('no mail'); } }, UtilsService: class { async clearCache() { throw new Error('redis down'); } } },
    env: { PUBLIC_URL: 'https://x', CACHE_ENABLED: true },
  });
  const r = await call(handlers['POST /:collection/:id/entries'], { body: { person_id: P.nologin, role: 'view' } });
  assert.equal(r.status, 200);
  assert.ok(warnings.some((w) => /could not clear the data cache: redis down/.test(w)));
});

// ---- review fix round 1 ---------------------------------------------------------------------------------------

test('the manage check runs INSIDE the write transaction, on its connection, on every write route', async () => {
  const world = baseTables();
  world.sample_access.push({ access_id: 'a1', sample_id: SAMPLE, person_id: P.view, role: 'view', added_by_person_id: P.owner, created_at: new Date() });
  const { handlers, calls, db } = mount({ tables: world });
  await add(handlers, { person_id: P.nologin, role: 'view' });
  await call(handlers['PATCH /:collection/:id/entries/:person_id'], { params: { person_id: P.view }, body: { role: 'edit' } });
  await call(handlers['DELETE /:collection/:id/entries/:person_id'], { params: { person_id: P.view } });
  await transfer(handlers, P.nologin);
  const writes = calls.manage.filter((m) => m.user === U.owner);
  assert.equal(writes.length, 4);
  for (const m of writes) {
    assert.equal(m.knex?.isTransaction, true, 'ItemsService got the transaction');
    assert.equal(m.events.at(-1), 'begin', 'asked after the transaction began, before it ended');
  }
  // a refused manage check rolls the transaction back without a write
  const refused = await add(handlers, { person_id: P.view, role: 'view' }, { acc: as(U.view) });
  assert.equal(refused.status, 403);
  assert.deepEqual(db.log.events.slice(-2), ['begin', 'rollback']);
  assert.ok(db.log.writes.filter((w) => w.inTrx).every((w) => w.op !== 'insert' || w.row.person_id !== P.view));
});

test('a manage check that fails inside the transaction (ownership changed meanwhile) writes nothing', async () => {
  let owner = U.owner;
  const { handlers, db, calls } = mount({ manage: (c, id, user) => user === owner });
  owner = U.view; // the transfer committed between the request arriving and the write
  const r = await add(handlers, { person_id: P.nologin, role: 'view' });
  assert.equal(r.status, 403);
  assert.deepEqual(db.tables().sample_access, []);
  assert.equal(calls.mail.sent.length, 0);
});

test('a person who cannot read the record yet is mailed the generic wording: no title, no link, nothing of any parent', async () => {
  const world = baseTables();
  world.projects[0].restricted = true;
  world.project_readers.push({ record_id: PROJECT, user_id: U.owner }); // the caller can read the project, so the response may name it
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.co });
  const { handlers, calls } = mount({ tables: world });
  const blocked = await add(handlers, { person_id: P.view, role: 'view' }); // vic: a login, not in the sample's readers
  assert.equal(blocked.body.email, 'sent');
  assert.ok(blocked.body.entry.blocked_by, 'the list says so too');
  const m = calls.mail.sent[0];
  assert.equal(m.to, 'vic@login.example');
  assert.match(m.subject, /Olive Owner gave you access to sample SM-001/);
  for (const body of [m.text, m.html]) {
    assert.ok(body.includes('SM-001'), 'the kind and code of the record are there');
    assert.ok(body.includes('Olive Owner'), 'and who added them');
    assert.ok(/You cannot open it yet/.test(body));
    assert.ok(!body.includes('Bar A'), 'no title');
    assert.ok(!body.includes('lab.example'), 'no link');
    assert.ok(!/restricted|PRJ1|Project One|Pia/.test(body), 'nothing of the parent');
  }
  assert.ok(!m.html.includes('<a '));
  // a person in the record's own readers gets the ordinary mail with the title and the link
  const listed = await add(handlers, { person_id: P.co, role: 'view' });
  assert.equal(listed.body.entry.blocked_by, null);
  assert.ok(calls.mail.sent[1].text.includes('Bar A') && calls.mail.sent[1].text.includes('https://lab.example/admin/home/samples/'));
  // a person with no login is blocked too, with its own wording
  const nologin = await add(handlers, { person_id: P.nologin, role: 'view' });
  assert.equal(nologin.body.email, 'sent');
  assert.deepEqual(nologin.body.entry.blocked_by, { reason: 'no_login', ...NONE });
  assert.ok(!calls.mail.sent[2].text.includes('Bar A') && !calls.mail.sent[2].text.includes('lab.example'));
  assert.match(calls.mail.sent[2].text, /once you have a D1 login/);
});

test('a transfer returns blocked_by of the new owner (null when they can read it) and mails the generic wording to a blocked one', async () => {
  const world = baseTables();
  world.campaigns[0].restricted = true;
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.owner });
  world.campaign_readers.push({ record_id: CAMPAIGN, user_id: U.owner });
  const { handlers, calls } = mount({ tables: world });
  const r = await call(handlers['POST /:collection/:id/transfer'], { collection: 'manufacturing_operations', id: OPERATION, body: { person_id: P.view } });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'sent');
  assert.deepEqual(r.body.blocked_by, { reason: 'parent', collection: 'physical_samples', id: SAMPLE, kind: 'sample', code: 'SM-001' });
  const m = calls.mail.sent[0];
  assert.equal(m.subject, 'Olive Owner made you the owner of operation SM-001-F1');
  assert.ok(/You cannot open it yet/.test(m.text) && !m.text.includes('lab.example') && !/campaign/i.test(m.text));
  // the new owner is in the record's readers (the owner path): not blocked, ordinary mail
  const ok = baseTables();
  ok.operation_readers.push({ record_id: OPERATION, user_id: U.view });
  const fine = mount({ tables: ok });
  const r2 = await call(fine.handlers['POST /:collection/:id/transfer'], { collection: 'manufacturing_operations', id: OPERATION, body: { person_id: P.view } });
  assert.equal(r2.body.blocked_by, null);
  assert.ok(fine.calls.mail.sent[0].text.includes('lab.example'));
  // a transfer to a person with no login says so
  const none = await call(fine.handlers['POST /:collection/:id/transfer'], { collection: 'test_sessions', id: TEST, body: { person_id: P.nologin } });
  assert.deepEqual(none.body.blocked_by, { reason: 'no_login', ...NONE });
});

test('mailContent: blockedReason drops the title and the link even when they are passed', () => {
  for (const blockedReason of ['parent', 'no_login']) {
    const m = mailContent({ adder: 'Olive', role: 'Can view', kind: 'sample', code: 'SM-1', title: 'Secret bar', link: 'https://x/y', blockedReason });
    assert.ok(!m.text.includes('Secret bar') && !m.html.includes('Secret bar') && !m.text.includes('https://x') && !m.html.includes('https://x'));
  }
  assert.ok(mailContent({ adder: 'Olive', role: 'Can view', kind: 'sample', code: 'SM-1', blockedReason: 'parent' }).text.includes('You cannot open it yet.'));
  assert.ok(mailContent({ adder: 'Olive', role: 'Can view', kind: 'sample', code: 'SM-1', blockedReason: 'no_login' }).text.includes('D1 login'));
  assert.ok(mailContent({ adder: 'Olive', role: 'Can view', kind: 'sample', code: 'SM-1', title: 'Bar', link: 'https://x/y' }).text.includes('https://x/y'));
});

test('without PUBLIC_URL: one warning at startup, and the mail carries no link', async () => {
  const noUrl = baseTables();
  noUrl.sample_readers.push({ record_id: SAMPLE, user_id: U.co });
  const none = mount({ env: {}, tables: noUrl });
  assert.equal(none.warnings.filter((w) => /STARBASE_URL nor PUBLIC_URL is set/.test(w)).length, 1);
  const r = await add(none.handlers, { person_id: P.co, role: 'view' });
  assert.equal(r.body.email, 'sent');
  assert.ok(!/admin\/home/.test(none.calls.mail.sent[0].text) && !none.calls.mail.sent[0].html.includes('<a '));
  assert.ok(none.calls.mail.sent[0].text.includes('Bar A'));
  assert.equal(none.warnings.filter((w) => /PUBLIC_URL/.test(w)).length, 1, 'still just the one');
  assert.equal(mount().warnings.filter((w) => /PUBLIC_URL/.test(w)).length, 0);
});

test('a read-back that fails after the commit still answers 200 with the committed change, and logs it', async () => {
  const { handlers, db, errors, calls } = mount();
  const original = db.transaction;
  db.transaction = async (fn) => {
    const out = await original(fn);
    db.breakReads(); // the connection drops right after the commit
    return out;
  };
  const r = await add(handlers, { person_id: P.nologin, role: 'view' });
  assert.equal(r.status, 200);
  assert.equal(r.body.entry, null);
  assert.equal(r.body.email, 'failed', 'the mail lookups need the database too, and a failure there is only a failed mail');
  assert.equal(db.tables().sample_access.length, 1, 'the change is committed');
  assert.ok(errors.some((e) => /committed but reading it back failed/.test(e)));
  assert.equal(calls.mail.sent.length, 0);
});

// ---- teams in who-has-access (migration 182) -------------------------------------------------------------------------

// What the database does for the team functions, in the in-memory world: team_pending_actionable answers `actionable(ta, person)`;
// team_decide approves (the pending row goes, a derived row appears) or declines (the row stays, declined). Every call is recorded.
function teamHook({ actionable = () => true, decideError = null } = {}) {
  const seen = [];
  const hook = (sql, bindings, target) => {
    if (/team_pending_actionable|team_decide/.test(sql)) seen.push({ sql, bindings }); // not the actor's set_config
    if (/team_pending_actionable/.test(sql)) return { rows: [{ ok: actionable(bindings[1], bindings[2]) }] };
    if (/team_decide/.test(sql)) {
      if (decideError) throw decideError;
      const [collection, ta, person, decision] = bindings;
      const cfg = COLLECTIONS[collection];
      const pending = (target.tables[`${cfg.kind}_team_pending`] ??= []);
      const row = pending.find((r) => r.team_access_id === ta && r.person_id === person);
      const grant = target.tables[`${cfg.kind}_team_access`].find((g) => g.team_access_id === ta);
      if (decision === 'approve') {
        pending.splice(pending.indexOf(row), 1);
        target.tables[cfg.table].push({ access_id: `d-${person}`, [cfg.fk]: grant[cfg.fk], person_id: person, role: grant.role, added_by_person_id: grant.added_by_person_id, team_access_id: ta, created_at: new Date() });
      } else row.state = 'declined';
    }
    return { rows: [] };
  };
  hook.seen = seen;
  return hook;
}

const TA = 'ta-alpha';
const TB = 'ta-beta';
const sampleGrant = (extra = {}) => ({ team_access_id: TA, sample_id: SAMPLE, team_id: T.alpha, role: 'view', trust_new_members: false, added_by_person_id: P.owner, created_at: new Date(), ...extra });
const derived = (person_id, role = 'view', ta = TA) => ({ access_id: `d-${ta}-${person_id}`, sample_id: SAMPLE, person_id, role, added_by_person_id: P.owner, team_access_id: ta, created_at: new Date() });
const own = (person_id, role = 'view') => ({ access_id: `o-${person_id}`, sample_id: SAMPLE, person_id, role, added_by_person_id: P.owner, team_access_id: null, created_at: new Date('2026-10-01T10:00:00Z') });
const teamRoute = (m, suffix = '') => `${m} /:collection/:id/entries/team/:team_id${suffix}`;

test('GET: the teams of the record (counts, role, trust, waiting = worth asking about, declined), and derived rows are not person entries', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant({ trust_new_members: false }), sampleGrant({ team_access_id: TB, team_id: T.beta, role: 'edit', trust_new_members: true }));
  world.sample_access.push(own(P.co, 'view'), derived(P.view), derived(P.owner), derived(P.co, 'edit', TB));
  world.sample_team_pending.push(
    { team_access_id: TA, person_id: P.stranger, state: 'pending' }, { team_access_id: TA, person_id: P.nologin, state: 'pending' },
    { team_access_id: TA, person_id: P.badlogin, state: 'declined' }, { team_access_id: TA, person_id: P.inactive, state: 'declined' },
  );
  const hook = teamHook({ actionable: (ta, person) => person !== P.nologin }); // not worth asking about
  const { handlers } = mount({ tables: world, raw: hook });
  const r = await call(handlers['GET /:collection/:id']);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.teams, [
    { team_access_id: TA, team_id: T.alpha, name: 'Alpha lab', color: 'blue', logo: null, member_count: 7, role: 'view', trust_new_members: false, waiting: 1, declined: 2 },
    { team_access_id: TB, team_id: T.beta, name: 'Beta crew', color: 'green', logo: ID(400), member_count: 1, role: 'edit', trust_new_members: true, waiting: 0, declined: 0 },
  ]);
  // the person entries: the own row of Cory only; the derived rows of Vic, Olive (the owner) and Cory (Beta) are not entries
  assert.deepEqual(r.body.entries.map((e) => [e.name, e.role, e.source]), [['Cory Coowner', 'view', 'access']]);
  assert.ok(hook.seen.every((c) => /team_pending_actionable/.test(c.sql)), 'only pending rows were asked about');
  assert.deepEqual(hook.seen.map((c) => c.bindings), [['physical_samples', TA, P.stranger], ['physical_samples', TA, P.nologin]]);
  // a record with no team grant: an empty list
  assert.deepEqual((await call(handlers['GET /:collection/:id'], { collection: 'campaigns', id: CAMPAIGN })).body.teams, []);
});

test('GET: a person with an own row AND a derived row is one entry, with the own role', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant({ role: 'edit' }));
  world.sample_access.push(derived(P.view, 'edit'), own(P.view, 'view'));
  const { handlers } = mount({ tables: world, raw: teamHook() });
  const entries = (await call(handlers['GET /:collection/:id'])).body.entries;
  assert.deepEqual(entries.map((e) => [e.name, e.role]), [['Vic Viewer', 'view']]);
});

test('add team: inserts the grant, mails each ACTIVE member with a login and an address (not the adder, not those waiting), "via <team>"', async () => {
  const world = baseTables();
  world.sample_team_pending.push({ team_access_id: 'ta-1', person_id: P.stranger, state: 'pending' }); // waits on this grant: not mailed
  const { handlers, db, calls } = mount({ tables: world, raw: teamHook() });
  const r = await add(handlers, { team_id: T.alpha, role: 'edit' });
  assert.equal(r.status, 200);
  assert.deepEqual(db.tables().sample_team_access.map((g) => [g.sample_id, g.team_id, g.role, g.added_by_person_id]), [[SAMPLE, T.alpha, 'edit', P.owner]]);
  assert.equal(db.tables().sample_access.length, 0, 'the derived rows are the database\'s (triggers), the endpoint writes only the grant');
  assert.equal(r.body.team.name, 'Alpha lab');
  assert.equal(r.body.team.role, 'edit');
  // members: owner (the adder), view, co, badlogin (login without address), nologin, inactive, stranger (waiting)
  assert.deepEqual(calls.mail.sent.map((m) => m.to).sort(), ['co@login.example', 'vic@login.example']);
  for (const m of calls.mail.sent) {
    assert.match(m.subject, /Olive Owner gave you access to sample SM-001 via Alpha lab/);
    assert.match(m.text, /via Alpha lab/);
    assert.match(m.html, /via Alpha lab/);
    assert.match(m.text, /Your role: Can edit/);
  }
  assert.deepEqual(r.body.emails, { sent: 2, skipped: 2, failed: 0 });
  assert.equal(r.body.email, 'sent');
  assert.deepEqual(db.log.events, ['begin', 'commit']);
  assert.match(db.log.raw[0].sql, /d1\.actor_identity/);
  assert.ok(calls.mail.sent.every((m) => m.to !== 'olive@people.example' && m.to !== 'owner@login.example'), 'never the adder');
});

test('add team: a team with nobody to mail, and a failing mail, both leave the grant standing', async () => {
  const none = mount({ raw: teamHook() });
  const r = await add(none.handlers, { team_id: T.empty, role: 'view' });
  assert.deepEqual([r.status, r.body.email, r.body.emails], [200, 'skipped', { sent: 0, skipped: 0, failed: 0 }]);
  assert.equal(none.db.tables().sample_team_access.length, 1);
  const failing = mount({ mail: { fail: true }, raw: teamHook() });
  const f = await add(failing.handlers, { team_id: T.alpha, role: 'view' });
  assert.equal(f.status, 200);
  assert.equal(f.body.email, 'failed');
  assert.equal(f.body.emails.failed, 3, 'Vic, Cory and Sam (nobody waits on this grant)');
  assert.equal(failing.db.tables().sample_team_access.length, 1, 'mail never undoes a change');
  assert.ok(failing.warnings.some((w) => /email for physical_samples/.test(w)));
});

test('add team: a member who cannot read the record yet is mailed the generic wording (no title, no link)', async () => {
  const world = baseTables();
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.co }); // Cory reads it already, Vic does not
  const { handlers, calls } = mount({ tables: world, raw: teamHook() });
  await add(handlers, { team_id: T.alpha, role: 'view' });
  const to = Object.fromEntries(calls.mail.sent.map((m) => [m.to, m]));
  assert.ok(to['co@login.example'].text.includes('Bar A') && to['co@login.example'].text.includes('lab.example'));
  assert.ok(!to['vic@login.example'].text.includes('Bar A') && !to['vic@login.example'].text.includes('lab.example'));
  assert.match(to['vic@login.example'].text, /via Alpha lab/);
});

test('add team: a duplicate is 409 TEAM_ALREADY_LISTED, also when two owners add it at once; unknown team, bad ids, bad role: 400; a non-manager: 403', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  const { handlers, db, calls } = mount({ tables: world, raw: teamHook() });
  const dup = await add(handlers, { team_id: T.alpha, role: 'view' });
  assert.equal(dup.status, 409);
  assert.equal(errorOf(dup).extensions.code, 'TEAM_ALREADY_LISTED');
  assert.equal(errorOf(dup).extensions.source, 'd1-record-access');
  // the race: the pre-check saw nothing, the unique key refuses
  const racing = mount({ raw: teamHook() });
  const original = racing.db.transaction;
  racing.db.transaction = (fn) => original((trx) => fn(Object.assign((table) => {
    const q = trx(table);
    if (table === 'sample_team_access') q.insert = () => Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' }));
    return q;
  }, { raw: trx.raw })));
  const race = await add(racing.handlers, { team_id: T.alpha, role: 'view' });
  assert.deepEqual([race.status, errorOf(race).extensions.code], [409, 'TEAM_ALREADY_LISTED']);
  for (const body of [{ team_id: ID(777), role: 'view' }, { team_id: 'nope', role: 'view' }, { team_id: T.beta }, { team_id: T.beta, role: 'investigator' }, { team_id: T.beta, role: 'admin' }]) {
    assert.equal((await add(handlers, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await add(handlers, { team_id: T.beta, role: 'view' }, { acc: as(U.view) })).status, 403);
  assert.equal(db.tables().sample_team_access.length, 1, 'nothing was added');
  assert.equal(calls.mail.sent.length, 0);
  // a project takes investigator, not edit
  const proj = await call(handlers['POST /:collection/:id/entries'], { collection: 'projects', id: PROJECT, acc: as(U.pi), body: { team_id: T.beta, role: 'investigator' } });
  assert.equal(proj.status, 200);
  assert.equal(db.tables().project_team_access[0].role, 'investigator');
  assert.equal((await call(handlers['POST /:collection/:id/entries'], { collection: 'projects', id: PROJECT, acc: as(U.pi), body: { team_id: T.empty, role: 'edit' } })).status, 400);
});

test('PATCH team: role and trust_new_members change the grant (the triggers move the rows); bad input, unknown grant, non-manager', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  const { handlers, db, calls } = mount({ tables: world, raw: teamHook() });
  const patch = handlers[teamRoute('PATCH')];
  const params = { team_id: T.alpha };
  const role = await call(patch, { params, body: { role: 'edit' } });
  assert.equal(role.status, 200);
  assert.deepEqual([role.body.team.role, role.body.team.trust_new_members], ['edit', false]);
  const trust = await call(patch, { params, body: { trust_new_members: true } });
  assert.deepEqual([trust.body.team.role, trust.body.team.trust_new_members], ['edit', true]);
  const both = await call(patch, { params, body: { role: 'view', trust_new_members: false } });
  assert.deepEqual([both.body.team.role, both.body.team.trust_new_members], ['view', false]);
  assert.equal(db.log.writes.filter((w) => w.table === 'sample_team_access' && w.op === 'update').length, 3);
  assert.equal(db.tables().sample_access.length, 0, 'no derived row is touched by hand');
  for (const body of [undefined, {}, { role: 'investigator' }, { trust_new_members: 'yes' }, { role: 5 }]) assert.equal((await call(patch, { params, body })).status, 400, JSON.stringify(body));
  assert.equal((await call(patch, { params: { team_id: 'nope' }, body: { role: 'edit' } })).status, 400);
  assert.equal((await call(patch, { params: { team_id: T.beta }, body: { role: 'edit' } })).status, 404, 'that team is not on the record');
  assert.equal((await call(patch, { params, acc: as(U.view), body: { role: 'edit' } })).status, 403);
  assert.equal(calls.mail.sent.length, 0);
});

test('DELETE team: removes the grant only (the derived and pending rows go with it in the database); 404 when not listed; 403 for a non-manager', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant(), sampleGrant({ team_access_id: TB, team_id: T.beta }));
  const { handlers, db } = mount({ tables: world, raw: teamHook() });
  const del = handlers[teamRoute('DELETE')];
  assert.equal((await call(del, { params: { team_id: T.alpha }, acc: as(U.view) })).status, 403);
  const r = await call(del, { params: { team_id: T.alpha } });
  assert.deepEqual([r.status, r.body], [200, { removed: true }]);
  assert.deepEqual(db.tables().sample_team_access.map((g) => g.team_id), [T.beta]);
  assert.equal((await call(del, { params: { team_id: T.alpha } })).status, 404);
  assert.equal((await call(del, { params: { team_id: 'x' } })).status, 400);
  assert.deepEqual(db.log.events.slice(-2), ['begin', 'rollback']);
});

test('GET members: active (derived rows), pending (with whether it is worth asking) and declined; readers may look, an unlisted team is 404', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_access.push(derived(P.view), derived(P.co), own(P.nologin), derived(P.owner, 'view', TB));
  world.sample_team_pending.push(
    { team_access_id: TA, person_id: P.stranger, state: 'pending', decided_at: null }, { team_access_id: TA, person_id: P.badlogin, state: 'pending', decided_at: null },
    { team_access_id: TA, person_id: P.inactive, state: 'declined', decided_at: new Date('2026-10-14T08:00:00Z') },
  );
  const { handlers } = mount({ tables: world, raw: teamHook({ actionable: (ta, person) => person === P.stranger }) });
  const get = handlers[teamRoute('GET', '/members')];
  const r = await call(get, { params: { team_id: T.alpha }, acc: as(U.view) }); // a plain reader
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.active, [
    { person_id: P.co, name: 'Cory Coowner', can_sign_in: true }, { person_id: P.view, name: 'Vic Viewer', can_sign_in: true },
  ]);
  assert.deepEqual(r.body.pending, [
    { person_id: P.badlogin, name: 'Bo Badlogin', can_sign_in: true, actionable: false }, { person_id: P.stranger, name: 'Sam Stranger', can_sign_in: true, actionable: true },
  ]);
  assert.deepEqual(r.body.declined, [{ person_id: P.inactive, name: 'Ian Inactive', can_sign_in: false, decided_at: '2026-10-14T08:00:00.000Z' }]);
  assert.equal((await call(get, { params: { team_id: T.beta } })).status, 404);
  assert.equal((await call(get, { params: { team_id: 'x' } })).status, 400);
  // a record the caller cannot read stays a 404 (nothing about it)
  const hidden = mount({ tables: world, raw: teamHook(), readable: () => false });
  assert.equal((await call(hidden.handlers[teamRoute('GET', '/members')], { params: { team_id: T.alpha } })).status, 404);
});

const decideRoute = teamRoute('POST', '/members/:person_id');
const decide = (h, personId, body, extra = {}) => call(h[decideRoute], { params: { team_id: T.alpha, person_id: personId }, body, ...extra });

test('decide: approve runs team_decide as the manager, the joiner gets the derived row and one mail "via <team>"; decline mails nobody', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant({ role: 'edit' }));
  world.sample_team_pending.push({ team_access_id: TA, person_id: P.view, state: 'pending' }, { team_access_id: TA, person_id: P.co, state: 'pending' });
  const hook = teamHook();
  const { handlers, db, calls } = mount({ tables: world, raw: hook });
  const ok = await decide(handlers, P.view, { decision: 'approve' });
  assert.deepEqual([ok.status, ok.body], [200, { decision: 'approve', email: 'sent' }]);
  assert.deepEqual(hook.seen.map((c) => c.bindings), [['physical_samples', TA, P.view, 'approve']]);
  assert.match(hook.seen[0].sql, /d1_private\.team_decide/);
  assert.deepEqual(db.log.events, ['begin', 'commit']);
  assert.match(db.log.raw[0].sql, /d1\.actor_identity/, 'the actor first, so team_decide names the caller');
  assert.ok(db.tables().sample_access.some((r) => r.person_id === P.view && r.team_access_id === TA && r.role === 'edit'));
  assert.deepEqual(db.tables().sample_team_pending.map((p) => p.person_id), [P.co]);
  assert.equal(calls.mail.sent.length, 1);
  assert.equal(calls.mail.sent[0].to, 'vic@login.example');
  assert.match(calls.mail.sent[0].subject, /gave you access to sample SM-001 via Alpha lab/);
  assert.match(calls.mail.sent[0].text, /Your role: Can edit/);
  const no = await decide(handlers, P.co, { decision: 'decline' });
  assert.deepEqual([no.status, no.body], [200, { decision: 'decline', email: 'skipped' }]);
  assert.equal(db.tables().sample_team_pending[0].state, 'declined');
  assert.equal(calls.mail.sent.length, 1, 'no mail for a decline');
  // a declined member can still be approved later
  const later = await decide(handlers, P.co, { decision: 'approve' });
  assert.equal(later.status, 200);
  assert.equal(calls.mail.sent.length, 2);
});

test('decide: a failing mail leaves the approval standing; the approver is never mailed', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_team_pending.push({ team_access_id: TA, person_id: P.view, state: 'pending' }, { team_access_id: TA, person_id: P.owner, state: 'pending' });
  const failing = mount({ tables: world, raw: teamHook(), mail: { fail: true } });
  const r = await decide(failing.handlers, P.view, { decision: 'approve' });
  assert.deepEqual([r.status, r.body.email], [200, 'failed']);
  assert.ok(failing.db.tables().sample_access.some((x) => x.person_id === P.view && x.team_access_id === TA));
  const self = await decide(failing.handlers, P.owner, { decision: 'approve' }); // the manager is the joiner
  assert.equal(self.body.email, 'skipped');
});

test('decide: only a manager of the record (403, nothing run), 409 when nothing waits, P0002 from the function is 409 too, 400 on bad input, 404 unlisted team', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_team_pending.push({ team_access_id: TA, person_id: P.view, state: 'pending' });
  const hook = teamHook();
  const { handlers, db } = mount({ tables: world, raw: hook });
  assert.equal((await decide(handlers, P.view, { decision: 'approve' }, { acc: as(U.co) })).status, 403);
  assert.equal(hook.seen.length, 0, 'team_decide never ran');
  assert.deepEqual(db.log.events.slice(-2), ['begin', 'rollback']);
  assert.equal((await decide(handlers, P.view, { decision: 'approve' }, { acc: admin })).status, 200, 'an admin may');
  const again = await decide(handlers, P.view, { decision: 'approve' });
  assert.equal(again.status, 409);
  assert.equal(errorOf(again).extensions.code, 'NOTHING_TO_DECIDE');
  assert.equal((await decide(handlers, P.stranger, { decision: 'decline' })).status, 409);
  for (const body of [undefined, {}, { decision: 'maybe' }, { decision: 'APPROVE' }]) assert.equal((await decide(handlers, P.view, body)).status, 400, JSON.stringify(body));
  assert.equal((await decide(handlers, 'nope', { decision: 'approve' })).status, 400);
  assert.equal((await call(handlers[decideRoute], { params: { team_id: T.beta, person_id: P.view }, body: { decision: 'approve' } })).status, 404);
  const raced = baseTables();
  raced.sample_team_access.push(sampleGrant());
  raced.sample_team_pending.push({ team_access_id: TA, person_id: P.view, state: 'pending' });
  const p0002 = mount({ tables: raced, raw: teamHook({ decideError: Object.assign(new Error('Nothing to decide'), { code: 'P0002' }) }) });
  const lost = await decide(p0002.handlers, P.view, { decision: 'approve' });
  assert.deepEqual([lost.status, errorOf(lost).extensions.code], [409, 'NOTHING_TO_DECIDE']);
  assert.equal(p0002.calls.mail.sent.length, 0);
});

// ---- the person flows next to derived rows (the must-fix: a person's own flows touch only team_access_id IS NULL) ----

const derivedOf = (db, ta = TA) => db.tables().sample_access.filter((r) => r.team_access_id === ta);

test('person POST: the upsert names the partial unique index of own rows, so a person who also has a derived row gets an own row and the derived row is untouched', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_access.push(derived(P.view, 'view'));
  world.sample_co_owners.push({ id: 1, sample_id: SAMPLE, user_id: U.view });
  const { handlers, db } = mount({ tables: world, raw: teamHook() });
  const r = await add(handlers, { person_id: P.view, role: 'edit' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'skipped', 'the legacy co-owner row made this not a new grant');
  assert.deepEqual(db.tables().sample_access.map((x) => [x.person_id, x.role, x.team_access_id ?? null]), [[P.view, 'view', TA], [P.view, 'edit', null]]);
  assert.deepEqual(db.tables().sample_co_owners, [], 'the old row still goes (dropLegacy)');
  assert.deepEqual(r.body.entry && [r.body.entry.role, r.body.entry.source], ['edit', 'access']);
  // a second add updates the own row in place
  await add(handlers, { person_id: P.view, role: 'view' });
  assert.deepEqual(db.tables().sample_access.map((x) => [x.role, x.team_access_id ?? null]), [['view', TA], ['view', null]]);
  // and the SQL is ON CONFLICT (fk, person_id) WHERE team_access_id IS NULL
  assert.equal(db.log.compiled[0].table, 'sample_access');
  assert.equal(db.log.compiled[0].target, '("sample_id", "person_id") WHERE "team_access_id" IS NULL');
  assert.equal(db.log.compiled[0].patch.role, 'edit');
});

test('person POST: a team member with only a derived row is a new grant: mailed, and an own row is added', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_access.push(derived(P.view, 'view'));
  const { handlers, db, calls } = mount({ tables: world, raw: teamHook() });
  const r = await add(handlers, { person_id: P.view, role: 'view' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'sent', 'a derived row is not an entry of their own');
  assert.equal(calls.mail.sent.length, 1);
  assert.equal(db.tables().sample_access.filter((x) => x.person_id === P.view).length, 2);
});

test('person PATCH: changes the own row only; a person who only has a derived row is not on the list (404)', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_access.push(derived(P.view, 'view'), own(P.view, 'view'), derived(P.co, 'view'));
  const { handlers, db } = mount({ tables: world, raw: teamHook() });
  const patch = handlers['PATCH /:collection/:id/entries/:person_id'];
  const r = await call(patch, { params: { person_id: P.view }, body: { role: 'edit' } });
  assert.equal(r.status, 200);
  assert.deepEqual(db.tables().sample_access.filter((x) => x.person_id === P.view).map((x) => [x.role, x.team_access_id ?? null]), [['view', TA], ['edit', null]]);
  assert.equal((await call(patch, { params: { person_id: P.co }, body: { role: 'edit' } })).status, 404, 'Cory is only on the list through a team');
  assert.deepEqual(derivedOf(db).map((x) => [x.person_id, x.role]), [[P.view, 'view'], [P.co, 'view']]);
});

test('person DELETE: removes the own row and leaves every derived row (the guard would refuse them); a derived-only person is a 404', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant(), sampleGrant({ team_access_id: TB, team_id: T.beta }));
  world.sample_access.push(derived(P.view, 'view'), derived(P.view, 'view', TB), own(P.view, 'edit'), derived(P.co, 'view'));
  const { handlers, db } = mount({ tables: world, raw: teamHook() });
  const del = handlers['DELETE /:collection/:id/entries/:person_id'];
  const r = await call(del, { params: { person_id: P.view } });
  assert.deepEqual([r.status, r.body], [200, { removed: true }]);
  assert.deepEqual(db.tables().sample_access.map((x) => [x.person_id, x.team_access_id]), [[P.view, TA], [P.view, TB], [P.co, TA]]);
  assert.equal((await call(del, { params: { person_id: P.view } })).status, 404, 'only derived rows left: not on the person list');
  assert.equal((await call(del, { params: { person_id: P.co } })).status, 404);
  assert.equal(db.tables().sample_access.length, 3);
});

test('transfer: the new owner\'s own row goes, their derived rows stay; the previous owner gets an own row next to theirs', async () => {
  const world = baseTables();
  world.sample_team_access.push(sampleGrant());
  world.sample_access.push(derived(P.view, 'view'), own(P.view, 'view'), derived(P.owner, 'view'));
  world.sample_readers.push({ record_id: SAMPLE, user_id: U.view });
  const { handlers, db } = mount({ tables: world, raw: teamHook() });
  const r = await transfer(handlers, P.view);
  assert.equal(r.status, 200);
  assert.equal(db.tables().physical_samples[0].owner_person_id, P.view);
  const rows = db.tables().sample_access.map((x) => [x.person_id, x.role, x.team_access_id ?? null]);
  assert.deepEqual(rows, [[P.view, 'view', TA], [P.owner, 'view', TA], [P.owner, 'edit', null]]);
  // the previous owner: an own Can edit row, the derived row untouched; the new owner: derived row kept, own row gone
  const got = await call(handlers['GET /:collection/:id'], { acc: as(U.view) });
  assert.deepEqual(got.body.entries.map((e) => [e.name, e.role]), [['Olive Owner', 'edit']]);
});

test('transfer on a project: the previous PI becomes an own investigator row though a derived row exists', async () => {
  const world = baseTables();
  world.project_team_access.push({ team_access_id: 'ta-p', project_id: PROJECT, team_id: T.alpha, role: 'investigator', trust_new_members: false, added_by_person_id: P.pi });
  world.project_access.push({ access_id: 'd1', project_id: PROJECT, person_id: P.pi, role: 'investigator', added_by_person_id: P.pi, team_access_id: 'ta-p', created_at: new Date() });
  const { handlers, db } = mount({ tables: world, manage: () => true, raw: teamHook() });
  const r = await transfer(handlers, P.view, { collection: 'projects', id: PROJECT, acc: as(U.pi) });
  assert.equal(r.status, 200);
  assert.deepEqual(db.tables().project_access.map((x) => [x.person_id, x.team_access_id ?? null]), [[P.pi, 'ta-p'], [P.pi, null]]);
});

test('the mock models the partial index: a plain column list as the conflict target is refused like Postgres refuses it', async () => {
  const { db } = mount();
  await assert.rejects(db.transaction((trx) => trx('sample_access').insert({ sample_id: SAMPLE, person_id: P.view, role: 'view' }).onConflict(['sample_id', 'person_id']).merge({ role: 'view' })), /no unique or exclusion constraint/);
});

test('mailContent: via adds "via <team>" to the subject and the body, HTML-escaped; without it nothing changes', () => {
  const m = mailContent({ adder: 'Olive', role: 'Can view', kind: 'sample', code: 'SM-1', title: 'Bar', link: 'https://x/y', via: 'Lab <b>1</b>' });
  assert.equal(m.subject, 'Olive gave you access to sample SM-1 via Lab <b>1</b>');
  assert.match(m.text, /the sample SM-1 \(Bar\) via Lab <b>1<\/b>\./);
  assert.match(m.html, /via Lab &lt;b&gt;1&lt;\/b&gt;\./);
  assert.ok(!m.html.includes('<b>1'));
  assert.ok(!/via/.test(mailContent({ adder: 'Olive', role: 'Can view', kind: 'sample', code: 'SM-1' }).subject));
});
