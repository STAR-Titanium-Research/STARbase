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
//                                                short ID or code. A COPY of a file that is still in an inbox is not counted (D11: the badge
//                                                counts a file once; the list shows the copy, marked); it counts once its original is gone or was
//                                                dismissed by ANOTHER owner, and never once the original is linked or dismissed by the same owner
//                                                (then it is hidden). A file already on the record it names (linked in Data Studio) is not counted
//                                                either: neither is something new to link
//   GET  /d1-inbox/files?tab=new|older|linked|dismissed&kind=a,b&strength=a,b&folder=&from=&to=&owner=me|team:<id>&link_kind=&limit=&offset=
//                                   -> { data: FoundFile[], meta: { total, limit, offset, acceptable } }   FoundFile = the file_candidates columns
//                                      plus name, suggested_label, suggested_can_edit, duplicate_of_owner, linked_record_id, linked_label,
//                                      decided_by_name and owner {kind, id, name}. duplicate_of_owner (null unless the row is a copy) is the NAME of whose
//                                      Inbox holds the original when that is the caller's own folder or one of their teams, else { kind: 'other' } with no
//                                      name; a copy is hidden from new, older and open once its original is linked or dismissed by the same owner, and
//                                      once it is linked when the original belongs to someone else. A record is named (suggestion, matches, linked record) only
//                                      to a caller who can READ it. meta.acceptable (null unless the query has acceptable=1: it reads
//                                      candidates and checks edit rights) = how many rows Accept all would link for the same filter.
//                                      FoundFile.has_thumbnail (boolean, additive): true when the crawler stored thumbnails for the file (kinds image and
//                                      sem_image only; a failure marker row, thumb NULL, does not count). The bytes are never part of the list.
//   GET  /d1-inbox/files/:candidate_id/thumb | /preview
//                                   -> the stored picture itself, NOT a { data } envelope: 200 image/jpeg (thumb about 320 px, preview about 1600 px: a reduced
//                                      copy, never the original) with Cache-Control: private, no-cache (the browser may keep the picture but asks again every time,
//                                      so canSee runs on every request) and a strong ETag (md5 of the bytes, computed per request, not stored); 304 with no body
//                                      when If-None-Match matches (sent only after canSee). Vary: Cookie, Authorization. Visible to exactly who sees the file in the list (canSee: the owner person's login, an
//                                      active member of the owner team, administrators); 404 NOT_FOUND (the usual Directus-shaped JSON error) when the id is
//                                      not a uuid, the candidate does not exist, is gone or is not the caller's to see, or has no picture (no row, or a failure
//                                      marker row): the same answer for all of them, so no id is confirmed; a 404 carries no ETag and no caching headers. Read-only: allowed to a Lab Viewer.
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
//                                   read), 409 ALREADY_ADDED (the file already has a surface scan row, for instance one added through the Alicona
//                                   feature's own dialog: asked up front, before any record is read; the table's unique constraints are the backstop),
//                                   409 SURFACE_SCANS_UNAVAILABLE (no such table yet). Where the table exists, the summary and the new, older and open
//                                   lists leave out undecided surface scan files that already have a scan (older databases use the plain queries).
//   POST /d1-inbox/accept-all       { filter?, dry_run?, candidate_ids?, cursor? }   links the exact short-ID suggestions the caller can edit
//                                   (images, and documents or other files, never surface scans) -> { data: { link_batch_id, linked: <count>,
//                                   items, skipped: [{ candidate_id, reason }] (the first 200), skipped_total, has_more, next_cursor } }.
//                                   dry_run -> { data: { count, ids, skipped, skipped_total, has_more, next_cursor } } and nothing is written.
//                                   With candidate_ids (the ids of a preview) exactly those are re-checked under the row locks and linked if
//                                   they still qualify; the filter is ignored. Without them it reads the filter's rows a page at a time (keyset
//                                   on first_seen_at, candidate_id) so a page of rows it must skip never hides linkable rows behind it;
//                                   has_more is true only when the last page it read was full, and next_cursor (sent back as `cursor`) goes on.
//   POST /d1-inbox/dismiss | /restore  { candidate_ids: [...] }  -> { data: { changed: <count>, changed_ids, unchanged_ids } }
//                                   A restore (and an undo) also makes the crawler list the file's folder again (D12): see SQL.relistDirs.
//   POST /d1-inbox/undo             { link_batch_id }       removes the junction rows that batch created (and the surface_scans rows it added,
//                                   as the caller: 403 when they may no longer delete) -> { data: { undone: <count> } }
//   POST /d1-inbox/rescan           queue a person-scope scan -> 202 { data: { queued: true, ... } }; 429 (extensions.retry_after_seconds) within
//                                   10 minutes of the last request, or while one is queued or running
//   GET  /d1-inbox/prefs, PUT /d1-inbox/prefs { auto_link: boolean }
//   GET  /d1-inbox/ignored-folders  -> { data: [{ ignored_id, folder, owner: { kind: 'person' | 'team', id, name }, created_at, can_remove }],
//                                   meta: { can_change: boolean } }  the rules of the caller's own folder and of the teams they are an ACTIVE member of
//                                   (spec section 15). meta.can_change says whether the caller may change rules at all: false for a Lab Viewer (who reads
//                                   them, every can_remove false), true for everyone else, whatever the number of rules (an empty list included; the
//                                   client hides "Ignore this folder" and the add field on false). folder is relative to the owner's root, as it was sent.
//   POST /d1-inbox/ignored-folders  { folder, team_id? }  -> 201 { data: { ignored_id, folder, team_id, dismissed } }   "Ignore this folder when scanning": a
//                                   rule for the caller's personal folder, or for the team folder of team_id (an active member only). folder is relative to
//                                   the owner's root (World-Ti Paper/Drafts, never Users/<alias>/...), no leading or trailing slash, no empty, . or .. part,
//                                   not the root itself, at most 200 rules per owner (409 TOO_MANY_RULES), the same folder twice ignoring case is
//                                   409 ALREADY_IGNORED, 400 INVALID_PAYLOAD otherwise (extensions.field is 'folder'). In the SAME transaction the owner's
//                                   open ('new') found files in that folder and below are dismissed exactly as POST /dismiss does it (restorable; linked
//                                   and gone files are untouched); dismissed says how many. The crawler reads the rules and never lists the subtree.
//                                   `dismissed` counts every open ('new') row of the owner under the rule that moved to Dismissed: it can include rows the
//                                   list does not show (a copy hidden while its original is decided by the same owner, a surface scan file that already
//                                   has a scan), so it can be larger than the number of files the Inbox listed under the folder. It is not changed to
//                                   match the list: those rows were open and are now dismissed, restorable like any other. folder is trimmed of leading
//                                   and trailing whitespace before it is checked and stored.
//   DELETE /d1-inbox/ignored-folders/:id  -> { data: { ignored_id, folder, still_ignored, rescan_queued } }   removes the rule and RESETS the folder's cache rows (inbox_dirs: dir_mtime
//                                   and last_listed_at NULL, for the folder and everything below it; never deleted, or a crawler that finds the parent
//                                   unchanged would never rediscover the folder: it keeps a 'seen, not listed' row for every ignored folder), so the next
//                                   scan lists the folder again; a person-scope rescan is queued when the 10-minute limit of POST /rescan allows
//                                   (rescan_queued says whether one was; the limit never fails the delete). still_ignored is true when the folder is STILL
//                                   covered by another rule of the same owner (removing A/B while A is ignored): nothing changes for the crawler, so the cache
//                                   is not reset and no rescan is queued (rescan_queued false); false otherwise. Files the rule dismissed stay in Dismissed
//                                   until restored. A rule that is not the caller's or their team's is 404 NOT_FOUND. No administrator override: rules are
//                                   a person's or a team's own (admin-wide rules are not in v1).
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
// Visibility of a candidate: its owner person's login, any ACTIVE member (people.active) of its owner team, administrators (all). One predicate, canSee,
// serves the list and the picture routes.
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
// Ignored folders (spec section 15): at most this many rules per owner (the table has no limit of its own), and the longest folder text accepted.
const MAX_IGNORED_PER_OWNER = 200;
const MAX_IGNORED_FOLDER = 500;

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
// The edge a surface scan file's name points to (match_strength 'edge_code'): read as the caller so the list can name it, but never editable (a scan is
// added through Directus's create permission on surface_scans, not a record-edit right) and not a link target.
const SCAN_EDGES = 'insert_edges';
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
  + ' c.link_batch_id, c.adopted_at, c.auto_undone_at';
const IDS = "string_to_array(?, ',')::uuid[]";
// The two pictures the crawler stores per image candidate: the route's last segment -> the column of d1_private.file_thumbnails.
const PICTURES = { thumb: 'thumb', preview: 'preview' };
// no-cache, not max-age: a browser that kept a picture for an hour would show it without the server running canSee (a shared lab PC, a person removed from a team).
// no-cache lets it keep the bytes but revalidate every time; the 304 is only answered after canSee. Vary tells caches the answer depends on who asks.
const PICTURE_CACHE_CONTROL = 'private, no-cache';
const PICTURE_VARY = 'Cookie, Authorization';
const perTarget = (build) => Object.fromEntries(Object.entries(LINK_TARGETS).map(([collection, t]) => [collection, build(t, collection)]));
// D11, the same image in two inboxes. A copy (duplicate_of) is shown, marked, while its original is undecided, and drops out of the new, older and open
// lists once the original is LINKED, or DISMISSED BY THE SAME OWNER (the same person or team). Another owner dismissing their file must not hide yours: a
// copy whose original sits in a different owner's inbox stays until that original is linked (and is then counted, see below). The one SAME_OWNER test
// serves the list and the summary, so they cannot disagree.
const SAME_OWNER = '(c.owner_person_id IS NOT DISTINCT FROM o.owner_person_id AND c.owner_team_id IS NOT DISTINCT FROM o.owner_team_id)';
const COPY_HIDDEN = `NOT (c.duplicate_of IS NOT NULL AND (o.state = 'linked' OR (o.state = 'dismissed' AND ${SAME_OWNER})))`;
// The badge counts a file once (D11): a copy of a file still in an inbox is not counted (the list shows it, marked). It counts once no inbox holds the
// original any more: the original is gone, or dismissed by ANOTHER owner (so it counts for nobody). Never when the original is linked (hidden) or the same
// owner dismissed it (hidden).
const NOT_A_COUNTED_COPY = `(c.duplicate_of IS NULL OR o.state = 'gone' OR (o.state = 'dismissed' AND NOT ${SAME_OWNER}))`;
// A file that is already on the record it names (linked in Data Studio) is not a new thing to link: not counted, not accepted in bulk.
const NOT_ON_RECORD = Object.entries(LINK_TARGETS)
  .map(([collection, t]) => `NOT (c.suggested_collection = '${collection}' AND EXISTS (SELECT 1 FROM ${t.junction} j WHERE j.${t.fk} = c.suggested_record_id AND j.directus_files_id = c.directus_files_id))`)
  .join(' AND ');

// Ignored folders (spec section 15, M1 of the review): the crawler loads the owner's rules once per scan, so it can register a file under a folder that was
// ignored a moment ago, after POST /ignored-folders dismissed what was there. Such an undecided ('new') row must never show, never count in the badge and never
// be accepted in bulk: this one clause, shared by the list, the count, the summary and accept-all, leaves it out. It is the crawler's own db._not_ignored: the rule
// is relative to the owner's root, which is the first two parts of the file's own path ('Users/<alias>', 'Shared/<share folder>'); a rule covers the folder and
// everything below it on WHOLE path parts (the prefix 'root/rule/' is compared with left(), never LIKE, so no wildcard in a folder name is special) and ignoring
// case. The owner-person and owner-team tests are two separate NOT EXISTS (each an equality on its own column) so the planner can use the partial indexes
// idx_inbox_ignored_dirs_owner_person and _owner_team; a file owned by a team has a NULL person id and the person subquery then finds nothing, and the reverse.
// Only the undecided tabs and the summary use it: a LINKED row under a rule is still listed in the Linked tab, a dismissed one in Dismissed.
const IGNORED_PREFIX = "lower(split_part(c.rel_path, '/', 1) || '/' || split_part(c.rel_path, '/', 2) || '/' || ig.rel_folder)";
const UNDER_RULE = `left(lower(c.rel_path), length(${IGNORED_PREFIX}) + 1) = ${IGNORED_PREFIX} || '/'`;
const NOT_UNDER_IGNORED = 'NOT EXISTS (SELECT 1 FROM d1_private.inbox_ignored_dirs ig WHERE ig.owner_person_id = c.owner_person_id'
  + ` AND ${UNDER_RULE}) AND NOT EXISTS (SELECT 1 FROM d1_private.inbox_ignored_dirs ig WHERE ig.owner_team_id = c.owner_team_id AND ${UNDER_RULE})`;

// A surface scan file that was already added (through the Alicona feature's own dialog, or here) is not a new thing to add: not counted, not listed as
// undecided. Only meaningful where the surface_scans table exists (the endpoint asks first), so it is a separate fragment, never part of NOT_ON_RECORD.
const SCAN_ADDED = "NOT (c.kind = 'surface_scan' AND EXISTS (SELECT 1 FROM surface_scans s WHERE s.directus_files_id = c.directus_files_id))";
const summarySql = (scans) => 'SELECT c.owner_person_id, c.owner_team_id, c.origin,'
  + " (c.suggested_record_id IS NOT NULL AND c.match_strength IN ('short_id', 'code')) AS exact, count(*)::int AS n"
  + ' FROM d1_private.file_candidates c LEFT JOIN d1_private.file_candidates o ON o.candidate_id = c.duplicate_of'
  + ` WHERE c.state = 'new' AND (c.owner_person_id = ? OR c.owner_team_id = ANY(${IDS}))`
  + ` AND ${NOT_A_COUNTED_COPY} AND ${NOT_ON_RECORD} AND ${NOT_UNDER_IGNORED}${scans ? ` AND ${SCAN_ADDED}` : ''}`
  + ' GROUP BY c.owner_person_id, c.owner_team_id, c.origin, exact';

export const SQL = {
  setActor: "SELECT set_config('d1.actor_identity', ?, true)",
  lock: 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))',
  personByUser: 'SELECT person_id, full_name, active, uni_alias, user_id FROM people WHERE user_id = ?',
  personById: 'SELECT person_id, full_name, active, uni_alias, user_id FROM people WHERE person_id = ?',
  teamsOfPerson:
    'SELECT t.team_id, t.name, t.share_folder FROM team_members m JOIN teams t ON t.team_id = m.team_id WHERE m.person_id = ? ORDER BY t.name',
  // Bindings: the person id, the team ids as one csv ('' for none).
  summary: summarySql(false),
  // The same where the surface_scans table exists (the endpoint checks first): without the surface scan files that already have a scan.
  summaryWithScans: summarySql(true),
  // The rows of the candidates asked for, locked in id order (two requests for one file serialise on this).
  candidatesForUpdate: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) ORDER BY c.candidate_id FOR UPDATE`,
  // The same rows without the lock: for reads that write nothing (the list's "acceptable" count, an accept-all dry run).
  candidatesById: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) ORDER BY c.candidate_id`,
  // The same two reads for accept-all, which must never link a row under an ignored folder (see NOT_UNDER_IGNORED): such an undecided row reads as not found. A row
  // that is already decided is returned whatever its folder, so the answer for it stays NOT_NEW.
  acceptCandidatesById: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) AND (c.state <> 'new' OR (${NOT_UNDER_IGNORED})) ORDER BY c.candidate_id`,
  acceptCandidatesForUpdate: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.candidate_id = ANY(${IDS}) AND (c.state <> 'new' OR (${NOT_UNDER_IGNORED})) ORDER BY c.candidate_id FOR UPDATE`,
  batchForUpdate: `SELECT ${CANDIDATE_COLUMNS} FROM d1_private.file_candidates c WHERE c.link_batch_id = ? ORDER BY c.candidate_id FOR UPDATE`,
  // Bindings: decided_by, link_kind, collection, junction id, batch id, adopt (boolean), candidate id. Only a candidate still 'new' changes.
  markLinked:
    "UPDATE d1_private.file_candidates SET state = 'linked', decided_at = now(), decided_by = ?, link_kind = ?, linked_collection = ?,"
    + ' linked_junction_id = ?, link_batch_id = ?,'
    + ' adopted_at = CASE WHEN ?::boolean THEN coalesce(adopted_at, now()) ELSE adopted_at END'
    + " WHERE candidate_id = ? AND state = 'new' RETURNING candidate_id",
  // Undo clears the four link columns together (the table's CHECK). adopted_at stays: the crawler may already have hashed the file. An undone AUTO
  // link is remembered in auto_undone_at (the SET list sees the old link_kind), so the crawler's auto-link never links that file again.
  resetBatch:
    "UPDATE d1_private.file_candidates SET state = 'new', decided_at = NULL, decided_by = NULL,"
    + " auto_undone_at = CASE WHEN link_kind = 'auto' THEN now() ELSE auto_undone_at END, link_kind = NULL, linked_collection = NULL,"
    + ` linked_junction_id = NULL, link_batch_id = NULL WHERE candidate_id = ANY(${IDS}) AND link_batch_id = ? AND state = 'linked'`
    + ' RETURNING candidate_id',
  dismiss:
    "UPDATE d1_private.file_candidates SET state = 'dismissed', decided_at = now(), decided_by = ?"
    + ` WHERE candidate_id = ANY(${IDS}) AND state = 'new' RETURNING candidate_id`,
  restore:
    "UPDATE d1_private.file_candidates SET state = 'new', decided_at = NULL, decided_by = NULL"
    + ` WHERE candidate_id = ANY(${IDS}) AND state = 'dismissed' RETURNING candidate_id`,
  // Restore and undo put a file back to 'new'. If it vanished meanwhile, the crawler's folder cache still says "listed, unchanged" for its folder, so the
  // file would stay 'new' for good: forget that the folder was listed (last_listed_at and dir_mtime NULL, as the crawler's own lost-file handling does:
  // a NULL mtime never equals the share's) and the next scan lists it again and marks what is missing gone. Only the file's own folder row, only for
  // its owner (a path cached for someone else is left alone), and never baselined_at. Binding: the candidate ids as one csv.
  relistDirs:
    'UPDATE d1_private.inbox_dirs d SET last_listed_at = NULL, dir_mtime = NULL FROM d1_private.file_candidates c'
    + ` WHERE c.candidate_id = ANY(${IDS}) AND d.rel_path = regexp_replace(c.rel_path, '/[^/]*$', '')`
    + ' AND d.owner_person_id IS NOT DISTINCT FROM c.owner_person_id AND d.owner_team_id IS NOT DISTINCT FROM c.owner_team_id',
  // Ignored folders (spec section 15, migration 199). The owner is always a pair of bindings (person id, team id), one of them null; paths are compared
  // lower-cased on whole path parts: a prefix 'root/folder/' with starts_with() (no LIKE, so no wildcard in a folder name is ever special).
  // Bindings: the person id (or null), the team ids as one csv ('' for none).
  ignoredList:
    'SELECT i.ignored_id, i.owner_person_id, i.owner_team_id, i.rel_folder, i.created_at, coalesce(p.full_name, t.name) AS owner_name'
    + ' FROM d1_private.inbox_ignored_dirs i LEFT JOIN people p ON p.person_id = i.owner_person_id LEFT JOIN teams t ON t.team_id = i.owner_team_id'
    + ` WHERE i.owner_person_id = ?::uuid OR i.owner_team_id = ANY(${IDS}) ORDER BY lower(i.rel_folder), i.ignored_id`,
  ignoredById:
    'SELECT ignored_id, owner_person_id, owner_team_id, rel_folder FROM d1_private.inbox_ignored_dirs WHERE ignored_id = ?',
  // Bindings: person id, team id (one null). The owner's rules, counted for the cap; one rule found ignoring case, for the duplicate answer.
  ignoredCount:
    'SELECT count(*)::int AS n FROM d1_private.inbox_ignored_dirs WHERE owner_person_id IS NOT DISTINCT FROM ?::uuid AND owner_team_id IS NOT DISTINCT FROM ?::uuid',
  ignoredFind:
    'SELECT ignored_id FROM d1_private.inbox_ignored_dirs WHERE owner_person_id IS NOT DISTINCT FROM ?::uuid AND owner_team_id IS NOT DISTINCT FROM ?::uuid'
    + ' AND lower(rel_folder) = lower(?)',
  // Bindings: person id, team id, folder, created_by.
  ignoredInsert:
    'INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, owner_team_id, rel_folder, created_by) VALUES (?::uuid, ?::uuid, ?, ?)'
    + ' RETURNING ignored_id, rel_folder, created_at',
  ignoredDelete: 'DELETE FROM d1_private.inbox_ignored_dirs WHERE ignored_id = ? RETURNING ignored_id',
  // The folders of the owner's rules (bindings: person id, team id), read after a delete to see whether the removed folder is still covered by a rule above it.
  ignoredOfOwner:
    'SELECT rel_folder FROM d1_private.inbox_ignored_dirs WHERE owner_person_id IS NOT DISTINCT FROM ?::uuid AND owner_team_id IS NOT DISTINCT FROM ?::uuid',
  // The owner's open candidates, by owner only (the (owner, state) indexes serve it): which of them lie under the new rule is decided in JS by isIgnored, the one
  // matcher the crawler's Python twin is tested against. A SQL prefix test lowercases in Postgres while the final check lowercases in JS, and the two differ for
  // some characters (a final sigma, a dotted capital I), so a prefilter could drop a row the matcher would cover. Only id and path are read, and nothing is
  // locked here: the dismissal that follows (SQL.dismiss, as POST /dismiss) changes a row only while it is still 'new', so a file linked or dismissed in
  // between stays as it is. Bindings: person id, team id.
  openUnderFolder:
    "SELECT c.candidate_id, c.rel_path FROM d1_private.file_candidates c WHERE c.state = 'new'"
    + ' AND c.owner_person_id IS NOT DISTINCT FROM ?::uuid AND c.owner_team_id IS NOT DISTINCT FROM ?::uuid ORDER BY c.candidate_id',
  // A removed rule: reset the cache rows of the folder (its own row and everything below) to "seen, not listed" (last_listed_at and dir_mtime NULL, as
  // relistDirs does; never baselined_at, and the rows are NOT deleted: the crawler reaches a folder through its cached parent, so a deleted row would hide
  // the folder for as long as the parent's modification time stays the same; a NULL mtime never equals the share's). Bindings: person id, team id, the
  // folder's path 'root/folder', then the same path with a slash.
  ignoredResetDirs:
    'UPDATE d1_private.inbox_dirs SET last_listed_at = NULL, dir_mtime = NULL WHERE owner_person_id IS NOT DISTINCT FROM ?::uuid'
    + ' AND owner_team_id IS NOT DISTINCT FROM ?::uuid AND (lower(rel_path) = lower(?) OR starts_with(lower(rel_path), lower(?)))',
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
  // Which of the files already have a surface scan (any insert or edge). Binding: the file ids as one csv. Only asked where the table exists.
  scansOfFiles: `SELECT DISTINCT directus_files_id FROM surface_scans WHERE directus_files_id = ANY(${IDS})`,
  scanById: 'SELECT scan_id AS id, insert_id, edge_id, directus_files_id FROM surface_scans WHERE scan_id = ?',
  // The picture routes. Step 1 (cheap, no bytes): who owns the candidate and does a picture exist, with the md5 of the chosen picture as its ETag (NULL for a
  // failure marker row, whose pictures are NULL: that is a 404 like no row). The ETag is computed by the database on every request, not stored (md5 of a few
  // hundred KB is cheap next to moving them). The owner columns go through canSee, the list's own predicate. Step 2 (only when the caller may see it and the
  // ETag is not already theirs): the bytes AND their md5 in ONE query, so the ETag sent always belongs to the bytes sent, even if the picture was replaced
  // between the two steps. The column is chosen from the closed PICTURES map below, never from the request.
  thumbMeta: Object.fromEntries(Object.entries(PICTURES).map(([kind, column]) => [kind,
    `SELECT c.owner_person_id, c.owner_team_id, c.state, md5(t.${column}) AS etag FROM d1_private.file_candidates c`
    + ' JOIN d1_private.file_thumbnails t ON t.candidate_id = c.candidate_id WHERE c.candidate_id = ?'])),
  thumbBytes: Object.fromEntries(Object.entries(PICTURES).map(([kind, column]) => [kind, `SELECT md5(t.${column}) AS etag, t.${column} AS bytes FROM d1_private.file_thumbnails t WHERE t.candidate_id = ?`])),
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

// Does an If-None-Match header name this strong ETag (a quoted string)? A list of tags, a weak tag (W/"...": the comparison ignores the weakness) and * count.
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || header.trim() === '') return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
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
  // The picture routes answer this for every reason alike (not a uuid, no such file, gone, not the caller's, no picture), so no id is confirmed.
  noPicture: () => new HttpError(404, 'NOT_FOUND', 'There is no picture for that file.'),
  notInInbox: (candidateId) => new HttpError(404, 'NOT_FOUND', 'That file is not in your inbox.', { candidate_id: candidateId }),
  noFolder: () => new HttpError(409, 'NO_FOLDER', 'There is no folder to scan yet. Ask an administrator to set your uni alias.'),
  alreadyQueued: (requestId) => new HttpError(409, 'ALREADY_QUEUED', 'A scan of everyone is already waiting or running.', { request_id: requestId }),
  readOnly: () => new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE),
  adminOnly: () => new HttpError(403, 'FORBIDDEN', 'Only administrators can do that.'),
  rateLimited,
  alreadyIgnored: (folder) => new HttpError(409, 'ALREADY_IGNORED', 'That folder is already ignored.', { field: 'folder', folder }),
  tooManyRules: () => new HttpError(409, 'TOO_MANY_RULES', `You can ignore at most ${MAX_IGNORED_PER_OWNER} folders. Remove one first.`, { limit: MAX_IGNORED_PER_OWNER }),
  notIgnored: () => new HttpError(404, 'NOT_FOUND', 'That ignored folder does not exist.'),
  notYourTeam: () => new HttpError(403, 'FORBIDDEN', 'You are not a member of that team.', { field: 'team_id' }),
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
  + ' coalesce(cp.full_name, ct.name) AS duplicate_of_owner, o.owner_person_id AS duplicate_owner_person_id, o.owner_team_id AS duplicate_owner_team_id,'
  + ' c.rel_path, c.size_bytes, c.source_mtime, c.first_seen_at, c.decided_at, c.link_kind, c.linked_collection, c.link_batch_id,'
  + " coalesce(sj.sample_id, oj.operation_id, tj.session_id, CASE WHEN c.linked_collection = 'surface_scans' THEN c.linked_junction_id END) AS linked_record_id,"
  + " coalesce(nullif(btrim(coalesce(du.first_name, '') || ' ' || coalesce(du.last_name, '')), ''), du.email) AS decided_by_name,"
  + ' c.owner_person_id, c.owner_team_id, coalesce(op.full_name, ot.name) AS owner_name, c.adopted_at,'
  + ' EXISTS (SELECT 1 FROM d1_private.file_thumbnails th WHERE th.candidate_id = c.candidate_id AND th.thumb IS NOT NULL) AS has_thumbnail';
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

// The query for a list page ({ count: true }: its total; { accept: true }: the ids accept-all considers; { scans: true }: the surface_scans table exists, so
// undecided surface scan files that already have a scan are left out). Everything a client chose is a binding.
export function buildListQuery(scope, f, { count = false, accept = false, after = null, pageSize = ACCEPT_PAGE, scans = false } = {}) {
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
  if (f.tab === 'new') where.push("c.state = 'new'", "c.origin = 'new'", COPY_HIDDEN, NOT_UNDER_IGNORED);
  else if (f.tab === 'older') where.push("c.state = 'new'", "c.origin = 'backlog'", COPY_HIDDEN, NOT_UNDER_IGNORED);
  else if (f.tab === 'open') where.push("c.state = 'new'", COPY_HIDDEN, NOT_UNDER_IGNORED);
  else where.push(`c.state = '${f.tab}'`); // linked or dismissed (validated by parseFileFilters)
  // a surface scan file that already has a scan is not undecided any more (only where the table exists: `scans`)
  if (scans && !accept && ['new', 'older', 'open'].includes(f.tab)) where.push(SCAN_ADDED);
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
    if (!where.includes(NOT_UNDER_IGNORED)) where.push(NOT_UNDER_IGNORED); // (the undecided tabs have it already)
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

// Whose Inbox holds the original of a copy: the name (a string) only for the caller's own folder, one of their teams, or any for an administrator;
// for anyone else { kind: 'other' } and no name, so another person's name is not handed to someone who has no business with their folder. A row
// that does not say who owns the original, or a caller not given, is 'other' (fails closed). The client reads a string as the name and anything else as
// "a copy of another found file".
export function duplicateOwnerOut(row, viewer) {
  const mine = Boolean(viewer) && (viewer.admin === true
    || (!isBlank(row.duplicate_owner_person_id) && row.duplicate_owner_person_id === viewer.personId)
    || (!isBlank(row.duplicate_owner_team_id) && Array.isArray(viewer.teamIds) && viewer.teamIds.includes(row.duplicate_owner_team_id)));
  return mine && !isBlank(row.duplicate_of_owner) ? row.duplicate_of_owner : { kind: 'other' };
}

// One row of the list as STARbase's FoundFile (inboxApi.ts): the file_candidates columns it uses plus resolved labels. A record is named only to
// a caller who can READ it (`info.readable`, a set of "collection:id"; its code is in `info.labels`); for any other the suggestion, the matches
// and the linked record are left empty, so no id of a Restricted record leaks. `suggested_can_edit` says whether Link would pass.
export function fileOut(row, info) {
  const matches = Array.isArray(asJson(row.matches)) ? asJson(row.matches) : [];
  const key = (collection, id) => `${collection}:${id}`;
  // an insert edge is named only on a surface scan row (the F2 dialog's pre-selection); on any other file it is never a suggestion or a match
  const seen = (collection, id) => Boolean(id) && (collection !== SCAN_EDGES || row.kind === 'surface_scan') && info.readable.has(key(collection, id));
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
    duplicate_of_owner: row.duplicate_of ? duplicateOwnerOut(row, info.viewer) : null,
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
    has_thumbnail: row.has_thumbnail === true,
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
  // a person undid an auto-link of this file: automation never links it again (their own Link or Accept all of it stays allowed)
  if (auto && cand.auto_undone_at) return 'UNDONE';
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

// ---- ignored folders (spec section 15) -------------------------------------------------------------------------------------------

// Does a rule cover this folder? `folder` is a path relative to the owner's root ('' for the root itself, which no rule covers); `rules` are the rel_folder
// strings of the owner's rules. A rule covers the folder it names and everything beneath it, on WHOLE path parts and ignoring case (the share is
// case-insensitive): 'World-Ti Paper' covers 'World-Ti Paper' and 'world-ti paper/Drafts' but not 'World-Ti Paper 2'. No wildcards. The crawler has the
// same function in Python (scripts/inbox_crawler/), and both test files run the same table of cases: change them together.
export function isIgnored(folder, rules) {
  if (typeof folder !== 'string' || folder === '' || !Array.isArray(rules)) return false;
  const path = folder.toLowerCase();
  return rules.some((rule) => {
    if (typeof rule !== 'string' || rule === '') return false;
    const r = rule.toLowerCase();
    return path === r || path.startsWith(`${r}/`);
  });
}

// The folder a found file sits in, relative to its owner's root ('' for a file directly in the root, or one that is not under the root at all).
export function folderOfCandidate(relPath, root) {
  const path = String(relPath ?? '');
  const prefix = `${root}/`;
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return '';
  const rest = path.slice(prefix.length);
  const cut = rest.lastIndexOf('/');
  return cut < 0 ? '' : rest.slice(0, cut);
}

// The folder of a new rule, checked: relative to the owner's root, no leading or trailing slash, no empty, '.' or '..' part (the same rules as the
// table's CHECKs, so a refusal here is a 400 with a message, never a constraint error), and never the root itself or a path that starts with it.
// `root` is 'Users/<alias>' or 'Shared/<share folder>'. Leading and trailing whitespace is trimmed BEFORE anything is checked (the client trims too; a pasted
// path often carries a newline or a space), and the trimmed folder is what is validated, compared, stored and answered. Returns that folder.
export function parseIgnoredFolder(raw, root) {
  const fail = (message) => new HttpError(400, 'INVALID_PAYLOAD', message, { field: 'folder' });
  if (typeof raw !== 'string') throw fail('Choose the folder to ignore.');
  const value = raw.trim();
  if (value === '') throw fail('Choose a folder below your own folder: the whole folder cannot be ignored.');
  if (value.length > MAX_IGNORED_FOLDER) throw fail(`The folder is too long (at most ${MAX_IGNORED_FOLDER} characters).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw fail('The folder contains characters that are not allowed.');
  if (value.includes('\\')) throw fail('Write the folder with / between the names, not \\.');
  if (value.startsWith('/') || value.endsWith('/')) throw fail('The folder must not start or end with a slash.');
  const parts = value.split('/');
  if (parts.some((part) => part === '')) throw fail('The folder has an empty part (two slashes in a row).');
  if (parts.some((part) => part === '.' || part === '..')) throw fail('The folder must not contain . or .. parts.');
  const lower = value.toLowerCase();
  const rootLower = typeof root === 'string' ? root.toLowerCase() : null;
  if (rootLower && (lower === rootLower || lower.startsWith(`${rootLower}/`))) {
    throw fail(`Give the folder relative to your own folder, without ${root}/.`);
  }
  return value;
}

// ---- the answers, as the typed client in STARbase reads them ---------------------------------------------------------------------
// One function per route's body (the routes call these; contract_fixtures.mjs writes their output to tests/fixtures/d1-inbox/ for the client's tests).

const skippedOut = (skipped) => ({ skipped: skipped.slice(0, SKIPPED_SHOWN), skipped_total: skipped.length });

// One answer item of POST /link for a thing newly linked: a junction row (record_id is the record) or a surface scan (record_id is the new scan's id, which
// is also junction_id; the insert or edge it was added to is named, the other is null).
export const linkedItemOut = ({ cand, collection, recordId, scan }, junctionId, adopted) => (collection === SURFACE_SCANS
  ? { candidate_id: cand.candidate_id, collection, record_id: junctionId, junction_id: junctionId, insert_id: scan.insertId, edge_id: scan.edgeId, adopted }
  : { candidate_id: cand.candidate_id, collection, record_id: recordId, junction_id: junctionId, adopted });
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
// GET /ignored-folders: rows as ignoredList selects them, as the whole body { data, meta }. canChange is false for a caller who may only read (a Lab Viewer)
// and true for everyone else, whatever the number of rules: meta.can_change is what the client asks before it offers to add a rule (an empty list has
// no row to carry can_remove), and each row's can_remove repeats it.
export const shapeIgnoredFolders = (rows, canChange) => ({
  data: rows.map((r) => ({
    ignored_id: r.ignored_id,
    folder: r.rel_folder,
    owner: r.owner_person_id
      ? { kind: 'person', id: r.owner_person_id, name: r.owner_name ?? '' }
      : { kind: 'team', id: r.owner_team_id, name: r.owner_name ?? '' },
    created_at: toIso(r.created_at),
    can_remove: canChange,
  })),
  meta: { can_change: canChange },
});
// POST /ignored-folders. `dismissed` is the number of rows the dismissal changed: every open row of the owner under the rule, so it can include hidden copies and
// rows the list does not show; it is not a count of what the list displayed.
export const shapeIgnoredAdded = (rule, teamId, dismissed) => ({ ignored_id: rule.ignored_id, folder: rule.rel_folder, team_id: teamId ?? null, dismissed });
// DELETE /ignored-folders/:id
// stillIgnored: the folder is still covered by another rule of the same owner (a rule above it), so nothing about it changed: no cache reset, no rescan.
export const shapeIgnoredRemoved = (rule, { stillIgnored = false, rescanQueued = false } = {}) => ({
  ignored_id: rule.ignored_id, folder: rule.rel_folder, still_ignored: stillIgnored, rescan_queued: rescanQueued,
});
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
    // The edge a surface scan file's name points to (S4): read as the caller (their read rule decides), named by its code, and NEVER added to the
    // editable set below (adding a scan is not editing the edge). fileOut passes it through for a surface scan row only.
    const edgeIds = [...new Set(pairs.filter(([c, id]) => c === SCAN_EDGES && isUuid(id)).map(([, id]) => String(id)))];
    if (edgeIds.length) {
      try {
        const rows = await itemsFor(schema, acc, SCAN_EDGES).readByQuery({ fields: ['edge_id', 'edge_code'], filter: { edge_id: { _in: edgeIds } }, limit: edgeIds.length });
        for (const r of rows) {
          readable.add(`${SCAN_EDGES}:${r.edge_id}`);
          labels.set(`${SCAN_EDGES}:${r.edge_id}`, r.edge_code ?? null);
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

  // 409 ALREADY_ADDED for the first fresh surface scan entry whose file already has a scan row. One query for the whole request.
  async function requireNoScan(trx, entries) {
    const scans = entries.filter((e) => e.collection === SURFACE_SCANS);
    if (!scans.length) return;
    const have = new Set(rowsOf(await trx.raw(SQL.scansOfFiles, [scans.map((e) => e.cand.directus_files_id).join(',')])).map((r) => String(r.directus_files_id)));
    const hit = scans.find((e) => have.has(String(e.cand.directus_files_id)));
    if (hit) throw ERRORS.alreadyAdded(hit.cand.candidate_id);
  }

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
      if (err?.code === 'INVALID_FOREIGN_KEY' || err?.code === '23503') throw new HttpError(404, 'NOT_FOUND', 'That insert, edge, operation or file no longer exists.', { candidate_id: cand.candidate_id, collection: SURFACE_SCANS });
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
      linked.push(linkedItemOut({ cand, collection, recordId, scan }, junctionId, adopt));
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
            again.push({ ...linkedItemOut({ cand, collection: w.collection, scan: w.scan }, cand.linked_junction_id, false), already_linked: true });
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
      // a file that already has a surface scan (added through the Alicona dialog, or by someone else) is treated like an already-linked file: 409 up front,
      // before any record is read or written (the unique constraints would also refuse the same insert or edge, but not another one)
      await requireNoScan(trx, fresh);
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
      const rows = new Map(rowsOf(await db.raw(lock ? SQL.acceptCandidatesForUpdate : SQL.acceptCandidatesById, [ids.join(',')])).map((r) => [r.candidate_id, r]));
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
        const cands = rowsOf(await db.raw(lock ? SQL.acceptCandidatesForUpdate : SQL.acceptCandidatesById, [found.map((r) => r.candidate_id).join(',')]));
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
      // a restored file may have vanished while it was dismissed: have the crawler list its folder again (D12)
      if (name === 'restore' && done.length) await trx.raw(SQL.relistDirs, [done.join(',')]);
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
      // the files are 'new' again: if one vanished while it was linked, the crawler must list its folder again to mark it gone (D12)
      if (done.length) await trx.raw(SQL.relistDirs, [done.map((r) => r.candidate_id).join(',')]);
      return shapeUndo(batch, done);
    });
    await clearDataCache(schema);
    res.json({ data: out });
  }));

  // -- reading ---------------------------------------------------------------------------------------------------------------

  router.get('/summary', route(async ({ res, acc }) => {
    const scope = await scopeOf(acc);
    const rows = scope.personId ? rowsOf(await database.raw((await scanTableAvailable()) ? SQL.summaryWithScans : SQL.summary, [scope.personId, scope.teamIds.join(',')])) : [];
    res.json({ data: shapeSummary(rows, scope, scope.teams, scope.person) });
  }));

  router.get('/files', route(async ({ req, res, acc }) => {
    const f = parseFileFilters(req.query);
    const scope = await scopeOf(acc);
    requireOwnerVisible(scope, f);
    const schema = await schemaOf(req);
    const scans = await scanTableAvailable();
    const page = buildListQuery(scope, f, { scans });
    const total = buildListQuery(scope, f, { count: true, scans });
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
    // `viewer` is who is asking, for the one thing a row names by folder: whose Inbox holds the original of a copy (duplicateOwnerOut)
    res.json(shapeFiles(rows, { ...info, viewer: scope }, { total: count, limit: f.limit, offset: f.offset, acceptable }));
  }));

  // -- the pictures -------------------------------------------------------------------------------------------------------------

  // GET /files/:candidate_id/thumb | /preview: the stored JPEG itself, never a { data } envelope (so no res.json on success). Visible to exactly who sees the
  // file in the list: the owner columns go through canSee, the one visibility predicate (an administrator sees all, as there). Every reason to refuse is the
  // same 404, and a 404 never carries caching headers: ETag, Cache-Control and Vary are set only immediately before the 304 or the 200 goes out. The ETag is the
  // md5 of the stored bytes (the database computes it, per request, so a 304 never moves the bytes); the 200 reads the bytes and their md5 together.
  const pictureRoute = (kind) => route(async ({ req, res, acc }) => {
    const id = isUuid(req.params?.candidate_id) ? req.params.candidate_id.toLowerCase() : null;
    if (id === null) throw ERRORS.noPicture();
    const scope = await scopeOf(acc);
    const [meta] = rowsOf(await database.raw(SQL.thumbMeta[kind], [id]));
    // a failure marker row has no picture (etag NULL): the same 404
    if (!meta || meta.state === 'gone' || !canSee(scope, meta) || typeof meta.etag !== 'string' || meta.etag === '') throw ERRORS.noPicture();
    const cachingHeaders = (etag) => {
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', PICTURE_CACHE_CONTROL);
      res.setHeader('Vary', PICTURE_VARY);
    };
    if (etagMatches(req.headers?.['if-none-match'], `"${meta.etag}"`)) {
      cachingHeaders(`"${meta.etag}"`);
      res.status(304).end();
      return;
    }
    // the row may have vanished, or become a marker, since step 1: a 404 then, with nothing set yet
    const [row] = rowsOf(await database.raw(SQL.thumbBytes[kind], [id]));
    if (!row || !Buffer.isBuffer(row.bytes) || row.bytes.length === 0 || typeof row.etag !== 'string' || row.etag === '') throw ERRORS.noPicture();
    cachingHeaders(`"${row.etag}"`);
    res.status(200);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', String(row.bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(row.bytes);
  });
  router.get('/files/:candidate_id/thumb', pictureRoute('thumb'));
  router.get('/files/:candidate_id/preview', pictureRoute('preview'));

  // -- rescan, prefs ----------------------------------------------------------------------------------------------------------

  // Queue a person-scope scan for the caller (their folder and their teams'), unless the rate limit says no (429, with the seconds to wait). Shared by
  // POST /rescan and by removing an ignored folder, which asks for one only when the limit allows.
  async function queueRescan(acc, scope) {
    const limited = rateLimited;
    const now = clock();
    const since = new Date(now.getTime() - RESCAN_WINDOW_MS).toISOString();
    return inTransaction(acc.user, async (trx) => {
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
  }

  router.post('/rescan', route(async ({ res, acc }) => {
    const scope = await scopeOf(acc);
    const hasFolder = Boolean(scope.person?.uni_alias) || scope.teams.some((t) => !isBlank(t.share_folder));
    if (!scope.personId || !hasFolder) {
      throw ERRORS.noFolder();
    }
    const out = await queueRescan(acc, scope);
    res.status(202).json({ data: shapeQueued(out) });
  }));

  // -- ignored folders (spec section 15) ---------------------------------------------------------------------------------------

  // The owner a rule of the caller's belongs to, from the request: the caller's personal folder, or the team folder of team_id (an active member only).
  // Returns { personId, teamId, root }; root is the owner's folder on the share ('Users/<alias>', 'Shared/<share folder>').
  const ignoreOwnerOf = (scope, teamId) => {
    if (teamId === undefined || teamId === null) {
      if (!scope.personId || isBlank(scope.person?.uni_alias)) throw ERRORS.noFolder();
      return { personId: scope.personId, teamId: null, root: `Users/${scope.person.uni_alias}` };
    }
    if (!isUuid(teamId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'team_id must be an id.', { field: 'team_id' });
    const team = scope.teams.find((t) => t.team_id === teamId.toLowerCase());
    if (!team) throw ERRORS.notYourTeam();
    if (isBlank(team.share_folder)) throw ERRORS.noFolder();
    return { personId: null, teamId: team.team_id, root: `Shared/${team.share_folder}` };
  };
  // A rule the caller may manage: their own, or one of a team they are an active member of. (No administrator override: admin-wide rules are not in v1.)
  const ownsRule = (scope, rule) => (rule.owner_person_id ? rule.owner_person_id === scope.personId : scope.teamIds.includes(rule.owner_team_id));
  // The folder on the share a rule's owner has right now, as seen by the caller (their own alias, or a team of theirs); null when it was unset since.
  const rootOfRule = (scope, rule) => {
    if (rule.owner_person_id) return isBlank(scope.person?.uni_alias) ? null : `Users/${scope.person.uni_alias}`;
    const team = scope.teams.find((t) => t.team_id === rule.owner_team_id);
    return isBlank(team?.share_folder) ? null : `Shared/${team.share_folder}`;
  };

  router.get('/ignored-folders', route(async ({ res, acc }) => {
    const scope = await scopeOf(acc);
    const rows = scope.personId || scope.teamIds.length
      ? rowsOf(await database.raw(SQL.ignoredList, [scope.personId, scope.teamIds.join(',')]))
      : [];
    res.json(shapeIgnoredFolders(rows, !isViewerAccountability(acc)));
  }));

  router.post('/ignored-folders', route(async ({ req, res, acc }) => {
    const body = bodyOf(req);
    if (!body) throw badInput('The request must be { "folder": "...", "team_id": "..." (optional) }.');
    const scope = await scopeOf(acc);
    const owner = ignoreOwnerOf(scope, body.team_id);
    const folder = parseIgnoredFolder(body.folder, owner.root);
    const out = await inTransaction(acc.user, async (trx) => {
      // one rule at a time per owner, so the cap and the duplicate check cannot be raced past
      await trx.raw(SQL.lock, [`inbox-ignore:${owner.personId ?? owner.teamId}`]);
      const [{ n } = { n: 0 }] = rowsOf(await trx.raw(SQL.ignoredCount, [owner.personId, owner.teamId]));
      if (Number(n) >= MAX_IGNORED_PER_OWNER) throw ERRORS.tooManyRules();
      if (rowsOf(await trx.raw(SQL.ignoredFind, [owner.personId, owner.teamId, folder])).length) throw ERRORS.alreadyIgnored(folder);
      let rule;
      try {
        [rule] = rowsOf(await trx.raw(SQL.ignoredInsert, [owner.personId, owner.teamId, folder, acc.user]));
      } catch (err) {
        if (isUnique(err)) throw ERRORS.alreadyIgnored(folder);
        throw err;
      }
      // The owner's open files in the folder and below, dismissed with the SAME statement and state rule as POST /dismiss (only 'new' changes: linked and
      // gone files are untouched). The database only selects the owner's open rows; isIgnored decides which of them the rule covers, so a file the crawler would
      // still scan (the same rule, in Python) is never dismissed, and one it would skip is never missed, on the strength of a database case-folding difference.
      const open = rowsOf(await trx.raw(SQL.openUnderFolder, [owner.personId, owner.teamId]))
        .filter((r) => isIgnored(folderOfCandidate(r.rel_path, owner.root), [folder]));
      const done = open.length ? rowsOf(await trx.raw(SQL.dismiss, [acc.user, open.map((r) => r.candidate_id).join(',')])) : [];
      return shapeIgnoredAdded(rule, owner.teamId, done.length);
    });
    res.status(201).json({ data: out });
  }));

  router.delete('/ignored-folders/:id', route(async ({ req, res, acc }) => {
    const id = req.params?.id;
    if (!isUuid(id)) throw badInput('The ignored folder id is not valid.');
    const scope = await scopeOf(acc);
    const removed = await inTransaction(acc.user, async (trx) => {
      const [found] = rowsOf(await trx.raw(SQL.ignoredById, [id.toLowerCase()]));
      // a rule that is not yours is the same 404 as one that does not exist
      if (!found || !ownsRule(scope, found)) throw ERRORS.notIgnored();
      // the owner's rule lock, as POST takes it: two removals (of A and of A/B) must not each see the other's rule and both decide "still ignored", which would
      // leave a folder nobody ignores any more with a cache that says it was listed
      await trx.raw(SQL.lock, [`inbox-ignore:${found.owner_person_id ?? found.owner_team_id}`]);
      if (!rowsOf(await trx.raw(SQL.ignoredDelete, [found.ignored_id])).length) throw ERRORS.notIgnored();
      // Removing a rule that sits under another rule of the same owner (A/B while A is ignored) changes nothing the crawler does: the folder is still not
      // scanned, so its cache rows are left as they are and no rescan is asked for.
      const others = rowsOf(await trx.raw(SQL.ignoredOfOwner, [found.owner_person_id, found.owner_team_id])).map((r) => r.rel_folder);
      if (isIgnored(found.rel_folder, others)) return { rule: found, stillIgnored: true };
      // The folder's cache rows are reset, not deleted (see SQL.ignoredResetDirs), so the next scan lists the folder again. An owner whose folder was unset
      // since has no cache left to reset.
      const root = rootOfRule(scope, found);
      if (root) {
        const path = `${root}/${found.rel_folder}`;
        await trx.raw(SQL.ignoredResetDirs, [found.owner_person_id, found.owner_team_id, path, `${path}/`]);
      }
      return { rule: found, stillIgnored: false };
    });
    // A rescan, only where the limit of POST /rescan allows it (and not when the folder is still ignored: there is nothing new to list); the rule is gone
    // either way, so nothing here may fail the request.
    let queued = false;
    if (!removed.stillIgnored && scope.personId && (Boolean(scope.person?.uni_alias) || scope.teams.some((t) => !isBlank(t.share_folder)))) {
      try {
        await queueRescan(acc, scope);
        queued = true;
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 429)) logger?.warn?.(`${SOURCE}: could not queue a rescan after removing an ignored folder: ${err?.message || err}`);
      }
    }
    res.json({ data: shapeIgnoredRemoved(removed.rule, { stillIgnored: removed.stillIgnored, rescanQueued: queued }) });
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
