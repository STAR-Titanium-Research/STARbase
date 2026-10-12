import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from './rigTestApi';
import { REFRESH_AHEAD_MS, createSessionSync, type SessionView } from './rigTestSession';

const ok = (): ApiResult<unknown> => ({ kind: 'ok', data: { ok: true } });
const NOW = 1_000_000;

function setup(over: { online?: boolean; token?: string | null; expiresAt?: number } = {}) {
	const auth = {
		on: over.online ?? true,
		token: over.token === undefined ? 'tok-1' : over.token,
		expiresAt: over.expiresAt ?? NOW + 15 * 60_000,
	};
	const api = { putSession: vi.fn(async () => ok()), deleteSession: vi.fn(async () => ok()) };
	const refresh = vi.fn(async () => { auth.token = `${auth.token}-r`; auth.expiresAt = NOW + 15 * 60_000; return true; });
	const sync = createSessionSync({
		api,
		auth: { online: () => auth.on && !!auth.token, accessToken: () => auth.token, expiresAt: () => auth.expiresAt, refresh },
		now: () => NOW,
	});
	return { auth, api, refresh, sync };
}
const view = (v: Partial<SessionView> = {}): SessionView => ({ session: false, hardwareOk: true, relay: 'ok', ...v });

describe('createSessionSync', () => {
	it('sends the token once, then only when it changes or the recorder lost it', async () => {
		const { auth, api, sync } = setup();
		await sync.sync(view());
		expect(api.putSession).toHaveBeenCalledWith('tok-1', auth.expiresAt);
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenCalledTimes(1);
		await sync.sync(view({ session: false })); // the recorder restarted
		expect(api.putSession).toHaveBeenCalledTimes(2);
		auth.token = 'tok-2';
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenLastCalledWith('tok-2', auth.expiresAt);
	});

	it('clears the recorder on sign-out or going offline', async () => {
		const { auth, api, sync } = setup();
		await sync.sync(view());
		auth.on = false;
		await sync.sync(view({ session: true }));
		expect(api.deleteSession).toHaveBeenCalledTimes(1);
		await sync.sync(view({ session: false }));
		expect(api.deleteSession).toHaveBeenCalledTimes(1); // nothing left to clear
	});

	it('refreshes early only on the rig', async () => {
		const near = { expiresAt: NOW + REFRESH_AHEAD_MS - 1 };
		const onRig = setup(near);
		await onRig.sync.sync(view({ hardwareOk: true }));
		expect(onRig.refresh).toHaveBeenCalledTimes(1);
		expect(onRig.api.putSession).toHaveBeenCalledWith('tok-1-r', expect.any(Number));
		for (const hardwareOk of [false, null]) {
			const office = setup(near);
			await office.sync.sync(view({ hardwareOk }));
			expect(office.refresh).not.toHaveBeenCalled();
		}
	});

	it('does not send an expired token', async () => {
		const { api, sync } = setup({ expiresAt: NOW - 1 });
		await sync.sync(view({ hardwareOk: false }));
		expect(api.putSession).not.toHaveBeenCalled();
	});

	it('retries a rejected sign-in once, then stops', async () => {
		const { api, refresh, sync } = setup();
		await sync.sync(view());                                   // sends tok-1
		await sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() })); // refused: refresh, send tok-1-r
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(api.putSession).toHaveBeenLastCalledWith('tok-1-r', expect.any(Number));
		await sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() })); // refused again: give up
		await sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() }));
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(api.putSession).toHaveBeenCalledTimes(2);
	});

	it('a failed PUT is tried again on the next tick', async () => {
		const { api, sync } = setup();
		api.putSession.mockResolvedValueOnce({ kind: 'error', status: 0, detail: 'down' });
		await sync.sync(view({ session: true }));
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenCalledTimes(2);
	});

	it('release() clears the recorder only when signed out', async () => {
		const signedIn = setup();
		await signedIn.sync.release();
		expect(signedIn.api.deleteSession).not.toHaveBeenCalled();
		const signedOut = setup({ online: false });
		await signedOut.sync.release();
		expect(signedOut.api.deleteSession).toHaveBeenCalledTimes(1);
	});

	it('a sign-out that lands while a PUT is in flight is applied once it finishes', async () => {
		const { auth, api, sync } = setup();
		let release: (r: ApiResult<unknown>) => void = () => {};
		api.putSession.mockImplementationOnce(() => new Promise<ApiResult<unknown>>((res) => { release = res; }));
		const first = sync.sync(view());
		auth.on = false;
		const second = sync.sync(view({ session: true })); // dropped by the busy guard, but remembered
		release(ok());
		await Promise.all([first, second]);
		expect(api.deleteSession).toHaveBeenCalledTimes(1);
	});

	it('a rejection asked before the new token was sent is stale: ignored, nothing deleted', async () => {
		const { auth, api, refresh, sync } = setup();
		let releasePut: () => void = () => {};
		let onRefresh = () => {};
		refresh.mockImplementation(async () => { auth.token = 'tok-1-r'; onRefresh(); return true; });
		await sync.sync(view()); // tok-1 lent
		api.putSession.mockImplementationOnce(() => new Promise<ApiResult<unknown>>((res) => { releasePut = () => res(ok()); }));
		let stale: Promise<void> = Promise.resolve();
		// The refresh makes the store re-read /pending; that GET leaves before the new PUT finishes
		// and still carries the old "rejected" answer.
		onRefresh = () => { stale = sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() })); };
		const first = sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() }));
		await vi.waitFor(() => expect(api.putSession).toHaveBeenCalledTimes(2));
		releasePut();
		await Promise.all([first, stale]);
		await sync.sync(view({ session: true, relay: 'ok', askedAt: sync.stamp() })); // the recorder holds tok-1-r, relay accepts it
		expect((api.putSession.mock.calls as unknown as [string][]).map((c) => c[0])).toEqual(['tok-1', 'tok-1-r']);
		expect(api.deleteSession).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('a rejection asked after the new token was sent is believed', async () => {
		const { api, sync } = setup();
		await sync.sync(view());
		await sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() }));
		expect(api.putSession).toHaveBeenLastCalledWith('tok-1-r', expect.any(Number));
		await sync.sync(view({ session: false, relay: 'signin_rejected', askedAt: sync.stamp() })); // refused again
		await sync.sync(view({ session: false, relay: 'ok', askedAt: sync.stamp() }));
		expect(api.putSession).toHaveBeenCalledTimes(2); // gave up: the refused token is not sent again
	});

	it('a rejection with no askedAt is never believed once a PUT has finished', async () => {
		const { refresh, sync, api } = setup();
		await sync.sync(view());
		await sync.sync(view({ relay: 'signin_rejected' }));
		expect(refresh).not.toHaveBeenCalled();
		expect(api.deleteSession).not.toHaveBeenCalled();
	});

	it('release() while a PUT is in flight: the finished PUT is undone and not recorded as lent', async () => {
		const { auth, api, sync } = setup();
		let finish: () => void = () => {};
		api.putSession.mockImplementationOnce(() => new Promise<ApiResult<unknown>>((res) => { finish = () => res(ok()); }));
		const first = sync.sync(view());
		await vi.waitFor(() => expect(api.putSession).toHaveBeenCalledTimes(1));
		auth.on = false;
		await sync.release();
		expect(api.deleteSession).toHaveBeenCalledTimes(1);
		finish();
		await first;
		expect(api.deleteSession).toHaveBeenCalledTimes(2); // the late PUT is undone
		// The old token is not remembered as lent: signing back in with it sends it again.
		auth.on = true;
		await sync.sync(view({ session: true }));
		expect(api.putSession).toHaveBeenCalledTimes(2);
		expect(api.putSession).toHaveBeenLastCalledWith('tok-1', expect.any(Number));
	});

	it('release() forgets a refused token, so the next sign-in starts clean', async () => {
		const { auth, api, refresh, sync } = setup();
		await sync.sync(view());
		await sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() })); // refresh -> tok-1-r
		await sync.sync(view({ relay: 'signin_rejected', askedAt: sync.stamp() })); // tok-1-r refused too: retry used up
		auth.on = false;
		await sync.release();
		auth.on = true; // the same token signed in again
		await sync.sync(view({ relay: 'ok' }));
		expect(api.putSession).toHaveBeenLastCalledWith('tok-1-r', expect.any(Number));
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
