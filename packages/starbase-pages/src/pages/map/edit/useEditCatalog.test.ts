import { describe, expect, it } from 'vitest';
import { fakeServer } from './fakeBuildServer';
import { useEditCatalog } from './useEditCatalog';

const make = () => {
	const server = fakeServer();
	return { ...server, catalog: useEditCatalog(server.api, async () => []) };
};

describe('useEditCatalog', () => {
	it('reads picked samples whole: the card, the version, and the record with its relations as ids', async () => {
		const { catalog, s } = make();
		const read = await catalog.loadSamples(['s1', 'nope']);
		expect([...read.keys()]).toEqual(['s1']);
		const one = read.get('s1')!;
		expect(one.version).toBe(4);
		expect(one.sample).toMatchObject({ id: 's1', code: 'PS-001' });
		expect(one.values.material_id).toBe('mat1');
		expect(one.values.project_id).toBe('proj1');
		expect(catalog.samples.get('s1')?.code).toBe('PS-001');
		expect(catalog.records.get('physical_samples:s1')?.values.material_id).toBe('mat1');
		expect(s.calls.filter((c) => c === 'GET /items/physical_samples')).toHaveLength(1);
	});

	it('reads nothing for nothing', async () => {
		const { catalog, s } = make();
		expect((await catalog.loadSamples([])).size).toBe(0);
		expect(s.calls).toEqual([]);
	});

	it('searches the samples by code, two letters at least', async () => {
		const { catalog } = make();
		expect(await catalog.searchSamples('p')).toEqual([]);
		expect((await catalog.searchSamples('PS-002')).map((r) => r.code)).toEqual(['PS-002']);
	});

	it('reads the methods and the field definitions once', async () => {
		const { catalog, s } = make();
		await Promise.all([catalog.ensure(), catalog.ensure()]);
		expect(catalog.methods.value.map((m) => m.code)).toEqual(['MF', 'HT', 'MC']);
		expect(s.calls.filter((c) => c === 'GET /items/manufacturing_methods')).toHaveLength(1);
	});

	it('marks a record asked for and not answered as gone', async () => {
		const { catalog } = make();
		await catalog.loadRecords({ physical_samples: ['s9'], manufacturing_operations: [], test_sessions: [] });
		expect(catalog.records.get('physical_samples:s9')).toBeNull();
	});
});
