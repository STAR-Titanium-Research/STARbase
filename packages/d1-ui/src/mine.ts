// Directus filters for "mine", as sent to /items (so Directus resolves $CURRENT_USER server-side).
//
// "Mine" is an explicit filter on top of what ADR-0011 lets the user read (a PI can read far more
// than they own, and "my work" is the narrower list), using the involvement columns of that ADR:
// ownership is `owner_person_id` -> people.user_id, co-ownership
// is the M2M alias `co_owners` (sample_co_owners.user_id), a project's PI is
// `principal_investigator_person` -> people.user_id and its investigators are the M2M alias
// `secondary_investigators` (project_investigators.user_id). The older `owner` and
// `principal_investigator` UUID columns are hidden backups and are not used.
//
// A1a adds the hidden O2M alias `access` (sample_access, project_access: person_id, role) beside the old M2M aliases. A person
// listed with role edit on a sample is a co-owner; a project_access row with role investigator is a secondary investigator.
// DIRECTUS CONSTRAINTS (spec section 3): a relation key is read by its FIRST key only, so `access: {person_id: ..., role: ...}`
// would silently drop the role (every viewer would count as a co-owner), and a `_some` body must be one plain chain. Two
// conditions on one row of a to-many relation are an `_and` of two BARE paths through the same alias (Directus joins an alias
// once per query path, so both hold on the same row). mine.test.ts walks every filter here and refuses the other forms.
//
// The Data Studio bookmarks "My operations" and "My samples" (migration 135) use the same
// owner path, so the counts agree with them for owner-only filters.

export const CURRENT_USER = '$CURRENT_USER';

type Filter = Record<string, unknown>;

export const ownedByMe: Filter = { owner_person_id: { user_id: { _eq: CURRENT_USER } } };

// The same row of an alias: this person, with this role (bare paths, never a sibling key or a _some with two conditions).
const accessRoleMine = (role: string): Filter => ({
	_and: [{ access: { person_id: { user_id: { _eq: CURRENT_USER } } } }, { access: { role: { _eq: role } } }],
});

export const coOwnedByMe: Filter = {
	_or: [{ co_owners: { _some: { user_id: { _eq: CURRENT_USER } } } }, accessRoleMine('edit')],
};

export const samplesMine: Filter = { _or: [ownedByMe, coOwnedByMe] };

// A record a team owns (owner_team_id on the four ownable types) is the work of every member of that team. The team ids are the caller's
// own memberships, read from /items/team_members (a Lab Member may read that table), so no relation hop through the team is needed: a plain
// `_in` on the record's own column. They are not part of the constants above: samplesMine and projectsMine are carried verbatim by the
// smoke test (scripts/dev/directus_smoke.mjs), and a person with no team gets the unchanged filter.
export const ownedByTeams = (teamIds: string[]): Filter | null => (teamIds.length ? { owner_team_id: { _in: [...teamIds] } } : null);

/** A "mine" filter widened with the records of the teams I belong to. An `_or` of its own is extended, not nested. */
export function withMyTeams(base: Filter, teamIds: string[]): Filter {
	const teams = ownedByTeams(teamIds);
	if (!teams) return base;
	const keys = Object.keys(base);
	if (keys.length === 1 && keys[0] === '_or' && Array.isArray(base._or)) return { _or: [...(base._or as Filter[]), teams] };
	return { _or: [base, teams] };
}

export const projectsMine: Filter = {
	_or: [
		{ principal_investigator_person: { user_id: { _eq: CURRENT_USER } } },
		{ secondary_investigators: { _some: { user_id: { _eq: CURRENT_USER } } } },
		accessRoleMine('investigator'),
	],
};

// "The signed-in user is this project's PI or one of its investigators": one row (or none) from
// /items/projects. project_rollup is readable only by them (ADR-0011), so an empty roll-up is
// either an empty project or this check failing.
export const projectInvestigatorFilter = (projectId: string | number): Filter => ({
	_and: [{ project_id: { _eq: projectId } }, projectsMine],
});

export const campaignsMine: Filter = ownedByMe;

// Force analysis: operations with at least one force file in the given state, via the O2M alias
// `force_analyses` on manufacturing_operations.
export const withForceFile = (status: 'error' | 'pending'): Filter => ({
	force_analyses: { _some: { status: { _eq: status } } },
});

export const forceErrorOnMyOperations: Filter = { _and: [ownedByMe, withForceFile('error')] };
export const forcePendingOperations: Filter = withForceFile('pending');

export const failedTests: Filter = { status: { _eq: 'failed' } };

// A sample with no owner (neither a person nor a team). Offered to admins only: members would see their own rows or nothing.
export const ownerlessSamples: Filter = { _and: [{ owner_person_id: { _null: true } }, { owner_team_id: { _null: true } }] };
