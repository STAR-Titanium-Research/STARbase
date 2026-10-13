// Performance gate for the record access rules (A1a Task 2), run by scripts/dev/directus_smoke.sh with
// D1_SMOKE_MODE=perf on the seeded copy (scripts/dev/seed_access_fixture.sql). Node 20, no dependencies.
// Replays the Explorer's real requests as two Lab Members and prints one line per request:
//   PERF <user> <request> n=<n> p50=<ms> p95=<ms> max=<ms> rows=<filter_count or rows returned>
// Users: stranger (involved in nothing: the rules scan everything and return the orphan FAST runs) and member
// (co-owner of 20 samples, investigator of two projects, owner of 30 operations). Limit of the plan: p95 under 300 ms
// per list request, and not more than 2x today's median. Run once with --skip 20261012000166 (and 167) for "before",
// once without for "after", on the same seed.
// The requests mirror packages/d1-ui/src/index/indexConfig.ts + indexQuery.ts (index lists), core/extensions/d1-home
// home/LabStats.vue (Home counts), pages/projects/useProjectsIndex.ts, pages/sample/useSampleData.ts,
// pages/operation/useOperationData.ts and pages/projects/useProjectData.ts (record pages), with the same fields,
// sorts, limits and filters.
import { createHash } from 'node:crypto';

const BASE = process.env.DIRECTUS_URL;
const N = Number(process.env.D1_SMOKE_PERF_N || 20);
const TOKENS = { stranger: 'smoke-perf-stranger', member: 'smoke-perf-member' };
const ADMIN = process.env.TOKEN;
// a request that takes longer than this is reported as a timeout and not repeated
const TIMEOUT_MS = Number(process.env.D1_SMOKE_PERF_TIMEOUT_MS || 60000);

const q = (params) => {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => out.push(`${k}[]=${encodeURIComponent(x)}`));
    else out.push(`${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`);
  }
  return out.join('&');
};

async function call(method, path, token, body) {
  const t0 = performance.now();
  let res;
  let text = '';
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { status: 0, ms: performance.now() - t0, body: null, timeout: true };
    throw e;
  }
  const ms = performance.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, ms, body: parsed };
}
const get = (path, token) => call('GET', path, token);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const admin = async (path) => (await get(path, ADMIN)).body?.data;

// --- the request lists ------------------------------------------------------------------------------------------------
const INDEX = [
  ['operations_index', '/items/manufacturing_operations?' + q({
    fields: ['operation_id', 'pass_code', 'sample_id.sample_code', 'method_id.method_code', 'equipment_id.equipment_name', 'operation_date', 'operator_name', 'outcome_notes'],
    sort: ['-operation_date'], limit: 50, page: 1, meta: 'filter_count' })],
  ['operations_index_page3', '/items/manufacturing_operations?' + q({
    fields: ['operation_id', 'pass_code', 'sample_id.sample_code', 'method_id.method_code', 'operation_date'],
    sort: ['-operation_date'], limit: 50, page: 3, meta: 'filter_count' })],
  ['operations_no_owner_machining', '/items/manufacturing_operations?' + q({
    fields: ['operation_id', 'pass_code'], sort: ['-operation_date'], limit: 50, meta: 'filter_count',
    filter: { _and: [{ _and: [{ owner_person_id: { _null: true } }, { _or: [{ process_category: { _null: true } }, { process_category: { _neq: 'sintering' } }] }] }] } })],
  ['tests_index', '/items/test_sessions?' + q({
    fields: ['session_id', 'test_code', 'test_type', 'sample_id.sample_code', 'session_date', 'status'], sort: ['-session_date'], limit: 50, meta: 'filter_count' })],
  ['campaigns_index', '/items/campaigns?' + q({
    fields: ['campaign_id', 'campaign_code', 'name', 'project_id.project_code', 'campaign_type', 'status', 'start_date', 'end_date'],
    sort: ['-start_date'], limit: 50, meta: 'filter_count' })],
  ['samples_index', '/items/physical_samples?' + q({
    fields: ['sample_id', 'sample_code', 'project_id.project_code', 'form', 'current_status', 'location', 'created_at'], sort: ['-created_at'], limit: 50, meta: 'filter_count' })],
  ['projects_index', '/items/projects?' + q({
    fields: ['project_id', 'project_code', 'project_name', 'is_active', 'start_date', 'end_date', 'principal_investigator_person.person_id', 'principal_investigator_person.full_name', 'principal_investigator_person.user_id'],
    sort: ['project_code'], limit: 500 })],
  ['projects_campaign_counts', '/items/campaigns?' + q({ aggregate: { count: '*' }, groupBy: ['project_id'], filter: { project_id: { _nnull: true } }, limit: -1 })],
  ['projects_sample_counts', '/items/physical_samples?' + q({ aggregate: { count: '*' }, groupBy: ['project_id'], filter: { project_id: { _nnull: true } }, limit: -1 })],
  ['home_count_samples', '/items/physical_samples?' + q({ aggregate: { count: '*' }, limit: 1 })],
  ['home_count_machining', '/items/manufacturing_operations?' + q({ aggregate: { count: '*' }, limit: 1, filter: { process_category: { _neq: 'sintering' } } })],
  ['home_count_fast', '/items/manufacturing_operations?' + q({ aggregate: { count: '*' }, limit: 1, filter: { process_category: { _eq: 'sintering' } } })],
  ['home_count_tests', '/items/test_sessions?' + q({ aggregate: { count: '*' }, limit: 1 })],
  ['home_count_projects', '/items/projects?' + q({ aggregate: { count: '*' }, limit: 1 })],
  ['home_count_campaigns', '/items/campaigns?' + q({ aggregate: { count: '*' }, limit: 1 })],
];

const SAMPLE_FIELDS = [
  'sample_id', 'sample_code', 'nickname', 'form', 'current_status', 'item_type', 'stock_category', 'location', 'notes', 'surface_finish',
  'manufacturing_route', 'manufactured_date', 'mounted', 'mounting_method', 'export_controlled', 'mass_grams', 'diameter_mm',
  'inner_diameter_mm', 'length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm', 'created_at', 'updated_at', 'version',
  'material_id.material_id', 'material_id.common_name', 'material_id.alloy_code', 'material_id.density_g_per_cm3',
  'project_id.project_id', 'project_id.project_code', 'project_id.project_name', 'owner_person_id.person_id', 'owner_person_id.full_name',
  'co_owners.user_id.first_name', 'co_owners.user_id.last_name', 'primary_method_id.method_id', 'primary_method_id.method_name',
];
const OPERATION_FIELDS = [
  'operation_id', 'pass_code', 'operation_sequence', 'operation_date', 'process_category', 'operator_name', 'outcome_notes', 'capture_software',
  'capture_frequency_khz', 'force_file_id', 'source_system', 'method_id.method_id', 'method_id.method_name', 'equipment_id.equipment_id',
  'equipment_id.equipment_name', 'project_id.project_id', 'project_id.project_code', 'project_id.project_name', 'campaign_id.campaign_id',
  'campaign_id.campaign_code', 'campaign_id.name', 'owner_person_id.person_id', 'owner_person_id.full_name', 'operator_person_id.person_id',
  'operator_person_id.full_name', 'sample_id.sample_id', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.form', 'sample_id.current_status',
  'output_sample_id.sample_id', 'output_sample_id.sample_code', 'output_sample_id.nickname', 'output_sample_id.form', 'output_sample_id.current_status',
];
const PROJECT_FIELDS = ['project_id', 'project_code', 'project_name', 'is_active', 'start_date', 'end_date',
  'principal_investigator_person.person_id', 'principal_investigator_person.full_name', 'principal_investigator_person.user_id'];

function samplePage(label, id) {
  return [
    [`${label}_sample_item`, `/items/physical_samples/${id}?` + q({ fields: SAMPLE_FIELDS })],
    [`${label}_sample_operations`, '/items/manufacturing_operations?' + q({
      filter: { sample_id: { _eq: id } }, sort: ['operation_sequence', 'operation_date'], limit: 101,
      fields: ['operation_id', 'pass_code', 'operation_sequence', 'operation_date', 'process_category', 'method_id.method_name', 'equipment_id.equipment_name', 'operator_name', 'sample_id.sample_code'] })],
    [`${label}_sample_tests`, '/items/test_sessions?' + q({
      filter: { _or: [{ sample_id: { _eq: id } }, { subject: { _some: { _and: [{ collection: { _eq: 'physical_samples' } }, { item: { _eq: id } }] } } }] },
      sort: ['session_date'], limit: 101, fields: ['session_id', 'test_type', 'test_category', 'session_date', 'status', 'equipment_id.equipment_name', 'operator_name'] })],
    [`${label}_sample_campaigns`, '/items/campaign_samples?' + q({ filter: { sample_id: { _eq: id } }, limit: 20, fields: ['campaign_id.campaign_id', 'campaign_id.campaign_code', 'campaign_id.name'] })],
    [`${label}_sample_all_fields`, `/items/physical_samples/${id}?fields=*`],
  ];
}
function operationPage(label, id) {
  return [
    [`${label}_operation_item`, `/items/manufacturing_operations/${id}?` + q({ fields: OPERATION_FIELDS })],
    [`${label}_operation_all_fields`, `/items/manufacturing_operations/${id}?fields=*`],
  ];
}
function projectPage(label, id) {
  const byProject = { project_id: { _eq: id } };
  return [
    [`${label}_project_item`, `/items/projects/${id}?` + q({ fields: PROJECT_FIELDS })],
    [`${label}_project_all_fields`, `/items/projects/${id}?fields=*`],
    [`${label}_project_samples`, '/items/physical_samples?' + q({
      filter: { _and: [byProject, { campaigns: { _none: { campaign_id: { _nnull: true } } } }] }, sort: ['sample_code'], limit: 101,
      fields: ['sample_id', 'sample_code', 'form', 'current_status', 'material_id.common_name'] })],
    [`${label}_project_operations`, '/items/manufacturing_operations?' + q({
      filter: { _and: [byProject, { campaign_id: { _null: true } }] }, sort: ['-operation_date'], limit: 101,
      fields: ['operation_id', 'pass_code', 'operation_sequence', 'process_category', 'operation_date', 'sample_id.sample_code'] })],
    [`${label}_project_tests`, '/items/test_sessions?' + q({
      filter: { _and: [byProject, { campaign_id: { _null: true } }] }, sort: ['-session_date'], limit: 101,
      fields: ['session_id', 'test_type', 'status', 'session_date', 'sample_id.sample_code'] })],
    [`${label}_project_rollup`, '/items/project_rollup?' + q({ filter: byProject, limit: 200, fields: ['row_id', 'kind', 'code', 'detail'] })],
  ];
}
function campaignPage(label, id) {
  return [[`${label}_campaign_all_fields`, `/items/campaigns/${id}?fields=*`]];
}

// --- what to ask for: records of the seed ---------------------------------------------------------------------------
// the member's user id is the seed's perf.id('user-member'): md5('smoke-perf-user-member') written as a uuid
const md5 = createHash('md5').update('smoke-perf-user-member').digest('hex');
const memberUser = `${md5.slice(0, 8)}-${md5.slice(8, 12)}-${md5.slice(12, 16)}-${md5.slice(16, 20)}-${md5.slice(20)}`;
const coOwned = (await admin('/items/sample_co_owners?' + q({ filter: { user_id: { _eq: memberUser } }, limit: 1, fields: ['sample_id'] })))?.[0]?.sample_id;
const hiddenSample = (await admin('/items/physical_samples?' + q({ filter: { _and: [{ restricted: { _eq: true } }, { sample_code: { _starts_with: 'PFS' } }] }, limit: 1, fields: ['sample_id'] })))?.[0]?.sample_id;
const anOp = (await admin('/items/manufacturing_operations?' + q({ filter: { sample_id: { _eq: coOwned } }, limit: 1, fields: ['operation_id'] })))?.[0]?.operation_id;
const aProject = (await admin('/items/projects?' + q({ filter: { project_code: { _eq: 'PFP1' } }, limit: 1, fields: ['project_id'] })))?.[0]?.project_id;
const aCampaign = (await admin('/items/campaigns?' + q({ filter: { name: { _starts_with: 'Perf campaign' } }, limit: 1, fields: ['campaign_id'] })))?.[0]?.campaign_id;

// The Force App's list requests (apps/force-app/web/src/record/directusLookups.ts searchPastOperations, workspace.ts replay search,
// uploadResume.ts findAnalysisRow, settings/captureUploadState.ts fetchAnalysisRows) and the other child lists of an operation.
const analysed = (await admin('/items/machining_force_analysis?' + q({ filter: { operation_id: { _nnull: true } }, limit: 80, sort: ['-created_at'], fields: ['operation_id'] }))) ?? [];
const analysedIds = analysed.map((r) => r.operation_id);
const anAnalysedOp = analysedIds[0];
const FORCE = [
  ['force_past_operations', '/items/machining_force_analysis?' + q({
    filter: { status: { _eq: 'done' } }, limit: 15, sort: ['-created_at'],
    fields: ['id', 'peak_fx', 'peak_fy', 'peak_fz', 'operation_id.pass_code', 'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname'] })],
  ['force_past_operations_search', '/items/machining_force_analysis?' + q({
    filter: { status: { _eq: 'done' }, _or: [{ operation_id: { pass_code: { _icontains: 'PF' } } }, { operation_id: { sample_id: { sample_code: { _icontains: 'PFS1' } } } }, { operation_id: { sample_id: { nickname: { _icontains: 'PF' } } } }] },
    limit: 15, sort: ['-created_at'],
    fields: ['id', 'peak_fx', 'peak_fy', 'peak_fz', 'operation_id.pass_code', 'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname'] })],
  ['force_replay_search', '/items/machining_force_analysis?' + q({
    filter: { status: { _eq: 'done' } }, limit: 25, sort: ['-created_at'],
    fields: ['id', 'status', 'operation_id.operation_id', 'operation_id.pass_code', 'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname'] })],
  ['force_analysis_rows_in', '/items/machining_force_analysis?' + q({ filter: { operation_id: { _in: analysedIds } }, fields: ['operation_id', 'live_cache_file', 'directus_files_id'], limit: -1 })],
  ['force_analysis_count', '/items/machining_force_analysis?' + q({ aggregate: { count: '*' }, limit: 1 })],
  ['fast_run_data_list', '/items/fast_run_data?' + q({ fields: ['operation_id', 'status'], limit: 50, meta: 'filter_count' })],
  ['operation_data_files_list', '/items/operation_data_files?' + q({ fields: ['operation_id', 'directus_files_id'], limit: 50, meta: 'filter_count' })],
];
if (anAnalysedOp) {
  FORCE.push(['force_analysis_for_op', '/items/machining_force_analysis?' + q({ filter: { operation_id: { _eq: anAnalysedOp } }, fields: ['id', 'live_cache_file', 'directus_files_id'], limit: 10 })]);
  FORCE.push(['fast_run_data_for_op', '/items/fast_run_data?' + q({ filter: { operation_id: { _eq: anAnalysedOp } }, fields: ['operation_id', 'status'], limit: 10 })]);
  FORCE.push(['operation_data_files_for_op', '/items/operation_data_files?' + q({ filter: { operation_id: { _eq: anAnalysedOp } }, fields: ['operation_id', 'directus_files_id'], limit: 10 })]);
}
let requests = [...INDEX, ...FORCE];
if (coOwned) requests.push(...samplePage('co_owned', coOwned));
if (hiddenSample) requests.push(...samplePage('restricted', hiddenSample));
if (anOp) requests.push(...operationPage('co_owned', anOp));
if (aProject) requests.push(...projectPage('P1', aProject));
if (aCampaign) requests.push(...campaignPage('C', aCampaign));

// D1_SMOKE_PERF_ONLY=<regex> keeps the requests whose name matches; D1_SMOKE_PERF_USERS=stranger or member keeps one user
if (process.env.D1_SMOKE_PERF_ONLY) requests = requests.filter(([label]) => new RegExp(process.env.D1_SMOKE_PERF_ONLY).test(label));
const USERS = (process.env.D1_SMOKE_PERF_USERS || 'stranger,member').split(',');

let bad = 0;
for (const user of USERS) {
  for (const [label, path] of requests) {
    const first = await get(path, TOKENS[user]); // warm-up (plan cache, connection) is not counted
    if (first.timeout) {
      console.log(`PERF ${user} ${label} n=1 p50=>${TIMEOUT_MS} p95=>${TIMEOUT_MS} max=>${TIMEOUT_MS} rows= (TIMEOUT)`);
      continue;
    }
    if (first.status !== 200 && first.status !== 403) {
      console.log(`PERF ${user} ${label} FAILED status=${first.status} ${JSON.stringify(first.body?.errors ?? first.body).slice(0, 200)}`);
      bad++;
      continue;
    }
    // a request that already took seconds is measured fewer times (the projects list is minutes at N = 20)
    const n = first.ms > 3000 ? Math.min(N, 3) : N;
    const times = [];
    for (let i = 0; i < n; i++) times.push((await get(path, TOKENS[user])).ms);
    times.sort((a, b) => a - b);
    const rows = first.body?.meta?.filter_count ?? (Array.isArray(first.body?.data) ? first.body.data.length : first.status === 200 ? 1 : 0);
    // duplicates: a list whose first field is a key must not repeat it (the readers rules are EXISTS tests, so none may)
    const data = Array.isArray(first.body?.data) ? first.body.data : [];
    const key = data.length && !('count' in data[0]) ? Object.keys(data[0])[0] : null;
    const dups = key ? data.length - new Set(data.map((r) => JSON.stringify(r[key]))).size : 0;
    console.log(`PERF ${user} ${label} n=${n} p50=${pct(times, 50).toFixed(0)} p95=${pct(times, 95).toFixed(0)} max=${times[times.length - 1].toFixed(0)} rows=${rows} dups=${dups}${first.status === 403 ? ' (403 not visible)' : ''}`);
  }
}
// one save as a co-owner (the sample's editors may save): PATCH notes with a narrow read-back, N times
if (coOwned) {
  const times = [];
  for (let i = 0; i < Math.min(N, 10); i++) {
    const r = await call('PATCH', `/items/physical_samples/${coOwned}?fields=sample_id`, TOKENS.member, { notes: `perf save ${i}` });
    if (r.status !== 200) { console.log(`PERF member save_sample FAILED status=${r.status}`); bad++; break; }
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  if (times.length) console.log(`PERF member save_sample n=${times.length} p50=${pct(times, 50).toFixed(0)} p95=${pct(times, 95).toFixed(0)} max=${times[times.length - 1].toFixed(0)} rows=1`);
}
process.exit(bad ? 1 : 0);
