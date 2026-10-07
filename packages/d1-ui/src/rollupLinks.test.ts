import { describe, expect, it } from 'vitest';
import { md5 } from './md5';
import { recordRoute } from './recordRoute';
import { rollupOperationsFilter, rollupRowId, rollupTargets } from './rollupLinks';

const P = 'a0000000-0000-4000-8000-000000000001';

// Expected values were produced by Postgres with the formulas of v_project_rollup (migration
// 20261002000116), e.g. SELECT md5('sample:' || <project> || ':' || <sample>).
const SQL = {
	op1: '7744ee69222bd684de29d5ee72e2c073',
	op2: '650785d5d3a7295ec15711ffdb62b98a',
	sample: 'dedb8b9102e6d920a620b28c2db605c1',
	equipment: '8ee3a5f38ee88563582ff1275b6646da',
	tool: '86323865acfb31f4fb8ca4cd14b8b980',
	edge: '68657cf91ec1f8a881b6396e332345aa',
	insert: '864ebde6d502ef4a105f1dd777d43504',
	material: '874d8058d5c734e0aad6fc10a56cde82',
};

const O1 = 'b0000000-0000-4000-8000-000000000001';
const O2 = 'b0000000-0000-4000-8000-000000000002';
const ops = [
	{
		operation_id: O1,
		sample_id: { sample_id: 'c0000000-0000-4000-8000-000000000001' },
		equipment_id: { equipment_id: 'd0000000-0000-4000-8000-000000000001' },
		tool_id: { tool_id: 'e0000000-0000-4000-8000-000000000001' },
		insert_edge_id: { edge_id: 'f0000000-0000-4000-8000-000000000001', insert_id: { insert_id: '10000000-0000-4000-8000-000000000001' } },
		material_id: { material_id: '20000000-0000-4000-8000-000000000001' },
	},
	{
		operation_id: O2,
		// the user may not read these relations: Directus gives the bare id, not an object
		sample_id: 'c0000000-0000-4000-8000-000000000009',
		equipment_id: null,
		tool_id: undefined,
		insert_edge_id: 'f0000000-0000-4000-8000-000000000009',
		material_id: null,
	},
];

describe('md5', () => {
	it('matches the reference vectors', () => {
		expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
	});
	it('matches Postgres md5() across the padding boundaries and non-ASCII text', () => {
		expect(md5('x'.repeat(55))).toBe('04364420e25c512fd958a70738aa8f72');
		expect(md5('y'.repeat(56))).toBe('6c830a5d23df58dbe0171eb5639bf3e4');
		expect(md5('z'.repeat(64))).toBe('3ecc49f9d9d6c263b4f0de7fc3f38aed');
		expect(md5('q'.repeat(200))).toBe('df02a36fd4a99febe469328b0fe2037f');
		expect(md5('Ti-6Al-4V é')).toBe('43cef9813e0efd1cb3223e141d0bb3b8');
	});
});

describe('rollupRowId', () => {
	it('is the hash the view computes for each kind', () => {
		expect(rollupRowId('operation', P, O1)).toBe(SQL.op1);
		expect(rollupRowId('sample', P, 'c0000000-0000-4000-8000-000000000001')).toBe(SQL.sample);
		expect(rollupRowId('equipment', P, 'd0000000-0000-4000-8000-000000000001')).toBe(SQL.equipment);
		expect(rollupRowId('tool', P, 'e0000000-0000-4000-8000-000000000001')).toBe(SQL.tool);
		expect(rollupRowId('insert_edge', P, 'f0000000-0000-4000-8000-000000000001')).toBe(SQL.edge);
		expect(rollupRowId('cutting_insert', P, '10000000-0000-4000-8000-000000000001')).toBe(SQL.insert);
		expect(rollupRowId('material', P, '20000000-0000-4000-8000-000000000001')).toBe(SQL.material);
	});
	it('ties everything but operations to the project', () => {
		const other = 'a0000000-0000-4000-8000-000000000002';
		expect(rollupRowId('sample', other, 'c0000000-0000-4000-8000-000000000001')).not.toBe(SQL.sample);
		expect(rollupRowId('operation', other, O1)).toBe(SQL.op1);
	});
});

describe('rollupTargets', () => {
	const map = rollupTargets(ops, P);

	it('resolves each kind of rollup row to its record by row_id', () => {
		expect(map.get(SQL.op1)).toEqual({ collection: 'manufacturing_operations', id: O1 });
		expect(map.get(SQL.sample)).toEqual({ collection: 'physical_samples', id: 'c0000000-0000-4000-8000-000000000001' });
		expect(map.get(SQL.equipment)).toEqual({ collection: 'equipment', id: 'd0000000-0000-4000-8000-000000000001' });
		expect(map.get(SQL.tool)).toEqual({ collection: 'tools', id: 'e0000000-0000-4000-8000-000000000001' });
		expect(map.get(SQL.edge)).toEqual({ collection: 'insert_edges', id: 'f0000000-0000-4000-8000-000000000001' });
		expect(map.get(SQL.insert)).toEqual({ collection: 'cutting_inserts', id: '10000000-0000-4000-8000-000000000001' });
		expect(map.get(SQL.material)).toEqual({ collection: 'materials', id: '20000000-0000-4000-8000-000000000001' });
	});
	it('leaves out records the user cannot read', () => {
		expect(map.get(SQL.op2)).toEqual({ collection: 'manufacturing_operations', id: O2 });
		// the unreadable sample / edge (bare ids) are not linked: 2 operations + 6 related records
		expect(map.size).toBe(8);
	});
	it('cannot mislink operations that share a pass_code (the rows are keyed by id, not code)', () => {
		const dup = rollupTargets([{ operation_id: O1 }, { operation_id: O2 }], P);
		expect(dup.get(SQL.op1)?.id).toBe(O1);
		expect(dup.get(SQL.op2)?.id).toBe(O2);
		expect(dup.size).toBe(2);
	});
	it('copes with nothing', () => {
		expect(rollupTargets(null, P).size).toBe(0);
		expect(rollupTargets([{}], P).size).toBe(0);
	});
	it('feeds recordRoute: Explorer pages where they exist, the Data Studio form otherwise', () => {
		const route = (rowId: string) => {
			const t = map.get(rowId)!;
			return recordRoute(t.collection, t.id);
		};
		expect(route(SQL.op1)).toBe(`/home/operations/${O1}`);
		expect(route(SQL.sample)).toBe('/home/samples/c0000000-0000-4000-8000-000000000001');
		expect(route(SQL.equipment)).toBe('/content/equipment/d0000000-0000-4000-8000-000000000001');
	});
});

describe('rollupOperationsFilter', () => {
	it('takes the project own operations and the campaign-only ones, not another project\'s', () => {
		expect(rollupOperationsFilter(P)).toEqual({
			_or: [
				{ project_id: { _eq: P } },
				{ _and: [{ project_id: { _null: true } }, { campaign_id: { project_id: { _eq: P } } }] },
			],
		});
	});
});
