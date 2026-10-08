import { describe, expect, it } from 'vitest';
import { createdRecord } from './createResult';

describe('createdRecord', () => {
	it('reads the id and code of the created row', () => {
		expect(createdRecord({ data: { sample_id: 's1', sample_code: '12-AB' } }, 'sample_id', 'sample_code')).toEqual({ id: 's1', code: '12-AB' });
		expect(createdRecord({ data: { sample_id: 's1' } }, 'sample_id', 'sample_code')).toEqual({ id: 's1', code: '' });
	});
	it('is null for an empty (204) answer, which means created but not readable', () => {
		expect(createdRecord('', 'sample_id', 'sample_code')).toBeNull();
		expect(createdRecord(undefined, 'sample_id', 'sample_code')).toBeNull();
		expect(createdRecord({ data: null }, 'sample_id', 'sample_code')).toBeNull();
		expect(createdRecord({ data: {} }, 'sample_id', 'sample_code')).toBeNull();
	});
});
