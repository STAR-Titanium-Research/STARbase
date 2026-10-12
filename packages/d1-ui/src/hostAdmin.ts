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
