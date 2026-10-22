import type { AxiosInstance } from 'axios';

/**
 * Everything the shared FAST-analysis dashboard needs from its embedding environment.
 *
 * Much smaller than ForceHost (see packages/force-plotting/src/host.ts): every FAST network
 * call is a plain axios request through `api`, and both environments' `api` instance already
 * handles its own auth transparently -- Directus's own client and STARbase (spec section 9) both
 * ride the shared Directus session cookie, so no Bearer interceptor or refresh retry is involved.
 * There is no raw-`fetch` sidecar seam to bridge here, so no authHeaders/refreshAuth/fetchCredentials.
 */
export interface FastHost {
	/** Authenticated axios instance (session cookie in both hosts). */
	api: AxiosInstance;
	/** Open a Directus record editor for the given collection and primary key. */
	openRecord(collection: string, id: string): void;
	/**
	 * May the signed-in user change this record? `true` / `false` as Directus answers (false for a Lab Viewer without asking),
	 * `null` when that is not known. The Conform plotter offers upload, link, window and unlink only unless this is `false`:
	 * the same rule the Operation page uses for its own edit controls. A host without it offers them, and the server decides.
	 */
	canUpdate?(collection: string, id: string): Promise<boolean | null>;
}

// A module-level singleton rather than Vue provide/inject, matching ForceHost's reasoning --
// keeps the two seams consistent even though nothing here is a plain module (yet).
let current: FastHost | null = null;

export function setFastHost(host: FastHost): void {
	current = host;
}

export function useFastHost(): FastHost {
	if (!current) {
		throw new Error(
			'@d1/fast-plotting: no host installed. Call setFastHost() in the consuming ' +
			'component before rendering FastDashboard.',
		);
	}
	return current;
}

/** Test-only: clear the installed host so cases start from a known state. */
export function resetFastHost(): void {
	current = null;
}
