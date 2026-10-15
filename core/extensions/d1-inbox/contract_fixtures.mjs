// The Inbox contract fixtures: what d1-inbox answers, written down as golden files that STARbase's client tests read.
//
//   node core/extensions/d1-inbox/contract_fixtures.mjs        regenerates tests/fixtures/d1-inbox/*.json
//
// Every body here is produced by d1-inbox's REAL shaping code (fileOut, shapeSummary, shapeAcceptAll, shapeAdmin, shapeError, ...), never typed by
// hand, so a change to a shape changes a fixture. index.contract.test.mjs fails until the checked-in files are regenerated,
// and the STARbase tests (packages/starbase-pages/src/inbox/inboxContract.test.ts) then run the client's parsers over the new files, so a shape
// change cannot slip past the client. Fixtures are pretty-printed JSON with a stable key order; ids and times are fixed.
//
// A fixture is { description, request: { method, path, query | body }, status, body }. The requests are what the client is expected to send:
// the contract test checks the server accepts each one, and the client test checks the client sends the same.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ERRORS, FILTER_KEYS, FILTER_VALUES, HttpError, linkedItemOut, parseFileFilters, parseScanItem, shapeAcceptAll, shapeAcceptDryRun, shapeAdmin, shapeError, shapeFiles,
  shapeLink, shapePrefs, shapeQueued, shapeStateChange, shapeSummary, shapeUndo, unfit,
} from './index.js';

export const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/d1-inbox/', import.meta.url));

// ---- fixed ids and times ----------------------------------------------------------------------------------------------------
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_ALICE = ID(11);
const TEAM = ID(21);
const TEAM_NO_FOLDER = ID(22);
const S_EDIT = ID(101); // a sample the caller can edit ("S-0042")
const S_VIEW = ID(105); // a sample the caller can read but not edit
const S_HIDDEN = ID(104); // a Restricted sample the caller cannot read
const INSERT = ID(201); // a cutting insert ("H13A-#2")
const EDGE = ID(202); // one of its edges ("H13A-#2-fC")
const OPERATION = ID(102); // the operation that wore it
const SCAN = ID(6001); // a surface_scans row
const BATCH = ID(901);
const NOW = new Date('2026-10-15T12:00:00.000Z');
const at = (iso) => new Date(iso);

const LIST_PATH = '/d1-inbox/files';
const request = (method, path, rest = {}) => ({ method, path, ...rest });
const ok = (description, req, body, status = 200) => ({ description, request: req, status, body });
const failure = (description, req, err) => {
  const { status, body } = shapeError(err);
  return { description, request: req, status, body };
};

// ---- the found files --------------------------------------------------------------------------------------------------------

// A row as the list query selects it (LIST_SELECT): pg returns dates as Date, bigint and numeric as strings.
const row = (over) => ({
  candidate_id: ID(1000), directus_files_id: ID(3000), name: 'file.tif', mime_type: 'image/tiff', kind: 'image', kind_confidence: '0.90', extracted: {},
  origin: 'new', state: 'new', match_strength: 'none', matches: [], suggested_collection: null, suggested_record_id: null, duplicate_of: null,
  duplicate_of_owner: null, rel_path: 'Users/ali1/file.tif', size_bytes: '2500000', source_mtime: at('2026-10-10T09:00:00.000Z'),
  first_seen_at: at('2026-10-11T09:00:00.000Z'), decided_at: null, link_kind: null, linked_collection: null, link_batch_id: null, linked_record_id: null,
  decided_by_name: null, owner_person_id: P_ALICE, owner_team_id: null, owner_name: 'Alice A', adopted_at: null, ...over,
});
const named = (id, token, via = 'short_id') => [{ collection: 'physical_samples', record_id: id, via, token }];
const suggest = (id) => ({ suggested_collection: 'physical_samples', suggested_record_id: id });

const NEW_ORIGINAL = row({
  candidate_id: ID(1001), directus_files_id: ID(3001), name: '3fa9c1d2_A1.tif', kind: 'sem_image', kind_confidence: '0.95',
  extracted: { kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' }, match_strength: 'short_id', matches: named(S_EDIT, '3fa9c1d2'),
  ...suggest(S_EDIT), rel_path: 'Users/ali1/sem/3fa9c1d2_A1.tif', size_bytes: '3145728',
});
const COPY = row({
  candidate_id: ID(1002), directus_files_id: ID(3002), name: '3fa9c1d2_A1.tif', kind: 'sem_image', kind_confidence: '0.95',
  match_strength: 'short_id', matches: named(S_EDIT, '3fa9c1d2'), ...suggest(S_EDIT), duplicate_of: ID(1001), duplicate_of_owner: 'Alice A',
  rel_path: 'Shared/SEM/2026/3fa9c1d2_A1.tif', owner_person_id: null, owner_team_id: TEAM, owner_name: 'SEM team',
});
const SURFACE_SCAN = row({
  candidate_id: ID(1003), directus_files_id: ID(3003), name: 'scan_0007.nid', mime_type: null, kind: 'surface_scan', kind_confidence: '0.80',
  rel_path: 'Users/ali1/afm/scan_0007.nid', size_bytes: '52428800',
});
const DOCUMENT = row({
  candidate_id: ID(1004), directus_files_id: ID(3004), name: 'S-0042_notes.pdf', mime_type: 'application/pdf', kind: 'document', kind_confidence: null,
  match_strength: 'code', matches: named(S_EDIT, 'S-0042', 'code'), ...suggest(S_EDIT), rel_path: 'Users/ali1/reports/S-0042_notes.pdf', size_bytes: '120000',
});
const NOT_EDITABLE = row({
  candidate_id: ID(1005), directus_files_id: ID(3005), name: 'abcd1234_B2.tif', kind: 'image', match_strength: 'short_id', matches: named(S_VIEW, 'abcd1234'),
  ...suggest(S_VIEW), rel_path: 'Users/ali1/abcd1234_B2.tif',
});
const HIDDEN_RECORD = row({
  candidate_id: ID(1006), directus_files_id: ID(3006), name: 'ffff0000_C3.tif', kind: 'image', match_strength: 'short_id', matches: named(S_HIDDEN, 'ffff0000'),
  ...suggest(S_HIDDEN), rel_path: 'Users/ali1/ffff0000_C3.tif',
});
const BACKLOG_EXACT = row({
  candidate_id: ID(1007), directus_files_id: ID(3007), name: '3fa9c1d2_old.tif', kind: 'sem_image', kind_confidence: '0.90', origin: 'backlog',
  match_strength: 'short_id', matches: named(S_EDIT, '3fa9c1d2'), ...suggest(S_EDIT), rel_path: 'Users/ali1/2024/3fa9c1d2_old.tif', source_mtime: at('2024-03-02T10:00:00.000Z'),
  first_seen_at: at('2026-10-01T08:00:00.000Z'),
});
const LINKED_AUTO = row({
  candidate_id: ID(1008), directus_files_id: ID(3008), name: '3fa9c1d2_A2.tif', kind: 'sem_image', kind_confidence: '0.95', state: 'linked',
  match_strength: 'short_id', matches: named(S_EDIT, '3fa9c1d2'), ...suggest(S_EDIT), rel_path: 'Users/ali1/sem/3fa9c1d2_A2.tif', decided_at: at('2026-10-14T16:00:00.000Z'),
  link_kind: 'auto', linked_collection: 'physical_samples', linked_record_id: S_EDIT, link_batch_id: BATCH, decided_by_name: 'Alice A', adopted_at: null,
});
const LINKED_MANUAL = row({
  candidate_id: ID(1009), directus_files_id: ID(3009), name: 'S-0042_notes.pdf', mime_type: 'application/pdf', kind: 'document', kind_confidence: null, state: 'linked',
  match_strength: 'code', matches: named(S_EDIT, 'S-0042', 'code'), ...suggest(S_EDIT), rel_path: 'Users/ali1/reports/S-0042_final.pdf', decided_at: at('2026-10-14T17:30:00.000Z'),
  link_kind: 'manual', linked_collection: 'physical_samples', linked_record_id: S_EDIT, link_batch_id: ID(902), decided_by_name: 'Alice A', adopted_at: at('2026-10-14T17:30:00.000Z'),
});
const LINKED_SCAN = row({
  candidate_id: ID(1012), directus_files_id: ID(3012), name: 'H13A-2_fC_worn.al3d', mime_type: null, kind: 'surface_scan', kind_confidence: '1.00', state: 'linked',
  rel_path: 'Users/ali1/alicona/H13A-2_fC_worn.al3d', size_bytes: '52428800', decided_at: at('2026-10-15T09:30:00.000Z'), link_kind: 'manual',
  linked_collection: 'surface_scans', linked_record_id: SCAN, link_batch_id: ID(903), decided_by_name: 'Alice A', adopted_at: null,
});
const DOC_EXACT = row({
  candidate_id: ID(1011), directus_files_id: ID(3011), name: '3fa9c1d2_report.pdf', mime_type: 'application/pdf', kind: 'document', kind_confidence: null,
  match_strength: 'short_id', matches: named(S_EDIT, '3fa9c1d2'), ...suggest(S_EDIT), rel_path: 'Users/ali1/reports/3fa9c1d2_report.pdf', size_bytes: '88000',
});
const DISMISSED = row({
  candidate_id: ID(1010), directus_files_id: ID(3010), name: 'IMG_0001.jpg', mime_type: 'image/jpeg', kind: 'image', state: 'dismissed', rel_path: 'Users/ali1/IMG_0001.jpg',
  decided_at: at('2026-10-13T09:00:00.000Z'), decided_by_name: 'Alice A',
});

// What the caller may read, name and edit: S_EDIT is theirs to edit, S_VIEW only to read, S_HIDDEN not even to read.
const INFO = {
  readable: new Set([`physical_samples:${S_EDIT}`, `physical_samples:${S_VIEW}`, `surface_scans:${SCAN}`]),
  labels: new Map([[`physical_samples:${S_EDIT}`, 'S-0042'], [`physical_samples:${S_VIEW}`, 'S-0050'], [`surface_scans:${SCAN}`, 'H13A-#2-fC (worn)']]),
  editable: new Set([`physical_samples:${S_EDIT}`]),
  // a surface scan the list names: the edge (or insert) it was added to
  scans: new Map([[SCAN, { insert_id: null, edge_id: EDGE }]]),
};
// What accept-all does with `rows`: the rows its query reads (an exact short ID naming one record: buildListQuery's accept filter), sorted by the
// endpoint's own unfit() and the caller's edit rights into what it links and what it leaves.
const reads = (c) => c.state === 'new' && c.match_strength === 'short_id' && c.suggested_record_id && c.kind !== 'surface_scan' && !c.duplicate_of && c.matches.length === 1;
function acceptPlan(rows) {
  const entries = [];
  const skipped = [];
  for (const cand of rows.filter(reads)) {
    const why = unfit(cand, { auto: false }) ?? (INFO.editable.has(`${cand.suggested_collection}:${cand.suggested_record_id}`) ? null : 'NOT_EDITABLE');
    if (why) skipped.push({ candidate_id: cand.candidate_id, reason: why });
    else entries.push({ cand });
  }
  return { entries, skipped };
}
const IMAGE_KINDS = ['sem_image', 'image', 'surface_scan'];
const linkedItems = (entries) => entries.map(({ cand }) => ({
  candidate_id: cand.candidate_id, collection: cand.suggested_collection, record_id: cand.suggested_record_id, junction_id: ID(5000 + (Number(cand.candidate_id.slice(-4)) - 1000)),
  adopted: !IMAGE_KINDS.includes(cand.kind),
}));
const list = (rows, query, total = rows.length, acceptable = null) => {
  const f = parseFileFilters(query);
  return ok(`GET ${LIST_PATH}?${new URLSearchParams(query)}`, request('GET', LIST_PATH, { query }), shapeFiles(rows, INFO, { total, limit: f.limit, offset: f.offset, acceptable }));
};

// ---- the summary ------------------------------------------------------------------------------------------------------------

const summaryRow = (over) => ({ owner_person_id: P_ALICE, owner_team_id: null, origin: 'new', exact: false, n: 0, ...over });
const SUMMARY_ROWS = [
  summaryRow({ n: 3 }), // 3 new
  summaryRow({ origin: 'backlog', exact: true, n: 2 }), // 2 older files that name one record
  summaryRow({ origin: 'backlog', exact: false, n: 9 }), // older files that name nothing: not counted
  summaryRow({ owner_person_id: null, owner_team_id: TEAM, n: 4 }),
  summaryRow({ owner_person_id: null, owner_team_id: TEAM, origin: 'backlog', exact: true, n: 1 }),
];
const summary = (description, rows, scope, teams, person) => ok(description, request('GET', '/d1-inbox/summary'), { data: shapeSummary(rows, scope, teams, person) });

// ---- accept-all --------------------------------------------------------------------------------------------------------------

const ALL_NEW = [NEW_ORIGINAL, COPY, SURFACE_SCAN, DOCUMENT, NOT_EDITABLE, HIDDEN_RECORD, DOC_EXACT];
const FILTER = { tab: 'new', strength: 'short_id' };
// ---- the admin page ----------------------------------------------------------------------------------------------------------

const crawlerState = (over) => ({
  desired_state: 'running', interval_minutes: 30, read_mb_per_s: '60', last_heartbeat_at: at('2026-10-15T11:59:30.000Z'), daemon_started_at: at('2026-10-15T08:00:00.000Z'),
  current_activity: 'idle', last_scan_started_at: at('2026-10-15T11:30:00.000Z'), last_scan_finished_at: at('2026-10-15T11:45:00.000Z'), files_registered: '42', error_count: 1,
  last_error: 'share briefly unreachable', unmatched_folders: ['Users/zz9', 'Shared/Old project'], ...over,
});
const ADMIN_REST = {
  people: [{ person_id: ID(14), full_name: 'Dave D', active: true, has_login: true }, { person_id: ID(18), full_name: 'Fay Former', active: false, has_login: false }],
  totals: [{ state: 'new', n: 5 }, { state: 'linked', n: 2 }, { state: 'dismissed', n: 1 }],
  failed: [{ at: at('2026-10-15T10:00:00.000Z'), error: 'Users/ali1 is not readable' }],
  queue: { queued: 1, running: 0 },
};
const admin = (description, state) => ok(description, request('GET', '/d1-inbox/admin'), { data: shapeAdmin({ ...ADMIN_REST, state }, NOW) });

// ---- the fixtures -----------------------------------------------------------------------------------------------------------

export function buildFixtures() {
  const out = new Map();
  const put = (name, fixture) => out.set(`${name}.json`, fixture);

  // GET /files
  put('files_new', list(ALL_NEW, { tab: 'new', kind: 'sem_image,surface_scan,image,document,other', limit: '50', offset: '0' }));
  put('files_new_acceptable', list([NEW_ORIGINAL, NOT_EDITABLE], { tab: 'new', strength: 'short_id', acceptable: '1', limit: '50' }, 2, acceptPlan([NEW_ORIGINAL, NOT_EDITABLE]).entries.length));
  put('files_older', list([BACKLOG_EXACT], { tab: 'older', owner: 'me', limit: '50' }));
  put('files_linked', list([LINKED_AUTO, LINKED_MANUAL], { tab: 'linked', link_kind: 'auto', limit: '20' }, 2));
  put('files_linked_surface_scan', list([LINKED_SCAN], { tab: 'linked', link_kind: 'manual', limit: '20' }, 1));
  put('files_dismissed', list([DISMISSED], { tab: 'dismissed', limit: '50' }));
  put('files_team_folder', list([COPY], { tab: 'new', owner: `team:${TEAM}`, folder: 'sem', from: '2026-10-01', to: '2026-10-15', limit: '50' }));
  put('files_empty', list([], { tab: 'new', limit: '50' }, 0));
  put('files_400_bad_filter', failure('a filter the server refuses', request('GET', LIST_PATH, { query: { kind: 'video' } }), (() => { try { parseFileFilters({ kind: 'video' }); } catch (e) { return e; } return new Error('expected a 400'); })()));

  // GET /summary
  const scope = { personId: P_ALICE, teamIds: [TEAM], admin: false };
  const person = { uni_alias: 'ali1' };
  const teams = [{ team_id: TEAM, name: 'SEM team', share_folder: 'SEM' }, { team_id: TEAM_NO_FOLDER, name: 'No folder team', share_folder: null }];
  put('summary_person_alias_team', summary('a person with an alias and one team that has a share folder (a team with none is left out)', SUMMARY_ROWS, scope, teams, person));
  put('summary_person_no_alias', summary('a person whose uni alias is not set yet: has_alias is false', [], { personId: P_ALICE, teamIds: [], admin: false }, [], { uni_alias: null }));
  put('summary_no_person', summary('a login with no People row (an administrator): no person block', [], { personId: null, teamIds: [], admin: true }, [], null));

  // POST /link
  const linkReq = (items) => request('POST', '/d1-inbox/link', { body: { items } });
  const oneLink = [{ candidate_id: ID(1001), collection: 'physical_samples', record_id: S_EDIT }];
  put('link_ok', ok('one file linked', linkReq(oneLink), { data: shapeLink({ link_batch_id: BATCH, newly: 1, items: linkedItems([{ cand: NEW_ORIGINAL }]) }) }));
  put('link_ok_bulk', ok('two files linked in one batch', linkReq([...oneLink, { candidate_id: ID(1011), collection: 'physical_samples', record_id: S_EDIT }]),
    { data: shapeLink({ link_batch_id: BATCH, newly: 2, items: linkedItems([{ cand: NEW_ORIGINAL }, { cand: DOC_EXACT }]) }) }));
  put('link_already_linked', ok('the same person repeats the same link: no new batch, a count of 0', linkReq(oneLink),
    { data: shapeLink({ link_batch_id: null, newly: 0, items: linkedItems([{ cand: NEW_ORIGINAL }]).map((i) => ({ ...i, already_linked: true })) }) }));
  put('link_403_not_editable', failure('the caller cannot edit the record', linkReq(oneLink), ERRORS.notEditable(ID(1001), 'physical_samples', S_EDIT)));
  put('link_409_already_linked', failure('someone else linked the file first', linkReq(oneLink), ERRORS.alreadyLinked(ID(1001))));
  put('link_409_already_on_record', failure('the file is already on the record (linked in Data Studio)', linkReq(oneLink), ERRORS.alreadyOnRecord(ID(1001))));
  put('link_409_surface_scan', failure('a surface scan is never linked to a sample, operation or test: it is added to an insert or an edge',
    linkReq([{ candidate_id: ID(1003), collection: 'physical_samples', record_id: S_EDIT }]), ERRORS.surfaceScan(ID(1003))));

  // POST /link, a surface scan: { candidate_id, collection: 'surface_scans', insert_id | edge_id, condition, operation_id?, scanned_on?, condition_note?, notes? }
  const scanItem = { candidate_id: ID(1003), collection: 'surface_scans', insert_id: INSERT, condition: 'worn' };
  const scanReq = (item = scanItem) => linkReq([item]);
  const asEntry = (item) => ({ cand: SURFACE_SCAN, collection: 'surface_scans', scan: parseScanItem(item) });
  const refusal = (item) => { try { parseScanItem(item); } catch (e) { return e; } return new Error('expected a 400'); };
  put('link_surface_scan_ok', ok('a surface scan added to an insert (the condition is the only thing the person must choose)', scanReq(),
    { data: shapeLink({ link_batch_id: BATCH, newly: 1, items: [linkedItemOut(asEntry(scanItem), SCAN, false)] }) }));
  const fullItem = { candidate_id: ID(1003), collection: 'surface_scans', edge_id: EDGE, condition: 'cleaned', operation_id: OPERATION, scanned_on: '2026-10-14', condition_note: 'ultrasonic bath', notes: 'after pass 3' };
  put('link_surface_scan_ok_edge', ok('a surface scan added to an edge, with the operation, the day and notes', scanReq(fullItem),
    { data: shapeLink({ link_batch_id: BATCH, newly: 1, items: [linkedItemOut(asEntry(fullItem), SCAN, false)] }) }));
  put('link_surface_scan_ok_mixed', ok('a sample link and a surface scan in one batch', linkReq([...oneLink, scanItem]),
    { data: shapeLink({ link_batch_id: BATCH, newly: 2, items: [...linkedItems([{ cand: NEW_ORIGINAL }]), linkedItemOut(asEntry(scanItem), SCAN, false)] }) }));
  put('link_surface_scan_already_linked', ok('the same person repeats the same add: no new batch, a count of 0', scanReq(),
    { data: shapeLink({ link_batch_id: null, newly: 0, items: [{ ...linkedItemOut(asEntry(scanItem), SCAN, false), already_linked: true }] }) }));
  const noCondition = { candidate_id: ID(1003), collection: 'surface_scans', insert_id: INSERT };
  put('link_surface_scan_400_condition', failure('no condition: the person always chooses it, it is never defaulted', scanReq(noCondition), refusal(noCondition)));
  const bothItems = { ...scanItem, edge_id: EDGE };
  put('link_surface_scan_400_item', failure('both an insert and an edge: exactly one is needed', scanReq(bothItems), refusal(bothItems)));
  const badDay = { ...scanItem, scanned_on: '15/10/2026' };
  put('link_surface_scan_400_date', failure('a day that is not YYYY-MM-DD', scanReq(badDay), refusal(badDay)));
  put('link_surface_scan_404_not_found', failure('the insert, edge or operation does not exist or the caller cannot read it (the same answer)', scanReq(),
    ERRORS.scanRefMissing(ID(1003), 'insert', INSERT)));
  put('link_surface_scan_403_not_allowed', failure('the caller may not create surface scans', scanReq(), ERRORS.scanNotAllowed(ID(1003))));
  put('link_surface_scan_409_already_added', failure('the file is already a surface scan of that insert or edge (the table\'s unique constraint); the whole batch is rolled back',
    scanReq(), ERRORS.alreadyAdded(ID(1003))));
  put('link_surface_scan_409_unavailable', failure('there is no surface_scans table yet (the feature check)', scanReq(), ERRORS.scansUnavailable()));
  put('link_409_not_a_surface_scan', failure('only a surface_scan file can be added as a surface scan', request('POST', '/d1-inbox/link', { body: { items: [{ ...scanItem, candidate_id: ID(1001) }] } }),
    ERRORS.notASurfaceScan(ID(1001))));

  // POST /accept-all
  const acceptReq = (extra) => request('POST', '/d1-inbox/accept-all', { body: { filter: FILTER, ...extra } });
  const plan = acceptPlan(ALL_NEW);
  const planIds = plan.entries.map((e) => e.cand.candidate_id);
  // the keyset cursor accept-all hands back (the last row read: its first_seen_at and id), as base64url JSON
  const cursor = Buffer.from(JSON.stringify(['2026-10-11T09:00:00.000Z', ID(1011)])).toString('base64url');
  put('accept_all_dry_run', ok('a dry run: what would be linked and what would be left', acceptReq({ dry_run: true }),
    { data: shapeAcceptDryRun({ ...plan, has_more: false, next_cursor: null }) }));
  put('accept_all_dry_run_has_more', ok('a dry run that stopped at its page cap: has_more and a cursor to carry on', acceptReq({ dry_run: true }),
    { data: shapeAcceptDryRun({ ...plan, has_more: true, next_cursor: cursor }) }));
  put('accept_all_dry_run_none', ok('a dry run with nothing to link', acceptReq({ dry_run: true }),
    { data: shapeAcceptDryRun({ ...acceptPlan([NOT_EDITABLE, HIDDEN_RECORD]), has_more: false, next_cursor: null }) }));
  put('accept_all_real', ok('accept-all for a filter', acceptReq({}),
    { data: shapeAcceptAll({ batchId: BATCH, items: linkedItems(plan.entries), skipped: plan.skipped, has_more: false, next_cursor: null }) }));
  put('accept_all_real_candidate_ids', ok('accept-all for exactly the files a dry run listed', acceptReq({ candidate_ids: planIds }),
    { data: shapeAcceptAll({ batchId: BATCH, items: linkedItems(plan.entries), skipped: [], has_more: false, next_cursor: null }) }));
  put('accept_all_real_none', ok('accept-all that linked nothing: no batch', acceptReq({}),
    { data: shapeAcceptAll({ batchId: null, items: [], skipped: acceptPlan([NOT_EDITABLE, HIDDEN_RECORD]).skipped, has_more: false, next_cursor: null }) }));

  // POST /dismiss, /restore, /undo
  put('dismiss_ok', ok('one file dismissed, one already was', request('POST', '/d1-inbox/dismiss', { body: { candidate_ids: [ID(1001), ID(1010)] } }),
    { data: shapeStateChange({ done: [ID(1001)], unchanged: [ID(1010)], change: [ID(1001)] }) }));
  put('restore_ok', ok('one file restored', request('POST', '/d1-inbox/restore', { body: { candidate_ids: [ID(1010)] } }),
    { data: shapeStateChange({ done: [ID(1010)], unchanged: [], change: [ID(1010)] }) }));
  put('dismiss_409_not_new', failure('the file was linked meanwhile', request('POST', '/d1-inbox/dismiss', { body: { candidate_ids: [ID(1008)] } }),
    new HttpError(409, 'NOT_NEW', 'That file was already linked or is gone.', { candidate_id: ID(1008) })));
  put('undo_ok', ok('a batch undone', request('POST', '/d1-inbox/undo', { body: { link_batch_id: BATCH } }), { data: shapeUndo(BATCH, [{}, {}]) }));
  put('undo_ok_surface_scan', ok('a batch that added a surface scan undone: the scan row is deleted, the file returns to new', request('POST', '/d1-inbox/undo', { body: { link_batch_id: ID(903) } }),
    { data: shapeUndo(ID(903), [{}]) }));
  put('undo_403_surface_scan', failure('the caller may no longer delete the scan: nothing is undone', request('POST', '/d1-inbox/undo', { body: { link_batch_id: ID(903) } }),
    ERRORS.scanUndoDenied(ID(1003))));
  put('undo_404', failure('a batch that does not exist or was already undone', request('POST', '/d1-inbox/undo', { body: { link_batch_id: BATCH } }),
    new HttpError(404, 'NOT_FOUND', 'That batch does not exist or was already undone.')));

  // POST /rescan, /admin/scan-all
  const queued = { request_id: ID(7001), status: 'queued', requested_at: NOW };
  put('rescan_202', ok('a rescan queued', request('POST', '/d1-inbox/rescan', { body: {} }), { data: shapeQueued(queued) }, 202));
  put('rescan_429', failure('a rescan within 10 minutes of the last (or while one waits)', request('POST', '/d1-inbox/rescan', { body: {} }), ERRORS.rateLimited(420)));
  put('rescan_409_no_folder', failure('a person with no folder', request('POST', '/d1-inbox/rescan', { body: {} }), ERRORS.noFolder()));
  put('scan_all_202', ok('a scan of every folder queued', request('POST', '/d1-inbox/admin/scan-all', { body: {} }), { data: shapeQueued({ ...queued, request_id: ID(7002) }) }, 202));
  put('scan_all_409_already_queued', failure('one already waits', request('POST', '/d1-inbox/admin/scan-all', { body: {} }), ERRORS.alreadyQueued(ID(7002))));

  // GET and PUT /prefs
  put('prefs_get_off', ok('auto-link off (the default)', request('GET', '/d1-inbox/prefs'), { data: shapePrefs(undefined) }));
  put('prefs_put_on', ok('auto-link turned on', request('PUT', '/d1-inbox/prefs', { body: { auto_link: true } }), { data: shapePrefs({ auto_link: true }) }));

  // GET /admin
  put('admin_alive', admin('a daemon that heartbeated 30 s ago', crawlerState({})));
  put('admin_paused', admin('a daemon that beats but is told to pause', crawlerState({ desired_state: 'paused' })));
  put('admin_stale', admin('a daemon that has not heartbeated for an hour (stale wins over paused)', crawlerState({ desired_state: 'paused', last_heartbeat_at: at('2026-10-15T11:00:00.000Z') })));
  put('admin_never', admin('no state row yet: the daemon never started', undefined));
  put('admin_403', failure('a person who is not an administrator', request('GET', '/d1-inbox/admin'), ERRORS.adminOnly()));

  // errors every route can answer
  put('error_401', failure('no signed-in user', request('GET', '/d1-inbox/summary'), new HttpError(401, 'UNAUTHORIZED', 'Sign in first.')));
  put('error_403_read_only', failure('a Lab Viewer writes', request('POST', '/d1-inbox/link', { body: { items: oneLink } }), ERRORS.readOnly()));
  put('error_500', failure('an unexpected failure says nothing of its cause', request('GET', '/d1-inbox/summary'), new Error('relation "d1_private.file_candidates" does not exist')));

  // the query side
  const cases = [
    { tab: 'new' }, { tab: 'older', owner: 'me' }, { tab: 'linked', link_kind: 'auto', limit: '20' }, { kind: 'sem_image,surface_scan,image', strength: 'short_id,code' },
    { folder: ' SEM ', from: '2026-10-01', to: '2026-10-15', owner: `team:${TEAM}`, offset: '50', limit: '500' }, { tab: 'open', acceptable: '1' },
  ];
  put('filters_parse', {
    description: 'what parseFileFilters makes of a list query string (the accept-all filter is read by the same function, default tab open)',
    cases: cases.map((query) => ({ query, parsed: parseFileFilters(query) })),
  });
  put('filter_keys', {
    description: 'the keys parseFileFilters reads: a list query and accept-all.filter may carry these and nothing else, and these values',
    keys: FILTER_KEYS,
    values: { tab: FILTER_VALUES.tab, kind: FILTER_VALUES.kind, strength: FILTER_VALUES.strength, link_kind: FILTER_VALUES.link_kind },
    owner_forms: ['me', 'team:<uuid>', 'person:<uuid>'],
    limit: { default: FILTER_VALUES.default_limit, max: FILTER_VALUES.max_limit },
  });
  return out;
}

export const fixtureText = (fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

export function writeFixtures(dir = FIXTURE_DIR) {
  mkdirSync(dir, { recursive: true });
  const wanted = buildFixtures();
  for (const name of readdirSync(dir)) if (name.endsWith('.json') && !wanted.has(name)) rmSync(`${dir}${name}`);
  for (const [name, fixture] of wanted) writeFileSync(`${dir}${name}`, fixtureText(fixture));
  return [...wanted.keys()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const names = writeFixtures();
  console.log(`wrote ${names.length} fixtures to ${FIXTURE_DIR}`);
}
