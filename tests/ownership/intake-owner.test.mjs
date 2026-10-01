import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

let admin, a, b, typeId;

before(async () => {
	admin = await adminToken();
	a = await createUser(admin, 'IntakeA');
	b = await createUser(admin, 'IntakeB');
	const r = await api('POST', '/items/insert_types', admin, { type_code: `OWNTEST-${Date.now()}`, short_code: `OT${Date.now() % 100000}`, inserts_per_box: 3, edge_count: 2 });
	typeId = r.data.data.insert_type_id;
});

after(async () => {
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
	await api('DELETE', `/items/insert_types/${typeId}`, admin);
	await deleteUser(admin, a.userId);
	await deleteUser(admin, b.userId);
});

async function intake(token, body) {
	const r = await api('POST', '/items/tool_boxes', token, { insert_type_id: typeId, package_quantity: 2, ...body });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	await new Promise((res) => setTimeout(res, 1500));
	return r.data.data.tool_box_id;
}

function owners(firstBoxId) {
	const code = sqlOne(`SELECT split_part(tool_box_code, '-', 1) FROM tool_boxes WHERE tool_box_id = '${firstBoxId}'`);
	return sql(`
		SELECT DISTINCT owner_person_id FROM tool_boxes WHERE insert_type_id = '${typeId}' AND tool_box_code LIKE '${code}-%'
		UNION SELECT DISTINCT ci.owner_person_id FROM cutting_inserts ci JOIN tool_boxes tb ON tb.tool_box_id = ci.tool_box_id WHERE tb.insert_type_id = '${typeId}'
		UNION SELECT DISTINCT ie.owner_person_id FROM insert_edges ie JOIN cutting_inserts ci ON ci.insert_id = ie.insert_id JOIN tool_boxes tb ON tb.tool_box_id = ci.tool_box_id WHERE tb.insert_type_id = '${typeId}'
	`).map((r) => r[0]);
}

test('intake with chosen owner carries it to every row', async () => {
	const first = await intake(a.token, { owner_person_id: personOf(b.userId) });
	assert.deepEqual(owners(first), [personOf(b.userId)]);
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
});

test('intake without an owner uses the login for every row', async () => {
	const first = await intake(a.token, {});
	assert.deepEqual(owners(first), [personOf(a.userId)]);
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
});

test('the code-filling triggers no longer copy the parent owner', async () => {
	const first = await intake(b.token, {});
	const insertId = sqlOne(`INSERT INTO cutting_inserts (tool_box_id) VALUES ('${first}') RETURNING insert_id`);
	assert.equal(sqlOne(`SELECT owner_person_id FROM cutting_inserts WHERE insert_id = '${insertId}'`), null);
	const edgeId = sqlOne(`INSERT INTO insert_edges (insert_id) VALUES ('${insertId}') RETURNING edge_id`);
	assert.equal(sqlOne(`SELECT owner_person_id FROM insert_edges WHERE edge_id = '${edgeId}'`), null);
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
});

test('expand_tool_box_intake no longer reads the legacy owner column and serialises by short code', () => {
	const def = sql(`SELECT pg_get_functiondef('expand_tool_box_intake(uuid)'::regprocedure)`).map((r) => r.join('\t')).join('\n');
	assert.ok(!/v_box\.owner\b(?!_)/.test(def), 'still references v_box.owner');
	assert.match(def, /pg_advisory_xact_lock\(hashtext\(v_short_code\)\)/);
});

test("a manual insert in someone else's box is owned by the login, not the box owner", async () => {
	const first = await intake(b.token, {});
	const r = await api('POST', '/items/cutting_inserts', a.token, { tool_box_id: first });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	assert.equal(r.data.data.owner_person_id, personOf(a.userId));
});
