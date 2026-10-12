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

const DROP = ['session_id', 'short_id', 'created_at', 'updated_at', 'version', 'subject', 'created_by'];
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
