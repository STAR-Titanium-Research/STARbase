import { describe, expect, it } from 'vitest';
import { groupChoices, groupKeys, sortWithGroup } from './groupBy';
import { indexDefBySlug } from './indexConfig';

const samples = indexDefBySlug('samples')!;
const tests = indexDefBySlug('tests')!;

describe('groupChoices', () => {
	it('offers the enum and relation filters, not the bool, flag or team ones', () => {
		expect(groupChoices(samples)).toEqual([
			{ value: 'project_id', label: 'Project' },
			{ value: 'current_status', label: 'Status' },
			{ value: 'material_id', label: 'Material' },
		]);
	});
	it('leaves out a relation whose collection the user cannot read', () => {
		expect(groupChoices(samples, new Set(['materials'])).map((c) => c.value)).toEqual(['current_status', 'material_id']);
	});
});

describe('groupKeys', () => {
	it('is an enum by its field and a relation by what it shows', () => {
		expect(groupKeys(samples, 'current_status')).toEqual(['current_status']);
		expect(groupKeys(samples, 'project_id')).toEqual(['project_id.project_code']);
	});
	it('adds the fallback that names a row without a code (a campaign), after the display field', () => {
		expect(groupKeys(tests, 'campaign_id')).toEqual(['campaign_id.campaign_code', 'campaign_id.name']);
	});
	it('is empty for no grouping, a field that cannot group, or an unreadable relation', () => {
		expect(groupKeys(samples, null)).toEqual([]);
		expect(groupKeys(samples, 'nickname')).toEqual([]);
		expect(groupKeys(samples, 'project_id', new Set())).toEqual([]);
	});
});

describe('sortWithGroup', () => {
	it('puts the group first, and lets a sort by the group field itself keep its direction', () => {
		expect(sortWithGroup([], '-created_at')).toEqual(['-created_at']);
		expect(sortWithGroup(['current_status'], '-created_at')).toEqual(['current_status', '-created_at']);
		expect(sortWithGroup(['current_status'], 'current_status')).toEqual(['current_status']);
		expect(sortWithGroup(['current_status'], '-current_status')).toEqual(['-current_status']);
	});
	it('sorts by every key of a group, the fallback too, before the sort', () => {
		const keys = ['campaign_id.campaign_code', 'campaign_id.name'];
		expect(sortWithGroup(keys, '-created_at')).toEqual([...keys, '-created_at']);
		expect(sortWithGroup(keys, '-campaign_id.campaign_code')).toEqual(['-campaign_id.campaign_code', 'campaign_id.name']);
	});
});
