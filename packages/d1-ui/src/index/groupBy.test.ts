import { describe, expect, it } from 'vitest';
import { groupChoices, groupColumn, groupFetchField, groupSortKey, sortWithGroup } from './groupBy';
import { indexDefBySlug } from './indexConfig';

const samples = indexDefBySlug('samples')!;
const operations = indexDefBySlug('operations')!;

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

describe('groupSortKey / groupFetchField', () => {
	it('sorts an enum by its field and a relation by what it shows', () => {
		expect(groupSortKey(samples, 'current_status')).toBe('current_status');
		expect(groupSortKey(samples, 'project_id')).toBe('project_id.project_code');
	});
	it('is null for no grouping, a field that cannot group, or an unreadable relation', () => {
		expect(groupSortKey(samples, null)).toBeNull();
		expect(groupSortKey(samples, 'nickname')).toBeNull();
		expect(groupSortKey(samples, 'project_id', new Set())).toBeNull();
	});
	it('asks for a field only when no column already does', () => {
		expect(groupFetchField(samples, 'current_status')).toBeNull();
		expect(groupFetchField(samples, 'project_id')).toBeNull();
		const extra = operations.filters.find((f) => (f.options.kind === 'enum' || f.options.kind === 'relation') && !operations.columns.some((c) => c.field === f.field))!;
		expect(groupFetchField(operations, extra.field)).toBe(extra.options.kind === 'relation' ? `${extra.field}.${extra.options.display}` : extra.field);
	});
});

describe('groupColumn', () => {
	it("is the list's own column for the field, else one made from the filter", () => {
		expect(groupColumn(samples, 'current_status')).toBe(samples.columns.find((c) => c.field === 'current_status'));
		const extra = operations.filters.find((f) => f.options.kind === 'relation' && !operations.columns.some((c) => c.field === f.field))!;
		expect(groupColumn(operations, extra.field)).toMatchObject({ field: extra.field, label: extra.label, relation: { collection: (extra.options as { collection: string }).collection } });
		expect(groupColumn(samples, 'nope')).toBeNull();
	});
});

describe('sortWithGroup', () => {
	it('puts the group first, and lets a sort by the group field itself stand alone', () => {
		expect(sortWithGroup(null, '-created_at')).toEqual(['-created_at']);
		expect(sortWithGroup('current_status', '-created_at')).toEqual(['current_status', '-created_at']);
		expect(sortWithGroup('current_status', 'current_status')).toEqual(['current_status']);
		expect(sortWithGroup('current_status', '-current_status')).toEqual(['-current_status']);
	});
});
