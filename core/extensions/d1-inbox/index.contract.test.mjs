// The server half of the Inbox contract test. Run with: node --test core/extensions/d1-inbox/index.contract.test.mjs
//
// d1-inbox's answers are written down as golden files in tests/fixtures/d1-inbox/ (contract_fixtures.mjs makes them from the real shaping code);
// STARbase's client tests (packages/starbase-pages/src/inbox/inboxContract.test.ts) read the same files. So:
//   * this test fails when a shape changes until the fixtures are regenerated (`node core/extensions/d1-inbox/contract_fixtures.mjs`), and the
//     regenerated files then fail the client's tests until the client follows;
//   * the requests the fixtures show are checked against the server's own validators;
//   * filter_keys.json is checked to be the truth about what parseFileFilters and buildListQuery read.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { FIXTURE_DIR, buildFixtures, fixtureText } from './contract_fixtures.mjs';
import { FILTER_KEYS, FILTER_VALUES, LINK_COLLECTIONS, SCAN_CONDITIONS, buildListQuery, parseFileFilters, parseIgnoredFolder, parseScanItem, shapeAcceptAll } from './index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const built = buildFixtures();
const onDisk = () => readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json')).sort();
const read = (name) => JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8'));

test('the checked-in fixtures are exactly what the endpoint produces now (byte for byte)', () => {
  assert.deepEqual(onDisk(), [...built.keys()].sort(), 'fixture files added or removed: run node core/extensions/d1-inbox/contract_fixtures.mjs');
  for (const [name, fixture] of built) {
    assert.equal(
      readFileSync(`${FIXTURE_DIR}${name}`, 'utf8'), fixtureText(fixture),
      `tests/fixtures/d1-inbox/${name} is out of date: d1-inbox's answer changed. Run node core/extensions/d1-inbox/contract_fixtures.mjs, then fix STARbase's client (packages/starbase-pages/src/inbox/inboxApi.ts) until its contract test passes.`,
    );
  }
});

test('the fixtures are the cases the client has to handle', () => {
  const names = new Set(built.keys());
  for (const wanted of [
    'files_new', 'files_older', 'files_linked', 'files_dismissed', 'files_new_acceptable', 'summary_person_alias_team', 'summary_person_no_alias', 'summary_no_person',
    'accept_all_dry_run', 'accept_all_dry_run_has_more', 'accept_all_real', 'accept_all_real_candidate_ids', 'link_ok', 'link_already_linked', 'link_403_not_editable',
    'link_409_already_linked', 'link_409_surface_scan', 'link_409_not_a_surface_scan', 'link_surface_scan_ok', 'link_surface_scan_ok_edge', 'link_surface_scan_ok_mixed',
    'link_surface_scan_already_linked', 'link_surface_scan_400_condition', 'link_surface_scan_400_item', 'link_surface_scan_400_date', 'link_surface_scan_404_not_found',
    'link_surface_scan_403_not_allowed', 'link_surface_scan_409_already_added', 'link_surface_scan_409_unavailable', 'files_linked_surface_scan', 'undo_ok_surface_scan',
    'undo_403_surface_scan', 'undo_ok', 'dismiss_ok', 'restore_ok', 'rescan_202', 'rescan_429', 'rescan_409_no_folder', 'prefs_get_off', 'prefs_put_on',
    'admin_alive', 'admin_paused', 'admin_stale', 'admin_never', 'scan_all_202', 'scan_all_409_already_queued', 'filter_keys',
    'ignored_get', 'ignored_get_viewer', 'ignored_get_empty', 'ignored_post_ok', 'ignored_post_ok_team', 'ignored_post_400_folder', 'ignored_post_400_root',
    'ignored_post_403_team', 'ignored_post_409_no_folder', 'ignored_post_409_already_ignored', 'ignored_post_409_too_many_rules', 'ignored_delete_ok',
    'ignored_delete_ok_rate_limited', 'ignored_delete_404',
  ]) assert.ok(names.has(`${wanted}.json`), `missing fixture ${wanted}`);
  const rows = built.get('files_new.json').body.data;
  assert.ok(rows.some((r) => r.kind === 'sem_image' && r.suggested_label), 'a new original with a suggestion');
  assert.ok(rows.some((r) => r.duplicate_of), 'a copy');
  assert.ok(rows.some((r) => r.kind === 'surface_scan'), 'a surface scan');
  assert.ok(rows.some((r) => r.kind === 'document'), 'a document');
  assert.ok(built.get('files_older.json').body.data.some((r) => r.origin === 'backlog' && r.match_strength === 'short_id'), 'a backlog exact match');
  assert.ok(built.get('files_linked.json').body.data.some((r) => r.link_kind === 'auto' && r.state === 'linked'), 'a row linked by auto');
});

test('every request in a fixture is one the server accepts', () => {
  for (const [name, fx] of built) {
    const req = fx.request;
    if (!req) continue;
    const label = `${name}: ${req.method} ${req.path}`;
    if (req.path === '/d1-inbox/files') {
      if (fx.status === 200) {
        const parsed = parseFileFilters(req.query);
        assert.deepEqual(Object.keys(req.query).filter((k) => !FILTER_KEYS.includes(k)), [], `${label} sends a key the server ignores`);
        assert.equal(fx.body.meta.limit, parsed.limit, label);
        assert.equal(fx.body.meta.offset, parsed.offset, label);
      }
      continue;
    }
    const body = req.body ?? {};
    if (req.path.startsWith('/d1-inbox/ignored-folders')) {
      if (req.method === 'POST') {
        assert.deepEqual(Object.keys(body).filter((k) => !['folder', 'team_id'].includes(k)), [], `${label} sends a key the server ignores`);
        if (body.team_id !== undefined) assert.match(body.team_id, UUID, label);
        if (fx.status === 400) {
          // the 400 fixtures are the folders the server's own parser refuses, with the message and field they show
          assert.throws(() => parseIgnoredFolder(body.folder, 'Users/ali1'), (e) => e.status === 400 && e.message === fx.body.errors[0].message && e.extra.field === 'folder', label);
        } else {
          assert.equal(typeof body.folder, 'string', label);
          if (fx.status === 201) assert.doesNotThrow(() => parseIgnoredFolder(body.folder, 'Users/ali1'), label);
        }
      } else if (req.method === 'DELETE') {
        assert.match(req.path.slice('/d1-inbox/ignored-folders/'.length), UUID, label);
      } else {
        assert.equal(req.path, '/d1-inbox/ignored-folders', label);
      }
    } else if (req.path === '/d1-inbox/link') {
      assert.ok(body.items.length >= 1 && body.items.length <= 200, label);
      for (const i of body.items) {
        assert.match(i.candidate_id, UUID, label);
        assert.ok(LINK_COLLECTIONS.includes(i.collection), `${label}: ${i.collection}`);
        if (i.collection === 'surface_scans') {
          // a surface scan item is checked by the server's own parser: the 400 fixtures are the ones it refuses, with the message and field they show
          if (fx.status === 400) {
            assert.throws(() => parseScanItem(i), (e) => e.status === 400 && e.message === fx.body.errors[0].message && e.extra.field === fx.body.errors[0].extensions.field, label);
          } else {
            assert.doesNotThrow(() => parseScanItem(i), label);
          }
          assert.deepEqual(Object.keys(i).filter((k) => !['candidate_id', 'collection', 'insert_id', 'edge_id', 'condition', 'operation_id', 'scanned_on', 'condition_note', 'notes'].includes(k)), [], `${label} sends a field the server drops`);
        } else {
          assert.match(i.record_id, UUID, label);
        }
      }
    } else if (req.path === '/d1-inbox/accept-all') {
      const parsed = parseFileFilters(body.filter, { defaultTab: 'open' });
      assert.deepEqual(Object.keys(body.filter).filter((k) => !FILTER_KEYS.includes(k)), [], `${label} sends a filter key the server ignores`);
      assert.ok(parsed.tab, label);
      if (body.dry_run !== undefined) assert.equal(typeof body.dry_run, 'boolean', label);
      for (const id of body.candidate_ids ?? []) assert.match(id, UUID, label);
      assert.deepEqual(Object.keys(body).filter((k) => !['filter', 'dry_run', 'candidate_ids', 'cursor'].includes(k)), [], label);
    } else if (req.path === '/d1-inbox/dismiss' || req.path === '/d1-inbox/restore') {
      assert.ok(body.candidate_ids.length >= 1, label);
      for (const id of body.candidate_ids) assert.match(id, UUID, label);
    } else if (req.path === '/d1-inbox/undo') {
      assert.match(body.link_batch_id, UUID, label);
    } else if (req.path === '/d1-inbox/prefs' && req.method === 'PUT') {
      assert.deepEqual(Object.keys(body), ['auto_link'], label);
      assert.equal(typeof body.auto_link, 'boolean', label);
    }
  }
});

test('every answer has the envelope the client reads: { data } with a status, or Directus errors with extensions.code and source', () => {
  for (const [name, fx] of built) {
    if (!fx.request) continue;
    if (fx.status >= 400) {
      assert.equal(fx.body.errors.length, 1, name);
      const [e] = fx.body.errors;
      assert.equal(typeof e.message, 'string', name);
      assert.equal(typeof e.extensions.code, 'string', name);
      assert.equal(e.extensions.source, 'd1-inbox', name);
    } else {
      assert.ok(fx.body.data !== undefined, `${name} has no data`);
      assert.deepEqual(Object.keys(fx.body).filter((k) => k !== 'data' && k !== 'meta'), [], name);
      assert.equal('meta' in fx.body, fx.request.path === '/d1-inbox/files', `${name}: only the list carries meta`);
    }
  }
  assert.equal(read('rescan_429.json').body.errors[0].extensions.retry_after_seconds, 420);
});

// ---- filter_keys.json is the truth about what the server reads -----------------------------------------------------------------

const SCOPE = { personId: '00000000-0000-4000-8000-000000000011', teamIds: ['00000000-0000-4000-8000-000000000021'], admin: false };
const TEAM = '00000000-0000-4000-8000-000000000021';
// For each accepted key: a value, and where the server shows it was read (the parse, and the query's bindings).
const PROBES = {
  tab: { value: 'older', parsed: (f) => f.tab === 'older', bound: null },
  kind: { value: 'image,document', parsed: (f) => f.kinds?.join() === 'image,document', bound: 'image,document' },
  strength: { value: 'short_id,code', parsed: (f) => f.strengths?.join() === 'short_id,code', bound: 'short_id,code' },
  folder: { value: 'sem', parsed: (f) => f.folder === 'sem', bound: 'sem' },
  from: { value: '2026-10-01', parsed: (f) => f.date_from === '2026-10-01', bound: '2026-10-01' },
  to: { value: '2026-10-15', parsed: (f) => f.date_to === '2026-10-15', bound: '2026-10-15' },
  owner: { value: `team:${TEAM}`, parsed: (f) => f.owner?.kind === 'team' && f.owner.id === TEAM, bound: TEAM },
  link_kind: { value: 'auto', parsed: (f) => f.link_kind === 'auto', bound: 'auto' },
  acceptable: { value: '1', parsed: (f) => f.acceptable === true, bound: null },
  limit: { value: '7', parsed: (f) => f.limit === 7, bound: 7 },
  offset: { value: '9', parsed: (f) => f.offset === 9, bound: 9 },
};

test('filter_keys.json lists exactly the keys parseFileFilters reads, and each one is read', () => {
  const fixture = read('filter_keys.json');
  assert.deepEqual(fixture.keys, FILTER_KEYS);
  assert.deepEqual(Object.keys(PROBES).sort(), [...FILTER_KEYS].sort(), 'a filter key was added or removed: give it a probe here');
  const base = parseFileFilters({});
  for (const key of FILTER_KEYS) {
    const probe = PROBES[key];
    const parsed = parseFileFilters({ [key]: probe.value });
    assert.ok(probe.parsed(parsed), `${key} is in FILTER_KEYS but parseFileFilters does not read it`);
    assert.notDeepEqual(parsed, base, key);
    if (probe.bound !== null) {
      const { bindings } = buildListQuery(SCOPE, parsed);
      assert.ok(bindings.includes(probe.bound), `${key} is read by parseFileFilters but buildListQuery does not bind it`);
    }
  }
  // a key that is not in the list is ignored, which is what the client's test guards against
  assert.deepEqual(parseFileFilters({ bogus: 'x', page: '3', q: 'x' }), base);
});

test('filter_keys.json values are the ones the server accepts, and nothing else', () => {
  const { values, limit } = read('filter_keys.json');
  for (const [key, list] of Object.entries(values)) {
    assert.deepEqual(list, FILTER_VALUES[key], key);
    for (const v of list) assert.doesNotThrow(() => parseFileFilters({ [key]: v }), `${key}=${v}`);
    assert.throws(() => parseFileFilters({ [key]: 'nonsense' }), { status: 400 }, key);
  }
  assert.equal(parseFileFilters({ limit: String(limit.max + 1) }).limit, limit.max);
  assert.equal(parseFileFilters({}).limit, limit.default);
  for (const owner of ['me', `team:${TEAM}`, `person:${TEAM}`]) assert.doesNotThrow(() => parseFileFilters({ owner }), owner);
  assert.throws(() => parseFileFilters({ owner: 'team' }), { status: 400 });
  assert.throws(() => parseFileFilters({ owner: 'everyone' }), { status: 400 });
});

// ---- what the client leans on beyond the shapes ----------------------------------------------------------------------------------

test('an accept-all dry run lists exactly the files it counts, and the real run for them asks for those ids', () => {
  const dry = built.get('accept_all_dry_run.json').body.data;
  assert.equal(dry.count, dry.ids.length);
  assert.equal(dry.dry_run, true);
  assert.ok(dry.count > 0 && dry.skipped.length > 0);
  assert.deepEqual(built.get('accept_all_real_candidate_ids.json').request.body.candidate_ids, dry.ids);
  const real = built.get('accept_all_real_candidate_ids.json').body.data;
  assert.deepEqual(real.items.map((i) => i.candidate_id), dry.ids);
  assert.equal(real.linked, dry.count);
  // every id is a file of the list the client was looking at
  const listed = built.get('files_new.json').body.data.map((r) => r.candidate_id);
  for (const id of dry.ids) assert.ok(listed.includes(id), id);
  // a dry run writes nothing, so it has no batch; a run that linked nothing has none either
  assert.equal('link_batch_id' in dry, false);
  assert.equal(built.get('accept_all_real_none.json').body.data.link_batch_id, null);
  assert.equal(built.get('accept_all_real.json').body.data.link_batch_id, real.link_batch_id);
});

test('accept-all names at most 200 skipped files and says how many there were in all (the client shows both)', () => {
  const many = Array.from({ length: 250 }, (_, n) => ({ candidate_id: `c${n}`, reason: 'NOT_EDITABLE' }));
  const out = shapeAcceptAll({ batchId: null, items: [], skipped: many, has_more: false, next_cursor: null });
  assert.equal(out.skipped.length, 200);
  assert.equal(out.skipped_total, 250);
});

test('a surface scan item always carries a condition the person chose: the fixtures show every condition the server accepts and none is defaulted', () => {
  assert.deepEqual(SCAN_CONDITIONS, ['new', 'worn', 'cleaned', 'other']);
  const sent = [...built.values()].filter((fx) => fx.request?.path === '/d1-inbox/link').flatMap((fx) => fx.request.body.items).filter((i) => i.collection === 'surface_scans');
  assert.ok(sent.length >= 5);
  assert.ok(sent.some((i) => i.condition === undefined), 'the 400 fixture for a missing condition');
  assert.throws(() => parseScanItem({ candidate_id: '00000000-0000-4000-8000-000000001003', insert_id: '00000000-0000-4000-8000-000000000201' }), { status: 400 });
  // the answer item of an add names the scan (record_id = junction_id = scan id) and the insert or edge it went to
  for (const name of ['link_surface_scan_ok.json', 'link_surface_scan_ok_edge.json', 'link_surface_scan_ok_mixed.json']) {
    const item = built.get(name).body.data.items.find((i) => i.collection === 'surface_scans');
    assert.equal(item.record_id, item.junction_id, name);
    assert.equal([item.insert_id, item.edge_id].filter((v) => v !== null).length, 1, `${name}: exactly one of insert_id and edge_id`);
    assert.equal(item.adopted, false, name);
  }
  // a linked surface scan in the list names the scan and where it went
  const [linked] = built.get('files_linked_surface_scan.json').body.data;
  assert.equal(linked.linked_collection, 'surface_scans');
  assert.equal([linked.linked_insert_id, linked.linked_edge_id].filter((v) => v !== null).length, 1);
  assert.match(linked.linked_label, /worn/);
});

test('ignored folders: a rule is { ignored_id, folder, owner: { kind, id, name }, created_at, can_remove }; adding answers the rule and what was dismissed; removing says whether a rescan was queued', () => {
  const list = built.get('ignored_get.json').body.data;
  assert.ok(list.some((r) => r.owner.kind === 'team') && list.some((r) => r.owner.kind === 'person'), 'a team rule and a personal rule');
  for (const r of list) {
    assert.deepEqual(Object.keys(r), ['ignored_id', 'folder', 'owner', 'created_at', 'can_remove']);
    assert.match(r.ignored_id, UUID);
    assert.deepEqual(Object.keys(r.owner), ['kind', 'id', 'name']);
    assert.equal(r.can_remove, true);
    assert.equal(new Date(r.created_at).toISOString(), r.created_at);
    assert.doesNotMatch(r.folder, /^\/|\/$|\/\/|^Users\/|^Shared\//, 'relative to the owner root');
  }
  assert.ok(built.get('ignored_get_viewer.json').body.data.every((r) => r.can_remove === false), 'a Lab Viewer removes nothing');
  assert.deepEqual(built.get('ignored_get_empty.json').body.data, []);
  const person = built.get('ignored_post_ok.json');
  assert.equal(person.status, 201);
  assert.deepEqual(Object.keys(person.body.data), ['ignored_id', 'folder', 'team_id', 'dismissed']);
  assert.equal(person.body.data.team_id, null);
  assert.equal(person.body.data.folder, person.request.body.folder);
  assert.equal(Number.isInteger(person.body.data.dismissed), true);
  const team = built.get('ignored_post_ok_team.json');
  assert.equal(team.body.data.team_id, team.request.body.team_id);
  const removed = built.get('ignored_delete_ok.json').body.data;
  assert.deepEqual(Object.keys(removed), ['ignored_id', 'folder', 'rescan_queued']);
  assert.equal(removed.rescan_queued, true);
  assert.equal(built.get('ignored_delete_ok_rate_limited.json').status, 200, 'the rescan limit never fails the delete');
  assert.equal(built.get('ignored_delete_ok_rate_limited.json').body.data.rescan_queued, false);
  assert.equal(built.get('ignored_post_409_already_ignored.json').body.errors[0].extensions.code, 'ALREADY_IGNORED');
  assert.equal(built.get('ignored_post_409_too_many_rules.json').body.errors[0].extensions.limit, 200);
  assert.equal(built.get('ignored_post_400_folder.json').body.errors[0].extensions.field, 'folder');
  assert.equal(built.get('ignored_delete_404.json').status, 404);
});

test('a copy of a file in an Inbox the caller has no part in carries { kind: other } and no name; a copy in their own or their team folder carries the name', () => {
  const rows = built.get('files_team_folder.json').body.data;
  const other = rows.find((r) => r.candidate_id === '00000000-0000-4000-8000-000000001013');
  assert.deepEqual(other.duplicate_of_owner, { kind: 'other' });
  assert.ok(!JSON.stringify(other).includes('Bob B'), "the other person's name is not in the row");
  assert.equal(rows.find((r) => r.candidate_id === '00000000-0000-4000-8000-000000001002').duplicate_of_owner, 'Alice A');
});

test('the folder filter reads the folder part of the path, not the file name (the client words it that way)', () => {
  const { sql, bindings } = buildListQuery(SCOPE, parseFileFilters({ folder: 'SEM' }));
  assert.match(sql, /strpos\(lower\(regexp_replace\(c\.rel_path, '\[\^\/\]\*\$', ''\)\), lower\(\?\)\) > 0/);
  assert.ok(bindings.includes('SEM'));
});

test('every row the list shows names its owner as { kind, id, name }, and a copy names whose Inbox the original is in', () => {
  for (const name of ['files_new.json', 'files_older.json', 'files_linked.json', 'files_dismissed.json']) {
    for (const row of built.get(name).body.data) {
      assert.ok(['person', 'team'].includes(row.owner.kind), name);
      assert.equal(typeof row.owner.name, 'string', name);
      assert.equal(row.duplicate_of === null, row.duplicate_of_owner === null, `${name}: duplicate_of and duplicate_of_owner go together`);
    }
  }
});
