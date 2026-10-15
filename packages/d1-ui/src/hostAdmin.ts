// The synchronous guess at "is this user an admin", read off the Directus user store. Directus
// keeps the flag in different places across versions; any of them being true is enough. It is only
// the starting value of ExplorerHost.isAdmin, so pages render right on the first frame; the host
// then corrects it from the server's own answer (GET /policies/me/globals). A non-admin wrongly
// guessed to be one only briefly sees an admin-only entry, and the server still refuses the actions.

interface StoreLike {
	isAdmin?: boolean | null;
	currentUser?: { admin_access?: boolean | null; role?: { admin_access?: boolean | null } | string | null } | null;
}

export function guessAdmin(store: StoreLike | null | undefined): boolean {
	if (!store) return false;
	const u = store.currentUser;
	// `??` takes the first value that is not null/undefined, so an explicit false from the store wins
	// over a later true: the order is the one the pages used before the host existed.
	const roleFlag = u && typeof u.role === 'object' && u.role ? u.role.admin_access : undefined;
	return Boolean(store.isAdmin ?? u?.admin_access ?? roleFlag);
}

// The account role Lab Viewer (migration 185, ADR-0014 amendment): a login that reads every record and changes nothing. Its id is the one the
// endpoints compare (d1-record-access labViewerRoleId, scripts/access_rules.json "viewer.role"). The endpoints can move it with the environment
// variable D1_LAB_VIEWER_ROLE_ID; a front end has no such variable, so an app that moves it also changes it here.
export const LAB_VIEWER_ROLE_ID = '10000001-0000-0000-0000-000000000003';

// Is this the Lab Viewer role? `role` is a role id as the hosts keep it (user.role), or a role object from the Directus store. No role (null,
// undefined, a role of no id) is not a viewer; ids compare without case, as the endpoints do.
export function isLabViewerRole(role: unknown, viewerRoleId: string = LAB_VIEWER_ROLE_ID): boolean {
	const id = role && typeof role === 'object' ? (role as { id?: unknown }).id : role;
	return typeof id === 'string' && id !== '' && id.toLowerCase() === viewerRoleId.toLowerCase();
}
