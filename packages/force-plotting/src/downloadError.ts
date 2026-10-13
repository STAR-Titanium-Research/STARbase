// What the analyst sees when a host's downloadAsset() rejects (an expired session, a file that is gone).
// One plain sentence per case; the raw axios text ("Request failed with status code 403") never reaches the UI.
export function downloadFailureMessage(err: unknown): string {
	const status = (err as { response?: { status?: number } } | null | undefined)?.response?.status;
	if (status === 401 || status === 403) return 'Your session expired. Reload the page to sign in again.';
	if (status === 404) return 'That file is no longer available.';
	return 'The download failed. Try again in a moment.';
}
