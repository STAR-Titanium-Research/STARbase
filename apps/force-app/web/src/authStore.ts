// Auth store — reuses Directus authentication. The standalone app has no user database of
// its own; it POSTs credentials to Directus /auth/login, holds the returned access + refresh
// tokens, and attaches the access token as a Bearer on every API call (see directusClient.ts).
//
// This module deliberately uses a BARE axios instance (not directusClient) for the auth
// endpoints, so there is no import cycle and a refresh can never recurse through the 401
// interceptor that itself triggers the refresh.
import axios from 'axios';
import { reactive, computed } from 'vue';
import { getConfig } from './config';
import {
	enrollOfflineLogin, getOfflineProfile, matchesStoredPassword, offlineEntryValid, revokeOfflineLogin,
	touchOfflineVerified, updateOfflineProfile, verifyOfflineLogin,
} from './offlineAuth';
import { isUnreachable } from './netErrors';

export interface DirectusUser {
	id: string;
	role: string | { id: string; admin_access?: boolean } | null;
	admin_access?: boolean;
	first_name?: string | null;
	last_name?: string | null;
	email?: string | null;
	/** people.person_id of this account (people.user_id -> directus_users), when it has one. */
	person_id?: string | null;
}

interface AuthState {
	accessToken: string | null;
	refreshToken: string | null;
	// epoch ms when the access token expires (server `expires` is a duration in ms).
	expiresAt: number;
	user: DirectusUser | null;
	// True for a session opened from the on-device verifier with no connection (see
	// offlineAuth.ts): a known user but NO Directus tokens, so nothing can be written to the
	// database until the user signs in online again (reauthenticate()).
	offline: boolean;
	// epoch ms of the online sign-in that created the verifier this offline session rests on.
	offlineVerifiedAt: number;
}

const LS_KEY = 'force-app.auth';

function loadPersisted(): Partial<AuthState> {
	try {
		return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
	} catch {
		return {};
	}
}

const persisted = loadPersisted();
// An offline session outlives a reload (the operator must not be signed out by restarting the
// app mid-shift with no network), but only while the account's verifier entry still exists and is
// in date: forgetting or revoking the account must end its session too, not just block new ones.
const offlineStillValid = !!persisted.offline && offlineEntryValid(persisted.user?.email);
const state = reactive<AuthState>({
	accessToken: persisted.accessToken ?? null,
	refreshToken: persisted.refreshToken ?? null,
	expiresAt: persisted.expiresAt ?? 0,
	user: offlineStillValid || persisted.refreshToken || persisted.accessToken ? (persisted.user ?? null) : null,
	offline: offlineStillValid,
	offlineVerifiedAt: offlineStillValid ? (persisted.offlineVerifiedAt ?? 0) : 0,
});

function persist() {
	// Persist the refresh token (survives reload) + last known user for a warm start. The
	// access token is short-lived; we keep it too so a quick reload doesn't force a refresh.
	localStorage.setItem(
		LS_KEY,
		JSON.stringify({
			accessToken: state.accessToken,
			refreshToken: state.refreshToken,
			expiresAt: state.expiresAt,
			user: state.user,
			offline: state.offline,
			offlineVerifiedAt: state.offlineVerifiedAt,
		}),
	);
}

/** Signed in, but who you are could not be read. The session is dropped rather than left user-less. */
export class ProfileLoadError extends Error {
	constructor() {
		super("Signed in, but your profile could not be loaded from the server. Try again.");
		this.name = 'ProfileLoadError';
	}
}

export class OfflineLoginError extends Error {
	constructor(public reason: 'unknown' | 'expired' | 'wrong-password' | 'throttled', message: string) {
		super(message);
		this.name = 'OfflineLoginError';
	}
}

// A bare client for the auth endpoints only — no interceptors, no Bearer, no refresh loop.
function authClient() {
	return axios.create({ baseURL: getConfig().directusUrl, headers: { 'Content-Type': 'application/json' } });
}

// Directus 11 moved admin_access/app_access from roles to POLICIES, so `role.admin_access`
// is not a real field — requesting it made Directus collapse the whole response to just {id}
// (dropping `role`), which broke admin detection. Fetch only valid fields: `role` (M2O id
// string, matched against the app's ADMIN_ROLE_IDS) plus the policy-derived admin flag.
const USER_FIELDS = ['id', 'first_name', 'last_name', 'email', 'role', 'policies.policy.admin_access'];

export const authStore = {
	state,
	isAuthenticated: computed(() => !!state.refreshToken || !!state.accessToken || state.offline),
	currentUser: computed(() => state.user),

	getAccessToken(): string | null {
		return state.accessToken;
	},

	// Sign in. Online this is a normal Directus login and (re)creates the on-device verifier for the
	// account. If Directus cannot be reached it falls back to that verifier, opening an offline
	// session. Resolves `{ offline }` so the caller can tell the user which one they got.
	async login(email: string, password: string): Promise<{ offline: boolean }> {
		try {
			await onlineLogin(email, password);
			return { offline: false };
		} catch (e: any) {
			if (e instanceof ProfileLoadError) throw e;
			if (isUnreachable(e)) return loginOffline(email, password);
			// The server refused a password this PC's verifier still accepts: it was changed, or the
			// account was disabled. Stop honouring it offline right away rather than at expiry.
			if (e?.response?.status === 401 && (await matchesStoredPassword(email, password).catch(() => false))) {
				revokeOfflineLogin(email);
			}
			throw e;
		}
	},

	// Upgrade an offline session to a real one once the server is reachable again: the same
	// user proves their password online, which also yields the tokens queued records need to sync.
	// Throws (and keeps the offline session) if the server is still unreachable or the password is wrong.
	async reauthenticate(password: string): Promise<void> {
		const email = state.user?.email;
		if (!email) throw new Error('no signed-in user to re-authenticate');
		try {
			await onlineLogin(email, password);
		} catch (e: any) {
			if (isUnreachable(e)) throw new Error("Still can't reach the server.");
			if (e?.response?.status === 401) throw new Error('Incorrect password.');
			throw e;
		}
	},

	// Exchange the refresh token for a fresh access token. Returns false if it can't (caller
	// then routes to /login). Concurrent 401s share one in-flight refresh via `refreshing`.
	async refresh(): Promise<boolean> {
		if (!state.refreshToken) return false;
		if (refreshing) return refreshing;
		refreshing = (async () => {
			try {
				const res = await authClient().post('/auth/refresh', { refresh_token: state.refreshToken, mode: 'json' });
				const data = res.data?.data ?? {};
				state.accessToken = data.access_token ?? null;
				state.refreshToken = data.refresh_token ?? state.refreshToken;
				state.expiresAt = Date.now() + (Number(data.expires) || 0);
				persist();
				// The server just vouched for this account: restart its offline window.
				if (state.user?.email) touchOfflineVerified(state.user.email);
				return !!state.accessToken;
			} catch (e: any) {
				// Only a refusal means the session is over. An unreachable server (or a proxy 5xx)
				// says nothing about the refresh token, and clearing it here signed operators out
				// the moment the network dropped.
				const status = e?.response?.status;
				if (status === 400 || status === 401 || status === 403) this.clear();
				return false;
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	},

	async fetchCurrentUser(): Promise<void> {
		if (!state.accessToken) return;
		try {
			const res = await authClient().get('/users/me', {
				params: { fields: USER_FIELDS },
				headers: { Authorization: `Bearer ${state.accessToken}` },
			});
			const me = res.data?.data ?? {};
			// Flatten the policy admin flag to a top-level `admin_access` boolean, which is one of
			// the signals the ownership-scoping logic checks (alongside ADMIN_ROLE_IDS on `role`).
			const policies: any[] = Array.isArray(me.policies) ? me.policies : [];
			const admin_access = policies.some((p) => p?.policy?.admin_access === true);
			// The person row this account is linked to (people.user_id). Recorded with every cut so the
			// database owner is the person who recorded it, whoever syncs it later. Best effort: keep
			// the previous value for the same user if this one lookup fails.
			// A FAILED lookup (as opposed to "no person row") must not erase a known link: keep the last
			// one from this session or, failing that, from the stored profile. Anything still missing is
			// resolved from the user id at upload time (recorder.ts::resolvePersonForUser).
			let person_id: string | null = state.user?.id === me.id ? (state.user?.person_id ?? null) : null;
			if (!person_id && me.email) person_id = getOfflineProfile(me.email)?.person_id ?? null;
			try {
				const pr = await authClient().get('/items/people', {
					params: { filter: { user_id: { _eq: me.id } }, fields: ['person_id'], limit: 1 },
					headers: { Authorization: `Bearer ${state.accessToken}` },
				});
				person_id = pr.data?.data?.[0]?.person_id ?? null;
			} catch {
				/* keep what we had */
			}
			state.user = {
				id: me.id,
				role: me.role ?? null,
				admin_access,
				first_name: me.first_name ?? null,
				last_name: me.last_name ?? null,
				email: me.email ?? null,
				person_id,
			};
			persist();
			if (state.user.email) updateOfflineProfile(state.user.email, state.user);
		} catch {
			/* leave the warm-start user in place */
		}
	},

	async logout(): Promise<void> {
		const rt = state.refreshToken;
		this.clear();
		if (rt) {
			try {
				await authClient().post('/auth/logout', { refresh_token: rt, mode: 'json' });
			} catch {
				/* best effort */
			}
		}
	},

	// Called on navigation: an offline session whose account was forgotten, revoked or has aged out
	// ends here. (Not mid-page: bouncing the operator to /login during a cut would lose it.)
	checkOfflineSession(): void {
		if (state.offline && !offlineEntryValid(state.user?.email)) this.clear();
	},

	clear(): void {
		state.accessToken = null;
		state.refreshToken = null;
		state.expiresAt = 0;
		state.user = null;
		state.offline = false;
		state.offlineVerifiedAt = 0;
		localStorage.removeItem(LS_KEY);
	},
};

// Directus login + the bits that hang off a successful one. Shared by login() and reauthenticate().
async function onlineLogin(email: string, password: string): Promise<void> {
	const res = await authClient().post('/auth/login', { email, password, mode: 'json' });
	const data = res.data?.data ?? {};
	state.accessToken = data.access_token ?? null;
	state.refreshToken = data.refresh_token ?? null;
	state.expiresAt = Date.now() + (Number(data.expires) || 0);
	state.offline = false;
	state.offlineVerifiedAt = 0;
	// A warm-start profile belongs to whoever signed in last. If this is a different account and
	// the profile fetch below fails, it must not be kept -- it would be enrolled (and later stamped
	// onto recordings) under the wrong person.
	if (state.user?.email?.trim().toLowerCase() !== email.trim().toLowerCase()) state.user = null;
	persist();
	await authStore.fetchCurrentUser();
	// A session with no user is worse than none: currentRecorder() is null, so recordings would be
	// saved unattributed and any user could sync them. Drop it and let the operator retry.
	if (!state.user) {
		authStore.clear();
		throw new ProfileLoadError();
	}
	// Remember this account for offline sign-in. Never let a failure here undo a good login.
	try {
		await enrollOfflineLogin(email, password, state.user);
	} catch (e) {
		console.warn('offline sign-in could not be enabled for this account', e);
	}
}

async function loginOffline(email: string, password: string): Promise<{ offline: boolean }> {
	const v = await verifyOfflineLogin(email, password);
	if (!v.ok) {
		const msg: Record<string, string> = {
			unknown: "Can't reach the server, and this account hasn't signed in on this PC before. Sign in once while connected to enable offline sign-in.",
			expired: "Can't reach the server, and offline sign-in for this account has expired. Sign in while connected to renew it.",
			'wrong-password': "Can't reach the server, and that password doesn't match the one stored for offline sign-in.",
			throttled: `Too many incorrect attempts. Try again in ${Math.ceil((v.retryInMs ?? 0) / 1000)} s.`,
		};
		throw new OfflineLoginError(v.reason, msg[v.reason]);
	}
	state.accessToken = null;
	state.refreshToken = null;
	state.expiresAt = 0;
	state.user = v.user;
	state.offline = true;
	state.offlineVerifiedAt = v.verifiedAt;
	persist();
	return { offline: true };
}

let refreshing: Promise<boolean> | null = null;
