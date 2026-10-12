import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sqlOne } from './lib.mjs';

// Expected count comes straight from the filled sheet (MAP/NEW rows' operations).
const expected = Number(execFileSync('py', ['-3', '-c', `
from openpyxl import load_workbook
ws = load_workbook('db/mappings/operator-mapping.xlsx', data_only=True)['Operators']
n = 0
for r in range(2, ws.max_row + 1):
    a, c = ws.cell(r, 1).value, ws.cell(r, 3).value
    if a is None or not str(a).strip().isdigit(): break
    if str(ws.cell(r, 5).value or '').strip().upper() in ('MAP', 'NEW'): n += int(c)
print(n)`], { encoding: 'utf8' }).trim());

test('every MAP/NEW operator row now links its operations to a person', () => {
	const linked = Number(sqlOne(`SELECT count(*) FROM manufacturing_operations
		WHERE operator IS NOT NULL AND operator_person_id IS NOT NULL
		  AND operator IN (SELECT id FROM "Machine_Operators")`));
	assert.ok(linked >= expected, `linked ${linked} >= expected ${expected}`);
});

// [[machine_operator_id, [additional names]]] for MAP/NEW rows that list additional people.
const multi = JSON.parse(execFileSync('py', ['-3', '-c', `
import json
from openpyxl import load_workbook
ws = load_workbook('db/mappings/operator-mapping.xlsx', data_only=True)['Operators']
out = []
for r in range(2, ws.max_row + 1):
    a = ws.cell(r, 1).value
    if a is None or not str(a).strip().isdigit(): break
    if str(ws.cell(r, 5).value or '').strip().upper() not in ('MAP', 'NEW'): continue
    extra = [p.strip() for p in str(ws.cell(r, 13).value or '').split(',') if p.strip()]
    if extra: out.append([int(a), extra])
print(json.dumps(out))`], { encoding: 'utf8' }).trim());

test('multi-person rows put every extra person on each operation as an additional operator', () => {
	assert.ok(multi.length > 0, 'sheet has multi-person rows');
	for (const [opId, names] of multi) {
		for (const name of names) {
			const missing = sqlOne(`SELECT count(*) FROM manufacturing_operations o
				WHERE o.operator = ${opId}
				  AND NOT EXISTS (SELECT 1 FROM operation_additional_operators x JOIN people p ON p.person_id = x.person_id
				                  WHERE x.operation_id = o.operation_id AND lower(p.full_name) = lower('${name.replace(/'/g, "''")}'))`);
			assert.equal(missing, '0', `operator ${opId} missing additional ${name}`);
		}
	}
});

test('operator_name text is untouched for every operation', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM manufacturing_operations WHERE operator IS NOT NULL AND nullif(trim(operator_name), '') IS NULL`), '0');
});
