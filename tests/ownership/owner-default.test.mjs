import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

let admin, a, b, methodId, sampleId, techId;
const cleanup = [];

before(async () => {
	admin = await adminToken();
	a = await createUser(admin, 'OwnerA');
	b = await createUser(admin, 'OwnerB');
	methodId = sqlOne(`SELECT method_id FROM manufacturing_methods WHERE method_code = 'MT'`);
	// manufacturing_operations_has_sample requires an input/output sample (or a source system).
	sampleId = sqlOne(`SELECT sample_id FROM physical_samples LIMIT 1`);
	techId = sqlOne(`INSERT INTO people (full_name, is_operator) VALUES ('OwnTest Technician ${Date.now()}', true) RETURNING person_id`);
});

after(async () => {
	for (const [col, id] of cleanup.reverse()) await api('DELETE', `/items/${col}/${id}`, admin);
	sql(`DELETE FROM people WHERE person_id = '${techId}'`);
	await deleteUser(admin, a.userId);
	await deleteUser(admin, b.userId);
});

async function create(token, collection, body, pk) {
	const r = await api('POST', `/items/${collection}`, token, body);
	assert.equal(r.status, 200, JSON.stringify(r.data));
	cleanup.push([collection, r.data.data[pk]]);
	return r.data.data;
}

test('blank owner is filled with the logged-in researcher', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `OD-${Date.now()}` }, 'sample_id');
	assert.equal(s.owner_person_id, personOf(a.userId));
});

test('explicit null owner is filled from login', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `ODN-${Date.now()}`, owner_person_id: null }, 'sample_id');
	assert.equal(s.owner_person_id, personOf(a.userId));
});

test('an explicitly chosen owner is kept', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `ODX-${Date.now()}`, owner_person_id: personOf(b.userId) }, 'sample_id');
	assert.equal(s.owner_person_id, personOf(b.userId));
});

test('login wins over the campaign owner; project is still inherited', async () => {
	const project = sqlOne(`SELECT project_id FROM projects LIMIT 1`);
	const c = await create(b.token, 'campaigns', { project_id: project, campaign_type: 'machining_trial', name: `OD-C-${Date.now()}` }, 'campaign_id');
	assert.equal(c.owner_person_id, personOf(b.userId));
	const op = await create(a.token, 'manufacturing_operations', { method_id: methodId, sample_id: sampleId, campaign_id: c.campaign_id }, 'operation_id');
	assert.equal(op.owner_person_id, personOf(a.userId));
	assert.equal(op.project_id, project);
});

test('force-app-shaped operation: owner from login, operator preserved', async () => {
	const op = await create(a.token, 'manufacturing_operations', {
		method_id: methodId, sample_id: sampleId, operator_person_id: techId, process_category: 'machining',
		capture_software: 'force-app', machining_force_captured: true,
	}, 'operation_id');
	assert.equal(op.owner_person_id, personOf(a.userId));
	assert.equal(op.operator_person_id, techId);
});

test('projects: PI defaults to the login', async () => {
	const p = await create(a.token, 'projects', { project_name: `OD-P-${Date.now()}` }, 'project_id');
	assert.equal(p.principal_investigator_person, personOf(a.userId));
});

test('machine-like login leaves owner blank', async () => {
	const m = await createUser(admin, 'Machine');
	sql(`UPDATE people SET is_researcher = false WHERE user_id = '${m.userId}'`);
	try {
		const s = await create(m.token, 'physical_samples', { sample_code: `ODM-${Date.now()}` }, 'sample_id');
		assert.equal(s.owner_person_id, null);
	} finally { await deleteUser(admin, m.userId); }
});

test('PATCH keeps a non-researcher owner', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `ODP-${Date.now()}` }, 'sample_id');
	sql(`UPDATE physical_samples SET owner_person_id = '${techId}' WHERE sample_id = '${s.sample_id}'`);
	const r = await api('PATCH', `/items/physical_samples/${s.sample_id}`, a.token, { nickname: 'edited' });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	assert.equal(sqlOne(`SELECT owner_person_id FROM physical_samples WHERE sample_id = '${s.sample_id}'`), techId);
});
