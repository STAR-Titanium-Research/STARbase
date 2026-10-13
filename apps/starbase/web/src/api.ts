import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

// STARbase's client for d1-server. There is no token anywhere: the browser sends Directus's session
// cookie (withCredentials), the one Data Studio uses (ADR-0013). Pages get this instance as host.api and
// the plotters as their api, so every request passes the session guard below.

declare module 'axios' {
	interface AxiosRequestConfig {
		/** Not watched by the session guard: sign-in, sign-out and the guard's own probes. */
		sbNoGuard?: boolean;
		/** Already retried once after a session renewal. */
		sbRetried?: boolean;
	}
}

export function createApi(baseURL: string): AxiosInstance {
	return axios.create({ baseURL, withCredentials: true, timeout: 30_000 });
}

export type RefreshOutcome = 'ok' | 'refused' | 'unreachable';
export type Recovery = 'retry' | 'fail' | 'signed-out';

// POST /auth/refresh in session mode: Directus renews the session cookie (Data Studio does the same, and
// Directus's refresh grace period covers both apps renewing at once). A refusal means there is no
// session any more; no answer at all means d1-server could not be reached, which is not a sign-out.
export async function refreshSession(api: AxiosInstance): Promise<RefreshOutcome> {
	try {
		await api.post('/auth/refresh', { mode: 'session' }, { sbNoGuard: true });
		return 'ok';
	} catch (e) {
		// Only Directus saying "no such session" (400 invalid/missing token, 401, 403) is a refusal. A gateway
		// 502/503/504, a 429 or no answer is d1-server not being reachable: never a reason to sign anyone out.
		const status = (e as AxiosError).response?.status;
		return status === 400 || status === 401 || status === 403 ? 'refused' : 'unreachable';
	}
}

// Is the session still there? /users/me answers while it is. No answer counts as alive: a network blip
// must never sign anyone out.
export async function sessionAlive(api: AxiosInstance): Promise<boolean> {
	try {
		await api.get('/users/me', { params: { fields: 'id' }, sbNoGuard: true });
		return true;
	} catch (e) {
		const status = (e as AxiosError).response?.status;
		return !(status === 401 || status === 403);
	}
}

export interface SessionGuard {
	// What a 401/403 means: 'retry' (the session was renewed), 'fail' (a real refusal, or no answer),
	// 'signed-out' (no session; onSignedOut has been called). Also used by the Force plotter's refreshAuth.
	recover(status: number): Promise<Recovery>;
}

// After a sign-out in Data Studio there is no cookie, and Directus answers items as the PUBLIC role:
// 403, not 401 (spec §4, Review Focus 1). So a 403 is checked: if the session is alive it is a real
// refusal (a Lab Member reading what they may not; the page shows it), otherwise the session is renewed
// or, if that is refused, the user is sent to sign in. Concurrent failures share one check per status.
export function installSessionGuard(
	api: AxiosInstance,
	onSignedOut: () => void,
	probes: { alive(): Promise<boolean>; refresh(): Promise<RefreshOutcome> } = { alive: () => sessionAlive(api), refresh: () => refreshSession(api) },
): SessionGuard {
	const inFlight = new Map<number, Promise<Recovery>>();

	async function run(status: number): Promise<Recovery> {
		if (status === 403 && (await probes.alive())) return 'fail';
		const outcome = await probes.refresh();
		if (outcome === 'ok') return 'retry';
		if (outcome === 'refused') {
			onSignedOut();
			return 'signed-out';
		}
		return 'fail';
	}

	const guard: SessionGuard = {
		recover(status) {
			let p = inFlight.get(status);
			if (!p) {
				p = run(status).finally(() => inFlight.delete(status));
				inFlight.set(status, p);
			}
			return p;
		},
	};

	api.interceptors.response.use(undefined, async (error: AxiosError) => {
		const cfg = error.config as InternalAxiosRequestConfig | undefined;
		const status = error.response?.status;
		if (!cfg || cfg.sbNoGuard || cfg.sbRetried || (status !== 401 && status !== 403)) throw error;
		if ((await guard.recover(status)) !== 'retry') throw error;
		cfg.sbRetried = true;
		return api.request(cfg);
	});

	return guard;
}
