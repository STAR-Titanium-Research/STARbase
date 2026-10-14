import { describe, expect, it, vi } from 'vitest';
import { MY_TEAMS_QUERY, loadMyTeamIds, teamIdsOf } from './myTeams';

describe('teamIdsOf', () => {
	it('lists each team once, from a bare id or an expanded team', () => {
		expect(teamIdsOf([{ team_id: 't1' }, { team_id: 't2' }, { team_id: 't1' }, { team_id: { team_id: 't3' } }])).toEqual(['t1', 't2', 't3']);
	});
	it('is empty for anything that is not a list of rows with a team', () => {
		expect(teamIdsOf(null)).toEqual([]);
		expect(teamIdsOf({})).toEqual([]);
		expect(teamIdsOf([{}, { team_id: null }, null])).toEqual([]);
	});
});

describe('loadMyTeamIds', () => {
	it('reads the caller\'s own memberships through people.user_id', async () => {
		const getItems = vi.fn(async () => [{ team_id: 't1' }]);
		expect(await loadMyTeamIds(getItems)).toEqual({ ids: ['t1'], unread: false });
		expect(getItems).toHaveBeenCalledWith('team_members', { filter: MY_TEAMS_QUERY.filter, fields: ['team_id'], limit: -1 });
		expect(JSON.stringify(MY_TEAMS_QUERY.filter)).toContain('$CURRENT_USER');
	});
	it('falls back to no teams, and says so, when the memberships cannot be read', async () => {
		expect(await loadMyTeamIds(vi.fn(async () => { throw new Error('403'); }))).toEqual({ ids: [], unread: true });
	});
});
