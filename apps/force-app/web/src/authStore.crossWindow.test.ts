// Two windows (the main one and a pop-out) share one session through localStorage. Directus rotates
// the refresh token on every /auth/refresh, so a window still holding the previous one must pick up
// the new one rather than get refused and sign every window out.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Installed before authStore evaluates: it reads the stored session and registers its `storage`
// listener at import time.
const store = vi.hoisted(() => {
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		},
	});
	Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
	return store;
});

// A Directus that honours only its current refresh token and rotates it on every refresh.
const server = vi.hoisted(() => ({
	validRefresh: '' as string,
	n: 0,
	refreshCalls: [] as string[],
	rotate(): { access_token: string; refresh_token: string; expires: number } {
		this.n += 1;
		this.validRefresh = `rt-${this.n}`;
		return { access_token: `at-${this.n}`, refresh_token: this.validRefresh, expires: 900000 };
	},
}));
vi.mock('axios', () => {
	const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });
	const client = {
		post: async (path: string, body: any) => {
			if (path === '/auth/login') return { data: { data: server.rotate() } };
			if (path === '/auth/refresh') {
				server.refreshCalls.push(body.refresh_token);
				await null; // the request is "on the wire": a test can act before the server answers
				if (body.refresh_token !== server.validRefresh) throw httpErr(401);
				return { data: { data: server.rotate() } };
			}
			return { data: {} };
		},
		get: async (path: string) => {
			if (path === '/users/me') {
				return { data: { data: { id: 'u-1', role: 'r', first_name: 'Ada', last_name: 'L', email: 'ada@lab.org', policies: [] } } };
			}
			if (path === '/items/people') return { data: { data: [{ person_id: 'p-1' }] } };
			return { data: {} };
		},
	};
	return { default: { create: () => client } };
});
vi.mock('./config', () => ({ getConfig: () => ({ directusUrl: 'http://directus' }) }));

import { authStore } from './authStore';
import { revokeOfflineLogin } from './offlineAuth';

const KEY = 'force-app.auth';

/** What the other window does when it refreshes: the server rotates, and it stores the result.
 *  No `storage` event is delivered here -- tests that want one call fireStorage(). */
function otherWindowRefreshes() {
	const t = server.rotate();
	const saved = JSON.parse(store.get(KEY)!);
	store.set(KEY, JSON.stringify({ ...saved, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires }));
}

function fireStorage(key: string | null = KEY) {
	window.dispatchEvent(Object.assign(new Event('storage'), { key }));
}

beforeEach(() => {
	authStore.clear();
	store.clear();
	server.validRefresh = '';
	server.n = 0;
	server.refreshCalls = [];
});

describe('storage events from another window', () => {
	it('a refresh in another window replaces this window\'s tokens', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		otherWindowRefreshes();
		fireStorage();
		expect(authStore.state.refreshToken).toBe(server.validRefresh);
		expect(authStore.state.accessToken).toBe(`at-${server.n}`);

		// ...so this window's own next refresh is accepted.
		expect(await authStore.refresh()).toBe(true);
		expect(server.refreshCalls).toEqual(['rt-2']);
	});

	it('a sign-in in another window signs this one in too', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		const saved = store.get(KEY)!;
		authStore.clear();

		store.set(KEY, saved);
		fireStorage();
		expect(authStore.isAuthenticated.value).toBe(true);
		expect(authStore.state.user).toMatchObject({ id: 'u-1', person_id: 'p-1' });
	});

	it('removal (a sign-out in another window) signs this one out', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		store.delete(KEY);
		fireStorage();
		expect(authStore.isAuthenticated.value).toBe(false);
		expect(authStore.state.user).toBeNull();
	});

	it('localStorage.clear() elsewhere (key null) is followed too', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		store.clear();
		fireStorage(null);
		expect(authStore.isAuthenticated.value).toBe(false);
	});

	it('other keys, even ones sharing the prefix, are ignored', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		store.delete(KEY);
		fireStorage('force-app.auth.vault');
		expect(authStore.state.refreshToken).toBe('rt-1');
	});

	it('an offline session from another window is adopted only while its verifier is valid', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		const offline = JSON.stringify({
			accessToken: null, refreshToken: null, expiresAt: 0,
			user: authStore.state.user, offline: true, offlineVerifiedAt: Date.now(),
		});
		authStore.clear();

		store.set(KEY, offline);
		fireStorage();
		expect(authStore.state.offline).toBe(true);
		expect(authStore.isAuthenticated.value).toBe(true);

		revokeOfflineLogin('ada@lab.org');
		authStore.clear();
		store.set(KEY, offline);
		fireStorage();
		expect(authStore.state.offline).toBe(false);
		expect(authStore.isAuthenticated.value).toBe(false);
	});
});

describe('a refused refresh re-reads the stored session first', () => {
	it('another window already rotated the token: retry with the stored one, keep the session', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		otherWindowRefreshes(); // no event reached this window

		expect(await authStore.refresh()).toBe(true);
		expect(server.refreshCalls).toEqual(['rt-1', 'rt-2']);
		expect(authStore.state.refreshToken).toBe('rt-3');
		expect(JSON.parse(store.get(KEY)!).refreshToken).toBe('rt-3');
	});

	it('the stored token is the one refused: the session ends', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		server.validRefresh = 'revoked-on-server';

		expect(await authStore.refresh()).toBe(false);
		expect(server.refreshCalls).toEqual(['rt-1']);
		expect(authStore.isAuthenticated.value).toBe(false);
		expect(store.has(KEY)).toBe(false);
	});

	it('the retry is refused too: the session ends', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		otherWindowRefreshes();
		server.validRefresh = 'revoked-on-server';

		expect(await authStore.refresh()).toBe(false);
		expect(server.refreshCalls).toEqual(['rt-1', 'rt-2']);
		expect(authStore.isAuthenticated.value).toBe(false);
	});

	it('another window signed out meanwhile: this one signs out without a retry', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		server.validRefresh = 'revoked-on-server';
		store.delete(KEY);

		expect(await authStore.refresh()).toBe(false);
		expect(server.refreshCalls).toEqual(['rt-1']);
		expect(authStore.isAuthenticated.value).toBe(false);
	});

	it('a newer token that arrived by event while the request was in flight is retried, not wiped', async () => {
		await authStore.login('ada@lab.org', 'pw-1');
		// The other window refreshes while this window's (now doomed) request is on the wire, and its
		// storage event lands before the refusal does: this window's state already holds the new token,
		// but the one it SENT was the old one.
		const pending = authStore.refresh();
		otherWindowRefreshes();
		fireStorage();

		expect(await pending).toBe(true);
		expect(server.refreshCalls).toEqual(['rt-1', 'rt-2']);
		expect(JSON.parse(store.get(KEY)!).refreshToken).toBe('rt-3');
	});
});
