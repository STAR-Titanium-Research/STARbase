import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

test('a researcher can record several operators on an operation', async () => {
	const admin = await adminToken();
	const u = await createUser(admin, 'MultiOp');
	const methodId = sqlOne(`SELECT method_id FROM manufacturing_methods WHERE method_code = 'MT'`);
	// manufacturing_operations_has_sample requires an input/output sample (or a source system).
	const sampleId = sqlOne(`SELECT sample_id FROM physical_samples LIMIT 1`);
	const [t1, t2] = sql(`INSERT INTO people (full_name, is_operator) VALUES ('OwnTest TechA ${Date.now()}', true), ('OwnTest TechB ${Date.now()}', true) RETURNING person_id`).map((r) => r[0]);
	let opId;
	try {
		const r = await api('POST', '/items/manufacturing_operations', u.token, {
			method_id: methodId, sample_id: sampleId, operator_person_id: t1, additional_operators: [{ person_id: t2 }],
		});
		assert.equal(r.status, 200, JSON.stringify(r.data));
		opId = r.data.data.operation_id;
		const g = await api('GET', `/items/manufacturing_operations/${opId}?fields=operator_person_id,additional_operators.person_id`, u.token);
		assert.equal(g.status, 200, JSON.stringify(g.data));
		assert.equal(g.data.data.operator_person_id, t1);
		assert.deepEqual(g.data.data.additional_operators.map((x) => x.person_id), [t2]);
	} finally {
		if (opId) await api('DELETE', `/items/manufacturing_operations/${opId}`, admin);
		sql(`DELETE FROM people WHERE person_id IN ('${t1}', '${t2}')`);
		await deleteUser(admin, u.userId);
	}
});

test('test sessions accept additional operators too', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM directus_relations WHERE many_collection = 'session_additional_operators' AND many_field = 'session_id' AND one_field = 'additional_operators'`), '1');
});

test('merge_person dedupes an additional-operator row that would clash', () => {
	const op = sqlOne(`SELECT operation_id FROM manufacturing_operations LIMIT 1`);
	const [keep, drop] = sql(`INSERT INTO people (full_name) VALUES ('OwnTest MKeep'), ('OwnTest MDrop') RETURNING person_id`).map((r) => r[0]);
	try {
		sql(`INSERT INTO operation_additional_operators (operation_id, person_id) VALUES ('${op}', '${keep}'), ('${op}', '${drop}')`);
		sql(`SELECT merge_person('${keep}', '${drop}')`);
		assert.equal(sqlOne(`SELECT count(*) FROM operation_additional_operators WHERE operation_id = '${op}' AND person_id = '${keep}'`), '1');
	} finally {
		sql(`DELETE FROM operation_additional_operators WHERE person_id IN ('${keep}', '${drop}')`);
		sql(`DELETE FROM people WHERE person_id IN ('${keep}', '${drop}')`);
	}
});
