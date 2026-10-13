// Defence in depth for a shared browser: the plotters keep module-level caches, an admin read may still be
// in flight, and the Explorer host is per user. When a sign-in yields a different user than the last one
// seen in this page load, the page reloads once (a clean document, nothing of the previous user left).
export function needsReload(lastUserId: string | null | undefined, newUserId: string | null | undefined): boolean {
	return !!lastUserId && !!newUserId && lastUserId !== newUserId;
}
