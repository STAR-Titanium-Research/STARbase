// Lends the signed-in operator's D1 access token to the local recorder, which sends it to the
// relay on every rig-test call (ADR-0012 decision 2, amended 2026-10-12). Only while the session
// is online: signed out or offline, the recorder holds nothing and the PC takes no requests.
//
// Driven by the store's pending poll (`sync`, every 30 s and on sign-in changes) and by the
// shell unmounting (`release`). A factory so the tests can drive it with a fake api and auth.
import type { ApiResult } from './rigTestApi';
import type { RelayState } from './rigTestLogic';

/** While the PC is on the rig, refresh the access token this long before it expires, so the
 *  recorder's copy never lapses between two 30 s polls. */
export const REFRESH_AHEAD_MS = 90_000;

export interface SessionAuth {
	/** An online session with an access token (not offline, not signed out). */
	online(): boolean;
	accessToken(): string | null;
	/** Epoch ms. */
	expiresAt(): number;
	refresh(): Promise<boolean>;
}
export interface SessionApi {
	putSession(token: string, expiresAt: number): Promise<ApiResult<unknown>>;
	deleteSession(): Promise<ApiResult<unknown>>;
}
/** What the recorder last said (GET /rig-tests/pending). */
export interface SessionView {
	session: boolean; hardwareOk: boolean | null; relay: RelayState;
	/** `stamp()` taken just before the request this view answers was issued. A `signin_rejected`
	 *  view is believed only if it was asked after our last PUT finished: an older one describes the
	 *  token we have since replaced. Absent counts as 0, i.e. never newer than a finished PUT. */
	askedAt?: number;
}

export function createSessionSync(deps: { api: SessionApi; auth: SessionAuth; now: () => number }) {
	const { api, auth, now } = deps;
	/** The token the recorder holds, as far as we know. */
	let sent: string | null = null;
	/** A token the relay refused: never sent again. */
	let rejected: string | null = null;
	/** A refused sign-in gets one refresh-and-resend; reset once the relay accepts again. */
	let retried = false;
	let busy = false;
	/** Monotonic clock for ordering requests against PUTs (see SessionView.askedAt). */
	let clock = 0;
	/** `stamp()` at the moment the last PUT finished successfully. */
	let sentAt = 0;
	/** release() ran: a PUT that finishes afterwards must not be recorded as lent. */
	let released = false;
	/** The latest view that arrived while a pass was running: the sign-in may have changed under
	 *  it, so one more pass runs on it when the first finishes. */
	let pendingView: SessionView | null = null;

	const wanted = (): string | null => (auth.online() ? auth.accessToken() : null);

	/** Call immediately before issuing GET /pending; pass the result back as `askedAt`. */
	const stamp = (): number => ++clock;

	async function sync(view: SessionView): Promise<void> {
		if (busy) { pendingView = view; return; }
		busy = true;
		try {
			// Asked before the token the recorder now holds was sent: it says nothing about that
			// token (and its `session: false` is out of date too). The next poll will.
			const stale = view.relay === 'signin_rejected' && (view.askedAt ?? 0) <= sentAt;
			if (stale) {
				// ignore the rejection
			} else if (view.relay === 'signin_rejected' && sent) {
				rejected = sent;
				sent = null;
				if (!retried) { retried = true; await auth.refresh(); }
			} else if (view.relay === 'ok') {
				retried = false;
			}
			if (view.hardwareOk === true && auth.online() && auth.expiresAt() - now() < REFRESH_AHEAD_MS) await auth.refresh();
			const token = wanted();
			if (token && token !== rejected && auth.expiresAt() > now()) {
				if (token !== sent || (!view.session && !stale)) {
					released = false;
					const r = await api.putSession(token, auth.expiresAt());
					if (released) {
						// release() ran while the PUT was in flight: the recorder must not keep it.
						sent = null;
						await api.deleteSession();
					} else {
						sent = r.kind === 'ok' ? token : null;
						if (r.kind === 'ok') sentAt = stamp();
					}
				}
			} else if (sent !== null || view.session) {
				await api.deleteSession();
				sent = null;
			}
		} finally {
			busy = false;
		}
		const next = pendingView;
		pendingView = null;
		if (next) await sync(next);
	}

	/** The shell is going away: if nobody is signed in online, the recorder must not keep the
	 *  last operator's token. */
	async function release(): Promise<void> {
		if (wanted()) return;
		sent = null;
		rejected = null;
		retried = false;
		released = true;
		await api.deleteSession();
	}

	return { sync, release, stamp };
}
export type SessionSync = ReturnType<typeof createSessionSync>;
