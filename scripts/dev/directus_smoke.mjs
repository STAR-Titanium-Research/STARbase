// Directus smoke cases, run by scripts/dev/directus_smoke.sh against a throwaway Directus on a
// restored copy of live. Node 20, no dependencies. One `SMOKE PASS|FAIL <case>` line per case;
// exit 1 on any FAIL. Env: DIRECTUS_URL, TOKEN (admin static token of the copy),
// LM_TOKEN (static token of a Lab Member user created in the copy, with its own people row; is_researcher).
// The lm_* cases need that user to be able to read at all. When Directus answers the probe read with the known
// `_some ... can only be used with top level relational alias field` 400 (the Lab Member permission rows, see
// task-6 report) they print `SMOKE SKIP <case>: <reason>` and do not fail the run; any other probe failure (401,
// 403, 500, another 400) leaves them to run and FAIL. D1_SMOKE_REQUIRE_LM=1 (or true) makes the skip a FAIL.
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

process.exit(failed ? 1 : 0);
