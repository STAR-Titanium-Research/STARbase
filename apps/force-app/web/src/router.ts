import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { ref } from 'vue';
import { authStore } from './authStore';
import { installFocusLinks } from './ui/focusLink';

const routes: RouteRecordRaw[] = [
	{ path: '/login', name: 'login', component: () => import('./LoginPage.vue'), meta: { public: true } },
	// Authenticated app: a persistent left-sidebar shell with the sections rendered inside it.
	{
		path: '/',
		component: () => import('./AppShell.vue'),
		children: [
			{ path: '', redirect: '/record' },
			{ path: 'record', name: 'record', component: () => import('./record/RecordPage.vue') },
			{ path: 'plot', name: 'plot', component: () => import('./force/StandaloneForceDashboard.vue') },
			{ path: 'plot/local/:captureId', name: 'plot-local', component: () => import('./force/LocalCaptureView.vue') },
			// Its own section, not a panel inside Plot: the workbench is a specialist analysis
			// surface under active development, and it is only mounted in this app (the Directus
			// module no longer hosts it at all). AppShell's per-item popout gives it a second
			// monitor for free.
			{ path: 'diagnostics', name: 'diagnostics', component: () => import('./force/DiagnosticsPage.vue') },
			{ path: 'labamp', name: 'labamp', component: () => import('./labamp/LabAmpPage.vue') },
			{ path: 'nidaq', name: 'nidaq', component: () => import('./nidaq/NidaqPage.vue') },
			// fillViewport: Settings owns its scrolling (a fixed column with its own scrolling pane, see
			// AppShell's .content.fill) so a banner above it can never push the document into overflow (#30).
			{ path: 'settings', name: 'settings', component: () => import('./settings/SettingsPage.vue'), meta: { fillViewport: true } },
		],
	},
	// Detached single-panel live view for a second monitor (no shell). Same recorder stream.
	{ path: '/live/:panel', name: 'live', component: () => import('./record/LivePanelWindow.vue') },
	// Detached Diagnostics panel (no shell). A viewer of the last bake — see DiagPanelWindow.
	{ path: '/diag-panel/:analysisId', name: 'diag-panel', component: () => import('./force/DiagPanelWindow.vue') },
	{ path: '/:pathMatch(.*)*', redirect: '/record' },
];

export const router = createRouter({
	// BASE_URL is '/' in dev and '/app/' in the production build (see vite.config base), so the
	// router works both at the dev root and behind Caddy's /app/ path over Tailscale.
	history: createWebHistory(import.meta.env.BASE_URL),
	routes,
});

// Auth guard: anything not marked `public` requires a session (access or refresh token).
router.beforeEach((to) => {
	authStore.checkOfflineSession();
	if (to.meta.public) return true;
	if (authStore.isAuthenticated.value) return true;
	return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : undefined };
});

// The most recent route that wasn't /settings itself. Settings > Report a Bug is only ever
// reached AT /settings, so a report's own `route.fullPath` at submit time is always "/settings" —
// useless for saying where the issue actually was. This tracks where the operator came from, so
// the report body and the area picker's default both point at the section that actually matters.
export const lastNonSettingsRoute = ref('/record');
router.afterEach((to) => {
	if (!to.path.startsWith('/settings')) lastNonSettingsRoute.value = to.fullPath;
});

// `?focus=<id>` on any route spotlights the matching [data-focus] element once it renders (#98).
installFocusLinks(router);

// Electron desktop shell only (see electronBridge.d.ts): the main process's Help menu and the
// sidecar-recovery flow (apps/force-app/desktop/src/sidecar.ts) both route the renderer here.
if (window.forceApp) {
	window.forceApp.onNavigate((targetPath) => {
		void router.push(targetPath);
	});
}
