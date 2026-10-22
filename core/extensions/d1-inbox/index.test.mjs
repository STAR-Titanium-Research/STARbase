// Run with: node --test core/extensions/d1-inbox/index.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import endpoint, {
  ERRORS, HttpError, LINK_COLLECTIONS, LINK_TARGETS, SQL, buildListQuery, canChange, canSee, canUndoRow, etagMatches, fileOut, folderOfCandidate, isIgnored, mount, parseFileFilters,
  parseIgnoredFolder, parseScanItem, safeEqual, semAccess, shapeSemSettings, shapeSummary, unfit,
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
const INS1 = ID(201); // a cutting insert every member can read
const INS2 = ID(204);
const EDGE1 = ID(202); // an insert edge every member can read
const MISSING = ID(299); // an id no record has (or none the caller can read: the answer is the same)
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
    auto_undone_at: null,
    ...overrides,
  };
};

// A candidate that names exactly one record (suggestion and matches agree).
const candFor = (collection, record, over = {}) => cand({
  suggested_collection: collection, suggested_record_id: record,
  matches: [{ collection, record_id: record, via: 'short_id', token: 'abcd1234' }], ...over,
});

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
    // records a person may read but not edit (a view-only person on a visible record)
    viewable: { [U.carol]: { physical_samples: new Set([S3]), manufacturing_operations: new Set(), test_sessions: new Set() } },
    prefs: new Map(),
    // stream F1: the surface_scans table (rows as the fake ItemsService keeps them), and the records a scan may name (every non-viewer can read these)
    scanTable: true, scans: [],
    refs: { cutting_inserts: new Set([INS1, INS2]), insert_edges: new Set([EDGE1]), manufacturing_operations: new Set([O1]) },
    labels: { [INS1]: 'INS-001', [EDGE1]: 'INS-001-E1' },
    denyScanCreate: false, denyRefRead: null,
    scanRequests: [],
    // d1_private.file_thumbnails: candidate_id -> { thumb: Buffer, preview: Buffer }
    thumbs: new Map(),
    // the crawler's folder cache (d1_private.inbox_dirs): { rel_path, owner_person_id, owner_team_id, dir_mtime, last_listed_at }
    dirs: [],
    // ignored folders (d1_private.inbox_ignored_dirs): { ignored_id, owner_person_id, owner_team_id, rel_folder, created_at, created_by }
    ignored: [], skipIgnoredFind: false,
    crawlerState: {
      desired_state: 'running', interval_minutes: 30, read_mb_per_s: '60', last_heartbeat_at: new Date('2026-10-15T11:59:30.000Z'),
      daemon_started_at: new Date('2026-10-15T08:00:00.000Z'), current_activity: 'idle', last_scan_started_at: new Date('2026-10-15T11:30:00.000Z'),
      last_scan_finished_at: new Date('2026-10-15T11:45:00.000Z'), files_registered: '42', error_count: 1, last_error: 'share briefly unreachable',
      unmatched_folders: ['Users/zz9', 'Shared/Old project'],
    },
    totals: [{ state: 'new', n: 5 }, { state: 'linked', n: 2 }],
    // canned answers for the dynamic queries and the grouped summary
    listRows: [], listTotal: 0, acceptIds: [], acceptQueries: [], summaryRows: [],
    // failure switches
    denyDelete: false, failCreateFor: null,
    // stream D: the pointer rows of files (owner columns), d1_private.sem_image_settings and sem_settings_access_log
    files: new Map(), settings: new Map(), settingsLog: [], denyJunctionRead: false,
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
// does a row (a rule, a cache row, a candidate) belong to the owner given as the first two bindings (person id, team id; one of them null)?
const sameOwner = (row, b) => (row.owner_person_id ?? null) === (b[0] ?? null) && (row.owner_team_id ?? null) === (b[1] ?? null);
const copy = (v) => structuredClone(v);
// the columns d1_private.sem_image_settings has for the settings, and the ranges its CHECKs hold
const SEM_TEXT = ['detector', 'mode', 'instrument'];
const SEM_KEYS = ['kv', 'spot', 'working_distance_mm', 'magnification', 'hfw_um', 'pixel_size_nm', 'scale_bar_um', ...SEM_TEXT, 'acquired_at'];
const SEM_RANGES = { kv: [0.1, 30], spot: [1, 10], working_distance_mm: [0.1, 50], magnification: [5, 1000000], hfw_um: [Number.MIN_VALUE, Infinity], pixel_size_nm: [Number.MIN_VALUE, Infinity], scale_bar_um: [Number.MIN_VALUE, Infinity] };
// the SQL clause NOT_UNDER_IGNORED, as the fake database evaluates it: is the candidate under one of ITS OWNER's rules? The rule is relative to the owner's root,
// which is the first two parts of the file's own path; whole path parts, ignoring case.
const underIgnoredRule = (w, c) => {
  const root = c.rel_path.split('/').slice(0, 2).join('/');
  const ownRule = (r) => (c.owner_person_id !== null && r.owner_person_id === c.owner_person_id) || (c.owner_team_id !== null && r.owner_team_id === c.owner_team_id);
  return w.ignored.some((r) => ownRule(r)
    && c.rel_path.toLowerCase().startsWith(`${root}/${r.rel_folder}/`.toLowerCase()));
};

// a rollback puts the candidate objects back IN PLACE (the tests hold references to them)
const snapshot = (w) => ({ candidates: [...w.candidates.values()].map((c) => [c, copy(c)]), junctions: copy(w.junctions), scans: copy(w.scans), scanRequests: copy(w.scanRequests), prefs: copy(w.prefs), dirs: copy(w.dirs), settings: copy(w.settings), settingsLog: copy(w.settingsLog), ignored: copy(w.ignored) });
const restore = (w, s) => {
  for (const [obj, saved] of s.candidates) { for (const k of Object.keys(obj)) delete obj[k]; Object.assign(obj, saved); }
  w.junctions = s.junctions; w.scans = s.scans; w.scanRequests = s.scanRequests; w.prefs = s.prefs; w.dirs = s.dirs; w.settings = s.settings; w.settingsLog = s.settingsLog; w.ignored = s.ignored;
};

// the pointer row's owner columns say another owner than the candidate's (a folder that changed hands, C1): the loaders of d1-inbox leave such a candidate out
const restamped = (w, c) => {
  const f = w.files.get(c.directus_files_id);
  return Boolean(f) && (f.owner_person_id !== null || f.owner_team_id !== null) && (f.owner_person_id !== c.owner_person_id || f.owner_team_id !== c.owner_team_id);
};

function statement(w, sql, b, txId) {
  w.log.push({ sql, name: NAMES.get(sql) ?? null, bindings: b, tx: txId });
  const name = NAMES.get(sql);
  if (!name) {
    if (/^SELECT count\(\*\)/.test(sql)) return [{ total: w.listTotal }];
    if (/^SELECT c\.candidate_id, c\.first_seen_at FROM/.test(sql)) {
      // accept-all's page: acceptIds in order, after the keyset cursor (its last binding is the candidate id), at most LIMIT n
      w.acceptQueries.push({ sql, bindings: b });
      const limit = Number(/LIMIT (\d+)/.exec(sql)[1]);
      const ids = /\(c\.first_seen_at, c\.candidate_id\) >/.test(sql) ? w.acceptIds.slice(w.acceptIds.indexOf(b.at(-1)) + 1) : w.acceptIds;
      return ids.slice(0, limit).map((candidate_id) => ({ candidate_id, first_seen_at: w.candidates.get(candidate_id)?.first_seen_at ?? '2026-10-14T10:00:00.000Z' }));
    }
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
    case 'candidatesById': case 'candidatesForUpdate': return csv(b[0]).sort().map((id) => w.candidates.get(id)).filter((c) => c && !restamped(w, c)).map(copy);
    // the same reads without an undecided row that lies under one of its owner's ignored folders (SQL NOT_UNDER_IGNORED), and with the file-owner predicate
    case 'acceptCandidatesById': case 'acceptCandidatesForUpdate':
      return csv(b[0]).sort().map((id) => w.candidates.get(id)).filter((c) => c && !restamped(w, c) && (c.state !== 'new' || !underIgnoredRule(w, c))).map(copy);
    case 'batchForUpdate': return [...w.candidates.values()].filter((c) => c.link_batch_id === b[0] && !restamped(w, c)).sort((x, y) => x.candidate_id.localeCompare(y.candidate_id)).map(copy);
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
          // as the SQL does: an undone AUTO link is remembered (auto_undone_at), so the crawler's auto-link never links the file again
          Object.assign(c, { state: 'new', decided_at: null, decided_by: null, auto_undone_at: c.link_kind === 'auto' ? w.now.toISOString() : c.auto_undone_at,
            link_kind: null, linked_collection: null, linked_junction_id: null, link_batch_id: null });
          out.push({ candidate_id: id });
        }
      }
      return out;
    }
    case 'dismiss': case 'restore': {
      if (name === 'dismiss' && w.failDismiss) throw new Error('disk full');
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
    case 'relistDirs': {
      // the folder cache rows of the folders the given candidates sit in (same path, same owner): forgotten as "listed", so the next scan lists them
      for (const id of csv(b[0])) {
        const c = w.candidates.get(id);
        const parent = c?.rel_path.replace(/\/[^/]*$/, '');
        for (const d of w.dirs) {
          if (c && d.rel_path === parent && d.owner_person_id === c.owner_person_id && d.owner_team_id === c.owner_team_id) Object.assign(d, { last_listed_at: null, dir_mtime: null });
        }
      }
      return [];
    }
    // ignored folders: the owner is the pair of bindings (person id, team id), one of them null
    case 'ignoredList': {
      const teams = csv(b[1]);
      return copy(w.ignored.filter((r) => (b[0] !== null && r.owner_person_id === b[0]) || teams.includes(r.owner_team_id))
        .map((r) => ({ ...r, owner_name: r.owner_person_id ? w.people.find((p) => p.person_id === r.owner_person_id)?.full_name : w.teams.find((t) => t.team_id === r.owner_team_id)?.name }))
        .sort((x, y) => x.rel_folder.toLowerCase().localeCompare(y.rel_folder.toLowerCase()) || x.ignored_id.localeCompare(y.ignored_id)));
    }
    case 'ignoredById': return copy(w.ignored.filter((r) => r.ignored_id === b[0]));
    case 'ignoredOfOwner': return w.ignored.filter((r) => sameOwner(r, b)).map((r) => ({ rel_folder: r.rel_folder }));
    case 'ignoredCount': return [{ n: w.ignored.filter((r) => sameOwner(r, b)).length }];
    case 'ignoredFind': return w.skipIgnoredFind ? [] : w.ignored.filter((r) => sameOwner(r, b) && r.rel_folder.toLowerCase() === b[2].toLowerCase()).map((r) => ({ ignored_id: r.ignored_id }));
    case 'ignoredInsert': {
      // the unique index (owner, lower(rel_folder)) and the table's form CHECKs
      if (w.ignored.some((r) => sameOwner(r, b) && r.rel_folder.toLowerCase() === b[2].toLowerCase())) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      if (b[2] === '' || /^\/|\/$|\/\//.test(b[2]) || b[2].split('/').some((x) => x === '.' || x === '..')) throw Object.assign(new Error('violates check constraint'), { code: '23514' });
      const row = { ignored_id: ID(9500 + w.ignored.length + w.txCount), owner_person_id: b[0], owner_team_id: b[1], rel_folder: b[2], created_at: w.now.toISOString(), created_by: b[3] };
      w.ignored.push(row);
      return [{ ignored_id: row.ignored_id, rel_folder: row.rel_folder, created_at: row.created_at }];
    }
    case 'ignoredDelete': {
      const hit = w.ignored.filter((r) => r.ignored_id === b[0]);
      w.ignored = w.ignored.filter((r) => r.ignored_id !== b[0]);
      return hit.map((r) => ({ ignored_id: r.ignored_id }));
    }
    case 'openUnderFolder': // the owner's open rows only: which of them lie under the rule is decided in JS
      return [...w.candidates.values()].filter((c) => c.state === 'new' && sameOwner(c, b) && !restamped(w, c))
        .sort((x, y) => x.candidate_id.localeCompare(y.candidate_id)).map((c) => ({ candidate_id: c.candidate_id, rel_path: c.rel_path }));
    case 'ignoredResetDirs':
      for (const d of w.dirs) {
        if (sameOwner(d, b) && (d.rel_path.toLowerCase() === b[2].toLowerCase() || d.rel_path.toLowerCase().startsWith(b[3].toLowerCase()))) Object.assign(d, { last_listed_at: null, dir_mtime: null });
      }
      return [];
    case 'prefsGet': return w.prefs.has(b[0]) ? [{ auto_link: w.prefs.get(b[0]) }] : [];
    case 'prefsPut': w.prefs.set(b[0], b[1]); return [{ auto_link: b[1] }];
    case 'rescanBlocking': {
      if (w.failRescan) throw new Error('queue table is down');
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
    case 'thumbMeta.thumb': case 'thumbMeta.preview': {
      // the join of file_candidates and file_thumbnails: no row when the candidate or its picture is missing; etag = md5 of the chosen picture
      const c = w.candidates.get(b[0]);
      const t = w.thumbs.get(b[0]);
      // the file-owner predicate (FILE_OWNER_MATCHES) holds here too: a candidate whose file is stamped to another owner has no row
      if (!c || !t || restamped(w, c)) return [];
      const bytes = t[name.split('.')[1]];
      // a failure marker row (thumb and preview NULL): md5(NULL) is NULL
      const row = { owner_person_id: c.owner_person_id, owner_team_id: c.owner_team_id, state: c.state, etag: bytes ? createHash('md5').update(bytes).digest('hex') : null };
      // a test hook: what happens between the cheap step and the bytes (a picture replaced or removed by the crawler)
      if (w.afterThumbMeta) { const hook = w.afterThumbMeta; w.afterThumbMeta = null; queueMicrotask(() => hook(w)); }
      return [row];
    }
    case 'thumbBytes.thumb': case 'thumbBytes.preview': {
      const t = w.thumbs.get(b[0]);
      const bytes = t ? t[name.split('.')[1]] : null;
      return t ? [{ etag: bytes ? createHash('md5').update(bytes).digest('hex') : null, bytes }] : [];
    }
    case 'summary': case 'summaryWithScans': return copy(w.summaryRows);
    case 'scansOfFiles': return [...new Set(csv(b[0]))].filter((id) => w.scans.some((r) => r.directus_files_id === id)).map((id) => ({ directus_files_id: id }));
    case 'scanTableExists': return [{ available: w.scanTable }];
    case 'scanById': return copy(w.scans.filter((r) => r.scan_id === b[0]).map((r) => ({ id: r.scan_id, insert_id: r.insert_id ?? null, edge_id: r.edge_id ?? null, directus_files_id: r.directus_files_id })));
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
    case 'saveSemSettings': {
      // d1_private.save_sem_settings as the migration describes it: known keys only, merge, manual fields skipped, a row only when some key mapped
      const [fileId, json, readBy] = b;
      const x = JSON.parse(json);
      const mapped = SEM_KEYS.filter((k) => k in x);
      const row = w.settings.get(fileId) ?? (mapped.length ? { directus_files_id: fileId, sources: {}, flags: {}, read_by: readBy, corrected_by: null, corrected_at: null } : null);
      if (row) {
        for (const k of mapped) {
          if (row.sources[k] === 'manual') continue;
          row[k] = k === 'magnification' || SEM_TEXT.includes(k) || k === 'acquired_at' ? x[k] : String(x[k]);
          row.sources[k] = x.sources?.[k] ?? 'metadata';
        }
        row.flags = { ...row.flags, ...(x.flags ?? {}) };
        row.read_by = readBy;
        w.settings.set(fileId, row);
      }
      return [{ saved: w.settings.has(fileId) }];
    }
    case 'deleteUnlinkedSemSettings': {
      const gone = [];
      for (const id of csv(b[0])) {
        const linked = Object.values(w.junctions).some((rows) => rows.some((j) => j.directus_files_id === id)) || w.scans.some((r) => r.directus_files_id === id);
        if (!linked && w.settings.delete(id)) gone.push({ directus_files_id: id });
      }
      return gone;
    }
    case 'semTableExists': return [{ available: w.semTable !== false }];
    case 'semFile': return w.files.has(b[0]) ? [copy(w.files.get(b[0]))] : [];
    case 'semSettingsGet': return w.settings.has(b[0]) ? [copy(w.settings.get(b[0]))] : [];
    case 'semAccessLogInsert': w.settingsLog.push({ directus_files_id: b[0], read_by_user: b[1], reason: b[2] }); return [];
    case 'semCorrect': {
      // d1_private.correct_sem_setting: a known field, a value of its type inside its range, and a row to correct; marks the field manual
      const [fileId, field, json, user] = b;
      const value = JSON.parse(json);
      const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
      if (!SEM_KEYS.includes(field)) refuse('22023', `sem_image_settings.${field} is not a correctable field`);
      if (SEM_TEXT.includes(field) ? typeof value !== 'string' || value.trim() === '' : field === 'acquired_at' ? Number.isNaN(Date.parse(value)) : typeof value !== 'number') refuse('22023', `${json} is not a valid value for ${field}`);
      const range = SEM_RANGES[field];
      if (range && !(value >= range[0] && value <= range[1])) refuse('22023', `value ${json} is out of range for ${field}`);
      const row = w.settings.get(fileId);
      if (!row) refuse('P0002', `no sem_image_settings row for file ${fileId}`);
      row[field] = typeof value === 'number' && field !== 'magnification' ? String(value) : value;
      row.sources[field] = 'manual';
      delete row.flags[field];
      row.corrected_by = user;
      row.corrected_at = w.now.toISOString();
      return [];
    }
    case 'adminState': return [copy(w.crawlerState)];
    // scan progress: the same grouping the SQL does (not gone, not under an owner's ignored rule, the file-owner predicate), by owner
    case 'progressOwners': return copy([
      ...w.people.filter((p) => p.uni_alias).map((p) => ({ kind: 'person', owner_id: p.person_id, name: p.full_name, folder: p.uni_alias, has_login: p.user_id !== null })),
      ...w.teams.filter((t) => t.share_folder).map((t) => ({ kind: 'team', owner_id: t.team_id, name: t.name, folder: t.share_folder, has_login: null })),
    ].sort((x, y) => x.name.localeCompare(y.name)));
    case 'progressDirs': case 'progressFiles': {
      const people = csv(b[0]);
      const teams = csv(b[1]);
      const mine = (r) => people.includes(r.owner_person_id) || teams.includes(r.owner_team_id);
      const groups = new Map();
      const rows = name === 'progressDirs'
        ? w.dirs.filter((d) => mine(d) && !underIgnoredRule(w, { ...d, rel_path: `${d.rel_path}/` }))
        : [...w.candidates.values()].filter((c) => c.state !== 'gone' && mine(c) && !restamped(w, c) && !underIgnoredRule(w, c));
      for (const r of rows) {
        const key = `${r.owner_person_id}|${r.owner_team_id}`;
        const g = groups.get(key) ?? { owner_person_id: r.owner_person_id ?? null, owner_team_id: r.owner_team_id ?? null, rows: [] };
        g.rows.push(r);
        groups.set(key, g);
      }
      return [...groups.values()].map(({ rows: rs, ...owner }) => {
        if (name === 'progressDirs') return { ...owner, folders_known: rs.length, folders_listed: rs.filter((d) => d.last_listed_at).length };
        const images = rs.filter((c) => ['image', 'sem_image'].includes(c.kind));
        const sem = rs.filter((c) => c.kind === 'sem_image');
        return {
          ...owner, files: rs.length, images: images.length, images_read: images.filter((c) => c.classified_by).length,
          images_with_thumb: images.filter((c) => w.thumbs.has(c.candidate_id)).length, sem: sem.length, sem_with_scale: sem.filter((c) => c.extracted?.pixel_size_nm != null).length,
        };
      });
    }
    case 'progressScan': return [{ last_scan_finished_at: w.crawlerState.last_scan_finished_at }];
    case 'adminPeopleWithoutAlias': return copy(w.people.filter((p) => p.active && !p.uni_alias).map((p) => ({ person_id: p.person_id, full_name: p.full_name, has_login: p.user_id !== null })));
    case 'adminFailedRequests': return copy(w.scanRequests.filter((r) => r.status === 'failed').map((r) => ({ at: r.finished_at ?? r.requested_at, error: r.error })));
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
  if (kind === 'junctionFindMany') {
    const records = csv(b[0]);
    const files = csv(b[1]);
    return w.junctions[target.junction].filter((j) => records.some((r, i) => r === j[target.fk] && files[i] === j.directus_files_id))
      .map((j) => ({ record_id: j[target.fk], directus_files_id: j.directus_files_id }));
  }
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
      const junction = Object.values(LINK_TARGETS).find((t) => t.junction === this.collection);
      if (junction) {
        // the read of a junction as the caller (stream D): Directus's junction rule follows the record's read rule, so a row is seen when the record is
        if (w.denyJunctionRead) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
        const record = Object.keys(LINK_TARGETS).find((c) => LINK_TARGETS[c] === junction);
        const user = this.options.accountability.user;
        const allowed = new Set([...(w.editable[user]?.[record] ?? []), ...(w.viewable[user]?.[record] ?? [])]);
        return w.junctions[this.collection].filter((j) => j.directus_files_id === query.filter.directus_files_id._eq && (this.options.accountability.admin === true || allowed.has(j[junction.fk])))
          .slice(0, query.limit ?? 100).map((j) => ({ id: j.id }));
      }
      if (this.collection === 'surface_scans') {
        // the label read of the list: scans as the caller may read them (every member), with the insert or edge nested
        const wanted = new Set(query.filter.scan_id._in);
        return w.scans.filter((r) => wanted.has(r.scan_id)).map((r) => ({
          scan_id: r.scan_id, condition: r.condition,
          insert_id: r.insert_id ? { insert_id: r.insert_id, insert_code: w.labels[r.insert_id] } : null,
          edge_id: r.edge_id ? { edge_id: r.edge_id, edge_code: w.labels[r.edge_id] } : null,
        }));
      }
      if (this.collection === 'insert_edges' && query.filter.edge_id?._in) {
        // the label read of the list (S4): the edges the caller may READ (w.refs.insert_edges), with their codes; w.denyRefRead makes the collection forbidden
        if (w.denyRefRead === 'insert_edges') throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
        return query.filter.edge_id._in.filter((id) => w.refs.insert_edges.has(id)).map((id) => ({ edge_id: id, edge_code: w.labels[id] }));
      }
      const refPk = { cutting_inserts: 'insert_id', insert_edges: 'edge_id', manufacturing_operations: 'operation_id' }[this.collection];
      if (refPk && !query.filter._and && query.filter[refPk]?._eq !== undefined) {
        // the existence read of a scan's insert, edge or operation, as the caller
        if (w.denyRefRead === this.collection) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
        const id = query.filter[refPk]._eq;
        const seen = w.refs[this.collection].has(id);
        return seen ? [{ [refPk]: id }] : [];
      }
      const pk = LINK_TARGETS[this.collection]?.pk;
      const user = this.options.accountability.user;
      if (!query.filter._and) {
        // a label read: { fields: [pk, code], filter: { pk: { _in } } }, answered with what the caller may READ (what they can edit, and what they can view)
        const allowed = new Set([...(w.editable[user]?.[this.collection] ?? []), ...(w.viewable[user]?.[this.collection] ?? [])]);
        const asAdmin = this.options.accountability.admin === true;
        return query.filter[pk]._in.filter((id) => (asAdmin ? w.records[this.collection].has(id) : allowed.has(id)))
          .map((id) => ({ [pk]: id, [query.fields[1]]: `CODE-${id.slice(-4)}` }));
      }
      const first = query.filter._and[0][pk];
      const ids = first._eq !== undefined ? [first._eq] : first._in;
      const allowed = w.editable[user]?.[this.collection] ?? new Set();
      return ids.filter((id) => allowed.has(id)).map((id) => ({ [pk]: id }));
    }

    async createOne(data) {
      w.failCreateFor?.(this.collection, data);
      if (this.collection === 'surface_scans') {
        if (w.denyScanCreate) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
        // the table's unique constraints: one scan per (insert, file) and per (edge, file); Directus answers RECORD_NOT_UNIQUE
        if (w.scans.some((r) => r.directus_files_id === data.directus_files_id && ((data.insert_id && r.insert_id === data.insert_id) || (data.edge_id && r.edge_id === data.edge_id)))) {
          throw Object.assign(new Error('Field has to be unique.'), { status: 400, code: 'RECORD_NOT_UNIQUE' });
        }
        const scanId = ID(6000 + w.scans.length + w.items.length);
        w.scans.push({ scan_id: scanId, ...data, render_status: 'pending' });
        w.items.push({ op: 'create', collection: 'surface_scans', data, accountability: this.options.accountability, knex: this.options.knex, id: scanId });
        return scanId;
      }
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
      if (this.collection === 'surface_scans') {
        w.scans = w.scans.filter((r) => r.scan_id !== id);
        w.items.push({ op: 'delete', collection: 'surface_scans', id, accountability: this.options.accountability, knex: this.options.knex });
        return id;
      }
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
  res.end = (chunk) => { if (chunk !== undefined) res.raw = chunk; res.ended = true; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  return res;
}

let uuidSeq = 0;
function setup(w, { env = { D1_INBOX_CRAWLER_SECRET: SECRET }, schema = {}, deps = {} } = {}) {
  const router = fakeRouter();
  const errors = [];
  const context = {
    database: fakeDatabase(w), services: fakeServices(w), getSchema: async () => schema,
    logger: { warn() {}, error: (m) => errors.push(m), info() {} }, env,
  };
  mount(router, context, { clock: () => w.now, uuid: () => ID(9000 + (uuidSeq += 1)), ...deps });
  const call = async (key, { user, admin = false, role = ROLE_MEMBER, roles, body, query, params, headers } = {}) => {
    const handler = router.routes.get(key);
    assert.ok(handler, `route ${key} is registered`);
    const req = {
      method: key.split(' ')[0],
      accountability: user ? { user, role, ...(roles ? { roles } : {}), admin } : { user: null, role: null, admin: false },
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
  assert.equal(LINK_TARGETS.surface_scans, undefined, 'a surface scan makes a row of its own, not a junction row: it is not a LINK_TARGETS entry');
  assert.deepEqual(LINK_COLLECTIONS, ['physical_samples', 'manufacturing_operations', 'test_sessions', 'surface_scans'], 'what a link item may name (stream F1)');
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

test('parseFileFilters: the names STARbase sends: tab, kind, strength, folder, from, to, owner, link_kind, paging; bad values are 400', () => {
  const ok = parseFileFilters({ tab: 'older', kind: 'sem_image,image', strength: 'short_id,code', folder: ' Run 1 ', from: '2026-10-01', to: '2026-10-15', owner: 'me', link_kind: 'auto', limit: '20', offset: '40' });
  assert.equal(ok.tab, 'older');
  assert.deepEqual(ok.kinds, ['sem_image', 'image']);
  assert.deepEqual(ok.strengths, ['short_id', 'code']);
  assert.equal(ok.folder, 'Run 1');
  assert.equal(ok.date_from, '2026-10-01');
  assert.equal(ok.date_to, '2026-10-15');
  assert.deepEqual(ok.owner, { kind: 'me', id: null });
  assert.equal(ok.link_kind, 'auto');
  assert.equal(ok.limit, 20);
  assert.equal(ok.offset, 40);
  assert.deepEqual(parseFileFilters({ owner: `team:${TEAM}` }).owner, { kind: 'team', id: TEAM });
  assert.deepEqual(parseFileFilters({ owner: `person:${P.bob}` }).owner, { kind: 'person', id: P.bob });
  assert.equal(parseFileFilters({}).tab, 'new');
  assert.equal(parseFileFilters({}, { defaultTab: 'open' }).tab, 'open');
  assert.equal(parseFileFilters({}).limit, 50);
  assert.equal(parseFileFilters({ limit: '9999' }).limit, 200, 'paging is clamped');
  assert.equal(parseFileFilters({ kind: '', folder: '', owner: '' }).kinds, null, 'empty values are left out');
  for (const bad of [{ tab: 'everything' }, { kind: 'movie' }, { strength: 'maybe' }, { from: 'yesterday' }, { to: '2026-13-40' }, { owner: 'nobody' },
    { owner: 'team:nope' }, { owner: 'team' }, { owner: `me:${TEAM}` }, { limit: '-1' }, { limit: 'x' }, { offset: '-5' }, { link_kind: 'telepathy' }, { folder: 'x'.repeat(600) }]) {
    assert.throws(() => parseFileFilters(bad), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(bad));
  }
});

// D11: a copy is shown (marked) while its original is undecided and drops out when the original is linked, or dismissed by the SAME owner. Another owner
// dismissing a file must not hide yours: that copy is listed AND counted (its original no longer counts for anyone).
const SAME_OWNER_SQL = '\\(c\\.owner_person_id IS NOT DISTINCT FROM o\\.owner_person_id AND c\\.owner_team_id IS NOT DISTINCT FROM o\\.owner_team_id\\)';
const COPY_HIDDEN_SQL = new RegExp(`NOT \\(c\\.duplicate_of IS NOT NULL AND \\(o\\.state = 'linked' OR \\(o\\.state = 'dismissed' AND ${SAME_OWNER_SQL}\\)\\)\\)`);
const COUNTED_COPY_SQL = new RegExp(`\\(c\\.duplicate_of IS NULL OR o\\.state = 'gone' OR \\(o\\.state = 'dismissed' AND NOT ${SAME_OWNER_SQL}\\)\\)`);

test('buildListQuery: each tab, the owner scope and the filters are bindings, never text', () => {
  const scope = { personId: P.alice, teamIds: [TEAM, OTHER_TEAM], admin: false };
  const tabs = {
    new: [/c\.state = 'new'/, /c\.origin = 'new'/],
    older: [/c\.state = 'new'/, /c\.origin = 'backlog'/],
    open: [/c\.state = 'new'/],
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
  // a copy drops out of the new, older and open lists once its original was linked, or dismissed by the SAME owner (D11); not the linked and dismissed tabs
  for (const tab of ['new', 'older', 'open']) assert.match(buildListQuery(scope, parseFileFilters({ tab })).sql, COPY_HIDDEN_SQL);
  assert.doesNotMatch(buildListQuery(scope, parseFileFilters({ tab: 'linked' })).sql, /o\.state = 'linked'/);
  assert.doesNotMatch(buildListQuery(scope, parseFileFilters({ tab: 'dismissed' })).sql, /o\.state = 'dismissed'/);
  // filters
  const f = parseFileFilters({ kind: 'sem_image', folder: 'Run1', strength: 'short_id,code', from: '2026-10-01', to: '2026-10-15', link_kind: 'auto', tab: 'linked' });
  const q = buildListQuery(scope, f);
  assert.match(q.sql, /c\.kind = ANY\(/);
  assert.match(q.sql, /c\.match_strength = ANY\(/);
  assert.match(q.sql, /strpos\(lower\(regexp_replace\(c\.rel_path, '\[\^\/\]\*\$', ''\)\), lower\(\?\)\) > 0/, 'the folder part of the path contains the text, any case');
  assert.match(q.sql, /c\.link_kind = \?/);
  for (const b of ['sem_image', 'Run1', 'short_id,code', '2026-10-01', '2026-10-15', 'auto']) assert.ok(q.bindings.includes(b), b);
  // an owner replaces the default scope
  const me = buildListQuery(scope, parseFileFilters({ owner: 'me' }));
  assert.match(me.sql, /c\.owner_person_id = \?/);
  assert.doesNotMatch(me.sql.slice(me.sql.indexOf(' FROM d1_private.file_candidates c ')), /owner_team_id = ANY/, 'the owner scope of the rows is only the person');
  assert.ok(me.bindings.includes(P.alice));
  const one = buildListQuery(scope, parseFileFilters({ owner: `team:${TEAM}` }));
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
  assert.match(accept.sql, /^SELECT c\.candidate_id, c\.first_seen_at FROM/);
  assert.match(accept.sql, /c\.match_strength = 'short_id'/);
  assert.match(accept.sql, /c\.suggested_record_id IS NOT NULL/);
});

test('the summary SQL counts a copy only when no inbox still holds its original (gone, or dismissed by ANOTHER owner), and not a file already on the record it names', () => {
  assert.match(SQL.summary, COUNTED_COPY_SQL, 'a copy counts when its original is gone or dismissed by someone else');
  assert.doesNotMatch(SQL.summary, /o\.state = 'linked'/, 'a copy of a linked original is hidden from the list and never counted');
  for (const { junction, fk } of Object.values(LINK_TARGETS)) {
    assert.match(SQL.summary, new RegExp(`EXISTS \\(SELECT 1 FROM ${junction} j WHERE j\\.${fk} = c\\.suggested_record_id AND j\\.directus_files_id = c\\.directus_files_id\\)`), junction);
  }
  // the list still shows a copy (marked), hiding it only by the rule above
  const list = buildListQuery({ personId: P.alice, teamIds: [], admin: false }, parseFileFilters({})).sql;
  assert.match(list, COPY_HIDDEN_SQL);
});

test('the accept query: no surface scan, no copy, nothing already on its record, exactly one match, keyset paging in (first_seen_at, candidate_id)', () => {
  const scope = { personId: P.alice, teamIds: [], admin: false };
  const f = parseFileFilters({}, { defaultTab: 'open' });
  const first = buildListQuery(scope, f, { accept: true, pageSize: 100 });
  assert.match(first.sql, /^SELECT c\.candidate_id, c\.first_seen_at FROM/);
  assert.match(first.sql, /c\.kind <> 'surface_scan'/);
  assert.match(first.sql, /c\.duplicate_of IS NULL/);
  assert.match(first.sql, /jsonb_array_length\(c\.matches\) = 1/);
  for (const { junction, fk } of Object.values(LINK_TARGETS)) assert.match(first.sql, new RegExp(`NOT \\(c\\.suggested_collection = '[a-z_]+' AND EXISTS \\(SELECT 1 FROM ${junction} j WHERE j\\.${fk} =`), junction);
  assert.match(first.sql, /ORDER BY c\.first_seen_at, c\.candidate_id LIMIT 100$/);
  assert.doesNotMatch(first.sql, /\(c\.first_seen_at, c\.candidate_id\) >/);
  const next = buildListQuery(scope, f, { accept: true, pageSize: 100, after: { at: '2026-10-14T10:00:00.000Z', id: ID(5) } });
  assert.match(next.sql, /\(c\.first_seen_at, c\.candidate_id\) > \(\?::timestamptz, \?::uuid\)/);
  assert.deepEqual(next.bindings.slice(-2), ['2026-10-14T10:00:00.000Z', ID(5)]);
});

test('parseFileFilters: acceptable is a flag, off unless 1 or true', () => {
  assert.equal(parseFileFilters({}).acceptable, false);
  assert.equal(parseFileFilters({ acceptable: '1' }).acceptable, true);
  assert.equal(parseFileFilters({ acceptable: 'true' }).acceptable, true);
  assert.equal(parseFileFilters({ acceptable: '0' }).acceptable, false);
  assert.throws(() => parseFileFilters({ acceptable: 'maybe' }), (e) => e instanceof HttpError && e.status === 400);
});

test('shapeSummary: new count and older-with-exact-match, per person and per team, in the shape inboxSummary.ts reads', () => {
  const scope = { personId: P.alice, teamIds: [TEAM, OTHER_TEAM], admin: false };
  const teams = [{ team_id: TEAM, name: 'SEM team', share_folder: 'SEM' }, { team_id: OTHER_TEAM, name: 'Other team', share_folder: 'Other' }, { team_id: ID(23), name: 'No folder', share_folder: null }];
  const rows = [
    { owner_person_id: P.alice, owner_team_id: null, origin: 'new', exact: false, n: 3 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'new', exact: true, n: 1 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'backlog', exact: false, n: 10 },
    { owner_person_id: P.alice, owner_team_id: null, origin: 'backlog', exact: true, n: 2 },
    { owner_person_id: null, owner_team_id: TEAM, origin: 'new', exact: false, n: 5 },
    { owner_person_id: null, owner_team_id: TEAM, origin: 'backlog', exact: true, n: 4 },
  ];
  const out = shapeSummary(rows, scope, teams, { uni_alias: 'ali1' });
  assert.deepEqual(out.person, { person_id: P.alice, new: 4, older_matches: 2, has_alias: true });
  assert.deepEqual(out.teams, [
    { team_id: TEAM, name: 'SEM team', new: 5, older_matches: 4 },
    { team_id: OTHER_TEAM, name: 'Other team', new: 0, older_matches: 0 },
  ], 'a team with a share folder, with nothing in it, is still listed; one with no folder is not');
  assert.equal(out.new, 9);
  assert.equal(out.older_matches, 6);
  assert.equal(shapeSummary([], scope, [], { uni_alias: null }).person.has_alias, false);
  assert.equal(shapeSummary([], { personId: null, teamIds: [], admin: false }, [], null).person, null);
});

// ---- the wrapper: sign-in, Directus-shaped errors, Lab Viewer ------------------------------------------------------------

const USER_ROUTES = [
  'GET /summary', 'GET /files', 'POST /link', 'POST /relink', 'POST /accept-all', 'POST /dismiss', 'POST /restore', 'POST /undo',
  'POST /rescan', 'GET /prefs', 'PUT /prefs', 'GET /admin', 'POST /admin/scan-all', 'GET /sem-settings', 'PATCH /sem-settings/:file',
  'GET /ignored-folders', 'POST /ignored-folders', 'DELETE /ignored-folders/:id', 'GET /progress',
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
    ['POST /restore', { candidate_ids: [c.candidate_id] }], ['POST /undo', { link_batch_id: ID(1) }], ['POST /relink', { candidate_id: c.candidate_id, collection: 'physical_samples', record_id: S1 }], ['POST /rescan', {}], ['PUT /prefs', { auto_link: true }],
    ['PATCH /sem-settings/:file', { field: 'kv', value: 10 }],
    ['POST /ignored-folders', { folder: 'x' }], ['DELETE /ignored-folders/:id', undefined],
  ];
  for (const [key, body] of writes) {
    const res = await call(key, { user: U.viewer, role: LAB_VIEWER_ROLE_ID, body });
    assert.equal(res.statusCode, 403, key);
    assert.equal(codeOf(res), 'READ_ONLY_ROLE', key);
  }
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.scanRequests.length, 0);
  assert.equal(w.prefs.size, 0);
  assert.equal(w.ignored.length, 0);
  assert.equal(c.state, 'new');
  assert.equal((await call('GET /summary', { user: U.viewer, role: LAB_VIEWER_ROLE_ID })).statusCode, 200);
  assert.equal((await call('GET /prefs', { user: U.viewer, role: LAB_VIEWER_ROLE_ID })).statusCode, 200);
});

// ---- summary ---------------------------------------------------------------------------------------------------------------

test('a Lab Viewer is found from the caller role AND its roles list (as d1-access-guard does), whatever the login says', async () => {
  const w = newWorld();
  const c = add(w, cand());
  const { call } = setup(w);
  const viaList = await call('POST /dismiss', { user: U.alice, roles: [ROLE_MEMBER, LAB_VIEWER_ROLE_ID.toUpperCase()], body: { candidate_ids: [c.candidate_id] } });
  assert.equal(viaList.statusCode, 403);
  assert.equal(codeOf(viaList), 'READ_ONLY_ROLE');
  assert.equal(c.state, 'new');
  assert.equal((await call('POST /dismiss', { user: U.alice, roles: [ROLE_MEMBER], body: { candidate_ids: [c.candidate_id] } })).statusCode, 200);
});

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
  assert.deepEqual(res.body.data.person, { person_id: P.alice, new: 2, older_matches: 3, has_alias: true });
  assert.deepEqual(res.body.data.teams, [{ team_id: TEAM, name: 'SEM team', new: 1, older_matches: 0 }]);
  assert.equal(res.body.data.new, 3);
  assert.equal(res.body.data.older_matches, 3);
  const q = w.log.find((l) => l.name === 'summaryWithScans');
  assert.equal(q.bindings[0], P.alice, 'the person');
  assert.equal(q.bindings[1], TEAM, 'only the teams Alice is an active member of');
  // a person with no alias yet says so (the UI shows "ask an administrator")
  const dave = await call('GET /summary', { user: U.dave });
  assert.equal(dave.body.data.person.has_alias, false);
});

test('GET /summary: a Former (inactive) person is a member of no team; a login with no person sees zeros; an administrator sees only their own', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const former = await call('GET /summary', { user: U.former });
  assert.deepEqual(former.body.data.teams, []);
  assert.equal(w.log.find((l) => l.name === 'summaryWithScans').bindings[1], '');
  w.log.length = 0;
  const nobody = await call('GET /summary', { user: U.nobody });
  assert.equal(nobody.statusCode, 200);
  assert.equal(nobody.body.data.person, null);
  assert.deepEqual(nobody.body.data.teams, []);
  assert.equal(nobody.body.data.new, 0);
  assert.equal(w.log.some((l) => l.name?.startsWith('summary')), false, 'no scope, no query');
  w.log.length = 0;
  await call('GET /summary', { user: U.admin, admin: true });
  const q = w.log.find((l) => l.name === 'summaryWithScans');
  assert.equal(q.bindings[0], P.admin, 'an administrator counts their own folders, not everyone');
});

// ---- files -----------------------------------------------------------------------------------------------------------------

const listRow = (c, over = {}) => ({
  candidate_id: c.candidate_id, directus_files_id: c.directus_files_id, name: 'a.tif', mime_type: 'image/tiff', kind: c.kind, kind_confidence: c.kind_confidence,
  extracted: c.extracted, origin: c.origin, state: c.state, match_strength: c.match_strength, matches: c.matches,
  suggested_collection: c.suggested_collection, suggested_record_id: c.suggested_record_id, duplicate_of: null, duplicate_of_owner: null,
  rel_path: c.rel_path, size_bytes: c.size_bytes, source_mtime: null, first_seen_at: c.first_seen_at, decided_at: null, link_kind: null,
  linked_collection: null, link_batch_id: null, linked_record_id: null, decided_by_name: null,
  owner_person_id: c.owner_person_id, owner_team_id: c.owner_team_id, owner_name: 'Alice A', adopted_at: null,
  duplicate_owner_person_id: null, duplicate_owner_team_id: null,
  ...over,
});

test('GET /files: a page of FoundFile rows (the columns STARbase reads plus labels), total and acceptable in meta', async () => {
  const w = newWorld();
  const a = cand();
  w.listRows = [listRow(a)];
  w.listTotal = 41;
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice, query: { tab: 'new', limit: '10' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.meta, { total: 41, limit: 10, offset: 0, acceptable: null }, 'acceptable is computed only when asked for');
  assert.equal(w.acceptQueries.length, 0, 'no accept plan on a plain list load');
  const [row] = res.body.data;
  assert.equal(row.candidate_id, a.candidate_id);
  assert.equal(row.directus_files_id, a.directus_files_id);
  assert.equal(row.name, 'a.tif');
  assert.equal(row.kind, 'sem_image');
  assert.equal(row.suggested_collection, 'physical_samples');
  assert.equal(row.suggested_record_id, S1);
  assert.equal(row.suggested_label, `CODE-${S1.slice(-4)}`, 'the record code, read as the caller');
  assert.equal(row.suggested_can_edit, true);
  assert.deepEqual(row.matches, [{ collection: 'physical_samples', record_id: S1, via: 'short_id', token: '3fa9c1d2' }]);
  assert.deepEqual(row.owner, { kind: 'person', id: P.alice, name: 'Alice A' });
  assert.equal(row.rel_path, a.rel_path);
  assert.equal(row.duplicate_of, null);
  assert.equal(row.duplicate_of_owner, null);
  for (const key of ['kind_confidence', 'extracted', 'origin', 'state', 'match_strength', 'size_bytes', 'source_mtime', 'first_seen_at', 'decided_at', 'link_kind', 'link_batch_id', 'linked_collection', 'linked_record_id', 'linked_label', 'decided_by_name']) {
    assert.ok(key in row, key);
  }
});

test('GET /files: meta.acceptable (only with acceptable=1) is what Accept all would link for the same filter; not for linked or dismissed', async () => {
  const w = newWorld();
  const ok = add(w, candFor('physical_samples', S1));
  const noEdit = add(w, candFor('physical_samples', S3));
  const doc = add(w, candFor('physical_samples', S1, { kind: 'document' }));
  w.acceptIds = [ok, noEdit, doc].map((c) => c.candidate_id);
  w.listRows = [];
  const { call } = setup(w);
  assert.equal((await call('GET /files', { user: U.alice, query: { tab: 'older' } })).body.meta.acceptable, null);
  assert.equal(w.acceptQueries.length, 0);
  const res = await call('GET /files', { user: U.alice, query: { tab: 'older', acceptable: '1' } });
  assert.equal(res.body.meta.acceptable, 2, 'the image and the document; not the record Alice cannot edit');
  assert.equal(w.candidates.get(ok.candidate_id).state, 'new', 'nothing was written');
  assert.equal(w.log.some((l) => l.name === 'candidatesForUpdate'), false, 'and nothing was locked');
  assert.equal((await call('GET /files', { user: U.alice, query: { tab: 'linked', acceptable: '1' } })).body.meta.acceptable, null);
  assert.equal((await call('GET /files', { user: U.alice, query: { tab: 'dismissed', acceptable: '1' } })).body.meta.acceptable, null);
});

test('GET /files: a record the caller cannot READ is named nowhere (no id, no label, no match); one they can read but not edit says so', async () => {
  const w = newWorld();
  const mine = cand();
  const restricted = cand({ suggested_record_id: S2, matches: [{ collection: 'physical_samples', record_id: S2, via: 'short_id', token: 'bbbbbbbb' }] });
  const ambiguous = cand({ suggested_collection: null, suggested_record_id: null, matches: [{ collection: 'physical_samples', record_id: S1, via: 'short_id', token: 'cccccccc' }, { collection: 'physical_samples', record_id: S2, via: 'short_id', token: 'cccccccc' }] });
  const viewOnly = cand({ owner_person_id: P.carol, suggested_record_id: S3, matches: [{ collection: 'physical_samples', record_id: S3, via: 'short_id', token: 'dddddddd' }] });
  w.listRows = [listRow(mine), listRow(restricted), listRow(ambiguous)];
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice });
  const [a, b, c] = res.body.data;
  assert.equal(a.suggested_record_id, S1);
  assert.equal(b.suggested_record_id, null);
  assert.equal(b.suggested_collection, null);
  assert.equal(b.suggested_label, null);
  assert.deepEqual(b.matches, []);
  assert.ok(!('suggested_can_edit' in b));
  assert.equal(b.match_strength, 'short_id', 'the strength is kept');
  assert.deepEqual(c.matches.map((m) => m.record_id), [S1], 'only the readable match of an ambiguous file');
  assert.equal(JSON.stringify(res.body).includes(S2), false, 'a Restricted record id appears nowhere in the answer');
  // Carol can read S3 but not edit it
  w.listRows = [listRow(viewOnly, { owner_name: 'Carol C' })];
  const carol = await call('GET /files', { user: U.carol });
  assert.equal(carol.body.data[0].suggested_record_id, S3);
  assert.equal(carol.body.data[0].suggested_can_edit, false);
  // an administrator reads everything
  w.listRows = [listRow(restricted)];
  const admin = await call('GET /files', { user: U.admin, admin: true });
  assert.equal(admin.body.data[0].suggested_record_id, S2);
  // the reads ran as the caller
  for (const r of w.items.filter((i) => i.op === 'read' && !i.accountability.admin)) assert.ok([U.alice, U.carol].includes(r.accountability.user));
});

test('GET /files: a linked row names the record it was linked to and who linked it (readable records only)', async () => {
  const w = newWorld();
  const c = cand({ state: 'linked' });
  w.listRows = [listRow(c, { state: 'linked', link_kind: 'auto', linked_collection: 'physical_samples', linked_record_id: S1, link_batch_id: ID(77), decided_by_name: 'Alice A', decided_at: '2026-10-15T10:00:00.000Z' }),
    listRow(c, { state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S2 })];
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice, query: { tab: 'linked', link_kind: 'auto' } });
  const [a, b] = res.body.data;
  assert.equal(a.linked_record_id, S1);
  assert.equal(a.linked_label, `CODE-${S1.slice(-4)}`);
  assert.equal(a.link_kind, 'auto');
  assert.equal(a.link_batch_id, ID(77));
  assert.equal(a.decided_by_name, 'Alice A');
  assert.equal(b.linked_record_id, null, 'a record the caller cannot read');
  assert.equal(b.linked_label, null);
  assert.equal(w.items.filter((i) => i.op === 'read' && i.query.filter._and).length, 0, 'no edit check for a linked row');
});

test('GET /files: a copy names whose Inbox holds the original only to the owner or an owner team member; for anyone else it is { kind: "other" } with no name', async () => {
  const w = newWorld();
  const a = cand();
  const copyOf = (owner) => listRow(a, { duplicate_of: ID(1), duplicate_of_owner: owner.name, duplicate_owner_person_id: owner.person ?? null, duplicate_owner_team_id: owner.team ?? null });
  const askAs = async (user, admin, owner) => {
    w.listRows = [copyOf(owner)];
    const { call } = setup(w);
    return (await call('GET /files', { user, admin })).body.data[0];
  };
  // the caller's own folder, and a team they belong to: the name (a string, as the client has always read it)
  assert.equal((await askAs(U.alice, false, { name: 'Alice A', person: P.alice })).duplicate_of_owner, 'Alice A');
  assert.equal((await askAs(U.alice, false, { name: 'SEM team', team: TEAM })).duplicate_of_owner, 'SEM team');
  assert.equal((await askAs(U.bob, false, { name: 'SEM team', team: TEAM })).duplicate_of_owner, 'SEM team');
  // another person, or a team they are not in: no name, whatever the query returned
  const other = await askAs(U.alice, false, { name: 'Bob B', person: P.bob });
  assert.deepEqual(other.duplicate_of_owner, { kind: 'other' });
  assert.equal(other.duplicate_of, ID(1), 'the copy is still marked as a copy');
  assert.deepEqual((await askAs(U.alice, false, { name: 'Other team', team: OTHER_TEAM })).duplicate_of_owner, { kind: 'other' });
  assert.doesNotMatch(JSON.stringify(other), /Bob B/, 'no name anywhere in the row (the owner of the row is Alice herself)');
  // a Former person is in no team, so a team's name is not theirs to read; an administrator sees every Inbox
  assert.deepEqual((await askAs(U.former, false, { name: 'SEM team', team: TEAM })).duplicate_of_owner, { kind: 'other' });
  assert.equal((await askAs(U.admin, true, { name: 'Bob B', person: P.bob })).duplicate_of_owner, 'Bob B');
  // not a copy: null
  w.listRows = [listRow(a)];
  assert.equal((await setup(w).call('GET /files', { user: U.alice })).body.data[0].duplicate_of_owner, null);
  // a row without the owner ids (nothing known about the original's owner) fails closed
  w.listRows = [listRow(a, { duplicate_of: ID(1), duplicate_of_owner: 'Bob B' })];
  assert.deepEqual((await setup(w).call('GET /files', { user: U.alice })).body.data[0].duplicate_of_owner, { kind: 'other' });
  const { call } = setup(w);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner: `person:${P.bob}` } })).statusCode, 403);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner: `team:${OTHER_TEAM}` } })).statusCode, 403);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner: `team:${TEAM}` } })).statusCode, 200);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner: 'me' } })).statusCode, 200);
  assert.equal((await call('GET /files', { user: U.alice, query: { owner: `person:${P.alice}` } })).statusCode, 200);
  assert.equal((await call('GET /files', { user: U.admin, admin: true, query: { owner: `person:${P.bob}` } })).statusCode, 200);
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
  assert.equal(res.body.data.linked, 1, 'a count, as STARbase reads it');
  assert.equal(res.body.data.items[0].candidate_id, c.candidate_id);
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
  assert.equal(res.body.data.items[0].junction_id, created[0].id);
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
  assert.equal(again.body.data.link_batch_id, null, 'nothing new was linked: never the old batch id');
  assert.equal(again.body.data.linked, 0, 'a count of the newly linked');
  assert.equal(again.body.data.items[0].already_linked, true);
  assert.ok(first.body.data.link_batch_id);
  assert.equal(w.junctions.sample_data_files.length, 1);
  // a different record for an already linked file
  w.editable[U.alice].physical_samples.add(ID(106));
  w.records.physical_samples.add(ID(106));
  const other = await call('POST /link', { user: U.alice, body: { items: [link(c, 'physical_samples', ID(106))] } });
  assert.equal(other.statusCode, 409);
  assert.equal(codeOf(other), 'ALREADY_LINKED');
});

test('POST /link refuses a surface scan linked to a sample (409 SURFACE_SCAN): it is added to an insert or an edge, nothing is written', async () => {
  const w = newWorld();
  const scan = add(w, cand({ kind: 'surface_scan' }));
  const img = add(w, cand());
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(img), link(scan)] } });
  assert.equal(res.statusCode, 409);
  assert.equal(codeOf(res), 'SURFACE_SCAN');
  assert.equal(errorOf(res).extensions.candidate_id, scan.candidate_id);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(img.state, 'new');
});

// ---- adding a surface scan (stream F1) ---------------------------------------------------------------------------------------

// a found .al3d file: the crawler tags it surface_scan and names no record
const scanCand = (over = {}) => cand({
  kind: 'surface_scan', kind_confidence: 1, match_strength: 'none', matches: [], suggested_collection: null, suggested_record_id: null,
  rel_path: `Users/ali1/alicona/edge${seq}.al3d`, ...over,
});
const scanItem = (candidate, over = {}) => ({ candidate_id: candidate.candidate_id, collection: 'surface_scans', insert_id: INS1, condition: 'worn', ...over });
const ACCESS_RULES = JSON.parse(readFileSync(new URL('../../../scripts/access_rules.json', import.meta.url), 'utf8'));
const MEMBER_CREATE_FIELDS = ACCESS_RULES.custom.surface_scans.create.fields;

test('a surface scan item is parsed to what the contract allows: a condition, exactly one of insert and edge, a real day, bounded notes', () => {
  const c = scanCand();
  const ok = parseScanItem(scanItem(c, { operation_id: O1.toUpperCase(), scanned_on: '2026-10-14', condition_note: '  chipped ', notes: 'n' }));
  assert.deepEqual(ok, { condition: 'worn', insertId: INS1, edgeId: null, operationId: O1, scannedOn: '2026-10-14', conditionNote: 'chipped', notes: 'n' });
  assert.deepEqual(parseScanItem({ candidate_id: c.candidate_id, edge_id: EDGE1, condition: 'other', notes: '', scanned_on: '' }),
    { condition: 'other', insertId: null, edgeId: EDGE1, operationId: null, scannedOn: null, conditionNote: null, notes: null });
  for (const condition of ['new', 'worn', 'cleaned', 'other']) assert.equal(parseScanItem(scanItem(c, { condition })).condition, condition);
});

test('POST /link, surface scan: every invalid item is 400 INVALID_PAYLOAD naming the field; no transaction is opened and nothing is checked or written', async () => {
  const w = newWorld();
  const c = add(w, scanCand());
  const { call } = setup(w);
  const bad = [
    ['condition', scanItem(c, { condition: undefined })],
    ['condition', scanItem(c, { condition: null })],
    ['condition', scanItem(c, { condition: '' })],
    ['condition', scanItem(c, { condition: 'broken' })],
    ['condition', scanItem(c, { condition: 'Worn' })],
    ['condition', scanItem(c, { condition: ['worn'] })],
    ['edge_id', scanItem(c, { edge_id: EDGE1 })], // both
    ['insert_id', scanItem(c, { insert_id: undefined })], // neither
    ['insert_id', scanItem(c, { insert_id: 'nope' })],
    ['edge_id', scanItem(c, { insert_id: undefined, edge_id: 'nope' })],
    ['operation_id', scanItem(c, { operation_id: 'nope' })],
    ['scanned_on', scanItem(c, { scanned_on: '2026-13-40' })],
    ['scanned_on', scanItem(c, { scanned_on: '2026-02-30' })],
    ['scanned_on', scanItem(c, { scanned_on: '15/10/2026' })],
    ['scanned_on', scanItem(c, { scanned_on: 20261015 })],
    ['notes', scanItem(c, { notes: 'x'.repeat(2001) })],
    ['notes', scanItem(c, { notes: { text: 'x' } })],
    ['condition_note', scanItem(c, { condition_note: 'x'.repeat(501) })],
  ];
  for (const [field, item] of bad) {
    const res = await call('POST /link', { user: U.alice, body: { items: [item] } });
    assert.equal(res.statusCode, 400, `${field}: ${JSON.stringify(item).slice(0, 90)}`);
    assert.equal(codeOf(res), 'INVALID_PAYLOAD');
    assert.equal(errorOf(res).extensions.field, field, JSON.stringify(item).slice(0, 90));
    assert.equal(errorOf(res).extensions.candidate_id, c.candidate_id);
  }
  // the limits are inclusive: 2000 characters of notes and 500 of condition note are fine
  assert.doesNotThrow(() => parseScanItem(scanItem(c, { notes: 'x'.repeat(2000), condition_note: 'x'.repeat(500) })));
  assert.equal(w.txCount, 0, 'no transaction for a bad body');
  assert.equal(w.log.some((l) => l.name === 'scanTableExists'), false, 'validation comes before the table check');
  assert.equal(w.scans.length, 0);
});

test('POST /link, surface scan: an insert gets a scan created as the caller, the candidate is marked linked in the same transaction', async () => {
  const w = newWorld();
  const c = add(w, scanCand());
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [scanItem(c)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const batch = res.body.data.link_batch_id;
  assert.match(batch, /^[0-9a-f-]{36}$/);
  assert.equal(res.body.data.linked, 1);
  const created = writesTo(w, 'surface_scans');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].data, { insert_id: INS1, directus_files_id: c.directus_files_id, condition: 'worn' }, 'only what was given: no operation, date, note or owner');
  assert.equal(created[0].accountability.user, U.alice, 'created as the caller, so permissions and the owner hook apply');
  assert.equal(created[0].accountability.admin, false);
  assert.ok(created[0].knex?.isTransaction, 'inside the one transaction');
  assert.deepEqual(res.body.data.items, [{
    candidate_id: c.candidate_id, collection: 'surface_scans', record_id: created[0].id, junction_id: created[0].id, insert_id: INS1, edge_id: null, adopted: false,
  }]);
  assert.equal(c.state, 'linked');
  assert.equal(c.decided_by, U.alice);
  assert.equal(c.link_kind, 'manual');
  assert.equal(c.linked_collection, 'surface_scans');
  assert.equal(c.linked_junction_id, created[0].id, 'the new scan id: the four link columns go together');
  assert.equal(c.link_batch_id, batch);
  assert.equal(c.adopted_at, null, 'a surface scan is read by the viewer worker, not adopted for hashing here');
  assert.equal(w.junctions.sample_data_files.length + w.junctions.operation_data_files.length + w.junctions.session_data_files.length, 0, 'no junction row');
  assert.equal(w.scans[0].render_status, 'pending', 'the default queues the render');
  const tx = w.log.filter((l) => l.tx !== null);
  assert.equal(tx[0].name, 'setActor');
  assert.deepEqual(tx[0].bindings, [U.alice]);
});

test('POST /link, surface scan: an edge with the operation, day and notes; the optional fields are sent when given', async () => {
  const w = newWorld();
  const c = add(w, scanCand());
  const { call } = setup(w);
  const res = await call('POST /link', {
    user: U.alice,
    body: { items: [{ candidate_id: c.candidate_id, collection: 'surface_scans', edge_id: EDGE1, condition: 'cleaned', operation_id: O1, scanned_on: '2026-10-14', condition_note: 'ultrasonic bath', notes: ' after pass 3 ' }] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(writesTo(w, 'surface_scans')[0].data, {
    edge_id: EDGE1, directus_files_id: c.directus_files_id, condition: 'cleaned', condition_note: 'ultrasonic bath', scanned_on: '2026-10-14', operation_id: O1, notes: 'after pass 3',
  });
  assert.deepEqual(res.body.data.items[0].insert_id, null);
  assert.equal(res.body.data.items[0].edge_id, EDGE1);
});

test('POST /link, surface scan: only the fields the contract lets a Lab Member send reach the table, whatever the client puts in the item', async () => {
  const w = newWorld();
  const c = add(w, scanCand());
  const { call } = setup(w);
  const worker = {
    scan_id: ID(9999), render_status: 'done', render_error: 'x', rendered_at: '2026-10-15T00:00:00Z', cache_key: 'abc', source_format: 'al3d', source_width: 1, source_height: 1,
    grid_width: 1, grid_height: 1, pixel_pitch_x_um: 1, pixel_pitch_y_um: 1, z_min_um: 1, z_max_um: 2, owner: U.bob, owner_person_id: P.bob, created_at: 'x', updated_at: 'x', version: 7, record_id: S1,
  };
  const res = await call('POST /link', { user: U.alice, body: { items: [scanItem(c, { ...worker, operation_id: O1, scanned_on: '2026-10-14', condition_note: 'c', notes: 'n' })] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const sent = Object.keys(writesTo(w, 'surface_scans')[0].data).sort();
  assert.deepEqual(sent, ['condition', 'condition_note', 'directus_files_id', 'insert_id', 'notes', 'operation_id', 'scanned_on']);
  for (const key of sent) assert.ok(MEMBER_CREATE_FIELDS.includes(key), `${key} is in the Lab Member create list of scripts/access_rules.json`);
  assert.doesNotMatch(sent.join(), /render_|cache_key|source_|grid_|pixel_pitch_|z_m|owner/);
  assert.equal(w.scans[0].render_status, 'pending', 'the worker owns render_status; the endpoint left the default');
});

test('POST /link, surface scan: the candidate must be a surface scan (409 NOT_A_SURFACE_SCAN); a surface scan is never linked to a sample (409 SURFACE_SCAN)', async () => {
  const w = newWorld();
  const image = add(w, cand());
  const doc = add(w, cand({ kind: 'document' }));
  const scan = add(w, scanCand());
  const { call } = setup(w);
  for (const other of [image, doc]) {
    const res = await call('POST /link', { user: U.alice, body: { items: [scanItem(other)] } });
    assert.equal(res.statusCode, 409);
    assert.equal(codeOf(res), 'NOT_A_SURFACE_SCAN');
    assert.equal(errorOf(res).extensions.candidate_id, other.candidate_id);
  }
  for (const [collection, record] of [['physical_samples', S1], ['manufacturing_operations', O1], ['test_sessions', T1]]) {
    const res = await call('POST /link', { user: U.alice, body: { items: [link(scan, collection, record)] } });
    assert.equal(res.statusCode, 409, collection);
    assert.equal(codeOf(res), 'SURFACE_SCAN');
    assert.match(errorOf(res).message, /^A surface scan is added to an insert or an edge/);
  }
  assert.equal(w.scans.length, 0);
  assert.equal(scan.state, 'new');
  assert.equal(image.state, 'new');
});

test('POST /link, surface scan: a batch of a sample link and a scan is one transaction, one batch id; link_kind is bulk', async () => {
  const w = newWorld();
  const img = add(w, cand());
  const scan = add(w, scanCand());
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(img), scanItem(scan, { edge_id: undefined, insert_id: INS2, condition: 'new' })] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.linked, 2);
  assert.equal(img.link_batch_id, scan.link_batch_id);
  assert.equal(scan.link_batch_id, res.body.data.link_batch_id);
  assert.equal(img.link_kind, 'bulk');
  assert.equal(scan.link_kind, 'bulk');
  assert.equal(w.junctions.sample_data_files.length, 1);
  assert.equal(w.scans.length, 1);
  assert.deepEqual(res.body.data.items.map((i) => i.collection), ['physical_samples', 'surface_scans']);
  assert.equal(w.txCount, 1, 'one transaction for both');
  // the edit check still applies to the sample half: a sample the caller cannot edit stops the whole batch, scan included
  const img2 = add(w, cand());
  const scan2 = add(w, scanCand());
  const refused = await call('POST /link', { user: U.alice, body: { items: [link(img2, 'physical_samples', S2), scanItem(scan2)] } });
  assert.equal(refused.statusCode, 403);
  assert.equal(w.scans.length, 1, 'the scan of the refused batch was never written');
  assert.equal(scan2.state, 'new');
});

test('POST /link, surface scan: a unique violation (the file is already a scan of that insert or edge) is 409 ALREADY_ADDED and the whole batch rolls back', async () => {
  const w = newWorld();
  const img = add(w, cand());
  const scan = add(w, scanCand());
  // someone added this file to INS1 in Data Studio already
  w.scans.push({ scan_id: ID(4801), insert_id: INS1, directus_files_id: scan.directus_files_id, condition: 'new', render_status: 'done' });
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(img), scanItem(scan)] } });
  assert.equal(res.statusCode, 409);
  assert.equal(codeOf(res), 'ALREADY_ADDED');
  assert.equal(errorOf(res).message, 'That file is already a surface scan of this insert or edge.');
  assert.equal(errorOf(res).extensions.candidate_id, scan.candidate_id);
  assert.equal(w.junctions.sample_data_files.length, 0, 'the sample link made before the scan rolled back');
  assert.equal(w.scans.length, 1, 'only the scan that was already there');
  assert.equal(img.state, 'new');
  assert.equal(scan.state, 'new');
  assert.equal(scan.link_batch_id, null);
  // a file that already has a scan is treated like an already-linked file (S5): another insert or edge is refused the same way
  const other = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan, { insert_id: undefined, edge_id: EDGE1 })] } });
  assert.equal(other.statusCode, 409);
  assert.equal(codeOf(other), 'ALREADY_ADDED');
  assert.equal(w.scans.length, 1);
  // the raw Postgres code is the same answer
  const w2 = newWorld();
  const scan2 = add(w2, scanCand());
  w2.failCreateFor = (collection) => { if (collection === 'surface_scans') throw Object.assign(new Error('duplicate key'), { code: '23505' }); };
  assert.equal(codeOf(await setup(w2).call('POST /link', { user: U.alice, body: { items: [scanItem(scan2)] } })), 'ALREADY_ADDED');
});

test('POST /link, surface scan: no surface_scans table yet is 409 SURFACE_SCANS_UNAVAILABLE before any transaction; samples still link; a yes is asked once', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  const img = add(w, cand());
  const { call } = setup(w);
  w.scanTable = false;
  const res = await call('POST /link', { user: U.alice, body: { items: [link(img), scanItem(scan)] } });
  assert.equal(res.statusCode, 409);
  assert.equal(codeOf(res), 'SURFACE_SCANS_UNAVAILABLE');
  assert.equal(errorOf(res).message, 'Surface scans are not available yet.');
  assert.equal(w.txCount, 0);
  assert.equal(img.state, 'new', 'nothing was linked');
  // a link that names no scan never asks
  const before = w.log.filter((l) => l.name === 'scanTableExists').length;
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [link(img)] } })).statusCode, 200);
  assert.equal(w.log.filter((l) => l.name === 'scanTableExists').length, before);
  // the migration lands: the next request sees it, and then the answer is remembered
  w.scanTable = true;
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } })).statusCode, 200);
  const scan2 = add(w, scanCand());
  w.scanTable = false;
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [scanItem(scan2)] } })).statusCode, 200, 'a table that was there is not asked about again');
  assert.equal(w.log.filter((l) => l.name === 'scanTableExists').length, before + 1);
});

test('POST /link, surface scan: a Lab Viewer is refused as for any link (READ_ONLY_ROLE), nothing is written', async () => {
  const w = newWorld();
  const scan = add(w, scanCand({ owner_person_id: P.viewer }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.viewer, role: LAB_VIEWER_ROLE_ID, body: { items: [scanItem(scan)] } });
  assert.equal(res.statusCode, 403);
  assert.equal(codeOf(res), 'READ_ONLY_ROLE');
  assert.equal(w.scans.length, 0);
  assert.equal(w.txCount, 0);
  assert.equal(scan.state, 'new');
});

// S5: a found .al3d that someone added through the Alicona feature's own dialog has a surface_scans row. The Inbox treats it like a file already linked.
test('POST /link, surface scan: a file that already has a scan (added through the Alicona dialog) is 409 ALREADY_ADDED up front, before any record is read or written', async () => {
  const w = newWorld();
  const done = add(w, scanCand());
  const fresh = add(w, scanCand());
  w.scans.push({ scan_id: ID(4802), edge_id: EDGE1, directus_files_id: done.directus_files_id, condition: 'worn', render_status: 'done' });
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [scanItem(fresh, { condition: 'new' }), scanItem(done, { insert_id: INS2 })] } });
  assert.equal(res.statusCode, 409);
  assert.equal(codeOf(res), 'ALREADY_ADDED');
  assert.equal(errorOf(res).extensions.candidate_id, done.candidate_id);
  assert.equal(w.items.filter((i) => i.collection === 'cutting_inserts').length, 0, 'refused before the insert or edge was even read');
  assert.equal(writesTo(w, 'surface_scans').length, 0);
  assert.equal(w.scans.length, 1);
  assert.equal(done.state, 'new');
  assert.equal(fresh.state, 'new', 'all or nothing');
  assert.equal(w.log.filter((l) => l.name === 'scansOfFiles').length, 1, 'one query for the whole request');
  // the other file alone is fine, and a repeat of ITS add is the idempotent answer, not this refusal
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [scanItem(fresh)] } })).statusCode, 200);
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [scanItem(fresh)] } })).body.data.items[0].already_linked, true);
});

test('POST /link: a surface scan file that already has a scan is still never linked to a sample, operation or test (409 SURFACE_SCAN)', async () => {
  const w = newWorld();
  const done = add(w, scanCand());
  w.scans.push({ scan_id: ID(4803), insert_id: INS1, directus_files_id: done.directus_files_id, condition: 'worn', render_status: 'done' });
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(done)] } });
  assert.equal(codeOf(res), 'SURFACE_SCAN');
});

test('GET /summary: counts exclude undecided surface scan files that already have a scan, where the table exists; an older database uses the old query', async () => {
  const w = newWorld();
  const { call } = setup(w);
  await call('GET /summary', { user: U.alice });
  assert.equal(w.log.filter((l) => l.name === 'summaryWithScans').length, 1);
  assert.equal(w.log.filter((l) => l.name === 'summary').length, 0);
  assert.match(SQL.summaryWithScans, /NOT \(c\.kind = 'surface_scan' AND EXISTS \(SELECT 1 FROM surface_scans s WHERE s\.directus_files_id = c\.directus_files_id\)\)/);
  assert.doesNotMatch(SQL.summary, /surface_scans/, 'the plain query must run where the table does not exist yet');
  // a database without the table (an older one): the plain query, and no read of surface_scans anywhere
  const old = newWorld();
  old.scanTable = false;
  await setup(old).call('GET /summary', { user: U.alice });
  assert.equal(old.log.filter((l) => l.name === 'summary').length, 1);
  assert.equal(old.log.filter((l) => l.name === 'summaryWithScans').length, 0);
  assert.equal(old.log.some((l) => /surface_scans/.test(l.sql) && l.name !== 'scanTableExists'), false);
});

test('GET /files: the new, older and open lists (and their totals) leave out undecided surface scan files that already have a scan; linked and dismissed keep them', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const clause = /NOT \(c\.kind = 'surface_scan' AND EXISTS \(SELECT 1 FROM surface_scans s WHERE s\.directus_files_id = c\.directus_files_id\)\)/;
  const sqlOf = () => w.log.filter((l) => !l.name && /^SELECT /.test(l.sql)).map((l) => l.sql);
  for (const tab of ['new', 'older', 'open']) {
    w.log.length = 0;
    assert.equal((await call('GET /files', { user: U.alice, query: { tab } })).statusCode, 200);
    const queries = sqlOf();
    assert.equal(queries.length, 2, `${tab}: the page and its total`);
    for (const q of queries) assert.match(q, clause, tab);
  }
  for (const tab of ['linked', 'dismissed']) {
    w.log.length = 0;
    await call('GET /files', { user: U.alice, query: { tab } });
    for (const q of sqlOf()) assert.doesNotMatch(q, /FROM surface_scans/, tab);
  }
  // an older database: no table, so the clause is not in the SQL at all
  const old = newWorld();
  old.scanTable = false;
  await setup(old).call('GET /files', { user: U.alice, query: { tab: 'new' } });
  for (const l of old.log.filter((x) => !x.name && /^SELECT /.test(x.sql))) assert.doesNotMatch(l.sql, /FROM surface_scans/);
});

test('the SQL: buildListQuery adds the scan exclusion only when asked, for undecided tabs only, and never to accept-all (it never takes a scan)', () => {
  const scope = { personId: P.alice, teamIds: [], admin: false };
  const clause = /surface_scans s WHERE s\.directus_files_id = c\.directus_files_id/;
  for (const tab of ['new', 'older', 'open']) {
    const f = parseFileFilters({ tab });
    assert.doesNotMatch(buildListQuery(scope, f).sql, clause, 'off by default (older databases)');
    assert.match(buildListQuery(scope, f, { scans: true }).sql, clause);
    assert.match(buildListQuery(scope, f, { scans: true, count: true }).sql, clause);
  }
  for (const tab of ['linked', 'dismissed']) assert.doesNotMatch(buildListQuery(scope, parseFileFilters({ tab }), { scans: true }).sql, clause);
  assert.doesNotMatch(buildListQuery(scope, parseFileFilters({}, { defaultTab: 'open' }), { accept: true, scans: true }).sql, clause);
});

test('POST /link, surface scan: a foreign key violation at create (the insert, edge, operation or file vanished) is 404 NOT_FOUND naming collection surface_scans, as the client reads it', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  w.failCreateFor = (collection) => { if (collection === 'surface_scans') throw Object.assign(new Error('fk'), { code: 'INVALID_FOREIGN_KEY' }); };
  const res = await setup(w).call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  assert.equal(res.statusCode, 404);
  assert.equal(codeOf(res), 'NOT_FOUND');
  assert.equal(errorOf(res).extensions.collection, 'surface_scans');
  // a file that is not the caller's to see is a 404 too, but without it: the client says "not in your inbox"
  const other = add(w, scanCand({ owner_person_id: P.carol }));
  w.failCreateFor = null;
  const gone = await setup(w).call('POST /link', { user: U.alice, body: { items: [scanItem(other)] } });
  assert.equal(codeOf(gone), 'NOT_FOUND');
  assert.equal(errorOf(gone).extensions.collection, undefined);
  assert.equal(errorOf(gone).message, 'That file is not in your inbox.');
});

test('POST /link, surface scan: a missing insert, edge or operation (or one the caller cannot read) is 404; a refused read or create is 403; nothing stays written', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  const { call } = setup(w);
  for (const [item, what] of [
    [scanItem(scan, { insert_id: MISSING }), 'insert'],
    [scanItem(scan, { insert_id: undefined, edge_id: MISSING }), 'edge'],
    [scanItem(scan, { operation_id: MISSING }), 'operation'],
  ]) {
    const res = await call('POST /link', { user: U.alice, body: { items: [item] } });
    assert.equal(res.statusCode, 404, what);
    assert.equal(codeOf(res), 'NOT_FOUND');
    assert.match(errorOf(res).message, new RegExp(`That ${what} does not exist`));
    assert.equal(errorOf(res).extensions.candidate_id, scan.candidate_id);
  }
  w.denyRefRead = 'cutting_inserts';
  const denied = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  assert.equal(denied.statusCode, 403);
  assert.equal(codeOf(denied), 'FORBIDDEN');
  w.denyRefRead = null;
  w.denyScanCreate = true;
  const noCreate = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  assert.equal(noCreate.statusCode, 403);
  assert.equal(codeOf(noCreate), 'FORBIDDEN');
  assert.match(errorOf(noCreate).message, /not allowed to add surface scans/);
  assert.equal(w.scans.length, 0);
  assert.equal(scan.state, 'new');
  // the existence reads ran as the caller, inside the transaction
  const reads = w.items.filter((i) => i.op === 'read' && i.collection === 'cutting_inserts');
  assert.ok(reads.length >= 1);
  assert.equal(reads[0].accountability.user, U.alice);
  assert.ok(reads[0].knex?.isTransaction);
});

test('POST /link, surface scan: a candidate that is not the caller\'s to see is 404; a team file can be added by any active member', async () => {
  const w = newWorld();
  const others = add(w, scanCand({ owner_person_id: P.carol }));
  const team = add(w, scanCand({ owner_person_id: null, owner_team_id: TEAM }));
  const { call } = setup(w);
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [scanItem(others)] } })).statusCode, 404);
  assert.equal((await call('POST /link', { user: U.carol, body: { items: [scanItem(team)] } })).statusCode, 404);
  const res = await call('POST /link', { user: U.bob, body: { items: [scanItem(team)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writesTo(w, 'surface_scans')[0].accountability.user, U.bob);
});

test('POST /link, surface scan: an administrator adds one with their own accountability (the endpoint never adds admin rights)', async () => {
  const w = newWorld();
  const scan = add(w, scanCand({ owner_person_id: P.admin }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.admin, admin: true, role: ID(80), body: { items: [scanItem(scan)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(writesTo(w, 'surface_scans')[0].accountability.user, U.admin);
});

test('POST /link, surface scan: the same person repeating the same add is idempotent (no second row, no new batch); another insert is 409 ALREADY_LINKED', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  const { call } = setup(w);
  const first = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  const again = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.link_batch_id, null);
  assert.equal(again.body.data.linked, 0);
  assert.equal(again.body.data.items[0].already_linked, true);
  assert.equal(again.body.data.items[0].record_id, first.body.data.items[0].record_id);
  assert.equal(w.scans.length, 1);
  const other = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan, { insert_id: INS2 })] } });
  assert.equal(other.statusCode, 409);
  assert.equal(codeOf(other), 'ALREADY_LINKED');
  const edge = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan, { insert_id: undefined, edge_id: EDGE1 })] } });
  assert.equal(codeOf(edge), 'ALREADY_LINKED');
  const bob = add(w, scanCand({ owner_person_id: null, owner_team_id: TEAM }));
  await call('POST /link', { user: U.alice, body: { items: [scanItem(bob)] } });
  assert.equal(codeOf(await call('POST /link', { user: U.bob, body: { items: [scanItem(bob)] } })), 'ALREADY_LINKED', 'a teammate\'s add is not yours to repeat');
});

test('POST /link, surface scan: a dismissed scan file is 409 NOT_NEW, nothing written', async () => {
  const w = newWorld();
  const scan = add(w, scanCand({ state: 'dismissed' }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  assert.equal(res.statusCode, 409);
  assert.equal(codeOf(res), 'NOT_NEW');
  assert.equal(w.scans.length, 0);
});

test('POST /link, surface scan: the data cache is cleared after the commit when CACHE_ENABLED', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  const { call } = setup(w, { env: { D1_INBOX_CRAWLER_SECRET: SECRET, CACHE_ENABLED: 'true' } });
  await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } });
  assert.equal(w.cacheCleared, 1);
});

test('POST /accept-all and /auto-link keep refusing a surface scan (it needs a condition a person chooses)', async () => {
  const w = newWorld();
  const scan = add(w, candFor('physical_samples', S1, { kind: 'surface_scan' }));
  const { call } = setup(w);
  const dry = await call('POST /accept-all', { user: U.alice, body: { dry_run: true, candidate_ids: [scan.candidate_id] } });
  assert.equal(dry.body.data.count, 0);
  assert.deepEqual(dry.body.data.skipped, [{ candidate_id: scan.candidate_id, reason: 'SURFACE_SCAN' }]);
  w.prefs.set(U.alice, true);
  const auto = await call('POST /auto-link', { headers: { 'x-inbox-crawler-secret': SECRET }, body: { candidate_ids: [scan.candidate_id] } });
  assert.deepEqual(auto.body.data.results, [{ candidate_id: scan.candidate_id, status: 'skipped', reason: 'SURFACE_SCAN' }]);
  assert.equal(w.scans.length, 0);
});

// ---- undo of a scan batch ----------------------------------------------------------------------------------------------------

test('POST /undo of a batch that added scans deletes only the scan rows it made, as the caller, and returns the candidates to new', async () => {
  const w = newWorld();
  const img = add(w, cand());
  const scan = add(w, scanCand());
  const keep = add(w, scanCand());
  // another scan, somebody else's, of the same insert
  w.scans.push({ scan_id: ID(4802), insert_id: INS1, directus_files_id: ID(3998), condition: 'new', render_status: 'done' });
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(img), scanItem(scan)] } })).body.data.link_batch_id;
  await call('POST /link', { user: U.alice, body: { items: [scanItem(keep, { condition: 'new' })] } });
  assert.equal(w.scans.length, 3);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.undone, 2);
  assert.deepEqual(w.scans.map((r) => r.directus_files_id).sort(), [ID(3998), keep.directus_files_id].sort(), 'the other batch\'s scan and somebody else\'s stay');
  assert.equal(w.junctions.sample_data_files.length, 0);
  for (const c of [img, scan]) {
    assert.equal(c.state, 'new');
    assert.equal(c.link_batch_id, null);
    assert.equal(c.linked_junction_id, null);
    assert.equal(c.linked_collection, null);
  }
  assert.equal(keep.state, 'linked');
  const deletes = w.items.filter((i) => i.op === 'delete' && i.collection === 'surface_scans');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].accountability.user, U.alice, 'deleted as the caller, never as an administrator');
  assert.equal(deletes[0].accountability.admin, false);
  assert.ok(deletes[0].knex?.isTransaction);
  assert.equal(actorsOf(w).at(-1).bindings[0], U.alice);
  // the file can be added again afterwards
  assert.equal((await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } })).statusCode, 200);
});

test('POST /undo leaves a scan alone that was deleted, or repointed at another file, since; the candidate still goes back to new', async () => {
  const w = newWorld();
  const a = add(w, scanCand());
  const b = add(w, scanCand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [scanItem(a), scanItem(b)] } })).body.data.link_batch_id;
  // a's scan is deleted in Data Studio; b's is repointed at another file there
  w.scans = w.scans.filter((r) => r.directus_files_id !== a.directus_files_id);
  w.scans.find((r) => r.directus_files_id === b.directus_files_id).directus_files_id = ID(3999);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.undone, 2);
  assert.equal(w.items.filter((i) => i.op === 'delete').length, 0, 'neither row was this batch\'s any more');
  assert.deepEqual(w.scans.map((r) => r.directus_files_id), [ID(3999)]);
  assert.equal(a.state, 'new');
  assert.equal(b.state, 'new');
});

test('POST /undo: a caller who may no longer delete the scan gets 403, nothing is undone and no administrator is used', async () => {
  const w = newWorld();
  const scan = add(w, scanCand()); // first in candidate id order, which is the order undo deletes in
  const img = add(w, cand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(img), scanItem(scan)] } })).body.data.link_batch_id;
  w.denyDelete = true;
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 403);
  assert.equal(codeOf(res), 'FORBIDDEN');
  assert.match(errorOf(res).message, /cannot be undone/);
  assert.equal(errorOf(res).extensions.candidate_id, scan.candidate_id);
  assert.equal(scan.state, 'linked');
  assert.equal(img.state, 'linked');
  assert.equal(w.scans.length, 1);
  assert.equal(w.junctions.sample_data_files.length, 1, 'the sample half was rolled back too');
  assert.equal(w.items.some((i) => i.op === 'delete' && i.accountability.admin === true), false);
});

test('POST /undo of a scan batch: another person\'s batch is 403 (an administrator in the owner team may, with their own accountability; one outside it may not)', async () => {
  const w = newWorld();
  const scan = add(w, scanCand({ owner_person_id: null, owner_team_id: TEAM }));
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } })).body.data.link_batch_id;
  assert.equal((await call('POST /undo', { user: U.bob, body: { link_batch_id: batch } })).statusCode, 403);
  assert.equal(w.scans.length, 1);
  assert.equal((await call('POST /undo', { user: U.admin, admin: true, role: ID(80), body: { link_batch_id: batch } })).statusCode, 403, 'read-only on a team that is not theirs');
  assert.equal(w.scans.length, 1);
  w.teamMembers.push({ team_id: TEAM, person_id: P.admin });
  const admin = await call('POST /undo', { user: U.admin, admin: true, role: ID(80), body: { link_batch_id: batch } });
  assert.equal(admin.statusCode, 200, JSON.stringify(admin.body));
  assert.equal(w.scans.length, 0);
  assert.equal(w.items.filter((i) => i.op === 'delete')[0].accountability.user, U.admin);
});

test('POST /undo of a scan batch whose table has since gone: nothing to delete, the candidate returns to new', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [scanItem(scan)] } })).body.data.link_batch_id;
  // a fresh process (the answer is not remembered) on a database that no longer has the table
  w.scanTable = false;
  const fresh = setup(w);
  const res = await fresh.call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(scan.state, 'new');
});

// ---- the list shows a scan that was added ------------------------------------------------------------------------------------

test('GET /files: a row added as a surface scan names the scan, its insert or edge and a label; a scan that is gone names nothing', async () => {
  const w = newWorld();
  const scan = add(w, scanCand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [scanItem(scan, { condition: 'worn' })] } })).body.data.link_batch_id;
  const scanId = w.scans[0].scan_id;
  w.listRows = [{
    ...scan, name: 'edge.al3d', mime_type: null, decided_by_name: 'Alice A', owner_name: 'Alice A', linked_record_id: scanId, size_bytes: '1000',
    source_mtime: null, first_seen_at: '2026-10-14T10:00:00.000Z', decided_at: '2026-10-15T10:00:00.000Z',
  }];
  w.listTotal = 1;
  const res = await call('GET /files', { user: U.alice, query: { tab: 'linked' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const [row] = res.body.data;
  assert.equal(row.linked_collection, 'surface_scans');
  assert.equal(row.linked_record_id, scanId);
  assert.equal(row.linked_label, 'INS-001 (worn)');
  assert.equal(row.linked_insert_id, INS1);
  assert.equal(row.linked_edge_id, null);
  assert.equal(row.link_batch_id, batch);
  const read = w.items.find((i) => i.op === 'read' && i.collection === 'surface_scans');
  assert.equal(read.accountability.user, U.alice, 'read as the caller');
  // deleted since: not readable, so not named
  w.scans = [];
  const gone = await call('GET /files', { user: U.alice, query: { tab: 'linked' } });
  assert.equal(gone.body.data[0].linked_collection, null);
  assert.equal(gone.body.data[0].linked_record_id, null);
  assert.equal('linked_insert_id' in gone.body.data[0], false);
});

// S4: the file name of a surface scan can name an edge ("H13A-#2-fC"): the crawler suggests it (insert_edges, match_strength edge_code) and the F2 dialog
// starts with that edge chosen, so the list must NAME the edge to a caller who can read it. Never editable (a scan is added through Directus's create
// permission on surface_scans, not a record-edit right), and only a surface scan candidate carries it.
const edgeCand = (over = {}, edge = EDGE1) => scanCand({
  match_strength: 'edge_code', matches: [{ collection: 'insert_edges', record_id: edge, via: 'edge_code', token: 'INS-001-E1' }],
  suggested_collection: 'insert_edges', suggested_record_id: edge, ...over,
});

test('GET /files: an edge named by a surface scan file is suggested to a caller who can read the edge (id and code), never as editable', async () => {
  const w = newWorld();
  const scan = edgeCand();
  w.listRows = [listRow(scan)];
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const [row] = res.body.data;
  assert.equal(row.suggested_collection, 'insert_edges');
  assert.equal(row.suggested_record_id, EDGE1);
  assert.equal(row.suggested_label, 'INS-001-E1', 'the edge code, read as the caller');
  assert.equal(row.match_strength, 'edge_code');
  assert.deepEqual(row.matches.map((m) => m.record_id), [EDGE1]);
  assert.equal(row.suggested_can_edit, false, 'an edge is never in the editable set: adding a scan is not editing the edge');
  const read = w.items.find((i) => i.op === 'read' && i.collection === 'insert_edges');
  assert.equal(read.accountability.user, U.alice, 'read as the caller');
  assert.deepEqual(read.query.fields.sort(), ['edge_code', 'edge_id']);
  // an administrator is no exception to "never editable"
  const admin = await call('GET /files', { user: U.admin, admin: true, role: ID(80) });
  assert.equal(admin.body.data[0].suggested_can_edit, false);
});

test('GET /files: an edge the caller cannot read (or whose collection is forbidden) is named nowhere: no suggestion, no match, no id', async () => {
  const w = newWorld();
  const hidden = ID(299);
  w.listRows = [listRow(edgeCand({}, hidden))];
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice });
  const [row] = res.body.data;
  assert.equal(row.suggested_collection, null);
  assert.equal(row.suggested_record_id, null);
  assert.equal(row.suggested_label, null);
  assert.deepEqual(row.matches, []);
  assert.equal(row.match_strength, 'edge_code', 'the strength is kept');
  assert.ok(!('suggested_can_edit' in row));
  assert.equal(JSON.stringify(res.body).includes(hidden), false);
  // no read permission on insert_edges at all: the list still answers, naming nothing
  w.listRows = [listRow(edgeCand())];
  w.denyRefRead = 'insert_edges';
  const denied = await call('GET /files', { user: U.alice });
  assert.equal(denied.statusCode, 200);
  assert.equal(denied.body.data[0].suggested_record_id, null);
});

test('GET /files: an edge suggestion is passed through for a surface scan candidate only (an image or document named like an edge gets none)', async () => {
  const w = newWorld();
  w.listRows = [listRow(edgeCand({ kind: 'sem_image' })), listRow(edgeCand({ kind: 'document' })), listRow(edgeCand())];
  const { call } = setup(w);
  const [image, doc, scan] = (await call('GET /files', { user: U.alice })).body.data;
  for (const r of [image, doc]) {
    assert.equal(r.suggested_record_id, null);
    assert.equal(r.suggested_label, null);
    assert.deepEqual(r.matches, []);
    assert.ok(!('suggested_can_edit' in r));
  }
  assert.equal(scan.suggested_record_id, EDGE1);
});

test('GET /files: one insert_edges read per page, however many rows name an edge; none when no row does', async () => {
  const w = newWorld();
  w.listRows = [listRow(edgeCand()), listRow(edgeCand()), listRow(cand())];
  const { call } = setup(w);
  await call('GET /files', { user: U.alice });
  assert.equal(w.items.filter((i) => i.op === 'read' && i.collection === 'insert_edges').length, 1);
  w.items.length = 0;
  w.listRows = [listRow(cand())];
  await call('GET /files', { user: U.alice });
  assert.equal(w.items.filter((i) => i.collection === 'insert_edges').length, 0);
});

test('the SQL: linked_record_id of the list falls back to the scan id for a row added as a surface scan; scan SQL names only the scans table and information_schema', () => {
  const { sql } = buildListQuery({ personId: P.alice, teamIds: [], admin: false }, parseFileFilters({ tab: 'linked' }));
  assert.match(sql, /CASE WHEN c\.linked_collection = 'surface_scans' THEN c\.linked_junction_id END\) AS linked_record_id/);
  assert.doesNotMatch(sql, /JOIN surface_scans/, 'the list must not break where the table does not exist yet');
  assert.match(SQL.scanTableExists, /information_schema\.tables/);
  assert.match(SQL.scanById, /FROM surface_scans WHERE scan_id = \?/);
});

test('POST /link looks for files already on their record with one query per collection, not one per row', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const c = add(w, cand({ suggested_collection: 'test_sessions', suggested_record_id: T1 }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(a), link(b), link(c, 'test_sessions', T1)] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.log.filter((l) => l.name?.startsWith('junctionFindMany.')).map((l) => l.name).sort(), ['junctionFindMany.physical_samples', 'junctionFindMany.test_sessions']);
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
  assert.match(errorOf(res).message, /Dismiss clears it/);
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
  assert.equal(res.body.data.items.find((l) => l.candidate_id === doc.candidate_id).adopted, true);
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

test('POST /accept-all links only exact short-ID suggestions to one record the caller can edit (images, documents and other files; never surface scans), and reports what it skipped', async () => {
  const w = newWorld();
  const ok1 = add(w, candFor('physical_samples', S1));
  const ok2 = add(w, candFor('test_sessions', T1));
  const doc = add(w, candFor('physical_samples', S1, { kind: 'document' }));
  const other = add(w, candFor('physical_samples', S1, { kind: 'other' }));
  const scan = add(w, candFor('physical_samples', S1, { kind: 'surface_scan' }));
  const notEditable = add(w, candFor('physical_samples', S3));
  const code = add(w, candFor('physical_samples', S1, { match_strength: 'code' }));
  const noSuggestion = add(w, cand({ suggested_collection: null, suggested_record_id: null, matches: [] }));
  const ambiguous = add(w, cand({ matches: [{ collection: 'physical_samples', record_id: S1, via: 'short_id', token: 'x' }, { collection: 'physical_samples', record_id: S3, via: 'short_id', token: 'y' }] }));
  const copy = add(w, candFor('physical_samples', S1, { duplicate_of: ok1.candidate_id }));
  const done = add(w, candFor('physical_samples', S1, { state: 'linked' }));
  const onRecord = add(w, candFor('physical_samples', S1));
  w.junctions.sample_data_files.push({ id: ID(4902), sample_id: S1, directus_files_id: onRecord.directus_files_id });
  w.acceptIds = [ok1, ok2, doc, other, scan, notEditable, code, noSuggestion, ambiguous, copy, done, onRecord].map((c) => c.candidate_id);
  const { call } = setup(w);
  const res = await call('POST /accept-all', { user: U.alice, body: { filter: { tab: 'new' } } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.linked, 4, 'a count');
  assert.match(data.link_batch_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(data.items.map((l) => l.candidate_id).sort(), [ok1, ok2, doc, other].map((c) => c.candidate_id).sort());
  const reasons = Object.fromEntries(data.skipped.map((s) => [s.candidate_id, s.reason]));
  assert.equal(reasons[scan.candidate_id], 'SURFACE_SCAN');
  assert.equal(reasons[notEditable.candidate_id], 'NOT_EDITABLE');
  assert.equal(reasons[code.candidate_id], 'NOT_EXACT');
  assert.equal(reasons[noSuggestion.candidate_id], 'NO_SUGGESTION');
  assert.equal(reasons[ambiguous.candidate_id], 'AMBIGUOUS', 'two records named: never linked in bulk either (D9)');
  assert.equal(reasons[copy.candidate_id], 'COPY');
  assert.equal(reasons[done.candidate_id], 'NOT_NEW');
  assert.equal(reasons[onRecord.candidate_id], 'ALREADY_ON_RECORD');
  assert.equal(data.has_more, false);
  assert.equal(w.junctions.sample_data_files.length, 4, 'the Data Studio row, ok1, the document and the other file');
  assert.equal(w.junctions.session_data_files.length, 1);
  assert.equal(ok1.link_kind, 'bulk');
  assert.equal(ok1.link_batch_id, ok2.link_batch_id);
  assert.equal(doc.adopted_at, NOW.toISOString(), 'a document is adopted: the crawler hashes it once');
  assert.equal(other.adopted_at, NOW.toISOString());
  assert.equal(ok1.adopted_at, null);
  assert.equal(scan.state, 'new');
  assert.equal(notEditable.state, 'new');
  // one junction lookup per collection for the whole page
  assert.equal(w.log.filter((l) => l.name?.startsWith('junctionFindMany.')).length <= 2, true);
});

test('POST /accept-all is not stalled by a page of rows it must skip: 600 skipped, then 50 linkable, all reached; has_more is honest', async () => {
  const w = newWorld();
  const skipped = Array.from({ length: 600 }, () => add(w, candFor('physical_samples', S3)));
  const good = Array.from({ length: 50 }, () => add(w, candFor('physical_samples', S1)));
  w.acceptIds = [...skipped, ...good].map((c) => c.candidate_id);
  const { call } = setup(w);
  const res = await call('POST /accept-all', { user: U.alice, body: { filter: {} } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.linked, 50, 'the second page was reached in the same call');
  assert.equal(res.body.data.has_more, false);
  assert.equal(res.body.data.skipped_total, 600);
  assert.ok(res.body.data.skipped.length <= 200, 'the list of skipped rows is capped');
  assert.equal(res.body.data.next_cursor, null);
  assert.equal(w.acceptQueries.length, 2, 'two pages of the keyset');
  assert.match(w.acceptQueries[1].sql, /\(c\.first_seen_at, c\.candidate_id\) > \(\?::timestamptz, \?::uuid\)/);
  assert.equal(w.acceptQueries[1].bindings.at(-1), skipped[499].candidate_id, 'the cursor is the last row of the first page');
});

test('POST /accept-all: when the scan cap of one call is reached, has_more is true with a cursor; the next calls reach the rest', async () => {
  const w = newWorld();
  const skipped = Array.from({ length: 600 }, () => add(w, candFor('physical_samples', S3)));
  const good = Array.from({ length: 50 }, () => add(w, candFor('physical_samples', S1)));
  w.acceptIds = [...skipped, ...good].map((c) => c.candidate_id);
  const { call } = setup(w, { deps: { acceptPage: 100, acceptMaxPages: 3 } });
  const one = await call('POST /accept-all', { user: U.alice, body: { filter: {} } });
  assert.equal(one.body.data.linked, 0);
  assert.equal(one.body.data.has_more, true, 'rows remain that could still be linkable');
  assert.ok(one.body.data.next_cursor);
  assert.equal(w.acceptQueries.length, 3);
  const two = await call('POST /accept-all', { user: U.alice, body: { filter: {}, cursor: one.body.data.next_cursor } });
  assert.equal(two.body.data.linked, 0);
  assert.equal(two.body.data.has_more, true);
  const three = await call('POST /accept-all', { user: U.alice, body: { filter: {}, cursor: two.body.data.next_cursor } });
  assert.equal(three.body.data.linked, 50, 'the linkable rows after 600 skipped ones');
  assert.equal(three.body.data.has_more, false, 'the last page was short: nothing remains');
  assert.equal(three.body.data.next_cursor, null);
  assert.equal((await call('POST /accept-all', { user: U.alice, body: { filter: {}, cursor: 'not a cursor' } })).statusCode, 400);
});

test('POST /accept-all dry_run: { count, ids, skipped, has_more } and nothing written; a real run can take those candidate_ids and links exactly them', async () => {
  const w = newWorld();
  const a = add(w, candFor('physical_samples', S1));
  const b = add(w, candFor('test_sessions', T1));
  const c = add(w, candFor('physical_samples', S3));
  const late = add(w, candFor('physical_samples', S1));
  w.acceptIds = [a, b, c].map((x) => x.candidate_id);
  const { call } = setup(w);
  const dry = await call('POST /accept-all', { user: U.alice, body: { filter: {}, dry_run: true } });
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.body.data.count, 2);
  assert.deepEqual(dry.body.data.ids.sort(), [a.candidate_id, b.candidate_id].sort());
  assert.deepEqual(dry.body.data.skipped, [{ candidate_id: c.candidate_id, reason: 'NOT_EDITABLE' }]);
  assert.equal(dry.body.data.has_more, false);
  assert.equal(a.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  // meanwhile one of the previewed files is dismissed by someone, and a NEW linkable file turns up
  b.state = 'dismissed';
  w.acceptIds = [a, b, c, late].map((x) => x.candidate_id);
  const real = await call('POST /accept-all', { user: U.alice, body: { candidate_ids: dry.body.data.ids } });
  assert.equal(real.statusCode, 200, JSON.stringify(real.body));
  assert.deepEqual(real.body.data.items.map((i) => i.candidate_id), [a.candidate_id], 'only what was previewed and still qualifies');
  assert.deepEqual(real.body.data.skipped, [{ candidate_id: b.candidate_id, reason: 'NOT_NEW' }]);
  assert.equal(late.state, 'new', 'a file that was not previewed is not linked');
  assert.equal(w.acceptQueries.length, 1, 'the real run did not select again (only the dry run did)');
  // each id is re-checked under the locks, with the same rules, and a file the caller cannot see is not touched
  const bobs = add(w, candFor('physical_samples', S1, { owner_person_id: P.bob }));
  const again = await call('POST /accept-all', { user: U.alice, body: { candidate_ids: [bobs.candidate_id, ID(4044), c.candidate_id] } });
  assert.deepEqual(again.body.data.skipped.map((s) => s.reason).sort(), ['NOT_EDITABLE', 'NOT_FOUND', 'NOT_FOUND']);
  assert.equal(bobs.state, 'new');
  assert.ok(w.log.some((l) => l.name === 'acceptCandidatesForUpdate'), 'accept-all locks through its own read, which leaves out rows under an ignored folder');
  assert.equal((await call('POST /accept-all', { user: U.alice, body: { candidate_ids: ['x'] } })).statusCode, 400);
  assert.equal((await call('POST /accept-all', { user: U.alice, body: { candidate_ids: [] } })).statusCode, 400);
});

test('POST /accept-all: a file the caller cannot see is never touched, even when the selection names it', async () => {
  const w = newWorld();
  const bobs = add(w, cand({ owner_person_id: P.bob }));
  w.acceptIds = [bobs.candidate_id];
  const { call } = setup(w);
  const res = await call('POST /accept-all', { user: U.alice, body: { filter: {} } });
  assert.equal(res.body.data.linked, 0);
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
  assert.equal(res.body.data.changed, 2, 'a count');
  assert.deepEqual(res.body.data.changed_ids.sort(), [mine.candidate_id, team.candidate_id].sort());
  assert.equal(mine.state, 'dismissed');
  assert.equal(mine.decided_by, U.alice);
  assert.equal(team.state, 'dismissed');
  // dismissing twice changes nothing and is not an error
  const again = await call('POST /dismiss', { user: U.bob, body: { candidate_ids: [team.candidate_id] } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.data.changed, 0);
  assert.deepEqual(again.body.data.unchanged_ids, [team.candidate_id]);
  assert.equal(team.decided_by, U.alice, 'the first to resolve it');
  // restore (a teammate may)
  const back = await call('POST /restore', { user: U.bob, body: { candidate_ids: [team.candidate_id] } });
  assert.equal(back.statusCode, 200);
  assert.equal(team.state, 'new');
  assert.equal(team.decided_by, null);
  assert.deepEqual(actorsOf(w).map((a) => a.bindings[0]).slice(0, 2), [U.alice, U.bob]);
});

// Restore and undo put a file back to new. If it vanished meanwhile the crawler's folder cache still says "listed, unchanged", so nothing would ever
// mark it gone: the folder's cache row is cleared (last_listed_at and dir_mtime NULL) and the next scan lists the folder again.
const dirRow = (rel_path, over = {}) => ({ rel_path, owner_person_id: P.alice, owner_team_id: null, dir_mtime: '2026-10-14T10:00:00.000Z', last_listed_at: '2026-10-14T10:05:00.000Z', ...over });
const listed = (d) => d.last_listed_at !== null || d.dir_mtime !== null;

test('POST /restore clears the folder cache of the restored file\'s folder (and only that folder, only for that owner) so the next scan lists it again', async () => {
  const w = newWorld();
  const a = add(w, cand({ state: 'dismissed', rel_path: 'Users/ali1/sem/a.tif' }));
  const t = add(w, cand({ state: 'dismissed', owner_person_id: null, owner_team_id: TEAM, rel_path: 'Shared/SEM/2026/t.tif' }));
  const stays = add(w, cand({ state: 'dismissed', rel_path: 'Users/ali1/other/b.tif' }));
  w.dirs = [dirRow('Users/ali1'), dirRow('Users/ali1/sem'), dirRow('Users/ali1/other'), dirRow('Shared/SEM/2026', { owner_person_id: null, owner_team_id: TEAM }),
    dirRow('Shared/SEM', { owner_person_id: null, owner_team_id: TEAM }), dirRow('Users/bob2/sem', { owner_person_id: P.bob })];
  const { call } = setup(w);
  const res = await call('POST /restore', { user: U.alice, body: { candidate_ids: [a.candidate_id, t.candidate_id] } });
  assert.equal(res.statusCode, 200);
  const byPath = Object.fromEntries(w.dirs.map((d) => [d.rel_path, listed(d)]));
  assert.deepEqual(byPath, {
    'Users/ali1': true, 'Users/ali1/sem': false, 'Users/ali1/other': true, 'Shared/SEM/2026': false, 'Shared/SEM': true, 'Users/bob2/sem': true,
  }, 'only the two parent folders are forgotten');
  assert.equal(w.dirs.find((d) => d.rel_path === 'Users/ali1/sem').dir_mtime, null, 'dir_mtime too, as the crawler does when it keeps a folder "changed"');
  assert.equal(stays.state, 'dismissed');
  const calls = w.log.filter((l) => l.name === 'relistDirs');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].bindings[0].split(',').sort(), [a.candidate_id, t.candidate_id].sort(), 'for the candidates that changed');
  assert.equal(calls[0].tx, w.log.find((l) => l.name === 'restore').tx, 'in the transaction of the restore');
});

test('POST /undo clears the folder cache of every undone file\'s folder, as restore does', async () => {
  const w = newWorld();
  const a = add(w, cand({ rel_path: 'Users/ali1/sem/a.tif' }));
  const b = add(w, cand({ rel_path: 'Users/ali1/scans/b.tif' }));
  const keep = add(w, cand({ rel_path: 'Users/ali1/keep/c.tif' }));
  w.dirs = [dirRow('Users/ali1/sem'), dirRow('Users/ali1/scans'), dirRow('Users/ali1/keep')];
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } })).body.data.link_batch_id;
  await call('POST /link', { user: U.alice, body: { items: [link(keep)] } });
  assert.ok(w.dirs.every(listed), 'linking touches no cache row');
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.dirs.map((d) => [d.rel_path, listed(d)]), [['Users/ali1/sem', false], ['Users/ali1/scans', false], ['Users/ali1/keep', true]]);
});

test('dismiss, a restore that changes nothing, and a failed undo leave the folder cache alone', async () => {
  const w = newWorld();
  const a = add(w, cand({ rel_path: 'Users/ali1/sem/a.tif' }));
  const fresh = add(w, cand({ rel_path: 'Users/ali1/sem/n.tif' }));
  w.dirs = [dirRow('Users/ali1/sem')];
  const { call } = setup(w);
  await call('POST /dismiss', { user: U.alice, body: { candidate_ids: [a.candidate_id] } });
  assert.ok(w.dirs.every(listed), 'dismiss never relists');
  const none = await call('POST /restore', { user: U.alice, body: { candidate_ids: [fresh.candidate_id] } });
  assert.equal(none.body.data.changed, 0);
  assert.ok(w.dirs.every(listed), 'nothing restored, nothing cleared');
  assert.equal(w.log.filter((l) => l.name === 'relistDirs').length, 0);
  // an undo that is refused rolls back with everything else
  const linked = (await call('POST /link', { user: U.alice, body: { items: [link(fresh)] } })).body.data.link_batch_id;
  const refused = await call('POST /undo', { user: U.bob, body: { link_batch_id: linked } });
  assert.notEqual(refused.statusCode, 200);
  assert.ok(w.dirs.every(listed));
});

test('the SQL: the relist clears last_listed_at and dir_mtime of the folder (same path, same owner) of the given candidates, and nothing else', () => {
  assert.match(SQL.relistDirs, /^UPDATE d1_private\.inbox_dirs d SET last_listed_at = NULL, dir_mtime = NULL FROM d1_private\.file_candidates c/);
  assert.match(SQL.relistDirs, /d\.rel_path = regexp_replace\(c\.rel_path, '\/\[\^\/\]\*\$', ''\)/, 'the parent folder: the path without its last segment');
  assert.match(SQL.relistDirs, /d\.owner_person_id IS NOT DISTINCT FROM c\.owner_person_id AND d\.owner_team_id IS NOT DISTINCT FROM c\.owner_team_id/, 'a folder cached for another owner is not touched');
  assert.doesNotMatch(SQL.relistDirs, /baselined_at/, 'the baseline of an owner is never reset');
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
  assert.equal(r.body.data.changed, 0);
  assert.deepEqual(r.body.data.unchanged_ids, [mine.candidate_id]);
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

test('POST /undo leaves alone a junction row that no longer holds the file it created (repointed in Data Studio); the candidate still goes back to new', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } })).body.data.link_batch_id;
  // someone repoints a's junction row at another file in Data Studio
  const row = w.junctions.sample_data_files.find((j) => j.directus_files_id === a.directus_files_id);
  row.directus_files_id = ID(3999);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.undone, 2);
  assert.deepEqual(w.junctions.sample_data_files.map((j) => j.directus_files_id), [ID(3999)], 'the repointed row stays; b\'s row went');
  assert.equal(w.items.filter((i) => i.op === 'delete').length, 1);
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
  // an administrator who is not in the owner team is read-only on its files (stream D): 403, nothing undone; a member of the team that did not link it is 403 too
  assert.equal((await call('POST /undo', { user: U.admin, admin: true, body: { link_batch_id: teamBatch } })).statusCode, 403);
  assert.equal(t.state, 'linked');
  w.teamMembers.push({ team_id: TEAM, person_id: P.admin });
  assert.equal((await call('POST /undo', { user: U.admin, admin: true, body: { link_batch_id: teamBatch } })).statusCode, 200, 'an administrator in the team may undo what a teammate linked');
  assert.equal(t.state, 'new');
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: myBatch } })).statusCode, 200);
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: myBatch } })).statusCode, 404, 'already undone');
  for (const body of [undefined, {}, { link_batch_id: 'x' }]) assert.equal((await call('POST /undo', { user: U.alice, body })).statusCode, 400);
});

// ---- imaging settings: saved with the link, removed with the last link (stream D, task D1) --------------------------------------------

const SEM_EXTRACTED = { kv: 15, spot: 3, magnification: 5000, hfw_um: 59.7, instrument: 'Quanta', sources: { kv: 'metadata', magnification: 'derived' }, flags: { check_this: true }, ocr_confidence: { kv: 0.91 } };
const savesOf = (w) => w.log.filter((l) => l.name === 'saveSemSettings');

test('POST /link saves the settings of a sem_image: save_sem_settings(file, the candidate\'s extracted, inbox), in the link transaction, after the candidate is marked linked', async () => {
  const w = newWorld();
  const c = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const saves = savesOf(w);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].bindings.slice(0, 1), [c.directus_files_id]);
  assert.deepEqual(JSON.parse(saves[0].bindings[1]), SEM_EXTRACTED, 'the candidate\'s extracted, whole: the function maps the keys, not this endpoint');
  assert.equal(saves[0].bindings[2], 'inbox');
  assert.equal(saves[0].bindings.length, 3);
  assert.match(SQL.saveSemSettings, /^SELECT d1_private\.save_sem_settings\(\?, \?::jsonb, \?\)/);
  const link1 = w.log.find((l) => l.name === 'markLinked');
  assert.equal(saves[0].tx, link1.tx, 'the same transaction as the link');
  assert.ok(saves[0].tx !== null);
  assert.ok(w.log.indexOf(saves[0]) > w.log.indexOf(link1), 'after the candidate is marked linked');
  assert.equal(w.settings.get(c.directus_files_id).kv, '15');
  assert.equal(w.settings.get(c.directus_files_id).sources.kv, 'metadata');
});

test('POST /link of a plain image, a document or a surface scan saves no settings', async () => {
  const w = newWorld();
  const image = add(w, cand({ kind: 'image', extracted: SEM_EXTRACTED }));
  const doc = add(w, cand({ kind: 'document', extracted: SEM_EXTRACTED }));
  const other = add(w, cand({ kind: 'other' }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(image), link(doc), link(other)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(savesOf(w).length, 0);
  assert.equal(w.settings.size, 0);
  const scan = add(w, cand({ kind: 'surface_scan', extracted: SEM_EXTRACTED, suggested_collection: null, suggested_record_id: null, matches: [], match_strength: 'none' }));
  w.refs.cutting_inserts.add(INS1);
  const added = await call('POST /link', { user: U.alice, body: { items: [{ candidate_id: scan.candidate_id, collection: 'surface_scans', insert_id: INS1, condition: 'worn' }] } });
  assert.equal(added.statusCode, 200, JSON.stringify(added.body));
  assert.equal(savesOf(w).length, 0, 'a surface scan is not an SEM image');
});

test('POST /link: a candidate whose extracted has no settings still calls the function (it decides what is a setting), a JSON string extracted is passed as it is', async () => {
  const w = newWorld();
  const empty = add(w, cand({ extracted: null }));
  const text = add(w, cand({ extracted: JSON.stringify({ kv: 20 }) }));
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(empty), link(text)] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const [a, b] = savesOf(w);
  assert.deepEqual(JSON.parse(a.bindings[1]), {}, 'no extracted at all is an empty object, never the text "null"');
  assert.deepEqual(JSON.parse(b.bindings[1]), { kv: 20 });
});

test('POST /link: a rollback after the settings call leaves nothing (no junction row, no settings row, the candidate still new)', async () => {
  const w = newWorld();
  const a = add(w, cand({ extracted: SEM_EXTRACTED }));
  const b = add(w, cand({ extracted: SEM_EXTRACTED }));
  let n = 0;
  w.failCreateFor = () => { n += 1; if (n === 2) throw new Error('boom'); };
  const { call } = setup(w);
  const res = await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } });
  assert.equal(res.statusCode, 500);
  assert.equal(savesOf(w).length, 1, 'the first file\'s settings were saved before the second link failed');
  assert.equal(w.settings.size, 0, 'and rolled back with it');
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(a.state === 'new' && b.state === 'new', true);
});

test('POST /link: a failing settings call refuses the whole link (nothing half done)', async () => {
  const w = newWorld();
  const c = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call, errors } = setup(w);
  const real = w.settings.set.bind(w.settings);
  w.settings.set = () => { throw new Error('function failed'); };
  const res = await call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  w.settings.set = real;
  assert.equal(res.statusCode, 500);
  assert.equal(errors.length, 1);
  assert.equal(c.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
});

test('POST /accept-all saves the settings of every sem_image it links, in its transaction', async () => {
  const w = newWorld();
  const sem = add(w, candFor('physical_samples', S1, { extracted: SEM_EXTRACTED }));
  const image = add(w, candFor('physical_samples', S1, { kind: 'image', extracted: SEM_EXTRACTED }));
  const sem2 = add(w, candFor('test_sessions', T1, { extracted: { kv: 10 } }));
  w.acceptIds = [sem, image, sem2].map((c) => c.candidate_id);
  const { call } = setup(w);
  const res = await call('POST /accept-all', { user: U.alice, body: { filter: { tab: 'new' } } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.linked, 3);
  assert.deepEqual(savesOf(w).map((l) => l.bindings[0]).sort(), [sem.directus_files_id, sem2.directus_files_id].sort());
  assert.ok(savesOf(w).every((l) => l.bindings[2] === 'inbox'));
  assert.deepEqual([...w.settings.keys()].sort(), [sem.directus_files_id, sem2.directus_files_id].sort());
});

test('POST /auto-link saves the settings of the sem_image it links, as the person, in its transaction', async () => {
  const w = newWorld();
  const c = add(w, cand({ extracted: SEM_EXTRACTED }));
  w.prefs.set(U.alice, true);
  const res = await auto(w, [c.candidate_id]);
  assert.equal(res.body.data.results[0].status, 'linked', JSON.stringify(res.body));
  const [save] = savesOf(w);
  assert.equal(save.bindings[0], c.directus_files_id);
  assert.deepEqual(JSON.parse(save.bindings[1]), SEM_EXTRACTED);
  assert.equal(save.bindings[2], 'inbox');
  assert.ok(w.settings.has(c.directus_files_id));
  // a plain image through auto-link saves nothing
  const img = add(w, cand({ kind: 'image', extracted: SEM_EXTRACTED }));
  await auto(w, [img.candidate_id]);
  assert.equal(savesOf(w).length, 1);
});

test('POST /undo removes the settings when no link of the file remains (and only then)', async () => {
  const w = newWorld();
  const a = add(w, cand({ extracted: SEM_EXTRACTED }));
  const b = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } })).body.data.link_batch_id;
  assert.equal(w.settings.size, 2);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(w.settings.size, 0, 'both files have no link left');
  const del = w.log.find((l) => l.name === 'deleteUnlinkedSemSettings');
  assert.deepEqual(csv(del.bindings[0]).sort(), [a.directus_files_id, b.directus_files_id].sort());
  const undoTx = w.log.find((l) => l.name === 'resetBatch').tx;
  assert.equal(del.tx, undoTx, 'in the undo transaction');
  assert.ok(w.log.indexOf(del) > w.log.findIndex((l) => l.name === 'setActor' && l.tx === undoTx));
});

test('POST /undo keeps the settings while another link of the file remains (a second junction row in another collection, or a surface scan)', async () => {
  const w = newWorld();
  const a = add(w, cand({ extracted: SEM_EXTRACTED }));
  const b = add(w, cand({ extracted: SEM_EXTRACTED }));
  const c = add(w, cand({ extracted: SEM_EXTRACTED }));
  const d = add(w, cand({ extracted: SEM_EXTRACTED }));
  // a is also on an operation, b on a test, c has a surface scan row; d has only this link
  w.junctions.operation_data_files.push({ id: ID(4911), operation_id: O1, directus_files_id: a.directus_files_id });
  w.junctions.session_data_files.push({ id: ID(4912), session_id: T1, directus_files_id: b.directus_files_id });
  w.scans.push({ scan_id: ID(6101), insert_id: INS1, directus_files_id: c.directus_files_id, condition: 'worn' });
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b), link(c), link(d)] } })).body.data.link_batch_id;
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.undone, 4);
  assert.equal(w.junctions.sample_data_files.length, 0, 'every link this batch made is gone');
  assert.deepEqual([...w.settings.keys()].sort(), [a.directus_files_id, b.directus_files_id, c.directus_files_id].sort(), 'settings stay while a link remains, go with the last one');
  assert.equal(w.settings.has(d.directus_files_id), false);
});

test('POST /undo of a link made without settings, and a refused undo, touch no settings', async () => {
  const w = newWorld();
  const img = add(w, cand({ kind: 'image' }));
  const sem = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const batchImg = (await call('POST /link', { user: U.alice, body: { items: [link(img)] } })).body.data.link_batch_id;
  const batchSem = (await call('POST /link', { user: U.alice, body: { items: [link(sem)] } })).body.data.link_batch_id;
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: batchImg } })).statusCode, 200);
  assert.equal(w.settings.size, 1, 'the SEM image keeps its settings while its own link stands');
  w.denyDelete = true;
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: batchSem } })).statusCode, 403);
  assert.equal(w.settings.size, 1, 'a refused undo rolls back with everything else');
  w.denyDelete = false;
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: batchSem } })).statusCode, 200);
  assert.equal(w.settings.size, 0);
});

test('the SQL: the settings are written by the function only, and undo deletes only a file with no row left in the four link tables', () => {
  assert.match(SQL.saveSemSettings, /d1_private\.save_sem_settings/);
  assert.doesNotMatch(SQL.saveSemSettings, /INSERT|UPDATE/i, 'the endpoint never maps extracted to columns itself');
  const del = SQL.deleteUnlinkedSemSettings;
  assert.match(del, /^DELETE FROM d1_private\.sem_image_settings/);
  for (const table of ['sample_data_files', 'operation_data_files', 'session_data_files', 'surface_scans']) assert.match(del, new RegExp(`NOT EXISTS \\(SELECT 1 FROM ${table} `), table);
  assert.match(SQL.candidatesForUpdate, /c\.extracted/, 'the link transaction reads the candidate\'s extracted');
  assert.match(SQL.batchForUpdate, /c\.extracted/);
});

// ---- imaging settings: read and correct, locked files, administrators read-only (stream D, task D2) ---------------------------------

const SEM_ROW = {
  kv: '15.00', spot: '3.0', working_distance_mm: '8.50', magnification: 5000, hfw_um: '59.70', pixel_size_nm: '29.1400', scale_bar_um: '10.000',
  detector: 'ETD', mode: 'SE', instrument: 'Quanta 650', acquired_at: new Date('2026-03-02T10:15:30.000Z'),
  sources: { kv: 'metadata', magnification: 'derived', detector: 'metadata' }, flags: { check_this: true }, read_by: 'inbox', read_at: new Date('2026-10-14T10:00:00.000Z'),
  corrected_by: null, corrected_at: null,
};
// A file with a pointer row (owner columns) and settings. Defaults: Alice's own.
let fileSeq = 0;
const semFile = (w, { owner = { owner_person_id: P.alice, owner_team_id: null }, settings = true } = {}) => {
  fileSeq += 1;
  const id = ID(7500 + fileSeq);
  w.files.set(id, { id, ...owner });
  if (settings) w.settings.set(id, { directus_files_id: id, ...copy(SEM_ROW) });
  return id;
};
const OWNED_BY = { alice: { owner_person_id: P.alice, owner_team_id: null }, team: { owner_person_id: null, owner_team_id: TEAM }, other: { owner_person_id: P.carol, owner_team_id: null },
  nobody: { owner_person_id: null, owner_team_id: null } };
const getSem = (call, file, who) => call('GET /sem-settings', { ...who, query: { file } });
const ALICE = { user: U.alice };
const BOB = { user: U.bob };
const CAROL = { user: U.carol };
const ADMIN = { user: U.admin, admin: true, role: ID(80) };
const VALUES = { kv: 15, spot: 3, working_distance_mm: 8.5, magnification: 5000, hfw_um: 59.7, pixel_size_nm: 29.14, scale_bar_um: 10, detector: 'ETD', mode: 'SE', instrument: 'Quanta 650', acquired_at: '2026-03-02T10:15:30.000Z' };

test('canChange and semAccess: the owner person or an active member of the owner team; an administrator is neither unless they are', () => {
  const scope = (over) => ({ personId: P.alice, teamIds: [TEAM], admin: false, ...over });
  const own = cand();
  const teams = cand({ owner_person_id: null, owner_team_id: TEAM });
  assert.equal(canChange(scope(), own), true);
  assert.equal(canChange(scope(), teams), true);
  assert.equal(canChange(scope({ personId: P.bob, teamIds: [] }), own), false);
  assert.equal(canChange(scope({ teamIds: [] }), teams), false);
  assert.equal(canChange(scope({ personId: P.admin, teamIds: [], admin: true }), own), false, 'an administrator who is not the owner may not change it');
  assert.equal(canChange(scope({ personId: P.admin, teamIds: [], admin: true }), teams), false);
  assert.equal(canChange(scope({ personId: P.admin, teamIds: [TEAM], admin: true }), teams), true, 'a member of the owner team is a member, administrator or not');
  assert.equal(canChange(scope({ personId: P.alice, admin: true }), own), true);
  assert.equal(canChange(scope({ personId: null, teamIds: [], admin: false }), own), false);
  assert.equal(canChange(scope({ personId: null, teamIds: [] }), cand({ owner_person_id: null, owner_team_id: null })), false, 'an unowned candidate is nobody\'s to change');
  assert.equal(canSee(scope({ personId: P.admin, teamIds: [], admin: true }), own), true, 'canSee is unchanged: the list still shows an administrator everything');
  const file = (o) => ({ owner_person_id: null, owner_team_id: null, ...o });
  assert.equal(semAccess(scope(), file({ owner_person_id: P.alice })), 'owner');
  assert.equal(semAccess(scope(), file({ owner_team_id: TEAM })), 'owner');
  assert.equal(semAccess(scope(), file({ owner_person_id: P.bob })), 'other');
  assert.equal(semAccess(scope(), file({ owner_team_id: OTHER_TEAM })), 'other');
  assert.equal(semAccess(scope(), file({})), 'unowned');
  assert.equal(semAccess(scope({ personId: null, teamIds: [] }), file({ owner_person_id: P.alice })), 'other');
  assert.equal(semAccess(scope({ personId: null, teamIds: [] }), file({})), 'unowned');
});

test('GET /sem-settings: the owner gets the values, their sources and flags, and can edit; no administrator log row is written for an owner', async () => {
  const w = newWorld();
  const file = semFile(w);
  const { call } = setup(w);
  const res = await getSem(call, file, ALICE);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { data: {
    locked: false, settings: VALUES, sources: SEM_ROW.sources, flags: { check_this: true }, can_edit: true,
  } });
  assert.equal(w.settingsLog.length, 0, 'an owner reading their own settings is not logged');
  assert.equal(w.log.some((l) => l.name === 'semAccessLogInsert'), false);
  const read = w.log.find((l) => l.name === 'semSettingsGet');
  assert.deepEqual(read.bindings, [file]);
  assert.equal(w.items.length, 0, 'the owner is decided from the pointer row\'s owner columns: no Directus read');
});

test('GET /sem-settings: a value that is null is absent from settings (never null), numbers are numbers, the time is ISO 8601', async () => {
  const w = newWorld();
  const file = semFile(w, { settings: false });
  w.settings.set(file, { directus_files_id: file, kv: '12.50', spot: null, working_distance_mm: null, magnification: null, hfw_um: null, pixel_size_nm: null, scale_bar_um: null,
    detector: null, mode: null, instrument: null, acquired_at: null, sources: { kv: 'ocr' }, flags: {}, read_by: 'inbox', read_at: new Date(), corrected_by: null, corrected_at: null });
  const { call } = setup(w);
  const res = await getSem(call, file, ALICE);
  assert.deepEqual(res.body.data.settings, { kv: 12.5 });
  assert.deepEqual(res.body.data.sources, { kv: 'ocr' });
  assert.deepEqual(res.body.data.flags, {});
  assert.doesNotMatch(JSON.stringify(res.body), /null/);
  assert.deepEqual(shapeSemSettings({ ...SEM_ROW, sources: JSON.stringify({ kv: 'manual' }), flags: '{}' }, { canEdit: false }).sources, { kv: 'manual' }, 'jsonb as text is parsed');
});

test('GET /sem-settings: a member of the owner team gets the team\'s values; a person outside the team, and a Former member, get locked: true and no values anywhere in the JSON', async () => {
  const w = newWorld();
  const file = semFile(w, { owner: OWNED_BY.team });
  const { call } = setup(w);
  const bob = await getSem(call, file, BOB);
  assert.equal(bob.statusCode, 200);
  assert.equal(bob.body.data.locked, false);
  assert.deepEqual(bob.body.data.settings, VALUES);
  assert.equal(bob.body.data.can_edit, true, 'a team member may correct a team file');
  for (const who of [CAROL, { user: U.former }, { user: U.nobody }]) {
    const res = await getSem(call, file, who);
    assert.equal(res.statusCode, 200, 'locked is an answer, not an error');
    assert.deepEqual(res.body, { data: { locked: true } });
    assert.doesNotMatch(JSON.stringify(res.body), /5000|Quanta|ETD|metadata|settings|kv/, 'no value anywhere');
  }
  assert.equal(w.settingsLog.length, 0, 'a refusal is not an administrator read');
  assert.equal(w.items.length, 0);
});

test('GET /sem-settings: another person\'s file is locked for a member even when they can read the record it is linked to', async () => {
  const w = newWorld();
  const file = semFile(w, { owner: OWNED_BY.other });
  w.junctions.sample_data_files.push({ id: ID(4921), sample_id: S1, directus_files_id: file });
  const { call } = setup(w);
  const res = await getSem(call, file, ALICE);
  assert.deepEqual(res.body, { data: { locked: true } });
  assert.equal(w.items.length, 0, 'an owned file is decided by its owner alone: the record is not consulted');
});

test('GET /sem-settings: an administrator gets the same values read-only and exactly one access log row with reason admin_read; an administrator who is the owner is not logged', async () => {
  const w = newWorld();
  const file = semFile(w);
  const { call } = setup(w);
  const res = await getSem(call, file, ADMIN);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { locked: false, settings: VALUES, sources: SEM_ROW.sources, flags: { check_this: true }, can_edit: false });
  assert.deepEqual(w.settingsLog, [{ directus_files_id: file, read_by_user: U.admin, reason: 'admin_read' }]);
  const insert = w.log.find((l) => l.name === 'semAccessLogInsert');
  assert.ok(insert.tx !== null, 'written in a transaction that starts with the actor');
  assert.equal(w.log.find((l) => l.tx === insert.tx).name, 'setActor');
  await getSem(call, file, ADMIN);
  assert.equal(w.settingsLog.length, 2, 'every read is one row');
  // an administrator who owns a file, and one who is a member of the owner team, read as owners
  const mine = semFile(w, { owner: { owner_person_id: P.admin, owner_team_id: null } });
  const own = await getSem(call, mine, ADMIN);
  assert.equal(own.body.data.can_edit, true);
  assert.equal(w.settingsLog.length, 2, 'no log row for an owner');
  // an administrator's read of a team's file
  const teamFile = semFile(w, { owner: OWNED_BY.team });
  assert.equal((await getSem(call, teamFile, ADMIN)).statusCode, 200);
  assert.equal(w.settingsLog.length, 3);
  assert.equal(w.settingsLog[2].directus_files_id, teamFile);
});

test('GET /sem-settings: no settings row for a reader who is allowed is { locked: false, settings: null }; for one who is not, it is still locked (no hint whether a row exists)', async () => {
  const w = newWorld();
  const file = semFile(w, { settings: false });
  const { call } = setup(w);
  assert.deepEqual((await getSem(call, file, ALICE)).body, { data: { locked: false, settings: null } });
  assert.deepEqual((await getSem(call, file, CAROL)).body, { data: { locked: true } });
  assert.equal(w.settingsLog.length, 0, 'an administrator who reads nothing is not logged as having read something');
  assert.deepEqual((await getSem(call, file, ADMIN)).body, { data: { locked: false, settings: null } });
  assert.equal(w.settingsLog.length, 0);
});

test('GET /sem-settings: an unowned file is read by whoever can read a record it is linked to, decided by reading the junctions AS THE CALLER through ItemsService', async () => {
  const w = newWorld();
  const file = semFile(w, { owner: OWNED_BY.nobody });
  w.junctions.sample_data_files.push({ id: ID(4922), sample_id: S1, directus_files_id: file });
  w.junctions.session_data_files.push({ id: ID(4923), session_id: T1, directus_files_id: file });
  const { call } = setup(w);
  const bob = await getSem(call, file, BOB); // Bob can edit (so read) S1
  assert.deepEqual(bob.body.data.settings, VALUES);
  assert.equal(bob.body.data.can_edit, false, 'nobody owns an unowned file, so nobody may correct it here');
  const reads = w.items.filter((i) => i.op === 'read');
  assert.ok(reads.length >= 1);
  assert.ok(reads.every((r) => r.accountability.user === U.bob && r.accountability.admin === false), 'every read ran with the caller\'s own accountability');
  assert.ok(reads.every((r) => Object.values(LINK_TARGETS).some((t) => t.junction === r.collection)), 'the junction collections');
  assert.deepEqual(reads[0].query.filter, { directus_files_id: { _eq: file } });
  assert.equal(w.settingsLog.length, 0);
  // Carol can read neither record
  assert.deepEqual((await getSem(call, file, CAROL)).body, { data: { locked: true } });
  // Carol can read S3 (view-only) and a file linked to it is hers to read
  const viewed = semFile(w, { owner: OWNED_BY.nobody });
  w.junctions.sample_data_files.push({ id: ID(4924), sample_id: S3, directus_files_id: viewed });
  assert.equal((await getSem(call, viewed, CAROL)).body.data.locked, false);
});

test('GET /sem-settings: an unowned file linked nowhere, or whose junction read is refused, is locked for a member; an administrator reads it (and is logged)', async () => {
  const w = newWorld();
  const orphan = semFile(w, { owner: OWNED_BY.nobody });
  const linked = semFile(w, { owner: OWNED_BY.nobody });
  w.junctions.sample_data_files.push({ id: ID(4925), sample_id: S1, directus_files_id: linked });
  const { call } = setup(w);
  assert.deepEqual((await getSem(call, orphan, ALICE)).body, { data: { locked: true } });
  w.denyJunctionRead = true;
  assert.deepEqual((await getSem(call, linked, ALICE)).body, { data: { locked: true } }, 'a refused read is "not allowed", not an error');
  w.denyJunctionRead = false;
  assert.equal((await getSem(call, linked, ALICE)).body.data.locked, false);
  const admin = await getSem(call, orphan, ADMIN);
  assert.equal(admin.body.data.locked, false);
  assert.equal(w.settingsLog.at(-1).reason, 'admin_read');
});

test('GET /sem-settings: a file that does not exist is locked, a bad or missing file id is 400, a Lab Viewer may read', async () => {
  const w = newWorld();
  const file = semFile(w);
  const { call } = setup(w);
  assert.deepEqual((await getSem(call, ID(7999), ALICE)).body, { data: { locked: true } });
  assert.deepEqual((await getSem(call, ID(7999), ADMIN)).body, { data: { locked: true } }, 'there is nothing to read or log');
  assert.equal(w.settingsLog.length, 0);
  for (const bad of [undefined, '', 'x', `${file}x`, ['a', 'b']]) assert.equal((await getSem(call, bad, ALICE)).statusCode, 400, JSON.stringify(bad));
  const viewerFile = semFile(w, { owner: { owner_person_id: P.viewer, owner_team_id: null } });
  const res = await getSem(call, viewerFile, { user: U.viewer, role: LAB_VIEWER_ROLE_ID });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.locked, false);
  assert.equal(res.body.data.can_edit, true, 'the route would still refuse a Lab Viewer\'s PATCH (READ_ONLY_ROLE)');
});

test('GET /sem-settings: a failing log insert is a 500 and no value is sent (the read is logged or it does not happen)', async () => {
  const w = newWorld();
  const file = semFile(w);
  const { call, errors } = setup(w);
  w.settingsLog.push = () => { throw new Error('log table down'); };
  const res = await getSem(call, file, ADMIN);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.data, undefined);
  assert.equal(errors.length, 1);
});

const patchSem = (call, file, body, who) => call('PATCH /sem-settings/:file', { ...who, params: { file }, body });

test('PATCH /sem-settings/<file>: the owner corrects a value; sources.kv is manual; the answer is the settings as the GET gives them; it runs in a transaction that starts with the actor', async () => {
  const w = newWorld();
  const file = semFile(w);
  const { call } = setup(w);
  const res = await patchSem(call, file, { field: 'kv', value: 20 }, ALICE);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.locked, false);
  assert.equal(res.body.data.settings.kv, 20);
  assert.equal(res.body.data.sources.kv, 'manual');
  assert.equal(res.body.data.sources.magnification, 'derived', 'the other fields keep their source');
  assert.equal(res.body.data.can_edit, true);
  assert.equal(w.settings.get(file).sources.kv, 'manual');
  assert.equal(w.settings.get(file).corrected_by, U.alice);
  const call1 = w.log.find((l) => l.name === 'semCorrect');
  assert.deepEqual(call1.bindings, [file, 'kv', '20', U.alice], 'the function gets the file, the field, the value as JSON text and the user');
  assert.match(SQL.semCorrect, /d1_private\.correct_sem_setting\(\?, \?, \?::jsonb, \?\)/);
  assert.equal(w.log.find((l) => l.tx === call1.tx).name, 'setActor');
  // text and time corrections take their JSON as it is
  assert.equal((await patchSem(call, file, { field: 'detector', value: 'BSE' }, ALICE)).body.data.settings.detector, 'BSE');
  assert.deepEqual(w.log.filter((l) => l.name === 'semCorrect').at(-1).bindings.slice(1, 3), ['detector', '"BSE"']);
  assert.equal((await patchSem(call, file, { field: 'acquired_at', value: '2026-03-02T11:00:00+00:00' }, ALICE)).statusCode, 200);
});

test('PATCH /sem-settings/<file>: a member of the owner team may correct a team file', async () => {
  const w = newWorld();
  const file = semFile(w, { owner: OWNED_BY.team });
  const { call } = setup(w);
  assert.equal((await patchSem(call, file, { field: 'spot', value: 4 }, BOB)).statusCode, 200);
  assert.equal(w.settings.get(file).sources.spot, 'manual');
});

test('PATCH /sem-settings/<file>: anyone else is 403 FORBIDDEN and nothing changes: another member, an administrator who is not the owner, a Former team member, an unowned file, a file that does not exist', async () => {
  const w = newWorld();
  const mine = semFile(w);
  const team = semFile(w, { owner: OWNED_BY.team });
  const unowned = semFile(w, { owner: OWNED_BY.nobody });
  const { call } = setup(w);
  const before = JSON.stringify([...w.settings]);
  const body = { field: 'kv', value: 20 };
  for (const [file, who, label] of [[mine, BOB, 'another member'], [mine, CAROL, 'a stranger'], [mine, ADMIN, 'an administrator who is not the owner'], [team, CAROL, 'outside the team'],
    [team, { user: U.former }, 'a Former team member'], [team, ADMIN, 'an administrator, team file'], [unowned, ALICE, 'an unowned file, a member'], [unowned, ADMIN, 'an unowned file, an administrator'],
    [ID(7998), ALICE, 'no such file']]) {
    const res = await patchSem(call, file, body, who);
    assert.equal(res.statusCode, 403, label);
    assert.equal(codeOf(res), 'FORBIDDEN', label);
    assert.equal(errorOf(res).extensions.source, 'd1-inbox');
  }
  assert.equal(JSON.stringify([...w.settings]), before);
  assert.equal(w.log.some((l) => l.name === 'semCorrect'), false, 'the function was never called');
});

test('PATCH /sem-settings/<file>: an unknown field (read_by, sources, directus_files_id) or a value the function refuses is 400 INVALID_PAYLOAD and nothing changes; a missing row is 404', async () => {
  const w = newWorld();
  const file = semFile(w);
  const bare = semFile(w, { settings: false });
  const { call } = setup(w);
  const before = JSON.stringify([...w.settings]);
  for (const field of ['read_by', 'sources', 'flags', 'directus_files_id', 'corrected_by', 'nope']) {
    const res = await patchSem(call, file, { field, value: 'x' }, ALICE);
    assert.equal(res.statusCode, 400, field);
    assert.equal(codeOf(res), 'INVALID_PAYLOAD', field);
    assert.equal(errorOf(res).extensions.field, 'field', field);
  }
  for (const [field, value] of [['kv', 99], ['kv', 'ten'], ['kv', null], ['magnification', 2], ['magnification', 5000.5], ['spot', 0], ['detector', ''], ['acquired_at', 'not a time']]) {
    const res = await patchSem(call, file, { field, value }, ALICE);
    assert.equal(res.statusCode, 400, `${field}=${value}`);
    assert.equal(errorOf(res).extensions.field, 'value', field);
  }
  assert.equal(JSON.stringify([...w.settings]), before, 'a refused correction changes nothing');
  const gone = await patchSem(call, bare, { field: 'kv', value: 10 }, ALICE);
  assert.equal(gone.statusCode, 404);
  assert.equal(codeOf(gone), 'NOT_FOUND');
});

test('PATCH /sem-settings/<file>: the body is { field, value } and nothing else; a bad file id is 400; a Lab Viewer is READ_ONLY_ROLE', async () => {
  const w = newWorld();
  const file = semFile(w, { owner: { owner_person_id: P.viewer, owner_team_id: null } });
  const { call } = setup(w);
  for (const body of [undefined, null, [], {}, { value: 1 }, { field: 'kv' }, { field: 7, value: 1 }, { field: 'kv', value: 1, extra: true }, { field: 'kv', value: undefined }]) {
    const res = await patchSem(call, semFile(w), body, ALICE);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await patchSem(call, 'not-a-uuid', { field: 'kv', value: 1 }, ALICE)).statusCode, 400);
  const viewer = await patchSem(call, file, { field: 'kv', value: 10 }, { user: U.viewer, role: LAB_VIEWER_ROLE_ID });
  assert.equal(viewer.statusCode, 403);
  assert.equal(codeOf(viewer), 'READ_ONLY_ROLE');
  assert.equal(w.log.some((l) => l.name === 'semCorrect'), false);
});

// Administrators are read-only on other people's files: the write rule is canChange, never canSee.
const adminCall = (call, key, body) => call(key, { ...ADMIN, body });

test('test_admin_cannot_link_others_files: POST /link by an administrator who is not the owner or a member of the owner team is 403 FORBIDDEN, nothing is written', async () => {
  const w = newWorld();
  const person = add(w, cand());
  const team = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const scan = add(w, cand({ kind: 'surface_scan', matches: [], suggested_collection: null, suggested_record_id: null, match_strength: 'none' }));
  const { call } = setup(w);
  for (const [c, item] of [[person, link(person)], [team, link(team)], [scan, { candidate_id: scan.candidate_id, collection: 'surface_scans', insert_id: INS1, condition: 'worn' }]]) {
    const res = await adminCall(call, 'POST /link', { items: [item] });
    assert.equal(res.statusCode, 403, JSON.stringify(res.body));
    assert.equal(codeOf(res), 'FORBIDDEN');
    assert.equal(errorOf(res).extensions.candidate_id, c.candidate_id);
    assert.match(errorOf(res).message, /administrator/i);
    assert.equal(c.state, 'new');
  }
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.scans.length, 0);
  assert.equal(w.settings.size, 0);
  assert.equal(savesOf(w).length, 0);
  // one file of someone else in a batch refuses the whole batch
  const own = add(w, cand({ owner_person_id: P.admin }));
  const mixed = await adminCall(call, 'POST /link', { items: [link(own, 'physical_samples', S1), link(person)] });
  assert.equal(mixed.statusCode, 403);
  assert.equal(own.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  // their own file, and a file of a team they belong to, link as before
  assert.equal((await adminCall(call, 'POST /link', { items: [link(own)] })).statusCode, 200);
  w.teamMembers.push({ team_id: TEAM, person_id: P.admin });
  assert.equal((await adminCall(call, 'POST /link', { items: [link(team)] })).statusCode, 200);
});

test('POST /accept-all by an administrator for someone else\'s files is 403 FORBIDDEN (a run and a preview), by candidate_ids and by a person filter; the administrator\'s own files still link', async () => {
  const w = newWorld();
  const theirs = add(w, candFor('physical_samples', S1));
  const mine = add(w, candFor('physical_samples', S1, { owner_person_id: P.admin }));
  w.acceptIds = [theirs.candidate_id];
  const { call } = setup(w);
  for (const body of [
    { candidate_ids: [theirs.candidate_id] }, { candidate_ids: [theirs.candidate_id], dry_run: true },
    { filter: { tab: 'new', owner: `person:${P.alice}` } }, { filter: { tab: 'new', owner: `person:${P.alice}` }, dry_run: true },
  ]) {
    const res = await adminCall(call, 'POST /accept-all', body);
    assert.equal(res.statusCode, 403, JSON.stringify(body));
    assert.equal(codeOf(res), 'FORBIDDEN');
  }
  assert.equal(theirs.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(savesOf(w).length, 0);
  w.acceptIds = [mine.candidate_id];
  const ok = await adminCall(call, 'POST /accept-all', { filter: { tab: 'new' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.linked, 1);
});

test('POST /dismiss, /restore and /undo by an administrator for someone else\'s files are 403 FORBIDDEN and change nothing', async () => {
  const w = newWorld();
  const fresh = add(w, cand());
  const dismissed = add(w, cand({ state: 'dismissed' }));
  const linkedByAlice = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(linkedByAlice)] } })).body.data.link_batch_id;
  const dismiss = await adminCall(call, 'POST /dismiss', { candidate_ids: [fresh.candidate_id] });
  assert.equal(dismiss.statusCode, 403);
  assert.equal(codeOf(dismiss), 'FORBIDDEN');
  assert.equal(fresh.state, 'new');
  const restore = await adminCall(call, 'POST /restore', { candidate_ids: [dismissed.candidate_id] });
  assert.equal(restore.statusCode, 403);
  assert.equal(dismissed.state, 'dismissed');
  const undo = await adminCall(call, 'POST /undo', { link_batch_id: batch });
  assert.equal(undo.statusCode, 403);
  assert.equal(codeOf(undo), 'FORBIDDEN');
  assert.equal(linkedByAlice.state, 'linked');
  assert.equal(w.junctions.sample_data_files.length, 1);
  assert.equal(w.settings.size, 1, 'the settings stay');
  // their own files
  const own = add(w, cand({ owner_person_id: P.admin }));
  assert.equal((await adminCall(call, 'POST /dismiss', { candidate_ids: [own.candidate_id] })).statusCode, 200);
  assert.equal((await adminCall(call, 'POST /restore', { candidate_ids: [own.candidate_id] })).statusCode, 200);
  // the owner and the linker may still undo
  assert.equal((await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } })).statusCode, 200);
});

test('administrators keep reading: the list shows another person\'s files (and the acceptable count leaves them out), the summary and the admin page work', async () => {
  const w = newWorld();
  const theirs = add(w, candFor('physical_samples', S1));
  w.listRows = [{ ...theirs, name: 'x.tif', mime_type: 'image/tiff', owner_name: 'Alice A', decided_by_name: null }];
  w.listTotal = 1;
  w.acceptIds = [theirs.candidate_id];
  const { call } = setup(w);
  const list = await call('GET /files', { ...ADMIN, query: { owner: `person:${P.alice}`, acceptable: '1' } });
  assert.equal(list.statusCode, 200, JSON.stringify(list.body));
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.meta.acceptable, 0, 'accept all would not link a file the administrator may not change');
  assert.equal((await call('GET /summary', ADMIN)).statusCode, 200);
  assert.equal((await call('GET /admin', ADMIN)).statusCode, 200);
});

test('the crawler\'s auto-link is unaffected: it acts for the owner, never for an administrator', async () => {
  const w = newWorld();
  const c = add(w, cand({ owner_person_id: P.admin, extracted: SEM_EXTRACTED }));
  w.prefs.set(U.admin, true);
  const res = await auto(w, [c.candidate_id]);
  assert.equal(res.body.data.results[0].status, 'linked', JSON.stringify(res.body));
  assert.equal(savesOf(w).length, 1);
  const theirs = add(w, cand({ extracted: SEM_EXTRACTED }));
  w.prefs.set(U.alice, true);
  assert.equal((await auto(w, [theirs.candidate_id])).body.data.results[0].status, 'linked');
});

test('ERRORS.adminReadOnly and the new SQL: the words, and the statements stay inside d1_private, directus_files and the link tables', () => {
  const err = ERRORS.adminReadOnly(ID(1001));
  assert.equal(err.status, 403);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.extra.candidate_id, ID(1001));
  assert.match(SQL.semFile, /FROM directus_files WHERE id = \?/);
  assert.match(SQL.semSettingsGet, /FROM d1_private\.sem_image_settings WHERE directus_files_id = \?/);
  assert.match(SQL.semAccessLogInsert, /^INSERT INTO d1_private\.sem_settings_access_log \(directus_files_id, read_by_user, reason\) VALUES \(\?, \?, \?\)/);
});

// ---- rescan ----------------------------------------------------------------------------------------------------------------

test('POST /rescan queues one person-scope request; a second within 10 minutes is 429 with the seconds to wait', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const first = await call('POST /rescan', { user: U.alice });
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.data.queued, true);
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
    'skipped:BACKLOG', 'skipped:TEAM_FILE', 'skipped:COPY', 'skipped:SURFACE_SCAN', 'skipped:NOT_NEW',
  ]);
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.junctions.operation_data_files.length + w.junctions.session_data_files.length, 0);
});

test('unfit: an undone auto-link is UNDONE for auto-link only; a person\'s own Link and Accept all of that file stay allowed', () => {
  const undone = cand({ auto_undone_at: '2026-10-15T10:00:00.000Z' });
  assert.equal(unfit(undone, { auto: true }), 'UNDONE');
  assert.equal(unfit(undone, { auto: false }), null, 'accept-all is a person acting: allowed');
  assert.equal(unfit(cand(), { auto: true }), null);
  assert.equal(unfit(cand({ state: 'dismissed', auto_undone_at: '2026-10-15T10:00:00.000Z' }), { auto: true }), 'NOT_NEW', 'the state comes first');
});

test('POST /undo of an AUTO batch marks the files undone: the next auto-link skips them as UNDONE, nothing is linked', async () => {
  const w = newWorld();
  const c = add(w, cand());
  const s = setup(w);
  w.prefs.set(U.alice, true);
  const first = await auto(w, [c.candidate_id], undefined, { setup: s });
  const batch = first.body.data.results[0].link_batch_id;
  assert.equal(c.link_kind, 'auto');
  assert.equal(c.auto_undone_at, null, 'linked, not undone');
  const undo = await s.call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(undo.statusCode, 200);
  assert.equal(c.state, 'new');
  assert.equal(c.link_kind, null, 'all four link columns cleared together as before');
  assert.equal(c.auto_undone_at, w.now.toISOString(), 'the undo of an auto batch is remembered');
  assert.equal(w.junctions.sample_data_files.length, 0);
  const again = await auto(w, [c.candidate_id], undefined, { setup: s });
  assert.deepEqual(again.body.data.results.map((r) => [r.status, r.reason]), [['skipped', 'UNDONE']]);
  assert.equal(c.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0, 'no second junction row');
});

test('an undone auto-link file is still the person\'s to link: a manual Link and Accept all work and clear nothing; undoing that manual batch keeps the mark', async () => {
  const w = newWorld();
  const c = add(w, candFor('physical_samples', S1, { auto_undone_at: '2026-10-15T10:00:00.000Z' }));
  w.acceptIds = [c.candidate_id];
  const s = setup(w);
  const preview = await s.call('POST /accept-all', { user: U.alice, body: { dry_run: true } });
  assert.deepEqual(preview.body.data.ids, [c.candidate_id], 'Accept all considers it');
  const manual = await s.call('POST /link', { user: U.alice, body: { items: [link(c)] } });
  assert.equal(manual.statusCode, 200, JSON.stringify(manual.body));
  assert.equal(c.state, 'linked');
  assert.equal(c.link_kind, 'manual');
  assert.equal(c.auto_undone_at, '2026-10-15T10:00:00.000Z', 'a manual link clears nothing');
  const undo = await s.call('POST /undo', { user: U.alice, body: { link_batch_id: manual.body.data.link_batch_id } });
  assert.equal(undo.statusCode, 200);
  assert.equal(c.auto_undone_at, '2026-10-15T10:00:00.000Z', 'and undoing it does not clear the mark');
  const all = await s.call('POST /accept-all', { user: U.alice, body: {} });
  assert.equal(all.body.data.linked, 1, 'Accept all links it');
  assert.equal(c.link_kind, 'bulk');
});

test('POST /undo of a MANUAL or bulk batch does not set auto_undone_at: the file is a plain new file again', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const s = setup(w);
  const one = await s.call('POST /link', { user: U.alice, body: { items: [link(a)] } });
  const two = await s.call('POST /link', { user: U.alice, body: { items: [link(b), link(add(w, cand()))] } });
  for (const [res, c] of [[one, a], [two, b]]) {
    await s.call('POST /undo', { user: U.alice, body: { link_batch_id: res.body.data.link_batch_id } });
    assert.equal(c.state, 'new');
    assert.equal(c.auto_undone_at, null);
  }
  w.prefs.set(U.alice, true);
  assert.equal((await auto(w, [a.candidate_id], undefined, { setup: s })).body.data.results[0].status, 'linked', 'nothing remembers a manual undo');
});

test('the SQL: undo remembers an undone auto link in the same UPDATE that clears the link columns, and the candidate reads carry it', () => {
  assert.match(SQL.resetBatch, /auto_undone_at = CASE WHEN link_kind = 'auto' THEN now\(\) ELSE auto_undone_at END/);
  assert.match(SQL.resetBatch, /link_kind = NULL, linked_collection = NULL, linked_junction_id = NULL, link_batch_id = NULL/);
  for (const name of ['candidatesForUpdate', 'candidatesById', 'batchForUpdate']) assert.match(SQL[name], /c\.auto_undone_at/, name);
  for (const name of ['restore', 'dismiss', 'markLinked']) assert.doesNotMatch(SQL[name], /auto_undone_at/, `${name} neither sets nor clears it`);
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

test('a crawler secret shorter than 32 characters is treated as not set: auto-link refuses every call, and a warning says so', async () => {
  const w = newWorld();
  const c = add(w, cand());
  w.prefs.set(U.alice, true);
  const warned = [];
  const short = setup(w, { env: { D1_INBOX_CRAWLER_SECRET: 'short-secret' } });
  short.context.logger.warn = (m) => warned.push(m);
  // mount ran before the spy: mount again to see the warning
  const router = fakeRouter();
  mount(router, { ...short.context, env: { D1_INBOX_CRAWLER_SECRET: 'x'.repeat(31) } });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /D1_INBOX_CRAWLER_SECRET/);
  const res = await short.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] }, headers: { 'x-inbox-crawler-secret': 'short-secret' } });
  assert.equal(res.statusCode, 403);
  assert.equal(c.state, 'new');
  const ok = setup(w, { env: { D1_INBOX_CRAWLER_SECRET: 'y'.repeat(32) } });
  assert.equal((await ok.call('POST /auto-link', { body: { candidate_ids: [c.candidate_id] }, headers: { 'x-inbox-crawler-secret': 'y'.repeat(32) } })).statusCode, 200);
});

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

test('GET /admin: administrators only; the shape STARbase reads (status, errors, unmatched folders, people without an alias, queued requests)', async () => {
  const w = newWorld();
  w.scanRequests.push({ request_id: ID(7001), scope: 'person', person_id: P.bob, requested_by: U.bob, requested_at: '2026-10-15T09:00:00.000Z', finished_at: '2026-10-15T09:01:00.000Z', status: 'failed', error: 'share unreachable' });
  const { call } = setup(w);
  const denied = await call('GET /admin', { user: U.alice });
  assert.equal(denied.statusCode, 403);
  assert.equal(codeOf(denied), 'FORBIDDEN');
  const res = await call('GET /admin', { user: U.admin, admin: true });
  assert.equal(res.statusCode, 200);
  const d = res.body.data;
  assert.deepEqual(d.status, {
    desired_state: 'running', interval_minutes: 30, read_mb_per_s: 60, daemon: 'alive',
    last_heartbeat_at: '2026-10-15T11:59:30.000Z', daemon_started_at: '2026-10-15T08:00:00.000Z', current_activity: 'idle',
    last_scan_started_at: '2026-10-15T11:30:00.000Z', last_scan_finished_at: '2026-10-15T11:45:00.000Z',
    files_registered: 42, error_count: 1, last_error: 'share briefly unreachable',
  });
  assert.deepEqual(d.errors, [
    { at: '2026-10-15T11:45:00.000Z', message: 'share briefly unreachable' },
    { at: '2026-10-15T09:01:00.000Z', message: 'share unreachable' },
  ]);
  assert.deepEqual(d.unmatched_folders, ['Users/zz9', 'Shared/Old project']);
  assert.deepEqual(d.people_without_alias, [{ person_id: P.dave, full_name: 'Dave D', active: true, has_login: true }]);
  assert.equal(d.queued_requests, 0);
  assert.deepEqual(d.candidates, { new: 5, linked: 2 });
});

test('GET /admin: the daemon verdict is stale or never FIRST (a dead daemon is not paused), then paused, then alive', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const verdict = async (beat, desired) => {
    w.crawlerState.last_heartbeat_at = beat === null ? null : new Date(NOW.getTime() - beat);
    w.crawlerState.desired_state = desired;
    return (await call('GET /admin', { user: U.admin, admin: true })).body.data.status.daemon;
  };
  assert.equal(await verdict(30_000, 'running'), 'alive', 'a heartbeat 30 s ago');
  assert.equal(await verdict(30_000, 'paused'), 'paused', 'alive and asked to pause');
  assert.equal(await verdict(6 * 60_000, 'running'), 'stale', 'no heartbeat for more than five minutes');
  assert.equal(await verdict(6 * 60_000, 'paused'), 'stale', 'dead and paused: stale, not paused');
  assert.equal(await verdict(5 * 60_000, 'running'), 'alive', 'exactly five minutes is still inside the rule');
  assert.equal(await verdict(null, 'running'), 'never');
  assert.equal(await verdict(null, 'paused'), 'never', 'never ran and paused: never, not paused');
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
  assert.equal(res.body.data.queued, true);
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

// ---- the pictures (spec section 14) ---------------------------------------------------------------------------------------------

const JPEG_THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
const JPEG_PREVIEW = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0a, 0x0b, 0x0c, 0x0d]);
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const withPicture = (w, c) => { w.thumbs.set(c.candidate_id, { thumb: JPEG_THUMB, preview: JPEG_PREVIEW }); return c; };
const picture = (call, kind, id, user, extra = {}) => call(`GET /files/:candidate_id/${kind}`, { user, params: { candidate_id: id }, ...extra });

test('GET /files: has_thumbnail is a boolean per row, true only when the list query says a picture pair exists, and the bytes are never in the list', async () => {
  const w = newWorld();
  const a = cand();
  const b = cand();
  w.listRows = [listRow(a, { has_thumbnail: true }), listRow(b)];
  w.listTotal = 2;
  const { call } = setup(w);
  const res = await call('GET /files', { user: U.alice, query: { tab: 'new' } });
  assert.deepEqual(res.body.data.map((r) => r.has_thumbnail), [true, false]);
  const page = buildListQuery({ personId: P.alice, teamIds: [], admin: false }, parseFileFilters({}));
  assert.match(page.sql, /EXISTS \(SELECT 1 FROM d1_private\.file_thumbnails th WHERE th\.candidate_id = c\.candidate_id AND th\.thumb IS NOT NULL\) AS has_thumbnail/, 'a failure marker (thumb NULL) is not a thumbnail');
  assert.doesNotMatch(page.sql.replace('th.thumb IS NOT NULL', ''), /\b(th|t)\.(thumb|preview)\b/, 'the list never selects the bytes');
  const info = { readable: new Set(), labels: new Map(), editable: new Set() };
  assert.equal(fileOut(listRow(a, { has_thumbnail: 'yes' }), info).has_thumbnail, false, 'only a real true counts');
  assert.equal(fileOut(listRow(a), info).has_thumbnail, false, 'a row without the column is false, not undefined');
});

test('GET /files/:id/thumb and /preview: the owner gets the JPEG itself with the right headers and no JSON wrapping', async () => {
  const w = newWorld();
  const a = withPicture(w, add(w, cand()));
  const { call } = setup(w);
  for (const [kind, bytes] of [['thumb', JPEG_THUMB], ['preview', JPEG_PREVIEW]]) {
    const res = await picture(call, kind, a.candidate_id, U.alice);
    assert.equal(res.statusCode, 200, kind);
    assert.equal(res.headers['content-type'], 'image/jpeg', kind);
    assert.equal(res.headers['cache-control'], 'private, no-cache', kind);
    assert.equal(res.headers.vary, 'Cookie, Authorization', kind);
    assert.doesNotMatch(res.headers['cache-control'], /max-age/, 'a cached picture would skip canSee');
    assert.equal(res.headers.etag, `"${md5(bytes)}"`, kind);
    assert.equal(res.headers['content-length'], String(bytes.length), kind);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', kind);
    assert.deepEqual(res.raw, bytes, `${kind}: the stored bytes, as they are`);
    assert.equal(res.body, undefined, `${kind}: res.json is never used for a picture`);
  }
  assert.notEqual(md5(JPEG_THUMB), md5(JPEG_PREVIEW), 'each picture has its own ETag');
  assert.equal(w.log.filter((l) => l.name === 'thumbBytes.thumb').length, 1);
  assert.equal(w.log.some((l) => l.name === 'setActor'), false, 'a read: no transaction, no actor');
});

test('GET /files/:id/thumb: visible to exactly who sees the file in the list (canSee): the owner, an active member of the owner team, an administrator; nobody else', async () => {
  const w = newWorld();
  const own = withPicture(w, add(w, cand()));
  const team = withPicture(w, add(w, cand({ owner_person_id: null, owner_team_id: TEAM })));
  const { call } = setup(w);
  // [personal file, team file] visible? Alice and Bob are in the SEM team, Carol only in another team, Dave in none, Former is inactive
  for (const [who, expected] of [[U.alice, [true, true]], [U.bob, [false, true]], [U.carol, [false, false]], [U.dave, [false, false]], [U.former, [false, false]]]) {
    for (const [c, want] of [[own, expected[0]], [team, expected[1]]]) {
      const res = await picture(call, 'thumb', c.candidate_id, who);
      assert.equal(res.statusCode, want ? 200 : 404, `${who} on ${c.owner_person_id ? 'a personal' : 'a team'} file`);
      if (want) assert.deepEqual(res.raw, JPEG_THUMB); else assert.equal(res.raw, undefined, 'no byte of a picture the caller cannot see');
    }
  }
  assert.equal((await picture(call, 'thumb', own.candidate_id, U.admin, { admin: true })).statusCode, 200, 'an administrator sees all, as in canSee');
  assert.equal((await picture(call, 'preview', team.candidate_id, U.admin, { admin: true })).statusCode, 200);
});

test('GET /files/:id/thumb: not visible, no picture, no such file, a gone file and a bad id are all the same 404 (nothing confirms an id), and no bytes are read for them', async () => {
  const w = newWorld();
  const hidden = withPicture(w, add(w, cand({ owner_person_id: P.bob })));
  const none = add(w, cand());
  const gone = withPicture(w, add(w, cand({ state: 'gone' })));
  const marker = add(w, cand());
  w.thumbs.set(marker.candidate_id, { thumb: null, preview: null, failed_reason: 'could not be decoded' });
  const { call } = setup(w);
  const answers = [];
  for (const id of [hidden.candidate_id, none.candidate_id, ID(9999), gone.candidate_id, marker.candidate_id, 'not-a-uuid', undefined]) {
    const res = await picture(call, 'preview', id, U.alice);
    assert.equal(res.statusCode, 404, String(id));
    assert.equal(codeOf(res), 'NOT_FOUND', String(id));
    assert.equal(errorOf(res).extensions.source, 'd1-inbox');
    assert.equal(res.raw, undefined);
    for (const h of ['etag', 'cache-control', 'vary']) assert.equal(res.headers[h], undefined, `no ${h} on a 404`);
    answers.push(res.body);
  }
  assert.deepEqual(answers, answers.map(() => answers[0]), 'one answer for every reason');
  assert.deepEqual(answers[0], { errors: [{ message: ERRORS.noPicture().message, extensions: { code: 'NOT_FOUND', source: 'd1-inbox' } }] });
  assert.equal(w.log.filter((l) => /^thumbBytes/.test(l.name ?? '')).length, 0, 'bytes were never read');
  // an upper-case id is the same id
  const upper = await picture(call, 'thumb', withPicture(w, add(w, cand())).candidate_id.toUpperCase(), U.alice);
  assert.equal(upper.statusCode, 200);
});

test('GET /files/:id/thumb and /preview: a failure marker row (no pictures) is a 404 for the owner too, with no bytes read and no caching headers, even with a matching If-None-Match', async () => {
  const w = newWorld();
  const a = add(w, cand());
  w.thumbs.set(a.candidate_id, { thumb: null, preview: null, failed_reason: 'could not be decoded' });
  const { call } = setup(w);
  for (const kind of ['thumb', 'preview']) {
    for (const headers of [{}, { 'if-none-match': '*' }, { 'if-none-match': `"${md5(Buffer.alloc(0))}"` }]) {
      const res = await picture(call, kind, a.candidate_id, U.alice, { headers });
      assert.equal(res.statusCode, 404, kind);
      assert.equal(codeOf(res), 'NOT_FOUND');
      assert.equal(res.raw, undefined);
      for (const h of ['etag', 'cache-control', 'vary']) assert.equal(res.headers[h], undefined, `${kind}: no ${h}`);
    }
  }
  assert.equal(w.log.filter((l) => /^thumbBytes/.test(l.name ?? '')).length, 0, 'bytes were never read for a marker');
});

test('GET /files/:id/thumb: the picture vanishing (or becoming a marker) between the cheap step and the bytes is a plain 404 with no caching headers', async () => {
  for (const after of [(w, id) => w.thumbs.delete(id), (w, id) => w.thumbs.set(id, { thumb: null, preview: null, failed_reason: 'x' })]) {
    const w = newWorld();
    const a = withPicture(w, add(w, cand()));
    w.afterThumbMeta = (world) => after(world, a.candidate_id);
    const { call } = setup(w);
    const res = await picture(call, 'thumb', a.candidate_id, U.alice);
    assert.equal(res.statusCode, 404);
    assert.equal(codeOf(res), 'NOT_FOUND');
    assert.equal(res.raw, undefined);
    for (const h of ['etag', 'cache-control', 'vary', 'content-type', 'content-length']) assert.equal(res.headers[h], undefined, `no ${h}`);
  }
});

test('GET /files/:id/thumb: a picture replaced between the cheap step and the bytes goes out under the ETag of the bytes sent, not the old one', async () => {
  const w = newWorld();
  const a = withPicture(w, add(w, cand()));
  const fresh = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x09, 0x09, 0x09]);
  w.afterThumbMeta = (world) => world.thumbs.set(a.candidate_id, { thumb: fresh, preview: JPEG_PREVIEW });
  const { call } = setup(w);
  const res = await picture(call, 'thumb', a.candidate_id, U.alice);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.raw, fresh);
  assert.equal(res.headers.etag, `"${md5(fresh)}"`, 'the tag of the bytes sent');
  assert.notEqual(res.headers.etag, `"${md5(JPEG_THUMB)}"`);
});

test('GET /files/:id/thumb: 401 without a user; a Lab Viewer may read pictures of their own inbox (a read is not a write)', async () => {
  const w = newWorld();
  const a = withPicture(w, add(w, cand({ owner_person_id: P.viewer })));
  const { call } = setup(w);
  const anon = await picture(call, 'thumb', a.candidate_id, undefined);
  assert.equal(anon.statusCode, 401);
  assert.equal(codeOf(anon), 'UNAUTHORIZED');
  const viewer = await picture(call, 'thumb', a.candidate_id, U.viewer, { role: LAB_VIEWER_ROLE_ID });
  assert.equal(viewer.statusCode, 200);
  assert.deepEqual(viewer.raw, JPEG_THUMB);
});

test('GET /files/:id/thumb: If-None-Match with the current ETag is a 304 with no body and no bytes read; another or old tag, or none, is a 200', async () => {
  const w = newWorld();
  const a = withPicture(w, add(w, cand()));
  const { call } = setup(w);
  const etag = `"${md5(JPEG_THUMB)}"`;
  const hit = await picture(call, 'thumb', a.candidate_id, U.alice, { headers: { 'if-none-match': etag } });
  assert.equal(hit.statusCode, 304);
  assert.equal(hit.raw, undefined, 'no body');
  assert.equal(hit.ended, true);
  assert.equal(hit.headers.etag, etag, 'a 304 repeats the ETag');
  assert.equal(hit.headers['cache-control'], 'private, no-cache');
  assert.equal(hit.headers.vary, 'Cookie, Authorization');
  assert.equal(hit.headers['content-type'], undefined);
  assert.equal(w.log.filter((l) => l.name === 'thumbBytes.thumb').length, 0, 'a 304 never moves the bytes');
  for (const header of [`"${md5(JPEG_PREVIEW)}"`, '"stale"', '', undefined]) {
    const res = await picture(call, 'thumb', a.candidate_id, U.alice, { headers: header === undefined ? {} : { 'if-none-match': header } });
    assert.equal(res.statusCode, 200, String(header));
    assert.deepEqual(res.raw, JPEG_THUMB);
  }
  // the thumb's tag is not the preview's
  assert.equal((await picture(call, 'preview', a.candidate_id, U.alice, { headers: { 'if-none-match': etag } })).statusCode, 200);
  assert.equal((await picture(call, 'preview', a.candidate_id, U.alice, { headers: { 'if-none-match': `"${md5(JPEG_PREVIEW)}"` } })).statusCode, 304);
  // a 304 is only for a caller who may see the file: someone else gets the 404 even with the right tag
  assert.equal((await picture(call, 'thumb', a.candidate_id, U.carol, { headers: { 'if-none-match': etag } })).statusCode, 404);
  // a changed picture changes the tag
  w.thumbs.set(a.candidate_id, { thumb: Buffer.from([0xff, 0xd8, 0x00]), preview: JPEG_PREVIEW });
  assert.equal((await picture(call, 'thumb', a.candidate_id, U.alice, { headers: { 'if-none-match': etag } })).statusCode, 200);
});

test('etagMatches: a quoted tag, a list of tags, a weak tag and * match; anything else does not', () => {
  const tag = '"abc"';
  assert.equal(etagMatches('"abc"', tag), true);
  assert.equal(etagMatches('"x", "abc"', tag), true);
  assert.equal(etagMatches('W/"abc"', tag), true);
  assert.equal(etagMatches('*', tag), true);
  for (const bad of ['"abd"', 'abc', '', '   ', undefined, null, ['"abc"']]) assert.equal(etagMatches(bad, tag), false, String(bad));
});

test('the picture SQL reads the bytes of one column chosen from a closed list, for one candidate id, and the visibility step reads no bytes', () => {
  assert.deepEqual(Object.keys(SQL.thumbMeta), ['thumb', 'preview']);
  assert.deepEqual(Object.keys(SQL.thumbBytes), ['thumb', 'preview']);
  for (const kind of ['thumb', 'preview']) {
    assert.match(SQL.thumbMeta[kind], new RegExp(`md5\\(t\\.${kind}\\) AS etag`));
    assert.doesNotMatch(SQL.thumbMeta[kind].replace(/md5\(t\.\w+\)/, ''), /\bt\.(thumb|preview)\b/, 'only the md5 of the picture, never the picture');
    // one candidate id, and (merged with the SEM reader's C1) the file-owner predicate of every candidate read, nothing else
    assert.match(SQL.thumbMeta[kind], /WHERE c\.candidate_id = \? AND NOT EXISTS \(SELECT 1 FROM directus_files pf WHERE pf\.id = c\.directus_files_id AND [^?]*\)\)$/);
    // the bytes and their md5 in one query: the ETag sent always belongs to the bytes sent
    assert.match(SQL.thumbBytes[kind], new RegExp(`^SELECT md5\\(t\\.${kind}\\) AS etag, t\\.${kind} AS bytes FROM d1_private\\.file_thumbnails t WHERE t\\.candidate_id = \\?$`));
  }
});

// ---- ignored folders (spec section 15) ----------------------------------------------------------------------------------------

// The table of cases for the matcher. The crawler's Python test (tests/scripts/test_inbox_crawler_ignored.py) runs the SAME 30 rows through
// scripts/inbox_crawler's is_ignored, row for row: change them together. [folder relative to the owner's root, rules, ignored?]
export const IGNORE_CASES = [
  // the folder itself, and anything beneath it
  ['World-Ti Paper', ['World-Ti Paper'], true],
  ['World-Ti Paper/Drafts', ['World-Ti Paper'], true],
  ['World-Ti Paper/Drafts/v2/figs', ['World-Ti Paper'], true],
  // whole path parts only: a lookalike name is not covered
  ['World-Ti Paper 2', ['World-Ti Paper'], false],
  ['World-Ti Paper 2/Drafts', ['World-Ti Paper'], false],
  ['World-Ti Paperwork', ['World-Ti Paper'], false],
  ['World-Ti', ['World-Ti Paper'], false],
  ['Old World-Ti Paper', ['World-Ti Paper'], false],
  // a rule does not cover its parent or its siblings
  ['World-Ti Paper', ['World-Ti Paper/Drafts'], false],
  ['World-Ti Paper/Final', ['World-Ti Paper/Drafts'], false],
  ['World-Ti Paper/Drafts', ['World-Ti Paper/Drafts'], true],
  ['World-Ti Paper/Drafts/old', ['World-Ti Paper/Drafts'], true],
  // the share is case-insensitive: so is the match, in both directions
  ['world-ti paper/drafts', ['World-Ti Paper'], true],
  ['WORLD-TI PAPER', ['world-ti paper'], true],
  ['World-Ti Paper/DRAFTS', ['world-ti paper/drafts'], true],
  // nested rules and several rules
  ['a/b/c', ['a/b', 'a/b/c'], true],
  ['a/b', ['a/b/c', 'a/b'], true],
  ['a/x', ['a/b', 'a/b/c'], false],
  ['z', ['a', 'z'], true],
  ['z/y', ['a', 'z'], true],
  ['m', ['a', 'z'], false],
  // no wildcards: a star or a question mark is an ordinary character
  ['anything', ['*'], false],
  ['a/b', ['a/*'], false],
  ['a/*', ['a/*'], true],
  // no rules, and the owner's root (empty) are never ignored
  ['a', [], false],
  ['', ['a'], false],
  ['', [], false],
  // a name with a dot or a space is just a name
  ['data.v2/raw', ['data.v2'], true],
  ['data.v2x', ['data.v2'], false],
  ['data v2', ['data.v2'], false],
];

test('isIgnored: the shared table of cases (the crawler runs the same rows in Python)', () => {
  for (const [folder, rules, expected] of IGNORE_CASES) {
    assert.equal(isIgnored(folder, rules), expected, `${JSON.stringify(folder)} against ${JSON.stringify(rules)}`);
  }
  assert.equal(isIgnored('a', undefined), false);
  assert.equal(isIgnored(undefined, ['a']), false);
});

test('folderOfCandidate: the folder of a file relative to its owner root, whatever the case; a file in the root has none', () => {
  assert.equal(folderOfCandidate('Users/ali1/World-Ti Paper/Drafts/a.tif', 'Users/ali1'), 'World-Ti Paper/Drafts');
  assert.equal(folderOfCandidate('users/ALI1/sem/a.tif', 'Users/ali1'), 'sem');
  assert.equal(folderOfCandidate('Users/ali1/a.tif', 'Users/ali1'), '');
  assert.equal(folderOfCandidate('Users/ali10/sem/a.tif', 'Users/ali1'), '', 'another root that starts with the same letters is not under it');
  assert.equal(folderOfCandidate('Shared/SEM/2026/a.tif', 'Shared/SEM'), '2026');
});

test('parseIgnoredFolder: relative to the root, no leading or trailing slash, no empty, . or .. part, never the root, with a message and the field', () => {
  const root = 'Users/ali1';
  for (const ok of ['World-Ti Paper', 'World-Ti Paper/Drafts', 'a.b/..c/d.', 'a b/c', 'Users/ali10/x', 'Users']) assert.equal(parseIgnoredFolder(ok, root), ok, ok);
  const refused = [
    [undefined, /Choose the folder/], [null, /Choose the folder/], [7, /Choose the folder/], ['', /whole folder cannot be ignored/], ['   ', /whole folder cannot be ignored/],
    ['/a', /start or end with a slash/], ['a/', /start or end with a slash/], ['/', /start or end with a slash/], ['a//b', /empty part/], ['.', /\. or \.\./], ['..', /\. or \.\./],
    ['./a', /\. or \.\./], ['a/./b', /\. or \.\./], ['a/../b', /\. or \.\./], ['a/..', /\. or \.\./], ['a\\b', /not \\/], ['a\u0000b', /not allowed/], ['a\nb', /not allowed/],
    ['x'.repeat(501), /too long/], ['Users/ali1', /relative to your own folder/], ['users/ALI1/sem', /relative to your own folder/],
  ];
  for (const [value, message] of refused) {
    assert.throws(() => parseIgnoredFolder(value, root), (e) => e.status === 400 && e.code === 'INVALID_PAYLOAD' && e.extra.field === 'folder' && message.test(e.message), JSON.stringify(value));
  }
  assert.equal(parseIgnoredFolder('x'.repeat(500), root).length, 500);
  assert.doesNotThrow(() => parseIgnoredFolder('Users/ali1', 'Users/bob2'), 'only the caller\'s own root is refused');
});

const rule = (w, over = {}) => {
  const row = { ignored_id: ID(9400 + w.ignored.length), owner_person_id: P.alice, owner_team_id: null, rel_folder: 'World-Ti Paper', created_at: '2026-10-16T08:00:00.000Z', created_by: U.alice, ...over };
  w.ignored.push(row);
  return row;
};
const under = (path, over = {}) => cand({ rel_path: path, ...over });

test('GET /ignored-folders: the caller\'s own rules and their teams\', each with its owner; nobody else\'s; can_remove true for a member, false for a Lab Viewer', async () => {
  const w = newWorld();
  const mine = rule(w, { rel_folder: 'World-Ti Paper/Drafts' });
  const team = rule(w, { owner_person_id: null, owner_team_id: TEAM, rel_folder: 'Old runs', created_by: U.bob });
  rule(w, { owner_person_id: P.bob, rel_folder: 'bobs secret folder' });
  rule(w, { owner_person_id: null, owner_team_id: OTHER_TEAM, rel_folder: 'other team' });
  const { call } = setup(w);
  const alice = await call('GET /ignored-folders', { user: U.alice });
  assert.equal(alice.statusCode, 200);
  assert.deepEqual(alice.body.data, [
    { ignored_id: team.ignored_id, folder: 'Old runs', owner: { kind: 'team', id: TEAM, name: 'SEM team' }, created_at: '2026-10-16T08:00:00.000Z', can_remove: true },
    { ignored_id: mine.ignored_id, folder: 'World-Ti Paper/Drafts', owner: { kind: 'person', id: P.alice, name: 'Alice A' }, created_at: '2026-10-16T08:00:00.000Z', can_remove: true },
  ]);
  assert.deepEqual((await call('GET /ignored-folders', { user: U.bob })).body.data.map((r) => r.folder), ['bobs secret folder', 'Old runs'], 'Bob sees his own and the team\'s, not Alice\'s');
  assert.deepEqual((await call('GET /ignored-folders', { user: U.carol })).body.data.map((r) => r.folder), ['other team']);
  assert.deepEqual((await call('GET /ignored-folders', { user: U.former })).body.data, [], 'a Former person is a member of no team and has no rules');
  assert.deepEqual((await call('GET /ignored-folders', { user: U.nobody })).body.data, [], 'a login with no person has none');
  const viewer = await call('GET /ignored-folders', { user: U.viewer, role: LAB_VIEWER_ROLE_ID });
  assert.equal(viewer.statusCode, 200);
  rule(w, { owner_person_id: P.viewer, rel_folder: 'v' });
  const again = await call('GET /ignored-folders', { user: U.viewer, role: LAB_VIEWER_ROLE_ID });
  assert.deepEqual(again.body.data.map((r) => [r.folder, r.can_remove]), [['v', false]], 'a Lab Viewer reads the rules but may remove none');
  assert.equal(w.txCount, 0, 'a read opens no transaction');
});

test('GET /ignored-folders: meta.can_change is false for a Lab Viewer and true for everyone else, whatever the number of rules (none included)', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const viewerEmpty = await call('GET /ignored-folders', { user: U.viewer, role: LAB_VIEWER_ROLE_ID });
  assert.deepEqual(viewerEmpty.body, { data: [], meta: { can_change: false } }, 'a Lab Viewer with no rules: nothing else says that rules cannot be changed');
  const viewerByParent = await call('GET /ignored-folders', { user: U.viewer, role: ID(70), roles: [ID(70), LAB_VIEWER_ROLE_ID] });
  assert.equal(viewerByParent.body.meta.can_change, false, 'the viewer role anywhere in the role list counts, as it does for every write');
  for (const user of [U.alice, U.bob, U.carol, U.dave, U.former, U.nobody]) {
    assert.deepEqual((await call('GET /ignored-folders', { user })).body, { data: [], meta: { can_change: true } }, `${user}: true with no rules, even a person with no folder (the add itself answers NO_FOLDER)`);
  }
  assert.deepEqual((await call('GET /ignored-folders', { user: U.admin, admin: true })).body.meta, { can_change: true });
  rule(w, { rel_folder: 'a' });
  rule(w, { owner_person_id: P.viewer, rel_folder: 'v' });
  const withRules = await call('GET /ignored-folders', { user: U.alice });
  assert.deepEqual([withRules.body.meta, withRules.body.data.map((r) => r.can_remove)], [{ can_change: true }, [true]]);
  const viewer = await call('GET /ignored-folders', { user: U.viewer, role: LAB_VIEWER_ROLE_ID });
  assert.deepEqual([viewer.body.meta, viewer.body.data.map((r) => r.can_remove)], [{ can_change: false }, [false]], 'independent of how many rules exist');
});

test('POST /ignored-folders: a rule for the caller\'s folder; the open files below it are dismissed in the same transaction, nothing else is', async () => {
  const w = newWorld();
  const inside = add(w, under('Users/ali1/World-Ti Paper/a.tif'), under('Users/ali1/World-Ti Paper/Drafts/deep/b.tif'), under('Users/ali1/world-ti paper/c.tif', { origin: 'backlog' }));
  const [sibling, notBelow, atRoot, linked, gone, dismissed, others, teams] = add(w,
    under('Users/ali1/World-Ti Paper 2/a.tif'), under('Users/ali1/sem/World-Ti Paper/a.tif'), under('Users/ali1/a.tif'),
    under('Users/ali1/World-Ti Paper/linked.tif', { state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_junction_id: ID(5001), link_batch_id: ID(901) }),
    under('Users/ali1/World-Ti Paper/gone.tif', { state: 'gone' }), under('Users/ali1/World-Ti Paper/old.tif', { state: 'dismissed', decided_by: U.bob }),
    under('Users/bob2/World-Ti Paper/b.tif', { owner_person_id: P.bob }), under('Shared/SEM/World-Ti Paper/t.tif', { owner_person_id: null, owner_team_id: TEAM }));
  const { call } = setup(w);
  const res = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'World-Ti Paper' } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body, { data: { ignored_id: w.ignored[0].ignored_id, folder: 'World-Ti Paper', team_id: null, dismissed: 3 } });
  assert.deepEqual(w.ignored.map((r) => [r.owner_person_id, r.owner_team_id, r.rel_folder, r.created_by]), [[P.alice, null, 'World-Ti Paper', U.alice]]);
  for (const c of inside) {
    assert.equal(c.state, 'dismissed', c.rel_path);
    assert.equal(c.decided_by, U.alice, 'dismissed by the person who added the rule, as POST /dismiss records it');
    assert.equal(c.decided_at, NOW.toISOString());
  }
  assert.equal(sibling.state, 'new', 'World-Ti Paper 2 is another folder');
  assert.equal(notBelow.state, 'new', 'a folder of the same name further down is another folder: rules start at the root');
  assert.equal(atRoot.state, 'new');
  assert.equal(linked.state, 'linked', 'a linked file is untouched');
  assert.equal(linked.link_batch_id, ID(901));
  assert.equal(gone.state, 'gone');
  assert.equal(dismissed.state, 'dismissed');
  assert.equal(dismissed.decided_by, U.bob, 'an earlier dismissal is not rewritten');
  assert.equal(others.state, 'new', 'another person\'s file at the same relative path is theirs');
  assert.equal(teams.state, 'new', 'a team file is another owner\'s');
  // one transaction: the actor first, the lock, then the rule and the dismissal, all under the same transaction id
  const tx = w.log.filter((l) => l.tx);
  assert.equal(new Set(tx.map((l) => l.tx)).size, 1);
  assert.deepEqual(tx.map((l) => l.name), ['setActor', 'lock', 'ignoredCount', 'ignoredFind', 'ignoredInsert', 'openUnderFolder', 'dismiss']);
  assert.equal(actorsOf(w).at(0).bindings[0], U.alice);
  assert.deepEqual(w.log.find((l) => l.name === 'openUnderFolder').bindings, [P.alice, null], 'the owner only: the rule is applied in JS, not by a lowercasing prefix in SQL');
  assert.equal(w.log.find((l) => l.name === 'dismiss').sql, SQL.dismiss, 'the very statement of POST /dismiss');
});

test('POST /ignored-folders: a share whose personal folders are under `User` (INBOX_PERSON_DIR, as on the lab share) gets its files dismissed too; with the variable unset the root stays Users', async () => {
  const before = process.env.INBOX_PERSON_DIR;
  process.env.INBOX_PERSON_DIR = 'User';
  try {
    const w = newWorld();
    const [inside, elsewhere] = add(w, under('User/ali1/World-Ti Paper/a.tif'), under('Users/ali1/World-Ti Paper/a.tif'));
    const { call } = setup(w);
    const res = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'World-Ti Paper' } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.dismissed, 1);
    assert.equal(inside.state, 'dismissed', 'the file under the configured personal-folder directory');
    assert.equal(elsewhere.state, 'new', 'a path under another top-level folder is not the owner\'s folder');
  } finally {
    if (before === undefined) delete process.env.INBOX_PERSON_DIR; else process.env.INBOX_PERSON_DIR = before;
  }
});

test('POST /ignored-folders: which open rows a rule covers is decided in JS by isIgnored, never by a lowercasing prefix in SQL (a character Postgres and JS lowercase differently is still covered)', async () => {
  const w = newWorld();
  // JS lowercases a dotted capital I to "i" plus a combining dot, as the rule and as the path; a Postgres prefix compare on lower() could miss the pair
  const dotted = add(w, under('Users/ali1/i\u0307stanbul/a.tif'), under('Users/ali1/\u03a3\u0391\u03a3/b.tif'));
  const other = add(w, under('Users/ali1/istanbul2/a.tif'));
  const { call } = setup(w);
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: '\u0130stanbul' } })).body.data.dismissed, 1);
  assert.equal(dotted[0].state, 'dismissed');
  assert.equal(dotted[1].state, 'new');
  assert.equal(other.state, 'new');
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: '\u03a3\u0391\u03a3' } })).body.data.dismissed, 1, 'a final sigma in the rule and in the path');
  assert.equal(dotted[1].state, 'dismissed');
  // the statement reads no path: it does not look at a prefix, so SQL and JS cannot disagree about a row
  assert.doesNotMatch(SQL.openUnderFolder, /starts_with|lower\(|LIKE|\bleft\(/);
  assert.doesNotMatch(SQL.openUnderFolder, /FOR UPDATE/, 'nothing is locked: the dismissal changes a row only while it is still new');
});

test('parseIgnoredFolder and POST /ignored-folders: leading and trailing whitespace is trimmed before validating; the trimmed folder is stored, compared and answered', async () => {
  assert.equal(parseIgnoredFolder('  World-Ti Paper/Drafts \n', 'Users/ali1'), 'World-Ti Paper/Drafts');
  assert.equal(parseIgnoredFolder('\ta b/c\u00a0', 'Users/ali1'), 'a b/c', 'tabs and a no-break space too');
  assert.equal(parseIgnoredFolder(` ${'x'.repeat(500)} `, 'Users/ali1').length, 500, 'the length limit is on the trimmed folder');
  for (const [value, message] of [[' / ', /start or end with a slash/], [' /a', /start or end with a slash/], ['a/ ', /whole folder|empty part|slash/], [' Users/ali1/x ', /relative to your own folder/], [' a//b ', /empty part/], [' a/../b ', /\. or \.\./]]) {
    assert.throws(() => parseIgnoredFolder(value, 'Users/ali1'), (e) => e.status === 400 && e.extra.field === 'folder' && message.test(e.message), JSON.stringify(value));
  }
  assert.throws(() => parseIgnoredFolder('a\nb', 'Users/ali1'), /characters that are not allowed/, 'a line break INSIDE the path is still refused');
  const w = newWorld();
  const c = add(w, under('Users/ali1/World-Ti Paper/a.tif'));
  const { call } = setup(w);
  const res = await call('POST /ignored-folders', { user: U.alice, body: { folder: '  World-Ti Paper \n' } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.folder, 'World-Ti Paper', 'answered trimmed');
  assert.equal(res.body.data.dismissed, 1);
  assert.deepEqual(w.ignored.map((r) => r.rel_folder), ['World-Ti Paper'], 'stored trimmed');
  assert.equal(c.state, 'dismissed');
  // the duplicate check sees the trimmed text, so a padded copy of an existing rule is the same rule
  const again = await call('POST /ignored-folders', { user: U.alice, body: { folder: ' world-ti paper ' } });
  assert.equal(again.statusCode, 409);
  assert.equal(codeOf(again), 'ALREADY_IGNORED');
  assert.equal(errorOf(again).extensions.folder, 'world-ti paper');
  assert.equal(w.ignored.length, 1);
  // only whitespace is the whole folder: 400, nothing written
  const blank = await call('POST /ignored-folders', { user: U.alice, body: { folder: ' \n\t ' } });
  assert.equal(blank.statusCode, 400);
  assert.equal(errorOf(blank).extensions.field, 'folder');
  assert.equal(w.ignored.length, 1);
});

test('POST /ignored-folders: dismissed counts every open row of the owner under the rule, hidden copies and rows the list does not show included', async () => {
  const w = newWorld();
  const original = add(w, under('Users/ali1/dup/orig.tif'));
  const copy = add(w, under('Users/ali1/dup/copy.tif', { duplicate_of: original.candidate_id }));
  const { call } = setup(w);
  const res = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'dup' } });
  assert.equal(res.body.data.dismissed, 2, 'the original and its copy: the copy is hidden from the list once its original is dismissed, and still counted here');
  assert.deepEqual([original.state, copy.state], ['dismissed', 'dismissed']);
  assert.match(readFileSync(new URL('./index.js', import.meta.url), 'utf8'), /`dismissed` counts every open \('new'\) row of the owner under the rule/, 'the contract comment says so');
});

test('POST /ignored-folders: a file the rule dismissed can be restored by hand, with the ordinary Restore', async () => {
  const w = newWorld();
  const c = add(w, under('Users/ali1/old/a.tif'));
  const { call } = setup(w);
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: 'old' } })).body.data.dismissed, 1);
  assert.equal(c.state, 'dismissed');
  const restored = await call('POST /restore', { user: U.alice, body: { candidate_ids: [c.candidate_id] } });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.body.data.changed, 1);
  assert.equal(c.state, 'new');
  assert.equal(w.ignored.length, 1, 'the rule stays: restoring a file does not remove the rule');
});

test('POST /ignored-folders: a folder with nothing open under it still makes the rule, dismissed 0; the folder is stored as sent', async () => {
  const w = newWorld();
  const { call } = setup(w);
  const res = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'Brand New/Folder' } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.data, { ignored_id: w.ignored[0].ignored_id, folder: 'Brand New/Folder', team_id: null, dismissed: 0 });
  assert.equal(w.log.some((l) => l.name === 'dismiss'), false, 'no dismissal statement for no files');
});

test('POST /ignored-folders: a team rule by a member dismisses the team\'s open files; a non-member is 403 and writes nothing; so is a team with no folder', async () => {
  const w = newWorld();
  const t1 = add(w, under('Shared/SEM/runs/a.tif', { owner_person_id: null, owner_team_id: TEAM }), under('Shared/SEM/runs/b/c.tif', { owner_person_id: null, owner_team_id: TEAM }));
  const mine = add(w, under('Users/ali1/runs/a.tif'));
  const { call } = setup(w);
  const denied = await call('POST /ignored-folders', { user: U.carol, body: { folder: 'runs', team_id: TEAM } });
  assert.equal(denied.statusCode, 403);
  assert.equal(codeOf(denied), 'FORBIDDEN');
  assert.equal(errorOf(denied).extensions.field, 'team_id');
  const former = await call('POST /ignored-folders', { user: U.former, body: { folder: 'runs', team_id: TEAM } });
  assert.equal(former.statusCode, 403, 'a Former person is a member of no team');
  assert.equal(w.ignored.length, 0);
  assert.equal(t1[0].state, 'new');
  const res = await call('POST /ignored-folders', { user: U.bob, body: { folder: 'runs', team_id: TEAM.toUpperCase() } });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { ignored_id: w.ignored[0].ignored_id, folder: 'runs', team_id: TEAM, dismissed: 2 });
  assert.deepEqual(w.ignored.map((r) => [r.owner_person_id, r.owner_team_id, r.created_by]), [[null, TEAM, U.bob]]);
  assert.deepEqual(t1.map((c) => [c.state, c.decided_by]), [['dismissed', U.bob], ['dismissed', U.bob]]);
  assert.equal(mine.state, 'new', 'Alice\'s own folder of the same name is not the team\'s');
  assert.deepEqual(w.log.find((l) => l.name === 'openUnderFolder').bindings, [null, TEAM], 'the team\'s open rows; the rule is applied in JS');
  // Alice, a member too, may then not add the same rule again
  assert.equal(codeOf(await call('POST /ignored-folders', { user: U.alice, body: { folder: 'RUNS', team_id: TEAM } })), 'ALREADY_IGNORED');
  w.teams[0].share_folder = null;
  const noFolder = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'x', team_id: TEAM } });
  assert.equal(noFolder.statusCode, 409);
  assert.equal(codeOf(noFolder), 'NO_FOLDER');
  assert.equal(codeOf(await call('POST /ignored-folders', { user: U.alice, body: { folder: 'x', team_id: 'not-an-id' } })), 'INVALID_PAYLOAD');
});

test('POST /ignored-folders: a person with no uni alias, and a login with no person, are 409 NO_FOLDER; the whole folder, a path with the root in it and bad paths are 400 with the field', async () => {
  const w = newWorld();
  const { call } = setup(w);
  assert.equal(codeOf(await call('POST /ignored-folders', { user: U.dave, body: { folder: 'x' } })), 'NO_FOLDER');
  assert.equal(codeOf(await call('POST /ignored-folders', { user: U.nobody, body: { folder: 'x' } })), 'NO_FOLDER');
  for (const folder of ['', '/', '/a', 'a/', 'a//b', '.', '..', 'a/../b', 'Users/ali1', 'users/ALI1/sem', undefined, 5]) {
    const res = await call('POST /ignored-folders', { user: U.alice, body: { folder } });
    assert.equal(res.statusCode, 400, JSON.stringify(folder));
    assert.equal(codeOf(res), 'INVALID_PAYLOAD');
    assert.equal(errorOf(res).extensions.field, 'folder');
  }
  for (const body of [undefined, null, [], 'x']) assert.equal((await call('POST /ignored-folders', { user: U.alice, body })).statusCode, 400);
  // a team root cannot be ignored through the team either
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: 'Shared/SEM', team_id: TEAM } })).statusCode, 400);
  assert.equal(w.ignored.length, 0);
  assert.equal(w.txCount, 0, 'a refused request opens no transaction');
});

test('POST /ignored-folders: the same folder twice for one owner is 409 ALREADY_IGNORED whatever the case; another owner may ignore it too; a race on the unique index is the same 409', async () => {
  const w = newWorld();
  const c = add(w, under('Users/ali1/dup/a.tif'));
  const { call } = setup(w);
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: 'World-Ti Paper' } })).statusCode, 201);
  const again = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'world-TI paper' } });
  assert.equal(again.statusCode, 409);
  assert.equal(codeOf(again), 'ALREADY_IGNORED');
  assert.equal(errorOf(again).extensions.source, 'd1-inbox');
  assert.equal(errorOf(again).extensions.field, 'folder');
  assert.equal(w.ignored.length, 1);
  assert.equal((await call('POST /ignored-folders', { user: U.bob, body: { folder: 'World-Ti Paper' } })).statusCode, 201, 'Bob\'s rule for his own folder');
  assert.equal((await call('POST /ignored-folders', { user: U.bob, body: { folder: 'World-Ti Paper', team_id: TEAM } })).statusCode, 201, 'and the team\'s');
  assert.equal(w.ignored.length, 3);
  // two requests past the check at once: the table's unique index refuses the second insert, and nothing of it is kept
  w.skipIgnoredFind = true;
  const raced = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'World-Ti Paper' } });
  assert.equal(raced.statusCode, 409);
  assert.equal(codeOf(raced), 'ALREADY_IGNORED');
  assert.equal(w.ignored.length, 3);
  assert.equal(c.state, 'new', 'a refused rule dismisses nothing');
});

test('POST /ignored-folders: at most 200 rules per owner (409 TOO_MANY_RULES); the 200th is allowed, and the cap is per owner', async () => {
  const w = newWorld();
  for (let n = 0; n < 199; n += 1) rule(w, { rel_folder: `f${n}`, ignored_id: ID(20000 + n) });
  const { call } = setup(w);
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: 'the 200th' } })).statusCode, 201);
  const over = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'the 201st' } });
  assert.equal(over.statusCode, 409);
  assert.equal(codeOf(over), 'TOO_MANY_RULES');
  assert.equal(errorOf(over).extensions.limit, 200);
  assert.equal(w.ignored.length, 200);
  assert.equal((await call('POST /ignored-folders', { user: U.bob, body: { folder: 'x' } })).statusCode, 201, 'Bob has his own 200');
  assert.equal((await call('POST /ignored-folders', { user: U.alice, body: { folder: 'x', team_id: TEAM } })).statusCode, 201, 'and so has the team');
});

test('POST /ignored-folders: if the dismissal fails nothing is kept, the rule included (one transaction); the failure says nothing of its cause', async () => {
  const w = newWorld();
  const c = add(w, under('Users/ali1/boom/a.tif'));
  const { call, errors } = setup(w);
  w.failDismiss = true;
  const res = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'boom' } });
  assert.equal(res.statusCode, 500);
  assert.equal(codeOf(res), 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(errorOf(res).message, /disk/);
  assert.equal(w.ignored.length, 0, 'the rule was rolled back with the dismissal');
  assert.equal(c.state, 'new');
  assert.equal(errors.length, 1);
});

test('DELETE /ignored-folders/:id: removes the rule and RESETS the folder cache below it (rows kept, mtime and listed time NULL); queues a rescan', async () => {
  const w = newWorld();
  const r = rule(w, { rel_folder: 'World-Ti Paper/Drafts' });
  const keep = rule(w, { rel_folder: 'World-Ti Paper/Final' });
  const dir = (rel_path, over = {}) => ({ rel_path, owner_person_id: P.alice, owner_team_id: null, dir_mtime: '2026-10-10T00:00:00.000Z', last_listed_at: '2026-10-15T00:00:00.000Z', baselined_at: null, ...over });
  w.dirs.push(
    dir('Users/ali1', { baselined_at: '2026-10-01T00:00:00.000Z' }), dir('Users/ali1/World-Ti Paper'), dir('Users/ali1/World-Ti Paper/Drafts', { dir_mtime: null, last_listed_at: null }),
    dir('Users/ali1/world-ti paper/drafts/v2'), dir('Users/ali1/World-Ti Paper/Drafts2'), dir('Users/ali1/World-Ti Paper/Final'),
    dir('Users/bob2/World-Ti Paper/Drafts', { owner_person_id: P.bob }),
  );
  const dismissed = add(w, under('Users/ali1/World-Ti Paper/Drafts/a.tif', { state: 'dismissed', decided_by: U.alice }));
  const { call } = setup(w);
  const res = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: r.ignored_id.toUpperCase() } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { data: { ignored_id: r.ignored_id, folder: 'World-Ti Paper/Drafts', still_ignored: false, rescan_queued: true } });
  assert.deepEqual(w.ignored.map((x) => x.rel_folder), ['World-Ti Paper/Final']);
  assert.ok(w.ignored.includes(keep));
  assert.equal(w.dirs.length, 7, 'no cache row is deleted: the crawler reaches a folder through its cached parent');
  const state = (path) => { const d = w.dirs.find((x) => x.rel_path === path); return [d.dir_mtime, d.last_listed_at]; };
  assert.deepEqual(state('Users/ali1/World-Ti Paper/Drafts'), [null, null]);
  assert.deepEqual(state('Users/ali1/world-ti paper/drafts/v2'), [null, null], 'everything below it, whatever the letter case');
  const untouched = ['2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z'];
  for (const path of ['Users/ali1', 'Users/ali1/World-Ti Paper', 'Users/ali1/World-Ti Paper/Drafts2', 'Users/ali1/World-Ti Paper/Final', 'Users/bob2/World-Ti Paper/Drafts']) {
    assert.deepEqual(state(path), untouched, `${path}: the parent, a sibling that shares a prefix, other folders and another owner's rows are left alone`);
  }
  assert.equal(w.dirs.find((d) => d.rel_path === 'Users/ali1').baselined_at, '2026-10-01T00:00:00.000Z');
  assert.equal(dismissed.state, 'dismissed', 'files the rule dismissed stay dismissed until restored by hand');
  assert.equal(w.scanRequests.length, 1);
  assert.deepEqual([w.scanRequests[0].scope, w.scanRequests[0].person_id, w.scanRequests[0].requested_by], ['person', P.alice, U.alice]);
  const names = w.log.filter((l) => l.tx === 1).map((l) => l.name);
  assert.deepEqual(names, ['setActor', 'ignoredById', 'lock', 'ignoredDelete', 'ignoredOfOwner', 'ignoredResetDirs'], 'the rule and the cache go in one transaction, the actor first, under the owner\'s rule lock');
  assert.deepEqual(w.log.find((l) => l.name === 'ignoredResetDirs').bindings, [P.alice, null, 'Users/ali1/World-Ti Paper/Drafts', 'Users/ali1/World-Ti Paper/Drafts/']);
});

test('DELETE /ignored-folders/:id: a folder directly under the root: its own row is reset, the root row and its baseline are not touched', async () => {
  const w = newWorld();
  const r = rule(w, { rel_folder: 'sem' });
  w.dirs.push(
    { rel_path: 'Users/ali1', owner_person_id: P.alice, owner_team_id: null, dir_mtime: 'x', last_listed_at: 'y', baselined_at: 'b' },
    { rel_path: 'Users/ali1/sem', owner_person_id: P.alice, owner_team_id: null, dir_mtime: 'x', last_listed_at: 'y', baselined_at: null },
  );
  const { call } = setup(w);
  assert.equal((await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: r.ignored_id } })).statusCode, 200);
  assert.deepEqual(w.dirs, [
    { rel_path: 'Users/ali1', owner_person_id: P.alice, owner_team_id: null, dir_mtime: 'x', last_listed_at: 'y', baselined_at: 'b' },
    { rel_path: 'Users/ali1/sem', owner_person_id: P.alice, owner_team_id: null, dir_mtime: null, last_listed_at: null, baselined_at: null },
  ]);
});

test('DELETE /ignored-folders/:id: the rescan limit never fails the delete: the rule is gone and rescan_queued is false', async () => {
  const w = newWorld();
  const r = rule(w);
  w.scanRequests.push({ request_id: ID(7100), scope: 'person', person_id: P.alice, requested_by: U.alice, requested_at: new Date(NOW.getTime() - 60_000).toISOString(), finished_at: null, status: 'done' });
  const { call, errors } = setup(w);
  const res = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: r.ignored_id } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, { ignored_id: r.ignored_id, folder: 'World-Ti Paper', still_ignored: false, rescan_queued: false });
  assert.equal(w.ignored.length, 0);
  assert.equal(w.scanRequests.length, 1, 'no second request was queued');
  assert.deepEqual(errors, []);
  // a rescan that is still queued blocks too (the partial unique index of the queue is the backstop)
  const second = rule(w, { rel_folder: 'other' });
  w.scanRequests[0] = { ...w.scanRequests[0], requested_at: new Date(NOW.getTime() - 3_600_000).toISOString(), status: 'queued' };
  assert.deepEqual((await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: second.ignored_id } })).body.data.rescan_queued, false);
  // and an unexpected failure of the queue after the delete is not the delete's failure either
  const third = rule(w, { rel_folder: 'third' });
  w.scanRequests.length = 0;
  w.failRescan = true;
  const res3 = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: third.ignored_id } });
  assert.equal(res3.statusCode, 200);
  assert.equal(res3.body.data.rescan_queued, false);
  assert.equal(w.ignored.some((x) => x.ignored_id === third.ignored_id), false);
  assert.deepEqual(errors, [], 'a warning, not an error: the delete worked');
});

test('DELETE /ignored-folders/:id: a team member removes the team\'s rule (the cache under the TEAM folder is reset, the member\'s own rescan is queued); a non-member and an administrator are 404', async () => {
  const w = newWorld();
  const r = rule(w, { owner_person_id: null, owner_team_id: TEAM, rel_folder: 'runs/old', created_by: U.bob });
  w.dirs.push(
    { rel_path: 'Shared/SEM/runs', owner_person_id: null, owner_team_id: TEAM, dir_mtime: 'x', last_listed_at: 'y', baselined_at: null },
    { rel_path: 'Shared/SEM/runs/old/deeper', owner_person_id: null, owner_team_id: TEAM, dir_mtime: 'x', last_listed_at: 'y', baselined_at: null },
  );
  const { call } = setup(w);
  for (const who of [{ user: U.carol }, { user: U.admin, admin: true }, { user: U.former }, { user: U.dave }]) {
    const res = await call('DELETE /ignored-folders/:id', { ...who, params: { id: r.ignored_id } });
    assert.equal(res.statusCode, 404, JSON.stringify(who));
    assert.equal(codeOf(res), 'NOT_FOUND');
  }
  assert.equal(w.ignored.length, 1, 'still there');
  assert.equal(w.dirs.length, 2);
  const res = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: r.ignored_id } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.folder, 'runs/old');
  assert.equal(w.ignored.length, 0);
  assert.deepEqual(w.dirs.map((d) => [d.rel_path, d.last_listed_at]), [['Shared/SEM/runs', 'y'], ['Shared/SEM/runs/old/deeper', null]], 'the team folder\'s rows below the rule are reset, the parent is not');
  assert.deepEqual([w.scanRequests[0].scope, w.scanRequests[0].person_id], ['person', P.alice]);
});

test('DELETE /ignored-folders/:id: another person\'s rule, an unknown id and a malformed id: 404 / 404 / 400; the rule is untouched', async () => {
  const w = newWorld();
  const bobs = rule(w, { owner_person_id: P.bob, rel_folder: 'bob stuff' });
  const { call } = setup(w);
  const theirs = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: bobs.ignored_id } });
  assert.equal(theirs.statusCode, 404);
  assert.equal(codeOf(theirs), 'NOT_FOUND');
  assert.equal(errorOf(theirs).message, (await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: ID(99999) } })).body.errors[0].message, 'not yours reads exactly like not there');
  assert.equal(w.ignored.length, 1);
  assert.equal((await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: 'nope' } })).statusCode, 400);
  assert.equal((await call('DELETE /ignored-folders/:id', { user: U.alice, params: {} })).statusCode, 400);
  assert.equal(w.scanRequests.length, 0, 'a refused delete queues nothing');
});

test('DELETE /ignored-folders/:id: a rule whose owner folder was unset since is removed without clearing a cache that has no root', async () => {
  const w = newWorld();
  const r = rule(w, { owner_person_id: P.dave, rel_folder: 'x' });
  const { call } = setup(w);
  const res = await call('DELETE /ignored-folders/:id', { user: U.dave, params: { id: r.ignored_id } });
  assert.equal(res.statusCode, 200);
  assert.equal(w.ignored.length, 0);
  assert.equal(w.log.some((l) => l.name === 'ignoredResetDirs'), false);
  assert.equal(res.body.data.rescan_queued, false, 'a person with no folder has nothing to rescan (POST /rescan says NO_FOLDER)');
  assert.equal(w.scanRequests.length, 0);
});

// ---- rows the crawler registered under a folder that is ignored now (review M1) ----------------------------------------------------

// The one clause every undecided read shares (the list and its count, the summary, accept-all's selection and its candidate reads): an undecided row under a rule
// of ITS OWNER is left out. The SQL itself runs on a real Postgres in tests/phase1_schema.sh (the d1-inbox block); here the text is pinned.
const IGNORED_CLAUSE = /NOT EXISTS \(SELECT 1 FROM d1_private\.inbox_ignored_dirs ig WHERE ig\.owner_person_id = c\.owner_person_id AND lower\(split_part\(c\.rel_path, '\/', 3\)\) = lower\(split_part\(ig\.rel_folder, '\/', 1\)\) AND left\(lower\(c\.rel_path\), length\(lower\(split_part\(c\.rel_path, '\/', 1\) \|\| '\/' \|\| split_part\(c\.rel_path, '\/', 2\) \|\| '\/' \|\| ig\.rel_folder\)\) \+ 1\) = lower\(split_part\(c\.rel_path, '\/', 1\) \|\| '\/' \|\| split_part\(c\.rel_path, '\/', 2\) \|\| '\/' \|\| ig\.rel_folder\) \|\| '\/'\) AND NOT EXISTS \(SELECT 1 FROM d1_private\.inbox_ignored_dirs ig WHERE ig\.owner_team_id = c\.owner_team_id AND lower\(split_part\(c\.rel_path, '\/', 3\)\) = lower\(split_part\(ig\.rel_folder, '\/', 1\)\) AND left\(/;

test('the SQL: the summary, the new / older / open lists and their counts, and accept-all leave out undecided rows under an ignored folder of their owner; Linked and Dismissed keep them', () => {
  const scope = { personId: P.alice, teamIds: [TEAM], admin: false };
  assert.match(SQL.summary, IGNORED_CLAUSE);
  assert.match(SQL.summaryWithScans, IGNORED_CLAUSE);
  for (const tab of ['new', 'older', 'open']) {
    const f = parseFileFilters({ tab });
    assert.match(buildListQuery(scope, f).sql, IGNORED_CLAUSE, `${tab} list`);
    assert.match(buildListQuery(scope, f, { count: true }).sql, IGNORED_CLAUSE, `${tab} count`);
    assert.match(buildListQuery(scope, f, { scans: true }).sql, IGNORED_CLAUSE, `${tab} list with scans`);
  }
  for (const tab of ['linked', 'dismissed']) {
    assert.doesNotMatch(buildListQuery(scope, parseFileFilters({ tab })).sql, /inbox_ignored_dirs/, `${tab}: a linked or dismissed file under a rule is still listed`);
    assert.doesNotMatch(buildListQuery(scope, parseFileFilters({ tab }), { count: true }).sql, /inbox_ignored_dirs/, `${tab} count`);
  }
  // accept-all's pages, whatever tab the filter names, and each of its candidate reads
  for (const tab of ['new', 'open', 'older', 'linked']) {
    const sql = buildListQuery(scope, parseFileFilters({ tab }), { accept: true }).sql;
    assert.match(sql, IGNORED_CLAUSE, `accept-all page (${tab})`);
    assert.equal(sql.split('inbox_ignored_dirs').length - 1, 2, `${tab}: the clause is there once, not twice`);
  }
  for (const name of ['acceptCandidatesById', 'acceptCandidatesForUpdate']) {
    assert.match(SQL[name], IGNORED_CLAUSE, name);
    assert.match(SQL[name], /c\.state <> 'new' OR/, `${name}: a decided row is still returned, so its answer stays NOT_NEW`);
  }
  assert.match(SQL.acceptCandidatesForUpdate, /FOR UPDATE$/);
  assert.doesNotMatch(SQL.acceptCandidatesById, /FOR UPDATE/);
  // what /link, /dismiss, /restore and /undo read is not filtered: a person may still dismiss, restore or undo whatever they can reach
  for (const name of ['candidatesById', 'candidatesForUpdate', 'batchForUpdate']) assert.doesNotMatch(SQL[name], /inbox_ignored_dirs/, name);
});

test('the SQL: the ignored-folder clause is two NOT EXISTS (person owner, team owner) so each uses its partial index, compares with left() and lower() and never LIKE, and takes the root from the path', () => {
  for (const sql of [SQL.summary, buildListQuery({ personId: P.alice, teamIds: [], admin: false }, parseFileFilters({})).sql]) {
    const clause = sql.slice(sql.indexOf('NOT EXISTS (SELECT 1 FROM d1_private.inbox_ignored_dirs'));
    assert.equal(clause.split('NOT EXISTS (SELECT 1 FROM d1_private.inbox_ignored_dirs').length - 1, 2);
    assert.match(clause, /ig\.owner_person_id = c\.owner_person_id/);
    assert.match(clause, /ig\.owner_team_id = c\.owner_team_id/);
    assert.doesNotMatch(clause, /OR ig\.owner|ig\.owner_person_id = c\.owner_person_id OR/, 'never one subquery with an OR across the two owner columns (no partial index would serve it)');
    assert.doesNotMatch(clause, /\bLIKE\b|\bILIKE\b|~/, 'no pattern matching: a % or _ in a folder name is never special');
    assert.match(clause, /split_part\(c\.rel_path, '\/', 1\)/);
  }
});

test('POST /accept-all with candidate_ids: an undecided file under an ignored folder of its owner is not found (never linked); a rule of ANOTHER owner, or a decided file, changes nothing', async () => {
  const w = newWorld();
  const late = add(w, candFor('physical_samples', S1, { rel_path: 'Users/ali1/World-Ti Paper/late.tif' }));
  const fine = add(w, candFor('physical_samples', S1, { rel_path: 'Users/ali1/World-Ti Paper 2/ok.tif' }));
  const bobsRule = add(w, candFor('physical_samples', S1, { rel_path: 'Users/ali1/bobs/x.tif' }));
  const linked = add(w, candFor('physical_samples', S1, { rel_path: 'Users/ali1/World-Ti Paper/linked.tif', state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_junction_id: ID(5001), link_batch_id: ID(901) }));
  w.ignored.push({ ignored_id: ID(9300), owner_person_id: P.alice, owner_team_id: null, rel_folder: 'world-ti paper', created_at: NOW.toISOString(), created_by: U.alice });
  w.ignored.push({ ignored_id: ID(9301), owner_person_id: P.bob, owner_team_id: null, rel_folder: 'bobs', created_at: NOW.toISOString(), created_by: U.bob });
  const { call } = setup(w);
  const ids = [late, fine, bobsRule, linked].map((c) => c.candidate_id);
  const dry = await call('POST /accept-all', { user: U.alice, body: { dry_run: true, candidate_ids: ids } });
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.data.ids.sort(), [fine, bobsRule].map((c) => c.candidate_id).sort(), 'only files outside Alice\'s own rules qualify (Bob\'s rule is Bob\'s)');
  assert.deepEqual(dry.body.data.skipped.sort((x, y) => x.reason.localeCompare(y.reason)).map((x) => [x.candidate_id, x.reason]),
    [[linked.candidate_id, 'NOT_NEW'], [late.candidate_id, 'NOT_FOUND']].sort((x, y) => x[1].localeCompare(y[1])));
  const real = await call('POST /accept-all', { user: U.alice, body: { candidate_ids: ids } });
  assert.equal(real.statusCode, 200, JSON.stringify(real.body));
  assert.equal(late.state, 'new', 'the late file is not linked');
  assert.equal(fine.state, 'linked');
  assert.ok(w.log.some((l) => l.name === 'acceptCandidatesForUpdate'));
  assert.equal(w.log.some((l) => l.name === 'candidatesForUpdate'), false, 'accept-all never reads through the unfiltered statement');
});

test('DELETE /ignored-folders/:id: a rule under another rule of the same owner (A/B while A is ignored): still_ignored true, no cache reset, no rescan; the rule is gone', async () => {
  const w = newWorld();
  const above = rule(w, { rel_folder: 'World-Ti Paper' });
  const below = rule(w, { rel_folder: 'world-ti paper/Drafts/v2' });
  const dir = (rel_path) => ({ rel_path, owner_person_id: P.alice, owner_team_id: null, dir_mtime: '2026-10-10T00:00:00.000Z', last_listed_at: '2026-10-15T00:00:00.000Z', baselined_at: null });
  w.dirs.push(dir('Users/ali1/World-Ti Paper'), dir('Users/ali1/World-Ti Paper/Drafts/v2'));
  const { call } = setup(w);
  const res = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: below.ignored_id } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { data: { ignored_id: below.ignored_id, folder: 'world-ti paper/Drafts/v2', still_ignored: true, rescan_queued: false } });
  assert.deepEqual(w.ignored, [above], 'only the removed rule is gone');
  assert.equal(w.log.some((l) => l.name === 'ignoredResetDirs'), false, 'the cache of a folder that stays ignored is not reset');
  assert.deepEqual(w.dirs.map((d) => [d.dir_mtime, d.last_listed_at]), [['2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z'], ['2026-10-10T00:00:00.000Z', '2026-10-15T00:00:00.000Z']]);
  assert.equal(w.scanRequests.length, 0, 'and no rescan is queued');
  assert.equal(w.log.some((l) => l.name === 'rescanInsert' || l.name === 'rescanBlocking'), false, 'nothing is even asked of the rescan queue');
  // removing the rule above afterwards: nothing covers the folder any more
  const last = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: above.ignored_id } });
  assert.deepEqual(last.body.data, { ignored_id: above.ignored_id, folder: 'World-Ti Paper', still_ignored: false, rescan_queued: true });
  assert.deepEqual(w.dirs.map((d) => d.last_listed_at), [null, null], 'the folder and everything below it is listed again by the next scan');
});

test('DELETE /ignored-folders/:id: a rule beside, above or in another owner\'s tree does not count as covering; whole path parts only; a team rule is judged against the team\'s rules', async () => {
  const w = newWorld();
  rule(w, { rel_folder: 'World-Ti Paper 2' });
  rule(w, { rel_folder: 'World-Ti Paper/Drafts/deeper' });
  rule(w, { owner_person_id: P.bob, rel_folder: 'World-Ti Paper' });
  rule(w, { owner_person_id: null, owner_team_id: TEAM, rel_folder: 'World-Ti Paper' });
  const target = rule(w, { rel_folder: 'World-Ti Paper/Drafts' });
  const { call } = setup(w);
  const res = await call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: target.ignored_id } });
  assert.deepEqual(res.body.data, { ignored_id: target.ignored_id, folder: 'World-Ti Paper/Drafts', still_ignored: false, rescan_queued: true },
    'a sibling that shares a prefix, a rule BELOW it, and the same folder in another owner\'s rules do not cover it');
  // the team's own rule under the team's other rule
  const teamBelow = rule(w, { owner_person_id: null, owner_team_id: TEAM, rel_folder: 'world-ti paper/x' });
  w.scanRequests.length = 0;
  const team = await call('DELETE /ignored-folders/:id', { user: U.bob, params: { id: teamBelow.ignored_id } });
  assert.deepEqual([team.body.data.still_ignored, team.body.data.rescan_queued], [true, false]);
});

test('DELETE /ignored-folders/:id: two removals of A and of A/B at once cannot both decide "still ignored": they take the owner\'s rule lock, so the second sees the first\'s delete', async () => {
  const w = newWorld();
  const a = rule(w, { rel_folder: 'A' });
  const b = rule(w, { rel_folder: 'A/B' });
  w.dirs.push({ rel_path: 'Users/ali1/A/B', owner_person_id: P.alice, owner_team_id: null, dir_mtime: 'x', last_listed_at: 'y', baselined_at: null });
  const { call } = setup(w);
  const [one, two] = await Promise.all([
    call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: a.ignored_id } }),
    call('DELETE /ignored-folders/:id', { user: U.alice, params: { id: b.ignored_id } }),
  ]);
  assert.deepEqual([one.statusCode, two.statusCode], [200, 200]);
  assert.equal(w.ignored.length, 0);
  assert.deepEqual([one.body.data.still_ignored, two.body.data.still_ignored].filter(Boolean).length <= 1, true, 'at most one of the two saw the other\'s rule');
  assert.equal(two.body.data.still_ignored, false, 'the second removal sees no rule left above the folder');
  assert.equal(w.dirs[0].last_listed_at, null, 'so the folder\'s cache was reset by one of them');
  const locks = w.log.filter((x) => x.name === 'lock' && String(x.bindings[0]).startsWith('inbox-ignore:'));
  assert.deepEqual(locks.map((l) => l.bindings), [[`inbox-ignore:${P.alice}`], [`inbox-ignore:${P.alice}`]], 'each removal locks the owner\'s rules before it deletes and reads (the fake serialises whole transactions; the real guarantee is this lock)');
  for (const l of locks) assert.ok(w.log.findIndex((x) => x === l) < w.log.findIndex((x) => x.tx === l.tx && x.name === 'ignoredDelete'), 'the lock comes first');
});

// ---- wiring ------------------------------------------------------------------------------------------------------------------

test('the default export is the endpoint: id d1-inbox, a handler that registers every route', () => {
  assert.equal(endpoint.id, 'd1-inbox');
  const router = fakeRouter();
  endpoint.handler(router, { database: () => {}, services: {}, getSchema: async () => ({}), logger: {}, env: {} });
  assert.deepEqual([...router.routes.keys()].sort(), [
    'DELETE /ignored-folders/:id', 'GET /admin', 'GET /files', 'GET /files/:candidate_id/preview', 'GET /files/:candidate_id/thumb', 'GET /ignored-folders', 'GET /prefs', 'GET /progress',
    'GET /sem-settings', 'GET /siblings', 'GET /summary', 'PATCH /sem-settings/:file', 'POST /accept-all', 'POST /admin/scan-all', 'POST /auto-link', 'POST /dismiss', 'POST /ignored-folders',
    'POST /link', 'POST /relink', 'POST /rescan', 'POST /restore', 'POST /undo', 'PUT /prefs',
  ]);
});

test('no route reads or writes anything outside d1_private, the three junction and record tables, and (stream F1) surface_scans', () => {
  const allowed = /d1_private\.|information_schema\.tables|\b(people|teams|team_members|directus_files|directus_users|directus_roles|directus_access|directus_policies|sample_data_files|operation_data_files|session_data_files|physical_samples|manufacturing_operations|test_sessions|surface_scans)\b/;
  const statements = Object.values(SQL).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)));
  for (const text of statements) {
    if (/\bFROM\b|\bINTO\b|\bUPDATE\b/i.test(text)) assert.match(text, allowed, text);
    assert.doesNotMatch(text, /directus_collections|directus_fields|directus_permissions/);
  }
});

test('sql_check.mjs (run on a real Postgres by tests/schema/160-inbox.sh) prepares every statement the endpoint has, and the phase1 block names the checks', () => {
  const printed = execFileSync(process.execPath, [fileURLToPath(new URL('./sql_check.mjs', import.meta.url))], { encoding: 'utf8' });
  const names = new Set([...printed.matchAll(/^PREPARE (\w+) AS /gm)].map((m) => m[1]));
  for (const [key, value] of Object.entries(SQL)) {
    const wanted = typeof value === 'string' ? [key.toLowerCase()] : Object.keys(value).map((sub) => `${key}_${sub}`.toLowerCase());
    for (const name of wanted) assert.ok(names.has(name), `${name} is prepared`);
  }
  for (const name of ['list_new', 'count_new', 'count_older', 'list_linked', 'accept_open', 'accept_after']) assert.ok(names.has(name), name);
  assert.doesNotMatch(printed, /\?/, 'every ? is numbered');
  const phase1 = readFileSync(new URL('../../../tests/schema/160-inbox.sh', import.meta.url), 'utf8');
  assert.match(phase1, /core\/extensions\/d1-inbox\/sql_check\.mjs/);
  for (const name of ['summary', 'count_new', 'accept_open', 'marklinked', 'resetbatch', 'rescaninsert', 'progressdirs', 'progressfiles']) assert.match(phase1, new RegExp(`EXECUTE ${name}\\(|format\\('EXECUTE ${name}\\(`), `phase1 runs ${name}`);
});

// ---- C1: a folder that changed hands; the new holder neither sees nor links the old owner's files -------------------------------------------

const stampTo = (w, c, owner) => { w.files.set(c.directus_files_id, { id: c.directus_files_id, ...owner }); return c; };

test('C1: a candidate whose file is stamped to someone else is refused by link, accept-all (by id), dismiss and restore, and left alone', async () => {
  const w = newWorld();
  // Alice's candidate row (the folder is hers now), but the file is stamped to Carol (the former holder of the alias)
  const foreign = stampTo(w, add(w, cand()), OWNED_BY.other);
  const own = stampTo(w, add(w, cand()), OWNED_BY.alice);
  const { call } = setup(w);
  const linked = await call('POST /link', { user: U.alice, body: { items: [link(foreign)] } });
  assert.equal(linked.statusCode, 404);
  assert.equal(codeOf(linked), 'NOT_FOUND');
  assert.equal(foreign.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  const accept = await call('POST /accept-all', { user: U.alice, body: { candidate_ids: [foreign.candidate_id, own.candidate_id] } });
  assert.equal(accept.statusCode, 200, JSON.stringify(accept.body));
  assert.deepEqual(accept.body.data.skipped.map((s) => [s.candidate_id, s.reason]), [[foreign.candidate_id, 'NOT_FOUND']]);
  assert.equal(foreign.state, 'new');
  assert.equal(own.state, 'linked');
  const dismissed = await call('POST /dismiss', { user: U.alice, body: { candidate_ids: [foreign.candidate_id] } });
  assert.equal(dismissed.statusCode, 404);
  assert.equal(foreign.state, 'new');
  foreign.state = 'dismissed';
  const restored = await call('POST /restore', { user: U.alice, body: { candidate_ids: [foreign.candidate_id] } });
  assert.equal(restored.statusCode, 404);
  assert.equal(foreign.state, 'dismissed');
});

test('C1: undo leaves a batch row whose file was re-stamped to someone else (404 when nothing else is left in the batch)', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a)] } })).body.data.link_batch_id;
  stampTo(w, a, OWNED_BY.other);
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 404);
  assert.equal(a.state, 'linked');
  assert.equal(w.junctions.sample_data_files.length, 1);
});

test('C1 with ignored folders and pictures: a re-stamped file has no picture, is not dismissed by a new ignore rule, and accept-all by id still drops an ignored row', async () => {
  const w = newWorld();
  const foreign = stampTo(w, withPicture(w, add(w, under('Users/ali1/World-Ti Paper/foreign.tif'))), OWNED_BY.other);
  const own = stampTo(w, withPicture(w, add(w, under('Users/ali1/World-Ti Paper/own.tif'))), OWNED_BY.alice);
  const { call } = setup(w);
  // the picture routes: the same 404 for the re-stamped file (as the list leaves it out), the owner's own file still served
  for (const kind of ['thumb', 'preview']) {
    const res = await picture(call, kind, foreign.candidate_id, U.alice);
    assert.equal(res.statusCode, 404, kind);
    assert.equal(res.raw, undefined, 'no byte of a file stamped to someone else');
    assert.equal((await picture(call, kind, own.candidate_id, U.alice)).statusCode, 200, kind);
  }
  // a new ignore rule dismisses the owner's own open rows below it, never the re-stamped one (POST /dismiss would refuse it too)
  const added = await call('POST /ignored-folders', { user: U.alice, body: { folder: 'World-Ti Paper' } });
  assert.equal(added.statusCode, 201, JSON.stringify(added.body));
  assert.equal(added.body.data.dismissed, 1);
  assert.equal(own.state, 'dismissed');
  assert.equal(foreign.state, 'new', 'the re-stamped row is not the holder\'s to dismiss');
  // accept-all by id: an own row under the rule (restored by hand here) reads as not found, as main's ignore filter says; the re-stamped one too
  own.state = 'new';
  const accept = await call('POST /accept-all', { user: U.alice, body: { candidate_ids: [foreign.candidate_id, own.candidate_id] } });
  assert.equal(accept.statusCode, 200, JSON.stringify(accept.body));
  assert.deepEqual(accept.body.data.skipped.map((s) => s.reason).sort(), ['NOT_FOUND', 'NOT_FOUND']);
  assert.equal(own.state, 'new');
  assert.equal(foreign.state, 'new');
});

test('C1: every query that loads or counts candidates holds the file-owner predicate (the SQL the fake cannot run)', () => {
  const predicate = /NOT EXISTS \(SELECT 1 FROM directus_files pf WHERE pf\.id = c\.directus_files_id AND \(pf\.owner_person_id IS NOT NULL OR pf\.owner_team_id IS NOT NULL\) AND \(pf\.owner_person_id IS DISTINCT FROM c\.owner_person_id OR pf\.owner_team_id IS DISTINCT FROM c\.owner_team_id\)\)/;
  for (const name of ['candidatesForUpdate', 'candidatesById', 'batchForUpdate', 'summary', 'summaryWithScans']) assert.match(SQL[name], predicate, name);
  // the reads the ignored-folders and thumbnails work added: accept-all's own two reads, the open rows a new ignore rule dismisses, the picture routes' owner check
  for (const name of ['acceptCandidatesById', 'acceptCandidatesForUpdate', 'openUnderFolder']) assert.match(SQL[name], predicate, name);
  for (const kind of Object.keys(SQL.thumbMeta)) assert.match(SQL.thumbMeta[kind], predicate, `thumbMeta.${kind}`);
  // and the predicate never replaces the ignore filter: the summary and accept-all's reads hold both
  for (const name of ['summary', 'summaryWithScans', 'acceptCandidatesById', 'acceptCandidatesForUpdate']) assert.match(SQL[name], /d1_private\.inbox_ignored_dirs/, `${name} keeps the ignore rule`);
  // every statement that reads d1_private.file_candidates c for a caller holds it (the admin totals and the folder-cache UPDATE are not a caller's candidate read)
  const exempt = new Set(['adminTotals', 'relistDirs']);
  for (const [name, value] of Object.entries(SQL)) {
    for (const [key, text] of typeof value === 'string' ? [[name, value]] : Object.entries(value).map(([sub, t]) => [`${name}.${sub}`, t])) {
      if (exempt.has(name) || !/FROM d1_private\.file_candidates c\b/.test(text) || /^UPDATE/.test(text)) continue;
      assert.match(text, predicate, `${key} reads candidates`);
    }
  }
  const scope = { personId: P.alice, teamIds: [TEAM], admin: false };
  for (const tab of ['new', 'older', 'open', 'linked', 'dismissed']) {
    const f = parseFileFilters({ tab });
    assert.match(buildListQuery(scope, f).sql, predicate, `list ${tab}`);
    assert.match(buildListQuery(scope, f, { count: true }).sql, predicate, `count ${tab}`);
  }
  assert.match(buildListQuery(scope, parseFileFilters({}, { defaultTab: 'open' }), { accept: true }).sql, predicate, 'accept-all');
  assert.match(SQL.candidatesForUpdate, /FOR UPDATE/);
});

// ---- I4: an undo before migration 197 is applied --------------------------------------------------------------------------------------

test('POST /undo before migration 197 (no sem_image_settings table) undoes the link and does not touch the settings table', async () => {
  const w = newWorld();
  w.semTable = false;
  const a = add(w, cand({ kind: 'image' }));
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a)] } })).body.data.link_batch_id;
  const res = await call('POST /undo', { user: U.alice, body: { link_batch_id: batch } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(a.state, 'new');
  assert.equal(w.junctions.sample_data_files.length, 0);
  assert.equal(w.log.some((l) => l.name === 'deleteUnlinkedSemSettings'), false, 'the settings table is not there: nothing is deleted from it');
  assert.ok(w.log.some((l) => l.name === 'semTableExists'), 'it asked first');
});

test('POST /undo once 197 is applied asks no more and removes the settings as before (the positive answer is remembered)', async () => {
  const w = newWorld();
  const a = add(w, cand({ extracted: SEM_EXTRACTED }));
  const b = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const first = (await call('POST /link', { user: U.alice, body: { items: [link(a)] } })).body.data.link_batch_id;
  const second = (await call('POST /link', { user: U.alice, body: { items: [link(b)] } })).body.data.link_batch_id;
  await call('POST /undo', { user: U.alice, body: { link_batch_id: first } });
  await call('POST /undo', { user: U.alice, body: { link_batch_id: second } });
  assert.equal(w.settings.size, 0);
  assert.equal(w.log.filter((l) => l.name === 'semTableExists').length, 1);
  assert.equal(w.log.filter((l) => l.name === 'deleteUnlinkedSemSettings').length, 2);
});

test('POST /undo notices a 197 applied while the server runs (a negative answer is asked again)', async () => {
  const w = newWorld();
  w.semTable = false;
  const a = add(w, cand({ kind: 'image' }));
  const b = add(w, cand({ kind: 'image' }));
  const { call } = setup(w);
  const first = (await call('POST /link', { user: U.alice, body: { items: [link(a)] } })).body.data.link_batch_id;
  await call('POST /undo', { user: U.alice, body: { link_batch_id: first } });
  w.semTable = true;
  const second = (await call('POST /link', { user: U.alice, body: { items: [link(b)] } })).body.data.link_batch_id;
  await call('POST /undo', { user: U.alice, body: { link_batch_id: second } });
  assert.equal(w.log.filter((l) => l.name === 'deleteUnlinkedSemSettings').length, 1);
});

// ---- the linked-file view: a linked row's title and batch size, and the siblings of its record ---------------------------------------------

test('GET /files: a linked row carries its record\'s title (a sample\'s nickname, a test\'s type, none for an operation) and the size of its link batch', async () => {
  const w = newWorld();
  const c = cand({ state: 'linked' });
  w.listRows = [
    listRow(c, { state: 'linked', link_kind: 'bulk', linked_collection: 'physical_samples', linked_record_id: S1, link_batch_id: ID(77), link_batch_size: 3 }),
    listRow(c, { state: 'linked', link_kind: 'manual', linked_collection: 'manufacturing_operations', linked_record_id: O1, link_batch_id: ID(78), link_batch_size: 1 }),
    listRow(c, { state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S2, link_batch_id: ID(79), link_batch_size: 1 }),
    listRow(cand(), { state: 'new' }),
  ];
  const { call } = setup(w);
  const [sample, operation, hidden, fresh] = (await call('GET /files', { user: U.alice, query: { tab: 'linked' } })).body.data;
  assert.equal(sample.linked_title, `CODE-${S1.slice(-4)}`, 'the nickname, read as the caller');
  assert.equal(sample.link_batch_size, 3);
  assert.equal(operation.linked_title, null, 'an operation has no second line');
  assert.equal(operation.link_batch_size, 1);
  assert.equal(hidden.linked_title, null, 'a record the caller cannot read is not named, nor titled');
  assert.equal(fresh.linked_title, null);
  assert.equal(fresh.link_batch_size, null, 'only a linked row has a batch');
  const titleReads = w.items.filter((i) => i.op === 'read' && i.query.fields?.includes('nickname'));
  assert.equal(titleReads.length, 1, 'one extra read, for the samples the linked rows name');
  assert.deepEqual(titleReads[0].query.filter.sample_id._in, [S1], 'only readable linked records are asked for a title');
});

test('GET /files: a title the caller\'s permissions refuse costs only the title, not the record\'s code', async () => {
  const w = newWorld();
  const c = cand({ state: 'linked' });
  w.listRows = [listRow(c, { state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S1, link_batch_id: ID(77), link_batch_size: 1 })];
  const { call, context } = setup(w);
  const real = context.services.ItemsService;
  context.services.ItemsService = class extends real {
    async readByQuery(query) {
      if (query.fields?.includes('nickname')) throw Object.assign(new Error('forbidden'), { status: 403, code: 'FORBIDDEN' });
      return super.readByQuery(query);
    }
  };
  const [row] = (await call('GET /files', { user: U.alice, query: { tab: 'linked' } })).body.data;
  assert.equal(row.linked_label, `CODE-${S1.slice(-4)}`);
  assert.equal(row.linked_title, null);
});

test('buildListQuery: the record option lists the files linked to one record through its junction row, without the sj / oj / tj joins, and leaves one file out', () => {
  const scope = { personId: P.alice, teamIds: [TEAM], admin: false };
  const f = parseFileFilters({ tab: 'linked', kind: 'sem_image,image', limit: '7' });
  for (const [collection, t] of Object.entries(LINK_TARGETS)) {
    const record = { collection, id: S1, exclude: ID(1) };
    for (const opts of [{ record }, { record, count: true }]) {
      const q = buildListQuery(scope, f, opts);
      // driven from the record's side: the files in the record's junction rows (its unique index), then their candidates; the second test keeps a file only when the
      // junction row ITS link made is on that record, so the answer is what it was before
      assert.match(q.sql, new RegExp(`c\\.linked_collection = \\? AND c\\.directus_files_id IN \\(SELECT ri\\.directus_files_id FROM ${t.junction} ri WHERE ri\\.${t.fk} = \\?::uuid\\)`
        + ` AND EXISTS \\(SELECT 1 FROM ${t.junction} rj WHERE rj\\.id = c\\.linked_junction_id AND rj\\.${t.fk} = \\?::uuid\\) AND c\\.candidate_id <> \\?::uuid`));
      assert.equal(q.bindings.filter((b) => b === S1).length, 2, 'the record id is bound for the junction subquery and for the exactness test');
      assert.ok(q.bindings.includes(S1) && q.bindings.includes(ID(1)) && q.bindings.includes(collection), 'the record, the excluded file and the collection are bindings');
      assert.doesNotMatch(q.sql, new RegExp(`${S1}|${ID(1)}`), 'no id in the text');
      assert.match(q.sql, /c\.state = 'linked'/);
    }
  }
  assert.doesNotMatch(buildListQuery(scope, f).sql, /rj\./, 'no record option, no record clause');
  // the bindings stay in the order of the placeholders: the clause comes after link_kind and before the paging
  const q = buildListQuery(scope, parseFileFilters({ tab: 'linked', link_kind: 'auto', limit: '5' }), { record: { collection: 'physical_samples', id: S1, exclude: ID(1) } });
  assert.equal(q.sql.match(/\?/g).length, q.bindings.length);
  assert.deepEqual(q.bindings.slice(-7), ['auto', 'physical_samples', S1, S1, ID(1), 5, 0]);
});

// the file and the junction row its link made, on a world with Alice's sample S1
function linkedWorld() {
  const w = newWorld();
  const self = add(w, cand({ state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_junction_id: ID(5001), link_batch_id: ID(77) }));
  w.junctions.sample_data_files.push({ id: ID(5001), sample_id: S1, directus_files_id: self.directus_files_id });
  const other = (n) => listRow(cand({ state: 'linked' }), { state: 'linked', link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S1, link_batch_id: ID(80 + n), link_batch_size: 1, has_thumbnail: true });
  w.listRows = [other(1), other(2)];
  w.listTotal = 9;
  return { w, self };
}
const listSql = (w) => w.log.filter((l) => l.name === null && /^SELECT c\.candidate_id, c\.directus_files_id/.test(l.sql));

test('GET /siblings: the other pictures linked to the same record, with the list\'s rows, their total and the list\'s own scope', async () => {
  const { w, self } = linkedWorld();
  const { call } = setup(w);
  const res = await call('GET /siblings', { user: U.alice, query: { file: self.candidate_id, limit: '2' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.meta, { total: 9, limit: 2, offset: 0, acceptable: null });
  assert.equal(res.body.data.length, 2);
  assert.equal(res.body.data[0].linked_record_id, S1);
  assert.equal(res.body.data[0].linked_label, `CODE-${S1.slice(-4)}`);
  assert.equal(res.body.data[0].has_thumbnail, true);
  const [page] = listSql(w);
  assert.match(page.sql, /c\.state = 'linked'/);
  assert.match(page.sql, /c\.kind = ANY\(/);
  assert.match(page.sql, /rj\.sample_id = \?::uuid/);
  assert.ok(page.bindings.includes('sem_image,image') && page.bindings.includes(S1) && page.bindings.includes(self.candidate_id), 'the record comes from the file\'s own junction row');
  assert.ok(page.bindings.includes(P.alice), 'the caller\'s own folders, as in the list');
  assert.deepEqual(page.bindings.slice(-2), [2, 0]);
});

test('GET /siblings: nothing for a file that is not linked to a sample, operation or test, or whose link is gone, or a record the caller cannot read', async () => {
  const { w } = linkedWorld();
  const { call } = setup(w);
  const empty = async (id) => {
    const res = await call('GET /siblings', { user: U.alice, query: { file: id } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.meta.total, 0);
  };
  await empty(add(w, cand()).candidate_id);
  await empty(add(w, cand({ state: 'linked', kind: 'surface_scan', linked_collection: 'surface_scans', linked_junction_id: ID(6001), link_batch_id: ID(90) })).candidate_id);
  // the junction row was removed in Data Studio, or repointed at another file
  const orphan = add(w, cand({ state: 'linked', linked_collection: 'physical_samples', linked_junction_id: ID(5002), link_batch_id: ID(91) }));
  await empty(orphan.candidate_id);
  w.junctions.sample_data_files.push({ id: ID(5002), sample_id: S1, directus_files_id: ID(1) });
  await empty(orphan.candidate_id);
  // Alice cannot read the Restricted sample S2
  const hidden = add(w, cand({ state: 'linked', linked_collection: 'physical_samples', linked_junction_id: ID(5003), link_batch_id: ID(92) }));
  w.junctions.sample_data_files.push({ id: ID(5003), sample_id: S2, directus_files_id: hidden.directus_files_id });
  await empty(hidden.candidate_id);
  assert.equal(listSql(w).length, 0, 'none of these ran the list query');
});

test('GET /siblings: a file the caller cannot see, or an id that is not one, is 404; a bad limit is 400; no login is 401', async () => {
  const { w, self } = linkedWorld();
  const { call } = setup(w);
  for (const [file, user] of [[self.candidate_id, U.bob], [ID(999), U.alice], ['nope', U.alice], [undefined, U.alice]]) {
    const res = await call('GET /siblings', { user, query: { file } });
    assert.equal(res.statusCode, 404, String(file));
    assert.equal(codeOf(res), 'NOT_FOUND');
  }
  assert.equal((await call('GET /siblings', { user: U.alice, query: { file: self.candidate_id, limit: 'many' } })).statusCode, 400);
  assert.equal((await call('GET /siblings', { query: { file: self.candidate_id } })).statusCode, 401);
  assert.equal(listSql(w).length, 0);
});

test('GET /siblings: an administrator reading someone else\'s file sees that owner\'s siblings; a team file lists the team\'s', async () => {
  const { w, self } = linkedWorld();
  const { call } = setup(w);
  const asAdmin = await call('GET /siblings', { user: U.admin, admin: true, query: { file: self.candidate_id } });
  assert.equal(asAdmin.statusCode, 200);
  const [page] = listSql(w);
  assert.match(page.sql, /c\.owner_person_id = \?/);
  assert.ok(page.bindings.includes(P.alice), 'the file\'s owner, not the administrator');
  assert.deepEqual(page.bindings.slice(0, 3), [true, P.admin, ''], 'the batch size counts what the administrator can see');
  assert.ok(!page.bindings.slice(3).includes(P.admin), 'the rows are the file owner, not the administrator');
  // a team's file read by a team member: the member's default scope already holds the team
  const teamFile = add(w, cand({ owner_person_id: null, owner_team_id: TEAM, state: 'linked', linked_collection: 'physical_samples', linked_junction_id: ID(5004), link_batch_id: ID(93) }));
  w.junctions.sample_data_files.push({ id: ID(5004), sample_id: S1, directus_files_id: teamFile.directus_files_id });
  await call('GET /siblings', { user: U.alice, query: { file: teamFile.candidate_id } });
  const second = listSql(w).at(-1);
  assert.match(second.sql, /c\.owner_team_id = ANY/);
  assert.ok(second.bindings.includes(TEAM));
});

// ---- Change: POST /relink is one transaction; can_undo; the batch size the caller can see -----------------------------------------------------

const relinkBody = (c, collection = 'manufacturing_operations', record = O1) => ({ candidate_id: c.candidate_id, collection, record_id: record });

test('POST /relink: the file\'s own link is undone and the new one made in ONE transaction; its settings, a manual correction included, are never deleted', async () => {
  const w = newWorld();
  const c = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const first = (await call('POST /link', { user: U.alice, body: { items: [link(c)] } })).body.data;
  w.settings.get(c.directus_files_id).sources.kv = 'manual';
  w.settings.get(c.directus_files_id).kv = '99';
  const before = w.txCount;
  const logFrom = w.log.length;
  const res = await call('POST /relink', { user: U.alice, body: relinkBody(c) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(w.txCount - before, 1, 'undo and link share one transaction');
  assert.equal(res.body.data.linked, 1);
  assert.notEqual(res.body.data.link_batch_id, first.link_batch_id, 'a new batch of one');
  assert.deepEqual(res.body.data.items.map((i) => [i.candidate_id, i.collection, i.record_id]), [[c.candidate_id, 'manufacturing_operations', O1]]);
  assert.equal(w.junctions.sample_data_files.length, 0, 'the old junction row is gone');
  assert.deepEqual(w.junctions.operation_data_files.map((j) => [j.operation_id, j.directus_files_id]), [[O1, c.directus_files_id]]);
  assert.equal(c.state, 'linked');
  assert.equal(c.linked_collection, 'manufacturing_operations');
  assert.equal(c.link_batch_id, res.body.data.link_batch_id);
  assert.equal(c.decided_by, U.alice);
  assert.equal(c.link_kind, 'manual');
  const names = w.log.slice(logFrom).map((l) => l.name);
  assert.ok(!names.includes('deleteUnlinkedSemSettings'), 'the file stays linked, so its settings are not touched');
  assert.ok(!names.includes('relistDirs'), 'the file does not go back to the inbox');
  assert.equal(w.settings.get(c.directus_files_id).kv, '99', 'the manual correction survives');
  assert.equal(w.settings.get(c.directus_files_id).sources.kv, 'manual');
  assert.ok(writesTo(w, 'sample_data_files').some((i) => i.op === 'delete' && i.accountability.user === U.alice), 'the old row was deleted as the caller');
  assert.ok(writesTo(w, 'operation_data_files').every((i) => i.accountability.user === U.alice && i.knex?.isTransaction));
});

test('POST /relink: a new link that is refused changes NOTHING: the file stays on its old record, its settings stay', async () => {
  const w = newWorld();
  const c = add(w, cand({ extracted: SEM_EXTRACTED }));
  const { call } = setup(w);
  const first = (await call('POST /link', { user: U.alice, body: { items: [link(c)] } })).body.data;
  w.settings.get(c.directus_files_id).sources.kv = 'manual';
  w.settings.get(c.directus_files_id).kv = '99';
  const junction = copy(w.junctions.sample_data_files);
  const logFrom = w.log.length;
  // S3 is a sample Alice may not edit (Dave's)
  const refused = await call('POST /relink', { user: U.alice, body: relinkBody(c, 'physical_samples', S3) });
  assert.equal(refused.statusCode, 403);
  assert.equal(codeOf(refused), 'FORBIDDEN');
  assert.equal(c.state, 'linked');
  assert.equal(c.link_batch_id, first.link_batch_id, 'the old batch still stands');
  assert.equal(c.linked_collection, 'physical_samples');
  assert.deepEqual(w.junctions.sample_data_files, junction, 'the old junction row is back');
  assert.equal(w.junctions.operation_data_files.length, 0);
  assert.equal(w.settings.get(c.directus_files_id).kv, '99');
  assert.equal(w.settings.get(c.directus_files_id).sources.kv, 'manual');
  assert.ok(!w.log.slice(logFrom).some((l) => l.name === 'deleteUnlinkedSemSettings'), 'a relink never deletes the settings');
  // a Restricted record the caller cannot read, and one that does not exist, are refused the same way
  assert.equal((await call('POST /relink', { user: U.alice, body: relinkBody(c, 'physical_samples', S2) })).statusCode, 403);
  const gone = await call('POST /relink', { user: U.alice, body: relinkBody(c, 'physical_samples', MISSING) });
  assert.ok([403, 404].includes(gone.statusCode), String(gone.statusCode));
  assert.equal(c.link_batch_id, first.link_batch_id);
  assert.equal(w.junctions.sample_data_files.length, 1);
});

test('POST /relink: only that file of its batch moves; the others stay linked to the old record', async () => {
  const w = newWorld();
  const a = add(w, cand());
  const b = add(w, cand());
  const { call } = setup(w);
  const batch = (await call('POST /link', { user: U.alice, body: { items: [link(a), link(b)] } })).body.data.link_batch_id;
  const res = await call('POST /relink', { user: U.alice, body: relinkBody(a) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(a.linked_collection, 'manufacturing_operations');
  assert.equal(b.state, 'linked');
  assert.equal(b.link_batch_id, batch, 'the other file keeps its batch');
  assert.deepEqual(w.junctions.sample_data_files.map((j) => j.directus_files_id), [b.directus_files_id]);
});

test('POST /relink: the rules of undo and link: the linker only, an administrator who is not the owner is read-only, a file that is not linked to a record is 409, a bad body is 400', async () => {
  const w = newWorld();
  const team = add(w, cand({ owner_person_id: null, owner_team_id: TEAM }));
  const fresh = add(w, cand());
  const { call } = setup(w);
  await call('POST /link', { user: U.alice, body: { items: [link(team)] } });
  const batch = team.link_batch_id;
  const unchanged = () => assert.ok(team.state === 'linked' && team.link_batch_id === batch && w.junctions.sample_data_files.length === 1, 'nothing changed');
  const bob = await call('POST /relink', { user: U.bob, body: relinkBody(team, 'physical_samples', S1) });
  assert.equal(bob.statusCode, 403, 'a teammate sees the file, but the link is the linker\'s');
  unchanged();
  const admin = await call('POST /relink', { user: U.admin, admin: true, role: ID(80), body: relinkBody(team) });
  assert.equal(admin.statusCode, 403);
  assert.equal(codeOf(admin), 'FORBIDDEN');
  unchanged();
  assert.equal((await call('POST /relink', { user: U.carol, body: relinkBody(team) })).statusCode, 404, 'not Carol\'s to see');
  const notLinked = await call('POST /relink', { user: U.alice, body: relinkBody(fresh) });
  assert.equal(notLinked.statusCode, 409);
  assert.equal(codeOf(notLinked), 'NOT_LINKED');
  assert.equal(fresh.state, 'new');
  const scan = add(w, cand({ kind: 'surface_scan', state: 'linked', link_batch_id: ID(990), linked_collection: 'surface_scans', linked_junction_id: ID(6100), decided_by: U.alice }));
  assert.equal(codeOf(await call('POST /relink', { user: U.alice, body: relinkBody(scan) })), 'NOT_LINKED');
  assert.equal(codeOf(await call('POST /relink', { user: U.alice, body: relinkBody({ candidate_id: ID(9999) }) })), 'NOT_FOUND');
  const txs = w.txCount;
  for (const body of [undefined, {}, { ...relinkBody(team), record_id: 'x' }, { ...relinkBody(team), candidate_id: 'x' }, { ...relinkBody(team), collection: 'surface_scans' }, { ...relinkBody(team), collection: 'nope' }]) {
    assert.equal((await call('POST /relink', { user: U.alice, body })).statusCode, 400);
  }
  assert.equal(w.txCount, txs, 'no transaction for a bad body');
  assert.equal((await call('POST /relink', { body: relinkBody(team) })).statusCode, 401);
  // an administrator who is a member of the owner team may, as for undo
  w.teamMembers.push({ team_id: TEAM, person_id: P.admin });
  w.editable[U.admin] = { physical_samples: new Set(), manufacturing_operations: new Set([O1]), test_sessions: new Set() };
  assert.equal((await call('POST /relink', { user: U.admin, admin: true, role: ID(80), body: relinkBody(team) })).statusCode, 200);
});

test('FoundFile.can_undo: true only for a linked row the caller could undo (they linked it, or are an administrator who may change the file); false for every other row', async () => {
  const w = newWorld();
  const mine = listRow(cand({ state: 'linked' }), { state: 'linked', decided_by: U.alice, link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S1, link_batch_id: ID(77) });
  const teammates = listRow(cand({ state: 'linked' }), { state: 'linked', decided_by: U.bob, owner_person_id: null, owner_team_id: TEAM, link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S1, link_batch_id: ID(78) });
  const fresh = listRow(cand(), { state: 'new', decided_by: null });
  w.listRows = [mine, teammates, fresh];
  const { call } = setup(w);
  const asAlice = (await call('GET /files', { user: U.alice, query: { tab: 'linked' } })).body.data;
  assert.deepEqual(asAlice.map((r) => r.can_undo), [true, false, false], 'Alice may undo what she linked, not what Bob linked in the team folder, and a new file has nothing to undo');
  assert.ok(asAlice.every((r) => typeof r.can_undo === 'boolean'));
  const asBob = (await call('GET /files', { user: U.bob, query: { tab: 'linked' } })).body.data;
  assert.deepEqual(asBob.map((r) => r.can_undo), [false, true, false], 'Alice\'s own file is not Bob\'s to change; the team file he linked is his to undo');
  // an administrator reads Alice's file and may not change it, so may not undo it
  const asAdmin = (await call('GET /files', { user: U.admin, admin: true, query: { tab: 'linked', owner: `person:${P.alice}` } })).body.data;
  assert.equal(asAdmin[0].can_undo, false);
  // the same rule as the routes apply, for the same rows
  const scope = { personId: P.alice, teamIds: [TEAM], admin: false };
  for (const [row, want] of [[mine, true], [teammates, false], [fresh, false]]) assert.equal(canUndoRow(scope, row, U.alice), want);
  assert.equal(canUndoRow(scope, mine, undefined), false, 'no user id, no undo');
  assert.equal(fileOut(mine, { readable: new Set(), labels: new Map(), editable: new Set() }).can_undo, false, 'no viewer given: fails closed');
});

test('buildListQuery: link_batch_size counts only the batch files the caller can see (their folders and teams, everything for an administrator); the count query does not carry it', () => {
  const alice = { personId: P.alice, teamIds: [TEAM, OTHER_TEAM], admin: false };
  const admin = { personId: P.admin, teamIds: [], admin: true };
  const f = parseFileFilters({ tab: 'linked' });
  const q = buildListQuery(alice, f);
  assert.match(q.sql, /\(SELECT count\(\*\)::int FROM d1_private\.file_candidates bc WHERE bc\.link_batch_id = c\.link_batch_id AND bc\.state = 'linked' AND NOT EXISTS \(SELECT 1 FROM directus_files pf WHERE pf\.id = bc\.directus_files_id .* AND \(\?::boolean OR bc\.owner_person_id = \? OR bc\.owner_team_id = ANY\(string_to_array\(\?, ','\)::uuid\[\]\)\)\) END AS link_batch_size/);
  assert.deepEqual(q.bindings.slice(0, 3), [false, P.alice, `${TEAM},${OTHER_TEAM}`], 'the three bindings of the batch count come first');
  assert.equal(q.sql.match(/\?/g).length, q.bindings.length);
  assert.deepEqual(buildListQuery(admin, f).bindings.slice(0, 3), [true, P.admin, '']);
  assert.deepEqual(buildListQuery({ personId: null, teamIds: [], admin: false }, f).bindings.slice(0, 3), [false, null, ''], 'a login with no person counts nothing');
  assert.doesNotMatch(buildListQuery(alice, f, { count: true }).sql, /bc\./);
  assert.match(q.sql, /c\.decided_by,/, 'the row says who linked it (can_undo)');
});

// ---- scan progress (GET /progress) -----------------------------------------------------------------------------------------------

const pgDir = (rel, owner, listed = true) => ({ rel_path: rel, ...owner, dir_mtime: null, last_listed_at: listed ? '2026-10-15T11:00:00.000Z' : null });
const READ = 'sem-2';

function progressWorld() {
  const w = newWorld();
  // Alice: 3 folders known, 2 listed; 2 plain images (1 read), 2 SEM images (both read, 1 with a scale), a document and a gone file; 2 pictures (one a failure marker)
  w.dirs.push(pgDir('Users/ali1', OWNED_BY.alice), pgDir('Users/ali1/sem', OWNED_BY.alice), pgDir('Users/ali1/new', OWNED_BY.alice, false), pgDir('Users/car3', OWNED_BY.other));
  const a1 = add(w, cand({ classified_by: READ, extracted: { pixel_size_nm: 2.5 } }));
  const a2 = add(w, cand({ classified_by: READ, extracted: {} }));
  add(w, cand({ kind: 'image', classified_by: READ }));
  add(w, cand({ kind: 'image', classified_by: null }));
  add(w, cand({ kind: 'document' }), cand({ state: 'gone', classified_by: READ }));
  w.thumbs.set(a1.candidate_id, { thumb: Buffer.from('a'), preview: Buffer.from('b') });
  w.thumbs.set(a2.candidate_id, { thumb: null, preview: null });
  // the SEM team's folder: one folder, listed; one image, read, with a picture
  w.dirs.push(pgDir('Shared/SEM', OWNED_BY.team));
  const t1 = add(w, cand({ ...OWNED_BY.team, rel_path: 'Shared/SEM/t.tif', classified_by: READ, extracted: { pixel_size_nm: 1 } }));
  w.thumbs.set(t1.candidate_id, { thumb: Buffer.from('a'), preview: Buffer.from('b') });
  // Carol's: one unread image
  add(w, cand({ ...OWNED_BY.other, rel_path: 'Users/car3/c.tif' }));
  return w;
}
const ALICE_FOLDER = { folders_known: 3, folders_listed: 2, files: 5, images: 4, images_read: 3, images_with_thumb: 2, sem: 2, sem_with_scale: 1 };

test('GET /progress: a person reads their own folder and the folder of each team they are an active member of, with the counts the client turns into percentages', async () => {
  const w = progressWorld();
  const { call } = setup(w);
  const res = await call('GET /progress', { user: U.alice });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.folders, [
    { owner: { kind: 'person', id: P.alice, name: 'Alice A', folder: 'ali1', root: 'Users/ali1', has_login: true }, ...ALICE_FOLDER },
    { owner: { kind: 'team', id: TEAM, name: 'SEM team', folder: 'SEM', root: 'Shared/SEM', has_login: null },
      folders_known: 1, folders_listed: 1, files: 1, images: 1, images_read: 1, images_with_thumb: 1, sem: 1, sem_with_scale: 1 },
  ]);
  assert.equal(res.body.data.last_scan_finished_at, '2026-10-15T11:45:00.000Z');
  assert.deepEqual(w.log.filter((l) => l.name?.startsWith('progress')).map((l) => l.name), ['progressDirs', 'progressFiles', 'progressScan'], 'one statement per kind of answer');
  assert.equal(w.log.some((l) => /INSERT|UPDATE|DELETE/i.test(l.sql)), false, 'read only');
});

test('GET /progress: nobody else\'s folder; no alias and no team means no folder; a Former person has their own folder and no team', async () => {
  const w = progressWorld();
  const { call } = setup(w);
  const bob = await call('GET /progress', { user: U.bob });
  assert.deepEqual(bob.body.data.folders.map((f) => f.owner.name), ['SEM team', 'Bob B'], 'the team folder has files, his own has none');
  assert.deepEqual(bob.body.data.folders.find((f) => f.owner.kind === 'person'), {
    owner: { kind: 'person', id: P.bob, name: 'Bob B', folder: 'bob2', root: 'Users/bob2', has_login: true },
    folders_known: 0, folders_listed: 0, files: 0, images: 0, images_read: 0, images_with_thumb: 0, sem: 0, sem_with_scale: 0,
  });
  assert.deepEqual((await call('GET /progress', { user: U.dave })).body.data.folders, []);
  assert.deepEqual((await call('GET /progress', { user: U.carol })).body.data.folders.map((f) => f.owner.name), ['Carol C', 'Other team']);
  assert.deepEqual((await call('GET /progress', { user: U.former })).body.data.folders.map((f) => f.owner.name), ['Fay Former']);
  assert.deepEqual((await call('GET /progress', { user: U.nobody })).body.data.folders, [], 'a login with no person');
});

test('GET /progress: all=1 is for administrators (403 otherwise): every folder with an alias or a share folder, people without a login included, largest first', async () => {
  const w = progressWorld();
  w.people.push({ person_id: ID(19), full_name: 'Eve E', active: true, uni_alias: 'eve5', user_id: null });
  const { call } = setup(w);
  const denied = await call('GET /progress', { user: U.alice, query: { all: '1' } });
  assert.equal(denied.statusCode, 403);
  assert.equal(codeOf(denied), 'FORBIDDEN');
  assert.equal((await call('GET /progress', { user: U.alice, query: { all: '0' } })).statusCode, 200, 'all=0 is the caller\'s own');
  const res = await call('GET /progress', { user: U.admin, admin: true, query: { all: '1' } });
  assert.equal(res.statusCode, 200);
  const folders = res.body.data.folders;
  assert.deepEqual(folders.map((f) => f.owner.name), ['Alice A', 'Carol C', 'SEM team', 'Ada Admin', 'Bob B', 'Eve E', 'Fay Former', 'Other team', 'Vic Viewer'], 'files desc, then name');
  assert.equal(folders.find((f) => f.owner.name === 'Eve E').owner.has_login, false);
  assert.equal(folders.find((f) => f.owner.name === 'Other team').owner.has_login, null);
  assert.equal(folders.find((f) => f.owner.name === 'Alice A').files, ALICE_FOLDER.files);
  assert.deepEqual((await call('GET /progress', { user: U.admin, admin: true })).body.data.folders.map((f) => f.owner.name), ['Ada Admin'], 'without all=1 an administrator reads their own');
});

test('GET /progress: anything under the owner\'s ignored folders is left out, so 100% can be reached; the person folder follows INBOX_PERSON_DIR', async () => {
  const w = progressWorld();
  w.dirs.push(pgDir('Users/ali1/Skip', OWNED_BY.alice, false), pgDir('users/ali1/skip/deeper', OWNED_BY.alice, false));
  add(w, cand({ rel_path: 'Users/ali1/Skip/x.tif', classified_by: null }));
  w.ignored.push({ ignored_id: ID(7100), owner_person_id: P.alice, owner_team_id: null, rel_folder: 'Skip', created_at: '2026-10-14T10:00:00.000Z', created_by: U.alice });
  const before = process.env.INBOX_PERSON_DIR;
  process.env.INBOX_PERSON_DIR = 'User';
  try {
    const { call } = setup(w);
    const mine = (await call('GET /progress', { user: U.alice })).body.data.folders[0];
    assert.equal(mine.owner.root, 'User/ali1');
    assert.deepEqual({ ...mine, owner: undefined }, { owner: undefined, ...ALICE_FOLDER }, 'the ignored folders and the file under them do not count');
  } finally {
    if (before === undefined) delete process.env.INBOX_PERSON_DIR; else process.env.INBOX_PERSON_DIR = before;
  }
});

test('GET /progress: a file whose pointer row is stamped to another owner is not counted for the folder (a folder that changed hands)', async () => {
  const w = progressWorld();
  stampTo(w, add(w, cand({ rel_path: 'Users/ali1/old.tif' })), OWNED_BY.other);
  const { call } = setup(w);
  assert.equal((await call('GET /progress', { user: U.alice })).body.data.folders[0].files, ALICE_FOLDER.files);
});

test('GET /progress: a Lab Viewer may read it; every statement takes its owners as bindings (never text)', async () => {
  const w = progressWorld();
  const { call } = setup(w);
  assert.equal((await call('GET /progress', { user: U.viewer, role: LAB_VIEWER_ROLE_ID })).statusCode, 200);
  assert.equal(SQL.progressDirs.split('?').length - 1, 2);
  assert.equal(SQL.progressFiles.split('?').length - 1, 2);
  assert.match(SQL.progressDirs, /inbox_ignored_dirs/);
  assert.match(SQL.progressFiles, /inbox_ignored_dirs/);
});
