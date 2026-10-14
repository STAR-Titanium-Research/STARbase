import { CURRENT_USER } from '@d1/ui';

// The teams the signed-in user belongs to, for "Your work": a record a team owns (owner_team_id) is the work of every member of that team.
// The ids come from /items/team_members (a Lab Member may read that table; the person is found through people.user_id, so the caller's own
// person id is not needed), and Home then widens its "mine" filters with `owner_team_id _in <ids>` (withMyTeams in @d1/ui). A person
// with no teams, or whose memberships cannot be read, gets the filters they had before.

export const MY_TEAMS_QUERY = {
	filter: { person_id: { user_id: { _eq: CURRENT_USER } } },
	fields: ['team_id'],
	limit: -1,
} as const;

export const MY_TEAMS_UNREAD = 'Records owned by your teams may be missing: your team memberships could not be read.';

/** The distinct team ids of the rows /items/team_members answered with. */
export function teamIdsOf(rows: unknown): string[] {
	if (!Array.isArray(rows)) return [];
	const ids = rows.map((r) => (typeof r?.team_id === 'string' ? r.team_id : r?.team_id?.team_id)).filter((id): id is string => typeof id === 'string' && !!id);
	return [...new Set(ids)];
}

type GetItems = (collection: string, params?: Record<string, unknown>) => Promise<any[]>;

/** `ids`: my teams ([] when there are none or they could not be read); `unread`: the read failed, so Home says its team lists may be short. */
export async function loadMyTeamIds(getItems: GetItems): Promise<{ ids: string[]; unread: boolean }> {
	try {
		return { ids: teamIdsOf(await getItems('team_members', { ...MY_TEAMS_QUERY, fields: [...MY_TEAMS_QUERY.fields] })), unread: false };
	} catch {
		return { ids: [], unread: true };
	}
}
