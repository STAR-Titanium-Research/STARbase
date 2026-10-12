import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sqlOne } from './lib.mjs';

const TABLES = ['physical_samples', 'tool_boxes', 'cutting_inserts', 'insert_edges', 'etchants', 'prep_recipes',
	'campaigns', 'manufacturing_operations', 'test_sessions', 'projects'];

for (const t of TABLES) {
	test(`${t} has a created_by column`, () => {
		assert.equal(sqlOne(`SELECT count(*) FROM information_schema.columns WHERE table_name = '${t}' AND column_name = 'created_by'`), '1');
	});
}

test('created_by is stamped from the login and survives an owner change', async () => {
	const admin = await adminToken();
	const jozef = await createUser(admin, 'Jozefish');
	const dennis = await createUser(admin, 'Dennisish');
	let sampleId;
	try {
		const r = await api('POST', '/items/physical_samples', jozef.token, { sample_code: `CB-${Date.now()}` });
		assert.equal(r.status, 200, JSON.stringify(r.data));
		sampleId = r.data.data.sample_id;
		assert.equal(r.data.data.created_by, jozef.userId);
		const u = await api('PATCH', `/items/physical_samples/${sampleId}`, jozef.token, { owner_person_id: personOf(dennis.userId) });
		assert.equal(u.status, 200, JSON.stringify(u.data));
		assert.equal(sqlOne(`SELECT created_by FROM physical_samples WHERE sample_id = '${sampleId}'`), jozef.userId);
	} finally {
		if (sampleId) await api('DELETE', `/items/physical_samples/${sampleId}`, admin);
		await deleteUser(admin, jozef.userId);
		await deleteUser(admin, dennis.userId);
	}
});
