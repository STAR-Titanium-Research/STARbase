// Write-path timings through a real Directus (A1a Task 2, performance gate), run by scripts/dev/directus_smoke.sh in D1_SMOKE_MODE=perf next to
// scripts/dev/perf_writes.sql (the SQL-level writers). Node 20, no dependencies. One line per scenario:
//   PERFW <scenario> n=<n> p50=<ms> p95=<ms> max=<ms>
// Env: DIRECTUS_URL, TOKEN (admin), D1_SMOKE_PERF_N (repetitions, default 5), D1_PERF_WRITES_ONLY (a scenario name or regex), UI_WAIT_MS (how long
// the import transaction of the "ui_write_wait" scenario stays open: the harness holds it; this script only times the writes meanwhile).
// Scenarios, each end to end as the request is made (and undone afterwards, untimed):
//   force_app_upload          the sequence of apps/force-app/web/src/record/uploadCapture.ts: POST the operation, POST /files, POST machining_force_analysis (a member)
//   coowner_added_big_sample  POST /items/sample_co_owners on the sample in several campaigns of the large project with many operations (admin)
//   tests_with_subjects_x20   20 x POST /items/test_sessions with a subject (migration 139's per-subject UPDATE; one refresh per row)
//   campaign_add_50_samples   50 x POST /items/campaign_samples into the largest campaign of the large project (what Directus does for M2M writes)
//   link_login_big_pi         PATCH /items/people/<PI of the large project> {user_id}: row 45's cascade over the project's whole content (admin)
//   team_join_100_records     POST /d1-teams/<team>/members: a person joins a team given Can edit on 100 records (every grant trusts new members:
//                             100 derived access rows and their readers recompute; People 2, needs migrations 181 and 182 and the d1-teams and
//                             d1-record-access extensions; skipped when /d1-teams does not answer)
//   team_grant_20_members     POST /d1-record-access/physical_samples/<big sample>/entries {team_id, role}: a team of 20 is given Can edit on the big sample
//   ui_write_wait_<kind>      a PATCH of a sample / test / campaign note as a member WHILE the harness holds an import transaction open
const BASE = process.env.DIRECTUS_URL;
const ADMIN = process.env.TOKEN;
const N = Number(process.env.D1_SMOKE_PERF_N || 5);
const ONLY = process.env.D1_PERF_WRITES_ONLY ? new RegExp(process.env.D1_PERF_WRITES_ONLY) : null;
const MEMBER = 'smoke-perf-member';

async function call(method, path, token, body, raw) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: res.status, ms: performance.now() - t0, body: parsed, text };
}
const q = (params) => {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => out.push(`${k}[]=${encodeURIComponent(x)}`));
    else out.push(`${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`);
  }
  return out.join('&');
};
const admin = async (path) => (await call('GET', path, ADMIN)).body?.data;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const report = (name, times) => {
  const t = [...times].sort((a, b) => a - b);
  console.log(`PERFW ${name} n=${t.length} p50=${pct(t, 50).toFixed(0)} p95=${pct(t, 95).toFixed(0)} max=${t[t.length - 1].toFixed(0)}`);
};
let bad = 0;
const want = (name) => !ONLY || ONLY.test(name);
const must = (r, what) => { if (r.status < 200 || r.status >= 300) { console.log(`PERFW ${what} FAILED status=${r.status} ${r.text.slice(0, 200)}`); bad++; return false; } return true; };

// the project with the most operations of its own (the SQL script picks by operations of its own and on its samples; they agree on the seeded copy)
const byProject = (await admin('/items/manufacturing_operations?' + q({ filter: { project_id: { _nnull: true } }, aggregate: { count: '*' }, groupBy: ['project_id'], limit: -1 }))) ?? [];
const bigProjectId = byProject.sort((a, b) => Number(b.count) - Number(a.count))[0]?.project_id;
const bigProject = (await admin('/items/projects?' + q({ filter: { project_id: { _eq: bigProjectId } }, fields: ['project_id', 'principal_investigator_person.person_id', 'principal_investigator_person.user_id'], limit: 1 })))?.[0];
const camps = (await admin('/items/campaign_samples?' + q({ filter: { campaign_id: { project_id: { _eq: bigProject?.project_id } } }, aggregate: { count: '*' }, groupBy: ['campaign_id'], limit: -1 }))) ?? [];
const bigCampaign = camps.sort((a, b) => Number(b.count) - Number(a.count))[0]?.campaign_id;
const method = (await admin('/items/manufacturing_methods?' + q({ filter: { process_category: { _eq: 'machining' } }, fields: ['method_id'], limit: 1 })))?.[0]?.method_id;
// the sample with the most operations among the large project's samples that sit in several campaigns
const sampleCandidates = (await admin('/items/manufacturing_operations?' + q({ filter: { project_id: { _eq: bigProject?.project_id }, sample_id: { _nnull: true } }, aggregate: { count: '*' }, groupBy: ['sample_id'], limit: -1 }))) ?? [];
const bigSample = sampleCandidates.sort((a, b) => Number(b.count) - Number(a.count))[0]?.sample_id;
const someUser = (await admin('/users?' + q({ filter: { email: { _contains: 'example.invalid' }, id: { _nnull: true } }, fields: ['id'], limit: 5 })))?.find(Boolean)?.id;
const members = await admin('/items/sample_co_owners?' + q({ fields: ['user_id'], limit: 1 }));
const coUser = members?.[0]?.user_id ?? someUser;
console.log(`PERFINFO ids project=${bigProject?.project_id} campaign=${bigCampaign} sample=${bigSample} method=${method}`);

// ---- 1. a Force App upload (as the member: a sample they can read is needed, so the sequence runs on one of their own new samples)
if (want('force_app_upload')) {
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const s = await call('POST', '/items/physical_samples?fields=sample_id', MEMBER, { sample_code: `PWUP-${Date.now()}-${i}`, item_type: 'sample', current_status: 'active' });
    if (!must(s, 'force_app_upload sample')) continue;
    const t1 = performance.now();
    const o = await call('POST', '/items/manufacturing_operations?fields=operation_id', MEMBER, { sample_id: s.body.data.sample_id, method_id: method, machining_operation_subtype: 'F', machining_cutting_speed_m_per_min: 30 });
    if (!must(o, 'force_app_upload operation')) continue;
    const form = new FormData();
    form.append('file', new Blob(['PERFW upload ' + i], { type: 'text/plain' }), `perfw-${i}.txt`);
    const f = await call('POST', '/files', MEMBER, form, true);
    if (!must(f, 'force_app_upload file')) continue;
    const a = await call('POST', '/items/machining_force_analysis?fields=id', MEMBER, { operation_id: o.body.data.operation_id, directus_files_id: f.body.data.id, status: 'pending' });
    if (!must(a, 'force_app_upload analysis')) continue;
    times.push(performance.now() - t1);   // the upload sequence itself (operation, file, analysis); the sample is set up before
    await call('DELETE', `/items/physical_samples/${s.body.data.sample_id}`, ADMIN);
    await call('DELETE', `/files/${f.body.data.id}`, ADMIN);
    void t0;
  }
  if (times.length) report('force_app_upload', times);
}

// ---- 2. a co-owner change on the big sample (add, timed; remove untimed)
if (want('coowner_added_big_sample') && bigSample && coUser) {
  const times = [];
  for (let i = 0; i < N; i++) {
    const r = await call('POST', '/items/sample_co_owners?fields=id', ADMIN, { sample_id: bigSample, user_id: coUser });
    if (!must(r, 'coowner_added_big_sample')) break;
    times.push(r.ms);
    await call('DELETE', `/items/sample_co_owners/${r.body.data.id}`, ADMIN);
  }
  if (times.length) report('coowner_added_big_sample', times);
}

// ---- 3. N tests with subjects
if (want('tests_with_subjects_x20') && bigSample) {
  const times = [];
  const rounds = Math.max(1, Math.min(N, 3));
  for (let k = 0; k < rounds; k++) {
    const created = [];
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/items/test_sessions?fields=session_id', ADMIN, { test_type: 'sem', status: 'registered', subject: { create: [{ collection: 'physical_samples', item: { sample_id: bigSample } }], update: [], delete: [] } });
      if (!must(r, 'tests_with_subjects_x20')) break;
      created.push(r.body.data.session_id);
    }
    times.push(performance.now() - t0);
    for (const id of created) await call('DELETE', `/items/test_sessions/${id}`, ADMIN);
  }
  report('tests_with_subjects_x20', times);
}

// ---- 4. adding 50 samples to the largest campaign of the large project
if (want('campaign_add_50_samples') && bigCampaign) {
  const present = new Set(((await admin('/items/campaign_samples?' + q({ filter: { campaign_id: { _eq: bigCampaign } }, fields: ['sample_id'], limit: -1 }))) ?? []).map((r) => r.sample_id));
  const pool = ((await admin('/items/physical_samples?' + q({ filter: { sample_code: { _starts_with: 'PFS' } }, fields: ['sample_id'], limit: 300, sort: ['sample_code'] }))) ?? []).map((r) => r.sample_id).filter((id) => !present.has(id));
  const times = [];
  const rounds = Math.max(1, Math.min(N, 3));
  for (let k = 0; k < rounds; k++) {
    const batch = pool.slice(k * 50, k * 50 + 50);
    const ids = [];
    const t0 = performance.now();
    for (const sid of batch) {
      const r = await call('POST', '/items/campaign_samples?fields=id', ADMIN, { campaign_id: bigCampaign, sample_id: sid });
      if (!must(r, 'campaign_add_50_samples')) break;
      ids.push(r.body.data.id);
    }
    times.push(performance.now() - t0);
    for (const id of ids) await call('DELETE', `/items/campaign_samples/${id}`, ADMIN);
  }
  report('campaign_add_50_samples', times);
}

// ---- 5. linking the login of the PI of the large project
if (want('link_login_big_pi') && bigProject?.principal_investigator_person?.person_id) {
  const pid = bigProject.principal_investigator_person.person_id;
  const uid = bigProject.principal_investigator_person.user_id;
  const times = [];
  for (let i = 0; i < Math.min(N, 3); i++) {
    await call('PATCH', `/items/people/${pid}`, ADMIN, { user_id: null });
    const r = await call('PATCH', `/items/people/${pid}?fields=person_id`, ADMIN, { user_id: uid });
    if (!must(r, 'link_login_big_pi')) break;
    times.push(r.ms);
  }
  if (times.length) report('link_login_big_pi', times);
}

// ---- 5b. teams (People 2): the member makes a team (the creator is its manager), the admin gives it records and members; the join and the
// grant are timed, the setup is not. Each round removes its team (DELETE /d1-teams/<id> takes the grants and derived rows with it).
const teamsOn = (await call('GET', '/d1-teams', ADMIN)).status === 200;
const teamSetup = async (tag) => {
  const t = await call('POST', '/d1-teams', MEMBER, { name: `Perf team ${tag} ${Date.now()}` });
  return must(t, `${tag} team`) ? t.body.team_id : null;
};
const dropTeam = (id) => call('DELETE', `/d1-teams/${id}`, ADMIN);
const people = teamsOn ? ((await admin('/items/people?' + q({ fields: ['person_id', 'user_id'], filter: { user_id: { _nnull: true } }, limit: 60 }))) ?? []) : [];
if (want('team_join_100_records') && teamsOn) {
  const samples = ((await admin('/items/physical_samples?' + q({ fields: ['sample_id'], limit: 100, sort: ['sample_id'] }))) ?? []).map((r) => r.sample_id);
  const times = [];
  for (let k = 0; k < Math.min(N, 3) && samples.length; k++) {
    const team = await teamSetup('join');
    if (!team) break;
    let ok = true;
    for (const sid of samples) {
      const g = await call('POST', `/d1-record-access/physical_samples/${sid}/entries`, ADMIN, { team_id: team, role: 'edit' });
      const t = ok && await call('PATCH', `/d1-record-access/physical_samples/${sid}/entries/team/${team}`, ADMIN, { trust_new_members: true });
      ok = must(g, 'team_join_100_records grant') && must(t, 'team_join_100_records trust');
      if (!ok) break;
    }
    const inTeam = new Set((((await call('GET', `/d1-teams/${team}`, ADMIN)).body?.members) ?? []).map((m) => m.person_id));
    const joiner = ok && people.find((p) => !inTeam.has(p.person_id))?.person_id;
    if (!joiner) { console.log('PERFW team_join_100_records FAILED no joiner or no grants'); bad++; }
    else {
      const r = await call('POST', `/d1-teams/${team}/members`, ADMIN, { person_id: joiner });
      if (must(r, 'team_join_100_records')) times.push(r.ms);
    }
    await dropTeam(team);
  }
  if (times.length) report('team_join_100_records', times);
}
if (want('team_grant_20_members') && teamsOn && bigSample) {
  const times = [];
  for (let k = 0; k < Math.min(N, 3); k++) {
    const team = await teamSetup('grant');
    if (!team) break;
    let ok = true;
    const inTeam = new Set((((await call('GET', `/d1-teams/${team}`, ADMIN)).body?.members) ?? []).map((m) => m.person_id)); // the creator
    let added = inTeam.size;
    for (const person of people) {
      if (added >= 20) break;
      if (inTeam.has(person.person_id)) continue;
      ok = must(await call('POST', `/d1-teams/${team}/members`, ADMIN, { person_id: person.person_id }), 'team_grant_20_members member');
      if (!ok) break;
      added += 1;
    }
    if (ok && added < 20) console.log(`PERFINFO team_grant_20_members only ${added} people with a login in the copy`);
    if (ok) {
      const r = await call('POST', `/d1-record-access/physical_samples/${bigSample}/entries`, ADMIN, { team_id: team, role: 'edit' });
      if (must(r, 'team_grant_20_members')) times.push(r.ms);
    }
    await dropTeam(team);
  }
  if (times.length) report('team_grant_20_members', times);
}

// ---- 6. UI writes while the harness holds an import transaction (a member edits a sample, a test, a campaign note)
if (want('ui_write_wait')) {
  const targets = [
    ['sample', '/items/physical_samples', 'notes', (await admin('/items/physical_samples?' + q({ filter: { sample_code: { _starts_with: 'PFS' } }, fields: ['sample_id'], limit: 1 })))?.[0]?.sample_id],
    ['test', '/items/test_sessions', 'notes', (await admin('/items/test_sessions?' + q({ fields: ['session_id'], limit: 1, sort: ['-created_at'] })))?.[0]?.session_id],
    ['campaign', '/items/campaigns', 'notes', (await admin('/items/campaigns?' + q({ filter: { name: { _starts_with: 'Perf campaign' } }, fields: ['campaign_id'], limit: 1 })))?.[0]?.campaign_id],
  ];
  for (const [kind, path, field, id] of targets) {
    if (!id) continue;
    const r = await call('PATCH', `${path}/${id}?fields=${field}`, ADMIN, { [field]: `perf ui wait ${Date.now()}` });
    console.log(`PERFW ui_write_wait_${kind} n=1 p50=${r.ms.toFixed(0)} p95=${r.ms.toFixed(0)} max=${r.ms.toFixed(0)} status=${r.status}`);
  }
}
process.exit(bad ? 1 : 0);
