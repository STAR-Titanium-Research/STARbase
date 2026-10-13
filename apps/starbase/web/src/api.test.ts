import { describe, expect, it, vi } from 'vitest';
import { createApi, installSessionGuard, refreshSession, sessionAlive } from './api';
import { fakeServer, type Reply } from './testing/fakeServer';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const statusOf = (e: unknown) => (e as { response?: { status?: number } }).response?.status;

function setup(route: (key: string) => Reply) {
	const api = createApi(D1);
	const onSignedOut = vi.fn();
	const guard = installSessionGuard(api, onSignedOut);
	const calls = fakeServer(api, (key) => route(key));
	return { api, guard, onSignedOut, calls };
}

describe('createApi', () => {
	it('talks to d1-server with the session cookie, never a token', () => {
		const api = createApi(D1);
		expect(api.defaults.baseURL).toBe(D1);
		expect(api.defaults.withCredentials).toBe(true);
		expect(api.defaults.headers.common?.Authorization).toBeUndefined();
	});
});

describe('the session guard', () => {
	it('a 401 renews the session once and retries the request', async () => {
		let first = true;
		const { api, calls, onSignedOut } = setup((key) => {
			if (key === 'GET /items/x') {
				const s = first ? 401 : 200;
				first = false;
				return s;
			}
			return key === 'POST /auth/refresh' ? 200 : 404;
		});
		await expect(api.get('/items/x')).resolves.toMatchObject({ status: 200 });
		expect(calls).toEqual(['GET /items/x', 'POST /auth/refresh', 'GET /items/x']);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it("a 403 with a live session is the page's to show: no renewal, no sign-out", async () => {
		const { api, calls, onSignedOut } = setup((key) => (key === 'GET /items/x' ? 403 : key === 'GET /users/me' ? 200 : 404));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(403);
		expect(calls).toEqual(['GET /items/x', 'GET /users/me']);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it('signed out elsewhere: a 403 as the public role sends the user to sign in (Review Focus 1)', async () => {
		const { api, calls, onSignedOut } = setup((key) =>
			key === 'GET /items/x' ? 403 : key === 'GET /users/me' ? 401 : key === 'POST /auth/refresh' ? 400 : 404,
		);
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(403);
		expect(calls).toEqual(['GET /items/x', 'GET /users/me', 'POST /auth/refresh']);
		expect(onSignedOut).toHaveBeenCalledTimes(1);
	});

	it('a network error is not a sign-out (Review Focus 5)', async () => {
		const { api, calls, onSignedOut } = setup(() => 'network');
		const e = await api.get('/items/x').catch((x) => x);
		expect(statusOf(e)).toBeUndefined();
		expect(calls).toEqual(['GET /items/x']);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it('a renewal that cannot reach the server does not sign out', async () => {
		const { api, onSignedOut } = setup((key) => (key === 'GET /items/x' ? 401 : 'network'));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(401);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it('a renewal answered by a gateway blip (502) or a rate limit (429) does not sign out', async () => {
		for (const blip of [502, 503, 504, 429]) {
			const { api, calls, onSignedOut } = setup((key) => (key === 'GET /items/x' ? 401 : key === 'POST /auth/refresh' ? blip : 404));
			expect(statusOf(await api.get('/items/x').catch((e) => e)), String(blip)).toBe(401);
			expect(calls).toEqual(['GET /items/x', 'POST /auth/refresh']);
			expect(onSignedOut, String(blip)).not.toHaveBeenCalled();
		}
	});

	it('a renewal refused with 401 signs out', async () => {
		const { api, onSignedOut } = setup((key) => (key === 'GET /items/x' ? 401 : key === 'POST /auth/refresh' ? 401 : 404));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(401);
		expect(onSignedOut).toHaveBeenCalledTimes(1);
	});

	it('concurrent 401s share one renewal', async () => {
		const seen = new Set<string>();
		const { api, calls } = setup((key) => {
			if (key.startsWith('GET /items/')) {
				if (seen.has(key)) return 200;
				seen.add(key);
				return 401;
			}
			return key === 'POST /auth/refresh' ? 200 : 404;
		});
		await Promise.all([api.get('/items/a'), api.get('/items/b')]);
		expect(calls.filter((c) => c === 'POST /auth/refresh')).toHaveLength(1);
	});

	it('a request that fails again after the retry is not retried a second time', async () => {
		const { api, calls } = setup((key) => (key === 'GET /items/x' ? 401 : key === 'POST /auth/refresh' ? 200 : 404));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(401);
		expect(calls).toEqual(['GET /items/x', 'POST /auth/refresh', 'GET /items/x']);
	});

	it('sign-in, sign-out and the probes are not guarded', async () => {
		const { api, calls } = setup(() => 401);
		await api.post('/auth/login', {}, { sbNoGuard: true }).catch(() => {});
		expect(calls).toEqual(['POST /auth/login']);
	});

	it('recover() for the plotters: a live session is a refusal, a lapsed one is renewed', async () => {
		const alive = setup((key) => (key === 'GET /users/me' ? 200 : 404));
		expect(await alive.guard.recover(403)).toBe('fail');
		const lapsed = setup((key) => (key === 'GET /users/me' ? 401 : key === 'POST /auth/refresh' ? 200 : 404));
		expect(await lapsed.guard.recover(403)).toBe('retry');
	});
});

describe('refreshSession and sessionAlive', () => {
	it('renews in session mode, and tells a refusal from no answer', async () => {
		const api = createApi(D1);
		let body: unknown;
		fakeServer(api, (key, cfg) => {
			body = JSON.parse(String(cfg.data));
			return 200;
		});
		expect(await refreshSession(api)).toBe('ok');
		expect(body).toEqual({ mode: 'session' });
		fakeServer(api, () => 401);
		expect(await refreshSession(api)).toBe('refused');
		fakeServer(api, () => 'network');
		expect(await refreshSession(api)).toBe('unreachable');
	});
	it('only 400, 401 and 403 are a refusal; 5xx and 429 are no answer', async () => {
		const api = createApi(D1);
		for (const s of [400, 401, 403]) {
			fakeServer(api, () => s);
			expect(await refreshSession(api), String(s)).toBe('refused');
		}
		for (const s of [429, 500, 502, 503, 504]) {
			fakeServer(api, () => s);
			expect(await refreshSession(api), String(s)).toBe('unreachable');
		}
	});
	it('a session is alive unless /users/me says 401 or 403 (no answer counts as alive)', async () => {
		const api = createApi(D1);
		fakeServer(api, () => 200);
		expect(await sessionAlive(api)).toBe(true);
		fakeServer(api, () => 403);
		expect(await sessionAlive(api)).toBe(false);
		fakeServer(api, () => 'network');
		expect(await sessionAlive(api)).toBe(true);
	});
});
