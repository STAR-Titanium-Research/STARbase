// Directus endpoint: d1-inbox  (mounted at /d1-inbox)
//
// The server half of the Inbox (spec docs/superpowers/specs/2026-10-15-found-files-inbox-design.md sections 4, 5 and 9, ADR-0020, migration
// 20261015000193). The inbox crawler (scripts/inbox_crawler/) finds new files in a person's folder (Users/<uni alias>) and in each team's
// folder (Shared/<share folder>) and writes one candidate row per file to d1_private.file_candidates. This endpoint is the only way people
// reach those rows: they are never a Directus collection, so Directus's REST cannot read them.
//
// The shapes are the ones STARbase's typed client reads (packages/starbase-pages/src/inbox/inboxApi.ts, packages/d1-ui/src/inbox/inboxSummary.ts);
// every answer is { data: ... }.
//
//   GET  /d1-inbox/summary          -> { data: { person: {person_id, new, older_matches, has_alias} | null, teams: [{team_id, name, new,
//                                                older_matches}] (teams with a share folder), new, older_matches } }
//                                                new = origin 'new' (not backlog); older_matches = backlog files that name exactly one record by
//                                                short ID or code. A COPY of a file that is still in another inbox is not counted (D11: the badge
//                                                counts a file once; the list shows the copy, marked), nor is a file already on the record it
//                                                names (linked in Data Studio): neither is something new to link
//   GET  /d1-inbox/files?tab=new|older|linked|dismissed&kind=a,b&strength=a,b&folder=&from=&to=&owner=me|team:<id>&link_kind=&limit=&offset=
//                                   -> { data: FoundFile[], meta: { total, limit, offset, acceptable } }   FoundFile = the file_candidates columns
//                                      plus name, suggested_label, suggested_can_edit, duplicate_of_owner, linked_record_id, linked_label,
//                                      decided_by_name and owner {kind, id, name}. A record is named (suggestion, matches, linked record) only
//                                      to a caller who can READ it. meta.acceptable (null unless the query has acceptable=1: it reads
//                                      candidates and checks edit rights) = how many rows Accept all would link for the same filter.
//   POST /d1-inbox/link             { items: [{ candidate_id, collection, record_id } | <a surface scan>] }  (1 to 200, one transaction)
//                                   -> { data: { link_batch_id, linked: <count of newly linked>, items: [{ candidate_id, collection, record_id,
//                                                junction_id, adopted, already_linked? }] } }   link_batch_id is null and linked 0 when every item
//                                                was already linked by the same person (a repeat).
//                                   A SURFACE SCAN is ADDED, not linked (stream F1, spec section 8): the item is { candidate_id,
//                                   collection: 'surface_scans', insert_id | edge_id (exactly one), condition ('new' | 'worn' | 'cleaned' | 'other',
//                                   required, never defaulted), operation_id?, scanned_on? (YYYY-MM-DD), condition_note?, notes? } and only for a
//                                   candidate of kind 'surface_scan' (409 NOT_A_SURFACE_SCAN otherwise; a surface_scan candidate linked to a sample,
//                                   operation or test is 409 SURFACE_SCAN). It creates a surface_scans row through ItemsService as the caller in the
//                                   same transaction that marks the candidate linked (link_kind manual or bulk, linked_collection 'surface_scans',
//                                   linked_junction_id = the scan id). Its answer item is { candidate_id, collection: 'surface_scans', record_id:
//                                   <scan_id>, junction_id: <scan_id>, insert_id, edge_id (one of them null), adopted: false }. Refusals: 400
//                                   INVALID_PAYLOAD (extensions.field names the field), 404 NOT_FOUND (insert, edge or operation the caller cannot
//                                   read), 409 ALREADY_ADDED (the table's unique constraints), 409 SURFACE_SCANS_UNAVAILABLE (no such table yet).
//   POST /d1-inbox/accept-all       { filter?, dry_run?, candidate_ids?, cursor? }   links the exact short-ID suggestions the caller can edit
//                                   (images, and documents or other files, never surface scans) -> { data: { link_batch_id, linked: <count>,
//                                   items, skipped: [{ candidate_id, reason }] (the first 200), skipped_total, has_more, next_cursor } }.
//                                   dry_run -> { data: { count, ids, skipped, skipped_total, has_more, next_cursor } } and nothing is written.
//                                   With candidate_ids (the ids of a preview) exactly those are re-checked under the row locks and linked if
//                                   they still qualify; the filter is ignored. Without them it reads the filter's rows a page at a time (keyset
//                                   on first_seen_at, candidate_id) so a page of rows it must skip never hides linkable rows behind it;
//                                   has_more is true only when the last page it read was full, and next_cursor (sent back as `cursor`) goes on.
//   POST /d1-inbox/dismiss | /restore  { candidate_ids: [...] }  -> { data: { changed: <count>, changed_ids, unchanged_ids } }
//   POST /d1-inbox/undo             { link_batch_id }       removes the junction rows that batch created (and the surface_scans rows it added,
//                                   as the caller: 403 when they may no longer delete) -> { data: { undone: <count> } }
//   POST /d1-inbox/rescan           queue a person-scope scan -> 202 { data: { queued: true, ... } }; 429 (extensions.retry_after_seconds) within
//                                   10 minutes of the last request, or while one is queued or running
//   GET  /d1-inbox/prefs, PUT /d1-inbox/prefs { auto_link: boolean }
//   POST /d1-inbox/auto-link        MACHINE ONLY (the crawler): header X-Inbox-Crawler-Secret = env D1_INBOX_CRAWLER_SECRET
//                                   { candidate_ids: [...] } (or candidate_id) -> { data: { results: [{ candidate_id, status: 'linked' | 'skipped'
//                                   | 'error', reason?, link_batch_id? }] } }. Images only (sem_image, image): never a surface scan.
//   GET  /d1-inbox/admin            administrators only -> { data: { status: {...}, errors: [{at, message}], unmatched_folders: [...],
//                                   people_without_alias: [{person_id, full_name, active, has_login}], queued_requests, queue, candidates } }
//   POST /d1-inbox/admin/scan-all   administrators only -> 202 { data: { queued: true, ... } }; 409 ALREADY_QUEUED while one waits
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

import { LAB_VIEWER_ROLE_ID, READ_ONLY_ROLE_MESSAGE, isWriteRequest } from '../d1-record-access/index.js';

const SOURCE = 'd1-inbox';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENT_USER = '$CURRENT_USER';
const MAX_BATCH = 200;
// Accept-all reads candidates a page at a time (keyset on first_seen_at, candidate_id): a page of rows it must skip (a record the caller cannot
// edit) must not hide the linkable rows behind it. One call reads at most ACCEPT_MAX_PAGES pages and stops once it has ACCEPT_MAX_ENTRIES to link
// (soft: the page that crosses it is finished); a cursor carries on from there.
const ACCEPT_PAGE = 500;
const ACCEPT_MAX_PAGES = 10;
const ACCEPT_MAX_ENTRIES = 500;
const ACCEPT_MAX_IDS = 1000;
const SKIPPED_SHOWN = 200;
const MIN_SECRET_LENGTH = 32;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
const MAX_TEXT = 500;
const RESCAN_WINDOW_MS = 10 * 60 * 1000;
const DAEMON_STALE_MS = 5 * 60 * 1000;
const CRAWLER_STATE_ID = '00000000-0000-0000-0000-000000000001';

// What a candidate can be: the kinds the crawler reads before a person links (images and scans) and the rest (read once, after the link).
const IMAGE_KINDS = ['sem_image', 'image', 'surface_scan'];
const ALL_KINDS = ['sem_image', 'surface_scan', 'image', 'document', 'other'];
// Kinds auto-link may link in v1: images. A surface scan is ADDED to an insert or edge with a condition a person chooses (stream F1), so it is
// never linked in bulk or automatically; documents and other files may be accepted in bulk (the link adopts them) but never automatically.
const AUTO_KINDS = ['sem_image', 'image'];
const STRENGTHS = ['short_id', 'code', 'edge_code', 'none'];
const LINK_KINDS = ['manual', 'bulk', 'auto'];
const TABS = ['new', 'older', 'linked', 'dismissed', 'open'];

// Link targets in v1: the record collection -> its data-files junction and the junction's column for the record.
export const LINK_TARGETS = {
  physical_samples: { junction: 'sample_data_files', fk: 'sample_id', pk: 'sample_id', code: 'sample_code' },
  manufacturing_operations: { junction: 'operation_data_files', fk: 'operation_id', pk: 'operation_id', code: 'pass_code' },
  test_sessions: { junction: 'session_data_files', fk: 'session_id', pk: 'session_id', code: 'test_code' },
};
const isTarget = (name) => typeof name === 'string' && Object.hasOwn(LINK_TARGETS, name);

// The surface scan (stream F1) is not a LINK_TARGETS entry: it makes a ROW of its own (no junction, no record-edit rule: scans are lab-wide reference
// data, so Directus's own create permission on surface_scans decides) and needs a person-chosen condition. These are the collections a link item names.
export const SURFACE_SCANS = 'surface_scans';
export const LINK_COLLECTIONS = [...Object.keys(LINK_TARGETS), SURFACE_SCANS];
export const SCAN_CONDITIONS = ['new', 'worn', 'cleaned', 'other'];
// The table has no length limits (TEXT); these are the endpoint's own, so a paste of a whole report is refused instead of stored.
const MAX_CONDITION_NOTE = 500;
const MAX_SCAN_NOTES = 2000;
// The records a scan names, read as the caller before anything is written: the column, the collection, its key and the word the message uses.
const SCAN_REFS = {
  insert_id: { collection: 'cutting_inserts', pk: 'insert_id', what: 'insert' },
  edge_id: { collection: 'insert_edges', pk: 'edge_id', what: 'edge' },
  operation_id: { collection: 'manufacturing_operations', pk: 'operation_id', what: 'operation' },
};

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
// The badge counts a file once (D11): a copy of a file still in another inbox is not counted (the list shows it, marked), until its original is gone.
const NOT_A_COUNTED_COPY = "(c.duplicate_of IS NULL OR o.state = 'gone')";
// A file that is already on the record it names (linked in Data Studio) is not a new thing to link: not counted, not accepted in bulk.
const NOT_ON_RECORD = Object.entries(LINK_TARGETS)
  .map(([collection, t]) => `NOT (c.suggested_collection = '${collection}' AND EXISTS (SELECT 1 FROM ${t.junction} j WHERE j.${t.fk} = c.suggested_record_id AND j.directus_files_id = c.directus_files_id))`)
  .join(' AND ');

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
    + ` WHERE c.state = 'new' AND (c.owner_person_id = ? OR c.owner_team_id = ANY(${IDS}))`
    + ` AND ${NOT_A_COUNTED_COPY} AND ${NOT_ON_RECORD}`
    + ' GROUP BY c.owner_person_id, c.owner_team_id, c.origin, exact',
  // The rows of the candidates asked for, locked in id order (two requests for one file serialise on this).
  candidatesForUpdate: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) ORDER BY c.candidate_id FOR UPDATE`,
  // The same rows without the lock: for reads that write nothing (the list's "acceptable" count, an accept-all dry run).
  candidatesById: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) ORDER BY c.candidate_id`,
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
    'SELECT person_id, full_name, active, (user_id IS NOT NULL) AS has_login FROM people WHERE active AND uni_alias IS NULL ORDER BY full_name, person_id LIMIT 500',
  adminFailedRequests:
    "SELECT coalesce(finished_at, requested_at) AS at, error FROM d1_private.inbox_scan_requests WHERE status = 'failed' ORDER BY coalesce(finished_at, requested_at) DESC LIMIT 10",
  adminTotals: 'SELECT state, count(*)::int AS n FROM d1_private.file_candidates GROUP BY state',
  adminQueue:
    "SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running"
    + " FROM d1_private.inbox_scan_requests WHERE status IN ('queued', 'running')",
  // Stream F1: does the surface_scans table exist yet (the Alicona chat's migration 192)? Checked once, then remembered.
  scanTableExists: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'surface_scans') AS available",
  // A scan row by id, as undo and a repeated add read it. Never run unless scanTableExists said yes.
  scanById: 'SELECT scan_id AS id, insert_id, edge_id, directus_files_id FROM surface_scans WHERE scan_id = ?',
  recordsExist: perTarget((t, collection) => `SELECT ${t.pk} FROM ${collection} WHERE ${t.pk} = ANY(${IDS})`),
  // Which (record, file) pairs are already linked: bindings are the record ids and the file ids as two csv lists, pair by pair (one query a collection).
  junctionFindMany: perTarget((t) => `SELECT ${t.fk} AS record_id, directus_files_id FROM ${t.junction} WHERE (${t.fk}, directus_files_id) IN (SELECT r, f FROM unnest(${IDS}, ${IDS}) AS pairs(r, f))`),
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
// Is this caller a Lab Viewer? By role id only, from the role and the roles list (as d1-access-guard's isViewerCaller), whatever the login says.
export function isViewerAccountability(acc) {
  const ids = [acc?.role, ...(Array.isArray(acc?.roles) ? acc.roles : [])].filter((id) => typeof id === 'string');
  return ids.some((id) => id.toLowerCase() === LAB_VIEWER_ROLE_ID);
}

export function canSee(scope, candidate) {
  if (scope.admin === true) return true;
  if (scope.personId && candidate.owner_person_id === scope.personId) return true;
  return Boolean(candidate.owner_team_id) && scope.teamIds.includes(candidate.owner_team_id);
}

// The refusals the client acts on (each is a Directus-shaped error, see shapeError). The routes throw these, and the contract fixtures write them.
const rateLimited = (wait) => new HttpError(429, 'RATE_LIMITED', 'Your folder was scanned or queued a moment ago. Try again in a few minutes.', { retry_after_seconds: wait });
export const ERRORS = {
  notEditable: (candidateId, collection, recordId) =>
    new HttpError(403, 'FORBIDDEN', 'You can only link a file to a record you can edit.', { candidate_id: candidateId, collection, record_id: recordId }),
  alreadyOnRecord: (candidateId) => new HttpError(409, 'ALREADY_ON_RECORD', 'That file is already linked to that record. Dismiss clears it.', { candidate_id: candidateId }),
  dealtWith: (candidateId) => new HttpError(409, 'ALREADY_LINKED', 'Someone already dealt with that file.', { candidate_id: candidateId }),
  alreadyLinked: (candidateId) => new HttpError(409, 'ALREADY_LINKED', 'That file was already linked.', { candidate_id: candidateId }),
  surfaceScan: (candidateId) => new HttpError(409, 'SURFACE_SCAN', 'A surface scan is added to an insert or an edge.', { candidate_id: candidateId }),
  notASurfaceScan: (candidateId) => new HttpError(409, 'NOT_A_SURFACE_SCAN', 'Only a surface scan file can be added to an insert or an edge.', { candidate_id: candidateId }),
  alreadyAdded: (candidateId) => new HttpError(409, 'ALREADY_ADDED', 'That file is already a surface scan of this insert or edge.', { candidate_id: candidateId }),
  scansUnavailable: () => new HttpError(409, 'SURFACE_SCANS_UNAVAILABLE', 'Surface scans are not available yet.'),
  scanNotAllowed: (candidateId) => new HttpError(403, 'FORBIDDEN', 'You are not allowed to add surface scans.', { candidate_id: candidateId }),
  scanRefMissing: (candidateId, what, id) =>
    new HttpError(404, 'NOT_FOUND', `That ${what} does not exist or you cannot see it.`, { candidate_id: candidateId, collection: SURFACE_SCANS, record_id: id }),
  scanUndoDenied: (candidateId) =>
    new HttpError(403, 'FORBIDDEN', 'You can no longer delete that surface scan, so adding it cannot be undone.', { candidate_id: candidateId }),
  notInInbox: (candidateId) => new HttpError(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: candidateId }),
  noFolder: () => new HttpError(409, 'NO_FOLDER', 'There is no folder to scan yet. Ask an administrator to set your uni alias.'),
  alreadyQueued: (requestId) => new HttpError(409, 'ALREADY_QUEUED', 'A scan of everyone is already waiting or running.', { request_id: requestId }),
  readOnly: () => new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE),
  adminOnly: () => new HttpError(403, 'FORBIDDEN', 'Only administrators can do that.'),
  rateLimited,
};

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
// A 400 about one field of a surface scan item: extensions.field names it (and candidate_id the item) so the form can mark the right control.
const badField = (field, message, candidateId) => new HttpError(400, 'INVALID_PAYLOAD', message, { field, ...(candidateId ? { candidate_id: candidateId } : {}) });

// One surface scan item of POST /link, checked before anything is read or written: the fields the contract lets a Lab Member send and nothing
// else (an extra key such as render_status, owner_person_id or cache_key is dropped here, never forwarded). The condition is required and never
// defaulted (the crawler does not guess it, the person chooses it); exactly one of insert_id and edge_id; scanned_on a real day; notes bounded.
export function parseScanItem(item) {
  const candidateId = isUuid(item.candidate_id) ? item.candidate_id.toLowerCase() : undefined;
  const id = (field) => {
    const v = item[field];
    if (isBlank(v)) return null;
    if (!isUuid(v)) throw badField(field, `${field} must be an id.`, candidateId);
    return v.toLowerCase();
  };
  const note = (field, max, label) => {
    const v = item[field];
    if (isBlank(v)) return null;
    if (typeof v !== 'string') throw badField(field, `${label} is not valid.`, candidateId);
    const out = v.trim();
    if (out.length > max) throw badField(field, `${label} is too long (at most ${max} characters).`, candidateId);
    return out === '' ? null : out;
  };
  if (typeof item.condition !== 'string' || !SCAN_CONDITIONS.includes(item.condition)) {
    throw badField('condition', 'Choose the condition of the insert or edge: new, worn, cleaned or other.', candidateId);
  }
  const insertId = id('insert_id');
  const edgeId = id('edge_id');
  if ((insertId === null) === (edgeId === null)) {
    throw badField(insertId === null ? 'insert_id' : 'edge_id', 'A surface scan is added to an insert or an edge: send insert_id or edge_id, not both and not neither.', candidateId);
  }
  const operationId = id('operation_id');
  const scannedOn = isBlank(item.scanned_on) ? null : item.scanned_on;
  if (scannedOn !== null && (typeof scannedOn !== 'string' || !isRealDay(scannedOn))) throw badField('scanned_on', 'scanned_on must be a day, YYYY-MM-DD.', candidateId);
  return {
    condition: item.condition, insertId, edgeId, operationId, scannedOn,
    conditionNote: note('condition_note', MAX_CONDITION_NOTE, 'The condition note'), notes: note('notes', MAX_SCAN_NOTES, 'The notes'),
  };
}

const intParam = (v, what, { min, max, fallback }) => {
  const t = text(v, what);
  if (t === null) return fallback;
  if (!/^-?\d+$/.test(t)) throw badInput(`${what} must be a whole number.`);
  const n = Number(t);
  if (n < min) throw badInput(`${what} must be at least ${min}.`);
  return Math.min(n, max);
};

// The filters of a list (query string) or of accept-all (an object), in the names STARbase's inboxApi.ts sends: tab, kind (comma list),
// strength (comma list), folder (text the folder part of rel_path contains), from and to (YYYY-MM-DD), owner ('me', 'team:<id>', and for an
// administrator 'person:<id>'), link_kind, limit and offset. Returns a clean object or throws 400.
// The keys parseFileFilters reads (a list's query string, accept-all's `filter`); any other key is ignored. The cross-stream contract test
// (contract.test.mjs) probes that each one changes the parse, and STARbase's tests check that the client sends no key outside this list.
export const FILTER_KEYS = ['tab', 'kind', 'strength', 'folder', 'from', 'to', 'owner', 'link_kind', 'acceptable', 'limit', 'offset'];
// The values the enumerated filters accept (for the same tests).
export const FILTER_VALUES = { tab: TABS, kind: ALL_KINDS, strength: STRENGTHS, link_kind: LINK_KINDS, max_limit: MAX_PAGE, default_limit: DEFAULT_PAGE };

export function parseFileFilters(source, { defaultTab = 'new' } = {}) {
  const q = source ?? {};
  if (!isObject(q)) throw badInput('The filter is not valid.');
  const tab = text(q.tab, 'tab') ?? defaultTab;
  if (!TABS.includes(tab)) throw badInput('Unknown tab.');
  const list = (v, what, allowed) => {
    const t = text(v, what);
    if (t === null) return null;
    const items = t.split(',').map((k) => k.trim()).filter(Boolean);
    if (!items.length || items.some((k) => !allowed.includes(k))) throw badInput(`Unknown ${what}.`);
    return [...new Set(items)];
  };
  const kinds = list(q.kind, 'kind', ALL_KINDS);
  const strengths = list(q.strength, 'match strength', STRENGTHS);
  const folder = text(q.folder, 'folder');
  const dateFrom = text(q.from, 'from');
  const dateTo = text(q.to, 'to');
  for (const [d, what] of [[dateFrom, 'from'], [dateTo, 'to']]) if (d !== null && !isRealDay(d)) throw badInput(`${what} must be a day, YYYY-MM-DD.`);
  let owner = null;
  const ownerText = text(q.owner, 'owner');
  if (ownerText !== null) {
    const m = /^(me|team|person)(?::(.+))?$/.exec(ownerText);
    if (!m || (m[1] === 'me') !== (m[2] === undefined) || (m[2] !== undefined && !isUuid(m[2]))) throw badInput('owner must be me, team:<id> or person:<id>.');
    owner = { kind: m[1], id: m[2]?.toLowerCase() ?? null };
  }
  const linkKind = text(q.link_kind, 'link_kind');
  if (linkKind !== null && !LINK_KINDS.includes(linkKind)) throw badInput('Unknown link kind.');
  const acceptableText = text(q.acceptable, 'acceptable');
  if (acceptableText !== null && !['1', '0', 'true', 'false'].includes(acceptableText)) throw badInput('acceptable must be 1 or 0.');
  return {
    tab, kinds, strengths, folder, date_from: dateFrom, date_to: dateTo, owner, link_kind: linkKind,
    acceptable: acceptableText === '1' || acceptableText === 'true',
    limit: intParam(q.limit, 'limit', { min: 1, max: MAX_PAGE, fallback: DEFAULT_PAGE }),
    offset: intParam(q.offset, 'offset', { min: 0, max: 1_000_000, fallback: 0 }),
  };
}

const LIST_SELECT = 'SELECT c.candidate_id, c.directus_files_id, f.filename_download AS name, f.type AS mime_type, c.kind, c.kind_confidence,'
  + ' c.extracted, c.origin, c.state, c.match_strength, c.matches, c.suggested_collection, c.suggested_record_id, c.duplicate_of,'
  + ' coalesce(cp.full_name, ct.name) AS duplicate_of_owner,'
  + ' c.rel_path, c.size_bytes, c.source_mtime, c.first_seen_at, c.decided_at, c.link_kind, c.linked_collection, c.link_batch_id,'
  + " coalesce(sj.sample_id, oj.operation_id, tj.session_id, CASE WHEN c.linked_collection = 'surface_scans' THEN c.linked_junction_id END) AS linked_record_id,"
  + " coalesce(nullif(btrim(coalesce(du.first_name, '') || ' ' || coalesce(du.last_name, '')), ''), du.email) AS decided_by_name,"
  + ' c.owner_person_id, c.owner_team_id, coalesce(op.full_name, ot.name) AS owner_name, c.adopted_at';
const LIST_FROM = ' FROM d1_private.file_candidates c'
  + ' LEFT JOIN directus_files f ON f.id = c.directus_files_id'
  + ' LEFT JOIN d1_private.file_candidates o ON o.candidate_id = c.duplicate_of'
  + ' LEFT JOIN people op ON op.person_id = c.owner_person_id LEFT JOIN teams ot ON ot.team_id = c.owner_team_id'
  + ' LEFT JOIN people cp ON cp.person_id = o.owner_person_id LEFT JOIN teams ct ON ct.team_id = o.owner_team_id'
  + ' LEFT JOIN directus_users du ON du.id = c.decided_by'
  + " LEFT JOIN sample_data_files sj ON c.linked_collection = 'physical_samples' AND sj.id = c.linked_junction_id"
  + " LEFT JOIN operation_data_files oj ON c.linked_collection = 'manufacturing_operations' AND oj.id = c.linked_junction_id"
  + " LEFT JOIN session_data_files tj ON c.linked_collection = 'test_sessions' AND tj.id = c.linked_junction_id";
const SLIM_FROM = ' FROM d1_private.file_candidates c LEFT JOIN d1_private.file_candidates o ON o.candidate_id = c.duplicate_of';

// The query for a list page ({ count: true }: its total; { accept: true }: the ids accept-all considers). Everything a client chose is a binding.
export function buildListQuery(scope, f, { count = false, accept = false, after = null, pageSize = ACCEPT_PAGE } = {}) {
  const where = [];
  const bindings = [];
  const mine = scope.personId !== null && scope.personId !== undefined;
  if (f.owner?.kind === 'me') { where.push('c.owner_person_id = ?'); bindings.push(mine ? scope.personId : null); }
  else if (f.owner?.kind === 'person') { where.push('c.owner_person_id = ?'); bindings.push(f.owner.id); }
  else if (f.owner?.kind === 'team') { where.push('c.owner_team_id = ?'); bindings.push(f.owner.id); }
  else {
    where.push(`(c.owner_person_id = ? OR c.owner_team_id = ANY(${IDS}))`);
    bindings.push(mine ? scope.personId : null, scope.teamIds.join(','));
  }
  if (f.tab === 'new') where.push("c.state = 'new'", "c.origin = 'new'", COPY_HIDDEN);
  else if (f.tab === 'older') where.push("c.state = 'new'", "c.origin = 'backlog'", COPY_HIDDEN);
  else if (f.tab === 'open') where.push("c.state = 'new'", COPY_HIDDEN);
  else where.push(`c.state = '${f.tab}'`); // linked or dismissed (validated by parseFileFilters)
  if (f.kinds) { where.push("c.kind = ANY(string_to_array(?, ','))"); bindings.push(f.kinds.join(',')); }
  if (f.strengths) { where.push("c.match_strength = ANY(string_to_array(?, ','))"); bindings.push(f.strengths.join(',')); }
  if (f.folder) { where.push("strpos(lower(regexp_replace(c.rel_path, '[^/]*$', '')), lower(?)) > 0"); bindings.push(f.folder); }
  if (f.date_from) { where.push('coalesce(c.source_mtime, c.first_seen_at) >= ?::date'); bindings.push(f.date_from); }
  if (f.date_to) { where.push('coalesce(c.source_mtime, c.first_seen_at) < (?::date + 1)'); bindings.push(f.date_to); }
  if (f.link_kind) { where.push('c.link_kind = ?'); bindings.push(f.link_kind); }
  if (accept) {
    // What accept-all can ever link: exact short ID naming one record, not a surface scan, not a copy, not already on its record
    where.push("c.state = 'new'", "c.match_strength = 'short_id'", 'c.suggested_record_id IS NOT NULL', "c.kind <> 'surface_scan'", 'c.duplicate_of IS NULL',
      'jsonb_array_length(c.matches) = 1', NOT_ON_RECORD);
    if (after) { where.push('(c.first_seen_at, c.candidate_id) > (?::timestamptz, ?::uuid)'); bindings.push(after.at, after.id); }
    const size = Math.max(1, Math.floor(Number(pageSize)) || ACCEPT_PAGE);
    return { sql: `SELECT c.candidate_id, c.first_seen_at${SLIM_FROM} WHERE ${where.join(' AND ')} ORDER BY c.first_seen_at, c.candidate_id LIMIT ${size}`, bindings };
  }
  if (count) return { sql: `SELECT count(*)::int AS total${SLIM_FROM} WHERE ${where.join(' AND ')}`, bindings };
  const order = f.tab === 'linked' || f.tab === 'dismissed'
    ? 'ORDER BY c.decided_at DESC NULLS LAST, c.candidate_id'
    : 'ORDER BY c.first_seen_at DESC, c.candidate_id';
  return { sql: `${LIST_SELECT}${LIST_FROM} WHERE ${where.join(' AND ')} ${order} LIMIT ? OFFSET ?`, bindings: [...bindings, f.limit, f.offset] };
}

// The grouped counts of the summary query as the answer, in the shape STARbase's inboxSummary.ts reads: the person's (with has_alias), and each
// team's that has a share folder. `older_matches` = backlog files that name exactly one record by short ID or code.
export function shapeSummary(rows, scope, teams, person) {
  const sum = (match, want) => rows.filter(match).reduce((total, r) => total + (want(r) ? Number(r.n) : 0), 0);
  const counts = (match) => ({
    new: sum(match, (r) => r.origin === 'new'),
    older_matches: sum(match, (r) => r.origin === 'backlog' && r.exact === true),
  });
  const mine = scope.personId
    ? { person_id: scope.personId, ...counts((r) => r.owner_person_id === scope.personId), has_alias: !isBlank(person?.uni_alias) }
    : null;
  const teamOut = teams.filter((t) => !('share_folder' in t) || !isBlank(t.share_folder))
    .map((t) => ({ team_id: t.team_id, name: t.name, ...counts((r) => r.owner_team_id === t.team_id) }));
  const all = [mine, ...teamOut].filter(Boolean);
  return {
    person: mine,
    teams: teamOut,
    new: all.reduce((total, c) => total + c.new, 0),
    older_matches: all.reduce((total, c) => total + c.older_matches, 0),
  };
}

// $CURRENT_USER anywhere in a filter (ItemsService does not substitute it, the REST layer does).
function substitute(node, user) {
  if (node === CURRENT_USER) return user;
  if (Array.isArray(node)) return node.map((item) => substitute(item, user));
  if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, user)]));
  return node;
}

// One row of the list as STARbase's FoundFile (inboxApi.ts): the file_candidates columns it uses plus resolved labels. A record is named only to
// a caller who can READ it (`info.readable`, a set of "collection:id"; its code is in `info.labels`); for any other the suggestion, the matches
// and the linked record are left empty, so no id of a Restricted record leaks. `suggested_can_edit` says whether Link would pass.
export function fileOut(row, info) {
  const matches = Array.isArray(asJson(row.matches)) ? asJson(row.matches) : [];
  const key = (collection, id) => `${collection}:${id}`;
  const seen = (collection, id) => Boolean(id) && info.readable.has(key(collection, id));
  const suggested = seen(row.suggested_collection, row.suggested_record_id);
  const linked = seen(row.linked_collection, row.linked_record_id);
  const out = {
    candidate_id: row.candidate_id,
    directus_files_id: row.directus_files_id,
    name: row.name ?? String(row.rel_path ?? '').split('/').pop(),
    mime_type: row.mime_type ?? null,
    kind: row.kind,
    kind_confidence: num(row.kind_confidence),
    extracted: asJson(row.extracted) ?? {},
    origin: row.origin,
    state: row.state,
    match_strength: row.match_strength,
    matches: matches.filter((m) => seen(m.collection, m.record_id)),
    suggested_collection: suggested ? row.suggested_collection : null,
    suggested_record_id: suggested ? row.suggested_record_id : null,
    suggested_label: suggested ? (info.labels.get(key(row.suggested_collection, row.suggested_record_id)) ?? null) : null,
    duplicate_of: row.duplicate_of ?? null,
    duplicate_of_owner: row.duplicate_of ? (row.duplicate_of_owner ?? null) : null,
    rel_path: row.rel_path,
    size_bytes: num(row.size_bytes),
    source_mtime: toIso(row.source_mtime),
    first_seen_at: toIso(row.first_seen_at),
    decided_at: toIso(row.decided_at),
    link_kind: row.link_kind ?? null,
    link_batch_id: row.link_batch_id ?? null,
    linked_collection: linked ? row.linked_collection : null,
    linked_record_id: linked ? row.linked_record_id : null,
    linked_label: linked ? (info.labels.get(key(row.linked_collection, row.linked_record_id)) ?? null) : null,
    decided_by_name: row.decided_by_name ?? null,
    owner: row.owner_person_id
      ? { kind: 'person', id: row.owner_person_id, name: row.owner_name ?? '' }
      : { kind: 'team', id: row.owner_team_id, name: row.owner_name ?? '' },
    adopted: row.adopted_at !== null && row.adopted_at !== undefined,
  };
  // A row added as a surface scan also says which insert or edge it went to (the client links to that page).
  if (linked && row.linked_collection === SURFACE_SCANS) {
    const scan = info.scans?.get(String(row.linked_record_id));
    out.linked_insert_id = scan?.insert_id ?? null;
    out.linked_edge_id = scan?.edge_id ?? null;
  }
  if (suggested) out.suggested_can_edit = info.editable.has(key(row.suggested_collection, row.suggested_record_id));
  return out;
}

// Why accept-all (and auto-link) would not link a candidate, or null when the candidate qualifies on its own data.
export const unfit = (cand, { auto }) => {
  if (cand.state !== 'new') return 'NOT_NEW';
  if (auto && cand.owner_team_id) return 'TEAM_FILE';
  if (cand.duplicate_of) return 'COPY';
  if (auto && cand.origin === 'backlog') return 'BACKLOG';
  // a surface scan is ADDED to an insert or edge with a condition only a person chooses (stream F1): never accepted in bulk, never automatic
  if (cand.kind === 'surface_scan') return 'SURFACE_SCAN';
  if (auto && !AUTO_KINDS.includes(cand.kind)) return 'KIND_NOT_ALLOWED';
  if (cand.match_strength !== 'short_id') return 'NOT_EXACT';
  const matches = asJson(cand.matches);
  // two or more records named: never a suggestion (the crawler leaves suggested_* null, but a row that says otherwise is still refused), in bulk too (D9)
  if (Array.isArray(matches) && matches.length > 1) return 'AMBIGUOUS';
  if (!cand.suggested_record_id || !cand.suggested_collection) return 'NO_SUGGESTION';
  if (!Array.isArray(matches) || matches.length !== 1 || matches[0].record_id !== cand.suggested_record_id || matches[0].collection !== cand.suggested_collection) return 'AMBIGUOUS';
  if (!isTarget(cand.suggested_collection)) return 'COLLECTION_NOT_SUPPORTED';
  return null;
};

// ---- the answers, as the typed client in STARbase reads them ---------------------------------------------------------------------
// One function per route's body (the routes call these; contract_fixtures.mjs writes their output to tests/fixtures/d1-inbox/ for the client's tests).

const skippedOut = (skipped) => ({ skipped: skipped.slice(0, SKIPPED_SHOWN), skipped_total: skipped.length });

// POST /link: { link_batch_id | null, newly, items }
export const shapeLink = (out) => ({ link_batch_id: out.link_batch_id, linked: out.newly, items: out.items });
// POST /accept-all, dry run: found = { entries: [{ cand }], skipped, has_more, next_cursor }
export const shapeAcceptDryRun = (found) => ({
  count: found.entries.length, ids: found.entries.map((e) => e.cand.candidate_id), ...skippedOut(found.skipped), has_more: found.has_more, next_cursor: found.next_cursor, dry_run: true,
});
// POST /accept-all, real run: out = { batchId | null, items, skipped, has_more, next_cursor }
export const shapeAcceptAll = (out) => ({
  link_batch_id: out.batchId, linked: out.items.length, items: out.items, ...skippedOut(out.skipped), has_more: out.has_more, next_cursor: out.next_cursor,
});
// POST /dismiss | /restore
export const shapeStateChange = ({ done, unchanged, change }) => ({
  changed: done.length, changed_ids: done, unchanged_ids: [...unchanged, ...change.filter((id) => !done.includes(id))],
});
// POST /undo
export const shapeUndo = (batch, done) => ({ link_batch_id: batch.toLowerCase(), undone: done.length });
// POST /rescan and /admin/scan-all (202)
export const shapeQueued = (row) => ({ queued: true, request_id: row.request_id, status: row.status, requested_at: toIso(row.requested_at) });
// GET and PUT /prefs
export const shapePrefs = (row) => ({ auto_link: row?.auto_link === true });
// The error body of every refusal (Directus's shape); an unknown error is a 500 that says nothing of its cause.
export function shapeError(err) {
  const known = err instanceof HttpError;
  return {
    status: known ? err.status : 500,
    body: {
      errors: [{
        message: known ? err.message : 'Something went wrong on the server.',
        extensions: { ...(known ? err.extra : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
      }],
    },
  };
}
// GET /admin. rows = { state, people, totals, failed, queue }; now = the clock.
export function shapeAdmin({ state, people, totals, failed, queue }, now) {
  const s = state ?? {};
  const beat = s.last_heartbeat_at ? new Date(s.last_heartbeat_at).getTime() : null;
  // never or stale FIRST: a daemon that stopped heartbeating is not "paused" just because its desired state says so
  const daemon = beat === null ? 'never' : now.getTime() - beat > DAEMON_STALE_MS ? 'stale' : s.desired_state === 'paused' ? 'paused' : 'alive';
  const unmatched = asJson(s.unmatched_folders);
  // recent failures: the daemon's last error (its time is when the last scan ended) and the failed scan requests
  const errors = [
    ...(s.last_error ? [{ at: toIso(s.last_scan_finished_at ?? s.last_heartbeat_at), message: s.last_error }] : []),
    ...failed.filter((r) => r.error).map((r) => ({ at: toIso(r.at), message: r.error })),
  ];
  const waiting = (num(queue?.queued) ?? 0) + (num(queue?.running) ?? 0);
  return {
    status: {
      desired_state: s.desired_state ?? null, interval_minutes: num(s.interval_minutes), read_mb_per_s: num(s.read_mb_per_s), daemon,
      last_heartbeat_at: toIso(s.last_heartbeat_at), daemon_started_at: toIso(s.daemon_started_at), current_activity: s.current_activity ?? null,
      last_scan_started_at: toIso(s.last_scan_started_at), last_scan_finished_at: toIso(s.last_scan_finished_at),
      files_registered: num(s.files_registered) ?? 0, error_count: num(s.error_count) ?? 0, last_error: s.last_error ?? null,
    },
    errors,
    unmatched_folders: Array.isArray(unmatched) ? unmatched : [],
    people_without_alias: people.map((p) => ({ person_id: p.person_id, full_name: p.full_name, active: p.active !== false, has_login: p.has_login === true })),
    queued_requests: waiting,
    queue: { queued: num(queue?.queued) ?? 0, running: num(queue?.running) ?? 0 },
    candidates: Object.fromEntries(totals.map((t) => [t.state, Number(t.n)])),
  };
}
// GET /files: the rows as FoundFile and the paging meta.
export const shapeFiles = (rows, info, { total, limit, offset, acceptable }) => ({
  data: rows.map((r) => fileOut(r, info)), meta: { total: Number(total), limit, offset, acceptable },
});

// ---- the endpoint ----------------------------------------------------------------------------------------------------------

export function mount(router, context, deps = {}) {
  const { database, logger, services, getSchema, env } = context;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.uuid ?? (() => randomUUID());
  // A secret under 32 characters is as good as none (fail closed): auto-link refuses every call. openssl rand -hex 32 makes 64.
  const configured = typeof env?.D1_INBOX_CRAWLER_SECRET === 'string' ? env.D1_INBOX_CRAWLER_SECRET : '';
  const secret = configured.length >= MIN_SECRET_LENGTH ? configured : '';
  if (secret === '') logger?.warn?.(`${SOURCE}: D1_INBOX_CRAWLER_SECRET is not set or shorter than ${MIN_SECRET_LENGTH} characters, so POST /d1-inbox/auto-link refuses every call`);

  const sendError = (res, err) => {
    const known = err instanceof HttpError;
    if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    if (known && err.status === 429 && err.extra.retry_after_seconds) res.setHeader?.('Retry-After', String(err.extra.retry_after_seconds));
    const shaped = shapeError(err);
    return res.status(shaped.status).json(shaped.body);
  };
  // A person's route: needs a signed-in user; a Lab Viewer changes nothing (every write is refused first).
  const route = (fn) => async (req, res) => {
    try {
      const acc = req.accountability;
      if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
      if (isWriteRequest(req) && isViewerAccountability(acc)) throw ERRORS.readOnly();
      await fn({ req, res, acc });
    } catch (err) {
      sendError(res, err);
    }
  };
  const adminRoute = (fn) => route(async (ctx) => {
    if (ctx.acc.admin !== true) throw ERRORS.adminOnly();
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

  // Does the surface_scans table exist (stream F1)? One information_schema read, and a yes is remembered (a table does not go away).
  let scansKnown = false;
  async function scanTableAvailable(db = database) {
    if (scansKnown) return true;
    const [row] = rowsOf(await db.raw(SQL.scanTableExists, []));
    scansKnown = row?.available === true;
    return scansKnown;
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
    if (f.owner?.kind === 'person' && f.owner.id !== scope.personId) throw new HttpError(403, 'FORBIDDEN', 'That folder is not yours.');
    if (f.owner?.kind === 'team' && !scope.teamIds.includes(f.owner.id)) throw new HttpError(403, 'FORBIDDEN', 'That folder is not your team\'s.');
  };
  const requireIds = (v, what, max = MAX_BATCH) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > max || v.some((id) => !isUuid(id))) {
      throw badInput(`${what} must be 1 to ${max} ids.`);
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
  // What the page may NAME of the records its rows point at: which the caller can READ (the real read rule, as the caller) and their codes
  // ("S-0042"), and which of those they can edit. Nothing is read for a record the caller cannot read, so nothing of it is returned.
  async function recordInfo(db, acc, schema, pairs, editPairs) {
    const by = new Map();
    for (const [collection, id] of pairs) if (isTarget(collection) && isUuid(id)) (by.get(collection) ?? by.set(collection, new Set()).get(collection)).add(String(id));
    const readable = new Set();
    const labels = new Map();
    for (const [collection, ids] of by) {
      const target = LINK_TARGETS[collection];
      try {
        const rows = await itemsFor(schema, acc, collection).readByQuery({ fields: [target.pk, target.code], filter: { [target.pk]: { _in: [...ids] } }, limit: ids.size });
        for (const r of rows) {
          readable.add(`${collection}:${r[target.pk]}`);
          labels.set(`${collection}:${r[target.pk]}`, r[target.code] ?? null);
        }
      } catch (err) {
        if (!isDenied(err)) throw err;
      }
    }
    // A surface scan a row was added as: readable by the caller (reference data) or not named; its label is the insert or edge code and the condition.
    const scans = new Map();
    const scanIds = [...new Set(pairs.filter(([c, id]) => c === SURFACE_SCANS && isUuid(id)).map(([, id]) => String(id)))];
    if (scanIds.length) {
      try {
        const rows = await itemsFor(schema, acc, SURFACE_SCANS).readByQuery({
          fields: ['scan_id', 'condition', 'insert_id.insert_id', 'insert_id.insert_code', 'edge_id.edge_id', 'edge_id.edge_code'],
          filter: { scan_id: { _in: scanIds } },
          limit: scanIds.length,
        });
        for (const r of rows) {
          const code = r.insert_id?.insert_code ?? r.edge_id?.edge_code ?? null;
          const key = `${SURFACE_SCANS}:${r.scan_id}`;
          readable.add(key);
          labels.set(key, code ? `${code} (${r.condition})` : r.condition ?? null);
          scans.set(String(r.scan_id), { insert_id: r.insert_id?.insert_id ?? null, edge_id: r.edge_id?.edge_id ?? null });
        }
      } catch (err) {
        if (!isDenied(err)) throw err;
      }
    }
    // the edit check only for the records a row SUGGESTS (a linked record or a lesser match needs none)
    const editable = await editableSet(db, acc, schema, editPairs.filter(([c, id]) => readable.has(`${c}:${id}`)));
    return { readable, labels, editable, scans };
  }

  // -- linking -------------------------------------------------------------------------------------------------------------------

  // Which of `entries` ({ collection, recordId, fileId }) are ALREADY linked: one query per collection. Returns a set of "collection:record:file".
  async function existingLinks(db, entries) {
    const by = new Map();
    for (const e of entries) (by.get(e.collection) ?? by.set(e.collection, []).get(e.collection)).push(e);
    const found = new Set();
    for (const [collection, list] of by) {
      const rows = rowsOf(await db.raw(SQL.junctionFindMany[collection], [list.map((e) => e.recordId).join(','), list.map((e) => e.fileId).join(',')]));
      for (const r of rows) found.add(`${collection}:${r.record_id}:${r.directus_files_id}`);
    }
    return found;
  }
  const linkKey = (collection, recordId, fileId) => `${collection}:${recordId}:${fileId}`;

  // Reads the insert, edge or operation a scan names as the caller (their read permission and row rules apply): a record that is not there and one
  // the caller cannot see are the same 404, so no id is confirmed; a collection the caller may not read at all is Directus's 403.
  async function requireScanRefs(trx, { acc, schema, entries }) {
    for (const { cand, scan } of entries.filter((e) => e.collection === SURFACE_SCANS)) {
      for (const [column, value] of [['insert_id', scan.insertId], ['edge_id', scan.edgeId], ['operation_id', scan.operationId]]) {
        if (value === null) continue;
        const ref = SCAN_REFS[column];
        let rows;
        try {
          rows = await itemsFor(schema, acc, ref.collection, trx).readByQuery({ fields: [ref.pk], filter: { [ref.pk]: { _eq: value } }, limit: 1 });
        } catch (err) {
          if (isDenied(err)) throw ERRORS.scanNotAllowed(cand.candidate_id);
          throw err;
        }
        if (!rows.length) throw ERRORS.scanRefMissing(cand.candidate_id, ref.what, value);
      }
    }
  }

  // The row of one surface scan, created through ItemsService as the caller inside the open transaction (permissions and hooks apply: d1-owner-default
  // sets the owner). ONLY the fields the contract lets a Lab Member send; the worker's render_*, cache_key, source_*, grid_*, pixel_pitch_* and z_* columns
  // are never sent (render_status then takes its default 'pending', which queues the render). Returns the new scan_id.
  async function createScan(trx, { acc, schema, cand, scan }) {
    const data = {
      ...(scan.insertId !== null ? { insert_id: scan.insertId } : { edge_id: scan.edgeId }),
      directus_files_id: cand.directus_files_id,
      condition: scan.condition,
      ...(scan.conditionNote !== null ? { condition_note: scan.conditionNote } : {}),
      ...(scan.scannedOn !== null ? { scanned_on: scan.scannedOn } : {}),
      ...(scan.operationId !== null ? { operation_id: scan.operationId } : {}),
      ...(scan.notes !== null ? { notes: scan.notes } : {}),
    };
    try {
      return await itemsFor(schema, acc, SURFACE_SCANS, trx).createOne(data);
    } catch (err) {
      if (isUnique(err)) throw ERRORS.alreadyAdded(cand.candidate_id);
      if (isDenied(err)) throw ERRORS.scanNotAllowed(cand.candidate_id);
      if (err?.code === 'INVALID_FOREIGN_KEY' || err?.code === '23503') throw new HttpError(404, 'NOT_FOUND', 'That insert, edge, operation or file no longer exists.', { candidate_id: cand.candidate_id });
      if (err?.status === 400 && typeof err.message === 'string') throw badInput(err.message);
      throw err;
    }
  }

  // Writes the links of `entries` ({ cand, collection, recordId } or, for a surface scan, { cand, collection: 'surface_scans', scan }) in the open
  // transaction: the junction row (or the scan row) as the caller, then the candidate. The caller has already locked the candidates, checked their state
  // and the edit rights.
  async function performLink(trx, { acc, schema, entries, linkKind, batchId }) {
    const linked = [];
    for (const { cand, collection, recordId, scan } of entries) {
      let junctionId;
      if (collection === SURFACE_SCANS) {
        junctionId = await createScan(trx, { acc, schema, cand, scan });
      } else {
        const target = LINK_TARGETS[collection];
        try {
          junctionId = await itemsFor(schema, acc, target.junction, trx).createOne({ [target.fk]: recordId, directus_files_id: cand.directus_files_id });
        } catch (err) {
          if (isUnique(err)) throw ERRORS.alreadyOnRecord(cand.candidate_id);
          if (isDenied(err)) throw ERRORS.notEditable(cand.candidate_id, collection, recordId);
          throw err;
        }
      }
      const adopt = !IMAGE_KINDS.includes(cand.kind);
      const done = rowsOf(await trx.raw(SQL.markLinked, [acc.user, linkKind, collection, junctionId, batchId, adopt, cand.candidate_id]));
      if (!done.length) throw ERRORS.dealtWith(cand.candidate_id);
      linked.push(collection === SURFACE_SCANS
        ? { candidate_id: cand.candidate_id, collection, record_id: junctionId, junction_id: junctionId, insert_id: scan.insertId, edge_id: scan.edgeId, adopted: adopt }
        : { candidate_id: cand.candidate_id, collection, record_id: recordId, junction_id: junctionId, adopted: adopt });
    }
    return linked;
  }

  router.post('/link', route(async ({ req, res, acc }) => {
    const body = bodyOf(req);
    const items = body?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) throw badInput(`items must be 1 to ${MAX_BATCH} links.`);
    const wanted = [];
    for (const item of items) {
      if (isObject(item) && isUuid(item.candidate_id) && item.collection === SURFACE_SCANS) {
        wanted.push({ id: item.candidate_id.toLowerCase(), collection: SURFACE_SCANS, recordId: null, scan: parseScanItem(item) });
        continue;
      }
      if (!isObject(item) || !isUuid(item.candidate_id) || !isUuid(item.record_id) || !isTarget(item.collection)) {
        throw badInput('Each link needs a candidate_id, a collection (physical_samples, manufacturing_operations or test_sessions) and a record_id;'
          + ' a surface scan needs a candidate_id, collection surface_scans, an insert_id or an edge_id, and a condition.');
      }
      wanted.push({ id: item.candidate_id.toLowerCase(), collection: item.collection, recordId: item.record_id.toLowerCase() });
    }
    if (new Set(wanted.map((w) => w.id)).size !== wanted.length) throw badInput('A file can only be linked once in one request.');
    if (wanted.some((w) => w.collection === SURFACE_SCANS) && !(await scanTableAvailable())) throw ERRORS.scansUnavailable();
    const schema = await schemaOf(req);
    const scope = await scopeOf(acc);
    const linkKind = wanted.length === 1 ? 'manual' : 'bulk';
    const out = await inTransaction(acc.user, async (trx) => {
      const rows = new Map(rowsOf(await trx.raw(SQL.candidatesForUpdate, [wanted.map((w) => w.id).join(',')])).map((r) => [r.candidate_id, r]));
      const fresh = [];
      const again = [];
      for (const w of wanted) {
        const cand = rows.get(w.id);
        if (!cand || !canSee(scope, cand)) throw ERRORS.notInInbox(w.id);
        if (cand.state === 'new') {
          // a surface scan is ADDED to an insert or edge with a person-chosen condition (stream F1), never linked to a sample, operation or test;
          // and only a surface scan is added that way
          if (w.collection === SURFACE_SCANS) {
            if (cand.kind !== 'surface_scan') throw ERRORS.notASurfaceScan(w.id);
          } else if (cand.kind === 'surface_scan') {
            throw ERRORS.surfaceScan(w.id);
          }
          fresh.push({ cand, collection: w.collection, recordId: w.recordId, scan: w.scan });
          continue;
        }
        if (cand.state === 'linked') {
          // the same person repeating the same link (or the same surface scan add): nothing more to do
          const mine = cand.decided_by === acc.user && cand.linked_collection === w.collection && cand.linked_junction_id;
          if (mine && w.collection === SURFACE_SCANS) {
            const [scanRow] = rowsOf(await trx.raw(SQL.scanById, [cand.linked_junction_id]));
            if (!scanRow || (scanRow.insert_id ?? null) !== w.scan.insertId || (scanRow.edge_id ?? null) !== w.scan.edgeId) throw ERRORS.alreadyLinked(w.id);
            again.push({
              candidate_id: w.id, collection: w.collection, record_id: cand.linked_junction_id, junction_id: cand.linked_junction_id,
              insert_id: w.scan.insertId, edge_id: w.scan.edgeId, adopted: false, already_linked: true,
            });
            continue;
          }
          const same = mine && w.collection !== SURFACE_SCANS
            && rowsOf(await trx.raw(SQL.junctionById[w.collection], [cand.linked_junction_id]))[0]?.record_id === w.recordId;
          if (!same) throw ERRORS.alreadyLinked(w.id);
          again.push({ candidate_id: w.id, collection: w.collection, record_id: w.recordId, junction_id: cand.linked_junction_id, adopted: !IMAGE_KINDS.includes(cand.kind), already_linked: true });
          continue;
        }
        if (cand.state === 'gone') throw new HttpError(409, 'FILE_GONE', 'That file is no longer on the share.', { candidate_id: w.id });
        throw new HttpError(409, 'NOT_NEW', 'Restore that file before linking it.', { candidate_id: w.id });
      }
      // The edit check, before anything is written: all or nothing.
      // (a surface scan has no record-edit rule: Directus's own create permission on surface_scans decides, and the records it names are read as the caller)
      const links = fresh.filter((e) => e.collection !== SURFACE_SCANS);
      const editable = await editableSet(trx, acc, schema, links.map((e) => [e.collection, e.recordId]));
      for (const e of links) if (!editable.has(`${e.collection}:${e.recordId}`)) throw ERRORS.notEditable(e.cand.candidate_id, e.collection, e.recordId);
      const there = await existingLinks(trx, links.map((e) => ({ collection: e.collection, recordId: e.recordId, fileId: e.cand.directus_files_id })));
      for (const e of links) if (there.has(linkKey(e.collection, e.recordId, e.cand.directus_files_id))) throw ERRORS.alreadyOnRecord(e.cand.candidate_id);
      await requireScanRefs(trx, { acc, schema, entries: fresh });
      // nothing newly linked (the same person repeating a link): no batch, a count of 0, never the old batch id
      const batchId = fresh.length ? newId() : null;
      const linked = fresh.length ? await performLink(trx, { acc, schema, entries: fresh, linkKind, batchId }) : [];
      return { link_batch_id: batchId, newly: linked.length, items: [...linked, ...again], wrote: fresh.length > 0 };
    });
    if (out.wrote) await clearDataCache(schema);
    res.json({ data: shapeLink(out) });
  }));

  // A keyset cursor is { at, id } of the last row read, passed around as base64url JSON.
  const encodeCursor = (row) => Buffer.from(JSON.stringify([toIso(row.first_seen_at), row.candidate_id])).toString('base64url');
  function decodeCursor(text) {
    if (text === undefined || text === null || text === '') return null;
    try {
      const [at, id] = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
      if (typeof at === 'string' && !Number.isNaN(new Date(at).getTime()) && isUuid(id)) return { at, id };
    } catch { /* falls through */ }
    throw badInput('cursor is not valid.');
  }
  const acceptPage = deps.acceptPage ?? ACCEPT_PAGE;
  const acceptMaxPages = deps.acceptMaxPages ?? ACCEPT_MAX_PAGES;

  // Sorts `cands` (candidate rows, already locked or read) into what accept-all links (`entries`) and what it leaves (`skipped`, with a reason):
  // the candidate's own data, then what the caller may edit (one read a collection), then what is already on its record (one query a collection).
  async function classify(db, { acc, schema, scope, cands }) {
    const skipped = [];
    const fit = [];
    for (const cand of cands) {
      if (!canSee(scope, cand)) continue;
      const why = unfit(cand, { auto: false });
      if (why) skipped.push({ candidate_id: cand.candidate_id, reason: why });
      else fit.push(cand);
    }
    const editable = await editableSet(db, acc, schema, fit.map((c) => [c.suggested_collection, c.suggested_record_id]));
    const editableFit = [];
    for (const cand of fit) {
      if (editable.has(`${cand.suggested_collection}:${cand.suggested_record_id}`)) editableFit.push(cand);
      else skipped.push({ candidate_id: cand.candidate_id, reason: 'NOT_EDITABLE' });
    }
    const there = await existingLinks(db, editableFit.map((c) => ({ collection: c.suggested_collection, recordId: c.suggested_record_id, fileId: c.directus_files_id })));
    const entries = [];
    for (const cand of editableFit) {
      if (there.has(linkKey(cand.suggested_collection, cand.suggested_record_id, cand.directus_files_id))) skipped.push({ candidate_id: cand.candidate_id, reason: 'ALREADY_ON_RECORD' });
      else entries.push({ cand, collection: cand.suggested_collection, recordId: cand.suggested_record_id });
    }
    return { entries, skipped };
  }

  // What accept-all would do. With `ids` (the candidate ids of an earlier preview) exactly those are re-checked, nothing is selected. Otherwise it
  // reads the filter's candidates a page at a time from `cursor`, until it has enough to link, has read its page cap, or runs out; `has_more` says
  // whether rows may remain (the last page was full), and `next_cursor` carries on. `lock` takes the row locks of a real run.
  async function planAccept(db, { acc, schema, scope, f, lock, ids = null, cursor = null }) {
    if (ids) {
      const rows = new Map(rowsOf(await db.raw(lock ? SQL.candidatesForUpdate : SQL.candidatesById, [ids.join(',')])).map((r) => [r.candidate_id, r]));
      const missing = ids.filter((id) => !rows.get(id) || !canSee(scope, rows.get(id))).map((id) => ({ candidate_id: id, reason: 'NOT_FOUND' }));
      const planned = await classify(db, { acc, schema, scope, cands: ids.map((id) => rows.get(id)).filter(Boolean) });
      return { entries: planned.entries, skipped: [...planned.skipped, ...missing], has_more: false, next_cursor: null };
    }
    const entries = [];
    const skipped = [];
    let after = cursor;
    let exhausted = false;
    let last = null;
    for (let page = 0; page < acceptMaxPages; page += 1) {
      const query = buildListQuery(scope, f, { accept: true, after, pageSize: acceptPage });
      const found = rowsOf(await db.raw(query.sql, query.bindings));
      if (found.length) {
        const cands = rowsOf(await db.raw(lock ? SQL.candidatesForUpdate : SQL.candidatesById, [found.map((r) => r.candidate_id).join(',')]));
        const planned = await classify(db, { acc, schema, scope, cands });
        entries.push(...planned.entries);
        skipped.push(...planned.skipped);
        last = found[found.length - 1];
        after = { at: toIso(last.first_seen_at), id: last.candidate_id };
      }
      if (found.length < acceptPage) { exhausted = true; break; }
      if (entries.length >= ACCEPT_MAX_ENTRIES) break;
    }
    return { entries, skipped, has_more: !exhausted, next_cursor: exhausted || !last ? null : encodeCursor(last) };
  }
  router.post('/accept-all', route(async ({ req, res, acc }) => {
    const body = req.body === undefined || req.body === null ? {} : bodyOf(req);
    if (!body) throw badInput('The request is not valid.');
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') throw badInput('dry_run must be true or false.');
    const f = parseFileFilters(body.filter, { defaultTab: 'open' });
    const cursor = decodeCursor(body.cursor);
    const ids = body.candidate_ids === undefined ? null : requireIds(body.candidate_ids, 'candidate_ids', ACCEPT_MAX_IDS);
    const schema = await schemaOf(req);
    const scope = await scopeOf(acc);
    requireOwnerVisible(scope, f);
    if (body.dry_run === true) {
      const found = await planAccept(database, { acc, schema, scope, f, lock: false, ids, cursor });
      res.json({ data: shapeAcceptDryRun(found) });
      return;
    }
    const out = await inTransaction(acc.user, async (trx) => {
      const found = await planAccept(trx, { acc, schema, scope, f, lock: true, ids, cursor });
      if (!found.entries.length) return { ...found, batchId: null, items: [] };
      const batchId = newId();
      return { ...found, batchId, items: await performLink(trx, { acc, schema, entries: found.entries, linkKind: 'bulk', batchId }) };
    });
    if (out.batchId) await clearDataCache(schema);
    res.json({ data: shapeAcceptAll(out) });
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
        if (!cand || !canSee(scope, cand)) throw ERRORS.notInInbox(id);
        if (cand.state === from) change.push(id);
        else if (cand.state === to) unchanged.push(id);
        else throw new HttpError(409, refusal.code, refusal.message, { candidate_id: id });
      }
      const done = change.length ? rowsOf(await trx.raw(SQL[name], name === 'dismiss' ? [acc.user, change.join(',')] : [change.join(',')])).map((r) => r.candidate_id) : [];
      return shapeStateChange({ done, unchanged, change });
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
        // A surface scan this batch added: only that row, and only while it still holds the file it was made for, deleted as the caller (the member
        // delete permission of surface_scans applies; never an administrator's). A caller who may not delete gets 403 and nothing is undone.
        if (row.linked_collection === SURFACE_SCANS && row.linked_junction_id) {
          if (!(await scanTableAvailable(trx))) continue;
          const [scanRow] = rowsOf(await trx.raw(SQL.scanById, [row.linked_junction_id]));
          if (!scanRow || scanRow.directus_files_id !== row.directus_files_id) continue;
          try {
            await itemsFor(schema, acc, SURFACE_SCANS, trx).deleteOne(row.linked_junction_id);
          } catch (err) {
            if (isDenied(err)) throw ERRORS.scanUndoDenied(row.candidate_id);
            throw err;
          }
          continue;
        }
        // Only the junction row this batch created, and only if it is still there (someone may have removed it in Data Studio meanwhile).
        if (!row.linked_junction_id || !isTarget(row.linked_collection)) continue;
        const stillThere = rowsOf(await trx.raw(SQL.junctionById[row.linked_collection], [row.linked_junction_id]))[0];
        // gone, or repointed at another file in Data Studio since: not this batch's row any more, leave it alone
        if (!stillThere || stillThere.directus_files_id !== row.directus_files_id) continue;
        try {
          await itemsFor(schema, acc, LINK_TARGETS[row.linked_collection].junction, trx).deleteOne(row.linked_junction_id);
        } catch (err) {
          if (isDenied(err)) throw new HttpError(403, 'FORBIDDEN', 'You can no longer change that record, so this link cannot be undone.', { candidate_id: row.candidate_id });
          throw err;
        }
      }
      const done = rowsOf(await trx.raw(SQL.resetBatch, [rows.map((r) => r.candidate_id).join(','), batch.toLowerCase()]));
      return shapeUndo(batch, done);
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
    const schema = await schemaOf(req);
    const page = buildListQuery(scope, f);
    const total = buildListQuery(scope, f, { count: true });
    const rows = (rowsOf(await database.raw(page.sql, page.bindings)));
    const [{ total: count } = { total: 0 }] = rowsOf(await database.raw(total.sql, total.bindings));
    const pairs = rows.flatMap((r) => [
      [r.suggested_collection, r.suggested_record_id], [r.linked_collection, r.linked_record_id],
      ...(Array.isArray(asJson(r.matches)) ? asJson(r.matches) : []).map((m) => [m.collection, m.record_id]),
    ]);
    const info = await recordInfo(database, acc, schema, pairs, rows.filter((r) => r.state === 'new').map((r) => [r.suggested_collection, r.suggested_record_id]));
    // how many of the rows this filter matches Accept all would link (the same plan, nothing locked or written)
    // only when asked for (acceptable=1): it reads candidates and checks edit rights, which a plain list load must not do
    const open = f.tab === 'new' || f.tab === 'older' || f.tab === 'open';
    const acceptable = f.acceptable && open ? (await planAccept(database, { acc, schema, scope, f, lock: false })).entries.length : null;
    res.json(shapeFiles(rows, info, { total: count, limit: f.limit, offset: f.offset, acceptable }));
  }));

  // -- rescan, prefs ----------------------------------------------------------------------------------------------------------

  router.post('/rescan', route(async ({ res, acc }) => {
    const scope = await scopeOf(acc);
    const hasFolder = Boolean(scope.person?.uni_alias) || scope.teams.some((t) => !isBlank(t.share_folder));
    if (!scope.personId || !hasFolder) {
      throw ERRORS.noFolder();
    }
    const limited = rateLimited;
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
    res.status(202).json({ data: shapeQueued(out) });
  }));

  router.get('/prefs', route(async ({ res, acc }) => {
    const [row] = rowsOf(await database.raw(SQL.prefsGet, [acc.user]));
    res.json({ data: shapePrefs(row) });
  }));

  router.put('/prefs', route(async ({ req, res, acc }) => {
    const body = bodyOf(req);
    if (!body || Object.keys(body).length !== 1 || typeof body.auto_link !== 'boolean') throw badInput('The request must be { "auto_link": true or false }.');
    const row = await inTransaction(acc.user, async (trx) => rowsOf(await trx.raw(SQL.prefsPut, [acc.user, body.auto_link]))[0]);
    res.json({ data: shapePrefs(row) });
  }));

  // -- auto-link (the crawler) ------------------------------------------------------------------------------------------------

  // What Directus's getAccountabilityForToken builds for a login: the role and its parents, and whether any policy is admin or app access.
  // NOT verified against Directus's own fetchRolesTree: the SQL.roleTree order (the role first, then its parents) and the exact accountability fields
  // Directus 11.17 reads are from memory of its source (backlog IF20 checks it on a live Directus).
  async function accountabilityFor(db, user) {
    const roles = isBlank(user.role) ? [] : rowsOf(await db.raw(SQL.roleTree, [user.role])).map((r) => r.id);
    const [access] = rowsOf(await db.raw(SQL.globalAccess, [user.id, roles.join(',')]));
    return { user: user.id, role: user.role ?? null, roles, admin: access?.admin === true, app: access?.app === true, ip: null };
  }

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
        const there = await existingLinks(trx, [{ collection: cand.suggested_collection, recordId: cand.suggested_record_id, fileId: cand.directus_files_id }]);
        if (there.size) return skip('ALREADY_ON_RECORD');
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
    const failed = rowsOf(await database.raw(SQL.adminFailedRequests, []));
    const [queue] = rowsOf(await database.raw(SQL.adminQueue, []));
    res.json({ data: shapeAdmin({ state, people, totals, failed, queue }, clock()) });
  }));

  router.post('/admin/scan-all', adminRoute(async ({ res, acc }) => {
    const out = await inTransaction(acc.user, async (trx) => {
      await trx.raw(SQL.lock, ['inbox-scan-all']);
      const [waiting] = rowsOf(await trx.raw(SQL.scanAllBlocking, []));
      if (waiting) throw ERRORS.alreadyQueued(waiting.request_id);
      return rowsOf(await trx.raw(SQL.scanAllInsert, [acc.user]))[0];
    });
    res.status(202).json({ data: shapeQueued(out) });
  }));
}

export default {
  id: SOURCE,
  handler: (router, context) => mount(router, context),
};
