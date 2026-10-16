import { ref, type Ref } from 'vue';
import type { AxiosError, AxiosInstance } from 'axios';
import { isRestarting, looksRestarting, ownOriginReachable, refreshSession, unreachableText } from './api';

// Who is signed in to STARbase. There is no STARbase account: the browser holds Directus's session
// cookie (set by /auth/login in session mode, here or in Data Studio), and this asks d1-server whose it
// is (spec §3.2). Admin status is the server's own answer (GET /policies/me/globals): in Directus 11 the
// flag lives on policies, not roles (the Force App's lesson).

export type SessionState = 'unknown' | 'signed-in' | 'signed-out' | 'unreachable';
export interface SessionUser {
	id: string;
	first_name?: string;
	last_name?: string;
	email?: string;
	role: string | null;
}
export interface AuthProvider {
	name: string;
	label: string;
	icon: string | null;
}

export interface Session {
	state: Ref<SessionState>;
	user: Ref<SessionUser | null>;
	/** While state is 'unreachable': d1-server answered 502/503/504 (restarting), not just silent. */
	restarting: Ref<boolean>;
	isAdmin: Ref<boolean>;
	adminKnown: Ref<boolean>;
	load(): Promise<SessionState>;
	ensure(): Promise<SessionState>;
	signIn(email: string, password: string): Promise<void>;
	signOut(): Promise<void>;
	markSignedOut(): void;
}

export const SESSION_NOT_KEPT =
	'Directus accepted the sign-in, but this browser did not keep the session for STARbase. Check that cookies are allowed for d1-server.';

const USER_FIELDS = 'id,first_name,last_name,email,role';
const LOAD_TIMEOUT_MS = 10_000;

const statusOf = (e: unknown): number | undefined => (e as AxiosError)?.response?.status;

// A failed /users/me: 401/403 is "no session"; no answer, a timeout or a 5xx is "can't reach".
export function classifyLoadError(e: unknown): 'signed-out' | 'unreachable' {
	const s = statusOf(e);
	return s === 401 || s === 403 ? 'signed-out' : 'unreachable';
}

function toUser(u: any): SessionUser {
	const role = u?.role && typeof u.role === 'object' ? (u.role.id ?? null) : (u?.role ?? null);
	const user: SessionUser = { id: String(u?.id), role };
	if (u?.first_name) user.first_name = u.first_name;
	if (u?.last_name) user.last_name = u.last_name;
	if (u?.email) user.email = u.email;
	return user;
}

export function createSession(api: AxiosInstance, probe: () => Promise<boolean> = ownOriginReachable): Session {
	const state = ref<SessionState>('unknown');
	const user = ref<SessionUser | null>(null);
	const isAdmin = ref(false);
	const restarting = ref(false);
	const adminKnown = ref(false);
	let loading: Promise<SessionState> | null = null;

	function markSignedOut(): void {
		state.value = 'signed-out';
		user.value = null;
		isAdmin.value = false;
		adminKnown.value = false;
	}

	async function readAdmin(): Promise<void> {
		adminKnown.value = false;
		try {
			const r = await api.get('/policies/me/globals', { sbNoGuard: true });
			isAdmin.value = r.data?.data?.admin_access === true;
		} catch {
			isAdmin.value = false;
		} finally {
			adminKnown.value = true;
		}
	}

	const me = () => api.get('/users/me', { params: { fields: USER_FIELDS }, timeout: LOAD_TIMEOUT_MS, sbNoGuard: true });

	async function fetchState(): Promise<SessionState> {
		let res;
		try {
			res = await me();
		} catch (e) {
			if (classifyLoadError(e) === 'unreachable') {
				restarting.value = await looksRestarting(e, probe);
				return (state.value = 'unreachable');
			}
			// No session, or only its access token lapsed: one renewal decides.
			const renewed = await refreshSession(api);
			if (renewed === 'unreachable') {
				restarting.value = await probe();
				return (state.value = 'unreachable');
			}
			if (renewed === 'refused') {
				markSignedOut();
				return state.value;
			}
			try {
				res = await me();
			} catch (again) {
				if (classifyLoadError(again) === 'unreachable') {
					restarting.value = await looksRestarting(again, probe);
				return (state.value = 'unreachable');
				}
				markSignedOut();
				return state.value;
			}
		}
		user.value = toUser(res.data?.data);
		state.value = 'signed-in';
		void readAdmin();
		return state.value;
	}

	function load(): Promise<SessionState> {
		if (!loading) loading = fetchState().finally(() => (loading = null));
		return loading;
	}

	async function ensure(): Promise<SessionState> {
		return state.value === 'unknown' ? load() : state.value;
	}

	async function signIn(email: string, password: string): Promise<void> {
		await api.post('/auth/login', { email, password, mode: 'session' }, { sbNoGuard: true });
		if ((await load()) !== 'signed-in') throw new Error(SESSION_NOT_KEPT);
	}

	async function signOut(): Promise<void> {
		try {
			await api.post('/auth/logout', { mode: 'session' }, { sbNoGuard: true });
		} catch {
			// Already gone, or d1-server unreachable: STARbase forgets the user either way.
		}
		markSignedOut();
	}

	return { state, user, isAdmin, restarting, adminKnown, load, ensure, signIn, signOut, markSignedOut };
}

// Where to go after signing in: a path of this app only. Another site (//host, a scheme, a backslash
// that browsers treat as a slash), a control character or the sign-in pages themselves give Home.
export function safeNext(raw: unknown): string {
	if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	if (/[\u0000-\u001f\\]/.test(raw)) return '/';
	if (raw === '/signin' || raw.startsWith('/signin/') || raw.startsWith('/signin?')) return '/';
	return raw;
}

// One button per SSO provider Directus offers (GET /auth). None, or no answer: just the password form.
export async function listProviders(api: AxiosInstance): Promise<AuthProvider[]> {
	try {
		const r = await api.get('/auth', { sbNoGuard: true });
		const list: unknown = r.data?.data;
		if (!Array.isArray(list)) return [];
		return list
			.filter((p) => p && typeof p.name === 'string' && p.name !== '')
			.map((p) => ({
				name: p.name as string,
				label: typeof p.label === 'string' && p.label ? p.label : (p.name as string).charAt(0).toUpperCase() + (p.name as string).slice(1),
				icon: typeof p.icon === 'string' ? p.icon : null,
			}));
	} catch {
		return [];
	}
}

// The provider's sign-in on d1-server, coming back to /signin/done. Directus must list this URL in
// AUTH_<PROVIDER>_REDIRECT_ALLOW_LIST (runbook).
export function providerLoginUrl(directusUrl: string, provider: string, appOrigin: string, next: unknown): string {
	const back = `${appOrigin}/signin/done?next=${encodeURIComponent(safeNext(next))}`;
	return `${directusUrl.replace(/\/+$/, '')}/auth/login/${encodeURIComponent(provider)}?redirect=${encodeURIComponent(back)}`;
}

export async function signInErrorText(e: unknown, probe?: () => Promise<boolean>): Promise<string> {
	if (e instanceof Error && e.message === SESSION_NOT_KEPT) return SESSION_NOT_KEPT;
	const err = e as AxiosError<{ errors?: { message?: string }[] }>;
	if (!err?.response || isRestarting(e)) return unreachableText(e, probe);
	if (err.response.status === 401) return 'Wrong email or password.';
	return err.response.data?.errors?.[0]?.message || 'Sign-in failed.';
}

// /signin/done?reason=<CODE>: Directus sends the user back with its own code when an SSO sign-in fails.
export function ssoErrorText(reason: string): string {
	const known: Record<string, string> = {
		INVALID_CREDENTIALS: 'Directus did not accept that account.',
		INVALID_PROVIDER: 'That sign-in provider is not set up on d1-server.',
		USER_SUSPENDED: 'That account is suspended.',
	};
	return known[reason] ?? `Directus said: ${reason}`;
}
