import { describe, expect, it } from 'vitest';
import { NO_SAMPLE, filterRuns, filterSamples, groupBySample, type RunRow } from './fastSamples';

const run = (id: string, code: string | null, extra: Partial<RunRow> = {}): RunRow => ({
	id, pass_code: `P-${id}`, sample_id: code ? { sample_code: code, nickname: 'WC-10Co' } : null, material_id: { common_name: 'tungsten carbide' }, ...extra,
});
// newest first
const rows = [run('1', 'S-B'), run('2', 'S-A'), run('3', 'S-B'), run('4', null), run('5', 'S-A', { sintering_recipe_number: 'Ti 900/20' })];

describe('groupBySample', () => {
	it('groups the runs by sample, newest sample first, with a run count', () => {
		const g = groupBySample(rows);
		expect(g.map((x) => [x.key, x.runs])).toEqual([['S-B', 2], ['S-A', 2], [NO_SAMPLE, 1]]);
	});
	it('describes a sample by its nickname and material', () => {
		expect(groupBySample(rows)[0].sub).toBe('WC-10Co · tungsten carbide');
	});
	it('names the group of runs that have no sample', () => {
		expect(groupBySample(rows)[2].code).toBe('No sample');
	});
	it('is empty for no runs', () => {
		expect(groupBySample([])).toEqual([]);
	});
});

describe('filterSamples', () => {
	const g = groupBySample(rows);
	it('matches the code, nickname or material', () => {
		expect(filterSamples(g, 's-a').map((x) => x.key)).toEqual(['S-A']);
		expect(filterSamples(g, 'carbide')).toHaveLength(3);
		expect(filterSamples(g, '  ')).toBe(g);
	});
});

describe('filterRuns', () => {
	it('keeps every run without a sample or a query', () => {
		expect(filterRuns(rows, null, '')).toBe(rows);
	});
	it('narrows to one sample, including the runs without one', () => {
		expect(filterRuns(rows, 'S-A', '').map((r) => r.id)).toEqual(['2', '5']);
		expect(filterRuns(rows, NO_SAMPLE, '').map((r) => r.id)).toEqual(['4']);
	});
	it('searches the run code, sample code and recipe, with the sample chip applied too', () => {
		expect(filterRuns(rows, null, 'p-3').map((r) => r.id)).toEqual(['3']);
		expect(filterRuns(rows, null, 's-b').map((r) => r.id)).toEqual(['1', '3']);
		expect(filterRuns(rows, null, 'ti 900').map((r) => r.id)).toEqual(['5']);
		expect(filterRuns(rows, 'S-A', 'ti 900').map((r) => r.id)).toEqual(['5']);
		expect(filterRuns(rows, 'S-B', 'ti 900')).toEqual([]);
	});
});
