import type { Router } from 'vue-router';
import { createRepeatFilter, routeTarget, type UsageKind } from '@d1/ui';

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

let active: { send: (target: string) => boolean; api: PingApi; off: () => void } | null = null;

export function pingVisit(kind: UsageKind, target: string): void {
	if (!active || !active.send(target)) return;
	try {
		// A rejected promise is caught here; a throw before the request is caught by the try.
		void Promise.resolve(active.api.post('/d1-usage/visit', { kind, target })).catch(() => {});
	} catch {
		// Never surfaces.
	}
}

function pingRoute(path: string): void {
	const hit = routeTarget(path);
	if (hit) pingVisit(hit.kind, hit.target);
}

// Starts the pings for this user, replacing any earlier hook (a different user signed in in the same
// tab gets a fresh repeat filter). The page already open counts as the first visit.
export function installUsagePings(router: Router, api: PingApi): void {
	active?.off();
	const off = router.afterEach((to, _from, failure) => {
		if (!failure) pingRoute(to.fullPath);
	});
	active = { send: createRepeatFilter(), api, off };
	pingRoute(router.currentRoute.value.fullPath);
}
