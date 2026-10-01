import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

test('a new login with no matching person gets a new researcher person', async () => {
	const admin = await adminToken();
	const u = await createUser(admin, 'Fresh');
	try {
		const p = personOf(u.userId);
		assert.ok(p, 'person created');
		assert.equal(sqlOne(`SELECT is_researcher FROM people WHERE person_id = '${p}'`), 't');
		assert.equal(sqlOne(`SELECT full_name FROM people WHERE person_id = '${p}'`), 'OwnTest Fresh');
	} finally { await deleteUser(admin, u.userId); }
});

test('a new login links an existing unlinked person with the same email', async () => {
	const admin = await adminToken();
	const email = `own-test-link-${Date.now()}@example.com`;
	const existing = sqlOne(`INSERT INTO people (full_name, email, is_operator) VALUES ('Linky Tech', '${email}', true) RETURNING person_id`);
	const u = await createUser(admin, 'Linky', { email });
	try {
		assert.equal(personOf(u.userId), existing);
		assert.equal(sqlOne(`SELECT is_researcher FROM people WHERE person_id = '${existing}'`), 't');
	} finally {
		await deleteUser(admin, u.userId);
		sql(`DELETE FROM people WHERE person_id = '${existing}'`);
	}
});

test('ambiguous name creates a new person instead of linking either', async () => {
	const admin = await adminToken();
	const tag = `Twin${Date.now()}`;
	const [twin1, twin2] = sql(`INSERT INTO people (full_name) VALUES ('OwnTest ${tag}'), ('OwnTest ${tag}') RETURNING person_id`).map((r) => r[0]);
	const twins = [twin1, twin2];
	const u = await createUser(admin, tag);
	try {
		const p = personOf(u.userId);
		assert.ok(p);
		assert.ok(!twins.includes(p), 'did not link an ambiguous existing row');
	} finally {
		await deleteUser(admin, u.userId);
		sql(`DELETE FROM people WHERE person_id IN ('${twins.join("','")}')`);
	}
});
