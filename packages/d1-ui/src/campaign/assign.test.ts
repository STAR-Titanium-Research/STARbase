import { describe, expect, it, vi } from 'vitest';
import { campaignAssignPatch, inheritCampaignProject, lostRaceMessage, projectInheritPatch, readCampaignProject } from './assign';

describe('campaignAssignPatch', () => {
	it('adds only where the record is in no campaign', () => {
		expect(campaignAssignPatch('operation_id', 'o1', 'c1', 'c1')).toEqual({
			query: { filter: { operation_id: { _eq: 'o1' }, campaign_id: { _null: true } } },
			data: { campaign_id: 'c1' },
		});
	});
	it('removes only where the record is in this campaign', () => {
		expect(campaignAssignPatch('operation_id', 'o1', 'c1', null)).toEqual({
			query: { filter: { operation_id: { _eq: 'o1' }, campaign_id: { _eq: 'c1' } } },
			data: { campaign_id: null },
		});
	});
});

describe('projectInheritPatch', () => {
	it('only touches a record whose project is still null', () => {
		expect(projectInheritPatch('session_id', 't1', 'p1')).toEqual({
			query: { filter: { session_id: { _eq: 't1' }, project_id: { _null: true } } },
			data: { project_id: 'p1' },
		});
	});
});

describe('lostRaceMessage', () => {
	it('is null when a row changed or the answer is not a list', () => {
		expect(lostRaceMessage([{ id: 1 }], true, 'X')).toBeNull();
		expect(lostRaceMessage(undefined, true, 'X')).toBeNull();
	});
	it('says who got there first', () => {
		expect(lostRaceMessage([], true, 'OP-1')).toBe('OP-1 is already in another campaign.');
		expect(lostRaceMessage([], false, 'OP-1')).toBe('OP-1 is no longer in this campaign.');
	});
});

const apiWith = (project: unknown, patch = vi.fn().mockResolvedValue({})) => ({
	get: vi.fn().mockResolvedValue({ data: { data: { project_id: project } } }),
	patch,
});

describe('readCampaignProject', () => {
	it('reads a bare or expanded project id, null when none or unreadable', async () => {
		expect(await readCampaignProject(apiWith('p1'), 'c1')).toBe('p1');
		expect(await readCampaignProject(apiWith({ project_id: 'p2' }), 'c1')).toBe('p2');
		expect(await readCampaignProject(apiWith(null), 'c1')).toBeNull();
		expect(await readCampaignProject({ get: vi.fn().mockRejectedValue(new Error('x')), patch: vi.fn() }, 'c1')).toBeNull();
	});
});

describe('inheritCampaignProject', () => {
	it('patches conditionally with the campaign project', async () => {
		const api = apiWith('p1');
		expect(await inheritCampaignProject(api, 'test_sessions', 'session_id', 't1', 'c1', 'The test')).toBe('');
		expect(api.patch).toHaveBeenCalledWith('/items/test_sessions', projectInheritPatch('session_id', 't1', 'p1'));
	});
	it('sends nothing when the campaign has no project', async () => {
		const api = apiWith(null);
		expect(await inheritCampaignProject(api, 'test_sessions', 'session_id', 't1', 'c1', 'The test')).toBe('');
		expect(api.patch).not.toHaveBeenCalled();
	});
	it('stays quiet when the role may not edit the record, reports other failures', async () => {
		const forbidden = { response: { status: 403 } };
		expect(await inheritCampaignProject(apiWith('p1', vi.fn().mockRejectedValue(forbidden)), 'test_sessions', 'session_id', 't1', 'c1', 'T')).toBe('');
		const msg = await inheritCampaignProject(apiWith('p1', vi.fn().mockRejectedValue(new Error('boom'))), 'test_sessions', 'session_id', 't1', 'c1', 'T');
		expect(msg).toContain('T was added, but its project could not be set');
	});
});
