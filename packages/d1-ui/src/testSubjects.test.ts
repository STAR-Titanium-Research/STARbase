import { describe, expect, it } from 'vitest';
import { splitSubjects, TEST_SUBJECT_FIELDS } from './testSubjects';

describe('splitSubjects', () => {
	it('splits samples from other subjects and keeps the sample fields', () => {
		const out = splitSubjects([
			{ collection: 'physical_samples', item: { sample_id: 's1', sample_code: '12-AB-7', current_status: 'in_stock' } },
			{ collection: 'insert_edges', item: { edge_id: 'g1', edge_code: 'CNMG-1-A' } },
		]);
		expect(out.samples).toEqual([{ sample_id: 's1', sample_code: '12-AB-7', current_status: 'in_stock' }]);
		expect(out.others).toEqual([{ collection: 'insert_edges', item: 'g1', label: 'CNMG-1-A' }]);
	});
	it('keeps a subject the user may not read, as a bare id', () => {
		const out = splitSubjects([
			{ collection: 'physical_samples', item: 's2' },
			{ collection: 'insert_edges', item: 'g2' },
			{ collection: 'tools', item: 't1' },
		]);
		expect(out.samples).toEqual([{ sample_id: 's2' }]);
		expect(out.others).toEqual([
			{ collection: 'insert_edges', item: 'g2' },
			{ collection: 'tools', item: 't1' },
		]);
	});
	it('skips junk rows and copes with nothing', () => {
		expect(splitSubjects(null)).toEqual({ samples: [], others: [] });
		expect(splitSubjects([null, {}, { collection: 'physical_samples', item: null }, { collection: 'tools', item: '' }])).toEqual({
			samples: [],
			others: [],
		});
	});
	it('asks for each target through the M2A syntax', () => {
		expect(TEST_SUBJECT_FIELDS).toContain('item:physical_samples.sample_code');
		expect(TEST_SUBJECT_FIELDS).toContain('item:insert_edges.edge_code');
	});
});
