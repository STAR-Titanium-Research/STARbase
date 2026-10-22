import { describe, expect, it } from 'vitest';
import { filterRuns, type RunRow } from './fastSamples';

const run = (id: string, feedstock: string | null): RunRow => ({ id, pass_code: `CF-${id}`, sample_id: { sample_code: `S-${id}` }, conform_feedstock: feedstock });
const rows = [run('1', 'AA6082 swarf'), run('2', 'Ti swarf'), run('3', null)];

describe('filterRuns on a Conform list', () => {
	it('also searches the feedstock, as the placeholder says', () => {
		expect(filterRuns(rows, null, 'swarf').map((r) => r.id)).toEqual(['1', '2']);
		expect(filterRuns(rows, null, 'aa6082').map((r) => r.id)).toEqual(['1']);
		expect(filterRuns(rows, 'S-2', 'swarf').map((r) => r.id)).toEqual(['2']);
	});
	it('still finds a run by its code or sample code', () => {
		expect(filterRuns(rows, null, 'cf-3').map((r) => r.id)).toEqual(['3']);
		expect(filterRuns(rows, null, 's-1').map((r) => r.id)).toEqual(['1']);
	});
});
