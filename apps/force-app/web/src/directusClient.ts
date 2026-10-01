// The Directus REST client used by the app, including the shared plotting package via the
// standalone ForceHost (see force/StandaloneForceDashboard.vue). It is a plain axios instance
// pointed at the configured Directus origin, with:
//   - a request interceptor that attaches the Bearer access token, and
//   - a response interceptor that, on 401, transparently refreshes the token once and retries,
//     falling back to the unauthorized handler (→ /login) when the refresh also fails.
// This reproduces, cross-origin, what the Directus session cookie did for the embedded module.
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getConfig } from './config';
import { authStore } from './authStore';

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
	onUnauthorized = fn;
}

export const api = axios.create();

api.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
	// baseURL is resolved per-request so a runtime /config.json (loaded at boot) is honoured.
	cfg.baseURL = getConfig().directusUrl;
	const tok = authStore.getAccessToken();
	if (tok) {
		cfg.headers.set('Authorization', `Bearer ${tok}`);
	}
	return cfg;
});

api.interceptors.response.use(
	(res) => res,
	async (error: AxiosError) => {
		const cfg = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
		const status = error.response?.status;
		// 403 as well as 401: Directus answers a request carrying NO usable token with 403 on
		// item reads, so an expired access token surfaced as a 403 that this interceptor
		// ignored -- the detached diagnostics panel showed "Request failed with status code
		// 403" and never recovered. Retrying a genuine permissions 403 costs one refresh and
		// then fails the same way, so the retry is safe to widen.
		const recoverable = status === 401 || status === 403;
		if (recoverable && cfg && !cfg._retried && authStore.state.refreshToken) {
			cfg._retried = true;
			const ok = await authStore.refresh();
			if (ok) {
				cfg.headers.set('Authorization', `Bearer ${authStore.getAccessToken()}`);
				return api.request(cfg);
			}
			// A refresh that failed because the server couldn't be reached leaves the refresh token in
			// place (only a refusal clears it). That is not "this session is over": don't sign out,
			// and don't bounce a recording in progress to /login.
			if (authStore.state.refreshToken) return Promise.reject(error);
		}
		// Only a 401 means "this session is over". A 403 that survived the retry above is a
		// permissions answer about one resource, and must not sign the analyst out.
		// An offline session has no token to lose: its 401s are just the server asking for one, and
		// bouncing to /login would throw away a recording in progress.
		if (status === 401 && !authStore.state.offline) {
			authStore.clear();
			onUnauthorized?.();
		}
		return Promise.reject(error);
	},
);

// Authenticated Bearer header for the sidecar `fetch()` calls (filter-service, and any octree
// requests that need auth). Kept here so there is one source of truth for the auth header.
export function authHeaders(): Record<string, string> {
	const tok = authStore.getAccessToken();
	return tok ? { Authorization: `Bearer ${tok}` } : {};
}
