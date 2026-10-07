// Directus filters for "mine", as sent to /items (so Directus resolves $CURRENT_USER server-side).
//
// "Mine" is explicit rather than a permission rule (ADR-0011 is not live yet), using the
// involvement columns of that ADR: ownership is `owner_person_id` -> people.user_id, co-ownership
// is the M2M alias `co_owners` (sample_co_owners.user_id), a project's PI is
// `principal_investigator_person` -> people.user_id and its investigators are the M2M alias
// `secondary_investigators` (project_investigators.user_id). The older `owner` and
// `principal_investigator` UUID columns are hidden backups and are not used.
//
// The Data Studio bookmarks "My operations" and "My samples" (migration 135) use the same
// owner path, so the counts agree with them for owner-only filters.

export const CURRENT_USER = '$CURRENT_USER';

type Filter = Record<string, unknown>;

export const ownedByMe: Filter = { owner_person_id: { user_id: { _eq: CURRENT_USER } } };

export const coOwnedByMe: Filter = { co_owners: { _some: { user_id: { _eq: CURRENT_USER } } } };

export const samplesMine: Filter = { _or: [ownedByMe, coOwnedByMe] };

export const projectsMine: Filter = {
	_or: [
		{ principal_investigator_person: { user_id: { _eq: CURRENT_USER } } },
		{ secondary_investigators: { _some: { user_id: { _eq: CURRENT_USER } } } },
	],
};

export const campaignsMine: Filter = ownedByMe;

// Force analysis: operations with at least one force file in the given state, via the O2M alias
// `force_analyses` on manufacturing_operations.
export const withForceFile = (status: 'error' | 'pending'): Filter => ({
	force_analyses: { _some: { status: { _eq: status } } },
});

export const forceErrorOnMyOperations: Filter = { _and: [ownedByMe, withForceFile('error')] };
export const forcePendingOperations: Filter = withForceFile('pending');

export const failedTests: Filter = { status: { _eq: 'failed' } };

// A sample with no owner. Offered to admins only: members would see their own rows or nothing.
export const ownerlessSamples: Filter = { owner_person_id: { _null: true } };
