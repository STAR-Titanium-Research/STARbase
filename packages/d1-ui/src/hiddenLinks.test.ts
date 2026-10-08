import { describe, expect, it, vi } from 'vitest';
import { emptyLinks, hiddenFrom, readHiddenLinks } from './hiddenLinks';

describe('emptyLinks', () => {
	it('lists the links that came back empty', () => {
		expect(emptyLinks({ a: { id: 1 }, b: null, c: undefined }, ['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
		expect(emptyLinks(null, ['a'])).toEqual(['a']);
	});
});

describe('hiddenFrom', () => {
	it('flags the fields whose raw key is set', () => {
		expect(hiddenFrom({ a: 'x', b: null, c: '' }, ['a', 'b', 'c'])).toEqual({ a: true });
		expect(hiddenFrom(undefined, ['a'])).toEqual({});
	});
});

describe('readHiddenLinks', () => {
	it('reads nothing when every link is a record', async () => {
		const getItem = vi.fn();
		expect(await readHiddenLinks(getItem, 'manufacturing_operations', 'o1', { sample_id: { sample_id: 's' } }, ['sample_id'])).toEqual({});
		expect(getItem).not.toHaveBeenCalled();
	});
	it('reads the raw keys of the empty links only and reports the set ones as hidden', async () => {
		const getItem = vi.fn().mockResolvedValue({ output_sample_id: 'abc', project_id: null });
		const row = { sample_id: { sample_id: 's' }, output_sample_id: null, project_id: null };
		const out = await readHiddenLinks(getItem, 'manufacturing_operations', 'o1', row, ['sample_id', 'output_sample_id', 'project_id']);
		expect(getItem).toHaveBeenCalledWith('manufacturing_operations', 'o1', { fields: ['output_sample_id', 'project_id'] });
		expect(out).toEqual({ output_sample_id: true });
	});
	it('says none hidden when the read fails', async () => {
		const getItem = vi.fn().mockRejectedValue(new Error('x'));
		expect(await readHiddenLinks(getItem, 'c', 'i', {}, ['a'])).toEqual({});
	});
});
