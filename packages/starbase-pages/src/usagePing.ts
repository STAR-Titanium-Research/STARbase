import type { Router } from 'vue-router';
import { canonicalPath, createRepeatFilter, routeTarget, type RepeatFilter, type UsageKind } from '@d1/ui';

// The visit pings of the "Frequently used" panel: POST /d1-usage/visit (core/extensions/d1-usage)
// each time the signed-in user opens an Explorer page, a record page, a dashboard or a quick
// action's form. Fire and forget: a ping that fails (offline, 500, signed out) is swallowed, never
// shown and never delays a navigation. A repeat of the same target within ten minutes is not sent.
//
// One router hook for the whole app (installed with the Explorer host), not one per page: the pages
// come and go, and the dashboards are other modules the Explorer's pages do not wrap. The quick
// actions that open no route (Print labels opens a server page in a new tab) call pingVisit.

interface PingApi {
	post(path: string, body?: unknown): Promise<unknown>;
}

let active: { filter: RepeatFilter; api: PingApi; off: () => void } | null = null;

// A target counts as sent once its request is on its way (so a click and the route change it causes
// send one ping), and is let through again at once if the request fails: a failed ping does not
// block the next try for ten minutes.
export function pingVisit(kind: UsageKind, target: string): void {
	const now = active;
	if (!now || !now.filter.peek(target)) return;
	try {
		const sent = now.api.post('/d1-usage/visit', { kind, target });
		now.filter.mark(target);
		void Promise.resolve(sent).catch(() => now.filter.unmark(target));
	} catch {
		// Never surfaces; nothing was sent, so nothing is marked.
	}
}

function pingRoute(path: string): void {
	const hit = routeTarget(canonicalPath(path));
	if (hit) pingVisit(hit.kind, hit.target);
}

// Starts the pings for this user, replacing any earlier hook (a different user signed in in the same
// tab gets a fresh repeat filter). The page already open counts as the first visit.
export function installUsagePings(router: Router, api: PingApi): void {
	active?.off();
	const off = router.afterEach((to, _from, failure) => {
		if (!failure) pingRoute(to.fullPath);
	});
	active = { filter: createRepeatFilter(), api, off };
	pingRoute(router.currentRoute.value.fullPath);
}
