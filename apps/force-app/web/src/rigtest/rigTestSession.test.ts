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
		await sync.sync(view({ relay: 'signin_rejected' }));       // refused: refresh, send tok-1-r
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(api.putSession).toHaveBeenLastCalledWith('tok-1-r', expect.any(Number));
		await sync.sync(view({ relay: 'signin_rejected' }));       // refused again: give up
		await sync.sync(view({ relay: 'signin_rejected' }));
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
});
