// "The server could not be reached", as opposed to "the server said no". One definition, shared by
// sign-in (fall back to the offline verifier), the session refresh (keep the session) and the
// pickers (fall back to the offline snapshot), so they can never disagree about being offline.
export function isUnreachable(e: any): boolean {
	const status = e?.response?.status;
	return !e?.response || status === 502 || status === 503 || status === 504;
}
