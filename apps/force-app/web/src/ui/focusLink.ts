// The `?focus=<id>` link convention (#98): any route can be opened with `?focus=<id>` and the
// element carrying `data-focus="<id>"` is spotlighted once it renders. A link from an error ("the
// sample rate is too high") or a help text ("set the backup URL") can then land the user on the
// exact field instead of on a page they have to search.
//
// The target often renders late — a lazy route chunk, a settings tab that only mounts once
// SettingsPage has read `?tab=`, a form waiting on its first fetch — so the lookup polls for a
// short while instead of giving up on the first miss.
import type { LocationQuery, Router } from 'vue-router';
import { resolveSpotlightTarget, spotlight } from './spotlight';

export const FOCUS_WAIT_MS = 2000;
const POLL_MS = 50;

/** The `focus` query value, or null. A repeated `?focus=a&focus=b` takes the first. */
export function focusIdFrom(query: LocationQuery): string | null {
	const v = query.focus;
	const id = Array.isArray(v) ? v[0] : v;
	return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** Resolves with the first non-null `probe()` result, or null once `timeoutMs` has passed. */
export function waitFor<T>(probe: () => T | null, timeoutMs = FOCUS_WAIT_MS, intervalMs = POLL_MS): Promise<T | null> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			const hit = probe();
			if (hit != null) return resolve(hit);
			if (Date.now() >= deadline) return resolve(null);
			setTimeout(tick, intervalMs);
		};
		tick();
	});
}

/** The query without `focus`, for clearing it once handled (so Back/reload doesn't replay it). */
export function withoutFocus(query: LocationQuery): LocationQuery {
	const { focus: _drop, ...rest } = query;
	return rest;
}

export function installFocusLinks(router: Router): void {
	// Only the latest navigation's target is spotlighted: a quick second link must not be
	// followed by the first one's late spotlight.
	let seq = 0;
	router.afterEach(async (to) => {
		const id = focusIdFrom(to.query);
		if (!id) return;
		const mine = ++seq;
		const el = await waitFor(() => resolveSpotlightTarget(id));
		if (mine !== seq) return;
		if (el) spotlight(el);
		if (router.currentRoute.value.query.focus !== undefined) {
			void router.replace({ query: withoutFocus(router.currentRoute.value.query), hash: router.currentRoute.value.hash });
		}
	});
}
