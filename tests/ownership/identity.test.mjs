import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql, sqlOne } from './lib.mjs';

test('every non-suspended login has exactly one person', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM directus_users u
		WHERE u.status <> 'suspended' AND NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id = u.id)`), '0');
});

test('every login-linked person is a researcher', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE user_id IS NOT NULL AND NOT is_researcher`), '0');
});

test('Dennis is standardised on dennis.premoli2 and the other logins are suspended', () => {
	assert.equal(sqlOne(`SELECT user_id FROM people WHERE person_id = '4319d317-d5eb-4c99-bf68-4d124e939525'`),
		'59422866-e6be-463b-ac1f-a2c885034c2a');
	assert.equal(sqlOne(`SELECT count(*) FROM directus_users WHERE status = 'suspended'
		AND id IN ('39be2287-8c25-5f80-8c68-803cdaca77a1','5e9b44c7-0938-4c94-9322-382bd48a3fdf')`), '2');
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE full_name = 'dennis.premoli@gmail.com'`), '0');
});

// Logins are managed by admins and come and go (invites get deleted and re-sent),
// so these check the merges held rather than which logins currently exist.
test('Sam Lister is one person', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE full_name IN ('Sam', 'Sam Lister')`), '1');
});

test('James Pepper and Jack Krohn are each one person', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE full_name = 'James Pepper'`), '1');
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE full_name = 'Jack Krohn'`), '1');
});

test('no legacy login FK still points at an alias login', () => {
	assert.equal(sqlOne(`SELECT
		(SELECT count(*) FROM campaigns WHERE owner IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM physical_samples WHERE owner IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM manufacturing_operations WHERE owner IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM projects WHERE principal_investigator IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM project_investigators WHERE user_id IN (SELECT alias_user_id FROM login_aliases))`), '0');
});

test('merge_person repoints references and removes the dropped row', () => {
	const [keep, drop] = sql(`INSERT INTO people (full_name) VALUES ('MergeTest Keep'), ('MergeTest Drop') RETURNING person_id`).map((r) => r[0]);
	const sample = sqlOne(`INSERT INTO physical_samples (sample_code, owner_person_id) VALUES ('MERGE-TEST-${Date.now()}', '${drop}') RETURNING sample_id`);
	try {
		sql(`SELECT merge_person('${keep}', '${drop}')`);
		assert.equal(sqlOne(`SELECT owner_person_id FROM physical_samples WHERE sample_id = '${sample}'`), keep);
		assert.equal(sqlOne(`SELECT count(*) FROM people WHERE person_id = '${drop}'`), '0');
	} finally {
		sql(`DELETE FROM physical_samples WHERE sample_id = '${sample}'`);
		sql(`DELETE FROM people WHERE person_id IN ('${keep}', '${drop}')`);
	}
});
