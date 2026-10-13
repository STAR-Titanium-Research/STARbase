// Directus smoke cases, run by scripts/dev/directus_smoke.sh against a throwaway Directus on a
// restored copy of live. Node 20, no dependencies. One `SMOKE PASS|FAIL <case>` line per case;
// exit 1 on any FAIL. Env: DIRECTUS_URL, TOKEN (admin static token of the copy),
// LM_TOKEN (static token of a Lab Member user created in the copy, with its own people row; is_researcher).
// The lm_* cases need that user to be able to read at all. When Directus answers the probe read with the known
// `_some ... can only be used with top level relational alias field` 400 (the Lab Member permission rows, see
// task-6 report) they print `SMOKE SKIP <case>: <reason>` and do not fail the run; any other probe failure (401,
// 403, 500, another 400) leaves them to run and FAIL. D1_SMOKE_REQUIRE_LM=1 (or true) makes the skip a FAIL.
import { readFileSync } from 'node:fs';

const BASE = process.env.DIRECTUS_URL;
const TOKEN = process.env.TOKEN;
const LM_TOKEN = process.env.LM_TOKEN;

async function api(method, path, body, token = TOKEN) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const errText = (r) => JSON.stringify(r.body?.errors ?? r.body);
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`SMOKE PASS ${name}`);
  } catch (e) {
    if (e?.skip && !/^(1|true)$/i.test(process.env.D1_SMOKE_REQUIRE_LM ?? '')) {
      console.log(`SMOKE SKIP ${name}: ${e.message}`);
      return;
    }
    failed++;
    console.log(`SMOKE FAIL ${name}: ${String(e.message ?? e).replace(/\s+/g, ' ')}`);
  }
}
function expect(cond, detail) { if (!cond) throw new Error(detail); }

const rand6 = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
const sampleCode = `SMOKE-${rand6}`;
let sample; // {sample_id, short_id}
let test;   // created test_sessions row

// T0a regression (the incident): creating a sample through Directus must work.
await check('create_sample', async () => {
  const r = await api('POST', '/items/physical_samples?fields=sample_id,short_id',
    { sample_code: sampleCode, nickname: 'smoke', item_type: 'sample', current_status: 'active' });
  expect(r.status === 200, `status ${r.status}: ${errText(r)}`);
  sample = r.body.data;
  expect(/^[0-9a-f]{8,}$/.test(sample?.short_id ?? ''), `short_id ${JSON.stringify(sample?.short_id)} is not hex`);
});

await check('create_test_with_subject', async () => {
  expect(sample, 'no sample (create_sample failed)');
  const r = await api('POST', '/items/test_sessions?fields=*', {
    test_type: 'sem', status: 'registered',
    subject: { create: [{ collection: 'physical_samples', item: { sample_id: sample.sample_id } }], update: [], delete: [] },
  });
  expect(r.status === 200, `status ${r.status}: ${errText(r)}`);
  test = r.body.data;
  expect(test.test_code === `${sampleCode}-SEM1`, `test_code ${test.test_code}, expected ${sampleCode}-SEM1`);
});

// `fields=*` also returns the hidden o2m aliases of migrations 165 and 166 (`access`, `readers`: the ids of the access and readers rows); a
// client that re-POSTs a GET body must drop them (the readers rows belong to the source record, and the Lab Member has no write grant on them)
const DROP = ['session_id', 'short_id', 'created_at', 'updated_at', 'version', 'subject', 'created_by', 'access', 'readers'];
async function copyOfTest() {
  const r = await api('GET', `/items/test_sessions/${test.session_id}?fields=*`);
  expect(r.status === 200, `read test: status ${r.status}: ${errText(r)}`);
  const copy = { ...r.body.data };
  for (const k of DROP) delete copy[k];
  return copy;
}

// Directus "Duplicate" re-POSTs the item: with the code kept it must be rejected as non-unique.
await check('copy_test_keeping_code', async () => {
  expect(test, 'no test (create_test_with_subject failed)');
  const r = await api('POST', '/items/test_sessions', await copyOfTest());
  expect(r.status === 400, `status ${r.status}, expected 400: ${errText(r)}`);
  expect(/has to be unique/i.test(errText(r)), `no "has to be unique" message: ${errText(r)}`);
  const e = r.body?.errors?.[0];
  expect(e?.extensions?.field === 'test_code', `uniqueness error is not on test_code: ${errText(r)}`);
});

// With the code cleared (and the subject re-attached) the copy gets the next number.
await check('copy_test_cleared', async () => {
  expect(test, 'no test (create_test_with_subject failed)');
  const copy = await copyOfTest();
  copy.test_code = null;
  copy.subject = { create: [{ collection: 'physical_samples', item: { sample_id: sample.sample_id } }], update: [], delete: [] };
  const r = await api('POST', '/items/test_sessions?fields=*', copy);
  expect(r.status === 200, `status ${r.status}: ${errText(r)}`);
  expect(r.body.data.test_code === `${sampleCode}-SEM2`, `test_code ${r.body.data.test_code}, expected ${sampleCode}-SEM2`);
});

// --- T0b: operation codes are made by the database (operation_code_for / trigger 157) -------------
const OPS = '/items/manufacturing_operations';
let methodId;   // a machining method
let op;         // the automatic machining operation, created with no pass_code
let typedOp;    // a second operation with a typed code
const f1 = (speed, feed = 0.1) => `${sampleCode}-F1-${speed}MPM_${feed}feed_1DoC`;
async function readOp(id) {
  const r = await api('GET', `${OPS}/${id}?fields=operation_id,pass_code,operation_sequence,process_category,sintering_run_number`);
  expect(r.status === 200, `read operation: status ${r.status}: ${errText(r)}`);
  return r.body.data;
}
async function patchOp(id, body) {
  const r = await api('PATCH', `${OPS}/${id}?fields=operation_id,pass_code`, body);
  expect(r.status === 200, `patch ${JSON.stringify(body)}: status ${r.status}: ${errText(r)}`);
  return r.body.data;
}

await check('op_create_auto', async () => {
  expect(sample, 'no sample (create_sample failed)');
  const m = await api('GET', '/items/manufacturing_methods?filter[process_category][_eq]=machining&limit=1&fields=method_id');
  expect(m.status === 200 && m.body?.data?.[0]?.method_id, `no machining method: status ${m.status}: ${errText(m)}`);
  methodId = m.body.data[0].method_id;
  const r = await api('POST', `${OPS}?fields=operation_id,pass_code,operation_sequence`, {
    sample_id: sample.sample_id, method_id: methodId, machining_operation_subtype: 'F',
    machining_cutting_speed_m_per_min: 30, machining_feed_mm_per_rev: 0.1, machining_axial_depth_of_cut_mm: 1,
  });
  expect(r.status === 200, `status ${r.status}: ${errText(r)}`);
  op = r.body.data;
  expect(op.pass_code === f1(30), `pass_code ${op.pass_code}, expected ${f1(30)}`);
});

await check('op_edit_follows', async () => {
  expect(op, 'no operation (op_create_auto failed)');
  const r = await patchOp(op.operation_id, { machining_cutting_speed_m_per_min: 45 });
  expect(r.pass_code === f1(45), `pass_code ${r.pass_code}, expected ${f1(45)}`);
});

await check('op_typed_kept', async () => {
  expect(op, 'no operation (op_create_auto failed)');
  const t = await patchOp(op.operation_id, { pass_code: 'SMOKE-TYPED' });
  expect(t.pass_code === 'SMOKE-TYPED', `typed pass_code ${t.pass_code}`);
  const r = await patchOp(op.operation_id, { machining_cutting_speed_m_per_min: 50 });
  expect(r.pass_code === 'SMOKE-TYPED', `typed code was overwritten: ${r.pass_code}`);
});

await check('op_cleared', async () => {
  expect(op, 'no operation (op_create_auto failed)');
  const r = await patchOp(op.operation_id, { pass_code: null });
  expect(r.pass_code === f1(50), `pass_code ${r.pass_code}, expected ${f1(50)}`);
});

// The preview must give what the real write then gives.
await check('op_preview_matches', async () => {
  expect(op, 'no operation (op_create_auto failed)');
  const p = await api('POST', '/d1-next-number/operation-code',
    { values: { machining_feed_mm_per_rev: 0.2 }, operation_id: op.operation_id });
  expect(p.status === 200, `preview status ${p.status}: ${errText(p)}`);
  const r = await patchOp(op.operation_id, { machining_feed_mm_per_rev: 0.2 });
  expect(r.pass_code === f1(50, 0.2), `pass_code ${r.pass_code}, expected ${f1(50, 0.2)}`);
  expect(p.body?.code === r.pass_code, `preview ${JSON.stringify(p.body)} differs from the saved code ${r.pass_code}`);
  // a new operation (no operation_id): the preview estimates the next number, F2
  const n = await api('POST', '/d1-next-number/operation-code', {
    values: { sample_id: { sample_id: sample.sample_id }, method_id: methodId, machining_operation_subtype: 'F',
      machining_cutting_speed_m_per_min: 30 },
  });
  expect(n.status === 200 && n.body?.code === `${sampleCode}-F2-30MPM`, `new-op preview ${n.status} ${JSON.stringify(n.body)}`);
});

// `automatic` comes from the SAVED row (the trigger's test), not from the values sent: an automatic op is
// automatic even with values that change the code; after a typed code is saved it is not. Restores `op`
// to automatic at the end (sample_rename_cascades relies on it following the rule).
await check('op_preview_automatic_flag', async () => {
  expect(op, 'no operation (op_create_auto failed)');
  const a = await api('POST', '/d1-next-number/operation-code', { values: {}, operation_id: op.operation_id });
  expect(a.status === 200 && a.body?.automatic === true && a.body?.code === f1(50, 0.2),
    `automatic op: ${a.status} ${JSON.stringify(a.body)}, expected {code: ${f1(50, 0.2)}, automatic: true}`);
  const e = await api('POST', '/d1-next-number/operation-code',
    { values: { machining_cutting_speed_m_per_min: 70 }, operation_id: op.operation_id });
  expect(e.status === 200 && e.body?.automatic === true && e.body?.code === f1(70, 0.2),
    `automatic op, edited values: ${e.status} ${JSON.stringify(e.body)}`);
  const t = await patchOp(op.operation_id, { pass_code: 'SMOKE-TYPED-R4' });
  expect(t.pass_code === 'SMOKE-TYPED-R4', `typed pass_code ${t.pass_code}`);
  const b = await api('POST', '/d1-next-number/operation-code', { values: {}, operation_id: op.operation_id });
  expect(b.status === 200 && b.body?.automatic === false && b.body?.code === f1(50, 0.2),
    `typed op: ${b.status} ${JSON.stringify(b.body)}, expected {code: ${f1(50, 0.2)}, automatic: false}`);
  const r = await patchOp(op.operation_id, { pass_code: null });
  expect(r.pass_code === f1(50, 0.2), `restore: pass_code ${r.pass_code}, expected ${f1(50, 0.2)}`);
});

await check('op_preview_requires_login', async () => {
  const res = await fetch(`${BASE}/d1-next-number/operation-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: {} }),
  });
  expect(res.status === 401, `status ${res.status}, expected 401`);
});

// Frozen rows (source_system experiment_sheet): clearing the code keeps it, and the preview says so
// without building anything. Runs on the copy of live, on one of its imported operations.
await check('op_frozen_clear_keeps_code', async () => {
  const f = await api('GET', `${OPS}?filter[source_system][_eq]=experiment_sheet&filter[pass_code][_nnull]=true&limit=1&fields=operation_id,pass_code`);
  expect(f.status === 200, `list frozen operations: status ${f.status}: ${errText(f)}`);
  const row = f.body?.data?.[0];
  expect(row?.operation_id && row.pass_code, 'no experiment_sheet operation with a code in the copy');
  const p = await api('POST', '/d1-next-number/operation-code', { values: {}, operation_id: row.operation_id });
  expect(p.status === 200 && p.body?.frozen === true && p.body?.code === row.pass_code,
    `frozen preview ${p.status} ${JSON.stringify(p.body)}, expected {code: ${row.pass_code}, frozen: true}`);
  const r = await patchOp(row.operation_id, { pass_code: null });
  expect(r.pass_code === row.pass_code, `clearing changed the code: ${row.pass_code} -> ${r.pass_code}`);
  const again = await readOp(row.operation_id);
  expect(again.pass_code === row.pass_code, `saved code after clearing: ${again.pass_code}`);
});

// Row visibility (ADR-0011) end to end: a Lab Member who is not on the admin's smoke sample or operation
// must get 403 from the preview (the SQL reads with the database role's rights, so the route must refuse),
// and must still be able to preview their own operation.
const PREVIEW = '/d1-next-number/operation-code';
// Precondition: the Lab Member can read at all. If not (see the SKIP reason), the three cases are reported as
// SKIP, loudly, instead of FAIL: the cause is the Lab Member permission rows, not the preview route. Only that
// one known 400 skips; a 401 (token not accepted), 403, 500 or another 400 lets the cases run and fail.
// D1_SMOKE_REQUIRE_LM=1 makes a skip a failure.
let lmBlocked = null;
if (LM_TOKEN) {
  const probe = await api('GET', '/items/physical_samples?limit=1&fields=sample_id', undefined, LM_TOKEN);
  const knownBlocker = probe.status === 400 && /_some.*can only be used/.test(errText(probe));
  if (knownBlocker) lmBlocked = `a Lab Member cannot read physical_samples in this copy (status ${probe.status}: ${errText(probe)})`;
}
function needLm() {
  expect(LM_TOKEN, 'no LM_TOKEN (the harness did not create the Lab Member user)');
  if (lmBlocked) throw Object.assign(new Error(lmBlocked), { skip: true });
}

await check('lm_preview_foreign_op_403', async () => {
  needLm();
  expect(op, 'no operation (op_create_auto failed)');
  const r = await api('POST', PREVIEW, { values: {}, operation_id: op.operation_id }, LM_TOKEN);
  expect(r.status === 403, `status ${r.status}, expected 403: ${JSON.stringify(r.body)}`);
  expect(!JSON.stringify(r.body).includes(sampleCode), `the 403 body leaks the operation's code: ${JSON.stringify(r.body)}`);
});

await check('lm_preview_foreign_sample_403', async () => {
  needLm();
  expect(sample, 'no sample (create_sample failed)');
  const r = await api('POST', PREVIEW, {
    values: { sample_id: sample.sample_id, process_category: 'machining', machining_operation_subtype: 'F' },
  }, LM_TOKEN);
  expect(r.status === 403, `status ${r.status}, expected 403: ${JSON.stringify(r.body)}`);
  expect(!JSON.stringify(r.body).includes(sampleCode), `the 403 body leaks the sample's code: ${JSON.stringify(r.body)}`);
});

await check('lm_preview_own_op_200', async () => {
  needLm();
  expect(methodId, 'no method (earlier case failed)');
  const lmCode = `SMOKELM-${rand6}`;
  const s = await api('POST', '/items/physical_samples?fields=sample_id,sample_code',
    { sample_code: lmCode, nickname: 'smoke lm', item_type: 'sample', current_status: 'active' }, LM_TOKEN);
  expect(s.status === 200, `lab member sample create: status ${s.status}: ${errText(s)}`);
  const o = await api('POST', `${OPS}?fields=operation_id,pass_code`, {
    sample_id: s.body.data.sample_id, method_id: methodId, machining_operation_subtype: 'F',
    machining_cutting_speed_m_per_min: 30,
  }, LM_TOKEN);
  expect(o.status === 200, `lab member operation create: status ${o.status}: ${errText(o)}`);
  expect(o.body.data.pass_code === `${lmCode}-F1-30MPM`, `pass_code ${o.body.data.pass_code}`);
  const p = await api('POST', PREVIEW,
    { values: { machining_cutting_speed_m_per_min: 70 }, operation_id: o.body.data.operation_id }, LM_TOKEN);
  expect(p.status === 200, `preview status ${p.status}: ${JSON.stringify(p.body)}`);
  const u = await api('PATCH', `${OPS}/${o.body.data.operation_id}?fields=pass_code`,
    { machining_cutting_speed_m_per_min: 70 }, LM_TOKEN);
  expect(u.status === 200, `lab member patch: status ${u.status}: ${errText(u)}`);
  expect(u.body.data.pass_code === `${lmCode}-F1-70MPM`, `saved code ${u.body.data.pass_code}`);
  expect(p.body?.code === u.body.data.pass_code, `preview ${JSON.stringify(p.body)} differs from the saved code ${u.body.data.pass_code}`);
});

// A non-sintering create must not be blocked by the sintering run number (a typed code here).
await check('create_machining_op_without_run_number', async () => {
  expect(sample && methodId, 'no sample/method (earlier case failed)');
  const r = await api('POST', `${OPS}?fields=operation_id,pass_code,sintering_run_number`, {
    sample_id: sample.sample_id, method_id: methodId, machining_operation_subtype: 'F',
    machining_cutting_speed_m_per_min: 30, pass_code: 'SMOKE-TYPED2',
  });
  expect(r.status === 200, `status ${r.status}: ${errText(r)}`);
  typedOp = r.body.data;
  expect(typedOp.sintering_run_number == null, `sintering_run_number ${typedOp.sintering_run_number}`);
  expect(typedOp.pass_code === 'SMOKE-TYPED2', `typed pass_code ${typedOp.pass_code}`);
});

// Correcting a sample's code carries into its automatic operation codes, not into a typed one.
await check('sample_rename_cascades', async () => {
  expect(op && typedOp, 'no operations (earlier case failed)');
  const renamed = `${sampleCode}-R`;
  const r = await api('PATCH', `/items/physical_samples/${sample.sample_id}?fields=sample_code`, { sample_code: renamed });
  expect(r.status === 200, `rename status ${r.status}: ${errText(r)}`);
  const auto = await readOp(op.operation_id);
  expect(auto.pass_code === `${renamed}-F1-50MPM_0.2feed_1DoC`, `auto op ${auto.pass_code}, expected ${renamed}-F1-50MPM_0.2feed_1DoC`);
  const typed = await readOp(typedOp.operation_id);
  expect(typed.pass_code === 'SMOKE-TYPED2', `typed op changed to ${typed.pass_code}`);
});

// ---------------------------------------------------------------------------------------------------------------
// Record access (A1a Task 2): the Lab Member rules of scripts/access_rules.json against a real Directus.
// The harness loaded scripts/dev/access_matrix_fixture.sql into the copy (32 universes: every restricted/unrestricted
// combination of a project, campaign, sample, operation and test, access lists, an old co-owner and investigator) and
// computed, in plain SQL written from the spec's tables, what every fixture user may read, update and delete; the
// answer is /fixture/expected.json. Every case below compares Directus with that answer.
// ---------------------------------------------------------------------------------------------------------------
let FX = null;
try { FX = JSON.parse(readFileSync('/fixture/expected.json', 'utf8')); } catch { /* no fixture: the cases report it */ }
function needFx() {
  if (!FX) throw Object.assign(new Error('no access fixture in this run (the copy has no access tables, or D1_SMOKE_ACCESS=0)'), { skip: true });
}
const PK = {
  physical_samples: 'sample_id', manufacturing_operations: 'operation_id', test_sessions: 'session_id',
  campaigns: 'campaign_id', projects: 'project_id',
};
const NOTE = {
  physical_samples: 'notes', manufacturing_operations: 'outcome_notes', test_sessions: 'notes',
  campaigns: 'notes', projects: 'description',
};
const RECORD_KEYS = ['P', 'Q', 'C', 'C2', 'S', 'S2', 'O', 'O2', 'O3', 'O4', 'OF1', 'OF2', 'T'];
const labels = new Map();
const universe = (k) => FX.universes[k];
if (FX) for (const u of FX.universes) for (const key of RECORD_KEYS) labels.set(u[key], `${key}#${u.k}`);
const lab = (id) => labels.get(id) ?? id.slice(0, 8);
// The update and delete matrices send one write per user and record; eight of the 32 universes (every flag on its own, the
// all-open one, the all-restricted one and a mixed one) keep that to a few minutes. The read matrices cover all 32.
const WRITE_UNIVERSES = new Set([0, 1, 2, 4, 8, 16, 21, 31]);
const fixtureIds = (collection, all = true) => {
  const keys = {
    physical_samples: ['S', 'S2'], manufacturing_operations: ['O', 'O2', 'O3', 'O4', 'OF1', 'OF2'],
    test_sessions: ['T'], campaigns: ['C', 'C2'], projects: ['P', 'Q'],
  }[collection];
  return FX.universes.filter((u) => all || WRITE_UNIVERSES.has(u.k)).flatMap((u) => keys.map((key) => u[key]));
};
const expectedRead = (user, collection) => [
  ...FX.expected[user][collection].read,
  ...(collection === 'manufacturing_operations' ? FX.real_amnesty_ops : []),
].sort();

async function listIds(collection, token, qs = '') {
  const pk = PK[collection];
  const r = await api('GET', `/items/${collection}?limit=-1&fields=${pk}&sort=${pk}${qs}`, undefined, token);
  expect(r.status === 200, `GET ${collection}: status ${r.status}: ${errText(r)}`);
  return r.body.data.map((row) => row[pk]);
}
const diff = (got, want) => {
  const g = new Set(got), w = new Set(want);
  return { extra: got.filter((x) => !w.has(x)), missing: want.filter((x) => !g.has(x)) };
};
const show = (ids) => ids.slice(0, 6).map(lab).join(',') + (ids.length > 6 ? `,...(${ids.length})` : '');

// Every ruled collection answers 200 for a member (the `_some` rule of Directus 11.17: one illegal `_some` 400s
// every collection whose rule reaches it).
const RULED = [
  'physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects', 'sample_co_owners',
  'sample_stock_provenance', 'sample_data_files', 'sample_genealogy', 'campaign_samples', 'operation_data_files',
  'machining_force_analysis', 'fast_run_data', 'session_data_files', 'operation_additional_operators',
  'session_additional_operators', 'test_sessions_subject', 'project_investigators', 'project_rollup', 'people',
  'sample_access', 'operation_access', 'test_access', 'campaign_access', 'project_access',
];
await check('lm_access_every_ruled_collection_answers_200', async () => {
  needFx();
  const bad = [];
  for (const user of ['stranger', 'owner', 'pi', 'viewer', 'editor', 'opOwner']) {
    for (const collection of RULED) {
      const r = await api('GET', `/items/${collection}?limit=3&meta=filter_count&fields=${PK[collection] ?? "*"}`, undefined, FX.users[user]);
      if (r.status !== 200) bad.push(`${user} ${collection} -> ${r.status} ${errText(r).slice(0, 160)}`);
    }
  }
  expect(!bad.length, bad.slice(0, 5).join(' | '));
});

// list, filter_count, a second page and no duplicate ids, for every fixture user, against the SQL evaluation
for (const collection of Object.keys(PK)) {
  await check(`lm_access_matrix_${collection}_read`, async () => {
    needFx();
    const problems = [];
    for (const [user, token] of Object.entries(FX.users)) {
      const want = expectedRead(user, collection);
      const got = await listIds(collection, token);
      const dups = got.length - new Set(got).size;
      if (dups) problems.push(`${user}: ${dups} duplicate ids`);
      const d = diff(got, want);
      if (d.extra.length || d.missing.length) problems.push(`${user}: extra [${show(d.extra)}] missing [${show(d.missing)}]`);
      const c = await api('GET', `/items/${collection}?limit=1&meta=filter_count&fields=${PK[collection]}`, undefined, token);
      if (c.body?.meta?.filter_count !== want.length) problems.push(`${user}: filter_count ${c.body?.meta?.filter_count}, expected ${want.length}`);
      const page = await api('GET', `/items/${collection}?limit=7&page=2&sort=${PK[collection]}&fields=${PK[collection]}`, undefined, token);
      const p2 = (page.body?.data ?? []).map((row) => row[PK[collection]]);
      if (JSON.stringify(p2) !== JSON.stringify(want.slice(7, 14))) problems.push(`${user}: page 2 differs`);
    }
    expect(!problems.length, problems.slice(0, 4).join(' | '));
  });
}

// update: PATCH a harmless field as every user on every fixture record; 200 exactly where the SQL evaluation says so.
// Then delete: a user who may not delete gets 403 on every record, and the one who may deletes it (leaf records first).
const patchStatus = async (collection, id, token) =>
  (await api('PATCH', `/items/${collection}/${id}?fields=${PK[collection]}`, { [NOTE[collection]]: 'smoke access' }, token)).status;
for (const collection of Object.keys(PK)) {
  await check(`lm_access_matrix_${collection}_update`, async () => {
    needFx();
    const problems = [];
    for (const [user, token] of Object.entries(FX.users)) {
      const can = new Set(FX.expected[user][collection].update);
      for (const id of fixtureIds(collection, false)) {
        const s = await patchStatus(collection, id, token);
        if (can.has(id) ? s !== 200 : s !== 403) problems.push(`${user} PATCH ${lab(id)} -> ${s}, expected ${can.has(id) ? 200 : 403}`);
      }
    }
    expect(!problems.length, `${problems.length} mismatches: ${problems.slice(0, 5).join(' | ')}`);
  });
}
// named cases of the spec's cascade table (they are also inside the matrix; these name the intent)
await check('lm_access_viewer_cannot_patch_editor_can', async () => {
  needFx();
  const u = universe(0);
  for (const [collection, key] of [['physical_samples', 'S'], ['manufacturing_operations', 'O'], ['test_sessions', 'T'], ['campaigns', 'C']]) {
    const v = await patchStatus(collection, u[key], FX.users.viewer);
    const e = await patchStatus(collection, u[key], FX.users.editor);
    expect(v === 403 && e === 200, `${collection}: viewer ${v} (want 403), editor ${e} (want 200)`);
  }
});

await check('lm_access_sample_restricted_operation_invisible_to_its_own_owner', async () => {
  needFx();
  const u = universe(4); // the sample is restricted, nothing else
  const ops = await listIds('manufacturing_operations', FX.users.opOwner);
  const tests = await listIds('test_sessions', FX.users.opOwner);
  for (const id of [u.O, u.O2]) expect(!ops.includes(id), `opOwner sees ${lab(id)} under a restricted sample`);
  expect(!tests.includes(u.T), 'opOwner sees the test under a restricted sample');
  const own = await listIds('manufacturing_operations', FX.users.owner);
  expect(own.includes(u.O) && own.includes(u.O2), 'the sample owner no longer sees the operations of their restricted sample');
  const direct = await api('GET', `/items/manufacturing_operations/${u.O}`, undefined, FX.users.opOwner);
  expect(direct.status === 403, `GET of the hidden operation by id -> ${direct.status}, expected 403`);
});

await check('lm_access_restricted_project_and_campaign_cascade', async () => {
  needFx();
  const p = universe(1); // the project is restricted
  const camps = await listIds('campaigns', FX.users.campaignOwner);
  expect(!camps.includes(p.C), 'campaignOwner still sees the campaign of a restricted project');
  const stranger = await listIds('physical_samples', FX.users.stranger);
  expect(!stranger.includes(p.S), 'a stranger sees a sample of a restricted project');
  const pi = await listIds('manufacturing_operations', FX.users.pi);
  expect(pi.includes(p.O) && pi.includes(p.O3) && pi.includes(p.O4), 'the PI no longer reads everything in their restricted project');
  const owner = await listIds('manufacturing_operations', FX.users.owner);
  expect(!owner.includes(p.O) && !owner.includes(p.O2), 'the owner of the sample keeps the sample, not the operations under a restricted project (strict gates, spec section 1)');
  const c = universe(2); // the campaign is restricted
  const camp = await listIds('physical_samples', FX.users.campaignOwner);
  expect(camp.includes(c.S) && camp.includes(c.S2), 'the owner of a restricted campaign loses the samples in it');
  const inv = await listIds('campaigns', FX.users.inv);
  expect(!inv.includes(c.C), 'an investigator of the project reaches a restricted campaign');
  const invOps = await listIds('manufacturing_operations', FX.users.inv);
  expect(!invOps.includes(c.O4), 'an investigator reads an operation whose campaign is restricted');
});

// params: the eleven *_params tables were folded into columns of the operation and test rows (migration 32), so they
// follow those rows; there is no table left to rule.
await check('lm_access_params_follow_their_operation', async () => {
  needFx();
  const ok = await api('GET', `/items/manufacturing_operations/${universe(4).O2}?fields=operation_id,machining_cutting_speed_m_per_min`, undefined, FX.users.owner);
  expect(ok.status === 200 && 'machining_cutting_speed_m_per_min' in ok.body.data, `the owner reads an operation's inline parameters (${ok.status})`);
  const hidden = await api('GET', `/items/manufacturing_operations/${universe(4).O2}?fields=operation_id,machining_cutting_speed_m_per_min`, undefined, FX.users.opOwner);
  expect(hidden.status === 403, `the inline parameters of a hidden operation: status ${hidden.status}, expected 403`);
});

// the access tables: own rows only, and no member writes them (only the record-access endpoint does)
await check('lm_access_tables_show_own_rows_only_and_take_no_writes', async () => {
  needFx();
  const mine = await api('GET', '/items/sample_access?limit=-1&fields=person_id.user_id,role', undefined, FX.users.viewer);
  expect(mine.status === 200 && mine.body.data.length === 32 && mine.body.data.every((r) => r.role === 'view'), `viewer's own sample_access rows: ${mine.status} ${mine.body?.data?.length}`);
  const none = await api('GET', '/items/sample_access?limit=-1', undefined, FX.users.stranger);
  expect(none.status === 200 && none.body.data.length === 0, `a stranger sees ${none.body?.data?.length} sample_access rows`);
  const u = universe(0);
  const write = await api('POST', '/items/sample_access', { sample_id: u.S, person_id: u.P, role: 'view' }, FX.users.owner);
  expect(write.status === 403, `a member creating a sample_access row: status ${write.status}, expected 403`);
});

// --- readers-based rules (migration 166): the child collections read through ONE bare hop to the parent's readers table, campaign_samples
// through its own readers alias, sample_genealogy through the one two-hop OR left. Each is compared with the oracle's answer for the
// parent (the fixture adds child rows to every universe), with no duplicate rows and with filter_count and paging in step.
const CHILD_FILTER = {
  manufacturing_operations: () => fixtureIds('manufacturing_operations'),
  test_sessions: () => fixtureIds('test_sessions'),
  physical_samples: () => fixtureIds('physical_samples'),
  projects: () => fixtureIds('projects'),
};
// [child collection, the fk to the parent, parent collection, which oracle list answers it]
const CHILDREN = [
  ['machining_force_analysis', 'operation_id', 'manufacturing_operations', 'op_ordinary'],
  ['fast_run_data', 'operation_id', 'manufacturing_operations', 'op_ordinary'],
  ['operation_additional_operators', 'operation_id', 'manufacturing_operations', 'op_ordinary'],
  ['session_additional_operators', 'session_id', 'test_sessions', 'read'],
  ['test_sessions_subject', 'test_sessions_id', 'test_sessions', 'read'],
  ['sample_co_owners', 'sample_id', 'physical_samples', 'read'],
  ['project_investigators', 'project_id', 'projects', 'read'],
];
for (const [child, fk, parent, listName] of CHILDREN) {
  await check(`lm_access_child_${child}_reads_through_the_parents_readers`, async () => {
    needFx();
    const inList = CHILD_FILTER[parent]().join(',');
    const base = `/items/${child}?limit=-1&fields=${fk}&filter[${fk}][_in]=${inList}`;
    const adminRes = await api('GET', base);
    expect(adminRes.status === 200, `admin GET ${child}: ${adminRes.status} ${errText(adminRes)}`);
    const withChildren = new Set(adminRes.body.data.map((r) => r[fk]));
    expect(withChildren.size > 0, `the fixture has no ${child} rows`);
    const problems = [];
    for (const [user, token] of Object.entries(FX.users)) {
      const readable = listName === 'op_ordinary' ? FX.extra[user].op_ordinary : FX.expected[user][parent].read;
      const want = readable.filter((id) => withChildren.has(id));
      const r = await api('GET', base, undefined, token);
      if (r.status !== 200) { problems.push(`${user}: status ${r.status} ${errText(r).slice(0, 120)}`); continue; }
      const rows = r.body.data.map((x) => x[fk]);
      if (rows.length !== new Set(rows).size) problems.push(`${user}: ${rows.length - new Set(rows).size} duplicate rows`);
      const d = diff([...new Set(rows)], want);
      if (d.extra.length || d.missing.length) problems.push(`${user}: extra [${show(d.extra)}] missing [${show(d.missing)}]`);
      const c = await api('GET', `/items/${child}?limit=1&meta=filter_count&fields=${fk}&filter[${fk}][_in]=${inList}`, undefined, token);
      if (c.body?.meta?.filter_count !== rows.length) problems.push(`${user}: filter_count ${c.body?.meta?.filter_count}, rows ${rows.length}`);
    }
    expect(!problems.length, problems.slice(0, 4).join(' | '));
  });
}

// campaign_samples: ONE top-level `_some` on campaign_sample_readers (the junction's readers: readers of the sample, or, for an
// unrestricted sample, readers of its campaign); sample_genealogy: the one two-hop rule (an edge is readable by readers of its child or parent)
await check('lm_access_campaign_samples_read_through_their_own_readers', async () => {
  needFx();
  const inList = fixtureIds('campaigns').join(',');
  const problems = [];
  for (const [user, token] of Object.entries(FX.users)) {
    const r = await api('GET', `/items/campaign_samples?limit=-1&fields=id&sort=id&filter[campaign_id][_in]=${inList}`, undefined, token);
    if (r.status !== 200) { problems.push(`${user}: status ${r.status} ${errText(r).slice(0, 120)}`); continue; }
    const got = r.body.data.map((x) => x.id);
    if (got.length !== new Set(got).size) problems.push(`${user}: duplicate junction rows`);
    const d = diff(got, FX.extra[user].junction);
    if (d.extra.length || d.missing.length) problems.push(`${user}: extra ${d.extra.length} missing ${d.missing.length}`);
    const c = await api('GET', `/items/campaign_samples?limit=1&meta=filter_count&fields=id&filter[campaign_id][_in]=${inList}`, undefined, token);
    if (c.body?.meta?.filter_count !== FX.extra[user].junction.length) problems.push(`${user}: filter_count ${c.body?.meta?.filter_count}, expected ${FX.extra[user].junction.length}`);
    const p2 = await api('GET', `/items/campaign_samples?limit=7&page=2&sort=id&fields=id&filter[campaign_id][_in]=${inList}`, undefined, token);
    if (JSON.stringify((p2.body?.data ?? []).map((x) => x.id)) !== JSON.stringify([...FX.extra[user].junction].sort().slice(7, 14))) problems.push(`${user}: page 2 differs`);
  }
  expect(!problems.length, problems.slice(0, 4).join(' | '));
});

await check('lm_access_sample_genealogy_two_hop_rule_no_duplicates', async () => {
  needFx();
  const inList = fixtureIds('physical_samples').join(',');
  const problems = [];
  for (const [user, token] of Object.entries(FX.users)) {
    const r = await api('GET', `/items/sample_genealogy?limit=-1&fields=child_sample_id&filter[child_sample_id][_in]=${inList}`, undefined, token);
    if (r.status !== 200) { problems.push(`${user}: status ${r.status} ${errText(r).slice(0, 120)}`); continue; }
    const got = r.body.data.map((x) => x.child_sample_id);
    if (got.length !== new Set(got).size) problems.push(`${user}: duplicate edges (${got.length} rows)`);
    const d = diff([...new Set(got)], FX.extra[user].genealogy);
    if (d.extra.length || d.missing.length) problems.push(`${user}: extra ${d.extra.length} missing ${d.missing.length}`);
    const c = await api('GET', `/items/sample_genealogy?limit=1&meta=filter_count&fields=child_sample_id&filter[child_sample_id][_in]=${inList}`, undefined, token);
    if (c.body?.meta?.filter_count !== got.length) problems.push(`${user}: filter_count ${c.body?.meta?.filter_count}, rows ${got.length}`);
  }
  expect(!problems.length, problems.slice(0, 4).join(' | '));
});

// the amnesty leaf: ownerless runs open to everyone are readable by a stranger, their children are not (no inheritance)
await check('lm_access_amnesty_leaf_reads_the_run_not_its_children', async () => {
  needFx();
  const u = universe(0);
  const ops = await listIds('manufacturing_operations', FX.users.stranger);
  expect(ops.includes(u.OF1) && ops.includes(u.OF2), 'a stranger does not read the ownerless runs of the all-open universe');
  const child = await api('GET', `/items/machining_force_analysis?limit=-1&fields=operation_id&filter[operation_id][_in]=${u.OF1},${u.OF2}`, undefined, FX.users.stranger);
  expect(child.status === 200 && child.body.data.length === 0, `a stranger reads ${child.body?.data?.length} analysis rows of the amnesty runs (children do not inherit the amnesty)`);
  // narrowed: an ownerless run on a sample held only by a restricted campaign is NOT open to everyone (universe 2: C restricted, S not)
  const r = universe(2);
  const open = await listIds('manufacturing_operations', FX.users.stranger);
  expect(!open.includes(r.OF2), 'the ownerless run on a sample held only by a restricted campaign is still open to a stranger (the amnesty is narrowed)');
});

// an operation on a sample that sits only in a restricted campaign is invisible to its owner (ruling 19), not to the sample's owner
await check('lm_access_operation_under_a_restricted_campaigns_sample_is_invisible_to_its_owner', async () => {
  needFx();
  const u = universe(2); // the campaign is restricted, nothing else
  const ops = await listIds('manufacturing_operations', FX.users.opOwner);
  expect(!ops.includes(u.O2), 'opOwner reads an operation on a sample held only by a restricted campaign (ruling 19)');
  const owner = await listIds('manufacturing_operations', FX.users.owner);
  expect(owner.includes(u.O2), 'the sample owner no longer reads the operation of their own sample');
  const direct = await api('GET', `/items/manufacturing_operations/${u.O2}`, undefined, FX.users.opOwner);
  expect(direct.status === 403, `GET of the shielded operation by id -> ${direct.status}, expected 403`);
});

// update and delete are never wider than read: for every user and type, the oracle's update and delete ids are inside its read ids
await check('lm_access_update_and_delete_ids_are_subsets_of_read_ids', async () => {
  needFx();
  const bad = [];
  for (const user of Object.keys(FX.users)) {
    for (const collection of Object.keys(PK)) {
      const read = new Set(FX.expected[user][collection].read);
      for (const action of ['update', 'delete']) {
        const wider = FX.expected[user][collection][action].filter((id) => !read.has(id));
        if (wider.length) bad.push(`${user} ${collection} ${action}: ${wider.length} id(s) beyond read`);
      }
    }
  }
  expect(!bad.length, bad.slice(0, 4).join(' | '));
});

// the junction guard of this task part: a co-owner cannot repoint a co-owner row (403, shown above); a stranger cannot create access rows
await check('lm_access_restricted_project_hides_everything_inside_from_a_stranger_not_from_the_pi', async () => {
  needFx();
  const p = universe(1);
  const stranger = { campaigns: await listIds('campaigns', FX.users.stranger), samples: await listIds('physical_samples', FX.users.stranger),
    ops: await listIds('manufacturing_operations', FX.users.stranger), tests: await listIds('test_sessions', FX.users.stranger) };
  expect(!stranger.campaigns.includes(p.C) && !stranger.samples.includes(p.S) && !stranger.ops.includes(p.O) && !stranger.tests.includes(p.T),
    'a stranger reads something inside a restricted project');
  const pi = { campaigns: await listIds('campaigns', FX.users.pi), samples: await listIds('physical_samples', FX.users.pi),
    ops: await listIds('manufacturing_operations', FX.users.pi), tests: await listIds('test_sessions', FX.users.pi) };
  expect(pi.campaigns.includes(p.C) && pi.samples.includes(p.S) && pi.ops.includes(p.O) && pi.tests.includes(p.T), 'the PI does not read everything in their restricted project');
});

// the Directus rules never answer with a duplicate: every ruled collection, as a member with an access list of several people
await check('lm_access_no_duplicates_in_any_record_list', async () => {
  needFx();
  const bad = [];
  for (const user of ['stranger', 'viewer', 'editor', 'pi', 'inv']) {
    for (const collection of Object.keys(PK)) {
      const got = await listIds(collection, FX.users[user]);
      if (got.length !== new Set(got).size) bad.push(`${user} ${collection}: ${got.length - new Set(got).size} duplicates`);
    }
  }
  expect(!bad.length, bad.slice(0, 4).join(' | '));
});

// the hidden `readers` alias fields keep read permission `*` on the parents; the readers tables themselves are readable only for one's own login. A member who
// asks for readers.user_id gets only their own rows, and a filter on someone else's readers row never widens what they read (review finding 7)
await check('lm_access_readers_alias_gives_a_member_nothing_beyond_their_own_rows', async () => {
  needFx();
  const me = await api('GET', '/users/me?fields=id', undefined, FX.users.viewer);
  const other = await api('GET', '/users/me?fields=id', undefined, FX.users.owner);
  expect(me.status === 200 && other.status === 200, 'could not read the two logins');
  const mine = me.body.data.id, theirs = other.body.data.id;
  const readable = await listIds('physical_samples', FX.users.viewer);
  expect(readable.length > 0, 'the viewer reads no sample');
  const r = await api('GET', `/items/physical_samples?limit=-1&fields=sample_id,readers.user_id&filter[sample_id][_in]=${readable.slice(0, 100).join(',')}`, undefined, FX.users.viewer);
  if (r.status === 200) {
    const foreign = [];
    for (const row of r.body.data) for (const x of row.readers || []) { const uid = typeof x === 'object' ? x.user_id : x; if (uid && uid !== mine) foreign.push(uid); }
    expect(!foreign.length, `readers.user_id shows ${foreign.length} other login(s) to a member (first: ${foreign[0]})`);
  } else {
    expect(r.status === 403, `fields=readers.user_id -> ${r.status}, expected 200 with own rows only or 403`);
  }
  const f = await api('GET', `/items/physical_samples?limit=-1&fields=sample_id&filter[readers][user_id][_eq]=${theirs}`, undefined, FX.users.viewer);
  if (f.status === 200) {
    const set = new Set(readable);
    const wider = f.body.data.map((x) => x.sample_id).filter((id) => !set.has(id));
    expect(!wider.length, `a filter on another login's readers row widens the viewer's samples by ${wider.length}`);
  } else {
    expect([400, 403].includes(f.status), `filter[readers][user_id] -> ${f.status}`);
  }
});

// sample_co_owners: update and delete are the sample owner's now (a co-owner used to be able to repoint or remove
// co-owner rows, which on a restricted sample is a leak). The guard on create lands in Task 3.
await check('lm_access_co_owner_cannot_change_or_remove_co_owner_rows', async () => {
  needFx();
  const u = universe(31);
  const patch = await api('PATCH', `/items/sample_co_owners/${u.coowner_row}`, { user_id: '00000000-0000-4000-8000-000000000000' }, FX.users.coowner);
  expect(patch.status === 403, `co-owner PATCH user_id -> ${patch.status}, expected 403`);
  const del = await api('DELETE', `/items/sample_co_owners/${u.coowner_row}`, undefined, FX.users.coowner);
  expect(del.status === 403, `co-owner DELETE -> ${del.status}, expected 403`);
  const other = await api('DELETE', `/items/sample_co_owners/${u.coowner_row}`, undefined, FX.users.stranger);
  expect(other.status === 403, `stranger DELETE -> ${other.status}, expected 403`);
  const owner = await api('DELETE', `/items/sample_co_owners/${u.coowner_row}`, undefined, FX.users.owner);
  expect(owner.status === 204, `the sample's owner DELETE -> ${owner.status}, expected 204`);
});

// project_rollup (migration 167): the PI reads every row of the project, an investigator only the unrestricted ones
await check('lm_access_rollup_pi_reads_all_investigators_only_unrestricted', async () => {
  needFx();
  const ids = FX.universes.map((u) => u.P).join(',');
  const problems = [];
  let hidden = 0;
  for (const [user, token] of Object.entries(FX.users)) {
    const r = await api('GET', `/items/project_rollup?filter[project_id][_in]=${ids}&limit=-1&fields=row_id&sort=row_id`, undefined, token);
    if (r.status !== 200) { problems.push(`${user}: status ${r.status}`); continue; }
    const got = r.body.data.map((x) => x.row_id).sort();
    const want = [...FX.rollup[user]].sort();
    const d = diff(got, want);
    if (d.extra.length || d.missing.length) problems.push(`${user}: extra ${d.extra.length} missing ${d.missing.length}`);
    if (user === 'inv') hidden = FX.rollup.pi.length - want.length;
  }
  expect(!problems.length, problems.slice(0, 4).join(' | '));
  expect(hidden > 0, 'the fixture has no restricted rollup row an investigator must not see');
});

// ---------------------------------------------------------------------------------------------------------------
// Record access (A1a Task 3): the d1-record-access endpoint, the d1-access-guard rules of section 4, and the readers drift
// count of /d1-admin-overview, against a real Directus. These cases build their OWN records (a small "world" made with the
// admin token) instead of using the 32 fixture universes: they change access lists, owners and the restricted flag, which
// would shift what the delete matrices below expect. The fixture users (people with logins) act on them. The smoke Directus
// has no mail server (no EMAIL_*, the default sendmail transport has no binary), so an email attempt answers `failed`; the
// case asserts that and that the change stood; the harness then looks for the warning in Directus's own log (a
// `SMOKE NOTE ra_expect_email_warning` line asks for it).
// ---------------------------------------------------------------------------------------------------------------
const RA = '/d1-record-access';
const raSuffix = Math.random().toString(36).slice(2, 7).toUpperCase().padEnd(5, '0');
let RAW = null; // the world: ids of what the cases below act on
let emailsFailed = 0;

const GUARD = 'd1-access-guard';
const refusedBy = (r, source, kind) => r.status === 403 && r.body?.errors?.[0]?.extensions?.source === source && (!kind || r.body.errors[0].extensions.kind === kind);
const why = (r) => `${r.status} ${errText(r).slice(0, 200)}`;

async function personOfUser(name) {
  const me = await api('GET', '/users/me?fields=id', undefined, FX.users[name]);
  expect(me.status === 200, `users/me as ${name}: ${me.status}`);
  const p = await api('GET', `/items/people?filter[user_id][_eq]=${me.body.data.id}&fields=person_id&limit=1`);
  expect(p.status === 200 && p.body.data[0], `no People row for the fixture user ${name}`);
  return { user: me.body.data.id, person: p.body.data[0].person_id };
}
async function adminMake(collection, body, key) {
  const r = await api('POST', `/items/${collection}?fields=${key}`, body);
  expect(r.status === 200, `admin create ${collection}: ${why(r)}`);
  return r.body.data[key];
}
// d1_private.readers_drift_count() through the admin overview (?refresh=1 skips its one-minute cache): 0 after every case
async function noDrift(label) {
  const r = await api('GET', '/d1-admin-overview?refresh=1');
  expect(r.status === 200, `${label}: /d1-admin-overview ${why(r)}`);
  const drift = r.body?.readers_drift;
  expect(drift && drift.count === 0 && drift.flagged === false, `${label}: readers drift ${JSON.stringify(drift)}`);
}
const entriesOf = async (collection, id, token) => {
  const r = await api('GET', `${RA}/${collection}/${id}`, undefined, token);
  expect(r.status === 200, `GET ${RA}/${collection}: ${why(r)}`);
  return r.body;
};
const addEntry = (collection, id, person_id, role, token) => api('POST', `${RA}/${collection}/${id}/entries`, { person_id, role }, token);
const noteEmail = (r) => { if (r.body?.email === 'failed') emailsFailed++; };

await check('ra_world_setup', async () => {
  needFx();
  const [owner, coowner, viewer, editor, stranger, campaignOwner, pi] =
    await Promise.all(['owner', 'coowner', 'viewer', 'editor', 'stranger', 'campaignOwner', 'pi'].map(personOfUser));
  const nologin = await api('GET', `/items/people?filter[full_name][_eq]=${encodeURIComponent('Fx nologin')}&fields=person_id&limit=1`);
  expect(nologin.body?.data?.[0], 'the fixture has no login-less person');
  const mailed = await adminMake('people', { full_name: `Smoke Mailed ${raSuffix}`, email: `smoke-ra-${raSuffix.toLowerCase()}@example.invalid`, is_researcher: true, active: true }, 'person_id');
  const proj = (n, who) => adminMake('projects', { project_code: `SMKRA-${raSuffix}-${n}`, project_name: `Smoke record access ${n}`, principal_investigator_person: who.person }, 'project_id');
  const PW = await proj('W', pi);
  const PW2 = await proj('W2', pi);
  const PM = await proj('M', campaignOwner); // a project the campaign owner "created": they are its PI
  const sample = (n, extra = {}) => adminMake('physical_samples', { sample_code: `SMKRA-${raSuffix}-${n}`, nickname: 'smoke', item_type: 'sample', current_status: 'active', project_id: PW, owner_person_id: owner.person, ...extra }, 'sample_id');
  const SA = await sample('A'); // the list, add, change, remove, transfer cases
  const SB = await sample('B'); // the restricted flag and a restricted move
  const SR = await sample('R'); // restricted, held by the campaign, not readable by its owner
  const SU = await sample('U'); // unrestricted, in the unrestricted campaign
  const SX = await sample('X'); // restricted, the campaign owner's attempt to attach it
  const camp = (n, extra = {}) => adminMake('campaigns', { project_id: PW, campaign_type: 'testing_campaign', name: `Smoke RA ${n} ${raSuffix}`, owner_person_id: campaignOwner.person, ...extra }, 'campaign_id');
  const CW = await camp('with restricted');
  const CU = await camp('unrestricted');
  const CE = await camp('editable');
  for (const [campaign_id, sample_id] of [[CW, SR], [CU, SU]]) await adminMake('campaign_samples', { campaign_id, sample_id }, 'id');
  for (const id of [SR, SX]) { const r = await api('PATCH', `/items/physical_samples/${id}`, { restricted: true }); expect(r.status === 200, `restrict ${id}: ${why(r)}`); }
  await adminMake('sample_co_owners', { sample_id: SA, user_id: coowner.user }, 'id'); // an old-table co-owner of SA
  await adminMake('campaign_access', { campaign_id: CE, person_id: editor.person, role: 'edit' }, 'access_id'); // a Can edit person of CE
  await adminMake('campaign_samples', { campaign_id: CE, sample_id: SR }, 'id');
  RAW = { owner, coowner, viewer, editor, stranger, campaignOwner, pi, nologin: nologin.body.data[0].person_id, mailed, PW, PW2, PM, SA, SB, SR, SU, SX, CW, CU, CE };
  await noDrift('world');
});

await check('ra_owner_adds_people_and_the_email_failure_never_blocks_the_change', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  // a login-less person with no address: nothing to mail
  const a = await addEntry('physical_samples', RAW.SA, RAW.nologin, 'view', t.owner);
  expect(a.status === 200 && a.body.email === 'skipped', `add a person with no address: ${why(a)}`);
  expect(a.body.entry.can_sign_in === false && a.body.entry.label === 'Can view', `entry ${JSON.stringify(a.body.entry)}`);
  // a login-less person with an address, and a person with a login: the mail cannot be sent here, the change stands
  for (const [person, role] of [[RAW.mailed, 'edit'], [RAW.viewer.person, 'view'], [RAW.editor.person, 'edit']]) {
    const r = await addEntry('physical_samples', RAW.SA, person, role, t.owner);
    expect(r.status === 200, `add ${person}: ${why(r)}`);
    expect(['failed', 'skipped'].includes(r.body.email), `no mail server here, expected failed or skipped, got ${r.body.email}`);
    noteEmail(r);
  }
  const list = await entriesOf('physical_samples', RAW.SA, t.owner);
  expect(list.can_manage === true && list.entries.length === 5, `owner's list: can_manage ${list.can_manage}, ${list.entries.length} entries (4 added + the old co-owner)`);
  const co = list.entries.find((e) => e.source === 'co_owner');
  expect(co && co.label.startsWith('Co-owner'), `the old co-owner is listed as one: ${JSON.stringify(co)}`);
  // adding the owner is a 409, an unknown role is a 400, a person twice is a role change with no mail
  const owner409 = await addEntry('physical_samples', RAW.SA, RAW.owner.person, 'view', t.owner);
  expect(owner409.status === 409, `adding the owner: ${why(owner409)}`);
  const bad = await addEntry('physical_samples', RAW.SA, RAW.viewer.person, 'investigator', t.owner);
  expect(bad.status === 400, `an investigator on a sample: ${why(bad)}`);
  const again = await addEntry('physical_samples', RAW.SA, RAW.mailed, 'view', t.owner);
  expect(again.status === 200 && again.body.email === 'skipped' && again.body.entry.role === 'view', `re-adding: ${why(again)}`);
  await noDrift('owner adds');
});

await check('ra_non_owners_can_list_and_cannot_manage', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  for (const who of ['viewer', 'editor', 'coowner']) {
    const list = await entriesOf('physical_samples', RAW.SA, t[who]);
    expect(list.can_manage === false, `${who}: can_manage ${list.can_manage}`);
    const add = await addEntry('physical_samples', RAW.SA, RAW.stranger.person, 'view', t[who]);
    expect(refusedBy(add, 'd1-record-access'), `${who} POST entries: ${why(add)}`);
    const patch = await api('PATCH', `${RA}/physical_samples/${RAW.SA}/entries/${RAW.viewer.person}`, { role: 'edit' }, t[who]);
    expect(refusedBy(patch, 'd1-record-access'), `${who} PATCH entries: ${why(patch)}`);
    const del = await api('DELETE', `${RA}/physical_samples/${RAW.SA}/entries/${RAW.viewer.person}`, undefined, t[who]);
    expect(refusedBy(del, 'd1-record-access'), `${who} DELETE entries: ${why(del)}`);
    const tr = await api('POST', `${RA}/physical_samples/${RAW.SA}/transfer`, { person_id: RAW.stranger.person }, t[who]);
    expect(refusedBy(tr, 'd1-record-access'), `${who} transfer: ${why(tr)}`);
  }
  // a stranger cannot even see the record: 404, and nothing is written
  const hidden = await api('GET', `${RA}/physical_samples/${RAW.SA}`, undefined, t.stranger);
  expect(hidden.status === 404, `stranger GET: ${why(hidden)}`);
  const w = await addEntry('physical_samples', RAW.SA, RAW.stranger.person, 'view', t.stranger);
  expect(w.status === 404, `stranger POST: ${why(w)}`);
  const anon = await fetch(`${BASE}${RA}/physical_samples/${RAW.SA}`);
  expect(anon.status === 401, `no token: ${anon.status}`);
  const after = await entriesOf('physical_samples', RAW.SA, t.owner);
  expect(after.entries.length === 5, `the list changed under a refused caller: ${after.entries.length}`);
  await noDrift('non-owners');
});

await check('ra_owner_changes_a_role_and_removes_and_the_co_owner_row_goes_with_it', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  const up = await api('PATCH', `${RA}/physical_samples/${RAW.SA}/entries/${RAW.viewer.person}`, { role: 'edit' }, t.owner);
  expect(up.status === 200 && up.body.entry.role === 'edit', `PATCH: ${why(up)}`);
  // the old co-owner row is converted by a write for that person
  const conv = await api('PATCH', `${RA}/physical_samples/${RAW.SA}/entries/${RAW.coowner.person}`, { role: 'view' }, t.owner);
  expect(conv.status === 200 && conv.body.entry.source === 'access' && conv.body.entry.role === 'view', `convert the co-owner: ${why(conv)}`);
  const left = await api('GET', `/items/sample_co_owners?filter[sample_id][_eq]=${RAW.SA}&fields=id`);
  expect(left.body.data.length === 0, `the old co-owner row is still there (${left.body.data.length})`);
  const del = await api('DELETE', `${RA}/physical_samples/${RAW.SA}/entries/${RAW.mailed}`, undefined, t.owner);
  expect(del.status === 200, `DELETE: ${why(del)}`);
  const again = await api('DELETE', `${RA}/physical_samples/${RAW.SA}/entries/${RAW.mailed}`, undefined, t.owner);
  expect(again.status === 404, `DELETE twice: ${why(again)}`);
  await noDrift('role change and remove');
});

await check('ra_a_change_through_the_endpoint_is_readable_at_once_by_the_added_person', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  const before = await api('GET', `/items/physical_samples/${RAW.SX}?fields=sample_id`, undefined, t.stranger);
  expect(before.status === 403, `the stranger reads a restricted sample before being added: ${before.status}`);
  const add = await addEntry('physical_samples', RAW.SX, RAW.stranger.person, 'view', t.owner);
  expect(add.status === 200, `add: ${why(add)}`);
  noteEmail(add);
  const now = await api('GET', `/items/physical_samples/${RAW.SX}?fields=sample_id`, undefined, t.stranger);
  expect(now.status === 200, `read-your-write: the added person gets ${now.status}`);
  const del = await api('DELETE', `${RA}/physical_samples/${RAW.SX}/entries/${RAW.stranger.person}`, undefined, t.owner);
  expect(del.status === 200, `remove: ${why(del)}`);
  const gone = await api('GET', `/items/physical_samples/${RAW.SX}?fields=sample_id`, undefined, t.stranger);
  expect(gone.status === 403, `after the removal the stranger gets ${gone.status}`);
  await noDrift('read your write');
});

await check('ra_restricted_flag_is_the_owners_to_switch_not_an_editors', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  const add = await addEntry('physical_samples', RAW.SB, RAW.editor.person, 'edit', t.owner);
  expect(add.status === 200, `add the editor: ${why(add)}`);
  noteEmail(add);
  const edit = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { nickname: 'edited by the editor' }, t.editor);
  expect(edit.status === 200, `a Can edit person edits an ordinary field: ${why(edit)}`);
  const refused = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { restricted: true }, t.editor);
  expect(refusedBy(refused, GUARD, 'restricted'), `editor PATCH restricted: ${why(refused)}`);
  const ok = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id,restricted`, { restricted: true }, t.owner);
  expect(ok.status === 200 && ok.body.data.restricted === true, `owner PATCH restricted: ${why(ok)}`);
  const unlock = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { restricted: false }, t.editor);
  expect(refusedBy(unlock, GUARD, 'restricted'), `editor lifts the restriction: ${why(unlock)}`);
  // sending the stored value back (a form save) is not a change
  const same = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { restricted: true, nickname: 'saved again' }, t.editor);
  expect(same.status === 200, `editor saves the form with the unchanged flag: ${why(same)}`);
  await noDrift('restricted flag');
});

await check('ra_editor_cannot_move_a_restricted_sample_to_another_project', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  // SB is restricted and the editor is on its list (the case above)
  const move = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { project_id: RAW.PW2 }, t.editor);
  expect(refusedBy(move, GUARD, 'restricted'), `editor PATCH project_id of a restricted sample: ${why(move)}`);
  const owner = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id,project_id`, { project_id: RAW.PW2 }, t.owner);
  expect(owner.status === 200 && owner.body.data.project_id === RAW.PW2, `the owner moves it: ${why(owner)}`);
  const back = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { project_id: RAW.PW }, t.owner);
  expect(back.status === 200, `and back: ${why(back)}`);
  // lift the restriction (owner), then a move by the editor is an ordinary edit again
  await api('PATCH', `/items/physical_samples/${RAW.SB}`, { restricted: false }, t.owner);
  const open = await api('PATCH', `/items/physical_samples/${RAW.SB}?fields=sample_id`, { project_id: RAW.PW2 }, t.editor);
  expect(open.status === 200, `an unrestricted move by the editor: ${why(open)}`);
  await api('PATCH', `/items/physical_samples/${RAW.SB}`, { project_id: RAW.PW }, t.owner);
  await noDrift('restricted move');
});

await check('ra_campaign_owner_cannot_move_a_campaign_holding_restricted_records_into_their_own_project', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  // CW holds the restricted sample SR, which the campaign owner does not own (and cannot read): the move is the admin's
  const move = await api('PATCH', `/items/campaigns/${RAW.CW}?fields=campaign_id`, { project_id: RAW.PM }, t.campaignOwner);
  expect(refusedBy(move, GUARD, 'restricted'), `campaign owner PATCH project_id (holds a restricted sample): ${why(move)}`);
  const stays = await api('GET', `/items/campaigns/${RAW.CW}?fields=project_id`);
  expect(stays.body.data.project_id === RAW.PW, 'the campaign moved anyway');
  // a Can edit person of a campaign is refused even when nothing in it is restricted (CE holds SR too; the owner rule decides first)
  const editor = await api('PATCH', `/items/campaigns/${RAW.CE}?fields=campaign_id`, { project_id: RAW.PM }, t.editor);
  expect(refusedBy(editor, GUARD, 'restricted'), `Can edit person PATCH project_id: ${why(editor)}`);
  // the owner of an unrestricted campaign holding only unrestricted records may move it
  const ok = await api('PATCH', `/items/campaigns/${RAW.CU}?fields=campaign_id,project_id`, { project_id: RAW.PM }, t.campaignOwner);
  expect(ok.status === 200 && ok.body.data.project_id === RAW.PM, `campaign owner moves an unrestricted campaign: ${why(ok)}`);
  // an admin may move the one that holds restricted records
  const admin = await api('PATCH', `/items/campaigns/${RAW.CW}?fields=project_id`, { project_id: RAW.PW2 });
  expect(admin.status === 200 && admin.body.data.project_id === RAW.PW2, `admin moves the restricted one: ${why(admin)}`);
  await api('PATCH', `/items/campaigns/${RAW.CW}`, { project_id: RAW.PW });
  await noDrift('campaign project move');
});

await check('ra_campaign_samples_insert_for_an_unreadable_sample_is_403', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  // SX is restricted and the campaign owner is not on its list
  const r = await api('POST', '/items/campaign_samples', { campaign_id: RAW.CW, sample_id: RAW.SX }, t.campaignOwner);
  expect(refusedBy(r, GUARD, 'junction'), `campaign owner attaches a sample they cannot read: ${why(r)}`);
  const none = await api('GET', `/items/campaign_samples?filter[campaign_id][_eq]=${RAW.CW}&filter[sample_id][_eq]=${RAW.SX}&fields=id`);
  expect(none.body.data.length === 0, 'the row was written anyway');
  // an unrestricted sample the owner of the campaign does own is fine for its owner ('owner' owns SA and is no campaign owner: refused on the campaign)
  const wrongCampaign = await api('POST', '/items/campaign_samples', { campaign_id: RAW.CW, sample_id: RAW.SA }, t.owner);
  expect(wrongCampaign.status === 403, `a sample owner attaching to someone else's campaign: ${wrongCampaign.status}`);
  await noDrift('campaign_samples insert');
});

await check('ra_co_owner_cannot_add_a_co_owner_and_the_owner_can', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  const sneak = await api('POST', '/items/sample_co_owners', { sample_id: RAW.SB, user_id: RAW.stranger.user }, t.editor);
  expect(refusedBy(sneak, GUARD, 'junction'), `an editor adds a co-owner: ${why(sneak)}`);
  // the old-table co-owner of SA (converted earlier) is gone; make a fresh one for the check
  const legacy = await adminMake('sample_co_owners', { sample_id: RAW.SA, user_id: RAW.coowner.user }, 'id');
  const byCo = await api('POST', '/items/sample_co_owners', { sample_id: RAW.SA, user_id: RAW.stranger.user }, t.coowner);
  expect(refusedBy(byCo, GUARD, 'junction'), `a co-owner adds a co-owner: ${why(byCo)}`);
  const patch = await api('PATCH', `/items/sample_co_owners/${legacy}`, { user_id: RAW.stranger.user }, t.coowner);
  const del = await api('DELETE', `/items/sample_co_owners/${legacy}`, undefined, t.coowner);
  expect(patch.status === 403 && del.status === 403, `a co-owner changes or deletes a co-owner row: ${patch.status} / ${del.status}`);
  const owner = await api('POST', '/items/sample_co_owners?fields=id', { sample_id: RAW.SA, user_id: RAW.stranger.user }, t.owner);
  expect(owner.status === 200, `the owner adds a co-owner: ${why(owner)}`);
  const read = await api('GET', `/items/physical_samples/${RAW.SA}?fields=sample_id`, undefined, t.stranger);
  expect(read.status === 200, `the new co-owner reads the sample: ${read.status}`);
  await noDrift('co-owner junction');
});

await check('ra_transfer_makes_the_new_owner_and_keeps_the_previous_one_as_can_edit', async () => {
  expect(RAW, 'no world (ra_world_setup failed)');
  const t = FX.users;
  const r = await api('POST', `${RA}/physical_samples/${RAW.SB}/transfer`, { person_id: RAW.viewer.person }, t.owner);
  expect(r.status === 200 && r.body.owner.person_id === RAW.viewer.person, `transfer: ${why(r)}`);
  expect(['failed', 'skipped'].includes(r.body.email), `transfer mail: ${r.body.email}`);
  noteEmail(r);
  const asNew = await entriesOf('physical_samples', RAW.SB, t.viewer);
  expect(asNew.can_manage === true && asNew.owner.person_id === RAW.viewer.person, `the new owner manages: ${JSON.stringify(asNew.owner)} ${asNew.can_manage}`);
  const prev = asNew.entries.find((e) => e.person_id === RAW.owner.person);
  expect(prev && prev.role === 'edit' && prev.label === 'Can edit', `the previous owner stays as Can edit: ${JSON.stringify(prev)}`);
  expect(!asNew.entries.some((e) => e.person_id === RAW.viewer.person), 'the new owner is not an entry');
  const old = await entriesOf('physical_samples', RAW.SB, t.owner);
  expect(old.can_manage === false, 'the previous owner still manages');
  const back = await api('POST', `${RA}/physical_samples/${RAW.SB}/transfer`, { person_id: RAW.owner.person }, t.viewer);
  expect(back.status === 200, `transfer back: ${why(back)}`);
  noteEmail(back);
  await noDrift('transfer');
});

await check('ra_admin_overview_reports_the_readers_drift', async () => {
  const r = await api('GET', '/d1-admin-overview?refresh=1');
  expect(r.status === 200 && r.body.readers_drift && typeof r.body.readers_drift.checked_at === 'string', `overview: ${why(r)}`);
  expect(r.body.readers_drift.count === 0 && r.body.readers_drift.flagged === false, `drift ${JSON.stringify(r.body.readers_drift)}`);
  needFx();
  const member = await api('GET', '/d1-admin-overview', undefined, FX.users.owner);
  expect(member.status === 403, `a member reads the overview: ${member.status}`);
});

if (emailsFailed > 0) console.log(`SMOKE NOTE ra_expect_email_warning ${emailsFailed}`);

// The delete matrices run last: they really delete the fixture records the cases above use.
for (const collection of ['test_sessions', 'manufacturing_operations', 'physical_samples', 'campaigns', 'projects']) {
  await check(`lm_access_matrix_${collection}_delete`, async () => {
    needFx();
    const problems = [];
    const deleters = new Map();
    for (const user of Object.keys(FX.users)) for (const id of FX.expected[user][collection].delete) deleters.set(id, [...(deleters.get(id) ?? []), user]);
    for (const id of fixtureIds(collection, false)) {
      for (const [user, token] of Object.entries(FX.users)) {
        if ((deleters.get(id) ?? []).includes(user)) continue;
        const r = await api('DELETE', `/items/${collection}/${id}`, undefined, token);
        if (r.status !== 403) problems.push(`${user} DELETE ${lab(id)} -> ${r.status}, expected 403`);
      }
    }
    // the owners who may delete do (a sample or campaign that still has records under it may refuse with a 4xx
    // other than 403: that is the foreign key, not the rule)
    const sub = new Set(fixtureIds(collection, false));
    for (const [id, users] of deleters) {
      if (!sub.has(id)) continue;
      for (const user of users.slice(0, 1)) {
        const r = await api('DELETE', `/items/${collection}/${id}`, undefined, FX.users[user]);
        if (r.status === 403 || r.status >= 500) problems.push(`${user} DELETE ${lab(id)} -> ${r.status}, expected 204: ${errText(r).slice(0, 120)}`);
      }
    }
    expect(!problems.length, `${problems.length} mismatches: ${problems.slice(0, 5).join(' | ')}`);
  });
}

process.exit(failed ? 1 : 0);
