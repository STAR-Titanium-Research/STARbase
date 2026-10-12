import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlOne } from './lib.mjs';

const OWNED = ['tool_boxes', 'cutting_inserts', 'insert_edges', 'physical_samples', 'manufacturing_operations',
	'test_sessions', 'campaigns', 'etchants', 'prep_recipes'];

for (const t of OWNED) {
	test(`${t}: every legacy owner has an owner_person_id`, () => {
		assert.equal(sqlOne(`SELECT count(*) FROM ${t} WHERE owner IS NOT NULL AND owner_person_id IS NULL`), '0');
	});
}

test('projects: every legacy PI has a principal_investigator_person', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM projects WHERE principal_investigator IS NOT NULL AND principal_investigator_person IS NULL`), '0');
});

test('junctions: every row has a person_id', () => {
	assert.equal(sqlOne(`SELECT (SELECT count(*) FROM project_investigators WHERE person_id IS NULL) + (SELECT count(*) FROM sample_co_owners WHERE person_id IS NULL)`), '0');
});

test("James Pepper's historical operations now carry his person", () => {
	assert.ok(Number(sqlOne(`SELECT count(*) FROM manufacturing_operations WHERE owner_person_id = 'fa2c6071-b0cc-4b7b-ac59-d5cad192b2ed'`)) >= 202);
});
