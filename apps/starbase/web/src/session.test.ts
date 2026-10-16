import { describe, expect, it, vi } from 'vitest';
import { createApi, looksRestarting } from './api';
import {
	SESSION_NOT_KEPT, classifyLoadError, createSession, listProviders, providerLoginUrl, safeNext, signInErrorText, ssoErrorText,
} from './session';
import { fakeServer, type Reply } from './testing/fakeServer';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const ME = { status: 200, data: { data: { id: 'u1', first_name: 'Ada', role: 'r1' } } };
const ADMIN = { status: 200, data: { data: { admin_access: true } } };

function setup(route: (key: string, cfg: any) => Reply) {
	const api = createApi(D1);
	const calls = fakeServer(api, route);
	return { api, calls, session: createSession(api, async () => false) };
}

describe('createSession', () => {
	it('load: signed in, with the user and the server-side admin flag', async () => {
		const { session } = setup((key) => (key === 'GET /users/me' ? ME : key === 'GET /policies/me/globals' ? ADMIN : 404));
		expect(await session.load()).toBe('signed-in');
		expect(session.user.value).toEqual({ id: 'u1', first_name: 'Ada', role: 'r1' });
		await vi.waitFor(() => expect(session.adminKnown.value).toBe(true));
		expect(session.isAdmin.value).toBe(true);
	});

	it('load: a lapsed access token is renewed before deciding', async () => {
		let first = true;
		const { session, calls } = setup((key) => {
			if (key === 'GET /users/me') {
				const r = first ? 401 : ME;
				first = false;
				return r;
			}
			return key === 'POST /auth/refresh' ? 200 : 404;
		});
		expect(await session.load()).toBe('signed-in');
		expect(calls.slice(0, 3)).toEqual(['GET /users/me', 'POST /auth/refresh', 'GET /users/me']);
	});

	it('load: no session at all is signed-out', async () => {
		const { session } = setup((key) => (key === 'POST /auth/refresh' ? 400 : 401));
		expect(await session.load()).toBe('signed-out');
		expect(session.user.value).toBeNull();
	});

	it('load: a renewal answered by a gateway blip is unreachable, not signed out', async () => {
		for (const blip of [502, 429]) {
			const { session } = setup((key) => (key === 'POST /auth/refresh' ? blip : 401));
			expect(await session.load(), String(blip)).toBe('unreachable');
		}
	});

	it('load: no answer, a timeout or a 5xx is unreachable, not signed out (Review Focus 5)', async () => {
		expect(await setup(() => 'network').session.load()).toBe('unreachable');
		expect(await setup(() => 502).session.load()).toBe('unreachable');
		expect(classifyLoadError({ code: 'ECONNABORTED' })).toBe('unreachable');
		expect(classifyLoadError({ response: { status: 403 } })).toBe('signed-out');
	});

	it('ensure: loads once, however many navigations ask at the same time', async () => {
		const { session, calls } = setup((key) => (key === 'GET /users/me' ? ME : 404));
		await Promise.all([session.ensure(), session.ensure(), session.ensure()]);
		expect(calls.filter((c) => c === 'GET /users/me')).toHaveLength(1);
		await session.ensure();
		expect(calls.filter((c) => c === 'GET /users/me')).toHaveLength(1);
	});

	it('signIn: posts the password in session mode (the cookie Data Studio uses), then loads who it is', async () => {
		let login: any;
		const { session } = setup((key, cfg) => {
			if (key === 'POST /auth/login') {
				login = { body: JSON.parse(String(cfg.data)), withCredentials: cfg.withCredentials };
				return 200;
			}
			return key === 'GET /users/me' ? ME : 404;
		});
		await session.signIn('ada@example.org', 'pw');
		expect(login).toEqual({ body: { email: 'ada@example.org', password: 'pw', mode: 'session' }, withCredentials: true });
		expect(session.state.value).toBe('signed-in');
	});

	it('signIn: says so when the browser did not keep the session', async () => {
		const { session } = setup((key) => (key === 'POST /auth/login' ? 200 : key === 'POST /auth/refresh' ? 400 : 401));
		await expect(session.signIn('a@b.c', 'pw')).rejects.toThrow(SESSION_NOT_KEPT);
	});

	it('signOut: ends the session in session mode (Data Studio too) and forgets the user, even offline', async () => {
		let logout: unknown;
		const { session } = setup((key, cfg) => {
			if (key === 'POST /auth/logout') {
				logout = JSON.parse(String(cfg.data));
				return 'network';
			}
			return key === 'GET /users/me' ? ME : 404;
		});
		await session.load();
		await session.signOut();
		expect(logout).toEqual({ mode: 'session' });
		expect(session.state.value).toBe('signed-out');
		expect(session.user.value).toBeNull();
	});
});

describe('safeNext (Review Focus 2)', () => {
	it('keeps a path of this app, query and encoding included', () => {
		expect(safeNext('/samples/a%2Fb?x=1#k')).toBe('/samples/a%2Fb?x=1#k');
		expect(safeNext('/plot/force?operation=9')).toBe('/plot/force?operation=9');
	});
	it('sends anything else to Home', () => {
		for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/signin', '/signin?next=/x', '/signin/done', 'samples', '', undefined, null, ['/samples'], '/a\nb']) {
			expect(safeNext(bad), String(bad)).toBe('/');
		}
	});
});

describe('providers', () => {
	it('one button per provider Directus lists', async () => {
		const { api } = setup(() => ({ status: 200, data: { data: [{ name: 'google', driver: 'openid', icon: 'google' }, { name: 'lab', label: 'Lab SSO' }, { driver: 'x' }] } }));
		expect(await listProviders(api)).toEqual([
			{ name: 'google', label: 'Google', icon: 'google' },
			{ name: 'lab', label: 'Lab SSO', icon: null },
		]);
	});
	it('no providers (or no answer) means just the password form', async () => {
		expect(await listProviders(setup(() => 'network').api)).toEqual([]);
	});
	it("the provider link returns to STARbase's /signin/done with a safe next", () => {
		expect(providerLoginUrl(`${D1}/`, 'google', 'https://starbase.tail54eeb6.ts.net', '/samples/1?x=1')).toBe(
			`${D1}/auth/login/google?redirect=${encodeURIComponent('https://starbase.tail54eeb6.ts.net/signin/done?next=%2Fsamples%2F1%3Fx%3D1')}`,
		);
		expect(providerLoginUrl(D1, 'google', 'https://s', '//evil')).toContain(encodeURIComponent('next=%2F'));
	});
});

describe('error texts', () => {
	it('sign-in failures say what to do', () => {
		expect(signInErrorText({ response: { status: 401, data: {} } })).toBe('Wrong email or password.');
		expect(signInErrorText({ message: 'Network Error' })).toMatch(/Can't reach the database/);
		expect(signInErrorText({ response: { status: 503, data: {} } })).toMatch(/under maintenance/);
		expect(signInErrorText({ response: { status: 429, data: { errors: [{ message: 'Too many requests' }] } } })).toBe('Too many requests');
		expect(signInErrorText(new Error(SESSION_NOT_KEPT))).toBe(SESSION_NOT_KEPT);
	});
	it("an SSO return shows Directus's reason", () => {
		expect(ssoErrorText('INVALID_CREDENTIALS')).toBe('Directus did not accept that account.');
		expect(ssoErrorText('SOMETHING_NEW')).toBe('Directus said: SOMETHING_NEW');
	});
});

describe('looksRestarting', () => {
	it('treats a gateway status as a restart without probing', async () => {
		const probe = vi.fn(async () => false);
		expect(await looksRestarting({ response: { status: 502 } }, probe)).toBe(true);
		expect(probe).not.toHaveBeenCalled();
	});
	it('a silent d1-server is a restart when STARbase itself still answers, offline when it does not', async () => {
		expect(await looksRestarting({ message: 'Network Error' }, async () => true)).toBe(true);
		expect(await looksRestarting({ message: 'Network Error' }, async () => false)).toBe(false);
	});
	it('any other answer is not a restart', async () => {
		expect(await looksRestarting({ response: { status: 500 } }, async () => true)).toBe(false);
	});
});
