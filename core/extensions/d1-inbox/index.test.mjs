// Run with: node --test core/extensions/d1-inbox/index.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import endpoint, {
  HttpError, LINK_TARGETS, SQL, buildListQuery, canSee, mount, parseFileFilters, safeEqual, shapeSummary,
} from './index.js';
import { LAB_VIEWER_ROLE_ID } from '../d1-record-access/index.js';

// ---- ids and fixtures --------------------------------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { alice: ID(1), bob: ID(2), carol: ID(3), dave: ID(4), admin: ID(5), viewer: ID(6), nobody: ID(7), former: ID(8) };
const P = { alice: ID(11), bob: ID(12), carol: ID(13), dave: ID(14), admin: ID(15), viewer: ID(16), former: ID(18) };
const TEAM = ID(21);
const OTHER_TEAM = ID(22);
const S1 = ID(101); // a sample Alice and Bob can edit
const S2 = ID(104); // a Restricted sample nobody but its owner can read
const S3 = ID(105); // a sample Carol can only view
const O1 = ID(102);
const T1 = ID(103);
const ROLE_MEMBER = ID(81);
const ROLE_PARENT = ID(82);
const NOW = new Date('2026-10-15T12:00:00.000Z');
const SECRET = 'a'.repeat(64);

// A found file. Defaults: Alice's own, new, an image that names sample S1 by short ID.
let seq = 0;
const cand = (overrides = {}) => {
  seq += 1;
  return {
    candidate_id: ID(1000 + seq), directus_files_id: ID(3000 + seq),
    owner_person_id: P.alice, owner_team_id: null,
    kind: 'sem_image', kind_confidence: 0.9, extracted: {}, origin: 'new', state: 'new',
    match_strength: 'short_id', matches: [{ collection: 'physical_samples', record_id: S1, via: 'short_id', token: '3fa9c1d2' }],
    suggested_collection: 'physical_samples', suggested_record_id: S1, duplicate_of: null,
    rel_path: `Users/ali1/img${seq}.tif`, size_bytes: 1000, source_mtime: null, first_seen_at: '2026-10-14T10:00:00.000Z',
    decided_at: null, decided_by: null, link_kind: null, linked_collection: null, linked_junction_id: null, link_batch_id: null, adopted_at: null,
    ...overrides,
  };
};

function newWorld() {
  const w = {
    now: NOW,
    users: new Map([
      [U.alice, { id: U.alice, role: ROLE_MEMBER, status: 'active' }],
      [U.bob, { id: U.bob, role: ROLE_MEMBER, status: 'active' }],
      [U.carol, { id: U.carol, role: ROLE_MEMBER, status: 'active' }],
      [U.dave, { id: U.dave, role: ROLE_MEMBER, status: 'active' }],
      [U.admin, { id: U.admin, role: ID(80), status: 'active' }],
      [U.viewer, { id: U.viewer, role: LAB_VIEWER_ROLE_ID, status: 'active' }],
      [U.former, { id: U.former, role: ROLE_MEMBER, status: 'suspended' }],
    ]),
    roleParents: new Map([[ROLE_MEMBER, ROLE_PARENT]]),
    globalAccess: { [ID(80)]: { admin: true, app: true }, [ROLE_MEMBER]: { admin: false, app: true } },
    people: [
      { person_id: P.alice, full_name: 'Alice A', active: true, uni_alias: 'ali1', user_id: U.alice },
      { person_id: P.bob, full_name: 'Bob B', active: true, uni_alias: 'bob2', user_id: U.bob },
      { person_id: P.carol, full_name: 'Carol C', active: true, uni_alias: 'car3', user_id: U.carol },
      { person_id: P.dave, full_name: 'Dave D', active: true, uni_alias: null, user_id: U.dave },
      { person_id: P.admin, full_name: 'Ada Admin', active: true, uni_alias: 'ada9', user_id: U.admin },
      { person_id: P.viewer, full_name: 'Vic Viewer', active: true, uni_alias: 'vic1', user_id: U.viewer },
      { person_id: P.former, full_name: 'Fay Former', active: false, uni_alias: 'fay1', user_id: U.former },
    ],
    teams: [{ team_id: TEAM, name: 'SEM team', share_folder: 'SEM' }, { team_id: OTHER_TEAM, name: 'Other team', share_folder: 'Other' }],
    teamMembers: [{ team_id: TEAM, person_id: P.alice }, { team_id: TEAM, person_id: P.bob }, { team_id: TEAM, person_id: P.former }, { team_id: OTHER_TEAM, person_id: P.carol }],
    candidates: new Map(),
    junctions: { sample_data_files: [], operation_data_files: [], session_data_files: [] },
    records: { physical_samples: new Set([S1, S2, S3]), manufacturing_operations: new Set([O1]), test_sessions: new Set([T1]) },
    // what the caller may edit, as the real update rule would decide: user -> collection -> ids
    editable: {
      [U.alice]: { physical_samples: new Set([S1]), manufacturing_operations: new Set([O1]), test_sessions: new Set([T1]) },
      [U.bob]: { physical_samples: new Set([S1]), manufacturing_operations: new Set(), test_sessions: new Set() },
      [U.carol]: { physical_samples: new Set(), manufacturing_operations: new Set(), test_sessions: new Set() },
      [U.dave]: { physical_samples: new Set([S3]), manufacturing_operations: new Set(), test_sessions: new Set() },
      [U.viewer]: { physical_samples: new Set([S1]), manufacturing_operations: new Set(), test_sessions: new Set() },
    },
    prefs: new Map(),
    scanRequests: [],
    crawlerState: {
      desired_state: 'running', interval_minutes: 30, read_mb_per_s: '60', last_heartbeat_at: new Date('2026-10-15T11:59:30.000Z'),
      daemon_started_at: new Date('2026-10-15T08:00:00.000Z'), current_activity: 'idle', last_scan_started_at: new Date('2026-10-15T11:30:00.000Z'),
      last_scan_finished_at: new Date('2026-10-15T11:45:00.000Z'), files_registered: '42', error_count: 1, last_error: 'share briefly unreachable',
      unmatched_folders: ['Users/zz9', 'Shared/Old project'],
    },
    totals: [{ state: 'new', n: 5 }, { state: 'linked', n: 2 }],
    // canned answers for the dynamic queries and the grouped summary
    listRows: [], listTotal: 0, acceptIds: [], summaryRows: [],
    // failure switches
    denyDelete: false, failCreateFor: null,
    log: [], items: [], txCount: 0, cacheCleared: 0, chain: Promise.resolve(),
  };
  return w;
}

const add = (w, ...rows) => { for (const r of rows) w.candidates.set(r.candidate_id, r); return rows.length === 1 ? rows[0] : rows; };

// ---- fakes: knex, ItemsService, router ---------------------------------------------------------------------------------

// every statement of SQL (and the nested per-collection ones) by its text, so the fake answers by NAME
const NAMES = new Map();
for (const [key, value] of Object.entries(SQL)) {
  if (typeof value === 'string') NAMES.set(value, key);
  else for (const [sub, text] of Object.entries(value)) NAMES.set(text, `${key}.${sub}`);
}
const csv = (v) => String(v ?? '').split(',').filter(Boolean);
const copy = (v) => structuredClone(v);

// a rollback puts the candidate objects back IN PLACE (the tests hold references to them)
const snapshot = (w) => ({ candidates: [...w.candidates.values()].map((c) => [c, copy(c)]), junctions: copy(w.junctions), scanRequests: copy(w.scanRequests), prefs: copy(w.prefs) });
const restore = (w, s) => {
  for (const [obj, saved] of s.candidates) { for (const k of Object.keys(obj)) delete obj[k]; Object.assign(obj, saved); }
  w.junctions = s.junctions; w.scanRequests = s.scanRequests; w.prefs = s.prefs;
};

function statement(w, sql, b, txId) {
  w.log.push({ sql, name: NAMES.get(sql) ?? null, bindings: b, tx: txId });
  const name = NAMES.get(sql);
  if (!name) {
    if (/^SELECT count\(\*\)/.test(sql)) return [{ total: w.listTotal }];
    if (/^SELECT c\.candidate_id FROM/.test(sql)) return w.acceptIds.map((candidate_id) => ({ candidate_id }));
    if (/^SELECT c\.candidate_id, /.test(sql)) return copy(w.listRows);
    throw new Error(`unexpected SQL: ${sql}`);
  }
  switch (name) {
    case 'setActor': return [{ set_config: b[0] }];
    case 'lock': return [];
    case 'personByUser': return copy(w.people.filter((p) => p.user_id === b[0]));
    case 'personById': return copy(w.people.filter((p) => p.person_id === b[0]));
    case 'teamsOfPerson': {
      const ids = w.teamMembers.filter((m) => m.person_id === b[0]).map((m) => m.team_id);
      return copy(w.teams.filter((t) => ids.includes(t.team_id)));
    }
    case 'candidatesForUpdate': return csv(b[0]).sort().map((id) => w.candidates.get(id)).filter(Boolean).map(copy);
    case 'batchForUpdate': return [...w.candidates.values()].filter((c) => c.link_batch_id === b[0]).sort((x, y) => x.candidate_id.localeCompare(y.candidate_id)).map(copy);
    case 'markLinked': {
      const [decidedBy, linkKind, collection, junctionId, batchId, adopt, id] = b;
      const c = w.candidates.get(id);
      if (!c || c.state !== 'new') return [];
      Object.assign(c, { state: 'linked', decided_at: w.now.toISOString(), decided_by: decidedBy, link_kind: linkKind, linked_collection: collection, linked_junction_id: junctionId, link_batch_id: batchId });
      if (adopt) c.adopted_at ??= w.now.toISOString();
      return [{ candidate_id: id }];
    }
    case 'resetBatch': {
      const out = [];
      for (const id of csv(b[0])) {
        const c = w.candidates.get(id);
        if (c && c.link_batch_id === b[1] && c.state === 'linked') {
          Object.assign(c, { state: 'new', decided_at: null, decided_by: null, link_kind: null, linked_collection: null, linked_junction_id: null, link_batch_id: null });
          out.push({ candidate_id: id });
        }
      }
      return out;
    }
    case 'dismiss': case 'restore': {
      const [, ids] = name === 'dismiss' ? [b[0], b[1]] : [null, b[0]];
      const from = name === 'dismiss' ? 'new' : 'dismissed';
      const out = [];
      for (const id of csv(ids)) {
        const c = w.candidates.get(id);
        if (c && c.state === from) {
          Object.assign(c, name === 'dismiss' ? { state: 'dismissed', decided_at: w.now.toISOString(), decided_by: b[0] } : { state: 'new', decided_at: null, decided_by: null });
          out.push({ candidate_id: id });
        }
      }
      return out;
    }
    case 'prefsGet': return w.prefs.has(b[0]) ? [{ auto_link: w.prefs.get(b[0]) }] : [];
    case 'prefsPut': w.prefs.set(b[0], b[1]); return [{ auto_link: b[1] }];
    case 'rescanBlocking': {
      if (w.skipBlockingCheck) return [];
      const [personId, since] = b;
      const hit = w.scanRequests.filter((r) => r.scope === 'person' && r.person_id === personId && (
        new Date(r.requested_at) > new Date(since) || (r.finished_at && new Date(r.finished_at) > new Date(since))
        || ['queued', 'running'].includes(r.status)))
        .sort((x, y) => new Date(y.requested_at) - new Date(x.requested_at));
      return copy(hit.slice(0, 1));
    }
    case 'rescanInsert': {
      // the partial unique index of migration 193: one queued or running request per person
      if (w.scanRequests.some((r) => r.scope === 'person' && r.person_id === b[0] && ['queued', 'running'].includes(r.status))) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const row = { request_id: ID(7000 + w.scanRequests.length), scope: 'person', person_id: b[0], requested_by: b[1], requested_at: w.now.toISOString(), finished_at: null, status: 'queued' };
      w.scanRequests.push(row);
      return [copy(row)];
    }
    case 'summary': return copy(w.summaryRows);
    case 'userForAccountability': return w.users.has(b[0]) ? [copy(w.users.get(b[0]))] : [];
    case 'roleTree': {
      const out = [];
      for (let r = b[0]; r; r = w.roleParents.get(r)) out.push({ id: r });
      return out;
    }
    case 'globalAccess': {
      const roles = csv(b[1]);
      const rows = roles.map((r) => w.globalAccess[r]).filter(Boolean);
      return [{ admin: rows.some((r) => r.admin), app: rows.some((r) => r.app) }];
    }
    case 'adminState': return [copy(w.crawlerState)];
    case 'adminPeopleWithoutAlias': return copy(w.people.filter((p) => p.active && !p.uni_alias).map((p) => ({ person_id: p.person_id, full_name: p.full_name, has_login: p.user_id !== null })));
    case 'adminTotals': return copy(w.totals);
    case 'adminQueue': return [{ queued: w.scanRequests.filter((r) => r.status === 'queued').length, running: w.scanRequests.filter((r) => r.status === 'running').length }];
    case 'scanAllBlocking': return copy(w.scanRequests.filter((r) => r.scope === 'all' && ['queued', 'running'].includes(r.status) && true).slice(0, 1));
    case 'scanAllInsert': {
      const row = { request_id: ID(8000 + w.scanRequests.length), scope: 'all', person_id: null, requested_by: b[0], requested_at: w.now.toISOString(), finished_at: null, status: 'queued' };
      w.scanRequests.push(row);
      return [copy(row)];
    }
    default: break;
  }
  const [kind, sub] = name.split('.');
  const target = LINK_TARGETS[sub];
  if (kind === 'recordsExist') return csv(b[0]).filter((id) => w.records[sub].has(id)).map((id) => ({ [target.pk]: id }));
  if (kind === 'junctionFind') return copy(w.junctions[target.junction].filter((j) => j[target.fk] === b[0] && j.directus_files_id === b[1]));
  if (kind === 'junctionById') {
    return copy(w.junctions[target.junction].filter((j) => j.id === b[0]).map((j) => ({ id: j.id, record_id: j[target.fk], directus_files_id: j.directus_files_id })));
  }
  throw new Error(`unhandled statement ${name}`);
}

function fakeDatabase(w) {
  const make = (txId) => {
    const raw = async (sql, b = []) => ({ rows: statement(w, sql, b, txId) });
    return raw;
  };
  const db = (table) => {
    // d1-record-access's isLabViewer: db('directus_users').where('id', x).first('role')
    if (table !== 'directus_users') throw new Error(`unexpected table ${table}`);
    let id;
    const q = { where: (_c, v) => { id = v; return q; }, first: async () => (w.users.has(id) ? { role: w.users.get(id).role } : undefined) };
    return q;
  };
  db.raw = make(null);
  db.transaction = (fn) => {
    const run = async () => {
      w.txCount += 1;
      const txId = w.txCount;
      const snap = snapshot(w);
      const trx = () => { throw new Error('trx() not used'); };
      trx.raw = make(txId);
      trx.isTransaction = true;
      trx.txId = txId;
      try {
        return await fn(trx);
      } catch (err) {
        restore(w, snap);
        throw err;
      }
    };
    // transactions queue up: the candidate row lock (SELECT ... FOR UPDATE) serialises two requests for one file
    const p = w.chain.then(run, run);
    w.chain = p.catch(() => {});
    return p;
  };
  return db;
}

function fakeServices(w) {
  class ItemsService {
    constructor(collection, options) {
      this.collection = collection;
      this.options = options;
    }

    async readByQuery(query) {
      // a mirror of d1-access-guard's canPass read: { _and: [ {pk: _eq|_in}, <update rule> ] }
      w.items.push({ op: 'read', collection: this.collection, query, accountability: this.options.accountability, knex: this.options.knex });
      const pk = LINK_TARGETS[this.collection]?.pk;
      const first = query.filter._and[0][pk];
      const ids = first._eq !== undefined ? [first._eq] : first._in;
      const user = this.options.accountability.user;
      const allowed = w.editable[user]?.[this.collection] ?? new Set();
      return ids.filter((id) => allowed.has(id)).map((id) => ({ [pk]: id }));
    }

    async createOne(data) {
      w.failCreateFor?.(this.collection, data);
      const target = Object.values(LINK_TARGETS).find((t) => t.junction === this.collection);
      const rows = w.junctions[this.collection];
      if (rows.some((j) => j[target.fk] === data[target.fk] && j.directus_files_id === data.directus_files_id)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const id = ID(5000 + rows.length + w.items.length);
      rows.push({ id, ...data });
      w.items.push({ op: 'create', collection: this.collection, data, accountability: this.options.accountability, knex: this.options.knex, id });
      return id;
    }

    async deleteOne(id) {
      if (w.denyDelete) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
      w.junctions[this.collection] = w.junctions[this.collection].filter((j) => j.id !== id);
      w.items.push({ op: 'delete', collection: this.collection, id, accountability: this.options.accountability, knex: this.options.knex });
      return id;
    }
  }
  class UtilsService {
    constructor(options) { this.options = options; }
    async clearCache() { w.cacheCleared += 1; }
  }
  return { ItemsService, UtilsService };
}

function fakeRouter() {
  const routes = new Map();
  const reg = (method) => (path, fn) => routes.set(`${method} ${path}`, fn);
  return { routes, get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE') };
}
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  return res;
}

let uuidSeq = 0;
function setup(w, { env = { D1_INBOX_CRAWLER_SECRET: SECRET }, schema = {} } = {}) {
  const router = fakeRouter();
  const errors = [];
  const context = {
    database: fakeDatabase(w), services: fakeServices(w), getSchema: async () => schema,
    logger: { warn() {}, error: (m) => errors.push(m), info() {} }, env,
  };
  mount(router, context, { clock: () => w.now, uuid: () => ID(9000 + (uuidSeq += 1)) });
  const call = async (key, { user, admin = false, role = ROLE_MEMBER, body, query, params, headers } = {}) => {
    const handler = router.routes.get(key);
    assert.ok(handler, `route ${key} is registered`);
    const req = {
      method: key.split(' ')[0],
      accountability: user ? { user, role, admin } : { user: null, role: null, admin: false },
      body, query: query ?? {}, params: params ?? {}, headers: headers ?? {}, schema,
    };
    const res = fakeRes();
    await handler(req, res);
    return res;
  };
  return { router, call, errors, context };
}

const errorOf = (res) => res.body?.errors?.[0];
const codeOf = (res) => errorOf(res)?.extensions?.code;
const actorsOf = (w) => w.log.filter((l) => l.name === 'setActor');
const writesTo = (w, collection) => w.items.filter((i) => i.collection === collection && i.op !== 'read');
const SAMPLE_JUNCTION = 'sample_data_files';
const link = (candidate, collection = 'physical_samples', record = S1) => ({ candidate_id: candidate.candidate_id, collection, record_id: record });

// ---- pure helpers ------------------------------------------------------------------------------------------------------

test('the spec table of link targets: sample, operation and test junctions', () => {
  assert.deepEqual(Object.keys(LINK_TARGETS).sort(), ['manufacturing_operations', 'physical_samples', 'test_sessions']);
  assert.equal(LINK_TARGETS.physical_samples.junction, 'sample_data_files');
  assert.equal(LINK_TARGETS.physical_samples.fk, 'sample_id');
  assert.equal(LINK_TARGETS.manufacturing_operations.junction, 'operation_data_files');
  assert.equal(LINK_TARGETS.manufacturing_operations.fk, 'operation_id');
  assert.equal(LINK_TARGETS.test_sessions.junction, 'session_data_files');
  assert.equal(LINK_TARGETS.test_sessions.fk, 'session_id');
  assert.equal(LINK_TARGETS.surface_scans, undefined, 'the surface_scans target is stream F1, not v1');
});

test('the junction FK columns match the migrations (20260624000031, 20260624000032)', () => {
  const sql = readFileSync(new URL('../../../db/migrations/20260624000031_operation_data_files.sql', import.meta.url), 'utf8')
    + readFileSync(new URL('../../../db/migrations/20260624000032_sample_session_data_files.sql', import.meta.url), 'utf8');
  for (const { junction, fk } of Object.values(LINK_TARGETS)) {
    const block = sql.slice(sql.indexOf(`CREATE TABLE ${junction} (`));
    assert.match(block.slice(0, block.indexOf(');')), new RegExp(`\\b${fk}\\b`), `${junction}.${fk}`);
  }
});

test('safeEqual: equal strings only, whatever the lengths, never throws', () => {
  assert.equal(safeEqual(SECRET, SECRET), true);
  assert.equal(safeEqual(SECRET, `${SECRET}x`), false);
  assert.equal(safeEqual(SECRET, SECRET.slice(1)), false);
  assert.equal(safeEqual('', ''), false, 'an empty secret never matches');
  assert.equal(safeEqual(undefined, SECRET), false);
  assert.equal(safeEqual(SECRET, undefined), false);
  assert.equal(safeEqual([SECRET], SECRET), false);
});

test('canSee: the owner person, an active member of the owner team, an administrator; nobody else', () => {
  const own = cand();
  const teams = cand({ owner_person_id: null, owner_team_id: TEAM });
  const scope = (over) => ({ personId: P.alice, teamIds: [TEAM], admin: false, ...over });
  assert.equal(canSee(scope(), own), true);
  assert.equal(canSee(scope(), teams), true);
  assert.equal(canSee(scope({ personId: P.bob, teamIds: [] }), own), false);
  assert.equal(canSee(scope({ teamIds: [] }), teams), false, 'not a member of the owner team');
  assert.equal(canSee(scope({ personId: P.bob, teamIds: [OTHER_TEAM] }), teams), false);
  assert.equal(canSee(scope({ personId: null, teamIds: [], admin: true }), own), true);
  assert.equal(canSee(scope({ personId: null, teamIds: [], admin: true }), teams), true);
  assert.equal(canSee(scope({ personId: null, teamIds: [] }), own), false, 'a login with no person sees nothing');
});

test('parseFileFilters: tab, kind, folder, dates, owner, strength, paging; bad values are 400', () => {
  const ok = parseFileFilters({ tab: 'older', kind: 'sem_image,image', folder: '/Users/ali1/run 1//', date_from: '2026-10-01', date_to: '2026-10-15', strength: 'any', limit: '20', offset: '40' });
  assert.equal(ok.tab, 'older');
  assert.deepEqual(ok.kinds, ['sem_image', 'image']);
  assert.equal(ok.folder, 'Users/ali1/run 1/');
  assert.equal(ok.strength, 'any');
  assert.equal(ok.limit, 20);
  assert.equal(ok.offset, 40);
  assert.equal(parseFileFilters({}).tab, 'new');
  assert.equal(parseFileFilters({}).limit, 50);
  assert.equal(parseFileFilters({ limit: '9999' }).limit, 200, 'paging is clamped');
  for (const bad of [{ tab: 'everything' }, { kind: 'movie' }, { date_from: 'yesterday' }, { date_to: '2026-13-40' }, { strength: 'maybe' },
    { owner_person_id: 'nope' }, { owner_team_id: 'nope' }, { limit: '-1' }, { limit: 'x' }, { offset: '-5' }, { link_kind: 'telepathy' }, { folder: 'x'.repeat(600) }]) {
    assert.throws(() => parseFileFilters(bad), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(bad));
  }
});

test('buildListQuery: each tab, the owner scope and the filters are bindings, never text', () => {
  const scope = { personId: P.alice, teamIds: [TEAM, OTHER_TEAM], admin: false };
  const tabs = {
    new: [/c\.state = 'new'/, /c\.origin = 'new'/],
    older: [/c\.state = 'new'/, /c\.origin = 'backlog'/],
    linked: [/c\.state = 'linked'/],
    dismissed: [/c\.state = 'dismissed'/],
  };
  for (const [tab, patterns] of Object.entries(tabs)) {
    const { sql, bindings } = buildListQuery(scope, parseFileFilters({ tab }));
    for (const p of patterns) assert.match(sql, p, tab);
    assert.ok(bindings.includes(P.alice), 'the person id is a binding');
    assert.ok(bindings.includes(`${TEAM},${OTHER_TEAM}`), 'the team ids are one csv binding');
    assert.doesNotMatch(sql, new RegExp(P.alice), 'no id in the text');
  }
  // a copy drops out of the new and older tabs once its original is linked or dismissed
  for (const tab of ['new', 'older']) assert.match(buildListQuery(scope, parseFileFilters({ tab })).sql, /o\.state IN \('linked', 'dismissed'\)/);
  assert.doesNotMatch(buildListQuery(scope, parseFileFilters({ tab: 'linked' })).sql, /o\.state IN/);
  // filters
  const f = parseFileFilters({ kind: 'sem_image', folder: 'Users/ali1/run1', strength: 'short_id', date_from: '2026-10-01', date_to: '2026-10-15', link_kind: 'auto', tab: 'linked' });
  const q = buildListQuery(scope, f);
  assert.match(q.sql, /c\.kind = ANY\(/);
  assert.match(q.sql, /starts_with\(c\.rel_path, \?\)/);
  assert.match(q.sql, /c\.match_strength = \?/);
  assert.match(q.sql, /c\.link_kind = \?/);
  assert.ok(q.bindings.includes('Users/ali1/run1/'));
  assert.ok(q.bindings.includes('short_id') && q.bindings.includes('auto'));
  // an explicit owner replaces the default scope
  const one = buildListQuery(scope, parseFileFilters({ owner_team_id: TEAM }));
  assert.match(one.sql, /c\.owner_team_id = \?/);
  assert.ok(one.bindings.includes(TEAM));
  // paging and order
  const paged = buildListQuery(scope, parseFileFilters({ limit: '10', offset: '30' }));
  assert.match(paged.sql, /ORDER BY c\.first_seen_at DESC, c\.candidate_id\s+LIMIT \? OFFSET \?/);
  assert.deepEqual(paged.bindings.slice(-2), [10, 30]);
  assert.match(buildListQuery(scope, parseFileFilters({ tab: 'linked' })).sql, /ORDER BY c\.decided_at DESC/);
  const count = buildListQuery(scope, parseFileFilters({}), { count: true });
  assert.match(count.sql, /^SELECT count\(\*\)/);
  assert.doesNotMatch(count.sql, /LIMIT/);
  const accept = buildListQuery(scope, parseFileFilters({ tab: 'new' }), { accept: true });
  assert.match(accept.sql, /^SELECT c\.candidate_id FROM/);
  assert.match(accept.sql, /c\.match_strength = 'short_id'/);
  assert.match(accept.sql, /c\.suggested_record_id IS NOT NULL/);
});

test('shapeSummary: new count and older-with-exact-match, per person and per team', () => {
  const scope = { personId: P.alice, teamIds: [TEAM, OTHER_TEAM], admin: false };
  const teams = [{ team_id: TEAM, name: 'SEM team' }, { team_id: OTHER_TEAM, name: 'Other team' }];
  const rows = [
    { owner_person_id: P.alice, owner_team_id: null, origin: 'new', exact: false, n: 3 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'new', exact: true, n: 1 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'backlog', exact: false, n: 10 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'backlog', exact: true, n: 2 },
    { owner_person_id: null, owner_team_id: TEAM, origin: 'new', exact: false, n: 5 },
    { owner_person_id: null, owner_team_id: TEAM, origin: 'backlog', exact: true, n: 4 },
  ];
  const out = shapeSummary(rows, scope, teams, { name: 'Alice A' });
  assert.deepEqual(out.person, { person_id: P.alice, new: 4, older_matching: 2 });
  assert.deepEqual(out.teams, [
    { team_id: TEAM, name: 'SEM team', new: 5, older_matching: 4 },
    { team_id: OTHER_TEAM, name: 'Other team', new: 0, older_matching: 0 },
  ]);
  assert.equal(out.total_new, 9);
  assert.equal(out.total_older_matching, 6);
  assert.equal(shapeSummary([], { personId: null, teamIds: [], admin: false }, [], null).person, null);
});

// ---- the wrapper: sign-in, Directus-shaped errors, Lab Viewer ------------------------------------------------------------

const USER_ROUTES = [
  'GET /summary', 'GET /files', 'POST /link', 'POST /accept-all', 'POST /dismiss', 'POST /restore', 'POST /undo',
  'POST /rescan', 'GET /prefs', 'PUT /prefs', 'GET /admin', 'POST /admin/scan-all',
];

test('every route but auto-link needs a signed-in user: 401, Directus-shaped, source d1-inbox', async () => {
  const w = newWorld();
  const { call } = setup(w);
  for (const key of USER_ROUTES) {
    const res = await call(key, { body: {} });
    assert.equal(res.statusCode, 401, key);
    assert.equal(codeOf(res), 'UNAUTHORIZED', key);
    assert.equal(errorOf(res).extensions.source, 'd1-inbox', key);
    assert.equal(typeof errorOf(res).message, 'string');
  }
  assert.equal(w.log.length, 0, 'nothing is read or written for an anonymous caller');
});

test('an unexpected failure is a 500 with no detail, and is logged', async () => {
  const w = newWorld();
  const { call, errors } = setup(w);
  w.people = null; // makes the fake throw
  const res = await call('GET /summary', { user: U.alice });
  assert.equal(res.statusCode, 500);
  assert.equal(codeOf(res), 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(errorOf(res).message, /people|null|TypeError/);
  assert.equal(errors.length, 1);
});

test('a Lab Viewer changes nothing: every write route is 403 READ_ONLY_ROLE and writes nothing; reads still work', async () => {
  const w = newWorld();
  const c = add(w, cand({ owner_person_id: P.viewer }));
  const { call } = setup(w);
  const writes = [
    ['POST /link', { items: [link(c)] }], ['POST /accept-all', { filter: {} }], ['POST /dismiss', { candidate_ids: [c.candidate_id] }],
    ['POST /restore', { candidate_ids: [c.candidate_id] }], ['POST /undo', { link_batch_id: ID(1) }], ['POST /rescan', {}], ['PUT /prefs', { auto_link: true }],
  ];
  for (const [key, body] of writes) {
    const res = await call(key, { user: U.viewer, role: LAB_VIEWER_ROLE_ID, body });
    assert.equal(res.statusCode, 403, key);
    assert.equal(codeOf(res), 'READ_ONLY_ROLE', key);
  }
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.scanRequests.length, 0);
  assert.equal(w.prefs.size, 0);
  assert.equal(c.state, 'new');
  assert.equal((await call('GET /summary', { user: U.viewer, role: LAB_VIEWER_ROLE_ID })).statusCode, 200);
  assert.equal((await call('GET /prefs', { user: U.viewer, role: LAB_VIEWER_ROLE_ID })).statusCode, 200);
});

// ---- summary ---------------------------------------------------------------------------------------------------------------

test('GET /summary: the person and each of their teams, new vs older with a match; asked for the caller scope only', async () => {
  const w = newWorld();
  w.summaryRows = [
    { owner_person_id: P.alice, owner_team_id: null, origin: 'new', exact: false, n: 2 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'backlog', exact: true, n: 3 },
    { owner_person_id: null, owner_team_id: TEAM, origin: 'new', exact: true, n: 1 },
  ];
  const { call } = setup(w);
  const res = await call('GET /summary', { user: U.alice });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.person, { person_id: P.alice, new: 2, older_matching: 3 });
  assert.deepEqual(res.body.data.teams, [{ team_id: TEAM, name: 'SEM team', new: 1, older_matching: 0 }]);
  assert.equal(res.body.data.total_new, 3);
  assert.equal(res.body.data.total_older_matching, 3);
  const q = w.log.find((l) => l.name === 'summary');
  assert.equal(q.bindings[0], P.alice, 'the person');
  assert.equal(q.bindings[1], TEAM, 'only the teams Alice is an active member of');
});

test('GET /summary: a Former (inactive) person is a member of no team; a login with no person sees zeros; an administrator sees only their own', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const former = await call('GET /summary', { user: U.former });
  assert.deepEqual(former.body.data.teams, []);
  assert.equal(w.log.find((l) => l.name === 'summary').bindings[1], '');
  w.log.length = 0;
  const nobody = await call('GET /summary', { user: U.nobody });
  assert.equal(nobody.statusCode, 200);
  assert.equal(nobody.body.data.person, null);
  assert.deepEqual(nobody.body.data.teams, []);
  assert.equal(nobody.body.data.total_new, 0);
  assert.equal(w.log.some((l) => l.name === 'summary'), false, 'no scope, no query');
  w.log.length = 0;
  await call('GET /summary', { user: U.admin, admin: true });
  const q = w.log.find((l) => l.name === 'summary');
  assert.equal(q.bindings[0], P.admin, 'an administrator counts their own folders, not everyone');
});

// ---- files -----------------------------------------------------------------------------------------------------------------

const listRow = (c, over = {}) => ({
  candidate_id: c.candidate_id, file_id: c.directus_files_id, name: 'a.tif', mime_type: 'image/tiff', kind: c.kind, kind_confidence: c.kind_confidence,
  extracted: c.extracted, origin: c.origin, state: c.state, match_strength: c.match_strength, matches: c.matches,
  suggested_collection: c.suggested_collection, suggested_record_id: c.suggested_record_id, duplicate_of: null, copy_owner_name: null, copy_owner_kind: null,
  rel_path: c.rel_path, size_bytes: c.size_bytes, source_mtime: null, first_seen_at: c.first_seen_at, decided_at: null, link_kind: null,
  linked_collection: null, link_batch_id: null, owner_person_id: c.owner_person_id, owner_team_id: c.owner_team_id, owner_name: 'Alice A', adopted_at: null,
  ...over,
});

test('GET /files: a page of rows with the file, the owner and the suggestion and why; total in meta', async () => {
  const w = newWorld();
  const a = cand();
  w.listRows = [listRow(a)];
  w.listTotal = 41;
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice, query: { tab: 'new', limit: '10' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.meta, { total: 41, limit: 10, offset: 0 });
  const [row] = res.body.data;
  assert.equal(row.id, a.candidate_id);
  assert.equal(row.file_id, a.directus_files_id);
  assert.equal(row.name, 'a.tif');
  assert.equal(row.kind, 'sem_image');
  assert.deepEqual(row.suggestion, { collection: 'physical_samples', record_id: S1, via: 'short_id', token: '3fa9c1d2' });
  assert.deepEqual(row.owner, { kind: 'person', id: P.alice, name: 'Alice A' });
  assert.equal(row.rel_path, a.rel_path);
  assert.equal(row.is_copy, false);
});

test('GET /files: a suggestion the caller cannot edit is not shown (no record id leaks), and neither are the other matches', async () => {
  const w = newWorld();
  const mine = cand();
  const restricted = cand({ suggested_record_id: S2, matches: [{ collection: 'physical_samples', record_id: S2, via: 'short_id', token: 'bbbbbbbb' }] });
  const ambiguous = cand({ match_strength: 'short_id', suggested_collection: null, suggested_record_id: null, matches: [{ collection: 'physical_samples', record_id: S1, via: 'short_id', token: 'cccccccc' }, { collection: 'physical_samples', record_id: S2, via: 'short_id', token: 'cccccccc' }] });
  w.listRows = [listRow(mine), listRow(restricted), listRow(ambiguous)];
  w.listTotal = 3;
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice });
  const [a, b, c] = res.body.data;
  assert.equal(a.suggestion.record_id, S1);
  assert.equal(b.suggestion, null);
  assert.equal(b.match_count, 1);
  assert.equal(c.suggestion, null);
  assert.equal(c.match_count, 2);
  assert.equal(JSON.stringify(res.body).includes(S2), false, 'a Restricted record id appears nowhere in the answer');
  // the edit check ran as the caller, in one read per collection
  const reads = w.items.filter((i) => i.op === 'read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].accountability.user, U.alice);
});

test('GET /files: a copy says whose folder holds the original; an owner filter on someone else is 403 unless administrator', async () => {
  const w = newWorld();
  const a = cand();
  w.listRows = [listRow(a, { duplicate_of: ID(1), copy_owner_name: 'Bob B', copy_owner_kind: 'person' })];
  w.listTotal = 1;
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice });
  assert.equal(res.body.data[0].is_copy, true);
  assert.deepEqual(res.body.data[0].copy_of, { owner_kind: 'person', owner_name: 'Bob B' });
  const other = await call('GET /files', { user: U.alice, query: { owner_person_id: P.bob } });
  assert.equal(other.statusCode, 403);
  const otherTeam = await call('GET /files', { user: U.alice, query: { owner_team_id: OTHER_TEAM } });
  assert.equal(otherTeam.statusCode, 403);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner_team_id: TEAM } })).statusCode, 200);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner_person_id: P.alice } })).statusCode, 200);
  assert.equal((await call('GET /files', { user: U.admin, admin: true, query: { owner_person_id: P.bob } })).statusCode, 200);
  assert.equal((await call('GET /files', { user: U.alice, query: { tab: 'nope' } })).statusCode, 400);
});

test('GET /files: the query carries the caller person and the active teams, nothing the client supplied as text', async () => {
  const w = newWorld();
  const { call } = setup(w);
  await call('GET /files', { user: U.alice, query: { folder: "x'; DROP TABLE d1_private.file_candidates; --", kind: 'image' } });
  const list = w.log.find((l) => /^SELECT c\.candidate_id, /.test(l.sql));
  assert.ok(list.bindings.includes(P.alice));
  assert.ok(list.bindings.includes(TEAM));
  assert.doesNotMatch(list.sql, /DROP TABLE/);
  // Former person: no team
  w.log.length = 0;
  await call('GET /files', { user: U.former });
  const former = w.log.find((l) => /^SELECT c\.candidate_id, /.test(l.sql));
  assert.equal(former.bindings.includes(TEAM), false);
});

// ---- link ------------------------------------------------------------------------------------------------------------------

test('POST /link validates the body: items 1 to 200, ids, a known target, no candidate twice', async () => {
  const w = newWorld();
  const c = add(w, cand());
  const { call } = setup(w);
  const bad = [
    undefined, {}, { items: [] }, { items: 'x' }, { items: [{}] },
    { items: [{ candidate_id: 'nope', collection: 'physical_samples', record_id: S1 }] },
    { items: [{ candidate_id: c.candidate_id, collection: 'physical_samples', record_id: 'nope' }] },
    { items: [{ candidate_id: c.candidate_id, collection: 'campaigns', record_id: S1 }] },
    { items: [{ candidate_id: c.candidate_id, collection: 'surface_scans', record_id: S1 }] },
    { items: [{ candidate_id: c.candidate_id, collection: '__proto__', record_id: S1 }] },
    { items: [link(c), link(c)] },
    { items: Array.from({ length: 201 }, () => link(c)) },
  ];
  for (const body of bad) {
    const res = await call('POST /link', { user: U.alice, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 80));
    assert.equal(codeOf(res), 'INVALID_PAYLOAD');
  }
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.txCount, 0, 'no transaction was opened for a bad body');
});

test('POST /link: one candidate, one record, as the caller: junction row through ItemsService, candidate linked, batch id returned', async () => {
  const w = newWorld();
  const c = add(w, cand());
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const batch = res.body.data.link_batch_id;
  assert.match(batch, /^[0-9a-f-]{36}$/);
  assert.equal(res.body.data.count, 1);
  assert.equal(res.body.data.linked[0].candidate_id, c.candidate_id);
  const created = writesTo(w, SAMPLE_JUNCTION);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].data, { sample_id: S1, directus_files_id: c.directus_files_id });
  assert.equal(created[0].accountability.user, U.alice, 'created as the caller, not as the system');
  assert.equal(created[0].accountability.admin, false);
  assert.ok(created[0].knex?.isTransaction, 'inside the one transaction');
  assert.equal(c.state, 'linked');
  assert.equal(c.decided_by, U.alice);
  assert.equal(c.link_kind, 'manual');
  assert.equal(c.linked_collection, 'physical_samples');
  assert.equal(c.linked_junction_id, created[0].id);
  assert.equal(c.link_batch_id, batch);
  assert.equal(c.adopted_at, null, 'an image is not adopted: the crawler already read it');
  assert.equal(res.body.data.linked[0].junction_id, created[0].id);
});

test('POST /link: every write transaction starts with set_config d1.actor_identity for the caller', async () => {
  const w = newWorld();
  const c = add(w, cand());
  const { call } = setup(w);
  await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  const tx = w.log.filter((l) => l.tx !== null);
  assert.equal(tx[0].name, 'setActor');
  assert.deepEqual(tx[0].bindings, [U.alice]);
  assert.match(SQL.setActor, /set_config\('d1\.actor_identity', \?, true\)/);
});

test('POST /link: a view-only person is refused 403, a Restricted record the person cannot read is refused 403, nothing is written', async () => {
  const w = newWorld();
  const own = add(w, cand({ owner_person_id: P.carol }));
  const { call } = setup(w);
  // Carol can read S3 and view it, but the update rule does not pass for her
  const viewOnly = await call('POST /link', { user: U.carol, body: { items: [link(own, 'physical_samples', S3)] } });
  assert.equal(viewOnly.statusCode, 403);
  assert.equal(codeOf(viewOnly), 'FORBIDDEN');
  // a Restricted sample she cannot even read: the same answer (the answer does not say whether the record exists)
  const restricted = await call('POST /link', { user: U.carol, body: { items: [link(own, 'physical_samples', S2)] } });
  assert.equal(restricted.statusCode, 403);
  assert.equal(codeOf(restricted), 'FORBIDDEN');
  assert.equal(errorOf(restricted).message, errorOf(viewOnly).message);
  // and for an unknown record id
  const unknown = await call('POST /link', { user: U.carol, body: { items: [link(own, 'physical_samples', ID(999))] } });
  assert.equal(unknown.statusCode, 403);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(own.state, 'new');
});

test('POST /link: the edit check is the update rule of d1-access-guard, run as the caller through ItemsService', async () => {
  const guard = JSON.parse(readFileSync(new URL('../d1-access-guard/rules.json', import.meta.url), 'utf8'));
  const sampleRule = guard.guards.campaign_samples.find((g) => g.parent === 'physical_samples').filter;
  const testRule = guard.guards.test_sessions_subject.find((g) => g.parent === 'test_sessions').filter;
  const subst = (node) => JSON.parse(JSON.stringify(node).replaceAll('"$CURRENT_USER"', JSON.stringify(U.alice)));
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand({ suggested_collection: 'manufacturing_operations', suggested_record_id: O1 }));
  const c = add(w, cand({ suggested_collection: 'test_sessions', suggested_record_id: T1 }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(a), link(b, 'manufacturing_operations', O1), link(c, 'test_sessions', T1)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const reads = Object.fromEntries(w.items.filter((i) => i.op === 'read').map((i) => [i.collection, i]));
  assert.deepEqual(reads.physical_samples.query.filter._and[1], subst(sampleRule));
  assert.deepEqual(reads.test_sessions.query.filter._and[1], subst(testRule));
  // operations and tests share the rule record.update (scripts/access_rules.json), so the tests' filter is the operations' filter
  assert.deepEqual(reads.manufacturing_operations.query.filter._and[1], subst(testRule));
  const rules = JSON.parse(readFileSync(new URL('../../../scripts/access_rules.json', import.meta.url), 'utf8')).rules;
  assert.equal(rules.manufacturing_operations.update, 'record.update');
  assert.equal(rules.test_sessions.update, 'record.update');
  assert.equal(rules.physical_samples.update, 'sample.editors');
  for (const r of Object.values(reads)) {
    assert.equal(r.accountability.user, U.alice);
    assert.ok(r.knex?.isTransaction);
    assert.equal(JSON.stringify(r.query).includes('$CURRENT_USER'), false, 'the placeholder is replaced');
  }
});

test('POST /link: an operation and a test go to their own junctions', async () => {
  const w = newWorld();
  const o = add(w, cand({ suggested_collection: 'manufacturing_operations', suggested_record_id: O1 }));
  const t = add(w, cand({ suggested_collection: 'test_sessions', suggested_record_id: T1 }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(o, 'manufacturing_operations', O1), link(t, 'test_sessions', T1)] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.junctions.operation_data_files.map((j) => [j.operation_id, j.directus_files_id]), [[O1, o.directus_files_id]]);
  assert.deepEqual(w.junctions.session_data_files.map((j) => [j.session_id, j.directus_files_id]), [[T1, t.directus_files_id]]);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(o.link_kind, 'bulk', 'more than one item is a bulk link');
  assert.equal(o.link_batch_id, t.link_batch_id, 'one batch');
});

test('POST /link: the batch is atomic; one record the caller cannot edit and nothing is linked', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(a), link(b, 'physical_samples', S3)] } });
  assert.equal(res.statusCode, 403);
  assert.equal(errorOf(res).extensions.candidate_id, b.candidate_id);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(a.state, 'new');
  assert.equal(b.state, 'new');
});

test('POST /link: a failed junction create rolls the whole batch back (the earlier row, the candidate update)', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  let n = 0;
  w.failCreateFor = () => { n += 1; if (n === 2) throw new Error('boom'); };
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } });
  assert.equal(res.statusCode, 500);
  assert.equal(w.junctions.sample_data_files.length, 0, 'the first row was rolled back');
  assert.equal(a.state === 'new' && b.state === 'new', true);
  assert.equal(w.cacheCleared, 0);
});

test('POST /link: a candidate that does not exist, or that is not the caller\'s to see, is 404 (and names no one)', async () => {
  const w = newWorld();
  const bobs = add(w, cand({ owner_person_id: P.bob }));
  const { call } = setup(w);
  const unknown = await call('POST /link', { user: U.alice, body: { items: [{ candidate_id: ID(4040), collection: 'physical_samples', record_id: S1 }] } });
  assert.equal(unknown.statusCode, 404);
  const hidden = await call('POST /link', { user: U.alice, body: { items: [link(bobs)] } });
  assert.equal(hidden.statusCode, 404);
  assert.equal(codeOf(hidden), 'NOT_FOUND');
  assert.equal(bobs.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
});

test('POST /link: a team folder file is linkable by any active member, not by an outsider or a Former member', async () => {
  const w = newWorld();
  const t = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const { call } = setup(w);
  assert.equal((await call('POST /link', { user: U.carol, body: { items: [link(t)] } })).statusCode, 404, 'a member of another team');
  assert.equal((await call('POST /link', { user: U.former, body: { items: [link(t)] } })).statusCode, 404, 'a Former member is not an active member');
  assert.equal((await call('POST /link', { user: U.bob, body: { items: [link(t)] } })).statusCode, 200);
  assert.equal(t.decided_by, U.bob);
});

test('POST /link: two members race for a team file; the second gets 409 and there is one junction row', async () => {
  const w = newWorld();
  const t = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const { call } = setup(w);
  const [one, two] = await Promise.all([
    call('POST /link', { user: U.alice, body: { items: [link(t)] } }),
    call('POST /link', { user: U.bob, body: { items: [link(t)] } }),
  ]);
  assert.deepEqual([one.statusCode, two.statusCode].sort(), [200, 409]);
  const loser = one.statusCode === 409 ? one : two;
  assert.equal(codeOf(loser), 'ALREADY_LINKED');
  assert.equal(w.junctions.sample_data_files.length, 1, 'no second junction row');
  assert.equal(t.state, 'linked');
  // the candidate row was locked FOR UPDATE before it was read
  assert.match(SQL.candidatesForUpdate, /FOR UPDATE/);
  assert.match(SQL.candidatesForUpdate, /ORDER BY c?\.?candidate_id/);
});

test('POST /link: the same person repeating the same link is idempotent (same batch, no second row); another record is 409', async () => {
  const w = newWorld();
  const c = add(w, cand());
  const { call } = setup(w);
  const first = await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  const again = await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.data.link_batch_id, first.body.data.link_batch_id);
  assert.equal(again.body.data.linked[0].already_linked, true);
  assert.equal(w.junctions.sample_data_files.length, 1);
  // a different record for an already linked file
  w.editable[U.alice].physical_samples.add(ID(106));
  w.records.physical_samples.add(ID(106));
  const other = await call('POST /link', { user: U.alice, body: { items: [link(c, 'physical_samples', ID(106))] } });
  assert.equal(other.statusCode, 409);
  assert.equal(codeOf(other), 'ALREADY_LINKED');
});

test('POST /link: a dismissed or gone file is 409 (restore it first), never linked', async () => {
  const w = newWorld();
  const d = add(w, cand({ state: 'dismissed' }));
  const g = add(w, cand({ state: 'gone' }));
  const { call } = setup(w);
  const a = await call('POST /link', { user: U.alice, body: { items: [link(d)] } });
  assert.equal(a.statusCode, 409);
  assert.equal(codeOf(a), 'NOT_NEW');
  const b = await call('POST /link', { user: U.alice, body: { items: [link(g)] } });
  assert.equal(b.statusCode, 409);
  assert.equal(codeOf(b), 'FILE_GONE');
  assert.equal(w.junctions.sample_data_files.length, 0);
});

test('POST /link: a file already linked to that record (Data Studio) is 409 ALREADY_ON_RECORD: no second row, and no junction id to undo that this batch did not make', async () => {
  const w = newWorld();
  const c = add(w, cand());
  w.junctions.sample_data_files.push({ id: ID(4900), sample_id: S1, directus_files_id: c.directus_files_id });
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  assert.equal(res.statusCode, 409);
  assert.equal(codeOf(res), 'ALREADY_ON_RECORD');
  assert.equal(w.junctions.sample_data_files.length, 1);
  assert.equal(c.state, 'new');
});

test('POST /link: a document or other file is adopted (the crawler hashes it once); an image is not', async () => {
  const w = newWorld();
  const doc = add(w, cand({ kind: 'document' }));
  const other = add(w, cand({ kind: 'other' }));
  const scan = add(w, cand({ kind: 'image' }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(doc), link(other), link(scan)] } });
  assert.equal(res.statusCode, 200);
  assert.equal(doc.adopted_at, NOW.toISOString());
  assert.equal(other.adopted_at, NOW.toISOString());
  assert.equal(scan.adopted_at, null);
  assert.equal(res.body.data.linked.find((l) => l.candidate_id === doc.candidate_id).adopted, true);
});

test('POST /link: an administrator may link any visible file to any record that exists; a record that does not is 403', async () => {
  const w = newWorld();
  const c = add(w, cand({ owner_person_id: P.admin }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.admin, admin: true, body: { items: [link(c, 'physical_samples', S2)] } });
  assert.equal(res.statusCode, 200);
  assert.equal(w.junctions.sample_data_files[0].sample_id, S2);
  assert.equal(w.items.filter((i) => i.op === 'read').length, 0, 'no rule to run for an administrator');
  const c2 = add(w, cand({ owner_person_id: P.admin }));
  const none = await call('POST /link', { user: U.admin, admin: true, body: { items: [link(c2, 'physical_samples', ID(998))] } });
  assert.equal(none.statusCode, 403);
});

test('POST /link: the data cache is cleared after the commit when CACHE_ENABLED, and not otherwise', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const on = setup(w, { env: { CACHE_ENABLED: 'true', D1_INBOX_CRAWLER_SECRET: SECRET } });
  await on.call('POST /link', { user: U.alice, body: { items: [link(a)] } });
  assert.equal(w.cacheCleared, 1);
  const w2 = newWorld();
  const b = add(w2, cand());
  const off = setup(w2);
  await off.call('POST /link', { user: U.alice, body: { items: [link(b)] } });
  assert.equal(w2.cacheCleared, 0);
});

// ---- accept-all ------------------------------------------------------------------------------------------------------------

test('POST /accept-all links only exact short-ID suggestions to one record the caller can edit, and reports what it skipped', async () => {
  const w = newWorld();
  const ok1 = add(w, cand());
  const ok2 = add(w, cand({ suggested_collection: 'test_sessions', suggested_record_id: T1 }));
  const notEditable = add(w, cand({ suggested_record_id: S3 }));
  const code = add(w, cand({ match_strength: 'code' }));
  const noSuggestion = add(w, cand({ suggested_collection: null, suggested_record_id: null, matches: [] }));
  const doc = add(w, cand({ kind: 'document' }));
  const copy = add(w, cand({ duplicate_of: ok1.candidate_id }));
  const done = add(w, cand({ state: 'linked' }));
  const onRecord = add(w, cand());
  w.junctions.sample_data_files.push({ id: ID(4902), sample_id: S1, directus_files_id: onRecord.directus_files_id });
  w.acceptIds = [ok1, ok2, notEditable, code, noSuggestion, doc, copy, done, onRecord].map((c) => c.candidate_id);
  const { call } = setup(w);
  const res = await call('POST /accept-all', { user: U.alice, body: { filter: { tab: 'new' } } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.count, 2);
  assert.match(data.link_batch_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(data.linked.map((l) => l.candidate_id).sort(), [ok1.candidate_id, ok2.candidate_id].sort());
  const reasons = Object.fromEntries(data.skipped.map((s) => [s.candidate_id, s.reason]));
  assert.equal(reasons[notEditable.candidate_id], 'NOT_EDITABLE');
  assert.equal(reasons[code.candidate_id], 'NOT_EXACT');
  assert.equal(reasons[noSuggestion.candidate_id], 'NO_SUGGESTION');
  assert.equal(reasons[doc.candidate_id], 'DOCUMENT');
  assert.equal(reasons[copy.candidate_id], 'COPY');
  assert.equal(reasons[done.candidate_id], 'NOT_NEW');
  assert.equal(reasons[onRecord.candidate_id], 'ALREADY_ON_RECORD');
  assert.equal(w.junctions.sample_data_files.length, 2, 'the Data Studio row and one new row');
  assert.equal(w.junctions.session_data_files.length, 1);
  assert.equal(ok1.link_kind, 'bulk');
  assert.equal(ok1.link_batch_id, ok2.link_batch_id);
  assert.equal(notEditable.state, 'new');
});

test('POST /accept-all: dry_run counts without writing; nothing to do is 200 with no batch; the filter is validated', async () => {
  const w = newWorld();
  const ok = add(w, cand());
  w.acceptIds = [ok.candidate_id];
  const { call } = setup(w);
  const dry = await call('POST /accept-all', { user: U.alice, body: { filter: {}, dry_run: true } });
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.body.data.count, 1);
  assert.equal(dry.body.data.link_batch_id, null);
  assert.equal(ok.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  w.acceptIds = [];
  const none = await call('POST /accept-all', { user: U.alice, body: { filter: {} } });
  assert.equal(none.statusCode, 200);
  assert.equal(none.body.data.count, 0);
  assert.equal(none.body.data.link_batch_id, null);
  assert.equal((await call('POST /accept-all', { user: U.alice, body: { filter: { tab: 'bogus' } } })).statusCode, 400);
  assert.equal((await call('POST /accept-all', { user: U.alice, body: { filter: 'x' } })).statusCode, 400);
  assert.equal((await call('POST /accept-all', { user: U.alice, body: {} })).statusCode, 200, 'no filter means every new file');
});

test('POST /accept-all: a file the caller cannot see is never touched, even when the selection names it', async () => {
  const w = newWorld();
  const bobs = add(w, cand({ owner_person_id: P.bob }));
  w.acceptIds = [bobs.candidate_id];
  const { call } = setup(w);
  const res = await call('POST /accept-all', { user: U.alice, body: { filter: {} } });
  assert.equal(res.body.data.count, 0);
  assert.equal(bobs.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
});

// ---- dismiss and restore ---------------------------------------------------------------------------------------------------

test('POST /dismiss then /restore: state changes, decided_by recorded, a team file resolves for everyone', async () => {
  const w = newWorld();
  const mine = add(w, cand());
  const team = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const { call } = setup(w);
  const res = await call('POST /dismiss', { user: U.alice, body: { candidate_ids: [mine.candidate_id, team.candidate_id] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.changed.sort(), [mine.candidate_id, team.candidate_id].sort());
  assert.equal(mine.state, 'dismissed');
  assert.equal(mine.decided_by, U.alice);
  assert.equal(team.state, 'dismissed');
  // dismissing twice changes nothing and is not an error
  const again = await call('POST /dismiss', { user: U.bob, body: { candidate_ids: [team.candidate_id] } });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.body.data.changed, []);
  assert.deepEqual(again.body.data.unchanged, [team.candidate_id]);
  assert.equal(team.decided_by, U.alice, 'the first to resolve it');
  // restore (a teammate may)
  const back = await call('POST /restore', { user: U.bob, body: { candidate_ids: [team.candidate_id] } });
  assert.equal(back.statusCode, 200);
  assert.equal(team.state, 'new');
  assert.equal(team.decided_by, null);
  assert.deepEqual(actorsOf(w).map((a) => a.bindings[0]).slice(0, 2), [U.alice, U.bob]);
});

test('POST /dismiss: a linked file is 409; an unknown or someone else\'s is 404; bad bodies are 400; nothing changes on failure', async () => {
  const w = newWorld();
  const linked = add(w, cand({ state: 'linked' }));
  const bobs = add(w, cand({ owner_person_id: P.bob }));
  const mine = add(w, cand());
  const { call } = setup(w);
  const a = await call('POST /dismiss', { user: U.alice, body: { candidate_ids: [mine.candidate_id, linked.candidate_id] } });
  assert.equal(a.statusCode, 409);
  assert.equal(codeOf(a), 'NOT_NEW');
  assert.equal(mine.state, 'new', 'the batch is all or nothing');
  assert.equal((await call('POST /dismiss', { user: U.alice, body: { candidate_ids: [bobs.candidate_id] } })).statusCode, 404);
  assert.equal((await call('POST /dismiss', { user: U.alice, body: { candidate_ids: [ID(4041)] } })).statusCode, 404);
  for (const body of [undefined, {}, { candidate_ids: [] }, { candidate_ids: ['x'] }, { candidate_ids: 'x' }, { candidate_ids: Array.from({ length: 201 }, () => mine.candidate_id) }]) {
    assert.equal((await call('POST /dismiss', { user: U.alice, body })).statusCode, 400);
    assert.equal((await call('POST /restore', { user: U.alice, body })).statusCode, 400);
  }
  assert.equal(bobs.state, 'new');
  // restore of a file that is not dismissed is a no-op reported as unchanged
  const r = await call('POST /restore', { user: U.alice, body: { candidate_ids: [mine.candidate_id] } });
  assert.deepEqual(r.body.data.unchanged, [mine.candidate_id]);
});

// ---- undo ------------------------------------------------------------------------------------------------------------------

test('POST /undo removes exactly the junction rows its batch created and returns the candidates to new', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const later = add(w, cand());
  // a row somebody else made for the same sample, which must survive
  w.junctions.sample_data_files.push({ id: ID(4901), sample_id: S1, directus_files_id: ID(3999) });
  const { call } = setup(w);
  const batch1 = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } })).body.data.link_batch_id;
  const batch2 = (await call('POST /link', { user: U.alice, body: { items: [link(later)] } })).body.data.link_batch_id;
  assert.notEqual(batch1, batch2);
  assert.equal(w.junctions.sample_data_files.length, 4);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch1 } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.undone, 2);
  assert.deepEqual(w.junctions.sample_data_files.map((j) => j.directus_files_id).sort(), [ID(3999), later.directus_files_id].sort());
  for (const c of [a, b]) {
    assert.equal(c.state, 'new');
    assert.equal(c.link_batch_id, null);
    assert.equal(c.linked_junction_id, null);
    assert.equal(c.decided_by, null);
  }
  assert.equal(later.state, 'linked', 'the other batch is untouched');
  const deletes = w.items.filter((i) => i.op === 'delete');
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].accountability.user, U.alice, 'deleted as the caller (the rule of the junction applies)');
  assert.equal(actorsOf(w).at(-1).bindings[0], U.alice);
});

test('POST /undo after the record or the file was changed: only the junction row of the batch goes; a row already deleted is skipped', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } })).body.data.link_batch_id;
  // someone deletes one junction row by hand in Data Studio meanwhile
  w.junctions.sample_data_files = w.junctions.sample_data_files.filter((j) => j.directus_files_id !== a.directus_files_id);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.undone, 2);
  assert.equal(w.items.filter((i) => i.op === 'delete').length, 1, 'only the row that still exists is deleted');
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(a.state, 'new');
  assert.equal(b.state, 'new');
});

test('POST /undo: unknown or already undone batch is 404; another person\'s batch is 403 (an administrator may); a refused delete rolls everything back', async () => {
  const w = newWorld();
  const t = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const mine = add(w, cand());
  const { call } = setup(w);
  const teamBatch = (await call('POST /link', { user: U.alice, body: { items: [link(t)] } })).body.data.link_batch_id;
  const myBatch = (await call('POST /link', { user: U.alice, body: { items: [link(mine)] } })).body.data.link_batch_id;
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: ID(4042) } })).statusCode, 404);
  const other = await call('POST /undo', { user: U.bob, body: { link_batch_id: teamBatch } });
  assert.equal(other.statusCode, 403, 'a teammate sees the file but the batch is the linker\'s');
  assert.equal(t.state, 'linked');
  // a delete the junction rule refuses (the person lost edit rights since)
  w.denyDelete = true;
  const refused = await call('POST /undo', { user: U.alice, body: { link_batch_id: myBatch } });
  assert.equal(refused.statusCode, 403);
  assert.equal(mine.state, 'linked');
  assert.equal(w.junctions.sample_data_files.length, 2);
  w.denyDelete = false;
  assert.equal((await call('POST /undo', { user: U.admin, admin: true, body: { link_batch_id: teamBatch } })).statusCode, 200);
  assert.equal(t.state, 'new');
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: myBatch } })).statusCode, 200);
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: myBatch } })).statusCode, 404, 'already undone');
  for (const body of [undefined, {}, { link_batch_id: 'x' }]) assert.equal((await call('POST /undo', { user: U.alice, body })).statusCode, 400);
});

// ---- rescan ----------------------------------------------------------------------------------------------------------------

test('POST /rescan queues one person-scope request; a second within 10 minutes is 429 with the seconds to wait', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const first = await call('POST /rescan', { user: U.alice });
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.data.status, 'queued');
  assert.equal(w.scanRequests.length, 1);
  assert.equal(w.scanRequests[0].person_id, P.alice);
  assert.equal(w.scanRequests[0].requested_by, U.alice);
  const second = await call('POST /rescan', { user: U.alice });
  assert.equal(second.statusCode, 429);
  assert.equal(codeOf(second), 'RATE_LIMITED');
  assert.equal(errorOf(second).extensions.retry_after_seconds, 600);
  assert.equal(second.headers['retry-after'], '600');
  assert.equal(w.scanRequests.length, 1);
  // 9 minutes later: still limited, with the rest of the wait
  w.now = new Date(NOW.getTime() + 9 * 60_000);
  const third = await call('POST /rescan', { user: U.alice });
  assert.equal(third.statusCode, 429);
  assert.equal(errorOf(third).extensions.retry_after_seconds, 60);
  // another person is not limited by Alice
  assert.equal((await call('POST /rescan', { user: U.bob })).statusCode, 202);
  // and after the ten minutes (the request finished), Alice may again
  w.scanRequests[0].status = 'done';
  w.scanRequests[0].finished_at = new Date(NOW.getTime() + 2 * 60_000).toISOString();
  w.now = new Date(NOW.getTime() + 10 * 60_000 + 1000);
  assert.equal((await call('POST /rescan', { user: U.alice })).statusCode, 429, 'the finish counts: ten minutes from it');
  w.now = new Date(NOW.getTime() + 12 * 60_000 + 1000);
  assert.equal((await call('POST /rescan', { user: U.alice })).statusCode, 202);
});

test('POST /rescan: a request still queued or running blocks whatever its age', async () => {
  const w = newWorld();
  const { call } = setup(w);
  assert.equal((await call('POST /rescan', { user: U.alice })).statusCode, 202);
  w.now = new Date(NOW.getTime() + 61 * 60_000);
  const old = await call('POST /rescan', { user: U.alice });
  assert.equal(old.statusCode, 429);
  assert.equal(codeOf(old), 'RATE_LIMITED');
});

test('POST /rescan: a 23505 from the insert (two requests past the check at once) is the same 429', async () => {
  const w = newWorld();
  const { call } = setup(w);
  w.scanRequests.push({ request_id: ID(7778), scope: 'person', person_id: P.alice, requested_by: U.alice, requested_at: new Date(NOW.getTime() - 3600_000).toISOString(), finished_at: null, status: 'queued' });
  // the check query is skipped by the fake, the unique index still fires
  w.skipBlockingCheck = true;
  const res = await call('POST /rescan', { user: U.alice });
  assert.equal(res.statusCode, 429);
  assert.equal(codeOf(res), 'RATE_LIMITED');
  assert.equal(w.scanRequests.length, 1);
});

test('POST /rescan: a login with no person, or a person with no alias and no team folder, is 409 with a reason; the check and the insert share one lock', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const nobody = await call('POST /rescan', { user: U.nobody });
  assert.equal(nobody.statusCode, 409);
  assert.equal(codeOf(nobody), 'NO_FOLDER');
  const dave = await call('POST /rescan', { user: U.dave });
  assert.equal(dave.statusCode, 409);
  assert.equal(codeOf(dave), 'NO_FOLDER');
  assert.equal(w.scanRequests.length, 0);
  await call('POST /rescan', { user: U.alice });
  const names = w.log.filter((l) => l.tx !== null).map((l) => l.name);
  assert.deepEqual(names.slice(0, 4), ['setActor', 'lock', 'rescanBlocking', 'rescanInsert']);
  assert.match(SQL.lock, /pg_advisory_xact_lock/);
});

// ---- prefs -----------------------------------------------------------------------------------------------------------------

test('GET/PUT /prefs round-trips the auto-link switch; off by default; only a real boolean is accepted', async () => {
  const w = newWorld();
  const { call } = setup(w);
  assert.deepEqual((await call('GET /prefs', { user: U.alice })).body.data, { auto_link: false });
  const on = await call('PUT /prefs', { user: U.alice, body: { auto_link: true } });
  assert.equal(on.statusCode, 200);
  assert.deepEqual(on.body.data, { auto_link: true });
  assert.deepEqual((await call('GET /prefs', { user: U.alice })).body.data, { auto_link: true });
  assert.deepEqual((await call('GET /prefs', { user: U.bob })).body.data, { auto_link: false }, 'per person');
  assert.deepEqual((await call('PUT /prefs', { user: U.alice, body: { auto_link: false } })).body.data, { auto_link: false });
  for (const body of [undefined, {}, { auto_link: 'true' }, { auto_link: 1 }, { auto_link: null }, { auto_link: true, extra: 1 }]) {
    const res = await call('PUT /prefs', { user: U.alice, body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(w.prefs.get(U.alice), false);
  assert.equal(actorsOf(w).length, 2, 'both successful writes named the caller');
});

// ---- auto-link (machine) -------------------------------------------------------------------------------------------------

const auto = (w, ids, headers = { 'x-inbox-crawler-secret': SECRET }, opts = {}) => {
  const { call } = opts.setup ?? setup(w);
  return call('POST /auto-link', { body: { candidate_ids: ids }, headers });
};

test('POST /auto-link is machine-only: the secret header, constant-time, and refused when missing, wrong or unconfigured', async () => {
  const w = newWorld();
  const c = add(w, cand());
  w.prefs.set(U.alice, true);
  const s = setup(w);
  const noHeader = await s.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] } });
  assert.equal(noHeader.statusCode, 401);
  const wrong = await s.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] }, headers: { 'x-inbox-crawler-secret': 'b'.repeat(64) } });
  assert.equal(wrong.statusCode, 403);
  const shorter = await s.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] }, headers: { 'x-inbox-crawler-secret': 'b' } });
  assert.equal(shorter.statusCode, 403);
  // a signed-in person (any role, even an administrator) without the secret is not the crawler
  const person = await s.call('POST /auto-link', { user: U.alice, body: { candidate_ids: [c.candidate_id] } });
  assert.equal(person.statusCode, 401);
  const admin = await s.call('POST /auto-link', { user: U.admin, admin: true, body: { candidate_ids: [c.candidate_id] } });
  assert.equal(admin.statusCode, 401);
  assert.equal(c.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  // no secret configured: every call is refused, even one that sends an empty header
  const bare = setup(w, { env: {} });
  for (const headers of [{ 'x-inbox-crawler-secret': SECRET }, { 'x-inbox-crawler-secret': '' }, {}]) {
    const res = await bare.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] }, headers });
    assert.ok([401, 403].includes(res.statusCode), `status ${res.statusCode}`);
  }
  const blank = setup(w, { env: { D1_INBOX_CRAWLER_SECRET: '' } });
  assert.equal((await blank.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] }, headers: { 'x-inbox-crawler-secret': '' } })).statusCode, 403);
  assert.equal(c.state, 'new');
});

test('POST /auto-link: links for an opted-in person as that person (their accountability, their edit rights, their name in the audit)', async () => {
  const w = newWorld();
  const c = add(w, cand());
  w.prefs.set(U.alice, true);
  const res = await auto(w, [c.candidate_id]);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.results[0].status, 'linked');
  assert.match(res.body.data.results[0].link_batch_id, /^[0-9a-f-]{36}$/);
  assert.equal(c.state, 'linked');
  assert.equal(c.link_kind, 'auto');
  assert.equal(c.decided_by, U.alice);
  const created = writesTo(w, SAMPLE_JUNCTION);
  assert.equal(created.length, 1);
  // the accountability is the person's login, not an administrator or the system
  assert.deepEqual(created[0].accountability, { user: U.alice, role: ROLE_MEMBER, roles: [ROLE_MEMBER, ROLE_PARENT], admin: false, app: true, ip: null });
  // the edit check ran as the person
  const read = w.items.find((i) => i.op === 'read');
  assert.equal(read.accountability.user, U.alice);
  assert.equal(read.accountability.admin, false);
  // the audit trigger names the person
  assert.equal(actorsOf(w)[0].bindings[0], U.alice);
});

test('POST /auto-link never links for a person who opted out (or never chose)', async () => {
  const w = newWorld();
  const off = add(w, cand());
  const never = add(w, cand({ owner_person_id: P.bob }));
  w.prefs.set(U.alice, false);
  const res = await auto(w, [off.candidate_id, never.candidate_id]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.results.map((r) => [r.status, r.reason]), [['skipped', 'OPTED_OUT'], ['skipped', 'OPTED_OUT']]);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(off.state, 'new');
});

test('POST /auto-link never links a document, an ambiguous match, a code match, a backlog file, a team file, a copy or a surface scan', async () => {
  const w = newWorld();
  w.prefs.set(U.alice, true);
  const doc = add(w, cand({ kind: 'document' }));
  const other = add(w, cand({ kind: 'other' }));
  const ambiguous = add(w, cand({ suggested_collection: null, suggested_record_id: null, matches: [
    { collection: 'physical_samples', record_id: S1, via: 'short_id', token: 'x' }, { collection: 'physical_samples', record_id: S2, via: 'short_id', token: 'x' }] }));
  const twoButSuggested = add(w, cand({ matches: [
    { collection: 'physical_samples', record_id: S1, via: 'short_id', token: 'x' }, { collection: 'physical_samples', record_id: S3, via: 'short_id', token: 'y' }] }));
  const code = add(w, cand({ match_strength: 'code' }));
  const edge = add(w, cand({ match_strength: 'edge_code' }));
  const none = add(w, cand({ match_strength: 'none', suggested_collection: null, suggested_record_id: null, matches: [] }));
  const backlog = add(w, cand({ origin: 'backlog' }));
  const team = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const dup = add(w, cand({ duplicate_of: doc.candidate_id }));
  const scan = add(w, cand({ kind: 'surface_scan' }));
  const dismissed = add(w, cand({ state: 'dismissed' }));
  const ids = [doc, other, ambiguous, twoButSuggested, code, edge, none, backlog, team, dup, scan, dismissed].map((c) => c.candidate_id);
  const res = await auto(w, ids);
  assert.equal(res.statusCode, 200);
  const reasons = res.body.data.results.map((r) => `${r.status}:${r.reason}`);
  assert.deepEqual(reasons, [
    'skipped:KIND_NOT_ALLOWED', 'skipped:KIND_NOT_ALLOWED', 'skipped:AMBIGUOUS', 'skipped:AMBIGUOUS', 'skipped:NOT_EXACT', 'skipped:NOT_EXACT', 'skipped:NOT_EXACT',
    'skipped:BACKLOG', 'skipped:TEAM_FILE', 'skipped:COPY', 'skipped:SURFACE_SCAN_NOT_AVAILABLE', 'skipped:NOT_NEW',
  ]);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.junctions.operation_data_files.length + w.junctions.session_data_files.length, 0);
});

test('POST /auto-link refuses a record the person cannot edit (view-only, Restricted) and never uses another identity', async () => {
  const w = newWorld();
  w.prefs.set(U.carol, true);
  const viewOnly = add(w, cand({ owner_person_id: P.carol, suggested_record_id: S3, matches: [{ collection: 'physical_samples', record_id: S3, via: 'short_id', token: 'a' }] }));
  const restricted = add(w, cand({ owner_person_id: P.carol, suggested_record_id: S2, matches: [{ collection: 'physical_samples', record_id: S2, via: 'short_id', token: 'b' }] }));
  const res = await auto(w, [viewOnly.candidate_id, restricted.candidate_id]);
  assert.deepEqual(res.body.data.results.map((r) => [r.status, r.reason]), [['skipped', 'NOT_EDITABLE'], ['skipped', 'NOT_EDITABLE']]);
  assert.equal(w.junctions.sample_data_files.length, 0);
  for (const r of w.items.filter((i) => i.op === 'read')) {
    assert.equal(r.accountability.user, U.carol);
    assert.equal(r.accountability.admin, false);
  }
});

test('POST /auto-link: a person with no login, a suspended login or a Lab Viewer is skipped; an admin login is not given extra rights by the machine', async () => {
  const w = newWorld();
  // Fay (Former, suspended login) opted in; Vic is a Lab Viewer
  w.prefs.set(U.former, true);
  w.prefs.set(U.viewer, true);
  w.people.push({ person_id: ID(19), full_name: 'No Login', active: true, uni_alias: 'nol1', user_id: null });
  const former = add(w, cand({ owner_person_id: P.former }));
  const viewer = add(w, cand({ owner_person_id: P.viewer }));
  const nologin = add(w, cand({ owner_person_id: ID(19) }));
  const res = await auto(w, [former.candidate_id, viewer.candidate_id, nologin.candidate_id]);
  assert.deepEqual(res.body.data.results.map((r) => [r.status, r.reason]), [['skipped', 'NO_LOGIN'], ['skipped', 'READ_ONLY_ROLE'], ['skipped', 'NO_LOGIN']]);
  assert.equal(w.junctions.sample_data_files.length, 0);
});

test('POST /auto-link: each candidate is its own batch and transaction; one failure does not stop the next; unknown ids are reported', async () => {
  const w = newWorld();
  w.prefs.set(U.alice, true);
  const a = add(w, cand());
  const b = add(w, cand());
  const c = add(w, cand());
  let n = 0;
  w.failCreateFor = () => { n += 1; if (n === 2) throw new Error('boom'); };
  const res = await auto(w, [a.candidate_id, b.candidate_id, ID(4043), c.candidate_id]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.results.map((r) => r.status), ['linked', 'error', 'skipped', 'linked']);
  assert.equal(res.body.data.results[2].reason, 'NOT_FOUND');
  assert.notEqual(res.body.data.results[0].link_batch_id, res.body.data.results[3].link_batch_id);
  assert.equal(a.state, 'linked');
  assert.equal(b.state, 'new', 'its transaction rolled back');
  assert.equal(c.state, 'linked');
  assert.equal(w.junctions.sample_data_files.length, 2);
  // an auto-link can be undone like any link
  const undo = await w_undo(w, res.body.data.results[0].link_batch_id);
  assert.equal(undo.statusCode, 200);
  assert.equal(a.state, 'new');
});

async function w_undo(w, batch) {
  const { call } = setup(w);
  return call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
}

test('POST /auto-link validates its body: 1 to 200 candidate ids', async () => {
  const w = newWorld();
  const s = setup(w);
  const h = { 'x-inbox-crawler-secret': SECRET };
  for (const body of [undefined, {}, { candidate_ids: [] }, { candidate_ids: ['x'] }, { candidate_ids: 'x' }, { candidate_ids: Array.from({ length: 201 }, () => ID(1)) }]) {
    assert.equal((await s.call('POST /auto-link', { body, headers: h })).statusCode, 400);
  }
  w.prefs.set(U.alice, true);
  const one = add(w, cand());
  assert.equal((await s.call('POST /auto-link', { body: { candidate_id: one.candidate_id }, headers: h })).statusCode, 200, 'a single candidate_id is accepted too');
});

// ---- admin -----------------------------------------------------------------------------------------------------------------

test('GET /admin: administrators only; status, last scan, errors, unmatched folders, people without an alias, queue and totals', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const denied = await call('GET /admin', { user: U.alice });
  assert.equal(denied.statusCode, 403);
  assert.equal(codeOf(denied), 'FORBIDDEN');
  const res = await call('GET /admin', { user: U.admin, admin: true });
  assert.equal(res.statusCode, 200);
  const d = res.body.data;
  assert.equal(d.status.desired_state, 'running');
  assert.equal(d.status.interval_minutes, 30);
  assert.equal(d.status.daemon, 'alive', 'a heartbeat 30 s ago');
  assert.equal(d.status.files_registered, 42);
  assert.deepEqual(d.last_scan, { started_at: '2026-10-15T11:30:00.000Z', finished_at: '2026-10-15T11:45:00.000Z' });
  assert.deepEqual(d.errors, { count: 1, last_error: 'share briefly unreachable' });
  assert.deepEqual(d.unmatched_folders, ['Users/zz9', 'Shared/Old project']);
  assert.deepEqual(d.people_without_alias.map((p) => p.full_name), ['Dave D']);
  assert.deepEqual(d.queue, { queued: 0, running: 0 });
  assert.deepEqual(d.candidates, { new: 5, linked: 2 });
});

test('GET /admin: the daemon is stale after five minutes without a heartbeat, never when it has not run, paused when paused', async () => {
  const w = newWorld();
  const { call } = setup(w);
  w.crawlerState.last_heartbeat_at = new Date(NOW.getTime() - 6 * 60_000);
  assert.equal((await call('GET /admin', { user: U.admin, admin: true })).body.data.status.daemon, 'stale');
  w.crawlerState.last_heartbeat_at = null;
  assert.equal((await call('GET /admin', { user: U.admin, admin: true })).body.data.status.daemon, 'never');
  w.crawlerState.last_heartbeat_at = new Date(NOW.getTime() - 1000);
  w.crawlerState.desired_state = 'paused';
  assert.equal((await call('GET /admin', { user: U.admin, admin: true })).body.data.status.daemon, 'paused');
  w.crawlerState.unmatched_folders = null;
  assert.deepEqual((await call('GET /admin', { user: U.admin, admin: true })).body.data.unmatched_folders, []);
});

test('POST /admin/scan-all: administrators only; queues an all-scope request once; a second while one is waiting is 409 with that request', async () => {
  const w = newWorld();
  const { call } = setup(w);
  assert.equal((await call('POST /admin/scan-all', { user: U.alice })).statusCode, 403);
  assert.equal(w.scanRequests.length, 0);
  const res = await call('POST /admin/scan-all', { user: U.admin, admin: true });
  assert.equal(res.statusCode, 202);
  assert.equal(w.scanRequests.length, 1);
  assert.equal(w.scanRequests[0].scope, 'all');
  assert.equal(w.scanRequests[0].person_id, null);
  assert.equal(w.scanRequests[0].requested_by, U.admin);
  const again = await call('POST /admin/scan-all', { user: U.admin, admin: true });
  assert.equal(again.statusCode, 409);
  assert.equal(codeOf(again), 'ALREADY_QUEUED');
  assert.equal(errorOf(again).extensions.request_id, res.body.data.request_id);
  assert.equal(w.scanRequests.length, 1);
  assert.equal(actorsOf(w).at(0).bindings[0], U.admin);
});

// ---- wiring ------------------------------------------------------------------------------------------------------------------

test('the default export is the endpoint: id d1-inbox, a handler that registers every route', () => {
  assert.equal(endpoint.id, 'd1-inbox');
  const router = fakeRouter();
  endpoint.handler(router, { database: () => {}, services: {}, getSchema: async () => ({}), logger: {}, env: {} });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'GET /admin', 'GET /files', 'GET /prefs', 'GET /summary', 'POST /accept-all', 'POST /admin/scan-all', 'POST /auto-link', 'POST /dismiss',
    'POST /link', 'POST /rescan', 'POST /restore', 'POST /undo', 'PUT /prefs',
  ]);
});

test('no route reads or writes anything outside d1_private and the three junction and record tables', () => {
  const allowed = /d1_private\.|\b(people|teams|team_members|directus_files|directus_users|directus_roles|directus_access|directus_policies|sample_data_files|operation_data_files|session_data_files|physical_samples|manufacturing_operations|test_sessions)\b/;
  const statements = Object.values(SQL).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)));
  for (const text of statements) {
    if (/\bFROM\b|\bINTO\b|\bUPDATE\b/i.test(text)) assert.match(text, allowed, text);
    assert.doesNotMatch(text, /directus_collections|directus_fields|directus_permissions/);
  }
});
