import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from 'vue-router';
import { starbaseRoutes } from '@d1/starbase-pages';
import AppShell from './AppShell.vue';
import AcceptInvite from './pages/AcceptInvite.vue';
import ForgotPassword from './pages/ForgotPassword.vue';
import ResetPassword from './pages/ResetPassword.vue';
import SignInDone from './pages/SignInDone.vue';
import SignInPage from './pages/SignInPage.vue';
import { guardDecision, homeRedirect } from './guard';
import type { Session } from './session';

// STARbase's routes (spec §3.3): the sign-in pages on their own, old Directus-form links redirected, and
// every signed-in page inside the shell. starbaseRoutes are relative paths, so they must be children of a
// '/' route; extraChildren (the plot pages, Task 8) come first, and ':slug' stays last.
export function buildRoutes(extraChildren: RouteRecordRaw[] = []): RouteRecordRaw[] {
	return [
		{ path: '/signin', name: 'signin', component: SignInPage, meta: { public: true } },
		{ path: '/signin/done', name: 'signin-done', component: SignInDone, meta: { public: true } },
		{ path: '/accept-invite', name: 'accept-invite', component: AcceptInvite, meta: { public: true } },
		{ path: '/forgot-password', name: 'forgot-password', component: ForgotPassword, meta: { public: true } },
		{ path: '/reset-password', name: 'reset-password', component: ResetPassword, meta: { public: true } },
		{ path: '/home/:rest(.*)*', redirect: (to) => homeRedirect(to.fullPath) },
		{ path: '/', component: AppShell, children: [...extraChildren, ...starbaseRoutes] },
	];
}

export function createStarbaseRouter(session: Session, extraChildren: RouteRecordRaw[] = []): Router {
	const router = createRouter({ history: createWebHistory('/'), routes: buildRoutes(extraChildren) });
	router.beforeEach(async (to) => guardDecision(to, await session.ensure()));
	// The page frame sets the tab title for signed-in pages; the public pages (sign-in, accept-invite, password reset) have no frame.
	const PUBLIC_TITLES: Record<string, string> = {
		'accept-invite': 'Set your password · STARbase',
		'forgot-password': 'Forgot password · STARbase',
		'reset-password': 'Set a new password · STARbase',
	};
	router.afterEach((to) => {
		if (to.meta.public === true && typeof document !== 'undefined') document.title = PUBLIC_TITLES[String(to.name)] ?? 'Sign in · STARbase';
	});
	return router;
}
