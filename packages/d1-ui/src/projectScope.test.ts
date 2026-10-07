import { describe, expect, it } from 'vitest';
import {
	anyProjectFilter, effectiveProjectId, effectiveProjectIdFields, projectScopeFilter,
	sampleProjectScopeFilter,
} from './projectScope';
import { rollupOperationsFilter } from './rollupLinks';

const P = 'p-1';

describe('projectScopeFilter', () => {
	it('is the COALESCE rule: own project, or no own project and the campaign project', () => {
		expect(projectScopeFilter(P)).toEqual({
			_or: [
				{ project_id: { _eq: P } },
				{ _and: [{ project_id: { _null: true } }, { campaign_id: { project_id: { _eq: P } } }] },
			],
		});
	});
	it('is the same filter the project items view uses', () => {
		expect(rollupOperationsFilter(P)).toEqual(projectScopeFilter(P));
	});
});

describe('anyProjectFilter', () => {
	it('matches rows with a project of their own or through their campaign', () => {
		expect(anyProjectFilter()).toEqual({
			_or: [{ project_id: { _nnull: true } }, { campaign_id: { project_id: { _nnull: true } } }],
		});
	});
});

describe('sampleProjectScopeFilter', () => {
	it('adds membership of one of the project campaigns through the junction', () => {
		expect(sampleProjectScopeFilter(P)).toEqual({
			_or: [
				{ project_id: { _eq: P } },
				{ campaigns: { _some: { campaign_id: { project_id: { _eq: P } } } } },
			],
		});
	});
});

describe('effectiveProjectId', () => {
	it('prefers the record own project', () => {
		expect(effectiveProjectId({ project_id: 'a', campaign_id: { project_id: 'b' } })).toBe('a');
	});
	it('falls back to the project of the campaign', () => {
		expect(effectiveProjectId({ project_id: null, campaign_id: { project_id: 'b' } })).toBe('b');
	});
	it('accepts expanded projects', () => {
		expect(effectiveProjectId({ project_id: { project_id: 'a' } })).toBe('a');
	});
	it('is null with neither, or when the campaign is a bare id', () => {
		expect(effectiveProjectId({ project_id: null, campaign_id: null })).toBeNull();
		expect(effectiveProjectId({ campaign_id: 'c-1' })).toBeNull();
	});
	it('names the fields to read', () => {
		expect(effectiveProjectIdFields).toEqual(['project_id', 'campaign_id.project_id']);
	});
});
