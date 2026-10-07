// "The server could not be reached", as opposed to "the server said no". One definition, shared by
// sign-in (fall back to the offline verifier), the session refresh (keep the session) and the
// pickers (fall back to the offline snapshot), so they can never disagree about being offline.
export function isUnreachable(e: any): boolean {
	const status = e?.response?.status;
	return !e?.response || status === 502 || status === 503 || status === 504;
}

/** A bare "Failed to fetch" / "Load failed" / NetworkError message: the browser's wording for a
 *  transport failure (backend down, or blocked by CORS / HTTPS mixed-content), as opposed to an
 *  error the server answered with. */
export function isFetchFailure(message: string): boolean {
	return /failed to fetch|load failed|networkerror/i.test(message);
}

/** Display text for an error thrown by a fetch to the recorder backend: spells out a transport
 *  failure, otherwise the error's own message, otherwise `fallback`. */
export function describeFetchError(e: any, fallback: string): string {
	return isFetchFailure(e?.message || '')
		? "can't reach the recording backend — is it running?"
		: e?.message || fallback;
}
