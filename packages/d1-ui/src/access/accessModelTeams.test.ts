import { describe, expect, it } from 'vitest';
import {
	isTeamHit, sortTeams, teamBacklogText, teamHitOf, teamMembersLabel, teamRoleLabel, teamsMatching, waitingMembers, type TeamAccess, type TeamHit,
} from './accessModel';

const team = (over: Partial<TeamAccess> = {}): TeamAccess => ({
	team_access_id: 'a1', team_id: 't1', name: 'Sintering', color: 'teal', logo: null, member_count: 3, role: 'view', trust_new_members: false, waiting: 0, declined: 0, ...over,
});
const hit = (over: Partial<TeamHit> = {}): TeamHit => ({ kind: 'team', team_id: 't1', name: 'Sintering', color: 'teal', logo: null, member_count: 3, ...over });

describe('teams on the list', () => {
	it('sorts the strongest level first, then by name', () => {
		const sorted = sortTeams([team({ team_id: 'a', name: 'Zeta', role: 'view' }), team({ team_id: 'b', name: 'Beta', role: 'view' }), team({ team_id: 'c', name: 'Omega', role: 'edit' })]);
		expect(sorted.map((t) => t.team_id)).toEqual(['c', 'b', 'a']);
	});
	it('sorts a copy and ranks a Secondary investigator with an editor', () => {
		const input = [team({ team_id: 'a', name: 'B', role: 'view' }), team({ team_id: 'b', name: 'A', role: 'investigator' })];
		expect(sortTeams(input).map((t) => t.team_id)).toEqual(['b', 'a']);
		expect(input[0].team_id).toBe('a');
	});
	it('words the level of a team (never "Co-owner": a team does not own a sample)', () => {
		expect(teamRoleLabel('view')).toBe('Can view');
		expect(teamRoleLabel('edit')).toBe('Can edit');
		expect(teamRoleLabel('investigator')).toBe('Secondary investigator');
		expect(teamRoleLabel('odd')).toBe('odd');
	});
	it('counts the members in the row subtitle', () => {
		expect(teamMembersLabel(3)).toBe('Team · 3 members');
		expect(teamMembersLabel(1)).toBe('Team · 1 member');
		expect(teamMembersLabel(0)).toBe('Team · 0 members');
	});
	it('says how many joiners wait and how many were declined, and nothing when none', () => {
		expect(teamBacklogText(team({ waiting: 2, declined: 1 }))).toBe('2 waiting · 1 declined');
		expect(teamBacklogText(team({ waiting: 2 }))).toBe('2 waiting · 0 declined');
		expect(teamBacklogText(team({ declined: 1 }))).toBe('0 waiting · 1 declined');
		expect(teamBacklogText(team())).toBeNull();
	});
	it('offers a decision for those who are waiting, but not for people the owner need not be asked about', () => {
		const rows = [
			{ person_id: 'a', name: 'A', can_sign_in: true, actionable: true },
			{ person_id: 'b', name: 'B', can_sign_in: true, actionable: false },
			{ person_id: 'c', name: 'C', can_sign_in: false },
		];
		expect(waitingMembers(rows).map((r) => r.person_id)).toEqual(['a', 'c']);
	});
});

describe('teams in the add box', () => {
	const teams = [hit({ team_id: 'a', name: 'Sintering' }), hit({ team_id: 'b', name: 'Machining' }), hit({ team_id: 'c', name: 'Sinter Lab' })];
	it('tells a team hit from a person hit', () => {
		expect(isTeamHit(hit())).toBe(true);
		expect(isTeamHit({ person_id: 'p', full_name: 'E' })).toBe(false);
	});
	it('builds a hit from a listed team', () => {
		expect(teamHitOf({ team_id: 't', name: 'N', description: null, color: 'blue', logo: 'f', member_count: 2, managers: [], is_member: false, is_manager: false })).toEqual({
			kind: 'team', team_id: 't', name: 'N', color: 'blue', logo: 'f', member_count: 2,
		});
	});
	it('filters by name, ignoring case and spaces around, and sorts by name', () => {
		expect(teamsMatching(teams, '  SINTER ', { teams: [] }).map((t) => t.team_id)).toEqual(['c', 'a']);
		expect(teamsMatching(teams, 'nothing', { teams: [] })).toEqual([]);
		expect(teamsMatching(teams, '   ', { teams: [] })).toEqual([]);
	});
	it('leaves out the teams that already have access, and caps the list', () => {
		expect(teamsMatching(teams, 'sinter', { teams: [team({ team_id: 'a' })] }).map((t) => t.team_id)).toEqual(['c']);
		expect(teamsMatching(teams, 'i', { teams: [] }, 2)).toHaveLength(2);
		expect(teamsMatching(teams, 'sinter', { teams: undefined })).toHaveLength(2);
	});
});
