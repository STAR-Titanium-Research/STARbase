// Directus smoke cases, run by scripts/dev/directus_smoke.sh against a throwaway Directus on a
// restored copy of live. Node 20, no dependencies. One `SMOKE PASS|FAIL <case>` line per case;
// exit 1 on any FAIL. Env: DIRECTUS_URL, TOKEN (admin static token of the copy).
const BASE = process.env.DIRECTUS_URL;
const TOKEN = process.env.TOKEN;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

process.exit(failed ? 1 : 0);
