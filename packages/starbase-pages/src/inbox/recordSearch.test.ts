import { describe, expect, it } from 'vitest';
import { LINK_TARGETS } from './inboxModel';
import { RESULT_LIMIT, isSearchable, searchParams, toOption } from './recordSearch';

const [sample, operation, test] = LINK_TARGETS;

describe('the record picker search', () => {
	it('is for two characters or more', () => {
		expect([isSearchable(''), isSearchable(' a '), isSearchable('ab')]).toEqual([false, false, true]);
	});
	it('matches a sample by code or nickname, with the finder\'s fields', () => {
		const p = searchParams(sample, ' Ti-01 ');
		expect(p).toEqual({ fields: ['sample_id', 'sample_code', 'nickname', 'short_id'], filter: JSON.stringify({ _or: [{ sample_code: { _icontains: 'Ti-01' } }, { nickname: { _icontains: 'Ti-01' } }] }), limit: RESULT_LIMIT });
	});
	it('also tries an exact short ID when the text is hex of 8 characters or more', () => {
		const f = JSON.parse(searchParams(test, '3FA9C1D2').filter as string);
		expect(f._or).toContainEqual({ short_id: { _eq: '3fa9c1d2' } });
		expect(JSON.parse(searchParams(test, 'T-12').filter as string)._or).toHaveLength(1);
	});
	it('names a row by what the person knows it by', () => {
		expect(toOption(sample, { sample_id: 's1', sample_code: 'S-0042', nickname: 'Bar A' })).toEqual({ collection: 'physical_samples', id: 's1', label: 'S-0042', detail: 'Bar A' });
		expect(toOption(test, { session_id: 't1', test_code: 'T-9', test_type: 'tensile' })).toEqual({ collection: 'test_sessions', id: 't1', label: 'T-9', detail: 'tensile' });
		expect(toOption(operation, { operation_id: 'o1', pass_code: 'OP-3' })?.label).toBe('OP-3');
		expect(toOption(sample, { sample_code: 'no id' })).toBeNull();
	});
});
