// Directus endpoint: d1-inbox  (mounted at /d1-inbox)
//
// The server half of the Inbox (spec docs/superpowers/specs/2026-10-15-found-files-inbox-design.md sections 4, 5 and 9, ADR-0020, migration
// 20261015000193). The inbox crawler (scripts/inbox_crawler/) finds new files in a person's folder (Users/<uni alias>) and in each team's
// folder (Shared/<share folder>) and writes one candidate row per file to d1_private.file_candidates. This endpoint is the only way people
// reach those rows: they are never a Directus collection, so Directus's REST cannot read them.
//
//   GET  /d1-inbox/summary          -> { data: { person: {person_id, new, older_matching} | null, teams: [{team_id, name, new, older_matching}],
//                                                total_new, total_older_matching } }     new = origin 'new' (not backlog), older_matching =
//                                                backlog files that name exactly one record by short ID or code; copies of a file that was
//                                                already linked or dismissed are not counted
//   GET  /d1-inbox/files?tab=new|older|linked|dismissed|open&kind=a,b&folder=&date_from=&date_to=&strength=any|short_id|code|edge_code|none
//        &owner_person_id=&owner_team_id=&link_kind=manual|bulk|auto&limit=&offset=    -> { data: Row[], meta: { total, limit, offset } }
//   POST /d1-inbox/link             { items: [{ candidate_id, collection, record_id }] }  (1 to 200, one transaction)
//                                   -> { data: { link_batch_id, count, linked: [{ candidate_id, collection, record_id, junction_id, adopted,
//                                                already_linked? }] } }
//   POST /d1-inbox/accept-all       { filter?, dry_run? }   links the exact short-ID suggestions the caller can edit -> { data: { link_batch_id,
//                                                count, linked, skipped: [{ candidate_id, reason }], has_more } }
//   POST /d1-inbox/dismiss | /restore  { candidate_ids: [...] }  -> { data: { changed, unchanged } }
//   POST /d1-inbox/undo             { link_batch_id }       removes the junction rows that batch created, candidates go back to new
//   POST /d1-inbox/rescan           queue a person-scope scan; 429 within 10 minutes of the last request, or while one is queued or running
//   GET  /d1-inbox/prefs, PUT /d1-inbox/prefs { auto_link: boolean }
//   POST /d1-inbox/auto-link        MACHINE ONLY (the crawler): header X-Inbox-Crawler-Secret = env D1_INBOX_CRAWLER_SECRET
//                                   { candidate_ids: [...] } (or candidate_id) -> { data: { results: [{ candidate_id, status: 'linked' | 'skipped'
//                                   | 'error', reason?, link_batch_id? }] } }
//   GET  /d1-inbox/admin, POST /d1-inbox/admin/scan-all     administrators only
//
// Errors have the Directus shape { errors: [{ message, extensions: { code, source: 'd1-inbox', ... } }] }: 401 no user, 403 not allowed,
// 404 unknown (or not yours to see), 409 refused state, 400 bad input, 429 rate limit.
//
// Visibility of a candidate: its owner person's login, any ACTIVE member (people.active) of its owner team, administrators (all).
//
// How a request runs (the d1-build / d1-record-access pattern):
//   * Every write transaction starts with set_config('d1.actor_identity', <user id>, true), so the audit trigger names the person.
//   * A link is a junction row (sample_data_files, operation_data_files, session_data_files) created through Directus's ItemsService with the
//     caller's accountability and knex: trx, so Directus permissions and every hook apply. Junction CREATES are not restricted by the
//     permission rules (ADR-0011: create is 'any'), so this endpoint decides first: the caller must be able to EDIT the target record. The
//     test is d1-access-guard's own: the update rule of the record (core/extensions/d1-access-guard/rules.json, generated from
//     scripts/access_rules.json) run as a read through ItemsService as the caller, with $CURRENT_USER replaced (see canEditMany). It is MIRRORED
//     here, not imported, because the guard keeps canPass private to its hook factory. A Lab Viewer, a view-only person, and a Restricted
//     record the caller cannot read all fail it. Administrators are not checked against the rule (as in the guard); the record must exist.
//   * The candidate rows are locked FOR UPDATE (in id order) before they are read, so two team members linking one file serialise: the second
//     sees state 'linked' and gets 409. The candidate update also names state = 'new', so a second junction row cannot be made.
//   * Auto-link acts on a person's behalf: accountabilityFor() builds what Directus's own getAccountabilityForToken builds for that login
//     ({ user, role, roles (the role and its parents), admin, app, ip: null }), from directus_users, the role tree and the policies. It never
//     uses an administrator accountability for someone who is not one.
//   * After a commit the Directus data cache is cleared when CACHE_ENABLED is on (knex writes bypass the services that do it).
//   * Testable without Directus: mount(router, { database, services, getSchema, logger, env }, { clock, uuid }) takes everything it uses.
//
// The link keeps the four undo columns together (migration 193 CHECK): state 'linked' needs link_kind, linked_collection, linked_junction_id
// and link_batch_id, and undo clears all four. So a file that is ALREADY linked to the record (in Data Studio) cannot be marked linked here
// (there is no junction id this batch made, and undo must never delete a row it did not create): the link is refused 409 ALREADY_ON_RECORD.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { LAB_VIEWER_ROLE_ID, READ_ONLY_ROLE_MESSAGE, isLabViewer, isWriteRequest } from '../d1-record-access/index.js';

const SOURCE = 'd1-inbox';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENT_USER = '$CURRENT_USER';
const MAX_BATCH = 200;
const ACCEPT_LIMIT = 500;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
const MAX_TEXT = 500;
const RESCAN_WINDOW_MS = 10 * 60 * 1000;
const DAEMON_STALE_MS = 5 * 60 * 1000;
const CRAWLER_STATE_ID = '00000000-0000-0000-0000-000000000001';

// What a candidate can be: the kinds the crawler reads before a person links (images and scans) and the rest (read once, after the link).
const IMAGE_KINDS = ['sem_image', 'image', 'surface_scan'];
const ALL_KINDS = ['sem_image', 'surface_scan', 'image', 'document', 'other'];
// Kinds accept-all and auto-link may link in v1: images. A surface scan is ADDED to an insert or edge (stream F1), not linked to a sample.
const AUTO_KINDS = ['sem_image', 'image'];
const STRENGTHS = ['short_id', 'code', 'edge_code', 'none'];
const LINK_KINDS = ['manual', 'bulk', 'auto'];
const TABS = ['new', 'older', 'linked', 'dismissed', 'open'];

// Link targets in v1: the record collection -> its data-files junction and the junction's column for the record.
export const LINK_TARGETS = {
  physical_samples: { junction: 'sample_data_files', fk: 'sample_id', pk: 'sample_id' },
  manufacturing_operations: { junction: 'operation_data_files', fk: 'operation_id', pk: 'operation_id' },
  test_sessions: { junction: 'session_data_files', fk: 'session_id', pk: 'session_id' },
};
const isTarget = (name) => typeof name === 'string' && Object.hasOwn(LINK_TARGETS, name);

// The update rule ("Can edit") of each target, from d1-access-guard's generated rules. Samples: the guard of campaign_samples.sample_id. Tests:
// the guard of test_sessions_subject. Operations and tests share the rule record.update in scripts/access_rules.json (a test pins that), so
// the tests' filter is the operations' filter.
const GUARD_RULES = JSON.parse(readFileSync(new URL('../d1-access-guard/rules.json', import.meta.url), 'utf8')).guards;
const ruleFor = (junction, parent) => {
  const found = (GUARD_RULES[junction] ?? []).find((g) => g.parent === parent);
  if (!found?.filter) throw new Error(`d1-inbox: d1-access-guard rules.json has no ${junction} guard for ${parent}`);
  return found.filter;
};
const EDIT_RULES = {
  physical_samples: ruleFor('campaign_samples', 'physical_samples'),
  test_sessions: ruleFor('test_sessions_subject', 'test_sessions'),
};
EDIT_RULES.manufacturing_operations = EDIT_RULES.test_sessions;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const rowsOf = (out) => out?.rows ?? [];
const toIso = (t) => (t instanceof Date ? t.toISOString() : t == null ? null : new Date(t).toISOString());
const isDenied = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
const isUnique = (e) => e?.code === '23505' || e?.code === 'RECORD_NOT_UNIQUE';
const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const isUuid = (v) => typeof v === 'string' && UUID.test(v);

// ---- SQL (parameterised; nothing a client sends is put into SQL text) ----------------------------------------------------------

const CANDIDATE_COLUMNS = 'c.candidate_id, c.directus_files_id, c.owner_person_id, c.owner_team_id, c.kind, c.state, c.origin, c.match_strength, c.matches,'
  + ' c.suggested_collection, c.suggested_record_id, c.duplicate_of, c.decided_by, c.link_kind, c.linked_collection, c.linked_junction_id,'
  + ' c.link_batch_id, c.adopted_at';
const IDS = "string_to_array(?, ',')::uuid[]";
const perTarget = (build) => Object.fromEntries(Object.entries(LINK_TARGETS).map(([collection, t]) => [collection, build(t, collection)]));
// A copy (duplicate_of) drops out of the new and older lists once its original was linked or dismissed.
const COPY_HIDDEN = "NOT (c.duplicate_of IS NOT NULL AND o.state IN ('linked', 'dismissed'))";

export const SQL = {
  setActor: "SELECT set_config('d1.actor_identity', ?, true)",
  lock: 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))',
  personByUser: 'SELECT person_id, full_name, active, uni_alias, user_id FROM people WHERE user_id = ?',
  personById: 'SELECT person_id, full_name, active, uni_alias, user_id FROM people WHERE person_id = ?',
  teamsOfPerson:
    'SELECT t.team_id, t.name, t.share_folder FROM team_members m JOIN teams t ON t.team_id = m.team_id WHERE m.person_id = ? ORDER BY t.name',
  // Bindings: the person id, the team ids as one csv ('' for none).
  summary:
    'SELECT c.owner_person_id, c.owner_team_id, c.origin,'
    + " (c.suggested_record_id IS NOT NULL AND c.match_strength IN ('short_id', 'code')) AS exact, count(*)::int AS n"
    + ' FROM d1_private.file_candidates c LEFT JOIN d1_private.file_candidates o ON o.candidate_id = c.duplicate_of'
    + ` WHERE c.state = 'new' AND (c.owner_person_id = ? OR c.owner_team_id = ANY(${IDS})) AND ${COPY_HIDDEN}`
    + ' GROUP BY c.owner_person_id, c.owner_team_id, c.origin, exact',
  // The rows of the candidates asked for, locked in id order (two requests for one file serialise on this).
  candidatesForUpdate: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) ORDER BY c.candidate_id FOR UPDATE`,
  batchForUpdate: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.link_batch_id = ? ORDER BY c.candidate_id FOR UPDATE`,
  // Bindings: decided_by, link_kind, collection, junction id, batch id, adopt (boolean), candidate id. Only a candidate still 'new' changes.
  markLinked:
    "UPDATE d1_private.file_candidates SET state = 'linked', decided_at = now(), decided_by = ?, link_kind = ?, linked_collection = ?,"
    + ' linked_junction_id = ?, link_batch_id = ?,'
    + ' adopted_at = CASE WHEN ?::boolean THEN coalesce(adopted_at, now()) ELSE adopted_at END'
    + " WHERE candidate_id = ? AND state = 'new' RETURNING candidate_id",
  // Undo clears the four link columns together (the table's CHECK). adopted_at stays: the crawler may already have hashed the file.
  resetBatch:
    "UPDATE d1_private.file_candidates SET state = 'new', decided_at = NULL, decided_by = NULL, link_kind = NULL, linked_collection = NULL,"
    + ` linked_junction_id = NULL, link_batch_id = NULL WHERE candidate_id = ANY(${IDS}) AND link_batch_id = ? AND state = 'linked'`
    + ' RETURNING candidate_id',
  dismiss:
    "UPDATE d1_private.file_candidates SET state = 'dismissed', decided_at = now(), decided_by = ?"
    + ` WHERE candidate_id = ANY(${IDS}) AND state = 'new' RETURNING candidate_id`,
  restore:
    "UPDATE d1_private.file_candidates SET state = 'new', decided_at = NULL, decided_by = NULL"
    + ` WHERE candidate_id = ANY(${IDS}) AND state = 'dismissed' RETURNING candidate_id`,
  prefsGet: 'SELECT auto_link FROM d1_private.inbox_prefs WHERE user_id = ?',
  prefsPut:
    'INSERT INTO d1_private.inbox_prefs (user_id, auto_link) VALUES (?, ?)'
    + ' ON CONFLICT (user_id) DO UPDATE SET auto_link = EXCLUDED.auto_link, updated_at = now() RETURNING auto_link',
  // The rate limit: the person's last request began, or finished, in the window, or is still queued or running. Bindings: person, window start (twice).
  rescanBlocking:
    'SELECT request_id, status, requested_at, finished_at FROM d1_private.inbox_scan_requests'
    + " WHERE scope = 'person' AND person_id = ?"
    + " AND (requested_at > ?::timestamptz OR finished_at > ?::timestamptz OR status IN ('queued', 'running'))"
    + ' ORDER BY requested_at DESC LIMIT 1',
  rescanInsert:
    "INSERT INTO d1_private.inbox_scan_requests (scope, person_id, requested_by) VALUES ('person', ?, ?)"
    + ' RETURNING request_id, status, requested_at',
  scanAllBlocking:
    "SELECT request_id, status, requested_at FROM d1_private.inbox_scan_requests WHERE scope = 'all' AND status IN ('queued', 'running')"
    + ' ORDER BY requested_at DESC LIMIT 1',
  scanAllInsert:
    "INSERT INTO d1_private.inbox_scan_requests (scope, requested_by) VALUES ('all', ?) RETURNING request_id, status, requested_at",
  // Auto-link: what Directus's getAccountabilityForToken reads for a login.
  userForAccountability: 'SELECT id, role, status FROM directus_users WHERE id = ?',
  roleTree:
    'WITH RECURSIVE tree AS (SELECT id, parent, 0 AS depth FROM directus_roles WHERE id = ?'
    + ' UNION ALL SELECT r.id, r.parent, t.depth + 1 FROM directus_roles r JOIN tree t ON r.id = t.parent WHERE t.depth < 20)'
    + ' SELECT id FROM tree ORDER BY depth',
  globalAccess:
    'SELECT coalesce(bool_or(p.admin_access), false) AS admin, coalesce(bool_or(p.app_access), false) AS app'
    + ` FROM directus_access a JOIN directus_policies p ON p.id = a.policy WHERE a."user" = ? OR a.role = ANY(${IDS})`,
  adminState:
    'SELECT desired_state, interval_minutes, read_mb_per_s, last_heartbeat_at, daemon_started_at, current_activity, last_scan_started_at,'
    + ' last_scan_finished_at, files_registered, error_count, last_error, unmatched_folders'
    + ` FROM d1_private.inbox_crawler_state WHERE id = '${CRAWLER_STATE_ID}'`,
  adminPeopleWithoutAlias:
    'SELECT person_id, full_name, (user_id IS NOT NULL) AS has_login FROM people WHERE active AND uni_alias IS NULL ORDER BY full_name, person_id LIMIT 500',
  adminTotals: 'SELECT state, count(*)::int AS n FROM d1_private.file_candidates GROUP BY state',
  adminQueue:
    "SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running"
    + " FROM d1_private.inbox_scan_requests WHERE status IN ('queued', 'running')",
  recordsExist: perTarget((t, collection) => `SELECT ${t.pk} FROM ${collection} WHERE ${t.pk} = ANY(${IDS})`),
  junctionFind: perTarget((t) => `SELECT id FROM ${t.junction} WHERE ${t.fk} = ? AND directus_files_id = ?`),
  junctionById: perTarget((t) => `SELECT id, ${t.fk} AS record_id, directus_files_id FROM ${t.junction} WHERE id = ?`),
};

// ---- pure helpers (exported for the tests) -----------------------------------------------------------------------------------

// Constant-time string equality for secrets: both digests have one length whatever the inputs. Blank or non-string never matches.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

// scope = { personId, teamIds, admin }: who is asking, and which folders are theirs.
export function canSee(scope, candidate) {
  if (scope.admin === true) return true;
  if (scope.personId && candidate.owner_person_id === scope.personId) return true;
  return Boolean(candidate.owner_team_id) && scope.teamIds.includes(candidate.owner_team_id);
}

const badInput = (message) => new HttpError(400, 'INVALID_PAYLOAD', message);
const text = (v, what) => {
  if (isBlank(v)) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw badInput(`${what} is not valid.`);
  const out = String(v).trim();
  if (out.length > MAX_TEXT) throw badInput(`${what} is too long.`);
  return out === '' ? null : out;
};
const isRealDay = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};
const intParam = (v, what, { min, max, fallback }) => {
  const t = text(v, what);
  if (t === null) return fallback;
  if (!/^-?\d+$/.test(t)) throw badInput(`${what} must be a whole number.`);
  const n = Number(t);
  if (n < min) throw badInput(`${what} must be at least ${min}.`);
  return Math.min(n, max);
};

// The filters of a list (query string) or of accept-all (an object). Returns a clean object or throws 400.
export function parseFileFilters(source, { defaultTab = 'new' } = {}) {
  const q = source ?? {};
  if (!isObject(q)) throw badInput('The filter is not valid.');
  const tab = text(q.tab, 'tab') ?? defaultTab;
  if (!TABS.includes(tab)) throw badInput('Unknown tab.');
  const kindText = text(q.kind, 'kind');
  const kinds = kindText === null ? null : kindText.split(',').map((k) => k.trim()).filter(Boolean);
  if (kinds && (!kinds.length || kinds.some((k) => !ALL_KINDS.includes(k)))) throw badInput('Unknown kind.');
  let folder = text(q.folder, 'folder');
  if (folder !== null) folder = `${folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}/`;
  if (folder === '/') folder = null;
  const dateFrom = text(q.date_from, 'date_from');
  const dateTo = text(q.date_to, 'date_to');
  for (const [d, what] of [[dateFrom, 'date_from'], [dateTo, 'date_to']]) if (d !== null && !isRealDay(d)) throw badInput(`${what} must be a day, YYYY-MM-DD.`);
  const strength = text(q.strength, 'strength');
  if (strength !== null && strength !== 'any' && !STRENGTHS.includes(strength)) throw badInput('Unknown match strength.');
  const ownerPerson = text(q.owner_person_id, 'owner_person_id');
  const ownerTeam = text(q.owner_team_id, 'owner_team_id');
  if (ownerPerson !== null && !isUuid(ownerPerson)) throw badInput('owner_person_id is not valid.');
  if (ownerTeam !== null && !isUuid(ownerTeam)) throw badInput('owner_team_id is not valid.');
  const linkKind = text(q.link_kind, 'link_kind');
  if (linkKind !== null && !LINK_KINDS.includes(linkKind)) throw badInput('Unknown link kind.');
  return {
    tab, kinds, folder, date_from: dateFrom, date_to: dateTo, strength, link_kind: linkKind,
    owner_person_id: ownerPerson?.toLowerCase() ?? null, owner_team_id: ownerTeam?.toLowerCase() ?? null,
    limit: intParam(q.limit, 'limit', { min: 1, max: MAX_PAGE, fallback: DEFAULT_PAGE }),
    offset: intParam(q.offset, 'offset', { min: 0, max: 1_000_000, fallback: 0 }),
  };
}

const LIST_SELECT = 'SELECT c.candidate_id, c.directus_files_id AS file_id, f.filename_download AS name, f.type AS mime_type, c.kind, c.kind_confidence,'
  + ' c.extracted, c.origin, c.state, c.match_strength, c.matches, c.suggested_collection, c.suggested_record_id, c.duplicate_of,'
  + " coalesce(cp.full_name, ct.name) AS copy_owner_name,"
  + " CASE WHEN o.candidate_id IS NULL THEN NULL WHEN o.owner_person_id IS NOT NULL THEN 'person' ELSE 'team' END AS copy_owner_kind,"
  + ' c.rel_path, c.size_bytes, c.source_mtime, c.first_seen_at, c.decided_at, c.link_kind, c.linked_collection, c.link_batch_id,'
  + ' c.owner_person_id, c.owner_team_id, coalesce(op.full_name, ot.name) AS owner_name, c.adopted_at';
const LIST_FROM = ' FROM d1_private.file_candidates c'
  + ' LEFT JOIN directus_files f ON f.id = c.directus_files_id'
  + ' LEFT JOIN d1_private.file_candidates o ON o.candidate_id = c.duplicate_of'
  + ' LEFT JOIN people op ON op.person_id = c.owner_person_id LEFT JOIN teams ot ON ot.team_id = c.owner_team_id'
  + ' LEFT JOIN people cp ON cp.person_id = o.owner_person_id LEFT JOIN teams ct ON ct.team_id = o.owner_team_id';
const SLIM_FROM = ' FROM d1_private.file_candidates c LEFT JOIN d1_private.file_candidates o ON o.candidate_id = c.duplicate_of';

// The query for a list page ({ count: true }: its total; { accept: true }: the ids accept-all considers). Everything a client chose is a binding.
export function buildListQuery(scope, f, { count = false, accept = false } = {}) {
  const where = [];
  const bindings = [];
  const mine = scope.personId !== null && scope.personId !== undefined;
  if (f.owner_person_id || f.owner_team_id) {
    const parts = [];
    if (f.owner_person_id) { parts.push('c.owner_person_id = ?'); bindings.push(f.owner_person_id); }
    if (f.owner_team_id) { parts.push('c.owner_team_id = ?'); bindings.push(f.owner_team_id); }
    where.push(`(${parts.join(' OR ')})`);
  } else {
    where.push(`(c.owner_person_id = ? OR c.owner_team_id = ANY(${IDS}))`);
    bindings.push(mine ? scope.personId : null, scope.teamIds.join(','));
  }
  if (f.tab === 'new') where.push("c.state = 'new'", "c.origin = 'new'", COPY_HIDDEN);
  else if (f.tab === 'older') where.push("c.state = 'new'", "c.origin = 'backlog'", COPY_HIDDEN);
  else if (f.tab === 'open') where.push("c.state = 'new'", COPY_HIDDEN);
  else where.push(`c.state = '${f.tab}'`); // linked or dismissed (validated by parseFileFilters)
  if (f.kinds) { where.push("c.kind = ANY(string_to_array(?, ','))"); bindings.push(f.kinds.join(',')); }
  if (f.folder) { where.push('starts_with(c.rel_path, ?)'); bindings.push(f.folder); }
  if (f.date_from) { where.push('coalesce(c.source_mtime, c.first_seen_at) >= ?::date'); bindings.push(f.date_from); }
  if (f.date_to) { where.push('coalesce(c.source_mtime, c.first_seen_at) < (?::date + 1)'); bindings.push(f.date_to); }
  if (f.strength === 'any') where.push("c.match_strength <> 'none'");
  else if (f.strength) { where.push('c.match_strength = ?'); bindings.push(f.strength); }
  if (f.link_kind) { where.push('c.link_kind = ?'); bindings.push(f.link_kind); }
  if (accept) {
    where.push("c.state = 'new'", "c.match_strength = 'short_id'", 'c.suggested_record_id IS NOT NULL');
    return { sql: `SELECT c.candidate_id${SLIM_FROM} WHERE ${where.join(' AND ')} ORDER BY c.first_seen_at, c.candidate_id LIMIT ${ACCEPT_LIMIT}`, bindings };
  }
  if (count) return { sql: `SELECT count(*)::int AS total${SLIM_FROM} WHERE ${where.join(' AND ')}`, bindings };
  const order = f.tab === 'linked' || f.tab === 'dismissed'
    ? 'ORDER BY c.decided_at DESC NULLS LAST, c.candidate_id'
    : 'ORDER BY c.first_seen_at DESC, c.candidate_id';
  return { sql: `${LIST_SELECT}${LIST_FROM} WHERE ${where.join(' AND ')} ${order} LIMIT ? OFFSET ?`, bindings: [...bindings, f.limit, f.offset] };
}

// The grouped counts of the summary query as the answer: the person's, and each team's (a team with nothing is still listed).
export function shapeSummary(rows, scope, teams, _person) {
  const sum = (match, want) => rows.filter(match).reduce((total, r) => total + (want(r) ? Number(r.n) : 0), 0);
  const counts = (match) => ({
    new: sum(match, (r) => r.origin === 'new'),
    older_matching: sum(match, (r) => r.origin === 'backlog' && r.exact === true),
  });
  const person = scope.personId ? { person_id: scope.personId, ...counts((r) => r.owner_person_id === scope.personId) } : null;
  const teamOut = teams.map((t) => ({ team_id: t.team_id, name: t.name, ...counts((r) => r.owner_team_id === t.team_id) }));
  const all = [person, ...teamOut].filter(Boolean);
  return {
    person,
    teams: teamOut,
    total_new: all.reduce((total, c) => total + c.new, 0),
    total_older_matching: all.reduce((total, c) => total + c.older_matching, 0),
  };
}

// $CURRENT_USER anywhere in a filter (ItemsService does not substitute it, the REST layer does).
function substitute(node, user) {
  if (node === CURRENT_USER) return user;
  if (Array.isArray(node)) return node.map((item) => substitute(item, user));
  if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, user)]));
  return node;
}

// What the Home panel and the Inbox page need of a candidate row. The record a suggestion names is shown only when the caller may edit it
// (`editable` is the set of "collection:id" the edit check passed): a record the caller cannot edit is not named, so no id leaks.
function fileOut(row, editable) {
  const matches = Array.isArray(asJson(row.matches)) ? asJson(row.matches) : [];
  const key = `${row.suggested_collection}:${row.suggested_record_id}`;
  const hit = row.suggested_record_id ? matches.find((m) => m.record_id === row.suggested_record_id && m.collection === row.suggested_collection) : null;
  const suggestion = row.suggested_record_id && editable.has(key)
    ? { collection: row.suggested_collection, record_id: row.suggested_record_id, via: hit?.via ?? null, token: hit?.token ?? null }
    : null;
  const slash = String(row.rel_path ?? '').lastIndexOf('/');
  return {
    id: row.candidate_id,
    file_id: row.file_id,
    name: row.name ?? String(row.rel_path ?? '').slice(slash + 1),
    mime_type: row.mime_type ?? null,
    kind: row.kind,
    kind_confidence: num(row.kind_confidence),
    extracted: asJson(row.extracted) ?? {},
    origin: row.origin,
    state: row.state,
    match_strength: row.match_strength,
    match_count: matches.length,
    suggestion,
    is_copy: Boolean(row.duplicate_of),
    copy_of: row.duplicate_of ? { owner_kind: row.copy_owner_kind ?? null, owner_name: row.copy_owner_name ?? null } : null,
    rel_path: row.rel_path,
    folder: slash >= 0 ? row.rel_path.slice(0, slash + 1) : '',
    size_bytes: num(row.size_bytes),
    source_mtime: toIso(row.source_mtime),
    first_seen_at: toIso(row.first_seen_at),
    decided_at: toIso(row.decided_at),
    link: row.state === 'linked' ? { kind: row.link_kind, collection: row.linked_collection, batch_id: row.link_batch_id } : null,
    owner: row.owner_person_id
      ? { kind: 'person', id: row.owner_person_id, name: row.owner_name ?? null }
      : { kind: 'team', id: row.owner_team_id, name: row.owner_name ?? null },
    adopted: row.adopted_at !== null && row.adopted_at !== undefined,
  };
}

// ---- the endpoint ----------------------------------------------------------------------------------------------------------

export function mount(router, context, deps = {}) {
  const { database, logger, services, getSchema, env } = context;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.uuid ?? (() => randomUUID());
  const secret = typeof env?.D1_INBOX_CRAWLER_SECRET === 'string' ? env.D1_INBOX_CRAWLER_SECRET : '';
  if (secret === '') logger?.warn?.(`${SOURCE}: D1_INBOX_CRAWLER_SECRET is not set, so POST /d1-inbox/auto-link refuses every call`);

  const sendError = (res, err) => {
    const known = err instanceof HttpError;
    if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    if (known && err.status === 429 && err.extra.retry_after_seconds) res.setHeader?.('Retry-After', String(err.extra.retry_after_seconds));
    return res.status(known ? err.status : 500).json({
      errors: [{
        message: known ? err.message : 'Something went wrong on the server.',
        extensions: { ...(known ? err.extra : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
      }],
    });
  };
  // A person's route: needs a signed-in user; a Lab Viewer changes nothing (every write is refused first).
  const route = (fn) => async (req, res) => {
    try {
      const acc = req.accountability;
      if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
      if (isWriteRequest(req) && (await isLabViewer(database, acc.user))) throw new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE);
      await fn({ req, res, acc });
    } catch (err) {
      sendError(res, err);
    }
  };
  const adminRoute = (fn) => route(async (ctx) => {
    if (ctx.acc.admin !== true) throw new HttpError(403, 'FORBIDDEN', 'Only administrators can do that.');
    await fn(ctx);
  });
  // The crawler's route: the shared secret, nothing else (a signed-in person without it is refused too).
  const machineRoute = (fn) => async (req, res) => {
    try {
      if (secret === '') throw new HttpError(403, 'FORBIDDEN', 'Not allowed.');
      const given = req.headers?.['x-inbox-crawler-secret'];
      if (isBlank(given)) throw new HttpError(401, 'UNAUTHORIZED', 'Not allowed.');
      if (!safeEqual(given, secret)) throw new HttpError(403, 'FORBIDDEN', 'Not allowed.');
      await fn({ req, res });
    } catch (err) {
      sendError(res, err);
    }
  };

  const schemaOf = async (req) => req.schema ?? (await getSchema());
  const itemsFor = (schema, accountability, collection, knex) =>
    new services.ItemsService(collection, { schema, accountability, ...(knex ? { knex } : {}) });
  const inTransaction = (userId, work) =>
    database.transaction(async (trx) => {
      await trx.raw(SQL.setActor, [String(userId)]);
      return work(trx);
    });

  // Knex writes bypass the Directus services that clear the data cache, so clear it after the commit (as d1-build does).
  async function clearDataCache(schema) {
    if (!toBool(env?.CACHE_ENABLED)) return;
    try {
      await new services.UtilsService({ schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
    } catch (err) {
      logger?.warn?.(`${SOURCE}: could not clear the data cache: ${err?.message || err}`);
    }
  }

  // -- who is asking -------------------------------------------------------------------------------------------------------

  // The caller's person and the teams they are an ACTIVE member of (a Former person is a member of none).
  async function scopeOf(acc, db = database) {
    const [person] = rowsOf(await db.raw(SQL.personByUser, [acc.user]));
    const teams = person?.active ? rowsOf(await db.raw(SQL.teamsOfPerson, [person.person_id])) : [];
    return { personId: person?.person_id ?? null, teamIds: teams.map((t) => t.team_id), admin: acc.admin === true, person: person ?? null, teams };
  }
  const requireOwnerVisible = (scope, f) => {
    if (scope.admin) return;
    if (f.owner_person_id && f.owner_person_id !== scope.personId) throw new HttpError(403, 'FORBIDDEN', 'That folder is not yours.');
    if (f.owner_team_id && !scope.teamIds.includes(f.owner_team_id)) throw new HttpError(403, 'FORBIDDEN', 'That folder is not your team\'s.');
  };
  const requireIds = (v, what) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > MAX_BATCH || v.some((id) => !isUuid(id))) {
      throw badInput(`${what} must be 1 to ${MAX_BATCH} ids.`);
    }
    return [...new Set(v.map((id) => id.toLowerCase()))];
  };
  const bodyOf = (req) => (isObject(req.body) ? req.body : null);

  // -- the edit check ----------------------------------------------------------------------------------------------------------

  // Which of `ids` (of one target collection) may `acc` edit? The update rule of d1-access-guard, run as a read through ItemsService with the
  // caller's accountability (the real read rule applies as well, so a Restricted record the caller cannot read is not editable). One id is an
  // equality, several are one _in read. An administrator passes the rule by definition (as in the guard): the record only has to exist.
  async function canEditMany(db, acc, schema, collection, ids) {
    const target = LINK_TARGETS[collection];
    const list = [...new Set(ids.map(String))];
    if (!list.length) return new Set();
    if (acc.admin === true) {
      return new Set(rowsOf(await db.raw(SQL.recordsExist[collection], [list.join(',')])).map((r) => String(r[target.pk])));
    }
    try {
      const rows = await itemsFor(schema, acc, collection, db.isTransaction ? db : undefined).readByQuery({
        fields: [target.pk],
        filter: { _and: [{ [target.pk]: list.length === 1 ? { _eq: list[0] } : { _in: list } }, substitute(EDIT_RULES[collection], acc.user)] },
        limit: list.length,
      });
      return new Set(rows.map((r) => String(r[target.pk])));
    } catch (err) {
      if (isDenied(err)) return new Set();
      throw err;
    }
  }
  // { 'collection:id' } of everything in `pairs` ([collection, id]) that the caller may edit.
  async function editableSet(db, acc, schema, pairs) {
    const by = new Map();
    for (const [collection, id] of pairs) if (isTarget(collection) && !isBlank(id)) (by.get(collection) ?? by.set(collection, new Set()).get(collection)).add(String(id));
    const out = new Set();
    for (const [collection, ids] of by) for (const id of await canEditMany(db, acc, schema, collection, [...ids])) out.add(`${collection}:${id}`);
    return out;
  }
  const notEditable = (candidateId, collection, recordId) =>
    new HttpError(403, 'FORBIDDEN', 'You can only link a file to a record you can edit.', { candidate_id: candidateId, collection, record_id: recordId });

  // -- linking -------------------------------------------------------------------------------------------------------------------

  const junctionExists = async (trx, collection, recordId, fileId) =>
    rowsOf(await trx.raw(SQL.junctionFind[collection], [recordId, fileId]))[0] ?? null;

  // Writes the links of `entries` ({ cand, collection, recordId }) in the open transaction: the junction row as the caller, then the candidate.
  // The caller has already locked the candidates, checked their state and the edit rights.
  async function performLink(trx, { acc, schema, entries, linkKind, batchId }) {
    const linked = [];
    for (const { cand, collection, recordId } of entries) {
      const target = LINK_TARGETS[collection];
      let junctionId;
      try {
        junctionId = await itemsFor(schema, acc, target.junction, trx).createOne({ [target.fk]: recordId, directus_files_id: cand.directus_files_id });
      } catch (err) {
        if (isUnique(err)) throw new HttpError(409, 'ALREADY_ON_RECORD', 'That file is already linked to that record.', { candidate_id: cand.candidate_id });
        if (isDenied(err)) throw notEditable(cand.candidate_id, collection, recordId);
        throw err;
      }
      const adopt = !IMAGE_KINDS.includes(cand.kind);
      const done = rowsOf(await trx.raw(SQL.markLinked, [acc.user, linkKind, collection, junctionId, batchId, adopt, cand.candidate_id]));
      if (!done.length) throw new HttpError(409, 'ALREADY_LINKED', 'Someone already dealt with that file.', { candidate_id: cand.candidate_id });
      linked.push({ candidate_id: cand.candidate_id, collection, record_id: recordId, junction_id: junctionId, adopted: adopt });
    }
    return linked;
  }

  router.post('/link', route(async ({ req, res, acc }) => {
    const body = bodyOf(req);
    const items = body?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) throw badInput(`items must be 1 to ${MAX_BATCH} links.`);
    const wanted = [];
    for (const item of items) {
      if (!isObject(item) || !isUuid(item.candidate_id) || !isUuid(item.record_id) || !isTarget(item.collection)) {
        throw badInput('Each link needs a candidate_id, a collection (physical_samples, manufacturing_operations or test_sessions) and a record_id.');
      }
      wanted.push({ id: item.candidate_id.toLowerCase(), collection: item.collection, recordId: item.record_id.toLowerCase() });
    }
    if (new Set(wanted.map((w) => w.id)).size !== wanted.length) throw badInput('A file can only be linked once in one request.');
    const schema = await schemaOf(req);
    const scope = await scopeOf(acc);
    const linkKind = wanted.length === 1 ? 'manual' : 'bulk';
    const out = await inTransaction(acc.user, async (trx) => {
      const rows = new Map(rowsOf(await trx.raw(SQL.candidatesForUpdate, [wanted.map((w) => w.id).join(',')])).map((r) => [r.candidate_id, r]));
      const fresh = [];
      const again = [];
      for (const w of wanted) {
        const cand = rows.get(w.id);
        if (!cand || !canSee(scope, cand)) throw new HttpError(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: w.id });
        if (cand.state === 'new') { fresh.push({ cand, collection: w.collection, recordId: w.recordId }); continue; }
        if (cand.state === 'linked') {
          // the same person repeating the same link: nothing more to do
          const same = cand.decided_by === acc.user && cand.linked_collection === w.collection && cand.linked_junction_id
            && rowsOf(await trx.raw(SQL.junctionById[w.collection], [cand.linked_junction_id]))[0]?.record_id === w.recordId;
          if (!same) throw new HttpError(409, 'ALREADY_LINKED', 'That file was already linked.', { candidate_id: w.id });
          again.push({ candidate_id: w.id, collection: w.collection, record_id: w.recordId, junction_id: cand.linked_junction_id, adopted: !IMAGE_KINDS.includes(cand.kind), already_linked: true, link_batch_id: cand.link_batch_id });
          continue;
        }
        if (cand.state === 'gone') throw new HttpError(409, 'FILE_GONE', 'That file is no longer on the share.', { candidate_id: w.id });
        throw new HttpError(409, 'NOT_NEW', 'Restore that file before linking it.', { candidate_id: w.id });
      }
      // The edit check, before anything is written: all or nothing.
      const editable = await editableSet(trx, acc, schema, fresh.map((e) => [e.collection, e.recordId]));
      for (const e of fresh) if (!editable.has(`${e.collection}:${e.recordId}`)) throw notEditable(e.cand.candidate_id, e.collection, e.recordId);
      for (const e of fresh) {
        if (await junctionExists(trx, e.collection, e.recordId, e.cand.directus_files_id)) {
          throw new HttpError(409, 'ALREADY_ON_RECORD', 'That file is already linked to that record.', { candidate_id: e.cand.candidate_id });
        }
      }
      const batchId = fresh.length ? newId() : (again[0]?.link_batch_id ?? null);
      const linked = fresh.length ? await performLink(trx, { acc, schema, entries: fresh, linkKind, batchId }) : [];
      return { schema, link_batch_id: batchId, linked: [...linked, ...again.map(({ link_batch_id: _b, ...rest }) => rest)], wrote: fresh.length > 0 };
    });
    if (out.wrote) await clearDataCache(schema);
    res.json({ data: { link_batch_id: out.link_batch_id, count: out.linked.length, linked: out.linked } });
  }));

  // Why accept-all (and auto-link) would not link a candidate, or null when the candidate qualifies on its own data.
  const unfit = (cand, { auto }) => {
    if (cand.state !== 'new') return 'NOT_NEW';
    if (auto && cand.owner_team_id) return 'TEAM_FILE';
    if (cand.duplicate_of) return 'COPY';
    if (auto && cand.origin === 'backlog') return 'BACKLOG';
    if (cand.kind === 'surface_scan') return 'SURFACE_SCAN_NOT_AVAILABLE';
    if (!AUTO_KINDS.includes(cand.kind)) return auto ? 'KIND_NOT_ALLOWED' : 'DOCUMENT';
    if (cand.match_strength !== 'short_id') return 'NOT_EXACT';
    const matches = asJson(cand.matches);
    // two or more records named: never a suggestion (the crawler leaves suggested_* null, but a row that says otherwise is still refused)
    if (auto && Array.isArray(matches) && matches.length > 1) return 'AMBIGUOUS';
    if (!cand.suggested_record_id || !cand.suggested_collection) return 'NO_SUGGESTION';
    if (auto && (!Array.isArray(matches) || matches.length !== 1 || matches[0].record_id !== cand.suggested_record_id || matches[0].collection !== cand.suggested_collection)) return 'AMBIGUOUS';
    if (!isTarget(cand.suggested_collection)) return 'COLLECTION_NOT_SUPPORTED';
    return null;
  };

  router.post('/accept-all', route(async ({ req, res, acc }) => {
    const body = req.body === undefined || req.body === null ? {} : bodyOf(req);
    if (!body) throw badInput('The request is not valid.');
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') throw badInput('dry_run must be true or false.');
    const f = parseFileFilters(body.filter, { defaultTab: 'open' });
    const schema = await schemaOf(req);
    const scope = await scopeOf(acc);
    requireOwnerVisible(scope, f);
    const dry = body.dry_run === true;
    const work = async (db) => {
      const query = buildListQuery(scope, f, { accept: true });
      const ids = rowsOf(await db.raw(query.sql, query.bindings)).map((r) => r.candidate_id);
      const skipped = [];
      const fit = [];
      if (ids.length) {
        for (const cand of rowsOf(await db.raw(SQL.candidatesForUpdate, [ids.join(',')]))) {
          if (!canSee(scope, cand)) continue;
          const why = unfit(cand, { auto: false });
          if (why) skipped.push({ candidate_id: cand.candidate_id, reason: why });
          else fit.push(cand);
        }
      }
      const editable = await editableSet(db, acc, schema, fit.map((c) => [c.suggested_collection, c.suggested_record_id]));
      const entries = [];
      for (const cand of fit) {
        if (!editable.has(`${cand.suggested_collection}:${cand.suggested_record_id}`)) { skipped.push({ candidate_id: cand.candidate_id, reason: 'NOT_EDITABLE' }); continue; }
        if (await junctionExists(db, cand.suggested_collection, cand.suggested_record_id, cand.directus_files_id)) { skipped.push({ candidate_id: cand.candidate_id, reason: 'ALREADY_ON_RECORD' }); continue; }
        entries.push({ cand, collection: cand.suggested_collection, recordId: cand.suggested_record_id });
      }
      return { entries, skipped, has_more: ids.length >= ACCEPT_LIMIT };
    };
    if (dry) {
      const found = await work(database);
      res.json({ data: { link_batch_id: null, count: found.entries.length, linked: [], skipped: found.skipped, has_more: found.has_more, dry_run: true } });
      return;
    }
    const out = await inTransaction(acc.user, async (trx) => {
      const found = await work(trx);
      if (!found.entries.length) return { ...found, batchId: null, linked: [] };
      const batchId = newId();
      return { ...found, batchId, linked: await performLink(trx, { acc, schema, entries: found.entries, linkKind: 'bulk', batchId }) };
    });
    if (out.batchId) await clearDataCache(schema);
    res.json({ data: { link_batch_id: out.batchId, count: out.linked.length, linked: out.linked, skipped: out.skipped, has_more: out.has_more } });
  }));

  // -- dismiss, restore, undo ---------------------------------------------------------------------------------------------

  const stateChange = (name, { from, to, refusal }) => route(async ({ req, res, acc }) => {
    const body = bodyOf(req);
    const ids = requireIds(body?.candidate_ids, 'candidate_ids');
    const scope = await scopeOf(acc);
    const out = await inTransaction(acc.user, async (trx) => {
      const rows = rowsOf(await trx.raw(SQL.candidatesForUpdate, [ids.join(',')]));
      const byId = new Map(rows.map((r) => [r.candidate_id, r]));
      const change = [];
      const unchanged = [];
      for (const id of ids) {
        const cand = byId.get(id);
        if (!cand || !canSee(scope, cand)) throw new HttpError(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: id });
        if (cand.state === from) change.push(id);
        else if (cand.state === to) unchanged.push(id);
        else throw new HttpError(409, refusal.code, refusal.message, { candidate_id: id });
      }
      const done = change.length ? rowsOf(await trx.raw(SQL[name], name === 'dismiss' ? [acc.user, change.join(',')] : [change.join(',')])).map((r) => r.candidate_id) : [];
      return { changed: done, unchanged: [...unchanged, ...change.filter((id) => !done.includes(id))] };
    });
    res.json({ data: out });
  });
  router.post('/dismiss', stateChange('dismiss', { from: 'new', to: 'dismissed', refusal: { code: 'NOT_NEW', message: 'That file was already linked or is gone.' } }));
  router.post('/restore', stateChange('restore', { from: 'dismissed', to: 'new', refusal: { code: 'NOT_DISMISSED', message: 'That file was linked or is gone, so it cannot be restored.' } }));

  router.post('/undo', route(async ({ req, res, acc }) => {
    const batch = bodyOf(req)?.link_batch_id;
    if (!isUuid(batch)) throw badInput('link_batch_id must be a batch id.');
    const schema = await schemaOf(req);
    const scope = await scopeOf(acc);
    const out = await inTransaction(acc.user, async (trx) => {
      const rows = rowsOf(await trx.raw(SQL.batchForUpdate, [batch.toLowerCase()])).filter((r) => r.state === 'linked' && canSee(scope, r));
      if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'That batch does not exist or was already undone.');
      if (!scope.admin && rows.some((r) => r.decided_by !== acc.user)) throw new HttpError(403, 'FORBIDDEN', 'Only the person who linked these files can undo it.');
      for (const row of rows) {
        // Only the junction row this batch created, and only if it is still there (someone may have removed it in Data Studio meanwhile).
        if (!row.linked_junction_id || !isTarget(row.linked_collection)) continue;
        const stillThere = rowsOf(await trx.raw(SQL.junctionById[row.linked_collection], [row.linked_junction_id]))[0];
        if (!stillThere) continue;
        try {
          await itemsFor(schema, acc, LINK_TARGETS[row.linked_collection].junction, trx).deleteOne(row.linked_junction_id);
        } catch (err) {
          if (isDenied(err)) throw new HttpError(403, 'FORBIDDEN', 'You can no longer change that record, so this link cannot be undone.', { candidate_id: row.candidate_id });
          throw err;
        }
      }
      const done = rowsOf(await trx.raw(SQL.resetBatch, [rows.map((r) => r.candidate_id).join(','), batch.toLowerCase()]));
      return { link_batch_id: batch.toLowerCase(), undone: done.length };
    });
    await clearDataCache(schema);
    res.json({ data: out });
  }));

  // -- reading ---------------------------------------------------------------------------------------------------------------

  router.get('/summary', route(async ({ res, acc }) => {
    const scope = await scopeOf(acc);
    const rows = scope.personId ? rowsOf(await database.raw(SQL.summary, [scope.personId, scope.teamIds.join(',')])) : [];
    res.json({ data: shapeSummary(rows, scope, scope.teams, scope.person) });
  }));

  router.get('/files', route(async ({ req, res, acc }) => {
    const f = parseFileFilters(req.query);
    const scope = await scopeOf(acc);
    requireOwnerVisible(scope, f);
    const page = buildListQuery(scope, f);
    const total = buildListQuery(scope, f, { count: true });
    const rows = rowsOf(await database.raw(page.sql, page.bindings));
    const [{ total: count } = { total: 0 }] = rowsOf(await database.raw(total.sql, total.bindings));
    const open = f.tab === 'new' || f.tab === 'older' || f.tab === 'open';
    const editable = open
      ? await editableSet(database, acc, await schemaOf(req), rows.map((r) => [r.suggested_collection, r.suggested_record_id]))
      : new Set();
    res.json({ data: rows.map((r) => fileOut(r, editable)), meta: { total: Number(count), limit: f.limit, offset: f.offset } });
  }));

  // -- rescan, prefs ----------------------------------------------------------------------------------------------------------

  router.post('/rescan', route(async ({ res, acc }) => {
    const scope = await scopeOf(acc);
    const hasFolder = Boolean(scope.person?.uni_alias) || scope.teams.some((t) => !isBlank(t.share_folder));
    if (!scope.personId || !hasFolder) {
      throw new HttpError(409, 'NO_FOLDER', 'There is no folder to scan yet. Ask an administrator to set your uni alias.');
    }
    const limited = (wait) => new HttpError(429, 'RATE_LIMITED', 'Your folder was scanned or queued a moment ago. Try again in a few minutes.', { retry_after_seconds: wait });
    const now = clock();
    const since = new Date(now.getTime() - RESCAN_WINDOW_MS).toISOString();
    const out = await inTransaction(acc.user, async (trx) => {
      await trx.raw(SQL.lock, [`inbox-rescan:${scope.personId}`]);
      const [last] = rowsOf(await trx.raw(SQL.rescanBlocking, [scope.personId, since, since]));
      if (last) {
        const latest = Math.max(new Date(last.requested_at).getTime(), last.finished_at ? new Date(last.finished_at).getTime() : 0);
        const wait = Math.ceil((latest + RESCAN_WINDOW_MS - now.getTime()) / 1000);
        throw limited(wait > 0 ? wait : RESCAN_WINDOW_MS / 1000);
      }
      try {
        return rowsOf(await trx.raw(SQL.rescanInsert, [scope.personId, acc.user]))[0];
      } catch (err) {
        // the partial unique index (one queued or running request per person): a request that raced this one
        if (err?.code === '23505') throw limited(RESCAN_WINDOW_MS / 1000);
        throw err;
      }
    });
    res.status(202).json({ data: { request_id: out.request_id, status: out.status, requested_at: toIso(out.requested_at) } });
  }));

  router.get('/prefs', route(async ({ res, acc }) => {
    const [row] = rowsOf(await database.raw(SQL.prefsGet, [acc.user]));
    res.json({ data: { auto_link: row?.auto_link === true } });
  }));

  router.put('/prefs', route(async ({ req, res, acc }) => {
    const body = bodyOf(req);
    if (!body || Object.keys(body).length !== 1 || typeof body.auto_link !== 'boolean') throw badInput('The request must be { "auto_link": true or false }.');
    const row = await inTransaction(acc.user, async (trx) => rowsOf(await trx.raw(SQL.prefsPut, [acc.user, body.auto_link]))[0]);
    res.json({ data: { auto_link: row?.auto_link === true } });
  }));

  // -- auto-link (the crawler) ------------------------------------------------------------------------------------------------

  // What Directus's getAccountabilityForToken builds for a login: the role and its parents, and whether any policy is admin or app access.
  async function accountabilityFor(db, user) {
    const roles = isBlank(user.role) ? [] : rowsOf(await db.raw(SQL.roleTree, [user.role])).map((r) => r.id);
    const [access] = rowsOf(await db.raw(SQL.globalAccess, [user.id, roles.join(',')]));
    return { user: user.id, role: user.role ?? null, roles, admin: access?.admin === true, app: access?.app === true, ip: null };
  }
  const isViewerAccountability = (acc) => [acc.role, ...acc.roles].some((r) => typeof r === 'string' && r.toLowerCase() === LAB_VIEWER_ROLE_ID);

  async function autoLinkOne(candidateId, schema) {
    const skip = (reason) => ({ candidate_id: candidateId, status: 'skipped', reason });
    try {
      const out = await database.transaction(async (trx) => {
        const [cand] = rowsOf(await trx.raw(SQL.candidatesForUpdate, [candidateId]));
        if (!cand) return skip('NOT_FOUND');
        if (cand.owner_team_id || !cand.owner_person_id) return skip('TEAM_FILE');
        const [person] = rowsOf(await trx.raw(SQL.personById, [cand.owner_person_id]));
        const [user] = person?.user_id ? rowsOf(await trx.raw(SQL.userForAccountability, [person.user_id])) : [];
        if (!user || user.status !== 'active') return skip('NO_LOGIN');
        const [pref] = rowsOf(await trx.raw(SQL.prefsGet, [user.id]));
        if (pref?.auto_link !== true) return skip('OPTED_OUT');
        const acc = await accountabilityFor(trx, user);
        if (isViewerAccountability(acc)) return skip('READ_ONLY_ROLE');
        const why = unfit(cand, { auto: true });
        if (why) return skip(why);
        // the edit check as the person, then the link as the person
        const editable = await editableSet(trx, acc, schema, [[cand.suggested_collection, cand.suggested_record_id]]);
        if (!editable.has(`${cand.suggested_collection}:${cand.suggested_record_id}`)) return skip('NOT_EDITABLE');
        if (await junctionExists(trx, cand.suggested_collection, cand.suggested_record_id, cand.directus_files_id)) return skip('ALREADY_ON_RECORD');
        await trx.raw(SQL.setActor, [String(user.id)]);
        const batchId = newId();
        await performLink(trx, { acc, schema, linkKind: 'auto', batchId, entries: [{ cand, collection: cand.suggested_collection, recordId: cand.suggested_record_id }] });
        return { candidate_id: candidateId, status: 'linked', link_batch_id: batchId };
      });
      return out;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return skip(err.code);
      if (err instanceof HttpError && err.status === 403) return skip('NOT_EDITABLE');
      logger?.error?.(`${SOURCE}: auto-link of ${candidateId} failed: ${err?.stack || err?.message || err}`);
      return { candidate_id: candidateId, status: 'error', reason: 'ERROR' };
    }
  }

  router.post('/auto-link', machineRoute(async ({ req, res }) => {
    const body = bodyOf(req);
    const ids = requireIds(body?.candidate_ids ?? (isUuid(body?.candidate_id) ? [body.candidate_id] : undefined), 'candidate_ids');
    const schema = await schemaOf(req);
    const results = [];
    for (const id of ids) results.push(await autoLinkOne(id, schema));
    if (results.some((r) => r.status === 'linked')) await clearDataCache(schema);
    res.json({ data: { results } });
  }));

  // -- admin --------------------------------------------------------------------------------------------------------------------

  router.get('/admin', adminRoute(async ({ res }) => {
    const [state] = rowsOf(await database.raw(SQL.adminState, []));
    const people = rowsOf(await database.raw(SQL.adminPeopleWithoutAlias, []));
    const totals = rowsOf(await database.raw(SQL.adminTotals, []));
    const [queue] = rowsOf(await database.raw(SQL.adminQueue, []));
    const s = state ?? {};
    const beat = s.last_heartbeat_at ? new Date(s.last_heartbeat_at).getTime() : null;
    const daemon = beat === null ? 'never' : s.desired_state === 'paused' ? 'paused' : clock().getTime() - beat > DAEMON_STALE_MS ? 'stale' : 'alive';
    const unmatched = asJson(s.unmatched_folders);
    res.json({
      data: {
        status: {
          desired_state: s.desired_state ?? null, interval_minutes: num(s.interval_minutes), read_mb_per_s: num(s.read_mb_per_s), daemon,
          last_heartbeat_at: toIso(s.last_heartbeat_at), daemon_started_at: toIso(s.daemon_started_at), current_activity: s.current_activity ?? null,
          files_registered: num(s.files_registered) ?? 0,
        },
        last_scan: { started_at: toIso(s.last_scan_started_at), finished_at: toIso(s.last_scan_finished_at) },
        errors: { count: num(s.error_count) ?? 0, last_error: s.last_error ?? null },
        unmatched_folders: Array.isArray(unmatched) ? unmatched : [],
        people_without_alias: people.map((p) => ({ person_id: p.person_id, full_name: p.full_name, has_login: p.has_login === true })),
        queue: { queued: num(queue?.queued) ?? 0, running: num(queue?.running) ?? 0 },
        candidates: Object.fromEntries(totals.map((t) => [t.state, Number(t.n)])),
      },
    });
  }));

  router.post('/admin/scan-all', adminRoute(async ({ res, acc }) => {
    const out = await inTransaction(acc.user, async (trx) => {
      await trx.raw(SQL.lock, ['inbox-scan-all']);
      const [waiting] = rowsOf(await trx.raw(SQL.scanAllBlocking, []));
      if (waiting) throw new HttpError(409, 'ALREADY_QUEUED', 'A scan of everyone is already waiting or running.', { request_id: waiting.request_id });
      return rowsOf(await trx.raw(SQL.scanAllInsert, [acc.user]))[0];
    });
    res.status(202).json({ data: { request_id: out.request_id, status: out.status, requested_at: toIso(out.requested_at) } });
  }));
}

export default {
  id: SOURCE,
  handler: (router, context) => mount(router, context),
};
